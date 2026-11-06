// 玩家的显示模式与帽子选项保存在浏览器中。它们只改变画面，因此在线玩家可以不同。
import type { DisplayMode } from '../render/webgl.ts';
import { STORAGE_PREFIX } from '../game/page.ts';

const DISPLAY_KEY = `${STORAGE_PREFIX}.display`;
const HATS_KEY = `${STORAGE_PREFIX}.wearHats`;

/** “实际戴上帽子”是否开启。 */
export function loadWearHats(): boolean {
  try {
    return localStorage.getItem(HATS_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveWearHats(on: boolean): void {
  try {
    localStorage.setItem(HATS_KEY, on ? '1' : '0');
  } catch {
    // 存储可能被阻止。
  }
}

export const DISPLAY_MODES: DisplayMode[] = ['smooth', 'flash', 'handheld'];

export const DISPLAY_NAMES: Record<DisplayMode, string> = {
  smooth: 'Smooth',
  flash: 'Old flash game',
  handheld: 'Handheld',
};

export function loadDisplay(): DisplayMode {
  try {
    const v = localStorage.getItem(DISPLAY_KEY);
    if (DISPLAY_MODES.includes(v as DisplayMode)) return v as DisplayMode;
  } catch {
    // 存储可能被阻止。
  }
  return 'smooth';
}

export function saveDisplay(mode: DisplayMode): void {
  try {
    localStorage.setItem(DISPLAY_KEY, mode);
  } catch {
    // 存储可能被阻止。
  }
}

export function nextDisplay(mode: DisplayMode): DisplayMode {
  return DISPLAY_MODES[(DISPLAY_MODES.indexOf(mode) + 1) % DISPLAY_MODES.length];
}
