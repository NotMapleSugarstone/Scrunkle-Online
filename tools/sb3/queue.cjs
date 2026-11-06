// 为 drive.cjs 服务器排队测试：node tools/sb3/queue.cjs <serveDir> <test.cjs>... 按顺序写入 NN-<name>.cjs 包装。
const fs = require('fs');
const path = require('path');

const [, , dir, ...tests] = process.argv;
fs.mkdirSync(dir, { recursive: true });
let n = fs.readdirSync(dir).filter(f => /^\d+-/.test(f)).length;
for (const t of tests) {
  const abs = path.resolve(t).split(path.sep).join('/');
  const file = path.join(dir, `${String(++n).padStart(2, '0')}-${path.basename(t, '.cjs')}.cjs`);
  // 每次运行都使用测试及其辅助文件的新副本，因此编辑后无需重启服务器。
  fs.writeFileSync(file, `for (const k of Object.keys(require.cache)) if (k.includes('tests')) delete require.cache[k];\nmodule.exports = require(${JSON.stringify(abs)});\n`);
  console.log(file);
}
