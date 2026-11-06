// 从解析树为每个目标生成一个 TypeScript 模块。
// 永远不会挂起的代码生成普通函数。可能挂起的代码生成可恢复单元：在恢复标签上
// 执行 switch，并将状态保存在普通数据帧中。
import type { Expr, Lit, ProcIR, ScriptIR, Stmt, StoreRef, TargetIR } from './ir.ts';
import { sanitize } from './ir.ts';
import { COMPILED } from '../../src/engine/defs.ts';

type Mode = 'N' | 'W' | 'D';
type Ty = 'nn' | 'num' | 'str' | 'bool' | 'any';
interface C {
  c: string;
  t: Ty;
  pure: boolean;
  lit?: { v: Lit };
}

const PROMISE_OPS = new Set(['sound_setvolumeto', 'sound_changevolumeby', 'sound_seteffectto', 'sound_changeeffectby', 'sound_playuntildone', 'sensing_askandwait']);
const WAIT_OPS = new Set(['control_wait', 'control_wait_until', 'event_broadcastandwait', 'motion_glidesecstoxy']);
/** 页面可通过 `rt.natives` 用 TypeScript 替换的自定义积木。 */
const NATIVE_PROCS = new Set<string>();
/** 工具通过 `rt.procs` 调用的自定义积木，例如 AI 锦标赛替玩家运行内置 AI。 */
const EXPOSED_PROCS = new Set<string>();
/** 使用 PROBE=1 时，每个转译后的自定义积木都会向 `rt.probe` 报告参数（tools/parity-probe.ts）。 */
const PROBE = process.env.PROBE === '1';

export interface Analysis {
  /** proccode -> 在 warp 上下文中运行时能否挂起 */
  suspW: Map<string, boolean>;
  /** proccode -> 在非 warp 上下文中运行时能否挂起 */
  suspN: Map<string, boolean>;
  warnings: string[];
}

// ------------------------------------------------------------------ 分析

function walk(stmts: Stmt[], fn: (s: Stmt) => void): void {
  for (const s of stmts) {
    fn(s);
    if (s.k === 'if') {
      walk(s.then, fn);
      if (s.else) walk(s.else, fn);
    } else if (s.k === 'repeat' || s.k === 'until' || s.k === 'forever') walk(s.body, fn);
  }
}

function exprImpure(e: Expr | undefined): boolean {
  if (!e) return false;
  if (e.k !== 'op') return false;
  if (e.op === 'operator_random') return true;
  // 接触边缘会读取绘制边界，使渲染器保留角色的凸包。
  if (e.op === 'sensing_touchingobject') {
    const m = e.in.TOUCHINGOBJECTMENU;
    if (!m || m.k !== 'lit' || m.v === '_edge_') return true;
  }
  return e.inOrder.some((k) => exprImpure(e.in[k]));
}

export function analyze(t: TargetIR): Analysis {
  const suspW = new Map<string, boolean>();
  const suspN = new Map<string, boolean>();
  for (const code of t.procs.keys()) {
    suspW.set(code, false);
    suspN.set(code, false);
  }
  const warnings: string[] = [];
  // 原版在非 warp 调用一个已在调用栈上方几层的自定义积木时会 yield，因此
  // 能通过任意调用链再次调用自身的过程必须能够挂起。
  const callees = new Map<string, Set<string>>();
  for (const p of t.procs.values()) {
    const out = new Set<string>();
    walk(p.body, (s) => {
      if (s.k === 'call' && t.procs.has(s.proc)) out.add(s.proc);
    });
    callees.set(p.proccode, out);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const c = stack.pop()!;
      if (c === to) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const n of callees.get(c) ?? []) stack.push(n);
    }
    return false;
  };
  const recursive = new Set<string>();
  for (const p of t.procs.values()) {
    if (p.warp) continue;
    walk(p.body, (s) => {
      if (s.k === 'call' && !t.procs.get(s.proc)?.warp && t.procs.has(s.proc) && reaches(s.proc, p.proccode)) recursive.add(p.proccode);
    });
  }
  const suspends = (stmts: Stmt[], mode: 'W' | 'N'): boolean => {
    let found = false;
    walk(stmts, (s) => {
      if (found) return;
      if ((s.k === 'repeat' || s.k === 'until' || s.k === 'forever') && mode === 'N') found = true;
      else if (s.k === 'op' && (PROMISE_OPS.has(s.op) || WAIT_OPS.has(s.op))) found = true;
      else if (s.k === 'call') {
        const p = t.procs.get(s.proc);
        if (p) {
          const ctx = p.warp ? 'W' : mode;
          if ((ctx === 'W' ? suspW : suspN).get(s.proc)) found = true;
        }
      }
    });
    return found;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of t.procs.values()) {
      const w = suspends(p.body, 'W');
      const n = p.warp ? w : recursive.has(p.proccode) || suspends(p.body, 'N');
      if (w !== suspW.get(p.proccode)) {
        suspW.set(p.proccode, w);
        changed = true;
      }
      if (n !== suspN.get(p.proccode)) {
        suspN.set(p.proccode, n);
        changed = true;
      }
    }
  }
  // 生成器无法精确建模的异常情况。
  for (const p of t.procs.values()) {
    walk(p.body, (s) => {
      if (s.k === 'op' && WAIT_OPS.has(s.op) && (p.warp)) warnings.push(`${t.name}: ${s.op} inside warp procedure "${p.proccode}"`);
      if (s.k === 'forever' && p.warp) warnings.push(`${t.name}: forever inside warp procedure "${p.proccode}"`);
      if (s.k === 'call' && !t.procs.has(s.proc)) warnings.push(`${t.name}: call to undefined procedure "${s.proc}"`);
    });
  }
  return { suspW, suspN, warnings };
}

// ------------------------------------------------------------------ 字面量辅助

function litCode(v: Lit): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (Object.is(v, -0)) return '-0';
    return String(v);
  }
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function toNumberLit(v: Lit): number {
  if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function toBoolLit(v: Lit): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return !(v === '' || v === '0' || v.toLowerCase() === 'false');
  return Boolean(v);
}

function compareLit(v1: Lit, v2: Lit): number {
  let n1 = Number(v1);
  let n2 = Number(v2);
  const ws = (v: Lit) => typeof v === 'string' && v.trim().length === 0;
  if (n1 === 0 && ws(v1)) n1 = NaN;
  else if (n2 === 0 && ws(v2)) n2 = NaN;
  if (Number.isNaN(n1) || Number.isNaN(n2)) {
    const s1 = String(v1).toLowerCase();
    const s2 = String(v2).toLowerCase();
    return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
  }
  if ((n1 === Infinity && n2 === Infinity) || (n1 === -Infinity && n2 === -Infinity)) return 0;
  return n1 - n2;
}

const lit = (v: Lit): C => ({
  c: litCode(v),
  t: typeof v === 'number' ? (Number.isNaN(v) ? 'num' : 'nn') : typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool' : 'any',
  pure: true,
  lit: { v },
});

function num(e: C): string {
  if (e.lit) return litCode(toNumberLit(e.lit.v));
  if (e.t === 'nn') return e.c;
  return `num(${e.c})`;
}
function bool(e: C): string {
  if (e.lit) return String(toBoolLit(e.lit.v));
  if (e.t === 'bool') return e.c;
  return `bool(${e.c})`;
}
function str(e: C): string {
  if (e.lit) return JSON.stringify(String(e.lit.v));
  if (e.t === 'str') return e.c;
  return `String(${e.c})`;
}

