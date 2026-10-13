/**
 * ui/snapshot-panel.ts —— 快照面板（交互规格 §7.6 / §10.2）
 *
 * 这是全案**唯一的安全出口**：撤销条只有 5 秒，超时之后要有一个地方能还原。
 * 三件事缺一不可：
 *   · **显示占用**（文件数 / 字节数）—— 因为 `saveData` 那条路会静默吞 ENOENT，
 *     面板上能看见"这份快照到底存了多少"是静默失败的唯一现实对策
 *   · **还原**（走确认流：还原会动文件，也会把挡路的挪去「还原保留」）
 *   · **保留策略**：最近 20 个 + 不超过 30 天（P1 用户已确认接线），可一键清理
 *
 * 快照存插件目录、**不进库**（`snapshot.ts` 走 adapter），所以这里读的是
 * `SnapshotService.list()`，不碰 vault 索引。
 */
import type { WorkbenchContext } from '../core/context';
import type { SnapshotManifest } from '../services/snapshot';
import { formatBytes, formatRelativeTime } from '../core/util';
import { btn, div } from './primitives';
import { confirm } from './confirm';
import { openModal, type PanelHandle } from './panel';
import { NOTIFY_MS, notify, notifyLight } from './notify';
import { restoreOrNotify } from './undo-bar';

/** 保留策略（交互规格 §7.6；P1 由用户拍板：最近 20 个 + 不超过 30 天） */
export const KEEP_COUNT = 20;
export const KEEP_DAYS = 30;

/**
 * 快照列表 + 还原/删除按钮。**唯一实现点**：独立面板（`openSnapshotPanel`）与
 * 设置面板的「快照」栏都调它 —— 两边各写一份的话，"还原"的安全文案会漂。
 * 返回的 `paint()` 用来刷新（还原/删除之后）。
 */
export function mountSnapshotList(
  host: HTMLElement,
  ctx: WorkbenchContext,
  opts: { onPaint?: (s: { count: number; files: number; bytes: number }) => void; initial?: SnapshotManifest[] } = {},
): { paint: () => Promise<void>; summary: () => { count: number; files: number; bytes: number } } {
  const list = host;
  let last = { count: 0, files: 0, bytes: 0 };
  /** R3（P7.12）：首帧用"备好的数据"（`openSnapshotPanel` 先读盘再开门）——用过即弃 */
  let pending = opts.initial;

  async function paint(): Promise<void> {
    while (list.firstChild) list.removeChild(list.firstChild);
    const all = pending ?? (await ctx.snapshot.list());
    pending = undefined;
    const total = all.reduce((sum, m) => sum + (m.totalBytes ?? 0), 0);
    const nFiles = all.reduce((sum, m) => sum + m.contents.length, 0);
    last = { count: all.length, files: nFiles, bytes: total };

    opts.onPaint?.(last);
    if (all.length === 0) {
      list.appendChild(div({ cls: 'kbw-snap-empty', text: '还没有快照。动库操作之前会自动拍一份。' }));
      return;
    }

    const head = div({ cls: 'kbw-snap-row is-head' });
    head.appendChild(div({ cls: 'kbw-snap-c1', text: '时间' }));
    head.appendChild(div({ cls: 'kbw-snap-c2', text: '触发操作' }));
    head.appendChild(div({ cls: 'kbw-snap-c3', text: '涉及' }));
    head.appendChild(div({ cls: 'kbw-snap-c4', text: '大小' }));
    head.appendChild(div({ cls: 'kbw-snap-c5', text: '' }));
    list.appendChild(head);

    for (const m of all) {
      const row = div({ cls: 'kbw-snap-row' });
      row.appendChild(
        div({ cls: 'kbw-snap-c1', text: formatRelativeTime(m.at), title: new Date(m.at).toLocaleString() }),
      );
      row.appendChild(div({ cls: 'kbw-snap-c2', text: m.reason || m.id, title: `${m.id}\n${m.reason}` }));
      const bits: string[] = [`${m.contents.length} 份内容`];
      if (m.moves.length > 0) bits.push(`${m.moves.length} 次移动`);
      if (m.newDirs.length > 0) bits.push(`${m.newDirs.length} 个新目录`);
      if (m.deletions.length > 0) bits.push(`${m.deletions.length} 项删除`);
      row.appendChild(div({ cls: 'kbw-snap-c3', text: bits.join(' · ') }));
      row.appendChild(div({ cls: 'kbw-snap-c4', text: formatBytes(m.totalBytes ?? 0) }));
      const act = div({ cls: 'kbw-snap-c5' });
      act.appendChild(
        btn({
          cls: 'kbw-btn is-small',
          text: '还原',
          on: {
            click: async () => {
              // 还原会动文件（挡路的会挪去「还原保留」）→ 走确认流
              const res = await confirm({
                title: `即将还原到「${m.reason || m.id}」`,
                preview: [
                  { kind: 'move', from: `${m.moves.length} 次移动`, to: '逆着搬回去', count: m.moves.length },
                ],
                warnings: [],
                notes: [
                  '挡路的文件会被挪到「还原保留-<时间戳>/」（移动，不是删除）',
                  '不在快照里的内容一律不让路',
                ],
                primary: { label: '还原' },
              });
              if (res.action !== 'primary') return;
              /**
               * ⚠️ **P7.19 收口**（独立审查 🔴1 抓到的**漏网**）：这里原来是裸
               * `const r = await ctx.snapshot.restore(m.id)` —— 它跑在一个 async 事件处理器里，
               * **reject 会逃成未捕获**（与 B1 那只虫同一个通道；本处当时没有用例覆盖，所以"全仓 20 处"
               * 数漏了它）。改走 `restoreOrNotify`：失败 → `[经纬]` warn + 轻提示、返回 `null`；
               * 成功原样回吐 `RestoreResult`（下面这几行的用法一字未动）。
               */
              const r = await restoreOrNotify(ctx.snapshot, m.id);
              if (!r) return; // 读不回来（多半已经删了）—— 已经知会过用户，别再往下走
              const done = r.movedBack + r.contentsRestored + (r.filesRemoved ?? 0);
              if (r.blocked.length > 0) {
                notify({
                  kind: 'partial',
                  text: `还原完成：${done} 项，${r.blocked.length} 项没动`,
                  detail: r.blocked.map((b) => `${b.path}：${b.why}`).slice(0, 3).join('；'),
                  ms: NOTIFY_MS.long,
                });
              } else {
                notifyLight(`已还原 ${done} 项`, r.keptAside.length > 0 ? `${r.keptAside.length} 个文件挪到了「还原保留」` : undefined);
              }
              await paint();
            },
          },
        }),
      );
      act.appendChild(
        btn({
          cls: 'kbw-btn is-small is-ghost',
          text: '删除',
          title: '只删这份快照（不影响库里的文件）',
          on: {
            click: async () => {
              const res = await confirm({
                title: '即将删除这份快照',
                preview: [{ kind: 'delete', where: '快照目录', count: 1 }],
                warnings: [],
                notes: [m.reason || m.id],
                danger: { confirmLabel: '再点一次确认', irreversible: true },
                primary: { label: '删除' },
              });
              if (res.action !== 'primary') return;
              await ctx.snapshot.remove(m.id);
              notifyLight('已删除快照');
              await paint();
            },
          },
        }),
      );
      row.appendChild(act);
      list.appendChild(row);
    }
  }

  return { paint, summary: () => ({ ...last }) };
}

