/**
 * spec：网格档（P6 · 交互规格 §3.5）
 *
 * 判据分三层（开工提示词写的"判据三层"）：
 *  ① **纯函数** —— `insertionIndexAt` / `mergeReorder` / `seedOrder` / `applyManualOrder`
 *     / `pruneOrder` / `remapOrder` / `resolveNotesView`（不碰 DOM，跑得飞快）
 *  ② **真链路** —— 真 DOM：切档 / 框选 / 拖动换位 / 顺序落盘 / 改名迁键 / 拖到树搬文件
 *  ③ 真机探针 —— 不在这个文件里（`scripts/probe.mjs`）
 *
 * ── jsdom 几何的两条硬前提（不知道就会写出永远红的判据）────────
 *  · `getBoundingClientRect` 被统一桩成 **200×100、坐标全 0**（`scripts/test.mjs`）
 *    → 所有格子的中心线都在 x=100。于是 `insertionIndexAt` 只有两个结果：
 *    **x < 100 → 插到第 0 位**、**x ≥ 100 → 插到末尾**。判据就照这个写，别假装有排版。
 *  · jsdom **没有命中测试**：`elementFromPoint` 拿不到东西，`evt.target` 就是
 *    你 dispatch 的那个元素 → "落在哪个目标上"必须由**调用方选元素**来表达
 *    （拖到目录树那一步：move/up 要 dispatch 在**树节点**上，不是 document）。
 *
 * 全部在**动库库（B）**上跑：拖到目录树那一条会真的搬文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { __resetNotices } from '../../src/ui/notify';
import { deleteDirTree, openRenameDirPrompt } from '../../src/modules/notes/menus';
import {
  applyManualOrder,
  insertionIndexAt,
  mergeReorder,
  pruneOrder,
  remapOrder,
  reseatOrder,
  seedOrder,
} from '../../src/modules/notes/grid-order';
import { DEFAULT_SETTINGS, normalizeSettings, resolveNotesView } from '../../src/core/settings';
import { LONG_PRESS_MS } from '../../src/ui/dnd';

const KB = '01_新知识库';

export async function specGrid(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  /**
   * **笔记**格子。
   * ⚠️ B3 起网格里还有**文件夹格子**（`.kbw-gcell.is-folder`）—— 它是导航不是笔记，
   * 没有 `data-path`、不参与选择/框选/换位。判据一律把它排掉：不排的话
   * `cells()[0]` 会拿到一个文件夹（"单击只选一格"当场变 0、大小那一行读成"8 篇"）。
   * 需要文件夹格子时用 `.kbw-gcell.is-folder` 单独取（见 B3 那条用例）。
   */
  const cells = (): HTMLElement[] => H.qa(document.body, '.kbw-gcell:not(.is-folder)');
  const cellPaths = (): string[] => cells().map((c) => c.dataset.path ?? '');
  const settings = () => ctx().settings.get();

  /**
   * 选中集 / 选择模式都**从 DOM 读**，不从 store 读。
   * 理由：选中集是「全部笔记」模块**自己那个 store** 里的一份（界面偏好才在
   * `WorkbenchSettings` 上），外面拿不到；而且"界面上看着选中了没"本来就是
   * 用户看见的那一件事（真机探针也是这么量的）。
   */
  const selPaths = (): string[] =>
    H.qa<HTMLElement>(document.body, '.kbw-gcell.is-selected').map((c) => c.dataset.path ?? '');
  const selCount = (): number => selPaths().length;
  const inSelectMode = (): boolean =>
    H.qa(document.body, '.kbw-gcell.is-selectmode').length > 0;

  /**
   * 打开「全部笔记」并**站进一个本层有 ≥6 篇的目录**。
   * ⚠️ P6b ② 起列表只画本层（Windows 式）—— 库根那一层常常一篇都没有，
   * 不站进去的话"网格里有几格"当场是 0（那一片用例会集体假红）。
   */
  async function openNotes(): Promise<void> {
    ctx().goNotes();
    await H.settle(60);
    ok(await H.enterTopDirWithNotes(ctx(), 6), '进到一个本层 ≥6 篇的目录（网格才有格子）');
  }

  /**
   * 切视图档 —— 点界面上那三个按钮（别直接改 store，那验不到"切换要记进配置"）。
   * ⚠️ **先清选择**：有选择时工具条整条被批量栏顶掉（§3.4），三个档位按钮**根本不在**——
   * 一条用例失败后留下的选择会让后面每条都"找不到按钮"（级联假红）。
   */
  async function switchView(label: string): Promise<void> {
    const seg = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
      H.textOf(b).includes(label),
    );
    ok(seg, `视图档按钮「${label}」在`);
    H.click(seg as Element);
    await H.settle(70);
    // 档位是**防抖 400ms** 落盘的 → 断言要等它真的落下去（`persist` 的 `saveSoon`）
    // ⚠️ 要**检查返回值**（独立审查 🟢7）：不检查的话"没落盘"不会在这里报，
    // 而是让后面某条以别的形态失败 —— 报错点会指到不相干的地方去
    ok(
      await H.until(() => settings().notesView === labelToView(label), 1200, 30),
      `视图档「${label}」记进配置（等到落盘）`,
    );
  }

  /** 切档前**先清选择**（有选择时三个档位按钮整条被批量栏顶掉 —— 见 `clearSelection`）*/
  async function useView(label: string): Promise<void> {
    await clearSelection();
    await switchView(label);
  }

  // P7.1 两档化：只剩「网格 / 详细信息」两钮
  const labelToView = (label: string): string => (label === '网格' ? 'grid' : 'detail');

  /**
   * 有选择时工具条换成批量栏 → 点 ✕ 清掉（后续判据要用工具条）。
   * ⚠️ **✕ 是个 `iconBtn`**（`aria-label` = 「清空选择（Esc）」），**没有文字** ——
   * 按 `textOf(...).includes('✕')` 找**永远找不到**（那一版就是这么静默失效的）。
   * 按 `aria-label` 找才是稳的。
   */
  async function clearSelection(): Promise<void> {
    closeAllMenus();
    const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
    if (!bar) return;
    const clear = H.qa<HTMLElement>(bar, 'button').find((b) =>
      (b.getAttribute('aria-label') ?? '').includes('清空选择'),
    );
    if (clear) H.click(clear);
    await H.settle(50);
  }

  /**
   * 等一个设置项落盘（`persist` 走 400ms 防抖）。
   * 🔴 直接 `eq(settings().x, ...)` 是**必红**的写法：动作做完的那一刻内存里的 store 变了、
   * 但 `SettingsStore.save()` 还在防抖窗口里 —— 断言读的是**上一次**的值。
   */
  async function untilSetting<T>(get: () => T, want: T, msg: string): Promise<void> {
    const done = await H.until(() => get() === want, 1500, 30);
    ok(done, `${msg}（等到落盘；实际 ${String(get())}）`);
  }

  // ════════════════════════════════════════════════════════════
  // ① 纯函数层
  // ════════════════════════════════════════════════════════════
  await suite.group('网格 · 纯函数（落点 / 顺序表）', async () => {
    await suite.it('insertionIndexAt：行上 / 行内左右 / 末尾', async () => {
      // 两行三列：每格 100×80。中心线分别落在 x = 50 / 150 / 250
      const boxes = [
        { left: 0, top: 0, width: 100, height: 80 },
        { left: 100, top: 0, width: 100, height: 80 },
        { left: 200, top: 0, width: 100, height: 80 },
        { left: 0, top: 80, width: 100, height: 80 },
        { left: 100, top: 80, width: 100, height: 80 },
        { left: 200, top: 80, width: 100, height: 80 },
      ];
      eq(insertionIndexAt(boxes, 40, 40), 0, '第一格中心左边 → 插到最前');
      eq(insertionIndexAt(boxes, 140, 40), 1, '第二格中心左边 → 插到它前面');
      eq(insertionIndexAt(boxes, 240, 40), 2, '第三格中心右边（仍在本行）→ 插到它后面');
      // ⚠️ **正好落在中心线上算"右边"**（`x < center` 是严格小于）—— 写死这条免得将来有人
      // 顺手把 `<` 改成 `<=` 而没人发现
      eq(insertionIndexAt(boxes, 50, 40), 1, '正好压在中心线上 → 算后半格');
      eq(insertionIndexAt(boxes, 10, 120), 3, '落在第二行最左 → 插到第二行开头');
      eq(insertionIndexAt(boxes, 300, 300), 6, '全在下方 → 插到末尾');
      eq(insertionIndexAt([], 10, 10), 0, '空列表 → 0');
    });

    await suite.it('mergeReorder：插到最前 / 中间 / 末尾，且不动看不见的那些', async () => {
      const global = ['a', 'b', 'c', 'd', 'e'];
      eq(mergeReorder(global, ['c', 'a', 'b'], ['c']).join(','), 'c,a,b,d,e', '拖到最前');
      eq(mergeReorder(global, ['a', 'c', 'b'], ['c']).join(','), 'a,c,b,d,e', '拖到中间');
      eq(mergeReorder(global, ['b', 'c', 'a'], ['a']).join(','), 'b,c,a,d,e', '拖到末尾');
      // 🔴 被筛掉的那些（d e）相对位置一个都不许动 —— 这是"筛出来的子集"那条口径的核心
      eq(mergeReorder(global, ['c', 'a', 'b'], ['c']).slice(3).join(','), 'd,e', '筛掉的保持原样');
      eq(mergeReorder(global, ['c', 'a', 'b', 'd', 'e'], ['c']).join(','), 'c,a,b,d,e', '全都在屏幕上');
    });

    await suite.it('mergeReorder：全选之后整片拖走 → 位置按原位放回、内部顺序按用户摆的', async () => {
      const global = ['a', 'b', 'c', 'd'];
      // 屏幕上只有 a b，且两个都在被拖的集合里 → 没有任何"没被拖的邻居"可以当锚
      eq(
        mergeReorder(global, ['b', 'a'], ['a', 'b']).join(','),
        'b,a,c,d',
        '锚全缺 → **位置**回到原处（第 0 位起），但**内部顺序**按用户摆的（b 在前）',
      );
      // 反过来也稳：不因为"这次没锚"就把用户刚摆的次序抹平
      eq(mergeReorder(global, ['a', 'b'], ['a', 'b']).join(','), 'a,b,c,d', '没动就是没动');
    });

    await suite.it('seedOrder：第一次拖动时把看得见的补进表（否则表里只剩被拖的那几篇）', async () => {
      eq(seedOrder([], ['x', 'y', 'z']).join(','), 'x,y,z', '空表 → 按当前显示顺序补齐');
      eq(seedOrder(['y'], ['x', 'y', 'z']).join(','), 'y,x,z', '已有的不重复加，新的追加');
      // 🔴 这就是那个隐蔽 bug 的判据：没有 seed 的话表里只剩被拖的那一篇
      const merged = mergeReorder(seedOrder([], ['x', 'y', 'z']), ['z', 'x', 'y'], ['z']);
      eq(merged.length, 3, '补齐之后再并，表里是**全部**看得见的，而不是只剩一篇');
      eq(merged.join(','), 'z,x,y', '并且落到最前');
    });

    await suite.it('reseatOrder：把可见项按**屏幕顺序**重新落座（F1 那个缺陷的纯函数判据）', async () => {
      /**
       * 🔴 这条钉的是独立审查 F1：**自动排列开着**时屏幕按排序规则排、而表里是旧手排顺序 ——
       * 不先按屏幕顺序落座就并落点，会让"除被拖那一篇之外整片跳回旧手排顺序"。
       */
      eq(reseatOrder(['c', 'a', 'b'], ['a', 'b', 'c']).join(','), 'a,b,c', '可见项按 vis 重排');
      eq(reseatOrder(['c', 'a', 'b'], ['b', 'a', 'c']).join(','), 'b,a,c', '拖动后（vis 已是新序）也照办');
      // 被筛掉的那些**一格都不动**（它们不在 vis 里，槽位原样保留）
      eq(reseatOrder(['x', 'c', 'y', 'a'], ['a', 'c']).join(','), 'x,a,y,c', '筛掉的槽位不动');
      eq(reseatOrder([], ['a']).join(','), '', '空表 → 空');
      /**
       * **端到端复现 F1 那一幕**（这才是这条修法真正要保的性质）：
       * 表=[c,a,b]（旧手排）· 屏幕=[a,b,c]（按名字排）· 把 b 拖到最前 → 期望 [b,a,c]。
       */
      const table = ['c', 'a', 'b'];
      const visNew = ['b', 'a', 'c'];
      eq(mergeReorder(table, visNew, ['b']).join(','), 'c,b,a', '旧写法（不落座）会把其余整片拖回旧序');
      eq(mergeReorder(reseatOrder(table, visNew), visNew, ['b']).join(','), 'b,a,c', '先落座 → 只剩被拖那一篇动了');
    });

    await suite.it('applyManualOrder：表里有的按表排，没摆过的排后面', async () => {
      const rows = [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }];
      eq(applyManualOrder(rows, ['c', 'a']).map((r) => r.path).join(','), 'c,a,b,d', '已知项在前、未知项垫后');
      eq(applyManualOrder(rows, []).map((r) => r.path).join(','), 'a,b,c,d', '空表 = 原顺序');
      eq(applyManualOrder(rows, ['d', 'a', 'd']).map((r) => r.path).join(','), 'd,a,b,c', '重复键取第一次');
    });

    await suite.it('pruneOrder / remapOrder：死键剪掉、改名迁键', async () => {
      const alive = new Set(['a', 'b', 'c']);
      eq(pruneOrder(['a', 'x', 'b'], alive).join(','), 'a,b', '剪掉不在库里的');
      eq(pruneOrder(['a', 'b'], alive).join(','), 'a,b', '都活着 → 原样');
      eq(remapOrder(['a', 'b'], 'a', 'z').join(','), 'z,b', '改名 → 键跟着走');
      eq(remapOrder(['a', 'b'], 'nope', 'z').join(','), 'a,b', '表里没有 → 原样（别平白多写一次盘）');
      eq(remapOrder(['a'], 'a', 'a').join(','), 'a', '同名 → 不动');
    });

    await suite.it('resolveNotesView：没切过看设备，切过就以用户为准（§3.2 + B7）', async () => {
      // ⚠️ P6 第八段改过默认：**没切过的一律网格**（用户真机第 5 条"网格设为默认视图"）
      eq(resolveNotesView(null, false), 'grid', '桌面 + 没切过 → 网格');
      eq(resolveNotesView(null, true), 'grid', '触屏 + 没切过 → 网格（§3.2）');
      // P7.1 两档化：存着的只可能是 detail / grid（'compact' 由迁移改写，见 settings 组）
      eq(resolveNotesView('detail', true), 'detail', '切过 → 以用户为准（B7，触屏也不改）');
      eq(resolveNotesView('grid', false), 'grid', '桌面显式选网格也认');
    });

    await suite.it('settings 归一化：notesView 的 null 必须原样活下来（别用 detail 当哨兵）', async () => {
      eq(DEFAULT_SETTINGS.notesView, null, '默认是 null（"还没切过"），不是 detail');
      eq(normalizeSettings({ notesView: null }).notesView, null, 'null 过一遍归一化还是 null');
      eq(normalizeSettings({ notesView: 'grid' }).notesView, 'grid', 'grid 是合法值');
      eq(normalizeSettings({ notesView: 'nonsense' }).notesView, null, '非法值退回默认');
      eq(
        normalizeSettings({ notesView: 'compact' }).notesView,
        null,
        'P7.1：compact 视图档已删 —— 归一化不再收它（存量值由迁移在读盘时改写成 detail）',
      );
      // 数组 / 布尔必须显式处理：default 那一支只收字符串，其余会被**静默丢掉**
      eq(normalizeSettings({ gridOrder: ['a', 'b'] }).gridOrder.join(','), 'a,b', 'gridOrder 数组不被丢');
      eq(normalizeSettings({ gridAutoArrange: false }).gridAutoArrange, false, '布尔不被丢');
      eq(normalizeSettings({ gridSort: { key: 'size', dir: 'desc' } }).gridSort?.key, 'size', 'gridSort 收下');
      eq(normalizeSettings({ gridSort: { key: '领域', dir: 'desc' } }).gridSort, null, '网格只认三个键，别的退回 null');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 真链路
  // ════════════════════════════════════════════════════════════
  await suite.group('网格 · 真链路（渲染 / 选中 / 框选）', async () => {
    await suite.it('切到网格：画得出来、贴了 data-scroll、工具条上不再有「列」', async () => {
      __resetNotices();
      await openNotes();
      await useView('网格');
      eq(settings().notesView, 'grid', '档位记进配置（§3.2 切换后记进配置）');

      const grid = H.maybe<HTMLElement>(document.body, '.kbw-grid');
      ok(grid, '网格滚动容器画出来了');
      eq(grid?.getAttribute('data-scroll'), 'grid', '贴的是 grid 这个键（**不蹭 list**）');
      ok(H.maybe(document.body, '.kbw-grid-inner'), '网格体内层在（框选矩形的宿主）');
      ok(cells().length > 0, `格子画出来了（${cells().length} 个）`);

      const first = cells()[0];
      ok(first.querySelector('.kbw-gthumb svg'), '每格有纸页图标');
      ok(H.textOf(first.querySelector('.kbw-gname')).length > 0, '每格有名称');
      // 大小那一行读的是**索引里的 size**（不逐篇 statSync）；值本身随夹具大小变，别写死单位
      ok(
        /^\d+(\.\d+)?\s*(B|KB|MB)$/.test(H.textOf(first.querySelector('.kbw-gsize')).trim()),
        `每格有大小（实际「${H.textOf(first.querySelector('.kbw-gsize'))}」）`,
      );

      const tools = H.textOf(H.maybe(document.body, '.kbw-notes-tools'));
      ok(!tools.includes('列'), '网格档**不画**「列」按钮（不适用就别留个改不动的入口）');
      contains(H.textOf(H.maybe(document.body, '.kbw-sortbar')), '排序', '排序条在');
      contains(H.textOf(H.maybe(document.body, '.kbw-sortbar')), '自动排列', '自动排列勾选框在');
      contains(H.textOf(H.maybe(document.body, '.kbw-gstatus')), '共', '底部状态行在');
    });

    await suite.it('选中口径与表格同一份：单击 / Ctrl 加选 / Shift 范围选', async () => {
      const all = cells();
      ok(all.length >= 3, `至少 3 格才好验范围选（实际 ${all.length}）`);
      H.click(all[0]);
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-gcell.is-selected').length, 1, '单击只选一格');

      H.click(all[1], { ctrlKey: true });
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-gcell.is-selected').length, 2, 'Ctrl 加选');

      H.click(all[2], { shiftKey: true });
      await H.settle(20);
      /**
       * Shift 是**替换**成那一段（与表格同一条：`rangeSelected(merge=false)`）。
       * 🔴 **比路径不比数量**（独立审查 🟡12）：Shift 之前恰好也是 2 个，而范围也是 2 个
       * → "Shift 什么都不做"同样是 2，比数量分不出来。
       */
      eq(
        selPaths().sort().join(','),
        [all[1].dataset.path ?? '', all[2].dataset.path ?? ''].sort().join(','),
        'Shift 取的是"锚点→目标"那一段',
      );
      // Ctrl+Shift 点到**更远**那一格 → 与现有选择取并集（点到同一格只会得到同一段）
      H.click(all[3], { shiftKey: true, ctrlKey: true });
      await H.settle(20);
      eq(H.qa(document.body, '.kbw-gcell.is-selected').length, 3, 'Ctrl+Shift = 与现有选择取并集');

      ok(H.maybe(document.body, '.kbw-notes-bar.is-batch'), '有选择 → 工具条换成批量栏（§3.4 两屏共用）');
      await clearSelection();
      eq(H.qa(document.body, '.kbw-gcell.is-selected').length, 0, '清掉了选择');
    });

    await suite.it('框选：空白处拖出矩形 → 拖动中预览、**松手才提交**（工具条拖动中不换）', async () => {
      const inner = H.maybe<HTMLElement>(document.body, '.kbw-grid-inner');
      ok(inner, '网格体在');
      ok(cells().length >= 2, '够几格才好转');

      // 起点在**空白**上（jsdom 没有命中测试 → 直接 dispatch 在 inner 上，target 就不是格子）
      H.pointerDown(inner as Element, { x: 5, y: 5, pointerType: 'mouse' });
      await H.tick(10);
      H.pointerMove(document.body, { x: 150, y: 80, pointerType: 'mouse' });
      await H.tick(10);
      const box = H.maybe<HTMLElement>(document.body, '.kbw-marquee');
      ok(box, '拖动中选框在（挂 body、固定定位 —— 与看板同一份实现）');
      ok(
        !H.maybe(document.body, '.kbw-notes-bar.is-batch'),
        '拖动中工具条**还没**换成批量栏（视觉稿：松手后操作栏才出现）',
      );
      const during = H.qa(document.body, '.kbw-gcell.is-selected').length;
      ok(during >= 2, `拖动中就在预览选中（${during} 格）`);

      H.pointerUp(document.body, { x: 150, y: 80, pointerType: 'mouse' });
      await H.settle(80);
      eq(H.maybe(document.body, '.kbw-marquee'), null, '松手后选框收掉了');
      ok(H.maybe(document.body, '.kbw-notes-bar.is-batch'), '松手后操作栏才出现');
      ok(H.qa(document.body, '.kbw-gcell.is-selected').length >= 2, '选择提交了');
      // 等过 `wasDraggingRecently` 的 150ms 窗口 —— 不然下一发 click 会被当成"拖完补的那一发"吞掉
      await H.settle(240);
      await clearSelection();
    });

    await suite.it('框选中止：pointercancel 要干净收场（不留选框、不改选择）', async () => {
      const inner = H.maybe<HTMLElement>(document.body, '.kbw-grid-inner');
      H.pointerDown(inner as Element, { x: 5, y: 5, pointerType: 'mouse' });
      await H.tick(10);
      H.pointerMove(document.body, { x: 150, y: 80, pointerType: 'mouse' });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-marquee'), '先确认选框起来了');
      H.pointerCancel(document.body, { x: 150, y: 80, pointerType: 'mouse' });
      await H.settle(60);
      eq(H.maybe(document.body, '.kbw-marquee'), null, 'pointercancel → 选框收掉（干净中止）');
      eq(selCount(), 0, '取消不改选择');
      await H.settle(240);
    });

    await suite.it('选中态与批量栏 / goNotes 意图共用同一份 store', async () => {
      // ① 网格里选一格 → **共用那份批量栏**认得它（§3.4 两档同一份实现）
      H.click(cells()[0]);
      await H.settle(40);
      const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
      ok(bar, '有选择 → 工具条换成批量栏（两档共用同一份）');
      contains(H.textOf(bar), '1', '批量栏报的就是网格里那一格');
      await clearSelection();
      eq(selCount(), 0, '清掉了');

      /**
       * ② `goNotes({selectPaths})` 意图预选 → 网格里照样亮着。
       * 这条正是"**各写一份必漂**"那条纪律的判据：意图走的是 `applyIntent`
       * 写同一个 store，网格只是它的一个渲染者。
       */
      const two = cellPaths().slice(0, 2);
      ok(two.length === 2, '至少两格');
      ctx().goNotes({ selectPaths: two });
      await H.settle(90);
      eq(selPaths().sort().join(','), [...two].sort().join(','), '意图预选两篇 → 网格里亮两格');

      /**
       * ③ **重绘不该把选择清掉**（P2 那条"每勾一下都丢滚动/选择"的同类）。
       * 切排序 = 视图参数变了 → 整块重画 → 选择按**路径**重贴，不是按下标。
       */
      const keep = settings().gridAutoArrange;
      H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
      await H.settle(90);
      eq(selPaths().sort().join(','), [...two].sort().join(','), '重绘之后两格照样是选中的');
      if (settings().gridAutoArrange !== keep) {
        H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
        await H.settle(90);
      }
      await clearSelection();
      eq(selCount(), 0, '收尾清干净');
    });

    /**
     * **B2 的边界**：网格的排序条 / 状态行**住在 `listHost` 里面**（`grid.el` 挂在它上面），
     * 而 B2 的"点空白清空选择"就挂在 `listHost` 上 —— 只挡 `.kbw-gcell` 的话，
     * 勾一下「自动排列」= 把刚选好的几篇全清掉。这条钉的就是那个边界。
     */
    await suite.it('B2 点排序条不算"点空白"：选择不许被那一下清掉', async () => {
      await clearSelection();
      const two = cellPaths().slice(0, 2);
      ok(two.length === 2, '至少两格');
      ctx().goNotes({ selectPaths: two });
      await H.settle(90);
      eq(selPaths().sort().join(','), [...two].sort().join(','), '前提：两格已选中');

      const keep = settings().gridAutoArrange;
      H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
      await H.settle(120);
      eq(selPaths().sort().join(','), [...two].sort().join(','), '勾「自动排列」不该顺手清空选择');
      if (settings().gridAutoArrange !== keep) {
        H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
        await H.settle(120);
      }
      // 状态行同样不是空白
      H.click(H.q<HTMLElement>(document.body, '.kbw-gstatus'));
      await H.settle(80);
      eq(selPaths().sort().join(','), [...two].sort().join(','), '点状态行也不该清空选择');
      await clearSelection();
    });

    await suite.it('触屏长按 400ms 不动 → 进选择模式（图标冒复选框），不重排', async () => {
      const before = cellPaths();
      const cell = cells()[0];
      H.pointerDown(cell, { x: 40, y: 40, pointerType: 'touch' });
      /**
       * ⚠️ 采样点要**围着常量取**，别写死 120/500（独立审查 🟡13）：写死的话阈值落在
       * (120, 480) 区间内任何值都会绿 —— 突变实测把它改成 300 照样全绿，
       * 而 S4 定的 400 是有理由的（要跑在系统长按菜单 ~500ms 前面）。
       */
      await H.tick(LONG_PRESS_MS - 60);
      eq(inSelectMode(), false, `还没到 ${LONG_PRESS_MS}ms：没进选择模式`);
      await H.tick(120); // 越过阈值
      eq(inSelectMode(), true, '长按成立 → 进选择模式');
      ok(cells()[0].classList.contains('is-selectmode'), '格子冒出复选框（class 挂上了）');
      ok(cells()[0].classList.contains('is-selected'), '长按那一格被选上了');

      H.pointerUp(cell, { x: 40, y: 40, pointerType: 'touch', buttons: 0 });
      await H.settle(60);
      eq(cellPaths().join(','), before.join(','), '长按不动就松手 → **不重排**');
      ok(inSelectMode(), '仍停选择模式（松手之后才逐个点）');
      // 等过 `wasDraggingRecently` 的 150ms 窗口（长按也是一次"拖动真的开始过"）
      await H.settle(240);

      // 选择模式下点一下 = 加选（不是"只选它"）
      H.click(cells()[1]);
      await H.settle(30);
      eq(selCount(), 2, '选择模式下点格子 = 加选');

      // Esc：选择模式 + 选择一起退（压/弹那一层是唯一出路 —— Esc 不走 keymap.bind）
      H.keydown(H.q(document.body, '.kbw-notes'), 'Escape');
      await H.settle(40);
      eq(inSelectMode(), false, 'Esc 退出选择模式');
      eq(selCount(), 0, 'Esc 同时清空选择');
      ok(!cells()[0].classList.contains('is-selectmode'), '复选框跟着收掉了');
    });

    await suite.it('触屏长按 400ms 后移动 → 改判成拖动（拖动模式，不是选择模式）', async () => {
      const before = cellPaths();
      const cell = cells()[0];
      H.pointerDown(cell, { x: 40, y: 40, pointerType: 'touch' });
      await H.tick(LONG_PRESS_MS + 80);
      eq(inSelectMode(), true, '先按长按成立进选择模式');
      // 超过 10px 容差 → 改判拖动
      H.pointerMove(document.body, { x: 150, y: 60, pointerType: 'touch' });
      await H.tick(20);
      eq(inSelectMode(), false, '真的动了 → 退出选择模式（§3.5 的第二行）');
      ok(H.maybe(document.body, '.kbw-gfloat'), '有"跟着光标走"的浮标（单篇拖的是图标本身）');
      H.pointerUp(document.body, { x: 150, y: 60, pointerType: 'touch', buttons: 0 });
      await H.settle(90);
      const after = cellPaths();
      eq(after.length, before.length, '格子数没变');
      ok(after[0] !== before[0], `第一格确实挪走了（落到末尾）`);
      await untilSetting(() => settings().gridAutoArrange, false, '拖完自动取消「自动排列」');
    });
  });

  await suite.group('网格 · 拖动换位与自由摆放', async () => {
    await suite.it('鼠标拖动换位：顺序真变了 + 状态行说明现在是自由摆放', async () => {
      await useView('网格');
      const before = cellPaths();
      ok(before.length >= 3, '够几格才好转');

      const from = cells()[0];
      H.pointerDown(from, { x: 20, y: 20, pointerType: 'mouse' });
      await H.tick(10);
      // 只挪 2px（< 4px 阈值）不该进拖动 —— 不然阈值改成 0 也没人知道
      H.pointerMove(document.body, { x: 22, y: 20, pointerType: 'mouse' });
      await H.tick(10);
      eq(H.maybe(document.body, '.kbw-gfloat'), null, '只挪 2px 不该进拖动（鼠标阈值 4px）');
      H.pointerMove(document.body, { x: 40, y: 20, pointerType: 'mouse' });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-gfloat'), '越过 4px 阈值 → 进入拖动（有浮标）');
      // jsdom 里所有格子同坐标 → x ≥ 100 = 插到末尾
      H.pointerMove(document.body, { x: 150, y: 60, pointerType: 'mouse' });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-gap'), '有"空出来的位置"（虚线空位）');
      H.pointerUp(document.body, { x: 150, y: 60, pointerType: 'mouse', buttons: 0 });
      await H.tick(30);

      /**
       * **拖完那一发 click 要被吃掉**（`wasDraggingRecently`）：拖完松手，浏览器会补一发
       * click 落在原处/新处的格子上 —— 不吃掉的话会"拖完莫名其妙把别的格子选中了"
       *（看板那边更刺眼：会弹出悬浮小窗）。
       *
       * ⚠️ **必须紧挨着松手判**（独立审查 🔴4 + 我自己的实测）：窗口只有 **150ms**
       *（`ui/dnd.ts` 的 `wasDraggingRecently`），而后面那两次 `untilSetting` 会等防抖落盘
       *（最多 1.5s）—— 放到它们后面就等于在一个**早已过期**的窗口上断言，
       * 那样它会变成"永远成立"的恒真（实测：那一刻 `swallowed=false` 也可能通过）。
       * ⚠️ 而且**比"身份"不比"数量"**：拖完选中的是**被拖走的那一篇**，重排之后
       * `cells()[0]` 已经是别的格子 —— 吞没吞掉结果都是 1 个，比数量恒真。
       */
      const beforeSel = selPaths().join(',');
      const targetPath = cells()[0].dataset.path;
      ok(targetPath !== before[0], '拖完之后第一格换人了（否则下面这条比不出东西）');
      H.click(cells()[0]);
      await H.tick(30);
      eq(selPaths().join(','), beforeSel, '拖动后补的那一发 click 被吞掉（**选中的还是原来那批**）');

      await H.settle(200); // 让窗口过期，别漏给后面
      const after = cellPaths();
      eq(after.length, before.length, '格子数没变');
      eq(after[after.length - 1], before[0], `第一格落到了末尾（${before[0]}）`);
      await untilSetting(() => settings().gridAutoArrange, false, '拖完自动取消「自动排列」（否则排序规则会把它顶回去）');
      /**
       * ⚠️ 判据要落在**末位那一项**上，不能只看 `gridOrder.length`：
       * 上一条用例留下的表**长度一样**（同一个视图集）→ 长度相等这一条会**立刻**满足，
       * 读到的还是**上一张表**（防抖窗口里的旧值）。这正是"判据挑错观测量"的典型。
       */
      await untilSetting(
        () => settings().gridOrder[settings().gridOrder.length - 1],
        before[0],
        '顺序表落盘了、覆盖**全部**看得见的，且它在末尾',
      );
      contains(H.textOf(H.maybe(document.body, '.kbw-gstatus')), '自由摆放', '状态行写明现在是自由摆放');
      eq(H.maybe(document.body, '.kbw-gfloat'), null, '松手后浮标收掉');
      eq(H.maybe(document.body, '.kbw-gap'), null, '松手后空位收掉');

    });

    await suite.it('自动排列关着时：显示顺序 = 表里的顺序，切走回来还在（§12 决策 7）', async () => {
      const order = [...settings().gridOrder];
      ok(order.length >= 3, '先有表');
      await useView('详细信息');
      await useView('网格');
      eq(cellPaths().join(','), order.join(','), '切回来顺序按表走（没被排序规则顶回去）');

      /**
       * 自由摆放模式下排序下拉**置灰**（独立审查 F2）：
       * 那时显示顺序由顺序表说了算、`gridSort` 被完全忽略 —— 留着能点就是"点了没反应"。
       * 与「网格档不画『列』按钮」同一条纪律。
       */
      const sortBtn = H.q<HTMLButtonElement>(document.body, '.kbw-sortbar .kbw-btn');
      ok(sortBtn.hasAttribute('disabled'), '自由摆放时排序下拉置灰（改不动就别留个入口）');
      contains(sortBtn.getAttribute('title') ?? '', '自动排列', 'title 里写清了为什么');
      eq(cellPaths().join(','), order.join(','), '显示顺序仍然 = 表里的顺序');
    });

    await suite.it('排序下拉：自动排列开着时**真的按它排**（并记进配置）', async () => {
      await useView('网格');
      // ① 先确保自动排列开着（否则下拉是灰的 —— 那正是上一条验的）
      if (!settings().gridAutoArrange) {
        H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
        await H.settle(90);
        await untilSetting(() => settings().gridAutoArrange, true, '自动排列勾上了');
      }
      // ② 选出「大小」
      const sortBtn = H.q<HTMLButtonElement>(document.body, '.kbw-sortbar .kbw-btn');
      ok(!sortBtn.hasAttribute('disabled'), '自动排列开着 → 下拉可用');
      H.click(sortBtn);
      await H.settle(60);
      const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((m) =>
        H.textOf(m).includes('大小'),
      );
      ok(item, '排序菜单里有「大小」');
      H.click(item as Element);
      await H.settle(90);
      closeAllMenus();
      await H.settle(30);

      /**
       * 🔴 这条是独立审查 🔴5 的补丁：原来**没有任何判据**碰过排序下拉 ——
       * 突变实测（`onGridSort` 换成空实现）整套 24 条**全绿**，
       * 因为唯一碰它的用例断言的是"自由摆放时**不改**顺序"，而"下拉被完全忽略"恰好也满足。
       * 现在两件事都判：**配置真的写了** + **屏幕真的按它排了**。
       */
      await untilSetting(() => settings().gridSort?.key, 'size', '排序选择记进配置');
      const byPath = new Map(ctx().index.notes().map((n) => [n.path, n.size]));
      const sizes = cellPaths().map((p) => byPath.get(p) ?? -1);
      ok(sizes.length >= 3, '够几格才看得出排序');
      ok(
        sizes.every((s, i) => i === 0 || sizes[i - 1] <= s),
        `按大小升序排（前几个：${sizes.slice(0, 5).join(' / ')}）`,
      );
      // 收尾：拨回名称升序（免得影响后面的用例）
      H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-btn'));
      await H.settle(60);
      const nameItem = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((m) =>
        H.textOf(m).includes('名称'),
      );
      if (nameItem) H.click(nameItem);
      await H.settle(90);
      closeAllMenus();
      await H.settle(30);
    });

    await suite.it('🔴 拖动换位：自动排列开着时也不许把别的格子挪走（回归）', async () => {
      /**
       * 这条钉的是独立审查 F1 那个真缺陷：屏幕是按排序规则排的、而表里是**上一次自由摆放**
       * 的旧顺序 —— 直接在旧表上并落点，会让"除被拖那一篇之外**整片跳回旧手排顺序**"。
       * 现在的做法是先把可见项按**屏幕顺序**重新落座（`reseatOrder`）再并。
       */
      await useView('网格');
      if (!settings().gridAutoArrange) {
        H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
        await H.settle(90);
      }
      await untilSetting(() => settings().gridAutoArrange, true, '自动排列开着（屏幕按排序规则排）');
      const onScreen = cellPaths();
      ok(onScreen.length >= 4, '至少 4 格');
      // 造出"表与屏幕不同序"：手动塞一张与屏幕**相反**的旧表
      await ctx().settings.save({ gridOrder: [...onScreen].reverse(), gridAutoArrange: true });
      await useView('详细信息');
      await useView('网格');
      eq(cellPaths().join(','), onScreen.join(','), '先确认屏幕没被那张反着的表影响（自动排列开着）');

      const before = cellPaths();
      const from = cells()[0];
      H.pointerDown(from, { x: 20, y: 20, pointerType: 'mouse' });
      await H.tick(10);
      H.pointerMove(document.body, { x: 40, y: 20, pointerType: 'mouse' });
      await H.tick(10);
      H.pointerMove(document.body, { x: 150, y: 60, pointerType: 'mouse' }); // jsdom 里 x>=100 → 落末尾
      await H.tick(10);
      H.pointerUp(document.body, { x: 150, y: 60, pointerType: 'mouse', buttons: 0 });
      await H.settle(240);

      const after = cellPaths();
      eq(after[after.length - 1], before[0], '被拖的那一篇落到末尾');
      /** 🔴 关键：**其余那些的相对次序一个都不许变**（旧实现在这里会整片跳回旧手排顺序） */
      eq(after.slice(0, -1).join(','), before.slice(1).join(','), '除被拖项外，其余顺序原样不动');
    });

    await suite.it('重新勾上「自动排列」→ 回到排序规则，顺序表原样留着', async () => {
      const order = [...settings().gridOrder];
      H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
      await H.settle(70);
      await untilSetting(() => settings().gridAutoArrange, true, '勾上了（落盘）');
      eq(settings().gridOrder.join(','), order.join(','), '顺序表原样留着（决策 7：关掉再打开顺序保留）');
      ok(!H.textOf(H.maybe(document.body, '.kbw-gstatus')).includes('自由摆放'), '状态行不再说自由摆放');
    });

    await suite.it('改名之后顺序表的键跟着迁（否则那篇从手动顺序里失联）', async () => {
      await useView('网格');
      // 先确保表里有内容、并且自动排列是关的（"表说了算"的状态）
      if (settings().gridAutoArrange) {
        H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
        await H.settle(70);
      }
      const target = cellPaths()[0];
      ok(target, '有目标');
      ok(settings().gridOrder.includes(target), '先确认它在顺序表里');

      /**
       * 🔴 **改名走表格档的 F2**，而且**故意让网格不在场** ——
       * 这正是 P5 那条教训的现场：迁移挂在**插件层**（`main.ts` 的
       * `vault.on('rename')`），而不是网格模块里。挂在模块里的话，
       * "改名那一刻网格没渲染"就会漏迁 → 那篇从手动顺序里失联。
       */
      await useView('详细信息');
      const name = target.split('/').pop()?.replace(/\.md$/, '') ?? '';
      const row = H.qa<HTMLElement>(document.body, '.kbw-trow').find((r) => r.dataset.path === target);
      ok(row, '表格里有这一行');
      H.click(row as Element);
      await H.settle(30);
      H.keydown(H.q(document.body, '.kbw-root'), 'F2');
      await H.settle(40);
      const input = H.q<HTMLInputElement>(document.body, '.kbw-inline-input');
      input.value = `${name}-改`;
      H.keydown(input, 'Enter');
      await H.settleIndex(app, 260);

      const newPath = `${target.slice(0, target.length - name.length - 3)}${name}-改.md`;
      const renamed = await H.until(() => H.exists(vaultRoot, newPath), 2000, 50);
      ok(
        renamed,
        `文件真的改名了：${newPath}（00_Inbox：${H.listFiles(vaultRoot, `${KB}/00_Inbox`).join('、')}` +
          `｜提示：${H.textsOf(document.body, '.kbw-notice').join(' / ')}` +
          `｜撤销条：${H.textsOf(document.body, '.kbw-undobar-text').join(' / ')}` +
          `｜输入框值：${input.value}）`,
      );
      const order = settings().gridOrder;
      ok(order.includes(newPath), '顺序表里是新路径');
      ok(!order.includes(target), '旧路径不在表里了（迁干净了）');
      // 位置也要保住：它原来排在第几，改完还排第几
      await useView('网格');
      eq(cellPaths()[0], newPath, '改名之后位置没变（还是第一格）');

      /**
       * 🔴 **收尾：把这次改名还回去**。
       * 这条用例跑在**动库库 B** 上，而后面还排着 specPanels / specBoard / specRebuild
       * 一大串 —— 留一篇叫 `XXX-改` 的笔记在库里，会让那些按名字取夹具的用例**整片假红**
       *（实测：不回退的话后面 20 条一起挂，而且失败点看着跟网格毫无关系）。
       * 本项目的规矩就是"动过的库要拨回基线"。
       */
      const bars = H.qa<HTMLElement>(document.body, '.kbw-undobar');
      const undo = H.qa<HTMLElement>(bars[bars.length - 1], '.kbw-btn').find((b) =>
        H.textOf(b).includes('撤销'),
      );
      if (undo) H.click(undo);
      await H.settleIndex(app, 400);
      ok(await H.until(() => H.exists(vaultRoot, target), 2000, 50), '改名的收尾：撤销回原名');
    });

    await suite.it('拖到左侧目录节点 = 搬文件（走 mover，与表格同一条链）', async () => {
      // ⚠️ 上一条可能停在别的档 → 先切回网格（一条失败会留下状态）
      await useView('网格');
      const target = cellPaths().find((p) => p.startsWith(`${KB}/00_Inbox`));
      ok(target, `挑一篇在 00_Inbox 里的（实际 ${cellPaths().length} 格）`);
      const name = target.split('/').pop() ?? '';

      /**
       * 折叠的子树不渲染 → 先展开 02_Areas 才有子节点可当落点。
       * ⚠️ **只在没展开时才点**：`specNotes` 跑在前面、它已经展开过一次 ——
       * 无脑点一下等于**收起**，然后"找不到内容创作节点"（全量跑时才现形的假红）。
       */
      const areas = H.qa<HTMLElement>(document.body, '.kbw-tree-item').find(
        (i) => i.dataset.dir === '02_Areas',
      );
      ok(areas, '有 02_Areas 节点');
      const caret = H.q<HTMLElement>(areas as Element, '.kbw-tree-caret');
      if (!caret.classList.contains('is-open')) {
        H.click(caret);
        await H.settle(60);
      }
      const liveNode = (): HTMLElement | null =>
        H.qa<HTMLElement>(document.body, '.kbw-tree-item[data-drop]').find((n) =>
          (n.dataset.drop ?? '').endsWith('内容创作'),
        ) ?? null;
      ok(liveNode(), '展开后有「内容创作」节点');

      const cell = cells().find((c) => c.dataset.path === target) as HTMLElement;
      ok(cell, '那一格还在屏幕上');
      H.pointerDown(cell, { x: 20, y: 20, pointerType: 'mouse' });
      await H.tick(10);
      H.pointerMove(document.body, { x: 40, y: 20, pointerType: 'mouse' });
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-gfloat'), '进入拖动');
      /**
       * ⚠️ move/up 要 dispatch 在**树节点**上：jsdom 没有命中测试，
       * `dropTargetAt` 靠 `evt.target.closest('[data-drop]')` —— 打在 document 上就认不出目标。
       */
      H.pointerMove(liveNode() as Element, { x: 30, y: 30, pointerType: 'mouse' });
      await H.tick(20);
      ok(H.maybe(document.body, '.kbw-tree-item.is-drop'), '掠过目录节点 → 目标高亮（§3.1）');
      H.pointerUp(liveNode() as Element, { x: 30, y: 30, pointerType: 'mouse', buttons: 0 });
      await H.settleIndex(app, 260);

      ok(H.exists(vaultRoot, `${KB}/02_Areas/内容创作/${name}`), `文件被搬到内容创作：${name}`);
      ok(!H.exists(vaultRoot, target), '原位没了');
      ok(H.maybe(document.body, '.kbw-undobar'), '拖拽是即时生效 + 撤销条（唯一不走确认流的动库动作）');
      /**
       * 撤销回去，别把库留在半路。
       * ⚠️ **取最后一条撤销条**：同一会话里可能叠着好几条（改名 / 上一条拖拽 / 这一条），
       * 从头找会拿到**最早那条**的按钮 → 点下去撤的是别的操作，而"文件没回来"
       * 看起来像还原坏了。真机上多个浮层叠加也是同一条口径：**取最后一个**。
       */
      const bars = H.qa<HTMLElement>(document.body, '.kbw-undobar');
      const undoBtn = H.qa<HTMLElement>(bars[bars.length - 1], '.kbw-btn').find((b) =>
        H.textOf(b).includes('撤销'),
      );
      ok(undoBtn, '撤销条上有撤销按钮');
      H.click(undoBtn as Element);
      // 还原要读快照 + 写盘 + 等索引重解析 → 走 `settleIndex`（与表格那条拖拽用例同一口径）
      await H.settleIndex(app, 400);
      const back = await H.until(() => H.exists(vaultRoot, target), 2000, 50);
      ok(
        back,
        `撤销把文件放回原位了（目标目录现在有：${H.listFiles(vaultRoot, `${KB}/02_Areas/内容创作`).join('、')}）`,
      );
    });

    await suite.it('空态：搜到没有 → 网格里画空态，不是一片白', async () => {
      await useView('网格');
      const search = H.q<HTMLInputElement>(document.body, '.kbw-search');
      search.value = 'zzz-绝对搜不到-zzz';
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      await H.settle(90);
      eq(cells().length, 0, '一格都没有');
      ok(H.maybe(document.body, '.kbw-grid .kbw-empty'), '网格里画了空态');
      search.value = '';
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      await H.settle(90);
    });

    /**
     * **B3（用户 2026-09-27）**：网格里要有文件夹图标，点「整个知识库」时按文件夹分好类显示。
     *
     * 口径（用户拍板：**混排、文件夹在前**）：
     *   · 文件夹格子是**导航不是笔记** → 没有 `data-path`（选择/框选/换位都按它认笔记）；
     *   · 但它**可以是落点** → 有 `data-drop`（与目录树节点同一个口径，走同一条 mover 链）；
     *   · **搜索/筛选生效时一个都不画**（那时文件夹是噪音，且"文件夹不匹配搜索词"）。
     */
    await suite.it('B3 文件夹格子：混排在最前 · 点它进那个目录 · 搜索时不画', async () => {
      await openNotes();
      await useView('网格');

      /** 进一个**真有子目录**的目录：从目录树里挑一个"不是叶子"的节点 */
      const parentNode = H.qa<HTMLElement>(document.body, '.kbw-tree-item').find((i) => {
        const caret = i.querySelector('.kbw-tree-caret');
        return caret != null && !caret.classList.contains('is-leaf') && (i.dataset.dir ?? '') !== '';
      });
      ok(parentNode, '目录树里有一个带子目录的节点');
      const parentDir = parentNode?.dataset.dir ?? '';
      const caret = H.q<HTMLElement>(parentNode as Element, '.kbw-tree-caret');
      if (!caret.classList.contains('is-open')) {
        H.click(caret);
        await H.settle(80);
      }
      H.click(H.q<HTMLElement>(parentNode as Element, '.kbw-tree-name') ?? (parentNode as Element));
      await H.settle(120);
      // ⚠️ `treeSelected` 是**防抖 400ms** 落盘的 → 直接 eq 会读到上一次的值（第一版就这么红的）
      ok(
        await H.until(() => ctx().settings.get().treeSelected === parentDir, 1500, 30),
        `进到那个目录（等到落盘；实际 ${ctx().settings.get().treeSelected}）`,
      );

      const folderCells = (): HTMLElement[] =>
        H.qa<HTMLElement>(document.body, '.kbw-gcell.is-folder');
      const dirs = (): string[] => folderCells().map((c) => c.dataset.dir ?? '');
      ok(folderCells().length > 0, `网格里有文件夹格子（${parentDir}：${dirs().join(' / ')}）`);

      // ① 每个文件夹格子都是**当前目录的直接子目录**（不是别处的目录、也不是笔记）
      for (const d of dirs()) {
        ok(d.startsWith(`${parentDir}/`), `${d} 是 ${parentDir} 下面的`);
        ok(d.slice(parentDir.length + 1).indexOf('/') < 0, `${d} 是**直接**子目录（不是孙目录）`);
      }
      // ② 顺序：文件夹**全部排在笔记前面**（混排在前的口径）
      const all = H.qa<HTMLElement>(document.body, '.kbw-gcell');
      let seenNote = false;
      let orderOk = true;
      for (const c of all) {
        const isFolder = c.classList.contains('is-folder');
        if (!isFolder) seenNote = true;
        else if (seenNote) orderOk = false;
      }
      ok(orderOk, '文件夹格子全在笔记格子之前');
      /**
       * ③ 「N 篇」那个数字要**真的数对**（B 路 🟡2.7）：格子上写的是"这个目录下（含子目录）
       * 有多少篇"，用户会读它 —— 拿索引里的真数比（**从数据里取**，别写死），并卡 `> 0`
       * （防"恒 0 也绿"）。
       */
      const entries = ctx().index.notes();
      for (const c of folderCells().slice(0, 3)) {
        const dir = c.dataset.dir ?? '';
        const real = entries.filter(
          (e) => e.effectivePosition === dir || e.effectivePosition.startsWith(`${dir}/`),
        ).length;
        const shown = Number((H.textOf(c.querySelector('.kbw-gsize')) ?? '').replace(/[^0-9]/g, ''));
        ok(real > 0, `${dir} 下真的有笔记（${real}）`);
        eq(shown, real, `${dir} 的「N 篇」与索引里的数一致`);
      }

      // ④ 身份：没有 data-path（不参与选择/框选/换位），有 data-drop（能当落点）
      ok(
        folderCells().every((c) => c.dataset.path === undefined),
        '文件夹格子没有 data-path（它不是笔记）',
      );
      ok(
        folderCells().every((c) => c.dataset.drop === c.dataset.dir),
        '文件夹格子有 data-drop（拖笔记到它上面 = 搬到那个目录）',
      );

      /**
       * ④ **Windows 式**（P6b ②，用户 2026-09-27 原话"左键双击打开…参考 windows"）：
       * 桌面**单击 = 选中**（不进目录）、**双击 = 进入**。
       */
      const target = dirs()[0];
      /** 真机的双击序列是 click → click → dblclick */
      const dblClick = (el: Element): void => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      };
      H.click(folderCells()[0]);
      await H.settle(120);
      ok(folderCells()[0]?.classList.contains('is-selected'), '桌面单击 = 选中这个文件夹格子');
      eq(
        ctx().settings.get().treeSelected,
        parentDir,
        '单击**不**进目录（那是双击的活，与 Windows 一致）',
      );
      // 点空白 = 取消文件夹的选中（与"点空白取消笔记选中"同一条手感）
      const blank = H.q<HTMLElement>(document.body, '.kbw-grid');
      blank.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await H.settle(80);
      eq(
        folderCells().filter((c) => c.classList.contains('is-selected')).length,
        0,
        '点空白取消文件夹选中',
      );

      dblClick(folderCells()[0]);
      await H.settle(150);
      ok(
        await H.until(() => ctx().settings.get().treeSelected === target, 1500, 30),
        `双击文件夹 = 改 dir（等到落盘；实际 ${ctx().settings.get().treeSelected}）`,
      );
      contains(
        H.textOf(H.q(document.body, '.kbw-crumbs')),
        target.split('/').pop() ?? '',
        '面包屑跟着走',
      );

      /**
       * ⑤ 搜索生效时**一个文件夹格子都不画**。
       *
       * 🔴 判据带两个前提（P6② 独立审查 B 路 🔴2.4 + 我自己的突变实测）：
       *  ① **搜索真的有命中**：用"绝对搜不到"的词时，`foldersFor` 那条守卫**有没有都一样**
       *    （文件夹格子来自 `buildTree(entries())`，搜索把 entries 滤成空、树本来就没有子节点）；
       *  ② **得在"有子目录的那一层"**：进了叶子目录之后本来就没有文件夹格，
       *    守卫删掉也照样绿（第一版就是这么空转的）。所以先回父目录再搜。
       */
      H.click(H.q<HTMLElement>(parentNode as Element, '.kbw-tree-name') ?? (parentNode as Element));
      await H.settle(200);
      ok(folderCells().length > 0, '前提：回到有子目录的那一层（不然这条判据是空转）');
      const search = H.q<HTMLInputElement>(document.body, '.kbw-search');
      const someNote = cellPaths()[0]?.split('/').pop()?.replace(/\.md$/, '') ?? '';
      search.value = someNote.slice(0, 2);
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      await H.settle(150);
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-gcell[data-path]').length > 0,
        `前提：搜索「${someNote.slice(0, 2)}」有命中（否则下面那条判据是空转）`,
      );
      eq(folderCells().length, 0, '搜索时文件夹是噪音 → 不画');
      search.value = '';
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
      await H.settle(150);
      // 回到父目录，收尾干净
      H.click(H.q<HTMLElement>(parentNode as Element, '.kbw-tree-name') ?? (parentNode as Element));
      await H.settle(120);
    });

    // 收尾：把状态拨回基线，别漏给后面的用例（本项目的老规矩）
    await suite.it('收尾：拨回详细信息 + 顺序表清空 + 显式档位复位', async () => {
      await useView('详细信息');
      await ctx().settings.save({ gridOrder: [], gridAutoArrange: true, notesView: null, gridSort: null });
      await H.settle(50);
      eq(cells().length, 0, '回到表格档，网格不在了');
      eq(settings().gridOrder.length, 0, '顺序表清空');
    });
  });

  // ────────────────────────────────────────────────────────────
  /**
   * **P6b ② 网格的 Windows 式**（用户 2026-09-27 原话："希望他们在文件夹中…文件夹
   * **左键双击打开，右键打开菜单**，参考 windows"）。
   */
  await suite.group('P6b ② · 文件夹格子（Windows 式）', async () => {
    const KB_REL = '01_新知识库';
    /** 文件夹格子（与 `cells()` 那份"笔记格子"分开） */
    const folderCells = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-gcell.is-folder');
    const dblClick = (el: Element): void => {
      // 真机的双击序列是 click → click → dblclick
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    };
    const goRoot = async (): Promise<void> => {
      ok(await H.clickTreeNode(''), '回到「整个知识库」');
    };

    /** 顶层目录（相对库根；只用来挑夹具 —— 树默认只展开根节点，深的节点点不到） */
    const topDirs = (): string[] => {
      const out: string[] = [];
      for (const f of app.vault.getAllLoadedFiles()) {
        if (!('children' in f)) continue; // 不是文件夹
        if (!f.path.startsWith(`${KB_REL}/`)) continue;
        if (f.path.split('/').some((seg) => seg.startsWith('.'))) continue;
        const rel = f.path.slice(KB_REL.length + 1);
        if (rel === '' || rel.includes('/')) continue;
        out.push(rel);
      }
      return out.sort((a, b) => a.localeCompare(b, 'zh'));
    };

    /**
     * 挑一个"**本层没有笔记、但有子目录**"的顶层目录。
     * ⚠️ P7.1b 起**库根本身**也是这种层（根层不再递归），但树的默认展开只到根节点、
     * 深一层的节点在 DOM 里点不到 —— 所以这个候选仍然只从**顶层子目录**里找。
     * 挑不到返回 `''`（断言会当场说明）。
     */
    const dirWithOnlyFolders = (): string => {
      const notes = ctx().index.notes();
      const at = new Set(notes.map((e) => e.effectivePosition));
      for (const d of topDirs()) {
        if (at.has(d)) continue;
        // "有子目录"用"它下面有笔记"近似（真子目录数据源在网格那侧；这里只要夹具稳）
        if (notes.some((e) => e.effectivePosition.startsWith(`${d}/`))) return d;
      }
      return '';
    };

    await suite.it('② 空文件夹在网格里**看得见**（数据源是真子目录，不是"有笔记的目录"）', async () => {
      await openNotes();
      await useView('网格');
      await goRoot();
      // 造一个**空**目录（夹具里没有空目录这种东西）
      const name = `__探针空目录-${Date.now()}`;
      fs.mkdirSync(path.join(vaultRoot, KB_REL, name), { recursive: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(180);
      await goRoot();

      const hit = folderCells().find((c) => (c.dataset.dir ?? '') === name);
      ok(
        hit,
        `空目录也要在网格里占一格（实际：${folderCells().map((c) => c.dataset.dir).join(' / ')}）`,
      );
      eq(H.textOf(hit?.querySelector('.kbw-gsize') ?? null), '0 篇', '它的计数是 0 篇');

      // 双击进去 —— 空目录也要能进（用户原话："我建了它，进不去"）
      dblClick(hit as Element);
      await H.settle(200);
      ok(
        await H.until(() => ctx().settings.get().treeSelected === name, 1500, 30),
        `双击空文件夹 = 进得去（实际 ${ctx().settings.get().treeSelected}）`,
      );
      ok(H.maybe(document.body, '.kbw-empty'), '空目录里显示空态（不是"什么都没有"）');

      // 收尾：删掉自造目录 + 回库根（否则后面整片用例都受影响）
      fs.rmSync(path.join(vaultRoot, KB_REL, name), { recursive: true, force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(160);
      await goRoot();
    });

    await suite.it('② 桌面：单击 = 选中（不进目录）· 双击 = 进入 · 触屏单击直接进', async () => {
      await openNotes();
      await useView('网格');
      await goRoot();
      const cell = folderCells()[0];
      ok(cell, '库根那一层得有文件夹格子');
      const dir = cell.dataset.dir ?? '';
      ok(dir, '格子带着目录路径');

      // 桌面单击：只选中
      H.click(cell);
      await H.settle(140);
      ok(cell.classList.contains('is-selected'), '单击 = 选中这一格（Windows 手感）');
      eq(
        ctx().settings.get().treeSelected,
        '',
        '单击**不**进目录（那是双击的活 —— 与资源管理器一致）',
      );

      // 点空白 = 取消文件夹选中
      H.q<HTMLElement>(document.body, '.kbw-notes-list').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await H.settle(120);
      eq(
        folderCells().filter((c) => c.classList.contains('is-selected')).length,
        0,
        '点空白取消文件夹选中',
      );

      // 桌面双击：进入
      dblClick(cell);
      await H.settle(220);
      ok(
        await H.until(() => ctx().settings.get().treeSelected === dir, 1500, 30),
        `双击 = 进那个目录（实际 ${ctx().settings.get().treeSelected}）`,
      );

      // 触屏：单击直接进（触屏没有"选中"这个中间态）
      document.body.classList.add('is-mobile');
      try {
        await goRoot();
        const cell2 = folderCells()[0];
        const dir2 = cell2?.dataset.dir ?? '';
        ok(cell2 && dir2, '回到库根还有文件夹格子');
        H.click(cell2);
        await H.settle(220);
        ok(
          await H.until(() => ctx().settings.get().treeSelected === dir2, 1500, 30),
          `触屏（body.is-mobile）单击 = 直接进（实际 ${ctx().settings.get().treeSelected}）`,
        );
      } finally {
        document.body.classList.remove('is-mobile');
        await goRoot();
      }
    });

    await suite.it('② 右键菜单：非空目录的「重命名…/删除…」**可用**（P7.14 起不再置灰）', async () => {
      await openNotes();
      await useView('网格');
      await goRoot();
      // 00_Inbox 是非空的（夹具里 8 篇）
      const cell = folderCells().find((c) => (c.dataset.dir ?? '') === '00_Inbox');
      ok(cell, '找得到 00_Inbox 那一格（非空）');
      cell?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(120);
      const menu = H.q(document.body, '.kbw-menu');
      const labels = H.qa<HTMLElement>(menu, '.kbw-menu-item').map((i) => H.textOf(i));
      for (const want of ['进入这个目录', '在此新建笔记', '在系统资源管理器中打开', '重命名…', '删除…']) {
        ok(labels.some((t) => t.includes(want)), `菜单里有「${want}」：${labels.join(' | ')}`);
      }
      ok(cell?.classList.contains('is-selected'), '右键即选中（与表格行、卡片同一口径）');
      /**
       * 🔴 **P7.14 · 有意识改契约（做窄 → 放开）**：非空目录原先「重命名/删除」置灰 + 写明原因；
       * 现在两项都可用（语义 = 过 mover：快照 / 撤销 / 双链修复，见 `menus.ts` 顶上那段）。
       * 这里只钉"菜单画得出来且可点"；真正的动库行为在「P7.14 · 文件夹重命名/删除」那组。
       */
      const items = H.qa<HTMLElement>(menu, '.kbw-menu-item');
      const del = items.find((i) => H.textOf(i).includes('删除…'));
      ok(del, '有「删除…」这一项');
      ok(del && !del.classList.contains('is-disabled'), '非空目录 → 删除项**可用**（不再置灰）');
      const rn = items.find((i) => H.textOf(i).includes('重命名…'));
      ok(rn && !rn.classList.contains('is-disabled'), '「重命名…」也可用');
      closeAllMenus();
    });

    await suite.it('② 空目录能删：走确认流（真删掉）', async () => {
      await openNotes();
      await useView('网格');
      await goRoot();
      const name = `__探针待删-${Date.now()}`;
      fs.mkdirSync(path.join(vaultRoot, KB_REL, name), { recursive: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(180);
      await goRoot();
      const cell = folderCells().find((c) => (c.dataset.dir ?? '') === name);
      ok(cell, '造出来的空目录在网格里（数据源是真子目录）');
      cell?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(120);
      const items = H.qa<HTMLElement>(document.body, '.kbw-menu-item');
      const del = items.find((i) => H.textOf(i).includes('删除…'));
      ok(del && !del.classList.contains('is-disabled'), '空目录 → 删除项可点（不置灰）');
      H.click(del as Element);
      await H.settle(200);

      // 确认流（唯一那条动库前的闸）
      const modal = H.q(document.body, '.kbw-modal');
      contains(H.textOf(modal), name, '确认流说清要删的是哪一个');
      const primary = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((b) =>
        H.textOf(b).includes('删除'),
      );
      ok(primary, '确认流有主按钮');
      H.click(primary as Element);
      await H.settle(300);
      eq(
        fs.existsSync(path.join(vaultRoot, KB_REL, name)),
        false,
        '空目录真的被删掉了（走 adapter.rmdir）',
      );
      // 收尾：索引与缓存的账
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(160);
      await goRoot();
    });

    await suite.it('② 空目录"菜单画出来之后"被塞进一篇：点删除时**现问磁盘**，确认单如实报篇数', async () => {
      /**
       * 🔴 这条用例的形态跟着契约换过（P7.14）：
       *   · 旧契约 = 非空一律拒 —— 守卫靠"再问一次磁盘"，弹"目录里还有笔记"；
       *   · 新契约 = 非空也开放 —— `deleteDirTree` **收集目录树走磁盘真源**（`adapter.list`），
       *     确认单里如实报"含 N 个文件"。守卫换了形态，判据跟着换：**缓存树还停在"空"时
       *     塞进一篇**，确认单必须报 1、而不是"空目录"文案（偷懒用缓存判定的实现当场红）。
       * 菜单那一帧照旧允许可点（那是按缓存树的快判），真正的账在点下去之后现算。
       */
      await openNotes();
      await useView('网格');
      await goRoot();
      const name = `__探针塞进来-${Date.now()}`;
      fs.mkdirSync(path.join(vaultRoot, KB_REL, name), { recursive: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(200);
      await goRoot();
      const cell = folderCells().find((c) => (c.dataset.dir ?? '') === name);
      ok(cell, '造出来的空目录在网格里');
      cell?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(140);
      const del = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('删除'),
      );
      ok(del && !del.classList.contains('is-disabled'), '菜单说它可删（目录里此刻确实空）');
      closeAllMenus();
      await H.settle(120);

      // ⚠️ 菜单已经画出来了 —— 现在往里面塞一篇（**缓存树还停在"空"**）
      fs.writeFileSync(
        path.join(vaultRoot, KB_REL, name, '塞进来的.md'),
        '---\n类型: 笔记\n状态: 进行中\n创建日期: 2026-09-27\ntags: []\n---\n# 塞进来的\n',
        'utf8',
      );
      await H.settle(160);

      cell?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(140);
      const del2 = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('删除'),
      );
      ok(del2, '菜单里还有「删除…」这一项');
      H.click(del2 as Element);
      await H.settle(260);
      const modal = H.q(document.body, '.kbw-modal');
      contains(
        H.textOf(modal),
        '含 1 个文件',
        '确认单**现问磁盘**：如实报 1 个文件（若显示"空目录"文案 = 拿了缓存的旧账）',
      );
      const cancel = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((b) =>
        H.textOf(b).includes('不删了'),
      );
      ok(cancel, '有「不删了」');
      H.click(cancel as Element);
      await H.settle(200);
      eq(
        fs.existsSync(path.join(vaultRoot, KB_REL, name, '塞进来的.md')),
        true,
        '取消后那一篇**一个字节都没动**',
      );
      fs.rmSync(path.join(vaultRoot, KB_REL, name), { recursive: true, force: true });
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(200);
      await goRoot();
    });

    await suite.it('② 重命名空目录：菜单 → 取名 → `adapter.rename` 真的动了盘（A🟡3 补的判据）', async () => {
      /**
       * 🔴 独立审查 A🟡3：这条路原先**零判据**，而且**离线跑不通** —— 桩的 `StubAdapter`
       * 没有 `rename`（真机有：asar 取证 `fsPromises.rename` + 对目录连后代逐个
       * `trigger("renamed")`），调用会当场 TypeError、被 catch 吃掉成"重命名失败"。
       * 桩已补；这条用例钉住"菜单那条路真的改到了盘上"。
       */
      await openNotes();
      await useView('网格');
      await goRoot();
      const from = `__探针改名前-${Date.now()}`;
      const to = `__探针改名后-${Date.now()}`;
      fs.mkdirSync(path.join(vaultRoot, KB_REL, from), { recursive: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(220);
      await goRoot();
      const cell = folderCells().find((c) => (c.dataset.dir ?? '') === from);
      ok(cell, `造出来的空目录在网格里（${from}）`);
      cell?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }),
      );
      await H.settle(150);
      const rename = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('重命名'),
      );
      ok(rename && !rename.classList.contains('is-disabled'), '空目录 → 「重命名…」可点（不置灰）');
      H.click(rename as Element);
      await H.settle(200);

      // 取名对话框（与「新建文件夹」同一套 prompt）
      const modal = H.q(document.body, '.kbw-modal');
      const input = H.q<HTMLInputElement>(modal, 'input.kbw-input');
      eq(input.value, from, '输入框预填现在的名字（改名而不是重打一遍）');
      input.value = to;
      H.click(H.q<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn.is-primary'));
      await H.settle(400);

      eq(
        fs.existsSync(path.join(vaultRoot, KB_REL, to)),
        true,
        `新名字在盘上出现了（${to}）`,
      );
      eq(fs.existsSync(path.join(vaultRoot, KB_REL, from)), false, '老名字没了（是改名不是复制）');
      // 收尾
      fs.rmSync(path.join(vaultRoot, KB_REL, to), { recursive: true, force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(200);
      await goRoot();
    });

    await suite.it('② 本层没有笔记但有子文件夹：空态指向**文件夹行**（P7.1b：句尾改口 + 不再给「切到网格档」）', async () => {
      await openNotes();
      await useView('详细信息');
      /**
       * ⚠️ **候选从库结构里取**（别写死 `99_Meta`：夹具一换就假红）—— 只挑**顶层**目录：
       * 树默认只展开根节点，深一层的节点在 DOM 里根本点不到。
       * （P7.1b 起**库根本身**也是这种层，但"双击文件夹行就在上面"这句话在本条同样成立，
       * 夹具不必非用根层。）
       */
      const only = dirWithOnlyFolders();
      ok(
        only !== '',
        `夹具里得有一个"本层没笔记、但有子目录"的顶层目录（扫到的顶层目录：${topDirs().join('、')}）`,
      );
      ok(await H.clickTreeNode(only), `进到那一层（${only}）`);
      await H.settle(120);
      const empty = H.maybe<HTMLElement>(document.body, '.kbw-empty');
      ok(empty, '这一层没有笔记 → 有东西的（空态画出来了）');
      eq(
        H.textOf(H.q(document.body, '.kbw-crumbs-count')),
        '本层 0 篇',
        '面包屑也照实写"本层 0 篇"',
      );
      contains(H.textOf(empty), '文件夹', '空态要说清"这一层有文件夹"（不是"还没有笔记"）');
      /**
       * **P7.1b · N2b 拍板**：句尾指向**文件夹行**（"双击上面的文件夹进入"）；
       * 「切到网格档」那条按钮**撤掉** —— 文件夹行就在空态上面，旧路已冗余。
       */
      contains(
        H.textOf(empty),
        '双击上面的文件夹进入',
        '句尾指向文件夹行（"文件夹行上线后语境变了"）',
      );
      eq(
        H.qa<HTMLElement>(empty as HTMLElement, '.kbw-btn').length,
        0,
        '不再给「切到网格档」按钮（N2b：文件夹行就在上面，那条路已冗余）',
      );
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-frow').length > 0,
        '文件夹行确实就在空态上面（那句话的依据 —— 少了它这句文案才是假的）',
      );
      /**
       * **触屏档写「点」不写「双击」**（独立审查 🟡4）：触屏上文件夹行是**单击直接进**
       *（与网格文件夹格同款），照抄"双击"会和实际行为矛盾。重进这一层强制重画一次。
       */
      document.body.classList.add('is-mobile');
      try {
        await goRoot();
        ok(await H.clickTreeNode(only), `触屏档再进「${only}」`);
        await H.settle(120);
        const empty2 = H.maybe<HTMLElement>(document.body, '.kbw-empty');
        ok(empty2, '触屏档下空态照旧画出来');
        contains(
          H.textOf(empty2),
          '点上面的文件夹进入',
          '触屏档的句尾是「点上面」（单击直接进 —— 与网格文件夹格同款）',
        );
      } finally {
        document.body.classList.remove('is-mobile');
        await goRoot();
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.14 · 文件夹「重命名…/删除…」对**非空目录**也开放（真机反馈："无法删除或重命名"）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.14 · 文件夹重命名/删除（非空也开放）', async () => {
    const KB = DEFAULT_SETTINGS.kbRoot;
    const DIR_A = `${KB}/__p714夹甲`;
    const writeFix = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(vaultRoot, rel)), { recursive: true });
      fs.writeFileSync(path.join(vaultRoot, rel), text, 'utf8');
    };
    const topModal = (): HTMLElement =>
      H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
    const clickModalBtn = (m: HTMLElement, text: string): boolean => {
      const b = H
        .qa<HTMLElement>(m, '.kbw-modal-foot .kbw-btn')
        .find((x) => H.textOf(x).includes(text));
      if (!b) return false;
      H.click(b);
      return true;
    };
    const clean = async (): Promise<void> => {
      fs.rmSync(path.join(vaultRoot, DIR_A), { recursive: true, force: true });
      fs.rmSync(path.join(vaultRoot, `${KB}/__p714夹乙`), { recursive: true, force: true });
      /**
       * ⚠️ **回收站那份也要精确清掉**：local 回收站把文件平铺进 `.trash/<名字>`，
       * 撤销"写回内容"**不回吞**它 —— 留着的话，后面数 `.trash` 件数的用例
       * （P7.1c 的 Del 组）基线会被污染成"期望 0 实际 1"（实测踩过）。
       */
      fs.rmSync(path.join(vaultRoot, '.trash', 'c.md'), { force: true });
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(80);
    };

    await suite.it('重命名（走 mover 整组搬）：两篇进新夹、旧夹（含子目录壳）清掉、撤销能整批还原', async () => {
      writeFix(`${DIR_A}/a.md`, H.note('# a\n'));
      writeFix(`${DIR_A}/子/b.md`, H.note('# b\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 260);
      try {
        const p = openRenameDirPrompt(ctx(), '__p714夹甲');
        await H.settle(120);
        const m = topModal();
        const input = H.q<HTMLInputElement>(m, '.kbw-input');
        input.value = '__p714夹乙';
        input.dispatchEvent(new Event('input'));
        await H.settle(30);
        ok(clickModalBtn(m, '改名'), '有「改名」主按钮');
        await p;
        await H.settleIndex(app, 400);

        ok(fs.existsSync(path.join(vaultRoot, `${KB}/__p714夹乙/a.md`)), 'a.md 搬进新夹');
        ok(
          fs.existsSync(path.join(vaultRoot, `${KB}/__p714夹乙/子/b.md`)),
          '子/b.md 也搬了（子目录整组跟着走）',
        );
        ok(!fs.existsSync(path.join(vaultRoot, DIR_A)), '旧夹（含子目录壳）清掉了');

        await H.until(() => H.currentUndoButton('撤销') != null, 3000, 50);
        const undoBtn = H.currentUndoButton('撤销');
        ok(undoBtn, '撤销条在（mover 快照 = 一个撤销句柄）');
        H.click(undoBtn as HTMLElement);
        await H.settleIndex(app, 400);
        ok(
          await H.until(() => fs.existsSync(path.join(vaultRoot, `${DIR_A}/a.md`)), 3000, 50),
          '撤销：a.md 回到旧夹（快照按 moves 逆搬）',
        );
        ok(
          !fs.existsSync(path.join(vaultRoot, `${KB}/__p714夹乙`)),
          '新夹收回（快照 newDirs —— 里面空了才删得掉）',
        );
      } finally {
        await clean();
      }
    });

    await suite.it('删除（含文件）：确认单点名文件数 → 进回收站 → 撤销按旧路径写回', async () => {
      /**
       * ⚠️ 把 `trashOption` **圈到 `'local'`** 再跑（跑完拨回）：桩的默认是 `'system'`，
       * 那条路会把件数记进 `app.vault.systemTrashed` —— 后面的 P7.1c「Del 删除」组拿它
       * 当"没走系统回收站"的判据（期望 0），被污染成 1 就会红（实测踩过）。
       * `'local'` 同时让 `.trash` 里真的留一份 —— `clean()` 里按名精确清掉。
       */
      const origTrash = app.vault.getConfig('trashOption');
      app.vault.setConfig('trashOption', 'local');
      writeFix(`${DIR_A}/c.md`, H.note('# c\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 260);
      try {
        const p = deleteDirTree(ctx(), '__p714夹甲');
        await H.settle(150);
        const m = topModal();
        contains(H.textOf(m), '含 1 个文件', '确认单标题点名文件数（不再"只对空目录"）');
        contains(H.textOf(m), '回收站', '去向说明在（回收站语义）');
        ok(clickModalBtn(m, '删除这 1 个文件'), '主按钮文案带数量');
        await p;
        await H.settleIndex(app, 400);
        ok(!fs.existsSync(path.join(vaultRoot, `${DIR_A}/c.md`)), '文件进回收站（原位没了）');
        ok(!fs.existsSync(path.join(vaultRoot, DIR_A)), '目录壳也清了');

        await H.until(() => H.currentUndoButton('撤销') != null, 3000, 50);
        const undoBtn = H.currentUndoButton('撤销');
        ok(undoBtn, '撤销条在（mover.trash 的快照）');
        H.click(undoBtn as HTMLElement);
        await H.settleIndex(app, 400);
        ok(
          await H.until(() => fs.existsSync(path.join(vaultRoot, `${DIR_A}/c.md`)), 3000, 50),
          '撤销：文件按旧路径写回（父目录随内容链重建）',
        );
      } finally {
        app.vault.setConfig('trashOption', origTrash as 'system' | 'local' | 'none');
        await clean();
      }
    });
  });
}