/**
 * ui/clear-empty.ts —— **「一键清空此类…」**（#10 ②，2026-10-06 拍定；
 * P7.13b 从 `ui/suggest-panel.ts` **原样抽出**，两处入口共用同一份）。
 *
 * 判定 = `stripTailSection(stripFrontmatter(text)).trim() === ''` ——
 * 用户那些"只有一个模板架子"的笔记正好落进这个判定。模板（`T_*`）与
 * `03_AI指令集` 一律不碰。范围 = **全库扫**（#10 口径；不管从哪进来，清的都一样）。
 *
 * 流：预览（逐篇）→ 确认 → `mover.trash`（快照 + 日志全在那条链上）→ 撤销条。
 *
 * ⚠️ **抽出时的两条纪律**（P7.13b）：
 *   · 行为一字不改 —— suggest-panel 那条路（`busy` 状态 + `render()` 由调用方管）
 *     照旧；文案逐字保留（既有判据认字符串）。
 *   · `source` 参数化：整理建议面板那条路传 `'suggest'`（默认，行为不变），
 *     首页待处理的 ① 传 `'todo'`（操作日志的来源标签，见 `MoveSource`）。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import type { MoveSource } from '../services/mover';
import { relativeTo } from '../core/paths';
import { stripFrontmatter } from '../services/frontmatter';
import { stripTailSection } from '../services/templates';
import { isAiProtected } from '../services/ai';
import { confirm } from './confirm';
import { notifyError, notifyLight } from './notify';
import { restoreOrNotify, showUndo } from './undo-bar';

export async function runClearEmpty(
  ctx: WorkbenchContext,
  opts: { source?: MoveSource } = {},
): Promise<void> {
  try {
    const kbRoot = ctx.settings.kbRoot();
    const protectedAbs = ctx.ai.protectedDir();
    const files: TFile[] = [];
    for (const e of ctx.index.notes()) {
      const rel = relativeTo(e.path, kbRoot);
      if (!rel || rel === e.path) continue;
      if (isAiProtected(e.path, protectedAbs)) continue;
      let text = '';
      try {
        text = await ctx.app.vault.cachedRead(e.file);
      } catch {
        continue;
      }
      if (stripTailSection(stripFrontmatter(text)).trim() === '') files.push(e.file);
    }
    if (files.length === 0) {
      notifyLight('没有可清空的', '全库扫了一遍：没有"剥掉前言与尾链后没有正文"的笔记');
      return;
    }
    const res = await confirm({
      title: `清空这 ${files.length} 篇？`,
      preview: files.map((f) => ({
        kind: 'set' as const,
        prop: `《${f.basename}》`,
        from: '剥掉前言与尾链后，正文为空',
        to: '回收站',
        count: 1,
      })),
      warnings: [],
      notes: [
        '范围 = 全库（不限这份清单的收件箱范围）',
        '进回收站（随时可还原）；执行前自动快照，可一键撤回',
      ],
      primary: { label: `清空这 ${files.length} 篇` },
    });
    if (res.action !== 'primary') return;
    const r = await ctx.mover.trash({
      files,
      source: opts.source ?? 'suggest',
      reason: `清空无正文笔记：${files.length} 篇`,
    });
    if (r.error) {
      notifyError('清空已中止', r.error);
      return;
    }
    if (r.skipped.length > 0) {
      notifyLight(`${r.skipped.length} 篇没清掉`, r.skipped[0]?.note ?? '');
    }
    if (r.trashed.length > 0 && r.snapshotId) {
      showUndo({
        text: `已清空 ${r.trashed.length} 篇（进回收站）`,
        detail: r.reversible ? '撤销 = 从操作前的快照还原' : '这些文件进了系统回收站，可从系统回收站找回',
        onUndo: () => {
          void restoreOrNotify(ctx.snapshot, r.snapshotId).then((back) => {
            // 失败（快照已被消费 / 读不回）已由 restoreOrNotify 报过：只判空，不播成功文案
            if (!back) return;
            notifyLight(`已还原这次清空：写回 ${back.contentsRestored} 篇`);
          });
        },
        onView: () => void ctx.report.openLatest(),
        onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
      });
    }
  } catch (e) {
    notifyError('清空失败', e instanceof Error ? e.message : String(e));
  }
}
