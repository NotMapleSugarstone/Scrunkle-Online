// 用于在两个积木 id 互不相关的 Scratch 3 项目之间合并脚本的积木图辅助工具。
const fs = require('fs');
const path = require('path');
const { makePrinter } = require('./decompile.cjs');

// 每个目标都会获得指向舞台的隐藏链接，使打印时能从 id 解析全局名称。
function loadProject(dir) {
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const st = p.targets.find(t => t.isStage);
  for (const t of p.targets) Object.defineProperty(t, '__stage', { value: st, enumerable: false });
  return p;
}

function getTarget(p, name) {
  const t = p.targets.find(t => (name === 'Stage' ? t.isStage : t.name === name));
  if (!t) throw new Error(`no target ${name}`);
  return t;
}
const stageOf = p => p.targets.find(t => t.isStage);

// 分配项目中任何目标、变量、列表、广播或注释都未使用的 id。
class Ids {
  constructor(p) {
    this.used = new Set();
    for (const t of p.targets) {
      for (const k of ['blocks', 'variables', 'lists', 'broadcasts', 'comments']) for (const id of Object.keys(t[k] || {})) this.used.add(id);
    }
    this.n = 0;
  }
  next() {
    let id;
    do id = '$' + (this.n++).toString(36); while (this.used.has(id));
    this.used.add(id);
    return id;
  }
}

function isBlock(b) { return b && !Array.isArray(b); }

// 脚本的每个积木：从 `top` 沿 `next` 的链，以及其输入持有的所有内容。
function chainIds(blocks, top, followNext = true) {
  const out = new Set();
  const stack = [top];
  let first = true;
  while (stack.length) {
    const id = stack.pop();
    if (!id || out.has(id)) continue;
    const b = blocks[id];
    if (!b) continue;
    out.add(id);
    if (Array.isArray(b)) continue;
    if (b.next && (followNext || !first)) stack.push(b.next);
    first = false;
    for (const inp of Object.values(b.inputs)) for (const v of inp.slice(1)) if (typeof v === 'string') stack.push(v);
  }
  return out;
}
const scriptIds = (blocks, top) => chainIds(blocks, top, true);
const branchIds = (blocks, id) => chainIds(blocks, id, false);

// 按 VM 加载器的方式解析变量、列表或广播引用：先按 id 查局部，再按 id 查全局，最后按名称。
function resolveRef(p, t, kind, name, id) {
  const st = stageOf(p);
  const dict = kind === 'broadcast' ? 'broadcasts' : kind === 'list' ? 'lists' : 'variables';
  const nameOf = (tt, i) => (kind === 'broadcast' ? tt.broadcasts[i] : tt[dict][i] && tt[dict][i][0]);
  if (kind !== 'broadcast' && t[dict][id] !== undefined) return { scope: 'local', id, name: nameOf(t, id), target: t };
  if (st[dict][id] !== undefined) return { scope: 'global', id, name: nameOf(st, id), target: st };
  if (kind !== 'broadcast') for (const [i, v] of Object.entries(t[dict])) if (v[0] === name) return { scope: 'local', id: i, name, target: t };
  for (const [i, v] of Object.entries(st[dict])) if ((kind === 'broadcast' ? v : v[0]) === name) return { scope: 'global', id: i, name, target: st };
  return null;
}

class Merger {
  constructor(dst, src) {
    this.dst = dst;
    this.src = src;
    this.ids = new Ids(dst);
    this.log = [];
    this.created = [];
  }

  // 查找或创建与源引用匹配的目标变量、列表或广播。
  bind(srcT, dstT, kind, name, id) {
    const r = resolveRef(this.src, srcT, kind, name, id);
    if (!r) throw new Error(`${srcT.name}: unresolved ${kind} ${name} (${id})`);
    const dst = this.dst, st = stageOf(dst);
    const dict = kind === 'broadcast' ? 'broadcasts' : kind === 'list' ? 'lists' : 'variables';
    const local = r.scope === 'local' && !dstT.isStage;
    const home = local ? dstT : st;
    if (kind === 'broadcast') {
      for (const [i, n] of Object.entries(st.broadcasts)) if (n === r.name) return { id: i, name: n };
      const nid = this.ids.next();
      st.broadcasts[nid] = r.name;
      this.created.push(`broadcast ${r.name}`);
      return { id: nid, name: r.name };
    }
    for (const [i, v] of Object.entries(home[dict])) if (v[0] === r.name) return { id: i, name: r.name };
    if (local) for (const [i, v] of Object.entries(st[dict])) if (v[0] === r.name) throw new Error(`${dstT.name}: local ${kind} ${r.name} would shadow a global`);
    const nid = this.ids.next();
    home[dict][nid] = JSON.parse(JSON.stringify(r.target[dict][r.id]));
    this.created.push(`${local ? dstT.name : 'Stage'} ${kind} ${r.name}`);
    return { id: nid, name: r.name };
  }

