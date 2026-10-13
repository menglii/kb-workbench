/**
 * spec：P4 · 看板 —— 板块取数 / 卡片三档 / 悬浮小窗 / 勾选框直写 / 跨板块拖动 / 三套菜单
 *
 * 对应完成定义（开发计划.md §9）：
 *   「文件夹源板块显示出卡片且摘要里没有前言与尾链 · 展开就地长开 · 单击出悬浮小窗 ·
 *     勾选框直写那一行 · 跨板块拖动按分组改对了东西 · 三套菜单的作用域行都对」
 *
 * 三层（与前几期同一套）：
 *   A. **纯函数**：配置归一化 / 四种数据源的取数 / 排序 / 摘要剥离 / 任务行对齐
 *   B. **真链路**：在真数据副本上挂看板 → 卡片 → 小窗 → 勾选框 → 拖动（真搬文件）
 *   C. **界面**：板块管理面板 / 三套菜单 / 只读模式
 *
 * ⚠️ 数据源是 `BASE_KB`（迁移后那份）。**断言一律从数据里取** ——
 * 完成定义里写的"显示 4 篇"是照设计稿说的，实验库现在那个目录下有几篇就认几篇
 * （夹具一换就假红是这一期开工时刚踩过的坑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { NoteEntry } from '../../src/core/vault-index';
import type { StubApp } from '../stub/index';
import { MarkdownRenderer } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { Component } from '../stub/index';
import type { Component as CardComponent } from 'obsidian';
import { __resetNotices } from '../../src/ui/notify';
import { __escapeLabels } from '../../src/core/keymap';
import { LONG_PRESS_MS, wasDraggingRecently } from '../../src/ui/dnd';
import { __resetUndo, hasUndoBar } from '../../src/ui/undo-bar';
import { closeAllMenus } from '../../src/ui/menu';
import { mergeWindowInto, panelOfPath } from '../../src/modules/board/editor';
import {
  BOARD_CONFIG_VERSION,
  effectiveHeight,
  effectiveWidth,
  groupKey,
  hasOverride,
  migrateLegacyView,
  normalizeBoard,
  normalizeSection,
  panelWrapFor,
  withPanelPref,
} from '../../src/modules/board/config';
import {
  applyPanelFont,
  defaultPanelFont,
  nextFontSize,
  platformBaseFont,
} from '../../src/modules/board/panel-ui';
import { BOARD_VIEW_DEFAULTS } from '../../src/core/config-files';
import { planBoard, sortNotes, defaultPropsFor } from '../../src/modules/board/sources';
import { cardBody, taskItems, setTaskLine } from '../../src/modules/board/summary';
import {
  cardsAxis,
  withInserted,
  withInsertedMany,
  hitTest,
  slotFromRects,
  type SlotRect,
} from '../../src/modules/board/drag';
import {
  dragSet,
  marqueeHit,
  normRect,
  rangeSelected,
  toggleSelected,
} from '../../src/modules/board/select';
import { applyListBudget, renderCard } from '../../src/modules/board/cards';
import { insertTab, nextActiveAfterClose, remapPaths, resolveActive } from '../../src/modules/board/tabs';
import { closeCardPanel } from '../../src/modules/board/editor';
import { VIEW_TYPE } from '../../src/view/workbench-view';
import { dockFit, dockReserve, normalizeDock, withDockSide } from '../../src/ui/dock';
import { purgeOverlays } from '../../src/ui/panel';
import { onlyCollapseChanged } from '../../src/modules/board/index';
import { stripTailSection } from '../../src/services/templates';

const KB = '01_新知识库';
const BOARD_CFG = `${KB}/99_Meta/06_工作台/看板配置.json`;

/** 造一条 NoteEntry（纯函数层用，不碰库） */
function entry(relPath: string, props: Record<string, unknown> = {}): NoteEntry {
  const name = relPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
  return {
    file: { path: `${KB}/${relPath}`, basename: name } as never,
    props,
    flags: [],
    effectivePosition: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '',
    path: `${KB}/${relPath}`,
    basename: name,
    isTemplate: false,
    mtime: 1000,
    size: 10,
  };
}

/**
 * 工具条上那个「板块管理」按钮 —— **按图标认它**（lucide 的 `settings`），不按文字认。
 *
 * 为什么单拎出来：它原先写的是 emoji 字形「⚙ 板块」，emoji 的长相由**字体**决定
 * （用户 2026-09-25 第二波反馈："时不时变成灰色上色的版本"）→ 已改成 SVG + 纯文字「板块」。
 * 而按文字认会撞上旁边的「＋ 添加板块」（它俩都含"板块"两个字）→ 所以锚在**图标**上。
 *
 * ⚠️ **桩与真机的图标形状不一样**（真机实测 2026-09-25）：
 *   · 桩（`tests/stub`）：`<svg data-icon="settings">`
 *   · 真机（Obsidian `setIcon`）：`<svg class="svg-icon lucide-settings">`，**没有 `data-icon`**
 * 两个选择器都写上 —— 只按桩的形状写，将来有人把这条判据搬到真机（探针）就会**永远匹配不到**
 * （那种"写了判据、其实查了个不存在的属性"正是本项目栽过的假绿）。
 */
/**
 * 工具条上那个齿轮（按 lucide settings 认，不是 emoji 字形）。
 *
 * ⚠️ **有选择时整条工具条会被批量栏顶掉**（c 期 §3.4 的口径，与「全部笔记」同一套）——
 * 那一刻齿轮**本来就该不在**，点批量栏的 ✕（「清空选择」）它才回来。
 * 用例开头常常还带着上一条留下的选择（"三套菜单"那几条会右键卡片，右键即选中），
 * 所以这里先把它清掉再找：**判据是"清空之后齿轮在不在"**，
 * 不是"任何时刻它都得在"（后者会把正常行为当成 bug）。
 *
 * 清选择用**点 ✕**、不用模拟 Esc：Esc 要走 `installGlobalEscape` 那条
 * document 捕获监听，桩环境里不一定接得住；点按钮是同步的、也只走产品自己的那条路。
 */
function gearBtn(): HTMLElement | undefined {
  const pick = (): HTMLElement | undefined =>
    H.qa<HTMLElement>(document.body, '.kbw-board-toolbar .kbw-btn').find(
      (b) => b.querySelector('svg[data-icon="settings"], svg.lucide-settings') !== null,
    );
  const first = pick();
  if (first) return first;
  const clear = H.maybe<HTMLElement>(
    document.body,
    '.kbw-board-toolbar .kbw-batch-tail .kbw-iconbtn',
  );
  if (clear) H.click(clear);
  return pick();
}

