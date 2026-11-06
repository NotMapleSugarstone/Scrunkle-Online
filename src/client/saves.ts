// 玩家的存档，保存在此浏览器中供下次访问使用：舞台列表和变量见 src/game/saves.ts。
// 离线游玩在第一帧前加载，并在游戏运行时写回。在线游戏在每台机器上都从
// 项目自身数据开始，因此所有人初始状态相同，也从不写入存档。
import type { Value } from '../engine/cast.ts';
import type { Runtime } from '../engine/runtime.ts';
import { SAVE_LISTS, SAVE_VARS, shownCode } from '../game/saves.ts';
import { STORAGE_PREFIX } from '../game/page.ts';
import { downloadFile, fileName } from './download.ts';

const KEY = `${STORAGE_PREFIX}.save`;
/** 运行中游戏存档的最长写入间隔。 */
const WRITE_EVERY_MS = 2000;

interface SaveFile {
  format: 1;
  lists: Record<string, Value[]>;
  vars: Record<string, Value>;
}

/** 列表和变量只保存字符串、数字和布尔值。 */
const isValue = (v: unknown): v is Value => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

function read(): SaveFile | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SaveFile | null;
    if (!v || v.format !== 1 || typeof v.lists !== 'object' || typeof v.vars !== 'object') return null;
    return v;
  } catch {
    return null;
  }
}

function capture(rt: Runtime): SaveFile {
  const def = rt.stage.sprite.def;
  const lists: Record<string, Value[]> = {};
  for (const name of SAVE_LISTS) {
    const prop = def.listNames?.[name];
    if (prop !== undefined) lists[name] = rt.stage.l[prop].slice();
  }
  const vars: Record<string, Value> = {};
  for (const name of SAVE_VARS) {
    const prop = def.varNames?.[name];
    if (prop !== undefined) vars[name] = rt.stage.v[prop];
  }
  return { format: 1, lists, vars };
}

/** 将浏览器存档载入尚未运行任何帧的运行时。类型错误的值会被跳过。 */
export function loadSave(rt: Runtime): void {
  const save = read();
  if (!save) return;
  const def = rt.stage.sprite.def;
  for (const name of SAVE_LISTS) {
    const prop = def.listNames?.[name];
    const items = save.lists[name];
    if (prop !== undefined && Array.isArray(items) && items.every(isValue)) rt.stage.l[prop].splice(0, Infinity, ...items);
  }
  for (const name of SAVE_VARS) {
    const prop = def.varNames?.[name];
    const v = save.vars[name];
    if (prop !== undefined && isValue(v)) rt.stage.v[prop] = v;
  }
}

/**
 * 将游戏显示的可复制代码（src/game/saves.ts 中的 `shownCode`）逐个下载为文本文件，
 * 并以文件名调用 `onSaved`。返回每个绘制帧后要运行的检查。
 */
export function codeFiles(onSaved: (name: string) => void): (rt: Runtime) => void {
  let last = '';
  return (rt) => {
    const shown = shownCode(rt);
    if (!shown || shown.code === last) return;
    last = shown.code;
    const name = fileName(shown.name);
    downloadFile(new Blob([shown.code], { type: 'text/plain' }), name);
    onSaved(name);
  };
}

/**
 * 持续写入运行中游戏的存档：变化时最多每两秒一次，以及页面隐藏或关闭时。
 * 返回再写入一次并停止的函数。
 */
export function keepSaving(game: () => Runtime): () => void {
  let last = JSON.stringify(capture(game()));
  const flush = () => {
    const text = JSON.stringify(capture(game()));
    if (text === last) return;
    last = text;
    try {
      localStorage.setItem(KEY, text);
    } catch {
      // 存储可能被阻止或已满。
    }
  };
  const timer = setInterval(flush, WRITE_EVERY_MS);
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  return () => {
    flush();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
  };
}