  rebindPrim(srcT, dstT, prim) {
    const kind = { 11: 'broadcast', 12: 'variable', 13: 'list' }[prim[0]];
    if (!kind) return;
    const r = this.bind(srcT, dstT, kind, prim[1], prim[2]);
    prim[1] = r.name;
    prim[2] = r.id;
  }

  // 将积木从源目标复制到目标目标，使用新 id 并重新绑定数据引用。
  copy(srcT, ids, dstT) {
    const map = new Map();
    for (const id of ids) map.set(id, this.ids.next());
    for (const id of ids) {
      const b = JSON.parse(JSON.stringify(srcT.blocks[id]));
      if (Array.isArray(b)) { this.rebindPrim(srcT, dstT, b); dstT.blocks[map.get(id)] = b; continue; }
      b.next = b.next && map.has(b.next) ? map.get(b.next) : null;
      b.parent = b.parent && map.has(b.parent) ? map.get(b.parent) : null;
      for (const inp of Object.values(b.inputs)) {
        for (let k = 1; k < inp.length; k++) {
          const v = inp[k];
          if (typeof v === 'string') inp[k] = map.get(v) || null;
          else if (Array.isArray(v)) this.rebindPrim(srcT, dstT, v);
        }
      }
      for (const [fname, kind] of [['VARIABLE', 'variable'], ['LIST', 'list'], ['BROADCAST_OPTION', 'broadcast']]) {
        const f = b.fields[fname];
        if (!f) continue;
        const r = this.bind(srcT, dstT, kind, f[0], f[1]);
        b.fields[fname] = [r.name, r.id];
      }
      delete b.comment;
      dstT.blocks[map.get(id)] = b;
    }
    // 父链接来自复制的图，因为源子积木可能被图外的死片段认领。
    for (const nid of map.values()) {
      const b = dstT.blocks[nid];
      if (!isBlock(b)) continue;
      if (b.next) dstT.blocks[b.next].parent = nid;
      for (const inp of Object.values(b.inputs)) for (const v of inp.slice(1)) if (typeof v === 'string' && isBlock(dstT.blocks[v])) dstT.blocks[v].parent = nid;
    }
    return map;
  }

  copyScript(srcT, top, dstT, x, y) {
    const map = this.copy(srcT, scriptIds(srcT.blocks, top), dstT);
    const nb = dstT.blocks[map.get(top)];
    nb.topLevel = true;
    nb.parent = null;
    if (x !== undefined) { nb.x = x; nb.y = y; }
    return map.get(top);
  }

  // 复制一条语句及其子栈，返回新 id，未连接。
  copyBranch(srcT, id, dstT) {
    const map = this.copy(srcT, branchIds(srcT.blocks, id), dstT);
    const nb = dstT.blocks[map.get(id)];
    nb.next = null; nb.parent = null; nb.topLevel = false;
    delete nb.x; delete nb.y;
    return map.get(id);
  }
}

function removeIds(t, ids) {
  for (const id of ids) delete t.blocks[id];
  for (const [cid, c] of Object.entries(t.comments || {})) if (c.blockId && ids.has(c.blockId)) delete t.comments[cid];
}
function removeScript(t, top) { removeIds(t, scriptIds(t.blocks, top)); }

// 对 next 链进行语句操作。每个 id 命名目标 t 中的一个语句积木。
function lastOf(t, id) { while (t.blocks[id].next) id = t.blocks[id].next; return id; }

function insertAfter(t, anchor, first) {
  const a = t.blocks[anchor], last = lastOf(t, first);
  t.blocks[last].next = a.next;
  if (a.next) t.blocks[a.next].parent = last;
  a.next = first;
  t.blocks[first].parent = anchor;
}

// 将一条链插入 `anchor` 之前，`anchor` 可以是子栈的第一条语句或跟在帽子之后。
function insertBefore(t, anchor, first) {
  const a = t.blocks[anchor], last = lastOf(t, first);
  const par = a.parent && t.blocks[a.parent];
  t.blocks[first].parent = a.parent;
  if (par) {
    if (par.next === anchor) par.next = first;
    else for (const inp of Object.values(par.inputs)) if (inp[1] === anchor) inp[1] = first;
  }
  t.blocks[last].next = anchor;
  a.parent = last;
}

