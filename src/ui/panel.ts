/**
 * ui/panel.ts —— 面板 / 浮层容器
 *
 * 决策 30「浮层从触发点展开」：菜单/面板各自把 `transform-origin` 设在**被点的位置**，
 * 动画从那儿缩放长出来，而不是从中心弹。
 *
 * ⚠️ 因此**绝不给容器加 `container-type`**（platform-pitfalls #11）：
 * `container-type: inline-size` 隐含 `contain: layout`，会让该元素成为
 * `absolute`/`fixed` 后代的包含块 —— 正好打中这里用的定位。
 *
 * 两个形态：
 *   · `openModal`    居中 + 遮罩（确认流、快捷键表）
 *   · `openFloating` 锚在触发点旁（就地编辑、下拉长面板）
 */
import { div, el, iconBtn } from './primitives';
import { pushEscapeLayer } from '../core/keymap';
import { Disposer, clamp, on } from '../core/util';
import { startPointerDrag } from './dnd';

export interface Point {
  x: number;
  y: number;
}

export interface PanelOptions {
  /** 面板头按住能不能拖（默认能 —— a.5-2）；显式 false 关掉 */
  dragHandle?: boolean;
  /**
   * **幕后模式**（P7.24 · L2 服务族）：只挂不显示 —— 整面 backdrop 贴 `kbw-offstage`
   * （`display:none`，在任何一帧绘制之前贴好），**且不压 Esc 层**（独立审 🟡6：
   * 压着的话，用户在确认卡出现前按 Esc 会"看不见地"把它关掉、随后卡又凭空冒出）。
   * 给"面板替 agent 跑管线、只该弹确认卡"的场景用；普通面板别传。
   */
  hidden?: boolean;
  title?: string;
  /**
   * **用这个元素当标题**（P6b ⑤：悬浮小窗的"标题就是输入框"）。
   *
   * 为什么不给调用方"自己往 head 里塞"：头的 DOM 是浮层建的（标题、副标题、右侧按钮
   * 有各自的顺序与 CSS），调用方拼一份必然与 `setTitle` 那套打架。给了这个口子之后，
   * 浮层负责摆放、调用方只管元素本身的行为（输入、提交）。
   * ⚠️ 传了它就**不要再传 `title`**（那会建出两个标题元素）。
   */
  titleEl?: HTMLElement;
  sub?: string;
  /**
   * **右下角给一个缩放手柄**（P6b ③，用户 2026-09-27 提："窗口可以拖动、缩放，类似 Windows 窗口"）。
   * 默认关 —— 只有"小窗"这一类需要；筛选/属性那些小浮层给个手柄只是噪音。
   * ⚠️ 手柄是**拖动入口**，所以必须配一个**非拖动的等价操作**（WCAG 2.2 Dragging Movements，
   * 与看板卡片排序、停靠大小同一批口径）—— 小窗那边是 ⚙ 菜单里的「窗口：窄 / 中 / 宽」。
   */
  resizable?: boolean;
  /**
   * **头部拖动时的回调**（P6b ③ 的"拖窗合并"）。
   *
   * `onHeadDragEnd` 的 `dropped` = 指针落下（false = `pointercancel` / Esc 中止）——
   * 取消时调用方要**把高亮都撤掉**（与 `ui/dnd` 那套"三条出路都要收干净"同一条纪律）。
   * 拖动本身由浮层做（跟手 + 夹进视口），调用方只拿坐标去决定"落在哪扇窗上"。
   */
  onHeadDrag?: (phase: 'start' | 'move' | 'end', point: Point, dropped?: boolean) => void;
  /** 拖动缩放途中的尺寸（调用方拿它显示「420 × 560」那一行浮标） */
  onResize?: (size: { w: number; h: number }) => void;
  /** 触发点（视口坐标）—— 决定从哪儿展开 */
  origin?: Point;
  /** 也可以给一个锚点元素，取它的右下角当触发点 */
  anchor?: HTMLElement;
  /**
   * **居中在这个点上**（视口坐标）—— 与 `origin` 互斥，给了它就不"贴触发点"了。
   * 用户 2026-09-25 要的：笔记小窗别贴在卡片下面（那儿上下都没空间，
   * 十来个属性行会把正文挤出屏幕）。
   */
  center?: Point;
  /**
   * **顶部居中在这个点上**（视口坐标）：水平居中，垂直方向**从这点往下长**。
   * 用户 2026-09-25 第二版："不需要显示在屏幕中间，要在所点击的文件窗格**中心的顶部**"。
   */
  topCenter?: Point;
  /** 面板头右侧可以挂几个小按钮（调用方自备；浮层只负责摆位置） */
  headActions?: HTMLElement[];
  /**
   * **面板头最左边**可以挂几个小按钮/图标（P7.3b：AI 面板的「历史对话」）。
   * 与 `headActions`（右侧、`margin-left:auto`）相对；排在标题**之前**。
   */
  headLeading?: HTMLElement[];
  width?: 'narrow' | 'normal' | 'wide';
  /** 点遮罩/空白是否关闭（模态默认 true，浮层默认 true） */
  closeOnOutside?: boolean;
  /**
   * **"这一下算不算外面"的例外**（d 期）：返回 `true` 的那些点**不关窗**。
   *
   * 🔴 为什么必须有（真机实测才发现的，离线桩看不见）：
   * 面板"点外面就关"听的是 **mousedown**，而"点一张卡片"这一下**也是** mousedown ——
   * 于是"单击卡片 = 在这个面板里再开一篇"永远攒不起来：mousedown 先把面板关了，
   * 紧跟着的 click 才又开一扇新的，**上一篇就没了**。
   * 离线的 `H.click` 只派 `click`、不派 `mousedown`，所以那一套用例全绿（假绿）。
   * 判断交给调用方（`ui/` 不该知道"看板卡片"是什么东西）。
   */
  ignoreOutsideClick?: (target: Element | null) => boolean;
  /**
   * **钉住**（d 期，§3.1）：点外面**不关**，直到手动关 —— IDE tool window 口径。
   * 只对浮层有意义（模态是流程性的，钉住它没有语义）。运行时可 `setPinned()` 改。
   */
  pinned?: boolean;
  /**
   * **开窗时的几何**（P7.2c · 4.3-②，Q3 拍板"全记尺寸+位置"）：调用方记着的
   * 「全局默认」`{x,y,w,h}`（视口坐标）。给了它就**不锚触发点**、直接摆在这，
   * 并当作用户定过的位置（内容长高只夹回视口，不再跟着内容重摆）。
   * 越界会在摆好后**夹回视口**（换显示器后老坐标可能在线外）。
   */
  initialGeo?: { x: number; y: number; w: number; h: number } | null;
  /**
   * **几何变了（拖动 / 缩放"结束"那一下）**（P7.2c · 4.3-②）：调用方拿它落盘。
   * ⚠️ 只在结束时报 —— 拖动途中每帧回调等于让调用方每帧写盘。
   */
  onGeometryChange?: (geo: { x: number; y: number; w: number; h: number }) => void;
  closable?: boolean;
  onClose?: (reason: string) => void;
}

