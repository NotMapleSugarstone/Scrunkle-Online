// 各角色声音播放的确定性模型。它决定“播放到结束”何时完成；
// 音频输出层只跟随它的事件。
import { pow2 } from './dmath.ts';
import type { Target } from './target.ts';
import type { Thread } from './thread.ts';


export interface SoundEvent {
  kind: 'play' | 'stop' | 'fx';
  sprite: number;
  sound: number;
  /** 事件在模拟中的时间，单位毫秒。 */
  at: number;
  /** 开始时的播放速率，'fx' 时为新的速率。 */
  rate: number;
  /** 目标音量 0..100。 */
  volume: number;
  /** 声像 -100..100。 */
  pan?: number;
  /** 此播放器每次启动时递增，使输出层能匹配重新开始。 */
  serial: number;
}

/** 角色每个声音一个播放器，由此角色的所有克隆共享。 */
export interface PlayerState {
  isPlaying: boolean;
  startingUntil: number;
  /** 到 `lastT` 为止消耗的缓冲时间，单位毫秒。 */
  pos: number;
  lastT: number;
  rate: number;
  /** 等待此播放器下次停止的线程。 */
  waiters: Thread[];
  /** 最后播放此声音的目标。 */
  owner: Target | null;
  /** 最后应用到此声音效果链的音高效果值。 */
  pitch: number;
  serial: number;
  /** 此声音在角色声音中首次播放的排名，或 -1。停止所有声音时按此顺序执行。 */
  order: number;
}

export function newPlayer(): PlayerState {
  return { isPlaying: false, startingUntil: 0, pos: 0, lastT: 0, rate: 1, waiters: [], owner: null, pitch: 0, serial: 0, order: -1 };
}

export function pitchRatio(pitch: number): number {
  return pow2(pitch / 10 / 12);
}
