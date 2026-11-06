// 玩家之间的直连：每对玩家一条 WebRTC 数据通道，设为无序且
// 不重传，以获得最低延迟。建立连接的消息通过房间传递。如果
// 无法建立直连，或对局中直连静默，该玩家的数据包也会经过
// 房间的中继。
import type { RoomClient } from './room-client.ts';
import { fromBase64, toBase64 } from './wire.ts';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const DIRECT_TIMEOUT_MS = 8_000;
/** 对局中每个对端每帧都发送数据包，因此这么久没收到就说明链路正在失效。 */
const QUIET_MS = 1_000;
const WATCH_MS = 250;

export type LinkState = 'connecting' | 'direct' | 'relay';

interface Link {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  state: LinkState;
  timer: ReturnType<typeof setTimeout>;
  /** 上次通过直连通道收到数据包的时间。 */
  heard: number;
}

export class Mesh {
  private links = new Map<number, Link>();
  private watcher: ReturnType<typeof setInterval> | null = null;
  onPacket: (data: ArrayBuffer) => void = () => {};
  onLinkChange: (seat: number, state: LinkState) => void = () => {};
  /** 链路切换到中继时调用，并提供原因，用于诊断。 */
  onFallback: (seat: number, reason: string) => void = () => {};

  constructor(private room: RoomClient, readonly local: number, extraIce: RTCIceServer[] = []) {
    this.ice = [...ICE_SERVERS, ...extraIce];
  }

  private ice: RTCIceServer[];

  /** 为 `seats` 中尚无链路的每个座位打开链路。座位号较小的一方发出 offer。 */
  ensure(seats: number[]): void {
    for (const s of seats) {
      if (s === this.local || this.links.has(s)) continue;
      this.open(s, this.local < s);
    }
  }

  state(seat: number): LinkState {
    return this.links.get(seat)?.state ?? 'connecting';
  }

  /** 每条链路的状态，用于问题报告。 */
  describe(): Record<number, Record<string, string | number>> {
    const now = performance.now();
    const out: Record<number, Record<string, string | number>> = {};
    for (const [seat, l] of this.links) {
      out[seat] = {
        state: l.state,
        connection: l.pc.connectionState,
        ice: l.pc.iceConnectionState,
        channel: l.channel?.readyState ?? 'none',
        heardMsAgo: Math.round(now - l.heard),
      };
    }
    return out;
  }

  /** 开始检查直连是否持续收到数据包。在游戏每帧发送后调用一次。 */
  watch(): void {
    if (this.watcher) return;
    const now = performance.now();
    for (const l of this.links.values()) l.heard = now;
    this.watcher = setInterval(() => {
      const t = performance.now();
      for (const [seat, l] of this.links) {
        if (l.state !== 'direct') continue;
        const cs = l.pc.connectionState;
        if (cs === 'failed' || cs === 'disconnected' || cs === 'closed') this.fallBack(seat, `connection ${cs}`, true);
        else if (l.channel?.readyState !== 'open') this.fallBack(seat, `channel ${l.channel?.readyState ?? 'missing'}`, true);
        else if (t - l.heard > QUIET_MS) this.fallBack(seat, `no direct packets for ${Math.round(t - l.heard)} ms`, true);
      }
    }, WATCH_MS);
  }

  private open(seat: number, offer: boolean): Link {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const link: Link = {
      pc,
      channel: null,
      state: 'connecting',
      timer: setTimeout(() => this.fallBack(seat, 'no direct connection in time', false), DIRECT_TIMEOUT_MS),
      heard: performance.now(),
    };
    this.links.set(seat, link);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.room.send({ type: 'signal', to: seat, data: JSON.stringify({ ice: e.candidate.toJSON() }) });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.fallBack(seat, 'connection failed', true);
    };
    const wire = (ch: RTCDataChannel) => {
      ch.binaryType = 'arraybuffer';
      link.channel = ch;
      ch.onopen = () => {
        clearTimeout(link.timer);
        link.heard = performance.now();
        if (link.state === 'connecting') {
          link.state = 'direct';
          this.onLinkChange(seat, 'direct');
        }
      };
      ch.onclose = () => this.fallBack(seat, 'channel closed', true);
      ch.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        link.heard = performance.now();
        this.onPacket(e.data);
      };
    };
    if (offer) {
      wire(pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
      void pc
        .createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.room.send({ type: 'signal', to: seat, data: JSON.stringify({ sdp: pc.localDescription }) }));
    } else {
      pc.ondatachannel = (e) => wire(e.channel);
    }
    return link;
  }

  /**
   * 从此以后将此座位的数据包经中继发送，直连通道仍打开时也继续经直连发送。
   * 中继在此局剩余时间内保持开启，因为失效链路往往仍能单向工作。`tell` 会让
   * 对端也这样做，因为他们可能仍能收到本端，却不知道自己的数据包已丢失。
   */
  private fallBack(seat: number, reason: string, tell: boolean): void {
    const link = this.links.get(seat);
    if (!link || link.state === 'relay') return;
    clearTimeout(link.timer);
    link.state = 'relay';
    if (tell) this.room.send({ type: 'signal', to: seat, data: JSON.stringify({ relay: true }) });
    this.onLinkChange(seat, 'relay');
    this.onFallback(seat, reason);
  }

  /** 处理另一座位经房间转发的建立连接消息。 */
  async signal(from: number, data: string): Promise<void> {
    let msg: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit; relay?: boolean };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    let link = this.links.get(from);
    if (!link) link = this.open(from, false);
    if (msg.relay) {
      this.fallBack(from, 'the other player stopped hearing this one', false);
      return;
    }
    const pc = link.pc;
    try {
      if (msg.sdp) {
        await pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.room.send({ type: 'signal', to: from, data: JSON.stringify({ sdp: pc.localDescription }) });
        }
      } else if (msg.ice) {
        await pc.addIceCandidate(msg.ice);
      }
    } catch {
      // 失败的步骤会让链路超时后转入中继。
    }
  }

  /** 通过房间中继收到的数据包。 */
  relayed(data: string): void {
    try {
      this.onPacket(fromBase64(data));
    } catch {
      // 忽略格式错误的中继数据。
    }
  }

  send(seat: number, data: ArrayBuffer): void {
    const link = this.links.get(seat);
    if (!link) return;
    if (link.channel?.readyState === 'open' && link.state !== 'connecting') {
      try {
        link.channel.send(data);
      } catch {
        // 如果链路已回退，下面的中继仍会承载它。
      }
    }
    if (link.state === 'relay') this.room.send({ type: 'relay', to: seat, data: toBase64(data) });
  }

  close(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    for (const l of this.links.values()) {
      clearTimeout(l.timer);
      l.pc.close();
    }
    this.links.clear();
  }
}
