// 将造型和声音文件复制到浏览器构建的 public/assets，替换原有内容。
// 矢量造型按原加载器规范化后的形式写入（viewBox、注入的字体）。注入的字体
// 占大部分字节，并在数百个造型中重复，因此每种字体只写入 public/assets/fonts 一次，
// 造型保留 `cbfont:<hash>` 标记，页面在绘制前会换回字体（src/render/webgl.ts）。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { adpcmToPcm, isAdpcm } from './lib/adpcm.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/ref-meta.json'), 'utf8'));
const project = JSON.parse(fs.readFileSync(path.join(ROOT, 'sb3/project.json'), 'utf8'));
const assetDir = path.join(ROOT, 'public/assets');
const costumeDir = path.join(assetDir, 'costumes');
const soundDir = path.join(assetDir, 'sounds');
const fontDir = path.join(assetDir, 'fonts');
fs.rmSync(assetDir, { recursive: true, force: true });
for (const d of [costumeDir, soundDir, fontDir]) fs.mkdirSync(d, { recursive: true });

const fonts = new Map<string, string>();
function shareFonts(svg: string): string {
  return svg.replace(/url\("(data:[^"]+)"\)/g, (whole, data: string) => {
    if (!/^data:(application\/x-font|font\/)/.test(data)) return whole;
    let id = fonts.get(data);
    if (!id) {
      id = createHash('sha1').update(data).digest('hex').slice(0, 12);
      fonts.set(data, id);
      fs.writeFileSync(path.join(fontDir, `${id}.txt`), data);
    }
    return `url("cbfont:${id}")`;
  });
}

let svgs = 0;
let bitmaps = 0;
let sounds = 0;
for (const t of meta) {
  for (const c of t.costumes) {
    const out = path.join(costumeDir, c.md5ext);
    if (c.format === 'svg') {
      fs.writeFileSync(out, shareFonts(fs.readFileSync(path.join(ROOT, 'out/svg', c.md5ext), 'utf8')));
      svgs++;
    } else {
      fs.copyFileSync(path.join(ROOT, 'sb3', c.md5ext), out);
      bitmaps++;
    }
  }
}
let converted = 0;
for (const t of project.targets) {
  for (const s of t.sounds) {
    const data = fs.readFileSync(path.join(ROOT, 'sb3', s.md5ext));
    const adpcm = isAdpcm(data);
    if (adpcm) converted++;
    fs.writeFileSync(path.join(soundDir, s.md5ext), adpcm ? adpcmToPcm(data) : data);
    sounds++;
  }
}
console.log(`svg ${svgs}, bitmap ${bitmaps}, sounds ${sounds} (${converted} from ADPCM), shared fonts ${fonts.size}`);
