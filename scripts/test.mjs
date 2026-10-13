// 离线验收：jsdom + 桩 obsidian + **真实调用链**
//
// 为什么不直接跑 main.js：main.js 里 `require('obsidian')` 是宿主注入的。
// 这里用 esbuild 把 `tests/index.ts`（含 src/ 全部源码）打成一个 Node 包，
// 把 `obsidian` 这个 import **别名到 tests/stub**，于是：
//   · 插件源码一个字节没改，走的是真的 onload / registerView / setViewState / onOpen
//   · 文件系统是真的（临时副本），renameFile 撞名真的抛异常
//   · DOM 是 jsdom，但几何量不到 → 需要几何的地方用 defineProperty 覆盖（见下）
//
// 用法：npm test
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import { buildStyles } from './styles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', '.tmp', 'bundle.cjs');
const STUB = path.join(ROOT, 'tests', 'stub', 'index.ts');
/**
 * **成绩单落盘路径**（P7.19 #3 ①）：`tests/index.ts` 收尾往这里写失败名单 + 总数 + 耗时。
 * 由这里按**仓库根**定死（不靠 `process.cwd()`），`mutate-runner.mjs` 读同一个常量拼的路径。
 * ⚠️ 落盘本身在 `tests/index.ts`（**一处落盘**）；这里只是把路径告诉它。
 */
// ⚠️ **别无条件覆盖**（P7.20-1）：分片驱动会给每一片设一份自己的成绩单路径。
process.env.KBW_RESULTS_PATH ??= path.join(ROOT, 'tests', '.tmp', 'last-results.json');

const require = createRequire(import.meta.url);

/**
 * **未捕获日志归因**（P7.19 #4）：把"当前跑到哪一条用例"摘出来，附在 unhandled / jsdomError
 * 那两行日志后面 —— 一行级改动，把"有 Promise 没被 catch"从**噪音**变成**可归因**。
 *
 * 为什么需要：以前这两条日志只说"有个 Promise 没接住"，而它**必然**是某个用例触发的；
 * 全量跑时 570 条里挑一条，等于没有线索（P7.19 #1 那条虫正是这么被"嫌疑触发点"绕了好几轮的）。
 * `Suite.current` 是现成的（`-r` 卡住时报的就是它），这里只是复用它。
 * ⚠️ 早期（`run()` 还没建 Suite 时）没有归因对象 → 返回空串，不硬编个假的。
 */
function nowCase() {
  const s = globalThis.__kbwSuite;
  if (!s) return '';
  const c = String(s.current ?? '').replace(/(\s*›\s*)+$/, '').trim();
  return c ? `　【用例：${c}】` : '';
}

/**
 * ⚠️ **这条提示在本机已经反了**（P7.19 实测定性）。
 * 本机（Win11 + 宿主工具链 沙箱）恰恰**需要** `NODE_OPTIONS` 里挂那个 shim
 * （`C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs`）—— 否则同步子进程调用会死在 `EBUSY`
 * （`spawnSync`/`execFileSync`，pid=0）；`env -u NODE_OPTIONS` 反而把 shim 一起去掉。
 * 真正会让套件"**只打印一行 `经纬 · P0 离线验收` 就死**"的原因是**node 用错了**：
 * `npm test` 按 PATH 找 `node`，而 PATH 里排最前的是 宿主工具链 managed v22 ——
 * 它的 `fs.cpSync(recursive)` 被外部强杀（`0xC0000409`）。**要用 system node v24**（项目 `.nvmrc` = 24）。
 */
if (process.env.NODE_OPTIONS) {
  console.warn(
    `⚠ NODE_OPTIONS 非空（${process.env.NODE_OPTIONS}）—— 本机这是预期（沙箱 shim）；` +
      `跑不起来先查 node（要 system v24，不是 managed v22）`,
  );
}

// ── 1. 打包（顺带重建 styles.css —— 样式断言必须看最新产物）─────
/**
 * ── `--prepare` 与 `KBW_NO_BUILD`（P7.20-1 分片）──────────────────
 * 分片是**多个进程并行**，而 `bundle.cjs` 与 `styles.css` 都是**仓库里的同一个文件**：
 * 四个进程同时 esbuild 写同一个 outfile、同时 `buildStyles` 写 styles.css，
 * 轻则互相打断，重则**读到写了一半的 styles.css**（样式断言会随机变红 —— 最难查的那种红）。
 * 处置：
 *   · 驱动先跑一次 `--prepare`（只建 bundle + styles 然后退出）；
 *   · 各片带 `KBW_NO_BUILD=1` 起跑，**只读**那份产物。
 * ⚠️ 不分片（默认）时两条路都不走，行为与从前逐字一致。
 */
const PREPARE_ONLY = process.argv.includes('--prepare');
const NO_BUILD = process.env.KBW_NO_BUILD === '1';

