/**
 * scripts/probe-run.mjs —— **本机真机探针运行器**（P7.20 探针基建）
 *
 * 把「切库 → 起 Obsidian → 跑探针 → 复原」串成**一条命令**。为什么非要这样串，
 * 是 P7.20 在 宿主工具链 沙箱里实测出来的三条硬事实：
 *
 *  ① **Chromium 的 GPU 沙箱在沙箱里起不来** → Obsidian 裸起直接 FATAL（exit=3）：
 *       `[pid:FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:416]
 *        GPU process isn't usable. Goodbye.`
 *     加 `--no-sandbox` 才能活（`--disable-gpu` **不够**，只是死得晚几秒）。
 *     ⚠️ 这个报错极具误导性：`obsidian.mjs up` 只报"40 秒了调试端口还没起来"，
 *        很容易被误判成"没有交互式桌面"（P7.19 就是这么把探针记成 D7 欠账的）。
 *        真相：**桌面是有的**（同上下文起 notepad 能活），是 GPU 进程的问题。
 *
 *  ② **沙箱的 job object 在命令结束时回收所有后代进程** → Obsidian **跨命令活不下来**
 *     （detached + unref 也没用；关沙箱也一样）。所以 `up` 和 `probe` **必须同命令**，
 *     先 up 再单独 probe 永远连不上。
 *
 *  ③ **Obsidian 单实例 + 记住上次打开的库** → 上次开的是别的库时，探针红线会直接拒跑
 *     （`assertWritableSandbox` 按路径判）。这里启动前把 `obsidian.json` 的 open 标记
 *     切到实验库，**跑完复原**（原文件先备份，且只在 `open` 字段上动）。
 *
 * 用法：
 *   node scripts/probe-run.mjs                 # 冒烟档（--smoke）
 *   node scripts/probe-run.mjs --full          # 全量
 *   node scripts/probe-run.mjs --domain board  # 域档（P7.20-6，只跑该域 + 前置）
 *   node scripts/probe-run.mjs --only 样式      # 单串（同 npm run probe -- --only 样式）
 *   node scripts/probe-run.mjs --full --keep    # 跑完不恢复 obsidian.json（调试用）
 *   node scripts/probe-run.mjs --restore        # 一键复原 obsidian.json（被强杀后用）
 *   KBW_PROBE_SKIP_SHOT=1 node scripts/probe-run.mjs --domain board   # 迭代轮跳过截图（P7.20-7）
 *
 * ⚠️ 与 `npm run probe` 的关系：那个是"假设 Obsidian 已经带端口在跑"的原版；
 *    本脚本是**在本机沙箱里把 Obsidian 也管起来**的包装。真机（有 GPU 的日常桌面）
 *    仍然可以照旧用 `npm run obsidian -- up` + `npm run probe`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath; // 用当前跑的 node（本机 = system v24；managed v22 会被强杀）
const CFG = 'C:/Users/<你的用户名>/AppData/Roaming/obsidian/obsidian.json';
const BAK = path.join(ROOT, 'tests', '.tmp', 'obsidian.json.probe-bak');
const WANT_VAULT = 'C:/Users/<你的用户名>/OneDrive/Desktop/sandbox-vault';

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');

const c = { ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m` };

/** 把 Obsidian 的"上次打开的库"切到实验库；返回是否切成功 */
function pointConfigAtSandbox() {
  if (!fs.existsSync(CFG)) return { ok: false, reason: '找不到 obsidian.json：' + CFG };
  const raw = fs.readFileSync(CFG, 'utf8');
  fs.mkdirSync(path.dirname(BAK), { recursive: true });
  fs.writeFileSync(BAK, raw, 'utf8');
  const j = JSON.parse(raw);
  let hit = null;
  for (const [id, v] of Object.entries(j.vaults ?? {})) {
    const norm = String(v.path).replace(/\\/g, '/').toLowerCase();
    if (norm === WANT_VAULT.toLowerCase()) {
      v.open = true;
      hit = id;
    } else {
      delete v.open;
    }
  }
  if (!hit) return { ok: false, reason: 'obsidian.json 里没有实验库：' + WANT_VAULT };
  fs.writeFileSync(CFG, JSON.stringify(j), 'utf8');
  return { ok: true };
}

function restoreConfig() {
  if (!fs.existsSync(BAK)) return;
  fs.copyFileSync(BAK, CFG);
  fs.unlinkSync(BAK);
}

/**
 * ── 中断钩子（P7.20-8）：让 `finally` 里的复原**照走** ─────────────
 * 🔴 Ctrl+C 的默认动作是**立即终止** —— 会跳过 `finally`，于是 `obsidian.json`
 *    停在实验库。P7.20 实测中断过**两次，两次都是手工 `cp` 备份复原**的。
 *    手工的东西会漏第三次，所以这里把中断接管下来：
 *    · 子进程（`probe.mjs`）自己也接了 SIGINT/SIGTERM，会换 token 收尾后退出；
 *    · 父进程这里**不立刻退**（只打印一句），等 `spawnSync` 自然返回 → 走 `finally` → 复原。
 * ⚠️ `spawnSync` 是同步的：中断到达时主线程正阻塞在里面，JS 回调要等它返回才会跑 ——
 *    所以我们**不需要**在钩子里做复原，只需要"别让默认终止抢先"。
 * ⚠️ 万一被**强杀**（外部 terminate，钩子也来不及跑）→ 用 `--restore` 一键复原（见下）。
 */
