/**
 * modules/notes/grid.ts —— 网格档（交互规格 §3.5，视觉照 `界面设计.html` 的 `s-desk`）
 *
 * 一屏三方块：**排序条**（排序下拉 + 自动排列 + 提示）· **网格体**（可滚）· **状态行**
 *（「共 N 项 · 框选 M 项」）。每格 = 纸页图标 + 名称 + 大小。
 *
 * ── 五条来自真机实测的纪律（都是本项目栽过的，逐条对应）────────
 *
 * ① 🔴 **框选起手那一帧必须先把选框归零到触点**（S4 手机实测的残影 bug，**离线测不出**）：
 *    所以选框元素在 `pointerdown` 里就造好、并把几何写成"触点处的零尺寸"，`onStart` 只是
 *    把它挂上去。绝不能让它在第一个可见帧里带着上一次的尺寸。
 *
 * ② 🔴 **触屏不能用位移阈值启动拖动**：触屏第一个 `pointermove` 就带 4.5–20px 位移。
 *    阈值、长按 400ms、10px 容差、`pointercancel`、Esc 中止这一整套**都在 `ui/dnd.ts`**，
 *    这里只接线，绝不自己再写一套判断。
 *
 * ③ 🔴 **长按双模式**（§3.5 两行）：长按 400ms 后**不动** = 进选择模式，**移动** = 进拖动模式。
 *    两件事共用同一次长按 —— 见 `onStart` / `onOver` 里 `pendingSelect` 的那条状态机。
 *
 * ④ 🔴 **拖动之后那发 `click` 要吃掉**（`wasDraggingRecently`）：拖完松手落回原处，
 *    浏览器会补一发 click → "双击打开"被它误伤。表格与看板都接了，这里同样接。
 *
 * ⑤ 🔴 **`Region.paint()` 是先清宿主再渲染** → 本文件的 `el` 每次重建；
 *    所以**任何要活过重绘的东西（marquee / float / 拖动句柄）都必须挂在 `document.body`
 *    或由本对象持有并在 `dispose()` 里收掉**，否则会变成孤儿 DOM（真机上量到过 9 个）。
 */
import type { NoteEntry } from '../../core/vault-index';
import type { GridSortKey } from '../../core/settings';
import { Disposer, formatBytes, hasMod, isTouch, on } from '../../core/util';
import { asBool } from '../../services/schema';
import { btn, div, el, icon, iconBtn, span } from '../../ui/primitives';
import { dragSet, marqueeHit, normRect, type Rect } from '../board/select';
import {
  dragGhost,
  followPointer,
  isTouchPointer,
  startPointerDrag,
  TOUCH_TOLERANCE,
  wasDraggingRecently,
  type GhostGrab,
  type GhostHandle,
} from '../../ui/dnd';
import { showMenu, type MenuItem } from '../../ui/menu';
import { SCROLL_ATTR } from '../../core/view-memory';
import { insertionIndexAt, type Box } from './grid-order';
import { startEdgeScroll, type EdgeScroller } from './autoscroll';

/**
 * 单篇浮标的起手缩放 —— 与 `.kbw-gfloat` 的 CSS `transform: scale(1.04)` **同值**（改要两处一起改）。
 * 为什么要搬到 inline：`.kbw-gfloat` 的 CSS scale 会被跟手写的 inline transform **整个覆盖**
 * ——不并进同一串的话起手跳一下、缩放丢失（F4 那笔账的另一半，P7.23 修）。
 */
const FLOAT_SCALE = 1.04;

/**
 * 网格里的**文件夹格子**（B3，用户 2026-09-27 提："新增文件夹图标，点击整个知识库文件夹，
 * 里面文件按文件夹分好类后显示"）。
 *
 * 口径（与目录树**同一份**，别另算一遍）：
 *   · 候选 = `buildTree()` 里当前目录的**子节点** —— 数字口径也一样（含子目录的笔记数）；
 *   · **搜索/筛选生效时不画**（那时文件夹是噪音，而且"文件夹不匹配搜索词"）；
 *   · 它是**导航不是笔记**：不参与框选、不被拖动、不进选择集；
 *   · 但它**可以是落点** —— 把笔记拖到文件夹图标上 = 搬到那个目录（`data-drop` 与目录树同一个口径）。
 */
export interface GridFolder {
  /** 相对库根 */
  dir: string;
  name: string;
  /** 该目录下的笔记数（含子目录）—— 与目录树上那个数字同一份 */
  count: number;
}

export interface GridOpts {
  /** 要显示的笔记（**顺序已定**：自动排列走排序规则，否则走手动顺序表） */
  entries: NoteEntry[];
  /** 当前目录下的子目录（B3）：文件夹格子排在笔记**前面**；不传/空 = 不画 */
  folders?: GridFolder[];
  /** 点文件夹格子 = 进那个目录（改 `dir`，面包屑与目录树跟着走） */
  onOpenDir?: (dir: string) => void;
  /** 右键文件夹格子 = 目录菜单（P6b ②：在系统资源管理器打开 / 重命名 / 删除空目录…） */
  onFolderMenu?: (dir: string, evt: MouseEvent) => void;
  /**
   * 当前选中集。
   *
   * 🔴 **必须是函数（现取），不能是一个 Set 快照**（P6 用例逮到的真缺陷）：
   * 选中变化**不重画列表**（只就地切 class，为了保住滚动）—— 于是渲染那一刻传进来的
   * 那个 Set 会**当场过期**。拿它做判断的地方全会错：
   *  · "长按这一格要不要补进选择" → 快照里有它 → **跳过** → 用户看着没选中；
   *  · "拖的是单篇还是一组"（`dragSet`）→ 快照里还留着上一次的两篇 → 明明只拖一篇，
   *    却走了多选那条路（没有浮标、只有一个小药丸）。
   * 两处症状都像"随机抽风"，其实是同一个根因。
   */
  selected: () => ReadonlySet<string>;
  cursor: string | null;
  /** 自动排列的勾选态（§3.5 的勾选框） */
  autoArrange: boolean;
  sort: { key: GridSortKey; dir: 'asc' | 'desc' };
  /** 触屏选择模式（常驻态；桌面永远 false） */
  selectMode: boolean;
  hasSelection: boolean;

