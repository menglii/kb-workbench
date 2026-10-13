// 拍向导配图（P7.2b · 1.1 的 5 张）
//
// 连 CDP → 钉 1400×900 视口 → 逐屏布置 + **注入圈注**（截图管线里画，位置随图固定）→ 截图。
// 产出两处：
//   · `素材/向导配图-P7.2/`（**原图**：整幅 + 圈注，归档、以后改圈注位置从这儿再裁）
//   · `assets/wizard/*.png`（**成品**：裁好的横带 —— 随插件发布、向导里 <img> 直接吃）
//
// 命令行（按顺序走）：
//   1) node scripts/make-demo-vault.mjs --force          ← 生成演示库（全假内容）
//   2) node scripts/shoot-wizard.mjs --register          ← 把演示库登记成"打开的库"（Obsidian 必须完全退出）
//   3) KBW_LAUNCH_MIN=0 npm run probe:launch             ← 带调试端口启动（最大化；截图要可见窗口）
//   4) KBW_VAULT_SANDBOX="<演示库>" node scripts/shoot-wizard.mjs   ← 拍
//   5) （退出 Obsidian 后）node scripts/shoot-wizard.mjs --restore  ← 还原 obsidian.json
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
const OUT_ARCHIVE = path.join(ROOT, '素材', '向导配图-P7.2');
const OUT_ASSETS = path.join(ROOT, 'assets', 'wizard');

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

// ── 模式一：登记 / 还原 obsidian.json（都要求 Obsidian 已完全退出）──────
function register() {
  if (obsidianRunning()) fail('Obsidian 还在运行 —— 它退出时会回写 obsidian.json，先完全退出（File → Exit）');
  if (!fs.existsSync(OBS_JSON)) fail(`找不到 ${OBS_JSON}`);
  const raw = JSON.parse(fs.readFileSync(OBS_JSON, 'utf8'));
  fs.copyFileSync(OBS_JSON, OBS_BAK); // 先备份（--restore 靠它）
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
  console.log(`\n  下一步：${c.dim('KBW_LAUNCH_MIN=0 npm run probe:launch')} 然后 ${c.dim('KBW_VAULT_SANDBOX="' + DEMO + '" node scripts/shoot-wizard.mjs')}`);
}

function restore() {
  if (obsidianRunning()) fail('Obsidian 还在运行 —— 先完全退出再还原 obsidian.json（否则会被它回写覆盖）');
  if (!fs.existsSync(OBS_BAK)) fail(`没有备份 ${OBS_BAK} —— 是不是没走过 --register？`);
  fs.copyFileSync(OBS_BAK, OBS_JSON);
  fs.rmSync(OBS_BAK);
  console.log(`${c.ok('✓')} obsidian.json 已还原（下次启动回原来的库）`);
}

// ── 页面里的工具（Runtime.evaluate 用）────────────────────────────────
/** 圈注：给 list 里每一项画一枚 accent 色圆角框 + 编号；再调一次先清旧的 */
const annoJs = (list) => `(() => {
  document.getElementById('kbw-shoot-anno')?.remove();
  // 平台通知（toast）是**会话态**：上一步的"已加载/提示"会飘在角上 —— 拍图前清掉（只是化妆）
  document.querySelectorAll('.notice-container').forEach((n) => n.remove());
  const box = document.createElement('div');
  box.id = 'kbw-shoot-anno';
  box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const accent = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim() || '#7c5cff';
  const list = ${JSON.stringify(list)};
  let drawn = 0;
  for (const a of list) {
    const el = a.sel ? document.querySelector(a.sel) : null;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const pad = a.pad != null ? a.pad : 6;
    const ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;border:2.5px solid ' + accent + ';border-radius:10px;' +
      'left:' + Math.round(r.left - pad) + 'px;top:' + Math.round(r.top - pad) + 'px;' +
      'width:' + Math.round(r.width + pad * 2) + 'px;height:' + Math.round(r.height + pad * 2) + 'px;box-sizing:border-box';
    const num = document.createElement('div');
    num.textContent = String(a.n);
    num.style.cssText = 'position:absolute;left:-11px;top:-11px;width:20px;height:20px;border-radius:50%;' +
      'background:' + accent + ';color:#fff;font:bold 12px/20px sans-serif;text-align:center';
    ring.appendChild(num);
    box.appendChild(ring);
    drawn += 1;
  }
  document.body.appendChild(box);
  return drawn;
})()`;

