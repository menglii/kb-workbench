/**
 * spec：**P6 段⑥ · 结构与手势轮**（2026-09-28）—— 离线能验的那一半
 *
 * 对应 `归档/提示词/P6期第六段提示词.md` 的三条 + 顺带项：
 *   · **④-A 顶栏列头槽**：「目录」抬进顶栏那一格，三列头同一基线
 *   · **⑤ 卡片双击升格**：双击 = 把那一篇交出去变成平台标签页
 *   · **⑥ `editor-menu`**：平台笔记右键菜单里那两项（判据与动作同一份规则）
 *   · **语义色收口**：徽标不再"反色文字压满底"
 *
 * ⚠️ **真机才验得了的那些不在这里**：几何（三列头基线差 ≤2px / 槽宽 == 目录栏宽）、
 * 双击之后"两个 buffer 不许并存"、平台菜单真长什么样、对比度读数 —— 全在 `scripts/probe.mjs`。
 * 这里只钉"能离线钉死的那一半"：DOM 结构、接线、纯函数、静态形状。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { hasUndoBar } from '../../src/ui/undo-bar';
import { closeCardPanel, panelPaths } from '../../src/modules/board/editor';
import { BOARD_CONFIG_VERSION } from '../../src/modules/board/config';
import { menuAppliesTo, buildAiSubmenu, buildEditorSubmenu, underKbRoot } from '../../src/ui/editor-menu';
import { VIEW_TYPE } from '../../src/view/workbench-view';
import { renderNotes } from '../../src/modules/notes';

/** 库根名（换夹具时与 `tests/helpers.ts` 的 `BASE_KB` 那一段一起改） */
const KB = '01_新知识库';
const BOARD_CFG = `${KB}/99_Meta/06_工作台/看板配置.json`;

