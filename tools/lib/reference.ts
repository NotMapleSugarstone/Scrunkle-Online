import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startStaticServer } from './static-server.ts';
import { hasOverrides, PATCHED_SB3, SOURCE_SB3, writePatchedProject } from './lists.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** 参考实现运行的项目：源项目，或当 data/lists 中有编辑时，包含这些编辑的副本。 */
export async function referenceProject(): Promise<string> {
  return hasOverrides() ? writePatchedProject() : SOURCE_SB3;
}

/** 参考实现将要运行的项目，不写入任何内容，用于缓存键。 */
export function referenceProjectPath(): string {
  return hasOverrides() ? PATCHED_SB3 : SOURCE_SB3;
}

export interface RefSession {
  page: Page;
  browser: Browser;
  close: () => Promise<void>;
}

/** 在无头浏览器中打开参考运行器，并等到项目或 `opts.sb3` 加载完成。 */
export async function openReference(opts: { headless?: boolean; sb3?: string } = {}): Promise<RefSession> {
  const server = await startStaticServer(ROOT);
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: opts.headless ?? true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  // 编译后的日期积木读取本地时间，因此页面在 UTC 中运行，本地时间即模拟时钟。
  const page = await browser.newPage({ viewport: { width: 980, height: 760 }, timezoneId: 'UTC' });
  page.on('pageerror', (e) => console.error('[ref pageerror]', e.message));
  page.on('console', (m) => {
    const text = m.text();
    if (/Translation for|willReadFrequently/.test(text)) return;
    if (m.type() === 'error' || m.type() === 'warning') console.error(`[ref ${m.type()}]`, text.slice(0, 300));
  });
  const sb3 = path.relative(ROOT, opts.sb3 ?? await referenceProject()).replace(/\\/g, '/');
  await page.goto(`${server.url}/reference/index.html?p=/${encodeURI(sb3)}`);
  await page.waitForFunction(() => (window as any).H?.ready || (window as any).H?.error, null, { timeout: 1_200_000, polling: 500 });
  const err = await page.evaluate(() => (window as any).H.error);
  if (err) throw new Error(`reference failed to load: ${err}`);
  return {
    page,
    browser,
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}
