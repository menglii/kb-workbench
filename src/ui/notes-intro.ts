/**
 * ui/notes-intro.ts —— **首次进「全部笔记」的一次性讲解**（P7.10 · #8）
 *
 * 触发在 `modules/notes/index.ts` 的 `mount()`（`notesIntroSeen !== true` 才弹）。
 * 造型（拍板）：**居中偏右的浮层卡片** —— ≤6 条「点哪里」+ 一行指路 + 「去看教程」；
 * 解释交给教程中心，这里只报"点哪里"（极简口径）。
 *
 * 四条口径：
 *  · **只出一次**：用户关掉（「知道了」/「去看教程」/ Esc）都落 `notesIntroSeen: true`；
 *  · **不落盘的两种关法** —— `unmount`（模块卸载：那是"你离开了这一屏"，不是"你看完了"，
 *    下次进来照弹）与 `purge`（插件重载清浮层：那不是用户的动作，落盘就成了"偷偷替他关"）；
 *  · **点外面不关**（`closeOnOutside: false`）：这张卡是"读一读"，不是菜单 ——
 *    用户一边读一边把界面点着玩正是它想要的效果，点到就消失才是打扰。
 *  · 「去看教程」= 关掉本卡 + `openTutorialCenter(ctx, 'find-notes')`（找笔记那篇，
 *    与 #8 新加的两篇图文同批 —— 应的是"进阶玩法在教程中心"那句）。
 */
import type { WorkbenchContext } from '../core/context';
import { btn, div, el } from './primitives';
import { openFloating, type PanelHandle } from './panel';
import { openTutorialCenter } from './tutorial';

/**
 * 卡里的「点哪里」（≤6 条）。P7.11 · #2（批注定稿）：**按眼睛扫屏的顺序重排**
 *（左 → 上 → 右上 → 列表 → 多选）**并通俗化**（逐字照方案 §2 的表格，别再改字）。
 */
const POINTS = [
  '左边是目录树：一层一层点进去',
  '上面有搜索框和筛选，找不到就搜一下',
  '右上角能换两种看法：网格 / 详细信息',
  '双击打开一篇；F2 改名字；Delete 丢进回收站',
  '勾选几篇，顶上会变成批量操作条（迁移 / 属性 / 标签）',
];

export function showNotesIntro(ctx: WorkbenchContext, host: HTMLElement): PanelHandle {
  /**
   * 摆位 =「居中偏右」：按**模块宿主**的矩形算（工作台可用区）；量不到（0 宽高、jsdom）
   * 就退成视口比例的兜底点。偏到 60% 处 —— 左侧目录树照看得到，卡片落在列表区上。
   */
  const r = host.getBoundingClientRect?.();
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const center =
    r && r.width > 0 && r.height > 0
      ? { x: r.left + r.width * 0.6, y: r.top + Math.min(r.height * 0.42, 320) }
      : { x: vw * 0.58, y: vh * 0.4 };

  const h = openFloating({
    // P7.11 · #2：标题加问号（与向导引言「直接用 Obsidian？」同一手法）
    title: '第一次来「全部笔记」？',
    center,
    closeOnOutside: false,
    onClose: (reason) => {
      if (reason !== 'unmount' && reason !== 'purge') void ctx.settings.save({ notesIntroSeen: true });
    },
  });
  // 宽度收窄（浮层默认 max-width 520 —— 这张卡按"段"读，420 更紧凑）；样式在 notes.css
  h.root.classList.add('kbw-noteintro');

  const list = el('ul', { cls: 'kbw-noteintro-list' });
  for (const p of POINTS) list.appendChild(el('li', { text: p }));
  h.body.appendChild(list);
  h.body.appendChild(div({ cls: 'kbw-noteintro-tip', text: '进阶玩法在 设置 → 帮助 → 教程中心' }));

  h.foot.appendChild(
    btn({
      cls: 'kbw-btn is-ghost',
      text: '去看教程',
      on: {
        click: () => {
          h.close('done');
          openTutorialCenter(ctx, 'find-notes');
        },
      },
    }),
  );
  h.foot.appendChild(div({ cls: 'kbw-spacer' }));
  h.foot.appendChild(
    btn({ cls: 'kbw-btn is-primary', text: '知道了', on: { click: () => h.close('done') } }),
  );
  return h;
}
