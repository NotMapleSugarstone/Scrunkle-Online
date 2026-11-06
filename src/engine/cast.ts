// 源项目运行时的值转换与运算符语义。
// 生成的游戏代码每次动态类型操作都会调用这些辅助函数。

import * as dm from './dmath.ts';
import { COMPILED } from './defs.ts';

export type Value = string | number | boolean;

export function toNumber(v: Value | undefined | null): number {
  if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

export function toBoolean(v: Value | undefined | null): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    return !(v === '' || v === '0' || v.toLowerCase() === 'false');
  }
  return Boolean(v);
}

export function toStr(v: Value | undefined | null): string {
  return String(v);
}

function isWhiteSpace(v: Value | undefined | null): boolean {
  return v === null || (typeof v === 'string' && v.trim().length === 0);
}

export function compare(v1: Value | undefined, v2: Value | undefined): number {
  if (typeof v1 === 'number' && typeof v2 === 'number' && v1 === v1 && v2 === v2) return v1 === v2 ? 0 : v1 - v2;
  let n1 = Number(v1);
  let n2 = Number(v2);
  if (n1 === 0 && isWhiteSpace(v1)) n1 = NaN;
  else if (n2 === 0 && isWhiteSpace(v2)) n2 = NaN;
  if (Number.isNaN(n1) || Number.isNaN(n2)) {
    const s1 = String(v1).toLowerCase();
    const s2 = String(v2).toLowerCase();
    if (s1 < s2) return -1;
    if (s1 > s2) return 1;
    return 0;
  }
  if ((n1 === Infinity && n2 === Infinity) || (n1 === -Infinity && n2 === -Infinity)) return 0;
  return n1 - n2;
}

export function eq(a: Value | undefined, b: Value | undefined): boolean {
  return a === b || compare(a, b) === 0;
}
export function lt(a: Value | undefined, b: Value | undefined): boolean {
  return compare(a, b) < 0;
}
export function gt(a: Value | undefined, b: Value | undefined): boolean {
  return compare(a, b) > 0;
}

export function isInt(v: Value | undefined): boolean {
  // 编译运行时将 Infinity 和 1e21 及以上的数字视为整数，解释器则不这样。
  if (typeof v === 'number') return Number.isNaN(v) ? true : COMPILED ? v === Math.floor(v) : v === parseInt(String(v), 10);
  if (typeof v === 'boolean') return true;
  if (typeof v === 'string') return v.indexOf('.') < 0;
  return false;
}

export function add(a: Value, b: Value): number {
  return toNumber(a) + toNumber(b);
}
export function sub(a: Value, b: Value): number {
  return toNumber(a) - toNumber(b);
}
export function mul(a: Value, b: Value): number {
  return toNumber(a) * toNumber(b);
}
export function div(a: Value, b: Value): number {
  return toNumber(a) / toNumber(b);
}
export function mod(a: Value, b: Value): number {
  const n = toNumber(a);
  const m = toNumber(b);
  let r = n % m;
  if (r / m < 0) r += m;
  return r;
}
export function round(a: Value): number {
  return Math.round(toNumber(a));
}

export function and(a: Value | undefined, b: Value | undefined): boolean {
  return toBoolean(a) && toBoolean(b);
}
export function or(a: Value | undefined, b: Value | undefined): boolean {
  return toBoolean(a) || toBoolean(b);
}
export function not(a: Value | undefined): boolean {
  return !toBoolean(a);
}

export function join(a: Value | undefined, b: Value | undefined): string {
  return String(a) + String(b);
}

export function letterOf(index: Value, s: Value): string {
  const i = toNumber(index) - 1;
  const str = String(s);
  if (i < 0 || i >= str.length) return '';
  return str.charAt(i);
}

export function length(s: Value): number {
  return String(s).length;
}

export function contains(a: Value, b: Value): boolean {
  return String(a).toLowerCase().includes(String(b).toLowerCase());
}

export function mathop(op: string, v: Value): number {
  const n = toNumber(v);
  switch (op) {
    case 'abs': return Math.abs(n);
    case 'floor': return Math.floor(n);
    case 'ceiling': return Math.ceil(n);
    case 'sqrt': return Math.sqrt(n);
    case 'sin': return round10(dm.sin((Math.PI * n) / 180));
    case 'cos': return round10(dm.cos((Math.PI * n) / 180));
    case 'tan': return tan(n);
    case 'asin': return (dm.asin(n) * 180) / Math.PI;
    case 'acos': return (dm.acos(n) * 180) / Math.PI;
    case 'atan': return (dm.atan(n) * 180) / Math.PI;
    case 'ln': return dm.log(n);
    case 'log': return dm.log(n) / Math.LN10;
    case 'e ^': return dm.exp(n);
    case '10 ^': return Math.pow(10, n);
  }
  return 0;
}

/** 按原版三角函数的方式四舍五入到 10 位小数：编译代码用 Math.round，解释器用 toFixed。 */
const round10 = COMPILED ? (x: number) => Math.round(x * 1e10) / 1e10 : (x: number) => parseFloat(x.toFixed(10));

function tan(angle: number): number {
  switch (angle % 360) {
    case -270:
    case 90:
      return Infinity;
    case -90:
    case 270:
      return -Infinity;
  }
  // 解释器在取正切前将角度对 360 取模，编译代码不这样做。
  return round10(dm.tan((Math.PI * (COMPILED ? angle : angle % 360)) / 180));
}

