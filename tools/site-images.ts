// 从游戏造型渲染站点图标、触摸图标和链接预览图。
// 用法：npx tsx tools/site-images.ts "<sprite>" "<costume>" [x,y,size] [--art "<sprite>" "<costume>"] [--clear-shadow]
//          [--icon "<sprite>" "<costume>"]
// 图标显示造型自身像素坐标 x,y（左上角）处给定大小的正方形，或整个造型，置于
// 白色圆角方块上。使用 --icon 时改为显示该造型的可见像素，背景透明。
// 预览图将整个造型居中放在白底上；使用 --art 时则用该造型填充深色晕影
// 下的图像。--clear-shadow 会将造型中半透明的纯黑像素变为透明，从而去除
// 绘制在其中的阴影。
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { allCostumes, skins } from '../src/game/assets.ts';
import { modules } from '../src/game/generated/index.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public');
const args = process.argv.slice(2);
/** 从参数中移除 `--name` 及其后的 `count` 个值，并返回这些值。 */
function option(name: string, count: number): string[] | null {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, count + 1).slice(1) : null;
}
const artArgs = option('--art', 2);
const iconArgs = option('--icon', 2);
const clearShadow = option('--clear-shadow', 0) !== null;
const [sprite, costumeName, crop] = args;
const usage =
  'usage: npx tsx tools/site-images.ts "<sprite>" "<costume>" [x,y,size] [--art "<sprite>" "<costume>"] [--clear-shadow] [--icon "<sprite>" "<costume>"]';
if (!sprite || !costumeName || (artArgs && artArgs.length < 2) || (iconArgs && iconArgs.length < 2)) throw new Error(usage);

interface Picture {
  src: string;
  w: number;
  h: number;
  /** 图片自身像素中的可见像素。 */
  box: { x: number; y: number; w: number; h: number };
}

/** 造型的 data URL 及图像像素尺寸，共享字体会放回矢量图像。 */
function costume(spriteName: string, name: string): Picture {
  const ti = modules.findIndex((m) => m.def.name === spriteName);
  const c = allCostumes[ti]?.find((x) => x.name === name);
  if (!c) throw new Error(`missing costume ${spriteName}/${name}`);
  const skin = skins[c.skin];
  const file = path.join(OUT, 'assets', skin.file);
  if (skin.kind === 'svg') {
    const svg = fs.readFileSync(file, 'utf8').replace(/cbfont:([0-9a-f]+)/g, (_m, id: string) => fs.readFileSync(path.join(OUT, 'assets/fonts', `${id}.txt`), 'utf8'));
    return { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, w: skin.w, h: skin.h, box: { x: 0, y: 0, w: skin.w, h: skin.h } };
  }
  const png = fs.readFileSync(file);
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  return { src: `data:image/png;base64,${png.toString('base64')}`, w, h, box: { x: 0, y: 0, w, h } };
}

/** 在页面中查找图片的可见像素，先用 `clear` 清除半透明纯黑像素。 */
async function measure(tab: Page, pic: Picture, clear: boolean): Promise<void> {
  const r = await tab.evaluate(
    async ({ src, w, h, clear }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const d = data.data;
      let [x0, y0, x1, y1] = [w, h, -1, -1];
      for (let i = 0; i < d.length; i += 4) {
        if (clear && d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] < 255) d[i + 3] = 0;
        if (d[i + 3] < 16) continue;
        const px = (i / 4) % w;
        const py = Math.floor(i / 4 / w);
        [x0, y0, x1, y1] = [Math.min(x0, px), Math.min(y0, py), Math.max(x1, px), Math.max(y1, py)];
      }
      const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      if (!clear) return { src, box };
      ctx.putImageData(data, 0, 0);
      return { src: c.toDataURL('image/png'), box };
    },
    { src: pic.src, w: Math.round(pic.w), h: Math.round(pic.h), clear },
  );
  pic.src = r.src;
  if (r.box.w > 0) pic.box = r.box;
}

const logo = costume(sprite, costumeName);
const iconPic = iconArgs ? costume(iconArgs[0], iconArgs[1]) : null;
const [cx, cy, cs] = crop ? crop.split(',').map(Number) : [0, 0, Math.max(logo.w, logo.h)];

function page(w: number, h: number, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:transparent"><div style="position:relative;width:${w}px;height:${h}px;overflow:hidden">${body}</div></body></html>`;
}

/** 按 `scale` 缩放图片，使其可见像素中心位于 (x, y)。 */
function centered(pic: Picture, x: number, y: number, scale: number): string {
  const left = x - (pic.box.x + pic.box.w / 2) * scale;
  const top = y - (pic.box.y + pic.box.h / 2) * scale;
  return `<img src="${pic.src}" style="position:absolute;left:${left}px;top:${top}px;width:${pic.w * scale}px;height:${pic.h * scale}px">`;
}

function icon(size: number): string {
  if (iconPic) return page(size, size, centered(iconPic, size / 2, size / 2, (size * 0.96) / Math.max(iconPic.box.w, iconPic.box.h)));
  // 裁剪到白色圆角方块上，使深色轮廓在深色标签栏中也可见。
  const inner = size * 0.9;
  const s = inner / cs;
  const pad = (size - inner) / 2;
  return page(
    size,
    size,
    `<div style="position:absolute;inset:0;background:#fff;border-radius:${size * 0.18}px"></div>` +
      `<div style="position:absolute;left:${pad}px;top:${pad}px;width:${inner}px;height:${inner}px;overflow:hidden">` +
      `<img src="${logo.src}" style="position:absolute;left:${-cx * s}px;top:${-cy * s}px;width:${logo.w * s}px;height:${logo.h * s}px"></div>`,
  );
}

function preview(): string {
  if (!artArgs) return page(1200, 630, `<div style="position:absolute;inset:0;background:#fff"></div>${centered(logo, 600, 315, Math.min(1100 / logo.box.w, 590 / logo.box.h))}`);
  const art = costume(artArgs[0], artArgs[1]);
  return page(
    1200,
    630,
    centered(art, 600, 315, Math.max(1200 / art.w, 630 / art.h)) +
      '<div style="position:absolute;inset:0;background:radial-gradient(ellipse at center, rgba(22,18,40,0.25), rgba(10,10,18,0.75))"></div>' +
      centered(logo, 600, 315, Math.min(760 / logo.box.w, 400 / logo.box.h)),
  );
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const tab = await browser.newPage();
await measure(tab, logo, clearShadow);
if (iconPic) await measure(tab, iconPic, false);
const jobs: [string, number, number, string, boolean][] = [
  ['favicon.png', 64, 64, icon(64), true],
  ['apple-touch-icon.png', 180, 180, icon(180), true],
  ['preview.png', 1200, 630, preview(), false],
];
for (const [file, w, h, html, transparent] of jobs) {
  await tab.setViewportSize({ width: w, height: h });
  await tab.setContent(html);
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await tab.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width: w, height: h }, omitBackground: transparent });
  console.log(`wrote public/${file} (${w}x${h})`);
}
await browser.close();
