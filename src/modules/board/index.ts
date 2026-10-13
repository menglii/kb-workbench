/**
 * modules/board —— 看板（**P4 实做**）
 *
 * 形态（方案设计.md §2.4 / 交互规格 §4）：工具条 + 一串板块，每个板块是
 * 「板块头（折叠 / 名称 / 计数 / ＋ / ⋯）+ 卡片网格」。
 *
 * 状态分两层，与「全部笔记」同一套：
 *   · **配置**（板块、视图参数、折叠、手动顺序）→ 库内 `06_工作台/看板配置.json`
 *     （`./config.ts` 是唯一写点；设置面板的「看板默认值」栏写的是同一份文件的 `view` 段）
 *   · **本次会话的临时态**（展开的卡片、光标、拖拽掠过、正在改名、顶上一行回执）→ 模块自己的 store
 *
 * ⚠️ 区域重绘的 key 里**没有** `expanded` / `cursor`：那两个是就地改 class，
 * 重画整块会丢滚动位置（与笔记模块"选中不重画表格"同一条理由）。
 */
import { Component } from 'obsidian';
import type { BoardIntent, ModuleRender, WorkbenchContext } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import { Region, Store } from '../../core/store';
import { Disposer, clamp, debounce, hasMod, on } from '../../core/util';
import type { Debounced } from '../../core/util';
import { emptyState, skeleton } from '../../ui/empty';
import { btn, div, el, icon, iconBtn, span } from '../../ui/primitives';
import { NOTIFY_MS, notify, notifyInfo } from '../../ui/notify';
import { isEditable, pushEscapeLayer } from '../../core/keymap';
import { isTouchPointer, startPointerDrag } from '../../ui/dnd';
import { openNewNoteDialog } from '../../ui/new-note';
import { readRouteTable, tagDirs } from '../../services/routes';
import { NotesOps } from '../notes/ops';
import { showNoteMenu, type BoardMenuHooks } from '../notes/menus';
import {
  closeDockingPanel,
  keepPinnedPanel,
  openCardWindow,
  mergeChoices,
  mergeWindowInto,
  panelOfPath,
  panelClaimsWindow,
  panelPaths,
  promoteToTab,
  rebindCardPanel,
  type CardWindowCtx,
} from './editor';
import { onWindowFreed } from './window-seat';
import { closePeek, followPeek, syncPeek, type PeekDeps } from './peek';
// 16.13（P7.2d）：进过看板 = 新手清单第 3 项的一半（另一半是 notes 的视图档切换）
import { recordOnboarding } from '../home/onboarding';
import {
  SCROLL_ATTR,
  applyScroll,
  captureScroll,
  remapScrollPath,
  remapSnap,
  claimScroll,
  restoreIfReset,
  loadMemo,
  saveMemo,
  type ScrollSnap,
} from '../../core/view-memory';
import { showBoardMenu, showPanelDisplayMenu, showSectionMenu } from './menus';
import { closeSectionPanel, openSectionPanel } from './panels';
import { renderCard, emptySection, type CardCallbacks } from './cards';
import { planBoard, defaultPropsFor, type BoardGroup } from './sources';
import {
  CARD_H_MAX,
  CARD_H_MIN,
  CARD_MODE_LABEL,
  CARD_W_MAX,
  CARD_W_MIN,
  BoardConfigStore,
  effectiveCardMode,
  effectiveHeight,
  effectiveProps,
  effectiveWidth,
  isCollapsed,
  type BoardSection,
  type CardMode,
  type PanelPref,
} from './config';
import { batchBar } from '../notes/batch-bar';
import { dropCards, moveCardToGroup, startCardDrag, withInserted, type CardMoveDeps } from './drag';
import { dragSet, marqueeHit, normRect, rangeSelected, toggleSelected } from './select';
import { writeTaskToggle } from './tasks';

/**
 * 看板区的 **Region key**（重绘判据）。
 * ⚠️ 改它的时候**同时看 `keepScrollKey`**：新字段属于"内容/瞬时态变了要重画"，
 * 还是"视图参数变了 → 该回顶上"？前者进 `keepScrollKey` 的抹除名单。
 */
function regionKey(s: BoardState): string {
  return `${s.rev}|${s.cfgRev}|${s.paintRev}|${s.loaded ? 1 : 0}|${s.renamingNote ?? ''}`;
}

/**
 * **"要不要保住滚动位置"的那一份 key** —— 与 `regionKey` **同源**，只把"内容/瞬时态"
 * 那几个字段抹平（`rev` / `paintRev` / `renamingNote`）。剩下的是**视图参数**（`cfgRev`）
 * 与"索引就绪"（`loaded`）：它们变了说明用户改了东西（形态/排序/宽度…）或这一屏刚重建，
 * 那本来就该回到顶上。
 *
 * ⚠️ **默认保**：新字段没加进这里 = "它变了也保住滚动"（安全的那一侧，不会把用户甩回顶上）。
 */
function keepScrollKey(s: BoardState): string {
  return regionKey({ ...s, rev: -1, paintRev: -1, renamingNote: null });
}

interface BoardState {
  /** 索引修订号（区域重绘的 key） */
  rev: number;
  /** 配置修订号（配置被外面改了之后 +1） */
  cfgRev: number;
  /**
   * **"请重画一次"的专属信号**（e2 期独立审查逼出来的 🟡1）。
   *
   * 原先 `repaint()` 借 `cfgRev + 1` 当"请重画" —— 于是任何走 `repaint()` 的重绘
   *（改完名、快速切换跳过来）都被滚动保持那条判据当成"**视图参数变了**、该回顶上"，
   * 把刚保住的位置又清掉。字段分开之后：`cfgRev` = 配置真的变了，`paintRev` = 只是要重画。
   */
  paintRev: number;
  /** 配置读过了吗（没读过 → 骨架屏，别闪一个"空看板"） */
  loaded: boolean;
  /** 正文已展开的卡片 */
  expanded: string[];
  /** 键盘光标（卡片路径；不重画，只改 class） */
  cursor: string | null;
  /** 拖拽掠过的板块 key（高亮用） */
  dragKey: string | null;
  dragCount: number;
  /** 会插到第几个（插入位指示线画在这儿；-1 = 还没算出来） */
  dragIndex: number;
  /** 从哪个板块拖出来的（同板块 = 排序，不报「N → M」） */
  dragFrom: string | null;
  /**
   * 正在拖的那**一组**卡（半透明占位）。
   * c 期起是数组：拖选中的一张 = 整组一起搬，那几张都要半透明
   *（只标一张的话，看起来像"另外几张掉队了"）。
   */
  dragPaths: string[];
  /** 正在就地改名的板块 id */
  renaming: string | null;
  /** 正在就地改名的笔记路径 */
  renamingNote: string | null;
  /**
   * 面板里**正开着哪几篇**（源卡片要打「编辑中」标记 —— a.5-3）。
   * d 期起是**一组**（多篇分页）：从"哪一篇"改成"哪几篇"，判据也跟着从 `===` 改成 `includes`。
   * ⚠️ 真源在面板那边（`panelPaths()`）：切模块时模块会被重建，而面板不会 ——
   * 所以 `mount()` 里要**回读一次**，不能只靠这个字段自己攒。
   */
  editingPaths: string[];
  /** 「改设置不关窗」时顶上的那一行回执（§4.1） */
  receipt: string | null;
  /**
   * **多选**（P4.5 c 期 §3.5）—— 与 `expanded` / `cursor` 同级的**临时态，不进配置**：
   * 进配置会让每次点选都落一次盘、还会触发整块重绘（选择一动就重画整个看板）。
   * 选中的是**路径**（不是 DOM 节点）：重绘之后照样能贴回 class。
   */
  selected: string[];
  /** `Shift+单击` 范围选的锚点；语义与「全部笔记」那一屏完全一致 */
  anchor: string | null;
  /**
   * **触屏选择模式**（段⑤ 收的欠账，§4.2「单篇设置」那一行）：
   * 触屏没有右键 —— 单篇菜单只能从「长按 400ms → 选择模式 → 点那张卡的 ⋯」进。
   * 与网格档的 `selectMode`（`modules/notes/index.ts`）**同一套语义**：
   *   · 开着时点一下卡片 = 加选/减选（不是开窗）；
   *   · 每张卡左上角冒出 ⋯；点空白 / `Esc` 退出。
   * ⚠️ 与 `selected` 是**两件事**：选择模式是"姿态"，选择集是"内容"（与网格那条注释同源）。
   */
  selectMode: boolean;
}

/** 视图记忆的键（看板这一份）——`ModuleId` 那一套是给滚动快照用的，这个是给"模块自己的东西" */
const BOARD_MEMO = 'board';

/**
 * **看板要跨"切走再回来"记住的两样**（e 期 §4.4 的"光标 / 展开态"）。
 *
 * 它们本来在模块自己的 store 里（**临时态，不进配置**），而模块一换就重建 ——
 * 所以拿 `view-memory.ts` 那张会话内的表当落点。
 *
 * ⚠️ **选中集不在里面**（口径见 `看板优化方案.md` §6.15）：跨模块留着选择更像"忘了清"，
 * 而批量操作会作用在看不见的地方。
 * ⚠️ **板块 / 子板块的收起态也不在**：那个本来就落在配置里（`view.collapsed` / `openSubs`），
 * 自己就会回来 —— 再记一份就是两处各说各话。
 */
interface BoardMemo {
  cursor: string | null;
  expanded: string[];
}

export const renderBoard: ModuleRender = (host, ctx) => {
  const m = new BoardModule(ctx);
  m.mount(host);
  return () => m.dispose();
};

class BoardModule {
  private ctx: WorkbenchContext;
  private cfg: BoardConfigStore;
  private store: Store<BoardState>;
  private ops: NotesOps;
  /** `MarkdownRenderer.render` 的第 5 参（**必须**是 Component，否则核心报内存泄漏） */
  private component = new Component();
  private d = new Disposer();
  private regions: Region<BoardState>[] = [];
  /** 正文缓存：路径 → 正文（索引修订变了就整体重读） */
  private texts = new Map<string, string>();
  private textsRev = -1;
  private bodyHost!: HTMLElement;
  private toolbarHost!: HTMLElement;
  /** 模块宿主（`.kbw-board`）—— 形态那个类名挂在它上面，见 `applyFlow()` */
  private host!: HTMLElement;
  private escPop: (() => void) | null = null;
  private renameEsc: (() => void) | null = null;
  private stopDrag: (() => void) | null = null;
  /**
   * 正在框选时的取消句柄（c 期独立审查 🟡6）。
   * 与 `stopDrag` **同一待遇**：Esc 那层要真的停掉它（不是只清界面状态），
   * 卸载时也要收 —— 不然挂在 `document.body` 上的 `.kbw-marquee` 和那几个 document 级监听
   * 会留到下一次 `pointerup`（坑/界面与样式.md 那条"挂在 body 上的浮层会变孤儿 DOM"正对着这个）。
   */
  private stopMarquee: (() => void) | null = null;
  private paintToken = 0;
  private lastRev = -1;
  /** 这一屏的滚动位置恢复过了吗（视图记忆，e 期 §4.4）—— 见 `paintBoard` 末尾 */
  private scrollRestored = false;
  /** **mount 时认领下来的**滚动快照（看板是异步画，外壳那句同步兜底不该碰它） */
  private snap: ScrollSnap | null = null;
  /**
   * 这一趟重绘要不要保住滚动位置（订阅里按 `keepScrollKey` 算好，`paintBoard` 消费）。
   *
   * ⚠️ **捕获与写回都在 `paintBoard` 里、同一个同步块内**（e2 独立审查 🔴1 / 🟡2）：
   * 早先是在 store 订阅里捕获、在"画完那一刻"写回 —— 中间隔着"清宿主 + 重建"，
   * 而看板的绘制是**异步**的，于是有一整类竞态：
   *  · 在订阅里捕会读到"重绘中途"的空壳（卡暂时不在、值全 0），空快照盖掉好快照；
   *  · 改名那一下中间有一趟**画不出那张卡**（索引还没登记新路径）→ 写回写不到它，
   *    而下一趟捕获读到的已经是被清过的 0 —— 位置**永久丢失**。
   * 改成"捕 → 清 → 重建 → 写"同一条同步路径之后，这两个洞都不存在了
   *（异步只发生在它们**之前**的 `ensureTexts`）。
   */
  private keepScrollNext = true;
  /** 上一趟"没写进去"的滚动位置（键还没长出来）——下一趟接着试，见 `paintBoard` 末尾 */
  private carriedSnap: ScrollSnap | null = null;
  /** 带了几趟了（上限 8：改名那一下索引会 churn 好几轮） */
  private carryAge = 0;
  /**
   * **捕获之后、写回之前**发生的改名（旧路径 → 新路径）。
   *
   * 🔴 时机是**写回那一刻**才用，不是改名那一刻就用（e2 独立审查 🟡2 的实测）：
   * 改名的真实现顺序是"改名事件 → 索引修订 → 重绘（捕获 → 重建带新路径 → 写回）"，
   * 而捕获读到的键还是**旧路径**（DOM 还没重画）—— 所以"把快照的键换过去"这件事
   * 只能在写回前做，提前做等于白做（那时快照还没生成）。
   */
  private renamedSinceSnap = new Map<string, string>();
  private saveSoon: Debounced<[]>;
  /** 待落盘的折叠/顺序（攒一下再写，免得拖一次写一次盘） */
  private pendingCollapsed: string[] | null = null;
  private pendingOpenSubs: string[] | null = null;
  private pendingOrder: Record<string, string[]> | null = null;
  /** 待落盘的「每条笔记的属性/正文比例」（与 pendingOrder 一起攒，同一套防抖） */
  private pendingRatio: Record<string, number> | null = null;
  /** 待落盘的「每条笔记自己的小窗设置」（改名迁键用；与上面两个同一套防抖） */
  private pendingPanel: Record<string, PanelPref> | null = null;
  /** 上一次看到的配置（序列化后）—— 判"这次变的是不是只有收起态"，见 `cfg.onChange` 那段 */
  private lastCfgJson = '';
  /** 上一次画的拖动反馈签名（`key|index`）—— 见 `paintDrag`：没变就别重建 */
  private lastDragPaint = '';
  /** 消费过的「跳到看板」意图序号（e2 期 §4.1，与 notes 那边同一套判新旧的办法） */
  private lastIntentSeq = 0;
  /**
   * 意图要求"让她看得见"的那个东西 —— **画完之后**才滚（那时 DOM 才有），
   * 而且展开收起本身也要重绘一次，所以不能当场滚。
   */
  private pendingReveal: { path?: string; sectionId?: string } | null = null;
  /** mount 时认下的意图（那时配置还没读完）——由 `cfg.onChange` 那一下落地 */
  private bootIntent: BoardIntent | null = null;

  constructor(ctx: WorkbenchContext) {
    this.ctx = ctx;
    this.cfg = new BoardConfigStore(ctx);
    this.ops = new NotesOps(ctx, () => this.repaint());
    /**
     * **视图记忆的初值直接进 store**（e 期 §4.4）：光标与"展开了正文的卡片"是**临时态**
     *（不进配置），模块一重建就没了 —— 而它们该在"切走再回来"时还在。
     * 放进初值最省事：绘制路径本来就读 store，不必再写一遍"回来时把 class 贴上去"。
     * ⚠️ 陈旧路径不在这儿剔（那时还没有卡片可对照）—— `pruneSelection()` 每轮画完会剔。
     */
    const memo = loadMemo<BoardMemo>(BOARD_MEMO);
    this.store = new Store<BoardState>({
      rev: -1,
      cfgRev: 0,
      paintRev: 0,
      loaded: false,
      expanded: memo?.expanded ? [...memo.expanded] : [],
      cursor: memo?.cursor ?? null,
      dragKey: null,
      dragCount: 0,
      dragIndex: -1,
      dragFrom: null,
      dragPaths: [],
      renaming: null,
      renamingNote: null,
      editingPaths: [],
      receipt: null,
      selected: [],
      anchor: null,
      selectMode: false,
    });
    this.saveSoon = debounce(() => void this.flushPending(), 400);
  }

