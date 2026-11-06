// 游戏在画布上需要的 HTML 覆盖层：问题框、监视器和对话气泡。
import type { PauseRule, Runtime } from '../engine/runtime.ts';
import { STAGE_H, STAGE_W, STAGE_X, STAGE_Y, type Monitors } from '../engine/defs.ts';
import type { Value } from '../engine/cast.ts';
import { createElement, FileUp } from 'lucide';

/** 问题框接受为答案的最大文本文件大小。 */
const ANSWER_FILE_MAX = 1_000_000;

export class QuestionBox {
  private el: HTMLDivElement;
  private label: HTMLDivElement;
  private input: HTMLInputElement;
  private fileBtn: HTMLButtonElement;
  private shownFor: unknown = null;
  /** 自上一帧以来提交的文本，由下一次模拟输入取走。 */
  pendingAnswer: string | undefined;
  onFocusChange?: (focused: boolean) => void;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'question';
    this.label = document.createElement('div');
    this.label.className = 'question-text';
    const row = document.createElement('div');
    row.className = 'question-row';
    this.input = document.createElement('input');
    this.input.type = 'text';
    const ok = document.createElement('button');
    ok.textContent = '✔';
    ok.setAttribute('aria-label', 'Submit answer');
    // 文本文件内容作为答案，用于要求输入代码的问题。
    this.fileBtn = document.createElement('button');
    this.fileBtn.title = 'Open a .txt file';
    this.fileBtn.setAttribute('aria-label', 'Open a .txt file');
    this.fileBtn.append(createElement(FileUp, { width: '1em', height: '1em', 'aria-hidden': 'true' }));
    this.fileBtn.hidden = true;
    const pick = document.createElement('input');
    pick.type = 'file';
    pick.accept = '.txt,text/plain';
    pick.hidden = true;
    this.fileBtn.addEventListener('click', () => pick.click());
    pick.addEventListener('change', async () => {
      const file = pick.files?.[0];
      pick.value = '';
      if (!file || file.size > ANSWER_FILE_MAX) return;
      this.pendingAnswer = (await file.text()).replace(/^﻿/, '').trim();
      this.input.value = '';
    });
    row.append(this.input, this.fileBtn, ok, pick);
    this.el.append(this.label, row);
    this.el.hidden = true;
    parent.append(this.el);
    const submit = () => {
      this.pendingAnswer = this.input.value;
      this.input.value = '';
    };
    ok.addEventListener('click', submit);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('focus', () => this.onFocusChange?.(true));
    this.input.addEventListener('blur', () => this.onFocusChange?.(false));
  }

  /** 显示用文本文件内容作答的按钮。 */
  set allowFiles(on: boolean) {
    this.fileBtn.hidden = !on;
  }

  update(rt: Runtime): void {
    const q = rt.questions[0];
    if (!q) {
      if (!this.el.hidden) {
        this.el.hidden = true;
        this.shownFor = null;
        this.input.blur();
      }
      return;
    }
    if (this.shownFor !== q) {
      this.shownFor = q;
      this.label.textContent = q.text;
      this.el.hidden = false;
      this.input.focus();
    }
  }
}

export class ListMonitors {
  private els = new Map<string, { root: HTMLDivElement; body: HTMLDivElement; footer: HTMLDivElement; last: string }>();

  constructor(private parent: HTMLElement, private defs: Monitors) {}

  update(rt: Runtime): void {
    for (const d of this.defs.lists) {
      const visible = rt.monitorVisible[d.prop] ?? d.visible;
      let m = this.els.get(d.prop);
      if (!visible) {
        if (m) m.root.hidden = true;
        continue;
      }
      if (!m) {
        const root = document.createElement('div');
        root.className = 'list-monitor';
        root.style.left = `${(d.x / STAGE_W) * 100}%`;
        root.style.top = `${(d.y / STAGE_H) * 100}%`;
        root.style.width = `${(d.width / STAGE_W) * 100}%`;
        root.style.height = `${(d.height / STAGE_H) * 100}%`;
        const header = document.createElement('div');
        header.className = 'list-header';
        header.textContent = d.label;
        const body = document.createElement('div');
        body.className = 'list-body';
        const footer = document.createElement('div');
        footer.className = 'list-footer';
        root.append(header, body, footer);
        this.parent.append(root);
        m = { root, body, footer, last: '' };
        this.els.set(d.prop, m);
      }
      m.root.hidden = false;
      const items: Value[] = rt.stage.l[d.prop];
      const key = JSON.stringify(items);
      if (key !== m.last) {
        m.last = key;
        m.body.replaceChildren(
          ...items.map((v, i) => {
            const row = document.createElement('div');
            row.className = 'list-row';
            const idx = document.createElement('span');
            idx.className = 'list-index';
            idx.textContent = String(i + 1);
            const val = document.createElement('span');
            val.className = 'list-value';
            val.textContent = String(v);
            row.append(idx, val);
            return row;
          }),
        );
        m.footer.textContent = `length ${items.length}`;
      }
    }
  }
}

