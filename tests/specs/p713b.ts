/**
 * spec：**P7.13b · 反馈批 5 实施（二）** —— 域 D 待处理右键两改（#6a/#6b）+ 三类自动化 E1/E2/E3
 *
 * 自造库（`makeTempVault('p713b')`）—— 会真造 / 真搬 / 真删夹具（全带 `__p713b` 前缀，
 * 每条自己收），与 p78/p79/p711 同一条纪律。⚠️ 夹具库里**有一处**会干扰本批判据的存量：
 * `00_Inbox/旧链接摘录.md` 带失效链（"失效双链"那行本来就是它撑着的 —— E1 的"行消失"
 * 要连它一起修，见 ③ 的注释）。E2/E3 那两个行由本 spec 的夹具现造、清完即消失。
 *
 * 覆盖面（条目号 → 断言主体）：
 *   · 纯逻辑：`replaceLinkTarget`（认得出才换/别名与节保留/幂等）· `parseLinkFix`（清洗与丢弃）
 *     · `planMoveBackToDeclared`（不存在 → missing；排除 → skips）· `rowDisabledReason`（三档置灰）
 *   · #6a 落点：鼠标右键 = 鼠标落点；键盘呼出（坐标 0）回退行锚点
 *   · E1 修链全流程（stub AI）：面板 → 卡片 → 选候选 → 确认 → 按行改（`|别名`/`#节` 保留）→
 *     行消失 → 撤销还原（连库内既有的那篇一起）
 *   · ① 搬回声明处：已存在目录直接搬；不存在 → **先问一次**（不建 → 没动+通知；建 → 搬+可撤销）
 *   · E2 保最新一份：确认单点名"较旧那件"→ 回收站 → 行消失 → 撤销还原
 *   · E3 孤儿附件：挪 `99_Meta/05_待清理/`（目录随 mover 建、可撤销收回）→ 行消失
 *   · ② 一键完全处理：面板型动作**等面板关**才收尾；串行 + 取消 = 跳过继续 + 汇总"完成 X / 跳过 Y"
 *   · ① 置灰：外部改动行的 ① 置灰 + 原因文案在菜单上
 *
 * ⚠️ AI 一律假传输层（绝不联网）。清场纪律照旧：自造文件 / homeDismissed / 通知栈 ——
 * 每条 finally 原值归还。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { __resetNotices } from '../../src/ui/notify';
import { replaceLinkTarget } from '../../src/services/link-fix';
import { parseLinkFix } from '../../src/services/ai';
import { planMoveBackToDeclared } from '../../src/services/reconcile';
import { computeTodoItems, rowDisabledReason, runRowAction } from '../../src/modules/home/todo-actions';
import type { TodoItem } from '../../src/modules/home/todo';
import type { NoteEntry } from '../../src/core/vault-index';

const KB = '01_新知识库';
/** 复用的子目录（夹具库里有） */
const RES = '03_Resources';
const META_CLEAN = '99_Meta/05_待清理';

/** 造一个 NoteEntry（纯函数层用，不碰库 —— 与 automation.ts 的同款） */
function entryOf(pathStr: string, props: Record<string, unknown>, flags: NoteEntry['flags'] = []): NoteEntry {
  const rel = pathStr.startsWith(`${KB}/`) ? pathStr.slice(KB.length + 1) : pathStr;
  const parts = rel.split('/');
  const name = (parts.pop() ?? '').replace(/\.md$/, '');
  const dir = parts.join('/');
  return {
    file: { path: pathStr, basename: name } as unknown as NoteEntry['file'],
    props,
    flags,
    effectivePosition: dir,
    path: pathStr,
    basename: name,
    isTemplate: false,
    mtime: 0,
    size: 10,
  };
}

/** 造一个 TodoItem（面板型动作/置灰判据只需要 id 与文案） */
function itemOf(id: string, text = '（用例造的项）', act = '去看看'): TodoItem {
  return { id, level: 'blue', text, act, meta: '', count: 1 };
}

