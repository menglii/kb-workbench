/**
 * ui/undo-bar.ts —— 撤销条（交互规格 §10.1 / §1.3）
 *
 * 两条硬规矩：
 *  ① **「撤销」= 从操作前的快照还原**，不是逆运算。全案的安全论证建立在
 *     "不做逆运算"上（方案设计.md §6.1），撤销条不能是例外。
 *  ② **动库成功后才出现**，存活 5 秒；超时后仍能在快照面板里还原
 *     （超时不是"没了"，是"换个入口"）。
 *
 * 与通知栈同一套做法（挂在 body 上、可被插件重载留下孤儿 → 加载/卸载都要清）：
 * 容器挂在 document.body，`position: fixed` 在底部。
 */
import { btn, div, span } from './primitives';
import { notifyLight } from './notify';
import type { RestoreResult } from '../services/snapshot';

/** 存活时长（交互规格 §10.1：5 秒） */
export const UNDO_MS = 5000;

export interface UndoSpec {
  /** 「已移动 12 篇笔记」 */
  text: string;
  detail?: string;
  /** 「撤销」——一般就是 `snapshot.restore(id)` */
  onUndo: () => void | Promise<void>;
  /** 「查看」——打开这次的操作报告 */
  onView?: () => void;
  ms?: number;
  /**
   * 超时后的落点（默认什么都不做）。传了就在超时时给一条轻提示，
   * 让用户知道"还能在快照面板里还原"。
   */
  onExpire?: () => void;
}

/**
 * 「还原或知会」—— 全仓 fire-and-forget `restore(...)` 的统一落点（P7.19 · #1③）。
 *
 * 🔴 为什么非要它：`snapshot.restore(id)` 在**快照已被消费 / 读不回**时会 throw，
 * 而调用方几乎都写成 `() => void ctx.snapshot.restore(id)` —— `void` 把 promise
 * 吞成 `undefined`，**undo-bar 那一层也接不住**（它只能 catch `onUndo()` 的返回值）。
 * 后果分两头：真机上只是控制台一条报错、用户毫无感知；离线套件则按设计
 * **整轮判红**，而且那条日志在 P7.19 之前**不带用例名**（见 #4）——
 * "二次 restore"那只虫就是这么长出来的。
 *
 * 口径：失败 → `[经纬]` warn（探针收得到）+ 一条轻提示（用户知道"没撤销成功"）；
 * 成功 → 原样把 `RestoreResult` 交回调用方的 `.then(...)`（**各处成功文案一律不动**）。
 * 失败时 resolve `null` —— 所以带 `.then((back) => …)` 的调用点要判一下再播成功提示。
 */
export function restoreOrNotify(
  snap: { restore: (id: string) => Promise<RestoreResult> },
  id: string,
): Promise<RestoreResult | null> {
  return Promise.resolve()
    .then(() => snap.restore(id))
    .catch((e: unknown) => {
      console.warn(`[经纬] 还原失败（快照 ${id}）`, e);
      notifyLight('没撤销成功', '这份快照已经不在了（多半已经撤过一次）');
      return null;
    });
}

let container: HTMLElement | null = null;
let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function getContainer(): HTMLElement {
  if (container && container.isConnected) return container;
  purgeContainers();
  container = div({ cls: 'kbw-undobar-wrap', attr: { role: 'region', 'aria-label': '撤销' } });
  document.body.appendChild(container);
  return container;
}

function purgeContainers(): void {
  for (const stale of Array.from(document.querySelectorAll('.kbw-undobar-wrap'))) stale.remove();
}

/** 插件加载/卸载时调：别在 body 上留孤儿 DOM */
export function disposeUndoBar(): void {
  clearTimer();
  purgeContainers();
  container = null;
  current = null;
}

/**
 * 有撤销条在吗（探针与测试用）。
 * ⚠️ 退场是异步的（等动画 / 400ms 兜底），所以**光看 isConnected 会晚一拍** ——
 * 已经打了 `leaving` 标记的就不算"还在"（与通知栈的 liveNotices 同一口径）。
 */
export function hasUndoBar(): boolean {
  return current != null && current.isConnected && current.dataset.leaving !== '1';
}

