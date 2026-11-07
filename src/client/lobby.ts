// 游戏开始前的界面：离线游玩，或创建/加入在线房间。
// 也包含在线游戏期间的状态行和等待面板。
import type { SeatInfo } from '../net/protocol.ts';
import type { LinkState } from '../net/mesh.ts';
import { cleanName, NAME_MAX, SEATS } from '../net/protocol.ts';
import { GAME_TITLE, STORAGE_PREFIX } from '../game/page.ts';
import { browserKeyToName } from '../engine/io.ts';
import { ACTIONS, DEFAULT_KEYS, DEFAULT_TOUCH_BUTTONS, loadControls, loadTouchButtons, saveControls, saveTouchButtons } from './controls.ts';
import { listControllers } from './pads.ts';
import { createElement, Download, Pencil, Play, Trash2, X, type IconNode } from 'lucide';
import { clock, REPLAY_NAME_MAX, replayName, replayTitle, type ReplayMeta } from './replay.ts';
import { deleteReplay, importReplay, listReplays, renameReplay, REPLAY_FILE_TYPE, replayFile } from './replay-store.ts';
import { VIDEO_QUALITIES, type VideoQuality } from './replay-viewer.ts';
import { downloadFile, fileName } from './download.ts';
import { actionLabel, currentText, displayLabel, keyLabel, loadNetLang, modeLabel, netFrameDelay, netReason, netText, saveNetLang, type NetLang, type NetTextKey } from './net-text.ts';
import type { DisplayMode } from '../render/webgl.ts';

const NAME_KEY = `${STORAGE_PREFIX}.name`;
const DELAY_KEY = `${STORAGE_PREFIX}.delay`;
const EXPORT_KEY = `${STORAGE_PREFIX}.replayExport`;
/** 玩家接受在线提示后设置，此浏览器中不再显示该提示。 */
const ONLINE_NOTICE_KEY = `${STORAGE_PREFIX}.onlineNotice`;

/** 上次下载选项：视频或回放文件，以及视频质量。 */
function loadExport(): { kind: 'mp4' | 'file'; quality: VideoQuality } {
  try {
    const v = JSON.parse(localStorage.getItem(EXPORT_KEY) ?? 'null');
    if ((v?.kind === 'mp4' || v?.kind === 'file') && v.quality in VIDEO_QUALITIES) return v;
  } catch {
    // 存储可能被阻止。
  }
  return { kind: 'mp4', quality: '720p' };
}
function renderOption(b: HTMLButtonElement, label: string, on: boolean): void {
  const state = el('span', `lobby-option-state${on ? ' on' : ''}`, on ? currentText('on') : currentText('off'));
  b.replaceChildren(el('span', 'lobby-option-label', label), state);
  b.setAttribute('aria-pressed', String(on));
}

/** 只显示图标的按钮，名称放在提示框中。 */
function iconButton(node: IconNode, label: string, cls = ''): HTMLButtonElement {
  const b = el('button', `lobby-option lobby-icon ${cls}`.trim());
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(createElement(node, { width: 18, height: 18, 'aria-hidden': 'true' }));
  return b;
}

/**
 * 将列表行变为带有“删除”和“保留”的问题，并把 `name` 留在左侧。页面不能依赖
 * 浏览器自带对话框，因为某些嵌入式浏览器从不显示它们。
 */
function askDelete(li: HTMLLIElement, name: HTMLElement, question: string, remove: () => Promise<void>, keep: () => void): void {
  const ask = el('div', 'row-ask');
  ask.append(name, el('span', 'row-question', question));
  const yes = el('button', 'lobby-option mod-delete', currentText('delete'));
  yes.addEventListener('click', () => void remove());
  const no = el('button', 'lobby-option', currentText('keep'));
  no.addEventListener('click', keep);
  li.classList.add('asking');
  li.replaceChildren(ask, yes, no);
  no.focus();
}

/** “在线对战，Kitty Forest，2:31，10 月 20 日”，回放有名称时显示在角色之后。 */
function replayDetail(m: ReplayMeta): string {
  const kind = `${m.online ? currentText('onlinePrefix') : ''}${modeLabel(m.mode).toLowerCase()}`;
  const when = new Date(m.saved).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return [m.name ? replayTitle(m) : '', `${kind[0].toUpperCase()}${kind.slice(1)}`, m.stage, clock(m.frames), when].filter(Boolean).join(', ');
}

/** 回放的全部信息，用于其行的提示框。 */
function replayAbout(m: ReplayMeta): string {
  const who = m.online && m.names.length ? `\n${currentText('players')}: ${m.names.join(', ')}` : '';
  const when = new Date(m.saved).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `${replayName(m)}\n${replayTitle(m)}, ${m.stage}\n${m.online ? currentText('onlinePrefix') : ''}${modeLabel(m.mode)}, ${clock(m.frames)}, ${currentText('savedOn')} ${when}${who}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 在线游玩可接受、无需 Scratch 账号的随机名称。 */
function randomName(): string {
  return `player${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
}

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // 存储可能被阻止。
  }
}

