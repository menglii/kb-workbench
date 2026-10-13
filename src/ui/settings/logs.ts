/**
 * ui/settings/logs.ts —— 设置 · **日志**栏（交互规格 §7.7）
 *
 * 为什么这一栏不是可有可无的：§11 要求"AI 每次动库都留痕，便于事后回看它判断得对不对"
 * —— **留痕的地方就是这里**。命令面板收成 4 条之后，日志就只剩"撤销条上的查看"，
 * 看完就找不回来了；这一栏是它的常驻入口。
 *
 * 列表读 `99_Meta/05_操作日志/`，点开**直接在 Obsidian 里打开那篇日志笔记**
 * （它们本来就是笔记实体，可被双链引用、可被看板检索）。
 * 「是否 AI 建议的」筛选 §7.7 列了，但真要有东西可筛得等 P6（AI 助手），先摆着。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../../core/context';
import { formatRelativeTime } from '../../core/util';
import { parseReport, type ParsedReport, type ReportResult } from '../../services/report';
import { btn, div, span } from '../primitives';
import { emptyLine, group, setTitle, smallBtn, statusLine, toolbar } from './kit';
import type { SectionApi, SettingsBlock } from './types';

const RESULT_LABEL: Record<ReportResult, string> = { ok: '成功', partial: '部分成功', error: '失败' };

interface Row {
  file: TFile;
  parsed: ParsedReport;
}

export function makeLogsSection(): SettingsBlock {
  let typeFilter = 'all';
  let resultFilter: 'all' | ReportResult = 'all';
  let aiOnly = false;

  return {
    label: '日志',
    sub: '操作日志列表与筛选',
    render(host, api) {
      void paint(host, api);
    },
  };

  async function paint(host: HTMLElement, api: SectionApi): Promise<void> {
    const ctx = api.ctx;
    host.appendChild(setTitle('日志', `库内目录：${ctx.settings.logDir()}（日志就是普通笔记，点开可读全文）`));

    const files = await ctx.report.recent(200);
    const rows: Row[] = [];
    for (const f of files) {
      const text = await safeRead(ctx, f);
      const parsed = parseReport(text, f.name);
      if (parsed) rows.push({ file: f, parsed });
    }

    const types = Array.from(new Set(rows.map((r) => r.parsed.action))).sort((a, b) => a.localeCompare(b, 'zh'));

    // ── 筛选 ───────────────────────────────────────────────────
    const typeSel = document.createElement('select');
    typeSel.className = 'kbw-select';
    typeSel.appendChild(option('all', `全部类型（${types.length}）`));
    for (const t of types) typeSel.appendChild(option(t, t));
    typeSel.value = typeFilter;
    typeSel.addEventListener('change', () => {
      typeFilter = typeSel.value;
      api.rerender();
    });

    const resultSel = document.createElement('select');
    resultSel.className = 'kbw-select';
    resultSel.appendChild(option('all', '全部结果'));
    for (const r of ['ok', 'partial', 'error'] as ReportResult[]) {
      resultSel.appendChild(option(r, RESULT_LABEL[r]));
    }
    resultSel.value = resultFilter;
    resultSel.addEventListener('change', () => {
      resultFilter = resultSel.value as 'all' | ReportResult;
      api.rerender();
    });

    const aiBtn = btn({
      cls: ['kbw-btn', 'is-small', aiOnly ? 'is-primary' : 'is-ghost'],
      text: '只看 AI 建议的',
      on: {
        click: () => {
          aiOnly = !aiOnly;
          api.rerender();
        },
      },
    });

    host.appendChild(toolbar(typeSel, resultSel, aiBtn));

    const shown = rows.filter(
      (r) =>
        (typeFilter === 'all' || r.parsed.action === typeFilter) &&
        (resultFilter === 'all' || r.parsed.result === resultFilter) &&
        (!aiOnly || r.parsed.ai),
    );

    host.appendChild(group('操作日志'));
    /**
     * ⚠️ **这行是"点了筛选之后的反馈"，要用状态行**（独立审 2026-10-04 🟡）：
     * 它原先挂在 `group` 的第二参（= `.kbw-set-group-s`）里、**吃「显示说明」开关** ——
     * 折叠态下"筛出 0 条"被藏起来，用户点了筛选只看得到列表变短。
     * 8.3 的口径是"状态 / 动态行不吃开关"，这句（含下面 routes 的体检汇总）归状态行。
     */
    host.appendChild(statusLine(`共 ${rows.length} 条，筛出 ${shown.length} 条`));
    if (shown.length === 0) {
      host.appendChild(
        emptyLine(rows.length === 0 ? '还没有操作日志（动一次库就会有一条）' : '没有符合条件的日志'),
      );
      return;
    }

    for (const r of shown) {
      const row = div({ cls: 'kbw-log-row' });
      const line1 = div({ cls: 'kbw-log-line1' });
      line1.appendChild(span({ cls: 'kbw-log-time', text: formatRelativeTime(r.file.stat?.mtime ?? 0) }));
      line1.appendChild(span({ cls: 'kbw-log-act', text: r.parsed.action }));
      line1.appendChild(
        span({
          /**
           * `has-label` = **这个胶囊里有文字** → 补一个色点（P6 段⑥ 语义色收口那条规矩：
           * 「有字就有点，没字只有色」）。表格「标记」列的**短词胶囊不加点**
           * （P7.7c 拍板照稿 .flg：字形即语义、轻重的色相由淡底承担），
           * 理由写在 `styles/components.css` 那一段。
           */
          cls: [
            'kbw-flag',
            'has-label',
            r.parsed.result === 'ok' ? 'flag-green' : r.parsed.result === 'partial' ? 'flag-yellow' : 'flag-red',
          ],
          text: RESULT_LABEL[r.parsed.result],
        }),
      );
      if (r.parsed.files > 0) line1.appendChild(span({ cls: 'kbw-log-n', text: `${r.parsed.files} 篇` }));
      if (r.parsed.ai) line1.appendChild(span({ cls: 'kbw-log-ai', text: 'AI 建议' }));
      row.appendChild(line1);
      row.appendChild(div({ cls: 'kbw-log-sum', text: r.parsed.summary || r.file.basename }));
      const act = div({ cls: 'kbw-log-act-btns' });
      act.appendChild(
        smallBtn('打开', () => void ctx.app.workspace.getLeaf('tab').openFile(r.file), '在 Obsidian 里打开这篇日志'),
      );
      row.appendChild(act);
      host.appendChild(row);
    }
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

async function safeRead(ctx: WorkbenchContext, f: TFile): Promise<string> {
  try {
    return await ctx.app.vault.cachedRead(f);
  } catch {
    return '';
  }
}
