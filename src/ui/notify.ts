/**
 * ui/notify.ts —— 通知与反馈（**全局层**，交互规格 §1.3）
 *
 * 五场合 × 时长 × 落点：
 *   轻量成功（改属性、重命名）  顶部 Notice 2s
 *   动库成功（移动/删除/批量）  Notice 3s + 底部撤销条 5s（撤销条在 P1）  → 操作日志
 *   部分成功（有跳过项）        黄色，写明"跳过 N 篇" 6s                  → 操作日志
 *   失败                        红色 + 不自动回滚 6s（可手动关）           → 操作日志
 *   需要决策                    确认流弹窗（不走这里）
 *
 * 为什么不用平台 `Notice`：
 *  ① 落点是**顶部**，平台 Notice 容器在右下角 —— 改平台的容器会连别的插件的通知一起挪走
 *  ② 平台 Notice 没有动作按钮，而「查看报告」「撤销」是这套反馈的必需件
 * 所以自建一个栈：颜色/边框/阴影全走主题变量，零硬编码色。
 *
 * ⚠️ 通知**挂在 document.body 上**，工作台没开着也要能弹（命令面板触发的操作照样要有反馈）。
 */
import { btn, clear, div, span } from './primitives';

export type NoticeKind = 'success' | 'partial' | 'error' | 'info';

/** 时长档（交互规格 §1.3） */
export const NOTIFY_MS = {
  /** 轻量成功：改属性 / 重命名 */
  light: 2000,
  /** 动库成功：移动 / 删除 / 批量 */
  library: 3000,
  /** 部分成功与失败 */
  long: 6000,
  /** 信息提示 */
  info: 3000,
} as const;

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface NotifySpec {
  kind: NoticeKind;
  text: string;
  detail?: string;
  actions?: NoticeAction[];
  /** 不传则按 kind 取默认（success→light，error/partial→long） */
  ms?: number;
  /**
   * 是否让日志落点记一笔。
   * ⚠️ 动库操作**不走这里** —— `services/mover.ts` 自己调 `services/report.ts`
   * 写详细报告（谁、从哪到哪、跳过原因），避免一条操作记两遍。
   * 这个开关留给"改属性"这类没有独立报告的轻量改动。
   */
  log?: boolean;
}

/** 日志落点由外部注入 —— ui 不依赖 services */
export type LogSink = (spec: NotifySpec) => void;

const MAX_VISIBLE = 3;

let container: HTMLElement | null = null;
let logSink: LogSink | null = null;

export function setLogSink(fn: LogSink | null): void {
  logSink = fn;
}

function getContainer(): HTMLElement {
  if (container && container.isConnected) return container;
  // ⚠️ 插件重载后，上一个实例的容器还挂在 body 上（它不是新实例的 DOM）
  // → 先清掉同名的，保证任何时候只有一个容器（真机探针量出来的：旧的没 top，
  //   新通知落到了旧的容器里，位置就一直是错的）
  purgeContainers();
  container = div({ cls: 'kbw-notices', attr: { role: 'region', 'aria-label': '通知' } });
  document.body.appendChild(container);
  return container;
}

function purgeContainers(): void {
  for (const stale of Array.from(document.querySelectorAll('.kbw-notices'))) stale.remove();
}

/** 插件卸载时调：把容器一起带走，不在 body 上留孤儿 DOM */
export function disposeNotices(): void {
  purgeContainers();
  container = null;
}

/**
 * 把通知栈放到**当前视图头的下沿之下**。
 * 固定 `top: 12px` 会压住标签页与视图标题（真机截图比对才发现）；
 * 视图头高度随平台/移动端/停靠方式变，所以每次弹通知都重量一次。
 */
function positionContainer(host: HTMLElement): void {
  let bottom = 0;
  try {
    const header =
      document.querySelector('.workspace-leaf.mod-active .view-header') ??
      document.querySelector('.view-header');
    bottom = header?.getBoundingClientRect?.().bottom ?? 0;
  } catch {
    bottom = 0;
  }
  host.style.top = `${Math.max(12, Math.round(bottom) + 8)}px`;
}

function defaultMs(kind: NoticeKind): number {
  if (kind === 'success') return NOTIFY_MS.light;
  if (kind === 'info') return NOTIFY_MS.info;
  return NOTIFY_MS.long;
}