export interface LobbyHandlers {
  local(): void;
  host(name: string): void;
  join(name: string, code: string): void;
  start(delay: number): void;
  leave(): void;
  /** 玩家开启或关闭了触屏控制。 */
  touchControls(on: boolean): void;
  /** 玩家更改了触屏按钮的功能，按 `DEFAULT_TOUCH_BUTTONS` 的位置顺序。 */
  touchButtons(names: string[]): void;
  /** 玩家选择要观看的回放。 */
  watch(id: string): void;
  /** 玩家选择将回放下载为视频。 */
  recordVideo(id: string, quality: VideoQuality): void;
  /** 玩家请求下一个显示模式。 */
  nextDisplay(): void;
  /** 玩家开启或关闭了“实际戴上帽子”。 */
  wearHats(on: boolean): void;
}

export class Lobby {
  root: HTMLDivElement;
  private status: HTMLDivElement;
  private menu: HTMLDivElement;
  private room: HTMLDivElement;
  private onlineHeading: HTMLDivElement;
  private nameLabel: HTMLSpanElement;
  private codeOut: HTMLSpanElement;
  private codeLabel: HTMLSpanElement;
  private barTitle: HTMLSpanElement;
  private seatList: HTMLUListElement;
  private startBtn: HTMLButtonElement;
  private waitNote: HTMLParagraphElement;
  private delayLabel: HTMLSpanElement;
  private leaveBtn: HTMLButtonElement;
  private nameIn: HTMLInputElement;
  private delayIn: HTMLSelectElement;
  private hostBtn: HTMLButtonElement;
  private codeIn: HTMLInputElement;
  private joinBtn: HTMLButtonElement;
  private onlineRows: HTMLElement[];
  private offlineNote: HTMLParagraphElement;
  private loading = true;
  private controlsView: HTMLDivElement;
  private controlsBtn: HTMLButtonElement;
  private touchBtn: HTMLButtonElement;
  private touchOn = false;
  private controls = loadControls();
  private keyButtons: HTMLButtonElement[] = [];
  /** 正在等待按键的按钮索引，或 -1。 */
  private capturing = -1;
  private controlsHeading: HTMLDivElement;
  private controlsTabs: HTMLDivElement;
  private keysTabBtn: HTMLButtonElement;
  private touchTabBtn: HTMLButtonElement;
  private controlsTab: 'keys' | 'touch' = 'keys';
  private keysPart: HTMLDivElement;
  private touchEdit: HTMLDivElement;
  private touchPicks: HTMLButtonElement[] = [];
  private touchButtons = loadTouchButtons();
  /** 先点选的触屏按钮，等待与另一个交换，或 -1。 */
  private picked = -1;
  /** 控制界面显示时，浏览器能看到的控制器。 */
  private padNote: HTMLParagraphElement;
  private padTimer: ReturnType<typeof setInterval> | null = null;
  /** 控制界面返回的界面。 */
  private backTo: 'menu' | 'room' = 'menu';
  private replaysView: HTMLDivElement;
  private replaysBtn: HTMLButtonElement;
  private replayList: HTMLUListElement;
  private displayBtn: HTMLButtonElement;
  private hatsBtn: HTMLButtonElement;
  private hatsOn = false;
  private langBtn: HTMLButtonElement;
  private lang: NetLang = loadNetLang();
  private statusKey: NetTextKey | null = null;
  private statusReason: string | null = null;
  private roomHost = true;
  private roomReady = false;
  private noticeView: HTMLDivElement;
  private noticeHeading: HTMLDivElement;
  private noticeText: HTMLParagraphElement;
  private noticeOk: HTMLButtonElement;
  private noticeBack: HTMLButtonElement;
  /** 等待玩家接受在线提示的创建或加入操作。 */
  private afterNotice: (() => void) | null = null;

