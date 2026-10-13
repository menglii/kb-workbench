/**
 * `tests/specs/menu-helpers.ts` —— 菜单导航的小助手（P7.15 加）。
 *
 * 为什么要有它：菜单是**多级**的，而判据里"点开某一级"这件事的写法在
 * `p71c.ts` / `notes.ts` 里各写了一遍（还都踩过"子菜单项尾带 `›`、别用 `$` 锚"那条）。
 * 抽成一份，后面的用例只关心"我要点哪个标签"。
 *
 * ⚠️ 一级最多 8 项（§8.4 之二）意味着**多数动作住在二级**：
 * 笔记行菜单的形状是 `改 ›` → `属性 ›` → 各种属性…（P7.12 · R8 收的）。
 */
import * as H from '../helpers';

/** 当前挂在文档里的所有菜单项（多级菜单是**并列**挂在 body 上的，所以这里天然含各级） */
export function menuItems(): HTMLElement[] {
  return H.qa<HTMLElement>(document.body, '.kbw-menu .kbw-menu-item');
}

/** 所有菜单项的文本（出错时打出来定位用） */
export function menuLabels(): string[] {
  return menuItems().map((i) => H.textOf(i).trim());
}

/** 按"文本包含"找菜单项（子菜单项尾部带 `›`，一律用 includes/startsWith） */
export function findMenuItem(needle: string): HTMLElement | null {
  return menuItems().find((i) => H.textOf(i).includes(needle)) ?? null;
}

/** 点开一级（分组项），等你给的那一串标签**依次**点下去；任一环找不到返回 false */
export async function clickMenuPath(...path: string[]): Promise<boolean> {
  for (const label of path) {
    const item = menuItems().find((i) => H.textOf(i).trim().startsWith(label));
    if (!item) return false;
    H.click(item);
    await H.settle(80);
  }
  return true;
}
