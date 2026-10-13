/**
 * core/view-memory.ts —— **视图记忆**（P4.5 e 期 §4.4）
 *
 * §4.4 的原话：
 * ```
 * | 4.4 | 视图记忆 | 切走再回来保持滚动位置 / 展开态 / 光标（现在回来是"重置到顶"） | 小 |
 * ```
 *
 * ── 为什么现在回来是"重置到顶" ────────────────────────────────
 * `view/workbench-view.ts` 的 `paintModule()` 换模块时把 `moduleHost` **整个清空重建**
 *（`while (host.firstChild) removeChild`，P0 起就是这条）—— 于是宿主里**每一个**滚动容器的
 * `scrollTop` 都归零。这不是 bug，是"换一屏就该是新的"，只是少了"回来时回到原处"。
 *
 * ── 记什么、不记什么（口径在 `看板优化方案.md` §6.15）──────────
 *  ① **各滚动容器位置** —— 带 `data-scroll` 的那些
 *  ② **看板键盘光标** —— 模块自己交上来（`saveMemo` / `loadMemo`）
 *  ③ **卡片正文展开态** —— 同上
 *  ④ **不记选中集**：跨模块留着选择更像"忘了清"，而批量操作会作用在看不见的地方
 *  ⑤ **不重复造**：树 / 板块的收起展开态本来就落在配置里（`view.collapsed` / `treeExpanded`），
 *     它们自己就会回来 —— 别在这儿再记一份，两份迟早漂
 *
 * ── 三条设计上的硬要求 ────────────────────────────────────────
 * 🔴 **滚动快照是一次性的**（`recallScroll` 取走就没了）：否则索引一变触发的重绘
 *   会把用户**当前**的滚动位置拽回上次记住的地方 —— 那是比"重置到顶"更烦的 bug。
 * 🔴 **恢复的时机由模块自己定**（"画完那一下"）：看板的绘制是**异步带 token** 的
 *   （`paintBoard` 先读正文再画，冷启还是两段式），视图层在 `render()` 返回后就写回
 *   只会写在一个空容器上（写了也白写 —— 那时还没有可滚的东西）。所以本文件只提供
 *   "怎么记、怎么取"，**不提供"什么时候写回"**。
 * 🔴 **只活在本次会话**（模块级 Map）：跨插件重载不保留。§4.4 说的是"切走再回来"，
 *   不是"关掉 Obsidian 再打开还在原地"。
 *
 * ── `data-scroll` 契约（谁渲染，谁负责贴）──────────────────────
 * 与项目里 `is-collapsed`（`renderSection` 那条）同一条规矩：**类的唯一来源就在渲染处**。
 * 值是这个容器在这一屏里的**稳定标识**（`modhost` / `board` / `list` / `tree`），
 * 键在整个模块内唯一即可 —— 捕获时按它写、恢复时按它找。
 */
import type { ModuleId } from './settings';

/** 滚动容器的标识属性。**只有一处出处**（TS 与探针都认它） */
export const SCROLL_ATTR = 'data-scroll';

export interface ScrollPos {
  top: number;
  left: number;
}

/** 一次捕获的结果：`data-scroll` 值 → 位置 */
export type ScrollSnap = Record<string, ScrollPos>;

/**
 * 捕获 `root` 里每一个 [`data-scroll`] 容器的位置。
 *
 * ⚠️ **包括 0**（不"只记非零的"）：用户滚下去、切走、回来滚回顶、再切走 ——
 * 只记非零的话第二次切走会**留着第一次那个非零值**，下次回来又被送回半中间。
 */
export function captureScroll(root: HTMLElement): ScrollSnap {
  const out: ScrollSnap = {};
  /**
   * ⚠️ **要把 `root` 自己也算进来**（独立审查抓的）：`querySelectorAll` **不含自己**，
   * 而调用方常常**正传着那个带标记的元素** —— 看板写回时传的就是 `.kbw-board-body`
   *（键 `board` 的宿主）、外壳兜底时传的是 `.kbw-modhost`（键 `modhost`）——
   * 于是那两个键"捕得到、写不回去"，而红线里那条"三层缺一不可"的注释白写了。
   */
  for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>(`[${SCROLL_ATTR}]`))]) {
    const key = node.getAttribute?.(SCROLL_ATTR);
    if (!key) continue;
    out[key] = { top: node.scrollTop, left: node.scrollLeft };
  }
  return out;
}

