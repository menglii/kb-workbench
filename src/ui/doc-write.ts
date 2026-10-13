/**
 * ui/doc-write.ts —— **「改正文」的可复用写链**（P7.22a · #1 抽件）
 *
 * 一条链干四件事：**快照 → `vault.process`（当刻重算 + 防呆）→ 操作日志 → 撤销条**。
 * 两个使用者：
 *   · `ui/beautify.ts`（美化笔记，P7.12 起的单篇先例 —— 抽件后它改调这里）；
 *   · `ui/ai-tools.ts` 的正文编辑工具（`patch_text` / `append`，P7.22a 新开的口）。
 *
 * ## 为什么单独一个文件（而不是让 agent 执行体自己 `vault.process`）
 *
 * `tests/specs/redline.ts` 钉着一条形态禁令：`ui/ai-tools.ts` **不许出现任何写盘 API**
 * （`vault.process(` / `vault.modify(` …）—— AI 驱动的批量写盘只能过既有出口。
 * 正文写盘因此**不在执行体里开**：这里就是那条新答案 —— 执行体只调
 * `writeDocs(ctx, …)`，`vault.process` 只在本文件里出现。redline 的正向断言
 * （"执行体必调这条新出口"）与负向名单（"仍不许自己开写盘 API"）在
 * `tests/specs/redline.ts` 的「AI 面板只画不动库」那条里同处挂着 —— 改这条链 = 有意识地改契约。
 *
 * ## 三条纪律（沿用 beautify 的防呆三则，别删）
 *
 * ① **快照失败 → 整批中止**（一个字节都不写）——先拍快照，拍不出来就退；
 * ② **写时以"当刻正文"重算**（`vault.process` 回调里拿最新文本走 `next()`）：
 *    确认到执行之间正文被别处改过 → `next` 返回 `{skip}` → **不覆盖**；
 * ③ **一批一动 = 一快照 = 一撤销句柄**：多篇写共用同一张快照、只弹一条撤销条。
 *
 * ⚠️ **只换正文**：前言那一半由 `splitFrontmatter` 切开后**原样拼回**（`next` 只算 body）。
 * ⚠️ **确认流不在这里**：调用方各自过 `ui/confirm.ts`（唯一出口，红线只认拖拽一个例外），
 * 本件从"确认之后"开始。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { splitFrontmatter } from '../services/frontmatter';
import { markSelfWrite } from '../core/writes';
import { notifyLight } from './notify';
import { restoreOrNotify, showUndo } from './undo-bar';

/** 一篇的写单：`next` 在 `vault.process` 回调里拿"当刻正文"算新正文 */
export interface DocWriteItem {
  file: TFile;
  /**
   * 返回 `{body}` = 写这个新正文；返回 `{skip: 原因}` = **不写这一篇**（防呆 / 幂等），
   * 原因如实带回（调用方给用户看）。
   */
  next: (cur: { head: string; body: string }) => { body: string } | { skip: string };
}

/** 逐篇结果（与 `items` 同序） */
export interface DocWriteOutcome {
  path: string;
  state: 'written' | 'skipped' | 'failed';
  /** skipped 的原因 / failed 的报错 */
  note?: string;
}

export interface DocWriteResult {
  items: DocWriteOutcome[];
  snapshotId: string;
  /** 快照失败（整批中止，一篇都没写） */
  error?: string;
}

export interface DocWriteSpec {
  /** 快照 reason（如「美化笔记：X」/「改正文（AI）：3 篇」） */
  reason: string;
  /** 操作日志的 action（如「美化笔记」） */
  label: string;
  items: DocWriteItem[];
  /** 日志 summary（`written` = 真写成功的篇数；失败/跳过如实由调用方另行呈报） */
  logSummary: (written: number) => string;
  logExtra?: string;
  /** 撤销条文案（只有真写了才弹；`written` = 真写成的篇数 —— 别报"N 条"把跳过的算进去） */
  undoText: (written: number) => string;
  undoDetail: string;
  /** 撤销成功后的轻提示 */
  undoneText: string;
}

/**
 * 跑一条写链。**不抛异常**：快照失败走 `error`、单篇失败走该篇的 `state:'failed'`。
 * （beautify 的"整个流程抛出"兜底仍在它自己的 try/catch —— 那是它那层的交互职责。）
 */
export async function writeDocs(ctx: WorkbenchContext, spec: DocWriteSpec): Promise<DocWriteResult> {
  const out: DocWriteOutcome[] = spec.items.map((it) => ({ path: it.file.path, state: 'failed' }));

  // ── ① 快照（失败 → 整批中止；与 beautify 的"快照失败，已中止"同一条语义）──
  let snapId = '';
  try {
    const snap = await ctx.snapshot.capture({ reason: spec.reason, files: spec.items.map((it) => it.file) });
    snapId = snap.id;
  } catch (e) {
    return { items: out, snapshotId: '', error: e instanceof Error ? e.message : String(e) };
  }

  // ── ② 逐篇写（`vault.process` 里当刻重算；前言原样拼回）──
  let written = 0;
  for (let i = 0; i < spec.items.length; i += 1) {
    const item = spec.items[i];
    const res = out[i];
    try {
      let skipWhy: string | null = null;
      let didWrite = false;
      markSelfWrite(item.file.path);
      await ctx.app.vault.process(item.file, (cur) => {
        const now = splitFrontmatter(cur);
        const next = item.next(now);
        if ('skip' in next) {
          skipWhy = next.skip;
          return cur;
        }
        didWrite = true;
        return now.head + next.body;
      });
      if (skipWhy != null) {
        res.state = 'skipped';
        res.note = skipWhy;
      } else if (didWrite) {
        res.state = 'written';
        written += 1;
      } else {
        // `process` 回调没跑（理论上不达）——保守当"没写"，别冒充成功
        res.state = 'skipped';
        res.note = '写盘回调没有执行';
      }
    } catch (e) {
      res.state = 'failed';
      res.note = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * ── ③ 日志 + 撤销条（**真写了才落**）──
   * 一篇都没写成时不落日志、不弹撤销条（没动库就没有"这次操作"可记）。
   */
  if (written > 0) {
    const logged = await ctx.report.log({
      action: spec.label,
      result: 'ok',
      source: 'ai',
      summary: spec.logSummary(written),
      snapshotId: snapId,
      extra: spec.logExtra,
    });
    if (!logged) notifyLight(`这次的「${spec.label}」日志没写进库`, '（操作本身已完成，见控制台）');
    showUndo({
      text: spec.undoText(written),
      detail: spec.undoDetail,
      onUndo: () => {
        void restoreOrNotify(ctx.snapshot, snapId).then((r) => {
          if (r) notifyLight(spec.undoneText);
        });
      },
      onView: () => void ctx.report.openLatest(),
      onExpire: () => notifyLight('撤销条已过期', '仍可在快照面板里还原'),
    });
  }
  return { items: out, snapshotId: snapId };
}
