// scripts/last-green.mjs —— 「上一轮收尾刚在同一份源码上全绿过 → 开工基线可以免跑」
//（2026-10-09 加 · 检查流程优化；省的是每轮开工那 ~12 分钟的基线 `npm test`）
//
// 用法（写进 CLAUDE.md「开发方式」的检查流程）：
//   · 收尾：**看过「全部通过 ✅」之后**跑 `npm run last-green -- record` —— 记下当前源码指纹；
//   · 开工：`npm run last-green -- check` —— 指纹一致 → 「基线可免」（退出码 0）；不一致 → 要跑（退出码 1）。
//
// 指纹 = `git ls-files` 之下 `src/ tests/ scripts/ styles/ package.json tsconfig.json manifest.json`
// 的**工作树内容**哈希（sha256 截 16 位）——认的是"这份源码本身"：
//   · **committed 与未提交的改动都算数**（收尾跑全量那一刻，树恰恰是脏的——round 的改动还没 commit）；
//   · 不认 node_modules / 依赖版本（换依赖是罕见操作 → 那时手动跑一次基线）。
//
// ⚠️ P7.19 补的两个洞（都能**把全量翻红却不动指纹** → `check` 误报"基线可免"）：
//   · `WATCHED` 少了 **`styles/`**（离线套件里有一批样式源断言，见 `scripts/styles.mjs` 的构建产物）
//     与 **`manifest.json`**（插件清单，改了加载行为就可能变）；
//   · `git ls-files` **只列已追踪** → 本轮"先 record 后 commit"时，**新文件还没进索引**，
//     提交之后指纹才"虚变"，`check` 于是误报"要跑基线"（P7.18b §6 实踩）。
//     加 `--others --exclude-standard` 一起列**未追踪但没被 gitignore**的文件，顺序不再敏感。
//
// ⚠️ P7.19 收尾又踩到一条**虚变**（不是 bug，是设计使然，别去"修"它）：
//   指纹认的是**工作树字节**。而 `.gitattributes`（`* text=auto eol=lf`）会在**任何一次 git 动作**
//   （commit / merge / checkout）时把工作树里原本 CRLF 的文件改写为 LF（git 会先给
//   `warning: ... CRLF will be replaced by LF the next time Git touches it`）。
//   ⇒ 于是 `record` 之后只要一 `git merge`，`check` 就会报"要跑基线"，而**文件数没变**（仍 267）、
//   内容语义也没变。**处置两条都行**：① 在最终的树上重跑一次全量再 `record`（P7.19 选的）；
//   ② 认了 eol 差异、不 record（下轮开工照跑基线，成本一样）。**别为了消告警造假记录**。
//
// 存储 = `tests/.tmp/.last-green.json`：`.tmp/` 是 gitignore 的（不进 git），
// 又**不在** `makeTempVault` 清理的那几个子目录里（跨 run 存活）。
//
// ⚠️ `record` 不替你判断"真的绿了"—— 它只记指纹（"看过 ✅ 才记"是使用纪律）。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STORE = path.join(ROOT, 'tests', '.tmp', '.last-green.json');
const WATCHED = ['src', 'tests', 'scripts', 'styles', 'package.json', 'tsconfig.json', 'manifest.json'];

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};

function fingerprint() {
  // `--cached --others --exclude-standard` = **已追踪 + 未追踪（但不含 gitignore）** ——
  // 少了 `--others` 就会在"先 record 后 commit"时把新文件漏掉（见文件头那段）。
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...WATCHED],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const h = crypto.createHash('sha256');
  for (const f of listed) {
    h.update(`${f}\0`);
    h.update(fs.readFileSync(path.join(ROOT, f)));
    h.update('\0');
  }
  return { fp: h.digest('hex').slice(0, 16), files: listed.length };
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return null;
  }
}

const mode = process.argv[2];
const now = fingerprint();

if (mode === 'record') {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(
    STORE,
    `${JSON.stringify({ fp: now.fp, at: new Date().toISOString(), files: now.files }, null, 2)}\n`,
    'utf8',
  );
  console.log(c.ok('✓ 已记录基线指纹') + c.dim(`（${now.fp} · ${now.files} 个文件）`));
  console.log(c.dim('  前提：你刚看过「全部通过 ✅」——record 不替你判断绿的。'));
  process.exit(0);
}

if (mode === 'check') {
  const last = readStore();
  if (!last) {
    console.log(c.bad('✗ 没有基线记录') + c.dim('（tests/.tmp/.last-green.json 不存在）→ 跑基线全量'));
    console.log(c.dim('  跑完记得：npm run last-green -- record'));
    process.exit(1);
  }
  if (last.fp === now.fp) {
    console.log(c.ok('✓ 基线可免') + c.dim(`（源码指纹与上次全绿一致：${now.fp}，${last.at} 记的）`));
    console.log(c.dim('  ⚠️ 该跑的照跑：npm run typecheck ＋ npm run lint:probe；收尾全量一样要跑。'));
    process.exit(0);
  }
  console.log(
    c.bad('✗ 要跑基线') +
      c.dim(`（指纹变了：记的是 ${last.fp}，现在是 ${now.fp}——源码/测试/脚本动过）`),
  );
  process.exit(1);
}

console.error('用法：node scripts/last-green.mjs record | check');
process.exit(1);
