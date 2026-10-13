/**
 * blocks/recent —— 最近改动（§2.4）
 *
 * **P7.2a 从 `modules/home/index.ts` 原样搬出**（行为一字不改）——
 * 段的标题（"最近改动" + 发丝线）也归这块；「改动内容」照旧来自我们自己的操作日志。
 */
import type { WorkbenchContext } from '../../../core/context';
import type { NoteEntry } from '../../../core/vault-index';
import type { HomeBlock } from './index';
import { div, el } from '../../../ui/primitives';
import { formatRelativeTime } from '../../../core/util';
import { asString } from '../../../services/schema';

/** 最近改动显示几条 */
const RECENT_N = 3;
/** 「改动内容」最多往回读几条日志 */
const LOG_SCAN = 6;

/** 每次 paint +1：异步回来时"我这一轮还算不算数" */
let gen = 0;

/** 日志正文里的「摘要」：`# 移动 · …` 后的第一个非空普通行 */
function summaryOf(text: string): string {
  const lines = text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#') || t.startsWith('---') || t.startsWith('**结果**') || t.startsWith('-') || t.startsWith('|')) continue;
    if (/^[一-龥A-Za-z]+:/.test(t)) continue; // 前言里的键
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }
  return '';
}

function describeChange(entry: NoteEntry, logs: { text: string; summary: string }[]): string {
  if (entry.flags.includes('external-change')) return '外部改动';
  const hit = logs.find((l) => l.text.includes(entry.basename));
  if (hit && hit.summary) return hit.summary;
  return asString(entry.props['状态']) ? `状态：${asString(entry.props['状态'])}` : '—';
}

async function recentLogs(ctx: WorkbenchContext): Promise<{ text: string; summary: string }[]> {
  try {
    const files = await ctx.report.recent(LOG_SCAN);
    const out: { text: string; summary: string }[] = [];
    for (const f of files) {
      const text = await ctx.app.vault.cachedRead(f);
      out.push({ text, summary: summaryOf(text) });
    }
    return out;
  } catch (e) {
    console.error('[经纬] 读操作日志失败', e);
    return [];
  }
}

async function paintRecent(ctx: WorkbenchContext, host: HTMLElement, myGen: number): Promise<void> {
  const recent = [...ctx.index.notes()].sort((a, b) => b.mtime - a.mtime).slice(0, RECENT_N);
  // ⚠️ 这里要 await（读日志）→ 期间可能又重绘过一次：世代号不对就整段放弃，
  // 否则会把行追加到新一轮内容后面（"最近改动"重复）
  if (myGen !== gen) return;
  if (recent.length === 0) {
    host.appendChild(div({ cls: 'kbw-home-clean', text: '还没有笔记' }));
    return;
  }
  // 「改动内容」来自我们自己的操作日志（§2.4）：读最近几条，谁提到它就归谁
  const logs = await recentLogs(ctx);
  if (myGen !== gen) return;
  for (const e of recent) {
    const row = div({
      cls: ['kbw-rec', 'kbw-hover-1'],
      /**
       * **两种打开方式都写进 title**（P7.2d · 16.9-c 的拍板原话）：
       * 小窗是看板域的能力（`ctx.openNoteWindow` 桥），看板模块关着时退标签页。
       */
      attr: { title: `${e.path}\n点击：以小窗打开（看板模块开着时）；看板关着 → 新标签页` },
    });
    row.appendChild(div({ cls: 'kbw-rec-n', text: e.basename, title: e.path }));
    row.appendChild(div({ cls: 'kbw-rec-w', text: describeChange(e, logs) }));
    row.appendChild(div({ cls: 'kbw-rec-t', text: e.mtime ? formatRelativeTime(e.mtime) : '—' }));
    row.addEventListener('click', () => {
      /**
       * **先问桥**（P7.2d · 16.9-c）：`true` = 小窗那条路处理了（含"已经开着 → 抬到最前"）。
       * 桥没接上（看板模块关着 / 路径不在索引里）才退"开标签页" ——
       * 新标签是**必须**的：`false` 会替换当前叶子（当前叶子往往就是工作台）。
       */
      if (ctx.openNoteWindow?.(e.path)) return;
      void ctx.app.workspace.getLeaf('tab').openFile(e.file);
    });
    host.appendChild(row);
  }
}

export const recentBlock: HomeBlock = {
  id: 'recent',
  title: '最近改动',
  hint: '全库 mtime 前 3；「改动内容」来自操作日志（不是我们改的写"外部改动"）',
  defaultOn: true,
  paint(ctx, host) {
    const myGen = ++gen;
    const head = div({ cls: 'kbw-sec-head' });
    head.appendChild(el('h3', { text: '最近改动' }));
    host.appendChild(head);
    host.appendChild(div({ cls: 'kbw-rule' }));
    void paintRecent(ctx, host, myGen);
    return true;
  },
  cleanup() {
    gen += 1;
  },
};
