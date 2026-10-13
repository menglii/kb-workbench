/**
 * modules/board/editor.ts —— **就地编辑面板**（快速编辑面，交互规格 §4.2；d 期 §3.1 起可多篇）
 *
 * ```
 * ┌─ 未锈铠 ───────────────────── [图钉] [⚙] [×] ┐
 * ├─ [未锈铠 ×][钩子草稿 ×][素材-3 ×]  ──────────┤   ← 只在 ≥2 篇时出现
 * │ 标题  [未锈铠                    ]           │
 * │ ──────────────────────────────────────────── │
 * │ 状态  [3-撰写中 ▾]   ← 值域来自属性规范       │
 * │ ──────────────────────────────────────────── │
 * │ ┌──────────────────────────────────────┐    │
 * │ │ 真 CodeMirror（正文）                 │    │
 * │ └──────────────────────────────────────┘    │
 * │                    [在新标签页打开][完成]     │
 * └──────────────────────────────────────────────┘
 * ```
 *
 * 为什么把"就地编辑"收进面板：卡片上原来分散着"点标题改名 / 点属性值改属性 /
 * 点正文改正文"三种点击，很容易误触（尤其是只想滚动看板的时候）。
 *
 * ── d 期：从"一个窗"变成"一组 tab" ────────────────────────────
 * §3.1 的原话："多篇分页 —— 窗格里开成一组 tab（一次编辑好几篇）；
 * **同一时刻只开一篇是现在最硬的限制**"。
 *
 * 🔴 **并发口径**（先定口径再动手 —— 旧限制就是被下面第 1 条逼出来的）：
 *  ① **同一个 path 只许有一个活着的叶**。两个编辑器改同一份文件 = 各自持一份 buffer、
 *     各自 `save()` 整份写回，后写的把先写的**整段冲掉**（不是"谁赢"那么温和，是丢改动）。
 *     所以面板内部**按 path 去重**：再点一篇已经在 tab 里的 = **切过去**，绝不新开。
 *     ⚠️ 去重必须**跟着改名走**（`vault.on('rename')` 重映射），否则改名之后
 *     同一篇会以两个 path 各占一个 tab —— 又变回两个编辑器。
 *  ② **切 tab 也 `save()`**：成本是一次写盘，换来一条可断言的不变量 ——
 *     "任何 tab 离开活动态时都已落盘"。它顺带挡住"切走之后插件崩了 / 被强杀"那条路。
 *  ③ **关 tab / 关面板一律 `await save()` 再 `detach()`**（顺序反了丢最后几秒输入，P4 实测）。
 *  ④ **面板是模块级单例，不随看板模块一起死**：切模块时钉住的留着（`record.deps` 指向
 *     最后一个活着的看板模块）；工作台视图关闭 / 插件卸载时才无条件收掉。
 *
 * ── d2 期：再进一步，它可以**停靠**（§3.1 的第三条能力）─────────
 * 从"浮在工作台上面"变成"钉在工作台边上"（左 / 右 / 下），仍然是一组 tab、各自挂真编辑器。
 *  · **停靠 ≈ 恒钉住**（IDE 的 tool window 不会因为点了别处就消失）
 *  · **窄档退回浮层**：主区挤到 640 以下就不停靠（判定在 `ui/dock.ts` 的 `dockFit()`）
 *  · 浮层那几套（`position:fixed` / 点外面关 / resize 关 / 头部拖动 / **Esc 关**）在停靠态下
 *    **整体失效** —— 实现全在 `ui/panel.ts` 的 `setDocked()`，这里只管"搬进搬出 + 落盘"
 *
 * 🔴 **两条平台坑（`坑/平台.md` 的 D 组）**：
 *  ① 就地挂编辑器 = `new WorkspaceLeaf(app)` + `setViewState({type:'markdown'})`，
 *     挂上去的 `containerEl` **自带 `.view-header`**（一整排导航条）→ 必须 CSS 藏
 *  ② **detach 之前必须 `view.save()`** —— 否则丢掉最后几秒的输入
 */
import type { Editor, MarkdownView, TFile } from 'obsidian';
import { Component, MarkdownRenderer, WorkspaceLeaf } from 'obsidian';
import type { WorkbenchContext } from '../../core/context';
import type { NoteEntry } from '../../core/vault-index';
import { div, el, span, btn, iconBtn, multiSelect } from '../../ui/primitives';
import { isOwnPopup, openFloating, type PanelHandle } from '../../ui/panel';
import { panelOwner, type DockOwner, type DockPort } from '../../ui/dock';
import { showContextMenu } from '../../ui/menu';
import { NOTIFY_MS, notify, notifyLight } from '../../ui/notify';
import { Disposer, clamp } from '../../core/util';
import { startPointerDrag } from '../../ui/dnd';
import { isEditable } from '../../core/keymap';
import { PROP_ORDER, SPEC_BY_NAME, asList, asString, declaredPositions, requiredFor } from '../../services/schema';
import { kbDirsOf } from '../../core/vault-index';
import { cardBody } from './summary';
import { insertTab, nextActiveAfterClose, remapPaths, resolveActive, sameTab } from './tabs';
import { notifyWindowFreed } from './window-seat';
import {
  applyPanelFont,
  applyPanelRatio,
  applyPanelScale,
  defaultPanelFont,
  foldTailHeading,
  nextFontSize,
  panelSplit,
  PANEL_FONT_DELTA,
} from './panel-ui';
import {
  PANEL_FONT_MAX,
  PANEL_FONT_MIN,
  PANEL_FONT_STEPS,
  panelContentFor,
  panelWrapFor,
  panelFontFor,
  panelPropsFor,
  panelRatioFor,
  withPanelPref,
  BoardConfigStore,
  type PanelContentMode,
  type PanelPropsMode,
} from './config';

export interface CardWindowCtx {
  ctx: WorkbenchContext;
  cfg: BoardConfigStore;
  refresh: () => void;
  /**
   * **笔记操作口**（P7.15 · #3 加；P7.16 · #2b 加 `declarePositionHere`）。
   *
   * 为什么小窗要它：`文件位置` 那两条链（"选哪儿搬哪儿" = 确认流 → mover → 快照 →
   * 撤销条 → 日志；"就住这儿" = 确认流 → 写声明）都已经有一份实现
   *（`modules/notes/ops.ts`）—— 小窗自己再拼一份就是**两处两制**，文案与日志口径会立刻漂。
   * 可缺省：离线单测直接渲染小窗（看板模块没接 ops 时）—— 那时选择器置灰并说明。
   */
  ops?: {
    setPositionByMove: (entries: NoteEntry[], dir: string, reason?: string) => Promise<void>;
    declarePositionHere: (entries: NoteEntry[]) => Promise<void>;
  };
  onReceipt: (text: string) => void;
  /** 面板里还开着哪几篇（含顺序）—— 看板据此给源卡片打「编辑中」标记 */
  onTabsChanged?: (paths: string[]) => void;
}

// ────────────────────────────────────────────────────────────────
// 面板集（f 期：**模块级单例 → N 个独立实例**）
// ────────────────────────────────────────────────────────────────
/**
 * **"文件已经不在了"这个关闭原因**。
 *
 * ⚠️ 必须是个**常量**：它有两处（`vault.on('delete')` 的处置、改名重映射里扫出来的 dropped），
 * 而判"要不要 save"用的也是它 —— 原先两边各写一份裸字符串，**当场就漂了**
 *（一处写 `'file-gone'`、一处写 `'源文件已被删除'`），症状是"文件被删之后面板还要 save 一次"
 *（真机上那就是**把删掉的文件写回来**）。离线用例抓到过，而且症状很阴：
 * **全量跑时红、单跑恰好绿**（因为全量里那条 delete 事件是先被另一条路径处理的）。
 */
const FILE_GONE = 'file-gone';
/** 一个 tab = 一篇笔记的一整页内容（切 tab 只 show/hide，**不重建** —— 重建会丢光标且要重挂编辑器） */
interface CwTab {
  path: string;
  file: TFile;
  /** 最后一次已知的索引项（索引里查不到时兜底；改了属性/改名后以索引为准） */
  entry: NoteEntry;
  /**
   * **我属于哪一扇窗**（f 期加）。
   *
   * 🔴 为什么必须带上：多窗之后，"这一页"与"那一扇"不再是一回事，
   * 而 editor.ts 里**十几处**函数（`paintProps` / `paintContent` / `writeProp` /
   * `mountEditor` / `renderPreview` / `gotoLineIn` …）原先都靠读模块级的
   * `panel` 单例来拿"我的那扇"。改成从 tab 自己身上取，是这一期最大的一处去单例化 ——
   * 少改一处的症状是**画到别人那扇窗里**（或画到一扇已被拆掉的窗里）。
   */
  panel: CwPanel;
  /** 这一篇的整页（属性块 + 正文块都在里面） */
  page: HTMLElement;
  /**
   * ⚠️ **P6b ⑤ 起没有"每页一个标题输入框"了**（独立审查 A🟡4）：输入框并进面板头、
   * **全窗共用一个**（`CwPanel.titleInput`）。原先这里那个 `titleInput` 字段是"每页一个"
   * 的旧假设残留 —— **全仓库没有一处读它**，留着只会让下一个人以为"这是这一页的输入框"。
   * 要取它一律走 `p.titleInput`（或 `p.h.setTitle`，它内部会判"正在打字就别动"）。
   */
  /** 属性块（`panelProps` 变了只重建这一块，不碰编辑器） */
  propsBlock: HTMLElement;
  /** 正文块（`panelContent` 变了重建这一块 —— 那一块才需要重挂编辑器） */
  contentBlock: HTMLElement;
  /** 属性 / 正文之间那根可拖的分隔条（第 5 条；两边都有内容时才显示） */
  splitter: HTMLElement;
  editorHost: HTMLElement;
  leaf: WorkspaceLeaf | null;
  view: MarkdownView | null;
  /** `save()` 防重入（同一个叶的两次 save 撞在一起没有好处） */
  saving: boolean;
  /**
   * 上一次画属性块 / 正文块时**这一篇**用的档位（覆盖 → 看板默认算出来的那个）。
   * ⚠️ f 期从"面板级"挪到"tab 级"：档位现在**每一篇可以不一样**
   *（`view.panelByPath[path]`），面板级那一份分不清"是哪一篇变了"。
   */
  lastProps: PanelPropsMode;
  lastContent: PanelContentMode;
  /** 尾链折叠跑过没有（只在挂上编辑器那一刻折一次；用户自己展开之后不再抢） */
  tailFolded: boolean;
}

interface CwPanel {
  /**
   * 实例号（从 1 起）。两个用途：
   *  · **停靠口子的占用者身份**（`panel#<n>`，见 `ui/dock.ts` 的 `DockOwner`）——
   *    多窗共用 `'panel'` 的话，乙窗关一下会把甲窗正占着的窗格收掉；
   *  · 探针/回执里认人（"哪一扇"）。
   */
  id: number;
  /** 我在那个单槽口子里的名字（`panel#<id>`，只算一次，别每次现拼） */
  owner: DockOwner;
  h: PanelHandle;
  tabs: CwTab[];
  /** 当前活动 tab 的 path */
  active: string;
  deps: CardWindowCtx;
  /** tab 条（`tabs.length >= 2` 时才显示） */
  strip: HTMLElement;
  /** 面板头里那个**唯一的**标题输入框（P6b ⑤：标题并进面板头，全窗共用） */
  titleInput: HTMLInputElement;
  /** 共用的底部按钮（作用于**当前 tab**） */
  footOpenTab: HTMLButtonElement;
  footOpenHere: HTMLButtonElement;
  /** 面板自己的 Component（`MarkdownRenderer.render` 的第 5 参）——
   *  **不借看板模块那一个**：面板比模块活得久，借来的会在切模块时被 unload 掉 */
  component: Component;
  d: Disposer;
  /** 正在跑「设置变了 → 重建」那一轮（重建期间别被自己的 cfg.onChange 再触发一次） */
  rebuilding: boolean;
  /**
   * 上一次报给看板的 tab 列表（拼成字符串）。
   * ⚠️ 用来**挡住没必要的通知**：看板那边判"变没变"是 `!==`（引用比较），
   * 每次都新造一个数组的话它**永远判成变了** → 每开/切一次 tab 都白重画一遍卡片状态。
   * 与 P4.5 §1.2 那条"只有收起态变了就别整块重绘"是同一类浪费。
   */
  lastNotified: string;
  /* ⚠️ `lastNotified` 现在**不再是判据**（并集的签名在模块级 `lastNotifiedUnion`）——
     留着只是"这一扇报过什么"的现场记录，别拿它当去重判据。 */
  /**
   * 当前那条 `cfg.onChange` 的退订函数。
   * 🔴 **切模块时要换到新 store 上**（见 `rebindCardPanel`）：面板跨模块存活，
   * 而它订阅的是**那一个** `BoardConfigStore` 实例 —— 旧 store 的 file watcher
   * 挂在旧模块的 Disposer 上，模块一卸就再也不 emit 了。
   */
  cfgUnsub: (() => void) | null;
  /**
   * **建面板时认下的那一个停靠口子**，此后一直用它。
   *
   * 🔴 为什么不每次从 `ctx.dock` 现取（d2 审查抓的）：`ctx.dock` 是**后开的那个视图胜**。
   * 分屏开两个工作台标签时，从 `ctx.dock` 现取会让面板"申请到别人的窗格上"，
   * 结果是**另一个标签边上留一条空的 380px 走廊**，而面板其实还在原来那一个宿主里。
   * 面板实际也不可能换视图活（它的视图一关就被收了），所以"认一次、用到底"就是对的。
   */
  dockPort: DockPort | null;
  /**
   * **嵌入式卡片窗**（P7.2d · 16.9-b B 档）：不只"停靠"，而是**住进首页块宿主**
   *（`openEmbeddedCardWindow`）。与普通停靠的区别是三件事：
   *  · 不走停靠口子（`dockPort = null`）—— `syncDock` 对它整体跳过，
   *    否则"配置变了 → 没人占口子 → 取消停靠"会把窗从块里弹出去；
   *  · 浮层专属动作（图钉 / 底部按钮 /「全部关闭」/ 拖 tab）**不接线**（没有去处）；
   *  · tab 条的 ✕ 改成调 `embedTabClose`（= "取消钉选"，见 `paintStrip`）。
   * ⚠️ 生命周期归**开它的那个块**：块 `cleanup()` → `destroyPanel(this)` ——
   * 与"钉住的面板跨模块活"是**相反**的口径（它是首页 DOM 的一部分，不是工作现场）。
   */
  embedded: boolean;
  /** 内嵌态 tab ✕ 的去向（由 `openEmbeddedCardWindow` 注入；普通窗是 null） */
  embedTabClose: ((path: string) => void) | null;
  /** 重新订阅"当前 deps 那个 store"的配置变更（`rebindCardPanel` 调） */
  bindCfg: () => void;
  /** 配置变了要重做的那几件事（换 store 之后也要立刻补做一次） */
  onCfg: () => void;
}

/**
 * **还开着的窗**（f 期：从单例改成集合）。
 * ⚠️ 用 `Set` 的**插入顺序**当真源：`panelPaths()` 报给看板的顺序、
 * "第一个窗"这类判据都靠它稳定（换 `Map` 也行，但别换成无序结构）。
 */
const panels = new Set<CwPanel>();
/** 实例号发号器（从 1 起；占用者身份 `panel#<n>` 会写进停靠口子，别复号） */
let panelSeq = 0;
/**
 * **最近交互的那一扇**（用户 2026-09-26 拍板的口径）。
 *
 * 三件事认它（都是这一期定下来的）：
 *  · 单击卡片 → 这一篇落到**哪一扇**（没有窗就新建一扇）
 *  · `Esc` / "点外面" 关**哪一扇**（只关它；别人的窗不受影响）
 *  · "停靠面板"菜单作用在**哪一扇**（窗格只有一个口子）
 *
 * 更新点只有一处：面板根上的 `pointerdown` / `focusin`（捕获阶段）——
 * 用它而不是"谁最后创建"，因为用户的多窗操作大半是**来回点**而不是新开。
 */
let activePanel: CwPanel | null = null;
/**
 * **最近交互的那一扇"浮层"窗**（f 期独立审查 🔴3 加的第二个变量）。
 *
 * 为什么不能只留 `activePanel` 一个：停靠的那一扇**没有"点外面"这回事**
 *（`ui/panel.ts` 对停靠态早退），可它照样可以是"最近交互"的那一扇 —— 那样一来
 * 点空白时**谁都不关**（停靠那扇不接这一下，浮层那扇又因"不是最近交互"被豁免）。
 * 所以"点外面关谁"看这个变量：它只会被**非停靠**的窗更新。
 */
let activeFloating: CwPanel | null = null;
/**
 * **这一发 `mousedown` 该由谁负责关**（事件级快照）。
 *
 * 🔴 为什么要快照（独立审查 🔴2）：每扇窗的"点外面"监听都挂在 `document` 上、**按注册顺序**跑。
 * 甲先跑 → 关掉自己 → `onClose` 里改 `activeFloating` → 乙后跑时读到的已经是**改过的**值 →
 * 判据失效、乙也关（实测："最近交互的那一扇 = 先建的那一扇"时一点空白两扇全没）。
 * 在**捕获阶段**先把"该关谁"定下来（捕获一定早于所有冒泡监听），后面谁先谁后都不影响判据。
 */
let outsideTarget: CwPanel | null = null;
let outsideTrackerReady = false;
/** 确保那一个 document 级监听只装一次（编辑器模块被反复 import 也不会叠） */
function ensureOutsideTracker(): void {
  if (outsideTrackerReady || typeof document === 'undefined') return;
  outsideTrackerReady = true;
  document.addEventListener(
    'mousedown',
    () => {
      outsideTarget = activeFloating;
    },
    true,
  );
}
/**
 * **认领了停靠窗格的那一扇**（单槽：同一时刻只许一扇窗停靠）。
 *
 * 🔴 为什么认领要跟配置分开记（口径 ③）：
 *  · `view.dock.where` 是**看板级**的一格偏好（"窗格在哪一边"），它没有"哪一扇窗"这个概念；
 *  · 而 N 扇窗**都**读同一个配置的话，每扇都会去 `port.request(...)` —— 窗格只有一个口子，
 *    后申请的把前一个挤掉，用户看到的是"两扇窗来回抢窗格"。
 * 所以"谁去占"是**认领制**：建窗时如果没人认领就认领（第一扇窗照配置停靠，与单窗时行为一致）、
 * 或者用户在菜单里显式点停靠时改判给最近交互的那一扇；认领者关掉 → 让出来（`notifyWindowFreed()`）。
 */
let dockingPanel: CwPanel | null = null;

/** 面板里还开着哪几篇（**所有窗的并集**；看板据此打「编辑中」标记） */
export function panelPaths(): string[] {
  const out: string[] = [];
  for (const p of panels) for (const t of p.tabs) out.push(t.path);
  return out;
}

/** 现在开着几扇窗（菜单/探针用；0 = 没有窗） */
export function panelCount(): number {
  return panels.size;
}

/**
 * **可选的"并入目标"**（P6b ③）：每扇窗一条（`id` + 篇数 + 首篇名字）。
 *
 * 为什么要它：合并的**主路径是拖动**（拖头到另一扇身上），而 WCAG 2.2 的
 * Dragging Movements 要求**每个拖动都有一个非拖动的等价操作** —— 与看板卡片排序的
 * 「上移/下移」、停靠大小的「窄/中/宽」是同一批口径。卡片菜单里那条「并入别的窗…」用它。
 *
 * @param exclude 排除某一扇（通常是"这一篇所在的那一扇"—— 并进自己没意义）
 */
export function mergeChoices(exclude: number | null): { id: number; label: string }[] {
  const out: { id: number; label: string }[] = [];
  for (const p of panels) {
    if (p.id === exclude) continue;
    /**
     * ⚠️ **内嵌窗不是"并入目标"**（P7.2d）：它的 tab 条 = 钉选清单，
     * 往里并一篇「没有钉过的」笔记会被下一次 `sync` 收走（并入即消失）。
     * 它也不该作为源出现在这（块内不接拖 tab，✕ 是取消钉选）。
     */
    if (p.embedded) continue;
    const first = p.tabs[0] ? liveEntry(p, p.tabs[0]).basename : '（空）';
    out.push({ id: p.id, label: `小窗 #${p.id}（${p.tabs.length} 篇 · ${first}）` });
  }
  return out;
}

/** 这一篇现在开在哪一扇窗里（没开 = null）—— 卡片菜单要拿它算"排除哪一扇" */
export function panelOfPath(path: string): number | null {
  for (const p of panels) if (p.tabs.some((t) => t.path === path)) return p.id;
  return null;
}

/**
 * **把 A 并进 B**（`mergeChoices` 那条非拖动等价物的落点）。
 * @returns 真的并了 = true（id 对不上 / 已经是同一扇 = false，不报错）
 */
export function mergeWindowInto(fromId: number, intoId: number): boolean {
  if (fromId === intoId) return false;
  let from: CwPanel | null = null;
  let into: CwPanel | null = null;
  for (const p of panels) {
    if (p.id === fromId) from = p;
    if (p.id === intoId) into = p;
  }
  if (!from || !into) return false;
  mergePanelInto(from, into);
  return true;
}

/** 最近交互的那一扇的实例号（没有窗就是 null）——菜单据此决定"停靠作用在谁身上" */
export function activePanelId(): number | null {
  return activePanel ? activePanel.id : null;
}

/** 此刻**真的**停在窗格里的那一扇（探针用；"打算占"是另一回事，见 `panelClaimsWindow`） */
export function dockedPanelId(): number | null {
  for (const p of panels) if (p.h.isDocked()) return p.id;
  return null;
}

