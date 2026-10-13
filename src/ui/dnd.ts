/**
 * ui/dnd.ts —— 指针拖拽基元（方案设计.md §7.3 预留的那一个）
 *
 * 为什么不用 HTML5 的 drag & drop：它在触屏上基本不可用，而这一版**必须**考虑触屏
 * （方案设计 §5.8）。所以自己走 pointer 事件。
 *
 * 三条来自真机实测的规矩（`obsidian-plugin-dev` + P-1 S4）：
 *  ① **触屏不能用位移阈值启动拖动**：触屏第一个 `pointermove` 就带 4.5–20px 位移，
 *     4px 阈值形同虚设 → 触屏走**长按 400ms + 10px 容差**（容差内视为"没动"）。
 *     长按期间一旦超过容差 = 用户在滚动 → **立刻放弃**这次拖动。
 *  ② **`pointercancel` 在触屏上很常见**（滚动接管手势时必然发生）→ 必须当成
 *     "干净中止"，否则卡片/行会卡在拖动状态里。
 *  ③ **不用 `setPointerCapture`**：拖动期间要在 document 上收指针，capture 会把
 *     target 钉在起点上（探针实测过）。命中解析：先看 `evt.target.closest('[data-drop]')`，
 *     再退回 `document.elementFromPoint`。
 *
 * 触屏判定走 `pointerType === 'touch'` 或 `body.is-mobile`（平台的触屏口径），
 * **不看视口宽度、也不看 UA**（S4 实测：平板 UA 是 X11、视口 1238px，但全是 touch）。
 */
import { div } from './primitives';
import { Disposer, on } from '../core/util';

/** 鼠标：超过这个位移就算拖动（决策 9） */
export const MOUSE_THRESHOLD = 4;
/** 触屏：长按时长（S4 定稿；系统长按菜单约 500ms，400 跑在它前面） */
export const LONG_PRESS_MS = 400;
/** 触屏：长按期间的位移容差 */
export const TOUCH_TOLERANCE = 10;

/**
 * **刚刚拖过一次吗**（a.5-1）。
 *
 * 为什么需要它：`pointerup` 上的 `preventDefault()` **拦不住随后的 `click`** ——
 * 用户"拖出去又拖回原处松手"，指针落回原卡片，浏览器照样补一发 click，
 * 于是看板**弹出了悬浮小窗**（"有概率直接触发单击效果"就是这么来的）。
 * 目前接的是**看板卡片**与**「全部笔记」的行**两处（树节点没有这个问题：它不靠 click 选中）。
 */
let dragEndedAt = 0;
/**
 * ⚠️ 窗口**只要够罩住"松手那一发"就行**（独立审查：浏览器补的 click 与 pointerup 同一任务，差几 ms）——
 * 400ms 会让"拖完马上点一下"被静默吞掉（本项目最烦的症状就是"点一下没反应"），
 * 也会跨用例漏到下一个用例（`dragEndedAt` 是全局态）。
 * 所以窗口收到 150ms，并**定时归零**，绝不让它活到用户的下一次点击。
 */
export function wasDraggingRecently(withinMs = 150): boolean {
  return dragEndedAt !== 0 && Date.now() - dragEndedAt < withinMs;
}

/**
 * **自己实现的拖动**（没走 `startPointerDrag` 基元的那种，比如卡片里那根分隔条）
 * 在松手时要手动记这一笔 —— 否则浏览器补的那一发 `click` 会被当成普通单击
 * （用户 2026-09-25 实测："拖动调整属性/内容占比之后，会识别成普通的左键单击，打开小窗"）。
 * 口径与基元内部那笔**完全一致**（同一个 `dragEndedAt`、同一个 150ms 窗口）。
 */
export function markDragEnded(): void {
  dragEndedAt = Date.now();
  window.setTimeout(() => {
    dragEndedAt = 0;
  }, 200);
}

export interface DragCtx<T> {
  data: T;
  /** 起始事件（用来取初始坐标） */
  down: PointerEvent;
  /** 当前坐标（每次 move 更新） */
  x: number;
  y: number;
  touch: boolean;
  /** 拖动是否已经开始（onStart 之后为 true） */
  started: boolean;
}

