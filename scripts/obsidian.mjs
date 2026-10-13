/**
 * scripts/obsidian.mjs —— **Obsidian 控制台**（P7.2d 工具化，2026-10-04）
 *
 * 把「agent 自主起停 Obsidian」与「隐身态照样能读面板 / 排查 bug」收成一个口：
 *
 * ```
 * npm run obsidian -- up [--park|--show|--min|--max|--keep]   # 带调试端口 + 反节流开关启动（默认 park）
 * npm run obsidian -- down [--force]                          # 优雅退出（CloseMainWindow；--force 才强杀）
 * npm run obsidian -- park                                    # 移出屏幕外 —— 隐形但**全功能**（推荐常驻档）
 * npm run obsidian -- show                                    # 移回屏幕（回 park 前记下的位置）
 * npm run obsidian -- min | max | restore                     # 真·最小化 / 最大化 / 还原
 * npm run obsidian -- status [--probe]                        # 全套状态 + 活性探针（rAF/计时器/截图）
 * ```
 *
 * ── 为什么要有它（P7.2c 一轮"环境红"换来的三条硬事实，全部真机实测）──
 *   ① **真·最小化 = 合成器停帧**：CDP 截图必超时、rAF 归零 —— 探针全量在最小化态跑会红一片；
 *   ② **被别的窗口盖住**（没带开关时）→ rAF 0、计时器被节流 ~2×，但截图勉强能出；
 *   ③ **`--disable-background-timer-throttling` + `--disable-renderer-backgrounding` +
 *      `--disable-backgrounding-occluded-windows` 三件套 + **移出屏幕外（park）**：
 *      `visibilityState` 仍是 visible，rAF/计时器/截图**全部正常**（实测 rAF 219/s、截图 30ms）。
 *   ⇒ 想"别打扰我但要干活"：**park，不要 min**。`up` 默认就帮你 park。
 *   ⚠️ 三个开关只有在 `up` 时带上才有用（单实例应用：已经带参数跑着再启动一次参数会被忽略）。
 *
 * ⚠️ 非 Windows：窗口半边（park/show/min/max/status 的窗口字段）全部降级为"说清楚不支持"，
 *    `down` 仍尽力而为（走 cdp `app.quit()` 不保证）……本仓库只在 Windows 上用这套（见 17.4）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getObsidianWindow,
  moveObsidian,
  resizeObsidian,
  restoreObsidian,
  showWindow,
  windowStateName,
  closeObsidian,
  SW_MAXIMIZE,
  SW_MINIMIZE,
  SW_RESTORE,
} from './win-window.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.KBW_CDP_PORT ?? 9222);
const PARK_POS = { x: -32000, y: -32000 };
/**
 * **park 态也要垫到"截图基准"尺寸**（P7.2d 复审 R1，跨工具互踩的修法②）：
 * 探针的"截图前把窗口弄够大"按**尺寸**判断（内宽 < 1400 → maximize）——
 * 而 parked 窗口若偏小，`SW_MAXIMIZE` 会把它**拽回最近的显示器**、破坏隐形档。
 * 把外框垫到 1440×980（内宽余量 ≥1400）后，那条路自然短路。
 * `show` 会按存档把用户原本的尺寸还回去。
 */
const SHOT_W = 1440;
const SHOT_H = 980;
/** park 前的位置记在这里（show 还原用；`tests/.tmp/` 是开发期临时区） */
const STATE_FILE = path.join(ROOT, 'tests', '.tmp', 'obsidian-window.json');

/**
 * **反节流三件套**（P7.2d 实测，见文件头三条硬事实）。
 * ⚠️ 代价：Chromium 不再回收后台渲染内存、任何窗口层级的节流都关着 —— 开发机可接受；
 * 这不是"生产推荐配置"，是**开发工具**的启动参数。
 */
export const LAUNCH_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

