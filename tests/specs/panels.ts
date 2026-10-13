/**
 * spec：P1 的**面板与安全出口** —— 快照面板 / 撤销条 / 删除到回收站 / 属性与标签面板
 *
 * 三条对应 P1 任务清单里的东西：
 *   · 撤销条：5 秒、能撤销、超时后指向快照面板（§10.1）
 *   · 快照面板：列表 / 还原 / 保留策略（**20 个 + 30 天**，P1 用户已拍板）/ 一键清理 / 显示占用（§7.6）
 *   · 批量栏：属性 / 标签 / 删除到回收站（§3.4 + §8.3 的危险项）
 *
 * 在**动库库（B）**上跑（会真删真还原）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { __resetNotices } from '../../src/ui/notify';
import { UNDO_MS, __resetUndo, hasUndoBar, showUndo } from '../../src/ui/undo-bar';
import { formatBytes } from '../../src/core/util';
import { closeAllMenus } from '../../src/ui/menu';
import { openSnapshotPanel } from '../../src/ui/snapshot-panel';
// ⑧-A：底栏"看得见"那张遍历表要用到这几个（见本文件顶部 `FOOT_CASES`）
import { openMigratePanel } from '../../src/ui/migrate-panel';
import { openBackfillPanel } from '../../src/ui/backfill-panel';
import { openCleanupPanel } from '../../src/ui/cleanup-panel';
import { openFmRepairPanel } from '../../src/ui/fm-repair-panel';
import { openRebuildPanel } from '../../src/ui/rebuild-panel';
import { openSuggestPanel } from '../../src/ui/suggest-panel';
import { openTitlePanel } from '../../src/ui/title-panel';
import { openLinkPanel } from '../../src/ui/link-panel';
import { openNewNoteDialog } from '../../src/ui/new-note';
// ⚠️ 同一文件里有**两个** `openModal` 调用点（`promptText` / `pickOne`）——
// 独立审查 B🔴4 抓到 `pickOne` 那个模态从来没被遍历过，所以两条都要进表
import { pickOne, promptText } from '../../src/ui/prompt';
import { confirm } from '../../src/ui/confirm';
// P8 期 2：建回顾卡的两栏模态（正反面）—— 同一条账：新模态要进 FOOT_CASES
import { openReviewCardDialog } from '../../src/ui/review-card';
import { openReviewGenPanel } from '../../src/ui/review-gen';
import { openReviewSession } from '../../src/ui/review-session';
import { onboardingWizardJustFinished } from '../../src/modules/home/onboarding';
import type { WorkbenchContext } from '../../src/core/context';

const KB = '01_新知识库';

/**
 * ⑧-A 的**遍历表**：一个 `openModal` 面板一行。
 *
 * · `file` —— 源文件名（不带 `.ts`）。`redline.ts` 拿它跟"从 `src/ui/` 源码里扫出来的
 *   在底栏 append 过的面板"对表 —— **加了新面板却没补这一行，那条断言会当场红**。
 * · `buttons` —— 底栏里 `.kbw-btn` 的**个数**（点名数，不是"有没有"）。数字变化（加/删按钮）
 *   时这条会红：那是提醒你"用户看得见的东西变了"，确认无误就把数字改掉。
 * · `open` —— 用**真入口**打开（`ctx` 上的那几条，或面板自己的 `openXxx(ctx)`）。
 *
 * ⚠️ 两条"点不出按钮"的边界（数字是从代码里数出来的，别照抄提示词）：
 * 向导是 **3** 个（**P7.10 起**：引言屏是 跳过介绍 / 跳过教程 / 下一步 —— 「上一步」引言屏
 * **不画**（节点整个摘掉，不是隐藏类），所以这个数还是 3；进第 1 步后它才出现
 * —— 提示词原稿写"4 个"）；
 * 确认流用最小 spec 打开是 **2** 个（取消 + 主按钮；`secondary` 才会更多）。
 */
