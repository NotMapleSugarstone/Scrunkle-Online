// 舞台顶部的一行消息，例如“回放已保存”。

export class Toast {
  private el: HTMLDivElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(stage: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'toast';
    this.el.hidden = true;
    stage.append(this.el);
  }

  /** 显示消息 `ms` 毫秒；`ms` 为 0 时显示到下一条消息。 */
  show(text: string, ms = 2500): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.el.textContent !== text) this.el.textContent = text;
    this.el.hidden = false;
    if (ms > 0) this.timer = setTimeout(() => this.hide(), ms);
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.el.hidden = true;
  }
}