  onOpen(e: NoteEntry): void;
  onCellClick(e: NoteEntry, evt: MouseEvent): void;
  onCellMenu(e: NoteEntry, evt: MouseEvent): void;
  onSort(key: GridSortKey): void;
  onAutoArrange(next: boolean): void;
  /** 网格内换位（落点算完之后）：给出屏幕上的新顺序与被拖的那几篇 */
  onReorder(visNew: string[], moving: string[]): void;
  /** 拖到左侧目录节点 → 搬文件（走 mover，与表格那边同一条链） */
  onMoveToDir(paths: string[], dir: string): void;
  /** 拖动掠过目录树时的目标高亮（复用 `dragDir` 那套） */
  onDragDir(dir: string | null, count: number): void;
  /**
   * **拖动真的开始了 / 结束了**（P7.1c ③）：模块靠它把工具条切到"面包屑让位"那一档
   * —— 拖动期间要能把笔记拖到面包屑上（否则工具条被批量栏顶着，面包屑根本不在 DOM 里）。
   * ⚠️ 只在**越过阈值/长按成立之后**才报 true（pointerdown 不算——那一发可能只是次单击）。
   */
  onDragActive?: (active: boolean) => void;
  /** 框选结束 → 把结果交给模块写进 store（**松手才提交**，见下方注释） */
  onMarquee(paths: string[], additive: boolean): void;
  onSelectMode(next: boolean): void;
  /** 空态元素（列表为空时显示） */
  empty?: HTMLElement;
}

export interface GridHandle {
  el: HTMLElement;
  /**
   * **取消文件夹那一格的选中**（P6b ②）。
   *
   * ⚠️ 为什么由**调用方**来喊，而不是网格自己在 `inner` 上听 `click`：
   * 空白处的判定（"哪些算控件、哪些算空白"）在两处各写一遍必然漂 ——
   * 「点空白取消选中」这一套已经在 `notes/index.ts` 的 `listHost` 上有一套完整的
   * 排除名单（表格头 / 排序条 / 状态行 / 空态…），网格只是**多一种要清的东西**。
   */
  clearFolderSelection(): void;
  cellFor(path: string): HTMLElement | null;
  scrollCellIntoView(path: string): void;
  /** 只改选中/光标（不重画 —— 与表格那边 `paintSelection` 同一条理由：保住滚动） */
  setSelection(selected: ReadonlySet<string>, cursor: string | null): void;
  /**
   * 只改"选择模式"这一个 class，**同样不重画**。
   *
   * 🔴 为什么它不能走 store → 重绘那条路：长按进选择模式发生在**手势进行中**，
   * 而重绘会 `dispose()` 掉本对象 —— 而它手里攥着这次手势的 `stopDrag`，
   * `dispose` 一调就把拖动**当场取消**（"长按之后就没反应了"）。
   */
  setSelectMode(on: boolean): void;
  dispose(): void;
}

/** 一格的 DOM（也用于克隆成"跟着光标走"的浮标） */
function buildCell(e: NoteEntry, opts: GridOpts): HTMLElement {
  const cell = div({
    cls: [
      'kbw-gcell',
      'kbw-hover-1',
      // 隐藏的笔记：**淡出但不消失**（与表格那边 `rowAttrs` 的 is-dimmed 同一条口径，P1 定的）
      asBool(e.props['隐藏']) ? 'is-dimmed' : null,
    ],
    data: e.isTemplate ? { path: e.path, tpl: '1' } : { path: e.path },
    attr: { role: 'option', tabindex: '-1', 'aria-label': e.basename, title: e.path },
  });
  // v2 · #5：模板格子**不画复选框**（看得见、不进批量；与表格档 `columns.ts` 的 `checkCell` 同一口径）
  if (!e.isTemplate) {
    cell.appendChild(
      span(
        { cls: 'kbw-gcb' },
        el('input', {
          cls: 'kbw-rowcheck',
          attr: { type: 'checkbox', 'aria-label': `选择 ${e.basename}`, 'data-path': e.path },
        }),
      ),
    );
  }
  // ⋯（只在选择模式下出现）：触屏没有右键，单篇菜单从这里进（§4.2 / 排查报告 #13 的拍板）
  cell.appendChild(
    iconBtn('more-horizontal', `「${e.basename}」的更多操作`, (evt) => {
      evt.stopPropagation();
      opts.onCellMenu(e, evt);
    }, { size: 14, cls: 'kbw-gmore' }),
  );
  const thumb = div({ cls: 'kbw-gthumb' });
  thumb.appendChild(icon('file', 24));
  cell.appendChild(thumb);
  cell.appendChild(div({ cls: 'kbw-gname', text: e.basename }));
  cell.appendChild(div({ cls: 'kbw-gsize', text: formatBytes(e.size) }));
  return cell;
}

/**
 * 文件夹格子的 DOM。
 * ⚠️ **没有 `data-path`**（那是"笔记"的标志）：`gridBoxes()` 按它取框选命中的格子、
 * `cellFor/setSelection` 也按它找人 —— 少这一个属性，它就自动落在"导航"那一侧，
 * 不用在框选/拖动那几处各自再加一个"这个不算"的判断（那种写法必然漏掉一处）。
 * ⚠️ 但**有 `data-drop`**：拖笔记掠过它、松手落在它上面 = 搬到那个目录 ——
 * 与目录树节点同一个口径，走的也是同一条 `onMoveToDir` → mover。
 */
