// 触屏上的屏幕控制：用于移动的摇杆和控制器风格的按钮，
// 游戏运行时在触屏设备上显示；横屏位于舞台旁，竖屏位于舞台下方，
// 使用控制器时隐藏。玩家可在大厅的控制菜单中设置每个按钮的功能。
// 触屏设备显示期间，游戏运行时控制显示在舞台旁。
import { ACTIONS, DEFAULT_TOUCH_BUTTONS, loadTouchButtons } from './controls.ts';
import { DOWN, LEFT, RIGHT, UP, type Pads } from './pads.ts';
import { STORAGE_PREFIX } from '../game/page.ts';
import { actionLabel } from './net-text.ts';

/** 摇杆半径中拇指必须移动的比例，超过后才算方向。 */
const STICK_DEADZONE = 0.3;
/** 每个轴的方向阈值：cos 67.5 度，使八个方向均分。 */
const AXIS = 0.383;
/** 菜单中拇指必须移动得更远，因为每次释放方向都会移动选择。 */
const MENU_DEADZONE = 0.5;
/** 菜单中保持当前轴，直到另一轴领先这么多，避免 45 度附近的拇指在两轴间跳动。 */
const MENU_STICKINESS = 0.25;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 指针按下期间将其事件保留在 `target` 上。已经抬起的指针无法捕获，但也无妨。 */
function capture(target: Element, id: number): void {
  try {
    target.setPointerCapture(id);
  } catch {
    // 指针已不再活动。
  }
}

const CHOICE_KEY = `${STORAGE_PREFIX}.touch`;

