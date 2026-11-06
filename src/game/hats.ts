// “实际戴上帽子”：每个斗士的帽子画在其头上并随头转动，而且紧跟在
// 斗士自己的画笔图层图章之后，因此帽子会获得斗士的轮廓，其他斗士也能遮住它。
// 它只改变画面。`tools/hat-anchors.ts` 生成 `hat-anchors.json` 中的头部位置。
import type { PenCmd, Runtime } from '../engine/runtime.ts';
import type { Target } from '../engine/target.ts';
import { def as fighterDef } from './generated/costumes.ts';
import anchorData from './hat-anchors.json' with { type: 'json' };

type Stamp = Extract<PenCmd, { op: 'stamp' }>;

/** 按皮肤索引：帽子点在造型单位中相对旋转中心的位置（y 向上）、顺时针旋转角度，以及镜像时为 1。 */
const anchors = new Map<number, readonly number[]>();
for (const c of fighterDef.costumes) {
  const a = (anchorData as Record<string, number[]>)[c.name];
  if (a) anchors.set(c.skin, a);
}

/** 变量 `!#` 为斗士角色的克隆编号：1 和 2 绘制斗士，4 和 5 绘制其帽子。 */
const NUM = fighterDef.varNames?.['!#'] ?? 'Num';

/** 图章所属的玩家以及它是否为帽子；其他所有图章为 null。 */
function role(owner: Target | undefined): { player: number; hat: boolean } | null {
  if (!owner || owner.sprite.def.name !== fighterDef.name) return null;
  const n = Number(owner.v[NUM]);
  if (n === 1 || n === 2) return { player: n, hat: false };
  if (n === 4 || n === 5) return { player: n - 3, hat: true };
  return null;
}

const RING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** 一个斗士一帧内的图章：轮廓、斗士及副本，然后是帽子及副本。 */
interface Group {
  bodies: number[];
  hats: Stamp[];
}

/**
 * 与斗士图章一起绘制的帽子：位于造型锚点给出的头部位置，随斗士旋转和翻转。
 * 它采用斗士图章的效果，因此会随斗士一起变白、淡出和闪烁，并保留帽子图章自身的颜色。
 */
function worn(body: Stamp, hat: Stamp, anchor: readonly number[]): Stamp {
  const [ax, ay, turn, mirrored] = anchor;
  const lx = (ax * body.sx) / 100, ly = (ay * body.sy) / 100;
  const r = ((body.dir - 90) * Math.PI) / 180;
  const flipped = body.sx < 0;
  const stamp: Stamp = {
    op: 'stamp',
    skin: hat.skin,
    x: body.x + lx * Math.cos(r) + ly * Math.sin(r),
    y: body.y - lx * Math.sin(r) + ly * Math.cos(r),
    sx: Math.abs(body.sx) * (flipped !== (mirrored === 1) ? -1 : 1),
    sy: body.sy,
    dir: body.dir + (flipped ? -turn : turn),
    fx: { ...body.fx, color: hat.fx.color },
  };
  if (hat.tint) stamp.tint = hat.tint;
  return stamp;
}

/** 从 `from` 开始的画笔命令，并将每顶帽子移动到其斗士的头部。 */
export function wearHats(rt: Runtime, cmds: readonly PenCmd[], from: number): readonly PenCmd[] {
  const owners = rt.stampOwners;
  if (!owners) return cmds.slice(from);
  const open = new Map<number, Group>();
  const groupOf = new Map<number, Group>();
  const moved = new Set<number>();
  for (let i = from; i < cmds.length; i++) {
    const cmd = cmds[i];
    if (cmd.op !== 'stamp') continue;
    const who = role(owners.get(cmd));
    if (!who) continue;
    let g = open.get(who.player);
    if (!who.hat) {
      if (!g || g.hats.length) open.set(who.player, (g = { bodies: [], hats: [] }));
      g.bodies.push(i);
      groupOf.set(i, g);
    } else if (g && g.bodies.every((b) => anchors.has((cmds[b] as Stamp).skin))) {
      g.hats.push(cmd);
      moved.add(i);
    }
  }
  if (moved.size === 0) return cmds.slice(from);
  const out: PenCmd[] = [];
  for (let i = from; i < cmds.length; i++) {
    if (moved.has(i)) continue;
    const cmd = cmds[i];
    out.push(cmd);
    const g = groupOf.get(i);
    if (!g || g.hats.length === 0) continue;
    // 斗士的轮廓图章最先出现，且没有自己的帽子图章。最后一个轮廓图章之后，帽子会
    // 以自己的白色圆环使用相同宽度，使轮廓包住两者。游戏的圆环缺少一条对角线，
    // 这在人物顶部最明显，因此帽子的圆环包含全部八条。
    const outlines = g.bodies.length - g.hats.length;
    const j = g.bodies.indexOf(i);
    if (outlines > 0 && j === outlines - 1) {
      const main = cmds[g.bodies[outlines]] as Stamp;
      const ring = g.bodies.slice(0, outlines).map((b) => cmds[b] as Stamp);
      const w = Math.max(...ring.map((s) => Math.max(Math.abs(s.x - main.x), Math.abs(s.y - main.y))));
      const anchor = anchors.get(main.skin)!;
      for (const [dx, dy] of RING) out.push(worn({ ...main, x: main.x + dx * w, y: main.y + dy * w, fx: ring[0].fx }, g.hats[0], anchor));
    }
    if (j === g.bodies.length - 1) {
      g.hats.forEach((hat, h) => {
        const body = cmds[g.bodies[Math.max(0, outlines + h)]] as Stamp;
        out.push(worn(body, hat, anchors.get(body.skin)!));
      });
    }
  }
  return out;
}