async function buildBundle() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  buildStyles(ROOT);
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'tests', 'index.ts')],
    outfile: OUT,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    sourcemap: 'inline',
    logLevel: 'warning',
    external: ['jsdom'],
    plugins: [
      {
        name: 'stub-obsidian',
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({ path: STUB }));
        },
      },
    ],
  });
}

if (PREPARE_ONLY) {
  await buildBundle();
  console.log(`[prepare] bundle.cjs + styles.css 已就绪 → ${path.relative(ROOT, OUT)}`);
  process.exit(0);
}

if (NO_BUILD) {
  // 只读模式：产物必须**已经存在**。缺了就直接失败，别让 1200 条用例以"模块载入失败"的面目陪葬
  if (!fs.existsSync(OUT)) {
    console.error(
      `✗ KBW_NO_BUILD=1 但 ${path.relative(ROOT, OUT)} 不存在 —— 先跑 \`node scripts/test.mjs --prepare\``,
    );
    process.exit(1);
  }
} else {
  await buildBundle();
}

// ── 2. jsdom 全局 ─────────────────────────────────────────────
/**
 * ⚠️ 把 jsdom 的**内部错误**接出来（`virtualConsole` 默认把它打到控制的 console、且**不算失败**）：
 * 事件处理器里**同步 throw** 就走这条路 —— 真机症状是"按钮点了没反应"，
 * 而离线全套照样绿（独立审查的突变 r27 实测：给点击处理器加一个同步 throw，225/225 全绿）。
 * 这里把它归到 `unhandled`（与未捕获的 Promise 同一处置：打栈 + 整轮算失败）。
 */
const jsdomErrors = [];
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
  virtualConsole: new (require('jsdom').VirtualConsole)()
    .on('jsdomError', (e) => {
      jsdomErrors.push(e);
      console.error(`\n✗ jsdom 内部错误（多半是事件处理器里同步抛的）${nowCase()}：`);
      console.error(e && e.stack ? e.stack : e);
    })
    .on('error', () => {})
    .on('warn', () => {})
    .on('info', () => {})
    .on('log', () => {})
    .on('debug', () => {}),
});
const win = dom.window;

// 把 jsdom 的东西挂到 Node 全局上（已有的不覆盖，之后再强制覆盖关键项）
for (const key of Object.getOwnPropertyNames(win)) {
  if (key in globalThis) continue;
  const desc = Object.getOwnPropertyDescriptor(win, key);
  if (!desc) continue;
  try {
    Object.defineProperty(globalThis, key, { ...desc, configurable: true });
  } catch {
    /* 有些属性挂不上，忽略 */
  }
}
const FORCE = [
  'window', 'document', 'navigator', 'location', 'getComputedStyle', 'HTMLElement', 'Element',
  'Node', 'Text', 'DocumentFragment', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent',
  'HTMLDivElement', 'HTMLSpanElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'HTMLTableElement', 'SVGElement', 'DOMParser',
];
for (const key of FORCE) {
  try {
    Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
  } catch {
    /* 忽略 */
  }
}

// jsdom 没有 ResizeObserver —— 装一个"记录回调"的桩，测试里手动触发
const observers = [];
globalThis.__kbwResizeObservers = observers;
class ResizeObserverStub {
  constructor(cb) {
    this.cb = cb;
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;
win.ResizeObserver = ResizeObserverStub;

// jsdom 量不到布局：把几何相关的读法覆盖成普通值（**只影响测试**）
Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', {
  get() {
    return this.dataset?.w === 'zero' ? 0 : 200;
  },
  configurable: true,
});
Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', {
  get() {
    return this.dataset?.h === 'zero' ? 0 : 100;
  },
  configurable: true,
});
win.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON: () => ({}) };
};

// 把真样式表塞进去（样式相关的断言查样式源，不查 computed style）
const cssPath = path.join(ROOT, 'styles.css');
if (fs.existsSync(cssPath)) {
  const style = win.document.createElement('style');
  style.textContent = fs.readFileSync(cssPath, 'utf8');
  win.document.head.appendChild(style);
}

// ── 3. 跑 ─────────────────────────────────────────────────────
/**
 * ⚠️ **没被 catch 的 Promise** 会让 node 直接抛 `triggerUncaughtException` 并把整轮打断，
 * 而那条消息**不带栈**（只剩一句 DOMException/TypeError），排查时等于没有线索。
 * P3 实测踩到过（一个 `void (async () => …)()` 里抛的 DOM 错）。
 * 这里接住它、把栈打出来，并且**算作失败**（异步错误也是错误，不能悄悄过去）。
 */
const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
  console.error(`\n✗ 有 Promise 没被 catch${nowCase()}：`);
  console.error(reason && reason.stack ? reason.stack : reason);
});

