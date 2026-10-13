/**
 * ui/beautify.ts —— **「美化笔记」**（P7.12 · R8 的 A 形态）：AI 出稿 → 预览对比 →
 * 确认 → **整体替换正文**（快照 + 撤销条）。
 *
 * 🔴 这是"**AI 改正文**"的新写路径 —— `交互规格.md` §8.5 边界的补充条：
 * P7.3c 的 D4（"替换选区"不做）被本次**有意识地重开**：口子只开在"整篇正文、用户
 * 在对比框里看过稿、走确认流"这一条上；"替换选区"照旧不做（撤销语义单拍）。
 *
 * 边界（与全项目同一条）：
 *   · 动库前确认 → `ui/confirm.ts`（唯一出口）；写盘链（快照 → `vault.process` +
 *     `markSelfWrite` → 日志 → 撤销条）在 `ui/doc-write.ts`（P7.22a 抽件，
 *     与 `ui/ai-tools.ts` 的正文编辑工具**共用同一条**）；
 *   · **只换正文**：前言原样保留（模型根本看不到它，回来也不许碰）；
 *   · 快照失败 → **中止**（一个字节都不写）；写完弹撤销条（快照还原，不是逆运算）；
 *   · `03_AI指令集`（保护目录）**在发起前就拦** —— 与起标题同一道闸
 *     （这条流水线全程 `source:'ai'`，归 §11.1 边界③ 管）。
 *
 * 防呆三则（都写死在下面，别删）：
 *   ① AI 回了空稿 → 不替换；
 *   ② 预览到确认之间**正文被别处改过** → 不覆盖（重看一眼）；
 *   ③ 超长正文由服务层拒绝（整篇替换的截断 = 数据丢失）。
 */
import { TFile } from 'obsidian';
import type { WorkbenchContext } from '../core/context';
import { relativeTo } from '../core/paths';
import { splitFrontmatter } from '../services/frontmatter';
import { AiError, AI_PROTECTED_WHY, isAiProtected } from '../services/ai';
import { confirm } from './confirm';
import { diffBox } from './diff-box';
import { writeDocs } from './doc-write';
import { notifyError, notifyLight } from './notify';
import { AI_NOT_CONFIGURED } from './suggest-panel';

/**
 * 从编辑器右键进来：出稿 → 对比 → 确认 → 替换。**异步、可重入互斥**（同一次打开
 * 里连点两次会弹两个确认框 —— 用一个模块级 busy 挡住，重复点击只给轻提示）。
 */
let running = false;