/**
 * 把**最近交互的那一扇**设为停靠认领者（"停靠面板"菜单点下去之前调）。
 *
 * 没有窗就什么都不做：`view.dock` 照写（下次点开卡片直接落进窗格 —— d2 定的口径），
 * 只是"现在的这几扇窗"谁都不去占（那时也没有窗可占）。
 */
export function claimDockForActive(): void {
  /**
   * ⚠️ **内嵌窗不认领**（独立审 F3 的同一族；分屏时它可能是"最近交互"的那一扇）：
   * 名额到手它也永不 `request`（`syncDock` 早退），等于把窗格名额锁死。
   */
  if (activePanel && !activePanel.embedded && panels.has(activePanel)) {
    dockingPanel = activePanel;
  }
}

/**
 * 把某一扇窗提到最上（最近的交互）：Esc 关它、点击落在它里面、`z` 序在其它窗之上。
 * 顺带把它记成 `activePanel`。
 */
function raisePanel(p: CwPanel): void {
  if (!panels.has(p)) return;
  activePanel = p;
  /**
   * ⚠️ **停靠的那一扇不更新 `activeFloating`**：它不接"点外面"那一下，
   * 更新了就等于"把点外面的靶子指到一个关不掉的东西上"（独立审查 🔴3）。
   * 菜单/"最近交互"仍然认它（那是另一个问题，看 `activePanel`）。
   */
  if (!p.h.isDocked()) activeFloating = p;
  p.h.raise();
}

/**
 * 在**所有窗**里找这一篇（跨窗去重，口径 ②）。
 *
 * 🔴 为什么跨窗也要求唯一：同一份文件两个活编辑器 = 各持一份 buffer、各自整份写回，
 * **后写的把先写的冲掉**（丢字，不报错）。d 期只在一扇窗的 tab 之间守这条，
 * 多窗之后必须跨窗守 —— 用户完全可能在第 2 扇窗里再点一次同一张卡。
 * 命中时**跳到那一扇**（并把它提到最上），绝不新开。
 */
function findTabAnywhere(path: string, file: unknown): { panel: CwPanel; tab: CwTab } | null {
  /**
   * ⚠️ 判据本身**不在这一处重写**：仍然走 `tabs.ts` 的 `sameTab`
   *（"路径相同**或**同一个文件对象"—— 第二条挡的是改名之后索引还没刷新的那一小段窗口）。
   * 这里只是把探针对象造出来（`sameTab` 只读 `path` 与 `fileOf` 的结果）。
   */
  const probe = { path, file } as unknown as CwTab;
  const fileOf = (t: CwTab): unknown => t.file;
  for (const p of panels) {
    for (const t of p.tabs) if (sameTab(t, probe, fileOf)) return { panel: p, tab: t };
  }
  return null;
}

/**
 * **在新的一扇窗里打开这一篇**（f 期新入口：卡片菜单「打开 › 在新悬浮窗中打开」）。
 *
 * 与 `openCardTab` 的唯一区别是"目标窗"：这里**强制新建**。但**跨窗去重仍然先跑**
 * （口径 ②）—— 已经开着的话跳过去并说一声，绝不为"新窗"这个意图破例。
 */
export function openCardWindow(
  entry: NoteEntry,
  c: CardWindowCtx,
  at?: { line: number | null },
  opts: { quiet?: boolean } = {},
): void {
  const gotoLine = at?.line ?? null;
  const hit = findTabAnywhere(entry.path, entry.file);
  if (hit) {
    /**
     * **已经开着 → 抬到最前 + 闪一下**（P6b ③，用户原话："点到**相同文件强调一下
     * 已打开的窗口**"）。
     *
     * ⚠️ 这条**推翻了 f 期**的"单击进最近交互那扇 + 加一个 tab"：现在的模型是
     * **一文件一扇窗**（单击卡片 = 开一扇新窗；要并在一起靠"拖窗合并"或 tab 拖进去）。
     * 所以这里不再新建 tab，只把人带到那一扇前面 + 给一个看得见的"就是它"。
     *
     * `quiet` = 单击卡片那条路（闪一下就够了，别再弹一条回执 —— 那是菜单入口才需要的说明）。
     */
    /**
     * ⚠️ **内嵌窗不动 deps**（P7.2d）：它的 deps 是首页那条链（插件级单例），
     * 换成调用方（看板模块 / 最近改动的桥）之后，那个来源一卸载它就抱着死引用。
     * 其余动作照做 —— flash 它在首页块里同样看得见（"就是你要的那篇"）。
     */
    if (!hit.panel.embedded) hit.panel.deps = c;
    activate(hit.panel, hit.tab.path);
    raisePanel(hit.panel);
    hit.panel.h.flash();
    if (gotoLine != null) void gotoLineIn(hit.tab, gotoLine);
    if (!opts.quiet) c.onReceipt('这一篇已经在一个小窗里了（已经抬到最前）');
    return;
  }
  const p = createPanel(c);
  openTabInto(p, entry, gotoLine);
  raisePanel(p);
  if (!opts.quiet) c.onReceipt('已在新小窗里打开');
}

/** 在某个坐标上开一扇新窗（"把 tab 拖出去拆成一扇窗"那条路用；不传就按看板列顶） */
export function openWindowAt(c: CardWindowCtx, at: { x: number; y: number }): CwPanel {
  const p = createPanel(c, at);
  raisePanel(p);
  return p;
}

// ────────────────────────────────────────────────────────────────
// 内嵌卡片窗（P7.2d · 16.9-b B 档）＋ 插件级小窗依赖
// ────────────────────────────────────────────────────────────────
/**
 * **插件级小窗依赖**（P7.2d）：看板模块**没挂载**时也能开卡片窗的那一份 deps。
 *
 * 🔴 为什么非有不可：模块是"切到谁才挂谁"，而首页块（钉住的笔记）与「最近改动」的桥
 * 都**在首页**用到卡片窗 —— 那一刻看板模块已被卸载。原口径"board 模块挂载时挂桥"
 * 在落点上永远拿不到，所以桥与 B 档共用这一个单例（见 `期末交接-P7.2.md` 2d 段的修正记录）。
 *
 * 四条口径：
 *  · 自带一份 `BoardConfigStore`：读写走共享的 `ctx.configs`，与看板模块那份**同一份文件**；
 *  · 读盘是异步的 —— 读完 `rebindCardPanel` 把配置补做一遍（与看板模块同一条：
 *    `load()` 自己不 emit，"配置就绪"只有加载方知道）；
 *  · 🔴 **接 `watchExternal`**（独立审 F1）：不接的话"设置 → 看板 → 改小窗正文/字号"这类
 *    **从别的入口写**配置的动作，内嵌窗**永久不跟**（它不像看板模块那样每次挂载都重读）——
 *    症状是"设置改了没用"，且切模块再回来也不自愈（单例数据只读过一次）。
 *  · `onReceipt` 落通知（首页没有看板那条回执栏）；`refresh` / `onTabsChanged` 空操作 ——
 *    它们服务的"看板卡片镜像"那一刻本来就没挂载。
 */
let windowDeps: CardWindowCtx | null = null;
/** 单例那份 `watchExternal` 的退订（换 ctx / 理论上换单例时收掉旧的） */
let windowDepsUnwatch: (() => void) | null = null;
export function ensureWindowDeps(ctx: WorkbenchContext): CardWindowCtx {
  if (windowDeps && windowDeps.ctx === ctx) return windowDeps;
  windowDepsUnwatch?.();
  windowDepsUnwatch = null;
  const cfg = new BoardConfigStore(ctx);
  const deps: CardWindowCtx = {
    ctx,
    cfg,
    refresh: () => {},
    onReceipt: (text) => notify({ kind: 'info', text, ms: NOTIFY_MS.info }),
    onTabsChanged: () => {},
  };
  windowDeps = deps;
  windowDepsUnwatch = cfg.watchExternal();
  void cfg
    .load(false)
    .then(() => {
      if (windowDeps === deps) rebindCardPanel(deps);
    })
    .catch((e) => {
      console.error('[经纬] 小窗依赖：读看板配置失败（按默认值继续）', e);
    });
  return deps;
}

/** 内嵌窗的把手（首页块拿它同步/重放/收尾；**生命周期归块**，见 `CwPanel.embedded`） */
export interface EmbeddedWindowHandle {
  /** 与钉选清单对齐：**收多的**（save+detach）、**加缺的**（全局去重，已在别处的搬进来）、按排序重排 */
  sync(paths: string[]): void;
  /** 块重绘之后把窗放回**新宿主**（同一个节点，不重建）+ 让每篇的编辑器重新量一次 */
  rehost(host: HTMLElement): void;
  /** 收干净：每篇先 save 再 detach、拆壳 —— 块 `cleanup()` 的唯一去处（**不留悬挂叶**） */
  destroy(): void;
  /** 里面现在开着哪几篇（顺序） */
  openPaths(): string[];
  /**
   * **这一扇还活着吗**（独立审 F2）：被"块外"的路收掉（如别的窗把它最后一篇搬走 →
   * `destroyPanel`）之后，块若还抱着旧把手，rehost/sync 全在静默空转 → **块剩一个空框**、
   * 且只有块重建才自愈。paint 拿到把手先问这一句，死了就弃掉重开。
   */
  isAlive(): boolean;
}

/**
 * **开一扇内嵌卡片窗**（P7.2d · 16.9-b B 档）：把真卡片窗停进任意宿主（首页块）。
 *
 * 与普通小窗共用全套（tab / 真编辑器 / 属性写回 / ⚙ 显示设置），差别见
 * `CwPanel.embedded`：不上图钉、不摆底部按钮与「全部关闭」、不接拖 tab 与停靠口子，
 * tab 的 ✕ 调 `onTabClose`（= 取消钉选）。
 */
export function openEmbeddedCardWindow(
  c: CardWindowCtx,
  host: HTMLElement,
  entries: NoteEntry[],
  opts: { onTabClose?: (path: string) => void } = {},
): EmbeddedWindowHandle {
  /**
   * ⚠️ 顺序：**先 `setDocked` 再挂 tab** —— `openTabInto` 里挂真编辑器的落行重试
   * 依赖"页已进 DOM 且能参与布局"，先停进宿主，第一帧量到的就是对的尺寸。
   */
  const p = createPanel(c, undefined, true);
  p.embedTabClose = opts.onTabClose ?? null;
  p.h.setDocked(host);
  for (const e of entries) addEmbeddedTab(p, e);
  const first = entries[0];
  if (first) activate(p, first.path); // 打开就停在第一篇（不是"最后加进来的那篇"）
  return {
    sync: (paths) => syncEmbeddedTabs(p, paths),
    rehost: (next) => {
      if (!panels.has(p)) return;
      next.appendChild(p.h.root);
      // 重新进 DOM / 换了容器宽度 → 每篇都催一次重排（CodeMirror 只在被通知时才重新量）
      for (const t of p.tabs) refreshEditor(t);
    },
    destroy: () => destroyPanel(p, 'embedded-close'),
    openPaths: () => p.tabs.map((t) => t.path),
    isAlive: () => panels.has(p),
  };
}

/**
 * 加一篇进内嵌窗。**全局一文件一扇窗去重**（口径 ②）在这里也守着：
 *  · 已经在这扇里 → 什么都不做；
 *  · 在**别处**开着（浮层或窗格里）→ **搬进来**（`adoptTab` 换父节点，同一个活编辑器，
 *    不重建、不丢光标）—— 钉住的笔记在首页就是"住在这个块里"；不搬的话块里会缺一篇
 *    （看着像没钉上），或者两处各开一个编辑器（同一文件双写 = 丢改动）。
 *    搬空的旧窗顺手收掉（与拖窗合并同一条路）。
 *  · 🔴 **别的内嵌窗不抢**（独立审 F2）：分屏开两个工作台标签都停首页时，两块各有一扇窗 ——
 *    让它们互相"搬进来"就是乒乓（A 搬空 B → B 重建时再搬回 A）：症状是两块交替变空框。
 *    抢的语义（"钉住的笔记住在这个块里"）只对**浮层/窗格**的窗成立；内嵌窗之间**先到先得**，
 *    后来的那块显示"没抢到的"那几篇（极端情况下为空 —— 边缘布局，记档接受）。
 */
function addEmbeddedTab(p: CwPanel, entry: NoteEntry): void {
  const hit = findTabAnywhere(entry.path, entry.file);
  if (hit) {
    if (hit.panel === p) return;
    if (hit.panel.embedded) return; // 兄弟内嵌窗里开着 → 不抢（见上）
    if (adoptTab(hit.panel, p, hit.tab)) {
      paintStrip(hit.panel);
      if (hit.panel.tabs.length === 0) destroyPanel(hit.panel, 'merged-into-home');
    }
    return;
  }
  openTabInto(p, entry, null);
}

/** 与钉选清单对齐（收多的 / 加缺的 / 按清单排序）—— `handle.sync` 的实现 */
function syncEmbeddedTabs(p: CwPanel, want: string[]): void {
  if (!panels.has(p)) return;
  const wantSet = new Set(want);
  for (const t of [...p.tabs]) {
    if (!wantSet.has(t.path)) void closeTab(p, t.path, 'embed-sync');
  }
  // 收空了 = 整扇没了（`closeTab` 关最后一篇那条路）—— 后面的都别做了
  if (!panels.has(p)) return;
  for (const path of want) {
    if (p.tabs.some((t) => t.path === path)) continue;
    const entry = p.deps.ctx.index.get(path);
    if (!entry) continue; // 索引里查不到（刚删 / 改名还没迁完）→ 不画死路径
    addEmbeddedTab(p, entry);
  }
  if (!panels.has(p)) return;
  // 按清单顺序排（`p.tabs` 的次序 = strip 与"右邻居"规则的依据）
  const rank = new Map(want.map((w, i) => [w, i]));
  p.tabs.sort((a, b) => (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER));
  paintStrip(p);
}

/**
 * **这个点下面是哪一扇窗**（P6b ③：拖窗合并 / 把 tab 拖出去拆窗都要问它）。
 *
 * 用 `elementsFromPoint` 而不是 `elementFromPoint`：跟着光标走的那一扇（或正在拖的那个）
 * **就在光标底下**，`elementFromPoint` 只会返回最上面那个 —— 而它往往正是"源"本身。
 * 从后往前找第一个**不是 exclude 的** `.kbw-cw-panel`。
 */
function panelUnder(point: { x: number; y: number }, exclude: CwPanel | null): CwPanel | null {
  const stack =
    typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(point.x, point.y)
      : [document.elementFromPoint(point.x, point.y)];
  for (const el of stack) {
    const root = (el as HTMLElement | null)?.closest?.('.kbw-cw-panel') as HTMLElement | null;
    if (!root) continue;
    const id = Number(root.dataset.win ?? '');
    for (const q of panels) if (q.id === id && q !== exclude) return q;
  }
  return null;
}

/**
 * **把"合并落点"的观感成对地加上/摘掉**（P6b ③）：目标窗**整窗描边** + 顶部那条
 * 「松手并入这一扇」。
 *
 * 🔴 真机实测抓到过一次"只加了提示条、没加描边"（第一版就是这么写的）：判据里明明有
 * 「目标窗被点亮」这一条，而实现只做了提示条 —— 两件事**必须一处加一处摘**，
 * 分成两个函数写迟早漏掉一个（`source` 那个参数只为让它顺手把源窗的标记也带上）。
 */
function setMergeTarget(target: CwPanel | null, source: CwPanel | null): void {
  if (!target) {
    for (const p of panels) {
      p.h.root.classList.remove('is-merge-target');
      p.h.root.querySelector('.kbw-panel-merge-hint')?.remove();
    }
    return;
  }
  target.h.root.classList.add('is-merge-target');
  showMergeHint(target, true);
  void source;
}

/** 合并时的那个提示条（"松手并入这一扇"）—— 挂在目标窗上，松手/取消都要收干净 */
function showMergeHint(target: CwPanel, on: boolean): void {
  const prev = target.h.root.querySelector('.kbw-panel-merge-hint');
  if (!on) {
    prev?.remove();
    return;
  }
  if (prev) return;
  target.h.root.appendChild(div({ cls: 'kbw-panel-merge-hint', text: '松手并入这一扇' }));
}

/**
 * **把一扇窗并进另一扇**（P6b ③，用户原话："一个窗口**拖到别的窗口触发合并**"）。
 *
 * 口径（设计稿那张状态表）：
 *  · 逐篇按**顺序**搬进目标窗；**同一篇去重**（目标里已有 → 只留它那一份，并说一声）；
 *  · 搬的是**同一批 DOM/叶**（`adoptTab` 只改父节点与归属，绝不重建 —— 重建 = 丢光标）；
 *  · 搬完 **A 关掉**（`destroyPanel(本扇)`：只收自己那一扇，别扫别人）；
 *  · A 若是停靠占用者 → 让出口子由 `onClose` 那段统一做（e 期"认人"那条口径）。
 */
function mergePanelInto(from: CwPanel, into: CwPanel): void {
  if (from === into || !panels.has(from) || !panels.has(into)) return;
  const moved: string[] = [];
  const dup: string[] = [];
  for (const t of [...from.tabs]) {
    if (adoptTab(from, into, t)) moved.push(liveEntry(into, t).basename);
    else dup.push(t.path.split('/').pop() ?? t.path);
  }
  paintStrip(into);
  paintStrip(from);
  const last = into.tabs[into.tabs.length - 1];
  if (last) activate(into, last.path);
  notify({
    kind: dup.length > 0 ? 'partial' : 'info',
    text: `已并入「${into.tabs.length} 篇」那一扇`,
    detail:
      moved.length > 0
        ? `搬过去：${moved.slice(0, 4).join('、')}${moved.length > 4 ? '…' : ''}` +
          (dup.length > 0 ? `｜已在那一扇里（跳过去了）：${dup.slice(0, 3).join('、')}` : '')
        : '那几篇本来就在目标窗里',
    ms: NOTIFY_MS.info,
  });
  if (from.tabs.length === 0) destroyPanel(from, 'merged');
  else paintStrip(from);
}

/**
 * **把一篇从一扇窗搬到另一扇**（合并、以及"拖 tab 到别的窗"共用）。
 *
 * @returns 真的搬过去了 = true；目标窗里已经有这一篇 = false（调用方负责把它关掉/跳过）
 */
function adoptTab(from: CwPanel, into: CwPanel, tab: CwTab): boolean {
  const fileOf = (t: CwTab): unknown => t.file;
  if (from !== into && into.tabs.some((t) => sameTab(t, tab, fileOf))) {
    // 同一篇两个活编辑器 = 丢改动（d 期口径 ①）→ 我们这一份**必须先 save 再 detach**
    from.tabs = from.tabs.filter((t) => t !== tab);
    void saveTab(tab, 'merge-dup').then(() => dropTab(tab));
    return false;
  }
  from.tabs = from.tabs.filter((t) => t !== tab);
  tab.panel = into;
  into.tabs = [...into.tabs, tab];
  /**
   * ⚠️ **搬的是同一个节点**（页面里挂着真编辑器叶）：`appendChild` 换父即可，
   * 绝不重建。之后催一次重排 —— 换了容器宽度，CodeMirror 不重算就会按旧宽度排行。
   */
  into.h.body.appendChild(tab.page);
  tab.page.dataset.path = tab.path;
  refreshEditor(tab);
  return true;
}

/** 把一篇放进某一扇窗（开 tab → 挂页 → 画正文 → 激活）—— `openCardTab` / `openCardWindow` 共用 */
function openTabInto(p: CwPanel, entry: NoteEntry, gotoLine: number | null): void {
  /**
   * **去重的判据在 `tabs.ts`**（`insertTab`：已经在里面就什么都不做）。
   * ⚠️ 第二条判据（**同一个文件对象也算同一篇**）不能省 —— 它挡的是
   * "改名之后索引还没刷新"那一小段窗口里点卡片（独立审查 🟡3 实测：
   * 只按 path 判会开出第二个 tab，而它的路径指向**已经不存在的旧路径**）。
   */
  const fileOf = (t: CwTab): unknown => t.file;
  const res = insertTab(p.tabs, createTab(p, entry), fileOf);
  if (!res.added) {
    // 已经在这一扇里 → 切过去（跨窗那半截在 `findTabAnywhere` 已经挡掉了）
    const exist = p.tabs.find((t) => sameTab(t, { path: entry.path } as CwTab, fileOf)) ?? null;
    if (exist) {
      activate(p, exist.path);
      if (gotoLine != null) void gotoLineIn(exist, gotoLine);
    }
    return;
  }
  const candidate = res.tabs[res.tabs.length - 1];
  /**
   * 把"这一篇想让编辑器落在哪一行"写在**页**上（a.5-5 的探针判据）。
   * ⚠️ 真源从"面板 root"挪到"页"了：多篇之后每个 tab 各有各的落点行，
   * 写在面板上会互相覆盖（探针据此分辨"实现把行号算错了"还是"编辑器收下了但没动"）。
   */
  candidate.page.dataset.gotoLine = gotoLine == null ? 'none' : String(gotoLine);
  /**
   * 🔴 **顺序要紧**：先建页 → 入列 → **挂进面板** → 再画正文（挂编辑器）。
   * 反过来的话，`mountEditor` 会把真编辑器挂进一个**还没进 DOM 的页**里 ——
   * CodeMirror 在游离节点上量不到尺寸，落行那套重试会空转到超时
   *（症状：光标没落上、`scrollIntoView` 白调，而"行号算对了"这件事看起来又是对的）。
   */
  p.tabs = res.tabs;
  candidate.page.dataset.path = candidate.path;
  p.h.body.appendChild(candidate.page);
  paintContent(candidate, gotoLine);
  activate(p, candidate.path);
}

/**
 * 关面板。`keepPinned` 是给**看板模块卸载**用的：钉住时留着（切模块不该把我的编辑现场弄没），
 * 工作台视图关闭 / 插件卸载则**无条件收**（那时候连宿主都没了）。
 */
