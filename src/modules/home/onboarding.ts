/**
 * modules/home/onboarding.ts —— **新手清单**（P7.2d · 16.13）的**旗标层唯一真源**
 *
 * 四项 = **动作点置位**（做过就记，不改；"做过 ≠ 现在存在"——建过的笔记被删了
 * 也照样算做过，不扫库状态）。全勾 → 卡片退休（清单块 paint 返回 false 自隐）。
 *
 * | 项 id | 打勾判据 | 置位点（动作发生时） |
 * |---|---|---|
 * | `wizard` | `settings.wizardDone === true`（**不进** `onboarding` 数组） | `ui/wizard.ts` 保存 true 时 |
 * | `created` | `onboarding` 含 `created` | 新建对话框 / 快捕 / 剪藏 任一成功 |
 * | `view` | 含 `view` | 视图档切换（notes）/ 看板模块挂载 |
 * | `search` | 含 `search` | 搜索输入开始 / 首页搜索提交 / 「?」快捷键表打开 |
 *
 * ⚠️ **第 1 项为什么不落数组**："重置新手清单"要让它**继续打勾**（向导是真走过了，
 * 没有"取消走过"这回事）—— 进了数组就会被一起清掉，那语义就错了。
 *
 * ⚠️ **四项的文案与"点了去哪"在 `blocks/tutorial.ts`**（那边是 UI 层，要 import
 * `ui/new-note` 这类东西）—— 本文件刻意**不 import 任何 ui 组件以外的模块**，
 * 免得与置位点（ui/new-note / ui/quick-capture）形成循环 import。
 */
import type { WorkbenchContext } from '../../core/context';
import type { OnboardingId } from '../../core/settings';
import { btn, div } from '../../ui/primitives';
import { openModal } from '../../ui/panel';

/** 现在打勾了哪几项（`wizard` 读三态；其余查数组）—— 清单块与设置栏都吃这一份 */
export function onboardingDone(ctx: WorkbenchContext): Record<string, boolean> {
  const st = ctx.settings.get();
  const arr = st.onboarding ?? [];
  return {
    wizard: st.wizardDone === true,
    created: arr.includes('created'),
    view: arr.includes('view'),
    search: arr.includes('search'),
  };
}

/** 四步是否全完成（**退休判据**：全勾 → 清单块自隐；「重置新手清单」按钮也按它启用） */
export function onboardingComplete(done: Record<string, boolean>): boolean {
  return done.wizard === true && done.created === true && done.view === true && done.search === true;
}

/** 三项旗标（不含向导）都记上了吗 —— 完成提示的两个入口共用这一条 */
function flagsAll(arr: readonly string[]): boolean {
  return arr.includes('created') && arr.includes('view') && arr.includes('search');
}

/**
 * **记一项动作点**（幂等：已记过就什么都不做）。
 *
 * 全勾那一瞬弹一次「完成提示」（`announceDone`）—— 判据是"**这一次**把它补全的"：
 * 之前没齐、之后齐了。所以重开一局（重置后再完成）会**再弹一次**，这是对的。
 * 向导是最后一脚的场景由 `onboardingWizardJustFinished` 兜（那条路不进数组）。
 */
export function recordOnboarding(ctx: WorkbenchContext, id: OnboardingId): void {
  const st = ctx.settings.get();
  const arr = st.onboarding ?? [];
  if (arr.includes(id)) return;
  const next = [...arr, id];
  void ctx.settings.save({ onboarding: next });
  if (st.wizardDone === true && !flagsAll(arr) && flagsAll(next)) announceDone();
}

/**
 * **向导刚保存 `wizardDone: true` 时调**（`ui/wizard.ts`）。
 *
 * 只处理"向导是最后一脚"这一种：另外三项早齐了、向导一完成就全勾。
 * ⚠️ 调用点必须在 `save()` **之后**（save 是异步的，但这里不读 `wizardDone`，
 * 只读 `onboarding` —— 那个键没被向导动过，没有时序问题）。
 */
export function onboardingWizardJustFinished(ctx: WorkbenchContext): void {
  const arr = ctx.settings.get().onboarding ?? [];
  if (flagsAll(arr)) announceDone();
}

/**
 * 「重置新手清单」（设置 → 首页 栏）：清旗标 → 卡片回来。
 * ⚠️ **不动 `wizardDone`**（第 1 项照旧打勾，见文件头）。
 */
export function resetOnboarding(ctx: WorkbenchContext): void {
  void ctx.settings.save({ onboarding: null });
}

/**
 * 完成提示（一次性：判据在调用方 —— 只在"全勾那一瞬"调）。
 *
 * ⚠️ v2（P7.12 · #2 拍定，用户逐字定的）：
 * 标题 = 「**最后几句话**」；正文两行 = 「谢谢你体验我做的插件」/「教程可在设置中重新观看」；
 * 原来那句"想重做：设置 → 首页 →「重置新手清单」"**整段替换掉**（只留教程那一句的落点）。
 */
function announceDone(): void {
  const h = openModal({ title: '最后几句话', width: 'narrow' });
  h.body.appendChild(div({ cls: 'kbw-set-note', text: '谢谢你体验我做的插件' }));
  h.body.appendChild(div({ cls: 'kbw-set-note', text: '教程可在设置中重新观看' }));
  h.foot.appendChild(btn({ cls: 'kbw-btn is-primary', text: '好', on: { click: () => h.close('ok') } }));
}