function buildFolderCell(f: GridFolder, opts: GridOpts, select: (dir: string | null) => void): HTMLElement {
  const cell = div({
    cls: ['kbw-gcell', 'is-folder', 'kbw-hover-1'],
    data: { drop: f.dir, dir: f.dir },
    attr: { role: 'button', tabindex: '0', 'aria-label': `文件夹 ${f.name}`, title: f.dir },
  });
  const thumb = div({ cls: 'kbw-gthumb' });
  thumb.appendChild(icon('folder', 24));
  cell.appendChild(thumb);
  cell.appendChild(div({ cls: 'kbw-gname', text: f.name }));
  cell.appendChild(div({ cls: 'kbw-gsize', text: `${f.count} 篇` }));
  const open = (): void => opts.onOpenDir?.(f.dir);
  /**
   * **Windows 式**（P6b ②，用户原话："文件夹**左键双击打开**，右键打开菜单…参考 windows"）：
   *  · 桌面：**单击 = 选中**（`.kbw-gcell.is-selected`，与笔记格子同一套视觉），**双击 = 进入**；
   *  · **触屏单击直接进**：触屏没有"选中"这个中间态（Windows 触摸也是这个口径），
   *    而"点一下没反应"在触屏上是最难解释的症状。
   * ⚠️ 判据走 `isTouch()`（= `body.is-mobile`，**不看视口宽度、也不看 UA** —— S4 平板实测的教训）。
   */
  cell.addEventListener('click', (evt) => {
    if (wasDraggingRecently()) return; // 拖完补的那一发 click 不算（同 §3.5 纪律 ④）
    if (isTouch()) open();
    else select(f.dir);
    evt.stopPropagation(); // 别让"点空白 = 取消选中"那一套跟着跑
  });
  cell.addEventListener('dblclick', (evt) => {
    if (wasDraggingRecently()) return;
    if (isTouch()) return; // 触屏上单击已经进去了，第二下不该再"进入一次"
    evt.preventDefault();
    open();
  });
  cell.addEventListener('contextmenu', (evt) => {
    // 右键即选中（Windows 手感，与表格行、卡片同一口径）
    select(f.dir);
    opts.onFolderMenu?.(f.dir, evt as MouseEvent);
  });
  cell.addEventListener('keydown', (evt) => {
    const k = evt as KeyboardEvent;
    // 键盘等价物（可达性）：Enter = 进入（与双击等价）、Space = 选中
    if (k.key === 'Enter') {
      k.preventDefault();
      open();
    } else if (k.key === ' ') {
      k.preventDefault();
      select(f.dir);
    }
  });
  return cell;
}