export async function specP6d(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /**
   * 点导航项切模块。
   * ⚠️ **不走 `ctx().goNotes()`**（e2 那轮的教训）：那一次调用会顺手把"待消费的意图"清成 null，
   * 于是"意图有没有被重复消费"这类事会被它**替实现盖住**。点导航项才是真路径。
   */
  async function navTo(label: string): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes(label),
    );
    ok(nav, `导航里有「${label}」`);
    H.click(nav as Element);
    await H.settle(180);
  }

  /** 看板配置（模拟"手改库内 JSON"：走文件 + modify 事件，真链路） */
  async function writeBoardCfg(data: unknown): Promise<void> {
    H.writeNote(vaultRoot, BOARD_CFG, `${JSON.stringify(data, null, 2)}\n`);
    app.vault.rescan();
    const f = app.vault.getAbstractFileByPath(BOARD_CFG);
    app.vault.trigger('modify', f);
    await H.settle(320); // 配置监听是 150ms debounce
  }

  const boardCfg = (extra: Record<string, unknown> = {}): unknown => ({
    version: BOARD_CONFIG_VERSION,
    view: { cardMode: 'content', panelProps: 'few', ...extra },
    sections: [{ id: 's-cont', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P6 段⑥ ④-A · 顶栏列头槽', async () => {
    await suite.it('「目录」住在顶栏那一格；目录树里不再有表头', async () => {
      await ctx().activate();
      await H.settle();
      await navTo('全部笔记');
      closeAllMenus();

      const slot = H.q<HTMLElement>(document.body, '.kbw-colslot');
      /**
       * **顺序是判据的一部分**：槽占的是顶栏**最左边那一格**（与目录栏同一条竖线）。
       * 放进中间或末尾就跑到标题右边去了 —— 而"跑到哪儿"离线量不了，
       * 所以至少把"它是第一个孩子"钉死。
       */
      const topbar = H.q<HTMLElement>(document.body, '.kbw-topbar');
      eq(topbar.firstElementChild, slot, '槽是顶栏的第一个孩子（占最左那一格）');

      const head = H.maybe<HTMLElement>(slot, '.kbw-tree-head');
      ok(head, '槽里装着树表头');
      contains(H.textOf(head), '目录', '槽里写着「目录」');

      const side = H.q<HTMLElement>(document.body, '.kbw-notes-side');
      eq(H.maybe(side, '.kbw-tree-head'), null, '目录树自己那一行表头已经取消');
      ok(H.maybe(side, '.kbw-tree-body'), '树体还在（取消的只是表头那一行）');
    });

    await suite.it('「重排库结构」没随表头一起消失：搬到面包屑行右端', async () => {
      const bar = H.q<HTMLElement>(document.body, '.kbw-notes-toolbar');
      const labeled = (root: ParentNode): boolean =>
        H.qa<HTMLElement>(root, 'button').some((b) =>
          (b.getAttribute('aria-label') ?? '').includes('目录操作'),
        );
      /**
       * ⚠️ **有选择时整条工具条被批量栏顶掉**（§3.4 的既定口径，与「列」/「筛选」/视图档
       * 那几个按钮同一待遇）—— 那一刻 `⋯` 本来就该不在。全量跑时上一条用例留下的选择
       * 正是这个状态（子集跑时反而没有 → 这条会假绿）。
       * 清选择**点批量栏的 ✕**，别用模拟 Esc：Esc 走 `installGlobalEscape` 那条
       * document 捕获监听，桩环境里不一定接得住（c 期实测），点按钮是同步生效的。
       */
      if (!labeled(bar)) {
        const clear = H.maybe<HTMLElement>(bar, '.kbw-batch-tail .kbw-iconbtn');
        ok(clear, '工具条被批量栏顶掉了，而且找不到「清空选择」那颗 ✕');
        H.click(clear as Element);
        await H.settle(180);
      }
      ok(labeled(bar), '清空选择之后，面包屑行里找得到「目录操作」');
      eq(
        H.maybe(bar, '.kbw-batch-tail'),
        null,
        '前置自证：这时画的是真工具条（不是批量栏）',
      );

      /**
       * ⚠️ 判据落在**"它不在树表头里"**上，而不只是"它在别处在"。
       * 只判"找得到"的话，把入口留在原地（表头被删 → 入口自然也没了）也不会红 ——
       * 而"入口随着那一行一起没了"正是这条要防的。
       */
      const head = H.q<HTMLElement>(document.body, '.kbw-colslot .kbw-tree-head');
      eq(labeled(head), false, '树表头里已经没有这颗 ⋯ 了（它搬走了）');
    });

    await suite.it('外壳没起来（直接渲染模块）时，标题**留在树里**而不是弄丢', async () => {
      /**
       * ⚠️ **"没有槽"这件事现在只能靠"根本没有外壳"来造**（独立审查 A🔴1 的修法带来的一处连带）：
       * `paintModule` 会在渲染前把 `ctx.colSlot` 认回**本视图**那一份，
       * 所以"把 `ctx.colSlot` 清掉再切模块"这条路**已经造不出没有槽的世界**了
       *（第一版就是这么写的，修完当场红）。
       * 真正够得着兜底的场景只剩一个：**离线/直接渲染这个模块**（没有外壳的那条路）——
       * 那就照那个场景写：自己造一个裸宿主、直接调 `renderNotes`。
       */
      await navTo('首页');
      const c = ctx() as unknown as { colSlot?: unknown };
      const saved = c.colSlot;
      c.colSlot = undefined;
      const bare = document.createElement('div');
      bare.className = 'kbw-mod';
      document.body.appendChild(bare);
      let cleanup: (() => void) | null = null;
      try {
        cleanup = renderNotes(bare, ctx()) ?? null;
        await H.settle(120);
        const head = H.maybe<HTMLElement>(bare, '.kbw-notes-side .kbw-tree-head');
        ok(head, '没有槽时表头回到树里（标题不能因为"没有槽"而消失）');
        contains(H.textOf(head), '目录', '回去的还是那一份「目录」');
        eq(H.maybe(bare, '.kbw-colslot'), null, '裸宿主里本来就没有槽');
      } finally {
        cleanup?.();
        bare.remove();
        c.colSlot = saved;
        await H.settle(120);
        await navTo('全部笔记');
      }
    });

    await suite.it('切走模块 → 槽收干净（不留孤儿 DOM）', async () => {
      eq(H.q(document.body, '.kbw-colslot').children.length, 1, '在「全部笔记」里槽是有内容的');
      await navTo('首页');
      eq(
        H.q(document.body, '.kbw-colslot').children.length,
        0,
        '切走之后槽空了（模块 dispose 把自己的节点带走）',
      );
      await navTo('全部笔记');
    });

    /**
     * 🔴 **这条是独立审查 A🔴1 的复现**（真 bug，不是补强）：`ctx.colSlot` 与 `ctx.dock`
     * 一样是**单槽**（多标签时后开的视图胜），而模块是在 `mount()` 里认依赖的 ——
     * 分屏两个工作台标签、都停在「全部笔记」时，**两边模块都会从 ctx 现取**，
     * 拿到的是**后开那个视图**的槽 → 两个模块往同一个槽里 `replaceChildren`、互相顶掉 →
     * **先建的那个视图的「目录」标题彻底消失**（槽里空、树里也空）。
     * 修法是"**渲染谁，谁把口子摆成自己的**"（`workbench-view.ts` 的 `paintModule`）。
     *
     * ⚠️ 判据要**逐视图**量（"全页表头数 == 视图数"也能过，但那对不上人眼看到的画面）——
     * 每个视图自己的槽里必须**正好一个**表头。
     */
    await suite.it('分屏两个工作台标签：两边各自看得见「目录」（认人不止在视图层）', async () => {
      const roots = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-root');
      const shape = (r: HTMLElement): { heads: number; inSlot: number } => ({
        heads: r.querySelectorAll('.kbw-tree-head').length,
        inSlot: r.querySelectorAll('.kbw-colslot .kbw-tree-head').length,
      });
      await navTo('全部笔记');
      eq(roots().length, 1, '前置：先只有一个工作台视图');

      const leaf2 = app.workspace.getLeaf('tab');
      await leaf2.setViewState({ type: VIEW_TYPE } as never);
      await H.settle(520);
      eq(roots().length, 2, '前提：两个工作台视图');

      /**
       * 走**这一段**（独立审查的复现路径）：切走再切回 —— 两个模块都会**重建**，
       * 而重建那一刻才会重新认 `ctx.colSlot`。
       * 用 store 而不是点导航项：两个视图同屏时 `qa('.kbw-navitem')` 会跨视图命中，
       * 而 `store.set` 正是导航项点击做的事（两边各自订阅 store，都会重画）。
       */
      ctx().store.set({ activeModule: 'home' });
      await H.settle(340);
      ctx().store.set({ activeModule: 'notes' });
      await H.settle(460);

      for (const [i, r] of roots().entries()) {
        const c = shape(r);
        eq(c.heads, 1, `视图 ${i + 1}：「目录」表头正好一个（既不能丢、也不能有两份）`);
        eq(c.inSlot, 1, `视图 ${i + 1}：表头在**自己那个槽**里`);
      }

      // 关掉第二个：第一个的表头还得在（收尾的"只撤自己的"那一条）
      leaf2.detach();
      await H.settle(420);
      eq(roots().length, 1, '第二个视图关掉了');
      eq(shape(roots()[0]).inSlot, 1, '关掉第二个之后，第一个的「目录」还在');
      await navTo('首页');
      await navTo('全部笔记');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P6 段⑥ ⑤ · 卡片双击 = 升格成标签页', async () => {
    const cards = (): HTMLElement[] => H.qa(document.body, '[data-card]');

    async function openBoardWithCards(): Promise<void> {
      await writeBoardCfg(boardCfg());
      await navTo('看板');
      ok(cards().length > 0, `卡片出来了（${cards().length} 张）`);
    }

    /** 双击（`detail: 2` 与真机一致） */
    function dblclick(el: Element): void {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    }

    /** 单击卡片标题（开小窗那条主路径）—— 每次重新取 DOM（面板一开看板就重画，旧引用是游离节点） */
    async function clickCard(path: string): Promise<void> {
      const card = H.q<HTMLElement>(document.body, `[data-card][data-path="${path}"]`);
      H.click(card.querySelector('.kbw-card-t') as Element);
      await H.settle(200);
    }

    /**
     * **这一篇还活着的叶**（不按 `kbw-cw-leaf` 过滤 —— 平台那个标签页的叶也算一份）。
     * 判据是"同一份文件只有一个活编辑器"，所以两边都要数进来。
     * ⚠️ 桩的 `detach()` 会把叶从 `__leaves` 里**摘掉**，所以这里其实只能看见活着的那些；
     * 保底再判一次 `!detached`（将来桩改成留档也不会假绿）。
     */
    const liveLeavesFor = (path: string): unknown[] =>
      (
        app as unknown as {
          __leaves: { detached: boolean; view: { file?: { path: string } } | null }[];
        }
      ).__leaves.filter((l) => l.view?.file?.path === path && !l.detached);

    /**
     * 把这一篇的叶全 detach 掉（**探针开的自己收**：上一条用例升格出来的标签页不会自己关）。
     * ⚠️ **循环清到干净为止**：平台的 `openFile` 是异步的，上一条用例留下的叶可能在我数完之后
     * 才落进来 —— 清一次有时会剩下一个（突变测试时就是这么红的，而红在前置那句、看不出真因）。
     */
    const detachAllFor = (path: string): void => {
      type Leaf = {
        detached: boolean;
        view: { file?: { path: string } } | null;
        detach?: () => void;
      };
      const all = (): Leaf[] => (app as unknown as { __leaves: Leaf[] }).__leaves;
      for (let round = 0; round < 8; round += 1) {
        const alive = all().filter((l) => l.view?.file?.path === path && !l.detached);
        if (alive.length === 0) return;
        for (const l of alive) l.detach?.();
      }
    };

    await suite.it('单击照旧开小窗；双击把它**交出去**：窗里没了 + 平台开了标签页', async () => {
      await openBoardWithCards();
      const p = cards()[0].dataset.path as string;

      await clickCard(p);
      eq(panelPaths().join(','), p, '单击之后小窗里就是这一篇（主路径一个字没变）');
      /**
       * 前置自证：小窗开着它时，那张卡片带「编辑中」虚线描边（a.5-3 的源卡片标记）。
       * 有了这一步，下面"升格之后描边摘掉"才是一条**有信息量**的判据
       *（独立审查 B-6：`mirrorEditing` 那一句注释写着"不能省这一句"，而当时**没有判据**）。
       */
      eq(
        H.q<HTMLElement>(document.body, `[data-card][data-path="${p}"]`).classList.contains(
          'is-editing-source',
        ),
        true,
        '前置：卡片带着「编辑中」描边',
      );

      const before = app.__leafCalls.length;
      dblclick(H.q<HTMLElement>(document.body, `[data-card][data-path="${p}"]`));
      await H.settle(260);

      eq(panelPaths().includes(p), false, '那一篇从小窗里**走了**（升格 = 走掉，不是复制一份）');
      eq(
        H.q<HTMLElement>(document.body, `[data-card][data-path="${p}"]`).classList.contains(
          'is-editing-source',
        ),
        false,
        '升格之后，「编辑中」描边摘掉了（升格那句 mirrorEditing 真的跑了）',
      );
      eq(H.qa(document.body, '.kbw-cw-panel').length, 0, '只剩一篇时小窗整个关掉');
      const calls = app.__leafCalls.slice(before);
      ok(
        calls.some((c) => c.kind === 'tab'),
        `升格走的是 getLeaf('tab')（实际：${calls.map((c) => String(c.kind)).join('/') || '没调用' }）`,
      );
      /**
       * ⚠️ **"平台真的开了那一篇"必须单独钉**：只看"窗里没了 + 调过 getLeaf"的话，
       * "先关掉、然后忘了开"照样绿 —— 而那正是会丢笔记的那一类错。
       */
      ok(
        app.__leaves.some((l) => l.opened === p),
        `平台确实打开了这一篇（${p}）`,
      );
    });

    await suite.it('不变量：升格之后窗里**不留第二个 buffer**（同一份文件只许一个活编辑器）', async () => {
      await openBoardWithCards();
      const p = cards()[0].dataset.path as string;
      /**
       * ⚠️ **先把这一篇的叶清干净**：本组上一条用例升格出来的**平台标签页不会自己关**，
       * 留着它就会把下面那个"只有一份 buffer"数成 2（第一版就是这么假红的）——
       * 判据必须是**自证的**，不能依赖"上一条有没有顺手清场"。
       */
      detachAllFor(p);
      await H.settle(200);
      eq(liveLeavesFor(p).length, 0, '前置：这一篇一个活叶都没有');

      await clickCard(p);
      eq(panelPaths().join(','), p, '前置：小窗里开着它');
      eq(liveLeavesFor(p).length, 1, '前置：此刻只有一个活叶（窗里那个）');
      dblclick(H.q<HTMLElement>(document.body, `[data-card][data-path="${p}"]`));
      await H.settle(260);
      eq(panelPaths().includes(p), false, '列表里这一篇已经摘掉了');
      /**
       * 🔴 **必须看"叶真的 detach 了没"，不能只看 `panelPaths()`**（独立审查 B-1，
       * 它用突变实证过）：`closeTab` 第一句就是 `p.tabs.splice(...)` ——
       * **只要它被调到，`panelPaths()` 就少一篇**，与"那个编辑器叶有没有被 detach"**无关**。
       * 突变：把 `dropTab` 里的 `detachLeaf(tab)` 删掉 → 这一组**照样全绿**，
       * 而 `app.__leaves` 从 3 涨到 5（同一份文件两个活 buffer —— 正是要防的那件事）。
       *
       * ⚠️ **这里数的是"这一篇还活着的叶总数"，不按 `kbw-cw-leaf` 过滤**：
       * 不变量是"同一份文件只有一个活编辑器"，所以平台那个标签页的叶**也算一份**
       *（升格之后它就该是 1；窗里那份必须已经 detach，否则就是 2）。
       * 够得着 `__leaves` 的办法与 `tests/specs/board.ts` 的 `panelLeaves()` 同源
       *（桩的 `__leaves` 连 `new WorkspaceLeaf(app)` 造的叶也算 —— 那正是真机看不见的一半）。
       */
      eq(liveLeavesFor(p).length, 1, `这一篇活着、且**只有一份** buffer（实际 ${liveLeavesFor(p).length} 份）`);
    });

    await suite.it('「没先单击」也能升格（promoteToTab 的兜底分支，独立审查 B-5）', async () => {
      /**
       * ⚠️ 上面两条都**先单击**（面板里已经开着那一篇）→ `promoteToTab` 走的是
       * `findTabAnywhere` 命中那一支。**没命中那一支**（面板里根本没有它）从来没跑过 ——
       * 独立审查 B-5 在它开头加 `if (!hit) return;` 也照样全绿。
       * 真实场景：只读刚放开、或者直接双击一张还没开过的卡。
       */
      await openBoardWithCards();
      const p = cards()[0].dataset.path as string;
      eq(panelPaths().length, 0, '前置：小窗里什么都没有');
      const before = app.__leafCalls.length;
      dblclick(H.q<HTMLElement>(document.body, `[data-card][data-path="${p}"]`));
      await H.settle(320);

      const calls = app.__leafCalls.slice(before);
      ok(
        calls.some((c) => c.kind === 'tab'),
        `兜底那一支也要 getLeaf('tab')（实际：${calls.map((c) => String(c.kind)).join('/') || '没调用'}）`,
      );
      ok(
        app.__leaves.some((l) => l.opened === p),
        '平台确实打开了这一篇（别假装有窗、也别什么都不做）',
      );
      /**
       * ⚠️ **兜底分支不开小窗**：这一下只派了 `dblclick`、没有派那两次 `click`，
       * 所以"单击开窗"那一步根本没发生（第一版把期望写成 1，当场假红）。
       * 真实手势里窗是**单击**开的，兜底管的是"窗里没有它"那种情况。
       */
      eq(panelPaths().length, 0, '兜底分支不开小窗（窗是单击那条路开的）');
      closeCardPanel({ reason: 'spec-cleanup' });
      await H.settle(140);
    });

    /**
     * ⚠️ **「选择模式下双击不升格」这条只有静态判据**（独立审查 B-3 点出来的缺口）：
     * `selectMode` 活在**看板模块自己的 store** 上（不是全局 `WorkbenchState`），
     * 外面够不着；真要离线验就得先走完"触屏长按 400ms"那条真手势（在 `p6d` 这一层太重，
     * 而探针里已经有那条手势的判据）。所以这里退到静态：**钉住那三条短路在不在**。
     * 这是本项目对这类缺口的常规处置（`redline.ts` 那批就是这么来的）。
     */
    await suite.it('双击的三条短路都在源码里（触屏 / 选择模式 / 修饰键）—— 静态', () => {
      const src = fs
        .readFileSync(path.join(H.repoRoot(), 'src', 'modules', 'board', 'index.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const i = src.indexOf('private onCardDoubleClick(');
      ok(i > 0, '找得到 onCardDoubleClick');
      const body = src.slice(i, src.indexOf('\n  private ', i + 10));
      ok(/if \(isTouchPointer\(evt\)\) return;/.test(body), '触屏短路在（探针另有真机判据）');
      ok(/s\.selectMode/.test(body), '选择模式短路在（这条只有静态判据，别删）');
      ok(/hasMod\(evt\) \|\| evt\.shiftKey/.test(body), '修饰键短路在');
      ok(/readonly/.test(body), '只读短路在');
    });

    await suite.it('触屏不参与：`body.is-mobile` 下双击什么都不做', async () => {
      await openBoardWithCards();
      const p = cards()[0].dataset.path as string;
      await clickCard(p);
      const before = app.__leafCalls.length;
      document.body.classList.add('is-mobile');
      try {
        dblclick(H.q<HTMLElement>(document.body, `[data-card][data-path="${p}"]`));
        await H.settle(220);
      } finally {
        document.body.classList.remove('is-mobile');
      }
      eq(panelPaths().includes(p), true, '触屏双击之后小窗还在（没有升格）');
      eq(app.__leafCalls.length, before, '也没让平台开标签页');
      // 清场：把小窗收掉，别把编辑现场留给下一条
      closeCardPanel({ reason: 'spec-cleanup' });
      await H.settle(140);
    });

    await suite.it('只读模式：双击不升格（与单击同一条口径）', async () => {
      await writeBoardCfg(boardCfg({ readonly: true }));
      await navTo('看板');
      ok(cards().length > 0, '卡片出来了');
      const p = cards()[0].dataset.path as string;
      const before = app.__leafCalls.length;
      dblclick(H.q<HTMLElement>(document.body, `[data-card][data-path="${p}"]`));
      await H.settle(220);
      eq(panelPaths().length, 0, '只读模式不开小窗（前置）');
      eq(app.__leafCalls.length, before, '也不升格到标签页');
      // 还原配置，别把只读留给后面的用例
      await writeBoardCfg(boardCfg());
      await navTo('看板');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P6 段⑥ ⑥ · editor-menu（判据 + 动作）', async () => {
    await suite.it('纯函数：只有「库根之下的 .md」才归我们管', () => {
      eq(underKbRoot(`${KB}/00_Inbox/a.md`, KB), true, '库根之下 ✓');
      eq(underKbRoot(KB, KB), true, '库根本身也算在库里');
      /**
       * ⚠️ **前缀陷阱**：`01_新知识库-备份/…` 与库根同前缀、但**不是库里的东西**。
       * 只写 `startsWith(kbRoot)` 会把它算进来 —— 这一行的存在就是让那种写法当场红。
       */
      eq(underKbRoot(`${KB}-备份/a.md`, KB), false, '同前缀的兄弟目录不算');
      eq(underKbRoot('别的库/a.md', KB), false, '库外不算');

      const f = (p: string, ext: string): never => ({ path: p, extension: ext }) as never;
      eq(menuAppliesTo(f(`${KB}/00_Inbox/a.md`, 'md') as never, KB), true, 'md + 库内 ✓');
      eq(menuAppliesTo(f(`${KB}/00_Inbox/a.txt`, 'txt') as never, KB), false, '非 md ✗');
      eq(menuAppliesTo(f(`${KB}-备份/a.md`, 'md') as never, KB), false, '库根之外 ✗');
      eq(menuAppliesTo(null, KB), false, '没有文件（画布/空白处右键）✗');
    });

    /**
     * R8 两栏化的**单元层**：两个子菜单各三项、回调接线、段名（放到「插入」之下）。
     * `planOneReconcile` 那组口径用例随菜单项退役一起删 —— 「按规则归位」并入
     * 「自动整理」（判据换成与一键整理同一条 `planRebuild` 链，覆盖率在 tidy 组）。
     */
    const unitDeps = (log: string[]): never =>
      ({
        app,
        kbRoot: () => KB,
        openInWorkbench: () => log.push('workbench'),
        copyPath: () => log.push('copy'),
        rename: () => log.push('rename'),
        tidyOne: () => log.push('tidy'),
        aiTitle: () => log.push('aiTitle'),
        beautify: () => log.push('beautify'),
        askAi: () => log.push('askAi'),
      }) as never;

    await suite.it('经纬 ›：三项固定（复制文件路径 / 重命名 / 返回经纬工作台），各自接回调', () => {
      const log: string[] = [];
      const file = { path: `${KB}/00_Inbox/x.md`, basename: 'x' } as never;
      const m = makeMenu();
      buildEditorSubmenu(m as never, file, unitDeps(log));
      eq(
        m.items.map((i) => i.title).join(','),
        '复制文件路径,重命名,返回经纬工作台',
        '经纬恒三项（R8 拍定：用户自己动的动作放这栏）',
      );
      m.items[0].run();
      m.items[1].run();
      m.items[2].run();
      eq(log.join(','), 'copy,rename,workbench', '三项分别接到了回调（不是只画了壳）');
    });

    await suite.it('经纬AI ›：常态三项（自动整理 / 自动命名 / 美化笔记），各自接回调', () => {
      const log: string[] = [];
      const file = { path: `${KB}/00_Inbox/x.md`, basename: 'x' } as never;
      const m = makeMenu();
      buildAiSubmenu(m as never, file, unitDeps(log), '');
      eq(
        m.items.map((i) => i.title).join(','),
        '自动整理,自动命名,美化笔记',
        '经纬AI 常态三项（条件项「问 AI」在没有选区时不画 —— 那半在 p73c 组）',
      );
      m.items[0].run();
      m.items[1].run();
      m.items[2].run();
      eq(log.join(','), 'tidy,aiTitle,beautify', '三项分别接到了回调');
    });

    await suite.it('真链路：`editor-menu` 进来 → 两个子菜单（section=insert）→「自动整理」走确认流 + mover', async () => {
      /**
       * ① **先验接线**：库里**本来就有**普通笔记 —— 拿一篇去触发，顶层仍该是**两个**子菜单。
       * R8 起「自动整理」**不是条件项**（没有该挪的也会给出"这一篇没有要整理的"——
       * 拍定 14 的语义，别改回"条件画项"）；这一条钉的是 `main.ts` 把接线真的挂上了
       *（纯函数那层用的是注入的假 dep，验不到接线）。
       */
      const plain = ctx()
        .index.getAll()
        .find((e) => !e.isTemplate && !('文件位置' in e.props) && e.effectivePosition);
      ok(plain, '库里有一篇没写「文件位置」的笔记（用它验接线）');
      const gotPlain = collectMenu((menu) => {
        app.workspace.trigger('editor-menu', menu, {} as never, {
          file: H.fileAt(app, (plain as { path: string }).path),
        } as never);
      });
      eq(gotPlain.top.join(','), '经纬,经纬AI', '顶层两项（都收进子菜单，一级不铺开）');
      eq(
        gotPlain.tops.map((t) => t.section).join(','),
        'insert,insert',
        '两项都挂 insert 段（放到「插入」之下 —— asar 取证的段名；收尾真机复核渲染顺序）',
      );

      /**
       * ② 夹具：造一篇"声明与实际不符"的笔记（`00_Inbox` 里，声明 `02_Areas/内容创作`）。
       * ⚠️ 造完必须 `rescan()` **+ 等索引 + `index.rebuild()`**（P6② 那条：`rescan()` 会重建
       * 全部 `TFile`，索引不重建的话后面整片用例会红）。
       */
      const rel = `${KB}/00_Inbox/__p6d归位.md`;
      const moved = `${KB}/02_Areas/内容创作/__p6d归位.md`;
      H.writeNote(vaultRoot, rel, '---\n文件位置: 02_Areas/内容创作\n---\n\n正文\n');
      app.vault.rescan();
      await H.settleIndex(app);
      ctx().index.rebuild();
      await H.settleIndex(app);

      /**
       * 🔴 **夹具的清理一律走 `finally`**（独立审查 B-12）：这中间每一条 `ok()/eq()`
       * 都可能抛（断言失败就抛），一抛就跳过了下面的清场 ——
       * 库里从此多一篇 `__p6d归位.md`，而**下一轮全量跑的前提就被它改了**
       *（本项目为"夹具残留"付过不止一次代价）。
       */
      const cleanup = async (): Promise<void> => {
        /**
         * A8（P7.21a 顺带收）：点"最新那条且非离场"的撤销按钮 —— 别退回
         * `document.querySelector('.kbw-undobar button')`（按文档顺序取第一个，
         * 命中的很可能是上一条正在离场的旧条；P7.19 收编 15 处时漏了这两处）。
         */
        const undo = H.currentUndoButton('撤销');
        if (undo) {
          H.click(undo);
          await H.settle(420);
        }
        for (const p of [moved, rel]) {
          if (H.exists(vaultRoot, p)) fs.rmSync(path.join(vaultRoot, p), { force: true });
        }
        app.vault.rescan();
        await H.settleIndex(app);
        ctx().index.rebuild();
        await H.settleIndex(app);
      };

      try {
        const target = H.fileAt(app, rel);
        const got = collectMenu((menu) => {
          app.workspace.trigger('editor-menu', menu, {} as never, { file: target } as never);
        });
        const wei = got.tops.find((t) => t.title === '经纬');
        const ai = got.tops.find((t) => t.title === '经纬AI');
        ok(wei && ai, '两个子菜单都在');
        eq(
          (wei as FakeItem).sub?.items.map((i) => i.title).join(','),
          '复制文件路径,重命名,返回经纬工作台',
          '经纬三项（R8 拍定）',
        );
        eq(
          (ai as FakeItem).sub?.items.map((i) => i.title).join(','),
          '自动整理,自动命名,美化笔记',
          '经纬AI 三项（没有选区时）',
        );

        // ③ 点「自动整理」→ 走 `main.ts` 的接线（`runInboxTidy` 收窄档）→ 确认流 → mover
        const tidyItem = (ai as FakeItem).sub?.items.find((i) => i.title === '自动整理');
        ok(tidyItem, '找得到「自动整理」');
        eq(H.exists(vaultRoot, rel), true, '前置：它还在 00_Inbox');
        (tidyItem as FakeItem).run();
        const opened = await H.until(
          () => H.maybe<HTMLElement>(document.body, '.kbw-modal') != null,
          1600,
        );
        ok(opened, '确认流弹出来了（§9：动库前一律过它）');
        const modal = H.q<HTMLElement>(document.body, '.kbw-modal');
        contains(H.textOf(modal), '整理', '确认框说的是「整理」');
        const primary = H.qa<HTMLElement>(modal, 'button').find((b) =>
          H.textOf(b).includes('搬这'),
        );
        ok(primary, '有主按钮（搬这 N 篇）');
        H.click(primary as Element);
        eq(
          await H.until(() => H.exists(vaultRoot, moved), 1600),
          true,
          '真的按声明搬到了 02_Areas/内容创作',
        );
        /**
         * ⚠️ **成对判**（P6② 那条：只判"新位置有"会被 `already`（拖回原处）骗过）：
         * 老位置必须同时没了。
         */
        eq(H.exists(vaultRoot, rel), false, '老位置没有了');
        eq(hasUndoBar(), true, '有撤销条（与手工那条同一套）');
        const logs = H.listFiles(vaultRoot, `${KB}/99_Meta/05_操作日志`);
        ok(logs.length > 0, `留了日志（${logs.length} 份）`);
      } finally {
        await cleanup();
      }
    });

    await suite.it('真链路：经纬AI › 美化笔记 → 对比框 → 替换正文（只换正文、前言不动）+ 撤销条', async () => {
      H.resetAi();
      H.stubAi({ raw: '# 美化稿\n\n改写过的正文。\n' });
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      const rel = `${KB}/00_Inbox/__p6d美化.md`;
      const head = '---\n类型: 笔记\n文件位置: 00_Inbox\n---\n\n';
      H.writeNote(vaultRoot, rel, `${head}# 原文\n\n旧的正文。\n`);
      app.vault.rescan();
      await H.settleIndex(app);
      ctx().index.rebuild();
      await H.settleIndex(app);
      const cleanup = async (): Promise<void> => {
        /**
         * A8（P7.21a 顺带收）：点"最新那条且非离场"的撤销按钮 —— 别退回
         * `document.querySelector('.kbw-undobar button')`（按文档顺序取第一个，
         * 命中的很可能是上一条正在离场的旧条；P7.19 收编 15 处时漏了这两处）。
         */
        const undo = H.currentUndoButton('撤销');
        if (undo) {
          H.click(undo);
          await H.settle(420);
        }
        if (H.exists(vaultRoot, rel)) fs.rmSync(path.join(vaultRoot, rel), { force: true });
        app.vault.rescan();
        await H.settleIndex(app);
        ctx().index.rebuild();
        await H.settleIndex(app);
        // AI 配回"没配"（后面的用例默认未配置）
        await ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: '' } });
        H.resetAi();
      };
      try {
        const target = H.fileAt(app, rel);
        const got = collectMenu((menu) => {
          app.workspace.trigger('editor-menu', menu, {} as never, { file: target } as never);
        });
        const ai = got.tops.find((t) => t.title === '经纬AI');
        const bItem = (ai as FakeItem)?.sub?.items.find((i) => i.title === '美化笔记');
        ok(bItem, '找得到「美化笔记」');
        (bItem as FakeItem).run();
        const opened = await H.until(
          () => H.maybe<HTMLElement>(document.body, '.kbw-modal') != null,
          1600,
        );
        ok(opened, '确认流（带对比框）弹出来了');
        const modal = H.q<HTMLElement>(document.body, '.kbw-modal');
        contains(H.textOf(modal), '替换', '标题说清动作（用美化稿替换…）');
        const diff = H.maybe<HTMLElement>(modal, '.kbw-diff');
        ok(diff, '对比框在（`confirm` 的 attach 扩展点）');
        contains(H.textOf(diff as HTMLElement), '对比', '对比框有抬头（行数 + 增删计数）');
        ok(
          H.qa<HTMLElement>(diff as HTMLElement, '.kbw-diff-line.is-add').length > 0,
          '新增行标出来（is-add）',
        );
        ok(
          H.qa<HTMLElement>(diff as HTMLElement, '.kbw-diff-line.is-del').length > 0,
          '被换掉的行标出来（is-del）',
        );

        const primary = H.qa<HTMLElement>(modal, 'button').find((b) =>
          H.textOf(b).includes('替换正文'),
        );
        ok(primary, '主按钮「替换正文」');
        H.click(primary as Element);
        eq(
          await H.until(() => H.readNote(vaultRoot, rel).includes('美化稿'), 2000),
          true,
          '正文换成了美化稿',
        );
        const after = H.readNote(vaultRoot, rel);
        eq(after.startsWith(head), true, '前言原样保留（只换正文）');
        eq(after.includes('旧的正文'), false, '旧正文没了（成对判）');
        eq(hasUndoBar(), true, '有撤销条（快照还原）');
      } finally {
        await cleanup();
      }
    });

    await suite.it('写盘那一步抛错 → 弹「美化没走完」，不静默（P7.12 收尾 · 独立审 A3）', async () => {
      H.resetAi();
      H.stubAi({ raw: '# 美化稿\n\n改写过的正文。\n' });
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      const rel = `${KB}/00_Inbox/__p6d美化抛.md`;
      H.writeNote(vaultRoot, rel, '---\n类型: 笔记\n---\n\n# 原文\n\n旧的正文。\n');
      app.vault.rescan();
      await H.settleIndex(app);
      ctx().index.rebuild();
      await H.settleIndex(app);
      const cleanup = async (): Promise<void> => {
        if (H.exists(vaultRoot, rel)) fs.rmSync(path.join(vaultRoot, rel), { force: true });
        app.vault.rescan();
        await H.settleIndex(app);
        ctx().index.rebuild();
        await H.settleIndex(app);
        await ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: '' } });
        H.resetAi();
      };
      try {
        const target = H.fileAt(app, rel);
        const got = collectMenu((menu) => {
          app.workspace.trigger('editor-menu', menu, {} as never, { file: target } as never);
        });
        const ai = got.tops.find((t) => t.title === '经纬AI');
        const bItem = (ai as FakeItem)?.sub?.items.find((i) => i.title === '美化笔记');
        ok(bItem, '找得到「美化笔记」');
        (bItem as FakeItem).run();
        ok(await H.until(() => H.maybe<HTMLElement>(document.body, '.kbw-modal') != null, 1600), '确认流弹出来了');
        const modal = H.q<HTMLElement>(document.body, '.kbw-modal');
        /**
         * 故意让写盘那一步炸 —— 模拟"确认期间那篇被别处删了/同步换文件"。
         * 独立审 A3 抓的是：旧写法 `try/finally` 没有 `catch`，这一发会被调用方的
         * `void` 吞成未捕获拒绝——不弹错、无撤销条、用户以为"点了替换，什么都没发生"。
         */
        const orig = app.vault.process;
        (app.vault as { process: unknown }).process = async () => {
          throw new Error('模拟写盘失败（文件刚被别处删了）');
        };
        try {
          const primary = H.qa<HTMLElement>(modal, 'button').find((b) => H.textOf(b).includes('替换正文'));
          ok(primary, '主按钮「替换正文」');
          H.click(primary as Element);
          ok(
            await H.until(
              () => H.textsOf(document.body, '.kbw-notice').some((t) => t.includes('美化没走完')),
              2000,
            ),
            '失败**明说**（弹「美化没走完」，不是静默）',
          );
        } finally {
          (app.vault as { process: unknown }).process = orig;
        }
        eq(H.readNote(vaultRoot, rel).includes('旧的正文'), true, '正文一个字节没动（写盘没发生）');
        eq(hasUndoBar(), false, '没出撤销条');
      } finally {
        await cleanup();
      }
    });

    await suite.it('真链路：经纬AI › 自动命名 → 标题面板只服务这一篇（**不是「未命名」也照样给**）', async () => {
      H.resetAi();
      H.stubAi({
        raw: JSON.stringify({
          reply: '给了两个候选',
          // ⚠️ `path` 是**相对库根**的口径（提示词里候选清单就是这个口径）——
          // 写成库内绝对路径会被当幻觉路径丢掉（`proposeTitles` 的 known 表只认 rel）
          titles: [{ path: '00_Inbox/__p6d命名.md', options: ['周会纪要', '例会要点'] }],
        }),
      });
      await H.configAi(plugin);
      ctx().ai.transport = ctx().ai.http;
      const rel = `${KB}/00_Inbox/__p6d命名.md`;
      H.writeNote(vaultRoot, rel, '---\n类型: 笔记\n---\n\n这是关于周会纪要的内容。\n');
      app.vault.rescan();
      await H.settleIndex(app);
      ctx().index.rebuild();
      await H.settleIndex(app);
      const cleanup = async (): Promise<void> => {
        // 关掉标题面板（取最上面那枚模态的头部关闭钮）
        const top = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
        const x = top ? H.qa<HTMLElement>(top, '.kbw-modal-head button')[0] : null;
        if (x) {
          H.click(x);
          await H.settle(120);
        }
        if (H.exists(vaultRoot, rel)) fs.rmSync(path.join(vaultRoot, rel), { force: true });
        app.vault.rescan();
        await H.settleIndex(app);
        ctx().index.rebuild();
        await H.settleIndex(app);
        await ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: '' } });
        H.resetAi();
      };
      try {
        const target = H.fileAt(app, rel);
        const got = collectMenu((menu) => {
          app.workspace.trigger('editor-menu', menu, {} as never, { file: target } as never);
        });
        const ai = got.tops.find((t) => t.title === '经纬AI');
        const nItem = (ai as FakeItem)?.sub?.items.find((i) => i.title === '自动命名');
        ok(nItem, '找得到「自动命名」');
        (nItem as FakeItem).run();
        const opened = await H.until(
          () => H.maybe<HTMLElement>(document.body, '.kbw-modal') != null,
          1600,
        );
        ok(opened, '标题面板开出来了');
        const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
        const rows = H.qa<HTMLElement>(modal, '.kbw-title-row');
        eq(rows.length, 1, '只服务这一篇（不是全库的「未命名」清单）');
        contains(H.textOf(rows[0]), '__p6d命名', '行就是右键那一篇（标题不是占位符也照样给）');
        // AI 候选回来了（开面板即出计划；桩是同步回话）
        eq(
          await H.until(() => H.textOf(modal).includes('周会纪要'), 1600),
          true,
          'AI 候选落在卡上（A/B 选项）',
        );
      } finally {
        await cleanup();
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P6 段⑥ · 语义色收口', async () => {
    await suite.it('徽标不再是「反色文字压满底」：淡底 + 常态色文字 + 色点', () => {
      const css = fs.readFileSync(path.join(H.repoRoot(), 'styles', 'components.css'), 'utf8');
      const body = extractRule(css, '.kbw-flag {');
      ok(body, '找得到 .kbw-flag 规则');
      eq(/color:\s*var\(--text-on-accent/.test(body as string), false, '不再用反色文字（白/黑压满底）');
      eq(/background:\s*var\(--color-/.test(body as string), false, '底色不再是语义色的满色');
      ok(/color-mix\(in srgb, var\(--flag-color/.test(body as string), '底色走 16% 的淡 mix');
      ok(/color:\s*var\(--text-normal\)/.test(body as string), '文字用常态色（两个主题都自动达标）');
      ok(
        /\.kbw-flag\.flag-red\s*\{\s*--flag-color:\s*var\(--color-red\)/.test(css),
        '红档给了 --flag-color（不然全走兜底的 --text-faint）',
      );
    });

    await suite.it('全仓库只有一处定义 `.kbw-flag` —— 同权重谁赢看源码顺序', () => {
      /**
       * 🔴 这条**真抓到过问题**：`styles/settings.css` 里原先还留着一条
       * `.kbw-flag.flag-green { color: var(--text-on-accent) … }`，而它在 `STYLE_ORDER`
       * 里排在 `components.css` **之后** → 新样式被它**悄悄盖掉**，界面上看着像
       * "绿的那一档没生效"。改共用组件前先搜一遍有没有第二处。
       */
      const dir = path.join(H.repoRoot(), 'styles');
      const hits: string[] = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.css')) continue;
        // 剥注释再搜（本项目栽过：注释里写着的词会被判成"代码里有"）
        const code = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/\.kbw-flag\s*\{/.test(code) || /\.kbw-flag\.flag-/.test(code)) {
          if (f !== 'components.css') hits.push(f);
        }
      }
      eq(hits.join(','), '', '除了 components.css，别处不许再定义 .kbw-flag');
    });

    /**
     * ⚠️ **色点本身 <3:1 是「有意保留、明说」项**（P7.7c · 10.5 判据里记的档）：
     * 黄色色点要够 3:1 就得暗到不像黄色，是色相本身的性质 —— 意义由文字
     * （≥4.5:1）与 `title` 承担，这里**只钉文字那一半**，色点不断言达标（不修）。
     */
    await suite.it('「有字就有点，没字只有色」：日志徽标带 has-label，表格标记列不带', async () => {
      /**
       * 表格「标记」列那一格。
       *
       * ⚠️ **两件事都要从数据里来**（CLAUDE.md：夹具一换写死的断言就假红）：
       * ① 哪一篇有标记；② **它所在的目录** —— 列表只画**当前目录**，
       * 而"当前目录"是前一条用例留下来的一次视野状态。第一版就是只对了①，
       * 于是在一个没有带标记笔记的目录里量到 0 个徽标（假红）。
       * 库里真的一篇都没有时才降级，而且**说出来**（不静默跳过）。
       */
      const withFlag = ctx().index.getAll().filter((e) => e.flags.length > 0 && !e.isTemplate);
      /**
       * 🔴 **空集要判失败，不许静默通过**（独立审查 B-11）：第一版这里只 `console.log`
       * 一句"这一条没验成"，然后**照样算通过** —— 那是"看着在测、其实没测"
       * （与探针里那条"静默跳过"同一个形态）。夹具（`BASE_KB`）里恒有带标记的笔记，
       * 真到一篇都没有那天，这条**应该红**，逼人来看一眼。
       */
      ok(withFlag.length > 0, '库里得有带健康标记的笔记（否则标记列无从量起）');
      {
        /**
         * 挑一篇**目录是顶层**的（树里点得到它），点进去，然后**按路径认那一行**。
         * ⚠️ 认行、不认"列表里有没有徽标" —— 后者取决于"当前目录是谁"（前一条用例
         * 留下的一次视野状态），第一版就是这么在别的目录里量到 0 个而假红的。
         */
        const pick = withFlag.find((e) => !e.effectivePosition.includes('/')) ?? withFlag[0];
        await navTo('全部笔记');
        await H.clickTreeNode(pick.effectivePosition);
        await H.settle(240);
        const row = H.maybe<HTMLElement>(
          document.body,
          `.kbw-trow[data-path="${pick.path}"]`,
        );
        if (!row) {
          ok(false, `点进「${pick.effectivePosition}」之后没画出 ${pick.path} 那一行（夹具形态变了？）`);
        } else {
          const pills = H.qa<HTMLElement>(row, '.kbw-flagcell .kbw-flag');
          ok(pills.length > 0, `那一篇（${pick.flags.join('/')}）在标记列里有 ${pills.length} 个徽标`);
          eq(
            pills.every((p) => !p.classList.contains('has-label')),
            true,
            '标记列的徽标**不带**色点（那一列按短词排的宽，加点每枚再吃 10px，理由在 components.css）',
          );
        }
      }

      // 日志行那一份：**直接渲染**，不走设置面板的导航（少一层壳，判据落在同一个类上）
      ctx().openWorkbenchSettings();
      await H.settle(240);
      const modal = H.q<HTMLElement>(document.body, '.kbw-modal');
      /**
       * ⚠️ P6 第八段把八栏收成了六栏：日志那一块现在住在**「数据」栏**里
       *（快照 + 日志 = 同一件事的两头）。找栏名要认宿主栏，进栏之后那一块自己就在
       *（`compose()` 把它的标题降级成小节标题）。
       */
      const tab = H.qa<HTMLElement>(modal, '.kbw-set-tab').find((t) => H.textOf(t).includes('数据'));
      ok(tab, '设置面板里有「数据」栏（日志那一块住在里面）');
      H.click(tab as Element);
      await H.settle(400);
      contains(H.textOf(H.q<HTMLElement>(document.body, '.kbw-set-body')), '日志', '日志那一块在');
      const busy = H.qa<HTMLElement>(document.body, '.kbw-set-body .kbw-flag');
      if (busy.length === 0) {
        ok(false, '日志栏里一个徽标都没有（色点那半边就没验成 —— 那正是本轮改的东西）');
      } else {
        eq(
          busy.every((p) => p.classList.contains('has-label')),
          true,
          '日志行的徽标**带**色点（那里有文字、放得下）',
        );
      }
      closeAllMenus();
      const close = H.qa<HTMLElement>(document.body, '.kbw-modal button').find((b) =>
        H.textOf(b).includes('关闭'),
      );
      if (close) H.click(close);
      await H.settle(180);
    });
  });
}

/**
 * 从 CSS 文本里抠出某条规则的规则体（`sel {` 之后到配对的 `}`）。
 *
 * 🔴 **先剥注释再找**（独立审查 B-2 用突变实证）：第一版在**原文**上 `indexOf`，
 * 于是在真规则**之前**插一段注释、注释里"写着"那一组好声明、真规则改回坏样式 ——
 * **判据照样全绿**（`indexOf` 命中了注释里的那个子串）。
 * 本项目对这条有现成纪律（redline 那批静态断言一律 `strip()`）—— 这里漏了。
 * ⚠️ **别改成"取最后一条匹配"**：`components.css` 里还有
 * `body.is-mobile .kbw-flag {` 同样含 `.kbw-flag {` 这个子串（那是**另一条**规则，
 * 它后面还有别的规则体），取最后一条同样会取错。
 */
function extractRule(css: string, selector: string): string | null {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = code.indexOf(selector);
  if (i < 0) return null;
  const j = code.indexOf('{', i);
  const k = code.indexOf('}', j);
  if (j < 0 || k < 0) return null;
  return code.slice(j, k);
}

interface FakeItem {
  title: string;
  run: () => void;
  sub: FakeMenu | null;
  /** 挂的段（`setSection`）——R8 起要断言"放到「插入」之下"（`insert` 是 asar 取证的段名） */
  section: string;
}
interface FakeMenu {
  addItem(cb: (i: unknown) => void): FakeMenu;
  items: FakeItem[];
}

/**
 * 一个**形状最小**的假菜单：只实现被测代码真的会调的那几个方法
 * （多实现的那些是"给自己答案打分"）。
 *
 * ⚠️ 桩里没有 `Menu`（`tests/stub` 不导出它 —— 所以 `ui/editor-menu.ts` 那边也只做类型 import）。
 * 菜单的形状靠 `setSubmenu` 撑着，而**它在公开类型定义里没有、是 asar 取证的**
 * （取证全文在 `src/ui/editor-menu.ts` 头注）。
 */
function makeMenu(): FakeMenu {
  const menu: FakeMenu = {
    items: [],
    addItem(cb: (i: unknown) => void) {
      const rec: FakeItem = { title: '', run: () => undefined, sub: null, section: '' };
      const handle = {
        setTitle: (t: string) => {
          rec.title = t;
          return handle;
        },
        setIcon: () => handle,
        setSection: (s: string) => {
          rec.section = s;
          return handle;
        },
        onClick: (fn: () => void) => {
          rec.run = fn;
          return handle;
        },
        setSubmenu: () => {
          rec.sub = makeMenu();
          return rec.sub;
        },
      };
      cb(handle);
      menu.items.push(rec);
      return menu;
    },
  };
  return menu;
}

/**
 * 触发一次 `editor-menu`，把"我们加了什么"摘出来：**顶层项** + 第一项的子菜单项。
 * 两样都要 —— 只摘子菜单的话，"我们往一级铺了五项"这种退化会**看不出来**。
 */
function collectMenu(fire: (menu: FakeMenu) => void): {
  top: string[];
  items: FakeItem[];
  /** 顶层项本体（含段名与子菜单）——R8 起两个子菜单都要摘，`top/items` 只覆盖第一项 */
  tops: FakeItem[];
} {
  const root = makeMenu();
  fire(root);
  return {
    top: root.items.map((i) => i.title),
    items: root.items[0]?.sub?.items ?? [],
    tops: root.items,
  };
}
