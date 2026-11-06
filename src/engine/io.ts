// 模拟所看到的键盘、鼠标和文本作答状态。
import type { Value } from './cast.ts';

const KEY_NAMES = ['space', 'left arrow', 'up arrow', 'right arrow', 'down arrow', 'enter'];

/** 将浏览器 `KeyboardEvent.key` 转换为游戏使用的键名，游戏忽略的键返回 ''。 */
export function browserKeyToName(key: string): string {
  switch (key) {
    case ' ': return 'space';
    case 'ArrowLeft': case 'Left': return 'left arrow';
    case 'ArrowUp': case 'Up': return 'up arrow';
    case 'ArrowRight': case 'Right': return 'right arrow';
    case 'ArrowDown': case 'Down': return 'down arrow';
    case 'Enter': return 'enter';
  }
  if (key.length > 1) return '';
  return key.toUpperCase();
}

/** 将游戏代码中的按键参数规范化为键名。 */
export function keyArgToName(arg: Value): string {
  if (typeof arg === 'number') {
    if (arg >= 48 && arg <= 90) return String.fromCharCode(arg);
    switch (arg) {
      case 32: return 'space';
      case 37: return 'left arrow';
      case 38: return 'up arrow';
      case 39: return 'right arrow';
      case 40: return 'down arrow';
    }
  }
  let k = String(arg);
  if (KEY_NAMES.includes(k)) return k;
  if (k.length > 1) k = k[0];
  if (k === ' ') return 'space';
  return k.toUpperCase();
}

/** 一位玩家一帧的输入。 */
export interface PlayerInput {
  /** 本帧按住的键名。 */
  keys: string[];
  /** 舞台坐标中的鼠标位置（整数）和按钮状态，前提是此玩家驱动鼠标。 */
  mouse?: { x: number; y: number; down: boolean };
  /** 提交给已打开问题的文本。 */
  answer?: string;
  /** 自上一帧以来其他玩家设置的云变量值，按到达顺序以名称和值成对表示。 */
  cloud?: [string, string][];
  /** 测试在帧运行前设置的舞台变量，按名称索引。页面从不发送这些。 */
  vars?: [string, Value][];
  /** 测试在帧运行前替换的列表，包含目标名称、列表 id 和项目。页面从不发送这些。 */
  lists?: [string, string, Value[]][];
}

export class IoState {
  /** 每个玩家槽位按住的键。单机游玩时槽位 0 是本地键盘。 */
  keys: Set<string>[] = [new Set(), new Set(), new Set(), new Set()];
  /** 为 true 时，控制表各玩家行只能看到自己槽位的按键。 */
  netMode = false;
  mouseX = 0;
  mouseY = 0;
  mouseDown = false;

  anyKey(): boolean {
    for (const s of this.keys) if (s.size > 0) return true;
    return false;
  }

  keyPressed(arg: Value): boolean {
    if (arg === 'any') return this.anyKey();
    const name = keyArgToName(arg);
    for (const s of this.keys) if (s.has(name)) return true;
    return false;
  }

  /** 控制表中一行的按键测试（第 0 行共享，第 1 至 4 行是玩家）。 */
  keyPressedForRow(row: number, arg: Value): boolean {
    if (!this.netMode || row < 1 || row > 4) return this.keyPressed(arg);
    if (arg === 'any') return this.keys[row - 1].size > 0;
    return this.keys[row - 1].has(keyArgToName(arg));
  }
}