// 从链中分离一条语句（及其子栈）并删除它。
function deleteStmt(t, id) {
  const b = t.blocks[id];
  const par = b.parent && t.blocks[b.parent];
  if (par) {
    if (par.next === id) par.next = b.next;
    else for (const inp of Object.values(par.inputs)) if (inp[1] === id) inp[1] = b.next;
  }
  if (b.next) t.blocks[b.next].parent = b.parent;
  b.next = null;
  removeIds(t, branchIds(t.blocks, id));
}

function replaceStmt(t, old, first) {
  insertBefore(t, old, first);
  deleteStmt(t, old);
}

// 将一条链追加到 C 形积木的子栈输入（SUBSTACK 或 SUBSTACK2）末尾。
function appendToSubstack(t, cblock, first, name = 'SUBSTACK') {
  const c = t.blocks[cblock];
  const inp = c.inputs[name];
  if (!inp || !inp[1]) { c.inputs[name] = [2, first]; t.blocks[first].parent = cblock; return; }
  insertAfter(t, lastOf(t, inp[1]), first);
}

// 按语句内容而非 id 定位脚本和语句的伪代码。
function printer(t) { return makePrinter(t, t.__stage); }

function hatText(t, top) { return printer(t).hat(t.blocks[top]); }

function scriptText(t, top) {
  const out = [];
  printer(t).stmts(t.blocks[top].next, '  ', out);
  return out.join('\n');
}

// 语句伪代码的第一行，用它在不含子栈的情况下识别语句。
function stmtHead(t, id) {
  const out = [];
  const b = t.blocks[id];
  const saved = b.next;
  b.next = null;
  printer(t).stmts(id, '', out);
  b.next = saved;
  return out[0];
}

// 一个语句及其子栈的伪代码，不含其后的语句。
function stmtText(t, id) {
  const out = [];
  const b = t.blocks[id];
  const saved = b.next;
  b.next = null;
  printer(t).stmts(id, '', out);
  b.next = saved;
  return out.join('\n');
}

function topScripts(t) {
  const pr = printer(t);
  return Object.entries(t.blocks).filter(([, b]) => isBlock(b) && b.topLevel && pr.hat(b)).map(([id]) => id);
}

// 帽子文本等于 `hat` 的顶层脚本（DEFINE 帽子只按 proccode 匹配）。
function findScripts(t, hat) {
  return topScripts(t).filter(id => {
    const h = hatText(t, id);
    return h === hat || (hat.startsWith('DEFINE ') && h.startsWith(hat + ' args='));
  });
}

function findScript(t, hat) {
  const s = findScripts(t, hat);
  if (s.length !== 1) throw new Error(`${t.name}: ${s.length} scripts match ${hat}`);
  return s[0];
}

// 脚本内任意位置、首行包含 `needle` 的语句，按阅读顺序排列。
function findStmts(t, top, needle) {
  const found = [];
  const visit = id => {
    while (id) {
      const b = t.blocks[id];
      if (id !== top && stmtHead(t, id).includes(needle)) found.push(id);
      for (const k of ['SUBSTACK', 'SUBSTACK2']) if (b.inputs[k] && b.inputs[k][1]) visit(b.inputs[k][1]);
      id = b.next;
    }
  };
  visit(top);
  return found;
}

function findStmt(t, top, needle, nth = 0, expect = 1) {
  const s = findStmts(t, top, needle);
  if (expect !== null && s.length !== expect) throw new Error(`${t.name}: ${s.length} statements match ${needle} (expected ${expect})`);
  if (!s[nth]) throw new Error(`${t.name}: no statement ${nth} for ${needle}`);
  return s[nth];
}

// 设置积木的字面量输入，保留其 shadow 类型。
function setLiteral(t, id, input, value) {
  const inp = t.blocks[id].inputs[input];
  const v = inp[inp.length === 3 ? 2 : 1];
  if (Array.isArray(v)) { v[1] = String(value); return; }
  const sh = t.blocks[v];
  if (sh && sh.shadow) { const f = Object.keys(sh.fields)[0]; sh.fields[f][0] = String(value); return; }
  throw new Error(`${t.name}: input ${input} of ${id} is not a literal`);
}

