// 查找每个斗士造型的头部，用于页面的“实际戴上帽子”选项。
// 每个角色的 Idle 造型给出头部：帽子落点下方的一个圆盘。该角色的其他造型
// 会搜索这个圆盘，经过旋转和镜像，并让帽子点和转向跟随最佳匹配。
// 用法：npx tsx tools/hat-anchors.ts [--only <character>] [--sheets <dir>]
// --sheets 会按匹配位置画出戴着帽子的每个造型，每个角色一张图。HAT_COSTS=1 打印每个
// 造型的匹配代价。
// 写入 src/game/hat-anchors.json。每个造型名称映射到 [x, y, turn, mirrored]：帽子点在造型单位中
// 相对旋转中心的位置（y 向上）、帽子顺时针转向角度，以及头部朝向反面时为 1。
// 不带 --only 时，每个角色运行一个子进程，同时运行多个。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readPng, writePng, type Image } from './lib/png.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src/game/hat-anchors.json');
/** 游戏自身代码中帽子相对斗士位置的高度，尚未应用按角色的偏移。 */
const HAT_BASE = 52;
/** 代价高于此值（平均通道差，0 到 1）的匹配会采用同一动作中某一帧的帽子点。 */
const MAX_COST = 0.3;
/** 粗搜索的转向角度。 */
const COARSE_STEP = 15;
/** 每度转向增加的代价，使帽子保持竖直，除非头部明显倾斜。 */
const TURN_COST = 0.00015;
/**
 * 帽子点最多可移动多远（单位）以落在头部轮廓上、它检查的带状区域（每侧单位数），以及
 * 该区域中必须为实心的比例。头顶的杆或光晕填充比例太小，不足以抬起帽子。
 */
const SETTLE_MAX = 8;
const SETTLE_BAND = 4;
const SETTLE_FILL = 0.6;
/**
 * 帽子点在头发顶部下方多远，以头部半径计：游戏自身帽子点的中位数。
 * 超出范围的游戏帽子点采用该中位数。
 */
const SINK = 0.45;
const SINK_RANGE = [0.3, 0.7];

/**
 * 检查图后手工修正的值，保存在 `tools/hat-fixes.json`。角色可设置 `sink`（头顶下方单位数）、
 * `radius`（头部半径，单位）、`dx` 和 `dy`（将 Idle 帽子点向右和向上移动的单位数）以及
 * `maxTurn`（帽子可向任一侧转动的角度，0 表示头部从不倾斜）。帧可映射到帽子点
 * [x, y, turn, mirrored]、另一造型名称（复制它）、{ dx, dy, turn }（调整它），或
 * { top: sink, wide }（将帽子竖直放入造型实心形状顶部那么多单位处，见 `topOf`）。
 */
interface Fixes {
  characters: Record<string, { sink?: number; radius?: number; dx?: number; dy?: number; maxTurn?: number }>;
  frames: Record<string, number[] | string | { dx?: number; dy?: number; turn?: number; top?: number; wide?: number }>;
}
const fixes = JSON.parse(fs.readFileSync(path.join(path.resolve(import.meta.dirname), 'hat-fixes.json'), 'utf8')) as Fixes;

interface SkinDef { w: number; h: number; rcx: number; rcy: number; kind: string; file: string; res: number }
interface CostumeRef { name: string; skin: number }
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/game/assets-data.json'), 'utf8')) as { skins: SkinDef[]; costumes: CostumeRef[][] };

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const only = opt('--only');
const sheets = opt('--sheets');
/** 子进程将条目写到这里，而不是写入表格。 */
const part = opt('--part');

/** 每造型单位 `scale` 像素处的预乘 RGBA，取值 0 到 1。 */
interface Layer { w: number; h: number; px: Float32Array; scale: number }

function premultiply(img: Image, scale: number): Layer {
  const px = new Float32Array(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) {
    const a = img.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) px[i * 4 + c] = (img.data[i * 4 + c] / 255) * a;
    px[i * 4 + 3] = a;
  }
  return { w: img.w, h: img.h, px, scale };
}

function half(l: Layer): Layer {
  const w = Math.ceil(l.w / 2), h = Math.ceil(l.h / 2), px = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = x * 2 + dx, sy = y * 2 + dy;
      if (sx >= l.w || sy >= l.h) continue;
      for (let c = 0; c < 4; c++) px[(y * w + x) * 4 + c] += l.px[(sy * l.w + sx) * 4 + c] / 4;
    }
  }
  return { w, h, px, scale: l.scale / 2 };
}

