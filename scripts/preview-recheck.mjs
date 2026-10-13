// 「属性迁移的**预演**那一步」重新完整跑一遍（用迁移前的备份换回实验库）
//
// 为什么需要它（`归档/期末交接-P2.md` 的记债 + 用户 2026-09-24 的交待）：
//   迁移是**单向**的 —— 实验库迁完之后，探针里那两步只剩"终态断言"
//   （断言"首页不再报旧规范、缺必填=0"），**预演路径本身**（列表、逐篇待定项、
//   模板自检、只读不改盘）就再也没被真机跑过。
//   要重新验它，就得把 `.tooling/backup/属性统一-<日期>/`（**迁移前**那份）
//   换回实验库，跑完再换回来。
//
// 它做的事（每一步都可核对）：
//   ① 给**当前**实验库打一份可用来自证的备份（`--out` 指定的目录）
//   ② 把当前的 `01_新知识库` 移到 `.tooling/swap-<时间戳>/`（**移动不是删除**）
//   ③ 把迁移前那份 `01_新知识库` 拷进来
//   ④ 提示你跑 `npm run probe -- --only "P2 ·"`（脚本不替你跑：探针要 CDP）
//   ⑤ 你按回车后：移走换进来的那棵树 → 把 ② 移走的移回来 → 按 manifest 核对 sha256
//
// 🔴 只在**实验库**上跑（复用 `vault-guard` 的判据）。真库不许碰。
//
// 用法：
//   node scripts/preview-recheck.mjs --backup "…/.tooling/backup/属性统一-2026-09-24" --out "…/.tooling/backup/P3-期中"
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { assertWritableSandbox, sandboxVault } from './vault-guard.mjs';

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
const backup = path.resolve(arg('backup', ''));
const out = path.resolve(arg('out', ''));
const KB = '01_新知识库';

if (!backup || !fs.existsSync(path.join(backup, KB))) {
  console.error(`✗ 迁移前备份里找不到 ${KB}：${backup}`);
  process.exit(1);
}
if (!out) {
  console.error('✗ 缺 --out（当前实验库的临时备份落到哪儿）');
  process.exit(1);
}
if (!fs.existsSync(path.join(vault, '.obsidian'))) {
  console.error(`✗ 不是有效的库（缺 .obsidian/）：${vault}`);
  process.exit(1);
}
const guard = assertWritableSandbox(vault, '换库做迁移预演复跑');
if (!guard.ok) {
  console.error(`✗ ${guard.reason}`);
  process.exit(1);
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 把一棵树拷到目标，并写一份 sha256 清单（与 vault-backup.mjs 同一口径） */
function backupTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  const rows = [];
  const walk = (dir, relDir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(src, rel);
        continue;
      }
      const dst = path.join(to, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      rows.push(`${sha256(src)} *${rel.replace(/\\/g, '/')}`);
    }
  };
  walk(from, '');
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.writeFileSync(
    path.join(to, 'manifest.sha256'),
    [`# 备份 —— ${stamp}`, `# 来源：${from}`, ...rows].join('\n') + '\n',
    'utf8',
  );
  return rows.length;
}

/** 按清单核对（返回 {ok, bad[], missing[]}） */
function verifyTree(dir, manifestPath) {
  const lines = fs
    .readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  const bad = [];
  const missing = [];
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64}) \*(.+)$/);
    if (!m) continue;
    const target = path.join(dir, m[2]);
    if (!fs.existsSync(target)) {
      missing.push(m[2]);
      continue;
    }
    if (sha256(target) !== m[1]) bad.push(m[2]);
  }
  return { ok: bad.length === 0 && missing.length === 0, bad, missing, total: lines.length };
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

/**
 * 非交互模式：`--then "npm run probe -- --only P2"` —— 换库之后**自动跑那条命令**，
 * 跑完自动换回来。CI/一口气验完用这个；不带 `--then` 就是交互式（跑一半歇着）。
 *
 * ⚠️ **换库必须让 Obsidian 重启过**（`--restart`，`--then` 模式下默认开）：
 * Obsidian 只对**单个文件**的变化敏感，整棵目录树被换掉它看不见 ——
 * 不重启的话索引里还是旧库那一份（真机实测：预演报「17 篇要改」，
 * 而迁移前那份备份里明明有 42 篇带旧键的）。
 */
const thenCmd = arg('then', '');
const restart = process.argv.includes('--restart') || (thenCmd !== '' && !process.argv.includes('--no-restart'));

const swapDir = path.join(vault, '.tooling', `swap-${Date.now()}`);
let moved = false;

