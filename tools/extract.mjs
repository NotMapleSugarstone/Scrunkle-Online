// 将源项目解压到 sb3/（project.json 以及造型和声音文件），并写入 src/game/runtime.json：
// 记录项目面向哪个运行时以及它设置的舞台，引擎、转译器和参考运行器都遵循这些。
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, process.argv[2] ?? 'game.sb3');
const out = path.join(root, 'sb3');
const zip = await JSZip.loadAsync(fs.readFileSync(src));
fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue;
  fs.writeFileSync(path.join(out, path.basename(name)), await entry.async('nodebuffer'));
  n++;
}
console.log(`extracted ${n} files to ${out}`);

// 由编译运行时保存的项目会在 meta.platform 中注明，其设置位于以 "_twconfig_" 结尾的舞台注释中。
// 较早的存档只有注释。
const project = JSON.parse(fs.readFileSync(path.join(out, 'project.json'), 'utf8'));
const stage = project.targets.find((t) => t.isStage);
const comment = Object.values(stage.comments ?? {}).find((c) => typeof c.text === 'string' && c.text.trimEnd().endsWith('_twconfig_'));
const compiled = project.meta?.platform?.name === 'TurboWarp' || !!comment;
let config = {};
if (comment) {
  // 设置就是标记所在行末尾的 JSON，按原版读取方式解析。
  const line = comment.text.split('\n').find((l) => l.endsWith('_twconfig_'));
  config = JSON.parse(line.slice(0, line.lastIndexOf('//')));
}
const runtime = {
  runtime: compiled ? 'turbowarp' : 'vanilla',
  stageWidth: config.width ?? 480,
  stageHeight: config.height ?? 360,
  framerate: config.framerate ?? 30,
};

// 移植版只复现默认运行时选项。其他选项会改变模拟，需要修改引擎。
const problems = [];
if (runtime.framerate !== 30) problems.push(`framerate ${runtime.framerate} (the engine steps at 30 frames per second)`);
const options = config.runtimeOptions ?? {};
if (options.maxClones !== undefined && options.maxClones !== 300) problems.push(`maxClones ${options.maxClones}`);
if (options.miscLimits === false) problems.push('miscLimits off');
if (options.fencing === false) problems.push('fencing off');
if (config.turbo) problems.push('turbo mode');
if (config.interpolation) console.log('note: the project turns on interpolation, which only smooths drawing; the port draws without it');
if (config.hq) console.log('note: the project turns on high quality pen, which only changes how the pen layer is drawn');
fs.writeFileSync(path.join(root, 'src', 'game', 'runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
console.log(`runtime ${runtime.runtime}, stage ${runtime.stageWidth}x${runtime.stageHeight}, ${runtime.framerate} frames per second`);
if (problems.length) {
  console.error(`unsupported project settings: ${problems.join(', ')}`);
  process.exitCode = 1;
}
