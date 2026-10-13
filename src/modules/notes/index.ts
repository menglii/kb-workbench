/**
 * modules/notes —— 全部笔记（P1 实做，交互规格 §3）
 *
 * 形态：面包屑 + 左目录树 + 右侧列表（**两档：详细信息 / 网格** —— P7.1 删了「名称+时间」档）。
 * 交互规格 §3.3 定的手感：**单击选中 / 双击打开**（有意偏离 Obsidian 本体文件列表
 * —— 这一屏的核心用例是批量操作，单击就能连续勾选、不会误开笔记）。
 *
 * 状态分两层：
 *   · **界面偏好**（视图档 / 列显隐 / 列宽 / 排序 / 树展开 / 搜索范围）→ 插件 data.json
 *     （`ctx.settings`，切走回来不变）
 *   · **本次会话的临时态**（选中、光标、搜索词、筛选条件）→ 模块自己的 store，
 *     不落盘（"清除筛选"是常态操作，落盘只会让人下次打开一脸懵）
 *
 * 区域重绘的用法：树 / 工具条 / 表格各一个 Region；**选中变化不重画表格**，
 * 只就地改行的 class（否则每勾一行都丢滚动位置）。
 */
import type { ColSlotPort, ModuleRender, NotesIntent, WorkbenchContext } from '../../core/context';
import { kbDirsOf, type HealthFlag, type NoteEntry } from '../../core/vault-index';
import { hasMod, debounce, Disposer, formatRelativeTime, isTouch, on, todayISO } from '../../core/util';
import type { Debounced } from '../../core/util';
import type { GridSortKey, NotesView, SearchScope, WorkbenchSettings } from '../../core/settings';
import { resolveNotesView } from '../../core/settings';
import { Region, Store } from '../../core/store';
import { ancestors, joinPath, parentDir } from '../../core/paths';
import { TFolder } from 'obsidian';
import { asBool } from '../../services/schema';
import { emptyState } from '../../ui/empty';
import { btn, div, el, icon, iconBtn, span } from '../../ui/primitives';
import {
  renderTable,
  type Column,
  type HeaderMenuInfo,
  type TableHandle,
  type TableTopRow,
} from '../../ui/table';
import { dragGhost, startPointerDrag, type GhostHandle } from '../../ui/dnd';
import { NOTIFY_MS, notify } from '../../ui/notify';
import type { KeyActionId } from '../../core/keymap';
import { isEditable, pushEscapeLayer } from '../../core/keymap';
import { wasDraggingRecently } from '../../ui/dnd';
import {
  buildColumns,
  emptyCell,
  folderFlagsCell,
  sortValueOf,
  defaultHiddenFor,
  type FolderHealth,
} from './columns';
import { buildTreeFromVault, renderTree, allDirs, type TreeDropInfo, type TreeNode } from './tree';
import {
  activeFilterCount,
  computeVisible,
  emptyFilters,
  hasAnyFilter,
  isDeepQuery,
  underDir,
  type FilterSet,
  type SortSpec,
} from './filters';
// ⚠️ 选择语义的**共享纯函数**（c 期起两屏同一份）—— 那个文件不 import 任何东西，依赖方向无环
import { rangeSelected, toggleSelected } from '../board/select';
// 16.13（P7.2d）：新手清单的动作点置位（视图档切换 / 用过搜索）
import { recordOnboarding } from '../home/onboarding';
import { batchBar } from './batch-bar';
import { openFilterPanel } from './panels';
import {
  columnsMenuSpec,
  showBlankMenu,
  showColumnsMenu,
  showFolderMenu,
  showGridFolderMenu,
  showHeaderMenu,
  showNoteMenu,
  type MenuCtx,
} from './menus';
import { NotesOps } from './ops';
import { openNewNoteDialog } from '../../ui/new-note';
// P7.10 · #8：首入「全部笔记」的一次性讲解浮层（触发与回收都在本文件 mount/dispose）
import { showNotesIntro } from '../../ui/notes-intro';
import type { PanelHandle } from '../../ui/panel';
import { renderGrid, type GridFolder, type GridHandle } from './grid';
import { startEdgeScroll, type EdgeScroller } from './autoscroll';
import { applyManualOrder, mergeReorder, reseatOrder, seedOrder } from './grid-order';
import { SCROLL_ATTR, captureScroll, recallScroll, restoreIfReset } from '../../core/view-memory';

/** 拖动掠过折叠树节点多久后展开（P7.1c ④）——比"点开"慢一点，是明确的悬停意图 */
const HOVER_EXPAND_MS = 500;

interface NotesState {
  /** 索引修订号 —— 区域重绘的 key（索引没动就不重画） */
  rev: number;
  /**
   * **"请重画一次"的专属计数器**（P6 补，e2 那条纪律的现成落点）。
   *
   * 为什么不能借 `rev`：`Store.set()` 对**值相同**的字段直接跳过通知
   *（`Object.is` 逐个比，全等就 `return false`）——而 `repaint()` 想说的正是
   * "索引没动，但我改了别的东西，请照新状态再画一遍"。
   * 借 `rev` 的写法在这种情况下**一声不响地什么也不做**：
   * 网格里拖动换位后顺序表变了、DOM 却停在旧顺序（"拖了等于没拖"）。
   */
  paintRev: number;
  dir: string;
  open: string[];
  /**
   * **树里「含文件展示」的目录**（P7.23 · `treeShowFiles` 的 store 一份，同 `open`）：
   * 「完全展开（含所有子文件夹与文件）」给整棵子树盖它、「收起此文件夹」整棵子树清它。
   * 落盘走 `persist`（防抖 400ms），口径与 `open → treeOpen` 同族。
   */
  treeShowFiles: string[];
  search: string;
  scope: SearchScope;
  filters: FilterSet;
  view: NotesView;
  sort: SortSpec | null;
  /** 隐藏的列；**null = 用户还没选过**（用默认显隐，含自定义属性列） */
  hiddenCols: string[] | null;
  widths: Record<string, number>;
  selected: string[];
  anchor: string | null;
  cursor: string | null;
  /** 拖动掠过中的目标目录（null = 没在拖） */
  dragDir: string | null;
  dragCount: number;
  /**
   * **拖动真的开始了**（P7.1c ③；越过阈值/长按成立才置 true）。
   * 唯一的用处：工具条在拖动期间**让位给面包屑** —— 否则拖起来那一瞬选中集非空、
   * 整条工具条被批量栏顶掉，面包屑根本不在 DOM 里，"拖到面包屑 = 上移"无处可落。
   * ⚠️ **不进 `listKey` / 树 key**（那会重绘列表或目录树 = 当场掐断拖动）；
   * 只进工具条 key（见 `paintToolbar` 开头）。
   */
  dragActive: boolean;
  /** 正在就地改名的行 */
  renaming: string | null;
  // ── P6：网格档（§3.5）────────────────────────────────────────
  /** 网格的排序（名称 / 修改日期 / 大小）—— 与表格的 `sort` **不是同一份** */
  gridSort: { key: GridSortKey; dir: 'asc' | 'desc' };
  /** 自动排列：开 = 按排序规则铺满；关 = 自由摆放（按顺序表） */
  gridAutoArrange: boolean;
  /**
   * ⚠️ **自由摆放的顺序表不在这里** —— 它只活在 `SettingsStore` 里（`settings.gridOrder`）。
   *
   * 为什么（P6 用例逮到的真缺陷）：这张表有**两个写入方** ——
   * ① 网格自己（拖动换位）；② **插件层**的 `vault.on('rename')`（改名迁键，挂在
   * `main.ts`，理由见那儿）。模块里再存一份副本的话，②改的是 settings、
   * **副本不会跟着动** → 下一次渲染用旧表算顺序，那篇刚改名的笔记在表里查无此路径 →
   * 被当成"没摆过的新笔记"**掉到末尾**（症状像"改个名位置就乱了"）。
   * 单写入方的 `gridSort` / `gridAutoArrange` 留在 store 里（它们变要重画），
   * **多写入方的 `gridOrder` 只读 settings** —— 这就是这两类的分界线。
   */
  /** 触屏选择模式（长按不动进来；Esc / 点空白出去）。桌面永远 false */
  selectMode: boolean;
  /**
   * **跳转带来的那份筛选**（A3，用户 2026-09-27 提）—— `null` = 现在这份筛选不是跳转给的。
   *
   * 为什么存"那一份"而不是一个布尔：**"还原"该不该给，判据是"现在生效的还是不是它"**。
   * 存值就能直接比（用户自己去筛选面板改过 → 两份不等 → 按钮自己消失），
   * 不需要在别处再挂一串"什么时候清掉这个标记"的规则（那种写法必然漏掉某条入口）。
   */
  jumpFilter: FilterSet | null;
  /**
   * **跳转带来的那个目录**（P7.9 · ④）—— 与 `jumpFilter` 同规矩、同一条判据：
   * `null` = 现在生效的目录不是跳转给的（或这次跳转压根没带目录）。
   *
   * 为什么要它：「整理收件箱 → 去全部笔记自己整理」带的是**目录 + 全选**，
   * 不在旧 A3 的判定（只看筛选）里 —— 跳过去之后**没有任何回头路**
   *（用户复现：`jumpRestoreButton=null`，只能手动去点树根）。
   * 「还原」只对**带目录的跳转**把目录回库根；纯筛选跳转照旧不碰目录树。
   */
  jumpDir: string | null;
}

export const renderNotes: ModuleRender = (host, ctx) => {
  const m = new NotesModule(ctx);
  m.mount(host);
  return () => m.dispose();
};

class NotesModule {
  private ctx: WorkbenchContext;
  private store: Store<NotesState>;
  private ops: NotesOps;
  private d = new Disposer();
  private regions: Region<NotesState>[] = [];
  private saveSoon: Debounced<[Partial<WorkbenchSettings>]>;

  private treeHost!: HTMLElement;
  private toolbarHost!: HTMLElement;
  private listHost!: HTMLElement;
  /**
   * **顶栏列头槽**（P6 段⑥ ④-A）：外壳在顶栏里留的那一格，「目录」二字搬去那儿。
   *
   * 🔴 **认一次、用到底**（d2 抓的 `ctx.xxx` 单槽那条纪律）：多标签时后开的视图会覆盖
   * `ctx.colSlot`，每次从 ctx 现取就会把标题填进**别人那一扇**的槽里。
   * 可缺省（离线单测直接渲染本模块时没有外壳）—— `null` 时标题照旧留在树里。
   */
  private colSlot: ColSlotPort | null = null;

  private table: TableHandle | null = null;
  private grid: GridHandle | null = null;
  private searchInput: HTMLInputElement | null = null;
  /** 面包屑右侧的计数（搜索时它要跟着走，但不重画工具条 —— 免得丢焦点） */
  private countEl: HTMLElement | null = null;
  private ghost: GhostHandle | null = null;
  private dragging: NoteEntry[] = [];
  private stopDrag: (() => void) | null = null;
  private lastIntentSeq = 0;
  private lastRev = -1;
  /** Esc 的"清空选择"层（有选中 / 选择模式时才压栈）*/
  private escSel: (() => void) | null = null;
  /** Esc 的"清掉跳转清单"层（有跳转带来的筛选或目录时才压栈，压在清选择**下面**）*/
  private escJump: (() => void) | null = null;
  /** 就地改名时压在更上面的一层（Esc 先取消改名，再谈清空选择）*/
  private renameEsc: (() => void) | null = null;
  /** 拖到边缘自动滚动（P7.1c ⑥）——表格档那一条链的实例（网格档的在 `grid.ts` 里） */
  private edgeScroll: EdgeScroller | null = null;
  /** 掠过折叠树节点的展开计时器（P7.1c ④）——目标用 dir 记（重绘会把元素换掉） */
  private expandTimer: ReturnType<typeof setTimeout> | null = null;
  private expandDir: string | null = null;
  /**
   * **文件夹创建时间**的缓存（P7.1c，用户 2026-10-03 加条）：`adapter.stat` 是异步的，
   * 而表格渲染是同步的 —— 先画「—」、查到了再**就地改那一格**（同 `updateCount` 那条路）。
   * 值 0 = 查过但拿不到（画「—」）；key 不在 = 还没查。
   */
  private dirCTime = new Map<string, number>();
  /** 首入讲解浮层的把手（P7.10 · #8；mount 弹、dispose 收 —— 见那两处） */
  private intro: PanelHandle | null = null;

  constructor(ctx: WorkbenchContext) {
    this.ctx = ctx;
    const s = ctx.settings.get();
    this.store = new Store<NotesState>({
      rev: -1,
      paintRev: 0,
      dir: s.treeSelected,
      open: [...s.treeOpen],
      treeShowFiles: [...s.treeShowFiles],
      search: '',
      scope: s.searchScope,
      filters: emptyFilters(),
      /**
       * ⚠️ 视图档走 `resolveNotesView()`（**唯一出处**）：`null` = 用户还没切过 → **网格**
       *（P6⑧ 起，用户真机第 5 条"网格设为默认视图"；以前是"桌面进详细信息"）；
       * 切过就以用户为准（§3.2 + B7 的优先级）。
       * 别在这里自己写兜底（`s.notesView ?? 'grid'`）—— 那条规则只许有一个出处。
       */
      view: resolveNotesView(s.notesView, isTouch()),
      sort: s.notesSort as SortSpec | null,
      hiddenCols: s.columnsHidden ? [...s.columnsHidden] : null,
      widths: { ...s.columnWidths },
      selected: [],
      anchor: null,
      cursor: null,
      dragDir: null,
      dragCount: 0,
      dragActive: false,
      renaming: null,
      gridSort: s.gridSort ?? { key: 'name', dir: 'asc' },
      gridAutoArrange: s.gridAutoArrange,
      selectMode: false,
      jumpFilter: null,
      jumpDir: null,
    });
    this.ops = new NotesOps(ctx, () => this.repaint());
    this.saveSoon = debounce((patch: Partial<WorkbenchSettings>) => {
      void ctx.settings.save(patch);
    }, 400);
  }

