/**
 * blocks/quick —— 快捷动作（§2.2）
 *
 * **P7.2a 从 `modules/home/index.ts` 原样搬出**。两处与拆分有关的口径：
 * ① 它原来是 `.kbw-hero` 的最后一个孩子（跟着 hero 的 max-width 640 居中），
 *    拆出来后由 CSS 保持同样的居中约束（`.kbw-quickrow` 自己那套没动）；
 * ② **分隔线（`.kbw-home-div`）归这一块**（拆分时定的口径）：它是"上半部（门面）
 *    的收尾线"——hero 或 quick 谁被藏，线跟着 quick 走；排序变化时线也随块移动。
 *
 * **P7.2b（1.6b）：教程"关键按钮"那一处**（Q4 拍板：只做首页这四个）。
 * ⚠️ **P7.7 收（2026-10-05 用户真机反馈）**：原"每个按钮一枚小「?」徽标、点开出解释"
 * 太吵（四枚圈圈）；**徽标退役** → 改为**鼠标悬停停留 600ms 自动出同一扇小浮层**，
 * 移开（含离开浮层本身）淡出关闭。两条已知代价**如实记档**：
 *   · 触屏没有 hover（`pointerType !== 'mouse'` 直接不接）→ 触屏这条路暂时够不着提示
 *     （12.2 手机端未立项；要补就等立项时按长按档设计）；
 *   · 键盘也不再可达（原徽标可 Tab + Enter）——按钮本身的功能不受影响。
 * 浮层仍是**既有小浮层** `ui/panel.ts` 的 `openFloating`（不新造浮层）；同一时刻只留一扇。
 */
import type { HomeBlock } from './index';
import { btn, div, icon, span } from '../../../ui/primitives';
import { openFloating, type PanelHandle } from '../../../ui/panel';
import { openInboxChoices } from '../tidy';
import { openNewNoteDialog } from '../../../ui/new-note';
import { openSnapshotPanel } from '../../../ui/snapshot-panel';

/** 悬停停留多久出提示（毫秒）。太短=划过就弹很吵；太长=等不到。600ms 贴常见 tooltip 的体感。 */
const TIP_DWELL_MS = 600;
/** 移开后的宽限：留给"把手移到浮层上继续读"，超时没回来就关。 */
const TIP_LINGER_MS = 250;

/**
 * 当前开着的那扇提示浮层（**模块级**：任何时刻只留一扇）。
 * `for` = 从哪个按钮开出来的。浮层自己关掉（点外面 / Esc）时在 `closed` 回调里清空
 * —— 别让这里攒着死引用。
 */
let tipOpen: { handle: PanelHandle; for: HTMLElement } | null = null;
/** 单枚"延迟关闭"计时器（按钮离开 / 浮层离开共用同一枚 —— 反正同时只有一扇浮层） */
let closeTimer: number | null = null;

function cancelClose(): void {
  if (closeTimer != null) window.clearTimeout(closeTimer);
  closeTimer = null;
}

function closeSoon(): void {
  cancelClose();
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
    tipOpen?.handle.close('leave');
  }, TIP_LINGER_MS);
}

function showButtonTip(anchor: HTMLElement, title: string, text: string): void {
  tipOpen?.handle.close('switch');
  const h = openFloating({
    anchor,
    title,
    dragHandle: false, // 一句解释，不需要拖
    /**
     * 🔴 不豁免 `anchor`（与旧徽标版相反）：旧豁免是给"再点徽标 = toggle 收起"那套用的；
     * 现在悬停开、按钮本体点了就是执行动作 —— 点下去（mousedown）先把提示收掉是对的。
     */
  });
  h.body.appendChild(div({ cls: 'kbw-qbtn-tip-body', text }));
  /**
   * 把手移到浮层上继续读 → 留在那儿（取消延迟关）；离开浮层再用同一个宽限关。
   * 监听挂在 `h.root` 上：浮层关了它随 DOM 一起没了，不用手动摘。
   */
  h.root.addEventListener('pointerenter', (evt) => {
    const pt = (evt as PointerEvent).pointerType;
    if (pt && pt !== 'mouse') return;
    cancelClose();
  });
  h.root.addEventListener('pointerleave', (evt) => {
    const pt = (evt as PointerEvent).pointerType;
    if (pt && pt !== 'mouse') return;
    closeSoon();
  });
  tipOpen = { handle: h, for: anchor };
  void h.closed.then(() => {
    if (tipOpen?.handle === h) tipOpen = null;
  });
}

