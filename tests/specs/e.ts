/**
 * spec：P4.5 · e 期 —— 分屏(§3.3) / 预览窗格 Peek(§3.2) / 视图记忆(§4.4)
 *
 * 对应「看板优化方案.md §6.15 开工口径」里那七条拍板 + 三条自定口径。
 *
 * 三层（与前几期同一套）：
 *   A. **纯函数**：滚动快照的捕获/写回/一次性语义 · `normalizePeek` 收脏值 · 分屏的参数
 *   B. **真链路**：切模块再回来位置还在（notes / board）· 窗格开合与互斥 · 配置驱动
 *   C. **红线**（`tests/specs/redline.ts`）：单一出处、不许成环、"写完清表"
 *
 * 🔴 **本 spec 有一条已知的"离线只能验到这里"边界**：
 * 桩里**没有多视图**（`getLeaf` 一律造一个叶、`ctx.dock` 也就一个口子）——
 * 所以"分屏之后工作台仍然只有一份""两个工作台标签"这类判据**离线一律不验**，
 * 交给真机探针（口径写在开工提示词里：别在桩里模拟多视图然后当证据）。
 * 这里能验的是"**传下去的参数对不对**"（`__leafCalls`）——真机语义由 asar 取证守着。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import { normalizeView } from '../../src/modules/board/config';
import { defaultPeek, normalizePeek, withPeekSide, DOCK_MAX_BOTTOM, DOCK_MAX } from '../../src/ui/dock';
import {
  SCROLL_ATTR,
  applyScroll,
  captureScroll,
  clearViewMemory,
  hasPendingScroll,
  loadMemo,
  recallScroll,
  rememberScroll,
  saveMemo,
} from '../../src/core/view-memory';
import { peekIsOpen, peekPath } from '../../src/modules/board/peek';
import { closeCardPanel } from '../../src/modules/board/editor';
import { __resetNotices } from '../../src/ui/notify';
import { NotesOps } from '../../src/modules/notes/ops';

const KB = '01_新知识库';
const BOARD_CFG = `${KB}/99_Meta/06_工作台/看板配置.json`;

export async function specE(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 导航到某一屏（点导航项 = 真路径） */
  async function navTo(label: string): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes(label),
    );
    ok(nav, `导航里有「${label}」`);
    H.click(nav as Element);
    await H.settle(160);
  }
  const scrollOf = (sel: string): number =>
    H.maybe<HTMLElement>(document.body, sel)?.scrollTop ?? -1;

  /** 写看板配置（走文件 + modify 事件 = 真链路，与 board spec 同一招） */
  async function writeBoardCfg(data: unknown): Promise<void> {
    H.writeNote(vaultRoot, BOARD_CFG, `${JSON.stringify(data, null, 2)}\n`);
    app.vault.rescan();
    const f = app.vault.getAbstractFileByPath(BOARD_CFG);
    app.vault.trigger('modify', f);
    await H.settle(320);
  }
  /** jsdom 量不到布局（`clientWidth` 恒 0）→ 覆盖属性再触发一次 ResizeObserver 回调 */
  function setBox(w: number, h: number): void {
    const r = H.q(document.body, '.kbw-root');
    Object.defineProperty(r, 'clientWidth', { value: w, configurable: true });
    Object.defineProperty(r, 'clientHeight', { value: h, configurable: true });
    H.triggerResize();
  }
  const ONE_SECTION = [{ id: 'e1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
  /**
   * **两份窗格尺寸刻意不同**（预览 380 / 面板 420）：互斥那几条要判"窗格此刻归谁"，
   * 而判据只能看窗格宽度 —— 两份一样宽的话，那条断言**认不出归属**（恒真）。
   * 这是独立审查抓出来的一处假绿（三处配置里两份都是 380）。
   */
  const PEEK_BOX = { where: 'right' as const, size: 380 };
  const DOCK_W = 420;
  /** 两个板块 = **两列**：「每一列各自滚」那条要有第二列才验得出来（见那条用例的注释） */
  const TWO_SECTIONS = [...ONE_SECTION, { id: 'e2', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务' }];
  const cfgOf = (extra: Record<string, unknown>, sections: unknown[] = ONE_SECTION): unknown => ({
    version: 1,
    view: { cardMode: 'content', ...extra },
    sections,
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e · 视图记忆（§4.4）· 纯函数', async () => {
    /** 造一个带几个 `data-scroll` 容器的宿主 */
    function hostWith(keys: string[]): HTMLElement {
      const root = document.createElement('div');
      for (const k of keys) {
        const d = document.createElement('div');
        d.setAttribute(SCROLL_ATTR, k);
        root.appendChild(d);
      }
      return root;
    }

    await suite.it('捕获 / 写回：往返一致，且**包括 0**（"滚回顶"也是一个要记住的位置）', () => {
      const a = hostWith(['list', 'tree', 'other']);
      const kids = Array.from(a.children) as HTMLElement[];
      kids[0].scrollTop = 137;
      kids[1].scrollLeft = 12;
      kids[2].scrollTop = 0;
      const snap = captureScroll(a);
      eq(Object.keys(snap).length, 3, '三个容器都收下了（**含那个 0**）');
      eq(snap.list.top, 137, 'list.top');
      eq(snap.tree.left, 12, 'tree.left');

      const b = hostWith(['list', 'tree', 'other']);
      const n = applyScroll(b, snap);
      eq(n, 3, '写了 3 个');
      eq((b.children[0] as HTMLElement).scrollTop, 137, 'list 写回去了');
      eq((b.children[1] as HTMLElement).scrollLeft, 12, 'tree 写回去了');
      eq((b.children[2] as HTMLElement).scrollTop, 0, '那个 0 也照写（不是"跳过 0"）');
    });

    await suite.it('写回的两个退化分支：没快照 → 0；DOM 认不出的键 → 安静跳过（不报错）', () => {
      const b = hostWith(['list']);
      eq(applyScroll(b, null), 0, '没有快照 → 什么都没写');
      eq(applyScroll(b, { 别的键: { top: 99, left: 0 } }), 0, '键对不上 → 写 0 个、也不抛');
      eq((b.children[0] as HTMLElement).scrollTop, 0, '没被塞进别的键的值');
    });

    await suite.it('`rememberScroll` 两条守卫：捕获为空**不覆盖** · 多次捕获**合并**', () => {
      clearViewMemory();
      // ① 正常的第一次
      const board = hostWith(['board', 'modhost']);
      (board.children[0] as HTMLElement).scrollTop = 120;
      rememberScroll('board', board);
      ok(hasPendingScroll('board'), '记下了');

      // ② 换成"一个可滚容器都没有"的宿主（= 骨架屏 / 降级态）→ **什么都不该做**
      rememberScroll('board', document.createElement('div'));
      const afterEmpty = recallScroll('board', hostWith(['board']));
      eq(afterEmpty, 1, '空捕获没有把上一次记的冲掉（这条链还是认得出来）');

      // ③ 合并：第二次只长出了 modhost（值 0），board 那个 120 要留着
      const again = hostWith(['board', 'modhost']);
      (again.children[0] as HTMLElement).scrollTop = 120;
      rememberScroll('board', again);
      const onlyModhost = hostWith(['modhost']);
      rememberScroll('board', onlyModhost);
      const target = hostWith(['board']);
      eq(recallScroll('board', target), 1, 'board 那条还在（合并而不是替换）');
      eq((target.children[0] as HTMLElement).scrollTop, 120, '值还是 120 —— 被 `{modhost:0}` 挤掉就会变成 0');
    });

    await suite.it('`recallScroll` **一次性**：第二次调用什么都不写（否则重绘会把人拽回上一次的位置）', () => {
      clearViewMemory();
      const src = hostWith(['list']);
      (src.children[0] as HTMLElement).scrollTop = 88;
      rememberScroll('notes', src);
      const first = hostWith(['list']);
      eq(recallScroll('notes', first), 1, '第一次写回');
      eq((first.children[0] as HTMLElement).scrollTop, 88, '值对');

      const second = hostWith(['list']);
      eq(recallScroll('notes', second), 0, '第二次是空操作');
      eq(hasPendingScroll('notes'), false, '取走即删');

      // 再演示一次"为什么":取走之后重绘不该把人拽回去
      eq(applyScroll(second, null), 0, '（重绘路径拿到的是 null，不写）');
    });

    await suite.it('模块自己的备忘（光标 / 展开态）：`loadMemo` 不消费、`clearViewMemory` 清干净', () => {
      clearViewMemory();
      eq(loadMemo('board'), null, '一开始没有');
      saveMemo('board', { cursor: 'a.md', expanded: ['a.md'] });
      eq((loadMemo<{ cursor: string }>('board') as { cursor: string }).cursor, 'a.md', '读得到');
      eq(loadMemo('board') != null, true, '**不消费**（读几次都一样 —— 它是"上次的样子"）');
      clearViewMemory();
      eq(loadMemo('board'), null, '清表之后没了（插件卸载那条路要的就是这个）');
    });

    await suite.it('`normalizePeek` 收脏值：没有"不停靠"这一档，认不出的边回默认（右）', () => {
      eq(JSON.stringify(normalizePeek(null)), JSON.stringify(defaultPeek()), '空 → 默认');
      eq(normalizePeek({ where: '看不懂', size: 380 }).where, 'right', '认不出的边 → 默认右边（**不是 null**）');
      eq(normalizePeek({ where: null }).where, 'right', '显式 null 也一样 —— Peek 只有窗格形态');
      eq(normalizePeek({ where: 'left', size: 9999 }).size, DOCK_MAX, '尺寸夹到上限');
      eq(normalizePeek({ where: 'bottom', size: 9999 }).size, DOCK_MAX_BOTTOM, '底部的上限另算');
      eq(withPeekSide({ where: 'right', size: 520 }, 'bottom').size, 520, '换边**沿用**尺寸（不重置成默认）');
      eq(withPeekSide({ where: 'right', size: 999 }, 'right').size, DOCK_MAX, '换边照样夹一次');
    });

    await suite.it('`normalizeView`：老配置（没有 peek 那两个键）读得出默认、开着时读得进来', () => {
      const old = normalizeView({ cardWidth: 240 });
      eq(old.peekEnabled, false, '老配置 → **默认关**（拍板 Q2 原话："要，默认关"）');
      eq(old.peek.where, 'right', '落点默认右边');
      const on = normalizeView({ peekEnabled: true, peek: { where: 'bottom', size: 300 } });
      eq(on.peekEnabled, true, '开着读得进来');
      eq(on.peek.where, 'bottom', '换的边也读进来了');
      eq(on.peek.size, 300, '尺寸也读进来了');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e · 视图记忆 · 真链路（切走再回来）', async () => {
    await suite.it('全部笔记：切到看板再回来，**列表与目录树**的滚动位置都还在', async () => {
      clearViewMemory();
      await navTo('全部笔记');
      const list = H.q<HTMLElement>(document.body, '.kbw-notes-list');
      const tree = H.q<HTMLElement>(document.body, '.kbw-tree-body');
      list.scrollTop = 137;
      tree.scrollTop = 42;
      eq(list.scrollTop, 137, '（前提）jsdom 保住了我们设的值');

      await navTo('看板'); // 切走：这一下捕获
      eq(scrollOf('.kbw-notes-list'), -1, '（前提）笔记那一屏已经被拆掉了');
      await navTo('全部笔记'); // 切回：画完写回
      eq(scrollOf('.kbw-notes-list'), 137, '列表位置回来了');
      eq(scrollOf('.kbw-tree-body'), 42, '目录树位置也回来了 —— **多层滚动容器都要记**');
    });

    await suite.it('看板**每一列各自滚** —— 列的位置也要记，且**认得回是哪一列**', async () => {
      /**
       * 🔴 这条是**真机实测补出来的**（探针第一轮）：列形态下每列自己滚
       *（`styles/board.css` 的 `> .kbw-cards { overflow-y: auto }`），
       * 而真机上那个实验库里**唯一**有滚余量的容器就是列 —— 只记 `.kbw-board-body` 的话，
       * "切走再回来还在原地"在那种库上**一次都不会生效**（探针的 info 会写着"没有可滚余量"）。
       *
       * ⚠️ **夹具必须真有 ≥2 列**（独立审查抓的假绿）：原来只用 `cfgOf({})` 那一个板块 ——
       * 实测列数 = 1，于是把键改成所有列同名（`cards:0`）这条**照样绿**，
       * 名字里写着的"每一列"根本没被验到。现在两个板块 + 键两两不同，两个方向都堵上。
       */
      clearViewMemory();
      await writeBoardCfg(cfgOf({}, TWO_SECTIONS));
      await navTo('看板');
      await H.settle(240);
      const cols = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-cards[data-scroll]');
      ok(cols().length >= 2, `夹具得真有第二列（实际 ${cols().length} 列）—— 否则这条名不副实`);
      ok(
        cols().every((c) => (c.getAttribute('data-scroll') ?? '').startsWith('cards:')),
        '键的形状是 cards:<板块 key>（回头要回到**那一列**）',
      );
      const keys = cols().map((c) => c.getAttribute('data-scroll') ?? '');
      eq(new Set(keys).size, keys.length, '每一列的键**都不一样**（都写成同一个，位置就串列了）');

      const c0 = cols()[0];
      const c1 = cols()[1];
      const key = c0.getAttribute('data-scroll') ?? '';
      c0.scrollTop = 123;
      c1.scrollTop = 45;
      eq(c0.scrollTop, 123, '（前提）设进去了两种不同的值');

      await navTo('全部笔记');
      await navTo('看板');
      await H.settle(280);
      const back = cols().find((c) => c.getAttribute('data-scroll') === key);
      ok(back, '回来之后那一列还在（键认得出来）');
      eq(back.scrollTop, 123, '**那一列**的位置回来了');
      eq(cols()[1].scrollTop, 45, '另一列回的是**它自己**那个值（没串）');
    });

    await suite.it('反向：**清掉记忆之后切回来就是顶**（证明位置是从表里来的，不是碰巧）', async () => {
      /**
       * 为什么要有这条：上面那条（位置回来）有可能"因为别的原因"绿 ——
       * 比如浏览器自己保住了滚动、或者哪儿顺手写了一次。这条把记忆**清空**再切回来，
       * 必须归零 —— 两条一起才说明"回来"这件事**真的**由那张表驱动。
       * ⚠️ 清表要掐在**捕获之后、写回之前**（先切走让它捕获，再清，再切回）。
       */
      await navTo('全部笔记');
      H.q<HTMLElement>(document.body, '.kbw-notes-list').scrollTop = 137;
      await navTo('看板'); // 这一下把 137 捕获进表
      clearViewMemory(); // 掐在这中间：表空了
      await navTo('全部笔记');
      eq(scrollOf('.kbw-notes-list'), 0, '表空了 → 回来就是顶');
    });

    await suite.it('模块内部重绘**不会**把人拽回去（重绘路径里没有第二处写回）', async () => {
      /**
       * ⚠️ **这条判据守的是"重绘路径里不许再写回一次"，不是"快照一次性"本身** ——
       * 独立审查用突变验过：把 `recallScroll` 里那句 `pendingScroll.delete(id)` 删掉
       *（真正的一次性语义破了），这条**照样绿**（能红的只有纯函数那条）。
       * 名字原先写着"快照一次性那条不变量的真链路版"，名不副实 —— 现在改成它真正守的东西。
       */
      await navTo('全部笔记');
      H.q<HTMLElement>(document.body, '.kbw-notes-list').scrollTop = 200;
      await navTo('看板');
      await navTo('全部笔记');
      eq(scrollOf('.kbw-notes-list'), 200, '先恢复到 200');
      /**
       * 用户自己滚到别处（55）→ 触发一次**模块内部**的重绘。
       * 若重绘那条路上还有第二处写回，这次会把 200 又写回来 —— 那比"重置到顶"更烦人
       *（用户刚滚到的地方被凭空拽走）。
       * ⚠️ 用"重载索引"这条真路径（它改 `rev` → 列表区域重画），不是往 store 里塞假广播：
       * 假广播会把这条判据变成"看起来在测、其实测不到"。
       */
      H.q<HTMLElement>(document.body, '.kbw-notes-list').scrollTop = 55;
      ctx().index.rebuild();
      await H.settleIndex(app, 240);
      eq(scrollOf('.kbw-notes-list'), 55, '重绘之后还是用户自己的位置');
      /**
       * ⚠️ 试过再加一段"再切走再回来"想顺手把"一次性"也钉在真链路上，**验不成**：
       * 切走那一下 `rememberScroll` 会**按当前 DOM 重新捕一遍**，表里的旧记录本来就被盖掉了 ——
       * 有没有 `pendingScroll.delete` 这句都是绿的（又是一条"看起来在测、其实测不到"）。
       * 所以"一次性"这条不变量**只有纯函数那条用例守得住**（上面那条），写清楚，
       * 别让人以为真链路这层也管它。
       */
    });

    await suite.it('看板：光标与「展开了正文的卡片」跨模块回来还在', async () => {
      clearViewMemory();
      await writeBoardCfg(cfgOf({}));
      await navTo('看板');
      const cards = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '[data-card]');
      ok(cards().length >= 1, '得有卡片');

      // 光标：按下即选中（真路径，不直接改 store）
      const card = cards()[0];
      H.pointerDown(card, { x: 30, y: 30 });
      await H.tick(10);
      H.pointerUp(card, { x: 30, y: 30, buttons: 0 });
      await H.settle(60);
      const path = card.dataset.path ?? '';
      eq(H.maybe<HTMLElement>(document.body, '[data-card].is-cursor')?.dataset.path, path, '光标在它身上');

      // 展开正文（真路径：点卡片底部那个「展开」）
      const more = H.maybe<HTMLElement>(document.body, '[data-card] .kbw-card-more');
      ok(more, '卡片上有「展开」');
      H.click(more as Element);
      await H.settle(80);
      ok(
        H.maybe(document.body, `[data-card][data-path="${path}"] .kbw-card-body.is-open`),
        '（前提）真的展开了',
      );

      await navTo('全部笔记');
      await navTo('看板');
      eq(
        H.maybe<HTMLElement>(document.body, '[data-card].is-cursor')?.dataset.path,
        path,
        '光标回来了（视图记忆记的是 store 初值，绘制路径本来就认它）',
      );
      ok(
        H.maybe(document.body, `[data-card][data-path="${path}"] .kbw-card-body.is-open`),
        '展开态也回来了',
      );
    });

    await suite.it('记忆里那条路径已经不在看板上 → **剔掉**（别一直显示一篇看不见的笔记）', async () => {
      clearViewMemory();
      // 故意记一条不存在的路径
      saveMemo('board', { cursor: `${KB}/02_Areas/内容创作/根本没有这一篇.md`, expanded: [] });
      await writeBoardCfg(cfgOf({}));
      await navTo('全部笔记');
      await navTo('看板');
      eq(
        H.maybe<HTMLElement>(document.body, '[data-card].is-cursor'),
        null,
        '失效光标被剔了（否则预览窗格会一直跟着一篇查不到的笔记）',
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e · 分屏（§3.3）', async () => {
    await suite.it('走的是 `getLeaf(\'split\', \'vertical\')` —— 参数传对了', async () => {
      const entry = ctx().index.notes()[0];
      ok(entry, '库里有笔记');
      app.__leafCalls.length = 0;
      new NotesOps(ctx(), () => undefined).open(entry, 'split');
      await H.settle(40);
      eq(app.__leafCalls.length, 1, '开了一个叶');
      eq(app.__leafCalls[0].kind, 'split', '**是分屏**，不是标签页');
      /**
       * 🔴 `'vertical'` 这个字面量是判据的一部分（不是实现细节）：
       * 平台上 `vertical` 说的是**分隔线竖直** = 左右并排、新叶落在右边（asar 取证）。
       * 谁要是照直觉把它改成 `'horizontal'`，分屏就变成"上下堆叠" —— 而离线
       * 除此之外**没有任何东西**能发现（真机探针也只看"多了一片"）。
       */
      eq(app.__leafCalls[0].direction, 'vertical', "'vertical' = 左右并排、新的在右（照直觉改会变成上下）");
    });

    await suite.it('反向：别的打开方式不会被顺手改成 split', async () => {
      const entry = ctx().index.notes()[0];
      const ops = new NotesOps(ctx(), () => undefined);
      app.__leafCalls.length = 0;
      ops.open(entry, 'newTab');
      ops.open(entry, 'current');
      await H.settle(40);
      const kinds = app.__leafCalls.map((c) => c.kind);
      eq(kinds[0], 'tab', 'newTab 走 tab');
      eq(kinds[1], false, 'current 走 getLeaf(false)（**不开新叶**，是替换当前标签）');
    });

    /**
     * ⚠️ **"菜单里有没有这一项"这条判据不在这儿**：三级菜单靠悬停飞出，而 jsdom
     * 没有悬停（项目里已有先例：逐级展开很脆）。它由 `redline.ts` 的**静态断言**钉住
     *（把 `notes/menus.ts` 读出来查那个菜单项 + 那个 `'split'`）——
     * 比"点开菜单看一眼"更不容易假绿（改了文案也不会漏）。
     */
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e · 预览窗格 Peek（§3.2）', async () => {
    const peekEl = (): HTMLElement | null => H.maybe<HTMLElement>(document.body, '.kbw-peek');
    /** 光标走到第一张卡上（按下即选中） */
    async function putCursorOnFirstCard(): Promise<string> {
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      ok(card, '有卡片');
      H.pointerDown(card, { x: 30, y: 30 });
      await H.tick(10);
      H.pointerUp(card, { x: 30, y: 30, buttons: 0 });
      await H.settle(80);
      return card.dataset.path ?? '';
    }
    const peekShownPath = (): string =>
      H.maybe<HTMLElement>(document.body, '.kbw-peek-md')?.getAttribute('data-path') ?? '';

    await suite.it('默认关：配置里没有 peekEnabled → 打开看板**没有**窗格', async () => {
      clearViewMemory();
      await closeAllMenus();
      purgeOverlays();
      await writeBoardCfg(cfgOf({}));
      await navTo('看板');
      setBox(1400, 900);
      await H.settle(120);
      eq(peekEl(), null, '默认关（Q2 拍板）');
      eq(peekIsOpen(), false, '单例也没建');
    });

    await suite.it('开着：窗格搬进 `.kbw-dock`（与停靠面板**同一个宿主**），且配置说了算', async () => {
      await writeBoardCfg(cfgOf({ peekEnabled: true, peek: PEEK_BOX }));
      await H.settle(200);
      ok(peekEl(), '窗格在');
      eq(peekIsOpen(), true, '单例建了');
      const dock = H.q(document.body, '.kbw-dock');
      eq(peekEl()?.parentElement, dock, '**搬进了停靠宿主**（不是挂在 body 上飘）');
      eq(peekEl()?.classList.contains('is-docked'), true, '浮层形态已经按停靠态分流');
      const stage = H.q(document.body, '.kbw-stage');
      eq(stage.getAttribute('data-dock'), 'right', '舞台认下了右边（= 主区让出了宽度）');
      eq(dock.style.width, '380px', '窗格宽度来自配置');
    });

    await suite.it('跟着**键盘光标**换内容（鼠标不让它动）', async () => {
      const root = H.q(document.body, '.kbw-root');
      const first = await putCursorOnFirstCard();
      await H.settle(120);
      eq(peekPath(), first, '光标那一篇 = 窗格里那一篇');
      eq(peekShownPath(), first, '渲染出来的 `<div class="kbw-peek-md" data-path>` 也指对了');

      H.keydown(root, ']'); // 下一张
      await H.settle(160);
      const second = peekPath();
      ok(second && second !== first, `] 之后窗格换了内容（${String(second).split('/').pop()}）`);
      eq(peekShownPath(), second, '渲染也跟着换了（令牌挡住了老的那一次）');
    });

    await suite.it('浮层态的面板**不占窗格** —— 点卡片看一篇，预览不该凭空消失', async () => {
      /**
       * 🔴 这条的口径是**离线用例逼出来的**（原来 `openCard` 一见 Peek 就收，
       * 太狠了）：拍板那句说的是"**同一个宿主**的两种占用，开一个收另一个"——
       * 而浮层态的面板**根本不在窗格里**（`position: fixed` 飘在 body 上），
       * 它和停靠的 Peek 物理上不冲突。一律收掉的话，
       * "Peek 开着 → 随手点一张卡看看 → 关掉"会让预览凭空没了，用户以为 Peek 坏了。
       */
      await writeBoardCfg(cfgOf({ peekEnabled: true, peek: PEEK_BOX }));
      await H.settle(300);
      ok(peekIsOpen(), '（前提）Peek 占着窗格');
      // 配置里**没有** dock → 面板只会是浮层
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'right', '（前提）窗格归预览');
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      H.realClick(card.querySelector('.kbw-card-t') as Element);
      await H.settle(260);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '编辑面板开了（浮层）');
      eq(peekIsOpen(), true, '**预览还在**（浮层面板不占窗格，谁也不用让）');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'right', '窗格还是预览的');
      closeCardPanel({ reason: 'test-close' });
      await H.settle(240);
    });

    await suite.it('互斥①：**停靠的**面板要窗格 → 预览让位（同一个宿主，开一个收另一个）', async () => {
      await writeBoardCfg(
        cfgOf({ peekEnabled: true, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(300);
      ok(peekIsOpen(), '（前提）Peek 占着窗格');
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '（前提）编辑面板没开');
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      H.realClick(card.querySelector('.kbw-card-t') as Element);
      await H.settle(320);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '编辑面板开了');
      eq(peekIsOpen(), false, '预览窗格被让出去了（面板要停靠，窗格只有一个）');
      eq(peekEl(), null, '窗格 DOM 也收了（不是留一条空走廊）');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'left', '窗格归停靠的面板');
      /**
       * ⚠️ 宽度必须是**面板那一份**，所以两份尺寸**不能相同**（独立审查抓的假绿：
       * 原来 `peek.size` 与 `dock.size` 都是 380 —— 谁的宽度都是 `'380px'`，这条断言恒真）。
       */
      eq(H.q(document.body, '.kbw-dock').style.width, `${DOCK_W}px`, '宽度是**面板**那一份');
      ok(DOCK_W !== PEEK_BOX.size, '（前提）两份尺寸本来就不同 —— 否则这条判据认不出归属');
    });

    await suite.it('互斥②：预览再开回来时，**停靠的**编辑面板让位（真链路要收到那条回调）', async () => {
      // 先确保"编辑面板正占着窗格"（上一条留下的状态）
      await writeBoardCfg(
        cfgOf({ peekEnabled: false, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(260);
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      if (!H.maybe(document.body, '.kbw-cw-panel')) {
        H.realClick(card.querySelector('.kbw-card-t') as Element);
        await H.settle(260);
      }
      ok(H.maybe(document.body, '.kbw-cw-panel'), '（前提）面板开着');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'left', '（前提）面板停靠在左边');

      /**
       * 开预览窗格 → 面板必须被收掉（`PeekDeps.onNeedWindow` 那条回调真被调到了）。
       * ⚠️ **这一份配置要连 `dock: left` 一起写着**（别只写 peek）：面板若因此先滑回浮层，
       * "让位"就退化成一件容易的事。真正的难点是**面板还停靠着的时候**让位 ——
       * 它收尾那句 `request(null)` 会把我们刚申请的窗格盖掉，所以 peek 那边必须先申请、
       * 请它让开、**再申请一次**（`applyPeekPlacement` 里那三步）。
       */
      await writeBoardCfg(
        cfgOf({ peekEnabled: true, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(320);
      eq(peekIsOpen(), true, '窗格开了');
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '编辑面板被收掉了（互斥的另一半）');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'right', '窗格归预览');
      eq(H.q(document.body, '.kbw-dock').style.width, `${PEEK_BOX.size}px`, '宽度是**预览**那一份（与面板那份不同，认得出归属）');
    });

    await suite.it('互斥③：停靠的编辑面板关了 → 窗格**自己回到预览**（配置说开着就得在）', async () => {
      /**
       * 🔴 这条是**真机探针逼出来的**（第二轮探针的 `✗ 第二次开 Peek 没开起来` 那条）：
       * 互斥只做"我要用就把别人请走"是**一半** —— 占着窗格的那个**走了之后**，
       * 配置里说该占着它的那个得能收回去。少了它，症状是
       * "边上空着一条、界面上什么都没有，而菜单里那一项还勾着"，
       * 用户得把开关点两下才回得来（而"配置说开着"这件事看起来是对的）。
       */
      // 前提：面板停靠着占住左边（Peek 关着）
      await writeBoardCfg(
        cfgOf({ peekEnabled: false, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(280);
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      if (!H.maybe(document.body, '.kbw-cw-panel')) {
        H.realClick(card.querySelector('.kbw-card-t') as Element);
        await H.settle(280);
      }
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'left', '（前提）面板停靠着');
      ok(!peekIsOpen(), '（前提）预览没开');

      // 打开预览 → 面板让位（被收掉）
      await writeBoardCfg(
        cfgOf({ peekEnabled: true, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(340);
      ok(peekIsOpen(), '（前提）预览占着窗格');
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '（前提）面板让位了');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'right', '（前提）窗格归预览');

      // 关掉预览 → 窗格该让回主区，**不留一条空走廊**
      await writeBoardCfg(
        cfgOf({ peekEnabled: false, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(320);
      eq(peekIsOpen(), false, '关掉预览 → 窗格收掉');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'none', '窗格还回给主区');

      // ★ 核心：面板停靠着、预览**开着但被挤掉**（点卡片那一下）→ 面板一关，预览要自己回来
      await writeBoardCfg(
        cfgOf({ peekEnabled: true, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(320);
      ok(peekIsOpen(), '（前提）预览占着窗格');
      H.realClick(H.qa<HTMLElement>(document.body, '[data-card]')[0].querySelector('.kbw-card-t') as Element);
      await H.settle(320);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '（前提）面板抢走了窗格');
      ok(!peekIsOpen(), '（前提）预览让位了（但配置里还开着）');

      closeCardPanel({ reason: 'test-close' });
      await H.settle(340);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '面板关掉了');
      eq(peekIsOpen(), true, '**预览自己回来了**（配置说开着就得在，不用用户点两下）');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'right', '窗格又归预览了');
      eq(H.q(document.body, '.kbw-dock').style.width, `${PEEK_BOX.size}px`, '宽度是**预览**那一份（与面板那份不同，认得出归属）');
    });

    /**
     * ════════════════════════════════════════════════════════════
     * 下面四条是**独立审查（`归档/审查报告/审查报告-P4.5-e.md`）抓出来的真缺陷**的回归判据。
     * 它们的共同点：**离线 30 条全绿、真机探针也全绿**（探针声明视口 1400×900、
     * 且从不做"开着 Peek 再挤窄拉宽"），只会在用户机器上出现 —— 所以每一条都要
     * **先能复现那个坏行为**，再钉死。
     * ════════════════════════════════════════════════════════════
     */
    await suite.it('🔴 放不下时：预览**不许以浮层的样子**飘在 body 上；拉宽之后要进窗格', async () => {
      await writeBoardCfg(cfgOf({ peekEnabled: false }));
      await H.settle(200);
      setBox(700, 900); // 700 − 640 = 60 < DOCK_MIN(240) → 放不下
      await writeBoardCfg(cfgOf({ peekEnabled: true, peek: PEEK_BOX }));
      await H.settle(300);
      const pe = peekEl();
      ok(pe, '窗格对象建出来了（配置说开着）');
      eq(pe.parentElement, H.q(document.body, '.kbw-dock'), '**它没有浮层形态**：根必须挂在停靠宿主里，不是 body 上');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'none', '（前提）容器放不下 → 窗格不生效');
      eq(H.q(document.body, '.kbw-dock').style.display, 'none', '宿主藏着 → 里面的 Peek 也就是隐形的');

      // 拉宽 → 它该**自己出现**（不用用户再点一次菜单）
      setBox(1400, 900);
      await H.settle(300);
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'right', '拉宽之后窗格生效了');
      ok(
        H.maybe(document.body, '.kbw-dock .kbw-peek'),
        '**窗格里的东西也跟上了** —— 只翻一个 data-dock 而里面是空的，就是一条"空走廊"',
      );
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-dock > *').filter(
          (k) => !k.classList.contains('kbw-dock-grip'),
        ).length === 1,
        '宿主里**只有一个占用者**（多个根挤在一起谁被裁掉全看 append 顺序）',
      );
    });

    await suite.it('🔴 浮层态的面板**不许被拽进窗格**（挤窄再拉宽只是改变"放不放得下"）', async () => {
      /**
       * 审查实测：面板的 `dockPort.onChange` 原先只问 `applied`、**不问配置** ——
       * 于是"挤窄再拉宽"会把一个**浮层态**的面板搬进窗格，还把预览的窗格挤掉。
       * 症状是"我把窗口拉宽了一下，浮着的编辑面板不见了"。
       */
      await writeBoardCfg(cfgOf({ peekEnabled: true, peek: PEEK_BOX }, TWO_SECTIONS));
      await H.settle(260);
      setBox(1400, 900);
      await H.settle(120);
      ok(peekIsOpen(), '（前提）预览占着窗格');
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      H.realClick(card.querySelector('.kbw-card-t') as Element);
      await H.settle(280);
      const panel = H.maybe<HTMLElement>(document.body, '.kbw-cw-panel');
      ok(panel, '（前提）编辑面板开着（浮层 —— 配置里没有 dock）');
      ok(!panel.parentElement?.classList.contains('kbw-dock'), '（前提）它是浮层，不在窗格里');
      eq(peekIsOpen(), true, '（前提）浮层面板不占窗格，预览还在');

      setBox(700, 900);
      await H.settle(200);
      setBox(1400, 900);
      await H.settle(300);
      const panel2 = H.maybe<HTMLElement>(document.body, '.kbw-cw-panel');
      ok(panel2, '面板还活着');
      ok(
        !panel2.parentElement?.classList.contains('kbw-dock'),
        '**面板仍在浮层**（配置里没说停靠，就永远不该被搬进窗格）',
      );
      eq(peekIsOpen(), true, '预览也还在占着窗格（没被"浮层变停靠"挤掉）');
    });

    await suite.it('🔴 菜单把面板改成停靠 → 两个占用者**不许同时挂在窗格里**（预览让位）', async () => {
      /**
       * 审查实测：这一条是纯用户操作（面板**钉住** → 空白处右键 →「停靠面板 → 停靠到左侧」），
       * 而模块的 `syncPeek` 只管"预览该不该在"、面板那边也不问预览 ——
       * 谁赢取决于**订阅顺序**（注册顺序，与用户意图无关）。
       * 症状是两个根同时挂在同一窗格里、两个占用者都以为自己占着。
       */
      await writeBoardCfg(cfgOf({ peekEnabled: true, peek: PEEK_BOX, panelPinned: true }));
      await H.settle(260);
      setBox(1400, 900);
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      H.realClick(card.querySelector('.kbw-card-t') as Element);
      await H.settle(280);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '（前提）面板开着（浮层 + 钉住）');
      ok(peekIsOpen(), '（前提）预览也占着窗格（浮层面板不冲突）');

      // 「停靠到左边」= 写配置（与菜单那条路同源）
      await writeBoardCfg(
        cfgOf({ peekEnabled: true, peek: PEEK_BOX, panelPinned: true, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(340);
      const dock = H.q(document.body, '.kbw-dock');
      const occupants = H.qa<HTMLElement>(document.body, '.kbw-dock > *').filter(
        (k) => !k.classList.contains('kbw-dock-grip'),
      );
      eq(occupants.length, 1, `窗格里**只有一个**占用者（实际 ${occupants.length} 个）`);
      eq(peekIsOpen(), false, '预览让位了（面板要停靠）');
      ok(H.maybe(document.body, '.kbw-cw-panel'), '面板还在（它是被"停靠"了，不是被关掉）');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'left', '窗格归面板');
      eq(dock.style.width, `${DOCK_W}px`, '宽度是面板那一份');
    });

    await suite.it('🟡 让位那一下**不许弹假的**「预览窗格现在放不下」', async () => {
      /**
       * 审查实测：容器 1400px 宽（明明放得下），让位流程里 `request(null)` 会把
       * `applied` 翻成 false，于是"我要用窗格"的正常动作被当成"放不下"，弹一条假通知。
       * 判据：**清空通知之后**走一遍"面板停靠 → 开预览 → 面板让位"，一条都不该有。
       */
      __resetNotices();
      await writeBoardCfg(
        cfgOf({ peekEnabled: false, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(280);
      setBox(1400, 900);
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      if (!H.maybe(document.body, '.kbw-cw-panel')) {
        H.realClick(card.querySelector('.kbw-card-t') as Element);
        await H.settle(280);
      }
      __resetNotices();
      await writeBoardCfg(
        cfgOf({ peekEnabled: true, peek: PEEK_BOX, dock: { where: 'left', size: DOCK_W } }),
      );
      await H.settle(340);
      ok(peekIsOpen(), '（前提）预览拿到窗格了（说明容器放得下）');
      const said = H.textsOf(document.body, '.kbw-notice').join('｜');
      eq(said, '', `放得下就不该有"放不下"的通知（实际：${said}）`);
    });

    await suite.it('🟡 `board` 与 `modhost` 这两个键：**捕得到也要写得回去**', async () => {
      /**
       * 审查抓的：`applyScroll(root, …)` 用 `root.querySelectorAll` —— **root 不算自己的后代**。
       * 而看板写回时传的 root 正是 `.kbw-board-body` 自己（键 `board` 就贴在它身上）、
       * 外壳兜底时传的是 `.kbw-modhost`（键 `modhost`）→ 那两个键"捕得到、写不回去"。
       */
      clearViewMemory();
      await writeBoardCfg(cfgOf({}, TWO_SECTIONS));
      await navTo('看板');
      await H.settle(240);
      const body = H.q<HTMLElement>(document.body, '.kbw-board-body');
      body.scrollLeft = 210;
      body.scrollTop = 77;
      eq(body.scrollLeft, 210, '（前提）设进去了');
      await navTo('全部笔记');
      await navTo('看板');
      await H.settle(300);
      const back = H.q<HTMLElement>(document.body, '.kbw-board-body');
      eq(back.scrollLeft, 210, '键 `board`（**root 自己**）的横向位置回来了');
      eq(back.scrollTop, 77, '纵向也回来了');

      // home / graph 这一类"内容自然流"：滚的是外壳的 `.kbw-modhost`，模块自己够不着它
      await navTo('首页');
      await H.settle(200);
      const host = H.q<HTMLElement>(document.body, '.kbw-modhost');
      host.scrollTop = 66;
      eq(host.scrollTop, 66, '（前提）设进去了');
      await navTo('全部笔记');
      await navTo('首页');
      await H.settle(240);
      eq(
        H.q<HTMLElement>(document.body, '.kbw-modhost').scrollTop,
        66,
        '键 `modhost` 也回来了（同步画的模块靠外壳兜那一下）',
      );
      await navTo('看板'); // 收尾拨回看板（别把"停在哪一屏"漏给后面的用例）
    });

    await suite.it('🟡 浮层面板开着时**一次配置变更**不许把它关掉（`panelClaimsWindow()` 那半句）', async () => {
      // ⚠️ 上一条把页面停在「首页」了 —— 单跑时也要自己开（项目惯例）
      await navTo('看板');
      /**
       * 审查抓的零覆盖：`onNeedWindow` 里 `if (panelIsDocked())` 那半句 ——
       * 把它去掉（无条件收面板）全套用例照样绿。这里补上：**浮层**的面板开着、
       * 预览要窗格时，面板**不该被关**（它没占窗格，没理由让位）。
       */
      await writeBoardCfg(cfgOf({ peekEnabled: false, peek: PEEK_BOX, panelPinned: true }));
      await H.settle(260);
      setBox(1400, 900);
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      if (!H.maybe(document.body, '.kbw-cw-panel')) {
        H.realClick(card.querySelector('.kbw-card-t') as Element);
        await H.settle(280);
      }
      ok(H.maybe(document.body, '.kbw-cw-panel'), '（前提）浮层面板开着（钉住）');
      // 开预览 → 会走 `applyPeekPlacement` → `onNeedWindow()`
      await writeBoardCfg(
        cfgOf({ peekEnabled: true, peek: PEEK_BOX, panelPinned: true }),
      );
      await H.settle(340);
      eq(peekIsOpen(), true, '预览拿到窗格了');
      ok(
        H.maybe(document.body, '.kbw-cw-panel'),
        '**浮层面板还在**（它没占窗格，不该被预览关掉）',
      );
    });

    await suite.it('随模块走：切走时窗格让出来（**配置不删**），切回来又开', async () => {
      ok(peekIsOpen(), '（前提）窗格开着');
      await navTo('全部笔记');
      eq(peekEl(), null, '切走 → 窗格 DOM 收了');
      eq(H.q(document.body, '.kbw-dock').style.width, '', '舞台的窗格也还回去了');
      const raw = JSON.parse(H.readNote(vaultRoot, BOARD_CFG)) as {
        view: { peekEnabled?: boolean };
      };
      eq(raw.view.peekEnabled, true, '**配置没删**（那是"用户的偏好"，不是"这一刻开着"）');

      await navTo('看板');
      await H.settle(200);
      eq(peekIsOpen(), true, '切回看板自动回来');
      ok(peekEl(), '窗格真的在');
    });

    await suite.it('挤窄到放不下：**必须说出来**（它没有浮层形态，不说就是"点了没反应"）', async () => {
      ok(peekIsOpen(), '（前提）窗格开着');
      setBox(700, 900); // 700 − 640 = 60 < DOCK_MIN(240) → 放不下
      await H.settle(160);
      const notes = H.qa<HTMLElement>(document.body, '.kbw-notice');
      const said = notes.some((n) => H.textOf(n).includes('放不下'));
      ok(said, '弹了一条"放不下"的说明 —— 否则用户点了菜单、配置也写了，屏幕上什么都没发生');
      // 拉宽回来：窗格自己回来（`onChange` 那条订阅）
      setBox(1400, 900);
      await H.settle(200);
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'right', '拉宽之后窗格回来了');
    });

    await suite.it('🔁 反复停靠 ↔ 取消十次：不留下第二个占用者、也不留空走廊', async () => {
      /**
       * 从 d2 那 20 条"验过但没搬进仓库"的覆盖里**挑出来的第一条**（清单见 d2 节末尾）：
       * 它守的是"**反复进出窗格不会把状态攒脏**" —— 而 e 期恰好把这块重写了
       *（占用者身份 + 唯一落点 `applyPanelDock`），正是最该有人守着的地方。
       */
      await writeBoardCfg(cfgOf({ peekEnabled: false, peek: PEEK_BOX, panelPinned: true }));
      await H.settle(240);
      setBox(1400, 900);
      await closeCardPanel({ reason: 'test-close' });
      const card = H.qa<HTMLElement>(document.body, '[data-card]')[0];
      H.realClick(card.querySelector('.kbw-card-t') as Element);
      await H.settle(280);

      const occupants = (): number =>
        H.qa<HTMLElement>(document.body, '.kbw-dock > *').filter(
          (k) => !k.classList.contains('kbw-dock-grip'),
        ).length;
      for (let i = 0; i < 10; i += 1) {
        const on = i % 2 === 0;
        await writeBoardCfg(
          cfgOf({
            peekEnabled: false,
            peek: PEEK_BOX,
            panelPinned: true,
            dock: on ? { where: 'left', size: DOCK_W } : { where: null, size: DOCK_W },
          }),
        );
        await H.settle(200);
        const n = occupants();
        if (n > 1) {
          ok(false, `第 ${i + 1} 轮之后窗格里有 ${n} 个占用者（攒脏了）`);
        }
      }
      // 收尾：停在"停靠"那一档，接着取消，看它是不是干净地回到浮层
      await writeBoardCfg(
        cfgOf({ peekEnabled: false, peek: PEEK_BOX, panelPinned: true, dock: { where: null, size: DOCK_W } }),
      );
      await H.settle(260);
      eq(occupants(), 0, '取消停靠之后窗格是空的（**不留空走廊**）');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'none', '舞台也让回去了');
      ok(H.maybe(document.body, '.kbw-cw-panel'), '面板还在（取消停靠 = 回浮层，不是关掉）');
      await closeCardPanel({ reason: 'test-close' });
      await H.settle(200);
    });

    await suite.it('收窗格：配置不动、窗格让出来、DOM 收干净（`closePeek` 的三件事）', async () => {
      await writeBoardCfg(cfgOf({ peekEnabled: false }));
      await H.settle(240);
      eq(peekIsOpen(), false, '关掉了');
      eq(peekEl(), null, 'DOM 没了');
      eq(H.q(document.body, '.kbw-stage').getAttribute('data-dock'), 'none', '舞台让回给主区');
      // 收尾把盒子拨回去（这个视图根是全库共用的，留着 1400 会让后面的用例在"宽档"下跑）
      setBox(0, 0);
      closeAllMenus();
      purgeOverlays();
    });
  });
}
