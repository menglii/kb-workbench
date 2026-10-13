// 演示库生成器（P7.2b 向导配图专用）
//
// 建一个**全假内容**的 Obsidian 库：主题化的虚构笔记（**不含任何真实信息**）——
// 拍图、演示、试跑用。配图红线："分享包 / 截图里的图不许带真实库内容"，这就是那件事的底子。
//
// 用法：
//   npm run build && node scripts/make-demo-vault.mjs            → 桌面/插件演示库
//   node scripts/make-demo-vault.mjs --out "D:/某处" --force     → 换落点/覆盖重建
//
// 产出：
//   <库>/.obsidian/            精简核心插件配置（graph 开着 —— 图谱那屏要用）
//   <库>/.obsidian/plugins/kb-workbench/   插件本体（从仓库现拷；assets/ 一起）
//   <库>/01_新知识库/          21 个骨架目录 + 14 篇**虚构**主题笔记 + 1 篇操作日志
//   <库>/02_旧知识库/          两个空目录（让"工作文件夹"的切换有个现成候选）
//
// ⚠️ 本脚本**不碰 Obsidian 的库登记**（obsidian.json）—— 那是 `shoot-wizard.mjs --register`
//    的活，而且必须在 Obsidian **完全退出**时做（它退出时会回写那个文件）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const force = args.includes('--force');
const DEMO =
  outIdx >= 0
    ? path.resolve(args[outIdx + 1])
    : path.resolve(process.env.KBW_DEMO_VAULT || 'C:/Users/<你的用户名>/OneDrive/Desktop/插件演示库');

const fail = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

