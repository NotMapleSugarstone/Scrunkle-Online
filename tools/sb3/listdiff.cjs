// 对两个项目共有的每个舞台列表，打印各方缺少的行；对用撇号打包的行，打印各方缺少的令牌。
const fs = require('fs');
const [, , aPath, bPath, only] = process.argv;
const A = JSON.parse(fs.readFileSync(aPath, 'utf8'));
const B = JSON.parse(fs.readFileSync(bPath, 'utf8'));
const lists = p => Object.fromEntries(p.targets.flatMap(t => Object.values(t.lists).map(([n, v]) => [`${t.isStage ? '' : t.name + '/'}${n}`, v])));
const la = lists(A), lb = lists(B);
const tokens = rows => new Set(rows.flatMap(r => String(r).split(/['.]/)).filter(Boolean));
for (const name of Object.keys(lb)) {
  if (!(name in la) || (only && name !== only)) continue;
  const a = la[name], b = lb[name];
  if (JSON.stringify(a) === JSON.stringify(b)) continue;
  console.log(`## ${name}: ${a.length} -> ${b.length} rows`);
  const n = Math.max(a.length, b.length);
  const changed = [];
  for (let i = 0; i < n; i++) if (String(a[i]) !== String(b[i])) changed.push(i + 1);
  console.log(`  rows differing by index: ${changed.length > 30 ? changed.slice(0, 30).join(',') + ',...' : changed.join(',')}`);
  const ta = tokens(a), tb = tokens(b);
  const lost = [...ta].filter(t => !tb.has(t)), gained = [...tb].filter(t => !ta.has(t));
  if (lost.length || gained.length) {
    console.log(`  tokens only CB (${lost.length}): ${lost.slice(0, 60).join(' ')}`);
    console.log(`  tokens only PK (${gained.length}): ${gained.slice(0, 60).join(' ')}`);
  }
}
