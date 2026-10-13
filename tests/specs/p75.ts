/**
 * spec：P7.5 · 设置体检轮（8.1 全面体检 ＋ 8.3 `.kbw-set-hint` 拆类名）
 *
 * 这一轮是"一批小修 + 一次拆分"，判据按它们各自要看的**现象**分三组：
 *   A. **文案体检**（8.1-C 的机制化）：七栏全渲染一遍，扫内部代号 / Markdown 记号 /
 *      类名泄漏 —— P6⑤ 人眼清过一遍、P7.3c 又漏 2 处，正说明该上机制而不是人眼；
 *   B. **8.3 拆类名**：状态 / 动态行 = `.kbw-set-status`（不与说明共类名、必须在场），
 *      说明行照旧是行标签里的 `.kbw-set-hint`（收起 + title 两半判据在 automation.spec）；
 *   C. **顺手件**：M1 `cardHeight`（未物化的库上不再把 undefined 画进输入框 + 落盘不丢键）·
 *      B 搜索（**含被降级成小节说明的那句**）· C 「问 AI」带当前值且**绝不带 key**。
 *
 * ⚠️ 自己一套库（`makeTempVault('p75')`）：要真开设置面板渲染七栏（各栏读库内配置）；
 *    C 组会把 `ctx.ai.ask` 换成假实现（**绝不联网**）并临时塞一个假 key（用例自己拨回）。
 *    夹具里**没有** `06_工作台/看板配置.json` —— M1 那条要的正是"未物化"现场。
 *
 * ⚠️ **每条的起手与收尾都要 `sweep()`**（独立审 2026-10-04 🟡）：断言失败是 `throw`，
 *    收尾那句 sweep 不会执行 —— 只收尾不清场的话，一条红会以"残留面板"污染后面每一条。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import { FEATURES } from '../../src/core/settings';
import { TUTORIAL_ARTICLES } from '../../src/ui/tutorial';

/**
 * 用户可见文案的黑名单（按"历史真犯过"的形态列）：P6⑤ 清过的 12 处（反引号 / 加粗记号）、
 * P7.3c 又进的 2 处（`**`）、8.1 体检与独立审查出的期号 / 键名 / 节号引用、反引号。
 * 判据扫的是**渲染出来的文本**（含被收起的说明与 `title`）—— 用户一摊开就能看见的那一层。
 */