export async function specBoard(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 打开「看板」并等它画好（点导航项 = 真路径，见 notes.ts 的同一段注释） */
  async function openBoard(): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes('看板'),
    );
    ok(nav, '导航里有「看板」');
    H.click(nav as Element);
    await H.settle(120);
  }

  /** 把看板配置写成指定内容（**模拟"手改库内 JSON"**：走文件 + modify 事件，真链路） */
  async function writeBoardCfg(data: unknown): Promise<void> {
    H.writeNote(vaultRoot, BOARD_CFG, `${JSON.stringify(data, null, 2)}\n`);
    app.vault.rescan();
    const f = app.vault.getAbstractFileByPath(BOARD_CFG);
    app.vault.trigger('modify', f);
    await H.settle(320); // 配置监听是 150ms debounce
  }

  const cards = (): HTMLElement[] => H.qa(document.body, '[data-card]');
  const sections = (): HTMLElement[] => H.qa(document.body, '.kbw-sect');

  // ════════════════════════════════════════════════════════════
  await suite.group('P4 · 看板 · 纯函数（配置 / 取数 / 摘要 / 任务行）', async () => {
    await suite.it('配置归一化：坏数据不炸、缺项补默认、未知键保留', () => {
      const cfg = normalizeBoard({
        version: 1,
        view: { cardWidth: 9999, gap: -5, cardMode: '看不懂', props: ['状态'] },
        sections: [
          { id: 'a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 'a', name: '重复 id', kind: 'tag', value: 'x' }, // 重复 id → 留第一个
          { id: 'b', kind: 'shelter' }, // 收容所没有值也要能建
          { id: 'c', kind: 'tag', value: '' }, // 没配完的 → 丢掉
          null,
        ],
        _说明: '手写的注释键',
      });
      eq(cfg.view.cardWidth, 720, '卡片宽度夹到上限 720（2026-09-25 从 480 提到 720）');
      eq(cfg.view.cardHeight, 0, '卡片高度缺省 = 0（自动）');
      eq(cfg.view.gap, 0, '间距夹到 0');
      eq(cfg.view.cardMode, 'content', '看不懂的档位退回默认');
      eq(cfg.sections.length, 2, '重复 id 与空值板块被丢掉（实际 2 个）');
      eq(cfg.sections[1].name, '收容所', '收容所的名字有默认值');
      eq((cfg as unknown as { _说明?: string })._说明, undefined, '未知键不进归一化结果（写回时另存）');
    });

    await suite.it('取数：文件夹源递归命中 + 自动子板块（空的子目录不生成）', () => {
      const entries = [
        entry('02_Areas/内容创作/未锈铠.md'),
        entry('02_Areas/内容创作/终末地.md'),
        entry('02_Areas/内容创作/9月/9.20.md'),
        entry('02_Areas/内容创作/9月/9.21.md'),
        entry('02_Areas/内容创作/空目录里没有笔记.md'),
        entry('02_Areas/每日任务/9.22.md'),
      ];
      const cfg = normalizeBoard({
        view: { shelter: false },
        sections: [{ id: 's1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      const groups = planBoard(entries , cfg, { kbRoot: KB });
      eq(groups.length, 2, '父板块 + 一个子板块（空目录不生成）');
      eq(groups[0].notes.length, 5, '父板块**递归**含子目录里的（不递归的话笔记会凭空消失）');
      eq(groups[1].title, '9月', '子板块名 = 直接子目录名');
      eq(groups[1].notes.length, 2, '子板块只含自己那棵子树');
      eq(groups[1].sub, true, '标记成子板块');
    });

    await suite.it('取数：「排除」在命中结果上做减法（路径前缀 / 任意一段前缀）', () => {
      const entries = [
        entry('02_Areas/内容创作/未锈铠.md'),
        entry('02_Areas/内容创作/9月/9.20.md'),
        entry('02_Areas/内容创作/_草稿/废弃.md'),
      ];
      const cfg = normalizeBoard({
        sections: [
          {
            id: 's1',
            name: '内容创作',
            kind: 'folder',
            value: '02_Areas/内容创作',
            exclude: ['9月', '_草稿'],
          },
        ],
      });
      const g = planBoard(entries , cfg, { kbRoot: KB })[0];
      eq(g.notes.length, 1, `排除掉两条（实际剩 ${g.notes.map((n) => n.basename).join('/')}）`);
      eq(g.excluded, 2, '被排除的条数要报出来（面板要显示）');
      ok(!g.notes.some((n) => n.basename === '9.20'), '子目录被排除后不再命中');
    });

    await suite.it('取数：「允许重复」关 = 只进第一个命中的板块；收容所吃剩下的', () => {
      const entries = [
        entry('02_Areas/内容创作/a.md', { tags: ['精选'] }),
        entry('02_Areas/内容创作/b.md'),
      ];
      const dup = normalizeBoard({
        view: { allowDuplicate: true, shelter: true },
        sections: [
          { id: 's1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 's2', name: '精选', kind: 'tag', value: '精选' },
          { id: 's3', name: '收容所', kind: 'shelter', value: '' },
        ],
      });
      const g1 = planBoard(entries, dup, { kbRoot: KB });
      eq(g1.length, 3, '允许重复：三个板块都有');
      eq(g1[1].notes.length, 1, '标签板块拿到那一条');
      eq(g1[2].notes.length, 0, '允许重复时收容所是空的（大家都被命中了）');

      const once = normalizeBoard({
        view: { allowDuplicate: false, shelter: true },
        sections: [
          { id: 's2', name: '精选', kind: 'tag', value: '精选' },
          { id: 's1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 's3', name: '收容所', kind: 'shelter', value: '' },
        ],
      });
      const g2 = planBoard(entries, once, { kbRoot: KB });
      eq(g2[0].notes.length, 1, '第一个板块拿到精选那条');
      eq(g2[1].notes.length, 1, '文件夹板块只剩没被拿走的那条');
      eq(g2[2].notes.length, 0, '两条都被命中了 → 收容所空');
    });

    await suite.it('取数：隐藏/上限只影响显示，**计数与命中登记仍按全量**', () => {
      const entries = [
        entry('02_Areas/内容创作/a.md'),
        entry('02_Areas/内容创作/b.md', { 隐藏: true }),
        entry('02_Areas/内容创作/c.md'),
      ];
      const cfg = normalizeBoard({
        view: { showHidden: false },
        sections: [{ id: 's1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', limit: 1 }],
      });
      const g = planBoard(entries , cfg, { kbRoot: KB })[0];
      eq(g.notes.length, 1, '上限 1 篇');
      eq(g.total, 2, '总数不含被隐藏的那篇（2 篇可见）');
      eq(g.limited, 1, '被上限截掉 1 篇');
      eq(g.hidden, 1, '隐藏 1 篇（板块头要显示徽标）');
      eq(g.matched.length, 3, '命中登记按**全量**（否则"允许重复关"会漏）');

      const showCfg = normalizeBoard({
        view: { showHidden: true },
        sections: [{ id: 's1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      const g2 = planBoard(entries, showCfg, { kbRoot: KB })[0];
      eq(g2.notes.length, 3, '「查看隐藏的文件」打开 → 带淡出回来');
      eq(g2.hidden, 0, '回来了就不再算隐藏');
    });

    await suite.it('取数：属性值源 → 子板块 = 每个取值（自动增删）', () => {
      // v2：拿「状态」当属性值源（发布进度已随专属字段退役）
      const entries = [
        entry('02_Areas/内容创作/a.md', { 状态: '进行中' }),
        entry('02_Areas/内容创作/b.md', { 状态: '已完成' }),
        entry('02_Areas/内容创作/c.md', { 状态: '进行中' }),
        entry('02_Areas/内容创作/d.md', {}),
      ];
      const cfg = normalizeBoard({
        sections: [{ id: 's1', name: '按状态', kind: 'prop', value: '状态' }],
      });
      const groups = planBoard(entries , cfg, { kbRoot: KB });
      eq(groups.length, 2, '两个取值 → 两个子板块');
      eq(groups.map((g) => g.title).join('|'), '进行中|已完成', '子板块名 = 取值（按名称排）');
      eq(groups[0].notes.length, 2, '同一取值的归一组');
      ok(
        groups.every((g) => !g.notes.some((n) => n.basename === 'd')),
        '没有这个属性的笔记不进任何子板块（它会落到收容所）',
      );
    });

    await suite.it('排序：手动顺序表里没有的条目**接在后面按名字排**（不会消失）', () => {
      const a = entry('00_Inbox/a.md');
      const b = entry('00_Inbox/b.md');
      const c = entry('00_Inbox/c.md');
      const sorted = sortNotes([a, b, c], { key: '手动', dir: 'asc' }, [c.path, a.path]);
      eq(sorted.map((x) => x.basename).join(''), 'cab', '顺序表里的按表来，没登记的在后面');

      const byName = sortNotes([c, a, b], { key: '名称', dir: 'asc' }, undefined);
      eq(byName.map((x) => x.basename).join(''), 'abc', '名称升序');
      const byNameDesc = sortNotes([c, a, b], { key: '名称', dir: 'desc' }, undefined);
      eq(byNameDesc.map((x) => x.basename).join(''), 'cba', '名称降序');

      const p1 = entry('00_Inbox/x.md', { 状态: '进行中' });
      const p2 = entry('00_Inbox/y.md', { 状态: '已完成' });
      const p3 = entry('00_Inbox/z.md', {});
      const byProp = sortNotes([p2, p1, p3], { key: '状态', dir: 'asc' }, undefined);
      eq(
        byProp.map((x) => x.basename).join(''),
        'xyz',
        '按属性升序，**空值永远排最后**（不随方向翻）',
      );
      const byPropDesc = sortNotes([p2, p1, p3], { key: '状态', dir: 'desc' }, undefined);
      eq(byPropDesc.map((x) => x.basename).join(''), 'yxz', '降序时空值仍在最后');
    });

    await suite.it('摘要：剥前言 + 剥尾链（含分隔线），并交出正确的行号偏移', () => {
      const full = [
        '---',
        '类型: 笔记',
        '状态: 进行中',
        '---',
        '# 未锈铠',
        '钩子还在磨。',
        '',
        '---',
        '## 关联笔记',
        '- 所属中心：[[MOC]]',
      ].join('\n');
      const r = cardBody(full, {
        stripFrontmatter: true,
        stripTail: true,
        markers: ['## 关联笔记'],
        title: '未锈铠',
      });
      ok(!r.text.includes('类型:'), '前言被剥掉');
      ok(!r.text.includes('关联笔记'), '尾链段被剥掉');
      ok(!r.text.includes('所属中心'), '尾链段的内容也没了');
      ok(!/^---/m.test(r.text.trim()), '尾链上面那条分隔线一起走（否则摘要尾巴是一根横线）');
      ok(r.text.includes('钩子还在磨。'), '正文还在');
      eq(r.text.includes('# 未锈铠'), false, '与标题同名的首个 H1 去掉（卡面标题已经写了）');
      /**
       * 🔴 **偏移量必须是 4，且行数不变**（独立审查 R1）。
       * 早先的实现是 `lines.splice(i, 1)` **删掉**那一行 —— 它后面每一行都前移 1，
       * 而 `lineOffset` 是一个标量，于是"卡面第 n 行 = 原文第 n+offset 行"当场作废：
       * 模板产出的笔记（首屏第一行就是 `# 文件名`，夹具里 17 篇是这个形状）
       * **点勾选框会写到上面那一行**。修法是把它**抹成空行**（行数不变 → 偏移量守得住）。
       */
      eq(r.lineOffset, 4, '正文第 0 行 = 原文第 4 行（前言 4 行）');
      // 「抹 H1 不改行数」：与**标题不匹配**的那一次比（自证，不写死行数）
      const noBlank = cardBody(full, {
        stripFrontmatter: true,
        stripTail: true,
        markers: ['## 关联笔记'],
        title: '别的标题',
      });
      eq(
        r.text.split('\n').length,
        noBlank.text.split('\n').length,
        '抹 H1 不改行数（只有剥两端才允许改行数）',
      );
      eq(r.text.split('\n')[0], '', 'H1 那一行被抹成空行');

      // 真形状：模板产出的笔记（H1 在正文第一行）+ 两条任务行 → 第 2 条任务的行号必须对
      const tmpl = ['---', '类型: 内容作品', '---', '# 未锈铠', '', '- [ ] 甲', '- [ ] 乙', ''].join('\n');
      const tb = cardBody(tmpl, {
        stripFrontmatter: true,
        stripTail: true,
        markers: ['## 关联笔记'],
        title: '未锈铠',
      });
      const tasks = taskItems(tb.text);
      eq(tasks.length, 2, '两条任务行都认出来了');
      eq(
        tmpl.split('\n')[tasks[1].line + tb.lineOffset],
        '- [ ] 乙',
        '卡面第 2 条任务 + lineOffset = 原文里那一行（写回靠的就是这个换算）',
      );

      // 尾部没标记：原样返回（判据不能把普通正文吃掉）
      const plain = cardBody('正文一\n正文二\n', {
        stripFrontmatter: true,
        stripTail: true,
        markers: ['## 关联笔记'],
        title: 'x',
      });
      eq(plain.text.trim(), '正文一\n正文二', '没有尾链段时不动它');
    });

    await suite.it('剥尾链：自定义标记、以及换行数不同的前言（偏移量按实际行数算）', () => {
      const full = '---\na: 1\n---\n正文\n## 我的尾巴\n不想要的\n';
      const r = cardBody(full, {
        stripFrontmatter: true,
        stripTail: true,
        markers: ['## 我的尾巴'],
        title: 'x',
      });
      eq(r.text.trim(), '正文', '自定义标记也能剥');
      eq(r.lineOffset, 3, '前言 3 行 → 偏移 3（不是写死的 4）');
      eq(stripTailSection('正文\n## 关联笔记\n- x\n', ['## 关联笔记']).trim(), '正文', '判据本身可用');
    });

    await suite.it('任务行：围栏代码块里的 `- [ ]` 不算（否则框数与行数对不上）', () => {
      const body = [
        '前情提要：',
        '- [ ] 真的任务一',
        '```',
        '- [ ] 示例里的假任务',
        '```',
        '- [x] 真的任务二',
        '',
        '  - [ ] 缩进的也算',
      ].join('\n');
      const tasks = taskItems(body);
      eq(tasks.length, 3, `只认真的三条（实际 ${tasks.length}）`);
      eq(tasks[0].line, 1, '第 1 行的行号对');
      eq(tasks[1].line, 5, '跳过代码块后行号仍然对');
      eq(tasks[1].checked, true, '已勾的读出来是勾的');
      eq(tasks[2].line, 7, '缩进的也算');
    });

    await suite.it('任务写回：**按目标态写**（幂等），不是任务行就不动', () => {
      const full = '正文\n- [ ] 一条\n- [x] 两条\n';
      eq(setTaskLine(full, 1, true).split('\n')[1], '- [x] 一条', '勾上');
      eq(setTaskLine(full, 2, false).split('\n')[2], '- [ ] 两条', '取消勾');
      eq(setTaskLine(full, 1, false), full, '本来就没勾 → 原样返回（幂等）');
      eq(setTaskLine(full, 0, true), full, '不是任务行 → 原样返回');
      eq(setTaskLine(full, 99, true), full, '越界 → 原样返回');
      // 绝对行号：正文里的第 1 行 = 原文里 offset+1 行
      const withFm = '---\na: 1\n---\n- [ ] 一条\n';
      eq(setTaskLine(withFm, 3, true).split('\n')[3], '- [x] 一条', '按绝对行号改得到');
    });

    await suite.it('插入位置：withInserted 的边界（负数/超界/已在表里）', () => {
      const a = entry('00_Inbox/a.md');
      const b = entry('00_Inbox/b.md');
      const c = entry('00_Inbox/c.md');
      eq(withInserted([a, b, c], b, 0).join('|'), [b.path, a.path, c.path].join('|'), '插到最前');
      eq(withInserted([a, b, c], a, 99).join('|'), [b.path, c.path, a.path].join('|'), '超界 → 末尾');
      eq(withInserted([a, b], c, -1).join('|'), [a.path, b.path, c.path].join('|'), '新条目追加');
    });

    /**
     * c 期（§3.5 多选与批量）的**第一层判据：纯函数**。
     * "选择集怎么算 / 框选命中谁 / 拖拽拿哪一组"全在这里定死；
     * 界面那一层（DOM 上的 `is-selected`、工具条换批量栏）另有界面用例。
     */
    await suite.it('多选：Ctrl 切一张 / Shift 取一段 / 锚点不在就退化（纯函数）', () => {
      eq(toggleSelected([], 'a').join(','), 'a', '空集合加一张');
      eq(toggleSelected(['a', 'b'], 'a').join(','), 'b', '再点一次 = 减掉');
      eq(toggleSelected(['a'], 'b').join(','), 'a,b', '没选过的 = 加上');
      const order = ['a', 'b', 'c', 'd'];
      eq(rangeSelected(order, [], 'b', 'd', false).join(','), 'b,c,d', '正着取一段');
      eq(rangeSelected(order, [], 'd', 'b', false).join(','), 'b,c,d', '倒着取同一段');
      eq(rangeSelected(order, ['a'], 'b', 'c', true).join(','), 'a,b,c', 'Ctrl+Shift = 并集');
      eq(
        rangeSelected(order, ['a'], 'zz', 'c', false).join(','),
        'c',
        '锚点不在（被删 / 被筛 / 换板块）→ 退化成"只选目标"',
      );
      eq(
        rangeSelected(order, ['a'], 'a', 'zz', false).join(','),
        'a',
        '目标不在 → **保持原样**（清空会让"选了一半全没了"更费解）',
      );
    });

    await suite.it('框选：相交即命中 / 零面积不算 / 看不见的卡片跳过（纯函数）', () => {
      const items = [
        { path: 'a', rect: { left: 0, top: 0, width: 100, height: 50 } },
        { path: 'b', rect: { left: 200, top: 0, width: 100, height: 50 } },
        // 收起板块里的卡片：`display:none` → rect 全是 0（这类必须跳过）
        { path: 'gone', rect: { left: 0, top: 0, width: 0, height: 0 } },
      ];
      eq(
        marqueeHit(items, { left: -20, top: -20, width: 60, height: 30 }).join(','),
        'a',
        '沾到一角就算命中（不要求整个卡片在框里）',
      );
      eq(
        marqueeHit(items, { left: -1, top: -1, width: 400, height: 100 }).join(','),
        'a,b',
        '全包 —— 零尺寸那个（看不见的卡片）不能跟着混进来',
      );
      eq(
        marqueeHit(items, { left: 10, top: 10, width: 0, height: 0 }).length,
        0,
        '零面积 = 没框住任何东西（在空白处点一下不该清空选择）',
      );
      eq(marqueeHit(items, { left: 500, top: 500, width: 10, height: 10 }).length, 0, '框在空白处');
    });

    await suite.it('拖哪一组：按住选中的一张 = 搬整组；按住没选中的 = 只它自己（纯函数）', () => {
      const order = ['a', 'b', 'c'];
      eq(dragSet(order, ['b', 'c'], 'b').join(','), 'b,c', '点在已选中的卡上 → 整组一起搬');
      eq(dragSet(order, ['b', 'c'], 'a').join(','), 'a', '点在没选中的卡上 → 只搬它自己');
      eq(
        dragSet(order, ['zz'], 'a').join(','),
        'a',
        '选中集里全是"已经看不见的路径" → 兜底成单张（别拖了个空）',
      );
      eq(dragSet(order, ['c'], 'c').join(','), 'c', '只选了一张 = 本来就只有一张');
      eq(
        dragSet(order, ['c', 'a'], 'a').join(','),
        'a,c',
        '整组的顺序按**显示顺序**取（按点击先后落盘会随点击次序漂）',
      );
    });

    await suite.it('整组插入：一次进一组、保持相对次序（纯函数）', () => {
      const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((p) => entry(`00_Inbox/${p}.md`));
      eq(
        withInsertedMany([a, b, c, d], [a, b], 2).join('|'),
        [c.path, d.path, a.path, b.path].join('|'),
        '摘下 a,b 之后插到第 2 位：组内相对次序保持（a 仍在 b 前）',
      );
      eq(
        withInsertedMany([a, b, c, d], [c, a], 0).join('|'),
        [c.path, a.path, b.path, d.path].join('|'),
        '跨组摘取（c 与 a）也按传入次序插',
      );
      eq(withInsertedMany([a, b], [], 1).join('|'), [a.path, b.path].join('|'), '空组 = 什么都不动');
    });

    await suite.it('normRect：反着拖也归一化（框选起手帧就是它的零尺寸特例）', () => {
      const r = normRect({ x: 100, y: 80 }, { x: 40, y: 20 });
      eq([r.left, r.top, r.width, r.height].join(','), '40,20,60,60', '右下往左上拖');
      const z = normRect({ x: 7, y: 9 }, { x: 7, y: 9 });
      eq([z.left, z.top, z.width, z.height].join(','), '7,9,0,0', '同一点 = 零尺寸');
    });

    await suite.it('onlyCollapseChanged：只有收起态变了才是 true（判据是"重绘 or 就地贴"的分水岭）', () => {
      const base = JSON.stringify({
        version: 1,
        view: { cardWidth: 240, collapsed: ['a'], openSubs: [] },
        sections: [{ id: 'a', name: '甲', kind: 'folder', value: 'x' }],
      });
      const same = JSON.stringify({
        version: 1,
        view: { cardWidth: 240, collapsed: ['a'], openSubs: [] },
        sections: [{ id: 'a', name: '甲', kind: 'folder', value: 'x' }],
      });
      eq(onlyCollapseChanged(base, same), true, '逐字节相同 → true（不退化成"永远重绘"也算不对）');
      const onlyCollapsed = JSON.stringify({
        version: 1,
        view: { cardWidth: 240, collapsed: [], openSubs: ['a'] },
        sections: [{ id: 'a', name: '甲', kind: 'folder', value: 'x' }],
      });
      eq(onlyCollapseChanged(base, onlyCollapsed), true, '只动了 collapsed / openSubs → true（就地贴）');
      const plusWidth = JSON.stringify({
        version: 1,
        view: { cardWidth: 300, collapsed: [], openSubs: ['a'] },
        sections: [{ id: 'a', name: '甲', kind: 'folder', value: 'x' }],
      });
      eq(onlyCollapseChanged(base, plusWidth), false, '连宽度也改了 → false（必须整块重绘）');
      const plusSection = JSON.stringify({
        version: 1,
        view: { cardWidth: 240, collapsed: [], openSubs: [] },
        sections: [
          { id: 'a', name: '甲', kind: 'folder', value: 'x' },
          { id: 'b', name: '乙', kind: 'folder', value: 'y' },
        ],
      });
      eq(onlyCollapseChanged(base, plusSection), false, '板块数变了 → false');
      eq(onlyCollapseChanged(base, '{ 这不是 JSON'), false, '解析不了 → false（保守那条路）');
    });

    await suite.it('落点序号：**指示线画的那个缝 == 最终落点**（同板块往前挪的差一格修掉了）', () => {
      /** 四张卡排一行，每张 90 宽、间距 10（left = 0 / 100 / 200 / 300） */
      const rect = (i: number, top = 0) => ({ left: i * 100, top, width: 90, height: 60 });
      // ① 纯判据：按 rect 比"指针在哪个缝"
      eq(slotFromRects([rect(0), rect(1), rect(2)], 30, 30), 0, '压在第一张里 → 缝 0');
      eq(slotFromRects([rect(0), rect(1), rect(2)], 95, 30), 1, '落在两张之间 → 缝 1');
      eq(slotFromRects([rect(0), rect(1), rect(2)], 500, 30), 3, '越过最后一张 → 末尾');
      eq(slotFromRects([rect(0), rect(1, 100), rect(2, 100)], 95, 30), 1, '换行：右侧空白算下一行之前');
      eq(
        slotFromRects([{ left: 0, top: 0, width: 0, height: 0 }], 10, 10),
        1,
        '量不到几何（jsdom）→ 一律末尾（不静默插到别人前面）',
      );

      // ② 真判据：拖动源**要从序号里排除**，否则往前挪差一格（P4.5 §1.1 修的）
      const holder = document.createElement('div');
      holder.className = 'kbw-cards';
      holder.dataset.drop = 'k1';
      const paths = ['X', 'A', 'B', 'C']; // X = 正在拖的那张，在最前
      paths.forEach((p, i) => {
        const d = document.createElement('div');
        d.dataset.card = '';
        d.dataset.path = p;
        Object.defineProperty(d, 'getBoundingClientRect', {
          value: () => ({ ...rect(i), right: i * 100 + 90, bottom: 60 }),
          configurable: true,
        });
        holder.appendChild(d);
      });
      document.body.appendChild(holder);
      try {
        // 指针压在 B 的左半边（B 在 DOM 第 2 位、left=200、中心 245）
        const hit = hitTest(205, 30, holder, -1, ['X']);
        eq(hit.key, 'k1', '命中了这个板块');
        eq(hit.index, 1, '序号是"排除 X 之后"的 1（老代码给 2）');
        const notes = paths.map((p) => entry(`00_Inbox/${p}.md`));
        // `withInserted` 回的是**路径**表（顺序表的形状），取回文件名好读
        const after = withInserted(notes, notes[0], hit.index).map(
          (p) => p.split('/').pop()?.replace(/\.md$/, '') ?? '',
        );
        eq(after.join(','), 'A,X,B,C', '落点就在指示线指的那个缝里（X 在 B 前面）');
        // 压在自己身上（还没拖出去）→ 还是原来那一格
        eq(hitTest(5, 30, holder, -1, ['X']).index, 0, '压着自己 → 缝 0（＝不动）');
        // 越过末尾
        eq(hitTest(9999, 30, holder, -1, ['X']).index, 3, '越过末尾 → 末尾');
      } finally {
        holder.remove();
      }
    });

    await suite.it('默认显示属性：核心项与元属性不进默认档，最多 5 个', () => {
      // v2：五件套之外的自由键拿「来源」当样本（专属字段已退役）
      const entries = [
        entry('00_Inbox/a.md', { 类型: '笔记', 状态: '进行中', tags: [], 来源: 'https://example.com', 我的键: 'x' }),
      ];
      const props = defaultPropsFor(entries);
      ok(!props.includes('类型') && !props.includes('tags') && !props.includes('创建日期'), '核心项不进默认档');
      ok(!props.includes('隐藏') && !props.includes('位置锁定'), '元属性不进默认档');
      ok(props.includes('我的键'), `真有的自定义属性要在里面：${props.join('/')}`);
      ok(props.length <= 5, `最多 5 个（实际 ${props.length}）`);
    });

    await suite.it('卡片尺寸：全局值与板块级覆盖（null = 继承）', () => {
      const cfg = normalizeBoard({
        view: { cardWidth: 300, cardHeight: 400 },
        sections: [
          { id: 's1', name: 'A', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 's2', name: 'B', kind: 'folder', value: '02_Areas/每日任务', width: 520, height: 260 },
        ],
      });
      eq(effectiveWidth(cfg, cfg.sections[0]), 300, '没覆盖 → 跟看板级');
      eq(effectiveHeight(cfg, cfg.sections[0]), 400, '没覆盖 → 跟看板级');
      eq(effectiveWidth(cfg, cfg.sections[1]), 520, '板块级覆盖宽度');
      eq(effectiveHeight(cfg, cfg.sections[1]), 260, '板块级覆盖高度');
      ok(hasOverride(cfg.sections[1]), '有覆盖 → 「重置本板块设置」可点');
      ok(!hasOverride(cfg.sections[0]), '没覆盖 → 置灰');
      // 越界的值要被夹回区间
      const bad = normalizeSection({ id: 'x', kind: 'folder', value: 'a', width: 99999, height: 5 });
      eq(bad?.width, 720, '宽度上限 720');
      eq(bad?.height, 160, '高度下限 160');
    });

    await suite.it('groupKey：板块与子板块的键稳定且不撞', () => {
      eq(groupKey('s1'), 's1', '板块键就是 id');
      eq(groupKey('s1', '9月'), 's1::9月', '子板块键带子键');
      ok(groupKey('s1', 'a') !== groupKey('s1', 'b'), '不同子板块不撞');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4 · 看板 · 真链路（卡片 / 小窗 / 勾选框 / 拖动）', async () => {
    __resetNotices();
    __resetUndo();

    await suite.it('打开看板：库里没有配置就先落一份（"谁的期谁负责第一次落盘"）', async () => {
      // 先把可能存在的配置挪走：第一次打开看板该由它落盘
      fs.rmSync(path.join(vaultRoot, BOARD_CFG), { force: true });
      app.vault.rescan();
      await openBoard();
      ok(H.maybe(document.body, '.kbw-board'), '看板模块挂上了');
      ok(await H.until(() => fs.existsSync(path.join(vaultRoot, BOARD_CFG))), '配置落盘了');
      const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
      eq(raw.version, 1, '带版本号');
      ok(raw.view && Array.isArray(raw.sections), '有 view 与 sections 两段');
      // 空看板要有引导，不是一片空白
      ok(H.maybe(document.body, '.kbw-empty'), '没有板块时给空态引导');
    });

    await suite.it('文件夹源板块：卡片数从数据里取；摘要里看不到 YAML 与尾链', async () => {
      const dir = '02_Areas/内容创作';
      const expect = ctx()
        .index.notes()
        .filter((e) => e.path.startsWith(`${KB}/${dir}/`));
      ok(expect.length > 0, `夹具里 ${dir} 得有笔记（实际 ${expect.length}）`);

      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', summaryLines: 3 },
        sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: dir }],
      });
      await H.settle(150);
      eq(cards().length, expect.length, `卡片数 = 那个目录下的笔记数（${expect.length}）`);
      eq(sections().length, 1, '一个板块');

      // 卡面：标题 + 正文摘要
      const withBody = cards().find((c) => (c.querySelector('.kbw-card-body')?.textContent ?? '').trim().length > 5);
      ok(withBody, '得有卡片带正文');
      const text = H.textOf(withBody?.querySelector('.kbw-card-body') ?? null);
      ok(!text.includes('类型:') && !text.includes('状态:'), `摘要里不该有 YAML 前言：${text.slice(0, 80)}`);
      ok(!text.includes('关联笔记'), '摘要里不该有尾链段');
      ok(!text.includes('[[') || !text.includes('所属中心'), '尾链的双链不该露出来');
      eq(text.includes('---'), false, '摘要里不该有分隔线');
    });

    await suite.it('「展开」就地长开（不跳转、不重画）', async () => {
      const card = cards().find((c) => c.querySelector('.kbw-card-more'));
      ok(card, '得有带「展开」的卡片');
      const more = card?.querySelector('.kbw-card-more') as HTMLElement;
      eq(H.textOf(more).includes('展开'), true, '初始是「展开」');
      const bodyEl = card?.querySelector('.kbw-card-body') as HTMLElement;
      eq(bodyEl.classList.contains('is-open'), false, '默认收起（3 行截断）');
      H.click(more);
      await H.settle(40);
      // ⚠️ 就地改 class：卡片本身还在文档里（重画过的话这个节点就脱了）
      eq(bodyEl.isConnected, true, '展开不该重画整块（节点还在文档里）');
      eq(bodyEl.classList.contains('is-open'), true, '长开了');
      eq(H.textOf(card?.querySelector('.kbw-card-more') ?? null).includes('收起'), true, '按钮变「收起」');
      H.click(card?.querySelector('.kbw-card-more') as Element);
      await H.settle(40);
      eq(bodyEl.classList.contains('is-open'), false, '再点收起');
    });

    await suite.it('单击卡片开悬浮小窗：真编辑器挂上了，Esc 关掉且关前会 save', async () => {
      /**
       * ⚠️ 这一节测的是**属性行的控件形态**（枚举给下拉）→ 得显式要「前 6 行」那一档：
       * C2 之后默认是 `none`（只看正文），不写就没属性块（第一版就是在这儿红的）。
       */
      await writeBoardCfg({
        version: BOARD_CONFIG_VERSION,
        view: { cardMode: 'content', panelProps: 'few' },
        sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(300);
      const card = cards()[0];
      const target = card.querySelector('.kbw-card-t') as HTMLElement;
      H.click(target);
      await H.settle(160);
      const panel = H.maybe<HTMLElement>(document.body, '.kbw-panel');
      ok(panel, '悬浮小窗出来了');
      contains(H.textOf(panel), '打开笔记', '窗里有「打开笔记」');
      // 真编辑器：桩的 markdown 视图（带 .view-header，要 CSS 藏）
      const leaf = H.maybe<HTMLElement>(panel, '.kbw-cw-editor .view-content');
      ok(leaf, '真编辑器挂进了窗里');
      ok(H.maybe(panel, '.kbw-cw-editor .view-header'), '带 .view-header（真机同样自带，靠 CSS 藏）');
      // 属性行：状态是枚举 → 下拉
      const selects = H.qa<HTMLSelectElement>(panel, '.kbw-cw-props select');
      ok(selects.length > 0, '枚举属性给的是下拉（不是手打）');

      const view = (app as unknown as { __leaves: unknown[] }).__leaves;
      const before = view.length;
      ok(before > 0, '建过一个叶');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      eq(H.maybe(document.body, '.kbw-panel'), null, 'Esc 关掉了窗');
      // 关窗必须先 save 再 detach（平台坑：detach 会丢最后几秒的输入）
      await H.settle(60);
      ok(
        !H.qa(document.body, '.kbw-cw-editor').length,
        '编辑器从 DOM 里收走了（不留悬挂的叶）',
      );
    });

    await suite.it('勾选框直写那一行（**模板形状**：正文首行就是 `# 标题`），且不弹小窗', async () => {
      /**
       * ⚠️ 造笔记要照**模板产出的形状**造：正文第一行是 `# 文件名`。
       * 早先这条用例造的是一篇"规范的假笔记"（正文首行就是正文），
       * 于是 `cardBody` 里"抹掉同名 H1"那一支**根本没走**，
       * 而行号偏移的 bug 恰好只在那一支里出错（独立审查 R1：夹具里 17 篇是这个形状）。
       * 点的是**第 2 个**框 —— 第 1 个框在 bug 下也会"静默不动作"（上一行是空行），
       * 只有第 2 个框能暴露出"改了上面那条"。
       */
      const rel = `${KB}/02_Areas/内容创作/__探针勾选.md`;
      const body = ['# __探针勾选', '', '- [ ] 第一条', '- [ ] 第二条', ''].join('\n');
      H.writeNote(vaultRoot, rel, H.note(body, { 类型: '笔记', 状态: '进行中', tags: [] }));
      app.vault.rescan();
      app.vault.trigger('modify', app.vault.getAbstractFileByPath(rel));
      await H.settleIndex(app, 240);

      const card = cards().find((c) => (c.dataset.path ?? '').endsWith('__探针勾选.md'));
      ok(card, '那张卡片出来了');
      const boxes = H.qa<HTMLInputElement>(card as Element, 'input[type="checkbox"]');
      eq(boxes.length, 2, `两个勾选框都渲染出来了（实际 ${boxes.length}）`);
      /**
       * ⚠️ 这句原先写的是「disabled 被摘掉了（真机渲染出来是 disabled 的）」——
       * **后半句是错的**：2026-09-26 真机实测，卡面里平台给出的框 `disabled` 全为 false。
       * 桩也已按真机对齐（不再预设 disabled），于是这句现在是"框是可点的"这个**结果**的断言。
       */
      eq(boxes[0].disabled, false, '框是可点的（没有 disabled）');
      eq(card?.dataset.taskMismatch, undefined, '框数与任务行数对得上（对不上会写进 data-task-mismatch）');

      const box = boxes[1]; // ← 点第二条
      box.checked = true;
      box.dispatchEvent(new Event('click', { bubbles: true }));
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settleIndex(app, 260);
      const text = H.readNote(vaultRoot, rel);
      ok(text.includes('- [ ] 第一条'), `第一条**必须原样**（点的是第二条）：\n${text}`);
      ok(text.includes('- [x] 第二条'), `第二条被勾上了：\n${text}`);
      eq(H.maybe(document.body, '.kbw-panel'), null, '勾选**不该**弹悬浮小窗');

      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 200);
    });

    await suite.it('跨板块拖动（鼠标 4px）：文件夹源 → 真搬文件 + 撤销条', async () => {
      const fromDir = '02_Areas/内容创作';
      const toDir = '02_Areas/每日任务';
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [
          { id: 's-a', name: '内容创作', kind: 'folder', value: fromDir },
          { id: 's-b', name: '每日任务', kind: 'folder', value: toDir },
        ],
      });
      await H.settle(150);
      __resetUndo();
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '这条用例开始时不该有残留药丸');

      const source = cards().find((c) => (c.dataset.path ?? '').startsWith(`${KB}/${fromDir}/`));
      ok(source, '源板块得有卡片');
      const from = source?.dataset.path ?? '';
      const holder = H.qa<HTMLElement>(document.body, '.kbw-cards').find(
        (h) => h.dataset.drop === 's-b',
      );
      ok(holder, '目标板块的放置区在');

      const grip = source?.querySelector('.kbw-card-t') as HTMLElement;
      H.pointerDown(grip, { x: 30, y: 40 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 32, y: 40 });
      await H.tick(10);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '只挪 2px 不该进拖动（鼠标阈值 4px）');
      H.pointerMove(document.body, { x: 40, y: 44 });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-dragghost'), '越过 4px → 进入拖动（有药丸）');
      H.pointerMove(holder as Element, { x: 60, y: 80 });
      await H.tick(10);
      ok(
        H.qa(document.body, '.kbw-cards').some((h) => h.dataset.drop === 's-b' && h.classList.contains('is-drop')),
        '掠过目标板块 → 高亮（data-drop 命中了）',
      );
      /**
       * P4.5 §1.1：**松手前就要看得见会落在第几张** —— 三样东西缺一不可。
       * jsdom 量不到几何 → 缝一律算末尾，这里只断言"画出来了、位置在目标区里、文案是真数"。
       */
      ok(H.maybe<HTMLElement>(holder as Element, '.kbw-dropline'), '插入位指示线画在目标区块里');
      eq(
        H.maybe<HTMLElement>(document.body, '.kbw-card.is-dragging')?.dataset.path,
        from,
        '拖动源是半透明占位（位置没有凭空消失）',
      );
      const preview = H.textOf(H.maybe<HTMLElement>(document.body, '.kbw-sect-preview'));
      const inTarget = H.qa<HTMLElement>(holder as Element, '[data-card]').length;
      eq(preview, `${inTarget} → ${inTarget + 1}`, '板块头报「现在几篇 → 放下之后几篇」');

      H.pointerUp(holder as Element, { x: 60, y: 80, buttons: 0 });
      await H.tick(20);
      eq(H.maybe<HTMLElement>(document.body, '.kbw-dropline'), null, '松手后指示线收掉');
      eq(H.maybe<HTMLElement>(document.body, '.kbw-sect-preview'), null, '松手后预告收掉');
      eq(H.maybe<HTMLElement>(document.body, '.kbw-card.is-dragging'), null, '松手后占位样式摘掉');
      await H.settleIndex(app, 320);

      const moved = ctx().index.notes().find((e) => e.basename === from.split('/').pop()?.replace(/\.md$/, ''));
      ok(moved, '那篇还在库里');
      eq(moved?.effectivePosition, toDir, '被搬到目标板块的目录了');
      ok(hasUndoBar(), '拖完出撤销条（拖拽是唯一不走确认流的动库动作）');

      // 撤销回去，别污染后面的用例
      const undoBtn = H.currentUndoButton('撤销');
      H.click(undoBtn as Element);
      await H.settleIndex(app, 320);
      eq(ctx().index.get(from)?.effectivePosition, fromDir, '撤销把文件搬回来了');
    });

    /**
     * c 期（§3.5）：**整组拖动** —— 按住已选中的一张 = 整组一起搬。
     * 这是判据三层里的**真链路**那层：两个文件真的动了，而且
     * **一次操作 = 一个快照 = 一条撤销**（撤销一次两张都回来，不是撤两次）。
     */
    await suite.it('多选（c 期）：拖整组 = 一次搬两张 + 一条撤销', async () => {
      await openBoard();
      const fromDir = '02_Areas/内容创作';
      const toDir = '02_Areas/每日任务';
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', summaryLines: 3 },
        sections: [
          { id: 's-a', name: '内容创作', kind: 'folder', value: fromDir },
          { id: 's-b', name: '每日任务', kind: 'folder', value: toDir },
        ],
      });
      await H.settle(150);
      __resetUndo();

      const srcCards = cards().filter((c) => (c.dataset.path ?? '').startsWith(`${KB}/${fromDir}/`));
      ok(srcCards.length >= 2, `源板块至少两张卡（实际 ${srcCards.length}）`);
      const [a, b] = srcCards;
      const pathA = a.dataset.path ?? '';
      const pathB = b.dataset.path ?? '';

      // ① 先选中这一组
      H.click(a, { ctrlKey: true });
      H.click(b, { ctrlKey: true });
      await H.settle(80);
      eq(H.qa<HTMLElement>(document.body, '.kbw-card.is-selected').length, 2, 'Ctrl+点选中两张');

      // ② 按住其中一张拖到目标板块
      const holder = H.qa<HTMLElement>(document.body, '.kbw-cards').find(
        (h) => h.dataset.drop === 's-b',
      );
      ok(holder, '目标板块的放置区在');
      const grip = a.querySelector('.kbw-card-t') as HTMLElement;
      H.pointerDown(grip, { x: 30, y: 40 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 40, y: 44 }); // 越过 4px 阈值 → 进拖动
      await H.tick(10);
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-card.is-dragging').length,
        2,
        '**整组**都半透明（只标起手那张会像"另外几张掉队了"）',
      );
      H.pointerMove(holder as Element, { x: 60, y: 80 });
      await H.tick(10);
      const preview = H.textOf(H.maybe<HTMLElement>(document.body, '.kbw-sect-preview'));
      const inTarget = H.qa<HTMLElement>(holder as Element, '[data-card]').length;
      eq(preview, `${inTarget} → ${inTarget + 2}`, '预告按**组的大小**加（拖两张就 +2，不是写死的 +1）');

      H.pointerUp(holder as Element, { x: 60, y: 80, buttons: 0 });
      await H.tick(20);
      await H.settleIndex(app, 320);

      /**
       * ⚠️ **按 basename 找**，不能按原路径 `get(path)` —— 搬走之后路径就变了
       * （`index.get(旧路径)` 直接 undefined，本用例第一版就栽在这）。
       * 顺带把"不唯一"也报出来：夹具里重名的话这里会立刻炸，不会静默测了个别人。
       */
      const posOf = (base: string): string | undefined => {
        const hits = ctx()
          .index.notes()
          .filter((e) => e.basename === base);
        return hits.length === 1 ? hits[0].effectivePosition : `（不唯一：${hits.length}）`;
      };
      const baseA = pathA.split('/').pop()?.replace(/\.md$/, '') ?? '';
      const baseB = pathB.split('/').pop()?.replace(/\.md$/, '') ?? '';

      eq(posOf(baseA), toDir, 'A 搬到目标目录了');
      eq(posOf(baseB), toDir, 'B 也搬了（整组一起走）');
      ok(hasUndoBar(), '拖完出撤销条');
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-undobar-wrap').length,
        1,
        '只有一条撤销条',
      );
      /**
       * ⚠️ 上面那条**独自站着是空跑断言**（c 期独立审查 🟢11）：`ui/undo-bar.ts` 每次
       * `showUndo` 都先 `purgeContainers()` 把旧的清掉 —— 哪怕 mover 被循环调 N 次也只剩一条。
       * 真正能红的是**文案里的篇数**：一次 mover 调用报「2 篇」，循环调用会变成「1 篇」。
       */
      eq(
        H.textOf(H.maybe<Element>(document.body, '.kbw-undobar-text')).includes('2 篇'),
        true,
        '撤销条要报「2 篇」（mover 被循环调的话这里会变成「1 篇」）',
      );

      // ③ 撤销**一次**，两张都回来
      const undoBtn = H.currentUndoButton('撤销');
      H.click(undoBtn as Element);
      await H.settleIndex(app, 320);
      eq(posOf(baseA), fromDir, '撤销：A 回来了');
      eq(posOf(baseB), fromDir, '撤销：B 也回来了（一次撤销管整组）');

      /**
       * ⚠️ **收干净选择**（否则后面的用例全崩）：有选择时工具条**整条是批量栏**，
       * 那些"找工具条按钮"的用例（如「收起/展开」找「全部收起」）会拿到 undefined。
       * 清法用**点 ✕**（不是模拟 Esc —— 它要走 document 捕获那条监听，桩环境里接不住）。
       */
      const clearSel = H.maybe<HTMLElement>(
        document.body,
        '.kbw-board-toolbar .kbw-batch-tail .kbw-iconbtn',
      );
      if (clearSel) {
        H.click(clearSel);
        await H.settle(80);
      }
      eq(H.qa<HTMLElement>(document.body, '.kbw-card.is-selected').length, 0, '用例收尾：选择清干净');
    });

    await suite.it('跨板块拖动（属性值源）：**真的拖一次**，改的是那个属性、不搬文件', async () => {
      await openBoard(); // ⚠️ 单跑（KBW_TEST_ONLY）时前置步不会跑，自己开
      /**
       * ⚠️ 这条用例原先名不副实：名字写着"改的是那个属性"，**用例体里一次拖动都没有**
       * （只手写了属性、断言卡片出现）。独立审查 R2 顺带发现整条路是**死代码**
       * （守卫写成 `sec.kind === 'prop' && target.sub`，而属性值源恒为顶级组）
       * —— 名字与内容不符会让人以为这块有覆盖，所以这里改成真拖。
       */
      const from = `${KB}/02_Areas/内容创作/__探针属性.md`;
      const other = `${KB}/02_Areas/内容创作/__探针属性2.md`;
      // v2：拿「状态」当属性值源（发布进度已随专属字段退役）——待拖的那篇**不写状态**
      // ⚠️ 得手写（`H.note` 的默认值会给状态种一个 进行中 —— 那就不是"没填"了）
      H.writeNote(vaultRoot, from, '---\n类型: 笔记\ntags: []\n---\n\n# 待拖的\n\n正文\n');
      // 再造一篇已经填好取值的 → 让「按状态」多出一个取值组当落点
      H.writeNote(vaultRoot, other, H.note('当落点的', { 状态: '已完成', tags: [] }));
      app.vault.rescan();
      app.vault.trigger('modify', app.vault.getAbstractFileByPath(from));
      app.vault.trigger('modify', app.vault.getAbstractFileByPath(other));
      await H.settleIndex(app, 260);

      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', allowDuplicate: true },
        sections: [{ id: 's-p', name: '按状态', kind: 'prop', value: '状态' }],
      });
      await H.settle(220);
      contains(H.textOf(document.body), '已完成', '属性值源按取值出了板块');

      const src = cards().find((c) => (c.dataset.path ?? '').endsWith('__探针属性.md'));
      ok(!src, '没填这个属性的那篇**不在**任何取值板块里（它现在没地方显示）');
      // 它不在任何板块里 → 用「整个库」板块来当拖动源：换一个配置，两板块并存
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [
          { id: 's-all', name: '整个库', kind: 'folder', value: '' },
          { id: 's-p', name: '按状态', kind: 'prop', value: '状态' },
        ],
      });
      await H.settle(320);

      const src2 = cards().find((c) => (c.dataset.path ?? '').endsWith('__探针属性.md'));
      ok(
        src2,
        [
          '源卡片在「整个库」板块里',
          `板块=${H.qa<HTMLElement>(document.body, '.kbw-sect-nm').map((n) => H.textOf(n)).join('/') || '（一块都没有）'}`,
          `卡片=${cards().length} 张`,
          `配置里的 sections=${JSON.stringify((JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8')) as { sections?: unknown[] }).sections)}`,
          `看板区文本=${(H.textOf(H.maybe(document.body, '.kbw-board-body')) || '').slice(0, 80)}`,
          `board 节点=${H.qa(document.body, '.kbw-board').length}／body 节点=${H.qa(document.body, '.kbw-board-body').length}／骨架=${H.qa(document.body, '.kbw-skel').length}／空态=${H.qa(document.body, '.kbw-empty').length}`,
          `当前模块=${ctx().store.get().activeModule}`,
        ].join('｜'),
      );
      const target = H.qa<HTMLElement>(document.body, '.kbw-cards').find(
        (h) => h.dataset.drop === 's-p::已完成',
      );
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-sect-nm').some((n) => H.textOf(n) === '已完成'),
        '「已完成」这一块要在看板上',
      );
      ok(target, `属性值板块的放置区在（实际 ${H.qa<HTMLElement>(document.body, '[data-drop]').map((x) => x.dataset.drop).join('/')}）`);

      __resetUndo();
      const grip = src2?.querySelector('.kbw-card-t') as HTMLElement;
      H.pointerDown(grip, { x: 30, y: 40 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 40, y: 44 });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-dragghost'), '越过 4px → 进入拖动（有药丸）');
      H.pointerMove(target as Element, { x: 50, y: 60 });
      await H.tick(10);
      H.pointerUp(target as Element, { x: 50, y: 60, buttons: 0 });
      await H.settleIndex(app, 320);
      ok(hasUndoBar(), '拖完出了撤销条（说明真的走到了"改属性"那条路）');
      /**
       * ⚠️ 拖放是**异步**的（拍快照 → 写盘 → metadataCache 300ms 滞后 → 索引防抖），
       * 上面那一轮 settle 只等到"撤销条出来"，索引那边还差一拍 —— 再结一次。
       */
      await H.settleIndex(app, 420);

      const moved = ctx().index.get(from);
      eq(
        moved?.props['状态'],
        '已完成',
        `拖过去之后**属性改成目标取值**了｜文件正文=
${H.readNote(vaultRoot, from)}｜索引里有这篇=${!!moved}`,
      );
      eq(moved?.effectivePosition, '02_Areas/内容创作', '文件**没搬**（属性值源只改属性）');
      ok(hasUndoBar(), '走的是快照 + 撤销条那条路');

      // 收拾：撤销 + 删两篇探针笔记
      const undoBtn = H.currentUndoButton('撤销');
      if (undoBtn) H.click(undoBtn);
      // 还原同样是异步的（读快照 → 写回 → 缓存滞后）→ 两轮 settle
      await H.settleIndex(app, 420);
      await H.settleIndex(app, 320);
      eq(ctx().index.get(from)?.props['状态'], undefined, '撤销把属性改回去了');

      for (const p of [from, other]) fs.rmSync(path.join(vaultRoot, p), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 240);
    });

    await suite.it('文件夹源 =「整个库」（空值）：画得出来、卡片是全库（不是静默丢板块）', async () => {
      await openBoard(); // ⚠️ 单跑（KBW_TEST_ONLY）时前置步不会跑，自己开
      // 独立审查 R5：面板的第一项候选就是"整个库"，而存储层原先把它当"没配完"丢掉
      await writeBoardCfg({
        version: 1,
        view: {},
        sections: [{ id: 's-all', name: '整个库', kind: 'folder', value: '' }],
      });
      await H.settle(240);
      // 「整个库」会把每个顶层目录也生成一个子板块（§4.1 的子板块规则）——所以只断言"画出来了"
      ok(sections().length >= 1, `板块画出来了（不是被静默丢掉）：${sections().length} 块`);
      contains(H.textOf(sections()[0]), '整个库', '名字在');
      const total = ctx().index.notes().length;
      ok(cards().length > 0, `卡片出来了（全库 ${total} 篇）`);
    });

    await suite.it('子板块：板块目录下有子目录时**画出来**（默认收起 + 展开）', async () => {
      await openBoard(); // ⚠️ 单跑（KBW_TEST_ONLY）时前置步不会跑，自己开
      // 独立审查 R6：子板块原先只活在取数层，界面被 filter(!sub) 整批丢掉
      const dir = '02_Areas/内容创作';
      const sub = `${dir}/__探针子目录`;
      H.writeNote(vaultRoot, `${KB}/${sub}/甲.md`, H.note('# 甲\n正文', { tags: [] }));
      H.writeNote(vaultRoot, `${KB}/${sub}/乙.md`, H.note('# 乙\n正文', { tags: [] }));
      app.vault.rescan();
      app.vault.trigger('modify', app.vault.getAbstractFileByPath(`${KB}/${sub}/甲.md`));
      await H.settleIndex(app, 260);

      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 's-c', name: '内容创作', kind: 'folder', value: dir }],
      });
      await H.settle(240);
      const heads = H.qa<HTMLElement>(document.body, '.kbw-sect');
      eq(heads.length, 2, `父板块 + 子板块都画出来了（实际 ${heads.length}）`);
      const subHead = heads.find((h) => h.classList.contains('is-sub'));
      ok(subHead, '子板块那一行带 is-sub（缩进 + 竖参考线靠它）');
      contains(H.textOf(subHead as Element), '__探针子目录', '子板块名 = 子目录名');
      eq(
        (subHead as HTMLElement).querySelector('.kbw-cards'),
        null,
        '子板块**默认收起**（没画卡片区）',
      );
      // 点它自己的三角 → 摊开（展开态落在 openSubs 里，与顶级板块的 collapsed 相反）
      H.click((subHead as HTMLElement).querySelector('.kbw-sect-caret') as Element);
      await H.settle(220);
      const again = H.qa<HTMLElement>(document.body, '.kbw-sect').find((h) => h.classList.contains('is-sub'));
      ok(again?.querySelector('.kbw-cards'), '点一下就摊开了');
      ok(
        await H.until(() => {
          const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
          return Array.isArray(raw.view?.openSubs) && raw.view.openSubs.length > 0;
        }),
        '展开态落进了配置的 openSubs（防抖 400ms）',
      );

      fs.rmSync(path.join(vaultRoot, `${KB}/${sub}`), { recursive: true, force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 240);
    });

    await suite.it('收起/展开 = **就地切 class**（不重绘卡片：量渲染次数 + 节点还是那个节点）', async () => {
    await openBoard(); // ⚠️ 单跑（KBW_TEST_ONLY）时前置步不会跑，自己开
    /**
     * 这条测的是用户报的「全部展开/收起有时候慢」：根因是**整块重绘** ——
     * 每张卡片的正文都要重走一遍 MarkdownRenderer（异步），43 篇就是几十次。
     * 判据只能用**渲染次数**：DOM 可以重建得一模一样（节点连不连着、文字对不对都看不出）。
     */
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', collapsed: [] },
      sections: [
        { id: 'cv-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
        { id: 'cv-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务' },
      ],
    });
    await H.settle(300);
    const toolBtn = (label: string): HTMLElement | undefined =>
      H.qa<HTMLElement>(document.body, '.kbw-board-toolbar .kbw-btn').find((b) =>
        H.textOf(b).includes(label),
      );
    ok(sections().length >= 2, `板块画出来了（${sections().length} 块）`);
    ok(cards().length > 0, `卡片出来了（${cards().length} 张）`);
    const first = cards()[0];
    /**
     * ⚠️ 取基准前**先等"渲染次数 + 第一张卡片的节点"双双稳定**：
     * `paintBoard` 是异步的（先读正文再建卡片），上一个用例遗留的那一轮可能**还没开始**呢 ——
     * 只看计数会漏掉"即将到来"的那一轮，它落在断言窗口里就是假红（负载下实测会漂）。
     * 节点也不动了才算真静默（那一轮会整块重建 DOM）。
     */
    const quiet = async (): Promise<void> => {
      let lastCalls = -1;
      let lastFirst: HTMLElement | null = null;
      for (let i = 0; i < 25; i += 1) {
        const stable = lastCalls === MarkdownRenderer.calls && lastFirst === (cards()[0] ?? null);
        lastCalls = MarkdownRenderer.calls;
        lastFirst = cards()[0] ?? null;
        if (stable) return;
        await H.settle(80);
      }
    };
    /**
     * ⚠️ **先把每一块的卡片区都建出来**（点一次全部展开），再取基准 ——
     * 不然"展开也是零渲染"这条会依赖"这些目录下没有子目录"这个**夹具形状**：
     * 哪天 `02_Areas/内容创作` 里多一个子目录，全部展开就会为那个子板块**合法地**建卡片区、
     * 多出 N 次渲染 → 用例红，而红的原因与代码对不对无关（CLAUDE.md 那条"夹具一换断言就假红"）。
     * 先把该建的都建完，后面两轮收起/展开就必然零渲染（与有几个子目录无关）。
     */
    H.click(toolBtn('全部展开') as Element);
    await H.settle(300);
    await quiet();
    const base = MarkdownRenderer.calls;

    // ① 全部收起：卡片区留着但藏起来，一次渲染都不许再来
    H.click(toolBtn('全部收起') as Element);
    await H.settle(260);
    await quiet();
    eq(MarkdownRenderer.calls, base, '收起：没有重渲染任何正文');
    eq(sections().every((s) => s.classList.contains('is-collapsed')), true, '板块都带上了 is-collapsed');
    eq(
      sections().every((s) => s.querySelector('.kbw-cards') != null),
      true,
      '卡片区留在 DOM 里（展开才是瞬时的）',
    );
    eq(cards()[0] === first, true, '还是同一批卡片节点（没重建）');
    ok(
      await H.until(() => {
        const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
        return Array.isArray(raw.view?.collapsed) && raw.view.collapsed.length === 2;
      }),
      '收起态落进了配置（防抖 400ms）',
    );

    // ② 全部展开：仍然零渲染，节点还是原来那个
    H.click(toolBtn('全部展开') as Element);
    await H.settle(260);
    await quiet();
    eq(MarkdownRenderer.calls, base, '展开：也没有重渲染');
    eq(sections().every((s) => !s.classList.contains('is-collapsed')), true, 'is-collapsed 都摘掉了');
    eq(cards()[0] === first, true, '还是同一批卡片节点');

    // ③ 单个板块的三角：这条路以前也是整块重绘
    const caret = (): Element => sections()[0].querySelector('.kbw-sect-caret') as Element;
    H.click(caret());
    await H.settle(220);
    await quiet();
    eq(MarkdownRenderer.calls, base, '点三角收起：零渲染');
    eq(sections()[0].classList.contains('is-collapsed'), true, '第一块收起了');
    eq(H.textOf(sections()[0].querySelector('.kbw-sect-n')), H.textOf(sections()[0].querySelector('.kbw-sect-n')), '计数行还在');
    H.click(caret());
    await H.settle(220);
    await quiet();
    eq(MarkdownRenderer.calls, base, '再点一次展开：仍然零渲染');
    eq(sections()[0].classList.contains('is-collapsed'), false, '又展开了');
    eq(cards()[0] === first, true, '来回了两次，卡片还是同一批节点');
    /**
     * ⚠️ 等防抖那一下**落完**再往下走：收起态是 400ms 防抖落盘的，
     * 不等它写完就去写新配置 → 那一下会把刚写好的配置**覆盖回去**（步骤互相污染，
     * 与真机探针那条「库内配置让步骤互相污染」同一个坑）。
     */
    ok(
      await H.until(() => {
        const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
        return Array.isArray(raw.view?.collapsed) && raw.view.collapsed.length === 0;
      }),
      '收起态的防抖落盘先落完（免得覆盖下面那份配置）',
    );

    // ④ 首屏（重新进看板）就收起的板块：**不为看不见的卡片读正文**；
    //    展开时只补它自己那一块，别的卡片一根汗毛都不动
    const aCards = (): HTMLElement[] =>
      H.qa<HTMLElement>(document.body, '[data-drop="cv-a"] [data-card]');
    const bCards = (): HTMLElement[] =>
      H.qa<HTMLElement>(document.body, '[data-drop="cv-b"] [data-card]');
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', collapsed: ['cv-b'] },
      sections: [
        { id: 'cv-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
        { id: 'cv-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务' },
      ],
    });
    await H.settle(260);
    // 走的是"就地"那条：卡片区**留着**（只是 CSS 藏起来）—— 与"首屏没建"是两件事，都要有人管
    eq(
      sections().find((s) => s.dataset.key === 'cv-b')?.classList.contains('is-collapsed'),
      true,
      '就地收起',
    );
    ok(bCards().length > 0, '收起时卡片区留着（展开才是瞬时的）');

    // 重新进一次看板 = 真"首屏"：这时才该懒建（此前一直是"进来看板就渲染全部正文"）
    ctx().goNotes();
    await H.settle(200);
    await openBoard();
    await H.settle(320);
    eq(bCards().length, 0, '首屏就收起的那块：卡片区没建（不为看不见的卡片读正文）');
    ok(aCards().length > 0, '另一块照常');
    const aFirst = aCards()[0];
    await quiet();
    const beforeExpand = MarkdownRenderer.calls;
    const bSect = sections().find((s) => s.dataset.key === 'cv-b') as HTMLElement;
    H.click(bSect.querySelector('.kbw-sect-caret') as Element);
    await H.settle(280);
    await quiet();
    ok(bCards().length > 0, `只补了这一块（${bCards().length} 张）`);
    eq(
      MarkdownRenderer.calls - beforeExpand,
      bCards().length,
      '渲染次数 == 这一块的卡片数（多了就说明整块重绘了）',
    );
    eq(aCards()[0] === aFirst, true, '另一块的卡片没被重建');
  });

    /**
     * c 期（§3.5）：**多选的界面那一层** —— 只看 DOM 上看得见的三件事：
     * `is-selected` 贴没贴上、工具条有没有**整条**换成批量栏、✕ 能不能清干净。
     *（"选择集怎么算"那些判据在纯函数那几条，这里不重复。）
     */
    await suite.it('多选（c 期）：Ctrl 加/减选 · Shift 取段 · 批量栏顶上工具条 · ✕ 清空', async () => {
      // ⚠️ 自己准备数据：`KBW_TEST_ONLY` 单跑时前置步不会跑（与本文件里那几条同规矩）
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', summaryLines: 3 },
        sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await openBoard();
      await H.settle(320);
      const cards = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-card');
      const selected = (): number =>
        H.qa<HTMLElement>(document.body, '.kbw-card.is-selected').length;
      const batchCount = (): HTMLElement | null =>
        H.maybe<HTMLElement>(document.body, '.kbw-board-toolbar .kbw-batch-count');
      const clearBtn = (): HTMLElement | null =>
        H.maybe<HTMLElement>(document.body, '.kbw-board-toolbar .kbw-batch-tail .kbw-iconbtn');

      const all = cards();
      ok(all.length >= 3, `至少三张卡才谈得上多选（实际 ${all.length}）`);
      eq(selected(), 0, '一开始没有选择');
      eq(batchCount(), null, '没选择时工具条就是工具条，不带批量栏');

      H.click(all[0], { ctrlKey: true });
      await H.settle(80);
      eq(selected(), 1, 'Ctrl+单击选中一张');
      eq(
        H.textOf(batchCount() as Element).includes('已选 1 篇'),
        true,
        '工具条整条换成了批量栏（§3.4 的口径）',
      );

      H.click(all[1], { ctrlKey: true });
      await H.settle(80);
      eq(selected(), 2, '再加一张');
      eq(H.textOf(batchCount() as Element).includes('已选 2 篇'), true, '计数跟着走（不是停在 1）');

      H.click(all[1], { ctrlKey: true });
      await H.settle(80);
      eq(selected(), 1, '再点同一张 = 减掉');

      // 锚点此刻在 all[1]，Shift 点到 all[2] → 那一段两张
      H.click(all[2], { shiftKey: true });
      await H.settle(80);
      eq(selected(), 2, 'Shift 从锚点取一段');

      H.click(clearBtn() as Element);
      await H.settle(120);
      eq(selected(), 0, '✕ 清空选择');
      eq(batchCount(), null, '批量栏收掉');
      ok(gearBtn(), '齿轮也回来了（工具条真的还原了）');
    });

    /**
     * 单击卡片那条路（**不带修饰键**）：开悬浮小窗 **且清空选择**。
     * 这是用户 2026-09-25 拍板的（Windows 资源管理器惯例）——
     * 防的是"以为在处理新点开的那张、其实批量操作还作用在旧选择上"。
     */
    await suite.it('多选（c 期）：不带修饰键的单击 = 开窗 + 清空选择', async () => {
      // 同样自己准备数据（单跑时前置步不跑）
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', summaryLines: 3 },
        sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await openBoard();
      await H.settle(320);
      const selected = (): number =>
        H.qa<HTMLElement>(document.body, '.kbw-card.is-selected').length;
      const all = H.qa<HTMLElement>(document.body, '.kbw-card');
      ok(all.length >= 3, `至少三张卡（实际 ${all.length}）`);
      H.click(all[0], { ctrlKey: true });
      H.click(all[1], { ctrlKey: true });
      await H.settle(80);
      eq(selected(), 2, '先选中两张');

      H.click(all[2]);
      await H.settle(160);
      ok(H.maybe<HTMLElement>(document.body, '.kbw-panel'), '小窗开出来了');
      eq(selected(), 0, '单击开窗时**顺手清空选择**（不让旧选择留在背后）');

      // 收干净，别把状态漏给下一条用例
      H.keydown(document.body, 'Escape');
      await H.settle(160);
      closeAllMenus();
    });

  // ── 段⑤（2026-09-28）：触屏「选择模式 → ⋯」那条欠账 ──────────────
  /**
   * §4.2 表里「单篇设置」那一行的第二条路：**触屏没有右键** —— 单篇菜单只能从
   * 「长按 400ms → 选择模式 → 点那张卡的 ⋯」进，否则重命名 / 位置锁定 / 在新窗口打开
   * 在触屏上全都够不着。与网格档（§3.5）**同一组常数、同一条容差**：
   * 长按 400ms 不动 = 选择模式；长按之后移动 > 10px = 改判成拖动。
   */
  await suite.it('触屏长按 400ms 不动 → 进选择模式 · 卡片冒出 ⋯ · ⋯ 与右键是**同一份菜单**', async () => {
    // 自己准备数据（`KBW_TEST_ONLY` 单跑时前置步不会跑，与本文件其它用例同规矩）
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', summaryLines: 3 },
      sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    await openBoard();
    await H.settle(320);

    const cards = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-card');
    const selCount = (): number => H.qa<HTMLElement>(document.body, '.kbw-card.is-selected').length;
    /** 选择模式的判据看**类名**（不进渲染 key，所以只能这么认） */
    const inSelectMode = (): boolean => cards().some((c) => c.classList.contains('is-selectmode'));

    const all = cards();
    ok(all.length >= 3, `至少三张卡才谈得上选择模式（实际 ${all.length}）`);
    const before = all.map((c) => c.dataset.path ?? '');
    eq(inSelectMode(), false, '一开始不在选择模式');
    eq(selCount(), 0, '一开始没有选择');

    /**
     * 🔴 **起手先把 Esc 分层栈收干净**（`dispatchEscape` **只问栈顶**）。
     *
     * 为什么必须自己收：前面几组用例（「全部笔记」的筛选下拉、设置面板）**结束时留着浮层**
     * —— 实测这一条跑起来时栈上是 `board:clear-transient > modal:工作台设置 > multiselect-dropdown`。
     * 那样的话"按一下 Esc"弹掉的是**别人留下的那一层**，判据以"Esc 没生效"的样子红，
     * 真因却在几十条之前。第一版就是这么红的：单跑全绿、全量 33 条红
     *（我的用例没退出选择模式 → 后面每一条"点卡片开小窗"的用例都变成了"切换选中"）。
     * 这是**用例自己的起手清场**（与探针每一步开头那个 `P.closeAll()` 同一条纪律），
     * 不是把断言放宽 —— 收完之后栈仍然是空的才算过。
     */
    for (let i = 0; i < 6 && __escapeLabels().length > 0; i += 1) {
      H.keydown(document.body, 'Escape');
      await H.settle(40);
    }
    ok(
      __escapeLabels().length === 0,
      `起手时 Esc 栈该能收干净（实际还剩：${__escapeLabels().join(' > ') || '空'}）`,
    );

    /**
     * **早退也清场**（CLAUDE.md 那条纪律）：断言中途抛掉时，绝不许把"选择模式"留给下一条用例 ——
     * 它会静默地把后面每一条"点卡片开小窗"的用例变成"切换选中"（第一版 33 条级联假红的真因）。
     * 清场走的是**实现自己的出口**（点看板空白处），不是直接改 store。
     */
    const cleanup = async (): Promise<void> => {
      closeAllMenus();
      const body = H.q<HTMLElement>(document.body, '.kbw-board-body');
      if (body) H.click(body);
      await H.settle(60);
    };

    try {
      H.pointerDown(all[0], { x: 40, y: 40, pointerType: 'touch' });
      // ⚠️ 采样点围着常量取（写死的话阈值改成任何值都会绿 —— 网格那条踩过）
      await H.tick(LONG_PRESS_MS - 60);
      eq(inSelectMode(), false, `还没到 ${LONG_PRESS_MS}ms：不该进选择模式`);
      await H.tick(120);
      eq(inSelectMode(), true, '长按成立 → 进选择模式');
      eq(selCount(), 1, '长按那一张**并进**选择（不是"只选它"，也不是把它取消）');

      H.pointerUp(all[0], { x: 40, y: 40, pointerType: 'touch', buttons: 0 });
      await H.settle(240); // 等过 wasDraggingRecently 的 150ms 窗口
      eq(cards().map((c) => c.dataset.path ?? '').join(','), before.join(','), '长按不动就松手：卡片顺序没动');
      eq(inSelectMode(), true, '仍停在选择模式（松手之后才逐个点）');

      // ① ⋯ 出来了
      const moreBtn = cards()[0].querySelector<HTMLElement>('.kbw-card-morebtn');
      ok(moreBtn, '选择模式下卡片上有 ⋯');

      // ② 点它 → 菜单；条目与右键那份**逐字相同**（"别另写一份"这条纪律的判据）
      const items = (): string[] =>
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').map((x) => H.textOf(x));
      H.click(moreBtn as Element);
      await H.settle(80);
      const viaMore = items();
      ok(viaMore.length > 0, `⋯ 点得出菜单（${viaMore.slice(0, 6).join(' / ')}…）`);
      closeAllMenus();
      await H.settle(80);
      eq(items().length, 0, '菜单收干净了（别挡着后面那一次）');

      cards()[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
      );
      await H.settle(80);
      const viaRight = items();
      ok(viaRight.length > 0, '右键也弹得出菜单');
      eq(viaMore.join('|'), viaRight.join('|'), '两条入口弹的是**同一份**菜单（同一份实现）');
      closeAllMenus();
      await H.settle(80);

      // ③ 选择模式下点一张 = 加选 / 再点 = 减选（不是开窗）
      H.click(cards()[1]);
      await H.settle(80);
      eq(selCount(), 2, '选择模式下点一张 = 加选');
      eq(H.maybe(document.body, '.kbw-panel'), null, '选择模式下点卡片**不开窗**');
      H.click(cards()[1]);
      await H.settle(80);
      eq(selCount(), 1, '再点同一张 = 减选');

      // ④ Esc：模式与选择一起退（走 Esc 分层栈那条路 —— Esc 不走 keymap.bind）
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      eq(inSelectMode(), false, `Esc 退出选择模式（栈=${__escapeLabels().join('>') || '空'}）`);
      eq(selCount(), 0, `Esc 同时清空选择（栈=${__escapeLabels().join('>') || '空'}）`);
    } finally {
      await cleanup();
    }
  });

  await suite.it('触屏长按后移动 > 10px → 改判成拖动（不是选择模式）', async () => {
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', summaryLines: 3 },
      sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    await openBoard();
    await H.settle(320);
    const cards = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-card');
    const inSelectMode = (): boolean => cards().some((c) => c.classList.contains('is-selectmode'));

    const all = cards();
    ok(all.length >= 2, `至少两张卡（实际 ${all.length}）`);
    const from = all[0].dataset.path ?? '';
    // 目标：**它自己那一块的放置区**（拖回原位 → 什么都不写，不污染后面的用例）
    const holder = H.qa<HTMLElement>(document.body, '.kbw-cards').find(
      (h) => h.querySelector(`[data-path="${from}"]`) != null,
    );
    ok(holder, '找得到这张卡所在板块的放置区');

    /** 早退也清场（同上一条用例的理由：绝不许把"选择模式"留给后面那些用例） */
    const cleanup = async (): Promise<void> => {
      closeAllMenus();
      const body = H.q<HTMLElement>(document.body, '.kbw-board-body');
      if (body) H.click(body);
      await H.settle(60);
    };

    try {
      H.pointerDown(all[0], { x: 40, y: 40, pointerType: 'touch' });
      await H.tick(LONG_PRESS_MS + 80);
      eq(inSelectMode(), true, '先按长按成立进选择模式');
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '长按期间**没有**药丸（还没决定是选择还是拖动）');

      // 超过 10px 容差 → 这一下是拖动
      H.pointerMove(holder as Element, { x: 160, y: 120, pointerType: 'touch' });
      await H.tick(20);
      eq(inSelectMode(), false, '真的动了 → 退出选择模式（§4.2 那条容差）');
      ok(H.maybe(document.body, '.kbw-dragghost'), '有跟着光标走的药丸（真的进了拖动这条路）');

      H.pointerUp(holder as Element, { x: 40, y: 40, pointerType: 'touch', buttons: 0 });
      await H.settle(160);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '松手后药丸收掉');
      eq(cards().length, all.length, '卡片数没变（拖回原位不搬东西）');
      /**
       * 🔴 **松手之后要等"防抖那一笔写盘"落地**（`saveSoon` 是 400ms）。
       *
       * 为什么（2026-09-28 实测出来的）：同板块落点会写**顺序表**，而 jsdom 没有几何
       *（所有 rect 都是 0）→ 落点算出来是"末尾"，所以"拖回原位"在这里**并不是空操作**，
       * 它会写一笔 `manualOrder`。那一笔要是没落地就往下走，**几百毫秒后它会把
       * 下一条用例刚写进去的 `看板配置.json` 盖掉**（那一组就是"b · 属性和正文之间的分隔条"
       * 假红：盘上 cardMode 明明是 both，报出来却是 content）。
       * 这一条与项目里那条"写盘走防抖、判据要等它"是同一件事，只是这次踩的是**跨用例**的脚。
       */
      await H.settle(520);
    } finally {
      await cleanup();
    }
  });

  /**
   * 只读模式**只挡拖、不挡整条手势**（P6⑤ 独立审查 A3 修的那条）。
   * 触屏上「选择模式 → 点 ⋯」是单篇菜单**唯一**的入口，而"在新标签页/新悬浮窗打开"
   * 这类动作在只读下本来就该可用（§8.1 只禁**改**）。所以：还能进选择模式，但**拖动作废**
   *（不建药丸、松手不写顺序表）。
   */
  await suite.it('只读模式下：触屏长按仍能进选择模式（⋯ 单篇菜单），但**拖动作废**（不写顺序表）', async () => {
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', summaryLines: 3, readonly: true },
      sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    await openBoard();
    await H.settle(340);
    const cards = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-card');
    const inSelectMode = (): boolean => cards().some((c) => c.classList.contains('is-selectmode'));
    const all = cards();
    ok(all.length >= 2, `至少两张卡（实际 ${all.length}）`);
    ok(H.maybe(document.body, '.kbw-card-morebtn'), '只读下卡片上也有 ⋯（菜单入口不能在只读里消失）');

    const cfgBefore = fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8');
    const cleanup = async (): Promise<void> => {
      closeAllMenus();
      const body = H.q<HTMLElement>(document.body, '.kbw-board-body');
      if (body) H.click(body);
      await H.settle(60);
    };
    try {
      H.pointerDown(all[0], { x: 40, y: 40, pointerType: 'touch' });
      await H.tick(LONG_PRESS_MS + 80);
      eq(inSelectMode(), true, '只读下长按照样进选择模式');

      H.pointerMove(document.body, { x: 160, y: 120, pointerType: 'touch' });
      await H.tick(20);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '**没有药丸**（只读下这一拖作废）');
      H.pointerUp(document.body, { x: 160, y: 120, pointerType: 'touch', buttons: 0 });
      await H.settle(600); // 等过顺序表的 400ms 防抖窗口：有写的话这里就能看出来
      eq(
        fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'),
        cfgBefore,
        '只读下拖完**配置文件一个字节都没动**（顺序表也不许写）',
      );
    } finally {
      await cleanup();
    }
  });

  // ── b 期：列形态 + 竖条折叠（2026-09-25）──────────────────────
  await suite.it('b · 形态：缺省 = 列、显式流式留着、不认识的值回落（view.flow 只增不改）', () => {
    eq(normalizeBoard({ view: {} }).view.flow, 'columns', '缺省就是列（Q4 拍板：列默认）');
    eq(normalizeBoard({ view: { flow: 'flow' } }).view.flow, 'flow', '显式流式要原样留着');
    eq(normalizeBoard({ view: { flow: '列' } }).view.flow, 'columns', '不认识的值回落到默认，不炸');
    // 老配置（P4 写的那些，压根没有 flow 这个键）读进来必须还是好好的
    const old = normalizeBoard({ view: { cardWidth: 300, cardHeight: 0 } }).view;
    eq(old.flow, 'columns', '老配置没有 flow → 列（升级不用迁移）');
    eq(old.cardWidth, 300, '顺带确认老字段一个没丢');
  });

  await suite.it('b · 落点算法认得"纵向堆"：列形态按上下半分前后（横向那条老口径不变）', () => {
    /** 三张卡摆成**一行**（宽 240 高 100，间隔 12）与**一列**（往下摆），只有轴不同 */
    const row: SlotRect[] = [0, 252, 504].map((left) => ({ left, top: 0, width: 240, height: 100 }));
    const col: SlotRect[] = [0, 112, 224].map((top) => ({ left: 0, top, width: 240, height: 100 }));
    eq(cardsAxis(row), 'x', '一行三张 = 横向排');
    eq(cardsAxis(col), 'y', '一列三张 = 纵向堆');
    eq(cardsAxis([]), 'x', '空 → 判不出来，回落横向');
    eq(cardsAxis([col[0]]), 'x', '只有一张、又没给容器宽（jsdom 没布局）→ 回落横向（老口径）');
    /**
     * **只剩一张卡**的时候（独立审查 🟡4）：列形态下"目标列只有一张卡"与"两张卡互拖"
     * 都会走到这儿，回落横向就等于把"落点跟着鼠标左右走"放回来了。
     * 判据是几何：卡片填满容器内容宽 → 纵向堆。
     */
    eq(cardsAxis([col[0]], 240), 'y', '单卡填满容器（列形态）→ 纵向堆');
    eq(cardsAxis([row[0]], 1000), 'x', '单卡比容器窄得多（流式）→ 横向');
    eq(cardsAxis([row[0]], 0), 'x', '容器宽量不到 → 回落横向（离线/未布局，与老口径一致）');

    // 纵向落点：指针在卡片中心线之上 → 插它前面；之下 → 插它后面
    eq(slotFromRects(col, 120, 10, 4, 'y'), 0, '偏上 → 插到第 1 张前');
    eq(slotFromRects(col, 120, 70, 4, 'y'), 1, '偏下 → 插到第 1 张后');
    /**
     * 🔴 **纵向的落点不许跟鼠标的左右位置有关**（这条是这次改的真问题）：
     * 横向那条老口径在"卡片中心 ±rowTol"的窄带里用 `cx > x` 分左右 ——
     * 套到纵向堆上，同一条横向缝隙会**因为鼠标往右挪 1px 就换落点**。
     */
    eq(
      slotFromRects(col, 10, 70, 4, 'y'),
      slotFromRects(col, 230, 70, 4, 'y'),
      '纵向：鼠标在同一列里偏左还是偏右，落点必须一样',
    );
    // 横向的老口径原样（同一行里比左右）——别被上面那条改坏了
    eq(slotFromRects(row, 10, 50, 4, 'x'), 0, '横向：第 1 张左半边 → 插它前');
    eq(slotFromRects(row, 250, 50, 4, 'x'), 1, '横向：跨过第 1 张中心 → 插它后');
  });

  await suite.it('b · 属性和正文之间的分隔条：两者档才有、比例夹在 15%–85%、null = 自动', async () => {
    // 纯函数：归一化
    eq(normalizeBoard({ view: { propsRatio: 0.4 } }).view.propsRatio, 0.4, '正常值原样留着');
    eq(normalizeBoard({ view: { propsRatio: 2 } }).view.propsRatio, 0.85, '超上限夹到 0.85');
    eq(normalizeBoard({ view: { propsRatio: -1 } }).view.propsRatio, 0.15, '超下限夹到 0.15');
    eq(normalizeBoard({ view: { propsRatio: 'x' } }).view.propsRatio, null, '非法值 → 自动');
    eq(normalizeBoard({ view: {} }).view.propsRatio, null, '缺省 → 自动（老配置不用迁移）');
    // 真链路：两者档的卡片里有分隔条、只内容档没有
    await openBoard();
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'both', flow: 'columns', propsRatio: 0.4 },
      sections: [{ id: 'b-split', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    /**
     * ⚠️ **等"现象"出现，别等一个写死的毫秒数**（2026-09-28 修）：
     * 这之前是 `await H.settle(340)`，而看板的绘制是**异步两段式**的（先读正文再画）——
     * 340ms 在机器忙的时候不够，于是卡片还是**上一档残留的那一批**：
     * `ok(card, '两者档画出了卡片')` 被旧卡片满足（它看不出档位），紧接着找 `.kbw-card-split`
     * 就红成"选择器没命中"，看着像功能坏了。实测全量跑里会偶发（连着两轮红了一次）。
     * 判据不变（真没画出来照样红）—— 只是把"等"换成等那个类出现。
     */
    // ⚠️ 谓词里必须用 `H.maybe`（不抛），`H.q` 找不到会**抛** —— 那样 `until` 直接炸，
    // 轮询一次都跑不到（第一版就是这么红的）
    const painted = await H.until(
      () => H.maybe(document.body, '.kbw-card.is-split') != null,
      2000,
    );
    await H.settle(60); // 让这一趟画完（DOM 引用别取到半成品）
    const card = cards()[0];
    ok(card, `两者档画出了卡片（卡片数=${cards().length}）`);
    /**
     * ⚠️ 用 `H.maybe` + 带诊断的 `ok`，**别用会抛的 `H.q`** —— 抛出来的话失败信息里
     * 只有一句"选择器没命中"，看不出"卡片当时是哪一档、盘上配置是什么"
     *（CLAUDE.md：夹具的前提不成立时要把诊断一起报出来）。
     */
    const split = H.maybe<HTMLElement>(card, '.kbw-card-split');
    ok(
      split,
      `两者档的卡片里要有分隔条（等 is-split=${painted}；卡片 class=${card.className}` +
        `；模块=${ctx().store.get().activeModule}` +
        `；盘上 cardMode=${
          ((await ctx().configs.read('board')) as { view?: { cardMode?: string } })?.view?.cardMode
        }）`,
    );
    eq(split?.getAttribute('role'), 'separator', '分隔条是 separator 角色（可达性）');
    eq(split?.getAttribute('tabindex'), '0', '可聚焦 —— 键盘也能调（拖拽要有非拖拽等价物）');
    eq(card.classList.contains('is-split'), true, '有比例 → 卡片带 is-split');
    eq(card.style.getPropertyValue('--kbw-props-pct'), '40%', '比例落到 CSS 变量上');
    /**
     * 🔴 **拖过分隔条之后那一发 click 不许开小窗**（用户 2026-09-25："
     * 拖动调整属性和内容占比后，会识别成普通的左键单击，打开小窗"）。
     * 分隔条没走 `startPointerDrag` 基元 → 它在松手时要自己 `markDragEnded()`，
     * 否则卡片的单击处理器会把这发 click 收下。
     */
    H.pointerDown(split, { x: 20, y: 2 });
    await H.tick(10);
    H.pointerMove(document.body, { x: 24, y: 40 });
    await H.tick(10);
    H.pointerUp(document.body, { x: 24, y: 40, buttons: 0 });
    await H.tick(10);
    H.click(card);
    await H.settle(150);
    eq(H.maybe(document.body, '.kbw-panel'), null, '拖完分隔条之后那一发 click 不开小窗');

    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', flow: 'columns' },
      sections: [{ id: 'b-split', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    await H.settle(340);
    eq(H.maybe(cards()[0], '.kbw-card-split'), null, '只内容档不该有分隔条（没东西可分隔）');
  });

  await suite.it('b · 小窗：居中弹出 · 属性默认只铺 6 行 · 两个显示设置（藏 YAML / 只读预览）', async () => {
    const openWindow = async (view: Record<string, unknown>): Promise<HTMLElement> => {
      await openBoard();
      /**
       * ⚠️ 写 **v2**（当前格式）：v1 文件里的 `panelProps: 'few'` 会被一次性迁移
       * 当成"旧默认"吃掉（见 `migrateLegacyView`）—— 这一条要测的是"few 这档好使"，
       * 就得按**用户真的选过**那个版本号写。
       */
      await writeBoardCfg({
        version: BOARD_CONFIG_VERSION,
        view: { cardMode: 'content', flow: 'columns', ...view },
        sections: [{ id: 'b-panel', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(340);
      const card = cards()[0];
      ok(card, '有卡片');
      H.click(H.q<HTMLElement>(card, '.kbw-card-t'));
      await H.settle(160);
      const panel = H.maybe<HTMLElement>(document.body, '.kbw-panel');
      ok(panel, '小窗开了');
      return panel;
    };
    const closeWindow = async (): Promise<void> => {
      H.keydown(document.body, 'Escape');
      await H.settle(120);
      eq(H.maybe(document.body, '.kbw-panel'), null, 'Esc 关掉');
    };

    /**
     * ① 顶部居中弹出（**C2 之后**：不写 `panelProps` 就是新默认 `none` = 只看正文）。
     * 口径见 `core/config-files.ts` 的 `BOARD_VIEW_DEFAULTS.panelProps` —— 用户 2026-09-27 拍板。
     */
    const p0 = await openWindow({ cardMode: 'both' });
    eq(
      (p0 as HTMLElement).style.getPropertyValue('--kbw-origin'),
      '50% 0',
      '顶部居中弹出：从**顶边中间**长出来（用户第二版口径："在被点那一列的顶部"）',
    );
    ok((p0 as HTMLElement).style.left !== '' && (p0 as HTMLElement).style.top !== '', '位置算过了（left/top 落值）');
    eq(H.maybe(p0, '.kbw-cw-props'), null, 'C2 默认：属性块整块不画（只看正文）');
    ok(H.maybe(p0, '.kbw-cw-editor'), '正文那块还在');
    await closeWindow();

    // ①b 「前 6 行」这一档仍然好使（只是不再是默认）
    const p1 = await openWindow({ cardMode: 'both', panelProps: 'few' });
    const rows = H.qa<HTMLElement>(p1, '.kbw-cw-props .kbw-cw-row');
    ok(rows.length > 0 && rows.length <= 6, `「前 6 行」档只铺前 6 行（实际 ${rows.length}）`);
    const more = H.maybe<HTMLElement>(p1, '.kbw-cw-more');
    if (more) {
      contains(H.textOf(more), '显示全部属性', '有「显示全部属性」的入口');
      H.click(more);
      await H.settle(80);
      ok(
        H.qa<HTMLElement>(p1, '.kbw-cw-props .kbw-cw-row').length > rows.length,
        '点它就地把剩下的铺出来（不重开窗）',
      );
    }
    await closeWindow();

    // ② 设置：属性 none（= 藏 YAML 头那块 UI）+ 正文 preview（= 只读渲染、剥前言与尾链）
    const p2 = await openWindow({ cardMode: 'both', panelProps: 'none', panelContent: 'preview' });
    eq(H.maybe(p2, '.kbw-cw-props'), null, 'panelProps=none → 属性区整块不显示');
    eq(H.maybe(p2, '.kbw-cw-editor .view-content'), null, 'preview 档不挂真编辑器');
    const prev = H.maybe<HTMLElement>(p2, '.kbw-cw-editor');
    ok(prev, '有预览容器');
    const prevText = H.textOf(prev);
    ok(prevText.length > 0, `预览渲染出了正文（实际 ${prevText.length} 字）`);
    // ⚠️ 剥前言走的是卡片摘要那一份口径 → 预览里不该出现 YAML 键
    ok(!/类型\s*:/.test(prevText), '预览里看不到 YAML（前言被剥掉了）');
    await closeWindow();

    // ③ 设置：正文 none（只看属性）
    const p3 = await openWindow({ cardMode: 'both', panelContent: 'none' });
    eq(H.maybe(p3, '.kbw-cw-editor'), null, 'panelContent=none → 正文区整块不显示');
    await closeWindow();
    // 收尾：拨回默认，别给后面的用例留状态
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', flow: 'columns' },
      sections: [{ id: 'b-panel', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    await H.settle(240);
  });

  await suite.it('b · 改形态**必须走整块重绘**：onlyCollapseChanged 不许把它当成"只改了收起态"', () => {
    const base = { sections: [], view: { flow: 'columns', collapsed: ['s1'] } };
    const other = { sections: [], view: { flow: 'flow', collapsed: ['s1'] } };
    eq(
      onlyCollapseChanged(JSON.stringify(base), JSON.stringify(other)),
      false,
      '形态变了 → **不是**"只有收起态变了"（否则切形态只就地贴、界面不换）',
    );
    // 对照：只有收起态变 → true（这是 a 期的判据，别被上面那条带坏）
    eq(
      onlyCollapseChanged(JSON.stringify(base), JSON.stringify({ sections: [], view: { flow: 'columns', collapsed: [] } })),
      true,
      '只有 collapsed 变 → 就地贴，不重绘（§1.2 的优化还在）',
    );
  });

  await suite.it('b · 列形态：宿主带 is-cols、板块上也有 --kbw-card-w（列宽 = 卡片宽度）', async () => {
    await openBoard();
    const board = H.q<HTMLElement>(document.body, '.kbw-board');
    const withFlow = (flow: 'columns' | 'flow'): unknown => ({
      version: 1,
      view: { cardMode: 'content', flow },
      sections: [{ id: 'b-cols', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    await writeBoardCfg(withFlow('columns'));
    await H.settle(260);
    eq(board.classList.contains('is-cols'), true, '列形态：宿主上有 is-cols');
    const sect = sections().find((s) => s.dataset.key === 'b-cols') as HTMLElement;
    ok(sect, '板块画出来了');
    /**
     * 列宽靠板块上的这个变量算（列不是 `.kbw-cards` 的后代，读不到卡片区那份内联变量）。
     * ⚠️ 首屏就收起的板块**不建卡片区**，所以它也必须能拿到 —— 这正是变量要放在板块上的原因。
     */
    eq(sect.style.getPropertyValue('--kbw-card-w'), '240px', '板块上也有 --kbw-card-w');
    await writeBoardCfg(withFlow('flow'));
    await H.settle(260);
    eq(board.classList.contains('is-cols'), false, '切流式 → 摘掉 is-cols');
    await writeBoardCfg(withFlow('columns'));
    await H.settle(200);
  });

  await suite.it('b · 收起态不能被"整块重绘"吃掉类名（同时改别的字段时的真机 bug）', async () => {
    await openBoard();
    const sec = [{ id: 'b-repaint', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', flow: 'columns', cardHeight: 0, collapsed: [] },
      sections: sec,
    });
    await H.settle(320);
    /**
     * 关键：这一笔**同时**改了 `cardHeight` 与 `collapsed` —— `onlyCollapseChanged` 判成 false
     * → 走**整块重绘**（`cfgRev++`）→ 重绘那条路必须自己把 `is-collapsed` 贴上。
     * （只改 collapsed 时走的是"就地贴"那条路，所以以前测不出来 ✗）
     */
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', flow: 'columns', cardHeight: 300, collapsed: ['b-repaint'] },
      sections: sec,
    });
    await H.settle(360);
    const sect = sections().find((s) => s.dataset.key === 'b-repaint') as HTMLElement;
    ok(sect, '重绘之后板块还在');
    eq(sect.classList.contains('is-collapsed'), true, '整块重绘之后**类名也得在**（否则列形态下竖条不出现）');
    ok(H.maybe(sect, '.kbw-cards') === null, '收起态不建卡片区（这条是老行为，一并钉住）');
    // 收尾：别把收起态留给后面的用例
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', flow: 'columns', collapsed: [] },
      sections: sec,
    });
    await H.settle(240);
  });

  await suite.it('b · 竖条档：收起留一条真 `<button>` 竖条，点它展开**不重绘**（节点还是那些）', async () => {
    await openBoard();
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', flow: 'columns', collapsed: [] },
      sections: [{ id: 'b-rail', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    await H.settle(320);
    const sect = sections().find((s) => s.dataset.key === 'b-rail') as HTMLElement;
    ok(sect, '板块画出来了');
    const cards = H.q<HTMLElement>(sect, '.kbw-cards');
    ok(cards, '展开态有卡片区');
    const body0 = cards.querySelector('.kbw-card-body')?.firstElementChild ?? null;
    ok(body0, '正文渲染出来了（否则下面那句"节点没变"是空跑）');

    H.click(H.q(sect, '.kbw-sect-caret') as Element);
    await H.settle(220);
    eq(sect.classList.contains('is-collapsed'), true, '点三角收起了');
    ok(H.q(sect, '.kbw-cards'), '卡片区**仍在 DOM 里**（就地切 class，不是删掉）');

    const rail = H.q<HTMLElement>(sect, '.kbw-sect-rail');
    ok(rail, '竖条挂在板块头上');
    eq(rail.tagName, 'BUTTON', '是真 `<button>` —— 键盘 Enter/Space 的原生激活白送（a 期欠的可达性别再欠）');
    contains(H.textOf(rail), '内容创作', '竖排名字就是板块名');
    ok(/\d/.test(H.textOf(rail)), `竖条上有计数（实际「${H.textOf(rail)}」）`);

    H.click(rail);
    await H.settle(260);
    eq(sect.classList.contains('is-collapsed'), false, '点一下竖条就展开');
    eq(body0.isConnected, true, '展开后正文还是**原来那个节点**（走的是就地贴，没有整块重绘）');
    // 收尾：别把收起态留给后面的用例
    await writeBoardCfg({
      version: 1,
      view: { cardMode: 'content', collapsed: [] },
      sections: [{ id: 'b-rail', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
    });
    await H.settle(200);
  });

  await suite.it('卡片尺寸：全局高度生效（正文填满 + 不画「展开」）· 板块级宽度覆盖', async () => {
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', cardWidth: 260, cardHeight: 420 },
        sections: [{ id: 's-c', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(240);
      const holder = H.q<HTMLElement>(document.body, '.kbw-cards');
      eq(holder.style.getPropertyValue('--kbw-card-w'), '260px', '宽度从全局来');
      eq(holder.style.getPropertyValue('--kbw-card-h'), '420px', '高度从全局来');
      ok(holder.classList.contains('has-h'), '固定高度那一档带 has-h（CSS 靠它把正文切成"填满+可滚"）');
      eq(
        H.qa<HTMLElement>(holder, '.kbw-card-more').length,
        0,
        '固定高度时不画「展开」（正文已经填满，没东西可展）',
      );

      // 板块级覆盖：第二块用不同的宽高
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', cardWidth: 260, cardHeight: 420 },
        sections: [
          { id: 's-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 's-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务', width: 520, height: 200 },
          { id: 's-d', name: '灵感杂记', kind: 'folder', value: '02_Areas/灵感杂记', height: null },
        ],
      });
      await H.settle(240);
      const holders = H.qa<HTMLElement>(document.body, '.kbw-cards');
      const a = holders.find((x) => x.dataset.drop === 's-a') as HTMLElement;
      const b = holders.find((x) => x.dataset.drop === 's-b') as HTMLElement;
      eq(a.style.getPropertyValue('--kbw-card-w'), '260px', 'A 跟看板级');
      eq(b.style.getPropertyValue('--kbw-card-w'), '520px', 'B 用板块级覆盖的宽度');
      eq(b.style.getPropertyValue('--kbw-card-h'), '200px', 'B 用板块级覆盖的高度');
      // ⚠️ 板块级**没有"自动"这一档**：`height: null` = 继承看板级（这里是 420）
      const d = holders.find((x) => x.dataset.drop === 's-d') as HTMLElement;
      eq(d.style.getPropertyValue('--kbw-card-h'), '420px', '没覆盖高度的板块跟看板级');
    });

    await suite.it('Ctrl+滚轮缩放卡片：界面立刻变、配置防抖落盘', async () => {
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', cardWidth: 300, cardHeight: 0 },
        sections: [{ id: 's-c', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(240);
      const body = H.q<HTMLElement>(document.body, '.kbw-board-body');
      const wheel = (deltaY: number, ctrl: boolean): WheelEvent => {
        const evt = new WheelEvent('wheel', { deltaY, ctrlKey: ctrl, bubbles: true, cancelable: true });
        body.dispatchEvent(evt);
        return evt;
      };
      // 不按 Ctrl：不该缩放（那是给看板滚动用的）
      const plain = wheel(-120, false);
      await H.tick(20);
      eq(
        H.q<HTMLElement>(document.body, '.kbw-cards').style.getPropertyValue('--kbw-card-w'),
        '300px',
        '不按 Ctrl 时不缩放',
      );
      eq(plain.defaultPrevented, false, '不按 Ctrl 的滚轮不该被吞');

      const zoomIn = wheel(-120, true);
      await H.tick(20);
      eq(
        H.q<HTMLElement>(document.body, '.kbw-cards').style.getPropertyValue('--kbw-card-w'),
        '320px',
        'Ctrl+滚轮上滚 → 加一档（界面立刻变）',
      );
      eq(zoomIn.defaultPrevented, true, 'Ctrl+滚轮要 preventDefault（否则平台把整个界面一起缩放）');
      wheel(-120, true);
      wheel(-120, true);
      await H.tick(20);
      eq(
        H.q<HTMLElement>(document.body, '.kbw-cards').style.getPropertyValue('--kbw-card-w'),
        '360px',
        '连滚三格累计（不是每次都从配置重新算）',
      );
      // 防抖 300ms 后落盘
      ok(
        await H.until(() => {
          const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
          return raw.view?.cardWidth === 360;
        }, 1500),
        '缩放后的宽度落进配置（防抖，不是每滚一格写一次盘）',
      );
      /**
       * **高度也要跟着变**（用户 2026-09-25 补的那条）：
       * 自动高度档在第一次缩放时锁成固定高度（基准＝当时渲染出来的**最高**那张卡）。
       * ⚠️ jsdom 量不到真实高度（全是 0）→ 这里断言的是**行为契约**：
       * 固定高度那一档出现在配置里、`has-h` 加上、回执报「W × H」；
       * 真机上"量到的基准"由探针那一步管。
       */
      ok(
        await H.until(() => {
          const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
          return typeof raw.view?.cardHeight === 'number' && raw.view.cardHeight > 0;
        }, 1500),
        '自动高度档缩放之后 → 配置里出现固定高度（不再停在 0）',
      );
      eq(
        H.q<HTMLElement>(document.body, '.kbw-cards').classList.contains('has-h'),
        true,
        '卡片区就地带上 has-h（正文切成"填满 + 内部滚动"，不必等重绘）',
      );

      // 反面：本来就有固定高度时，按同一比例缩放（不是重新量）
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', cardWidth: 300, cardHeight: 400 },
        sections: [{ id: 's-c', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(240);
      wheel(-120, true);
      await H.tick(20);
      const holder2 = H.q<HTMLElement>(document.body, '.kbw-cards');
      eq(holder2.style.getPropertyValue('--kbw-card-w'), '320px', '宽 300 → 320');
      ok(
        /^4\d\dpx$/.test(holder2.style.getPropertyValue('--kbw-card-h')),
        `固定高度按同一比例缩放（300→320 时 400 → ${holder2.style.getPropertyValue('--kbw-card-h')}）`,
      );
      // 收尾：拨回默认，别影响后面的用例
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 's-c', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(200);
    });

    await suite.it('「允许重复」关 + 有上限：被截掉的那篇**不会**又出现在下一个板块', async () => {
      await openBoard(); // ⚠️ 单跑（KBW_TEST_ONLY）时前置步不会跑，自己开
      /**
       * 独立审查 M3：把 `sources.ts` 里的命中登记从 `g.matched` 换回 `g.notes`（就是注释
       * 明写"不能这么写"的那个回归），**全量用例照样全绿** —— 也就是说这条不变量
       * 原先只在 `makeGroup` 的字段层被断言过，跨板块那一层没人守。
       * 这里补的就是跨板块那一层：第一篇板块有上限，被截掉的那篇必须**仍然算命中过**。
       */
      const dir = '02_Areas/内容创作';
      const names = ['__探针顺序A.md', '__探针顺序B.md'];
      for (const n of names) {
        H.writeNote(vaultRoot, `${KB}/${dir}/${n}`, H.note('# x\n正文', { tags: [] }));
        app.vault.trigger('modify', app.vault.getAbstractFileByPath(`${KB}/${dir}/${n}`));
      }
      app.vault.rescan();
      await H.settleIndex(app, 260);

      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', allowDuplicate: false, shelter: true },
        sections: [
          { id: 's-a', name: '窄的', kind: 'folder', value: dir, limit: 1 },
          { id: 's-b', name: '收容所', kind: 'shelter', value: '' },
        ],
      });
      await H.settle(240);
      const shelter = H.qa<HTMLElement>(document.body, '.kbw-sect').find((s) =>
        H.textOf(s).includes('收容所'),
      );
      const inShelter = H.qa<HTMLElement>(shelter ?? document.body, '[data-card]').map(
        (c) => c.dataset.path ?? '',
      );
      ok(
        names.every((n) => !inShelter.some((p) => p.endsWith(n))),
        `被第一个板块命中的笔记（含被上限截掉的）都不该落进收容所：${inShelter.join('/')}`,
      );

      for (const n of names) fs.rmSync(path.join(vaultRoot, `${KB}/${dir}/${n}`), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 240);
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4 · 看板 · 界面（板块管理 / 三套菜单 / 只读）', async () => {
    __resetNotices();

    await suite.it('a.5-1 拖完那一发 click 被吞掉；拖回原位**一个字节都不写**', async () => {
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [
          {
            id: 'a5-a',
            name: '内容创作',
            kind: 'folder',
            value: '02_Areas/内容创作',
            sort: { key: '名称', dir: 'asc' },
          },
        ],
      });
      await H.settle(280);
      const mine = H.qa<HTMLElement>(document.body, '[data-drop="a5-a"] [data-card]');
      ok(mine.length >= 2, `得有卡片可拖（实际 ${mine.length}）`);

      // ① 对照：普通单击**要**开窗（证明第 ② 步的"不开"不是因为别的原因）
      H.click(mine[0]);
      await H.settle(200);
      ok(H.maybe(document.body, '.kbw-panel'), '对照：普通单击照旧开悬浮小窗');
      H.keydown(document.body, 'Escape');
      await H.settle(200);

      /**
       * ② 拖出去再拖回来，松手后浏览器会补一发 click —— 必须被吞。
       * ⚠️ 卡片**要现取**：上面开窗/关窗会触发一次 repaint（`refresh()` → `repaint()`），
       * 早先抓在手里的那批节点已经脱离文档 —— 往脱离文档的节点派 pointerup **不会冒泡到 document**，
       * 于是 document 上的收手指令永远收不到（用例就是这么假红了三次）。
       */
      const live = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '[data-drop="a5-a"] [data-card]');
      const last = live()[live().length - 1];
      const holder = H.q<HTMLElement>(document.body, '[data-drop="a5-a"]');
      H.pointerDown(last, { x: 40, y: 40 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 70, y: 44 });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-dragghost'), '越过 4px → 进了拖动');
      /**
       * ⚠️ 松手点选**列表末尾**（拖出去再拖回来那种"回到原位"的最接近模拟）：
       * jsdom 里 `getBoundingClientRect` 被统一桩成 200×100 同坐标（`scripts/test.mjs`），
       * 按真机那样"松手回原处"会被算成"插到第一张之前"——那是桩的几何，不是逻辑。
       * 判据本身一样：这一张本来就是最后一张 → 顺序没变 → 一个字节都不该写。
       */
      // ⚠️ 落点看的是**最后一次 pointermove** 的坐标（拖拽基元用 ctx.x/y），不是 pointerup 的
      H.pointerMove(holder, { x: 300, y: 500 });
      await H.tick(10);
      H.pointerUp(holder, { x: 300, y: 500, buttons: 0 });
      await H.tick(10);
      // jsdom 不会自己补 click，这里**手工补上**，模拟真机行为（它就是那一发让人误开窗的 click）
      const panelBefore = H.qa(document.body, '.kbw-panel').length;
      eq(panelBefore, 0, '补这一发 click 之前：一个浮层都没有（第 ① 步那个已经关干净了）');
      H.click(last);
      await H.settle(200);
      eq(
        H.qa(document.body, '.kbw-panel').length,
        0,
        `拖动之后补的那一发 click 被吞（不开窗）—— 实际浮层 ${H.qa(document.body, '.kbw-panel').length} 个`,
      );

      /**
       * ③ 拖回原位 = **什么都不写**：最后一张拖到"末尾"就是它原来的位置，
       * 顺序没变 → 不该写顺序表、更不该把这一块悄悄切成「手动」档
       *（用户报的"我什么都没改，排序却变成手动了 / 卡片跳了一下"）。
       */
      ok(
        await H.until(() => {
          const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
          const sec = (raw.sections ?? []).find((s: { id: string }) => s.id === 'a5-a');
          return sec?.sort?.key === '名称' && !raw.view?.manualOrder?.['a5-a'];
        }, 1200),
        `拖回原位之后：排序仍是「名称」、顺序表里没有这一块（没写盘）—— 实际 ${JSON.stringify(
          (() => {
            const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
            const sec = (raw.sections ?? []).find((s: { id: string }) => s.id === 'a5-a');
            return { sort: sec?.sort ?? null, manualOrder: raw.view?.manualOrder ?? null };
          })(),
        )}`,
      );
    });

    await suite.it('a.5-4 任务清单按**条数**截（嵌套子项算一条）；展开能看全', async () => {
      await openBoard();
      const rel = `02_Areas/内容创作/__探针任务A5.md`;
      // 5 条顶级任务，其中两条带子项（子项跟着父项算一条）
      H.writeNote(
        vaultRoot,
        `${KB}/${rel}`,
        H.note(
          '# 任务\n\n- [ ] 甲\n    - [ ] 甲-1\n    - [ ] 甲-2\n- [ ] 乙\n    - [ ] 乙-1\n- [ ] 丙\n- [ ] 丁\n- [ ] 戊\n',
          { 类型: '任务' },
        ),
      );
      app.vault.rescan();
      app.vault.trigger('modify', app.vault.getAbstractFileByPath(`${KB}/${rel}`));
      await H.settleIndex(app, 260);
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', summaryLines: 3 },
        sections: [{ id: 'a5-t', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(320);

      const card = cards().find((c) => (c.dataset.path ?? '').includes('__探针任务A5')) as HTMLElement;
      ok(card, '任务清单那张卡片出来了');
      await H.until(() => !!card.querySelector('.kbw-card-body ul'), 1500);
      const body = card.querySelector('.kbw-card-body') as HTMLElement;
      eq(body.classList.contains('is-list-body'), true, '正文被标成"清单卡"（行截断让位给条数）');
      /**
       * ⚠️ **桩把缩进拍平了**（`renderMiniMarkdown` 不建嵌套 `<ul>`），所以这里量到的
       * 是"8 条平铺、按条数藏掉后 5 条"——**嵌套子项跟着父项算一条**那条规则桩验不了，
       * 由下面手搭 DOM 的纯断言 + 真机探针管（真机的渲染器才建嵌套列表）。
       */
      const over = H.qa<HTMLElement>(body, '.kbw-li-over');
      eq(over.length, 5, `按条数（3）藏掉多出来的 5 条：丁/戊/甲-1/甲-2/乙-1 实际 ${over.length}`);
      eq(
        H.qa<HTMLElement>(body, 'li').length - over.length,
        3,
        '折叠态可见的 li = 8 - 5 = 3（摘要条数）',
      );
      eq(card.dataset.taskMismatch, undefined, '勾选框与任务行仍然一一对应（标记不动 DOM 数量）');
      // 展开（就地切 class）→ 被标记的那些不再藏（CSS 管可见性，这里断言机制）
      H.click(H.q<HTMLElement>(card, '.kbw-card-more'));
      await H.settle(120);
      eq(body.classList.contains('is-open'), true, '展开后 is-open 在正文上（CSS 据此放开被标记的项）');
      fs.rmSync(path.join(vaultRoot, `${KB}/${rel}`), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 240);
    });

    await suite.it('a.5-4c **固定高度档不做条数截**（那一档没有「展开」，藏了就真回不来）', async () => {
      await openBoard();
      const rel = `02_Areas/内容创作/__探针固定高任务.md`;
      H.writeNote(
        vaultRoot,
        `${KB}/${rel}`,
        H.note(
          ['# 任务', '', '- [ ] 甲', '- [ ] 乙', '- [ ] 丙', '- [ ] 丁', '- [ ] 戊', ''].join('\n'),
          {},
        ),
      );
      app.vault.rescan();
      app.vault.trigger('modify', app.vault.getAbstractFileByPath(`${KB}/${rel}`));
      await H.settleIndex(app, 260);
      await writeBoardCfg({
        version: 1,
        // 固定高度（非 0）→ 那一档"正文填满 + 内部可滚"，**不画展开条**
        view: { cardMode: 'content', summaryLines: 3, cardHeight: 300 },
        sections: [{ id: 'a5f', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(320);
      const card = cards().find((c) => (c.dataset.path ?? '').includes('__探针固定高任务')) as HTMLElement;
      ok(card, '卡片出来了');
      await H.until(() => !!card.querySelector('.kbw-card-body li'), 1500);
      eq(
        H.qa<HTMLElement>(card, '.kbw-li-over').length,
        0,
        '固定高度档**一条都不许藏**（独立审查 🔴1：那一档没有「展开」，display:none 回不来）',
      );
      eq(H.maybe(card, '.kbw-card-more'), null, '这一档本来就不画「展开」（对照组）');
      fs.rmSync(path.join(vaultRoot, `${KB}/${rel}`), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 240);
    });

    await suite.it('a.5-1b 写顺序表要写**命中全集**（有「显示上限」时不许把没显示的挤掉）', async () => {
      await openBoard();
      const dir = '02_Areas/内容创作';
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', collapsed: [] },
        // 上限 2：屏幕上只看得到 2 张，但这一块**命中** 6 篇
        sections: [
          { id: 'a5l', name: '内容创作', kind: 'folder', value: dir, limit: 2, sort: { key: '名称', dir: 'asc' } },
        ],
      });
      await H.settle(320);
      const shown = H.qa<HTMLElement>(document.body, '[data-drop="a5l"] [data-card]');
      eq(shown.length, 2, `上限生效：只看得到 2 张（实际 ${shown.length}）`);
      const matched = ctx()
        .index.notes()
        .filter((e) => (e.path ?? '').startsWith(`${KB}/${dir}/`)).length;
      ok(matched > shown.length, `这一块命中 ${matched} 篇（比显示的多，才有得验）`);

      const firstShown = shown[0];
      H.pointerDown(firstShown, { x: 40, y: 40 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 70, y: 44 });
      await H.tick(10);
      const holder = H.q<HTMLElement>(document.body, '[data-drop="a5l"]');
      H.pointerMove(holder, { x: 300, y: 500 });
      await H.tick(10);
      H.pointerUp(holder, { x: 300, y: 500, buttons: 0 });
      await H.tick(20);
      ok(
        await H.until(() => {
          const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
          const list = raw.view?.manualOrder?.['a5l'];
          return Array.isArray(list) && list.length >= matched;
        }, 1600),
        `顺序表里要有**命中全集**（≥${matched} 条）—— 只写看得见的那几条的话，` +
          `用户一放开上限，没显示的会按名称排到末尾（看着就是"跳走"）`,
      );
    });

    await suite.it('a.5-1a「刚拖过」的窗口只罩住那一发 click，**不许漏到用户的下一次点击**', async () => {
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'a5w', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(300);
      const mine = H.qa<HTMLElement>(document.body, '[data-drop="a5w"] [data-card]');
      ok(mine.length >= 1, '得有卡片');
      eq(wasDraggingRecently(), false, '没拖过的时候窗口是关着的（别把正常点击也吞了）');
      H.pointerDown(mine[0], { x: 40, y: 40 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 80, y: 44 });
      await H.tick(10);
      H.pointerUp(mine[0], { x: 80, y: 44, buttons: 0 });
      await H.tick(20);
      eq(wasDraggingRecently(), true, '拖完的那一瞬间窗口是开着的（浏览器补的那一发就该被吞）');
      await H.settle(300);
      eq(wasDraggingRecently(), false, '窗口很短：过一会儿必须恢复，否则"点一下没反应"');
      /**
       * ⚠️ **收尾清场**（这条用例做过一次真实拖动，会留下两样跨用例生效的东西）：
       *  ① 顺序表 400ms 防抖落盘 —— 不等它落完，那一笔会**跑到后面某个用例里写盘**；
       *  ② 拖动留下的临时态（光标 / 回执）—— 用一次 Esc 清干净。
       * （实测：不清的话全量套件会在**迁移**那条用例上偶发 90s 超时，挂点还游走。）
       */
      await H.settle(600);
      H.keydown(H.q(document.body, '.kbw-root'), 'Escape');
      await H.settle(200);
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'a5w', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(200);
    });

    await suite.it('a.6 载入期保留名字：loading 档渲染「读正文中…」而不是「（还没有正文）」', async () => {
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'a6-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(280);
      const entry = ctx().index.notes()[0];
      ok(entry, '索引里有笔记');
      const view = normalizeBoard({ view: { cardMode: 'content' } }).view;
      const card = renderCard(
        {
          ctx: ctx(),
          view,
          entry,
          text: '',
          loading: true,
          cardMode: 'content',
          props: [],
          expanded: false,
          component: new Component() as unknown as CardComponent,
        },
        {
          onClick: () => undefined,
          onContextMenu: () => undefined,
          onOpenTab: () => undefined,
          onDoubleClick: () => undefined,
          onPointerDown: () => undefined,
          onToggleTask: () => undefined,
          onExpand: () => undefined,
        },
      );
      eq(H.textOf(card.querySelector('.kbw-card-t')), entry.basename, '标题就是文件名（载入期也有）');
      contains(H.textOf(card.querySelector('.kbw-card-body')), '读正文中', '正文位置写「读正文中…」');
      const card2 = renderCard(
        {
          ctx: ctx(),
          view,
          entry,
          text: '',
          cardMode: 'content',
          props: [],
          expanded: false,
          component: new Component() as unknown as CardComponent,
        },
        {
          onClick: () => undefined,
          onContextMenu: () => undefined,
          onOpenTab: () => undefined,
          onDoubleClick: () => undefined,
          onPointerDown: () => undefined,
          onToggleTask: () => undefined,
          onExpand: () => undefined,
        },
      );
      contains(H.textOf(card2.querySelector('.kbw-card-body')), '还没有正文', '真没正文时才说「还没有正文」');
    });

    await suite.it('a.5-4b applyListBudget 纯断言：**嵌套子项跟着父项算一条**（手搭 DOM）', () => {
      const host = document.createElement('div');
      // 3 条顶级：甲（带 2 个子项）/ 乙（带 1 个）/ 丙，再加 丁、戊
      host.innerHTML =
        '<ul>' +
        '<li class="task-list-item">甲<ul><li>甲-1</li><li>甲-2</li></ul></li>' +
        '<li class="task-list-item">乙<ul><li>乙-1</li></ul></li>' +
        '<li class="task-list-item">丙</li>' +
        '<li class="task-list-item">丁</li>' +
        '<li class="task-list-item">戊</li>' +
        '</ul>';
      document.body.appendChild(host);
      try {
        const marked = applyListBudget(host, 3);
        eq(marked, 2, '超额的顶级只有 2 条（丁、戊）——子项不算独立条目');
        eq(host.classList.contains('is-list-body'), true, '标记了"这是清单卡"');
        eq(host.querySelectorAll('.kbw-li-over').length, 2, '子项没被单独标记（它们在父 li 里，父藏了它们就藏了）');
        const first = host.querySelector('li') as HTMLElement;
        eq(first.classList.contains('kbw-li-over'), false, '第 1 条（甲）不藏');
        // 幂等：再跑一遍不该改变结论（渲染可能重入）
        eq(applyListBudget(host, 3), 2, '重复调用结论一致');
        // 预算比条目多 → 一个都不藏
        const host2 = document.createElement('div');
        host2.innerHTML = '<ul><li>a</li><li>b</li></ul>';
        document.body.appendChild(host2);
        eq(applyListBudget(host2, 9), 0, '预算够大 → 一条都不藏');
        host2.remove();
      } finally {
        host.remove();
      }
    });

    await suite.it('a.5-2/3 面板头能拖；悬浮小窗开着时源卡片带「编辑中」标记', async () => {
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'a5-m', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(280);
      const first = cards()[0];
      ok(first, '有卡片');
      const path = first.dataset.path ?? '';
      const cardNow = (): HTMLElement | undefined =>
        cards().find((c) => c.dataset.path === path);

      // 「编辑中」标记
      H.click(H.q<HTMLElement>(first, '.kbw-card-t'));
      await H.settle(240);
      ok(H.maybe(document.body, '.kbw-panel'), '小窗开了');
      eq(
        cardNow()?.classList.contains('is-editing-source'),
        true,
        '源卡片带 is-editing-source（滚看板时靠它认人）',
      );
      H.keydown(document.body, 'Escape');
      await H.settle(300);
      eq(cardNow()?.classList.contains('is-editing-source'), false, '关窗后标记摘掉');

      // 面板头可拖（板块管理面板）
      const gear = gearBtn();
      ok(gear, '工具条上那个齿轮按钮在（按 lucide settings 认，不是 emoji 字形）');
      H.click(gear as Element);
      await H.settle(200);
      const panel = H.maybe<HTMLElement>(document.body, '.kbw-panel');
      ok(panel, '板块管理面板开了');
      const head = H.q<HTMLElement>(panel as Element, '.kbw-panel-head');
      ok(head, '面板有头（拖拽手柄在头上）');
      const beforeLeft = (panel as HTMLElement).style.left;
      H.pointerDown(head, { x: 100, y: 18 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 170, y: 70 });
      await H.tick(10);
      H.pointerUp(document.body, { x: 170, y: 70, buttons: 0 });
      await H.tick(20);
      ok(
        (panel as HTMLElement).style.left !== beforeLeft &&
          (panel as HTMLElement).style.left !== '',
        `面板头拖得动（left ${beforeLeft || '(空)'} → ${(panel as HTMLElement).style.left}）`,
      );
      H.keydown(document.body, 'Escape');
      await H.settle(150);
    });

    await suite.it('a.5-5 单击卡片里哪一行，小窗就从那一行开始（任务行精确对齐）', async () => {
      await openBoard();
      const rel = `02_Areas/内容创作/__探针定位A5.md`;
      const body = '# 任务\n\n- [ ] 甲\n- [ ] 乙\n- [ ] 丙\n- [ ] 丁\n';
      H.writeNote(vaultRoot, `${KB}/${rel}`, H.note(body, { 类型: '任务' }));
      app.vault.rescan();
      app.vault.trigger('modify', app.vault.getAbstractFileByPath(`${KB}/${rel}`));
      await H.settleIndex(app, 260);
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', summaryLines: 3 },
        sections: [{ id: 'a5-g', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(320);
      const card = cards().find((c) => (c.dataset.path ?? '').includes('__探针定位A5')) as HTMLElement;
      ok(card, '卡片出来了');
      await H.until(() => !!card.querySelector('.kbw-card-body li'), 1500);
      const lis = Array.from(
        (card.querySelector('.kbw-card-body') as HTMLElement).querySelectorAll('li'),
      ).filter((li) => li.querySelector('input[type="checkbox"]'));
      eq(lis.length, 4, '四条任务都渲染出来了（条数=3 时第四条只是被 CSS 藏着）');
      // 期望的绝对行号**从文件里取**（夹具形状会变，别写死）
      const lines = H.readNote(vaultRoot, `${KB}/${rel}`).split('\n');
      const thirdTaskLine = lines.findIndex((l) => l.includes('- [ ] 丙'));
      ok(thirdTaskLine > 0, `源文里找得到「丙」那一行（第 ${thirdTaskLine} 行）`);

      H.click(lis[2]); // 点第三条任务
      await H.settle(400);
      const leaves = (app as unknown as { __leaves: { view?: unknown }[] }).__leaves;
      const view = leaves[leaves.length - 1]?.view as
        | { cursorAt?: { line: number }; scrolledTo?: { from: { line: number } } }
        | undefined;
      console.log(
        '[debug] 面板=', H.qa(document.body, '.kbw-panel').length,
        '｜面板标题=', H.textOf(H.q(document.body, '.kbw-panel-title')),
        '｜leaves=', leaves.map((l) => (l.view as { getViewType?: () => string })?.getViewType?.() ?? '?'),
        '｜view.cursorAt=', (view as { cursorAt?: unknown })?.cursorAt,
        '｜窗里有编辑器=', !!H.maybe(document.body, '.kbw-cw-editor'),
        '｜降级提示=', H.textsOf(document.body, '.kbw-cw-note').join(' / ').slice(0, 120),
        '｜窗内文本=', H.textOf(H.maybe<HTMLElement>(document.body, '.kbw-cw-panel')).slice(0, 60),
      );
      eq(view?.cursorAt?.line, thirdTaskLine, '窗里的编辑器光标落在「丙」那一行');
      eq(view?.scrolledTo?.from.line, thirdTaskLine, '画面也滚到那一行');
      H.keydown(document.body, 'Escape');
      await H.settle(300);
      // 关窗要留个断言：不关的话后面每条拿 .kbw-panel 的用例都会连着红（一串假红）
      eq(H.maybe(document.body, '.kbw-panel'), null, 'Esc 关掉了小窗（别把窗留给后面的用例）');
      fs.rmSync(path.join(vaultRoot, `${KB}/${rel}`), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 240);
    });

    await suite.it('§4.2 键盘：F2 改名 / Ctrl+Enter 新标签 / `[` `]` 翻卡 / Ctrl+↑↓ 跳板块', async () => {
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [
          { id: 'k-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 'k-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务' },
        ],
      });
      await H.settle(280);
      const cursorPath = (): string =>
        H.maybe<HTMLElement>(document.body, '[data-card].is-cursor')?.dataset.path ?? '';
      ok(cards().length >= 2, '得有卡片可走');
      // ⚠️ 键要派给**工作台根元素**（键盘处理器挂在那儿）—— 派给 body 收不到，与 notes 用例同源
      const root = H.q(document.body, '.kbw-root');
      /**
       * ⚠️ **光标先落到一张确定的卡上**（别依赖前面用例留下的状态）：
       * `onCardPointerDown` 会在按下时就设光标，所以"按下 + 松开、不位移"就能**确定地**把光标
       * 放在指定的那张卡上（不位移 → 不进拖动；jsdom 不会自己补 click → 不会开小窗）。
       * 早先这里直接按 ↓："从残留光标往前走一格"，落点取决于前面跑过什么 —— 单跑绿、全量红（实测）。
       */
      const anchorCard = cards()[0];
      H.pointerDown(anchorCard, { x: 30, y: 30 });
      await H.tick(10);
      H.pointerUp(anchorCard, { x: 30, y: 30, buttons: 0 });
      await H.settle(60);
      eq(cursorPath(), anchorCard.dataset.path ?? '', '先从一张确定的卡开始（按下即选中）');

      // ↑↓ 本来就有（这里只是把光标放到第一张上）
      H.keydown(root, 'ArrowDown');
      await H.settle(80);
      const first = cursorPath();
      ok(first, '↓ 落了光标');

      // `]` / `[`：下一张 / 上一张（IDE 手感）
      H.keydown(root, ']');
      await H.settle(60);
      const second = cursorPath();
      ok(second && second !== first, `] 走到下一张（${second.split('/').pop()}）`);
      H.keydown(root, '[');
      await H.settle(60);
      eq(cursorPath(), first, '[ 走回上一张');

      // Ctrl+↑↓：板块之间跳（**不是 Tab** —— Tab 得留给板块头上那排控件）
      H.keydown(root, 'ArrowDown', { ctrlKey: true });
      await H.settle(80);
      const jumped = cursorPath();
      ok(jumped && jumped !== first, `Ctrl+↓ 跳到下一块的第一张（${jumped.split('/').pop()}）`);
      ok(
        H.qa<HTMLElement>(document.body, '[data-card].is-cursor').length === 1,
        '光标只有一个（就地改 class，不是攒一堆）',
      );
      H.keydown(root, 'ArrowUp', { ctrlKey: true });
      await H.settle(80);

      /**
       * ⚠️ 基准要取**此刻**的光标（`beforeF2`），不能拿流程开头那个 `first`：
       * 中间那几步（`]` `[` `Ctrl+↑↓`）本来就会移动光标 —— 用开头的值比，
       * 断言等于在说"中间那几步都不许生效"（早先碰巧过了，是因为残留光标让它刚好回到原位）。
       */
      const beforeF2 = cursorPath();
      ok(beforeF2, 'F2 之前光标在某张卡上');
      // F2 → 就地改名（与「全部笔记」同一套）；Esc 取消
      H.keydown(root, 'F2');
      await H.settle(120);
      const input = H.maybe<HTMLInputElement>(document.body, '[data-card] .kbw-inline-input');
      ok(input, 'F2 出就地输入框');
      eq(input?.value, (cursorPath().split('/').pop() ?? '').replace(/\.md$/, ''), '框里是当前名字');
      H.keydown(input as Element, 'Escape');
      await H.settle(150);
      eq(H.maybe(document.body, '[data-card] .kbw-inline-input'), null, 'Esc 收掉输入框');
      eq(cursorPath(), beforeF2, '光标还在原处（没被改名流程弄丢）');

      // Ctrl+Enter → 新标签页打开
      const leaves = (): unknown[] => (app as unknown as { __leaves: unknown[] }).__leaves;
      const beforeLeaves = leaves().length;
      H.keydown(root, 'Enter', { ctrlKey: true });
      await H.settle(150);
      ok(leaves().length > beforeLeaves, 'Ctrl+Enter 建了一个新叶（新标签）');
      ok(H.maybe(document.body, '.kbw-board-body'), '看板还在（没把工作台那一页顶掉）');
    });

    await suite.it('§4.2 菜单里的「上移 / 下移 / 移到别的板块」= 拖拽的等价操作', async () => {
      await openBoard();
      __resetUndo();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [
          { id: 'm-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 'm-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务' },
        ],
      });
      await H.settle(280);
      /** 打开卡片菜单 → 找那一组（菜单项是 div.kbw-menu-item，不是 button） */
      const openCardMenu = async (path: string): Promise<HTMLElement> => {
        const card = cards().find((c) => c.dataset.path === path) as HTMLElement;
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
        await H.settle(80);
        return H.q<HTMLElement>(document.body, '.kbw-menu');
      };
      /** ⚠️ 子菜单是**另一个** `.kbw-menu` 实例（悬停/点击才飞出）→ 一律在整个 body 里找 */
      const itemByText = (text: string): HTMLElement | undefined =>
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes(text));

      const inA = H.qa<HTMLElement>(document.body, '[data-drop="m-a"] [data-card]').map(
        (c) => c.dataset.path ?? '',
      );
      ok(inA.length >= 2, `这一块至少两张卡（实际 ${inA.length}）`);
      const target = inA[0];
      const mine = target.split('/').pop() ?? '';

      const openGroup = async (): Promise<void> => {
        H.click(itemByText('在这一块里') as Element);
        await H.settle(80);
      };

      // ① 上移/下移：换一格 → 顺序表 + 排序切到「手动」
      await openCardMenu(inA[1]);
      ok(itemByText('在这一块里'), '卡片菜单里有「在这一块里」这一组');
      await openGroup();
      const up = itemByText('上移一位');
      ok(up, '有「上移一位」');
      H.click(up as Element);
      await H.settle(260);
      const afterUp = H.qa<HTMLElement>(document.body, '[data-drop="m-a"] [data-card]').map(
        (c) => c.dataset.path ?? '',
      );
      eq(
        afterUp[0],
        inA[1],
        `上移之后它到了第一位（原第一是 ${inA[0].split('/').pop()}）`,
      );
      ok(
        await H.until(() => {
          const raw = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
          const sec = (raw.sections ?? []).find((s: { id: string }) => s.id === 'm-a');
          return sec?.sort?.key === '手动' && Array.isArray(raw.view?.manualOrder?.['m-a']);
        }, 1500),
        '顺序表落进配置，且这一块的排序切到了「手动」（不然顺序表不生效）',
      );

      // ② 移到别的板块：对文件夹源 = **真搬文件**（与拖拽同一条实现）
      await openCardMenu(target);
      await openGroup();
      const moveGroup = itemByText('移到别的板块');
      ok(moveGroup, '有「移到别的板块」');
      H.click(moveGroup as Element); // 再飞出一层：候选板块
      await H.settle(80);
      const toB = itemByText('每日任务');
      ok(toB, '候选里列出了另一块');
      H.click(toB as Element);
      await H.settleIndex(app, 420);
      const moved = ctx().index.notes().find((e) => e.basename === mine.replace(/\.md$/, ''));
      eq(moved?.effectivePosition, '02_Areas/每日任务', '那篇被搬到目标板块的目录了');
      ok(hasUndoBar(), '走的是快照 + 撤销条那条路（和拖拽一样）');

      // 收拾：撤销 + 把顺序表拨回去，别给后面的用例留状态
      const undoBtn = H.currentUndoButton('撤销');
      H.click(undoBtn as Element);
      await H.settleIndex(app, 420);
      eq(
        ctx().index.get(target)?.effectivePosition,
        '02_Areas/内容创作',
        '撤销把文件搬回来了',
      );
      closeAllMenus();
    });

    await suite.it('三套菜单的作用域行：空白处 / 板块头 / 卡片', async () => {
      await openBoard(); // ⚠️ 单跑时前置步不会跑
      await writeBoardCfg({
        version: 1,
        view: {},
        sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(150);

      // ① 空白处 → 全局
      const body = H.q<HTMLElement>(document.body, '.kbw-board-body');
      body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      await H.settle(60);
      let menu = H.q<HTMLElement>(document.body, '.kbw-menu');
      contains(H.textOf(H.q(menu, '.kbw-menu-scope')), '全部板块', '空白处 → 全部板块');
      closeAllMenus();
      await H.settle(30);

      // ② 板块头 → 这一个（带篇数）
      const head = H.q<HTMLElement>(document.body, '.kbw-sect-head');
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
      await H.settle(60);
      menu = H.q<HTMLElement>(document.body, '.kbw-menu');
      const scopeText = H.textOf(H.q(menu, '.kbw-menu-scope'));
      contains(scopeText, '内容创作', '板块头 → 这一个板块');
      contains(scopeText, '篇', '作用域行带篇数');
      closeAllMenus();
      await H.settle(30);

      // ③ 卡片 → 这一篇（复用 P1 那份笔记菜单）
      const card = cards()[0];
      const cardName = (card.dataset.path ?? '').split('/').pop()?.replace(/\.md$/, '') ?? '';
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
      await H.settle(60);
      menu = H.q<HTMLElement>(document.body, '.kbw-menu');
      const note = H.textOf(H.q(menu, '.kbw-menu-scope'));
      contains(note, cardName, `卡片 → 这一篇（P1 那份笔记菜单用 basename）：${note}`);
      closeAllMenus();
      await H.settle(30);
    });

    await suite.it('板块管理面板：实时命中计数 + 添加（先类型后值）', async () => {
      H.click(gearBtn() as Element);
      await H.settle(80);
      const panel = H.q<HTMLElement>(document.body, '.kbw-panel');
      contains(H.textOf(panel), '板块管理', '面板开了');
      const rows = H.qa<HTMLElement>(panel, '.kbw-bp-row');
      eq(rows.length, 1, '一行 = 一个板块');
      const count = H.textOf(H.q(rows[0], '.kbw-bp-count'));
      ok(/\d+\s*篇/.test(count), `实时计数要显示出来（实际「${count}」）`);

      // 添加板块：先选类型 → 再选值
      H.click(H.qa<HTMLElement>(panel, '.kbw-btn').find((b) => H.textOf(b).includes('添加板块')) as Element);
      await H.settle(80);
      const add = H.q<HTMLElement>(panel, '.kbw-bp-add');
      contains(H.textOf(add), '标签', '四种类型都列出来（先类型后值）');
      ok(H.qa(add, 'select').length >= 1, '文件夹/标签/属性值各有候选下拉');
      ok(H.qa(add, '.kbw-btn').length >= 2, '每类都有「建」按钮');

      // 建一个标签板块（用第一个候选）
      const tagRow = H.qa<HTMLElement>(add, '.kbw-bp-add-row')[1];
      const sel = H.q<HTMLSelectElement>(tagRow, 'select');
      ok(sel.value, '标签候选非空（夹具里有标签）');
      H.click(H.qa<HTMLElement>(tagRow, '.kbw-btn')[0]);
      await H.settle(150);
      eq(H.qa<HTMLElement>(panel, '.kbw-bp-row').length, 2, '多了一行');
      eq(sections().length, 2, '看板上多了一个板块');
      contains(H.textOf(H.q(panel, '.kbw-bp-hint')), '只删配置', '文案说清"删除只删配置"');
      closeAllMenus();
    });

    await suite.it('板块管理面板：点外面关掉；再点齿轮仍然能开（不会刚关又被开回来）', async () => {
      await openBoard(); // ⚠️ 单跑（KBW_TEST_ONLY）时前置步不会跑，自己开
      const 板 = (): HTMLElement | null => H.maybe<HTMLElement>(document.body, '.kbw-panel');
      const gear = (): HTMLElement => gearBtn() as HTMLElement;
      // 先确保是关着的
      if (板()) {
        H.keydown(document.body, 'Escape');
        await H.settle(120);
      }
      H.click(gear());
      await H.settle(120);
      ok(板(), '点齿轮开面板');
      // 点面板里的东西**不该**关
      H.click(H.q(板() as Element, '.kbw-bp-hint'));
      await H.settle(100);
      ok(板(), '点面板里面不该关');
      // 点外面（看板空白）→ 关
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await H.settle(150);
      eq(板(), null, '点外面关掉（用户 2026-09-25 反馈的那条）');
      // ⚠️ 「点齿轮想关掉」那一下会被 outside 关掉，紧接着的 click 不该把它又开回来 ——
      // 那 350ms 的窗口是给"同一次点击"用的，所以这里要隔过去再点
      await H.settle(420);
      H.click(gear());
      await H.settle(120);
      ok(板(), '再点齿轮还能开（隔了一会儿）');
      H.click(gear());
      await H.settle(120);
      eq(板(), null, '面板开着时点齿轮 → 关掉（不是"关掉又被开回来"）');
    });

    await suite.it('面板里改一项（出回执）之后，**Esc 仍然关得掉面板**（分层栈的顺序）', async () => {
      await openBoard();
      const 板 = (): HTMLElement | null => H.maybe<HTMLElement>(document.body, '.kbw-panel');
      if (板()) {
        H.keydown(document.body, 'Escape');
        await H.settle(140);
      }
      H.click(gearBtn() as Element);
      await H.settle(120);
      ok(板(), '面板开了');
      // 面板里改一项 → 顶上一行回执 → 看板自己那条"清临时态"的层会被推起来
      H.click(H.q(板() as Element, '.kbw-btn'));
      await H.settle(120);
      const addBtn = H.qa<HTMLElement>(板() as Element, '.kbw-bp-add .kbw-btn')[0];
      ok(addBtn, '有「建」按钮可用');
      H.click(addBtn);
      await H.settle(200);
      /**
       * 🔴 这条是 P4.5 真机之前抓到的**顺序坑**：⚠️「清临时态」那种层语义上是最低优先级，
       * 要是它压在面板层上面，Esc 会去清一条看不见的回执、面板纹丝不动
       * （症状："面板里改个设置，Esc 就关不掉了"；基线里它碰巧压得早才没露出来）。
       * 所以这里**直接断言层序**，再看行为。
       */
      const layers = __escapeLabels();
      eq(layers[layers.length - 1]?.startsWith('floating:'), true, `面板层在最上面（实际栈：${layers.join(' < ')}）`);
      H.keydown(document.body, 'Escape');
      await H.settle(160);
      eq(板(), null, 'Esc 关掉了面板');
    });

    await suite.it('板块管理面板：改名 / 删除两下确认 / ▲▼ 换序', async () => {
      await openBoard();
      // 自己铺两个板块（不依赖上一条用例留下的状态；单跑时尤其重要）
      await writeBoardCfg({
        version: 1,
        view: {},
        sections: [
          { id: 's-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 's-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务' },
        ],
      });
      await H.settle(240);
      // 自己开面板（不依赖上一条用例留下的状态）
      if (!H.maybe(document.body, '.kbw-panel')) {
        H.click(gearBtn() as Element);
        await H.settle(150);
      }
      const panel = H.q<HTMLElement>(document.body, '.kbw-panel');
      const rows = H.qa<HTMLElement>(panel, '.kbw-bp-row');

      // ▲▼：第二行上移
      const upBtn = H.qa<HTMLElement>(rows[1], '.kbw-iconbtn')[0];
      H.click(upBtn);
      await H.settle(180);
      const after = H.qa<HTMLElement>(panel, '.kbw-bp-row');
      ok(after.length === 2, '换序后还是两行');
      const cfgRows = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8')).sections as {
        id: string;
        name: string;
      }[];
      // ▲▼ 真的换了序：配置里第二条的 id 走到了第一位（原先这里只断言"还是两条"，等于没测）
      const firstIdBefore = rows[0].dataset.id;
      ok(cfgRows[0].id !== firstIdBefore, '▲ 上移之后配置里的顺序真的变了');

      // 双击名字就地改名（原先用例名带「改名」却没验过）
      // ⚠️ 每一步都**重新取行**：面板改一次就整块重画，旧节点会脱开文档
      const rowAt = (i: number): HTMLElement =>
        H.qa<HTMLElement>(H.q<HTMLElement>(document.body, '.kbw-panel'), '.kbw-bp-row')[i];
      const nameEl = H.q<HTMLElement>(rowAt(0), '.kbw-bp-nm');
      nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await H.settle(80);
      const input = H.q<HTMLInputElement>(rowAt(0), 'input.kbw-inline-input');
      input.value = '换个名字';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await H.settle(220);
      const renamed = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8')).sections.map(
        (s: { name: string }) => s.name,
      );
      ok(renamed.includes('换个名字'), `改名写进配置了（实际 ${renamed.join('/')}）`);

      // 删除：第一下只改文案，第二下才真删
      const delBtn = () =>
        H.qa<HTMLElement>(H.q<HTMLElement>(document.body, '.kbw-panel'), '.kbw-bp-row')[0].querySelector(
          '.kbw-iconbtn:last-of-type',
        ) as HTMLElement;
      const before = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8')).sections.length;
      H.click(delBtn());
      await H.settle(120);
      eq(
        JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8')).sections.length,
        before,
        '第一下**不删**（两下确认）',
      );
      ok(H.textOf(delBtn()).includes('再点一次'), '第一下之后按钮变成「再点一次」');
      H.click(delBtn());
      await H.settle(200);
      eq(
        JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8')).sections.length,
        before - 1,
        '第二下才删',
      );
      // 收尾：关面板
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      eq(H.maybe(document.body, '.kbw-panel'), null, 'Esc 关面板');
    });

    await suite.it('全局菜单里连改两项：**前一项不被吞掉**、勾选态跟着走（R3）', async () => {
      /**
       * 独立审查 R3：菜单里的 `view` 是**开菜单那一刻**的快照，而"改设置不关窗"
       * 是就地 `refresh(build())` —— 连点两个属性时，第二项按第一项之前的值算，
       * 第一项被静默丢掉、复选框还显示旧状态（"菜单显示与文件相反"）。
       */
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', props: ['状态'] },
        sections: [{ id: 's-c', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(220);
      const body = H.q<HTMLElement>(document.body, '.kbw-board-body');
      body.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
      );
      await H.settle(60);
      const menu = H.q<HTMLElement>(document.body, '.kbw-menu');
      const item = (needle: string): HTMLElement | undefined =>
        H.qa<HTMLElement>(menu, '.kbw-menu-item').find((i) => H.textOf(i).includes(needle));
      H.click(item('显示属性') as Element);
      await H.settle(60);
      /**
       * ⚠️ 每次都要**重取当前那个子菜单**：改一次设置菜单会整块重建，
       * 抓着旧节点点下去跑的是**旧闭包**（算出来的 next 还是改之前的值）——
       * 这正是 R3 那条 bug 的"用例镜像"，测试自己踩一遍就够了。
       */
      const pick = (needle: string): void => {
        const live = H.maybe<HTMLElement>(document.body, '.kbw-menu.is-sub');
        const row = live
          ? H.qa<HTMLElement>(live, '.kbw-menu-item').find((i) => H.textOf(i) === needle)
          : undefined;
        ok(row, `子菜单里有「${needle}」`);
        H.click(row as Element);
      };
      // v2：候选来自"库里真有的属性"（五件套都在，专属字段已退役）—— 挑两个还没勾上的
      const p1 = '类型';
      const p2 = 'tags';
      pick(p1); // 第一项：加
      await H.settle(200);
      pick(p2); // 第二项：再加（不能把第一项冲掉）
      await H.settle(240);
      const cfg = JSON.parse(fs.readFileSync(path.join(vaultRoot, BOARD_CFG), 'utf8'));
      ok(
        cfg.view.props.includes(p1) && cfg.view.props.includes(p2),
        `两项都要在（实际 ${JSON.stringify(cfg.view.props)}）`,
      );
      // 菜单里那个复选框要反映**当前**状态，不是开菜单那一刻的
      const row = H.qa<HTMLElement>(H.q<HTMLElement>(document.body, '.kbw-menu.is-sub'), '.kbw-menu-item').find(
        (i) => H.textOf(i) === p1,
      );
      const box = row?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;
      eq(box?.checked, true, '刚勾上的那一项，复选框要是勾着的（不是相反）');
      closeAllMenus();
      await H.settle(60);
    });

    await suite.it('卡片右键 →「重命名」：真的出输入框，回车改名走 mover（R4）', async () => {
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 's-c', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(220);
      const before = cards()[0];
      const oldPath = before.dataset.path ?? '';
      const oldName = oldPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
      ok(oldName, '有卡片可改名');

      before.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(60);
      let menu = H.q<HTMLElement>(document.body, '.kbw-menu');
      // §8.3 那份菜单把「改」组收进了子菜单（一级最多 8 项）→ 先进「改」，再点「重命名」
      const 改Row = H.qa<HTMLElement>(menu, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith('改'),
      );
      ok(改Row, `P1 那份菜单里要有「改」组（实际 ${H.qa<HTMLElement>(menu, '.kbw-menu-item').map((i) => H.textOf(i)).join('/')}）`);
      H.click(改Row as Element);
      await H.settle(80);
      menu = H.q<HTMLElement>(document.body, '.kbw-menu.is-sub');
      const renameRow = H.qa<HTMLElement>(menu, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('重命名'),
      );
      H.click(renameRow as Element);
      await H.settle(200);
      // 菜单关掉之后，卡片标题那一格要变成输入框（原先只是改了个 state，没人画）
      const input = H.maybe<HTMLInputElement>(document.body, '[data-card] input.kbw-inline-input');
      ok(input, '卡片上真的出了就地输入框');
      const next = `${oldName}_改`;
      (input as HTMLInputElement).value = next;
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await H.settleIndex(app, 320);

      const dir = oldPath.split('/').slice(0, -1).join('/');
      ok(
        ctx().index.get(`${dir}/${next}.md`),
        `改名真的落盘了（${dir}/${next}.md）`,
      );
      ok(!ctx().index.get(oldPath), '旧路径不在了');
      // 收拾：改回去
      const back = ctx().index.get(`${dir}/${next}.md`);
      if (back) {
        await ctx().mover.move({
          targets: [{ newName: oldName, files: [back.file] }],
          source: 'board',
          reason: '探针改名（改回去）',
        });
        await H.settleIndex(app, 320);
      }
    });

    await suite.it('段落 只读模式：拦住就地编辑（勾选框与小窗都不动）', async () => {
      await writeBoardCfg({
        version: 1,
        view: { readonly: true },
        sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(180);
      ok(cards().length > 0, '只读模式照样显示卡片');
      const card = cards()[0];
      H.click(card.querySelector('.kbw-card-t') as Element);
      await H.settle(120);
      // ⚠️ 认准**卡片小窗**那个类名：`.kbw-panel` 也包含板块管理面板
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '只读模式下单击**不开**悬浮小窗');
      // 收尾：关掉只读，别影响后面的用例
      await writeBoardCfg({
        version: 1,
        view: {},
        sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(150);
    });

    await suite.it('手改库内 JSON：看板跟着变（配置层是唯一真源）', async () => {
      await writeBoardCfg({
        version: 1,
        view: { cardWidth: 300 },
        sections: [{ id: 's-1', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务' }],
      });
      await H.settle(200);
      eq(sections().length, 1, '换成别的板块了');
      contains(H.textOf(H.q(document.body, '.kbw-sect-nm')), '每日任务', '板块名跟着文件走');
      const holder = H.q<HTMLElement>(document.body, '.kbw-cards');
      eq(holder.style.getPropertyValue('--kbw-card-w'), '300px', '视图参数从配置来');
    });
  });

  // ════════════════════════════════════════════════════════════
  // d 期 · 多篇分页 + 钉住（§3.1）
  // ════════════════════════════════════════════════════════════
  /**
   * 这一期的立项理由（§3.1 原话）："同一时刻只开一篇是现在最硬的限制"。
   * 打破它的代价是一次**并发口径**的重定 —— 见 `editor.ts` 文件头那四条，
   * 其中第 ① 条（同一 path 只许一个叶）是本期最要紧、也最容易悄悄失效的一条。
   */
  await suite.group('P4.5 · d 期 · 多篇分页（纯函数 + 真链路）', async () => {
    /**
     * 每条用例开头先清场：上一条**失败**时面板会留在场上，而下一条又会去点卡片 ——
     * 那种污染最会伪装成"这条的新判据有问题"（c 期与探针都栽过这件事，
     * 所以探针每一步开头有 `closeAll()`，用例这边也得有对等的东西）。
     */
    async function closePanelNow(): Promise<void> {
      if (!H.maybe(document.body, '.kbw-cw-panel')) return;
      H.keydown(document.body, 'Escape');
      await H.settle(300);
    }
    /**
     * **真派一发 `mousedown`**。面板"点外面就关"监听的正是它 ——
     * 而 `H.click` 只派 `click`（探针那个 `P.click` 才派全套 pointerdown/mousedown/mouseup/click）。
     * 拿 `H.click` 测这条会**恒真**（面板当然还在），是个很干净的假绿。
     */
    function mousedownOn(target: Element): void {
      target.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
      );
    }
    /** 面板里那一篇的标题 —— **读 `.value`**：`<input>` 的 textContent 永远是空字符串 */
    /**
     * 这一页现在显示的标题。
     * ⚠️ P6b ⑤ 起标题输入框**并进面板头那一行**（不在页里了）→ 从"这一页所属的那扇窗"
     * 往上找头。判据是**页所属的窗**（`.kbw-cw-panel`）而不是 `document` —— 多窗时
     * 全局查会拿到**别的窗**的标题（那一版在多窗用例里必然假红）。
     */
    function titleOf(pg: HTMLElement): string {
      const panel = pg.closest<HTMLElement>('.kbw-cw-panel');
      return H.maybe<HTMLInputElement>(panel ?? document.body, '.kbw-cw-title')?.value ?? '';
    }
    const panelPages = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-cw-page');
    const panelTabs = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-cw-tab');
    const openPages = (): string[] => panelPages().map((pg) => pg.dataset.path ?? '');
    /**
     * **面板自己造的那些叶**（含路径）。
     *
     * ⚠️ 只认带 `kbw-cw-leaf` 的：更早的用例会**故意**用 `getLeaf('tab')` 打开真实标签
     *（自动化那几条要拿平台标签验行为），那些叶活得好好的、也不归面板管 ——
     * 全量跑时正是被它们带红的（第一条版本量的是"所有 markdown 叶"，于是
     * `归位.md` 那个平台叶一出现，这一组就假红）。
     *
     * 判据为什么比真机那条硬：桩的 `__leaves` 连 `new WorkspaceLeaf(app)` 造的叶也算，
     * 而真机上那些叶**不在**平台的叶树里（`getLeavesOfType` 看不到）→
     * 真机只能数 DOM，"DOM 拆了但叶还活着"数不出来。
     */
    const panelLeaves = (): { path: string; detached: boolean }[] =>
      (
        app as unknown as {
          __leaves: {
            detached: boolean;
            view: { file?: { path: string }; containerEl?: HTMLElement } | null;
          }[];
        }
      ).__leaves
        // `mountEditor` 挂上去时会给 `view.containerEl` 打这个类 —— 认它最准
        .filter((l) => l.view?.containerEl?.classList?.contains('kbw-cw-leaf') === true)
        .map((l) => ({ path: l.view?.file?.path ?? '?', detached: l.detached }));

    await suite.it('纯函数 · 打开同一篇两次只留一个 tab（去重）', () => {
      const a = { path: 'x/a.md' };
      const b = { path: 'x/b.md' };
      const r1 = insertTab([], a);
      eq(r1.added, true, '第一次开 = 新增');
      eq(r1.tabs.length, 1, '列表里一篇');

      const r2 = insertTab(r1.tabs, a);
      eq(r2.added, false, '**再开同一篇 = 不新增**（这条失效就是两个编辑器改一份文件）');
      eq(r2.tabs.length, 1, '还是一个 tab');
      eq(r2.tabs[0], a, '留下的还是那**同一个对象**（它的 DOM 与叶都挂在这份身份上）');

      const r3 = insertTab(r2.tabs, b);
      eq(r3.added, true, '换一篇 = 新增');
      eq(r3.tabs.length, 2, '两个 tab');
      // 新开的那一篇排在最前（差一位都说明顺序口径漂了）
      eq(r3.tabs[1].path, 'x/b.md', '新增的排在末尾（不是插到最前）');
    });

    await suite.it('纯函数 · 关一篇之后落到**右邻居**（没有右邻居落左邻居、空了返回 null）', () => {
      const mk = (n: number): { path: string }[] =>
        Array.from({ length: n }, (_v, i) => ({ path: `p${i}.md` }));
      eq(nextActiveAfterClose(mk(3), 0), 'p0.md', '关掉第 0 个 → 原第 1 个顶上来（现在排在 0）');
      eq(nextActiveAfterClose(mk(3), 2), 'p2.md', '关掉**末尾**那个 → 落到左邻居（原来的倒数第二）');
      eq(nextActiveAfterClose(mk(1), 0), 'p0.md', '只剩一篇 → 就它');
      eq(nextActiveAfterClose([], 0), null, '一篇都不剩 → null（该关整扇面板了）');
    });

    await suite.it('纯函数 · 改名重映射：跟着 `file.path` 走，被删的收进 dropped', () => {
      const t1 = { path: 'kb/旧名.md', file: { path: 'kb/旧名.md' } };
      const t2 = { path: 'kb/没动.md', file: { path: 'kb/没动.md' } };
      const t3 = { path: 'kb/被删了.md', file: { path: 'kb/被删了.md' } };
      // 平台在 rename 时**就地改** file.path（桩与真机都是）—— 我们只需要每篇自己去读它
      t1.file.path = 'kb/新名.md';
      const r = remapPaths([t1, t2, t3], (t) => (t.file.path === 'kb/被删了.md' ? null : t.file.path));
      eq(r.changed, true, '有变化');
      eq(t1.path, 'kb/新名.md', '改名那篇跟着走了（不跟 = 去重失效、会开出第二个编辑器）');
      eq(t2.path, 'kb/没动.md', '没动的原样');
      eq(r.dropped.length, 1, '被删的那篇被交出来（调用方要负责关掉它的叶）');
      eq(r.dropped[0], t3, '交出来的正是那一篇');

      // 什么都没变 → changed=false（别让调用方白重画一次 tab 条）
      const t4 = { path: 'kb/x.md', file: { path: 'kb/x.md' } };
      eq(remapPaths([t4], (t) => t.file.path).changed, false, '没变就是没变');
    });

    await suite.it('纯函数 · 当前那篇：还在就保持，不在就退最后一篇，空了 null', () => {
      const tabs = [{ path: 'a.md' }, { path: 'b.md' }];
      eq(resolveActive(tabs, 'a.md'), 'a.md', '当前那篇还在 → 保持（**不许**乱跳）');
      eq(resolveActive(tabs, 'gone.md'), 'b.md', '不在列表里 → 退最后一篇');
      eq(resolveActive([], 'a.md'), null, '空了 → null');
    });

    await suite.it('真链路 · 开 3 篇 → 关中间 1 篇 → 另 2 篇还在、内容还对（本期最核心那条）', async () => {
      await closePanelNow();
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'd1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 3, `这一屏要有 ≥3 张卡片（现在 ${cs.length} 张）`);
      const want = cs.slice(0, 3).map((c) => c.dataset.path ?? '');

      /**
       * ⚠️ **点卡片一律用 `H.realClick`**（派 pointerdown→mousedown→mouseup→click）。
       * 用只派 `click` 的 `H.click` 会**跳过 mousedown**，而"面板点外面就关"正是挂在
       * mousedown 上 —— 真机实测因此真红过：mousedown 先把面板关了、click 再开一扇新的，
       * 三下只攒出 1 页（离线当时全绿，是探针抓到的）。
       */
      for (const c of cs.slice(0, 3)) {
        H.realClick(c.querySelector('.kbw-card-t') as Element);
        await H.settle(240);
      }
      /**
       * 🔴 **P6b ③ 起"单击 = 一文件一扇窗"**（用户 2026-09-27 拍板，推翻了 f 期的
       * "单击进最近交互那扇 + 加 tab"）：三下单击 → **三扇窗**，每扇一篇。
       * 多篇分页（一扇窗里多个 tab）依然存在，只是入口变成**合并**：
       * 拖窗头到另一扇身上，或走卡片菜单的「打开 › 并入别的窗…」（非拖动等价物）。
       * 这条用例要验的正是"一扇窗里多页"那套，所以下面用**真入口**把它们并起来。
       */
      eq(
        H.qa(document.body, '.kbw-cw-panel').length,
        3,
        '三下单击 = 三扇窗（一文件一扇窗）',
      );
      eq(panelPages().length, 3, '每扇一页（共 3 页）');
      for (let i = 1; i < 3; i += 1) {
        const from = panelOfPath(want[i]);
        const into = panelOfPath(want[0]);
        ok(from != null && into != null && from !== into, `${want[i]} 与首篇各在一扇窗里`);
        ok(mergeWindowInto(from as number, into as number), `把第 ${i + 1} 扇并进第 1 扇`);
        await H.settle(120);
      }
      eq(H.qa(document.body, '.kbw-cw-panel').length, 1, '合并之后只剩一扇窗');
      eq(panelPages().length, 3, '面板里 3 页');
      eq(panelTabs().length, 3, 'tab 条上 3 个（≥2 篇才显示这条）');
      // 每页各自挂着一个真编辑器（不是共用一份）
      eq(H.qa(document.body, '.kbw-cw-editor .view-content').length, 3, '3 篇各自一个真编辑器');
      eq(openPages().slice().sort().join('|'), want.slice().sort().join('|'), '开着的正是点的那三篇');

      // 关掉**中间**那一篇（✕ 在 tab 条上，不在页里 —— 按 data-path 从那条上找）
      const midPath = want[1];
      const midTab = panelTabs().find((t) => t.dataset.path === midPath);
      ok(midTab, '找得到中间那个 tab');
      H.click(H.q<HTMLElement>(midTab as HTMLElement, '.kbw-cw-tabx'));
      await H.settle(260);

      // 另两篇还在，而且**内容对得上**（不是"数量对上就算过"）
      const left = openPages();
      eq(left.length, 2, '关掉一篇之后剩 2 页');
      ok(!left.includes(midPath), '关掉的那篇不在了');
      for (const pth of [want[0], want[2]]) {
        ok(left.includes(pth), `${pth} 还在`);
        const pg = panelPages().find((p) => p.dataset.path === pth);
        ok(pg, `${pth} 那一页还在`);
        ok(
          H.maybe(pg as HTMLElement, '.kbw-cw-editor .view-content'),
          `${pth} 的真编辑器还挂着`,
        );
      }
      /**
       * **面板头那个标题框显示的是"当前那一篇"**（P6b ⑤：输入框并进头那一行，
       * 全窗共用一个）。所以判据不能拿"某一页"去比 —— 要**先切到它**再比：
       * 切过去之后头里的名字、以及页的显隐都要对上（顺带把"切 tab 会换标题"钉住）。
       */
      for (const pth of [want[0], want[2]]) {
        const tb = panelTabs().find((t) => t.dataset.path === pth);
        ok(tb, `${pth} 的 tab 还在`);
        H.click(tb as Element);
        await H.settle(160);
        eq(
          titleOf(panelPages().find((p) => p.dataset.path === pth) as HTMLElement),
          pth.split('/').pop()?.replace(/\.md$/, ''),
          `切到 ${pth} 之后，头里的标题就是这一篇`,
        );
      }
      // tab 条上的名字也跟着收敛了
      eq(panelTabs().length, 2, 'tab 条上剩 2 个');
      eq(
        openPages().join('|'),
        panelTabs().map((t) => t.dataset.path).join('|'),
        'tab 条的顺序与页的顺序一致',
      );

      /**
       * **切 tab 会 save**（d 期定的口径 ②）—— 一条可断言的不变量：
       * "任何 tab 离开活动态时都已落盘"。
       *
       * ⚠️ 判据只能数 `saveCount`，不能看盘：桩的 `save()` 在没打过字（`draft == null`）
       * 时**不写盘**，而真机的 `view.save()` 是无条件写的 —— 拿盘当判据会**离线假绿**。
       * 也就是说这条用例钉的是"调用发生了"；"写下去的字节对不对"归 P4 的
       * 「Esc 关掉且关前会 save」那条（它也是同一套口径）。
       */
      const mdViews = (): { file: { path: string } | null; saveCount: number }[] =>
        (app as unknown as { __leaves: { view: unknown }[] }).__leaves
          .map((l) => l.view as unknown as { file?: { path: string } | null; saveCount?: number })
          .filter((v) => v && typeof v.saveCount === 'number') as {
          file: { path: string } | null;
          saveCount: number;
        }[];
      const viewOf = (pth: string): { saveCount: number } | undefined =>
        mdViews().find((v) => v.file?.path === pth);
      /** 当前显示的那一页（隐藏的页是 `display:none`） */
      const activePage = (): string =>
        panelPages().find((pg) => pg.style.display !== 'none')?.dataset.path ?? '';

      const nowActive = activePage();
      const other = openPages().find((pth) => pth !== nowActive) ?? '';
      ok(nowActive && other, `两篇里认得出当前与另一篇（当前=${nowActive}）`);
      const before = viewOf(nowActive)?.saveCount ?? -1;
      ok(before >= 0, '拿得到当前这篇的 save 次数');
      // 切到另一篇（点它的 tab 条）
      const otherTab = panelTabs().find((t) => t.dataset.path === other);
      ok(otherTab, '找得到另一篇的 tab');
      H.click(otherTab as HTMLElement);
      await H.settle(300);
      eq(activePage(), other, '切过去了（当前页换成它）');
      eq(
        (viewOf(nowActive)?.saveCount ?? -1) > before,
        true,
        `切走的那一篇被 save 了一次（${nowActive}：${before} → ${viewOf(nowActive)?.saveCount ?? -1}）`,
      );

      /**
       * **从 2 篇关到 1 篇：tab 条要自己藏回去。**
       *
       * ⚠️ 判据必须落在这个**转变**上：建面板时就把它设成 `none` 了，
       * 所以"1 篇时 display === none"单看是恒真的（把 `paintStrip` 里改 display 那行删掉
       * 都测不出来 —— 作者自己突变验过一次，发现是空跑才补了这一条）。
       */
      const stripEl = H.maybe<HTMLElement>(document.body, '.kbw-cw-tabs');
      eq(
        stripEl ? getComputedStyle(stripEl).display : '',
        'flex',
        '2 篇时 tab 条是显示着的（否则下面那句"藏回去"是空跑）',
      );
      H.click(H.q<HTMLElement>(document.body, '.kbw-cw-tabx'));
      await H.settle(320);
      eq(openPages().length, 1, '关到只剩 1 篇');
      eq(
        stripEl ? getComputedStyle(stripEl).display : '',
        'none',
        '只剩 1 篇 → tab 条**藏回去**（不藏的话用户会看到一个空条）',
      );

      // 收尾：关掉（只剩 1 篇时「全部关闭」那个按钮不画，所以走 Esc）
      await closePanelNow();
      await H.settle(320);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '全部关闭之后面板收掉了');
      eq(H.qa(document.body, '.kbw-cw-leaf').length, 0, '三个编辑器 DOM 都收干净了');
    });

    await suite.it('真链路 · 同一篇点两次只有一页；**关面板时每个叶都被 detach**（不留悬挂叶）', async () => {
      await closePanelNow();
      /**
       * 记下**开工前**还活着的叶：这一组断言的是"**这一轮开的窗**关干净了"。
       * 量增量而不是量总数（总数会被更早用例留下的东西带红 —— 全量跑时正是这么红的），
       * 但顺手把基线打出来，好知道是不是**别人**漏了。
       */
      const base = panelLeaves().filter((l) => !l.detached);
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'd2', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务' }],
      });
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 1, '至少有 1 张卡片');
      const path0 = cs[0].dataset.path ?? '';

      /**
       * 基线不是空的就说明**更早的用例漏了叶**（全量跑时确实发生过）。
       * 让这一条先红在那儿、把证据留下来，而不是把我的断言悄悄放松。
       */
      eq(base.length, 0, `开工前不该有还活着的 markdown 叶（实际：${base.map((l) => l.path).join('｜')}）`);

      // ① 同一篇点两次（真鼠标序列 —— 见"开 3 篇"那条里的说明）
      H.realClick(cs[0].querySelector('.kbw-card-t') as Element);
      await H.settle(240);
      eq(panelPages().length, 1, '点一下 = 一页');
      /**
       * ⚠️ 判据是"**用户看不见它**"（`display`），不是"DOM 里没有节点" ——
       * `paintStrip` 是"先清空、再判断要不要画"，所以"一篇时没画"与
       * "画了又被清空"在**数节点**的判据下完全等价（独立审查点出的一条空跑断言）。
       */
      const stripEl = H.maybe<HTMLElement>(document.body, '.kbw-cw-tabs');
      ok(stripEl, 'tab 条这个容器在 DOM 里（只是被藏起来）');
      eq(
        stripEl ? getComputedStyle(stripEl).display : '',
        'none',
        '只有一篇时 tab 条**不显示**（与没有分页时的长相完全一致）',
      );
      eq(panelTabs().length, 0, '里面也没有 tab 项');
      /**
       * 🔴 **第二下这一发是本期最容易出错的地方**：
       * 去重一旦失效，会开出**第二个编辑器改同一份文件**（各持一份 buffer、
       * 各自整份写回，后写的把先写的冲掉）。而且它不会报错、只是丢字。
       */
      H.realClick(cs[0].querySelector('.kbw-card-t') as Element);
      await H.settle(240);
      eq(panelPages().length, 1, '同一篇点两次 = **只有一页**（去重生效）');
      eq(openPages()[0], path0, '还是那一篇');
      eq(H.qa(document.body, '.kbw-cw-editor .view-content').length, 1, '也只有一个编辑器');
      eq(H.qa(document.body, '.kbw-cw-leaf').length, 1, '只有一个叶挂在面板里');

      /**
       * ② 关面板 → **每个 tab 的叶都要 detach**。
       * ⚠️ 判据用桩的 `__leaves`（构造时就入栈，真机上 `new WorkspaceLeaf(app)`
       * 造出来的叶**不在**平台的叶树里、`getLeavesOfType` 看不到它）——
       * 所以离线这条比真机那条还严：真机上只能数 DOM。
       */
      eq(panelLeaves().length, base.length + 1, '面板开着时**只多**一个 markdown 叶');
      H.keydown(document.body, 'Escape');
      await H.settle(340);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, 'Esc 关掉面板');
      eq(H.qa(document.body, '.kbw-cw-leaf').length, 0, '编辑器 DOM 收干净了');
      /**
       * **这条是本期最要紧的收尾判据**：面板收掉不等于叶收掉。
       * `detach()` 会把叶从桩的 `__leaves` 里摘掉，所以"回到基线"就等于"叶真的 detach 了"
       *（而不是只把 DOM 拆了、叶还在工作区里挂着）。
       */
      eq(
        panelLeaves().filter((l) => !l.detached).length,
        base.length,
        `叶回到开工前的数量（漏了：${panelLeaves().map((l) => l.path).join('｜')}）`,
      );
    });

    await suite.it('真链路 · 改名：tab 跟着走（挂的是 rename 事件，不是改名按钮）', async () => {
      await closePanelNow();
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'd3', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 1, '至少有 1 张卡片');
      H.click(cs[0].querySelector('.kbw-card-t') as Element);
      await H.settle(240);
      const oldPath = panelPages()[0]?.dataset.path ?? '';
      ok(oldPath, '页上带着路径（探针与用例都靠它认人）');
      // 再开一篇：改名之后**两篇都要跟着走**（目录改名会一次挪一批，只改一篇必漏）
      const otherPath = cs[1]?.dataset.path ?? '';
      if (otherPath) {
        H.click(cs[1].querySelector('.kbw-card-t') as Element);
        await H.settle(240);
        /**
         * ⚠️ P6b ③ 起单击 = **一文件一扇窗** → 这里要"一扇窗里两页"（才有 tab 条
         * 可以验"tab 跟着改名走"），先**合并**（非拖动入口）。
         */
        const idA = panelOfPath(oldPath);
        const idB = panelOfPath(otherPath);
        if (idA != null && idB != null && idA !== idB) mergeWindowInto(idB, idA);
        await H.settle(220);
        /**
         * 🔴 合并之后**活动页是"后并进来的那一篇"** —— 而面板头那个标题框改的是
         * **当前那一篇**（P6b ⑤）。要让这条用例改的确实是 `oldPath`，得先**切回它**
         *（不切的话，输入的名字会落到另一篇头上，断言会以"旧路径还在"的形态报出来）。
         */
        const first = panelTabs().find((t) => t.dataset.path === oldPath);
        if (first) {
          H.click(first);
          await H.settle(160);
        }
      }
      eq(panelPages().length, otherPath ? 2 : 1, '面板里两页');

      // 走 mover（真链路：快照 + 撞名守卫 + 双链同步），不直接调 renameFile
      const name = `__探针-d期改名-${Date.now()}`;
      /**
       * ⚠️ **标题输入框在面板头里**（P6b ⑤：并进头那一行、全窗共用），不在页里 ——
       * 从**面板根**查（`H.q(page, …)` 会命中不了：页里已经没有它了）。
       */
      const input = H.q<HTMLInputElement>(
        H.q<HTMLElement>(document.body, '.kbw-cw-panel'),
        '.kbw-cw-title',
      );
      input.value = name;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await H.settle(500);

      const newPath = oldPath.replace(/[^/]+\.md$/, `${name}.md`);
      eq(H.exists(vaultRoot, newPath), true, '文件真的改名了（走的是 mover）');
      const nowPages = openPages();
      eq(
        nowPages.includes(newPath),
        true,
        'tab 的路径跟着改名走了（不跟 = 再点它会开出第二个编辑器）',
      );
      eq(nowPages.includes(oldPath), false, '旧路径不再挂在任何一页上');
      eq(nowPages.includes(newPath), true, '页上的 `data-path` 也换了（探针与用例认人的锚）');
      eq(nowPages.length, otherPath ? 2 : 1, '改名**没有**多出一页');
      if (otherPath) eq(nowPages.includes(otherPath), true, '另一篇不受影响');
      eq(
        panelTabs().find((t) => t.dataset.path === newPath) != null || nowPages.length < 2,
        true,
        'tab 条上那一个也跟着换了',
      );

      /**
       * 收尾：**先关面板**（关窗时会把编辑器 save 到它认的那个路径），
       * 再用文件系统把名字改回来。不先关面板就 fs 改名的话，
       * 面板随后 save 会**在老名字上重建一份**（本项目的"凭空复制一份"老账）。
       */
      await closePanelNow();
      if (H.exists(vaultRoot, newPath)) {
        fs.renameSync(path.join(vaultRoot, newPath), path.join(vaultRoot, oldPath));
        app.vault.rescan();
        /**
         * ⚠️ **必须显式重建索引**：`rescan()` 一个事件都不发（测试台那条规格），
         * 不重建的话索引里留着一个**指向旧路径的幽灵条目** → 后面的用例点它的卡片，
         * 面板去 `vault.read` 一个不存在的文件 → 冒一条 `[经纬] 读正文失败`
         *（真机探针把插件的 `console.error` 一律判成失败，所以这类噪声不能留）。
         */
        ctx().index.rebuild();
        await H.settleIndex(app);
      }
      eq(H.exists(vaultRoot, newPath), false, '别把 __探针 文件留在库里');
      eq(H.exists(vaultRoot, oldPath), true, '名字改回来了');
    });

    await suite.it('真链路 · 改**无关**设置不重建 tab 里的块；真换了档才重建', async () => {
      /**
       * ⚠️ `cfg.onChange` 是**整份配置**的变动通知 —— 拖卡片里那根分隔条、`Ctrl+滚轮` 缩放、
       * 改卡片显示档，每一项都会走到面板那边。不加判据的代价（本期自己复查时发现的）：
       * 拖一次分隔条就把所有 tab 的属性块重画一遍，**还顺手把用户点开的「显示全部属性」收回去**。
       *
       * 判据用**节点同一性**（b 期那条同款）：DOM 可以重建得一模一样，
       * "节点还连不连着"才看得出走的是就地更新还是整块重建。
       */
      const SEC = [{ id: 'd6', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      await closePanelNow();
      await openBoard();
      // ⚠️ 显式要「前 6 行」那一档（C2 之后默认是 none，不写就没有属性块可测"节点没变"）
      await writeBoardCfg({
        version: BOARD_CONFIG_VERSION,
        view: { cardMode: 'content', panelProps: 'few' },
        sections: SEC,
      });
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 1, '有卡片');
      H.realClick(cs[0].querySelector('.kbw-card-t') as Element);
      await H.settle(260);
      const propsBox = H.q<HTMLElement>(document.body, '.kbw-cw-props');
      const leaf = H.q<HTMLElement>(document.body, '.kbw-cw-leaf');
      ok(propsBox && leaf, '属性块与编辑器都在（否则下面"节点没变"是空跑）');

      // ① 改一个**跟小窗无关**的字段（`cardWidth` 正是拖分隔条/缩放写的那些之一）
      await writeBoardCfg({
        version: BOARD_CONFIG_VERSION,
        view: { cardMode: 'content', panelProps: 'few', cardWidth: 300 },
        sections: SEC,
      });
      await H.settle(400);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '改设置**不关面板**');
      eq(propsBox.isConnected, true, '属性块是**原来那个节点**（没有白重建一遍）');
      eq(H.q<HTMLElement>(document.body, '.kbw-cw-props'), propsBox, '还是同一个节点');
      eq(leaf.isConnected, true, '编辑器叶也没被重挂');

      // ② 真换了档 → 这一次**必须**重建（否则就是"改了没反应"）
      await writeBoardCfg({
        version: BOARD_CONFIG_VERSION,
        view: { cardMode: 'content', panelProps: 'all' },
        sections: SEC,
      });
      await H.settle(400);
      eq(propsBox.isConnected, false, '换成「全部」之后属性块确实重建了');
      eq(H.q<HTMLElement>(document.body, '.kbw-cw-leaf'), leaf, '但正文那一块没被碰（属性档不碰编辑器）');

      // 收尾：档位拨回来、关面板
      await closePanelNow();
      await writeBoardCfg({ version: 1, view: {}, sections: SEC });
      await H.settle(200);
    });

    await suite.it('真链路 · 面板开着点自己的 ⚙ 菜单选一档：**面板不许被那一下关掉**', async () => {
      /**
       * 🔴 独立审查 🟡4（实测复现）：面板"点外面就关"听的是 mousedown，而**点菜单项**
       * 那一下同样会先发 mousedown → 面板被关掉（所有 tab 一起 save+detach）→
       * 紧接着的 click 才写配置。于是"就地重建，不关窗"做不到，a.10 真机验过的
       * "选只读预览 → 窗口自动重开"也不成立。
       *
       * ⚠️ 既有用例全是"先写配置再开窗"，从没走过"面板开着 + 点菜单项"——
       * 所以那条 `ignoreOutsideClick` + `realClick` 的红线**全是假绿拦不住它**。
       * 这条必须走**真鼠标序列**（只派 click 的话 mousedown 根本不发，测不出来）。
       */
      const SEC = [{ id: 'd12', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      await closePanelNow();
      await openBoard();
      await writeBoardCfg({ version: 1, view: { cardMode: 'content' }, sections: SEC });
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 1, '有卡片');
      H.realClick(cs[0].querySelector('.kbw-card-t') as Element);
      await H.settle(320);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '面板开着');
      ok(H.maybe(document.body, '.kbw-cw-leaf'), '这时是真编辑器档');

      // 点面板头上的 ⚙（第一个 headAction 是图钉，⚙ 是第二个）
      const headBtns = H.qa<HTMLElement>(document.body, '.kbw-panel-actions .kbw-iconbtn');
      ok(headBtns.length >= 2, '面板头上有图钉与 ⚙');
      H.realClick(headBtns[1]);
      await H.settle(240);
      const menu = H.maybe<HTMLElement>(document.body, '.kbw-menu');
      ok(menu, '小窗显示设置的菜单弹出来了');

      /**
       * 选「这一篇 › 小窗正文 → 只读预览」（子菜单展开后才有）。
       * ⚠️ f 期这个菜单**多了一层**（「这一篇」/「所有窗的默认」，用户 2026-09-26 拍板要
       * 分清这两层），所以路径也跟着变成三段 —— 这条用例守的是"点菜单项不许把面板关掉"，
       * 走哪一层都成立（挑「这一篇」是因为它在 DOM 里排前面，`open()` 取首个命中）。
       */
      const open = (label: string): boolean => {
        const items = H.qa<HTMLElement>(document.body, '.kbw-menu-item');
        const hit = items.find((i) => H.textOf(i).includes(label));
        if (!hit) return false;
        H.realClick(hit);
        return true;
      };
      ok(open('这一篇'), '点开了「这一篇」那一层');
      await H.settle(200);
      ok(open('小窗正文'), '点开了「小窗正文」那一组');
      await H.settle(200);
      ok(open('只读预览'), '点了「只读预览」');
      await H.settle(500);

      ok(
        H.maybe(document.body, '.kbw-cw-panel'),
        '**面板还开着**（那一发 mousedown 不许把它关掉 —— 审查 🟡4）',
      );
      eq(
        H.qa(document.body, '.kbw-cw-leaf').length,
        0,
        '档位真的生效了（真编辑器收掉了、换成只读预览）',
      );
      eq(panelPages().length, 1, '页也还在');

      await closePanelNow();
      await writeBoardCfg({ version: 1, view: {}, sections: SEC });
      await H.settle(200);
    });

    await suite.it('真链路 · 面板开着切「小窗正文」档：**页还在**，只在正文那一块重建', async () => {
      /**
       * 🔴 这条钉的是独立审查的 🔴1（实测复现）：`rebuildAll` 换形态时借用了
       * `detachTab`，而那个函数兼着"关掉这一篇"的 `page.remove()` →
       * **切一次档 = 每一页被整页拆掉**（面板里 0 页、tab 条还画着、切回来也回不去）。
       * "拆页"只有"这一篇真的要走"时才该做。
       */
      const SEC = [{ id: 'd8', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      const cfgOf = (extra: Record<string, unknown>): unknown => ({
        version: 1,
        view: { cardMode: 'content', ...extra },
        sections: SEC,
      });
      await closePanelNow();
      await openBoard();
      await writeBoardCfg(cfgOf({}));
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 2, '至少两张卡');
      for (const c of cs.slice(0, 2)) {
        H.realClick(c.querySelector('.kbw-card-t') as Element);
        await H.settle(240);
      }
      eq(panelPages().length, 2, '先开两篇');
      eq(H.qa(document.body, '.kbw-cw-leaf').length, 2, '两个真编辑器');

      // 切到「只读预览」
      await writeBoardCfg(cfgOf({ panelContent: 'preview' }));
      await H.settle(600);
      eq(panelPages().length, 2, '**切档之后页还在**（原先会被整页拆掉 → 0）');
      eq(
        panelPages().filter((pg) => pg.isConnected).length,
        2,
        '两页都还连在文档里（不是游离节点）',
      );
      eq(H.qa(document.body, '.kbw-cw-leaf').length, 0, '真编辑器收掉了（这一档本来就是只读预览）');
      const hostInfo = H.qa<HTMLElement>(document.body, '.kbw-cw-editor').map(
        (h) => `${h.children.length}子/${H.textOf(h).replace(/\s/g, '').length}字`,
      );
      ok(
        hostInfo.length === 2 && hostInfo.every((x) => !x.startsWith('0子/0字')),
        `预览内容画出来了（实测 ${hostInfo.join('｜')}）`,
      );

      // 切回「可编辑」
      await writeBoardCfg(cfgOf({}));
      await H.settle(700);
      eq(panelPages().length, 2, '切回来还是两页（能就地恢复）');
      eq(
        H.qa(document.body, '.kbw-cw-editor .view-content').length,
        2,
        '两个真编辑器又挂回来了',
      );
      ok(H.maybe(document.body, '.kbw-cw-panel'), '面板一直开着（没被顺手关掉）');

      await closePanelNow();
      await writeBoardCfg(cfgOf({}));
      await H.settle(200);
    });

    await suite.it('真链路 · 挂载途中被关掉：同一篇**不会出现两个活叶**（口径 ①）', async () => {
      /**
       * 🔴 这条钉的是独立审查的 🔴2（实测复现）：`mountEditor` 的守卫原来按**路径**认
       *（`findTab(panel, tab.path)`），于是「点开 → 立刻 Esc → 立刻再点同一篇」时，
       * **第一发挂载**回来发现 path 又在列表里（命中的是**新**那个 tab）→ 放行 →
       * 叶挂进**已经拆掉的旧页**、写回已出列的旧 tab → 谁也不 detach 它。
       * 修法是守卫加**对象身份**判据（`findTab(...) !== tab`）。
       *
       * ⚠️ 这条**只有在"桩的 setViewState 是异步的"前提下才测得到** ——
       * 所以桩里那个 `viewStateLagMs` 默认就是非 0（与真机一致）。这里再放大一点，
       * 让窗口确定性地够宽（不然打不打得中全看机器快慢）。
       */
      const SEC = [{ id: 'd11', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      await closePanelNow();
      await openBoard();
      await writeBoardCfg({ version: 1, view: { cardMode: 'content' }, sections: SEC });
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 1, '有卡片');
      const path0 = cs[0].dataset.path ?? '';
      const mdAlive = (): number =>
        (app as unknown as { __leaves: { detached: boolean; view: unknown }[] }).__leaves.filter(
          (l) =>
            !l.detached &&
            (l.view as { containerEl?: HTMLElement } | null)?.containerEl?.classList?.contains(
              'kbw-cw-leaf',
            ) === true,
        ).length;

      const prevLag = app.viewStateLagMs;
      app.viewStateLagMs = 160; // 把"挂载还在路上"那个窗口拉宽，确定性地打中
      try {
        H.realClick(cs[0].querySelector('.kbw-card-t') as Element);
        await H.settle(30); // 挂载**还在路上**
        H.keydown(document.body, 'Escape'); // 立刻关掉
        await H.settle(20);
        H.realClick(cs[0].querySelector('.kbw-card-t') as Element); // 立刻再开同一篇
        await H.settle(700);
        eq(openPages().includes(path0), true, '第二下把它开出来了');
        eq(openPages().length, 1, '只有一页');
        eq(mdAlive(), 1, '**同一篇只有一个活着的叶**（口径 ①：两个 = 各持一份 buffer、丢改动）');
        eq(
          H.qa(document.body, '.kbw-cw-leaf').length,
          1,
          'DOM 里也只有一个编辑器（那一发迟到的挂载没把叶塞进已拆掉的旧页）',
        );
      } finally {
        app.viewStateLagMs = prevLag;
      }
      await closePanelNow();
      await H.settle(400);
      eq(mdAlive(), 0, '关掉之后没有悬挂叶（迟到的那些也被守卫收走了）');
      await writeBoardCfg({ version: 1, view: {}, sections: SEC });
      await H.settle(200);
    });

    await suite.it('真链路 · 反复开关面板**不漏监听**（关面板的每条短路路径都要 dispose）', async () => {
      /**
       * 🔴 独立审查 🟡5（实测复现）：`p.d.dispose()` 原先只在 `destroyPanel` 那一条路上，
       * 而 Esc / 头部 ✕ / 点外面 / resize / purge 是**直接调 `h.close()`** 的 →
       * 每关一次漏一条 `cfg.onChange` 订阅 + 一对 vault 监听，整份死面板还被闭包钉住。
       *
       * 判据数**桩的监听表**（`Emitter.count()`）—— 真机上这种东西不报错、只是慢慢漏。
       * ⚠️ 关的路径要**换着来**（Esc / ✕ / 「完成」），只有一条路的话
       * 另一条路上的漏照样测不出来。
       */
      const SEC = [{ id: 'd13', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      const vaultCount = (): number => app.vault.count();
      const openOne = async (): Promise<void> => {
        const c = cards()[0];
        ok(c, '有卡片');
        H.realClick(c.querySelector('.kbw-card-t') as Element);
        await H.settle(300);
        ok(H.maybe(document.body, '.kbw-cw-panel'), '面板开着');
      };
      await closePanelNow();
      await openBoard();
      await writeBoardCfg({ version: 1, view: { cardMode: 'content' }, sections: SEC });
      await H.settle(300);

      const base = vaultCount();
      // ① 开一扇 → Esc 关
      await openOne();
      ok(vaultCount() > base, `开面板时会挂上监听（${base} → ${vaultCount()}）`);
      H.keydown(document.body, 'Escape');
      await H.settle(340);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, 'Esc 关掉了');
      eq(vaultCount(), base, 'Esc 那条路把监听收干净了');

      /**
       * ② 再开一扇 → **点外面**关。
       * ⚠️ 浮层的头**没有 ✕**（那是模态才有的；这一扇的关法 = Esc / 点外面 /
       * 「完成」/「全部关闭」）—— 第一版这里写 `.kbw-panel-head .kbw-iconbtn:last-child`，
       * 选中的其实是**齿轮**，点它只是弹设置菜单，用例红得莫名其妙。
       */
      await openOne();
      mousedownOn(document.body);
      await H.settle(340);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '点外面关掉了');
      eq(vaultCount(), base, '点外面那条路也收干净了');

      // ③ 再开一扇 → `purgeOverlays()`（插件重载那条路）
      await openOne();
      purgeOverlays();
      await H.settle(340);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, 'purge 收掉了');
      eq(vaultCount(), base, 'purge 那条路也收干净了');

      // ④ 再开一扇 → 「完成」关（这条原先就走 dispose，是对照组）
      await openOne();
      const done = H.qa<HTMLElement>(document.body, '.kbw-cw-panel .kbw-panel-foot .kbw-btn').find(
        (b) => H.textOf(b) === '完成',
      );
      ok(done, '找得到「完成」');
      H.click(done as Element);
      await H.settle(400);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '「完成」关掉了');
      eq(vaultCount(), base, '「完成」那条路也是干净的');

      await writeBoardCfg({ version: 1, view: {}, sections: SEC });
      await H.settle(200);
    });

    await suite.it('真链路 · 钉住的面板切模块**留着**（不钉住的会被收掉）', async () => {
      /**
       * d 期拍板的口径：**面板跟着工作台、不跟着模块**（切去看一眼笔记再回来，
       * 编辑到一半的几篇不该没）—— 这条在审查前**一条判据都没有**（审查 🟡7 点名的）。
       */
      const SEC = [{ id: 'd9', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      const cfgOf = (extra: Record<string, unknown>): unknown => ({
        version: 1,
        view: { cardMode: 'content', ...extra },
        sections: SEC,
      });
      const navTo = (label: string): void => {
        const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
          H.textOf(b).includes(label),
        );
        ok(nav, `导航里有「${label}」`);
        H.click(nav as Element);
      };
      const p = (() => {
        const c = cards();
        return c.length > 0 ? (c[0].dataset.path ?? '') : '';
      });
      await closePanelNow();
      await openBoard();
      await writeBoardCfg(cfgOf({ panelPinned: true }));
      await H.settle(300);
      ok(p(), '有卡片');
      H.realClick(
        cards()
          .find((c) => c.dataset.path === p())
          ?.querySelector('.kbw-card-t') as Element,
      );
      await H.settle(260);
      ok(H.q<HTMLElement>(document.body, '.kbw-panel-actions .kbw-iconbtn').classList.contains('is-on'), '先钉住');

      // ① 钉住 → 切到「全部笔记」→ 面板与叶都还在
      navTo('全部笔记');
      await H.settle(500);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '切模块之后面板还在（钉住的）');
      eq(openPages().length, 1, '页也还在');
      ok(H.maybe(document.body, '.kbw-cw-leaf'), '编辑器叶还挂着');
      eq(
        (app as unknown as { __leaves: { detached: boolean }[] }).__leaves.filter((l) => !l.detached)
          .length > 0,
        true,
        '没被 detach',
      );

      // ② 切回看板 → 「编辑中」标记要**回读**出来（模块是新的、面板是老的）
      navTo('看板');
      await H.settle(700);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '切回来面板还在');
      eq(
        cards()
          .find((c) => c.dataset.path === p())
          ?.classList.contains('is-editing-source'),
        true,
        '「编辑中」标记回读出来了（模块重建后靠 `panelPaths()` 回读，不然标签整批消失）',
      );

      // ③ 取消钉住 → 再切模块 → 这次会被收掉（两态都认，别把"钉住"做成"永远收不掉"）
      H.click(H.q<HTMLElement>(document.body, '.kbw-panel-actions .kbw-iconbtn'));
      await H.settle(400);
      navTo('全部笔记');
      await H.settle(500);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '不钉住 → 切模块就收掉');

      navTo('看板');
      await H.settle(400);
      await writeBoardCfg(cfgOf({}));
      await H.settle(200);
    });

    await suite.it('真链路 · 面板开着删掉那一篇：页跟着收掉，且**关它时不再 save**', async () => {
      /**
       * 独立审查 🟡6：真机的 `MarkdownView.save()` 是**无条件写盘**的，平台的写路径又不查文件
       * 还在不在 → 文件刚被删、面板一 save 就把它**写回来**（"凭空复制一份"那类）。
       * 判据只能看"**有没有调 save**"：桩的 save 在没草稿时不写盘，所以看盘会假绿。
       */
      const rel = `${KB}/00_Inbox/__探针-d期-删.md`;
      const SEC = [{ id: 'd10', name: '收件箱', kind: 'folder', value: '00_Inbox' }];
      await closePanelNow();
      H.writeNote(vaultRoot, rel, H.note('# __探针-d期-删\n\n临时的一篇\n'));
      app.vault.rescan();
      await H.settleIndex(app);
      await openBoard();
      await writeBoardCfg({ version: 1, view: { cardMode: 'content' }, sections: SEC });
      /**
       * ⚠️ `vault.rescan()` **一个事件都不发**（测试台自己那条规格里写着的）→
       * 索引得**显式重建**，否则刚造的这篇进不了索引、看板上也就没有它的卡片
       *（第一版就是这么空跑红的）。顺序也要紧：先 rebuild 再 settle。
       */
      ctx().index.rebuild();
      await H.settleIndex(app);
      await H.settle(500);
      const card = cards().find((c) => c.dataset.path === rel);
      ok(
        card,
        `看板上找得到这一篇（${rel}）｜卡片 ${cards().length} 张｜索引里有=${ctx().index.get(rel) != null}｜收件箱板块=${sections().length} 块`,
      );
      H.realClick(card?.querySelector('.kbw-card-t') as Element);
      await H.settle(300);
      eq(openPages().includes(rel), true, '面板里开着了');

      /**
       * **抓住那个视图对象本身**（不是只记一个数）：叶被 detach 之后就找不到了，
       * 但我们手里这个引用还活着 → 事后照样读得到它的 `saveCount`。
       *
       * ⚠️ 判据**必须是"有没有调 save"**，不能是"盘上有没有那个文件" ——
       * 桩的 `save()` 在没打过字（`draft == null`）时**不写盘**，
       * 而真机的 `MarkdownView.save()` 是**无条件写**的 → 看盘会**离线假绿**
       *（审查 🟡6 正是这么证到的：离线只能证到"调用链真的会跑"）。
       */
      const viewObj = (app as unknown as { __leaves: { view: unknown }[] }).__leaves
        .map((l) => l.view as { file?: { path: string } | null; saveCount?: number })
        .find((v) => v?.file?.path === rel) as { saveCount: number } | undefined;
      ok(viewObj, '找得到这一篇的编辑器视图');
      const before = viewObj?.saveCount ?? -1;
      ok(before >= 0, '拿得到它的 save 次数');

      // 真删掉（走桩的 vault.delete → 会发 delete 事件，与真机同一条链）
      const f = H.fileAt(app, rel);
      await app.vault.delete(f);
      await H.settle(400);

      eq(openPages().includes(rel), false, '那一页跟着收掉了');
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '它是最后一篇 → 面板也收掉');
      eq(H.qa(document.body, '.kbw-cw-leaf').length, 0, '叶收干净了（没有悬挂叶）');
      eq(
        viewObj?.saveCount,
        before,
        `文件都已经没了，关它的时候**不许再 save 一次**（${before} → ${viewObj?.saveCount}）`,
      );
      eq(H.exists(vaultRoot, rel), false, '删掉之后也没被写回来');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
    });

    await suite.it('真链路 · 钉住：`view.panelPinned` 落到面板上，点外面不关', async () => {
      await closePanelNow();
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', panelPinned: true },
        sections: [{ id: 'd4', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 1, '有卡片');
      H.click(cs[0].querySelector('.kbw-card-t') as Element);
      await H.settle(240);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '面板开着');

      // 点外面（**真派 mousedown**）：钉住 → 不关
      mousedownOn(document.body);
      await H.settle(220);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '**钉住时点外面不关**（IDE tool window 口径）');

      // 取消钉住 → 同一下就该关上（同一份代码，两态都认）
      const pin = H.q<HTMLElement>(document.body, '.kbw-panel-actions .kbw-iconbtn');
      eq(pin.classList.contains('is-on'), true, '图钉按钮点亮了');
      H.click(pin);
      await H.settle(340);
      eq(pin.classList.contains('is-on'), false, '取消钉住之后图钉熄灭');
      mousedownOn(document.body);
      await H.settle(240);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '不钉住了 → 点外面就关');

      // 收尾：配置拨回默认（后面的用例不该继承"钉住"）
      await writeBoardCfg({
        version: 1,
        view: {},
        sections: [{ id: 'd4', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(200);
    });

    await suite.it('真链路 · `purgeOverlays()` **先关再拆**：重载那条路上的悬挂叶修掉了', async () => {
      /**
       * 🔴 这条钉的是本期查清的那个真 bug 的**机制**：
       * 插件重载时 `onunload` 先跑（`purgeOverlays()` 拆 DOM），随后视图 `onClose →
       * 模块 dispose → 关面板` 才跑 —— 而 `close()` 第一句是 `if (!root.isConnected) return;`
       * → 提前 return，`onClose` 回调根本不执行，**那个 markdown 叶永远没人 detach**。
       * 现在 `purgeOverlays()` 先让每个浮层走完关闭流程，再拆 DOM。
       */
      await closePanelNow();
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'd5', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(300);
      const cs = cards();
      ok(cs.length >= 1, '有卡片');
      // 开两篇：**每一篇**的叶都得收掉（只收一个是最容易漏的写法）
      H.click(cs[0].querySelector('.kbw-card-t') as Element);
      await H.settle(240);
      if (cs[1]) {
        H.click(cs[1].querySelector('.kbw-card-t') as Element);
        await H.settle(240);
      }
      ok(H.maybe(document.body, '.kbw-cw-panel'), '面板开着');
      const before = H.qa(document.body, '.kbw-cw-leaf').length;
      ok(before > 0, '面板里挂着真编辑器');

      purgeOverlays();
      await H.settle(340);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '浮层被收掉了');
      eq(
        H.qa(document.body, '.kbw-cw-leaf').length,
        0,
        '编辑器 DOM 也收干净了（不是留下孤儿 DOM）',
      );
      /**
       * ⚠️ **数桩的叶栈**（真机上 `new WorkspaceLeaf(app)` 造的叶不在平台叶树里，
       * 只能数 DOM）—— 这里能数到，所以这条离线判据比真机那条更硬：
       * 真机只能看见"DOM 拆了没"，看不见"叶还活着没"。
       */
      eq(
        panelLeaves().filter((l) => !l.detached).map((l) => l.path).join('｜'),
        '',
        'purge 之后没有还活着的 markdown 叶（不留悬挂叶）',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  await suite.group('P4.5 · d2 期 · 停靠（纯函数 + 真链路）', async () => {
    /**
     * d2 做的是 §3.1 剩下的那一条：**dock** —— 让面板从"浮在工作台上面"变成
     * "钉在工作台边上"（左/右/下），而它仍然是一组 tab、仍各挂真编辑器。
     *
     * 开工时（2026-09-26）用户拍了四条：**窄档退回浮层** · **只做菜单入口** ·
     * **Esc 不关停靠面板**（停靠 ≈ 恒钉住）· **「在新标签页打开」先把面板这一篇关掉**。
     * 这一组逐条钉住它们。
     */
    async function closePanelNow(): Promise<void> {
      if (!H.maybe(document.body, '.kbw-cw-panel')) return;
      /**
       * ⚠️ **这一组不能用 Esc 收场**（d 期那组可以）：停靠态下 `Esc` 故意不关面板。
       * 直接走产品自己的关闭口（`onClose` 的必经之路），它会把窗格一并让出来 ——
       * 清场用的是产品那条路，不是绕过去改 DOM。
       */
      closeCardPanel({ reason: 'test-reset' });
      await H.settle(300);
    }
    function mousedownOn(target: Element): void {
      target.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
      );
    }
    const panelRoot = (): HTMLElement => H.q<HTMLElement>(document.body, '.kbw-cw-panel');
    /** 面板头上的图钉是不是亮着（"钉住"那条开关的界面真相） */
    const isPinnedNow = (): boolean =>
      H.maybe<HTMLElement>(document.body, '.kbw-cw-panel .kbw-pin-btn')?.classList.contains('is-on') ??
      false;
    const dockHost = (): HTMLElement => H.q<HTMLElement>(document.body, '.kbw-dock');
    const stage = (): HTMLElement => H.q<HTMLElement>(document.body, '.kbw-stage');
    const dockWhere = (): string => stage().getAttribute('data-dock') ?? '';
    const panelPages = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-cw-page');
    /** 当前那一页的路径（切 tab 只切显隐，所以"当前"= 没被 display:none 的那一个） */
    const activePagePath = (): string =>
      panelPages().find((pg) => pg.style.display !== 'none')?.dataset.path ?? '';
    /**
     * **这一篇此刻有几个活编辑器**（含平台标签那些，不只面板造的）。
     * 🔴 「在新标签页打开」那条判据必须用这个口径 —— 只数 `kbw-cw-leaf` 的话，
     * "面板叶关了、平台标签开了"与"两个都活着"看起来是一样的。
     */
    const liveFor = (
      p: string,
    ): { detached: boolean; view: { file?: { path: string }; containerEl?: HTMLElement } | null }[] =>
      (
        app as unknown as {
          __leaves: {
            detached: boolean;
            view: { file?: { path: string }; containerEl?: HTMLElement } | null;
          }[];
        }
      ).__leaves.filter((l) => !l.detached && l.view?.file?.path === p);
    const panelLeaves = (): { path: string; detached: boolean; containerEl?: HTMLElement }[] =>
      (
        app as unknown as {
          __leaves: {
            detached: boolean;
            view: { file?: { path: string }; containerEl?: HTMLElement } | null;
          }[];
        }
      ).__leaves
        .filter((l) => l.view?.containerEl?.classList?.contains('kbw-cw-leaf') === true)
        .map((l) => ({
          path: l.view?.file?.path ?? '?',
          detached: l.detached,
          containerEl: l.view?.containerEl,
        }));
    /**
     * jsdom 量不到布局（`clientWidth` 恒 0）→ 直接覆盖属性再触发一次 ResizeObserver 回调。
     * ⚠️ **每条用例收尾必须 `setBox(0, 0)` 拨回去**：这个视图根是全库共用的，
     * 留着 1400 会让后面的用例在"宽档"下跑（mount 那条也用了同一招，它只改 clientWidth）。
     */
    function setBox(w: number, h: number): void {
      const r = H.q(document.body, '.kbw-root');
      Object.defineProperty(r, 'clientWidth', { value: w, configurable: true });
      Object.defineProperty(r, 'clientHeight', { value: h, configurable: true });
      H.triggerResize();
    }
    const SEC = [{ id: 'd2', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
    const cfgFile = (): { view: { dock?: { where: string | null; size: number } } } =>
      JSON.parse(H.readNote(vaultRoot, BOARD_CFG)) as {
        view: { dock?: { where: string | null; size: number } };
      };
    const cfgOf = (extra: Record<string, unknown>): unknown => ({
      version: 1,
      view: { cardMode: 'content', ...extra },
      sections: SEC,
    });
    const navTo = (label: string): void => {
      const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
        H.textOf(b).includes(label),
      );
      ok(nav, `导航里有「${label}」`);
      H.click(nav as Element);
    };
    /** 开面板（并先把舞台尺寸设成"宽"——不设的话 jsdom 里 `clientWidth=0`，停靠一律不生效） */
    async function openPanelDocked(where: 'left' | 'right' | 'bottom', size = 380): Promise<string> {
      await closePanelNow();
      await openBoard();
      setBox(1400, 900);
      await writeBoardCfg(cfgOf({ dock: { where, size } }));
      await H.settle(320);
      const path = cards()[0]?.dataset.path ?? '';
      ok(path, '有卡片可点');
      H.realClick(cards().find((c) => c.dataset.path === path)?.querySelector('.kbw-card-t') as Element);
      await H.settle(280);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '面板开着');
      return path;
    }

    await suite.it('纯函数 · `dockFit`：放得下就用你的尺寸、放不下挤到最大、挤不动就不停靠', () => {
      const F = (where: 'left' | 'right' | 'bottom', size: number, w: number, h: number) =>
        dockFit({ where, size }, w, h);
      eq(F('left', 380, 1400, 900).applied, true, '1400 的容器放得下 380');
      eq(F('left', 380, 1400, 900).size, 380, '放得下就**用你设的那个**（别自作主张改尺寸）');
      eq(F('left', 760, 1200, 900).size, 560, '放不下就挤到能放下的最大（1200 − 主区 640）');
      eq(F('left', 380, 900, 900).size, 260, '900 只够 260（900 − 640）');
      eq(F('left', 380, 880, 900).size, 240, '刚够下限（880 − 640 = 240）');
      eq(F('left', 380, 875, 900).applied, false, '再窄 5px 就**连最小窗格都放不下** → 不停靠');
      eq(F('left', 380, 800, 900).applied, false, '窄容器一律不停靠（= 退回浮层，d2 拍板）');
      eq(F('bottom', 300, 1400, 900).size, 300, '底部吃的是高度，与宽度无关');
      eq(F('bottom', 300, 1400, 500).applied, false, '窗口太矮 → 底部也不停靠（500 − 360 = 140 < 240）');
      eq(F('bottom', 300, 700, 900).applied, true, '⚠️ 底部停靠**不看宽度够不够 640**（它不吃宽度）');
      eq(F('left', 380, 0, 900).applied, false, '量不到尺寸（隐藏/未布局）→ 不停靠，绝不按 0 算');
      eq(F('left', 380, 1400, 0).applied, false, '高度也量不到 → 同上');
      const none = dockFit({ where: null, size: 380 }, 1400, 900);
      eq(none.applied, false, '`where: null` = 不停靠');
      eq(none.size, 380, '不生效时尺寸原样带回（换边时不至于把用户的宽度弄丢）');
    });

    await suite.it('纯函数 · 生效时**绝不会是窄档**（这条挡住"停靠与窄档互相推翻"的来回翻）', () => {
      /**
       * 🔴 这条钉的是 `dockFit` 上面那段"不会来回翻"的论证：
       * 生效 ⇒ `w − 窗格宽 >= 640` ⇒ `data-w` 至少是 `mid`，**永远不会是 narrow**。
       * 少了这个不变量，就会出现"停靠一开 → 主区变窄 → 判成窄档 → 窄档退回浮层 →
       * 主区又变宽 → 又停靠"的震荡（提示词点名要防的那件事）。
       */
      for (const w of [880, 900, 1024, 1100, 1280, 1400, 1920]) {
        const f = dockFit({ where: 'left', size: 380 }, w, 900);
        ok(f.applied, `${w} 应该放得下（880 就够 240 的下限）`);
        ok(w - f.size >= 640, `${w} 生效时主区还剩 ${w - f.size}，必须 >= 640（否则会判成窄档）`);
      }
      // 底部不吃宽度 → 断点扣减必须是 0（算进去会把断点整体推错一档）
      eq(dockReserve({ applied: true, where: 'bottom', size: 300 }), 0, '底部停靠不扣宽度');
      eq(dockReserve({ applied: true, where: 'left', size: 380 }), 380, '左侧扣 380');
      eq(dockReserve({ applied: true, where: 'right', size: 520 }), 520, '右侧扣 520');
      eq(dockReserve({ applied: false, where: 'left', size: 380 }), 0, '不生效就不扣（这一条保证"dock 为 null 时行为逐字节不变"）');
    });

    await suite.it('纯函数 · 配置解析 `normalizeDock`：脏值不炸、认不出的边当不停靠、尺寸夹进范围', () => {
      eq(normalizeDock(undefined).where, null, '缺省（老配置里没这个键）= 不停靠');
      eq(normalizeDock({ where: 'left' }).size, 380, '缺尺寸用默认');
      eq(normalizeDock({ where: 'top' }).where, null, '认不出的边**当不停靠**（不猜：猜错方向比不生效烦人）');
      eq(normalizeDock({ where: 3 }).where, null, '非字符串的边也当不停靠');
      eq(normalizeDock({ where: 'left', size: 9999 }).size, 760, '上界 760');
      eq(normalizeDock({ where: 'bottom', size: 9999 }).size, 620, '底部的上界更小（不该占掉半个屏幕）');
      eq(normalizeDock({ where: 'left', size: 10 }).size, 240, '下界 240');
      eq(normalizeDock({ where: 'left', size: 'x' }).size, 380, '坏尺寸退回默认（不是 NaN）');
      eq(normalizeDock(null).where, null, '`null` 也是不停靠');

      eq(withDockSide({ where: 'bottom', size: 620 }, 'left').size, 620, '换边**保留**尺寸');
      eq(withDockSide({ where: 'left', size: 760 }, 'bottom').size, 620, '按新边的上界夹一次');
      eq(withDockSide({ where: null, size: 380 }, 'right').where, 'right', '取消之后再选边还能选上');
    });

    await suite.it('真链路 · 停靠 → 切模块 → 回来还在（窗格与 tab 都不丢）', async () => {
      const path = await openPanelDocked('left');
      eq(dockWhere(), 'left', '舞台切成左停靠');
      eq(panelRoot().parentElement, dockHost(), '面板搬进了窗格宿主');
      eq(dockHost().style.width, '380px', '窗格宽度按配置落地');
      /**
       * **停靠 ≈ 恒钉住**：点外面**不关**（那是浮层的语义，窗格不是浮层）。
       * ⚠️ 这里必须**真派 `mousedown`** —— 那条监听就挂在 `document` 的 mousedown 上，
       * `H.click` 只派 click，拿它测会**恒真**（很干净的假绿）。
       */
      ok(!isPinnedNow(), '前提：这一篇没开"钉住"（不然后面那条验的就是钉住而不是停靠）');
      mousedownOn(document.body);
      await H.settle(240);
      ok(
        H.maybe(document.body, '.kbw-cw-panel'),
        '停靠态点外面**不关**（IDE 的 tool window 不会因为点了别处就消失）',
      );

      navTo('全部笔记');
      await H.settle(500);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '切模块之后面板还在（**停靠 ≈ 恒钉住**）');
      eq(dockWhere(), 'left', '窗格也还在');
      eq(panelRoot().parentElement, dockHost(), '还在窗格宿主里（没被搬回 body）');
      eq(panelLeaves().filter((l) => !l.detached).length, 1, '叶还活着（没被 detach）');

      navTo('看板');
      await H.settle(700);
      eq(activePagePath(), path, '切回来还是那一篇');
      eq(panelRoot().parentElement, dockHost(), '切回来仍在窗格里');
      eq(panelPages().length, 1, '页数没变');

      await closePanelNow();
      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 · 停靠搬家搬的是**同一个根节点**与**同一个叶**（绝不是重建）', async () => {
      /**
       * 🔴 这条是这一期最该有的一条：面板里每一页挂的是真的 `MarkdownView`（有活 buffer
       * 与光标）。搬家若走"拆了重建"，光标会跳、最后几秒输入可能丢 —— 而这种错
       * 在界面上**看不出来**（DOM 长得一模一样）。所以判据必须是**对象身份**。
       */
      await closePanelNow();
      await openBoard();
      setBox(1400, 900);
      await writeBoardCfg(cfgOf({}));
      await H.settle(320);
      const path = cards()[0]?.dataset.path ?? '';
      ok(path, '有卡片');
      H.realClick(cards().find((c) => c.dataset.path === path)?.querySelector('.kbw-card-t') as Element);
      await H.settle(280);
      eq(dockWhere(), 'none', '先是浮层');
      const rootNode = panelRoot();
      eq(rootNode.parentElement, document.body, '浮层挂在 body 上');
      const leaf0 = panelLeaves()[0];
      ok(leaf0 && !leaf0.detached, '有一个活着的编辑器叶');
      const el0 = leaf0.containerEl;

      // 浮层 → 左侧停靠
      await writeBoardCfg(cfgOf({ dock: { where: 'left', size: 380 } }));
      await H.settle(320);
      eq(panelRoot(), rootNode, '**还是同一个面板节点**（换了就是重建了）');
      eq(panelRoot().parentElement, dockHost(), '搬进了窗格');
      eq(panelLeaves()[0]?.containerEl, el0, '**还是同一个叶**（换了就是重挂了 → 丢光标）');
      eq(panelLeaves()[0]?.detached, false, '叶没被 detach 过');

      // 停靠 → 取消停靠（另一条路，回 body）
      await writeBoardCfg(cfgOf({}));
      await H.settle(320);
      eq(dockWhere(), 'none', '取消了停靠');
      eq(panelRoot(), rootNode, '回来还是同一个节点');
      eq(panelRoot().parentElement, document.body, '回到了 body（浮层那套定位重新生效）');
      eq(panelLeaves()[0]?.containerEl, el0, '叶还是那一个');
      eq(panelPages().length, 1, '页也没重建');
    });

    await suite.it('真链路 · 容器挤窄 → 退回浮层（且浮层语义真的回来）；再变宽 → 又停靠', async () => {
      await openPanelDocked('left');
      eq(panelRoot().parentElement, dockHost(), '先停在窗格里');

      // 1400 → 800：`800 − 640 = 160 < 240` → 连最小窗格都放不下 → 退回浮层
      setBox(800, 900);
      await H.settle(60);
      eq(dockWhere(), 'none', '挤不下 → 舞台收回停靠');
      eq(dockHost().style.display, 'none', '窗格宿主藏起来');
      eq(panelRoot().parentElement, document.body, '**面板搬回 body**（不是留在隐藏的宿主里）');
      eq(panelRoot().classList.contains('is-docked'), false, '窗格形态的类也摘掉了（定位那套由它管）');

      // 变宽 → 又停靠（配置没被改，还是 left）
      setBox(1400, 900);
      await H.settle(60);
      eq(dockWhere(), 'left', '变宽之后**自动又停靠**（配置一直没变）');
      eq(panelRoot().parentElement, dockHost(), '又搬回窗格');

      // 再挤窄 → 这次验"浮层语义真的回来"：点外面就该关（停靠态下点外面是不关的）
      setBox(800, 900);
      await H.settle(60);
      mousedownOn(document.body);
      await H.settle(280);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '退回浮层之后**点外面就关**（这是浮层的定义）');

      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 · 停靠态 `Esc` **不关**；取消停靠之后 `Esc` 又能关（分层要压/弹，不是永久弹掉）', async () => {
      /**
       * d2 拍板：**停靠 ≈ 恒钉住**，`Esc` 一点就没了等于白停靠 → 关闭走「完成」/
       * 「全部关闭」/ 取消停靠。
       *
       * ⚠️ 这条真正要防的是实现方式：`dispatchEscape()` 的规矩是
       * 「层回调返回 `false` 就把这层**弹掉**」—— 图省事写成"停靠时返回 false"的话，
       * 那一层会被永久弹掉，**取消停靠之后 Esc 再也关不掉它**（很难查的半个状态）。
       * 所以这里两个方向都要验。
       */
      await openPanelDocked('left');
      eq(__escapeLabels().some((l) => l.startsWith('floating:')), false, '停靠态下浮层那一层不在栈里');
      H.keydown(document.body, 'Escape');
      await H.settle(260);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '**停靠态 Esc 不关**（它一直在那儿）');

      await writeBoardCfg(cfgOf({}));
      await H.settle(320);
      eq(dockWhere(), 'none', '取消停靠了');
      eq(
        __escapeLabels().some((l) => l.startsWith('floating:')),
        true,
        'Esc 那一层要**压回来**（不压的话下面这一下会失败）',
      );
      H.keydown(document.body, 'Escape');
      await H.settle(280);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '回浮层之后 Esc 又能关（两个方向都认）');
      setBox(0, 0);
    });

    await suite.it('真链路 · 切走模块再回来，面板**仍然跟着配置走**（换停靠边立刻生效）', async () => {
      /**
       * 🔴 这条是我自己顺着"面板跨模块存活"这条线走出来的**真缺陷**（d 期就有，
       * d2 让它变显眼了）：面板订阅的是 `deps.cfg` —— **那一个** `BoardConfigStore` 实例。
       * 切走再切回来，模块是新的、带一个**新的 store**，而面板手里那个旧 store
       * 从此再也不 `emit`（它的 file watcher 挂在旧模块的 Disposer 上，随模块一起收了）。
       * 于是"换停靠边 / 钉住 / 切档"这些**写配置**的入口对它全都失聪 ——
       * 直到用户再点一张卡片（`openCardTab` 会顺带刷新 `deps`）。
       * 症状很阴：面板好端端停在那儿，你从菜单换了边，它纹丝不动。
       */
      await openPanelDocked('left');
      navTo('全部笔记');
      await H.settle(500);
      navTo('看板');
      await H.settle(700);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '切回来面板还在（停靠 ≈ 恒钉住）');
      eq(dockWhere(), 'left', '还是左侧');

      await writeBoardCfg(cfgOf({ dock: { where: 'bottom', size: 300 } }));
      await H.settle(420);
      eq(dockWhere(), 'bottom', '换边要**当场生效**（订阅不能还挂在切走那个模块的 store 上）');
      eq(panelRoot().parentElement, dockHost(), '面板还在窗格里（只是换了一边）');
      eq(dockHost().style.height, '300px', '换到底部之后按高度落地');

      await closePanelNow();
      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 · 停靠态关面板：**每个叶都 detach**、窗格收起、配置留着（下次开还停在那儿）', async () => {
      await openPanelDocked('left');
      /**
       * 再开一篇 → **P6b ③ 起那是另开一扇窗**（一文件一扇窗）→ 要凑出
       * 「tab 条 + 全部关闭」得**先合并**（非拖动入口：`mergeWindowInto`）。
       */
      const cs = cards();
      if (cs[1]) {
        H.realClick(cs[1].querySelector('.kbw-card-t') as Element);
        await H.settle(280);
        const idA = panelOfPath(cs[0].dataset.path ?? '');
        const idB = panelOfPath(cs[1].dataset.path ?? '');
        if (idA != null && idB != null && idA !== idB) mergeWindowInto(idB, idA);
        await H.settle(260);
      }
      eq(panelPages().length, 2, '两篇都开着');
      eq(panelLeaves().filter((l) => !l.detached).length, 2, '两个活叶');

      const closeAll = H.maybe<HTMLElement>(document.body, '.kbw-cw-tabclose-all');
      ok(closeAll, 'tab 条右端有「全部关闭」');
      H.click(closeAll as Element);
      await H.settle(400);

      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '面板收掉了');
      eq(
        panelLeaves().filter((l) => !l.detached).map((l) => l.path).join('｜'),
        '',
        '**每个叶都被 detach 了**（漏一个就是悬挂叶）',
      );
      eq(dockHost().style.display, 'none', '窗格让出来了（工作台边上不该空着一条）');
      eq(cfgFile().view.dock?.where, 'left', '**配置没动** —— 那是偏好，下次点开卡片还停在这儿');

      // 再开一篇 → 仍然停在左边（偏好真的生效了）
      H.realClick(cards()[0].querySelector('.kbw-card-t') as Element);
      await H.settle(300);
      eq(dockWhere(), 'left', '再开一篇仍然停靠在左侧');
      eq(panelRoot().parentElement, dockHost(), '直接进窗格（不是先浮一下再搬）');

      await closePanelNow();
      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 · 拖分隔条改窗格大小 → 松手落盘（拖动期间只改视觉）', async () => {
      await openPanelDocked('left');
      eq(cfgFile().view.dock?.size, 380, '起始 380');
      const grip = H.q<HTMLElement>(document.body, '.kbw-dock-grip');
      /**
       * ⚠️ jsdom 里 `getBoundingClientRect()` 全是 0，所以"左侧停靠的窗格宽 = 指针 x − 舞台 left"
       * 化简成 `raw = x`。这条判据里的 700 是这么来的（真机那边由探针看几何）。
       */
      H.pointerDown(grip, { x: 100, y: 60 });
      H.pointerMove(document.documentElement, { x: 700, y: 60 });
      await H.settle(30);
      eq(dockHost().style.width, '700px', '拖动期间**实时**跟手（这时还没落盘）');
      H.pointerUp(document.documentElement, { x: 700, y: 60 });
      await H.settle(360);
      eq(cfgFile().view.dock?.size, 700, '松手才写配置（每移动一像素写一次 = 看板整块重绘一遍）');
      eq(dockHost().style.width, '700px', '落盘之后宽度不变（不会跳回去）');

      // 拖到超出上限 → 夹到"能放下的最大"（1400 − 640 = 760）
      H.pointerDown(grip, { x: 700, y: 60 });
      H.pointerMove(document.documentElement, { x: 1390, y: 60 });
      H.pointerUp(document.documentElement, { x: 1390, y: 60 });
      await H.settle(360);
      eq(cfgFile().view.dock?.size, 760, '夹到上限 760（再宽主区就低于 640 了）');

      await closePanelNow();
      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 · 「在新标签页打开」**先把面板这一篇关掉**（同一文件不许两个活编辑器）', async () => {
      /**
       * 🔴 d 期遗留的口径冲突（独立审查点出、d2 拍板定掉）：
       * 原先这个按钮**直接开**一个平台标签，而面板里那个自造叶还活着 ——
       * 同一份文件两个活编辑器，各持一份 buffer、各自整份写回，**后写的把先写的冲掉**。
       * 现在：`save()` → 关掉面板这一篇（含 detach 叶）→ 再开标签。
       */
      await closePanelNow();
      await openBoard();
      setBox(1400, 900);
      await writeBoardCfg(cfgOf({}));
      await H.settle(320);
      const isPanelLeaf = (l: { view?: { containerEl?: HTMLElement } | null }): boolean =>
        l.view?.containerEl?.classList?.contains('kbw-cw-leaf') === true;
      const path = cards()[0]?.dataset.path ?? '';
      ok(path, '有卡片');
      H.realClick(cards().find((c) => c.dataset.path === path)?.querySelector('.kbw-card-t') as Element);
      await H.settle(280);
      /**
       * ⚠️ **不能断言"这一刻只有 1 个活编辑器"**：全量跑的时候，前面的自动化用例
       * 可能给同一篇留着一个平台标签（实测栽过，单跑绿、全量红）。
       * 所以判据写成**增量**：这一篇的活编辑器数**不许涨**。
       * 涨了就是老行为（面板一个 + 平台标签一个，各自整份写回、后写的冲掉先写的）。
       */
      const beforeAll = liveFor(path).length;
      eq(liveFor(path).filter(isPanelLeaf).length, 1, '开面板时：面板里有一个活叶');

      // 点「在新标签页打开」（底部第一个按钮）
      const foot = H.qa<HTMLElement>(document.body, '.kbw-cw-panel .kbw-panel-foot .kbw-btn');
      const openTab = foot.find((b) => H.textOf(b).includes('在新标签页打开'));
      ok(openTab, '底部有「在新标签页打开」');
      H.click(openTab as Element);
      await H.settle(420);

      eq(
        liveFor(path).filter(isPanelLeaf).length,
        0,
        '面板那个叶被 detach 了（不是留着不管）',
      );
      const afterAll = liveFor(path).length;
      ok(
        afterAll <= beforeAll,
        `这一篇的活编辑器数不许涨（${beforeAll} → ${afterAll}）—— 面板那一个被**换成了**平台标签那一个`,
      );
      ok(
        liveFor(path).some((l) => !isPanelLeaf(l)),
        '平台标签那边确实开着一个（别把"全关了"当成通过）',
      );
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '面板这一篇是唯一一篇 → 整扇收掉');
      eq(panelLeaves().filter((l) => !l.detached).length, 0, '面板自造的叶一个不剩');

      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 · 容器量到 0（标签被隐藏）时：停靠态的面板**不许被踢出窗格**', async () => {
      /**
       * 🟡 d2 审查抓的：`clientWidth/clientHeight` 为 0 有两种情况 —— ① 刚挂上没布局；
       * ② **这一页被藏起来了**（非活动标签 / 窗口最小化）。按"不生效"处理的话，
       * 面板会被踢出窗格、搬到 `document.body` 上飘着（真机上"切到另一个标签去写字"
       * 就是这个形状），切回来又自己停回去 —— 一进一出很不稳。
       */
      await openPanelDocked('left');
      eq(panelRoot().parentElement, dockHost(), '前提：在窗格里');
      setBox(0, 0);
      await H.settle(240);
      eq(dockWhere(), 'left', '量不到尺寸时**别下结论**（舞台不许翻）');
      eq(panelRoot().parentElement, dockHost(), '面板也不许被踢出窗格');
      eq(dockHost().style.display, '', '宿主照样显示着');
      setBox(1400, 900);
      await H.settle(240);
      eq(panelRoot().parentElement, dockHost(), '切回来还在窗格里（本来就没动过）');

      await closePanelNow();
      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 · 拖分隔条到一半面板被关掉：**不许留下一条空窗格**', async () => {
      /**
       * 🟡 d2 审查抓的：指针监听挂在 `document` 上，所以"拖到一半面板被关掉"
       *（关掉最后一篇 / 文件被删 / 「全部关闭」）之后，**后续的 `pointermove` 照样收得到**
       * —— 于是这次拖动会把窗格又显示回一条 640px 的**空走廊**，要等下一次开面板才收。
       */
      await openPanelDocked('left');
      const grip = H.q<HTMLElement>(document.body, '.kbw-dock-grip');
      H.pointerDown(grip, { x: 100, y: 60 });
      H.pointerMove(document.documentElement, { x: 600, y: 60 });
      await H.settle(40);
      eq(dockHost().style.display, '', '前提：拖动中窗格是显示的');

      // 拖到一半，把唯一那一篇关掉（「完成」）→ 整扇收掉
      const done = H.qa<HTMLElement>(document.body, '.kbw-cw-panel .kbw-panel-foot .kbw-btn').find(
        (b) => H.textOf(b).includes('完成'),
      );
      ok(done, '底部有「完成」');
      H.click(done as Element);
      await H.settle(420);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '前提：面板收掉了');
      eq(dockWhere(), 'none', '面板收掉那一刻窗格让出来了');

      // 指针还在动（用户手里还按着）
      H.pointerMove(document.documentElement, { x: 640, y: 60 });
      await H.settle(80);
      H.pointerUp(document.documentElement, { x: 640, y: 60 });
      await H.settle(420);
      eq(dockWhere(), 'none', '**没有面板时舞台不许切回停靠**');
      eq(dockHost().style.display, 'none', '宿主也别被显示回来（那就是一条空走廊）');

      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 · 分屏两个工作台标签：口子只撤自己的，面板停在**原来那个**窗格', async () => {
      /**
       * 🟡 d2 审查抓的两半：
       *  ① 面板若从 `ctx.dock` **现取**口子，而 `ctx.dock` 是"后开的视图胜"，
       *     换一次停靠配置就可能把申请打到另一个标签上 → **那一边留一条空的 380px 走廊**；
       *  ② 视图 `onClose` 原先**无条件**把 `ctx.dock` 清掉 → 关掉任一标签都会让
       *     剩下那个标签的停靠**永久失效**。
       */
      await openPanelDocked('left');
      const host1 = dockHost();
      const leaf2 = ctx().app.workspace.getLeaf('tab');
      await leaf2.setViewState({ type: VIEW_TYPE } as never);
      await H.settle(520);
      eq(H.qa(document.body, '.kbw-root').length, 2, '前提：两个工作台视图');
      setBox(1400, 900);
      await H.settle(140);
      const host2 = H.qa<HTMLElement>(document.body, '.kbw-dock').find((x) => x !== host1);
      ok(host2, '有第二个宿主');

      // 换边：面板认的是**自己那一个口子**，所以仍在 host1 里，host2 不该被点亮
      await writeBoardCfg(cfgOf({ dock: { where: 'bottom', size: 300 } }));
      await H.settle(460);
      eq(panelRoot().parentElement, host1, '面板还在**原来那个**宿主里（认一次、用到底）');
      eq(host2!.style.display, 'none', '另一个标签的窗格**不许被点亮**（否则边上一条空走廊）');

      // 关掉第二个标签 → 第一个标签的口子必须还在
      leaf2.detach();
      await H.settle(560);
      eq(ctx().dock !== undefined, true, '**关掉第二个标签之后第一个标签仍然要有停靠口子**');
      ok(H.maybe(document.body, '.kbw-cw-panel'), '面板还在（它停在第一个标签的窗格里，不该被收）');
      eq(panelRoot().parentElement, host1, '还在 host1 里');

      await closePanelNow();
      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);
    });

    await suite.it('真链路 🔴 停靠态关掉工作台标签：每个叶都要 **save + detach**（不许被 `isConnected` 短路）', async () => {
      /**
       * 🔴 这条是 d2 独立审查抓出来的**真缺陷**，离线原先恒绿（桩比真机宽松）。
       *
       * 平台在 `View.close()` 里是 **先 `containerEl.detach()`、再 `await this.onClose()`**
       *（asar 取证见 `tests/stub` 的 `WorkspaceLeaf.detach` 注释）。而停靠态下面板 root
       * 住在工作台外壳的 `.kbw-dock` 里 —— 它是 `contentEl` 的后代 ⇒ 视图 `onClose()`
       * 跑的那一刻 **root 已经不在文档里**，于是 `ui/panel.ts` 里那句
       * `if (!root.isConnected) return;` 会把整段关闭流程整个跳过：
       * 每个 tab 不 `save()` 不 `detach()`（**丢最后几秒输入 + 悬挂叶**）、
       * `d.dispose()` 与 `component.unload()` 都不跑。而且 `purgeOverlays()` 也救不回来
       *（它同样调 `close()`）。
       *
       * 浮层态一直没露出来，只是因为 root 挂在 `document.body` 上、body 不会被拆。
       */
      await openPanelDocked('left');
      const cs = cards();
      if (cs[1]) {
        H.realClick(cs[1].querySelector('.kbw-card-t') as Element);
        await H.settle(300);
      }
      const aliveBefore = panelLeaves().length;
      eq(aliveBefore, 2, '前提：两个活着的面板叶');

      const leaves = ctx().app.workspace.getLeavesOfType(VIEW_TYPE);
      eq(leaves.length, 1, '前提：一个工作台标签');
      leaves[0].detach();
      await H.settle(560);

      /** ⚠️ **先取数、再把工作台装回来**，最后才断言 —— 断言抛了也得让后面的用例能跑 */
      const aliveAfter = panelLeaves().length;
      const domAfter = H.qa(document.body, '.kbw-cw-leaf').length;
      await ctx().activate();
      await H.settle(700);
      const viewBack = H.qa(document.body, '.kbw-root').length === 1;
      await closePanelNow();
      await writeBoardCfg(cfgOf({}));
      setBox(0, 0);
      await H.settle(200);

      eq(viewBack, true, '复位：工作台又开出来了（后面还有用例要跑）');
      eq(domAfter, 0, '编辑器 DOM 跟着视图一起没了（这一条本来就对）');
      /**
       * ⚠️ 口径是"**一个都不剩**"而不是 `filter(l => !l.detached)`：桩的 `detach()`
       * 会把叶从 `__leaves` 里**摘掉**，所以查得到的就是"没 detach 的"。
       */
      eq(aliveAfter, 0, '**关视图之后不许有活着的面板叶**（漏一个 = 悬挂叶 + 最后几秒输入没落盘）');
    });

    // ════════════════════════════════════════════════════════════
    /**
     * P6 段② · C1 / C2（用户 2026-09-27 真机反馈）：
     *   C1 小窗默认字号**比平台小一档**（C1 是 −1px；**P6b ⑤ 起改成 −2px**），不再是"跟随平台"
     *   C2 小窗默认**只显示正文**（属性块不画）
     *
     * ⚠️ 两条都改的是**默认值**，而"默认值"最容易改了个寂寞：存量 `看板配置.json`
     * 里那个 `"panelProps": "few"` 是**旧默认被物化**下来的 —— 只改常量对它一点用都没有。
     * 所以这里的判据分两半：**纯函数**（默认与迁移）+ **真链路**（真开一扇窗看它画成什么样）。
     */
    await suite.it('C1/C2 默认值：字号 = 平台−2px · 属性块默认不画（含存量 `few` 的一次性迁移）', async () => {
      /**
       * ① 字号默认 = 平台基准 **− 2**（P6b ⑤：用户 2026-09-27 第二条反馈"正文默认大小还是大了"，
       * 从 C1 的 −1 又降了一档；桩里取不到平台变量 → `platformBaseFont()` 兜底 16）。
       */
      const base = platformBaseFont();
      eq(defaultPanelFont(), base - 2, `默认字号 = 平台 ${base} − 2`);
      const page = document.createElement('div');
      applyPanelFont(page, 0);
      eq(page.style.getPropertyValue('--font-text-size'), `${base - 2}px`, '没设过 → 落到页上的就是那个默认值');
      eq(
        Number(page.style.getPropertyValue('--kbw-cw-scale')).toFixed(3),
        ((base - 2) / base).toFixed(3),
        '面板自己那几行的比例**同源**（少一处就是"只有正文变小"）',
      );
      // 设过的照设的走（默认值**不许顶掉**用户单独调过的那一篇）
      applyPanelFont(page, 21);
      eq(page.style.getPropertyValue('--font-text-size'), '21px', '这一篇单独设过 → 按它');
      // `Ctrl+滚轮` 从"没设过"起步时应当以**默认那一档**为基准（不是平台基准）
      // 默认是平台 −2 → +1 = 平台 −1（C1 的 −1 现在只是"再上一档"，不再是默认）
      eq(nextFontSize(0, true, 11, 24), base - 1, '"没设过"按 +1 → 平台 −1 那一档');

      // ② 属性块默认 none
      eq(BOARD_VIEW_DEFAULTS.panelProps, 'none', '默认档 = 不显示');
      eq(normalizeBoard({}).view.panelProps, 'none', '空配置 → none');
      /**
       * ③ **一次性迁移**：v1 文件里的 `few` 是旧默认被物化下来的 → 迁到新默认；
       * v2 文件里的 `few` 是**用户选的** → 必须留住（否则"选了等于没选"）。
       */
      eq(
        normalizeBoard(migrateLegacyView({ version: 1, view: { panelProps: 'few' } })).view.panelProps,
        'none',
        'v1 的 few（旧默认）→ 迁成新默认',
      );
      eq(
        normalizeBoard(migrateLegacyView({ version: 2, view: { panelProps: 'few' } })).view.panelProps,
        'few',
        'v2 的 few（用户选的）→ 一个字节都不动',
      );
      eq(
        normalizeBoard(migrateLegacyView({ version: 1, view: { panelProps: 'all' } })).view.panelProps,
        'all',
        'v1 里"用户真的选过 all" → 也不动（迁移只认那个旧默认值）',
      );
      eq(BOARD_CONFIG_VERSION, 2, '迁移认的版本号');
    });

    /**
     * 🔴 **迁移的接线**（P6② 独立审查 B 路 🔴2.5）：上面那条只测了 `migrateLegacyView` 这个**纯函数**，
     * 而"读盘那一个入口到底调没调它"没有任何判据 —— 把 `BoardConfigStore.apply` 里的调用删掉，
     * 全仓库照样全绿（真机那一步也帮不上忙：实验库的配置早就迁成 v2 了）。
     * 后果很实：**老用户的 v1 配置永远停在旧默认**，用户提的 C2 对他们不生效。
     */
    await suite.it('C2 真链路：盘上的 v1 + `few` 会被迁移成 `none`；v2 的 `few` 留住', async () => {
      const SEC = [{ id: 'c2m', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      const openPanelNow = async (): Promise<HTMLElement | null> => {
        await openBoard();
        const card = cards()[0];
        ok(card, '有卡片');
        H.click(H.q<HTMLElement>(card, '.kbw-card-t'));
        await H.settle(220);
        return H.maybe<HTMLElement>(document.body, '.kbw-cw-panel');
      };
      const closePanelNow = async (): Promise<void> => {
        if (!H.maybe(document.body, '.kbw-cw-panel')) return;
        // ⚠️ 停靠态下 Esc 不关（d2 拍板）→ 优先点「完成」
        const foot = H.q<HTMLElement>(document.body, '.kbw-panel-foot, .kbw-cw-panel-foot');
        if (foot) {
          const done = H.qa<HTMLElement>(foot, 'button').find((b) => H.textOf(b) === '完成');
          if (done) H.click(done);
          else H.keydown(document.body, 'Escape');
        } else H.keydown(document.body, 'Escape');
        await H.settle(300);
      };

      // ① v1 + few（= 旧默认被物化下来的样子）→ 读回来该是 none（不画属性块）
      await writeBoardCfg({ version: 1, view: { cardMode: 'content', panelProps: 'few' }, sections: SEC });
      await H.settle(340);
      const p1 = await openPanelNow();
      ok(p1, '小窗开了（v1 那份）');
      eq(H.maybe(p1 as HTMLElement, '.kbw-cw-props'), null, 'v1 的 `few` 被迁移 → 不画属性块');
      await closePanelNow();

      // ② v2 + few（= 用户真的选过）→ 必须留住
      await writeBoardCfg({
        version: BOARD_CONFIG_VERSION,
        view: { cardMode: 'content', panelProps: 'few' },
        sections: SEC,
      });
      await H.settle(340);
      const p2 = await openPanelNow();
      ok(p2, '小窗开了（v2 那份）');
      ok(H.maybe(p2 as HTMLElement, '.kbw-cw-props'), 'v2 的 `few` 留住 → 属性块照画');
      await closePanelNow();

      // 收尾：把配置拨回基线
      await writeBoardCfg({ version: BOARD_CONFIG_VERSION, view: { cardMode: 'content' }, sections: SEC });
      await H.settle(260);
    });

    await suite.it('C1/C2 真链路：开一扇小窗 → 默认不画属性块、正文页挂着 平台−1px', async () => {
      const SEC = [{ id: 'c12', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      const cfg = { version: 1, view: { cardMode: 'content' }, sections: SEC };
      await openBoard();
      await writeBoardCfg(cfg);
      await H.settle(340);
      const card = cards()[0];
      ok(card, '有卡片');
      H.click(H.q<HTMLElement>(card, '.kbw-card-t'));
      await H.settle(220);
      const panel = H.maybe<HTMLElement>(document.body, '.kbw-cw-panel');
      ok(panel, '小窗开了');
      eq(
        H.maybe(panel as HTMLElement, '.kbw-cw-pblock .kbw-cw-props'),
        null,
        '默认不画属性块（C2：只看正文）',
      );
      const pages = H.qa<HTMLElement>(document.body, '.kbw-cw-page');
      ok(pages.length > 0, '有正文页');
      ok(
        pages[0].style.getPropertyValue('--font-text-size') !== '',
        `正文页真的挂上了字号变量（${pages[0].style.getPropertyValue('--font-text-size')}）`,
      );
      /**
       * ⚠️ 这里不写死"等于 平台−1"：`platformBaseFont()` 读的是**平台那个变量**，
       * 而它就是我们的默认值算出来的那个数 —— 拿它跟自己比是**恒真**。
       * 纯函数那条（上一条用例）已经钉死了"默认 = 基准 − 2"；这一条只钉"真链路里它落了值"。
       */
      // 收尾：关窗 + 配置拨回基线
      if (H.maybe(document.body, '.kbw-cw-panel')) {
        H.keydown(document.body, 'Escape');
        await H.settle(300);
      }
      await writeBoardCfg(cfg);
      await H.settle(250);
    });
  });

  // ────────────────────────────────────────────────────────────
  /**
   * **P6b ⑥ · 预览换行**（用户 2026-09-27 原话："看板窗口笔记预览内容**要换行，默认换行
   * 显示**，也可以设置为**当前可以左右拖动的状态**"）。
   *
   * 一处开关、两处生效：**卡片摘要**与**小窗只读预览**（同一份 `view.previewWrap`），
   * 每一篇还能在面板 ⚙ 里单独覆盖（`panelByPath[].wrap`）。
   * 判据看的是**类名**（`is-nowrap`）而不是算出来的宽度 —— 换行是 CSS 的事，
   * 离线量不到真实排版（jsdom 不做布局），但"该不该折行"这件事是纯状态，量得准。
   */
  await suite.group('P6b ⑥ · 预览换行（默认折行 + 可切横向滚动 + 每篇可覆盖）', async () => {
    /** 关掉面板（这一组自己的一份：d/d2 那两组的同名学生是**组内**作用域） */
    const closePanelNow = async (): Promise<void> => {
      if (!H.maybe(document.body, '.kbw-cw-panel')) return;
      closeCardPanel({ reason: 'test-reset' });
      await H.settle(280);
    };
    /** 配置拨回基线（内容创作那一块）*/
    const resetCfg = async (): Promise<void> => {
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'w0', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(200);
    };
    const clickCard = (card: HTMLElement): void => {
      H.realClick(card.querySelector('.kbw-card-t') as Element);
    };
    const cardBodies = (): HTMLElement[] =>
      H.qa<HTMLElement>(document.body, '.kbw-card-body');

    await suite.it('⑥ 默认**折行**：卡片与面板预览都不带 `is-nowrap`', async () => {
      await closePanelNow();
      await openBoard();
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 'w1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await H.settle(300);
      ok(cardBodies().length > 0, '有卡片正文');
      eq(
        cardBodies().filter((b) => b.classList.contains('is-nowrap')).length,
        0,
        '默认**折行**（没有任何一张带 `is-nowrap`）',
      );

      // 打开一篇看小窗只读预览（那一档才谈得上换行）
      clickCard(cards()[0]);
      await H.settle(320);
      const view = H.q(document.body, '.kbw-cw-panel');
      // ⚙ → 这一篇 → 小窗正文 → 只读预览
      const gear = H.qa<HTMLElement>(view, '.kbw-panel-actions .kbw-iconbtn').find((b) =>
        (b.getAttribute('aria-label') ?? '').includes('设置'),
      );
      ok(gear, '面板头有 ⚙');
      H.click(gear as Element);
      await H.settle(140);
      const mine = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('这一篇'),
      );
      ok(mine, '菜单里有「这一篇」');
      H.click(mine as Element);
      await H.settle(140);
      const content = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('小窗正文'),
      );
      ok(content, '子菜单里有「小窗正文」');
      H.click(content as Element);
      await H.settle(140);
      const preview = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('只读预览'),
      );
      ok(preview, '有「只读预览」这一档');
      H.click(preview as Element);
      await H.settle(420);
      closeAllMenus();
      const prevBox = H.maybe<HTMLElement>(view, '.kbw-cw-preview');
      ok(prevBox, '只读预览容器在（`.kbw-cw-preview`）');
      ok(!prevBox?.classList.contains('is-nowrap'), '默认折行（不带 `is-nowrap`）');
      await closePanelNow();
      await resetCfg();
    });

    await suite.it('⑥ 关掉之后两处**一起**变横向滚动；每篇的覆盖不被默认值顶掉', async () => {
      await closePanelNow();
      await openBoard();
      const SEC = [{ id: 'w2', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', previewWrap: false },
        sections: SEC,
      });
      await H.settle(320);
      ok(cardBodies().length > 0, '有卡片正文');
      eq(
        cardBodies().filter((b) => b.classList.contains('is-nowrap')).length,
        cardBodies().length,
        '关掉预览换行 → **每一张**卡片都切到横向滚动',
      );

      /**
       * **每篇的覆盖**：`panelByPath[path].wrap` 要**压过**看板默认。
       *
       * 🔴 **这一段的夹具被独立审查 B🔴1 判成假绿**：第一版在**全局 false** 之下断言
       * 某一篇（显式 `false`）还是 `false` —— 期望值恰好等于默认值 → 任何"忽略这一篇的
       * 覆盖"的实现（连 `own === true ? true : global` 这种）都会返回 false、判据照样绿。
       * 改成三段**期望值与默认值不同**的判据：
       *  ① 全局 **true** + 这一篇 `false` → `false`（覆盖生效）
       *  ② 全局 **false** + 这一篇 `true` → `true`（反向也生效）
       *  ③ 没设过的一篇：全局 true 时 `true`、全局 false 时 `false`（真的跟随默认）
       * ⚠️ 顺带纠正一条机制说法：`false ?? x` 在 JS 里**就是** `false`（`??` 只对 null/undefined
       * 回退）—— 会踩的是 `||` / `own === true` 这类写法。
       */
      const cs = cards();
      const p0 = cs[0].dataset.path ?? '';
      const p1 = cs[1]?.dataset.path ?? p0;
      ok(p0 && p1 && p0 !== p1, '夹具要两篇不同的笔记');
      const baseView = (await ctx().configs.read('board')) as { view: Record<string, unknown> };
      const plain = '01_新知识库/02_Areas/内容创作/从没设过的那一篇.md';

      // ① 全局 true + 这一篇 false → false
      const cfgA = normalizeBoard({
        version: BOARD_CONFIG_VERSION,
        view: {
          ...baseView.view,
          previewWrap: true,
          panelByPath: withPanelPref(baseView.view as never, p0, { wrap: false }),
        },
        sections: SEC,
      });
      eq(panelWrapFor(cfgA, p0), false, '全局 true、这一篇显式 false → **false**（覆盖压过默认）');
      eq(panelWrapFor(cfgA, plain), true, '没设过的那些跟随看板默认（此刻是 true）');

      // ② 全局 false + 这一篇 true → true
      const cfgB = normalizeBoard({
        version: BOARD_CONFIG_VERSION,
        view: {
          ...baseView.view,
          previewWrap: false,
          panelByPath: withPanelPref(baseView.view as never, p1, { wrap: true }),
        },
        sections: SEC,
      });
      eq(panelWrapFor(cfgB, p1), true, '全局 false、这一篇显式 true → **true**（反向也压过默认）');
      eq(panelWrapFor(cfgB, plain), false, '同一份配置下，没设过的跟着全局（false）');

      // ③ 真链路：盘上那份配置（全局 false）里，**没设过的那一篇**在卡片上就是横向滚动
      await writeBoardCfg({
        version: BOARD_CONFIG_VERSION,
        view: { ...(baseView.view as object), previewWrap: false },
        sections: SEC,
      });
      await H.settle(400);
      eq(
        cardBodies().filter((b) => b.classList.contains('is-nowrap')).length,
        cardBodies().length,
        '全局 false → 卡片全部横向滚动（真链路与纯函数同口径）',
      );
      await closePanelNow();
      await resetCfg();
    });

    await suite.it('⑥ 空白处菜单「更多显示 › 预览换行」在，且能切回来', async () => {
      await closePanelNow();
      await openBoard();
      await resetCfg();
      /**
       * ⚠️ 空白处右键挂的是**看板体**（`bodyHost` = `.kbw-board-body`），不是 `.kbw-board` ——
       * 打在容器上事件**不会向下**跑到它身上（本项目的老账：键盘事件那条也是这个形状）。
       */
      const host = H.q(document.body, '.kbw-board-body');
      host.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(140);
      const more = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('更多显示'),
      );
      ok(more, '空白处菜单里有「更多显示」');
      H.click(more as Element);
      await H.settle(160);
      const wrap = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('预览换行'),
      );
      ok(wrap, '子菜单里有「预览换行」');
      H.click(wrap as Element);
      await H.settle(160);
      const scroll = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('横向滚动'),
      );
      ok(scroll, '有「横向滚动（不折行）」这一档');
      H.click(scroll as Element);
      await H.settle(420);
      closeAllMenus();
      // ⚠️ `H.until` 只吃**同步**判据（异步读配置得自己等落盘窗口：防抖 400ms）
      await H.settle(560);
      const saved = (await ctx().configs.read('board')) as { view?: { previewWrap?: boolean } };
      eq(saved?.view?.previewWrap, false, '选了之后**真的写进配置**（防抖落盘）');
      await resetCfg();
    });
  });
}