export const sin = (v: Value): number => round10(dm.sin((Math.PI * toNumber(v)) / 180));
export const cos = (v: Value): number => round10(dm.cos((Math.PI * toNumber(v)) / 180));
export const abs = (v: Value): number => Math.abs(toNumber(v));
export const floor = (v: Value): number => Math.floor(toNumber(v));
export const ceil = (v: Value): number => Math.ceil(toNumber(v));
export const sqrt = (v: Value): number => Math.sqrt(toNumber(v));

// ------------------------------------------------------------------ 列表

const LIST_INVALID = -1;
const LIST_ALL = -2;
const LIST_ITEM_LIMIT = 200000;

/** 解析列表索引参数；`rand` 为“random”/“any”提供随机源。 */
function toListIndex(index: Value, len: number, acceptAll: boolean, rand: () => number): number {
  if (typeof index !== 'number') {
    if (index === 'all') return acceptAll ? LIST_ALL : LIST_INVALID;
    if (index === 'last') return len > 0 ? len : LIST_INVALID;
    if (index === 'random' || index === 'any') return len > 0 ? 1 + Math.floor(rand() * len) : LIST_INVALID;
  }
  const i = Math.floor(toNumber(index));
  if (i < 1 || i > len) return LIST_INVALID;
  return i;
}

let listRandom: () => number = () => {
  throw new Error('list random source not installed');
};
export function setListRandom(fn: () => number): void {
  listRandom = fn;
}

/** 数字或数字字符串索引这一常见情况的快速路径。 */
export function item(list: Value[], index: Value): Value {
  if (typeof index === 'number') {
    const i = Math.floor(index);
    return i >= 1 && i <= list.length ? list[i - 1] : '';
  }
  const i = toListIndex(index, list.length, false, listRandom);
  return i === LIST_INVALID ? '' : list[i - 1];
}

export function replaceItem(list: Value[], index: Value, v: Value): void {
  const i = toListIndex(index, list.length, false, listRandom);
  if (i === LIST_INVALID) return;
  list[i - 1] = v;
}

export function addTo(list: Value[], v: Value): void {
  if (list.length < LIST_ITEM_LIMIT) list.push(v);
}

export function deleteOf(list: Value[], index: Value): void {
  const i = toListIndex(index, list.length, true, listRandom);
  if (i === LIST_INVALID) return;
  if (i === LIST_ALL) {
    list.length = 0;
    return;
  }
  list.splice(i - 1, 1);
}

export function deleteAll(list: Value[]): void {
  list.length = 0;
}

export function insertAt(list: Value[], index: Value, v: Value): void {
  const i = toListIndex(index, list.length + 1, false, listRandom);
  if (i === LIST_INVALID) return;
  if (i > LIST_ITEM_LIMIT) return;
  list.splice(i - 1, 0, v);
  if (list.length > LIST_ITEM_LIMIT) list.pop();
}

/**
 * 按 `compare` 比较后第一个等于 `v` 的项，或 -1。查找项的数字只计算一次。
 * 不是数字的查找项会以忽略大小写的文本与每一项比较，与 `compare` 的行为一致。
 */
function findItem(list: Value[], v: Value): number {
  const n2 = Number(v);
  if (Number.isNaN(n2) || (n2 === 0 && isWhiteSpace(v))) {
    const s2 = String(v).toLowerCase();
    // 转小写会保留 ASCII 文本的长度，因此对于 ASCII 查找项，长度不等即可排除匹配。
    const ascii = !/[^\x00-\x7f]/.test(s2);
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item === v) return i;
      const t = typeof item === 'string' ? item : String(item);
      if (ascii && t.length !== s2.length) continue;
      if (t.toLowerCase() === s2) return i;
    }
    return -1;
  }
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === v || compare(item, v) === 0) return i;
  }
  return -1;
}

export function indexOf(list: Value[], v: Value): number {
  return findItem(list, v) + 1;
}

export function listContains(list: Value[], v: Value): boolean {
  return list.indexOf(v) >= 0 || findItem(list, v) >= 0;
}

export function listContents(list: Value[]): string {
  let allSingle = true;
  for (const x of list) {
    if (!(typeof x === 'string' && x.length === 1)) {
      allSingle = false;
      break;
    }
  }
  return allSingle ? list.join('') : list.join(' ');
}

// ------------------------------------------------------------------ 与运行时共享的数学辅助函数

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function wrapClamp(n: number, min: number, max: number): number {
  const range = (max - min) + 1;
  return n - (Math.floor((n - min) / range) * range);
}

/**
 * 将项目的逐字母拆分循环合并为一次调用。单词在每个等于 `sep` 的字母处结束
 * （按 `=` 语义）；最后一个分隔符后的文本作为 `word` 返回且不加入列表，
 * `next` 是循环计数器的最终值（输入为空时为“1”）。
 */
export function splitWords(input: Value, sep: Value, list: Value[]): { word: string; next: Value } {
  list.length = 0;
  const s = String(input);
  let word = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (compare(ch, sep) !== 0) word += ch;
    else {
      if (list.length < LIST_ITEM_LIMIT) list.push(word);
      word = '';
    }
  }
  return { word, next: s.length === 0 ? '1' : s.length + 1 };
}

/** 生成代码使用的短名称。 */
export const num = toNumber;
export const bool = toBoolean;
