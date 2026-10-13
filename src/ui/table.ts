/**
 * ui/table.ts —— 表格基元（方案设计.md §7.3 预留的那一个）
 *
 * 交互规格 §3.3 要的几件事在这里落地：**排序**（同时只有一列）、**列宽可拖**
 * （桌面 ±7px 命中区 / 触屏看得见的 ≥32px 抓手柄）、**显隐列**（「列」按钮 +
 * **表头右键菜单**，P7.1）、**行选中**、**前置行**（P7.1b 的文件夹行，见 `TableOptions.topRows`）。
 * 密度（31px 详细信息 / 26px 触屏档）走外层 class，不在这里定死。
 *
 * 三条刻意的选择：
 *  ① 用**真 `<table>` + `<colgroup>`**：列宽交给 `<col>`，不用给每格写宽度，
 *     重画时宽度天然保持（顺带对读屏友好）。
 *  ② **列宽拖动不用 `setPointerCapture`**：拖动期间在 document 上监听指针，
 *     capture 会把 target 钉在起点上（与拖拽基元同一条坑）。
 *  ③ 每行**不给 tabindex**（交互规格 §1.4 的原则）：键盘走"高亮行"，
 *     不给几十行各加一个 Tab 停靠点。
 */
import { div, el } from './primitives';
import { Disposer, on } from '../core/util';

export interface Column<T> {
  id: string;
  label: string;
  /** 默认宽度（px） */
  width: number;
  /** 最小宽度（名称列 ≥120） */
  minWidth?: number;
  align?: 'left' | 'right';
  /** 不给排序函数 = 这列不能排序 */
  sortValue?: (row: T) => string | number;
  render: (row: T) => Node | string;
  /** 固定列不可隐藏（「名称」列） */
  fixed?: boolean;
  /** 表头提示（健康标记列用它写明六种含义） */
  title?: string;
}

export interface RowAttrs {
  cls?: (string | false | null | undefined)[];
  data?: Record<string, string>;
}

/** 表头右键菜单要拿的列信息（P7.1 · 2.1/D2）——只给"这一列能干什么"，菜单位置由调用方定 */
export interface HeaderMenuInfo {
  id: string;
  label: string;
  /** 能排序吗（没给 `sortValue` 的列不能 —— 如「标记」列） */
  sortable: boolean;
  /** 能隐藏吗（`fixed` = 名称列 / 结构列不能） */
  hideable: boolean;
}

export interface TableOptions<T> {
  columns: Column<T>[];
  rows: T[];
  /**
   * **前置行**（P7.1b · 2.2）：表格体最顶上、与列对齐的一排「不是数据行」的行
   *（详细档的**文件夹行**就是它 —— 导航不是笔记）。
   *
   * 口径（为什么做成通用口子而不是每种场景各写一份）：
   *  · 它是 `<tbody>` 里的真 `<tr>`：列宽/对齐由同一张表的 `<colgroup>` 说了算，
   *    **不用为它改列布局**（§3.3 那条"没为它改列布局"的要求）；
   *  · 类名是 `.kbw-frow`（**刻意不带 `.kbw-trow`**）：这样"数笔记行 / 选中集 /
   *    paintSelection / 改名 / 光标"这些既有的 `.kbw-trow` 判据**天然碰不到它** ——
   *    它不是笔记行，不该被当成笔记行去数（网格那边靠 `data-path` 缺席区分，
   *    这里靠类名区分；两边分界线一致：**没有 `data-path` 就不是笔记**）。
   *  · 交互（点击/双击/右键/键盘）由调用方通过下面的回调接 —— 基元不猜语义。
   */
  topRows?: TableTopRow<T>[];
  rowKey: (row: T) => string;
  isSelected?: (row: T) => boolean;
  isCursor?: (row: T) => boolean;
  hiddenColumns?: string[];
  columnWidths?: Record<string, number>;
  sort?: { key: string; dir: 'asc' | 'desc' } | null;
  /** 点表头（同一列再点一次 = 反向，由调用方实现） */
  onSort?: (id: string) => void;
  onColumnResize?: (id: string, width: number) => void;
  /** 表头右键（P7.1 · 2.1/D2）：排序 / 隐藏这一列 / 打开列设置… 都从这儿开 */
  onHeaderContextMenu?: (col: HeaderMenuInfo, evt: MouseEvent) => void;
  onRowClick?: (row: T, evt: MouseEvent) => void;
  onRowDoubleClick?: (row: T, evt: MouseEvent) => void;
  onRowContextMenu?: (row: T, evt: MouseEvent) => void;
  onRowPointerDown?: (row: T, evt: PointerEvent) => void;
  rowAttrs?: (row: T) => RowAttrs;
  /** 无行时显示（调用方给空态元素） */
  empty?: HTMLElement;
}

