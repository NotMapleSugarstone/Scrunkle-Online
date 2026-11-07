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
import { assetCacheSuffix } from '../game/page.ts';
import { WebGLRenderer } from '../render/webgl.ts';
import { EFFECT_BITS } from '../render/shaders.ts';
import { AudioOut, SHORT_SOUND_S } from './audio.ts';
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
async function loadMasks(suffix = ''): Promise<MaskSet> {
  const res = await fetch(`${maskUrl}${suffix}`);
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
  private modePrefetching = false;
  private lastFighters = '';
  private fighterSkins = new Map<number, number[]>();
  private base: number[] | null = null;

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
   * 加载接触遮罩并编译着色器；纹理、声音和音乐由 `startPrefetch` 与按需加载负责。
   * `load` 只等待启动所需资源，使大厅先出现；实际比赛开始再由 `preloadForFight` 等待图像。
   */
  async load(onProgress: (done: number, total: number) => void): Promise<void> {
    const counts = { images: [0, skins.length], sounds: [0, this.rt.sprites.reduce((n, s) => n + s.sounds.length, 0)] };
    const report = () => onProgress(counts.images[0] + counts.sounds[0], counts.images[1] + counts.sounds[1]);
    const suffix = assetCacheSuffix();
    this.renderer.startLoading(ASSET_BASE, GAME_EFFECTS, (d, n) => ((counts.images = [d, n]), report()), suffix);
    this.audio.startLoading(this.rt, ASSET_BASE, (d, n) => ((counts.sounds = [d, n]), report()), suffix);
    masks = await loadMasks(suffix);
    installSilhouettes(this.rt, masks);
  }

  startPrefetch(): void {
    if (this.prefetching) return;
    this.prefetching = true;
    this.audio.prefetchShort();
    // 共用素材和模式素材只填充空闲队列；当前菜单、斗士和过场会抢占它们。
    this.renderer.loadLater(this.baseSkins());
    this.prefetchSelection();
    this.prefetchModeAssets();
  }

  /**
   * 进入游戏前等待共用图像和短音效加载完毕；长音乐仍在播放时按需加载。
   * `onProgress` 同时统计图像和短音效，供等待进度回调使用。
   */
  async preloadForPlay(onProgress: (done: number, total: number) => void): Promise<void> {
    this.startPrefetch();
    const ids = this.fighterIds();
    const skins = [...new Set([
      ...this.baseSkins(),
      ...this.fighterSkinsFor(ids),
      ...this.cutsceneSkinsFor(ids),
    ])];
    let imageDone = 0;
    let imageTotal = skins.length;
    const report = () => {
      const [soundDone, soundTotal] = this.audio.shortProgress();
      onProgress(imageDone + soundDone, imageTotal + soundTotal);
    };
    const timer = window.setInterval(report, 100);
    try {
      await Promise.all([
        this.renderer.loadNow(skins, (done, total) => {
          imageDone = done;
          imageTotal = total;
          report();
        }),
        this.audio.shortLoaded(SHORT_SOUND_S),
      ]);
    } finally {
      window.clearInterval(timer);
      report();
    }
  }

  /** 实际比赛开始前只等待当前画面、斗士和其过场帧；共用素材继续在后台加载。 */
  async preloadForFight(onProgress: (done: number, total: number) => void): Promise<void> {
    this.startPrefetch();
    const ids = this.fighterIds();
    const skins = [...new Set([
      ...this.visibleSkins(),
      ...this.fighterSkinsFor(ids),
      ...this.cutsceneSkinsFor(ids),
    ])];
    await this.renderer.loadNow(skins, onProgress);
  }

  /**
   * 进入离线游戏前只等待当前菜单实际可见的图像，避免收起大厅后先出现空白画面。
   * 其余菜单、模式和过场素材仍在后台预取。
   */
  async preloadCurrentView(onProgress: (done: number, total: number) => void): Promise<void> {
    await this.renderer.loadNow(this.visibleSkins(), onProgress);
  }

  /**
   * 过场开始时等待全部过场帧。它们通常已由 `prefetchModeAssets` 在后台排队，
   * 因此缓存命中时无需等待；冷缓存时也不会先画出缺帧的第一帧。
   */
  async preloadForCutscene(onProgress: (done: number, total: number) => void): Promise<void> {
    this.startPrefetch();
    await this.renderer.loadNow(this.allCutsceneSkins(), onProgress);
  }

  /**
   * 所有模式都可能用到的非角色图像：全部过场帧、MenuUI 的模式画面和训练用的 Hitbox Engine。
   * 不包含任何斗士造型；角色仍按当前选择加载，避免把所有 2,180 张斗士图塞进启动队列。
   */
  private prefetchModeAssets(): void {
    if (this.modePrefetching) return;
    this.modePrefetching = true;
    const add = [...new Set([
      ...this.allCutsceneSkins(),
      ...this.menuModeSkins(),
      ...this.stageModeSkins(),
      ...this.hitboxSkins(),
    ])];
    if (add.length > 0) this.renderer.loadLater(add);
  }

  /** 全部过场帧；关闭过场时不排队。 */
  private allCutsceneSkins(): number[] {
    if (!this.cutscenesEnabled()) return [];
    const sprite = this.rt.sprites.find((s) => s.name === 'cutscene');
    return sprite ? sprite.costumes.map((c) => c.skin) : [];
  }

  /** 当前可见目标使用的图像；舞台本身不在 drawList 中，因此单独加入。 */
  private visibleSkins(): number[] {
    const out: number[] = [];
    for (const t of this.rt.drawList) {
      if (!t.visible) continue;
      const c = t.sprite.costumes[t.currentCostume];
      if (c) out.push(c.skin);
    }
    const stage = this.rt.stage as unknown as { sprite: { costumes: { skin: number }[] }; currentCostume: number };
    const backdrop = stage.sprite.costumes[stage.currentCostume];
    if (backdrop) out.push(backdrop.skin);
    return [...new Set(out)];
  }

  /** MenuUI 的模式画面、塔、经典模式、故事、训练和设置界面。 */
  private menuModeSkins(): number[] {
    const sprite = this.rt.sprites.find((s) => s.name === 'MenuUI');
    return sprite ? sprite.costumes.map((c) => c.skin) : [];
  }

  /** 故事、塔、大厅、教程等模式使用的舞台背景；不只包括 stage* 战斗背景。 */
  private stageModeSkins(): number[] {
    const sprite = this.rt.sprites.find((s) => s.name === 'Stage');
    return sprite ? sprite.costumes.map((c) => c.skin) : [];
  }

  /** 训练模式的碰撞盒/高级判定显示。 */
  private hitboxSkins(): number[] {
    const sprite = this.rt.sprites.find((s) => s.name === 'Hitbox Engine');
    return sprite ? sprite.costumes.map((c) => c.skin) : [];
  }

  /** 菜单、舞台、UI、特效的共用图像；角色图像和过场帧按当前选择加载。 */
  private baseSkins(): number[] {
    if (this.base) return this.base;
    const out: number[] = [];
    for (const sprite of this.rt.sprites) {
      if (sprite.def.isStage) {
        for (const c of sprite.costumes) if (/^stage/.test(c.name)) out.push(c.skin);
      } else if (sprite.name === 'MenuUI') {
        for (const c of sprite.costumes) if (/^(portrait|stagei|GameSelect)/.test(c.name)) out.push(c.skin);
      } else if (sprite.name === 'costumes') {
        for (const c of sprite.costumes) if (!/^\d/.test(c.name)) out.push(c.skin);
      } else if (MENU_SPRITES.has(sprite.name) || sprite.name === 'Stage' || sprite.name === 'Players' || sprite.name === 'FX' || sprite.name === 'meow') {
        for (const c of sprite.costumes) out.push(c.skin);
      }
    }
    this.base = [...new Set(out)];
    return this.base;
  }

  /**
   * 有必杀过场的角色由 `starting_frames` 指定；`P_Char` 是 1 起始的索引。
   * 比赛只取当前斗士的帧；全部过场帧由模式预取在后台排队。
   * 设置中关闭过场动画时不加载这些帧。
   */
  private cutsceneSkinsFor(ids: number[], all = false): number[] {
    if (!this.cutscenesEnabled()) return [];
    const stage = this.rt.stage as unknown as { l: { starting_frames?: (number | string)[] } };
    const starters = (stage.l.starting_frames ?? []).map((frame) => String(frame));
    const candidates = all ? starters : ids.map((id) => starters[id - 1]);
    const prefixes = candidates.filter((prefix): prefix is string => Boolean(prefix));
    if (prefixes.length === 0) return [];
    const sprite = this.rt.sprites.find((s) => s.name === 'cutscene');
    if (!sprite) return [];
    return sprite.costumes
      .filter((c) => prefixes.some((prefix) => c.name.startsWith(prefix)))
      .map((c) => c.skin);
  }

  private cutscenesEnabled(): boolean {
    const stage = this.rt.stage as unknown as { l: { Global_GameSettings?: (number | string)[] } };
    return String(stage.l.Global_GameSettings?.[4] ?? '0') === '0';
  }

  /** 当前角色选择；变化时本地循环会先等待新角色图像再呈现。 */
  fighterKey(): string {
    return this.fighterIds().join(',');
  }

  /** 必杀/故事过场是否正在播放。 */
  cutsceneActive(): boolean {
    const stage = this.rt.stage as unknown as { v: { active_cutscene?: number | string } };
    return String(stage.v.active_cutscene ?? '0') === '1';
  }

  /** 当前过场编号；切换过场时本地循环会重新确认图像已就绪。 */
  cutsceneKey(): string {
    const stage = this.rt.stage as unknown as { v: { active_cutscene?: number | string; Cutscene_Num?: number | string } };
    return `${String(stage.v.active_cutscene ?? '0')}:${String(stage.v.Cutscene_Num ?? '0')}`;
  }

  private prefetchSelection(): void {
    const ids = this.fighterIds();
    const key = ids.join(',');
    if (key === this.lastFighters) return;
    this.lastFighters = key;
    const add = [...new Set([...this.fighterSkinsFor(ids), ...this.cutsceneSkinsFor(ids)])];
    if (add.length > 0) void this.renderer.loadNow(add);
  }

  private fighterIds(): number[] {
    const stage = this.rt.stage as unknown as { l: { P_Char?: (number | string)[] } };
    return [...new Set((stage.l.P_Char ?? []).map(Number))]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
  }

  private fighterSkinsFor(ids: number[]): number[] {
    if (this.fighterSkins.size === 0) this.collectFighterSkins();
    const add: number[] = [];
    for (const id of ids) add.push(...(this.fighterSkins.get(id) ?? []));
    return [...new Set(add)];
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