// ── 1. 从源码读骨架目录（唯一真源，照 make-share-pack 的读法）──────────
const cfgSrc = fs.readFileSync(path.join(ROOT, 'src/core/config-files.ts'), 'utf8');
const dirsBlock = /dirs:\s*\[([\s\S]*?)\]/.exec(cfgSrc);
if (!dirsBlock) fail('从 src/core/config-files.ts 里读不出 dirs —— 它的形状变了，改这个脚本');
const DIRS = [...dirsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (DIRS.length < 20) fail(`骨架目录只读出 ${DIRS.length} 个（该 ≥ 20）`);

// ── 2. 虚构笔记（主题化；类型/状态都照属性规范 v2 的真实值域写）────────────
/**
 * ⚠️ **v2 对齐（P8 收口 · 老账）**：这里原先写一行 `领域: ${area}` ——
 * 「领域」随属性 v2（P7.12）退役，demo 库不该再示范一个已退役的键。
 * 「六件」的后两件（`文件位置` / `收藏`）需要知道落点目录 → 在**落盘那一处**统一插
 *（见下面的 `withV2Props`），builder 只管内容。
 * ⚠️ `area` 仍留在参数里 —— 它标明这篇属于哪个领域，只是不再落成属性。
 */
const note = (title, { area, type, status, tags, body }) =>
  [
    '---',
    `类型: ${type}`,
    `状态: ${status}`,
    '创建日期: 2026-09-18',
    'tags:',
    ...tags.map((t) => `  - ${t}`),
    '---',
    '',
    `# ${title}`,
    '',
    ...body,
    '',
  ].join('\n');

const NOTES = {
  '01_新知识库/00_Inbox/读《卡片笔记写作法》.md': note('读《卡片笔记写作法》', {
    area: '内容创作',
    type: '想法',
    status: '待整理',
    tags: ['读书', '方法论'],
    body: ['卡片盒的关键不是"记"，是"把想法连起来"。', '', '先放两天，整理时再决定它去哪。'],
  }),
  '01_新知识库/00_Inbox/灵感：周报自动化.md': note('灵感：周报自动化', {
    area: '灵感杂记',
    type: '想法',
    status: '待整理',
    tags: ['自动化'],
    body: ['每周五花十分钟把"最近改动"过一遍，攒成一篇周报。'],
  }),
  '01_新知识库/01_Projects/01_执行中/个人网站改版.md': note('个人网站改版', {
    area: '项目',
    type: '项目笔记',
    status: '进行中',
    tags: ['项目', '前端'],
    body: ['目标：把首页换成"项目 + 文章"两栏。', '', '## 待办', '- [ ] 列出现有页面清单', '- [ ] 选一个新的字体组合'],
  }),
  '01_新知识库/01_Projects/02_待跟进/读书会分享.md': note('读书会分享', {
    area: '项目',
    type: '项目笔记',
    status: '进行中',
    tags: ['项目', '分享'],
    body: ['下月的读书会轮到我讲《卡片笔记写作法》。', '', '先攒素材，再定大纲。'],
  }),
  '01_新知识库/02_Areas/内容创作/写作选题库.md': note('写作选题库', {
    area: '内容创作',
    type: 'MOC',
    status: '持续更新',
    tags: ['MOC', '写作'],
    body: ['收集所有"可以写成文章"的选题，成稿后从这里摘出去。', '', '- 为什么我做笔记总是半途而废', '- 双链不是越多越好'],
  }),
  '01_新知识库/02_Areas/内容创作/公众号排版清单.md': note('公众号排版清单', {
    area: '内容创作',
    type: '指南',
    status: '持续更新',
    tags: ['写作', '清单'],
    body: ['发布前的固定动作：', '', '1. 标题少于 20 字', '2. 段间空一行', '3. 配图压到 500KB 以内'],
  }),
  '01_新知识库/02_Areas/游戏研究/《空洞骑士》地图考.md': note('《空洞骑士》地图考', {
    area: '游戏研究',
    type: '资料',
    status: '进行中',
    tags: ['游戏', '地图'],
    body: ['把圣巢的每个区域按"进入顺序"重新排一遍。'],
  }),
  '01_新知识库/02_Areas/生活健康/露营装备清单.md': note('露营装备清单', {
    area: '生活健康',
    type: '任务清单',
    status: '已完成',
    tags: ['生活', '清单'],
    body: ['- [x] 帐篷', '- [x] 天幕', '- [ ] 新的炉头', '- [ ] 防潮垫 ×2'],
  }),
  '01_新知识库/03_Resources/技术笔记/Obsidian 双链实践.md': note('Obsidian 双链实践', {
    area: '资源',
    type: '指南',
    status: '持续更新',
    tags: ['Obsidian', '笔记法'],
    body: ['双链只在"回头看"时才产生价值 —— 写的时候别为了链而链。'],
  }),
  '01_新知识库/03_Resources/技术笔记/Git 常用命令速查.md': note('Git 常用命令速查', {
    area: '资源',
    type: '资料',
    status: '持续更新',
    tags: ['Git', '速查'],
    body: ['`git switch -c` 建分支；`git restore --staged` 撤暂存。'],
  }),
  '01_新知识库/03_Resources/灵感杂记/地铁上的三条念头.md': note('地铁上的三条念头', {
    area: '灵感杂记',
    type: '想法',
    status: '待整理',
    tags: ['灵感'],
    body: ['1. 用"这周删了哪几篇"当整理指标', '2. 首页只留五个动作', '3. 给每篇笔记写一行"为什么留它"'],
  }),
  '01_新知识库/04_Archives/2025 年度回顾.md': note('2025 年度回顾', {
    area: '归档',
    type: '内容作品',
    status: '已归档',
    tags: ['回顾'],
    body: ['这一年最大的变化：从"收集"转向"整理"。'],
  }),
  '01_新知识库/99_Meta/04_索引与地图/知识地图.md': note('知识地图', {
    area: 'Meta',
    type: 'MOC',
    status: '持续更新',
    tags: ['MOC'],
    body: ['所有领域中心页的入口。'],
  }),
  '01_新知识库/99_Meta/05_操作日志/日志-20261002-213000-整理收件箱.md': note('日志-20261002-213000-整理收件箱', {
    area: 'Meta',
    type: '日志',
    status: '已完成',
    tags: ['日志'],
    body: ['把收件箱里的 4 篇分到了「内容创作」与「灵感杂记」。'],
  }),
};

/**
 * **补上「六件」的后两件**（v2）：`文件位置` = 笔记所在目录（相对库根，列表形）·`收藏: false`。
 * 在落盘前统一插，builder 不用各自记得。
 */
const withV2Props = (text, dir) =>
  text.replace('\n---\n', `\n文件位置:\n  - ${dir}\n收藏: false\n---\n`);

// ── 3. 重建库 ─────────────────────────────────────────────────
if (fs.existsSync(DEMO)) {
  if (!force) {
    fail(`演示库已存在：${DEMO}\n  要覆盖重建就加 --force（它是全假内容，重建不会丢任何真东西）`);
  }
  fs.rmSync(DEMO, { recursive: true, force: true });
}

const mk = (p) => fs.mkdirSync(p, { recursive: true });
mk(path.join(DEMO, '.obsidian', 'plugins', 'kb-workbench'));

// 精简核心插件配置：图谱/文件列表/搜索/属性/命令面板开着，其余关（干净的第一屏）
fs.writeFileSync(
  path.join(DEMO, '.obsidian', 'core-plugins.json'),
  `${JSON.stringify(
    {
      'file-explorer': true,
      'global-search': true,
      switcher: true,
      graph: true,
      backlink: false,
      canvas: false,
      'outgoing-link': false,
      'tag-pane': false,
      properties: true,
      'page-preview': false,
      'daily-notes': false,
      templates: false,
      'command-palette': true,
      'editor-status': true,
      outline: false,
      'word-count': false,
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(DEMO, '.obsidian', 'appearance.json'),
  `${JSON.stringify({ theme: 'moonstone', cssTheme: '' }, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(DEMO, '.obsidian', 'community-plugins.json'),
  `${JSON.stringify(['kb-workbench'], null, 2)}\n`,
);

// 插件本体（从仓库现拷 —— 与 deploy 一样是"构建产物"，别在演示库里开发）
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  if (!fs.existsSync(path.join(ROOT, f))) fail(`缺构建产物 ${f} —— 先 npm run build`);
  fs.copyFileSync(path.join(ROOT, f), path.join(DEMO, '.obsidian', 'plugins', 'kb-workbench', f));
}
const assetsSrc = path.join(ROOT, 'assets');
if (fs.existsSync(assetsSrc)) {
  fs.cpSync(assetsSrc, path.join(DEMO, '.obsidian', 'plugins', 'kb-workbench', 'assets'), {
    recursive: true,
  });
}
// 插件设置：**配过的稳态**（向导别再弹）+ 表格档（截图里目录树旁边是列表，看着像"资料库"）
// ⚠️ P7.10 · #8 起还要种 `notesIntroSeen: true`：不种的话首入「全部笔记」的一次性讲解浮层
// 会飘在出图目标上（拍教程配图时当场入镜）—— 演示库是"这台设备见过"的稳态。
fs.writeFileSync(
  path.join(DEMO, '.obsidian', 'plugins', 'kb-workbench', 'data.json'),
  `${JSON.stringify({ wizardDone: true, notesView: 'detail', notesIntroSeen: true }, null, 2)}\n`,
);

// 骨架目录 + 虚构笔记 + 一个现成的候选工作文件夹
for (const d of DIRS) mk(path.join(DEMO, '01_新知识库', d));
for (const [rel, text] of Object.entries(NOTES)) {
  const abs = path.join(DEMO, rel);
  // 文件位置 = 相对**库根**（`01_新知识库`）的目录（v2 列表形）
  const dir = path.posix.dirname(rel).split('/').slice(1).join('/');
  mk(path.dirname(abs));
  fs.writeFileSync(abs, withV2Props(text, dir));
}
mk(path.join(DEMO, '02_旧知识库', '00_Inbox'));
fs.writeFileSync(path.join(DEMO, '02_旧知识库', 'README.md'), '# 旧知识库\n\n（演示用：一个"现成的候选文件夹"）\n');

const count = Object.keys(NOTES).length;
console.log(`✓ 演示库已生成：${DEMO}`);
console.log(`  · 骨架目录 ${DIRS.length} 个 · 虚构笔记 ${count} 篇 · 插件 ${manifest.id} v${manifest.version}`);
console.log('  下一步（拍图）：node scripts/shoot-wizard.mjs --register（Obsidian 要先完全退出）');
