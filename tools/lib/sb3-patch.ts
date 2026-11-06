// 在 project.json 目标内构建新积木并将其拼入现有脚本，使游戏补丁脚本
// 之后能被原编辑器打开，如同手工制作。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const GAME_SB3 = path.join(ROOT, 'game.sb3');

type Block = { opcode: string; next: string | null; parent: string | null; inputs: Record<string, unknown[]>; fields: Record<string, unknown[]>; shadow: boolean; topLevel: boolean; mutation?: Record<string, unknown> };
type Costume = { name: string; bitmapResolution: number; dataFormat: string; assetId: string; md5ext: string; rotationCenterX: number; rotationCenterY: number };
type Sound = { name: string; assetId: string; dataFormat: string; rate: number; sampleCount: number; md5ext: string };
export type Target = { name: string; isStage: boolean; blocks: Record<string, Block>; variables: Record<string, [string, unknown]>; lists: Record<string, [string, unknown[]]>; costumes: Costume[]; sounds: Sound[]; broadcasts?: Record<string, string> };

/** 向角色添加矢量造型，并向项目添加其文件。 */
export function addSvgCostume(zip: JSZip, t: Target, name: string, svg: string, cx: number, cy: number): void {
  if (t.costumes.some((c) => c.name === name)) throw new Error(`${t.name} already has a costume ${name}`);
  const assetId = createHash('md5').update(svg).digest('hex');
  zip.file(`${assetId}.svg`, svg);
  t.costumes.push({ name, bitmapResolution: 1, dataFormat: 'svg', assetId, md5ext: `${assetId}.svg`, rotationCenterX: cx, rotationCenterY: cy });
}

/**
 * 为角色设置位图造型；若已有同名造型则替换其图像，使该造型保留位置。
 * 不再被任何造型使用的文件会离开项目。
 */
export function setPngCostume(zip: JSZip, project: Project, t: Target, name: string, png: Buffer, cx: number, cy: number, resolution = 2): void {
  const assetId = createHash('md5').update(png).digest('hex');
  zip.file(`${assetId}.png`, png);
  const next = { name, bitmapResolution: resolution, dataFormat: 'png', assetId, md5ext: `${assetId}.png`, rotationCenterX: cx, rotationCenterY: cy };
  const i = t.costumes.findIndex((c) => c.name === name);
  if (i < 0) { t.costumes.push(next); return; }
  const old = t.costumes[i].md5ext;
  t.costumes[i] = next;
  if (!project.targets.some((x) => x.costumes.some((c) => c.md5ext === old))) zip.remove(old);
}

/** 向角色添加声音，播放项目中已有声音所使用的同一文件。 */
export function copySound(t: Target, name: string, from: Sound): void {
  if (t.sounds.some((s) => s.name === name)) throw new Error(`${t.name} already has a sound ${name}`);
  t.sounds.push({ ...from, name });
}

/** 按名称访问舞台或角色列表。 */
export function listOf(t: Target, name: string): unknown[] {
  const hit = Object.values(t.lists).find((l) => l[0] === name);
  if (!hit) throw new Error(`no list ${name} in ${t.name}`);
  return hit[1];
}
export type Project = { targets: Target[]; monitors: Record<string, unknown>[] };
/** 报告器积木、变量或列表报告器，或字面量。 */
export type Val = { id: string } | { prim: [12 | 13, string, string] } | string | number;
export type Ref = [string, string];

// 原版积木格式中的 shadow 类型。
const TEXT = 10, NUM = 4, WHOLE = 6, INT = 7;

export async function loadGame(file = GAME_SB3): Promise<{ zip: JSZip; project: Project }> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return { zip, project: JSON.parse(await zip.file('project.json')!.async('string')) };
}