/**
 * **额外 Chromium flag**（P7.20 实测，本机沙箱专用）——
 * 宿主工具链 沙箱里 Chromium 的 GPU 进程初始化直接 FATAL：
 *   `[pid:FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:416]
 *    GPU process isn't usable. Goodbye.` → **主进程一起带走，exit=3**。
 * 症状极具误导性：`up` 只报"40 秒了调试端口还没起来"，而 `status` 说"没在跑"，
 * 看着像"没有交互式桌面"（P7.19 就是这么误判成 D7 欠账的）。
 * 真相：**桌面是有的**（同上下文起 notepad 能活），是 GPU 进程的问题。
 *
 * 实测：加 `--disable-gpu` 后主进程存活、`DevTools listening on ws://127.0.0.1:9222` 就绪。
 *
 * ⚠️ 用环境变量控制、**默认不加**：用户日常桌面不需要它，加了反而降级成软件渲染。
 *    在沙箱里跑探针时：`KBW_EXTRA_FLAGS="--disable-gpu" npm run obsidian -- up`
 */
function extraLaunchFlags() {
  const raw = process.env.KBW_EXTRA_FLAGS ?? '';
  return raw.split(/\s+/).filter(Boolean);
}

/** 找 obsidian.exe：环境变量优先，否则在常见安装根目录下按特征文件找（原 probe-launch 的搜索） */
export function findObsidianExe() {
  if (process.env.KBW_OBSIDIAN_EXE && fs.existsSync(process.env.KBW_OBSIDIAN_EXE)) {
    return process.env.KBW_OBSIDIAN_EXE;
  }
  const roots = [
    'C:\\Program Files\\Obsidian',
    'C:\\Users\\<你的用户名>\\AppData\\Local\\Obsidian',
    'C:\\Program Files\\Obsidian',
    'C:\\Program Files (x86)\\Obsidian',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    let seen = 0;
    while (stack.length > 0 && seen < 4000) {
      seen += 1;
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (/node_modules|\.git/.test(e.name)) continue;
          stack.push(p);
        } else if (/^obsidian\.exe$/i.test(e.name)) {
          return p;
        }
      }
    }
  }
  return null;
}

// ── 小工具 ──────────────────────────────────────────────────────
const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function listPages() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2500) });
    return await res.json();
  } catch {
    return [];
  }
}

function saveRect(rect) {
  try {
    // ⚠️ 只存"看上去正常"的几何（复审 Y4：最小化窗 rect 是 -32000 垃圾值，别写进存档）
    if (!rect || rect.left < -10000 || rect.right <= rect.left || rect.bottom <= rect.top) return;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ rect, at: Date.now() }), 'utf8');
  } catch {
    /* 记不上只影响 show 的还原位置 */
  }
}

function loadRect() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const r = raw?.rect;
    if (r && [r.left, r.top, r.right, r.bottom].every((n) => Number.isFinite(n))) {
      // ⚠️ 存档本身可能是"屏幕外"的垃圾值（早期版本把自己 park 的坐标记了进去）——不收
      if (r.left < -10000 || r.right <= r.left) return null;
      return r;
    }
  } catch {
    /* 没有/坏了就回默认 */
  }
  return null;
}

