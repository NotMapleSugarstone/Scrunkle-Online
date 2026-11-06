import './style.css';
import { Game, startFixedLoop } from './game.ts';
import { LocalInput } from './input.ts';
import { Hud, Lobby } from './lobby.ts';
import { OnlineGame } from './online.ts';
import { applyToPlayerOne, savedControls, seatKeys } from './controls.ts';
import { downloadFile, fileName } from './download.ts';
import { ReplayRecorder, replayName, runtimeState, snapshotState } from './replay.ts';
import { ReplayOffer } from './replay-offer.ts';
import { loadReplay } from './replay-store.ts';
import { runReplayViewer, videoType, type VideoOptions, type VideoQuality } from './replay-viewer.ts';
import { codeFiles, keepSaving, loadSave } from './saves.ts';
import { loadDisplay, loadWearHats, nextDisplay, saveDisplay, saveWearHats } from './display.ts';
import { currentFormat, currentText, displayLabel } from './net-text.ts';
import { wearHats } from '../game/hats.ts';
import { Toast } from './toast.ts';
import { actionKeys, Pads } from './pads.ts';
import { TouchControls } from './touch.ts';
import { seatScreen } from '../game/screens.ts';
import { pauseRule } from '../game/pause.ts';
import { STORAGE_PREFIX } from '../game/page.ts';
import { Mesh } from '../net/mesh.ts';
import { report } from '../net/report.ts';
import { BUILD, cancelRoom, hostRoom, joinRoom, onlineAvailable, RoomClient } from '../net/room-client.ts';
import type { PlayerInput } from '../engine/io.ts';
import { STAGE_H, STAGE_W } from '../engine/defs.ts';
import type { SeatInfo, StartInfo } from '../net/protocol.ts';

const stageWrap = document.getElementById('stage-wrap')!;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const overlay = document.getElementById('overlay')!;
const page = document.getElementById('app')!;

/** 触屏控制创建后设置；构建期间它们会调用 `fitStage`。 */
let touchUi: TouchControls | null = null;

function fitStage(): void {
  // 竖屏时触屏控制占屏幕底部，舞台位于其上方。
  const portraitTouch = !!touchUi?.active && window.innerHeight > window.innerWidth;
  const touchMin = portraitTouch ? 220 : 0;
  document.documentElement.classList.toggle('touch-portrait', portraitTouch);
  const pad = portraitTouch ? 8 : 16;
  const hudSpace = 28;
  const w = Math.max(240, window.innerWidth - pad * 2);
  const h = Math.max(180, window.innerHeight - pad * 2 - hudSpace - touchMin);
  const scale = Math.min(w / STAGE_W, h / STAGE_H);
  const cssW = Math.floor(STAGE_W * scale);
  const cssH = Math.floor(STAGE_H * scale);
  stageWrap.style.width = `${cssW}px`;
  stageWrap.style.height = `${cssH}px`;
  const touchH = portraitTouch ? window.innerHeight - pad * 2 - hudSpace - cssH : 0;
  document.documentElement.style.setProperty('--touch-h', `${touchH}px`);
  document.documentElement.style.setProperty('--stage-w', `${cssW}px`);
  document.documentElement.style.setProperty('--stage-h', `${cssH}px`);
  document.documentElement.style.setProperty('--stage-scale', String(scale));
  if (videoSize) {
    [canvas.width, canvas.height] = videoSize;
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
}

/** 回放录制为视频时的画布尺寸，不随窗口大小改变。 */
let videoSize: [number, number] | null = null;

/** 用 UTC 字段表示的本地时间，使日期积木读取玩家的墙上时钟。 */
function localT0(): number {
  const now = Date.now();
  return now - new Date(now).getTimezoneOffset() * 60_000;
}

fitStage();
window.addEventListener('resize', fitStage);

// 每页只有一个游戏对象：大厅显示期间素材只加载一次。在线游戏以共享种子开始时、
// 播放回放时，以及玩家返回开始界面时，会替换运行时。
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const game = new Game(canvas, overlay, { seed: randomSeed(), t0: localT0() });
const input = new LocalInput(stageWrap);
input.enabled = false;
game.question.onFocusChange = (f) => (input.enabled = !f);
if (game.pause) game.pause.onKey = (k) => input.tap(k);
input.escapeAs = pauseRule?.pauseKey ?? null;
const resumeAudio = () => game.audio.resume();
window.addEventListener('pointerdown', resumeAudio);
window.addEventListener('keydown', resumeAudio);
(window as unknown as { __game: Game }).__game = game;

const pads = new Pads();
const touch = new TouchControls(page, pads, fitStage);
touchUi = touch;
const toast = new Toast(stageWrap);
const offer = new ReplayOffer(stageWrap, toast);

/** 停止代替开始界面运行的内容：离线游玩、在线游戏或回放。 */
let stopPlaying: (() => void) | null = null;

/**
 * 在全新运行时上返回开始界面。图像和声音保持加载，因此无需刷新页面。
 * 保存回放的问题会继续显示在开始界面之上。
 */
function backToStart(view: 'menu' | 'replays' = 'menu'): void {
  stopPlaying?.();
  stopPlaying = null;
  input.enabled = false;
  game.audio.stopAll();
  game.rt = Game.createRuntime({ seed: randomSeed(), t0: localT0() });
  toast.hide();
  touch.setPlaying(false);
  game.present();
  lobby.showStart(view);
}

/** 离线游玩时舞台下方的状态栏，包含返回开始界面的按钮。 */
function leaveBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'hud';
  const leave = document.createElement('button');
  leave.className = 'hud-leave';
  leave.textContent = currentText('leaveGame');
  leave.title = currentText('backToStart');
  leave.tabIndex = -1;
  leave.addEventListener('mousedown', (e) => e.preventDefault());
  leave.addEventListener('click', () => backToStart());
  bar.append(leave);
  page.append(bar);
  return bar;
}

