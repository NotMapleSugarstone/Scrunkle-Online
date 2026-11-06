// 用于回滚的整局模拟快照。快照是普通数据，除了画笔命令
// 数组；该数组共享且只追加，因此每帧取快照的成本很低。
import type { Value } from './cast.ts';
import type { PenCmd, Runtime } from './runtime.ts';
import type { PlayerState } from './sound-model.ts';
import { Target, type Effects, type PenState, type SoundFx } from './target.ts';
import { Thread, type Frame } from './thread.ts';

interface TargetSnap {
  id: number;
  sprite: number;
  isOriginal: boolean;
  x: number;
  y: number;
  drawX: number;
  drawY: number;
  direction: number;
  size: number;
  currentCostume: number;
  visible: boolean;
  rotationStyle: string;
  draggable: boolean;
  volume: number;
  effects: Effects;
  hullClean: boolean;
  edgeValues: [string, boolean][];
  v: Record<string, Value>;
  l: Record<string, Value[]>;
  pen: PenState | null;
  snd: SoundFx | null;
  waitingSounds: number[];
}

interface ThreadSnap {
  id: number;
  target: number;
  sprite: number;
  script: number;
  status: number;
  isKilled: boolean;
  fresh: boolean;
  nullPending: boolean;
  frames: Frame[];
}

interface PlayerSnap extends Omit<PlayerState, 'waiters' | 'owner'> {
  waiters: number[];
  owner: number | null;
}

export interface Snapshot {
  frame: number;
  currentMSecs: number;
  paused: boolean;
  pausedFrames: number;
  timerStart: number;
  cloneCount: number;
  nextTargetId: number;
  nextThreadId: number;
  rngState: number;
  rngCalls: number;
  answer: string;
  questions: { text: string; thread: number; target: number }[];
  penCmds: PenCmd[];
  penLength: number;
  penGen: number;
  penCreated: boolean;
  monitorVisible: Record<string, boolean>;
  mouse: [number, number, boolean];
  /** 帧后各玩家槽位按住的键（已排序），用于判断下一帧某键是否为新按下。 */
  keys: string[][];
  targets: TargetSnap[];
  executable: number[];
  drawList: number[];
  clones: number[][];
  threads: ThreadSnap[];
  pending: number[];
  players: PlayerSnap[][];
}

/** 复制目标的列表。固定列表永不改变，因此副本共享它们，并按运行时的方式冻结。 */
function copyLists(l: Record<string, Value[]>, fixed: Set<string>): Record<string, Value[]> {
  const out: Record<string, Value[]> = {};
  for (const k in l) {
    const v = l[k];
    out[k] = !fixed.has(k) ? v.slice() : Object.isFrozen(v) ? v : (Object.freeze(v.slice()) as Value[]);
  }
  return out;
}

function copyFrame(f: Frame): Frame {
  const out: Frame = { u: f.u, pc: f.pc, warp: f.warp, pw: f.pw, a: f.a.slice(), l: f.l.slice(), pcp: f.pcp, pcs: f.pcs };
  if (f.w) out.w = f.w.slice();
  if (f.cd !== undefined) out.cd = f.cd;
  return out;
}

/** 仍可观察到其结果的线程：在列表中且未被杀死。 */
function live(rt: Runtime, th: Thread): boolean {
  return !th.isKilled && !th.orphan;
}