export function notify(spec: NotifySpec): () => void {
  const host = getContainer();
  positionContainer(host);
  const ms = spec.ms ?? defaultMs(spec.kind);

  // 同类同文本的通知不重复堆叠（批量操作常常连发）
  for (const existing of Array.from(host.children) as HTMLElement[]) {
    if (existing.dataset.kind === spec.kind && existing.dataset.text === spec.text) {
      return () => close(existing);
    }
  }

  const node = div({
    cls: ['kbw-notice', `is-${spec.kind}`],
    data: { kind: spec.kind, text: spec.text },
    attr: { role: spec.kind === 'error' || spec.kind === 'partial' ? 'alert' : 'status' },
  });
  node.appendChild(div({ cls: 'kbw-notice-bar' }));
  const body = div({ cls: 'kbw-notice-body' });
  body.appendChild(div({ cls: 'kbw-notice-text', text: spec.text }));
  if (spec.detail) body.appendChild(div({ cls: 'kbw-notice-detail', text: spec.detail }));
  if (spec.actions && spec.actions.length > 0) {
    const row = div({ cls: 'kbw-notice-actions' });
    for (const act of spec.actions) {
      row.appendChild(btn({ text: act.label, cls: 'kbw-btn is-small' , on: { click: () => { act.run(); close(node); } } }));
    }
    body.appendChild(row);
  }
  node.appendChild(body);
  node.appendChild(
    span({
      cls: 'kbw-notice-close',
      text: '×',
      attr: { role: 'button', 'aria-label': '关闭通知', tabindex: '0' },
      on: {
        click: () => close(node),
        keydown: (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') close(node);
        },
      },
    }),
  );

  host.appendChild(node);

  // 最多同时 3 条：超出把最老的收掉
  // ⚠️ 必须按"还没开始退场的"计数 —— 退场是异步的（等动画/400ms），
  // 直接数 children.length 会永远不降，**在 while 里转死**（P0 真踩过）
  while (liveNotices(host).length > MAX_VISIBLE) {
    const oldest = liveNotices(host)[0];
    if (!oldest) break;
    close(oldest);
  }

  // 悬停/聚焦时暂停计时（6 秒的失败通知常要读完再关）
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => close(node), ms);
  const pause = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const resume = () => {
    if (timer == null && node.isConnected) timer = setTimeout(() => close(node), 1200);
  };
  node.addEventListener('mouseenter', pause);
  node.addEventListener('mouseleave', resume);
  node.addEventListener('focusin', pause);
  node.addEventListener('focusout', resume);

  if (spec.log && logSink) {
    try {
      logSink(spec);
    } catch (e) {
      console.error('[经纬] 写通知日志失败', e);
    }
  }

  return () => close(node);
}

/** 还没开始退场的通知（退场中的不再计入上限） */
function liveNotices(host: HTMLElement): HTMLElement[] {
  return (Array.from(host.children) as HTMLElement[]).filter(
    (c) => c.dataset.leaving !== '1',
  );
}

function close(node: HTMLElement): void {
  if (!node.isConnected || node.dataset.leaving === '1') return;
  node.dataset.leaving = '1'; // 立刻生效，别等 DOM 真的消失
  node.classList.add('is-leaving');
  node.style.pointerEvents = 'none';
  const done = (): void => node.remove();
  node.addEventListener('animationend', done, { once: true });
  setTimeout(done, 400); // 兜底：动画被 prefers-reduced-motion 掐掉时也能收
}

// ── 四类便捷入口（调用处读起来就是交互规格里的那几行）──────────
export function notifyLight(text: string, detail?: string): void {
  notify({ kind: 'success', text, detail, ms: NOTIFY_MS.light });
}

export function notifyInfo(text: string, detail?: string): void {
  notify({ kind: 'info', text, detail, ms: NOTIFY_MS.info });
}

export function notifyPartial(text: string, detail: string, actions?: NoticeAction[]): void {
  notify({ kind: 'partial', text, detail, actions, ms: NOTIFY_MS.long });
}

export function notifyError(text: string, detail?: string): void {
  notify({ kind: 'error', text, detail, ms: NOTIFY_MS.long });
}

/** 测试用：清掉所有通知与容器 */
export function __resetNotices(): void {
  if (container) {
    clear(container);
    container.remove();
    container = null;
  }
}