/**
 * 写回。**只写认得出的键**（快照里有、DOM 里也有），返回写了几个 —— 可断言。
 *
 * ⚠️ 容器不存在时**安静跳过**：同一份快照要面对"这一屏这次长出来的容器不全"的各种情况
 *（比如索引还没就绪、板块被删了、收起的板块没有卡片区）—— 那都不该报错。
 *
 * ⚠️ 写的是 `scrollTop` 而不是 `scrollTo({behavior:'smooth'})`：恢复要**瞬时**，
 * 滚动动画在"切回来"这一刻看着像页面自己在动。
 */
export function applyScroll(root: HTMLElement, snap: ScrollSnap | null): number {
  if (!snap) return 0;
  let n = 0;
  // ⚠️ 与 `captureScroll` 对称：**root 自己也算**（理由写在那边的注释里）
  for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>(`[${SCROLL_ATTR}]`))]) {
    const key = node.getAttribute?.(SCROLL_ATTR);
    if (!key) continue;
    const pos = snap[key];
    if (!pos) continue;
    node.scrollTop = pos.top;
    node.scrollLeft = pos.left;
    n += 1;
  }
  return n;
}

/**
 * **只把"被这次重绘清零的"容器写回去**（a.6）—— 就地重绘（索引变动 → 区域整块重画）
 * 时的滚动保持用它，与"切走再回来"那条 `applyScroll` 分开：
 *
 * 🔴 为什么不能直接 `applyScroll`：捕获与写回之间可能夹着一段**异步**（看板要重读
 * 整批卡片的正文，大库上几百毫秒）。这期间用户完全可能自己滚了一下 ——
 * 照着老快照写回，就成了**另一种"跳"**（把他刚滚到的地方拽回去），比原来那个 bug 更难解释。
 * 判据很直接：**此刻还是 0 的**才是我要救的那些容器（重绘会把它们清成 0）。
 *
 * 返回写了几个（可断言）。
 */
export function restoreIfReset(root: HTMLElement, snap: ScrollSnap | null): number {
  if (!snap) return 0;
  const keep: ScrollSnap = {};
  for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>(`[${SCROLL_ATTR}]`))]) {
    const key = node.getAttribute?.(SCROLL_ATTR);
    if (!key) continue;
    const pos = snap[key];
    if (!pos || (pos.top === 0 && pos.left === 0)) continue;
    if (node.scrollTop !== 0 || node.scrollLeft !== 0) continue; // 用户在这中间自己滚过
    keep[key] = pos;
  }
  return applyScroll(root, keep);
}

/**
 * **改名 / 搬移之后，把快照里"以路径结尾"的键换成新路径**（e2 期独立审查 🟡2）。
 *
 * 为什么需要：卡面正文的键是 `card:<板块 key>:<路径>` —— 而**改名会改路径**。
 * 改名那一下的真实现顺序是"捕获（读到的还是旧路径）→ 重绘（新路径的 DOM）→ 写回"，
 * 于是写回时**认不出那个键**（`applyScroll` 对认不出的键安静跳过）→
 * 用户在那张卡里的位置照样丢（实测：列保住了 60、卡面正文 0）。
 *
 * ⚠️ 只动**后缀**（`:` + 旧路径）：别的键（`board` / `cards:<key>` / `list`…）不受影响，
 * 也就不怕误伤。与 `board/index.ts` 里"顺序表 / 比例表跟着 rename 迁"是同一条纪律 ——
 * **表里存的是路径，就得跟着 rename 走**。
 */
export function remapScrollPath(oldPath: string, newPath: string): void {
  if (!oldPath || !newPath || oldPath === newPath) return;
  for (const [id, snap] of pendingScroll) {
    const next = remapSnap(snap, oldPath, newPath);
    if (next) pendingScroll.set(id, next);
  }
}

