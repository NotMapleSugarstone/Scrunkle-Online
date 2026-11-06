// 回滚会话：每位玩家都运行完整模拟。本地输入经过
// 短暂延迟后应用；缺失的远程输入通过重复该玩家最后已知的按键来预测。
// 真实输入到达且与预测不同时，会话恢复该帧之前的快照，
// 并用修正后的输入继续向前模拟。
import type { PlayerInput } from '../engine/io.ts';
import { FRAME_MS, type Runtime } from '../engine/runtime.ts';
import type { SoundEvent } from '../engine/sound-model.ts';
import { saveSnapshot, loadSnapshot, type Snapshot } from '../engine/snapshot.ts';
import { asSent, decodePacket, encodePacket, Kind, type InputPacket, type Packet } from './wire.ts';

export interface Transport {
  /** 向一个座位发送数据包；投递不可靠且无序。 */
  send(seat: number, data: ArrayBuffer): void;
}

export interface SessionOptions {
  rt: Runtime;
  local: number;
  seats: number[];
  delay: number;
  /** 模拟最多可领先最旧的未确认远程输入多少帧。 */
  maxPrediction?: number;
  transport: Transport;
  now?: () => number;
}

export interface SessionStats {
  frame: number;
  rollbacks: number;
  rolledFrames: number;
  stalls: number;
  pings: Record<number, number>;
  advantage: number;
  waitingFor: number[];
  /** 距离上次收到各远程座位消息的毫秒数。 */
  silentFor: Record<number, number>;
  desync: { frame: number; seat: number } | null;
}

const SEND_WINDOW = 64;
const CHECK_EVERY = 60;
const SILENT_MS = 3000;

function sameInput(a: PlayerInput | undefined, b: PlayerInput | undefined): boolean {
  if (!a || !b) return false;
  if (a.keys.length !== b.keys.length) return false;
  const s = new Set(a.keys);
  for (const k of b.keys) if (!s.has(k)) return false;
  if (!!a.mouse !== !!b.mouse) return false;
  if (a.mouse && b.mouse && (a.mouse.x !== b.mouse.x || a.mouse.y !== b.mouse.y || a.mouse.down !== b.mouse.down)) return false;
  return a.answer === b.answer;
}

const EMPTY: PlayerInput = { keys: [] };