export const FOOT_CASES: Array<{
  file: string;
  what: string;
  buttons: number;
  open: (ctx: WorkbenchContext) => void;
}> = [
  { file: 'wizard', what: '首次使用向导', buttons: 3, open: (c) => c.openWizard() },
  // P7.3b 重设计：**底栏整个去掉**（关闭走头部 ✕ / Esc，导出上移成头部图标）→ 0
  { file: 'ai-panel', what: 'AI 助手', buttons: 0, open: (c) => c.openAi() },
  { file: 'migrate-panel', what: '属性迁移', buttons: 4, open: (c) => openMigratePanel(c) },
  { file: 'backfill-panel', what: '存量补全', buttons: 3, open: (c) => openBackfillPanel(c) },
  // P7.18：退出清理（底栏 = 重新扫描 / 关闭 / 清理所选 —— 清完与没勾时主按钮置灰，节点仍在）
  { file: 'cleanup-panel', what: '退出清理（P7.18）', buttons: 3, open: (c) => openCleanupPanel(c) },
  // P7.12 · R7：改名「库体检」；「重新检查」移进 ① 那一带 → 底栏剩 3（还原…/关闭/开始纠偏…）
  { file: 'rebuild-panel', what: '库体检', buttons: 3, open: (c) => openRebuildPanel(c) },
  // P7.6：执行按钮在**段内**（搬 / 挂链两条链各自的条），底栏不挂按钮 → 0
  { file: 'suggest-panel', what: '整理建议', buttons: 0, open: (c) => openSuggestPanel(c) },
  // P7.8：执行条在面板**内**（`.kbw-title-bar`，与 suggest-panel 同款）→ 0
  { file: 'title-panel', what: 'AI 起标题（P7.8）', buttons: 0, open: (c) => openTitlePanel(c) },
  // P7.13b：执行条同样在面板**内**（同款 `.kbw-title-bar`）→ 0
  { file: 'link-panel', what: 'AI 修链（P7.13b）', buttons: 0, open: (c) => openLinkPanel(c) },
  // P7.16：修前言（执行条同样在面板**内**，`.kbw-title-bar` 同族）→ 0
  { file: 'fm-repair-panel', what: '修前言（P7.16）', buttons: 0, open: (c) => openFmRepairPanel(c) },
  { file: 'snapshot-panel', what: '快照', buttons: 2, open: (c) => openSnapshotPanel(c) },
  { file: 'keys-help', what: '快捷键表', buttons: 3, open: (c) => c.openKeysHelp() },
  { file: 'quick-switch', what: '快速切换', buttons: 1, open: (c) => c.quickSwitch() },
  { file: 'quick-capture', what: '快速捕获', buttons: 2, open: (c) => c.quickCapture() },
  { file: 'new-note', what: '新建笔记', buttons: 2, open: (c) => openNewNoteDialog(c) },
  { file: 'prompt', what: '输入对话框', buttons: 2, open: () => void promptText({ title: '测试' }) },
  {
    file: 'prompt',
    what: '挑一个（同文件的第二个模态）',
    buttons: 1,
    open: () => void pickOne<string>({ title: '测试', items: [], label: (x) => x }),
  },
  // 0 = 它本来就**没有**底栏按钮：底栏靠 `:empty` 收着（别为了凑数给它加按钮）
  { file: 'settings-panel', what: '工作台设置', buttons: 0, open: (c) => c.openWorkbenchSettings() },
  {
    file: 'onboarding',
    what: '新手清单完成提示（P7.2d）',
    buttons: 1,
    open: (c) => {
      // 全勾判据读 `onboarding` —— 先把三项摆好再喊"向导收尾"（与 wizard.ts 的调用同一条路）
      void c.settings.save({ onboarding: ['created', 'view', 'search'] }).then(() => {
        onboardingWizardJustFinished(c);
      });
    },
  },
  {
    file: 'confirm',
    what: '确认流',
    buttons: 2,
    open: () =>
      void confirm({ title: '测试', preview: [], warnings: [], notes: [], primary: { label: '好' } }),
  },
  // P8 期 2：底栏 = 取消 + 下一步 → 2（正面 Enter 跳背面、背面 Enter 提交，都不额外加按钮）
  {
    file: 'review-card',
    what: '新建回顾卡（正反面）',
    buttons: 2,
    open: () => void openReviewCardDialog({ noteLabel: '甲' }),
  },
  // P8 期 4：底栏 = 「不动它」+「入库 N 张」→ 2（每张卡的改/删在 body 的行里，不是收尾动作）
  {
    file: 'review-gen',
    what: 'AI 出稿面板（期 4）',
    buttons: 2,
    open: () => void openReviewGenPanel('甲', [{ front: '问', back: '答' }]),
  },
  // P8 期 3：底栏 = 「结束本轮」→ 1（三键在 body 里，不在底栏 —— 它们是内容不是收尾动作）
  {
    file: 'review-session',
    what: '复习浮层（期 3）',
    buttons: 1,
    open: (c) =>
      void openReviewSession(c, [
        {
          id: 'foot-case',
          note: `${KB}/00_Inbox/甲.md`,
          front: '问题',
          back: '答案',
          createdAt: 0,
          lastReview: null,
          nextReview: 0,
          interval: 1,
          reps: 0,
          lapses: 0,
        },
      ]),
  },
];

