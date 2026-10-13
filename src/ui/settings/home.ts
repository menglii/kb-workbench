/**
 * ui/settings/home.ts —— 设置 · **首页**栏（P7.2a §1.2）
 *
 * | 项 | 说明 |
 * |---|---|
 * | 区块开关 | 首页内部的 8 个区块（五老块 + 收藏夹/随机漫步/教程卡片），默认 = 五开三关 |
 * | ↑↓ | 排序（**键盘/触屏可达**；桌面更顺手的是首页上直接拖 —— 两处同源落盘） |
 * | 全部恢复默认 | 显隐与顺序一起回到"五块全开 + 新模块关" |
 *
 * 🔴 **两层开关的分界**（本栏第一句就写清，防混淆是点名要求）：
 * · **Obsidian 设置 → 经纬**（原生设置页）= "首页**这个模块**开不开"；
 * · **这里** = "首页**内部**有哪些区块、按什么顺序"。
 *
 * ⚠️ **ui → modules 的第二处 import**（第一处是 `ui/quick-capture.ts` →
 * `modules/board/capture.ts`，那处的注释写着"唯一一处"——P7.2a 起要改成"两处"）：
 * 本栏是"首页栏"，块清单/解析的**唯一真源**在 `modules/home/blocks`（那边才有
 * `paint` 与注册表）—— 在这里再抄一份 id/名字必漂。方向依旧**无环**：
 * 本文件 → blocks → ui/primitives，而 ui/primitives 不回头 import 设置面板。
 */
import { BLOCK_BY_ID, resolveHomeBlocks, swapNeighbor } from '../../modules/home/blocks';
import {
  onboardingComplete,
  onboardingDone,
  resetOnboarding,
} from '../../modules/home/onboarding';
import type { WorkbenchContext } from '../../core/context';
import { div } from '../primitives';
import { ghostBtn, group, note, row, setTitle, smallBtn, switchCtl, toolbar } from './kit';
import type { SectionApi, SettingsSection } from './types';

export function makeHomeSection(): SettingsSection {
  return {
    id: 'home',
    label: '首页',
    icon: 'home',
    sub: '首页内部的区块：显隐 + 顺序（本机偏好）',
    render(host, api) {
      paint(host, api);
    },
  };
}

function paint(host: HTMLElement, api: Pick<SectionApi, 'ctx' | 'rerender'>): void {
  const ctx = api.ctx;
  host.appendChild(
    setTitle(
      '首页',
      '这里是「首页内部有哪些区块、按什么顺序」。整个「首页」模块的开关在 Obsidian 设置 → 经纬 里 —— 两层分开，别混。',
    ),
  );
  host.appendChild(
    group('区块', '桌面更顺手：回首页悬停任意区块 → 拖动柄。这里的 ↑↓ 给键盘与触屏用，两处落的是同一份偏好'),
  );

  const r = resolveHomeBlocks(ctx.settings.get().homeBlocks);
  r.order.forEach((id, at) => {
    const block = BLOCK_BY_ID[id];
    if (!block) return;
    const shown = !r.hidden.has(id);
    const ctl = div({ cls: 'kbw-set-ctl-row' });
    ctl.appendChild(switchCtl(shown, (v) => toggleBlock(ctx, api, id, v)));
    const up = smallBtn('↑', () => moveBlock(ctx, api, id, -1), '上移一位');
    const down = smallBtn('↓', () => moveBlock(ctx, api, id, 1), '下移一位');
    if (at === 0) {
      up.disabled = true;
      up.title = '已经是最上面一块';
    }
    if (at === r.order.length - 1) {
      down.disabled = true;
      down.title = '已经是最下面一块';
    }
    ctl.appendChild(up);
    ctl.appendChild(down);
    host.appendChild(row(block.title, ctl, block.hint));
  });

  host.appendChild(
    toolbar(
      ghostBtn('全部恢复默认', () => {
        // null = "还没动过" —— 归位到注册表默认（五老块全开 + 新模块关 + 默认顺序）
        void ctx.settings.save({ homeBlocks: null }).then(() => api.rerender());
      }),
    ),
  );
  host.appendChild(
    note(
      '「恢复默认」= 五老块全开、后来加的五个块关、按默认顺序。这份偏好落在本机的 data.json（不进库、不跟着同步）。',
    ),
  );

  // ── 新手清单（P7.2d · 16.13）────────────────────────────────
  host.appendChild(
    group('新手清单', '「新手清单」卡片全勾之后会自己退休（自隐）；想再走一轮，从这里重置'),
  );
  const doneAll = onboardingComplete(onboardingDone(ctx));
  const resetBtn = ghostBtn('重置新手清单', () => {
    resetOnboarding(ctx);
    api.rerender();
  });
  resetBtn.disabled = !doneAll;
  resetBtn.title = doneAll
    ? '清空打勾 —— 卡片会回到首页，可以再走一轮'
    : '四步全做完之后才能重置（走完向导 / 建过笔记 / 切过视图或进过看板 / 用过搜索或按过 ?）';
  host.appendChild(toolbar(resetBtn));
  host.appendChild(
    note('重置只清打勾（「走完向导」那项照旧打勾 —— 向导是真走过了）；它不动上面的区块开关。'),
  );
}

function toggleBlock(
  ctx: WorkbenchContext,
  api: Pick<SectionApi, 'rerender'>,
  id: string,
  on: boolean,
): void {
  const r = resolveHomeBlocks(ctx.settings.get().homeBlocks);
  const hidden = on ? [...r.hidden].filter((x) => x !== id) : [...r.hidden, id];
  void ctx.settings.save({ homeBlocks: { order: r.order, hidden } }).then(() => api.rerender());
}

function moveBlock(
  ctx: WorkbenchContext,
  api: Pick<SectionApi, 'rerender'>,
  id: string,
  dir: -1 | 1,
): void {
  const r = resolveHomeBlocks(ctx.settings.get().homeBlocks);
  // ⚠️ 设置栏的邻居 = **全部块**（隐藏的也画在这张列表里，越得过去）；
  // 首页 ⋯ 菜单那边用的是"可见邻居"——两处口径不同是刻意的（用户看到什么就换什么）
  const next = swapNeighbor(r.order, id, dir, r.order);
  if (next.join('|') === r.order.join('|')) return;
  void ctx.settings
    .save({ homeBlocks: { order: next, hidden: [...r.hidden] } })
    .then(() => api.rerender());
}
