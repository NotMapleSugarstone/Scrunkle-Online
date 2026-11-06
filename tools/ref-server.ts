// 保持一个参考运行器常驻并按请求运行场景，使一致性检查跳过数分钟的加载。
// 用法：npx tsx tools/ref-server.ts [port]   （parity.ts 在 127.0.0.1:8793 响应时使用它，或使用 REF_PORT）
// POST /run 传入 {scenario, fullAt?} 返回 {digests, fulls}。就绪后 GET /status 响应。用 Ctrl+C 或 POST /quit 停止。
import http from 'node:http';
import { openReference } from './lib/reference.ts';
import { listsKey } from './lib/lists.ts';
import { encodeSpecial } from './lib/ref-client.ts';

const port = Number(process.argv[2] ?? process.env.REF_PORT ?? 8793);
const t0 = Date.now();
const loadedLists = listsKey();
const ref = await openReference();
console.log(`reference loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s, serving on ${port}`);
let busy = Promise.resolve();
const CHUNK = 300;

// 请求会在队列中等待数分钟，默认请求超时会将其重置。
http
  .createServer({ requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0 }, (req, res) => {
    if (req.method === 'GET' && req.url === '/status') { res.end('ready'); return; }
    if (req.method === 'POST' && req.url === '/quit') { res.end('bye'); void ref.close().then(() => process.exit(0)); return; }
    // 在最后一次运行后于参考页面中求 JavaScript 表达式，用于调试（H 和 H.vm 可用）。
    if (req.method === 'POST' && req.url === '/eval') {
      let code = '';
      req.on('data', (c) => (code += c));
      req.on('end', () => {
        busy = busy.then(async () => {
          try {
            const out = await ref.page.evaluate((c) => JSON.stringify((0, eval)(c)), code);
            res.end(out ?? 'undefined');
          } catch (e) {
            res.writeHead(500);
            res.end(String((e as Error).stack ?? e));
          }
        });
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/run') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      busy = busy.then(async () => {
        try {
          const { scenario, fullAt = [], lists = '' } = JSON.parse(body);
          if (lists !== loadedLists) throw new Error('The reference server loaded different data/lists files. Restart it (POST /quit, then start it again).');
          const ev: Record<number, unknown[]> = {};
          for (const e of scenario.events) (ev[e.f] ??= []).push(e);
          await ref.page.evaluate((s) => (window as any).H.start({ seed: s.seed, username: s.username ?? '' }), { seed: scenario.seed, username: scenario.username });
          const digests: unknown[] = [];
          const fulls: Record<number, unknown> = {};
          for (let done = 0; done < scenario.frames; done += CHUNK) {
            const n = Math.min(CHUNK, scenario.frames - done);
            const r = await ref.page.evaluate(([n2, e, fa]) => (window as any).H.run(n2, e, { fullAt: fa }), [n, ev, fullAt] as const);
            digests.push(...r.digests);
            Object.assign(fulls, r.fulls);
          }
          res.setHeader('content-type', 'application/json');
          res.end(encodeSpecial({ digests, fulls }));
          console.log(`ran ${scenario.name} ${scenario.frames} frames`);
        } catch (e) {
          res.writeHead(500);
          res.end(String((e as Error).stack ?? e));
        }
      });
    });
  })
  .listen(port, '127.0.0.1');
