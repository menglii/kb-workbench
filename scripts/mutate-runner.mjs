// scripts/mutate-runner.mjs —— 突变验红的**通用运行器**（2026-10-09 加 · 检查流程优化）
//
// 每一轮的 `mutate-p7xx.mjs` 只写「MUTATIONS 数组 + 一句 `await runMutations(...)`」——
// 运行纪律（备份到仓库外 / 锚点自证 / 汇总行与过滤词双检 / 必还原 / 汇总退出码）全在这里，
// **一份实现**，别再每轮复制粘贴（本项目"两处各写一份必漂"的老账；P7.17 起照此用，
// 历史的 mutate-p715/716.mjs 是留档，不回头改）。
//
// 用法（每轮脚本的骨架）：
//
// ```js
// import { runMutations } from './mutate-runner.mjs';
// const MUTATIONS = [
//   {
//     id: 'M1-不推坏前言旗标',
//     file: 'src/core/vault-index.ts',
//     /** 过滤词：KBW_TEST_ONLY 用它筛出"该红"的那几条判据 */
//     test: '两种坏形状',
//     /** 可选：断言"**预期那条**"确实进了失败名单（子串匹配）—— 不然"随便哪条红了"也算咬住 */
//     expect: '不推坏前言旗标',
//     /** 返回 null = 锚点没命中（会判红：别让"没应用"冒充"没咬住"） */
//     apply(s) { ... return mutatedSource; },
//   },
// ];
// await runMutations(MUTATIONS, { tag: 'p717' });
// ```
//
// 纪律（照 `坑/判据与验证.md`，与 mutate-p715/p716 同款）：
//   · 每次突变**先自证锚点命中**（不命中就红）；
//   · 突变前把整份源码拷到**仓库外**（别放 `tests/.tmp` —— 会被下一次 run 清掉；
//     **别用 git checkout 还原** —— 会吃掉未提交改动）；
//   · 判红前**先看汇总行在不在**（"没找到汇总行" = 没跑起来，不是"通过"）；
//     过滤词一条都没命中（总数 0）也单独拦（那是"测试没跑"，不是"没咬住"）；
//   · 🔴 **跑套件用异步 `spawn(process.execPath, …)`**，别用 `npm test`（P7.19 实测定性两件事：
//     ① `npm` 会按 PATH 找 `node`，本机 PATH 排最前的是 managed v22 → `fs.cpSync` 被强杀 →
//        **只打印一行 banner 就死**，判定器把它读成"过滤词没选中"；② `execFileSync` 同步占满
//        事件循环 → 信号处理器在测试期间根本不会被调用，"中断还原"成了摆设）。
//     旧口径"Windows 下 spawn npm 要 `shell: true`"（P7.7c）在**本机沙箱**里已被这条取代；
//   · 🔴 **每处突变 = 一次过滤后的 `npm test`** —— 所以它**独占跑**：别与全量
//     共享固定临时库、也别与部署共享源码（检查流程里的"突变先独占"就是这么来的）。
//
// ⚠️ 每轮**只突 3–5 处最险的新判据**（2026-10-09 拍），其余并入滚动轮批量补 ——
//    "磨刀"要花在刀刃上：突变证明的是"这条新判据真的能红"，不是"把整轮 diff 全围一遍"。
//
// ── P7.19 加的三件（#3 判定器硬化 · #7 中断安全）────────────────────────
//
// **#3 为什么改**：旧的判法是"失败数 > 0 且有 ✗"就算咬住 —— 那**证明不了是这条判据红的**。
// 过滤词宽一点（比如"搬到"能选中 10 条），突变打断了**其中任意一条**都算数，
// 于是"新判据真的能红"这件事根本没被验证（正是本项目最怕的假绿形状）。
// 现在三件一起上：
//   ① `npm test` 收尾落 `tests/.tmp/last-results.json`（**一处落盘**在 `tests/index.ts`）；
//   ② 这里**解析 JSON + 打印失败名单**，mutation 可声明 `expect: '名字子串'`，
//      断言"**预期那条**在失败名单里"；
//   ③ 每个过滤词**先跑一次对照**（干净源码必须绿）—— 否则"过滤词本身就有红"会冒充"咬住了"。
//   ⚠️ 每次跑前**先删 JSON**：不然上一次的残留会冒充这一轮的结果（"JSON 缺失"必须能红）。
//   ⚠️ **成绩单（JSON）是主判据，汇总行只兜底**（P7.19 实测的修正）：stdout 走管道，
//      偶发拿不到末段 —— 同一个突变态手工跑明明有 `通过 2 / 4　失败 2`，判定器却报
//      "没找到汇总行"（把"咬住了"读成"没跑起来"）。落盘文件不受管道语义影响。
//
// **#7 为什么加**：以前被强杀（TaskStop / Ctrl-C / 断电）会**把突变态的源码留在工作树里** ——
// 下一次 `npm test` 拿到的是一份坏源码，红得莫名其妙。现在：
//   · 启动时**自检残留**（仓库外的 journal）→ 报出来 + **自动还原**（这就是"一键"）；
//   · `SIGINT` / `SIGTERM` 时**同步还原**当前这一处，再按信号规矩退出。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
/** `tests/index.ts` 收尾落的成绩单（**唯一**一份）—— 这里只读它 */
const RESULTS = path.join(ROOT, 'tests', '.tmp', 'last-results.json');
const SUMMARY_RE = /通过 (\d+) \/ (\d+)　失败 (\d+)/;

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};