export function closeCardPanel(
  opts: {
    keepPinned?: boolean;
    reason?: string;
    /**
     * **"停在别人窗格里就别收"**（多标签，d2 审查抓的）：传进来"我这一页的窗格宿主"，
     * 面板若停在**别的**宿主里就原样留着 —— 关掉一个不相干的工作台标签，
     * 不该把另一个标签里的编辑现场弄没。不传 = 老行为（无条件收）。
     */
    keepIfDockedOutside?: HTMLElement;
  } = {},
): void {
  /**
   * 🔴 **逐扇判**（f 期）：多窗之后这三条留/收的规矩**每扇窗各判一次** ——
   * 早先是"读单例 → 判一次 → 收"，多窗之后那样写会变成"只收第一扇"或"全收"，
   * 而这两条都不对（钉住的那扇该留、没钉的那扇该走，是**同一次调用里**的事）。
   */
  for (const p of Array.from(panels)) {
    if (
      opts.keepIfDockedOutside &&
      p.h.isDocked() &&
      p.h.root.parentElement !== opts.keepIfDockedOutside
    ) {
      /**
       * ⚠️ **内嵌窗天然落进"停在别处"这一支**（P7.2d 独立审 🟢7）：它的父节点是首页块、
       * 不是任何窗格 —— 于是这里会**跳过**它。这是刻意的：
       *  · 单视图：它由**块 cleanup** 收（`disposeModule` 在视图关闭时先跑，顺序钉着）；
       *  · 分屏：乙视图关窗时，甲视图首页里那扇**不该**被乙收掉 —— 跳过正是保护。
       * 代价是"顺序改成 closeCardPanel 先跑"会漏一扇 —— 那条顺序在 `workbench-view.ts`
       * 有注释钉着，改那边时要连这条一起看。
       */
      continue;
    }
    /**
     * ⚠️ **停靠也算"该留着"**（d2）：停靠 ≈ 恒钉住（IDE 的 tool window 不会因为
     * 切了个模块就消失）。少了 `isDocked()` 这一半，切走再回来窗格就空了 ——
     * 而且配置里还写着"停靠着"，下次点卡片又冒出来，看着像随机行为。
     */
    if (opts.keepPinned && (p.h.isPinned() || p.h.isDocked())) continue;
    destroyPanel(p, opts.reason ?? 'close');
  }
}

/**
 * **把认领着窗格的那一扇收掉**（e 期那条互斥的另一半：Peek 要窗格时把停靠的面板收掉）。
 *
 * ⚠️ 与 `closeCardPanel` 的区别（f 期必须分开）：那个是"把窗都收了"，
 * 而这里**只收占着窗格的那一扇** —— 其余窗是浮层，本来就与 Peek 不冲突
 *（用户随手点开的两扇小窗不该因为开了预览就一起没）。
 */
export function closeDockingPanel(reason: string): void {
  const p = dockingPanel;
  if (p && panels.has(p)) destroyPanel(p, reason);
}

/**
 * **看板模块卸载时调的是它**：钉住的留着，没钉住的收掉（d 期拍板：面板跟着工作台，
 * 不跟着模块 —— 切去看一眼笔记再回来，编辑到一半的几篇不该没）。
 * 单独一个名字而不是给 `closeCardPanel` 加参数：调用点只有两处，
 * 名字本身就该说清"我是被模块卸载调到的"。
 */
export function keepPinnedPanel(): void {
  closeCardPanel({ keepPinned: true });
}

/**
 * **看板模块重建时，把自己的依赖重新交给面板**（d2 修的真缺陷）。
 *
 * 🔴 为什么必须有：面板是**跨模块存活**的（d 期拍板："面板跟着工作台、不跟着模块"），
 * 而它订阅的是 `deps.cfg` —— **那一个** `BoardConfigStore` 实例。切走再切回来，
 * 模块是新的、带一个**新的 store**；旧 store 的 file watcher 挂在旧模块的 Disposer 上，
 * 随模块一起收了 → 旧 store 从此再也不 `emit`。于是"换停靠边 / 钉住 / 切档"
 * 这些**写配置**的入口对它全都失聪，直到用户再点一张卡片
 *（`openCardTab` 会顺带 `p.deps = c` 刷新一次）。
 *
 * 症状很阴：面板好端端停在那儿，你从菜单换了边，它纹丝不动 ——
 * 而"停靠位"这一期恰恰全靠配置驱动，所以 d2 把它顶到了明面上。
 * 离线判据：`真链路 · 切走模块再回来，面板仍然跟着配置走`（先红后修的那一条）。
 */
export function rebindCardPanel(deps: CardWindowCtx): void {
  /**
   * 🔴 **每一扇都要 rebind**（f 期）：d2 修的是"单例订阅了旧 store"，
   * 多窗之后同一个坑会按扇数复发 —— 漏掉的那一扇对配置**永久失聪**
   *（换停靠边 / 钉住 / 切档全都不动），而且它看着好端端的，只有用户会发现。
   *
   * ⚠️ **内嵌窗只认它自己那一份 deps**（P7.2d）：它的来源是插件级单例
   *（`ensureWindowDeps`）。分屏这种"另一个视图在看板、这个视图在首页"的场面上，
   * 看板模块挂载时的 rebind 不该把块内那扇接到看板模块身上（那个会卸载）。
   * 判据用**身份**：单例自己来 rebind 时 `p.deps === deps`，照样重订、不误伤。
   */
  for (const p of Array.from(panels)) {
    if (p.embedded && p.deps !== deps) continue;
    p.deps = deps;
    p.bindCfg();
  }
  /**
   * ⚠️ **配置还没读出来的时候别急着按它重排**：`BoardConfigStore.load()` 是异步的，
   * 而且它**读完不 `emit`**（只有 `save` / `watchExternal` 会）—— 这里若按一份
   * 尚未加载的默认值（`dock: null`、`panelPinned: false`）去重排，就会把刚停靠好的
   * 窗格**卸掉**，此后没有任何人再纠正它（离线实测：切模块回来窗格就没了）。
   * 所以没 `loaded` 就只接线，把"补做一遍"交给加载完那一条路
   * （`BoardModule.reloadCfg` 里再调一次本函数 —— 那时 `loaded` 已经是 true）。
   */
  if (!deps.cfg.isLoaded()) return;
  for (const p of Array.from(panels)) p.onCfg();
}

// ────────────────────────────────────────────────────────────────
// 停靠（d2 期 §3.1）
// ────────────────────────────────────────────────────────────────
/**
 * 让面板的"待在哪儿"跟上**配置**与**容器** —— 进出停靠的**唯一落点**。
 *
 * 三条都可能把人叫醒：建面板时、配置变了（菜单换边/取消）、容器尺寸变了（外壳通知）。
 * 前两条走这里；容器那条走 `onChange` 订阅（只需搬进/搬出，不必重新请求）。
 *
 * ⚠️ 外壳没起来的时候（离线单测直接渲染看板模块）`ctx.dock` 是 undefined ——
 * 那时**按浮层显示**、不抛错。配置里写着停靠也不报错（只是这次没生效）。
 */
function syncDock(p: CwPanel): void {
  /**
   * 🔴 **已经拆掉的窗不许再碰口子**（f 期实测抓的，多窗之后才暴露的真缺陷）。
   *
   * `emit()` 是"**先拷一份订阅者、再逐个叫**"（`BoardConfigStore.onChange` 与 `ConfigFiles`
   * 都是这个写法）→ 于是**在这一次配置变更里被收掉的那一扇**，它那条已退订的 `onCfg`
   * 仍会被叫到一次。单例时代看不出毛病（收了就是没了）；多窗之后后果很实：
   * 它照着配置**再 `request()` 一次**（它还认领着停靠），把刚拿到窗格的预览顶掉 ——
   * 离线实测的症状是：预览开起来、**转身就被关掉**（`closePeek('panel-took-window')`），
   * 而屏幕上那扇"抢窗格"的窗**根本不存在**。
   *
   * 判据用"我还在不在 `panels` 里"——**显式状态**，与 `ui/panel.ts` 的 `didClose` 同一条纪律
   *（别拿 `isConnected` 之类的间接信号推断"我还活着"，那正是 d2 那条 🔴 的教训）。
   */
  if (!panels.has(p)) return;
  /**
   * 🔴 **内嵌窗在这里整体跳过**（P7.2d）：它的"停靠"是 `setDocked(块宿主)`、
   * 与看板配置里的 `view.dock` 毫无关系。少了这一句，下面 `!port` 那一支
   * 会把它判成"该回浮层"，**当场把窗从首页块里弹出去**——而且配置一变就来一次。
   */
  if (p.embedded) return;
  // ⚠️ 用**建面板时认下的那一个口子**，不是 `p.deps.ctx.dock`（多标签时后者是"最后开的那个视图"）——
  //    见 `CwPanel.dockPort` 上那段：现取会让面板申请到别人的窗格上、留下一条空走廊。
  const port = p.dockPort;
  const want = p.deps.cfg.get().view.dock;
  if (!port) {
    if (p.h.isDocked()) p.h.setDocked(null);
    return;
  }
  /**
   * 🔴 **`dock.where` 为空（不停靠）时别去 `request(null)`**（e 期离线用例抓到的）：
   * 那个口子是**单槽**，`request(null)` 会把**别人**（预览窗格）正占着的窗格一起收掉 ——
   * 症状是"点一张卡片看一眼，旁边的预览**凭空就没了**"（而预览那边什么都没做错）。
   * 只有"**此刻真的是我占着**"时才需要让出去（问的是口子的身份，不是自己的 `isDocked`）。
   */
  if (want.where == null) {
    if (port.owner() !== p.owner) return;
    port.request(null, want.size, p.owner);
    return;
  }
  /**
   * 🔴 **认领制**（f 期口径 ③）：窗格只有一个口子，而 `view.dock.where` 是**看板级**的
   * 一格偏好 —— N 扇窗都照它去 `request(...)` 的话，后申请的会把前一个挤掉，
   * 用户看到的是"两扇窗来回抢窗格"。所以：
   *  · 我是认领者 → 照配置申请（换边、改大小、容器够不够都走这条）；
   *  · 有别人认领着（且它还在）→ **我不申请**，老实待在浮层；
   *  · 没人认领（第一次建窗 / 认领者已经关了）→ 我认领（第一扇窗照配置停靠，
   *    与单窗时的行为**逐字节一致**）。
   */
  if (dockingPanel !== p && dockingPanel && panels.has(dockingPanel)) return;
  dockingPanel = p;
  port.request(want.where, want.size, p.owner);
  applyPanelDock(p);
}

/**
 * **按口子此刻的样子**把面板搬进 / 搬出窗格 —— **唯一落点**。
 *
 * 🔴 为什么必须抽出来（e 期独立审查抓的真缺陷）：搬进/搬出原先抄了两份 ——
 * `syncDock`（配置变了）与 `dockPort.onChange`（容器尺寸变了）。两份的判据不一样：
 * `onChange` 那份只问 `applied`，**不问配置**，于是"挤窄再拉宽"会把一个**浮层态**的
 * 面板拽进窗格（实测：`dockerKids` 里多出 `kbw-cw-panel is-docked`，还把预览的窗格挤掉了）。
 * 现在的判据是三合一，且只写一遍：**口子生效 ∧ 占用者是我 ∧ 配置里说了要停靠**。
 */
function applyPanelDock(p: CwPanel): void {
  const port = p.dockPort;
  if (!port) return;
  // 同上：拆掉的窗不参与（`onChange` 那一趟同样是"先拷一份订阅者"的写法）
  if (!panels.has(p)) return;
  const mine =
    port.applied() && port.owner() === p.owner && p.deps.cfg.get().view.dock.where != null;
  if (mine && !p.h.isDocked()) attachDock(p, port.host);
  else if (!mine && p.h.isDocked()) detachDock(p);
}

/**
 * 搬进窗格。**搬的是同一个根节点**（`setDocked` 只 `appendChild` + 换类名）——
 * 里面每一页挂的都是真的 `MarkdownView`，重建 = 丢光标、可能丢最后几秒输入。
 * 搬完必须催一次 `Editor.refresh()`：面板刚从 `position:fixed` 变成流式元素，
 * 宽高都变了（理由见 `refreshEditor`）。
 */
function attachDock(p: CwPanel, host: HTMLElement): void {
  p.h.setDocked(host);
  refreshEditor(activeTab(p));
}

/**
 * 搬回浮层（取消停靠 / 容器挤不下了）。`setDocked(null)` 会按当前锚点重摆一次。
 *
 * ⚠️ **这里不喊"窗格让出来了"**（e 期独立审查的 🟡4）：曾经在这儿加过一声
 * `notifyWindowFreed()`，理由是"面板滑回浮层时窗格空出来了、预览该收回去" ——
 * 但审查实测：**那件事已经被别人兜住了**（一次配置变更里 `cfg.onChange → syncPeek`
 * 会照配置再算一遍），而且那条路**零覆盖**（删掉它全套用例照样全绿）。
 * 守不住又不缺它，就是"文档承诺了、代码冗余、用例没人守" —— 删掉。
 * 真正需要那声喊的是**面板关掉**那一刻（`onClose` 里），那一处有判据守着。
 */
function detachDock(p: CwPanel): void {
  p.h.setDocked(null);
  refreshEditor(activeTab(p));
}

/**
 * **这个面板打算占着窗格吗**（e 期）—— 给看板仲裁"谁该让位"用。
 *
 * 判据 = **我开着 ∧ 配置里说了停靠**（"浮层态的面板不占窗格，两者不冲突"，
 * 所以"配置里没说停靠"的面板不该被预览挤掉）。
 *
 * 🔴 与"**此刻真的占着**"（`h.isDocked()`）**不是一回事**，别拿后者替：
 * 被别人抢走的那一瞬间 `isDocked()` 是 `false`，而它**仍然打算**占着
 * （下一次配置变更它就会再申请一次）。用错的那个会漏掉这一瞬 ——
 * 离线实测的症状：预览开起来 → 面板被"要让位"判定放过 → 它先滑回浮层、
 * 紧接着把自己的申请补上，**把预览又挤掉**（来回一次，最后留在界面上的是面板）。
 */
export function panelClaimsWindow(): boolean {
  /**
   * ⚠️ f 期多窗之后，"打算占着"这句话只对**认领者**成立（口径 ③：只许一扇窗停靠）——
   * 拿"有窗开着 ∧ 配置说停靠"当判据的话，浮层里的第二扇窗也会被算成"打算占"，
   * 于是预览一开就把**它**收掉（而它从没打算停靠）。
   */
  return dockingPanel != null && panels.has(dockingPanel) && dockingPanel.deps.cfg.get().view.dock.where != null;
}

/**
 * 「在新标签页打开」= **把这一篇交出去**（d2 拍板的口径修正）。
 *
 * 🔴 原先这个按钮是**直接开**一个平台标签，而面板里那个自造的编辑器叶还活着 ——
 * 同一份文件两个活编辑器，各持一份 buffer、各自整份 `save()` 写回，
 * **后写的把先写的整段冲掉**（丢字，不报错）。它正好撞上 d 期口径 ①
 * 「同一 path 只许一个叶」，只是当时没人走到这条路上（d 期独立审查点出来的）。
 *
 * 现在的语义：`await save()` → 关掉面板这一篇（`closeTab`，含 detach 叶）
 * → 再让平台开标签。**不变量回来了**：任何时刻一份文件只有一个编辑器。
 * 代价是这一篇从面板里走了（多篇时只走它自己，其余 tab 不动）——
 * 按钮的 `title` 里写明了。
 */
async function handOffToTab(p: CwPanel, tab: CwTab, opts: { quiet?: boolean } = {}): Promise<void> {
  const file = tab.file;
  await closeTab(p, tab.path, 'open-in-tab');
  try {
    await p.deps.ctx.app.workspace.getLeaf('tab').openFile(file);
    if (!opts.quiet) p.deps.onReceipt('已在标签页打开（面板这一篇先关掉了）');
  } catch (e) {
    console.error('[经纬] 在标签页打开失败', e);
  }
}

/**
 * **升格：把卡片这一篇交出去，变成平台标签页**（P6 段⑥ ⑤，2026-09-28 拍板）。
 *
 * 这就是「双击卡片」那一下。**单击照旧立即开小窗**（一个字没变），双击只是把那个结果
 * 抬到标签页 —— 于是"不延迟单击"与"双击升格"同时成立（旧决策否掉的是**延迟判定**，不是手势）。
 *
 * 🔴 **走的必须是同一条已验证的路**（`handOffToTab`，小窗底部那个按钮）：
 * `save()` → `detach()` 自造叶 → 平台 `getLeaf('tab').openFile()`。
 * ⚠️ 为什么不是"把自造叶挪进平台标签区"（那么写"没有重挂闪烁"，看着更好）：
 * **平台没有这个 API** —— 那个叶是我们 `new WorkspaceLeaf(app)` 挂在自有容器里的，
 * 进不了平台的标签区。这里能复用的只有"同一份文件、同一时刻只有一个活编辑器"这条不变量，
 * 而 `handOffToTab` 正是靠**先收后开**保证它的（d2 拍板的口径修正）。
 *
 * 两种起点都要接（提示词点名的那条）：
 *  · **小窗里正开着这一篇**（双击之前那一下单击已经走完 `openCard`）→ 交出去；
 *  · **没开着**（只读模式刚放开、或第一下没开成）→ 直接让平台开标签，别假装还有个窗。
 */
export async function promoteToTab(
  entry: NoteEntry,
  c: CardWindowCtx,
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const hit = findTabAnywhere(entry.path, entry.file);
  if (hit) {
    /**
     * ⚠️ `quiet` 默认**关**（不弹回执）：双击这条路的反馈就是"那一页真的出现在标签栏里、
     * 小窗里没了" —— 与单击那条"闪一下就是反馈"同一个口径。底部那个按钮不一样：
     * 它是从一列按钮里点出来的，说一句"这一篇从面板里走了"才不突兀。
     */
    await handOffToTab(hit.panel, hit.tab, opts);
    return;
  }
  try {
    await c.ctx.app.workspace.getLeaf('tab').openFile(entry.file);
    if (!opts.quiet) c.onReceipt('已在新标签页打开');
  } catch (e) {
    console.error('[经纬] 升格到标签页失败', e);
  }
}