/** 记录每场比赛，并在结束后询问是否保存回放。 */
function recorder(t0: number, online: boolean, names: string[]): ReplayRecorder {
  const r = new ReplayRecorder(game.rt, t0, { build: BUILD, online, names });
  r.onStart = () => offer.clear();
  r.onFinish = (done) => offer.offer(done);
  return r;
}

/** 本地玩家一帧的输入：键盘、触屏、控制器、鼠标以及对问题的回答。 */
function sampleLocal(): PlayerInput {
  const keys = new Set(input.sampleKeys());
  // 触屏和控制器槽位 n 会按下玩家 n+1 的按键。
  pads.sample().forEach((acts, slot) => {
    for (const k of actionKeys(acts, seatKeys(game.rt, slot))) keys.add(k);
  });
  const p0: PlayerInput = { keys: [...keys] };
  const mouse = input.sampleMouse();
  if (mouse) p0.mouse = mouse;
  if (game.question.pendingAnswer !== undefined) {
    p0.answer = game.question.pendingAnswer;
    game.question.pendingAnswer = undefined;
  }
  return p0;
}

let room: RoomClient | null = null;
let mesh: Mesh | null = null;
let online: OnlineGame | null = null;
// 关闭页面时发送告别消息，让其他玩家继续而不再等待。
window.addEventListener('pagehide', () => online?.leave());
let seats: SeatInfo[] = [];
let host = 0;
let code = '';
let hosting = false;

const CUTSCENE_DEFAULT_KEY = `${STORAGE_PREFIX}.cutscenes-off`;
function applyCutsceneDefault(rt: Game['rt']): void {
  let first = false;
  try {
    first = localStorage.getItem(CUTSCENE_DEFAULT_KEY) === null;
    if (first) localStorage.setItem(CUTSCENE_DEFAULT_KEY, '1');
  } catch {
    first = true;
  }
  if (!first) return;
  const prop = rt.stage.sprite.def.listNames?.['!Global_GameSettings'];
  const list = prop === undefined ? undefined : rt.stage.l[prop];
  if (list && list.length > 4) list[4] = 1;
}