  constructor(parent: HTMLElement, private h: LobbyHandlers) {
    this.root = el('div', 'lobby');
    const panel = el('div', 'lobby-panel');
    panel.append(el('h1', 'lobby-title lobby-name', GAME_TITLE));

    this.menu = el('div', 'lobby-menu');
    const nameRow = el('label', 'lobby-field');
    this.nameLabel = el('span', '', this.t('name'));
    nameRow.append(this.nameLabel);
    this.nameIn = el('input');
    this.nameIn.maxLength = NAME_MAX;
    this.nameIn.spellcheck = false;
    this.nameIn.autocomplete = 'off';
    this.nameIn.autocapitalize = 'off';
    this.nameIn.title = this.t('nameHint');
    this.nameIn.value = cleanName(load(NAME_KEY, '')) || randomName();
    // Scratch 用户名不允许的字符会在输入或粘贴时被移除。
    this.nameIn.addEventListener('input', () => {
      const v = this.nameIn.value;
      const clean = cleanName(v);
      if (clean === v) return;
      const at = cleanName(v.slice(0, this.nameIn.selectionStart ?? v.length)).length;
      this.nameIn.value = clean;
      this.nameIn.setSelectionRange(at, at);
      this.setNetStatus('nameRule');
    });
    nameRow.append(this.nameIn);
    const localBtn = el('button', 'primary', this.t('playOffline'));
    this.hostBtn = el('button', '', this.t('host'));
    const joinRow = el('div', 'lobby-join');
    this.codeIn = el('input');
    this.codeIn.placeholder = this.t('roomCode');
    this.codeIn.maxLength = 6;
    this.codeIn.autocapitalize = 'characters';
    this.joinBtn = el('button', '', this.t('join'));
    joinRow.append(this.codeIn, this.joinBtn);
    this.onlineRows = [nameRow, this.hostBtn, joinRow];
    this.offlineNote = el('p', 'lobby-note', this.t('offline'));
    this.offlineNote.hidden = true;
    this.onlineHeading = el('div', 'lobby-heading', this.t('online'));
    this.menu.append(localBtn, this.onlineHeading, nameRow, this.hostBtn, joinRow, this.offlineNote);

    this.room = el('div', 'lobby-room');
    this.room.hidden = true;
    const bar = el('div', 'lobby-bar');
    this.codeOut = el('span', 'code');
    this.codeLabel = el('span', '', `${this.t('code')} `);
    const codeCell = el('span', '');
    codeCell.append(this.codeLabel, this.codeOut);
    this.barTitle = el('span', 'lobby-bar-title', this.t('online'));
    bar.append(this.barTitle, codeCell);
    this.seatList = el('ul', 'lobby-seats');
    const opts = el('div', 'lobby-opts');
    const delayRow = el('label', 'lobby-field');
    this.delayLabel = el('span', '', this.t('inputDelay'));
    delayRow.append(this.delayLabel);
    this.delayIn = el('select');
    this.updateDelayOptions();
    this.delayIn.value = load(DELAY_KEY, '1');
    delayRow.append(this.delayIn);
    opts.append(delayRow);
    this.startBtn = el('button', 'primary', this.t('start'));
    this.waitNote = el('p', 'lobby-note', this.t('waitHost'));
    const keysNote = el('p', 'lobby-note', this.t('roomKeysNote'));
    this.leaveBtn = el('button', '', this.t('leaveRoom'));
    this.leaveBtn.addEventListener('click', () => this.h.leave());
    this.room.append(bar, this.seatList, opts, this.startBtn, this.waitNote, keysNote, this.leaveBtn);

    this.controlsView = el('div', 'lobby-controls');
    this.controlsView.hidden = true;
    const grid = el('div', 'controls-grid');
    ACTIONS.forEach((action, i) => {
      const row = el('div', 'control');
      const key = el('button', 'control-key');
      key.addEventListener('click', () => this.capture(i));
      this.keyButtons.push(key);
      row.append(el('span', '', actionLabel(action)), key);
      grid.append(row);
    });
    // 屏幕上的触屏按钮位置。
    this.touchEdit = el('div', 'touch-edit');
    const touchFace = el('div', 'touch-edit-face');
    const touchSmall = el('div', 'touch-edit-small');
    DEFAULT_TOUCH_BUTTONS.map((_, i) => ['top', 'left', 'right', 'bottom'][i] ?? 'pill').forEach((place, i) => {
      const b = el('button', place);
      b.addEventListener('click', () => this.pickTouch(i));
      this.touchPicks.push(b);
      (i < 4 ? touchFace : touchSmall).append(b);
    });
    const touchPad = el('div', 'touch-edit-pad');
    touchPad.append(touchFace, touchSmall);
    this.touchEdit.append(el('p', 'lobby-note', currentText('tapSwap')), touchPad);
    this.renderTouch();
    // 触屏控制开启时，两个标签页会占据标题位置，使界面无需滚动即可放下。
    this.controlsHeading = el('div', 'lobby-heading', currentText('yourControls'));
    this.controlsTabs = el('div', 'controls-tabs');
    const tab = (label: string, which: 'keys' | 'touch'): HTMLButtonElement => {
      const b = el('button', '', label);
      b.addEventListener('click', () => {
        this.controlsTab = which;
        this.capture(-1);
        this.renderControlsTab();
      });
      this.controlsTabs.append(b);
      return b;
    };
    this.keysTabBtn = tab(currentText('keys'), 'keys');
    this.touchTabBtn = tab(currentText('touchButtons'), 'touch');
    this.keysPart = el('div', 'controls-keys');
    this.keysPart.append(el('p', 'lobby-note', currentText('keysNote')), grid);
    const actions = el('div', 'lobby-actions');
    const resetBtn = el('button', '', currentText('resetDefaults'));
    const doneBtn = el('button', 'primary', currentText('done'));
    actions.append(resetBtn, doneBtn);
    this.padNote = el('p', 'lobby-note');
    this.controlsView.append(this.controlsHeading, this.controlsTabs, this.keysPart, this.touchEdit, this.padNote, actions);
    resetBtn.addEventListener('click', () => {
      this.controls = [...DEFAULT_KEYS[0]];
      saveControls(this.controls);
      this.setTouchButtons([...DEFAULT_TOUCH_BUTTONS]);
      this.capture(-1);
    });
    doneBtn.addEventListener('click', () => this.show(this.backTo));
    this.renderKeys();

    this.replaysView = el('div', 'lobby-controls lobby-mods lobby-replays');
    this.replaysView.hidden = true;
    this.replayList = el('ul', 'mod-list replay-list');
    const replayActions = el('div', 'lobby-actions');
    const upload = el('button', '', currentText('upload'));
    upload.title = `${currentText('upload')} ${REPLAY_FILE_TYPE}`;
    const replayPick = el('input');
    replayPick.type = 'file';
    replayPick.accept = REPLAY_FILE_TYPE;
    replayPick.multiple = true;
    replayPick.hidden = true;
    upload.addEventListener('click', () => replayPick.click());
    replayPick.addEventListener('change', async () => {
      const files = [...(replayPick.files ?? [])];
      replayPick.value = '';
      const problems: string[] = [];
      for (const file of files) {
        try {
          await importReplay(file);
        } catch (e) {
          problems.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.setStatus(problems.join(' '));
      await this.refreshReplays();
    });
    const replaysDone = el('button', 'primary', currentText('done'));
    replaysDone.addEventListener('click', () => this.show('menu'));
    replayActions.append(upload, replaysDone, replayPick);
    this.replaysView.append(el('div', 'lobby-heading', currentText('replays')), this.replayList, replayActions);

    // 在此浏览器中首次创建或加入前显示。
    this.noticeView = el('div', 'lobby-controls');
    this.noticeView.hidden = true;
    this.noticeOk = el('button', 'primary', this.t('understand'));
    this.noticeBack = el('button', '', this.t('cancel'));
    const noticeActions = el('div', 'lobby-actions');
    noticeActions.append(this.noticeOk, this.noticeBack);
    this.noticeHeading = el('div', 'lobby-heading', this.t('noticeTitle'));
    this.noticeText = el('p', 'lobby-note', this.t('notice'));
    this.noticeView.append(
      this.noticeHeading,
      this.noticeText,
      noticeActions,
    );
    this.noticeOk.addEventListener('click', () => {
      store(ONLINE_NOTICE_KEY, '1');
      const go = this.afterNotice;
      this.afterNotice = null;
      this.show('menu');
      go?.();
    });
    this.noticeBack.addEventListener('click', () => {
      this.afterNotice = null;
      this.show('menu');
    });

    this.status = el('div', 'lobby-status');
    panel.append(this.menu, this.room, this.controlsView, this.replaysView, this.noticeView, this.status);
    this.replaysBtn = el('button', 'lobby-option', currentText('replays'));
    this.replaysBtn.addEventListener('click', () => this.openReplays());
    this.controlsBtn = el('button', 'lobby-option', currentText('controls'));
    this.controlsBtn.addEventListener('click', () => this.openControls());
    this.touchBtn = el('button', 'lobby-option');
    this.touchBtn.addEventListener('click', () => this.h.touchControls(!this.touchOn));
    this.setTouch(false);
    this.displayBtn = el('button', 'lobby-option');
    this.displayBtn.title = this.t('displayHint');
    this.displayBtn.addEventListener('click', () => this.h.nextDisplay());
    this.setDisplay('smooth');
    this.hatsBtn = el('button', 'lobby-option');
    this.hatsBtn.title = this.t('wearHatsHint');
    this.hatsBtn.addEventListener('click', () => this.h.wearHats(!this.hatsOn));
    this.setWearHats(false);
    this.langBtn = el('button', 'lobby-option');
    this.langBtn.addEventListener('click', () => this.setLanguage(this.lang === 'zh' ? 'en' : 'zh'));
    this.renderLanguage();
    // 页脚会把这些选项移开，避免在矮屏幕上挡住面板。
    const footer = el('div', 'lobby-footer');
    const left = el('div', 'lobby-footer-left');
    left.append(this.replaysBtn, this.touchBtn, this.displayBtn, this.hatsBtn, this.langBtn);
    void this.refreshReplays();
    footer.append(left, this.controlsBtn);
    this.root.append(panel, footer);
    parent.append(this.root);
    window.addEventListener('keydown', (e) => this.onCaptureKey(e), true);

    localBtn.addEventListener('click', () => !this.loading && this.h.local());
    this.hostBtn.addEventListener('click', () => {
      const name = this.name();
      if (name) this.online(() => this.h.host(name));
    });
    const join = () => {
      const name = this.name();
      if (name) this.online(() => this.h.join(name, this.codeIn.value.trim().toUpperCase()));
    };
    this.joinBtn.addEventListener('click', join);
    this.codeIn.addEventListener('keydown', (e) => e.key === 'Enter' && join());
    this.startBtn.addEventListener('click', () => {
      store(DELAY_KEY, this.delayIn.value);
      this.h.start(Number(this.delayIn.value));
    });
    // 输入大厅的按键不能传到下方游戏。
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    this.root.addEventListener('keyup', (e) => e.stopPropagation());
  }

  private t(key: NetTextKey): string {
    return netText(this.lang, key);
  }

  private setLanguage(lang: NetLang): void {
    if (lang === this.lang) return;
    const name = cleanName(this.nameIn.value);
    if (name) store(NAME_KEY, name);
    this.lang = lang;
    saveNetLang(lang);
    window.location.reload();
  }

  private renderLanguage(): void {
    this.nameLabel.textContent = this.t('name');
    this.nameIn.title = this.t('nameHint');
    this.hostBtn.textContent = this.t('host');
    this.codeIn.placeholder = this.t('roomCode');
    this.joinBtn.textContent = this.t('join');
    this.onlineHeading.textContent = this.t('online');
    this.offlineNote.textContent = this.t('offline');
    this.codeLabel.textContent = `${this.t('code')} `;
    this.barTitle.textContent = this.t('online');
    this.delayLabel.textContent = this.t('inputDelay');
    this.updateDelayOptions();
    this.startBtn.textContent = this.t('start');
    this.updateWaitNote();
    this.leaveBtn.textContent = this.t('leaveRoom');
    this.noticeHeading.textContent = this.t('noticeTitle');
    this.noticeText.textContent = this.t('notice');
    this.noticeOk.textContent = this.t('understand');
    this.noticeBack.textContent = this.t('cancel');
    this.langBtn.replaceChildren(el('span', 'lobby-option-label', this.t('language')), el('span', 'lobby-option-state', this.lang === 'zh' ? '中文' : 'EN'));
    this.langBtn.title = this.t('switchLanguage');
    this.langBtn.setAttribute('aria-label', this.langBtn.title);
    if (this.statusKey) this.writeStatus(this.t(this.statusKey));
    else if (this.statusReason !== null) this.writeStatus(netReason(this.lang, this.statusReason));
  }

  private updateDelayOptions(): void {
    const selected = this.delayIn.value;
    this.delayIn.replaceChildren(...Array.from({ length: 5 }, (_, d) => {
      const option = el('option', '', netFrameDelay(this.lang, d));
      option.value = String(d);
      return option;
    }));
    this.delayIn.value = selected;
  }

  private updateWaitNote(): void {
    this.waitNote.hidden = this.roomHost && this.roomReady;
    this.waitNote.textContent = this.roomHost ? this.t('waitJoin') : this.t('waitHost');
  }

  private name(): string | null {
    const name = cleanName(this.nameIn.value);
    if (!name) {
      this.setNetStatus('nameRule');
      return null;
    }
    store(NAME_KEY, name);
    return name;
  }

  /** 首张图片加载期间禁用游玩按钮，并显示进度。 */
  setLoading(loading: boolean, text = ''): void {
    this.loading = loading;
    for (const b of this.menu.querySelectorAll('button')) b.disabled = loading;
    this.setStatus(text);
  }

  setOnline(available: boolean): void {
    for (const r of this.onlineRows) r.hidden = !available;
    this.offlineNote.hidden = available;
  }

  setStatus(text: string): void {
    this.statusKey = null;
    this.statusReason = null;
    this.writeStatus(text);
  }

  setNetStatus(key: NetTextKey): void {
    this.statusKey = key;
    this.statusReason = null;
    this.writeStatus(this.t(key));
  }

  setNetReason(reason: string): void {
    this.statusKey = null;
    this.statusReason = reason;
    this.writeStatus(netReason(this.lang, reason));
  }

  private writeStatus(text: string): void {
    this.status.textContent = text;
  }

  showMenu(): void {
    this.show('menu');
  }

  /** 游戏或回放结束后再次显示大厅，位于菜单或回放界面。 */
  showStart(view: 'menu' | 'replays'): void {
    this.root.hidden = false;
    if (view === 'replays') this.openReplays();
    else this.show('menu');
    void this.refreshReplays();
  }

  /** 执行在线操作；若玩家尚未接受在线提示，则先显示提示。 */
  private online(action: () => void): void {
    if (load(ONLINE_NOTICE_KEY, '') === '1') {
      action();
      return;
    }
    this.afterNotice = action;
    this.setStatus('');
    this.show('notice');
  }

  private show(view: 'menu' | 'room' | 'controls' | 'replays' | 'notice'): void {
    if (view === 'menu' || view === 'room') this.backTo = view;
    if (this.padTimer) clearInterval(this.padTimer);
    this.padTimer = null;
    this.capture(-1);
    this.picked = -1;
    this.renderTouch();
    this.menu.hidden = view !== 'menu';
    this.room.hidden = view !== 'room';
    this.controlsView.hidden = view !== 'controls';
    this.replaysView.hidden = view !== 'replays';
    this.noticeView.hidden = view !== 'notice';
    this.touchBtn.hidden = view !== 'menu';
    this.replaysBtn.hidden = view !== 'menu';
    this.displayBtn.hidden = view !== 'menu';
    this.hatsBtn.hidden = view !== 'menu';
    this.langBtn.hidden = view !== 'menu';
    this.controlsBtn.hidden = view === 'controls' || view === 'replays' || view === 'notice';
    this.root.classList.toggle('in-room', view === 'room');
  }

  private openReplays(): void {
    this.show('replays');
    void this.refreshReplays();
  }

  private async refreshReplays(): Promise<void> {
    const all = await listReplays();
    this.replaysBtn.replaceChildren(el('span', 'lobby-option-label', this.t('replays')), el('span', `lobby-option-state${all.length ? ' on' : ''}`, all.length ? String(all.length) : this.t('none')));
    this.replayList.replaceChildren(...all.map((m) => this.replayRow(m)));
    if (!all.length) this.replayList.append(el('li', 'lobby-note', this.t('noReplays')));
  }

  private replayRow(m: ReplayMeta): HTMLLIElement {
    const li = el('li', 'mod replay');
    const what = el('div', 'replay-what');
    const name = el('span', 'mod-name', replayName(m));
    what.title = replayAbout(m);
    what.append(name, el('span', 'replay-detail', replayDetail(m)));
    const rename = iconButton(Pencil, this.t('rename'));
    rename.addEventListener('click', () => this.rename(m, name));
    const watch = iconButton(Play, this.t('watch'));
    watch.addEventListener('click', () => this.h.watch(m.id));
    const del = iconButton(Trash2, this.t('delete'), 'mod-delete');
    del.addEventListener('click', () =>
      askDelete(
        li,
        name,
        this.t('deleteReplay'),
        async () => {
          await deleteReplay(m.id);
          await this.refreshReplays();
        },
        () => li.replaceWith(this.replayRow(m)),
      ),
    );
    const save = iconButton(Download, this.t('download'));
    save.addEventListener('click', () => this.askDownload(m, li, name));
    li.append(what, rename, watch, save, del);
    return li;
  }

  /** 将回放行变为下载选项：视频或回放文件，以及视频质量。 */
  private askDownload(m: ReplayMeta, li: HTMLLIElement, name: HTMLElement): void {
    const pick = loadExport();
    const keep = () => {
      try {
        localStorage.setItem(EXPORT_KEY, JSON.stringify(pick));
      } catch {
        // 存储可能被阻止。
      }
    };
    const kinds = el('div', 'export-kind');
    const mp4 = el('button', 'lobby-option', 'MP4');
    mp4.title = this.t('videoOfReplay');
    const file = el('button', 'lobby-option', REPLAY_FILE_TYPE.slice(1).toUpperCase());
    file.title = this.t('replayFile');
    kinds.append(mp4, file);
    const quality = el('select', 'export-quality');
    quality.title = this.t('videoQuality');
    for (const q of Object.keys(VIDEO_QUALITIES)) quality.append(new Option(q, q));
    quality.value = pick.quality;
    const render = () => {
      mp4.classList.toggle('on', pick.kind === 'mp4');
      file.classList.toggle('on', pick.kind === 'file');
      quality.hidden = pick.kind !== 'mp4';
    };
    const choose = (kind: 'mp4' | 'file') => () => {
      pick.kind = kind;
      keep();
      render();
    };
    mp4.addEventListener('click', choose('mp4'));
    file.addEventListener('click', choose('file'));
    quality.addEventListener('change', () => {
      pick.quality = quality.value as VideoQuality;
      keep();
    });
    const go = iconButton(Download, this.t('download'));
    go.addEventListener('click', async () => {
      li.replaceWith(this.replayRow(m));
      if (pick.kind === 'mp4') {
        this.h.recordVideo(m.id, pick.quality);
        return;
      }
      const blob = await replayFile(m.id);
      if (blob) downloadFile(blob, `${fileName(replayName(m))}${REPLAY_FILE_TYPE}`);
    });
    const cancel = iconButton(X, this.t('cancel'));
    cancel.addEventListener('click', () => li.replaceWith(this.replayRow(m)));
    render();
    li.classList.add('choosing');
    li.replaceChildren(name, kinds, quality, go, cancel);
  }

  /** 用文本框替换回放名称。按 Enter 或离开文本框会保存，Escape 取消，名称为空则恢复角色名。 */
  private rename(m: ReplayMeta, name: HTMLElement): void {
    const box = el('input', 'replay-rename');
    box.maxLength = REPLAY_NAME_MAX;
    box.value = m.name ?? '';
    box.placeholder = replayTitle(m);
    let finished = false;
    const finish = async (save: boolean) => {
      if (finished) return;
      finished = true;
      if (save) await renameReplay(m.id, box.value.trim());
      await this.refreshReplays();
    };
    // 游戏的按键处理器会占用空格和方向键，因此按键事件在文本框处停止。
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void finish(true);
      else if (e.key === 'Escape') void finish(false);
    });
    box.addEventListener('blur', () => void finish(true));
    name.replaceWith(box);
    box.focus();
    box.select();
  }

