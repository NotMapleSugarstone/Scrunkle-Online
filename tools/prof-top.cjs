// 打印 V8 .cpuprofile 中自身耗时最多的函数，以及按调用栈统计总耗时最多的函数。
// 用法：node tools/prof-top.cjs <file.cpuprofile> [count]
const fs = require('fs');
const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const count = Number(process.argv[3] || 30);
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = prof.timeDeltas;
for (let i = 0; i < prof.samples.length; i++) self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + (dt[i] || 0));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
const label = (n) => `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
const selfBy = new Map();
const totalBy = new Map();
let all = 0;
for (const [id, us] of self) {
  all += us;
  const n = byId.get(id);
  selfBy.set(label(n), (selfBy.get(label(n)) || 0) + us);
  // 总耗时：每个函数在每个采样栈中计一次。
  const seen = new Set();
  for (let c = id; c !== undefined; c = parent.get(c)) {
    const l = label(byId.get(c));
    if (seen.has(l)) continue;
    seen.add(l);
    totalBy.set(l, (totalBy.get(l) || 0) + us);
  }
}
const show = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, count).map(([k, v]) => `${((v / all) * 100).toFixed(1).padStart(5)}%  ${k}`).join('\n');
console.log(`total ${(all / 1000).toFixed(0)} ms\n-- self\n${show(selfBy)}\n-- total\n${show(totalBy)}`);