// ------------------------------------------------------------------ 惯用法

const sameRef = (a: StoreRef, b: StoreRef): boolean => a.scope === b.scope && a.id === b.id && a.list === b.list;

/** 忽略积木 id 的结构相等比较。 */
function sameExpr(a: Expr | undefined, b: Expr | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'lit': return Object.is(a.v, (b as typeof a).v);
    case 'var': case 'listContents': return sameRef(a.ref, (b as typeof a).ref);
    case 'arg': return a.name === (b as typeof a).name && a.bool === (b as typeof a).bool;
    case 'op': {
      const o = b as typeof a;
      if (a.op !== o.op || a.inOrder.join() !== o.inOrder.join()) return false;
      if (JSON.stringify(a.f) !== JSON.stringify(o.f)) return false;
      return a.inOrder.every((k) => sameExpr(a.in[k], o.in[k]));
    }
  }
}

const isLitValue = (e: Expr | undefined, v: Lit): boolean => e?.k === 'lit' && Object.is(e.v, v);
const isVarOf = (e: Expr | undefined, r: StoreRef): boolean => e?.k === 'var' && sameRef(e.ref, r);
type OpStmt = Extract<Stmt, { k: 'op' }>;
const isOp = (s: Stmt | undefined, op: string): s is OpStmt => s?.k === 'op' && s.op === op;
const isSet = (s: Stmt | undefined, r: StoreRef): s is OpStmt => isOp(s, 'data_setvariableto') && sameRef(s.f.VARIABLE as StoreRef, r);
const isIncrement = (s: Stmt | undefined, r: StoreRef): boolean =>
  isOp(s, 'data_changevariableby') && sameRef(s.f.VARIABLE as StoreRef, r) && s.in.VALUE?.k === 'lit' && toNumberLit(s.in.VALUE.v) === 1;

interface SplitIdiom {
  list: StoreRef;
  word: StoreRef;
  counter: StoreRef;
  input: Expr;
  sep: Expr;
}

/**
 * 匹配 `stmts[i..i+3]` 处项目的逐字母拆分循环：清空列表、将单词设为 ""、
 * 将计数器设为 "1"，然后重复（输入长度）次，将每个非分隔符字母追加到单词，
 * 并在每个分隔符处将单词加入列表。
 */
function splitIdiom(stmts: Stmt[], i: number): SplitIdiom | null {
  const [s0, s1, s2, s3] = stmts.slice(i, i + 4);
  if (!isOp(s0, 'data_deletealloflist') || !isOp(s1, 'data_setvariableto') || !isOp(s2, 'data_setvariableto')) return null;
  if (s3?.k !== 'repeat') return null;
  const list = s0.f.LIST as StoreRef;
  const word = s1.f.VARIABLE as StoreRef;
  const counter = s2.f.VARIABLE as StoreRef;
  if (sameRef(word, counter) || !isLitValue(s1.in.VALUE, '') || !isLitValue(s2.in.VALUE, '1')) return null;
  // 循环运行期间，输入和分隔符必须保持其值。
  const steady = (e: Expr | undefined): e is Expr =>
    !!e && (e.k === 'lit' || e.k === 'arg' || (e.k === 'var' && !sameRef(e.ref, word) && !sameRef(e.ref, counter)));
  const times = s3.times;
  if (times.k !== 'op' || times.op !== 'operator_length' || !steady(times.in.STRING)) return null;
  const input = times.in.STRING;
  const branch = s3.body[0];
  if (s3.body.length !== 1 || branch.k !== 'if' || !branch.else) return null;
  const cond = branch.cond;
  if (cond.k !== 'op' || cond.op !== 'operator_not') return null;
  const test = cond.in.OPERAND;
  if (test?.k !== 'op' || test.op !== 'operator_equals' || !steady(test.in.OPERAND2)) return null;
  const letter = test.in.OPERAND1;
  if (letter?.k !== 'op' || letter.op !== 'operator_letter_of' || !isVarOf(letter.in.LETTER, counter) || !sameExpr(letter.in.STRING, input)) return null;
  const [t0, t1] = branch.then;
  const join = isSet(t0, word) ? t0.in.VALUE : undefined;
  if (branch.then.length !== 2 || join?.k !== 'op' || join.op !== 'operator_join') return null;
  if (!isVarOf(join.in.STRING1, word) || !sameExpr(join.in.STRING2, letter) || !isIncrement(t1, counter)) return null;
  const [e0, e1, e2] = branch.else;
  if (branch.else.length !== 3 || !isOp(e0, 'data_addtolist') || !sameRef(e0.f.LIST as StoreRef, list) || !isVarOf(e0.in.ITEM, word)) return null;
  if (!isSet(e1, word) || !isLitValue(e1.in.VALUE, '') || !isIncrement(e2, counter)) return null;
  return { list, word, counter, input, sep: test.in.OPERAND2 };
}

// ------------------------------------------------------------------ 生成器

interface ExprCtx {
  /** 参数名称 -> 代码，过程外为 null。 */
  args: Map<string, string> | null;
}

interface Label {
  n: number;
  used: boolean;
}

interface Pct {
  /** Promise 续接目标：某个标签，或从单元末尾退出。 */
  label: Label | null;
}

class UnitWriter {
  lines: (string | Label)[] = [];
  labels: Label[] = [];
  locals = 0;
  temps = 0;

  label(): Label {
    const l = { n: this.labels.length, used: false };
    this.labels.push(l);
    return l;
  }
  ref(l: Label): number {
    l.used = true;
    return l.n;
  }
  place(l: Label): void {
    this.lines.push(l);
  }
  emit(s: string): void {
    this.lines.push(s);
  }
  local(): number {
    return this.locals++;
  }
}

export class SpriteGen {
  t: TargetIR;
  stage: TargetIR;
  an: Analysis;
  /** proccode -> 可恢复单元变量名 */
  unitNames = new Map<string, { N?: string; W?: string }>();
  plainNeeded = new Set<string>();
  out: string[] = [];
  counter = 0;
  errors: string[] = [];
  /** 此目标列表中没有积木写入的属性名。 */
  fixedLists: string[] = [];

  constructor(t: TargetIR, stage: TargetIR, an: Analysis) {
    this.t = t;
    this.stage = stage;
    this.an = an;
  }

  // ---------------------------------------------------------------- 表达式

  ref(r: StoreRef): string {
    const base = r.scope === 'global' ? 'G' : 't';
    return `${base}.${r.list ? 'l' : 'v'}.${r.prop}`;
  }

  /** 设置或更改云变量后，与原版的数据积木一样将新值发送到云连接。 */
  cloudWrite(r: StoreRef, E: (s: string) => void): void {
    const decl = r.scope === 'global' && !r.list ? this.stage.vars.find((d) => d.id === r.id) : undefined;
    if (decl?.cloud) E(`rt.cloudSet(${JSON.stringify(decl.name)}, ${this.ref(r)});`);
  }

  ex(e: Expr | undefined, cx: ExprCtx): C {
    if (e === undefined) return lit(undefined);
    switch (e.k) {
      case 'lit':
        return lit(e.v);
      case 'var':
        return { c: this.ref(e.ref), t: 'any', pure: true };
      case 'listContents':
        return { c: `listContents(${this.ref(e.ref)})`, t: 'str', pure: true };
      case 'arg': {
        const code = cx.args?.get(e.name);
        if (code === undefined) return lit(0);
        return { c: code, t: 'any', pure: true };
      }
      case 'op':
        return this.op(e, cx);
    }
  }

