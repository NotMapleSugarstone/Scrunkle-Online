// 统计 Scratch 项目中的积木块，并列出永远无法运行的脚本：没有帽子的堆栈、接收
// 无人发送的消息的接收器，以及没有活动脚本调用的过程。
// 用法：npx tsx tools/dead-code.ts [project.sb3]
import path from 'node:path';
import { GAME_SB3, loadGame, ROOT } from './lib/sb3-patch.ts';
import { countBlocks, Editor } from './lib/sb3-edit.ts';
import { deadScripts, sentMessages } from './lib/reach.ts';

const file = path.resolve(process.argv[2] ?? GAME_SB3);
const { project } = await loadGame(file);
const sent = sentMessages(project.targets);
const rows: string[] = [];
const byKind = new Map<string, [number, number]>();
let total = 0;
for (const t of project.targets) {
  total += countBlocks(t);
  const edit = new Editor(t);
  for (const d of deadScripts(t, sent)) {
    const blocks = Array.isArray(t.blocks[d.top]) ? 1 : edit.descendants(d.top).reduce((n, id) => {
      const b = t.blocks[id];
      return n + (b.shadow ? 0 : 1) + Object.values(b.inputs).filter((v) => Array.isArray(v[1]) && (v[1][0] === 12 || v[1][0] === 13)).length;
    }, 0);
    const [scripts, n] = byKind.get(d.kind) ?? [0, 0];
    byKind.set(d.kind, [scripts + 1, n + blocks]);
    rows.push(`  ${d.kind.padEnd(22)} ${t.name.padEnd(16)} ${String(blocks).padStart(5)}  ${d.what}`);
  }
}
console.log(`${path.relative(ROOT, file)}: ${total} blocks`);
for (const [kind, [scripts, n]] of byKind) console.log(`${kind}: ${scripts} scripts, ${n} blocks`);
console.log(rows.join('\n'));