const loadImage = (skin: SkinDef) => readPng(fs.readFileSync(path.join(ROOT, 'public/assets', skin.file)));

/** 每单位 1 和 0.5 像素的造型图像层，来自每单位 2 像素的位图。 */
function pyramid(skin: SkinDef): [Layer, Layer] {
  const l1 = half(premultiply(loadImage(skin), skin.res));
  return [l1, half(l1)];
}

const alphaAt = (l: Layer, x: number, y: number) => (x < 0 || y < 0 || x >= l.w || y >= l.h ? 0 : l.px[(y * l.w + x) * 4 + 3]);

/** 参考层的头部圆盘：相对其中心的像素偏移（y 向下）及像素值。 */
interface Disc { dx: Float32Array; dy: Float32Array; v: Float32Array; n: number; r: number }

function disc(l: Layer, cx: number, cy: number, r: number): Disc {
  const dx: number[] = [], dy: number[] = [], v: number[] = [];
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    const ox = x + 0.5 - cx, oy = y + 0.5 - cy;
    if (ox * ox + oy * oy > r * r) continue;
    dx.push(ox);
    dy.push(oy);
    for (let c = 0; c < 4; c++) v.push(x < 0 || y < 0 || x >= l.w || y >= l.h ? 0 : l.px[(y * l.w + x) * 4 + c]);
  }
  return { dx: Float32Array.from(dx), dy: Float32Array.from(dy), v: Float32Array.from(v), n: dx.length, r };
}

/** 圆盘偏移经可选镜像后顺时针旋转 `turn` 度，并向下取整到整像素。 */
function turned(d: Disc, turn: number, mirror: boolean): Int32Array {
  const c = Math.cos((turn * Math.PI) / 180), s = Math.sin((turn * Math.PI) / 180), out = new Int32Array(d.n * 2);
  for (let i = 0; i < d.n; i++) {
    const x = mirror ? -d.dx[i] : d.dx[i], y = d.dy[i];
    out[i * 2] = Math.floor(x * c - y * s);
    out[i * 2 + 1] = Math.floor(x * s + y * c);
  }
  return out;
}

/** 圆盘中心位于像素 (tx, ty) 时圆盘与目标的平均通道差；超过 `limit` 时为 Infinity。 */
function cost(d: Disc, offs: Int32Array, t: Layer, tx: number, ty: number, limit: number): number {
  const stop = limit * d.n * 4;
  let sum = 0;
  for (let i = 0; i < d.n; i++) {
    const x = tx + offs[i * 2], y = ty + offs[i * 2 + 1], v = i * 4;
    if (x < 0 || y < 0 || x >= t.w || y >= t.h) {
      sum += d.v[v] + d.v[v + 1] + d.v[v + 2] + d.v[v + 3];
    } else {
      const p = (y * t.w + x) * 4;
      sum += Math.abs(d.v[v] - t.px[p]) + Math.abs(d.v[v + 1] - t.px[p + 1]) + Math.abs(d.v[v + 2] - t.px[p + 2]) + Math.abs(d.v[v + 3] - t.px[p + 3]);
    }
    if (sum > stop) return Infinity;
  }
  return sum / (d.n * 4);
}

interface Match { x: number; y: number; turn: number; mirror: boolean; cost: number }

/** 正面视图无论朝向哪边都能匹配，因此镜像必须明显胜出。 */
const MIRROR_COST = 0.01;
const extra = (turn: number, mirror: boolean) => Math.abs(turn) * TURN_COST + (mirror ? MIRROR_COST : 0);