/**
 * 按保留策略清理（两个入口共用：面板底部按钮 / 设置面板「快照」栏）。
 * 走确认流 —— 清理之后那些时间点就还原不回来了（§7.6）。
 */
export async function pruneSnapshots(ctx: WorkbenchContext, after?: () => Promise<void>): Promise<void> {
  const all = await ctx.snapshot.list();
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const drop = all.filter((m, i) => i >= KEEP_COUNT || m.at < cutoff);
  if (drop.length === 0) {
    notify({ kind: 'info', text: '都还在保留期内，没有可清理的', ms: NOTIFY_MS.info });
    return;
  }
  const res = await confirm({
    title: `即将清理 ${drop.length} 个旧快照`,
    preview: [{ kind: 'delete', where: '快照目录', count: drop.length }],
    warnings: [],
    notes: [`保留策略：最近 ${KEEP_COUNT} 个 + 不超过 ${KEEP_DAYS} 天`, '清理之后就还原不到这些时间点了'],
    danger: { confirmLabel: '再点一次确认', irreversible: true },
    primary: { label: `清理 ${drop.length} 个` },
  });
  if (res.action !== 'primary') return;
  const n = await ctx.snapshot.prune(KEEP_COUNT, KEEP_DAYS);
  notifyLight(`已清理 ${n} 个旧快照`);
  await after?.();
}

/**
 * R3（P7.12）：**先把数据备好再开面板** —— 原来是先 `openModal` 再 `void paint()`
 *（`paint` 里 `await list()`），用户会先看到一帧"只有外壳、列表还没画"的半成品
 *（批注实拍 FB4-二批-6）。现在 `list()` 没回来之前**不开门**，列表首帧直接用
 * 这份数据 —— 打开瞬间不存在"无列表"帧（判据在 panels.ts）。
 */
export async function openSnapshotPanel(ctx: WorkbenchContext): Promise<PanelHandle> {
  const initial = await ctx.snapshot.list();
  const h = openModal({ title: '快照', sub: '操作前自动拍的存档，可随时还原', width: 'wide' });
  const list = div({ cls: 'kbw-snap-list' });
  h.body.appendChild(list);

  const foot = h.foot;
  const pruneBtn = btn({
    cls: 'kbw-btn',
    text: `按保留策略清理（留最近 ${KEEP_COUNT} 个 / ${KEEP_DAYS} 天）`,
    on: {
      click: async () => {
        await pruneSnapshots(ctx, () => mounted.paint());
      },
    },
  });
  foot.appendChild(pruneBtn);
  foot.appendChild(btn({ cls: 'kbw-btn is-primary', text: '关闭', on: { click: () => h.close('close') } }));

  const mounted = mountSnapshotList(list, ctx, {
    initial,
    onPaint: (s) => {
      pruneBtn.setAttribute('title', `当前 ${s.count} 个快照 · ${s.files} 份内容 · ${formatBytes(s.bytes)}`);
    },
  });
  void mounted.paint();
  return h;
}