// ────────────────────────────────────────────────────────────────
// 面板骨架
// ────────────────────────────────────────────────────────────────
function createPanel(c: CardWindowCtx, at?: { x: number; y: number }, embed = false): CwPanel {
  /**
   * 实例号与占用者身份（f 期）。**先发号再建窗**：`owner` 要在建 `openFloating`
   * 之前就算好（`onClose` / 停靠那几条路都会用到它）。
   */
  const id = ++panelSeq;
  const owner = panelOwner(id);
  /**
   * 面板自己的 Component（`MarkdownRenderer.render` 的第 5 参必须是它，
   * 否则核心从插件栈帧报内存泄漏）。**它活到面板关闭为止** ——
   * 早先借的是看板模块的 component，而面板现在比模块活得久（切模块不关它）。
   */
  const component = new Component();
  component.load();
  const d = new Disposer();

  /**
   * ⚠️ **这两个按钮里的"我那一扇"要用 `self`（闭包），不许读被点的那一扇**：
   * 按钮是**每扇各有一套**的（建窗时就挂好了），点哪一扇的图钉就改哪一扇 ——
   * 早先读模块级单例，多窗之后会变成"点乙窗的图钉、改的是甲窗"。
   */
  const pinBtn = iconBtn('pin', '钉住（点外面不关）', () => {
    const p = self;
    if (!p) return;
    const next = !p.h.isPinned();
    // 写配置 → `cfg.onChange` 绕回来落到 `applyPinned`（两处入口共用一条真的落地路径）
    void p.deps.cfg.patchView({ panelPinned: next }).then(() => {
      p.deps.onReceipt(next ? '面板：已钉住（点外面不关）' : '面板：不再钉住');
    });
  });
  const gear = iconBtn('settings', '小窗显示设置（属性 / 正文 / 字号）', (evt) => {
    const p = self;
    if (!p) return;
    const tab = activeTab(p);
    if (!tab) return;
    openPanelSettings(evt as MouseEvent, tab, p.deps, () => rebuildAll(p), p);
  });

  /**
   * 🔴 **`onClose` 必须通过 `self` 拿自己，不能读模块级的 `panel`**（本期的真 bug）：
   * `destroyPanel()` 会**先把 `panel` 置空**再 `h.close()`（免得关闭回调里再读到正在拆的这一个），
   * 于是 `onClose` 里 `panel` 已经是 null → `closeAllTabs` 整段被跳过 →
   * **剩下的 tab 的叶一个都没 detach**（症状：面板收得干干净净、叶却留在工作区里）。
   * 离线用例量到过：开 3 篇、关中间一篇、再"全部关闭" → 漏 2 个叶。
   */
  let self: CwPanel | null = null;
  /** 头部拖动时"现在悬在哪一扇窗上"（P6b ③ 合并的落点；null = 当前没有目标） */
  let mergeTarget: CwPanel | null = null;
  /**
   * **标题输入框**（P6b ⑤）：它进**面板头那一行**（右留图钉 / ⚙），全窗共用。
   *
   * 三条口径：
   *  · **提交改的是"当前那一篇"**（`activeTab`）—— 输入框不再属于某一个 tab；
   *  · `Enter` 提交、`blur` 提交（与旧版完全一致的手感，改名走 `mover`）
   *  · ⚠️ **别在 `activate` 里无条件刷它的值**：那会在用户正打字时把字抹掉 ——
   *    由 `p.h.setTitle()` 内部判"焦点在不在这里"（见 `ui/panel.ts`）。
   */
  const titleInput = el('input', {
    cls: 'kbw-input kbw-cw-title',
    attr: { type: 'text', 'aria-label': '标题', placeholder: '标题' },
  });
  const commitTitle = (): void => {
    const p2 = self;
    if (!p2) return;
    const t = activeTab(p2);
    if (!t) return;
    const next = titleInput.value.trim();
    if (!next || next === liveEntry(p2, t).basename) return;
    titleInput.value = next;
    void renameTab(t, next);
  };
  titleInput.addEventListener('keydown', (evt) => {
    const k = evt as KeyboardEvent;
    if (k.key === 'Enter') {
      k.preventDefault();
      commitTitle();
    }
  });
  titleInput.addEventListener('blur', commitTitle);
  const h = openFloating({
    /**
     * ⚠️ **给的是元素不是文案**（P6b ⑤）：头里那一格从此是这个输入框本身。
     * 传 `title` 的话会再建一个标题元素（两个标题）。
     */
    titleEl: titleInput,
    width: 'normal',
    /**
     * **在被点那一列的顶部居中**（用户 2026-09-25 的口径）：
     * 不要屏幕中间，要所点击的文件窗格**中心的顶部**。
     * 多篇之后位置取**当前这一篇**所在的那一列（切 tab 时跟着重摆）。
     */
    // `at` = "把 tab 拖出去拆窗"的落点（不传就贴当前卡片那一列的顶部）
    topCenter: at ?? columnTopCenter({}),
    /**
     * **内嵌态不上图钉**（P7.2d）：它在块宿主里是静止的 —— "钉住"（点外面不关）
     * 对它没有语义，写进配置反而会污染普通窗的默认。⚙ 保留：属性显示 / 字号 /
     * 正文档 / 分隔条比例都是**用户自己的选择权**，块内一样要有
     *（⚙ 里的「窗口大小」组在停靠态本来就自动置灰，见 `openPanelSettings`）。
     */
    headActions: embed ? [gear] : [pinBtn, gear],
    pinned: embed ? false : c.cfg.get().view.panelPinned,
    /**
     * **可缩放**（P6b ③）：右下角一个把手，拖动改宽高（夹在 280×200 → 视口 90%）。
     * ⚠️ 尺寸**只记会话内存**（不进配置）—— 与 f 期"tab 列表是工作现场、不过库"同一条口径。
     * 键盘/触屏的等价物在 ⚙ 菜单的「窗口：窄 / 中 / 宽」。
     */
    resizable: true,
    /**
     * **几何记忆（4.3-②，Q3 拍板"全记尺寸+位置"）**：
     *  · 开窗时用 `data.json` 里记着的「全局默认」`panelGeo`（没记过 = null →
     *    照旧锚在被点那一列的顶部）；
     *  · 拖完/缩完**结束那一下**才写回（`settings.save` 自己还带防抖）——
     *    **会话内各窗互不影响**这条口径没变，变的只是"新窗从哪儿开始"。
     * ⚠️ 别把它塞进 `panelByPath`（那是每篇偏好的家）；几何是全局一份，见 `settings.ts`。
     * ⚠️ **内嵌态不读也不写它**（几何归块宿主，落盘只会污染"新窗从哪儿开始"）。
     */
    initialGeo: embed ? null : c.ctx.settings.get().panelGeo,
    onGeometryChange: (geo) => {
      if (embed) return; // 内嵌窗的"几何"是块给的 —— 拖/缩那两条路在停靠态本来就不可达，这里是同口径的兜底
      void c.ctx.settings.save({ panelGeo: geo });
    },
    onResize: (size) => showSizeBadge(size),
    /**
     * **拖头合并**（P6b ③）：把一扇窗的头拖到另一扇身上 → 目标窗描边 + 「松手并入这一扇」。
     *
     * 三条边界（设计稿那张状态表）：
     *  · **没有目标**：窗口留在原地不动，松手什么都不发生（不落地、不新建位置）；
     *  · **目标是别人**：源窗半透明（不然它压着目标窗，看不出"并进去的是哪一扇"）；
     *  · **取消**（`pointercancel` / Esc）：高亮全部撤掉，什么都不做。
     */
    onHeadDrag: (phase, point, dropped) => {
      const me = self;
      if (!me) return;
      if (phase === 'start') {
        mergeTarget = null;
        return;
      }
      if (phase === 'end') {
        const target = mergeTarget;
        setMergeTarget(mergeTarget, null);
        me.h.root.classList.remove('is-merge-source');
        mergeTarget = null;
        if (dropped && target) mergePanelInto(me, target);
        return;
      }
      // move
      const hit = panelUnder(point, me);
      if (hit !== mergeTarget) {
        setMergeTarget(mergeTarget, null);
        setMergeTarget(hit, me);
        mergeTarget = hit;
      }
      me.h.root.classList.toggle('is-merge-source', hit != null);
    },
    /**
     * 🔴 **点一张卡片 / 点面板自己开的菜单，都不算"点外面"**
     * （真机实测 + 独立审查各抓到一条，离线桩看不见）。
     *
     * "点外面就关"听的是 **mousedown**，而下面这些交互**同样**会先发 mousedown：
     *  · **点卡片** = "在这个面板里再开一篇"（本期主路径）→ 不豁免的话 mousedown 先关面板、
     *    紧接着的 click 又开一扇新的，**上一篇就没了** —— 多篇分页永远攒不起来
     *    （真机实测：连点三张只攒出 1 页；离线 `H.click` 只派 click，所以那套当时全绿）。
     *  · **点菜单项**（⚙ → 小窗正文 → 某一档）→ 不豁免的话"就地重建，不关窗"根本做不到，
     *    面板会被那一下 mousedown 关掉（独立审查 🟡4 实测）。
     *
     * ⚠️ 不豁免整个看板：点**板块空白处 / 板块头**仍然是"我去干别的了"，照关。
     * 钉住的时候本来就不关（那条判据在 `ui/panel.ts` 里，优先级更高）。
     *
     * ⚠️ "哪些算自己人"（菜单 / 多选下拉）那份知识**留在浮层那一层**：`ui/panel.ts` 的
     * `isOwnPopup()`。看板**不写菜单类名** —— 写了就撞项目那条
     * "看板不许自建菜单：弹菜单只能过 `ui/menu.ts`"的红线（它按类名字符串判，作者当场撞了一次）。
     *
     * ── f 期多窗补的两条（用户 2026-09-26 拍板："只关最近交互的那个"）──
     *  · **点别的窗不算"外面"**：不豁免的话，点一下乙窗就把甲窗关掉 ——
     *    两扇没钉住的小窗永远没法同时开着（点谁谁关）。
     *  · **不是最近交互的那一扇，这一下不归我关**：点空白只关掉"当前那一扇"。
     */
    ignoreOutsideClick: (t) =>
      t?.closest?.('[data-card]') != null ||
      isOwnPopup(t) ||
      t?.closest?.('.kbw-cw-panel') != null ||
      /**
       * ⚠️ 两条要点（独立审查 🔴2/🔴3）：
       *  · 判据读的是**这一发事件的快照**（`outsideTarget`），不是活的 `activeFloating` ——
       *    否则先关掉的那一扇会改掉判据，后面那扇跟着一起关；
       *  · 快照里的那一扇**必须是浮层**（停靠的关不掉，靶子不该指向它）。
       */
      (outsideTarget != null && outsideTarget !== self),
    onClose: () => {
      const p = self;
      if (p) panels.delete(p);
      /**
       * ⚠️ **别把"最近交互"置空**：置空会让下一发事件里"谁都不是最近交互"，
       * 于是所有浮层窗都以为自己该关（独立审查 🔴2 的另一半）。
       * 交给**还在的最后一扇**（插入顺序），用户再点它一下就能关。
       */
      if (activePanel === p) activePanel = Array.from(panels).pop() ?? null;
      if (activeFloating === p) {
        const rest = Array.from(panels).filter((x) => !x.h.isDocked());
        activeFloating = rest[rest.length - 1] ?? null;
      }
      /**
       * **认领的那扇走了 → 把窗格名额让出来**（f 期口径 ③）：不清的话，
       * 别的窗永远"有人认领着"，谁也不去占那个口子（配置说停靠却谁都不停）。
       */
      if (dockingPanel === p) {
        dockingPanel = null;
        /**
         * 🟡1（f 期独立审查）：**认领者走了要当场交接**，不能等"下一次配置变更"。
         * 原先只把名额置空 —— 于是"配置里写着停靠、界面上没人停"会一直保持到
         * 用户碰巧改了任何一个设置（那时还开着的那扇才想起认领）。
         * 交接规则：交给**还开着的最后一扇**（插入顺序）；它自己会照配置申请窗格。
         * ⚠️ 预览开着时不抢（那时候窗格归预览是既有口径，e 期有判据守着 ——
         * `onWindowFreed` 那条路会让它收回去）。
         * ⚠️ **内嵌窗不接交**（独立审 F3）：它 `syncDock` 整体早退（位置归块宿主），
         * 名额落到它身上 = 永远没人在真窗格上认领 → 之后所有新窗都不再自动停靠
         *（"配置写着停靠、界面没人停"的症状回归）。
         */
        const next = Array.from(panels).pop();
        if (
          next &&
          !next.embedded &&
          next.deps.cfg.get().view.dock.where != null &&
          !next.deps.cfg.get().view.peekEnabled
        ) {
          dockingPanel = next;
          syncDock(next);
        }
      }
      /**
       * 🔴 **`p.d.dispose()` 必须在 `onClose` 里**（独立审查 🟡5）：这是**所有**关闭路径的
       * 必经之地（Esc / 头部 ✕ / 点外面 / resize / purge 都是直接调 `h.close()` 的），
       * 而原先只有 `destroyPanel` 那一条路会 dispose → 每关一次漏一条 cfg 订阅 + 一对 vault 监听，
       * 整份死面板还被闭包钉住（离线数桩的 Emitter 表实测到"每关一次累加一对"）。
       */
      try {
        p?.d.dispose();
      } catch (e) {
        console.error('[经纬] 收面板的监听失败', e);
      }
      /**
       * **窗格收起，但配置不动**（d2）：`view.dock` 是"这个面板该怎么待着"的偏好
       *（与 `panelPinned` 同级），下次点开卡片还该停在那儿；这里只是把宿主让出来，
       * 免得工作台边上空着一条。⚠️ 顺序在 `d.dispose()` **之后**、`closeAllTabs`
       * **之前**都行，但必须在这个 try 块外面 —— 它自己也要 try。
       *
       * 🔴 **只有"我是占用者"时才让**（e 期补的那半句）：窗格就一个，
       * 而 `request(null)` 是不认人的 —— 浮层态的面板（没停靠）关一下，
       * 会把**预览窗格**正占着的那个窗格收掉（e 期两套占用者共存之后才可达）。
       * 判据问的是面板自己（`isDocked()` = 外壳裁决生效、我确实在里面），
       * 与上面 `onResize` 那条守卫同源。
       */
      try {
        /**
         * **只有"此刻真的是我占着"才撤窗格**（口子的身份说了算，不是自己的 `isDocked`）：
         * 被别人抢走之后再关面板，这一句会把**别人**正占着的窗格一起撤掉（e 期审查抓的）。
         */
        if (p && p.dockPort?.owner() === p.owner) {
          p.dockPort.request(null, p.deps.cfg.get().view.dock.size, p.owner);
        }
      } catch (e) {
        console.error('[经纬] 收窗格失败', e);
      }
      /**
       * **面板走了就喊一声**（e 期）—— 不论它刚才占没占着窗格：
       *  · 占着（停靠态）→ 窗格腾出来了，该由"配置里说开着"的预览收回去；
       *  · 没占着（浮层态）→ 也可能是它刚才把预览挤掉了（`openCard` 那条路），
       *    这一刻"窗格该归谁"的答案要重新算一遍（见 `window-seat.ts` 的头注释）。
       *
       * 喊一声是**幂等**的：听者只在"配置说开着、而我此刻没占着"时才动。
       * ⚠️ 顺序要紧：**在 `request(null)` 之后**喊 —— 反过来的话听者当场抢回去、
       * 紧接着这次 `request(null)` 又把它收掉，屏幕上就是"闪一下没了"。
       */
      try {
        notifyWindowFreed();
      } catch (e) {
        console.error('[经纬] 通知窗格让位失败', e);
      }
      // 关整扇：每个 tab 各自 save + detach（顺序在 tab 自己那一段里保证）
      if (p) void closeAllTabs(p);
      try {
        p?.deps.onTabsChanged?.([]);
      } catch (e) {
        console.error('[经纬] 关面板回调出错', e);
      }
      try {
        p?.component.unload?.();
      } catch (e) {
        console.error('[经纬] 收面板组件出错', e);
      }
    },
  });
  h.root.classList.add('kbw-cw-panel');
  /**
   * **尺寸浮标**（P6b ④）：`Ctrl+Shift+滚轮` 或拖右下角把手时，面板头右侧浮一行
   * 「420 × 560」，**手势结束 800ms 后淡出**（连续手势不重复闪 —— 每次重置那个定时器）。
   * ⚠️ 它是"这一扇窗"的现状，所以挂在头里（不是通知栈）：眼睛不用离开正在拖的那一角。
   */
  const sizeBadge = span({ cls: 'kbw-cw-size', attr: { 'aria-live': 'off' } });
  h.root.querySelector('.kbw-panel-head')?.appendChild(sizeBadge);
  let sizeBadgeTimer = 0;
  function showSizeBadge(size: { w: number; h: number }): void {
    sizeBadge.textContent = `${Math.round(size.w)} × ${Math.round(size.h)}`;
    sizeBadge.classList.add('is-on');
    window.clearTimeout(sizeBadgeTimer);
    sizeBadgeTimer = window.setTimeout(() => sizeBadge.classList.remove('is-on'), 800);
  }
  /** 钉住落到界面上（图钉的高亮态 + 文案）。**持有按钮引用**，不用选择器去猜。 */
  const applyPinned = (pinned: boolean): void => {
    h.setPinned(pinned);
    pinBtn.classList.toggle('is-on', pinned);
    pinBtn.setAttribute('aria-label', pinned ? '取消钉住' : '钉住（点外面不关）');
    pinBtn.setAttribute('title', pinned ? '取消钉住（点外面就关）' : '钉住（点外面不关）');
    h.root.classList.toggle('is-pinned', pinned);
  };
  applyPinned(c.cfg.get().view.panelPinned);
  /**
   * 图钉按钮挂个记号：**停靠态下用 CSS 把它藏起来**（`styles/board.css`）。
   * 停靠 ≈ 恒钉住 —— 那时候图钉点不点都一样，留着一个能点但看不出效果的开关
   * 比藏起来更让人犯嘀咕（"两处入口同一个开关"那条不变：空白处右键里还有一份）。
   */
  pinBtn.classList.add('kbw-pin-btn');

  // 面板级的一条：改名 / 删除要跟着走（**挂事件，不挂按钮** —— 改名有四个入口）
  const vault = c.ctx.app.vault as unknown as {
    on?: (name: string, cb: (...args: never[]) => void) => unknown;
    offref?: (ref: unknown) => void;
  };
  if (typeof vault.on === 'function') {
    /**
     * ⚠️ **改名要把事件的两个参数都收下**（`file` 与 `oldPath`）—— 只挂一个空回调、
     * 让每一页自己去读 `file.path` 是不够的：那次改名**可能根本没发生在我们手里那个
     * `TFile` 对象上**。`TFile.path` 是"就地改"的没错，但**前提是这个对象还是平台认的那一个**；
     * 任何一次 `vault.rescan()` 之后索引里换过一批新对象，旧对象就永远停在老路径上
     *（离线用例实测抓到的：文件已经在新路径了，页上的路径纹丝不动）。
     * 所以按**路径**认（`t.path === oldPath`），顺手把 `t.file` 换成平台现在认的那一个。
     */
    const onRename = (
      file: { path?: string; basename?: string; children?: unknown },
      oldPath?: string,
    ): void => {
      // **只扫自己这一扇**（每条监听挂在各自的窗上；扫全部会 N 倍重复干活）
      const p2 = self;
      if (!p2) return;
      syncTabsWithVault(p2, file?.path ? file : null, oldPath ?? null);
      /**
       * **目录改名 / 移动 → 重画属性块**（P7.16b 补，P7.16 独立审 🟡#4 记的那条账）：
       * 「文件位置」下拉的**候选表**跟着目录名变，而目录改名**既不加也不减**库指纹
       * （下面 `onVaultTree` 那枚 `getAllLoadedFiles().length` 看不见它）——不补这一支，
       * 候选要等下一次建/删目录或切 tab 才自愈。**只认"有 children 的才是目录"**：
       * 文件改名走索引那条（`onIndexChanged`）已覆盖，别在这儿重复干。
       */
      if ((file as { children?: unknown } | null)?.children !== undefined) {
        const p3 = alivePanel();
        if (p3) for (const t of p3.tabs) repaintPropsQuiet(t);
      }
    };
    const onDelete = (file: { path?: string }): void => {
      const p2 = self;
      if (!p2 || !file?.path) return;
      if (findTab(p2, file.path)) void closeTab(p2, file.path, FILE_GONE);
    };
    const ref = vault.on('rename', onRename as never);
    const ref2 = vault.on('delete', onDelete as never);
    /**
     * ── **属性块「脏检查重画」**（P7.16 · #1）────────────────────────────
     *
     * 现象（用户 2026-10-08 第 4 条）：① 新建文件夹后，小窗属性区的「文件位置」下拉
     * 候选**不更新**（要等切 tab / 重开面板）；② **外部改 YAML**（原生属性面板改 /
     * 同步拉进来）后属性块显示旧值。原先 `paintProps` 只在 ①设置变 ②自己写盘后
     * ③切 tab/重开面板时跑 —— 不订阅索引、也不订阅库变化。
     *
     * 两条触发源 + 一枚**库指纹**（`getAllLoadedFiles().length`）：
     *   · `ctx.index.onChange`：属性/条目变了（外部改 YAML、同步拉进来、插件自己写盘）
     *     → 只重画**在变化名单里的** tab（精确、便宜；"每个 tab"在这条路上没有增量）；
     *   · vault `create`/`delete`：**目录**增删不会走索引（索引只跟 `.md`，P7.13b 记过），
     *     但它会让「文件位置」下拉的候选表变 —— 用这枚指纹判"库变了"
     *     （与 P7.15 给目录树加的那一枚同源），变了就重画全部 tab。
     *     ⚠️ **目录改名/移动**指纹看不见（既不加也不减计数）→ 走**上面 `onRename` 里那一支**
     *     （P7.16b 补的：按 `children !== undefined` 认目录 → 重画全部 tab 的属性块；
     *     P7.16 独立审 🟡#4 记的那条账，本轮回销）。
     *
     * ⚠️ **两条钉死**（拍定）：
     *   ① 只重画**属性块**、绝不重挂编辑器（`paintProps` 生来如此，别在这儿另拼 DOM）；
     *   ② 焦点在属性块内的控件上（用户正在选 / 正在打字）→ **推迟到下一次触发**
     *      （别抢焦点：把 select 连它打开的候选一起换掉 = 当场"点了没反应"）。
     *      ⚠️ 独立审 🟡："下一次触发"原先**不保证会来**（跳过后不排队、blur 也不补）——
     *      现在把跳过的 tab 记进 `deferred`，属性块**失去焦点（focusout）时补画一次**。
     * ⚠️ **订阅不许把 O(文件数) 塞热路径**：指纹只用 `.length`（现成计数；不另做遍历——
     *   同 P7.15 给目录树加的那一枚）；全表遍历（`kbDirsOf` 那种）只许发生在真重画那一拍
     *   （`paintProps` 里现算候选）。
     * ⚠️ 重画**保住属性区的滚动位置**（e2 的老账："重绘会把滚动位置清零，而它不报错"）。
     */
    let lastLibFp = c.ctx.app.vault.getAllLoadedFiles().length;
    /** 因为"焦点在属性块里"被推迟的 tab（focusout 时补画 —— 见钉死②的独立审尾巴） */
    const deferredProps = new Set<CwTab>();
    const repaintPropsQuiet = (tab: CwTab): void => {
      /** 焦点保护（钉死②）：属性块里正握着焦点 → 记下来、跳过，等 focusout / 下一次触发 */
      if (tab.propsBlock.contains(document.activeElement)) {
        deferredProps.add(tab);
        return;
      }
      deferredProps.delete(tab);
      /** 保滚动：`.kbw-cw-props` 是属性行的滚动宿主（面板形态下 `overflow:auto`） */
      const top = tab.propsBlock.querySelector<HTMLElement>('.kbw-cw-props')?.scrollTop ?? 0;
      paintProps(tab);
      if (top > 0) {
        const box = tab.propsBlock.querySelector<HTMLElement>('.kbw-cw-props');
        if (box) box.scrollTop = top;
      }
    };
    const alivePanel = (): CwPanel | null => {
      const p2 = self;
      // 已拆的扇别碰（f 期纪律：长寿对象每个回调先问一句"我还活着吗"）
      return p2 && panels.has(p2) ? p2 : null;
    };
    const onVaultTree = (): void => {
      const p2 = alivePanel();
      if (!p2) return;
      const fp = c.ctx.app.vault.getAllLoadedFiles().length;
      if (fp === lastLibFp) return; // 计数没动 → 目录表不可能变（够用、成本为零）
      lastLibFp = fp;
      for (const t of p2.tabs) repaintPropsQuiet(t);
    };
    const onIndexChanged = (change: { changed: string[]; removed: string[] }): void => {
      const p2 = alivePanel();
      if (!p2) return;
      if (change.changed.length === 0 && change.removed.length === 0) return;
      const hit = new Set([...change.changed, ...change.removed]);
      for (const t of p2.tabs) if (hit.has(t.path)) repaintPropsQuiet(t);
    };
    /**
     * **焦点离开属性块 → 把推迟的那次补上**（独立审 🟡：光靠"下一次触发"可能永远不来，
     * 比如同步拉进来一份改动、用户随后把焦点移去正文，之后再也无人改这一篇）。
     * ⚠️ `focusout` 在"块内控件之间横跳"时也会发 —— `setTimeout(0)` 等焦点落定再判，
     * 仍在块里就继续挂着（`deferredProps` 不摘）。
     */
    const onPropsFocusOut = (): void => {
      const p2 = alivePanel();
      if (!p2) return;
      window.setTimeout(() => {
        const p3 = alivePanel();
        if (!p3) return;
        for (const t of Array.from(deferredProps)) {
          if (t.panel === p3 && !t.propsBlock.contains(document.activeElement)) {
            repaintPropsQuiet(t);
          }
        }
      }, 0);
    };
    h.root.addEventListener('focusout', onPropsFocusOut);
    d.add(() => h.root.removeEventListener('focusout', onPropsFocusOut));
    const ref3 = vault.on('create', onVaultTree as never);
    const ref4 = vault.on('delete', onVaultTree as never);
    const unsubIndex = c.ctx.index.onChange(onIndexChanged);
    d.add(() => {
      try {
        vault.offref?.(ref);
        vault.offref?.(ref2);
        vault.offref?.(ref3);
        vault.offref?.(ref4);
      } catch {
        /* 忽略 */
      }
      try {
        unsubIndex();
      } catch {
        /* 忽略 */
      }
      deferredProps.clear();
    });
  }

  // tab 条（≥2 篇才显示）
  const strip = div({ cls: 'kbw-cw-tabs' });
  strip.style.display = 'none';
  h.root.insertBefore(strip, h.body);

  // 共用的底部按钮（作用于**当前 tab**）
  /**
   * ⚠️ **内嵌态不摆底部按钮**（P7.2d）：三条各自的去向在块内都说不通 ——
   * "在新标签页打开"会把这颗 tab 从块里挪走（可钉选还在，下一次同步又加回来 = 点了没反应）、
   * "打开笔记"与"完成"会把**块里的窗**整个收掉（块还在，窗没了）。
   * 块内退出的正路是 tab 的 ✕（= 取消钉选）或笔记右键「取消钉」。
   * 空 foot 由 CSS 收掉（与模态同一条"空的不占位"口径）。
   */
  const footOpenTab = btn({
    cls: 'kbw-btn is-small is-ghost',
    text: '在新标签页打开',
    title: '交给标签页（面板这一篇会先关掉：同一文件两个编辑器会互相冲掉改动）',
    /**
     * 🔴 **这个按钮会先把面板里这一篇关掉**（d2 拍板，见 `handOffToTab`）——
     * 文案别写成"两边都留着"，那是**丢改动**的那条路。
     */
    on: { click: () => withActive((t) => void handOffToTab(p, t)) },
  });
  const footOpenHere = btn({
    cls: 'kbw-btn is-small',
    text: '打开笔记',
    title: '在当前标签打开（会替换工作台这一页）',
    /**
     * ⚠️ **打开之后要把面板收起来**：`getLeaf(false)` 换掉的常常就是工作台那一页
     * （P3 真机实测：一开笔记，工作台那页就没了）。面板跟着宿主一起消失，
     * 但**它自己不 close 就会留一个叶**：宿主 DOM 被平台拆了、`detach` 却没人调。
     */
    on: {
      click: () =>
        withActive((t) => {
          void c.ctx.app.workspace.getLeaf(false).openFile(t.file);
          // 同上：只收**这一扇**（全局那条会把别的窗一起收掉 —— 独立审查 🔴1）
          if (self) destroyPanel(self, 'open-in-current');
        }),
    },
  });
  if (!embed) {
    h.foot.style.display = '';
    h.foot.appendChild(footOpenTab);
    h.foot.appendChild(footOpenHere);
    h.foot.appendChild(
      btn({
        cls: 'kbw-btn is-small is-primary',
        text: '完成',
        title: '保存并关掉当前这一篇',
        on: { click: () => withActive((t) => void closeTab(self as CwPanel, t.path, 'done')) },
      }),
    );
  }

  /**
   * 配置变动跟着走：
   *  · `panelProps` / `panelContent`（含**每一篇的覆盖**）变了 → 重建对应那一块
   *  · `panelPinned` 变了 → 落到面板上（空白处右键那条菜单入口就靠这一条生效）
   *  · `dock` 变了 → 搬进/搬出窗格（认领者才动手）
   *  · `panelFont` / `panelPropsRatio`（含覆盖）变了 → 落到页上（第 2 / 5 条）
   */
  /**
   * 配置变了要重做的几件事（**写成具名函数**，因为"切模块换 store"时还要再补做一遍，
   * 见 `rebindCardPanel`）。⚠️ 一律从 `p.deps.cfg` 现取 —— 别用建面板那一刻闭包里的 `c`：
   * 切过模块之后那份 deps 已经是被换掉的老模块了。
   *
   * ⚠️ f 期多窗之后**不能再读模块级的 `panel`**：每条订阅挂在**各自的窗**上，
   * 读单例就等于"每次都去改第一扇窗"。
   */
  const onCfg = (): void => {
    const p2 = self;
    // ⚠️ `!panels.has(p2)` = **这一扇已经被拆了**（同一次配置变更里 "先收后叫" 那个窗口，
    //    见 `syncDock` 顶上那段）→ 什么都别做，尤其别去碰停靠口子
    if (!p2 || p2.rebuilding || !panels.has(p2)) return;
    applyPinned(p2.deps.cfg.get().view.panelPinned);
    rebuildAll(p2);
    /**
     * ⚠️ 停靠位也要**在这里跟着走**：换边 / 取消停靠都是写配置（菜单那两处入口），
     * 面板自己不订阅就没反应 —— 那不是"下次打开才生效"能糊过去的（用户点完菜单
     * 眼前这块窗格本该立刻换边）。
     * ⚠️ **内嵌窗跳过**（`syncDock` 顶上第一句就 return）—— 它的"位置"归块宿主，
     * 与看板配置里的停靠边没有关系。
     */
    syncDock(p2);
  };
  const bindCfg = (): void => {
    // 先退掉上一条（切模块时换 store）——`onChange` 的退订是**幂等**的（`listeners.delete`）
    p.cfgUnsub?.();
    p.cfgUnsub = p.deps.cfg.onChange(onCfg);
    d.add(p.cfgUnsub);
  };

  const p: CwPanel = {
    id,
    owner,
    h,
    tabs: [],
    active: '',
    deps: c,
    strip,
    titleInput,
    footOpenTab,
    footOpenHere,
    component,
    d,
    rebuilding: false,
    lastNotified: '',
    cfgUnsub: null,
    dockPort: null,
    embedded: embed,
    embedTabClose: null,
    bindCfg,
    onCfg,
  };
  self = p; // ← `onClose` 靠它拿到"自己这一个"（见上面那段注释）
  panels.add(p);
  /**
   * **默认的"最近交互"** = 刚建出来这一扇（用户点卡片 → 建窗，接下来那一下交互当然算它）。
   * 之后的更新挂在根元素的 `pointerdown`/`focusin` 上（见下）。
   * ⚠️ **内嵌窗不更新 `activeFloating`**（与 `raisePanel` 里那条同口径）：它是停靠态、
   * 不接"点外面"那一下 —— 把靶子指向它等于指到一个关不掉的东西上（视觉上点了没反应）。
   */
  activePanel = p;
  if (!embed) activeFloating = p; // 刚建出来的一定是浮层（停靠是后面 syncDock 的事）
  ensureOutsideTracker();
  h.root.dataset.win = String(id); // 探针/回执据此认"哪一扇"（多窗的判据全靠它）
  bindCfg();
  /**
   * **"最近交互的那一扇"怎么记**（f 期口径 ④）：捕获阶段的 `pointerdown` + `focusin`。
   *
   * 用**捕获**是为了抢在"点外面就关"那套（`ui/panel.ts` 装在 document 上的**冒泡**监听）
   * 之前更新：否则点乙窗时，甲窗的 outside 处理器先跑，看到的还是"甲是最近交互的"，
   * 于是把甲关掉 —— 正是多窗最不能接受的那个行为。
   */
  const markActive = (): void => raisePanel(p);
  h.root.addEventListener('pointerdown', markActive, true);
  h.root.addEventListener('focusin', markActive, true);
  d.add(() => {
    h.root.removeEventListener('pointerdown', markActive, true);
    h.root.removeEventListener('focusin', markActive, true);
  });
  /**
   * **面板里 `Ctrl+滚轮` = 缩放这一窗的文字**（f 期第 2 条）。
   *
   * ⚠️ 与"看板里 `Ctrl+滚轮` = 缩放卡片"是**两套**：那两个监听挂在 `.kbw-board-body`
   * 与卡片上，而这一扇窗挂在 `document.body` 上 —— 事件不会跑过去（实测过路径），
   * 但仍在这里 `stopPropagation()` 把边界写死：将来谁把监听挪到 document 上也不会打架。
   */
  const onWheel = (evt: WheelEvent): void => {
    if (!evt.ctrlKey && !evt.metaKey) return;
    const p2 = self;
    if (!p2) return;
    const tab = activeTab(p2);
    if (!tab) return;
    /**
     * **手势分流**（P6b ④，用户 2026-09-27 原话："当鼠标在悬浮窗口 **Ctrl+shift+滚轮** 触发
     * **当前的缩放**效果（= 窗口本身），放在**笔记正文部分 ctrl+滚轮** 则触发**笔记文字界面
     * 单独的缩放**，不影响窗口本身的大小"）。
     *
     * | 组合 | 光标位置 | 效果 |
     * |---|---|---|
     * | `Ctrl+Shift+滚轮` | 面板**任意处** | 缩放**窗口**（宽高按同一比例） |
     * | `Ctrl+滚轮` | **正文**上 | 这一篇的**正文字号**（f 期那套，不动） |
     * | `Ctrl+滚轮` | 面板头 / 属性区 | 也缩放**窗口**（"正文上才缩字"是用户的语义） |
     *
     * ⚠️ **监听挂在面板自己身上**（不是 document）：平台自己把 `Ctrl+滚轮` 用在"缩放整个界面"
     * 上，所以我们的 `preventDefault()` 只管面板里这一片 —— 手在别处滚，平台照常干活。
     */
    evt.preventDefault();
    evt.stopPropagation();
    const onBody =
      (evt.target as HTMLElement | null)?.closest?.('.kbw-cw-editor, .kbw-cw-preview') != null;
    if (evt.shiftKey || !onBody) {
      // 缩放窗口：一档 6%（连续手势不弹通知，只有那一行「420 × 560」浮标）
      const cur = p2.h.getSize();
      const factor = evt.deltaY < 0 ? 1.06 : 1 / 1.06;
      const lim = { minW: 280, minH: 200 };
      const maxW = Math.max(320, Math.round((window.innerWidth || 1200) * 0.9));
      const maxH = Math.max(240, Math.round((window.innerHeight || 800) * 0.9));
      const next = {
        w: clamp(Math.round(cur.w * factor), lim.minW, maxW),
        h: clamp(Math.round(cur.h * factor), lim.minH, maxH),
      };
      p2.h.setSize(next.w, next.h);
      showSizeBadge(next);
      return;
    }
    const view = p2.deps.cfg.get().view;
    const cur = panelFontFor(p2.deps.cfg.get(), tab.path);
    const next = nextFontSize(cur, evt.deltaY < 0, PANEL_FONT_MIN, PANEL_FONT_MAX);
    void p2.deps.cfg.patchView({ panelByPath: withPanelPref(view, tab.path, { font: next }) }).then(() => {
      p2.deps.onReceipt(`小窗字号：${next}px（这一篇）`);
    });
  };
  h.root.addEventListener('wheel', onWheel, { passive: false });
  d.add(() => h.root.removeEventListener('wheel', onWheel));
  /**
   * **停靠接线**（d2 §3.1）。三条：
   *  · 建面板这一刻按配置**请求**一次（外壳按容器尺寸裁决，见 `ui/dock.ts` 的 `dockFit`）
   *  · 外壳那边裁决变了（工作台被拖窄/挤宽）→ 搬进 / 搬出
   *  · 用户拖了分隔条 → 由**我们**写进配置（配置归看板管，外壳不碰它）
   */
  /**
   * ⚠️ **内嵌窗不接停靠口子**（P7.2d）：它的宿主是首页块，不是工作台窗格 ——
   * 认了口子就会去 `request(...)`，把工作台边上那条真窗格占掉。
   * `syncDock` 顶上会跳 `embedded`（那里必须跳：否则"没口子 + 已停靠"会被
   * 当成"该回浮层"、把窗从块里弹出去）。
   */
  const dockPort = embed ? null : (c.ctx.dock ?? null);
  p.dockPort = dockPort;
  if (dockPort) {
    d.add(
      dockPort.onChange(() => {
        /**
         * ⚠️ **一律走 `applyPanelDock`**（e 期独立审查抓的）：这里原先只问 `applied`，
         * 不问配置 —— 于是"挤窄再拉宽"（`applied` 翻面）会把一个**浮层态**的面板
         * 拽进窗格、顺带把预览的窗格挤掉。判据现在只有一处（见那个函数）。
         */
        applyPanelDock(p);
      }),
    );
    d.add(
      dockPort.onResize((size) => {
        // ⚠️ 只有**窗格真的是我在用**时才由我写配置（拖分隔条时两个占用者都收到广播，
        //    不问一句就会把对方的尺寸改掉）。问口子的身份，不比自己的布尔。
        //    f 期：身份是 `panel#<id>`，所以"是不是我"只有我自己答得对。
        if (p.dockPort?.owner() !== p.owner) return;
        // ⚠️ 从 `p.deps.cfg` 现取（不用建面板时闭包里的 `c`）：切过模块之后那份是老的
        const cur = p.deps.cfg.get().view.dock;
        if (!cur.where) return;
        void p.deps.cfg.patchView({ dock: { where: cur.where, size } }).then(() => {
          p.deps.onReceipt(`停靠大小：${size}px`);
        });
      }),
    );
  }
  syncDock(p);
  function withActive(fn: (t: CwTab) => void): void {
    const t = activeTab(p);
    if (t) fn(t);
  }
  return p;
}

