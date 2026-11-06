// 玩家浏览器与匹配房间之间的消息，每个方向都有严格的读取器。
// Worker 和游戏共用此文件。对局输入不经过
// 这里：它们点对点传输（见 wire.ts），只在中继兜底时经过房间。

export const PROTOCOL = 1;
export const SEATS = 2;
export const NAME_MAX = 20;
export const FRAME_MAX = 16_384;
export const SIGNAL_MAX = 12_000;
export const RELAY_MAX = 2_048;
export const DROP_MAX = 6_000;
/** 掉线玩家的座位为重新加入保留的秒数。 */
export const HOLD_SECONDS = 60;

export interface SeatInfo {
  seat: number;
  name: string;
  connected: boolean;
}

export interface StartInfo {
  seed: number;
  /** 模拟开始时间；日期积木将其读取为本地时间。 */
  t0: number;
  /** 参与游玩的座位，按顺序排列。 */
  seats: number[];
  /** 输入延迟，以帧为单位。 */
  delay: number;
}

export type ToRoom =
  | { type: 'hello'; build: string; name: string }
  | { type: 'hello'; build: string; resume: string }
  | { type: 'start'; t0: number; delay: number }
  | { type: 'signal'; to: number; data: string }
  | { type: 'relay'; to: number; data: string }
  /** 仅房主：在某座位离开后继续；该座位在 `frame` 之后的输入为空。 */
  | { type: 'drop'; seat: number; frame: number; data: string }
  | { type: 'leave' }
  | { type: 'ping' };

export type FromRoom =
  | { type: 'welcome'; seat: number; token: string; host: number; seats: SeatInfo[]; start: StartInfo | null }
  | { type: 'seats'; host: number; seats: SeatInfo[] }
  | { type: 'go'; start: StartInfo }
  | { type: 'signal'; from: number; data: string }
  | { type: 'relay'; from: number; data: string }
  | { type: 'dropped'; seat: number; frame: number; data: string }
  | { type: 'refused'; reason: string }
  | { type: 'pong' };

export type QueueReply = { ok: true; room: string; code?: string } | { ok: false; reason: string };

// ---------------------------------------------------------------- 读取器

type Obj = Record<string, unknown>;
const NO = undefined;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function frame(raw: unknown, max: number): Obj | string {
  if (typeof raw !== 'string') return 'binary frames are not accepted';
  if (raw.length > max) return 'frame too large';
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return 'not JSON';
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not an object';
  return v as Obj;
}

/** 如果对象恰好包含允许的键（且至少包含必需的键），则返回该对象。 */
function obj(v: unknown, allowed: string[], required = allowed): Obj | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return NO;
  const o = v as Obj;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return NO;
  for (const k of required) if (!own(o, k)) return NO;
  return o;
}

const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : NO);
export const isBuild = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v);
export const isToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
const isSeat = (v: unknown): v is number => whole(v, 0, SEATS - 1);

/** 玩家名称只包含 Scratch 用户名允许的字符：字母、数字、`_` 和 `-`。 */
const NAME = new RegExp(`^[A-Za-z0-9_-]{1,${NAME_MAX}}$`);

export function readName(v: unknown): string | undefined {
  return typeof v === 'string' && NAME.test(v) ? v : NO;
}

/** 移除了名称不允许字符并截断到 `NAME_MAX` 的名称。 */
export function cleanName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, NAME_MAX);
}

/** 编造的名称，`player` 加 2 到 7 位数字，无需 Scratch 账号。 */
export const isGeneratedName = (s: string): boolean => /^player\d{2,7}$/i.test(s);

function readSeats(v: unknown): SeatInfo[] | undefined {
  if (!Array.isArray(v) || v.length > SEATS) return NO;
  const out: SeatInfo[] = [];
  for (const x of v) {
    const o = obj(x, ['seat', 'name', 'connected']);
    const name = o ? readName(o.name) : NO;
    if (!o || !isSeat(o.seat) || !name || typeof o.connected !== 'boolean') return NO;
    out.push({ seat: o.seat, name, connected: o.connected });
  }
  return out;
}

export function readStart(v: unknown): StartInfo | undefined {
  const o = obj(v, ['seed', 't0', 'seats', 'delay']);
  if (!o || !whole(o.seed, 0, 0xffffffff) || !whole(o.t0, 0, 9e15) || !whole(o.delay, 0, 8)) return NO;
  if (!Array.isArray(o.seats) || o.seats.length < 1 || o.seats.length > SEATS || !o.seats.every(isSeat)) return NO;
  return { seed: o.seed, t0: o.t0, seats: [...(o.seats as number[])], delay: o.delay };
}

export function readClient(raw: unknown): { m: ToRoom } | { why: string } {
  const o = frame(raw, FRAME_MAX);
  if (typeof o === 'string') return { why: o };
  const m = clientMessage(o);
  return m ? { m } : { why: `a message of type ${JSON.stringify(String(o.type).slice(0, 16))} has the wrong shape` };
}

