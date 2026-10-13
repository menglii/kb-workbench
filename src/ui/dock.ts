/**
 * ui/dock.ts —— **停靠（dock）的纯运算**（P4.5 §3.1「可停靠面板」/ d2 期）
 *
 * §3.1 的原话：
 * ```
 * | 停靠（dock） | 拖到工作台的左 / 右 / 下，变成一条固定窗格 | PyCharm 的 Dock/Undock |
 * ```
 * 一句话：**让就地编辑面板从"浮在工作台上面"变成"钉在工作台边上"**，
 * 而且停靠之后它仍然是那一组 tab、仍然各自挂着真编辑器。
 *
 * ── 为什么这个文件在 `ui/` 而不是 `modules/board/` ──────────────
 * 停靠牵两头：**外壳**（`.kbw-dock` 宿主与 `data-w` 断点）与**面板**（看板的就地编辑面板）。
 * 放 `modules/board/` 的话，`view/workbench-view.ts` 要 import 它 —— 那是 view → board，
 * 方向是对的；但这一期真正的红线是**反方向不许有**（board → view 会成环）。
 * 放 `ui/` 两边都顺向（`view → ui`、`board → ui`），和 `ui/panel.ts`、`ui/menu.ts` 同一层。
 *
 * ── 为什么抽出来 ──────────────────────────────────────────────
 * 与 `board/tabs.ts`、`board/select.ts` 同一条理由：**规则只有一处出处**。
 * 「停哪儿、多宽、这个容器放不放得下」全是纯算术，离线可穷举；一旦散进
 * `updateLayoutWidth()` 和面板那两处，两边迟早会漂（这一期最怕的就是这个 ——
 * 断点漂了 b/c 期的窄档用例会集体假红）。
 */
import { clamp } from '../core/util';
// ⚠️ 默认值**不在这里**（`core/config-files.ts` 是唯一真源 —— `board/config.ts` 顶上
// 就写着这句话）。这里只在自己的兜底分支里读它，不另立一份。
import { BOARD_VIEW_DEFAULTS } from '../core/config-files';

// ────────────────────────────────────────────────────────────────
// 形状与常量
// ────────────────────────────────────────────────────────────────
export type DockSide = 'left' | 'right' | 'bottom';

export const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'bottom'];

export interface DockState {
  /** 停在哪一边；`null` = 不停靠（还是浮层那套） */
  where: DockSide | null;
  /** 窗格尺寸（px）：`left` / `right` 是**宽**，`bottom` 是**高** */
  size: number;
}

/** 还没停过的时候给它一个尺寸 —— 选边之后沿用这个值（见 `withDockSide`） */
export const DOCK_DEFAULT_SIZE = BOARD_VIEW_DEFAULTS.dock.size;
/** 比这还窄/矮就不叫窗格了 */
export const DOCK_MIN = 240;
export const DOCK_MAX = 760;
/** 底部窗格是"高"，一般不该占掉屏幕的一大半 */
export const DOCK_MAX_BOTTOM = 620;

/**
 * 停靠生效之后，**主内容区**至少还要留这么多 —— 不够就干脆不停靠（退回浮层）。
 *
 * ⚠️ 与外壳那个 `NARROW_MAX`（窄档阈值）**同值但不同义**，别合并：
 *  · 窄档说的是「整个工作台窄了」→ 导航变底部 tab 栏
 *  · 这里说的是「停靠吃掉一块之后主区还剩多少」
 * 两者恰好都是 640：主区低于窄档阈值，本来也就该走窄档布局 —— 而窄档下不停靠，
 * 于是就有了一条**不会来回翻**的判据（见 `dockFit` 上面那段）。
 */
export const DOCK_MIN_MAIN_W = 640;
/** 底部停靠时主区至少要留的高 */
export const DOCK_MIN_MAIN_H = 360;

/** 一份默认值（`where: null` = 不停靠）—— 配置缺省时用它 */
export function defaultDock(): DockState {
  return { where: null, size: DOCK_DEFAULT_SIZE };
}

