// 在线游戏：由回滚会话驱动的共享模拟，声音会跟随修正，
// 包含连接质量状态行，以及在某玩家离开后继续游戏。
import type { PlayerInput } from '../engine/io.ts';
import type { SoundEvent } from '../engine/sound-model.ts';
import { RollbackSession } from '../net/rollback.ts';
import type { Mesh } from '../net/mesh.ts';
import type { RoomClient } from '../net/room-client.ts';
import type { SeatInfo, StartInfo } from '../net/protocol.ts';
import { report, reportContext } from '../net/report.ts';
import { fromBase64, toBase64 } from '../net/wire.ts';
import { loadControls, seatKeys, translateKeys } from './controls.ts';
import { actionKeys, type Pads } from './pads.ts';
import { currentFormat, currentText } from './net-text.ts';
import { seatScreen } from '../game/screens.ts';
import { Game, startFixedLoop } from './game.ts';
import type { LocalInput } from './input.ts';

/** 即使某帧在修正后重新模拟，每帧也只播放一次声音。 */
class RollbackAudio {
  private played = new Map<number, Set<string>>();

  constructor(private game: Game) {}

  frame(f: number, resim: boolean, sounds: SoundEvent[]): void {
    const audio = this.game.audio;
    const before = this.played.get(f) ?? new Set<string>();
    const now = new Set<string>();
    const out: SoundEvent[] = [];
    for (const e of sounds) {
      if (e.kind === 'play') {
        const key = `${e.sprite}:${e.sound}`;
        now.add(key);
        if (resim && before.has(key)) continue;
      }
      out.push(e);
    }
    if (resim) {
      for (const key of before) {
        if (!now.has(key)) {
          const [s, n] = key.split(':').map(Number);
          audio.stopSound(s, n);
        }
      }
    }
    this.played.set(f, now);
    if (this.played.size > 200) {
      for (const k of this.played.keys()) if (k < f - 150) this.played.delete(k);
    }
    audio.apply(out);
  }
}

export interface OnlineHud {
  update(text: string, warn: string): void;
  /** 显示一个按钮；label 为 null 时隐藏。 */
  action(label: string | null, onClick: () => void): void;
  /** 在舞台上显示等待面板；title 为 null 时隐藏。 */
  waiting(title: string | null, text?: string, button?: { label: string; onClick: () => void } | null): void;
}

/** 游戏等待某玩家多少秒后，面板会允许房主不等对方继续。 */
const PROMPT_AFTER_S = 3;
/** “离开游戏”通知在状态行中保留的毫秒数。 */
const NOTICE_MS = 5_000;
const FREEZE_REPORT_MS = 5_000;
const AWAY_SILENT_MS = 1_000;

export class OnlineGame {
  session: RollbackSession;
  private stop: (() => void) | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private away = new Set<number>();
  private dropped = new Set<number>();
  /** 已告别的座位：关闭页面或选择离开。 */
  private left = new Set<number>();
  private notice: { text: string; until: number } | null = null;
  private stuckSince: number | null = null;
  private freezeReported = false;
  private desyncReported = false;
  host: number;

  constructor(
    public game: Game,
    private room: RoomClient,
    private mesh: Mesh,
    public start: StartInfo,
    public local: number,
    private names: Map<number, string>,
    private hud: OnlineHud,
    host: number,
  ) {
    this.host = host;
    this.session = new RollbackSession({
      rt: game.rt,
      local,
      seats: start.seats,
      delay: start.delay,
      maxPrediction: 10,
      transport: { send: (seat, data) => mesh.send(seat, data) },
    });
    const audio = new RollbackAudio(game);
    this.session.onFrame = (f, resim, sounds) => audio.frame(f, resim, sounds);
    mesh.onPacket = (data) => this.session.receive(data);
    this.session.onBye = (seat) => this.left.add(seat);
    reportContext.room = room.id;
    reportContext.seat = local;
    reportContext.online = true;
    mesh.onFallback = (seat, reason) => report('link-fallback', { seat, reason, ...this.diagnostics() });
  }

  /** 问题报告携带的会话与连接状态。 */
  diagnostics(): Record<string, unknown> {
    const st = this.session.stats;
    return {
      frame: st.frame,
      confirmed: this.session.confirmedFrame(),
      seats: this.start.seats,
      delay: this.start.delay,
      waitingFor: st.waitingFor,
      away: [...this.away],
      dropped: [...this.dropped],
      silentFor: st.silentFor,
      pings: st.pings,
      rollbacks: st.rollbacks,
      stalls: st.stalls,
      advantage: st.advantage,
      links: this.mesh.describe(),
    };
  }

  /** 房间发来的座位列表更新：谁已连接、当前房主是谁。 */
  seatsChanged(seats: SeatInfo[], host: number): void {
    this.host = host;
    this.away.clear();
    for (const s of this.start.seats) {
      const info = seats.find((x) => x.seat === s);
      if (s !== this.local && !this.dropped.has(s) && (!info || !info.connected)) this.away.add(s);
    }
  }

  /** 房间宣布房主将在缺少某座位的情况下继续。 */
  onDropped(seat: number, frame: number, data: string): void {
    if (this.dropped.has(seat)) return;
    if (this.session.applyDrop(seat, frame, fromBase64(data))) this.wentOn(seat);
  }

  private wentOn(seat: number): void {
    this.dropped.add(seat);
    this.notice = { text: currentFormat('leftGame', { name: this.name(seat) }), until: performance.now() + NOTICE_MS };
  }