/** 前置行的一条（见 `TableOptions.topRows`）——`cell` 按**可见列**逐个被问，返回 undefined 就留空格 */
export interface TableTopRow<T> {
  /** 稳定标识（重画时认人用；不进 DOM 也可，进 `data-key` 便于排错） */
  key: string;
  cls?: (string | false | null | undefined)[];
  /** 放进 DOM 的 data-*（如 `drop` / `dir` —— 拖拽落点靠它） */
  data?: Record<string, string>;
  attrs?: Record<string, string>;
  cell: (col: Column<T>) => Node | string | undefined;
  onClick?: (evt: MouseEvent) => void;
  onDoubleClick?: (evt: MouseEvent) => void;
  onContextMenu?: (evt: MouseEvent) => void;
  onKeyDown?: (evt: KeyboardEvent) => void;
}

export interface TableHandle {
  el: HTMLElement;
  rowFor(key: string): HTMLElement | null;
  scrollRowIntoView(key: string): void;
}

export function renderTable<T>(opts: TableOptions<T>): TableHandle {
  const root = div({ cls: 'kbw-tablewrap' });
  const cols = opts.columns.filter((c) => c.fixed || !(opts.hiddenColumns ?? []).includes(c.id));

  const table = el('table', { cls: 'kbw-table' });
  const colgroup = el('colgroup');
  /** 列宽拖拽要拿到对应的 `<col>`（宽度写在它身上，重画时天然保持） */
  const colEls = new Map<string, HTMLTableColElement>();
  for (const c of cols) {
    const col = el('col', { attr: { 'data-col': c.id } });
    col.style.width = `${widthOf(c, opts.columnWidths)}px`;
    colEls.set(c.id, col);
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  // ── 表头 ──────────────────────────────────────────────────────
  const thead = el('thead');
  const headRow = el('tr');
  for (const c of cols) {
    const th = el('th', {
      cls: [
        c.align === 'right' ? 'is-right' : null,
        opts.sort?.key === c.id ? 'is-sorted' : null,
        c.sortValue ? 'is-sortable' : null,
      ],
      title: c.title ?? c.label,
      attr: { 'data-col': c.id, scope: 'col' },
    });
    const label = div({ cls: 'kbw-th-label' });
    label.appendChild(div({ cls: 'kbw-th-text', text: c.label }));
    if (opts.sort?.key === c.id) {
      label.appendChild(div({ cls: 'kbw-th-dir', text: opts.sort?.dir === 'asc' ? '↑' : '↓' }));
    }
    th.appendChild(label);
    if (c.sortValue && opts.onSort) {
      th.addEventListener('click', (evt) => {
        if ((evt.target as HTMLElement).closest?.('.kbw-col-grip')) return;
        opts.onSort?.(c.id);
      });
    }
    /**
     * 表头右键（P7.1 · 2.1/D2）：**接住原生菜单**（`preventDefault`）再开我们的。
     * `contextmenu` 与排序那条 `click` 互不打扰（右键不产生 click）；
     * 「不可用项置灰而不是隐藏」的规矩由菜单那一侧（`showHeaderMenu`）执行 ——
     * 这里只报"这一列能干什么"（`sortable` / `hideable`），不替它做判断。
     */
    if (opts.onHeaderContextMenu) {
      th.addEventListener('contextmenu', (evt) => {
        evt.preventDefault();
        opts.onHeaderContextMenu?.(
          { id: c.id, label: c.label, sortable: !!c.sortValue, hideable: !c.fixed },
          evt,
        );
      });
    }
    // 列宽抓手：桌面是 ±7px 的细命中区（CSS 给宽度），触屏是看得见的 32px 柄
    const grip = div({
      cls: 'kbw-col-grip',
      attr: {
        role: 'separator',
        'aria-label': `调整「${c.label}」列宽（双击 = 按内容自适应）`,
        'aria-orientation': 'vertical',
      },
    });
    const colEl = colEls.get(c.id);
    if (colEl) grip.addEventListener('pointerdown', (evt) => startColumnResize(evt, c, grip, colEl, opts));
    /**
     * **双击 = 按内容自适应**（P7.1c ⑦ · 合集 17.9③，Windows/Excel 习惯）。
     * ⚠️ 与拖动**不冲突**：双击的头两下 pointerdown 会让 `startColumnResize` 跑两趟、
     * 但 `moved=false` 本就不落盘（`finish` 里那一条），接着这发 `dblclick` 才落盘。
     * ⚠️ "取数"（`measureColumnContent`，要真布局）与"算宽"（`fitWidthOf`，纯函数）
     * 刻意拆开 —— jsdom 量不到布局，离线只测纯函数那一半；真机几何由探针钉
     *（双击窄列 → 宽到刚好放下）。
     */
    grip.addEventListener('dblclick', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      /**
       * ⚠️ 表已经重画过（这个抓手是**游离节点**）就别量了：`getBoundingClientRect`
       * 在脱离文档的树上全是 0，算出来是 min 宽，白落一次盘（探针实测：拖动列宽
       * 触发的重画会让"手里的旧抓手"变成死者；真人点不到游离元素，这是给合成事件的守卫）。
       */
      if (!root.isConnected) return;
      const w = fitWidthOf(measureColumnContent(root, c.id), c.minWidth ?? 60, MAX_COL_W);
      opts.onColumnResize?.(c.id, w);
    });
    th.appendChild(grip);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  // ── 表体 ──────────────────────────────────────────────────────
  const tbody = el('tbody');
  /**
   * **前置行**（P7.1b · 2.2：详细档的文件夹行）——排在最前、与列对齐。
   * ⚠️ 刻意**不挂 `.kbw-trow`**（`TableOptions.topRows` 那段写了理由：既有的
   * "数笔记行 / 选中集 / paintSelection" 判据一个都不该碰到它）。
   */
  for (const tr of opts.topRows ?? []) {
    const row = el('tr', {
      cls: ['kbw-frow', 'kbw-hover-1', ...(tr.cls ?? [])],
      data: { ...(tr.data ?? {}), key: tr.key },
      attr: tr.attrs ?? {},
    });
    for (const c of cols) {
      const td = el('td', { cls: [c.align === 'right' ? 'is-right' : null], data: { col: c.id } });
      const content = tr.cell(c);
      if (typeof content === 'string') td.textContent = content;
      else if (content) td.appendChild(content);
      row.appendChild(td);
    }
    if (tr.onClick) row.addEventListener('click', tr.onClick);
    if (tr.onDoubleClick) row.addEventListener('dblclick', tr.onDoubleClick);
    if (tr.onContextMenu) row.addEventListener('contextmenu', tr.onContextMenu);
    if (tr.onKeyDown) row.addEventListener('keydown', tr.onKeyDown);
    tbody.appendChild(row);
  }
  const index = new Map<string, HTMLElement>();
  for (const row of opts.rows) {
    const key = opts.rowKey(row);
    const attrs = opts.rowAttrs?.(row) ?? {};
    const tr = el('tr', {
      cls: ['kbw-trow', 'kbw-hover-1', ...(attrs.cls ?? [])],
      data: { ...(attrs.data ?? {}), row: key, path: key },
    });
    if (opts.isSelected?.(row)) tr.classList.add('is-selected');
    if (opts.isCursor?.(row)) tr.classList.add('is-cursor');
    for (const c of cols) {
      const td = el('td', { cls: [c.align === 'right' ? 'is-right' : null], data: { col: c.id } });
      const content = c.render(row);
      if (typeof content === 'string') td.textContent = content;
      else td.appendChild(content);
      tr.appendChild(td);
    }
    tr.addEventListener('click', (evt) => {
      // 复选框自己处理（切换加选），不要顺带走「整行单击 = 只选它」
      if ((evt.target as HTMLElement).closest?.('.kbw-rowcheck')) return;
      opts.onRowClick?.(row, evt);
    });
    tr.addEventListener('dblclick', (evt) => opts.onRowDoubleClick?.(row, evt));
    tr.addEventListener('contextmenu', (evt) => opts.onRowContextMenu?.(row, evt));
    tr.addEventListener('pointerdown', (evt) => opts.onRowPointerDown?.(row, evt as PointerEvent));
    tbody.appendChild(tr);
    index.set(key, tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);

  if (opts.rows.length === 0 && opts.empty) root.appendChild(opts.empty);

  return {
    el: root,
    rowFor: (key) => index.get(key) ?? null,
    scrollRowIntoView: (key) => {
      const row = index.get(key);
      if (!row) return;
      try {
        row.scrollIntoView?.({ block: 'nearest' });
      } catch {
        /* jsdom 没有布局，忽略 */
      }
    },
  };
}

function widthOf<T>(c: Column<T>, widths: Record<string, number> | undefined): number {
  const w = widths?.[c.id];
  return w && w > 0 ? w : c.width;
}

/** 列宽上限（拖动与自适应共用同一个数——两处各写一个必然漂） */
const MAX_COL_W = 900;

/**
 * **纯函数**：把"每格内容宽"（含左右内边距）合成列宽 —— 取最大、夹 `[min, max]`、
 * 加 1px 边框余量、取整。与"怎么量"分开的理由：jsdom 没有布局，
 * `getBoundingClientRect` 是全同坐标 —— 纯函数离线测，量的那一半由探针钉真机几何。
 */
export function fitWidthOf(measures: number[], min: number, max = MAX_COL_W): number {
  const usable = measures.filter((w) => Number.isFinite(w) && w > 0);
  const content = usable.length > 0 ? Math.max(...usable) : 0;
  return Math.round(Math.min(max, Math.max(min, content + 1)));
}

/**
 * **量一列的内容宽**（要真布局，只在真机/真 DOM 里有意义）：
 * 把每一格的内容**克隆**进一个 `width: max-content` 的隐形探针里量 —— 直接读
 * `scrollWidth` 不行的原因见下。
 *
 * 为什么不读 `cell.scrollWidth`：它**不会小于 `clientWidth`** —— 列比内容宽时
 * 返回的就是当前列宽，"双击自适应"就只会变大、不会变小（Excel 是双向的）。
 * 克隆探针量的是**内容本身的固有宽度**，两个方向都对。
 *
 * 探针两条讲究：
 *   · 挂回**表格容器里**（`position:fixed` 不参与布局）—— 留在 `.kbw-root` 之内才继承
 *     同一套字体/主题变量（挂 body 上会换一套字体，量出来全偏）；
 *   · `visibility: hidden` 而不是 `display: none` —— 后者不参与排版，量出来恒 0。
 * 表头那一格里的列宽抓手（`.kbw-col-grip`）不算内容，跳过。
 */
function measureColumnContent(root: HTMLElement, colId: string): number[] {
  const cells = Array.from(root.querySelectorAll<HTMLElement>('th[data-col], td[data-col]')).filter(
    (c) => c.dataset.col === colId,
  );
  const out: number[] = [];
  for (const cell of cells) {
    const probe = div({ cls: 'kbw-fitprobe' });
    /**
     * ⚠️ 把**源行**的类也带上（独立审查 🟡5）：行级选择器（`.kbw-frow .kbw-name` 的粗体）
     * 不带上就会量偏 —— 拟合取全列最大，通常由笔记行长名决定，但"某个目录名恰好最长"时会差几 px。
     */
    if (cell.closest('.kbw-frow')) probe.classList.add('kbw-frow');
    for (const n of Array.from(cell.childNodes)) {
      if (n instanceof Element && n.classList.contains('kbw-col-grip')) continue;
      probe.appendChild(n.cloneNode(true));
    }
    if (probe.childNodes.length === 0) continue; // 空格子不参与（0 宽会把别的格顶掉）
    root.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    out.push(w + horizontalPadding(cell));
  }
  return out;
}

function horizontalPadding(cell: HTMLElement): number {
  const cs = window.getComputedStyle?.(cell);
  const l = Number.parseFloat(cs?.paddingLeft ?? '') || 0;
  const r = Number.parseFloat(cs?.paddingRight ?? '') || 0;
  return l + r;
}

/**
 * 拖列宽。
 * ⚠️ 不用 `setPointerCapture`：拖动期间要在 document 上收指针（腕子移出表头也得跟），
 * capture 会把 target 钉在柄上（真机探针实测过的坑，与 ui/dnd.ts 同一条）。
 */
function startColumnResize<T>(
  evt: PointerEvent,
  col: Column<T>,
  grip: HTMLElement,
  colEl: HTMLTableColElement,
  opts: TableOptions<T>,
): void {
  evt.preventDefault();
  evt.stopPropagation();
  const startX = evt.clientX;
  const startW = parseFloat(colEl.style.width || '') || col.width;
  const min = col.minWidth ?? 60;
  const max = MAX_COL_W;
  let last = startW;
  let moved = false;

  const disposer = new Disposer();
  grip.classList.add('is-dragging');
  const wrap = grip.closest('.kbw-tablewrap') as HTMLElement | null;
  wrap?.classList.add('is-resizing');

  const finish = (persist: boolean): void => {
    disposer.dispose();
    grip.classList.remove('is-dragging');
    wrap?.classList.remove('is-resizing');
    if (persist && moved) opts.onColumnResize?.(col.id, last);
  };

  disposer.add(
    on(document, 'pointermove', (e) => {
      const dx = (e as PointerEvent).clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      last = Math.min(max, Math.max(min, Math.round(startW + dx)));
      colEl.style.width = `${last}px`;
    }),
  );
  disposer.add(on(document, 'pointerup', () => finish(true)));
  disposer.add(on(document, 'pointercancel', () => finish(false)));
}