// ── 成绩单读写 ──────────────────────────────────────────────────
/** 读 `last-results.json`；**每次跑前先删**，所以"读不到"就是"这一轮没落盘"（该红） */
function readResults() {
  try {
    const r = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

/** 正在跑的那个 `scripts/test.mjs` 子进程（信号来了要把它带走，别留孤儿） */
let child = null;

/**
 * 跑一次套件（带过滤词）→ 返回 stdout+stderr 合并的文本（不看退出码，看内容与成绩单）。
 *
 * 🔴 **用异步 `spawn`，不用 `execFileSync`**（P7.19 #7 的关键）：
 * `execFileSync` 是**同步**的 —— 它把事件循环**占满**整段测试时长，于是
 * `process.on('SIGINT'/'SIGTERM')` 注册的处理器**在测试跑着的时候根本不会被调用**，
 * "中断时同步还原"就成了摆设（信号只会在两次同步调用之间的空档里才被处理，而那个空档几乎不存在）。
 * 异步 spawn 让事件循环活着 → 信号能立刻进处理器 → 真的来得及把当前那一处还原回去。
 * 顺带：异步 spawn 在本机沙箱里本来就是好的（要打补丁的只有同步那族）。
 *
 * 🔴 **别走 `npm`**（P7.19 实测定性）：`npm test` 会**按 PATH 找 `node`**，而本机
 * PATH 里排在最前面的是 **宿主工具链 managed node v22.22.2-3** —— 它的
 * `fs.cpSync(recursive)` 会被外部强杀（`status=3221226505` = `0xC0000409`，
 * 连 `process.on('exit')` 都不触发），症状 = **只打印一行 `经纬 · P0 离线验收` 就死**，
 * 判定器于是报"没找到汇总行 / 对照跑没跑起来"，**看起来像过滤词写错了**（离真相很远）。
 * 走 `process.execPath` 就钉死了"**启动本运行器的那一个 node**"（应当是本机 system node v24，
 * 见下面那道自检），既绕开 PATH 歧义，也绕开 `shell: true` 要经过的 `cmd.exe`（沙箱会拦）。
 * （P7.7c 那条"Windows 下 spawn npm 要 `shell: true`"在**本机沙箱**里已被这条取代。）
 */
function runTests(test) {
  fs.rmSync(RESULTS, { force: true }); // 先删 → "成绩单读不到"才有意义
  const env = { ...process.env, KBW_TEST_ONLY: test };
  delete env.KBW_TEST_LIST; // 列表模式绝不能漏进突变跑（那会一条都不跑）
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'test.mjs')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.stderr.on('data', (d) => {
      out += d;
    });
    proc.on('error', (e) => {
      out += `\n[spawn 失败] ${e.message}\n`;
    });
    proc.on('close', () => {
      child = null;
      resolve(out);
    });
  });
}

