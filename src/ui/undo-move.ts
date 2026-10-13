/**
 * ui/undo-move.ts —— **"搬完之后那条撤销条"**（P6 段⑥ 抽出来的一处）
 *
 * 为什么要有这个文件：`mover.move()` **自己不弹撤销条** —— 弹条的是**调用方**
 *（`notes/ops.ts` / `board/drag.ts` / `home/tidy.ts` / 三个面板各自弹各自的）。
 * 于是每加一个"会搬文件"的入口，就有一份 ~40 行的"弹条 + 撤销走快照还原 + 过期给条出路"
 * 要照抄一遍。P6 段⑥ 的 `editor-menu`（当时的「按规则归位这一篇」；R8 起换成
 * 「重命名」接着用这份实现）是第 N 个入口，
 * 而 `交互规格.md` §8.5 对它的要求是**"与手工那条完全同一套"** ——
 * 那就不该是"抄得像"，该是**同一份代码**。
 *
 * 口径（都是既有行为，搬过来没改）：
 *  · **撤销 = 从操作前的快照还原**（不是逆运算，`交互规格.md` §10.1）；
 *  · 快照里那几件"没做到"的要说出来，并给一条去快照面板的出路（§10.2）；
 *  · 撤销条过期不是"完了"—— 通知里再给一次入口（用户手慢了不该丢现场）。
 */
import type { RestoreResult } from '../services/snapshot';
import type { MoveResult } from '../services/mover';
import { NOTIFY_MS, notify } from './notify';
import { restoreOrNotify, showUndo } from './undo-bar';

export interface UndoMoveDeps {
  /** 还原（走快照服务，与手工那条同一个口） */
  restore: (snapshotId: string) => Promise<RestoreResult>;
  /**
   * 「查看」= 打开刚写的那份操作日志。
   * ⚠️ 返回类型是 `unknown`：`ReportService.openLatest()` 给的是 `Promise<boolean>`
   *（"有没有日志可开"），而调用方**根本不看那个值**（只是 fire-and-forget）。
   * 写成 `void` 会逼两边各加一次 `void` 转换 —— 那属于为了类型好看而加的噪音。
   */
  openLatest: () => unknown;
  /** 出路：快照面板 */
  openSnapshotPanel: () => void;
  /** 还原完成之后的刷新（各屏自己知道该重画什么；不传就不刷） */
  onRestored?: () => void;
}

/** 搬完弹撤销条（成功之后才弹 —— 没搬动就别给一个点了没事的按钮） */
export function showMoveUndo(deps: UndoMoveDeps, res: MoveResult): void {
  if (res.moved.length === 0) return;
  showUndo({
    text: `已移动 ${res.moved.length} 篇笔记`,
    detail: res.moved.length === 1 ? res.moved[0].to : undefined,
    onUndo: () => void restoreNow(deps, res.snapshotId),
    onView: () => void deps.openLatest(),
    onExpire: () => {
      notify({
        kind: 'info',
        text: '撤销条已过期',
        detail: '仍可在快照面板里还原',
        ms: NOTIFY_MS.long,
        actions: [{ label: '打开快照面板', run: () => deps.openSnapshotPanel() }],
      });
    },
  });
}

/**
 * 撤销 = 快照还原。
 *
 * ⚠️ 这一段的**每一句文案都是从 `notes/ops.ts` 原样搬过来的**（P6 段⑥ 抽出来，
 * 没顺手改口径）—— 加这句是因为"抽出共用"最容易走成"顺便优化一下措辞"，
 * 而那会**悄悄改掉既有判据认的字符串**（本项目栽过很多次）。
 *
 * ⚠️ 只管 `blocked`（"挡路没动"）。另外两类**不在这里报**：
 * `problems` / `notifications`（目录删不掉、快照内容读不回…）由
 * **`SnapshotService.restore()` 自己弹**（P5 那条：服务层把"没做到的部分"说出来，
 * 别指望每个调用方记得转达）。在这里再报一遍就是同一件事两处说、迟早不一致。
 */
export async function restoreNow(deps: UndoMoveDeps, snapshotId: string): Promise<void> {
  if (!snapshotId) return;
  const r = await restoreOrNotify(deps, snapshotId);
  // 失败已由 restoreOrNotify 报过（[经纬] warn + 轻提示）：别再播"已还原"
  if (!r) return;
  const done = r.movedBack + r.contentsRestored + (r.filesRemoved ?? 0);
  if (r.blocked.length > 0) {
    notify({
      kind: 'partial',
      text: `已还原 ${done} 项，${r.blocked.length} 项没动`,
      detail: r.blocked.map((b) => `${b.path}：${b.why}`).slice(0, 3).join('；'),
      ms: NOTIFY_MS.long,
      actions: [{ label: '打开快照面板', run: () => deps.openSnapshotPanel() }],
    });
  } else {
    notify({
      kind: 'success',
      text: '已还原',
      detail: r.keptAside.length > 0 ? `${r.keptAside.length} 个文件挪到了「还原保留」` : undefined,
      ms: NOTIFY_MS.light,
    });
  }
  deps.onRestored?.();
}