/** 纯函数那一份（看板手里那个"这一趟重绘前捕的快照"也要迁） */
export function remapSnap(snap: ScrollSnap | null, oldPath: string, newPath: string): ScrollSnap | null {
  if (!snap || !oldPath || !newPath || oldPath === newPath) return snap;
  const out: ScrollSnap = {};
  const suffix = `:${oldPath}`;
  for (const [key, pos] of Object.entries(snap)) {
    out[key.endsWith(suffix) ? `${key.slice(0, -suffix.length)}:${newPath}` : key] = pos;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// 会话内的那张表
// ────────────────────────────────────────────────────────────────
/** 待恢复的滚动快照（**一次性**：`recallScroll` 取走即删） */
const pendingScroll = new Map<ModuleId, ScrollSnap>();
/** 模块自己的记忆（光标 / 展开态…）—— 与滚动分开存：它的取用时机是"建 store 那一刻" */
const memos = new Map<string, unknown>();

/**
 * 宿主要拆了（换模块 / 关视图 / 降级成骨架屏）→ 把这一屏的滚动位置记下来。
 *
 * 🔴 **两条守卫，都是"别把上一次记的冲掉"**：
 *  ① 捕获结果是**空的**（这一屏一个可滚容器都没有 —— 骨架屏、降级态）→ **什么都不做**。
 *     照写不误的话，一次"索引重扫途中闪一下骨架"就会把用户真实的位置冲成一片零。
 *  ② **合并**而不是替换：`.kbw-modhost` 那个容器**每一屏都在**（它是外壳自己的），
 *     而它在这一屏可能是 0（内容撑不满）。整份替换的话，`{modhost: 0}` 会把
 *     `{modhost: 0, board: 120}` 里那个真正要记的 120 挤掉。
 *     ⚠️ 合并之后旧键可能永远留着（那个容器这一屏没长出来）—— 无害：
 *     `applyScroll` 只写"DOM 里真有的那些"，找不到就跳过。
 */
export function rememberScroll(id: ModuleId, root: HTMLElement): void {
  const snap = captureScroll(root);
  if (Object.keys(snap).length === 0) return;
  pendingScroll.set(id, { ...(pendingScroll.get(id) ?? {}), ...snap });
}

/**
 * 画完了 → 取走并写回。返回写了几个（0 = 没有待恢复的 / 一个都没认出来）。
 *
 * **取走即删**，所以同一次重绘里再调一次是空操作 —— "只恢复第一次"这条不变量
 * 由这个语义保证，调用方不必自己记标志位。
 */
export function recallScroll(id: ModuleId, root: HTMLElement): number {
  const snap = pendingScroll.get(id);
  if (!snap) return 0;
  pendingScroll.delete(id);
  return applyScroll(root, snap);
}

/** 有没有待恢复的滚动快照（外壳据此决定"要不要替这个模块兜一次"） */
export function hasPendingScroll(id: ModuleId): boolean {
  return pendingScroll.has(id);
}

/**
 * **认领**（不写回）：把快照取走自己拿着 —— 给**异步绘制**的模块用（看板）。
 *
 * 🔴 为什么需要它：看板的绘制是**两段式**的（先画占位、读完正文再画实），写回必须挂在
 * **画实那一刻**（写早了是往一个还没有卡片的容器上写，值会被钳成 0）。而外壳手里那句
 * "同步模块兜底"的 `recallScroll` 会**在 render 返回时就动手** —— 那时看板才画了个占位。
 * 于是规则是：**异步画的模块在 `mount()` 里先把快照认领走**（外壳那一问就落空了），
 * 等自己画实了再 `applyScroll`。
 */
export function claimScroll(id: ModuleId): ScrollSnap | null {
  const snap = pendingScroll.get(id);
  if (!snap) return null;
  pendingScroll.delete(id);
  return snap;
}

/** 模块自己的记忆（看板的光标 / 卡片展开态）。**不消费** —— 它是"上次的样子"，读多少次都一样 */
export function saveMemo<T>(id: string, blob: T): void {
  memos.set(id, blob);
}

export function loadMemo<T>(id: string): T | null {
  const v = memos.get(id);
  return v == null ? null : (v as T);
}

/**
 * 全清（**插件卸载时调**）。
 *
 * ⚠️ 为什么必须清：模块级 Map 挂在**模块作用域**上，插件重载时模块不会重新求值
 *（esbuild 打成的 bundle 被平台缓存），于是"上一次会话的位置"会漏到下一次 ——
 * 表现为"刚重载完，工作台自己滚到了半中间"。与通知栈那些"挂在 body 上的孤儿 DOM"
 * 是同一类账（`main.ts` 的 `onunload` 里一起清）。
 */
export function clearViewMemory(): void {
  pendingScroll.clear();
  memos.clear();
}
