// 将有关问题（卡死、不同步、链路丢失、脚本错误）的简短诊断发送到房间
// 服务器，由服务器写入日志。这里的内容都不影响游戏。
import { BUILD, relayBase } from './room-client.ts';

const PER_KIND = 5;
const TEXT_MAX = 1500;
const sent = new Map<string, number>();

/** 当前在线游戏的房间和座位，会附加到每份报告。 */
export const reportContext: { room?: string; seat?: number; online?: boolean } = {};

function trim(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > TEXT_MAX ? `${v.slice(0, TEXT_MAX)}...` : v;
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => trim(x, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, trim(x, depth + 1)]));
}

/** 报告一个问题。每种问题每次页面加载最多发送几次。 */
export function report(kind: string, detail: Record<string, unknown>): void {
  const base = relayBase();
  if (!base) return;
  const n = sent.get(kind) ?? 0;
  if (n >= PER_KIND) return;
  sent.set(kind, n + 1);
  const body = JSON.stringify({
    kind,
    build: BUILD,
    ...reportContext,
    page: location.pathname,
    agent: navigator.userAgent,
    detail: trim(detail),
  });
  // 纯文本正文使请求保持简单，浏览器不会发送预检请求。
  void fetch(`${base}/api/report`, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
}