// ── 3.5 看门狗：**按进展判卡住**，不是按总时长 ──────────────────
/**
 * 🔴 这里曾经是**一条 90 秒的总时长超时**，而它就是 P4.5 a.5 之后那批
 * 「全量 `npm test` 偶发超时、挂点在各用例间游走、分片单独跑全绿」的**根因**：
 * 全量套件本身就要 **~94s**（2026-09-25 实测 291/291 · 94.0s），于是
 * **正常跑完也会被它杀掉**；而"卡在哪一条"只取决于那一刻刚好跑到谁 → 看起来像随机挂某条用例。
 * 分片各跑都在 90s 以内，所以分片全绿 —— 同一个数字解释全部症状。
 *
 * 现在拆成两条，各自管一件事：
 *   · `STALL_MS`  —— **没有任何进展**才算卡住（在动就说明活着，跑多久都由它去）；
 *   · `CEILING_MS`—— 天花板只防"永远跑不完"，给到足够宽（默认 15 分钟）。
 * 判据从"跑得慢不慢"回到它本该是的意思："是不是真的不动了"。
 *
 * 🔴🔴 **P7.19 又一刀（2026-10-10 实测）：「进展」的口径不能是 `results.length`。**
 * 二代看门狗盯的是「**完成了多少条用例**」，这在**窄过滤**下是错的：
 * `KBW_TEST_ONLY='搬到'` 只选中十条，其余全部 skip（**不产结果**），但"把二十来个库
 * boot 起来"照样得跑完。实测：一个**永不命中**的过滤词，骨架 **87.1s**、`results.length`
 * 全程 0 → 看门狗在 60s 处报 `✗ 没有新结果已 Ns —— 卡在：<某条用例>` → 整轮按红退出。
 * 而 `suite.current` 那一刻恰好是某条**正在跑**的用例 → 于是看起来像"某条用例挂了"，
 * 卡点还随机器负载游走（骨架时长漂、60s 阈值骑在上面）—— 这就是那个"**间歇**卡住"的真身。
 *
 * 现在口径 = **进度心跳**（`tests/heartbeat.ts`：进一条用例含被 skip 的 / 进分组 / 造夹具 /
 * boot 库都敲一下）。真正的"卡住"（某条用例里 await 永不 resolve）会让心跳**彻底停住**，
 * 那才是它该抓的形态；"在 boot 库"则心跳不断，不管有多少用例被跳过。
 */
const STALL_MS = Number(process.env.KBW_TEST_STALL ?? 60000);
const CEILING_MS = Number(process.env.KBW_TEST_TIMEOUT ?? 900000);

/** 看门狗口径：心跳是主项，`results.length` 只在"心跳还没接上"（早期/旧快照）时兜底 */
function progressTick() {
  const s = globalThis.__kbwSuite;
  return (s?.ticks ?? 0) + (s?.results.length ?? 0);
}

/** 卡住/超时都走这里：把"跑到哪一条"打出来，别让人对着空输出猜 */
function bail(why) {
  const suite = globalThis.__kbwSuite;
  console.error(`\n✗ ${why} —— 卡在：${suite ? suite.current : '（还没开始）'}`);
  if (suite) {
    console.error(`  已通过 ${suite.passed} / ${suite.results.length}（进度心跳 ${suite.ticks}）`);
    for (const r of suite.failed) console.error(`  ✗ ${r.name}\n      ${(r.error ?? '').replace(/\n/g, '\n      ')}`);
  }
  process.exit(1);
}

let seen = -1;
let seenAt = Date.now();
const stall = setInterval(() => {
  const n = progressTick();
  if (n !== seen) {
    seen = n;
    seenAt = Date.now();
    return;
  }
  if (Date.now() - seenAt >= STALL_MS) {
    bail(`没有任何进展已 ${Math.round((Date.now() - seenAt) / 1000)}s（真的卡住了，不是跑得慢）`);
  }
}, 1000);
const ceiling = setTimeout(() => bail(`总时长超过天花板（${CEILING_MS}ms）`), CEILING_MS);
// ⚠️ 两个都不能 unref：unref 掉的定时器在事件循环空转时（"await 一个永不 resolve 的 Promise"
// 正是这种形态）不会触发，子进程会以退出码 0 静默退出、输出被截断 —— 看起来像"通过"
// （独立审查指出）。这里反过来：先假定失败，成功后再置 0。

let code = 1;
try {
  const mod = require(OUT);
  code = await mod.run(); // 0=全过 / 1=有失败 / 2=只跑了子集
  await new Promise((r) => setTimeout(r, 50)); // 让挂起的未捕获拒绝有机会报出来
  if (unhandled.length > 0 || jsdomErrors.length > 0) code = 1;
} catch (e) {
  console.error('\n测试跑挂了：\n', e);
  code = 1;
} finally {
  clearInterval(stall);
  clearTimeout(ceiling);
  try {
    win.close();
  } catch {
    /* 忽略 */
  }
  process.exitCode = code;
  const forced = setTimeout(() => process.exit(code), 200);
  forced.unref?.();
}
