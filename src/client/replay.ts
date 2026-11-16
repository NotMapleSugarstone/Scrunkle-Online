// 比赛回放。录像保存从比赛开始帧起的完整游戏状态，以及之后每一帧的输入，
// 直到比赛结束，因此回放能重现同一场比赛。它还每 10 秒保存一次状态哈希，
// 以便播放时判断何时不再一致。
import type { PlayerInput } from '../engine/io.ts';
import type { Runtime } from '../engine/runtime.ts';
import { saveSnapshot, type Snapshot } from '../engine/snapshot.ts';
import { STATUS_DONE } from '../engine/thread.ts';
import { snapshotHash } from '../net/rollback.ts';
import { matchInfo, type MatchView } from '../game/replays.ts';

/** 回放界面列出的内容。 */
export interface ReplayMeta {
  id: string;
  /** 玩家给回放的名称，显示时替代角色名。 */
  name?: string;
  saved: number;
  mode: string;
  fighters: string[];
  stage: string;
  /** 帧长度。 */
  frames: number;
  online: boolean;
  /** 在线比赛的座位名称。 */
  names: string[];
  /** 构建指纹。回放只有在保存它的构建中才能完全一致地播放。 */
  build: string;
}

export interface ReplayBody {
  format: 1;
  /** 运行时开始时间，日期积木会读取。 */
  t0: number;
  start: Snapshot;
  /** 开始后每一帧的输入，以 [帧数, 输入] 段保存。 */
  runs: [number, PlayerInput[]][];
  /** [已播放帧数, 状态哈希] 对。 */
  checks: [number, number][];
}

export type FinishedReplay = { meta: Omit<ReplayMeta, 'id' | 'saved'>; body: ReplayBody };

/** 录制器在一帧后读取的状态。 */
export interface FrameState extends MatchView {
  snapshot(): Snapshot;
}

/** 本地游玩时的实时运行时状态。 */
export function runtimeState(rt: Runtime): FrameState {
  const def = rt.stage.sprite.def;
  return {
    v: (n) => rt.stage.v[def.varNames?.[n] ?? ''],
    l: (n) => rt.stage.l[def.listNames?.[n] ?? ''] ?? [],
    running: (msg) => rt.threads.some((th) => th.target === rt.stage && th.script.msg === msg && th.status !== STATUS_DONE && !th.isKilled),
    snapshot: () => saveSnapshot(rt),
  };
}

/** 在线比赛中的快照状态；确认帧落后于实时运行时。 */
export function snapshotState(rt: Runtime, s: Snapshot): FrameState {
  const def = rt.stage.sprite.def;
  const index = rt.stage.sprite.index;
  const stage = s.targets.find((t) => t.isOriginal && t.sprite === index)!;
  const scripts = rt.stage.sprite.scripts;
  return {
    v: (n) => stage.v[def.varNames?.[n] ?? ''],
    l: (n) => stage.l[def.listNames?.[n] ?? ''] ?? [],
    running: (msg) => s.threads.some((th) => th.sprite === index && scripts[th.script]?.msg === msg && th.status !== STATUS_DONE && !th.isKilled),
    snapshot: () => s,
  };
}

/** 可保存的快照：复制画笔命令，因为快照共享画笔数组。 */
function detached(s: Snapshot): Snapshot {
  return { ...s, penCmds: s.penCmds.slice(0, s.penLength) };
}

const CHECK_EVERY = 300;
/** 超过 30 分钟的比赛不保留。 */
const MAX_FRAMES = 30 * 60 * 30;
/** 短于 10 秒的比赛不提示保存。 */
const MIN_FRAMES = 300;

function cloudEqual(a: PlayerInput['cloud'], b: PlayerInput['cloud']): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  return true;
}

function varsEqual(a: PlayerInput['vars'], b: PlayerInput['vars']): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  return true;
}

function listsEqual(a: PlayerInput['lists'], b: PlayerInput['lists']): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x[0] !== y[0] || x[1] !== y[1] || x[2].length !== y[2].length) return false;
    for (let j = 0; j < x[2].length; j++) if (x[2][j] !== y[2][j]) return false;
  }
  return true;
}

