// 代替开始界面播放已保存的回放：从保存的开始状态和记录输入重演比赛，
// 并提供暂停、单步、变速、跳转和退出按钮。
// 向后跳转时加载路径上最近的状态（每 2 秒一个），再向前播放。
import { loadSnapshot, saveSnapshot, type Snapshot } from '../engine/snapshot.ts';
import { snapshotHash } from '../net/rollback.ts';
import { startFixedLoop, type Game } from './game.ts';
import { clock, replayFrames, replayName, type ReplayBody, type ReplayMeta } from './replay.ts';
import { currentFormat, currentText } from './net-text.ts';

export interface ReplayViewerOptions {
  /** 游戏；运行时已用回放的 `t0` 重新创建。 */
  game: Game;
  meta: ReplayMeta;
  body: ReplayBody;
  /** 若播放结果可能不同，说明原因；此时回放以暂停状态开始。 */
  warning: string;
  page: HTMLElement;
  stage: HTMLElement;
  /** 玩家选择退出，或视频录制完成。 */
  onExit: () => void;
  /** 以正常速度将整个回放录制为视频，而不是让玩家观看。 */
  video?: VideoOptions;
}

/** 视频尺寸保持游戏的 16:9 比例。 */
export const VIDEO_QUALITIES = {
  '480p': { width: 854, height: 480, bitrate: 2_500_000 },
  '720p': { width: 1280, height: 720, bitrate: 5_000_000 },
  '1080p': { width: 1920, height: 1080, bitrate: 10_000_000 },
} as const;
export type VideoQuality = keyof typeof VIDEO_QUALITIES;

export interface VideoOptions {
  quality: VideoQuality;
  /** 录制时将画布设为固定尺寸；传入 null 时恢复窗口尺寸。 */
  setCanvasSize: (size: [number, number] | null) => void;
  /** 完成视频及其文件扩展名时调用。 */
  done: (video: Blob, extension: string) => void;
}

/** 浏览器能录制 MP4 时用 MP4，否则用 WebM。 */
const VIDEO_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

/** 此浏览器可录制的视频类型，无法录制时为 null。 */
export function videoType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
  return VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

const KEEP_EVERY = 60;
const SPEEDS = [0.25, 0.5, 1, 2, 4];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 不获取键盘焦点的按钮，使空格和方向键继续有效。 */
function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', undefined, text);
  b.title = title;
  b.tabIndex = -1;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