const lobby = new Lobby(overlay, {
  local() {
    game.startPrefetch();
    lobby.hide();
    input.enabled = true;
    // 先加载浏览器中的存档，控制设置中的按键会覆盖玩家 1 的已保存按键。
    loadSave(game.rt);
    applyCutsceneDefault(game.rt);
    const own = savedControls();
    if (own) applyToPlayerOne(game.rt, own);
    touch.setPlaying(true);
    game.audio.resume();
    const replay = recorder(game.rt.t0, false, []);
    const bar = leaveBar();
    const stopSaving = keepSaving(() => game.rt);
    const saveCodes = codeFiles((name) => toast.show(currentFormat('saved', { name }), 4000));
    const stopLoop = startFixedLoop(
      () => {
        const p = sampleLocal();
        game.step([p]);
        replay.frame([p], runtimeState(game.rt));
      },
      () => {
        game.present();
        saveCodes(game.rt);
      },
    );
    stopPlaying = () => {
      stopLoop();
      stopSaving();
      bar.remove();
    };
  },
  watch(id) {
    void watchReplay(id);
  },
  recordVideo(id, quality) {
    void watchReplay(id, quality);
  },
  async host(name) {
    lobby.setNetStatus('opening');
    const r = await hostRoom();
    if (!r.ok) {
      lobby.setNetReason(r.reason);
      return;
    }
    code = r.code ?? '';
    hosting = true;
    game.startPrefetch();
    connect(r.room, name);
  },
  async join(name, c) {
    if (!/^[A-Z0-9]{6}$/.test(c)) {
      lobby.setNetStatus('badCode');
      return;
    }
    lobby.setNetStatus('joining');
    const r = await joinRoom(c);
    if (!r.ok) {
      lobby.setNetReason(r.reason);
      return;
    }
    code = c;
    hosting = false;
    game.startPrefetch();
    connect(r.room, name);
  },
  start(delay) {
    room?.send({ type: 'start', t0: localT0(), delay });
  },
  leave() {
    if (hosting && code) void cancelRoom(code);
    online?.leave();
    mesh?.close();
    room?.close();
    room = null;
    mesh = null;
    lobby.showMenu();
    lobby.setStatus('');
  },
  touchControls(on) {
    touch.setChoice(on);
  },
  touchButtons(names) {
    touch.setButtons(names);
  },
  nextDisplay() {
    setDisplay(nextDisplay(display));
  },
  wearHats(on) {
    setWearHats(on);
  },
});
touch.onChange = (on) => lobby.setTouch(on);

let display = loadDisplay();
function setDisplay(mode: typeof display, announce = false): void {
  display = mode;
  saveDisplay(mode);
  game.renderer.setDisplay(mode);
  lobby.setDisplay(mode);
  game.present();
  if (announce) toast.show(currentFormat('displayAnnounce', { name: displayLabel(mode) }), 1500);
}
setDisplay(display);
function setWearHats(on: boolean): void {
  saveWearHats(on);
  game.renderer.setPenView(on ? wearHats : null);
  lobby.setWearHats(on);
  game.present();
}
setWearHats(loadWearHats());
// F2 在所有界面都有效，因此捕获阶段会先于大厅的按键处理看到它。
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'F2' || e.repeat) return;
    e.preventDefault();
    setDisplay(nextDisplay(display), true);
  },
  true,
);
// 菜单一次只响应一个方向；角色选择和比赛使用自由移动。
touch.menuMode = () => !seatScreen(game.rt);
lobby.setTouch(touch.enabled);
lobby.setOnline(onlineAvailable());

function refreshSeats(): void {
  if (!room) return;
  lobby.showRoom(code, seats, room.seat, host, (s) => mesh?.state(s) ?? 'connecting');
}

