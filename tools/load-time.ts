// 在无头 Edge 中清空缓存，测量构建后的站点从打开到“开始”可用的时间。
// 先运行 `npm run build`。用法：npx tsx tools/load-time.ts [runs]
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startStaticServer } from './lib/static-server.ts';
import { ROOT } from './lib/reference.ts';

const runs = Number(process.argv[2] ?? 1);
const server = await startStaticServer(path.join(ROOT, 'dist'));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  // 除非另行设置，浏览器只保留 250 项资源计时，而游戏会加载数千个文件。
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(20_000);
    // 统计渲染器从页面创建图像起为每张图像制作纹理的时间。
    const w = window as unknown as { __game?: { renderer: Record<string, unknown> }; __prepMs: number };
    w.__prepMs = 0;
    const hook = setInterval(() => {
      const r = w.__game?.renderer as { prepare?: (i: number) => void } | undefined;
      if (!r?.prepare) return;
      clearInterval(hook);
      const prepare = r.prepare.bind(r);
      r.prepare = (i: number) => {
        const s = performance.now();
        prepare(i);
        w.__prepMs += performance.now() - s;
      };
    }, 0);
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`${server.url}/index.html`);
  await page.waitForFunction(() => [...document.querySelectorAll('.lobby-menu button')].some((b) => b.textContent === 'Play offline' && !(b as HTMLButtonElement).disabled), null, { timeout: 600_000, polling: 200 });
  const ms = Date.now() - t0;
  const progress = await page.evaluate(() => document.querySelector('.lobby-progress')?.textContent ?? '');
  // 最后一张图像到达的时间，用于区分网络时间与解码和上传时间。
  const images = await page.evaluate(() => {
    const list = performance.getEntriesByType('resource').filter((e) => e.name.includes('/assets/costumes/'));
    return { count: list.length, lastEnd: Math.max(...list.map((e) => (e as PerformanceResourceTiming).responseEnd)) };
  });
  const prepMs = await page.evaluate(() => (window as unknown as { __prepMs: number }).__prepMs);
  console.log(`run ${i + 1}: Play enabled after ${(ms / 1000).toFixed(1)} s, ${(prepMs / 1000).toFixed(1)} s of it making textures, the last of ${images.count} images arrived at ${(images.lastEnd / 1000).toFixed(1)} s${progress ? ` (${progress} still loading)` : ''}${errors.length ? `, errors: ${errors.join('; ')}` : ''}`);
  await context.close();
}
await browser.close();
server.close();