  private op(e: Extract<Expr, { k: 'op' }>, cx: ExprCtx): C {
    const I = (n: string) => this.ex(e.in[n], cx);
    const pure = !exprImpure(e);
    const r = (c: string, t: Ty): C => ({ c, t, pure });
    const bin = (a: string, b: string): [C, C] => {
      const A = I(a);
      const B = I(b);
      return [A, B];
    };
    switch (e.op) {
      case 'operator_add': case 'operator_subtract': case 'operator_multiply': case 'operator_divide': {
        const [A, B] = bin('NUM1', 'NUM2');
        const sym = { operator_add: '+', operator_subtract: '-', operator_multiply: '*', operator_divide: '/' }[e.op]!;
        if (A.lit && B.lit) {
          const a = toNumberLit(A.lit.v);
          const b = toNumberLit(B.lit.v);
          const v = sym === '+' ? a + b : sym === '-' ? a - b : sym === '*' ? a * b : a / b;
          return lit(v);
        }
        this.checkOrder(e, ['NUM1', 'NUM2']);
        return r(`(${num(A)} ${sym} ${num(B)})`, 'num');
      }
      case 'operator_mod': {
        const [A, B] = bin('NUM1', 'NUM2');
        this.checkOrder(e, ['NUM1', 'NUM2']);
        return r(`mod(${num(A)}, ${num(B)})`, 'num');
      }
      case 'operator_round':
        return r(`Math.round(${num(I('NUM'))})`, 'nn');
      case 'operator_mathop': {
        const A = num(I('NUM'));
        const op = String(e.f.OPERATOR).toLowerCase();
        switch (op) {
          case 'abs': return r(`Math.abs(${A})`, 'nn');
          case 'floor': return r(`Math.floor(${A})`, 'nn');
          case 'ceiling': return r(`Math.ceil(${A})`, 'nn');
          case 'sqrt': return r(`Math.sqrt(${A})`, 'num');
          case 'sin': return r(`sin(${A})`, 'num');
          case 'cos': return r(`cos(${A})`, 'num');
          default: return r(`mathop(${JSON.stringify(op)}, ${A})`, 'num');
        }
      }
      case 'operator_random': {
        const [A, B] = bin('FROM', 'TO');
        this.checkOrder(e, ['FROM', 'TO']);
        return { c: `rt.pickRandom(${A.c}, ${B.c})`, t: 'num', pure: false };
      }
      case 'operator_equals': case 'operator_lt': case 'operator_gt': {
        const [A, B] = bin('OPERAND1', 'OPERAND2');
        if (A.lit && B.lit) {
          const c = compareLit(A.lit.v, B.lit.v);
          return lit(e.op === 'operator_equals' ? c === 0 : e.op === 'operator_lt' ? c < 0 : c > 0);
        }
        this.checkOrder(e, ['OPERAND1', 'OPERAND2']);
        const fn = e.op === 'operator_equals' ? 'eq' : e.op === 'operator_lt' ? 'lt' : 'gt';
        return r(`${fn}(${A.c}, ${B.c})`, 'bool');
      }
      case 'operator_and': case 'operator_or': {
        const [A, B] = bin('OPERAND1', 'OPERAND2');
        // 编译代码会对两者短路，因此右侧只在左侧无法决定时求值。
        // 解释器会求值两侧，当一侧抽取随机数或测试接触边缘时这一点很重要。
        const sym = e.op === 'operator_and' ? '&&' : '||';
        if (COMPILED || (A.pure && B.pure)) {
          if (COMPILED) this.checkOrder(e, ['OPERAND1', 'OPERAND2']);
          return r(`(${bool(A)} ${sym} ${bool(B)})`, 'bool');
        }
        this.checkOrder(e, ['OPERAND1', 'OPERAND2']);
        return r(`${e.op === 'operator_and' ? 'and' : 'or'}(${A.c}, ${B.c})`, 'bool');
      }
      case 'operator_not':
        return r(`!${bool(I('OPERAND'))}`, 'bool');
      case 'operator_join': {
        const [A, B] = bin('STRING1', 'STRING2');
        if (A.lit && B.lit) return lit(String(A.lit.v) + String(B.lit.v));
        this.checkOrder(e, ['STRING1', 'STRING2']);
        return r(`(${str(A)} + ${str(B)})`, 'str');
      }
      case 'operator_letter_of': {
        const [A, B] = bin('LETTER', 'STRING');
        this.checkOrder(e, ['LETTER', 'STRING']);
        return r(`letterOf(${A.c}, ${B.c})`, 'str');
      }
      case 'operator_length':
        return r(`${str(I('STRING'))}.length`, 'nn');
      case 'operator_contains': {
        const [A, B] = bin('STRING1', 'STRING2');
        this.checkOrder(e, ['STRING1', 'STRING2']);
        return r(`contains(${A.c}, ${B.c})`, 'bool');
      }
      case 'data_itemoflist':
        return r(`item(${this.ref(e.f.LIST as StoreRef)}, ${I('INDEX').c})`, 'any');
      case 'data_itemnumoflist':
        return r(`indexOf(${this.ref(e.f.LIST as StoreRef)}, ${I('ITEM').c})`, 'nn');
      case 'data_lengthoflist':
        return r(`${this.ref(e.f.LIST as StoreRef)}.length`, 'nn');
      case 'data_listcontainsitem':
        return r(`listContains(${this.ref(e.f.LIST as StoreRef)}, ${I('ITEM').c})`, 'bool');
      case 'looks_costumenumbername':
        return e.f.NUMBER_NAME === 'number' ? r('t.costumeNumber()', 'nn') : r('t.costumeName()', 'str');
      case 'looks_backdropnumbername':
        return e.f.NUMBER_NAME === 'number' ? r('G.costumeNumber()', 'nn') : r('G.costumeName()', 'str');
      case 'looks_size':
        return r('t.getSize()', 'nn');
      case 'motion_xposition':
        return r('t.xPosition()', 'nn');
      case 'motion_yposition':
        return r('t.yPosition()', 'nn');
      case 'motion_direction':
        return r('t.direction', 'nn');
      case 'sensing_mousex':
        return r('rt.io.mouseX', 'nn');
      case 'sensing_mousey':
        return r('rt.io.mouseY', 'nn');
      case 'sensing_mousedown':
        return r('rt.io.mouseDown', 'bool');
      case 'sensing_timer':
        return r('rt.timer()', 'nn');
      case 'sensing_keypressed':
        return r(`rt.keyPressed(${I('KEY_OPTION').c})`, 'bool');
      case 'sensing_of':
        return r(`rt.attributeOf(${JSON.stringify(e.f.PROPERTY)}, ${I('OBJECT').c})`, 'any');
      case 'sensing_distanceto':
        return r(`rt.distanceTo(t, ${I('DISTANCETOMENU').c})`, 'nn');
      case 'sensing_username':
        return r('rt.username', 'str');
      case 'sensing_dayssince2000':
        return r('rt.daysSince2000()', 'nn');
      case 'sensing_touchingobject':
        return r(`rt.touching(t, ${I('TOUCHINGOBJECTMENU').c})`, 'bool');
      case 'sensing_current':
        return r(`rt.current(${JSON.stringify(e.f.CURRENTMENU)})`, 'nn');
      case 'sensing_answer':
        return r('rt.answer', 'str');
      case 'sound_volume':
        return r('t.volume', 'nn');
    }
    this.errors.push(`unsupported reporter ${e.op} (${e.id})`);
    return r(`unsupported(${JSON.stringify(e.op)})`, 'any');
  }