// ────────────────────────────────────────────────────────────────
// 预览窗格（Peek，e 期 §3.2）—— 与停靠**共用同一个宿主**，所以形状也共用
// ────────────────────────────────────────────────────────────────
/**
 * 预览窗格的落点。
 *
 * 🔴 **它没有"不停靠"这一档**（与 `DockState` 的区别就在这儿）：Peek 只有**窗格**形态 ——
 * §3.2 要的就是"右侧**常驻**一个只读预览"，浮起来的预览（跟着光标弹）正是 §12 决策 5
 * 否掉的那个东西。所以 `where` 非空：不想要它就关掉 `enabled`。
 *
 * ⚠️ 关着的时候**位置与大小照样记着**（下次打开还停在该在的那一边），与 `dock` 同一条口径。
 */
export interface PeekDock {
  where: DockSide;
  size: number;
}

/** 预览窗格默认停右边（§3.2 原话就是"右侧常驻"） */
export function defaultPeek(): PeekDock {
  return { where: 'right', size: BOARD_VIEW_DEFAULTS.peek.size };
}

/**
 * 解析库内配置里那一份。走 `normalizeDock`（**唯一出处**）再补一个默认边 ——
 * 脏值 / 旧版本 / 另一台机器同步过来的都在那一处收口，这里只管"不许是 null"。
 */
export function normalizePeek(raw: unknown): PeekDock {
  const d = normalizeDock(raw);
  return { where: d.where ?? defaultPeek().where, size: d.size };
}

/** 换边（尺寸沿用当前值，只按新边夹一次）—— 与 `withDockSide` 同一套规矩 */
export function withPeekSide(peek: PeekDock, where: DockSide): PeekDock {
  return { where, size: clamp(peek.size, DOCK_MIN, maxSize(where)) };
}

// ────────────────────────────────────────────────────────────────
// 解析（配置 → 状态）
// ────────────────────────────────────────────────────────────────
function isSide(v: unknown): v is DockSide {
  return v === 'left' || v === 'right' || v === 'bottom';
}

/**
 * 把配置里那一份（可能是任何东西：手改过、旧版本、别的机器同步过来的）收成 `DockState`。
 * 认不出的边一律当"不停靠"（**不猜**：猜错方向比不生效烦人得多）。
 */
export function normalizeDock(raw: unknown): DockState {
  const o = (raw ?? {}) as { where?: unknown; size?: unknown };
  const where = isSide(o.where) ? o.where : null;
  const size = clampNumber(o.size, DOCK_MIN, maxSize(where), DOCK_DEFAULT_SIZE);
  return { where, size };
}

/** 这一边允许的上限 */
export function maxSize(where: DockSide | null): number {
  return where === 'bottom' ? DOCK_MAX_BOTTOM : DOCK_MAX;
}

/** 选一边（或取消）。尺寸沿用当前值，只按新边夹一次 —— 不重置成默认（用户的宽度该记住） */
export function withDockSide(dock: DockState, where: DockSide | null): DockState {
  return { where, size: clamp(dock.size, DOCK_MIN, maxSize(where)) };
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.round(clamp(n, lo, hi));
}

// ────────────────────────────────────────────────────────────────
// 生效判定（容器尺寸 → 实际形态）
// ────────────────────────────────────────────────────────────────
export interface DockFit {
  /** 这个容器里停靠**真的生效**吗 */
  applied: boolean;
  /** 生效时停在哪一边（不生效时原样带回） */
  where: DockSide | null;
  /** **实际**用的尺寸：容器不够时会把它挤小（不生效时是原值） */
  size: number;
}

