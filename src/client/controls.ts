// 每位玩家自己的按键保存在此浏览器中，游戏按座位读取按键。游戏从 `!G_Keybinds` 列表读取按键：
// 第 1 至 8 项是玩家 1 的按钮，第 9 至 16 项是玩家 2 的，第 17、18 项
// 用于在菜单中换歌。在线时，每位玩家的按键会在发送前转换为各自座位的按键，
// 因此两位玩家可以使用相同按键。
import { keyArgToName } from '../engine/io.ts';
import type { Value } from '../engine/cast.ts';
import type { Runtime } from '../engine/runtime.ts';
import { STORAGE_PREFIX } from '../game/page.ts';

/** 游戏按钮，按每位玩家在 `!G_Keybinds` 中的顺序排列。 */
export const ACTIONS = ['Up', 'Down', 'Left', 'Right', 'Attack', 'Special', 'Shield', 'Pause'];
/** 各座位初始按键，使用引擎中的名称。 */
export const DEFAULT_KEYS: string[][] = [
  ['up arrow', 'down arrow', 'left arrow', 'right arrow', 'N', 'M', 'B', 'V'],
  ['W', 'S', 'A', 'D', 'F', 'G', 'H', 'R'],
];

/**
 * 标准控制器布局的按钮及其对应动作。A 攻击并在菜单中选择，B 使用必杀并返回，
 * X 和 Y 跳跃，肩键和扳机防御，Back 和 Start 暂停。方向键和左摇杆负责移动。
 */
export const PAD_BUTTONS: [number, string][] = [
  [0, 'Attack'],
  [1, 'Special'],
  [2, 'Up'],
  [3, 'Up'],
  [4, 'Shield'],
  [5, 'Shield'],
  [6, 'Shield'],
  [7, 'Shield'],
  [8, 'Pause'],
  [9, 'Pause'],
];

/** 触屏按钮按位置排列：面键的上、左、右、下，然后是小按钮。 */
export const DEFAULT_TOUCH_BUTTONS = ['Up', 'Shield', 'Special', 'Attack', 'Pause'];

const KEYBINDS = '!G_Keybinds';
const BUTTONS = ACTIONS.length;
const STORE_KEY = `${STORAGE_PREFIX}.controls`;
const TOUCH_KEY = `${STORAGE_PREFIX}.touchButtons`;

/** 游戏按键列表，游戏内控制菜单会编辑它。 */
function keybinds(rt: Runtime): Value[] | undefined {
  const prop = rt.stage.sprite.def.listNames?.[KEYBINDS];
  return prop === undefined ? undefined : rt.stage.l[prop];
}

const keyName = (v: Value | undefined): string => (v === '' || v === undefined ? '' : keyArgToName(v));

/** 游戏当前为某座位读取的按键，按 `ACTIONS` 顺序。 */
export function seatKeys(rt: Runtime, seat: number): string[] {
  const list = keybinds(rt);
  if (!list) return DEFAULT_KEYS[seat] ?? [];
  const keys: string[] = [];
  for (let b = 0; b < BUTTONS; b++) keys.push(keyName(list[seat * BUTTONS + b]));
  return keys;
}

/**
 * 将玩家自己控制中的每个按键替换为该座位同一按钮的按键。
 * 其他按键原样传递，但座位使用的键只有在 `own` 中绑定时才生效。
 */
export function translateKeys(pressed: string[], own: string[], seat: string[]): string[] {
  const out = new Set<string>();
  own.forEach((k, i) => {
    if (k && seat[i] && pressed.includes(k)) out.add(seat[i]);
  });
  for (const k of pressed) if (!own.includes(k) && !seat.includes(k)) out.add(k);
  return [...out];
}

/** 在单机游玩时把此玩家自己的按键设为玩家 1 的按键，游戏内控制菜单仍可修改。 */
export function applyToPlayerOne(rt: Runtime, keys: string[]): void {
  const list = keybinds(rt);
  if (!list) return;
  // 游戏以小写保存字母，与其控制菜单一致。
  for (let b = 0; b < BUTTONS; b++) list[b] = keys[b].length === 1 ? keys[b].toLowerCase() : keys[b];
}

/** 玩家在“控制”中设置的按键，从未设置时为 null。 */
export function savedControls(): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (Array.isArray(v) && v.length === BUTTONS && v.every((k) => typeof k === 'string')) return v;
  } catch {
    // 存储可能被阻止，或保存的是旧格式。
  }
  return null;
}

export function loadControls(): string[] {
  return savedControls() ?? [...DEFAULT_KEYS[0]];
}

export function saveControls(keys: string[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(keys));
  } catch {
    // 存储可能被阻止。
  }
}

/** 每个触屏按钮的功能，按玩家顺序对应 `DEFAULT_TOUCH_BUTTONS`。 */
export function loadTouchButtons(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TOUCH_KEY) ?? 'null');
    if (Array.isArray(v) && v.length === DEFAULT_TOUCH_BUTTONS.length && DEFAULT_TOUCH_BUTTONS.every((a) => v.includes(a))) return v;
  } catch {
    // 存储可能被阻止。
  }
  return [...DEFAULT_TOUCH_BUTTONS];
}

export function saveTouchButtons(buttons: string[]): void {
  try {
    localStorage.setItem(TOUCH_KEY, JSON.stringify(buttons));
  } catch {
    // 存储可能被阻止。
  }
}