export async function runBeautify(ctx: WorkbenchContext, file: TFile): Promise<void> {
  if (running) {
    notifyLight('上一次美化还没走完', '等对比框出来再说');
    return;
  }
  if (!ctx.ai.isConfigured()) {
    notifyLight(AI_NOT_CONFIGURED);
    return;
  }
  /**
   * 保护目录硬拦：与 `ui/title-panel.ts` 建行时的本地判定同一句话（`AI_PROTECTED_WHY`）。
   * ⚠️ 拦的是**发起**（AI 改正文 = 写），用户自己动那篇不受影响。
   */
  if (isAiProtected(file.path, ctx.ai.protectedDir())) {
    notifyLight(AI_PROTECTED_WHY);
    return;
  }
  const kbRoot = ctx.settings.kbRoot();
  const rel = relativeTo(file.path, kbRoot);
  if (!rel || rel === file.path) {
    notifyLight('这一篇不在库根之下', '美化只服务库里的笔记');
    return;
  }

  running = true;
  try {
    /**
     * 出稿前先读一份"原文"（确认框要把两份都摆出来）——
     * 服务层还会再读一次（它管长度拒绝与材料口径），这里读的是**展示与写回**要的那份。
     */
    const original = await ctx.app.vault.cachedRead(file);
    const { body: bodyBefore } = splitFrontmatter(original);
    if (bodyBefore.trim() === '') {
      notifyLight('这篇没有正文', '空笔记没什么可美化的');
      return;
    }

    notifyLight('AI 美化中…', `《${file.basename}》· 出稿要一会儿`);
    let out: { body: string };
    try {
      out = await ctx.ai.beautify({ rel });
    } catch (e) {
      notifyError(
        '没美化出来（原件没动）',
        e instanceof AiError ? e.hint : e instanceof Error ? e.message : String(e),
      );
      return;
    }
    if (out.body.trim() === '') {
      notifyError('AI 回了空稿', '没有替换，原件没动');
      return;
    }

    const res = await confirm({
      title: `用美化稿替换「${file.basename}」的正文？`,
      preview: [
        {
          kind: 'set',
          prop: '正文',
          from: `${bodyBefore.split('\n').length} 行 / ${bodyBefore.length} 字`,
          to: `${out.body.split('\n').length} 行 / ${out.body.length} 字`,
          count: 1,
        },
      ],
      warnings: [],
      notes: ['只换正文；前言与属性一个字不动', '整体替换：执行前自动快照，可一键还原'],
      primary: { label: '替换正文' },
      secondary: [{ label: '不动它', value: 'cancel' }],
      attach: (host) => host.appendChild(diffBox(bodyBefore, out.body)),
    });
    if (res.action !== 'primary') return;

    /**
     * ── 快照 → 写 → 日志 → 撤销条（P7.22a 起走 `ui/doc-write.ts` 的共享链 ——
     * beautify 原来是这条链的"手写版"，抽件的理由 = #1 的正文编辑工具要同一条；
     * 行为照旧：快照失败整批中止、当刻重算防呆、一批一动=一快照=一撤销句柄）──
     */
    const write = await writeDocs(ctx, {
      reason: `美化笔记：${file.basename}`,
      label: '美化笔记',
      items: [
        {
          file,
          /**
           * 防呆②：确认期间正文被别处改过（同步拉进来一笔 / 别的窗口在编辑）→
           * `skip` → **不覆盖**，出来给一句"重看一眼"。
           */
          next: (cur) => (cur.body !== bodyBefore ? { skip: 'changed' } : { body: out.body }),
        },
      ],
      logSummary: () => `美化《${file.basename}》正文（${bodyBefore.length} → ${out.body.length} 字）`,
      logExtra: 'AI 改正文（R8 新写路径；只换正文、前言不动）',
      undoText: () => `已美化：${file.basename}`,
      undoDetail: '撤销 = 从操作前的快照还原（正文换回原稿）',
      undoneText: '已还原这次美化',
    });
    if (write.error != null) {
      notifyError('快照失败，已中止（一个字节都没写）', write.error);
      return;
    }
    const done = write.items[0];
    if (done.state === 'skipped') {
      notifyLight('正文刚被别处改过，没有覆盖', '再看一眼原文，重新发起一次美化');
      return;
    }
    if (done.state === 'failed') {
      /**
       * ⚠️ 独立审 A3（2026-10-07）的语义在这里：写盘那一步抛出（最现实的一发：
       * 确认期间那篇被别处删了/移进回收站）必须**明说** —— 不弹错、无撤销条、
       * 用户以为"点了替换，什么都没发生"是当年的缺陷形态。
       */
      notifyError('美化没走完', `${done.note ?? ''}（原件若已被替换，可在快照面板还原）`);
      return;
    }
  } catch (e) {
    /**
     * ⚠️ 独立审 A3（2026-10-07）：旧写法只有 `try/finally` 没有 `catch` —— 任一步抛出
     * （最现实的一发：确认期间那篇被别处删了/移进回收站，`vault.process` 读文件失败；
     * 或出稿前 `cachedRead` 时文件就没了）都会被调用方的 `void` 吞成未捕获拒绝：
     * 不弹错、无撤销条、控制台之外零痕迹 —— 用户看到的是"点了替换，什么都没发生"。
     */
    notifyError('美化没走完', `${e instanceof Error ? e.message : String(e)}（原件若已被替换，可在快照面板还原）`);
  } finally {
    running = false;
  }
}
