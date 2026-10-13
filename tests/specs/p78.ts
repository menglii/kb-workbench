/**
 * spec：**P7.8 · 待处理 AI 一键**（1.5 · 交互规格 §2.3）
 *
 * 自造库（`makeTempVault('p78')`）—— 会真造 / 真改名 / 真删一篇夹具（`未命名 8.md`，
 * 每条自己收），与 P72c/P72d 同一条纪律。不碰其它组的夹具。
 *
 * 四组：
 *  ① 纯逻辑：`buildTodos` 的 `ai` 标记（只三行带）+ `parseTitles` 的清洗
 *  ② 行渲染：✦ 的有无（只画在配了 AI 的行上）+ **未配置的降级**（title 明说、点了给轻提示、不开面板）
 *  ③ 接线：✦ 点击 = 开面板并**自动落 AI 那一跳**（scope 从行来：收件箱=00_Inbox / 缺领域=全库）；
 *     未命名行 →「AI 起标题」：候选（含包裹剥离/幻觉丢弃）→ 手改 → 确认流（改名预览）
 *     → 真改名（source:'ai' 留痕）→ 撤销还原
 *  ④ 红线：AI 工具表冻结哨兵（改表 = 改契约：三处同改之后回改它；P7.21a 有意识加了三个）
 *
 * ⚠️ 清场（跨用例污染是本项目栽得最多的那一类）：`homeDismissed` / `aiKey` / `moveStats` /
 * 自造文件 —— 每条用例 finally 里原值归还；面板与菜单收尾关干净。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { buildTodos } from '../../src/modules/home/todo';
import { parseTitles } from '../../src/services/ai';
import { AI_LIMITS } from '../../src/services/ai/prompt';
import { AI_TOOL_NAMES } from '../../src/services/ai/tools';
import { openTitlePanel } from '../../src/ui/title-panel';

const KB = '01_新知识库';
/** 自造夹具：占位标题必须**字面上**匹配 `未命名 N`（`isPlaceholderTitle` 的正则），没法加前缀 */
const FIX_REL = '03_Resources/未命名 8.md';
const FIX_NEW = '探针候选甲改.md';
/** AI 分诊的靶子（见 `writeFix` 的注释：三个源都不认领的一篇） */
const AI_TARGET = '00_Inbox/__p78AI靶.md';