function inputsEqual(a: PlayerInput[], b: PlayerInput[] | null): boolean {
  if (b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const keys = x.keys;
    if (keys.length !== y.keys.length) return false;
    for (let j = 0; j < keys.length; j++) if (keys[j] !== y.keys[j]) return false;
    const mx = x.mouse;
    const my = y.mouse;
    if (!!mx !== !!my) return false;
    if (mx && my && (mx.x !== my.x || mx.y !== my.y || mx.down !== my.down)) return false;
    if (x.answer !== y.answer || !cloudEqual(x.cloud, y.cloud) || !varsEqual(x.vars, y.vars) || !listsEqual(x.lists, y.lists)) return false;
  }
  return true;
}

function cloneInputs(inputs: PlayerInput[]): PlayerInput[] {
  return inputs.map((p) => {
    const q: PlayerInput = { keys: p.keys.slice() };
    if (p.mouse) q.mouse = { ...p.mouse };
    if (p.answer !== undefined) q.answer = p.answer;
    if (p.cloud) q.cloud = p.cloud.map(([a, b]) => [a, b]);
    if (p.vars) q.vars = p.vars.map(([a, b]) => [a, b]);
    if (p.lists) q.lists = p.lists.map(([a, b, c]) => [a, b, c.slice()]);
    return q;
  });
}

interface Recording {
  body: ReplayBody;
  lastInputs: PlayerInput[] | null;
  frames: number;
  mode: string;
  fighters: string[];
  stage: string;
}

export class ReplayRecorder {
  /** 比赛开始，上一场的保存提示已过期。 */
  onStart: () => void = () => {};
  /** 比赛结束，可以保存。 */
  onFinish: (r: FinishedReplay) => void = () => {};
  private rec: Recording | null = null;
  private wasMatch = false;

  constructor(
    private rt: Runtime,
    private t0: number,
    private about: { build: string; online: boolean; names: string[] },
  ) {}

  /** 每帧按顺序调用，传入该帧使用的输入和帧后状态。 */
  frame(inputs: PlayerInput[], s: FrameState): void {
    const info = matchInfo(this.rt, s);
    const rec = this.rec;
    if (rec) {
      if (!info) {
        this.rec = null;
        if (rec.frames >= MIN_FRAMES) this.finish(rec);
      } else if (rec.frames >= MAX_FRAMES) this.rec = null;
      else this.add(rec, inputs, s);
    } else if (info && !this.wasMatch) {
      this.rec = {
        body: { format: 1, t0: this.t0, start: detached(s.snapshot()), runs: [], checks: [] },
        lastInputs: null,
        frames: 0,
        ...info,
      };
      this.onStart();
    }
    this.wasMatch = !!info;
  }

  private add(rec: Recording, inputs: PlayerInput[], s: FrameState): void {
    const runs = rec.body.runs;
    if (inputsEqual(inputs, rec.lastInputs)) runs[runs.length - 1][0]++;
    else {
      const copy = cloneInputs(inputs);
      runs.push([1, copy]);
      rec.lastInputs = copy;
    }
    rec.frames++;
    if (rec.frames % CHECK_EVERY === 0) rec.body.checks.push([rec.frames, snapshotHash(s.snapshot())]);
  }

  private finish(rec: Recording): void {
    this.onFinish({
      meta: { mode: rec.mode, fighters: rec.fighters, stage: rec.stage, frames: rec.frames, ...this.about },
      body: rec.body,
    });
  }
}

/** 从输入段展开的每一帧输入。 */
export function replayFrames(body: ReplayBody): PlayerInput[][] {
  const out: PlayerInput[][] = [];
  for (const [n, inputs] of body.runs) for (let i = 0; i < n; i++) out.push(inputs);
  return out;
}

/** “Lemon vs Deli”。 */
export function replayTitle(m: Pick<ReplayMeta, 'fighters'>): string {
  return m.fighters.join(' vs ');
}

/** 回放的玩家名称，或角色名。 */
export function replayName(m: ReplayMeta): string {
  return m.name || replayTitle(m);
}

export const REPLAY_NAME_MAX = 60;

/** 帧数对应的“2:31”。 */
export function clock(frames: number): string {
  const s = Math.floor(frames / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