export function renderGrid(opts: GridOpts): GridHandle {
  const root = div({ cls: 'kbw-gridwrap' });
  /** 首帧用的那一份（**仅此一次**；之后一律走 `opts.selected()` 现取 —— 理由见接口注释）*/
  const initialSel = opts.selected();
  const d = new Disposer();
  const cells = new Map<string, HTMLElement>();
  /** 文件夹格子（**不并进 `cells`**：那一份的语义是"笔记"，选择/框选/换位全按它走） */
  const folderCells = new Map<string, HTMLElement>();
  /**
   * **被选中的那个文件夹**（P6b ②）。**只活在本对象里**（一个 DOM class，不进 store）：
   * 它是"准备双击/右键的那一格"的临时态，与笔记选择集是两回事（后者要驱动工具条与批量栏，
   * 进 store；这个只是就地高亮一下）。重绘（切档/换目录）时它自然跟着没了 —— 正确。
   */
  let selDir: string | null = null;
  /** 拖动掠过中的文件夹（就地贴 class —— 重绘会掐断拖动，不能走 store） */
  let dropDir: string | null = null;
  let marquee: HTMLElement | null = null;
  let stopMarquee: (() => void) | null = null;
  let stopDrag: (() => void) | null = null;
  let ghost: GhostHandle | null = null;
  let floatEl: HTMLElement | null = null;
  let gapEl: HTMLElement | null = null;
  /**
   * 单篇浮标的**跟手器**（P7.23；beginDrag 造、endDrag 收 —— 与 floatEl 同生命周期）。
   * 浮标收掉时元素被 remove，`will-change` 随元素一起去，不必单独摘。
   */
  let floatFollow: { move(x: number, y: number): void; stop(): void } | null = null;
  /**
   * **让位几何缓存**（P7.23）：静态格布局盒 —— `null` = 下次 `moveGap` 重测。
   * 为什么要有：布局直读（`offset*`）+ 上一帧写过的样式 = 每次首读都**强制回流**，
   * 拖一格时每发 pointermove 都来一轮（"读→写→读→写"链）→ 掉帧 → 浮标追不上手。
   * 缓存的刷新点只有两个：① `flip` 的返回值（post-insert 布局，提交后必刷）；
   * ② 拖动期间容器滚动 → 视口坐标整体平移 → `scroll` 里置 null 作废。
   */
  let gapBoxes: Box[] | null = null;
  /** 拖动期间挂的 scroll 监听（作废缓存用；endDrag 摘） */
  let offGapScroll: (() => void) | null = null;
  let draggingPaths: string[] = [];
  /** 拖到网格边缘时的自动滚动（P7.1c ⑥；beginDrag 起、endDrag 收） */
  let edge: EdgeScroller | null = null;

  // ── 排序条 ───────────────────────────────────────────────────
  const bar = div({ cls: 'kbw-sortbar' });
  bar.appendChild(span({ cls: 'kbw-sortbar-lb', text: '排序' }));
  const SORT_LABEL: Record<GridSortKey, string> = { name: '名称', mtime: '修改日期', size: '大小' };
  /**
   * 🔴 **自由摆放时这个下拉置灰**（独立审查 F2）：那时显示顺序由**顺序表**说了算，
   * `gridSort` 被完全忽略 —— 留着能点就是"点了没反应"（本项目最烦的症状）。
   * 与「网格档不画『列』按钮」是同一条纪律的两次应用：**改不动就别留个入口**。
   */
  const sortBtn = btn({
    cls: ['kbw-btn', 'is-small', 'kbw-hover-1', opts.autoArrange ? null : 'is-off'],
    attr: {
      'aria-label': '排序方式',
      disabled: opts.autoArrange ? undefined : true,
      title: opts.autoArrange
        ? '排序方式'
        : '现在是自由摆放，按你摆的顺序排。勾上「自动排列」才能按这里选的规则排',
    },
  });
  sortBtn.appendChild(span({ text: SORT_LABEL[opts.sort.key] }));
  sortBtn.appendChild(span({ cls: 'kbw-sortcar', text: opts.sort.dir === 'asc' ? '↑' : '↓' }));
  sortBtn.addEventListener('click', () => {
    if (!opts.autoArrange) return;
    const items: MenuItem[] = (Object.keys(SORT_LABEL) as GridSortKey[]).map((k) => ({
      kind: 'item',
      label: SORT_LABEL[k],
      control: { type: 'radio', checked: opts.sort.key === k, group: 'grid-sort' },
      // 点当前这一项 = 反向（与表头「点同一列反向」同一条手感）
      run: () => opts.onSort(k),
    }));
    const r = sortBtn.getBoundingClientRect();
    showMenu({ x: r.left, y: r.bottom }, { scope: { kind: 'section', label: '排序方式', icon: 'arrow-up-down' }, items });
  });
  bar.appendChild(sortBtn);

  const chk = div({
    cls: ['kbw-chk', opts.autoArrange ? 'is-on' : null],
    attr: { role: 'checkbox', 'aria-checked': opts.autoArrange ? 'true' : 'false', tabindex: '0' },
  });
  chk.appendChild(el('i'));
  chk.appendChild(span({ text: '自动排列' }));
  const toggleArrange = (): void => opts.onAutoArrange(!opts.autoArrange);
  chk.addEventListener('click', toggleArrange);
  chk.addEventListener('keydown', (evt) => {
    const k = evt as KeyboardEvent;
    if (k.key === ' ' || k.key === 'Enter') {
      k.preventDefault();
      toggleArrange();
    }
  });
  bar.appendChild(chk);

  bar.appendChild(div({ cls: 'kbw-sp' }));
  /**
   * 提示只在**非触屏**显示：触屏上没有"在空白处拖拽"这个习惯（§3.5 表下约束 ②），
   * 那边是长按进选择模式 —— 写着这句话只会让人试了不灵。
   */
  if (!isTouch()) {
    bar.appendChild(span({ cls: 'kbw-sortbar-hint', text: '在空白处拖出矩形即可框选' }));
  }
  root.appendChild(bar);

  // ── 网格体 ───────────────────────────────────────────────────
  /**
   * `data-scroll` 贴在这里（键另起一个 `grid`，**不蹭 `list`**）：
   * 网格是**另一个滚动容器**（表格那边滚的是 `listHost` 自己）。
   * 两边同键的话，从详细信息切到网格会拿表格的 scrollTop 去写网格，两边都别扭。
   */
  const body = div({ cls: 'kbw-grid', attr: { [SCROLL_ATTR]: 'grid' } });
  const inner = div({ cls: 'kbw-grid-inner' });
  body.appendChild(inner);

  /**
   * 文件夹格子**排在最前**（用户 2026-09-27 拍板：混排、文件夹在前）——
   * "先看有哪些分类，再看这一层的笔记"，与文件管理器的习惯一致。
   */
  const folders = opts.folders ?? [];
  /** 唯一改法：把 class 从旧的那格挪到新的那格（`null` = 全撤） */
  const selectFolder = (dir: string | null): void => {
    selDir = dir;
    for (const [d, el2] of folderCells) el2.classList.toggle('is-selected', d === dir);
  };
  for (const f of folders) {
    const cell = buildFolderCell(f, opts, selectFolder);
    inner.appendChild(cell);
    folderCells.set(f.dir, cell);
  }

  /**
   * 选中态/光标在格子上的**唯一画法** —— 构建收尾与 `setSelection` 走同一份。
   *
   * 🔴 **勾选框的 `checked` 必须在这里一起刷**（P7.23 修的 M1；用户报的
   * "网格里勾到两个以后再勾，之前选中的被取消勾选"的机制一半）：
   * 模块订阅里那道 `paintSelection` **只在 `selected`/`cursor` 引用变化时**才跑，
   * 而"因别的 key 变化而重建"的重绘（`paintRev`/排序/自动排列/切目录…）不走它 ——
   * 构建器要是只画 class、不画勾选框，重建后就是"格子看着选中、框是空的"。
   * **纪律：任何重建之后，DOM 勾选态 == 选中态。**
   */
  const paintSelectionDom = (selected: ReadonlySet<string>, cursor: string | null): void => {
    for (const [path, cell] of cells) {
      cell.classList.toggle('is-selected', selected.has(path));
      cell.classList.toggle('is-cursor', cursor === path);
      const cb = cell.querySelector<HTMLInputElement>('.kbw-rowcheck');
      if (cb) cb.checked = selected.has(path);
    }
  };
  // 空态只在"既没有笔记也没有文件夹"时出现 —— 有文件夹却写着"这里还没有笔记"是自相矛盾
  if (opts.entries.length === 0 && folders.length === 0 && opts.empty) {
    inner.appendChild(opts.empty);
  }
  for (const e of opts.entries) {
    const cell = buildCell(e, opts);
    if (opts.selectMode) cell.classList.add('is-selectmode');
    installCellHandlers(cell, e, opts, () => wasDraggingRecently());
    inner.appendChild(cell);
    cells.set(e.path, cell);
  }
  /**
   * **构建收尾：初始选中/光标完整刷一遍**（P7.23 修的 M1，下面的 `paintSelectionDom`）。
   * 🔴 别退回"在循环里只加 class"那种写法 —— 勾选框会漏（就是用户报的
   * "之前勾的被取消勾选"的机制一半）。收尾统一刷 = 保任何重建之后 DOM 勾选态 == store。
   */
  paintSelectionDom(initialSel, opts.cursor);
  root.appendChild(body);

  // ── 状态行 ───────────────────────────────────────────────────
  const status = div({ cls: 'kbw-gstatus' });
  /**
   * 左边这一句顺带当**模式指示**：自动排列关掉之后显示"· 自由摆放"。
   * 为什么不是弹一条通知：拖一下就弹一次会烦，而"现在是哪个模式"是一件**常驻**的事，
   * 常驻的事就该有个常驻的落点（顺带解释"为什么它不按名称排了"）。
   */
  // 有文件夹格子时把它的条数也报出来（只写"共 0 项"而屏幕上有三个文件夹是会吓人的）
  const folderNote = folders.length > 0 ? ` · ${folders.length} 个文件夹` : '';
  const statusLeft = span({
    text:
      (opts.autoArrange ? `共 ${opts.entries.length} 项` : `共 ${opts.entries.length} 项 · 自由摆放`) +
      folderNote,
  });
  status.appendChild(statusLeft);
  status.appendChild(div({ cls: 'kbw-sp' }));
  const statusRight = span({ cls: 'kbw-gstatus-tail' });
  status.appendChild(statusRight);
  root.appendChild(status);

  const paintStatus = (label = ''): void => {
    statusRight.textContent = label;
  };
  if (opts.hasSelection) paintStatus(`已选 ${initialSel.size} 项`);

  /** 选择模式这一个 class 的**唯一改法**（理由见 `GridHandle.setSelectMode` 的注释） */
  const applySelectMode = (on: boolean): void => {
    for (const cell of cells.values()) cell.classList.toggle('is-selectmode', on);
  };

  /**
   * 触屏：**点空白处退出选择模式**（iOS 相册那条路子的"点外面取消"）。
   * 用 `click` 而不是 `pointerdown`：拖滚网格时不该顺手把模式退掉。
   */
  d.add(
    on(inner, 'click', (evt) => {
      if (!opts.selectMode) return;
      const t = evt.target as HTMLElement | null;
      if (t?.closest?.('.kbw-gcell, button, input')) return;
      opts.onSelectMode(false);
    }),
  );

  // ── 框选（§3.5；桌面专用）────────────────────────────────────
  /**
   * 触屏不接框选：那里"在空白处拖"是**滚网格**的手势，抢过来网格就没法滚了
   *（与看板 `startMarquee` 同一条理由）。
   */
  if (!isTouch()) {
    d.add(
      on(inner, 'pointerdown', (evt) => {
        const e = evt as PointerEvent;
        if (e.button !== 0) return;
        if (isTouchPointer(e)) return;
        const t = e.target as HTMLElement | null;
        // 起点必须在空白（不是图标上）：格子上按下有它自己的活（选中 / 拖动）
        if (t?.closest?.('.kbw-gcell, button, input, .kbw-empty')) return;
        startMarquee(e);
      }),
    );
  }

  function startMarquee(down: PointerEvent): void {
    const start = { x: down.clientX, y: down.clientY };
    /** 起手时的修饰键决定"并集还是替换" —— 松手时再问就晚了（指针在框里） */
    const additive = hasMod(down) || down.shiftKey;
    const box = div({ cls: 'kbw-marquee' });
    /**
     * 🔴 **第一帧就归零到触点**（纪律 ①）：`place(start)` 必须在挂上去**之前**跑完，
     * 否则第一个可见帧会带着一个没有尺寸的默认框 —— S4 手机实测的"残影"就是这个。
     */
    const place = (x: number, y: number): void => {
      const r = normRect(start, { x, y });
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
    };
    place(start.x, start.y);
    /** 起手时的选择（并集模式要带上它）—— 框选期间只在 DOM 上预览，松手才写 store */
    const base = new Set(opts.selected());

    const preview = (x: number, y: number): string[] => {
      const hit = marqueeHit(gridBoxes(), normRect(start, { x, y }));
      const next = additive ? Array.from(new Set([...base, ...hit])) : hit;
      const set = new Set(next);
      for (const [path, cell] of cells) cell.classList.toggle('is-selected', set.has(path));
      paintStatus(`框选 ${hit.length} 项`);
      return next;
    };

    marquee = box;
    stopMarquee = startPointerDrag(down, 0, {
      onStart: (c) => {
        document.body.appendChild(box);
        place(c.x, c.y);
        preview(c.x, c.y);
      },
      onOver: (_t, c) => preview(c.x, c.y),
      onDrop: (_t, c) => {
        /**
         * ⚠️ **松手才提交**（不是每动一下就写 store）：工具条的 key 里有
         * `selected.length` —— 一进框选就把选中数推上去，工具条会**当场换成批量栏**，
         * 而 §3.5 的视觉稿写的是"**松手后**操作栏出现在这里"。
         * 拖动期间只用 DOM class 预览，观感一样、少一整类抖动。
         */
        const next = preview(c.x, c.y);
        box.remove();
        marquee = null;
        stopMarquee = null;
        opts.onMarquee(next, additive);
      },
      onCancel: () => {
        box.remove();
        marquee = null;
        stopMarquee = null;
        // 取消 → 把预览撤掉，恢复成起手时的样子
        for (const [path, cell] of cells) cell.classList.toggle('is-selected', base.has(path));
        paintStatus('');
      },
    });
  }

  /** 各格当前的视口矩形（框选与换位都用它；拿不到的跳过）*/
  function gridBoxes(): { path: string; rect: Rect }[] {
    const out: { path: string; rect: Rect }[] = [];
    for (const [path, cell] of cells) {
      // v2 · #5：模板格子不参与框选（预览高亮与「框选 N 项」都不算它）
      if (cell.dataset.tpl === '1') continue;
      const r = cell.getBoundingClientRect?.();
      if (!r) continue;
      out.push({ path, rect: r });
    }
    return out;
  }

  // ── 拖动（网格内换位 / 拖到目录树）─────────────────────────────
  function installCellHandlers(cell: HTMLElement, e: NoteEntry, o: GridOpts, swallow: () => boolean): void {
    cell.addEventListener('click', (evt) => {
      // 拖完补的那一发什么都不算（含勾选框区 —— 松手点正好落在别人角上也不许翻框）
      if (swallow()) return;
      const t = evt.target as HTMLElement | null;
      /**
       * **勾选框区（`.kbw-gcb`）= "点框"语义**（P7.23 · Q7 拍板：加大命中区、语义不变）。
       * 区加大到 29×29 之后，落点常常是框周围的留白 —— 原生激活只在点在 `input`
       * 自身上时才发生，留白那部分由这里补一次翻转 + `change`（委托据此改选择集）。
       * ⚠️ 点在 `input` 自身时**别补**：原生点击已经翻过一次并会补发 `change`，
       * 再翻一次 = 翻重、勾不上（jsdom 的合成 click 同样跑完整激活行为，实测过）。
       * 这一支**先于**下面的排清单：它要自己处理，不是"排掉不管"。
       */
      const gcb = t?.closest?.('.kbw-gcb');
      if (gcb) {
        const box = gcb.querySelector<HTMLInputElement>('.kbw-rowcheck');
        if (box && t !== box) {
          box.checked = !box.checked;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
      /**
       * ⚠️ `.kbw-inline-input` 也要排掉（P7.1c · ①）：改名输入框就挂在 `.kbw-gname` 里，
       * 点它是"点光标位置"，不该当成"点这一格"（会顺手改选择集 —— 而改名中改选择集
       * 观感上就是"点了没反应"）。
       */
      if (t?.closest?.('.kbw-gmore, .kbw-inline-input')) return;
      o.onCellClick(e, evt as MouseEvent);
    });
    cell.addEventListener('dblclick', (evt) => {
      if (swallow()) return;
      const t = evt.target as HTMLElement | null;
      // 双击输入框 = 选词，不是"打开这篇"（不挡的话 F2 改名时双击输入框会把笔记打开）
      if (t?.closest?.('.kbw-inline-input')) return;
      // 勾选框区双击 ≠ 打开（P7.23：区加大后连点的容错空间要跟上 —— 翻两下正好抵消，
      // 不该顺手把这篇打开；Windows 资源管理器同款口径）
      if (t?.closest?.('.kbw-gcb')) return;
      evt.preventDefault();
      o.onOpen(e);
    });
    cell.addEventListener('contextmenu', (evt) => {
      if (swallow()) return;
      o.onCellMenu(e, evt as MouseEvent);
    });
    cell.addEventListener('pointerdown', (evt) => onCellPointerDown(evt as PointerEvent, e, o));
  }

  function onCellPointerDown(down: PointerEvent, e: NoteEntry, o: GridOpts): void {
    if (down.button !== 0) return;
    const t = down.target as HTMLElement | null;
    if (t?.closest?.('.kbw-gmore, .kbw-inline-input')) return;
    /**
     * **就地改名进行中 → 不起拖动**（P7.1c · ① 的边界：改名进行中要挡住拖动）。
     * 这一发 pointerdown 之后焦点会离开输入框 → blur → 提交改名（`finish(true)`）；
     * 提交完列表重画，这次手势不带任何拖动，干净。
     * ⚠️ 用 DOM 现查而不是要一个"改名中"的 opt：输入框在不在 DOM 里就是事实本身。
     */
    if (inner.querySelector('.kbw-inline-input')) return;
    /**
     * 勾选框区自己处理：**既不起拖动、也不改选择**（勾选由 click/change 那两条路管）。
     * P7.23 起排的是整个 29×29 的区（`.kbw-gcb`）——与点击守卫同一口径（加大命中区后
     * 区里的留白也算"框"）。与表格那条 `closest('input, .kbw-rowcheck, …') → return`
     * 同一个口径 —— 同一屏两档两种手感是独立审查 🟢9 指的。
     */
    if (t?.closest?.('.kbw-gcb')) return;
    // v2 · #5：模板格子**不可拖**（看得见、不进批量；菜单里的单篇操作照旧）
    if (e.isTemplate) return;
    const ctrlLike = hasMod(down) || down.shiftKey;

    /**
     * **已经选中的格子里按下 → 不动选择**（拖整组）；没选中的 → 先只选它。
     * 桌面 + 触屏同一条：`dragSet` 的口径就是"拖的那张本来就在选择里就搬整组"。
     */
    if (!ctrlLike && !o.selected().has(e.path)) {
      o.onCellClick(e, down as unknown as MouseEvent);
    }

    /**
     * 长按双模式的中间态（纪律 ③）：触屏长按成立时先当"要进选择模式"，
     * 一旦真的移动了再改判成拖动 —— 见 `onOver`。
     */
    let pendingSelect = false;
    let enteredSelect = false;

    stopDrag?.();
    stopDrag = startPointerDrag(down, e, {
      onStart: (c) => {
        if (c.touch) {
          pendingSelect = true;
          /** 立即给反馈：进入选择模式（图标冒复选框）—— 松手不动就留在这儿 */
          if (!o.selectMode) {
            enteredSelect = true;
            applySelectMode(true);
            o.onSelectMode(true);
          }
          /**
           * 长按那一格**加进选择** —— 走"并集"（`onMarquee([path], true)`），
           * 不用 `onCellClick`：后者在**选择模式**下是 `toggleSelected`（切一下），
           * 而长按的语义是"把这一格拿起来"，已经选中的格子再长按**不该被取消**。
           * 并集是幂等的，按几次都一样。
           */
          o.onMarquee([e.path], true);
          o.onDragDir(null, 0);
          return;
        }
        beginDrag(e, c.x, c.y);
      },
      onOver: (target, c) => {
        if (pendingSelect) {
          const dist = Math.hypot(c.x - down.clientX, c.y - down.clientY);
          // 长按之后真的动了 → 这是**拖动**，不是选择（§3.5 的第二行）
          if (dist <= TOUCH_TOLERANCE) return;
          pendingSelect = false;
          if (enteredSelect) {
            enteredSelect = false;
            applySelectMode(false);
            o.onSelectMode(false);
          }
          beginDrag(e, c.x, c.y);
          return;
        }
        moveDrag(target, c.x, c.y);
      },
      onDrop: (target, c) => {
        if (pendingSelect) {
          // 长按不动就松手 = 进选择模式，别的什么都不做
          pendingSelect = false;
          endDrag();
          return;
        }
        finishDrag(target, c.x, c.y);
      },
      onCancel: () => {
        if (pendingSelect && enteredSelect) {
          applySelectMode(false);
          o.onSelectMode(false);
        }
        pendingSelect = false;
        endDrag();
      },
    });
  }

  /** 拖动真的开始了：起浮标 + 给原位留一个空档 */
  function beginDrag(e: NoteEntry, x: number, y: number): void {
    /**
     * **拖的那格本来就在选择里 → 搬整组**（Windows/资源管理器的口径，也是"想拖一组"
     * 最自然的动作）。走 `modules/board/select.ts` 的共享算子 —— 看板那边是同一份，
     * 两屏各写一遍迟早漂（c 期独立审查 🟢12 那条纪律）。
     */
    draggingPaths = dragSet(
      opts.entries.map((n) => n.path),
      Array.from(opts.selected()),
      e.path,
    );
    const cell = cells.get(e.path);
    if (cell && draggingPaths.length === 1) {
      /**
       * 单篇：**图标本身跟着光标走**（视觉稿 `s-desk` 的"拖动中的图标跟随光标"）。
       * 克隆一份挂到 body 上（固定定位），原格 `display:none` 退出流，
       * 空出来的位置交给 `gapEl`（虚线空位）—— 这样"目标位置空出来"是真的空出来。
       */
      const r = cell.getBoundingClientRect();
      const clone = cell.cloneNode(true) as HTMLElement;
      clone.classList.remove('is-selected', 'is-cursor', 'is-selectmode');
      clone.classList.add('kbw-gfloat');
      clone.style.left = `${r.left}px`;
      clone.style.top = `${r.top}px`;
      clone.style.width = `${r.width}px`;
      floatEl = clone;
      document.body.appendChild(clone);
      /**
       * **抓取偏移锁死 + 纯 transform 合帧**（P7.23；"图标不跟手"的根修）：
       * 起手这一次 rect 就是**最后一次**——之后每帧由 `followPointer` 纯算术写
       * `translate3d(...) scale(...)`，**浮标更新路径里不出现任何布局读**
       *（旧写法"从当前 rect 反算增量"是自反馈：读到自己上一帧写过的 transform，
       * 浮标会在两个位置之间来回弹）。
       * ⚠️ scale 并进同一串：CSS 那份会被 inline transform 整个覆盖（见 FLOAT_SCALE 注释）。
       */
      const grab: GhostGrab = { dx: x - r.left, dy: y - r.top, left: r.left, top: r.top };
      floatFollow = followPointer(clone, grab, { scale: FLOAT_SCALE });
      floatFollow.move(x, y); // 起手同步落位（transform 从第一帧起就带着 scale）
      clone.style.willChange = 'transform'; // 拖动期间顶到合成层（元素收掉随之去）
      cell.classList.add('is-dragging');
      gapEl = div({ cls: ['kbw-gcell', 'kbw-gap'] });
      gapEl.style.height = `${r.height}px`;
      cell.parentElement?.insertBefore(gapEl, cell);
      cell.style.display = 'none';
    } else {
      ghost = dragGhost(`${draggingPaths.length} 篇`);
      ghost.move(x, y);
      for (const p of draggingPaths) cells.get(p)?.classList.add('is-dragging');
      gapEl = div({ cls: ['kbw-gcell', 'kbw-gap'] });
      const anchor = cells.get(draggingPaths[0]);
      anchor?.parentElement?.insertBefore(gapEl, anchor);
    }
    opts.onDragDir(null, 0);
    /** 工具条让位给面包屑（模块把它切到"拖动中"那一档）——拖动真的开始了才报 */
    opts.onDragActive?.(true);
    startGapCache();
    edge = startEdgeScroll(body);
  }

  /**
   * 拖动期间维护**让位几何缓存**（P7.23）：静态格布局盒平时用缓存算落点（零布局读，
   * 成本≈0）；只有"还没量过"与"滚动过"（边缘自动滚 / 滚轮 —— 视口坐标整体平移）
   * 才真的重测一次。`scroll` 监听在 endDrag 摘。
   */
  function startGapCache(): void {
    gapBoxes = null;
    offGapScroll = on(body, 'scroll', () => {
      gapBoxes = null;
    }, { passive: true });
  }

  /** 拖动中：浮标跟手 + 空档换位（+ 掠过目录树时交给模块高亮） */
  function moveDrag(target: HTMLElement | null, x: number, y: number): void {
    // 指针进入网格上/下边缘带 → 自动滚（速度 0 时它自己歇着）
    edge?.update(x, y);
    if (floatEl) {
      // 浮标跟手：只存坐标 + 合帧写 transform（P7.23）——本行**没有任何布局读**
      floatFollow?.move(x, y);
    } else {
      ghost?.move(x, y);
    }
    const dir = target?.dataset?.drop;
    markDropDir(dir ?? null);
    if (dir != null) {
      opts.onDragDir(dir, draggingPaths.length);
      return;
    }
    opts.onDragDir(null, 0);
    moveGap(x, y);
  }

  /**
   * 拖动掠过文件夹格子时的**就地高亮**。
   * ⚠️ 为什么不走 store（`dragDir` 那条）：网格的重绘会 `dispose()` 本对象 ——
   * 而它手里正攥着这次拖动，重绘等于**当场取消拖动**（`GridHandle.setSelectMode`
   * 那条注释记的是同一件事）。目录树那边可以走 store，是因为它是另一块 Region。
   */
  function markDropDir(dir: string | null): void {
    if (dropDir === dir) return;
    if (dropDir) folderCells.get(dropDir)?.classList.remove('is-drop');
    dropDir = dir;
    if (dropDir) folderCells.get(dropDir)?.classList.add('is-drop');
  }

  /**
   * 空档挪到落点。**先量 first（各格原位）→ 挪 DOM → 量 last → 反向平移再放开**，
   * 就是教科书那套 FLIP —— 走 CSS transition 而不是 WAAPI，好处是
   * `prefers-reduced-motion` 与「动效 = 减少」那档**自动生效**（`styles/base.css` 与
   * `settings.css` 里那两条规则掐的就是 transition-duration）。
   *
   * ⚠️ P7.23 起 `first` 走**缓存**（`gapBoxes`）：命中就是纯算术、零强制回流；
   * 只有"没量过 / 拖动期间滚动过"才真测。🔴 缓存刷新只在两处 —— `flip` 的返回值
   *（post-insert 布局）与 `scroll` 置 null；**别在别处拿旧缓存当"当前布局"**。
   */
  function moveGap(x: number, y: number): void {
    if (!gapEl) return;
    const staticCells = Array.from(cells.values()).filter(
      (c) => !draggingPaths.includes(c.dataset.path ?? '') && c.style.display !== 'none',
    );
    if (staticCells.length === 0) return;
    const first = gapBoxes ?? layoutBoxes(staticCells);
    gapBoxes = first;
    const idx = insertionIndexAt(first.map((b) => ({ left: b.left, top: b.top, width: b.width, height: b.height })), x, y);
    const before = staticCells[idx] ?? null;
    if (gapEl.nextSibling === before) return; // 位置没变，别白动（且布局没动，缓存照旧）
    gapEl.parentElement?.insertBefore(gapEl, before);
    gapBoxes = flip(staticCells, first);
  }

  /**
   * 各格当前的**布局**矩形（**不含 transform**），坐标换到视口系。
   *
   * 🔴 为什么不能用 `getBoundingClientRect()`（独立审查 F3）：它**把 transform 算进去**，
   * 而让位动画（下面 `flip`）走的是 **200ms 的 CSS 过渡** —— 指针每 ~16ms 就调一次
   * `moveGap`，于是量到的全是**过渡中途**的位置：落点索引会来回跳、甚至偏一位，
   * 而松手那一发 `moveGap` 距上一次只有一帧 → **提交的顺序可能与用户看到的落点差一格**。
   *
   * `offsetLeft/offsetTop/offsetWidth/offsetHeight` 是**布局值**，与 transform 无关；
   * `inner` 自己不被 transform（只有格子被），所以它的 rect 照常用来做原点换算。
   * ⚠️ 指针坐标仍然走 `clientX/clientY`（视口系）——这里换算出来的也是视口系，两边一致。
   */
  function layoutBoxes(els: HTMLElement[]): Box[] {
    const base = inner.getBoundingClientRect();
    return els.map((el) => ({
      left: base.left + el.offsetLeft,
      top: base.top + el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    }));
  }

  /**
   * FLIP：先量 `first`（调用方给的**布局**盒）→ 挪 DOM → 量 `last` → 反向平移再放开。
   *
   * 走 CSS transition 而不是 WAAPI，好处是 `prefers-reduced-motion` 与「动效 = 减少」
   * 那档**自动生效**（`styles/base.css` 与 `settings.css` 掐的就是 transition-duration）。
   * ⚠️ 两端都用布局盒：用 rect 的话，上一帧动画没走完时 `dx/dy` 会多算一截（抖动）。
   *
   * @returns `last`（**post-insert 的布局盒**）—— P7.23 起调用方拿它当下一轮的
   * 让位缓存（提交后布局变了，旧缓存必须换掉；这里反正已经量过，白拿）。
   */
  function flip(els: HTMLElement[], first: Box[]): Box[] {
    const moved: HTMLElement[] = [];
    const last = layoutBoxes(els);
    els.forEach((c, i) => {
      const f = first[i];
      const l = last[i];
      if (!f || !l) return;
      const dx = f.left - l.left;
      const dy = f.top - l.top;
      if (Math.round(dx) === 0 && Math.round(dy) === 0) return;
      c.style.transition = 'none';
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(c);
    });
    if (moved.length === 0) return last;
    // 强制回流，让"瞬移回去"这件事先落定，再把 transition 放开 → 它才会从那儿滑回来
    void root.offsetHeight;
    for (const c of moved) {
      c.style.transition = '';
      c.style.transform = '';
    }
    return last;
  }

  function finishDrag(target: HTMLElement | null, x: number, y: number): void {
    const moving = [...draggingPaths];
    const dir = target?.dataset?.drop;
    // 落点定下来（空档最后挪一次），再把真实顺序读出来
    if (dir == null && gapEl) moveGap(x, y);
    const visNew: string[] = [];
    const holder = inner;
    for (const node of Array.from(holder.children) as HTMLElement[]) {
      if (node === gapEl) {
        // 空档的位置 = 被拖那几篇的新位置；把它们的路径按当前顺序补进去
        for (const p of moving) visNew.push(p);
        continue;
      }
      const p = node.dataset?.path;
      if (p && !moving.includes(p)) visNew.push(p);
    }
    endDrag();
    if (moving.length === 0) return;
    if (dir != null) {
      opts.onMoveToDir(moving, dir);
      return;
    }
    // 空档后半段没插进去的（拖到最末尾）在这里补齐
    for (const p of moving) if (!visNew.includes(p)) visNew.push(p);
    opts.onReorder(visNew, moving);
  }

  /** 收尾：浮标 / 空档 / 被藏起来的原格 / 目录高亮 / 边缘滚动 / 跟手器与缓存，一处不留 */
  function endDrag(): void {
    floatFollow?.stop();
    floatFollow = null;
    floatEl?.remove();
    floatEl = null;
    ghost?.dispose();
    ghost = null;
    gapEl?.remove();
    gapEl = null;
    for (const p of draggingPaths) {
      const c = cells.get(p);
      if (!c) continue;
      c.classList.remove('is-dragging');
      c.style.display = '';
      c.style.transform = '';
    }
    draggingPaths = [];
    markDropDir(null);
    opts.onDragDir(null, 0);
    edge?.dispose();
    edge = null;
    gapBoxes = null;
    offGapScroll?.();
    offGapScroll = null;
    opts.onDragActive?.(false);
  }

  return {
    el: root,
    clearFolderSelection: () => {
      if (selDir != null) selectFolder(null);
    },
    cellFor: (path) => cells.get(path) ?? null,
    scrollCellIntoView: (path) => {
      const cell = cells.get(path);
      if (!cell) return;
      try {
        cell.scrollIntoView?.({ block: 'nearest' });
      } catch {
        /* jsdom 没有布局，忽略 */
      }
    },
    setSelection: (selected, cursor) => {
      paintSelectionDom(selected, cursor);
      paintStatus(selected.size > 0 ? `已选 ${selected.size} 项` : '');
    },
    setSelectMode: applySelectMode,
    dispose: () => {
      stopMarquee?.();
      stopDrag?.();
      marquee?.remove();
      marquee = null;
      floatFollow?.stop();
      floatFollow = null;
      floatEl?.remove();
      floatEl = null;
      ghost?.dispose();
      ghost = null;
      gapEl?.remove();
      gapEl = null;
      // 边缘滚动循环（stopDrag 那条路已经收过；这里再兜一道，可重复调）
      edge?.dispose();
      edge = null;
      gapBoxes = null;
      offGapScroll?.();
      offGapScroll = null;
      d.dispose();
    },
  };
}
