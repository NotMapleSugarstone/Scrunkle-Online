// 移植版的 WebGL 渲染器。它遵循原渲染器的规则：矢量造型按
// 2 的幂次比例栅格化，位图使用最近邻采样，画笔图层是一张
// 舞台大小的纹理并用最近邻显示，效果在片元着色器中运行。
import { STAGE_H, STAGE_W, STAGE_X, STAGE_Y, type SkinDef } from '../engine/defs.ts';
import type { PenCmd, Runtime, Tint } from '../engine/runtime.ts';
import { RenderModel } from '../engine/render-model.ts';
import { cos, sin } from '../engine/dmath.ts';
import type { Effects } from '../engine/target.ts';
import { EFFECT_BITS, FRAGMENT, POST_VERTEX, QUANTIZE, UPSCALE, VERTEX } from './shaders.ts';

const NATIVE_W = STAGE_W;
const NATIVE_H = STAGE_H;
/** 旧 Flash 游戏显示模式中一个像素对应的舞台像素数。 */
const FLASH_DIVISOR = 2;
/** 矢量造型手持图像的纹理缓存级别，不使用 2 的幂次 mip。 */
const HANDHELD_LEVEL = -1;

/**
 * 舞台如何显示到屏幕。`smooth` 按原版以屏幕分辨率绘制。`flash` 按舞台大小绘制，
 * 减半、抖动到 256 色再放大。`handheld` 在小于舞台的网格上绘制（`handheldScale`），
 * 将每个矢量造型按同一比例栅格化一次，使正常大小的造型每个网格像素一个纹素，
 * 所有造型都用最近邻采样，然后放大结果。
 */
export type DisplayMode = 'smooth' | 'flash' | 'handheld';

/** 从 `from` 开始的画笔命令，按绘制所需的顺序和形式表示，用于只改变画面的选项。 */
export type PenView = (rt: Runtime, cmds: readonly PenCmd[], from: number) => readonly PenCmd[];

/** 显示模式绘制到的离屏图像。 */
interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}
/** 平滑图章在每个绘制帧覆盖剩余距离的比例，以及一次跳转的距离（舞台单位）。 */
const SMOOTH_RATE = 0.45;
const SMOOTH_SNAP = 90;
const MIP_OFFSET = 8;

interface Program {
  prog: WebGLProgram;
  uni: Map<string, WebGLUniformLocation | null>;
  aPos: number;
  aTex: number;
}

/** 绘制一个可绘制对象所需的数据：皮肤、变换和效果。 */
export interface DrawState {
  skin: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  dir: number;
  fx: Effects;
  tint?: Tint | null;
}

function ortho(left: number, right: number, bottom: number, top: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = 2 / (-1 - 1);
  m[12] = (right + left) / (left - right);
  m[13] = (top + bottom) / (bottom - top);
  m[14] = (1 + -1) / (-1 - 1);
  m[15] = 1;
  return m;
}

function effectBits(fx: Effects): number {
  let b = 0;
  if (fx.color) b |= EFFECT_BITS.color;
  if (fx.fisheye) b |= EFFECT_BITS.fisheye;
  if (fx.whirl) b |= EFFECT_BITS.whirl;
  if (fx.pixelate) b |= EFFECT_BITS.pixelate;
  if (fx.mosaic) b |= EFFECT_BITS.mosaic;
  if (fx.brightness) b |= EFFECT_BITS.brightness;
  if (fx.ghost) b |= EFFECT_BITS.ghost;
  return b;
}

