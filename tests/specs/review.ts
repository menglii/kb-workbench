/**
 * spec：**回顾（P8 期 2–4）**—— 数据 + 手动建卡 + 复习流程 + AI 出稿
 *
 * 对应计划的 §5.1–§5.3（期 2/3/4 那几组）：存取往返 · 手动建卡（含**取消确认一个字节都不写**的反例）·
 * **改名迁键**（不改名时不许动）· **不写属性**（来源笔记 frontmatter 逐字节不变）·
 * 面板列表与删除 · 纯函数（调度/到期/迁键）· 复习浮层（翻面/三键/小结）· 今日筛选 ·
 * AI 出稿（可改可删 → 确认流 → 一次落盘；四个反例）。
 *
 * 两条本文件自己的纪律：
 *   · **建卡链走真链路**（`createReviewCardFlow`：对话框 → 确认流 → 落库），不直接调 `addCard`
 *     —— 直接调的话"确认流漏了"这件事永远绿（P6② 那条"纯函数有判据 ≠ 接线有判据"）
 *   · 每条自己收场（删夹具 / 让对话框与确认流退出），别把浮层留给下一条
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import {
  ReviewRefusedError,
  addDays,
  applyGrade,
  cardIncomplete,
  countTally,
  dueCards,
  emptyTally,
  newCard,
  noteLabel,
  pruneCards,
  remapCards,
  sameCards,
  startOfDay,
  type ReviewCard,
} from '../../src/services/review';
import { AiParseError, buildReviewMessages, parseReview } from '../../src/services/ai/prompt';
import { createReviewCardFlow } from '../../src/ui/review-create';
import { runReviewGen } from '../../src/ui/review-gen';
import { __resetNotices } from '../../src/ui/notify';
import { showNoteMenu } from '../../src/modules/notes/menus';
import { closeAllMenus } from '../../src/ui/menu';

const KB = '01_新知识库';
const CARD_REL = `${KB}/99_Meta/06_工作台/复习.json`;
const FIX = `${KB}/00_Inbox/__回顾夹具.md`;

const mk = (id: string, note: string): ReviewCard => ({
  id,
  note,
  front: `问 ${id}`,
  back: `答 ${id}`,
  createdAt: 0,
  lastReview: null,
  nextReview: 0,
  interval: 1,
  reps: 0,
  lapses: 0,
});

export async function specReview(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const abs = (rel: string) => path.join(vaultRoot, rel);
  const cardsRaw = (): string => (fs.existsSync(abs(CARD_REL)) ? fs.readFileSync(abs(CARD_REL), 'utf8') : '');
  const cardsOf = (): ReviewCard[] => {
    const raw = cardsRaw();
    return raw ? (JSON.parse(raw).cards as ReviewCard[]) : [];
  };
  /**
   * 清掉卡片文件。⚠️ **必须走桩的 `vault.delete`**，不能用 `fs.rmSync`：后者只动盘、
   * 桩的 `byPath` 还留着那个 TFile —— 下一次写就是 `vault.process` 一个盘上不存在的文件
   *（`ENOENT`）。本仓记过这类"绕开桩"的账。
   */
  const purgeCards = async (): Promise<void> => {
    const f = app.vault.getAbstractFileByPath(CARD_REL);
    if (f) await app.vault.delete(f);
  };
  /** 收干净浮层（上一条若抛错，它的收尾不会执行 —— 起手先收一次） */
  const sweep = (): void => {
    while (H.maybe(document.body, '.kbw-modal')) {
      H.keydown(document.body, 'Escape');
    }
    closeAllMenus();
  };

  // ════════════════════════════════════════════════════════════
  await suite.group('P8 · 纯函数：调度与迁键（判据断得清的那一半）', async () => {
    await suite.it('新卡：间隔 1、今天到期（当天 0 点）、四个计数字段从 0 起', () => {
      const now = new Date(2026, 9, 10, 15, 30).getTime(); // 2026-10-10 15:30 本地
      const c = newCard(`${KB}/a.md`, '  问题  ', ' 答案 ', now, 'rv-test');
      eq(c.id, 'rv-test', 'id 可注入（用例要确定性）');
      eq(c.front, '问题', '正反面 trim');
      eq(c.back, '答案', '正反面 trim');
      eq(c.interval, 1, '间隔 1 天');
      eq(c.nextReview, startOfDay(now), 'nextReview = 当天 0 点（不是 now —— 否则今天建的卡要等到明天同一时刻）');
      eq(c.lastReview, null, '还没复习过');
      eq(c.reps, 0, '次数从 0 起');
      eq(c.lapses, 0, '忘记数从 0 起');
      ok(!cardIncomplete(c.front, c.back), '两面都填了 → 不算残缺');
      ok(cardIncomplete('问题', '  '), '背面只有空白 → 算残缺');
    });

    await suite.it('今日到期的边界：昨天算 · 今天建的算 · 明天不算（跨天也认）', () => {
      const today = new Date(2026, 9, 10, 9, 0).getTime();
      const at = (y: number, m: number, d: number) => new Date(y, m, d, 8, 0).getTime();
      const cards = [
        { ...mk('y', `${KB}/a.md`), nextReview: at(2026, 9, 9) }, // 昨天到期
        { ...mk('t', `${KB}/a.md`), nextReview: at(2026, 9, 10) }, // 今天
        { ...mk('m', `${KB}/a.md`), nextReview: at(2026, 9, 11) }, // 明天
        { ...mk('old', `${KB}/a.md`), nextReview: at(2026, 8, 1) }, // 逾期很久
      ];
      const due = dueCards(cards, today).map((c) => c.id).sort();
      eq(due.join(','), 'old,t,y', '到期 = 逾期 + 今天；明天那张不在里面');
      eq(
        dueCards([{ ...mk('x', `${KB}/a.md`), nextReview: startOfDay(today) }], today).length,
        1,
        '今天建的卡（nextReview = 当天 0 点）当天就算到期',
      );
    });

    await suite.it('改名迁键：精确命中 + 整目录前缀；**没命中就原样返回**（调用方据此不写盘）', () => {
      const cards = [
        mk('a', `${KB}/02_Areas/x.md`),
        mk('b', `${KB}/02_Areas/子/y.md`),
        mk('c', `${KB}/03_Resources/z.md`),
      ];
      // ① 改一篇笔记的名
      const r1 = remapCards(cards, `${KB}/02_Areas/x.md`, `${KB}/02_Areas/x2.md`);
      eq(r1[0].note, `${KB}/02_Areas/x2.md`, '精确命中：那一篇跟着迁');
      eq(r1[1].note, `${KB}/02_Areas/子/y.md`, '子目录那篇**不受影响**');
      // ② 改文件夹名（平台上是一个 rename 事件）→ 底下整片跟着迁
      const r2 = remapCards(cards, `${KB}/02_Areas`, `${KB}/01_Projects`);
      eq(
        r2.map((c) => c.note).join('|'),
        [`${KB}/01_Projects/x.md`, `${KB}/01_Projects/子/y.md`, `${KB}/03_Resources/z.md`].join('|'),
        '整目录前缀命中：底下两篇都迁、外面那篇不动',
      );
      // ③ 没命中 → 逐字段原样（`sameCards` 也为真 → 调用方不写盘）
      const r3 = remapCards(cards, `${KB}/别的/a.md`, `${KB}/别的/b.md`);
      ok(sameCards(cards, r3), '没命中时原样返回（`不改名时不许动` 靠这一条）');
      ok(sameCards(cards, cards), '同一份 → 相同');
      ok(!sameCards(cards, r1), '迁过 → 不相同');
      // ④ 边界：空串 / 同路径 / 前缀近似（`02_Areas2` 不该被 `02_Areas` 命中）
      ok(sameCards(cards, remapCards(cards, '', `${KB}/x.md`)), 'oldPath 空 → 不动');
      ok(sameCards(cards, remapCards(cards, `${KB}/02_Areas`, `${KB}/02_Areas`)), '新旧相同 → 不动');
      const r5 = remapCards([mk('n', `${KB}/02_Areas2/n.md`)], `${KB}/02_Areas`, `${KB}/P`);
      eq(r5[0].note, `${KB}/02_Areas2/n.md`, '前缀近似（02_Areas2）**不许**被 02_Areas 命中');
    });

    await suite.it('删掉来源笔记：剪掉它的卡；没命中不写盘；来源短名取 basename', () => {
      const cards = [mk('a', `${KB}/a.md`), mk('b', `${KB}/b.md`)];
      const pruned = pruneCards(cards, `${KB}/a.md`);
      eq(pruned.length, 1, '剪掉 1 张');
      eq(pruned[0].id, 'b', '剪的是那一篇的卡');
      ok(sameCards(cards, pruneCards(cards, `${KB}/c.md`)), '没有那一篇的卡 → 原样（不写盘）');
      eq(noteLabel(`${KB}/02_Areas/内容创作/写作选题库.md`), '写作选题库', '短名 = basename 去掉 .md');
      /**
       * **删整个目录**（与改名侧对称 —— 独立审 2026-10-10 指出的不对称）：
       * 平台删文件夹时发的是**那一个** delete 事件，只认精确命中会把底下所有卡留成死键。
       */
      eq(
        pruneCards(
          [mk('a', `${KB}/02_Areas/x.md`), mk('b', `${KB}/02_Areas/子/y.md`), mk('c', `${KB}/zz.md`)],
          `${KB}/02_Areas`,
        )
          .map((c) => c.id)
          .join(','),
        'c',
        '删整个目录：底下那两篇的卡一起剪掉，外面那篇的卡留着',
      );
      ok(
        sameCards(
          [mk('a', `${KB}/02_Areas2/x.md`)],
          pruneCards([mk('a', `${KB}/02_Areas2/x.md`)], `${KB}/02_Areas`),
        ),
        '前缀近似（02_Areas2）**不许**被 02_Areas 剪掉',
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P8 · 数据：库内 复习.json 的存取', async () => {
    await suite.it('文件不存在时读 → 空表（**不写盘**）', async () => {
      sweep();
      await purgeCards();
      const file = await ctx().review.load();
      eq(file.version, 1, 'version 是 1（它将来要能按版本迁移）');
      eq(file.cards.length, 0, '没有卡');
      ok(!fs.existsSync(abs(CARD_REL)), '读不创建文件（谁的期谁负责第一次落盘）');
      eq(ctx().review.cached(), null, '同步缓存没热过 → null（菜单按"这项先不画"处理）');
    });

    await suite.it('addCard → 落盘 → 重新读盘还在（走 config-files，不是裸写）', async () => {
      sweep();
      await purgeCards();
      const card = await ctx().review.addCard({ note: `${KB}/00_Inbox/甲.md`, front: 'Q1', back: 'A1' });
      ok(fs.existsSync(abs(CARD_REL)), '第一次 addCard 负责把文件建出来');
      const onDisk = JSON.parse(cardsRaw());
      eq(onDisk.version, 1, '落盘的 version');
      eq(onDisk.cards.length, 1, '落盘 1 张');
      eq(onDisk.cards[0].id, card.id, 'id 一致');

      // 换个"新实例"再读一遍：真的从盘上回来了
      const again = await ctx().review.load();
      eq(again.cards.length, 1, '重新读盘还在');
      eq(again.cards[0].front, 'Q1', '正面还在');
      // 缓存也热了（菜单要用）
      eq(ctx().review.cached()?.cards.length, 1, 'cached() 能同步读到');
      eq(ctx().review.cardsOf(ctx().review.cached(), `${KB}/00_Inbox/甲.md`).length, 1, '按笔记查得到');

      ok(await ctx().review.removeCard(card.id), '删掉 → true');
      eq(cardsOf().length, 0, '盘上没了');
      ok(!(await ctx().review.removeCard(card.id)), '再删一次 → false（不炸）');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P8 · 数据防线：文件坏了**不许写**（不覆盖用户卡片）', async () => {
    /**
     * 为什么这一组是**最要紧**的：`复习.json` 是用户数据、而且被鼓励手改
     *（面板头就写着「库内文件：…」）。解析失败时若照"空表"往下走，一次
     * read-modify-write 就会把用户所有卡片**整份覆盖掉**（独立审 2026-10-10 🔴）。
     * 所以这组钉两件事：① 坏文件时**拒写**并报出原因 ② 盘上那个文件**逐字节不变**
     *（用户的坏文件至少还在，他能自己修）。
     */
    const breakIt = async (text: string): Promise<void> => {
      await app.vault.process(H.fileAt(app, CARD_REL), () => text);
      await H.settle(150);
    };

    await suite.it('坏 JSON：loadDetailed 报 broken、四个写口全部拒写、盘上逐字节不变', async () => {
      sweep();
      await purgeCards();
      await ctx().review.addCard({ note: `${KB}/00_Inbox/甲.md`, front: 'Q', back: 'A' });
      const brokenText = '{ 这是手改坏的 JSON，少了引号与括号';
      await breakIt(brokenText);

      const res = await ctx().review.loadDetailed();
      ok(res.broken, `loadDetailed 报出"读不动"（实际 ${JSON.stringify(res.broken)}）`);
      eq(res.exists, true, '它是"存在但坏了"，不是"还没建"（两者必须分得开）');

      let threw: unknown = null;
      try {
        await ctx().review.addCard({ note: `${KB}/00_Inbox/甲.md`, front: 'Q2', back: 'A2' });
      } catch (e) {
        threw = e;
      }
      ok(threw instanceof ReviewRefusedError, `加卡被拒（实际 ${String(threw)}）`);
      eq(
        // 四个写口都验一遍：删卡 / 迁键 / 剪枝
        await Promise.all([
          ctx().review.removeCard('随便一个 id').then(() => 'no-throw').catch(() => 'refused'),
          ctx().review.remapNote(`${KB}/a.md`, `${KB}/b.md`).then(() => 'no-throw').catch(() => 'refused'),
          ctx().review.pruneNote(`${KB}/a.md`).then(() => 'no-throw').catch(() => 'refused'),
        ]).then((r) => r.join(',')),
        'refused,refused,refused',
        '删卡 / 迁键 / 剪枝三条写口同样拒写',
      );
      eq(cardsRaw(), brokenText, '★ 盘上那个文件**逐字节没动**（用户的坏文件还在，他能自己修）');
    });

    await suite.it('不认识的 version（如 2）：当"读不动"处理，不许按 v1 写回去', async () => {
      sweep();
      await purgeCards();
      await ctx().review.addCard({ note: `${KB}/00_Inbox/甲.md`, front: 'Q', back: 'A' });
      const v2Text = JSON.stringify({ version: 2, cards: [] }, null, 2) + '\n';
      await breakIt(v2Text);

      const res = await ctx().review.loadDetailed();
      contains(String(res.broken), 'version', '报出"版本不认识"这件事');
      let threw: unknown = null;
      try {
        await ctx().review.addCard({ note: `${KB}/00_Inbox/甲.md`, front: 'Q2', back: 'A2' });
      } catch (e) {
        threw = e;
      }
      ok(threw instanceof ReviewRefusedError, '一样拒写（不把 v2 降级写成 v1）');
      eq(cardsRaw(), v2Text, '盘上逐字节没动');
    });

    await suite.it('修好之后（写回合法 JSON）→ 又能写了（拒写是"这一次不写"，不是"永久坏掉"）', async () => {
      sweep();
      await purgeCards();
      await ctx().review.addCard({ note: `${KB}/00_Inbox/甲.md`, front: 'Q', back: 'A' });
      const saved = cardsRaw();
      await breakIt('坏');
      ok((await ctx().review.loadDetailed()).broken, '先确认这会儿是坏的');
      await app.vault.process(H.fileAt(app, CARD_REL), () => saved);
      await H.settle(150);
      const card = await ctx().review.addCard({ note: `${KB}/00_Inbox/甲.md`, front: 'Q2', back: 'A2' });
      eq(cardsOf().length, 2, '修好之后照常写（原有那张也还在）');
      contains(cardsOf().map((c) => c.back).join(','), card.back, '新加的那张落盘了');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P8 · 手动建卡：菜单 → 对话框 → 确认流 → 落库', async () => {
    /** 建一条来源笔记（真链路要用真文件；`fileAt` 按插件 API 的 TFile 形状取） */
    const seedNote = (rel: string, title: string): void => {
      H.writeNote(vaultRoot, rel, H.note(`# ${title}\n`, { 收藏: false }));
      app.vault.rescan();
      ctx().index.rebuild();
    };

    await suite.it('笔记右键菜单里有「生成回顾卡」（已有张数走同步缓存，没热过就不显示）', async () => {
      sweep();
      seedNote(FIX, '回顾夹具');
      const items = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-menu-item');
      const openMenu = (): void =>
        showNoteMenu(
          { path: FIX, basename: '__回顾夹具', props: {}, effectivePosition: '00_Inbox' } as never,
          new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }),
          {
            ctx: {
              index: { tags: () => [], notes: () => [] },
              configs: { cached: () => null },
              settings: { get: () => ({ homeCards: null }), kbRoot: () => KB },
              app: { vault: { getAllLoadedFiles: () => [] } },
              review: ctx().review,
            },
            ops: {
              revealBlockReason: () => null,
              fileListBlockReason: () => null,
              setProp: () => undefined,
              changeTags: () => undefined,
            },
            onRename: () => undefined,
            onExpandAll: () => undefined,
          } as never,
        );

      /**
       * ⚠️ **两条回顾卡入口收在子菜单里**（P8 期 4 收尾：笔记菜单一级是**硬 ≤8 项**，
       * 那条判据在 `tests/specs/notes.ts`）—— 所以先认父项「回顾卡」，
       * **点开它**再认子项；子项的 DOM 要父项展开之后才有。
       */
      const parentItem = (): HTMLElement | undefined =>
        items().find((i) => H.textOf(i).replace(/\s+/g, '').startsWith('回顾卡'));

      await purgeCards();
      await ctx().review.load(); // 让缓存热一次（load 会经 configs.read → 写 cache）
      openMenu();
      const parent = parentItem();
      ok(parent, `菜单一级有「回顾卡」（实际 ${items().map((i) => H.textOf(i)).join(' | ')}）`);
      H.click(parent as HTMLElement);
      await H.settle(80);
      const entry = items().find((i) => H.textOf(i).includes('生成回顾卡'));
      ok(entry, `子菜单里有「生成回顾卡」（实际 ${items().map((i) => H.textOf(i)).join(' | ')}）`);
      ok(!H.textOf(entry as HTMLElement).includes('已有'), '一张卡都没有时不显示"已有 N 张"');
      closeAllMenus();
      await H.settle(60);

      // 建两张 → 再开菜单 → 点开父项 → 提示里报得出张数
      await ctx().review.addCard({ note: FIX, front: 'Q', back: 'A' });
      await ctx().review.addCard({ note: FIX, front: 'Q2', back: 'A2' });
      openMenu();
      H.click(parentItem() as HTMLElement);
      await H.settle(80);
      const entry2 = items().find((i) => H.textOf(i).includes('生成回顾卡'));
      contains(H.textOf(entry2 as HTMLElement), '已有 2 张', '提示里报已有的张数');
      closeAllMenus();
      await H.settle(60);
    });

    await suite.it('走完整链：填两面 → 下一步 → 确认流（预览里有正反面）→ 落库；**来源笔记逐字节不变**', async () => {
      sweep();
      await purgeCards();
      seedNote(FIX, '回顾夹具');
      const before = H.readNote(vaultRoot, FIX);

      const flow = createReviewCardFlow(ctx(), FIX);
      await H.settle(80);
      const dlg = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(dlg, '对话框开了');
      contains(H.textOf(dlg), '回顾夹具', '标题里点名挂在谁身上');
      const tas = H.qa<HTMLTextAreaElement>(dlg, 'textarea.kbw-review-input');
      eq(tas.length, 2, '两面两个输入框');
      tas[0].value = '什么是间隔重复？';
      tas[1].value = '按固定间隔把卡片再问一遍。';
      H.click(
        H.qa<HTMLElement>(dlg, '.kbw-btn').find((b) => H.textOf(b).includes('下一步')) as HTMLElement,
      );
      await H.settle(80);

      const cf = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(cf, '确认流开了（硬规矩 #3：动库前必须过 confirm）');
      contains(H.textOf(cf), '即将新建回顾卡', '确认单标题说清动作');
      contains(H.textOf(cf), '什么是间隔重复？', '预览里能看见正面');
      contains(H.textOf(cf), '按固定间隔把卡片再问一遍。', '预览里能看见背面');
      contains(H.textOf(cf), '不拍快照', '快照那句被换成真话（不动笔记就不该承诺快照）');
      H.click(
        H.qa<HTMLElement>(cf, '.kbw-btn').find((b) => H.textOf(b).includes('新建这张卡')) as HTMLElement,
      );
      await H.settle(120);

      eq(await flow, true, '整条链返回"建了"');
      const cards = cardsOf();
      eq(cards.length, 1, '盘上 1 张卡');
      eq(cards[0].note, FIX, 'note = 来源笔记（库内路径）');
      eq(cards[0].front, '什么是间隔重复？', '正面落库');
      eq(cards[0].back, '按固定间隔把卡片再问一遍。', '背面落库');
      eq(H.readNote(vaultRoot, FIX), before, '**来源笔记逐字节不变**（不写属性、不碰正文）');
    });

    await suite.it('反例：确认流里取消 → **一个字节都不写**', async () => {
      sweep();
      await purgeCards();
      seedNote(FIX, '回顾夹具');

      const flow = createReviewCardFlow(ctx(), FIX);
      await H.settle(80);
      const dlg = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const tas = H.qa<HTMLTextAreaElement>(dlg, 'textarea.kbw-review-input');
      tas[0].value = 'Q';
      tas[1].value = 'A';
      H.click(
        H.qa<HTMLElement>(dlg, '.kbw-btn').find((b) => H.textOf(b).includes('下一步')) as HTMLElement,
      );
      await H.settle(80);
      const cf = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      H.click(
        H.qa<HTMLElement>(cf, '.kbw-btn').find((b) => H.textOf(b).includes('取消')) as HTMLElement,
      );
      await H.settle(100);

      eq(await flow, false, '取消 → 链返回 false');
      ok(!fs.existsSync(abs(CARD_REL)), '确认流取消 → 复习.json 连文件都没建出来');
    });

    await suite.it('反例：对话框里就取消（Esc）→ 也不写；两面没填完不许过', async () => {
      sweep();
      await purgeCards();
      seedNote(FIX, '回顾夹具');

      const flow = createReviewCardFlow(ctx(), FIX);
      await H.settle(80);
      let dlg = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const tas = H.qa<HTMLTextAreaElement>(dlg, 'textarea.kbw-review-input');
      // 只填正面 → 点下一步 → 拦住（既不关框、也不写盘）
      tas[0].value = '只有正面';
      H.click(
        H.qa<HTMLElement>(dlg, '.kbw-btn').find((b) => H.textOf(b).includes('下一步')) as HTMLElement,
      );
      await H.settle(60);
      dlg = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      contains(H.textOf(dlg), '背面', '拦住并说明是哪一面没填');
      ok(!fs.existsSync(abs(CARD_REL)), '被拦住时一个字节都没写');

      H.keydown(document.body, 'Escape');
      await H.settle(80);
      eq(await flow, false, 'Esc 取消 → 链返回 false');
      ok(!fs.existsSync(abs(CARD_REL)), '取消之后照样没有文件');
    });
  });

  // ════════════════════════════════════════════════════════════
  /**
   * ⚠️ **已知覆盖缺口**（独立审 2026-10-10 记）：改**文件夹**名那条路（整目录前缀）只有
   * **纯函数**用例覆盖 —— 端到端跑不了，因为桩的 `rename()` 搬完目录只改目录自己的 `byPath`
   * 项、**不重指子文件路径**（`tests/stub/index.ts`），真写会造出假夹具（`来源已不在` 满天飞）。
   * 真机上那条路由 `remapCards` 的**前缀分支**保证 —— 那正是"卡片的 note 是路径"这件事
   * 比顺序表严重的地方。桩真做了目录级重指之后，这里补一条端到端。
   */
  await suite.group('P8 · 改名迁键（挂在 main.ts 的 vault.on(rename) 上）', async () => {
    const A = `${KB}/00_Inbox/__回顾改名前.md`;
    const B = `${KB}/00_Inbox/__回顾改名后.md`;
    const C = `${KB}/00_Inbox/__回顾无关.md`;

    await suite.it('改这篇笔记的名 → 卡片跟着走；**顺便验证不改名时不许动**', async () => {
      sweep();
      await purgeCards();
      H.writeNote(vaultRoot, A, H.note('# 改名前\n'));
      H.writeNote(vaultRoot, C, H.note('# 无关\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await ctx().review.addCard({ note: A, front: 'Q', back: 'A' });

      // ① 改一篇**没有卡**的笔记 → 一个字节都不许写
      const beforeRaw = cardsRaw();
      /**
       * ⚠️ "逐字节相等"**证不出"没写盘"**（独立审 2026-10-10 🟡）：`configs.write` 用的是
       * 同一个 `JSON.stringify(data,null,2)+'\n'`，`remapCards` 又保序 —— 一个"没命中照样写一次"
       * 的实现会照样绿。所以这里**数写盘次数**（包一层计数器；`ctx.configs` 是单例，改完还原）。
       */
      const cfg = ctx().configs as unknown as {
        write: (name: string, data: unknown) => Promise<void>;
      };
      const orig = cfg.write.bind(ctx().configs);
      let writes = 0;
      cfg.write = (name: string, data: unknown) => {
        if (name === 'review') writes += 1;
        return orig(name, data);
      };
      try {
        await app.fileManager.renameFile(H.fileAt(app, C), `${KB}/00_Inbox/__回顾无关2.md`);
        await H.settle(150);
        eq(writes, 0, '★ 没命中 → **一次写盘都没有**（不是"写了一份一样的"）');
        eq(cardsRaw(), beforeRaw, '复习.json 逐字节没动');
      } finally {
        cfg.write = orig;
      }
      await app.fileManager.renameFile(H.fileAt(app, `${KB}/00_Inbox/__回顾无关2.md`), C);
      await H.settle(80);

      // ② 改有卡的那一篇 → note 跟着迁
      await app.fileManager.renameFile(H.fileAt(app, A), B);
      await H.settle(150);
      const after = cardsOf();
      eq(after.length, 1, '卡还是那一张（没被删）');
      eq(after[0].note, B, 'note 跟着改到了新路径');
      eq(after[0].front, 'Q', '正反面一个字节没动');

      // ③ 删掉那篇笔记 → 卡片被剪掉
      await app.fileManager.trashFile(H.fileAt(app, B));
      await H.settle(150);
      eq(cardsOf().length, 0, '来源没了 → 卡片被剪（不留点不开的死键）');
      // ⚠️ 用自己的口删（`fs.rmSync` 会绕开桩的 byPath 表 —— 本仓刚记过这条坑）
      const cFile = app.vault.getAbstractFileByPath(C);
      if (cFile) await app.vault.delete(cFile);
    });

    await suite.it('★ 并发迁键（批量搬 N 篇那种情形）：N 张卡的迁键**一个都不能丢**', async () => {
      /**
       * 为什么这条最要紧（独立审 2026-10-10 🔴）：改名/搬移是**平台事件流驱动**的 ——
       * 批量搬 3 篇 = 3 个 rename 事件紧挨着来，而每个处理都是
       * "异步 load() → 拼整份数组 → 整文件 write()" 的 read-modify-write。
       * 没有串行队列的话，三份 read 会落在第一次 write 之前 → **只有最后一次保住**，
       * 另外两张卡的 note 还指着搬走前的路径（面板全变「来源已不在」，用户还没法从 UI 修）。
       * 这条用例就是那个交错的现场：三个 remapNote **同时发**（不挨个 await）。
       */
      sweep();
      await purgeCards();
      const olds = [1, 2, 3].map((i) => `${KB}/00_Inbox/__回顾并发${i}.md`);
      const news = [1, 2, 3].map((i) => `${KB}/00_Inbox/__回顾并发${i}-改.md`);
      for (const p of olds) {
        H.writeNote(vaultRoot, p, H.note(`# ${p.split('/').pop()}
`));
        await ctx().review.addCard({ note: p, front: 'Q', back: 'A' });
      }
      eq(cardsOf().length, 3, '前提：三张卡都建好了');

      await Promise.all(olds.map((p, i) => ctx().review.remapNote(p, news[i])));

      const notes = cardsOf()
        .map((c) => c.note)
        .sort();
      eq(notes.join('|'), [...news].sort().join('|'), '★ 三张卡**都**迁到了新路径（一张都没被对方的快照盖掉）');
      // 收场
      for (const p of news) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P8 · 面板：空态 / 列表 / 删除走确认流', async () => {
    const NOTE = `${KB}/00_Inbox/__回顾面板.md`;
    const toReview = async (): Promise<void> => {
      await ctx().activate();
      await H.settle(80);
      const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem');
      H.click(nav[4]);
      await H.settle(120);
      eq(ctx().store.get().activeModule, 'review', '切到「回顾」栏');
    };

    await suite.it('没卡时给空态 + 一个能用的动作（不给死按钮）', async () => {
      sweep();
      await purgeCards();
      H.writeNote(vaultRoot, NOTE, H.note('# 面板夹具\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await toReview();
      ok(H.maybe(document.body, '.kbw-review'), '模块挂上了');
      const empty = H.maybe<HTMLElement>(document.body, '.kbw-review .kbw-empty');
      ok(empty, '没卡时画空态');
      contains(H.textOf(empty as HTMLElement), '还没有回顾卡', '空态标题');
      contains(H.textOf(empty as HTMLElement), '生成回顾卡', '空态里指了建卡的入口（右键菜单那条）');
      /** ⚠️ P8 期 4 起空态动作是**「从笔记生成」**（0 张卡时头部那两枚按钮都不画，它是唯一入口） */
      contains(H.textOf(empty as HTMLElement), '从笔记生成', '空态给的是能用的动作');
      /**
       * 那个动作真能走通（不是死按钮）——P8 期 4 起它是**「从笔记生成」**：
       * 点了要开**挑笔记**那个模态（`pickOne` 自带搜索），不是切走。
       */
      H.click(H.q<HTMLElement>(document.body, '.kbw-review .kbw-empty-act .kbw-btn'));
      await H.settle(150);
      const picker = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(picker, '点了开挑笔记的模态');
      contains(H.textOf(picker), '从哪一篇生成回顾卡', '模态标题说清在挑什么');
      H.keydown(document.body, 'Escape');
      await H.settle(120);
    });

    await suite.it('建了卡 → 列表画出来（正面 / 背面 / 来源）+ 头部报张数与今日到期', async () => {
      sweep();
      await purgeCards();
      await ctx().review.addCard({ note: NOTE, front: '列表问句', back: '列表答句' });
      await toReview();
      const rows = H.qa<HTMLElement>(document.body, '.kbw-review-row');
      eq(rows.length, 1, '一张卡一行');
      contains(H.textOf(rows[0]), '列表问句', '正面画出来了');
      contains(H.textOf(rows[0]), '列表答句', '背面也画出来（管理列表要能一眼扫）');
      const head = H.textOf(H.q(document.body, '.kbw-review-head'));
      contains(head, '全部卡片 1 张', '头部报总数');
      contains(head, '今日待复习 1 张', '新卡默认今天到期（间隔 1 天）');
      contains(head, '复习.json', '明写卡存在库内哪个文件（用户能自己打开/备份）');
      contains(H.textOf(H.q(document.body, '.kbw-review-row-side')), '__回顾面板', '来源笔记的短名');
      ok(!H.maybe(document.body, '.kbw-review-src.is-missing'), '来源还在 → 不标"来源已不在"');
    });

    await suite.it('文件坏掉时：面板画「读不出来」那行，**不画空态**（不让人以为卡丢了）', async () => {
      sweep();
      await purgeCards();
      await ctx().review.addCard({ note: NOTE, front: 'Q', back: 'A' });
      await app.vault.process(H.fileAt(app, CARD_REL), () => '{ 坏掉的 JSON');
      await H.settle(160);
      await toReview();
      const warn = H.maybe<HTMLElement>(document.body, '.kbw-review-broken');
      ok(warn, '画了"读不出来"那行');
      contains(H.textOf(warn as HTMLElement), '读不出来', '文案说清是读不出来');
      ok(!H.maybe(document.body, '.kbw-review .kbw-empty'), '**不画空态**（"没有卡片"在这是假话）');
      ok(!H.maybe(document.body, '.kbw-review-row'), '也不画卡片行');
      // 收场：把文件删掉（别把坏文件留给下一条）
      await purgeCards();
      await H.settle(120);
    });

    await suite.it('删除：取消 → 卡还在；两下确认 → 真没了（来源笔记不动）', async () => {
      sweep();
      await purgeCards();
      await ctx().review.addCard({ note: NOTE, front: '要删的', back: '答案' });
      await toReview();
      const beforeNote = H.readNote(vaultRoot, NOTE);

      // ① 取消
      H.click(H.q<HTMLElement>(document.body, '.kbw-review-del'));
      await H.settle(100);
      const cf = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(cf, '删除也走确认流');
      contains(H.textOf(cf), '要删的', '确认单里能看见是哪一张');
      H.click(
        H.qa<HTMLElement>(cf, '.kbw-btn').find((b) => H.textOf(b).includes('取消')) as HTMLElement,
      );
      await H.settle(120);
      eq(cardsOf().length, 1, '取消 → 卡还在');

      // ② 两下确认（danger：第一下上膛）
      H.click(H.q<HTMLElement>(document.body, '.kbw-review-del'));
      await H.settle(100);
      const cf2 = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const btn = (): HTMLElement =>
        H.qa<HTMLElement>(cf2, '.kbw-btn').find(
          (b) => H.textOf(b).includes('删除这张卡') || H.textOf(b).includes('再点一次'),
        ) as HTMLElement;
      H.click(btn());
      await H.settle(60);
      H.click(btn());
      await H.settle(150);

      eq(cardsOf().length, 0, '两下确认 → 卡删了');
      eq(H.readNote(vaultRoot, NOTE), beforeNote, '来源笔记一个字节没动');
      const rows = H.qa<HTMLElement>(document.body, '.kbw-review-row');
      eq(rows.length, 0, '列表里也没了');
      ok(H.maybe(document.body, '.kbw-review .kbw-empty'), '删光之后回到空态');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P8 · 间隔推进（期 3 的固定倍增表）', async () => {
    const now = new Date(2026, 9, 20, 15, 30).getTime(); // 2026-10-20 15:30 local
    const base = (over: Partial<ReviewCard> = {}): ReviewCard => ({
      ...mk('c1', `${KB}/a.md`),
      interval: 1,
      nextReview: startOfDay(now),
      ...over,
    });

    await suite.it('addDays 钉**绝对值**：+N 天落在当天 0 点，跨月 / 跨年 / 闰年都对', () => {
      /**
       * 🔴 为什么必须钉绝对值（独立审 2026-10-10 抓的判据洞）：本组其余各条的期望
       * **都由 `addDays` 自己算出来**（`eq(c.nextReview, addDays(now, 3))`）—— 那是半自证，
       * 只证明"`applyGrade` 调了 `addDays(now, 3)`"，**没有证明 `addDays` 是对的**。
       * 把 `addDays` 换成注释里明说要避免的 `ts + n*86400000`，那一组**照样全绿**
       *（中国无夏令时，两边同步偏移）。下面这些值是人算出来的，钉死。
       */
      const t = new Date(2026, 9, 20, 15, 30).getTime(); // 2026-10-20 15:30 本地
      eq(addDays(t, 0), new Date(2026, 9, 20).getTime(), '0 天 → 当天 0 点（不是 15:30）');
      eq(addDays(t, 3), new Date(2026, 9, 23).getTime(), '+3 天 → 2026-10-23 00:00');
      eq(addDays(t, -3), new Date(2026, 9, 17).getTime(), '-3 天 → 2026-10-17 00:00');
      eq(addDays(new Date(2026, 9, 31, 23, 0).getTime(), 1), new Date(2026, 10, 1).getTime(), '跨月');
      eq(addDays(new Date(2026, 11, 31, 23, 0).getTime(), 1), new Date(2027, 0, 1).getTime(), '跨年');
      eq(addDays(new Date(2028, 1, 28, 12, 0).getTime(), 1), new Date(2028, 1, 29).getTime(), '闰年 2 月');
    });

    await suite.it('记住：1 → 3（跳 2 太碎）、之后 ×2；reps++；下次 = 今天 + 新间隔', () => {
      const c1 = applyGrade(base(), 'remember', now);
      eq(c1.interval, 3, '原为 1 → **3**（不是 2）');
      eq(c1.reps, 1, 'reps++');
      eq(c1.lapses, 0, '忘记数不动');
      eq(c1.lastReview, now, 'lastReview = 这一次复习的时刻');
      eq(c1.nextReview, new Date(2026, 9, 23).getTime(), '下次 = 2026-10-23 00:00（绝对值）');
      ok(
        dueCards([c1], new Date(2026, 9, 22, 9, 0).getTime()).length === 0 &&
          dueCards([c1], new Date(2026, 9, 23, 9, 0).getTime()).length === 1,
        '第 3 天才到期（第 2 天不算）—— 边界钉在"天"上，且期望是**人写的绝对日期**',
      );

      const c2 = applyGrade(base({ interval: 3, reps: 1 }), 'remember', now);
      eq(c2.interval, 6, '3 → 6（×2）');
      eq(c2.reps, 2, 'reps 继续加');
      const c3 = applyGrade(base({ interval: 6, reps: 2 }), 'remember', now);
      eq(c3.interval, 12, '6 → 12');
    });

    await suite.it('模糊：间隔**不变**、只把下次推后一个间隔；忘记：回到 1 且 lapses++', () => {
      const f = applyGrade(base({ interval: 6, reps: 2, lapses: 1 }), 'fuzzy', now);
      eq(f.interval, 6, '间隔不变');
      eq(f.reps, 2, 'reps 不动（模糊不是"会了"）');
      eq(f.lapses, 1, 'lapses 不动（也不是"忘了"）');
      eq(f.lastReview, now, 'lastReview 照写');
      eq(f.nextReview, new Date(2026, 9, 26).getTime(), '下次 = 2026-10-26 00:00（今天 + 6）');
      ok(dueCards([f], now).length === 0, '当天不再到期（推后了）');

      const g = applyGrade(base({ interval: 12, reps: 5, lapses: 2 }), 'forgot', now);
      eq(g.interval, 1, '忘记 → 回到 1');
      eq(g.lapses, 3, 'lapses++');
      eq(g.reps, 5, 'reps 不动');
      eq(g.nextReview, new Date(2026, 9, 21).getTime(), '明天再来 = 2026-10-21 00:00');
      eq(dueCards([g], now).length, 0, '今天不再到期');
      eq(dueCards([g], new Date(2026, 9, 21, 7, 0).getTime()).length, 1, '★ 第二天 07:00 就算到期（跨天判据）');
    });

    await suite.it('三档都只动那几个字段：正面/背面/来源/createdAt 逐字段不动', () => {
      const src = base({ front: '问', back: '答', createdAt: 123 });
      for (const grade of ['remember', 'fuzzy', 'forgot'] as const) {
        const out = applyGrade(src, grade, now);
        eq(out.id, src.id, `${grade}：id 不动`);
        eq(out.note, src.note, `${grade}：来源笔记不动`);
        eq(out.front, src.front, `${grade}：正面不动`);
        eq(out.back, src.back, `${grade}：背面不动`);
        eq(out.createdAt, src.createdAt, `${grade}：createdAt 不动`);
      }
    });

    await suite.it('小结计数：countTally 一处出数（三档互不串）', () => {
      let t = emptyTally();
      t = countTally(t, 'remember');
      t = countTally(t, 'fuzzy');
      t = countTally(t, 'fuzzy');
      t = countTally(t, 'forgot');
      eq(t.total, 4, '总张数');
      eq(`${t.remember}/${t.fuzzy}/${t.forgot}`, '1/2/1', '三档各数各的');
    });

    await suite.it('落盘：grade() 写进库内那张表；找不到的 id 不写盘', async () => {
      sweep();
      await purgeCards();
      const made = await ctx().review.addCard({ note: `${KB}/00_Inbox/甲.md`, front: 'Q', back: 'A' });
      const updated = await ctx().review.grade(made.id, 'remember', now);
      ok(updated, '返回更新后的那张卡');
      const onDisk = cardsOf()[0];
      eq(onDisk.interval, 3, '盘上间隔已是 3');
      eq(onDisk.reps, 1, '盘上 reps 已是 1');
      eq(onDisk.nextReview, new Date(2026, 9, 23).getTime(), '盘上下次到期 = 2026-10-23 00:00');
      eq(onDisk.front, 'Q', '正反面没被动');

      const rawBefore = cardsRaw();
      eq(await ctx().review.grade('不存在的 id', 'remember', now), null, '找不到 → null');
      eq(cardsRaw(), rawBefore, '找不到时**不写盘**（逐字节没动）');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P8 · 复习浮层（期 3：翻面 → 三键 → 小结）', async () => {
    const NOTE = `${KB}/00_Inbox/__回顾浮层.md`;
    const SESSION = '.kbw-review-session';
    /** 造 N 张**今天到期**的卡（新卡默认今天到期） */
    const seed = async (n: number): Promise<ReviewCard[]> => {
      sweep();
      await purgeCards();
      H.writeNote(vaultRoot, NOTE, H.note('# 浮层夹具\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      const out: ReviewCard[] = [];
      for (let i = 1; i <= n; i += 1) {
        out.push(await ctx().review.addCard({ note: NOTE, front: `正面${i}`, back: `背面${i}` }));
      }
      return out;
    };
    const toReview = async (): Promise<void> => {
      await ctx().activate();
      await H.settle(80);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-navitem')[4]);
      await H.settle(120);
    };
    const start = async (): Promise<void> => {
      H.click(H.q<HTMLElement>(document.body, '.kbw-review-start'));
      // 等**条件**（浮层真的挂上）而不是赌固定睡眠 —— 慢机器上那是假红来源
      ok(await H.until(() => !!H.maybe(document.body, SESSION), 800), '浮层该开出来');
    };
    const face = (): HTMLElement => H.q<HTMLElement>(document.body, '.kbw-rs-face');
    const key = (k: string): void => {
      H.keydown(H.q<Element>(document.body, SESSION), k);
    };

    await suite.it('开始复习：浮层开着、正面可见、三键**置灰并写明原因**（还没翻面）', async () => {
      await seed(2);
      await toReview();
      const head = H.textOf(H.q(document.body, '.kbw-review-head'));
      contains(head, '今日待复习 2 张', '头里报今日张数');
      const startBtn = H.q<HTMLElement>(document.body, '.kbw-review-start');
      contains(H.textOf(startBtn), '开始复习', '头里有开始复习');
      ok(!(startBtn as HTMLButtonElement).hasAttribute('disabled'), '有到期 → 可点');

      await start();
      ok(H.maybe(document.body, SESSION), '浮层开了');
      contains(H.textOf(H.q(document.body, '.kbw-review-session .kbw-rs-progress')), '第 1 / 2 张', '进度行');
      eq(H.textOf(face()), '正面1', '先看正面');
      const btns = H.qa<HTMLElement>(document.body, '.kbw-rs-actions .kbw-btn');
      eq(btns.length, 3, '三键都在');
      ok(
        btns.every((b) => b.hasAttribute('disabled')),
        '★ 没翻面时三键都置灰（点了不算数 —— 这也是"别让人瞎点"）',
      );
      contains(H.textOf(H.q(document.body, '.kbw-rs-hint')), '空格', '提示里写了怎么翻面');

      /**
       * ★ **没翻面时按键不算数**（键盘路径**绕过** `disabled` 属性 —— 属性只挡鼠标）：
       * 先按一次「1 记住」，什么都不该发生（不落盘、不换张）。
       */
      const rawBefore = cardsRaw();
      key('1');
      await H.settle(120);
      eq(cardsRaw(), rawBefore, '★ 没翻面按 1 → 复习.json 逐字节没动');
      contains(
        H.textOf(H.q(document.body, '.kbw-review-session .kbw-rs-progress')),
        '第 1 / 2 张',
        '还停在第 1 张',
      );
      eq(H.textOf(face()), '正面1', '而且还在正面（没稀里糊涂翻过去）');

      // 收场
      H.keydown(H.q<Element>(document.body, SESSION), 'Escape');
      await H.settle(120);
    });

    await suite.it('空格翻面 → 三键可用 → 按 1 记住：落盘 interval 3 / reps 1 + 自动下一张', async () => {
      await seed(2);
      await toReview();
      await start();

      key(' ');
      await H.settle(80);
      eq(H.textOf(face()), '背面1', '★ 空格翻面：看得到答案了');
      const btns = H.qa<HTMLElement>(document.body, '.kbw-rs-actions .kbw-btn');
      ok(
        btns.every((b) => !b.hasAttribute('disabled')),
        '翻面后三键都可用',
      );

      /**
       * ★ **焦点要回到浮层根上**（外部交付线独立审指出的真风险）：三键在下一张会变成
       * `disabled`，而**给已聚焦控件设 `disabled` 会把焦点弹走**（Chromium）—— 此后空格/1/2/3
       * 静默失灵。所以每次重画都 `keepFocus()`；这条就是那个机制的判据。
       *
       * ⚠️ **首版是恒真的**（本仓独立审 🟡1 抓的）：断言写成 `contains(activeElement) || activeElement === body`
       * —— 后半段把"焦点丢回 body"也放行了，而前半段被 `openModal` 打开时那次自动送焦先满足；
       * 两条路都到不了红，拆掉 `keepFocus()` 照样绿。加固：**评卡前先把焦点主动丢掉**，
       * 评完只认**恰好等于浮层根**（`keepFocus()` 的机器化定义）。
       * 边界照旧：jsdom 不复现"给已聚焦控件设 disabled 会失焦"的 Chromium 行为 ——
       * 真机那条路（键会不会中途整段失灵）**归探针**（P8 期 3 步 ④）。
       */
      const sess = H.q<HTMLElement>(document.body, SESSION);
      (document.activeElement as HTMLElement | null)?.blur?.();
      ok(document.activeElement === document.body, '前提：焦点已被丢掉（不丢，下面的断言没有分辨力）');
      key('1');
      await H.settle(150);
      ok(
        document.activeElement === sess,
        '★ 评完一张之后焦点被收回浮层根（不在浮层根 = 键收不到了 —— 正常分辨率）',
      );
      /**
       * ⚠️ **这条判据的能力边界**（实测过，别当它管得住全部）：拆掉 `keepFocus()` 它**照样绿** ——
       * jsdom 不会因为"给已聚焦控件设 `disabled`"而失焦（那是 Chromium 的行为）。
       * 所以离线它只钉得住"焦点落在浮层里"这个**前置**；真机那条路（焦点到底送不送得到、
       * 键会不会在中途整段失灵）**归探针** —— 计划 §5.3 点名的就是它。
       */
      const first = cardsOf().find((c) => c.front === '正面1') as ReviewCard;
      eq(first.interval, 3, '★ 记住 → 间隔 1→3 落了盘');
      eq(first.reps, 1, 'reps 落了盘');
      ok(first.lastReview != null, 'lastReview 落了盘');
      contains(H.textOf(H.q(document.body, '.kbw-review-session .kbw-rs-progress')), '第 2 / 2 张', '自动到下一张');
      eq(H.textOf(face()), '正面2', '下一张又是正面（重新藏答案）');

      key(' ');
      await H.settle(60);
      key('3');
      ok(
        await H.until(
          () => H.textOf(H.q(document.body, '.kbw-review-session .kbw-rs-progress')).includes('本轮完成'),
          800,
        ),
        '第 2 张评完 → 该出小结',
      );
      const second = cardsOf().find((c) => c.front === '正面2') as ReviewCard;
      eq(second.interval, 1, '★ 忘记 → 间隔回到 1');
      eq(second.lapses, 1, 'lapses 落了盘');

      // 小结
      contains(H.textOf(H.q(document.body, '.kbw-review-session .kbw-rs-progress')), '本轮完成', '末尾是小结');
      const sum = H.textOf(H.q(document.body, '.kbw-rs-hint'));
      contains(sum, '记住 1', '小结报记住 1');
      contains(sum, '忘记 1', '小结报忘记 1');

      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-rs-actions .kbw-btn').find((b) =>
          H.textOf(b).includes('完成'),
        ) as HTMLElement,
      );
      await H.settle(150);
      ok(!H.maybe(document.body, SESSION), '点完成 → 浮层关了');
      contains(
        H.textOf(H.q(document.body, '.kbw-review-head')),
        '今天没有到期的卡',
        '★ 两张都推后了 → 今日归零（头里改口「今天没有到期的卡」，不是「今日待复习 0 张」）',
      );
    });

    await suite.it('中途 Esc：已做的那几张照样记下；未做的不动', async () => {
      await seed(3);
      await toReview();
      await start();
      key(' ');
      await H.settle(60);
      key('2');
      await H.settle(150);
      const graded = cardsOf().find((c) => c.front === '正面1') as ReviewCard;
      eq(graded.interval, 1, '模糊：间隔不变（本来就是 1）');
      eq(graded.lastReview != null, true, '模糊也记了 lastReview');

      H.keydown(H.q<Element>(document.body, SESSION), 'Escape');
      await H.settle(150);
      ok(!H.maybe(document.body, SESSION), 'Esc 关掉浮层');
      eq(cardsOf().length, 3, '卡一张没少');
      eq(
        cardsOf().filter((c) => c.lastReview != null).length,
        1,
        '只记了做过的那一张（另两张一个字节没动）',
      );
      contains(H.textOf(H.q(document.body, '.kbw-review-head')), '今日待复习 2 张', '今日还剩 2 张');
    });

    await suite.it('今日筛选：切「全部」看得到未到期的卡 + 「今日到期」标记；没到期时开始复习置灰', async () => {
      await seed(1);
      await toReview();
      // 把唯一那张推到 3 天后 → 今日归零
      const only = cardsOf()[0];
      await ctx().review.grade(only.id, 'remember', Date.now());
      await H.settle(150);
      const startBtn = H.q<HTMLElement>(document.body, '.kbw-review-start');
      ok((startBtn as HTMLButtonElement).hasAttribute('disabled'), '★ 今天没到期 → 开始复习置灰');
      contains(H.textOf(startBtn).length > 0 ? '开始复习' : '', '开始复习', '按钮还在（只是灰）');
      /**
       * ⚠️ **钉死整句**（独立审 2026-10-10 🔴 抓的真 bug 的回归判据）：
       * 这里原来只 `contains('下一次到期')` —— 而"刚刚"也含那三个字。当时实现用的是
       * **过去向**的 `formatRelativeTime`，对未来时间戳恒返回「刚刚」，句子 100% 是
       * 「…下一次到期：刚刚」（反向误导）。现在钉整句，那句再也回不去。
       */
      eq(
        H.textOf(H.q(document.body, '.kbw-review-today-empty')),
        '今天没有到期的卡。下一次到期：3 天后',
        '★ 整句钉死（未来向文案；换成"刚刚"这条当场红）',
      );

      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-review-scope .kbw-segbtn').find((b) =>
          H.textOf(b).includes('全部'),
        ) as HTMLElement,
      );
      await H.settle(120);
      const rows = H.qa<HTMLElement>(document.body, '.kbw-review-row');
      eq(rows.length, 1, '「全部」档看得到那张未到期的卡');
      contains(H.textOf(rows[0]), '正面1', '就是那一张');
      /**
       * 标记也**钉死文案**（同一根因：过去向格式化器 → 「刚刚」）。
       * 而且"算不算今天"要**按天比**（拿时间戳比会把"今天 08:00 到期、现在 07:00"判错）。
       */
      eq(
        H.textOf(H.q<HTMLElement>(document.body, '.kbw-review-when')),
        '3 天后',
        '★ 「全部」档标的是「3 天后」（不是「刚刚」）',
      );
      ok(!H.maybe(document.body, '.kbw-review-when.is-due'), '它不是"今日到期"（在 3 天后）');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P8 · 期 4 · 从笔记生成（AI 出稿 → 可改可删 → 确认流 → 入库）', async () => {
    const NOTE = `${KB}/00_Inbox/__回顾生成.md`;
    const PROTECTED = `${KB}/99_Meta/03_AI指令集/AI操作规范.md`;
    const noteBody = (t: string): string =>
      H.note(`# ${t}\n\n间隔重复的核心是"在快忘的时候再问一遍"。\n\n- 新卡间隔 1 天\n- 记住之后翻倍\n`, {});

    /** 造来源笔记（`reviewCards` 要求正文非空） */
    const seed = (): void => {
      H.writeNote(vaultRoot, NOTE, noteBody('__回顾生成'));
      app.vault.rescan();
      ctx().index.rebuild();
    };
    /** 假传输层：回一段固定文本；用完 `restore()` 把真传输换回来 */
    const fake = (text: string): void => {
      ctx().ai.transport = { chat: async () => ({ text }) };
    };
    const restore = (): void => {
      ctx().ai.transport = ctx().ai.http;
      void ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: '' } });
    };
    const configure = async (): Promise<void> => {
      await ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: 'fake-key' } });
    };

    await suite.it('parseReview：裸数组 / ```json 围栏 / `{cards:[…]}` 外壳都认；超上限报出丢了几张', () => {
      const bare = parseReview('[{"front":"问1","back":"答1"},{"front":"问2","back":"答2"}]');
      eq(bare.cards.length, 2, '裸数组');
      eq(bare.cards[0].front, '问1', '正面');
      eq(bare.truncated, 0, '没丢');

      const fenced = parseReview('```json\n[{"front":"问","back":"答"}]\n```');
      eq(fenced.cards.length, 1, '剥围栏（模型手痒的常见形态）');

      const wrapped = parseReview('{"cards":[{"front":"问","back":"答"}]}');
      eq(wrapped.cards.length, 1, '认 {cards:[…]} 外壳');

      const trimmed = parseReview('[{"front":"  问  ","back":" 答 "}]');
      eq(trimmed.cards[0].front, '问', '两面都 trim');

      const many = Array.from({ length: 20 }, (_, i) => `{"front":"f${i}","back":"b${i}"}`).join(',');
      const capped = parseReview(`[${many}]`);
      eq(capped.cards.length, 12, '只收前 12 张');
      eq(capped.truncated, 8, '★ 丢掉的张数**报出来**（不静默）');

      eq(parseReview('[]').cards.length, 0, '空数组是**正经答案**（"这篇没什么可问的"），不抛');
    });

    /**
     * ⚠️ **本组的三次突变验红**（独立审 2026-10-10 🟢 指出"只落了一条"，补齐）：
     *   ① `parseReview` 放水（缺一面就补空串）→ 下面这条「解析失败报出原因」当场红
     *   ② 面板发 AI 原稿而不是输入框里的值 → 「真链路」那条 `eq(back,'我改过的答案')` 当场红
     *   ③ 拆掉 `commitReviewCards` 里 `res.action !== 'primary'` 那道闸 → **只有「确认流里取消」那条红**
     *（真机探针那一步也独立咬了一遍"确认单里是改过的稿"。）
     */
    await suite.it('parseReview：解析失败**报出原因**（不猜、不拿默认值糊）', () => {
      const bad = (text: string): string => {
        try {
          parseReview(text);
          return '（没抛）';
        } catch (e) {
          return e instanceof AiParseError ? e.message : `（抛了别的：${String(e)}）`;
        }
      };
      contains(bad('好的，我看完了这篇笔记，它主要讲了间隔重复的基本思路。'), '不是 JSON', '散文 → 说清"不是 JSON"');
      contains(bad(''), '空内容', '空回复');
      contains(bad('[{"front":"问"}]'), '第 1 项不完整', '缺背面 → 指名第几项');
      const e = (() => {
        try {
          parseReview('[{"front":"a","back":"b"},{"front":"c"}]');
        } catch (err) {
          return err as AiParseError;
        }
        return null;
      })();
      ok(e, '第 2 项缺背面要抛');
      contains(String(e?.message), '第 2 项', '说清是第 2 项');
      contains(String(e?.raw), 'front', 'AiParseError 带着模型的原话（排错用）');
    });

    await suite.it('buildReviewMessages：system 写清"零编造 + 只回 JSON"，user 带标题与正文；**横切附加层**进 system', () => {
      const msgs = buildReviewMessages({ kbRoot: KB, rel: 'a/b.md', title: '标题甲', body: '正文甲' });
      eq(msgs.length, 2, 'system + user 两条');
      eq(msgs[0].role, 'system', '规则在 system（别夹在材料里）');
      contains(msgs[0].content, '零编造', 'system 里有一条"零编造"');
      contains(msgs[0].content, 'JSON 数组', '说清输出形状');
      contains(msgs[1].content, '标题甲', 'user 带标题');
      contains(msgs[1].content, '正文甲', 'user 带正文');
      /**
       * **横切附加层**（P7.22b · #3 的口径，本仓比参考实现多的两行；独立审 🟡2 点名的零覆盖）：
       * `runTask` 会把能力包（skill）与用户附加要求（taskNote）递给**每一条任务**的 builder —
       * 回顾这条也得收，且都排在硬规矩之前（附加要求优先、但不许顶掉输出格式）。
       */
      const msgs2 = buildReviewMessages({
        kbRoot: KB,
        rel: 'a/b.md',
        title: '标题甲',
        body: '正文甲',
        skill: { name: '甲包', instructions: '甲乙丙指令行', tools: null },
        taskNote: '丁戊己附加要求行',
      });
      const sys2 = msgs2[0].content;
      contains(sys2, '甲乙丙指令行', 'skill 正文进了 system');
      contains(sys2, '丁戊己附加要求行', 'taskNote 进了 system');
      ok(
        sys2.indexOf('甲乙丙指令行') < sys2.indexOf('## 输出什么') &&
          sys2.indexOf('丁戊己附加要求行') < sys2.indexOf('## 输出什么'),
        '两段附加层都排在「## 输出什么」之前（不许顶掉输出格式）',
      );
    });

    await suite.it('真链路：AI 出 2 张 → 改一张的背面 + 删掉一张 → 「入库 1 张」→ 确认流 → 落盘', async () => {
      sweep();
      await purgeCards();
      seed();
      const before = H.readNote(vaultRoot, NOTE);
      await configure();
      fake('[{"front":"AI问一","back":"AI答一"},{"front":"AI问二","back":"AI答二"}]');

      const flow = runReviewGen(ctx(), H.fileAt(app, NOTE));
      await H.settle(120);
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(panel, '出稿面板开了');
      contains(H.textOf(panel), 'AI 出的回顾卡 · 2 张', '标题报张数');
      contains(H.textOf(panel), '__回顾生成', '副标题点名来源');
      const rows = H.qa<HTMLElement>(panel, '.kbw-gen-row');
      eq(rows.length, 2, '两张一行');
      const tas0 = H.qa<HTMLTextAreaElement>(rows[0], 'textarea');
      eq(tas0[0].value, 'AI问一', 'AI 的正面进了输入框（★ 读 value：textarea 的内容不进 textContent）');

      // 改第 1 张的背面；删掉第 2 张
      const tas = H.qa<HTMLTextAreaElement>(rows[0], 'textarea');
      tas[1].value = '我改过的答案';
      H.click(
        H.qa<HTMLElement>(rows[1], '.kbw-gen-del')[0],
      );
      await H.settle(60);
      eq(H.qa<HTMLElement>(panel, '.kbw-gen-row').length, 1, '删掉一张之后只剩一行');
      contains(
        H.textOf(H.qa<HTMLElement>(panel, '.kbw-btn').find((b) => H.textOf(b).includes('入库')) as HTMLElement),
        '入库 1 张',
        '★ 主按钮跟着"还剩几张"走',
      );

      H.click(H.qa<HTMLElement>(panel, '.kbw-btn').find((b) => H.textOf(b).includes('入库')) as HTMLElement);
      await H.settle(100);
      const cf = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(cf, '入库前还要过一次确认流（硬规矩 #3）');
      contains(H.textOf(cf), '即将新建回顾卡', '一张的确认单标题');
      contains(H.textOf(cf), '我改过的答案', '确认单里是**改过之后**的稿');
      H.click(
        H.qa<HTMLElement>(cf, '.kbw-btn').find((b) => H.textOf(b).includes('新建这张卡')) as HTMLElement,
      );
      await H.settle(150);

      eq(await flow, 1, '返回入库 1 张');
      const cards = cardsOf();
      eq(cards.length, 1, '盘上 1 张');
      eq(cards[0].front, 'AI问一', '正面是 AI 那张');
      eq(cards[0].back, '我改过的答案', '★ 背面是**用户改过**的（不是 AI 原稿）');
      eq(cards[0].note, NOTE, '挂在来源笔记上');
      eq(H.readNote(vaultRoot, NOTE), before, '来源笔记逐字节不变');
      restore();
    });

    await suite.it('超上限：模型给 13 张 → 面板只画 12 张 + **明写"多给了几张"**（别静默丢）', async () => {
      /**
       * 这条补的是"截断要**说出来**"那句承诺的判据（独立审 2026-10-10 🟡）：
       * 原先只有 `parseReview` 那条验了 `truncated === 8` 这个**数字** ——
       * 面板那一行告知被删掉的话，`cards.slice(0, 12)` 就成了**静默丢内容**，而全套仍然绿。
       */
      sweep();
      await purgeCards();
      seed();
      await configure();
      const many = Array.from({ length: 13 }, (_, i) => `{"front":"f${i + 1}","back":"b${i + 1}"}`).join(',');
      fake(`[${many}]`);

      const flow = runReviewGen(ctx(), H.fileAt(app, NOTE));
      await H.settle(150);
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(panel, '面板开了');
      eq(H.qa<HTMLElement>(panel, '.kbw-gen-row').length, 12, '只画 12 行（上限）');
      const trunc = H.maybe<HTMLElement>(panel, '.kbw-gen-trunc');
      ok(trunc, '★ 有"多给了几张"那行告知');
      contains(H.textOf(trunc as HTMLElement), '多给了 1 张', '说清多给了几张');
      contains(H.textOf(trunc as HTMLElement), '只收前 12 张', '并说清这一轮收多少');
      H.click(
        H.qa<HTMLElement>(panel, '.kbw-btn').find((b) => H.textOf(b).includes('不动它')) as HTMLElement,
      );
      await H.settle(120);
      eq(await flow, 0, '取消 → 0 张');
      restore();
    });

    await suite.it('反例：入库那一刻在**确认流里取消** → 一个字节都不写', async () => {
      /**
       * 这条补的是"确认流那道闸真的在起作用"（突变实测：把 `res.action !== 'primary'`
       * 那一行拆掉，只有这条用例会红 —— 上面那条真链路是"一路点到底"，闸坏了它看不出来）。
       * 与期 2 手动建卡的「取消确认 → 一个字节都不写」是同一条纪律，AI 那条链也要有。
       */
      sweep();
      await purgeCards();
      seed();
      await configure();
      fake('[{"front":"问","back":"答"}]');

      const flow = runReviewGen(ctx(), H.fileAt(app, NOTE));
      await H.settle(120);
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      H.click(
        H.qa<HTMLElement>(panel, '.kbw-btn').find((b) => H.textOf(b).includes('入库')) as HTMLElement,
      );
      await H.settle(120);
      const cf = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(cf, '确认流开了');
      H.click(
        H.qa<HTMLElement>(cf, '.kbw-btn').find((b) => H.textOf(b).includes('取消')) as HTMLElement,
      );
      await H.settle(150);
      eq(await flow, 0, '取消 → 0 张');
      ok(!fs.existsSync(abs(CARD_REL)), '★ 确认流取消 → 一个字节都没写（连文件都不建）');
      restore();
    });

    await suite.it('反例：面板里「不动它」→ 一个字节都不写（连文件都不建）', async () => {
      sweep();
      await purgeCards();
      seed();
      await configure();
      fake('[{"front":"问","back":"答"}]');

      const flow = runReviewGen(ctx(), H.fileAt(app, NOTE));
      await H.settle(120);
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      H.click(
        H.qa<HTMLElement>(panel, '.kbw-btn').find((b) => H.textOf(b).includes('不动它')) as HTMLElement,
      );
      await H.settle(120);
      eq(await flow, 0, '取消 → 0 张');
      ok(!fs.existsSync(abs(CARD_REL)), '复习.json 连文件都没建出来');
      restore();
    });

    await suite.it('反例：模型回散文（解析失败）→ **报出来**、不写盘、面板都不开', async () => {
      sweep();
      await purgeCards();
      seed();
      await configure();
      fake('好的，我看完了这篇笔记。它主要讲了间隔重复的基本思路，建议如下……');
      __resetNotices();

      const flow = runReviewGen(ctx(), H.fileAt(app, NOTE));
      await H.settle(150);
      eq(await flow, 0, '解析失败 → 0 张');
      const notices = H.qa<HTMLElement>(document.body, '.kbw-notice');
      const text = notices.map((n) => H.textOf(n)).join('｜');
      contains(text, '没看懂模型回的话', '★ 把"没看懂"这件事报出来');
      contains(text, '不是 JSON', '并且带上原因');
      contains(text, '原文', '还把模型的原话摊出来（排错用）');
      ok(!H.maybe(document.body, '.kbw-gen-row'), '面板不该开（没有可改的东西）');
      ok(!fs.existsSync(abs(CARD_REL)), '一个字节都没写');
      restore();
    });

    await suite.it('反例：没配 AI 与保护目录 —— 都在**发起前**拦，并说明原因', async () => {
      sweep();
      await purgeCards();
      seed();
      // ① 没配 AI（默认就没有 key）
      void ctx().settings.save({ ai: { ...ctx().settings.get().ai, apiKey: '' } });
      __resetNotices();
      eq(await runReviewGen(ctx(), H.fileAt(app, NOTE)), 0, '没配 → 0 张');
      contains(
        H.qa<HTMLElement>(document.body, '.kbw-notice').map((n) => H.textOf(n)).join('｜'),
        '没配置',
        '报"没配置"（AI_NOT_CONFIGURED 那句）',
      );
      ok(!H.maybe(document.body, '.kbw-gen-row'), '也不开面板');

      // ② 保护目录：AI 指令集里的文件
      await configure();
      H.writeNote(vaultRoot, PROTECTED, '# AI 操作规范\n\n只有主人能改。\n');
      app.vault.rescan();
      ctx().index.rebuild();
      __resetNotices();
      eq(await runReviewGen(ctx(), H.fileAt(app, PROTECTED)), 0, '保护目录 → 0 张');
      contains(
        H.qa<HTMLElement>(document.body, '.kbw-notice').map((n) => H.textOf(n)).join('｜'),
        '只能读',
        '报 AI_PROTECTED_WHY 那句（"AI 指令集里的东西只能读、不能改名"）',
      );
      restore();
      const f = app.vault.getAbstractFileByPath(PROTECTED);
      if (f) await app.vault.delete(f);
    });

    await suite.it('数据层：addCards 一次写盘落 N 张；空数组连盘都不碰', async () => {
      sweep();
      await purgeCards();
      const made = await ctx().review.addCards([
        { note: `${KB}/00_Inbox/甲.md`, front: 'f1', back: 'b1' },
        { note: `${KB}/00_Inbox/甲.md`, front: 'f2', back: 'b2' },
        { note: `${KB}/00_Inbox/甲.md`, front: 'f3', back: 'b3' },
      ]);
      eq(made.length, 3, '三张一起进去');
      eq(cardsOf().length, 3, '盘上三张');
      eq(new Set(cardsOf().map((c) => c.id)).size, 3, 'id 各不相同');
      eq(cardsOf().map((c) => c.front).join(','), 'f1,f2,f3', '顺序照传进来的');
      const raw = cardsRaw();
      eq((await ctx().review.addCards([])).length, 0, '空数组 → 0 张');
      eq(cardsRaw(), raw, '而且**连盘都不碰**（逐字节没动）');
    });

    /**
     * ⚠️ 拆成两条（独立审 2026-10-10 🟡）：原来并成一条、还先 `purgeCards()` → 永远走空态那支，
     * `else` 里的"头部有按钮"**一次都没执行过**（删掉那枚按钮离线全绿）。
     */
    await suite.it('整库档（kbRoot 空串）也能生成 —— 那条闸不许把"整个库"判成"不在库根之下"', async () => {
      /**
       * 独立审 2026-10-10 🟡 抓的功能级问题：`kbRoot === ''` 是**合法配置**（"整个库"档），
       * 而老写法用 `rel === file.path` 当闸 —— 那一档下 `relativeTo` 原样返回路径 → 恒真 →
       * 功能 100% 不可用，还报"这一篇不在库根之下"（用户根本没设库根）。
       * 现在闸换成 `inKbScope`，这条把它钉住。
       */
      sweep();
      await purgeCards();
      const kbPrev = ctx().settings.kbRoot();
      const relPrev = `${KB}/00_Inbox/__回顾生成整库.md`;
      H.writeNote(vaultRoot, relPrev, noteBody('__回顾生成整库'));
      // ⚠️ 先让**桩**知道盘上多了这一篇，再切 kbRoot（`fileAt` 查的是桩的文件表）
      app.vault.rescan();
      await ctx().settings.save({ kbRoot: '' });
      ctx().index.rebuild();
      await H.settle(150);
      try {
        await configure();
        fake('[{"front":"整库问","back":"整库答"}]');
        const flow = runReviewGen(ctx(), H.fileAt(app, relPrev));
        await H.settle(150);
        // ⚠️ 面板要**驱动**（它等用户点「入库」）+ 再过确认流 —— 只 await 不点会挂住（看门狗会抓）
        const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
        ok(panel, '整库档下面板开出来了');
        H.click(
          H.qa<HTMLElement>(panel, '.kbw-btn').find((b) => H.textOf(b).includes('入库')) as HTMLElement,
        );
        await H.settle(120);
        const cf = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
        H.click(
          H.qa<HTMLElement>(cf, '.kbw-btn').find((b) => H.textOf(b).includes('新建这张卡')) as HTMLElement,
        );
        await H.settle(200);
        eq(await flow, 1, '★ 整库档下真能生成（老写法这里会是 0 + 一句对不上的报错）');
      } finally {
        restore();
        await ctx().settings.save({ kbRoot: kbPrev });
        ctx().index.rebuild();
        for (const c of cardsOf().filter((c) => c.note === relPrev)) await ctx().review.removeCard(c.id);
        const f = app.vault.getAbstractFileByPath(relPrev);
        if (f) await app.vault.delete(f);
        await H.settle(120);
      }
    });

    await suite.it('入口①（有卡）：头部有「从笔记生成」', async () => {
      sweep();
      await purgeCards();
      seed();
      await ctx().review.addCard({ note: NOTE, front: 'q', back: 'a' });
      await ctx().activate();
      await H.settle(80);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-navitem')[4]);
      await H.settle(150);
      ok(H.maybe(document.body, '.kbw-review-gen'), '★ 有卡时头部有「从笔记生成」');
      ok(!H.maybe(document.body, '.kbw-review .kbw-empty'), '有卡时不画空态');
    });

    await suite.it('入口②（0 张卡）：空态的动作就是「从笔记生成」', async () => {
      sweep();
      await purgeCards();
      seed();
      await ctx().activate();
      await H.settle(80);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-navitem')[4]);
      await H.settle(150);
      const empty = H.maybe<HTMLElement>(document.body, '.kbw-review .kbw-empty');
      ok(empty, '0 张卡 → 空态');
      const act = H.q<HTMLElement>(document.body, '.kbw-review .kbw-empty-act .kbw-btn');
      contains(H.textOf(act), '从笔记生成', '★ 空态的动作是「从笔记生成」（不是"去全部笔记"）');
      ok(!H.maybe(document.body, '.kbw-review-gen'), '0 张卡时头部那两枚按钮都不画（空态是唯一入口）');
    });
  });
}
