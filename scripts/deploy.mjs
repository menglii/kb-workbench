// 部署：把构建产物拷进 Obsidian 库的插件目录
//
// 🔴 这是「真库不许动」这条红线的**实际执行点**：
//     · 默认只部署到实验库（Desktop/sandbox-vault）
//     · 真库（Desktop/real-vault）必须显式传 --real，并且要在终端里手打 yes 确认
//     · 真库的 community-plugins.json **绝不自动改**（那等于替你打开插件），只打印手动手势
//
// 用法：
//   node scripts/deploy.mjs                  → 实验库
//   node scripts/deploy.mjs --real           → 真库（需交互确认）
//   KBW_ALLOW_REAL=1 node scripts/deploy.mjs --real --yes   → 真库（跳过交互；**要两个都给**）
//   node scripts/deploy.mjs --no-enable      → 实验库，且不动 community-plugins.json
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveDeployTarget, realVault, sandboxVault } from './vault-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 库路径与判据都在 vault-guard 里（唯一来源）
const args = new Set(process.argv.slice(2));
// ⚠️ 真库判定**按路径**，不看 --real：否则把 KBW_VAULT_SANDBOX 指向真库时，
// 这条日常路径会一路无确认地写下去、还打印"【实验库】"（独立审查实测出的一条）
const { target, isReal } = resolveDeployTarget(args.has('--real'));
const skipPrompt = args.has('--yes');
const noEnable = args.has('--no-enable');

const FILES = ['main.js', 'manifest.json', 'styles.css'];
/**
 * **随插件发布的目录**（递归拷）—— P7.2b 起有这一个：向导配图等静态资产。
 * ⚠️ 覆盖式（先删目标再拷）：图片改名/删图时不会在插件目录里留下孤儿。
 * 与 `make-share-pack.mjs` 是同一份口径，两边一起改。
 */
const DIRS = ['assets'];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ── 0. 前置检查 ────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const id = manifest.id;
const pluginDir = path.join(target, '.obsidian', 'plugins', id);

// manifest.id 必须等于插件目录名（platform-pitfalls #27：否则会造出「假插件目录」）
if (path.basename(pluginDir) !== id) fail(`manifest.id (${id}) 与部署目录名不一致`);

if (!fs.existsSync(target)) fail(`库不存在：${target}`);
if (!fs.existsSync(path.join(target, '.obsidian'))) fail(`不是有效的库（缺 .obsidian/）：${target}`);

for (const f of FILES) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    fail(`缺少构建产物 ${f} —— 先跑 npm run build`);
  }
}
// 产物陈旧提醒（不阻断：watch 模式下时间戳对比会误报）
const mainMtime = fs.statSync(path.join(ROOT, 'main.js')).mtimeMs;
const srcDir = path.join(ROOT, 'src');
let newestSrc = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else newestSrc = Math.max(newestSrc, fs.statSync(p).mtimeMs);
  }
};
if (fs.existsSync(srcDir)) walk(srcDir);
if (newestSrc > mainMtime) {
  console.warn(`⚠ main.js 比 src/ 里的源码旧 —— 建议先 npm run build`);
}

// ── 0.5 判据自检：真实目标必须先亮出来 ─────────────────────────
console.log(`
部署目标（按路径判定）：${target}`);
console.log(`  判据：${isReal ? '**真库**' : '实验库'}｜实验库配置=${sandboxVault()}｜真库配置=${realVault()}`);
if (isReal !== args.has('--real')) {
  console.log('  ⚠️ 注意：判据与命令行标志不一致 —— 一律按**路径**走（这才是安全的那个方向）');
}