  private openControls(): void {
    this.controlsTab = this.touchOn ? 'touch' : 'keys';
    this.renderControlsTab();
    this.show('controls');
    this.renderPads();
    this.padTimer = setInterval(() => this.renderPads(), 500);
  }

  /** 列出浏览器能看到的控制器名称，让玩家知道是否检测到了自己的控制器。 */
  private renderPads(): void {
    const all = listControllers();
    const used = all.filter((c) => c.used).map((c) => c.name);
    const other = all.filter((c) => !c.used).map((c) => c.name);
    let text = used.length ? `${used.length > 1 ? this.t('controllers') : this.t('controller')}: ${used.join(', ')}.` : this.t('noController');
    if (other.length) text += ` ${this.t('notUsed')}: ${other.join(', ')}.`;
    if (this.padNote.textContent !== text) this.padNote.textContent = text;
  }

  private renderControlsTab(): void {
    const touch = this.touchOn && this.controlsTab === 'touch';
    this.controlsHeading.hidden = this.touchOn;
    this.controlsTabs.hidden = !this.touchOn;
    this.keysPart.hidden = touch;
    this.touchEdit.hidden = !touch;
    this.keysTabBtn.setAttribute('aria-pressed', String(!touch));
    this.touchTabBtn.setAttribute('aria-pressed', String(touch));
  }