function destroyPanel(p: CwPanel, reason: string): void {
  /**
   * ⚠️ **摘牌这件事全在 `onClose` 里**（f 期调整）：`panels.delete(p)` / `activePanel` /
   * `dockingPanel` 三处都在那条必经之路上清（`h.close()` 的五条入口都会走到）。
   * 这里**只**负责发起关闭 —— 早先在这个函数里"先把单例置空"，多窗之后那样的写法
   * 会在 `onClose` 之前就把状态改坏（`panel` 单例已经没了，而 `panels` 里还留着它）。
   */
  p.h.close(reason);
  // ⚠️ `p.d.dispose()` **不在这里**（原先放这儿 → 只有这条路会收监听）：
  //    Esc / 头部 ✕ / 点外面 / resize / purge 那五条是**直接调 `h.close()`** 的，
  //    它们只走到 `onClose` → 每关一次就漏一条 cfg 订阅 + 一对 vault 监听，
  //    而且整份死面板（含 N 个 page 与编辑器 DOM）被闭包钉住（独立审查 🟡5 实测到"每关一次累加一对"）。
  //    所以 dispose 挪进 `onClose` —— 那是**所有**关闭路径的必经之地。
}

/** 逐个 tab 走"先 save 再 detach"，然后拆掉面板外壳 */
async function closeAllTabs(p: CwPanel): Promise<void> {
  const tabs = p.tabs.splice(0);
  for (const t of tabs) await saveTab(t);
  for (const t of tabs) dropTab(t);
}

// ────────────────────────────────────────────────────────────────
// tab 的增删改查
// ────────────────────────────────────────────────────────────────
function findTab(p: CwPanel, path: string): CwTab | null {
  return p.tabs.find((t) => t.path === path) ?? null;
}

function activeTab(p: CwPanel): CwTab | null {
  return findTab(p, p.active) ?? p.tabs[p.tabs.length - 1] ?? null;
}

/**
 * 造一个 tab（还没加进 `p.tabs`）—— 页面结构：
 *
 * ```
 * page
 * ├─ 标题行 + hr
 * ├─ propsBlock   ← 属性（这一篇的档位变了只重建它）
 * ├─ splitter     ← 可拖的分隔条（f 期第 5 条；两边都有内容时才显示）
 * └─ contentBlock ← 正文（档位换了才重建它，因为要重挂编辑器）
 * ```
 */
function createTab(p: CwPanel, entry: NoteEntry): CwTab {
  const page = div({ cls: 'kbw-cw-page' });
  const cfgNow = p.deps.cfg.get();
  const tab: CwTab = {
    path: entry.path,
    file: entry.file,
    entry,
    panel: p,
    page,
    propsBlock: div({ cls: 'kbw-cw-pblock' }),
    contentBlock: div({ cls: 'kbw-cw-cblock' }),
    splitter: div({ cls: 'kbw-cw-split' }),
    editorHost: div({ cls: 'kbw-cw-editor' }),
    leaf: null,
    view: null,
    saving: false,
    // 这一页马上会按"这一篇生效的档位"画（下面 `paintProps`）
    lastProps: panelPropsFor(cfgNow, entry.path),
    lastContent: panelContentFor(cfgNow, entry.path),
    tailFolded: false,
  };
  /**
   * 分隔条（f 期第 5 条）：形状与卡片那根一致，方向按"属性在上、正文在下"。
   * 拖动途中只改这一页的 CSS 变量；松手才落盘 ——
   * **Alt+拖 = 写"所有小窗的默认"**（与卡片那条同一套手感）。
   */
  tab.splitter = panelSplit(
    () => tab.page,
    (ratio, commit, global) => {
      if (!commit) {
        applyPanelRatio(tab.page, ratio);
        return;
      }
      if (global) {
        void p.deps.cfg.patchView({ panelPropsRatio: ratio }).then(() => {
          p.deps.onReceipt(ratio == null ? '小窗属性/正文：恢复自动（所有窗）' : `小窗属性/正文：${Math.round(ratio * 100)}%（所有窗）`);
        });
        return;
      }
      const view = p.deps.cfg.get().view;
      void p.deps.cfg.patchView({ panelByPath: withPanelPref(view, tab.path, { ratio }) }).then(() => {
        if (ratio == null) p.deps.onReceipt('这一篇的小窗比例：恢复自动');
        else p.deps.onReceipt(`这一篇的小窗比例：${Math.round(ratio * 100)}%`);
      });
    },
  );

  /**
   * ⚠️ **标题行没了**（P6b ⑤）：标题输入框并进面板头那一行（`p.titleInput`），
   * 这一页从 `.kbw-cw-pblock` 直接开始 —— 非正文部分从"头 + tab 条 + 标题行 + 「正文」标签"
   * 压到**一行**（真机上量过：140px → ~40px）。
   * 分隔线的活儿也交给属性块自己（块尾那根 `kbw-cw-hr`），空白页不再多画一条。
   */
  page.appendChild(tab.propsBlock);
  page.appendChild(tab.splitter);
  page.appendChild(tab.contentBlock);
  /**
   * 这一篇自己的字号 / 比例（f 期第 2 / 5 条）在**建页时**就落一遍，
   * 之后由 `rebuildAll`（配置变了）与 `activate`（切 tab）补。
   */
  applyPanelFont(page, panelFontFor(cfgNow, entry.path));
  applyPanelRatio(page, panelRatioFor(cfgNow, entry.path));
  paintProps(tab);
  // ⚠️ `paintContent` **不在这里**：它要挂真编辑器，而这一刻这一页还没进 DOM
  //（见 `openCardTab` 里那段顺序说明）
  return tab;
}

async function renameTab(tab: CwTab, next: string): Promise<void> {
  const p = tab.panel;
  // 走 mover（快照 + 撞名不覆盖 + 双链同步）；顺序表的迁移由模块的 rename 监听统一做
  const res = await p.deps.ctx.mover.move({
    targets: [{ newName: next, files: [tab.file] }],
    source: 'board',
    reason: `看板改名：${tab.entry.basename} → ${next}`,
  });
  if (res.moved.length > 0) {
    p.deps.onReceipt(`已改名：${tab.entry.basename} → ${next}`);
    p.deps.refresh();
  }
}

/** 切到某个 tab：显隐页面 + 更新头/条/按钮 + **把上一个 tab 落盘**（口径 ② ） */
function activate(p: CwPanel, path: string): void {
  const next = findTab(p, path);
  if (!next) return;
  const prev = activeTab(p);
  if (prev && prev.path !== path) void saveTab(prev);

  p.active = path;
  for (const t of p.tabs) {
    const on = t.path === path;
    t.page.classList.toggle('is-active', on);
    t.page.style.display = on ? '' : 'none';
  }
  paintStrip(p);
  const e = liveEntry(p, next);
  /**
   * 标题进输入框、路径缩成**短目录**（P6b ⑤：真机上原来那行是
   * 「01_新知识库/02_Areas/每日任务/2026-09-08 任务.md」—— 一整行只为了说"它在哪"）。
   * ⚠️ 全路径仍在 `title` 属性里（悬停可看），`shortDir` 只负责显示。
   */
  p.h.setTitle(e.basename, shortDir(p.deps.ctx, e.path));
  reposition(p, next);
  /**
   * **切过去就套上"这一篇"的字号**（f 期第 2 条）：字号是每篇可覆盖的，
   * 所以它随 tab 走（`--kbw-cw-scale` 挂在页上，切页 = 换字号）。
   * ⚠️ 只在真的写时改（`applyPanelFont` 内部按值设/摘属性），不重建任何东西。
   */
  applyPanelFont(next.page, panelFontFor(p.deps.cfg.get(), next.path));
  /** 外层（tab 条 / 标题 / 底部按钮）跟着**当前这一篇**缩（独立审查 🟡2） */
  applyPanelScale(p.h.root, panelFontFor(p.deps.cfg.get(), next.path));
  /**
   * ⚠️ 切回来之后要**催一次重排**：被 `display:none` 藏过的 CodeMirror 量到的是 0 几何
   * （切走那一刻它所在的那一页整个不参与布局），再显示时若没人通知它，
   * 滚动位置与光标行都会算错。（规则与"为什么不能派全局 resize"见 `refreshEditor`）
   */
  refreshEditor(next);
}

