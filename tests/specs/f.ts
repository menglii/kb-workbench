/**
 * spec：P4.5 · f 期 —— **多悬浮窗 + 六条优化**（看板最后一轮，2026-09-26）
 *
 * 这一期动的是几处**底层假设**，所以判据分得细一点：
 *  ① **面板单例 → N 个独立实例**（用户拍板）：多窗、跨窗去重、Esc/点外面只关"最近交互的那个"、
 *     停靠仍只许一扇（认领制）、`panelPaths()` 汇总所有窗；
 *  ② **档位从"看板级"变成"看板级 + 每一篇覆盖一层"**（`view.panelByPath`）：
 *     属性档 / 正文档 / 字号 / 属性正文比例，四个键都走"覆盖 → 默认"；
 *  ③ **尾链在小窗里从"看不见"变成"折起来"**：面板挂的是真编辑器，内容一个字不能改 ——
 *     所以离线只验**折叠的判据**（找行 / 找指示器），真机那一层在探针里。
 *
 * 三层（与前几期同一套）：A 纯函数 · B 真链路 · C 红线（`redline.ts`）。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import {
  PANEL_FONT_MAX,
  PANEL_FONT_MIN,
  normalizePanelByPath,
  normalizeView,
  panelContentFor,
  panelFontFor,
  panelPropsFor,
  panelRatioFor,
  withPanelPref,
} from '../../src/modules/board/config';
import {
  PANEL_FONT_DELTA,
  applyPanelFont,
  applyPanelRatio,
  findFoldIndicator,
  nextFontSize,
  platformBaseFont,
} from '../../src/modules/board/panel-ui';
import { BOARD_VIEW_DEFAULTS } from '../../src/core/config-files';
import { stripTailSection, tailHeadingLine } from '../../src/services/templates';
import {
  activePanelId,
  mergeWindowInto,
  panelCount,
  panelOfPath,
  panelPaths,
} from '../../src/modules/board/editor';
import { peekIsOpen } from '../../src/modules/board/peek';
import { MENU_TOP_COMFORT } from '../../src/ui/menu';

const KB = '01_新知识库';
const BOARD_CFG = `${KB}/99_Meta/06_工作台/看板配置.json`;
const SEC = [
  { id: 'f1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
];

export async function specF(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  async function openBoard(): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes('看板'),
    );
    ok(nav, '导航里有「看板」');
    H.click(nav as Element);
    await H.settle(160);
  }

  async function writeBoardCfg(data: unknown): Promise<void> {
    H.writeNote(vaultRoot, BOARD_CFG, `${JSON.stringify(data, null, 2)}\n`);
    app.vault.rescan();
    const f = app.vault.getAbstractFileByPath(BOARD_CFG);
    app.vault.trigger('modify', f);
    await H.settle(340);
  }

  /**
   * **假几何**（与 `e.ts` 的 `setBox` 同一招）：jsdom 里 `clientWidth` 恒 0 →
   * 外壳按 `dockFit(…, 0, 0)` 裁决成"放不下" → **停靠根本不会生效**。
   * 凡是要判"窗格归谁"的用例都得先给一个够大的容器。
   */
  function setBox(w: number, h: number): void {
    const r = H.q(document.body, '.kbw-root');
    Object.defineProperty(r, 'clientWidth', { value: w, configurable: true });
    Object.defineProperty(r, 'clientHeight', { value: h, configurable: true });
    H.triggerResize();
  }

  const cards = (): HTMLElement[] => H.qa(document.body, '[data-card]');
  const panels = (): HTMLElement[] => H.qa(document.body, '.kbw-cw-panel');
  const clickCard = (card: HTMLElement): void =>
    H.realClick(card.querySelector('.kbw-card-t') as Element);

  /** 卡片的右键菜单里找一项（真机/桩都走 contextmenu 那条路） */
  async function openCardMenu(card: HTMLElement): Promise<void> {
    card.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
    await H.settle(240);
  }
  const menuItem = (text: string): HTMLElement | undefined =>
    H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes(text));

  /** 走菜单那条真路开一扇新窗：右键卡片 → 打开 › 在新悬浮窗中打开 */
  async function openWindowViaMenu(card: HTMLElement): Promise<void> {
    await openCardMenu(card);
    const open = menuItem('打开');
    ok(open, '卡片菜单里有「打开」');
    H.realClick(open as Element);
    await H.settle(220);
    const item = menuItem('在新悬浮窗中打开');
    ok(item, '「打开 ›」里有「在新悬浮窗中打开」（只有看板给得出这一行）');
    H.realClick(item as Element);
    await H.settle(420);
  }

  /** 按一下面板（= "最近交互的那一扇"的判据靠它） */
  const touchPanel = (panel: HTMLElement): void => {
    H.pointerDown(panel, { x: 20, y: 8 });
    H.pointerUp(panel, { x: 20, y: 8, buttons: 0 });
  };

  /**
   * 关掉所有窗。
   * 🔴 **单篇的窗没有「全部关闭」**（tab 条 ≥2 篇才画）—— 只找那一个按钮的话，
   * 单篇的窗会**留到下一个用例**（真机探针也为这条栽过一次，见 `closeEditPanel` 的注释）。
   * 所以要退到面板底部的「完成」。
   */
  const closeAllPanels = async (): Promise<void> => {
    for (let guard = 0; guard < 8; guard += 1) {
      const p = panels()[0];
      if (!p) break;
      const all = H.qa<HTMLElement>(p, '.kbw-cw-tabclose-all')[0];
      if (all) H.click(all);
      else {
        const foot = H.q<HTMLElement>(p, '.kbw-panel-foot') ?? p;
        const done = H.qa<HTMLElement>(foot, '.kbw-btn').find((b) => H.textOf(b) === '完成');
        if (done) H.click(done);
        else H.keydown(document.body, 'Escape'); // 兜底：钉住/停靠之外的情况
      }
      await H.settle(300);
    }
    await H.settle(200);
  };
  const resetCfg = async (): Promise<void> => {
    await writeBoardCfg({ version: 1, view: { cardMode: 'content' }, sections: SEC });
    await H.settle(200);
  };

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 f · 小窗设置（纯函数：覆盖 → 看板默认）', async () => {
    await suite.it('`panelByPath` 的脏值逐键收掉；空壳条目不留', () => {
      const cleaned = normalizePanelByPath({
        'a.md': { props: 'all', content: 'preview', font: 18, ratio: 0.5 },
        'b.md': { props: '乱写', content: 42, font: 'x', ratio: 'y' },
        'c.md': { props: 'none', font: 999 },
        'd.md': {},
        '': { props: 'few' },
      });
      deepEq(Object.keys(cleaned).sort(), ['a.md', 'c.md'], '只留下真有覆盖的路径');
      deepEq(cleaned['a.md'], { props: 'all', content: 'preview', font: 18, ratio: 0.5 }, '四个键都收下');
      eq(cleaned['b.md'], undefined, '一个键都认不出 → 整条丢掉（不留空壳）');
      deepEq(cleaned['c.md'], { props: 'none' }, '越界字号只丢那一个键，其余保留');
    });

    await suite.it('`withPanelPref`：打补丁 / 清键 / 别的路径不动 / 原对象不改', () => {
      const view = normalizeView({
        panelByPath: { 'a.md': { props: 'all', font: 18 }, 'z.md': { content: 'none' } },
      });
      const one = withPanelPref(view, 'a.md', { font: 20, ratio: 0.3 });
      deepEq(one['a.md'], { props: 'all', font: 20, ratio: 0.3 }, '已有的键保留、新的键并进来');
      deepEq(one['z.md'], { content: 'none' }, '别的路径一个字节不动');
      const cleared = withPanelPref(view, 'a.md', { props: null, font: null });
      eq(cleared['a.md'], undefined, '两个键都清掉 → 这一条整个消失（回到跟随默认）');
      deepEq(cleared['z.md'], { content: 'none' }, '清除只作用在这一篇上');
      deepEq(view.panelByPath['a.md'], { props: 'all', font: 18 }, '原 view 没被就地改');
    });

    await suite.it('四个"生效值"函数：覆盖 → 看板默认', () => {
      const cfg = {
        view: {
          panelProps: 'few',
          panelContent: 'editor',
          panelFont: 0,
          panelPropsRatio: null,
          panelByPath: { 'a.md': { props: 'none', content: 'preview', font: 17, ratio: 0.6 } },
        },
      } as never;
      eq(panelPropsFor(cfg, 'a.md'), 'none', 'a 有覆盖：用覆盖');
      eq(panelPropsFor(cfg, 'b.md'), 'few', 'b 没覆盖：用看板默认');
      eq(panelContentFor(cfg, 'a.md'), 'preview', '正文档同理');
      eq(panelContentFor(cfg, 'b.md'), 'editor', '正文档默认');
      eq(panelFontFor(cfg, 'a.md'), 17, '字号');
      eq(panelFontFor(cfg, 'b.md'), 0, '字号默认 0 = 没设过（渲染时用 平台−1px）');
      eq(panelRatioFor(cfg, 'a.md'), 0.6, '比例');
      eq(panelRatioFor(cfg, 'b.md'), null, '比例默认 null = 自动');
    });

    await suite.it('看板默认值里这三个新键有默认（配置只加不删）', () => {
      const d = BOARD_VIEW_DEFAULTS as unknown as Record<string, unknown>;
      eq(d.panelFont, 0, '默认 0 = 没设过（C1 起"没设过"= 平台 −1px，见 defaultPanelFont）');
      eq(d.panelPropsRatio, null, '默认自动');
      deepEq(d.panelByPath, {}, '默认空表');
      const v = normalizeView({});
      eq(v.panelFont, 0, '老配置（没有这些键）读出来是默认');
      deepEq(v.panelByPath, {}, '老配置读出来是空表');
      ok(
        PANEL_FONT_MIN === 11 && PANEL_FONT_MAX === 24,
        `字号档范围 ${PANEL_FONT_MIN}–${PANEL_FONT_MAX}（改了要同步菜单与文档）`,
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 f · 面板控件（纯函数：字号 / 分隔条 / 折叠判据）', async () => {
    await suite.it('`nextFontSize`：没设过时从**默认那一档**起步，两端夹住', () => {
      /**
       * ⚠️ C1（2026-09-27）改了"没设过"的含义：不再是"跟随平台"，而是**平台 −Npx**。
       * **P6b ⑤ 把 N 从 1 改成 2**（用户第二条反馈"正文还是大了"）→ 从它往上一步 = **平台 −1**、
       * 往下一步 = **平台 −3**。
       * 拿 `platformBaseFont()` 当参照物（那是**平台**的值，不是我们算出来的）。
       */
      const base = platformBaseFont();
      eq(base, 16, '桩里读不到 `--font-text-size` → 兜底 16');
      eq(nextFontSize(0, true, PANEL_FONT_MIN, PANEL_FONT_MAX), base - 1, '默认（平台 −2）往上一步 = 平台 −1');
      eq(nextFontSize(0, false, PANEL_FONT_MIN, PANEL_FONT_MAX), base - 3, '往下 = 平台 −3');
      eq(nextFontSize(17, true, PANEL_FONT_MIN, PANEL_FONT_MAX), 18, '有值时在它自己的基础上 ±1');
      eq(nextFontSize(PANEL_FONT_MAX, true, PANEL_FONT_MIN, PANEL_FONT_MAX), PANEL_FONT_MAX, '上端夹住');
      eq(nextFontSize(PANEL_FONT_MIN, false, PANEL_FONT_MIN, PANEL_FONT_MAX), PANEL_FONT_MIN, '下端夹住');
    });

    await suite.it('`applyPanelFont`：0 = 用默认（平台 −2px）；>0 = 按它（两个变量同源）', () => {
      const page = document.createElement('div');
      applyPanelFont(page, 20);
      eq(page.style.getPropertyValue('--font-text-size'), '20px', '正文那一份（`--font-text-size`）');
      eq(page.style.getPropertyValue('--kbw-cw-scale'), String(20 / 16), '面板自己那几行那一份（比例）');
      /**
       * C1：`0` = **没设过 → 用默认**（不再是"摘掉属性跟随平台"）。
       * 两个变量仍要**同源**：少写一个就是"只有正文变小、面板那几行不变"。
       */
      applyPanelFont(page, 0);
      /** ⚠️ P6b ⑤ 起默认是 **平台 −2px**（不再写死 −1：那个数只在 `PANEL_FONT_DELTA` 一处） */
      const def = platformBaseFont() + PANEL_FONT_DELTA;
      eq(page.style.getPropertyValue('--font-text-size'), `${def}px`, '0 → 默认那一档（平台 −2px）');
      eq(
        page.style.getPropertyValue('--kbw-cw-scale'),
        String(def / platformBaseFont()),
        '两个变量同一个值算出来',
      );
    });

    await suite.it('`applyPanelRatio`：null = 回自动（摘 class 与属性）', () => {
      const page = document.createElement('div');
      applyPanelRatio(page, 0.35);
      ok(page.classList.contains('is-split'), '有比例 → 加 `is-split`（CSS 按它切高度分配）');
      eq(page.style.getPropertyValue('--kbw-cw-props-pct'), '35%', '比例落在 CSS 变量上');
      applyPanelRatio(page, null);
      ok(!page.classList.contains('is-split'), 'null = 自动 → 摘 class');
      eq(page.style.getPropertyValue('--kbw-cw-props-pct'), '', '变量也摘掉（否则下一次恢复不出来）');
    });

    await suite.it('尾链折叠的判据：`tailHeadingLine` 与 `stripTailSection` **同一份口径**', () => {
      const body = [
        '# 标题', // 0
        '正文一行', // 1
        '', // 2
        '---', // 3
        '## 关联笔记', // 4 ← 就是它
        '- 所属中心：[[x]]', // 5
        '- 返回 [[y]]', // 6
      ].join('\n');
      eq(tailHeadingLine(body), 4, '找到「关联笔记」那一行（0 基）');
      eq(tailHeadingLine('# 标题\n正文\n'), -1, '没有尾链段 → -1');
      /**
       * 🔴 两个函数必须**指向同一段**：`stripTailSection` 把标题行以及它上面那条分隔线
       * 一起切掉，所以它的切点 = 标题行再往上吞掉 `---` 与空行（这里 = 3）。
       */
      const cut = stripTailSection(body);
      /**
       * 切点是**标题行往上吞掉分隔线 + 紧邻空行** → 停在 `# 标题 / 正文一行` 之后（2 行）。
       * 这里钉的不是"3 行还是 2 行"，而是**与 `tailHeadingLine` 指的是同一段**：
       * 折叠从那一行开始、摘要停在那一行之前 —— 两边不能各说各话。
       */
      eq(cut.split('\n').length, 2, '摘要停在标题行之前（分隔线与紧邻空行一起被吞掉）');
      ok(!cut.includes('关联笔记'), '摘要里没有尾链段');
      eq(tailHeadingLine('# a\n## 我的尾巴\nx', ['## 我的尾巴']), 1, '自定义标记同样按"整行/标题文本"比');
      eq(tailHeadingLine('# a\n### 关联笔记\nx'), 1, 'ATX 标题层级不同也认（与摘要同一条规则）');
    });

    await suite.it('`findFoldIndicator`：按行文本认那一行，折叠后（带 …）还认得', () => {
      const host = document.createElement('div');
      host.innerHTML =
        '<div class="cm-line HyperMD-header HyperMD-header-1"># 标题</div>' +
        '<div class="cm-line HyperMD-header HyperMD-header-2">## 关联笔记<div class="cm-fold-indicator"></div></div>';
      const body = '# 标题\n\n## 关联笔记\n- a\n';
      const ind = findFoldIndicator(host, body, 2);
      ok(ind, '按行号拿到那一行的原文 → 找到它的折叠指示器');
      const line2 = host.querySelectorAll('.cm-line')[1];
      line2.textContent = '关联笔记…';
      // 折叠之后平台会把行文本改成「…」结尾 —— 判据不能因此认不出来（否则第二次就找不到）
      line2.appendChild(document.createElement('div')).className = 'cm-fold-indicator';
      ok(findFoldIndicator(host, body, 2), '折叠后（文本带 …）仍然认得出');
      /**
       * 🔴 **Live Preview 里标题的 `##` 不显示**（真机实测抓的）：源文那一行是
       * `## 关联笔记`，而 `.cm-line` 的文本是 `关联笔记`。两边不归一化的话**一个都对不上**
       * → 永远不会折，而离线判据（假 DOM 里灌的是带 `##` 的文本）**全绿**。
       * 下面这条就是拿 LP 的那个形态钉住它。
       */
      const host2 = document.createElement('div');
      host2.innerHTML =
        '<div class="cm-line HyperMD-header HyperMD-header-2">关联笔记<div class="cm-fold-indicator"></div></div>';
      ok(
        findFoldIndicator(host2, '# 标题\n\n## 关联笔记\n- a\n', 2),
        'LP 把 `##` 藏起来了也认得出（源文带 `##`、DOM 不带）',
      );
      eq(findFoldIndicator(host, body, 99), null, '行号越界 → null（不抛错）');
      eq(findFoldIndicator(host, '# 别的\n', 0), null, '那一行不在这段 DOM 里 → null');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 f · 多悬浮窗（真链路）', async () => {
    /**
     * 🔴 **P6b ③ 改了这条用例的口径**（用户 2026-09-27 拍板，推翻 f 期的
     * "单击进最近交互那扇 + 加一个 tab"）：现在是**一文件一扇窗** ——
     * 单击两篇 = **两扇窗**；要凑到一个窗里靠**合并**（拖头 / 「并入别的窗…」）。
     * 所以这条用例拆成两半：前半验"两篇各自一扇"（新口径），后半用**真入口合并**
     * 之后再验多篇分页那套（tab 条、`panelPaths` 汇总）不退化。
     */
    await suite.it('单击两篇 → **各自一扇窗**；合并之后合成一扇（多篇分页不退化）', async () => {
      await closeAllPanels();
      await openBoard();
      await resetCfg();
      const cs = cards();
      ok(cs.length >= 2, '至少两张卡');
      clickCard(cs[0]);
      await H.settle(300);
      eq(panelCount(), 1, '第一下 → 一扇窗');
      clickCard(cs[1]);
      await H.settle(340);
      eq(panelCount(), 2, '第二下 → **另开一扇**（一文件一扇窗）');

      // 合并：走**卡片菜单**那条非拖动等价物（WCAG 2.2 要的等价入口）
      const a = panelOfPath(cs[0].dataset.path ?? '');
      const b = panelOfPath(cs[1].dataset.path ?? '');
      ok(a != null && b != null && a !== b, '两篇各在一扇窗里');
      ok(mergeWindowInto(b as number, a as number), '把第二扇并进第一扇');
      await H.settle(200);
      eq(panelCount(), 1, '合并之后只剩一扇');
      eq(H.qa<HTMLElement>(panels()[0], '.kbw-cw-tab').length, 2, 'tab 条上有两篇');
      eq(panelPaths().length, 2, '`panelPaths()` 汇总得出来（「编辑中」标记据此亮）');
      /**
       * 实例号 = **发号器**（只增不减：占用者身份 `panel#<n>` 靠它唯一，复号会让"是不是我占着"判错）。
       * 所以这里只钉"它有号、而且和 DOM 上那个 `data-win` 是同一个" —— 别钉具体数字
       *（全量跑到这一步时前面已经开过几十扇窗了）。
       */
      ok(typeof activePanelId() === 'number', '这一扇有实例号');
      eq(String(activePanelId()), panels()[0].dataset.win, '实例号与 DOM 上的 `data-win` 同源');
      await closeAllPanels();
    });

    await suite.it('「在新悬浮窗中打开」→ 真的多一扇；两扇各一篇、互不影响', async () => {
      await closeAllPanels();
      await openBoard();
      const cs = cards();
      ok(cs.length >= 2, '至少两张卡');
      clickCard(cs[0]);
      await H.settle(300);
      eq(panelCount(), 1, '先有一扇');
      const win1 = panels()[0].dataset.win;
      await openWindowViaMenu(cs[1]);
      eq(panelCount(), 2, '**多了一扇窗**（不是往老窗里塞 tab）');
      const two = panels();
      /**
       * ⚠️ 数**页**不数 tab：1 篇时 tab 条根本不画（§4.2 的"≥2 篇才出现"）——
       * 数 `.kbw-cw-tab` 会得到 0，看着像"这篇没了"。
       */
      eq(H.qa<HTMLElement>(two[0], '.kbw-cw-page').length, 1, '第一扇还是 1 篇');
      eq(H.qa<HTMLElement>(two[1], '.kbw-cw-page').length, 1, '第二扇也是 1 篇');
      eq(panelPaths().length, 2, '两篇都在「编辑中」名单里');
      /**
       * 「最近交互的那一扇」= 刚开的那一扇。⚠️ 别比具体号（发号器只增不减，
       * 号的大小取决于前面跑过几个用例）—— 比"是不是**不是**第一扇"。
       */
      const win2 = panels()[1].dataset.win;
      ok(win2 !== win1, '两扇是两个实例（各有各的实例号）');
      eq(String(activePanelId()), win2, '刚开的那一扇 = 最近交互的那一扇');
      await closeAllPanels();
      eq(panelCount(), 0, '收干净（每一扇各自 save + detach）');
    });

    await suite.it('🔴 同一篇只许一个活叶 —— **跨窗也要去重**（点已开的那篇 = 跳过去）', async () => {
      /**
       * 口径 ②（d 期定的硬口径）在多窗之后必须仍然守：同一份文件两个活编辑器
       * = 各持一份 buffer、各自整份写回，**后写的把先写的冲掉**。
       */
      await closeAllPanels();
      await openBoard();
      const cs = cards();
      ok(cs.length >= 2, '至少两张卡');
      clickCard(cs[0]);
      await H.settle(300);
      /** ⚠️ 实例号是**只增不减的发号器**（占用者身份 `panel#<n>` 靠它唯一）—— 别假设它从 1 重来 */
      const firstWin = panels()[0].dataset.win;
      ok(firstWin, '（前提）第一扇有实例号');
      const firstPath = H.qa<HTMLElement>(panels()[0], '.kbw-cw-page')[0].dataset.path ?? '';
      ok(firstPath, '（前提）第一篇有路径');
      await openWindowViaMenu(cs[1]); // 第二扇（另一篇）
      eq(panelCount(), 2, '（前提）两扇窗');
      // 再点**第一篇**那张卡（它已经在第一扇里）→ 必须跳过去，绝不新开
      const again = cards().find((c) => c.dataset.path === firstPath);
      ok(again, '（前提）找得到第一篇那张卡');
      clickCard(again as HTMLElement);
      await H.settle(420);
      eq(panelCount(), 2, '**窗数没变**（跨窗去重）');
      /**
       * 跳到**装着这一篇的那一扇**：用 `data-win`（每扇自己带的实例号）认它 ——
       * 比"号是不是 1"稳（号只增不减），也比"第几个 DOM"稳（DOM 顺序会被提升打乱）。
       */
      const holder = panels().find((p) =>
        H.qa<HTMLElement>(p, '.kbw-cw-page').some((x) => x.dataset.path === firstPath),
      );
      ok(holder, '（判据自身的前提）找得到装着这一篇的那一扇');
      eq(String(activePanelId()), holder?.dataset.win, '跳到第一篇所在的那一扇（它成了最近交互的）');
      const pageCount = panels().reduce(
        (n, p) => n + H.qa<HTMLElement>(p, '.kbw-cw-page').length,
        0,
      );
      eq(pageCount, 2, '两扇加起来还是 2 篇（没有为同一篇多开一个编辑器）');
      await closeAllPanels();
    });

    await suite.it('Esc / 点外面只关**最近交互的那一扇**（用户拍板的口径 ④）', async () => {
      await closeAllPanels();
      await openBoard();
      const cs = cards();
      clickCard(cs[0]);
      await H.settle(300);
      await openWindowViaMenu(cs[1]);
      eq(panelCount(), 2, '（前提）两扇窗都开着');
      const [a, b] = panels();
      touchPanel(b); // 在第二扇里按一下 = 它是"最近交互的那个"
      await H.settle(140);
      H.keydown(document.body, 'Escape');
      await H.settle(360);
      eq(panelCount(), 1, 'Esc 只关掉一扇');
      ok(panels()[0] === a, '关掉的是**第二扇**（最近交互的那个），第一扇还在');

      /**
       * ⚠️ "点外面"听的是 **mousedown**（`ui/panel.ts` 的 `on(document, 'mousedown', …)`）——
       * 只派 pointerdown 是**测不出来**的（离线最容易踩的那种假绿）。
       */
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      await H.settle(360);
      eq(panelCount(), 0, '点空白 → 关掉剩下那一扇（它就是最近交互的）');
    });

    await suite.it('🔴 一扇窗被收掉之后**不再碰停靠口子**（同一次配置变更里的"先收后叫"）', async () => {
      /**
       * f 期实测抓到的真缺陷：`emit()` 是"先拷一份订阅者再逐个叫"，
       * 于是**同一次配置变更里被收掉的那扇窗**，它那条已退订的 `onCfg` 仍会被叫到一次 ——
       * 单例时代看不出问题，多窗之后它会照配置**再申请一次窗格**，把刚拿到窗格的预览顶掉
       *（症状：预览开起来、转身就被关掉，而"抢窗格"的那扇窗根本不存在）。
       * 判据：面板被 peek 挤掉之后，窗格必须归预览（而不是"谁都没占"或"面板又抢回去"）。
       */
      await closeAllPanels();
      await openBoard();
      setBox(1400, 900);
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', peekEnabled: true, peek: { where: 'right', size: 300 } },
        sections: SEC,
      });
      await H.settle(320);
      const cs = cards();
      clickCard(cs[0]);
      await H.settle(340);
      ok(panels().length > 0, '（前提）面板开着（浮层 —— 配置里没有 dock）');
      const before = panels().length;
      /** 口子的占用者变动轨迹 —— 出问题时这条是唯一能把"谁抢了谁"说清的东西 */
      const trace: string[] = [];
      const port = ctx().dock;
      const un = port?.onChange((st) => trace.push(`${st.applied ? 'on' : 'off'}:${st.owner ?? '-'}`));
      // 把面板改成"要停靠"：它申请口子 → 预览让位；紧接着再开预览 → 面板让位
      await writeBoardCfg({
        version: 1,
        view: {
          cardMode: 'content',
          peekEnabled: true,
          peek: { where: 'right', size: 300 },
          dock: { where: 'left', size: 260 },
        },
        sections: SEC,
      });
      await H.settle(420);
      /**
       * ⚠️ **别钉"谁赢"**：口径是"用户刚动的是哪个键谁赢"——
       * 这一次动的是 `dock`（面板要停靠）→ 按仲裁是**面板赢、预览让位**（e 期那条用例钉的就是它）。
       * 这里要钉的是**不变量**：宿主里**恰好一个占用者**，绝不出现"两个根挤在一起"或
       * "一条空走廊"（= 面板被收掉之后，它那条已退订的 `onCfg` 又反手把窗格申请回来）。
       */
      const occupants = H.qa<HTMLElement>(document.body, '.kbw-dock > *').filter(
        (k) => !k.classList.contains('kbw-dock-grip'),
      );
      const dockAttr = H.q(document.body, '.kbw-stage')?.getAttribute('data-dock');
      const peekOn = !!H.maybe(document.body, '.kbw-peek');
      un?.();
      eq(
        occupants.length,
        1,
        `宿主里恰好一个占用者（实际 ${occupants.length} 个；收前 ${before} 扇窗｜面板 ${panels().length}｜预览 ${peekOn}｜轨迹 ${trace.join(' ')}）`,
      );
      const mem = await (async () => {
        const raw = (await ctx().configs.read('board')) as { view: { dock?: unknown; peekEnabled?: boolean } };
        return `盘dock=${JSON.stringify(raw.view.dock)} 盘peek=${raw.view.peekEnabled}`;
      })();
      ok(
        dockAttr !== 'none',
        `窗格有主（实际 data-dock=${dockAttr}｜轨迹 ${trace.join(' ')}｜${mem}｜预览对象=${peekIsOpen()}）`,
      );
      await resetCfg();
    });

    await suite.it('每一篇的档位可以不一样（同一扇窗里两篇两个档）', async () => {
      await closeAllPanels();
      await openBoard();
      const cs = cards();
      ok(cs.length >= 2, '至少两张卡');
      clickCard(cs[0]);
      await H.settle(300);
      clickCard(cs[1]);
      await H.settle(360);
      /**
       * 🔴 P6b ③ 起单击 = **一文件一扇窗** → 想要"同一扇窗里两篇"得先**合并**
       *（拖头 / 卡片菜单「并入别的窗…」；这里走非拖动那个入口）。
       */
      const idA = panelOfPath(cs[0].dataset.path ?? '');
      const idB = panelOfPath(cs[1].dataset.path ?? '');
      ok(idA != null && idB != null && idA !== idB, '两篇先各自一扇窗');
      ok(mergeWindowInto(idB as number, idA as number), '并成一扇（两篇两页）');
      await H.settle(220);
      const pages = H.qa<HTMLElement>(panels()[0], '.kbw-cw-page');
      const paths = pages.map((x) => x.dataset.path ?? '');
      ok(paths[0] && paths[1], '两页都有路径');
      // 只给**第二篇**设"只读预览"
      const cfg = (await ctx().configs.read('board')) as { view: Record<string, unknown> };
      const next = withPanelPref(cfg.view as never, paths[1], { content: 'preview' });
      await writeBoardCfg({ ...(cfg as object), view: { ...cfg.view, panelByPath: next } });
      await H.settle(460);
      const pages2 = H.qa<HTMLElement>(panels()[0], '.kbw-cw-page');
      const second = pages2.find((x) => x.dataset.path === paths[1]) as HTMLElement;
      const first = pages2.find((x) => x.dataset.path === paths[0]) as HTMLElement;
      ok(second && first, '两页都在');
      eq(
        H.qa<HTMLElement>(second, '.kbw-cw-leaf').length,
        0,
        '第二篇换成了只读预览（真编辑器叶收掉了）',
      );
      eq(
        H.qa<HTMLElement>(first, '.kbw-cw-leaf').length,
        1,
        '**第一篇不受影响**（覆盖是按路径的，不是"全窗一刀切"）',
      );
      await closeAllPanels();
      await resetCfg();
    });

    await suite.it('改名要跟着迁 `panelByPath` 的键（表里存的是路径）', async () => {
      await closeAllPanels();
      await openBoard();
      const cs = cards();
      clickCard(cs[0]);
      await H.settle(320);
      const path0 = H.qa<HTMLElement>(panels()[0], '.kbw-cw-page')[0].dataset.path ?? '';
      ok(path0, '（前提）有路径');
      const cfg0 = (await ctx().configs.read('board')) as { view: Record<string, unknown> };
      await writeBoardCfg({
        ...(cfg0 as object),
        view: { ...cfg0.view, panelByPath: withPanelPref(cfg0.view as never, path0, { font: 19 }) },
      });
      await H.settle(400);
      const live = H.qa<HTMLElement>(panels()[0], '.kbw-cw-page')[0];
      eq(live.style.getPropertyValue('--font-text-size'), '19px', '字号落到页上了');

      // 真改名：面板头上的标题输入框 → blur 提交 → 走 mover
      const input = H.q<HTMLInputElement>(panels()[0], 'input.kbw-input');
      ok(input, '找得到标题输入框');
      const base = path0.split('/').pop() ?? '';
      input.value = base.replace(/\.md$/, '__改名');
      input.dispatchEvent(new Event('blur'));
      await H.settle(800);
      const after = (await ctx().configs.read('board')) as {
        view: { panelByPath?: Record<string, unknown> };
      };
      const keys = Object.keys(after.view.panelByPath ?? {});
      eq(keys.length, 1, `覆盖表里只有一条（实际 ${keys.length} 条）`);
      ok(keys[0].includes('__改名'), `键跟着改到新路径上了：${keys[0]}`);
      await closeAllPanels();
      await resetCfg();
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 f · 面板的其它三条（真链路）', async () => {
    await suite.it('`Ctrl+滚轮` 在面板里 = 缩这一窗的字（**不动卡片宽度**）', async () => {
      await closeAllPanels();
      await openBoard();
      await writeBoardCfg({ version: 1, view: { cardMode: 'content', cardWidth: 240 }, sections: SEC });
      await H.settle(260);
      const cs = cards();
      clickCard(cs[0]);
      await H.settle(340);
      const page0 = H.qa<HTMLElement>(panels()[0], '.kbw-cw-page')[0];
      const path0 = page0.dataset.path ?? '';
      /**
       * 🔴 **P6b ④ 起"在哪儿滚"有语义**：`Ctrl+滚轮` 只在**正文上**才缩字
       *（在面板头 / 属性区上滚 = 缩放**窗口**）。所以这一发必须打在**正文容器**上 ——
       * 打在面板根上（老写法）现在会走"缩放窗口"那条路（那是另一条判据，见 ③④ 那组）。
       */
      H.q<HTMLElement>(page0, '.kbw-cw-editor').dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 }),
      );
      await H.settle(460);
      const after = (await ctx().configs.read('board')) as {
        view: { cardWidth: number; panelByPath?: Record<string, { font?: number }> };
      };
      /**
       * ⚠️ 默认档 = **平台 −2px**（P6b ⑤ 从 −1 降了一档）→ 往上滚一步 = **平台 −1**。
       * 判据钉的是"滚轮真的把这一篇的字号写进了**这一篇**的覆盖里"，
       * 用 `PANEL_FONT_DELTA` 现算（别在用例里抄那个数）。
       */
      eq(
        after.view.panelByPath?.[path0]?.font,
        platformBaseFont() + PANEL_FONT_DELTA + 1,
        '字号写进了**这一篇**的覆盖里（默认 平台−2 → 往上一步 = 平台−1）',
      );
      eq(after.view.cardWidth, 240, '卡片宽度**一个像素没动**（两套缩放不许打架）');
      const page = H.qa<HTMLElement>(panels()[0], '.kbw-cw-page')[0];
      eq(
        page.style.getPropertyValue('--font-text-size'),
        `${platformBaseFont() + PANEL_FONT_DELTA + 1}px`,
        '页上真的生效了（与上面那个覆盖同一个值）',
      );
      await closeAllPanels();
      await resetCfg();
    });

    await suite.it('拖分隔条 → 落盘"这一篇的比例"；双击 → 回自动', async () => {
      await closeAllPanels();
      await openBoard();
      await resetCfg();
      const cs = cards();
      clickCard(cs[0]);
      await H.settle(340);
      const bar = H.q<HTMLElement>(panels()[0], '.kbw-cw-split');
      ok(bar, '面板里有分隔条');
      const page = H.q<HTMLElement>(panels()[0], '.kbw-cw-page');
      const path0 = page.dataset.path ?? '';
      /**
       * 桩里几何全是 0 → 给这一页一个**假几何**（判据只认"比例算得对 + 落盘"）。
       * 240 的值 = 120/400，正好落在允许区间里（0.15–0.85）。
       */
      (page as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
        ({ top: 0, bottom: 400, height: 400, left: 0, right: 300, width: 300 }) as DOMRect;
      H.pointerDown(bar, { x: 10, y: 5 });
      H.pointerMove(document.documentElement, { x: 10, y: 120 });
      H.pointerUp(document.documentElement, { x: 10, y: 120, buttons: 0 });
      await H.settle(420);
      const saved = (await ctx().configs.read('board')) as {
        view: { panelByPath?: Record<string, { ratio?: number }> };
      };
      const r = saved.view.panelByPath?.[path0]?.ratio ?? 0;
      ok(Math.abs(r - 0.3) < 0.05, `比例按页高算出来落盘了（实际 ${r}）`);
      ok(page.classList.contains('is-split'), '页上切到"按比例分"那一档');
      bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await H.settle(420);
      const saved2 = (await ctx().configs.read('board')) as {
        view: { panelByPath?: Record<string, { ratio?: number }> };
      };
      eq(saved2.view.panelByPath?.[path0]?.ratio, undefined, '双击 → 这一篇的覆盖清掉（回自动）');
      ok(!page.classList.contains('is-split'), '页上也回自动档');
      await closeAllPanels();
      await resetCfg();
    });

    await suite.it('标签页图标：贴得上、幂等、`svg-icon` 类不能少', async () => {
      /**
       * `getIcon()` 只能给 lucide 名（平台按名字画 SVG）→ 自造标记只能**开视图之后换掉**。
       * 真机那一层（宿主类名 / 重建时机）在探针里；离线这一层验"换得上 + 幂等 + 类名对"。
       */
      const host = document.createElement('div');
      host.innerHTML =
        '<div class="workspace-tab-header" data-type="kb-workbench-view">' +
        '<div class="workspace-tab-header-inner-icon"><svg class="svg-icon"></svg></div></div>';
      document.body.appendChild(host);
      const v = app.workspace.getLeavesOfType('kb-workbench-view')[0]?.view as unknown as {
        applyTabIcon?: () => void;
      };
      ok(typeof v?.applyTabIcon === 'function', '视图上有 `applyTabIcon`');
      v?.applyTabIcon?.();
      const iconBox = H.q<HTMLElement>(host, '.workspace-tab-header-inner-icon');
      ok(iconBox.querySelector('svg.kbw-tab-mark'), '平台画的那个 lucide 图标被换成了自己的标记');
      const first = iconBox.querySelector('svg');
      v?.applyTabIcon?.();
      ok(iconBox.querySelector('svg') === first, '幂等（贴过就不动 —— `layout-change` 会来很多次）');
      ok(
        iconBox.querySelector('svg')?.classList.contains('svg-icon'),
        '挂着平台的 `svg-icon` 类（尺寸跟着平台走，别自己写死）',
      );
      host.remove();
    });
  });

  // ════════════════════════════════════════════════════════════
  /**
   * **独立审查（`归档/审查报告/审查报告-P4.5-f.md`）抓到的真缺陷 → 每一条都留一个回归判据**。
   *
   * 这一组的存在本身就是教训：f 期原先那 20 条多窗用例**全走 `h.close()` 那条路**
   *（Esc / 点外面），于是"收尾层还留着只有一个面板的旧假设"整片漏掉 ——
   * 审查用"点按钮收尾"（完成 / 全部关闭 / 在新标签页打开 / 打开笔记）四条路各自复现了一次。
   */
  await suite.group('P4.5 f · 收尾与"最近交互"的回归判据（独立审查 🔴1/🔴2/🔴3/🔴4）', async () => {
    /** 面板底部的某个按钮（按文案找） */
    const footBtn = (panel: HTMLElement, text: string): HTMLElement | undefined =>
      H.qa<HTMLElement>(panel, '.kbw-panel-foot .kbw-btn').find((b) => H.textOf(b).includes(text));

    /**
     * 备好"两扇窗、各一篇"（甲 = 先建的）。
     * ⚠️ 先把板块配置写死（`resetCfg`）：这一组单独跑时，上一组留下的配置可能指向一个
     * 没有卡片的目录 —— 少了这句就会红在"至少两张卡"上（与它要验的东西毫无关系）。
     */
    async function twoWindows(): Promise<[HTMLElement, HTMLElement]> {
      await closeAllPanels();
      await openBoard();
      await resetCfg();
      const cs = cards();
      ok(cs.length >= 2, '至少两张卡');
      clickCard(cs[0]);
      await H.settle(320);
      await openWindowViaMenu(cs[1]);
      eq(panelCount(), 2, '（前提）两扇窗');
      return [panels()[0], panels()[1]];
    }

    await suite.it('🔴1 · 在甲窗点「完成」/「全部关闭」/「在新标签页打开」**只收甲窗**', async () => {
      // ① 「完成」（甲只有 1 篇）
      let [a] = await twoWindows();
      const done = footBtn(a, '完成');
      ok(done, '甲窗底部有「完成」');
      H.click(done as Element);
      await H.settle(500);
      eq(panelCount(), 1, '点「完成」之后只剩一扇（原先会把两扇一起收掉）');
      ok(panels()[0] !== a, '走掉的是**甲**（点的那一扇）');

      // ② 「在新标签页打开」（它会先关掉甲窗这一篇）
      [a] = await twoWindows();
      const toTab = footBtn(a, '在新标签页打开');
      ok(toTab, '甲窗底部有「在新标签页打开」');
      H.click(toTab as Element);
      await H.settle(600);
      eq(panelCount(), 1, '「在新标签页打开」也只收甲窗');

      // ③ 「全部关闭」（≥2 篇时才有那个按钮）→ 先让甲窗有 2 篇
      await closeAllPanels();
      await openBoard();
      const cs = cards();
      clickCard(cs[0]);
      await H.settle(300);
      clickCard(cs[1]);
      await H.settle(340);
      /**
       * ⚠️ P6b ③ 起单击 = **一文件一扇窗** → "甲窗 2 篇"要靠**合并**凑出来
       *（非拖动入口；「全部关闭」那个按钮本来就是 ≥2 篇才画的）。
       */
      const idA = panelOfPath(cs[0].dataset.path ?? '');
      const idB = panelOfPath(cs[1].dataset.path ?? '');
      if (idA != null && idB != null && idA !== idB) mergeWindowInto(idB, idA);
      await H.settle(220);
      await openWindowViaMenu(cards()[2] ?? cs[0]);
      eq(panelCount(), 2, '（前提）甲 2 篇 + 乙 1 篇');
      const [a2] = panels();
      const all = H.qa<HTMLElement>(a2, '.kbw-cw-tabclose-all')[0];
      ok(all, '甲窗 tab 条上有「全部关闭」');
      H.click(all);
      await H.settle(600);
      eq(panelCount(), 1, '「全部关闭」只关甲窗');
      await closeAllPanels();
      await resetCfg();
    });

    await suite.it('🔴2 · 点**先建的那一扇**再点空白：只关它（顺序不许影响判据）', async () => {
      /**
       * 根因是**监听顺序**：每扇窗的"点外面"都挂在 `document` 上、按注册顺序跑，
       * 甲先跑 → 关掉自己 → 把"最近交互"改掉 → 乙后跑时判据失效、跟着关。
       * 修法是"这一发事件该关谁"在**捕获阶段**先定下来（`outsideTarget`）。
       */
      const [a, b] = await twoWindows();
      touchPanel(a); // 甲（先建的）= 最近交互
      await H.settle(140);
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      await H.settle(400);
      eq(panelCount(), 1, '只关掉一扇（原先：先建的那扇是最近交互时**两扇全关**）');
      ok(panels()[0] === b, '留下的是**乙**（甲被关掉了）');
      await closeAllPanels();
    });

    await suite.it('🔴3 · 停靠的那一扇是"最近交互"时，**浮层那扇**点外面仍然关得掉', async () => {
      await closeAllPanels();
      await openBoard();
      setBox(1400, 900);
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', dock: { where: 'right', size: 300 } },
        sections: SEC,
      });
      await H.settle(400);
      const cs = cards();
      ok(cs.length >= 2, '至少两张卡');
      clickCard(cs[0]);
      await H.settle(400);
      ok(panels()[0].classList.contains('is-docked'), '（前提）甲照配置停靠');
      await openWindowViaMenu(cs[1]);
      eq(panelCount(), 2, '（前提）甲乙两扇');
      const docked = panels().find((x) => x.classList.contains('is-docked')) as HTMLElement;
      const floating = panels().find((x) => !x.classList.contains('is-docked')) as HTMLElement;
      ok(docked && floating, '（前提）一扇停靠、一扇浮层');
      touchPanel(docked); // 最近交互 = 停靠的那一扇
      await H.settle(140);
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      await H.settle(400);
      eq(panelCount(), 1, '浮层那扇被点外面关掉（原先两边都不关：停靠的不接、浮层的被豁免）');
      ok(panels()[0] === docked, '留下的是停靠的那一扇');
      await closeAllPanels();
      await resetCfg();
    });

    await suite.it('🔴4 · 「编辑中」标记按**所有窗的并集**算（两扇各一篇 → 两张卡都亮）', async () => {
      await twoWindows();
      const cs = cards();
      const paths = panels().map(
        (p) => H.qa<HTMLElement>(p, '.kbw-cw-page')[0]?.dataset.path ?? '',
      );
      ok(paths[0] && paths[1] && paths[0] !== paths[1], '两扇各开一篇不同的');
      await H.settle(300);
      const marked = paths.filter((path) =>
        cards().some((c) => c.dataset.path === path && c.classList.contains('is-editing-source')),
      );
      eq(marked.length, 2, `两张卡都带「编辑中」（原先只有最近动过那一扇的亮：实际 ${marked.length} 张）`);
      await closeAllPanels();
      void cs;
    });

    await suite.it('M2 · 点**先建的那一扇**再 `Esc`：关的是它（"最近交互"与"最后建的"必须分得开）', async () => {
      /**
       * 🔴 这条是审查做的突变测试捅出来的**假绿**：把 `raise()` 里"把 Esc 层挪到栈顶"
       * 整段删掉，f 期原先 20 条**全绿** —— 因为那些用例点的都是"刚建的第二扇"，
       * 而"最近交互"与"最后建的"在那种情形下**重合**（Esc 栈的默认顺序就是最后建的在上）。
       * 只有"点先建的那一扇"才验得到 `raise()` 真的做事。
       */
      const [a, b] = await twoWindows();
      touchPanel(a);
      await H.settle(160);
      H.keydown(document.body, 'Escape');
      await H.settle(400);
      eq(panelCount(), 1, 'Esc 只关一扇');
      ok(panels()[0] === b, '关掉的是**先建的那一扇**（最近交互的那个），后建的还在');
      await closeAllPanels();
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 f · 全局菜单的一级项数（硬规矩 2）', async () => {
    await suite.it('看板全局菜单：软目标内，且长菜单有分组（「重载」已收进「更多显示」）', async () => {
      /**
       * 硬规矩 2 的**2026-10-02 版**（用户拍板放宽）：数字不是判据，"一眼扫得完"才是 ——
       * 超过软目标（`MENU_TOP_COMFORT`）**要有分组**。这条读的是**弹出来的那个菜单**
       * （真链路），不是在文档里数表格；看板空白处这一级 f 期把「重载」收进「更多显示」后正好在软目标内。
       */
      await openBoard();
      const body = H.q<HTMLElement>(document.body, '.kbw-board-body');
      ok(body, '看板体在');
      body.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      );
      await H.settle(260);
      const menu = H.q<HTMLElement>(document.body, '.kbw-menu');
      ok(menu, '全局菜单弹出来了');
      const top = H.qa<HTMLElement>(menu, '.kbw-menu-item');
      const labels = top.map((i) => H.textOf(i));
      const seps = H.qa(menu, '.kbw-menu-sep').length;
      ok(
        top.length <= MENU_TOP_COMFORT || seps > 0,
        `一级 ${top.length} 项 / 分隔线 ${seps} 条（软目标 ${MENU_TOP_COMFORT}：超了就得有分组）—— 实际：${labels.join(' / ')}`,
      );
      const more = top.find((i) => H.textOf(i).includes('更多显示'));
      ok(more, '一级里有「更多显示」');
      H.realClick(more as Element);
      await H.settle(240);
      const sub = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('重载'),
      );
      ok(sub, '「重载」在「更多显示 ›」里（只是收深一层，没被删掉）');
      H.keydown(document.body, 'Escape');
      await H.settle(220);
    });
  });

  // 收尾：不留库内垃圾（后面还有别的 spec 跑同一个库）

  // ────────────────────────────────────────────────────────────
  /**
   * **P6b ③④**（用户 2026-09-27 第二轮反馈）：
   *  ③ 一文件一扇窗 · 拖到一起合并 · 可缩放 · 点到已开要强调
   *  ④ `Ctrl+Shift+滚轮` = 缩放**窗口**；`Ctrl+滚轮` 在**正文**上 = 缩**这一篇的字号**
   *
   * ⚠️ **拖拽那几条（拖头合并 / 拖 tab 拆窗）离线测不了**：它们靠
   * `document.elementsFromPoint` 判"落在哪一扇窗上"，而 **jsdom 没有命中测试**
   *（`elementFromPoint` 拿不到东西，见 `grid.ts` 顶上那条注释）。
   * 所以这里钉的是**语义**（合并 = 搬 tab + 去重 + A 关掉；缩放 = setSize 的夹取），
   * 手势本身归**真机探针**（`npm run probe` 里那几条）。
   */
  await suite.group('P6b ③④ · 一文件一扇窗 / 合并 / 缩放 / 手势分流', async () => {
    const winRoots = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-cw-panel');
    const pagesOf = (root: HTMLElement): string[] =>
      H.qa<HTMLElement>(root, '.kbw-cw-page').map((p) => p.dataset.path ?? '');
    const wheel = (el: Element, init: WheelEventInit): void => {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }));
    };

    await suite.it('③ 单击未开 = 新开一扇；单击已开 = 抬到最前 + **闪一下**（不新开）', async () => {
      await closeAllPanels();
      await openBoard();
      await resetCfg();
      const cs = cards();
      ok(cs.length >= 1, '至少一张卡');
      const path0 = cs[0].dataset.path ?? '';
      clickCard(cs[0]);
      await H.settle(320);
      eq(panelCount(), 1, '第一次单击 → 开了一扇');
      /**
       * ⚠️ 独立审查 §5.4：这里原先比**数量**（`length === 1`）—— "开成了**另一篇**的窗"
       * 照样绿。改成比**身份**（开的就是被点的那一篇）。
       */
      eq(pagesOf(winRoots()[0]).join(','), path0, '这一扇里**就是被点的那一篇**（逐路径比）');

      // 再点同一张：**不新开**，抬到最前 + 闪一下
      const again = cards().find((c) => c.dataset.path === path0);
      ok(again, '那张卡还在');
      clickCard(again as HTMLElement);
      await H.settle(220);
      eq(panelCount(), 1, '再点同一篇 → 还是那一扇（一文件一扇窗）');
      eq(pagesOf(winRoots()[0]).join(','), path0, '也没有多出一个 tab（还是那一篇）');
      ok(
        winRoots()[0].classList.contains('is-flash'),
        '点到已经开着的那一篇 → **闪一下**（`.is-flash`；动效=减少时是静态描边）',
      );
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-cw-editor .view-content').length,
        1,
        '同一篇只有一个活编辑器',
      );
      await closeAllPanels();
    });

    await suite.it('③ 合并的语义：逐篇搬进目标窗 · **同一篇去重** · 源窗关掉（不留悬挂叶）', async () => {
      await closeAllPanels();
      await openBoard();
      await resetCfg();
      const cs = cards();
      ok(cs.length >= 2, '至少两张卡');
      const p0 = cs[0].dataset.path ?? '';
      const p1 = cs[1].dataset.path ?? '';
      clickCard(cs[0]);
      await H.settle(300);
      clickCard(cs[1]);
      await H.settle(340);
      eq(panelCount(), 2, '两篇各自一扇');

      const into = panelOfPath(p0);
      const from = panelOfPath(p1);
      ok(into != null && from != null && into !== from, '两篇各在一扇窗里');
      const leavesBefore = H.qa<HTMLElement>(document.body, '.kbw-cw-leaf').length;

      ok(mergeWindowInto(from as number, into as number), '把第二扇并进第一扇');
      await H.settle(300);
      eq(panelCount(), 1, '合并之后只剩一扇');
      eq(
        pagesOf(winRoots()[0]).sort().join(','),
        [p0, p1].sort().join(','),
        '两篇都在目标窗里（逐路径比）',
      );
      eq(
        H.qa<HTMLElement>(winRoots()[0], '.kbw-cw-tab').length,
        2,
        'tab 条上有两篇（≥2 篇才画这条）',
      );
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-cw-leaf').length,
        leavesBefore,
        '叶的总数没变（搬的是同一个节点，不是重建）',
      );

      /**
       * **同一篇只留一份**（两个活编辑器 = 丢改动 —— d 期那条不变量）。
       *
       * ⚠️ 这里**验的是全局不变量**，不是"合并去重"那条分支：一文件一扇窗 + 跨窗去重
       *（`findTabAnywhere`）之下，**根本开不出"同一篇在两个窗里"的局面** ——
       * 再点一次卡片只会把已有那扇抬到最前（上一条用例已经钉住了）。
       * 所以 `adoptTab` 里那条"目标已有就 save + detach 我们这一份"是**兜底**，
       * 离线造不出它的输入（真正能造出来的是"拖 tab 到已有它的那一扇"，那要真机）。
       */
      const paths = panelPaths();
      eq(paths.length, new Set(paths).size, '合并之后没有任何一篇重复出现在名单里');
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-cw-editor .view-content').length,
        paths.length,
        '每一篇恰好一个活编辑器（没有同一篇两份）',
      );
      await closeAllPanels();
      await resetCfg();
    });

    await suite.it('③ 缩放：⚙ 菜单三档 + 双击把手复位', async () => {
      await closeAllPanels();
      await openBoard();
      await resetCfg();
      clickCard(cards()[0]);
      await H.settle(340);
      const root = winRoots()[0];
      ok(root, '开了一扇窗');
      const grip = H.maybe<HTMLElement>(root, '.kbw-panel-grip');
      ok(grip, '右下角有缩放手柄（`.kbw-panel-grip`）');

      /** 面板头的 ⚙ → 「窗口大小」→ 选一档 */
      const pickSize = async (label: string): Promise<void> => {
        const gear = H.qa<HTMLElement>(root, '.kbw-panel-actions .kbw-iconbtn').find(
          (b) => (b.getAttribute('aria-label') ?? '').includes('设置'),
        );
        ok(gear, '面板头有 ⚙');
        H.click(gear as Element);
        await H.settle(140);
        const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('窗口大小'),
        );
        ok(item, '菜单里有「窗口大小」（拖动的键盘等价物）');
        H.click(item as Element);
        await H.settle(160);
        const sub = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes(label),
        );
        ok(sub, `子菜单里有「${label}」`);
        H.click(sub as Element);
        await H.settle(200);
      };

      await pickSize('窄');
      eq(root.style.width, '340px', '选「窄」→ 宽度落到元素上');
      eq(root.style.height, '420px', '高度同源');
      await pickSize('宽');
      eq(root.style.width, '560px', '选「宽」→ 换过去');
      // 双击把手 = 复位（交还给 CSS）
      grip?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await H.settle(140);
      eq(root.style.width, '', '双击把手 → 复位（style 摘掉，交还给 CSS）');
      eq(root.style.height, '', '高度一起复位');
      await closeAllPanels();
      await resetCfg();
    });

    await suite.it('④ 手势分流：`Ctrl+Shift+滚轮` 改**窗口**（任意处）· `Ctrl+滚轮` 在头上也改窗口', async () => {
      await closeAllPanels();
      await openBoard();
      await resetCfg();
      clickCard(cards()[0]);
      await H.settle(340);
      const root = winRoots()[0];
      ok(root, '开了一扇窗');
      /**
       * ⚠️ **必须先给一个写实的尺寸**（走 ⚙ 菜单那条真入口）：滚轮的语义是
       * "在当前尺寸上乘一个系数"，而 jsdom 的 `getBoundingClientRect()` **全是 0** ——
       * 直接滚会一路夹到下限（280 × 200），看起来像"滚轮把窗口缩小了"（假红）。
       */
      const pickSize = async (label: string): Promise<void> => {
        const gear = H.qa<HTMLElement>(root, '.kbw-panel-actions .kbw-iconbtn').find(
          (b) => (b.getAttribute('aria-label') ?? '').includes('设置'),
        );
        ok(gear, '面板头有 ⚙');
        H.click(gear as Element);
        await H.settle(140);
        const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('窗口大小'),
        );
        ok(item, '菜单里有「窗口大小」');
        H.click(item as Element);
        await H.settle(160);
        const sub = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes(label),
        );
        ok(sub, `子菜单里有「${label}」`);
        H.click(sub as Element);
        await H.settle(200);
      };
      await pickSize('中');
      const readW = (): number => Number(root.style.width.replace('px', ''));
      const readH = (): number => Number(root.style.height.replace('px', ''));
      eq(readW(), 420, '起点尺寸 = 「中」那一档');
      eq(readH(), 560, '高度同源');

      // ① Ctrl+Shift+滚轮 —— 打在**面板头**上（任意处都该改窗口）
      const head = H.q<HTMLElement>(root, '.kbw-panel-head');
      wheel(head, { ctrlKey: true, shiftKey: true, deltaY: -100 });
      await H.settle(140);
      ok(readW() > 420 && readH() > 560, `Ctrl+Shift+滚轮 向上 → 窗口变大（${readW()} × ${readH()}）`);
      const badge = H.maybe<HTMLElement>(root, '.kbw-cw-size');
      ok(badge?.classList.contains('is-on'), '浮标亮起来（显示「420 × 560」那一行）');
      contains(H.textOf(badge ?? null), '×', '浮标写的是"宽 × 高"');
      ok(H.textOf(badge ?? null).includes('×'), '两边都写出来了');

      // ② Ctrl+滚轮在**头**上 = 也改窗口（用户的语义是"正文上才缩字"）
      const w1 = readW();
      wheel(head, { ctrlKey: true, deltaY: -100 });
      await H.settle(140);
      ok(readW() > w1, `Ctrl+滚轮 在头上 → 也改窗口（${w1} → ${readW()}）`);

      // ③ 夹取：连着往下滚很多次 → 不会小过下限（280 × 200）
      const body = H.q<HTMLElement>(root, '.kbw-panel-body');
      for (let i = 0; i < 40; i += 1) wheel(body, { ctrlKey: true, shiftKey: true, deltaY: 100 });
      await H.settle(180);
      eq(readW(), 280, '一直缩 → 夹在宽度下限 280');
      eq(readH(), 200, '高度同一条下限 200');
      await closeAllPanels();
      await resetCfg();
    });
  });
}
