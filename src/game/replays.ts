// 回放记录的比赛由哪些帧组成，以及回放界面如何称呼它。
import { toStr, type Value } from '../engine/cast.ts';
import type { Runtime } from '../engine/runtime.ts';

/** 一帧后游戏的状态，从实时运行时或已确认在线帧的快照读取。 */
export interface MatchView {
  /** 按项目中的名称访问舞台变量。 */
  v(name: string): Value;
  /** 按项目中的名称访问舞台列表。 */
  l(name: string): Value[];
  /** 由此广播（大写）启动的舞台脚本是否正在运行。 */
  running(message: string): boolean;
}

export interface MatchInfo {
  mode: string;
  fighters: string[];
  stage: string;
}

/** 斗士的名称，Text 角色将它们保存在一个永不改变的列表中。 */
function fighterNames(rt: Runtime): Value[] {
  const text = rt.getSpriteTargetByName('Text');
  const prop = text?.sprite.def.listNames?.['!!!names'];
  return (text && prop !== undefined && text.l[prop]) || [];
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** `s` 中正在进行的比赛；没有回放会保留的比赛时为 null。训练和教程不计入。 */
export function matchInfo(rt: Runtime, s: MatchView): MatchInfo | null {
  if (!s.running('GAMELOOP')) return null;
  if (toStr(s.v('training?')) === '1' || toStr(s.v('tutorial?')) === '1') return null;
  const story = toStr(s.v('#storybattle?'));
  const mode =
    toStr(s.v('!RosterFight')) === '1' ? 'Roster fight'
    : story === '1' ? 'Story'
    : story === '2' ? 'Tower'
    : story === '3' || story === '4' ? 'Classic'
    : toStr(s.v('AIon?')) === '1' ? 'Against the CPU'
    : 'Versus';
  const names = fighterNames(rt);
  const chars = s.l('!P_Char').slice(0, 2);
  const fighters = chars.map((c) => titleCase(toStr(names[Number(c) - 1] ?? `Fighter ${toStr(c)}`)));
  // 舞台列表为每个舞台保存名称和一行说明。
  const stage = titleCase(toStr(s.l('#D_StageInfo')[(Number(s.v('stage')) - 1) * 2] ?? ''));
  return { mode, fighters, stage };
}