// 语句自身表达式中（不含子栈或 next）的字面量槽，形如 {value, set}。
function literalSlots(t, id) {
  const slots = [];
  const visit = (bid) => {
    const b = t.blocks[bid];
    for (const [name, inp] of Object.entries(b.inputs)) {
      if (name === 'SUBSTACK' || name === 'SUBSTACK2') continue;
      const v = inp[1];
      if (Array.isArray(v)) { if (v[0] >= 4 && v[0] <= 10) slots.push({ value: String(v[1]), set: x => { v[1] = String(x); } }); continue; }
      if (typeof v !== 'string' || !t.blocks[v] || Array.isArray(t.blocks[v])) continue;
      const c = t.blocks[v];
      const f = Object.keys(c.fields);
      if (c.shadow && f.length === 1 && Object.keys(c.inputs).length === 0) slots.push({ value: String(c.fields[f[0]][0]), set: x => { c.fields[f[0]][0] = String(x); } });
      else visit(v);
    }
  };
  visit(id);
  return slots;
}

// 在一条语句内将字面量 `from` 替换为 `to`，并检查改变了多少槽。
function replaceLiteral(t, id, from, to, expect = 1) {
  const s = literalSlots(t, id).filter(x => x.value === String(from));
  if (s.length !== expect) throw new Error(`${t.name}: ${s.length} literals "${from}" in ${stmtHead(t, id)} (expected ${expect})`);
  for (const x of s) x.set(to);
}

// 按帽子配对两个目标的脚本，先配相同主体，再配最相似的。
function pairScripts(ta, tb) {
  const mk = t => topScripts(t).map(id => {
    const text = scriptText(t, id);
    return { id, hat: hatText(t, id), text, body: text.split('\n') };
  });
  const xs = mk(ta), ys = mk(tb);
  const sim = (x, y) => {
    const s = new Map();
    for (const l of x.body) s.set(l, (s.get(l) || 0) + 1);
    let c = 0;
    for (const l of y.body) if (s.get(l) > 0) { c++; s.set(l, s.get(l) - 1); }
    return (2 * c) / (x.body.length + y.body.length || 1);
  };
  const used = new Set(), pairs = [], onlyA = [];
  for (const x of xs) {
    const y = ys.find(y => !used.has(y) && y.hat === x.hat && y.text === x.text);
    if (y) { used.add(y); pairs.push([x, y]); x.done = true; }
  }
  for (const x of xs) {
    if (x.done) continue;
    let best = null, bs = -1;
    for (const y of ys) if (!used.has(y) && y.hat === x.hat) { const s = sim(x, y); if (s > bs) { bs = s; best = y; } }
    if (best) { used.add(best); pairs.push([x, best]); } else onlyA.push(x);
  }
  return { pairs, onlyA, onlyB: ys.filter(y => !used.has(y)) };
}

// 按位置重写每次调用的参数 id 和输入键，使其匹配原型。
function fixCalls(t, log) {
  const protos = new Map();
  for (const b of Object.values(t.blocks)) if (isBlock(b) && b.opcode === 'procedures_prototype') protos.set(b.mutation.proccode, b);
  for (const [id, b] of Object.entries(t.blocks)) {
    if (!isBlock(b) || b.opcode !== 'procedures_call') continue;
    const p = protos.get(b.mutation.proccode);
    if (!p) { log.push(`${t.name}: call to undefined "${b.mutation.proccode}" (${id})`); continue; }
    if (b.mutation.argumentids === p.mutation.argumentids) continue;
    const from = JSON.parse(b.mutation.argumentids), to = JSON.parse(p.mutation.argumentids);
    if (from.length !== to.length) log.push(`${t.name}: call "${b.mutation.proccode}" has ${from.length} args, prototype ${to.length} (${id})`);
    const inputs = {};
    for (const [k, v] of Object.entries(b.inputs)) {
      const i = from.indexOf(k);
      if (i >= 0 && i < to.length) inputs[to[i]] = v;
    }
    b.inputs = inputs;
    b.mutation.argumentids = p.mutation.argumentids;
    b.mutation.warp = p.mutation.warp;
  }
}

module.exports = {
  loadProject, getTarget, stageOf, Ids, Merger, isBlock, scriptIds, branchIds, resolveRef,
  removeIds, removeScript, insertAfter, insertBefore, deleteStmt, replaceStmt, appendToSubstack, lastOf,
  hatText, scriptText, stmtHead, stmtText, topScripts, findScripts, findScript, findStmts, findStmt, setLiteral,
  literalSlots, replaceLiteral, pairScripts, fixCalls,
};