function clearTimer(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function dismiss(node: HTMLElement): void {
  if (!node.isConnected) return;
  node.dataset.leaving = '1';
  node.classList.add('is-leaving');
  node.addEventListener('animationend', () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 400); // 兜底：动效被 reduced-motion 掐掉时也能收
}

export function showUndo(spec: UndoSpec): void {
  // 同一时刻只有一条（批量操作会连发；新的顶掉旧的，旧的超时提示也不该再响）
  clearTimer();
  if (current) dismiss(current);

  const host = getContainer();
  const ms = spec.ms ?? UNDO_MS;
  const node = div({ cls: 'kbw-undobar', data: { text: spec.text } });

  const body = div({ cls: 'kbw-undobar-body' });
  body.appendChild(div({ cls: 'kbw-undobar-text', text: spec.text }));
  if (spec.detail) body.appendChild(div({ cls: 'kbw-undobar-detail', text: spec.detail }));
  node.appendChild(body);

  /**
   * 🔴 **离场守卫**（P7.19 · #1②，语义拍板 G1 = 幂等跳过 + 轻提示）：
   * `dismiss()` 之后这条**还挂在 DOM 上最多 400ms**（等 `animationend` / 兜底定时器），
   * 而这期间再点任何按钮都**不该再触发动作** —— 上游多半已经被第一次点击消费掉了，
   * 最典型的是 `snapshot.restore(id)`：**restore 成功即 `remove(id)`**，
   * 第二次必然抛「快照不存在或读不了」。
   * 不动成功路径的任何文案：这条只在"已经点过、条正在走"时说话。
   */
  const gone = (): boolean => node.dataset.leaving === '1';
  const alreadyGone = (): void => {
    notifyLight('这一条正在收走', '刚才那一下已经生效，不用再点');
  };

  const actions = div({ cls: 'kbw-undobar-actions' });
  if (spec.onView) {
    actions.appendChild(
      btn({
        cls: 'kbw-btn is-small is-ghost',
        text: '查看',
        on: {
          click: () => {
            if (gone()) {
              alreadyGone();
              return;
            }
            clearTimer();
            spec.onView?.();
            dismiss(node);
          },
        },
      }),
    );
  }
  actions.appendChild(
    btn({
      cls: 'kbw-btn is-small is-primary',
      text: '撤销',
      on: {
        click: () => {
          if (gone()) {
            alreadyGone();
            return;
          }
          clearTimer();
          dismiss(node);
          /**
           * ⚠️ 这道 catch 现在**实际上不会被触发**（P7.19 独立审查 🟡5 指出）：
           * 全仓的 `onUndo` 调用点都写成 `() => void restoreOrNotify(...)` —— `void` 让
           * `spec.onUndo()` 返回 `undefined`，而 `restoreOrNotify` 自己已经把失败兜住了
           * （`[经纬]` warn + 轻提示）、**永不 reject**。
           * 留着它是**第二道防线**（万一将来有调用点直接返回一个会 reject 的 promise）；
           * 但别把它当成"撤销失败一定有提示"的**保证** —— 那件事在 `restoreOrNotify` 里。
           */
          void Promise.resolve(spec.onUndo()).catch((e) => {
            console.warn('[经纬] 撤销失败', e);
            notifyLight('没撤销成功', '这次还原没走完，可在快照面板里再试');
          });
        },
      },
    }),
  );
  actions.appendChild(
    span({
      cls: 'kbw-undobar-close',
      text: '×',
      attr: { role: 'button', 'aria-label': '关掉撤销条', tabindex: '0' },
      on: {
        click: () => {
          clearTimer();
          dismiss(node);
        },
      },
    }),
  );
  node.appendChild(actions);

  // 倒计时进度（纯 CSS 动画，宽度的推进就是"还剩多久"）
  const progress = div({ cls: 'kbw-undobar-progress' });
  progress.style.setProperty('--kbw-undo-ms', `${ms}ms`);
  node.appendChild(progress);

  host.appendChild(node);
  current = node;

  timer = setTimeout(() => {
    timer = null;
    dismiss(node);
    try {
      spec.onExpire?.();
    } catch (e) {
      console.error('[经纬] 撤销条超时回调出错', e);
    }
  }, ms);

  // 鼠标停下看/准备点的时候不该消失（和通知栈同一套）
  let paused = false;
  const pause = (): void => {
    paused = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    progress.classList.add('is-paused');
  };
  const resume = (): void => {
    if (!paused || !node.isConnected) return;
    paused = false;
    progress.classList.remove('is-paused');
    timer = setTimeout(() => {
      timer = null;
      dismiss(node);
      try {
        spec.onExpire?.();
      } catch (e) {
        console.error('[经纬] 撤销条超时回调出错', e);
      }
    }, 1200);
  };
  node.addEventListener('mouseenter', pause);
  node.addEventListener('mouseleave', resume);
  node.addEventListener('focusin', pause);
  node.addEventListener('focusout', resume);
}

/** 测试用：清干净 */
export function __resetUndo(): void {
  disposeUndoBar();
}
