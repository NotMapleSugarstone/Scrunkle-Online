// 比赛结束后的询问：是否在此浏览器中保存回放。
// 游戏继续在下方运行，按钮永远不会获得键盘焦点。
import { clock, type FinishedReplay } from './replay.ts';
import { saveReplay } from './replay-store.ts';
import { currentFormat, currentText } from './net-text.ts';
import type { Toast } from './toast.ts';

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.tabIndex = -1;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

export class ReplayOffer {
  private el: HTMLDivElement;
  private text: HTMLParagraphElement;
  private pending: FinishedReplay | null = null;

  constructor(
    stage: HTMLElement,
    private toast: Toast,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'replay-offer';
    this.el.hidden = true;
    this.text = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'replay-offer-actions';
    actions.append(
      button(currentText('saveReplay'), 'primary', () => void this.save()),
      button(currentText('noThanks'), '', () => this.clear()),
    );
    this.el.append(this.text, actions);
    stage.append(this.el);
  }

  offer(r: FinishedReplay): void {
    this.pending = r;
    this.text.textContent = currentFormat('saveReplayQuestion', { fighters: r.meta.fighters.join(' vs '), time: clock(r.meta.frames) });
    this.el.hidden = false;
  }

  /** 关闭询问，例如下一场比赛开始时。 */
  clear(): void {
    this.pending = null;
    this.el.hidden = true;
  }

  private async save(): Promise<void> {
    const r = this.pending;
    this.clear();
    if (!r) return;
    try {
      await saveReplay(r);
      this.toast.show(currentText('replaySaved'), 4000);
    } catch (e) {
      this.toast.show(currentFormat('replaySaveFailed', { error: e instanceof Error ? e.message : String(e) }), 6000);
    }
  }
}