function loadChoice(): boolean | null {
  try {
    const v = localStorage.getItem(CHOICE_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

export class TouchControls {
  private root: HTMLDivElement;
  /** 检测结果：触屏是主指针、发生过触摸，或控制器接管。 */
  private touchDevice = matchMedia('(pointer: coarse)').matches;
  /** 玩家在大厅中的选择；一旦设置就优先于检测结果。 */
  private choice = loadChoice();
  private playing = false;
  private dirs = new Set<number>();
  /** 按位置顺序排列的按钮及其按下的动作。 */
  private slots: { b: HTMLButtonElement; action: number }[] = [];
  /** 控制开启或关闭时调用，供大厅开关使用。 */
  onChange: (on: boolean) => void = () => {};
  /** 游戏显示菜单时为 true，此时摇杆一次只给出一个方向。 */
  menuMode: () => boolean = () => false;

  constructor(parent: HTMLElement, private pads: Pads, private relayout: () => void) {
    this.root = el('div', 'touch');
    this.root.append(this.stick(), this.face(), this.small());
    this.setButtons(loadTouchButtons());
    parent.append(this.root);
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.touchDevice) {
        this.touchDevice = true;
        this.update();
      }
    });
    // 真正控制器的首次输入会隐藏触屏控制。只声称自己是控制器的设备不会发送输入。
    this.pads.onController = () => {
      this.touchDevice = false;
      this.update();
    };
    window.addEventListener('blur', () => this.pads.releaseAll());
    this.update();
  }

  /** 游戏期间是否显示控制。 */
  get enabled(): boolean {
    return this.choice ?? this.touchDevice;
  }

  /** 控制显示时为 true，页面会为其留出空间。 */
  get active(): boolean {
    return this.enabled && this.playing;
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    this.update();
  }

  /** 记录玩家选择，之后优先于检测结果。 */
  setChoice(on: boolean): void {
    this.choice = on;
    try {
      localStorage.setItem(CHOICE_KEY, on ? '1' : '0');
    } catch {
      // 存储可能被阻止。
    }
    this.update();
  }

  private update(): void {
    this.onChange(this.enabled);
    document.documentElement.classList.toggle('touch-on', this.active);
    if (!this.active) {
      this.pads.releaseAll();
      this.setDirs(new Set());
    }
    this.relayout();
  }

  private setDirs(next: Set<number>): void {
    for (const a of this.dirs) if (!next.has(a)) this.pads.release(a);
    for (const a of next) if (!this.dirs.has(a)) this.pads.press(a);
    this.dirs = next;
  }

  /** 浮动摇杆：底座在拇指落点居中，旋钮跟随拇指。 */
  private stick(): HTMLElement {
    const zone = el('div', 'touch-stick');
    const base = el('div', 'touch-stick-base');
    const knob = el('div', 'touch-stick-knob');
    base.append(knob);
    zone.append(base);
    let id = -1;
    let cx = 0;
    let cy = 0;
    const move = (e: PointerEvent) => {
      const r = base.offsetWidth / 2;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > r) {
        dx = (dx / dist) * r;
        dy = (dy / dist) * r;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const next = new Set<number>();
      const menu = this.menuMode();
      if (dist > r * (menu ? MENU_DEADZONE : STICK_DEADZONE)) {
        const ux = (e.clientX - cx) / dist;
        const uy = (e.clientY - cy) / dist;
        if (menu) {
          // 菜单只响应最后释放的方向，因此一次只给出一个方向。
          const ax = Math.abs(ux);
          const ay = Math.abs(uy);
          let across = ax >= ay;
          if (this.dirs.has(RIGHT) || this.dirs.has(LEFT)) across = ay < ax + MENU_STICKINESS;
          else if (this.dirs.has(UP) || this.dirs.has(DOWN)) across = ax >= ay + MENU_STICKINESS;
          next.add(across ? (ux > 0 ? RIGHT : LEFT) : uy > 0 ? DOWN : UP);
        } else {
          if (ux > AXIS) next.add(RIGHT);
          if (ux < -AXIS) next.add(LEFT);
          if (uy < -AXIS) next.add(UP);
          if (uy > AXIS) next.add(DOWN);
        }
      }
      this.setDirs(next);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      base.classList.remove('held');
      base.style.left = '';
      base.style.top = '';
      knob.style.transform = '';
      this.setDirs(new Set());
    };
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (id !== -1) return;
      id = e.pointerId;
      capture(zone, id);
      const z = zone.getBoundingClientRect();
      cx = e.clientX;
      cy = e.clientY;
      base.style.left = `${cx - z.left}px`;
      base.style.top = `${cy - z.top}px`;
      base.classList.add('held');
      move(e);
    });
    zone.addEventListener('pointermove', (e) => {
      e.stopPropagation();
      if (e.pointerId === id) move(e);
    });
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
    return zone;
  }

  /** 按 `DEFAULT_TOUCH_BUTTONS` 的位置顺序为按钮分配动作。 */
  setButtons(names: string[]): void {
    this.pads.releaseAll();
    this.slots.forEach((s, i) => {
      s.action = ACTIONS.indexOf(names[i]);
      s.b.textContent = actionLabel(names[i]);
      s.b.classList.remove('down');
    });
  }

  private button(cls: string): HTMLButtonElement {
    const b = el('button', `touch-btn ${cls}`);
    b.tabIndex = -1;
    const slot = { b, action: -1 };
    this.slots.push(slot);
    // 按下时记录的动作在释放时生效，即使期间按钮发生变化。
    let held = -1;
    const up = (e: PointerEvent) => {
      e.stopPropagation();
      if (held >= 0) this.pads.release(held);
      held = -1;
      b.classList.remove('down');
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      capture(b, e.pointerId);
      held = slot.action;
      this.pads.press(held);
      b.classList.add('down');
    });
    b.addEventListener('pointermove', (e) => e.stopPropagation());
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }

  /** 菱形排列的四个按钮，类似控制器的面键。 */
  private face(): HTMLElement {
    const face = el('div', 'touch-face');
    face.append(this.button('top'), this.button('left'), this.button('right'), this.button('bottom'));
    return face;
  }

  private small(): HTMLElement {
    const row = el('div', 'touch-small');
    for (let i = 4; i < DEFAULT_TOUCH_BUTTONS.length; i++) row.append(this.button('pill'));
    return row;
  }
}