/** 快照模拟状态的稳定哈希。 */
export function snapshotHash(s: Snapshot): number {
  // 画笔数组是共享的，之后可能增长；以快照时的长度为准。按住的键来自
  // 所有对端已达成一致的输入，将它们排除可让快照之前的哈希保持不变。
  const text = JSON.stringify({ ...s, penCmds: s.penLength, keys: undefined });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class RollbackSession {
  readonly rt: Runtime;
  readonly local: number;
  readonly seats: number[];
  readonly delay: number;
  readonly maxPrediction: number;
  private transport: Transport;
  private now: () => number;

  /** 最后模拟的帧；运行时持有该帧之后的状态。 */
  frame = 0;
  private snaps = new Map<number, Snapshot>();
  /** 各座位按帧确认的输入。 */
  private inputs = new Map<number, Map<number, PlayerInput>>();
  /** 各座位确认输入无缺口的最高的帧。 */
  private lastConf = new Map<number, number>();
  /** 上次模拟各帧时使用的输入。 */
  private used = new Map<number, PlayerInput[]>();
  /** 每个对端持有的本端输入的最高帧。 */
  private peerAck = new Map<number, number>();
  private peerFrame = new Map<number, number>();
  private peerHeard = new Map<number, number>();
  private rtt = new Map<number, number>();
  private advantageAvg = 0;
  private skipCooldown = 0;
  private rollbackFrom = Infinity;
  private myHashes = new Map<number, number>();
  private theirHashes = new Map<string, number>();
  private checkOut = { frame: 0, hash: 0 };
  /** 该帧最近一次模拟产生的逐帧声音事件。 */
  readonly soundByFrame = new Map<number, SoundEvent[]>();
  stats: SessionStats = { frame: 0, rollbacks: 0, rolledFrames: 0, stalls: 0, pings: {}, advantage: 0, waitingFor: [], silentFor: {}, desync: null };
  /** 每帧模拟后调用，并告知是否为重新模拟。 */
  onFrame: ((frame: number, resim: boolean, sounds: SoundEvent[]) => void) | null = null;
  /** 一位玩家表示要离开游戏。 */
  onBye: ((seat: number) => void) | null = null;
  /** 当每个座位该帧的输入都已确认时，按顺序每帧调用一次，传入四个槽位的输入和该帧后的状态。 */
  onConfirmed: ((frame: number, inputs: PlayerInput[], after: Snapshot) => void) | null = null;
  private reported = 0;

  constructor(o: SessionOptions) {
    this.rt = o.rt;
    this.local = o.local;
    this.seats = [...o.seats];
    this.delay = o.delay;
    this.maxPrediction = o.maxPrediction ?? 10;
    this.transport = o.transport;
    this.now = o.now ?? (() => performance.now());
    this.rt.io.netMode = true;
    for (const s of this.seats) {
      const m = new Map<number, PlayerInput>();
      // 最初的 `delay` 帧还没有任何人的输入。
      for (let f = 1; f <= this.delay; f++) m.set(f, EMPTY);
      this.inputs.set(s, m);
      this.lastConf.set(s, this.delay);
      this.peerAck.set(s, this.delay);
      this.peerFrame.set(s, 0);
      this.peerHeard.set(s, this.now());
    }
    this.snaps.set(0, saveSnapshot(this.rt));
  }

  /** 已离开的座位，以及其真实输入计到哪一帧；之后其输入为空。 */
  private dropped = new Map<number, number>();

  private get remotes(): number[] {
    return this.seats.filter((s) => s !== this.local && !this.dropped.has(s));
  }

  private inputFor(seat: number, f: number): PlayerInput {
    const until = this.dropped.get(seat);
    if (until !== undefined && f > until) return EMPTY;
    const conf = this.inputs.get(seat)!.get(f);
    if (conf) return conf;
    const last = this.inputs.get(seat)!.get(this.lastConf.get(seat)!) ?? EMPTY;
    return { keys: last.keys };
  }

  private simulate(f: number, resim: boolean): void {
    const slots: PlayerInput[] = [EMPTY, EMPTY, EMPTY, EMPTY];
    const used: PlayerInput[] = [];
    for (const s of this.seats) {
      const inp = this.inputFor(s, f);
      slots[s] = inp;
      used[s] = inp;
    }
    this.used.set(f, used);
    this.rt.soundEvents.length = 0;
    this.rt.stepFrame(slots);
    const sounds = this.rt.soundEvents.splice(0);
    this.soundByFrame.set(f, sounds);
    this.snaps.set(f, saveSnapshot(this.rt));
    this.frame = f;
    this.onFrame?.(f, resim, sounds);
  }

  /** 处理来自对端的数据包。 */
  receive(data: ArrayBuffer): void {
    const p = decodePacket(data);
    if (!p || !this.seats.includes(p.from) || p.from === this.local) return;
    this.peerHeard.set(p.from, this.now());
    if (p.kind === Kind.Bye) {
      this.onBye?.(p.from);
      return;
    }
    if (p.kind === Kind.Ping) {
      this.transport.send(p.from, encodePacket({ kind: Kind.Pong, from: this.local, t: p.t }));
      return;
    }
    if (p.kind === Kind.Pong) {
      const sample = this.now() - p.t;
      const prev = this.rtt.get(p.from);
      this.rtt.set(p.from, prev === undefined ? sample : prev * 0.8 + sample * 0.2);
      return;
    }
    this.onInputs(p as InputPacket);
  }

  private onInputs(p: InputPacket): void {
    const s = p.from;
    const map = this.inputs.get(s)!;
    let last = this.lastConf.get(s)!;
    p.inputs.forEach((inp, i) => {
      const g = p.first + i;
      if (g !== last + 1) return;
      map.set(g, inp);
      last = g;
      if (g <= this.frame) {
        const u = this.used.get(g);
        if (!u || !sameInput(u[s], inp)) this.rollbackFrom = Math.min(this.rollbackFrom, g);
      }
    });
    this.lastConf.set(s, last);
    this.peerAck.set(s, Math.max(this.peerAck.get(s)!, p.ack));
    this.peerFrame.set(s, Math.max(this.peerFrame.get(s)!, p.frame));
    if (p.checkFrame) {
      this.theirHashes.set(`${s}:${p.checkFrame}`, p.checkHash);
      this.compareHash(s, p.checkFrame);
    }
  }

  private compareHash(seat: number, f: number): void {
    const mine = this.myHashes.get(f);
    const theirs = this.theirHashes.get(`${seat}:${f}`);
    if (mine === undefined || theirs === undefined) return;
    if (mine !== theirs && !this.stats.desync) this.stats.desync = { frame: f, seat };
    this.theirHashes.delete(`${seat}:${f}`);
  }

  private rollback(): void {
    const from = this.rollbackFrom;
    this.rollbackFrom = Infinity;
    if (from > this.frame) return;
    const snap = this.snaps.get(from - 1);
    if (!snap) throw new Error(`no snapshot for frame ${from - 1}; rollback window exceeded`);
    const end = this.frame;
    loadSnapshot(this.rt, snap);
    this.stats.rollbacks++;
    this.stats.rolledFrames += end - from + 1;
    for (let f = from; f <= end; f++) this.simulate(f, true);
  }

  /** 每个座位的输入都已确认到的帧。 */
  confirmedFrame(): number {
    let m = Infinity;
    for (const s of this.seats) if (!this.dropped.has(s)) m = Math.min(m, this.lastConf.get(s)!);
    // 已到达但尚未重新模拟的修正会使后续帧暂时不确定。
    return Math.min(m, this.frame, this.rollbackFrom - 1);
  }

  /** 一次固定频率 tick：接收本地输入、修正错误预测，并在允许时推进一帧。 */
  /** 在对端允许时前进一帧。`localInput` 未被使用时返回 false。 */
  tick(localInput: PlayerInput): boolean {
    if (this.rollbackFrom <= this.frame) this.rollback();
    const next = this.frame + 1;
    let oldest = Infinity;
    const waiting: number[] = [];
    for (const s of this.remotes) {
      const c = this.lastConf.get(s)!;
      oldest = Math.min(oldest, c);
      if (next - c > this.maxPrediction) waiting.push(s);
    }
    this.stats.waitingFor = waiting.filter((s) => this.now() - this.peerHeard.get(s)! > SILENT_MS);
    for (const s of this.remotes) this.stats.silentFor[s] = this.now() - this.peerHeard.get(s)!;
    let advance = waiting.length === 0;

    // 时间同步：落后于我们的对端会不时获得一帧来追赶。
    this.updateAdvantage();
    if (advance && this.skipCooldown <= 0 && this.advantageAvg > 1.0) {
      advance = false;
      this.skipCooldown = 6;
    }
    if (this.skipCooldown > 0) this.skipCooldown--;

    if (advance) {
      const f = next + this.delay;
      this.inputs.get(this.local)!.set(f, asSent(localInput));
      this.lastConf.set(this.local, f);
      this.simulate(next, false);
    } else {
      this.stats.stalls++;
    }
    this.checksum();
    this.reportConfirmed();
    this.sendInputs();
    this.prune();
    this.stats.frame = this.frame;
    this.stats.advantage = this.advantageAvg;
    void oldest;
    return advance;
  }

  private updateAdvantage(): void {
    let worst = -Infinity;
    for (const s of this.remotes) {
      const rttFrames = (this.rtt.get(s) ?? 0) / FRAME_MS;
      const theirs = this.peerFrame.get(s)! + rttFrames / 2;
      worst = Math.max(worst, this.frame - theirs);
    }
    if (worst === -Infinity) worst = 0;
    this.advantageAvg = this.advantageAvg * 0.9 + worst * 0.1;
  }

  private reportConfirmed(): void {
    if (!this.onConfirmed) return;
    const c = this.confirmedFrame();
    while (this.reported < c) {
      const f = ++this.reported;
      const used = this.used.get(f);
      const after = this.snaps.get(f);
      if (used && after) this.onConfirmed(f, [0, 1, 2, 3].map((s) => used[s] ?? EMPTY), after);
    }
  }

  private checksum(): void {
    const c = this.confirmedFrame();
    const f = c - (c % CHECK_EVERY);
    if (f <= 0 || this.myHashes.has(f)) return;
    const snap = this.snaps.get(f);
    if (!snap) return;
    const h = snapshotHash(snap);
    this.myHashes.set(f, h);
    this.checkOut = { frame: f, hash: h };
    for (const s of this.remotes) this.compareHash(s, f);
  }

  private sendInputs(): void {
    const mine = this.inputs.get(this.local)!;
    const last = this.lastConf.get(this.local)!;
    for (const s of this.remotes) {
      const first = Math.max(this.peerAck.get(s)! + 1, last - SEND_WINDOW + 1);
      const list: PlayerInput[] = [];
      for (let f = first; f <= last; f++) list.push(mine.get(f) ?? EMPTY);
      const p: Packet = {
        kind: Kind.Inputs,
        from: this.local,
        ack: this.lastConf.get(s)!,
        frame: this.frame,
        first,
        inputs: list,
        checkFrame: this.checkOut.frame,
        checkHash: this.checkOut.hash,
      };
      this.transport.send(s, encodePacket(p));
    }
  }

  /**
   * 房主端移除已离开座位：所有人将使用的其输入最后一帧，以及此对端截至该帧持有的输入，
   * 供收到较少输入的对端使用。
   */
  dropOffer(seat: number): { frame: number; data: ArrayBuffer } {
    const frame = this.lastConf.get(seat)!;
    const map = this.inputs.get(seat)!;
    let first = frame;
    while (first > 1 && map.has(first - 1) && frame - first < 120) first--;
    const list: PlayerInput[] = [];
    for (let f = first; f <= frame; f++) list.push(map.get(f) ?? EMPTY);
    const p: Packet = { kind: Kind.Inputs, from: seat, ack: 0, frame: 0, first, inputs: list, checkFrame: 0, checkHash: 0 };
    return { frame, data: encodePacket(p) };
  }

  /** 每个对端应用相同的移除：到 `frame` 为止使用真实输入，之后使用空输入。 */
  applyDrop(seat: number, frame: number, data: ArrayBuffer): boolean {
    if (this.dropped.has(seat) || seat === this.local) return false;
    const p = decodePacket(data);
    if (!p || p.kind !== Kind.Inputs) return false;
    const map = this.inputs.get(seat)!;
    let last = this.lastConf.get(seat)!;
    p.inputs.forEach((inp, i) => {
      const g = p.first + i;
      if (g === last + 1 && g <= frame) {
        map.set(g, inp);
        last = g;
      }
    });
    if (last < frame) return false;
    for (const f of [...map.keys()]) if (f > frame) map.delete(f);
    this.lastConf.set(seat, frame);
    this.dropped.set(seat, frame);
    for (let f = Math.max(1, frame - this.maxPrediction * 4); f <= this.frame; f++) {
      const u = this.used.get(f);
      if (u && !sameInput(u[seat], this.inputFor(seat, f))) {
        this.rollbackFrom = Math.min(this.rollbackFrom, f);
        break;
      }
    }
    return true;
  }

  /** 通知其他玩家本玩家即将离开的数据包。 */
  goodbye(): ArrayBuffer {
    return encodePacket({ kind: Kind.Bye, from: this.local, t: 0 });
  }

  /** 发送往返探测；大约每秒调用一次。 */
  probe(): void {
    for (const s of this.remotes) this.transport.send(s, encodePacket({ kind: Kind.Ping, from: this.local, t: this.now() }));
    for (const s of this.remotes) this.stats.pings[s] = Math.round(this.rtt.get(s) ?? 0);
  }

  private prune(): void {
    const keepFrom = this.confirmedFrame() - this.maxPrediction - 4;
    for (const f of this.snaps.keys()) if (f < keepFrom && f < this.frame - this.maxPrediction - 2) this.snaps.delete(f);
    for (const f of this.used.keys()) if (f < keepFrom) this.used.delete(f);
    for (const f of this.soundByFrame.keys()) if (f < this.frame - 120) this.soundByFrame.delete(f);
    let ackMin = Infinity;
    for (const s of this.remotes) ackMin = Math.min(ackMin, this.peerAck.get(s)!);
    for (const s of this.seats) {
      const m = this.inputs.get(s)!;
      const limit = Math.min(keepFrom, s === this.local ? ackMin : Infinity, this.lastConf.get(s)!) - 1;
      for (const f of m.keys()) if (f < limit) m.delete(f);
    }
    for (const f of this.myHashes.keys()) if (f < this.frame - 600) this.myHashes.delete(f);
  }
}