  /** 两个非纯输入求值顺序与源码不同时记录问题。 */
  private checkOrder(e: Extract<Expr, { k: 'op' }>, emitted: string[]): void {
    const impure = e.inOrder.filter((k) => exprImpure(e.in[k]));
    if (impure.length < 2) return;
    const emittedImpure = emitted.filter((k) => impure.includes(k));
    if (emittedImpure.join() !== impure.join()) this.errors.push(`evaluation order differs for ${e.op} ${e.id}`);
  }

  // ---------------------------------------------------------------- 简单语句（不挂起）

  /** 永不挂起的语句列表代码，已知惯用法替换为辅助函数调用。 */
  simpleSeq(stmts: Stmt[], cx: ExprCtx, mode: Mode, stopCode: string, ind: string, out: string[]): void {
    for (let i = 0; i < stmts.length; i++) {
      const split = mode === 'W' ? splitIdiom(stmts, i) : null;
      if (split) {
        const word = this.ref(split.word);
        const counter = this.ref(split.counter);
        out.push(`${ind}({ word: ${word}, next: ${counter} } = splitWords(${this.ex(split.input, cx).c}, ${this.ex(split.sep, cx).c}, ${this.ref(split.list)}));`);
        i += 3;
        continue;
      }
      this.simple(stmts[i], cx, mode, stopCode, ind, out);
    }
  }

  /** 永不挂起的单条语句代码。`stopCode` 是 `stop this script` 转换后的内容。 */
  simple(s: Stmt, cx: ExprCtx, mode: Mode, stopCode: string, ind: string, out: string[]): void {
    const I = (n: string) => (s.k === 'op' ? this.ex(s.in[n], cx) : lit(undefined));
    const E = (code: string) => out.push(`${ind}${code}`);
    switch (s.k) {
      case 'if': {
        E(`if (${bool(this.ex(s.cond, cx))}) {`);
        this.simpleSeq(s.then, cx, mode, stopCode, `${ind}  `, out);
        if (s.else && s.else.length) {
          E('} else {');
          this.simpleSeq(s.else, cx, mode, stopCode, `${ind}  `, out);
        }
        E('}');
        return;
      }
      case 'repeat': {
        const v = `i${++this.counter}`;
        const times = this.ex(s.times, cx);
        if (times.pure) {
          const init = times.lit ? String(Math.round(toNumberLit(times.lit.v))) : `Math.round(${num(times)})`;
          E(`for (let ${v} = ${init}; ${v}-- > 0; ) {`);
          this.simpleSeq(s.body, cx, mode, stopCode, `${ind}  `, out);
          E('}');
        } else {
          // 编译代码只求值计数一次，解释器每次循环都重新求值。
          E(`for (let ${v} = Math.round(${num(times)}); ${COMPILED ? `${v}-- > 0` : ''}; ) {`);
          if (!COMPILED) E(`  if (!(${v}-- > 0)) break;`);
          this.simpleSeq(s.body, cx, mode, stopCode, `${ind}  `, out);
          if (!COMPILED) E(`  ${times.c};`);
          E('}');
        }
        return;
      }
      case 'until':
        E(`while (!${bool(this.ex(s.cond, cx))}) {`);
        this.simpleSeq(s.body, cx, mode, stopCode, `${ind}  `, out);
        E('}');
        return;
      case 'forever':
        E('for (;;) {');
        this.simpleSeq(s.body, cx, mode, stopCode, `${ind}  `, out);
        E('}');
        return;
      case 'call': {
        const call = this.plainCall(s, cx);
        if (call) E(`${call};`);
        return;
      }
    }
    const f = s.f;
    switch (s.op) {
      case 'data_setvariableto': {
        const r = this.ref(f.VARIABLE as StoreRef);
        E(`${r} = ${I('VALUE').c};`);
        this.cloudWrite(f.VARIABLE as StoreRef, E);
        return;
      }
      case 'data_changevariableby': {
        const r = this.ref(f.VARIABLE as StoreRef);
        E(`${r} = num(${r}) + ${num(I('VALUE'))};`);
        this.cloudWrite(f.VARIABLE as StoreRef, E);
        return;
      }
      case 'data_addtolist':
        E(`addTo(${this.ref(f.LIST as StoreRef)}, ${I('ITEM').c});`);
        return;
      case 'data_deleteoflist':
        E(`deleteOf(${this.ref(f.LIST as StoreRef)}, ${I('INDEX').c});`);
        return;
      case 'data_deletealloflist':
        E(`deleteAll(${this.ref(f.LIST as StoreRef)});`);
        return;
      case 'data_insertatlist':
        this.orderCheckStmt(s, ['ITEM', 'INDEX']);
        E(`insertAt(${this.ref(f.LIST as StoreRef)}, ${I('INDEX').c}, ${I('ITEM').c});`);
        return;
      case 'data_replaceitemoflist':
        this.orderCheckStmt(s, ['INDEX', 'ITEM']);
        E(`replaceItem(${this.ref(f.LIST as StoreRef)}, ${I('INDEX').c}, ${I('ITEM').c});`);
        return;
      case 'data_showlist':
        E(`rt.showList(${JSON.stringify((f.LIST as StoreRef).prop)});`);
        return;
      case 'data_hidelist':
        E(`rt.hideList(${JSON.stringify((f.LIST as StoreRef).prop)});`);
        return;
      case 'motion_gotoxy':
        this.orderCheckStmt(s, ['X', 'Y']);
        E(`t.setXY(${num(I('X'))}, ${num(I('Y'))});`);
        return;
      case 'motion_setx':
        E(`t.setXY(${num(I('X'))}, t.y);`);
        return;
      case 'motion_sety':
        E(`t.setXY(t.x, ${num(I('Y'))});`);
        return;
      case 'motion_changexby':
        E(`t.setXY(t.x + ${num(I('DX'))}, t.y);`);
        return;
      case 'motion_changeyby':
        E(`t.setXY(t.x, t.y + ${num(I('DY'))});`);
        return;
      case 'motion_pointindirection':
        E(`t.setDirection(${num(I('DIRECTION'))});`);
        return;
      case 'motion_turnright':
        E(`t.setDirection(t.direction + ${num(I('DEGREES'))});`);
        return;
      case 'motion_pointtowards':
        E(`t.pointTowards(${I('TOWARDS').c});`);
        return;
      case 'motion_turnleft':
        E(`t.setDirection(t.direction - ${num(I('DEGREES'))});`);
        return;
      case 'motion_movesteps':
        E(`t.moveSteps(${I('STEPS').c});`);
        return;
      case 'motion_goto':
        E(`rt.goTo(t, ${I('TO').c});`);
        return;
      case 'motion_ifonedgebounce':
        E('rt.ifOnEdgeBounce(t);');
        return;
      case 'looks_goforwardbackwardlayers':
        E(`t.goLayers(${JSON.stringify(f.FORWARD_BACKWARD)}, ${I('NUM').c});`);
        return;
      case 'looks_say':
        E(`rt.say(t, ${I('MESSAGE').c});`);
        return;
      case 'looks_nextbackdrop':
        E('rt.nextBackdrop();');
        return;
      case 'sensing_resettimer':
        E('rt.resetTimer();');
        return;
      case 'sound_cleareffects':
        E('rt.clearSoundEffects(t);');
        return;
      case 'data_showvariable':
        E(`rt.showVariable(${JSON.stringify(this.monitorKey(f.VARIABLE as StoreRef))});`);
        return;
      case 'data_hidevariable':
        E(`rt.hideVariable(${JSON.stringify(this.monitorKey(f.VARIABLE as StoreRef))});`);
        return;
      case 'motion_setrotationstyle':
        E(`t.setRotationStyle(${JSON.stringify(f.STYLE)});`);
        return;
      case 'looks_switchcostumeto':
        E(`t.switchCostume(${I('COSTUME').c});`);
        return;
      case 'looks_nextcostume':
        E('t.nextCostume();');
        return;
      case 'looks_switchbackdropto':
        E(`rt.switchBackdrop(${I('BACKDROP').c});`);
        return;
      case 'looks_setsizeto':
        E(`t.setSize(${num(I('SIZE'))});`);
        return;
      case 'looks_changesizeby':
        E(`t.setSize(t.size + ${num(I('CHANGE'))});`);
        return;
      case 'looks_seteffectto':
        E(`t.setEffect(${JSON.stringify(String(f.EFFECT).toLowerCase())}, ${I('VALUE').c});`);
        return;
      case 'looks_changeeffectby':
        E(`t.changeEffect(${JSON.stringify(String(f.EFFECT).toLowerCase())}, ${I('CHANGE').c});`);
        return;
      case 'looks_cleargraphiceffects':
        E('t.clearEffects();');
        return;
      case 'looks_show':
        E('t.show();');
        return;
      case 'looks_hide':
        E('t.hide();');
        return;
      case 'looks_gotofrontback':
        E(`t.goToFrontBack(${JSON.stringify(f.FRONT_BACK)});`);
        return;
      case 'pen_clear':
        E('rt.penClear();');
        return;
      case 'pen_stamp':
        E('t.stamp();');
        return;
      case 'pen_penDown':
        E('t.penDown();');
        return;
      case 'pen_penUp':
        E('t.penUp();');
        return;
      case 'pen_setPenColorToColor':
        E(`t.setPenColorToColor(${I('COLOR').c});`);
        return;
      case 'pen_setPenColorParamTo':
        this.orderCheckStmt(s, ['COLOR_PARAM', 'VALUE']);
        E(`t.setPenColorParam(${I('COLOR_PARAM').c}, ${I('VALUE').c}, false);`);
        return;
      case 'pen_changePenColorParamBy':
        this.orderCheckStmt(s, ['COLOR_PARAM', 'VALUE']);
        E(`t.setPenColorParam(${I('COLOR_PARAM').c}, ${I('VALUE').c}, true);`);
        return;
      case 'pen_setPenSizeTo':
        E(`t.setPenSize(${I('SIZE').c});`);
        return;
      case 'pen_changePenSizeBy':
        E(`t.changePenSize(${I('SIZE').c});`);
        return;
      case 'sound_play':
        E(`rt.startSound(t, ${I('SOUND_MENU').c});`);
        return;
      case 'sound_stopallsounds':
        E('rt.stopAllSounds();');
        return;
      case 'event_broadcast':
        E(`rt.broadcast(${str(I('BROADCAST_INPUT'))});`);
        return;
      case 'control_create_clone_of':
        E(`rt.createClone(t, ${I('CLONE_OPTION').c});`);
        return;
      case 'control_delete_this_clone':
        E('rt.deleteThisClone(t);');
        return;
      case 'control_stop':
        if (f.STOP_OPTION === 'this script') E(stopCode);
        else if (f.STOP_OPTION === 'other scripts in sprite' || f.STOP_OPTION === 'other scripts in stage') E('rt.stopOtherScripts(t, rt.activeThread);');
        else E('rt.stopAll(); throw KILLED;');
        return;
    }
    this.errors.push(`unsupported statement ${s.op} (${s.id}) in mode ${mode}`);
    E(`unsupported(${JSON.stringify(s.op)});`);
  }

