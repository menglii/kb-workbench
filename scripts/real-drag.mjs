/**
 * real-drag.mjs —— 用 CDP 的**真输入管道**（Input.dispatchMouseEvent）拖一张网格卡片到左侧
 * 目录树，逐步量"浮标中心 vs 指针"的偏差。
 *
 * 为什么要有它（P7.23 收尾的教训）：探针的 `P.pointerXxx` 全是**页面内合成 DOM 事件** ——
 * 用户真机报"拖到侧边栏时图标不跟手"，而合成事件路线在实验库上量出来 0–1px；
 * **"合成事件全绿 ≠ 真输入全绿"**。这条路线补的正是输入管道那一层（P7.24 段 0 的常驻工具；
 * 要不要并进 probe runner 的 node 侧钩子，P7.24 开工时二选一）。
 *
 * 用法（自带起库/收尾，与 probe-run 同款；Obsidian 由本命令管生死）：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/real-drag.mjs
 *
 * **P7.24 转正为常驻工具（"挂大轮/重档收尾"的那一件）**：
 *   · **判据输出**：每步打印「指针/浮标/偏差/内联 transform/落点/预告」，收尾给一行总结
 *     `✓/✗ 真输入拖拽：N 步最大偏差 X px（上限 M）…`；
 *   · **退出码**：0 = 全部通过（偏差 ≤ 上限、浮标没丢、真搬 + 撤销都成）· 1 = 有判据破线
 *     （或准备/起库失败）—— 挂收尾脚本时直接看 exit code；
 *   · **参数化**：`KBW_REAL_DRAG_MAX_DEV`（默认 4，px）调上限。
 * 松手会真搬一篇（随后自动点撤销还原）；不需要搬就中途 Ctrl+C（收尾在 finally + 中断钩子里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectSandbox, cdpEval } from './cdp-page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const CFG = 'C:/Users/<你的用户名>/AppData/Roaming/obsidian/obsidian.json';
const BAK = path.join(ROOT, 'tests', '.tmp', 'obsidian.json.tmpdrag-bak');
const WANT_VAULT = 'C:/Users/<你的用户名>/OneDrive/Desktop/sandbox-vault';

function pointConfigAtSandbox() {
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
  if (!hit) return false;
  fs.writeFileSync(CFG, JSON.stringify(j), 'utf8');
  return true;
}
function restoreConfig() {
  if (fs.existsSync(BAK)) {
    fs.copyFileSync(BAK, CFG);
    fs.unlinkSync(BAK);
  }
}

/** 中断也要复原 obsidian.json（SIGINT 默认会跳过 finally —— probe-run 的同款教训） */
const onInt = (sig) => {
  console.error(`\n收到 ${sig} —— 复原 obsidian.json 后退出`);
  try {
    restoreConfig();
  } catch {
    /* 忽略 */
  }
  process.exit(130);
};
process.on('SIGINT', () => onInt('SIGINT'));
process.on('SIGTERM', () => onInt('SIGTERM'));

/** 页面侧准备：全部笔记 → 进一个"本层有笔记最多"的顶层目录 → 网格档；返回两个目标点 */
const SETUP = `(async () => {
  const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });
  const qa = (s, root) => Array.from((root ?? document).querySelectorAll(s));
  const text = (el) => (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim();
  const nav = qa('.kbw-navitem').find(function (b) { return text(b).indexOf('全部笔记') >= 0; });
  if (nav) { nav.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await sleep(900); }
  const ctx = window.app.plugins.plugins['kb-workbench'].context();
  const byDir = {};
  ctx.index.notes().forEach(function (e) {
    const d = e.effectivePosition;
    if (!d || d.indexOf('/') >= 0) return;
    byDir[d] = (byDir[d] || 0) + 1;
  });
  const top = Object.keys(byDir).sort(function (a, b) { return byDir[b] - byDir[a]; })[0];
  let node = qa('.kbw-tree-item[data-drop]').find(function (i) { return i.dataset.dir === top; });
  if (!node) return { err: '树里没有 ' + top };
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(1000);
  const seg = qa('.kbw-seg button').find(function (b) { return text(b) === '网格'; });
  if (seg) { seg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await sleep(700); }
  const cells = qa('.kbw-gcell[data-path]').filter(function (c) { return c.dataset.tpl !== '1'; });
  if (cells.length < 2) return { err: '网格里只有 ' + cells.length + ' 格（dir=' + top + '）' };
  const pick = (el, w) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const width = Math.min(r.width, w);
    return {
      x: Math.round(Math.max(8, Math.min(vw - 8, r.left + (width > 0 ? width / 2 : 40)))),
      y: Math.round(Math.max(8, Math.min(vh - 8, r.top + (r.height > 0 ? r.height / 2 : 12)))),
      visible: r.top >= 0 && r.bottom <= vh && r.height > 0,
    };
  };
  const src = pick(cells[0], 140);
  const rootNode = qa('.kbw-tree-item[data-drop]').find(function (i) { return (i.dataset.dir ?? '') === ''; });
  if (!rootNode) return { err: '树根节点不在' };
  const dst = pick(rootNode, 140);
  window.__tmpDrag = { src: src, dst: dst, dir: top };
  return { src: src, dst: dst, dir: top, cells: cells.length };
})()`;