export async function specP713b(
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
        fs.rmSync(path.join(vaultRoot, KB, rel), { recursive: true, force: true });
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

  const menuItems = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-menu-item');
  const menuItem = (needle: string): HTMLElement | undefined =>
    menuItems().find((i) => H.textOf(i).includes(needle));
  const todoRowOf = (needle: string): HTMLElement | undefined =>
    H.qa<HTMLElement>(document.body, '.kbw-todo').find((r) => H.textOf(r).includes(needle));

  /**
   * 把带这些措辞的待处理行挤进可见区（折叠只画前 5 条 —— 忽略掉挡在前面的行；
   * `homeDismissed` 由调用方 finally 原值归还）。与 p78 同一手法。
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
      if (idx < 0) return;
      const x = rows[idx].querySelector<HTMLElement>('.kbw-todo-x');
      if (!x) return;
      H.click(x);
      await H.settle(170);
    }
  }

  async function withReveal<T>(needles: string[], fn: () => Promise<T>): Promise<T> {
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

  /**
   * 行右键 → 悬停「✦ AI 自动处理」→ 点 ①（或 ②）。返回点到了没有（现场诊断靠它）。
   * ⚠️ 坐标给非 0（#6a 起鼠标路径走 `evt.clientX/Y`;0,0 是键盘回退档，那是另一条判据）。
   */
  async function clickRowAiItem(row: HTMLElement, which: '①' | '②'): Promise<boolean> {
    const r = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 30,
        clientY: r.top + 10,
      }),
    );
    const ai = await untilEl(() => menuItem('✦ AI 自动处理') ?? null);
    if (!ai) return false;
    ai.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    const sub = await untilEl(() => {
      const all = H.qa<HTMLElement>(document.body, '.kbw-menu');
      return all.reverse().find((x) => H.textOf(x).includes('自动处理本条')) ?? null;
    });
    if (!sub) return false;
    const item = H.qa<HTMLElement>(sub, '.kbw-menu-item').find((i) => H.textOf(i).startsWith(which));
    if (!item) return false;
    H.click(item);
    await H.settle(80);
    return true;
  }

  /** 认"最后出现的那枚"模态（面板自己也是一枚 `.kbw-modal` —— P6 段④ 的老账） */
  function modalWith(needle: string): HTMLElement | null {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal').filter((m) =>
      H.textOf(m).includes(needle),
    );
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /** 在某枚模态的底栏里点一枚按钮（按文案找） */
  function clickModalBtn(modal: HTMLElement, btnText: string): boolean {
    const b = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) =>
      H.textOf(x).includes(btnText),
    );
    if (!b) return false;
    H.click(b);
    return true;
  }

  /** 通告（`.kbw-notice-text` / `.kbw-notice-detail` 的全文本）里有没有这句 */
  function noticesText(): string {
    return H.qa<HTMLElement>(document.body, '.kbw-notice')
      .map((n) => H.textOf(n))
      .join(' || ');
  }

  /** 配 AI 并在收尾时把 key 还回去（与 p78 同款） */
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
  await suite.group('P7.13b · 纯逻辑（replaceLinkTarget / parseLinkFix / planMoveBack / 置灰原因）', async () => {
    await suite.it('replaceLinkTarget：只换认得出的目标；别名与 #小节 原样保留；幂等；多处全改', () => {
      // 别名保留
      eq(
        replaceLinkTarget('看 [[会议记录模板|简称]] 吧', '会议记录模板', '会议纪要').text,
        '看 [[会议纪要|简称]] 吧',
        '别名保留',
      );
      // #小节保留
      eq(
        replaceLinkTarget('见 [[会议记录模板#记录|别名]] 里', '会议记录模板', '会议纪要').text,
        '见 [[会议纪要#记录|别名]] 里',
        '#小节与别名一起保留（顺序 = 目标#节|别名）',
      );
      // 嵌入照改（`!` 留在原地）
      eq(
        replaceLinkTarget('![[会议记录模板]]', '会议记录模板', '会议纪要').text,
        '![[会议纪要]]',
        '嵌入也认（`!` 不动）',
      );
      // 认不出的一处不动：目标要**整段相等**（前缀/后缀不算）
      eq(
        replaceLinkTarget('[[会议记录模板集]] 与 [[短名]]', '会议记录模板', '会议纪要').text,
        '[[会议记录模板集]] 与 [[短名]]',
        '不是整段相等就不算（模板集 ≠ 模板）',
      );
      // 多命中全改 + 计数如实
      const multi = replaceLinkTarget('a [[旧]] b [[旧|x]] c [[旧]]', '旧', '新');
      eq(multi.count, 3, '同一目标出现三处 → 三处全改（同一条断链）');
      eq(multi.text, 'a [[新]] b [[新|x]] c [[新]]', '三处都换了、别名保留');
      // 幂等 / 空值
      eq(replaceLinkTarget('[[平]]', '平', '平').count, 0, '新旧同名 → 一处都不动');
      eq(replaceLinkTarget('[[平]]', '', '新').count, 0, '空目标 → 不动');
      eq(replaceLinkTarget('[[平]]', '平', '').count, 0, '空新值 → 不动');
    });

    await suite.it('parseLinkFix：剥包裹 · 脏候选判丢 · 每条封顶 2 · 散文回落', () => {
      const r = parseLinkFix(
        JSON.stringify({
          reply: '看了一遍',
          links: [
            // ⚠️ 脏候选要放在**封顶之前**才走得到（封顶 2 之后 break，后面的不再看 —— 与 parseTitles 同口径）
            { path: 'a.md', from: '旧目标', options: ['带/斜杠', '《新目标》', '"引号包裹"', '第五个'] },
            { path: 'b.md', from: '', options: ['хорошо'] },
            { path: 'c.md', options: ['缺 from'] },
            { from: '缺路径', options: ['x'] },
          ],
        }),
      );
      eq(r.list.length, 1, '只有 a.md 一行成型');
      deepEq(r.list[0].options, ['新目标', '引号包裹'], '剥两端包裹 · 封顶 2（第五个不进）');
      eq(r.list[0].from, '旧目标', 'from 原样带出来（服务层再归一化复核）');
      eq(r.dropped, 4, '斜杠 + 空 from + 缺 options + 缺 path —— 各丢一条（如实计数）');
      eq(
        parseLinkFix(JSON.stringify({ reply: 'x', links: '坏形状' })).dropped,
        1,
        'links 形状不对（字符串）也要如实计 dropped（独立审 🟡2 的尾巴）',
      );
      const chat = parseLinkFix('（模型只回了一段话）');
      eq(chat.list.length, 0, '散文回落：没有候选');
      contains(chat.reply, '只回了一段话', '散文原样带回来当 reply');
    });

    await suite.it('planMoveBackToDeclared：已存在 → moves；不存在 → missing；排除 → skips；已一致/无声明不进', () => {
      const opts = { kbRoot: KB, exclude: ['99_Meta', '还原保留'], dirs: new Set(['', '00_Inbox', '02_Areas/灵感杂记']) };
      const a = entryOf(`${KB}/00_Inbox/a.md`, { 文件位置: ['02_Areas/灵感杂记'] });
      const b = entryOf(`${KB}/00_Inbox/b.md`, { 文件位置: ['02_Areas/__没这个目录'] });
      const c = entryOf(`${KB}/00_Inbox/c.md`, { 文件位置: ['99_Meta/03_AI指令集'] });
      const d = entryOf(`${KB}/00_Inbox/d.md`, { 文件位置: ['00_Inbox'] }); // 就住这儿 → 不进
      const e = entryOf(`${KB}/00_Inbox/e.md`, {}); // 无声明 → 不进
      const plan = planMoveBackToDeclared([a, b, c, d, e], opts);
      eq(plan.moves.length, 1, '只有 a 进 moves');
      eq(plan.moves[0].declared, '02_Areas/灵感杂记', '目标 = 声明处');
      eq(plan.moves[0].to, '02_Areas/灵感杂记/a.md', '落点相对库根（消费方再 joinPath）');
      eq(plan.missing.length, 1, 'b 的目标目录不存在 → missing（走"建前问一次"）');
      eq(plan.missing[0].declared, '02_Areas/__没这个目录', 'missing 带上声明的目录名');
      eq(plan.skips.length, 1, 'c 的目标在排除区 → skips（只报不搬）');
      contains(plan.skips[0].why, '排除范围', '跳过原因写得出来');
    });

    await suite.it('proposeLinks（服务层复核）：幻觉路径 / 清单外目标 / 对不上的 from 判丢；合法条目留 1–2 个候选', async () => {
      await withAi(async () => {
        H.resetAi();
        H.stubAi({
          raw: JSON.stringify({
            reply: '（用例）',
            links: [
              // 合法的一条：靶子 = 夹具库既有的失效链（旧链接摘录 → [[不存在的旧笔记]]）
              { path: '00_Inbox/旧链接摘录.md', from: '不存在的旧笔记', options: ['幻觉目标甲', '9.16'] },
              { path: '幻觉/没有这篇.md', from: '不存在的旧笔记', options: ['9.16'] },
              { path: '00_Inbox/旧链接摘录.md', from: '对不上的旧目标', options: ['9.16'] },
            ],
          }),
        });
        const res = await ctx().ai.proposeLinks({});
        eq(res.items.length, 1, `只有合法那条留下（实际 ${JSON.stringify(res.items)}）`);
        deepEq(res.items[0].options, ['9.16'], '清单外的候选（幻觉目标甲）判丢 —— 值域 = 全库标题');
        eq(res.items[0].from, '不存在的旧笔记', 'from 归一化后原样带出');
        ok(res.dropped >= 2, `幻觉路径 + 对不上的 from 如实计入 dropped（实际 ${res.dropped}）`);
        ok(res.fed.includes('00_Inbox/旧链接摘录.md'), 'fed 回报"看过哪几篇"');
      });
    });

    await suite.it('rowDisabledReason：外改 / 一次性标签 / 未配 AI 的修链 三档置灰；可自动的行不置灰', async () => {
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        await H.configAi(plugin, { apiKey: '' });
        contains(rowDisabledReason(ctx(), itemOf('broken-link')), '还没配置 AI', '未配 AI：修链行置灰并点名去哪配');
        await H.configAi(plugin);
        eq(rowDisabledReason(ctx(), itemOf('broken-link')), '', '配了 AI → 修链行可跑');
        contains(rowDisabledReason(ctx(), itemOf('external-change')), '亲自过目', '外改：置灰 + 原因（Q24）');
        contains(rowDisabledReason(ctx(), itemOf('unused-tags')), '提示', '一次性标签：置灰 + 原因（Q24）');
        for (const id of ['inbox', 'position-mismatch', 'migrate', 'placeholder-title', 'empty-file', 'dup-files', 'orphan-files']) {
          eq(rowDisabledReason(ctx(), itemOf(id)), '', `可自动的 ${id} 不置灰`);
        }
      } finally {
        await H.configAi(plugin, { apiKey: prevKey });
        await H.settle(80);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② #6a 菜单落点（鼠标 = 鼠标处；键盘 = 回退行锚点）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13b · #6a 菜单落点（Q19）', async () => {
    await suite.it('鼠标右键 = 鼠标落点；键盘呼出（坐标 0）回退行锚点（两条路落的坐标不同）', async () => {
      await withReveal(['收件箱有'], async () => {
        const row = await untilEl(() => todoRowOf('收件箱有') ?? null, 4000);
        ok(row, '前提：收件箱行在');
        try {
          // ── 鼠标路径：clientX/Y 直传 ──
          row!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 50 }),
          );
          const menuA = await untilEl(() => H.q<HTMLElement>(document.body, '.kbw-menu'));
          ok(menuA, '鼠标右键开了菜单');
          const leftA = parseInt(menuA!.style.left, 10);
          const topA = parseInt(menuA!.style.top, 10);
          eq(leftA, 104, `菜单 left = 鼠标 x + 4（实际 ${menuA!.style.left}）`);
          eq(topA, 54, `菜单 top = 鼠标 y + 4（实际 ${menuA!.style.top}）`);
          closeAllMenus();
          await H.settle(60);
          // ── 键盘路径：坐标 0 → 回退行锚点（row.left+24 / row.top+8 再 +4 的落点内缩） ──
          const r = row!.getBoundingClientRect();
          row!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }),
          );
          const menuB = await untilEl(() => H.q<HTMLElement>(document.body, '.kbw-menu'));
          ok(menuB, '键盘呼出（坐标 0）也能开菜单');
          const leftB = parseInt(menuB!.style.left, 10);
          const topB = parseInt(menuB!.style.top, 10);
          eq(leftB, Math.max(4, Math.round(r.left + 24 + 4)), `回退行锚点 left（实际 ${menuB!.style.left}）`);
          eq(topB, Math.max(4, Math.round(r.top + 8 + 4)), `回退行锚点 top（实际 ${menuB!.style.top}）`);
          ok(leftA !== leftB || topA !== topB, '两条路落的点不同（真回退了，不是都算一处）');
        } finally {
          closeAllMenus();
        }
      });
    });
  });

  // ════════════════════════════════════════════════════════════
  // ③ E1 修链全流程（① → 面板 → 确认 → 按行改 → 行消失 → 撤销）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13b · E1 修链（AI 修失效双链全流程）', async () => {
    await suite.it('① → 修链面板 → 选候选 → 确认 → 只改认得出的那条（别名/节保留）→ 行消失 → 撤销还原', async () => {
      const SRC = `${RES}/__p713b修链源.md`;
      const TARGET = `${RES}/会议纪要.md`;
      const BASE_BROKEN = '00_Inbox/旧链接摘录.md';
      const baseAbs = path.join(vaultRoot, KB, BASE_BROKEN);
      const baseBefore = fs.readFileSync(baseAbs, 'utf8');
      /**
       * 夹具：一篇带失效链的源（同一目标出现两次：一次带别名、一次带 #节）、
       * 一篇**有效**链接（不该被动）、一篇候选目标（AI 猜的那个）。
       *
       * ⚠️ 夹具库自带 `00_Inbox/旧链接摘录.md`（`[[不存在的旧笔记]]`）——"失效双链"那行
       * **本来就是它撑着的**。"跑完行消失"要成立，得**连它一起修**：stub 给两条链都出候选
       *（这正是"一键修完整行"的真实形态），撤销那一下会把两篇一起还原。
       */
      writeFix(SRC, H.note('开头 [[会议记录模板|简称]] 中间，[[会议记录模板#记录]] 再一句，[[会议纪要]] 结尾。\n', { 类型: '资料' }));
      writeFix(TARGET, H.note('（候选目标，探针造的。）\n', { 类型: '资料' }));
      await H.settleIndex(app);
      try {
        await withReveal(['有失效双链'], async () => {
          await withAi(async () => {
            H.resetAi();
            H.stubAi({
              raw: JSON.stringify({
                reply: '（用例）猜了两个目标',
                links: [
                  { path: SRC, from: '会议记录模板', options: ['会议纪要'] },
                  { path: BASE_BROKEN, from: '不存在的旧笔记', options: ['会议纪要'] },
                ],
              }),
            });
            const row = await untilEl(() => todoRowOf('有失效双链') ?? null, 4000);
            ok(row, `前提：失效双链行在（当前行：${H.qa<HTMLElement>(document.body, '.kbw-todo').map((r) => H.textOf(r).slice(0, 14)).join(' / ')}）`);
            const clicked = await clickRowAiItem(row!, '①');
            ok(clicked, '行菜单 ① 点到了');
            const panel = await untilEl(() => modalWith('AI 修链'));
            ok(panel, '「AI 修链」面板开了');
            // 两张卡（源 + 库里既有那篇），卡头是《名》+ [[旧目标]]
            const cardOf = (needle: string): HTMLElement | undefined =>
              H.qa<HTMLElement>(panel!, '.kbw-title-row').find((r) => H.textOf(r).includes(needle));
            const cardA = await untilEl(() => cardOf('__p713b修链源') ?? null, 4000);
            ok(cardA, '源那篇的卡在');
            contains(H.textOf(cardA!), '[[会议记录模板]]', '卡上写着这条失效链的旧目标');
            const cardB = cardOf('旧链接摘录');
            ok(cardB, '库里既有那篇（旧链接摘录）也有卡 —— 一行里的链都进面板');
            // 候选出来：A 项 = 会议纪要
            const optA = await untilEl(
              () => cardA!.querySelector<HTMLElement>('.kbw-title-opt[data-key="A"]') ?? null,
              4000,
            );
            ok(optA && H.textOf(optA).includes('会议纪要'), 'AI 候选出来了（A = 会议纪要）');
            const optB = cardB!.querySelector<HTMLElement>('.kbw-title-opt[data-key="A"]');
            ok(optB, '库里那篇的候选也出来了');
            // 两张卡都选 A
            H.click(cardA!.querySelector('.kbw-title-opt[data-key="A"]') as Element);
            H.click(cardB!.querySelector('.kbw-title-opt[data-key="A"]') as Element);
            await H.settle(40);
            const runBtn = H.qa<HTMLElement>(panel!, '.kbw-title-bar .kbw-btn').find((b) =>
              H.textOf(b).includes('改这'),
            );
            contains(H.textOf(runBtn!), '2 条', `执行名单 = 2 条链（实际「${H.textOf(runBtn!)}」）`);
            H.click(runBtn!);
            // 确认流：逐条 旧链 → 新链
            const cfm = await untilEl(() => modalWith('即将改'));
            ok(cfm, '确认流弹出来了');
            const planText = H.textsOf(cfm!, '.kbw-plan-row').join(' || ');
            contains(planText, '会议记录模板', '预览点名旧链');
            contains(planText, '旧链接摘录', '库里那篇也在单上');
            ok(clickModalBtn(cfm!, '改这'), '点了主按钮');
            // 写盘：源那篇 —— 两处都换、别名与节保留、有效链不动
            // ⚠️ 等条件别用 `includes('会议纪要')` —— 原文里**本来就有**一条有效的 `[[会议纪要]]`，
            // 一上来就满足（等了个寂寞，断言读到的是写盘前的原文）。等"别名那处换掉"才作数。
            const after = await untilEl(() => {
              const t = fs.readFileSync(path.join(vaultRoot, KB, SRC), 'utf8');
              return t.includes('[[会议纪要|简称]]') ? t : null;
            }, 3000);
            ok(after, '源那篇写盘了');
            ok(after!.includes('[[会议纪要|简称]]'), '带别名的那处：目标换、别名保留');
            ok(after!.includes('[[会议纪要#记录]]'), '带 #节的那处：目标换、节保留');
            ok(!after!.includes('会议记录模板'), '旧目标一处不剩');
            ok(after!.includes('[[会议纪要]] 结尾'), '本来就有效的链原样（不是只认会改的）');
            ok(after!.includes('开头 '), '行内其余文本一字不改');
            // 库里那篇也修了
            const baseAfter = fs.readFileSync(baseAbs, 'utf8');
            ok(baseAfter.includes('[[会议纪要]]'), '库里既有那篇也修了（同一张单）');
            // 留痕：source 'ai'
            const logs = app.vault
              .getMarkdownFiles()
              .filter((f) => f.path.includes('05_操作日志') && /\/日志-\d{8}-\d{6}-/.test(`/${f.name}`))
              .sort((x, y) => y.path.localeCompare(x.path));
            const logTexts = await Promise.all(logs.slice(0, 6).map((f) => app.vault.cachedRead(f)));
            const myLog = logTexts.find((t) => t.includes('修失效双链')) ?? '';
            ok(myLog !== '', '写了修链日志');
            contains(myLog, '**这条是 AI 建议的**', 'AI 留痕（§11.1 边界④）');
            /**
             * 行消失（两篇都不再断链 → 整行撤掉）。
             * ⚠️ 必须先 `settleIndex`：写盘 → metadataCache 重解析有 ~300ms 滞后（桩模拟真机），
             * 不结算的话索引里的旗标还是旧的（第一版就这么假红的 —— 活文本已修、旗标未刷）。
             */
            await H.settleIndex(app);
            await H.settle(150);
            const items = await computeTodoItems(ctx());
            ok(
              !items.some((i) => i.id === 'broken-link'),
              `两篇都修好后「失效双链」整行消失（还剩：${items.map((i) => i.id).join(',')}）`,
            );
            // 撤销 → 连库里那篇一起还原
            const undo = await untilEl(() => H.currentUndoButton('撤销'));
            ok(undo, '撤销条在');
            H.click(undo!);
            await H.until(() => fs.readFileSync(baseAbs, 'utf8') === baseBefore, 3000);
            eq(fs.readFileSync(baseAbs, 'utf8'), baseBefore, '撤销 = 快照还原：库里那篇逐字节回到原样');
            ok(fs.readFileSync(path.join(vaultRoot, KB, SRC), 'utf8').includes('[[会议记录模板|简称]]'), '源那篇也还原');
            H.keydown(document.body, 'Escape'); // 关面板（Esc 关栈顶）
            await H.settle(150);
          });
        });
      } finally {
        H.keydown(document.body, 'Escape');
        await H.settle(100);
        rmFix([SRC, TARGET]);
        // 兜底：库里那篇若因中途失败没还原，写回原文
        if (fs.readFileSync(baseAbs, 'utf8') !== baseBefore) {
          fs.writeFileSync(baseAbs, baseBefore, 'utf8');
          rmFix([]);
        }
        await H.settle(120);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ④ ① 搬回声明处（目录存在直接搬；不存在 → 建前单独问一次）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13b · ① 位置不一致 → 搬回声明处', async () => {
    await suite.it('声明目录已存在：① → 确认流 → 真搬回 → 「位置不一致」行消失 → 撤销还原', async () => {
      const SRC = `${RES}/__p713b位偏.md`;
      const DEST = '02_Areas/灵感杂记/__p713b位偏.md';
      writeFix(SRC, H.note('正文。\n', { 类型: '资料', 文件位置: ['02_Areas/灵感杂记'] }));
      await H.settleIndex(app);
      try {
        await withReveal(['位置不一致'], async () => {
          const row = await untilEl(() => todoRowOf('位置不一致') ?? null, 4000);
          ok(row, '前提：位置不一致行在');
          const clicked = await clickRowAiItem(row!, '①');
          ok(clicked, '行菜单 ① 点到了');
          const cfm = await untilEl(() => modalWith('即将搬回声明处'));
          ok(cfm, '确认流弹出来了（没有"建目录"那道问 —— 目标目录已存在）');
          contains(H.textsOf(cfm!, '.kbw-plan-row').join(' || '), '__p713b位偏', '预览点名这一篇');
          ok(clickModalBtn(cfm!, '搬这'), '点了主按钮');
          await H.until(() => fs.existsSync(path.join(vaultRoot, KB, DEST)), 3000);
          ok(fs.existsSync(path.join(vaultRoot, KB, DEST)), '真搬到声明处了');
          ok(!fs.existsSync(path.join(vaultRoot, KB, SRC)), '老位置没了（成对判）');
          await H.settleIndex(app);
          const items = await computeTodoItems(ctx());
          ok(
            !items.some((i) => i.id === 'position-mismatch'),
            `「位置不一致」行消失（还剩：${items.map((i) => i.id).join(',')}）`,
          );
          // 撤销 → 搬回原位
          const undo = await untilEl(() => H.currentUndoButton('撤销'));
          ok(undo, '撤销条在');
          H.click(undo!);
          await H.until(() => fs.existsSync(path.join(vaultRoot, KB, SRC)), 3000);
          ok(fs.existsSync(path.join(vaultRoot, KB, SRC)), '撤销 = 快照还原：回到原位置');
        });
      } finally {
        closeAllMenus();
        rmFix([SRC, DEST]);
        await H.settle(120);
      }
    });

    await suite.it('声明目录不存在：**建前单独问一次** —— 不建 → 没动 + 通知说明；再点建 → 目录随 mover 建、搬到、行消失、撤销连目录收回', async () => {
      const SRC = `${RES}/__p713b位偏2.md`;
      const WANT = '02_Areas/__p713b新领域';
      const DEST = `${WANT}/__p713b位偏2.md`;
      writeFix(SRC, H.note('正文。\n', { 类型: '资料', 文件位置: [WANT] }));
      await H.settleIndex(app);
      try {
        await withReveal(['位置不一致'], async () => {
          // ── 第一次：不建 ──
          const ask = await (async () => {
            const row = await untilEl(() => todoRowOf('位置不一致') ?? null, 4000);
            ok(row, '前提：位置不一致行在');
            const clicked = await clickRowAiItem(row!, '①');
            ok(clicked, '① 点到了');
            return untilEl(() => modalWith('目标目录还不存在'));
          })();
          ok(ask, '「要顺手建出来吗」单独问了一次（Q 拍定：建前问）');
          contains(H.textOf(ask!), WANT, '预览点名那个目录（拼错的也照列 —— 请用户核对）');
          __resetNotices();
          ok(clickModalBtn(ask!, '不建'), '点了"不建"');
          await H.settle(250);
          ok(!fs.existsSync(path.join(vaultRoot, KB, DEST)), '不建 → 一个文件都没动');
          ok(!fs.existsSync(path.join(vaultRoot, KB, WANT)), '不建 → 目录也没建');
          const notice = await untilEl(() => (noticesText().includes('没能搬回声明处') ? noticesText() : null), 3000);
          ok(notice, `通知说清了"没能搬回"（实际：${noticesText().slice(0, 120)}）`);
          contains(notice!, WANT, '通知里点名那个目录（原因 → 出路）');
          // ── 第二次：建 ──
          const row2 = await untilEl(() => todoRowOf('位置不一致') ?? null, 3000);
          ok(row2, '行还在（不建之后没被吞掉）');
          const clicked2 = await clickRowAiItem(row2!, '①');
          ok(clicked2, '再点 ①');
          const ask2 = await untilEl(() => modalWith('目标目录还不存在'));
          ok(ask2, '又问了一次');
          ok(clickModalBtn(ask2!, '建出来并继续'), '点了"建出来并继续"');
          const cfm = await untilEl(() => modalWith('即将搬回声明处'));
          ok(cfm, '接上主确认单（建目录并进同一单）');
          ok(clickModalBtn(cfm!, '搬这'), '搬');
          await H.until(() => fs.existsSync(path.join(vaultRoot, KB, DEST)), 3000);
          ok(fs.existsSync(path.join(vaultRoot, KB, WANT)), '目录建出来了（mover 建的，进快照）');
          ok(fs.existsSync(path.join(vaultRoot, KB, DEST)), '文件搬进去了');
          await H.settleIndex(app);
          const items = await computeTodoItems(ctx());
          ok(!items.some((i) => i.id === 'position-mismatch'), '行消失');
          // 撤销 → 文件回来、目录收回（快照的 newDirs）
          const undo = await untilEl(() => H.currentUndoButton('撤销'));
          ok(undo, '撤销条在');
          H.click(undo!);
          await H.until(() => fs.existsSync(path.join(vaultRoot, KB, SRC)), 3000);
          ok(fs.existsSync(path.join(vaultRoot, KB, SRC)), '文件回到原位');
          await H.until(() => !fs.existsSync(path.join(vaultRoot, KB, WANT)) || true, 1500);
          ok(!fs.existsSync(path.join(vaultRoot, KB, WANT)), '撤销 = 连本次新建的目录一起收回（快照 newDirs）');
        });
      } finally {
        closeAllMenus();
        rmFix([SRC, DEST]);
        try {
          fs.rmSync(path.join(vaultRoot, KB, WANT), { recursive: true, force: true });
        } catch {
          /* 已经没了 */
        }
        await H.settle(120);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑤ E2 重复保最新 + E3 孤儿挪待清理
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13b · E2 重复文件保最新一份 / E3 孤儿附件挪待清理', async () => {
    await suite.it('E2：① → 确认单点名"较旧那件"（保 mtime 最新）→ 回收站 → 行消失 → 撤销还原', async () => {
      const A = `${RES}/__p713b重复甲.bin`; // 旧
      const B = `${RES}/__p713b重复乙.bin`; // 新
      /**
       * ⚠️ 夹具库**没有**现成的重复组（旧资料那 4 篇看着像，其实内容各不相同 ——
       * 第一版按"逐字节相同"假设写过，跑出来是 4 篇都还在，当场证伪）。这行的出现
       * 完全由下面这对夹具撑着 —— "跑完行消失"因此是确定性的。
       */
      writeFix(A, 'SAME-CONTENT-P713B');
      writeFix(B, 'SAME-CONTENT-P713B');
      const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      fs.utimesSync(path.join(vaultRoot, KB, A), past, past); // 甲 = 三天前的
      await H.settleIndex(app);
      try {
        await withReveal(['文件内容重复'], async () => {
          const row = await untilEl(() => todoRowOf('文件内容重复') ?? null, 4000);
          ok(row, '前提：重复行在');
          const clicked = await clickRowAiItem(row!, '①');
          ok(clicked, '① 点到了');
          const cfm = await untilEl(() => modalWith('重复文件只留最新的一份'));
          ok(cfm, '确认流弹出来了');
          /**
           * ⚠️ 断"哪件进回收站"要看**落点格**（`.kbw-plan-kind` = 被清的文件名）——
           * 整行文本里"与《乙》内容相同"也带着乙（那正是"留着"的说明），
           * 拿 `includes('乙')` 直接判会假红（第一版就这么栽的）。
           */
          const prev = H.textsOf(cfm!, '.kbw-plan-row').join(' || ');
          const kinds = H.qa<HTMLElement>(cfm!, '.kbw-plan-row .kbw-plan-kind').map((k) => H.textOf(k));
          ok(kinds.includes('《__p713b重复甲.bin》'), `较旧那件（甲）在"将清"名单里：${prev.slice(0, 160)}`);
          ok(!kinds.includes('《__p713b重复乙.bin》'), '较新那件（乙）不在名单里（它是"留着"的那份）');
          contains(prev, '修改更晚', '每行写清替谁让路');
          ok(clickModalBtn(cfm!, '清这'), '点了主按钮');
          await H.until(() => !fs.existsSync(path.join(vaultRoot, KB, A)), 3000);
          ok(!fs.existsSync(path.join(vaultRoot, KB, A)), '甲进了回收站');
          ok(fs.existsSync(path.join(vaultRoot, KB, B)), '乙留着');
          await H.settleIndex(app);
          const items = await computeTodoItems(ctx());
          ok(
            !items.some((i) => i.id === 'dup-files'),
            `「重复文件」行消失（还剩：${items.map((i) => i.id).join(',')}）`,
          );
          const undo = await untilEl(() => H.currentUndoButton('撤销'));
          ok(undo, '撤销条在');
          H.click(undo!);
          await H.until(() => fs.existsSync(path.join(vaultRoot, KB, A)), 3000);
          ok(fs.existsSync(path.join(vaultRoot, KB, A)), '撤销：甲回来了');
        });
      } finally {
        closeAllMenus();
        rmFix([A, B]);
        await H.settle(120);
      }
    });

    await suite.it('P7.14：两篇「空壳笔记」不算内容重复 —— 改走「还没写内容」行（真机反馈修正）', async () => {
      /**
       * 场景（用户真机 2026-10-08）：新建两篇空笔记（各有自动前言、正文空白、逐字相同）
       * → 此前被算成"一组文件内容重复"。现在：空壳不进重复候选，改报「还没写内容」。
       */
      const A = `${KB}/00_Inbox/__p714空壳甲.md`;
      const B = `${KB}/00_Inbox/__p714空壳乙.md`;
      const shell = '---\n创建日期: 2026-10-08\ntags: []\n---\n\n';
      H.writeNote(vaultRoot, A, shell);
      H.writeNote(vaultRoot, B, shell);
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      try {
        let items = await computeTodoItems(ctx());
        ok(
          !items.some((i) => i.id === 'dup-files'),
          `两篇空壳不许算重复（还剩：${items.map((i) => i.id).join(',')}）`,
        );
        const row = items.find((i) => i.id === 'empty-file');
        ok(row, '「还没写内容」行在');
        contains(row!.text, '还没写内容', '行文案（P7.14 新口径）');
        ok(row!.count >= 2, `空壳被算进这行（count=${row!.count}）`);

        // 对照：给两篇**同样的非空正文** → 又该报重复（口径别放宽成"永远不报"）
        H.writeNote(vaultRoot, A, `${shell}同一段正文\n`);
        H.writeNote(vaultRoot, B, `${shell}同一段正文\n`);
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app);
        items = await computeTodoItems(ctx());
        ok(
          items.some((i) => i.id === 'dup-files'),
          `同样的非空内容照旧报重复（还剩：${items.map((i) => i.id).join(',')}）`,
        );
      } finally {
        rmFix([A, B]);
        await H.settle(120);
      }
    });

    await suite.it('E3：① → 确认 → 挪进 99_Meta/05_待清理（目录随 mover 建）→ 行消失 → 撤销收回', async () => {
      const ORPHAN = `${RES}/__p713b孤儿.png`;
      writeFix(ORPHAN, 'ORPHAN-BYTES-P713B');
      await H.settleIndex(app);
      const destAbs = path.join(vaultRoot, KB, META_CLEAN, '__p713b孤儿.png');
      try {
        await withReveal(['附件没人引用'], async () => {
          const row = await untilEl(() => todoRowOf('附件没人引用') ?? null, 4000);
          ok(row, '前提：孤儿行在');
          const clicked = await clickRowAiItem(row!, '①');
          ok(clicked, '① 点到了');
          const cfm = await untilEl(() => modalWith('没人引用的附件挪到'));
          ok(cfm, '确认流弹出来了');
          contains(H.textsOf(cfm!, '.kbw-plan-row').join(' || '), '__p713b孤儿.png', '预览点名那件');
          contains(H.textOf(cfm!), '只挪不删', '说明写着"只挪不删"（E3 的口径）');
          ok(clickModalBtn(cfm!, '挪这'), '点了主按钮');
          await H.until(() => fs.existsSync(destAbs), 3000);
          ok(fs.existsSync(destAbs), `挪进 ${META_CLEAN}/ 了`);
          ok(!fs.existsSync(path.join(vaultRoot, KB, ORPHAN)), '老位置没了（成对判）');
          await H.settleIndex(app);
          const items = await computeTodoItems(ctx());
          ok(
            !items.some((i) => i.id === 'orphan-files'),
            `「附件没人引用」行消失（还剩：${items.map((i) => i.id).join(',')}）`,
          );
          // 撤销 → 收回原位（**目录也收回** —— 独立审 🟢2：原来这里只有注释、没有断言）
          const undo = await untilEl(() => H.currentUndoButton('撤销'));
          ok(undo, '撤销条在');
          H.click(undo!);
          await H.until(() => fs.existsSync(path.join(vaultRoot, KB, ORPHAN)), 3000);
          ok(fs.existsSync(path.join(vaultRoot, KB, ORPHAN)), '撤销：附件回到原位');
          await H.until(() => !fs.existsSync(path.join(vaultRoot, KB, META_CLEAN)), 3000);
          ok(
            !fs.existsSync(path.join(vaultRoot, KB, META_CLEAN)),
            '撤销：本次新建的落点目录也收回（快照 newDirs —— 夹具库本来没有它）',
          );
        });
      } finally {
        closeAllMenus();
        rmFix([ORPHAN]);
        try {
          fs.rmSync(path.join(vaultRoot, KB, META_CLEAN), { recursive: true, force: true });
        } catch {
          /* 已经没了 */
        }
        await H.settle(120);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑥ ② 一键完全处理（面板型 await · 串行 · 取消跳过 · 汇总）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13b · ② 一键完全处理（串行语义）', async () => {
    await suite.it('面板型动作**等面板关**才收尾（② 靠这一份 await 串行 —— Q23；三条映射各点对面板）', async () => {
      /**
       * 用假 item 直接调 `runRowAction`（只用到 id）：面板开着时这个 Promise
       * **不许 settle**；关掉面板它才回来。⏱ 给 400ms 宽限（异步跳转/frame）。
       * ⚠️ 三条面板型映射逐条走（独立审 🟡3：原来 **migrate 分支离线零覆盖** ——
       * 只在这条的"不置灰"循环里出现过 id；这里补上"开的是属性迁移面板 + 等关"）。
       * 失效双链在未配 AI 时**也开面板**（卡里写"没配 AI"，AI 只在配置时才跑）。
       */
      for (const [id, panelTitle] of [
        ['placeholder-title', 'AI 起标题'],
        ['migrate', '属性迁移'],
        ['broken-link', 'AI 修链'],
      ] as const) {
        const p = runRowAction(ctx(), itemOf(id));
        let settled = false;
        void p.then(() => {
          settled = true;
        });
        const panel = await untilEl(() => modalWith(panelTitle));
        ok(panel, `${id} → 「${panelTitle}」面板开了`);
        await H.settle(400);
        ok(!settled, `${id}：面板还开着 → Promise 没收尾（串行就靠这一下）`);
        H.keydown(document.body, 'Escape');
        await H.until(() => settled, 3000);
        ok(settled, `${id}：关掉面板 → 收尾（下一行才开始）`);
        await H.settle(120);
      }
    });

    await suite.it('逐条串行：取消 = 跳过继续；跑完汇总「完成 X 行 / 跳过 Y 行」（外改行置灰跳过并写明原因）', async () => {
      const ORPHAN = `${RES}/__p713b串行孤儿.png`;
      const EXT = `${RES}/__p713b外改.md`;
      writeFix(ORPHAN, 'ORPHAN-BYTES-P713B-SEQ');
      writeFix(EXT, H.note('外改前。\n', { 类型: '资料' }));
      H.externalWrite(app, `${KB}/${EXT}`, H.note('外改后 —— 别处改的。\n', { 类型: '资料' }));
      await H.settleIndex(app);
      const destAbs = path.join(vaultRoot, KB, META_CLEAN, '__p713b串行孤儿.png');
      /**
       * 把**其余全部行**忽略掉（homeDismissed），清单只剩我们控制的两条：
       * · `orphan-files`（蓝）—— 可跑；
       * · `external-change`（黄）—— 置灰档（跳过 + 原因）。
       * 序 = 严重度降序 → 外改先（跳过），孤儿后（真跑）。
       */
      const prevDismissed = ctx().settings.get().homeDismissed.slice();
      try {
        const allIds = (await computeTodoItems(ctx())).map((i) => i.id);
        ok(allIds.includes('orphan-files'), `前提：孤儿行在（当前：${allIds.join(',')}）`);
        ok(allIds.includes('external-change'), '前提：外改行在（外部写入打的旗标）');
        await ctx().settings.save({
          homeDismissed: allIds.filter((id) => id !== 'orphan-files' && id !== 'external-change'),
        });
        await ensureHome();
        await H.settle(200);
        const box = H.qa<HTMLElement>(document.body, '.kbw-hblock').find((b) => b.dataset.block === 'todo');
        ok(box, '前提：待处理块在');
        // ── 第一趟：确认单里点取消 → 孤儿行"没弄掉" → 跳过继续、汇总照样出 ──
        {
          const head = box!.querySelector('.kbw-sec-head h3') as Element;
          const r = head.getBoundingClientRect();
          head.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5 }),
          );
          const item = await untilEl(() => menuItem('✦ 一键完全处理') ?? null);
          ok(item, '块菜单一级项「✦ 一键完全处理」在');
          __resetNotices();
          H.click(item!);
          const cfm = await untilEl(() => modalWith('没人引用的附件挪到'));
          ok(cfm, '第一行（孤儿 → E3）的确认流弹出来了 —— 置灰档不弹框、直接记跳过');
          H.keydown(document.body, 'Escape'); // 取消 = 跳过这一行
          await H.settle(200);
          const summary = await untilEl(
            () => (noticesText().includes('一键完全处理：完成') ? noticesText() : null),
            8000,
          );
          ok(summary, `汇总通知出来了（实际：${noticesText().slice(0, 160)}）`);
          contains(summary!, '完成 0 行 / 跳过 2 行', '取消 = 跳过继续（两条都跳）；外改那条先跳的也计数');
          contains(summary!, '没弄掉：', '被取消的那行按"还剩几"如实记（复算清单得出的）');
          contains(summary!, '亲自过目', '外改行的跳过原因写明（Q24 的置灰原因同一份文案）');
          ok(fs.existsSync(path.join(vaultRoot, KB, ORPHAN)), '取消 → 文件没动');
        }
        // ── 第二趟：确认 → 真跑完 → 汇总 完成 1 / 跳过 1 ──
        {
          const head = box!.querySelector('.kbw-sec-head h3') as Element;
          const r = head.getBoundingClientRect();
          head.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 5 }),
          );
          const item = await untilEl(() => menuItem('✦ 一键完全处理') ?? null);
          ok(item, '块菜单项在（第二趟）');
          __resetNotices();
          H.click(item!);
          const cfm = await untilEl(() => modalWith('没人引用的附件挪到'));
          ok(cfm, '确认流弹出');
          ok(clickModalBtn(cfm!, '挪这'), '这次点了"挪这 N 件"');
          const summary = await untilEl(
            () => (noticesText().includes('一键完全处理：完成') ? noticesText() : null),
            8000,
          );
          ok(summary, `第二趟汇总出来了（实际：${noticesText().slice(0, 160)}）`);
          contains(summary!, '完成 1 行 / 跳过 1 行', '孤儿行真弄掉了（跑完行消失 = 完成）');
          contains(summary!, '亲自过目', '外改行仍如实记跳过原因');
          ok(fs.existsSync(destAbs), '附件真挪到待清理了');
        }
      } finally {
        closeAllMenus();
        await ctx().settings.save({ homeDismissed: prevDismissed });
        rmFix([ORPHAN, EXT]);
        try {
          fs.rmSync(path.join(vaultRoot, KB, META_CLEAN), { recursive: true, force: true });
        } catch {
          /* 已经没了 */
        }
        await H.settle(150);
      }
    });

    await suite.it('外改行的 ① 在菜单上置灰并写明原因（Q24 的界面档）', async () => {
      const EXT = `${RES}/__p713b外改2.md`;
      writeFix(EXT, H.note('外改前。\n', { 类型: '资料' }));
      H.externalWrite(app, `${KB}/${EXT}`, H.note('外改后。\n', { 类型: '资料' }));
      await H.settleIndex(app);
      try {
        await withReveal(['外部改动'], async () => {
          const row = await untilEl(() => todoRowOf('外部改动') ?? null, 4000);
          ok(row, '前提：外改行在');
          const r = row!.getBoundingClientRect();
          row!.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10 }),
          );
          const ai = await untilEl(() => menuItem('✦ AI 自动处理') ?? null);
          ok(ai, '行菜单在');
          ai!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          const sub = await untilEl(() => {
            const all = H.qa<HTMLElement>(document.body, '.kbw-menu');
            return all.reverse().find((x) => H.textOf(x).includes('自动处理本条')) ?? null;
          });
          ok(sub, '子菜单在');
          const one = H.qa<HTMLElement>(sub!, '.kbw-menu-item').find((i) =>
            H.textOf(i).startsWith('①'),
          );
          ok(one, '① 在');
          ok(one!.classList.contains('is-disabled'), '① 置灰（外改没有自动动作 —— Q24）');
          contains(H.textOf(one!), '亲自过目', '置灰原因写在行上（不是"点了没反应"）');
        });
      } finally {
        closeAllMenus();
        rmFix([EXT]);
        await H.settle(120);
      }
    });
  });
}