// ── 残留自检 + 中断安全（#7）────────────────────────────────────
const JOURNAL = (backup) => path.join(backup, '_journal.json');
function writeJournal(backup, entries) {
  try {
    fs.writeFileSync(JOURNAL(backup), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  } catch {
    /* 记不上就算了 —— 不因为日志失败而中断验红 */
  }
}
function readJournal(backup) {
  try {
    const j = JSON.parse(fs.readFileSync(JOURNAL(backup), 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/**
 * 启动自检：仓库外的 journal 里还有"没还原"的条目 = 上一轮被强杀过。
 * **先还原再干活** —— 不然这一轮的对照跑会拿一份坏源码跑（红得莫名其妙）。
 */
function restoreResidue(backup) {
  const stale = readJournal(backup);
  const restored = [];
  for (const e of stale) {
    try {
      const abs = path.join(ROOT, e.file);
      const bak = fs.readFileSync(e.bak, 'utf8');
      const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (cur !== bak) {
        fs.writeFileSync(abs, bak, 'utf8');
        restored.push(e.file);
      }
    } catch {
      /* 备份读不了 → 交给下面报出来 */
    }
  }
  writeJournal(backup, []);
  return restored;
}

/**
 * 跑一批突变。全部被咬住 → `process.exit(0)`；否则打印问题并 `exit(1)`。
 *
 * @param {Array<{id: string, file: string, test: string, expect?: string, apply: (src: string) => string | null}>} mutations
 * @param {{tag?: string}} [opts] `tag` 只进备份目录名（`kbw-<tag>-mut-backup`），便于多轮共存
 */
export async function runMutations(mutations, { tag = 'mut' } = {}) {
  const BACKUP = path.join(os.tmpdir(), `kbw-${tag}-mut-backup`);
  fs.mkdirSync(BACKUP, { recursive: true });

  /**
   * 🔴 **自检：跑套件的 node 必须是"能跑套件的那个"**。
   * 宿主工具链 managed node（`~/.tooling/binaries/node/**`）的 `fs.cpSync(recursive)` 会被外部
   * 强杀 → 表现为"只打印一行 banner 就死"，而判定器会把它读成"过滤词没选中"。
   * 与其让人对着假线索查半小时，不如**入口就红**（本机正确姿势 = `F:/03_DevTools/Node.js/node.exe`，
   * 项目 `.nvmrc` = 24）。
   */
  if (/[\\/]\.tooling[\\/]binaries[\\/]node[\\/]/.test(process.execPath)) {
    console.error(c.bad(`\n✗ 你在用 宿主工具链 managed node 跑套件：${process.execPath}`));
    console.error(c.dim('   → 换 system node：`F:/03_DevTools/Node.js/node.exe scripts/mutate-p7xx.mjs`'));
    process.exit(1);
  }

  // ── #7 启动自检残留 ─────────────────────────────────────────
  const staleBefore = readJournal(BACKUP);
  if (staleBefore.length > 0) {
    const restored = restoreResidue(BACKUP);
    console.log(
      c.warn(`\n⚠️ 检测到上次未收尾的突变残留（进程被强杀？journal 里 ${staleBefore.length} 条）`),
    );
    console.log(c.dim(`   已自动还原（"一键"就是这个）：${restored.length ? restored.join(' · ') : '（磁盘内容已与备份一致，无需改）'}`));
    if (restored.length > 0) {
      console.log(c.dim('   ⚠️ 还原是**进程被杀那一刻**的状态 —— 若你之后又手改过这些文件，请自己核一眼。'));
    }
  }

  // ── #7 中断安全：同步还原当前这一处 ──────────────────────────
  /** 当前"已写进工作树、尚未还原"的那一处（信号来了就把它还原掉） */
  let inFlight = null; // { abs, src }
  let journal = [];
  const onSignal = (sig) => {
    // 先把正在跑的套件子进程带走（别留一个孤儿在后台啃 CPU）
    if (child) {
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
    }
    if (inFlight) {
      try {
        fs.writeFileSync(inFlight.abs, inFlight.src, 'utf8');
        console.error(c.warn(`\n⚠️ 收到 ${sig} —— 已把 ${path.relative(ROOT, inFlight.abs)} 还原回原样`));
      } catch (e) {
        console.error(c.bad(`\n✗ 收到 ${sig}，但还原失败：${e.message}`));
        console.error(c.bad(`   手动还原：把 ${inFlight.abs} 写回备份目录里的对应 .bak`));
      }
    }
    journal = [];
    writeJournal(BACKUP, journal);
    console.error(c.dim('   突变未跑完 → 本轮不算通过，退出码 130。'));
    process.exit(130);
  };
  const sigint = () => onSignal('SIGINT');
  const sigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);

  // ── #3 对照跑缓存（同一个过滤词只跑一次干净源码）─────────────
  const controlCache = new Map();
  /**
   * 从一次跑的输出里抽出"跑了吗 / 谁红了"。
   *
   * 🔴 **成绩单（`tests/.tmp/last-results.json`）是主判据，汇总行是兜底**（P7.19 实测的修正）：
   * 原先只认汇总行 —— 而 stdout 是**管道**，`execFileSync`/`spawn` 那一侧偶发拿不到完整的末段
   * （实测：同一个突变态**手工跑**明明有 `通过 2 / 4　失败 2`，判定器却报"没找到汇总行"，
   * 于是把"咬住了"读成"测试没跑起来"）。成绩单是**落盘文件**，不受管道语义影响，且信息更全
   * （失败用例名、总数、耗时都在里面）—— 所以：有成绩单就用它，没有才退回汇总行。
   * 两条**都没有**才判"没跑起来"（那是真的没跑）。
   */
  function digest(out) {
    const summary = out.match(SUMMARY_RE);
    const res = readResults();
    const ran = !!res || !!summary;
    const total = res ? Number(res.total ?? -1) : summary ? Number(summary[2]) : -1;
    const failedNames = res && Array.isArray(res.failed) ? res.failed.map(String) : null;
    const failedCount = res && Array.isArray(res.failed)
      ? res.failed.length
      : summary
        ? Number(summary[3])
        : -1;
    return { summary, res, ran, total, failedNames, failedCount };
  }

  /** 对照跑：**干净源码 + 这个过滤词**必须绿（成绩单为主判据 —— 缺成绩单不算绿） */
  async function control(test) {
    if (!controlCache.has(test)) {
      const out = await runTests(test);
      const d = digest(out);
      const green = d.ran && d.total > 0 && d.failedNames !== null && d.failedNames.length === 0;
      controlCache.set(test, { ...d, out, green });
    }
    return controlCache.get(test);
  }

  let bad = 0;
  for (const m of mutations) {
    const abs = path.join(ROOT, m.file);
    const bak = path.join(BACKUP, `${m.id}-${path.basename(m.file)}.bak`);

    // ── #3 ③ 先对照跑：干净源码必须绿 ─────────────────────────
    const ctrl = await control(m.test);
    if (!ctrl.ran) {
      console.log(c.bad(`✗ ${m.id}：**对照跑没跑起来**（成绩单与汇总行都没有 —— 真的没跑）`));
      console.log(c.dim(`   过滤词「${m.test}」；输出头 200 字：${ctrl.out.slice(0, 200).replace(/\n/g, '⏎')}`));
      bad += 1;
      continue;
    }
    if (ctrl.total === 0) {
      console.log(c.bad(`✗ ${m.id}：**对照跑一条用例都没选中**（过滤词「${m.test}」拼错了？）`));
      console.log(c.dim('   —— 先把过滤词改对，再判突变（不然"没跑"会冒充"咬住"）'));
      bad += 1;
      continue;
    }
    if (!ctrl.green) {
      /**
       * 🔴 **"没绿"与"成绩单缺失"必须分开报**（P7.19 反例自证时抓出）：
       * 原先只有一句"对照跑没绿 —— 干净源码上这个过滤词就有红"，于是**落盘坏了**会被读成
       * "过滤词自己有红"，把人往错方向带（反例（三）实测：成绩单没落盘时，报的却是
       * "干净源码有红"，而干净源码明明是绿的 —— 它只是没写成成绩单）。
       */
      if (!ctrl.res) {
        console.log(c.bad(`✗ ${m.id}：**对照跑成绩单缺失**（跑完了却没落盘 —— 判据被关 / 落盘路径坏了）`));
        console.log(c.dim('   → 查 tests/index.ts 收尾的落盘，以及 scripts/test.mjs 设的 KBW_RESULTS_PATH'));
      } else {
        console.log(c.bad(`✗ ${m.id}：**对照跑没绿** —— 干净源码上这个过滤词就有红，没法判突变`));
        console.log(c.dim(`   对照跑失败名单：${(ctrl.failedNames ?? []).join(' · ') || '（空）'}`));
      }
      bad += 1;
      continue;
    }

    const src = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(bak, src, 'utf8'); // 先备份到仓库外
    const mutated = m.apply(src);
    if (mutated == null || mutated === src) {
      console.log(c.bad(`✗ ${m.id}：**锚点没命中**（别把"没应用"当成"没咬住"）`));
      bad += 1;
      continue;
    }
    // 记账（仓库外）：被强杀时靠它把这一处还原回来
    journal = journal.filter((e) => e.file !== m.file);
    journal.push({ id: m.id, file: m.file, bak });
    writeJournal(BACKUP, journal);

    fs.writeFileSync(abs, mutated, 'utf8');
    inFlight = { abs, src };
    let out = '';
    try {
      out = await runTests(m.test);
    } finally {
      fs.writeFileSync(abs, src, 'utf8'); // 还原（无论如何）
      inFlight = null;
      journal = journal.filter((e) => e.file !== m.file);
      writeJournal(BACKUP, journal);
    }

    // ── #3 判定：跑起来了吗 → 谁红了 → 是预期那条吗 ──────────────
    const d = digest(out);
    if (!d.ran) {
      console.log(c.bad(`✗ ${m.id}：**测试没跑起来**（成绩单与汇总行都没有）`));
      console.log(c.dim(`   输出头 200 字：${out.slice(0, 200).replace(/\n/g, '⏎')}`));
      bad += 1;
      continue;
    }
    if (d.total === 0) {
      console.log(c.bad(`✗ ${m.id}：**过滤词一条都没选中**（测试没跑，不算咬住）`));
      bad += 1;
      continue;
    }
    /**
     * ⚠️ **成绩单缺了就要红**（不是"降级容忍"）：它是**落盘文件**，只要那轮跑完就一定会写；
     * 缺了说明"跑完了却没落盘"（判据被关掉 / 落盘路径坏了）—— 那样这条判据就无从核对了。
     * 这一档的反例 = 把 `KBW_RESULTS_PATH` 指到一个坏路径（`tests/index.ts` 落盘会失败）。
     */
    if (!d.res) {
      console.log(c.bad(`✗ ${m.id}：**成绩单缺失**（tests/.tmp/last-results.json 没落盘）—— 判据改了吗？`));
      console.log(c.dim('   检查 tests/index.ts 收尾的落盘与 KBW_RESULTS_PATH'));
      bad += 1;
      continue;
    }
    const failedNames = d.failedNames ?? [];
    if (failedNames.length === 0) {
      console.log(c.bad(`✗ ${m.id}：**没咬住** —— 突变后仍全绿（${d.summary ? d.summary[0] : `total=${d.total}`}）`));
      bad += 1;
      continue;
    }
    if (m.expect) {
      const hit = failedNames.some((n) => n.includes(m.expect));
      if (!hit) {
        console.log(c.bad(`✗ ${m.id}：**咬错了** —— 红了 ${failedNames.length} 条，但「${m.expect}」不在名单里`));
        console.log(c.dim(`   实际红的是：${failedNames.join(' · ')}`));
        bad += 1;
        continue;
      }
      console.log(c.ok(`✓ ${m.id}：咬住了（失败 ${failedNames.length} 条，含「${m.expect}」）`));
    } else {
      console.log(c.ok(`✓ ${m.id}：咬住了（失败 ${failedNames.length} 条）`));
    }
    console.log(c.dim(`   失败名单：${failedNames.join(' · ')}`));
  }

  process.removeListener('SIGINT', sigint);
  process.removeListener('SIGTERM', sigterm);
  writeJournal(BACKUP, []);
  console.log(bad === 0 ? c.ok('\n✓ 全部突变都被咬住') : c.bad(`\n✗ ${bad} 处有问题`));
  process.exit(bad === 0 ? 0 : 1);
}
