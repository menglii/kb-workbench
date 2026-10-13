/**
 * ui/settings/snapshot.ts —— 设置 · **快照**栏（交互规格 §7.6）
 *
 * 列表 / 还原 / 保留策略 / 一键清理 / 显示占用 —— 与独立快照面板**共用同一份实现**
 * （`mountSnapshotList` / `pruneSnapshots`），这里只是换个地方摆：设置里想看一眼
 * "上次动库拍了多大一份"时不用跑去另一个面板。
 */
import { formatBytes } from '../../core/util';
import { btn, div } from '../primitives';
import { KEEP_COUNT, KEEP_DAYS, mountSnapshotList, openSnapshotPanel, pruneSnapshots } from '../snapshot-panel';
import { group, readRow, setTitle, statusLine, toolbar } from './kit';
import type { SectionApi, SettingsBlock } from './types';

export function makeSnapshotSection(): SettingsBlock {
  return {
    label: '快照',
    sub: '列表 · 还原 · 保留策略 · 占用',
    render(host, api) {
      paint(host, api);
    },
  };

  function paint(host: HTMLElement, api: SectionApi): void {
    const ctx = api.ctx;
    host.appendChild(
      setTitle('快照', '插件目录：.obsidian/plugins/kb-workbench/snapshots/（不进库，不污染搜索）'),
    );

    const summary = statusLine('统计中…');
    host.appendChild(
      toolbar(
        btn({
          cls: 'kbw-btn is-small is-ghost',
          text: '打开完整面板',
          on: { click: () => openSnapshotPanel(ctx) },
        }),
        btn({
          cls: 'kbw-btn is-small',
          text: `按保留策略清理（留最近 ${KEEP_COUNT} 个 / ${KEEP_DAYS} 天）`,
          on: {
            click: () => {
              void pruneSnapshots(ctx, async () => {
                await mounted.paint();
                api.rerender();
              });
            },
          },
        }),
      ),
    );
    host.appendChild(summary);

    host.appendChild(group('保留策略', '超出的会在「清理」时删掉；不点就不会自动清'));
    host.appendChild(
      readRow('保留最近', `${KEEP_COUNT} 个`, '到目前只有点「按保留策略清理」才会删 —— 平时不会自动清'),
    );
    host.appendChild(readRow('保留天数', `${KEEP_DAYS} 天`, '超过天数或超过个数的会被清理'));

    host.appendChild(group('存档', '时间倒序'));
    const list = div({ cls: 'kbw-snap-list' });
    host.appendChild(list);
    const mounted = mountSnapshotList(list, ctx, {
      onPaint: (s) => {
        summary.textContent = `当前 ${s.count} 个快照 · ${s.files} 份内容 · 共 ${formatBytes(s.bytes)}`;
      },
    });
    void mounted.paint();
  }
}