/**
 * 停靠在这个容器里放得下吗？放得下就顺便把尺寸夹到能放下的最大值。
 *
 * 🔴 **为什么要"挤小"而不是"放不下就算了"**：同一个窗口宽度，用户设 760 的窗格，
 * 拖窄一点就整个退回浮层、拖宽一点又跳回来 —— 那种"来回翻"很难用。
 * 挤到能放下的最大宽度，手感是连续的。
 *
 * 🔴 **为什么这条判据不会来回翻**（设计时专门验过的，别再"优化"掉）：
 *  · `applied` 只看**容器原始尺寸**（`w`/`h`），不看夹过之后的落点 ——
 *    所以它不依赖自己的输出，没有反馈环。
 *  · 生效 ⇒ `w - size >= 640` ⇒ `data-w` 至少是 `mid`，**永远不会是 narrow**；
 *    于是"窄档退回浮层"与"停靠生效"互斥，不会两边互相推翻。
 *  · 不生效 ⇒ 外壳按**整个宽度**算 `data-w`（就是这一期之前的行为，逐字节不变）。
 */
export function dockFit(dock: DockState, w: number, h: number): DockFit {
  const pass = { applied: false, where: dock.where, size: dock.size };
  if (!dock.where) return pass;
  if (!(w > 0) || !(h > 0)) return pass;
  const avail = dock.where === 'bottom' ? h - DOCK_MIN_MAIN_H : w - DOCK_MIN_MAIN_W;
  // 连最小窗格都放不下 → 不停靠（窄档/矮窗走浮层，见 §3.1 d2 拍板）
  if (avail < DOCK_MIN) return pass;
  const size = Math.round(clamp(dock.size, DOCK_MIN, Math.min(maxSize(dock.where), avail)));
  return { applied: true, where: dock.where, size };
}

/**
 * 停靠**从横向**吃掉多少 —— 外壳拿它去判 `data-w` 断点。
 *
 * ⚠️ 只有左右两边吃宽度；底部吃的是高度（`data-w` 是纯宽度口径，别把它算进去，
 * 算了的话底部停靠会把断点整体推错一档）。
 */
export function dockReserve(fit: DockFit): number {
  if (!fit.applied) return 0;
  return fit.where === 'bottom' ? 0 : fit.size;
}

// ────────────────────────────────────────────────────────────────
// 端口（外壳 ↔ 面板）
// ────────────────────────────────────────────────────────────────
/**
 * 工作台外壳交出来的停靠口子（挂在 `WorkbenchContext.dock` 上）。
 *
 * 形状刻意做成"**面板请求、外壳裁决**"：面板说"我要停左边、宽 380"，
 * 外壳按**当前容器尺寸**判放不放得下（`dockFit`）—— 因为只有外壳知道容器多大，
 * 也只有外壳能改 `data-w` 断点。面板只管"搬进去还是搬出来"。
 */
/**
 * **窗格的占用者**（e 期加，f 期改成"每个占用者各有身份"）。
 *
 * 🔴 为什么非要有身份：窗格只有一个，而它从 e 期起有**两个**占用者
 *（就地编辑面板 / 预览窗格 Peek）。它们各自都有"我不要了 → `request(null)`"这条收尾，
 * 而那个口子是**单槽**：**收尾不认人** —— 浮层态的面板关一下、或者它滑回浮层，
 * 就会把**别人**正占着的窗格一起撤掉（离线实测：点一张卡看一眼，旁边的预览凭空没了；
 * 独立审查又把它的两个变体都抓了出来）。有了身份之后，"撤窗格"这件事就只由
 * **当前占用者**做得成（`owner()` 一问便知）。
 *
 * 🔴 **f 期（多悬浮窗）把 `'panel'` 拆成了 `panel#<n>`**（用户 2026-09-26 拍板）：
 * 面板从"模块级单例"变成**N 个独立实例**，于是"占用者是不是面板"这句话不再够用 ——
 * 甲窗占着、乙窗关一下，按老口径（`owner() === 'panel'`）乙也会认成"是我占着"，
 * 一旦去 `request(null)` 就把甲的窗格收掉（正是 e 期那条 🔴 换了个入口复发）。
 * 所以身份带上实例号：**只有那一个窗**认得自己那一份。
 *
 * ⚠️ 名字取在**占用者**上，不是"哪个模块"：将来再多一个占用者，加进这个联合类型即可
 *（面板侧一律用 `panelOwner(id)` 造名、用 `isPanelOwner()` 判，别在别处手拼字符串）。
 */
