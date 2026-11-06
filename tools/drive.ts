// 用令牌脚本驱动移植版游戏，并将输入记录为一致性场景。
// 用法：npx tsx tools/drive.ts "<tokens>" [save-as] [seed]
// 令牌：
//   click:NAME[/w]  将鼠标移到名为 NAME 的显示角色上（最上层的显示角色），按下并释放，然后
//                   运行 w 帧（默认 30）
//   click:NAME#n    对该角色的第 n 个显示目标执行相同操作，克隆按创建顺序从 0 计数
//   KEY*h/w         点按 KEY h 帧（默认 3），然后运行 w 帧（默认 20）；两词键名用 _（left_arrow）
//   hold:KEY/n      按住 KEY n 帧
//   wait/n          运行 n 帧
//   fuzz/n          随机按下双方玩家的按键 n 帧
import fs from 'node:fs';
import path from 'node:path';
import { createPort } from './lib/port.ts';
import type { ScenarioEvent, Scenario } from './lib/port.ts';
import type { PlayerInput } from '../src/engine/io.ts';
import { Rng } from '../src/engine/rng.ts';
import type { Runtime } from '../src/engine/runtime.ts';
import type { Target } from '../src/engine/target.ts';
import { ACTIONS, seatKeys } from '../src/client/controls.ts';
import { describe } from '../src/game/screens.ts';

const tokens = (process.argv[2] ?? '').split(/\s+/).filter(Boolean);
const saveAs = process.argv[3];
const seed = Number(process.argv[4] ?? 7);
const fuzzRng = new Rng(seed * 31 + 7);

const rt: Runtime = createPort(seed);
rt.logPen = false;
rt.greenFlag();
const events: ScenarioEvent[] = [];
const held = new Set<string>();
let mouse: { x: number; y: number; down: boolean } | undefined;
let f = 0;

/** 游戏当前读取的双方玩家按键，不含暂停键，因为随机暂停会让整次运行耗在暂停菜单里。 */
const controls = (): string[][] => [0, 1].map((seat) => seatKeys(rt, seat).filter((k, i) => k !== '' && ACTIONS[i] !== 'Pause'));
const toName = (k: string) => (k.length === 1 ? k.toUpperCase() : k);

const step = () => {
  f++;
  for (const e of events) {
    if (e.f !== f) continue;
    if (e.type === 'key') e.down ? held.add(e.key) : held.delete(e.key);
  }
  const m = events.filter((e) => e.f === f && e.type === 'mouse').pop() as Extract<ScenarioEvent, { type: 'mouse' }> | undefined;
  const inp: PlayerInput = { keys: [...held] };
  if (m) {
    mouse = { x: m.x, y: m.y, down: m.down ?? mouse?.down ?? false };
    inp.mouse = { ...mouse };
  }
  rt.stepFrame([inp]);
};
const run = (n: number) => { for (let i = 0; i < n; i++) step(); };
const press = (key: string, hold: number, wait: number) => {
  events.push({ f: f + 1, type: 'key', key, down: true }, { f: f + 1 + hold, type: 'key', key, down: false });
  run(hold + wait);
};

/** 目标遮罩内的一个点，该处目标是按点击拾取方式可见的最上层角色。 */
function clickPoint(t: Target): [number, number] | null {
  const b = rt.render.aabb(t);
  const xs: number[] = [], ys: number[] = [];
  for (let x = Math.ceil(b.left); x <= Math.floor(b.right); x += 2) xs.push(x);
  for (let y = Math.ceil(b.bottom); y <= Math.floor(b.top); y += 2) ys.push(y);
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
  const pts = xs.flatMap((x) => ys.map((y) => [x, y] as [number, number])).sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
  for (const [x, y] of pts) {
    if (x <= -240 || x >= 240 || y <= -180 || y >= 180) continue;
    if (!rt.render.touchingPoint(t, x, y)) continue;
    const above = rt.drawList.slice(rt.drawList.indexOf(t) + 1).some((o) => o.visible && o.effects.ghost < 100 && rt.render.touchingPoint(o, x, y));
    if (!above) return [x, y];
  }
  return null;
}

function click(name: string, index: number, wait: number): void {
  const sprite = rt.getSpriteTargetByName(name)?.sprite;
  const shown = (sprite?.clones ?? []).filter((c) => c.visible);
  const t = index >= 0 ? shown[index] : rt.drawList.filter((c) => c.name === name && c.visible).pop();
  if (!t) throw new Error(`no shown sprite ${name}${index >= 0 ? `#${index}` : ''}`);
  const p = clickPoint(t);
  if (!p) throw new Error(`no clickable point on ${name}`);
  events.push({ f: f + 1, type: 'mouse', x: p[0], y: p[1] }, { f: f + 2, type: 'mouse', x: p[0], y: p[1], down: true }, { f: f + 5, type: 'mouse', x: p[0], y: p[1], down: false });
  run(5 + wait);
}

const show = (label: string) => console.log(`${label.padEnd(18)} f=${f} ${describe(rt)}`);

for (const tok of tokens) {
  if (tok.startsWith('click:')) {
    const m = tok.match(/^click:([^#/]+)(?:#(\d+))?(?:\/(\d+))?$/)!;
    click(m[1].replace(/_/g, ' '), m[2] === undefined ? -1 : Number(m[2]), Number(m[3] ?? 30));
  } else if (tok.startsWith('hold:')) {
    const m = tok.match(/^hold:([^/]+)\/(\d+)$/)!;
    press(m[1].replace(/_/g, ' '), Number(m[2]), 0);
  } else if (tok.startsWith('answer:')) {
    // answer:TEXT/w 在打开的问题框中输入 TEXT，然后运行 w 帧（默认 20）；_ 表示空格。
    const m = tok.match(/^answer:([^/]*)(?:\/(\d+))?$/)!;
    events.push({ f: f + 1, type: 'answer', text: m[1].replace(/_/g, ' ') });
    run(Number(m[2] ?? 20));
  } else if (tok.startsWith('wait/')) {
    run(Number(tok.slice(5)));
  } else if (tok.startsWith('fuzz/')) {
    const end = f + Number(tok.slice(5));
    const rows = controls().map((r) => r.map(toName));
    const down = new Set<string>();
    while (f < end) {
      const row = rows[fuzzRng.next() < 0.5 ? 0 : 1];
      const k = row[Math.floor(fuzzRng.next() * row.length)];
      events.push({ f: f + 1, type: 'key', key: k, down: !down.has(k) });
      if (down.has(k)) down.delete(k);
      else down.add(k);
      run(1 + Math.floor(fuzzRng.next() * 8));
    }
    for (const k of down) events.push({ f: f + 1, type: 'key', key: k, down: false });
    run(1);
  } else {
    const m = tok.match(/^([^*/]+)(?:\*(\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad token ${tok}`);
    press(toName(m[1].replace(/_/g, ' ')), Number(m[2] ?? 3), Number(m[3] ?? 20));
  }
  show(tok);
}
if (saveAs) {
  const sc: Scenario = { name: saveAs, seed, frames: f + 30, events };
  fs.mkdirSync(path.resolve(import.meta.dirname, '../tests/scenarios'), { recursive: true });
  fs.writeFileSync(path.resolve(import.meta.dirname, `../tests/scenarios/${saveAs}.json`), JSON.stringify(sc));
  console.log(`saved tests/scenarios/${saveAs}.json (${sc.frames} frames)`);
}