export function saveSnapshot(rt: Runtime): Snapshot {
  const liveTargets = new Set(rt.targets.map((t) => t.id));
  const tid = (t: Target) => t.id;
  return {
    frame: rt.frame,
    currentMSecs: rt.currentMSecs,
    paused: rt.paused,
    pausedFrames: rt.pausedFrames,
    timerStart: rt.timerStart,
    cloneCount: rt.cloneCount,
    nextTargetId: rt.nextTargetId,
    nextThreadId: rt.nextThreadId,
    rngState: rt.rng.state,
    rngCalls: rt.rng.calls,
    answer: rt.answer,
    questions: rt.questions.map((q) => ({ text: q.text, thread: live(rt, q.thread) ? q.thread.id : -1, target: q.target.id })),
    penCmds: rt.pen.cmds,
    penLength: rt.pen.cmds.length,
    penGen: rt.pen.gen,
    penCreated: rt.penCreated,
    monitorVisible: { ...rt.monitorVisible },
    mouse: [rt.io.mouseX, rt.io.mouseY, rt.io.mouseDown],
    keys: rt.io.keys.map((set) => [...set].sort()),
    targets: rt.targets.map((t) => ({
      id: t.id,
      sprite: t.sprite.index,
      isOriginal: t.isOriginal,
      x: t.x,
      y: t.y,
      drawX: t.drawX,
      drawY: t.drawY,
      direction: t.direction,
      size: t.size,
      currentCostume: t.currentCostume,
      visible: t.visible,
      rotationStyle: t.rotationStyle,
      draggable: t.draggable,
      volume: t.volume,
      effects: { ...t.effects },
      hullClean: t.hullClean,
      edgeValues: [...t.edgeValues],
      v: { ...t.v },
      l: copyLists(t.l, t.sprite.fixedLists),
      pen: t.pen ? { ...t.pen, c4: [...t.pen.c4] as PenState['c4'] } : null,
      snd: t.snd ? { ...t.snd } : null,
      waitingSounds: [...t.waitingSounds],
    })),
    executable: rt.executable.map(tid),
    drawList: rt.drawList.map(tid),
    clones: rt.sprites.map((s) => s.clones.map(tid)),
    threads: rt.threads.map((th) => ({
      id: th.id,
      target: th.target.id,
      sprite: th.target.sprite.index,
      script: th.target.sprite.scriptIndex.get(th.script)!,
      status: th.status,
      isKilled: th.isKilled,
      fresh: th.fresh,
      nullPending: th.nullPending,
      frames: th.frames.map(copyFrame),
    })),
    pending: rt.pending.filter((th) => live(rt, th)).map((th) => th.id),
    players: rt.players.map((list) =>
      list.map((p) => ({
        isPlaying: p.isPlaying,
        startingUntil: p.startingUntil,
        pos: p.pos,
        lastT: p.lastT,
        rate: p.rate,
        pitch: p.pitch,
        serial: p.serial,
        order: p.order,
        waiters: p.waiters.filter((th) => live(rt, th)).map((th) => th.id),
        // 已删除的持有者等同于无持有者；保存为 null 可让快照保持可比较。
        owner: p.owner && liveTargets.has(p.owner.id) ? p.owner.id : null,
      })),
    ),
  };
}