/**
 * **催一次编辑器重排**（切 tab、以及**停靠搬运**之后都要）。
 *
 * 🔴 **只能用 `Editor.refresh()`，不许派 `window` 上的 `resize`**（真机/离线都栽过）：
 * 面板自己就挂着一句"窗口尺寸变了 → 关窗"（P4 起的行为），
 * 派一发全局 resize 会**把自己关掉** —— 症状是"点第二下卡片面板就没了"。
 * `refresh()` 是公开 API（`Editor`，0.11.11 起），语义就是"重算布局"，没有旁观副作用。
 *
 * ⚠️ 停靠搬运之后这一下**不能省**：面板刚从 `position:fixed` 变成窗格里的
 * 流式元素，宽度与高度都变了，而 CodeMirror 只在被通知时才重新量 ——
 * 不叫它的话光标行与滚动位置会按旧尺寸算（d 期"藏过又显"那条就是这个病）。
 */
function refreshEditor(t: CwTab | null): void {
  if (!t) return;
  const ed = (t.view as unknown as { editor?: { refresh?: () => void } } | null)?.editor;
  try {
    ed?.refresh?.();
  } catch (e) {
    console.error('[经纬] 催编辑器重排失败（不影响内容）', e);
  }
}

/** 关一个 tab：`await save()` → `detach()` → 拆页；关掉最后一个 = 关整扇面板 */
async function closeTab(p: CwPanel, path: string, why: string): Promise<void> {
  const i = p.tabs.findIndex((t) => t.path === path);
  if (i < 0) return;
  const tab = p.tabs[i];
  p.tabs.splice(i, 1);
  await saveTab(tab, why);
  dropTab(tab);
  if (p.tabs.length === 0) {
    /**
     * 关掉最后一篇 = 关**这一扇**（面板里没东西可显示了）。
     *
     * 🔴 **不能调 `closeCardPanel()`**（f 期独立审查 🔴1）：那个函数是"逐扇遍历、
     * 每扇都 destroy"的设计（给模块卸载 / 视图关闭那种"全都收掉"的场景用的）——
     * 多窗之后在这儿调它，等于"在甲窗点完成，乙窗也一起没了"（实测 4 条用例全红）。
     * "这一扇不要了"只有一条路：`destroyPanel(本扇, …)`。
     */
    destroyPanel(p, why);
    return;
  }
  if (p.active === path) {
    /**
     * 关掉的正是当前这篇 → 落到**右邻居**（`tabs.ts` 那条规则，别在这儿再写一遍）。
     * `activate` 会顺带把新当前这篇的标题/tab 条/位置都刷一遍。
     */
    const nextPath = nextActiveAfterClose(p.tabs, i);
    if (nextPath) activate(p, nextPath);
    return;
  }
  /**
   * 关的是**别的**那一篇（中键点 tab / 那个 tab 上的 ✕）→ 当前这篇不动，
   * 只重画 tab 条。⚠️ 这里**不要**碰 `p.active`：`nextActiveAfterClose` 给的是
   * "被关掉那张的邻居"，拿它当新的当前 = 用户在别的 tab 上点一下 ✕，视线就被拽走了。
   */
  p.active = resolveActive(p.tabs, p.active) ?? '';
  paintStrip(p);
}

/**
 * 只 save，不 detach（切 tab 与关闭都走它）。
 *
 * @param why 关掉它的原因 —— **`'file-gone'` 时不 save**。
 *   真机的 `MarkdownView.save()` 是**无条件写盘**的，而平台的写路径不查文件还在不在
 *   （本项目记过很多次的"凭空复制一份"就是这一类）→ 文件刚被删，我们一 save 就把它写回来了。
 *   离线抓不到这条（桩的 `save()` 只在"有草稿"时写，而且 `process()` 会先读、文件没了就抛 ENOENT）——
 *   是独立审查按调用链实测出来的（🟡6）。
 */
async function saveTab(tab: CwTab, why?: string): Promise<void> {
  if (why === FILE_GONE) return;
  if (tab.saving) return;
  tab.saving = true;
  try {
    const v = tab.view as unknown as { save?: () => Promise<void> | void } | null;
    await v?.save?.();
  } catch (e) {
    console.error('[经纬] 保存正文失败', e);
  } finally {
    tab.saving = false;
  }
}

/**
 * **只收叶**：把这一篇的编辑器叶 detach 掉，**页面留着**（`tab.page` 原地不动）。
 *
 * 🔴 为什么必须与"关 tab"分开（独立审查 🔴1，实测复现）：`rebuildAll` 在**切换正文形态**
 * （editor ↔ preview ↔ none）时也要收掉旧叶 —— 它原先借用了 `detachTab`，而那个函数
 * 兼着"关掉这一篇"的 `tab.page.remove()`。于是**切一次档 = 每一页被整页拆掉**：
 * 面板里 0 页、tab 条还画着、切回来也回不去（`paintContent` 往一个已游离的 page 里画）。
 * 「拆页」只有"这一篇真的要走"时才该做，别让别的流程顺手带走它。
 */
function detachLeaf(tab: CwTab): void {
  const leaf = tab.leaf;
  tab.leaf = null;
  tab.view = null;
  try {
    leaf?.detach();
  } catch (e) {
    console.error('[经纬] 收面板里的编辑器失败', e);
  }
}

/** **关掉这一篇**：收叶 + 把它的页从面板里摘掉（**先 save 后 detach** 的顺序由调用方保证） */
function dropTab(tab: CwTab): void {
  detachLeaf(tab);
  tab.page.remove();
}

/**
 * 把"编辑中"名单报给看板。
 *
 * 🔴 **报的是所有窗的并集**（f 期独立审查 🔴4）：接收端 `mirrorEditing` 是**整份替换**，
 * 而这条原先只报**本扇**的 tabs → 两扇各开一篇时只有"最近动过的那扇"的卡片会亮
 *（另一扇的卡片标记被整份覆盖掉）。`panelPaths()`（并集）本来就有，其它入口一直用的是它。
 * ⚠️ "没变就别报"的签名也要**按并集**算：还按单扇算的话会出现"甲报过、乙变了却不报"（漏报）。
 */
let lastNotifiedUnion = '';
function notifyTabs(p: CwPanel): void {
  const paths = panelPaths();
  const sig = paths.join('|');
  if (sig === lastNotifiedUnion) return;
  lastNotifiedUnion = sig;
  try {
    p.deps.onTabsChanged?.(paths);
  } catch (e) {
    console.error('[经纬] 同步「编辑中」标记出错', e);
  }
}

/**
 * **跟着改名 / 删除走**（`vault.on('rename')` / `vault.on('delete')`）。
 * 规则本体在 `tabs.ts` 的 `remapPaths`（那里写了为什么"按 oldPath 改那一个"会漏）。
 */
function syncTabsWithVault(
  p: CwPanel,
  renamed: { path?: string; basename?: string } | null,
  oldPath: string | null,
): void {
  const vaultNow = p.deps.ctx.app.vault;
  /**
   * ⚠️ **`changed` 要把下面两步合起来算**（① 改过也算改）。
   * 漏掉 ① 的后果很阴：路径其实已经对了 → `remapPaths` 判"没变化"，
   * 而"把页上的 `data-path` 同步过去"那一段挂在 `changed` 上 → **整段被跳过**。
   * 外部看到的是"改名之后 tab 没跟"，内部其实已经对了 —— 这种里外不一致最难查。
   */
  let changed = false;

  /**
   * ① **按路径认**（不依赖对象身份）：改名事件把 `oldPath` 给出来了，
   * 直接拿它对 tab 的路径 —— 手里那个 `TFile` 有没有被换过都不影响这一步。
   * 顺手把 `t.file` 换成平台**现在**认的那一个（旧对象留着只会一路作废下去）。
   */
  if (renamed?.path && oldPath && renamed.path !== oldPath) {
    for (const t of p.tabs) {
      if (t.path !== oldPath) continue;
      t.path = renamed.path;
      const live = vaultNow.getAbstractFileByPath(renamed.path);
      if (live) t.file = live as TFile;
      changed = true;
    }
  }

  /**
   * ② 再整体扫一遍。这一趟管两件事：**目录改名**（一次挪一批，事件是按文件逐个来的，
   * 但"哪些还活着"只有逐个看才知道）与**文件被删/被搬出库**（收进 `dropped`）。
   * 判据用"这个路径还解析得出东西吗"，不用"手里那个对象还是不是它"。
   */
  const swept = remapPaths(p.tabs, (t) => {
    const live = t.file?.path;
    if (live && vaultNow.getAbstractFileByPath(live)) return live;
    // 手里那个对象作废了（某次重扫之后换了新对象）→ 退一步看这一页自己记的路径
    return vaultNow.getAbstractFileByPath(t.path) ? t.path : null;
  });
  /**
   * 已经不在库里的那些**逐个关掉**（它们各自还挂着一个真编辑器叶，不关就是悬挂叶）。
   * 关的时候 `closeTab` 自己会 save + detach；`p.active` 的落点也由它管。
   */
  for (const t of swept.dropped) void closeTab(p, t.path, FILE_GONE);
  changed = changed || swept.changed;
  if (!changed) return;
  /**
   * ⚠️ **页上的 `data-path` 也要跟着改**：它是探针与用例认人的锚（全项目找页/找卡片都靠它）。
   * 不改的话"改名之后 tab 跟没跟"从外面看起来是**没跟**，而内部 `tab.path` 其实已经对了。
   */
  for (const t of p.tabs) t.page.dataset.path = t.path;
  p.active = resolveActive(p.tabs, p.active) ?? p.active;
  paintStrip(p);
}

/** 索引里现取（属性改了 / 改名之后要拿到新的）；查不到就退回最后已知那一份 */
function liveEntry(p: CwPanel, tab: CwTab): NoteEntry {
  const fresh = p.deps.ctx.index.get(tab.path);
  if (fresh) tab.entry = fresh;
  return tab.entry;
}

/**
 * **搬走一篇之后收尾**（P6b ③ 的拆窗/搬 tab）：搬空了就收整扇，否则把活动页落到还留着的那一篇上。
 * ⚠️ 与 `closeTab` 那条"关掉最后一篇 = 关这一扇"是**同一条口径**，别在别处再判一遍。
 */
function afterTabRemoved(p: CwPanel, path: string): void {
  if (p.tabs.length === 0) {
    destroyPanel(p, 'tab-moved');
    return;
  }
  if (p.active === path) activate(p, p.tabs[p.tabs.length - 1].path);
  else paintStrip(p);
}

/** 切 tab / 开 tab 时重摆位置（面板贴在**这一篇**所在那一列的顶部） */
function reposition(p: CwPanel, tab: CwTab): void {
  /**
   * 钉住了就不跟着走：钉住 = "我要它待在**这儿**"，跟着当前 tab 跑来跑去就不叫钉住了。
   * （`followAnchor` 内部还会看"用户自己拖过没有"，那条优先级更高。）
   */
  if (p.h.isPinned()) return;
  // ⚠️ 走 `followAnchor` 而不是直接写 left/top：面板内部那次"内容长高就重摆"按锚点算，
  //    直接改 left/top 会被下一次重摆拽回原来那一列
  p.h.followAnchor(columnTopCenter({ path: tab.path }));
}

// ────────────────────────────────────────────────────────────────
// tab 条
// ────────────────────────────────────────────────────────────────
function paintStrip(p: CwPanel): void {
  const strip = p.strip;
  while (strip.firstChild) strip.removeChild(strip.firstChild);
  // 只有一篇时整条藏起来 —— 与"没有分页"时的长相完全一致（零回归）
  strip.style.display = p.tabs.length >= 2 ? '' : 'none';
  if (p.tabs.length < 2) {
    notifyTabs(p);
    return;
  }
  /** 正在拖的那一篇（null = 没在拖） */
  let dragTab: CwTab | null = null;
  /** 拖 tab 时悬在哪一扇窗上（与拖头的 `mergeTarget` 是两条独立的手势，各自记各自的） */
  let hoverPanel: CwPanel | null = null;
  for (const t of p.tabs) {
    const on = t.path === p.active;
    const item = div({
      cls: ['kbw-cw-tab', 'kbw-hover-2', on ? 'is-on' : null],
      attr: {
        role: 'tab',
        tabindex: '0',
        'aria-selected': on ? 'true' : 'false',
        title: t.path,
        'data-path': t.path,
      },
      on: {
        click: () => activate(p, t.path),
        // 中键关掉（浏览器/IDE 惯例）——不用先切过去再关
        auxclick: (evt) => {
          if ((evt as MouseEvent).button === 1) {
            evt.preventDefault();
            void closeTab(p, t.path, 'middle-click');
          }
        },
        keydown: (evt) => {
          const k = evt as KeyboardEvent;
          if (k.key === 'Enter' || k.key === ' ') {
            k.preventDefault();
            activate(p, t.path);
          }
        },
      },
    });
    /**
     * **把 tab 拖出去**（P6b ③ 的"拆窗"，用户 2026-09-27 拍板"做，且本轮做"）。
     *
     * | 松手落点 | 结果 |
     * |---|---|
     * | **别的窗**上 | 那一篇**并进那一扇**（与拖窗合并同一条路：`adoptTab`） |
     * | **窗外**的空白 | 就地**拆成一扇新窗**（`openWindowAt`，落点 = 松手处） |
     * | 还在自己身上 | 什么都不做（tab **不做重排** —— 那是另一套原语，本轮不做） |
     *
     * ⚠️ **只有 ≥2 篇的窗才接这个手势**：只有一篇时"拖出去"等于把这扇窗搬个位（头本来就能拖），
     * 而"拆出一扇同内容的窗 + 原窗关掉"会让人以为自己搞坏了什么。
     * ⚠️ 触屏不接（与框选/拖动同一批口径：那里"拖"是滚动手势）。
     */
    item.addEventListener('pointerdown', (down) => {
      const e = down as PointerEvent;
      if (e.button !== 0) return;
      if ((e.target as HTMLElement | null)?.closest?.('.kbw-cw-tabx')) return;
      /**
       * ⚠️ **内嵌态不接拖 tab**（P7.2d）：拖出去 = 拆窗/并入别的窗 —— 块内没有
       * "把这一篇挪去别处"的语义（钉选还钉着，同步又加回来）。移除走 ✕（取消钉选）。
       */
      if (p.embedded) return;
      if (p.tabs.length < 2) return;
      if (e.pointerType === 'touch') return;
      const finishDrag = (point: { x: number; y: number } | null, dropped: boolean): void => {
        item.classList.remove('is-dragging');
        if (hoverPanel) {
          showMergeHint(hoverPanel, false);
          hoverPanel = null;
        }
        const moved = dragTab;
        dragTab = null;
        if (!moved || !dropped || !point) return;
        const over = panelUnder(point, p);
        if (over) {
          if (adoptTab(p, over, moved)) {
            paintStrip(p);
            paintStrip(over);
            activate(over, moved.path);
            afterTabRemoved(p, moved.path);
          }
          return;
        }
        const rect = p.h.root.getBoundingClientRect();
        const inside =
          point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
        if (inside) return;
        // 拆成一扇新窗（落点 = 松手处；新窗尺寸走默认，用户随后可拖角）
        const np = openWindowAt(p.deps, point);
        if (adoptTab(p, np, moved)) {
          paintStrip(p);
          paintStrip(np);
          activate(np, moved.path);
          afterTabRemoved(p, moved.path);
        }
        return;
      };
      startPointerDrag(e, null, {
        onStart: () => {
          dragTab = t;
          item.classList.add('is-dragging');
        },
        onOver: (_target: HTMLElement | null, c: { x: number; y: number }) => {
          if (!dragTab) return;
          const hit = panelUnder({ x: c.x, y: c.y }, p);
          if (hit !== hoverPanel) {
            if (hoverPanel) showMergeHint(hoverPanel, false);
            hoverPanel = hit;
            if (hit) showMergeHint(hit, true);
          }
        },
        onDrop: (_target: HTMLElement | null, c: { x: number; y: number }) =>
          finishDrag({ x: c.x, y: c.y }, true),
        onCancel: () => finishDrag(null, false),
      });
    });
    item.appendChild(span({ cls: 'kbw-cw-tabname', text: liveEntry(p, t).basename }));
    const x = el('button', {
      cls: 'kbw-iconbtn kbw-cw-tabx',
      attr: {
        type: 'button',
        'aria-label': p.embedded
          ? `取消钉选 ${liveEntry(p, t).basename}`
          : `关闭 ${liveEntry(p, t).basename}`,
        title: p.embedded ? '取消钉选（从首页移除，不删笔记）' : '关掉这一篇（先保存）',
      },
      on: {
        click: (evt) => {
          evt.stopPropagation(); // 别让点 ✕ 顺带切过去（那会白 save 一次）
          /**
           * 🔴 **内嵌态 ✕ = 取消钉选**（P7.2d 拍板）：直接 `closeTab` 的话，
           * 钉选还在 → 下一次 `sync` 又把它加回来（典型的"点了没反应"）。
           * 去向交给**开窗的那个人**（首页块 → 写 `homeCards`，同步随后收掉 tab）。
           */
          if (p.embedded) {
            p.embedTabClose?.(t.path);
            return;
          }
          void closeTab(p, t.path, 'tab-close');
        },
      },
    });
    x.appendChild(span({ cls: 'kbw-ico', text: '×' }));
    item.appendChild(x);
    strip.appendChild(item);
  }
  // 一个显式的"全关"入口（攒多了要有地方收）
  /**
   * ⚠️ **内嵌态不摆「全部关闭」**（P7.2d）：那片纸在块内等于"把钉选全清了"，
   * 语义太重；一扇窗的 ✕（取消钉选）已经给足了逐篇移除的能力。
   */
  if (!p.embedded) {
    const all = el('button', {
      cls: 'kbw-btn is-small is-ghost kbw-cw-tabclose-all',
      text: '全部关闭',
      attr: { type: 'button', title: '保存并关掉面板里的每一篇' },
      // 「全部关闭」= 关**这一扇**里的每一篇（不是关掉所有窗 —— 独立审查 🔴1）
      on: { click: () => destroyPanel(p, 'close-all') },
    });
    strip.appendChild(all);
  }
  notifyTabs(p);
}

// ────────────────────────────────────────────────────────────────
// 属性块（`panelProps` 变了只重建这块）
// ────────────────────────────────────────────────────────────────
function paintProps(tab: CwTab): void {
  const p = tab.panel;
  const box = tab.propsBlock;
  while (box.firstChild) box.removeChild(box.firstChild);
  /**
   * 显示多少行由 `panelPropsFor(这一篇)` 定（用户 2026-09-25 要的设置；f 期起**每篇可覆盖**）：
   *   `few`（默认）= 前 6 行 + 展开链接；`all` = 全铺；`none` = 整块不显示（= "藏掉 YAML 头"）。
   * 默认限量是因为 `propsFor` 真机上会给十来个，全铺会把正文挤出屏幕（他的截图里正文只剩一条缝）。
   */
  const propsMode = panelPropsFor(p.deps.cfg.get(), tab.path);
  syncSplitter(tab, propsMode, panelContentFor(p.deps.cfg.get(), tab.path));
  if (propsMode === 'none') return;
  const entry = liveEntry(p, tab);
  const allProps = propsFor(entry);
  box.appendChild(div({ cls: 'kbw-cw-sec', text: '属性' }));
  const propsBox = div({ cls: 'kbw-cw-props' });
  const PANEL_PROPS_MAX = 6;
  const first = propsMode === 'all' ? allProps : allProps.slice(0, PANEL_PROPS_MAX);
  const rest = propsMode === 'all' ? [] : allProps.slice(PANEL_PROPS_MAX);
  for (const name of first) propsBox.appendChild(propRow(p, tab, name));
  if (rest.length > 0) {
    const more = btn({
      cls: 'kbw-btn is-small is-ghost kbw-cw-more',
      text: `显示全部属性（${allProps.length}）`,
      title: '含必填但为空的项；展开后这一窗就长了，正文要往下滚',
    });
    more.addEventListener('click', () => {
      for (const name of rest) propsBox.appendChild(propRow(p, tab, name));
      more.remove();
    });
    propsBox.appendChild(more);
  }
  box.appendChild(propsBox);
  box.appendChild(div({ cls: 'kbw-cw-hr' }));
}

