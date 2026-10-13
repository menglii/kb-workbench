// 备份：把一个库的指定子树**原样复制**到备份目录，并写一份 sha256 清单
//
// 用途（`开发计划.md` §7 step 1）：动属性之前先留一份可核对的原件。
// 与插件自己的快照不是一回事 —— 快照在插件目录里、给"撤销"用；这份是给
// **"到底改了多少、改了什么"**用的（改完拿 `sha256sum -c` 一比就知道了）。
//
// 用法：
//   node scripts/vault-backup.mjs --out "C:/…/sandbox-vault/.tooling/backup/属性统一-2026-09-24"
//   node scripts/vault-backup.mjs --vault "C:/…/real-vault" --out "…" --only 01_新知识库
//
// 🔴 **目的地不许落在真库里**：这是"迁移前留底"，误把备份写回真库就是往真库里塞东西。
//    判据复用 `vault-guard.mjs`（唯一来源），**按路径判**。
//    真要往真库里写：`--allow-real` **加上** `KBW_ALLOW_REAL=1`（与 `deploy.mjs` 的双保险同一口径）——
//    单给一个标志就能过的话，这个后门迟早会被顺手用掉（P2 收尾的独立审查指出）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertBackupTarget, sandboxVault } from './vault-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`✗ --${name} 后面要跟一个值`);
    process.exit(1);
  }
  return v;
}

const vault = path.resolve(arg('vault', sandboxVault()));
const out = arg('out', '');
const only = arg('only', '01_新知识库')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ⚠️ 双保险：标志 + 环境变量（`deploy.mjs` 的 `--yes` + `KBW_ALLOW_REAL=1` 就是这个口径）
const wantsReal = process.argv.includes('--allow-real');
if (wantsReal && process.env.KBW_ALLOW_REAL !== '1') {
  console.error('✗ --allow-real 要**同时**给 KBW_ALLOW_REAL=1（防手滑；与 deploy 同一口径）');
  process.exit(1);
}

if (!out) {
  console.error('✗ 缺 --out（备份落到哪儿）');
  process.exit(1);
}
if (!fs.existsSync(path.join(vault, '.obsidian'))) {
  console.error(`✗ 不是有效的库（缺 .obsidian/）：${vault}`);
  process.exit(1);
}
// `--only` 不许跑出库外（`--only ..` 会把库上一级整棵拷走）
for (const rel of only) {
  const parts = rel.split(/[\\/]/);
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || parts.includes('..')) {
    console.error(`✗ --only 只能是库内的相对目录（收到 ${rel}）`);
    process.exit(1);
  }
}
// 目的地判据：按**路径**判 + 双保险（实现只在 vault-guard 里 —— 离线用例直接断言它的**行为**，
// 不靠"源码里有这个字符串"：独立审查实测过，注释里提到 KBW_ALLOW_REAL 就能骗过子串匹配）
const target = assertBackupTarget(out, { allowReal: wantsReal });
if (!target.ok) {
  console.error(`✗ ${target.reason}`);
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`✗ 备份目的地已存在：${out}\n  换个目录名（带上日期），别覆盖上一份。`);
  process.exit(1);
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const rows = [];
let bytes = 0;
const copyTree = (srcRoot, rel) => {
  const src = path.join(srcRoot, rel);
  if (!fs.existsSync(src)) return;
  const walk = (dir, relDir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, e.name);
      const relPath = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(from, relPath);
        continue;
      }
      const to = path.join(out, relPath);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      const stat = fs.statSync(from);
      bytes += stat.size;
      rows.push({ rel: relPath.replace(/\\/g, '/'), hash: sha256(from), size: stat.size });
    }
  };
  walk(src, rel.replace(/\\/g, '/'));
};

fs.mkdirSync(out, { recursive: true });
for (const rel of only) copyTree(vault, rel);

rows.sort((a, b) => (a.rel < b.rel ? -1 : 1));
const md = rows.filter((r) => r.rel.toLowerCase().endsWith('.md')).length;
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
// ⚠️ 用**本地时间**：与库内日志文件名（`日志-YYYYMMDD-HHMMSS-…`）同一口径，
// 并排看不会差一个时区（第一版用了 toISOString = UTC，差 8 小时）
const stamp =
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
  `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const lines = [
  `# 备份清单 —— ${stamp}`,
  `# 来源：${vault}（只读拷贝，原库未改动）`,
  `# 范围：${only.join(' + ')}`,
  `# 文件数：${rows.length}（其中 md ${md}）｜合计 ${(bytes / 1024).toFixed(1)} KB`,
  `# 核对：cd "${out}" && sha256sum -c manifest.sha256`,
  ...rows.map((r) => `${r.hash} *${r.rel}`),
];
fs.writeFileSync(path.join(out, 'manifest.sha256'), `${lines.join('\n')}\n`, 'utf8');

console.log(`✓ 备份完成：${out}`);
console.log(`  文件 ${rows.length} 个（md ${md}）｜${(bytes / 1024).toFixed(1)} KB｜清单 manifest.sha256`);
console.log(`  来源 ${vault} → 范围 ${only.join(' + ')}`);
void ROOT;