  // ── 生命周期 ─────────────────────────────────────────────────
  mount(host: HTMLElement): void {
    host.classList.add('kbw-notes');
    // 列头槽**只在这里认一次**（见字段上那条纪律）
    this.colSlot = this.ctx.colSlot ?? null;

    const shell = div({ cls: 'kbw-notes-shell' });
    this.treeHost = div({ cls: 'kbw-notes-side' });
    const main = div({ cls: 'kbw-notes-main' });
    this.toolbarHost = div({ cls: 'kbw-notes-toolbar' });
    /**
     * `data-scroll` = **视图记忆**认这个容器的锚（e 期 §4.4）。
     * 规矩是"谁渲染谁负责贴"（与 `is-collapsed` 同一条）—— 外壳按它捕获/写回
     * `scrollTop`，所以**别在 CSS 或别处再写一份容器清单**。
     */
    this.listHost = div({ cls: 'kbw-notes-list', attr: { [SCROLL_ATTR]: 'list' } });
    main.appendChild(this.toolbarHost);
    main.appendChild(this.listHost);
    shell.appendChild(this.treeHost);
    shell.appendChild(main);
    host.appendChild(shell);

    /**
     * ⚠️ **顺序有约束：[树, 工具条, 列表]**（独立审查 🟢7）——列表必须**最后**画。
     * 理由：列表重绘里可能**重入**改状态（网格 dispose → endDrag → `set({dragActive:false})`），
     * 那一发会顺手把工具条画成新档位；列表排在前面的话，外层循环随后又会拿**旧 state**
     * 把工具条画回旧档位（拖动结束后工具条停在错的那一档，症状很隐蔽）。**别重排这个数组。**
     */
    this.regions = [
      new Region<NotesState>(
        this.treeHost,
        () => this.paintTree(),
        {
          /**
           * ⚠️ **末位那一段是"库有变化"的 O(1) 指纹**（P7.15 · #2；独立审查 🟡5 改的口径）：
           * 树的数据源换成真实目录之后，**空目录的增删**不动 `rev`（索引条目没变）、
           * 也不动 `entries().length` —— 而 `syncFromIndex` 只对齐 `selected`、**不重画**。
           * 少了这一段，"别处建/删了一个空目录"不会让树重画（`repaint()` 那条路能救
           * 建完进目录的场景，但删/外部变化救不了）。
           *
           * ⚠️ 用 `getAllLoadedFiles().length` **不是** `realDirs().length`：
           * 后者每次 key 求值都要全表遍历一遍目录（key 在每次 `store.set` 都算 —— 选中、
           * 筛选、拖动预告每换一个落点一次），是把 O(文件数) 塞进热路径。
           * 长度是一份**O(1) 的现成计数**，而且"目录增删"必然连带它变（建/删空目录
           * 同样会走 vault 的 create/delete）—— 指纹够用，成本为零。
           * ⚠️ 它只当"变了就重画"的开关，**树本身照旧现算**（不缓存目录表）。
           */
          /**
           * ⚠️ **`open` / `treeShowFiles` 必须 `JSON.stringify`，不能用 `join(',')`**
           *（P7.24 · T3 实测抓到的真 bug）：`[].join(',')` 与 `[''].join(',')` **都是空串**
           * —— "全部收起（`open: []`）→ 点根 caret 开回来（`open: ['']`，'' = 库根）"
           * 这一对状态变化**key 相同 → 不重绘**，DOM 停在收起态（设置里其实已经开了）。
           * 单元素且为空串的数组正是碰撞点；`treeShowFiles` 同款（完全展开根 = `['']`）。
           */
          key: (s) =>
            `${s.rev}|${JSON.stringify(s.open)}|${JSON.stringify(s.treeShowFiles)}|${s.dir}|${s.dragDir ?? ''}|${s.dragCount}|${this.entries().length}|${this.ctx.app.vault.getAllLoadedFiles().length}`,
        },
      ),
      new Region<NotesState>(
        this.toolbarHost,
        () => this.paintToolbar(),
        // 工具条与批量栏是同一块地方（选中任意一行 → 整体换成操作栏，不占额外高度）
        // ⚠️ key 里**不能有 search**：搜索框就在这块里，一重画就丢焦点。
        // 搜索引起的计数变化由 `updateCount()` 就地改（见 store 订阅）
        {
          /**
           * ⚠️ key 里只要 `selected.length`（**不要**拼整个选择集，c 期独立审查 🔴1）：
           * "长度不变、内容变了"时不重画是**可以接受**的 —— 批量栏那四个按钮走的是
           * `selected: () => this.selectedEntries()`（**点击那一刻现取**），
           * 所以"看到的就是操作对象"由 getter 保证；拼整个选择集在全选上千行时反而很贵。
           *
           * ⚠️ P7.1c 起拼 `dragActive`：拖动开始时工具条要从批量栏**换回面包屑那一条**
           *（"拖到面包屑 = 上移"的前提），拖动结束再换回来 —— 两处各重画一次。
           * 它**只进这一个 key**：进列表/树 key 都等于当场掐断拖动。
           */
          key: (s) =>
            `${s.rev}|${s.selected.length}|${s.view}|${s.dir}|${s.scope}|${JSON.stringify(
              s.filters,
            )}|${s.sort?.key ?? ''}${s.sort?.dir ?? ''}|${this.selectedEntries().length}|${
              s.dragActive ? 'D' : ''
            }` +
            /**
             * A3：「还原显示」按钮的显隐直接进 key（判据就是 `canRestoreJump` 那一份）。
             * 只拼 `filters` 不够 —— 跳转把筛选换成同一份值时（`applyIntent` 会整份替换），
             * 拼出来一模一样，按钮的显隐就会停在上一屏。
             */
            `|${this.canRestoreJump(s) ? 'R' : ''}`,
        },
      ),
      new Region<NotesState>(
        this.listHost,
        () => this.paintList(),
        // ⚠️ 与"滚动保持"的判据**同源**（`keepScrollKey`）—— 别在这里另写一份
        { key: (s) => this.listKey(s) },
      ),
    ];

    this.d.add(this.ctx.index.onChange(() => this.syncFromIndex()));
    this.d.add(
      this.store.subscribe((s, prev) => {
        /**
         * **重绘前先把滚动位置记下来**（a.6；e2 独立审查后与看板一起改成"默认保"）。
         * 症状：同步 / 自动补全往库里写一笔、或别处改了一篇 → 索引修订变 →
         * 列表与目录树整块重绘 → 滚动位置归零（"我正翻到一半，它自己回顶上了"）。
         *
         * ⚠️ 捕获必须在 `Region.paint()` **之前**（它是先清宿主、再调渲染函数）。
         * 🔴 **判据必须与列表 Region 的 key 同源**（`keepScrollKey`）—— 第一版写的是
         * "`rev` 变了就保"，而 key 里还有 `renaming`：于是**就地改名（F2）进出一次**
         * 就把位置清了（看板那边同一处洞被独立审查实测到：列 60→0、卡面正文 120→0）。
         * 默认保、只有"视图参数真的变了"才不保。
         */
        const keepScroll = this.keepScrollKey(s) === this.keepScrollKey(prev);
        const snapList = keepScroll ? captureScroll(this.listHost) : null;
        const snapTree = keepScroll ? captureScroll(this.treeHost) : null;
        for (const r of this.regions) r.paint(s);
        /**
         * 写回**只针对被清零的容器**（`applyScroll` 无条件写会把用户在这中间
         * 自己滚到的位置拽回去 —— 看板那边写成了 `restoreLiveScroll`，同一条理由）。
         */
        if (snapList) restoreIfReset(this.listHost, snapList);
        if (snapTree) restoreIfReset(this.treeHost, snapTree);
        // 只改选中/光标 → 就地改 class，不重画（保住滚动位置）
        if (s.selected !== prev.selected || s.cursor !== prev.cursor) this.paintSelection(s);
        if (s.search !== prev.search) this.updateCount();
        if (
          s.selected !== prev.selected ||
          s.selectMode !== prev.selectMode ||
          // 跳转筛选也是 Esc 的一层（P6b ①）—— 只按选择变化重判，会漏掉"跳过来但没带预选中"那种
          this.canRestoreJump(s) !== this.canRestoreJump(prev)
        ) {
          this.syncEscapeLayer();
        }
        this.persist(s, prev);
      }),
    );
    this.d.add(
      this.ctx.store.subscribe((s) => {
        if (s.notesIntent && s.notesIntentSeq !== this.lastIntentSeq) {
          this.lastIntentSeq = s.notesIntentSeq;
          this.applyIntent(s.notesIntent);
          this.consumeIntent();
        }
      }),
    );
    this.d.add(
      this.ctx.keys.register(
        'notes',
        host,
        (action, evt) => this.onKey(action, evt),
        (evt) => this.onLocalKey(evt),
      ),
    );
    /**
     * **空白处右键**（B1，§8.1）：列表（表格 / 网格 / 空态）与目录树的**空白**都能右键。
     *
     * 为什么挂在容器上而不是每种元素上：行/格/节点的菜单是**各自**挂的
     * （`table.ts` 的 `tr`、`grid.ts` 的 cell、`tree.ts` 的 row），
     * 所以能落到这里的事件**天生就是空白处**的。再加一道 `closest` 是防御
     *（别人将来把菜单挪到容器上时，这里不会把两种菜单叠着弹）。
     *
     * ⚠️ 网格那边**不用管框选**：`startMarquee` 第一句就是 `if (e.button !== 0) return`
     *（右键拖不会起框选）—— 这里只要 `preventDefault()` 把平台的原生菜单按住。
     */
    this.d.add(
      on(this.listHost, 'contextmenu', (evt) => {
        const e = evt as MouseEvent;
        const t = e.target as HTMLElement | null;
        // 行/格/文件夹行各有各的菜单（P7.1b 起 `.kbw-frow` 也在这里排掉 —— 它自己那扇
        // 是 `showGridFolderMenu`，落到这儿会**两扇菜单一起弹**）
        if (t?.closest?.('.kbw-trow, .kbw-frow, .kbw-gcell, button, input, thead')) return;
        e.preventDefault();
        const s = this.store.get();
        showBlankMenu(e, this.menuCtx(), {
          where: s.view === 'grid' ? 'grid' : 'table',
          dir: s.dir,
          // 建完就站进去：P7.15 · #2 起树/网格画真实目录（含空目录），
          // 不给这一步反馈的话，用户会觉得"我建了但它没出现"
          onFolderCreated: (rel) => this.openDir(rel),
          restore: this.canRestoreJump(s) ? { run: () => this.restoreJump() } : undefined,
          clearFilters: hasAnyFilter(s.filters)
            ? () => this.store.set({ filters: emptyFilters(), jumpFilter: null })
            : undefined,
        });
      }),
    );
    this.d.add(
      on(this.treeHost, 'contextmenu', (evt) => {
        const e = evt as MouseEvent;
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('.kbw-tree-item, button, input, thead')) return;
        e.preventDefault();
        showBlankMenu(e, this.menuCtx(), {
          where: 'tree',
          dir: this.store.get().dir,
          onFolderCreated: (rel) => this.openDir(rel),
          restore: this.canRestoreJump(this.store.get())
            ? { run: () => this.restoreJump() }
            : undefined,
          onExpandAll: (dir) => this.expandAll(dir),
          // 「全部收起」= 与目录节点菜单（T3）**同一个函数**（收编自这条内联：两处各写一份
          // 必漂 —— 也正是"同一实现"那条判据要的形态）
          onCollapseAll: () => this.collapseAll(),
        });
      }),
    );

    /**
     * **点空白处 = 取消选中**（B2，用户 2026-09-27 提："选中笔记点击别处要能取消选中状态"）。
     *
     * 三条口径：
     *   · **"空白"要认准**：`.kbw-trow` / `.kbw-gcell` 之外才是。`table-layout: fixed;
     *     width: 100%` 让表体下方常常有一大片"表外"区域（空态元素也在那儿）——
     *     那正是落点，**点单元格不算**（那是选中/加选）。
     *   · **走 `store.set`**（`syncEscapeLayer` 是 Esc 层的唯一出处）：就地改 store 会留下
     *     一个"空的 Esc 层"，按一下 Esc 什么也不发生。
     *   · **触屏不接**（与框选/拖拽不接触屏同一条口径）：那里点空白是**滚动的收尾**，
     *     手指一滑就清空选择，太容易误触。
     *   · 用 `click` 不用 `pointerdown`（与网格那条同一理由）：拖框选/拖滚动收尾时
     *     不该顺手清空 —— 再加一道 `wasDraggingRecently()` 挡住拖完补的那一发。
     */
    this.d.add(
      on(this.listHost, 'click', (evt) => {
        if (isTouch()) return;
        if (wasDraggingRecently()) return;
        const t = evt.target as HTMLElement | null;
        /**
         * 🔴 **表头（`thead`）也算控件**：`th` 的 click **没有** `stopPropagation`
         *（`ui/table.ts`），而排序会 `store.set` → 同步重画整张表 —— 事件的传播路径在
         * **dispatch 那一刻**就定好了，`th` 被摘掉照样冒泡到这里 → **点一下表头排序 = 选择被清空**
         *（独立审查 A 路写了复现用例当场跑红）。列宽抓手 `.kbw-col-grip` 同属这条路径。
         *
         * 🔴 **"空白"必须排除"住在 listHost 里的那些工具条"**：
         * 网格的排序条（`.kbw-sortbar`）与状态行（`.kbw-gstatus`）就在 `grid.el` 里，
         * 而 `grid.el` 是挂在 `listHost` 上的 —— 只挡 `.kbw-trow/.kbw-gcell` 的话，
         * **点一下「自动排列」 = 清空选择**（真机上是"我刚选好几篇、一勾自动排列全没了"）。
         * 这一类"看着是空白、其实有活干"的区块要逐个排掉，别指望一层 closest 兜住。
         */
        if (
          t?.closest?.(
            '.kbw-trow, .kbw-frow, .kbw-gcell, button, input, a, select, thead, .kbw-col-grip, ' +
              '.kbw-marquee, .kbw-sortbar, .kbw-gstatus, .kbw-empty',
          )
        ) {
          return;
        }
        // 网格里那个"选中的文件夹格子"也一起撤（P6b ②）—— 它不进 store，只能由这里喊；
        // 详细档的**文件夹行**同理（P7.1b · 2.2）—— 两档同一手感
        this.grid?.clearFolderSelection();
        this.clearFolderRowSelection();
        if (this.store.get().selected.length === 0) return;
        this.store.set({ selected: [], anchor: null, cursor: null });
      }),
    );

    // 行首复选框：事件委托（表格每次重画都换 DOM，逐个挂会漏）
    this.d.add(
      on(this.listHost, 'change', (evt) => {
        const box = evt.target as HTMLInputElement | null;
        if (!box?.classList?.contains('kbw-rowcheck')) return;
        const path = box.dataset?.path ?? '';
        if (!path) return;
        // v2 · #5：模板不进选择集（两档的复选框本就不给模板画，这里是委托边界的兜底）
        if (this.entitiesByPath(path)?.isTemplate) return;
        const cur = this.store.get().selected;
        this.store.set({
          selected: box.checked ? Array.from(new Set([...cur, path])) : cur.filter((p) => p !== path),
          anchor: path,
          cursor: path,
        });
      }),
    );

    // 打开时若有待消费的意图（首页「整理收件箱」直接跳过来），立刻用上
    const st = this.ctx.store.get();
    if (st.notesIntent) {
      this.lastIntentSeq = st.notesIntentSeq;
      this.applyIntent(st.notesIntent);
      this.consumeIntent();
    }

    this.syncFromIndex();
    /**
     * **画完了 → 把上一回的位置写回去**（视图记忆，e 期 §4.4）。
     *
     * ⚠️ 时机就在这儿：`syncFromIndex()` 会推 `rev`，三个 Region 是**同步**画的
     *（`paintList` 不 await 任何东西），所以这一行跑的时候 DOM 已经在位了。
     * 写在 `mount()` 更早的地方等于写在一个空宿主上（写了也白写）。
     *
     * ⚠️ 快照是**一次性**的（`recallScroll` 取走即删）：之后索引变动引起的重绘
     * 不会再把人拽回上次的位置。
     */
    recallScroll('notes', host);

