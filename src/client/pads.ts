// 触屏控制和游戏控制器，按本地每位玩家的游戏按钮读取。
// 槽位 0 是此设备上的第一位玩家：触屏控制和第一个使用的控制器。
// 后续控制器在单机游玩时按首次使用顺序成为下一位玩家，
// 因此只在 Android 上伪装成控制器的设备（如手机传感器）不会占用槽位。
import { ACTIONS, PAD_BUTTONS } from './controls.ts';

const act = (name: string): number => ACTIONS.indexOf(name);
export const UP = act('Up');
export const DOWN = act('Down');
export const LEFT = act('Left');
export const RIGHT = act('Right');

/** 摇杆倾斜到多大才算方向。 */
const STICK_DEADZONE = 0.4;

/** 标准布局按钮对应的游戏按钮，方向键像左摇杆一样移动。 */
const BUTTONS: [number, number][] = [
  ...PAD_BUTTONS.map(([b, name]): [number, number] => [b, act(name)]).filter(([, a]) => a >= 0),
  [12, UP],
  [13, DOWN],
  [14, LEFT],
  [15, RIGHT],
];

/** Android 将其列为控制器但实际不是的设备，例如指纹传感器和侧键。 */
const NOT_CONTROLLERS = /uinput|fpc|goodix|fingerprint|gpio-keys/i;

/** 设备是否像控制器：标准布局，或按钮数量足够且有摇杆/方向键。 */
function isController(gp: Gamepad): boolean {
  if (NOT_CONTROLLERS.test(gp.id)) return false;
  return gp.mapping === 'standard' || (gp.buttons.length >= 4 && gp.axes.length >= 2);
}

/** 去掉某些浏览器附加的厂商和产品编号后的控制器名称。 */
const controllerName = (gp: Gamepad) => gp.id.replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor: \w+ Product: \w+\)/i, '').trim() || 'Controller';

/** 浏览器列为控制器的设备，以及游戏是否使用每个设备。 */
export function listControllers(): { name: string; used: boolean }[] {
  return [...(navigator.getGamepads?.() ?? [])].filter((gp): gp is Gamepad => !!gp && gp.connected).map((gp) => ({ name: controllerName(gp), used: isController(gp) }));
}

export class Pads {
  /** 触屏控制中按住的按钮。 */
  private held = new Set<number>();
  /** 自上次采样以来按下的按钮，使短于一帧的轻点也能计数。 */
  private tapped = new Set<number>();
  /** 按首次使用顺序排列的控制器索引，也就是槽位顺序。 */
  private order: number[] = [];
  /** 控制器首次使用时调用。 */
  onController: () => void = () => {};

  press(action: number): void {
    this.held.add(action);
    this.tapped.add(action);
  }

  release(action: number): void {
    this.held.delete(action);
  }

  releaseAll(): void {
    this.held.clear();
  }

  /** 每帧各本地玩家按槽位排列的按钮。 */
  sample(): number[][] {
    const slots: Set<number>[] = [new Set([...this.held, ...this.tapped])];
    this.tapped.clear();
    const pads = new Map<number, Set<number>>();
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp || !gp.connected || !isController(gp)) continue;
      const acts = new Set<number>();
      readController(gp, acts);
      pads.set(gp.index, acts);
      if (acts.size && !this.order.includes(gp.index)) {
        this.order.push(gp.index);
        this.onController();
      }
    }
    this.order = this.order.filter((i) => pads.has(i));
    this.order.forEach((index, n) => {
      const slot = (slots[n] ??= new Set());
      for (const a of pads.get(index)!) slot.add(a);
    });
    return slots.map((s) => [...s]);
  }

  /** 放回所在帧未运行的按钮，使下次采样仍包含它们。 */
  retap(actions: number[]): void {
    for (const a of actions) this.tapped.add(a);
  }
}

function direction(x: number, y: number, out: Set<number>): void {
  if (x > STICK_DEADZONE) out.add(RIGHT);
  if (x < -STICK_DEADZONE) out.add(LEFT);
  if (y < -STICK_DEADZONE) out.add(UP);
  if (y > STICK_DEADZONE) out.add(DOWN);
}

/** 帽子开关方向，从上开始顺时针，对应轴值 -1、-5/7、...、1。约 1.29 表示未按下。 */
const HAT: [number, number][] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function readController(gp: Gamepad, out: Set<number>): void {
  for (const [b, a] of BUTTONS) if (gp.buttons[b]?.pressed) out.add(a);
  direction(gp.axes[0] ?? 0, gp.axes[1] ?? 0, out);
  if (gp.mapping === 'standard') return;
  // 没有标准布局时，桌面浏览器会把方向键报告为一个帽轴（轴 9），其值在
  // 八个 -1 到 1 的档位间变化。位于档位之间的值（例如静止的 0）不是方向。
  const hat = gp.axes[9];
  if (hat === undefined) return;
  const step = ((hat + 1) * 7) / 2;
  const k = Math.round(step);
  if (k >= 0 && k <= 7 && Math.abs(step - k) < 0.15) direction(HAT[k][0], HAT[k][1], out);
}

/** 为按键为 `row`（来自 `seatKeys`）的座位按下 `actions` 的键名。 */
export function actionKeys(actions: number[], row: string[]): string[] {
  const out: string[] = [];
  for (const a of actions) if (row[a]) out.push(row[a]);
  return out;
}
