// 查找、移动和删除目标中已有的积木，用于不添加积木而修改脚本的补丁。
import type { Target } from './sb3-patch.ts';

export type Block = Target['blocks'][string];
const SUBSTACKS = ['SUBSTACK', 'SUBSTACK2'];

export class Editor {
  constructor(readonly t: Target) {}

  get B(): Record<string, Block> {
    return this.t.blocks;
  }
  block(id: string): Block {
    const b = this.B[id];
    if (!b || Array.isArray(b)) throw new Error(`${this.t.name}: no block ${id}`);
    return b;
  }

  /** 自定义积木的定义块，按 proccode 查找。 */
  procedure(proccode: string): string {
    const proto = Object.entries(this.B).find(([, b]) => b?.opcode === 'procedures_prototype' && b.mutation?.proccode === proccode);
    if (!proto) throw new Error(`${this.t.name}: no procedure ${proccode}`);
    return proto[1].parent!;
  }
  /** 收到 `message` 时运行的唯一脚本的帽子。 */
  receiver(message: string): string {
    const hats = Object.entries(this.B).filter(([, b]) => b?.opcode === 'event_whenbroadcastreceived' && String(b.fields.BROADCAST_OPTION[0]) === message);
    if (hats.length !== 1) throw new Error(`${this.t.name}: ${hats.length} receivers of ${message}`);
    return hats[0][0];
  }

  /** 脚本中 `top` 以下的每个积木：语句、子栈和报告器，按顺序排列。 */
  descendants(top: string, followNext = true): string[] {
    const out: string[] = [];
    const visit = (id: string | null, chain: boolean) => {
      for (; id; id = chain ? this.block(id).next : null) {
        out.push(id);
        for (const [name, v] of Object.entries(this.block(id).inputs)) {
          const child = v[1];
          if (typeof child !== 'string' || !this.B[child]) continue;
          visit(child, SUBSTACKS.includes(name));
        }
      }
    };
    visit(top, followNext);
    return out;
  }
  /** `top` 下 `test` 接受的唯一积木；没有或不止一个时抛出错误。 */
  one(top: string, what: string, test: (b: Block, id: string) => boolean): string {
    const hits = this.descendants(top).filter((id) => test(this.block(id), id));
    if (hits.length !== 1) throw new Error(`${this.t.name}: ${hits.length} blocks match ${what}`);
    return hits[0];
  }

  /** 字面量输入的文本；由报告器填充或为空时为 undefined。 */
  literal(id: string, input: string): string | undefined {
    const v = this.block(id).inputs[input];
    return v && v[0] === 1 && Array.isArray(v[1]) ? String(v[1][1]) : undefined;
  }
  /** 内联存储在输入中的变量或列表报告器名称。 */
  inlineName(id: string, input: string): string | undefined {
    const v = this.block(id).inputs[input];
    return v && Array.isArray(v[1]) && (v[1][0] === 12 || v[1][0] === 13) ? String(v[1][1]) : undefined;
  }
  /** 输入中的报告器积木（若有）。 */
  child(id: string, input: string): string | undefined {
    const v = this.block(id).inputs[input];
    const c = v?.[1];
    return typeof c === 'string' && this.B[c] && !this.block(c).shadow ? c : undefined;
  }
  setLiteral(id: string, input: string, value: string): void {
    const v = this.block(id).inputs[input];
    if (!v || v[0] !== 1 || !Array.isArray(v[1])) throw new Error(`${this.t.name}: ${id}.${input} holds no literal`);
    (v[1] as unknown[])[1] = value;
  }

  // ------------------------------------------------------------ 语句

