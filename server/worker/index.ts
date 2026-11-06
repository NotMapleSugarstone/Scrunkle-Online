// 匹配 Worker：加入码来自唯一的大厅，每局游戏的套接字发往各自
// 的房间。除健康检查外的每个请求都要按地址限流，并以所有地址合计的上限兜底。
// 对局流量通常点对点传输，根本不会到达此 Worker。
import { PROTOCOL, isBuild, type QueueReply } from '../../src/net/protocol';
import { lobbyOf, type Env } from './env';
import { Lobby } from './lobby';
import { log } from './log';
import { Room } from './room';

export { Lobby, Room };

const ADDRESS_BURST = 20;
const ADDRESS_PER_SECOND = 0.5;
const WORLD_BURST = 600;
const WORLD_PER_SECOND = 100;
const BUCKETS_MAX = 5000;
const BUCKET_IDLE_MS = 10 * 60 * 1000;
const BODY_MAX = 1024;
/** 玩家页面提交的问题报告有单独且更小的限额，因此永远不会阻塞建房或加入。 */
const REPORT_BURST = 10;
const REPORT_PER_SECOND = 0.2;
const REPORT_MAX = 8192;

interface Bucket {
  tokens: number;
  at: number;
}
const buckets = new Map<string, Bucket>();
const reportBuckets = new Map<string, Bucket>();
const world: Bucket = { tokens: WORLD_BURST, at: Date.now() };

function draw(b: Bucket, burst: number, perSecond: number, now: number): boolean {
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function limited(address: string, now: number): string | null {
  if (buckets.size > BUCKETS_MAX) for (const [k, b] of buckets) if (now - b.at > BUCKET_IDLE_MS) buckets.delete(k);
  let b = buckets.get(address);
  if (!b) buckets.set(address, (b = { tokens: ADDRESS_BURST, at: now }));
  if (!draw(b, ADDRESS_BURST, ADDRESS_PER_SECOND, now)) return 'Too many requests from this address. Wait a minute and try again.';
  if (!draw(world, WORLD_BURST, WORLD_PER_SECOND, now)) return 'The rooms are busy. Try again in a minute.';
  return null;
}

function reportAllowed(address: string, now: number): boolean {
  if (reportBuckets.size > BUCKETS_MAX) for (const [k, b] of reportBuckets) if (now - b.at > BUCKET_IDLE_MS) reportBuckets.delete(k);
  let b = reportBuckets.get(address);
  if (!b) reportBuckets.set(address, (b = { tokens: REPORT_BURST, at: now }));
  return draw(b, REPORT_BURST, REPORT_PER_SECOND, now);
}

/** 记录玩家页面提交的问题报告（卡死、不同步、连接丢失或脚本错误）。 */
async function takeReport(request: Request, address: string): Promise<number> {
  const text = await request.text();
  if (text.length > REPORT_MAX) return 413;
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return 400;
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 400;
  log('client-report', { from: addressKey(address), country: request.headers.get('CF-IPCountry'), ...(report as Record<string, unknown>) });
  return 204;
}

function addressKey(address: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function allowedOrigin(env: Env, origin: string | null): boolean {
  if (origin === null) return false;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  if (!allowedOrigin(env, origin)) return {};
  return { 'Access-Control-Allow-Origin': origin!, 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('content-length') ?? 0) > BODY_MAX) return null;
  const text = await request.text();
  if (text.length > BODY_MAX) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const CODE = /^[A-Za-z0-9]{6}$/;
const ROOM_ID = /^room-[0-9a-f-]{36}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);
    const reply = (body: QueueReply, status = 200) => Response.json(body, { status, headers: cors });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/api/health') return Response.json({ ok: true, protocol: PROTOCOL }, { headers: cors });
    const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';

    if (url.pathname === '/api/report') {
      if (request.method !== 'POST') return new Response('use POST', { status: 405, headers: cors });
      if (!allowedOrigin(env, origin)) return new Response('forbidden origin', { status: 403, headers: cors });
      if (!reportAllowed(address, Date.now())) return new Response(null, { status: 429, headers: cors });
      return new Response(null, { status: await takeReport(request, address), headers: cors });
    }

    if (url.pathname.startsWith('/api/queue/')) {
      if (request.method !== 'POST') return new Response('use POST', { status: 405, headers: cors });
      if (!allowedOrigin(env, origin)) return new Response('forbidden origin', { status: 403, headers: cors });
      const busy = limited(address, Date.now());
      if (busy) {
        log('rate-limited', { path: url.pathname, from: addressKey(address) });
        return reply({ ok: false, reason: busy }, 429);
      }
      const b = await bodyOf(request);
      if (!b || !isBuild(b.build)) return reply({ ok: false, reason: 'The request could not be read.' }, 400);
      const lobby = lobbyOf(env);
      switch (url.pathname.slice('/api/queue/'.length)) {
        case 'host': {
          const r = await lobby.host(b.build, addressKey(address));
          log('lobby-host', { ok: r.ok, reason: r.ok ? undefined : r.reason, build: b.build, from: addressKey(address) });
          return reply(r);
        }
        case 'join': {
          if (typeof b.code !== 'string' || !CODE.test(b.code)) return reply({ ok: false, reason: 'A code is six letters and numbers.' }, 400);
          const r = await lobby.join(b.code.toUpperCase(), b.build);
          log('lobby-join', { ok: r.ok, reason: r.ok ? undefined : r.reason, build: b.build, from: addressKey(address) });
          return reply(r);
        }
        case 'cancel':
          if (typeof b.code === 'string' && CODE.test(b.code)) await lobby.cancel(b.code.toUpperCase());
          return reply({ ok: true, room: '' });
      }
      return new Response('not found', { status: 404, headers: cors });
    }

    // CORS 不覆盖套接字握手，因此在这里检查来源。
    const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9_-]{1,64})$/);
    if (m) {
      if (!allowedOrigin(env, origin)) return new Response('forbidden origin', { status: 403, headers: cors });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426, headers: cors });
      if (!ROOM_ID.test(m[1])) return new Response('no such room', { status: 404, headers: cors });
      const busy = limited(address, Date.now());
      if (busy) return new Response(busy, { status: 429, headers: cors });
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(request);
    }
    return new Response('not found', { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Env>;