function propRow(p: CwPanel, tab: CwTab, name: string): HTMLElement {
  const entry = liveEntry(p, tab);
  const row = div({ cls: 'kbw-cw-row' });
  row.appendChild(span({ cls: 'kbw-cw-k', text: name }));
  const spec = SPEC_BY_NAME[name];
  const raw = entry.props[name];
  if (name === '文件位置') {
    /**
     * 🔴 **「文件位置」给的是"目录选择器"，不是自由多选**（P7.15 · #3，用户 2026-10-08）：
     * 候选 = **现算的库里目录**（`kbDirsOf` —— 与「新建笔记」落点下拉、目录树、
     * 批量迁移菜单**同一份口径**，新建目录立刻在列、不缓存）；选中 → 确认流 →
     * `mover` 搬过去 + 声明同步（见 `ops.setPositionByMove` 的两条后果说明）。
     *
     * 与别的多选型的区别是有意的：那一列是**声明**，改它就是"改主意去哪"——
     * 光写个字符串不搬，用户看到的还是"属性改了、文件没动"（v2 · #12 的口径在
     * 这条路上一直没落地，本轮补上）。
     */
    const select = el('select', { cls: 'kbw-select is-small' });
    /**
     * 🔴 **未声明 ≠ 库根**（P7.16 · #2a，拍定 Q1 长版）：`declaredPositions` 为空时
     * 旧实现 `select.value = ''` 会**选中「库根」**——那是误导（用户没声明过，
     * 不等于"声明在库根"）。现在空列表 → 多画一条 **sentinel 项**
     * 「（未声明 · 现处 XX）」（选中它 = no-op）；`['']`（真声明在库根）才由
     * 「库根」选中 —— **二者可区分**（空列表 vs `['']`）。拍定知悉：长文案在下拉
     * 窄时会截断（可接受；悬停/路径列仍可看全）。
     */
    const declared = declaredPositions(entry.props);
    const undeclared = declared.length === 0;
    const cur = declared[0] ?? '';
    const here = entry.effectivePosition || '';
    /**
     * sentinel 取值形状（轮内裁量）：**NUL 开头**——目录名不可能含它（文件系统不让），
     * 所以撞不上任何真实候选（`''` 库根项、目录名、`cur` 那枚"不在库里"）。
     */
    const SENTINEL_UNSET = '\u0000kbw-未声明';
    /** ⚠️ 候选**现算一次、本函数里复用**（`dirOptions` 每次都遍历 `getAllLoadedFiles`） */
    const dirs = dirOptions(p.deps.ctx);
    if (undeclared) {
      select.appendChild(
        el('option', {
          attr: { value: SENTINEL_UNSET },
          text: `（未声明 · 现处 ${here || '库根'}）`,
        }),
      );
    }
    /**
     * 「就住这儿」（P7.16 · #2b，拍定 Q2）：**未声明**且这一项就是它现在待的地方 →
     * 改成可点的一条真动作（写声明、不搬）。已声明的那一项照旧是普通候选
     *（声明 == 现处时选它 = 死操作，`moveByPosition` 里早退）。
     */
    select.appendChild(
      el('option', {
        attr: { value: '' },
        text: undeclared && here === '' ? '就住这儿（写声明，不搬）' : '库根',
      }),
    );
    for (const d of dirs) {
      select.appendChild(
        el('option', {
          attr: { value: d },
          text: undeclared && d === here ? '就住这儿（写声明，不搬）' : d,
        }),
      );
    }
    // 声明值可能指向一个**已不存在的目录**（错位的那种）—— 也画出来，别让选择器骗人
    if (cur && !dirs.includes(cur)) {
      select.appendChild(el('option', { attr: { value: cur }, text: `${cur}（不在库里）` }));
    }
    select.value = undeclared ? SENTINEL_UNSET : cur;
    /**
     * ⚠️ **没有搬动能力时置灰并说明**（独立审查 🟡2）：插件级的卡片窗依赖束
     * （`ensureWindowDeps`，首页「钉住的笔记」那块用的）没接 `ops` —— 不置灰的话
     * 用户选了个目录、只弹一句"这一屏没有搬动能力"，而选择器**停在刚选的值上**
     * （界面显示"改了"、实际什么都没改）。注释承诺过"置灰并说明"，这里兑现。
     */
    if (!p.deps.ops) {
      select.disabled = true;
      select.title = '这一屏没有搬动能力（首页的卡片窗）—— 去「全部笔记」或看板里改';
      select.setAttribute('aria-disabled', 'true');
      row.appendChild(select);
      return row;
    }
    select.addEventListener('change', () => {
      const dir = select.value;
      // sentinel（「（未声明 · 现处 XX）」那条）被选中 = **no-op**（拍定 Q1）：
      // 不搬、不写；连着两次选中它也不会触发 change，这里只是防御
      if (dir === SENTINEL_UNSET) return;
      void moveByPosition(tab, dir);
    });
    row.appendChild(select);
  } else if (spec?.multi) {
    // 列表型（`平台` / `tags`）：自研多选（平台没有值域 → 候选来自全库聚合）
    const cands = p.deps.ctx.index.valuesOf(name);
    row.appendChild(
      multiSelect({
        value: asList(raw).map(String),
        candidates: () => (spec.values ? [...spec.values] : cands),
        allowCustom: !spec.values,
        placeholder: spec.values ? '从值域里挑' : '回车加一个',
        emptyHint: spec.values ? '' : '库里还没有别的取值',
        onChange: (next) => void writeProp(tab, name, next),
      }).el,
    );
  } else if (spec?.values) {
    const sel = el('select', { cls: 'kbw-select is-small' });
    sel.appendChild(el('option', { attr: { value: '' }, text: '（空）' }));
    for (const v of spec.values) sel.appendChild(el('option', { attr: { value: v }, text: v }));
    sel.value = asString(raw);
    sel.addEventListener('change', () => {
      // 单值枚举：清空 = 删键（不是写一个空字符串）
      void writeProp(tab, name, sel.value === '' ? null : sel.value);
    });
    row.appendChild(sel);
  } else if (spec?.kind === 'bool') {
    const cb = el('input', { cls: 'kbw-check', attr: { type: 'checkbox' } });
    cb.checked = raw === true;
    cb.addEventListener('change', () => void writeProp(tab, name, cb.checked));
    row.appendChild(cb);
  } else {
    // 自由文本 / 日期：给个输入框（日期仍是文本，格式由属性规范管）
    const input = el('input', {
      cls: 'kbw-input',
      attr: { type: spec?.kind === 'date' ? 'date' : 'text', value: asString(raw) },
    });
    input.addEventListener('change', () => void writeProp(tab, name, input.value.trim() || null));
    row.appendChild(input);
  }
  if (spec?.readOnly) row.appendChild(span({ cls: 'kbw-cw-note', text: '只读' }));
  if (spec?.hint) row.title = spec.hint;
  return row;
}

/** 目录选择器的候选：**现算**的真实目录（`kbDirsOf`，'' = 库根，单独画在第一位） */
function dirOptions(ctx: WorkbenchContext): string[] {
  return Array.from(kbDirsOf(ctx.app, ctx.settings.kbRoot()))
    .filter((d) => d !== '')
    .sort((a, b) => String(a).localeCompare(String(b), 'zh'));
}

/**
 * 「文件位置」选择器选中之后的整条链（P7.15 · #3）：
 * 确认流（`ui/confirm.ts`，硬规矩之三）→ `mover` 搬 + 声明跟随。
 *
 * ⚠️ **两条后果必须一致**（拍板条目点名的那条）：搬成了、声明没改 = 下一次体检报
 * 「位置不一致」假红。所以声明**不由这里写** —— `mover` 第 7 步的「属性跟随」
 * 本来就会把它写成实际落点（`mover.ts` 那条"显式搬动就是改主意"）。
 * ⚠️ **P7.18b 起未声明的也写**（旧的 `declared.length === 0 → continue` 已删）——
 * "任何搬动之后，声明 = 实际落点"（用户 2026-10-09 拍板）；本链只管发起，声明全归 mover。
 *
 * ⚠️ 搬完**这一篇的路径变了**：`mover` 的 rename 事件会走 `remapPaths`（tabs.ts）
 * 把 tab 的 path/file 换成新身位 —— 之后重画属性区就落在新文件上了。
 */
async function moveByPosition(tab: CwTab, dir: string): Promise<void> {
  const p = tab.panel;
  const entry = liveEntry(p, tab);
  if (!entry) return;
  /**
   * 🔴 **整条链归 `NotesOps`**（确认流 → mover/fm → 快照/撤销条那几套）——
   * 小窗这里不自己拼一份：拼了就是**两处两制**（撤销条/通知/日志的文案与行为会漂）。
   */
  const ops = p.deps.ops;
  if (!ops) {
    /** 理论上到不了（选择器已按同一条判据置灰）；真到了也要**把选择器拨回原值** */
    notify({ kind: 'error', text: '这一屏没有搬动能力（缺少笔记操作口）', ms: NOTIFY_MS.long });
    paintProps(tab);
    return;
  }
  /** 选中项就是它现在待的地方 */
  if ((entry.effectivePosition || '') === (dir || '')) {
    /**
     * **「就住这儿」**（P7.16 · #2b，拍定 Q2）：**未声明**的笔记早先在这里一律早退
     *（死操作）—— 于是"只声明不搬"没有入口。现在改成可点的一条真动作
     *（`ops.declarePositionHere`：确认流 → 写声明；文案写明"只写声明、不动文件"）。
     * 已声明的照旧早退（声明 == 现处时选它本就没有事可做）。
     */
    if (declaredPositions(entry.props).length === 0) {
      await ops.declarePositionHere([entry]);
      // 成功/取消都把选择器拨回（成功 = 声明已写、取消 = 回到"（未声明 · 现处）"那条）
      paintProps(tab);
    }
    return;
  }
  await ops.setPositionByMove([entry], dir);
  /**
   * 搬完重画属性区（此时 tab 的 path 已由 rename 事件重映射到新身位）。
   * ⚠️ **取消确认流也走到这儿**（`setPositionByMove` 在 cancel 时直接 return）：
   * 重画会把选择器拨回声明值 —— 否则它停在用户刚点的那一项上，像"已经改了"。
   */
  paintProps(tab);
}

async function writeProp(tab: CwTab, name: string, value: unknown): Promise<void> {
  const p = tab.panel;
  try {
    const r = await p.deps.ctx.fm.setMany(tab.file, { [name]: value });
    /**
     * ⚠️ 守卫跳过（前言里有嵌套映射）= **没改**：守卫自己已经弹了 partial 通知，
     * 这里再说一句「已改」就是同屏打架（独立审查 🟡1）。
     */
    if (r.skipped.length > 0) return;
  } catch (e) {
    notify({
      kind: 'error',
      text: `「${name}」没改成`,
      detail: e instanceof Error ? e.message : String(e),
      ms: NOTIFY_MS.long,
    });
    return;
  }
  notifyLight(`已改「${name}」`);
  p.deps.onReceipt(`「${liveEntry(p, tab).basename}」的「${name}」已改`);
  p.deps.refresh();
  // tab 条上显的是名字，属性改动不影响它
}

// ────────────────────────────────────────────────────────────────
// 正文块（`panelContent` 变了才重建 —— 它要重挂编辑器）
// ────────────────────────────────────────────────────────────────
function paintContent(tab: CwTab, gotoLine: number | null): void {
  const p = tab.panel;
  const box = tab.contentBlock;
  while (box.firstChild) box.removeChild(box.firstChild);
  const contentMode = panelContentFor(p.deps.cfg.get(), tab.path);
  syncSplitter(tab, panelPropsFor(p.deps.cfg.get(), tab.path), contentMode);
  tab.editorHost = div({
    cls: [
      'kbw-cw-editor',
      // 只读预览那一档才谈得上"换不换行"（真编辑器自己管自己的排版）
      contentMode === 'preview' ? 'kbw-cw-preview' : null,
      contentMode === 'preview' && !panelWrapFor(p.deps.cfg.get(), tab.path) ? 'is-nowrap' : null,
    ],
    attr: {
      /**
       * 关掉换行时**写明边界**（P6b ⑥ 的文档要求）：`white-space` 只管文本，
       * 表格/代码块仍按内容宽度横滚 —— 用户在"为什么这个还是宽的"之前先看到这句话。
       */
      title:
        contentMode === 'preview' && !panelWrapFor(p.deps.cfg.get(), tab.path)
          ? '横向滚动：长行按原样显示（表格 / 代码块本来就按内容宽度排）'
          : '',
    },
  });
  if (contentMode === 'none') return;
  /**
   * ⚠️ **「正文」那个标签没了**（P6b ⑤）：非正文部分压到一行之后，正文块靠自己的
   * `padding` 与上面的分隔条认位（原来那 24px 的标签只说了"这里是正文"——
   * 用户看得见，不用写）。
   */
  box.appendChild(tab.editorHost);
  /**
   * `preview` 档为什么存在（用户 2026-09-25 要的"隐藏 YAML 头 / 结尾双链"）：
   * 真编辑器里那两段**是文件的一部分，藏不掉** —— 要藏就得换成只读渲染
   * （复用卡片摘要那套 `stripFrontmatter` + `stripTail`，同一份口径）。
   */
  box.appendChild(
    div({
      cls: 'kbw-cw-note',
      text:
        contentMode === 'preview'
          ? '只读预览（已剥掉前言与结尾双链）；要改动点「打开笔记」—— 设置里可切回可编辑'
          : '正文用 Obsidian 的真编辑器（有补全、有双链）；切走或关窗时自动保存',
    }),
  );
  if (contentMode === 'preview') void renderPreview(tab);
  else void mountEditor(tab, gotoLine);
}

/**
 * 只读预览（`panelContent: 'preview'`）：读文件 → 剥前言/尾链 → 渲染。
 * ⚠️ 剥离口径**复用卡片摘要那一份**（`summary.cardBody`）—— 自己再写一遍必然漂，
 * 症状是"卡片里看不到前言、小窗里却看得到"（同一份数据两种说法）。
 */
async function renderPreview(tab: CwTab): Promise<void> {
  const p = tab.panel;
  try {
    const raw = await p.deps.ctx.app.vault.read(tab.file);
    // 读盘期间可能已经切走/关掉了
    if (!tab.editorHost.isConnected) return;
    const view = p.deps.cfg.get().view;
    const cut = cardBody(raw, {
      stripFrontmatter: view.stripFrontmatter,
      stripTail: view.stripTail,
      markers: view.stripMarkers,
      title: liveEntry(p, tab).basename,
    });
    await MarkdownRenderer.render(p.deps.ctx.app, cut.text, tab.editorHost, tab.path, p.component);
  } catch (e) {
    tab.editorHost.appendChild(
      div({
        cls: 'kbw-cw-note is-warn',
        text: `读正文失败：${e instanceof Error ? e.message : String(e)}`,
      }),
    );
  }
}

/**
 * **尾链折叠的落点**（f 期第 4 条）：挂上编辑器那一趟调一次，之后
 * `stripTail` 从关变开时由 `rebuildAll` 再补一次（🟡4）。
 *
 * ⚠️ 三条口径（用户 2026-09-26 拍板 + 独立审查 🟡4）：
 *  · **只在挂载时折**（用户自己展开之后不许再抢）；
 *  · **失败要能重来**：`tailFolded` 只在**真折上**之后才置位 ——
 *    原先"先置位再折"，3 秒内没找到指示器就**永久放弃**（文档特别大 / 挂载特别慢时可达）；
 *  · 跟随 `view.stripTail`（关掉它就不折）。
 */
function maybeFoldTail(p: CwPanel, tab: CwTab): void {
  if (tab.tailFolded || !tab.view) return;
  if (!p.deps.cfg.get().view.stripTail) return;
  const cfg = p.deps.cfg.get();
  const edAny = (tab.view as unknown as { editor?: Editor }).editor ?? null;
  /**
   * ⚠️ 行号**不在这一层算**（这里文档可能还没进编辑器）—— 交给 `foldTailHeading` 自己
   * "等文档就绪再算再折"（它内部有重试；见那个函数的注释）。
   */
  void foldTailHeading(
    edAny as unknown as { getValue?: () => string; scrollIntoView?: (p: { line: number; ch: number }, c?: boolean) => void } | null,
    (tab.view as unknown as { containerEl?: HTMLElement }).containerEl ?? null,
    cfg.view.stripMarkers,
    () => panels.has(p) && findTab(p, tab.path) === tab,
  ).then((folded) => {
    if (folded) tab.tailFolded = true; // 只有真折上才算折过（失败留给下一次机会）
  });
}

async function mountEditor(tab: CwTab, gotoLine: number | null): Promise<void> {
  const p = tab.panel;
  try {
    /**
     * ⚠️ `new WorkspaceLeaf(app)` 是**半公开**用法（S1 探针在真机上验过：能建、能挂、
     * `detach()` 能收）。`@types/obsidian` 里这个构造函数写成 0 参 —— 类型与实际不符，
     * 所以这里显式转一下，别为了过编译把 app 丢掉（丢了真机上就建不出叶）。
     */
    const LeafCtor = WorkspaceLeaf as unknown as new (app: unknown) => WorkspaceLeaf;
    const leaf = new LeafCtor(p.deps.ctx.app);
    await leaf.setViewState({
      type: 'markdown',
      state: { file: tab.path, mode: 'source' },
    } as never);
    /**
     * **平台自己的"打开到某一行"通道**（a.5-5）：搜索跳转、反链跳转用的就是它 ——
     * 由视图在完成布局后自己应用，不受"叶子刚挂上、文档还没进编辑器"的时序影响。
     * 下面的光标重试只是兜底（万一某个版本不吃 ephemeral state）。
     */
    if (gotoLine != null) {
      try {
        (leaf as unknown as { setEphemeralState?: (st: unknown) => void }).setEphemeralState?.({
          line: gotoLine,
          ch: 0,
        });
      } catch (e) {
        console.error('[经纬] ephemeral state 定位失败（不影响打开）', e);
      }
    }
    // tab 在挂载途中被关掉 / 面板被收掉 → 别留悬挂的叶
    /**
     * 🔴 **守卫要认对象身份，不能只认路径**（独立审查 🔴2，实测复现）：
     * 「关掉这一篇 → 立刻再开同一篇」时，第一发挂载回来会发现 path **又在列表里**了
     *（命中的是**新**那个 tab）→ 只按路径判会放行 → 叶被挂进**已经拆掉的旧页**、
     * 写回**已经出列的旧 tab** → 谁也不 detach 它（同一篇两个活叶，违反口径 ①）。
     * 所以三个条件都要：面板还在 · 列表里那一个**就是我自己** · 我还没有叶。
     */
    if (!panels.has(p) || findTab(p, tab.path) !== tab || tab.leaf !== null) {
      try {
        leaf.detach();
      } catch {
        /* 忽略 */
      }
      return;
    }
    const view = leaf.view as unknown as MarkdownView;
    const containerEl = (view as unknown as { containerEl: HTMLElement }).containerEl;
    containerEl.classList.add('kbw-cw-leaf');
    tab.editorHost.appendChild(containerEl);
    tab.leaf = leaf;
    tab.view = view;
    if (gotoLine != null) await gotoLineIn(tab, gotoLine);
    // 挂上之后把当前这一页标出来（探针据此断言"打开的是这一篇"）
    tab.page.dataset.path = tab.path;
    /**
     * **尾链折叠**（f 期第 4 条，用户拍板"自动折叠、可点开"）：尊重 `view.stripTail` ——
     * 卡片那边剥掉的那一段，小窗这边**折**起来（内容一个字不改，点一下还能展开）。
     * ⚠️ 只在**挂上编辑器这一趟**折一次（`tab.tailFolded`）：用户自己展开之后不许再抢
     *（那是他的操作；重挂编辑器时才会按新档再折一次）。
     */
    maybeFoldTail(p, tab);
  } catch (e) {
    console.error('[经纬] 面板挂编辑器失败', e);
    tab.editorHost.appendChild(
      div({
        cls: 'kbw-cw-note is-warn',
        text: `这个环境挂不上真编辑器（${e instanceof Error ? e.message : String(e)}）—— 用「打开笔记」改正文。`,
      }),
    );
  }
}

/**
 * **单击位置 → 起始输入位置**（a.5-5）：把编辑器滚到那一行、光标落在行首。
 * 用 CodeMirror 自己的 API（`view.editor`）：`setCursor` + `scrollIntoView(..., true)`
 * （第二参 true = 顶到上方，跟"我要从这儿开始写"的手感一致）。
 * 行号越界就原样不动 —— 文件可能刚被外面改过。
 */
async function gotoLineIn(tab: CwTab, gotoLine: number): Promise<void> {
  const p = tab.panel;
  /**
   * ⚠️ **每次都重新取 `view.editor`**（真机实测）：文档进编辑器时视图可能被重建过一次，
   * 早先抓在手里的那个 editor 包装对象就作废了 —— 在它上面 setCursor 毫无效果
   *（症状：行号算对了、编辑器纹丝不动，连 `.cm-cursor` 都不渲染）。
   */
  const edNow = (): Editor | undefined =>
    (tab.view as unknown as { editor?: Editor } | null)?.editor;
  /**
   * ⚠️ **要等文档真的进编辑器再落点**（真机实测）：叶子刚挂上时编辑器里还是空的
   * （`lineCount()` = 1），此时 `setCursor` 还没意义；而平台随后会把
   * "上次的光标位置 / ephemeral state" 应用上来，抢在它前面设等于白设。
   * 所以：空文档就每 150ms 再试（最多 ~4.5s）；**一旦有内容就收手** ——
   * 那时要么平台已经应用过了，要么用户自己开始打字了，都不是我们该覆盖的。
   */
  const apply = (tries: number): void => {
    if (!panels.has(p) || findTab(p, tab.path) !== tab) return;
    try {
      const ed = edNow();
      const total = ed?.lineCount() ?? 0;
      if (total <= 1) {
        if (tries > 0) window.setTimeout(() => apply(tries - 1), 150);
        return;
      }
      if (!ed || gotoLine < 0 || gotoLine >= total) return;
      /** @param first 第一次落点**无条件设**；后面那两次复投只在"光标还在那一行"时才动手 */
      const put = (first: boolean): void => {
        const e2 = edNow();
        if (!e2 || !panels.has(p) || findTab(p, tab.path) !== tab) return;
        /**
         * 🔴 **用户已经在窗里打字了就别抢**（独立审查 🟡5）：文档就绪可能要 1–2s，
         * 这期间他完全可能点进标题框开始改 —— 这时 `focus()` 会把焦点夺走，
         * 标题框 `blur` 于是拿着**半截标题**提交改名。宁可不落点，也别替用户提交。
         */
        if (first) {
          const act = document.activeElement as HTMLElement | null;
          if (act && tab.page.contains(act) && isEditable(act)) return;
        }
        /**
         * ⚠️ **只在"光标还在我们设的那一行"时才复投**：首次调用发生在编辑器刚挂上、
         * **还没量过尺寸**的时刻（CodeMirror 这时吃不下 scrollIntoView / focus，
         * 真机实测：光标设上了、视口纹丝不动、`.cm-cursor` 都不渲染）。
         * 所以布局完成后再补两次；一旦用户自己动了光标，就再也不碰它。
         */
        try {
          const cur = e2.getCursor();
          if (!first && (cur.line !== gotoLine || cur.ch !== 0)) return;
          e2.setCursor({ line: gotoLine, ch: 0 });
          e2.scrollIntoView({ from: { line: gotoLine, ch: 0 }, to: { line: gotoLine, ch: 0 } }, true);
          e2.focus();
          /**
           * ⚠️ **再补一次 DOM 层的滚动**（真机实测踩到）：CodeMirror 的 `scrollIntoView`
           * 只滚它**自己的**滚动容器，而这一窗里真正在滚的可能是外层的面板/宿主 ——
           * "行号设上了、视口纹丝不动"就是这么来的。
           * 直接找到那一行的 `.cm-line` 元素调 DOM 的 `scrollIntoView`：
           * 它会把**沿途每一层**滚动容器都带到位，不依赖"谁在滚"这个假设。
           * （CM 若启用了虚拟滚动、只渲染可见行，索引对不上 → 这一步跳过，不影响光标。）
           */
          try {
            const cEl = (tab.view as unknown as { containerEl?: HTMLElement } | null)?.containerEl;
            const lineEls = cEl ? Array.from(cEl.querySelectorAll<HTMLElement>('.cm-line')) : [];
            // `nearest` = 最小滚动（`center` 在真机上滚过头，把那一行带到了窗框上方）
            lineEls[gotoLine]?.scrollIntoView?.({ block: 'nearest' });
          } catch (e) {
            console.error('[经纬] 滚动到那一行失败（不影响光标）', e);
          }
        } catch (e) {
          console.error('[经纬] 定位到行失败', e);
        }
      };
      put(true);
      window.setTimeout(() => put(false), 400);
      window.setTimeout(() => put(false), 1200);
      /**
       * 把"编辑器现在停在哪一行"写到面板上：探针据此断言
       *（光标元素 `.cm-cursor` 只在聚焦时才渲染，拿它当唯一判据会假红）。
       */
      const mark = (): void => {
        try {
          const e3 = edNow();
          const cur = e3?.getCursor();
          if (cur) tab.page.dataset.cursorLine = String(cur.line);
        } catch {
          /* 拿不到就算了 */
        }
      };
      mark();
      window.setTimeout(mark, 400);
      window.setTimeout(mark, 1200);
    } catch (e) {
      console.error('[经纬] 定位到行失败', e);
    }
  };
  apply(30); // ≈4.5s：真机上文档进编辑器可能要一两秒（实测 1.8s 的窗口不够）
}