  private orderCheckStmt(s: Extract<Stmt, { k: 'op' }>, emitted: string[]): void {
    const impure = s.inOrder.filter((k) => exprImpure(s.in[k]));
    if (impure.length < 2) return;
    if (emitted.filter((k) => impure.includes(k)).join() !== impure.join()) this.errors.push(`evaluation order differs for ${s.op} ${s.id}`);
  }

  /** 按参数顺序排列的调用参数，并对非纯输入进行源码顺序检查。 */
  callArgs(s: Extract<Stmt, { k: 'call' }>, cx: ExprCtx): { args: string[]; impure: boolean } {
    const proto = this.t.protos.get(s.proc);
    if (!proto) return { args: [], impure: false };
    const args = proto.ids.map((id, i) => {
      const e = s.args[id];
      if (e === undefined) return litCode(proto.defaults[i] as Lit);
      return this.ex(e, cx).c;
    });
    const impureIds = s.inOrder.filter((k) => exprImpure(s.args[k]));
    if (impureIds.length >= 2) {
      const emitted = proto.ids.filter((id) => impureIds.includes(id));
      if (emitted.join() !== impureIds.join()) this.errors.push(`evaluation order differs for call ${s.proc} ${s.id}`);
    }
    // 不是参数的输入在原版中仍会求值。
    for (const k of s.inOrder) {
      if (!proto.ids.includes(k) && exprImpure(s.args[k])) this.errors.push(`impure input that is not a parameter in call ${s.proc}`);
    }
    return { args, impure: impureIds.length > 0 };
  }

  plainCall(s: Extract<Stmt, { k: 'call' }>, cx: ExprCtx): string | null {
    const p = this.t.procs.get(s.proc);
    if (!p) {
      const { args } = this.callArgs(s, cx);
      const sideEffects = args.filter((a) => a.includes('rt.pickRandom'));
      return sideEffects.length ? sideEffects.join(', ') : null;
    }
    this.plainNeeded.add(p.proccode);
    const { args } = this.callArgs(s, cx);
    return `${this.plainName(p)}(${['t', ...args].join(', ')})`;
  }

  /** 变量监视器的键：属性名，自己的变量前面加上角色名。 */
  monitorKey(ref: StoreRef): string {
    return ref.scope === 'global' ? ref.prop : `${this.t.name}.${ref.prop}`;
  }

  plainName(p: ProcIR): string {
    return `p_${p.fname}`;
  }

  // ---------------------------------------------------------------- 普通过程

  /** 正在生成主体的过程，供少数生成方式不同的积木使用。 */
  currentProc: string | null = null;

  genPlainProc(p: ProcIR): string {
    this.currentProc = p.proccode;
    const used = new Set<string>(['t']);
    const params: string[] = [];
    const args = new Map<string, string>();
    p.argNames.forEach((n) => {
      const id = sanitize(`a_${n}`, used, 'a');
      params.push(id);
      args.set(n, id);
    });
    const out: string[] = [];
    // NATIVE_PROCS 中的自定义积木会运行运行时持有的 TypeScript 版本（若存在），然后
    // 只有在那个版本返回 false 时才运行自己的积木。
    if (PROBE) out.push(`    if (rt.probe) rt.probe(${JSON.stringify(p.proccode)}, [${params.join(', ')}]);`);
    if (NATIVE_PROCS.has(p.proccode)) out.push(`    { const nat = rt.natives[${JSON.stringify(`${this.t.name}/${p.proccode}`)}]; if (nat && nat(t, [${params.join(', ')}]) !== false) return; }`);
    this.simpleSeq(p.body, { args }, 'W', 'return;', '    ', out);
    const sig = ['t: T', ...params.map((x) => `${x}: Value`)].join(', ');
    return `  /** define ${p.proccode.replace(/\*\//g, '* /')} */\n  function ${this.plainName(p)}(${sig}): void {\n${out.join('\n')}\n  }\n`;
  }