/** 头部圆盘在目标中的最佳位置，以 1 级像素中的圆盘中心表示。 */
function search(ref: { coarse: Disc; fine: Disc }, [t1, t2]: [Layer, Layer], maxTurn = 180): Match {
  const seeds: Match[] = [];
  for (const mirror of [false, true]) {
    for (let turn = -180; turn < 180; turn += COARSE_STEP) {
      if (Math.abs(turn) > maxTurn) continue;
      const offs = turned(ref.coarse, turn, mirror);
      let best: Match = { x: 0, y: 0, turn, mirror, cost: Infinity };
      for (let y = 0; y < t2.h; y++) for (let x = 0; x < t2.w; x++) {
        if (alphaAt(t2, x, y) < 0.5) continue;
        const c = cost(ref.coarse, offs, t2, x, y, best.cost);
        if (c < best.cost) best = { x, y, turn, mirror, cost: c };
      }
      if (best.cost < Infinity) seeds.push(best);
    }
  }
  const ranked = (m: Match) => m.cost + extra(m.turn, m.mirror);
  seeds.sort((a, b) => ranked(a) - ranked(b));
  let best: Match = { x: 0, y: 0, turn: 0, mirror: false, cost: Infinity };
  for (const seed of seeds.slice(0, 6)) {
    let m: Match = { ...seed, x: seed.x * 2, y: seed.y * 2, cost: Infinity };
    let score = Infinity;
    for (const [span, step, reach] of [[12, 3, 3], [2, 1, 1]] as const) {
      const from = m;
      for (let turn = Math.max(-maxTurn, from.turn - span); turn <= Math.min(maxTurn, from.turn + span); turn += step) {
        const offs = turned(ref.fine, turn, from.mirror);
        const add = extra(turn, from.mirror);
        for (let y = from.y - reach; y <= from.y + reach; y++) for (let x = from.x - reach; x <= from.x + reach; x++) {
          const c = cost(ref.fine, offs, t1, x, y, score - add);
          if (c + add < score) {
            score = c + add;
            m = { x, y, turn, mirror: from.mirror, cost: c };
          }
        }
      }
    }
    if (ranked(m) < ranked(best)) best = m;
  }
  return best;
}

/**
 * 从 (x, y) 沿 `up` 向上多远是头部轮廓（像素）：从头部内侧沿该线向上走带状区域，
 * 轮廓是遇到空隙前的最后一个实心位置。带状区域从未实心时返回 null。
 */
function outline(l: Layer, x: number, y: number, ux: number, uy: number): number | null {
  const band = SETTLE_BAND * l.scale;
  let last: number | null = null, gap = 0;
  for (let t = -12 * l.scale; t <= 24 * l.scale; t++) {
    let solid = 0;
    for (let b = -band; b <= band; b++) if (alphaAt(l, Math.round(x + ux * t - uy * b), Math.round(y + uy * t + ux * b)) >= 0.8) solid++;
    if (solid >= SETTLE_FILL * (2 * band + 1)) {
      last = t;
      gap = 0;
    } else if (last !== null && ++gap >= 3) break;
  }
  return last;
}

/** x 周围各列中最上方的不透明行，或 -1。 */
function topAt(l: Layer, x: number, reach: number): number {
  for (let y = 0; y < l.h; y++) for (let dx = -reach; dx <= reach; dx++) if (alphaAt(l, Math.round(x) + dx, y) > 0.5) return y;
  return -1;
}

/** 参考层中的帽子点（像素，y 向下）：游戏自身的点，或当它没落在头上时的头顶。 */
function hatPoint(l: Layer, skin: SkinDef, hatY: number): { x: number; y: number; own: boolean } {
  const own = { x: skin.rcx * l.scale, y: (skin.rcy - hatY) * l.scale };
  const top = topAt(l, own.x, 4);
  if (top >= 0 && own.y >= top - 8 && own.y <= top + 20) return { ...own, own: true };
  // 头部是顶部 25 单位内的不透明主体，帽子落在其中部稍下方。
  const first = topAt(l, l.w / 2, Math.ceil(l.w / 2));
  let lo = Infinity, hi = -Infinity;
  for (let y = first; y < Math.min(l.h, first + 25); y++) for (let x = 0; x < l.w; x++) if (alphaAt(l, x, y) > 0.5) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  const x = (lo + hi + 1) / 2;
  return { x, y: topAt(l, x, 3) + 3, own: false };
}

/** 帽子点下方最宽不透明连续段宽度的一半，即头部的像素半径。 */
function headRadius(l: Layer, x: number, y: number): number {
  let widest = 0;
  for (let row = Math.round(y + 6); row < Math.min(l.h, y + 20); row++) {
    let a = Math.round(x), b = Math.round(x);
    if (alphaAt(l, a, row) < 0.5) continue;
    while (alphaAt(l, a - 1, row) >= 0.5) a--;
    while (alphaAt(l, b + 1, row) >= 0.5) b++;
    widest = Math.max(widest, b - a + 1);
  }
  return Math.min(30, Math.max(12, widest / 2));
}

