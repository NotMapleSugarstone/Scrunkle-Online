// 通过 Web Audio 播放模拟中的声音事件。长声音（音乐）保持在
// 模拟时钟上，因此曲目会在游戏的“play until done”认为结束时准确结束，
// 即使在线游戏等待或跳帧，也能无缝循环，不会出现空隙或截断。
import type { SoundEvent } from '../engine/sound-model.ts';
import type { Runtime } from '../engine/runtime.ts';

const FADE_S = 0.025;
/** 至少这么长的声音会跟随模拟时钟。 */
const FOLLOW_MIN_S = 4;
export const SHORT_SOUND_S = 20;
/** 小于此值的漂移属于计时噪声，不处理。 */
const DEADBAND_S = 0.03;
/** 超过此值的漂移通过跳转修正，而不是稍微加快或放慢播放。 */
const SEEK_S = 0.35;
/** 每秒漂移对应的播放速率变化，以及最大变化量（1% 约等于六分之一个半音）。 */
const RATE_GAIN = 0.1;
const RATE_MAX = 0.01;
/** 连续呈现这么多帧且模拟没有推进后，后续声音暂停。 */
const HOLD_AFTER = 3;

interface Voice {
  buffer: AudioBuffer;
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  serial: number;
  volume: number;
  follow: boolean;
  /** 模拟请求的播放速率。 */
  rate: number;
  /** 模拟时间 `simAt`（毫秒）时的缓冲区位置（秒）。 */
  simPos: number;
  simAt: number;
  /** 音频时间 `realAt` 时的缓冲区位置（秒），以及实际播放速率。 */
  realPos: number;
  realAt: number;
  playRate: number;
  held: boolean;
}

