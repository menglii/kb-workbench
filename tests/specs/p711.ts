/**
 * spec：**P7.11 · 反馈批 3（整改轮）** 的增量判据（2026-10-06）
 *
 * 自造库（`makeTempVault('p711')`）—— 会真造 / 真改名 / 真删几篇 `__p711*` 夹具
 * （每条自己收），与 p78/p79 同一条纪律。
 *
 * 覆盖面（条目号 → 断言主体）：
 *   · #4  待处理两扇菜单（P7.13b 回改：块菜单 = 「✦ 一键完全处理」**一级项**；
 *        行菜单子菜单 = ① 自动处理本条 / ② 一键完全处理 —— 「一键自动整理 + 目录列表」退役）
 *   · #10 折叠行可展开 / 收起（会话态）
 *   · #13 一键整理搬不动：两条通知的 actions 都带「✦ AI 建议」（点了开面板 + 自动 AI 跳）
 *   · #5  首页空白菜单顺序（问 AI / 重载上位 / 首页设置）；问 AI → 面板开；首页设置 → home 栏
 *   · #8  「重载此板块」（只重画该块；walk = 换新三篇）· 全局菜单重载 = ctx.reloadIndex（替身）
 *   · #9  纯界面偏好（showSettingHints）只落盘：store 不被 set / 首页块 DOM 身份不变
 *   · #12 B 类全链：AI 补声明（v2：给缺「文件位置」的笔记提落点）→ 确认流 → fm.set → 撤销还原
 *
 * ⚠️ AI 一律假传输层（绝不联网）。清场纪律照旧：自造文件 / homeDismissed / wizardDone /
 * ai key —— 每条 finally 原值归还。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { __resetNotices } from '../../src/ui/notify';
import { __resetUndo } from '../../src/ui/undo-bar';
import { openSuggestPanel } from '../../src/ui/suggest-panel';
import { runInboxTidy } from '../../src/modules/home/tidy';

const KB = '01_新知识库';

export async function specP711(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  async function untilEl<T>(get: () => T | null | undefined, timeoutMs = 2500): Promise<T | null> {
    const got = await H.until(() => Boolean(get()), timeoutMs);
    return got ? (get() as T) : null;
  }

  /** 造一篇自用夹具（写盘 → rescan → 索引重建 —— rescan 会重建 TFile，索引必须跟着重建） */
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

  /** 激活工作台 + 切到首页（`activeModule` 是落盘的，别假设"打开就在首页"） */
  async function ensureHome(): Promise<void> {
    await ctx().activate();
    await H.settle(80);
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
      H.textOf(n).includes('首页'),
    );
    if (nav && !nav.classList.contains('is-on')) {
      H.click(nav);
      await H.settle(200);
    }
  }

  const blockBox = (id: string): HTMLElement | undefined =>
    H.qa<HTMLElement>(document.body, '.kbw-hblock').find((b) => b.dataset.block === id);

  const rightClick = (el: Element): void => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
    );
  };

  /** 菜单项文本（去掉子菜单箭头的 `›` —— 它在 DOM 里是行的尾巴） */
  const menuItemTexts = (): string[] =>
    H.qa<HTMLElement>(document.body, '.kbw-menu-item').map((i) => H.textOf(i).replace('›', '').trim());

  const menuItem = (needle: string): HTMLElement | undefined =>
    H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes(needle));

  // ════════════════════════════════════════════════════════════
  // #4 待处理右键：两扇菜单（块 / 行）
  // P7.13b · #6a/#6b 回改：块菜单 AI 项升一级项「✦ 一键完全处理」；行菜单子菜单 = ①/②
  //（「一键自动整理 + 目录列表」退役 —— 范围选择已由「整理收件箱」承担，判据在 tidy.ts）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.11 · #4 待处理右键两扇菜单（P7.13b 回改）', async () => {
    await suite.it('块菜单第一层：✦ 一键完全处理置顶（P7.13b 升一级项）+ 重载此板块 + 默认四项', async () => {
      await ensureHome();
      const box = blockBox('todo');
      ok(box, '前提：todo 块在');
      try {
        rightClick(box!.querySelector('.kbw-sec-head h3') as Element);
        await H.settle(40);
        const texts = menuItemTexts();
        ok(
          texts[0]?.startsWith('✦ 一键完全处理') === true,
          `第一层置顶 = 「✦ 一键完全处理」（P7.13b · Q25。实际：${texts.join(' | ')}）`,
        );
        eq(texts[1], '重载此板块', '第二项 = 重载此板块（#8）');
        const idx = (n: string): number => texts.findIndex((t) => t.includes(n));
        ok(idx('上移一位') > 0 && idx('下移一位') > idx('上移一位'), '默认项照旧：上移 / 下移');
        ok(idx('隐藏这块') > idx('下移一位') && idx('首页设置') > idx('隐藏这块'), '隐藏这块 / 首页设置…照旧');
      } finally {
        closeAllMenus();
      }
    });

    await suite.it('「✦ 一键完全处理」是一级项**不套子菜单**（悬停不开新层；老形态退役）', async () => {
      await ensureHome();
      const box = blockBox('todo');
      ok(box, '前提：todo 块在');
      try {
        rightClick(box!.querySelector('.kbw-sec-head h3') as Element);
        await H.settle(40);
        const ai = menuItem('✦ 一键完全处理');
        ok(ai, `第一层有它（实际：${menuItemTexts().join(' | ')}）`);
        // 悬停等价物：直接派 mouseenter —— 老 AI 项（带子菜单）靠它展开；一级项应当毫无反应
        ai!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        await H.settle(80);
        eq(
          H.qa<HTMLElement>(document.body, '.kbw-menu').length,
          1,
          '悬停不开子菜单（一级项 —— Q25 拍定"不套子菜单"）',
        );
        ok(
          !menuItemTexts().some((t) => t.includes('一键自动整理')),
          '老「一键自动整理」不在这扇菜单里（能力在「整理收件箱」与 ① 里 —— Q21）',
        );
        ok(
          !menuItemTexts().some((t) => / · \d+ 篇$/.test(t)),
          '「目录列表」退役（找不到「xx · N 篇」行 —— Q21）',
        );
      } finally {
        closeAllMenus();
      }
    });

    await suite.it('行菜单「✦ AI 自动处理 ›」子菜单 = ① 自动处理本条（带行量词）+ ② 一键完全处理（恰好两项）', async () => {
      await ensureHome();
      try {
        const row = await untilEl(() => H.qa<HTMLElement>(document.body, '.kbw-todo')[0] ?? null, 4000);
        ok(row, '前提：待处理行在');
        const r = row!.getBoundingClientRect();
        // #6a 起：鼠标路径（非 0 坐标）→ 菜单开在鼠标落点；这里照真机序列派 contextmenu
        row!.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: r.left + 30,
            clientY: r.top + 10,
          }),
        );
        const ai = await untilEl(() => menuItem('✦ AI 自动处理') ?? null);
        ok(ai, `行菜单里有「✦ AI 自动处理 ›」（实际：${menuItemTexts().join(' | ')}）`);
        ai!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        /**
         * ⚠️ 从后往前找**装着目标项的那一层**（菜单是叠着的；与 probe-helpers 的 clickMore 同一条）。
         */
        const sub = await untilEl(() => {
          const all = H.qa<HTMLElement>(document.body, '.kbw-menu');
          const m = all.reverse().find((x) => H.textOf(x).includes('自动处理本条'));
          return m ?? null;
        });
        ok(sub, `子菜单开出来了（当前菜单项：${menuItemTexts().join(' | ')}）`);
        const items = H.qa<HTMLElement>(sub!, '.kbw-menu-item').map((i) => H.textOf(i));
        eq(items.length, 2, `子菜单**恰好两项**（目录列表退役 —— Q21。实际：${items.join(' | ')}）`);
        ok(items[0]?.startsWith('① 自动处理本条（') === true, `第一项 = ①（带行量词），实际「${items[0]}」`);
        ok(items[0]?.endsWith('）') === true, '① 的括号闭合（量词来自行的文案）');
        eq(items[1], '② 一键完全处理', '第二项 = ②（Q25 的文案）');
      } finally {
        closeAllMenus();
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // #10 折叠行可展开
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.11 · #10 折叠行展开', async () => {
    await suite.it('默认 5 条 + 「还有 N 项 ▸ 展开」；点开 → 全部条数可见；「收起」→ 收回', async () => {
      // 造 4 篇未命名 → 撑出折叠（配合夹具自带的几项）
      const made: string[] = [];
      for (let i = 1; i <= 4; i += 1) {
        const rel = `00_Inbox/未命名 71${i}.md`;
        writeFix(rel, '探针造（p711 fold），用完会删。\n');
        made.push(rel);
      }
      await H.settleIndex(app);
      const dismissed0 = ctx().settings.get().homeDismissed.slice();
      try {
        await ensureHome();
        await H.until(() => H.qa<HTMLElement>(document.body, '.kbw-todo').length >= 5, 4000);
        const rowsOf = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-todo');
        const restRow = (): HTMLElement | undefined =>
          H.qa<HTMLElement>(document.body, '.kbw-todo-rest').find((r) =>
            H.textOf(r).includes('还有'),
          );
        const foldRow = await untilEl(() => restRow() ?? null, 4000);
        ok(foldRow, `前提：折叠行在（当前行数 ${rowsOf().length} / 忽略 ${ctx().settings.get().homeDismissed.length}）`);
        contains(H.textOf(foldRow!), '展开', '折叠行写着「▸ 展开」');
        eq(rowsOf().length, 5, '默认只画前 5 条');
        const beforeN = rowsOf().length;
        // 点开 → 全部可见（第 6 条起也画出来、且行上有 ✕ 可用）
        H.click(foldRow!);
        await H.until(() => H.qa<HTMLElement>(document.body, '.kbw-todo').length > beforeN, 2500);
        const all = rowsOf();
        ok(all.length > beforeN, `点开后条数变多（${beforeN} → ${all.length}）`);
        ok(!restRow(), '「还有 N 项」行收起（换成「收起」）');
        const collapse = H
          .qa<HTMLElement>(document.body, '.kbw-todo-rest')
          .find((r) => H.textOf(r).includes('收起'));
        ok(collapse, '展开态有「收起 ▾」行');
        ok(
          all[5].querySelector('.kbw-todo-x') != null,
          '第 6 条起是**可用**的行（带忽略口 —— 不是死文字）',
        );
        // 收回
        H.click(collapse as Element);
        await H.until(() => H.qa<HTMLElement>(document.body, '.kbw-todo').length === beforeN, 2500);
        eq(rowsOf().length, beforeN, '再点「收起」→ 回到 5 条');
      } finally {
        closeAllMenus();
        rmFix(made);
        await ctx().settings.save({ homeDismissed: dismissed0 });
        await H.settle(150);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // #13 整理失败 → 通知里给「✦ AI 建议」
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.11 · #13 搬不动 → ✦ AI 建议', async () => {
    await suite.it('0 可搬（待定）通知：actions 带「✦ AI 建议」；点了开面板并自动落 AI 跳', async () => {
      /**
       * ⚠️ 用**受控子目录**当范围（`runInboxTidy` 的 `scope` 参数）：
       * 直接拿整个 00_Inbox 的话，夹具里那些正常 Inbox 笔记会产生可搬项 → 走确认流
       * 而不是"0 可搬"通知（第一版就这么假红）。子目录里只有这一篇搬不动的。
       */
      const SCOPE = '00_Inbox/__p711箱';
      const STUCK = `${SCOPE}/__p711搬不动.md`; // 声明指向不存在的目录 → pending
      writeFix(STUCK, '---\n类型: 想法\n领域: 灵感杂记\n文件位置:\n  - 04_Archives/不存在的地方\n---\n\n正文\n');
      await H.settleIndex(app);
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        await H.configAi(plugin);
        H.resetAi();
        const stub = H.stubAi({ reply: '看了一遍', ideas: [] });
        __resetNotices();
        await runInboxTidy(ctx(), { scope: SCOPE });
        const notice = await untilEl(
          () =>
            H.qa<HTMLElement>(document.body, '.kbw-notice').find((n) =>
              H.textOf(n).includes('还没搬'),
            ) ?? null,
          3000,
        );
        ok(notice, '「N 篇还没搬」通知弹出来了');
        const aiBtn = H
          .qa<HTMLElement>(notice!, '.kbw-btn')
          .find((b) => H.textOf(b).includes('AI 建议'));
        ok(aiBtn, `通知动作里有「✦ AI 建议」（实际：${H.textsOf(notice!, '.kbw-btn').join(' | ')}）`);
        H.click(aiBtn as Element);
        const modal = await untilEl(() => {
          const m = H.qa<HTMLElement>(document.body, '.kbw-modal').find((x) =>
            H.textOf(x).includes('整理建议'),
          );
          return m ?? null;
        });
        ok(modal, '点了开整理建议面板');
        const seg = await untilEl(() => modal!.querySelector<HTMLElement>('.kbw-segbtn.is-on'));
        eq(H.textOf(seg), '收件箱', '面板范围 = 收件箱（与这条通知同一片）');
        // 自动 AI 跳 = classify 那一跳：假模型被叫过（空建议也照走）
        await H.until(() => stub.calls.length >= 1, 2500);
        eq(stub.calls.length >= 1, true, `自动 AI 跳落了（假模型调用 ${stub.calls.length} 次）`);
        H.keydown(document.body, 'Escape');
        await H.settle(120);
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        H.resetAi();
        await H.configAi(plugin, { apiKey: prevKey });
        rmFix([STUCK]);
        __resetNotices();
        await H.settle(120);
      }
    });

    await suite.it('未配 AI：点「✦ AI 建议」给轻提示、不开面板（按钮照画不 disabled）', async () => {
      const SCOPE = '00_Inbox/__p711箱2';
      const STUCK = `${SCOPE}/__p711搬不动2.md`;
      writeFix(STUCK, '---\n类型: 想法\n领域: 灵感杂记\n文件位置:\n  - 04_Archives/也不存在\n---\n\n正文\n');
      await H.settleIndex(app);
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        await H.configAi(plugin, { apiKey: '' });
        __resetNotices();
        await runInboxTidy(ctx(), { scope: SCOPE });
        const notice = await untilEl(
          () =>
            H.qa<HTMLElement>(document.body, '.kbw-notice').find((n) =>
              H.textOf(n).includes('还没搬'),
            ) ?? null,
          3000,
        );
        ok(notice, '通知在');
        const aiBtn = H
          .qa<HTMLElement>(notice!, '.kbw-btn')
          .find((b) => H.textOf(b).includes('AI 建议'));
        ok(aiBtn, '按钮照画');
        ok(!aiBtn!.hasAttribute('disabled'), '不 disabled（点了给提示，不是"点了没反应"）');
        const modals0 = H.qa(document.body, '.kbw-modal').length;
        H.click(aiBtn as Element);
        const light = await untilEl(
          () =>
            H.qa<HTMLElement>(document.body, '.kbw-notice-text').find((t) =>
              (t.textContent ?? '').includes('还没配置 AI'),
            ) ?? null,
        );
        ok(light, '点了给轻提示（不静默）');
        eq(H.qa(document.body, '.kbw-modal').length, modals0, '不开面板');
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        await H.configAi(plugin, { apiKey: prevKey });
        rmFix([STUCK]);
        __resetNotices();
        await H.settle(120);
      }
    });

    await suite.it('部分搬成（真冲突）：mover 那条 partial 通知也带上「✦ AI 建议」（extraActions 直通）', async () => {
      const SCOPE = '00_Inbox/__p711箱3';
      const A = `${SCOPE}/__p711冲突篇.md`;
      const B = '02_Areas/灵感杂记/__p711冲突篇.md';
      // 显式声明 → 可搬（目标 = 02_Areas/灵感杂记）；目标处放一篇**内容不同**的 → 真冲突
      writeFix(A, '---\n类型: 想法\n领域: 灵感杂记\n文件位置:\n  - 02_Areas/灵感杂记\n---\n\n源这篇\n');
      writeFix(B, '---\n类型: 想法\n领域: 灵感杂记\n---\n\n目标那篇（内容不同 → 真冲突）\n');
      await H.settleIndex(app);
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        await H.configAi(plugin);
        __resetNotices();
        void runInboxTidy(ctx(), { scope: SCOPE });
        const cfm = await untilEl(() => {
          const m = H.qa<HTMLElement>(document.body, '.kbw-modal').find((x) =>
            H.textOf(x).includes('即将整理'),
          );
          return m ?? null;
        });
        ok(cfm, '确认流在（这一篇有落点，只是目标撞名）');
        const primary = H.q<HTMLElement>(cfm!, '.kbw-modal-foot .kbw-btn.is-primary');
        H.click(primary);
        const partial = await untilEl(
          () =>
            H.qa<HTMLElement>(document.body, '.kbw-notice').find(
              (n) => H.textOf(n).includes('撞名') || H.textOf(n).includes('冲突'),
            ) ?? null,
          4000,
        );
        ok(partial, `mover 的 partial 通知弹出来了（现场：${H.textsOf(document.body, '.kbw-notice').join(' || ')}）`);
        const aiBtn = H
          .qa<HTMLElement>(partial!, '.kbw-btn')
          .find((b) => H.textOf(b).includes('AI 建议'));
        ok(aiBtn, `partial 的 actions 里有「✦ AI 建议」（实际：${H.textsOf(partial!, '.kbw-btn').join(' | ')}）`);
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        __resetUndo();
        rmFix([A, B]);
        await H.configAi(plugin, { apiKey: prevKey });
        __resetNotices();
        await H.settle(150);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // #5 首页空白菜单 + #8 重载（全局 / 此板块）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.11 · #5/#8 首页菜单与重载', async () => {
    await suite.it('空白右键菜单顺序：还原快照 → ✦ 问 AI；重载在首页设置上面；点「问 AI」开面板', async () => {
      await ensureHome();
      try {
        /**
         * "空白处"在离线桩里**直接右键宿主**（`.kbw-home`）：jsdom 没有
         * `elementFromPoint`（几何也全是 0），宿主本身不在任何 `.kbw-hblock` 里 →
         * 走的就是"空白 = 全局菜单"那条分发（与 p72a 同一手法）。
         */
        const host = H.q<HTMLElement>(document.body, '.kbw-home');
        rightClick(host);
        await H.settle(40);
        const texts = menuItemTexts();
        eq(
          texts.join('|'),
          [
            '新建笔记',
            '整理收件箱',
            '还原快照',
            '✦ 问 AI',
            '快速切换',
            '快速捕获',
            '重载（重扫全库索引）',
            '首页设置…',
            '工作台设置',
            '快捷键一览',
          ].join('|'),
          `空白菜单顺序逐条（实际：${texts.join(' | ')}）`,
        );
        const ask = menuItem('✦ 问 AI');
        ok(ask, '「✦ 问 AI」在');
        H.click(ask as Element);
        const aiModal = await untilEl(() => {
          const m = H.qa<HTMLElement>(document.body, '.kbw-modal').find((x) =>
            H.textOf(x).includes('经纬助手'),
          );
          return m ?? null;
        });
        ok(aiModal, '点「问 AI」→ AI 助手面板开（与首页那枚 ✦ 同去处）');
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        // 首页设置 → 落到 home 栏
        rightClick(host);
        await H.settle(40);
        const setRow = menuItem('首页设置');
        ok(setRow, '「首页设置…」在');
        H.click(setRow as Element);
        await H.settle(150);
        const tab = await untilEl(() =>
          H.qa<HTMLElement>(document.body, '.kbw-set-tab[data-section="home"]').find((t) =>
            t.classList.contains('is-on'),
          ) ?? null,
        );
        ok(tab, '落在工作台设置的「首页」栏');
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
      }
    });

    await suite.it('全局菜单「重载」= ctx.reloadIndex（替身计一次）；块菜单「重载此板块」只重画该块', async () => {
      await ensureHome();
      // 起手把 walk 打开（默认关）
      const prevBlocks = ctx().settings.get().homeBlocks;
      try {
        await ctx().settings.save({ homeBlocks: { order: [], hidden: [] } }); // 全部按注册表序、含默认关的
        await H.settle(300);
        await ensureHome();
        // ① ctx.reloadIndex 替身：点菜单里的重载
        const calls: number[] = [];
        const orig = ctx().reloadIndex;
        ctx().reloadIndex = () => {
          calls.push(1);
        };
        try {
          const host = H.q<HTMLElement>(document.body, '.kbw-home');
          rightClick(host);
          await H.settle(40);
          const reload = menuItem('重载（重扫全库索引）');
          ok(reload, '重载项在');
          H.click(reload as Element);
          await H.settle(60);
          eq(calls.length, 1, '点了走 ctx.reloadIndex（一处实现两处入口）');
        } finally {
          ctx().reloadIndex = orig;
        }
        closeAllMenus();
        // ② 块菜单「重载此板块」：只重画该块（别的块 DOM 身份不变；walk 顺带换新三篇）
        await H.settle(200);
        const walk = blockBox('walk');
        ok(walk, '前提：随机漫步块在（把 homeBlocks 摆成全显）');
        const walkRowsBefore = H.qa<HTMLElement>(walk as HTMLElement, '.kbw-rec').map((r) => H.textOf(r));
        const recent = blockBox('recent');
        const recentRowBefore = recent?.querySelector('.kbw-rec') ?? null;
        rightClick(walk!.querySelector('.kbw-sec-head h3') as Element);
        await H.settle(40);
        const reloadBlk = menuItem('重载此板块');
        ok(reloadBlk, '块菜单里有「重载此板块」');
        H.click(reloadBlk as Element);
        await H.settle(300);
        const walkRowsAfter = H.qa<HTMLElement>(walk as HTMLElement, '.kbw-rec').map((r) => H.textOf(r));
        ok(
          walkRowsAfter.join('|') !== walkRowsBefore.join('|'),
          `漫步重载 = 顺带换新三篇（前：${walkRowsBefore.join(' / ')} ；后：${walkRowsAfter.join(' / ')}）`,
        );
        eq(
          recent?.querySelector('.kbw-rec'),
          recentRowBefore,
          '别的块没被碰（DOM 身份不变 —— 只重画该块）',
        );
      } finally {
        closeAllMenus();
        await ctx().settings.save({ homeBlocks: prevBlocks });
        await H.settle(250);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // #9 设置性能：纯界面偏好只落盘
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.11 · #9 纯界面偏好只落盘', async () => {
    await suite.it('save({showSettingHints})：main 那条链没跑（store 不被 set）· 变更键清单如实；别的键照旧触发', async () => {
      await ensureHome();
      const hints0 = ctx().settings.get().showSettingHints;
      const dismissed0 = ctx().settings.get().homeDismissed.slice();
      const store = ctx().store;
      const origSet = store.set.bind(store);
      /**
       * **替身**：只在"我们那次 save 的通知窗口"里计 store.set 的调用数。
       * 为什么用 armed 窗口：子集/全量里都有别处的 settings.save 在跑（后台的
       * `reconcileSeen` 之类），裸计数会被邻居的链路污染；窗口 `armed=true` → 我们那次
       * save 的通知（我的监听排在 main 的**后面** → main 若跑了链，调用已经发生）→ 关闭。
       */
      let armed = false;
      let setCalls = 0;
      (store as unknown as { set: typeof store.set }).set = ((p: never) => {
        if (armed) setCalls += 1;
        return origSet(p);
      }) as typeof store.set;
      let seenChanged: string[] | null = null;
      const unsub = ctx().settings.onChange((_s, changed) => {
        if (changed.length > 0 && changed.every((k) => k === 'showSettingHints')) {
          seenChanged = [...changed];
          armed = false;
        }
      });
      try {
        const box = blockBox('todo');
        ok(box, '前提：todo 块在');
        const headBefore = box!.querySelector('.kbw-sec-head');
        // 先把队列排空（上一次别处的 save 落地）—— 防邻居的 run 落进窗口
        await ctx().settings.save({});
        await H.settle(200);
        armed = true;
        await ctx().settings.save({ showSettingHints: !hints0 });
        await H.settle(250);
        eq(seenChanged !== null, true, '变更键清单如实：这次通知的 changed 恰是 [showSettingHints]');
        eq(setCalls, 0, `showSettingHints 那次 save：main 的链没跑（store.set 调用 ${setCalls} 次）`);
        eq(
          box!.querySelector('.kbw-sec-head'),
          headBefore,
          '首页块没被重画（DOM 身份不变 —— 设置面板自己就地换类名）',
        );
        // 对照：改一个"该重画"的键 → 链照跑（store.set 被调 → 块重画）——判据不是恒真
        // ⚠️ 要**真变**：存一个没人用过的 id（此前 homeDismissed 是空的，写 [] 等于没变 ——
        // "没变"也会被分流跳过，那样对照测的是空气）
        armed = true;
        await ctx().settings.save({ homeDismissed: ['__p711-noise'] });
        await H.settle(300);
        ok(setCalls > 0, `对照：homeDismissed 变化照旧走全链（窗口内 store.set ${setCalls} 次）`);
        ok(
          blockBox('todo')?.querySelector('.kbw-sec-head') !== headBefore,
          '对照：该重画的键真的把块重画了（身份变了）',
        );
      } finally {
        armed = false;
        (store as unknown as { set: typeof store.set }).set = origSet;
        unsub();
        await ctx().settings.save({ showSettingHints: hints0, homeDismissed: dismissed0 });
        await H.settle(200);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // #12 面板其余三条（独立审 🟡3 补的缺口：D 三类齐 / 自己去整理 / 未配 AI）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.11 · #12 面板其余三条', async () => {
    await suite.it('D = 三类行齐（搬 + YAML + 结尾双链）·「自己去整理」A 类 = 跳「全部笔记」· 未配 AI = 轻提示不执行', async () => {
      const FIX = '00_Inbox/__p711三类.md';
      writeFix(FIX, '---\n类型: 笔记\n---\n\n这篇三类都要占：讲的是把整理建议接进首页待处理。\n');
      await H.settleIndex(app);
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        // ① 未配 AI：面板里的「AI 自动去做」= 轻提示、不执行（本轮就地拍板的口径）
        await H.configAi(plugin, { apiKey: '' });
        {
          const h = openSuggestPanel(ctx(), { scope: '00_Inbox' });
          await untilEl(() => h.body.querySelector<HTMLElement>('.kbw-suggest-choice'), 4000);
          const before = H.readNote(vaultRoot, `${KB}/${FIX}`);
          const modals0 = H.qa(document.body, '.kbw-modal').length;
          const runBtn = H.qa<HTMLElement>(h.body, '.kbw-suggest-bar .kbw-btn').find((b) =>
            H.textOf(b).includes('AI 自动去做'),
          );
          ok(runBtn, '前提：「AI 自动去做」在');
          H.click(runBtn!);
          const light = await untilEl(
            () =>
              H.qa<HTMLElement>(document.body, '.kbw-notice-text').find((t) =>
                (t.textContent ?? '').includes('还没配置 AI'),
              ) ?? null,
          );
          ok(light, '未配 AI：点了给轻提示（不静默）');
          eq(H.qa(document.body, '.kbw-modal').length, modals0, '不开确认流（轻提示 + 不执行）');
          eq(H.readNote(vaultRoot, `${KB}/${FIX}`), before, '一个字都没动');
          h.close('test');
          await H.settle(80);
        }
        // ② D 三类齐：三类清单同时呈现（搬 / 缺「文件位置」/ 结尾或尾链）
        {
          await H.configAi(plugin);
          const h = openSuggestPanel(ctx(), { scope: '00_Inbox' });
          await untilEl(() => h.body.querySelector<HTMLElement>('.kbw-suggest-choice'), 4000);
          const optD = H
            .qa<HTMLElement>(h.body, '.kbw-suggest-opt')
            .find((o) => o.dataset.cls === 'D');
          ok(optD, 'D 项在');
          H.click(optD!);
          // 懒算（B/C 现算）落地：等出现「缺「文件位置」」行（v2：B 类 = 缺声明）
          const areaRow = await untilEl(
            () =>
              H.qa<HTMLElement>(h.body, '.kbw-suggest-row').find((r) =>
                H.textOf(r).includes('缺「文件位置」'),
              ) ?? null,
            4000,
          );
          ok(areaRow, 'D 类下 B 类行（缺「文件位置」）在（B 现算被拉起）');
          const textsAll = H.qa<HTMLElement>(h.body, '.kbw-suggest-row').map((r) => H.textOf(r));
          ok(
            textsAll.some((t) => t.includes('→') && !t.includes('「')),
            'A 类行（搬：→ 目录）在',
          );
          ok(textsAll.length >= 2, `三类来源合流（实际 ${textsAll.length} 行）`);
          h.close('test');
          await H.settle(80);
        }
        // ③ 「自己去整理」A 类 = 关面板 + 跳「全部笔记」
        {
          await ensureHome();
          const h = openSuggestPanel(ctx(), { scope: '00_Inbox' });
          await untilEl(() => h.body.querySelector<HTMLElement>('.kbw-suggest-choice'), 4000);
          const self = H.qa<HTMLElement>(h.body, '.kbw-suggest-bar .kbw-btn').find((b) =>
            H.textOf(b).includes('自己去整理'),
          );
          ok(self, '前提：「自己去整理」在');
          H.click(self!);
          await H.until(() => ctx().store.get().activeModule === 'notes', 2500);
          eq(ctx().store.get().activeModule, 'notes', '「自己去整理」= 跳「全部笔记」（A 类）');
          eq(H.qa(document.body, '.kbw-modal').length, 0, '面板已收（不叠在跳转之上）');
        }
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        await H.configAi(plugin, { apiKey: prevKey });
        rmFix([FIX]);
        __resetNotices();
        await ensureHome();
        await H.settle(120);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // #12 B 类全链（v2：AI 补**声明**）→ 确认流 → fm.set → 撤销
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.11 · #12 B 类（AI 补声明）全链', async () => {
    await suite.it('选 B → 清单含缺「文件位置」篇 → AI 自动去做 → 确认流 → 写前言 → 撤销还原', async () => {
      const FIX = '00_Inbox/__p711缺声明.md';
      writeFix(FIX, '---\n类型: 笔记\n---\n\n这篇讲的是把整理建议接进首页待处理。\n');
      await H.settleIndex(app);
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        await H.configAi(plugin);
        H.resetAi();
        H.stubAi({
          raw: JSON.stringify({
            reply: '（用例）看了一遍',
            locus: [
              { path: FIX, to: '02_Areas/灵感杂记' },
              { path: '幻觉/不存在.md', to: '02_Areas/内容创作' }, // 幻觉路径 → 判丢
              { path: FIX, to: '02_Areas/游戏研究' }, // 重复 → 判丢（只留第一条）
            ],
          }),
        });
        const h = openSuggestPanel(ctx(), { scope: '00_Inbox' });
        try {
          await untilEl(() => h.body.querySelector<HTMLElement>('.kbw-suggest-choice'), 4000);
          const optB = H
            .qa<HTMLElement>(h.body, '.kbw-suggest-opt')
            .find((o) => o.dataset.cls === 'B');
          ok(optB, 'B 项在');
          H.click(optB!);
          await untilEl(
            () =>
              H
                .qa<HTMLElement>(h.body, '.kbw-suggest-row')
                .find((r) => H.textOf(r).includes('__p711缺声明')) ?? null,
            4000,
          );
          const fixRow = H
            .qa<HTMLElement>(h.body, '.kbw-suggest-row')
            .find((r) => H.textOf(r).includes('__p711缺声明'));
          ok(fixRow, 'B 类清单里有这一篇（缺「文件位置」）');
          const aiBtn = H
            .qa<HTMLElement>(h.body, '.kbw-suggest-bar .kbw-btn')
            .find((b) => H.textOf(b).includes('AI 自动去做'));
          ok(aiBtn, '「AI 自动去做」在');
          H.click(aiBtn as Element);
          // AI 回来后：行上出现值（→ 02_Areas/灵感杂记），随后走确认流
          const cfm = await untilEl(() => {
            const m = H.qa<HTMLElement>(document.body, '.kbw-modal').find((x) =>
              H.textOf(x).includes('即将整理'),
            );
            return m ?? null;
          }, 5000);
          ok(cfm, '确认流弹出来了（AI 补声明 → 确认流）');
          const planText = H
            .qa<HTMLElement>(cfm!, '.kbw-plan-row')
            .map((r) => H.textOf(r))
            .join(' || ');
          contains(planText, '文件位置', '预览行是「补「文件位置」」档');
          contains(planText, '02_Areas/灵感杂记', '提议的落点在预览里（你确认的就是它）');
          const primary = H.q<HTMLElement>(cfm!, '.kbw-modal-foot .kbw-btn.is-primary');
          ok(primary, '主按钮在');
          H.click(primary);
          // 写盘：这篇的前言里有「文件位置: 02_Areas/灵感杂记」（列表型两行）
          await H.until(() => H.readNote(vaultRoot, `${KB}/${FIX}`).includes('  - 02_Areas/灵感杂记'), 4000);
          contains(
            H.readNote(vaultRoot, `${KB}/${FIX}`),
            '文件位置:',
            '「文件位置」写进了前言（fm.set）',
          );
          contains(
            H.readNote(vaultRoot, `${KB}/${FIX}`),
            '  - 02_Areas/灵感杂记',
            '值 = AI 提议的落点',
          );
          // 撤销条 → 还原
          const undo = await untilEl(() => H.currentUndoButton('撤销'));
          ok(undo, '撤销条在');
          H.click(undo!);
          await H.until(() => !H.readNote(vaultRoot, `${KB}/${FIX}`).includes('文件位置'), 4000);
          ok(
            !H.readNote(vaultRoot, `${KB}/${FIX}`).includes('文件位置'),
            '撤销 = 快照还原，前言回到没有「文件位置」的样子',
          );
        } finally {
          H.keydown(document.body, 'Escape');
          await H.settle(120);
          h.close('test');
          await H.settle(80);
        }
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        H.resetAi();
        await H.configAi(plugin, { apiKey: prevKey });
        rmFix([FIX]);
        __resetUndo();
        __resetNotices();
        await H.settle(120);
      }
    });
  });
}
