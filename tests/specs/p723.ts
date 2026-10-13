/**
 * spec：**P7.23 · 反馈批 7**（2026-10-11）—— 修改方案 = `右键菜单与拖拽跟手-修改方案-2026-10-11.md`
 *
 * 四块的判据（照方案 §五/§七 落）：
 *  ① **勾选框互踩修复**（§7.2）—— R-A 复现（重建后勾选态不许丢）· R-B 语义（点框=累加 /
 *     点格=替换，Q7 拍板"Windows 口径 + 加大命中区"）· R-C 节奏（快勾三连 / 慢勾三连都 = 3）。
 *     🔴 **纪律（常驻）**：任何时刻 **DOM 勾选态 == 选中态**（`boxesMatchSelection`）——
 *     R-A 那两条就是这条纪律的"重建后"一半（重建前那一半由别处的点选用例盖）。
 *  ② 拖拽跟手（§四）：浮标抓取偏移锁 + 纯 transform 合帧 —— 几何类只能真机（探针新步），
 *     离线的可判据部分是**拖动阈值分流**（"想打开结果搬了"的防呆，随 ③ 的文件行一起落）。
 *  ③ 树菜单 7 项 + 文件行（§二 / Q1–Q6）：菜单字面与项数、一层展开 / 完全展开（含文件行）/
 *     收起、文件名规则（`treeShowFiles` 持久化 + normalize）、单击打开、文件行可拖（搬 + 撤销）。
 *     ⚠️ P7.24 起那条根菜单断言已随 T2/T3 更新（非根 7 项 / 根 8 项 —— 根不再恒开），见 p724 与 P7.24 交接。
 *  ④ 批量栏两件（§7.3）：「AI 处理 ›」四条走既有 notes 名单通道 + 「问 AI（N 篇）」（refs 截断
 *     如实）；「打开所选」（≤10 直开 / >10 确认）。
 *
 * 自备库（`makeTempVault('p723')`）：③ 要真建目录 / 真搬文件（mover + 撤销条）、
 * ④ 的 AI 一律假传输层（绝不联网）、「打开所选」真开叶（收尾自己 detach）——
 * 与别的 spec 互不踩。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { followPointer, ghostTranslate } from '../../src/ui/dnd';
import { AI_PANEL_REF_CAP } from '../../src/ui/ai-panel';
import { closeAllMenus } from '../../src/ui/menu';
import { hasUndoBar } from '../../src/ui/undo-bar';
import { normalizeSettings } from '../../src/core/settings';
import { clickMenuPath, menuLabels } from './menu-helpers';

const KB = '01_新知识库';

export async function specP723(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const settings = () => ctx().settings.get();

  // ── 两档的取数（网格格 / 表行；文件夹格与模板格没有勾选框，逐处排掉）────────
  const gcells = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-gcell:not(.is-folder)');
  const trows = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-trow');
  /**
   * 当前这一档的"笔记行/格"（不含文件夹格；模板行/格照收 —— 它们没有勾选框，
   * `boxesMatchSelection` 会跳过，但"选中类"的统计里也不该出现，见那个函数的口径）。
   */
  const listItems = (): HTMLElement[] => [...gcells(), ...trows()];
  const selectedCount = (): number =>
    listItems().filter((el) => el.classList.contains('is-selected')).length;

  /**
   * 批量栏报的「已选 N 篇」—— 它走 `selected: () => this.selectedEntries()`（**点击那刻现取**），
   * 所以这个数是 **store 选择集**的镜子（不是 DOM 态）。批量栏不在（没选择）时返回 null。
   */
  const batchCount = (): number | null => {
    const el = H.maybe(document.body, '.kbw-batch-count');
    if (!el) return null;
    const m = H.textOf(el).match(/已选\s*(\d+)\s*篇/);
    return m ? Number(m[1]) : null;
  };

  /**
   * 🔴 **纪律（本轮常驻判据）**：任何时刻 DOM 勾选态 == 选中态。
   *
   * 两段合起来才算钉上：
   *  ① 每一格/行：`box.checked === is-selected 类`（同一格上的两个 DOM 表示必须一致）；
   *  ② 批量栏「已选 N 篇」（**读 store 现取**）== 选中类计数
   *     → 由①②传递出 `box.checked` 与 store 一致。
   * ⚠️ 没有勾选框的（模板 / 文件夹格）跳过 —— 它们本就"不进选择集"（v2 · #5）。
   */
  function boxesMatchSelection(msg: string): void {
    const list = listItems();
    ok(list.length > 0, `${msg}：这一档画出来了（有笔记行/格）`);
    for (const el of list) {
      const box = el.querySelector<HTMLInputElement>('.kbw-rowcheck');
      if (!box) continue;
      eq(box.checked, el.classList.contains('is-selected'), `${msg}：${el.dataset.path} 勾选框 == 选中类`);
    }
    const sel = selectedCount();
    const n = batchCount();
    if (n != null) eq(n, sel, `${msg}：批量栏「已选 ${n} 篇」== 选中类计数 ${sel}`);
  }

  /** 勾一格/行（= 真机点勾选框的**结果**那一半：翻转 + change；click 那半由 `realBoxClick`） */
  function tick(el: HTMLElement): void {
    const box = el.querySelector<HTMLInputElement>('.kbw-rowcheck');
    if (!box) throw new Error('这一格没有勾选框');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 一发**完整的**勾选框点击 —— 直接 `H.click(box)` 就是完整三件套：
   * 冒泡的 `click`（守卫必须把它吃掉，这是 R-B 的第一半）+ 原生翻转 + `change`。
   * 🔴 **jsdom 的合成 click 跑完整激活行为**（勾选框翻转 + 补发 `change`）——
   * 2026-10-11 实测（第一版在这里手动又翻了一次 → 翻重、勾不上，R-B 假红）。
   * 所以**不要再手动翻转/补 change**；要"只改状态不点"的给 `tick()`。
   */
  function realBoxClick(el: HTMLElement): void {
    const box = el.querySelector<HTMLInputElement>('.kbw-rowcheck');
    if (!box) throw new Error('这一格没有勾选框');
    H.click(box);
  }

  /** 打开「全部笔记」并站进一个本层有 ≥6 篇的目录（网格才有格子，两档同用） */
  async function openNotes(): Promise<void> {
    ctx().goNotes();
    await H.settle(60);
    ok(await H.enterTopDirWithNotes(ctx(), 6), '进到一个本层 ≥6 篇的目录');
  }

  /** 切视图档（**先清选择**：有选择时工具条整条被批量栏顶掉，档位按钮根本不在） */
  async function switchView(label: '网格' | '详细信息'): Promise<void> {
    await clearSelection();
    const seg = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
      H.textOf(b).includes(label),
    );
    ok(seg, `视图档按钮「${label}」在`);
    H.click(seg as Element);
    await H.settle(70);
    ok(
      await H.until(() => settings().notesView === (label === '网格' ? 'grid' : 'detail'), 1200, 30),
      `视图档「${label}」记进配置`,
    );
  }

  /** 清空选择（批量栏 ✕，按 aria-label 找 —— 它是 iconBtn，没有文字） */
  async function clearSelection(): Promise<void> {
    const bar = H.maybe<HTMLElement>(document.body, '.kbw-notes-bar.is-batch');
    if (!bar) return;
    const clear = H.qa<HTMLElement>(bar, 'button').find((b) =>
      (b.getAttribute('aria-label') ?? '').includes('清空选择'),
    );
    if (clear) H.click(clear);
    await H.settle(50);
  }

  // ═════════════════════════════════════════════════════════════
  // ① 勾选框互踩（§7.2）：R-A / R-B / R-C
  // ═════════════════════════════════════════════════════════════
  await suite.group('P7.23 · 勾选框纪律', async () => {
    await suite.it('R-A① 网格重建（自动排列切换 → 列表重画）后勾选态不丢', async () => {
      await openNotes();
      await switchView('网格');
      const list = gcells().filter((c) => !c.dataset.tpl);
      ok(list.length >= 3, '至少 3 格（快/慢勾都要三位）');

      // 勾两个（慢勾：每一次都留出重绘间隙）
      tick(list[0]);
      await H.settle(20);
      tick(list[1]);
      await H.settle(20);
      eq(selectedCount(), 2, '勾了两个');
      boxesMatchSelection('勾完两个时');

      /**
       * 触发**列表区重建**（但不碰选择集）——`gridAutoArrange` 在 `listKey` 里，
       * 切一下 = 整块列表重新渲染（renderGrid 新造 DOM）。这就是 M1 的现形点：
       * 重建出来的勾选框必须照着 store 的选中态画（按现状：渲染成未勾选 → 红）。
       */
      const chk = H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk');
      H.click(chk);
      await H.settle(60);

      eq(selectedCount(), 2, '重建后选择集不丢（is-selected 类照旧）');
      boxesMatchSelection('列表重建之后（M1 现形点：勾选框不许渲染成空的）');
      // 复原（自动排列切回去，别把状态留给下一条）
      H.click(H.q<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk'));
      await H.settle(60);
      boxesMatchSelection('复原自动排列时也不再丢');
      await clearSelection();
    });

    await suite.it('R-A② 库内推一次索引 rev（外部写入的等价物）后勾选态不丢', async () => {
      await openNotes();
      await switchView('网格');
      const list = gcells().filter((c) => !c.dataset.tpl);
      tick(list[0]);
      await H.settle(20);
      tick(list[1]);
      await H.settle(20);
      eq(selectedCount(), 2, '勾了两个');

      // 「索引变了」的最小等价物：重建索引（真库里=同步推库 / 外部写入时的事件链）
      ctx().index.rebuild();
      await H.settle(80);
      eq(selectedCount(), 2, '索引重建后选择集不丢');
      boxesMatchSelection('索引推 rev 之后');
      await clearSelection();
    });

    await suite.it('R-A③ 切档往返（表 → 网格）：两档同口径（带选择切不了 —— 都从清空开始）', async () => {
      await openNotes();
      await switchView('详细信息');
      const rows = trows().filter((r) => !r.dataset.tpl);
      ok(rows.length >= 3, '详细档至少 3 行');
      tick(rows[0]);
      await H.settle(20);
      tick(rows[1]);
      await H.settle(20);
      eq(selectedCount(), 2, '表档勾了两个');
      boxesMatchSelection('表档勾完两个');

      await switchView('网格');
      // ⚠️ 切档**会清选择**（switchView 里先 clearSelection —— 有选择时档位按钮不在）。
      // 这条于是只验"清完之后两档同口径"，真正的"带选择重建"由 R-A① 管。
      boxesMatchSelection('清完选择切到网格（两档同口径：勾选框与选中类一起空）');
    });

    await suite.it('R-B 语义：点勾选框 = 累加（不触发点格替换）；点格本体 = 替换（Windows 口径）', async () => {
      await openNotes();
      await switchView('网格');
      const list = gcells().filter((c) => !c.dataset.tpl);

      tick(list[0]);
      await H.settle(20);
      tick(list[1]);
      await H.settle(20);
      eq(selectedCount(), 2, '先勾两个');

      /**
       * ① 点**第三格的勾选框**（完整三件套）：必须**累加**成 3 ——
       * 冒泡到格子的那发 click 要被守卫（`.kbw-gcb`）吃掉，不许触发"点格 = 替换"。
       */
      realBoxClick(list[2]);
      await H.settle(20);
      eq(selectedCount(), 3, '点勾选框 = 累加（2 + 1），不是替换');
      boxesMatchSelection('三连勾之后');

      /**
       * ② 点勾选框**区的留白**（Q7 加大命中区的那一圈 —— jsdom 里派在 `.kbw-gcb` 上、
       * 不落在 `input` 自身）= **点框**：翻掉 list[0] 的勾（3 → 2）。
       * 若这一支没接住，click 会落进格子本体 → "点格替换" → 选择集变成只剩 list[0]（1）——
       * 断言用 3→2 就能把那两种走法分开。
       */
      const zone = list[0].querySelector<HTMLElement>('.kbw-gcb');
      ok(zone, 'list[0] 有勾选框区（.kbw-gcb）');
      H.click(zone as Element);
      await H.settle(20);
      eq(selectedCount(), 2, '点框周围的留白 = 点框（减选一格）');
      ok(!list[0].classList.contains('is-selected'), '被翻掉的是 list[0]');
      boxesMatchSelection('留白翻框之后');

      /**
       * ③ 点**格子本体**（不是勾选框区）= **替换选择**（Q7 拍板保持 Windows 口径）。
       * 这一条写成明确规格 —— 也正是用户报的"近失点击"的语义面：命中区加大
       * （`.kbw-gcb` 的 29×29）就是为了让"差一点没点中框"的落点仍然算框（由探针真机量）。
       */
      H.click(list[3]);
      await H.settle(20);
      eq(selectedCount(), 1, '点格本体 = 替换为只选它');
      ok(
        list[3].classList.contains('is-selected'),
        '被点的格子是选中的那个',
      );
      boxesMatchSelection('点格替换之后');
      await clearSelection();
    });

    await suite.it('R-C 节奏：快勾三连（无重绘间隙）/ 慢勾三连（每次等重绘），选择集都 = 3', async () => {
      await openNotes();
      await switchView('网格');
      let list = gcells().filter((c) => !c.dataset.tpl);

      // 快勾三连：同一发同步块里连勾三个
      tick(list[0]);
      tick(list[1]);
      tick(list[2]);
      await H.settle(30);
      eq(selectedCount(), 3, '快勾三连 = 3');
      boxesMatchSelection('快勾三连之后');
      await clearSelection();

      // 慢勾三连：每次之间都等重绘
      list = gcells().filter((c) => !c.dataset.tpl);
      tick(list[0]);
      await H.settle(40);
      tick(list[1]);
      await H.settle(40);
      tick(list[2]);
      await H.settle(40);
      eq(selectedCount(), 3, '慢勾三连 = 3');
      boxesMatchSelection('慢勾三连之后');
      await clearSelection();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // ② 拖拽跟手（§三/§四）—— 离线能钉的是"位移怎么算/写在哪"，
  //    真正的"跟不跟手"（偏差 ≤4px、不累积）只能靠真机探针那一步。
  // ═════════════════════════════════════════════════════════════
  await suite.group('P7.23 · 拖拽跟手（离线壳）', async () => {
    await suite.it('ghostTranslate 纯函数：抓取偏移锁死 + 常量偏移（药丸口径）', async () => {
      // 网格浮标口径：起手指针 (126,62)、格子左上角 (100,50) → grab={dx:26,dy:12}
      const g = { dx: 26, dy: 12, left: 100, top: 50 };
      deepEq(ghostTranslate(g, 166, 92), { tx: 40, ty: 30 }, '指针 (166,92) → translate(40,30)');
      // 不变式：布局原点 + translate == 指针 − 抓取偏移（"锁死的偏移"的代数表达）
      const at = ghostTranslate(g, 301, 199);
      eq(g.left + at.tx, 301 - g.dx, '左边缘 == 指针 − 抓取偏移（x）');
      eq(g.top + at.ty, 199 - g.dy, '上边缘 == 指针 − 抓取偏移（y）');
      // 药丸口径：布局原点 (0,0)、恒定偏移 (−12,−14)（= 原来的 +12/+14 落点）
      deepEq(
        ghostTranslate({ dx: -12, dy: -14, left: 0, top: 0 }, 200, 300),
        { tx: 212, ty: 314 },
        '药丸：指针 + (12,14)',
      );
    });

    await suite.it('followPointer：起手同步落位 / 每帧合帧只写一次 / stop 收净', async () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      try {
        const follow = followPointer(el, { dx: -12, dy: -14, left: 0, top: 0 });
        follow.move(10, 20);
        eq(el.style.transform, 'translate3d(22px, 34px, 0)', '第一发**同步**写（不等 rAF，起手无残影）');
        follow.move(100, 100);
        follow.move(200, 300);
        eq(
          el.style.transform,
          'translate3d(22px, 34px, 0)',
          '同一帧内的后续 move 不直写（只存最新坐标）',
        );
        await H.settle(40);
        eq(
          el.style.transform,
          'translate3d(212px, 314px, 0)',
          '一帧只写一次、取**最新**坐标（中间那些被合帧丢掉）',
        );
        follow.move(500, 500);
        follow.stop();
        await H.settle(40);
        eq(el.style.transform, 'translate3d(212px, 314px, 0)', 'stop 之后挂起的那一帧不再写');
        // scale 并串（网格浮标用）
        const el2 = document.createElement('div');
        document.body.appendChild(el2);
        const f2 = followPointer(el2, { dx: 0, dy: 0, left: 0, top: 0 }, { scale: 1.04 });
        f2.move(10, 10);
        eq(el2.style.transform, 'translate3d(10px, 10px, 0) scale(1.04)', 'scale 并进同一串 transform');
        f2.stop();
        el2.remove();
      } finally {
        el.remove();
      }
    });

    await suite.it('真链路：单篇浮标 = 起手带 scale / 合帧写最新 / 松手即收 + 自动排列复原', async () => {
      await openNotes();
      await switchView('网格');
      const list = gcells().filter((c) => !c.dataset.tpl);
      const cell = list[0];
      ok(cell, '有一格可拖');
      H.pointerDown(cell, { x: 20, y: 10 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 26, y: 12 }); // 越过 4px 阈值 → beginDrag
      await H.tick(5); // < 一帧：rAF 还没跑
      const float = H.maybe<HTMLElement>(document.body, '.kbw-gfloat');
      ok(float, '越过阈值 → 出现单篇浮标');
      eq(
        float.style.transform,
        'translate3d(0px, 0px, 0) scale(1.04)',
        '起手同步落位，且 scale 并进同一串（不被 inline transform 覆盖丢失）',
      );
      eq(float.style.willChange, 'transform', '拖动期间挂 will-change（元素收掉随去）');
      const leftBefore = float.style.left;
      const topBefore = float.style.top;
      H.pointerMove(document.body, { x: 66, y: 52 });
      eq(
        float.style.transform,
        'translate3d(0px, 0px, 0) scale(1.04)',
        'rAF 未到：位移还是上一帧的值（合帧，不是每发 move 直写）',
      );
      await H.settle(40);
      eq(
        float.style.transform,
        'translate3d(40px, 40px, 0) scale(1.04)',
        '一帧后 = 最新坐标（纯算术：指针 − 抓取偏移 − 布局原点）',
      );
      eq(float.style.left, leftBefore, '跟手路径**不碰 left**（没有布局写）');
      eq(float.style.top, topBefore, '跟手路径**不碰 top**（没有布局写）');
      H.pointerUp(document.body, { x: 66, y: 52, buttons: 0 });
      await H.settle(40);
      eq(H.maybe(document.body, '.kbw-gfloat'), null, '松手 → 浮标收掉');
      eq(H.maybe(document.body, '.kbw-gap'), null, '空档也收掉');
      // 拖完自动取消「自动排列」（既有口径）—— 复原，别把状态留给后面的用例
      const chk = H.maybe<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk');
      if (chk && !chk.classList.contains('is-on')) {
        H.click(chk);
        await H.settle(30);
      }
    });

    await suite.it('真链路：多篇药丸同源（transform 合帧），松开即收', async () => {
      await openNotes();
      await switchView('网格');
      let list = gcells().filter((c) => !c.dataset.tpl);
      tick(list[0]);
      await H.settle(20);
      tick(list[1]);
      await H.settle(20);
      eq(selectedCount(), 2, '先选两篇（整组拖动的前提）');
      H.pointerDown(list[1], { x: 20, y: 10 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 26, y: 12 });
      await H.tick(5);
      const pill = H.maybe<HTMLElement>(document.body, '.kbw-dragghost');
      ok(pill, '多篇拖动 → 药丸');
      eq(H.textOf(pill), '2 篇', '药丸写「2 篇」');
      eq(pill.style.transform, 'translate3d(38px, 26px, 0)', '药丸起手同步落位（指针 + 12/14）');
      H.pointerMove(document.body, { x: 66, y: 52 });
      await H.settle(40);
      eq(pill.style.transform, 'translate3d(78px, 66px, 0)', '合帧后 = 最新坐标');
      H.pointerUp(document.body, { x: 66, y: 52, buttons: 0 });
      await H.settle(40);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '松开 → 药丸收掉');
      await clearSelection();
      const chk = H.maybe<HTMLElement>(document.body, '.kbw-sortbar .kbw-chk');
      if (chk && !chk.classList.contains('is-on')) {
        H.click(chk);
        await H.settle(30);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════
  // ③ 树菜单 7 项 + 文件行（§二 / Q1–Q6）
  // ═════════════════════════════════════════════════════════════
  await suite.group('P7.23 · 树菜单与文件行', async () => {
    /** 节点行（**带 data-drop** 的才是目录 —— 文件行没有它，别用 `.kbw-tree-item` 裸选） */
    const treeNode = (dir: string): HTMLElement | null =>
      H.qa<HTMLElement>(document.body, '.kbw-tree-item[data-drop]').find(
        (el) => (el.dataset.dir ?? '') === dir,
      ) ?? null;
    const fileRows = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-tree-file');
    const caretOpen = (row: HTMLElement | null): boolean =>
      !!row?.querySelector('.kbw-tree-caret.is-open');
    /** 右键一个目录节点 → 等菜单挂出来 */
    async function rightClickNode(dir: string): Promise<void> {
      closeAllMenus();
      const node = treeNode(dir);
      ok(node, `树里有节点「${dir === '' ? '整个知识库' : dir}」`);
      node?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 220 }),
      );
      await H.settle(120);
    }

    /**
     * 可控子树的夹具（4 层，比夹具库深 —— 专门为"一层 vs 递归"的区分造）：
     *   __p723树/A/甲.md · A/B/乙.md · A/B/C/丙.md · A/B/C/D/丁.md
     * 4 层才让"展开子目录只开一层"可见：D 的行出不出现 = 唯一的 DOM 证据。
     *
     * ⚠️ 树**只渲染展开节点的子节点** —— 造完还要把「__p723树」展开，
     * 否则连 A 的行都不在 DOM 里（第一版就栽在这：rightClickNode('__p723树/A') 找不到节点）。
     * 展开走**产品路径**（节点菜单 →「展开子目录」，幂等）。
     */
    async function seedTree(): Promise<void> {
      H.writeNote(vaultRoot, `${KB}/__p723树/A/甲.md`, H.note('# 甲\n'));
      H.writeNote(vaultRoot, `${KB}/__p723树/A/B/乙.md`, H.note('# 乙\n'));
      H.writeNote(vaultRoot, `${KB}/__p723树/A/B/C/丙.md`, H.note('# 丙\n'));
      H.writeNote(vaultRoot, `${KB}/__p723树/A/B/C/D/丁.md`, H.note('# 丁\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(80);
      await rightClickNode('__p723树');
      ok(await clickMenuPath('展开子目录'), '先把「__p723树」展开（A 的行才在）');
      await H.settle(120);
      ok(treeNode('__p723树/A'), '「__p723树/A」可见');
    }

    await suite.it('节点菜单 = 非根 7 项 / 根 8 项（P7.24 · T2/T3 后）· 字面与顺序对 · 一级 ≤8', async () => {
      ctx().goNotes();
      await H.settle(80);

      await rightClickNode('01_Projects');
      const labels = menuLabels();
      const want = [
        '在此新建笔记',
        '在此新建目录',
        '展开子目录',
        '完全展开（含所有子文件夹与文件）',
        '收起此文件夹',
        '在系统资源管理器中打开',
        '重排库结构…',
      ];
      eq(labels.length, want.length, `树节点菜单 = 7 项（实际：${labels.join(' | ')}）`);
      // ⚠️ 用 startsWith：置灰项会把原因拼在后面（「在系统资源管理器中打开这个版本不提供」）
      want.forEach((w, i) => {
        ok(labels[i].startsWith(w), `第 ${i + 1} 项是「${w}」（实际「${labels[i]}」）`);
      });
      ok(labels.length <= 8, '一级 ≤ 8（菜单硬规矩）');
      closeAllMenus();
      await H.settle(60);

      /**
       * 根节点：**P7.24 · T2 反转后不再恒开** —— 根也画「收起此文件夹」；
       * T3 再补一条「全部收起」（只给根）。满配 8 项（≤8，带分隔线）。
       */
      await rightClickNode('');
      const rootLabels = menuLabels();
      const wantRoot = [
        '在此新建笔记',
        '在此新建目录',
        '展开子目录',
        '完全展开（含所有子文件夹与文件）',
        '收起此文件夹',
        '全部收起',
        '在系统资源管理器中打开',
        '重排库结构…',
      ];
      eq(rootLabels.length, wantRoot.length, `根节点菜单 = 8 项（实际：${rootLabels.join(' | ')}）`);
      wantRoot.forEach((w, i) => {
        ok(rootLabels[i].startsWith(w), `根第 ${i + 1} 项是「${w}」（实际「${rootLabels[i]}」）`);
      });
      ok(rootLabels.length <= 8, '根一级 ≤ 8（满配正好 8）');
      closeAllMenus();
      await H.settle(60);
    });

    await suite.it('展开子目录 = 只开一层（孙目录的行不出现）；完全展开 = 递归 + 文件行', async () => {
      await openNotes();
      await seedTree();

      // ① 展开子目录：open ∪ {A, B} —— C 不开，D 的行**不出现**（唯一可观测的"一层"证据）
      await rightClickNode('__p723树/A');
      ok(await clickMenuPath('展开子目录'), '点了「展开子目录」');
      await H.settle(120);
      ok(caretOpen(treeNode('__p723树/A')), 'A 自己展开了');
      ok(caretOpen(treeNode('__p723树/A/B')), '直接子目录 B 也展开了');
      ok(treeNode('__p723树/A/B/C'), 'C 的行可见（B 开着）');
      eq(treeNode('__p723树/A/B/C/D'), null, 'D 的行**不在** —— 只开一层（孙目录没展开）');
      eq(fileRows().length, 0, '展开子目录**不**列文件行');

      // ② 完全展开：递归 + 整棵子树列文件（Q1）
      await rightClickNode('__p723树/A');
      ok(await clickMenuPath('完全展开'), '点了「完全展开」');
      await H.settle(120);
      ok(caretOpen(treeNode('__p723树/A/B/C')), 'C 也展开了（递归）');
      ok(treeNode('__p723树/A/B/C/D'), 'D 的行出现（四层全开）');
      const files = fileRows();
      eq(files.length, 4, `四层各列一篇文件行（实际 ${files.length}）`);
      const names = files.map((r) => H.textOf(r));
      deepEq(names, ['丁', '丙', '乙', '甲'], '文件行按"子目录之后、同层按名排"排（D→C→B→A 的嵌套顺序）');
      // 持久化：等防抖落盘（Q5）
      ok(
        await H.until(() => {
          const f = settings().treeShowFiles;
          return f.includes('__p723树/A') && f.includes('__p723树/A/B/C/D');
        }, 1500, 30),
        'treeShowFiles 记进配置（含整棵子树）',
      );
    });

    await suite.it('收起此文件夹 = open 只收本节点（后代保留）+ 子树"含文件展示"全清', async () => {
      // 自足地先把 A 完全展开（不赖上一条的收尾状态 —— 单条子集跑也能验）
      await rightClickNode('__p723树/A');
      ok(await clickMenuPath('完全展开'), '先把 A 完全展开');
      await H.settle(120);
      ok(caretOpen(treeNode('__p723树/A/B/C/D')) || treeNode('__p723树/A/B/C/D'), '完全展开态在位');

      await rightClickNode('__p723树/A');
      ok(await clickMenuPath('收起此文件夹'), '点了「收起此文件夹」');
      await H.settle(120);
      eq(treeNode('__p723树/A/B'), null, '收起后整棵子树的行都没了');
      eq(fileRows().length, 0, '文件行也没了');
      ok(
        await H.until(() => !settings().treeShowFiles.includes('__p723树/A/B/C/D'), 1500, 30),
        'treeShowFiles 整棵子树被清（"收起来就该全收"）',
      );

      // 点三角重新展开（Q3：后代 open 记录保留 —— B/C/D 仍在原态）+ 文件行**不再自己冒出来**
      const rowA = treeNode('__p723树/A');
      ok(rowA, 'A 的行在');
      H.click(H.q<HTMLElement>(rowA as HTMLElement, '.kbw-tree-caret'));
      await H.settle(120);
      ok(caretOpen(treeNode('__p723树/A/B')), 'B 仍在原态（开着 —— 后代 open 记录保留）');
      ok(treeNode('__p723树/A/B/C/D'), 'D 的行也在（原态整棵复原）');
      eq(fileRows().length, 0, '文件行**不**跟着回来（收起时清干净了）');
    });

    await suite.it('在此新建目录：真建 + 建完进得去（onOpenDir 链）', async () => {
      await rightClickNode('00_Inbox');
      ok(await clickMenuPath('在此新建目录'), '节点菜单里有「在此新建目录」');
      await H.settle(200);
      const modal = H.q(document.body, '.kbw-modal');
      const input = H.q<HTMLInputElement>(modal, 'input.kbw-input');
      const name = '__p723新建目录';
      input.value = name;
      H.click(H.q<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn.is-primary'));
      await H.settleIndex(app);
      await H.settle(120);

      const rel = `00_Inbox/${name}`;
      ok(H.exists(vaultRoot, `${KB}/${rel}`), '目录真建了（磁盘上在）');
      ok(treeNode(rel), '树里自然出现（不手动 rebuild —— onOpenDir 那条链）');
      // "建完进得去"：当前面包屑的 is-on 段 = 新目录
      const crumb = H.q<HTMLElement>(document.body, '.kbw-crumb.is-on');
      ok(H.textOf(crumb).includes(name), `建完就站在里面（面包屑 = ${H.textOf(crumb)}）`);

      // 收场：安全删法（metadataCache 有 ~300ms 滞后重解析定时器）+ 回一个正常目录
      fs.rmSync(path.join(vaultRoot, KB, rel), { force: true, recursive: true });
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(120);
      eq(treeNode(rel), null, '清场：新目录从树里消失');
    });

    await suite.it('文件行：单击（含 2px 微动）= 打开不误判；拖到目录节点 = 搬 + 撤销', async () => {
      await openNotes();
      await seedTree();
      // 让 A 的文件行可见
      await rightClickNode('__p723树/A');
      ok(await clickMenuPath('完全展开'), '先完全展开 A（文件行才有）');
      await H.settle(120);

      const full甲 = `${KB}/__p723树/A/甲.md`;
      const row甲 = (): HTMLElement | null =>
        fileRows().find((r) => (r.dataset.path ?? '') === full甲) ?? null;
      ok(row甲(), '「甲」的文件行在');

      // ① 单击（一次 2px 的微动 —— 没过 4px 阈值）→ 打开、不搬
      H.pointerDown(row甲() as Element, { x: 30, y: 10 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 32, y: 10 });
      await H.tick(10);
      H.pointerUp(document.body, { x: 32, y: 10, buttons: 0 });
      H.click(row甲() as Element); // 真机上浏览器补的那一发 click
      await H.settle(80);
      ok(
        app.__leaves.some((l) => l.opened === full甲),
        '单击 = 打开这一篇（2px 微动不算拖）',
      );
      eq(ctx().index.get(full甲)?.effectivePosition, '__p723树/A', '单击不搬（"想打开结果搬了"防呆）');
      ok(!hasUndoBar(), '单击不出撤销条');

      // ② 拖过阈值 → 药丸 + 目标高亮 → 松手搬 + 撤销条
      const target = treeNode('__p723树');
      ok(target, '目标节点「__p723树」在');
      H.pointerDown(row甲() as Element, { x: 30, y: 10 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 40, y: 12 }); // 过 4px 阈值
      await H.tick(10);
      ok(H.maybe(document.body, '.kbw-dragghost'), '拖过阈值 → 药丸在');
      ok(row甲()?.classList.contains('is-dragging'), '原行 is-dragging 观感');
      H.pointerMove(target as Element, { x: 60, y: 40 });
      await H.tick(10);
      ok(target?.classList.contains('is-drop'), '掠过目录节点 → 目标高亮（本地，不走 store）');
      H.pointerUp(target as Element, { x: 60, y: 40, buttons: 0 });
      await H.settleIndex(app);
      // ⚠️ 搬完**路径变了** —— 按新路径查（一开始写的是旧路径，拿到的 undefined 被误读了一会儿）
      eq(
        ctx().index.get(`${KB}/__p723树/甲.md`)?.effectivePosition,
        '__p723树',
        '拖到目录节点 = 真搬（mover 同一条链；新路径在、有效位置=目标）',
      );
      ok(H.exists(vaultRoot, `${KB}/__p723树/甲.md`), '新位置的文件真在磁盘上');
      ok(hasUndoBar(), '搬完出撤销条');
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '松手后药丸收掉');

      // 撤销还原（收场）
      const undoBtn = H.currentUndoButton('撤销');
      ok(undoBtn, '有撤销按钮');
      H.click(undoBtn as Element);
      await H.settleIndex(app);
      eq(ctx().index.get(full甲)?.effectivePosition, '__p723树/A', '撤销把文件搬回原目录');
    });

    await suite.it('模板文件行：可打开、**不可拖**（与网格 v2·#5 同口径；独立审 🟡2 补）', async () => {
      await openNotes();
      await seedTree();
      // 模板夹具：名字带 T_ 就是模板（与索引的 isTemplate 同一口径）
      H.writeNote(vaultRoot, `${KB}/__p723树/A/T_模板.md`, H.note('# 模板体\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(80);
      ok(ctx().index.get(`${KB}/__p723树/A/T_模板.md`)?.isTemplate, '夹具被认成模板');

      await rightClickNode('__p723树/A');
      ok(await clickMenuPath('完全展开'), '完全展开（模板行也要列出来 —— 看得见）');
      await H.settle(120);
      const tplRow = fileRows().find((r) => (r.dataset.path ?? '').endsWith('/T_模板.md'));
      ok(tplRow, '模板的文件行画出来了');

      // 拖它：4px 阈值过了也不该起拖动（连基元都不起）—— 药丸不出现、文件不搬
      const target = treeNode('__p723树');
      ok(target, '目标节点在');
      H.pointerDown(tplRow as Element, { x: 30, y: 10 });
      await H.tick(10);
      H.pointerMove(document.body, { x: 60, y: 20 });
      await H.tick(10);
      H.pointerMove(target as Element, { x: 60, y: 40 });
      await H.tick(10);
      eq(H.maybe(document.body, '.kbw-dragghost'), null, '模板行拖不动（药丸不出现）');
      H.pointerUp(target as Element, { x: 60, y: 40, buttons: 0 });
      await H.settleIndex(app);
      ok(
        H.exists(vaultRoot, `${KB}/__p723树/A/T_模板.md`),
        '模板没被拖走（还在 __p723树/A）',
      );
      // 收场：删模板夹具（别把 T_ 留在 __p723树 里影响后续用例的树行数断言）
      fs.rmSync(path.join(vaultRoot, KB, '__p723树/A/T_模板.md'), { force: true });
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(120);
    });

    await suite.it('treeShowFiles 的 normalize 收敛（静态：同 treeOpen 那条口径）', async () => {
      const norm = normalizeSettings({ treeShowFiles: ['a', 1, null, 'b', ''] });
      deepEq(norm.treeShowFiles, ['a', 'b', ''], '非字符串项剔掉、字符串原样保留（同 treeOpen 口径）');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // ④ 批量栏两件（§7.3）：AI 处理 ›（含问 AI 截断）· 打开所选（Q9 阈值）
  // ═════════════════════════════════════════════════════════════
  await suite.group('P7.23 · 批量栏两件', async () => {
    const batchBtn = (label: string): HTMLElement | null =>
      H.qa<HTMLElement>(document.body, '.kbw-notes-bar.is-batch button').find((b) =>
        H.textOf(b).includes(label),
      ) ?? null;
    /**
     * 等索引就绪 + 站进 dir + 切网格 + 等到列表里真有 ≥n 格。
     *
     * 🔴 **别用 `goNotes({ dir })`**（本组第一版栽在这，源码探针查出机制）：
     * 带 dir 的意图会被"**当时那个模块实例**"消费掉，而块刚起来时 `indexReady` 翻转
     * 常紧跟着发生 → 模块**重挂第二个实例** —— 新实例只从 `s.treeSelected` 取目录，
     * 而那是**防抖 400ms** 落盘的（还没落）→ 落到旧目录（根层）上，
     * "跳转的目录"整个丢掉。真机上这个窗口≈0（首页可点的时候索引早 ready 了），
     * 是**测试时序**问题 —— 但判据要稳，就照既有模式走：`goNotes()` + **点树节点**
     *（`clickTreeNode` 自带"点中了没"的三次自证）。
     */
    async function openGridDir(dir: string, n: number): Promise<void> {
      ok(await H.until(() => ctx().index.isReady(), 4000), '索引就绪');
      ctx().goNotes();
      await H.settle(80);
      ok(await H.clickTreeNode(dir), `站进 ${dir}（走树节点，自证）`);
      await switchView('网格');
      ok(
        await H.until(() => gcells().filter((c) => !c.dataset.tpl).length >= n, 1500, 30),
        `进了 ${dir}（网格里 ≥${n} 格）`,
      );
    }

    /** 造 n 篇夹具进 `__p723AI` 并站进去（打开所选 >10 的确认门、问 AI 的截断都要它） */
    async function seedAI(count: number): Promise<void> {
      for (let i = 1; i <= count; i += 1) {
        H.writeNote(vaultRoot, `${KB}/__p723AI/篇${String(i).padStart(2, '0')}.md`, H.note(`# 篇 ${i}\n`));
      }
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(80);
      await openGridDir('__p723AI', count);
    }

    await suite.it('「AI 处理 ›」= 起标题/修链/修前言/补声明 + 问 AI（这 N 篇）；起标题真开面板', async () => {
      await openGridDir('00_Inbox', 2);
      let list = gcells().filter((c) => !c.dataset.tpl);
      tick(list[0]);
      await H.settle(20);
      tick(list[1]);
      await H.settle(20);
      eq(selectedCount(), 2, '先选两篇');

      const ai = batchBtn('AI 处理');
      ok(ai, '批量栏有「AI 处理」');
      H.click(ai as Element);
      await H.settle(120);
      const labels = menuLabels();
      const want = ['起标题', '修链', '修前言', '补声明', '问 AI（这 2 篇）'];
      eq(labels.length, want.length, `子菜单 = 4 条动作 + 问 AI（实际：${labels.join(' | ')}）`);
      want.forEach((w, i) => ok(labels[i].startsWith(w), `第 ${i + 1} 条是「${w}」（实际「${labels[i]}」）`));

      ok(await clickMenuPath('起标题'), '点「起标题」');
      await H.settle(160);
      const modal = H.q(document.body, '.kbw-modal');
      ok(H.textOf(modal).includes('AI 起标题'), '起标题面板真开了（only 名单通道）');
      H.keydown(modal, 'Escape');
      await H.settle(80);
      await clearSelection();
    });

    await suite.it('「问 AI（这 N 篇）」：refs 按面板真实容量 5 截断并如实说', async () => {
      await seedAI(12);
      // ⚠️ 批量栏要**先有选择**才出现（它整条顶掉工具条）——想点「全选」得先选一格
      tick(gcells().filter((c) => !c.dataset.tpl)[0]);
      await H.settle(40);
      const allBtn = batchBtn('全选');
      ok(allBtn, '有「全选」');
      H.click(allBtn as Element);
      await H.settle(60);
      eq(selectedCount(), 12, '全选 12 篇');

      // 拦下 openAi（用例只验"带了几篇引用"，不起真的 AI 面板）
      const captured: { seed: string; refs: number }[] = [];
      const realOpen = ctx().openAi;
      ctx().openAi = (seed?: string, refs?: unknown[]) => {
        captured.push({ seed: seed ?? '', refs: (refs ?? []).length });
      };
      try {
        const ai = batchBtn('AI 处理');
        ok(ai, '有「AI 处理」');
        H.click(ai as Element);
        await H.settle(100);
        ok(await clickMenuPath('问 AI（这 12 篇）'), '点「问 AI（这 12 篇）」');
        await H.settle(100);
        eq(captured.length, 1, 'openAi 被调了一次');
        /**
         * 🔴 截断口径 = **AI 面板的真实容量 5**（`AI_PANEL_REF_CAP`；独立审 🔴1 纠的口径错位 ——
         * 第一版按 `AI_LIMITS.refs`(10) 截、通知也说"前 10 篇"，而面板 `slice(0,5)` 会**静默**
         * 再砍一刀：6~10 篇连通知都没有）。这条判据钉的是**真闸门**（面板常量），不是中间层的自说自话。
         */
        eq(captured[0].refs, AI_PANEL_REF_CAP, `refs 按 AI_PANEL_REF_CAP=${AI_PANEL_REF_CAP} 截断`);
        const noticeText = H.textsOf(document.body, '.kbw-notice').join(' ');
        ok(noticeText.includes('5 篇'), `如实说了截断（通知里见「5 篇」：${noticeText}）`);
      } finally {
        ctx().openAi = realOpen;
      }
      await clearSelection();
    });

    await suite.it('「打开所选」：≤10 直开 N 个叶；>10 先确认（取消 = 一个都不开）', async () => {
      await seedAI(12);
      // ① >10：先确认 → Esc 取消 → 一个都不开
      tick(gcells().filter((c) => !c.dataset.tpl)[0]); // 先有选择 → 批量栏才出现
      await H.settle(40);
      H.click(batchBtn('全选') as Element);
      await H.settle(60);
      eq(selectedCount(), 12, '全选 12 篇');
      const openBtn = batchBtn('打开所选');
      ok(openBtn, `批量栏有「打开所选（12 篇）」（实际：${openBtn ? H.textOf(openBtn) : '没有'}）`);
      app.__leafCalls.length = 0;
      H.click(openBtn as Element);
      await H.settle(120);
      const modal = H.q(document.body, '.kbw-modal');
      ok(H.textOf(modal).includes('打开这 12 篇'), '>10 先弹确认（标题写清 N）');
      ok(H.textOf(modal).includes('12 个标签页'), '确认单里写清"将打开 12 个标签页"');
      H.keydown(modal, 'Escape');
      await H.settle(80);
      eq(app.__leafCalls.filter((c) => c.kind === 'tab').length, 0, '取消 = 一个都不开');

      // ② ≤3：直接开 3 个叶
      await clearSelection();
      let list = gcells().filter((c) => !c.dataset.tpl);
      ok(list.length >= 3, '至少 3 格');
      tick(list[0]);
      await H.settle(20);
      tick(list[1]);
      await H.settle(20);
      tick(list[2]);
      await H.settle(20);
      eq(selectedCount(), 3, '选 3 篇');
      const openedPaths = list.slice(0, 3).map((c) => c.dataset.path ?? '');
      app.__leafCalls.length = 0;
      H.click(batchBtn('打开所选') as Element);
      await H.settle(160);
      eq(H.maybe(document.body, '.kbw-modal'), null, '≤10 不弹确认');
      eq(app.__leafCalls.filter((c) => c.kind === 'tab').length, 3, '开了 3 个标签叶');
      for (const p of openedPaths) {
        ok(app.__leaves.some((l) => l.opened === p), `真的打开了「${p.split('/').pop()}」`);
      }
      await clearSelection();
      // 收场：把这几扇叶 detach 掉（别给后面的用例留挂着的 markdown 视图）
      for (const l of [...app.__leaves]) {
        if (l.opened && openedPaths.includes(l.opened)) l.detach();
      }
      await H.settle(60);
    });
  });
}
