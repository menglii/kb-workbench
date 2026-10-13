/**
 * ui/organize.ts —— 「补尾链」共用链（P7.12 · #9/#11 从 suggest-panel 拆出）
 *
 * 语义一字不动（原 `suggest-panel.ts` 闭包里的 `chainTail`）：快照 → 逐篇
 * `completion.fillFile`（只加不删，与「一键补全存量」同一条链）→ 报告日志 → 撤销条。
 * 两个调用方：
 *   · 整理建议面板 C 类（原主，拆出来就是为了「一键整理」不写第二份 —— 两处各截一刀迟早漂）；
 *   · 「一键整理」的 AI 流程（补属性 → 搬 → **补尾链**）：**搬后**按新位置补 ——
 *     尾链里的「所属中心 / 返回大地图」取决于它现在住哪，搬前补必然指错。
 *
 * ⚠️ 传的是**库内绝对路径**（vault 口径，`fillFile` 直接吃）；调用方自己从"相对库根"拼。
 * `quiet = true` 时不弹自己的撤销条（快照照拍、id 返回）——「一键整理」要把它并进
 * 搬动那条撤销条（搬的快照**还原内容**，一次还原就把尾链和声明一起带回去了）。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { notifyError, notifyLight } from './notify';
import { restoreOrNotify, showUndo } from './undo-bar';

export interface TopUpTailsResult {
  filled: number;
  skipped: number;
  failed: number;
  /** 快照 id（没拍成/空跑时为 ''） */
  snapshotId: string;
}

export async function topUpTails(
  ctx: WorkbenchContext,
  absPaths: string[],
  o: { action: string; source: string; quiet?: boolean; reasonLabel?: string },
): Promise<TopUpTailsResult> {
  const out: TopUpTailsResult = { filled: 0, skipped: 0, failed: 0, snapshotId: '' };
  const files: TFile[] = [];
  const missing: string[] = [];
  for (const p of absPaths) {
    const f = ctx.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) files.push(f);
    else missing.push(p);
  }
  if (missing.length > 0) notifyLight(`${missing.length} 篇执行时已经不在原位（跳过了）`, missing[0]);
  if (files.length === 0) return out;

  try {
    const snap = await ctx.snapshot.capture({
      reason: `${o.reasonLabel ?? '补尾链'}：${files.length} 篇`,
      files,
    });
    out.snapshotId = snap.id;
  } catch (e) {
    notifyError('快照失败，已中止', e instanceof Error ? e.message : String(e));
    return out;
  }

  const failedRows: string[] = [];
  for (const f of files) {
    try {
      const outcome = await ctx.completion.fillFile(f, {});
      if (outcome.kind === 'filled') out.filled += 1;
      else if (outcome.kind === 'failed') {
        out.failed += 1;
        failedRows.push(`${f.basename}：${outcome.detail}`);
      } else out.skipped += 1;
    } catch (e) {
      out.failed += 1;
      failedRows.push(`${f.basename}：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const logged = await ctx.report.log({
    action: o.action,
    result: failedRows.length === 0 ? 'ok' : 'partial',
    source: o.source,
    /**
     * ⚠️ **汇总措辞别特指"尾链"**（P7.17 修洞后回销）：`fillFile` 现在**也补缺键**
     *（有前言的按行合并补六件缺的），逐篇 `detail` 是准的、汇总这一行跟着放宽口径。
     */
    summary: `补了 ${out.filled} 篇的缺口（缺的键与尾链；跳过 ${out.skipped} 篇，失败 ${out.failed} 篇）`,
    rows: failedRows.slice(0, 5).map((f) => ({ label: '失败', detail: f })),
    snapshotId: out.snapshotId,
    extra: '只加不删（与「一键补全存量」同一条链）',
  });
  if (!logged) notifyLight('这次的补全日志没写进库', '（操作本身已完成，见控制台）');

  if (out.snapshotId && !o.quiet) {
    showUndo({
      // 同上面那条：口径从"只补尾链"放宽成"补缺口"（P7.17 修洞的回销）
      text: `已补 ${out.filled} 篇（缺的键与尾链）`,
      detail: '撤销 = 从操作前的快照还原',
      onUndo: () => {
        void restoreOrNotify(ctx.snapshot, out.snapshotId).then((r) => {
          if (r) notifyLight('已还原这次补尾链');
        });
      },
      onView: () => void ctx.report.openLatest(),
      onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
    });
  }
  if (failedRows.length > 0) notifyLight(`${failedRows.length} 篇没补成`, failedRows[0]);
  return out;
}