  // ---------------------------------------------------------------- 可恢复单元

  /** 语句列表在给定模式下能否挂起。 */
  suspends(stmts: Stmt[], mode: Mode): boolean {
    let found = false;
    walk(stmts, (s) => {
      if (found) return;
      if (s.k === 'repeat' || s.k === 'until' || s.k === 'forever') {
        if (mode !== 'W') found = true;
      } else if (s.k === 'op' && (PROMISE_OPS.has(s.op) || WAIT_OPS.has(s.op))) found = true;
      else if (s.k === 'call') {
        const p = this.t.procs.get(s.proc);
        if (!p) return;
        if (p.warp) found ||= !!this.an.suspW.get(s.proc);
        else if (mode === 'N') found ||= !!this.an.suspN.get(s.proc);
        else if (mode === 'W') found ||= !!this.an.suspW.get(s.proc);
        else found ||= !!this.an.suspN.get(s.proc) || !!this.an.suspW.get(s.proc);
      }
    });
    return found;
  }

  /** 需要 Promise 续接目标的语句。 */
  needsPct(s: Stmt, mode: Mode): boolean {
    let found = false;
    walk([s], (x) => {
      if (x.k === 'op' && PROMISE_OPS.has(x.op)) found = true;
      if (x.k === 'call') {
        const p = this.t.procs.get(x.proc);
        if (p && this.callIsResumable(p, mode)) found = true;
      }
    });
    return found;
  }

  callIsResumable(p: ProcIR, mode: Mode): boolean {
    if (p.warp) return !!this.an.suspW.get(p.proccode);
    if (mode === 'N') return !!this.an.suspN.get(p.proccode);
    if (mode === 'W') return !!this.an.suspW.get(p.proccode);
    return !!this.an.suspN.get(p.proccode) || !!this.an.suspW.get(p.proccode);
  }

  unitName(p: ProcIR, ctx: 'N' | 'W'): string {
    const e = this.unitNames.get(p.proccode) ?? {};
    if (!e[ctx]) {
      e[ctx] = `U_${p.fname}_${ctx === 'N' ? 'nowarp' : 'warp'}`;
      this.unitNames.set(p.proccode, e);
    }
    return e[ctx]!;
  }

  /** 在 `ctx` 中进入时，过程可恢复变体的模式。 */
  unitMode(p: ProcIR, ctx: 'N' | 'W'): Mode {
    if (!p.warp) return ctx === 'N' ? 'N' : 'W';
    // 编译代码在 Promise 积木之后仍保持 warp 模式。在解释器中，warp 过程在
    // Promise 续接落到其顶层且调用方不在 warp 模式后会变为非 warp。
    if (COMPILED) return 'W';
    const lands = p.body.some((s, i) => i < p.body.length - 1 && this.needsPct(s, 'W'));
    return lands ? 'D' : 'W';
  }

  genUnit(name: string, title: string, body: Stmt[], mode: Mode, isProc: boolean, cx: ExprCtx, proc: string | null = null): string {
    const w = new UnitWriter();
    const entry = w.label();
    w.ref(entry);
    w.place(entry);
    if (PROBE && isProc && proc) w.emit(`if (rt.probe) rt.probe(${JSON.stringify(proc)}, f.a);`);
    const endCode = isProc ? 'return Ctl.Return;' : 'return Ctl.End;';
    const stopCode = isProc ? 'return Ctl.StopReturn;' : 'return Ctl.End;';
    this.rseq(w, body, mode, cx, { label: null }, true, stopCode);
    w.emit(endCode);
    const lines: string[] = [];
    for (const l of w.lines) {
      if (typeof l === 'string') lines.push(`        ${l}`);
      else if (l.used) lines.push(`      case ${l.n}:`);
    }
    return `  /** ${title.replace(/\*\//g, '* /')} */\n  const ${name} = rt.unit(${JSON.stringify(`${this.t.name}/${title}`)}, ${JSON.stringify(proc)}, (th, f) => {\n    const t = th.target as T;\n    for (;;) {\n      switch (f.pc) {\n${lines.join('\n')}\n      }\n    }\n  });\n`;
  }

  private pctCode(w: UnitWriter, pct: Pct): string {
    return pct.label ? String(w.ref(pct.label)) : 'PC_FALL_OFF';
  }