// ── 子命令 ──────────────────────────────────────────────────────
async function cmdUp(args) {
  const mode = args.includes('--show')
    ? 'show'
    : args.includes('--min')
      ? 'min'
      : args.includes('--max')
        ? 'max'
        : args.includes('--keep')
          ? 'keep'
          : 'park'; // 默认：不打扰 + 全功能
  if (await portAlive()) {
    console.log(c.ok(`✓ 调试端口 ${PORT} 已经在响应 —— Obsidian 已经带参数跑着`));
    const w0 = await getObsidianWindow();
    // 显式模式对"已经在跑"的实例也生效（复审 Y7）：--show 把屏幕外的搬回来；
    // 只有**显式** --park 才动手 park（默认不带时不去动一个正在用的可见窗口）
    if (args.includes('--show') && w0?.offscreen) return await cmdShow();
    if (args.includes('--park') && w0 && !w0.offscreen && !w0.iconic) return await cmdPark();
    console.log(c.dim('  接下去直接 npm run probe / npm run status 即可；要把它藏起来：npm run obsidian -- park'));
    return 0;
  }
  const win = await getObsidianWindow();
  if (win) {
    console.error(c.bad('\n✗ Obsidian 正在运行，但调试端口没开。'));
    console.error(`
  单实例应用：必须**先完全退出**再带参数启动，否则参数会被忽略（反节流开关也就丢了）。

    1. npm run obsidian -- down      （或 File → Exit）
    2. npm run obsidian -- up
`);
    return 1;
  }
  const exe = findObsidianExe();
  if (!exe) {
    console.error(c.bad('✗ 找不到 obsidian.exe —— 用 KBW_OBSIDIAN_EXE 环境变量直接指路径'));
    return 1;
  }
  console.log(`Obsidian：${c.dim(exe)}`);
  const extra = extraLaunchFlags();
  console.log(`启动中（端口 ${PORT} + 反节流三件套${extra.length ? ` + 额外 ${extra.join(' ')}` : ''}）…`);
  spawn(exe, [`--remote-debugging-port=${PORT}`, ...LAUNCH_FLAGS, ...extra], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  const t0 = Date.now();
  for (;;) {
    await sleep(1000);
    if (await portAlive()) break;
    if (Date.now() - t0 > 40000) {
      console.error(c.bad('✗ 40 秒了调试端口还没起来 —— 看看 Obsidian 是不是弹了什么对话框'));
      return 1;
    }
  }
  console.log(c.ok(`✓ 调试端口就绪（${Math.round((Date.now() - t0) / 1000)}s）`));
  /** 等窗口出来（复审 G6：一次性读太脆——重试几拍） */
  let w = null;
  for (let i = 0; i < 6 && !w; i += 1) {
    await sleep(700);
    w = await getObsidianWindow();
  }
  if (!w) {
    console.error(c.bad('✗ 端口起来了但没找到主窗口'));
    return 1;
  }
  if (mode === 'park') {
    if (w.iconic) {
      await restoreObsidian();
      await sleep(400);
    }
    // ⚠️ 只有"本来在屏幕内"的坐标才值得存（saveRect 里还有一层 sanity guard）
    if (!w.offscreen) saveRect(w.rect);
    await moveObsidian(PARK_POS.x, PARK_POS.y);
    await resizeObsidian(SHOT_W, SHOT_H); // 垫到截图基准（见 SHOT_W 注释）
    console.log(c.ok('✓ 已 park（移出屏幕外）—— 隐形，但截图/rAF/计时器全功能'));
    console.log(c.dim('  要看见它：npm run obsidian -- show'));
  } else if (mode === 'show') {
    console.log(c.ok('✓ 已启动（窗口按它自己记住的位置显示）'));
  } else if (mode === 'max') {
    await showWindow(SW_MAXIMIZE);
    console.log(c.ok('✓ 已启动并最大化'));
  } else if (mode === 'min') {
    console.log(
      c.bad('⚠ 真·最小化 = 合成器停帧：CDP 截图会超时、rAF 归零 —— 排查用 park，别用 min'),
    );
    await showWindow(SW_MINIMIZE);
  }
  return 0;
}

async function cmdDown(args) {
  /**
   * 🔴 **关之前把位置还回屏幕**：Obsidian 会把窗口几何记进工作区 —— 停在 park 位时直接关，
   * 用户下次**手点** Obsidian 会"像打不开"（其实开在 -32000 屏幕外）。先还原再关。
   */
  const w0 = await getObsidianWindow();
  if (w0?.offscreen) {
    const rect = loadRect() ?? { left: 60, top: 60, right: 60 + 1200, bottom: 60 + 800 };
    await moveObsidian(rect.left, rect.top);
    await sleep(300);
  }
  const res = await closeObsidian();
  if (res === 'closed') {
    console.log(c.ok('✓ Obsidian 已优雅退出（平台自己存过工作区）'));
    return 0;
  }
  if (res === 'no-window') {
    console.log('（本来就没在跑）');
    return 0;
  }
  if (res === 'unknown') {
    console.error(c.bad('✗ 查不到进程状态（PowerShell 没起来？）—— 去任务管理器看一眼，别默认它关了'));
    return 1;
  }
  if (args.includes('--force')) {
    console.log(c.dim('优雅关闭没等到，--force：taskkill…'));
    try {
      // ⚠️ **同步 + 校验**（复审 Y1）：原来 detached spawn 不检查就报"已强杀"是假成功路径
      execFileSync('taskkill', ['/IM', 'Obsidian.exe', '/F'], { stdio: 'ignore' });
    } catch {
      /* taskkill 非零退出 = 没杀掉（也许其实已经没了）——下面复查 */
    }
    await sleep(1200);
    const left = await winAliveCount();
    if (left === 0) {
      console.log(c.ok('✓ 已强杀（下次启动可能丢工作区状态）'));
      return 0;
    }
    console.error(c.bad(`✗ 强杀之后还有 ${left === null ? '（查不到）' : left} 个 Obsidian 进程 —— 手动看一眼`));
    return 1;
  }
  console.error(c.bad('✗ 发了关闭请求但进程还在（可能有"要保存吗"之类的对话框）—— 看一眼，或 --force 强杀'));
  return 1;
}

/** 数 Obsidian 进程（`null` = 查不到） */
function winAliveCount() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-Process Obsidian -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { encoding: 'utf8' },
    );
    return Number(out.trim());
  } catch {
    return null;
  }
}

