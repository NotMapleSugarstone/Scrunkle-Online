// 持有一个模拟及其全部呈现组件：渲染器、音频和覆盖层。
import { Runtime, FRAME_MS } from '../engine/runtime.ts';
import type { PlayerInput } from '../engine/io.ts';
import { effectsUsed, modules, monitors } from '../game/generated/index.ts';
import { skins } from '../game/assets.ts';
import { installSilhouettes } from '../game/silhouettes.ts';
import { decodeMaskSet, type MaskSet } from '../engine/masks.ts';
import maskUrl from '../game/masks.bin?url';
import { pauseRule } from '../game/pause.ts';
import { CODE_ANSWERS, HIDDEN_LISTS } from '../game/saves.ts';
import { WebGLRenderer } from '../render/webgl.ts';
import { EFFECT_BITS } from '../render/shaders.ts';
import { AudioOut } from './audio.ts';
import { Bubbles, ListMonitors, PauseMenu, QuestionBox, VarMonitors } from './overlays.ts';

export const ASSET_BASE = `${import.meta.env.BASE_URL}assets/`;

const MENU_SPRITES = new Set(['UI', 'Transition', 'Text', 'Border']);

/**
 * 游玩前预编译的着色器效果组合：游戏使用的颜色、亮度和幽灵效果的每种组合，
 * 以及与其搭配使用的形状效果。较少见的组合会在首次绘制时编译。
 */
const GAME_EFFECTS = (() => {
  const used = (name: keyof typeof EFFECT_BITS) => (effectsUsed.includes(name) ? EFFECT_BITS[name] : 0);
  const tints = [used('color'), used('brightness'), used('ghost')].filter(Boolean);
  const shapes = [0, ...[used('whirl'), used('fisheye'), used('pixelate'), used('mosaic')].filter(Boolean)];
  const out = new Set<number>();
  for (const shape of shapes) for (let m = 0; m < 1 << tints.length; m++) out.add(tints.reduce((b, t, i) => (m & (1 << i) ? b | t : b), shape));
  out.delete(0);
  return [...out];
})();

/** 获取并解压接触遮罩。 */
async function loadMasks(): Promise<MaskSet> {
  const res = await fetch(maskUrl);
  if (!res.ok || !res.body) throw new Error(`masks: HTTP ${res.status}`);
  const plain = res.body.pipeThrough(new DecompressionStream('gzip'));
  return decodeMaskSet(new Uint8Array(await new Response(plain).arrayBuffer()));
}

/** 遮罩；首次加载后创建的所有运行时共享。 */
let masks: MaskSet | null = null;

export interface GameOptions {
  seed: number;
  /** 模拟开始时间；也驱动日期积木。 */
  t0: number;
}

export class Game {
  rt: Runtime;
  renderer: WebGLRenderer;
  audio: AudioOut;
  question: QuestionBox;
  lists: ListMonitors;
  vars: VarMonitors;
  bubbles: Bubbles;
  /** 移植版的暂停菜单，用于带暂停规则的游戏。 */
  pause: PauseMenu | null;
  private prefetching = false;
  private lastFighters = '';
  private fighterSkins = new Map<number, number[]>();
  private effectsQueued = false;

  constructor(
    public canvas: HTMLCanvasElement,
    public overlay: HTMLElement,
    opts: GameOptions,
  ) {
    this.rt = Game.createRuntime(opts);
    this.renderer = new WebGLRenderer(canvas, skins);
    this.audio = new AudioOut();
    this.question = new QuestionBox(overlay);
    this.question.allowFiles = CODE_ANSWERS;
    const hidden = new Set(HIDDEN_LISTS.map((name) => this.rt.stage.sprite.def.listNames?.[name]));
    this.lists = new ListMonitors(overlay, { ...monitors, lists: monitors.lists.filter((d) => !hidden.has(d.prop)) });
    this.vars = new VarMonitors(overlay, monitors);
    this.bubbles = new Bubbles(overlay);
    this.pause = pauseRule ? new PauseMenu(overlay, pauseRule) : null;
  }

  /** 安装遮罩并点击绿旗后的运行时。遮罩必须已加载。 */
  static createRuntime(opts: GameOptions): Runtime {
    const rt = new Runtime(modules, skins, { seed: opts.seed, t0: opts.t0, pause: pauseRule });
    rt.stampOwners = new WeakMap();
    if (masks) installSilhouettes(rt, masks);
    rt.greenFlag();
    return rt;
  }

  /**
   * 在游玩前加载接触遮罩、所有带纹理的图像和所有短声音，如同原版在开始前加载整个项目。
   * 否则菜单和开场会在图像到达前绘制空白帧。音乐在开始游玩后继续加载。
   */
  async load(onProgress: (done: number, total: number) => void): Promise<void> {
    const counts = { images: [0, skins.length], sounds: [0, this.rt.sprites.reduce((n, s) => n + s.sounds.length, 0)] };
    const report = () => onProgress(counts.images[0] + counts.sounds[0], counts.images[1] + counts.sounds[1]);
    this.renderer.startLoading(ASSET_BASE, GAME_EFFECTS, (d, n) => ((counts.images = [d, n]), report()));
    this.audio.startLoading(this.rt, ASSET_BASE, (d, n) => ((counts.sounds = [d, n]), report()));
    masks = await loadMasks();
    installSilhouettes(this.rt, masks);
  }