export class AudioOut {
  ctx: AudioContext;
  private master: GainNode;
  private buffers: (AudioBuffer | null)[][] = [];
  private voices = new Map<string, Voice>();
  private lastSim = -1;
  private still = 0;
  muted = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }

  private files: string[][] = [];
  private base = '';
  private assetSuffix = '';
  /** 每个声音：0 未请求，1 已排队或加载中，2 已加载。 */
  private loadState: Uint8Array[] = [];
  private urgent: [number, number][] = [];
  private background: [number, number][] = [];
  private backgroundStarted = false;
  private loading = 0;
  /** 每个文件只解码一次，因为多个角色共享声音文件。 */
  private decoded = new Map<string, Promise<AudioBuffer>>();
  /** 尚未加载完成的声音的播放事件，按 voice key 索引。 */
  private pending = new Map<string, SoundEvent>();
  private onProgress?: (done: number, total: number) => void;
  private loaded = 0;
  private total = 0;

  /**
   * 在后台开始加载声音；项目中的声音超过一百兆字节。
   * 游戏在声音到达前播放它时，会优先加载该声音。长声音随后会从游戏
   * 时钟指示的位置开始，短声音仅在仍来得及播放时才播放。
   */
  startLoading(rt: Runtime, base: string, onProgress?: (done: number, total: number) => void, assetSuffix = ''): void {
    this.base = base;
    this.assetSuffix = assetSuffix;
    this.onProgress = onProgress;
    this.total = rt.sprites.reduce((n, s) => n + s.sounds.length, 0);
    this.files = rt.sprites.map((s) => s.sounds.map((d) => d.file));
    this.buffers = rt.sprites.map((s) => s.sounds.map(() => null));
    this.loadState = rt.sprites.map((s) => new Uint8Array(s.sounds.length));
    this.durations = rt.sprites.map((s) => s.sounds.map((d) => d.sampleCount / d.rate));
    this.backgroundStarted = false;
    this.background = [];
    this.pump();
  }

  prefetchShort(): void {
    if (this.backgroundStarted || this.loadState.length === 0) return;
    this.backgroundStarted = true;
    this.background = this.allJobs().filter(([si, i]) => this.durations[si][i] < SHORT_SOUND_S);
    this.pump();
  }

  private allJobs(): [number, number][] {
    const jobs = this.durations.flatMap((list, si) => list.map((_, i) => [si, i] as [number, number]));
    return jobs.sort((a, b) => this.durations[a[0]][a[1]] - this.durations[b[0]][b[1]]);
  }

  private durations: number[][] = [];

  /** 短音效的加载进度，用于进入游戏前的加载界面。 */
  shortProgress(): [number, number] {
    let done = 0;
    let total = 0;
    for (let si = 0; si < this.durations.length; si++) {
      const durations = this.durations[si];
      for (let i = 0; i < durations.length; i++) {
        if (durations[i] >= SHORT_SOUND_S) continue;
        total++;
        if (this.loadState[si]?.[i] === 2) done++;
      }
    }
    return [done, total];
  }

  /** 当所有短于 `seconds` 的声音加载完成或失败后完成。 */
  shortLoaded(seconds: number): Promise<void> {
    const ready = () => this.loadState.every((list, si) => list.every((st, i) => st === 2 || this.durations[si][i] >= seconds));
    return ready() ? Promise.resolve() : new Promise((r) => this.waiters.push(() => (ready() ? (r(), true) : false)));
  }

  /** 每个等待项在目标加载完成后返回 true，随后被移除。 */
  private waiters: (() => boolean)[] = [];

  private want(si: number, i: number): void {
    if (!this.loadState[si] || this.loadState[si][i] !== 0) return;
    this.loadState[si][i] = 1;
    this.urgent.push([si, i]);
    this.pump();
  }

  private pump(): void {
    while (this.loading < 6) {
      let job = this.urgent.shift();
      while (!job && this.background.length > 0) {
        const b = this.background.shift()!;
        if (this.loadState[b[0]][b[1]] === 0) {
          this.loadState[b[0]][b[1]] = 1;
          job = b;
        }
      }
      if (!job) return;
      const [si, i] = job;
      const file = this.files[si][i];
      this.loading++;
      let decoded = this.decoded.get(file);
      if (!decoded) {
        decoded = fetch(/^(blob|data|https?):/.test(file) ? file : `${this.base}${file}${this.assetSuffix}`)
          .then((res) => res.arrayBuffer())
          .then((data) => this.ctx.decodeAudioData(data));
        this.decoded.set(file, decoded);
      }
      void decoded
        .then((buf) => (this.buffers[si][i] = buf), () => (this.buffers[si][i] = null))
        .finally(() => {
          this.loadState[si][i] = 2;
          this.loading--;
          this.onProgress?.(++this.loaded, this.total);
          this.arrived(si, i);
          this.waiters = this.waiters.filter((w) => !w());
          if (this.loaded === this.total) for (const r of this.done.splice(0)) r();
          this.pump();
        });
    }
  }

  private done: (() => void)[] = [];

  /** 当所有声音加载完成或失败后完成。 */
  allLoaded(): Promise<void> {
    return this.loaded === this.total ? Promise.resolve() : new Promise((r) => this.done.push(r));
  }

  private arrived(si: number, i: number): void {
    const key = `${si}:${i}`;
    const e = this.pending.get(key);
    const buffer = this.buffers[si][i];
    this.pending.delete(key);
    if (!e || !buffer || this.muted) return;
    const lateMs = Math.max(0, this.lastSim - e.at);
    if (buffer.duration >= FOLLOW_MIN_S) {
      const offset = (lateMs / 1000) * e.rate;
      if (offset < buffer.duration) this.startVoice(key, e, buffer, offset);
    } else if (lateMs <= 150) this.startVoice(key, e, buffer, 0);
  }

  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  setVolume(v: number): void {
    this.master.gain.value = v;
  }

  private tap: MediaStreamAudioDestinationNode | null = null;

  /** 游戏播放的全部声音，作为用于录制视频的新音频流。`endCapture` 会停止向其中输入。 */
  capture(): MediaStream {
    this.endCapture();
    this.tap = this.ctx.createMediaStreamDestination();
    this.master.connect(this.tap);
    return this.tap.stream;
  }

  endCapture(): void {
    if (this.tap) this.master.disconnect(this.tap);
    this.tap = null;
  }

  /**
   * 停止所有声音，并从模拟当前所在的位置重新开始长声音，类似回放跳转到另一帧之后。
   * 已经在播放的短声音不再重新开始。
   */
  resync(rt: Runtime): void {
    this.stopAll();
    if (this.muted) return;
    const simMs = rt.currentMSecs;
    rt.players.forEach((list, si) =>
      list.forEach((p, i) => {
        const buffer = this.buffers[si]?.[i];
        if (!p.isPlaying || !buffer || buffer.duration < FOLLOW_MIN_S) return;
        const offset = (p.pos + (simMs - p.lastT) * p.rate) / 1000;
        if (offset < 0 || offset >= buffer.duration) return;
        const e: SoundEvent = { kind: 'play', sprite: si, sound: i, at: simMs, rate: p.rate, volume: p.owner?.volume ?? 100, pan: p.owner?.snd?.pan ?? 0, serial: p.serial };
        this.startVoice(`${si}:${i}`, e, buffer, offset);
        const v = this.voices.get(`${si}:${i}`)!;
        v.simPos = offset;
        v.simAt = simMs;
      }),
    );
  }

  /** 应用排队的事件并清空队列。 */
  apply(events: SoundEvent[]): void {
    for (const e of events) this.handle(e);
    events.length = 0;
  }

  /** 让后续声音跟随模拟时钟。每个呈现帧用模拟时间调用一次。 */
  sync(simMs: number): void {
    const now = this.ctx.currentTime;
    this.still = simMs === this.lastSim ? this.still + 1 : 0;
    this.lastSim = simMs;
    for (const v of this.voices.values()) {
      if (!v.follow) continue;
      if (this.still >= HOLD_AFTER) {
        // 游戏正在等待（通常是等待另一名玩家），因此音乐也等待。
        if (!v.held) this.hold(v, now);
        continue;
      }
      const want = expected(v, simMs);
      if (want >= v.buffer.duration) continue;
      if (v.held) {
        this.restart(v, want, now);
        continue;
      }
      const drift = actual(v, now) - want;
      if (Math.abs(drift) > SEEK_S) this.restart(v, want, now);
      else {
        const factor = Math.abs(drift) < DEADBAND_S ? 1 : 1 - Math.max(-RATE_MAX, Math.min(RATE_MAX, drift * RATE_GAIN));
        setPlayRate(v, v.rate * factor, now);
      }
    }
  }

  private handle(e: SoundEvent): void {
    const key = `${e.sprite}:${e.sound}`;
    const now = this.ctx.currentTime;
    if (e.kind === 'play') {
      this.fadeOut(key, now);
      this.pending.delete(key);
      const buffer = this.buffers[e.sprite]?.[e.sound];
      if (this.muted) return;
      if (!buffer) {
        if (this.loadState[e.sprite]?.[e.sound] !== 2) {
          this.pending.set(key, e);
          this.want(e.sprite, e.sound);
        }
        return;
      }
      this.startVoice(key, e, buffer, 0);
    } else if (e.kind === 'stop') {
      const p = this.pending.get(key);
      if (p && p.serial === e.serial) this.pending.delete(key);
      const v = this.voices.get(key);
      if (v && v.serial === e.serial) this.fadeOut(key, now);
    } else {
      const v = this.voices.get(key);
      if (!v) return;
      v.simPos = expected(v, e.at);
      v.simAt = e.at;
      v.rate = e.rate;
      setPlayRate(v, e.rate, now);
      v.volume = e.volume / 100;
      if (!v.held) v.gain.gain.value = v.volume;
      v.pan.pan.value = (e.pan ?? 0) / 100;
    }
  }

  private startVoice(key: string, e: SoundEvent, buffer: AudioBuffer, offset: number): void {
    const now = this.ctx.currentTime;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = (e.pan ?? 0) / 100;
    pan.connect(this.master);
    const v: Voice = {
      buffer,
      src: null as unknown as AudioBufferSourceNode,
      gain: null as unknown as GainNode,
      pan,
      serial: e.serial,
      volume: e.volume / 100,
      follow: buffer.duration >= FOLLOW_MIN_S,
      rate: e.rate,
      simPos: 0,
      simAt: e.at,
      realPos: 0,
      realAt: now,
      playRate: e.rate,
      held: false,
    };
    this.startSource(v, offset, now, offset > 0);
    this.voices.set(key, v);
  }

  /** 通过新的 source 和 gain，从 `offset` 秒处开始播放该声音的缓冲区。 */
  private startSource(v: Voice, offset: number, now: number, fadeIn: boolean): void {
    const src = this.ctx.createBufferSource();
    src.buffer = v.buffer;
    src.playbackRate.value = v.rate;
    const gain = this.ctx.createGain();
    if (fadeIn) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(v.volume, now + FADE_S);
    } else gain.gain.value = v.volume;
    src.connect(gain).connect(v.pan);
    src.start(now, offset);
    src.onended = () => {
      for (const [k, x] of this.voices) if (x === v && x.src === src && !x.held) this.voices.delete(k);
    };
    v.src = src;
    v.gain = gain;
    v.realPos = offset;
    v.realAt = now;
    v.playRate = v.rate;
  }

  private restart(v: Voice, offset: number, now: number): void {
    const old = { src: v.src, gain: v.gain };
    v.held = false;
    this.startSource(v, offset, now, true);
    fade(old.src, old.gain, now);
  }

  private hold(v: Voice, now: number): void {
    v.held = true;
    fade(v.src, v.gain, now);
  }

  private fadeOut(key: string, now: number): void {
    const v = this.voices.get(key);
    if (!v) return;
    this.voices.delete(key);
    fade(v.src, v.gain, now);
  }

  /** 淡出一个声音，用于修正移除了已经开始的声音时。 */
  stopSound(sprite: number, sound: number): void {
    this.fadeOut(`${sprite}:${sound}`, this.ctx.currentTime);
  }

  /** 停止所有声音，用于回滚替换时间线时。 */
  stopAll(): void {
    const now = this.ctx.currentTime;
    this.pending.clear();
    for (const key of [...this.voices.keys()]) this.fadeOut(key, now);
  }
}

function expected(v: Voice, simMs: number): number {
  return v.simPos + ((simMs - v.simAt) / 1000) * v.rate;
}

function actual(v: Voice, now: number): number {
  return v.realPos + (now - v.realAt) * v.playRate;
}

function setPlayRate(v: Voice, rate: number, now: number): void {
  if (Math.abs(rate - v.playRate) < 1e-5) return;
  v.realPos = actual(v, now);
  v.realAt = now;
  v.playRate = rate;
  v.src.playbackRate.value = rate;
}

function fade(src: AudioBufferSourceNode, gain: GainNode, now: number): void {
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0, now + FADE_S);
  try {
    src.stop(now + FADE_S);
  } catch {
    // 已停止
  }
}
