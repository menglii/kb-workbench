// cdp-page.mjs —— **给 CDP 脚本挑页的唯一入口**（红线：只许接实验库那个页）
//
// 为什么单独一个文件：`reload` / `cdp-eval` / `probe` 都要"先连上 Obsidian 再干活"，
// 而**连错页就等于在真库里执行动作** —— P0 收尾的审查抓到过：
// `reload` 与 `cdp-eval` 原先"只管连第一个调试页"，没有任何库校验（文档却声称接上了）。
// 现在三个脚本共用这一份：**逐页问它开着哪个库，只有"是实验库且不是真库"的页才放行**。
//
// 判据本身在 `vault-guard.mjs`（`assertWritableSandbox`：正反双判），这里只负责挑页与报错。
import { assertWritableSandbox } from './vault-guard.mjs';

/**
 * 🔴 **真库通道**（2026-09-24 加；用户明确发话"在真库上执行"时才用）。
 *
 * 默认**关闭**，而且要**两个环境变量一起给**才放行（与 `deploy.mjs` 的双保险同一口径）：
 *   `KBW_ALLOW_REAL=1` + `KBW_REAL_TARGET=<真库路径片段>`
 *
 * ⚠️ 它只放行**挑页**这一个动作：探针里那些真正写库的步骤另有自己的守卫
 * （`probe.mjs` 的 `assertWritableSandbox` + `guard: true`），所以"跑探针"这条路
 * **仍然连不上真库**。这个通道只给"点插件自己的界面"这类一次性、可见的动作。
 */
export function realTargetAllowed(vault, env = process.env) {
  if (env.KBW_ALLOW_REAL !== '1') return null;
  const want = env.KBW_REAL_TARGET || '';
  if (!want) return null;
  if (!String(vault ?? '').includes(want)) return null;
  return { ok: true, reason: '' };
}

const DEFAULT_PORT = 9222;

export function cdpBase(port = Number(process.env.KBW_CDP_PORT ?? DEFAULT_PORT)) {
  return `http://127.0.0.1:${port}`;
}

