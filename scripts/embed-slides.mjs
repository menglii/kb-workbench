// 把 8 张成品 WebP 内嵌进讲解页 HTML（替换 .shot__bd 占位框）
//
// 用法：node scripts/embed-slides.mjs [--html <路径>]
//   · 默认对象 = `C:/Users/<你的用户名>/Downloads/经纬-知识工作台-讲解页.html`
//   · 首次跑会先备份成 `….备份-2026-10-13.html`（已存在则不覆盖）
//   · 幂等保护：页面里已经有 data:image/webp 就直接退出（重拍后要重嵌，先还原备份再跑）
//
// 配对方式 = **按 DOM 顺序**：页面里 8 个槽位的 `.shot__t` 依次是
// 首页 / 全部笔记 / 确认卡 / 看板 / 复习 / 助手 / 暗色 / 收件箱 —— 与文件名一一对应，
// 顺序对不上直接报错（不猜、不错位）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, '素材', '讲解页-2026-10-13', 'web');
const args = process.argv.slice(2);
const htmlPath = (() => {
  const i = args.indexOf('--html');
  return i >= 0 ? args[i + 1] : 'C:/Users/<你的用户名>/Downloads/经纬-知识工作台-讲解页.html';
})();

/** [文件名, 槽位标签（核对用）, alt] */
const FILES = [
  ['01-home', '首页', '演示库 · 首页：搜索、快捷动作与「待处理」全库体检'],
  ['02-notes', '全部笔记', '演示库 · 全部笔记：筛选、勾选与底部批量栏'],
  ['03-notes-confirm', '确认卡', '演示库 · 确认卡：批量移动前写清「会发生什么」'],
  ['04-board', '看板', '演示库 · 看板：拖动换栏后，底部撤销条兜底'],
  ['05-review', '复习', '演示库 · 复习：卡片翻到答案面，1 / 2 / 3 三键评分'],
  ['06-ai-plan', '助手', '演示库 · 助手：「整理收件箱」跑到确认卡前的提案表'],
  ['07-dark', '暗色', '演示库 · 暗色：明暗跟随 Obsidian 主题'],
  ['08-ai-confirm', '收件箱', '演示库 · 确认卡：即将按 AI 的建议移动 2 篇'],
];

const fail = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

if (!fs.existsSync(htmlPath)) fail(`找不到 HTML：${htmlPath}`);
let html = fs.readFileSync(htmlPath, 'utf8');
if (html.includes('data:image/webp')) fail('页面里已经有内嵌图了（要重嵌先还原 .备份 文件再跑）');

// ── 槽位顺序核对 ────────────────────────────────────────────────
const found = [...html.matchAll(/shot__t">演示库 · ([^<]+)</g)].map((m) => m[1]);
const want = FILES.map((f) => f[1]);
if (found.length !== 8 || found.some((x, i) => x !== want[i])) {
  fail(`槽位顺序对不上。页面里：${found.join(' / ')}；期望：${want.join(' / ')}`);
}

// ── 备份（首次）────────────────────────────────────────────────
const bak = htmlPath.replace(/\.html$/, '.备份-2026-10-13.html');
if (!fs.existsSync(bak)) {
  fs.writeFileSync(bak, html);
  console.log(`· 已备份 → ${path.basename(bak)}`);
}

// ── CSS：配图模式（虚线占位 → 真截图；图与假窗口栏拼成"截图窗口"）──
if (!html.includes('配图模式：虚线占位换成真截图')) {
  const css =
    `\n/* ── 配图模式：虚线占位换成真截图（2026-10-13）──\n` +
    `   图与 .shot__bar（假窗口栏）拼成一块"截图窗口"；叠层场景里右栏高是被 flex 定死的，\n` +
    `   所以 img 用 object-fit:cover 顶对齐裁切；行内（版面流里）则按原比例整张显示。 */\n` +
    `.shot__bd.has-img{border:0; margin:0; padding:0; min-height:0; border-radius:0; display:block}\n` +
    `.shot__bd.has-img img{display:block; width:100%; height:100%; object-fit:cover; object-position:top center}\n`;
  html = html.replace('</style>', css + '</style>');
}

// ── 逐个替换 .shot__bd（按 DOM 顺序配对）────────────────────────
let i = 0;
html = html.replace(/<div class="shot__bd">[\s\S]*?<\/div>/g, (m) => {
  if (i >= FILES.length) return m;
  const [name, , alt] = FILES[i];
  i += 1;
  const b64 = fs.readFileSync(path.join(WEB, `${name}.webp`)).toString('base64');
  return (
    `<div class="shot__bd has-img">` +
    `<img src="data:image/webp;base64,${b64}" alt="${alt}" width="1332" height="816" decoding="async">` +
    `</div>`
  );
});
if (i !== FILES.length) fail(`只替换了 ${i} / ${FILES.length} 个槽位（占位框形状变了？）`);

fs.writeFileSync(htmlPath, html);
console.log(`✓ 8 张全部内嵌 → ${htmlPath}`);
console.log(`  文件大小 ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB（其中图 ${(fs.readFileSync(path.join(WEB, '04-board.webp')).length / 1024).toFixed(0)}KB~ 级）`);
console.log('  → 浏览器打开看一眼；要重嵌：还原 .备份-2026-10-13.html 后再跑');
