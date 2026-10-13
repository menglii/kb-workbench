/**
 * view/workbench-view.ts —— 工作台外壳（ItemView）
 *
 * 方案设计.md §5.3：左导航 152px + 主内容区 + 导航底部状态区。
 * 「区域重绘」原语在这里落地：导航区、状态区、模块区各是一个 Region，
 * state 变了只重画该区域（模块区带 `key`，索引没动就不重画）。
 *
 * 三条与平台相关的注意事项：
 *  · 窄容器判断走 **JS 量 clientWidth 打 `data-w`**，**不给容器加 container-type**
 *  · 触控尺寸走 `body.is-mobile`（CSS 侧），这里只管布局
 *  · 键盘高亮**只在键盘真的用过之后**才出现（第一下 keydown 给根元素加 `kbw-kbd`）
 */
import { ItemView, Scope, type WorkspaceLeaf } from 'obsidian';
import { div, el, icon, iconBtn, brandMark } from '../ui/primitives';
import { Region, type Unsubscribe } from '../core/store';
import { Disposer, formatRelativeTime, on } from '../core/util';
import { SCROLL_ATTR, hasPendingScroll, recallScroll, rememberScroll } from '../core/view-memory';
import { MODULES, MODULE_IDS, type FeatureId, type ModuleId } from '../core/settings';
import type { ColSlotPort, ModuleRender, WorkbenchContext, WorkbenchState } from '../core/context';
import {
  DOCK_ATTR,
  DOCK_GRIP_CLASS,
  DOCK_HOST_CLASS,
  DOCK_STAGE_CLASS,
  defaultDock,
  dockFit,
  dockReserve,
  type DockFit,
  type DockOwner,
  type DockPort,
  type DockSide,
  type DockState,
  type DockStatus,
} from '../ui/dock';
import { startPointerDrag } from '../ui/dnd';

import { emptyState, skeleton } from '../ui/empty';
import { renderHome } from '../modules/home';
import { renderNotes } from '../modules/notes';
import { renderBoard } from '../modules/board';
import { renderGraph } from '../modules/graph';
import { renderReview } from '../modules/review';
/**
 * 面板是**工作台级**的（d 期拍板：跟着工作台、不跟着看板模块），所以"视图关了要收掉它"
 * 这件事落在这一层。它是模块级单例，不随模块重建 —— 这里拿到的永远是当前那一个。
 */
import { closeCardPanel } from '../modules/board/editor';

export const VIEW_TYPE = 'kb-workbench-view';

const MODULE_RENDERERS: Record<ModuleId, ModuleRender> = {
  home: renderHome,
  notes: renderNotes,
  board: renderBoard,
  graph: renderGraph,
  review: renderReview,
};

/** 布局断点（方案设计.md §5.8 ①）——按**容器**宽度，不是视口 */
const MID_MAX = 900;
const NARROW_MAX = 640;

/**
 * **还活着的工作台视图的停靠口子**（分屏开两个标签时会有两个）。
 *
 * 🔴 为什么要有这张表（d2 审查抓的）：`ctx.dock` 是个**单槽**，后开的视图胜。
 * 原先视图 `onClose` **无条件**把它清成 `undefined` —— 于是"关掉第二个标签"
 * 会把第一个标签的口子一起撤掉：剩下那个标签的停靠**永久失效**
 *（配置还写着 left，再开卡片却是浮层），而它边上那条空窗格也没人收。
 * 现在按"自己的撤、把口子**交还给还活着的那个**"来收。
 */
const livePorts: DockPort[] = [];

/**
 * **还活着的列头槽**（同一张表的第二种口子，P6 段⑥ ④-A）。
 *
 * 与 `livePorts` 逐字同一条纪律、同一个理由：`ctx.colSlot` 也是**单槽**，
 * 收尾时无条件清掉的话，"关掉后开的那个标签"会把还活着的那个标签的槽一起撤掉
 *（症状：工作台还开着，中列标题却没了）。
 */
const liveColSlots: ColSlotPort[] = [];

export class WorkbenchView extends ItemView {
  private ctx: WorkbenchContext;
  private disposer = new Disposer();
  private root: HTMLElement;
  private regions: Region<WorkbenchState>[] = [];
  private unsubscribe: Unsubscribe | null = null;
  private lastModuleIndex = -1;
  /**
   * **上一次真的画在宿主里的那一屏**（视图记忆要用它当键，见 `paintModule`）。
   * ⚠️ 不能用 `state.activeModule` 代替：换模块那一下进 `paintModule` 时，
   * `state` 已经是新的那个了，而我们要记的是**刚被换走**的那一屏。
   */
  private paintedModule: ModuleId | null = null;
  /** 上一次"这一屏是什么身份"（与模块区 Region 的 key **同一个函数**，见 `moduleKey`） */
  private lastModuleKey: string | null = null;