  // ── 生命周期 ─────────────────────────────────────────────────
  mount(host: HTMLElement): void {
    host.classList.add('kbw-board');
    this.host = host;
    // 16.13（P7.2d）：进过看板 = 新手清单第 3 项（挂载 = 真的进来了；幂等，记过就跳过）
    recordOnboarding(this.ctx, 'view');
    /**
     * **认领滚动快照**（视图记忆，e 期）。看板是**两段式异步画**的，写回必须挂在
     * **画实那一刻**（`paintBoard` 末尾的 `!cold` 分支）；不先认领的话，外壳那句
     * "同步模块兜底"会在 `render()` 返回时就写一次 —— 那时卡片还没画出来，值会被钳成 0。
     */
    this.snap = claimScroll('board');
    this.component.load();
    const shell = div({ cls: 'kbw-board-shell' });
    this.toolbarHost = div({ cls: 'kbw-board-toolbar' });
    /**
     * `data-scroll` = **视图记忆**认这个容器的锚（e 期 §4.4）。看板真正在滚的是这一层
     * （不是外壳那个 `.kbw-modhost`：列形态下每个板块列还各有各的滚动）。
     * 规矩同 `is-collapsed`：**谁渲染谁负责贴**，别在别处再列一份容器清单。
     */
    this.bodyHost = div({ cls: 'kbw-board-body', attr: { [SCROLL_ATTR]: 'board' } });
    shell.appendChild(this.toolbarHost);
    shell.appendChild(this.bodyHost);
    host.appendChild(shell);

    this.regions = [
      new Region<BoardState>(this.toolbarHost, () => this.paintToolbar(), {
        /**
         * `selected.length` 进 key：有选择时工具条整条换成批量栏，「已选 N 篇」那个数字每变一次都得重画。
         *
         * ⚠️ 长度相同、**内容不同**的那些变化（`Ctrl+点 B` → `Shift+点 C` → `Shift+点 D`，
         * 选段仍是 2 张）这里**不会重画** —— 那是**故意的**：批量栏那四个按钮走的是
         * `selected: () => this.selectedEntries()`（**点击那一刻现取**，见 `paintBatchBar`），
         * 所以"看到的就是操作对象"由 getter 保证，不需要拿整个选择集去拼 key
         *（`Ctrl+A` 全选上千张时，那种拼法每次 store 变化都要拼几十 KB 字符串）。
         * 这条修法是 c 期独立审查 🔴1 给的两条路子里更省的那条。
         */
        key: (s) =>
          `${s.cfgRev}|${s.receipt ?? ''}|${s.renaming ?? ''}|${this.cfg.get().sections.length}|${this.cfg.get().view.cardWidth}|${s.selected.length}`,
      }),
      /**
       * ⚠️ 板块区是**异步画**的（要先把正文读出来）→ Region 的 render 只负责发起。
       * `paintToken` 挡住并发：两次 paint 交错时，慢的那次不许再往宿主里塞 DOM。
       */
      new Region<BoardState>(this.bodyHost, () => void this.paintBoard(), {
        // ⚠️ 与"滚动保持"的判据**同源**（`keepScrollKey`）—— 别在这里另写一份
        key: (s) => regionKey(s),
        /**
         * 🔴 **`reuse: true` = 别在这里清宿主**（看着像滥用，其实是被捕获时机逼出来的）：
         * `Region.paint()` 是"先清宿主、再调渲染函数"，而看板的绘制是**异步两段式**的
         *（先读正文再画）—— 清早了，`paintBoard` 里就再也读不到"上一次画完的那份 DOM"，
         * 滚动捕获只能读到一个**空壳**（全 0），那份空快照还会盖掉好快照（实测日志里
         * 就是"列 60 → 捕获成 0 → 写回 0"）。所以清宿主改由 `paintBoard` 在最靠近重建的
         * 那一刻自己做，捕获就贴在它前面。
         */
        reuse: true,
      }),
    ];

    /**
     * **回读一次「编辑中」**（d 期）：面板是跨模块存活的，切走再切回来时
     * 模块是全新的、面板还是老的那一个 —— 不回读的话标记会整批消失，
     * 而面板里明明还开着那几篇（真机上一眼就看得出不对）。
     */
    this.store.set({ editingPaths: panelPaths() });
    /**
     * ⚠️ **同一件事的另一半（d2 修）**：只回读"编辑中"不够 —— 面板订阅的是
     * **上一个模块那个 `BoardConfigStore`**（它随旧模块一起收了），
     * 不把依赖重新交给它，换停靠边/钉住/切档这些**写配置**的入口对它全是失聪的
     * （判据：`真链路 · 切走模块再回来，面板仍然跟着配置走`）。
     */
    rebindCardPanel(this.panelDeps());
    /**
     * **预览窗格（e 期 §3.2）**：与面板同类 —— 建模块时让它跟上配置。
     * ⚠️ 它内部判 `cfg.isLoaded()`（配置是异步读的，照默认值重排会把刚停好的窗格卸掉；
     * d2 在面板上踩过这条，见 `rebindCardPanel`）。
     */
    syncPeek(this.peekDeps());
    // 视图记忆里记着光标 → 窗格一建出来就该显示那一篇，而不是等用户按一下方向键
    followPeek(this.cursorEntry());
    /**
     * **窗格空出来了 → 重新算一遍"该谁占着"**（e 期）。
     *
     * 🔴 听者挂在**模块**上，不挂在 Peek 那一个对象上 —— 这一点是要紧的：
     * 面板抢窗格时我们收掉的是**整个 Peek**（`closePeek`），对象没了、挂在它身上的
     * 监听也一起没了。可正是"面板走了之后预览该回来"这件事需要有人听着
     *（少了它，症状是"边上空着一条、界面上什么都没有，而菜单里那一项还勾着"，
     * 用户得把开关点两下才回得来）。模块活着，这条就一直在。
     */
    this.d.add(onWindowFreed(() => syncPeek(this.peekDeps())));

    this.d.add(this.ctx.index.onChange(() => this.syncFromIndex()));
    /**
     * **消费「跳到看板」意图**（e2 期 §4.1 快速切换）—— 与「全部笔记」那边同一套做法：
     * 意图带序号，消费一次就记下来（同样内容的意图再来一次也要生效）。
     */
    this.d.add(
      this.ctx.store.subscribe((s) => {
        if (s.boardIntent && s.boardIntentSeq !== this.lastIntentSeq) {
          this.lastIntentSeq = s.boardIntentSeq;
          this.applyIntent(s.boardIntent);
        }
      }),
    );
    /**
     * 🔴 **还要认"建模块之前就已经躺在 state 里的意图"**（与「全部笔记」那边同一句，e2 期自查抓的）：
     * `Store.subscribe` **不会**拿当前状态先叫你一次 —— 从首页 / 全部笔记跳板块时，
     * `goBoard()` 先把意图写进 state、再切模块，而我们是**切过去之后才新建**的模块，
     * 那条订阅永远等不到那次 set → 症状是"跳了，但没展开、也没滚过去"（静默失效）。
     *
     * ⚠️⚠️ **但那一刻配置多半还没读完**（`BoardConfigStore.load()` 是异步的，而它读完**不 emit**）——
     * 照默认配置去 `applyIntent` 会得出"那个板块不在了"，然后再也没人重试
     *（离线用例当场抓到：跳板块那一步收到的是"那个板块不在了"的通知）。
     * 所以这里**只把意图记下来**，等 `cfg.onChange` 把它落地（那一下 `loaded` 才为真）。
     */
    {
      const st = this.ctx.store.get();
      if (st.boardIntent && st.boardIntentSeq !== this.lastIntentSeq) {
        this.lastIntentSeq = st.boardIntentSeq;
        this.bootIntent = st.boardIntent;
      }
    }
    /**
     * 配置变了。
     * ⚠️ **只有收起态变了就不重绘**（P4.5 §1.2）：收起态自己也是写进配置的，
     * 而配置写完会通知订阅者（P4 修的「不通知」那条）——
     * 于是 400ms 防抖落盘那一下会把刚做完的就地更新连同整块重绘一起冲掉，
     * 每张卡片的正文再渲染一遍，等于白优化（用例量到了：收起后展开多出 10 次渲染）。
     */
    this.d.add(
      this.cfg.onChange(() => {
        const json = JSON.stringify(this.cfg.get());
        const prev = this.lastCfgJson;
        const first = prev === '';
        const onlyCollapse = !first && onlyCollapseChanged(prev, json);
        this.lastCfgJson = json;
        if (onlyCollapse) {
          this.applyCollapseInPlace();
          return;
        }
        this.store.set({ loaded: true, cfgRev: this.store.get().cfgRev + 1 });
        /**
         * 🔴 **仲裁：窗格该归谁**（e 期，独立审查逼出来的）。
         *
         * 两个占用者各自的"我该占着"都写在**同一份配置**里（`view.dock` / `view.peekEnabled`），
         * 所以"两边都说要"时该谁赢，只能看**用户刚动的是哪一个**：
         *  · 刚动的是 `dock`（菜单里点了「停靠到左边」）→ **面板赢**：把预览收掉，
         *    这一次**不要**再把预览摆回来（它的 `peekEnabled` 还开着，若不跳过 `syncPeek`，
         *    它会在面板申请之前先把窗格抢走 —— 注册顺序上模块的订阅排在面板前面）。
         *    预览不会丢：面板让出来那一刻 `onWindowFreed` 会把它请回来。
         *  · 刚动的是 `peekEnabled` / `peek`（菜单里开了预览）→ **预览赢**：照常 `syncPeek`，
         *    它会经 `onNeedWindow` 把停靠的面板收掉。
         *  · 两个都动了 / 都没动（比如只是改了卡片宽度）→ 走预览那条（与以前一致）。
         */
        const dockMoved = viewKeyMoved(prev, json, 'dock');
        const peekMoved = viewKeyMoved(prev, json, 'peekEnabled') || viewKeyMoved(prev, json, 'peek');
        if (!first && dockMoved && !peekMoved && panelClaimsWindow()) {
          /**
           * ⚠️ 还要问一句"**面板真的会来占吗**"（`panelClaimsWindow()` = 它开着 + 配置说要停靠）：
           * 面板**没开着**的时候改 `dock` 只是改了个偏好，谁也占不了窗格 ——
           * 那种时候把预览收掉纯属误伤（离线实测：写完配置预览就没了，而面板根本不在场）。
           */
          closePeek({ reason: 'panel-wants-window' });
          return;
        }
        /**
         * 预览窗格也跟着配置走（开 / 关 / 换边 / 改大小都写在这里）。
         * ⚠️ 放在 `onlyCollapse` 那条早退**之后**：那一条只吞"收起态"变更，
         * 而 `peekEnabled` / `peek` 不在其中 —— 走到这里就说明确实该跟了。
         */
        syncPeek(this.peekDeps());
      }),
    );
    this.d.add(this.cfg.watchExternal());
    this.d.add(
      this.store.subscribe((s, prev) => {
        /**
         * **索引变动引起的重绘要先把这一屏的滚动位置记下来**（a.6 真机实测的 bug）。
         *
         * 症状（用户报的"勾一下笔记就跳"）：在看板上点某个勾选框、或同步 / 自动补全
         * 往库里写一笔 → 索引修订变 → 整块重绘 → **卡面正文与各板块列的滚动位置全部归零**，
         * 用户被从"读到的那一行"甩回顶上（真机量到：列 80 → 0、卡面正文 200 → 0）。
         *
         * ⚠️ 两条边界：
         *  ① **真正的捕获在 `paintBoard` 里**（清宿主之前那一刻）—— 不是在这儿：
         *     在这儿捕会读到"重绘中途"的 DOM（卡片暂时不在、scrollTop 全 0），
         *     那份全 0 的快照会盖掉好快照（e2 独立审查后的实测日志）。这里只**记下要不要保**。
         *  ② **判据与 Region 的 key 同源**（`keepScrollKey`）：**默认保**，
         *     只有"视图参数真的变了"那几个字段才不保。
         *
         * 🔴 为什么不能写成"哪几种变化要保"的白名单（e2 期独立审查 🔴1）：
         * 第一版是"`rev` 变了且 `cfgRev` 没变"，而 Region 的 key 里还有 `renamingNote`
         * 与后来的 `paintRev` —— **两个集合不一致**，于是 `F2` 进就地改名再 `Esc`
         *（一个字节都没改）就把位置清了（实测：列 60→0、卡面正文 120→0）。
         * 凡是"要枚举"的判据迟早漏一个；跟着 key 走就再也不会漏。
         */
        this.keepScrollNext = keepScrollKey(s) === keepScrollKey(prev);
        for (const r of this.regions) r.paint(s);
        // 落点序号也在变（同板块里挪一格就要重画指示线）→ 它变了也得重画
        if (
          s.dragKey !== prev.dragKey ||
          s.dragIndex !== prev.dragIndex ||
          s.cursor !== prev.cursor ||
          s.editingPaths !== prev.editingPaths ||
          // 多选：点一下就换一批 class —— 必须走"就地改 class"这条路，不许整块重绘
          s.selected !== prev.selected ||
          /**
           * 🔴 **触屏选择模式单独变了也要贴**（P6⑤ 独立审查 A2）：`is-selectmode`（卡面那颗 ⋯）
           * 是 `paintStates` 事后贴的，而"长按后移动 >10px 改判拖动"那条路**只发一次
           * `set({ selectMode: false })`**、不带别的字段 → 不在上面那组条件里 → class 撤不掉，
           * 视觉上还停在选择模式（点卡片却是开窗）。一行的事，但症状是"界面在说谎"。
           */
          s.selectMode !== prev.selectMode
        ) {
          this.paintStates(s);
        }
        /**
         * **光标变了 → 预览窗格跟着换**（e 期 §3.2 的口径："只跟键盘光标"）。
         * 挂在光标这一条上（不挂"任何 store 变动"）：鼠标拖动、选择、回执那些
         * 都不该让预览重读一次文件。
         */
        if (s.cursor !== prev.cursor) followPeek(this.cursorEntry());
        // 视图记忆：光标与"展开了正文"是临时态，趁还有值写进会话表（§4.4）
        if (s.cursor !== prev.cursor || s.expanded !== prev.expanded) {
          saveMemo(BOARD_MEMO, { cursor: s.cursor, expanded: [...s.expanded] } satisfies BoardMemo);
        }
        this.syncEscapeLayer();
      }),
    );
    this.d.add(
      this.ctx.keys.register(
        'board',
        host,
        (action) => this.onKey(action),
        (evt) => this.onRawKey(evt),
      ),
    );
    /**
     * **`Ctrl/Cmd + 滚轮` 缩放卡片**（用户 2026-09-25 要的）。
     * 三条：
     *  ① 只在按住修饰键时接管，其余滚轮留给看板/卡片正文自己滚；
     *  ② `preventDefault`（否则平台会把整个界面缩放一起做掉）；
     *  ③ 拖动途中**每滚一格都落盘**是不行的（一次滚动几十个事件 = 几十次写 JSON）→
     *     界面立刻改（CSS 变量），落盘走 300ms 防抖。
     */
    const zoomRef = (evt: Event): void => this.onZoom(evt as WheelEvent);
    this.bodyHost.addEventListener('wheel', zoomRef, { passive: false });
    this.d.add(() => this.bodyHost.removeEventListener('wheel', zoomRef));
    // 空白处右键 → 全局菜单（§8.1）
    this.d.add(
      on(this.bodyHost, 'contextmenu', (evt) => {
        const t = evt.target as HTMLElement | null;
        if (t?.closest?.('[data-card], .kbw-sect-head, input')) return; // 卡片/板块头有自己的菜单
        evt.preventDefault();
        showBoardMenu(this.menuCtx(), evt as MouseEvent);
      }),
    );
    /**
     * **空白处拖拽 = 框选**（c 期 §3.5）。
     *
     * 两条"不接"：
     *  · **触屏**不接 —— 那里"在空白处拖"是滚看板的手势，抢过来会让看板没法滚
     *    （触屏的多选留给"长按 → 选择模式"那一套，与 §3.5 网格档同一条思路）；
     *  · 卡片 / 板块头 / 各种控件上按下也不算 —— 它们各有各的活（拖卡片、折叠、按钮）。
     * 剩下能落到这里的，就是货真价实的空白（卡片之间的缝、板块下方的留白）。
     */
    this.d.add(
      on(this.bodyHost, 'pointerdown', (evt) => {
        const e = evt as PointerEvent;
        if (e.button !== 0) return;
        if (isTouchPointer(e)) return;
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('[data-card], .kbw-sect-head, button, input, a, textarea, select')) return;
        this.startMarquee(e);
      }),
    );
    /**
     * **触屏：点空白退出选择模式**（与网格档 `grid.ts` 那条同一个手感：iOS 相册的"点外面取消"）。
     * 用 `click` 而不是 `pointerdown` —— 滚看板时不该顺手把模式退掉。
     * ⚠️ 排除名单与"框选的空白"**同一份口径**（卡片 / 板块头 / 各种控件都不算空白），
     * 但这里**要连触屏也接**：它在触屏上才是出口（框选那条不接触屏，两件事）。
     */
    this.d.add(
      on(this.bodyHost, 'click', (evt) => {
        if (!this.store.get().selectMode) return;
        const t = evt.target as HTMLElement | null;
        if (t?.closest?.('[data-card], .kbw-sect-head, button, input, a, textarea, select')) return;
        this.setSelectMode(false);
        this.store.set({ selected: [], anchor: null });
      }),
    );
    /**
     * **顺序表的迁移挂在 vault 的 rename 上**（§4.4 最后一行）。
     * 为什么挂事件而不是挂"改名那个按钮"：改名有四个入口（卡片小窗 / 笔记菜单 /
     * 全部笔记的表格 / 跨板块拖动），挂按钮就一定会漏掉一个 —— 而顺序表存的是**路径**，
     * 漏一次的后果是那篇笔记从手动顺序里失联、掉到末尾（还查不出原因）。
     * `renameFile` 就地改 `file.path`，所以新路径从事件参数里拿（`oldPath` 是回调给的）。
     */
    const renameRef = this.ctx.app.vault.on('rename', (f, oldPath) => {
      if (!f?.path || !oldPath) return;
      this.migrateOrder(oldPath, f.path);
      /**
       * ⚠️ **滚动快照里带路径的键也要跟着迁**（e2 期独立审查 🟡2）：卡面正文的键是
       * `card:<板块 key>:<路径>`，改名之后写回时**认不出那个键** → 位置照样丢
       *（实测：列保住了、卡面正文 0）。这里两处都要迁：手上这一趟的 `liveSnap`，
       * 与"切走再回来"那张会话表（`pendingScroll`）。
       */
      this.renamedSinceSnap.set(oldPath, f.path);
      /**
       * 🔴 **顺手把"那张卡此刻的滚动位置"直接钉下来**（e2 独立审查 🟡2 的实测）：
       * 改名之后索引会先删旧、后加新，中间有一趟**画不出那张卡**；等它回来时正文是 0，
       * 而"用户原来滚到 120"这件事**已经没人记得了**（那一趟捕不到它）。
       * 改名事件这一刻 DOM 还是旧的、位置还在 —— 就地读下来、按**新路径**存进手上的那份，
       * 之后不管中间 churn 几趟，它都会在"卡回来"的那一趟被写回去。
       * ⚠️ 这段必须在**本函数里**（改名事件的第一时间），晚一步 DOM 就被重画了。
       */
      for (const body of Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-card-body'))) {
        const key = body.getAttribute(SCROLL_ATTR) ?? '';
        if (!key.endsWith(`:${oldPath}`)) continue;
        if (body.scrollTop === 0 && body.scrollLeft === 0) continue;
        const nextKey = `${key.slice(0, -oldPath.length)}${f.path}`;
        this.carriedSnap = { ...(this.carriedSnap ?? {}), [nextKey]: { top: body.scrollTop, left: body.scrollLeft } };
      }
      /** "切走再回来"那张会话表是**当时**就该迁的（它的键不用等写回） */
      remapScrollPath(oldPath, f.path);
    });
    this.d.add(() => this.ctx.app.vault.offref(renameRef));
    this.applyFlow();
    void this.reloadCfg();
  }

  /**
   * 把**形态**贴到宿主上（`is-cols` ↔ 流式）。
   *
   * 两处要调：`mount`（首帧）与 `paintBoard`（配置变了之后）—— 它是**类名**，
   * 而重绘只重建 body 里的 DOM，不会自己去更新宿主上的类。
   *
   * 谁改形态都走同一条路：看板菜单 / 设置面板「看板默认值」→ `view.flow` 变 →
   * `cfgRev++` → 整块重绘（`onlyCollapseChanged` 只吞"收起态"那一种变更，形态不在其中）
   * → 这里跟着更新类名 ✓。**别在别处再判一次**（两处判会漂）。
   *
   * ⚠️ **窄档不在这里判**：窄档由 CSS 强制回流式（`.kbw-root[data-w="narrow"]` 下不套列形态）——
   * 窄与否是**容器宽度**（工作台会被别的标签页挤窄），不该由配置或渲染时的一次读值决定。
   */
  private applyFlow(): void {
    if (!this.host) return;
    this.host.classList.toggle('is-cols', this.cfg.get().view.flow !== 'flow');
  }

  /**
   * 文件改名/搬移之后，把顺序表里的旧路径换成新路径（**只换取值不动键**）。
   * 拖过一次的笔记才在表里；不在表里就什么都不用做。
   */
  private migrateOrder(oldPath: string, newPath: string): void {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const cfg = this.cfg.get();
    const next: Record<string, string[]> = {};
    let touched = false;
    for (const [key, list] of Object.entries(cfg.view.manualOrder)) {
      if (!list.includes(oldPath)) {
        next[key] = list;
        continue;
      }
      next[key] = list.map((p) => (p === oldPath ? newPath : p));
      touched = true;
    }
    /**
     * 顺带迁**每条笔记的属性/正文比例**（`propsRatioByPath`）—— 同一套理由：
     * 表里存的是**路径**，改名/搬移不迁的话，那条笔记的设置就"失联"了
     * （症状是它突然变回全局默认的高度）。挂 `vault.on('rename')` 而不是挂改名按钮，
     * 是因为改名有四个入口（小窗 / 笔记菜单 / 表格 / 跨板块拖动）。
     */
    const ratioMap = cfg.view.propsRatioByPath ?? {};
    const nextRatio = { ...ratioMap };
    let ratioTouched = false;
    if (ratioMap[oldPath] != null) {
      nextRatio[newPath] = ratioMap[oldPath];
      delete nextRatio[oldPath];
      ratioTouched = true;
    }
    /**
     * 再迁**这一篇自己的小窗设置**（`panelByPath`，f 期第 3 条）——
     * 与上面同一套理由，而且这一份更脆：它管的是"这一篇的小窗长什么样"，
     * 不迁的话用户会看到"我给它单独设过字号/比例，改个名就回默认了"
     *（`core/config-files.ts` 那条注释里写了"合成一份 map 就是为了只有一个迁移点"）。
     */
    const panelMap = cfg.view.panelByPath ?? {};
    const nextPanel = { ...panelMap };
    let panelTouched = false;
    if (panelMap[oldPath] != null) {
      nextPanel[newPath] = panelMap[oldPath];
      delete nextPanel[oldPath];
      panelTouched = true;
    }
    if (!touched && !ratioTouched && !panelTouched) return;
    cfg.view.manualOrder = next;
    if (ratioTouched) cfg.view.propsRatioByPath = nextRatio;
    if (panelTouched) cfg.view.panelByPath = nextPanel;
    this.pendingOrder = next;
    this.pendingRatio = ratioTouched ? nextRatio : null;
    this.pendingPanel = panelTouched ? nextPanel : null;
    this.saveSoon();
  }

  dispose(): void {
    /**
     * ⚠️ **模块卸载要先收掉自己开的那两个浮层**（独立审查 R9）：面板里挂着 markdown 叶，
     * 没人 detach 就成了工作区里查得到的悬挂叶。
     *
     * d 期起分两种：**钉住的留着**（用户拍板：面板跟着工作台、不跟着模块 ——
     * 切去看一眼笔记再回来，编辑到一半的几篇不该没），没钉住的收掉。
     * 真正"无条件收"发生在工作台视图关闭与插件卸载那两处。
     *
     * ⚠️ `purgeOverlays()`（插件加载/卸载时调）原先只 `el.remove()`、不触发 `onClose`，
     * 于是上面这条"谁来 detach"在重载路径上**根本没人执行** ——
     * 已改成**先关再拆**（见 `ui/panel.ts` 的 `liveFloaters`）。
     */
    keepPinnedPanel();
    /**
     * **预览窗格随模块走**（与面板**不一样**：面板钉住时跨模块留着，Peek 不留）。
     * 理由：面板里挂着真编辑器（编辑现场值得留着），Peek 只是一份只读渲染，重建代价为零；
     * 而且它占着工作台的窗格 —— 切到别的模块还占着，那一块就是一块空白。
     * 配置不删（`peekEnabled` 仍是 true）→ 下次进看板自动回来（见 `mount` 里的 `syncPeek`）。
     */
    closePeek({ reason: 'module-dispose' });
    closeSectionPanel();
    this.stopDrag?.();
    this.stopDrag = null;
    this.stopMarquee?.();
    this.stopMarquee = null;
    this.escPop?.();
    this.escPop = null;
    this.renameEsc?.();
    this.renameEsc = null;
    this.saveSoon.flush(); // 不带参 = 执行挂起的那一次
    this.d.dispose();
    for (const r of this.regions) r.dispose();
    this.regions = [];
    this.component.unload();
  }

  // ── 配置 ─────────────────────────────────────────────────────
  private async reloadCfg(): Promise<void> {
    await this.cfg.load(true); // 看板是 P4：第一次打开时由它落盘
    this.lastCfgJson = JSON.stringify(this.cfg.get());
    this.store.set({ loaded: true, cfgRev: this.store.get().cfgRev + 1 });
    /**
     * ⚠️ **读出来了才把面板拉回来对一遍**（d2）：`load()` 自己**不 emit**，
     * 所以"配置就绪"这件事只有这里知道。切模块回来时面板还停着，
     * 而它手里那份 deps 刚被换成这个新 store —— 不在这时补做一遍，
     * 面板就会一直用**默认值**（`dock: null`）去重排，窗格当场消失。
     */
    rebindCardPanel(this.panelDeps());
    // 配置读出来了 → 预览窗格这下才能按真值重排（`load()` 读完不 emit，见 syncPeek 那段）
    syncPeek(this.peekDeps());
    /**
     * ⚠️ 还要**补一次**跟随：`mount()` 里那次 `followPeek` 跑在窗格造出来**之前**
     *（配置是异步读的，`ensurePeek` 到 `reloadCfg` 才落地）—— 不补的话，
     * 视图记忆记着的光标要等用户按一下方向键才显示。
     */
    followPeek(this.cursorEntry());
    /**
     * 🔴 **mount 时认下的那个意图，到这儿才落地**。
     *
     * 为什么必须挂在这儿（而不是 `cfg.onChange`）：`BoardConfigStore.load()` **读完不 emit**
     *（d2 那笔账：能知道"配置就绪"的只有 `reloadCfg` 这一处）。挂 onChange 的话，
     * 从首页/全部笔记跳板块时意图会**一直躺着不动**，直到用户恰好动了别的东西才生效。
     *
     * 顺序放在最后：上面那几句都可能触发重绘，而 `applyIntent` 会再推一次配置/光标。
     */
    if (this.bootIntent) {
      const pending = this.bootIntent;
      this.bootIntent = null;
      this.applyIntent(pending);
    }
  }

  private async flushPending(): Promise<void> {
    const patch: {
      collapsed?: string[];
      openSubs?: string[];
      manualOrder?: Record<string, string[]>;
      propsRatioByPath?: Record<string, number>;
      panelByPath?: Record<string, PanelPref>;
    } = {};
    if (this.pendingCollapsed) {
      patch.collapsed = this.pendingCollapsed;
      this.pendingCollapsed = null;
    }
    if (this.pendingOpenSubs) {
      patch.openSubs = this.pendingOpenSubs;
      this.pendingOpenSubs = null;
    }
    if (this.pendingOrder) {
      patch.manualOrder = this.pendingOrder;
      this.pendingOrder = null;
    }
    if (this.pendingRatio) {
      patch.propsRatioByPath = this.pendingRatio;
      this.pendingRatio = null;
    }
    if (this.pendingPanel) {
      patch.panelByPath = this.pendingPanel;
      this.pendingPanel = null;
    }
    if (Object.keys(patch).length === 0) return;
    await this.cfg.patchView(patch);
  }

  /** 收起/展开一组。⚠️ 顶级与子板块落在**不同的表**里（默认态相反，见 `config.isCollapsed`） */
  private toggleCollapsed(key: string, sub = false): void {
    const v = this.cfg.get().view;
    if (sub) {
      this.setOpenSubs(
        v.openSubs.includes(key) ? v.openSubs.filter((k) => k !== key) : [...v.openSubs, key],
      );
    } else {
      this.setCollapsed(v.collapsed.includes(key) ? v.collapsed.filter((k) => k !== key) : [...v.collapsed, key]);
    }
    this.applyCollapseInPlace();
  }

  /**
   * 收起态落配置。
   * ⚠️ **不推 `cfgRev`**（P4.5 改）：看板区 Region 的 key 里带着 `cfgRev`，
   * 一推就是整块重绘 —— 每张卡片的正文都要**重走一遍 `MarkdownRenderer.render`**（异步），
   * 于是"点一下全部收起"要几十次渲染（用户报的"有时候慢"就是这个）。
   * 收起态只是**显示状态**，配置改完由调用方接一句 `applyCollapseInPlace()` 就地贴到 DOM 上；
   * 落盘仍旧走 400ms 防抖（`saveSoon`），一个字没少。
   */
  private setCollapsed(next: string[]): void {
    this.cfg.get().view.collapsed = next;
    this.pendingCollapsed = next;
    this.saveSoon();
  }

  private setOpenSubs(next: string[]): void {
    this.cfg.get().view.openSubs = next;
    this.pendingOpenSubs = next;
    this.saveSoon();
  }

  // ── 数据 ─────────────────────────────────────────────────────
  private entries(): NoteEntry[] {
    return this.ctx.index.notes();
  }

  private tagsOf(e: NoteEntry): string[] {
    const v = e.props['tags'];
    const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
    const out = list.map((t) => String(t).replace(/^#/, ''));
    const cache = this.ctx.app.metadataCache.getFileCache(e.file);
    for (const t of cache?.tags ?? []) out.push(t.tag.replace(/^#/, ''));
    return out;
  }

  private groups(): BoardGroup[] {
    return planBoard(this.entries(), this.cfg.get(), {
      kbRoot: this.ctx.settings.kbRoot(),
      tagsOf: (e) => this.tagsOf(e),
    });
  }

  /** 卡面要显示哪几个属性（板块级覆盖看板级；都没选过 → 默认前 5 个） */
  private propsFor(sec: BoardSection | null): string[] {
    return effectiveProps(this.cfg.get(), sec) ?? defaultPropsFor(this.entries());
  }

  private syncFromIndex(): void {
    const rev = this.ctx.index.revision;
    if (rev === this.lastRev) return;
    this.lastRev = rev;
    this.store.set({ rev });
  }

  /** 把要画的卡片的正文读进缓存（按路径；索引修订变了就整体重读） */
  /** 正文还在读（界面据此写「读正文中…」，而不是「（还没有正文）」） */
  private textsLoading = false;

  private async ensureTexts(): Promise<void> {
    /**
     * ⚠️ **`textsRev` 只在读完之后才置位**（独立审查 🟡7）：早先是"进门就置位"，
     * 于是"读的过程中"那次重绘会看到 `stale === false` → 拿**半满的缓存**画图 →
     * 还没读到的那些卡片显示「（还没有正文）」。而冷启那条补画的 `.then` 又被 token 挡掉 → 不自愈。
     * 判据改成"读完了才算数"：读的过程中 `stale` 仍为 true（该走两段式的继续走）。
     * 并发调用共用同一个 promise，免得同一批文件被读两遍。
     */
    const rev = this.ctx.index.revision;
    if (rev !== this.textsRev) {
      this.texts.clear();
      // ⚠️ **进门就置位**：这条是快车道 —— 读的过程中别的重绘不该再触发一次全量读
      this.textsRev = rev;
    }
    const missing = this.entries().filter((e) => this.texts.get(e.path) == null);
    if (missing.length === 0) {
      this.textsLoading = false;
      return;
    }
    /**
     * ⚠️ **"读没读完"要单独标**（独立审查 🟡7）：`textsRev` 是"这份缓存属于哪一版"，
     * 而**在读**是另一件事 —— 界面靠 `textsLoading` 决定正文位置写「读正文中…」
     * 还是「（还没有正文）」，不然读到一半的重绘会把还没读到的卡片写成"没有正文"。
     *
     * ⚠️ 这里**不做"在飞 promise 复用"**：试过一版（并发调用共用同一个读的 promise），
     * 全套用例出现**挂点游走的 90s 超时**（每次卡在不同用例）—— 那种 `await 共享 promise`
     * 的写法只要有一条路径没把它结清就整体悬住。宁可偶发重复读（这是原有行为，套件一直是绿的）。
     */
    this.textsLoading = true;
    await Promise.all(
      missing.map(async (e) => {
        try {
          this.texts.set(e.path, await this.ctx.app.vault.cachedRead(e.file));
        } catch (err) {
          console.error('[经纬] 读正文失败', e.path, err);
          this.texts.set(e.path, '');
        }
      }),
    );
    if (rev === this.ctx.index.revision) this.textsLoading = false;
  }

  private textOf(e: NoteEntry): string {
    return this.texts.get(e.path) ?? '';
  }

  /**
   * 把选择集里**已经不在看板上**的路径剔掉（c 期独立审查 🔴2）。
   *
   * 什么时候会失效：**拖到别的板块**（搬完文件路径就变了）、笔记被删 / 改名、板块被删。
   * 不剔的后果很怪（审查给了最短复现）：选两张 → 按住其中一张拖到另一个板块 → 手一松，
   * **屏幕上没有任何卡片高亮**，顶上却挂着「已选 0 篇 / 2 篇被筛掉，仍在选中」+ 四个点了没反应的按钮，
   * 而且**工具条被顶掉**（板块管理 / 卡片显示都够不着）—— 用户只能靠 Esc 才出得来。
   *
   * ⚠️ **时机在"画完之后"**：在 `paintStates` 里边画边 `store.set` 会递归（订阅 → 重绘 → 又 set）。
   * ⚠️ 判据是 `cardOrder()`（**全部板块的卡片**，含收起板块里的）—— 用"看得见的那些"当判据
   * 会把收起板块里选中的卡片误剔掉。
   */
  private pruneSelection(order: string[]): void {
    const s = this.store.get();
    const alive = new Set(order);
    /**
     * 光标也一起剔（e 期 §4.4 起它可能是**上一次会话记下来的**：视图记忆把光标放进了
     * store 初值，而那一篇可能已经被删/改路径/移出看板）—— 留着的话，预览窗格会
     * 一直显示一篇已经不在看板上的笔记，而键盘上下也不从它那儿接。
     */
    const cursor = s.cursor != null && alive.has(s.cursor) ? s.cursor : null;
    if (s.selected.length === 0 && cursor === s.cursor) return;
    const next = s.selected.filter((p) => alive.has(p));
    const anchor = s.anchor != null && alive.has(s.anchor) ? s.anchor : null;
    if (next.length !== s.selected.length || anchor !== s.anchor || cursor !== s.cursor) {
      this.store.set({ selected: next, anchor, cursor });
    }
  }

  /**
   * 选中的卡片（按**当前显示顺序**解析成条目）。
   * 认不出来的路径直接丢：那篇可能被删了，也可能因为它所在的板块被删、已经不在看板上 ——
   * 拿不到 `NoteEntry` 就没法参与批量操作（确认流要的是文件本身）。
   */
  private selectedEntries(): NoteEntry[] {
    const sel = new Set(this.store.get().selected);
    return this.groups()
      .flatMap((g) => g.notes)
      .filter((e) => sel.has(e.path));
  }

  /**
   * 批量栏（c 期 §3.5）—— 实现是 `notes/batch-bar.ts` 那份**共享件**，
   * 这里只负责把本屏的口径传进去：
   *  · 「全选」= 看板里的全部卡片（与 `Ctrl+A`、`.cardOrder()` 同一个口径）
   *  · 「被筛掉仍选中」= 选中集里那些**已经不在看板上**的路径（板块被删、笔记被移走…）
   */
  private paintBatchBar(s: BoardState): void {
    const sel = this.selectedEntries();
    const all = this.cardOrder();
    this.toolbarHost.appendChild(
      batchBar({
        ctx: this.ctx,
        ops: this.ops,
        // ⚠️ **传函数不传数组**（c 期独立审查 🔴1）：按钮闭包要的是"点那一刻"的选中
        selected: () => this.selectedEntries(),
        all: {
          count: all.length,
          run: () => this.store.set({ selected: all, anchor: all[0] ?? null }),
          // 看板没有"筛选结果"这个概念（共享件的缺省文案是「全部笔记」那屏的口径）
          title: '选中看板里的全部卡片（含收起板块里的）',
        },
        onClear: () => this.store.set({ selected: [], anchor: null, cursor: null }),
        offscreen: Math.max(0, s.selected.length - sel.length),
        /**
         * ⚠️ **看板这句要跟「全部笔记」不一样**（c 期独立审查 🟡10，用户 2026-09-25 拍板）：
         * 两屏的 `selectedEntries` 口径不同 —— 「全部笔记」按**全库**解析（被筛掉的仍会被操作），
         * 看板**只认看板上的卡**（被筛掉的**不会**被操作）。
         * 沿用"仍在选中"就是一句空承诺：用户按文案预期"8 篇全搬"，实际只搬了看板上那几张。
         */
        offscreenText: (n) => `${n} 篇已不在看板上，不会被操作`,
        // 只读模式：批量栏的四个动库动作也要挡（c 期独立审查 🟡7）——
        // 同一批动作在卡片菜单里是置灰的，不能换条路就照做
        blocked: this.cfg.get().view.readonly
          ? '只读模式开着：右键空白处 → 更多显示 → 只读模式，即可动库'
          : undefined,
      }),
    );
    /**
     * ⚠️ **回执在批量栏这一支也要画**（c 期独立审查 🟡5）：回执原先只有一个渲染点，
     * 在"画普通工具条"那一支里 —— 于是**有选择时**它永远不出现：
     * 选着几张卡按 `Ctrl+滚轮` 缩放，屏幕上一点反馈都没有（而 §4.2 明写要报「卡片 W × H」）；
     * 更烦的是回执还是 Esc 分层栈的一层，会**白吃掉一次 Esc**。
     * 挂在 `.kbw-board-toolbar` 上（不是某条栏上），两条分支的定位口径就一致了
     *（那条容器在 CSS 里加了 `position: relative`）。
     */
    if (s.receipt) {
      this.toolbarHost.appendChild(div({ cls: 'kbw-board-receipt', text: s.receipt }));
    }
  }

  /**
   * 框选（c 期 §3.5）。
   *
   * 选框挂在 `document.body` 上（`position: fixed`）—— 挂进看板里的话，滚看板时
   * 框会跟着内容一起跑，而指针给的是**视口**坐标，两套坐标一混就全歪。
   * 拖动本身复用 `ui/dnd` 的基元（`startPointerDrag`）：阈值、`pointercancel`、
   * Esc 中止、监听清理那一整套都在那儿，自己再写一遍必漏一条。
   */
  private startMarquee(down: PointerEvent): void {
    const start = { x: down.clientX, y: down.clientY };
    /** 起手时的修饰键决定"并集还是替换"—— 基元的 ctx 里没有 evt，松手时再问就晚了 */
    const additive = hasMod(down) || down.shiftKey;
    const el = div({ cls: 'kbw-marquee' });
    /**
     * 🔴 **第一帧就要归零到触点**（S4 真机实测的残影 bug）：起手画的是一个**零尺寸**矩形。
     * 绝不能让上一次的框（或任何默认尺寸）在这一帧露出来 —— 那个 bug 离线测不出、真机一眼就看见。
     */
    const place = (x: number, y: number): void => {
      const r = normRect(start, { x, y });
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    };
    place(start.x, start.y);

    this.stopMarquee = startPointerDrag(down, 0, {
      onStart: (c) => {
        document.body.appendChild(el);
        place(c.x, c.y);
      },
      onOver: (_t, c) => place(c.x, c.y),
      onDrop: (_t, c) => {
        el.remove();
        this.stopMarquee = null;
        const box = normRect({ x: start.x, y: start.y }, { x: c.x, y: c.y });
        const items = this.cardElements().map((ce) => ({
          path: ce.dataset.path ?? '',
          rect: ce.getBoundingClientRect(),
        }));
        const hit = marqueeHit(items, box);
        const s = this.store.get();
        const next = additive ? Array.from(new Set([...s.selected, ...hit])) : hit;
        /**
         * ⚠️ 这里**不设回执**：工具条上已经有「已选 N 篇」，再挂一条回执等于凭空多一层 Esc
         *（`syncEscapeLayer` 把回执排在选择前面）—— 用户要按两次 Esc 才清得掉选择。
         */
        this.store.set({ selected: next, anchor: hit[0] ?? s.anchor });
        this.syncEscapeLayer();
      },
      onCancel: () => {
        el.remove();
        this.stopMarquee = null;
        this.syncEscapeLayer();
      },
    });
    /**
     * 记下句柄 + 刷一次 Esc 层（`need()` 里加了"框选中"这一条）——
     * 框选**不改 store**，所以不会自动触发订阅里那次 `syncEscapeLayer`，得手动叫一次。
     */
    this.syncEscapeLayer();
  }

  // ── 区域：工具条 ─────────────────────────────────────────────
  private paintToolbar(): void {
    /**
     * **有选择时，整条工具条换成批量栏**（§3.4 的口径：不额外占垂直空间；
     * 与「全部笔记」共用 `notes/batch-bar.ts` 那一份实现，改一处两屏一起变）。
     */
    const s = this.store.get();
    if (s.selected.length > 0) {
      this.paintBatchBar(s);
      return;
    }
    const bar = div({ cls: 'kbw-board-bar' });
    const left = div({ cls: 'kbw-board-tools' });

    /**
     * ⚠️ 图标必须是 **lucide 的 `settings` 简笔 SVG**，不许写成 emoji 字形「⚙」
     *（用户 2026-09-25 第二波反馈："这个图标时不时变成灰色上色的版本"）：
     * emoji 由**字体**决定长相，同一台机器上也会因字体回退/上下文渲染成彩色或灰阶的图画，
     * 而相邻的按钮全是单色线性 SVG —— 放一起就是"这个按钮跟别的不一样"。
     * 文本也顺带只留「板块」（图标已经承担了"齿轮"的语义）。
     */
    left.appendChild(
      btn(
        {
          cls: 'kbw-btn is-small',
          title: '板块管理（增删改 / 排序 / 实时命中计数）；再点一次关',
          on: { click: (evt) => this.openPanel(evt.currentTarget as HTMLElement) },
        },
        icon('settings', 15),
        '板块',
      ),
    );
    left.appendChild(
      btn({
        cls: 'kbw-btn is-small',
        text: '＋ 添加板块',
        on: { click: () => this.openPanel(null, true) },
      }),
    );
    left.appendChild(
      btn({
        cls: 'kbw-btn is-small is-ghost',
        text: '全部展开',
        title: '把所有板块展开（含子板块）',
        on: { click: () => this.setAllCollapsed(false) },
      }),
    );
    left.appendChild(
      btn({
        cls: 'kbw-btn is-small is-ghost',
        text: '全部收起',
        on: { click: () => this.setAllCollapsed(true) },
      }),
    );

    const right = div({ cls: 'kbw-board-tools' });
    right.appendChild(span({ cls: 'kbw-board-label', text: '卡片显示' }));
    const seg = div({ cls: 'kbw-seg' });
    for (const m of ['content', 'props', 'both'] as CardMode[]) {
      seg.appendChild(
        btn({
          cls: ['kbw-segbtn', this.cfg.get().view.cardMode === m ? 'is-on' : null],
          text: CARD_MODE_LABEL[m],
          on: { click: () => void this.setView({ cardMode: m }, `卡片显示：${CARD_MODE_LABEL[m]}`) },
        }),
      );
    }
    right.appendChild(seg);
    /**
     * **小窗显示的入口**（f 期第 3 条）：就挨着「卡片显示」——
     * 用户找"显示档"时手边就有（原先只有面板头上的 ⚙ 一个入口）。
     * 弹菜单一律过 `ui/menu.ts`（`showPanelDisplayMenu` 里就是它）。
     */
    right.appendChild(
      iconBtn('sliders-horizontal', '小窗显示（属性 / 正文 / 字号）', (evt) => {
        showPanelDisplayMenu(this.menuCtx(), evt as MouseEvent);
      }),
    );

    // `s` 在函数开头就取过了（批量栏那条早退也要用它）
    if (s.receipt) bar.appendChild(div({ cls: 'kbw-board-receipt', text: s.receipt }));
    bar.appendChild(left);
    bar.appendChild(div({ cls: 'kbw-board-sp' }));
    bar.appendChild(right);
    this.toolbarHost.appendChild(bar);
  }

  /** 累计中的缩放目标（滚轮一次可能来十几个事件，攒着一起写） */
  private zoomW: number | null = null;
  private zoomH: number | null = null;
  private zoomFlush: Debounced<[]> | null = null;

  private onZoom(evt: WheelEvent): void {
    if (!evt.ctrlKey && !evt.metaKey) return;
    evt.preventDefault();
    const cfg = this.cfg.get();
    const dir = evt.deltaY > 0 ? -1 : 1;
    const step = 20;
    /**
     * ⚠️ 基准值要取"**累计中的上一格**，没有才取配置里的"——
     * 写成 `this.zoomW ?? cfg.view.cardWidth + dir * step` 看着像对，
     * 但第一格之后 `zoomW` 一直非空，于是**只加了第一格**（连滚十格也只挪一档）。
     */
    const baseW = this.zoomW ?? cfg.view.cardWidth;
    const w = clamp(baseW + dir * step, CARD_W_MIN, CARD_W_MAX);
    /**
     * 高度：**自动高度档在第一次缩放时锁成固定高度**（用户 2026-09-25 补的）。
     * 为什么不锁不行：自动高度是按"摘要行数截断"算的 —— 变宽反而更矮
     * （同样 3 行，宽度大了每行占的高度更小），于是"缩放"看着像只改了宽度、笔记没有变大。
     * 基准取**当前最高那张卡的高度**（取最高而不是平均：平均会让长卡比缩放前更矮，
     * 反而要滚动 —— 与"放大是为了看到更多"相反，见 `autoHeightBase`），
     * 之后按宽度同比例缩放；这一档的代价是卡片高度从此统一（回执里报「卡片 W × H」）。
     */
    const baseH = this.zoomH ?? (cfg.view.cardHeight > 0 ? cfg.view.cardHeight : this.autoHeightBase());
    const h = baseH > 0 ? clamp(Math.round(baseH * (w / baseW)), CARD_H_MIN, CARD_H_MAX) : 0;
    this.zoomW = w;
    this.zoomH = h;
    // ① 先改界面（就地，不等落盘）。`has-h` 要一起加：CSS 靠它把正文从"3 行截断"切成"填满 + 内部滚动"
    for (const el2 of Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-cards'))) {
      el2.style.setProperty('--kbw-card-w', `${w}px`);
      if (h > 0) {
        el2.style.setProperty('--kbw-card-h', `${h}px`);
        el2.classList.add('has-h');
      }
    }
    /**
     * ⚠️ **列形态下还得写板块上那一份**（b 期独立审查 🟡1）：列宽读的是 `.kbw-sect` 上的
     * `--kbw-card-w`（列不是 `.kbw-cards` 的后代），只写卡片区的话 —— 卡片被
     * `max-width: 100%` 夹在列里、列又没变 → **整个看板纹丝不动**，只有顶上回执在滚数字，
     * 等 300ms 防抖落盘后整块重绘才"跳"一下。流式下没这个问题（卡片区就是宽度的宿主）。
     */
    for (const sect of Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-sect'))) {
      sect.style.setProperty('--kbw-card-w', `${w}px`);
    }
    this.setReceipt(h > 0 ? `卡片 ${w} × ${h}` : `卡片宽度 ${w}`);
    // ② 再防抖落盘
    this.zoomFlush ??= debounce(() => {
      const ww = this.zoomW;
      const hh = this.zoomH;
      this.zoomW = null;
      this.zoomH = null;
      if (ww == null) return;
      void this.setView(hh != null && hh > 0 ? { cardWidth: ww, cardHeight: hh } : { cardWidth: ww });
    }, 300);
    this.zoomFlush();
  }

  /**
   * 自动高度档下量一个**基准高度**：取**最高的那张卡**。
   *
   * 为什么是最高而不是平均：基准被拿去当"缩放后所有卡片的统一高度"，
   * 取平均的话**最长的那几张会比缩放前更矮** → 原本一屏能看完的正文要开始滚，
   * 与"放大是为了看到更多"正好相反（真机实测：平均 205px、首张只有 181px）。
   * 取最高的代价是短卡多一点留白 —— 两种代价里这个是可接受的。
   *
   * 用途只有一个：第一次 Ctrl+滚轮缩放时把"自动"锁成固定高度的基准（见 `onZoom`）。
   * 量不到（卡片还没画 / 收起了）→ 0，调用方当"没有基准"处理。
   */
  private autoHeightBase(): number {
    let max = 0;
    for (const c of this.cardElements()) {
      const h = c.getBoundingClientRect().height;
      if (h > max) max = h;
    }
    return Math.round(max);
  }

  private setReceipt(text: string): void {
    this.store.set({ receipt: text });
    window.setTimeout(() => {
      if (this.store.get().receipt === text) this.store.set({ receipt: null });
    }, 2600);
  }

  private async setView(patch: Partial<import('./config').BoardView>, receipt?: string): Promise<void> {
    await this.cfg.patchView(patch);
    this.store.set({ cfgRev: this.store.get().cfgRev + 1 });
    if (receipt) this.setReceipt(receipt);
  }

  private setAllCollapsed(collapse: boolean): void {
    const groups = this.groups();
    this.setCollapsed(collapse ? groups.filter((g) => !g.sub).map((g) => g.key) : []);
    // 「全部收起」= 子板块也回到默认（收起）；「全部展开」= 子板块一起摊开
    this.setOpenSubs(collapse ? [] : groups.filter((g) => g.sub).map((g) => g.key));
    this.applyCollapseInPlace();
    this.setReceipt(collapse ? '已全部收起' : '已全部展开（含子板块）');
  }

  private openPanel(anchor: HTMLElement | null, addNew = false): void {
    openSectionPanel({
      ctx: this.ctx,
      store: this.cfg,
      anchor,
      addNew,
      onChanged: (receipt) => {
        this.store.set({ cfgRev: this.store.get().cfgRev + 1 });
        if (receipt) this.setReceipt(receipt);
      },
      onNeedsRender: () => this.store.set({ cfgRev: this.store.get().cfgRev + 1 }),
      counts: () => {
        const map = new Map<string, number>();
        for (const g of this.groups()) {
          if (g.sub) continue;
          map.set(g.sectionId, (map.get(g.sectionId) ?? 0) + g.notes.length);
        }
        return map;
      },
    });
  }

  private menuCtx() {
    return {
      ctx: this.ctx,
      store: this.cfg,
      groups: () => this.groups(),
      refresh: () => this.store.set({ cfgRev: this.store.get().cfgRev + 1 }),
      onReceipt: (text: string) => this.setReceipt(text),
    };
  }

  // ── 区域：板块与卡片 ─────────────────────────────────────────
  private async paintBoard(): Promise<void> {
    const token = ++this.paintToken;
    // 形态是**宿主上的类名**，重绘不会自己更新它（改形态走的就是这条路）
    this.applyFlow();
    if (!this.store.get().loaded) {
      // `reuse: true` → Region 不再替我们清宿主，这里自己清（别让骨架叠在旧内容上）
      while (this.bodyHost.firstChild) this.bodyHost.removeChild(this.bodyHost.firstChild);
      this.bodyHost.appendChild(skeleton('cards', 6));
      return;
    }
    /**
     * **两段式绘制**（用户 2026-09-25 反馈："读正文的时候至少保留下名字"）。
     * 早先是"先 await 读完 43 篇正文、再画" → 这一段时间里屏幕上只有灰色骨架条，
     * 连是哪篇都看不出来。现在：**先用缓存（可能是空的）把卡片画出来**（名字/属性/时间
     * 本来就是从索引来的、立即可得），正文位置写「读正文中…」；读完正文再画第二遍。
     */
    const stale = this.textsRev !== this.ctx.index.revision;
    /**
     * ⚠️ **只对"一次都没读过正文"那一次两段式**（冷启）：缓存里还没有任何正文时，
     * 先把名字/属性/时间（都来自索引，立即可得）画出来、正文写「读正文中…」。
     * 之后的重绘（改筛选、拖拽、索引更新…）仍旧"读完再画一遍"——
     * 每次重绘都多拍一下会让**别处拿着的 DOM 引用过期**（用例实测：多出好几条假红），
     * 而那时的正文通常已经缓存好了，本来也不需要两段。
     */
    const cold = stale && this.texts.size === 0;
    if (cold) {
      const myToken = token;
      /**
       * ⚠️ **正在拖动时先不画**（真机探针实测）：重绘会把卡片的位置换掉，
       * 而拖拽的落点是按**当时**的几何算的 —— 拖到一半被重画，松手就落错地方
       *（a.5-1 那条真机判据因此假红过一次）。等拖动结束（或超时）再补这一拍。
       */
      const paintWhenIdle = (tries: number): void => {
        /**
         * 🔴 **token 变了不等于"可以不补画"**（2026-09-25 真机撞见的"卡片永久卡在「读正文中…」"）。
         *
         * 那条死路是这么走成的：读正文的过程中恰好插进来一次别的重绘（`paintToken` 变了），
         * 而**它画的时候正文还没读完** → 屏幕上就写着「读正文中…」；等 `ensureTexts` 读完回来，
         * 这里一看 token 不同就 `return` → **再没有任何人会补画这一拍**。
         * 更糟的是 `ensureTexts` 进门就把 `textsRev` 置成了当前版本（快车道），
         * 之后所有重绘都判成"缓存命中" → 直接照着旧状态画 → 永久停在占位上（只有重载插件能救）。
         *
         * 所以判据**要看屏幕**，不是看 token：`bodyHost` 里还挂着 `is-loading` 的占位就补画。
         * 补画最多多跑一次（`ensureTexts` 的 `.then` 只来一发），不会自己循环；
         * 真读不出正文时占位会变成「（还没有正文）」（不带 `is-loading`）→ 自然收敛。
         */
        const stillLoading = this.bodyHost.querySelector('.kbw-card-empty.is-loading') != null;
        if (myToken !== this.paintToken && !stillLoading) return;
        if (this.store.get().dragKey != null && tries > 0) {
          window.setTimeout(() => paintWhenIdle(tries - 1), 400);
          return;
        }
        void this.paintBoard();
      };
      void this.ensureTexts().then(() => paintWhenIdle(25));
    } else if (stale) {
      await this.ensureTexts();
      if (token !== this.paintToken) return;
    } else {
      // 缓存命中：不用读
    }

    /**
     * 🔴 **捕获就在这一刻**（清宿主之前、正文也读完了）：这一刻的 DOM 是"上一次画完的完整一屏"，
     * 用户滚到哪儿都能如实读到。写回紧跟在同一块的重建之后 —— 中间没有 await，
     * 也就没有"这几毫秒里世界变了"的窗口（见 `keepScrollNext` 的注释）。
     *
     * ⚠️ 改名要在这儿补一刀：捕获读到的键还是**旧路径**（DOM 还没重画），
     * 而重建之后是**新路径** —— 不换键就写不回去（实测：列保住了、卡面正文 0）。
     */
    let snap = this.keepScrollNext ? captureScroll(this.bodyHost) : null;
    for (const [from, to] of this.renamedSinceSnap) snap = remapSnap(snap, from, to);
    /**
     * ⚠️ **只有"真的换过键"之后才能清那张改名表**：`snap` 为 null 的趟（视图参数变过、
     * 或这一趟不需要保滚动）什么都没迁，清掉就等于**把这次改名丢了** ——
     * 下一趟捕到的还是旧键，而 DOM 里已经是新键，位置照样回不去（实测：卡在=true but top=0）。
     */
    if (snap) this.renamedSinceSnap.clear();
    if (this.carriedSnap) {
      // 上一趟"没长出来"的那些：只补这一趟**没有的键**（fresh 永远优先 —— 用户可能刚滚过）
      const merged: ScrollSnap = { ...(snap ?? {}) };
      for (const [k, v] of Object.entries(this.carriedSnap)) if (!(k in merged)) merged[k] = v;
      snap = merged;
    }
    this.keepScrollNext = true;
    while (this.bodyHost.firstChild) this.bodyHost.removeChild(this.bodyHost.firstChild);
    const cfg = this.cfg.get();

    if (cfg.sections.length === 0) {
      this.bodyHost.appendChild(
        emptyState({
          kind: 'board',
          title: '还没有板块',
          desc: '看板按板块取数。先建一个「文件夹 / 标签 / 属性值 / 收容所」板块，卡片就出来了。',
          action: { label: '＋ 添加板块', run: () => this.openPanel(null, true) },
        }),
      );
      return;
    }

    const groups = this.groups();
    let painted = 0;
    for (const g of groups) {
      const sec = cfg.sections.find((x) => x.id === g.sectionId) ?? null;
      if (!sec) continue;
      /**
       * ⚠️ **子板块也要画**（独立审查 R6：原先这里是 `groups.filter(x => !x.sub)`，
       * 子板块被整批丢掉 —— §4.1 承诺的「缩进 + 竖参考线 + 默认收起」一行都没出现过，
       * 而取数层一直在算它们）。父板块被「隐藏空板块」藏起来时，子板块跟着藏，
       * 免得出现没有父的孤儿行。
       */
      if (cfg.view.hideEmpty) {
        const parentKey = g.sub ? g.sectionId : g.key;
        if (!groups.some((x) => x.key === parentKey && x.notes.length > 0)) continue;
      }
      this.bodyHost.appendChild(this.renderSection(g, sec));
      if (!g.sub) painted += 1;
    }
    if (painted === 0) {
      this.bodyHost.appendChild(
        emptySection('所有板块都是空的（「隐藏空板块」开着）', '在空白处右键 → 更多显示 → 关掉「隐藏空板块」就能看见它们'),
      );
    }
    this.paintStates(this.store.get());
    /**
     * ⚠️ **画完之后**才剔失效的选择（见 `pruneSelection` 的注释）——拖走/删掉/改名的那些
     * 路径到这一步已经不在 `cardOrder()` 里了。
     */
    this.pruneSelection(groups.flatMap((g) => g.notes.map((n) => n.path)));
    /**
     * **画完了 → 把上一回的位置写回去**（视图记忆，e 期 §4.4）。
     *
     * 🔴 时机必须挂在这儿：看板是**异步带 token** 画的（先读正文再画），冷启还是**两段式**
     *（先画名字/属性、正文位置写「读正文中…」，读完再画一遍）。写早了就是往一个
     * 还没有卡片的容器上设 `scrollTop` —— 写了也白写（此时它压根不可滚，值会被钳成 0）。
     * 所以判据用 `!cold`（这一趟是**画实了**的那一趟）。
     *
     * ⚠️ `scrollRestored` 让"第一次"这件事显式：快照本身是一次性的（取走即删），
     * 但 `paintBoard` 会被索引/配置变动反复调到 —— 有标志位，这条不变量不依赖
     * "`recallScroll` 恰好被调了几次"这种隐式知识。
     */
    if (!this.scrollRestored && !cold && this.snap) {
      this.scrollRestored = true;
      /**
       * ⚠️ 写回的 root 用 **`this.bodyHost`**（而不是模块宿主 `this.host`）：
       * `board` 这个键就贴在它自己身上、`cards:<key>` 贴在各列上（都是它的后代）——
       * 而 `applyScroll` 现在**连 root 自己一起写**（独立审查抓的那个"捕得到、写不回去"
       * 就是这里：原先 root 不含自己）。
       */
      applyScroll(this.bodyHost, this.snap);
      this.snap = null;
    }
    /**
     * **写回就在重建之后**（同一个同步块）：`restoreIfReset` 只填"此刻还是 0"的容器 ——
     * 刚重建出来的那些正好都是 0，所以该恢复的都恢复；而被别的路径设过的（用户自己滚过）
     * 不会被抢。`cold` 那一趟是占位屏，没有位置可恢复，跳过。
     */
    if (!cold) {
      restoreIfReset(this.bodyHost, snap);
      /**
       * **这一趟没写进去的（键还没长出来）带在手上，下一趟再试**（上限 8 趟）。
       *
       * 为什么必须有它（e2 独立审查 🔴1/🟡2 顺着查出来的实测）：改名那一下索引会先删旧、
       * 后加新，中间**有一趟重绘画不出那张卡** —— 那一趟它的位置无处可写；等它回来时，
       * 新画出来的卡面正文是 0，而"用户原来滚到 120"这件事已经没有任何人记得了。
       * 判据只认"**非零、且此刻 DOM 里没有这个键**"（键在但值是 0 = 用户滚到了顶，
       * 那种不算没写进去）。带在手上的值只填"此刻还是 0"的容器，所以不会去拽用户自己滚到的地方。
       */
      const missing: ScrollSnap = {};
      const here = new Set<string>();
      for (const node of [this.bodyHost, ...Array.from(this.bodyHost.querySelectorAll<HTMLElement>(`[${SCROLL_ATTR}]`))]) {
        const k = node.getAttribute(SCROLL_ATTR);
        if (k) here.add(k);
      }
      for (const [k, pos] of Object.entries(snap ?? {})) {
        if ((pos.top !== 0 || pos.left !== 0) && !here.has(k)) missing[k] = pos;
      }
      this.carriedSnap = Object.keys(missing).length > 0 && this.carryAge < 8 ? missing : null;
      this.carryAge = this.carriedSnap ? this.carryAge + 1 : 0;
    }
    /**
     * **"跳过来要看得见"那一下**（e2 期 §4.1）—— 排在滚动恢复**之后**：
     * 前者是"保持用户原来的位置"，后者是"用户刚要求去别处"，后者优先。
     */
    if (!cold) this.revealPending();
  }

  /**
   * 把「跳到看板」的意图落到界面上：**先展开（那是配置）、再等画完滚过去**。
   *
   * ⚠️ 不在这儿直接 `scrollIntoView`：展开会改配置 → 触发一次重绘 → 那时刚滚到的位置
   * 会被新画出来的 DOM 换掉（滚了个寂寞）。所以只记在 `pendingReveal` 上，
   * 由 `paintBoard` 末尾（画实那一趟）执行。
   */
  private applyIntent(intent: BoardIntent): void {
    /**
     * ⚠️ **配置还没读完时先存着**（独立审查指出的残留时序洞）：模块刚 mount、`reloadCfg()`
     * 还没回来的那个窗口里收到的意图，照默认空配置去查板块会得出"那个板块不在了"并**把意图吃掉**
     *（`lastIntentSeq` 已推进，不会再重试）—— 症状是"跳了、但没展开"，还搭一句假通知。
     */
    if (!this.cfg.isLoaded()) {
      this.bootIntent = intent;
      return;
    }
    const cfg = this.cfg.get();
    let target: { path?: string; sectionId?: string } | null = null;

    if (intent.path) {
      const g = this.groups().find((x) => x.notes.some((n) => n.path === intent.path));
      if (g) {
        if (isCollapsed(cfg, g.key, g.sub)) this.toggleCollapsed(g.key, g.sub);
        this.store.set({ cursor: intent.path });
        target = { path: intent.path };
      } else {
        // 这一篇不在看板上（被筛掉 / 板块改了）→ 如实说，别装作跳成功了
        notifyInfo('这一篇不在看板上', '它可能被排除规则挡住了，或不在任何板块的数据源里');
        return;
      }
    } else if (intent.sectionId) {
      const sec = cfg.sections.find((x) => x.id === intent.sectionId);
      if (!sec) {
        notifyInfo('那个板块不在了', '看板配置可能刚被改过');
        return;
      }
      const g = this.groups().find((x) => x.sectionId === sec.id);
      if (g && isCollapsed(cfg, g.key, g.sub)) this.toggleCollapsed(g.key, g.sub);
      const first = g?.notes[0];
      if (first) this.store.set({ cursor: first.path });
      target = { sectionId: sec.id, path: first?.path };
    }
    this.pendingReveal = target;
    /**
     * 展开那一步已经触发了一次重绘；板块没收起、也没有卡片可落光标时上面**一次都不会重绘** ——
     * 那种情况下得自己叫一次，否则 `pendingReveal` 永远等不到"画完那一刻"。
     */
    this.repaint();
  }

  /** 画完了 → 把"要看得见"的那个滚进视野（`pendingReveal` 由 `applyIntent` 放下） */
  private revealPending(): void {
    const want = this.pendingReveal;
    if (!want) return;
    this.pendingReveal = null;
    /**
     * ⚠️ **自己走一遍 DOM 认元素，不拼 CSS 选择器**：路径里 `/` `.` 引号都有，
     * 拼选择器迟早踩到转义问题（`view-memory` 的键匹配当初就是为这个改成遍历的）。
     */
    let el: HTMLElement | null = null;
    if (want.path) {
      el =
        Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-card')).find(
          (c) => c.dataset.path === want.path,
        ) ?? null;
    } else if (want.sectionId) {
      const id = want.sectionId;
      el =
        Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-sect')).find((x) => {
          const k = x.dataset.key ?? '';
          return k === id || k.startsWith(`${id}::`);
        }) ?? null;
    }
    /**
     * ⚠️ 滚的是**卡片/板块那个元素**、用 `block:'center'`：它自己会把**各个可滚祖先**
     *（列、看板体）一起带到位 —— 这正是"跳过去并让它可见"要的效果。
     */
    el?.scrollIntoView?.({ block: 'center' });
  }

  private renderSection(g: BoardGroup, sec: BoardSection): HTMLElement {
    const cfg = this.cfg.get();
    const collapsed = isCollapsed(cfg, g.key, g.sub);
    /**
     * 🔴 **重绘时也要把 `is-collapsed` 贴上去**（用户 2026-09-25 真机截图抓到的真 bug）：
     * 这里原先只用 `collapsed` 决定"建不建卡片区"，**类名交给 `applyCollapseInPlace` 去贴** ——
     * 于是凡是**走整块重绘**的配置变更（例：同时改了卡片高度，`onlyCollapseChanged` 判成 false），
     * 收起的板块就渲染成"没有 `is-collapsed` 类、也没有卡片区"的怪样子：
     * 列形态下竖条不出现、头上那排按钮还在，看着像坏了一半（用户原话："显示的内容非常奇怪"）。
     * **类的唯一来源就在这儿**：谁渲染，谁负责贴。
     */
    const sect = div({ cls: ['kbw-sect', g.sub ? 'is-sub' : null, collapsed ? 'is-collapsed' : null] });
    sect.dataset.key = g.key;
    /**
     * ⚠️ **列宽就是卡片宽度**（§2.1：复用 `cardWidth`，不另造参数）—— 而列形态下
     * 需要这个值的元素（列本身、列头、指示线）**不都是 `.kbw-cards` 的后代**，
     * 所以这里在**板块**上再放一份（CSS 变量会继承）。
     *
     * 为什么不能只靠 `buildCards` 那一份：首屏就收起的板块**根本不建卡片区**
     *（那是 §1.2 的优化），于是"收起 → 展开"之后板块上依然没有这个变量 ——
     * 列宽会静默退回 240px 默认值（用户把卡片调成 320 就露馅了）。
     * 两份都从 `effectiveWidth(cfg, sec)` 来，同一个纯函数、同一份配置 → 不会漂。
     */
    sect.style.setProperty('--kbw-card-w', `${effectiveWidth(cfg, sec)}px`);
    sect.style.setProperty('--kbw-gap', `${cfg.view.gap}px`);
    sect.appendChild(this.renderSectionHead(g, sec, collapsed));
    if (!collapsed) sect.appendChild(this.buildCards(g, sec));
    return sect;
  }

  /**
   * 板块头那一行。
   * ⚠️ **单独抽出来**是为了「就地收起/展开」：那条路只重画这一行（`applyCollapseInPlace`），
   * 不碰卡片区 —— 卡片区一重画，每张卡的正文就要重走一遍 `MarkdownRenderer.render`。
   */
  private renderSectionHead(g: BoardGroup, sec: BoardSection, collapsed: boolean): HTMLElement {
    const head = div({ cls: 'kbw-sect-head', attr: { 'data-drop': g.key } });
    head.appendChild(
      span(
        {
          cls: ['kbw-sect-caret', collapsed ? null : 'is-open'],
          attr: { role: 'button', tabindex: '0', 'aria-label': collapsed ? '展开' : '收起' },
          on: {
            click: (evt) => {
              evt.stopPropagation();
              this.toggleCollapsed(g.key, g.sub);
            },
          },
        },
        icon(collapsed ? 'chevron-right' : 'chevron-down', 15),
      ),
    );

    if (this.store.get().renaming === g.sectionId && !g.sub) {
      head.appendChild(this.sectionRenameInput(sec));
    } else {
      head.appendChild(
        span({
          cls: 'kbw-sect-nm',
          text: g.title,
          attr: { role: 'button', tabindex: '0', title: g.sub ? `子板块：${g.title}` : '双击改名' },
          on: {
            dblclick: (evt) => {
              evt.stopPropagation();
              if (!g.sub) this.startSectionRename(g.sectionId);
            },
          },
        }),
      );
    }

    // 计数：上限截断时说清「N / M 条」（静默截断等于把笔记藏起来，§8.2）
    const count = span({ cls: 'kbw-sect-n' });
    count.textContent = g.limited > 0 ? `${g.notes.length} / ${g.total} 条` : `${g.total} 篇`;
    if (g.limited > 0) {
      count.classList.add('is-limited');
      count.title = `被「显示上限」截掉了 ${g.limited} 篇 —— 点一下放开`;
      count.setAttribute('role', 'button');
      count.setAttribute('tabindex', '0');
      count.addEventListener('click', (evt) => {
        evt.stopPropagation();
        void this.setSection(sec.id, { limit: null }, `「${sec.name}」不限条数了`);
      });
    }
    head.appendChild(count);

    if (g.hidden > 0) head.appendChild(span({ cls: 'kbw-sect-badge', text: `已隐藏 ${g.hidden}` }));
    if (g.excluded > 0) head.appendChild(span({ cls: 'kbw-sect-badge is-dim', text: `排除 ${g.excluded}` }));

    head.appendChild(div({ cls: 'kbw-board-sp' }));
    head.appendChild(
      iconBtn('plus', '在此新建笔记（按板块算落点）', (evt) => {
        evt.stopPropagation();
        this.newNoteIn(g, sec);
      }),
    );
    head.appendChild(
      iconBtn('more-horizontal', '板块菜单', (evt) => {
        evt.stopPropagation();
        this.sectionMenu(g, sec, evt);
      }),
    );
    /**
     * **竖条档**（§2.1 / Q4）：列形态下收起时不是整块消失，而是留一条 ~40px 的竖条
     *（竖排名字 + 计数），点一下展开。流式形态下它 `display: none`（那边收起的语义不变）。
     *
     * 三个决定：
     *  ① 它是**板块头里的一个元素**，不是独立区块 —— 这样 `applyCollapseInPlace` 那条
     *     "只重画头"的路会把它一起管住，不必再写第二套同步；也就还是"就地切 class"，
     *     没有退回整块重绘（收起态的优化是 a 期刚做的，不能因为加了竖条就丢掉）。
     *  ② 用**真 `<button>`**（不是 div+role）：Enter/Space 的原生激活白送，
     *     键盘用户够得到（板块头那排控件目前只有 click，别把这个新控件也做成那样）。
     *     代价是平台给 `button` 的样式要清干净（`box-shadow: inset …` 那圈虚线环，见 CSS）。
     *  ③ 计数用的是与板块头**同一份文案**（`count.textContent`）—— 两处各算一遍就会漂。
     */
    head.appendChild(
      el(
        'button',
        {
          cls: 'kbw-sect-rail',
          attr: { type: 'button', 'aria-label': `展开「${g.title}」`, title: `展开「${g.title}」` },
          on: {
            click: (evt) => {
              evt.stopPropagation();
              this.toggleCollapsed(g.key, g.sub);
            },
          },
        },
        icon('chevron-right', 15),
        span({ cls: 'kbw-rail-nm', text: g.title }),
        span({ cls: 'kbw-rail-n', text: count.textContent ?? '' }),
      ),
    );
    head.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.sectionMenu(g, sec, evt);
    });
    return head;
  }

  /** 一个板块的卡片区（`.kbw-cards`）。收起时就**不建**（首屏别为看不见的卡片读正文） */
  private buildCards(g: BoardGroup, sec: BoardSection): HTMLElement {
    const cfg = this.cfg.get();
    const cards = div({ cls: 'kbw-cards', attr: { 'data-drop': g.key } });
    /**
     * 🔴 **列形态下每一列各自滚**（`styles/board.css` 那条 `> .kbw-cards { overflow-y: auto }`）——
     * 所以视图记忆**必须把每一列也记上**，只记 `.kbw-board-body` 是不够的：
     * 真机实测（2026-09-26）：那个实验库里唯一有滚余量的容器就是列
     *（看板体 643−643、笔记列表 674−674 都是 0，两列分别是 411 / 91）——
     * 只记 body 的话，这一期最想兑现的"回来还在原地"在那种库上**一次都不会生效**。
     *
     * 键带上板块 key（`cards:<key>`）：列的位置要**回到那一列**，不能张冠李戴。
     * ⚠️ 收起的板块没有卡片区（`renderSection` 里那个 `if (!collapsed)`）→ 那一列这次没有容器，
     * 捕获/写回都会**安静跳过**（`captureScroll` 收不到它、`applyScroll` 找不到它就跳过）——
     * 展开之后是新位置（0），这是对的（"刚展开"本来就该在顶部）。
     */
    cards.setAttribute(SCROLL_ATTR, `cards:${g.key}`);
    const w = effectiveWidth(cfg, sec);
    const h = effectiveHeight(cfg, sec);
    cards.style.setProperty('--kbw-card-w', `${w}px`);
    cards.style.setProperty('--kbw-gap', `${cfg.view.gap}px`);
    /**
     * 固定高度（>0）单独一个类：CSS 里靠它把正文从"3 行截断"切成"填满 + 内部滚动"。
     * `showHidden` 那几个同理都走类名，别在 JS 里算样式。
     */
    if (h > 0) {
      cards.style.setProperty('--kbw-card-h', `${h}px`);
      cards.classList.add('has-h');
    }
    if (g.notes.length === 0) {
      cards.appendChild(emptySection('这个板块还没有笔记', hintForSource(g)));
    }
    for (const e of g.notes) {
      cards.appendChild(
        renderCard(
          {
            ctx: this.ctx,
            view: cfg.view,
            entry: e,
            text: this.textOf(e),
            loading: this.textsLoading || this.textsRev !== this.ctx.index.revision,
            cardMode: effectiveCardMode(cfg, sec),
            props: this.propsFor(sec),
            expanded: this.store.get().expanded.includes(e.path),
            fixedHeight: h > 0,
            renaming: this.store.get().renamingNote === e.path,
            component: this.component,
            /**
             * 键 = `card:<板块 key>:<路径>`：带上板块是为了**避免重名**
             *（「允许重复」默认开 → 同一篇可能有两张卡），带上路径是为了"回到那一张卡"。
             * ⚠️ 改名会改路径 → 那一下由 `vault.on('rename')` 把快照里的键一起迁（见 `migrateOrder` 旁边）。
             */
            scrollKey: `card:${g.key}:${e.path}`,
          },
          this.cardCallbacks(),
        ),
      );
    }
    return cards;
  }

  /**
   * **就地**把配置里的收起态贴到 DOM（P4.5 §1.2）—— **不重画整块**。
   *
   * 三条：
   *  ① 收起时**卡片区留在 DOM 里**、只加 `.is-collapsed` 让 CSS 藏起来 → 下次展开是瞬时的
   *     （首屏仍然不给收起态建卡片区：`renderSection` 里那个 `if (!collapsed)`）；
   *  ② 展开时卡片区还没建过（首屏就是收起的 / 子板块默认收起）→ **只补这一块**；
   *  ③ **只重画板块头那一行**（三角朝向 + `aria-label` 跟着走），
   *     计数徽标那些跟收起态无关的东西因此不必单独维护 —— 头是同一个函数画的，加字段不会漏。
   *     ⚠️ 例外：这一行正在就地改名时**不整行换**（换掉等于把输入框连人带字一起铲了）。
   */
  private applyCollapseInPlace(): void {
    const cfg = this.cfg.get();
    const byKey = new Map(this.groups().map((g) => [g.key, g]));
    const renaming = this.store.get().renaming;
    for (const sect of Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-sect'))) {
      const g = byKey.get(sect.dataset.key ?? '');
      if (!g) continue;
      const sec = cfg.sections.find((s) => s.id === g.sectionId);
      if (!sec) continue;
      const collapsed = isCollapsed(cfg, g.key, g.sub);
      sect.classList.toggle('is-collapsed', collapsed);
      if (!collapsed && directChild(sect, 'kbw-cards') == null) {
        sect.appendChild(this.buildCards(g, sec));
      }
      const head = directChild(sect, 'kbw-sect-head');
      if (!head) continue;
      if (renaming === g.sectionId && !g.sub) {
        const caret = head.querySelector<HTMLElement>('.kbw-sect-caret');
        if (caret) {
          caret.classList.toggle('is-open', !collapsed);
          caret.setAttribute('aria-label', collapsed ? '展开' : '收起');
          // 图标是两枚不同的 SVG（右/下）→ 只切 class 会留下"朝向说谎"的三角
          caret.textContent = '';
          caret.appendChild(icon(collapsed ? 'chevron-right' : 'chevron-down', 15));
        }
      } else {
        head.replaceWith(this.renderSectionHead(g, sec, collapsed));
        // 换头会铲掉挂在头上的预告；把签名清掉，让下一次 paintDrag 老老实实重画一遍
        this.lastDragPaint = '';
      }
    }
    /**
     * ⚠️ **补一遍状态类**（c 期独立审查 🟡3）：上面那次 `buildCards` 只会建卡片（数据 + 正文），
     * 而选择态 / 光标 / 「编辑中」这些标记是 `paintStates` **事后贴**的 ——
     * 不补的话，**就地展开一个收起的板块**时，里面每张卡都光秃秃的：
     * `Ctrl+A` 明明把它们算进「已选 N 篇」（`cardOrder()` 含收起板块，那是有意为之），
     * 屏幕上却一张都看不出被选中 → 点迁移**真会连它们一起搬**，用户完全没预期。
     * 只贴 class、不重建 DOM，代价可忽略。
     */
    this.paintStates(this.store.get());
  }

  private cardCallbacks(): CardCallbacks {
    return {
      onClick: (e, evt, absLine) => this.onCardClick(e, evt, absLine),
      onDoubleClick: (e, evt) => this.onCardDoubleClick(e, evt),
      onContextMenu: (e, evt) => this.noteMenu(e, evt),
      onOpenTab: (e) => this.ops.open(e, 'newTab'),
      onPointerDown: (e, evt) => this.onCardPointerDown(e, evt),
      onToggleTask: (e, _i, checked, absLine) => void this.toggleTask(e, absLine, checked),
      onExpand: (e, expanded) => this.setExpanded(e, expanded),
      onRenameCommit: (e, commit, value) => this.finishNoteRename(e, commit, value),
      onSplit: (p, ratio, commit, global) => this.applySplit(p, ratio, commit, global),
      /**
       * 选择模式下那颗 ⋯（触屏的单篇菜单入口）。
       * **走桌面右键那条完全相同的实现**（`noteMenu` → `showNoteMenu`）——
       * §4.2 表里「单篇设置」两列写的就是同一个菜单的两种入口方式，别在这儿另起一份。
       */
      onMore: (e, evt) => this.noteMenu(e, evt),
    };
  }

  /**
   * 「两者」档拖了属性/正文的分隔条（用户 2026-09-25 要的）。
   *
   * 三段：
   *  ① **拖动中**（`commit=false`）：只改所有卡片上的 `--kbw-props-pct`，界面立刻跟手；
   *  ② **松手**（`commit=true`）：写 `view.propsRatio`；
   *  ③ **双击/`ratio=null`**：恢复"自动"（把比例清成 null）。
   *
   * ⚠️ **第一次拖动要把卡片锁成固定高度**：比例是百分比，卡片高度自动时 `flex-basis: %`
   * 会退化成 auto、拖了等于没拖。基准取 `autoHeightBase()`（当前最高那张）——
   * 与 `Ctrl+滚轮` 那条完全同一套理由与同一个函数。
   */
  private applySplit(path: string, ratio: number | null, commit: boolean, global: boolean): void {
    const all = Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-card'));
    /** Alt+拖 = 全局默认 → 所有卡一起预览；否则只改这一条 */
    const targets = global ? all : all.filter((c) => c.dataset.path === path);
    for (const c of targets) {
      if (ratio == null) {
        c.classList.remove('is-split');
        c.style.removeProperty('--kbw-props-pct');
      } else {
        c.classList.add('is-split');
        c.style.setProperty('--kbw-props-pct', `${Math.round(ratio * 100)}%`);
      }
    }
    if (!commit) return;
    const cfg = this.cfg.get();
    const patch: {
      propsRatio?: number | null;
      propsRatioByPath?: Record<string, number>;
      cardHeight?: number;
    } = {};
    if (global) {
      patch.propsRatio = ratio;
    } else {
      const next = { ...(cfg.view.propsRatioByPath ?? {}) };
      if (ratio == null) delete next[path];
      else next[path] = ratio;
      patch.propsRatioByPath = next;
    }
    /**
     * ⚠️ **第一次拖动要把卡片锁成固定高度**：比例是百分比，卡片高度自动时
     * `flex-basis: %` 会退化成 auto、拖了等于没拖。基准取 `autoHeightBase()`（当前最高那张）——
     * 与 `Ctrl+滚轮` 那条同一套理由与同一个函数。
     */
    if (ratio != null && cfg.view.cardHeight <= 0) {
      const base = this.autoHeightBase();
      if (base > 0) patch.cardHeight = base;
    }
    const where = global ? '全部笔记的默认' : '这一条';
    void this.setView(
      patch,
      ratio == null ? `${where}：属性/正文按内容自动` : `${where}：属性占 ${Math.round(ratio * 100)}%`,
    );
  }


  private setExpanded(e: NoteEntry, expanded: boolean): void {
    const cur = this.store.get().expanded;
    const next = expanded ? Array.from(new Set([...cur, e.path])) : cur.filter((p) => p !== e.path);
    // 就地改 class（不重画整块 —— 重画会丢滚动位置，与笔记模块同一条理由）
    for (const card of this.cardElements()) {
      if (card.dataset.path !== e.path) continue;
      card.querySelector('.kbw-card-body')?.classList.toggle('is-open', expanded);
      const more = card.querySelector<HTMLElement>('.kbw-card-more');
      if (more) {
        more.classList.toggle('is-open', expanded);
        // 文字与箭头一起换（只改文字的话箭头会被 textContent 抹掉）
        more.textContent = expanded ? '收起' : '展开';
        more.appendChild(icon(expanded ? 'chevron-up' : 'chevron-down', 13));
      }
    }
    this.store.set({ expanded: next });
  }

  private cardElements(): HTMLElement[] {
    return Array.from(this.bodyHost.querySelectorAll<HTMLElement>('[data-card]'));
  }

  /** 拖动掠过高亮 + 键盘光标 + 多选（都是就地改 class） */
  private paintStates(s: BoardState): void {
    this.paintDrag(s);
    /**
     * ⚠️ 选择集可能上百条（`Ctrl+A` 一把全选）→ 先转 `Set`：
     * 每张卡都 `selected.includes(p)` 的话是 O(卡片数 × 选择数)，全选时就是平方级。
     */
    const sel = new Set(s.selected);
    /**
     * ⚠️ 这里**不许**再算 `this.groups()` 那种全量重算（c 期独立审查 🟢14）：
     * 原先顶上有一句 `const order = this.groups().flatMap(…)`，算完只被 `void` 掉 ——
     * 而 `planBoard` 是全库分组（含每篇的 `tagsOf` → `metadataCache`），
     * 这个函数**每按一次方向键、每点一下卡片**都要跑。
     */
    for (const c of this.cardElements()) {
      const p = c.dataset.path ?? '';
      c.classList.toggle('is-cursor', s.cursor === p);
      // 悬浮小窗正在编辑的那张（a.5-3）：滚看板时小窗不跟着走，靠这个标记告诉用户"是哪张"
      c.classList.toggle('is-editing-source', s.editingPaths.includes(p));
      // 多选（c 期）：与 `.is-cursor`（键盘光标）是**两件事**，可以同时贴在两张不同的卡上
      c.classList.toggle('is-selected', sel.has(p));
      /**
       * 触屏选择模式（段⑤）：每张卡左上角那颗 **⋯** 只在它开着时显形
       *（`styles/board.css` 认这个类）。**就地改 class、不进渲染 key** ——
       * 进 key 的话进出模式要重画整块看板，滚动位置会丢（网格那条同一理由）。
       */
      c.classList.toggle('is-selectmode', s.selectMode);
    }
  }

  /**
   * 拖动中的三样反馈（P4.5 §1.1，全是就地改 / 就地插，**不重绘**）：
   *  ① 目标板块高亮（老行为）
   *  ② **拖动源半透明占位** —— 一眼看出"从哪儿拿起来的"（不 `display:none`：位置不能凭空消失）
   *  ③ **插入位指示线** + 板块头的「N → M」预告 —— 松手前就知道会落在第几张
   *     （预告那份文案与 `交互规格 §3.1` 目录树拖拽是同一套：「现在几篇 → 放下之后几篇」）
   */
  private paintDrag(s: BoardState): void {
    const on = s.dragKey != null;
    for (const el2 of Array.from(this.bodyHost.querySelectorAll<HTMLElement>('[data-drop]'))) {
      el2.classList.toggle('is-drop', on && el2.dataset.drop === s.dragKey);
    }
    /** 整组拖动时**每一张**都要半透明（只标起手那张会像"别的掉队了"） */
    const dragging = new Set(s.dragPaths);
    for (const c of this.cardElements()) {
      c.classList.toggle('is-dragging', on && dragging.has(c.dataset.path ?? ''));
    }
    /**
     * ⚠️ 指示线与预告**只在落点真的变了时才重建**：
     * 这个函数还会被"光标动了"这类无关重绘调到（`paintStates` 一进来就调它），
     * 每调一次就删了重建，指示线上那 120ms 的入场动画会跟着重放 —— 真机上看着是"一闪"。
     * 用 key|index 当签名，没变就原地不动。
     */
    /** 拖动中一路应该有一条指示线；不在拖动时应该一条都没有 —— 这个"该不该在"也要进判据 */
    const sig = `${s.dragKey ?? ''}|${s.dragIndex}`;
    const painted = this.bodyHost.querySelector('.kbw-dropline') != null;
    if (sig === this.lastDragPaint && painted === on) return;
    this.lastDragPaint = sig;

    // 先收掉上一次画的（指示线 + 预告都在这个函数里重画，别的地方不许动它们）
    for (const old of Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-dropline'))) {
      old.remove();
    }
    for (const old of Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-sect-preview'))) {
      old.remove();
    }
    if (!on) return;

    const holder = this.dropHolder(s.dragKey);
    if (holder && s.dragIndex >= 0) {
      /**
       * ⚠️ 卡片表必须**排除正在拖的那张**（与 `hitTest` 同一个 `dropCards`）——
       * 各写一份的话，同板块内往前拖会差一格：线画在 C 前、落点在 C 后（独立审查抓到）。
       */
      const cards = dropCards(holder, s.dragPaths);
      const line = div({ cls: 'kbw-dropline' });
      const at = cards[s.dragIndex];
      if (at) holder.insertBefore(line, at);
      else holder.appendChild(line);
    }

    /**
     * 「N → M」只在**跨板块**时出现：同板块拖动只是排序，篇数不会变 ——
     * 那时候报一个"3 → 3"纯属噪音（指示线已经把话说清楚了）。
     */
    if (s.dragKey === s.dragFrom) return;
    const g = this.groups().find((x) => x.key === s.dragKey);
    const sect = Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-sect')).find(
      (x) => x.dataset.key === s.dragKey,
    );
    const head = sect ? directChild(sect, 'kbw-sect-head') : null;
    if (!g || !head) return;
    head.appendChild(
      span({
        cls: 'kbw-sect-preview',
        /**
         * ⚠️ 加的是**这一拖带着的张数**（`s.dragCount`），不是写死的 1 ——
         * c 期起一次能拖一组，`+1` 会让"拖 3 张"预告成"4 → 5"（真机上量到过）。
         * `Math.max(1, …)`：`dragCount` 在起手那一帧可能还是 0（还没报过）。
         */
        text: `${g.total} → ${g.total + Math.max(1, s.dragCount)}`,
        attr: { title: '放下之后这一块会有几篇' },
      }),
    );
  }

  /** 某个板块 key 的卡片区（收起的板块没有卡片区 → 返回 null） */
  private dropHolder(key: string | null): HTMLElement | null {
    if (!key) return null;
    for (const el2 of Array.from(this.bodyHost.querySelectorAll<HTMLElement>('.kbw-cards'))) {
      if (el2.dataset.drop === key) return el2;
    }
    return null;
  }

  // ── 卡片交互 ─────────────────────────────────────────────────
  /**
   * 单击卡片（P4.5 c 期 §3.5 把「Ctrl+单击」那条预留兑现了）。
   *
   * | 修饰键 | 做什么 |
   * |---|---|
   * | 无 | **开悬浮小窗** + **清空选择** |
   * | `Ctrl/Cmd` | 切一张（加选 / 减选），**不开窗** |
   * | `Shift` | 从锚点起取一段 |
   * | `Ctrl/Cmd+Shift` | 取并集 |
   *
   * ⚠️ **无修饰键时清空选择**是用户 2026-09-25 拍板的（Windows 资源管理器惯例）：
   * 卡片单击是"开窗"这个主路径，如果背后还挂着上一次的选择，很容易
   * "以为在处理新点开的那张、其实批量操作作用在旧选择上"。代价是
   * "选好一批 → 随手开一张看看 → 回来" 得重选，换的是不会误操作。
   */
  private onCardClick(e: NoteEntry, evt: MouseEvent, absLine: number | null = null): void {
    const s = this.store.get();
    /**
     * **触屏选择模式下点一下 = 加选/减选**（不是开窗、也不是"只选它"）——
     * 这就是 §4.2「长按不动 → 进选择模式」之后的那一步：逐个点。
     * 与网格档 `onGridClick` 里那段**同一个口径**。放在最前面：选择模式是"姿态"，
     * 它优先于桌面那套"单击开窗 / 无修饰键清空选择"。
     */
    if (s.selectMode) {
      this.store.set({
        selected: toggleSelected(s.selected, e.path),
        cursor: e.path,
        anchor: e.path,
      });
      return;
    }
    if (hasMod(evt) || evt.shiftKey) {
      const selected = evt.shiftKey
        ? rangeSelected(this.cardOrder(), s.selected, s.anchor, e.path, hasMod(evt))
        : toggleSelected(s.selected, e.path);
      this.store.set({ selected, anchor: e.path, cursor: e.path });
      return;
    }
    if (s.selected.length > 0) this.store.set({ selected: [], anchor: null });
    this.openCard(e, absLine);
  }

  /**
   * **双击 = 升格成标签页**（P6 段⑥ ⑤，2026-09-28 拍板）。
   *
   * 时序：第二下的 `click` 已经先走完 `onCardClick`（那一篇的小窗早开着，所以只是
   * 「抬到最前 + 闪一下」），`dblclick` 才到这儿 → 把它抬进平台标签页。
   * ⇒ 用户看到的是"小窗闪了一下、然后长腿走了"。**这是"不延迟单击"的必然代价**
   *（延迟判定正是旧决策否掉的那条路），已写进 `交互规格.md` 当**已知行为**，别当 bug 修。
   *
   * 四条边界：
   *  · **触屏不参与**（触屏单击=开窗、长按=菜单）—— 判据用 `isTouchPointer`（**与其它手势同源**）：
   *    `dblclick` 是 MouseEvent、没有 `pointerType`，于是走它的回落分支 `body.is-mobile`；
   *    而双击那两下在触屏上本来就是"双击缩放"的地盘。
   *  · **选择模式 / 带修饰键**不升格：那些点击的语义是**选择**，不是"打开这一篇"
   *   （与 `onCardClick` 里那两段的优先级**同一个顺序**，别在这里另判一套）。
   *  · **只读模式**不动作（与 `openCard` 同口径）。
   *  · 拖动刚结束不接（`cards.ts` 里已经用 `wasDraggingRecently()` 挡过一道）。
   */
  private onCardDoubleClick(e: NoteEntry, evt: MouseEvent): void {
    if (isTouchPointer(evt)) return;
    const s = this.store.get();
    if (s.selectMode || hasMod(evt) || evt.shiftKey) return;
    if (this.cfg.get().view.readonly) {
      notify({
        kind: 'info',
        text: '只读模式开着',
        detail: '在空白处右键 → 更多显示 → 只读模式，即可就地编辑',
        ms: NOTIFY_MS.info,
      });
      return;
    }
    /**
     * ⚠️ **升格之后要重报一次"编辑中"名单**：`panelPaths()` 里刚少了一篇
     * （那张卡片上的虚线「编辑中」描边得跟着摘掉）。第二下 `click` 报过一次的是
     * **还没升格**的名单，不能省这一句。
     */
    void promoteToTab(e, this.panelDeps(), { quiet: true }).then(() => this.mirrorEditing(panelPaths()));
  }

  /**
   * 卡片在**当前显示顺序**里的路径（扁平的、跨板块）。
   * 与键盘光标（`moveCursor` / `onRawKey` 里的那个 `flat`）**同一个口径** ——
   * 范围选和「光标走到下一张」必须对同一套顺序，不然两个功能会各说各话。
   */
  private cardOrder(): string[] {
    return this.groups().flatMap((g) => g.notes.map((n) => n.path));
  }

  /** @param gotoLine 单击落点对应的源文件行号（a.5-5）—— 算不出来就是 null */
  private openCard(e: NoteEntry, gotoLine: number | null = null): void {
    if (this.cfg.get().view.readonly) {
      notify({
        kind: 'info',
        text: '只读模式开着',
        detail: '在空白处右键 → 更多显示 → 只读模式，即可就地编辑',
        ms: NOTIFY_MS.info,
      });
      return;
    }
    /**
     * ⚠️ **这里不再"顺手把 Peek 收掉"**（e 期独立审查抓出来的那一轮）：
     * 占窗格的顺序由**口子的占用者身份**决定（`ui/dock.ts` 的 `DockOwner`）——
     * 面板要停靠时会申请窗格，那个申请让 `owner` 变成 `panel`，Peek 收到通知**自己让位**；
     * 而浮层态的面板根本不申请窗格，两者可以同时在（用户随手点一张卡看看，预览不该消失）。
     * 在这儿顺手收一下，看着像"互斥"，实际是把"谁占着"这件事**在第三处又判了一遍** ——
     * 判据一多就会与口子里的真源漂（审查实测：`dock` 改成停靠那一条路完全绕过这里）。
     */
    /**
     * **一文件一扇窗**（P6b ③，用户 2026-09-27 原话："看板界面点击文件则跳出一个悬浮窗口，
     * 再点一个文件再跳出一个；点到相同文件强调一下已打开的窗口"）。
     *
     * 🔴 这**推翻了 f 期**的"单击进最近交互那扇 + 加一个 tab"（原话："保留多篇分页 +
     * 单击进最近交互的那个窗"）。现行口径：
     *  · 未开 → **新开一扇窗**（`openCardWindow`）；
     *  · 已开 → **抬到最前 + 闪一下**（不新开、不加 tab）；
     *  · 想并在一起：把一扇窗的头拖到另一扇身上（合并），或把 tab 拖进目标窗。
     * `quiet: true` = 单击这条主路径不弹回执（闪一下就是反馈）。
     */
    openCardWindow(e, this.panelDeps(), { line: gotoLine }, { quiet: true });
    this.mirrorEditing(panelPaths());
  }

  /**
   * **交给面板的依赖束**（`mount` 与"点卡片开一篇"两处共用）。
   *
   * ⚠️ 抽出来是 d2 的要求：切模块回来时，模块得**重新把依赖交给面板**
   * （`rebindCardPanel`，见 `editor.ts` 里那段"订阅挂在旧 store 上"的说明）。
   * 两处各拼一份的话迟早会漂，而漏一个字段（比如 `onTabsChanged`）是**静默失效**。
   */
  private panelDeps(): CardWindowCtx {
    return {
      ctx: this.ctx,
      cfg: this.cfg,
      refresh: () => this.repaint(),
      onReceipt: (text) => this.setReceipt(text),
      onTabsChanged: (paths) => this.mirrorEditing(paths),
      /**
       * P7.15 · #3：小窗属性区的「文件位置」目录选择器要那条**唯一**的搬动链；
       * P7.16 · #2b 补齐"就住这儿"（写声明、不搬）——两条都转发到 `modules/notes/ops.ts`。
       */
      ops: {
        setPositionByMove: (entries, dir, reason) => this.ops.setPositionByMove(entries, dir, reason),
        declarePositionHere: (entries) => this.ops.declarePositionHere(entries),
      },
    };
  }

  /**
   * **交给预览窗格的依赖束**（e 期 §3.2）。与 `panelDeps` 同一条理由：抽出来，
   * 免得几处各拼一份、漏一个字段是**静默失效**。
   */
  private peekDeps(): PeekDeps {
    return {
      ctx: this.ctx,
      cfg: this.cfg,
      /**
       * 互斥的那一半：Peek 要窗格 → 把**占着窗格的那个**面板收掉。
       * ⚠️ **只收"停靠着"的那个**（浮层态的面板不占窗格，见 `openCard` 里那段说明）——
       * 不问一句就收的话，"预览开着 → 随手点一张卡看看"会被自己刚开的窗格反手关掉。
       */
      onNeedWindow: () => {
        /**
         * ⚠️ 判据是**面板打算占着窗格吗**（配置说了停靠 + 它开着），不是"此刻占着" ——
         * 后者会在"它刚被挤掉那一瞬"为假，于是**没人收它**，它随后又自己把窗格抢回去
         *（离线实测：预览开起来、转过身就被关掉）。见 `panelClaimsWindow` 的注释。
         *
         * ⚠️ f 期多窗之后**只收"认领窗格的那一扇"**（`closeDockingPanel`）：
         * 拿 `closeCardPanel`（收全部）会把用户随手开着的浮层小窗一起收掉 ——
         * 那些窗根本不占窗格、与预览不冲突。
         */
        if (panelClaimsWindow()) closeDockingPanel('peek-takes-window');
      },
      onReceipt: (text) => this.setReceipt(text),
    };
  }

  /** 光标指的那一篇（预览窗格、探针都用它）——查不到就是 null（文件被删了 / 路径失效） */
  private cursorEntry(): NoteEntry | null {
    const p = this.store.get().cursor;
    return p ? this.ctx.index.get(p) ?? null : null;
  }

  /**
   * 打「编辑中」标记（a.5-3）——**面板报什么，这里镜像什么**。
   *
   * ⚠️ **d 期起由面板反过来告诉我们**（`onTabsChanged`），不再"开一篇设一篇"：
   * panel 是**跨模块存活**的，切走再切回来时模块是新的、面板还是老的 ——
   * 靠模块自己攒的话，"切回来标记全没了"（而面板里明明还开着三篇）。
   * 所以：真源在面板，模块只是个**镜像**；`mount()` 里还要回读一次。
   */
  private mirrorEditing(paths: string[]): void {
    /**
     * ⚠️ **内容一样就别 set**：`editingPaths` 一变下游就 `paintStates()`（扫一遍所有卡片），
     * 而面板那边每次重画 tab 条都会报一次全新的数组 —— 不挡的话每开/切一次 tab
     * 都白扫一遍。判据用**逐项比较**，不是比引用（比引用的话新数组永远是"变了"）。
     */
    const prev = this.store.get().editingPaths;
    if (prev.length === paths.length && prev.every((p, i) => p === paths[i])) return;
    this.store.set({ editingPaths: paths });
  }

  private noteMenu(e: NoteEntry, evt: MouseEvent): void {
    /**
     * **右键未选中的卡片 → 先把它选上**（Windows 手感；「全部笔记」那边 `onRowMenu` 同一条）。
     * ⚠️ 已经选中时就**别动选择** —— 右键是那批选择里的成员，把选择缩成一张
     * 等于"顺手把用户刚选好的一批弄没了"。
     */
    const s = this.store.get();
    if (!s.selected.includes(e.path)) {
      this.store.set({ selected: [e.path], anchor: e.path, cursor: e.path });
    }
    // 复用 P1 那份笔记菜单（§8.3）——三套菜单里只有这一套不必重写
    showNoteMenu(e, evt, {
      ctx: this.ctx,
      ops: this.ops,
      onRename: (entry) => this.startNoteRename(entry),
      // 看板这边不开目录菜单 —— 三条"树"回调只是 MenuCtx 的形状要求（P7.23 加了两条）
      onExpandOne: () => undefined,
      onExpandAll: () => undefined,
      onCollapse: () => undefined,
      board: this.boardMenuHooks(e),
      /**
       * **「在新悬浮窗中打开」**（f 期 §6.17 多悬浮窗的入口）：只有看板给得了这个钩子 ——
       * 小窗是看板的东西（它挂的是看板的配置与「编辑中」标记），「全部笔记」那边没有它。
       * 与"单击卡片"的区别：那个落到**最近交互的那扇窗**（可能加个 tab），
       * 这个**另开一扇**（用户明确要"再开一个窗"）；同一篇已经开着时**跳过去**，
       * 绝不为了"新窗"破例开第二个编辑器（口径 ②：同一 path 只许一个活叶）。
       */
      openFloating: (entry) => openCardWindow(entry, this.panelDeps()),
      /**
       * **拖窗合并的非拖动等价物**（P6b ③ / WCAG 2.2 Dragging Movements）：
       * 「并入别的窗…」列出**除它自己那一扇之外**的窗（篇数 + 首篇名字）。
       * 一处不满足就不给这一行：窗只有一扇 / 这一篇根本不在窗里。
       */
      mergeChoices: (entry) => {
        const mine = panelOfPath(entry.path);
        const others = mergeChoices(mine);
        if (mine == null || others.length === 0) return [];
        return others.map((c) => ({
          label: c.label,
          run: () => {
            if (mergeWindowInto(mine, c.id)) this.mirrorEditing(panelPaths());
          },
        }));
      },
    });
  }

  /**
   * 卡片菜单里那一组「上移 / 下移 / 移到别的板块」（P4.5 §4.2）。
   * 这是 WCAG 2.2「Dragging Movements」要的**非拖拽等价操作** —— 拖拽本身在只读模式下是关的，
   * 所以这一组在只读时也一起置灰（判据与 `onCardPointerDown` 那条守卫同源）。
   */
  private boardMenuHooks(e: NoteEntry): BoardMenuHooks {
    const groups = this.groups();
    const mine = groups.find((g) => g.notes.some((n) => n.path === e.path));
    const readonly = this.cfg.get().view.readonly;
    return {
      sortBlock: readonly ? '只读模式开着（拖动也关着）' : undefined,
      onMoveUp: () => void this.moveCursorCard(e, -1),
      onMoveDown: () => void this.moveCursorCard(e, 1),
      targets: () =>
        groups
          .filter((g) => g.key !== mine?.key)
          .map((g) => {
            const sec = this.cfg.get().sections.find((s) => s.id === g.sectionId);
            const label = g.sub ? `${sec?.name ?? ''} / ${g.title}` : g.title;
            if (readonly) return { key: g.key, label, disabled: '只读模式开着（拖动也关着）' };
            if (sec?.kind === 'shelter') {
              return { key: g.key, label, disabled: '「收容所」不是能放进去的板块' };
            }
            return { key: g.key, label };
          }),
      onMoveTo: (key) => {
        if (!mine) return;
        void moveCardToGroup(this.dragDeps(e, mine.key), key);
      },
      onSortInto: (key) => {
        if (!mine) return;
        void moveCardToGroup(this.dragDeps(e, mine.key), key, { sortOnly: true });
      },
    };
  }

  /**
   * 拖拽与菜单共用的那半套依赖（见 `drag.ts` 的 `CardMoveDeps`）。
   * `entries` 只有**拖拽那条路**会传（c 期的整组拖动）；菜单里的「移到…/排到…」
   * 作用的就是点中的那一篇，不传 = 单张。
   */
  private dragDeps(e: NoteEntry, fromKey: string, entries?: NoteEntry[]): CardMoveDeps {
    return {
      ctx: this.ctx,
      store: this.cfg,
      entry: e,
      entries,
      fromKey,
      groups: () => this.groups(),
      findHolder: (key) => this.dropHolder(key),
      // 同步回一个"变了没"给拖拽那条路（它据此决定发哪条通知）—— 判据与 applyOrder 同源
      onOrderChanged: (key, order) => {
        if (this.orderUnchanged(key, order)) return false;
        void this.applyOrder(key, order);
        return true;
      },
      onError: (msg) => notify({ kind: 'error', text: msg, ms: NOTIFY_MS.long }),
      refresh: () => this.repaint(),
    };
  }

  /**
   * 手动顺序落下去。
   * ⚠️ **顺序表只在「手动」档生效** → 顺手把这一块的排序切到手动（和拖拽那条路同一条：
   * `drop` 在同板块分支里也这么做）。忘了这一步的症状是"点了上移，什么都没发生"。
   *
   * ⚠️ **两次改动要一次写完**：先写 `sections`（切手动）、再写 `manualOrder` 的话，
   * 中间那一次落盘会让看板在"手动档 + 旧顺序"下重画一次 —— 界面上是卡片先乱跳一下再归位。
   * `save()` 是深合并，两个字段一起递进去就只有一次重画。
   */
  /**
   * **这一串顺序跟现在渲染的一模一样吗**（a.5-1 的第二半）。
   *
   * 为什么要它：用户把卡片拖出去又拖回原处松手时，算出来的顺序与现状完全相同 ——
   * 那就**什么都不该发生**。早先照写不误，症状是"我什么都没改，这一块的排序却变成手动了"
   * （顺序表只在手动档生效，切档那一刻整块会按旧表重排 → 看着像"卡片跳了一下"）。
   * 拖拽那条路要**同步**拿这个结论（决定发哪条通知），所以单独抽一个同步函数。
   */
  private orderUnchanged(key: string, order: string[]): boolean {
    const g = this.groups().find((x) => x.key === key);
    return g != null && order.join('\n') === g.notes.map((n) => n.path).join('\n');
  }

  /** @returns 有没有真的写（调用方据此决定发不发"已排序"那类通知） */
  private async applyOrder(key: string, order: string[]): Promise<boolean> {
    const cfg = this.cfg.get();
    const g = this.groups().find((x) => x.key === key);
    if (this.orderUnchanged(key, order)) return false;
    const sec = g ? cfg.sections.find((s) => s.id === g.sectionId) : null;
    /**
     * ⚠️ **写顺序表要写"这块命中的全集"**（独立审查 🟡1）：`g.notes` 已被「显示上限」与
     * 「隐藏」截过一刀，只写那几条的话，**没显示的那些会被从手动顺序里挤掉** ——
     * `sortNotes` 对不在表里的条目按名称排到**末尾**，用户一放开上限/取消隐藏就会看到
     * "那几篇跳到末尾了"（"跳走"的另一种）。所以补齐：按**上一版表里的相对次序**接在后面
     *（不在旧表里的按命中次序），既保住它们的位置，也不至于把它们丢掉。
     */
    const full: string[] = (() => {
      if (!g) return order;
      const inOrder = new Set(order);
      const rest = g.matched.filter((p) => !inOrder.has(p));
      if (rest.length === 0) return order;
      const prev = cfg.view.manualOrder[key] ?? [];
      const ranked = [...prev.filter((p) => rest.includes(p)), ...rest.filter((p) => !prev.includes(p))];
      return [...order, ...ranked];
    })();
    const nextOrder = { ...cfg.view.manualOrder, [key]: full };
    const needSort = sec != null && sec.sort?.key !== '手动';
    await this.cfg.patchView(
      { manualOrder: nextOrder },
      needSort
        ? { sections: cfg.sections.map((s) => (s.id === sec.id ? { ...s, sort: { key: '手动', dir: 'asc' } } : s)) }
        : {},
    );
    this.pendingOrder = nextOrder;
    this.saveSoon();
    this.store.set({ cfgRev: this.store.get().cfgRev + 1 });
    return true;
  }

  /** 「上移一位 / 下移一位」：在**这一块里**换一格（写顺序表，不动文件） */
  private async moveCursorCard(e: NoteEntry, dir: -1 | 1): Promise<void> {
    const g = this.groups().find((x) => x.notes.some((n) => n.path === e.path));
    if (!g) return;
    const at = g.notes.findIndex((n) => n.path === e.path);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= g.notes.length) {
      this.setReceipt(dir < 0 ? '已经是第一张了' : '已经是最后一张了');
      return;
    }
    /**
     * ⚠️ 用 `withInserted`（拖拽那条路用的同一个函数）而不是自己 swap：
     * 它的语义是"先把自己摘掉、再插到第 N 位"，与拖拽落点是**同一个口径**
     * （独立审查建议：同一契约别留第二套实现，本期已经从两处漏过同类）。
     */
    await this.applyOrder(g.key, withInserted(g.notes, e, to));
    this.store.set({ cursor: e.path });
    this.setReceipt(`${dir < 0 ? '上移' : '下移'}一位：${e.basename}`);
    this.scrollTo(e.path);
  }

  private onCardPointerDown(e: NoteEntry, evt: PointerEvent): void {
    /**
     * 🔴 **只读模式只挡"拖"，不挡整条手势**（P6⑤ 独立审查 A3）：
     * 原先这里是一句 `if (readonly) return`，把**触屏的长按双模式**一起挡了 ——
     * 而触屏上「选择模式 → 点 ⋯」是**单篇菜单唯一的入口**（§4.2），
     * 挡掉之后重命名 / 位置锁定 / 在新窗口打开在只读下全都够不着；
     * 而"在新标签页 / 新悬浮窗打开"这类动作在只读下本来就该可用（§8.1 只禁**改**）。
     * 现在：只读 + 触屏 = 还能进选择模式，但**拖动作废**（`onHoldToDrag` 返回 false，
     * `drag.ts` 会放弃整条手势：不建药丸、不落点、松手什么都不写 —— 只读下不许有写盘动作）。
     */
    const readonly = this.cfg.get().view.readonly;
    const touch = isTouchPointer(evt);
    if (readonly && !touch) return;
    if (evt.button !== 0) return;
    const holder = (evt.target as HTMLElement | null)?.closest?.('[data-drop]') as HTMLElement | null;
    const fromKey = holder?.dataset.drop;
    if (!fromKey) return;
    /**
     * **这一拖搬的是哪一组**（c 期 §3.5）：按住的这张本来就在选择里 → 整组一起搬；
     * 否则只搬它自己（Windows / 资源管理器的口径，见 `select.ts` 的 `dragSet`）。
     * 路径要现解析成条目 —— 选中集里可能有已经被删/被移走的路径。
     */
    const byPath = new Map(this.groups().flatMap((g) => g.notes).map((n) => [n.path, n]));
    const picked = dragSet(this.cardOrder(), this.store.get().selected, e.path)
      .map((p) => byPath.get(p))
      .filter((x): x is NoteEntry => x != null);
    const group = picked.length > 0 ? picked : [e];
    this.store.set({ cursor: e.path });
    /**
     * **触屏长按双模式**（段⑤ 收的欠账）：长按成立时**先当"要进选择模式"**，
     * 真的移动了（> `TOUCH_TOLERANCE`）再改判成拖动 —— 与 `modules/notes/grid.ts`
     * 的 `onCellPointerDown` 是**同一套**（同一组常数、同一个中间态、同一条容差）。
     *
     * 为什么非要这个中间态：触屏上"按住不动"与"按住再拖"在**前 400ms 长得一模一样**，
     * 只有等长按成立了才知道用户要哪个；而一旦他在长按之后还继续移动，
     * 那显然是要拖（§4.2 表下那条"位移容差 ≤10px 内视为没动"）。
     */
    let enteredSelect = false;
    this.stopDrag?.();
    this.stopDrag = startCardDrag({
      ...this.dragDeps(e, fromKey, group),
      down: evt,
      onDragState: (key, count, index) =>
        this.store.set({
          dragKey: key,
          dragCount: count,
          dragIndex: index,
          dragFrom: key == null ? null : fromKey,
          dragPaths: key == null ? [] : group.map((x) => x.path),
        }),
      /**
       * ① 长按 400ms 成立（还没决定是选择还是拖动）→ 先按"选择模式"接管：
       * 进模式 + 给即时反馈（那张卡并进选择）。返回 true 让 `drag.ts` 先别画拖动视觉。
       */
      onHoldStart: () => {
        if (!this.store.get().selectMode) {
          enteredSelect = true;
          this.setSelectMode(true);
        }
        /**
         * 长按那一张**并进选择**（并集语义：已经选中的再长按不该被取消）。
         * 与网格档那条一样，不走 `onCardClick` —— 那在选择模式下是"切一下"（会把它取消掉）。
         */
        const s = this.store.get();
        this.store.set({ selected: Array.from(new Set([...s.selected, e.path])), cursor: e.path });
        return true;
      },
      /** ② 长按之后移动 > 10px → 改判成拖动：把刚才那一下"选择模式"撤回去（§4.2 表下那条容差） */
      onHoldToDrag: () => {
        /**
         * ⚠️ 只读：**返回 false = 这次手势作废**（见 `drag.ts` 那段注释）。
         * 选择模式**留着**（用户还能点 ⋯ 拿菜单），但这一拖不建药丸、不落点、不写盘。
         */
        if (readonly) return false;
        if (enteredSelect) {
          enteredSelect = false;
          this.setSelectMode(false);
        }
        return true;
      },
      /** ③ 长按之后原地松手 = 停在选择模式（什么都不搬）—— 这就是 §4.2 想要的落点 */
      onHoldEnd: () => {
        enteredSelect = false;
      },
    });
  }

  /**
   * 进出触屏选择模式（唯一出口）。
   * 与 `modules/notes/index.ts` 的 `setSelectMode` 同源：类名就地改（`paintStates` 会跟着贴）、
   * Esc 那一层跟着压/弹（`syncEscapeLayer` 按状态整组重建）。
   */
  private setSelectMode(next: boolean): void {
    if (this.store.get().selectMode === next) return;
    this.store.set({ selectMode: next });
  }

  /** 勾选框直写：改的是**文件**，成功之后才动界面（界面不能与文件各说一套） */
  private async toggleTask(e: NoteEntry, absLine: number, checked: boolean): Promise<void> {
    if (this.cfg.get().view.readonly) return;
    const ok = await writeTaskToggle(this.ctx, e, absLine, checked);
    if (!ok) {
      notify({
        kind: 'error',
        text: '这一行没改成',
        detail: `${e.basename} 第 ${absLine + 1} 行已经不是任务行了（可能被别处改过）`,
        ms: NOTIFY_MS.long,
      });
    }
  }

  // ── 板块动作 ─────────────────────────────────────────────────
  private startSectionRename(sectionId: string): void {
    this.store.set({ renaming: sectionId });
    this.renameEsc?.();
    this.renameEsc = pushEscapeLayer(() => {
      this.store.set({ renaming: null });
      this.renameEsc = null;
      return true;
    }, 'board:rename-section');
  }

  private sectionRenameInput(sec: BoardSection): HTMLElement {
    return this.inlineInput(sec.name, (commit, value) => {
      this.renameEsc?.();
      this.renameEsc = null;
      this.store.set({ renaming: null });
      if (commit && value && value !== sec.name) {
        void this.setSection(sec.id, { name: value }, `板块改名：${sec.name} → ${value}`);
      } else {
        this.store.set({ cfgRev: this.store.get().cfgRev + 1 });
      }
    });
  }

  /** 卡片标题就地改名（走 P1 的 `ops.rename`，顺序表的迁移在 mover 那边） */
  private startNoteRename(entry: NoteEntry): void {
    /**
     * ⚠️ **只读守卫放在这里**（独立审查抓到的口子）：`F2`（本期新加的）与卡片菜单的
     * 「重命名…」都会走到这个函数，而整条链原先没有守卫 —— 只读模式下按 F2 改个名回车，
     * **文件真的会被改名写盘**。放在入口这一处，两条口子一起盖住（与
     * `openCard` / `onCardPointerDown` / `toggleTask` 那几处的判据同源）。
     */
    if (this.cfg.get().view.readonly) {
      this.setReceipt('只读模式：改名也停用了（这一条同时管 F2 和菜单）');
      return;
    }
    this.store.set({ renamingNote: entry.path });
    this.renameEsc?.();
    this.renameEsc = pushEscapeLayer(() => {
      this.store.set({ renamingNote: null });
      this.renameEsc = null;
      return true;
    }, 'board:rename-note');
  }

  /** 卡片就地改名的收尾：提交走 mover（快照 + 撞名不覆盖 + 双链同步） */
  private finishNoteRename(entry: NoteEntry, commit: boolean, value: string): void {
    this.renameEsc?.();
    this.renameEsc = null;
    this.store.set({ renamingNote: null });
    if (!commit || !value || value === entry.basename) {
      this.repaint();
      return;
    }
    void this.ctx.mover
      .move({
        targets: [{ newName: value, files: [entry.file] }],
        source: 'board',
        reason: `看板改名：${entry.basename} → ${value}`,
      })
      .then((res) => {
        if (res.moved.length > 0) this.setReceipt(`已改名：${entry.basename} → ${value}`);
        this.repaint();
      });
  }

  private inlineInput(initial: string, done: (commit: boolean, value: string) => void): HTMLElement {
    const input = el('input', {
      cls: 'kbw-inline-input',
      attr: { type: 'text', value: initial, 'aria-label': '新名字' },
    });
    let finished = false;
    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      done(commit, input.value.trim());
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
    window.setTimeout(() => {
      input.focus();
      input.select?.();
    }, 0);
    return input;
  }

  private async setSection(id: string, patch: Partial<BoardSection>, receipt?: string): Promise<void> {
    const sections = this.cfg.get().sections.map((s) => (s.id === id ? { ...s, ...patch } : s));
    await this.cfg.save({ sections });
    this.store.set({ cfgRev: this.store.get().cfgRev + 1 });
    if (receipt) this.setReceipt(receipt);
  }

  private sectionMenu(g: BoardGroup, sec: BoardSection, evt: MouseEvent): void {
    showSectionMenu(
      {
        ctx: this.ctx,
        cfg: this.cfg,
        group: g,
        section: sec,
        refresh: () => this.store.set({ cfgRev: this.store.get().cfgRev + 1 }),
        onRename: () => {
          if (this.store.get().renaming !== g.sectionId) this.startSectionRename(g.sectionId);
        },
        onReceipt: (text) => this.setReceipt(text),
        onOpenPanel: () => this.openPanel(evt.currentTarget as HTMLElement),
        onExpandAll: (open) => this.setSectionCollapsed(sec.id, open),
        onNewNote: () => this.newNoteIn(g, sec),
        onDelete: () => void this.deleteSection(sec),
      },
      evt,
    );
  }

  /** 板块菜单的「展开全部子标题」：只管子板块那一层（顶级板块由工具条的「全部展开」管） */
  private setSectionCollapsed(sectionId: string, open: boolean): void {
    const mine = this.groups().filter((x) => x.sub && x.sectionId === sectionId).map((x) => x.key);
    const cur = this.cfg.get().view.openSubs;
    this.setOpenSubs(open ? Array.from(new Set([...cur, ...mine])) : cur.filter((k) => !mine.includes(k)));
    this.applyCollapseInPlace();
  }

  private async deleteSection(sec: BoardSection): Promise<void> {
    // **只删配置，绝不碰笔记**（§4.1）—— 文案里也写着，别让人以为会删笔记
    await this.cfg.save({ sections: this.cfg.get().sections.filter((s) => s.id !== sec.id) });
    this.store.set({ cfgRev: this.store.get().cfgRev + 1 });
    this.setReceipt(`已删除板块「${sec.name}」（笔记一篇都没动）`);
  }

  /** 板块头「＋」：按板块算落点建空文件（§4.2 的四条规则） */
  private newNoteIn(g: BoardGroup, sec: BoardSection): void {
    void this.newNoteDir(g, sec).then((dirRel) => {
      openNewNoteDialog(this.ctx, dirRel == null ? {} : { dirRel });
    });
  }

  private async newNoteDir(g: BoardGroup, sec: BoardSection): Promise<string | undefined> {
    const kbRoot = this.ctx.settings.kbRoot();
    if (sec.kind === 'folder') {
      const base = sec.value.replace(/^\/+|\/+$/g, '');
      return g.sub ? (base ? `${base}/${g.title}` : g.title) : base;
    }
    if (sec.kind === 'tag') {
      // 查「标签-目录映射」的标签段，**逐级前缀回退**（`a/b` 查不到就试 `a`）；查不到落 00_Inbox
      const { table } = await readRouteTable(this.ctx.app, this.ctx.settings);
      const dirs = tagDirs(table, kbRoot);
      const parts = String(sec.value).split('/');
      for (let i = parts.length; i > 0; i -= 1) {
        const hit = dirs[parts.slice(0, i).join('/')];
        if (hit) return hit;
      }
      return '00_Inbox';
    }
    return undefined;
  }

  private repaint(): void {
    this.lastRev = this.ctx.index.revision;
    /**
     * ⚠️ 推的是 **`paintRev`**（不是 `cfgRev`）：`cfgRev` 的语义已经被"滚动保持"那条判据
     * 借去当"视图参数变了 → 回顶上"了（见 `keepScrollKey` / `paintRev` 的注释）。
     * 这里只是"请重画一次"，配置一个字都没变。
     */
    this.store.set({ rev: this.ctx.index.revision, paintRev: this.store.get().paintRev + 1 });
  }

  // ── 键盘 ─────────────────────────────────────────────────────
  /**
   * 看板的键盘与表格档同源（§1.4）：↑↓←→ 移光标、`Enter` 开悬浮小窗、
   * `Ctrl+Enter` 新标签打开、`Shift+F10` 弹这篇的菜单。
   * ⚠️ 走 `ctx.keys` 路由 —— 别在模块里自己挂 keydown（真实焦点在工作台根元素上）。
   */
  /**
   * **表里没有的键**（P4.5 §4.2 补齐；走 `ctx.keys` 的 raw 通道，见 `core/keymap.ts`）：
   *
   * | 键 | 做什么 |
   * |---|---|
   * | `F2` | 就地改名（与「全部笔记」一致） |
   * | `Ctrl/Cmd+Enter` | 新标签页打开（`open` 已经在开悬浮小窗了，这里给另一条路） |
   * | `[` / `]` | 上一张 / 下一张卡（IDE 手感；方向键被正文滚动占住时也能走） |
   * | `Ctrl/Cmd+↑` / `Ctrl/Cmd+↓` | **在板块之间跳**（落到那一块的第一张卡） |
   *
   * ⚠️ **`Tab` 没按设计稿那样做成"跳板块"**：看板的板块头上有**一排 tabindex=0 的控件**
   * （三角 / 名字 / 计数），把 Tab 抢走 = 键盘用户再也够不到它们（WCAG 2.1.1 直接违反）。
   * 跳板块改用 `Ctrl+↑↓` —— 设计稿那句话实现时按无障碍让路了，理由记在这里。
   */
  private onRawKey(evt: KeyboardEvent): boolean {
    if (isEditable(evt.target)) return false; // 在输入框里打字时不抢
    const flat = this.groups().flatMap((g) => g.notes);
    const s = this.store.get();
    const idx = s.cursor ? flat.findIndex((e) => e.path === s.cursor) : -1;
    const jump = (d: number): boolean => {
      const groups = this.groups().filter((g) => g.notes.length > 0);
      if (groups.length === 0) return true;
      const here = groups.findIndex((g) => g.notes.some((n) => n.path === s.cursor));
      const next = here < 0 ? 0 : (here + d + groups.length) % groups.length;
      this.setReceipt(`板块：${groups[next].title}`);
      this.focusCard(groups[next].notes[0].path);
      return true;
    };

    if (evt.key === 'F2' && idx >= 0) {
      evt.preventDefault();
      this.startNoteRename(flat[idx]);
      return true;
    }
    if (evt.key === 'Enter' && hasMod(evt) && idx >= 0) {
      evt.preventDefault();
      this.ops.open(flat[idx], 'newTab');
      return true;
    }
    if (hasMod(evt) && (evt.key === 'ArrowDown' || evt.key === 'ArrowUp')) {
      evt.preventDefault();
      return jump(evt.key === 'ArrowDown' ? 1 : -1);
    }
    /**
     * `Ctrl/Cmd+A`：**全选**（c 期 §3.5）。
     *
     * 选的是"看板里的全部卡片"（跨板块、含收起板块里的那些）—— 与键盘光标
     *（`[` / `]`）**同一个口径**：`.cardOrder()` 就是这份顺序，光标走到收起的板块会自动展开它，
     * 所以"收起的也算在内"对看板不是怪事。刻意**不做成"只选看得见的"**：
     * 那样范围选（Shift）与全选（Ctrl+A）会拿两套顺序，用户没法预期。
     */
    if (hasMod(evt) && (evt.key === 'a' || evt.key === 'A')) {
      evt.preventDefault();
      const all = flat.map((e) => e.path);
      this.store.set({ selected: all, anchor: all[0] ?? null });
      /**
       * ⚠️ **成功时不设回执**（c 期独立审查 🟡5）：批量栏上的「已选 N 篇」就是同一份信息，
       * 再挂一条回执等于凭空多一层 Esc（回执排在选择**前面**，用户要按两次才清得掉选择）——
       * 而 `startMarquee` 那边正是按"别让用户按两次"来设计的，这条从另一个入口漏了。
       * 唯一要说话的是**一张卡都没有**：那时批量栏根本不出现，不说就成了"按了没反应"。
       */
      if (all.length === 0) this.setReceipt('看板里没有卡片可选');
      return true;
    }
    if (evt.key === '[') {
      evt.preventDefault();
      return this.moveCursor(-1);
    }
    if (evt.key === ']') {
      evt.preventDefault();
      return this.moveCursor(1);
    }
    return false;
  }

  /**
   * 光标上下移（方向键与 `[` `]` 共用一份）。
   * ⚠️ 合并成一份是**独立审查**的建议：原先两处各写一遍 step()，改一处漏一处是迟早的事。
   *
   * `extend` = `Shift+↑/↓`：顺带把**选择**从锚点拉到新光标那（c 期 §3.5 的键盘那条路），
   * 语义与「全部笔记」的 `moveCursor(d, extend)` 一致。`[` `]` 走的是 `extend=false`。
   */
  private moveCursor(d: number, extend = false): boolean {
    const flat = this.groups().flatMap((g) => g.notes);
    if (flat.length === 0) return true;
    const s = this.store.get();
    const idx = s.cursor ? flat.findIndex((e) => e.path === s.cursor) : -1;
    const at = idx < 0 ? (d > 0 ? 0 : flat.length - 1) : Math.min(flat.length - 1, Math.max(0, idx + d));
    if (extend) {
      const order = flat.map((e) => e.path);
      // 锚点还没设过（第一次 Shift+方向键）→ 拿**光标当前那张**当锚点
      const anchor = s.anchor ?? (idx >= 0 ? flat[idx].path : flat[at].path);
      this.store.set({
        selected: rangeSelected(order, s.selected, anchor, flat[at].path, true),
        anchor,
      });
    }
    this.focusCard(flat[at].path);
    return true;
  }

  /**
   * 把光标落到某张卡上：**收起的板块先就地展开**，再贴 class + 滚进视野。
   *
   * ⚠️ 为什么要展开（独立审查抓到）：首屏就收起的块**根本没建卡片区** →
   * `cardElements()` 里没有那些节点 → `.is-cursor` 贴不上、`scrollTo` 空转 →
   * 键盘按下去**完全看不出反应**；就地收起的块也只是给一张 `display:none` 的卡贴了 class。
   * 展开是就地切 class（P4.5 §1.2），不重绘，所以按着走也不卡。
   */
  private focusCard(path: string): void {
    const g = this.groups().find((x) => x.notes.some((n) => n.path === path));
    if (g && isCollapsed(this.cfg.get(), g.key, g.sub)) {
      this.toggleCollapsed(g.key, g.sub);
      this.setReceipt(`展开了「${g.title}」（光标进来了）`);
    }
    this.store.set({ cursor: path });
    this.scrollTo(path);
  }

  private onKey(action: string): boolean {
    const flat = this.groups().flatMap((g) => g.notes);
    const s = this.store.get();
    const idx = s.cursor ? flat.findIndex((e) => e.path === s.cursor) : -1;
    switch (action) {
      case 'move-down':
      case 'move-right':
        return this.moveCursor(1);
      case 'move-up':
      case 'move-left':
        return this.moveCursor(-1);
      case 'open': {
        const cur = flat[idx];
        if (!cur) return false;
        this.openCard(cur);
        return true;
      }
      case 'context-menu': {
        const cur = flat[idx];
        const card = this.cardElements().find((c) => c.dataset.path === cur?.path);
        if (!cur || !card) return false;
        const r = card.getBoundingClientRect();
        this.noteMenu(cur, {
          clientX: r.left + 40,
          clientY: r.top + 8,
          preventDefault() {},
          stopPropagation() {},
        } as unknown as MouseEvent);
        return true;
      }
      case 'focus-search':
        notify({
          kind: 'info',
          text: '看板里没有搜索框',
          detail: '看板是按板块取数的；要搜全库去「全部笔记」',
          ms: NOTIFY_MS.info,
        });
        return true;
      /**
       * **键盘建选择**（c 期 §3.5；独立审查 🟡8 补上）
       * —— `交互规格 §1.4` 里这四个键的作用域本来就写着含「卡片区」，
       * 而 keymap 那条注释还停留在"看板不做多选"（**正是 c 期推翻的那条记债**）。
       *
       * | 键 | 做什么 |
       * |---|---|
       * | `Space` | 切换光标那一张的选中态 |
       * | `Shift+↑/↓` | 从锚点拉到光标（并集） |
       * | `Ctrl+A` | 全选 —— ⚠️ **不在表内接**（见 `onRawKey` 的 raw 通道那条说明） |
       */
      case 'toggle-select': {
        if (idx < 0) return false;
        const path = flat[idx].path;
        this.store.set({ selected: toggleSelected(s.selected, path), anchor: path });
        return true;
      }
      case 'range-down':
        return this.moveCursor(1, true);
      case 'range-up':
        return this.moveCursor(-1, true);
      case 'select-all':
        /**
         * ⚠️ **表内一律不接**（原样留着这条，c 期没改）：`Ctrl+A` 是走
         * `ctx.keys` 的 **raw 通道**进 `onRawKey` 的（`Keymap.handle` 对没绑定的键返回 false、
         * 最后才轮到 `dispatchRaw`）。这里若也接一份，等于同一件事两处实现。
         */
        return false;
      default:
        return false;
    }
  }

  private scrollTo(path: string): void {
    const card = this.cardElements().find((c) => c.dataset.path === path);
    card?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Esc 的最后一层：清掉临时态（拖动高亮 / 回执 / 光标） */
  private syncEscapeLayer(): void {
    const need = (): boolean =>
      this.store.get().dragKey != null ||
      this.store.get().receipt != null ||
      this.store.get().cursor != null ||
      /**
       * 有选择也算"有东西可清"（c 期）。
       * ⚠️ 判据必须与下面回调里的分支**对上**：这里漏一条，Esc 就永远压不上那一层
       *（坑/界面与样式.md 那条「Esc 不走 keymap.bind，只问分层栈」）。
       */
      this.store.get().selected.length > 0 ||
      /**
       * **触屏选择模式**也算一层（段⑤）：它比"清空选择"更外层 —— 一起退掉
       *（停在"有选择、但不在选择模式"这个中间态对用户没有意义，与网格那条同一句话）。
       * ⚠️ 判据必须与下面回调里的分支**对上**，漏一条这一层就永远压不上。
       */
      this.store.get().selectMode ||
      /**
       * **框选中**也要算一份（c 期独立审查 🟡6）：框选改的是 DOM（选框挂在 body 上），
       * 不进 store —— 所以这条只能看句柄。少了它，只要当时有回执/光标/选择（很常见），
       * 全局捕获层的 Esc 就把事件吃掉去清那个东西，基元自己的 Esc 分支**永远收不到**，
       * 框继续跟着鼠标走、松手照样改选择。
       */
      this.stopMarquee != null;
    if (need() && !this.escPop) {
      this.escPop = pushEscapeLayer(() => {
        const s = this.store.get();
        /**
         * **框选优先**（c 期独立审查 🟡6）：它排在最前面 —— 手还按着、框还在跟的时候，
         * 用户按 Esc 要的是"别框了"，不是"清掉上一次的选择"。
         * ⚠️ 与 `dragKey` 同一待遇：**真的要停掉**（`stopMarquee()` 会连 document 级监听一起收），
         * 只清界面状态的话，松手照样改选择。
         */
        if (this.stopMarquee != null) {
          this.stopMarquee();
          this.stopMarquee = null;
        } else if (s.dragKey != null) {
          /**
           * ⚠️ **要真的取消拖动，不能只清界面状态**（独立审查抓到）：只 `store.set` 的话，
           * `drag.ts` 里的 `lastKey/lastIndex` 没变 → 反馈不会自己回来（除非指针挪到别的缝），
           * 而**松手照样落盘** —— 跨板块那一下就是真搬文件。误导性比"少一圈描边"大得多。
           * `stopDrag()` 会连指针拖动一起停掉（`stop()` + `endDrag()`），松手不再触发 drop。
           */
          this.stopDrag?.();
          this.stopDrag = null;
          this.store.set({ dragKey: null, dragCount: 0, dragIndex: -1, dragFrom: null, dragPaths: [] });
        }
        else if (s.receipt != null) this.store.set({ receipt: null });
        else if (s.selectMode || s.selected.length > 0) {
          // 触屏选择模式与选择一起退（与网格档同一条：模式比选择更外层）
          // 选择与光标一起清：光标是"键盘走到哪张"，选择没了它就没有意义（少按一次 Esc）
          this.store.set({ selected: [], anchor: null, cursor: null, selectMode: false });
        } else this.store.set({ cursor: null });
        return true;
      }, 'board:clear-transient', { bottom: true });
    } else if (!need() && this.escPop) {
      this.escPop();
      this.escPop = null;
    }
  }
}

