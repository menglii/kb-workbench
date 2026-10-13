/**
 * blocks/fav —— 收藏夹（P7.2a 新模块 M1 · G2-a 拍板：新属性「收藏」bool）
 *
 * 数据 = `收藏: true` 的笔记按 mtime 倒序取 6 篇；**一篇都没有 → 整块不画**
 * （D3「空块自动隐藏」：渲染后自报，不提前猜数据）。
 */
import type { WorkbenchContext } from '../../../core/context';
import type { NoteEntry } from '../../../core/vault-index';
import type { HomeBlock } from './index';
import { asBool } from '../../../services/schema';
import { div, el } from '../../../ui/primitives';
import { formatRelativeTime } from '../../../core/util';

/** 显示几篇 */
const FAV_N = 6;

/** 收藏的行（`收藏: true`，mtime 倒序） */
export function favNotes(ctx: WorkbenchContext): NoteEntry[] {
  return ctx.index
    .notes()
    .filter((e) => asBool(e.props['收藏']))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, FAV_N);
}

/** 收藏夹的行（与「最近改动」同一套行样式/交互：点开新标签） */
export function favRow(ctx: WorkbenchContext, e: NoteEntry): HTMLElement {
  const row = div({ cls: ['kbw-rec', 'kbw-hover-1'] });
  row.appendChild(div({ cls: 'kbw-rec-n', text: e.basename, title: e.path }));
  // v2：「领域」退役 → 右栏展示落点目录（"目录即领域"）
  row.appendChild(div({ cls: 'kbw-rec-w', text: e.effectivePosition || '—' }));
  row.appendChild(div({ cls: 'kbw-rec-t', text: e.mtime ? formatRelativeTime(e.mtime) : '—' }));
  row.addEventListener('click', () => {
    void ctx.app.workspace.getLeaf('tab').openFile(e.file);
  });
  return row;
}

export const favBlock: HomeBlock = {
  id: 'fav',
  title: '收藏夹',
  hint: '「收藏: true」的最近 6 篇（右键任意笔记可收藏）；一篇都没有时自动隐藏',
  defaultOn: false,
  paint(ctx, host) {
    const favs = favNotes(ctx);
    if (favs.length === 0) return false; // D3：没内容 → 不画
    const head = div({ cls: 'kbw-sec-head' });
    head.appendChild(el('h3', { text: '收藏夹' }));
    head.appendChild(div({ cls: 'kbw-sec-cnt', text: `${favs.length} 篇` }));
    host.appendChild(head);
    host.appendChild(div({ cls: 'kbw-rule' }));
    for (const e of favs) host.appendChild(favRow(ctx, e));
    return true;
  },
};
