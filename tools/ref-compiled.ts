// 打印原版编译器为已运行脚本生成的 JavaScript，以便与
// 移植版生成的代码比较。先通过 tools/parity.ts 运行场景，使脚本完成编译。
// 需要 tools/ref-server.ts 正在运行。用法：npx tsx tools/ref-compiled.ts <sprite> <hat block id or proccode text> [out file]
import fs from 'node:fs';
import { SERVER } from './lib/ref-client.ts';

const [sprite, key, outFile] = process.argv.slice(2);
const code = `(() => {
  const t = H.vm.runtime.targets.find((x) => x.isOriginal && x.sprite.name === ${JSON.stringify(sprite)});
  if (!t) return 'no sprite';
  const out = [];
  const cache = t.blocks._cache.compiledScripts;
  for (const [top, r] of Object.entries(cache)) {
    if (!r.success) { if (top === ${JSON.stringify(key)}) out.push('compile error: ' + r.value); continue; }
    const v = r.value;
    if (top === ${JSON.stringify(key)}) out.push('// script ' + top + '\\n' + v.startingFunction.toString());
    for (const [proc, f] of Object.entries(v.procedures)) {
      if (proc.includes(${JSON.stringify(key)})) out.push('// procedure ' + proc + ' (from script ' + top + ')\\n' + f.toString());
    }
  }
  return out.length ? out.join('\\n\\n') : 'not compiled yet';
})()`;
const res = await fetch(`${SERVER}/eval`, { method: 'POST', body: code });
const text = JSON.parse(await res.text()) as string;
if (outFile) {
  fs.writeFileSync(outFile, text);
  console.log(`wrote ${text.length} characters to ${outFile}`);
} else console.log(text);
