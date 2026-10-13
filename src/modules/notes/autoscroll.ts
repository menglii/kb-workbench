/**
 * modules/notes/autoscroll.ts —— 拖到滚动容器边缘时的自动滚动（P7.1c ⑥，两档共用）
 *
 * 两件事拆开，因为它们的可测性完全不同：
 *   · **纯映射**（`edgeScrollVelocity`）：指针位置 → 速度（px/s）。离线可测、无 DOM。
 *   · **滚动本身**（`startEdgeScroll`）：rAF 循环按掉帧时间把速度积进 `scrollTop`。
 *     只有真机验得了（jsdom 没有布局，`getBoundingClientRect` 全零）。
 *
 * 若干刻意的选择：
 *   · **只有纵向**：两个容器（表格 `listHost` / 网格 `.kbw-grid`）都是纵向滚动。
 *     横向滚动要在 `.kbw-tablewrap` 那一层做，是另一件事（先不做，别假装做了）。
 *   · **速度 ∝ 深入程度**：刚进边缘带最慢、贴死边线最快（线性）—— 移出去立刻回 0，
 *     "离开就停"是同一个映射函数的自然结果，不是另一条退出规则。
 *   · **rAF 只在速度非 0 时跑**（静止时不空转）；掉帧间隔封顶 50ms——
 *     切标签回来/系统卡顿一下不该让滚动"瞬移"一大截。
 *   · 不碰 `scroll-behavior`：那个走 CSS（`prefers-reduced-motion` 那一档由它管）。
 */

/** 边缘带宽度（px）：进入容器上下各 48px 之内开始滚 */
export const EDGE_BAND = 48;
/** 速度上限（px/s）：贴死边线时的最快速度 */
export const EDGE_MAX_SPEED = 600;

/**
 * **纯映射**：指针的纵向坐标 → 滚动速度（px/s，负 = 向上）。
 *
 * @param pos   指针的视口坐标（y）
 * @param start 容器上边缘（`rect.top`）
 * @param end   容器下边缘（`rect.bottom`）
 * 返回值 0 = 不滚（在中间区域、或容器矮到两条边缘带重叠时——那时"边"无意义）。
 */
export function edgeScrollVelocity(
  pos: number,
  start: number,
  end: number,
  band = EDGE_BAND,
  max = EDGE_MAX_SPEED,
): number {
  // 容器太矮（两条边缘带重叠）：不滚 —— 否则"中间"也永远在带里，一动就飞
  if (!(end - start > band * 2) || !(band > 0) || !(max > 0)) return 0;
  if (pos < start + band) return -max * Math.min(1, (start + band - pos) / band);
  if (pos > end - band) return max * Math.min(1, (pos - (end - band)) / band);
  return 0;
}

export interface EdgeScroller {
  /** 每次指针移动调一次（拖动的 onOver）——速度 0 时循环自己歇着 */
  update(x: number, y: number): void;
  /** 松手 / 取消 / 收尾：停循环（可重复调） */
  dispose(): void;
}

export function startEdgeScroll(
  container: HTMLElement,
  opts: { band?: number; max?: number } = {},
): EdgeScroller {
  const band = opts.band ?? EDGE_BAND;
  const max = opts.max ?? EDGE_MAX_SPEED;
  let vy = 0;
  let raf = 0;
  let last = 0;
  let dead = false;

  const tick = (t: number): void => {
    raf = 0;
    if (dead || vy === 0) return;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    if (dt > 0) container.scrollTop = container.scrollTop + vy * dt;
    raf = requestAnimationFrame(tick);
  };

  return {
    update: (_x, y) => {
      if (dead) return;
      const r = container.getBoundingClientRect();
      vy = edgeScrollVelocity(y, r.top, r.bottom, band, max);
      if (vy !== 0 && raf === 0) {
        last = 0; // 重新起跑：第一帧 dt=0（不拿停表前的时间差去积分）
        raf = requestAnimationFrame(tick);
      }
    },
    dispose: () => {
      dead = true;
      vy = 0;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
