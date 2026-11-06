// 每个事件一行 JSON。Worker 的日志存储会为字段建立索引，因此可以在控制台中按名称、
// 房间或座位筛选事件，也可用 `npx wrangler tail` 实时跟踪。
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
