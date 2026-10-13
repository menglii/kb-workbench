/**
 * ui/diff-box.ts —— 确认流里的**对比框**（只读展示物，走 `confirm` 的 `spec.attach` 口）
 *
 * ⚠️ **P7.16 从 `ui/beautify.ts` 原样搬出**（行为一字不改）——「修前言」面板也要给
 * "坏稿 → 修稿"摆一份对比，两个用户了，按"两处各写一份必漂"的老规矩收成一份。
 * 样式在 `styles/confirm.css` 的 `.kbw-diff-*`（早就在那儿）。
 */
import { diffLines, diffSummary, type DiffLine } from '../core/diff';
import { div, span } from './primitives';

/** 对比框（确认流里的 `spec.attach`；只读展示物） */
export function diffBox(before: string, after: string): HTMLElement {
  const lines: DiffLine[] = diffLines(before, after);
  const box = div({ cls: 'kbw-diff' });
  const { added, removed } = diffSummary(lines);
  box.appendChild(
    div({
      cls: 'kbw-diff-head',
      text: `对比（原文 ${before.split('\n').length} 行 → 新稿 ${after.split('\n').length} 行；+${added} / −${removed}）`,
    }),
  );
  const body = div({ cls: 'kbw-diff-body' });
  for (const l of lines) {
    body.appendChild(
      div(
        { cls: ['kbw-diff-line', `is-${l.kind}`] },
        span({
          cls: 'kbw-diff-mark',
          text: l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ',
        }),
        // 空行给一个不换行的空格，行高才撑得出来（CSS 是 pre-wrap）
        span({ cls: 'kbw-diff-text', text: l.text === '' ? ' ' : l.text }),
      ),
    );
  }
  box.appendChild(body);
  return box;
}