// ── 1. 真库：打印确认 ──────────────────────────────────────────
async function confirmReal() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  🔴 真库部署 —— 这是「real-vault」，不是实验库             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`  目标：${pluginDir}`);
  console.log(`  文件：${FILES.join(' · ')}${DIRS.length ? ' ＋ ' + DIRS.join('、') + '/' : ''}`);
  console.log('  影响：只往插件目录写上面这些文件/目录；不会碰任何笔记。');
  console.log('        真库的 community-plugins.json 不会被自动修改。');
  console.log('');
  if (skipPrompt) {
    // ⚠️ `--yes` 单独不够：它可能被复制粘贴脚本时顺手带上，而这是唯一一条
    // "不加路径判据也能写真库"的路径（独立审查指出）。要求环境里也明确写一句
    if (process.env.KBW_ALLOW_REAL !== '1') {
      fail(
        [
          '--yes 还需要环境变量一起给：KBW_ALLOW_REAL=1',
          '   （即：KBW_ALLOW_REAL=1 npm run deploy:real -- --yes）',
          '   两个都给了才跳过交互确认，避免「顺手 --yes」把插件写进真库',
        ].join('\n'),
      );
    }
    console.log('  （--yes + KBW_ALLOW_REAL=1 都已给，跳过交互确认）');
    return true;
  }
  if (!process.stdin.isTTY) {
    fail('stdin 不是终端 —— 真库部署必须交互确认，或在明确知情时加 --yes');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question('  确认要部署到真库吗？手打 yes 继续：', res));
  rl.close();
  if (ans.trim().toLowerCase() !== 'yes') {
    console.log('\n已取消，什么都没做。\n');
    process.exit(0);
  }
  return true;
}

// ── 2. 拷贝 ────────────────────────────────────────────────────
function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}
function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
  }
  return n;
}
function copyIn() {
  fs.mkdirSync(pluginDir, { recursive: true });
  const report = [];
  for (const f of FILES) {
    const src = path.join(ROOT, f);
    const dst = path.join(pluginDir, f);
    fs.copyFileSync(src, dst);
    const a = fs.statSync(src).size;
    const b = fs.statSync(dst).size;
    // 回读校验：静默写失败是这个项目反复踩过的坑（saveData 吞 ENOENT / 多级目录）
    if (a !== b) fail(`${f} 拷贝后大小不一致（源 ${a} / 目标 ${b}）`);
    report.push({ name: f, size: a });
  }
  for (const d of DIRS) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) {
      // 资产目录不存在 = 还没拍图（或误删）——**大声说出来**，别静默发布一个没配图的插件
      console.warn(`⚠ 缺少目录 ${d}/ —— 跳过（向导配图会走"加载失败就隐藏"那条路）`);
      continue;
    }
    const dst = path.join(pluginDir, d);
    fs.rmSync(dst, { recursive: true, force: true }); // 覆盖式：不留孤儿文件
    fs.cpSync(src, dst, { recursive: true });
    const a = countFiles(src);
    const b = countFiles(dst);
    if (a !== b) fail(`${d}/ 拷贝后文件数不一致（源 ${a} / 目标 ${b}）`);
    report.push({ name: `${d}/（${a} 个文件）`, size: dirSize(dst) });
  }
  return report;
}

// ── 3. 实验库：写 community-plugins.json 把插件启用起来 ─────────
function enableInSandbox() {
  const file = path.join(target, '.obsidian', 'community-plugins.json');
  let list = [];
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      console.warn('  ⚠ community-plugins.json 解析失败，按空数组处理');
    }
  }
  if (list.includes(id)) return { changed: false, list };
  list.push(id);
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  return { changed: true, list };
}

// ── 主流程 ─────────────────────────────────────────────────────
if (isReal) await confirmReal();

const report = copyIn();
console.log(`\n✓ 已部署到 ${isReal ? '【真库】' : '【实验库】'}`);
console.log(`  ${pluginDir}`);
for (const r of report) console.log(`  · ${r.name.padEnd(20)} ${(r.size / 1024).toFixed(1)} KB`);

if (isReal) {
  console.log('\n  真库里还需要你手动做两步（本脚本刻意不代劳）：');
  console.log('   1. 设置 → 第三方插件 → 把「经纬」打开');
  console.log('   2. 若「受限模式」还开着，先点「开启社区插件并重载」');
} else if (noEnable) {
  console.log('\n  （--no-enable：未改 community-plugins.json）');
} else {
  const r = enableInSandbox();
  console.log(`\n  community-plugins.json：${r.changed ? '已加入 ' + id : '本来就有 ' + id}`);
  console.log('  ⚠ 「社区插件总开关」是**应用级 localStorage**，程序化关不掉（platform-pitfalls #26）：');
  console.log('    新库第一次必须在 Obsidian 界面上手点一次「开启社区插件并重载」。');
}

console.log('\n  下一步：Obsidian 里 Ctrl+R 重载，或 设置 → 第三方插件 → 关掉再打开「经纬」。\n');
