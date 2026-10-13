/**
 * blocks/foot —— 底部状态（§2.5）
 *
 * **P7.2a 从 `modules/home/index.ts` 原样搬出**（行为一字不改：挂载时画一次，
 * 不订阅索引 —— "库 N 篇"刷新靠切模块回来重建，这是现状口径）。
 */
import type { HomeBlock } from './index';
import { formatRelativeTime } from '../../../core/util';
import { div, span } from '../../../ui/primitives';
import { openSnapshotPanel } from '../../../ui/snapshot-panel';

export const footBlock: HomeBlock = {
  id: 'foot',
  title: '底部状态',
  hint: '自动化运行状态 / 上次快照 / 库 N 篇',
  defaultOn: true,
  paint(ctx, host) {
    const s = ctx.store.get();
    const foot = div({ cls: 'kbw-home-foot' });
    const autoOn = s.modules.automation;
    const a = span({ cls: ['kbw-live', autoOn ? 'is-on' : 'is-off'] });
    foot.appendChild(a);
    foot.appendChild(
      span({
        cls: ['kbw-home-foot-item', 'kbw-hover-1'],
        text: autoOn ? '自动化运行中' : '自动化已停止',
        attr: { role: 'button', tabindex: '0' },
        on: { click: () => ctx.openWorkbenchSettings() },
      }),
    );
    foot.appendChild(span({ cls: 'kbw-home-foot-sep', text: '·' }));
    foot.appendChild(
      span({
        cls: ['kbw-home-foot-item', 'kbw-hover-1'],
        text:
          s.lastSnapshotAt != null ? `上次快照 ${formatRelativeTime(s.lastSnapshotAt)}` : '还没有快照',
        attr: { role: 'button', tabindex: '0' },
        on: { click: () => openSnapshotPanel(ctx) },
      }),
    );
    foot.appendChild(span({ cls: 'kbw-home-foot-sep', text: '·' }));
    foot.appendChild(span({ cls: 'kbw-home-foot-item', text: `库 ${ctx.index.notes().length} 篇` }));
    host.appendChild(foot);
    return true;
  },
};