export function loadSnapshot(rt: Runtime, s: Snapshot): void {
  rt.frame = s.frame;
  rt.currentMSecs = s.currentMSecs;
  rt.paused = s.paused;
  rt.pausedFrames = s.pausedFrames;
  rt.timerStart = s.timerStart;
  rt.cloneCount = s.cloneCount;
  rt.nextTargetId = s.nextTargetId;
  rt.nextThreadId = s.nextThreadId;
  rt.rng.state = s.rngState;
  rt.rng.calls = s.rngCalls;
  rt.answer = s.answer;
  rt.penCreated = s.penCreated;
  rt.monitorVisible = { ...s.monitorVisible };
  [rt.io.mouseX, rt.io.mouseY, rt.io.mouseDown] = s.mouse;
  // 在快照包含按键状态之前保存的回放，开始时没有任何按住的键。
  rt.io.keys = rt.io.keys.map((_, p) => new Set(s.keys?.[p] ?? []));

  // 画笔数组在两次清空之间只追加，因此截断它即可恢复快照的视图。
  s.penCmds.length = s.penLength;
  rt.pen = { cmds: s.penCmds, gen: s.penGen };
  rt.penEpoch++;

  // 原体保留其对象（生成代码持有舞台）；克隆体会重建。
  const originals = new Map<number, Target>();
  for (const sprite of rt.sprites) originals.set(sprite.index, sprite.original);
  const byId = new Map<number, Target>();
  rt.targets = s.targets.map((ts) => {
    const sprite = rt.sprites[ts.sprite];
    const t = ts.isOriginal ? originals.get(ts.sprite)! : new Target(rt, sprite, ts.id, false);
    t.id = ts.id;
    t.x = ts.x;
    t.y = ts.y;
    t.drawX = ts.drawX;
    t.drawY = ts.drawY;
    t.direction = ts.direction;
    t.size = ts.size;
    t.currentCostume = ts.currentCostume;
    t.visible = ts.visible;
    t.rotationStyle = ts.rotationStyle;
    t.draggable = ts.draggable;
    t.volume = ts.volume;
    t.effects = { ...ts.effects };
    t.hullClean = ts.hullClean;
    t.edgeValues = new Map(ts.edgeValues);
    t.v = { ...ts.v };
    t.l = copyLists(ts.l, sprite.fixedLists);
    t.pen = ts.pen ? { ...ts.pen, c4: [...ts.pen.c4] as PenState['c4'] } : null;
    t.snd = ts.snd ? { ...ts.snd } : null;
    t.waitingSounds = new Set(ts.waitingSounds);
    t.scriptThreads = [];
    byId.set(t.id, t);
    return t;
  });
  rt.stage = rt.targets.find((t) => t.isStage)!;
  rt.executable = s.executable.map((id) => byId.get(id)!);
  rt.drawList = s.drawList.map((id) => byId.get(id)!);
  rt.sprites.forEach((sprite, i) => {
    sprite.clones = s.clones[i].map((id) => byId.get(id)!);
  });

  const threads = new Map<number, Thread>();
  rt.threads = s.threads.map((ts) => {
    const target = byId.get(ts.target)!;
    const script = target.sprite.scripts[ts.script];
    const th = new Thread(ts.id, target, script);
    th.status = ts.status;
    th.isKilled = ts.isKilled;
    th.fresh = ts.fresh;
    th.nullPending = ts.nullPending;
    th.frames = ts.frames.map(copyFrame);
    threads.set(th.id, th);
    target.scriptThreads[ts.script] = th;
    return th;
  });
  // 已不在列表中的等待者会解析为空，因此用占位符代替它。
  const resolveThread = (id: number): Thread => threads.get(id) ?? orphanPlaceholder(rt);
  rt.pending = s.pending.map(resolveThread);
  rt.questions = s.questions.map((q) => ({ text: q.text, thread: q.thread < 0 ? orphanPlaceholder(rt) : resolveThread(q.thread), target: byId.get(q.target) ?? rt.stage }));
  rt.players = s.players.map((list) =>
    list.map((p) => ({
      isPlaying: p.isPlaying,
      startingUntil: p.startingUntil,
      pos: p.pos,
      lastT: p.lastT,
      rate: p.rate,
      pitch: p.pitch,
      serial: p.serial,
      order: p.order,
      waiters: p.waiters.map(resolveThread),
      owner: p.owner === null ? null : (byId.get(p.owner) ?? null),
    })),
  );
  rt.activeThread = null;
}

function orphanPlaceholder(rt: Runtime): Thread {
  const th = new Thread(-1, rt.stage, rt.stage.sprite.scripts[0] ?? { hat: 'flag', top: '' });
  th.orphan = true;
  return th;
}

// 普通 JSON 会把 -0 写成 0，把 NaN 和无穷写成 null。游戏值包含这四种，因此用带标记对象传输。
const SPECIAL: [string, number][] = [['-0', -0], ['NaN', NaN], ['Inf', Infinity], ['-Inf', -Infinity]];

/** 保留 -0、NaN 和无穷的 JSON 文本，用于快照及任何持有快照的内容。 */
export function toExactJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v !== 'number' || (Number.isFinite(v) && !Object.is(v, -0))) return v;
    const tag = SPECIAL.find(([, n]) => Object.is(n, v))![0];
    return { [tag]: 1 };
  });
}

/** 读取 `toExactJson` 文本。名为 `__proto__` 的键会被丢弃，因为文本可能来自他人的文件。 */
export function fromExactJson<T>(text: string): T {
  return JSON.parse(text, (k, v) => {
    if (k === '__proto__') return undefined;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const keys = Object.keys(v);
    if (keys.length !== 1 || v[keys[0]] !== 1) return v;
    const hit = SPECIAL.find(([tag]) => tag === keys[0]);
    return hit ? hit[1] : v;
  }) as T;
}

/** 以 JSON 文本表示快照，用于发送给其他玩家。所需画笔命令会被复制进去。 */
export function snapshotToJson(s: Snapshot): string {
  return toExactJson({ ...s, penCmds: s.penCmds.slice(0, s.penLength) });
}

export function snapshotFromJson(text: string): Snapshot {
  return fromExactJson<Snapshot>(text);
}
