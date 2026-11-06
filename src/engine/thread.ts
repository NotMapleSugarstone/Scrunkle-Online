import type { Value } from './cast.ts';
import type { ScriptDef } from './defs.ts';
import type { Target } from './target.ts';

export const STATUS_RUNNING = 0;
export const STATUS_PROMISE_WAIT = 1;
export const STATUS_YIELD_TICK = 3;
export const STATUS_DONE = 4;

/** 可恢复调用栈的一层。纯数据，因此快照可深拷贝。 */
export interface Frame {
  /** 运行时单元表中的单元索引。 */
  u: number;
  /** 单元内的恢复标签。 */
  pc: number;
  /** 此单元顶层的当前 warp 标志。 */
  warp: boolean;
  /** 调用者层的 warp 标志，在此单元顶层的 Promise 续体之后继承。 */
  pw: boolean;
  /** 过程参数。 */
  a: Value[];
  /** 循环计数器、等待计时器及其他层级状态。 */
  l: (number | undefined)[];
  /** 被调用者通过 Promise 续体结束时恢复的标签。 */
  pcp: number;
  /** 被调用者通过 `stop this script` 返回时恢复的标签。 */
  pcs: number;
  /** `broadcast and wait` 启动的线程 id，等待期间保留。 */
  w?: number[];
  /** 此单元待处理调用周围的分支数；原版递归测试将其计为积木栈条目。 */
  cd?: number;
}

/** 标记 Promise 续体后落到单元末尾的帧标签。 */
export const PC_FALL_OFF = -2;

export class Thread {
  id: number;
  target: Target;
  script: ScriptDef;
  status = STATUS_RUNNING;
  isKilled = false;
  frames: Frame[] = [];
  /** 尚未运行的普通函数脚本。 */
  fresh = false;
  /** 脚本通过 Promise 续体落到末尾；将在下一步完成。 */
  nullPending = false;
  /** 被重启替换出线程列表；其任何行为都不再可观察。 */
  orphan = false;

  constructor(id: number, target: Target, script: ScriptDef) {
    this.id = id;
    this.target = target;
    this.script = script;
  }

  /** 线程没有更多工作时为 true，对应空积木栈。 */
  get stackEmpty(): boolean {
    return !this.fresh && !this.nullPending && this.frames.length === 0;
  }
}

export function newFrame(u: number, warp: boolean, pw: boolean, a: Value[]): Frame {
  return { u, pc: 0, warp, pw, a, l: [], pcp: PC_FALL_OFF, pcs: 0 };
}