const INT = { hit: false };
const onInt = (sig) => {
  if (INT.hit) process.exit(130);
  INT.hit = true;
  console.error(c.dim(`\n\n收到 ${sig} —— 等探针收尾，然后复原 obsidian.json`));
};
process.on('SIGINT', () => onInt('SIGINT'));
process.on('SIGTERM', () => onInt('SIGTERM'));

// ── `--restore`：一键复原（给"被强杀、finally 没走到"那种情况用）──────
if (argv.includes('--restore')) {
  if (!fs.existsSync(BAK)) {
    console.log(c.dim('没有待复原的备份 —— obsidian.json 是干净的（无需复原）'));
  } else {
    restoreConfig();
    console.log(c.ok('✓ 已从备份复原 obsidian.json'));
  }
  console.log(
    c.dim(
      '⚠️ 如果 Obsidian 还开着，它退出时会**回写** obsidian.json —— 复原前先完全退出它。\n' +
        '⚠️ 库里若还留着 __探针* 夹具，那是页面内收尾没走到，另行清理（见 坑/探针.md）。',
    ),
  );
  process.exit(0);
}

// ── 主流程 ──────────────────────────────────────────────────────
const sw = pointConfigAtSandbox();
if (!sw.ok) {
  console.error(c.bad('✗ 切库失败：' + sw.reason));
  process.exit(1);
}
console.log(c.dim('✓ 已把 Obsidian 的"上次打开的库"切到实验库（原 json 已备份）'));

let code = 1;
try {
  console.log(c.dim('… 起 Obsidian（--no-sandbox，park）'));
  const up = spawnSync(NODE, [path.join(ROOT, 'scripts', 'obsidian.mjs'), 'up'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // --no-sandbox：沙箱里 Chromium 的 GPU 进程起不来，裸起必崩（见文件头，必需）
      // 后两个：**万一还是崩了，别把 "Obsidian has stopped working / CrashSender.exe"
      //   对话框弹到用户屏幕上**（P7.20 诊断阶段踩过：故意试错误参数时崩了好几次，
      //   每个崩溃实例都在屏幕上留一个模态框，打扰用户）
      KBW_EXTRA_FLAGS: '--no-sandbox --disable-breakpad --disable-crash-reporter',
    },
  });
  if (up.status !== 0) {
    console.error(c.bad('✗ 起 Obsidian 失败 —— 探针跑不了'));
    code = up.status ?? 1;
  } else {
    /**
     * 🔴 **别把 `--smoke` 盖到 `--full` 上**（P7.20 实修）：原先写成
     *   `args = argv.includes('--full') ? [] : filter(...)` 之后**无条件** `if (!only) push('--smoke')`
     *   —— `--full` 先让 args 变空数组，紧接着又被补回 `--smoke`，于是"全量"实际跑的是**冒烟档**，
     *   而且日志里那行 `… 跑探针：--smoke` 混在一堆 dim 输出里，很容易一眼滑过去当全量。
     *   （本轮就这样白等了一轮 3.5 分钟的"全量基线"。）
     * 判据：**四档互斥** —— 无参→冒烟 / `--full`→全量 / `--only`→子集 / `--domain`→域档。
     * 🔴 **`--domain` 也必须列进来**（P7.20 实修）：第一版漏了它，于是 `--domain graph`
     *    被补上 `--smoke`，探针当场以"三档互斥"退出 —— 症状是"域档跑不起来"，
     *    谜底却在 wrapper 里。**加新的档位标志时，这行必须同步加**（同一个坑第二次了：
     *    上一次是 `--full` 被补 `--smoke`，这次是 `--domain`）。
     */
    const wantsFull = argv.includes('--full');
    const wantsOnly = argv.includes('--only');
    const wantsDomain = argv.includes('--domain');
    const args = argv.filter((a) => a !== '--keep' && a !== '--full');
    if (!wantsFull && !wantsOnly && !wantsDomain) args.push('--smoke');
    console.log(c.dim('… 跑探针：' + (args.join(' ') || '（全量）')));
    const pr = spawnSync(NODE, [path.join(ROOT, 'scripts', 'probe.mjs'), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    code = pr.status ?? 1;
  }
} finally {
  if (keep) {
    console.log(c.dim('（--keep：保留切过的 obsidian.json，不恢复）'));
  } else {
    restoreConfig();
    console.log(c.dim('✓ 已恢复 obsidian.json'));
  }
}
process.exit(code);