function connect(roomId: string, name: string): void {
  const client = new RoomClient(roomId, name);
  room = client;
  room.onStatus = (s, why) => {
    // 被拒绝玩家的套接字会在原因到达后立即关闭，原因会留在屏幕上。
    if (client.refusal) return;
    if (s !== 'open') report('room-socket', { status: s, why, inGame: online !== null, ...(online?.diagnostics() ?? {}) });
    if (s === 'reconnecting') lobby.setNetStatus('connectionLost');
    else if (s === 'closed' && !online) lobby.setNetStatus('disconnected');
    else if (s === 'open') lobby.setStatus('');
  };
  room.onMessage = (m) => {
    switch (m.type) {
      case 'welcome':
        // 房间套接字重连后也会收到 welcome。正在运行的游戏保留其
        // 连接，因此只有此玩家的座位变化时才替换 mesh。
        if (!mesh || mesh.local !== m.seat) {
          mesh?.close();
          mesh = new Mesh(room!, m.seat);
          mesh.onLinkChange = () => refreshSeats();
        }
        seats = m.seats;
        host = m.host;
        mesh.ensure(seats.map((s) => s.seat));
        refreshSeats();
        if (m.start && !online) begin(m.start);
        break;
      case 'seats':
        seats = m.seats;
        host = m.host;
        mesh?.ensure(seats.filter((s) => s.connected).map((s) => s.seat));
        refreshSeats();
        online?.seatsChanged(m.seats, m.host);
        break;
      case 'dropped':
        online?.onDropped(m.seat, m.frame, m.data);
        break;
      case 'signal':
        void mesh?.signal(m.from, m.data);
        break;
      case 'relay':
        mesh?.relayed(m.data);
        break;
      case 'go':
        begin(m.start);
        break;
      case 'refused':
        // 房间拒绝自己的房主时房间内无人，因此撤回房间代码。
        if (hosting && code) void cancelRoom(code);
        lobby.setNetReason(m.reason);
        lobby.showMenu();
        break;
    }
  };
  room.connect();
}

function begin(start: StartInfo): void {
  if (!room || !mesh || online) return;
  if (!start.seats.includes(room.seat)) {
    lobby.setNetStatus('startedWithout');
    return;
  }
  game.startPrefetch();
  game.rt = Game.createRuntime({ seed: start.seed, t0: start.t0 });
  const names = new Map(seats.map((s) => [s.seat, s.name]));
  const hud = new Hud(page, () => backToStart(), overlay);
  stopPlaying = () => {
    // 离开时会向其他人告别，并关闭房间和直连。
    online?.leave();
    hud.remove();
    online = null;
    delete (window as unknown as { __online?: OnlineGame }).__online;
    room = null;
    mesh = null;
  };
  online = new OnlineGame(game, room, mesh, start, room.seat, names, hud, host);
  (window as unknown as { __online: OnlineGame }).__online = online;
  // 在线时，只有在每位玩家该帧的输入确认后才记录该帧。
  const replay = recorder(start.t0, true, start.seats.map((s) => names.get(s) ?? `P${s + 1}`));
  online.session.onConfirmed = (_frame, inputs, after) => replay.frame(inputs, snapshotState(game.rt, after));
  lobby.hide();
  input.enabled = true;
  game.audio.resume();
  touch.setPlaying(true);
  online.run(input, pads);
}

window.addEventListener('error', (e) => report('error', { message: e.message, at: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error?.stack, ...(online?.diagnostics() ?? {}) }));
window.addEventListener('unhandledrejection', (e) => report('error', { message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack, ...(online?.diagnostics() ?? {}) }));

/** 代替开始界面播放已保存的回放，或将其录制为视频。 */
async function watchReplay(id: string, quality?: VideoQuality): Promise<void> {
  if (quality && !videoType()) {
    lobby.setStatus(currentText('cannotRecord'));
    return;
  }
  const saved = await loadReplay(id).catch(() => null);
  if (!saved) {
    lobby.setStatus(currentText('replayMissing'));
    return;
  }
  const { meta, body } = saved;
  const warning = meta.build !== BUILD ? currentText('replayDifferentVersion') : '';
  lobby.hide();
  lobby.setStatus('');
  game.audio.stopAll();
  game.rt = Game.createRuntime({ seed: 0, t0: body.t0 });
  const video: VideoOptions | undefined = quality && {
    quality,
    setCanvasSize: (size) => {
      videoSize = size;
      fitStage();
    },
    done: (file, extension) => {
      const name = `${fileName(replayName(meta))}.${extension}`;
      downloadFile(file, name);
      toast.show(extension === 'mp4' ? currentFormat('saved', { name }) : currentFormat('savedWebm', { name }), 5000);
    },
  };
  stopPlaying = runReplayViewer({ game, meta, body, warning, page, stage: stageWrap, video, onExit: () => backToStart('replays') });
}

// 每张图像和每个声音都在大厅后台加载并解码，完成后游玩按钮才启用。
lobby.setLoading(true, currentText('loading'));
void game
  .load(() => {})
  .then(() => {
    lobby.setProgress(1, 1);
    lobby.setLoading(false, '');
  })
  .catch((e) => lobby.setStatus(currentFormat('couldNotLoad', { error: String(e) })));