export interface DragSpec<T> {
  /** 真的进入拖动（越过阈值 / 长按成立） */
  onStart: (ctx: DragCtx<T>) => void;
  /** 指针到了哪个放置目标上（null = 不在任何目标上） */
  onOver?: (target: HTMLElement | null, ctx: DragCtx<T>) => void;
  /** 松手 */
  onDrop?: (target: HTMLElement | null, ctx: DragCtx<T>) => void;
  /** 中止（pointercancel / Esc / 交给滚动） */
  onCancel?: (ctx: DragCtx<T>) => void;
}

/**
 * 这一发事件是不是触屏来的。
 *
 * ⚠️ 参数**收 `Event` 不只收 `PointerEvent`**（P6 段⑥ ⑤ 加的双击那条路需要它）：
 * `dblclick` 是 **`MouseEvent`，天生没有 `pointerType`** —— 它走的是下面那条回落分支
 *（`body.is-mobile`）。类型上不许传的话，调用方只能自己造一个假对象或强转，
 * 那还不如把"没有 pointerType 也合法"这件事写在签名里。
 */
export function isTouchPointer(evt: { pointerType?: string } | Event): boolean {
  const pt = (evt as { pointerType?: string }).pointerType;
  if (pt === 'touch' || pt === 'pen') return true;
  try {
    return document.body.classList.contains('is-mobile');
  } catch {
    return false;
  }
}