  /** `depth` 统计这些语句周围的分支数，每个分支在原版的积木栈上占一项。 */
  private rseq(w: UnitWriter, stmts: Stmt[], mode: Mode, cx: ExprCtx, pctEnd: Pct, bodyLevel: boolean, stopCode: string, depth = 0): void {
    let pendingLabel: Label | null = null;
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      if (pendingLabel) {
        w.place(pendingLabel);
        pendingLabel = null;
      }
      let pct: Pct = pctEnd;
      if (i < stmts.length - 1 && this.needsPct(s, mode)) {
        const next = w.label();
        pendingLabel = next;
        if (mode === 'D' && bodyLevel) {
          // 落到过程顶层时会继承调用方的 warp 标志。
          const land = w.label();
          pct = { label: land };
          this.rstmt(w, s, mode, cx, pct, stopCode, depth);
          w.emit(`f.pc = ${w.ref(next)}; continue;`);
          w.place(land);
          w.emit('f.warp = f.pw;');
          continue;
        }
        pct = { label: next };
      }
      this.rstmt(w, s, mode, cx, pct, stopCode, depth);
    }
    if (pendingLabel) w.place(pendingLabel);
  }

  private loopEnd(w: UnitWriter, head: Label, mode: Mode): void {
    if (mode === 'N') w.emit(`f.pc = ${w.ref(head)}; return Ctl.Yield;`);
    else if (mode === 'D') w.emit(`f.pc = ${w.ref(head)}; if (!f.warp) return Ctl.Yield; continue;`);
    else w.emit(`f.pc = ${w.ref(head)}; continue;`);
  }

  private rstmt(w: UnitWriter, s: Stmt, mode: Mode, cx: ExprCtx, pct: Pct, stopCode: string, depth: number): void {
    if (!this.suspends([s], mode)) {
      const out: string[] = [];
      this.simple(s, cx, mode, stopCode, '', out);
      for (const l of out) w.emit(l);
      return;
    }
    switch (s.k) {
      case 'if': {
        const after = w.label();
        const elseL = s.else && s.else.length ? w.label() : null;
        w.emit(`if (!${bool(this.ex(s.cond, cx))}) { f.pc = ${w.ref(elseL ?? after)}; continue; }`);
        this.rseq(w, s.then, mode, cx, pct, false, stopCode, depth + 1);
        if (elseL) {
          w.emit(`f.pc = ${w.ref(after)}; continue;`);
          w.place(elseL);
          this.rseq(w, s.else!, mode, cx, pct, false, stopCode, depth + 1);
        }
        w.place(after);
        return;
      }
      case 'repeat': {
        const k = w.local();
        const head = w.label();
        const after = w.label();
        const times = this.ex(s.times, cx);
        // 编译代码在第一次循环前只求值计数一次。解释器每次
        // 循环都重新求值，并保留第一次的值。
        if (COMPILED) {
          w.emit(`f.l[${k}] = Math.round(${num(times)});`);
          w.place(head);
        } else {
          w.emit(`f.l[${k}] = undefined;`);
          w.place(head);
          if (times.pure) w.emit(`if (f.l[${k}] == null) f.l[${k}] = Math.round(${num(times)});`);
          else w.emit(`{ const n = Math.round(${num(times)}); if (f.l[${k}] == null) f.l[${k}] = n; }`);
        }
        w.emit(`f.l[${k}] = f.l[${k}]! - 1;`);
        w.emit(`if (!(f.l[${k}]! >= 0)) { f.pc = ${w.ref(after)}; continue; }`);
        this.rseq(w, s.body, mode, cx, { label: head }, false, stopCode, depth + 1);
        this.loopEnd(w, head, mode);
        w.place(after);
        return;
      }
      case 'until': {
        const head = w.label();
        const after = w.label();
        w.place(head);
        w.emit(`if (${bool(this.ex(s.cond, cx))}) { f.pc = ${w.ref(after)}; continue; }`);
        this.rseq(w, s.body, mode, cx, { label: head }, false, stopCode, depth + 1);
        this.loopEnd(w, head, mode);
        w.place(after);
        return;
      }
      case 'forever': {
        const head = w.label();
        w.place(head);
        this.rseq(w, s.body, mode, cx, { label: head }, false, stopCode, depth + 1);
        this.loopEnd(w, head, mode);
        return;
      }
      case 'call': {
        const p = this.t.procs.get(s.proc)!;
        const next = w.label();
        const { args, impure } = this.callArgs(s, cx);
        void impure;
        // 编译代码会让在 Promise 积木中结束的自定义积木从调用方的下一条积木继续，因此
        // 调用方循环仍会在末尾 yield。解释器则从调用方自己的 Promise 处继续。
        const pcpCode = COMPILED ? String(w.ref(next)) : this.pctCode(w, pct);
        if (p.warp) {
          const unit = this.unitName(p, 'W');
          w.emit(`return rt.call(th, f, ${unit}, [${args.join(', ')}], true, ${w.ref(next)}, ${pcpCode}, ${w.ref(next)}, ${depth});`);
        } else if (mode === 'N') {
          const unit = this.unitName(p, 'N');
          w.emit(`return rt.call(th, f, ${unit}, [${args.join(', ')}], false, ${w.ref(next)}, ${pcpCode}, ${w.ref(next)}, ${depth});`);
        } else if (mode === 'W') {
          const unit = this.unitName(p, 'W');
          w.emit(`return rt.call(th, f, ${unit}, [${args.join(', ')}], true, ${w.ref(next)}, ${pcpCode}, ${w.ref(next)}, ${depth});`);
        } else {
          // 动态 warp：被调用方按此单元当前所处的模式运行。
          const plainOk = !this.an.suspW.get(p.proccode);
          const unitN = this.an.suspN.get(p.proccode) ? this.unitName(p, 'N') : null;
          const wPart = plainOk
            ? `${this.plainCall(s, cx)};`
            : `return rt.call(th, f, ${this.unitName(p, 'W')}, [${args.join(', ')}], true, ${w.ref(next)}, ${pcpCode}, ${w.ref(next)}, ${depth});`;
          const nPart = unitN
            ? `return rt.call(th, f, ${unitN}, [${args.join(', ')}], false, ${w.ref(next)}, ${pcpCode}, ${w.ref(next)}, ${depth});`
            : `${this.plainCall(s, cx)};`;
          w.emit(`if (f.warp) { ${wPart} } else { ${nPart} }`);
        }
        w.place(next);
        return;
      }
    }
    const I = (n: string) => this.ex(s.in[n], cx);
    switch (s.op) {
      case 'control_wait': {
        const k = w.local();
        w.local();
        const chk = w.label();
        const dur = I('DURATION');
        w.emit(`f.l[${k}] = rt.currentMSecs; f.l[${k + 1}] = Math.max(0, 1000 * ${num(dur)});`);
        w.emit(`rt.requestRedraw(); f.pc = ${w.ref(chk)}; return Ctl.Yield;`);
        w.place(chk);
        // 解释器每一步都会重新求值持续时间，编译代码只求值一次。
        if (!COMPILED && !dur.pure) w.emit(`${dur.c};`);
        w.emit(`if (rt.currentMSecs - f.l[${k}]! < f.l[${k + 1}]!) return Ctl.Yield;`);
        return;
      }
      case 'event_broadcastandwait': {
        // 第一步求值消息并启动帽子；后续步骤只检查。
        const chk = w.label();
        const after = w.label();
        const msg = I('BROADCAST_INPUT');
        w.emit(`f.w = rt.broadcastStart(${msg.c}) ?? undefined; if (!f.w) { f.pc = ${w.ref(after)}; continue; }`);
        w.place(chk);
        w.emit(`{ const c = rt.broadcastWait(f.w!); if (c !== null) { f.pc = ${w.ref(chk)}; return c; } f.w = undefined; }`);
        w.place(after);
        return;
      }
      case 'motion_glidesecstoxy': {
        const k = w.local();
        for (let i = 0; i < 5; i++) w.local();
        const chk = w.label();
        const after = w.label();
        const secs = I('SECS'), x = I('X'), y = I('Y');
        w.emit(`f.l[${k}] = rt.currentMSecs; f.l[${k + 1}] = 1000 * ${num(secs)}; f.l[${k + 2}] = t.x; f.l[${k + 3}] = t.y; f.l[${k + 4}] = ${num(x)}; f.l[${k + 5}] = ${num(y)};`);
        w.emit(`if (f.l[${k + 1}]! <= 0) { t.setXY(f.l[${k + 4}]!, f.l[${k + 5}]!); f.pc = ${w.ref(after)}; continue; }`);
        w.emit(`f.pc = ${w.ref(chk)}; return Ctl.Yield;`);
        w.place(chk);
        if (!COMPILED) for (const e of [secs, x, y]) if (!e.pure) w.emit(`${e.c};`);
        w.emit(`if (rt.glideStep(t, f.l[${k + 2}]!, f.l[${k + 3}]!, f.l[${k + 4}]!, f.l[${k + 5}]!, rt.currentMSecs - f.l[${k}]!, f.l[${k + 1}]!)) return Ctl.Yield;`);
        w.place(after);
        return;
      }
      case 'control_wait_until': {
        const chk = w.label();
        w.place(chk);
        w.emit(`if (!${bool(I('CONDITION'))}) { f.pc = ${w.ref(chk)}; return Ctl.Yield; }`);
        return;
      }
      case 'sound_setvolumeto':
        w.emit(`rt.setVolume(t, ${I('VOLUME').c}); f.pc = ${this.pctCode(w, pct)}; return rt.suspend(th);`);
        return;
      case 'sound_changevolumeby':
        w.emit(`rt.changeVolume(t, ${I('VOLUME').c}); f.pc = ${this.pctCode(w, pct)}; return rt.suspend(th);`);
        return;
      case 'sound_seteffectto':
      case 'sound_changeeffectby': {
        const change = s.op === 'sound_changeeffectby';
        w.emit(`if (rt.soundEffect(t, ${JSON.stringify(s.f.EFFECT)}, ${I('VALUE').c}, ${change})) { f.pc = ${this.pctCode(w, pct)}; return rt.suspend(th); }`);
        return;
      }
      case 'sound_playuntildone':
        w.emit(`if (rt.playUntilDone(th, t, ${I('SOUND_MENU').c})) { f.pc = ${this.pctCode(w, pct)}; return Ctl.Promise; }`);
        return;
      case 'sensing_askandwait':
        w.emit(`f.pc = ${this.pctCode(w, pct)}; return rt.ask(th, t, ${I('QUESTION').c});`);
        return;
    }
    this.errors.push(`unsupported suspending statement ${s.op}`);
  }

  // ---------------------------------------------------------------- 模块

  generate(): string {
    const t = this.t;
    const body: string[] = [];
    const scriptDefs: string[] = [];

    t.scripts.forEach((s: ScriptIR, i: number) => {
      const title = s.hat === 'flag' ? 'when flag clicked' : s.hat === 'clone' ? 'when I start as a clone' : s.hat === 'key' ? `when key ${s.msg} pressed` : s.hat === 'click' ? 'when clicked' : s.hat === 'timer' ? `when ${s.msg} > ${s.value}` : `when I receive ${s.msg}`;
      const head = `hat: '${s.hat}', ${s.msg !== undefined ? `msg: ${JSON.stringify(s.msg)}, ` : ''}${s.value !== undefined ? `value: ${JSON.stringify(s.value)}, ` : ''}top: ${JSON.stringify(s.top)}`;
      if (this.suspends(s.body, 'N')) {
        const name = `S${i}`;
        body.push(this.genUnit(name, `${title} #${i}`, s.body, 'N', false, { args: null }));
        scriptDefs.push(`{ ${head}, unit: ${name} }`);
      } else {
        const out: string[] = [];
        this.simpleSeq(s.body, { args: null }, 'N', 'return;', '    ', out);
        const name = `s${i}`;
        body.push(`  /** ${title} #${i} */\n  function ${name}(t: T): void {\n${out.join('\n')}\n  }\n`);
        scriptDefs.push(`{ ${head}, plain: ${name} as (t: Target) => void }`);
      }
    });

    // 目前请求的可恢复过程变体可能继续请求更多；迭代到稳定为止。
    const doneUnits = new Set<string>();
    for (let progress = true; progress; ) {
      progress = false;
      for (const [code, e] of [...this.unitNames]) {
        const p = t.procs.get(code)!;
        for (const ctx of ['N', 'W'] as const) {
          const name = e[ctx];
          if (!name || doneUnits.has(name)) continue;
          doneUnits.add(name);
          progress = true;
          const args = new Map<string, string>();
          p.argNames.forEach((n, i) => args.set(n, `f.a[${i}]`));
          body.push(this.genUnit(name, `define ${p.proccode} (${ctx === 'N' ? 'non-warp' : 'warp'} context)`, p.body, this.unitMode(p, ctx), true, { args }, p.proccode));
        }
      }
    }
    // 普通过程，包括只能从其他普通过程到达的过程。
    const donePlain = new Set<string>();
    for (let progress = true; progress; ) {
      progress = false;
      for (const code of [...this.plainNeeded]) {
        if (donePlain.has(code)) continue;
        donePlain.add(code);
        progress = true;
        body.push(this.genPlainProc(t.procs.get(code)!));
      }
    }
    for (const code of donePlain) {
      if (!EXPOSED_PROCS.has(code)) continue;
      const p = t.procs.get(code)!;
      body.push(`  rt.procs[${JSON.stringify(`${t.name}/${code}`)}] = (t, args) => ${this.plainName(p)}(${['t as T', ...p.argNames.map((_, i) => `args[${i}]`)].join(', ')});`);
    }

    const fileBody = body.join('\n');
    return this.moduleText(fileBody, scriptDefs);
  }

  private moduleText(fileBody: string, scriptDefs: string[]): string {
    const t = this.t;
    const varsIface = t.vars.map((v) => `  ${v.prop}: Value;`).join('\n');
    const listsIface = t.lists.map((v) => `  ${v.prop}: Value[];`).join('\n');
    const json = t.json;
    const stageImport = t.isStage ? '' : `import type { StageT } from './Stage_.ts';\n`;
    const stageType = t.isStage ? 'T' : 'StageT';
    return `// Generated by tools/transpile from target "${t.name.replace(/\n/g, ' ')}". Edit the generator, not this file.
/* eslint-disable */
import type { Value } from '../../engine/cast.ts';
import { num, bool, eq, lt, gt, and, or, mod, sin, cos, mathop, letterOf, contains, item, indexOf, listContains, listContents, addTo, deleteOf, deleteAll, insertAt, replaceItem, splitWords } from '../../engine/cast.ts';
import { Ctl, type SpriteDef, type ScriptDef } from '../../engine/defs.ts';
import type { Runtime } from '../../engine/runtime.ts';
import { KILLED } from '../../engine/runtime.ts';
import type { Target } from '../../engine/target.ts';
import { PC_FALL_OFF } from '../../engine/thread.ts';
import { costumes, sounds } from '../assets.ts';
${stageImport}
export interface Vars {
${varsIface}
}

export interface Lists {
${listsIface}
}

export type T = Target & { v: Vars; l: Lists };
${t.isStage ? 'export type StageT = T;\n' : ''}
export const def: SpriteDef = {
  name: ${JSON.stringify(t.name)},
  isStage: ${t.isStage},
  layerOrder: ${json.layerOrder ?? 0},
  x: ${json.x ?? 0},
  y: ${json.y ?? 0},
  direction: ${json.direction ?? 90},
  size: ${json.size ?? 100},
  currentCostume: ${json.currentCostume ?? 0},
  visible: ${json.visible ?? true},
  rotationStyle: ${JSON.stringify(json.rotationStyle ?? 'all around')},
  draggable: ${json.draggable ?? false},
  volume: ${json.volume ?? 100},
  vars: {
${t.vars.map((v) => `    ${v.prop}: ${litCode(v.value as Lit)},`).join('\n')}
  },
  lists: {
${t.lists.map((v) => `    ${v.prop}: ${JSON.stringify(v.value)},`).join('\n')}
  },
  varNames: {
${t.vars.filter((v, i) => t.vars.findIndex((x) => x.name === v.name) === i).map((v) => `    ${JSON.stringify(v.name)}: ${JSON.stringify(v.prop)},`).join('\n')}
  },
  varIds: {
${t.vars.map((v) => `    ${v.prop}: ${JSON.stringify(v.id)},`).join('\n')}
  },
  listIds: {
${t.lists.map((v) => `    ${v.prop}: ${JSON.stringify(v.id)},`).join('\n')}
  },
  listNames: {
${t.lists.filter((v, i) => t.lists.findIndex((x) => x.name === v.name) === i).map((v) => `    ${JSON.stringify(v.name)}: ${JSON.stringify(v.prop)},`).join('\n')}
  },
  fixedLists: ${JSON.stringify(this.fixedLists)},
  costumes: costumes(${t.index}),
  sounds: sounds(${t.index}),
  scripts: [],
};

export function build(rt: Runtime) {
  const G = rt.stage as ${stageType};
  void G; void KILLED; void PC_FALL_OFF;

${fileBody}
  const scripts: ScriptDef[] = [
${scriptDefs.map((d) => `    ${d},`).join('\n')}
  ];
  return { scripts };
}
`;
  }
}
