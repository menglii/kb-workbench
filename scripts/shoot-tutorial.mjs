// 拍教程配图（P7.10 · #8 的两篇进阶图文：《找笔记》《批量操作》）
//
// 连 CDP → 钉 1400×900 视口 → 把**演示库**里的界面开到位 → 逐张截图（无圈注：教程配图走
// 干净界面，读者对着自己的库能对上号）。产出两处：
//   · `素材/教程配图-P7.10/`（**原图**全幅，归档）
//   · `assets/tutorial/*.png`（**成品**裁好的横带 —— 随插件发布、帮助栏 <img> 直接吃）
//
// 命令行（按顺序走，与 shoot-wizard.mjs 同一套）：
//   1) node scripts/make-demo-vault.mjs --force          ← 生成演示库（全假内容）
//   2) node scripts/shoot-tutorial.mjs --register        ← 把演示库登记成"打开的库"（Obsidian 必须完全退出）
//   3) KBW_LAUNCH_MIN=0 npm run probe:launch             ← 带调试端口启动（最大化；截图要可见窗口）
//   4) KBW_VAULT_SANDBOX="<演示库>" node scripts/shoot-tutorial.mjs   ← 拍
//   5) （退出 Obsidian 后）node scripts/shoot-tutorial.mjs --restore  ← 还原 obsidian.json
//
// 判据（脚本自己盯的）：
//   · **只连演示库**：走 `cdp-page.mjs` 的沙盒守卫（KBW_VAULT_SANDBOX 必须指向演示库，否则拒跑）；
//   · 窗口不可见 → 直接失败（截图会超时/拿到陈旧帧 —— 见 坑/探针.md 的「探针专坑 ④」）；
//   · 每张图拍完立刻**回读文件存在且非空**（静默写失败是这个项目反复踩的坑）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectSandbox, bringToFront } from './cdp-page.mjs';
import { sandboxVault } from './vault-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.resolve(process.env.KBW_DEMO_VAULT || 'C:/Users/<你的用户名>/OneDrive/Desktop/插件演示库');
const OBS_JSON = path.join(os.homedir(), 'AppData', 'Roaming', 'obsidian', 'obsidian.json');
const OBS_BAK = `${OBS_JSON}.kbw-shoot-bak`;
const OUT_ARCHIVE = path.join(ROOT, '素材', '教程配图-P7.10');
const OUT_ASSETS = path.join(ROOT, 'assets', 'tutorial');

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};
const fail = (m) => {
  console.error(`\n${c.bad('✗')} ${m}\n`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function obsidianRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe'], { encoding: 'utf8' });
    return /Obsidian\.exe/i.test(out);
  } catch {
    return false;
  }
}

// ── 模式一：登记 / 还原 obsidian.json（与 shoot-wizard 同一份逻辑）──────
function register() {
  if (obsidianRunning()) fail('Obsidian 还在运行 —— 它退出时会回写 obsidian.json，先完全退出（File → Exit）');
  if (!fs.existsSync(OBS_JSON)) fail(`找不到 ${OBS_JSON}`);
  const raw = JSON.parse(fs.readFileSync(OBS_JSON, 'utf8'));
  fs.copyFileSync(OBS_JSON, OBS_BAK);
  let hitId = null;
  for (const [id, v] of Object.entries(raw.vaults ?? {})) {
    if (String(v.path).toLowerCase() === DEMO.toLowerCase()) hitId = id;
  }
  if (!hitId) {
    hitId = Math.random().toString(16).slice(2, 18);
    raw.vaults[hitId] = { path: DEMO, ts: Date.now(), open: true };
  }
  for (const [id, v] of Object.entries(raw.vaults ?? {})) v.open = id === hitId;
  fs.writeFileSync(OBS_JSON, JSON.stringify(raw));
  console.log(`${c.ok('✓')} 已把演示库登记为"打开的库"：${DEMO}`);
  console.log(`  （obsidian.json 备份在 ${OBS_BAK}；拍完 --restore 还原）`);
  console.log(`\n  下一步：${c.dim('KBW_LAUNCH_MIN=0 npm run probe:launch')} 然后 ${c.dim('KBW_VAULT_SANDBOX="' + DEMO + '" node scripts/shoot-tutorial.mjs')}`);
}

function restore() {
  if (obsidianRunning()) fail('Obsidian 还在运行 —— 先完全退出再还原 obsidian.json（否则会被它回写覆盖）');
  if (!fs.existsSync(OBS_BAK)) fail(`没有备份 ${OBS_BAK} —— 是不是没走过 --register？`);
  fs.copyFileSync(OBS_BAK, OBS_JSON);
  fs.rmSync(OBS_BAK);
  console.log(`${c.ok('✓')} obsidian.json 已还原（下次启动回原来的库）`);
}

