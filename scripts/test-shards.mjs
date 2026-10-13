/**
 * scripts/test-shards.mjs —— **离线套件分片驱动**（P7.20-1）
 *
 * 全量离线套件（24 块 · ~1200 条）单进程要 14 分钟；这台机器 32 核，纯浪费。
 * 这里把它拆成 N 片**并行**跑，墙钟时间接近 1/N。
 *
 * 切在**块**粒度（为什么不能更细，见 `tests/shards.ts` 的文件头：块内用例有顺序依赖）。
 *
 * 用法：
 *   node scripts/test-shards.mjs                 # 4 片并行（默认）
 *   node scripts/test-shards.mjs --shards 8      # 8 片
 *   node scripts/test-shards.mjs --serial        # 分片但**串行**跑（对照用：验"并行本身不改判据"）
 *   node scripts/test-shards.mjs --shard 2       # 只跑第 2 片（调试某一片）
 *   node scripts/test-shards.mjs --shards 4 --keep-going   # 有片红了也把它跑完再汇总（默认就是跑完）
 *
 * ── 判据（这个脚本存在的意义全在这三条）───────────────────────────
 *   ① **覆盖核查**：各片自报的块名，并起来必须**恰好**是全部块（不缺、不重）。
 *      —— 防的是分片自己带来的假绿："某块谁也不跑，各片都绿"。
 *   ② **失败并集**：任一片有失败 → 整体红，并把失败名单原样打出来。
 *   ③ **不认退出码 0**：分片模式下每片都退 2（"只跑了子集，不算通过"）。
 *      整体绿 = 每片都退 2 **且**没有失败 **且**覆盖核查通过。
 *
 * ⚠️ 每片在 `tests/.tmp/<tag>` 与 `tests/.fixture/<tag>` 里各自开一份临时库与夹具 ——
 *    `ensureFixtures()` 会先 rmrf 再重建，共享目录下并行必然互删（见 `tests/helpers.ts`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath; // 用当前跑的 node（本机 = system v24；managed v22 会被强杀）
const TEST = path.join(ROOT, 'scripts', 'test.mjs');
const TMP = path.join(ROOT, 'tests', '.tmp');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('-') ? v : dflt;
};
const SHARDS = Math.max(1, Math.floor(Number(argOf('--shards', '4'))));
const SERIAL = argv.includes('--serial');
const ONLY_K = argv.includes('--shard') ? Math.max(0, Math.floor(Number(argOf('--shard', '0')))) : -1;
if (ONLY_K >= SHARDS) {
  console.error(`✗ --shard ${ONLY_K} 越界（--shards ${SHARDS} 的合法序号是 0..${SHARDS - 1}）`);
  process.exit(1);
}

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const secs = (t) => `${(t / 1000).toFixed(1)}s`;

const ks = ONLY_K >= 0 ? [ONLY_K] : [...Array(SHARDS).keys()];
const tagOf = (k) => `s${k}`;
const logOf = (k) => path.join(TMP, tagOf(k), 'run.log');
const resultsOf = (k) => path.join(TMP, tagOf(k), 'last-results.json');

console.log(c.bold(`\n经纬 · 离线套件分片：${ks.length} 片${SERIAL ? '（串行）' : '（并行）'}\n`));

// ── 1. 先建一次产物（bundle + styles）───────────────────────────
// 四片同时 esbuild 写同一个 outfile、同时写 styles.css → 互相打断 / 读到写了一半的 css。
// 所以：驱动建一次，各片 `KBW_NO_BUILD=1` 只读。（见 scripts/test.mjs 里那段的注释）
{
  const t = Date.now();
  const r = await run(NODE, [TEST, '--prepare'], { stdio: 'inherit' });
  if (r !== 0) {
    console.error(c.bad('✗ 产物准备失败 —— 分片跑不起来'));
    process.exit(1);
  }
  console.log(c.dim(`（产物就绪，${secs(Date.now() - t)}）\n`));
}

// ── 2. 跑各片 ──────────────────────────────────────────────────
const t0 = Date.now();
const results = new Map(); // k → { code, ms, log }

function spawnShard(k) {
  const tag = tagOf(k);
  const log = logOf(k);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'w');
  const t = Date.now();
  return new Promise((resolve) => {
    const ch = spawn(NODE, [TEST], {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        KBW_SHARDS: String(SHARDS),
        KBW_SHARD: String(k),
        KBW_SHARD_TAG: tag,
        KBW_NO_BUILD: '1',
        // 成绩单 / 耗时各自一份 —— 否则四个进程抢同一个文件
        KBW_RESULTS_PATH: resultsOf(k),
        KBW_TIMINGS_PATH: path.join(TMP, tag, 'timings.json'),
        // ⚠️ 并行下 CPU 被 N 份摊开，卡住阈值要放宽（否则"真慢"会被误判成"卡住"）
        KBW_TEST_STALL: process.env.KBW_TEST_STALL ?? (SERIAL ? '60000' : '180000'),
      },
    });
    ch.on('close', (code) => {
      fs.closeSync(fd);
      resolve({ k, code: code ?? 1, ms: Date.now() - t, log });
    });
  });
}

if (SERIAL) {
  for (const k of ks) {
    process.stdout.write(c.dim(`… 片 ${k + 1}/${SHARDS} 起跑\n`));
    results.set(k, await spawnShard(k));
    const r = results.get(k);
    console.log(
      `${r.code === 2 ? c.ok('  ✓') : c.bad('  ✗')} 片 ${k + 1}/${SHARDS}　${secs(r.ms)}　退出码 ${r.code}`,
    );
  }
} else {
  // 并行：stdout 各写各的日志文件（交错起来没法看），跑完再逐片报一行
  const running = ks.map(async (k) => {
    const r = await spawnShard(k);
    results.set(k, r);
    console.log(
      `${r.code === 2 ? c.ok('  ✓') : c.bad('  ✗')} 片 ${k + 1}/${SHARDS}　${secs(r.ms)}　退出码 ${r.code}　${c.dim(path.relative(ROOT, r.log))}`,
    );
    return r;
  });
  await Promise.all(running);
}
const wall = Date.now() - t0;

// ── 3. 汇总 ────────────────────────────────────────────────────
console.log(c.bold(`\n── 汇总 ──`));
let totalCases = 0;
let totalPassed = 0;
const failedNames = [];
const badShards = [];
/** ②覆盖核查：各片自报的块名并起来必须恰好是全部块 */
const unionBlocks = new Set();
let declaredBlocks = 0;
const seenPerShard = [];

