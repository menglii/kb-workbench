/**
 * spec：P7.7 · 视觉与动效系统轮 —— **JS 侧**
 *
 * 7.7b · 动效系统（10.1）三条：
 *   ① 「减少动效」时闪一下走**静态描边**（P6b 落成、P7.7 归档成范式）——"到点消失型"
 *      动效不许靠 CSS 压 1ms（那样 animationend 当场触发、类被摘掉、**什么都看不到**）；
 *   ② 常态闪一下仍走动画路径（防"判死了"：body 上没标记/是别的值时必须回到动画）；
 *   ③ `data-motion` **镜像到 body**（P7.7 修的洞：菜单/浮层/模态/通知/撤销条都挂在
 *      body 上，只挂 `.kbw-root` 的话插件自己的「动效=减少」档对它们等于没开）。
 * 7.7c · 批 3（渲染侧）：「标记」列短词逐条 + 文件夹两态（10.5）。
 *
 * 样式侧的断言在 `redline.ts`（曲线分档 / token 纪律 / 两段 reduce 的容器清单 /
 * 稿↔实现对表 / is-danger 形态）；真机侧在探针（计算值）。这里测 JS 行为与渲染结果。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, eq, ok } from '../framework';
import * as H from '../helpers';
import { openFloating } from '../../src/ui/panel';
import { iconBtn } from '../../src/ui/primitives';
import type { HealthFlag, NoteEntry } from '../../src/core/vault-index';
import {
  FLAG_LEVEL,
  FLAG_SHORT,
  buildColumns,
  flagDetail,
  folderFlagsCell,
} from '../../src/modules/notes/columns';

export async function specP77(suite: Suite, _app: StubApp, plugin: KbWorkbenchPlugin): Promise<void> {
  const ctx = () => plugin.context();

  await suite.group('P7.7b · 动效系统（JS 侧）', async () => {
    await suite.it('减少动效：闪一下 = 静态描边（不播动画），钉 1 秒后摘掉', async () => {
      const body0 = document.body.getAttribute('data-motion');
      const h = openFloating({ title: '闪测·reduce' });
      try {
        document.body.setAttribute('data-motion', 'reduce');
        h.flash();
        ok(h.root.classList.contains('is-flash-static'), '静态描边类上身');
        ok(
          !h.root.classList.contains('is-flash'),
          '不放动画类 —— 1ms 会让 animationend 当场触发、类被立刻摘掉，等于没有反馈',
        );
        ok(
          await H.until(() => !h.root.classList.contains('is-flash-static'), 3000),
          '钉 1 秒后摘掉（用户看得见的那一秒）',
        );
      } finally {
        if (body0 === null) document.body.removeAttribute('data-motion');
        else document.body.setAttribute('data-motion', body0);
        h.close();
      }
    });

    await suite.it('常态：闪一下仍走动画路径（类上身 → 兜底定时器摘除）', async () => {
      // 前提：body 上没有 reduce 标记 —— **量了要还回去**（全量套件里这条跑在
      // specMount 之后：视图首开已经把 `system` 镜像上 body 了，裸摘会把下一条用例弄脏 ——
      // 全量首跑实测就栽在这）
      const body0 = document.body.getAttribute('data-motion');
      document.body.removeAttribute('data-motion');
      const h = openFloating({ title: '闪测·常态' });
      try {
        h.flash();
        ok(h.root.classList.contains('is-flash'), '动画类 `.is-flash` 上身');
        ok(!h.root.classList.contains('is-flash-static'), '不是静态路径');
        ok(
          await H.until(() => !h.root.classList.contains('is-flash'), 3000),
          '摘除（jsdom 不跑 CSS 动画 → 走 1200ms 兜底定时器那条腿）',
        );
      } finally {
        if (body0 === null) document.body.removeAttribute('data-motion');
        else document.body.setAttribute('data-motion', body0);
        h.close();
      }
    });

    await suite.it('data-motion 镜像：工作台里改档跟着变（经 settings.onChange → repaintAll）', async () => {
      const motion0 = ctx().settings.get().motion;
      try {
        await ctx().activate();
        await H.settle();
        const target = motion0 === 'reduce' ? 'system' : 'reduce';
        await ctx().settings.save({ motion: target });
        ok(
          await H.until(() => document.body.getAttribute('data-motion') === target, 1500),
          `改档（${motion0} → ${target}）→ body 跟着变`,
        );
        await ctx().settings.save({ motion: motion0 });
        ok(
          await H.until(() => document.body.getAttribute('data-motion') === motion0, 1500),
          '改回来也跟（body 与 root 同源，同一处 applyAppearance 写）',
        );
      } finally {
        await ctx().settings.save({ motion: motion0 });
      }
    });
  });

  await suite.group('P7.7c · 批 3（渲染侧）', async () => {
    /** 造一条 NoteEntry（纯函数层用，不碰库；抄 board.ts 那份的形） */
    const entry = (basename: string, flags: HealthFlag[], props: Record<string, unknown> = {}): NoteEntry => ({
      file: { path: `01_新知识库/09_夹具/${basename}.md`, basename } as never,
      props,
      flags,
      effectivePosition: '09_夹具',
      path: `01_新知识库/09_夹具/${basename}.md`,
      basename,
      isTemplate: false,
      mtime: 0,
      size: 10,
    });
    /** 走真列定义拿到「标记」格的渲染结果（别把 flagsCell 再抄一份） */
    const flagCell = (e: NoteEntry): HTMLElement => {
      const col = buildColumns([e]).find((c) => c.id === 'flags');
      ok(col, '列定义里有「标记」列');
      return col?.render(e) as HTMLElement;
    };
    const chipOf = (cell: HTMLElement): HTMLElement => {
      const chip = cell.querySelector<HTMLElement>('.kbw-flag');
      ok(chip, '画出了一枚胶囊');
      return chip as HTMLElement;
    };

    await suite.it('10.5 · 短词逐条：五种标记 → 错位/断链/未名/空文/外改（字形即语义）', () => {
      /**
       * 词表是**拍板件**（`P7.7c开工提示词.md` §1①写死）——逐词点名，
       * 改动任何一个词这里当场红。同时钉住「不靠颜色」：语义在**文字**上，
       * 色相只承担轻重（`title` 里仍是全句，信息不丢）。
       * ⚠️ v2（P7.12）：「缺项」随缺必填退休 —— 词表从六枚收成五枚。
       */
      const cases: Array<[HealthFlag, string, string]> = [
        ['position-mismatch', '错位', '位置不一致：属性写的是「00_Inbox」，实际在「09_夹具」'],
        ['broken-link', '断链', '指向的笔记不在库里'],
        ['placeholder-title', '未名', '标题还是「未命名」'],
        ['empty-file', '空文', '文件是 0 字节'],
        ['external-change', '外改', '别处改过，还没合并'],
      ];
      const seen = new Set<string>();
      for (const [flag, word, sentence] of cases) {
        const e = entry(flag === 'placeholder-title' ? '未命名' : '某篇', [flag], {
          文件位置: ['00_Inbox'],
        });
        const chip = chipOf(flagCell(e));
        eq(chip.textContent, word, `${flag} 的短词是「${word}」（不是 ⚠）`);
        ok(!seen.has(word), `「${word}」六词互不相同`);
        seen.add(word);
        // #7（P7.12）：悬停走 **aria-label**（平台气泡那枚）——title 不许再挂（双挂=双提示框）
        eq(chip.getAttribute('title'), null, `${flag}：title 不挂（双提示框根治）`);
        eq(chip.getAttribute('aria-label'), flagDetail(e, flag), `${flag} 的悬停仍是全句`);
        ok(
          (chip.getAttribute('aria-label') ?? '').includes(sentence),
          `${flag} 的悬停里能看到原句「${sentence}」`,
        );
        ok(!chip.classList.contains('has-label'), '短词胶囊不带色点（照稿 .flg）');
        eq(FLAG_LEVEL[flag].length > 0, true, '轻重还在（色相由 16% 淡底承担）');
        eq(FLAG_SHORT[flag], word, `FLAG_SHORT 表里 ${flag} = ${word}`);
      }
      eq(seen.size, 5, '五个短词全都验到（v2：缺项随缺必填退休）');
      /** 顺带：多枚标记并排时按 entry.flags 顺序逐枚画（顺序语义不在这条判，只钉"都在"） */
      const multi = chipOf(flagCell(entry('多标', ['position-mismatch', 'empty-file'])));
      eq(multi.textContent, '错位', '多枚时第一枚照旧');
      eq(
        flagCell(entry('多标', ['position-mismatch', 'empty-file'])).querySelectorAll('.kbw-flag').length,
        2,
        '两枚都画出来',
      );
    });

    await suite.it('顺路收四笔 · 日期列挂 .kbw-tabnum（等宽数字的挂点不悬空）', () => {
      /**
       * redline 只钉了 `styles/notes.css` 的 `.kbw-tabnum` 规则存在 —— 把 columns.ts 里
       * 包 span 那一行删掉**没有判据会红**（独立审 🟢3）。这条从渲染侧把挂点闭上：
       * 日期类列（`创建日期`，`spec.kind==='date'`）的格子里必须是个 `.kbw-tabnum`。
       */
      const e = entry('有日期', [], { 创建日期: '2026-10-05', 类型: '想法' });
      const col = buildColumns([e]).find((c) => c.id === 'prop:创建日期');
      ok(col, '列定义里有「创建日期」（date 类 schema 列）');
      const cell = col?.render(e);
      const node = typeof cell === 'string' ? null : (cell as HTMLElement | undefined);
      eq(node?.classList.contains('kbw-tabnum'), true, '日期格包了一层 .kbw-tabnum（等宽数字）');
      eq(node?.textContent, '2026-10-05', '文本原样');
      // 非日期列不包（防"全都包上"式的假达标；「类型」是纯文本列，走 string 那条）
      const ncol = buildColumns([e]).find((c) => c.id === 'prop:类型');
      const ncell = ncol?.render(e);
      eq(typeof ncell === 'string', true, '普通文本列仍是纯字符串（没被顺手包一层）');
    });

    await suite.it('10.5 · 文件夹两态：「空」/「待整理」（轻重仍按最重档 · 悬停全句保留）', () => {
      // ① 子树 0 篇 → 「空」（悬停仍是原拍板那句「文件夹里还没有笔记」）
      const emptyChip = chipOf(folderFlagsCell({ notes: 0, flagged: 0, flags: new Map() }));
      eq(emptyChip.textContent, '空', '空目录画「空」');
      ok(emptyChip.classList.contains('flag-yellow'), '空目录是黄档');
      eq(emptyChip.getAttribute('title'), null, '「空」也不挂 title（双提示根治）');
      ok(
        (emptyChip.getAttribute('aria-label') ?? '').includes('还没有笔记'),
        '悬停全句保留（信息不丢，改走 aria-label）',
      );
      // ② 有带标记的笔记 → 「待整理」，最重是红 → 红档
      const aggChip = chipOf(
        folderFlagsCell({
          notes: 5,
          flagged: 2,
          flags: new Map<HealthFlag, number>([
            ['position-mismatch', 1],
            ['empty-file', 1],
          ]),
        }),
      );
      eq(aggChip.textContent, '待整理', '聚合画「待整理」');
      ok(aggChip.classList.contains('flag-red'), '轻重按最重档（红 > 黄 > 紫）');
      eq(aggChip.getAttribute('title'), null, '「待整理」也不挂 title');
      ok(
        (aggChip.getAttribute('aria-label') ?? '').includes('2 篇需要处理') &&
          (aggChip.getAttribute('aria-label') ?? '').includes('位置不一致 ×1'),
        '悬停仍是「N 篇需要处理 + 各类条数」全句（走 aria-label）',
      );
      // ③ 都干净 → 「—」（老口径不动）
      const cleanCell = folderFlagsCell({ notes: 3, flagged: 0, flags: new Map() });
      eq(cleanCell.querySelector<HTMLElement>('.kbw-cell-empty')?.textContent, '—', '干净文件夹画「—」');
      eq(cleanCell.querySelector('.kbw-flag'), null, '干净文件夹没有胶囊');
    });

    await suite.it('#7（P7.12）· 双提示根治：图标按钮只挂 aria-label（title 一个都不挂）', () => {
      /**
       * 用户实拍（FB4-现状-8）：同一枚标记同时出**两个**提示框。根因 = `title` + `aria-label`
       * 双挂（前者原生、后者平台气泡）。口径「保留黑色那枚」= 平台气泡（aria-label）——
       * 二批 12:49 扩面到**全部 iconBtn**（快捷键表 / 刷新 / 设置那排同款），这里把源头钉住。
       */
      const b = iconBtn('search', '搜索', () => {});
      eq(b.getAttribute('title'), null, 'iconBtn 不挂 title');
      eq(b.getAttribute('aria-label'), '搜索', 'aria-label 在（平台气泡那枚）');
    });
  });
}