async function main() {
  if (argsHas('--register')) return register();
  if (argsHas('--restore')) return restore();

  // ── 守卫：必须指着演示库跑（cdp-page 的沙盒判据也认这个 env）────────
  const sb = sandboxVault();
  if (path.resolve(sb).toLowerCase() !== DEMO.toLowerCase()) {
    fail(
      `KBW_VAULT_SANDBOX 必须指向演示库（当前 ${sb} / 期望 ${DEMO}）——\n` +
        `  即：KBW_VAULT_SANDBOX="${DEMO}" node scripts/shoot-tutorial.mjs\n` +
        `  （这一条同时是"只连演示库"的守卫；真库与实验库都不该被这个脚本连上）`,
    );
  }
  if (!fs.existsSync(DEMO)) fail(`演示库不存在：${DEMO} —— 先跑 node scripts/make-demo-vault.mjs --force`);

  const cdp = await connectSandbox({ what: '拍教程配图' });
  try {
    const { visible } = await bringToFront(cdp, { allowMinimized: false });
    if (!visible) {
      fail('窗口不可见（最小化/被遮住）—— 截图会超时或拿到陈旧帧。用 KBW_LAUNCH_MIN=0 npm run probe:launch 重启');
    }
    /**
     * ⚠️ **视口比向导那套窄一档**（920×760，不是 1400×900）：教程图是放大在帮助栏
     * 卡片里读的（内容宽 ~550px）——1400 宽的图缩到 0.4x 字就糊了；920 缩 ~0.6x，
     * 列表与面板里的小字都还读得出（首版 1400 实拍目检后改的）。
     */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 920,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.enable').catch(() => {});

    const evalJs = async (expression, timeoutMs = 30000) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        timeoutMs,
      );
      if (r.exceptionDetails) {
        throw new Error(`页面里异常：${r.exceptionDetails.text ?? ''} ${r.exceptionDetails.exception?.description ?? ''}`);
      }
      return r.result?.value;
    };
    const capture = async (file, clip) => {
      await evalJs(
        `(() => { document.querySelectorAll('.notice-container').forEach((n) => n.remove()); return true; })()`,
      ).catch(() => {});
      const params = { format: 'png' };
      if (clip) params.clip = { ...clip, scale: 1 };
      const r = await cdp.send('Page.captureScreenshot', params, 30000);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      const size = fs.statSync(file).size;
      if (size <= 0) fail(`截图写出来是空的：${file}`);
      console.log(`  · ${path.relative(ROOT, file)} ${(size / 1024).toFixed(0)} KB`);
      return size;
    };

    /** 把工作台开出来并落到「全部笔记」（**轮询到真切过去** —— 别赌导航画出来的毫秒数） */
    const ensureNotes = async () => {
      await evalJs(`(async () => {
        const app = window.app;
        const leaves = app.workspace.getLeavesOfType('kb-workbench-view');
        if (leaves.length === 0) {
          const leaf = app.workspace.getLeaf('tab');
          await leaf.setViewState({ type: 'kb-workbench-view', active: true });
        } else {
          app.workspace.setActiveLeaf(leaves[0], { focus: true });
        }
        return true;
      })()`);
      await sleep(1200);
      /**
       * ⚠️ 第一版是"找得到就点、找不到就算了"——视图刚挂时导航还没画出来，
       * 于是**静默什么都没发生**，后面 ① 整步以"树里没有 02_Areas"的形态红。
       * 现在轮询：点一次等一拍，直到 is-on 真的落在「全部笔记」；超时就报错。
       */
      const switched = await evalJs(`(async () => {
        for (let i = 0; i < 20; i += 1) {
          const on = document.querySelector('.kbw-navitem.is-on');
          if (on && on.textContent.includes('全部笔记')) return true;
          const n = [...document.querySelectorAll('.kbw-navitem')].find((x) => x.textContent.includes('全部笔记'));
          if (n) n.click();
          await new Promise((r) => setTimeout(r, 300));
        }
        return false;
      })()`);
      if (!switched) fail('点不动「全部笔记」导航（工作台一直没就绪）');
      await sleep(900);
    };

    /** 记下「笔记主区」的裁切框（工具栏 + 列表；上限 920×620 —— 帮助栏里放大读得住小字） */
    const mainClip = async () => {
      return await evalJs(`(() => {
        const el = document.querySelector('.kbw-notes-main');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(Math.min(r.width, 920)), height: Math.round(Math.min(r.height, 620)) };
      })()`);
    };

    fs.mkdirSync(OUT_ARCHIVE, { recursive: true });
    fs.mkdirSync(OUT_ASSETS, { recursive: true });
    console.log(`连上了：${cdp.vault}`);

    await ensureNotes();

    // ── 进入「02_Areas」（找笔记 / 筛选两张都在这一层拍）──────────────
    console.log('① 进 02_Areas…');
    const entered = await evalJs(`(async () => {
      const item = [...document.querySelectorAll('.kbw-tree-item')].find((i) => {
        const n = i.querySelector('.kbw-tree-name');
        return n && n.textContent.trim() === '02_Areas';
      });
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (!entered) fail('目录树里找不到「02_Areas」（演示库变了？改脚本或重造演示库）');
    await sleep(1000);

    // ── ② 《找笔记》搜索图：搜「清单」（02_Areas 之下会命中两篇）────────
    console.log('② 搜索…');
    const searched = await evalJs(`(async () => {
      const input = document.querySelector('.kbw-search');
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '清单');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    if (!searched) fail('找不到搜索框（.kbw-search）');
    await sleep(1200);
    const hitN = await evalJs(
      `document.querySelectorAll('.kbw-gcell[data-path], .kbw-trow[data-path]').length`,
    );
    console.log(`  （搜索命中 ${hitN} 行）`);
    await capture(path.join(OUT_ARCHIVE, 'find-search-full.png'));
    let clip = await mainClip();
    if (!clip) fail('量不到 .kbw-notes-main 的裁切框');
    await capture(path.join(OUT_ASSETS, 'find-search.png'), clip);

    // 清搜索，回到目录
    await evalJs(`(() => {
      const input = document.querySelector('.kbw-search');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1000);

    // ── ③ 《找笔记》筛选图：开「筛选」面板 ────────────────────────────
    console.log('③ 筛选…');
    const opened = await evalJs(`(async () => {
      const b = [...document.querySelectorAll('.kbw-notes-toolbar .kbw-btn')].find((x) => x.textContent.trim().indexOf('筛选') >= 0);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!opened) fail('工具栏里找不到「筛选」按钮');
    await sleep(1200);
    await capture(path.join(OUT_ARCHIVE, 'find-filter-full.png'));
    /**
     * ⚠️ 筛选面板锚在「筛选」按钮上、**左缘伸进目录树那一列** —— 裁切框要取
     * 「笔记主区 ∪ 面板」的并集（首版只裁主区，面板左半边被切掉，目检当场发现）。
     */
    clip = await evalJs(`(() => {
      const el = document.querySelector('.kbw-notes-main');
      if (!el) return null;
      const a = el.getBoundingClientRect();
      const panel = [...document.querySelectorAll('.kbw-panel')].pop();
      const b = panel ? panel.getBoundingClientRect() : null;
      const x = Math.round(b ? Math.min(a.left, b.left) - 8 : a.left);
      const right = Math.round(Math.max(a.right, b ? b.right + 8 : a.right));
      const bottom = Math.round(Math.max(a.top + Math.min(a.height, 700), b ? Math.min(b.bottom + 8, 755) : 0));
      return { x, y: Math.round(a.top), width: Math.min(right - x, 920), height: Math.min(bottom - Math.round(a.top), 700) };
    })()`);
    if (!clip) fail('量不到筛选图的裁切框');
    await capture(path.join(OUT_ASSETS, 'find-filter.png'), clip);
    // 关掉筛选面板
    await evalJs(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await sleep(600);

    // ── ④ 《批量操作》图：进「02_Areas/内容创作」，多选两篇 → 批量栏 ────
    // ⚠️ 演示库是**表格档**（`notesView: 'detail'`，make-demo-vault 的口径）：
    // 文件夹是行（`.kbw-frow`）、笔记是行（`.kbw-trow`）——两档选择器都留着（换档也不乱）
    console.log('④ 多选…');
    const into = await evalJs(`(async () => {
      const cell =
        document.querySelector('.kbw-gcell.is-folder[data-dir="02_Areas/内容创作"]') ||
        document.querySelector('.kbw-frow[data-dir="02_Areas/内容创作"]');
      if (!cell) return false;
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      return true;
    })()`);
    if (!into) fail('02_Areas 层里找不到「内容创作」的文件夹格/行');
    await sleep(1200);
    const picked = await evalJs(`(async () => {
      const cells = [...document.querySelectorAll('.kbw-gcell[data-path], .kbw-trow[data-path]')];
      if (cells.length < 2) return cells.length;
      cells[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      cells[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, ctrlKey: true }));
      return cells.length;
    })()`);
    if (typeof picked !== 'number' || picked < 2) fail(`「内容创作」里不足两篇可多选（${picked}）`);
    await sleep(1000);
    const hasBatch = await evalJs(`!!document.querySelector('.kbw-notes-bar.is-batch')`);
    if (!hasBatch) fail('多选之后批量栏没出现（.kbw-notes-bar.is-batch）');
    await capture(path.join(OUT_ARCHIVE, 'batch-bar-full.png'));
    clip = await mainClip();
    await capture(path.join(OUT_ASSETS, 'batch-bar.png'), clip);
    // 收尾：清选择（点批量栏的 ✕，别用模拟 Esc —— 见坑单）
    await evalJs(`(() => {
      const x = document.querySelector('.kbw-batch .kbw-iconbtn, .kbw-notes-bar.is-batch .kbw-iconbtn');
      if (x) x.click();
      return true;
    })()`);
    await sleep(600);

    console.log(`\n${c.ok('✓')} 拍完 3 张。原图在 素材/教程配图-P7.10/，成品在 assets/tutorial/。`);
    console.log(`  ${c.dim('肉眼过一遍成品；不满意改本脚本的选择器再拍。')}`);
  } finally {
    cdp.close();
  }
}

function argsHas(flag) {
  return process.argv.slice(2).includes(flag);
}

main().catch((e) => fail(e?.stack ?? String(e)));
