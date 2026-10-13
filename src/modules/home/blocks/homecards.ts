/**
 * blocks/homecards —— 钉住的笔记（P7.2d · 16.9-b）
 *
 * **两档（拍定：按看板模块开关自动切）**：
 *  · **A 行卡档**（看板关着 —— 保底）：一行一篇（名字 + 状态/落点目录 + 相对时间），
 *    点击开新标签页 —— 与「收藏夹」同款行形态；
 *  · **B 内嵌小窗档**（看板开着）：块内直接停一扇**真卡片窗**（`openEmbeddedCardWindow`），
 *    tab 条 = 钉住的几篇；正文/属性/字号与看板小窗**同一套**（含 ⚙ 里的显示选择权）。
 *
 * 空（一篇都没钉 / 钉的都不在索引里）→ **整块自隐**（`return false`，两档同一条）。
 * 数据 = `settings.homeCards`（`modules/home/pin.ts` 是读写口；改名迁键在 `main.ts`）。
 *
 * ── 生命周期（🔴 提示词点名的那条：不许留悬挂叶）────────────────
 * 内嵌窗是**块的一部分**（不是"跨模块存活的编辑现场"——与看板那边口径相反）：
 *  · 块 `cleanup(host)`（切模块 / 块重建 / 隐藏）→ `windows` 里的把手 `destroy()`
 *    → `destroyPanel`：每篇先 save 再 detach、拆壳；
 *  · Region **重画**（settings 变了）不算重建：`paint` 里拿到的是同一个宿主，
 *    走 `rehost`（同一个节点换父，编辑器不重建、不丢光标）+ `sync`。
 * ⚠️ 把手存 `WeakMap<宿主, 把手>` 而**不是模块级单例**：分屏两个工作台标签
 * 各有一份首页，两个宿主各认各的（模块级单例会被乙屏的 cleanup 把甲屏的窗收了）。
 */
import type { WorkbenchContext } from '../../../core/context';
import type { NoteEntry } from '../../../core/vault-index';
import type { HomeBlock } from './index';
import { div, el } from '../../../ui/primitives';
import { formatRelativeTime } from '../../../core/util';
import { asString } from '../../../services/schema';
import { homePins, toggleHomePin } from '../pin';
import { ensureWindowDeps, openEmbeddedCardWindow, type EmbeddedWindowHandle } from '../../board/editor';

/** 宿主元素 → 这一屏的内嵌窗把手（弱引用：块重建时旧宿主自然退场） */
const windows = new WeakMap<HTMLElement, EmbeddedWindowHandle>();

/** 行卡档的一行（与「收藏夹」同一套行样式/交互：点开新标签） */
function pinRow(ctx: WorkbenchContext, e: NoteEntry): HTMLElement {
  const row = div({ cls: ['kbw-rec', 'kbw-hover-1'] });
  row.appendChild(div({ cls: 'kbw-rec-n', text: e.basename, title: e.path }));
  const status = asString(e.props['状态']);
  // v2：「领域」退役 → 没状态时退回展示落点目录（"目录即领域"）
  row.appendChild(div({ cls: 'kbw-rec-w', text: status ? `状态：${status}` : e.effectivePosition || '—' }));
  row.appendChild(div({ cls: 'kbw-rec-t', text: e.mtime ? formatRelativeTime(e.mtime) : '—' }));
  row.addEventListener('click', () => {
    // 打开别的笔记一律新标签（`false` 会替换当前叶子 —— 当前叶子往往就是工作台）
    void ctx.app.workspace.getLeaf('tab').openFile(e.file);
  });
  return row;
}

/** 把这一屏可能停着的窗收干净（空态 / 换档 / 块收尾都走它；幂等） */
function teardown(host: HTMLElement | undefined): void {
  if (!host) return;
  const w = windows.get(host);
  if (!w) return;
  windows.delete(host);
  w.destroy();
}

export const homeCardsBlock: HomeBlock = {
  id: 'homeCards',
  title: '钉住的笔记',
  hint: '右键任意笔记「钉到首页」（最多 6 篇）；看板开着时块内直接停一扇真卡片窗，关着时行卡保底',
  defaultOn: false,
  paint(ctx, host) {
    const pins = homePins(ctx);
    // 索引里查不到的钉（刚删 / 改名还没迁完）先跳过 —— 不画死行、不开死 tab
    const entries = pins
      .map((p) => ctx.index.get(p))
      .filter((e): e is NoteEntry => Boolean(e));
    if (entries.length === 0) {
      teardown(host);
      return false; // 空 = 自隐
    }
    const head = div({ cls: 'kbw-sec-head' });
    head.appendChild(el('h3', { text: '钉住的笔记' }));
    head.appendChild(div({ cls: 'kbw-sec-cnt', text: `${entries.length} 篇` }));
    host.appendChild(head);
    host.appendChild(div({ cls: 'kbw-rule' }));

    if (!ctx.gate.isOn('board')) {
      // A 行卡档（看板关着 —— B 档的小窗能力属看板域，与「最近改动」退标签页同一条口径）
      teardown(host);
      for (const e of entries) host.appendChild(pinRow(ctx, e));
      return true;
    }

    /**
     * B 内嵌小窗档。⚠️ Region 重画会**先清空宿主**——窗根这时被摘出 DOM（没被销毁），
     * 这里把它**放回新宿主**（`rehost`，同一个节点换父，编辑器不重建）。
     */
    const winHost = div({ cls: 'kbw-hcard-win' });
    host.appendChild(winHost);
    let w = windows.get(host);
    /**
     * ⚠️ **把手先验活**（独立审 F2）：窗可能被"块外"的路收掉（别的窗把它的最后一篇搬走
     * → `destroyPanel`）—— 抱着死把手的话 rehost/sync 全是静默空转，块剩一个空框。
     * 死了就弃旧开新（新窗按同一份钉选重建，编辑器重挂一次，不丢内容）。
     */
    if (w && !w.isAlive()) {
      windows.delete(host);
      w = undefined;
    }
    if (!w) {
      w = openEmbeddedCardWindow(ensureWindowDeps(ctx), winHost, entries, {
        // 块内 tab 的 ✕ = 取消钉选（拍定）：写 homeCards → settings.onChange →
        // 块重画 → sync 把这一篇收掉。直接 closeTab 的话下一次同步又加回来（"点了没反应"）。
        onTabClose: (path) => toggleHomePin(ctx, path),
      });
      windows.set(host, w);
    } else {
      w.rehost(winHost);
    }
    w.sync(pins);
    return true;
  },
  cleanup(host) {
    teardown(host ?? undefined);
  },
};
