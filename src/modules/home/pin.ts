/**
 * modules/home/pin.ts —— 「钉到首页」的读写、上限与通知（P7.2d · 16.9-b）
 *
 * 数据 = `settings.homeCards`（路径表；`null` = 还没钉过 —— 见 `core/settings.ts`）。
 * 入口 = 笔记右键「其他」组·「收藏」旁（`modules/notes/menus.ts`）；
 * 消费方 = 首页「钉住的笔记」块（`blocks/homecards.ts`）＋ 设置栏的重置提示。
 *
 * ⚠️ **表里存的是路径** → 改名迁键 / 删除剪枝挂在 `main.ts` 插件层那两条监听里
 * （与 `gridOrder` 同一处纪律 —— 钉选发生在「全部笔记」，那时首页没挂载）。
 */
import type { WorkbenchContext } from '../../core/context';
import { notifyInfo, notifyPartial } from '../../ui/notify';

/**
 * 钉选上限（Q2 拍板：**6 篇**）。
 * 第 7 篇 → 通知「先取消一篇」，**不顶掉旧的**（不静默动用户钉过的东西）。
 */
export const HOME_CARDS_MAX = 6;

/** 现在钉着哪几篇（没钉过 → 空表） */
export function homePins(ctx: WorkbenchContext): string[] {
  return ctx.settings.get().homeCards ?? [];
}

export function isHomePinned(ctx: WorkbenchContext, path: string): boolean {
  return homePins(ctx).includes(path);
}

/**
 * 切换钉选（右键菜单两个方向的唯一入口）。
 *
 * 三条口径：
 *  · 取消 = 从表里去掉（**不动任何笔记文件**）；
 *  · 到上限**一个字都不写**，只给通知 —— "先取消一篇"由用户自己选；
 *  · 落盘走 `settings.save`（合并 + 回读校验），首页块靠 `settings.onChange` 跟进。
 */
export function toggleHomePin(ctx: WorkbenchContext, path: string): void {
  const pins = homePins(ctx);
  if (pins.includes(path)) {
    void ctx.settings.save({ homeCards: pins.filter((p) => p !== path) });
    notifyInfo('已取消钉选', '首页「钉住的笔记」里不会再出现它');
    return;
  }
  if (pins.length >= HOME_CARDS_MAX) {
    notifyPartial(`钉选上限 ${HOME_CARDS_MAX} 篇`, '先取消一篇再钉新的 —— 不会顶掉你旧的');
    return;
  }
  void ctx.settings.save({ homeCards: [...pins, path] });
  notifyInfo('已钉到首页', `在首页「钉住的笔记」里（最多 ${HOME_CARDS_MAX} 篇）`);
}
