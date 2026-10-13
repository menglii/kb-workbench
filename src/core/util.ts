/**
 * core/util.ts —— 时间 / 格式化 / 事件 / 平台判定
 *
 * 与 `core/paths.ts` 一样：放 core 里，好让 services 不必反向依赖 ui。
 */

// ── 时间 ───────────────────────────────────────────────────────
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `YYYY-MM-DD`（与 `创建日期` 同格式） */
export function todayISO(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYYMMDD-HHmmss`（快照目录名 / 日志文件名） */
export function stamp(d = new Date(), withSeconds = true): string {
  const head = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const tail = withSeconds
    ? `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    : `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${head}-${tail}`;
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const diff = now - ts;
  if (diff < 45_000) return '刚刚';
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${Math.max(1, min)} 分钟前`;
  const hour = Math.round(diff / 3_600_000);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.round(diff / 86_400_000);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地当天 0 点（`formatDueTime` 用；模块侧那一份在 `services/review.ts`，别互相 import） */
function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * **未来**时间的说法（「今天 / 明天 / N 天后」）—— 与 `formatRelativeTime` 配对的那一半。
 *
 * 🔴 为什么要单独一个（P8 期 3 独立审抓的真 bug）：`formatRelativeTime` 是**过去向**的
 *（`diff = now - ts`，负数恒 `< 45_000`）—— 喂未来时间戳**永远**返回「刚刚」。
 * 而"下一次到期"只可能在未来 → 那句话当时 100% 显示成「刚刚」，看着像"现在就该复习"。
 *
 * 粒度与 `dueCards` 对齐：**按天比**（两边都归到本地 0 点再相减），不是拿时间戳相减 ——
 * 否则"今天 08:00 到期、现在 07:00"的卡会被判成明天。
 */
export function formatDueTime(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const days = Math.round((dayStart(ts) - dayStart(now)) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '明天';
  if (days < 30) return `${days} 天后`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── 格式化 ─────────────────────────────────────────────────────
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

// ── 事件与定时 ─────────────────────────────────────────────────
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  /**
   * 立刻执行**挂起的那一次**（没挂起就什么都不做）；传参则用传进来的参数。
   * 「没挂起就不做」是刻意的：`flush()` 的调用点都是"收尾时别丢最后一次"
   * （模块卸载前存配置、清外部改动标记），不该凭空多跑一次。
   */
  flush(): void;
  flush(...args: A): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const wrapped = ((...args: A) => {
    lastArgs = args;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn(...a);
    }, ms);
  }) as Debounced<A>;
  wrapped.cancel = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const flush = (...args: A | []): void => {
    wrapped.cancel();
    const a = args.length > 0 ? (args as A) : lastArgs;
    lastArgs = null;
    if (a) fn(...a);
  };
  wrapped.flush = flush;
  return wrapped;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function on(
  target: HTMLElement | Document | Window,
  type: string,
  handler: (ev: Event) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** 收集一批取消函数，统一释放（视图/面板销毁时用） */
export class Disposer {
  private fns: (() => void)[] = [];
  private disposed = false;

  add(fn: () => void): void {
    if (this.disposed) {
      try {
        fn();
      } catch (e) {
        console.error('[经纬] 释放资源时出错', e);
      }
      return;
    }
    this.fns.push(fn);
  }

  addAll(fns: (() => void)[]): void {
    for (const fn of fns) this.add(fn);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    const list = this.fns.splice(0);
    for (const fn of list) {
      try {
        fn();
      } catch (e) {
        console.error('[经纬] 释放资源时出错', e);
      }
    }
  }
}

// ── 平台判定 ───────────────────────────────────────────────────
/**
 * 🔴 **单一口径：`body.is-mobile`**（方案设计.md §5.8 ②）
 *
 * 不看 UA、不看视口宽度。依据是 P-1 S4 的实测：
 *   平板 UA = `X11; Linux x86_64`（桌面 Linux）、视口 1238×731，
 *   但 `touchPoints: 5`、`pointerType` 全是 `touch`
 *   —— **UA 和宽度都与"是否触控"脱钩**。
 * 手机横屏 844–932px 比很多平板断点还宽，写在 max-width 里的规则永不命中。
 */
export function isTouch(): boolean {
  return typeof document !== 'undefined' && document.body?.classList.contains('is-mobile') === true;
}

let macCache: boolean | null = null;

export function isMac(): boolean {
  if (macCache == null) {
    const p = (navigator as Navigator & { platform?: string }).platform ?? '';
    const ua = navigator.userAgent ?? '';
    macCache = /mac/i.test(p) || /Mac OS X/i.test(ua);
  }
  return macCache;
}

/** 跨平台修饰键：Mac 用 Cmd，其余用 Ctrl */
export function hasMod(ev: MouseEvent | KeyboardEvent): boolean {
  return isMac() ? ev.metaKey : ev.ctrlKey;
}

export function modLabel(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