/** 帽子点下方几行中头部的横向中点：该处不透明连续段中点的中位数。 */
function headMiddle(l: Layer, x: number, y: number, r: number): number {
  const middles: number[] = [];
  for (let row = Math.round(y); row < Math.min(l.h, y + 0.4 * r); row++) {
    let a = Math.round(x), b = Math.round(x);
    if (alphaAt(l, a, row) < 0.5) continue;
    while (alphaAt(l, a - 1, row) >= 0.5) a--;
    while (alphaAt(l, b + 1, row) >= 0.5) b++;
    middles.push((a + b + 1) / 2);
  }
  middles.sort((a, b) => a - b);
  return middles.length ? middles[middles.length >> 1] : x;
}

/**
 * 足够宽（与落定带同宽）的带状区域连续实心的最上方一行的中点（像素），或 null。
 * 使用 `wide`（单位）时，改为该宽度内无断裂实心段的最上方一行，使形状上方的细线不被计入。
 */
function topOf(l: Layer, wide = 0): { x: number; y: number } | null {
  const band = SETTLE_BAND * l.scale, need = SETTLE_FILL * (2 * band + 1);
  for (let y = 0; y < l.h && wide > 0; y++) {
    for (let x = 0; x < l.w; x++) {
      let end = x;
      while (end < l.w && alphaAt(l, end, y) >= 0.8) end++;
      if (end - x >= wide * l.scale) return { x: (x + end) / 2, y };
      x = end;
    }
  }
  for (let y = 0; y < l.h && wide === 0; y++) {
    const hits: number[] = [];
    for (let x = 0; x < l.w; x++) {
      let solid = 0;
      for (let b = -band; b <= band; b++) if (alphaAt(l, x + b, y) >= 0.8) solid++;
      if (solid >= need) hits.push(x);
    }
    if (hits.length) return { x: (hits[0] + hits[hits.length - 1] + 1) / 2, y };
  }
  return null;
}

/** 舞台列表 `#MD_HatOffsets` 中按角色编号索引的帽子偏移。 */
function hatOffsets(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'src/game/generated/Stage_.ts'), 'utf8');
  const m = /^\s*Num_MD_HatOffsets: (\[.*\]),$/m.exec(src);
  if (!m) throw new Error('no #MD_HatOffsets list in Stage_.ts');
  return JSON.parse(m[1]) as string[];
}

/** 绘制斗士及其帽子的角色：同时拥有 "1Idle" 和 "hat1" 造型的角色。 */
const list = table.costumes.find((l) => l.some((c) => c.name === '1Idle') && l.some((c) => c.name === 'hat1'));
if (!list) throw new Error('no fighter sprite');
const byChar = new Map<string, CostumeRef[]>();
for (const c of list) {
  const m = /^(\d+)\D/.exec(c.name);
  if (!m || (only && m[1] !== only)) continue;
  if (!byChar.has(m[1])) byChar.set(m[1], []);
  byChar.get(m[1])!.push(c);
}

interface Cell { name: string; img: Image; skin: SkinDef; entry: number[]; cost: number; used: boolean }

