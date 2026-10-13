/**
 * modules/board/window-seat.ts —— **停靠窗格的"座位"通知**（P4.5 e 期）
 *
 * 起因是一个真机上才看得出来的坑：窗格只有一个，而它有两个占用者（就地编辑面板 /
 * 预览窗格 Peek），两者**互斥**。互斥的一半（"我要用就把别人请走"）在
 * `modules/board/index.ts` 那两处调用里做掉了；**另一半是这一条**：
 * 占着窗格的那个**走了之后**，"配置里说该占着它"的那个要能收回去。
 *
 * 🔴 少了它会怎么样（探针实测的形状）：Peek 开着 → 点一张卡片开编辑面板（Peek 让位、
 * 但配置里 `peekEnabled` 还是 true）→ 关掉编辑面板 → **边上空着一条，界面上什么都没有，
 * 而菜单里那一项还是勾着的**。用户只能把那个开关点两下才回得来 ——
 * 与 d2 那条"面板好端端停在那儿，你从菜单换了边，它纹丝不动"是同一类病：
 * **配置说开着，界面上没有**。
 *
 * ── 为什么需要这个文件（而不是让两方互相调）──────────────────────
 * `editor.ts` 与 `peek.ts` **不许互相 import**（会成环，红线有一条专门盯它）。
 * 所以把"窗格让出来了"这件事放进一个**两边都只单向 import** 的小模块里：
 * 编辑面板在收尾时喊一声，Peek 自己听着（它认一次依赖用到底，见 `CwPanel.dockPort` 那条）。
 *
 * ⚠️ 这里**只有通知，没有状态**：谁该占着窗格这件事的**真源是库内配置**
 *（`view.peekEnabled` / `view.dock`），不是这张表 —— 表里存一份就会与配置漂。
 */
type FreedListener = () => void;

const listeners = new Set<FreedListener>();

/** 订阅"窗格被让出来了"。返回退订函数。 */
export function onWindowFreed(cb: FreedListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 喊一声"我让出窗格了"（**在真的调过 `request(null)` 之后**再喊 ——
 * 先喊后让的话，听者当场把窗格抢回去，紧接着那次 `request(null)` 又把它收掉，
 * 屏幕上就是"闪一下没了"）。
 *
 * ⚠️ 逐个 try：一个听者出错不许连累别的（也**不抛回给调用方** ——
 * 它多半正在关窗流程里，那里再抛一次只会让收尾中断）。
 */
export function notifyWindowFreed(): void {
  for (const cb of Array.from(listeners)) {
    try {
      cb();
    } catch (e) {
      console.error('[经纬] 窗格让位通知出错', e);
    }
  }
}