/** 关掉 Obsidian（等进程真的没了）；换库前后各来一次 */
async function stopObsidian() {
  const { execFileSync } = await import('node:child_process');
  const count = () => {
    try {
      const out2 = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', "Get-Process Obsidian -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"],
        { encoding: 'utf8' },
      );
      return Number(out2.trim()) > 0;
    } catch {
      return false;
    }
  };
  if (!count()) return false;
  execFileSync('powershell', ['-NoProfile', '-Command', 'Stop-Process -Name Obsidian -Force -ErrorAction SilentlyContinue']);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && count()) await new Promise((r) => setTimeout(r, 400));
  return true;
}

const main = async () => {
  console.log(`实验库：${vault}`);
  console.log(`① 给当前状态打一份备份 → ${out}`);
  const n = backupTree(path.join(vault, KB), out);
  console.log(`   ${n} 个文件 + manifest.sha256`);

  if (restart) {
    const stopped = await stopObsidian();
    console.log(`   ${stopped ? '已关掉 Obsidian（换库前）' : 'Obsidian 本来就没开'}`);
  }

  const cur = path.join(vault, KB);
  const stash = path.join(swapDir, KB);
  const pre = path.join(backup, KB);
  console.log(`② 把当前 ${KB} 移到 ${stash}（**移动不是删除**）`);
  fs.mkdirSync(swapDir, { recursive: true });
  fs.renameSync(cur, stash);
  moved = true;
  console.log(`③ 把迁移前那份拷进来 ← ${pre}`);
  fs.cpSync(pre, cur, { recursive: true });

  if (thenCmd) {
    console.log(`
────────────────────────────────────────────────────────
现在实验库是**迁移前**的状态。跑：${thenCmd}
   ⚠️ 这一步之后**别在实验库里手动动库** —— 换回来时那份状态就没了
────────────────────────────────────────────────────────`);
    const { spawnSync } = await import('node:child_process');
    if (restart) {
      // 让它重新读一遍这棵树（目录树被换掉，不重启看不见）
      const launch = spawnSync('node', [path.join(ROOT, 'scripts', 'probe-launch.mjs')], {
        stdio: 'inherit',
        cwd: ROOT,
      });
      if (launch.status !== 0) console.error('⚠️ probe:launch 没成功（端口没起来的话探针会连不上）');
    }
    const r = spawnSync(thenCmd, { shell: true, stdio: 'inherit', cwd: ROOT });
    console.log(`（那条命令退出码=${r.status}）`);
  } else {
    console.log(`
────────────────────────────────────────────────────────
现在实验库是**迁移前**的状态。请：
   1) 在 Obsidian 里让插件重载一次（Ctrl+R）
   2) npm run probe -- --only "P2 ·"
   3) 看完结果回到这里按回车（脚本会把库换回来）
   ⚠️ 这一步之后**别在实验库里手动动库** —— 换回来时那份状态就没了
   （不想手动：加 --then "npm run probe -- --only P2" 让它自己跑）
────────────────────────────────────────────────────────`);
    await ask('跑完按回车换回原状… ');
  }

  console.log('④ 换回来');
  if (restart) {
    const stopped = await stopObsidian();
    console.log(`   ${stopped ? '已关掉 Obsidian（换回来之前，免得它把换回来的树又看混）' : 'Obsidian 没开着'}`);
  }
  fs.rmSync(cur, { recursive: true, force: true });
  fs.renameSync(stash, cur);
  moved = false;
  console.log('⑤ 按清单核对 sha256');
  const v = verifyTree(path.join(vault, KB), path.join(out, 'manifest.sha256'));
  if (v.ok) {
    console.log(`✓ 换回来了：${v.total} 个文件全部与备份一致`);
    fs.rmSync(swapDir, { recursive: true, force: true });
  } else {
    console.error(`✗ 对不上：坏 ${v.bad.length} / 缺 ${v.missing.length}`);
    for (const p of v.bad.slice(0, 5)) console.error(`   坏 ${p}`);
    for (const p of v.missing.slice(0, 5)) console.error(`   缺 ${p}`);
    console.error(`  临时目录留着没删：${swapDir}`);
    process.exitCode = 1;
  }
  if (restart) {
    const { spawnSync } = await import('node:child_process');
    spawnSync('node', [path.join(ROOT, 'scripts', 'probe-launch.mjs')], { stdio: 'inherit', cwd: ROOT });
  }
};

try {
  await main();
} catch (e) {
  console.error(`✗ 出错：${e.message}`);
  if (moved) {
    // 没换回来也要说清楚东西在哪，别让人以为丢了
    console.error(`  当前 ${KB} 被移到了 ${path.join(swapDir, KB)}，原状态在 ${out}`);
  }
  process.exitCode = 1;
} finally {
  rl.close();
  void ROOT;
}