  /** 从堆栈中取出语句，并连接其前后的积木。 */
  detach(id: string): void {
    const b = this.block(id);
    const p = b.parent;
    const n = b.next;
    if (p) {
      const pb = this.block(p);
      if (pb.next === id) pb.next = n;
      else {
        const k = SUBSTACKS.find((s) => pb.inputs[s]?.[1] === id);
        if (!k) throw new Error(`${this.t.name}: ${id} is not a statement of ${p}`);
        if (n) pb.inputs[k] = [2, n];
        else delete pb.inputs[k];
      }
    } else if (n) {
      Object.assign(this.block(n), { topLevel: true, x: (b as { x?: number }).x ?? 0, y: (b as { y?: number }).y ?? 0 });
    }
    if (n) this.block(n).parent = p;
    b.parent = null;
    b.next = null;
  }
  /** 将分离的语句放到 `after` 之后。 */
  insertAfter(id: string, after: string): void {
    const b = this.block(id);
    const a = this.block(after);
    b.parent = after;
    b.next = a.next;
    if (a.next) this.block(a.next).parent = id;
    a.next = id;
  }
  /** 将同一堆栈中从 `first` 到 `last` 的语句移入 `wrapper` 的空子栈，由该子栈取代它们的位置。 */
  wrap(first: string, last: string, wrapper: string): void {
    const f = this.block(first);
    const l = this.block(last);
    const w = this.block(wrapper);
    const p = f.parent;
    if (!p) throw new Error(`${this.t.name}: ${first} starts a script`);
    const pb = this.block(p);
    if (pb.next === first) pb.next = wrapper;
    else {
      const k = SUBSTACKS.find((s) => pb.inputs[s]?.[1] === first);
      if (!k) throw new Error(`${this.t.name}: ${first} is not a statement of ${p}`);
      pb.inputs[k] = [2, wrapper];
    }
    w.parent = p;
    w.next = l.next;
    if (l.next) this.block(l.next).parent = wrapper;
    l.next = null;
    w.inputs.SUBSTACK = [2, first];
    f.parent = wrapper;
  }
  /** 将分离的语句放到 `owner` 某个子栈的开头。 */
  insertFirst(id: string, owner: string, input = 'SUBSTACK'): void {
    const o = this.block(owner);
    const old = o.inputs[input]?.[1] as string | undefined;
    o.inputs[input] = [2, id];
    const b = this.block(id);
    b.parent = owner;
    b.next = old ?? null;
    if (old) this.block(old).parent = id;
  }
  /** 删除积木及其报告器、shadow 和子栈，但不删除其后的积木。 */
  deleteTree(id: string): number {
    let n = 0;
    const visit = (bid: string, chain: boolean) => {
      for (let cur: string | null = bid; cur; ) {
        const b = this.block(cur);
        if (!b.shadow) n++;
        for (const [name, v] of Object.entries(b.inputs)) {
          for (const c of v.slice(1)) {
            if (Array.isArray(c) && (c[0] === 12 || c[0] === 13)) n++;
            if (typeof c === 'string' && this.B[c]) visit(c, SUBSTACKS.includes(name));
          }
        }
        const next: string | null = chain ? b.next : null;
        delete this.B[cur];
        cur = next;
      }
    };
    visit(id, false);
    return n;
  }
  /** 从堆栈中取出语句并删除。返回删除的积木数。 */
  remove(id: string): number {
    this.detach(id);
    return this.deleteTree(id);
  }
  /** 从帽子开始删除整个脚本。 */
  removeScript(top: string): number {
    let n = 0;
    for (let id: string | null = top; id; ) {
      const next: string | null = this.block(id).next;
      this.block(id).next = null;
      n += this.deleteTree(id);
      id = next;
    }
    return n;
  }

  // ------------------------------------------------------------ 报告器

  /** 从父积木的输入中取出报告器，留下输入的 shadow 或空槽。 */
  unplug(id: string): void {
    const b = this.block(id);
    const p = this.block(b.parent!);
    const k = Object.keys(p.inputs).find((name) => p.inputs[name][1] === id);
    if (!k) throw new Error(`${this.t.name}: ${id} is not an input of ${b.parent}`);
    const v = p.inputs[k];
    if (v.length > 2 && v[2] != null) p.inputs[k] = [1, v[2]];
    else delete p.inputs[k];
    b.parent = null;
  }
  /** 用报告器 `child`（从其原位置移动）填充 `parent` 的输入，并删除原先填充的内容。 */
  plug(parent: string, input: string, child: string): number {
    const c = this.block(child);
    if (c.parent) this.unplug(child);
    const p = this.block(parent);
    const v = p.inputs[input];
    let removed = 0;
    if (v && typeof v[1] === 'string' && this.B[v[1]] && !this.block(v[1]).shadow) removed = this.deleteTree(v[1]);
    else if (v && Array.isArray(v[1]) && (v[1][0] === 12 || v[1][0] === 13)) removed = 1;
    const shadow = v ? (v[0] === 1 ? v[1] : v[2]) : undefined;
    p.inputs[input] = shadow !== undefined && !(Array.isArray(shadow) && (shadow[0] === 12 || shadow[0] === 13)) ? [3, child, shadow] : [2, child];
    c.parent = parent;
    return removed;
  }
  /** 用内联变量或列表报告器替换输入中的所有内容。 */
  plugInline(parent: string, input: string, kind: 12 | 13, name: string, id: string): number {
    const p = this.block(parent);
    const v = p.inputs[input];
    let removed = 0;
    if (v && typeof v[1] === 'string' && this.B[v[1]] && !this.block(v[1]).shadow) removed = this.deleteTree(v[1]);
    const shadow = v ? (v[0] === 1 ? v[1] : v[2]) : [10, ''];
    p.inputs[input] = [3, [kind, name, id], shadow];
    return removed;
  }
}

/** 分离已删除积木的注释，使其留在工作区且项目仍能加载。 */
export function keepOrphanComments(t: Target): number {
  let n = 0;
  for (const c of Object.values((t as { comments?: Record<string, { blockId: string | null }> }).comments ?? {})) {
    if (c.blockId && !t.blocks[c.blockId]) { c.blockId = null; n++; }
  }
  return n;
}

/** 编辑器显示的目标积木：非 shadow 积木以及内联变量和列表报告器。 */
export function countBlocks(t: Target): number {
  let n = 0;
  for (const b of Object.values(t.blocks)) {
    if (Array.isArray(b)) { n++; continue; }
    if (!b || b.shadow) continue;
    n++;
    for (const v of Object.values(b.inputs)) if (Array.isArray(v[1]) && (v[1][0] === 12 || v[1][0] === 13)) n++;
  }
  return n;
}