function clientMessage(o: Obj): ToRoom | undefined {
  switch (o.type) {
    case 'hello': {
      if (own(o, 'resume')) {
        const h = obj(o, ['type', 'build', 'resume']);
        return h && isBuild(h.build) && isToken(h.resume) ? { type: 'hello', build: h.build, resume: h.resume } : NO;
      }
      const h = obj(o, ['type', 'build', 'name']);
      const name = h ? readName(h.name) : NO;
      return h && isBuild(h.build) && name ? { type: 'hello', build: h.build, name } : NO;
    }
    case 'start': {
      const s = obj(o, ['type', 't0', 'delay']);
      return s && whole(s.t0, 0, 9e15) && whole(s.delay, 0, 8) ? { type: 'start', t0: s.t0, delay: s.delay } : NO;
    }
    case 'signal': {
      const s = obj(o, ['type', 'to', 'data']);
      const data = s ? text(s.data, SIGNAL_MAX) : NO;
      return s && isSeat(s.to) && data !== NO ? { type: 'signal', to: s.to, data } : NO;
    }
    case 'relay': {
      const r = obj(o, ['type', 'to', 'data']);
      const data = r ? text(r.data, RELAY_MAX) : NO;
      return r && isSeat(r.to) && data !== NO ? { type: 'relay', to: r.to, data } : NO;
    }
    case 'drop': {
      const d = obj(o, ['type', 'seat', 'frame', 'data']);
      const data = d ? text(d.data, DROP_MAX) : NO;
      return d && isSeat(d.seat) && whole(d.frame, 0, 1e9) && data !== NO ? { type: 'drop', seat: d.seat, frame: d.frame, data } : NO;
    }
    case 'leave':
    case 'ping':
      return obj(o, ['type']) ? { type: o.type } : NO;
  }
  return NO;
}

export function readRoom(raw: unknown): FromRoom | null {
  const o = frame(raw, FRAME_MAX * 2);
  if (typeof o === 'string') return null;
  return roomMessage(o) ?? null;
}

function roomMessage(o: Obj): FromRoom | undefined {
  switch (o.type) {
    case 'welcome': {
      const w = obj(o, ['type', 'seat', 'token', 'host', 'seats', 'start']);
      if (!w || !isSeat(w.seat) || !isToken(w.token) || !isSeat(w.host)) return NO;
      const seats = readSeats(w.seats);
      const start = w.start === null ? null : readStart(w.start);
      if (!seats || start === NO) return NO;
      return { type: 'welcome', seat: w.seat, token: w.token, host: w.host, seats, start };
    }
    case 'seats': {
      const s = obj(o, ['type', 'host', 'seats']);
      const seats = s ? readSeats(s.seats) : NO;
      return s && isSeat(s.host) && seats ? { type: 'seats', host: s.host, seats } : NO;
    }
    case 'go': {
      const g = obj(o, ['type', 'start']);
      const start = g ? readStart(g.start) : NO;
      return start ? { type: 'go', start } : NO;
    }
    case 'signal': {
      const s = obj(o, ['type', 'from', 'data']);
      const data = s ? text(s.data, SIGNAL_MAX) : NO;
      return s && isSeat(s.from) && data !== NO ? { type: 'signal', from: s.from, data } : NO;
    }
    case 'relay': {
      const r = obj(o, ['type', 'from', 'data']);
      const data = r ? text(r.data, RELAY_MAX) : NO;
      return r && isSeat(r.from) && data !== NO ? { type: 'relay', from: r.from, data } : NO;
    }
    case 'dropped': {
      const d = obj(o, ['type', 'seat', 'frame', 'data']);
      const data = d ? text(d.data, DROP_MAX) : NO;
      return d && isSeat(d.seat) && whole(d.frame, 0, 1e9) && data !== NO ? { type: 'dropped', seat: d.seat, frame: d.frame, data } : NO;
    }
    case 'refused': {
      const r = obj(o, ['type', 'reason']);
      const reason = r ? text(r.reason, 300) : NO;
      return reason !== NO ? { type: 'refused', reason } : NO;
    }
    case 'pong':
      return obj(o, ['type']) ? { type: 'pong' } : NO;
  }
  return NO;
}

export function readQueueReply(v: unknown): QueueReply | null {
  const ok = obj(v, ['ok', 'room', 'code'], ['ok', 'room']);
  if (ok && ok.ok === true && typeof ok.room === 'string' && (ok.code === undefined || typeof ok.code === 'string')) {
    return { ok: true, room: ok.room, ...(ok.code !== undefined ? { code: ok.code as string } : {}) };
  }
  const bad = obj(v, ['ok', 'reason']);
  if (bad && bad.ok === false && typeof bad.reason === 'string') return { ok: false, reason: bad.reason };
  return null;
}
