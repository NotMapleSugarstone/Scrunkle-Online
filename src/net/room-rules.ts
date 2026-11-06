// 匹配房间规则以普通类实现，使测试无需 Worker 运行时即可驱动。
// 一个房间容纳两位玩家，为两人同时开始游戏，并在他们之间转发
// 连接建立消息。它从不运行游戏。
import { HOLD_SECONDS, SEATS, type FromRoom, type SeatInfo, type StartInfo, type ToRoom } from './protocol.ts';
import { encodePacket, Kind, toBase64 } from './wire.ts';

export interface SeatState {
  name: string;
  token: string;
  connected: boolean;
  /** 座位套接字断开的时间，连接正常时为 null。 */
  awaySince: number | null;
}

export interface RoomData {
  build: string | null;
  seats: (SeatState | null)[];
  host: number;
  start: StartInfo | null;
  created: number;
}

/** 发给一个座位的消息；`seat` 为 -1 时发给所有已连接座位。 */
export type Out = { seat: number; m: FromRoom }[];

export function newRoom(now: number): RoomData {
  return { build: null, seats: Array.from({ length: SEATS }, () => null), host: 0, start: null, created: now };
}

export class RoomRules {
  constructor(public d: RoomData) {}

  private seatList(): SeatInfo[] {
    const out: SeatInfo[] = [];
    this.d.seats.forEach((s, i) => {
      if (s) out.push({ seat: i, name: s.name, connected: s.connected });
    });
    return out;
  }

  private seatsMsg(): FromRoom {
    return { type: 'seats', host: this.d.host, seats: this.seatList() };
  }

  private pickHost(): void {
    const cur = this.d.seats[this.d.host];
    if (cur && cur.connected) return;
    const next = this.d.seats.findIndex((s) => s && s.connected);
    if (next >= 0) this.d.host = next;
  }

  /** 处理来自套接字的消息。`seat` 是套接字的座位，hello 之前为 null。 */
  handle(seat: number | null, m: ToRoom, now: number, token: () => string, seed: () => number): { out: Out; seat?: number; close?: string } {
    const out: Out = [];
    if (m.type === 'hello') {
      if (seat !== null) return { out };
      if (this.d.build && this.d.build !== m.build) return { out, close: 'This room was made by a different version of the game. Reload the page.' };
      this.d.build = m.build;
      if ('resume' in m) {
        const i = this.d.seats.findIndex((s) => s && s.token === m.resume);
        if (i < 0) return { out, close: 'That seat is no longer held.' };
        const s = this.d.seats[i]!;
        s.connected = true;
        s.awaySince = null;
        this.pickHost();
        out.push({ seat: i, m: { type: 'welcome', seat: i, token: s.token, host: this.d.host, seats: this.seatList(), start: this.d.start } });
        out.push({ seat: -1, m: this.seatsMsg() });
        return { out, seat: i };
      }
      if (this.d.start) return { out, close: 'This game has already started.' };
      const i = this.d.seats.findIndex((s) => s === null);
      if (i < 0) return { out, close: 'This room is full.' };
      const s: SeatState = { name: m.name, token: token(), connected: true, awaySince: null };
      this.d.seats[i] = s;
      if (!this.d.seats[this.d.host]) this.d.host = i;
      this.pickHost();
      out.push({ seat: i, m: { type: 'welcome', seat: i, token: s.token, host: this.d.host, seats: this.seatList(), start: null } });
      out.push({ seat: -1, m: this.seatsMsg() });
      return { out, seat: i };
    }
    if (seat === null) return { out, close: 'Say hello first.' };
    switch (m.type) {
      case 'start': {
        if (seat !== this.d.host || this.d.start) return { out };
        const seats = this.d.seats.map((s, i) => (s && s.connected ? i : -1)).filter((i) => i >= 0);
        this.d.start = { seed: seed(), t0: m.t0, seats, delay: m.delay };
        out.push({ seat: -1, m: { type: 'go', start: this.d.start } });
        return { out };
      }
      case 'signal':
        if (m.to !== seat && this.d.seats[m.to]) out.push({ seat: m.to, m: { type: 'signal', from: seat, data: m.data } });
        return { out };
      case 'relay':
        if (m.to !== seat && this.d.seats[m.to]?.connected) out.push({ seat: m.to, m: { type: 'relay', from: seat, data: m.data } });
        return { out };
      case 'drop': {
        // 只有房主能决定，只能在对局中决定，且绝不能针对自己。座位会被永久释放。
        if (seat !== this.d.host || !this.d.start || m.seat === seat || !this.d.seats[m.seat]) return { out };
        this.d.seats[m.seat] = null;
        this.d.seats.forEach((s, i) => {
          if (s && s.connected && i !== seat) out.push({ seat: i, m: { type: 'dropped', seat: m.seat, frame: m.frame, data: m.data } });
        });
        out.push({ seat: -1, m: this.seatsMsg() });
        return { out };
      }
      case 'leave':
        out.push(...this.drop(seat, now, true));
        return { out, close: 'left' };
      case 'ping':
        out.push({ seat, m: { type: 'pong' } });
        return { out };
    }
    return { out };
  }

  /**
   * 套接字关闭或离开。开始前座位立即释放。开始后，主动离开（选择离开或关闭页面）的座位
   * 会消失，其他玩家收到其告别；连接断开的座位则会被保留。
   */
  drop(seat: number, now: number, left = false): Out {
    const s = this.d.seats[seat];
    if (!s) return [];
    const bye = this.d.start && left && s.connected ? this.goodbye(seat) : [];
    if (!this.d.start || left) {
      if (!this.d.start) this.d.seats[seat] = null;
      else {
        s.connected = false;
        s.awaySince = now - HOLD_SECONDS * 1000;
      }
    } else {
      s.connected = false;
      s.awaySince = now;
    }
    this.pickHost();
    return [...bye, { seat: -1, m: this.seatsMsg() }];
  }

  /** 离开座位的告别数据包，转发给其他所有人，使其游戏不再等待该座位。 */
  private goodbye(seat: number): Out {
    const data = toBase64(encodePacket({ kind: Kind.Bye, from: seat, t: 0 }));
    const out: Out = [];
    this.d.seats.forEach((s, i) => {
      if (s && s.connected && i !== seat) out.push({ seat: i, m: { type: 'relay', from: seat, data } });
    });
    return out;
  }

  /** 释放保留时间已过的座位；房间为空时返回 true。 */
  expire(now: number): boolean {
    this.d.seats.forEach((s, i) => {
      if (s && !s.connected && s.awaySince !== null && now - s.awaySince > HOLD_SECONDS * 1000) {
        if (!this.d.start) this.d.seats[i] = null;
      }
    });
    return this.d.seats.every((s) => !s || !s.connected);
  }
}