async function cmdPark() {
  let w = await getObsidianWindow();
  if (!w) {
    console.error(c.bad('✗ 没找到 Obsidian 窗口（先 up）'));
    return 1;
  }
  /** ⚠️ 最小化窗的 rect 也是 -32000（复审 Y4）——先还原再 park，否则判据会误报"已 park" */
  if (w.iconic) {
    await restoreObsidian();
    await sleep(400);
    w = await getObsidianWindow();
    if (!w) {
      console.error(c.bad('✗ 还原最小化之后找不到窗口了'));
      return 1;
    }
  }
  if (!w.offscreen) saveRect(w.rect);
  await moveObsidian(PARK_POS.x, PARK_POS.y);
  await resizeObsidian(SHOT_W, SHOT_H); // 垫到截图基准（见 SHOT_W 注释）
  await sleep(400);
  const after = await getObsidianWindow();
  const okParked = after?.offscreen === true && after?.iconic !== true;
  console.log(
    okParked
      ? c.ok('✓ 已 park（屏外；尺寸已垫到截图基准；show 可还回原位与原尺寸）')
      : c.bad(`✗ 移位没生效（iconic=${after?.iconic}，offscreen=${after?.offscreen}）`),
  );
  return okParked ? 0 : 1;
}

async function cmdShow() {
  const rect = loadRect() ?? { left: 60, top: 60, right: 60 + 1200, bottom: 60 + 800 };
  await restoreObsidian(); // 万一是最小化态，先还原
  await sleep(300);
  await moveObsidian(rect.left, rect.top);
  // 把 park 时垫大的尺寸还回原样（复审 R1 的配套：存档里存的是全 rect）
  await resizeObsidian(rect.right - rect.left, rect.bottom - rect.top);
  await sleep(400);
  const w = await getObsidianWindow();
  if (w && !w.offscreen && !w.iconic) {
    console.log(c.ok(`✓ 已移回屏幕（${windowStateName(w)}，位置 ${rect.left},${rect.top}）`));
    return 0;
  }
  console.error(c.bad(`✗ 没搬回屏幕（${windowStateName(w)}，rect=${w ? `${w.rect.left},${w.rect.top}` : '无'}）`));
  return 1;
}

async function cmdWindow(kind) {
  const map = { min: SW_MINIMIZE, max: SW_MAXIMIZE, restore: SW_RESTORE };
  const res = await showWindow(map[kind]);
  if (res === 'no-window') {
    console.error(c.bad('✗ 没找到 Obsidian 窗口（先 up）'));
    return 1;
  }
  if (res === '') {
    console.error(c.bad('✗ 窗口操作没成功（PowerShell 起不来或窗口没了）'));
    return 1;
  }
  if (kind === 'min') {
    console.log(c.dim('（提示：最小化态截图会死 —— 排查工作请用 park）'));
  }
  console.log(c.ok(`✓ ${res}`));
  return 0;
}

