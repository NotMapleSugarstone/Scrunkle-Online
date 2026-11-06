// 玩家 1 按下暂停键时游戏会自行暂停，因此移植版不额外添加暂停菜单。
import type { PauseRule } from '../engine/runtime.ts';

export const pauseRule: PauseRule | undefined = undefined;
