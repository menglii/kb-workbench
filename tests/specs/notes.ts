/**
 * spec：全部笔记（P1）—— 目录树 / 表格 / 选择 / 筛选 / 拖拽 / 批量栏 / 撤销条
 *
 * 对应完成定义（开发计划.md §6）：
 *   「把 00_Inbox 全选迁移到 02_Areas/内容创作；撞名被拦住；撤销条能撤回；
 *     首页显示『收件箱 0 篇待整理』」
 *
 * 全部在**动库库（B）**上跑 —— 这些用例真的会搬文件、改名、删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { __resetNotices } from '../../src/ui/notify';
import { __resetUndo, hasUndoBar } from '../../src/ui/undo-bar';
import { closeAllMenus } from '../../src/ui/menu';
import { asList } from '../../src/services/schema';
import { dateTokenOf, isoWeekOf, parseDateTerm, splitDateQuery, weeksInIsoYear } from '../../src/modules/notes/filters';
import { formatRelativeTime } from '../../src/core/util';

const KB = '01_新知识库';

export async function specNotes(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const rows = (): HTMLElement[] => H.qa(document.body, '.kbw-trow');
  const rowPaths = (): string[] => rows().map((r) => r.dataset.path ?? '');
  const treeItems = (): HTMLElement[] => H.qa(document.body, '.kbw-tree-item');

  /**
   * P6b ② 起「全部笔记」的列表**只画本层**（Windows 式），搜索/筛选则**往下找**。
   * 两条轴各有一个"应该看到谁"的判据 —— 用例里一律**从数据里取**，别写死数字：
   *   · `levelIn(dir)` = 本层（不含子目录）—— 浏览态该看到的
   *   · `underIn(dir)` = 子树（含子目录）—— 搜索/筛选态该看到的
   * ⚠️ 夹具的**库根那一层一篇都没有**（笔记都在 00_Inbox / 02_Areas 这些目录里），
   * 所以"回到整个知识库"之后浏览态列表本该是空的（`levelIn('')`）—— 那是口径正确
   *（**P7.1b 起根层也不再递归**，与 P6b ② 的每一层同款），不是坏了。
   */
  const levelIn = (dir: string): string[] =>
    ctx()
      .index.notes()
      .filter((e) => e.effectivePosition === dir)
      .map((e) => e.path)
      .sort();
  /**
   * 子树（含子目录）—— **搜索/筛选态**该看到的（"往下找"那条轴）。
   * ⚠️ **空串要单独判**：`'' + '/'` 是 `'/'`，而相对库根的路径不以 `/` 开头 ——
   * 少了这一支，`underIn('')` 只会收回"库根这一层那几篇"（实测：期望 0、实际 81）。
   * ⚠️ `underIn('')` **不再是"浏览态根层"的期望**（P7.1b 反转了 P6⑧ 的根层递归）——
   * 它现在只用于"在整库范围里往下找"的用例。
   */
  const underIn = (dir: string): string[] =>
    ctx()
      .index.notes()
      .filter(
        (e) =>
          dir === '' ||
          e.effectivePosition === dir ||
          e.effectivePosition.startsWith(`${dir}/`),
      )
      .map((e) => e.path)
      .sort();

  /** 打开「全部笔记」并等它画好 */
  async function openNotes(): Promise<void> {
    ctx().goNotes();
    await H.settle(60);
  }

  /**
   * 切到「首页」——**点导航项**，不是 `store.set`。
   *
   * ⚠️ 为什么必须走界面：`store.set({activeModule})` 只改内存状态、**不写 data.json**；
   * 只要之后有任何一次设置落盘（P3 起「自动归位」会悄悄记 `reconcileSeen`），
   * `main.ts` 的 `applySettingsToStore()` 就会按 data.json 把 activeModule **复位**，
   * 首页刚渲染出来又被换回笔记屏（P3 实测：一条用例因此假红）。
   * 点导航项 = 真路径（它会 `settings.save({activeModule})` + `store.set`），两边一致。
   */
  async function goHome(): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes('首页'),
    );
    ok(nav, '导航里有「首页」');
    H.click(nav as Element);
    await H.settle(80);
  }

  await suite.group('全部笔记 · 目录树', async () => {
    __resetNotices();
    __resetUndo();
    await openNotes();

    await suite.it('树：节点数字含子目录 · 99_Meta 默认折叠 · 点节点会筛列表', async () => {
      ok(H.maybe(document.body, '.kbw-notes'), '笔记模块挂上了');
      const items = treeItems();
      ok(items.length > 3, `树得有节点（实际 ${items.length}）`);
      // 第一个是「整个知识库」，数字 = 全部条目数（v2 · #5：模板也看得见，所以算它）
      eq(H.textOf(items[0]).includes('整个知识库'), true, '第一项是整个知识库');
      const total = ctx().index.getAll().length;
      ok(H.textOf(items[0]).includes(String(total)), `总数该是 ${total}（含模板）：${H.textOf(items[0])}`);

      // 99_Meta 默认折叠：它的子目录不该出现在树里（那棵子树没展开）
      const meta = items.find((i) => i.dataset.dir?.endsWith('99_Meta'));
      ok(meta, '有 99_Meta 节点');
      eq(meta?.getAttribute('aria-expanded'), 'false', '99_Meta 默认折叠');
      const metaChildren = items.filter((i) => i.dataset.dir?.startsWith('99_Meta/'));
      eq(metaChildren.length, 0, '折叠时子目录不渲染');

      // 点「00_Inbox」→ 列表只剩它下面的
      const inbox = treeItems().find((i) => i.dataset.dir === '00_Inbox');
      ok(inbox, '有 Inbox 节点');
      H.click(inbox as Element);
      await H.settle(60);
      const shown = rowPaths();
      ok(shown.length > 0, 'Inbox 下得有笔记');
      ok(
        shown.every((p) => p.startsWith(`${KB}/00_Inbox/`)),
        `列表该只剩 Inbox 的：${shown.slice(0, 3).join(' | ')}`,
      );
      // 记进配置（切走回来不变）
      ok(await H.until(() => ctx().settings.get().treeSelected === '00_Inbox'), '选中的目录写进了配置（防抖 400ms）');
    });

    await suite.it('树：展开/折叠写进配置', async () => {
      const meta = treeItems().find((i) => i.dataset.dir === '99_Meta');
      ok(meta, '有 99_Meta 节点');
      H.click(H.q(meta as Element, '.kbw-tree-caret'));
      await H.settle(40);
      ok(await H.until(() => ctx().settings.get().treeOpen.includes('99_Meta')), '展开状态记进了配置');
      const kids = treeItems().filter((i) => i.dataset.dir?.startsWith('99_Meta/'));
      ok(kids.length > 0, '展开后子目录该出现');
    });
  });

  await suite.group('全部笔记 · 表格', async () => {
    await suite.it('排序：点表头升序，再点降序，同时只有一列参与', async () => {
      H.click(treeItems()[0]); // 回到整个知识库
      await H.settle(60);
      const nameTh = H.qa(document.body, '.kbw-table th').find((th) => H.textOf(th).startsWith('名称'));
      ok(nameTh, '有「名称」表头');
      H.click(nameTh as Element);
      await H.settle(40);
      ok(
        await H.until(() => ctx().settings.get().notesSort?.key === 'name' && ctx().settings.get().notesSort?.dir === 'asc'),
        '排序记进配置（第一次升序）',
      );
      const asc = rowPaths();
      const base = (p: string): string => (p.split('/').pop() ?? '').replace(/\.md$/, '');
      // 同名笔记（不同目录）之间先后不定 —— 只断言"整体是升序"，不钉死字典序
      const isAsc = (list: string[]): boolean => {
        const names = list.map(base);
        for (let i = 1; i < names.length; i += 1) {
          if (names[i - 1].localeCompare(names[i], 'zh') > 0) return false;
        }
        return true;
      };
      ok(isAsc(asc), `行真的是升序：${asc.slice(0, 3).map(base).join(' | ')}`);

      H.click(nameTh as Element);
      await H.settle(40);
      ok(await H.until(() => ctx().settings.get().notesSort?.dir === 'desc'), '再点一次反向');
      const desc = rowPaths();
      ok(
        ((): boolean => {
          const names = desc.map(base);
          for (let i = 1; i < names.length; i += 1) {
            if (names[i - 1].localeCompare(names[i], 'zh') < 0) return false;
          }
          return true;
        })(),
        '行真的反过来了（降序）',
      );
      eq(H.qa(document.body, '.kbw-table th.is-sorted').length, 1, '同时只有一列参与排序');
    });

    await suite.it('列显隐：分组进子菜单（一级 ≤8 项）+ 隐藏「类型」写进配置', async () => {
      const before = H.qa(document.body, '.kbw-table th[data-col="prop:类型"]').length;
      eq(before, 1, '默认能看到「类型」列');
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
      const clickColItem = async (label: string): Promise<void> => {
        const colsBtn = H.qa(document.body, '.kbw-notes-tools .kbw-btn').find((b) => H.textOf(b) === '列');
        ok(colsBtn, '有「列」按钮');
        H.click(colsBtn as Element);
        await H.settle(30);
        const top = H.qa(document.body, '.kbw-menu-item');
        ok(top.length <= 8, `列菜单一级不超 8 项（实际 ${top.length}）—— 20+ 个列必须分组`);
        const group = top.find((i) => H.textOf(i).startsWith('常用'));
        ok(group, '一级里有「常用」分组');
        H.click(group as Element);
        await H.settle(30);
        const item = H.qa(document.body, '.kbw-menu-item').find((i) => H.textOf(i).startsWith(label));
        ok(item, `子菜单里有「${label}」`);
        H.click(item as Element);
        await H.settle(40);
        closeAllMenus();
        await H.settle(30);
      };
      try {
        await clickColItem('类型');
        eq(H.qa(document.body, '.kbw-table th[data-col="prop:类型"]').length, 0, '列没了');
        ok(
          await H.until(() => (ctx().settings.get().columnsHidden ?? []).includes('prop:类型')),
          '隐藏记进了配置',
        );
      } finally {
        console.warn = orig;
      }
      eq(warns.filter((w) => w.includes('菜单违反硬规矩')).length, 0, '列菜单不该有违规告警');
      // 恢复（也走菜单：模块状态不订阅设置变化，绕过界面改设置等于没验）
      await clickColItem('类型');
      eq(H.qa(document.body, '.kbw-table th[data-col="prop:类型"]').length, 1, '恢复回来了');
    });

    await suite.it('表头右键（P7.1 · D2）：排序 › / 隐藏这一列 / 打开列设置…；名称列不可隐藏（置灰写原因）', async () => {
      closeAllMenus();
      await H.settle(20);
      const colIds = (): string[] =>
        H.qa(document.body, '.kbw-table th').map((t) => t.getAttribute('data-col') ?? '');
      /** 表头右键（走真 contextmenu 事件 —— 与行菜单/空白菜单同一条路） */
      const headerMenuOn = async (colId: string): Promise<HTMLElement> => {
        const th = H.q(document.body, `.kbw-table th[data-col="${colId}"]`);
        th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 40 }));
        await H.settle(30);
        return H.q<HTMLElement>(document.body, '.kbw-menu');
      };
      /**
       * 这条会**先藏后还原**「类型」列 —— 中途断言早退时必须把列拨回来，
       * 否则后续用例集体少一列（P7.1a 实测：一次早退串红 4 条）。
       * `finally` 保证"早退也要清场"（与探针那条纪律同一份）。
       */
      const ensureTypeVisible = async (): Promise<void> => {
        closeAllMenus();
        await H.settle(20);
        if (colIds().includes('prop:类型')) return;
        const colsBtn = H.qa(document.body, '.kbw-notes-tools .kbw-btn').find((b) => H.textOf(b) === '列');
        if (!colsBtn) return;
        H.click(colsBtn);
        await H.settle(30);
        const group = H.qa(document.body, '.kbw-menu-item').find((i) => H.textOf(i).startsWith('常用'));
        if (group) H.click(group);
        await H.settle(30);
        const item = H.qa(document.body, '.kbw-menu-item').find((i) => H.textOf(i).startsWith('类型'));
        if (item) H.click(item);
        await H.settle(40);
        closeAllMenus();
        await H.settle(20);
      };

      try {
      // ① 可隐藏列：右键 → 作用域行 + 「隐藏这一列」→ 列没了 + 写进配置
      const menu1 = await headerMenuOn('prop:类型');
      contains(H.textOf(menu1), '列「类型」', '作用域行写清改的是哪一列（硬规矩 1）');
      const hideItem = H.qa(menu1, '.kbw-menu-item').find((i) => H.textOf(i).includes('隐藏这一列'));
      ok(hideItem, '有「隐藏这一列」');
      H.click(hideItem as Element);
      await H.settle(40);
      ok(!colIds().includes('prop:类型'), '列没了');
      ok(
        await H.until(() => (ctx().settings.get().columnsHidden ?? []).includes('prop:类型')),
        '隐藏记进了配置（与「列」菜单同一份状态）',
      );

      // ② 名称列（fixed）：那一项**置灰并写明原因**（不是不画 —— 位置不许跳）
      const menu2 = await headerMenuOn('name');
      const hide2 = H.qa(menu2, '.kbw-menu-item').find((i) => H.textOf(i).includes('隐藏这一列'));
      ok(hide2, '名称列的菜单里也有这一项');
      eq(hide2?.getAttribute('aria-disabled'), 'true', '名称列上「隐藏这一列」置灰');
      contains(H.textOf(hide2), '名称列不可隐藏', '置灰要写出原因');
      closeAllMenus();
      await H.settle(20);

      // ②b 不可排序的列（「标记」没有 sortValue）：置灰并写明原因
      const menu2b = await headerMenuOn('flags');
      const sort2b = H.qa(menu2b, '.kbw-menu-item').find((i) => H.textOf(i).includes('排序'));
      ok(sort2b, '标记列的菜单里也有「排序」');
      eq(sort2b?.getAttribute('aria-disabled'), 'true', '不可排序列上「排序」置灰（不是不画）');
      contains(H.textOf(sort2b), '这一列不参与排序', '置灰要写出原因');
      closeAllMenus();
      await H.settle(20);

      // ③ 排序 ›：点「降序」→ 记进配置（**明确方向**，不是 toggle）
      const menu3 = await headerMenuOn('mtime');
      const sortItem = H.qa(menu3, '.kbw-menu-item').find((i) => H.textOf(i).includes('排序'));
      ok(sortItem, '有「排序 ›」');
      H.click(sortItem as Element);
      await H.settle(30);
      const descItem = H.qa(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('降序'));
      ok(descItem, '子菜单里有「降序」');
      H.click(descItem as Element);
      await H.settle(40);
      ok(
        await H.until(
          () => ctx().settings.get().notesSort?.key === 'mtime' && ctx().settings.get().notesSort?.dir === 'desc',
        ),
        '排序（修改时间 · 降序）记进配置',
      );

      // ④ 「打开列设置…」：菜单**就地换成**「表格的列」，并真的能用（把「类型」勾回来）
      const menu4 = await headerMenuOn('prop:状态');
      /**
       * 🔴 **先派一次 mouseenter**（独立审查 R1 的复现路径）：真机鼠标移向
       * 「打开列设置…」时会**掠过**「排序」行 —— mouseenter 把 排序子菜单开出来、
       * 且它**不会**自己关（全文件没有 mouseleave）。refresh 若照旧 "reopen 同一下标"，
       * 就会拿**旧下标**去展开**新 spec**里的另一个分组（换完内容就多飞出一个「定位」）。
       * 只派 click 的旧写法没有 mouseenter，这条恒绿 —— 必须手动补这一发。
       */
      const sortRow = H.qa(menu4, '.kbw-menu-item').find((i) => H.textOf(i).includes('排序'));
      sortRow?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      await H.settle(30);
      ok(H.maybe(document.body, '.kbw-menu.is-sub'), '前提：掠过「排序」时它的子菜单真的开了');

      const openItem = H.qa(menu4, '.kbw-menu-item').find((i) => H.textOf(i).includes('打开列设置'));
      ok(openItem, '有「打开列设置…」');
      // 真实鼠标的完整路径：**先悬停到目标行再点**（activeIndex 会跟到这一行）——
      // 只把指针停在「排序」上就点，是现实里到不了的状态（点谁必先悬到谁）
      openItem?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      await H.settle(30);
      H.click(openItem as Element);
      await H.settle(30);
      const menu5 = H.q(document.body, '.kbw-menu');
      contains(H.textOf(menu5), '表格的列', '菜单换成了列设置（就地换内容，不关窗重开）');
      eq(
        H.qa(document.body, '.kbw-menu.is-sub').length,
        0,
        '换完内容不该有子菜单自动飞出（旧下标属于旧 spec，别拿它去展开新 spec 的分组）',
      );
      const group = H.qa(menu5, '.kbw-menu-item').find((i) => H.textOf(i).startsWith('常用'));
      ok(group, '列设置里有「常用」分组');
      H.click(group as Element);
      await H.settle(30);
      const typeItem = H.qa(document.body, '.kbw-menu-item').find((i) => H.textOf(i).startsWith('类型'));
      ok(typeItem, '子菜单里有「类型」');
      H.click(typeItem as Element);
      await H.settle(40);
      closeAllMenus();
      await H.settle(30);
      ok(colIds().includes('prop:类型'), '「类型」列回来了');
      ok(
        await H.until(() => !(ctx().settings.get().columnsHidden ?? []).includes('prop:类型')),
        '取消隐藏也落盘',
      );

      // 收尾：排序拨回组内基线（前一条「排序」用例留下的 name · desc；同样走表头菜单）
      const menu6 = await headerMenuOn('name');
      const sort6 = H.qa(menu6, '.kbw-menu-item').find((i) => H.textOf(i).includes('排序'));
      H.click(sort6 as Element);
      await H.settle(30);
      const desc6 = H.qa(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('降序'));
      H.click(desc6 as Element);
      await H.settle(40);
      ok(
        await H.until(
          () => ctx().settings.get().notesSort?.key === 'name' && ctx().settings.get().notesSort?.dir === 'desc',
        ),
        '收尾：排序拨回 name · desc（组内后续用例的基线）',
      );
      } finally {
        await ensureTypeVisible();
      }
    });

    /**
     * **表头右键 · 日期列**（P7.12 · 21.5「列头也给同粒度入口」）：
     * 日期列的菜单多一组「按日期筛 ›」（今天 / 本周 / 本月 / 今年 —— 日/周/月/年四粒度各一枚），
     * 点某枚 = 把现算的裸写词落进 `filters.created`；**非日期列不许有这组**。
     */
    await suite.it('表头右键 · 日期列：「按日期筛 ›」四粒度入口 → 落进筛选；非日期列没有', async () => {
      closeAllMenus();
      await H.settle(20);
      const colIds = (): string[] =>
        H.qa(document.body, '.kbw-table th').map((t) => t.getAttribute('data-col') ?? '');
      const headerMenuOn = async (colId: string): Promise<HTMLElement> => {
        const th = H.q(document.body, `.kbw-table th[data-col="${colId}"]`);
        th.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 40 }),
        );
        await H.settle(30);
        return H.q<HTMLElement>(document.body, '.kbw-menu');
      };
      /** 「列」菜单切一列显隐（与上面那条用例同一套路，本地版） */
      const toggleColumn = async (groupLabel: string, itemLabel: string): Promise<void> => {
        const colsBtn = H.qa(document.body, '.kbw-notes-tools .kbw-btn').find(
          (b) => H.textOf(b) === '列',
        );
        ok(colsBtn, '有「列」按钮');
        H.click(colsBtn as Element);
        await H.settle(30);
        const group = H.qa(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).startsWith(groupLabel),
        );
        ok(group, `列菜单里有「${groupLabel}」分组`);
        H.click(group as Element);
        await H.settle(30);
        const item = H.qa(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).startsWith(itemLabel),
        );
        ok(item, `子菜单里有「${itemLabel}」`);
        H.click(item as Element);
        await H.settle(40);
        closeAllMenus();
        await H.settle(30);
      };
      const weUnhid = !colIds().includes('prop:创建日期');
      try {
        H.click(treeItems()[0]); // 回整库：筛选态是"往下找"，期望好算
        await H.settle(50);
        if (weUnhid) await toggleColumn('其他', '创建日期');
        ok(colIds().includes('prop:创建日期'), '「创建日期」列可见（默认隐藏，这里显式打开）');

        // ① 非日期列（类型）：没有这组
        const menuT = await headerMenuOn('prop:类型');
        eq(
          H.qa(menuT, '.kbw-menu-item').some((i) => H.textOf(i).includes('按日期筛')),
          false,
          '非日期列的菜单里没有「按日期筛」',
        );
        closeAllMenus();
        await H.settle(20);

        // ② 日期列：有；四个粒度都在
        const menuD = await headerMenuOn('prop:创建日期');
        const dfItem = H.qa(menuD, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('按日期筛'),
        );
        ok(dfItem, '日期列有「按日期筛 ›」');
        H.click(dfItem as Element);
        await H.settle(30);
        const subItems = H.qa(document.body, '.kbw-menu.is-sub .kbw-menu-item').map((i) =>
          H.textOf(i).trim(),
        );
        for (const label of ['今天', '本周', '本月', '今年']) {
          ok(subItems.includes(label), `子菜单有「${label}」（四粒度入口）`);
        }

        // ③ 点「今年」→ filters.created = 今年的裸写词（经界面断言：徽标 + 列表）
        const yearTok = dateTokenOf(new Date(), 'year');
        const expected = ctx()
          .index.notes()
          .filter((e) => String(e.props['创建日期'] ?? '').startsWith(`${yearTok}-`))
          .map((e) => e.path)
          .sort();
        /**
         * ⚠️ 独立审 B6（P7.12 收尾）：夹具日期写死 2026-*，而 `yearTok` 是**现算**的 ——
         * 过掉 2026 之后 expected 与实现**同为空**，`'' === ''` 静默通过。加一道前置，
         * 让"夹具需要翻新"在到期那天变成一次**可见的红**，而不是永远绿。
         */
        ok(expected.length > 0, '前提：夹具里有"今年"创建的笔记（写了死日期的夹具到点要翻新）');
        const yearItem = H.qa(document.body, '.kbw-menu.is-sub .kbw-menu-item').find(
          (i) => H.textOf(i).trim() === '今年',
        );
        ok(yearItem, '找得到「今年」那一枚');
        H.click(yearItem as Element);
        await H.settle(60);
        const fbtn = H.qa(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
          H.textOf(b).startsWith('筛选'),
        );
        contains(H.textOf(fbtn as Element), '筛选 1', '筛选徽标按 1 条算（创建日期也算进条件数）');
        eq(
          rowPaths().sort().join(','),
          expected.join(','),
          `点「今年」= 按 ${yearTok} 筛（与裸写 ${yearTok} 同一个词）`,
        );
      } finally {
        // 清筛选（走界面）
        const fbtn = H.qa(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
          H.textOf(b).startsWith('筛选'),
        );
        if (fbtn) {
          H.click(fbtn as Element);
          await H.settle(60);
          const clear = H.qa<HTMLElement>(document.body, '.kbw-panel .kbw-btn').find((b) =>
            H.textOf(b).includes('清除全部筛选'),
          );
          if (clear) H.click(clear);
          await H.settle(60);
        }
        // 列恢复默认隐藏（只有本条打开过才恢复）
        if (weUnhid && colIds().includes('prop:创建日期')) {
          const m = await headerMenuOn('prop:创建日期');
          const hide = H.qa(m, '.kbw-menu-item').find((i) => H.textOf(i).includes('隐藏这一列'));
          if (hide) H.click(hide);
          await H.settle(40);
        }
        closeAllMenus();
        await H.settle(20);
      }
    });

    await suite.it('列宽拖动：拖抓手柄 → 宽度写进配置', async () => {
      const grip = H.q<HTMLElement>(document.body, '.kbw-table th[data-col="prop:类型"] .kbw-col-grip');
      const box = grip.getBoundingClientRect();
      const startX = box.left + 7;
      await H.pointerSequence([
        { el: grip, type: 'down', init: { x: startX, y: 10 } },
        { el: document.body, type: 'move', init: { x: startX + 30, y: 10 } },
        { el: document.body, type: 'move', init: { x: startX + 60, y: 10 } },
        { el: document.body, type: 'up', init: { x: startX + 60, y: 10, buttons: 0 } },
      ]);
      await H.until(() => typeof ctx().settings.get().columnWidths['prop:类型'] === 'number');
      const w = ctx().settings.get().columnWidths['prop:类型'];
      ok(typeof w === 'number' && w > 130, `宽度该变大（默认 130，实际 ${String(w)}）`);
      await ctx().settings.save({ columnWidths: {} });
      await H.settle(20);
    });

    await suite.it('默认列显隐：详情档只有 6 列（v2「领域」随退役移除；真机抓到过默认摊开 25 列）', async () => {
      const ths = H.qa(document.body, '.kbw-table th').map((t) => t.getAttribute('data-col') ?? '');
      eq(ths.length, 6, `默认该是 6 列，实际 ${ths.length}：${ths.join(',')}`);
      for (const id of ['check', 'flags', 'name', 'prop:类型', 'prop:状态', 'mtime']) {
        ok(ths.includes(id), `默认可见列里缺 ${id}（实际 ${ths.join(',')}）`);
      }
      // 默认隐藏：创建日期 / tags / 五件套之外的那些
      for (const id of ['prop:创建日期', 'prop:tags', 'prop:文件位置', 'size']) {
        ok(!ths.includes(id), `${id} 默认该是隐藏的`);
      }
      // 列宽之和要落在容器里（默认摊开时那张表有 3126px 宽）
      const widths = H.qa(document.body, '.kbw-table col').map((c) =>
        parseFloat(c.getAttribute('style')?.match(/width:\s*(\d+)/)?.[1] ?? '0'),
      );
      const total = widths.reduce((a, b) => a + b, 0);
      ok(total < 1400, `默认 6 列的宽度和该是"能一眼看完"的量级，实际 ${total}px`);
    });

    await suite.it('视图档：两档 = 详细信息 / 网格（P7.1 删「紧凑」）；切换记进配置、界面跟着换', async () => {
      const segs = H.qa(document.body, '.kbw-seg button');
      const labels = segs.map((b) => H.textOf(b));
      eq(segs.length, 2, `P7.1 起只有两档（实际 ${labels.join('/')}）`);
      eq(labels.join('/'), '详细信息/网格', '两档各是什么（原相对次序：详情在前、网格在后）');
      ok(!labels.some((l) => l.includes('紧凑')), '「紧凑」档已删（名称+时间那档，2.1）');

      const grid = segs.find((b) => H.textOf(b).includes('网格'));
      ok(!grid?.hasAttribute('disabled'), '网格档 P6 起可用（不再是置灰占位）');
      H.click(grid as Element);
      await H.settle(60);
      ok(await H.until(() => ctx().settings.get().notesView === 'grid'), '切网格记进配置');
      ok(H.maybe(document.body, '.kbw-grid'), '网格体真的画出来了');
      eq(H.qa(document.body, '.kbw-table').length, 0, '表格体撤掉了（两档互斥）');

      // 切回详细信息
      H.click(H.qa(document.body, '.kbw-seg button').find((b) => H.textOf(b).includes('详细信息')) as Element);
      await H.settle(60);
      ok(await H.until(() => ctx().settings.get().notesView === 'detail'), '切回详细信息也记进配置');
      eq(H.qa(document.body, '.kbw-table th').length, 6, '回到详细信息：默认 6 列都回来');
    });
  });

  await suite.group('全部笔记 · 选择与键盘', async () => {
    await suite.it('单击选中 / Shift 范围 / Ctrl 加选 / 复选框 / Esc 清空', async () => {
      // P6b ② 起列表只画本层 —— 先站进一个"本层笔记够多"的目录（夹具的库根是空的）
      const dir = await H.enterTopDirWithNotes(ctx(), 8);
      ok(dir, `夹具里得有一个本层 ≥8 篇的顶层目录（进了「${dir}」）`);
      const all = rows();
      ok(all.length >= 3, '至少 3 行才好验范围选');

      H.click(all[0]);
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 1, '单击只选一行');

      H.click(all[2], { shiftKey: true });
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 3, 'Shift 单击选一段');

      H.click(all[5], { ctrlKey: true });
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 4, 'Ctrl 单击加选一个');

      // 复选框：切掉第 6 行（刚加选的那行）
      const box = H.q<HTMLInputElement>(all[5], '.kbw-rowcheck');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 3, '复选框能取消选中');

      // Esc 清空（模块的最后一层）
      H.keydown(H.q(document.body, '.kbw-notes'), 'Escape');
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, 'Esc 清空选择');
    });

    await suite.it('键盘：↓ 移动高亮 + Space 选中 + F2 就地改名 + Esc 取消', async () => {
      const root = H.q(document.body, '.kbw-root');
      // 同上：先站进有笔记的目录（这一屏是接着上一条跑的，但别依赖它）
      ok(await H.enterTopDirWithNotes(ctx(), 4), '进到一个本层 ≥4 篇的目录');
      const first = rows()[0];
      H.click(first);
      await H.settle(20);
      H.keydown(root, 'ArrowDown');
      await H.settle(20);
      const cursorRow = H.q(document.body, '.kbw-trow.is-cursor');
      eq(cursorRow.dataset.path, rows()[1].dataset.path, '↓ 把高亮移到下一行');

      H.keydown(root, ' ');
      await H.settle(20);
      ok(
        H.qa(document.body, '.kbw-trow.is-selected').some((r) => r.dataset.path === cursorRow.dataset.path),
        'Space 选中当前行',
      );

      // F2 → 输入框；Esc 取消（不改名）
      H.keydown(root, 'F2');
      await H.settle(30);
      const input = H.maybe<HTMLInputElement>(document.body, '.kbw-inline-input');
      ok(input, 'F2 出输入框');
      const before = cursorRow.dataset.path;
      H.keydown(input as Element, 'Escape');
      await H.settle(40);
      eq(H.maybe(document.body, '.kbw-inline-input'), null, 'Esc 收掉输入框');
      ok(
        ctx()
          .index.notes()
          .some((e) => e.path === before),
        '名字没变（Esc 取消）',
      );
    });

    await suite.it('F2 真改名：mover 真的动了文件 + 出撤销条', async () => {
      const root = H.q(document.body, '.kbw-root');
      ok(await H.enterTopDirWithNotes(ctx(), 2), '进到一个本层 ≥2 篇的目录');
      const target = rows()[0];
      const oldPath = target.dataset.path ?? '';
      H.click(target);
      await H.settle(20);
      H.keydown(root, 'F2');
      await H.settle(30);
      const input = H.q<HTMLInputElement>(document.body, '.kbw-inline-input');
      input.value = '__改名测试';
      H.keydown(input, 'Enter');
      await H.settleIndex(app);
      const newPath = `${oldPath.slice(0, oldPath.lastIndexOf('/'))}/__改名测试.md`;
      ok(app.vault.getAbstractFileByPath(newPath), `文件真的改名了：${newPath}`);
      ok(!app.vault.getAbstractFileByPath(oldPath), '旧路径没了');
      ok(hasUndoBar(), '改名后出了撤销条');
      // 撤销回去
      const undoBtn = H.currentUndoButton('撤销');
      ok(undoBtn, '撤销条上有撤销按钮');
      H.click(undoBtn as Element);
      await H.settleIndex(app);
      ok(app.vault.getAbstractFileByPath(oldPath), '撤销把文件搬回原名');
    });
  });

  await suite.group('全部笔记 · 搜索与筛选', async () => {
    await suite.it('搜索：输入即过滤；搜索范围可切；计数跟着变', async () => {
      // 站进一个有笔记的目录：P6b ② 起**浏览**只看本层，而**搜索**是"在这棵子树里往下找"
      const dir = await H.enterTopDirWithNotes(ctx(), 6);
      ok(dir, `进到一个本层 ≥6 篇的目录（进了「${dir}」）`);
      /**
       * ⚠️ 搜索框**在进目录之后现取**：进目录会重画工具条（`dir` 在 key 里），
       * 之前拿到的那个 input 已经**不在文档里**了 —— 往它上面写 value 等于没写
       *（真机用例踩过：搜索"没生效"，其实是写进了一个被拆掉的节点）。
       */
      const box = H.q<HTMLInputElement>(document.body, '.kbw-search');
      const level = levelIn(dir);
      const all = level.length;
      const target = ctx().index.notes().find((e) => e.path === level[0]);
      ok(target, '本层第一篇在索引里找得到');
      const keyword = String(target?.basename ?? '').slice(0, 2);
      box.value = keyword;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(40);
      const shown = rowPaths();
      ok(shown.length > 0 && shown.length < all, `搜索该收窄结果（${shown.length}/${all}）`);
      eq(
        H.textOf(H.q(document.body, '.kbw-crumbs-count')),
        `命中 ${shown.length} 篇`,
        '有搜索词时面包屑写「命中 N 篇」（浏览态才写「本层 N 篇」）',
      );

      // 范围切到「标题」后，属性值里的词就不该再命中（原来只验了配置写没写进去）
      const scope = H.q<HTMLSelectElement>(document.body, '.kbw-select.is-small');
      scope.value = 'title';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settle(30);
      ok(await H.until(() => ctx().settings.get().searchScope === 'title'), '搜索范围记进配置');
      /**
       * 「范围=标题」到底该命中什么：**basename 或路径**（`filters.matchesSearch` 的口径）。
       * ⚠️ 这一段原先断言"命中的标题里都真有这个词"—— 那是**错的期望**：
       * 路径里有这个词也算命中（`02_Areas/每日任务/9.20.md` 首段就是路径）。
       * 夹具换成迁移后的数据时它才露出来（原来那个属性词恰好不出现在任何路径里，所以一直是假绿）。
       */
      // v2：「领域」退役 → 换「状态」当那个"只在属性里出现"的词（'已完成' 不出现在任何标题/路径里）
      const propWord = ctx().index.notes().some((e) => String(e.props['状态'] ?? '') === '已完成')
        ? '已完成'
        : String(ctx().index.notes().find((e) => e.props['状态'])?.props['状态'] ?? '');
      if (propWord) {
        const inPropsOnly = ctx()
          .index.notes()
          .filter((e) => String(e.props['状态'] ?? '') === propWord)
          .filter((e) => !e.basename.includes(propWord) && !e.path.includes(propWord));
        box.value = propWord;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await H.settle(40);
        const byTitle = rowPaths();
        ok(
          byTitle.every((p) => p.includes(propWord)),
          `范围=标题时，命中的都该是"标题或路径"里真有这个词的：${byTitle.slice(0, 3).join(' | ')}`,
        );
        if (inPropsOnly.length > 0) {
          ok(
            !inPropsOnly.some((e) => byTitle.includes(e.path)),
            `只在属性值里有「${propWord}」的那 ${inPropsOnly.length} 篇，范围=标题时不该命中`,
          );
        }
        ok(byTitle.length <= underIn(dir).length, `范围=标题只会更窄（${byTitle.length}/${underIn(dir).length}）`);
      }

      // ⚠️ 先把搜索与范围**还原干净再往下走**：这条用例里任何一条断言失败都会中止整个 it，
      //    而搜索框/范围是**跨用例的共享状态** —— 不还原的话后面每一条都会连带变红
      //    （P3 实测：一条断言失败把后面 10 条一起带红，排查了半天）
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      scope.value = 'all';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settle(40);
      eq(rowPaths().length, all, '清空搜索后恢复（回到本层那批）');
      eq(
        H.textOf(H.q(document.body, '.kbw-crumbs-count')),
        `本层 ${all} 篇`,
        '浏览态的面包屑计数写「本层 N 篇」',
      );
    });

    /**
     * **日期粒度搜索**（P7.12 · 合集 21.5「裸写」档）。
     * 先钉纯函数的**固定盘**（ISO 周跨年、写坏降级、引号强制文字）——
     * 这些是"写法本身无歧义"那几句话的可执行版；再用真界面验"裸写认「创建日期」"那条链。
     */
    await suite.it('日期粒度：解析固定盘 —— ISO 周（跨年）、写坏降文字、引号强制文字', () => {
      eq(parseDateTerm('2026')?.gran, 'year', '四位年 → 年');
      eq(parseDateTerm('2026-10')?.gran, 'month', '年-月 → 月');
      eq(parseDateTerm('2026-W41')?.gran, 'week', '年-W周 → 周');
      eq(parseDateTerm('2026-w41')?.gran, 'week', '小写 w 也认（写法宽容，语义同一条）');
      eq(parseDateTerm('2026-10-06')?.gran, 'day', '完整日期 → 当日');
      eq(parseDateTerm('2026-13'), null, '月份越界 → 不是日期（降级为文字搜）');
      eq(parseDateTerm('2026-02-30'), null, '不存在的日子 → 不是日期');
      eq(parseDateTerm('2026-W54'), null, '周号越界 → 不是日期');
      eq(parseDateTerm('2026-10-6'), null, '日不是两位 → 不是日期（严格 ISO 写法）');
      /**
       * ISO 周固定盘（不靠被测件自己推）：2026-01-01 是**周四** → 2026-W01 的第一天是
       * 2025-12-29（周一）；2026-10-05（周一）～10-11（周日）= **W41**；2027-01-01 是**周五**
       * → 归 **2026-W53**（跨年周按 ISO 归属）；2026 是 53 周年（12-28 永远在最后一周）。
       */
      eq(isoWeekOf(2025, 12, 29).y, 2026, '2025-12-29（周一）的 ISO 周年是 2026');
      eq(isoWeekOf(2025, 12, 29).w, 1, '它是 2026-W01 的第一天');
      eq(isoWeekOf(2026, 1, 1).w, 1, '2026-01-01（周四）仍在 W01');
      eq(isoWeekOf(2026, 10, 5).w, 41, '2026-10-05（周一）落 W41');
      eq(isoWeekOf(2026, 10, 11).w, 41, '2026-10-11（周日）仍是 W41（周一起算）');
      eq(isoWeekOf(2026, 10, 12).w, 42, '2026-10-12（下周一）进 W42');
      eq(weeksInIsoYear(2026), 53, '2026 有 53 个 ISO 周');
      eq(weeksInIsoYear(2027), 52, '2027 只有 52 个');
      const nye = isoWeekOf(2027, 1, 1);
      eq(`${nye.y}-W${String(nye.w).padStart(2, '0')}`, '2026-W53', '2027-01-01 归 2026-W53');
      // splitDateQuery：混写 / 引号 / 边界
      const mix = splitDateQuery('2026-10 计划');
      eq(mix.date?.gran, 'month', '混写：摘出日期词');
      eq(mix.text, '计划', '混写：剩下的当文字词（AND）');
      const q1 = splitDateQuery('"2026"');
      eq(q1.date, null, '整条被引号包住 → 不认日期');
      eq(q1.text, '2026', '引号剥掉后按字面文字搜');
      const q2 = splitDateQuery('"重要" 2026');
      eq(q2.date?.gran, 'year', '引号段**外**的裸写照认日期');
      eq(q2.text, '重要', '引号段照文字');
      const q3 = splitDateQuery('x12026y');
      eq(q3.date, null, '被更长数字串包着（12026）→ 不认，整条照文字');
      const q4 = splitDateQuery('2026-13');
      eq(q4.date, null, '写坏的词整条降文字（不猜一半）');
      // dateTokenOf（列头快捷入口现算）与解析互逆
      const dt = new Date(2026, 9, 6, 12, 0, 0);
      eq(dateTokenOf(dt, 'year'), '2026', '今年的词');
      eq(dateTokenOf(dt, 'month'), '2026-10', '本月的词');
      eq(dateTokenOf(dt, 'week'), '2026-W41', '本周的词');
      eq(dateTokenOf(dt, 'day'), '2026-10-06', '今天的词');
      eq(parseDateTerm(dateTokenOf(dt, 'week'))?.gran, 'week', '产出的词能被解析回同一粒度');
    });

    await suite.it('日期粒度搜索：裸写认「创建日期」（年/月/日/周 + 混写）；引号 ≠ 裸写', async () => {
      const dir = await H.enterTopDirWithNotes(ctx(), 6);
      ok(dir, `进到一个本层 ≥6 篇的目录（进了「${dir}」）`);
      const box = H.q<HTMLInputElement>(document.body, '.kbw-search');
      const sub = underIn(dir);
      const ymdOf = (p: string): [number, number, number] | null => {
        const raw = String(ctx().index.get(p)?.props['创建日期'] ?? '');
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      };
      const dated = sub
        .map((p) => ({ p, ymd: ymdOf(p) }))
        .filter((x): x is { p: string; ymd: [number, number, number] } => x.ymd !== null);
      ok(dated.length > 0, '子树里有带完整创建日期的笔记（否则这条无从验起）');
      const search = async (q: string): Promise<string[]> => {
        box.value = q;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await H.settle(40);
        return rowPaths().sort();
      };
      /**
       * ⚠️ 独立审 B3（P7.12 收尾）：搜索词是**跨用例共享状态** —— 中途任一断言抛错都必须
       * 还原，否则残留会喂给同一个 B 库后面 10+ 个 spec（"失败集合每次都变"的老形态）。
       * 收尾挂 `finally`（tidy 组的新用例就是这么写的，这里对齐）。
       */
      try {
        const p2 = (n: number): string => String(n).padStart(2, '0');
        const [y0, m0, d0] = dated[0].ymd;
        // ① 年
        const yWant = dated.filter((x) => x.ymd[0] === y0).map((x) => x.p).sort();
        eq((await search(String(y0))).join(','), yWant.join(','), `裸写 ${y0} → 该年创建的那些`);
        // ② 月
        const mWant = dated.filter((x) => x.ymd[0] === y0 && x.ymd[1] === m0).map((x) => x.p).sort();
        eq((await search(`${y0}-${p2(m0)}`)).join(','), mWant.join(','), '年-月 → 该月');
        // ③ 日
        const dWant = dated
          .filter((x) => x.ymd[0] === y0 && x.ymd[1] === m0 && x.ymd[2] === d0)
          .map((x) => x.p)
          .sort();
        eq((await search(`${y0}-${p2(m0)}-${p2(d0)}`)).join(','), dWant.join(','), '年-月-日 → 当日');
        // ④ 周（期望用"固定盘已钉过"的 isoWeekOf 现算 —— 不写死夹具日期）
        const wk = isoWeekOf(y0, m0, d0);
        const wTok = `${wk.y}-W${p2(wk.w)}`;
        const wWant = dated
          .filter((x) => {
            const iw = isoWeekOf(x.ymd[0], x.ymd[1], x.ymd[2]);
            return iw.y === wk.y && iw.w === wk.w;
          })
          .map((x) => x.p)
          .sort();
        eq((await search(wTok)).join(','), wWant.join(','), `裸写 ${wTok} → 该 ISO 周`);
        // ⚠️ 独立审 B5（P7.12 收尾）：原先这里还有一条 `wWant.length >= dWant.length` ——
        // 两边都由同一套 `isoWeekOf` 现算，数学上不可能失败（信息量 0，已删）。
        // 真正的信息量在上一行：解析器（`filters.ts`）与 `isoWeekOf`（周归属）两份实现互证。
        // ⑤ 混写 = 当月 × 含词（拿当月第一篇名字里的两字当词 —— 保证交集非空）
        const first = ctx().index.get(mWant[0] ?? '');
        const word = String(first?.basename ?? '').slice(0, 2);
        if (word) {
          const mixGot = await search(`${y0}-${p2(m0)} ${word}`);
          ok(mixGot.length >= 1, `混写「${y0}-${p2(m0)} ${word}」要有命中（当月 × 含词）`);
          ok(mixGot.every((p) => mWant.includes(p)), '混写结果是当月的子集（日期条件是 AND）');
        }
        // ⑥ 引号 = 文字搜：独立算一份"字面含 2026 的"期望（照 matchesSearch 的 all 口径）
        const textHit = sub.filter((p) => {
          const e = ctx().index.get(p);
          if (!e) return false;
          const hay: string[] = [e.basename, e.path, ...Object.keys(e.props), ...asList(e.props['tags'])];
          for (const v of Object.values(e.props)) {
            for (const item of asList(v)) hay.push(item);
            if (typeof v === 'boolean') hay.push(String(v));
          }
          return hay.some((s) => s.includes(String(y0)));
        }).sort();
        eq((await search(`"${y0}"`)).join(','), textHit.join(','), `引号 "${y0}" = 按字面文字搜`);
        eq((await search(String(y0))).join(','), yWant.join(','), '裸写仍是日期搜（与引号不是一回事）');
        // 还原（搜索词清空 —— 跨用例的共享状态，必须还原干净）
        await search('');
        eq(rowPaths().length, levelIn(dir).length, '清空后回到浏览态（本层那批）');
      } finally {
        // 幂等兜底：正常走完上面已清；中途抛错时从这里还原，别把搜索词漏给后面
        await search('');
      }
    });

    await suite.it('筛选：类型 / 状态 / 健康标记 三组条件各自生效', async () => {
      H.click(treeItems()[0]); // 回到整个知识库
      await H.settle(50);
      const entries = ctx().index.notes();
      const cases: { chip: string; match: (e: (typeof entries)[number]) => boolean; what: string }[] = [
        {
          // ⚠️ 别用「任务」当类型 chip：标签组里正好也有个 **完全同名**的标签「任务」，
          // 而面板里标签组在类型组之前 —— 按文本找会先命中标签那枚（v2 实测踩到）。
          chip: '日志',
          what: '类型',
          match: (e) => String(e.props['类型'] ?? '') === '日志',
        },
        {
          chip: '已完成',
          what: '状态',
          match: (e) => String(e.props['状态'] ?? '') === '已完成',
        },
        {
          chip: '失效双链',
          what: '健康标记',
          match: (e) => e.flags.includes('broken-link'),
        },
      ];
      for (const cs of cases) {
        const btn = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
          H.textOf(b).startsWith('筛选'),
        );
        ok(btn, '有「筛选」按钮');
        H.click(btn as Element);
        await H.settle(50);
        const panel = H.q(document.body, '.kbw-panel');
        // ⚠️ **按"组内"找 chip**：标签组里可能有与类型值同名的标签（如「任务」）——
        // 全面板按文本找会先命中标签那枚（v2 实测踩到）。组结构见上面 clickChip 的注释。
        const head = H.qa<HTMLElement>(panel, '.kbw-panel-group').find(
          (g) => H.textOf(g).trim() === cs.what,
        );
        ok(head, `面板里有「${cs.what}」组`);
        const chip = H.qa<HTMLElement>((head?.nextElementSibling ?? panel) as HTMLElement, '.kbw-chip.is-pickable').find(
          (ch) => H.textOf(ch) === cs.chip,
        );
        ok(chip, `筛选面板里有「${cs.chip}」`);
        H.click(chip as Element);
        await H.settle(50);
        const expect = entries.filter(cs.match).map((e) => e.path).sort();
        const shown = rowPaths().sort();
        eq(shown.length, expect.length, `${cs.what} 条件：命中数该是 ${expect.length}`);
        eq(shown.join('|'), expect.join('|'), `${cs.what} 条件：命中的该正好是那一批`);
        // 勾选态要跟着走（点了不能像没点）
        ok(chip.classList.contains('is-on'), `${cs.chip} 的勾选态要亮起来`);
        // 清掉这一条再验下一组
        const clear = H.qa<HTMLElement>(panel, '.kbw-btn').find((b) =>
          H.textOf(b).includes('清除全部筛选'),
        );
        H.click(clear as Element);
        await H.settle(50);
      }
      // P7.1b 起**根层不再递归**：清完之后回到"库根这一层"那一批（与其它层同款）
      eq(rowPaths().length, levelIn('').length, '清完之后回到"库根这一层"那一批（P7.1b 起不再平铺）');
    });

    await suite.it('筛选面板：多条件 AND（两组同时生效 = 交集）', async () => {
      const entries = ctx().index.notes();
      const btn = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
        H.textOf(b).startsWith('筛选'),
      );
      H.click(btn as Element);
      await H.settle(50);
      const panel = H.q(document.body, '.kbw-panel');
      /**
       * ⚠️ **按"组内"找 chip**（v2 实测踩到）：`.kbw-chip` 是按文本全面板找的，
       * 而**标签组里可能有与类型值完全同名的标签**（如「任务」）—— 不圈组会先命中标签那枚，
       * 筛出来的东西全不对（症状：交集一根不剩/多出一堆）。
       * 结构：`.kbw-panel-group`（组名）后面紧跟一个 `.kbw-panel-chips`。
       */
      const clickChip = async (label: string, groupName?: string): Promise<void> => {
        let scope: Element = panel;
        if (groupName) {
          const head = H.qa<HTMLElement>(panel, '.kbw-panel-group').find(
            (g) => H.textOf(g).trim() === groupName,
          );
          ok(head, `面板里有「${groupName}」组`);
          scope = head!.nextElementSibling ?? panel;
        }
        const chip = H.qa<HTMLElement>(scope as HTMLElement, '.kbw-chip.is-pickable').find(
          (ch) => H.textOf(ch) === label,
        );
        ok(chip, `面板里有「${label}」`);
        H.click(chip as Element);
        await H.settle(50);
      };
      /**
       * 两组：**类型 + 状态**，而且这一对是**从数据里挑的** ——
       * 不写死具体值：夹具一换（P3 换了迁移后的数据）写死的组合就会变成空交集，
       * 这条用例就从"验 AND"退化成"数据不对"（P3 实测踩到过：
       * 原来写死的「想法 + 缺必填属性」在迁移后一篇都不剩）。
       * 挑的条件是"交集非空、且真比单条件窄" —— 这正是 AND 能验出来的前提。
       */
      const types = Array.from(new Set(entries.map((e) => String(e.props['类型'] ?? '')).filter(Boolean)));
      const states = Array.from(new Set(entries.map((e) => String(e.props['状态'] ?? '')).filter(Boolean)));
      let pair: { type: string; state: string; hit: string[]; onlyType: number } | null = null;
      for (const t of types) {
        const inType = entries.filter((e) => String(e.props['类型'] ?? '') === t);
        for (const st of states) {
          const hit = inType.filter((e) => String(e.props['状态'] ?? '') === st);
          if (hit.length > 0 && hit.length < inType.length) {
            pair = { type: t, state: st, hit: hit.map((e) => e.path).sort(), onlyType: inType.length };
            break;
          }
        }
        if (pair) break;
      }
      ok(pair, '数据里得有一对"类型 + 状态"交集非空且比单条件窄的组合');
      const p2 = pair as { type: string; state: string; hit: string[]; onlyType: number };
      await clickChip(p2.type, '类型');
      await clickChip(p2.state, '状态');
      const expect = p2.hit;
      ok(expect.length < p2.onlyType, '交集要真比单条件窄（否则等于没 AND）');
      eq(rowPaths().sort().join('|'), expect.join('|'), `两组条件同时生效 = 交集（${p2.type} + ${p2.state}）`);
      const clear = H.qa<HTMLElement>(panel, '.kbw-btn').find((b) =>
        H.textOf(b).includes('清除全部筛选'),
      );
      H.click(clear as Element);
      await H.settle(60);
      eq(rowPaths().length, levelIn('').length, '清完之后回到"库根这一层"那一批（P7.1b 起不再递归）');
    });

    await suite.it('筛选面板：目录组 + 一键清除', async () => {
      const btn = H.qa(document.body, '.kbw-notes-tools .kbw-btn').find(
        (b) => H.textOf(b).startsWith('筛选'),
      );
      ok(btn, '有「筛选」按钮');
      H.click(btn as Element);
      await H.settle(40);
      const panel = H.q(document.body, '.kbw-panel');
      ok(H.textOf(panel).includes('类型') && H.textOf(panel).includes('状态'), '筛选面板含 类型 / 状态 两组');
      /**
       * 标签组：候选与判据都**从数据里取**。
       * ⚠️ 原来写死「内容创作」—— P2 的标签收尾把"与领域值重合的标签"清掉了
       * （`内容创作` 正是其中一个），夹具一换这个名字就不在候选里了。
       */
      const entries = ctx().index.notes();
      const tag =
        ctx()
          .index.tags()
          .find((t) => entries.some((e) => asList(e.props['tags']).map((x) => x.replace(/^#/, '')).includes(t))) ??
        '';
      ok(tag, `数据里得有一个标签可筛（实际 ${ctx().index.tags().slice(0, 5).join('/')}）`);
      const chip = H.qa(panel, '.kbw-chip.is-pickable').find((c) => H.textOf(c) === tag);
      ok(chip, `标签「${tag}」在候选里`);
      H.click(chip as Element);
      await H.settle(40);
      const shown = rowPaths();
      ok(shown.length > 0, '筛出来有东西');
      const bad = shown.filter(
        (p) =>
          !(entries.find((e) => e.path === p)?.props['tags'] as unknown[] | undefined)
            ?.map((x) => String(x).replace(/^#/, ''))
            .includes(tag),
      );
      eq(bad.length, 0, `筛出来必须全带「${tag}」`);

      // 一键清除
      const clear = H.qa(panel, '.kbw-btn').find((b) => H.textOf(b).includes('清除全部筛选'));
      ok(clear, '有「清除全部筛选」');
      H.click(clear as Element);
      await H.settle(40);
      eq(rowPaths().length, levelIn('').length, '清除后回到"库根这一层"那一批（P7.1b 起不再递归）');
    });

    await suite.it('筛选面板 · 创建日期：裸写词收窄；写坏只提示不落；清除全部还原', async () => {
      const dir = await H.enterTopDirWithNotes(ctx(), 6);
      ok(dir, `进到一个本层 ≥6 篇的目录（进了「${dir}」）`);
      const fbtn = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
        H.textOf(b).startsWith('筛选'),
      );
      ok(fbtn, '有「筛选」按钮');
      H.click(fbtn as Element);
      await H.settle(60);
      const panel = H.q(document.body, '.kbw-panel');
      const input = H.q<HTMLInputElement>(panel, '.kbw-panel-control .kbw-input');
      ok(input, '筛选面板里有「创建日期」输入框（同粒度入口：年 / 年-月 / 年-W周 / 年-月-日）');

      const sub = underIn(dir);
      const yearOf = (p: string): string => {
        const m = /^(\d{4})-/.exec(String(ctx().index.get(p)?.props['创建日期'] ?? ''));
        return m ? m[1] : '';
      };
      const dated = sub.filter((p) => yearOf(p) !== '');
      ok(dated.length > 0, '子树里有带创建日期的笔记（否则这条无从验起）');
      const year = yearOf(dated[0]);
      const want = dated.filter((p) => yearOf(p) === year).sort();

      input.value = year;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(450); // 面板里 250ms 防抖 —— 等它跨过去
      eq(rowPaths().sort().join(','), want.join(','), `筛「创建日期 = ${year}」→ 只剩该年创建的`);
      const hints = H.qa(document.body, '.kbw-panel-hint').map((h) => H.textOf(h)).join(' | ');
      contains(hints, `${year} 年`, '合法词给一句释义（"= X 年（全年）"）');

      // 写坏：红字提示 + **不落进筛选**（列表维持上一份合法值）
      input.value = '2026-13';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(450);
      contains(
        H.qa(document.body, '.kbw-panel-hint').map((h) => H.textOf(h)).join(' | '),
        '这个写法看不懂',
        '写坏要给一句人话（不是静默没反应）',
      );
      ok(H.qa(document.body, '.kbw-panel-hint.is-warn').length > 0, '写坏的红字标出来（is-warn）');
      eq(rowPaths().sort().join(','), want.join(','), '写坏不落进筛选（列表维持上一份合法值）');

      // 一键清除 → 列表回到浏览态
      const clear = H.qa<HTMLElement>(panel, '.kbw-btn').find((b) =>
        H.textOf(b).includes('清除全部筛选'),
      );
      ok(clear, '有「清除全部筛选」');
      H.click(clear as Element);
      await H.settle(60);
      eq(rowPaths().length, levelIn(dir).length, '清除后回到浏览态（本层那批）');
    });

    await suite.it('模板在「全部笔记」里可见（v2 · #5）：行 + 计数都算它；但没复选框、点不进选择集', async () => {
      ctx().goNotes({ dir: '99_Meta/02_模板库/Templater' });
      await H.settle(150);
      const trows = rows();
      const nameOf = (r: HTMLElement): string =>
        r.querySelector('.kbw-name')?.textContent ?? '';
      const tplRows = trows.filter((r) => nameOf(r).startsWith('T_'));
      ok(
        tplRows.length >= 6,
        `模板行要看得见（实际 ${tplRows.map(nameOf).join('/') || '（一行都没有）'}）`,
      );
      // 计数也算它们（用户最直接的观感：模板库里"· N 篇"对得上）
      eq(
        H.textOf(H.q(document.body, '.kbw-crumbs-count')),
        `本层 ${tplRows.length} 篇`,
        '面包屑计数把模板算进来',
      );
      for (const r of tplRows) {
        eq(r.querySelector('.kbw-rowcheck'), null, `模板行「${nameOf(r)}」不画复选框（不进批量）`);
        ok(
          r.querySelector('.kbw-flagcell .kbw-chip')?.textContent?.includes('模板'),
          '标记列给它「模板」chip（不是健康标记）',
        );
      }
      // 点一下：不进选择集、不冒批量栏
      const one = tplRows[0];
      H.click(one);
      await H.settle(30);
      ok(!one.classList.contains('is-selected'), '模板行点不进选择集');
      eq(H.maybe(document.body, '.kbw-notes-bar.is-batch'), null, '没冒批量栏');
      // ⚠️ 「也不能拖」在下面那条用例里用**真指针序列**验——独立审 B2：原先只是句注释，
      //    而拖动的门在 pointerdown 层，`H.click` 到不了那里，等于零覆盖。
      ctx().goNotes({});
      await H.settle(80);
    });

    await suite.it('模板不进选择集 · 键盘三路 + 拖动 + 网格复选框/框选全拦住（P7.12 收尾 · 独立审 A1/B2）', async () => {
      /**
       * #5 的不变量「模板看得见、但不进批量」原先只守住了 4 条入口（行点击 / 拖动 /
       * 表格复选框 / 批量栏全选）；独立审查抓到 **Ctrl+A・Shift+↑↓・Space・框选・
       * 网格复选框** 六条路都能把模板塞进选择集 → 批量「删除/迁移」会落到模板上
       * （批量栏两个计数当场对不上：已选 N 篇 vs 全选 M 篇）。这条用例逐路钉死。
       */
      const root = H.q(document.body, '.kbw-root');
      ctx().goNotes({ dir: '99_Meta/02_模板库/Templater' });
      await H.settle(150);
      const tpl = rows().filter((r) => (r.dataset.path ?? '').includes('/02_模板库/'));
      ok(tpl.length >= 6, `模板行得在（实际 ${tpl.length}）`);

      // ① Ctrl+A：全选 → 模板一个都不许进（有模板进就会冒批量栏）
      H.keydown(root, 'a', { ctrlKey: true });
      await H.settle(30);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, 'Ctrl+A 不选模板');
      eq(H.maybe(document.body, '.kbw-notes-bar.is-batch'), null, 'Ctrl+A 后不冒批量栏');

      // ② Shift+↓ 范围选：光标落在模板行上扩一段 → 仍不进
      H.keydown(root, 'ArrowDown');
      await H.settle(20);
      ok(
        (H.maybe(document.body, '.kbw-trow.is-cursor')?.dataset.path ?? '').includes('/02_模板库/'),
        '前提前置：光标确实停在模板行上（不然下面两条是空跑）',
      );
      H.keydown(root, 'ArrowDown', { shiftKey: true });
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, 'Shift+↓ 范围选不选模板');

      // ③ Space：光标停在模板行 → 不发选择
      H.keydown(root, ' ');
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, 'Space 不选模板行');

      // ④ 拖动门（B2）：真指针序列越过 4px 阈值 → 也不该出拖拽药丸（门在 pointerdown 层）
      const dragRow = tpl[0];
      const box = dragRow.getBoundingClientRect();
      await H.pointerSequence([
        { el: dragRow, type: 'down', init: { x: box.left + 20, y: box.top + 8 } },
        { el: document.body, type: 'move', init: { x: box.left + 60, y: box.top + 8 } },
      ]);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '模板行越过阈值也不进拖动（没药丸）');
      await H.pointerSequence([
        { el: document.body, type: 'up', init: { x: box.left + 60, y: box.top + 8, buttons: 0 } },
      ]);
      await H.settle(60);

      // ⑤ 网格档：模板格不画复选框；框选命中/计数/预览都要剔掉模板
      const seg = H.qa(document.body, '.kbw-seg button').find((b) => H.textOf(b).includes('网格'));
      ok(seg, '两档切换的「网格」钮在');
      H.click(seg as Element);
      await H.settle(120);
      const tcell = H.qa(document.body, '.kbw-gcell[data-tpl="1"]');
      ok(tcell.length >= 6, `模板格认得出来（data-tpl=1，实际 ${tcell.length}）`);
      for (const c of tcell) eq(c.querySelector('.kbw-rowcheck'), null, '模板格不画复选框（不进批量）');
      const inner = H.maybe<HTMLElement>(document.body, '.kbw-grid-inner');
      ok(inner, '网格体内层在（框选矩形的宿主）');
      H.pointerDown(inner as Element, { x: 5, y: 5, pointerType: 'mouse' });
      await H.tick(10);
      H.pointerMove(document.body, { x: 150, y: 80, pointerType: 'mouse' });
      await H.tick(10);
      contains(
        H.textOf(H.maybe(document.body, '.kbw-gstatus')),
        '框选 0 项',
        '这一屏全是模板 → 框选计数是 0（命中没滤的话会是 N）',
      );
      eq(H.qa(document.body, '.kbw-gcell.is-selected').length, 0, '拖动中预览也不亮模板格');
      H.pointerUp(document.body, { x: 150, y: 80, pointerType: 'mouse' });
      await H.settle(80);
      eq(H.qa(document.body, '.kbw-gcell.is-selected').length, 0, '松手后选择集仍空');
      eq(H.maybe(document.body, '.kbw-notes-bar.is-batch'), null, '框选完也不冒批量栏');

      // 收尾：切回详细信息档 + 回库根（跨用例共享状态，还原干净）
      const back = H.qa(document.body, '.kbw-seg button').find((b) => H.textOf(b).includes('详细信息'));
      if (back) H.click(back);
      await H.settle(60);
      ctx().goNotes({});
      await H.settle(80);
    });
  });

  await suite.group('全部笔记 · 批量栏与拖拽', async () => {
    await suite.it('批量栏：选中后表头换成操作栏（不占额外高度）+ 全选 + ✕ 清空', async () => {
      // P6b ② 起列表只画本层 → 先站进一个有笔记的目录，否则这一屏是空的
      ok(await H.enterTopDirWithNotes(ctx(), 4), '进到一个本层 ≥4 篇的目录');
      const all = rows();
      H.click(all[0]);
      H.click(all[1], { shiftKey: true } as MouseEventInit);
      await H.settle(30);
      const bar = H.q(document.body, '.kbw-notes-bar.is-batch');
      ok(bar, '批量栏出来了');
      contains(H.textOf(bar), '已选 2 篇', '写着选了几篇');
      eq(H.maybe(document.body, '.kbw-search'), null, '批量栏替换掉了工具条（同一个位置）');
      for (const label of ['迁移', '属性', '标签', '更多']) {
        ok(H.textsOf(bar, '.kbw-btn').some((t) => t.includes(label)), `缺按钮：${label}`);
      }
      const selAll = H.qa(bar, '.kbw-btn').find((b) => H.textOf(b).startsWith('全选'));
      
      H.click(selAll as Element);
      await H.settle(30);
      eq(
        H.qa(document.body, '.kbw-trow.is-selected').length,
        rows().length,
        '全选选中当前筛选结果全部',
      );
      const x = H.q(document.body, '.kbw-batch-tail .kbw-iconbtn');
      H.click(x);
      await H.settle(30);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, '✕ 清空选择');
      ok(H.maybe(document.body, '.kbw-search'), '工具条回来了');
    });

    await suite.it('「N 篇被筛掉，仍在选中」要说出来', async () => {
      /**
       * ⚠️ **P6b ② 起换目录只画本层** —— 这条用例的"被筛掉"原来是靠"切到 Inbox"实现的，
       * 而现在只要换到**任何别的目录**，原来那批就不在列表里了（同一个效果）。
       * 所以先站进一个 ≠ 00_Inbox 的目录（含 ≥2 篇），一会儿切去 Inbox。
       */
      const dirA = await H.enterTopDirWithNotes(ctx(), 2, { exclude: ['00_Inbox'] });
      ok(dirA, `进到一个 ≠ 00_Inbox 且本层 ≥2 篇的目录（进了「${dirA}」）`);
      const all = rows();
      ok(all.length >= 2, '至少两行');
      H.click(all[0]);
      H.click(all[1], { shiftKey: true });
      await H.settle(30);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 2, '先选中两篇');
      // ⚠️ 真实路径是**点目录树换目录**：有选中时工具条整块换成批量栏，
      // 搜索框/筛选按钮都不在 DOM 里 —— 能把选中行"筛掉"的只剩目录树
      ok(await H.clickTreeNode('00_Inbox'), '树里点得到 00_Inbox');
      const shown = rowPaths();
      ok(
        shown.every((pp) => pp.startsWith(`${KB}/00_Inbox/`)),
        '列表已切到 Inbox',
      );
      const bar = H.q(document.body, '.kbw-notes-bar.is-batch');
      contains(H.textOf(bar), '仍在选中', '要提示"被筛掉但仍选中"');
      contains(H.textOf(bar), '2', '写明还在选中的篇数');
      ok(
        H.qa(document.body, '.kbw-trow.is-selected').length < 2,
        '被筛掉的行不显示（但仍在选中集合里）',
      );
      // 切回原来那个目录 → 选中还在（P6b ② 起"回到整个知识库"那一层是空的）
      ok(await H.clickTreeNode(dirA), '切回原来那个目录');
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 2, '切回来选择还在');
      H.keydown(H.q(document.body, '.kbw-notes'), 'Escape');
      await H.settle(30);
    });

    await suite.it('行菜单：三条硬规矩零违规（捕获 console.warn）', async () => {
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => {
        warns.push(args.map(String).join(' '));
      };
      try {
        ok(await H.enterTopDirWithNotes(ctx(), 2), '进到一个本层 ≥2 篇的目录');
        rows()[0].dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
        );
        await H.settle(30);
        const menu = H.q(document.body, '.kbw-menu');
        contains(H.textOf(menu), '作用范围', '作用域行常驻');
        const top = H.qa(menu, '.kbw-menu-item').length;
        ok(top <= 8, `一级不超过 8 项（实际 ${top}）`);
        // 危险项：必须在最后，且上方有分隔线
        const danger = H.qa(menu, '.kbw-menu-item.is-danger');
        eq(danger.length, 1, '有一个危险项');
        let after = danger[0].nextElementSibling;
        let ordinaryAfter = 0;
        while (after) {
          if (after.classList.contains('kbw-menu-item')) ordinaryAfter += 1;
          after = after.nextElementSibling;
        }
        eq(ordinaryAfter, 0, '危险项排末位');
        ok(
          danger[0].previousElementSibling?.classList.contains('kbw-menu-sep'),
          '危险项上方有分隔线',
        );
        // 子菜单飞出来（改 › 里能拿到「属性」）
        const change = H.qa(menu, '.kbw-menu-item').find((i) => H.textOf(i).includes('改'));
        H.click(change as Element);
        await H.settle(30);
        ok(H.maybe(document.body, '.kbw-menu.is-sub'), '子菜单开了');
      } finally {
        console.warn = orig;
        closeAllMenus();
        await H.settle(20);
      }
      eq(warns.filter((w) => w.includes('菜单违反硬规矩')).length, 0, '不该有违规告警');
    });

    await suite.it('拖拽（鼠标 4px 阈值）：拖到树节点 → 文件真的搬了 + 撤销条', async () => {
      ok(await H.clickTreeNode('00_Inbox'), '进到 00_Inbox（列表只画本层，得先站进去）');
      __resetUndo();
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '这条用例开始时不该有残留药丸');
      ok(await H.clickTreeNode('00_Inbox'), '进到 00_Inbox（列表只画本层）');
      const source = rows().find((r) => (r.dataset.path ?? '').includes('/00_Inbox/'));
      ok(source, 'Inbox 里得有一篇来拖');
      const from = source.dataset.path ?? '';
      // 折叠的子树不渲染 → 先展开 02_Areas 才有子节点可当落点
      const areas = treeItems().find((i) => i.dataset.dir === '02_Areas');
      ok(areas, '有 02_Areas 节点');
      H.click(H.q(areas as Element, '.kbw-tree-caret'));
      await H.settle(40);
      const target = treeItems().find((i) => i.dataset.dir === '02_Areas/内容创作');
      ok(target, '有目标节点（展开后）');

      // 起手在行的名字格上（不要在复选框/抓手上）
      const grip = H.q<HTMLElement>(source, 'td[data-col="name"]');
      const a = grip.getBoundingClientRect();
      const b = (target as HTMLElement).getBoundingClientRect();
      /** 每次都重新取"此刻挂在文档里"的那个节点 */
      const live = (): Element =>
        treeItems().find((i) => i.dataset.dir === '02_Areas/内容创作') ?? document.body;

      // 先验反面：只挪 2px（< 4px 阈值）不该进拖动 —— 不然阈值改成 0 也没人知道
      H.pointerDown(grip, { x: a.left + 20, y: a.top + 8 });
      await H.tick(10);
      H.pointerMove(document.body, { x: a.left + 22, y: a.top + 8 });
      await H.tick(10);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '只挪 2px 不该进拖动（鼠标阈值 4px）');
      // 第一下必须超过 4px 才进入拖动
      H.pointerMove(document.body, { x: a.left + 26, y: a.top + 10 });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-dragghost'), '越过 4px 阈值 → 进入拖动（有药丸）');
      H.pointerMove(live(), { x: b.left + 20, y: b.top + 8 });
      await H.tick(10);
      // 「4 → 7」预告：掠过目标时就该出现（§3.1）
      ok(H.maybe(document.body, '.kbw-tree-preview'), '掠过目录节点 → 右上角出现「N → M」预告');
      H.pointerUp(live(), { x: b.left + 20, y: b.top + 8, buttons: 0 });
      await H.settleIndex(app);
      const moved = ctx()
        .index.notes()
        .find((e) => e.basename === from.split('/').pop()?.replace(/\.md$/, ''));
      ok(moved, '那篇还在库里');
      eq(moved?.effectivePosition, '02_Areas/内容创作', '被拖到目标目录了');
      ok(hasUndoBar(), '拖完出撤销条（拖拽是唯一不走确认流的动库动作）');
      // 撤销回去，别污染后面的用例
      const undoBtn = H.currentUndoButton('撤销');
      H.click(undoBtn as Element);
      await H.settleIndex(app);
      eq(
        ctx().index.get(from)?.effectivePosition,
        '00_Inbox',
        '撤销把文件搬回 Inbox',
      );
    });

    await suite.it('拖拽（触屏长按 400ms）：按住不动才进入拖动；早抬手不拖', async () => {
      ok(await H.clickTreeNode('00_Inbox'), '进到 00_Inbox');
      const source = rows().find((r) => (r.dataset.path ?? '').includes('/00_Inbox/'));
      ok(source, 'Inbox 里得有一篇');
      const from = source.dataset.path ?? '';
      const g = source.getBoundingClientRect();

      // ① 触屏：按住 200ms 就抬手 → 不该进拖动（长按阈值 400ms）
      __resetUndo();
      // ⚠️ 每一步都要**重新取当前挂在文档里的那个格子**：上一条用例的撤销还在异步收敛
      //（metadataCache 滞后 300ms + 索引 debounce），期间表格会重画 → 旧节点脱离文档 →
      // 事件就冒泡不到 document 了（jsdom 没有命中测试，这一条踩过两次）
      const liveCell = (): HTMLElement =>
        H.q<HTMLElement>(document.body, `.kbw-trow[data-path="${from}"] td[data-col="name"]`);
      const c = liveCell().getBoundingClientRect();
      // 按住 200ms 时（还没到 400ms）**就已经不能有拖动药丸** —— 这条才拦得住"阈值被改成 1ms"
      H.pointerDown(liveCell(), { x: c.left + 20, y: c.top + 8, pointerType: 'touch' });
      await H.tick(200);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '按住 200ms 时不该进拖动（长按要 400ms）');
      H.pointerUp(liveCell(), { x: c.left + 20, y: c.top + 8, pointerType: 'touch', buttons: 0 });
      await H.tick(20);
      await H.settle(60);
      ok(!hasUndoBar(), '早抬手不该搬东西');
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '早抬手不该留拖动药丸');
      // 走过整段长按窗口：确认没有"迟到的长按"把拖动点起来
      await H.settle(420);
      ok(!hasUndoBar(), '长按窗口过去后也不该搬');
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '长按窗口过去后也不该有药丸');

      // ①b 触屏：长按期间**动了 30px**（> 10px 容差）= 用户在滚动 → 立刻放弃这次拖动。
      //     把容差改成 100000 也照样绿的那种"没验"就在这里补上。
      H.pointerDown(liveCell(), { x: c.left + 20, y: c.top + 8, pointerType: 'touch' });
      await H.tick(120);
      H.pointerMove(liveCell(), { x: c.left + 50, y: c.top + 38, pointerType: 'touch' }); // 位移 ≈41px
      await H.tick(400); // 走过 400ms 长按窗口
      eq(
        H.maybe(document.body, '.kbw-dragghost'),
        null,
        '长按期间位移超过 10px 容差 → 立刻放弃拖动（不然触屏一滚列表就误拖）',
      );
      H.pointerUp(liveCell(), { x: c.left + 50, y: c.top + 38, pointerType: 'touch', buttons: 0 });
      await H.tick(30);

      // ② 触屏：按住 420ms（没动）→ 进入拖动 → 拖到目录树节点
      const areas = treeItems().find((i) => i.dataset.dir === '02_Areas');
      if (areas && !treeItems().some((i) => i.dataset.dir === '02_Areas/灵感杂记')) {
        H.click(H.q(areas as Element, '.kbw-tree-caret'));
        await H.settle(40);
      }
      const target = treeItems().find((i) => i.dataset.dir === '02_Areas/灵感杂记');
      ok(target, '有目标节点');
      const t = (target as HTMLElement).getBoundingClientRect();
      const live = (): Element =>
        treeItems().find((i) => i.dataset.dir === '02_Areas/灵感杂记') ?? document.body;
      H.pointerDown(liveCell(), { x: c.left + 20, y: c.top + 8, pointerType: 'touch' });
      await H.tick(430); // 等长按成立
      H.pointerMove(live(), { x: t.left + 20, y: t.top + 8, pointerType: 'touch' });
      await H.tick(20);
      ok(H.maybe(document.body, '.kbw-dragghost'), '长按后进入拖动（有拖动药丸）');
      H.pointerUp(live(), { x: t.left + 20, y: t.top + 8, pointerType: 'touch', buttons: 0 });
      await H.settleIndex(app);
      const touchMoved = ctx()
        .index.notes()
        .find((e) => e.basename === (from.split('/').pop() ?? '').replace(/\.md$/, ''));
      eq(touchMoved?.effectivePosition, '02_Areas/灵感杂记', '触屏长按拖动真的搬了');
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '放下之后药丸要收掉');
      // 撤销回去
      const undoBtn = H.currentUndoButton('撤销');
      H.click(undoBtn as Element);
      await H.settleIndex(app);
      void g;
    });

    await suite.it('a.5-1 拖完那一发 click 被吞：表格行的选中不被误改', async () => {
      /**
       * 独立审查 🟡3：看板卡片那条有断言，**表格行这条一直没有** ——
       * 而它是同一个坑的另一半（浏览器在 pointerup 之后会补一发 click，把刚拖完的行又选上/选掉）。
       * jsdom 不会自己补，所以**手工补上那一发**（与真机行为等价）。
       */
      ok(await H.clickTreeNode('00_Inbox'), '进到 00_Inbox（列表只画本层）');
      const source = rows().find((r) => (r.dataset.path ?? '').includes('/00_Inbox/'));
      ok(source, 'Inbox 里得有一篇来拖');
      const from = source.dataset.path ?? '';
      H.click(source);
      await H.settle(60);
      const before = H.qa<HTMLElement>(document.body, '.kbw-trow.is-selected').map(
        (r) => r.dataset.path ?? '',
      );
      eq(before.length, 1, '先选中它（对照组）');

      const cell = H.q<HTMLElement>(source, 'td[data-col="name"]');
      H.pointerDown(cell, { x: 30, y: 40 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 60, y: 44 });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-dragghost'), '越过 4px → 进了拖动');
      H.pointerUp(source as Element, { x: 30, y: 40, buttons: 0 });
      await H.tick(10);
      /**
       * ⚠️ 补的那一发 **不能拿"点它自己"来验**（突变实验抓到过：点一个本来就选中的行，
       * 选中集合前后一样 → 拿掉守卫也照样绿 = 假绿）。
       * 改验**窗口本身**：拖完 150ms 内点**别的行**也该被吞（那一发就是"刚刚拖完的余波"），
       * 而窗口过后必须恢复正常 —— 后者同时钉住"别漏到用户的下一次点击"（独立审查 🟡2）。
       */
      /**
       * ⚠️ 挑的是"**另一行**"（不再要求它在别的目录）：P6b ② 起列表只画本层，
       * 同一屏里根本没有"别的目录的行" —— 而这条用例要验的是"拖完那发 click 落在别处"，
       * 另一行就够（`r !== source` 才是判据）。
       */
      const other = rows().find((r) => r !== source);
      ok(other, '再找一行别的来点');
      const otherPath = other?.dataset.path ?? '';
      H.click(other); // ← 模拟浏览器补的那一发（落在别处）
      await H.tick(40);
      const after = H.qa<HTMLElement>(document.body, '.kbw-trow.is-selected').map(
        (r) => r.dataset.path ?? '',
      );
      eq(after.join('|'), before.join('|'), '拖动后 150ms 内的那一发 click 被吞：选中没被改');
      // 窗口过后：点击必须恢复（否则用户会觉得"点一下没反应"，那正是 P4 追过好几轮的病）
      await H.settle(260);
      H.click(other);
      await H.settle(80);
      const later = H.qa<HTMLElement>(document.body, '.kbw-trow.is-selected').map(
        (r) => r.dataset.path ?? '',
      );
      eq(later.join('|'), otherPath, '过了那段窗口，点击照常选中别的行');
      void from;
    });

    await suite.it('拖拽中止：pointercancel 要干净中止（不搬、不留药丸）', async () => {
      const source = rows().find((r) => (r.dataset.path ?? '').includes('/00_Inbox/'));
      ok(source, 'Inbox 里得有一篇');
      const from = source.dataset.path ?? '';
      __resetUndo();
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '这条用例开始时不该有残留药丸');
      const liveCell = (): HTMLElement =>
        H.q<HTMLElement>(document.body, `.kbw-trow[data-path="${from}"] td[data-col="name"]`);
      const c = liveCell().getBoundingClientRect();
      H.pointerDown(liveCell(), { x: c.left + 20, y: c.top + 8, pointerType: 'touch' });
      await H.tick(430);
      H.pointerMove(liveCell(), { x: c.left + 40, y: c.top + 30, pointerType: 'touch' });
      await H.tick(20);
      H.pointerCancel(liveCell(), { x: c.left + 40, y: c.top + 30, pointerType: 'touch' });
      await H.settleIndex(app);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '拖拽药丸要收掉');
      eq(ctx().index.get(from)?.effectivePosition, '00_Inbox', '没搬（中止了）');
      ok(!hasUndoBar(), '中止不该出撤销条');
    });
  });

  await suite.group('全部笔记 · 完成定义（整段流程）', async () => {
    await suite.it('Inbox 全选 → 迁移到内容创作 → 撤销能撤回；首页不再报「收件箱待整理」', async () => {
      __resetNotices();
      __resetUndo();
      const inboxPaths = ctx()
        .index.notes()
        .filter((e) => e.effectivePosition === '00_Inbox')
        .map((e) => e.path);
      ok(inboxPaths.length > 0, 'Inbox 里得有笔记');

      // ① 正面：首页**此刻必须**有「收件箱有 N 篇待整理」那一行（只验"搬完没有了"是假绿 ——
      //    那块整个没渲染也照样通过）
      await goHome();
      const inboxTodo = H.qa<HTMLElement>(document.body, '.kbw-todo').find((t) => {
        const txt = H.textOf(t);
        return txt.includes('收件箱') && txt.includes('待整理');
      });
      ok(inboxTodo, `首页该有「收件箱有 N 篇待整理」那一行：${H.textsOf(document.body, '.kbw-todo-t').join(' | ')}`);
      contains(H.textOf(inboxTodo), String(inboxPaths.length), '那行的数字要与实际篇数一致');

      // ② 从**首页点进去**（不是直接调 goNotes）：点那一行 → 应落到全部笔记 + 只列 Inbox + 已全选
      H.click(inboxTodo as Element);
      await H.settle(120);
      eq(ctx().store.get().activeModule, 'notes', '点待处理行应跳到全部笔记');
      eq(ctx().settings.get().treeSelected, '00_Inbox', '应带上目录筛选');
      eq(
        H.qa(document.body, '.kbw-trow.is-selected').length,
        inboxPaths.length,
        '应已全选（首页那条「整理这 N 篇」的落点）',
      );

      // 迁移（走确认流）→ 确认
      const migrate = H.qa(document.body, '.kbw-notes-bar .kbw-btn').find((b) =>
        H.textOf(b).includes('迁移'),
      );
      ok(migrate, '有「迁移」');
      H.click(migrate as Element);
      await H.settle(40);
      // 菜单是树形的：先展开 02_Areas，再展开 内容创作（子菜单是悬停/点击才飞出来的）
      const areasItem = H.qa(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith('02_Areas'),
      );
      ok(areasItem, '菜单里有「02_Areas」');
      H.click(areasItem as Element);
      await H.settle(40);
      const area = H.qa(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('内容创作'),
      );
      ok(area, '子菜单里有「内容创作」');
      H.click(area as Element); // → 再下一级
      await H.settle(40);
      const moveHere = H.qa(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('移到「内容创作」'),
      );
      ok(moveHere, '子菜单里有「移到内容创作」');
      H.click(moveHere as Element);
      await H.settle(60);

      // 确认流
      const modal = H.q(document.body, '.kbw-modal');
      contains(H.textOf(modal), `即将移动 ${inboxPaths.length} 篇笔记`, '确认流标题带数量');
      const primary = H.qa(modal, '.kbw-btn').find((b) => H.textOf(b).includes('移动'));
      ok(primary, '有主按钮');
      H.click(primary as Element);
      await H.settleIndex(app);
      await H.settle(80);

      const after = ctx()
        .index.notes()
        .filter((e) => e.effectivePosition === '00_Inbox');
      eq(after.length, 0, 'Inbox 搬空了');
      ok(hasUndoBar(), '出了撤销条');
      eq(ctx().settings.get().treeSelected, '00_Inbox', '还停在 Inbox（列表会空）');

      // 首页：不该再有「收件箱有 N 篇待整理」
      await goHome();
      const todoTexts = H.textsOf(document.body, '.kbw-todo-t');
      ok(
        !todoTexts.some((t) => t.includes('收件箱') && t.includes('待整理')),
        `首页不该再有「收件箱待整理」那一行：${todoTexts.join(' | ')}`,
      );

      // 回笔记屏，撤销
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(60);
      const undoBtn = H.currentUndoButton('撤销');
      ok(undoBtn, '撤销条还在');
      H.click(undoBtn as Element);
      // 还原是逐篇 await 的（7 篇 × rename/写回）→ 别用固定等待，等条件成立
      const inboxCount = (): number =>
        ctx()
          .index.notes()
          .filter((e) => e.effectivePosition === '00_Inbox').length;
      await H.until(() => inboxCount() === inboxPaths.length, 4000);
      await H.settleIndex(app);
      eq(inboxCount(), inboxPaths.length, '撤销把整批都搬回 Inbox');
    });

    await suite.it('撞名走界面：批量迁移撞上同名不同内容 → 通知里写出来 + 源文件原地不动', async () => {
      __resetUndo();
      __resetNotices();
      const name = '__界面撞名';
      const src = `${KB}/00_Inbox/${name}.md`;
      const dst = `${KB}/02_Areas/内容创作/${name}.md`;
      H.writeNote(vaultRoot, src, H.note('# 界面撞名源\n'));
      H.writeNote(vaultRoot, dst, H.note('# 界面撞名目标（内容不同）\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(60);

      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(80);
      const row = rows().find((r) => r.dataset.path === src);
      ok(row, '找到那篇');
      H.click(row as Element);
      await H.settle(30);
      const migrate = H.qa<HTMLElement>(document.body, '.kbw-notes-bar .kbw-btn').find((b) =>
        H.textOf(b).includes('迁移'),
      );
      H.click(migrate as Element);
      await H.settle(50);
      const areasItem = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith('02_Areas'),
      );
      ok(areasItem, '菜单里有 02_Areas');
      H.click(areasItem as Element);
      await H.settle(50);
      const area = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('内容创作'),
      );
      H.click(area as Element);
      await H.settle(50);
      const moveHere = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('移到「内容创作」'),
      );
      H.click(moveHere as Element);
      await H.settle(60);
      const modal = H.q(document.body, '.kbw-modal');
      const primary = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) => H.textOf(b).includes('移动'));
      H.click(primary as Element);
      await H.settleIndex(app);
      await H.settle(80);
      // 界面这一层要把"被跳过的"说出来（§9），源文件原地不动，目标没被覆盖
      contains(H.textOf(document.body), '撞名', '通知里要写明撞名冲突');
      ok(app.vault.getAbstractFileByPath(src), '源文件还在 Inbox（没搬走）');
      contains(H.readNote(vaultRoot, dst), '界面撞名目标', '目标文件没被覆盖');
      fs.rmSync(path.join(vaultRoot, src), { force: true });
      fs.rmSync(path.join(vaultRoot, dst), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
    });

    await suite.it('撞名被拦住（服务层）：目标已有同名且内容不同 → 报冲突、不动文件', async () => {
      __resetNotices();
      __resetUndo();
      const name = '__撞名测试';
      const src = `${KB}/00_Inbox/${name}.md`;
      const dst = `${KB}/02_Areas/内容创作/${name}.md`;
      H.writeNote(vaultRoot, src, H.note('# 源\n'));
      H.writeNote(vaultRoot, dst, H.note('# 目标（内容不同）\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(60);

      const file = H.fileAt(app, src);
      const res = await ctx().mover.move({
        targets: [{ dir: `${KB}/02_Areas/内容创作`, files: [file] }],
        source: 'batch',
        reason: '测试：撞名',
      });
      await H.settleIndex(app);
      eq(res.moved.length, 0, '一篇都没搬');
      eq(res.blocked.length, 1, '记了一条真冲突');
      eq(res.blocked[0].why, 'content-conflict', '冲突原因');
      ok(app.vault.getAbstractFileByPath(src), '源文件还在原地');
      eq(
        H.readNote(vaultRoot, dst).includes('目标（内容不同）'),
        true,
        '目标文件没被覆盖',
      );

      fs.rmSync(path.join(vaultRoot, src), { force: true });
      fs.rmSync(path.join(vaultRoot, dst), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(60);
    });
  });

  // ────────────────────────────────────────────────────────────
  /**
   * P6 段② · A3 / B1 / B2（用户 2026-09-27 真机反馈）
   *
   * 三条都在「全部笔记」这一屏，共用同一套 DOM 前提，所以放一组：
   *   A3  跳转之后要给一条**看得见**的回头路（清筛选 + 清预选中）
   *   B1  空白处右键（新建笔记 / 新建文件夹），目录树空白处与首页也各有一条
   *   B2  点空白处取消选中（**点单元格不算** —— 那是选中/加选）
   */
  await suite.group('P6② · 还原显示 / 空白右键 / 点空白取消选中', async () => {
    /** 清掉当前选择（有选择时工具条整条被批量栏顶掉） */
    async function clearSel(): Promise<void> {
      const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
      if (!bar) return;
      const x = H.qa<HTMLElement>(bar, 'button').find((b) =>
        (b.getAttribute('aria-label') ?? '').includes('清空选择'),
      );
      if (x) H.click(x);
      await H.settle(60);
    }
    /** 一条菜单项（菜单项是 `div.kbw-menu-item`，不是 button） */
    const menuItem = (text: string): HTMLElement | undefined =>
      H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes(text));
    const rightClick = (el: Element): void => {
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      );
    };
    const visibleRows = (): string[] => rowPaths();

    await suite.it('A3 「还原显示」：清掉跳转带来的筛选与预选中，**回到原来那批**（逐路径比）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      // P6b ② 起列表只画本层 → 先站进一个有笔记的目录（库根那一层常常是空的）
      ok(await H.enterTopDirWithNotes(ctx(), 2), '进到一个本层 ≥2 篇的目录');
      await clearSel();
      // 确保没有搜索词（它不参与还原，留着会干扰"回到原来那批"的判据）
      const search = H.maybe<HTMLInputElement>(document.body, '.kbw-search');
      if (search && search.value) {
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await H.settle(120);
      }
      const dirBefore = ctx().settings.get().treeSelected;
      const before = visibleRows();
      ok(before.length > 1, `当前目录下得有不止一篇（实际 ${before.length}）`);

      /**
       * 走**真入口**造一次跳转：`goNotes({paths, selectPaths})` 就是
       * 首页「筛选这几个文件」/快速切换跳一篇走的那条意图（A3 说的"跳转"）。
       * ⚠️ 挑一篇**不在**当前目录下的：这样"还原有没有回到原来那批"才看得出差别。
       */
      const pick =
        ctx().index.notes().find((e) => !before.includes(e.path)) ?? ctx().index.notes()[0];
      ok(pick, '库里要有笔记');
      ctx().goNotes({ paths: [pick.path], selectPaths: [pick.path] });
      await H.settle(200);

      eq(visibleRows().join(','), pick.path, '跳过去：只列这一篇（筛选真的生效了）');
      ok(H.maybe(document.body, '.kbw-notes-bar.is-batch'), '预选中 → 工具条换成批量栏');
      /**
       * 🔴 **两个容器都要查**（P6② 独立审查 B 路 🔴2.3）：
       * 「还原显示」在批量栏里（有预选中时）**也在工具条里**（预选中被清掉之后）——
       * 只查 `.kbw-batch-tail` 的话，"还原之后按钮自己消失""手动改筛选之后按钮自己消失"
       * 这两条**恒真**（那时选择已经清了、批量栏根本不在，必然查不到）。探针那一步查的就是两个容器。
       */
      /**
       * ⚠️ 文案在 P6b ① 改成**「还原」**（用户 2026-09-27 拍板：设计稿那句"还原到全部笔记"太长，
       * 落到 `title` 里）—— 判据跟着改，别让它变成"按钮找不到"的假红。
       * 🔴 **两个容器都要查**：批量栏里那一枚（有预选中时）与工具条里那一枚（预选中清掉之后）。
       */
      const restore = (): HTMLElement | undefined =>
        H.qa<HTMLElement>(document.body, '.kbw-batch-tail .kbw-btn, .kbw-notes-tools .kbw-btn').find(
          (b) => H.textOf(b) === '还原',
        );
      ok(restore(), `批量栏上要有「还原」：${H.textsOf(document.body, '.kbw-batch-tail .kbw-btn').join(' | ')}`);

      H.click(restore() as Element);
      await H.settle(160);
      eq(visibleRows().join(','), before.join(','), '还原之后回到"这个目录下的全部笔记"（逐路径比）');
      ok(!restore(), '没有可还原的东西了 → 那个按钮自己消失');
      ok(!H.maybe(document.body, '.kbw-notes-bar.is-batch'), '预选中也清了（工具条回来了）');
      eq(ctx().settings.get().treeSelected, dirBefore, '目录没被动（它不属于"这次跳转带来的显示变化"）');

      // 用户自己去筛选面板改过之后，那个还原口子必须消失（判据是"现在这份还是不是跳转给的那份"）
      ctx().goNotes({ paths: [pick.path], selectPaths: [pick.path] });
      await H.settle(200);
      ok(restore(), '再跳一次，口子又回来了');
      // ⚠️ 有选择时工具条整条被批量栏顶掉（§3.4）→ 想点「筛选」得先清选择
      await clearSel();
      const filterBtn = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
        H.textOf(b).includes('筛选'),
      );
      ok(filterBtn, '有「筛选」按钮');
      H.click(filterBtn as Element);
      await H.settle(120);
      const clearAll = H.qa<HTMLElement>(document.body, '.kbw-panel button').find((b) =>
        H.textOf(b).includes('清除全部筛选'),
      );
      if (clearAll) H.click(clearAll);
      await H.settle(150);
      H.keydown(document.body, 'Escape');
      await H.settle(150);
      await clearSel();
      ok(!restore(), '手动改过筛选之后就不该再挂着一个"还原显示"（它不是跳转给的了）');
    });

    await suite.it('B2 点列表空白处 = 取消选中；**点单元格不算**（那是选中/加选）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      ok(await H.enterTopDirWithNotes(ctx(), 3), '进到一个本层 ≥3 篇的目录');
      await clearSel();
      const list = H.q(document.body, '.kbw-notes-list');
      const first = H.q<HTMLElement>(document.body, '.kbw-trow');
      ok(first, '有一行');

      // ① 选中一行（点行）
      H.click(first);
      await H.settle(80);
      ok(H.qa(document.body, '.kbw-trow.is-selected').length > 0, '点行 = 选中');

      // ② 点**单元格**：不该清空（它自己的活是选中/加选）
      const cell = H.q<HTMLElement>(first, '[data-col="name"]') ?? first;
      H.click(cell);
      await H.settle(80);
      ok(
        H.qa(document.body, '.kbw-trow.is-selected').length > 0,
        '点单元格不该把选择清掉（它是行自己的命中区）',
      );

      // ③ 点**列表空白**（容器本身，不在任何行上）→ 清空
      H.click(list);
      await H.settle(80);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, '点空白 = 取消选中');
    });

    await suite.it('B1 空白处右键：新建笔记 / 新建文件夹（真建出目录，且重名会被拦）', async () => {
      closeAllMenus();
      __resetNotices();
      ctx().goNotes();
      await H.settle(120);
      await clearSel();

      const treeRoot = (): HTMLElement | undefined =>
        H.qa<HTMLElement>(document.body, '.kbw-tree-item').find((i) => (i.dataset.dir ?? '') === '');
      const goRoot = async (): Promise<void> => {
        const node = treeRoot();
        ok(node, '目录树里有「整个知识库」');
        H.click(node as Element);
        await H.settle(120);
      };
      /**
       * ⚠️ **两次尝试必须同一个父目录** —— 建完文件夹模块会**站进新目录**（B1 的反馈），
       * 不先退回来的话第二次的父目录就是那个新目录，"重名"根本不成立
       *（第一版就是这么假绿的：第二次真的又套了一层同名目录）。
       */
      await goRoot();
      const list = H.q(document.body, '.kbw-notes-list');
      rightClick(list);
      await H.settle(60);
      const menu = H.q(document.body, '.kbw-menu');
      ok(menu, '列表空白处能右键');
      contains(H.textOf(menu), '作用范围', '作用域行常驻');
      ok(menuItem('在此新建笔记'), '有「在此新建笔记」');
      ok(menuItem('新建文件夹'), '有「新建文件夹」');

      // 真建一个：点菜单项 → 问名字 → 确认（落点是**整个知识库**那一层）
      H.click(menuItem('新建文件夹') as Element);
      await H.settle(150);
      const prompt = H.q(document.body, '.kbw-modal');
      ok(prompt, '弹出取名对话框');
      const name = '__A2新目录';
      H.q<HTMLInputElement>(prompt, 'input.kbw-input').value = name;
      H.click(H.q<HTMLElement>(prompt, '.kbw-modal-foot .kbw-btn.is-primary'));
      await H.settle(220);
      const abs = path.join(vaultRoot, KB, name);
      ok(fs.existsSync(abs), `目录真建出来了：${abs}`);
      contains(H.textsOf(document.body, '.kbw-notice').join(' | '), name, '通知里报出名字');
      // 建完站进去了（那份反馈）—— 先退回来，重名那一步才在同一个父目录下
      await goRoot();

      /**
       * 重名要**在对话框里当场拦住**（点「新建」时校验就红，对话框不关 —— 用户可以直接改名）。
       * ⚠️ 夹具必须挑"刚建出来的那个"：库里的老目录也在候选里，但那不说明我们拦过。
       */
      H.click(treeRoot() as Element);
      await H.settle(120);
      /**
       * ⚠️ 桩里 `adapter.mkdir` **不进缓存树**（`byPath` 只在 `scan()` 里重建），
       * 而真机上平台会为它发一条 create 事件、缓存立刻就有 —— 这里手动 rescan 一下
       * 才是"真机点第二次那一刻"的样子（不然走的是另一条路：事后才发现，而不是当场拦住）。
       */
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(150);
      rightClick(H.q(document.body, '.kbw-notes-list'));
      await H.settle(80);
      ok(menuItem('新建文件夹'), '菜单又弹出来了');
      H.click(menuItem('新建文件夹') as Element);
      await H.settle(150);
      const prompt2 = H.q(document.body, '.kbw-modal');
      ok(prompt2, '第二次也弹出了取名对话框');
      H.q<HTMLInputElement>(prompt2, 'input.kbw-input').value = name;
      H.click(H.q<HTMLElement>(prompt2, '.kbw-modal-foot .kbw-btn.is-primary'));
      await H.settle(150);
      contains(H.textOf(H.q(document.body, '.kbw-modal')), '已经有同名', '重名当场拦住，对话框不关');
      eq(
        fs.readdirSync(path.join(vaultRoot, KB)).filter((f) => f === name).length,
        1,
        '只有一个，没覆盖也没加序号',
      );

      // ── 收尾：关对话框 → 删掉自造目录 → 把当前目录拨回基线（建完是"站进去了"的）
      H.keydown(H.q(document.body, '.kbw-modal'), 'Escape');
      await H.settle(120);
      fs.rmSync(abs, { recursive: true, force: true });
      /**
       * ⚠️ 两个都要做，否则后面整片用例红（实测：网格那 14 条集体"0 格"）：
       *  ① `rescan()` 会**重建全部 TFile 对象**，索引还攥着旧的 → 手动 `index.rebuild()`；
       *  ② 当前目录还停在那个人造的（已删掉的）目录上 → 点回「整个知识库」。
       */
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(120);
      await goRoot();
      await H.settle(150);
      ok(
        await H.until(() => ctx().settings.get().treeSelected === '', 1500, 30),
        `收尾：当前目录拨回「整个知识库」（实际 ${ctx().settings.get().treeSelected}）`,
      );
    });

    /**
     * **A 路独立审查 🔴1 的回归**：表头是**控件**（点它有活干：排序），不是"空白"。
     * 而 `th` 的 click 在 `ui/table.ts` 里**没有 stopPropagation**，事件照旧冒泡到 `listHost`
     * → 排序（同步重画整张表）之后选择被清空 —— 与"点一下「自动排列」清空选择"同一个根因，
     * 只是表格这一侧的表头当时漏了。
     */
    await suite.it('A 路回归：点表头排序**不该**清空选择（表头是控件，不是空白）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      ok(await H.enterTopDirWithNotes(ctx(), 2), '进到一个本层 ≥2 篇的目录');
      await clearSel();
      const row = H.q<HTMLElement>(document.body, '.kbw-trow');
      ok(row, '有一行');
      const path0 = row.dataset.path ?? '';
      H.click(row);
      await H.settle(80);
      ok(H.qa(document.body, '.kbw-trow.is-selected').length > 0, '前提：先选中了');

      const th = H.qa<HTMLElement>(document.body, '.kbw-table th').find((t) =>
        H.textOf(t).startsWith('名称'),
      );
      ok(th, '有「名称」表头');
      H.click(th as Element);
      await H.settle(120);
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-trow.is-selected').map((r) => r.dataset.path).join(','),
        path0,
        '点表头排序之后，选择与光标都还在（逐路径比，不看数量）',
      );
      ok(H.maybe(document.body, '.kbw-notes-bar.is-batch'), '批量栏也不该消失');
      await clearSel();
    });

    /**
     * **A 路独立审查 🔴2 的回归**：意图是"一次性"的 —— 消费掉就该从 shell store 里清掉。
     * 不清的话模块**整个重建**（切走再回来）时会把上一次跳转**原样再放一遍**：
     * 用户点过「还原显示」，去别处转一圈回来，筛选与预选中一起复活。
     */
    await suite.it('A 路回归：还原之后切模块往返，还原本意仍在（意图是一次性的）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      ok(await H.enterTopDirWithNotes(ctx(), 2), '进到一个本层 ≥2 篇的目录');
      await clearSel();
      const before = rowPaths();
      ok(before.length > 1, `前提：当前目录下不止一篇（${before.length}）`);
      const pick =
        ctx().index.notes().find((e) => !before.includes(e.path)) ?? ctx().index.notes()[0];
      ctx().goNotes({ paths: [pick.path], selectPaths: [pick.path] });
      await H.settle(200);
      eq(rowPaths().join(','), pick.path, '前提：跳转生效（只列这一篇）');

      const restore = (): HTMLElement | undefined =>
        H.qa<HTMLElement>(document.body, '.kbw-batch-tail .kbw-btn, .kbw-notes-tools .kbw-btn').find(
          (b) => H.textOf(b) === '还原',
        );
      H.click(restore() as Element);
      await H.settle(160);
      eq(rowPaths().join(','), before.join(','), '还原之后回到原来那批');

      /**
       * 切到首页再回来 → 模块整个重建。
       * 🔴 **回来这一步必须点导航项，不能调 `ctx().goNotes()`** ——
       * 那一次调用自己就会把 `notesIntent` 写成 null（它带的是空意图），
       * 等于替实现把 bug 盖住了（本轮突变实测：这么写时"不清意图"的坏实现**照样绿**）。
       */
      await goHome();
      const notesNav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
        H.textOf(b).includes('全部笔记'),
      );
      ok(notesNav, '导航里有「全部笔记」');
      H.click(notesNav as Element);
      await H.settle(220);
      eq(
        rowPaths().join(','),
        before.join(','),
        '切模块往返之后**还原本意仍在**（意图被消费掉了，不许再放一遍）',
      );
      ok(!restore(), '「还原」也不该自己冒出来');
      ok(!ctx().store.get().notesIntent, 'shell store 里的意图已经被消费掉（清成 null）');
    });

    await suite.it('B1 首页空白处右键：菜单里有新建笔记 / 整理收件箱 / 设置 / 快捷键', async () => {
      closeAllMenus();
      await goHome();
      rightClick(H.q(document.body, '.kbw-home'));
      await H.settle(60);
      const menu = H.q(document.body, '.kbw-menu');
      ok(menu, '首页空白处能右键');
      const labels = H.qa<HTMLElement>(menu, '.kbw-menu-item').map((i) => H.textOf(i));
      for (const want of ['新建笔记', '整理收件箱', '还原快照', '工作台设置', '快捷键一览']) {
        ok(labels.some((t) => t.includes(want)), `首页菜单里有「${want}」：${labels.join(' | ')}`);
      }
      contains(H.textOf(menu), '首页', '作用域行写清"这一屏"');
      closeAllMenus();
    });
  });

  // ────────────────────────────────────────────────────────────
  /**
   * **P6b ① / ②**（用户 2026-09-27 第二轮反馈）
   *
   *   ① 跳转之后要能还原：**点目录 / Esc / 按钮三条入口都要有**
   *   ② 网格与列表改成 **Windows 式**：只看本层 + 子文件夹（搜索/筛选仍然"往下找"）
   */
  await suite.group('P6b · ① 还原三入口 / ② 本层口径', async () => {
    /** 跳一次（首页「去看看」/ 快速切换跳一篇走的就是这条意图） */
    const jumpTo = async (path: string): Promise<void> => {
      ctx().goNotes({ paths: [path], selectPaths: [path] });
      await H.settle(220);
    };
    const restoreBtn = (): HTMLElement | undefined =>
      H.qa<HTMLElement>(
        document.body,
        '.kbw-batch-tail .kbw-btn, .kbw-notes-tools .kbw-btn, .kbw-notes-bar.is-batch .kbw-btn',
      ).find((b) => H.textOf(b) === '还原');

    await suite.it('① 跳转之后**点目录**就还原：逐路径等于该目录本层那一批', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      const dir = await H.enterTopDirWithNotes(ctx(), 3);
      ok(dir, `进到一个本层 ≥3 篇的目录（进了「${dir}」）`);
      const before = rowPaths(); // 浏览态 = 本层那一批
      const pick = ctx().index.notes().find((e) => !before.includes(e.path));
      ok(pick, '库里得有一篇不在本层（跳过去才看得出差别）');

      await jumpTo(pick.path);
      eq(rowPaths().join(','), pick.path, '前提：跳转生效（只列这一篇）');
      ok(restoreBtn(), '跳转之后「还原」在（批量栏左侧那一枚也算）');
      // ⚠️ 下面比的是**集合**：DOM 顺序与索引顺序不同，两边都排序再比
      const sorted = (xs: string[]): string => [...xs].sort().join(',');

      /**
       * **点目录 = 一次显式的视野动作** → 一次性清单到此为止。
       * ⚠️ 走界面（点目录树的节点），不是直接 `store.set` —— 这条口径的入口就是那儿。
       */
      ok(await H.clickTreeNode(dir), '再点一次那个目录');
      eq(sorted(rowPaths()), sorted(before), '回到"这个目录下的全部笔记"（逐路径比）');
      ok(!restoreBtn(), '还原过了 → 那个按钮自己消失');
      ok(!H.maybe(document.body, '.kbw-notes-bar.is-batch'), '预选中也一起清了（工具条回来）');
    });

    await suite.it('① 搜索词也算显式的视野动作（清掉跳转那份清单）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      const dir = await H.enterTopDirWithNotes(ctx(), 3);
      ok(dir, '进到一个本层 ≥3 篇的目录');
      const level = levelIn(dir);
      const pick = ctx().index.notes().find((e) => !level.includes(e.path));
      ok(pick, '库里得有一篇不在本层');
      await jumpTo(pick.path);
      ok(restoreBtn(), '前提：跳转之后有「还原」');
      /**
       * ⚠️ 跳转带了预选中 → 工具条整条被**批量栏**顶掉（§3.4）→ 搜索框不在 DOM 里。
       * 先清选择（点批量栏的 ✕，不是模拟 Esc —— Esc 会顺带清掉跳转筛选，那就没得验了）。
       */
      H.click(H.q<HTMLElement>(document.body, '.kbw-batch-tail .kbw-iconbtn'));
      await H.settle(160);
      ok(restoreBtn(), '清选择之后「还原」仍在（它只清选择）');

      // 改搜索词 —— 与"点目录"同级：都是显式的视野动作
      const box = H.q<HTMLInputElement>(document.body, '.kbw-search');
      box.value = dir.split('/').pop() ?? dir;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(160);
      ok(!restoreBtn(), '改了搜索词之后，「还原」不该再挂着（那份清单已经结束）');
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(160);
    });

    await suite.it('① `Esc` 分两层：先清选择、再清"跳转筛选"（分层可见）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      const dir = await H.enterTopDirWithNotes(ctx(), 3);
      ok(dir, '进到一个本层 ≥3 篇的目录');
      const level = levelIn(dir);
      const pick = ctx().index.notes().find((e) => !level.includes(e.path));
      ok(pick, '库里得有一篇不在本层');
      await jumpTo(pick.path);
      ok(restoreBtn(), '前提：跳转之后有「还原」');

      const host = H.q(document.body, '.kbw-notes');
      // 第一次 Esc：清**选择**（批量栏 → 工具条；筛选还在 → 列表还是那一篇）
      H.keydown(host, 'Escape');
      await H.settle(220);
      ok(!H.maybe(document.body, '.kbw-notes-bar.is-batch'), '第一次 Esc：选择清了（批量栏没了）');
      eq(rowPaths().join(','), pick.path, '第一次 Esc **不动筛选**（还是只列那一篇）');
      ok(restoreBtn(), '第一次 Esc 之后「还原」还在');

      // 第二次 Esc：清**跳转筛选**（列表回到本层那一批）
      H.keydown(H.q(document.body, '.kbw-notes'), 'Escape');
      await H.settle(240);
      eq([...rowPaths()].sort().join(','), [...level].sort().join(','), '第二次 Esc：跳转筛选清了（列表回到本层）');
      ok(!restoreBtn(), '第二次 Esc 之后「还原」自己消失');
      /**
       * ⚠️ 判据是**逐路径**而不是"变了没"：分层只要"第一次也清了"就会在第 2 步红
       *（那时列表已经回到本层），所以这一段本身就钉住了"两层是分开的"。
       */
    });

    await suite.it('① **用户自己改过筛选之后**，点目录不许把他的筛选清掉（守卫的判据）', async () => {
      /**
       * 🔴 独立审查 B🔴2：`endJumpScope` 里那道 `if (!this.canRestoreJump(s)) return;` 守卫
       * **零覆盖** —— 现有用例走的都是"跳转 → 立刻点目录"（这一份**就是**跳转给的那份）。
       * 突变实测：把守卫整行删掉（= 点目录时无条件清筛选），`①` 四条 + `A3` + `筛选` 那 11 条
       * **全绿** ✗。所以这条时序必须单独钉住：**跳转 → 用户自己改筛选 → 再点目录**。
       */
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      const dir = await H.enterTopDirWithNotes(ctx(), 3);
      ok(dir, '进到一个本层 ≥3 篇的目录');
      const level = levelIn(dir);
      const pick = ctx().index.notes().find((e) => !level.includes(e.path));
      ok(pick, '库里得有一篇不在本层');
      await jumpTo(pick.path);
      ok(restoreBtn(), '前提：跳转之后有「还原」');

      // 用户自己去筛选面板加一条（这一份筛选**是他给的**了）
      H.click(H.q<HTMLElement>(document.body, '.kbw-batch-tail .kbw-iconbtn')); // 先清选择（批量栏的 ✕）
      await H.settle(160);
      const filterBtn = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
        H.textOf(b).startsWith('筛选'),
      );
      ok(filterBtn, '有「筛选」按钮');
      H.click(filterBtn as Element);
      await H.settle(140);
      const panel = H.q(document.body, '.kbw-panel');
      const chip = H.qa<HTMLElement>(panel, '.kbw-chip.is-pickable').find((c) =>
        H.textOf(c) === '只看隐藏',
      );
      ok(chip, '筛选面板里有「只看隐藏」');
      H.click(chip as Element);
      await H.settle(160);
      H.keydown(document.body, 'Escape'); // 关面板（不改筛选）
      await H.settle(160);
      /** 用户那条筛选还在吗 —— 直接问筛选面板里那个 chip 的勾选态（比读徽标稳） */
      const chipOn = async (label: string): Promise<boolean> => {
        const fb = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
          H.textOf(b).startsWith('筛选'),
        );
        if (!fb) return false;
        H.click(fb);
        await H.settle(140);
        const pnl = H.q(document.body, '.kbw-panel');
        const ch = H.qa<HTMLElement>(pnl, '.kbw-chip.is-pickable').find((c) =>
          H.textOf(c) === label,
        );
        const on = ch?.classList.contains('is-on') === true;
        H.keydown(document.body, 'Escape');
        await H.settle(140);
        return on;
      };
      ok(await chipOn('只看隐藏'), '前提：用户自己加的「只看隐藏」已经在生效（chip 亮着）');

      // 现在点目录：**用户的那条筛选必须留着**（守卫该拦住）
      ok(await H.clickTreeNode(dir), '点回那个目录');
      await H.settle(160);
      ok(
        await chipOn('只看隐藏'),
        '用户自己设的那条筛选**还在**（点目录不该把它清掉 —— 守卫的判据）',
      );
      ok(!restoreBtn(), '而跳转那条「还原」口子该消失（现在这份筛选不是跳转给的了）');

      // 收尾：清掉用户那条筛选（别污染后面的用例）
      const fb2 = H.qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn').find((b) =>
        H.textOf(b).startsWith('筛选'),
      );
      if (fb2) {
        H.click(fb2);
        await H.settle(140);
        const clear = H.qa<HTMLElement>(document.body, '.kbw-panel .kbw-btn').find((b) =>
          H.textOf(b).includes('清除全部筛选'),
        );
        if (clear) H.click(clear);
        await H.settle(200);
        H.keydown(document.body, 'Escape');
        await H.settle(140);
      }
    });

    await suite.it('① 跳过来那一刻给一条轻通知（说明"已筛选 · 可还原"）', async () => {
      closeAllMenus();
      __resetNotices();
      ctx().goNotes();
      await H.settle(120);
      const dir = await H.enterTopDirWithNotes(ctx(), 3);
      ok(dir, '进到一个本层 ≥3 篇的目录');
      const pick = ctx().index.notes().find((e) => !levelIn(dir).includes(e.path));
      ok(pick, '库里得有一篇不在本层');
      await jumpTo(pick.path);
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-notice').some((n) => H.textOf(n).includes('可还原')),
        `跳转时要有那条轻通知（实际：${H.textsOf(document.body, '.kbw-notice').join(' | ')}）`,
      );
      closeAllMenus();
      __resetNotices();
      await H.settle(80);
    });

    await suite.it('② 本层口径：点目录只看本层，搜索仍然"往下找"', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      /**
       * ⚠️ 这条用例要的目录**必须是"本层 + 子目录都有笔记"的那种** ——
       * 否则"浏览 = 本层 / 搜索 = 子树"两种口径**看不出差别**（判据空转）。
       * 夹具里 00_Inbox 本层 8 篇但没有子目录，02_Areas 正好相反 —— 从数据里挑。
       */
      const withSub = Array.from(new Set(ctx().index.notes().map((e) => e.effectivePosition)))
        .filter((d) => d && !d.includes('/') && levelIn(d).length > 0)
        .find((d) => underIn(d).length > levelIn(d).length);
      ok(withSub, '夹具里得有一个"本层有笔记、子目录也有笔记"的顶层目录');
      const dir = withSub as string;
      ok(await H.clickTreeNode(dir), `进到 ${dir}`);
      eq([...rowPaths()].sort().join(','), levelIn(dir).join(','), '浏览态：只有本层那几篇');
      ok(levelIn(dir).length < underIn(dir).length, '这个目录得有子目录（不然这条判据是空转）');
      // 搜索 → 递归（子树）：与 Windows"在文件夹里搜"一致
      const box = H.q<HTMLInputElement>(document.body, '.kbw-search');
      box.value = '.md';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(180);
      eq([...rowPaths()].sort().join(','), underIn(dir).join(','), '搜索态：**往下找**（子树那一批）');
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(180);
      // ⚠️ 独立审查 §5.4：收尾这句原先比**数量** → 与前面两句一样改成**逐路径**
      eq(
        [...rowPaths()].sort().join(','),
        levelIn(dir).join(','),
        '清掉搜索词 → 回到本层（逐路径比）',
      );
    });

    await suite.it('② 拖拽预告：**从子目录拖到祖先目录**时数字不变（基准与增量同口径，A🔴1 的回归）', async () => {
      /**
       * 🔴 独立审查 A🔴1：`dropInfo` 原先 `from` 取树上**递归**数、`inside` 用**不递归**的
       * `inDir` → "从子目录拖到祖先目录"会**多报 N**（取证：树上 A=3，预告写「3 → 4」，
       * 松手后仍是 3）。修法是把 `inside` 换成 `underDir`（递归）—— 基准与增量必须同口径。
       * 这条判据就钉"拖到祖先时预告的两个数**相等**"（那篇本来就在它底下）。
       */
      closeAllMenus();
      ctx().goNotes({ dir: '02_Areas/内容创作' });
      await H.settle(220);
      const src = rows()[0];
      ok(src, '02_Areas/内容创作 里得有一篇来拖（夹具里 6 篇）');
      const fromPath = src.dataset.path ?? '';
      const ancestor = treeItems().find((i) => i.dataset.dir === '02_Areas');
      ok(ancestor, '树上有祖先节点 02_Areas');
      const cntText = H.textOf(ancestor?.querySelector('.kbw-tree-count') ?? null);
      const before = Number(cntText);
      ok(before > 0, `祖先节点上有个数（读到 ${cntText}）`);

      const grip = H.q<HTMLElement>(src, 'td[data-col="name"]');
      const a = grip.getBoundingClientRect();
      const b = (ancestor as HTMLElement).getBoundingClientRect();
      const live = (): Element =>
        treeItems().find((i) => i.dataset.dir === '02_Areas') ?? document.body;
      H.pointerDown(grip, { x: a.left + 20, y: a.top + 8 });
      await H.tick(10);
      H.pointerMove(document.body, { x: a.left + 26, y: a.top + 10 });
      await H.tick(10);
      H.pointerMove(live(), { x: b.left + 20, y: b.top + 8 });
      await H.tick(20);
      const preview = H.maybe<HTMLElement>(document.body, '.kbw-tree-preview');
      ok(preview, '掠过祖先节点 → 出现预告');
      const nums = (H.textOf(preview) ?? '').match(/\d+/g) ?? [];
      ok(nums.length === 2, `预告是两个数（读到「${H.textOf(preview)}」）`);
      eq(
        nums[0],
        String(before),
        '预告的**基准** = 树上那个数（含子目录）',
      );
      eq(
        nums[1],
        String(before),
        '被拖的那篇**本来就在它底下** → 预告的落点数**不变**（A🔴1：口径不一致时会多报 1）',
      );
      /**
       * 松手：那一篇会**上移一层**（`02_Areas/内容创作/x.md` → `02_Areas/x.md`）——
       * 而祖先的**含子目录**数**不变**（它底下还是那几篇）✓ 这正是预告写「N → N」的原因。
       * ⚠️ 收尾要**撤销**回去（别把夹具搬乱）。
       */
      H.pointerUp(live(), { x: b.left + 20, y: b.top + 8, buttons: 0 });
      await H.settleIndex(app);
      const name = fromPath.split('/').pop() ?? '';
      const upOne = `01_新知识库/02_Areas/${name}`;
      eq(
        Boolean(app.vault.getAbstractFileByPath(upOne)),
        true,
        `那一篇上移了一层（${upOne}）`,
      );
      const undo = H.currentUndoButton('撤销');
      ok(undo, '拖完出撤销条');
      if (undo) H.click(undo);
      await H.settleIndex(app);
      eq(
        Boolean(app.vault.getAbstractFileByPath(fromPath)),
        true,
        '撤销之后回到原处（夹具不受污染）',
      );
    });

    await suite.it('② 面包屑写「本层 N 篇」；树上那个数字标明「含子目录」', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      const dir = await H.enterTopDirWithNotes(ctx(), 3);
      ok(dir, '进到一个本层 ≥3 篇的目录');
      eq(
        H.textOf(H.q(document.body, '.kbw-crumbs-count')),
        `本层 ${levelIn(dir).length} 篇`,
        '面包屑的计数 = 当前列表的篇数（不是全库）',
      );
      const rootItem = H.qa<HTMLElement>(document.body, '.kbw-tree-item').find(
        (i) => (i.dataset.dir ?? '') === '',
      );
      const cnt = rootItem?.querySelector<HTMLElement>('.kbw-tree-count');
      ok(cnt, '树上那个数字还在');
      eq(cnt?.getAttribute('title'), null, '#7：树上数字不挂 title（双提示根治）');
      contains(cnt?.getAttribute('aria-label') ?? '', '含子目录', '口径写进 aria-label（含子目录）');
    });

    await suite.it('② `Alt+↑` 回上一级；在库根上按它什么都不发生', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      const dir = await H.enterTopDirWithNotes(ctx(), 3);
      ok(dir, `进到一个本层 ≥3 篇的目录（${dir}）`);
      H.keydown(H.q(document.body, '.kbw-notes'), 'ArrowUp', { altKey: true });
      // ⚠️ 目录是**防抖 400ms 落盘**的 → 直接 eq 会读到上一次的值（等它落下去）
      ok(
        await H.until(() => ctx().settings.get().treeSelected === '', 1500, 30),
        `\`Alt+↑\` 回到了上一级（实际 ${ctx().settings.get().treeSelected}）`,
      );
      // 再按一次：库根上再往上还是库根（不报错、不弹东西）
      H.keydown(H.q(document.body, '.kbw-notes'), 'ArrowUp', { altKey: true });
      await H.settle(240);
      eq(ctx().settings.get().treeSelected, '', '库根上再按 Alt+↑ 还是库根');
    });
  });

  /**
   * ────────────────────────────────────────────────────────────────
   * P7.1b · **目录口径：根层与其它层同款**（2026-10-03，**反转 P6⑧**）
   *
   * P6⑧（2026-09-29）曾拍"根层 = 整个库（递归）"—— 当时详细/紧凑档**画不出文件夹**，
   * "整个知识库"不递归就"点全部笔记一篇都看不见"（用户报的那条）。
   * P7.1b 反转：文件夹行走上详细档（2.2）之后那个成因消失了，而"根层平铺"的代价现形 ——
   * 用户 2026-10-03 截图：网格根层把 99_Meta 等深层 216 篇**平铺在文件夹格旁边**
   *（"本该在文件夹内的文件显示在了外面"），层级是假的、与 Windows 不一致。
   *
   * 这一组钉**三个方向**（少一个，"反向再翻一次"就会绿）：
   *   ① 根层**浏览** = 只画本层（深层文件不再平铺，两档都如此；导航交给文件夹行/格）；
   *   ② 根层**搜索 / 筛选** = 照旧**往下找**（那条轴一个字没动）；
   *   ③ 具体目录照旧只画本层（P6b ② 的口径没被翻掉）。
   */
  await suite.group('P7.1b · 目录口径（根层不再平铺 / 搜索筛选仍往下找 / 子目录仍本层）', async () => {
    const crumb = (): string => H.textOf(H.q(document.body, '.kbw-crumbs-count'));

    /** 切视图档（有选择时档位按钮整条被批量栏顶掉 —— 先清选择） */
    const pickView = async (label: string): Promise<void> => {
      closeAllMenus();
      const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
      if (bar) {
        const x = H.qa<HTMLElement>(bar, 'button').find((b) =>
          (b.getAttribute('aria-label') ?? '').includes('清空选择'),
        );
        if (x) H.click(x);
        await H.settle(60);
      }
      const seg = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
        H.textOf(b).includes(label),
      );
      ok(seg, `视图档「${label}」在`);
      H.click(seg as Element);
      await H.settle(240);
    };

    await suite.it('🔴 根层浏览：两档都不再平铺深层文件（本层 + 文件夹）· 面包屑写「本层 N 篇」', async () => {
      ctx().goNotes();
      await H.settle(120);
      // 先站进一个子目录，再**点回「整个知识库」** —— 复现用户那条路（点导航项）
      const dir = await H.enterTopDirWithNotes(ctx(), 3);
      ok(dir, `先站进一个本层 ≥3 篇的目录（${dir}）`);
      ok(await H.clickTreeNode(''), '点回「整个知识库」');
      await H.settle(120);

      const level = levelIn('');
      const deep = underIn('');
      ok(
        deep.length > level.length,
        `夹具前提：库根本层 ${level.length} 篇、整个库 ${deep.length} 篇 —— 不成立就测不出"不再平铺"`,
      );
      /**
       * 表格那一档逐路径比；网格档看**带 `data-path` 的笔记格**
       *（文件夹格没有 `data-path` —— 那是"导航不是笔记"的标志，见 `grid.ts`）。
       */
      await pickView('详细信息');
      eq(
        rowPaths().length,
        level.length,
        `详细档：根层只画本层（该 ${level.length} 篇；深层那 ${deep.length - level.length} 篇不许平铺进来）`,
      );
      eq(
        [...rowPaths()].sort().join(','),
        [...level].sort().join(','),
        '详细档：列出的正好是库根这一层那几篇（逐路径比，不是"数得一样"）',
      );
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-frow').length > 0,
        '详细档：根层的**文件夹行**画出来了（导航交给它 —— 少了它根层才是真的"什么都没有"）',
      );
      eq(crumb(), `本层 ${level.length} 篇`, '详细档：面包屑写「本层 N 篇」（P7.1b 起根层不再写「全部」）');

      await pickView('网格');
      const noteCells = H.qa<HTMLElement>(document.body, '.kbw-gcell[data-path]')
        .map((c) => c.dataset.path ?? '')
        .sort();
      eq(noteCells.length, level.length, `网格档：根层也只画本层（该 ${level.length} 篇）`);
      eq(noteCells.join(','), [...level].sort().join(','), '网格档：列出的正好是库根这一层那几篇（逐路径比）');
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-gcell.is-folder').length > 0,
        '网格档：根层的文件夹格照旧在（导航）',
      );
      eq(crumb(), `本层 ${level.length} 篇`, '网格档：面包屑照旧写「本层 N 篇」');

      await pickView('详细信息');
      ctx().goNotes();
      await H.settle(120);
    });

    await suite.it('🔴 根层搜索 / 筛选：照旧往下找（"找东西"那条轴一个字没动）', async () => {
      ctx().goNotes();
      await H.settle(120);
      ok(await H.clickTreeNode(''), '回到「整个知识库」');
      await H.settle(120);
      const deepOnly = underIn('').filter((p) => !levelIn('').includes(p));
      ok(deepOnly.length > 0, '库里得有"不在库根本层"的笔记');
      const target = ctx().index.notes().find((e) => e.path === deepOnly[0]);
      const kw = (target?.basename ?? '').slice(0, 2);
      ok(kw.length >= 2, `取一个关键词（${kw}）`);
      const box = H.q<HTMLInputElement>(document.body, '.kbw-search');
      box.value = kw;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(140);
      const hits = rowPaths();
      ok(
        hits.includes(deepOnly[0] as string),
        `在根层搜索「${kw}」要能命中深层那篇（${deepOnly[0]}）—— "往下找"的真正判据是这条（那篇不在本层）`,
      );
      ok(hits.length >= 1, `搜索有命中（${hits.length} 篇）`);
      eq(crumb(), `命中 ${hits.length} 篇`, '搜索态面包屑写「命中 N 篇」');
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(140);
      eq(rowPaths().length, levelIn('').length, '清掉搜索词 → 回到本层那一批（不再平铺）');

      /**
       * 筛选那条轴与搜索**共用 `isDeepQuery` 判据** —— 这里再用跳转筛选打一发，
       * 钉住"根层筛选也照旧跨子树"（夹具里那篇失效双链在 00_Inbox/，相对根层是深层）。
       */
      const deepFlag = ctx()
        .index.notes()
        .find((e) => !levelIn('').includes(e.path) && e.flags.includes('broken-link'));
      ok(deepFlag, '夹具里得有一篇"不在库根本层、带失效双链"的笔记');
      ctx().goNotes({ flags: ['broken-link'] });
      await H.settle(200);
      ok(rowPaths().includes(deepFlag?.path ?? ''), '筛选在根层照旧跨子树命中（往下找）');
      ok(await H.clickTreeNode(''), '点回「整个知识库」（一次性清单到此为止）');
      await H.settle(140);
      eq(rowPaths().length, levelIn('').length, '筛清除后回到本层那一批');
      ctx().goNotes();
      await H.settle(120);
    });

    await suite.it('具体目录**仍只画本层**（P6b ② 的 Windows 口径一个字没改）', async () => {
      ctx().goNotes();
      await H.settle(120);
      /**
       * 挑一个"**本层有笔记、且子目录里还有**"的顶层目录（两条都要，不然这一条测不出东西）：
       * 只有"本层 ≥1 且 子树 > 本层"，才分得出"递归"与"不递归"两种读法。
       * ⚠️ 候选从数据里取（别写死 `02_Areas`：夹具一换就假红）。
       */
      const tops = Array.from(
        new Set(ctx().index.notes().map((e) => e.effectivePosition.split('/')[0]).filter((d) => d !== '')),
      );
      const dir = tops.find((d) => levelIn(d).length >= 1 && underIn(d).length > levelIn(d).length);
      ok(
        dir,
        `夹具里得有一个"本层有笔记、子目录里也有"的顶层目录（顶层：${tops.join('、')}）`,
      );
      ok(await H.clickTreeNode(dir as string), `进到「${dir}」`);
      await H.settle(120);
      const level = levelIn(dir as string);
      const deep = underIn(dir as string);
      ok(deep.length > level.length, `前提：子树比本层多（本层 ${level.length} / 子树 ${deep.length}）`);
      eq(rowPaths().length, level.length, '只画本层（递归在这一层不该生效）');
      eq(
        [...rowPaths()].sort().join(','),
        [...level].sort().join(','),
        '列出的正好是这一层那几篇（逐路径比）',
      );
      contains(crumb(), '本层', '面包屑在这一层照旧写「本层 N 篇」');
      ctx().goNotes();
      await H.settle(120);
    });
  });

  /**
   * ────────────────────────────────────────────────────────────────
   * P7.1b · **2.2 文件夹行（详细档）**（用户 2026-10-02 定稿 + 4 处补充）
   *
   * 置顶的导航行：数据源/计数与**网格文件夹格同一份**（真子目录，空目录也画；
   * 搜索/筛选时不画）；单击选中（独立于笔记选择集）/ 双击进入 / Enter 进入 /
   * Space 不做 / 右键复用网格那扇菜单 / **拖入 = 搬（走 mover）**。
   * 实现落点是 `ui/table.ts` 的 `topRows`（真 `<tr>`、与列对齐、类名 `.kbw-frow`）。
   */
  await suite.group('P7.1b · 2.2 文件夹行（详细档）', async () => {
    /** 文件夹行（详细档）——注意它是 `.kbw-frow` 而**不是** `.kbw-trow`（刻意分开的类名） */
    const frows = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-frow');
    const dblClick = (el: Element): void => {
      // 真机的双击序列是 click → click → dblclick
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    };
    /** 某个目录的**真实直接子目录**（相对库根）——与 `foldersFor` 同一条数据源口径 */
    const subdirsOf = (dir: string): string[] => {
      const abs = dir ? `${KB}/${dir}` : KB;
      const out: string[] = [];
      for (const f of app.vault.getAllLoadedFiles()) {
        if (!('children' in f)) continue; // 不是文件夹
        if (f.parent?.path !== abs) continue;
        out.push(dir ? `${dir}/${f.name}` : f.name);
      }
      return out.sort((a, b) => a.localeCompare(b, 'zh'));
    };
    /** 这一层（含子目录）最新的 mtime */
    const maxMtimeUnder = (dir: string): number => {
      let max = 0;
      for (const e of ctx().index.notes()) {
        const pos = e.effectivePosition;
        if (pos === dir || pos.startsWith(`${dir}/`)) max = Math.max(max, e.mtime);
      }
      return max;
    };
    /** 挑一个"本层有笔记、且**直接子目录里也有笔记**"的顶层目录（两条都要，不然下面几条判据空转） */
    const pickDir = (): string => {
      const tops = Array.from(
        new Set(ctx().index.notes().map((e) => e.effectivePosition.split('/')[0]).filter((d) => d !== '')),
      );
      return tops.find((d) => levelIn(d).length >= 1 && subdirsOf(d).length >= 1) ?? '';
    };
    const pickView = async (label: string): Promise<void> => {
      closeAllMenus();
      const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
      if (bar) {
        const x = H.qa<HTMLElement>(bar, 'button').find((b) =>
          (b.getAttribute('aria-label') ?? '').includes('清空选择'),
        );
        if (x) H.click(x);
        await H.settle(60);
      }
      const seg = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
        H.textOf(b).includes(label),
      );
      ok(seg, `视图档「${label}」在`);
      H.click(seg as Element);
      await H.settle(240);
    };

    await suite.it('行在（置顶 + 真子目录 + 空目录也画）· 计数「名 · N 篇」（aria-label 含子目录）· 修改时间 = 最新一篇', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      await pickView('详细信息');
      const dir = pickDir();
      ok(dir, '夹具里得有一个"本层有笔记、且有直接子目录"的顶层目录');
      ok(await H.clickTreeNode(dir), `进到「${dir}」`);
      await H.settle(160);

      const subs = subdirsOf(dir);
      ok(subs.length >= 1, `这一层有真子目录（${subs.join('、')}）`);
      ok(frows().length >= 1, `文件夹行画出来了（实际 ${frows().length} 行）`);

      // ① 每一行都是当前目录的**直接子目录**（不是别处的目录、也不是笔记）
      const shownDirs = frows().map((r) => r.dataset.dir ?? '');
      for (const d of shownDirs) {
        if (d === '') continue; // 自造的空目录行等下单独验
        ok(d.startsWith(`${dir}/`), `${d} 是 ${dir} 下面的`);
        ok(d.slice(dir.length + 1).indexOf('/') < 0, `${d} 是**直接**子目录（不是孙目录）`);
      }
      // ② **置顶**：所有文件夹行都排在笔记行之前（同一 tbody 的文档顺序）
      const trs = H.qa<HTMLElement>(document.body, '.kbw-table tbody tr');
      const lastFolder = trs.map((r) => r.classList.contains('kbw-frow')).lastIndexOf(true);
      const firstNote = trs.findIndex((r) => r.classList.contains('kbw-trow'));
      ok(
        lastFolder >= 0 && firstNote >= 0 && lastFolder < firstNote,
        `文件夹行全部排在笔记行之前（置顶；实际 lastFolder=${lastFolder} firstNote=${firstNote}）`,
      );

      // ③ 身份：没有 data-path（不参与"选 N 篇"），有 data-drop（拖上去 = 搬），行里没有复选框
      ok(frows().every((r) => r.dataset.path === undefined), '文件夹行没有 data-path（它不是笔记行）');
      ok(
        frows().every((r) => r.dataset.drop === r.dataset.dir),
        '文件夹行有 data-drop（拖笔记到它上面 = 搬到那个目录）',
      );
      ok(
        frows().every((r) => r.querySelector('.kbw-rowcheck') === null),
        '文件夹行没有复选框（不进选择集）',
      );

      /**
       * ④ 计数「名 · N 篇」：N = **含子目录**的笔记数（与目录树上那个数字同口径）——
       * 从索引里的真数比（别写死），并卡 `> 0`（防"恒 0 也绿"）。
       */
      const entries = ctx().index.notes();
      for (const sd of subs) {
        const row = frows().find((r) => r.dataset.dir === sd);
        ok(row, `子目录「${sd}」有一行`);
        const real = entries.filter(
          (e) => e.effectivePosition === sd || e.effectivePosition.startsWith(`${sd}/`),
        ).length;
        const cnt = H.textOf((row as HTMLElement).querySelector('.kbw-frow-count') ?? null);
        eq(cnt, `· ${real} 篇`, `${sd} 的计数 = 含子目录的篇数（实际「${cnt}」）`);
        eq(
          (row as HTMLElement).querySelector('.kbw-frow-count')?.getAttribute('title'),
          null,
          `${sd} 的计数不挂 title（#7 双提示根治）`,
        );
        contains(
          (row as HTMLElement).querySelector('.kbw-frow-count')?.getAttribute('aria-label') ?? '',
          '含子目录',
          `${sd} 的计数口径写进 aria-label（含子目录）`,
        );
      }

      /**
       * ⑤ 修改时间列 = **目录下（含子目录）最新一篇**的 mtime。
       * ⚠️ 夹具里所有文件的 mtime 都是**夹具重建那一刻**（互相几乎相同）——"最新一篇在
       * 深层"这种形状得**现造**才分得出两种读法：造一个"**本层没有笔记、只有更深一层有**"
       * 的子目录 —— 只看本层的实现会渲染「—」（没有可参照的一篇），含子目录的给真时间。
       *
       * ⚠️ **自造夹具起、整段包 `try`，删除放 `finally`**（独立审查 🟡2）：`ok/eq` 是抛异常的，
       * 中间任何一条红了，直线写下去的收尾不会执行 —— 自造目录会留在**共享的 B 库**里，
       * 后面的 specGrid / specBoard 也跟着遭殃（"失败集合每次都变"的来源之一）。
       */
      const deepOnly = `__小修深层-${Date.now()}`;
      const emptyName = `__小修空行-${Date.now()}`;
      try {
        fs.mkdirSync(path.join(vaultRoot, KB, dir, deepOnly, '深处'), { recursive: true });
        fs.writeFileSync(
          path.join(vaultRoot, KB, dir, deepOnly, '深处', '深.md'),
          '---\n类型: 笔记\n状态: 进行中\n创建日期: 2026-10-03\n---\n\n深。\n',
          'utf8',
        );
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(200);
        const deepNote = ctx().index.notes().find(
          (e) => e.effectivePosition === `${dir}/${deepOnly}/深处`,
        );
        ok(deepNote, `自造的深层笔记进了索引（${dir}/${deepOnly}/深处/深.md）`);
        const rowD = frows().find((r) => r.dataset.dir === `${dir}/${deepOnly}`);
        ok(rowD, '只有深层笔记的子目录也占一行');
        eq(
          H.textOf((rowD as HTMLElement).querySelector('.kbw-frow-count') ?? null),
          '· 1 篇',
          '计数含子目录（本层 0 篇、深处 1 篇）',
        );
        eq(
          H.textOf((rowD as HTMLElement).querySelector('td[data-col="mtime"]') ?? null),
          formatRelativeTime(deepNote?.mtime ?? 0),
          '修改时间取**含子目录**的最新一篇（只看本层的话这儿会是「—」）',
        );
        // 普通子目录（本层就有笔记）也顺手对一遍口径
        const rowM = frows().find((r) => r.dataset.dir === subs[0]);
        eq(
          H.textOf((rowM as HTMLElement).querySelector('td[data-col="mtime"]') ?? null),
          formatRelativeTime(maxMtimeUnder(subs[0])),
          '修改时间 = 目录下（含子目录）最新一篇（与索引里的真数比）',
        );

        // ⑥ **空目录也画**（夹具里没有空目录这种东西 → 现造一个）
        fs.mkdirSync(path.join(vaultRoot, KB, dir, emptyName), { recursive: true });
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(180);
        const emptyRow = frows().find((r) => (r.dataset.dir ?? '').endsWith(emptyName));
        ok(emptyRow, `空目录也要占一行（实际：${frows().map((r) => r.dataset.dir).join(' / ')}）`);
        eq(H.textOf((emptyRow as HTMLElement).querySelector('.kbw-frow-count') ?? null), '· 0 篇', '它的计数是 0 篇');
        eq(
          H.textOf((emptyRow as HTMLElement).querySelector('td[data-col="mtime"]') ?? null),
          '—',
          '空目录的修改时间格写「—」（没有可参照的一篇）',
        );
      } finally {
        // 收尾：删掉自造的两个目录 + 回库根（别把夹具留给后面的用例）——无论红绿都执行
        fs.rmSync(path.join(vaultRoot, KB, dir, emptyName), { recursive: true, force: true });
        fs.rmSync(path.join(vaultRoot, KB, dir, deepOnly), { recursive: true, force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settle(160);
        await H.clickTreeNode('');
        await H.settle(120);
      }
    });

    await suite.it('交互：单击选中（不进目录、不入选择集）· 双击 / Enter 进入 · Space 不做 · 点空白撤高亮', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      await pickView('详细信息');
      const dir = pickDir();
      ok(dir, '夹具里得有一个"本层有笔记、且有直接子目录"的顶层目录');
      ok(await H.clickTreeNode(dir), `进到「${dir}」`);
      await H.settle(160);
      const row0 = frows()[0];
      ok(row0, '有文件夹行');
      const sub0 = row0.dataset.dir ?? '';
      ok(sub0, '行上带着目录路径');

      // ① 桌面单击 = 只选中（不进目录、不进"选 N 篇"的选中集）
      H.click(row0);
      await H.settle(140);
      ok(row0.classList.contains('is-selected'), '单击 = 选中这一行（与网格文件夹格同一套视觉）');
      eq(
        ctx().settings.get().treeSelected,
        dir,
        '单击**不**进入（那是双击的活 —— D3：单击选中 / 双击进入）',
      );
      eq(H.qa(document.body, '.kbw-trow[data-path].is-selected').length, 0, '不进"选 N 篇"的选中集');
      ok(!H.maybe(document.body, '.kbw-notes-bar.is-batch'), '批量栏不出现（没有笔记被选中）');

      // ② 先选中一篇笔记，再点文件夹行：**笔记的选择必须留着**（文件夹行是导航，两码事）
      const noteRow = rows()[0];
      ok(noteRow, '这一层有笔记行');
      H.click(noteRow);
      await H.settle(120);
      H.click(frows()[0]);
      await H.settle(120);
      eq(
        H.qa(document.body, '.kbw-trow[data-path].is-selected').length,
        1,
        '点文件夹行不清空笔记选择（与网格同款：两套选中各管各的）',
      );

      // ③ 点**列表空白** → 文件夹行的高亮撤掉（与"点空白取消笔记选中"同一条手感）
      H.q<HTMLElement>(document.body, '.kbw-notes-list').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await H.settle(120);
      eq(
        frows().filter((r) => r.classList.contains('is-selected')).length,
        0,
        '点空白取消文件夹行的高亮',
      );

      // ④ 双击 = 进入（面包屑跟着走）
      dblClick(frows()[0]);
      await H.settle(220);
      ok(
        await H.until(() => ctx().settings.get().treeSelected === sub0, 1500, 30),
        `双击 = 进那个目录（实际 ${ctx().settings.get().treeSelected}）`,
      );
      contains(H.textOf(H.q(document.body, '.kbw-crumbs')), sub0.split('/').pop() ?? '', '面包屑跟着走');
      ok(await H.clickTreeNode(dir), '回到这一层');
      await H.settle(160);

      // ⑤ Enter = 进入；**Space 不做**（D3 拍板：文件夹行不进选择集，Space 的"选中"语义无处安放）
      const rowK = frows()[0];
      const subK = rowK.dataset.dir ?? '';
      rowK.focus();
      H.keydown(rowK, ' ');
      await H.settle(140);
      eq(ctx().settings.get().treeSelected, dir, 'Space 不进入（"不做"就是不做）');
      ok(!rowK.classList.contains('is-selected'), 'Space 也不选中（与网格文件夹格的 Space=选中**不同**，这是 2.2 的拍板）');
      /**
       * ⚠️ 还要钉"**不许泄漏给全局键**"：Space 在键表里是「选中/取消选中」
       * （`toggle-select`）—— 文件夹行的处理函数不 `stopPropagation` 的话，
       * 焦点停在行上按一下空格会把**光标那篇笔记**选上（"键落在别处"的经典谜面）。
       */
      eq(
        H.qa(document.body, '.kbw-trow[data-path].is-selected').length,
        0,
        'Space 没泄漏给全局键（泄漏的话会把光标那篇笔记选上）',
      );
      H.keydown(rowK, 'Enter');
      await H.settle(220);
      ok(
        await H.until(() => ctx().settings.get().treeSelected === subK, 1500, 30),
        `Enter = 进入（实际 ${ctx().settings.get().treeSelected}）`,
      );
      ok(await H.clickTreeNode(dir), '回到这一层');
      await H.settle(160);

      // ⑥ 触屏（body.is-mobile）：单击**直接进**（触屏没有"选中"中间态，与网格文件夹格同款）
      document.body.classList.add('is-mobile');
      try {
        const touchRow = frows()[0];
        const touchSub = touchRow.dataset.dir ?? '';
        ok(touchSub, '触屏这一发有落点（文件夹行带着 dir）');
        H.click(touchRow);
        // ⚠️ 目录是**防抖 400ms 落盘**的 → 用 until 等它落定（写死短等待会假红）
        ok(
          await H.until(() => ctx().settings.get().treeSelected === touchSub, 1500, 30),
          `触屏单击 = 直接进（期望 ${touchSub}，实际 ${ctx().settings.get().treeSelected}）`,
        );
      } finally {
        document.body.classList.remove('is-mobile');
        await H.clickTreeNode('');
        await H.settle(120);
      }
    });

    await suite.it('搜索 / 筛选时不画（与网格文件夹格同一条判据）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      await pickView('详细信息');
      const dir = pickDir();
      ok(dir, '夹具里得有一个"本层有笔记、且有直接子目录"的顶层目录');
      ok(await H.clickTreeNode(dir), `进到「${dir}」`);
      await H.settle(160);
      ok(frows().length > 0, '前提：这一层本来就画着文件夹行（不然这条判据是空转）');

      const someNote = (rows()[0]?.dataset.path ?? '').split('/').pop()?.replace(/\.md$/, '') ?? '';
      const box = H.q<HTMLInputElement>(document.body, '.kbw-search');
      box.value = someNote.slice(0, 2);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(160);
      ok(
        rows().length > 0,
        `前提：搜索「${someNote.slice(0, 2)}」有命中（否则空转 —— 搜索时文件夹行不画是"它不匹配搜索词"的必然结果）`,
      );
      eq(frows().length, 0, '搜索时文件夹行是噪音 → 一条都不画');
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(160);
      ok(frows().length > 0, '清掉搜索词 → 文件夹行回来');
      await H.clickTreeNode('');
      await H.settle(120);
    });

    await suite.it('右键 = 复用网格那扇文件夹菜单（同一份实现）', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      await pickView('详细信息');
      const dir = pickDir();
      ok(dir, '夹具里得有一个"本层有笔记、且有直接子目录"的顶层目录');
      ok(await H.clickTreeNode(dir), `进到「${dir}」`);
      await H.settle(160);
      const row = frows()[0];
      ok(row, '有文件夹行');
      const sub = row.dataset.dir ?? '';
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(140);
      const menu = H.q(document.body, '.kbw-menu');
      ok(menu, '右键弹出菜单了');
      const labels = H.qa<HTMLElement>(menu, '.kbw-menu-item').map((i) => H.textOf(i));
      /**
       * 与网格那扇**同一份实现**（`showGridFolderMenu`）的标志性几项 —— 离线就钉这几条；
       * "真的是同一个函数"由实现侧保证（硬规矩：两处各写一份必漂）。
       */
      for (const want of ['进入这个目录', '在此新建笔记', '在系统资源管理器中打开']) {
        ok(labels.some((t) => t.includes(want)), `菜单里有「${want}」：${labels.join(' | ')}`);
      }
      contains(H.textOf(menu), sub.split('/').pop() ?? '', '作用域行写着这个文件夹');
      ok(row.classList.contains('is-selected'), '右键即选中（与网格文件夹格、表格行同一口径）');
      closeAllMenus();
      await H.clickTreeNode('');
      await H.settle(120);
    });

    await suite.it('🔴 拖一篇到文件夹行上 = 搬（走 mover）+ 撤销条能撤回', async () => {
      closeAllMenus();
      ctx().goNotes();
      await H.settle(120);
      await pickView('详细信息');
      const dir = pickDir();
      ok(dir, '夹具里得有一个"本层有笔记、且有直接子目录"的顶层目录');
      ok(await H.clickTreeNode(dir), `进到「${dir}」`);
      await H.settle(160);
      const src = rows()[0];
      ok(src, '这一层有一篇可以拖的笔记');
      const fromPath = src.dataset.path ?? '';
      const name = fromPath.split('/').pop() ?? '';
      const grip = H.q<HTMLElement>(src, 'td[data-col="name"]');

      // 落点：**第一个文件夹行**（它是本层的子目录，与被拖那篇不在一处 —— 搬是真的搬）
      const target = frows()[0];
      const toDir = target.dataset.dir ?? '';
      ok(toDir, '有落点（文件夹行）');
      const a = grip.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      H.pointerDown(grip, { x: a.left + 20, y: a.top + 8 });
      await H.tick(10);
      H.pointerMove(document.body, { x: a.left + 26, y: a.top + 10 });
      await H.tick(10);
      H.pointerMove(target, { x: b.left + 20, y: b.top + 8 });
      await H.tick(20);
      // 掠过文件夹行 → 行上要有"就放这儿"的落点高亮（独立审查 🟡3：与网格文件夹格同款）
      ok(
        target.classList.contains('is-drop'),
        '掠过文件夹行 → 行上有落点高亮（.is-drop）',
      );
      H.pointerUp(target, { x: b.left + 20, y: b.top + 8, buttons: 0 });
      await H.settleIndex(app);
      /**
       * ⚠️ **撤销放 `finally`**（独立审查 🟡2）：`ok/eq` 是抛异常的 —— 上面任何一条红了，
       * 直线写下来的"点撤销"就不会执行，被搬走的夹具笔记会**留在共享的 B 库里**
       *（后面 specGrid / specBoard 都在用它）→ 变成"失败集合每次都变"。
       */
      try {
        const want = `${KB}/${toDir}/${name}`;
        eq(
          Boolean(app.vault.getAbstractFileByPath(want)),
          true,
          `拖到文件夹行上 = 搬进那个目录（${want}；走 mover 那条链）`,
        );
        eq(
          Boolean(app.vault.getAbstractFileByPath(fromPath)),
          false,
          '老位置没了（成对判据："新位置有、老位置也在"是复制不是搬）',
        );
        ok(H.currentUndoButton('撤销') != null, '搬完出撤销条（与拖到目录树同一条链）');
        eq(
          H.qa(document.body, '.kbw-frow.is-drop').length,
          0,
          '落定之后没有残留的落点高亮（重画/收尾要清干净）',
        );
      } finally {
        const u = H.currentUndoButton('撤销');
        if (u) H.click(u);
        await H.settleIndex(app);
      }
      eq(
        Boolean(app.vault.getAbstractFileByPath(fromPath)),
        true,
        '撤销之后回到原处（夹具不受污染）',
      );
      await H.clickTreeNode('');
      await H.settle(120);
    });
  });

  /**
   * ────────────────────────────────────────────────────────────────
   * P7.0a · 批 1 小修（这几条都是"改对了但没人能证明它没漂回去"的高危项）
   *   ④ 空态动作按钮 · ⑦ 撤销条与通知去重（`quiet`）· ⑨ 迁移菜单死选项
   * ────────────────────────────────────────────────────────────────
   */
  await suite.group('P7.0a · 批 1 小修（空态动作 / 通知去重 / 迁移死选项）', async () => {
    /** 切视图档（有选择时档位按钮被批量栏顶掉 → 先点它的 ✕ 清选择） */
    async function pickView(label: string): Promise<void> {
      closeAllMenus();
      const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
      if (bar) {
        const clear = H.qa<HTMLElement>(bar, 'button').find((b) =>
          (b.getAttribute('aria-label') ?? '').includes('清空选择'),
        );
        if (clear) H.click(clear);
        await H.settle(50);
      }
      const seg = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
        H.textOf(b).includes(label),
      );
      ok(seg, `视图档「${label}」在`);
      H.click(seg as Element);
      await H.settle(200);
    }

    await suite.it('④ 空目录的空态带「＋ 在这里新建」—— 兜底那支也要给动作（且落点=当前目录）', async () => {
      closeAllMenus();
      __resetNotices();
      // 起手把搜索清掉（有搜索词时走的是「清除搜索」那一支，测不到兜底分支）
      const searchInput = H.maybe<HTMLInputElement>(document.body, '.kbw-search');
      if (searchInput && searchInput.value !== '') {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        await H.settle(120);
      }
      const view0 = ctx().settings.get().notesView;

      // 造一个**真的一无所有**的目录（本层没笔记、也没子文件夹）—— 兜底分支的唯一入口
      const name = `__小修空目录-${Date.now()}`;
      fs.mkdirSync(path.join(vaultRoot, KB, name), { recursive: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(160);

      ctx().goNotes({ dir: name });
      await H.settle(120);
      await pickView('详细信息');

      const act = H.maybe<HTMLElement>(document.body, '.kbw-empty .kbw-empty-act .kbw-btn');
      ok(act, `兜底空态要有动作按钮（实际：${H.textsOf(document.body, '.kbw-empty').join(' | ')}）`);
      contains(H.textOf(act), '在这里新建', '按钮文案是「＋ 在这里新建」');

      // 点它 → 开新建对话框，且**落点预填当前这个目录**（这是这个按钮存在的意义）
      H.click(act as Element);
      await H.settle(60);
      const modal = H.maybe<HTMLElement>(document.body, '.kbw-modal');
      ok(modal, '点了要开新建对话框');
      contains(H.textOf(modal), '新建笔记', '开的是「新建笔记」');
      const dirSel = H.qa<HTMLSelectElement>(modal as HTMLElement, 'select')[0];
      eq(dirSel?.value, name, '落点下拉预填 = 当前目录（不是默认收件箱）');

      // 收尾：关对话框
      const cancel = H.qa<HTMLElement>(modal as HTMLElement, '.kbw-modal-foot .kbw-btn').find((b) =>
        H.textOf(b).includes('取消'),
      );
      if (cancel) H.click(cancel as Element);
      await H.settle(60);

      /**
       * ④b **筛选无结果 ≠ 空目录**（独立审查 🟡4）：`foldersFor` 见筛选就返回空，
       * 于是"筛选激活 + 本层零命中"也落到过兜底分支 —— 那时目录里**是有笔记的**。
       * 这条钉住：筛选时给的是**回头路**（还原/清除筛选），不是「＋ 在这里新建」。
       */
      // v2：拿一个**永远零命中**的显式清单当"筛选无结果"的入口
      //（不再用已退休的 missing-required 旗标 —— 那个值现在没有任何一篇会有）
      ctx().goNotes({ paths: ['01_新知识库/__没有这一篇__.md'] });
      await H.settle(150);
      const act2 = H.maybe<HTMLElement>(document.body, '.kbw-empty .kbw-empty-act .kbw-btn');
      ok(act2, `筛选空态也要有动作：${H.textsOf(document.body, '.kbw-empty').join(' | ')}`);
      ok(
        !H.textOf(act2).includes('在这里新建'),
        `筛选时不许给「＋ 在这里新建」（把"没有匹配"说成"这里空着"）：${H.textOf(act2)}`,
      );
      ok(
        ['还原显示', '清除筛选'].some((l) => H.textOf(act2).includes(l)),
        `筛选空态该给回头路（还原显示 / 清除筛选）：${H.textOf(act2)}`,
      );
      /**
       * 🔴 **把回头路走完**（点掉它）—— 两个理由缺一不可：
       * ① 它是这枚按钮的功能本身（点了筛选真的清掉，空态回到"空目录"那支）；
       * ② ⚠️ **不点就是一个跨用例污染源**：`goNotes({dir})` 不带 `flags/paths` 时
       *    `applyIntent` **不清 filters**（只把 jumpFilter 置 null）—— 第一版收尾就漏在这里，
       *    残留的 health 筛选把后面 grid/panels 组的"格数/文件夹格子"整片带红
       *    （本地实测：网格"至少 3 格（实际 2）"一路连锁 24 条）。
       */
      H.click(act2 as Element);
      await H.settle(150);
      const act3 = H.maybe<HTMLElement>(document.body, '.kbw-empty .kbw-empty-act .kbw-btn');
      ok(
        act3 != null && H.textOf(act3).includes('在这里新建'),
        `点了回头路 → 筛选清掉、回到"空目录"的空态（实际：${act3 ? H.textOf(act3) : '(没有动作按钮)'}）`,
      );

      // 收尾：删自造目录、视图档还回去
      ctx().goNotes({ dir: name });
      await H.settle(100);
      fs.rmSync(path.join(vaultRoot, KB, name), { recursive: true, force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(160);
      ctx().goNotes();
      await H.settle(80);
      // P7.1 两档化：存着的只可能是 detail / grid / null
      await pickView(view0 === 'grid' ? '网格' : '详细信息');
    });

    await suite.it('⑦a 撤销条在时 mover 不弹重复通知（quiet；走 F2 改名这条真链路）', async () => {
      closeAllMenus();
      __resetNotices();
      await openNotes();
      ok(await H.enterTopDirWithNotes(ctx(), 2), '进到一个本层 ≥2 篇的目录');
      const target = rows()[0];
      const oldPath = target.dataset.path ?? '';
      H.click(target);
      await H.settle(20);
      H.keydown(H.q(document.body, '.kbw-root'), 'F2');
      await H.settle(30);
      const input = H.q<HTMLInputElement>(document.body, '.kbw-inline-input');
      input.value = '__小修七改名';
      H.keydown(input, 'Enter');
      await H.settleIndex(app);
      ok(hasUndoBar(), '改名后出了撤销条');
      const dup = H.textsOf(document.body, '.kbw-notice').filter((t) => t.includes('已移动'));
      eq(dup.length, 0, `撤销条在时不该再弹「已移动…」的重复通知：${dup.join(' | ')}`);
      // 撤销回去
      const undoBtn = H.currentUndoButton('撤销');
      ok(undoBtn, '撤销条上有撤销按钮');
      H.click(undoBtn as Element);
      await H.settleIndex(app);
      ok(app.vault.getAbstractFileByPath(oldPath), '撤销把文件搬回原名');
    });

    await suite.it('⑦b `quiet` 只压"成功"——partial（撞名冲突）照旧弹出来（"被跳过的要说出来"）', async () => {
      __resetNotices();
      // 造一对同名不同内容的夹具（撞名冲突的标准形状）
      H.writeNote(vaultRoot, `${KB}/00_Inbox/__小修七同名.md`, '---\n类型: 想法\n---\n\n甲\n');
      H.writeNote(vaultRoot, `${KB}/01_Projects/__小修七同名.md`, '---\n类型: 想法\n---\n\n乙\n');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      const f = ctx().index.notes().find((e) => e.path === `${KB}/00_Inbox/__小修七同名.md`);
      ok(f, '夹具在索引里');
      __resetNotices();
      const res = await ctx().mover.move({
        targets: [{ dir: `${KB}/01_Projects`, files: [f?.file as never] }],
        source: 'batch',
        reason: '测试：quiet + 撞名',
        quiet: true,
      });
      await H.settle(80);
      eq(res.blocked.length, 1, '撞名被拦住（夹具前提）');
      const texts = H.textsOf(document.body, '.kbw-notice');
      ok(
        texts.some((t) => t.includes('撞名冲突')),
        `partial 通知照旧弹出（quiet 不该压掉"被跳过的要说出来"）：${texts.join(' | ')}`,
      );
      // 收尾：删夹具 + 清通知
      fs.rmSync(path.join(vaultRoot, KB, '00_Inbox/__小修七同名.md'), { force: true });
      fs.rmSync(path.join(vaultRoot, KB, '01_Projects/__小修七同名.md'), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      __resetNotices();
    });

    await suite.it('⑨ 迁移菜单不出现「移到当前所在目录」（死选项）；别的目录照旧给', async () => {
      closeAllMenus();
      __resetNotices();
      await openNotes();
      const dir = await H.enterTopDirWithNotes(ctx(), 2);
      ok(dir, `进到一个本层 ≥2 篇的目录（${dir}）`);
      const dirName = dir.split('/').pop() ?? dir;

      // 选中本层两篇（都在 dir → 「移到 dir」对整批都是死选项）
      H.click(rows()[0]);
      await H.settle(30);
      H.click(rows()[1], { ctrlKey: true });
      await H.settle(40);

      const migrate = H.qa<HTMLElement>(document.body, '.kbw-notes-bar .kbw-btn').find((b) =>
        H.textOf(b).includes('迁移'),
      );
      ok(migrate, '批量栏有「迁移」');
      H.click(migrate as Element);
      await H.settle(50);

      // 当前目录的节点若还在（它有子目录），展开它的子菜单 —— 「移到…」项住在子里
      const selfParent = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).startsWith(`${dirName}（`),
      );
      if (selfParent) {
        H.click(selfParent);
        await H.settle(50);
      }
      const texts = H.textsOf(document.body, '.kbw-menu-item');
      ok(
        !texts.some((t) => t.includes(`移到「${dirName}」`)),
        `不许再给出「移到「${dirName}」」（真机上点了走一趟什么都没发生的确认流）：${texts.join(' | ')}`,
      );
      /**
       * 反向：**别的目录**的「移到…」照旧在（防"整个菜单空了"也绿）。
       * ⚠️ 「移到「X」」住在**子菜单**里 —— 一级项只是 `01_Projects（14）›`，
       * 要**点开一个别的目录**才看得到（第一版直接数一级文本，当场假红）。
       */
      const other = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => {
        const t = H.textOf(i);
        return /（\d+）/.test(t) && !t.startsWith(`${dirName}（`);
      });
      ok(other, `菜单里该有别的目录节点：${texts.join(' | ')}`);
      H.click(other as Element);
      await H.settle(50);
      const texts2 = H.textsOf(document.body, '.kbw-menu-item');
      ok(
        texts2.some((t) => t.startsWith('移到「')),
        `别的目录的「移到…」照旧要给：${texts2.join(' | ')}`,
      );

      closeAllMenus();
      // 清选择（点批量栏的 ✕ —— 模拟 Esc 在桩里不一定接得住）
      const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
      const clear = bar
        ? H.qa<HTMLElement>(bar, 'button').find((b) =>
            (b.getAttribute('aria-label') ?? '').includes('清空选择'),
          )
        : null;
      if (clear) H.click(clear);
      await H.settle(60);
      ctx().goNotes();
      await H.settle(80);
    });
  });

  /**
   * ────────────────────────────────────────────────────────────
   * P7.0b · 14.8a：`goNotes` 收到**不存在的目录** —— 要报出来，不许静默给"本层 0 篇"
   *
   * 由头：真机探针当初把树节点的**标签**（「整个知识库」）当目录传进去 → 整屏 0 项、
   * 看着像功能坏了，查了一轮才排除。守卫落在 `main.ts` 的 `goNotes()` 里：
   * 不认识的目录 → `console.warn` + **只丢这一个字段**（意图的其余条件照旧 ——
   * 那是 P7.0a "不带 flags/paths 的意图不清 filters" 的同一枚硬币）。
   * 真机那半条在探针里（`P7.0b · 14.8a` 那一步故意踩一次，并断言报出来了）。
   * ────────────────────────────────────────────────────────────
   */
  await suite.group('P7.0b · 14.8a goNotes 的坏目录守卫', async () => {
    await suite.it('不存在的目录：报出来 · 只丢 dir（树选择不动、列表不被甩空、别的字段照旧）', async () => {
      await openNotes();
      const before = ctx().settings.get().treeSelected;

      /**
       * ① 先跳一个**真实目录**，把树选择摆到已知状态（不然"没变"验不出东西）。
       * ⚠️ `treeSelected` 落盘走的是**400ms 防抖**（`saveSoon`）—— 用 `until` 等条件，
       * 别写 `settle(90)`（第一版就栽在这儿：读到的还是空串）。
       */
      ctx().goNotes({ dir: '00_Inbox' });
      ok(
        await H.until(() => ctx().settings.get().treeSelected === '00_Inbox', 2000, 30),
        `前提：真目录跳得进去（treeSelected 实际「${ctx().settings.get().treeSelected}」）`,
      );
      const n1 = rows().length;
      ok(n1 > 0, `前提：Inbox 这一层得有行（实际 ${n1}）—— 没有的话下面"没被甩空"是空的`);

      // ② 把**树的标签**当目录传（真机上就是这么踩的）：守卫要报出来、且不应用
      const warns: string[] = [];
      const orig = console.warn;
      console.warn = (...a: unknown[]): void => {
        warns.push(a.map((x) => String(x)).join(' '));
      };
      try {
        ctx().goNotes({ dir: '整个知识库' });
        await H.settle(90);
      } finally {
        console.warn = orig;
      }
      eq(ctx().settings.get().treeSelected, '00_Inbox', '坏目录被丢掉：树选择还是刚才那个真目录');
      eq(rows().length, n1, '列表没被甩成 0 行（守丢的是 dir 那一个字段，不是整条意图）');
      ok(
        warns.some((w) => w.includes('goNotes') && w.includes('整个知识库')),
        `要 console.warn 报出来（探针收 [经纬] 的 warn —— 别让它落在没人看的地方）：${warns.join(' | ')}`,
      );

      /**
       * ③ 意图的**其余字段照旧**（把整条意图一起吞掉也会让上面那条绿 —— 所以补这一条）。
       * 用 `selectAll`：它是"意图里唯一的非 dir 字段"里**唯一当场看得见**的那个
       *（`search` 那条不行：工具条 Region 的 key **故意不含 search**，
       * 模块已挂着时改 search 不会重画搜索框 —— 那是既有口径，不是这一条的事）。
       */
      ctx().goNotes({ dir: '整个知识库', selectAll: true });
      await H.settle(90);
      eq(ctx().settings.get().treeSelected, '00_Inbox', '带别的字段也一样：dir 仍然被丢');
      eq(
        H.qa(document.body, '.kbw-trow.is-selected').length,
        n1,
        '其余字段照旧生效（selectAll 把这一层全选了 —— 整条意图被吞掉的话这里会是 0）',
      );

      // 收尾：清选择（点批量栏的 ✕ —— 模拟 Esc 在桩里不一定接得住）+ 树选择还回去
      //（两者都是**留得住的状态**，别留给后面的用例 —— P7.0a 那 24 条连锁红换来的纪律）
      const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
      const clear = bar
        ? H.qa<HTMLElement>(bar, 'button').find((b) =>
            (b.getAttribute('aria-label') ?? '').includes('清空选择'),
          )
        : null;
      if (clear) H.click(clear);
      await H.settle(60);
      eq(H.qa(document.body, '.kbw-trow.is-selected').length, 0, '收尾：选择清干净了');
      const items = treeItems();
      const node = items.find((i) => (i.dataset.dir ?? '') === before) ?? items[0];
      if (node) H.click(node as Element);
      await H.settle(80);
    });
  });
}