/** 启动回放。返回停止回放并移除控件的函数。 */
export function runReplayViewer(o: ReplayViewerOptions): () => void {
  const { game, body } = o;
  const pageTitle = document.title;
  const bar = el('div', 'hud test-bar replay-bar');
  const exit = button(currentText('exit'), currentText('exitHint'), () => o.onExit());
  exit.classList.add('hud-leave');
  const note = el('div', 'replay-note');
  note.hidden = true;
  o.stage.append(note);
  o.page.prepend(bar);
  const tell = (text: string) => {
    note.textContent = text;
    note.hidden = false;
  };
  let stopLoop = () => {};
  let ready = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') exit.click();
    else if (!ready || !controls(e.key)) return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  let recorder: MediaRecorder | null = null;
  const stop = () => {
    stopLoop();
    window.removeEventListener('keydown', onKey);
    // 提前停止的录制会被丢弃。
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (o.video) {
      game.audio.endCapture();
      o.video.setCanvasSize(null);
    }
    bar.remove();
    note.remove();
    document.title = pageTitle;
  };

  const rt = () => game.rt;
  try {
    loadSnapshot(rt(), body.start);
  } catch {
    bar.append(el('span', 'hud-line', currentFormat('replayPrefix', { name: replayName(o.meta) })), exit);
    tell(currentText('cannotPlayReplay'));
    return stop;
  }
  game.audio.resync(rt());

  const frames = replayFrames(body);
  const total = frames.length;
  const checks = new Map(body.checks);
  const kept = new Map<number, Snapshot>([[0, body.start]]);
  let at = 0;
  let paused = false;
  let speed = 2;
  let carry = 0;
  let mismatch = false;

  /** 播放下一条记录帧。 */
  function advance(): void {
    game.step(frames[at]);
    at++;
    if (at % KEEP_EVERY === 0 && !kept.has(at)) kept.set(at, saveSnapshot(rt()));
    const want = checks.get(at);
    if (want !== undefined && !mismatch && snapshotHash(saveSnapshot(rt())) !== want) {
      mismatch = true;
      tell(currentFormat('replayMismatch', { time: clock(at) }));
    }
  }

  /** 无声跳转到第 `n` 帧，从不超过它的最近保留状态开始。 */
  function seek(n: number): void {
    n = Math.max(0, Math.min(total, n));
    if (n < at || n - at > KEEP_EVERY) {
      let from = 0;
      for (const f of kept.keys()) if (f <= n && f > from) from = f;
      if (from > at || n < at) {
        loadSnapshot(rt(), kept.get(from)!);
        at = from;
      }
    }
    while (at < n) advance();
    rt().soundEvents.length = 0;
    game.audio.resync(rt());
    carry = 0;
    if (!mismatch) note.hidden = true;
    draw();
  }

  const time = el('span', 'test-frame');
  const pause = button(currentText('pauseAction'), currentText('replayPauseHint'), () => setPaused(!paused));
  const back = button(currentText('back'), currentText('replayBackHint'), () => {
    setPaused(true);
    seek(at - 1);
  });
  const step = button(currentText('step'), currentText('replayStepHint'), () => {
    setPaused(true);
    if (at < total) advance();
    draw();
  });
  const rate = button('1x', currentText('replaySpeedHint'), () => {
    speed = (speed + 1) % SPEEDS.length;
    update();
  });
  const seekBar = el('input', 'replay-seek');
  seekBar.type = 'range';
  seekBar.min = '0';
  seekBar.max = String(total);
  seekBar.tabIndex = -1;
  seekBar.title = currentText('seekHint');
  seekBar.addEventListener('input', () => seek(Number(seekBar.value)));
  document.title = currentFormat('replayPrefix', { name: replayName(o.meta) });
  bar.append(time, seekBar, pause, back, step, rate, exit);

  /** 空格、左、右控制回放。返回该键是否被使用。 */
  function controls(key: string): boolean {
    if (o.video) return false;
    if (key === ' ') setPaused(!paused);
    else if (key === 'ArrowLeft') back.click();
    else if (key === 'ArrowRight') step.click();
    else return false;
    return true;
  }

  function setPaused(p: boolean): void {
    paused = p;
    if (!p && at >= total) seek(0);
    if (!p && !mismatch) note.hidden = true;
    update();
  }
  function update(): void {
    time.textContent = `${clock(at)} / ${clock(total)}`;
    pause.textContent = paused ? currentText('play') : currentText('pauseAction');
    rate.textContent = `${SPEEDS[speed]}x`;
    if (seekBar.value !== String(at)) seekBar.value = String(at);
    bar.classList.toggle('paused', paused);
  }
  /** 绘制当前帧，不重复播放声音。 */
  function draw(): void {
    rt().soundEvents.length = 0;
    game.renderer.render(rt());
    update();
  }

  stopLoop = startFixedLoop(
    () => {
      if (paused) return;
      carry += SPEEDS[speed];
      while (carry >= 1 && at < total) {
        advance();
        carry--;
      }
      if (at >= total) {
        paused = true;
        if (recorder) {
          if (recorder.state === 'recording') finishVideo();
        } else if (!mismatch) tell(currentText('endReplay'));
      }
    },
    () => {
      if (paused) draw();
      else {
        game.present();
        update();
      }
    },
  );
  let finishVideo = () => {};
  if (o.video) {
    // 录制画布和游戏声音时，整个回放以正常速度播放一次。
    const video = o.video;
    const quality = VIDEO_QUALITIES[video.quality];
    const type = videoType()!;
    for (const b of [seekBar, pause, back, step, rate]) b.hidden = true;
    bar.prepend(el('span', 'hud-line', currentFormat('replayRecording', { quality: video.quality })));
    exit.textContent = currentText('cancel');
    exit.title = currentText('cancelRecording');
    if (o.warning) tell(o.warning);
    video.setCanvasSize([quality.width, quality.height]);
    game.present();
    game.audio.resume();
    const tracks = [...game.canvas.captureStream(30).getVideoTracks(), ...game.audio.capture().getAudioTracks()];
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: quality.bitrate, audioBitsPerSecond: 160_000 });
    const chunks: Blob[] = [];
    let complete = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      for (const t of tracks) t.stop();
      if (!complete) return;
      video.done(new Blob(chunks, { type }), type.startsWith('video/mp4') ? 'mp4' : 'webm');
      o.onExit();
    };
    finishVideo = () => {
      complete = true;
      rec.stop();
    };
    rec.start(1000);
    recorder = rec;
  } else if (o.warning) {
    paused = true;
    tell(o.warning);
  }
  ready = true;
  update();
  game.present();
  return stop;
}