export interface PanelHandle {
  /** 内容容器（往这里塞内容） */
  body: HTMLElement;
  /** 底部条（按钮区） */
  foot: HTMLElement;
  /** 最外层（模态是 .kbw-modal，浮层是 .kbw-panel） */
  root: HTMLElement;
  close(reason?: string): void;
  closed: Promise<string>;
  /** 面板内的取消函数集合，关闭时自动执行 */
  disposer: Disposer;
  /** 钉住 / 取消钉住（点外面关不关）。模态上是个空操作 —— 它本来就不靠点外面关。 */
  setPinned(v: boolean): void;
  isPinned(): boolean;
  /**
   * **停靠**（d2 期 §3.1）：把这个浮层搬进 `host`（工作台外壳的 `.kbw-dock`）并切成窗格形态；
   * 传 `null` 就是"取消停靠、回浮层"（搬回 `document.body`）。
   *
   * 🔴 **搬的是同一个节点**，绝不重建 —— 面板里挂着真编辑器叶（`MarkdownView`），
   * 重建 = 丢光标、可能丢最后几秒输入。所以这里只 `appendChild` + 换类名。
   *
   * 🔴 **停靠态下浮层那套必须整体失效**（d2 开工提示词点名的一条）：
   * `position:fixed` 定位、`followAnchor()` 重摆、"点外面就关"、"resize 就关"、
   * 头部拖动 —— 在窗格里它们全都**没有语义**（"点外面"在 IDE 的 tool window 上是不存在的概念）。
   * 判据按 `docked` **每次事件现读**，与 `pinned` 同一套做法（摘/挂两套监听迟早会漂）。
   */
  setDocked(host: HTMLElement | null): void;
  isDocked(): boolean;
  /**
   * **换一个"该摆在哪儿"的锚点**（多篇分页切 tab 时用：面板要跟着当前那一篇走）。
   *
   * 为什么需要这个而不是让调用方直接写 `left/top`：面板内部有一个
   * `ResizeObserver → 重摆` 的机制（内容长高了要重新夹进视口），它按**创建时那个点**
   * 算位置 —— 直接改 left/top 的话，下一次内容长高就会被拽回原来那一列。
   * ⚠️ 与"用户自己拖过"互斥：`userMoved` 之后以用户拖的地方为准，这里只做夹回视口。
   */
  followAnchor(point: Point): void;
  /**
   * 换标题（多篇分页切 tab 时用）。**没建 head 时先建一个** ——
   * 否则调用方得自己保证"创建时一定传了 title"，那种隐含约定迟早漂。
   */
  setTitle(title: string, sub?: string): void;
  /**
   * **改尺寸**（P6b ③；只有 `resizable` 的面板有意义）。
   *
   * `w`/`h` 传 `null` = 交还给 CSS（双击手柄复位就是这一步）。
   * ⚠️ 只改 `width`/`height` 这一对，**不重摆位置** —— 位置由 `followAnchor` / 用户拖动管，
   * 两者混在一起的话"拖完手柄窗口还会自己跳一下"。
   */
  setSize(w: number | null, h: number | null): void;
  /** 现在这一对尺寸（px；没设过 = 量出来的实际值） */
  getSize(): { w: number; h: number };
  /**
   * **"我在这里"的闪一下**（P6b ③：点到已经开着的那一篇时强调那一扇）。
   *
   * 实现是加一个 class 让它播一次动画，播完自己摘（`animationend`）——
   * 不摘的话下一次再加同名 class 不会再播（浏览器认为"没变"）。
   * ⚠️ 「动效 = 减少」时**改成静态描边**（时长由 CSS 的 `prefers-reduced-motion` 与
   * 根元素的 `data-motion` 管，JS 不判）。
   */
  flash(): void;
  /**
   * **把这一扇提到最上**（f 期多窗加）：Esc 层挪到栈顶 + DOM 顺序排到其它浮层之后。
   *
   * 🔴 为什么两件事都要做：
   *  · **Esc**：`dispatchEscape()` 只问**最上面那一层**（`core/keymap.ts`）——
   *    不把层挪到栈顶的话，"最近交互的这一扇"根本轮不到它（用户键 Esc，
   *    关掉的是最后**开**的那一扇，而不是他刚点过的那一扇）；
   *  · **DOM 顺序**：浮层之间 `z-index` 相同（`--z-kbw-panel`），谁在上面看**插入顺序**。
   *
   * ⚠️ 只在自己**不是**最后一个浮层时才动 DOM（避免无意义的重排 —— 移动一个内含
   * 焦点的节点在浏览器里可能打断输入法/选区）。停靠态下 DOM 在窗格里，两件事都不做。
   */
  raise(): void;
  /**
   * **双击标题栏的键盘等价物**（P7.2c · 4.3-①）：最大化 ⇄ 还原。
   * WCAG 的"双击要有非双击入口"与窗口三档「窄/中/宽」同一批口径 —— ⚙ 菜单里给它两行。
   * 停靠态 / 不可缩放的浮层上是空操作（最大化没有语义）。
   */
  toggleMaximize(): void;
  isMaximized(): boolean;
}

// ────────────────────────────────────────────────────────────────
// 定位（浮层用）
// ────────────────────────────────────────────────────────────────
export function measure(node: HTMLElement): { w: number; h: number } {
  const w = node.offsetWidth || node.getBoundingClientRect?.().width || 0;
  const h = node.offsetHeight || node.getBoundingClientRect?.().height || 0;
  return { w, h };
}

/**
 * 把一个 fixed 元素放到 `at` 旁边，必要时翻边，并把 `--kbw-origin` 设成触发点。
 * 返回最终的实际位置与朝向。
 */
export function placeAt(
  node: HTMLElement,
  at: Point,
  opts: { gap?: number; maxW?: number; maxH?: number } = {},
): { x: number; y: number; flippedX: boolean; flippedY: boolean } {
  const gap = opts.gap ?? 4;
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const { w, h } = measure(node);
  const width = Math.min(w || 240, opts.maxW ?? vw - 16);
  const height = Math.min(h || 120, opts.maxH ?? vh - 16);

  const flippedX = at.x + gap + width > vw - 4;
  const flippedY = at.y + gap + height > vh - 4;
  const x = Math.max(4, flippedX ? at.x - gap - width : at.x + gap);
  const y = Math.max(4, flippedY ? at.y - gap - height : at.y + gap);

  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
  // 触发点在元素内的相对位置 → 缩放就从那儿长出来
  const ox = Math.max(0, Math.min(width, at.x - x));
  const oy = Math.max(0, Math.min(height, at.y - y));
  node.style.setProperty('--kbw-origin', `${Math.round(ox)}px ${Math.round(oy)}px`);
  return { x, y, flippedX, flippedY };
}

export function pointFromEvent(evt: MouseEvent | KeyboardEvent | undefined, fallbackEl?: HTMLElement): Point {
  if (evt && 'clientX' in evt && (evt.clientX || evt.clientY)) {
    return { x: evt.clientX, y: evt.clientY };
  }
  if (evt && 'target' in evt && evt.target instanceof HTMLElement) {
    const r = evt.target.getBoundingClientRect();
    return { x: r.left, y: r.bottom };
  }
  if (fallbackEl) {
    const r = fallbackEl.getBoundingClientRect();
    return { x: r.left, y: r.bottom };
  }
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  return { x: vw / 2, y: vh / 2 };
}

export function pointFromEl(target: HTMLElement): Point {
  const r = target.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
}