function anchorsFor(char: string, costumes: CostumeRef[], offsets: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const refCostume = costumes.find((c) => c.name === `${char}Idle`);
  if (!refCostume) return out;
  const refSkin = table.skins[refCostume.skin];
  const ref = pyramid(refSkin);
  const fix = fixes.characters[char] ?? {};
  const p = hatPoint(ref[0], refSkin, HAT_BASE + (Number(offsets[Number(char) - 1]) || 0));
  const r = fix.radius ?? headRadius(ref[0], p.x, p.y);
  // 帽子位于头发顶部（两耳之间）下方这么多单位处，因此落在头上。
  const top = outline(ref[0], p.x, p.y, 0, -1);
  const hair = top === null ? p.y : p.y - top;
  if (top !== null) p.y = hair + (fix.sink ?? (p.own && top >= SINK_RANGE[0] * r && top <= SINK_RANGE[1] * r ? top : SINK * r));
  // 游戏的帽子点是造型的旋转中心，在四分之三视角中偏离头部中心。
  p.x = headMiddle(ref[0], p.x, p.y, r) + (fix.dx ?? 0);
  p.y -= fix.dy ?? 0;
  // 圆盘包含头部及其上方少量空白。
  const cx = p.x, cy = hair + r * 0.85;
  const discs = { coarse: disc(ref[1], cx / 2, cy / 2, r / 2), fine: disc(ref[0], cx, cy, r) };
  const fromCenter = { x: p.x - cx, y: p.y - cy };
  // 每次匹配都保留 Idle 造型在头部轮廓下方的深度。
  const depth = outline(ref[0], p.x, p.y, 0, -1) ?? 0;
  const matched = new Map<string, { entry: number[]; cost: number }>();
  const cells = new Map<string, Cell>();
  for (const c of costumes) {
    const skin = table.skins[c.skin];
    if (skin.kind !== 'bitmap') continue;
    const layers = c === refCostume ? ref : pyramid(skin);
    const m = c === refCostume ? { x: cx, y: cy, turn: 0, mirror: false, cost: 0 } : search(discs, layers, fix.maxTurn);
    const a = (m.turn * Math.PI) / 180, hx = (m.mirror ? -1 : 1) * fromCenter.x, hy = fromCenter.y;
    let px = m.x + hx * Math.cos(a) - hy * Math.sin(a), py = m.y + hx * Math.sin(a) + hy * Math.cos(a);
    const ux = Math.sin(a), uy = -Math.cos(a);
    const edge = outline(layers[0], px, py, ux, uy);
    if (edge !== null) {
      const move = Math.max(-SETTLE_MAX, Math.min(SETTLE_MAX, edge - depth));
      px += ux * move;
      py += uy * move;
    }
    const entry = [round(px - skin.rcx), round(skin.rcy - py), Math.round(((m.turn + 540) % 360) - 180), m.mirror ? 1 : 0];
    matched.set(c.name, { entry, cost: m.cost });
    if (process.env.HAT_COSTS) console.log(`${c.name} ${m.cost.toFixed(3)} ${entry.join(' ')}`);
    if (sheets) cells.set(c.name, { name: c.name, img: loadImage(skin), skin, entry, cost: m.cost, used: true });
  }
  // 找不到头部的帧（例如旋转）会采用同一动作中名称开头
  // 与其共享最长前缀的帧的帽子点。
  const good = [...matched].filter(([, v]) => v.cost <= MAX_COST);
  const shared = (a: string, b: string) => {
    let n = 0;
    while (n < a.length && a[n] === b[n]) n++;
    return n;
  };
  let used = 0;
  for (const [name, v] of matched) {
    if (v.cost <= MAX_COST) {
      out[name] = v.entry;
      used++;
      continue;
    }
    let pick = refCostume.name, most = char.length + 1;
    for (const [other] of good) if (shared(name, other) > most) [pick, most] = [other, shared(name, other)];
    out[name] = good.length ? (matched.get(pick)?.entry ?? v.entry) : v.entry;
    const cell = cells.get(name);
    if (cell) Object.assign(cell, { entry: out[name], used: false });
  }
  for (const name of Object.keys(out)) {
    const f = fixes.frames[name];
    if (f === undefined) continue;
    const [x, y, turn, mirror] = out[name];
    if (typeof f === 'string') out[name] = [...(out[f] ?? out[name])];
    else if (Array.isArray(f)) out[name] = f;
    else if (f.top !== undefined) {
      const skin = table.skins[costumes.find((c) => c.name === name)!.skin];
      const t = topOf(pyramid(skin)[0], f.wide);
      out[name] = t ? [round(t.x - skin.rcx + (f.dx ?? 0)), round(skin.rcy - t.y - f.top + (f.dy ?? 0)), f.turn ?? 0, 0] : out[name];
    } else out[name] = [round(x + (f.dx ?? 0)), round(y + (f.dy ?? 0)), turn + (f.turn ?? 0), mirror];
    const cell = cells.get(name);
    if (cell) cell.entry = out[name];
  }
  if (sheets) writeSheet(path.resolve(sheets, `${char}.png`), [...cells.values()]);
  console.log(`${char}: ${costumes.length} costumes, ${used} matched; hat point ${p.own ? 'from the game' : 'found'}, head radius ${r.toFixed(1)}`);
  return out;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

const DIGITS = [
  ['111', '101', '101', '101', '111'], ['010', '110', '010', '010', '111'], ['111', '001', '111', '100', '111'],
  ['111', '001', '111', '001', '111'], ['101', '101', '111', '001', '001'], ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'], ['111', '001', '001', '001', '001'], ['111', '101', '111', '101', '111'],
  ['111', '101', '111', '001', '111'],
];

/**
 * 按匹配位置画出戴着帽子 1 的每个造型、其编号和匹配代价条，未采用匹配时显示为红色。
 * 图旁文本文件列出每个编号对应的造型。
 */
function writeSheet(file: string, cells: Cell[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file.replace(/\.png$/, '.txt'), cells.map((c, k) => `${k} ${c.name} ${c.entry.join(' ')} ${c.cost.toFixed(3)}`).join('\n') + '\n');
  const hatSkin = table.skins[list!.find((c) => c.name === 'hat1')!.skin];
  const hat = loadImage(hatSkin);
  const CW = 300, CH = 260, cols = 8;
  const out: Image = { w: CW * cols, h: CH * Math.ceil(cells.length / cols), data: new Uint8Array(0) };
  out.data = new Uint8Array(out.w * out.h * 4).fill(255);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= out.w || y >= out.h || a <= 0) return;
    const i = (y * out.w + x) * 4, k = a / 255;
    out.data[i] = out.data[i] * (1 - k) + r * k;
    out.data[i + 1] = out.data[i + 1] * (1 - k) + g * k;
    out.data[i + 2] = out.data[i + 2] * (1 - k) + b * k;
  };
  cells.forEach((c, k) => {
    const ox = (k % cols) * CW + 10, oy = Math.floor(k / cols) * CH + 30;
    const s = Math.min(1, (CW - 20) / c.img.w, (CH - 40) / c.img.h);
    for (let y = 0; y < c.img.h * s; y++) for (let x = 0; x < c.img.w * s; x++) {
      const i = (Math.floor(y / s) * c.img.w + Math.floor(x / s)) * 4;
      put(ox + x, oy + y, c.img.data[i], c.img.data[i + 1], c.img.data[i + 2], c.img.data[i + 3]);
    }
    // 相对帽子点的造型像素 q 对应帽子像素 M R(-turn) q。
    const [ux, uy, turn, mirror] = c.entry;
    const res = c.skin.res, px = (ux + c.skin.rcx) * res, py = (c.skin.rcy - uy) * res;
    const a = (turn * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    for (let y = -80; y < 80; y++) for (let x = -80; x < 80; x++) {
      let hx = x * cos + y * sin;
      const hy = -x * sin + y * cos;
      if (mirror) hx = -hx;
      const ix = Math.floor(hx + hatSkin.rcx * hatSkin.res), iy = Math.floor(hy + hatSkin.rcy * hatSkin.res);
      if (ix < 0 || iy < 0 || ix >= hat.w || iy >= hat.h) continue;
      const i = (iy * hat.w + ix) * 4;
      put(ox + (px + x) * s, oy + (py + y) * s, hat.data[i], hat.data[i + 1], hat.data[i + 2], hat.data[i + 3] * 0.85);
    }
    const bar = Math.min(CW - 140, Math.round((c.cost / MAX_COST) * 100));
    for (let x = 0; x < bar; x++) for (let y = 0; y < 6; y++) put(ox + 40 + x, oy - 20 + y, c.used ? 40 : 230, c.used ? 160 : 30, 40, 255);
    // 该单元格在图的造型名称列表中的编号，用 3x5 像素字体放大 3 倍绘制。
    [...String(k)].forEach((d, n) => DIGITS[Number(d)].forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit === '1') for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) put(ox + n * 12 + x * 3 + sx, oy - 26 + y * 3 + sy, 0, 0, 0, 255);
    })));
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, writePng(out));
}