/** 放置目标解析（data-drop 属性即契约；树节点/「整个知识库」都带它） */
export function dropTargetAt(evt: PointerEvent | { target?: unknown; clientX: number; clientY: number }): HTMLElement | null {
  const t = evt.target as HTMLElement | null;
  const direct = t?.closest?.('[data-drop]') as HTMLElement | null;
  if (direct) return direct;
  try {
    const el = document.elementFromPoint?.(evt.clientX, evt.clientY) as HTMLElement | null;
    return (el?.closest?.('[data-drop]') as HTMLElement | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * 从一次 `pointerdown` 开始盯着这次手势。
 * 返回一个"取消"函数（调用方在行被重画/卸载时调一下，避免留着监听）。
 */
export function startPointerDrag<T>(
  down: PointerEvent,
  data: T,
  spec: DragSpec<T>,
): () => void {
  const touch = isTouchPointer(down);
  const ctx: DragCtx<T> = {
    data,
    down,
    x: down.clientX,
    y: down.clientY,
    touch,
    started: false,
  };
  const disposer = new Disposer();
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  /** 已经交代过了（onDrop / onCancel 走过一次）——别重复回调 */
  let settled = false;

  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    /**
     * 记一笔"拖动刚结束"（**拖动真的开始过才算**）——见 `wasDraggingRecently`。
     * 放在 cleanup 里是为了把三条出路都覆盖上：松手 / pointercancel / Esc 取消。
     */
    if (ctx.started) {
      dragEndedAt = Date.now();
      window.setTimeout(() => {
        dragEndedAt = 0;
      }, 200);
    }
    if (longPressTimer != null) clearTimeout(longPressTimer);
    longPressTimer = null;
    document.documentElement.classList.remove('kbw-dragging');
    disposer.dispose();
    // 调用方主动中止（换行再按、模块卸载）也要通知 —— 否则拖动的药丸/目标高亮
    // 会留在界面上（"药丸没收掉"就是这么来的）
    if (ctx.started && !settled) {
      settled = true;
      try {
        spec.onCancel?.(ctx);
      } catch (e) {
        console.error('[经纬] 拖动中止回调出错', e);
      }
    }
  };

  const begin = (): void => {
    if (ctx.started || finished) return;
    ctx.started = true;
    document.documentElement.classList.add('kbw-dragging');
    try {
      spec.onStart(ctx);
    } catch (e) {
      console.error('[经纬] 拖动开始回调出错', e);
    }
    // 起手就报一次命中（指针可能原地没动）
    spec.onOver?.(dropTargetAt(mk(down, ctx)), ctx);
  };

  disposer.add(
    on(document, 'pointermove', (e) => {
      const evt = e as PointerEvent;
      if (evt.pointerId !== down.pointerId && down.pointerId !== 0) return;
      ctx.x = evt.clientX;
      ctx.y = evt.clientY;
      if (!ctx.started) {
        const dx = ctx.x - down.clientX;
        const dy = ctx.y - down.clientY;
        const dist = Math.hypot(dx, dy);
        if (touch) {
          // ① 长按期间动了 = 用户在滚动 → 放弃这次拖动（不是"改成拖动"）
          if (dist > TOUCH_TOLERANCE) {
            if (longPressTimer != null) clearTimeout(longPressTimer);
            longPressTimer = null;
            cleanup();
          }
          return;
        }
        if (dist < MOUSE_THRESHOLD) return;
        begin();
      }
      if (ctx.started) {
        evt.preventDefault?.();
        spec.onOver?.(dropTargetAt(evt), ctx);
      }
    }),
  );

  if (touch) {
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      begin();
    }, LONG_PRESS_MS);
    // ② 三层原生长按抑制里最容易被漏掉的一层（CSS 那两层在 styles/mobile.css）
    disposer.add(
      on(document, 'contextmenu', (e) => {
        if (ctx.started) e.preventDefault();
      }),
    );
  }

  disposer.add(
    on(document, 'pointerup', (e) => {
      const evt = e as PointerEvent;
      if (ctx.started) {
        evt.preventDefault?.();
        const target = dropTargetAt(evt);
        settled = true;
        try {
          spec.onDrop?.(target, ctx);
        } catch (err) {
          console.error('[经纬] 放下回调出错', err);
        }
      }
      cleanup();
    }),
  );

  // ② 触屏滚动接管时会发这个 → 干净中止
  disposer.add(
    on(document, 'pointercancel', () => {
      if (ctx.started) {
        settled = true;
        try {
          spec.onCancel?.(ctx);
        } catch (e) {
          console.error('[经纬] 拖动中止回调出错', e);
        }
      }
      cleanup();
    }),
  );

  /**
   * **窗口失焦 = 干净中止**（独立审查 🟡3）：把指针拖出窗口再在外面松手，
   * pointerup 不归我们（甚至没有）—— 拖动会卡在"拖到一半"（浮标留着、工具条停在拖动那一档）。
   * 失焦时指针已经不在我们这儿了，中止是唯一正确解释。
   */
  disposer.add(
    on(window, 'blur', () => {
      if (ctx.started && !settled) {
        settled = true;
        try {
          spec.onCancel?.(ctx);
        } catch (e) {
          console.error('[经纬] 拖动中止回调出错', e);
        }
      }
      cleanup();
    }),
  );

  disposer.add(
    /**
     * **Esc 中止拖动**。
     *
     * 🔴 **必须挂捕获阶段**（d2 独立审查实测出来的）：`installGlobalEscape`
     *（`core/keymap.ts`，管的是"逐层清临时态"）也是 document 上的**捕获**监听，
     * 而且它一旦接住就 `stopPropagation()` —— 这里挂冒泡的话**永远收不到**，
     * 于是"拖到一半按 Esc"**在真实环境里从来没生效过**（离线上只有"Esc 栈为空"时才走到，
     * 所以一直没露出来）。同一节点上的捕获监听不会被 `stopPropagation()` 挡住
     *（那要 `stopImmediatePropagation`），所以挂捕获就能拿到。
     *
     * ⚠️ 代价：这一下 Esc **两个效果都会发生**（那层清临时态 + 中止拖动）。
     * `installGlobalEscape` 注册得早、先跑；这里后跑但照样收得到。这是可接受的——
     * 冒泡时代价是"拖动卡住不中止"，那更糟。
     */
    on(
      document,
      'keydown',
      (e) => {
        if ((e as KeyboardEvent).key === 'Escape' && ctx.started) {
          (e as KeyboardEvent).stopPropagation();
          settled = true;
          try {
            spec.onCancel?.(ctx);
          } catch (err) {
            console.error('[经纬] 拖动中止回调出错', err);
          }
          cleanup();
        }
      },
      { capture: true },
    ),
  );

  return cleanup;
}

/** 造一个假的 PointerEvent 形态（起手时复用同一套命中解析） */
function mk(evt: PointerEvent, ctx: { x: number; y: number }): PointerEvent {
  return { target: evt.target, clientX: ctx.x, clientY: ctx.y } as unknown as PointerEvent;
}