  /** 开始等待某个按钮的按键；`i` 为 -1 时停止等待。 */
  private capture(i: number): void {
    this.capturing = i;
    this.renderKeys();
  }

  private onCaptureKey(e: KeyboardEvent): void {
    if (this.capturing < 0 || this.root.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      this.capture(-1);
      return;
    }
    const name = browserKeyToName(e.key);
    if (!name) return;
    this.controls[this.capturing] = name;
    saveControls(this.controls);
    this.capture(-1);
  }

  private renderKeys(): void {
    this.keyButtons.forEach((b, i) => {
      const label = i === this.capturing ? this.t('pressKey') : keyLabel(this.controls[i]);
      b.textContent = label;
      b.title = label;
      b.classList.toggle('capturing', i === this.capturing);
      b.classList.toggle('long', label.length > 6);
    });
  }

  /** 显示触屏控制是否开启。开启状态由已保存的选择或设备决定。 */
  setTouch(on: boolean): void {
    this.touchOn = on;
    renderOption(this.touchBtn, this.t('touchControls'), on);
    this.renderControlsTab();
  }

  setDisplay(mode: DisplayMode): void {
    const state = el('span', `lobby-option-state${mode === 'smooth' ? '' : ' on'}`, displayLabel(mode));
    this.displayBtn.replaceChildren(el('span', 'lobby-option-label', this.t('display')), state);
  }

