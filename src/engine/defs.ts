// 运行时与生成游戏代码共享的静态定义。
import type { Value } from './cast.ts';
import type { Target } from './target.ts';
import type { Thread, Frame } from './thread.ts';
import target from '../game/runtime.json';

/**
 * 若项目面向会编译脚本为 JavaScript 的运行时则为 true，面向解释器则为 false。其编译代码在若干
 * 规则上与解释器不同，引擎与转译器都会遵循这些规则（src/game/runtime.json，由
 * tools/extract.mjs 写入）。
 */
export const COMPILED = target.runtime === 'turbowarp';

/** 项目原本使用的舞台尺寸，由原项目的设置决定。 */
export const STAGE_W: number = target.stageWidth;
export const STAGE_H: number = target.stageHeight;
/** 舞台尺寸的一半：舞台上 x 与 y 的最大值。 */
export const STAGE_X = STAGE_W / 2;
export const STAGE_Y = STAGE_H / 2;

/** 一张造型图像的光栅化与放置数据，由原渲染器测得。 */
export interface SkinDef {
  /** 以舞台单位表示的逻辑宽高。 */
  w: number;
  h: number;
  /** 皮肤空间中的旋转中心。 */
  rcx: number;
  rcy: number;
  kind: 'svg' | 'bitmap';
  file: string;
  /** 位图每个舞台单位对应的像素数。 */
  res: number;
  /** 矢量光栅化器可使用的最大 mip 缩放。 */
  maxScale: number;
}

export interface CostumeDef {
  name: string;
  skin: number;
}

export interface SoundDef {
  name: string;
  file: string;
  rate: number;
  sampleCount: number;
}

export type HatKind = 'flag' | 'broadcast' | 'clone' | 'key' | 'click' | 'timer';

/** 可恢复单元返回给线程步进器的控制码。 */
export enum Ctl {
  /** 挂起到下一 tick；线程保持活动。 */
  Yield = 0,
  /** 挂起，直到类似 Promise 的操作在帧间完成。 */
  Promise = 1,
  /** 已压入被调用帧；立即运行它。 */
  Call = 2,
  /** 单元正常结束；恢复调用者。 */
  Return = 3,
  /** 在过程内部执行 `stop this script`；在调用者的停止标签处恢复调用者。 */
  StopReturn = 4,
  /** 脚本结束；线程完成。 */
  End = 5,
  /** 挂起到下一帧；线程不再计为活动（原项目的 yield-tick）。 */
  YieldTick = 6,
}

/** 可恢复的代码单元（脚本体或过程体），会编译为状态机。 */
export type UnitFn = (th: Thread, f: Frame) => Ctl;

export interface ScriptDef {
  hat: HatKind;
  /** 广播帽使用的大写广播名，按键帽使用的键名，或计时器帽测得的数值。 */
  msg?: string;
  /** 计时器帽的阈值，按原项目中的输入方式保存。 */
  value?: string;
  /** 帽子的积木 id，用于一致性报告。 */
  top: string;
  /** 永远不会挂起的脚本会作为普通函数直接运行到结束。 */
  plain?: (t: Target) => void;
  /** 可能挂起的脚本会启动这个可恢复单元。 */
  unit?: number;
}

export interface SpriteDef {
  name: string;
  isStage: boolean;
  layerOrder: number;
  x: number;
  y: number;
  direction: number;
  size: number;
  currentCostume: number;
  visible: boolean;
  rotationStyle: string;
  draggable: boolean;
  volume: number;
  /** 属性名到初始值。 */
  vars: Record<string, Value>;
  lists: Record<string, Value[]>;
  /** 原始变量名到属性名，用于 `(variable) of (sprite)`。 */
  varNames?: Record<string, string>;
  /** 属性名到原始变量 id，用于一致性报告。 */
  varIds: Record<string, string>;
  listIds: Record<string, string>;
  /** 原始列表名到属性名，供按名称读取列表的 TypeScript 代码使用。 */
  listNames?: Record<string, string>;
  /** 没有任何积木写入的列表属性名。克隆体与快照共享它们，而不是复制。 */
  fixedLists?: string[];
  costumes: CostumeDef[];
  sounds: SoundDef[];
  scripts: ScriptDef[];
}

export interface Monitors {
  /** 舞台上的列表属性名，对应可见性与位置。 */
  lists: { prop: string; label: string; x: number; y: number; width: number; height: number; visible: boolean }[];
  /** 舞台变量属性名到标签、显示模式（'default'、'large' 或 'slider'）、位置与可见性。 */
  vars: { prop: string; label: string; mode: string; x: number; y: number; visible: boolean }[];
}