  private navEl!: HTMLElement;
  private navItemsHost!: HTMLElement;
  private statusHost!: HTMLElement;
  private moduleHost!: HTMLElement;
  private titleEl_!: HTMLElement;
  private subEl!: HTMLElement;
  /** 顶栏「列头槽」（P6 段⑥ ④-A）—— 模块往这里填「目录」 */
  private colSlotEl!: HTMLElement;
  /** **我自己那一个**列头槽（多标签时 `ctx.colSlot` 会被后一个视图覆盖，收尾要认人） */
  private myColSlot: ColSlotPort | null = null;
  /** 「舞台」= 左导航之外的全部（停靠宿主 + 主区住在这里） */
  private stageEl!: HTMLElement;
  /** 停靠宿主（面板搬进/搬出的那个容器） */
  private dockHost!: HTMLElement;
  private dockGrip!: HTMLElement;
  /** 面板请求的停靠（外壳按容器尺寸**裁决**之后才生效，见 `ui/dock.ts` 的 `dockFit`） */
  private dockReq: DockState = defaultDock();
  /** **我自己那一个**口子（多标签时 `ctx.dock` 会被后一个视图覆盖，收尾要认人，见 `onClose`） */
  private myPort: DockPort | null = null;
  /** 上一次裁决结果（生效没）—— 变了才通知占用者搬进/搬出 */
  private dockApplied = false;
  /** 上一次**谁占着**（e 期）—— 换人也算"变了"，见 `paintDock` */
  private dockOwner: DockOwner | null = null;
  /** 最后一次申请里记下的占用者（`request(null)` 会清掉） */
  private dockReqOwner: DockOwner | null = null;
  private dockSubs = new Set<(s: DockStatus) => void>();
  private dockSizeSubs = new Set<(size: number) => void>();
  /** 当前模块的清理函数（模块自己订阅索引；换模块/关视图时必须收干净） */
  private moduleCleanup: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, ctx: WorkbenchContext, onOpened?: () => void) {
    super(leaf);
    this.ctx = ctx;
    this.onOpened = onOpened;
    this.root = this.contentEl;
  }

  /**
   * 视图打开时喊一声（③ 的第二个入口：会话恢复那条路不经过 `plugin.activate()`，
   * 见 `main.ts` 的 `registerView`）。**只做"打开工作台要做的事"，不碰界面** ——
   * 具体动作在 main.ts 里（`collapseSidebarOnOpen`，受设置开关管、自己判"已经收着就跳过"）。
   */
  private onOpened?: () => void;

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    const active = this.ctx.store.get().activeModule;
    return `经纬 · ${MODULES[active]?.label ?? '工作台'}`;
  }

  getIcon(): string {
    return 'layout-dashboard';
  }

  /**
   * **标签页图标换成插件自己的标记**（f 期第 6 条，用户 2026-09-26 的截图）。
   *
   * `getIcon()` 只能返回一个 **lucide 名字**（平台按名字画 SVG），给不了自造图形 ——
   * 所以照 `main.ts` 里 ribbon 那条先例：**等平台画完，再把里面的 SVG 换掉**
   *（`ribbon.replaceChildren(brandMark(18))`，同一个 `brandMark()`，图标只有一个真源）。
   *
   * 真机取证（2026-09-26，1.13.7，写在 `看板优化方案.md` §6.18）：
   *  · 宿主是 `.workspace-tab-header[data-type="kb-workbench-view"] .workspace-tab-header-inner-icon`；
   *  · 平台**会重建**这个头（实测：`layout-change`、切叶子再回来之后图标又变回 grid 了）
   *    → 所以要在 `onOpen` / 改名 / `layout-change` 三处都补一遍；
   *  · 尺寸**不要自己写死**：平台给 svg 的是 `.svg-icon`（主区 tab 的 `--icon-size` = 14px、
   *    侧栏 18px，随区域变）→ 我们的 svg 挂上同一个类，尺寸就跟着平台走
   *    （实测：不带这个类会按属性尺寸画成 14，与旁边那排图标对不齐）。
   *  · 幂等：已经贴过就什么都不做（`layout-change` 会来很多次）。
   */
  private applyTabIcon(): void {
    try {
      const header = document.querySelector(
        '.workspace-tab-header[data-type="kb-workbench-view"] .workspace-tab-header-inner-icon',
      );
      if (!header) return;
      if (header.querySelector('svg.kbw-tab-mark')) return;
      header.replaceChildren(brandMark(18, 'svg-icon kbw-tab-mark'));
    } catch (e) {
      // 图标只是门面：贴不上不影响任何功能，别让它把 onOpen 带崩
      console.error('[经纬] 换标签页图标失败（不影响功能）', e);
    }
  }

  async onOpen(): Promise<void> {
    /**
     * ③ 「打开工作台时收起侧栏」：**放在建 DOM 之前**。
     * 早一步收掉 = 后面 `data-w` 的那次测量（ResizeObserver 那一趟）已经是
     * "侧栏不在"的宽度，不必再多一次 relayout。
     * ⚠️ 动作本身在 `main.ts` 里（受设置开关管、自己判"已经收着就跳过"），这里只负责喊一声。
     */
    try {
      this.onOpened?.();
    } catch (e) {
      console.error('[经纬] 打开工作台时的例行动作失败（不影响界面）', e);
    }
    this.root.classList.add('kbw-root');
    /**
     * **给宿主 leaf 打个我们自己的类**（P7.0a 批 1③）：那条平台标题栏
     *（`.view-header`，标签上方那排 ← → 标题）**停在旧模块名**、且刷不动（见 `refreshTitle`），
     * 所以整条藏掉 —— 但 CSS 要有个**我们自己的锚点**：不能按 `data-type` 写
     *（图谱那次栽过：挂上去的叶 `data-type` 不是我们的 → 真机零命中），
     * 也不能光靠 `.view-header` 裸选择器（会打到小窗/图谱之外的一切宿主）。
     * 做法与 `.kbw-cw-leaf`（board/editor.ts）同一份先例：加在 `containerEl` 上。
     */
    this.containerEl.classList.add('kbw-workbench-leaf');
    this.root.setAttribute('data-w', 'wide');
    this.applyAppearance();
    this.buildShell();

    // ⚠️ 宿主必须是**装导航项的容器**：Region.paint 会清空宿主，
    // 若把 .kbw-nav 当宿主，会把里面的 navItemsHost 一起清掉（P0 真踩过）
    const navRegion = new Region<WorkbenchState>(
      this.navItemsHost,
      (_el, state) => this.paintNav(state),
      { key: (s) => `${s.activeModule}|${MODULE_IDS.map((m) => s.modules[m]).join('')}` },
    );
    const statusRegion = new Region<WorkbenchState>(
      this.statusHost,
      (_el, state) => this.paintStatus(state),
      { key: (s) => `${s.entryCount}|${s.lastSnapshotAt ?? 0}|${s.modules.automation}|${s.indexReady}` },
    );
    const moduleRegion = new Region<WorkbenchState>(
      this.moduleHost,
      (_el, state) => this.paintModule(state),
      {
        // ⚠️ key 里**不要 indexRevision**：模块自己订阅索引做内部区域重绘，
        // 外壳每次索引变动就整体清空重画的话，选择/滚动/树展开全丢（P1 改）
        key: (s) => this.moduleKey(s),
      },
    );
    this.regions = [navRegion, statusRegion, moduleRegion];

    this.unsubscribe = this.ctx.store.subscribe((state, prev) => {
      if (state.activeModule !== prev.activeModule) {
        this.setModuleDirection(state.activeModule);
        this.refreshTitle();
      }
      /**
       * 🔴 **视图记忆的捕获点必须在这儿**（`for (const r of this.regions)` **之前**）——
       * 不能放进 `paintModule`：`Region.paint()` 是**先清宿主、再调渲染函数**
       *（`core/store.ts` 那句 `while (this.host.firstChild) removeChild`）——
       * 等进到 `paintModule` 里，宿主的 DOM 已经没了，捕获回来的是**一片空**
       *（离线实测踩到：`pending` 里什么都没有 → 切回来当然还是 0；
       * 而且"捕获为空就不覆盖"那条守卫会把它**静静地**吞掉，症状看着像"功能没生效"）。
       *
       * 判据用 `moduleKey()`（与 Region 的 key **同一个函数**）：凡是会让宿主整体重建的
       * （换模块 / 索引就绪翻面 / 库根不见了），都在这一下把上一屏的位置记下来。
       */
      const mk = this.moduleKey(state);
      if (mk !== this.lastModuleKey) {
        if (this.paintedModule) rememberScroll(this.paintedModule, this.moduleHost);
        this.lastModuleKey = mk;
        this.paintedModule = state.activeModule;
      }
      for (const r of this.regions) r.paint(state);
      this.updateLayoutWidth();
    });

    this.wireKeyboard();
    // 停靠口子挂给面板用（见 `makeDockPort`：外壳建宿主、面板搬进来）
    this.myPort = this.makeDockPort();
    livePorts.push(this.myPort);
    this.ctx.dock = this.myPort;
    // 列头槽挂给模块用（④-A：外壳开槽、模块填标题）—— 与上面那条同一条认人纪律
    this.myColSlot = { el: this.colSlotEl };
    liveColSlots.push(this.myColSlot);
    this.ctx.colSlot = this.myColSlot;
    /**
     * **标签页图标**（f 期第 6 条）：开视图这一刻贴一次，并盯住 `layout-change` ——
     * 真机实测平台会在重排之后**重建**那个 tab 头（图标又变回 grid）。
     * ⚠️ `layout-change` 来得很勤：`applyTabIcon()` 自己幂等（贴过就返回），所以代价只是一次查询。
     */
    this.applyTabIcon();
    const onLayout = (): void => this.applyTabIcon();
    /**
     * ⚠️ 退订走平台惯用的 **`on()` 拿到 ref → `offref(ref)`**（与 `vault.on` 那两处同一套）：
     * 用 `off(name, handler)` 的话离线桩里没有那个方法（那是个只在真机存在的重载），
     * 得靠 try/catch 兜 —— 而"兜住"意味着**离线永远验不到退订**（本项目最忌的那类假绿）。
     */
    const layoutRef = this.ctx.app.workspace.on('layout-change', onLayout);
    this.disposer.add(() => {
      try {
        this.ctx.app.workspace.offref(layoutRef);
      } catch {
        /* 平台没有 offref 就算了（视图要关了，残留监听再触发也只是白跑一次幂等查询） */
      }
    });

    const ro = new ResizeObserver(() => this.updateLayoutWidth());
    ro.observe(this.root);
    this.disposer.add(() => ro.disconnect());

    this.lastModuleIndex = MODULE_IDS.indexOf(this.ctx.store.get().activeModule);
    this.refreshTitle();
    this.paintAll(true);
    this.updateLayoutWidth();
  }

  async onClose(): Promise<void> {
    this.disposeModule();
    /**
     * **面板在这里无条件收掉**（d 期）。
     * 模块卸载那条路对钉住的**故意留着**（切模块不该把编辑现场弄没），
     * 但视图关闭不一样：面板是挂在工作台这一页上的，宿主都没了，
     * 留着它就是一个**没人能 detach 的编辑器叶**（每个 tab 一个）。
     */
    /**
     * 收面板 —— ⚠️ **停在别人窗格里的那个不许收**（多标签，d2 审查抓的）：
     * 本视图的窗格宿主马上要拆，停在它里面的必须收（否则就是一个没人 detach 的叶）；
     * 但停在**另一个还活着的工作台标签**的窗格里的，是别人的编辑现场。
     */
    closeCardPanel({ reason: 'view-close', keepIfDockedOutside: this.dockHost });
    /**
     * 撤口子**只撤自己的，并把口子交还给还活着的那个视图**（d2 审查抓的）：
     * 原先无条件清成 `undefined`，于是"关掉第二个标签"会把第一个标签的口子一起撤掉
     * → 剩下那个标签的停靠**永久失效**（配置还写着 left，再开卡片却是浮层）。
     */
    const mine = this.myPort;
    if (mine) {
      const i = livePorts.indexOf(mine);
      if (i >= 0) livePorts.splice(i, 1);
      if (this.ctx.dock === mine) this.ctx.dock = livePorts[livePorts.length - 1];
    }
    this.myPort = null;
    // 列头槽同一条账（④-A）：只撤自己的，把口子交还给还活着的那个视图
    const mySlot = this.myColSlot;
    if (mySlot) {
      const i = liveColSlots.indexOf(mySlot);
      if (i >= 0) liveColSlots.splice(i, 1);
      if (this.ctx.colSlot === mySlot) this.ctx.colSlot = liveColSlots[liveColSlots.length - 1];
    }
    this.myColSlot = null;
    /**
     * ⚠️ 槽里那点内容**不在这儿清**：装进去的是模块自己的节点，由模块的 `dispose()` 收
     *（`disposeModule()` 就在本函数第一行跑了）。外壳在这儿顺手清一把看似无害，
     * 实际是"两处都在管同一件事" —— 而真正的风险不是清错（`mySlot.el` 永远是本视图的元素），
     * 是**下一个人以为这里该管**，于是又添一条规则。
     */
    this.dockSubs.clear();
    this.dockSizeSubs.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const r of this.regions) r.dispose();
    this.regions = [];
    this.disposer.dispose();
    this.root.classList.remove('kbw-root');
    this.containerEl.classList.remove('kbw-workbench-leaf');
  }

  /**
   * 重画（索引/配置变化后由插件调）。
   * ⚠️ **不强制**：三个区域的 key 已经覆盖了各自显示的东西。P0 这里是 `paintAll(true)`，
   * P1 必须改掉 —— 模块自己会写界面偏好（排序/列宽/树展开），那会经 `settings.onChange`
   * 绕回来调这里；一强制就把模块**整体重建**（选择、筛选、树展开全丢）。
   */
  repaint(): void {
    this.applyAppearance();
    this.paintAll(false);
  }

  /**
   * 外观（交互规格 §7.5）：密度 / 动效落到根元素的 `data-*` 上，**样式由 CSS 认**
   * （`styles/settings.css`）。在视图里改样式的话，"哪来的这条规则"根本查不清。
   */
  private applyAppearance(): void {
    const s = this.ctx.settings.get();
    this.root.setAttribute('data-density', s.density);
    this.root.setAttribute('data-motion', s.motion);
    /**
     * 🔴 **`data-motion` 同时镜像到 `body`**（P7.7 · 10.1）：菜单 / 浮层 / 模态 / 通知 /
     * 撤销条全都挂在 `body` 上（不在 root 里）—— 只挂 root 的话，「动效 = 减少」这一档
     * 对它们等于没开（盘点实测的洞）。选择器点名容器、绝不裸写 `[data-motion] *`；
     * 卸载时由 `main.ts` 摘掉，别在 body 上留孤儿属性。
     */
    document.body.setAttribute('data-motion', s.motion);
  }

  /**
   * **模块区的"身份"** —— 变了就意味着宿主会被**整体清空重建**。
   *
   * ⚠️ **只有这一处出处**：模块区 Region 的 `key` 与视图自己那次"该不该记滚动位置"的
   * 判断（`onOpen` 的订阅里）**必须用同一个函数**。各写一份的话，迟早出现
   * "Region 重画了但没人记位置"（= 视图记忆静默失效）或者反过来（记了一堆没意义的快照）。
   */
  private moduleKey(s: WorkbenchState): string {
    return `${s.activeModule}|${s.indexReady}|${s.kbRootMissing}`;
  }

  private paintAll(force = false): void {
    const state = this.ctx.store.get() as WorkbenchState;
    for (const r of this.regions) r.paint(state, force);
  }

  // ── 骨架 ─────────────────────────────────────────────────────
  private buildShell(): void {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);

    const shell = div({ cls: 'kbw-shell' });
    this.navEl = div({ cls: 'kbw-nav' });

    const brand = div({ cls: 'kbw-brand' });
    brand.appendChild(brandMark(22));
    brand.appendChild(div({ cls: 'kbw-brand-name', text: '经纬' }));
    this.navEl.appendChild(brand);

    // 导航项由 navRegion 重画 → 占位容器
    this.navItemsHost = div({ cls: 'kbw-navitems' });
    this.navEl.appendChild(this.navItemsHost);

    this.statusHost = div({ cls: 'kbw-navfoot' });
    this.navEl.appendChild(this.statusHost);

    const main = div({ cls: 'kbw-main' });
    const topbar = div({ cls: 'kbw-topbar' });
    /**
     * **列头槽**（P6 段⑥ ④-A）：顶栏里那一格，宽 = 目录栏宽，**由模块填**。
     *
     * 它取代了 P6b ⑧ 那段 `::before` 灰带 —— 那段灰带把两块灰底连成了一条通高带、
     * 但它**没有承担任何信息**，中列真正的标题「目录」却被压在它下面
     *（用户原话："中间那个灰框上面有点空"）。改成槽之后三列的头落在同一基线。
     *
     * 顺序要紧：**必须是顶栏的第一个子元素** —— 它占的就是最左边那一格，
     * CSS 那边靠 `:has(.kbw-notes)` 决定画不画（别的模块不填，默认 `display:none`）。
     */
    this.colSlotEl = div({ cls: 'kbw-colslot' });
    topbar.appendChild(this.colSlotEl);
    this.titleEl_ = el('h2', { text: '首页' });
    topbar.appendChild(this.titleEl_);
    this.subEl = div({ cls: 'kbw-sub', text: '' });
    topbar.appendChild(this.subEl);
    const actions = div({ cls: 'kbw-topbar-actions' });
    actions.appendChild(iconBtn('keyboard', '快捷键表', () => this.ctx.openKeysHelp()));
    actions.appendChild(
      /**
       * P7.11 · #8：实现抽去了 `ctx.reloadIndex()`（首页全局菜单的「重载（重扫全库索引）」
       * 与这里是**同一件事** —— 一处实现两处入口，别在这儿再写一份两行）。
       */
      iconBtn('refresh-cw', '重载（重扫全库索引）', () => this.ctx.reloadIndex()),
    );
    actions.appendChild(iconBtn('settings', '工作台设置', () => this.ctx.openWorkbenchSettings()));
    topbar.appendChild(actions);

    /**
     * `data-scroll` = **视图记忆**（e 期 §4.4）认这个容器的锚。
     *
     * ⚠️ 为什么这个（外壳自己的）容器也要记：`home` / `graph` 这类"内容自然流"的模块
     * **就是它在滚**（`styles/shell.css` 的 `overflow: auto`），它们内部没有自己的滚动容器。
     * 看板与全部笔记另有自己的那一层（`.kbw-board-body` / `.kbw-notes-list`），
     * 也都各自贴了 `data-scroll` —— 捕获那一遍是**把所有带标记的容器都收下来**，
     * 所以多层容器不必在外壳这儿写一份清单。
     */
    this.moduleHost = div({ cls: 'kbw-modhost', attr: { [SCROLL_ATTR]: 'modhost' } });

    main.appendChild(topbar);
    main.appendChild(this.moduleHost);

    /**
     * **舞台**（d2 期）：左导航之外的全部 —— 停靠宿主与主区并排住在它里面。
     *
     * 🔴 为什么非要有这一层（而不是像开工提示词里草拟的"`.kbw-shell` 直接变成三件"）：
     * 底部停靠要求 `main` 与 `dock` **上下**排，而左导航得**通高**。
     * 三个平级的 flex 子元素做不到这件事（`.kbw-shell` 只能是 row 或 column 之一），
     * 所以把"主区 + 停靠"收进一个自己的 flex 容器，方向由 `data-dock` 切。
     * ⚠️ `main` 仍然是 `flex:1` + `min-width:0`（原来那两条一条都不能少 ——
     * 少了 `min-width:0`，列形态的列会把主区撑开，横向溢出）。
     */
    // 重建外壳 = 宿主是新的：裁决结果与占用者都要重新翻一遍，
    // 否则占用者收不到"搬进来"那一次通知（`dockOwner` 一起清，见 `paintDock` 那句 changed）
    this.dockApplied = false;
    this.dockOwner = null;
    this.stageEl = div({ cls: DOCK_STAGE_CLASS });
    this.stageEl.setAttribute(DOCK_ATTR, 'none');
    this.dockHost = div({ cls: DOCK_HOST_CLASS });
    this.dockHost.style.display = 'none';
    /**
     * 分隔条。⚠️ 它是**拖动件**，按 WCAG 2.2 的 Dragging Movements 必须有**非拖动的等价操作**
     * —— 那一半由菜单里的「停靠面板 → 大小：窄/中/宽」三档预设提供（§4.3 记过这条口径）。
     * 这里补上 `role`/`aria-label`：读屏至少要能知道"这里有个能调窗格大小的东西"。
     */
    this.dockGrip = div({
      cls: DOCK_GRIP_CLASS,
      attr: { role: 'separator', 'aria-label': '拖动改窗格大小', title: '拖动改窗格大小' },
    });
    this.dockHost.appendChild(this.dockGrip);
    this.stageEl.appendChild(this.dockHost);
    this.stageEl.appendChild(main);

    shell.appendChild(this.navEl);
    shell.appendChild(this.stageEl);
    this.root.appendChild(shell);
    this.wireDockGrip();
  }

  // ── 停靠（d2 期 §3.1）─────────────────────────────────────────
  /**
   * 建好宿主、把口子交出去（挂 `ctx.dock`）。
   *
   * 🔴 **方向**：外壳建宿主 → 面板搬进来。反过来（board 去 import view 找宿主）
   * 就是循环 import，这一期明令不许。
   * ⚠️ 同一个插件里开两个工作台标签时，两个视图会各注册一次、后者胜 ——
   * 与 `closeCardPanel`（面板本来就是模块级单例）同一个已知边界，本期不解决。
   */
  private makeDockPort(): DockPort {
    return {
      host: this.dockHost,
      request: (where, size, owner) => {
        this.dockReq = { where, size };
        /**
         * ⚠️ **`request(null)` 要把占用者清掉**（"我不要了"），而 `where` 有值时记下是谁 ——
         * 收尾那句 `request(null)` 只由**当前占用者**发得出来（它们各自先问 `owner()`），
         * 所以这里不必再校验。
         */
        this.dockReqOwner = where ? owner : null;
        // `updateLayoutWidth()` 里会走 `paintDock()` → **状态变了就通知占用者**
        this.updateLayoutWidth();
      },
      applied: () => this.dockApplied,
      owner: () => (this.dockApplied ? this.dockReqOwner : null),
      canHold: (where, size) => {
        const w = this.root.clientWidth || 0;
        const h = this.root.clientHeight || 0;
        // 量不到尺寸就说"放不下"？不 —— 那会让"窗口被藏起来"被读成"容器太小"。
        // 量不到时**沿用上一次的结论**（与 `updateLayoutWidth` 那条守卫同一个口径）。
        if (!(w > 0) || !(h > 0)) return this.dockApplied;
        return dockFit({ where, size }, w, h).applied;
      },
      onChange: (cb) => {
        this.dockSubs.add(cb as (s: DockStatus) => void);
        return () => this.dockSubs.delete(cb as (s: DockStatus) => void);
      },
      onResize: (cb) => {
        this.dockSizeSubs.add(cb);
        return () => this.dockSizeSubs.delete(cb);
      },
    };
  }

  /**
   * **拖分隔条改窗格大小**（d2 加的那半条）。
   *
   * ⚠️ 为什么除了菜单还要有这个：`view.dock.size` 光靠菜单那三档预设太粗，
   * 而"拖动必须有一个非拖动的等价操作"（WCAG 2.2 Dragging Movements，§4.3 记过那条）
   * 正好由菜单那三档预设满足 —— 两条一起才成立，别只留一条。
   *
   * 拖动期间只改**视觉**（`dockReq.size` + 重排），松手才落盘：
   * 每移动一像素写一次配置的话，`cfg.onChange` 会把看板整块重绘一遍。
   */
  private wireDockGrip(): void {
    this.dockGrip.addEventListener('pointerdown', (evt) => {
      const down = evt as PointerEvent;
      if (down.button !== 0) return;
      const where = this.dockReq.where;
      if (!where) return;
      const stage = this.stageEl;
      const before: DockState = { ...this.dockReq };
      const r = stage.getBoundingClientRect();
      startPointerDrag<null>(down, null, {
        onStart: () => {
          this.dockGrip.classList.add('is-dragging');
          this.root.classList.add('kbw-dock-resizing');
        },
        onOver: (_t, c) => {
          /**
           * ⚠️ **窗格已经被让出来了就别再申请回来**（d2 审查抓的）：
           * 指针监听挂在 `document` 上，所以"拖到一半面板被关掉"（关掉最后一篇 / 文件被删 /
           * 「全部关闭」）之后，**后续的 `pointermove` 照样收得到** ——
           * 于是这次拖动会把窗格又显示回一条 640px 的**空走廊**，要等下一次开面板才收。
           * `dockApplied` 是外壳自己的状态：面板一关（`request(null)`）它就是 false。
           */
          if (!this.dockApplied) return;
          const raw =
            where === 'bottom' ? r.bottom - c.y : where === 'left' ? c.x - r.left : r.right - c.x;
          // 夹的规矩走 `dockFit`（**唯一出处**）—— 免得这里与外壳各判一套
          const fit = dockFit(
            { where, size: Math.round(raw) },
            this.root.clientWidth || 0,
            this.root.clientHeight || 0,
          );
          this.dockReq = { where, size: fit.applied ? fit.size : before.size };
          /**
           * ⚠️ 走 `updateLayoutWidth()` 而**不是**直接 `paintDock()`：拖的过程中
           * **断点也要跟着走**。拖宽到主区跌破 mid 阈值时，导航该当场收成图标栏 ——
           * 等松手才收，看着像"拖到一半卡住了"。
           */
          this.updateLayoutWidth();
        },
        onDrop: () => {
          this.dockGrip.classList.remove('is-dragging');
          this.root.classList.remove('kbw-dock-resizing');
          for (const cb of Array.from(this.dockSizeSubs)) cb(this.dockReq.size);
        },
        onCancel: () => {
          this.dockGrip.classList.remove('is-dragging');
          this.root.classList.remove('kbw-dock-resizing');
          // 中止 = 回到拖动前那一个宽度（`pointercancel` 在触屏很常见，别让它留下半个状态）
          this.dockReq = before;
          this.updateLayoutWidth();
        },
      });
    });
  }

  /**
   * 把裁决结果落到 DOM 上，并在**生效与否变了**的时候通知面板搬进/搬出。
   *
   * ⚠️ 顺序是**先通知、后改 DOM**：两个方向都保证"面板已经在正确的位置上了，
   * 宿主的状态才跟着翻"。反过来做的话，取消停靠那一帧面板还挂在正要 `display:none`
   * 的宿主里（同一任务内不会真闪，但依赖"浏览器不会在任务中间绘制"太脆）。
   */
  private paintDock(fit: DockFit): void {
    if (!this.stageEl) return;
    /**
     * ⚠️ **"变了没"要连占用者一起比**（e 期）：换人（面板 ↔ 预览）时 `applied` 一直是 true，
     * 只比它的话那个占用者**收不到通知** —— 而"另一个占用者把窗格要走了"正是靠这条通知
     * 才让位的（Peek 的自动让位全押在它身上）。少了这半句，两个根会同时挂在一个宿主里。
     */
    const nextOwner = fit.applied ? this.dockReqOwner : null;
    const changed = this.dockApplied !== fit.applied || this.dockOwner !== nextOwner;
    this.dockApplied = fit.applied;
    this.dockOwner = nextOwner;
    if (changed) {
      const s: DockStatus = { applied: fit.applied, owner: nextOwner };
      for (const cb of Array.from(this.dockSubs)) {
        try {
          cb(s);
        } catch (e) {
          console.error('[经纬] 停靠状态通知占用者失败', e);
        }
      }
    }
    const where: DockSide | null = fit.applied ? fit.where : null;
    this.stageEl.setAttribute(DOCK_ATTR, where ?? 'none');
    this.dockHost.style.width = where === 'left' || where === 'right' ? `${fit.size}px` : '';
    this.dockHost.style.height = where === 'bottom' ? `${fit.size}px` : '';
    this.dockHost.style.display = where ? '' : 'none';
  }

  // ── 区域渲染 ─────────────────────────────────────────────────
  private paintNav(state: WorkbenchState): void {
    while (this.navItemsHost.firstChild) this.navItemsHost.removeChild(this.navItemsHost.firstChild);
    for (const id of MODULE_IDS) {
      const meta = MODULES[id];
      const enabled = !meta.toggleable || state.modules[id as FeatureId];
      const item = el('button', {
        cls: ['kbw-navitem', 'kbw-hover-1', state.activeModule === id ? 'is-on' : null, enabled ? null : 'is-off'],
        attr: { type: 'button', title: enabled ? meta.label : `${meta.label}（模块已关闭）` },
        on: {
          click: () => {
            if (!enabled) {
              this.ctx.gate.assert(id as FeatureId, `打开${meta.label}`);
              return;
            }
            void this.ctx.settings.save({ activeModule: id });
            this.ctx.store.set({ activeModule: id });
          },
        },
      });
      item.appendChild(icon(meta.icon, 16));
      item.appendChild(div({ cls: 'kbw-navitem-label', text: meta.label }));
      this.navItemsHost.appendChild(item);
    }
  }

  private paintStatus(state: WorkbenchState): void {
    while (this.statusHost.firstChild) this.statusHost.removeChild(this.statusHost.firstChild);

    const autoOn = state.modules.automation;
    const row1 = div({
      cls: ['kbw-navfoot-row', 'kbw-hover-1'],
      attr: { role: 'button', tabindex: '0', title: '打开设置 · 自动化（P3）' },
      on: { click: () => this.ctx.openWorkbenchSettings() },
    });
    row1.appendChild(div({ cls: ['kbw-dot', autoOn ? 'is-on' : 'is-off'] }));
    row1.appendChild(div({ cls: 'kbw-navfoot-text', text: autoOn ? '自动化运行中' : '自动化已停止' }));
    this.statusHost.appendChild(row1);

    const row2 = div({
      cls: ['kbw-navfoot-row', 'kbw-hover-1'],
      attr: { role: 'button', tabindex: '0', title: '打开快照面板' },
      on: { click: () => this.ctx.openSnapshotPanel() },
    });
    row2.appendChild(
      div({
        cls: 'kbw-navfoot-text',
        text:
          state.lastSnapshotAt != null
            ? `快照 ${formatRelativeTime(state.lastSnapshotAt)}`
            : '还没有快照',
      }),
    );
    this.statusHost.appendChild(row2);

    const row3 = div({ cls: 'kbw-navfoot-row' });
    row3.appendChild(
      div({
        cls: 'kbw-navfoot-text',
        text: state.indexReady ? `库 ${state.entryCount} 篇` : '库 索引中…',
      }),
    );
    this.statusHost.appendChild(row3);
  }

  private paintModule(state: WorkbenchState): void {
    const host = this.moduleHost;
    /**
     * ⚠️ **宿主到这儿已经是空的了**（`Region.paint` 先清后调渲染函数）——
     * 所以"记下上一屏的滚动位置"**不在这个函数里**，在订阅那条路上（见 `onOpen` 那段）。
     */
    // 换模块 / 降级状态变了 → 先把上一个模块的订阅与定时器收干净
    this.disposeModule();
    while (host.firstChild) host.removeChild(host.firstChild);

    // 降级一：库根被改名/移走（交互规格 §1.5 最后一行）
    if (state.kbRootMissing) {
      const empty = emptyState({
        kind: 'folder',
        title: '找不到知识库根目录',
        desc: `设置里写的是「${this.ctx.settings.kbRoot()}」，库里没有这个目录。改一下路径，或者把它改回来。`,
        action: { label: '打开设置', run: () => this.ctx.openNativeSettings() },
      });
      host.appendChild(empty);
      return;
    }

    // 降级二：索引未就绪 → 骨架屏（不空白、也不转圈）
    if (!state.indexReady) {
      host.appendChild(skeletonFor(state.activeModule));
      return;
    }

    const render = MODULE_RENDERERS[state.activeModule];
    if (!render) return;
    /**
     * 🔴 **渲染之前，把列头槽"认回自己那一份"**（P6 段⑥ 独立审查 A🔴1 抓的真 bug，有复现）。
     *
     * `ctx.colSlot` 与 `ctx.dock` 一样是**单槽**（多标签时后开的视图胜）。模块是在
     * `mount()` 里认依赖的（认一次、用到底），而**每次切模块模块都会重建** ——
     * 于是"分屏两个工作台标签、都停在全部笔记"时：两边的模块**都会**从 ctx 现取，
     * 拿到的是**后开那个视图**的槽 → 两个模块往同一个槽里 `replaceChildren`，
     * 互相顶掉 → **先建的那个视图的「目录」标题彻底消失**（槽里空、树里也空），
     * 它的 dispose 还会顺手摘掉别人槽里的表头。
     *
     * 修法就这一行：**渲染谁，谁把口子摆成自己的**（渲染是同步的，模块在同一拍里认走）。
     * 视图自己那份永远是 `myColSlot` —— 与本文件 `makeDockPort` 那条"外壳建宿主"同一个思路：
     * **外壳知道自己是哪一扇，模块不知道，那就别让模块去猜**。
     * ⚠️ 同样的道理适用于将来任何"进 ctx 的单槽资源"：**在渲染点重新认领**，
     * 而不是只依赖"开视图那一刻写进 ctx"。
     */
    if (this.myColSlot) this.ctx.colSlot = this.myColSlot;
    const wrap = div({ cls: 'kbw-mod' });
    host.appendChild(wrap);
    try {
      const cleanup = render(wrap, this.ctx);
      this.moduleCleanup = typeof cleanup === 'function' ? cleanup : null;
      /**
       * **同步画完的模块在这里补写回滚动位置**（视图记忆，e 期）。
       *
       * 为什么由外壳兜这一下：`home` / `graph` 是"内容自然流"，**滚动的是 `.kbw-modhost` 自己**
       *（模块内部没有自己的滚动容器），所以模块**够不着**那个容器 —— 只有外壳手里有它。
       * 反过来说，模块自己能写回的（notes 在 `mount()` 末尾消费掉、board 在画实那一刻
       * `claim`+写回）都**已经把快照取走了**，这里一问 `hasPendingScroll` 就是空操作 ✓
       * 于是一条规则管两边：**同步画的靠外壳兜底，异步画的（看板）自己认领**。
       */
      if (hasPendingScroll(state.activeModule)) recallScroll(state.activeModule, host);
    } catch (e) {
      console.error(`[经纬] 模块 ${state.activeModule} 渲染出错`, e);
      wrap.appendChild(
        emptyState({
          kind: 'search',
          title: '这个模块渲染出错了',
          desc: String(e),
        }),
      );
    }
  }

  private disposeModule(): void {
    const fn = this.moduleCleanup;
    this.moduleCleanup = null;
    if (!fn) return;
    try {
      fn();
    } catch (e) {
      console.error('[经纬] 模块卸载出错', e);
    }
  }

  private setModuleDirection(next: ModuleId): void {
    const nextIndex = MODULE_IDS.indexOf(next);
    if (this.lastModuleIndex >= 0) {
      this.root.setAttribute('data-dir', nextIndex >= this.lastModuleIndex ? 'down' : 'up');
    }
    this.lastModuleIndex = nextIndex;
  }

  private refreshTitle(): void {
    const active = this.ctx.store.get().activeModule;
    this.titleEl_.textContent = MODULES[active]?.label ?? '工作台';
    this.subEl.textContent = activeSubtitle(active);
    /**
     * 标签页标题也跟着走（半公开 API，没有就安静跳过）。
     *
     * ⚠️ **它只刷"标签页"那两个**（asar 取证：`updateHeader` 里只写
     * `this.tabHeaderInnerTitleEl.setText(this.getDisplayText())`）——**刷不了**
     * 标签上方那条平台标题栏（`.view-header-title`，它只在视图 `load()` 里设一次，
     * 之后只订阅 `group-change` / `history-change`，切模块不在其中；真机实测：
     * 手动调一次 `updateHeader()`，那条文本纹丝不动）。
     * 所以那条标题栏由**我们整条藏掉**（P7.0a 批 1③，`.kbw-workbench-leaf .view-header`，
     * 与内嵌图谱 `.kbw-graph-stage` / 小窗 `.kbw-cw-leaf` 同一个做法）——
     * 别再想着"把 updateHeader 接上去同步它"，那条路走不通，实测过的。
     */
    const leaf = this.leaf as unknown as { updateHeader?: () => void };
    leaf.updateHeader?.();
    /**
     * 顺手补一次标签页图标（f 期第 6 条）：`updateHeader()` 之后平台可能重画过那个框。
     * 幂等且便宜（`querySelector` + 一次比对），放在这条"标题变了"的必经之路上最省心。
     */
    this.applyTabIcon();
  }

  // ── 布局宽度（JS 量容器宽打 data-w；**不加 container-type**）──
  /**
   * 量容器宽打 `data-w`。
   *
   * 🔴 **停靠一开这里就错**（d2 开工提示词点名的三处之一）：原先量的是**整个工作台根**，
   * 而停靠是"从根里切一块给窗格" —— 根不变、主区变窄，于是**"该退化成窄档的没退化"** → 横向溢出。
   * 改法：**扣掉停靠宽再判**。
   *
   * ⚠️ **千万别改成量 `main`**：那会把 152px 导航宽度也算进去 → 现有断点整体漂移，
   * b 期与 c 期的窄档用例/探针会集体假红（这条是 d 期开工前就找出来的，别重踩）。
   * 量 `root` 再**只减窗格**，`dock` 为 `null` 时就是这一期之前的行为、逐字节不变。
   *
   * ⚠️ 裁决（放不放得下）走 `dockFit`，**只看容器原始尺寸**、不看夹过之后的落点 ——
   * 于是它不依赖自己的输出，不会"窄了退、退了又宽"来回翻（论证在 `ui/dock.ts`）。
   */
  private updateLayoutWidth(): void {
    const w = this.root.clientWidth || 0;
    const h = this.root.clientHeight || 0;
    /**
     * 🔴 **量不到尺寸时不许下结论**（d2 审查抓的）：`clientWidth/clientHeight` 为 0 有两种
     * 完全不同的情况 —— ① 刚挂上、还没布局；② **这一页被藏起来了**（非活动标签 / 窗口最小化）。
     * 按"不生效"处理的话，停靠态的面板会被踢出窗格、搬到 `document.body` 上飘着
     *（真机上"切到另一个标签去写字"就是这个形状），切回来又自己停回去 —— 一进一出很不稳。
     * 所以**沿用上一次的结论**，等真有尺寸了再说。
     *
     * ⚠️ `data-w` 那一段**不受这条影响**：它一直是"量不到就当 wide"（P0 起的行为），
     * 而且既有的挂载用例只覆盖 `clientWidth`（jsdom 里 `clientHeight` 恒 0）——
     * 一起拦会把那一批全弄红。这里只拦住"翻停靠生效状态"这一步。
     */
    const measurable = w > 0 && h > 0;
    const fit: DockFit = measurable
      ? dockFit(this.dockReq, w, h)
      : { applied: this.dockApplied, where: this.dockReq.where, size: this.dockReq.size };
    const eff = w === 0 ? 0 : Math.max(0, w - dockReserve(fit));
    const next = eff === 0 ? 'wide' : eff < NARROW_MAX ? 'narrow' : eff < MID_MAX ? 'mid' : 'wide';
    if (this.root.getAttribute('data-w') !== next) this.root.setAttribute('data-w', next);
    // 裁决结果落到 DOM，并在"生效没"翻转时通知面板搬进/搬出
    if (measurable) this.paintDock(fit);
  }

  // ── 键盘 ─────────────────────────────────────────────────────
  private wireKeyboard(): void {
    this.disposer.add(
      on(this.root, 'keydown', (evt) => {
        const kev = evt as KeyboardEvent;
        // 幂等：别用一次性的布尔量，否则外部清掉这个类之后就再也加不回来
        if (!this.root.classList.contains('kbw-kbd')) this.root.classList.add('kbw-kbd');
        // 菜单/模态自己处理过的事件已经在捕获阶段 stopPropagation，不会到这儿
        if (this.ctx.keymap.handle(kev)) {
          kev.preventDefault();
          kev.stopPropagation();
          return;
        }
        // 表里没有的键（F2 / mod+Enter）也按"当前模块"路由 —— 模块别自己挂 keydown，
        // 真实焦点在工作台根元素上，事件不会向下传到模块宿主
        if (this.ctx.keys.dispatchRaw(this.ctx.store.get().activeModule, kev)) {
          kev.preventDefault();
          kev.stopPropagation();
        }
      }),
    );

    // 点了工作台就把焦点交给容器，不然按键落不到这里
    this.disposer.add(
      on(this.root, 'mousedown', () => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body) {
          this.root.setAttribute('tabindex', '-1');
          this.root.focus();
        }
      }),
    );

    // ⚠️ 13 个动作**在插件层绑**（`main.ts` 的 onload）—— 不在这里绑：
    // 分屏开第二个工作台标签时，视图级的 bind 会互相顶掉，关掉一个会让另一个的
    // 全部表内快捷键失灵（`Keymap.bind` 每个动作只留最后一个处理函数）。
    // 这里只负责"把事件交出去"：先走 keymap（含 Esc 分层栈），再走模块的 raw 键。

    /**
     * 🔴 **F2 与平台撞车（P7.1c 真机实证，P1 起的老账）**：平台核心命令
     * `workspace:edit-file-title`（「重命名文件」）**默认键就是 F2**，它在 document 层
     * 把事件吃掉（`stopImmediatePropagation`）——根元素那套监听（上面那条）**永远收不到**，
     * 于是"F2 就地改名"（表格 P1 起 / 看板 P6 起 / 网格 P7.1c）在真机上从未生效过
     * （离线测不出：jsdom 没有平台层。按键实测：只有 F2 被吃，Del/Home/End/Alt+↑ 都正常）。
     *
     * 平台给的正路是 **Scope**：push 之后**平台自己的键盘管线会先把事件问我们**
     *（真机实测：合成派发的 F2 也会走这条管线）——不用抢事件、不占命令条数。
     *
     * 三条口径（都钉在判据里）：
     *   · 只在**键落在工作台里**时接管（`evt.target` 在本根之内）；别的标签页按 F2
     *     仍归平台的「重命名文件」（`return` 不消费 = 放行）；
     *   · 接管时走**与根元素监听完全同一条链**（keymap 14 动作 → 模块 raw 键）——
     *     不在这里另写一份 F2 逻辑；
     *   · **键在工作台里就一律消费**（`return false`）——不按"模块认不认"来放行：
     *     模块的 raw 分支约定是"动作自己跑 + 自己 preventDefault"（`onLocalKey` 的
     *     F2/Del 分支都不返回值），拿它的返回值当"处理了吗"会**误放行**；
     *     而工作台里的 F2 本来就**没有平台的正当含义**（`edit-file-title` 打的是
     *     "当前文件"——活动叶是工作台时那指向上一个笔记，纯属误伤）。
     */
    const f2Scope = new Scope();
    f2Scope.register([], 'F2', (evt) => {
      const kev = evt as KeyboardEvent;
      if (!(kev.target instanceof Node) || !this.root.contains(kev.target)) return;
      if (!this.root.classList.contains('kbw-kbd')) this.root.classList.add('kbw-kbd');
      /**
       * ⚠️ 与根监听的链条**逐字对齐**（独立审查 🟡4）：`handle` 认了就**别**再走 raw 键
       * —— 不这样，用户把某个全局动作改绑到 F2 之后，这一下会**双跑**（动作 + 改名的 raw 分支）。
       */
      if (this.ctx.keymap.handle(kev)) return false;
      this.ctx.keys.dispatchRaw(this.ctx.store.get().activeModule, kev);
      return false;
    });
    try {
      this.ctx.app.keymap.pushScope(f2Scope);
      this.disposer.add(() => {
        try {
          this.ctx.app.keymap.popScope(f2Scope);
        } catch {
          /* 平台版本差异就算了（视图都要关了，残留 scope 只是白跑一次判定） */
        }
      });
    } catch (e) {
      // 拿不到 pushScope（平台版本差异）→ 退回旧行为（F2 在工作台里继续被平台吃）
      console.error('[经纬] F2 的 Scope 没注册上，就地改名只剩右键菜单那条路', e);
    }
  }
}

function activeSubtitle(id: ModuleId): string {
  if (id === 'home') return '';
  if (id === 'notes') return '目录树 · 三档视图 · 批量操作';
  if (id === 'board') return '板块 · 卡片 · 就地编辑';
  /**
   * 回顾**不写副标题**：其余模块的副标题写的都是**已落地**的能力，
   * 「问答卡 · 间隔复习」与顶栏那一格的信息密度相比不值当 —— 空着最干净。
   */
  if (id === 'review') return '';
  return '内嵌官方图谱';
}

function skeletonFor(id: ModuleId): HTMLElement {
  const wrap = div({ cls: 'kbw-mod' });
  if (id === 'board') wrap.appendChild(skeleton('cards', 6));
  else if (id === 'home') wrap.appendChild(skeleton('home'));
  else wrap.appendChild(skeleton('table', 10));
  return wrap;
}
