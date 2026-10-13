/**
 * blocks/walk —— 随机漫步（P7.2a 新模块 M4）
 *
 * 从全库（排除「隐藏: true」）**稳定伪随机**抽 3 篇；「换一批」推进种子、
 * **只重画这三行**（不碰整页 —— 计划里的原话："只换种子不重画整页"）。
 *
 * 种子是**块内瞬时状态**（模块级变量）：**切模块/重建都不会重置**，只有插件重载
 * （或自己点「换一批」）才换新的 —— 这其实是更好的行为（回来还是那三篇，
 * "随手翻翻"不会一转身就换了）。「换一批」走 `nextSeed` 一步，与 `pickRandom` 同源。
 */
import type { WorkbenchContext } from '../../../core/context';
import type { NoteEntry } from '../../../core/vault-index';
import type { HomeBlock } from './index';
import { nextSeed, pickRandom } from './index';
import { asBool } from '../../../services/schema';
import { clear, div, el, iconBtn } from '../../../ui/primitives';
import { formatRelativeTime } from '../../../core/util';

/** 一次抽几篇 */
const WALK_N = 3;

/** 种子（块内瞬时状态） */
let seed = (Date.now() % 2147483647) | 0 || 20261003;

/**
 * **漫步池**（口径拍于 2026-10-03，2a 真机截图里连抽三篇 `日志-…`，观感呆）：
 * 全库去掉三类 —— `隐藏: true` · **元数据目录之下**（元数据目录是"工作台自己的房子"：
 * 日志 / 模板 / 看板配置 / 仪表盘，都不是"可漫步的知识"）· **快照还原的 `还原保留-*`**
 * （临时挡路目录，与自动归位排除表里的同名规则同源）。
 * ⚠️ 元数据目录用**设置现算**（`metaRoot()`），用户改过目录名也跟得上；
 * 排除的只是"抽哪些"，不动索引、不动其它块。
 */
export function walkPool(ctx: WorkbenchContext): NoteEntry[] {
  const metaPrefix = `${ctx.settings.metaRoot()}/`;
  return ctx.index.notes().filter((e) => {
    if (asBool(e.props['隐藏'])) return false;
    if (e.path.startsWith(metaPrefix)) return false;
    if (e.path.split('/').some((seg) => seg.startsWith('还原保留'))) return false;
    return true;
  });
}

function walkRow(ctx: WorkbenchContext, e: NoteEntry): HTMLElement {
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

export const walkBlock: HomeBlock = {
  id: 'walk',
  title: '随机漫步',
  hint: '从全库随机抽 3 篇；「换一批」只换这三行',
  defaultOn: false,
  paint(ctx, host) {
    let pool = walkPool(ctx);
    if (pool.length === 0) return false; // 库里没笔记 → 不画（与收藏夹同一条 D3 口径）

    const head = div({ cls: 'kbw-sec-head' });
    head.appendChild(el('h3', { text: '随机漫步' }));
    /**
     * 「换一批」= **图标按钮**（P7.11 · #7b，Q4 拍板用 lucide `shuffle`；
     * `refresh-cw` 留给"重载/刷新"）。**行为一字不动**（推种子 + 只重画三行）；
     * title / aria-label 保留「换一批」（`iconBtn` 两个都写）。
     */
    const refresh = iconBtn(
      'shuffle',
      '换一批',
      () => {
        /**
         * ⚠️ 就地重画这三行 —— 不触发整页/整块的 Region 重画：
         * 从模块级引用现取池子（这一趟期间索引可能变过），重放一次 pickRandom。
         */
        seed = nextSeed(seed);
        pool = walkPool(ctx);
        renderRows();
      },
      { size: 14, cls: 'kbw-walk-refresh' },
    );
    head.appendChild(refresh);
    host.appendChild(head);
    host.appendChild(div({ cls: 'kbw-rule' }));

    const list = div({ cls: 'kbw-walk-list' });
    host.appendChild(list);
    const renderRows = (): void => {
      clear(list);
      for (const e of pickRandom(pool, seed, WALK_N)) list.appendChild(walkRow(ctx, e));
    };
    renderRows();
    return true;
  },
  /**
   * 「重载此板块」在随机漫步上 = **顺带换新三篇**（P7.11 · #8，Q5 拍板）：
   * 推一步种子，渲染循环随后强制重画 → 自然换新（与「换一批」同源）。
   */
  reload() {
    seed = nextSeed(seed);
  },
};
