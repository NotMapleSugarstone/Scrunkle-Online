// 页面在两次访问之间保留的内容，使玩家进度在刷新后仍在，以及存档代码如何变成文件。
import type { Runtime } from '../engine/runtime.ts';
import { toStr, type Value } from '../engine/cast.ts';
import { GAME_TITLE } from './page.ts';

/**
 * 保存玩家进度和设置的舞台列表。`!SAVE_DATA` 是完整存档，游戏的存档代码保存它。
 * 设置和按键列表也会保留，因为设置菜单会修改它们，但不会复制到 `!SAVE_DATA`。
 */
export const SAVE_LISTS = ['!SAVE_DATA', '!Global_GameSettings', '!G_Keybinds'];

/** 要保留的舞台变量。此游戏只用列表保存进度。 */
export const SAVE_VARS: string[] = [];

/** 游戏只请求存档代码和美术代码，因此问题框也接受文本文件作为答案。 */
export const CODE_ANSWERS = true;

/**
 * 页面从不绘制其监视器的舞台列表。存档界面显示原始存档和可复制代码，
 * “保存”则改为将代码下载为文件。
 */
export const HIDDEN_LISTS = ['!SAVE_DATA', 'Save Code'];

function stageList(rt: Runtime, name: string): { items: Value[]; visible: boolean } | null {
  const prop = rt.stage.sprite.def.listNames?.[name];
  if (prop === undefined) return null;
  return { items: rt.stage.l[prop] ?? [], visible: rt.monitorVisible[prop] ?? false };
}

/**
 * 游戏显示给玩家复制的代码及其文件名，或 null。存档界面的“保存”和美术模式中保存作品
 * 都会将“Copy This Code:”和代码放入显示的 `Save Code` 列表。存档界面还会显示 `!SAVE_DATA`。
 */
export function shownCode(rt: Runtime): { code: string; name: string } | null {
  const list = stageList(rt, 'Save Code');
  if (!list?.visible || list.items.length !== 2 || toStr(list.items[0]) !== 'Copy This Code:') return null;
  const code = toStr(list.items[1]);
  if (!code) return null;
  const save = stageList(rt, '!SAVE_DATA')?.visible ?? false;
  return { code, name: `${GAME_TITLE} ${save ? 'save' : 'art'}.txt` };
}