const BAD: { name: string; re: RegExp }[] = [
  { name: 'Markdown 加粗记号（**）', re: /\*\*/ },
  { name: '反引号（Markdown 代码记号）', re: /`/ },
  { name: '内部键名（modules.xxx）', re: /modules\.[a-z]/i },
  { name: 'CSS 类名泄漏（kbw-）', re: /kbw-[a-z]/ },
  {
    name: '期号 / 段号代号（P4 / C1 起 / f 期 / 第 N 段）',
    re: /\bP[0-9]+\b|\bC[0-9]+ ?起|[ef][0-9]? ?期|第 ?[0-9一二三四五六七八九十]+ ?段/,
  },
  { name: '文档节号引用（§）', re: /§/ },
];

export async function specP75(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const root = path.resolve(__dirname, '..', '..');
  /** 收干净浮层 */
  function sweep(): void {
    purgeOverlays();
    closeAllMenus();
  }
  /** 起手先收场（上一条若抛错，它的收尾 sweep 不会执行），再开设置面板到某一栏 */
  async function openPanel(id?: 'automation' | 'board' | 'home' | 'appearance' | 'ai' | 'data' | 'help'): Promise<void> {
    sweep();
    ctx().openWorkbenchSettings(id);
    await H.settle(180);
  }
  /**
   * 等到主区文本长度**连续 3 次采样不变**（异步栏的行是 `await` 读库内文件之后才画的 ——
   * 别赌固定毫秒；本文件首版 620ms 曾量到 0 枚元素）。上界 ≈ 3s。
   */
  async function waitStable(main: HTMLElement): Promise<void> {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 25; i += 1) {
      await H.settle(120);
      const n = (main.textContent ?? '').length;
      stable = n > 0 && n === last ? stable + 1 : 0;
      if (stable >= 3) return;
      last = n;
    }
  }
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  void app;

  // ════════════════════════════════════════════════════════════
  // §A · 设置面板文案体检（8.1-C 的机制化）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.5 · 设置面板文案体检（内部代号不许进用户文案）', async () => {
    await suite.it('七栏全渲染：可见文本与 title 都不含内部代号 / 记号 / 类名', async () => {
      await openPanel();
      const rail = H.q<HTMLElement>(document.body, '.kbw-set-rail');
      const tabs = H.qa<HTMLElement>(rail, '.kbw-set-tab').filter(
        (t) => !t.classList.contains('is-ghost'),
      );
      eq(tabs.length, 7, '前提：七栏都在（栏少了这条会漏检）');

      const chunks: { where: string; text: string }[] = [];
      const grab = (where: string, rootEl: HTMLElement): void => {
        chunks.push({ where, text: H.textOf(rootEl) });
        for (const el of H.qa<HTMLElement>(rootEl, '[title]')) {
          chunks.push({ where, text: el.getAttribute('title') ?? '' });
        }
      };
      // 左栏（那七项的 title 是各栏的副标题，也是用户悬停能看的）
      for (const el of H.qa<HTMLElement>(rail, '[title]')) {
        chunks.push({ where: '左栏', text: el.getAttribute('title') ?? '' });
      }
      let rowTotal = 0;
      for (const t of tabs) {
        const name = H.textOf(t);
        H.click(t);
        await H.settle(150);
        const main = H.q<HTMLElement>(document.body, '.kbw-set-main');
        await waitStable(main);
        rowTotal += H.qa<HTMLElement>(main, '.kbw-set-row').length;
        grab(name, main);
      }
      /**
       * 🔴 **扫描面前提自证**：异步栏的行没画出来时，grab 只收到标题与栏顶 sub ——
       * 黑名单扫了个空壳、eq 恒绿。行总数（七栏合计）就是"扫没扫到东西"的硬指标。
       */
      ok(rowTotal >= 25, `七栏加起来 ${rowTotal} 行（少于此数说明有栏没渲染完，体检会漏）`);

      const hits: string[] = [];
      for (const c of chunks) {
        for (const b of BAD) {
          /**
           * ⚠️ **global 报全**（每类至多 3 条）：只报"第一个命中"的话，同一栏里的
           * 第二处漏网会被盖住 —— P7.5 首跑就吃到这个亏（外观栏先报出密度行的 §，
           * 动效组 sub 的 `方案设计.md §5.7` 被吞在同一个 chunk 里，是另起 grep 才看见的）。
           * ⚠️ **flags 要带上原 regex 的**（`i` 丢了的话 `Modules.` 这类大小写变体就漏）。
           */
          const flags = b.re.flags.includes('g') ? b.re.flags : `${b.re.flags}g`;
          const re = new RegExp(b.re.source, flags);
          let m: RegExpExecArray | null;
          let shown = 0;
          while ((m = re.exec(c.text)) !== null && shown < 3) {
            const at = m.index;
            const near = c.text
              .slice(Math.max(0, at - 16), at + m[0].length + 16)
              .replace(/\s+/g, ' ');
            hits.push(`[${c.where}] ${b.name}：…${near}…`);
            shown += 1;
            if (m[0] === '') break; // 零宽匹配防死循环（本项目记过这类）
          }
        }
      }
      eq(hits.join('\n'), '', `用户可见文案里不许出现内部代号 / 记号：\n${hits.join('\n')}`);
      sweep();
    });

    await suite.it('反面自证：黑名单真的咬得住（各类样本 + 大小写变体，必须命中）', () => {
      /**
       * 🔴 **"恒绿"的两种死法都要防**：黑名单写错（正则不匹配任何东西）时上面那条
       * 永远绿。这里用**必然命中**的样本把黑名单本身验一遍 ——
       * 大小写样本专防"重建正则时丢了 `i` 标志"（独立审 2026-10-04 🟡 抓过这一手）。
       */
      const samples = [
        '（P4 生效）',
        '改它能少点麻烦（§4.3）',
        '等于**自动弹确认框**',
        'modules.completion 关着',
        'Modules.Completion 关着',
        '看 `POST /chat/completions`',
      ];
      const caught = samples.filter((s) => BAD.some((b) => b.re.test(s)));
      eq(caught.length, samples.length, `每个样本都该被黑名单咬住（实际咬住 ${caught.length}/${samples.length}）`);
    });

    await suite.it('原生设置页（简版）与 FEATURES 文案同样不带代号（独立审 F4）', () => {
      const src = stripComments(fs.readFileSync(path.join(root, 'src', 'settings-tab.ts'), 'utf8'));
      ok(
        !/meta\.round/.test(src),
        '模块开关的名字后面不许再挂期号（`（${meta.round}）` 会渲染出「自动化（P3）」）',
      );
      const hits: string[] = [];
      for (const f of Object.values(FEATURES)) {
        for (const b of BAD) {
          const m = `${f.label} ${f.desc}`.match(b.re);
          if (m) hits.push(`${f.id}：${b.name} ← 「${m[0]}」`);
        }
      }
      eq(hits.join(' | '), '', `原生设置页能读到的文案不许带代号：${hits.join(' | ')}`);
    });

    await suite.it('教程正文不含已退役口径（「只读建议」粗档 —— 独立审 F10）', () => {
      ok(TUTORIAL_ARTICLES.length >= 6, '教程篇数 ≥6（前提自证：数据为空时下一条恒绿）');
      const bad = TUTORIAL_ARTICLES.filter((a) => a.md.includes('只读建议')).map((a) => a.id);
      eq(
        bad.join(','),
        '',
        '教程里还在讲已退役的粗档开关 —— 口径换了要同步（草稿真源 = P7.2b-教程草稿.md）',
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  // §B · 8.3 拆类名（状态行独立成类）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.5 · 8.3 拆类名：状态 / 动态行独立成 `.kbw-set-status`', async () => {
    await suite.it('自动化栏：状态行是新类名（不与说明共类名）；说明行照旧在标签里 + 挂 title', async () => {
      await openPanel();
      // 首栏就是「自动化」（automation 与 routes 两块的状态行都住这儿）；
      // 轮询到"至少两枚状态行"为止 —— 别赌固定等待（子集跑实测 620ms 不够）
      const painted = await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-set-status').length >= 2,
        3000,
        60,
      );
      ok(painted, '自动化栏的状态行画出来了（前提自证：0 枚时下面全是空过的）');
      const main = H.q<HTMLElement>(document.body, '.kbw-set-main');

      const statusEls = H.qa<HTMLElement>(main, '.kbw-set-status');
      ok(statusEls.length >= 2, `至少两枚状态行（自动归位的检查状态 + 目录映射的「已同步」；实际 ${statusEls.length}）`);
      ok(
        statusEls.every((s) => !s.classList.contains('kbw-set-hint')),
        '🔴 状态行不再带说明的类名（8.3 前它们同名两用）',
      );
      ok(statusEls.some((s) => H.textOf(s).includes('已同步')), '目录映射的「已同步」在（它是状态不是解释）');
      ok(
        statusEls.some((s) => H.textOf(s).includes('检查')),
        '自动归位的「上次检查 / 还没检查过」在',
      );
      ok(
        H.qa<HTMLElement>(main, '.kbw-set-label .kbw-set-status').length === 0,
        '状态行不住在行标签里（读法与"行内说明"彻底分开 —— 搜索/问 AI 不会再把它当解释读）',
      );

      // 说明行照旧（判据本体没变：行标签里那句 + title 挂着 —— 探针还有一份真机计算值的）
      const hintEls = H.qa<HTMLElement>(main, '.kbw-set-label .kbw-set-hint');
      ok(hintEls.length > 0, '说明行照旧在行标签里（前提自证：一枚都没有时下一条会空过）');
      ok(
        hintEls.every(
          (h) =>
            (
              h.closest('.kbw-set-row')?.querySelector('.kbw-set-label-t')?.getAttribute('title') ?? ''
            ) !== '',
        ),
        '每行说明都还挂在行标签的 title 上（收起 ≠ 删掉）',
      );
      sweep();
    });

    await suite.it('数据栏：快照那块「统计中… / 当前 N 个快照」与日志的「筛出 N 条」都是状态行', async () => {
      await openPanel('data');
      const okPaint = await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-set-status').length >= 2,
        4000,
        60,
      );
      ok(okPaint, '数据栏出现了状态行（快照统计 + 日志计数 —— 后者是独立审 F8 从收起区挪出来的）');
      const statusEls = H.qa<HTMLElement>(document.body, '.kbw-set-status');
      ok(
        statusEls.some((s) => H.textOf(s).includes('快照') || H.textOf(s).includes('统计中')),
        '快照统计那枚在（初始「统计中…」，画完变「当前 N 个快照…」）',
      );
      ok(
        statusEls.some((s) => H.textOf(s).includes('筛出')),
        '日志的「共 N 条，筛出 N 条」在明面上（不再藏进吃开关的小节说明里）',
      );
      ok(statusEls.every((s) => !s.classList.contains('kbw-set-hint')), '它们都带新类名');
      sweep();
    });
  });

  // ════════════════════════════════════════════════════════════
  // §C · 顺手件（M1 · B · C）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.5 · 顺手件：cardHeight / 搜索 / 问 AI', async () => {
    await suite.it('看板栏「卡片高度」是真数字，且改动落盘后该键还在（M1 + 独立审加固）', async () => {
      /**
       * 夹具里**没有** `06_工作台/看板配置.json` —— 正是当年的现场：`read('board')`
       * 返回默认集合，而它缺 `cardHeight` 这个键 → `undefined` 流进 `numberCtl`
       *（HTML number 输入框对非法 value 显示空串）。补进 `BOARD_VIEW_DEFAULTS` 后这里必是真数字。
       * ⚠️ 独立审加固的第二半：**落盘不丢键** —— 只钉输入框的话，`v.cardHeight ?? 0` 这种
       * 只改显示的补丁照样绿，而 `save()` 写出的 view 依旧可能没有这个键。
       */
      await openPanel('board');
      const rowOf = (label: string): HTMLElement | undefined =>
        H.qa<HTMLElement>(document.body, '.kbw-set-row').find((r) => H.textOf(r).includes(label));
      await H.until(() => rowOf('卡片高度') !== undefined, 3000, 60);
      const row = rowOf('卡片高度');
      ok(row, '有「卡片高度」这一行（前提自证）');
      const input = H.q<HTMLInputElement>(row as HTMLElement, 'input[type="number"]');
      ok(
        /^\d+$/.test(input.value),
        `输入框里要是真数字（实际「${input.value}」—— undefined 流进来时是空串）`,
      );

      // 改一下「网格间距」触发一次 save → 落盘的 view 里必须带着 cardHeight（值 0）
      const gapRow = rowOf('网格间距');
      ok(gapRow, '有「网格间距」这一行（前提自证）');
      const gapInput = H.q<HTMLInputElement>(gapRow as HTMLElement, 'input[type="number"]');
      gapInput.value = '14';
      gapInput.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settle(240);
      const file = path.join(vaultRoot, '01_新知识库', '99_Meta', '06_工作台', '看板配置.json');
      const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as { view?: Record<string, unknown> };
      eq(disk.view?.gap, 14, '前提：那次改动真落盘了（gap = 14）');
      eq(
        disk.view?.cardHeight,
        0,
        '🔴 落盘的 view 里 cardHeight 在（= 0）—— 不再被 JSON.stringify 静默丢掉',
      );
      sweep();
    });

    await suite.it('搜索能命中栏顶那句「数据在哪」与**被降级成小节说明**的子块那句（B + F9）', async () => {
      /**
       * 「标签-目录映射」这句住在 routes 块的 `setTitle` sub 里 —— 合进「自动化」栏时
       * 被 `renderPart` 降级成 `.kbw-set-group-s`（独立审 F9：只收 `.kbw-set-sub` 时搜不到。
       * 它比「跟着库走」狠：后者所在块名 == 栏名、不降级，验不出这一层）。
       */
      await openPanel();
      const box = H.q<HTMLInputElement>(document.body, '.kbw-set-search');
      box.value = '标签-目录映射';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const found = await H.until(
        () =>
          H.qa<HTMLElement>(document.body, '.kbw-set-result').some((r) =>
            H.textOf(r).includes('标签-目录映射'),
          ),
        6000,
        80,
      );
      ok(found, '命中清单里该有「库内文件：…/标签-目录映射.json」那条（来自被降级的小节说明）');
      const hit = H.qa<HTMLElement>(document.body, '.kbw-set-result').find((r) =>
        H.textOf(r).includes('标签-目录映射'),
      ) as HTMLElement;
      H.click(hit);
      await H.settle(420);
      ok(
        H.textOf(H.q(document.body, '.kbw-set-main')).includes('自动归位'),
        '点它跳到了「自动化」栏（子块住那一栏）',
      );
      sweep();
    });

    await suite.it('「问 AI」的清单带当前值（开关 / 分段），且**绝不带输入框里的 key**', async () => {
      await openPanel('ai');
      await ctx().settings.save({
        ai: {
          ...ctx().settings.get().ai,
          apiKey: 'sk-test-DEADBEEF-not-a-real-key',
          baseUrl: 'https://x.example/v1',
          model: 'm',
        },
      });
      await openPanel('ai');
      const holder = ctx().ai as unknown as Record<string, unknown>;
      const original = holder.ask;
      let asked: string | null = null;
      holder.ask = async (input: { question: string }) => {
        asked = input.question;
        return { reply: '（假回答）' };
      };
      try {
        const ask = H.q<HTMLElement>(document.body, '.kbw-set-askai');
        H.click(ask);
        await H.settle(160);
        const q = String(asked ?? '');
        ok(q !== '', '「问 AI」真的问了（前提自证）');
        ok(q.includes('（当前：'), '清单里带了当前值（开关 / 分段控件的状态）');
        // AI 栏「读与搜索」的生效档是「自动」—— 分段控件的选中项要被拼进去
        ok(q.includes('（当前：自动）'), `分段控件的生效档带上了（片段：${q.slice(0, 120)}…）`);
        ok(
          !q.includes('sk-test-DEADBEEF'),
          '🔴 输入框里的 key **绝不许**进提示词（"将来有人顺手把 input.value 加进去"的回归锁）',
        );
      } finally {
        holder.ask = original;
        // 假 key 拨回（这一条自己在 finally 里恢复 —— 别留给下一条 / 下一个 spec）
        await ctx().settings.save({
          ai: { ...ctx().settings.get().ai, apiKey: '', baseUrl: '', model: '' },
        });
        sweep();
      }
    });

    await suite.it('外观栏：点了分段控件，高亮就地跟着动（独立审 F6 —— 存量小 bug）', async () => {
      /**
       * `segCtl` 自己不移动 `is-on`、面板也不订阅 settings —— 外观栏那两枚原先点完
       * **高亮留在旧档**（要切栏再回来才对），且「问 AI」会把旧值当当前值。
       * 修法 = onChange 里补 `api.rerender()`（AI 栏的同类控件一直有，故只有那边绿）。
       */
      await openPanel('appearance');
      await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-seg').length >= 2,
        2500,
        60,
      );
      const segOf = (label: string): HTMLElement | undefined =>
        H.qa<HTMLElement>(document.body, '.kbw-set-row')
          .find((r) => H.textOf(r).includes(label))
          ?.querySelector('.kbw-seg') as HTMLElement | undefined;
      const density = segOf('密度');
      ok(density, '有「密度」分段（前提自证）');
      const compact = H.qa<HTMLElement>(density as HTMLElement, '.kbw-segbtn').find((b) =>
        H.textOf(b).includes('紧凑'),
      );
      ok(compact, '有「紧凑」那一档');
      H.click(compact as HTMLElement);
      const onNow = await H.until(() => {
        const seg = segOf('密度');
        return (
          H.qa<HTMLElement>(seg as HTMLElement, '.kbw-segbtn').find(
            (b) => H.textOf(b).includes('紧凑'),
          )?.classList.contains('is-on') === true
        );
      }, 2000, 60);
      ok(onNow, '🔴 点完高亮就在「紧凑」上（不重画时它留在「标准」—— 存量 bug 的原样）');
      // 拨回标准（这条自己收场，别留给下一条）
      await ctx().settings.save({ density: 'standard' });
      sweep();
    });
  });
}