/** 采样：浮标矩形 / 内联变换 / 预告 / 当前指针下元素 */
const SAMPLE = `(() => {
  const el = document.querySelector('.kbw-gfloat');
  const r = el ? el.getBoundingClientRect() : null;
  const prev = document.querySelector('.kbw-tree-preview');
  const drop = document.querySelector('.kbw-tree-item.is-drop');
  return {
    f: r ? { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
    tr: el ? String(el.style.transform) : null,
    preview: prev ? prev.textContent : null,
    dropDir: drop ? drop.dataset.dir : null,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!pointConfigAtSandbox()) {
    console.error('✗ obsidian.json 里没有实验库');
    process.exit(1);
  }
  console.log('✓ 已切库到实验库');
  let code = 1;
  try {
    console.log('… 起 Obsidian（--no-sandbox，park）');
    const up = spawnSync(NODE, [path.join(ROOT, 'scripts', 'obsidian.mjs'), 'up'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        KBW_EXTRA_FLAGS: '--no-sandbox --disable-breakpad --disable-crash-reporter',
      },
    });
    if (up.status !== 0) {
      console.error('✗ 起 Obsidian 失败');
      process.exit(1);
    }
    const cdp = await connectSandbox({ what: '真鼠标拖拽诊断', timeoutMs: 30000 });
    const mouse = (type, x, y) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
      });
    const ev = (expr) => cdpEval(cdp, expr, { timeoutMs: 20000 });

    const st = await ev(SETUP);
    console.log('setup =', JSON.stringify(st));
    if (!st || st.err) {
      console.error('✗ 准备失败');
      return;
    }
    const { src, dst } = st;
    let cur = { x: src.x, y: src.y };
    /** P7.24 判据累计（转正为常驻工具）：最大偏差 / 浮标丢没丢 / 松手后的搬与还原 */
    const MAX_DEV = Number(process.env.KBW_REAL_DRAG_MAX_DEV || 4);
    let maxDev = 0;
    let lostGhost = false;

    // ── 起手（真鼠标）
    await mouse('mousePressed', src.x, src.y);
    await sleep(60);
    cur = { x: src.x + 8, y: src.y + 6 };
    await mouse('mouseMoved', cur.x, cur.y);
    await sleep(120);
    let s0 = await ev(SAMPLE);
    console.log('起手后 =', JSON.stringify(s0));
    if (!s0.f) {
      console.error('✗ 没起浮标');
      return;
    }
    const anchor = { dx: s0.f.left + s0.f.w / 2 - cur.x, dy: s0.f.top + s0.f.h / 2 - cur.y };

    // ── 步进 12 步走向树根
    for (let i = 1; i <= 12; i += 1) {
      cur = {
        x: Math.round(src.x + 8 + ((dst.x - (src.x + 8)) * i) / 12),
        y: Math.round(src.y + 6 + ((dst.y - (src.y + 6)) * i) / 12),
      };
      await mouse('mouseMoved', cur.x, cur.y);
      await sleep(60);
      const s = await ev(SAMPLE);
      const dev = s.f
        ? Math.round(Math.hypot(s.f.left + s.f.w / 2 - (cur.x + anchor.dx), s.f.top + s.f.h / 2 - (cur.y + anchor.dy)))
        : -1;
      if (!s.f) lostGhost = true;
      else maxDev = Math.max(maxDev, dev);
      console.log(`步${i} 指针(${cur.x},${cur.y}) ${s.f ? `浮标(${s.f.left},${s.f.top}) 偏差${dev}` : '浮标没了'} tr=${String(s.tr).slice(0, 44)} drop=${s.dropDir} 预告=${s.preview}`);
    }

    // ── 大跳右 250（对照）
    cur = { x: dst.x + 250, y: dst.y };
    await mouse('mouseMoved', cur.x, cur.y);
    await sleep(60);
    let sJ = await ev(SAMPLE);
    if (!sJ.f) lostGhost = true;
    else {
      const devJ = Math.round(Math.hypot(sJ.f.left + sJ.f.w / 2 - (cur.x + anchor.dx), sJ.f.top + sJ.f.h / 2 - (cur.y + anchor.dy)));
      maxDev = Math.max(maxDev, devJ);
    }
    console.log('大跳后 =', JSON.stringify(sJ));

    // ── 松手（放到树根上）+ 收尾
    await mouse('mouseReleased', dst.x, dst.y);
    await sleep(600);
    const after = await ev(SAMPLE);
    console.log('松手后 =', JSON.stringify(after));
    console.log('（若文件被搬走，下面用撤销还原）');
    const undo = await ev(`(async () => {
      const btns = Array.from(document.querySelectorAll('.kbw-undobar .kbw-btn'));
      const b = btns.find(function (x) { return (x.textContent || '').indexOf('撤销') >= 0; });
      if (!b) return '没有撤销条';
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(function (r) { setTimeout(r, 1600); });
      return '已点撤销';
    })()`);
    console.log('撤销 =', undo);
    /* ── P7.24 判据输出（转正为常驻工具；挂重档收尾看这行 + exit code）── */
    const undoOk = typeof undo === 'string' && undo.indexOf('已点撤销') >= 0;
    const pass = !lostGhost && maxDev <= MAX_DEV && undoOk;
    console.log(
      (pass ? '✓' : '✗') +
        ' 真输入拖拽：' + (lostGhost ? '浮标丢过' : '浮标全程在') +
        ' · 最大偏差 ' + maxDev + 'px（上限 ' + MAX_DEV + '）' +
        ' · 撤销 ' + (undoOk ? '成' : String(undo)) +
        (pass ? ' ｜全部通过' : ' ｜有判据破线'),
    );
    cdp.close();
    code = pass ? 0 : 1;
  } finally {
    restoreConfig();
    console.log('✓ 已恢复 obsidian.json（Obsidian 会随本命令结束一起收）');
  }
  process.exit(code);
}

main().catch((e) => {
  console.error('驱动挂了：', e && e.stack ? e.stack : e);
  try {
    restoreConfig();
  } catch {
    /* 忽略 */
  }
  process.exit(1);
});