// ────────────────────────────────────────────────────────────────
// 模态
// ────────────────────────────────────────────────────────────────
export function openModal(opts: PanelOptions = {}): PanelHandle {
  const disposer = new Disposer();
  const backdrop = div({ cls: 'kbw-backdrop' });
  const root = div({ cls: ['kbw-modal', opts.width === 'narrow' ? 'is-narrow' : opts.width === 'wide' ? 'is-wide' : null] });
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');

  const head = div({ cls: 'kbw-modal-head' });
  let modalTitleEl: HTMLElement | null = null;
  let modalSubEl: HTMLElement | null = null;
  /**
   * 头**最左**那几个元素（P7.3b；与右侧的 `.kbw-modal-actions` 相对）。
   * ⚠️ 与 `.kbw-modal-actions` 一样：**容器建了就必须有样式规则**（P6③ 的教训：
   * 建了容器没写规则，头一改成 flex 就被压扁）。
   */
  if (opts.headLeading && opts.headLeading.length > 0) {
    const box = div({ cls: 'kbw-modal-leading' });
    for (const b of opts.headLeading) box.appendChild(b);
    head.appendChild(box);
  }
  if (opts.title) {
    const titleWrap = div({});
    modalTitleEl = el('h2', { cls: 'kbw-modal-title', text: opts.title });
    titleWrap.appendChild(modalTitleEl);
    if (opts.sub) {
      modalSubEl = div({ cls: 'kbw-modal-sub', text: opts.sub });
      titleWrap.appendChild(modalSubEl);
    }
    titleWrap.style.flex = '1';
    titleWrap.style.minWidth = '0';
    head.appendChild(titleWrap);
  } else {
    head.appendChild(div({ cls: 'kbw-spacer' }));
  }
  const body = div({ cls: 'kbw-modal-body' });
  /**
   * 🔴 **底栏"有没有"由子节点决定，不再是一份要同步的状态**（P6 ⑧-A，真机 bug）。
   *
   * 这里原先有一句 `foot.style.display = 'none'`，配套的隐含约定是"谁 append 谁负责
   * 把它解开"（`confirm` / `keys-help` / `new-note` / `prompt` / `quick-capture` /
   * `quick-switch` 有那一行，`wizard` / `ai-panel` / `migrate-panel` / `backfill-panel` /
   * `rebuild-panel` / `snapshot-panel` **没有**）→ 后六个面板的底部**一个按钮都不显示**
   *（内联 `display:none` 压得过 `panel.css` 的 `.kbw-modal-foot{display:flex}`）。
   * 用户报的"向导卡在第一个选项、切不动"就是这个：按钮在、点得到、就是看不见
   *（程序化点击照常生效 ⇒ 离线与探针**四层判据全都没抓住**）。
   *
   * 现在判据换成 CSS 的 `.kbw-modal-foot:empty { display: none }` ——
   * **空的不占位、有东西就显示**，没有第二份状态、也没有"记得解开"这种纪律。
   */
  const foot = div({ cls: 'kbw-modal-foot' });

  let closedResolve: (reason: string) => void = () => {};
  const closed = new Promise<string>((res) => {
    closedResolve = res;
  });

  const previouslyFocused = document.activeElement as HTMLElement | null;
  let popLayer: () => void = () => {};

  const close = (reason = 'close'): void => {
    if (!backdrop.isConnected) return;
    disposer.dispose();
    popLayer();
    backdrop.remove();
    if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
    opts.onClose?.(reason);
    closedResolve(reason);
  };

  /**
   * 头右侧的小按钮/胶囊（调用方自备）。
   *
   * ⚠️ **必须排在关闭按钮之前**：`openFloating` 那边一直是这个顺序（`.kbw-panel-actions`
   * 由 `margin-left:auto` 推到右边、✕ 跟在它后面）。模态这一侧原先**没有接这个选项**
   *（`PanelOptions.headActions` 有声明、`openModal` 里一行都没读）—— 于是"传了但它不出现"
   * 是个**静默**失败：P6④ 的 AI 面板第一版就是这样，档位胶囊一个都没画出来，
   * 而用例报的是"文本里找不到『只读建议模式』"，看着像文案写错了。
   */
  if (opts.headActions && opts.headActions.length > 0) {
    // ⚠️ 类名与浮层那个（`.kbw-panel-actions`）**分开**：那个挂在 `.kbw-panel-head` 下，
    // 这个挂在 `.kbw-modal-head` 下。两处样式规则各自写全（P6③ 的教训：建了容器却没写规则，
    // 头一改成 flex 就被压扁、里面的东西竖着叠起来）
    const box = div({ cls: 'kbw-modal-actions' });
    for (const b of opts.headActions) box.appendChild(b);
    head.appendChild(box);
  }

  if (opts.closable !== false) {
    head.appendChild(iconBtn('x', '关闭', () => close('close')));
  }

  root.appendChild(head);
  root.appendChild(body);
  root.appendChild(foot);
  backdrop.appendChild(root);
  /** P7.24 · L2 幕后模式：贴类在 append 之前（零帧），见 `PanelOptions.hidden` */
  if (opts.hidden === true) backdrop.classList.add('kbw-offstage');

  /**
   * ⚠️ **幕后面板不压 Esc 层**（独立审 🟡6）：不然用户在确认卡出现前按 Esc 会
   * "看不见地"关掉面板（界面毫无反应），几秒后确认卡又凭空冒出来。
   * 幕后面板的收场走它自己的 settle 链（结算 → 自关），不需要 Esc 这一档。
   */
  popLayer =
    opts.hidden === true
      ? () => undefined
      : pushEscapeLayer(() => {
          close('escape');
          return true;
        }, `modal:${opts.title ?? ''}`);

  if (opts.closeOnOutside !== false) {
    disposer.add(
      on(backdrop, 'mousedown', (evt) => {
        if (evt.target === backdrop) close('backdrop');
      }),
    );
  }
  // 焦点圈在模态内
  disposer.add(
    on(root, 'keydown', (evt) => {
      const kev = evt as KeyboardEvent;
      if (kev.key !== 'Tab') return;
      const focusables = focusableIn(root);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (kev.shiftKey && document.activeElement === first) {
        kev.preventDefault();
        last.focus();
      } else if (!kev.shiftKey && document.activeElement === last) {
        kev.preventDefault();
        first.focus();
      } else if (!root.contains(document.activeElement)) {
        kev.preventDefault();
        first.focus();
      }
    }),
  );

  document.body.appendChild(backdrop);
  const focusables = focusableIn(root);
  if (focusables.length > 0) {
    focusables[0].focus();
  } else {
    root.setAttribute('tabindex', '-1');
    root.focus();
  }

  if (opts.origin) {
    const r = root.getBoundingClientRect();
    const ox = Math.max(0, Math.min(r.width, opts.origin.x - r.left));
    const oy = Math.max(0, Math.min(r.height, opts.origin.y - r.top));
    root.style.setProperty('--kbw-origin', `${Math.round(ox)}px ${Math.round(oy)}px`);
  }

  return {
    body,
    foot,
    root,
    close,
    closed,
    disposer,
    /**
     * 模态**不接**钉住：它靠全屏遮罩拦住底下的一切，"点外面不关"在模态上没有语义
     * （遮罩点击本来就是"取消这次流程"）。留成空操作而不是抛错 —— 调用方不必分形态。
     */
    setPinned: () => {},
    isPinned: () => false,
    setDocked: () => {},
    isDocked: () => false,
    /**
     * 模态**不支持缩放与闪烁**（P6b ③ 只给小窗）：给一组说得通的空实现，
     * 免得每个调用方都要 `?.` 判一次。`setSize(null, null)` = 交还给 CSS（本来就是）。
     */
    setSize: () => undefined,
    getSize: () => measure(root),
    flash: () => undefined,
    /** 模态也没有"提到最上"这回事（同时只有一个，且带全屏遮罩）—— 空操作 */
    raise: () => {},
    /** 模态不最大化（它居中带遮罩，没有"工作台可用区"这回事）—— 空操作 */
    toggleMaximize: () => {},
    isMaximized: () => false,
    followAnchor: () => {},
    setTitle: (title, sub) => {
      if (modalTitleEl) modalTitleEl.textContent = title;
      if (sub != null && modalSubEl) modalSubEl.textContent = sub;
    },
  };
}