// ────────────────────────────────────────────────────────────────
// 设置变了 → 就地重建（不关面板、不切 tab）
// ────────────────────────────────────────────────────────────────
function rebuildAll(p: CwPanel): void {
  p.rebuilding = true;
  try {
    const cfg = p.deps.cfg.get();
    /**
     * **只有真的换了档才重建**（本期自己复查时补的）：
     * `cfg.onChange` 是**整份配置**的变动通知 —— 拖卡片里那根分隔条、`Ctrl+滚轮` 缩放、
     * 改卡片显示档……每一项都会走到这里。不加判据的话：
     *  · 拖一次分隔条就把**所有 tab 的属性块**重画一遍（几十个控件白重建）；
     *  · 顺带把用户点开的「显示全部属性」**收回去**（重建 = 丢掉那个展开态）。
     * 所以按"**这一篇**的档位有没有变"来决定重建哪一块 ——
     * ⚠️ f 期起档位是**每篇一份**（`panelByPath`），所以判据要一页一页地比
     *（面板级比一次的话，"只改了乙篇的档位"会被判成"谁都没变"）。
     */
    for (const tab of p.tabs) {
      const propsNow = panelPropsFor(cfg, tab.path);
      const contentNow = panelContentFor(cfg, tab.path);
      const propsChanged = tab.lastProps !== propsNow;
      const contentChanged = tab.lastContent !== contentNow;
      tab.lastProps = propsNow;
      tab.lastContent = contentNow;
      /**
       * **字号与比例每次都落一遍**（f 期第 2 / 5 条）：它们不重建任何东西，
       * 只是往页上写两个 CSS 变量（`applyPanelFont` / `applyPanelRatio` 内部按值设/摘）。
       * 放在"档位变了才动"的判据外面 —— 否则"只改了字号"这一趟会被整段跳过。
       */
      applyPanelFont(tab.page, panelFontFor(cfg, tab.path));
      if (p.active === tab.path) applyPanelScale(p.h.root, panelFontFor(cfg, tab.path));
      applyPanelRatio(tab.page, panelRatioFor(cfg, tab.path));
      /** 🟡4：把「藏掉尾链」从关拨到开之后，补折一次（`maybeFoldTail` 里自带"折过就不折"） */
      maybeFoldTail(p, tab);
      if (!propsChanged && !contentChanged) continue;
      /**
       * **属性块重建不碰编辑器**（`paintProps` 只重画那一块）——
       * 早先 `panelProps` 一变就"关窗再开一扇"，多篇之后那等于把 N 个编辑器全重挂一遍。
       * 只有 `panelContent` 真的换了形态（editor ↔ preview ↔ none）才需要重挂正文。
       */
      const wasEditor = !!tab.leaf;
      const wantsEditor = contentNow === 'editor';
      if (propsChanged) paintProps(tab);
      if (!contentChanged) continue;
      if (wasEditor !== wantsEditor) {
        // 形态换了：先把旧的收干净再画新的（顺序不能反）
        if (wasEditor) {
          void (async () => {
            await saveTab(tab);
            detachLeaf(tab);
            paintContent(tab, null);
          })();
          continue;
        }
        paintContent(tab, null);
      } else if (!wasEditor) {
        // 一直是 preview / none：重画那一块（内容可能变了）
        paintContent(tab, null);
      }
    }
  } finally {
    p.rebuilding = false;
  }
}

/**
 * **分隔条显不显示**（f 期第 5 条）：两边都得有内容才有"分"的必要 ——
 * 属性档是 `none`（整块藏了）或正文档是 `none` 时，分隔条只会是一条拖不动的死线。
 * ⚠️ 谁渲染谁负责贴（本项目的老教训）：`paintProps` 与 `paintContent` **各调一次**，
 * 因为两个档位谁先变都有可能。
 */
function syncSplitter(tab: CwTab, propsMode: PanelPropsMode, contentMode: PanelContentMode): void {
  const show = propsMode !== 'none' && contentMode !== 'none';
  tab.splitter.style.display = show ? '' : 'none';
}

// ────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────
/**
 * 这个窗里显示哪些属性：规范顺序里**这一篇真有的** + **每篇都该有的那几个**
 *（v2：类型/状态/tags —— 见 `schema.ts` 的 `requiredFor`），去掉只读项（`创建日期`）。
 * 不显示"库里所有属性"——那会把窗撑爆。
 */
export function propsFor(entry: NoteEntry): string[] {
  const always = new Set(requiredFor(entry.props['类型']).map((s) => s.name));
  return PROP_ORDER.filter((p) => {
    const spec = SPEC_BY_NAME[p];
    if (!spec || spec.readOnly) return false;
    if (p === 'tags') return true; // 标签是横切属性，永远显示
    return entry.props[p] != null || always.has(p);
  });
}

/**
 * 小窗的显示设置菜单（属性 / 正文 / 字号）。**就地重建**，不关窗 ——
 * 用户按下就看得见效果，不用"下次打开生效"那种说法。
 *
 * f 期（第 3 条）把菜单拆成**两层作用域**（用户拍板："菜单里明确区分『这一篇』与『所有卡片』"）：
 *  · 「这一篇」写 `panelByPath[path]`（只影响当前这一扇/这一篇）
 *  · 「所有窗的默认」写看板级那份（`panelProps` / `panelContent` / `panelFont`）
 * 外加一条**「跟随看板默认（清除这一篇）」**（清掉覆盖 —— 否则设过一次就回不去）。
 * ⚠️ 两层的勾选**各看各的**：上面那行永远显示**这一篇此刻生效的值**，下面那组显示看板默认，
 * 混着显示的话用户没法知道"现在这个效果是谁给的"。
 */
export function openPanelSettings(
  evt: MouseEvent,
  tab: CwTab,
  c: CardWindowCtx,
  rebuild: () => void,
  panel: CwPanel,
): void {
  const view = c.cfg.get().view;
  const cfgNow = c.cfg.get();
  /** 这一篇此刻**生效**的值（覆盖 → 看板默认） */
  const effProps = panelPropsFor(cfgNow, tab.path);
  const effContent = panelContentFor(cfgNow, tab.path);
  const effFont = panelFontFor(cfgNow, tab.path);
  const pref = cfgNow.view.panelByPath?.[tab.path] ?? {};

  const commit = (patch: Partial<import('./config').BoardView>, label: string): void => {
    void c.cfg.patchView(patch).then(() => {
      c.onReceipt(label);
      rebuild();
    });
  };
  /** 写"这一篇"的那一层 */
  const setMine = (p: import('./config').PanelPrefPatch, label: string): void => {
    commit({ panelByPath: withPanelPref(c.cfg.get().view, tab.path, p) }, label);
  };
  const item = (group: string, label: string, checked: boolean, run: () => void): import('../../ui/menu').MenuItem => ({
    kind: 'item',
    label,
    control: { type: 'radio', checked, group },
    run,
  });
  const shortName = tab.path.split('/').pop() ?? tab.path;

  showContextMenu(evt, {
    scope: { kind: 'global', label: `小窗显示 · ${shortName}` },
    items: [
      /**
       * **此刻生效的是什么**（置灰的信息行，不是开关）：两层设置叠在一起之后，
       * "现在这个效果是谁给的"必须看得见 —— 否则用户会对着"上面选了不显示、
       * 底下还写着前 6 行"犯迷糊。
       */
      {
        kind: 'item',
        label: `此刻生效：属性 ${EFF_LABEL.effProps(effProps)} · 正文 ${EFF_LABEL.effContent(effContent)} · 字号 ${fontLabel(effFont)}`,
        icon: 'info',
        disabled: '这一行是说明（下面是两处入口）',
      },
      { kind: 'separator' },
      {
        /**
         * **窗口大小三档**（P6b ③）：这是拖右下角那个把手的**键盘/触屏等价物**
         *（WCAG 2.2 Dragging Movements：「凡是有拖动的功能，都要有一个非拖动的入口」）。
         *
         * ⚠️ 它是**这一扇窗**的现状、**只记会话内存**（与 tab 列表同一条口径：
         * 那是工作现场，不该跟着库同步到别的机器上）。
         * P7.2c 起**拖完/缩完会把它记进 `data.json` 的 `panelGeo`**（下一扇新窗用）——
         * 会话内各窗互不影响这条口径没变，变的只是"新窗从哪儿开始"。
         */
        kind: 'item',
        label: '窗口大小',
        icon: 'maximize-2',
        submenu: [
          { key: 'narrow', label: '窄（340 × 420）' },
          { key: 'normal', label: '中（420 × 560）' },
          { key: 'wide', label: '宽（560 × 660）' },
          { key: 'reset', label: '复位（回到默认宽）' },
          /**
           * **最大化 / 还原**（P7.2c · 4.3-①）：双击标题栏那条的**键盘/触屏等价物**
           *（与上面三档同一条 WCAG 口径 —— 双击是个纯鼠标手势）。
           * 标签跟着现状走：开着的时候只有「还原」（点了等于现状的项是死选项）。
           * ⚠️ **停靠态置灰写明原因**（独立审 🟡6）：`toggleMaximize` 在停靠态是空操作
           *（窗格本来就铺满）—— 不置灰的话会发出"已最大化"的假回执（本项目最忌的
           *"界面承诺了、代码没做"）。
           */
          {
            key: 'max',
            label: panel.h.isMaximized() ? '还原（回到原大小）' : '最大化（铺满工作台）',
          },
        ].map((x) => ({
          kind: 'item' as const,
          label: x.label,
          /**
           * 停靠态这一整组都置灰（独立审 🟡5/🟡6 的同一条根）：窗格的尺寸归窗格自己
           *（拖内沿分隔条 /「停靠的大小」那组菜单），面板这三档 + 最大化写进去只会在
           *"浮层"形态生效 —— 停靠时点它们要么是空操作（最大化）要么反而把 `100%` 顶掉（三档）。
           */
          disabled: panel.h.isDocked() ? '停靠态尺寸归窗格（拖窗格内沿那根分隔条）' : undefined,
          run: () => {
            if (x.key === 'reset') {
              panel.h.setSize(null, null);
              c.onReceipt('窗口大小：复位');
              return;
            }
            if (x.key === 'max') {
              const was = panel.h.isMaximized();
              panel.h.toggleMaximize();
              c.onReceipt(was ? '窗口：已还原' : '窗口：已最大化（铺满工作台）');
              return;
            }
            const size =
              x.key === 'narrow'
                ? { w: 340, h: 420 }
                : x.key === 'wide'
                  ? { w: 560, h: 660 }
                  : { w: 420, h: 560 };
            panel.h.setSize(size.w, size.h);
            c.onReceipt(`窗口大小：${size.w} × ${size.h}`);
          },
        })),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: '这一篇',
        icon: 'file',
        submenu: [
          {
            kind: 'item',
            label: '小窗属性',
            submenu: [
              item('m-props', '前 6 行', effProps === 'few', () => setMine({ props: 'few' }, '这一篇的小窗属性：前 6 行')),
              item('m-props', '全部', effProps === 'all', () => setMine({ props: 'all' }, '这一篇的小窗属性：全部')),
              item('m-props', '不显示', effProps === 'none', () => setMine({ props: 'none' }, '这一篇的小窗属性：不显示')),
            ],
          },
          {
            kind: 'item',
            label: '小窗正文',
            submenu: [
              item('m-content', '可编辑', effContent === 'editor', () => setMine({ content: 'editor' }, '这一篇的小窗正文：可编辑')),
              item('m-content', '只读预览（剥前言与尾链）', effContent === 'preview', () => setMine({ content: 'preview' }, '这一篇的小窗正文：只读预览')),
              item('m-content', '不显示', effContent === 'none', () => setMine({ content: 'none' }, '这一篇的小窗正文：不显示')),
            ],
          },
          {
            kind: 'item',
            /**
             * **预览换行**（P6b ⑥）：这一篇一层。只读预览那一档才看得见效果，
             * 所以文案里点明它（不然"我开了怎么没反应"）。
             */
            label: '预览换行',
            submenu: [
              item('m-wrap', '跟随看板默认', typeof pref.wrap !== 'boolean',
                () => setMine({ wrap: null }, '这一篇的预览换行：跟随看板默认')),
              item('m-wrap', '换行（默认）', pref.wrap === true,
                () => setMine({ wrap: true }, '这一篇的预览换行：折行')),
              item('m-wrap', '横向滚动（不折行）', pref.wrap === false,
                () => setMine({ wrap: false }, '这一篇的预览换行：横向滚动')),
            ],
          },
          {
            kind: 'item',
            label: '小窗字号',
            submenu: [
              /**
               * ⚠️ 这一项**不是"跟随平台"**（C1，用户 2026-09-27 拍板）：没设过时用的是
               * **平台 + `PANEL_FONT_DELTA`**（`defaultPanelFont()`），所以文案要照实写、数字**现算**，别抄一份字面量。
               */
              item('m-font', `默认（平台 ${PANEL_FONT_DELTA}px → ${defaultPanelFont()}px）`, pref.font == null,
                () => setMine({ font: null }, `这一篇的小窗字号：默认（${defaultPanelFont()}px）`)),
              ...PANEL_FONT_STEPS.map((px) =>
                item('m-font', `${px}px`, pref.font === px, () => setMine({ font: px }, `这一篇的小窗字号：${px}px`)),
              ),
            ],
          },
          {
            kind: 'item',
            label: '跟随看板默认（清除这一篇的设置）',
            icon: 'undo',
            run: () =>
                setMine(
                  { props: null, content: null, font: null, ratio: null, wrap: null },
                  '这一篇的小窗设置：跟随看板默认',
                ),
          },
        ],
      },
      {
        kind: 'item',
        label: '所有窗的默认',
        icon: 'layers',
        submenu: [
          {
            kind: 'item',
            label: '小窗属性',
            submenu: [
              // ⚠️ C2 起"不显示"是默认档（用户 2026-09-27 拍板），标记要跟着走
              item('panelProps', '前 6 行', view.panelProps === 'few', () => commit({ panelProps: 'few' }, '小窗属性（所有窗）：前 6 行')),
              item('panelProps', '全部', view.panelProps === 'all', () => commit({ panelProps: 'all' }, '小窗属性（所有窗）：全部')),
              item('panelProps', '不显示（默认）', view.panelProps === 'none', () => commit({ panelProps: 'none' }, '小窗属性（所有窗）：不显示')),
            ],
          },
          {
            kind: 'item',
            label: '小窗正文',
            submenu: [
              item('panelContent', '可编辑（默认）', view.panelContent === 'editor', () => commit({ panelContent: 'editor' }, '小窗正文（所有窗）：可编辑')),
              item('panelContent', '只读预览', view.panelContent === 'preview', () => commit({ panelContent: 'preview' }, '小窗正文（所有窗）：只读预览')),
              item('panelContent', '不显示', view.panelContent === 'none', () => commit({ panelContent: 'none' }, '小窗正文（所有窗）：不显示')),
            ],
          },
          {
            kind: 'item',
            label: '预览换行',
            submenu: [
              item('previewWrap', '换行（默认）', view.previewWrap === true,
                () => commit({ previewWrap: true }, '预览换行（所有窗）：折行')),
              item('previewWrap', '横向滚动（不折行）', view.previewWrap === false,
                () => commit({ previewWrap: false }, '预览换行（所有窗）：横向滚动')),
            ],
          },
          {
            kind: 'item',
            label: '小窗字号',
            submenu: [
              /**
               * ⚠️ 文案与「这一篇」那一层**同源**（`0` 的含义是"没设过 → 平台 + `PANEL_FONT_DELTA`"，
               * 不是"跟随平台"）——独立审查 A 路 🔴3：同一张菜单上下两层说法相反，用户会以为没生效。
               * 数字**现算**（`defaultPanelFont()`），别再抄一份。
               */
              item(
                'panelFont',
                `默认（平台 ${PANEL_FONT_DELTA}px → ${defaultPanelFont()}px）`,
                view.panelFont === 0,
                () => commit({ panelFont: 0 }, `小窗字号（所有窗）：默认（${defaultPanelFont()}px）`),
              ),
              ...PANEL_FONT_STEPS.map((px) =>
                item('panelFont', `${px}px`, view.panelFont === px, () => commit({ panelFont: px }, `小窗字号（所有窗）：${px}px`)),
              ),
            ],
          },
        ],
      },
    ],
  });
}

/** 那一行"此刻生效"文案里用的短标签（三档的中文说法只有这一处） */
const EFF_LABEL = {
  effProps: (v: PanelPropsMode): string => (v === 'few' ? '前 6 行' : v === 'all' ? '全部' : '不显示'),
  effContent: (v: PanelContentMode): string =>
    v === 'editor' ? '可编辑' : v === 'preview' ? '只读预览' : '不显示',
};

/** 字号的显示文案：`0` = 没设过 → **默认那一档**（平台 −2px），照实报出算出来的 px */
function fontLabel(fs: number): string {
  return fs > 0 ? `${fs}px` : `默认（${defaultPanelFont()}px）`;
}

/**
 * **短目录**（P6b ⑤）：标题右侧那行字从"整条路径"缩成"它在哪"。
 *
 * 规则：去掉库根前缀与文件名 → 最多留**最后两段**（`02_Areas/每日任务`）。
 * 库根那几篇显示「库根」。空路径/拿不到库根时退回原样（宁可多显示，不可显示错）。
 */
export function shortDir(ctx: { settings: { kbRoot(): string } }, path: string): string {
  const root = (ctx.settings.kbRoot() || '').replace(/\/+$/, '');
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const slash = rel.lastIndexOf('/');
  const dir = slash >= 0 ? rel.slice(0, slash) : '';
  if (!dir) return '库根';
  const segs = dir.split('/').filter(Boolean);
  return segs.slice(-2).join('/');
}

/**
 * 面板摆在哪：**这一篇所在那一列的顶部居中**（用户 2026-09-25 的口径）。
 * 找卡片用 `data-path` **逐个比**而不是拼 CSS 选择器 —— 路径里有引号/方括号时选择器会炸。
 * 找不到卡片（比如从别处调进来的）就退回看板宿主的顶部居中。
 *
 * @param at 不给 `path` 时退到看板宿主（新建面板那一刻还不知道要贴哪儿）
 */
function columnTopCenter(at: { path?: string }): { x: number; y: number } {
  const card = at.path
    ? Array.from(document.querySelectorAll<HTMLElement>('[data-card]')).find(
        (c) => c.dataset.path === at.path,
      )
    : null;
  const sect = card?.closest<HTMLElement>('.kbw-sect');
  const r = sect?.getBoundingClientRect();
  const base =
    r && r.width > 0
      ? { x: r.left + r.width / 2, y: r.top + 6 }
      : (() => {
          const b = document.querySelector<HTMLElement>('.kbw-board')?.getBoundingClientRect();
          return b && b.width > 0
            ? { x: b.left + b.width / 2, y: b.top + 8 }
            : { x: (window.innerWidth || 1200) / 2, y: 40 };
        })();
  /**
   * **多窗要错开**（f 期）：新窗跟已有窗落在同一个点时，看上去像"没反应"
   * （用户以为没开出来，又点一次）。所以按"现在开着几扇"往下右各挪一点 ——
   * 挪出去的部分由 `ui/panel.ts` 的 `keepInside()` 夹回视口内（不会挪出屏幕）。
   * ⚠️ 只对**新窗**生效（建窗那一刻算一次），拖动/重摆都不再动它。
   */
  const step = Math.min(panels.size, 4) * 26;
  return { x: base.x + step, y: base.y + step };
}
