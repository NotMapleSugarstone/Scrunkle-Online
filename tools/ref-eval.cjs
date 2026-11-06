// 在运行中的参考页面（tools/ref-server.ts）中求文件里的 JavaScript 表达式并打印 JSON 结果。
// 用法：node tools/ref-eval.cjs <file.js>
const fs = require('node:fs');
const code = fs.readFileSync(process.argv[2], 'utf8');
fetch(`http://127.0.0.1:${process.env.REF_PORT ?? 8793}/eval`, { method: 'POST', body: code })
  .then((r) => r.text())
  .then((t) => console.log(t));