/** 每个角色在独立进程中运行，同时运行多个，并返回所有条目。 */
async function runAll(chars: string[]): Promise<Record<string, number[]>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hat-anchors-'));
  const queue = [...chars];
  const result: Record<string, number[]> = {};
  const worker = async () => {
    for (let char = queue.shift(); char !== undefined; char = queue.shift()) {
      const file = path.join(dir, `${char}.json`);
      const childArgs = ['--import', 'tsx', path.join(ROOT, 'tools/hat-anchors.ts'), '--only', char, '--part', file, ...(sheets ? ['--sheets', sheets] : [])];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, childArgs, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`character ${char} failed with code ${code}`))));
      });
      Object.assign(result, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, os.cpus().length - 2) }, worker));
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

const started = Date.now();
let entries: Record<string, number[]>;
if (only) {
  entries = anchorsFor(only, byChar.get(only) ?? [], hatOffsets());
  if (!part) entries = { ...(fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}), ...entries };
} else {
  entries = await runAll([...byChar.keys()]);
}
if (part) {
  fs.writeFileSync(part, JSON.stringify(entries));
} else {
  // 按造型顺序排列，使文件只在匹配结果改变处变化。
  const sorted: Record<string, number[]> = {};
  for (const c of list) if (entries[c.name]) sorted[c.name] = entries[c.name];
  fs.writeFileSync(OUT, `${JSON.stringify(sorted)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(sorted).length} costumes in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