/** 把一个点夹进「视口能放下这个面板」的范围（面板比视口还大时就贴左上角） */
function clampPoint(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  return {
    x: Math.round(Math.max(4, Math.min(Math.max(4, vw - w - 4), x))),
    y: Math.round(Math.max(4, Math.min(Math.max(4, vh - h - 4), y))),
  };
}

/** 面板**中心**落在 `point` 上（夹进视口） */
function placeCentered(node: HTMLElement, point: Point, origin = '50% 50%'): void {
  const { w, h } = measure(node);
  const p = clampPoint(point.x - w / 2, point.y - h / 2, w, h);
  node.style.left = `${p.x}px`;
  node.style.top = `${p.y}px`;
  node.style.setProperty('--kbw-origin', origin);
}

/** 面板**顶部居中**在 `point` 上（水平居中、往下长；夹进视口） */
function placeTopCentered(node: HTMLElement, point: Point): void {
  const { w, h } = measure(node);
  const p = clampPoint(point.x - w / 2, point.y, w, h);
  node.style.left = `${p.x}px`;
  node.style.top = `${p.y}px`;
  node.style.setProperty('--kbw-origin', '50% 0');
}

/** 只把面板**夹回视口**（不改用户拖到的地方） */
function keepInside(node: HTMLElement): void {
  const { w, h } = measure(node);
  const left = parseFloat(node.style.left || '0') || 0;
  const top = parseFloat(node.style.top || '0') || 0;
  const p = clampPoint(left, top, w, h);
  node.style.left = `${p.x}px`;
  node.style.top = `${p.y}px`;
}

/**
 * **工作台可用区**（P7.2c · 4.3-① 的"铺满范围"，Q3 顺带拍板）= `.kbw-root` 的 rect。
 *
 * 为什么不是视口：小窗是**工作台里**的东西，双击最大化铺的是工作台那一块
 *（Obsidian 的左侧栏/标签栏/状态栏不归它盖 —— 盖了看起来就像插件"越界"了）。
 * 找不到 `.kbw-root`（离线桩 / 工作台之外的悬浮调用）或 rect 量到 0（隐藏容器）
 * → 退成**视口减一圈边距**：铺满是尽力而为，摆出零尺寸才是事故。
 */
function workbenchRect(): { left: number; top: number; width: number; height: number } {
  const el = document.querySelector<HTMLElement>('.kbw-root');
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  }
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  return { left: 4, top: 4, width: vw - 8, height: vh - 8 };
}

// ────────────────────────────────────────────────────────────────
// 浮层
// ────────────────────────────────────────────────────────────────
/**
 * **还开着的浮层**：`purgeOverlays()` 要能"先关再拆"。
 *
 * 🔴 为什么必须有这张表（d 期修的真 bug，不是洁癖）：
 * 原先 `purgeOverlays()` 只 `el.remove()` —— **不触发 `onClose`**。而插件重载时
 * `onunload` 先跑（purge 掉 DOM），随后视图 `onClose → 看板模块 dispose`（那条路走的是
 * `keepPinnedPanel()`，钉住时**故意不关**）才跑，而 `close()` 第一句是
 * `if (!root.isConnected) return;` → **提前 return，`onClose` 回调根本不执行 →
 * 那个 markdown 叶永远没人 detach**。
 * 症状是工作区里留着一片查得到、谁也管不着的悬挂叶（P4/a.5 都记过，一直没找到机制）。
 * 现在：purge 先把每个浮层的关闭流程走完（save + detach 真编辑器），再拆 DOM。
 */
const liveFloaters = new Set<(reason: string) => void>();

/**
 * **这个东西是不是"我们自己弹的浮层"**（菜单 / 多选下拉）。
 *
 * 用途：浮层的"点外面就关"要给调用方留一个例外口子（`PanelOptions.ignoreOutsideClick`），
 * 而"哪些算自己人"这份知识**该留在浮层这一层** ——
 * 让看板去写 `.kbw-menu` 这种菜单类名，正好撞上项目那条红线
 *（"看板不许自建菜单：弹菜单只能过 `ui/menu.ts`"，它按类名字符串判，作者当场撞了一次）。
 *
 * ⚠️ 加进这张单子前先问一句"**点它之后那个浮层该不该关**"。
 */
export function isOwnPopup(target: Element | null): boolean {
  return target?.closest?.('.kbw-menu, .kbw-dropdown') != null;
}

/**
 * 把挂在 body 上的浮层/模态/遮罩**整批清掉**（插件加载与卸载时调）。
 * 重载时若正开着确认流，`.kbw-backdrop` 是全屏遮罩会挡住工作台，
 * 而 Esc 层已随卸载消失 —— 只能靠点它自己关，等于卡住（独立审查指出）。
 *
 * ⚠️ 顺序是**先关、后拆**：`close()` 可能是异步的（面板要先 `save()` 再 `detach()`
 * 真编辑器叶），所以这里只负责"让它们开始关"，不等它跑完 ——
 * 但那条链路会照常跑完，因为 `close()` 内部是 `void (async () => …)()`，不依赖调用方等它。
 */
export function purgeOverlays(): void {
  // 先拷一份再遍历：`close()` 会把自己从表里摘掉，直接遍历 Set 会漏掉后面的
  for (const close of Array.from(liveFloaters)) {
    try {
      close('purge');
    } catch (e) {
      // 一个浮层收不干净不许连累其余的（下面还会拆 DOM 兜底）
      console.error('[经纬] 收浮层时出错（继续收剩下的）', e);
    }
  }
  liveFloaters.clear();
  for (const sel of ['.kbw-modal', '.kbw-panel', '.kbw-backdrop', '.kbw-bubble']) {
    for (const el of Array.from(document.querySelectorAll(sel))) el.remove();
  }
}

