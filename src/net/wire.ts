// 对局中玩家之间传输的二进制数据包：逐帧输入（重发直到
// 确认，因此丢包无需重传）、状态校验和、往返探测，以及离开玩家的
// 告别消息。
import type { PlayerInput } from '../engine/io.ts';

/** 游戏可测试的每个键名，按所有玩家共享的固定顺序排列。 */
export const KEY_TABLE: string[] = (() => {
  const keys = ['space', 'left arrow', 'up arrow', 'right arrow', 'down arrow', 'enter'];
  for (let c = 65; c <= 90; c++) keys.push(String.fromCharCode(c));
  for (let d = 0; d <= 9; d++) keys.push(String(d));
  for (const ch of '!@#$%^&*()-–—=[]\\;\'‘’,./_+{}|:"“”<>?`~‚¢€£¥§ÜÖÄ') keys.push(ch.toUpperCase());
  keys.push('SS');
  return keys;
})();

/** 表示游戏无法命名的任意按住键，使“按下任意键”仍能工作。 */
export const OTHER_KEY = '\u0000other';
const KEY_INDEX = new Map(KEY_TABLE.map((k, i) => [k, i]));
const MASK_BYTES = 16;
const OTHER_BIT = 127;

export enum Kind {
  Inputs = 1,
  Ping = 2,
  Pong = 3,
  Bye = 4,
}

export interface InputPacket {
  kind: Kind.Inputs;
  from: number;
  /** 发送方持有的接收方无缺口输入的最高帧。 */
  ack: number;
  /** 发送方当前的模拟帧，用于时间同步。 */
  frame: number;
  first: number;
  inputs: PlayerInput[];
  /** 发送方在 `checkFrame` 之后状态的校验和，没有时为 0。 */
  checkFrame: number;
  checkHash: number;
}

export interface ProbePacket {
  kind: Kind.Ping | Kind.Pong | Kind.Bye;
  from: number;
  t: number;
}

export type Packet = InputPacket | ProbePacket;

export function encodeKeys(keys: Iterable<string>, out: Uint8Array, at: number): void {
  for (let i = 0; i < MASK_BYTES; i++) out[at + i] = 0;
  for (const k of keys) {
    const idx = k === OTHER_KEY ? OTHER_BIT : (KEY_INDEX.get(k) ?? OTHER_BIT);
    out[at + (idx >> 3)] |= 1 << (idx & 7);
  }
}

export function decodeKeys(buf: Uint8Array, at: number): string[] {
  const keys: string[] = [];
  for (let idx = 0; idx < MASK_BYTES * 8; idx++) {
    if (buf[at + (idx >> 3)] & (1 << (idx & 7))) keys.push(idx === OTHER_BIT ? OTHER_KEY : (KEY_TABLE[idx] ?? OTHER_KEY));
  }
  return keys;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodePacket(p: Packet): ArrayBuffer {
  if (p.kind !== Kind.Inputs) {
    const b = new ArrayBuffer(10);
    const v = new DataView(b);
    v.setUint8(0, p.kind);
    v.setUint8(1, p.from);
    v.setFloat64(2, p.t);
    return b;
  }
  const parts: Uint8Array[] = [];
  let size = 1 + 1 + 4 + 4 + 4 + 1 + 4 + 4;
  for (const inp of p.inputs) {
    const ans = inp.answer !== undefined ? enc.encode(inp.answer.slice(0, 500)) : null;
    const rec = new Uint8Array(MASK_BYTES + 1 + (inp.mouse ? 4 : 0) + (ans ? 2 + ans.length : 0));
    encodeKeys(inp.keys, rec, 0);
    let flags = 0;
    if (inp.mouse) flags |= 1 | (inp.mouse.down ? 2 : 0);
    if (ans) flags |= 4;
    rec[MASK_BYTES] = flags;
    let o = MASK_BYTES + 1;
    const rv = new DataView(rec.buffer);
    if (inp.mouse) {
      rv.setInt16(o, inp.mouse.x);
      rv.setInt16(o + 2, inp.mouse.y);
      o += 4;
    }
    if (ans) {
      rv.setUint16(o, ans.length);
      rec.set(ans, o + 2);
    }
    parts.push(rec);
    size += rec.length;
  }
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint8(0, p.kind);
  v.setUint8(1, p.from);
  v.setUint32(2, p.ack >>> 0);
  v.setUint32(6, p.frame >>> 0);
  v.setUint32(10, p.first >>> 0);
  v.setUint8(14, p.inputs.length);
  v.setUint32(15, p.checkFrame >>> 0);
  v.setUint32(19, p.checkHash >>> 0);
  let o = 23;
  for (const part of parts) {
    b.set(part, o);
    o += part.length;
  }
  return b.buffer;
}

/** 解码数据包；任何格式错误都返回 null。 */
export function decodePacket(buf: ArrayBuffer): Packet | null {
  try {
    const b = new Uint8Array(buf);
    const v = new DataView(buf);
    const kind = v.getUint8(0);
    const from = v.getUint8(1);
    if (from > 3) return null;
    if (kind === Kind.Ping || kind === Kind.Pong || kind === Kind.Bye) {
      if (b.length !== 10) return null;
      return { kind, from, t: v.getFloat64(2) };
    }
    if (kind !== Kind.Inputs) return null;
    const ack = v.getUint32(2);
    const frame = v.getUint32(6);
    const first = v.getUint32(10);
    const count = v.getUint8(14);
    const checkFrame = v.getUint32(15);
    const checkHash = v.getUint32(19);
    let o = 23;
    const inputs: PlayerInput[] = [];
    for (let i = 0; i < count; i++) {
      const keys = decodeKeys(b, o);
      const flags = b[o + MASK_BYTES];
      o += MASK_BYTES + 1;
      const inp: PlayerInput = { keys };
      if (flags & 1) {
        inp.mouse = { x: v.getInt16(o), y: v.getInt16(o + 2), down: (flags & 2) !== 0 };
        o += 4;
      }
      if (flags & 4) {
        const n = v.getUint16(o);
        inp.answer = dec.decode(b.subarray(o + 2, o + 2 + n));
        o += 2 + n;
      }
      inputs.push(inp);
    }
    if (o !== b.length) return null;
    return { kind, from, ack, frame, first, inputs, checkFrame, checkHash };
  } catch {
    return null;
  }
}

/**
 * 其他玩家解码时看到的输入：按键按表顺序排列，未知键记为 OTHER_KEY，指针取整到舞台单位，
 * 答案截断到发送长度。发送方也模拟这份副本，使每位玩家运行相同输入。
 */
export function asSent(inp: PlayerInput): PlayerInput {
  const p = decodePacket(encodePacket({ kind: Kind.Inputs, from: 0, ack: 0, frame: 0, first: 0, inputs: [inp], checkFrame: 0, checkHash: 0 }));
  return p?.kind === Kind.Inputs ? p.inputs[0] : { keys: [] };
}

/** 为仅支持文本的房间中继打包字节。 */
export function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}