async function cmdStatus(args) {
  const win = await getObsidianWindow();
  const alive = await portAlive();
  console.log(c.bold('Obsidian 控制台 · 状态'));
  console.log(`  进程/窗口： ${win ? `pid=${win.pid} · ${windowStateName(win)} · rect=${win.rect.left},${win.rect.top},${win.rect.right},${win.rect.bottom}` : c.dim('没在跑')}`);
  console.log(`  调试端口： ${alive ? c.ok(`:${PORT} ✔`) : c.dim(`:${PORT} ✗`)}`);
  if (alive) {
    const pages = await listPages();
    console.log(`  页面：     ${pages.length} 个（${pages.slice(0, 3).map((p) => String(p.title || p.url).slice(0, 40)).join(' / ')}）`);
  }
  if (!alive || !args.includes('--probe')) {
    if (win?.iconic) console.log(c.bad('  ⚠ 真·最小化态：截图/滚动类操作会失败 —— 用 park 代替（npm run obsidian -- park）'));
    return 0;
  }
  // 活性探针：rAF + 计时器 + 截图冒烟（走 cdp-page 的实验库断言，连不上就如实说）
  let cdp = null;
  try {
    const { connectSandbox } = await import('./cdp-page.mjs');
    cdp = await connectSandbox({ what: 'status --probe' });
  } catch (e) {
    console.log(c.dim(`  活性探针：连不上实验库（${String(e.message).slice(0, 60)}）—— 跳过`));
    return 0;
  }
  try {
    const r = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          const raf = await new Promise((res) => { let n = 0; const t0 = performance.now();
            const step = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(step); else res(n); };
            requestAnimationFrame(step); setTimeout(() => res(n), 1600); });
          const t0 = Date.now(); await new Promise((r) => setTimeout(r, 1000));
          return JSON.stringify({ raf, drift: Date.now() - t0, vis: document.visibilityState });
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      20000,
    );
    const m = JSON.parse(r.result.value);
    let shot = '';
    try {
      const t0 = Date.now();
      const buf = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15000);
      shot = Math.round((buf?.data?.length ?? 0) / 1024) + 'KB/' + (Date.now() - t0) + 'ms';
    } catch (e) {
      shot = '超时（合成器停帧）';
    }
    const rafOk = Number(m.raf) > 0;
    const shotOk = !shot.includes('超时');
    console.log(
      `  活性探针： rAF/s=${m.raf} · 计时器漂移=${m.drift}ms · vis=${m.vis} · 截图=${shot}`,
    );
    console.log(
      rafOk && shotOk
        ? c.ok('  ✓ 全功能：截图 / rAF / 计时器都活着 —— 探针可以跑')
        : c.bad(`  ⚠ 能力受限（rAF=${rafOk}，截图=${shotOk}）—— ${win?.iconic ? '最小化态，' : ''}用 park 试试`),
    );
  } catch (e) {
    console.log(c.dim(`  活性探针：求值失败（${String(e.message).slice(0, 60)}）`));
  } finally {
    try {
      cdp.close();
    } catch {
      /* 关不掉就算了 */
    }
  }
  return 0;
}

// ── CLI 入口（被 import 时不跑）────────────────────────────────
async function main() {
  const [, , cmd = 'status', ...args] = process.argv;
  if (!Number.isFinite(PORT)) {
    console.error(c.bad(`✗ KBW_CDP_PORT 不是数字（${process.env.KBW_CDP_PORT}）`));
    return 1;
  }
  const table = {
    up: () => cmdUp(args),
    down: () => cmdDown(args),
    park: cmdPark,
    show: cmdShow,
    min: () => cmdWindow('min'),
    max: () => cmdWindow('max'),
    restore: () => cmdWindow('restore'),
    status: () => cmdStatus(args),
  };
  if (!table[cmd]) {
    console.error('用法：node scripts/obsidian.mjs <up|down|park|show|min|max|restore|status> [--park|--show|--min|--max|--keep] [--probe] [--force]');
    return 1;
  }
  return await table[cmd]();
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