const clearAnnoJs = `(() => { document.getElementById('kbw-shoot-anno')?.remove(); return true; })()`;

/** 找导航项（按文字）并点它 */
const navClickJs = (label) => `(async () => {
  const n = [...document.querySelectorAll('.kbw-navitem')].find((x) => x.textContent.includes(${JSON.stringify(label)}));
  if (!n) return false;
  n.click();
  return true;
})()`;

async function main() {
  if (argsHas('--register')) return register();
  if (argsHas('--restore')) return restore();

  // ── 守卫：必须指着演示库跑（cdp-page 的沙盒判据也认这个 env）────────
  const sb = sandboxVault();
  if (path.resolve(sb).toLowerCase() !== DEMO.toLowerCase()) {
    fail(
      `KBW_VAULT_SANDBOX 必须指向演示库（当前 ${sb} / 期望 ${DEMO}）——\n` +
        `  即：KBW_VAULT_SANDBOX="${DEMO}" node scripts/shoot-wizard.mjs\n` +
        `  （这一条同时是"只连演示库"的守卫；真库与实验库都不该被这个脚本连上）`,
    );
  }
  if (!fs.existsSync(DEMO)) fail(`演示库不存在：${DEMO} —— 先跑 node scripts/make-demo-vault.mjs --force`);

  const cdp = await connectSandbox({ what: '拍向导配图' });
  try {
    const { visible } = await bringToFront(cdp, { allowMinimized: false });
    if (!visible) {
      fail('窗口不可见（最小化/被遮住）—— 截图会超时或拿到陈旧帧。用 KBW_LAUNCH_MIN=0 npm run probe:launch 重启');
    }
    // 钉视口：1400×900、dsf 1 —— 与拍图规范一致（浅色 1400×900）
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
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
      // 每次截图前清一下平台通知（toast 是会话态，上一拍的"已加载"会飘在角上 —— 只是化妆）
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

    /** 把工作台开出来（会话恢复可能已经开着） */
    const ensureWorkbench = async () => {
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
    };

    fs.mkdirSync(OUT_ARCHIVE, { recursive: true });
    fs.mkdirSync(OUT_ASSETS, { recursive: true });
    console.log(`连上了：${cdp.vault}`);

    // ── ① 原生 Obsidian（引言左栏的"痛点"面）──────────────────────
    console.log('① 原生 Obsidian…');
    await evalJs(`(async () => {
      const app = window.app;
      // 先收掉工作台的叶，再关插件（不然视图会剩一个"插件已关"的壳）；
      // 旧 markdown 标签也一并收掉 —— 重拍时上一轮的标签会攒起来（两个同名标签很难看）
      for (const l of app.workspace.getLeavesOfType('kb-workbench-view')) l.detach();
      for (const l of app.workspace.getLeavesOfType('markdown')) l.detach();
      await app.plugins.disablePlugin('kb-workbench');
      const f = app.vault.getMarkdownFiles().find((x) => x.path.includes('卡片笔记'));
      await app.workspace.getLeaf('tab').openFile(f);
      return true;
    })()`);
    await sleep(1500);
    await evalJs(annoJs([])); // 原生面不圈注（它是"痛点"的底，字由引言栏说）
    await capture(path.join(OUT_ARCHIVE, '01-native-full.png'));
    await capture(path.join(OUT_ASSETS, '01-native.png'), { x: 0, y: 0, width: 1400, height: 900 });
    await evalJs(clearAnnoJs);
    // 把插件开回来
    await evalJs(`(async () => { await app.plugins.enablePlugin('kb-workbench'); return true; })()`);
    await sleep(1200);
    await ensureWorkbench();

    // ── ② 工作台首页 ────────────────────────────────────────────
    console.log('② 工作台首页…');
    await evalJs(`(async () => {
      const p = app.plugins.plugins['kb-workbench'];
      const ctx = p.context();
      for (const l of app.workspace.getLeavesOfType('kb-workbench-view')) app.workspace.setActiveLeaf(l, { focus: true });
      // 切到首页（点导航项 —— 与真人同一条路）
      const n = [...document.querySelectorAll('.kbw-navitem')].find((x) => x.textContent.includes('首页'));
      if (n) n.click();
      await ctx.activate?.();
      return true;
    })()`);
    await sleep(1500);
    await evalJs(annoJs([]));
    await capture(path.join(OUT_ARCHIVE, '02-home-full.png'));
    await capture(path.join(OUT_ASSETS, '02-home.png'), { x: 0, y: 0, width: 1400, height: 900 });
    await evalJs(clearAnnoJs);

    // ── ③ 目录树（工作文件夹 / 元数据目录）──────────────────────
    console.log('③ 目录树…');
    await evalJs(navClickJs('全部笔记'));
    await sleep(1500);
    const drew3 = await evalJs(`(() => {
      document.getElementById('kbw-shoot-anno')?.remove();
      document.querySelectorAll('.notice-container').forEach((n) => n.remove());
      const box = document.createElement('div');
      box.id = 'kbw-shoot-anno';
      box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const accent = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim() || '#7c5cff';
      const ring = (el, n, pad) => {
        const r = el.getBoundingClientRect();
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;border:2.5px solid ' + accent + ';border-radius:10px;' +
          'left:' + Math.round(r.left - pad) + 'px;top:' + Math.round(r.top - pad) + 'px;' +
          'width:' + Math.round(r.width + pad * 2) + 'px;height:' + Math.round(r.height + pad * 2) + 'px;box-sizing:border-box';
        const num = document.createElement('div');
        num.textContent = String(n);
        num.style.cssText = 'position:absolute;left:-11px;top:-11px;width:20px;height:20px;border-radius:50%;' +
          'background:' + accent + ';color:#fff;font:bold 12px/20px sans-serif;text-align:center';
        d.appendChild(num);
        box.appendChild(d);
      };
      // ① = 根节点那一行（整个知识库 = 工作文件夹）；② = 99_Meta 那行
      // ⚠️ 行文本以折叠箭头开头 —— 按**名字元素**的精确文本找（startsWith 会落空，第一版就栽在这）
      const nameOf = (row) => row.querySelector('.kbw-tree-name')?.textContent?.trim() ?? '';
      const rows = [...document.querySelectorAll('.kbw-tree-item')];
      const root = rows.find((r) => nameOf(r) === '整个知识库');
      const meta = rows.find((r) => nameOf(r) === '99_Meta');
      if (root) ring(root, 1, 7);
      if (meta) ring(meta, 2, 6);
      document.body.appendChild(box);
      return (root ? 1 : 0) + (meta ? 1 : 0);
    })()`);
    console.log(`  （圈注画了 ${drew3}/2）`);
    await capture(path.join(OUT_ARCHIVE, '03-tree-full.png'));
    await capture(path.join(OUT_ASSETS, '03-tree.png'), { x: 0, y: 0, width: 1400, height: 620 });
    await evalJs(clearAnnoJs);

    // ── ④ 图谱（模块开关那步）──────────────────────────────────
    console.log('④ 图谱…');
    await evalJs(navClickJs('图谱'));
    await sleep(3500); // 官方图谱渲染要一会儿
    // 官方图谱的「颜色组/外观/力度」控制面板默认浮在右上角 —— 拍图时先收起来（点它自己那个 ×）
    await evalJs(`(() => {
      const panel = document.querySelector('.graph-controls');
      if (!panel) return false;
      const closeBtn = panel.querySelector('.clickable-icon, .graph-controls-button');
      if (closeBtn) { closeBtn.click(); return true; }
      panel.style.display = 'none';
      return true;
    })()`);
    await sleep(400);
    await evalJs(`(() => {
      const n = [...document.querySelectorAll('.kbw-navitem')].find((x) => x.textContent.includes('图谱'));
      if (!n) return 0;
      const accent = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim() || '#7c5cff';
      const r = n.getBoundingClientRect();
      const box = document.createElement('div');
      box.id = 'kbw-shoot-anno';
      box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const ring = document.createElement('div');
      ring.style.cssText = 'position:fixed;border:2.5px solid ' + accent + ';border-radius:10px;' +
        'left:' + (r.left - 6) + 'px;top:' + (r.top - 6) + 'px;width:' + (r.width + 12) + 'px;height:' + (r.height + 12) + 'px;box-sizing:border-box';
      const num = document.createElement('div');
      num.textContent = '1';
      num.style.cssText = 'position:absolute;left:-11px;top:-11px;width:20px;height:20px;border-radius:50%;' +
        'background:' + accent + ';color:#fff;font:bold 12px/20px sans-serif;text-align:center';
      ring.appendChild(num);
      box.appendChild(ring);
      document.body.appendChild(box);
      return 1;
    })()`);
    await capture(path.join(OUT_ARCHIVE, '04-graph-full.png'));
    await capture(path.join(OUT_ASSETS, '04-graph.png'), { x: 0, y: 0, width: 1400, height: 720 });
    await evalJs(clearAnnoJs);

    // ── ⑤ 重排库结构（现场检测那步指向的面板）──────────────────
    console.log('⑤ 重排库结构…');
    await evalJs(
      `(async () => { app.commands.executeCommandById('kb-workbench:rebuild'); return true; })()`,
    );
    await sleep(900);
    // 点「生成预览（只读）」并等预演算完
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.kbw-btn')].find((x) => x.textContent.includes('生成预览'));
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(2500);
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.kbw-btn')].find((x) => x.textContent.includes('生成预览'));
      if (!b) return 0;
      const accent = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim() || '#7c5cff';
      const r = b.getBoundingClientRect();
      const box = document.createElement('div');
      box.id = 'kbw-shoot-anno';
      box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const ring = document.createElement('div');
      ring.style.cssText = 'position:fixed;border:2.5px solid ' + accent + ';border-radius:10px;' +
        'left:' + (r.left - 6) + 'px;top:' + (r.top - 6) + 'px;width:' + (r.width + 12) + 'px;height:' + (r.height + 12) + 'px;box-sizing:border-box';
      const num = document.createElement('div');
      num.textContent = '1';
      num.style.cssText = 'position:absolute;left:-11px;top:-11px;width:20px;height:20px;border-radius:50%;' +
        'background:' + accent + ';color:#fff;font:bold 12px/20px sans-serif;text-align:center';
      ring.appendChild(num);
      box.appendChild(ring);
      document.body.appendChild(box);
      return 1;
    })()`);
    await capture(path.join(OUT_ARCHIVE, '05-rebuild-full.png'));
    // ⚠️ 这一张要**全幅 900**：面板高，底栏那枚「生成预览」在 ~714px 处 —— 裁 720 会把它切掉（第一版就是）
    await capture(path.join(OUT_ASSETS, '05-rebuild.png'), { x: 0, y: 0, width: 1400, height: 900 });
    await evalJs(clearAnnoJs);
    // 收尾：把面板关掉（往 body 派一发 Escape —— 全局 Esc 装在 document 捕获上，与用例同一路数）
    await evalJs(
      `(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`,
    );
    await sleep(400);

    console.log(`\n${c.ok('✓')} 拍完 5 张。原图在 素材/向导配图-P7.2/，成品在 assets/wizard/。`);
    console.log(`  ${c.dim('肉眼过一遍成品（尤其圈注位置）；不满意改本脚本的 sel/clip 再拍。')}`);
  } finally {
    cdp.close();
  }
}

function argsHas(flag) {
  return process.argv.slice(2).includes(flag);
}

main().catch((e) => fail(e?.stack ?? String(e)));
