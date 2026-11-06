// 游戏当前显示的界面。在线按键映射、触屏控制和工具摘要都会读取它。
import type { Runtime } from '../engine/runtime.ts';
import type { Target } from '../engine/target.ts';
import { STATUS_DONE } from '../engine/thread.ts';
import { toStr } from '../engine/cast.ts';

function costumeName(t: Target): string {
  return t.sprite.costumes[t.currentCostume]?.name ?? '';
}

function stageVar(rt: Runtime, name: string): string {
  const prop = rt.stage.sprite.def.varNames?.[name];
  return prop === undefined ? '' : toStr(rt.stage.v[prop]);
}

/** 舞台的比赛循环（“Gameloop”）运行时为 true，从比赛开始持续到结束。 */
export function inMatch(rt: Runtime): boolean {
  return rt.threads.some((th) => th.target === rt.stage && th.script.msg === 'GAMELOOP' && th.status !== STATUS_DONE && !th.isKilled);
}

/** 角色选择界面为 true，此时玩家 2 的标签跟随玩家 2 的按键。 */
export function characterSelect(rt: Runtime): boolean {
  const menu = rt.getSpriteTargetByName('MenuUI');
  return !!menu && menu.sprite.clones.some((c) => c.visible && costumeName(c) === 'p2chip');
}

/** 比赛正在运行且游戏未暂停时为 true。 */
export function inPlay(rt: Runtime): boolean {
  return inMatch(rt) && stageVar(rt, '?pause') !== '1';
}

/**
 * 每位玩家的按键属于自己座位的界面为 true：角色选择和比赛。其他界面
 * （包括暂停菜单）中每位玩家的按键都算玩家 1 的，因为菜单只读取玩家 1 的按键。
 */
export function seatScreen(rt: Runtime): boolean {
  return inPlay(rt) || characterSelect(rt);
}

/** 供工具输出的一行游戏状态说明。 */
export function describe(rt: Runtime): string {
  const backdrop = rt.stage.sprite.costumes[rt.stage.currentCostume]?.name;
  const shown = [...new Set(rt.drawList.filter((t) => t.visible).map((t) => t.name))];
  const where = inMatch(rt) ? (inPlay(rt) ? 'match' : 'paused') : characterSelect(rt) ? 'select' : 'menu';
  return `backdrop=${backdrop} ${where} shown=[${shown.join(',')}]`;
}