export class WebGLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGLRenderingContext;
  private skins: SkinDef[];
  private geom: RenderModel;
  private images: (HTMLImageElement | ImageBitmap | null)[];
  /** 按皮肤索引：mip 级别 -> 纹理（矢量），或索引 0 处的单一纹理（位图）。 */
  private textures: Map<number, WebGLTexture | null>[];
  private programs = new Map<string, Program>();
  private quadPos: WebGLBuffer;
  private quadTex: WebGLBuffer;
  private linePos: WebGLBuffer;
  private penTex: WebGLTexture;
  private penFbo: WebGLFramebuffer;
  /** 画笔图层大小，以像素计：480x360，或开启高质量画笔时的画布大小。 */
  private penW = NATIVE_W;
  private penH = NATIVE_H;
  /** 以画布分辨率而非 480x360 绘制画笔图层，使舞台放大时画笔线条和图章保持清晰。 */
  hqPen = false;
  /**
   * 这些皮肤的画笔图章会平滑移向目标位置，而不是直接画在那里。在线时其他玩家的
   * 选择光标使用此功能，因为回滚修正会让它们向后跳。只改变画面，绝不改变模拟。
   */
  smoothSkins = new Set<number>();
  private smoothed = new Map<number, { x: number; y: number }>();
  private penView: PenView | null = null;
  /** 画笔图层上因图像尚未加载而未绘制任何内容的图章皮肤。 */
  private penMissing = new Set<number>();
  private penArr: PenCmd[] | null = null;
  private penDrawn = 0;
  private penEpoch = -1;
  private emptyTex: WebGLTexture;
  private mipCanvas = new Map<number, HTMLCanvasElement>();
  private display: DisplayMode = 'smooth';
  private targets = new Map<string, Target>();
  /** 手持模式的网格和矢量造型大小相对舞台的比例：0.75 将 640x360 舞台绘制为 480x270。 */
  handheldScale = 0.75;
  /** 所有手持图像共用一个画布，使每个造型的 mip 画布保持原版的回读顺序。 */
  private handheldCanvas: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement, skins: SkinDef[]) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { alpha: false, stencil: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.skins = skins;
    this.geom = new RenderModel(skins);
    this.images = skins.map(() => null);
    this.textures = skins.map(() => new Map());

    this.quadPos = this.buffer([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5]);
    this.quadTex = this.buffer([1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1]);
    this.linePos = this.buffer([1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1]);

    this.emptyTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.texParams();

    this.penTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.penTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NATIVE_W, NATIVE_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.penFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.penFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.penTex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private buffer(data: number[]): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return b;
  }

  private texParams(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  // ---------------------------------------------------------------- 资源

  private base = '';
  /** 按皮肤索引：0 未请求，1 已排队或加载中，2 已加载。 */
  private loadState: Uint8Array = new Uint8Array(0);
  private urgent: number[] = [];
  private immediate: number[] = [];
  private nextBackground = 0;
  private loading = 0;
  private loaded = 0;
  private onProgress?: (done: number, total: number) => void;

  /**
   * 从 `base`（资源文件夹的 URL 前缀）开始加载造型图像，并为 `effects` 编译着色器。
   * 每张图像到达时创建其纹理，因此首次显示它的帧无需解码或上传。图像到达前就被绘制的皮肤
   * 会接下来加载，在此之前绘制为空白。
   */
  startLoading(base: string, effects: number[], onProgress?: (done: number, total: number) => void): void {
    this.base = base;
    this.onProgress = onProgress;
    this.loadState = new Uint8Array(this.skins.length);
    for (const bits of [0, ...effects]) this.program(false, bits);
    this.program(true, 0);
    this.nextBackground = this.skins.length;
    this.pump();
  }

  /** 给定皮肤加载完成后 resolve，用于首屏。 */
  loadNow(skins: number[]): Promise<void> {
    for (const i of skins) this.want(i);
    return new Promise((resolve) => {
      const check = () => !skins.some((i) => this.loadState[i] !== 2) && (resolve(), true);
      if (!check()) this.waiters.push(check);
    });
  }

  /** 每个在其皮肤加载完成后返回 true，随后被移除。 */
  private waiters: (() => boolean)[] = [];

  /**
   * 按画布当前比例制作皮肤纹理，方法是将它绘制到一个像素中，使驱动现在上传图像，
   * 而不是等到首次显示它的帧。矢量皮肤获得其正常大小对应的 mip，其他大小在首次绘制时制作，
   * 与原版一致。
   */
  private prepare(i: number): void {
    const gl = this.gl;
    const f = this.display === 'smooth' ? Math.max(this.canvas.width / NATIVE_W, this.canvas.height / NATIVE_H, 1) : 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 1, 1);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 1, 1);
    const fx = { color: 0, fisheye: 0, whirl: 0, pixelate: 0, mosaic: 0, brightness: 0, ghost: 0 };
    this.drawSprite({ skin: i, x: 0, y: 0, sx: 100, sy: 100, dir: 90, fx }, this.stageProj, f, f);
    gl.disable(gl.SCISSOR_TEST);
  }

  private want(i: number, priority = false): void {
    if (this.loadState.length === 0 || this.loadState[i] !== 0) return;
    this.loadState[i] = 1;
    (priority ? this.immediate : this.urgent).push(i);
    this.pump();
  }

  private pump(): void {
    while (this.loading < 16) {
      let i = this.immediate.shift();
      if (i === undefined) i = this.urgent.shift();
      if (i === undefined) {
        while (this.nextBackground < this.skins.length && this.loadState[this.nextBackground] !== 0) this.nextBackground++;
        if (this.nextBackground >= this.skins.length) return;
        i = this.nextBackground++;
        this.loadState[i] = 1;
      }
      const idx = i;
      const file = this.skins[idx].file;
      this.loading++;
      loadImage(/^(blob|data|https?):/.test(file) ? file : `${this.base}${file}`)
        .then((img) => (this.images[idx] = img), () => (this.images[idx] = null))
        .finally(() => {
          if (this.images[idx]) this.prepare(idx);
          this.loadState[idx] = 2;
          this.loading--;
          this.loaded++;
          this.onProgress?.(this.loaded, this.skins.length);
          this.waiters = this.waiters.filter((w) => !w());
          this.pump();
        });
    }
  }

  /** 皮肤在绘制比例（百分比）下的纹理，按需创建矢量 mip。 */
  private skinTexture(skinIdx: number, scaleX: number, scaleY: number): WebGLTexture {
    const skin = this.skins[skinIdx];
    const img = this.images[skinIdx];
    if (!img) {
      this.want(skinIdx, true);
      return this.emptyTex;
    }
    const gl = this.gl;
    const cache = this.textures[skinIdx];
    let level = 0;
    let mipScale = 1;
    if (skin.kind === 'svg' && this.display === 'handheld') level = HANDHELD_LEVEL;
    else if (skin.kind === 'svg') {
      const requested = Math.min(Math.max(Math.abs(scaleX), Math.abs(scaleY)) / 100, skin.maxScale);
      level = Math.max(Math.ceil(Math.log2(requested)) + MIP_OFFSET, 0);
      mipScale = Math.pow(2, level - MIP_OFFSET);
    }
    const hit = cache.get(level);
    if (hit !== undefined) return hit ?? this.emptyTex;
    let source: TexImageSource | ImageData = img;
    if (level === HANDHELD_LEVEL) {
      if (skin.w <= 0 || skin.h <= 0) {
        cache.set(level, null);
        return this.emptyTex;
      }
      // 每边为整数像素，绘制时拉伸以填满造型框。
      const c = (this.handheldCanvas ??= document.createElement('canvas'));
      c.width = Math.max(1, Math.round(skin.w * this.handheldScale));
      c.height = Math.max(1, Math.round(skin.h * this.handheldScale));
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(c.width / skin.w, 0, 0, c.height / skin.h, 0, 0);
      ctx.drawImage(img, 0, 0);
      source = ctx.getImageData(0, 0, c.width, c.height);
    } else if (skin.kind === 'svg') {
      // 每个造型一个画布，按原渲染器的顺序用于其 mip：
      // 浏览器在几次回读后会把画布交给 CPU 栅格化器，其抗锯齿结果不同。
      let c = this.mipCanvas.get(skinIdx);
      if (!c) {
        c = document.createElement('canvas');
        this.mipCanvas.set(skinIdx, c);
      }
      c.width = skin.w * mipScale;
      c.height = skin.h * mipScale;
      if (c.width <= 0 || c.height <= 0) {
        cache.set(level, null);
        return this.emptyTex;
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(mipScale, 0, 0, mipScale, 0, 0);
      ctx.drawImage(img, 0, 0);
      source = ctx.getImageData(0, 0, c.width, c.height);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.texParams();
    cache.set(level, tex);
    return tex;
  }

  private useNearest(skin: SkinDef, d: DrawState, scaleX: number, scaleY: number): boolean {
    if (skin.kind === 'bitmap' || this.display === 'handheld') return true;
    if (d.fx.fisheye || d.fx.whirl || d.fx.pixelate || d.fx.mosaic) return false;
    if (d.dir % 90 !== 0) return false;
    const ax = Math.abs(scaleX);
    const ay = Math.abs(scaleY);
    return ax > 99 && ax < 101 && ay > 99 && ay < 101;
  }

  // ---------------------------------------------------------------- 程序

  private program(line: boolean, bits: number): Program {
    const key = `${line ? 'L' : 'S'}${bits}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const defs: string[] = [];
    if (line) defs.push('#define LINE');
    for (const [name, bit] of Object.entries(EFFECT_BITS)) if (bits & bit) defs.push(`#define ENABLE_${name}`);
    const head = `${defs.join('\n')}\n`;
    const p = this.link(head + VERTEX, head + FRAGMENT);
    this.programs.set(key, p);
    return p;
  }

  /** 显示模式通道使用的程序，首次使用时编译。 */
  private postProgram(fragment: string): Program {
    const cached = this.programs.get(fragment);
    if (cached) return cached;
    const p = this.link(POST_VERTEX, fragment);
    this.programs.set(fragment, p);
    return p;
  }

  private link(vertex: string, fragment: string): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    return { prog, uni: new Map(), aPos: gl.getAttribLocation(prog, 'a_position'), aTex: gl.getAttribLocation(prog, 'a_texCoord') };
  }

  private loc(p: Program, name: string): WebGLUniformLocation | null {
    if (!p.uni.has(name)) p.uni.set(name, this.gl.getUniformLocation(p.prog, name));
    return p.uni.get(name)!;
  }

  // ---------------------------------------------------------------- 绘制

  /** 用给定投影绘制一个可绘制对象；`fbScaleX/Y` 将舞台单位转换为目标像素。 */
  private drawSprite(d: DrawState, projection: Float32Array, fbScaleX: number, fbScaleY: number): void {
    const gl = this.gl;
    const skin = this.skins[d.skin];
    const scaleX = d.sx * fbScaleX;
    const scaleY = d.sy * fbScaleY;
    const tex = this.skinTexture(d.skin, scaleX, scaleY);
    const bits = effectBits(d.fx) | (d.tint ? EFFECT_BITS.tint : 0);
    const p = this.program(false, bits);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadTex);
    gl.enableVertexAttribArray(p.aTex);
    gl.vertexAttribPointer(p.aTex, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const filter = this.useNearest(skin, d, scaleX, scaleY) ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.uniform1i(this.loc(p, 'u_skin'), 0);
    gl.uniformMatrix4fv(this.loc(p, 'u_projectionMatrix'), false, projection);
    gl.uniformMatrix4fv(this.loc(p, 'u_modelMatrix'), false, modelMatrix(skin, d));
    const fx = d.fx;
    if (bits & EFFECT_BITS.color) gl.uniform1f(this.loc(p, 'u_color'), (fx.color / 200) % 1);
    if (bits & EFFECT_BITS.fisheye) gl.uniform1f(this.loc(p, 'u_fisheye'), Math.max(0, (fx.fisheye + 100) / 100));
    if (bits & EFFECT_BITS.whirl) gl.uniform1f(this.loc(p, 'u_whirl'), (-fx.whirl * Math.PI) / 180);
    if (bits & EFFECT_BITS.pixelate) {
      gl.uniform1f(this.loc(p, 'u_pixelate'), Math.abs(fx.pixelate) / 10);
      gl.uniform2f(this.loc(p, 'u_skinSize'), skin.w, skin.h);
    }
    if (bits & EFFECT_BITS.mosaic) gl.uniform1f(this.loc(p, 'u_mosaic'), Math.max(1, Math.min(Math.round((Math.abs(fx.mosaic) + 10) / 10), 512)));
    if (bits & EFFECT_BITS.brightness) gl.uniform1f(this.loc(p, 'u_brightness'), Math.max(-100, Math.min(fx.brightness, 100)) / 100);
    if (bits & EFFECT_BITS.ghost) gl.uniform1f(this.loc(p, 'u_ghost'), 1 - Math.max(0, Math.min(fx.ghost, 100)) / 100);
    if (d.tint) gl.uniform4f(this.loc(p, 'u_tint'), d.tint[0], d.tint[1], d.tint[2], d.tint[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** 绘制一条画笔线条。`s` 是每舞台单位的画笔像素数，因此着色器中一单位宽的抗锯齿边缘就是一像素。 */
  private drawLine(cmd: Extract<PenCmd, { op: 'line' }>, s: number): void {
    const gl = this.gl;
    const p = this.program(true, 0);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linePos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
    const d = cmd.d || 1;
    const off = d === 1 || d === 3 ? 0.5 : 0;
    const x0 = (cmd.x0 + off) * s;
    const y0 = (cmd.y0 + off) * s;
    const dx = (cmd.x1 + off) * s - x0;
    const dy = (cmd.y1 + off) * s - y0;
    const c = cmd.c4;
    gl.uniform2f(this.loc(p, 'u_stageSize'), NATIVE_W * s, NATIVE_H * s);
    gl.uniform4f(this.loc(p, 'u_lineColor'), c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
    gl.uniform1f(this.loc(p, 'u_lineThickness'), d * s);
    gl.uniform1f(this.loc(p, 'u_lineLength'), Math.sqrt(dx * dx + dy * dy));
    gl.uniform4f(this.loc(p, 'u_penPoints'), x0, -y0, dx, -dy);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private penFlip = ortho(-NATIVE_W / 2, NATIVE_W / 2, NATIVE_H / 2, -NATIVE_H / 2);

  private drawPenCmd(cmd: PenCmd): void {
    const gl = this.gl;
    const s = this.penW / NATIVE_W;
    if (cmd.op === 'line') {
      gl.viewport(0, 0, this.penW, this.penH);
      gl.disable(gl.SCISSOR_TEST);
      this.drawLine(cmd, s);
      return;
    }
    const d: DrawState = { skin: cmd.skin, x: cmd.x, y: cmd.y, sx: cmd.sx, sy: cmd.sy, dir: cmd.dir, fx: cmd.fx, tint: cmd.tint };
    if (this.smoothSkins.has(cmd.skin)) {
      const p = this.ease(cmd.skin, cmd.x, cmd.y);
      d.x = p.x;
      d.y = p.y;
    }
    // 图章会先请求 100% 纹理（原版用它检查图章边界）。
    this.skinTexture(cmd.skin, 100, 100);
    if (this.loadState[cmd.skin] !== 2) this.penMissing.add(cmd.skin);
    const b = cmd.clip ?? stampBounds(this.geom, this.skins[cmd.skin], d);
    if (!b) return;
    if (this.penW !== NATIVE_W || this.penH !== NATIVE_H) {
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, this.penW, this.penH);
      this.drawSprite(d, this.penFlip, s, this.penH / NATIVE_H);
      return;
    }
    // 与原版一样，视口和投影只覆盖图章的边界；使用
    // 整个图层加剪刀测试时，边缘栅格化结果会略有不同。
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(NATIVE_W / 2 + b.left, NATIVE_H / 2 - b.top, b.right - b.left, b.top - b.bottom);
    this.drawSprite(d, ortho(b.left, b.right, b.top, b.bottom), 1, 1);
  }

  /** 使画笔纹理与模拟的命令列表保持一致。 */
  private syncPen(rt: Runtime): void {
    const gl = this.gl;
    const cmds = rt.pen.cmds;
    const resized = this.sizePen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.penFbo);
    // 图像到达前绘制的图章没有画出内容，因此该图像加载后会重绘画笔图层。
    const arrived = [...this.penMissing].some((s) => this.loadState[s] === 2);
    if (resized || cmds !== this.penArr || this.penDrawn > cmds.length || rt.penEpoch !== this.penEpoch || arrived) {
      gl.viewport(0, 0, this.penW, this.penH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.penArr = cmds;
      this.penDrawn = 0;
      this.penEpoch = rt.penEpoch;
      this.penMissing.clear();
    }
    if (this.penView) {
      if (this.penDrawn < cmds.length) for (const cmd of this.penView(rt, cmds, this.penDrawn)) this.drawPenCmd(cmd);
    } else {
      for (let i = this.penDrawn; i < cmds.length; i++) this.drawPenCmd(cmds[i]);
    }
    this.penDrawn = cmds.length;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** 将平滑图章的绘制位置向真实位置移动一部分，大幅跳转后则直接移动过去。 */
  private ease(skin: number, x: number, y: number): { x: number; y: number } {
    const p = this.smoothed.get(skin);
    if (!p || Math.hypot(x - p.x, y - p.y) > SMOOTH_SNAP) {
      const q = { x, y };
      this.smoothed.set(skin, q);
      return q;
    }
    p.x += (x - p.x) * SMOOTH_RATE;
    p.y += (y - p.y) * SMOOTH_RATE;
    return p;
  }

  /** 将画笔纹理调整为当前设置和画布大小，随后命令列表会按新大小重绘。 */
  private sizePen(): boolean {
    const hq = this.hqPen && this.display === 'smooth';
    const [gw, gh] = this.stageGrid();
    const w = hq ? Math.max(NATIVE_W, this.canvas.width) : gw;
    const h = hq ? Math.max(NATIVE_H, this.canvas.height) : gh;
    if (w === this.penW && h === this.penH) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.penTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.penW = w;
    this.penH = h;
    return true;
  }

  private stageProj = ortho(-NATIVE_W / 2, NATIVE_W / 2, -NATIVE_H / 2, NATIVE_H / 2);

  /** 从今以后通过 `view` 绘制画笔图层；为 null 时直接从命令绘制，并重绘。 */
  setPenView(view: PenView | null): void {
    this.penView = view;
    this.penArr = null;
  }

  /** 更改舞台显示到屏幕的方式。画笔图层会按新模式下的造型规则重绘。 */
  setDisplay(mode: DisplayMode): void {
    if (mode === this.display) return;
    this.display = mode;
    this.penArr = null;
  }

  /** 显示模式绘制舞台所用的像素尺寸：舞台自身大小，或手持模式更小的网格。 */
  private stageGrid(): [number, number] {
    const s = this.display === 'handheld' ? this.handheldScale : 1;
    return [Math.round(NATIVE_W * s), Math.round(NATIVE_H * s)];
  }

  /** 将当前模拟状态绘制到画布。 */
  render(rt: Runtime): void {
    const gl = this.gl;
    this.syncPen(rt);
    const post = this.display !== 'smooth';
    const [w, h] = post ? this.stageGrid() : [this.canvas.width, this.canvas.height];
    const stageImage = post ? this.target('stage', w, h) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, stageImage?.fbo ?? null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const differs = w !== NATIVE_W && h !== NATIVE_H;
    const sxF = differs ? w / NATIVE_W : 1;
    const syF = differs ? h / NATIVE_H : 1;
    const stage = rt.stage;
    this.drawSprite(drawStateOf(stage), this.stageProj, sxF, syF);
    if (rt.penCreated) this.drawPenLayer(sxF, syF);
    for (const t of rt.drawList) {
      if (!t.visible) continue;
      this.drawSprite(drawStateOf(t, rt.tintOf?.(t)), this.stageProj, sxF, syF);
    }
    if (stageImage) this.finishDisplay(stageImage);
  }

  /** 通过显示模式的通道将舞台图像从离屏目标输出到画布。 */
  private finishDisplay(stageImage: Target): void {
    const gl = this.gl;
    let src = stageImage;
    gl.disable(gl.BLEND);
    if (this.display === 'flash') {
      const low = this.target('flash', Math.round(NATIVE_W / FLASH_DIVISOR), Math.round(NATIVE_H / FLASH_DIVISOR));
      gl.bindFramebuffer(gl.FRAMEBUFFER, low.fbo);
      gl.viewport(0, 0, low.w, low.h);
      this.drawPost(this.postProgram(QUANTIZE), src);
      src = low;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const p = this.postProgram(UPSCALE);
    gl.useProgram(p.prog);
    gl.uniform2f(this.loc(p, 'u_size'), src.w, src.h);
    gl.uniform2f(this.loc(p, 'u_scale'), Math.max(1, Math.floor(this.canvas.width / src.w)), Math.max(1, Math.floor(this.canvas.height / src.h)));
    this.drawPost(p, src);
    gl.enable(gl.BLEND);
  }

  private drawPost(p: Program, src: Target): void {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.loc(p, 'u_image'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** 使用线性过滤的离屏图像，首次使用时创建，大小改变时重建。 */
  private target(name: string, w: number, h: number): Target {
    const gl = this.gl;
    const hit = this.targets.get(name);
    if (hit && hit.w === w && hit.h === h) return hit;
    if (hit) {
      gl.deleteFramebuffer(hit.fbo);
      gl.deleteTexture(hit.tex);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams();
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fbo, w, h };
    this.targets.set(name, t);
    return t;
  }

  private drawPenLayer(sxF: number, syF: number): void {
    const gl = this.gl;
    const p = this.program(false, 0);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadPos);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadTex);
    gl.enableVertexAttribArray(p.aTex);
    gl.vertexAttribPointer(p.aTex, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.penTex);
    const nearest = Math.max(100 * sxF, 100 * syF) >= 100;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.uniform1i(this.loc(p, 'u_skin'), 0);
    gl.uniformMatrix4fv(this.loc(p, 'u_projectionMatrix'), false, this.stageProj);
    const m = new Float32Array(16);
    // 画笔皮肤：480x360，中心位于舞台原点，方向 90，大小 100。
    m[0] = -NATIVE_W;
    m[5] = -NATIVE_H;
    m[10] = 1;
    m[15] = 1;
    gl.uniformMatrix4fv(this.loc(p, 'u_modelMatrix'), false, m);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
}

export function drawStateOf(t: import('../engine/target.ts').Target, tint: Tint | null = null): DrawState {
  return {
    skin: t.sprite.costumes[t.currentCostume].skin,
    x: t.drawX,
    y: t.drawY,
    sx: Math.fround(t.renderedScaleX()),
    sy: Math.fround(t.size),
    dir: t.renderedDirection(),
    fx: t.effects,
    tint,
  };
}

/** 与模拟几何相同的 32 位浮点存储的模型矩阵。 */
function modelMatrix(skin: SkinDef, d: DrawState): Float32Array {
  const f = Math.fround;
  const rotation = ((270 - d.dir) * Math.PI) / 180;
  const cd = cos(rotation);
  const sd = sin(rotation);
  const r00 = f(cd);
  const r01 = f(sd);
  const r10 = f(-sd);
  const r11 = f(cd);
  const adj0 = f(((f(skin.rcx) - skin.w / 2) * d.sx) / 100);
  const adj1 = f((((f(skin.rcy) - skin.h / 2) * d.sy) / 100) * -1);
  const s0 = f((skin.w * d.sx) / 100);
  const s1 = f((skin.h * d.sy) / 100);
  const m = new Float32Array(16);
  m[0] = s0 * r00;
  m[1] = s0 * r01;
  m[4] = s1 * r10;
  m[5] = s1 * r11;
  m[10] = 1;
  m[12] = r00 * adj0 + r10 * adj1 + d.x;
  m[13] = r01 * adj0 + r11 * adj1 + d.y;
  m[15] = 1;
  return m;
}

function stampBounds(_geom: RenderModel, skin: SkinDef, d: DrawState): { left: number; right: number; bottom: number; top: number } | null {
  const m = modelMatrix(skin, d);
  const x = Math.abs(0.5 * m[0]) + Math.abs(0.5 * m[4]);
  const y = Math.abs(0.5 * m[1]) + Math.abs(0.5 * m[5]);
  let left = -x + m[12];
  let right = x + m[12];
  let top = y + m[13];
  let bottom = -y + m[13];
  left = Math.max(left, -STAGE_X);
  right = Math.min(right, STAGE_X);
  bottom = Math.max(bottom, -STAGE_Y);
  top = Math.min(top, STAGE_Y);
  left = Math.min(left, STAGE_X);
  right = Math.max(right, -STAGE_X);
  bottom = Math.min(bottom, STAGE_Y);
  top = Math.max(top, -STAGE_Y);
  left = Math.floor(left);
  right = Math.ceil(right);
  bottom = Math.floor(bottom);
  top = Math.ceil(top);
  if (right - left === 0 || top - bottom === 0) return null;
  return { left, right, bottom, top };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  if (/\.svg$/i.test(url) && !/^(blob|data):/.test(url)) return loadSvg(url);
  return imageFrom(url, true);
}

/** `decode()` 的最长等待时间；页面不渲染时（如后台标签页）它永不结束。 */
const DECODE_WAIT_MS = 250;

/**
 * 加载图像。使用 `decode` 时浏览器还会在主线程外解码，因此纹理上传无需解码。
 * 上传仍会像原版一样自行预乘像素，使边缘像素保持一致。
 */
function imageFrom(url: string, decode = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (!decode || document.visibilityState === 'hidden') return resolve(img);
      const timer = setTimeout(() => resolve(img), DECODE_WAIT_MS);
      img.decode().then(
        () => (clearTimeout(timer), resolve(img)),
        () => (clearTimeout(timer), resolve(img)),
      );
    };
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/** 矢量造型之间共享的字体数据，按 tools/assets.ts 分配的 id 索引。 */
const fontCache = new Map<string, Promise<string>>();

/**
 * 恢复字体后加载矢量造型。图像无法自行获取字体，因此每个造型内嵌原加载器写入的字体。
 * 资源文件夹为每种字体只保留一份副本。
 */
async function loadSvg(url: string): Promise<HTMLImageElement> {
  let text = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`failed to load ${url}`);
    return r.text();
  });
  const ids = [...new Set([...text.matchAll(/cbfont:([0-9a-f]+)/g)].map((m) => m[1]))];
  if (ids.length > 0) {
    const fontBase = url.replace(/costumes\/[^/]+$/, 'fonts/');
    for (const id of ids) {
      if (!fontCache.has(id)) fontCache.set(id, fetch(`${fontBase}${id}.txt`).then((r) => r.text()));
      const data = await fontCache.get(id)!;
      text = text.split(`cbfont:${id}`).join(data);
    }
  }
  const blobUrl = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    return await imageFrom(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
