/**
 * 多选（P4.5 c 期 · §3.5）：选择集的**纯运算** —— **看板与「全部笔记」两屏共用同一份**。
 *
 * 单独一个文件，是为了让"选择集怎么算"能**离线验**——§3.5 的判据第一层就是纯函数：
 * 范围选、切换、框选这几件事都只吃数组和矩形，不碰 DOM、不碰 store、不看配置。
 * `Ctrl/Cmd+单击` 切一张、`Shift+单击` 从锚点取一段、`Ctrl+Shift` 取并集 —— 两屏一致。
 *（c 期独立审查 🟢12：c 期开工时看板这边是新写的、"全部笔记"那边还留着一份内联实现，
 *  两屏在"Shift 点到一个不在列表里的目标"这种边界上**已经不同**了 → 已把 notes 也接过来，
 *  并在 `tests/specs/redline.ts` 钉了一条"两屏都得调这两个函数"。）
 *
 * ⚠️ 唯一**故意留白**的地方：看板的普通单击是"开悬浮小窗"（天天在用的主路径），
 * 所以「替换整个选择」这件事由调用方在开窗那条路上做（见 `board/index.ts` 的 `onCardClick`），
 * 这里不提供"单击替换"的算子 —— 免得将来有人在别处顺手用了它、把开窗那条路的选择语义搞乱。
 */

/** 与 `getBoundingClientRect()` 同形（`left/top/width/height`），好直接喂进去 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 两个点 → 归一化矩形（框选时第二点可能在起点的左上方，宽高会是负的） */
export function normRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** `Ctrl/Cmd+单击`：有就减、没有就加（"切一下"） */
export function toggleSelected(selected: readonly string[], path: string): string[] {
  return selected.includes(path) ? selected.filter((p) => p !== path) : [...selected, path];
}

/**
 * `Shift+单击`：从**锚点**到目标，按**当前显示顺序**取一整段。
 *
 * - `merge`（= `Ctrl/Cmd+Shift+单击`）→ 与现有选择取并集；否则整段**替换**选择。
 * - 锚点还没设（`null`）→ 当作"锚点就是目标"，即只选这一张。
 * - 有一头不在 `order` 里（被筛掉 / 拖到别的板块去了 / 板块被收起）→ 退化成"只选目标"，
 *   **不报错也不清空**：用户看得见的那些照样选中（清空会让"选了一半全没了"更费解）。
 */
export function rangeSelected(
  order: readonly string[],
  selected: readonly string[],
  anchor: string | null,
  path: string,
  merge: boolean,
): string[] {
  const b = order.indexOf(path);
  if (b < 0) return [...selected];
  const a = anchor == null ? -1 : order.indexOf(anchor);
  if (a < 0) return [path];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const range = order.slice(lo, hi + 1);
  return merge ? Array.from(new Set([...selected, ...range])) : range;
}

/**
 * 框选：**与选框相交**的卡片就算圈中（不要求整个卡片都在框里 —— 与桌面/资源管理器的口径一致）。
 *
 * ⚠️ 只比"有交集"而不是"面积占比"：卡片比选框高得多的时候，占比口径会让
 * "明明框住了它却选不上"，那种手感很糟。零面积（点一下没拖）**不算命中**：
 * 那样会让"在空白处点一下"顺手清空选择，而用户的本意多半是"取消框选"。
 */
export function marqueeHit(
  items: readonly { path: string; rect: Rect }[],
  box: Rect,
): string[] {
  if (box.width <= 0 && box.height <= 0) return [];
  const out: string[] = [];
  for (const it of items) {
    /**
     * 零尺寸矩形 = **这一刻看不见的卡片**（所在板块收起了 / `display:none` → rect 全是 0）。
     * 不跳过的话它们叠在视口原点 (0,0) 上，从左上角拉起来的框会把它们一起圈进来 ——
     * 而用户屏幕上根本没有它们（"我没框它，怎么也被选中了"）。
     */
    if (it.rect.width <= 0 && it.rect.height <= 0) continue;
    const hit =
      it.rect.left < box.left + box.width &&
      it.rect.left + it.rect.width > box.left &&
      it.rect.top < box.top + box.height &&
      it.rect.top + it.rect.height > box.top;
    if (hit) out.push(it.path);
  }
  return out;
}

/**
 * 拖动时"实际要搬哪些"：**拖的那张如果本来就在选择里，就搬整组**；否则只搬它自己。
 * （Windows / 资源管理器的口径；也是"想拖一组"最自然的动作 —— 先选好，再按住其中一张拖。）
 *
 * 返回的数组顺序 = 选择集里的顺序（`order` 给定），**不是**按点击先后 ——
 * 顺序表（`manualOrder`）落盘时按显示顺序才稳定，按点击先后会随用户的点击次序漂。
 */
export function dragSet(
  order: readonly string[],
  selected: readonly string[],
  path: string,
): string[] {
  if (!selected.includes(path)) return [path];
  const inOrder = order.filter((p) => selected.includes(p));
  // 选择集里全是"看不见的路径"（被筛掉/收起了）时兜底成单张，别拖了个空
  return inOrder.length > 0 ? inOrder : [path];
}
