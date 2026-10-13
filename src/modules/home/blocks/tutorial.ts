/**
 * blocks/tutorial —— **新手清单**（P7.2d · 16.13；M8 教程卡片升级）
 *
 * 四步**动作点置位**（做过就记，不改）：
 *   ① 走完首次向导（读 `wizardDone` 三态）② 建过第一篇笔记 ③ 切过一次视图 / 进过看板
 *   ④ 用过搜索 / 按过 `?`。每项的"现在打没打勾"与"点它去哪"都在
 *   `modules/home/onboarding.ts`（唯一真源）；**打勾的四个置位点**见该文件头注。
 *
 * 三条行为：
 *  · **全勾 → 退休**（`onboardingComplete` → `return false` 自隐）；找回 = 设置 → 首页 →
 *    「重置新手清单」（`ui/settings/home.ts`）；
 *  · 未完成的那几行**可以点**（各走既有路径 —— 不新造入口）；打勾的画删除线、不再接点击；
 *  · 「看教程」保留（2b 起落点 = 教程中心第一篇）。
 *
 * ⚠️ 退休是**派生状态**（"四步全真"当场算）而不是另存一个旗标：
 * 重置清的是 `onboarding`（第 1 项读 `wizardDone`，重置后照旧打勾 —— 向导是真走过了）。
 */
import type { WorkbenchContext } from '../../../core/context';
import type { OnboardingId } from '../../../core/settings';
import type { HomeBlock } from './index';
import { btn, div, span } from '../../../ui/primitives';
// P7.10：`openTutorialCenter` 搬去了 `ui/tutorial.ts`（new-note 也要用，留在 help 会成环）
import { openTutorialCenter } from '../../../ui/tutorial';
import { openNewNoteDialog } from '../../../ui/new-note';
import { onboardingComplete, onboardingDone } from '../onboarding';

/** 清单一项（UI 层在这一块 —— 旗标层在 `../onboarding.ts`，那层不 import ui 组件防成环） */
interface OnboardingItem {
  /** 旗标 id；`wizard` 特殊：不落 `onboarding`，读 `wizardDone` 三态（见 onboarding.ts 头注） */
  id: 'wizard' | OnboardingId;
  label: string;
  /** 未完成时点它去哪（每一项都走**既有路径** —— 不新造入口） */
  run: (ctx: WorkbenchContext) => void;
}

/** 四项（顺序 = 界面顺序；文案与 `界面设计.html` 第 19 屏一致，改文案只改这里） */
export const ONBOARDING_ITEMS: OnboardingItem[] = [
  { id: 'wizard', label: '走完首次向导', run: (ctx) => ctx.openWizard() },
  {
    id: 'created',
    label: '建过第一篇笔记（新建 / 快捕 / 剪藏都算）',
    run: (ctx) => openNewNoteDialog(ctx),
  },
  { id: 'view', label: '切过一次视图，或进过看板', run: (ctx) => ctx.goNotes() },
  { id: 'search', label: '用过搜索，或按过 ? 看快捷键', run: (ctx) => ctx.openKeysHelp() },
];

export const tutorialBlock: HomeBlock = {
  id: 'tutorial',
  title: '新手清单',
  hint: '四步打勾（走完向导 / 建过笔记 / 切过视图或进过看板 / 用过搜索或按过 ?）；全勾自动退休，设置里可重置',
  defaultOn: false,
  paint(ctx, host) {
    const done = onboardingDone(ctx);
    if (onboardingComplete(done)) return false; // 全勾 → 退休自隐
    const card = div({ cls: 'kbw-tut' });
    card.appendChild(div({ cls: 'kbw-tut-t', text: '第一次用经纬？' }));
    const list = div({ cls: 'kbw-tut-list' });
    for (const item of ONBOARDING_ITEMS) {
      const on = done[item.id] === true;
      const row = div({ cls: ['kbw-tut-item', on ? 'is-done' : null] });
      row.appendChild(div({ cls: 'kbw-tut-box', text: on ? '✓' : '' }));
      row.appendChild(span({ cls: 'kbw-tut-lb', text: item.label }));
      if (!on) {
        // 每一项点了也走既有路径（与「看教程」同一批出口）
        row.addEventListener('click', () => item.run(ctx));
      }
      list.appendChild(row);
    }
    card.appendChild(list);
    const act = div({ cls: 'kbw-tut-act' });
    act.appendChild(
      btn({
        cls: 'kbw-btn',
        text: '看教程',
        on: { click: () => openTutorialCenter(ctx, 'start') },
      }),
    );
    card.appendChild(act);
    host.appendChild(card);
    return true;
  },
};