export async function saveGame(zip: JSZip, project: Project, file = GAME_SB3): Promise<void> {
  zip.file('project.json', JSON.stringify(project));
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

export class Blocks {
  private n = 0;
  constructor(readonly t: Target, private prefix: string) {}

  private id(): string {
    let id: string;
    do id = `${this.prefix}${++this.n}`;
    while (id in this.t.blocks);
    return id;
  }
  private make(opcode: string, inputs: Record<string, unknown[]> = {}, fields: Record<string, unknown[]> = {}): string {
    const id = this.id();
    this.t.blocks[id] = { opcode, next: null, parent: null, inputs, fields, shadow: false, topLevel: false };
    for (const v of Object.values(inputs)) {
      const child = v[1];
      if (typeof child === 'string' && this.t.blocks[child]) this.t.blocks[child].parent = id;
    }
    return id;
  }
  private input(v: Val, shadow: number): unknown[] {
    if (typeof v === 'object' && 'id' in v) return [3, v.id, [shadow, '']];
    if (typeof v === 'object') return [3, v.prim, [shadow, '']];
    return [1, [shadow, String(v)]];
  }
  private bool(v: { id: string }): unknown[] {
    return [2, v.id];
  }

  /** 查找或添加此目标的变量，并返回其名称和 id。 */
  variable(name: string): Ref {
    const hit = Object.entries(this.t.variables).find(([, v]) => v[0] === name);
    if (hit) return [name, hit[0]];
    const id = this.id();
    this.t.variables[id] = [name, 0];
    return [name, id];
  }
  /** 查找或添加此目标的列表，并返回其名称和 id。 */
  list(name: string): Ref {
    const hit = Object.entries(this.t.lists).find(([, v]) => v[0] === name);
    if (hit) return [name, hit[0]];
    const id = this.id();
    this.t.lists[id] = [name, []];
    return [name, id];
  }

  v(ref: Ref): Val {
    return { prim: [12, ref[0], ref[1]] };
  }
  arg(name: string): Val {
    return { id: this.make('argument_reporter_string_number', {}, { VALUE: [name, null] }) };
  }
  equals(a: Val, b: Val): { id: string } {
    return { id: this.make('operator_equals', { OPERAND1: this.input(a, TEXT), OPERAND2: this.input(b, TEXT) }) };
  }
  gt(a: Val, b: Val): { id: string } {
    return { id: this.make('operator_gt', { OPERAND1: this.input(a, TEXT), OPERAND2: this.input(b, TEXT) }) };
  }
  and(a: { id: string }, b: { id: string }): { id: string } {
    return { id: this.make('operator_and', { OPERAND1: this.bool(a), OPERAND2: this.bool(b) }) };
  }
  or(a: { id: string }, b: { id: string }): { id: string } {
    return { id: this.make('operator_or', { OPERAND1: this.bool(a), OPERAND2: this.bool(b) }) };
  }
  not(a: { id: string }): { id: string } {
    return { id: this.make('operator_not', { OPERAND: this.bool(a) }) };
  }
  add(a: Val, b: Val): Val {
    return { id: this.make('operator_add', { NUM1: this.input(a, NUM), NUM2: this.input(b, NUM) }) };
  }
  sub(a: Val, b: Val): Val {
    return { id: this.make('operator_subtract', { NUM1: this.input(a, NUM), NUM2: this.input(b, NUM) }) };
  }
  mul(a: Val, b: Val): Val {
    return { id: this.make('operator_multiply', { NUM1: this.input(a, NUM), NUM2: this.input(b, NUM) }) };
  }
  div(a: Val, b: Val): Val {
    return { id: this.make('operator_divide', { NUM1: this.input(a, NUM), NUM2: this.input(b, NUM) }) };
  }
  lt(a: Val, b: Val): { id: string } {
    return { id: this.make('operator_lt', { OPERAND1: this.input(a, TEXT), OPERAND2: this.input(b, TEXT) }) };
  }
  mod(a: Val, b: Val): Val {
    return { id: this.make('operator_mod', { NUM1: this.input(a, NUM), NUM2: this.input(b, NUM) }) };
  }
  abs(a: Val): Val {
    return { id: this.make('operator_mathop', { NUM: this.input(a, NUM) }, { OPERATOR: ['abs', null] }) };
  }
  /** 定义自定义积木，并返回其定义块和参数 id。将主体链在 `def` 之后。 */
  procedure(proccode: string, argNames: string[], warp: boolean, x = 0, y = 0): { def: string; argIds: string[] } {
    const def = this.id();
    const proto = this.id();
    const argIds = argNames.map(() => this.id());
    const inputs: Record<string, unknown[]> = {};
    argNames.forEach((n, i) => {
      const r = this.id();
      this.t.blocks[r] = { opcode: 'argument_reporter_string_number', next: null, parent: proto, inputs: {}, fields: { VALUE: [n, null] }, shadow: true, topLevel: false };
      inputs[argIds[i]] = [1, r];
    });
    this.t.blocks[proto] = { opcode: 'procedures_prototype', next: null, parent: def, inputs, fields: {}, shadow: true, topLevel: false,
      mutation: { tagName: 'mutation', children: [], proccode, argumentids: JSON.stringify(argIds), argumentnames: JSON.stringify(argNames),
        argumentdefaults: JSON.stringify(argNames.map(() => '')), warp: String(warp) } };
    this.t.blocks[def] = Object.assign({ opcode: 'procedures_definition', next: null, parent: null, inputs: { custom_block: [1, proto] }, fields: {}, shadow: false, topLevel: true }, { x, y }) as Block;
    return { def, argIds };
  }
  /** 广播消息的 id，新消息会加入舞台的消息列表。 */
  private message(stage: Target, name: string): string {
    const all = (stage.broadcasts ??= {});
    const hit = Object.entries(all).find(([, n]) => n === name);
    if (hit) return hit[0];
    const id = `${this.prefix}-${name}`;
    all[id] = name;
    return id;
  }
  /** 舞台广播 `name` 时启动的脚本。将主体链在它之后。 */
  whenBroadcast(stage: Target, name: string, x = 0, y = 0): string {
    const id = this.make('event_whenbroadcastreceived', {}, { BROADCAST_OPTION: [name, this.message(stage, name)] });
    Object.assign(this.t.blocks[id], { topLevel: true, x, y });
    return id;
  }
  broadcast(stage: Target, name: string): string {
    return this.make('event_broadcast', { BROADCAST_INPUT: [1, [11, name, this.message(stage, name)]] });
  }
  /** 此类没有专用方法的积木，使用数字输入和字段。 */
  op(opcode: string, numbers: Record<string, Val> = {}, fields: Record<string, unknown[]> = {}): string {
    return this.make(opcode, Object.fromEntries(Object.entries(numbers).map(([k, v]) => [k, this.input(v, NUM)])), fields);
  }
  /** 自定义积木调用，每个参数一个值。 */
  call(proccode: string, argIds: string[], args: Val[], warp: boolean): string {
    const inputs: Record<string, unknown[]> = {};
    argIds.forEach((a, i) => { inputs[a] = this.input(args[i], TEXT); });
    const id = this.make('procedures_call', inputs);
    this.t.blocks[id].mutation = { tagName: 'mutation', children: [], proccode, argumentids: JSON.stringify(argIds), warp: String(warp) };
    return id;
  }
  join(a: Val, b: Val): Val {
    return { id: this.make('operator_join', { STRING1: this.input(a, TEXT), STRING2: this.input(b, TEXT) }) };
  }
  letterOf(index: Val, text: Val): Val {
    return { id: this.make('operator_letter_of', { LETTER: this.input(index, WHOLE), STRING: this.input(text, TEXT) }) };
  }
  contains(a: Val, b: Val): { id: string } {
    return { id: this.make('operator_contains', { STRING1: this.input(a, TEXT), STRING2: this.input(b, TEXT) }) };
  }
  itemOf(index: Val, list: Ref): Val {
    return { id: this.make('data_itemoflist', { INDEX: this.input(index, INT) }, { LIST: [...list] }) };
  }
  itemNumOf(item: Val, list: Ref): Val {
    return { id: this.make('data_itemnumoflist', { ITEM: this.input(item, TEXT) }, { LIST: [...list] }) };
  }
  lengthOf(list: Ref): Val {
    return { id: this.make('data_lengthoflist', {}, { LIST: [...list] }) };
  }
  listContains(list: Ref, item: Val): { id: string } {
    return { id: this.make('data_listcontainsitem', { ITEM: this.input(item, TEXT) }, { LIST: [...list] }) };
  }

  stopThisScript(): string {
    const id = this.make('control_stop', {}, { STOP_OPTION: ['this script', null] });
    this.t.blocks[id].mutation = { tagName: 'mutation', children: [], hasnext: 'false' };
    return id;
  }

  addTo(item: Val, list: Ref): string {
    return this.make('data_addtolist', { ITEM: this.input(item, TEXT) }, { LIST: [...list] });
  }
  deleteOf(index: Val, list: Ref): string {
    return this.make('data_deleteoflist', { INDEX: this.input(index, INT) }, { LIST: [...list] });
  }
  deleteAll(list: Ref): string {
    return this.make('data_deletealloflist', {}, { LIST: [...list] });
  }
  insertAt(index: Val, list: Ref, item: Val): string {
    return this.make('data_insertatlist', { ITEM: this.input(item, TEXT), INDEX: this.input(index, INT) }, { LIST: [...list] });
  }
  showList(list: Ref): string {
    return this.make('data_showlist', {}, { LIST: [...list] });
  }
  hideList(list: Ref): string {
    return this.make('data_hidelist', {}, { LIST: [...list] });
  }
  set(v: Ref, value: Val): string {
    return this.make('data_setvariableto', { VALUE: this.input(value, TEXT) }, { VARIABLE: [...v] });
  }
  change(v: Ref, by: Val): string {
    return this.make('data_changevariableby', { VALUE: this.input(by, NUM) }, { VARIABLE: [...v] });
  }
  ifThen(cond: { id: string }, body: string[]): string {
    return this.make('control_if', { CONDITION: this.bool(cond), SUBSTACK: [2, this.chain(body)] });
  }
  ifElse(cond: { id: string }, then: string[], otherwise: string[]): string {
    return this.make('control_if_else', { CONDITION: this.bool(cond), SUBSTACK: [2, this.chain(then)], SUBSTACK2: [2, this.chain(otherwise)] });
  }
  repeatUntil(cond: { id: string }, body: string[]): string {
    return this.make('control_repeat_until', { CONDITION: this.bool(cond), SUBSTACK: [2, this.chain(body)] });
  }
  replace(index: Val, list: Ref, value: Val): string {
    return this.make('data_replaceitemoflist', { INDEX: this.input(index, INT), ITEM: this.input(value, TEXT) }, { LIST: [...list] });
  }
  repeat(times: Val, body: string[]): string {
    return this.make('control_repeat', { TIMES: this.input(times, WHOLE), SUBSTACK: [2, this.chain(body)] });
  }

  /** 将语句积木连接成堆栈并返回第一个。 */
  chain(ids: string[]): string {
    ids.forEach((id, i) => {
      if (i > 0) {
        this.t.blocks[id].parent = ids[i - 1];
        this.t.blocks[ids[i - 1]].next = id;
      }
    });
    return ids[0];
  }
  /** 将新语句堆栈插入积木 `after` 之后。 */
  insertAfter(after: string, ids: string[]): void {
    const first = this.chain(ids);
    const last = ids[ids.length - 1];
    const old = this.t.blocks[after].next;
    this.t.blocks[after].next = first;
    this.t.blocks[first].parent = after;
    this.t.blocks[last].next = old;
    if (old) this.t.blocks[old].parent = last;
  }

  /** 按顺序列出脚本的积木，跟随 `next` 和每个子栈。 */
  walk(top: string): string[] {
    const out: string[] = [];
    const visit = (id: string | null) => {
      for (; id; id = this.t.blocks[id].next) {
        out.push(id);
        for (const k of ['SUBSTACK', 'SUBSTACK2']) {
          const s = this.t.blocks[id].inputs[k];
          if (s && typeof s[1] === 'string') visit(s[1]);
        }
      }
    };
    visit(top);
    return out;
  }
  /** 输入的文本字面量，或报告器背后的 shadow。 */
  literal(id: string, input: string): string | undefined {
    const v = this.t.blocks[id].inputs[input];
    const lit = (v?.[1] ?? null) as unknown;
    return Array.isArray(lit) ? String(lit[1]) : undefined;
  }
}