/** 一次最小 CDP 求值（连上、问一句、断开）*/
async function ask(wsUrl, expression, timeoutMs = 8000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接超时')), timeoutMs);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      (e) => {
        clearTimeout(t);
        reject(new Error(`WebSocket 连不上：${e?.message ?? e}`));
      },
      { once: true },
    );
  });
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('求值超时')), timeoutMs);
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (msg.id !== 1) return;
        clearTimeout(t);
        const ex = msg.result?.exceptionDetails;
        resolve({ value: msg.result?.result?.value, error: ex ? (ex.text ?? '异常') : null });
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
        }),
      );
    });
  } finally {
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 库里这条路径怎么写：平台的字段名跨版本变过，两条都试 */
export const VAULT_PATH_EXPR =
  `(window.app?.vault?.adapter?.getBasePath?.() ?? window.app?.vault?.adapter?.basePath ?? '')`;

/**
 * 找到"开着实验库"的那个 CDP 页。
 * 找不到就抛错，并把**各页实际开着的库**列出来（别让人对着"连不上"猜）。
 */
export async function findSandboxPage({ port, what = '这个操作' } = {}) {
  const base = cdpBase(port);
  let pages;
  try {
    const res = await fetch(`${base}/json/list`);
    pages = (await res.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch (e) {
    throw new Error(
      `连不上调试端口（${base}）：${e?.message ?? e}\n` +
        '  Obsidian 是单实例应用 —— 先**完全退出**，再 `npm run probe:launch`',
    );
  }
  if (pages.length === 0) throw new Error(`调试端口通，但没有 page 目标（${base}）`);

  const seen = [];
  const asked = [];
  for (const p of pages) {
    let vault = '';
    try {
      const r = await ask(p.webSocketDebuggerUrl, VAULT_PATH_EXPR);
      vault = typeof r.value === 'string' ? r.value : '';
    } catch {
      vault = '(问不到)';
    }
    seen.push(`${vault || '(空)'}`);
    asked.push({ p, vault });
  }

  /**
   * ⚠️ 顺序要紧：**真库通道**（显式授权过）优先，否则"先碰到实验库就返回"会把
   * 真库那一页永远跳过（2026-09-24 实测踩过：两个库都开着时，通道给了也没生效）。
   */
  for (const { p, vault } of asked) {
    if (realTargetAllowed(vault) == null) continue;
    console.warn(
      `
🔴 走的是**真库通道**：${vault}
   （用户已发话；KBW_ALLOW_REAL=1 + KBW_REAL_TARGET=${process.env.KBW_REAL_TARGET}）
`,
    );
    return { page: p, vault, wsUrl: p.webSocketDebuggerUrl, real: true };
  }
  for (const { p, vault } of asked) {
    if (assertWritableSandbox(vault, what).ok) return { page: p, vault, wsUrl: p.webSocketDebuggerUrl };
  }
  throw new Error(
    `${pages.length} 个调试页里没有开着「实验库」的那个 —— ${what}一律不在真库上跑。\n` +
      `  实际开着：${seen.join(' ｜ ')}\n` +
      '  换库：在 Obsidian 里打开实验库（Desktop/sandbox-vault），或先跑 npm run probe:launch',
  );
}

/** 连上"实验库那个页"，返回一个够用的 CDP 句柄（只实现脚本真正要用的两件事）*/
export async function connectSandbox({ port, what = '这个操作', timeoutMs = 20000 } = {}) {
  const { page, vault } = await findSandboxPage({ port, what });
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      'error',
      (e) => {
        clearTimeout(t);
        reject(new Error(`WebSocket 连不上：${e?.message ?? e}`));
      },
      { once: true },
    );
  });

  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  });

  return {
    vault,
    page,
    on: (method, fn) => {
      const list = listeners.get(method) ?? [];
      list.push(fn);
      listeners.set(method, list);
    },
    send: (method, params = {}, t = 60000) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }, t);
        pending.set(id, {
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * **把窗口抬到前台并让它真的出帧**（真机检查的三件套，2026-09-25 实测补齐）。
 *
 * 为什么单拎出来（`probe.mjs` / `peek.mjs` 共用，口径只有一个）：
 *  ① 窗口**被最小化 / 被遮住**时 `document.visibilityState === 'hidden'`，
 *     此时 Chromium 给**所有元素 0 几何** —— 量宽高的判据会莫名其妙红、
 *     "有没有横向溢出"这类判据则**空过**（0 ≤ 0 恒真）。`Page.bringToFront` 之后立刻恢复
 *     （实测 hidden→visible、几何 0→256）。
 *  ② 窗口**可见但没有焦点**（被别的窗口压着）时几何是好的，但 Chromium **不给后台窗口产出新帧**
 *     → `Page.captureScreenshot` 可能给一张**陈旧的**画面（实测拿到过一张"收起态画成整宽横头"的图，
 *     而同一刻 DOM 明明是 40px 竖条）。`Emulation.setFocusEmulationEnabled` 是解药。
 *
 * ⚠️ 只影响渲染行为，**不改布局** —— 几何判据在开不开焦点模拟时都一样。
 * 返回 `{ visible, focused }`：`visible === false` 时**别信几何**，调用方自己决定是否中止。
 */
export async function bringToFront(cdp, { settleMs = 600, allowMinimized = false } = {}) {
  const read = async (expr, fallback) => {
    try {
      return await cdpEval(cdp, expr);
    } catch {
      return fallback;
    }
  };
  /**
   * ⚠️ **最小化的窗口，`Page.bringToFront` 叫不回来**（实测：刚 `probe:launch` 起来的窗口
   * 常常是隐藏态，bringToFront 之后 `visibilityState` 仍是 hidden → 所有几何还是 0）。
   * 得用 `Browser.setWindowBounds` 把窗口从 minimized 恢复成 normal ✓。
   * 这条命令在少数 Chromium/Electron 版本上不认 —— 失败就算了，让调用方按 visible 自己判断。
   *
   * `allowMinimized: true`（peek `--ghost` 用）= **别碰用户的窗口**：不恢复、也不 bringToFront，
   * 只如实回报状态，让调用方改走"模拟视口"那条路（见 peek.mjs 的 --ghost 注释）。
   */
  /**
   * ⚠️ **窗口的"最小化/还原"在页面连接上做不到**（实测：`Browser.getWindowForTarget` 在 page session
   * 上直接报 `wasn't found`，只有连**浏览器端点**（`/json/version` 那个 ws）才有 Browser 域）。
   * 所以这里只有 `Page.bringToFront`：它能把**可见但没焦点**的窗口抬到前台，
   * **最小化的窗口叫不回来** —— 那种情况下别硬来，走 peek 的 `--ghost`（模拟视口，压根不需要窗口可见）。
   */
  if (!allowMinimized) await cdp.send('Page.bringToFront').catch(() => {});
  await new Promise((r) => setTimeout(r, settleMs));
  const visible = (await read('document.visibilityState', 'visible')) === 'visible';
  const focused = (await read('document.hasFocus()', false)) === true;
  if (!focused) {
    await cdp
      .send('Emulation.setFocusEmulationEnabled', { enabled: true })
      .catch(() => {
        /* 老版本 Chromium 没有这条命令 */
      });
  }
  return { visible, focused };
}

/** 在页面里求值（`connectSandbox` 的返回值上没有 eval，这里补一个同一口径的） */
export async function cdpEval(cdp, expression, { timeoutMs = 20000 } = {}) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    timeoutMs,
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '页面里抛异常');
  }
  return r.result?.value;
}
