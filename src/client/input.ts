// 本地键盘和鼠标状态，使用游戏中的键名与舞台坐标。
import { browserKeyToName } from '../engine/io.ts';
import { STAGE_H, STAGE_W, STAGE_X, STAGE_Y } from '../engine/defs.ts';

export class LocalInput {
  keys = new Set<string>();
  /** 自上次采样以来按下的键，使短于一帧的轻点也能到达游戏。 */
  private tapped = new Set<string>();
  mouse = { x: 0, y: 0, down: false };
  mouseDirty = false;
  /** 为 false 时忽略按键事件（例如文本框获得焦点时）。 */
  enabled = true;
  /** Escape 也会按下的键，例如暂停菜单的键，或 null。 */
  escapeAs: string | null = null;

  constructor(private stageEl: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey) return;
      const name = e.key === 'Escape' && this.escapeAs ? this.escapeAs : browserKeyToName(e.key);
      if (!name) return;
      this.keys.add(name);
      this.tapped.add(name);
      if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      const name = e.key === 'Escape' && this.escapeAs ? this.escapeAs : browserKeyToName(e.key);
      if (name) this.keys.delete(name);
      // 带 Shift 的字符可能在释放时使用不同键名，因此也按物理键匹配。
      if (e.code.startsWith('Key')) this.keys.delete(e.code.slice(3));
      if (e.code.startsWith('Digit')) this.keys.delete(e.code.slice(5));
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.tapped.clear();
    });
    const move = (e: PointerEvent) => {
      const r = this.stageEl.getBoundingClientRect();
      const x = Math.round(Math.max(-STAGE_X, Math.min(STAGE_X, STAGE_W * ((e.clientX - r.left) / r.width - 0.5))));
      const y = Math.round(Math.max(-STAGE_Y, Math.min(STAGE_Y, -STAGE_H * ((e.clientY - r.top) / r.height - 0.5))));
      if (x !== this.mouse.x || y !== this.mouse.y) {
        this.mouse.x = x;
        this.mouse.y = y;
        this.mouseDirty = true;
      }
    };
    window.addEventListener('pointermove', move);
    this.stageEl.addEventListener('pointerdown', (e) => {
      move(e);
      this.mouse.down = true;
      this.clicked = true;
      this.mouseDirty = true;
    });
    window.addEventListener('pointerup', (e) => {
      move(e);
      if (this.mouse.down) {
        this.mouse.down = false;
        this.mouseDirty = true;
      }
    });
  }

  /** 一帧游戏使用的按键：当前按住的键加上上次调用后轻点的键。 */
  sampleKeys(): string[] {
    for (const k of this.keys) this.tapped.add(k);
    const out = [...this.tapped];
    this.tapped.clear();
    return out;
  }

  /** 模拟按下某键一帧，如同暂停菜单按钮。 */
  tap(key: string): void {
    this.tapped.add(key);
  }

  /** 返回所在帧未运行的已采样按键，使下次采样仍包含它们。 */
  retap(keys: string[]): void {
    for (const k of keys) this.tapped.add(k);
  }

  /** 由按下事件设置，使下次采样前释放的点击仍能到达游戏。 */
  private clicked = false;

  /** 一帧游戏使用的指针；自上次调用后未变化时为 undefined。 */
  sampleMouse(): { x: number; y: number; down: boolean } | undefined {
    if (!this.mouseDirty) return undefined;
    const m = { ...this.mouse, down: this.mouse.down || this.clicked };
    // 在一帧内释放的点击在该帧视为按下，下一帧视为释放。
    this.mouseDirty = this.clicked && !this.mouse.down;
    this.clicked = false;
    return m;
  }

  /** 返回所在帧未运行的已采样指针，使下次采样重复它。 */
  remouse(m: { down: boolean }): void {
    if (m.down && !this.mouse.down) this.clicked = true;
    this.mouseDirty = true;
  }
}