/** 给一个按钮装上"悬停停留出提示"（只认鼠标；触屏/笔直接不接 —— 见文件头） */
function wireHoverTip(b: HTMLElement, title: string, text: string): void {
  let dwell: number | null = null;
  const isMouse = (evt: Event): boolean => {
    const pt = (evt as PointerEvent).pointerType;
    // ⚠️ jsdom 的 PointerEvent 拿不到 pointerType（空串）→ 空串按鼠标放行（真机才分触屏）
    return !pt || pt === 'mouse';
  };
  b.addEventListener('pointerenter', (evt) => {
    if (!isMouse(evt)) return;
    cancelClose();
    if (dwell != null || tipOpen?.for === b) return;
    dwell = window.setTimeout(() => {
      dwell = null;
      showButtonTip(b, title, text);
    }, TIP_DWELL_MS);
  });
  b.addEventListener('pointerleave', (evt) => {
    if (!isMouse(evt)) return;
    if (dwell != null) window.clearTimeout(dwell);
    dwell = null;
    closeSoon();
  });
  /**
   * 🔴 **点下去就把计时取消**（P7.9 · ③ 修复）：原先 dwell 不理会点击 ——
   * 进按钮 300ms 内点开「整理收件箱」菜单，到 600ms 提示浮层**照样冒出**、
   * 挤在菜单后面（用户截图复现）。此后**离开前不再重新武装**：
   * 重新计时只认新的 `pointerenter`（离开再回来 = 新的一次悬停）。
   * ⚠️ 只认鼠标 —— 触屏的 `pointerdown` 就是"点按钮"本身，这条路不接触屏（同文件头）。
   */
  b.addEventListener('pointerdown', (evt) => {
    if (!isMouse(evt)) return;
    if (dwell != null) window.clearTimeout(dwell);
    dwell = null;
  });
}

export const quickBlock: HomeBlock = {
  id: 'quick',
  title: '快捷动作',
  hint: '新建笔记 / 整理收件箱 / 还原快照 / 问 AI 四个按钮（悬停停留一会儿，出这个按钮干什么的说明）',
  defaultOn: true,
  paint(ctx, host) {
    const row = div({ cls: 'kbw-quickrow' });
    /**
     * ⚠️ `run` 收下**按钮自己**：菜单要从它的下沿展开（`openInboxChoices` 要用）。
     * P7.2b 起每个按钮包进 `.kbw-qwrap`（position:relative），「?」徽标才有角落可站。
     */
    const mk = (
      iconName: string,
      label: string,
      tip: string,
      run: (b: HTMLElement) => void,
      cls?: string,
    ): HTMLElement => {
      const wrap = div({ cls: 'kbw-qwrap' });
      const b = btn({ cls: ['kbw-qbtn', cls ?? null], on: { click: () => run(b) } });
      b.appendChild(icon(iconName, 15));
      b.appendChild(span({ text: label }));
      wireHoverTip(b, label, tip);
      wrap.appendChild(b);
      return wrap;
    };
    row.appendChild(
      mk('plus', '新建笔记', '取名 → 选位置 → 选模板（可都不选）', () =>
        openNewNoteDialog(ctx),
      ),
    );
    // §2.2：二级选择（A2）—— 「自己整理」= 原来那条路，「一键自动整理」= 新加的
    row.appendChild(
      mk(
        'list-checks',
        '整理收件箱',
        '看看收件箱里积了多少篇；可以自己整理，也可以让它出一份「一键自动整理」的计划 —— 动库前先给你过目',
        (b) => openInboxChoices(ctx, b),
      ),
    );
    row.appendChild(
      mk('history', '还原快照', '回到某个时间点之前的库；做了也能反悔 —— 撤销条与快照都在', () =>
        openSnapshotPanel(ctx),
      ),
    );
    row.appendChild(
      mk('sparkles', '问 AI', '打开 AI 助手面板；还没配模型的话，先去 设置 → AI 助手 里填', () => ctx.openAi(), 'is-ai'),
    );
    host.appendChild(row);
    // 上半部的收尾线（归属见文件头 ②）
    host.appendChild(div({ cls: 'kbw-home-div' }));
    return true;
  },
};
