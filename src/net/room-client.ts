// 匹配房间的浏览器端：加入码请求、带心跳的房间套接字，以及
// 用令牌取回掉线座位的重连。来自房间的每条消息都会先经过
// `readRoom` 再被读取。
import { readQueueReply, readRoom, type FromRoom, type QueueReply, type ToRoom } from './protocol.ts';

declare const __BUILD__: string;
declare const __RELAY_URL__: string;

/** 站点的构建指纹，使房间只配对完全相同的游戏。 */
export const BUILD: string = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

const PING_MS = 10_000;
const RETRY_MS = 1_500;
const RETRY_LIMIT = 20;

/** 房间所在地址：开发时是此页面的源（Vite 转发 /api），否则是部署的 Worker。 */
export function relayBase(): string {
  if (import.meta.env?.DEV) return location.origin;
  return typeof __RELAY_URL__ === 'string' ? __RELAY_URL__ : '';
}

/** 发布构建未配置房间服务器地址时为 false。 */
export const onlineAvailable = (): boolean => relayBase() !== '';

async function post(path: string, body: object): Promise<QueueReply> {
  try {
    const res = await fetch(`${relayBase()}/api/queue/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readQueueReply(await res.json()) ?? { ok: false, reason: 'The lobby sent an answer this version cannot read.' };
  } catch {
    return { ok: false, reason: 'The matchmaking server could not be reached.' };
  }
}

export const hostRoom = (): Promise<QueueReply> => post('host', { build: BUILD });
export const joinRoom = (code: string): Promise<QueueReply> => post('join', { build: BUILD, code });
export const cancelRoom = (code: string): Promise<QueueReply> => post('cancel', { build: BUILD, code });

export class RoomClient {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private retries = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  /** 房间拒绝此玩家的原因（一旦被拒绝）。 */
  refusal: string | null = null;
  seat = -1;
  onMessage: (m: FromRoom) => void = () => {};
  onStatus: (s: 'open' | 'reconnecting' | 'closed', why?: string) => void = () => {};

  constructor(private room: string, private name: string) {}

  get id(): string {
    return this.room;
  }

  connect(): void {
    const base = relayBase().replace(/^http/, 'ws');
    const ws = new WebSocket(`${base}/api/room/${this.room}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      const hello: ToRoom = this.token ? { type: 'hello', build: BUILD, resume: this.token } : { type: 'hello', build: BUILD, name: this.name };
      ws.send(JSON.stringify(hello));
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS);
      this.onStatus('open');
    };
    ws.onmessage = (e) => {
      const m = readRoom(e.data);
      if (!m) return;
      if (m.type === 'welcome') {
        this.seat = m.seat;
        this.token = m.token;
      }
      if (m.type === 'refused') {
        this.closedByUs = true;
        this.refusal = m.reason;
      }
      this.onMessage(m);
    };
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      const why = `${e.code} ${e.reason}`.trim();
      if (this.closedByUs || this.retries >= RETRY_LIMIT) {
        this.onStatus('closed', why);
        return;
      }
      this.retries++;
      this.onStatus('reconnecting', why);
      setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  send(m: ToRoom): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closedByUs = true;
    this.send({ type: 'leave' });
    this.ws?.close();
  }
}
