/**
 * core/store.ts —— 状态 + 订阅，以及自研的「区域重绘」原语
 *
 * 方案设计.md §7.2：每个模块声明 `render(el, state)`，state 变化只重绘该区域。
 * 刻意简单、可预测：没有虚拟 DOM、没有 diff —— 一个区域要么原样留着，要么整体重画。
 * 代价是表格/看板网格的样板代码多一些，这是已知并接受的成本。
 */

export type Unsubscribe = () => void;
export type Listener<T> = (state: T, prev: T) => void;

export class Store<T extends object> {
  private state: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): Readonly<T> {
    return this.state;
  }

  /** 浅合并；**没有实际变化就不通知**（避免无谓重绘） */
  set(patch: Partial<T> | ((s: Readonly<T>) => Partial<T> | null)): boolean {
    const p = typeof patch === 'function' ? (patch as (s: Readonly<T>) => Partial<T> | null)(this.state) : patch;
    if (!p) return false;
    let changed = false;
    for (const k of Object.keys(p) as (keyof T)[]) {
      if (!Object.is(this.state[k], p[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    const prev = this.state;
    this.state = { ...this.state, ...p };
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(this.state, prev);
      } catch (e) {
        console.error('[经纬] 订阅者出错', e);
      }
    }
    return true;
  }

  subscribe(fn: Listener<T>): Unsubscribe {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 只关心某几个键的订阅（键的浅比较） */
  select<K extends keyof T>(keys: K[], fn: (s: T) => void): Unsubscribe {
    return this.subscribe((s, prev) => {
      for (const k of keys) {
        if (!Object.is(s[k], prev[k])) {
          fn(s);
          return;
        }
      }
    });
  }
}

export type Render<S> = (el: HTMLElement, state: S) => void;

export interface RegionOptions<S> {
  /**
   * 重绘判据：同一 key 再来一次就跳过（不传则每次 set 都重画）。
   * 例：`s => s.index.revision` —— 索引没动就不重画表格。
   */
  key?: (state: S) => unknown;
  /** 重画前是否清空宿主（默认清空） */
  reuse?: boolean;
}

/**
 * 区域：绑一个宿主元素，按 state 重绘。
 * **不接管生命周期以外的东西** —— dispose 只清空元素，不碰宿主本身。
 */
export class Region<S> {
  private host: HTMLElement;
  private render: Render<S>;
  private opts: RegionOptions<S>;
  private lastKey: unknown = Symbol('kbw-region-init');
  private disposed = false;

  constructor(host: HTMLElement, render: Render<S>, opts: RegionOptions<S> = {}) {
    this.host = host;
    this.render = render;
    this.opts = opts;
  }

  paint(state: S, force = false): void {
    if (this.disposed) return;
    if (!force && this.opts.key) {
      const k = this.opts.key(state);
      if (Object.is(k, this.lastKey)) return;
      this.lastKey = k;
    }
    if (!this.opts.reuse) {
      while (this.host.firstChild) this.host.removeChild(this.host.firstChild);
    }
    const target = this.opts.reuse ? (this.host.lastElementChild as HTMLElement) ?? this.host : this.host;
    try {
      this.render(target, state);
    } catch (e) {
      console.error('[经纬] 区域重绘出错', e);
      this.host.textContent = '这块渲染出错了，详见控制台。';
    }
  }

  dispose(): void {
    this.disposed = true;
    while (this.host.firstChild) this.host.removeChild(this.host.firstChild);
  }
}

/** 把 store 订阅与一批区域接起来，返回一个取消函数 */
export function bindRegions<S extends object>(store: Store<S>, regions: Region<S>[]): Unsubscribe {
  const paint = (s: S) => {
    for (const r of regions) r.paint(s);
  };
  paint(store.get() as S);
  return store.subscribe((s) => paint(s));
}