  private dropSeat(seat: number): void {
    if (this.dropped.has(seat)) return;
    const offer = this.session.dropOffer(seat);
    if (!this.session.applyDrop(seat, offer.frame, offer.data)) return;
    this.wentOn(seat);
    this.room.send({ type: 'drop', seat, frame: offer.frame, data: toBase64(offer.data) });
  }

  run(input: LocalInput, pads: Pads): void {
    this.probeTimer = setInterval(() => this.session.probe(), 1000);
    this.mesh.watch();
    const own = loadControls();
    this.stop = startFixedLoop(
      () => {
        const pressed = input.sampleKeys();
        // 每个控制器和触屏控制都操作此玩家自己的座位。
        const acts = pads.sample().flat();
        // 共享菜单将所有人的按键视为玩家 1；角色选择和比赛使用各座位自己的按键。
        const seat = seatKeys(this.game.rt, seatScreen(this.game.rt) ? this.local : 0);
        const keys = new Set(translateKeys(pressed, own, seat));
        for (const k of actionKeys(acts, seat)) keys.add(k);
        const p: PlayerInput = { keys: [...keys] };
        // 只有第一个座位驱动共享鼠标指针。
        const mouse = this.local === this.start.seats[0] ? input.sampleMouse() : undefined;
        if (mouse) p.mouse = mouse;
        if (this.game.question.pendingAnswer !== undefined) {
          p.answer = this.game.question.pendingAnswer;
          this.game.question.pendingAnswer = undefined;
        }
        if (!this.session.tick(p)) {
          // 帧未推进，因此下一次 tick 重新提交相同输入。
          input.retap(pressed);
          pads.retap(acts);
          if (p.mouse) input.remouse(p.mouse);
          if (p.answer !== undefined) this.game.question.pendingAnswer ??= p.answer;
        }
      },
      () => {
        this.game.present();
        this.updateHud();
      },
    );
  }

  private name(s: number): string {
    return this.names.get(s) ?? `P${s + 1}`;
  }

  private updateHud(): void {
    const st = this.session.stats;
    const parts: string[] = [];
    for (const s of this.start.seats) {
      if (s === this.local || this.dropped.has(s)) continue;
      const link = this.mesh.state(s);
      parts.push(`${this.name(s)}: ${st.pings[s] ?? '?'} ms ${link === 'relay' ? `(${currentText('relayed')})` : link === 'connecting' ? `(${currentText('hudConnecting')})` : ''}`);
    }
    parts.push(`${currentText('rollbacks')} ${st.rollbacks}`);
    let warn = '';
    // 房间套接字正在重连的玩家，只要输入仍可直连到达，就仍在游玩。
    const silentAway = [...this.away].filter((s) => (st.silentFor[s] ?? 0) > AWAY_SILENT_MS);
    const stuck = [...new Set([...st.waitingFor, ...silentAway])].filter((s) => !this.dropped.has(s));
    if (stuck.length) warn = currentFormat('waitingFor', { names: stuck.map((s) => this.name(s)).join(', ') });
    const now = performance.now();
    if (!warn && this.notice && now < this.notice.until) warn = this.notice.text;
    if (st.desync) warn = currentFormat('outOfSync', { frame: st.desync.frame });
    if (!stuck.length) this.stuckSince = null;
    else if (this.stuckSince === null) this.stuckSince = now;
    else if (now - this.stuckSince > FREEZE_REPORT_MS && !this.freezeReported) {
      this.freezeReported = true;
      report('freeze', { stuck, ...this.diagnostics() });
    }
    if (!stuck.length) this.freezeReported = false;
    if (st.desync && !this.desyncReported) {
      this.desyncReported = true;
      report('desync', { desync: st.desync, ...this.diagnostics() });
    }
    this.hud.update(parts.join('  |  '), warn);
    // 关闭页面或选择离开的玩家已告别，因此房主立即继续而不等待。
    const isHost = this.local === this.host;
    if (isHost) for (const s of this.left) if (!this.dropped.has(s)) this.dropSeat(s);
    // 其他玩家可能只是慢，因此几秒后由房主决定，所有人都会看到游戏在等谁。
    const waited = this.stuckSince === null ? 0 : (now - this.stuckSince) / 1000;
    const on = stuck.find((s) => !this.dropped.has(s));
    if (on !== undefined && waited > PROMPT_AFTER_S && !st.desync) {
      const who = this.name(on);
      if (isHost) this.hud.waiting(currentFormat('waitingTitle', { name: who }), currentFormat('waitingText', { seconds: Math.floor(waited) }), { label: currentFormat('continueWithout', { name: who }), onClick: () => this.dropSeat(on) });
      else this.hud.waiting(currentFormat('waitingTitle', { name: who }), currentFormat('waitingTextHost', { seconds: Math.floor(waited), host: this.name(this.host) }), null);
    } else this.hud.waiting(null);
    this.hud.action(null, () => {});
  }

  leave(): void {
    this.stop?.();
    if (this.probeTimer) clearInterval(this.probeTimer);
    // 告别消息同时通过直连和房间发送，即使其中一条路径失效也能到达。
    const bye = this.session.goodbye();
    for (const s of this.start.seats) {
      if (s === this.local || this.dropped.has(s)) continue;
      this.mesh.send(s, bye);
      this.room.send({ type: 'relay', to: s, data: toBase64(bye) });
    }
    this.mesh.close();
    this.room.close();
  }
}