  setWearHats(on: boolean): void {
    this.hatsOn = on;
    renderOption(this.hatsBtn, this.t('wearHats'), on);
  }

  /** 选择触屏按钮交换的第一个按钮，或与之前选中的按钮交换功能。 */
  private pickTouch(i: number): void {
    if (this.picked < 0 || this.picked === i) {
      this.picked = this.picked === i ? -1 : i;
      this.renderTouch();
      return;
    }
    const next = [...this.touchButtons];
    [next[this.picked], next[i]] = [next[i], next[this.picked]];
    this.setTouchButtons(next);
  }

  private setTouchButtons(names: string[]): void {
    this.touchButtons = names;
    this.picked = -1;
    saveTouchButtons(names);
    this.h.touchButtons([...names]);
    this.renderTouch();
  }

  private renderTouch(): void {
    this.touchPicks.forEach((b, i) => {
      b.textContent = actionLabel(this.touchButtons[i]);
      b.classList.toggle('picked', i === this.picked);
      b.setAttribute('aria-pressed', String(i === this.picked));
    });
  }

  showRoom(code: string, seats: SeatInfo[], local: number, host: number, links: (seat: number) => LinkState | null): void {
    if (this.controlsView.hidden) this.show('room');
    else this.backTo = 'room';
    this.codeOut.textContent = code;
    const items: HTMLLIElement[] = [];
    for (let s = 0; s < SEATS; s++) {
      const info = seats.find((x) => x.seat === s);
      const li = el('li', `seat${info ? '' : ' seat-open'}`);
      li.style.setProperty('--c', `var(--p${s + 1})`);
      li.append(el('span', 'seat-tag', `P${s + 1}`));
      if (!info) li.append(el('span', 'seat-empty', this.t('open')));
      else {
        li.append(el('span', 'seat-name', info.name));
        if (s === local) li.append(el('span', 'seat-link', this.t('you')));
        else if (!info.connected) li.append(el('span', 'seat-link', this.t('reconnecting')));
        else {
          const state = links(s);
          if (state) li.append(el('span', `seat-link ${state}`, state === 'direct' ? this.t('direct') : state === 'relay' ? this.t('relay') : this.t('connecting')));
        }
        if (s === host) li.append(el('span', 'seat-link', this.t('hostTag')));
      }
      items.push(li);
    }
    this.seatList.replaceChildren(...items);
    const isHost = local === host;
    const ready = seats.filter((x) => x.connected).length >= 2;
    this.startBtn.hidden = !isHost;
    this.startBtn.disabled = !ready;
    this.roomHost = isHost;
    this.roomReady = ready;
    this.updateWaitNote();
  }