/** 监视器文字：数字最多显示六位小数，与原编辑器一致。 */
function monitorText(v: Value): string {
  return typeof v === 'number' ? String(Number(v.toFixed(6))) : String(v);
}

/** 默认（标签和值）与大号（仅值）样式的舞台变量监视器。 */
export class VarMonitors {
  private els = new Map<string, { root: HTMLDivElement; value: HTMLSpanElement; last: string }>();

  constructor(private parent: HTMLElement, private defs: Monitors) {}

  update(rt: Runtime): void {
    for (const d of this.defs.vars) {
      const visible = rt.monitorVisible[`v:${d.prop}`] ?? d.visible;
      let m = this.els.get(d.prop);
      if (!visible) {
        if (m) m.root.hidden = true;
        continue;
      }
      if (!m) {
        const root = document.createElement('div');
        root.className = d.mode === 'large' ? 'var-monitor large' : 'var-monitor';
        root.style.left = `${(d.x / STAGE_W) * 100}%`;
        root.style.top = `${(d.y / STAGE_H) * 100}%`;
        if (d.mode !== 'large') {
          const label = document.createElement('span');
          label.className = 'var-label';
          label.textContent = d.label;
          root.append(label);
        }
        const value = document.createElement('span');
        value.className = 'var-value';
        root.append(value);
        this.parent.append(root);
        m = { root, value, last: '' };
        this.els.set(d.prop, m);
      }
      m.root.hidden = false;
      const text = monitorText(rt.stage.v[d.prop]);
      if (text !== m.last) {
        m.last = text;
        m.value.textContent = text;
      }
    }
  }
}

/** 模拟暂停时覆盖舞台的暂停菜单。其按钮会按下暂停规则中的键。 */
export class PauseMenu {
  private el: HTMLDivElement;
  onKey: (key: string) => void = () => {};

  constructor(parent: HTMLElement, rule: PauseRule) {
    this.el = document.createElement('div');
    this.el.className = 'pause-menu';
    this.el.hidden = true;
    const title = document.createElement('div');
    title.className = 'pause-title';
    title.textContent = 'Paused';
    const resume = document.createElement('button');
    resume.textContent = 'Resume';
    resume.addEventListener('click', () => this.onKey(rule.pauseKey));
    const quit = document.createElement('button');
    quit.textContent = rule.quitLabel;
    quit.addEventListener('click', () => this.onKey(rule.quitKey));
    const hint = document.createElement('div');
    hint.className = 'pause-hint';
    hint.textContent = `${rule.pauseKey} or Esc to resume, ${rule.quitKey}: ${rule.quitLabel.toLowerCase()}`;
    this.el.append(title, resume, quit, hint);
    parent.append(this.el);
  }

  update(rt: Runtime): void {
    if (this.el.hidden === rt.paused) this.el.hidden = !rt.paused;
  }
}

/**
 * `say` 产生的对话气泡，按原版方式放置：位于角色顶部旁，默认在右侧，
 * 若会超出舞台则放到左侧，并始终保持在舞台内。
 */
export class Bubbles {
  private els = new Map<number, { el: HTMLDivElement; right: boolean }>();

  constructor(private parent: HTMLElement) {}

  update(rt: Runtime): void {
    const live = new Set<number>();
    const stageW = this.parent.clientWidth || STAGE_W;
    for (const t of rt.targets) {
      const text = rt.bubbles[t.id];
      if (text === undefined || !t.visible) continue;
      live.add(t.id);
      let m = this.els.get(t.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'say-bubble';
        this.parent.append(el);
        m = { el, right: true };
        this.els.set(t.id, m);
      }
      if (m.el.textContent !== text) m.el.textContent = text;
      // 气泡大小以舞台单位计。造型框只是几何数据；外壳边界会改变模拟状态。
      const unit = STAGE_W / stageW;
      const w = m.el.offsetWidth * unit;
      const h = m.el.offsetHeight * unit;
      const b = rt.render.aabb(t);
      if (m.right && w + b.right > STAGE_X && b.left - w > -STAGE_X) m.right = false;
      else if (!m.right && b.left - w < -STAGE_X && w + b.right < STAGE_X) m.right = true;
      const x = m.right ? Math.max(-STAGE_X, Math.min(STAGE_X - w, b.right)) : Math.min(STAGE_X - w, Math.max(-STAGE_X, b.left - w));
      const y = Math.max(-STAGE_Y + h, Math.min(STAGE_Y, b.top + h));
      m.el.style.left = `${((x + STAGE_X) / STAGE_W) * 100}%`;
      m.el.style.top = `${((STAGE_Y - y) / STAGE_H) * 100}%`;
    }
    for (const [id, m] of this.els) {
      if (!live.has(id)) {
        m.el.remove();
        this.els.delete(id);
      }
    }
  }
}