  startPrefetch(): void {
    if (this.prefetching) return;
    this.prefetching = true;
    this.audio.prefetchShort();
    const menu: number[] = this.rt.stage.sprite.costumes.filter((c) => /^stage/.test(c.name)).map((c) => c.skin);
    for (const sprite of this.rt.sprites) {
      if (sprite.def.isStage) continue;
      if (sprite.name === 'MenuUI') {
        for (const c of sprite.costumes) if (/^(portrait|stagei|GameSelect)/.test(c.name)) menu.push(c.skin);
      } else if (MENU_SPRITES.has(sprite.name)) {
        for (const c of sprite.costumes) menu.push(c.skin);
      } else if (sprite.name === 'costumes') {
        for (const c of sprite.costumes) if (!/^\d/.test(c.name)) menu.push(c.skin);
      }
    }
    void this.renderer.loadNow(menu);
    this.prefetchSelection();
  }

  private prefetchSelection(): void {
    const stage = this.rt.stage as unknown as { l: { P_Char?: (number | string)[] } };
    const list = stage.l.P_Char ?? [];
    const ids = [...new Set([Number(list[0]), Number(list[1])])]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const key = ids.join(',');
    if (key === this.lastFighters) return;
    this.lastFighters = key;
    if (ids.length === 0) return;
    if (this.fighterSkins.size === 0) this.collectFighterSkins();
    const add: number[] = [];
    for (const id of ids) add.push(...(this.fighterSkins.get(id) ?? []));
    if (!this.effectsQueued) {
      this.effectsQueued = true;
      for (const sprite of this.rt.sprites) if (sprite.name === 'FX') for (const c of sprite.costumes) add.push(c.skin);
    }
    if (add.length > 0) void this.renderer.loadNow(add);
  }

  private collectFighterSkins(): void {
    const sprite = this.rt.sprites.find((s) => s.name === 'costumes');
    if (!sprite) return;
    for (const c of sprite.costumes) {
      const id = Number(/^(\d+)/.exec(c.name)?.[1]);
      if (!Number.isFinite(id)) continue;
      const list = this.fighterSkins.get(id);
      if (list) list.push(c.skin);
      else this.fighterSkins.set(id, [c.skin]);
    }
  }

  step(inputs: PlayerInput[]): void {
    this.rt.stepFrame(inputs);
  }

  present(): void {
    this.audio.apply(this.rt.soundEvents);
    this.audio.sync(this.rt.currentMSecs);
    this.renderer.render(this.rt);
    this.question.update(this.rt);
    this.lists.update(this.rt);
    this.vars.update(this.rt);
    this.bubbles.update(this.rt);
    this.pause?.update(this.rt);
    if (this.prefetching) this.prefetchSelection();
  }
}

/** 在 Worker 中运行，每 4 毫秒发送一条消息，使后台标签页也能持续收到。 */
const HEARTBEAT = 'const beat = () => { postMessage(0); setTimeout(beat, 4); }; beat();';

/** 帧可以提前开始的量，避免屏幕刷新抖动把帧推到下一次刷新。 */
const SLACK_MS = 4;
/** 帧迟到多久后由心跳运行；该值大于 50 Hz 以上刷新间隔。 */
const LATE_MS = 25;

/**
 * 每帧调用一次 `tick`，间隔与原版一样为 FRAME_MS；只要运行过帧，随后调用一次 `after`。
 * 屏幕刷新驱动循环，因此每帧从一次刷新开始并保持均匀间隔。后台标签页会停止动画帧，
 * 某些屏幕也会变慢，因此 Worker 心跳会运行迟到 LATE_MS 的帧，或在刷新停止后运行到期帧，
 * 让在线比赛继续。
 */
export function startFixedLoop(tick: () => void, after: () => void): () => void {
  const clock = () => performance.timeOrigin + performance.now();
  let next = clock() + FRAME_MS;
  let stopped = false;
  const run = (now: number) => {
    // 长时间卡顿后，循环会跳过遗漏的帧，而不是一次性补播。
    if (now - next > 250) next = now;
    let ran = false;
    while (now >= next - SLACK_MS) {
      tick();
      next += FRAME_MS;
      ran = true;
    }
    if (ran) after();
  };
  let raf = 0;
  let lastRefresh = 0;
  const refresh = (ts: number) => {
    if (stopped) return;
    lastRefresh = clock();
    run(performance.timeOrigin + ts);
    raf = requestAnimationFrame(refresh);
  };
  raf = requestAnimationFrame(refresh);
  const beat = () => {
    const now = clock();
    if (!stopped && now > next + (now - lastRefresh < 100 ? LATE_MS : 0)) run(now);
  };
  let heard = false;
  let timer = 0;
  const worker = new Worker(URL.createObjectURL(new Blob([HEARTBEAT], { type: 'text/javascript' })));
  worker.onmessage = () => {
    heard = true;
    beat();
  };
  // 某些嵌入式浏览器无法启动由 blob 创建的 Worker。此时使用页面自身的定时器
  // 提供心跳，尽管标签页在后台时它们会变慢。
  const fallback = window.setTimeout(() => {
    if (heard || stopped) return;
    worker.terminate();
    const loop = () => {
      beat();
      if (!stopped) timer = window.setTimeout(loop, 4);
    };
    loop();
  }, 500);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    worker.terminate();
    clearTimeout(fallback);
    clearTimeout(timer);
  };
}