export async function specPanels(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const rows = (): HTMLElement[] => H.qa(document.body, '.kbw-trow');

  /** 最上面那个模态（快照面板本身也是模态，确认流会叠在它上面） */
  function topModal(): HTMLElement {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal');
    const last = all[all.length - 1];
    ok(last, '该有模态在屏幕上');
    return last;
  }

  /** 从确认流里点主按钮（危险态要点两下：第一下上膛，第二下才执行） */
  async function confirmPrimary(match: string, danger = false): Promise<void> {
    const modal = topModal();
    const find = (): HTMLElement | undefined =>
      H.qa<HTMLElement>(modal, '.kbw-btn').find((b) => H.textOf(b).includes(match));
    const first = find();
    ok(first, `确认流里该有「${match}」按钮`);
    H.click(first as Element);
    if (danger) {
      await H.settle(30);
      const armed = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) =>
        H.textOf(b).includes('再点一次确认'),
      );
      ok(armed, '危险态第一下只上膛（按钮变成「再点一次确认」）');
      H.click(armed as Element);
    }
    await H.settle(40);
  }

  await suite.group('撤销条（交互规格 §10.1）', async () => {
    await suite.it('存活时长就是规格写的 5 秒', () => {
      // 所有用例都自己传 ms，谁也验不到默认值 —— 把常量本身钉住
      eq(UNDO_MS, 5000, '§10.1 定的 5 秒（改这个数要先改规格）');
    });

    await suite.it('到点自动过期，并把落点指向快照面板', async () => {
      __resetUndo();
      let expired = false;
      showUndo({ text: '测试条', ms: 60, onUndo: () => undefined, onExpire: () => (expired = true) });
      ok(hasUndoBar(), '条子出来了');
      await H.settle(140);
      ok(expired, '到点触发 onExpire（超时不是"没了"，是换个入口）');
      ok(!hasUndoBar(), '条子收掉了');
    });

    await suite.it('鼠标停上去时不消失（准备点的时候别跑掉）', async () => {
      __resetUndo();
      showUndo({ text: '悬停测试', ms: 60, onUndo: () => undefined });
      const bar = H.q(document.body, '.kbw-undobar');
      bar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      await H.settle(140);
      ok(hasUndoBar(), '悬停时不该过期');
      H.click(H.q(bar, '.kbw-undobar-close'));
      await H.settle(40);
      ok(!hasUndoBar(), '点 × 之后收掉');
    });

    await suite.it('「撤销」真的把文件还原回去（走快照，不是逆运算）', async () => {
      __resetUndo();
      const rel = `${KB}/00_Inbox/__撤销条测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 撤销条测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(40);

      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);
      ctx().goNotes({ dir: '00_Inbox', selectAll: true });
      await H.settle(60);
      // 只搬刚造的那一篇（用行菜单更贴近单篇操作）
      const row = rows().find((r) => r.dataset.path === rel);
      ok(row, '找到刚造的那篇');
      row?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      );
      await H.settle(40);
      // 「移动到…」在「改」这一组里（菜单是树形的：先展开分组）
      const changeGroup = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith('改'),
      );
      ok(changeGroup, '菜单里有「改」分组');
      H.click(changeGroup as Element);
      await H.settle(40);
      const moveItem = H.qa(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('移动到…'),
      );
      ok(moveItem, '菜单里有「移动到…」');
      /**
       * **P7.1c 起是树形子菜单**（2.7 落地）：没有手打入口了 —— 展开一个目录节点、
       * 点它子菜单里的「移到「X」」。目标目录**从菜单里现挑**（别写死名字：夹具一换就假绿）。
       */
      eq(H.qa(document.body, '.kbw-menu input').length, 0, '菜单里没有输入框（原地输入那套已撤）');
      H.click(moveItem as Element);
      await H.settle(60);
      const nodeItem = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        /（\d+）/.test(H.textOf(i)),
      );
      ok(nodeItem, '子菜单里有目录树节点');
      const nodeName = H.textOf(nodeItem as HTMLElement).replace(/（\d+）.*$/, '');
      H.click(nodeItem as Element);
      await H.settle(60);
      const leaf = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith(`移到「${nodeName}」`),
      );
      ok(leaf, `子菜单里有「移到「${nodeName}」」`);
      H.click(leaf as Element);
      await H.settleIndex(app);
      ok(app.vault.getAbstractFileByPath(`${KB}/${nodeName}/__撤销条测试.md`), `搬过去了（→ ${nodeName}）`);
      ok(hasUndoBar(), '出撤销条');
      const undo = H.currentUndoButton('撤销');
      H.click(undo as Element);
      await H.settleIndex(app);
      ok(app.vault.getAbstractFileByPath(rel), '撤销把它搬回来了');
      ok(
        H.readNote(vaultRoot, rel).includes('撤销条测试'),
        '内容完好（写回原文，不是逆运算）',
      );

      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('移动到… 只能从树里选（没有手打入口 → 指不到不存在的目录，也就不可能静默建目录）', async () => {
      /**
       * 这条的**形态变了**（P7.1c · 2.7）：旧实现是就地输入框，所以判据是"打了不存在的名字 → 拒动"；
       * 现在是**树形子菜单**——候选只能从树里点，手打入口没有了，**"不静默建目录"由结构保证**。
       * 判据跟着改成两半：① 菜单里没有输入框；② 树里给出的每一个目录**盘上都真有**。
       */
      __resetUndo();
      const rel = `${KB}/00_Inbox/__拒动测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 拒动测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);
      __resetNotices();
      const row = rows().find((r) => r.dataset.path === rel);
      row?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      );
      await H.settle(40);
      const changeGroup = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith('改'),
      );
      H.click(changeGroup as Element);
      await H.settle(40);
      const moveItem = H.qa(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('移动到…'),
      );
      ok(moveItem, '菜单里有「移动到…」');
      eq(H.qa(document.body, '.kbw-menu input').length, 0, '没有手打目录的入口（输入框一个都没有）');
      H.click(moveItem as Element);
      await H.settle(60);
      const nodeNames = H.qa<HTMLElement>(document.body, '.kbw-menu-item')
        .map((i) => H.textOf(i))
        .filter((t) => /（\d+）/.test(t))
        .map((t) => t.replace(/（\d+）.*$/, ''));
      ok(nodeNames.length > 0, '树里列出了目录节点');
      for (const n of nodeNames) {
        ok(
          app.vault.getAbstractFileByPath(`${KB}/${n}`),
          `「${n}」盘上真有（选得出来的目录必然存在，也就不存在"偷偷建目录"）`,
        );
      }
      closeAllMenus();
      ok(app.vault.getAbstractFileByPath(rel), '文件没动（只是看了一遍菜单）');
      ok(
        !app.vault.getAbstractFileByPath(`${KB}/02_Areas/根本没有这个目录`),
        '目录没被偷偷建出来',
      );
      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });
  });

  await suite.group('快照面板（交互规格 §7.6）', async () => {
    await suite.it('列表 / 占用 / 保留策略文案（20 个 + 30 天）', async () => {
      // 先造两份快照（搬两次）
      const a = `${KB}/00_Inbox/__快照A.md`;
      const b = `${KB}/00_Inbox/__快照B.md`;
      H.writeNote(vaultRoot, a, H.note('# 快照A\n'));
      H.writeNote(vaultRoot, b, H.note('# 快照B\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      for (const [rel, tag] of [
        [a, 'A'],
        [b, 'B'],
      ] as const) {
        const file = H.fileAt(app, rel);
        await ctx().mover.move({
          targets: [{ dir: `${KB}/02_Areas/内容创作`, files: [file] }],
          source: 'batch',
          reason: `测试：造快照${tag}`,
        });
        await H.settleIndex(app);
      }

      const panel = await openSnapshotPanel(ctx());
      await H.settle(80);
      const list = H.q(panel.root, '.kbw-snap-list');
      const dataRows = H.qa(list, '.kbw-snap-row:not(.is-head)');
      ok(dataRows.length >= 2, `面板列出快照（${dataRows.length} 份）`);
      contains(H.textOf(list), '份内容', '每行写清涉及多少内容');
      const foot = H.textOf(panel.foot);
      contains(foot, '20', '保留策略文案带「20 个」');
      contains(foot, '30', '保留策略文案带「30 天」');
      const prune = H.qa<HTMLElement>(panel.foot, '.kbw-btn').find((x) =>
        H.textOf(x).includes('清理'),
      );
      ok(prune, '有「按保留策略清理」');
      const title = prune?.getAttribute('title') ?? '';
      const all = await ctx().snapshot.list();
      const bytes = all.reduce((sum, m) => sum + (m.totalBytes ?? 0), 0);
      contains(title, `${all.length} 个快照`, `悬停要写清份数（实际「${title}」）`);
      contains(title, '份内容', '悬停要写清内容份数');
      ok(title.includes(formatBytes(bytes)), `悬停的占用量要与实际一致（期望含 ${formatBytes(bytes)}）`);

      // 都在保留期内 → 点了也不该删东西
      const before = (await ctx().snapshot.list()).length;
      H.click(prune as Element);
      await H.settle(80);
      eq((await ctx().snapshot.list()).length, before, '保留期内不清理任何东西');
      panel.close('test');
      await H.settle(40);
      eq(H.qa(document.body, '.kbw-modal').length, 0, '关掉了');
    });

    await suite.it('还原：从面板里把某一份快照还原回去（走确认流）', async () => {
      const all = await ctx().snapshot.list();
      // 明确挑"搬的是 A 的那一份"（两份快照理由一样，不能靠顺序猜）
      const target = all.find((m) => m.moves.some((mv) => mv.to.includes('__快照A.md')));
      ok(target, '得有一份搬过 A 的快照');
      const panel = await openSnapshotPanel(ctx());
      await H.settle(80);
      const rowsAll = H.qa<HTMLElement>(panel.root, '.kbw-snap-row:not(.is-head)');
      ok(rowsAll.length >= 2, `面板里有行（${rowsAll.length}）`);
      // 行里显示的是**触发操作**（reason）→ 靠它精确定位（两份快照理由不同）
      const row = rowsAll.find((r) => H.textOf(r).includes('测试：造快照A'));
      ok(row, `找到搬过 A 的那一行：${rowsAll.map((r) => H.textOf(r).slice(0, 40)).join(' | ')}`);
      const restore = H.qa<HTMLElement>(row as Element, '.kbw-btn').find((b) =>
        H.textOf(b).includes('还原'),
      );
      H.click(restore as Element);
      await H.settle(60);
      contains(H.textOf(topModal()), '即将还原', '还原走确认流');
      await confirmPrimary('还原');
      await H.settleIndex(app);
      panel.close('test');
      await H.settle(40);
      // 那份快照里的移动被逆回去了（文件回到 Inbox）
      ok(app.vault.getAbstractFileByPath(`${KB}/00_Inbox/__快照A.md`), 'A 回到 Inbox');
      fs.rmSync(path.join(vaultRoot, `${KB}/02_Areas/内容创作/__快照A.md`), { force: true });
      fs.rmSync(path.join(vaultRoot, `${KB}/00_Inbox/__快照B.md`), { force: true });
      fs.rmSync(path.join(vaultRoot, `${KB}/02_Areas/内容创作/__快照B.md`), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(40);
    });

    /**
     * 🔴 **P7.19 收口的那一处**（独立审查 🔴1 抓到的漏网）：面板的「还原」原先写着裸
     * `await ctx.snapshot.restore(m.id)` —— `SnapshotService.restore` 在快照读不回来时**直接 throw**，
     * 而它挂在 `btn({on:{click: async () => …}})` 上（返回值被丢弃）→ 就是 B1 那只虫的
     * **同一条未捕获通道**。这条用例钉它：**paint 之后**（列表里已经有这一行）把快照删掉，
     * 再点「还原」→ 必须兜住（轻提示），不许 unhandled。
     * ⚠️ "零未捕获"那一半是**套件级**判据（runner 的 unhandled 通道会把整轮判红）——
     * 所以这条用例只要跑完不动声色，就已经在证它。
     */
    await suite.it('还原：那一份**读不回来**（paint 之后被删）→ 兜住，不 unhandled', async () => {
      const snap = await ctx().snapshot.capture({ reason: 'P7.19 · 面板兜底', files: [] });
      const panel = await openSnapshotPanel(ctx());
      await H.settle(80);
      const rowsAll = H.qa<HTMLElement>(panel.root, '.kbw-snap-row:not(.is-head)');
      const row = rowsAll.find((r) => H.textOf(r).includes('P7.19 · 面板兜底'));
      ok(row, `面板里列出了这一份（${rowsAll.map((r) => H.textOf(r).slice(0, 30)).join(' | ')}）`);
      // ⚠️ **paint 之后、点之前**把它删掉 —— "已被消费的资源 + 迟到点击"那一族
      await ctx().snapshot.remove(snap.id);
      __resetNotices();
      const btn = H.qa<HTMLElement>(row as Element, '.kbw-btn').find((b) =>
        H.textOf(b).includes('还原'),
      );
      ok(btn, '行里有「还原」');
      H.click(btn as Element);
      await H.settle(60);
      contains(H.textOf(topModal()), '即将还原', '还是先走确认流');
      await confirmPrimary('还原');
      const notices = H.textsOf(document.body, '.kbw-notice').join(' || ');
      await H.until(() => H.textsOf(document.body, '.kbw-notice').join(' ').includes('没撤销成功'), 2000);
      contains(
        H.textsOf(document.body, '.kbw-notice').join(' || '),
        '没撤销成功',
        `读不回来的快照 → 兜住（轻提示），而不是未捕获（实际提示：${notices || '（一条都没有）'}）`,
      );
      __resetNotices();
      panel.close('test');
      await H.settle(40);
      eq(H.qa(document.body, '.kbw-modal').length, 0, '关掉了');
    });

    await suite.it('保留策略真执行：超期的会被删、保留期内的留着（库里的文件一个不动）', async () => {
      // 造一份"40 天前"的快照（比 30 天上限老）：直接写 manifest 到 snapshots/ 下
      const id = '20000101-000000';
      const dir = `${vaultRoot}/.obsidian/plugins/kb-workbench/snapshots/${id}`;
      fs.mkdirSync(`${dir}/contents`, { recursive: true });
      fs.writeFileSync(
        `${dir}/manifest.json`,
        JSON.stringify({
          id,
          reason: '测试：超期快照',
          contents: [],
          moves: [],
          newDirs: [],
          deletions: [],
          totalBytes: 0,
          at: Date.now() - 40 * 86_400_000,
          kbRoot: KB,
        }),
        'utf8',
      );
      const before = await ctx().snapshot.list();
      ok(before.some((m) => m.id === id), '超期那份在列表里');

      const panel = await openSnapshotPanel(ctx());
      await H.settle(80);
      const prune = H.qa<HTMLElement>(panel.foot, '.kbw-btn').find((x) =>
        H.textOf(x).includes('清理'),
      );
      H.click(prune as Element);
      await H.settle(80);
      contains(H.textOf(topModal()), '即将清理', '清理走确认流（危险态）');
      await confirmPrimary('清理', true);
      await H.settle(120);
      panel.close('test');
      await H.settle(60);
      const after = await ctx().snapshot.list();
      ok(!after.some((m) => m.id === id), '超期那份被删掉了');
      ok(after.length >= 1, '保留期内的没被误删');
      // 库里的文件不受影响
      ok(app.vault.getAbstractFileByPath(`${KB}/00_Inbox/_收件箱.md`), '库里的笔记一个没动');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await suite.it('删单份快照：危险态两下，且不影响库里的文件', async () => {
      const before = await ctx().snapshot.list();
      ok(before.length > 0, '得有快照可删');
      const id = before[0].id;
      const panel = await openSnapshotPanel(ctx());
      await H.settle(80);
      const del = H.qa<HTMLElement>(panel.root, '.kbw-snap-row .kbw-btn').find((b) =>
        H.textOf(b).includes('删除'),
      );
      ok(del, '每行有「删除」');
      H.click(del as Element);
      await H.settle(60);
      await confirmPrimary('删除', true);
      panel.close('test');
      await H.settle(60);
      const after = await ctx().snapshot.list();
      eq(after.length, before.length - 1, '少了一份');
      ok(
        !(await ctx().snapshot.read(id)),
        '那份真的没了',
      );
    });

    await suite.it('R3（P7.12）：打开前先备数据 —— 面板返回那一刻列表已画好（没有"无列表"帧）', async () => {
      /**
       * 批注实拍（FB4-二批-6）：原来先开门、`paint()` 里 `await list()` 后补列表
       * → 闪一帧"只有外壳"的半成品。修法 = 先把数据备好再开（`openSnapshotPanel`
       * 现在等 `list()` 回来才开门）。判据：`await openSnapshotPanel(...)` 返回**那一刻**
       * 列表行当场就在 —— 旧实现此刻是空的（要等下一个微任务才画）。
       */
      const rel = `${KB}/00_Inbox/__快照R3.md`;
      H.writeNote(vaultRoot, rel, H.note('# R3\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const shot = await ctx().mover.move({
        targets: [{ dir: `${KB}/02_Areas/内容创作`, files: [H.fileAt(app, rel)] }],
        source: 'batch',
        reason: '测试：R3 备数据',
      });
      await H.settleIndex(app);

      const panel = await openSnapshotPanel(ctx());
      const rowsNow = H.qa<HTMLElement>(panel.root, '.kbw-snap-row:not(.is-head)');
      ok(rowsNow.length > 0, `返回那一刻列表就画好了（当场 ${rowsNow.length} 行）`);
      contains(H.textOf(panel.root), '测试：R3 备数据', '而且画的就是新数据（不是空壳）');
      panel.close('test');
      await H.settle(40);
      // 清场：删掉这次搬出来的文件与那份快照
      fs.rmSync(path.join(vaultRoot, `${KB}/02_Areas/内容创作/__快照R3.md`), { force: true });
      if (shot.snapshotId) await ctx().snapshot.remove(shot.snapshotId);
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(40);
    });
  });

  await suite.group('删除到回收站（危险项）', async () => {
    await suite.it('两下确认才删；撤销能把内容找回来', async () => {
      app.vault.setConfig('trashOption', 'local'); // 只有 local 能程序化拿回
      const rel = `${KB}/00_Inbox/__待删除.md`;
      H.writeNote(vaultRoot, rel, H.note('# 待删除\n\n别丢了\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(40);
      __resetUndo();
      __resetNotices();

      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);
      const row = rows().find((r) => r.dataset.path === rel);
      ok(row, '找到那篇');
      H.click(row as Element);
      await H.settle(20);
      const more = H.qa<HTMLElement>(document.body, '.kbw-notes-bar .kbw-btn').find((b) =>
        H.textOf(b).includes('更多'),
      );
      ok(more, '批量栏有「更多」');
      H.click(more as Element);
      await H.settle(40);
      const del = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('删除'),
      );
      ok(del, '菜单里有删除');
      eq(del?.classList.contains('is-danger'), true, '删除是危险项');
      H.click(del as Element);
      await H.settle(60);
      await confirmPrimary('删除', true);
      await H.settleIndex(app);

      ok(!app.vault.getAbstractFileByPath(rel), '库里没了');
      eq(app.vault.systemTrashed.length, 0, '走的是库内 .trash（trashOption: local）');
      ok(H.exists(vaultRoot, `.trash/__待删除.md`), '进了 .trash');
      ok(hasUndoBar(), '删除也出撤销条（快照里有原文）');

      const undo = H.currentUndoButton('撤销');
      H.click(undo as Element);
      await H.settleIndex(app);
      ok(app.vault.getAbstractFileByPath(rel), '撤销把文件重建回来了');
      contains(H.readNote(vaultRoot, rel), '别丢了', '内容完整');

      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      fs.rmSync(path.join(vaultRoot, '.trash'), { recursive: true, force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });
  });

  await suite.group('删除到回收站 · 平台设置是「不删除」时', async () => {
    await suite.it('trashOption=none → 危险按钮置灰并写明原因（点了也不会假装删了）', async () => {
      app.vault.setConfig('trashOption', 'none');
      try {
        const rel = `${KB}/00_Inbox/__不删除测试.md`;
        H.writeNote(vaultRoot, rel, H.note('# 不删除测试\n'));
        app.vault.rescan();
        ctx().index.rebuild();
        ctx().goNotes({ dir: '00_Inbox' });
        await H.settle(60);
        const row = rows().find((r) => r.dataset.path === rel);
        ok(row, '找到那篇');
        H.click(row as Element);
        await H.settle(20);
        const more = H.qa<HTMLElement>(document.body, '.kbw-notes-bar .kbw-btn').find((b) =>
          H.textOf(b).includes('更多'),
        );
        H.click(more as Element);
        await H.settle(40);
        const del = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('删除'),
        );
        H.click(del as Element);
        await H.settle(60);
        const modal = topModal();
        const danger = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) =>
          H.textOf(b).includes('删除'),
        );
        ok(danger, '确认流里有删除按钮');
        eq(danger?.hasAttribute('disabled'), true, '平台设置是「不删除」→ 按钮要置灰');
        contains(H.textOf(modal), '不删除', '置灰的原因要写在界面上');
        // 关掉确认流，文件不该动
        H.keydown(modal, 'Escape');
        await H.settle(60);
        ok(app.vault.getAbstractFileByPath(rel), '文件还在（根本没删）');
        fs.rmSync(path.join(vaultRoot, rel), { force: true });
        app.vault.rescan();
        ctx().index.rebuild();
      } finally {
        app.vault.setConfig('trashOption', 'local');
      }
    });
  });

  await suite.group('属性与标签（单篇走菜单 / 批量走面板）', async () => {
    await suite.it('单篇：行菜单 改 › 属性 › 状态 › 已完成', async () => {
      const rel = `${KB}/00_Inbox/__属性测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 属性测试\n', {}, { 状态: '进行中' }));
      app.vault.rescan();
      ctx().index.rebuild();
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);
      __resetNotices();

      const row = rows().find((r) => r.dataset.path === rel);
      ok(row, '找到那篇');
      row?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(40);
      const pickMenu = async (label: string): Promise<void> => {
        const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).startsWith(label),
        );
        ok(item, `菜单里有「${label}」`);
        H.click(item as Element);
        await H.settle(40);
      };
      await pickMenu('改');
      await pickMenu('属性');
      await pickMenu('核心'); // 属性按分组进子菜单（一级不超 8 项的硬规矩）
      await pickMenu('状态');
      await pickMenu('已完成');
      await H.settleIndex(app);
      ctx().index.rebuild();
      contains(
        H.readNote(vaultRoot, rel),
        '状态: 已完成',
        '属性真的写进前言了（单篇轻量改动不走确认流）',
      );

      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('批量：面板选属性+值 → 确认流 → 两篇一起改', async () => {
      const a = `${KB}/00_Inbox/__批量属性A.md`;
      const b = `${KB}/00_Inbox/__批量属性B.md`;
      H.writeNote(vaultRoot, a, H.note('# 批量属性A\n', {}, { 状态: '进行中' }));
      H.writeNote(vaultRoot, b, H.note('# 批量属性B\n', {}, { 状态: '进行中' }));
      app.vault.rescan();
      ctx().index.rebuild();
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);

      const targetA = rows().find((r) => r.dataset.path === a);
      const targetB = rows().find((r) => r.dataset.path === b);
      ok(targetA && targetB, '两篇都在');
      H.click(targetA as Element);
      H.click(targetB as Element, { ctrlKey: true });
      await H.settle(30);
      const propBtn = H.qa<HTMLElement>(document.body, '.kbw-notes-bar .kbw-btn').find((x) =>
        H.textOf(x) === '属性',
      );
      H.click(propBtn as Element);
      await H.settle(60);
      const panel = H.q(document.body, '.kbw-panel');
      contains(H.textOf(panel), '改 2 篇的属性', '面板标题');
      // 属性默认就是「状态」；值用多选控件：输入 → Enter 选第一个候选
      const input = H.q<HTMLInputElement>(panel, '.kbw-multiselect input');
      input.focus();
      await H.settle(30);
      input.value = '已完成';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(30);
      H.keydown(input, 'Enter');
      await H.settle(30);
      const next = H.qa<HTMLElement>(panel, '.kbw-btn').find((x) => H.textOf(x).includes('下一步'));
      H.click(next as Element);
      await H.settle(60);
      await confirmPrimary('改 2 篇');
      await H.settleIndex(app);
      ctx().index.rebuild();
      contains(H.readNote(vaultRoot, a), '状态: 已完成', 'A 改了');
      contains(H.readNote(vaultRoot, b), '状态: 已完成', 'B 改了');

      for (const rel of [a, b]) fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('标签面板：加一个标签（走确认流）', async () => {
      const a = `${KB}/00_Inbox/__标签A.md`;
      const b = `${KB}/00_Inbox/__标签B.md`;
      H.writeNote(vaultRoot, a, H.note('# 标签A\n'));
      H.writeNote(vaultRoot, b, H.note('# 标签B\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);

      const tA = rows().find((r) => r.dataset.path === a);
      H.click(tA as Element);
      H.click(rows().find((r) => r.dataset.path === b) as Element, { ctrlKey: true });
      await H.settle(30);
      const tagBtn = H.qa<HTMLElement>(document.body, '.kbw-notes-bar .kbw-btn').find((x) =>
        H.textOf(x) === '标签',
      );
      H.click(tagBtn as Element);
      await H.settle(60);
      const panel = H.q(document.body, '.kbw-panel');
      const input = H.q<HTMLInputElement>(panel, '.kbw-multiselect input');
      input.focus();
      await H.settle(30);
      input.value = '__测试标签';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      H.keydown(input, 'Enter');
      await H.settle(30);
      const next = H.qa<HTMLElement>(panel, '.kbw-btn').find((x) => H.textOf(x).includes('下一步'));
      H.click(next as Element);
      await H.settle(60);
      await confirmPrimary('标签');
      await H.settleIndex(app);
      contains(H.readNote(vaultRoot, a), '__测试标签', 'A 加上了标签');
      contains(H.readNote(vaultRoot, b), '__测试标签', 'B 加上了标签');

      for (const rel of [a, b]) fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('标签面板：一次选两个（多选控件真能收多个值）', async () => {
      const rel = `${KB}/00_Inbox/__多标签.md`;
      H.writeNote(vaultRoot, rel, H.note('# 多标签\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);
      const row = rows().find((r) => r.dataset.path === rel);
      H.click(row as Element);
      await H.settle(20);
      const tagBtn = H.qa<HTMLElement>(document.body, '.kbw-notes-bar .kbw-btn').find((x) =>
        H.textOf(x) === '标签',
      );
      H.click(tagBtn as Element);
      await H.settle(60);
      const panel = H.q(document.body, '.kbw-panel');
      const input = H.q<HTMLInputElement>(panel, '.kbw-multiselect input');
      const typeOne = async (v: string): Promise<void> => {
        input.focus();
        await H.settle(30);
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await H.settle(20);
        H.keydown(input, 'Enter');
        await H.settle(30);
      };
      await typeOne('__标签甲');
      await typeOne('__标签乙');
      const chips = H.textsOf(panel, '.kbw-multiselect-item');
      ok(chips.some((t) => t.includes('__标签甲')), `两个都要在控件里：${chips.join('|')}`);
      ok(chips.some((t) => t.includes('__标签乙')), `两个都要在控件里：${chips.join('|')}`);
      const next = H.qa<HTMLElement>(panel, '.kbw-btn').find((x) => H.textOf(x).includes('下一步'));
      H.click(next as Element);
      await H.settle(80);
      await H.settleIndex(app);
      const text = H.readNote(vaultRoot, rel);
      contains(text, '__标签甲', '写盘后第一个标签在');
      contains(text, '__标签乙', '写盘后第二个标签也在（多选没丢值）');
      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('隐藏 / 取消隐藏（`隐藏: true`）与「已隐藏 1 篇」提示', async () => {
      const rel = `${KB}/00_Inbox/__隐藏测试.md`;
      H.writeNote(vaultRoot, rel, H.note('# 隐藏测试\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);

      const row = rows().find((r) => r.dataset.path === rel);
      row?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(40);
      const other = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith('其他'),
      );
      H.click(other as Element);
      await H.settle(40);
      const hide = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('隐藏这篇'),
      );
      ok(hide, '菜单里有「隐藏这篇」');
      H.click(hide as Element);
      // 界面动作是异步写盘（不 await）→ 先等它真的落到盘上，再结算缓存与索引
      ok(
        await H.until(() => H.readNote(vaultRoot, rel).includes('隐藏: true')),
        '写进了 `隐藏: true`',
      );
      await H.settleIndex(app);
      await H.settle(60);
      const liveRow = rows().find((r) => r.dataset.path === rel);
      ok(liveRow?.classList.contains('is-dimmed'), '列表里淡出但不消失（管理屏看得见）');

      // 筛选：只看隐藏
      // 右键菜单会顺手选中那一行 → 工具条此刻是批量栏，先 Esc 清掉选择
      H.keydown(H.q(document.body, '.kbw-notes'), 'Escape');
      await H.settle(40);
      const filterBtn = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
        H.textOf(b).startsWith('筛选'),
      );
      ok(filterBtn, '工具条上有「筛选」');
      H.click(filterBtn as Element);
      await H.settle(50);
      const fp = H.q(document.body, '.kbw-panel');
      const onlyHidden = H.qa<HTMLElement>(fp, '.kbw-chip.is-pickable').find((c) =>
        H.textOf(c) === '只看隐藏',
      );
      ok(onlyHidden, '筛选面板里有「只看隐藏」');
      H.click(onlyHidden as Element);
      await H.settle(50);
      eq(rows().length, 1, '只看隐藏 → 只剩它');
      // 清除全部筛选（它会顺手把面板关掉），别让筛选留给后面的用例
      const clear = H.qa<HTMLElement>(fp, '.kbw-btn').find((b) =>
        H.textOf(b).includes('清除全部筛选'),
      );
      ok(clear, '有「清除全部筛选」');
      H.click(clear as Element);
      await H.settle(60);
      eq(H.maybe(document.body, '.kbw-panel'), null, '清除后面板关掉');
      ok(rows().length > 1, '筛选清掉了（列表恢复）');

      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });
  });

  /**
   * ────────────────────────────────────────────────────────────────
   * ⑧-A · 模态底栏"看得见"（P6 第八段，用户真机报的 bug）
   *
   * 真机症状：**向导与 AI 面板底部一个按钮都不显示**（用户原话"向导界面卡在第一个选项
   * 没法切换"）。根因是 `openModal` 建完 `foot` 就打了**内联** `display:none`，
   * 而"谁 append 谁记得解开"这条隐含约定只被一半调用方遵守 —— 内联样式压得过
   * `panel.css` 的 `.kbw-modal-foot{display:flex}`。
   *
   * 🔴 **它四层判据全都没抓住**：程序化点击照常生效（按钮在、只是不可见）、
   * `textOf()` 也照样读得到（P6② 那条"`H.textOf` 判不出看不看得见"的又一次复发）。
   * ⇒ 所以这一条判的是**元素自己的状态 + 点名数一数**，不是"点得动"。
   *
   * ⚠️ **离线的边界要说清**：jsdom 里没有样式表（只吃内联样式），所以这里判两件 ——
   * ① 底栏不带内联 `display:none`；② 里面确实有 N 个按钮。
   * "真的画出来了"（computed `display !== none` + `height > 0` + `offsetHeight > 0`）
   * 由**探针在真机上判**（那才是这一轮 bug 的现场）。两条合起来才是完整判据，
   * 别把这一条当成全部 —— 而 `:empty` 那条 CSS 规则本身由 `redline.ts` 静态钉住。
   */
  await suite.it('⑧-A 全部 13 个 openModal 模态：底栏不带内联 display，且按钮数点得出来', async () => {
    /**
     * ⚠️ **前缀：快速捕获要"看板上至少有一个板块"才开浮层**（它先 `await` 读看板配置，
     * 一个板块都没有时只弹一句通知、不画浮层）。夹具库（`P4-基线`）里**没有**那份配置
     * —— 所以这里自己写一份最小的。
     *
     * 为什么敢写：`specBoard` 的**每一条**用例开头都会 `writeBoardCfg(...)` 覆盖成它自己的夹具
     *（`board.ts:703` 起十余处），所以这里留下的那份不会成为它的前提。
     * 而 `specAutomation` 只看 `自动化.json` / 目录映射，不读看板配置。
     */
    const cfgPath = `${KB}/99_Meta/06_工作台/看板配置.json`;
    H.writeNote(
      vaultRoot,
      cfgPath,
      `${JSON.stringify(
        {
          version: 1,
          view: {},
          sections: [{ id: 'footpre', name: '收件箱', kind: 'folder', value: '00_Inbox' }],
        },
        null,
        2,
      )}\n`,
    );
    app.vault.rescan();
    app.vault.trigger('modify', app.vault.getAbstractFileByPath(cfgPath));
    await H.settle(320);

    for (const c of FOOT_CASES) {
      const before = H.qa(document.body, '.kbw-modal').length;
      c.open(ctx());
      /**
       * 等它**真的开出来**（不等固定时长）：快速捕获那条是"先 `await` 读配置再画"，
       * 而 `settle(60)` 在慢机器上会抢在它前面 —— 那就成了"夹具没到"型的假红。
       */
      const opened = await H.until(() => H.qa(document.body, '.kbw-modal').length > before, 800);
      ok(opened, `${c.what}：面板该打开了`);
      const modals = H.qa<HTMLElement>(document.body, '.kbw-modal');
      const modal = modals[modals.length - 1];
      const foot = H.maybe<HTMLElement>(modal, '.kbw-modal-foot');
      ok(foot, `${c.what}：该有底栏容器`);
      const f = foot as HTMLElement;
      // 判据一：底栏自己没有内联隐藏（⑧-A 的根因就是这一句）
      ok(
        f.style.display !== 'none',
        `${c.what}：底栏不许带内联 display:none（六个面板的按钮就是这么丢的）`,
      );
      // 判据二：里面真的有几个按钮（点名数，不是"有没有东西"）
      const btns = H.qa(f, '.kbw-btn');
      eq(btns.length, c.buttons, `${c.what}：底栏该有 ${c.buttons} 个按钮`);
      // 判据三：按钮自己也不许带内联隐藏（"脚里有按钮"的下一层）
      const hiddenInline = btns.filter((b) => b.style.display === 'none');
      eq(hiddenInline.length, 0, `${c.what}：底栏里不该有内联隐藏的按钮`);
      /**
       * 判据四：**不许挂"隐藏类"**。
       *
       * 🔴 独立审查 B🔴2 实测：前三条只认**内联**样式 —— 给按钮加 `is-hidden`
       *（`.kbw-btn.is-hidden { display:none }` 是**现成的**规则，`styles/components.css`）
       * 或者给底栏加 `is-hidden` + 一条新规则，**四条判据全绿**，而真机上那一栏就是没了。
       * 离线没有样式表（jsdom 里没加载 `styles.css`），所以 `getComputedStyle` 这条更强的路走不通；
       * 能写的就是"**别挂已知的隐藏类**"这一条 —— 它覆盖的是本项目**自己的**写法
       *（`.is-hidden` 是全仓唯一的隐藏约定），够挡住现实里的回归形状。
       * ⚠️ 边界写在交接里：「自定义一个别的隐藏类名 + 配一条 CSS」这种仍然拦不住。
       */
      const HIDING = ['is-hidden', 'kbw-hidden', 'is-none'];
      const hiddenByClass = [f, ...btns].filter((el) =>
        HIDING.some((cls) => el.classList.contains(cls)),
      );
      eq(
        hiddenByClass.map((el) => `${el.tagName}.${el.className}`).join(' | '),
        '',
        `${c.what}：底栏与按钮都不许挂隐藏类（离线看不见 CSS，这条是那一半的兜底）`,
      );

      // 关掉走界面（✕ 是每个模态都有的那一个）—— 别把面板留给下一条用例
      const x = H.q<HTMLElement>(modal, '.kbw-iconbtn[aria-label="关闭"]');
      ok(x, `${c.what}：模态该有 ✕`);
      H.click(x);
      await H.settle(40);
      eq(H.qa(document.body, '.kbw-modal').length, before, `${c.what}：✕ 该关掉它`);
    }
  });
}