/**
 * 两份配置 JSON：**除了收起态（`view.collapsed` / `view.openSubs`）之外**是不是完全一样。
 * 只有一样时才允许"就地贴、不重绘"——多一处不同都回退到整块重绘（宁可多画，不许画少）。
 * 解析失败按"不是"处理（看不懂的配置一律走保守那条）。
 */
/**
 * **两份配置 JSON 里 `view` 下某个键变了吗** —— 用来回答"用户刚动的是哪一个"。
 *
 * 干嘛用：窗格只有一个，而"谁该占着它"分散在同一份配置的两个键里
 *（`view.dock` = 编辑面板要停靠 / `view.peekEnabled` = 预览要开）。
 * 两边都说要时，唯一能还原用户意图的线索就是**他刚改的那一个**（见 `cfg.onChange` 里那段仲裁）。
 *
 * ⚠️ 解析失败时**返回 true**（当"动过"）：宁可多裁一次，也别把窗格留在一个
 * 谁都不认的状态（那是"边上空着一条"的来源）。
 */
export function viewKeyMoved(prevJson: string, nextJson: string, key: string): boolean {
  const pick = (s: string): unknown => {
    try {
      const o = JSON.parse(s) as { view?: Record<string, unknown> };
      return o.view?.[key] ?? null;
    } catch {
      return Symbol('unparsable');
    }
  };
  const a = pick(prevJson);
  const b = pick(nextJson);
  if (typeof a === 'symbol' || typeof b === 'symbol') return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function onlyCollapseChanged(a: string, b: string): boolean {
  type Loose = { view?: Record<string, unknown> } & Record<string, unknown>;
  try {
    const x = JSON.parse(a) as Loose;
    const y = JSON.parse(b) as Loose;
    for (const c of [x, y]) {
      if (c.view && typeof c.view === 'object') {
        delete c.view.collapsed;
        delete c.view.openSubs;
      }
    }
    return JSON.stringify(x) === JSON.stringify(y);
  } catch {
    return false;
  }
}

/** **直接子元素**里带某个类的那个（不收孙子辈）。
 *  ⚠️ 不用 `:scope > .x`：离线夹具跑的 jsdom 对 `:scope` 支持不稳，真机与用例会各说一套。 */
function directChild(el: HTMLElement, cls: string): HTMLElement | null {
  for (const c of Array.from(el.children)) {
    if (c.classList.contains(cls)) return c as HTMLElement;
  }
  return null;
}

function hintForSource(g: BoardGroup): string {
  if (g.kind === 'folder') return '把这个目录下的笔记归进来，或直接往这里拖一篇。';
  if (g.kind === 'tag') return `给笔记加上「${g.title}」标签，它就会出现在这里。`;
  if (g.kind === 'prop') return '把笔记的这个属性改成这个值。';
  if (g.kind === 'shelter') return '哪条规则都没命中的笔记会落在这儿 —— 它是个提示，不是归宿。';
  return '往里放一条。';
}