// ────────────────────────────────────────────────────────────────
// 拖动时跟着指针的小药丸（「3 篇」）
// 起点那一帧就摆到触点上 —— S4 实测：浮层起手没归位会闪出上一次的残影
// ────────────────────────────────────────────────────────────────
export interface GhostHandle {
  el: HTMLElement;
  move(x: number, y: number): void;
  dispose(): void;
}

/**
 * **抓取偏移**（P7.23）：起手量**一次**，拖动期间锁死。
 *
 * `dx/dy` = 起手那一刻"指针 − 浮标左上角"，`left/top` = 浮标的布局原点
 * （创建时写在 `left/top` 上的那两个数）。之后每帧只用这两个数做算术 ——
 * 🔴 **绝不再量任何 rect**：从"当前 rect"反算增量是**自反馈**
 *（读到自己上一帧写过的 transform），表现为浮标在位置上**来回弹**、追不上手。
 */
export interface GhostGrab {
  dx: number;
  dy: number;
  left: number;
  top: number;
}

/**
 * 浮标位移的**纯函数**（jsdom 量不到布局，几何规则只能这样钉单测）：
 * 把指针坐标换算成相对布局原点的 `translate`，让"指针 − 抓取偏移"那一角落回浮标左上角。
 */
export function ghostTranslate(g: GhostGrab, x: number, y: number): { tx: number; ty: number } {
  return { tx: Math.round(x - g.dx - g.left), ty: Math.round(y - g.dy - g.top) };
}

/**
 * **跟手器**（P7.23）：把"摆到指针处"这件事收成一份 —— 网格浮标（单篇克隆）与
 * 药丸（多篇 / 看板卡 / 详细档行）共用同一份实现（两处各写一份必漂，本项目老账）。
 *
 * 两条规矩：
 *  ① **先落位、后合帧**：第一发 `move()` 同步写（起手那一帧就在触点上，不留残影）；
 *     之后指针事件只**存最新坐标**，每帧 rAF 最多写一次 transform
 *     （pointermove 比帧还密时，中间那些丢了就丢了 —— 视觉上取最终位即可）；
 *  ② **只写 transform**（`translate3d`，可选拼一段 `scale`）：写 `left/top` 是布局写，
 *     会让链上任何一次布局读触发强制回流 —— 掉帧的表现就是"浮标追不上手"。
 *     ⚠️ `scale` 必须**并进同一串** transform：CSS 里那份会被 inline transform 整个覆盖，
 *     分两次写的话起手会跳一下、缩放丢失（用户报的"图标不跟手"里就有这一截）。
 */
export function followPointer(
  el: HTMLElement,
  grab: GhostGrab,
  opts: { scale?: number } = {},
): { move(x: number, y: number): void; stop(): void } {
  let placed = false;
  let pending: { x: number; y: number } | null = null;
  let raf = 0;
  const write = (x: number, y: number): void => {
    const { tx, ty } = ghostTranslate(grab, x, y);
    const scale = opts.scale ? ` scale(${opts.scale})` : '';
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0)${scale}`;
  };
  const frame = (): void => {
    raf = 0;
    if (!pending) return;
    const p = pending;
    pending = null;
    write(p.x, p.y);
  };
  return {
    move(x, y) {
      if (!placed) {
        placed = true;
        write(x, y); // 起手同步落位（不等 rAF —— S4 的"残影"教训）
        return;
      }
      pending = { x, y };
      if (raf === 0) raf = requestAnimationFrame(frame);
    },
    stop() {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
    },
  };
}

export function dragGhost(text: string): GhostHandle {
  const el = div({ cls: 'kbw-dragghost', text });
  el.style.left = '0px';
  el.style.top = '0px';
  document.body.appendChild(el);
  /**
   * 药丸的抓取偏移是**常量**：原来的落点就是"指针 + 12 / + 14"，布局原点在 (0,0) ——
   * 折进同一套 `ghostTranslate` 口径（`dx/dy` 取负 = 加回来）。
   */
  const follow = followPointer(el, { dx: -12, dy: -14, left: 0, top: 0 });
  return {
    el,
    move: (x, y) => follow.move(x, y),
    dispose: () => {
      follow.stop();
      el.remove();
    },
  };
}