export type DockOwner = 'peek' | `panel#${number}`;

/** 预览窗格的占用者名（唯一出处；别在别处手写 `'peek'`） */
export const PEEK_OWNER: DockOwner = 'peek';

/** 第 `id` 个工作台面板的占用者名 */
export function panelOwner(id: number): DockOwner {
  return `panel#${id}`;
}

/** 这个占用者名是不是"某个面板"（`'peek'` 与 `null` 都不是） */
export function isPanelOwner(o: DockOwner | null | undefined): boolean {
  return typeof o === 'string' && o.startsWith('panel#');
}

/** 窗格此刻的样子（`onChange` 的载荷）—— 三条信息缺一不可，见各自注释 */
export interface DockStatus {
  /** 停靠**真的生效**吗（外壳按容器尺寸裁决的结果） */
  applied: boolean;
  /** 此刻**谁**占着（`null` = 没人）。⚠️ `applied` 为假时**恒为 null** */
  owner: DockOwner | null;
}

export interface DockPort {
  /** 停靠宿主（`.kbw-dock`）—— 占用者 `setDocked(它)` 把根节点搬进来 */
  host: HTMLElement;
  /**
   * 占用者说"我要停靠在 where（`null` = 取消）"。
   * `owner` 用来**认人**：只有最后申请成功的那个才是当前占用者（见 `owner()`）。
   */
  request(where: DockSide | null, size: number, owner: DockOwner): void;
  /** 此刻停靠**真的生效**吗（外壳按容器尺寸裁决的结果） */
  applied(): boolean;
  /**
   * 此刻**谁**占着这个窗格（`null` = 没人）。**"我不要了"之前先问它一句** ——
   * 不是自己占着的就别去 `request(null)`（那会把别人的窗格撤掉）。
   */
  owner(): DockOwner | null;
  /**
   * **这个容器现在放得下「这一边、这么大」的窗格吗** —— 与"谁占着"无关，纯几何。
   *
   * 🔴 为什么需要它：`applied() === false` 有**两种完全不同的原因** ——
   * ① 容器真的放不下；② 此刻被**别人**占着。要跟用户说"放不下"只能用①，
   * 拿 `applied` 去冒充②会弹出**假通知**（独立审查实测：容器 1400px 明明放得下，
   * 让位那一下照样弹了一条「预览窗格现在放不下」）。
   */
  canHold(where: DockSide, size: number): boolean;
  /**
   * 生效状态 / 占用者变了 → 通知占用者搬进/搬出。
   * 触发源有三类：**容器尺寸变了**（拖窄/挤宽、窗口缩放）· **换边/取消停靠** ·
   * **换人**（另一个占用者把窗格要走了 —— Peek 就是靠这一条自动让位的）。
   * 返回退订函数。
   */
  onChange(cb: (s: DockStatus) => void): () => void;
  /**
   * 用户**拖分隔条**松了手 → 外壳报一个尺寸，占用者负责写进配置
   * （配置归它管：`board/config.ts` 的 `patchView`）。
   *
   * ⚠️ 拖动**期间**不调它（每像素写一次配置 = 看板整块重绘一遍），
   * 只在松手那一下调。返回退订函数。
   */
  onResize(cb: (size: number) => void): () => void;
}

// ────────────────────────────────────────────────────────────────
// DOM 契约（属性名/类名只有一处出处，别在 CSS 与 TS 里各写一份）
// ────────────────────────────────────────────────────────────────
/** 工作台外壳里那个"舞台"（左导航之外的全部）—— 停靠宿主住在它里面 */
export const DOCK_STAGE_CLASS = 'kbw-stage';
/** 停靠宿主 */
export const DOCK_HOST_CLASS = 'kbw-dock';
/** 拖分隔条改宽度用的把手 */
export const DOCK_GRIP_CLASS = 'kbw-dock-grip';
/** 舞台上的停靠形态：`none` / `left` / `right` / `bottom` */
export const DOCK_ATTR = 'data-dock';