export async function specP78(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  async function untilEl<T>(get: () => T | null | undefined, timeoutMs = 2000): Promise<T | null> {
    const got = await H.until(() => Boolean(get()), timeoutMs);
    return got ? (get() as T) : null;
  }

  /**
   * 造一篇自用夹具（写盘 → rescan → 索引重建 —— rescan 会重建 TFile，索引必须跟着重建）。
   * ⚠️ **别拿夹具里的 Inbox 笔记当 AI 目标**：`领域` 在路由表里有落点的会被 `planRebuild`
   * 当**权威档**（prio 20）先接走 —— AI（60）永远盖不过它，AI 行根本不会出现
   *（第一版用 `00_Inbox/未命名.md` 就栽在这：面板里那行是「规则」而不是「AI」）。
   * 自造的目标：无声明、空 `领域`、无标签、名字与正文都没有关键词 —— 三个源都不认领它。
   */
  function writeFix(rel: string, text: string): void {
    fs.mkdirSync(path.join(vaultRoot, KB, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, KB, rel), text, 'utf8');
    app.vault.rescan();
    void app.metadataCache.settle();
    ctx().index.rebuild();
  }

  function rmFix(rels: string[]): void {
    for (const rel of rels) {
      try {
        fs.rmSync(path.join(vaultRoot, KB, rel), { force: true });
      } catch {
        /* 没了就算了 */
      }
    }
    app.vault.rescan();
    void app.metadataCache.settle();
    ctx().index.rebuild();
  }

  /** 激活工作台 + 切到首页（`activeModule` 是落盘的，别假设"打开就在首页"——与 p72a 同纪律） */
  async function ensureHome(): Promise<void> {
    await ctx().activate();
    await H.settle(80);
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
      H.textOf(n).includes('首页'),
    );
    if (nav && !nav.classList.contains('is-on')) {
      H.click(nav);
      await H.settle(150);
    }
  }

  /** 换一屏再回来 = 整块重画（✦ 的 title 是**画的时候**写的，摘了 key 必须重画才看得到降级态） */
  async function remountHome(): Promise<void> {
    const navOf = (label: string): HTMLElement | undefined =>
      H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) => H.textOf(n).includes(label));
    const notes = navOf('全部笔记');
    if (notes) {
      H.click(notes);
      await H.settle(150);
    }
    const home = navOf('首页');
    if (home) {
      H.click(home);
      await H.settle(200);
    }
  }

  /**
   * 把带这些措辞的待处理行挤进可见区（折叠只画前 5 条 —— 忽略掉挡在前面的行；
   * `homeDismissed` 是用户的设置，调用方 finally 里原值归还）。返回是否全部可见。
   */
  async function revealRows(needles: string[]): Promise<void> {
    for (let i = 0; i < 60; i += 1) {
      const rows = H.qa<HTMLElement>(document.body, '.kbw-todo');
      const texts = rows.map((r) => H.textOf(r));
      if (needles.every((n) => texts.some((t) => t.includes(n)))) return;
      if (rows.length === 0) {
        await H.settle(150); // 块还没画出来（预演/维护三件是异步的）
        continue;
      }
      const idx = texts.findIndex((t) => !needles.some((n) => t.includes(n)));
      if (idx < 0) return; // 可见的全是目标却还没齐 —— 交给断言报现场
      const x = rows[idx].querySelector<HTMLElement>('.kbw-todo-x');
      if (!x) return;
      H.click(x);
      await H.settle(170);
    }
  }

  async function withRevealed<T>(needles: string[], fn: () => Promise<T>): Promise<T> {
    const prev = ctx().settings.get().homeDismissed.slice();
    try {
      await ensureHome();
      await revealRows(needles);
      return await fn();
    } finally {
      closeAllMenus();
      await ctx().settings.save({ homeDismissed: prev });
      await H.settle(140);
    }
  }

  function todoRow(needle: string): HTMLElement | undefined {
    return H.qa<HTMLElement>(document.body, '.kbw-todo').find((r) => H.textOf(r).includes(needle));
  }

  /**
   * **行菜单里的「✦ AI 处理这一项」**（P7.12 · R5：行尾 ✦ 已撤，AI 入口 = 右键菜单）。
   * 走的是与用户完全同一条路：右键行 → 菜单项 → 点击。
   */
  async function clickRowAi(row: HTMLElement): Promise<void> {
    const r = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.top + 8 }),
    );
    const item = await untilEl(
      () =>
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('✦ AI 处理这一项'),
        ) ?? null,
    );
    ok(item, '行菜单里有「✦ AI 处理这一项」');
    H.click(item!);
    await H.settle(60);
  }

  /** 认"**最后**出现的那枚"（与 `currentUndoButton` / 探针 `lastModal` 同一口径：
   * 多条模态叠着时，先开的可能还没关 —— 取第一个会拿到上一条用例的那一份） */
  function modalWith(needle: string): HTMLElement | null {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal').filter((m) =>
      H.textOf(m).includes(needle),
    );
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /** 配置 AI 并在收尾时把 key 还回去 */
  async function withAi<T>(fn: () => Promise<T>): Promise<T> {
    const prevKey = ctx().settings.get().ai.apiKey;
    try {
      await H.configAi(plugin);
      return await fn();
    } finally {
      await H.configAi(plugin, { apiKey: prevKey });
      H.resetAi();
      await H.settle(120);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ① 纯逻辑
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.8 · 纯逻辑（ai 标记 + 候选名解析）', async () => {
    await suite.it('buildTodos：只两行带 ai（收件箱=classify · 未命名=title），其余不带', () => {
      const rows = buildTodos(ctx().index.notes(), '00_Inbox', {});
      const ids = rows.map((r) => r.id).join(',');
      // v2：「缺领域」行随领域退役退场（P7.12），带 ai 的只剩两行
      for (const id of ['inbox', 'placeholder-title']) {
        ok(rows.some((r) => r.id === id), `前提：${id} 行在（夹具该有）—— 现有行：${ids}`);
      }
      deepEq(
        rows
          .filter((r) => r.ai)
          .map((r) => `${r.id}:${r.ai}`)
          .sort(),
        ['inbox:classify', 'placeholder-title:title'].sort(),
        '只有这两行带 ai（位置不一致/迁移/双链等都不带）',
      );
    });

    await suite.it('parseTitles：剥书名号/引号包裹 · 非法字符判丢 · 去重 · 3 个封顶 · 散文回落', () => {
      const r = parseTitles(
        JSON.stringify({
          reply: '看了一遍',
          titles: [
            {
              path: 'a.md',
              options: ['《书名风格》', '"引号包裹"', '报告/带斜杠', '重复名', '重复名', '第五个'],
            },
            { path: 'b.md', options: [] },
            { options: ['缺路径'] },
          ],
        }),
      );
      eq(r.list.length, 1, '只有 a.md 一行成型');
      eq(r.list[0].path, 'a.md', 'path 原样');
      deepEq(
        r.list[0].options,
        ['书名风格', '引号包裹', '重复名'],
        '剥两端包裹 · 斜杠判丢 · 去重 · 封顶 3 个（第五个不进来）',
      );
      eq(r.dropped, 3, '斜杠 + 空候选 + 缺 path 各丢一条（如实计数）');
      const chat = parseTitles('（模型只回了一段话）');
      eq(chat.list.length, 0, '散文回落：没有候选');
      contains(chat.reply, '只回了一段话', '散文原样带回来当 reply');
    });

    /**
     * 🔴 **工具表冻结哨兵**：这条红了 = 有人动了工具表 —— **有意识地改**：
     * ① 改实现（`tools.ts`）→ ② 改 `AI接口冻结` §2 那张表 → ③ 改《交互规格》§11 那张表
     * ——**三处同源**，最后回改这里。
     * ⚠️ **P7.21a 有意识地加了三个**（`list` / `stats` = 只读工具族 · `ask_user` = 澄清提问）；
     * **P7.21b 又加一个 `grep`**（正文检索，三处已同步，见冻结 §2 与规格 §11 的 P7.21b 增补）；
     * **P7.22a 又加三个**（`patch_text` / `append` = 改正文（新类 `text`）· `rename` = 改名归搬动
     * —— 三处已同步，见冻结 §2 与规格 §11 的 P7.22a 增补）—— P7.8 原文那句"七个工具"从此作废。
     */
    await suite.it('AI 工具表冻结（改表 = 改契约：三处同改之后回改这里）', () => {
      deepEq(
        [...AI_TOOL_NAMES].sort(),
        [
          'append',
          'ask_user',
          'cleanup',
          'create',
          'delete',
          'grep',
          'list',
          'move',
          'patch_text',
          'read',
          'rename',
          'search',
          'set_prop',
          'set_tags',
          'stats',
          'suggest',
          'triage',
        ],
        '十七个工具，一个不多一个不少（P7.22a 加 patch_text / append / rename；P7.22b 加 suggest / triage / cleanup）',
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 行渲染：✦ 的有无 + 未配置的降级
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.8 · 行渲染（✦ 全撤 · 未配置降级）', async () => {
    await suite.it('待处理各行**都不画 ✦**（v2 · R5 拍定：AI 入口 = 右键菜单）', async () => {
      await withRevealed(
        ['有失效双链', '标题还是「未命名」', '收件箱有'],
        async () => {
          const rows = H.qa<HTMLElement>(document.body, '.kbw-todo');
          ok(rows.length >= 3, `前提：几行都在（实际 ${rows.length}）`);
          for (const r of rows) {
            /**
             * ⚠️ 独立审 B4（P7.12 收尾）：原来钉"无 `.kbw-todo-ai` 节点" —— 该类已随功能
             * 从 src 删掉，恒真。改钉**新形态**：行尾 = 动作文案 + 恰好一枚箭头
             *（R5 全撤后行上不再有 ✦；将来谁在行尾多画一枚图标，这里会红）。
             */
            const act = H.maybe<HTMLElement>(r, '.kbw-todo-act');
            ok(
              act !== null && act.querySelectorAll('svg').length === 1 && H.textOf(act).length > 0,
              `行尾 = 动作文案 + 单枚箭头（R5 全撤）：${H.textOf(r).slice(0, 40)}`,
            );
          }
        },
      );
    });

    await suite.it('未配置 AI：行菜单的「✦ AI 处理这一项」照常可点；点了给轻提示、不开面板', async () => {
      const prevKey = ctx().settings.get().ai.apiKey;
      const prevDismissed = ctx().settings.get().homeDismissed.slice();
      try {
        await H.configAi(plugin, { apiKey: '' });
        await ensureHome();
        await revealRows(['收件箱有']);
        await remountHome();
        const row = (await untilEl(() => todoRow('收件箱有'))) ?? todoRow('收件箱有');
        ok(row, '前提：收件箱行在');
        const modal0 = H.qa(document.body, '.kbw-modal').length;
        await clickRowAi(row!);
        const notice = await untilEl(() =>
          H.qa<HTMLElement>(document.body, '.kbw-notice-text').find((t) =>
            (t.textContent ?? '').includes('还没配置 AI'),
          ),
        );
        ok(notice, '点了给轻提示（不许静默什么都不发生）');
        contains(H.textOf(notice!), 'AI 助手', '提示里点名去哪配');
        eq(H.qa(document.body, '.kbw-modal').length, modal0, '不开面板');
      } finally {
        await H.configAi(plugin, { apiKey: prevKey });
        await ctx().settings.save({ homeDismissed: prevDismissed });
        await H.settle(120);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ③ 接线：行菜单「✦ AI 处理这一项」→（a）整理建议面板自动落 AI 跳（b）AI 起标题全流程
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.8 · 接线（行菜单 AI 项 → 面板落 AI 跳 · AI 起标题全流程）', async () => {
    await suite.it('行菜单「✦ AI 处理这一项」= 开整理建议面板并自动落 AI 跳（收件箱行 scope=00_Inbox；行本身不跳转）', async () => {
      writeFix(AI_TARGET, '一小段没有标题的正文，探针造的，用完会删。\n');
      await H.settle(150);
      await withRevealed(['收件箱有'], async () => {
        await withAi(async () => {
          const stats0 = ctx().settings.get().moveStats;
          try {
            // 学过往（prio 40）会盖住 AI（60）—— 清空统计，让 AI 行真看得到（探针同款）
            await ctx().settings.save({ moveStats: { tag: {}, dir: {} } });
            H.resetAi();
            const stub = H.stubAi({
              reply: '看了一遍',
              ideas: [{ path: AI_TARGET, to: '02_Areas/内容创作', why: '用例假模型' }],
            });
            const row = todoRow('收件箱有');
            ok(row, '前提：收件箱行在');
            await clickRowAi(row!);
            const modal = await untilEl(() => modalWith('整理建议'));
            ok(modal, '面板开了（菜单项的点击没冒泡成"跳到全部笔记"）');
            const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
              n.classList.contains('is-on'),
            );
            contains(H.textOf(nav ?? null), '首页', '没被行本身的点击带走去别的模块（stopPropagation）');
            const on = modal!.querySelector<HTMLElement>('.kbw-segbtn.is-on');
            eq(H.textOf(on), '收件箱', 'scope 从行来（收件箱行 = 00_Inbox）');
            /**
             * ⚠️ P7.9 · ⑥：行上的**全路径进了悬停 title** —— 认行别再拿整条路径去
             * `textOf` 里找（那条判据会永远假红）。认标题（《…》）+ AI 徽标。
             */
            const aiRow = await untilEl(() =>
              H.qa<HTMLElement>(modal!, '.kbw-suggest-row').find(
                (r) =>
                  H.textOf(r).includes('__p78AI靶') && !!r.querySelector('.kbw-suggest-src.is-ai'),
              ),
            );
            ok(
              aiRow,
              'AI 那一跳**自动**落了（没点「✦ AI 分类」按钮，AI 行自己出现）—— 现场：' +
                `模型调用 ${stub.calls.length} 次 · AI 按钮 title「${
                  modal!.querySelector('.kbw-suggest-aibtn')?.getAttribute('title') ?? ''
                }」 · 行：` +
                H.qa<HTMLElement>(modal!, '.kbw-suggest-row').map((r) => H.textOf(r)).join(' || '),
            );
            ok(fs.existsSync(path.join(vaultRoot, KB, AI_TARGET)), '只出建议表 —— 文件一字节没动');
            H.keydown(modal!, 'Escape'); // Esc 只问栈顶（面板在最上）
            await H.settle(150);
          } finally {
            await ctx().settings.save({ moveStats: stats0 });
            rmFix([AI_TARGET]);
          }
        });
      });
    });

    /**
     * ⚠️ v2（P7.12）：「缺领域行」整行退役 —— 原来那条「缺领域行的 ✦ → 落全库 AI 跳」
     * 的用例随之删除（行与 ✦ 都没了）。全库范围的 AI 跳改由整理建议面板自己的
     * 「全库」seg 覆盖（p79 面板组）。
     */
    await suite.it('（v2 记账）「缺领域」行已退役 —— 待处理不该再有它', async () => {
      const rows = buildTodos(ctx().index.notes(), '00_Inbox', {});
      ok(!rows.some((r) => r.id === 'missing-area'), 'buildTodos 里没有 missing-area 行');
    });

    await suite.it('未命名行 →「AI 起标题」全流程：候选卡选 A → 就地取名 → 确认流（改名预览）→ 真改名（留痕）→ 撤销还原', async () => {
      writeFix(FIX_REL, '这篇讲的是把整理建议接进首页待处理。\n');
      await H.settle(150);
      await withRevealed(['标题还是「未命名」'], async () => {
        await withAi(async () => {
          try {
            H.resetAi();
            H.stubAi({
              raw: JSON.stringify({
                reply: '（用例）看了一遍',
                titles: [
                  { path: FIX_REL, options: ['《探针候选甲》', '探针候选乙'] },
                  { path: '幻觉/不存在.md', options: ['乱写的'] },
                ],
              }),
            });
            const row = todoRow('标题还是「未命名」');
            ok(row, '前提：未命名行在');
            await clickRowAi(row!);
            const modal = await untilEl(() => modalWith('AI 起标题'));
            ok(modal, '「AI 起标题」面板开了');
            /**
             * P7.11 · #3：**副标题 / 提示行 / 按钮旁说明全删**（层次靠卡头与选项行立）。
             */
            eq(H.qa<HTMLElement>(modal!, '.kbw-modal-sub').length, 0, '副标题整句删除');
            eq(H.qa<HTMLElement>(modal!, '.kbw-title-hint').length, 0, '提示行退役');
            ok(H.maybe<HTMLElement>(modal!, '.kbw-modal-head .kbw-title-star'), '面板头有 ✦（accent 标识）');
            // 候选出来 = A/B 两枚选项行（《》包裹被剥 —— 断言的就是剥后的文本）
            const cardOf = (): HTMLElement | undefined =>
              H.qa<HTMLElement>(modal!, '.kbw-title-row').find((r) => H.textOf(r).includes(FIX_REL));
            const optA = await untilEl(() => {
              const c = cardOf();
              const o = c?.querySelector<HTMLElement>('.kbw-title-opt[data-key="A"]');
              return o && H.textOf(o).includes('探针候选甲') ? o : null;
            });
            ok(optA, '候选出来了 —— A 项就是候选甲（书名号包裹被剥）');
            const optB = cardOf()!.querySelector<HTMLElement>('.kbw-title-opt[data-key="B"]');
            contains(H.textOf(optB), '探针候选乙', 'B 项是第二个候选');
            // 四选项按 A/B/C/D 顺序（C=我来取名、D=看看笔记恒定）
            const keys = Array.from(cardOf()!.querySelectorAll<HTMLElement>('.kbw-title-opt')).map(
              (o) => o.dataset.key ?? '?',
            );
            deepEq(keys, ['A', 'B', 'C', 'D'], '四选项按 A/B/C/D 顺序（DOM 顺序）');
            contains(H.textOf(cardOf()!.querySelector('.kbw-title-opt[data-key="C"]')), '我来取名');
            contains(H.textOf(cardOf()!.querySelector('.kbw-title-opt[data-key="D"]')), '看看笔记');
            // 「丢弃 1 条」如实报出（P7.11 · #3：计数收进「改这 N 篇」的悬停 title）
            const runBtnOf = (): HTMLElement | undefined =>
              H.qa<HTMLElement>(modal!, '.kbw-title-bar .kbw-btn').find((b) =>
                H.textOf(b).includes('改成这'),
              );
            contains(runBtnOf()?.getAttribute('title') ?? '', '丢弃 1 条', '幻觉路径被丢——如实报出来（悬停）');
            // usage 小字：只留用量段、落**底栏右端**（P7.11 · #3；不与按钮抢焦）
            const usage = await untilEl(() => {
              const u = modal!.querySelector<HTMLElement>('.kbw-title-usage');
              return u && H.textOf(u).includes('token') ? u : null;
            });
            ok(usage, 'usage 小字在（含 token 用量段）');
            ok(
              usage!.parentElement?.classList.contains('kbw-title-bar') === true,
              'usage 落在底栏（右端 —— bar 里的最后一项）',
            );
            ok(usage!.nextElementSibling == null, 'usage 是底栏最右那一个（右端）');
            // 选 A：选中态亮起，执行名单 = 1 篇
            H.click(optA!);
            await H.settle(40);
            ok(
              cardOf()!.querySelector('.kbw-title-opt[data-key="A"]')?.classList.contains('is-on'),
              'A 选中态亮着',
            );
            contains(H.textOf(runBtnOf()), '1 篇', '选 A 之后执行名单 = 1 篇');
            // 改主意：点 C「我来取名」→ **同项就地变输入框**，敲新名（候选甲不再选中）
            const optC = cardOf()!.querySelector<HTMLElement>('.kbw-title-opt[data-key="C"]')!;
            H.click(optC);
            await H.settle(40);
            const input = cardOf()!.querySelector<HTMLInputElement>('.kbw-title-input');
            ok(input, '点 C → 该项就地变输入框');
            input!.value = '探针候选甲改';
            input!.dispatchEvent(new Event('input', { bubbles: true }));
            ok(
              !cardOf()!.querySelector('.kbw-title-opt[data-key="A"]')?.classList.contains('is-on'),
              '手敲之后 A 不再是选中态（最终以 C 的输入为准）',
            );
            contains(H.textOf(runBtnOf()), '1 篇', '仍然只有这一行定了名字');
            H.click(runBtnOf()!);
            // 确认流：逐条「旧名 → 新名」（面板自己也是 .kbw-modal —— 遍历所有模态找那一条）
            const primary = await untilEl(() => {
              for (const m of H.qa<HTMLElement>(document.body, '.kbw-modal')) {
                if (!H.textOf(m).includes('即将改')) continue;
                const b = H.qa<HTMLElement>(m, '.kbw-modal-foot .kbw-btn').find((x) =>
                  H.textOf(x).includes('改这'),
                );
                if (b) return b;
              }
              return null;
            });
            ok(primary, '确认流弹出来了');
            const planText = H.qa<HTMLElement>(document.body, '.kbw-plan-row')
              .map((r) => H.textOf(r))
              .join(' || ');
            contains(planText, '改名', '预览行有「改名」档');
            contains(planText, '未命名 8.md', '旧名在');
            contains(planText, '探针候选甲改.md', '新名在（清洗后的落盘名）');
            H.click(primary!);
            const newAbs = path.join(vaultRoot, KB, `03_Resources/${FIX_NEW}`);
            await H.until(() => fs.existsSync(newAbs));
            ok(fs.existsSync(newAbs), '真改名了（新名在）');
            ok(!fs.existsSync(path.join(vaultRoot, KB, FIX_REL)), '老名没了（成对判）');
            // 留痕：source 'ai' → 日志写「来源：AI 建议」+「这条是 AI 建议的」（§11.1 边界④）。
            // ⚠️ 只认插件自己写的文件名（`日志-<8位>-<6位>-…`，与 ai.ts 同一道筛）：
            // 夹具的日志目录里躺着**不按命名法的干扰项**和一条旧的重命名日志，
            // 按路径倒序/按措辞找都会读错文件（这话 ai.ts 的注释里已经栽过一次，我又栽了一次）。
            // 再按 `ai:true` 独有的那行认**我这条**（本轮之前没有 AI 来源的动库）。
            const logs = app.vault
              .getMarkdownFiles()
              .filter((f) => f.path.includes('05_操作日志') && /\/日志-\d{8}-\d{6}-/.test(`/${f.name}`))
              .sort((x, y) => y.path.localeCompare(x.path));
            ok(logs.length > 0, '写了操作日志');
            const logTexts = await Promise.all(logs.slice(0, 6).map((f) => app.vault.cachedRead(f)));
            const myLog = logTexts.find((t) => t.includes('**这条是 AI 建议的**')) ?? '';
            ok(
              myLog !== '',
              '日志留痕行在 —— 现场：' +
                logs
                  .slice(0, 6)
                  .map((f, i) => `${f.name}[${logTexts[i].split('\n').find((l) => l.includes('来源')) ?? ''}]`)
                  .join(' | '),
            );
            contains(myLog, '**来源**：AI 建议', '来源栏写「AI 建议」');
            contains(myLog, '探针候选甲改', '明细里看得出改成了什么名');
            // 撤销条 → 撤销 → 还原
            const undo = await untilEl(() => H.currentUndoButton('撤销'));
            ok(undo, '撤销条在');
            H.click(undo!);
            await H.until(() => fs.existsSync(path.join(vaultRoot, KB, FIX_REL)));
            ok(fs.existsSync(path.join(vaultRoot, KB, FIX_REL)), '撤销 = 快照还原，改回原名');
            ok(!fs.existsSync(newAbs), '新名没了（成对判）');
            H.keydown(modal!, 'Escape'); // 收尾：面板关掉（Esc 只问栈顶）
            await H.settle(150);
          } finally {
            rmFix([FIX_REL, `03_Resources/${FIX_NEW}`]);
            await H.settle(120);
          }
        });
      });
    });

    /**
     * P7.11 · #3：D「看看笔记」= 走**既有桥** `ctx.openNoteWindow`（P7.2d 那座）。
     * 判据口径与 p72d 的「最近改动桥」同款（spy 替身 + 数标签页）：
     * 桥在 → 收到 abs 路径、不开标签页；桥答 false → 退开标签页（看板关着那条退化口径）。
     */
    await suite.it('D · 看看笔记：走 ctx.openNoteWindow 桥（替身计一次）；桥答 false → 退开标签页', async () => {
      writeFix(FIX_REL, '这篇讲的是把整理建议接进首页待处理。\n');
      await H.settle(150);
      await withAi(async () => {
        try {
          H.resetAi();
          H.stubAi({ raw: JSON.stringify({ reply: '', titles: [] }) });
          closeAllMenus();
          const h = openTitlePanel(ctx());
          try {
            const card = await untilEl(
              () =>
                H.qa<HTMLElement>(h.body, '.kbw-title-row').find((r) =>
                  H.textOf(r).includes(FIX_REL),
                ) ?? null,
            );
            ok(card, '前提：自造那篇的卡在');
            const d = card!.querySelector<HTMLElement>('.kbw-title-opt[data-key="D"]');
            ok(d, 'D「看看笔记」在');
            const leaves = (): number =>
              (
                app as unknown as { __leaves: { view?: { getViewType?: () => string } }[] }
              ).__leaves.filter((l) => l.view?.getViewType?.() === 'markdown').length;
            const calls: string[] = [];
            const orig = ctx().openNoteWindow;
            try {
              // ① 桥在：收到 abs 路径；不开标签页
              ctx().openNoteWindow = (p: string) => {
                calls.push(p);
                return true;
              };
              const tabs0 = leaves();
              H.click(d!);
              await H.settle(80);
              deepEq(calls, [`${KB}/${FIX_REL}`], '桥收到了这一篇（库内绝对路径）');
              eq(leaves(), tabs0, '桥处理了 → 不开标签页');
              // ② 桥答 false → 退"开标签页"（与「最近改动」同口径）
              ctx().openNoteWindow = () => false;
              H.click(d!);
              await H.settle(150);
              eq(leaves(), tabs0 + 1, '桥答 false → 退开标签页');
            } finally {
              ctx().openNoteWindow = orig;
            }
          } finally {
            h.close('test');
          }
        } finally {
          rmFix([FIX_REL]);
          await H.settle(120);
        }
      });
    });

    /**
     * 🟢（P7.11 独立审补）：候选只有一项时 —— **B 缺位、字母不重排**
     *（A 在、C/D 还是 C/D）。代码按数组位取字母（`options[i]`），这条把中间态钉住。
     */
    await suite.it('候选只有一项：B 项缺位，C/D 字母不重排（A 在）', async () => {
      writeFix(FIX_REL, '这篇讲的是候选只有一项的中间态。\n');
      await H.settle(150);
      await withRevealed(['标题还是「未命名」'], async () => {
        await withAi(async () => {
          try {
            H.resetAi();
            H.stubAi({
              raw: JSON.stringify({
                reply: '',
                titles: [{ path: FIX_REL, options: ['独苗候选'] }],
              }),
            });
            const row = todoRow('标题还是「未命名」');
            ok(row, '前提：未命名行在');
            await clickRowAi(row!);
            const modal = await untilEl(() => modalWith('AI 起标题'));
            ok(modal, '面板开了');
            const card = await untilEl(() => {
              const c = H.qa<HTMLElement>(modal!, '.kbw-title-row').find((r) =>
                H.textOf(r).includes(FIX_REL),
              );
              const a = c?.querySelector<HTMLElement>('.kbw-title-opt[data-key="A"]');
              return a && H.textOf(a).includes('独苗候选') ? c : null;
            }, 4000);
            ok(card, 'A 项 = 独苗候选');
            const keys = Array.from(card!.querySelectorAll<HTMLElement>('.kbw-title-opt')).map(
              (o) => o.dataset.key ?? '?',
            );
            deepEq(keys, ['A', 'C', 'D'], 'B 缺位、C/D 字母不重排（DOM 顺序）');
            H.keydown(modal!, 'Escape');
            await H.settle(120);
          } finally {
            rmFix([FIX_REL]);
            await H.settle(120);
          }
        });
      });
    });

    /**
     * 🔴1 回归（独立审）：指令集硬拦在**建行时本地判** —— 不许等 AI 回话才有。
     * 原实现只在 AI 成功回话、且那篇在上限之内时才禁用；AI 一报错（断网 / key 失效）
     * 所有行的输入框都会放行（含指令集那篇）→ 改名照样以 source:'ai' 落盘。
     * 这里就用"AI 报错"这条最现实的路径压它：**输入框必须仍是禁用的**。
     */
    await suite.it('🔴 指令集里的占位笔记整行禁用 —— AI 报错也拦得住（独立审 🔴1 回归）', async () => {
      const protRel = '99_Meta/03_AI指令集/未命名 5.md';
      writeFix(protRel, '指令集里的占位笔记（这条流水线不许碰它）。\n');
      await H.settle(150);
      await withAi(async () => {
        try {
          H.resetAi();
          H.stubAi({ status: 500 }); // 模型这一跳直接失败
          closeAllMenus();
          const h = openTitlePanel(ctx());
          try {
            const rowEl = await untilEl(() =>
              H.qa<HTMLElement>(h.body, '.kbw-title-row').find((r) => H.textOf(r).includes(protRel)),
            );
            ok(rowEl, '前提：指令集那篇出现在面板里');
            /**
             * P7.11 · #3：卡片化之后"禁用"的形态 = **整卡只剩一行理由**（没有 A/B/C/D，
             * 也就没有可敲的输入框）——判据从"输入框 disabled"换成结构判据。
             */
            const noInput = (): boolean => rowEl!.querySelector('.kbw-title-input') == null;
            ok(noInput(), '🔴 没有可敲的输入框（不依赖 AI 回话）');
            contains(H.textOf(rowEl!), '只能读', '写明理由');
            eq(
              rowEl!.querySelectorAll('.kbw-title-opt').length,
              0,
              '被拦的卡不画选项（A/B/C/D 一个都没有）',
            );
            // 等 AI 的错误落地之后再看一眼：仍然是禁用的（不是"回话前禁用、回话后放行"）
            await H.settle(400);
            ok(noInput(), 'AI 报错落地后仍然禁用');
          } finally {
            h.close('test');
          }
        } finally {
          rmFix([protRel]);
          await H.settle(120);
        }
      });
    });

    /**
     * 🟡2 回归（独立审）：超过一轮上限的笔记，措辞要如实 ——
     * 「没让 AI 看它」≠「AI 没给候选」（上限 `AI_LIMITS.titleNotes` 截出来的那几篇，
     * 说成后者会把用户引向"再点一次试试"的错误方向）。
     */
    await suite.it('🟡 超过一轮上限的笔记：如实说「没让 AI 看它」，且输入框照常可用（独立审 🟡2 回归）', async () => {
      const rels: string[] = [];
      for (let i = 1; i <= AI_LIMITS.titleNotes + 1; i += 1) {
        rels.push(`03_Resources/未命名 9${String(i).padStart(2, '0')}.md`);
      }
      for (const rel of rels) {
        fs.mkdirSync(path.join(vaultRoot, KB, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(vaultRoot, KB, rel), '探针造的占位笔记，用完会删。\n', 'utf8');
      }
      app.vault.rescan();
      void app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(150);
      await withAi(async () => {
        try {
          H.resetAi();
          H.stubAi({ raw: JSON.stringify({ reply: '', titles: [] }) }); // 模型一个候选都不给
          closeAllMenus();
          const h = openTitlePanel(ctx());
          try {
            // ⚠️ 夹具里本来还有几篇占位笔记 —— 期望数从**索引现取**，别只数自造的 21 篇
          const totalPlaceholders = ctx()
            .index.notes()
            .filter((x) => !x.isTemplate && x.flags.includes('placeholder-title')).length;
          const rowsEl = await untilEl(() => {
              const all = H.qa<HTMLElement>(h.body, '.kbw-title-row');
              return all.length === totalPlaceholders ? all : null;
            });
            ok(
              rowsEl,
              `前提：面板列全（期望 ${totalPlaceholders} 篇［自造 21 + 夹具若干］）`,
            );
            // ⚠️ 行是**立刻**画出来的，措辞要等 AI 回话落地 —— 轮询到那一刻再数
            //（第一版行数一够就数，AI 还在飞，量到 0 —— 假红）
            await H.until(
              () =>
                H.qa<HTMLElement>(h.body, '.kbw-title-row').filter((r) =>
                  H.textOf(r).includes('没让 AI 看它'),
                ).length === totalPlaceholders - AI_LIMITS.titleNotes,
            );
            const unfed = H.qa<HTMLElement>(h.body, '.kbw-title-row').filter((r) =>
              H.textOf(r).includes('没让 AI 看它'),
            );
            eq(
              unfed.length,
              totalPlaceholders - AI_LIMITS.titleNotes,
              `正好 ${totalPlaceholders} - ${AI_LIMITS.titleNotes} 篇超出上限，措辞如实`,
            );
            ok(
              unfed[0]?.querySelector<HTMLElement>('.kbw-title-opt[data-key="C"]') != null,
              '超出上限 ≠ 被拦：C「我来取名」照常在（只是这轮 AI 没看它）',
            );
            const fedRow = H.qa<HTMLElement>(h.body, '.kbw-title-row').find((r) =>
              H.textOf(r).includes('AI 没给候选'),
            );
            ok(fedRow !== undefined, '其余行说的是「AI 没给候选」（模型真没给）');
          } finally {
            h.close('test');
          }
        } finally {
          rmFix(rels);
          await H.settle(120);
        }
      });
    });
  });
}