  hide(): void {
    this.root.hidden = true;
  }
}

export class Hud {
  root: HTMLDivElement;
  private line: HTMLSpanElement;
  private warn: HTMLSpanElement;
  private button: HTMLButtonElement;
  private onAction: () => void = () => {};
  private wait: HTMLDivElement;
  private waitTitle: HTMLDivElement;
  private waitText: HTMLParagraphElement;
  private waitButton: HTMLButtonElement;
  private onWait: () => void = () => {};

  constructor(parent: HTMLElement, onLeave: () => void, stage: HTMLElement) {
    this.root = el('div', 'hud');
    this.line = el('span', 'hud-line');
    this.warn = el('span', 'hud-warn');
    this.button = el('button', 'hud-action');
    this.button.hidden = true;
    this.button.addEventListener('click', () => this.onAction());
    const leave = el('button', 'hud-leave', 'Leave game');
    leave.addEventListener('click', onLeave);
    this.root.append(this.line, this.warn, this.button, leave);
    parent.append(this.root);
    this.wait = el('div', 'hud-wait');
    this.wait.hidden = true;
    this.waitTitle = el('div', 'lobby-heading');
    this.waitText = el('p', 'lobby-note');
    this.waitButton = el('button', 'primary');
    this.waitButton.addEventListener('click', () => this.onWait());
    this.wait.append(this.waitTitle, this.waitText, this.waitButton);
    stage.append(this.wait);
  }

  remove(): void {
    this.root.remove();
    this.wait.remove();
  }

  update(text: string, warn: string): void {
    if (this.line.textContent !== text) this.line.textContent = text;
    if (this.warn.textContent !== warn) this.warn.textContent = warn;
  }

  action(label: string | null, onClick: () => void): void {
    this.button.hidden = label === null;
    if (label !== null && this.button.textContent !== label) this.button.textContent = label;
    this.onAction = onClick;
  }

  /** 在线游戏等待玩家时覆盖舞台的面板；标题为 null 时隐藏。 */
  waiting(title: string | null, text = '', button: { label: string; onClick: () => void } | null = null): void {
    this.wait.hidden = title === null;
    if (title === null) return;
    if (this.waitTitle.textContent !== title) this.waitTitle.textContent = title;
    if (this.waitText.textContent !== text) this.waitText.textContent = text;
    this.waitButton.hidden = !button;
    if (button) {
      if (this.waitButton.textContent !== button.label) this.waitButton.textContent = button.label;
      this.onWait = button.onClick;
    }
  }
}