    /**
     * **首次进来的一次性讲解**（P7.10 · #8）：旗标没写过才弹（`ui/notes-intro.ts`）。
     * 摆位在画完之后算（浮层要按宿主列表区的位置"居中偏右"）。
     * ⚠️ 重挂载时若上一张还开着（dispose 那条路一般已经把它按 `unmount` 收了），
     * 先收旧的再弹新的 —— 两个 `close()` 都是幂等的。
     */
    if (this.ctx.settings.get().notesIntroSeen !== true) {
      this.intro?.close('unmount');
      this.intro = showNotesIntro(this.ctx, host);
    }
  }

  dispose(): void {
    // 讲解浮层（P7.10 · #8）：离开这一屏就收掉 —— **按 `unmount`**，不落旗标
    //（用户没关过它，下次进来该照弹；落旗标会变成"替他关"）
    this.intro?.close('unmount');
    this.intro = null;
    /**
     * **把槽里那一格收干净**（④-A）：装进去的是本模块的节点，本模块自己带走。
     *
     * ⚠️ `replaceChildren()` 在这里是**有判据的**（不是顺手清一把）：
     * 槽是外壳的元素、**比模块活得久**（切模块、关视图它都在），留着就是一段孤儿 DOM，
     * 而槽上还挂着 `:has()` 驱动的样式（`display:flex` 那一条按"槽里有没有东西"在变）。
     * 只清**本模块塞进去的那一个 head**（槽里本来就只可能有它 —— 分界线写在 `mount` 里）。
     */
    const c = this.colSlot;
    if (c) for (const n of Array.from(c.el.children)) if (n.classList.contains('kbw-tree-head')) n.remove();
    this.colSlot = null;
    this.stopDrag?.();
    this.ghost?.dispose();
    this.ghost = null;
    // 拖动那一套的收尾（stopDrag 那条路已经走过 endDrag，这里兜一道，都可重复调）
    this.clearHoverExpand();
    this.edgeScroll?.dispose();
    this.edgeScroll = null;
    // 网格自己攥着 marquee / 浮标 / 空白处那两个 document 监听 —— 不收就是孤儿 DOM
    this.grid?.dispose();
    this.grid = null;
    this.escSel?.();
    this.escSel = null;
    this.escJump?.();
    this.escJump = null;
    this.renameEsc?.();
    this.renameEsc = null;
    this.saveSoon.flush();
    this.d.dispose();
    for (const r of this.regions) r.dispose();
    this.regions = [];
  }

  /**
   * Esc 的分层栈：**先清选择 → 再清"跳转清单"**（P6b ①；P7.9 · ④ 起清单含筛选与目录，
   * 两层各压一层，别合成一层）。
   *
   * ⚠️ Esc **不走 `keymap.bind`**（`handle()` 里 escape 只问分层栈）——
   * 所以"有没有东西可清"要靠**压/弹一层栈**表达：有选中就压，清空了就弹。
   * 触屏选择模式也算"有东西可清"，而且它比"清空选择"更外层：一起退掉
   *（停在"有选择、但不在选择模式"这个中间态对用户没有意义 —— 那是桌面鼠标才有的姿态）。
   *
   * 🔴 **顺序靠"重建"保证，不靠"谁先 push"**：两层都是 `bottom: true`（背景层），
   * 而 `unshift` 的后压那层会落到**更下面** —— 依赖 push 顺序的话，
   * "先有选择、后跳转"与"先跳转、后有选择"会得到**相反的提问顺序**。
   * 所以状态一变就**整组重建**（先压跳转那层、再压选择那层 ⇒ 选择在上面、先被问到）；
   * 两层的"该不该在"仍各自按条件判（同一条纪律：**别用"回调返回 false"来禁用一层**）。
   */
  private syncEscapeLayer(): void {
    const s = this.store.get();
    const wantSel = s.selected.length > 0 || s.selectMode;
    const wantJump = this.canRestoreJump(s);
    if (wantSel === (this.escSel != null) && wantJump === (this.escJump != null)) return;
    this.escJump?.();
    this.escSel?.();
    this.escJump = null;
    this.escSel = null;
    /**
     * ⚠️ **先压"清选择"、再压"清跳转"** —— 顺序在这一行上，别凭直觉调换：
     * `bottom: true` 走的是 `unshift`（插到栈**底**），所以**后压的那层反而更靠底**，
     * 而 `dispatchEscape()` 问的是**栈顶**（数组末尾）。压成 [jump, sel] 才是
     * "先清选择、再清筛选"。
     */
    if (wantSel) {
      this.escSel = pushEscapeLayer(
        () => {
          if (this.store.get().selectMode) this.setSelectMode(false);
          this.store.set({ selected: [], anchor: null, cursor: null });
          return true;
        },
        'notes:clear-selection',
        { bottom: true },
      );
    }
    if (wantJump) {
      this.escJump = pushEscapeLayer(
        () => {
          this.restoreJump();
          return true;
        },
        'notes:clear-jump',
        { bottom: true },
      );
    }
  }

  // ── 数据 ─────────────────────────────────────────────────────
  /** 全部笔记（**不含模板**：模板不参与健康标记与批量操作） */
  private entries(): NoteEntry[] {
    /**
     * ⚠️ **P7.12 · #5（用户 2026-10-06 拍定）：「全部笔记」里模板可见**（行 + 计数）——
     * 数据源从 `index.notes()`（排除模板）换成 `index.getAll()`。
     * 「操作面照旧排除」由各处**入口守卫**承担（别在这里按 isTemplate 过滤，
     * 否则"看得见"就没了）：
     *   · 行点击不进选择集 / 不可拖（`onRowClick` / `onRowPointerDown` / 右键预选中）；
     *   · 复选框列对模板**不画**（`columns.ts` 的 `checkCell`）；
     *   · 「全选」与 `selectAll` 意图里剔掉模板（本文件两处）；
     *   · 健康标记本来就不算模板（`vault-index.computeFlags`）；首页计数各块自带过滤。
     */
    return this.ctx.index.getAll();
  }

  /** 当前生效的隐藏列：用户选过就照他的，没选过用默认（含自定义属性列） */
  private effectiveHidden(): string[] {
    const chosen = this.store.get().hiddenCols;
    return chosen ?? defaultHiddenFor(this.entries());
  }

  /** 「列设置」菜单的列清单（工具条「列」按钮与表头右键共用同一份构造） */
  private columnsForMenu(): { id: string; label: string; fixed?: boolean }[] {
    return buildColumns(this.entries()).map((c) => ({ id: c.id, label: c.label, fixed: c.fixed }));
  }

  /** 打开「列设置」菜单（工具条「列」按钮的入口） */
  private openColumnsMenu(anchor: HTMLElement): void {
    showColumnsMenu(anchor, this.columnsForMenu(), this.effectiveHidden(), (id, visible) =>
      this.setColumnHidden(id, visible),
    );
  }

  /**
   * 显隐一列 —— **表头右键与「列」菜单共用的唯一写入口**。
   * ⚠️ 走 `store`（防抖落盘那条链）—— 别在这儿直接 `settings.save`：
   * 模块读的是 store 里的 `hiddenCols`，绕过它等于"改了设置但界面不动"。
   */
  private setColumnHidden(id: string, visible: boolean): void {
    const cur = this.effectiveHidden();
    this.store.set({
      hiddenCols: visible ? cur.filter((c) => c !== id) : Array.from(new Set([...cur, id])),
    });
  }

  /**
   * 表头右键（P7.1 · 2.1/D2）：排序 › / 隐藏这一列 / 打开列设置…。
   * 菜单本体全在 `menus.ts` 的 `showHeaderMenu` —— 这里只负责把**状态与出口**接上：
   * 排序写 `sort`、隐藏走 `setColumnHidden`、「打开列设置…」给它现算一份列菜单 spec。
   */
  private showHeaderMenuFor(col: HeaderMenuInfo, evt: MouseEvent): void {
    showHeaderMenu(evt, {
      col,
      sort: this.store.get().sort,
      onSortDir: (dir) => this.store.set({ sort: { key: col.id, dir } }),
      onHide: () => this.setColumnHidden(col.id, false),
      columnsSpec: () =>
        columnsMenuSpec(this.columnsForMenu(), this.effectiveHidden(), (id, visible) =>
          this.setColumnHidden(id, visible),
        ),
      /**
       * 日期列的「按日期筛 ›」入口（P7.12 · 21.5「列头给同粒度入口」）。
       * 判定认**列 id**（`prop:创建日期` 是 schema 里唯一的日期列 —— v2 删掉
       * 目标发布日/截止日期之后）—— 别按 `col.label` 认，标签是给人看的、会改。
       */
      ...(col.id === 'prop:创建日期'
        ? {
            dateFilter: {
              onPick: (token: string) =>
                this.store.set({ filters: { ...this.store.get().filters, created: token } }),
            },
          }
        : {}),
    });
  }

  /**
   * 当前要显示的笔记（**顺序已定**）。
   *
   * 排序源按视图档分流：**表格用列排序（`sort`）、网格用排序下拉（`gridSort`）**。
   * 两者能共用 `computeVisible` + `sortValueOf` 是因为网格那三个键
   *（`name` / `mtime` / `size`）**正好就是表格列 id 的子集** —— 一份取值函数够用。
   *
   * 网格 + **自动排列关掉** → 顺序改由手动顺序表说了算（§3.5 的"自由摆放"）。
   * ⚠️ 手动顺序是**叠加在**筛选结果上的（不是另起一条路）：先筛出该显示的，
   * 再按表里的先后重排；表里没有的（新笔记）排在后面，彼此保持排序规则的顺序。
   */
  private visible(): NoteEntry[] {
    const s = this.store.get();
    const spec: SortSpec | null =
      s.view === 'grid' ? { key: s.gridSort.key, dir: s.gridSort.dir } : s.sort;
    const rows = computeVisible(this.entries(), {
      dir: s.dir,
      search: s.search,
      scope: s.scope,
      filters: s.filters,
      sort: spec,
      sortValue: sortValueOf,
    });
    // 顺序表**现取**（不存副本）：插件层的改名迁键改的就是它，缓存一份必过期
    if (s.view === 'grid' && !s.gridAutoArrange) {
      return applyManualOrder(rows, this.ctx.settings.get().gridOrder);
    }
    return rows;
  }

  private selectedEntries(): NoteEntry[] {
    const sel = new Set(this.store.get().selected);
    // v2 · #5：兜底剔模板 —— 批量栏「已选 N 篇」与「全选 M 篇」必须看同一份集合
    return this.entries().filter((e) => sel.has(e.path) && !e.isTemplate);
  }

  private syncFromIndex(): void {
    const rev = this.ctx.index.revision;
    if (rev === this.lastRev) return;
    this.lastRev = rev;
    // 索引变了：把已经不在库里的路径从选中里剔掉
    const alive = new Set(this.entries().map((e) => e.path));
    const s = this.store.get();
    this.store.set({
      rev,
      selected: s.selected.filter((p) => alive.has(p)),
    });
  }

  /** "请重画一次"：`rev` 对齐索引 + `paintRev` 自增一位（**保证订阅者一定被叫到**）*/
  private repaint(): void {
    this.lastRev = this.ctx.index.revision;
    this.store.set({ rev: this.ctx.index.revision, paintRev: this.store.get().paintRev + 1 });
  }

  // ── 区域：目录树 ─────────────────────────────────────────────
  private paintTree(): void {
    const s = this.store.get();
    const root = this.treeRoot();
    const drop = s.dragDir != null ? this.dropInfo(root, s.dragDir) : null;

    const tree = renderTree({
      root,
      open: s.open,
      showFiles: s.treeShowFiles,
      selected: s.dir,
      drop,
      onToggle: (dir) => {
        const next = this.store.get().open.includes(dir)
          ? this.store.get().open.filter((d) => d !== dir)
          : [...this.store.get().open, dir];
        this.store.set({ open: next });
      },
      // 点目录节点 = 显式的视野动作（`selectDir` 里顺带清掉跳转来的那份一次性清单，P6b ①）
      onSelect: (dir) => this.selectDir(dir),
      onContextMenu: (dir, evt) => showFolderMenu(dir, evt, this.menuCtx()),
      // 行尾「收起」按钮（P7.24 · T1）= 与菜单「收起此文件夹」**同一个** `collapseDir`
      onCollapse: (dir) => this.collapseDir(dir),
      /**
       * 文件行（P7.23）：单击=打开这一篇（Q2）——与列表双击同一条 `ops.open`；
       * 拖到目录节点上=搬（Q6）——复用网格那条"拖到目录"的链（mover + 撤销条同一份）。
       */
      onFileOpen: (path) => {
        const e = this.entitiesByPath(path);
        if (e) this.ops.open(e, 'current');
      },
      // 文件行右键（P7.24 · A22）= 与列表/网格行同一份笔记菜单
      onFileMenu: (path, evt) => {
        const e = this.entitiesByPath(path);
        if (e) showNoteMenu(e, evt, this.menuCtx());
        // 查不到实体（索引没跟上那一下）：至少别把原生右键菜单放出来（独立审 🟢8②）
        else evt.preventDefault();
      },
      onFileDrop: (path, dir) => this.applyGridMoveToDir([path], dir),
      onFileDragHint: (dir) => this.markCrumbDrop(dir),
    });

    /**
     * **表头搬进顶栏那一格**（P6 段⑥ ④-A）。
     *
     * 口径：三列的头（经纬 / 目录 / 全部笔记）落在**同一基线**，目录树头上多让出 42px。
     * ⚠️ 搬的是**同一个节点**（不是重建一份标题）：`renderTree` 每次重画都会新造一个 head，
     * 所以这一步在每次 `paintTree` 里都要做 —— 漏一次标题就回树里去了。
     * ⚠️ **没有槽的时候留在树里**（离线单测 / 外壳没起来）：标题不能因为"没有槽"就消失。
     */
    const head = tree.querySelector('.kbw-tree-head');
    if (this.colSlot && head) this.colSlot.el.replaceChildren(head);

    // 树自己也能拿键盘（↑↓ 选目录、←→ 收起/展开）——焦点在树里才生效
    const body = tree.querySelector('.kbw-tree-body') as HTMLElement | null;
    // 目录树自己的滚动位置也要记（视图记忆，e 期 §4.4）—— 见 `listHost` 上那段
    body?.setAttribute(SCROLL_ATTR, 'tree');
    body?.setAttribute('tabindex', '-1');
    body?.addEventListener('mousedown', () => body.focus());

    this.treeHost.appendChild(tree);
  }

  /**
   * 库内**真实目录**（相对库根，含空目录；`kbDirsOf` = 与「新建笔记」落点下拉、
   * AI 计划落点校验同一份口径）。
   *
   * P7.15 · #2：目录树原先只认"有笔记的目录"（`buildTree` 旧口径），
   * 于是用户新建的空文件夹**树里看不见**（网格画着 `2`（0 篇）、侧边栏没有）。
   * 现在树与网格同源：**画不画**看真实目录、**数字**看笔记数。
   *
   * ⚠️ 进区域 key 的是 `vault.getAllLoadedFiles().length`（**O(1) 的现成计数**，
   * 见那个 key）—— 不再每帧全表遍历（独立审查 🟡5）。**目录列表本身不缓存**：
   * 它由 `paintTree` 现算（与 Q3 的"不许缓存"一致），只在真重画那一拍付一次账。
   */
  private realDirs(): string[] {
    return Array.from(kbDirsOf(this.ctx.app, this.ctx.settings.kbRoot()));
  }

  /** 目录树那一份（真实目录 + 计数）—— 树/查找/筛选候选都走它，别各拼一遍 */
  private treeRoot(): TreeNode {
    return buildTreeFromVault(this.ctx.app, this.ctx.settings.kbRoot(), this.entries());
  }

  private nodeOf(dir: string): TreeNode {
    const root = this.treeRoot();
    if (!dir) return root;
    const walk = (n: TreeNode): TreeNode | null => {
      if (n.dir === dir) return n;
      for (const c of n.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root) ?? root;
  }

  /** 「4 → 7」：这个目录现在几篇、放下之后几篇 */
  private dropInfo(root: TreeNode, dir: string): TreeDropInfo {
    const find = (n: TreeNode): TreeNode | null => {
      if (n.dir === dir) return n;
      for (const c of n.children) {
        const hit = find(c);
        if (hit) return hit;
      }
      return null;
    };
    const from = find(root)?.count ?? 0;
    /**
     * 🔴 **`inside` 必须与树上那个数字同口径（递归）** —— 独立审查 A🔴1 抓到的真缺陷：
     * `from` 取的是树节点的**含子目录**数，而这里原先用 `inDir`（P6b ② 起**不递归**）→
     * "从子目录拖到祖先目录"时预告会**多报** `n`（真机一致：`A/B/子1.md` 拖到 `A`，
     * 预告写「3 → 4」，松手后树上还是 **3**）。**基准与增量必须同口径**。
     */
    const inside = this.dragging.filter((e) => underDir(e, dir)).length;
    return { dir, text: `${from} → ${from + this.dragging.length - inside}` };
  }

  // ── 区域：工具条 / 批量栏 ────────────────────────────────────
  private paintToolbar(): void {
    const s = this.store.get();
    /**
     * **有选择 → 整条换成批量栏**（§3.4 的既定口径）——**拖动期间例外**（P7.1c ③）：
     * 拖动一开始选中集必然非空，不让位的话面包屑根本不在 DOM 里，"拖到面包屑 = 上移"
     * 无从落点。所以拖动中工具条切回**常规那一条**（面包屑在里面，每一段都是落点）；
     * 松手/取消后 `dragActive` 落回 false，批量栏自己回来。
     */
    if (s.selected.length > 0 && !s.dragActive) {
      this.paintBatchBar();
      return;
    }

    const bar = div({ cls: 'kbw-notes-bar' });
    bar.appendChild(this.breadcrumb());

    const right = div({ cls: 'kbw-notes-tools' });

    const search = el('input', {
      cls: 'kbw-search',
      attr: { type: 'search', placeholder: '搜索笔记（/ 聚焦）', value: s.search },
    });
    search.addEventListener('input', () => {
      // 改搜索词与"点目录"同级：都是显式的视野动作 → 跳转来的那份一次性清单到此为止（P6b ①）
      this.endJumpScope();
      // 16.13（P7.2d）：用过搜索（"开始打字"就算用过 —— 含最后没搜到的情况）
      recordOnboarding(this.ctx, 'search');
      this.store.set({ search: search.value });
    });
    this.searchInput = search;
    right.appendChild(search);

    const scope = el('select', { cls: 'kbw-select is-small', attr: { title: '搜索范围' } });
    for (const [v, label] of [
      ['all', '全部'],
      ['title', '标题'],
      ['prop', '属性值'],
      ['tag', '标签'],
    ] as const) {
      scope.appendChild(el('option', { attr: { value: v }, text: label }));
    }
    scope.value = s.scope;
    scope.addEventListener('change', () => this.store.set({ scope: scope.value as SearchScope }));
    right.appendChild(scope);

    const filters = this.store.get().filters;
    const fcount = activeFilterCount(filters);
    right.appendChild(
      btn({
        cls: ['kbw-btn', 'is-small', fcount > 0 ? 'is-on' : null],
        text: fcount > 0 ? `筛选 ${fcount}` : '筛选',
        on: {
          click: (evt) => {
            openFilterPanel({
              filters: this.store.get().filters,
              dir: this.store.get().dir,
              /**
               * P7.15 · #2：候选换「真实目录」那一份（原先 buildTree 只给**第一层**，
               * 深层目录在候选里根本选不到；顺带与目录树同源）。
               * ⚠️ **滤掉 `''`**（独立审查 🟡3）：`realDirs` 来自 `kbDirsOf`，它的 Set
               * **含 `''`（整个知识库）**，而面板自己会补一项 `['', ...o.dirs]` —— 不滤就是
               * 两个同标签 chip（点谁两边一起亮）。另外这里顺手按名排序（Set 是插入序）。
               */
              dirs: this.realDirs()
                .filter((d) => d !== '')
                .sort((a, b) => a.localeCompare(b, 'zh')),
              tags: this.ctx.index.tags(),
              anchor: evt.currentTarget as HTMLElement,
              onDirsChange: (dir) => this.selectDir(dir),
              onChange: (f) => this.store.set({ filters: f }),
            });
          },
        },
      }),
    );

    /**
     * **A3：「还原显示」** —— 跳转（首页待处理 / 快速切换跳一篇）带来的筛选，
     * 在这里给一条一眼看得见的回头路。预选中还在时这条栏被批量栏顶掉，
     * 那个口子在 `paintBatchBar` 里（同一份判据、同一个动作）。
     */
    if (this.canRestoreJump(s)) {
      const spec = this.restoreJumpSpec();
      right.appendChild(
        btn({
          cls: ['kbw-btn', 'is-small', 'is-on'],
          text: spec.label,
          title: spec.title,
          on: { click: () => spec.run() },
        }),
      );
    }

    /**
     * 「列」按钮**网格档不画**（P6 拍板）：列宽/显隐是**表格**的概念，网格没有列。
     * 置灰留着的话，用户在网格里点开一个"勾了也没反应"的菜单 —— 不如不给这个入口
     *（§3.5 那一条的原话是"要么置灰写明、要么不画，别让它改不动还留在那儿"）。
     * 排序/自动排列那两个控件在网格自己的**排序条**上（视觉稿 `s-desk` 的位置）。
     */
    if (s.view !== 'grid') {
      right.appendChild(
        btn({
          cls: ['kbw-btn', 'is-small', this.effectiveHidden().length > 0 ? 'is-on' : null],
          text: '列',
          on: { click: (evt) => this.openColumnsMenu(evt.currentTarget as HTMLElement) },
        }),
      );
    }

    /**
     * 视图档（§3.2）：**P7.1 起两档 = 网格 / 详细信息**。
     * 原第三档「紧凑」（名称+时间）已删 —— 存量 `notesView: 'compact'` 由
     * `migrateSettings()` 在读盘时迁成 `'detail'`（等义改名，见 `core/settings.ts`）。
     * 顺序沿用原相对次序的剩余部分（详情在前、网格在后）。
     */
    const seg = div({ cls: 'kbw-seg' });
    const views: [NotesView, string][] = [
      ['detail', '详细信息'],
      ['grid', '网格'],
    ];
    for (const [v, label] of views) {
      seg.appendChild(
        btn({
          cls: ['kbw-segbtn', s.view === v ? 'is-on' : null],
          text: label,
          attr: { title: label },
          on: {
            click: () => {
              if (this.store.get().view === v) return;
              // 切走时把触屏选择模式收掉：它是网格档里的临时态，跟着档走
              this.store.set({ view: v, selectMode: v === 'grid' ? this.store.get().selectMode : false });
              // 16.13（P7.2d）：切过一次视图（真正的档位切换；起手画的那次不算）
              recordOnboarding(this.ctx, 'view');
            },
          },
        }),
      );
    }
    right.appendChild(seg);

    /**
     * **树的 ⋯**（重排库结构入口，与目录右键同一条菜单 —— `showFolderMenu` 作用在**当前目录**上）。
     *
     * ⚠️ **P6 段⑥ 起它挂在这儿，不再挂在目录树表头那一行** —— 那一行随 ④-A 整行取消了
     *（「目录」二字抬进了顶栏列头槽），入口不能跟着一起没。
     * 顺带修好一个老毛病：**窄档**下目录栏整个被 CSS 藏掉，挂在树头的 ⋯ 跟着消失
     *（那时只有"空白处右键"够得着）；挂到面包屑行之后窄档也够得着。
     * ⚠️ 它**不进批量栏**（`selected.length > 0` 时工具条整条被顶掉，见本函数开头）——
     * 与「列」/ 视图档那几个按钮同一条待遇，这是 §3.4 的既定口径。
     */
    right.appendChild(
      iconBtn('more-horizontal', '目录操作（重排库结构…）', (evt) =>
        showFolderMenu(this.store.get().dir, evt as MouseEvent, this.menuCtx()),
      ),
    );

    bar.appendChild(right);
    this.toolbarHost.appendChild(bar);
  }

  private breadcrumb(): HTMLElement {
    const dir = this.store.get().dir;
    const wrap = div({ cls: 'kbw-crumbs' });
    /**
     * **每一段都是拖拽落点**（P7.1c ③ "拖到面包屑 = 上移"）：段 = 那一级的目录，
     * 根段 = `''`（库根）。走 `data-drop` 那把公共钥匙（`ui/dnd` 的 `dropTargetAt`
     * 认它），于是**两档的拖动都自动能用**（表格行拖 / 网格格拖汇合在同一套 onDrop）。
     * ⚠️ 拖动期间工具条必须停在常规那一条（`paintToolbar` 的 `dragActive` 分支）——
     * 被批量栏顶掉时这一段根本不在 DOM 里。
     * ⚠️ 窄档里祖先段会被 CSS 收起来（不可见 = 落不到，`elementFromPoint` 命不中）；
     * 落点高亮 `.is-drop` 由 `markCrumbDrop` 就地贴（不走 store：重绘会掐断拖动）。
     */
    wrap.appendChild(
      span({
        // 窄档里祖先段会被 CSS 收起来（`kbw-crumb-ancestor`），**当前目录永远留着** ——
        // 主区在停靠侧栏时只有 ~690px，不收的话"现在在哪"会被挤没（真机截图抓到过）
        cls: ['kbw-crumb', 'kbw-hover-1', dir === '' ? 'is-on' : 'kbw-crumb-ancestor'],
        text: '全部笔记',
        data: { drop: '' },
        attr: { role: 'button', tabindex: '0' },
        on: { click: () => this.selectDir('') },
      }),
    );
    if (dir) {
      let acc = '';
      for (const seg of dir.split('/')) {
        acc = acc ? `${acc}/${seg}` : seg;
        const target = acc;
        wrap.appendChild(span({ cls: 'kbw-crumb-sep', text: '/' }));
        wrap.appendChild(
          span({
            cls: ['kbw-crumb', 'kbw-hover-1', target === dir ? 'is-on' : 'kbw-crumb-ancestor'],
            text: seg,
            data: { drop: target },
            attr: { role: 'button', tabindex: '0' },
            on: { click: () => this.selectDir(target) },
          }),
        );
      }
    }
    this.countEl = span({ cls: 'kbw-crumbs-count', text: this.countText() });
    wrap.appendChild(this.countEl);
    return wrap;
  }

  /**
   * 面包屑右侧那个计数（P6b ② 改口径）：**当前列表的篇数**（"本层 N 篇"）。
   *
   * 🔴 原先写的是「vis / 全库总数」（`164 / 192 篇`）—— 那是**目录树的算法**
   *（含子目录的导航汇总），与"点进去之后列表里到底有几篇"是两回事，两个数字并排
   * 更容易让人以为"点进去只显示了一部分"（用户 2026-09-27 拍板：写本层）。
   * 树上那个数字**保持含子目录**（它是导航汇总），但挂了 `aria-label`（含子目录 N 篇）说明口径
   * —— P7.12 · #7 起**去 title 留 aria-label**（黑色那枚气泡走平台的 aria-label 提示）。
   *
   * ⚠️ **P7.1b 起根层也写「本层 N 篇」**（与其它层完全同款）：那时根层不再递归
   *（来龙去脉见 `filters.ts` 里"根层的口径"那段），"全部 N 篇"会撒谎；
   * 少一个特例之后 `isRootDir` 整个删掉了（N2a 拍板：两变体选了"本层"）。
   */
  private countText(): string {
    const s = this.store.get();
    const n = this.visible().length;
    // 往下找的时候写「命中」：那时列表里是**整个目录树里的匹配**，写"本层"就是错的
    if (isDeepQuery({ search: s.search, filters: s.filters })) return `命中 ${n} 篇`;
    return `本层 ${n} 篇`;
  }

  /** 只更新计数（工具条不重画 → 搜索框不丢焦点） */
  private updateCount(): void {
    if (!this.countEl?.isConnected) return;
    this.countEl.textContent = this.countText();
  }

  /**
   * 批量栏（§3.4）—— 实现**搬去了 `./batch-bar.ts`**（P4.5 c 期：看板也要用同一份，
   * 两屏各写一份迟早漂，理由见那个文件的头注）。
   * 这里剩下的活只有"把本屏的口径传进去"：
   * 「全部」= **当前筛选结果**；"被筛掉仍选中"的篇数按本屏的 `visible()` 算。
   */
  private paintBatchBar(): void {
    const s = this.store.get();
    const vis = this.visible();
    const visiblePaths = new Set(vis.map((e) => e.path));
    this.toolbarHost.appendChild(
      batchBar({
        ctx: this.ctx,
        ops: this.ops,
        // ⚠️ **传函数不传数组**（c 期独立审查 🔴1）：按钮闭包要的是"点那一刻"的选中
        selected: () => this.selectedEntries(),
        all: {
          // v2 · #5：模板看得见但不进批量 —— 「全选」数与选择集都**剔掉模板**
          count: vis.filter((e) => !e.isTemplate).length,
          run: () =>
            this.store.set({
              selected: vis.filter((e) => !e.isTemplate).map((e) => e.path),
              anchor: vis.find((e) => !e.isTemplate)?.path ?? null,
            }),
        },
        onClear: () => this.store.set({ selected: [], anchor: null, cursor: null }),
        // 「打开所选（N 篇）」（P7.23 · Q9）：**只在「全部笔记」给**（看板=开 N 扇小窗，如实不给）
        openSelected: true,
        offscreen: s.selected.filter((p) => !visiblePaths.has(p)).length,
        restore: this.canRestoreJump(s) ? this.restoreJumpSpec() : undefined,
      }),
    );
  }

  // ── A3：跳转的回头路 ─────────────────────────────────────────
  /**
   * **跳转带来的那份显示变化还在生效吗**（判据：现在生效的**每一件**都还等于跳转记下的那份）。
   *
   * P7.9 · ④ 起这条判据管两样：`jumpFilter`（筛选）与 `jumpDir`（目录）——
   * 记了哪样就比哪样；用户自己动过任何一样 → 该样不等 → 这个口子自动消失
   *（与 `applyIntent` 里的写法**同源**，不必在别处再挂"什么时候清标记"的规则）。
   *
   * 🔴 **筛选那一半的基准是"跳转时的那份"，没带筛选就是空筛选**（独立审 🔴2）：
   * 目录跳转（`jumpFilter == null`）下若跳过这一比，用户随后自己设的筛选也照样挂着口子 ——
   * 一点就把**他的**筛选连带抹了，而 title / 规格都写着"你自己动过之后它自动消失"。
   * 判定"动过"的口径 = 现在这份 ≠ 跳转给的（空就是空）。
   */
  private canRestoreJump(s: NotesState): boolean {
    if (s.jumpFilter == null && s.jumpDir == null) return false;
    if (JSON.stringify(s.filters) !== JSON.stringify(s.jumpFilter ?? emptyFilters())) return false;
    if (s.jumpDir != null && s.dir !== s.jumpDir) return false;
    return true;
  }

  private restoreJumpSpec(): { label: string; title: string; run: () => void } {
    return {
      /**
       * 文案（P6b ①，用户 2026-09-27 拍板）：按钮就写「还原」。
       * 设计稿里是「还原到全部笔记」（说清回到哪儿），用户改成短的 ——
       * 那句解释落到 `title` 里（悬停看得到），免得按钮在批量栏左侧把"已选 N 篇"挤没了。
       * 2026-10-05（P7.9 · ④）：同一枚按钮也管**带目录的跳转**，title 按新语义重写。
       */
      label: '还原',
      title: '回到全部笔记默认显示：清掉这次跳转的目录、筛选与预选中（你自己动过之后它自动消失）',
      run: () => this.restoreJump(),
    };
  }

  /**
   * **还原"跳转后的显示"**（A3 / 还 e2 那笔债：`filters.paths` 的出口不够显眼；P7.9 · ④ 扩到目录）。
   * 一起做：清筛选、清预选中、把两个"跳转"标记抹掉；**带目录的跳转**再把目录回库根。
   * ⚠️ 目录只在 `jumpDir != null` 时才动 —— 纯筛选跳转（失效双链那几条）不碰目录树选择
   *（用户 2026-09-27 拍板的口径继续有效：还原 = 清这次跳转带来的显示变化）。
   * ⚠️ 清选中走 store（`syncEscapeLayer` 是 Esc 层的唯一出处，它由订阅统一维护）——
   * 别在这儿自己动 Esc 栈。
   */
  private restoreJump(): void {
    const s = this.store.get();
    this.store.set({
      filters: emptyFilters(),
      jumpFilter: null,
      jumpDir: null,
      ...(s.jumpDir != null ? { dir: '' } : {}),
      selected: [],
      anchor: null,
      cursor: null,
    });
  }

  // ── 区域：列表 ───────────────────────────────────────────────
  private paintList(): void {
    const s = this.store.get();
    const vis = this.visible();
    const selected = new Set(s.selected);

    if (s.view === 'grid') {
      this.paintGrid(s, vis);
      return;
    }
    this.grid?.dispose();
    this.grid = null;

    const cols: Column<NoteEntry>[] = buildColumns(this.entries());

    this.table = renderTable<NoteEntry>({
      columns: cols,
      rows: vis,
      /**
       * **文件夹行**（P7.1b · 2.2）：本层直接子目录、置顶、与列对齐。
       * 数据源与交互口径见 `folderRowsFor` —— 与网格文件夹格**同一份数据、同一扇菜单**。
       */
      topRows: this.folderRowsFor(s),
      rowKey: (e) => e.path,
      isSelected: (e) => selected.has(e.path),
      isCursor: (e) => s.cursor === e.path,
      hiddenColumns: this.effectiveHidden(),
      columnWidths: s.widths,
      sort: s.sort,
      onHeaderContextMenu: (col, evt) => this.showHeaderMenuFor(col, evt),
      rowAttrs: (e) => ({
        cls: [
          // 隐藏的笔记：淡出但不消失（这是管理屏，能不能看见要可控）
          asBool(e.props['隐藏']) ? 'is-dimmed' : null,
        ],
      }),
      onSort: (id) => {
        const cur = this.store.get().sort;
        this.store.set({
          sort: cur && cur.key === id ? { key: id, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key: id, dir: 'asc' },
        });
      },
      onColumnResize: (id, width) => {
        this.store.set({ widths: { ...this.store.get().widths, [id]: width } });
      },
      onRowClick: (e, evt) => this.onRowClick(e, evt),
      onRowDoubleClick: (e) => this.ops.open(e, 'current'),
      onRowContextMenu: (e, evt) => this.onRowMenu(e, evt),
      onRowPointerDown: (e, evt) => this.onRowPointerDown(e, evt),
      empty: this.emptyFor(s),
    });

    this.listHost.appendChild(this.table.el);
    /**
     * ⚠️ 挂输入框必须在 `appendChild` **之后**（原顺序如此，别动）：`mountRenameInput`
     * 末尾要 `input.focus()` —— 元素还游离在文档外时 focus 是空操作。
     */
    if (s.renaming) this.mountRenameAt(s.renaming);
    // 复选框与选中态在渲染后统一刷一遍（列定义不掺和状态）
    this.paintSelection(s);
  }

  /**
   * **空态的文案要看"这一层为什么是空的"**（P6b ②）。
   *
   * Windows 式口径下"根层只有子文件夹、没有笔记"是**常态**（整个知识库那一层尤其如此）。
   * 那时候默认那句「这个目录还没有笔记 · 新建一篇」是**误导** —— 明明有东西，只是都在
   * 文件夹里。所以：这一层有子目录时把它们的名字报出来，并给一条**去网格档**的路
   *（网格档里文件夹是一格一格的，点得进去）。
   */
  private emptyFor(s: NotesState): HTMLElement {
    if (s.search) {
      return emptyState({
        kind: 'search',
        compact: true,
        action: { label: '清除搜索', run: () => this.store.set({ search: '' }) },
      });
    }
    const folders = this.foldersFor(s);
    if (folders.length > 0) {
      const names = folders.slice(0, 4).map((f) => f.name).join('、');
      /**
       * **N2b 拍板（P7.1b）**：句尾改「双击上面的文件夹进入」、**去掉「切到网格档」按钮** ——
       * 文件夹行（2.2）上线后，文件夹就在这行字**上面**（置顶），单击/双击都能用；
       * 旧句里"或者切到网格档直接点文件夹"那条路已经是冗余的，留着反而把人引到另一个档去。
       * ⚠️ 这段文案只在**详细档**渲染得出来（网格那边 `renderGrid` 只要见到文件夹格
       * 就不画空态）。
       * ⚠️ **触屏要写「点」不是「双击」**（独立审查 🟡4）：触屏档文件夹行是**单击直接进**
       *（与网格文件夹格同款），照抄"双击"会和实际行为矛盾。判据在 `tests/specs/grid.ts`
       * 那条空态用例里（非触屏钉"双击"、`is-mobile` 档钉"点"）。
       */
      const enterHint = isTouch() ? '点上面的文件夹进入' : '双击上面的文件夹进入';
      return emptyState({
        kind: 'folder',
        compact: true,
        title: '这一层没有笔记',
        desc: `这一层有 ${folders.length} 个文件夹：${names}${folders.length > 4 ? '…' : ''} —— ${enterHint}`,
      });
    }
    /**
     * **筛选无结果 ≠ 空目录**（独立审查 🟡4 抓的边界）：`foldersFor` 见 `hasAnyFilter`
     * 就返回 `[]`，于是"筛选激活 + 本层零命中"也会落到这里 —— 那时目录里**是有笔记的**，
     * 只是被筛掉。给「＋ 在这里新建」等于把"没有匹配"说成"这里空着"。
     * 这一支给**回头路**：跳转筛选 → 「还原显示」（与工具条那份同源）；
     * 用户自己设的筛选 → 「清除筛选」（与空白处右键那份同一实现）。
     */
    if (hasAnyFilter(s.filters)) {
      return emptyState({
        kind: 'search',
        compact: true,
        title: '没有符合筛选的笔记',
        action: this.canRestoreJump(s)
          ? { label: '还原显示', run: () => this.restoreJump() }
          : {
              label: '清除筛选',
              run: () => this.store.set({ filters: emptyFilters(), jumpFilter: null }),
            },
      });
    }
    /**
     * 兜底（真的一无所有）**也要给动作**（P7.0a 批 1④）：`ui/empty.ts` 开头的纪律
     * 是"每种空态给一个动作"，稿子 `s-ds` 的「全部笔记 · 目录为空」画的正是
     * 「＋ 在这里新建」—— 而这一支从 P0 起就没传 `action`（只有上面"有子文件夹"
     * 那一支传了）。落点 = 当前目录（`s.dir`，与工具栏面包屑同一份口径）。
     */
    return emptyState({
      kind: 'folder',
      compact: true,
      action: {
        label: '＋ 在这里新建',
        run: () => openNewNoteDialog(this.ctx, { dirRel: s.dir }),
      },
    });
  }

  /**
   * 网格档（§3.5）。
   *
   * ⚠️ **每次重画都重建**（与表格一样）：`Region.paint()` 是先清宿主再渲染，
   * 老的那份必须自己 `dispose()` —— 它手里攥着 marquee / 浮标 / 拖动句柄，
   * 不收就会变成挂在 `document.body` 上的孤儿 DOM（真机上量到过 9 个）。
   */
  private paintGrid(s: NotesState, vis: NoteEntry[]): void {
    this.grid?.dispose();
    this.table = null;
    this.grid = renderGrid({
      entries: vis,
      folders: this.foldersFor(s),
      onOpenDir: (dir) => this.openDir(dir),
      // 右键文件夹格子 = 目录菜单（P6b ②）
      onFolderMenu: (dir, evt) => showGridFolderMenu(dir, evt, this.menuCtx()),
      // ⚠️ **传函数不传 Set**（选中变化不重画列表 → 快照当场过期）；同 `batchBar` 那条纪律
      selected: () => new Set(this.store.get().selected),
      cursor: s.cursor,
      autoArrange: s.gridAutoArrange,
      sort: s.gridSort,
      selectMode: s.selectMode,
      hasSelection: s.selected.length > 0,
      onOpen: (e) => this.ops.open(e, 'current'),
      onCellClick: (e, evt) => this.onGridClick(e, evt),
      onCellMenu: (e, evt) => this.onRowMenu(e, evt),
      onSort: (key) => this.onGridSort(key),
      onAutoArrange: (next) => {
        this.store.set({ gridAutoArrange: next });
        notify({
          kind: 'info',
          text: next ? '自动排列已开：按排序规则铺满' : '自由摆放：按你摆的顺序排',
          ms: NOTIFY_MS.light,
        });
      },
      onReorder: (visNew, moving) => this.applyGridReorder(visNew, moving),
      onMoveToDir: (paths, dir) => this.applyGridMoveToDir(paths, dir),
      /**
       * 拖动真的开始了 → 工具条让位给面包屑（P7.1c ③；网格那边只有这一条路能报 ——
       * 它的拖动句柄在 `grid.ts` 里）。边缘滚动在网格内部自起自收（`grid.ts`）。
       */
      onDragActive: (on) => this.setDragActive(on),
      onDragDir: (dir, count) => {
        // 面包屑段高亮 + 折叠树节点悬停展开：与表格档**同一份实现**（掠过的落点两档一致）
        this.markCrumbDrop(dir);
        this.hoverExpandTree(dir);
        const cur = this.store.get();
        if (cur.dragDir === dir && cur.dragCount === count) return;
        this.store.set({ dragDir: dir, dragCount: count });
      },
      onMarquee: (paths, additive) => this.applyMarquee(paths, additive),
      onSelectMode: (next) => this.setSelectMode(next),
      // 空态与表格档**同一份口径**（P6b ②：这一层有子文件夹时要说清"不是空的"）
      empty: this.emptyFor({ ...s, view: 'grid' }),
    });
    this.listHost.appendChild(this.grid.el);
    // 网格档的就地改名：重画后把输入框挂回"名称处"（与表格档同一条路，P7.1c ①）
    if (s.renaming) this.mountRenameAt(s.renaming);
  }

  /**
   * 网格里要画的文件夹（B3 / P6b ②）：**当前目录的真实子目录**。
   *
   * 🔴 **数据源从 `buildTree` 换成"真实目录"**（P6b ② 的一条硬要求）：
   * `buildTree` 只认"**有笔记的**目录"，于是用户新建的空文件夹在网格里**根本看不见**
   *（"我建了它，进不去"复活 —— P6b 上一轮刚把它做掉）。Windows 式导航下
   * **空目录必须可见**（它就是要被点进去的地方），所以子目录这一份从
   * `vault.getAllLoadedFiles()` 取（平台缓存树，含空目录），**计数**仍走 `buildTree`
   *（"含子目录"的那个数，与目录树上同一份口径）。
   *
   * ⚠️ **搜索 / 筛选生效时一个都不画**：文件夹不匹配搜索词，留着只是噪音；
   * 那时用户的意图是"找那几篇"，不是"逛目录"。
   */
  private foldersFor(s: NotesState): GridFolder[] {
    if (s.search.trim() !== '' || hasAnyFilter(s.filters)) return [];
    /**
     * ⚠️ P7.14：顶层比较用**纯路径**（`parentDir(f.path)`），不用 `f.parent?.path` ——
     * 库顶层两边都不可靠（离线桩 `parent = null`，真机是 `'/'`），
     * `kbRoot=''`（整个库）的根层因此会一个文件夹都画不出来。
     */
    const base = joinPath(this.ctx.settings.kbRoot(), s.dir);
    const names = new Set<string>();
    for (const f of this.ctx.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && parentDir(f.path) === base) names.add(f.name);
    }
    const countOf = new Map((this.nodeOf(s.dir)?.children ?? []).map((c) => [c.name, c.count]));
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, 'zh'))
      .map((name) => ({
        dir: s.dir ? `${s.dir}/${name}` : name,
        name,
        count: countOf.get(name) ?? 0,
      }));
  }

  /**
   * **详细档的文件夹行**（P7.1b · 2.2；用户 2026-10-02 定稿 + 4 处补充）。
   *
   * 一行一格的口径（都钉在判据里）：
   *   · 数据源 = `foldersFor(s)` —— 与网格文件夹格**同一份**（真子目录 + 含子目录的计数；
   *     空目录也画）；搜索/筛选生效时它返回空 → **一行都不画**（与网格同一条判据）。
   *   · 名称格 = 文件夹图标 + 名 + 「· N 篇」（N 挂 `aria-label` = 含子目录 N 篇；P7.12 · #7 起不再挂 title）；
   *     修改时间格 = **目录下最新一篇 mtime（含子目录）**；其余格留空（它不是笔记）。
   *   · 身份：**没有 `data-path`**，有 `data-drop`（拖笔记到行上 = 搬到那个目录 ——
   *     与目录树节点、网格文件夹格同一条 `mover` 链；落点解析见 `ui/dnd` 的 `dropTargetAt`）。
   *   · 交互（D3 定稿，与网格文件夹格同一套手感）：**单击选中 / 双击进入 / Enter 进入 /
   *     Space 不做 / 右键复用 `showGridFolderMenu`（同一份实现）/ 触屏单击直接进**。
   *   · ⚠️ 行的"选中"是**纯 DOM 态**（`.is-selected`，独立于笔记选择集 —— N3 拍板：
   *     文件夹行是导航，不进"选 N 篇"）：重绘自然清掉（与网格文件夹格同款）；
   *     清它的口子在"点空白处"那一处（`clearFolderRowSelection`）。
   */
  private folderRowsFor(s: NotesState): TableTopRow<NoteEntry>[] {
    const health = this.dirHealthUnder(s);
    return this.foldersFor(s).map((f) => ({
      key: `dir:${f.dir}`,
      data: { drop: f.dir, dir: f.dir },
      /**
       * ⚠️ **不给 `<tr>` 贴 `role="button"`**（独立审查 🟢3）：会把行语义整个换掉（td 变成
       * "无合法父"）。键盘等价物由 `tabindex` + 下面的 `Enter` 处理给；名称格 + `aria-label`
       * 已够读屏认人。完整的行内按钮化（role=row + 格内可聚焦节点）留作无障碍专项，不在本轮。
       */
      attrs: { tabindex: '0', 'aria-label': `文件夹 ${f.name}` },
      cell: (col) => {
        if (col.id === 'name') {
          const wrap = div({ cls: 'kbw-namecell' });
          wrap.appendChild(icon('folder', 14, 'kbw-ico kbw-frow-ic'));
          wrap.appendChild(span({ cls: 'kbw-name', text: f.name, title: f.dir }));
          wrap.appendChild(
            span({ cls: 'kbw-frow-count', text: `· ${f.count} 篇`, attr: { 'aria-label': `含子目录 ${f.count} 篇` } }),
          );
          return wrap;
        }
        if (col.id === 'mtime') {
          const mtime = this.latestMtimeUnder(f.dir);
          return mtime > 0 ? formatRelativeTime(mtime) : '—';
        }
        /**
         * **标记列 = 文件夹的聚合健康**（P7.1c，用户 2026-10-03 加条 + 拍板；P7.7c 换短词）：
         *   · 整棵子树 0 篇 → 「空」（悬停「文件夹里还没有笔记」—— 空目录也是"要留意"的一件事：填或删）；
         *   · 子树里有带健康标记的笔记 → 「待整理」，**按最重级别上色**（红 > 黄 > 紫 —— 与笔记行
         *     六色语言同源），悬停写「N 篇需要处理」+ 各类的条数；
         *   · 有笔记且都干净 → 「—」（与笔记行"没标记就画横杠"完全同款）。
         */
        if (col.id === 'flags') {
          return folderFlagsCell(health.get(f.dir));
        }
        /**
         * **创建日期列给文件夹的真值**（P7.1c 加条）：笔记读的是前言里的 `创建日期`，
         * 文件夹没有前言 —— 取**文件系统给的创建时间**（`adapter.stat().ctime`，
         * 平台的 `Stat` 文档口径就是"创建时间"）。它是异步的：先画「—」，
         * 查到了 `loadDirCTime` 就地补上这一格（缓存一次，本次会话内不再查）。
         */
        if (col.id === 'prop:创建日期') {
          const ctime = this.dirCTime.get(f.dir);
          if (ctime == null) {
            void this.loadDirCTime(f.dir);
            return emptyCell();
          }
          return ctime > 0 ? todayISO(new Date(ctime)) : emptyCell();
        }
        // 复选框列是**结构列**（每行一根，不是数据）：文件夹行没有它"该有的值"，留空格。
        if (col.id === 'check') return undefined;
        /**
         * 其余属性列 / 大小列：文件夹不是笔记、没有这些属性 → **画横杠**
         *（用户 2026-10-03 加条："这三栏属性没有就打横杠"）——"空值长什么样"与
         * 笔记行同一处口径（`columns.ts` 的 `emptyCell`），原来这里留空格是破例。
         */
        return emptyCell();
      },
      onClick: (evt) => {
        // 拖完补的那一发 click 不算（与网格文件夹格、表格行同一条纪律）
        if (wasDraggingRecently()) return;
        evt.stopPropagation(); // 别让"点空白 = 取消选中"那一套跟着跑（那个挂在内层容器上）
        // 触屏没有"选中"这个中间态 → 单击直接进（§3.2.1 那张表照抄网格文件夹格）
        if (isTouch()) {
          this.openDir(f.dir);
          return;
        }
        this.selectFolderRow(evt.currentTarget as HTMLElement);
      },
      onDoubleClick: (evt) => {
        if (wasDraggingRecently()) return;
        if (isTouch()) return; // 触屏单击已经进去了，第二下不该再"进入一次"
        evt.preventDefault();
        this.openDir(f.dir);
      },
      onContextMenu: (evt) => {
        // 右键即选中（Windows 手感，与网格文件夹格、表格行同一口径）+ **复用同一扇菜单**
        this.selectFolderRow(evt.currentTarget as HTMLElement);
        showGridFolderMenu(f.dir, evt, this.menuCtx());
      },
      onKeyDown: (evt) => {
        /**
         * 键盘等价物：**Enter = 进入**（与双击等价）；**Space 不做**（D3 拍板 ——
         * 文件夹行不进选择集，Space 的"选中"语义在这儿无处安放）。
         * ⚠️ 两个键都要 `stopPropagation`：Space 在全局键表里是「选中/取消选中」
         * （`toggle-select`）、Enter 是「打开当前项」—— 不按住的话，焦点停在文件夹行上
         * 按一下空格会把光标那篇笔记选上（"键落在别处"的经典谜面）。
         */
        if (evt.key === 'Enter') {
          evt.preventDefault();
          evt.stopPropagation();
          this.openDir(f.dir);
        } else if (evt.key === ' ') {
          evt.preventDefault();
          evt.stopPropagation();
        }
      },
    }));
  }

  /** 该目录下（**含子目录**）最新一篇的 mtime —— 文件夹行"修改时间"格的口径；空目录 = 0 */
  private latestMtimeUnder(dir: string): number {
    let max = 0;
    for (const e of this.entries()) if (underDir(e, dir)) max = Math.max(max, e.mtime);
    return max;
  }

  /**
   * 本层各子目录的**子树健康汇总**（P7.1c；文件夹行「标记」列的口径）。
   * 一次遍历把每篇摊到"它所属的当前层子目录"头上 —— 别对每个文件夹行各扫一遍全库。
   * 口径与 `foldersFor` 的计数同源：**含子目录**、模板不计（`entries()` 已排除）。
   */
  private dirHealthUnder(s: NotesState): Map<string, FolderHealth> {
    const out = new Map<string, FolderHealth>();
    const prefix = s.dir ? `${s.dir}/` : '';
    for (const e of this.entries()) {
      const pos = e.effectivePosition;
      // 直接躺在当前层的文件不属于任何子文件夹（它们是"这一层"的笔记）
      if (prefix ? !pos.startsWith(prefix) : pos === '') continue;
      const head = (prefix ? pos.slice(prefix.length) : pos).split('/')[0];
      if (!head) continue;
      const dir = `${prefix}${head}`;
      let h = out.get(dir);
      if (!h) {
        h = { notes: 0, flagged: 0, flags: new Map() };
        out.set(dir, h);
      }
      h.notes += 1;
      if (e.flags.length > 0) {
        h.flagged += 1;
        for (const f of e.flags) h.flags.set(f, (h.flags.get(f) ?? 0) + 1);
      }
    }
    return out;
  }

  /**
   * 取**文件夹的创建时间**（P7.1c 加条）并**就地补上那一格**。
   *
   * 事实与口径：`TFolder` 没有 `stat`（平台的 `TFile` 才有），文件夹的时间戳只能问
   * `adapter.stat()` —— 它是异步的，而表格渲染是同步的，所以先画「—」、查到再改
   * 那一格的 `textContent`（与 `updateCount` 同一条"就地改"的路）。平台 `Stat.ctime`
   * 的文档口径就是"创建时间"。写 0 = 查过但拿不到（别再查第二遍）。
   */
  private async loadDirCTime(dir: string): Promise<void> {
    if (this.dirCTime.has(dir)) return;
    this.dirCTime.set(dir, 0); // 先占位：同一帧里的下一次渲染别再发一份查询
    let t = 0;
    try {
      const st = await this.ctx.app.vault.adapter.stat(joinPath(this.ctx.settings.kbRoot(), dir));
      if (st && st.type === 'folder') t = st.ctime;
    } catch (e) {
      console.error('[经纬] 取文件夹创建时间失败', dir, e);
    }
    this.dirCTime.set(dir, t);
    if (t <= 0) return;
    const host = this.table?.el;
    if (!host) return;
    for (const row of Array.from(host.querySelectorAll<HTMLElement>('.kbw-frow'))) {
      if (row.dataset.dir !== dir) continue;
      const cell = row.querySelector<HTMLElement>('td[data-col="prop:创建日期"]');
      // 列表可能已经重画过（换成别的层了）—— 找不到就放弃：缓存里有，下次渲染自会读到
      if (cell) cell.textContent = todayISO(new Date(t));
      return;
    }
  }

  /** 文件夹行的"选中"：**独立的一档**（不进笔记选择集），同一时刻至多一行 */
  private selectFolderRow(row: HTMLElement): void {
    this.clearFolderRowSelection();
    row.classList.add('is-selected');
  }

  /** 撤掉文件夹行的高亮（点空白处 / 拖完）——与网格的 `clearFolderSelection` 同一时机 */
  private clearFolderRowSelection(): void {
    const host = this.table?.el;
    if (!host) return;
    for (const r of Array.from(host.querySelectorAll<HTMLElement>('.kbw-frow.is-selected'))) {
      r.classList.remove('is-selected');
    }
  }

  /**
   * 拖动掠过**文件夹行**时就地高亮（`.is-drop`，与网格文件夹格同款 —— 独立审查 🟡3：
   * 原先掠过文件夹行只有左边目录树那个节点亮，指针底下的行**没有任何"就放这儿"的反馈**）。
   * ⚠️ 只改 DOM、**不走 store**：行挂在列表 Region 上，"`store.set` → 重绘"会**掐断这次拖动**
   *（与网格 `markDropDir` 同一条理由）；收尾在 `endDrag()` 里一起清。
   */
  private markFolderRowDrop(el: HTMLElement | null): void {
    const host = this.table?.el;
    if (!host) return;
    const next = el && el.classList.contains('kbw-frow') ? el : null;
    for (const r of Array.from(host.querySelectorAll<HTMLElement>('.kbw-frow.is-drop'))) {
      if (r !== next) r.classList.remove('is-drop');
    }
    next?.classList.add('is-drop');
  }

  /**
   * 拖动掠过的**落点就地高亮**（P7.1c ③ 起）：文件夹行 + 面包屑段，一处管道。
   * 表格档传来的是指针底下的元素（`targetEl`）；网格档只有 `dir`（它的文件夹格高亮
   * 由网格自己管）→ 两处都按 `dir` 找面包屑段，行为一致。
   */
  private markDropHints(el: HTMLElement | null, dir: string | null): void {
    this.markFolderRowDrop(el);
    this.markCrumbDrop(dir);
  }

  /** 面包屑段的落点高亮（`data-drop` 即身份；只改 DOM，理由同上） */
  private markCrumbDrop(dir: string | null): void {
    for (const c of Array.from(this.toolbarHost.querySelectorAll<HTMLElement>('.kbw-crumb[data-drop]'))) {
      c.classList.toggle('is-drop', dir != null && c.dataset.drop === dir);
    }
  }

  /** 拖动状态进 store（只进工具条 key —— 见 `NotesState.dragActive` 上那段） */
  private setDragActive(on: boolean): void {
    if (this.store.get().dragActive !== on) this.store.set({ dragActive: on });
  }

  /**
   * **掠过折叠的树节点 ~500ms → 展开它**（P7.1c ④，"拖进去"的一步到位）。
   *
   * 边界：
   *   · 只认**折叠着且有子节点**的目录；同目标重复掠过**不重置计时器**
   *     （否则"走着走着停下"会把计时器越推越远，永远不展开）；
   *   · ⚠️ **P7.24 · T2**：这里原来排除了库根（`dir === ''` 早退，注解说"库根永远是展开的"
   *     —— 决策反转后那句已过期）。根也是普通节点：收着的根**掠过同样展开**（独立审 🟢5）；
   *   · 目标用 **dir 字符串**记，不攥元素 —— 树是另一个 Region，展开会让它重绘、元素换人；
   *   · 展开后指针还停在这个节点上 → 落点不变（`data-drop` 跟人走），**同一手势里直接落进去**；
   *   · 离开目标 / 松手 / 取消 → `clearHoverExpand()`（endDrag 里兜底）。
   */
  private hoverExpandTree(dir: string | null): void {
    if (dir == null) {
      this.clearHoverExpand();
      return;
    }
    if (dir === this.expandDir) return; // 同一个目标：计时器照跑，别重置
    this.clearHoverExpand();
    const s = this.store.get();
    if (s.open.includes(dir)) return; // 已经展开 → 没有要等的
    const node = this.findTreeNode(dir);
    if (!node || node.children.length === 0) return; // 没子节点 → 展开了也是空的
    this.expandDir = dir;
    this.expandTimer = setTimeout(() => {
      this.expandTimer = null;
      this.expandDir = null;
      const cur = this.store.get();
      if (cur.open.includes(dir)) return;
      this.store.set({ open: [...cur.open, dir] });
    }, HOVER_EXPAND_MS);
  }

  private clearHoverExpand(): void {
    if (this.expandTimer != null) clearTimeout(this.expandTimer);
    this.expandTimer = null;
    this.expandDir = null;
  }

  /** 树里找目录节点（找不到返回 null —— 别回落成根：根几乎总有子节点，会白计一次展开） */
  private findTreeNode(dir: string): TreeNode | null {
    const root = this.treeRoot();
    const walk = (n: TreeNode): TreeNode | null => {
      if (n.dir === dir) return n;
      for (const c of n.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  }

  /**
   * 进某个目录（点网格里的文件夹格子）。与目录树点节点**同一件事**：
   * 只改 `dir`，面包屑与树的选中都是它的下游 —— 别发明第二套导航状态。
   * 顺带把树展开到看得见那个目录（不然点进去之后左边一点反应都没有）。
   *
   * ⚠️ **P7.24 · T2**（独立审 🟡3 抓的漏网）：`ancestors()` **不含 `''`（库根）** ——
   * 根可收之后，"展开到看得见它"的承诺要在 `open` 里**补上 `''`**（否则根被收着时
   * 双击文件夹 / 新建文件夹，左边树仍只有「整个知识库」一行，与这条承诺相反）。
   */
  private openDir(dir: string): void {
    // 点目录 = 一次显式的视野动作 → 跳转带来的那份一次性清单到此为止（P6b ①）
    this.endJumpScope();
    const s = this.store.get();
    const opening = Array.from(new Set([...s.open, '', ...ancestors(dir)]));
    if (s.dir === dir) {
      // 已经站在这个目录里：只把"看得见"补上（根被收着时再双击它，树也该展开出来）
      if (opening.length !== s.open.length) this.store.set({ open: opening });
      return;
    }
    this.store.set({ dir, open: opening });
  }

  /**
   * **"跳转来的那一份一次性清单"到此为止**（P6b ①，用户 2026-09-27 的第二条反馈）。
   *
   * 一句话口径：**一次性清单只活到用户下一次显式的视野动作为止** ——
   * 点目录 / 点面包屑 / 改搜索词都算"我改主意了，要看别处"。
   *
   * 三条边界：
   *  · **只在"现在生效的还是跳转给的那一份"时才清**（`canRestoreJump`）。用户自己去
   *    筛选面板改过之后，那份筛选**是他的**，不该被我们顺手抹掉（也与"还原按钮消失"同一条判据）；
   *  · 连**预选中**一起清 —— 跳转带来的选中和它的筛选是同一件事（用户截图里的"已选 3 篇"
   *    就是跳转给的），留着的话工具条还停在批量栏上、反而挡住了还原按钮；
   *  · 清选中**走 store**（`syncEscapeLayer` 是 Esc 层的唯一出处，订阅里统一维护）。
   */
  private endJumpScope(): void {
    const s = this.store.get();
    if (!this.canRestoreJump(s)) return;
    this.store.set({
      filters: emptyFilters(),
      jumpFilter: null,
      jumpDir: null,
      selected: [],
      anchor: null,
      cursor: null,
    });
  }

  /** 换目录（点节点 / 点面包屑 / 筛选面板里选目录 / 树上按 ↑↓）：**唯一出处**，顺带结束跳转清单 */
  private selectDir(dir: string): void {
    this.endJumpScope();
    this.store.set({ dir });
  }

  /**
   * **意图是"一次性"的：消费掉就把它从 shell store 里清掉**（独立审查 A 路 🔴2）。
   *
   * 🔴 为什么非清不可：去重只在本实例里靠 `lastIntentSeq` —— 模块**整个重建**（切走再回来、
   * `paintModule` 换模块）时新实例的 `lastIntentSeq = 0`，于是 `if (st.notesIntent)` 又成立，
   * **把上一次跳转原样再放一遍**：用户点过「还原显示」回到"这个目录下的全部笔记"，
   * 去别处转一圈回来，筛选与预选中一起复活（"我不是还原过了吗"）。
   *
   * ⚠️ 不影响"同一个动作再点一次还要生效"：`goNotes()` 每次都会 `notesIntentSeq + 1` 并带上新意图
   *（内容相同也无所谓 —— 序号变了）。
   * ⚠️ 也不影响"模块没挂载时先记下意图，等挂载时再用"：清的是**消费之后**的那一份。
   */
  private consumeIntent(): void {
    if (this.ctx.store.get().notesIntent) this.ctx.store.set({ notesIntent: null });
  }

  /**
   * 触屏选择模式：进出都要把 Esc 那一层跟着压/弹（见 `syncEscapeLayer`）。
   * ⚠️ 类名走 `grid.setSelectMode`（就地改），**不进 `listKey`** —— 理由见
   * `GridHandle.setSelectMode`：重绘会把手势中途的拖动句柄一起收掉。
   */
  private setSelectMode(next: boolean): void {
    if (this.store.get().selectMode === next) return;
    this.grid?.setSelectMode(next);
    this.store.set({ selectMode: next });
  }

  private onGridSort(key: GridSortKey): void {
    const cur = this.store.get().gridSort;
    // 点当前这一项 = 反向（与表头"点同一列反向"同一条手感）
    this.store.set({
      gridSort:
        cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    });
  }

  /** 网格内换位落定（§3.5「拖动换位」） */
  private applyGridReorder(visNew: string[], moving: string[]): void {
    if (moving.length === 0 || visNew.length === 0) return;
    const s = this.store.get();
    /**
     * ⚠️ **先 `seedOrder` 再 `mergeReorder`**：第一次拖动时表是空的，
     * 没有锚就定位不到落点 → 表里只剩被拖的那几篇（其余顺序当场丢）。
     * 两条一起用才是完整的"并回全库表"。
     */
    /**
     * ⚠️ **三步都要**：`seedOrder` 补新来的 → `reseatOrder` 把可见项按**屏幕顺序**重新落座
     * → `mergeReorder` 把被拖的那几篇并回全表。
     *
     * 少了中间那一步就会出这个 bug（独立审查逮的，逐帧推演过）：
     * **自动排列开着**时屏幕是按排序规则排的、而表里是上一次自由摆放的旧顺序 ——
     * 直接并回去会让"除被拖那一篇之外**整片跳回旧手排顺序**"。
     */
    const seeded = seedOrder(this.ctx.settings.get().gridOrder, visNew);
    const next = mergeReorder(reseatOrder(seeded, visNew), visNew, moving);
    /**
     * 🔴 **拖完自动取消「自动排列」**（本项目对 §3.5 那一行的解读，理由要写下来）：
     * §3.5 说「自动排列开 = 按排序规则铺满」，又说「自动排列开启时，拖动 = 按新位置重排」——
     * 两条并存的唯一自洽解是：**拖动就是对"排序规则"的一次显式否决**。
     * 不取消的话，落点写进了顺序表、界面却立刻被排序规则顶回去
     *（"我拖了，它弹回去了"）—— 正是本项目最烦的那类"点了没反应"。
     * 顺序表本身不受影响：重新勾上「自动排列」再取消，摆的顺序还在（§12 决策 7）。
     */
    const unpin = s.gridAutoArrange;
    // ① 顺序表**直接落盘**（不经过 store 副本，也不走 `persist` 的 400ms 防抖）
    void this.ctx.settings.save(unpin ? { gridOrder: next, gridAutoArrange: false } : { gridOrder: next });
    // ② 「自动排列」是单写入方的 store 字段（它变要重画）—— 单独推一下
    if (unpin) this.store.set({ gridAutoArrange: false });
    /**
     * ③ 🔴 **必须显式重画一次**（别以为"拖动时 DOM 已经挪好了"）。
     *
     * `ui/dnd` 的拖动过程里，被拖的那一格是 `display:none` 藏在**原位**的，
     * 真正移动的只是那个"虚线空位"（`gapEl`）。松手时 `endDrag()` 把原格恢复显示 ——
     * 于是 DOM 又变回**拖动前**的顺序。不去按新表重画一遍的话，
     * 用户看到的就是"我拖了，它弹回原处"（拖了个寂寞）。
     * ⚠️ 而且这一步`gridAutoArrange` 已经是 false 时**没有任何其他东西会触发重画**
     *（store 里没有别的字段变了）→ 必须主动叫。
     */
    this.repaint();
  }

  /** 拖到左侧目录节点 → 搬文件（**走 `mover`**，与表格那边同一条链） */
  private applyGridMoveToDir(paths: string[], dir: string): void {
    const set = new Set(paths);
    const entries = this.entries().filter((e) => set.has(e.path));
    if (entries.length === 0) return;
    void this.ops.moveNow(entries, dir, 'drag', `拖拽移动到 ${dir || '库根'}`);
  }

  /**
   * 框选落定（§3.5「框选」）。
   * `additive`（起手按了 Ctrl/Shift）= 与起手时的选择取并集；否则替换。
   * ⚠️ 空框（点一下没拖）**不改选择** —— `marqueeHit` 对零尺寸返回空，
   * 这里不能再顺手把选择清掉（用户的本意多半是"取消框选"）。
   */
  private applyMarquee(paths: string[], additive: boolean): void {
    const s = this.store.get();
    /**
     * v2 · #5：模板不进选择集 —— 网格 `gridBoxes()` 已先滤一道（预览高亮与「框选 N 项」
     * 都跟着准）；这里再滤一次 = **store 写入边界的兜底**（将来别的调用方漏了也伤不到）。
     */
    const tpl = new Set(this.entries().filter((e) => e.isTemplate).map((e) => e.path));
    const hit = paths.filter((p) => !tpl.has(p));
    if (!additive && hit.length === 0) {
      // 零尺寸那一发（或只框到模板）：什么都不做（既不清空、也不提交）
      return;
    }
    this.store.set({
      selected: additive ? Array.from(new Set([...s.selected, ...hit])) : hit,
      /**
       * ⚠️ 锚点取**本次框中的**第一项（`hit` 就是滤后命中），与看板 `startMarquee` 同一个口径
       * （独立审查 🟢10：那边写的是 `hit[0] ?? s.anchor`）。并集模式下"锚点落在旧选择里"
       * 会让随后那一次 `Shift+`点选的起点莫名其妙。
       */
      anchor: hit[0] ?? s.anchor,
      cursor: hit[0] ?? s.cursor,
    });
  }

  /** 网格档的点选（与表格**同一套口径** + 触屏选择模式这一支） */
  private onGridClick(e: NoteEntry, evt: MouseEvent): void {
    const s = this.store.get();
    // v2 · #5：模板格子**不进选择集**（与表格行同一口径；双击仍可打开编辑）
    if (e.isTemplate) return;
    /**
     * 触屏选择模式下点一下 = **加选/减选**（不是"只选它"）—— 这就是 §3.5
     * 「长按不动 → 进选择模式，图标冒复选框」之后的那一步：逐个点。
     */
    if (s.selectMode) {
      this.store.set({
        selected: toggleSelected(s.selected, e.path),
        cursor: e.path,
        anchor: e.path,
      });
      return;
    }
    this.onRowClick(e, evt);
  }

  private paintSelection(s: NotesState): void {
    const selected = new Set(s.selected);
    if (this.grid) {
      this.grid.setSelection(selected, s.cursor);
      return;
    }
    if (!this.table) return;
    for (const row of Array.from(this.table.el.querySelectorAll<HTMLElement>('.kbw-trow'))) {
      const path = row.dataset.path ?? '';
      row.classList.toggle('is-selected', selected.has(path));
      row.classList.toggle('is-cursor', s.cursor === path);
      const box = row.querySelector<HTMLInputElement>('.kbw-rowcheck');
      if (box) box.checked = selected.has(path);
    }
  }

  // ── 选择与打开 ───────────────────────────────────────────────
  private onRowClick(e: NoteEntry, evt: MouseEvent): void {
    /**
     * ⚠️ **刚拖过就吞掉这一发 click**（a.5-1）：`pointerup` 的 preventDefault 拦不住 click，
     * 拖完松手会补一发 —— 在表格里症状是"拖完莫名其妙把别的行选中了/选择没了"。
     * 看板那边同一个判据（那里更刺眼：会弹出悬浮小窗）。
     */
    if (wasDraggingRecently()) return;
    // v2 · #5：模板行**不进选择集**（看得见、不可被批量操作；双击仍可打开编辑）
    if (e.isTemplate) return;
    const s = this.store.get();
    const order = this.visible().filter((x) => !x.isTemplate).map((x) => x.path);
    const path = e.path;
    /**
     * 选择语义走 `modules/board/select.ts` 的**共享纯函数**（c 期独立审查 🟢12）：
     * 原先这里有一份内联实现，与看板那份在边界上**已经不同**了 ——
     * 比如"Shift 点到一个不在列表里的目标"：这边退化成"只选这一张"，看板那边是"保持原样"。
     * 两屏各一份、且只有一边有判据，将来谁改一边另一边不会红。
     * ⚠️ `select.ts` 只吃数组，不 import 任何东西 → 这个依赖方向**没有环**。
     */
    if (evt.shiftKey) {
      const anchor = s.anchor ?? path;
      if (order.includes(anchor) && order.includes(path)) {
        this.store.set({
          selected: rangeSelected(order, s.selected, anchor, path, hasMod(evt)),
          cursor: path,
          anchor,
        });
        return;
      }
    }
    if (hasMod(evt)) {
      this.store.set({ selected: toggleSelected(s.selected, path), cursor: path, anchor: path });
      return;
    }
    this.store.set({ selected: [path], anchor: path, cursor: path });
  }

  private onRowMenu(e: NoteEntry, evt: MouseEvent): void {
    // 右键未选中的行 → 先把它选上（Windows 手感：右键即选中）；
    // v2 · #5：模板行**不预选中**（选择集会喂批量栏）—— 菜单照常开（单篇显式操作）
    if (!e.isTemplate && !this.store.get().selected.includes(e.path)) {
      this.store.set({ selected: [e.path], anchor: e.path, cursor: e.path });
    }
    showNoteMenu(e, evt, this.menuCtx());
  }

  // ── 菜单 ─────────────────────────────────────────────────────
  /** `MenuCtx` 的**唯一出处**（行菜单 / 目录节点菜单 / 空白菜单都走它）—— 各拼一份迟早漂 */
  private menuCtx(): MenuCtx {
    return {
      ctx: this.ctx,
      ops: this.ops,
      onRename: (entry) => this.startRename(entry),
      onExpandOne: (dir) => this.expandOne(dir),
      onExpandAll: (dir) => this.expandAll(dir),
      onCollapse: (dir) => this.collapseDir(dir),
      // 「全部收起」（P7.24 · T3 进目录节点菜单）= 与空白菜单那条**同一个** `collapseAll`
      onCollapseAll: () => this.collapseAll(),
      onOpenDir: (dir) => this.openDir(dir),
    };
  }

  /**
   * **展开一层**（P7.23「展开子目录」）：本目录 + **直接子目录**（一层）。
   * 与「完全展开」的差别就是"递归不递归" + 不碰 `treeShowFiles`（不列文件行）。
   */
  private expandOne(dir: string): void {
    const kids = (this.nodeOf(dir)?.children ?? []).map((c) => c.dir);
    this.store.set({
      open: Array.from(new Set([...this.store.get().open, dir, ...kids])),
    });
  }

  /**
   * **完全展开**（P7.23 升格；原「展开全部子目录」）：递归展开**且**整棵子树进
   * 「含文件展示」（Q1：字面实现"包括所有子文件夹，并显示文件"）。
   * 目录节点菜单与空白菜单共用一份。
   */
  private expandAll(dir: string): void {
    const s = this.store.get();
    const sub = allDirs(this.nodeOf(dir));
    this.store.set({
      open: Array.from(new Set([...s.open, dir, ...sub])),
      treeShowFiles: Array.from(new Set([...s.treeShowFiles, dir, ...sub])),
    });
  }

  /**
   * **收起此文件夹**（P7.23 · Q3）：`open` **只收本节点**（与点三角一致，后代记录保留）；
   * `treeShowFiles` 把**整棵子树**清掉 —— "收起来就该全收"：用户看不见的展开态记录留着
   * 只会让"再展开"时文件行诡异地半开，不如清干净（下次要用再「完全展开」）。
   *
   * P7.24 起 `dir` 也可以是 `''`（库根，T2 反转）—— 收根与收别的目录**同一条链**；
   * 行尾「收起」按钮（T1）与节点菜单共用本函数，没有第二套。
   */
  private collapseDir(dir: string): void {
    const s = this.store.get();
    const drop = new Set([dir, ...allDirs(this.nodeOf(dir))]);
    this.store.set({
      open: s.open.filter((d) => d !== dir),
      treeShowFiles: s.treeShowFiles.filter((d) => !drop.has(d)),
    });
  }

  /**
   * **全部收起**（P7.24 · T3 —— 从空白菜单那条**收编成一处**）：整棵树的展开态与
   * 「含文件展示」一起清。
   *
   * ⚠️ **连根一起收**（用户 2026-10-11 拍板"更彻底"那一档）：清空 `open` 之后
   * 连 `''`（库根）也不在 → 树只剩「整个知识库」一行。想再看见层级就点根 caret。
   * 目录节点菜单（T3 · 只给根画）与空白菜单**都调这一个函数**（静态可查同一处）。
   */
  private collapseAll(): void {
    this.store.set({ open: [], treeShowFiles: [] });
  }

  // ── 原地改名（F2 / 菜单；P7.1c 起**两档都有**）─────────────────
  private startRename(entry: NoteEntry): void {
    this.store.set({ renaming: entry.path, cursor: entry.path });
    this.mountRenameAt(entry.path);
  }

  /**
   * 把改名输入框挂到"名称处"——**两档的挂点不同**（P7.1c ①：F2 从"仅表格"放开到两档）：
   * 表格是名称格 `[data-col=name]`；网格是格子里那一行名 `.kbw-gname`
   * （挂进去前 `mountRenameInput` 会给它贴 `is-renaming` 解开 line-clamp —— c 期那笔账）。
   *
   * 🔴 **挂不上就把 `renaming` 清掉**（独立审查 🔴1）：那篇被筛掉 / 不在这一层时两处都找不到格
   * ——老代码"放弃挂载"但把 `renaming` 留在 store 里，而拖动守卫看的就是它 →
   * **之后每一发行 pointerdown 都早退**（详细档拖动静默失灵，Esc 也清不掉：
   * 改名那层 Esc 是在 `mountRenameInput` 里才压的）。清掉 = 改名取消，与"行离开视野"一致；
   * 那篇重新可见时也不会突然冒出一个输入框。
   */
  private mountRenameAt(path: string): void {
    const row = this.table?.rowFor(path) ?? null;
    const cell = row
      ? row.querySelector<HTMLElement>('[data-col="name"]')
      : this.grid?.cellFor(path)?.querySelector<HTMLElement>('.kbw-gname') ?? null;
    if (!cell) {
      if (this.store.get().renaming != null) this.store.set({ renaming: null });
      return;
    }
    if (!cell.querySelector('input')) this.mountRenameInput(cell, path);
  }

  private mountRenameInput(cell: HTMLElement, path: string): void {
    const entry = this.entitiesByPath(path);
    if (!entry) return;
    // Esc 分层：输入框这一层要压在最上面（否则 Esc 会先去清空选择，
    // 而全局捕获监听在输入框自己的 keydown 之前就把事件吃掉了）
    this.renameEsc?.();
    this.renameEsc = pushEscapeLayer(() => {
      finish(false);
      return true;
    }, 'notes:rename');
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    /**
     * ⚠️ 网格档：`.kbw-gname` 带着 `-webkit-box + line-clamp`（P7.1b 的两行裁切），
     * 而它是 legacy flexbox —— 输入框进去会被**压扁**（c 期那笔账）。贴 `is-renaming`
     * 让 CSS 把它换回普通块（`styles/notes.css` 那条规则；表格档贴了也无副作用）。
     */
    cell.classList.add('is-renaming');
    const input = el('input', {
      cls: 'kbw-inline-input',
      attr: { type: 'text', value: entry.basename, 'aria-label': '新名字' },
    });
    cell.appendChild(input);
    input.focus();
    input.select?.();
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      this.renameEsc?.();
      this.renameEsc = null;
      const next = input.value;
      this.store.set({ renaming: null });
      if (commit) void this.ops.rename(entry, next);
      else this.repaint();
    };
    input.addEventListener('keydown', (evt) => {
      const k = evt as KeyboardEvent;
      if (k.key === 'Enter') {
        k.preventDefault();
        k.stopPropagation();
        finish(true);
      } else if (k.key === 'Escape') {
        k.preventDefault();
        k.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  private entitiesByPath(path: string): NoteEntry | undefined {
    return this.entries().find((e) => e.path === path);
  }

  // ── 键盘 ─────────────────────────────────────────────────────
  /** 走路由的动作（KEY_ACTIONS 里的那 13 个） */
  private onKey(action: KeyActionId, evt: KeyboardEvent): boolean {
    const s = this.store.get();
    const vis = this.visible();
    const inTree = this.treeHost.contains(document.activeElement);
    if (inTree) {
      const handled = this.onTreeKey(action);
      if (handled != null) return handled;
    }
    switch (action) {
      case 'focus-search':
        // 批量栏是"整块替换工具条"（搜索框此刻不在 DOM 里）→ 先清空选择再聚焦，
        // 不然 `/` 会静默失效（独立审查指出）
        if (s.selected.length > 0) this.store.set({ selected: [], anchor: null, cursor: null });
        this.searchInput?.focus();
        this.searchInput?.select?.();
        return true;
      case 'move-down':
        return this.moveCursor(1, false, vis);
      case 'move-up':
        return this.moveCursor(-1, false, vis);
      case 'range-down':
        return this.moveCursor(1, true, vis);
      case 'range-up':
        return this.moveCursor(-1, true, vis);
      case 'toggle-select':
        return this.toggleCursor(vis);
      case 'select-all':
        // v2 · #5：模板看得见但不进批量 —— Ctrl+A 与批量栏「全选」同一口径（剔模板）
        this.store.set({
          selected: vis.filter((e) => !e.isTemplate).map((e) => e.path),
          anchor: vis.find((e) => !e.isTemplate)?.path ?? null,
        });
        return true;
      case 'open': {
        const cur = s.cursor ? this.entitiesByPath(s.cursor) : undefined;
        if (!cur) return false;
        this.ops.open(cur, hasMod(evt) ? 'newTab' : 'current');
        return true;
      }
      case 'context-menu': {
        const cur = s.cursor ? this.entitiesByPath(s.cursor) : undefined;
        // 两档各取各的行元素（菜单本身是同一份 `ui/menu.ts`，硬规矩 2）
        const row = cur ? (this.table?.rowFor(cur.path) ?? this.grid?.cellFor(cur.path) ?? null) : null;
        if (!cur || !row) return false;
        const r = row.getBoundingClientRect();
        this.onRowMenu(cur, { clientX: r.left + 40, clientY: r.top + 8, preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent);
        return true;
      }
      default:
        return false;
    }
  }

  /** 树里的 ↑↓ / ←→（焦点在树里时才走到这里；返回 null = 不接管） */
  private onTreeKey(action: KeyActionId): boolean | null {
    const s = this.store.get();
    const root = this.treeRoot();
    const flat: TreeNode[] = [];
    /**
     * ⚠️ **P7.24 · T2**：这里原来也有 `|| n.dir === ''`（"根恒开"的镜像特例，与
     * `tree.ts` 的 walk 同款）—— 根可收之后若留着，根收起时 ↓ 会把选中送到**没被渲染**的
     * 顶层目录（树无高亮、列表却已切走）。展开态一律看 `open`（独立审 🔴2 抓的漏网点）。
     */
    const walk = (n: TreeNode, depth: number): void => {
      flat.push(n);
      if (s.open.includes(n.dir)) for (const c of n.children) walk(c, depth + 1);
    };
    walk(root, 0);
    const idx = flat.findIndex((n) => n.dir === s.dir);
    if (action === 'move-down' || action === 'move-up') {
      const next = Math.min(flat.length - 1, Math.max(0, idx + (action === 'move-down' ? 1 : -1)));
      if (flat[next]) this.selectDir(flat[next].dir);
      return true;
    }
    if (action === 'move-right') {
      if (!s.open.includes(s.dir)) this.store.set({ open: [...s.open, s.dir] });
      return true;
    }
    if (action === 'move-left') {
      if (s.open.includes(s.dir)) this.store.set({ open: s.open.filter((d) => d !== s.dir) });
      return true;
    }
    if (action === 'escape') return null; // 交给外层
    return null;
  }

  private moveCursor(delta: 1 | -1, extend: boolean, vis: NoteEntry[]): boolean {
    if (vis.length === 0) return true;
    const s = this.store.get();
    const idx = s.cursor ? vis.findIndex((e) => e.path === s.cursor) : -1;
    const next = idx < 0 ? (delta > 0 ? 0 : vis.length - 1) : Math.min(vis.length - 1, Math.max(0, idx + delta));
    const path = vis[next].path;
    if (extend) {
      const anchor = s.anchor ?? (idx >= 0 ? vis[idx].path : path);
      const a = vis.findIndex((e) => e.path === anchor);
      // v2 · #5：范围选剔掉模板（Shift+↑↓ 与 Shift+点选 / 框选同一口径）
      const range = vis
        .slice(Math.min(a, next), Math.max(a, next) + 1)
        .filter((e) => !e.isTemplate)
        .map((e) => e.path);
      this.store.set({ cursor: path, anchor, selected: range });
    } else {
      // ⚠️ ↑↓ 只移**高亮**，不改选中（交互规格 §1.4：选中是 Space / 单击的事）
      this.store.set({ cursor: path, anchor: s.selected.length > 0 ? s.anchor : path });
    }
    // 两档各有各的滚动容器（表格是 `listHost` 自己，网格是 `.kbw-grid`）→ 两个都要叫
    this.table?.scrollRowIntoView(path);
    this.grid?.scrollCellIntoView(path);
    return true;
  }

  private toggleCursor(vis: NoteEntry[]): boolean {
    const s = this.store.get();
    const path = s.cursor ?? vis[0]?.path;
    if (!path) return false;
    // v2 · #5：光标停在模板行上时 Space 不发选择（与可勾选的行同一口径）
    if (vis.find((e) => e.path === path)?.isTemplate) return true;
    const next = s.selected.includes(path)
      ? s.selected.filter((p) => p !== path)
      : [...s.selected, path];
    this.store.set({ selected: next, cursor: path, anchor: path });
    return true;
  }

  /**
   * 列表区的本地键（**两档共用、不进 keymap**）：`Alt+↑` / `F2` / `Ctrl+Enter` /
   * `Del` / `Home` / `End` —— 都不在那 14 个全局动作里（E2 拍板：`KEY_ACTIONS` 是
   * 探针与文档钉着的契约，本轮的键一律走 `dispatchRaw` 这条"表里没有的键"的路）。
   */
  private onLocalKey(evt: KeyboardEvent): void {
    if (isEditable(evt.target)) return;
    const s = this.store.get();
    /**
     * **`Alt+↑` = 回到上一级目录**（P6b ②，设计稿那条"返回上一级：面包屑 + `Alt+↑`"）。
     * 为什么走这条"表里没有的键"的路子：它**不该出现在快捷键表里**（那是 14 个全局动作的表，
     * 这一个只在「全部笔记」这一屏有意义）——`dispatchRaw` 正是给这种键准备的。
     * ⚠️ 库根（`''`）**再往上还是自己**，什么都不做（不弹提示：那不是错误操作）。
     */
    if (evt.key === 'ArrowUp' && evt.altKey && !hasMod(evt)) {
      const cur = this.store.get().dir;
      if (!cur) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.selectDir(parentDir(cur));
      return;
    }
    /**
     * `F2` 就地改名（P7.1c ① 起**两档都有**；原注释说"只在表格档"的成因——
     * 网格没有"名称格"——已随 `.kbw-gname` 那个挂点消失）。范围（E5 拍板）：
     * **只笔记格**；文件夹格/行不接（改名非空目录会搬 N 篇，走右键那套 = 只对空目录开放）。
     * ⚠️ 文件管理器里"选中文件夹按 F2"很顺手，所以这条边界要写进 §3.3/§3.5 的表。
     */
    if (evt.key === 'F2' && s.cursor) {
      const entry = this.entitiesByPath(s.cursor);
      if (entry) {
        evt.preventDefault();
        evt.stopPropagation();
        this.startRename(entry);
      }
      return;
    }
    if (evt.key === 'Enter' && hasMod(evt) && s.cursor) {
      const entry = this.entitiesByPath(s.cursor);
      if (entry) {
        evt.preventDefault();
        evt.stopPropagation();
        this.ops.open(entry, 'newTab');
      }
      return;
    }
    /**
     * `Del` = 删除到回收站（P7.1c ②；2.3 拍板 + E1：**两档同一入口**）。
     * 删谁：**选中集优先**；没有选中时删光标那篇（"Del 删当前项"的 Windows 手感）。
     * 安全语义（别在此处放宽）：`local` 直删（撤销条 + 快照兜底）、`system`/`none`
     * 走现有两下确认流 —— 全在 `ops.trashQuick` 一处实现。
     */
    if (evt.key === 'Delete' && !hasMod(evt) && !evt.altKey && !evt.shiftKey) {
      const targets: NoteEntry[] =
        s.selected.length > 0
          ? this.selectedEntries()
          : s.cursor
            ? [this.entitiesByPath(s.cursor)].filter((e): e is NoteEntry => Boolean(e))
            : [];
      if (targets.length === 0) return;
      evt.preventDefault();
      evt.stopPropagation();
      void this.ops.trashQuick(targets);
      return;
    }
    /**
     * `Home` / `End` = 光标到首/尾格（P7.1c ⑥；E2：走 raw 键，**不进 `KEY_ACTIONS`**
     * —— 那 14 个动作是探针/文档钉着的契约）。与 ↑↓ 同一条口径：**只移高亮不改选中**；
     * 两档都接，滚动容器各叫各的。
     */
    if ((evt.key === 'Home' || evt.key === 'End') && !hasMod(evt) && !evt.altKey && !evt.shiftKey) {
      const vis = this.visible();
      if (vis.length === 0) return;
      evt.preventDefault();
      evt.stopPropagation();
      const path = (evt.key === 'Home' ? vis[0] : vis[vis.length - 1]).path;
      this.store.set({ cursor: path, anchor: s.selected.length > 0 ? s.anchor : path });
      this.table?.scrollRowIntoView(path);
      this.grid?.scrollCellIntoView(path);
    }
  }

  // ── 拖拽：表格行 → 目录树 / 文件夹行 / 面包屑 ─────────────────
  private onRowPointerDown(entry: NoteEntry, evt: PointerEvent): void {
    if (evt.button !== 0) return;
    // v2 · #5：模板行**不可拖**（看得见、不进批量；右键菜单里的单篇操作照旧可用）
    if (entry.isTemplate) return;
    const target = evt.target as HTMLElement | null;
    if (target?.closest?.('input, .kbw-rowcheck, .kbw-col-grip, .kbw-inline-input')) return;
    /**
     * **就地改名进行中 → 不起拖动**（P7.1c · ①）：这一发之后焦点会离开输入框 → blur →
     * 提交改名；提交完照旧能接着点/拖。网格档同一条（`grid.ts` 的 `onCellPointerDown`）。
     * ⚠️ 判据是**DOM 事实**（输入框在不在），不是 store 的 `renaming` —— 两档同一个口径，
     * 而且对"陈旧状态"天然免疫（独立审查 🟡2；`mountRenameAt` 挂不上时也会清 renaming，双保险）。
     */
    if (this.listHost.querySelector('.kbw-inline-input')) return;
    const s = this.store.get();
    if (!s.selected.includes(entry.path)) {
      this.store.set({ selected: [entry.path], anchor: entry.path, cursor: entry.path });
    }
    const dragging = this.selectedEntries();
    this.dragging = dragging.length > 0 ? dragging : [entry];
    this.stopDrag?.();
    this.stopDrag = startPointerDrag(evt, entry, {
      onStart: () => {
        this.ghost = dragGhost(`${this.dragging.length} 篇`);
        this.ghost.move(evt.clientX, evt.clientY);
        /**
         * 拖动真的开始了（越过阈值）→ ① 工具条让位给面包屑（`dragActive`，只进工具条 key）
         * ② 边缘自动滚动起跑（P7.1c ⑥）。两件都在这儿起，`endDrag` 里一起收。
         */
        this.setDragActive(true);
        this.edgeScroll = startEdgeScroll(this.listHost);
      },
      onOver: (targetEl, c) => {
        this.ghost?.move(c.x, c.y);
        this.edgeScroll?.update(c.x, c.y);
        const dir = targetEl?.dataset.drop ?? null;
        // 掠过文件夹行 / 面包屑段 → 就地高亮；掠过折叠的树节点 ~500ms → 展开（P7.1c ③④）
        this.markDropHints(targetEl, dir);
        this.hoverExpandTree(dir);
        if (dir == null) {
          if (this.store.get().dragDir != null) this.store.set({ dragDir: null, dragCount: 0 });
          return;
        }
        if (this.store.get().dragDir !== dir) {
          this.store.set({ dragDir: dir, dragCount: this.dragging.length });
        }
      },
      onDrop: (targetEl) => {
        const dir = targetEl?.dataset.drop;
        this.endDrag();
        if (dir == null) return;
        void this.ops.moveNow(this.dragging, dir, 'drag', `拖拽移动到 ${dir || '库根'}`);
      },
      onCancel: () => this.endDrag(),
    });
  }

  private endDrag(): void {
    // 落点高亮（文件夹行 / 面包屑段）/ 悬停展开计时器 / 边缘滚动 / 工具条档位，一处不留
    this.markDropHints(null, null);
    this.clearHoverExpand();
    this.edgeScroll?.dispose();
    this.edgeScroll = null;
    this.setDragActive(false);
    this.ghost?.dispose();
    this.ghost = null;
    this.stopDrag = null;
    if (this.store.get().dragDir != null || this.store.get().dragCount > 0) {
      this.store.set({ dragDir: null, dragCount: 0 });
    }
  }

  /**
   * 列表区的 **Region key**（重绘判据）。
   * ⚠️ 改它的时候**同时看 `keepScrollKey`**：新字段属于"内容/瞬时态"还是"视图参数"。
   */
  private listKey(s: NotesState): string {
    return `${s.rev}|${s.view}|${s.search}|${s.scope}|${JSON.stringify(s.filters)}|${
      s.sort?.key ?? ''
    }${s.sort?.dir ?? ''}|${this.effectiveHidden().join(',')}|${JSON.stringify(s.widths)}|${
      s.dir
    }|${s.renaming ?? ''}|${s.gridSort.key}${s.gridSort.dir}|${s.gridAutoArrange ? '1' : '0'}|${s.paintRev}|${JSON.stringify(
      // ⚠️ 独立审 🟢9：`gridOrder` 是**文件路径数组**（名字能带逗号）—— `join(',')` 有同族
      // 碰撞（`['a,b']` vs `['a','b']`），上 JSON.stringify（与树 key 的修法同一条纪律）
      this.ctx.settings.get().gridOrder,
    )}`;
  }

  /**
   * **"要不要保住滚动位置"的那一份 key** —— 与 `listKey` **同源**，只把"内容/瞬时态"
   * 那几个字段抹平（`rev` / `renaming` / `gridOrder`）。剩下的是**视图参数**（视图档 /
   * 搜索 / 范围 / 筛选 / 排序 / 列宽 / 目录）：它们变了说明用户改了视图，那本来就该回到顶上。
   *
   * ⚠️ **默认保**：新字段没加进这里 = "它变了也保住滚动"（安全的那一侧）。
   */
  private keepScrollKey(s: NotesState): string {
    /**
     * 抹平三类：① `rev` / `paintRev`（"请重画一次"的瞬时态）；
     * ② `renaming`（就地改名的进出）；③ **`gridAutoArrange`**。
     *
     * ⚠️ ③ 是独立审查指出的缺口：**拖动落点时它会顺带被关掉**（见 `applyGridReorder`），
     * 而它进了 `listKey` 却没在这里抹平 → **那一次拖动会把列表与目录树的滚动一起清零**。
     * 它是"拖动的一个副作用"，不是"用户改了视图" —— 用户既没点排序也没换筛选，
     * 凭什么把他翻到一半的位置收走。（真的显式切自动排列时不再重置滚动：可接受的让步。）
     */
    return this.listKey({ ...s, rev: -1, paintRev: 0, renaming: null, gridAutoArrange: true });
  }

  // ── 首页/命令跳过来的意图 ────────────────────────────────────
  private applyIntent(intent: NotesIntent): void {
    const patch: Partial<NotesState> = {};
    if (intent.dir != null) patch.dir = intent.dir;
    if (intent.search != null) patch.search = intent.search;
    if (intent.flags || intent.paths) {
      const f = { ...emptyFilters() };
      if (intent.flags) f.health = intent.flags as HealthFlag[];
      if (intent.paths) f.paths = intent.paths;
      patch.filters = f;
      // 记下"这份筛选是跳转给的" → 工具条上给一条显眼的回头路（A3）
      patch.jumpFilter = f;
    } else {
      // 这次跳转没带筛选（「整理收件箱」那种只带目录/全选）→ 别留着上一次的还原口
      patch.jumpFilter = null;
    }
    /**
     * **带 `dir` 的跳转也记一笔**（P7.9 · ④）：「整理收件箱 → 去全部笔记自己整理」带的就是
     * 目录 + 全选 —— 旧判据只看筛选，跳过去之后**一点回头路都没有**（用户复现）。
     * 与 `jumpFilter` 同规矩：只对**这次跳转带来的**变化记账，没带目录就清掉上一笔。
     */
    patch.jumpDir = intent.dir != null ? intent.dir : null;
    if (intent.selectPaths && intent.selectPaths.length > 0) {
      patch.selected = intent.selectPaths;
      // 锚点也要给：不然预选中之后按 Shift 范围选，起点会漂到上一次的锚点
      patch.anchor = intent.selectPaths[0];
      patch.cursor = intent.selectPaths[0];
    }
    this.store.set(patch);
    /**
     * **跳过来那一刻给一条轻通知**（P6b ①，设计稿的原话是「已按待处理筛选 · 可还原」）。
     *
     * 为什么不能只靠按钮：跳转之后工具条常被批量栏顶掉（用户截图 2 那个状态），
     * 而"我该怎么回去"是这一刻唯一的问题 —— 一句轻通知既说明"现在是筛过的"，
     * 又指出有回头路（按钮就在旁边）。连续跳不打扰：`light` 档会自己淡出。
     */
    if (patch.jumpFilter) {
      notify({
        kind: 'info',
        text: intent.flags ? '已按待处理筛选 · 可还原' : '已跳到这几篇 · 可还原',
        ms: NOTIFY_MS.light,
      });
    }

    /**
     * **"跳过来"要看得见**（e2 期 §4.1）：设了预选中就把它滚进视野。
     * ⚠️ 时机在 `store.set` **之后** —— 订阅是同步的，行已经画出来了（`paintList` 同步）；
     * 滚动用 `block:'nearest'`（已经在视野里就不动，别把整页滚一下）。
     */
    if (intent.selectPaths && intent.selectPaths.length > 0) {
      // 两档的行元素不同（`.kbw-trow` / `.kbw-gcell`）—— 都要能"跳过去看得见"
      const row = Array.from(this.listHost.querySelectorAll<HTMLElement>('.kbw-trow, .kbw-gcell')).find(
        (r) => r.dataset.path === intent.selectPaths?.[0],
      );
      row?.scrollIntoView?.({ block: 'nearest' });
    }

    const vis = this.visible();
    let sel: string[] | null = null;
    // v2 · #5：`selectAll` 意图同样剔掉模板（首页「整理收件箱…自己整理」那条路）
    if (intent.selectAll) sel = vis.filter((e) => !e.isTemplate).map((e) => e.path);
    if (sel) {
      this.store.set({ selected: sel, anchor: sel[0] ?? null, cursor: sel[0] ?? null });
      // §2.2「整理收件箱」要求"光标落操作栏"：批量栏刚画出来，把焦点交给第一个按钮
      if (intent.selectAll) this.toolbarHost.querySelector<HTMLElement>('button')?.focus();
    }
  }

  // ── 界面偏好落盘 ─────────────────────────────────────────────
  private persist(s: NotesState, prev: NotesState): void {
    const patch: Partial<WorkbenchSettings> = {};
    if (s.view !== prev.view) patch.notesView = s.view;
    // 只在"用户真的选过"（非 null）时才落盘 —— null 是"还没选过，用默认"
    if (s.hiddenCols && s.hiddenCols !== prev.hiddenCols) patch.columnsHidden = s.hiddenCols;
    if (s.widths !== prev.widths) patch.columnWidths = s.widths;
    if (s.sort !== prev.sort) patch.notesSort = s.sort;
    if (s.open !== prev.open) patch.treeOpen = s.open;
    if (s.treeShowFiles !== prev.treeShowFiles) patch.treeShowFiles = s.treeShowFiles;
    if (s.dir !== prev.dir) patch.treeSelected = s.dir;
    if (s.scope !== prev.scope) patch.searchScope = s.scope;
    // 网格档（P6）：`gridSort` / `gridAutoArrange` 是单写入方的 store 字段，走这里落盘；
    // ⚠️ **`gridOrder` 不走这里** —— 它只活在 settings 里（`applyGridReorder` 直接落盘），
    // 因为插件层的改名迁键也是它的写入方（见 `NotesState` 上那段注释）
    if (s.gridSort !== prev.gridSort) patch.gridSort = s.gridSort;
    if (s.gridAutoArrange !== prev.gridAutoArrange) patch.gridAutoArrange = s.gridAutoArrange;
    if (Object.keys(patch).length > 0) this.saveSoon(patch);
  }
}