export function openFloating(opts: PanelOptions = {}): PanelHandle {
  const disposer = new Disposer();
  const root = div({ cls: 'kbw-panel' });
  root.setAttribute('role', 'dialog');
  root.style.visibility = 'hidden'; // 先量再显，避免闪一下
  /** 钉住（点外面不关）—— 运行时可变，判据在事件里现读 */
  let pinned = opts.pinned === true;
  if (pinned) root.classList.add('is-pinned');
  /**
   * 停靠（宿主是窗格而不是 `document.body`）—— 同样运行时可变、判据现读。
   * 见 `PanelHandle.setDocked` 上那段：**停靠态下浮层那几套行为整体失效**。
   */
  let docked = false;

  const body = div({ cls: 'kbw-panel-body', css: { padding: 'var(--sp-3)' } });
  // 底栏的显隐口径与模态同一条（见 `openModal` 里那段）：**空的不占位**，别写内联 `display:none`
  const foot = div({ cls: 'kbw-panel-foot' });
  let titleEl: HTMLElement | null = null;
  let subEl: HTMLElement | null = null;
  let headEl: HTMLElement | null = null;
  // ⚠️ 浮层也要显示标题（P0 收了 `title` 却从不渲染 —— 筛选/属性/标签面板都没头）
  // ⚠️ 判据是 `opts.title` **或** `opts.titleEl`（P6b ⑤：小窗的标题就是输入框，没有 title 文案）
  if (opts.title || opts.titleEl) {
    const head = div({ cls: 'kbw-panel-head' });
    headEl = head;
    titleEl = opts.titleEl ?? div({ cls: 'kbw-panel-title', text: opts.title });
    if (opts.titleEl) titleEl.classList.add('kbw-panel-title');
    head.appendChild(titleEl);
    if (opts.sub) {
      subEl = div({ cls: 'kbw-panel-sub', text: opts.sub });
      head.appendChild(subEl);
    }
    if (opts.headActions && opts.headActions.length > 0) {
      // 头右侧的小按钮（调用方自备）—— `margin-left: auto` 把它们推到右边
      const box = div({ cls: 'kbw-panel-actions' });
      for (const b of opts.headActions) box.appendChild(b);
      head.appendChild(box);
    }
    root.appendChild(head);
    /**
     * **面板头按住可拖**（a.5-2，用户报"悬浮小窗无法拖动"）。
     * 走 `ui/dnd` 那套基元 —— 鼠标 4px 阈值、触屏长按，与卡片拖动同一手感；
     * 拖动只改 `left/top` 并夹在视口内（面板是 `position: fixed`，本来就不参与滚动）。
     * 头上的按钮/输入框不抢（那些控件自己有交互）。
     */
    if (opts.dragHandle !== false) {
      head.classList.add('kbw-panel-grab');
      head.addEventListener('pointerdown', (evt) => {
        const down = evt as PointerEvent;
        if (down.button !== 0) return;
        // 停靠态下头部不可拖：面板在窗格里是**静止的**，拖它没有去处
        //（"拖出去 = 取消停靠"是 PyCharm 的另一半手势，d2 拍板只做菜单入口）
        if (docked) return;
        if ((down.target as HTMLElement | null)?.closest?.('button, input, select, a')) return;
        const r = root.getBoundingClientRect();
        const w = r.width;
        const hh = r.height;
        startPointerDrag(down, null, {
          onStart: () => {
            root.classList.add('is-dragging');
            // 用户自己动过之后：只保证「在视口内」，不再跟着内容重摆 —— 否则拖到哪儿都会被拽回来
            userMoved = true;
            opts.onHeadDrag?.('start', { x: down.clientX, y: down.clientY });
          },
          onOver: (_t, ctx) => {
            const x = clamp(ctx.x - (down.clientX - r.left), 4, Math.max(4, window.innerWidth - w - 4));
            const y = clamp(ctx.y - (down.clientY - r.top), 4, Math.max(4, window.innerHeight - hh - 4));
            root.style.left = `${Math.round(x)}px`;
            root.style.top = `${Math.round(y)}px`;
            opts.onHeadDrag?.('move', { x: ctx.x, y: ctx.y });
          },
          onDrop: (_t, ctx) => {
            root.classList.remove('is-dragging');
            opts.onHeadDrag?.('end', { x: ctx.x, y: ctx.y }, true);
            // 几何变了（拖动**结束**才报 —— 途中每帧报等于让调用方每帧写盘）；
            // 最大化态不报（那是"铺满工作台的几何"，不是用户摆的常态几何 —— 独立审 🟡4）
            if (!maxState) opts.onGeometryChange?.(geoOf());
          },
          onCancel: () => {
            root.classList.remove('is-dragging');
            // ⚠️ 取消（`pointercancel` / Esc 中止）也要把调用方的高亮收干净 —— 传 dropped=false
            opts.onHeadDrag?.('end', { x: down.clientX, y: down.clientY }, false);
          },
        });
      });
      /**
       * **双击标题栏 = 最大化 / 还原**（P7.2c · 4.3-①；Q3 拍板"铺满工作台整块"）。
       *
       * 三条口径：
       *  · **同一套"别抢控件"守卫**（与上面拖动一致：按钮/输入框上不算）——
       *    否则双击图钉会顺手把窗最大化；
       *  · **只有 `resizable` 的浮层有它**（"小窗"语义 —— 筛选/属性那些小浮层的头
       *    双击一下突然铺满整块工作台是惊吓不是功能）；
       *  · 停靠态不可最大化（它本来就铺满窗格，`toggleMaximize` 里判）。
       *  键盘等价物 = ⚙ 菜单的「最大化 / 还原」（`toggleMaximize`，WCAG 那条）。
       */
      head.addEventListener('dblclick', (evt) => {
        if ((evt.target as HTMLElement | null)?.closest?.('button, input, select, a')) return;
        if (!opts.resizable) return;
        evt.preventDefault();
        toggleMaximize();
      });
    }
  }
  root.appendChild(body);
  root.appendChild(foot);

  let closedResolve: (reason: string) => void = () => {};
  const closed = new Promise<string>((res) => {
    closedResolve = res;
  });

  /**
   * 已经关过了吗 —— **用显式标志，不许看 `root.isConnected`**。
   *
   * 🔴 这是 d2 独立审查抓出来的真缺陷（离线被桩挡住、真机可达）：
   * 平台在 `View.close()` 里是**先 `containerEl.detach()`、再 `await this.onClose()`**
   *（asar 取证写在 `tests/stub` 的 `WorkspaceLeaf.detach` 上）。而停靠态下面板 root 住在
   * 工作台外壳的 `.kbw-dock` 里 —— 它就是 `contentEl` 的后代 ⇒ **视图 `onClose()`
   * 跑的那一刻，root 已经在文档之外了**，这句短路会让下面整段
   *（`onClose` 回调 → 每个 tab 的 `save()` + `detach()`、`d.dispose()`、
   * `component.unload()`、把窗格让出来）**一个都不执行** ——
   * 症状是**丢最后几秒输入 + 每个 tab 留一个悬挂叶**，而且 `purgeOverlays()` 也救不回来
   *（它同样调 `close()`，同样被短路）。
   *
   * 浮层态之所以一直没露出来，只是因为 root 挂在 `document.body` 上、而 body 不会被拆。
   */
  let didClose = false;
  const close = (reason = 'close'): void => {
    if (didClose) return;
    didClose = true;
    liveFloaters.delete(close);
    disposer.dispose();
    pullEsc();
    root.remove();
    const prev = previouslyFocused;
    if (prev && prev.isConnected) prev.focus();
    opts.onClose?.(reason);
    closedResolve(reason);
  };
  /**
   * 注册进"还开着的浮层"表 —— `purgeOverlays()` 靠它**先关再拆**（见那张表的注释：
   * 不注册的话插件重载会留下没人管的悬挂叶）。
   */
  liveFloaters.add(close);

  const previouslyFocused = document.activeElement as HTMLElement | null;
  /**
   * Esc 那一层做成**可压可弹**的一对（不是"钉住时把它摘掉"的那种两套代码）——
   * 因为停靠态下 **Esc 不该关掉窗格**（d2 拍板：停靠的意义就是"它一直在那儿"，
   * Esc 一点就没等于白停靠）。而 `dispatchEscape()` 的规矩是
   * 「**层回调返回 `false` 就把这层弹掉**、继续往下问」—— 直接返回 false 的话
   * 这层会被永久弹掉（取消停靠之后 Esc 就再也关不掉它了）。所以只能在
   * **进出停靠态时**显式压/弹，这也正是本项目 `keymap.ts` 注释里那条
   * 「按'有没有东西可清'压/弹那一层」的写法。
   */
  let popEscape: (() => void) | null = null;
  const pushEsc = (): void => {
    if (popEscape) return;
    popEscape = pushEscapeLayer(() => {
      close('escape');
      return true;
    }, `floating:${opts.title ?? ''}`);
  };
  const pullEsc = (): void => {
    popEscape?.();
    popEscape = null;
  };
  pushEsc();

  document.body.appendChild(root);
  /**
   * 当前"该摆在哪儿"。做成**可变的**（`followAnchor` 会改它）——
   * 否则内容长高时那一次重摆会按创建时的老锚点把面板拽回去。
   */
  let anchorPoint: Point = opts.center ?? opts.topCenter ?? opts.origin ?? (opts.anchor ? pointFromEl(opts.anchor) : { x: 40, y: 40 });
  const replace = (): void => {
    if (opts.center) {
      placeCentered(root, anchorPoint, '50% 50%');
    } else if (opts.topCenter) {
      placeTopCentered(root, anchorPoint);
    } else {
      placeAt(root, anchorPoint);
    }
  };
  replace();
  /**
   * 🔴 **内容长出来之后要重新摆一次**（用户 2026-09-25："悬浮窗口经常有一段在屏幕外面"）：
   * 开窗那一刻面板还短（真编辑器是后挂的、属性行还能「显示全部」展开），位置是按**当时**的高度
   * 算好的 —— 之后一长高就顶出视口了。
   * ⚠️ 用户**自己拖过之后就不再重摆**（只做"夹回视口"，否则拖到哪儿都会被拽回去）。
   */
  let userMoved = false;
  /**
   * ── 尺寸（P6b ③ 的缩放手柄那一套；**P7.2c 从下面挪上来** —— 开窗时就要能
   * "按记住的几何摆好"，而那段应用必须在 `visibility` 打开**之前**跑，别闪一下）。
   */
  let size: { w: number; h: number } | null = null;
  const applySize = (): void => {
    if (!size) {
      root.style.width = '';
      root.style.height = '';
      return;
    }
    root.style.width = `${Math.round(size.w)}px`;
    root.style.height = `${Math.round(size.h)}px`;
  };
  /** 视口 90%（下限 280×200 —— 比这个再小就不是"窗"了） */
  const limits = (): { minW: number; minH: number; maxW: number; maxH: number } => ({
    minW: 280,
    minH: 200,
    maxW: Math.max(320, Math.round((window.innerWidth || 1200) * 0.9)),
    maxH: Math.max(240, Math.round((window.innerHeight || 800) * 0.9)),
  });
  /**
   * **开窗就用"记住的几何"**（P7.2c · 4.3-②，Q3 拍板"全记尺寸+位置"）：
   * 调用方把上次拖/缩过的 `{x,y,w,h}`（`data.json` 的 `panelGeo`）传进来 ——
   * 有它就**不锚触发点**、直接摆这儿；没有（还没记过）就照旧走 `replace()` 锚列顶。
   * ⚠️ 记着的位置 = **用户定过的** → `userMoved = true`（内容长高只夹回视口）；
   * 摆完 `keepInside` —— 换显示器 / 改分辨率之后老坐标可能在线外。
   */
  if (opts.initialGeo) {
    const g = opts.initialGeo;
    size = { w: g.w, h: g.h };
    applySize();
    root.style.left = `${Math.round(g.x)}px`;
    root.style.top = `${Math.round(g.y)}px`;
    userMoved = true;
    keepInside(root);
  }
  const readjust = (): void => {
    // 停靠态下面板的尺寸由**窗格**说了算（宿主给宽/高，面板自己 100% 填满），
    // 这里再去写 left/top 只会在取消停靠那一刻闪一下
    if (docked) return;
    /**
     * ⚠️ **最大化态不许再夹**（P7.2c 真机实测）：`.kbw-root` 可以贴到视口边，
     * 而 `keepInside` 有 4px 安全边 —— 最大化触发 ResizeObserver 后会把刚铺满的框
     * 又拽回来 4px（真机量到窗 40,36 vs 工作台 44,40）。最大化几何就是目标几何。
     */
    if (maxState) return;
    if (userMoved) {
      keepInside(root);
      return;
    }
    replace();
  };
  try {
    const ro = new ResizeObserver(() => readjust());
    ro.observe(root);
    disposer.add(() => ro.disconnect());
  } catch {
    /* 没有 ResizeObserver 就算了（离线桩里也没有） */
  }
  root.style.visibility = '';

  /**
   * **钉住**（d 期 §3.1）：点外面不关。判据做成**每次事件现读** `pinned`，
   * 不是"钉住时把监听摘掉" —— 摘/挂两套代码迟早会漂（Esc 那层已经踩过同类坑）。
   * ⚠️ 视口变小不再关窗（钉住的窗被关掉就白钉了），改成**夹回视口内**。
   */
  if (opts.closeOnOutside !== false) {
    disposer.add(
      on(document, 'mousedown', (evt) => {
        // 停靠（窗格）：**没有"外面"这回事** —— 窗格就长在工作台上，它不是浮层。
        // 这一条也是 d2 定「停靠 ≈ 恒钉住」的落点（比 `pinned` 优先级更高）。
        if (docked) return;
        if (pinned) return;
        const t = evt.target as Element | null;
        if (root.contains(t as Node)) return;
        // 调用方声明的例外（"这一下我在干正事，别关"）——见 `ignoreOutsideClick`
        if (opts.ignoreOutsideClick?.(t)) return;
        close('outside');
      }),
    );
    disposer.add(
      on(window, 'resize', () => {
        // 同上：窗格跟着工作台走，视口变小不该把它关掉，也不该去写它的 left/top
        if (docked) return;
        if (pinned) keepInside(root);
        else close('resize');
      }),
    );
  }

  /**
   * ── 缩放手柄（P6b ③，`resizable: true` 才有）────────────────────────
   *
   * 三条要点（都是别处踩过的）：
   *  · **视觉 12×12、命中区 ±7px**（`.kbw-panel-grip` 用 `::before` 撑出更大的可点区域）——
   *    与表格列宽抓手、卡片分隔条同一档手感；
   *  · **拖动只改 `width/height`，不重摆位置**：位置归 `followAnchor` / 用户拖动管，
   *    两者混在一起会出现"拖完手柄窗口自己跳一下"；
   *  · **双击 = 复位**（交还给 CSS），与分隔条"双击回自动"同一条手感；
   *    键盘等价物在调用方（小窗那边是 ⚙ 菜单的「窗口：窄 / 中 / 宽」）。
   * （`size` / `applySize` / `limits` 三个定义在**上面**"开窗就用记住的几何"那段旁边。）
   */
  if (opts.resizable) {
    const grip = div({
      cls: 'kbw-panel-grip',
      attr: { role: 'button', tabindex: '0', 'aria-label': '拖动缩放窗口；双击复位' },
    });
    grip.addEventListener('pointerdown', (evt) => {
      const down = evt as PointerEvent;
      if (down.button !== 0) return;
      // 别让头部拖动/点外面那套跟着跑（手柄就在面板右下角里）
      evt.preventDefault();
      evt.stopPropagation();
      /**
       * ⚠️ **最大化态下手动缩放：先还原再缩**（独立审 🟢12）：直接缩的话，内联尺寸
       * 与 `size` 变量分叉 —— 之后"还原"一句会把刚缩的那份顶掉（看着像白缩）。
       */
      if (maxState) toggleMaximize();
      const r0 = root.getBoundingClientRect();
      const lim = limits();
      startPointerDrag(down, null, {
        onStart: () => root.classList.add('is-resizing'),
        onOver: (_t, ctx) => {
          size = {
            w: clamp(ctx.x - r0.left, lim.minW, lim.maxW),
            h: clamp(ctx.y - r0.top, lim.minH, lim.maxH),
          };
          applySize();
          opts.onResize?.(size);
        },
        onDrop: () => {
          root.classList.remove('is-resizing');
          // 缩放**结束**才报几何（拖动途中每帧报 = 调用方每帧写盘）；
          // 最大化态不报（同头部拖动那条 —— 独立审 🟡4）
          if (!maxState) opts.onGeometryChange?.(geoOf());
        },
        onCancel: () => root.classList.remove('is-resizing'),
      });
    });
    grip.addEventListener('dblclick', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      size = null;
      applySize();
    });
    root.appendChild(grip);
  }

  /** 现在这一扇的几何（视口坐标）—— 落盘与"还原到哪"共用一份口径 */
  const geoOf = (): { x: number; y: number; w: number; h: number } => {
    const r = root.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };

  /**
   * **最大化态**（P7.2c · 4.3-①）：`null` = 常态；非 null = 记着"最大化之前长什么样"。
   * 存的是**内联样式的原文**（`''` 也是合法原文 —— 交还给 CSS 的那些属性还原时就该是空串）。
   */
  let maxState: {
    left: string;
    top: string;
    w: string;
    h: string;
    maxW: string;
    maxH: string;
    userMoved: boolean;
  } | null = null;

  /**
   * 双击标题栏 / ⚙ 菜单「最大化·还原」的**唯一实现**（两处入口共用 —— 分两份必漂）。
   *
   * 铺满范围 = **工作台整块**（`.kbw-root` 的 rect，Q3 顺带拍板）：小窗是工作台里的东西，
   * "铺满"铺的是工作台可用区，不是整个 Obsidian 窗口（左侧栏/标签栏不归它盖）。
   * 找不到 `.kbw-root`（离线 / 悬浮在库根之外）→ 退成视口减一圈边距。
   * ⚠️ **停靠态 / 不可缩放的浮层上是空操作**：窗格本来就填满，小浮层没有"最大化"。
   *
   * 🔴 **必须同时放开 CSS 的 `max-width/max-height`**（真机首跑抓到的真缺陷）：
   * `.kbw-panel` 自带 `max-width: min(520px, 100vw-16px)` 与 `max-height: 100vh-24px` ——
   * 只写内联 `width/height` 的话，**max 把"铺满"当场夹回去**（真机量到窗 520×702，
   * 而工作台是 1356×860；**离线看不见**：jsdom 不加载样式表，假 rect 判据照样绿）。
   * 还原时把这两条**照原文还回去**（`''` 也是原文）。
   */
  const toggleMaximize = (): void => {
    if (docked || !opts.resizable) return;
    if (maxState) {
      // 还原：内联样式照原文还回去（'' 也还成 ''）
      root.style.left = maxState.left;
      root.style.top = maxState.top;
      root.style.width = maxState.w;
      root.style.height = maxState.h;
      root.style.maxWidth = maxState.maxW;
      root.style.maxHeight = maxState.maxH;
      userMoved = maxState.userMoved;
      maxState = null;
      return;
    }
    const r = workbenchRect();
    maxState = {
      left: root.style.left,
      top: root.style.top,
      w: root.style.width,
      h: root.style.height,
      maxW: root.style.maxWidth,
      maxH: root.style.maxHeight,
      userMoved,
    };
    root.style.left = `${Math.round(r.left)}px`;
    root.style.top = `${Math.round(r.top)}px`;
    root.style.width = `${Math.round(r.width)}px`;
    root.style.height = `${Math.round(r.height)}px`;
    root.style.maxWidth = 'none';
    root.style.maxHeight = 'none';
    // 最大化也是"用户定过的位置"—— 内容长高不许把它拽回去
    userMoved = true;
  };

  /**
   * **把这一扇提到最上**（`PanelHandle.raise` 的唯一实现；4.3-③ 的"点一下置顶"也走它）。
   *
   * 停靠态：DOM 在窗格里、Esc 层也摘了 —— 没有"提到最上"这回事。
   * ⚠️ 顺序：**先挪 Esc 层、再动 DOM** —— 两件都做（见 `PanelHandle.raise` 上那段）。
   * `pullEsc()` + `pushEsc()` 是"同一个层挪到栈顶"最省事的写法：
   * `pushEsc` 自己就判"已经有层了就不重复压"（先 pull 掉它才会真压）。
   * DOM 只在自己**不是最后一个浮层**时才动 —— 否则每点一下都白重排一次
   *（含焦点的节点被移动，浏览器可能打断输入法/选区，代价不小）。
   * 只对**同级浮层（.kbw-panel）**排序：模态（`.kbw-modal`）与它们是同一档
   * z-index，但那类"流程性"的东西该待在它自己该在的位置上，不去抢。
   */
  const raisePanel = (): void => {
    if (docked) return;
    if (popEscape) {
      pullEsc();
      pushEsc();
    }
    const peers = Array.from(document.querySelectorAll('.kbw-panel'));
    const last = peers[peers.length - 1];
    if (last && last !== root && root.isConnected && root.parentElement === document.body) {
      last.after(root);
    }
  };

  /**
   * **点一下提到最上**（4.3-③，Windows 手感）：浮层之间 `z-index` 同层，
   * 谁在上看 **DOM 插入顺序** —— 点哪扇就把哪扇排到末尾（复用 `raisePanel`，
   * **不引入第二套 z-index 计数**）。挂在 `pointerdown` 而不是 `click`：要在焦点落进
   * 这一扇**之前**挪（浏览器移动含焦点节点可能打断输入法/选区），也抢在"点外面就关"
   * 那一下之前把判据摆正。
   */
  disposer.add(
    on(root, 'pointerdown', () => {
      if (docked) return;
      raisePanel();
    }),
  );

  return {
    body,
    foot,
    root,
    close,
    setSize: (w, h) => {
      /** 停靠态尺寸归窗格（拖窗格内沿那根分隔条）—— 写内联只会把 `.is-docked` 的 100% 顶掉 */
      if (docked) return;
      // 最大化态先还原再改档（否则档位写在"铺满"上、再还原一句就把它顶掉 —— 独立审 🟢12）
      if (maxState) toggleMaximize();
      size = w == null || h == null ? null : { w, h };
      applySize();
    },
    getSize: () => {
      const r = root.getBoundingClientRect();
      return { w: size?.w ?? r.width, h: size?.h ?? r.height };
    },
    flash: () => {
      /**
       * ⚠️ 先摘再加重播（同一个 class 再加一遍不会重播动画）；用 `offsetWidth` 逼一次重排。
       * 摘的时机交给 `animationend` —— 提前摘会看到动画中途断掉。
       */
      root.classList.remove('is-flash', 'is-flash-static');
      void root.offsetWidth;
      /**
       * 🔴 **「动效 = 减少」时改走静态描边**（P6b ③ 的设计要求）。
       *
       * 为什么不能只靠 CSS：那两段 `prefers-reduced-motion` / `[data-motion=reduce]` 规则是把
       * `animation-duration` 压到 **1ms**（本项目既有的降级口径）—— 于是 `animationend`
       * **当场触发**，动画类被立刻摘掉，用户**什么也看不到**（"点到已开的那一篇"就没有反馈了）。
       * 所以：判到减少动效就换成 `is-flash-static`（静态主题色描边）钉 1 秒。
       */
      let reduce = false;
      try {
        reduce =
          document.body?.getAttribute?.('data-motion') === 'reduce' ||
          document
            .querySelector('.kbw-root')
            ?.getAttribute('data-motion') === 'reduce' ||
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      } catch {
        reduce = false;
      }
      if (reduce) {
        root.classList.add('is-flash-static');
        window.setTimeout(() => root.classList.remove('is-flash-static'), 1000);
        return;
      }
      root.classList.add('is-flash');
      const done = (): void => root.classList.remove('is-flash');
      root.addEventListener('animationend', done, { once: true });
      // 兜底：万一没有 animationend（被别处的规则吃掉）→ 用定时器摘
      window.setTimeout(done, 1200);
    },
    closed,
    disposer,
    setPinned: (v) => {
      pinned = v;
      root.classList.toggle('is-pinned', v);
      // 钉住之后就不该再被"内容长高"拽着走位了 —— 当作用户已经定过位置；
      // 最大化态不夹（同 readjust/followAnchor 那条）
      if (v && !maxState) keepInside(root);
    },
    isPinned: () => pinned,
    setDocked: (host) => {
      const next = host != null;
      docked = next;
      root.classList.toggle('is-docked', next);
      if (next) {
        /**
         * 搬进窗格 —— **同一个节点**，只 `appendChild`，绝不重建：
         * 面板里每一页挂的是真的 `MarkdownView`（有活 buffer 与光标），
         * 重建 = 丢光标、可能丢最后几秒输入（d2 开工提示词头一条红线）。
         */
        host.appendChild(root);
        // 浮层那套定位在窗格里没有意义；留着的话取消停靠那一刻会先闪到旧坐标
        root.style.left = '';
        root.style.top = '';
        /**
         * 🔴 **进窗格前把所有内联尺寸交还 CSS**（P7.2c ☓ 独立审 🟡5）：窗格形态靠
         * `.kbw-panel.is-docked { width:100%; height:100% }`，而**内联压类名** ——
         * 不管尺寸是"最大化"那份还是"手柄/⚙ 三档"（`setSize`）那份，留着都会让
         * 停靠的那扇**不铺满**（真机可走：停靠态齿轮仍可点）。
         * `size` 变量**不动** —— 取消停靠时 `applySize()` 把它还回来（见 else 分支）。
         * 最大化态到这里终结：把 `userMoved` 与 max-* 原文先还原（不是"静默丢"）。
         */
        if (maxState) {
          userMoved = maxState.userMoved;
          root.style.maxWidth = maxState.maxW;
          root.style.maxHeight = maxState.maxH;
          maxState = null;
        }
        root.style.width = '';
        root.style.height = '';
        root.style.maxWidth = '';
        root.style.maxHeight = '';
        // 停靠态 Esc 不关（见上面 `pushEsc` 那段）→ 把这一层弹掉，让 Esc 落到下面那层
        pullEsc();
      } else {
        document.body.appendChild(root);
        pushEsc();
        // 回浮层：按当前锚点重摆一次（`userMoved` 的优先级在 `replace` 外面那条判据里）
        replace();
        // 停靠期间尺寸交给了窗格 —— 回浮层时把"记着的那份"还回来（独立审 🟡5）
        applySize();
      }
    },
    isDocked: () => docked,
    raise: raisePanel,
    toggleMaximize,
    isMaximized: () => maxState != null,
    followAnchor: (point) => {
      anchorPoint = point;
      // 停靠态下**不重摆**，但锚点照样记着 —— 取消停靠那一刻要落回当前这一列。
      // ⚠️ 别把它写成"停靠时干脆不调 followAnchor"：那样切 tab 之后取消停靠会落回老位置。
      if (docked) return;
      // 最大化态同样不夹（见 `readjust` 里那条 —— 切 tab 也不该把铺满框拽回 4px）
      if (maxState) return;
      // 用户自己拖过就不抢（只保证还在视口里）—— 与内容长高那条同一个口径
      if (userMoved) keepInside(root);
      else replace();
    },
    setTitle: (title, sub) => {
      if (!titleEl) {
        // 建面板时没给 title → 现建一个头（顺序：head 在最前）
        const head = div({ cls: 'kbw-panel-head' });
        headEl = head;
        titleEl = div({ cls: 'kbw-panel-title', text: title });
        head.appendChild(titleEl);
        if (sub != null) {
          subEl = div({ cls: 'kbw-panel-sub', text: sub });
          head.appendChild(subEl);
        }
        root.insertBefore(head, root.firstChild);
        return;
      }
      /**
       * ⚠️ **标题元素可能是输入框**（P6b ⑤ 的小窗：标题就是输入框）。
       * 两种口径：
       *  · 用户正在里面打字（`activeElement === titleEl`）→ **一个字都不动**（别抢）；
       *  · 否则把值换成新的（切 tab 时标题要跟着切）。
       * 用 `textContent` 写 input 是**无声的**（改不出任何东西）—— 这正是本项目的
       * "看着像没生效"那一类，所以这里显式分叉。
       */
      const asInput =
        titleEl instanceof HTMLInputElement ? (titleEl as HTMLInputElement) : null;
      if (!(asInput && asInput === document.activeElement)) {
        if (asInput) {
          if (asInput.value !== title) asInput.value = title;
        } else {
          titleEl.textContent = title;
        }
      }
      if (sub == null) return;
      if (subEl) {
        subEl.textContent = sub;
        return;
      }
      const head = headEl;
      if (!head) return;
      subEl = div({ cls: 'kbw-panel-sub', text: sub });
      // sub 要插在标题**后面**，但不能跑到头右侧那排按钮后面
      const actions = head.querySelector('.kbw-panel-actions');
      head.insertBefore(subEl, actions ?? null);
    },
  };
}

export function openPanel(opts: PanelOptions & { kind?: 'modal' | 'floating' } = {}): PanelHandle {
  return opts.kind === 'floating' ? openFloating(opts) : openModal(opts);
}

const FOCUSABLE_SEL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 可聚焦元素。**注意退化分支**：量不到布局时（jsdom、隐藏容器）
 * 无法判断可见性，就退化成"全都算"——否则离线测试里永远找不到焦点目标。
 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SEL));
  const visible = all.filter((n) => n.offsetParent !== null || (n.getClientRects?.().length ?? 0) > 0);
  return visible.length > 0 ? visible : all;
}