for (const k of [...results.keys()].sort((a, b) => a - b)) {
  const r = results.get(k);
  let sheet = null;
  try {
    sheet = JSON.parse(fs.readFileSync(resultsOf(k), 'utf8'));
  } catch {
    /* 成绩单没落盘（跑挂了）→ 下面按红处置 */
  }
  const txt = fs.existsSync(r.log) ? fs.readFileSync(r.log, 'utf8') : '';
  // 片自报的那行：`分片 K/N：本片负责 6/24 块 —— A:real · B:move · …`
  const m = /本片负责 (\d+)\/(\d+) 块\s*——\s*(.+)/.exec(txt);
  const mine = m ? m[3].split('·').map((s) => s.trim()).filter(Boolean) : [];
  if (m) declaredBlocks = Number(m[2]);
  for (const b of mine) unionBlocks.add(b);
  seenPerShard.push({ k, declared: m ? Number(m[1]) : 0, got: mine.length });

  const cases = sheet?.total ?? 0;
  const passed = sheet?.passed ?? 0;
  const failed = sheet?.failed ?? [];
  totalCases += cases;
  totalPassed += passed;
  for (const n of failed) failedNames.push(`片${k + 1} · ${n}`);

  const bad = r.code === 0 || r.code === 1 || !sheet || failed.length > 0 || !m;
  if (bad) badShards.push({ k, code: r.code, why: !sheet ? '成绩单缺失' : !m ? '没自报块名' : failed.length ? `${failed.length} 条失败` : `退出码 ${r.code}` });
  console.log(
    `  片 ${k + 1}/${SHARDS}：用例 ${passed}/${cases}　失败 ${failed.length}　块 ${mine.length}　${secs(r.ms)}　` +
      (bad ? c.bad(`✗ ${!sheet ? '成绩单缺失' : !m ? '没自报块名' : failed.length ? '有失败' : '退出码 ' + r.code}`) : c.ok('✓')),
  );
}

console.log(
  c.dim(
    `\n  覆盖核查：各片合计声明 ${seenPerShard.reduce((s, x) => s + x.declared, 0)} 块 · ` +
      `去重后 ${unionBlocks.size} 块 · 全局共 ${declaredBlocks} 块`,
  ),
);
// ① 覆盖：不缺（去重数 = 总数）、不重（各片声明数之和 = 去重数）、各片自报数与实际列出的块数一致
const coverOk =
  declaredBlocks > 0 &&
  unionBlocks.size === declaredBlocks &&
  seenPerShard.reduce((s, x) => s + x.declared, 0) === unionBlocks.size &&
  seenPerShard.every((x) => x.declared === x.got);
if (!coverOk) {
  console.log(c.bad('  ✗ 覆盖核查没过 —— 分片的块分配有缺失或重复（**这会静默漏测整块用例**）'));
  for (const x of seenPerShard) console.log(c.dim(`      片 ${x.k + 1}：声明 ${x.declared} / 列出 ${x.got}`));
} else {
  console.log(c.ok(`  ✓ 覆盖核查通过（${declaredBlocks} 块全部有片认领，无重复）`));
}

console.log(
  `\n  用例合计 ${totalPassed}/${totalCases}　失败 ${failedNames.length}　` +
    `墙钟 ${secs(wall)}（${SERIAL ? '串行' : '并行'} ${results.size} 片）`,
);
if (failedNames.length > 0) {
  console.log(c.bad('\n  未通过：'));
  for (const n of failedNames) console.log(`    ✗ ${n}`);
}

// ③ 判绿：所有片退 2（子集）+ 无失败 + 覆盖通过 + 无"跑挂的片"
let code = 0;
if (failedNames.length > 0 || badShards.length > 0 || !coverOk) {
  code = 1;
  if (badShards.length > 0) {
    console.log(c.bad('\n  异常的片（成绩单/自报缺失，或退出码不是 2）：'));
    for (const b of badShards) console.log(`    ! 片 ${b.k + 1}：${b.why}（退出码 ${b.code}，日志 ${path.relative(ROOT, results.get(b.k).log)}）`);
  }
}
if (code === 0) {
  console.log(c.ok(`\n✓ 分片全绿（每片都是"子集"退出码 2 —— 整体判绿由上面的覆盖核查担保）`));
} else {
  console.log(c.bad(`\n✗ 分片判红 —— 逐片日志在 tests/.tmp/s*/run.log`));
}
process.exit(code);

/** 小工具：跑一个子进程并等它结束，返回退出码 */
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd: ROOT, ...opts });
    ch.on('close', (code) => resolve(code ?? 1));
  });
}
