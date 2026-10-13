/**
 * ui/settings/appearance.ts —— 设置 · **外观**栏（交互规格 §7.5）
 *
 * | 项 | 默认 |
 * | 密度 | 标准（表格 31px 行高） |
 * | 动效 | 跟随系统 `prefers-reduced-motion` |
 * | 打开工作台时自动收起侧栏 | 开（见 `main.ts` 的 `collapseSidebarOnOpen`） |
 * | 首页待处理已忽略项 | 可恢复 |
 *
 * 前两项写插件 `data.json`（"这台机器"的偏好），落到工作台根元素的 `data-*` 上，
 * 由 CSS 认（`styles/settings.css`）——**不在这里直接改样式**，否则"哪来的这条规则"查不清。
 *
 * 「已忽略项」是 §2.3 的功能：首页的待处理各条可以逐条忽略，**忽略了要能找回来**
 * （不然就是"东西被藏起来"），所以恢复入口放在这里。
 */
import { notifyLight } from '../notify';
import { emptyLine, group, row, segCtl, setTitle, smallBtn, switchCtl, toolbar } from './kit';
import type { SectionApi, SettingsSection } from './types';

/**
 * 首页待处理项的 id → 人话。
 * ⚠️ 与 `modules/home/todo.ts` 里 `out.push({ id: … })` 的那几个 id **一一对应**
 * （改那边记得改这里；对不上时会退化成显示 id 本身，不会错报）。
 */
const TODO_LABEL: Record<string, string> = {
  'broken-link': 'N 篇有失效双链',
  'position-mismatch': 'N 篇位置不一致',
  'external-change': 'N 篇有外部改动没合并',
  migrate: '旧规范还得再迁一趟',
  'placeholder-title': 'N 篇标题还是「未命名」',
  'empty-file': 'N 篇还没写内容', // P7.14：口径放宽到"空壳笔记"，旧文案"是空文件"跟着换
  // P7.16：「坏前言」那行（插在空文之后、收件箱之前 —— 黄档）
  'fragile-fm': 'N 篇前言里有嵌套映射',
  inbox: '收件箱有 N 篇待整理',
};

export function makeAppearanceSection(): SettingsSection {
  return {
    id: 'appearance',
    label: '外观',
    icon: 'palette',
    sub: '密度 · 动效 · 忽略项恢复',
    render(host, api) {
      paint(host, api);
    },
  };

  /**
   * ⚠️ 参数里多一个 `close`（P6 段④）：向导的重开入口要**先收面板再开向导** ——
   * 两个模态叠着时 Esc 只关最上面那个，下面的设置面板会留在屏幕上挡住后面的东西
   *（探针里"关不干净"的最常见来源）。它是 `SectionApi` 的子集，直接从那个类型取即可。
   */
  function paint(host: HTMLElement, api: Pick<SectionApi, 'ctx' | 'rerender' | 'close'>): void {
    const ctx = api.ctx;
    const s = ctx.settings.get();
    host.appendChild(setTitle('外观', '本机偏好：插件 data.json（不进库，每台设备可以不同）'));

    host.appendChild(group('密度', '只决定行有多高；显示哪些列由「全部笔记」的视图档决定'));
    host.appendChild(
      row(
        '密度',
        segCtl<'standard' | 'compact'>(
          s.density,
          [
            { value: 'standard', label: '标准（31px）' },
            { value: 'compact', label: '紧凑（26px）' },
          ],
          (v) => {
            void ctx.settings.save({ density: v }).then(() => {
              notifyLight(v === 'compact' ? '已切到紧凑' : '已切回标准');
              /**
               * 🔴 **点完要就地重画**（独立审 2026-10-04 🟡，存量小 bug）：`segCtl` 自己不移动
               * `is-on`（高亮会留在旧档），面板也不订阅 settings —— 不重画的话"点了高亮不动"，
               * 而且「问 AI」的 `currentValueOf` 会把**旧值**当当前值报给模型。（AI 栏的同类
               * 分段控件因为有重画一直是绿的 —— 两处行为要一致。）
               */
              api.rerender();
            });
          },
        ),
        '标准 = 表格 31px 行高；紧凑 = 26px',
      ),
    );

    host.appendChild(group('动效'));
    host.appendChild(
      row(
        '动效',
        segCtl<'system' | 'reduce'>(
          s.motion,
          [
            { value: 'system', label: '跟随系统' },
            { value: 'reduce', label: '减少动效' },
          ],
          (v) => {
            void ctx.settings.save({ motion: v }).then(() => {
              notifyLight(v === 'reduce' ? '已减少动效' : '已跟随系统设置');
              api.rerender(); // 同密度那枚（独立审 2026-10-04 🟡）
            });
          },
        ),
        '「减少动效」= 不管系统怎么设，工作台里都按减少处理',
      ),
    );

    host.appendChild(group('打开工作台', '工作台要横向空间：导航 152 + 目录栏 208 + 主区 ≥640 ⇒ 窗口 1000+ 才舒展'));

    host.appendChild(
      row(
        '打开工作台时自动收起侧栏',
        switchCtl(s.collapseSidebarOnOpen, (v) => {
          void ctx.settings.save({ collapseSidebarOnOpen: v }).then(() =>
            notifyLight(v ? '已开启（下次打开工作台时生效）' : '已关闭（侧栏一个字都不碰）'),
          );
        }),
        '收起的是 Obsidian 自己那个侧栏。关掉这个开关 = 从不动你的布局',
      ),
    );

    /**
     * ⚠️ **「重新运行首次向导」在 P6 第八段搬去了「帮助」栏**（用户第 4 条：
     * "首次使用向导别放外观里"）。三处一起改了：`settings/help.ts`（新家）·
     * `ui/wizard.ts` 的副标题 · `交互规格.md` §14.2（原来三处都写着"设置 → 外观"）。
     *
     * 为什么搬得动：向导是"带我走一遍"，与"外观（密度/动效/侧栏）"没有关系 ——
     * 它当年放这儿只是因为§14.2 随手写了那么一句。搬家的依据是**语义**，不是习惯。
     */
    host.appendChild(group('首页待处理 · 已忽略', '被忽略的条目不再出现在首页；这里可以把它们放回来'));
    const dismissed = s.homeDismissed;
    if (dismissed.length === 0) {
      host.appendChild(emptyLine('没有忽略过任何条目'));
      return;
    }
    for (const id of dismissed) {
      host.appendChild(
        row(
          TODO_LABEL[id] ?? id,
          smallBtn('恢复', () => {
            const next = ctx.settings.get().homeDismissed.filter((x) => x !== id);
            void ctx.settings.save({ homeDismissed: next }).then(() => {
              notifyLight(`已恢复「${TODO_LABEL[id] ?? id}」`);
              api.rerender();
            });
          }),
          '',
        ),
      );
    }
    host.appendChild(
      toolbar(
        smallBtn('全部恢复', () => {
          void ctx.settings.save({ homeDismissed: [] }).then(() => {
            notifyLight(`已恢复 ${dismissed.length} 条`);
            api.rerender();
          });
        }),
      ),
    );
  }
}
