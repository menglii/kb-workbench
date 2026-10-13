/**
 * spec：**「一键自动整理收件箱」**（A2，用户 2026-09-27 提）
 *
 * 判据两层（真机那一层在 `scripts/probe.mjs` 的 A2 步骤里）：
 *  ① **纯函数** —— `planRebuild({scopeDir})`：只管 Inbox 里那些、**一个目录都不新建**、
 *     声明优先、兜底目录、落点不存在进 `pending`；
 *  ② **真链路** —— 真造一篇在 Inbox 的笔记 → `runInboxTidy` → 确认流 → 真搬 + 真写「文件位置」
 *     → 快照还原回来（跑完库要跟没跑过一样：后面还有别的 spec 用同一个库）。
 *
 * ⚠️ 这里用 `planRebuild` 同一个规划器（不是另写一个）—— 那一份判据是全项目唯一的
 * "声明优先 / 兜底只在 00_Inbox / 撞名两篇都不搬"（P3 与 P5 都栽在"两处各写一份"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TFile } from 'obsidian';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import {
  planRebuild,
  rebuildNotesOf,
  shapeAsSkeleton,
  vaultShapeOf,
  type RebuildPlan,
} from '../../src/services/rebuild';
import { fallbackDir, readRouteTable } from '../../src/services/routes';
import { runInboxTidy } from '../../src/modules/home/tidy';
import { __resetNotices } from '../../src/ui/notify';
import { __resetUndo } from '../../src/ui/undo-bar';
import { closeAllMenus } from '../../src/ui/menu';

const KB = '01_新知识库';
const INBOX = '00_Inbox';
/** 域外夹具所在的那个目录（"一键整理只该动 Inbox"这条判据就靠它） */
const OUTSIDE_DIR = '01_Projects';
/** 自己造的夹具一律带这个前缀（清场靠认它） */
const T = '__整理';

export async function specTidy(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const inboxDir = () => path.join(vaultRoot, KB, INBOX);

  /** 造一篇在 Inbox 的笔记（带前言）；返回它的库内路径 */
  function makeInboxNote(name: string, fm: Record<string, string>): string {
    fs.mkdirSync(inboxDir(), { recursive: true });
    const head = Object.entries(fm)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    fs.writeFileSync(path.join(inboxDir(), `${name}.md`), `---\n${head}\n---\n\n正文\n`, 'utf8');
    /**
     * ⚠️ `rescan()` **不发任何事件**（桩的注释写着）→ 索引看不到这个新文件，
     * 于是计划里压根没有这一篇（第一版就是这么假红的：既不在 moves 也不在 pending）。
     * 造完要**手动 `index.rebuild()`**（`specNotes` 里也是这个做法）。
     */
    app.vault.rescan();
    app.metadataCache.settle();
    ctx().index.rebuild();
    return `${KB}/${INBOX}/${name}.md`;
  }

  /** 造一篇**域外**（不在 Inbox）、且**算得出落点**的笔记（声明优先那条路） */
  function makeOutsideNote(name: string, declared: string): string {
    const dir = path.join(vaultRoot, KB, OUTSIDE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${name}.md`),
      `---\n文件位置: ${declared}\ntags: []\n---\n\n正文\n`,
      'utf8',
    );
    app.vault.rescan();
    app.metadataCache.settle();
    ctx().index.rebuild();
    return `${KB}/${OUTSIDE_DIR}/${name}.md`;
  }

  /** 现在这份计划（与 `runInboxTidy` 里那份同源：同一份判据、同一个骨架口径） */
  async function planNow(): Promise<RebuildPlan> {
    const kbRoot = ctx().settings.kbRoot();
    const shape = await vaultShapeOf(app as never, kbRoot);
    const routes = await readRouteTable(app as never, ctx().settings);
    const exclude = (await ctx().automation.get()).reconcile.exclude;
    return planRebuild({
      skeleton: shapeAsSkeleton(shape.dirs, exclude),
      kbRoot,
      metaDir: ctx().settings.get().metaDir,
      existingDirs: shape.dirs,
      exists: shape.exists,
      notes: rebuildNotesOf(ctx().index.getAll(), kbRoot),
      fallbackDir: fallbackDir(routes.table, kbRoot),
      scopeDir: INBOX,
    });
  }

  await suite.group('A2 · 一键自动整理（计划：只管 Inbox / 不建目录）', async () => {
    await suite.it('纯函数：`scopeDir` 只收 Inbox —— **域外那篇算得出落点也不许进**', async () => {
      /**
       * 🔴 **这条判据必须自己造出"域外也有得搬"的局面**（P6② 独立审查 B 路 🔴2.1）：
       * 夹具（P4 基线）里"全库计划"与"Inbox 计划"**一模一样**（都是 9 篇、全在 Inbox 里），
       * 于是"限定范围之后只会更少"恒真、那条反例守卫**静默不执行**，
       * 而 `scopeDir` 整行删掉（"一键自动整理"会整理**全库**）照样全绿 —— 而
       * "别顺手把全库都归位了"正是用户原话里点名的一半。
       * 造一篇 `01_Projects/...md`、声明去 `02_Areas/灵感杂记`：它**必须**出现在全库计划里、
       * **必须不**出现在 Inbox 计划里。
       */
      makeOutsideNote('__整理域外', '02_Areas/灵感杂记');
      await H.settle(120);
      const kbRoot = ctx().settings.kbRoot();
      const shape = await vaultShapeOf(app as never, kbRoot);
      const routes = await readRouteTable(app as never, ctx().settings);
      const notes = rebuildNotesOf(ctx().index.getAll(), kbRoot);
      const base = {
        skeleton: shapeAsSkeleton(shape.dirs, []),
        kbRoot,
        metaDir: ctx().settings.get().metaDir,
        existingDirs: shape.dirs,
        exists: shape.exists,
        notes,
        fallbackDir: fallbackDir(routes.table, kbRoot),
      };
      const all = planRebuild({ ...base, notes: rebuildNotesOf(ctx().index.getAll(), kbRoot) });
      const scoped = planRebuild({
        ...base,
        notes: rebuildNotesOf(ctx().index.getAll(), kbRoot),
        scopeDir: INBOX,
      });
      const outside = `${kbRoot}/${OUTSIDE_DIR}/__整理域外.md`;
      ok(
        all.moves.some((m) => m.from === outside),
        `前提：全库计划里**有**那篇域外的（${all.moves.map((m) => m.from).join(' | ')}）`,
      );
      ok(
        !scoped.moves.some((m) => m.from === outside),
        '🔴 限定了范围：域外那篇**一篇都不许进**（按路径比，不看数量）',
      );
      ok(
        scoped.moves.every((m) => m.from.startsWith(`${kbRoot}/${INBOX}/`)),
        '限定了范围：搬的全在 Inbox 里',
      );
      /**
       * ⚠️ 这条比数在"两份数量相同"时**没有分辨力** —— 但上面那条按路径的判据是硬的；
       * 这里只作为附加信息报出来（不再写成"守卫"那种条件式断言，那种写法会静默不跑）。
       */
      ok(
        scoped.moves.length < all.moves.length,
        `限范围之后真的更少（全库 ${all.moves.length} → Inbox ${scoped.moves.length}）`,
      );
      /**
       * 再用**集合**把这件事说死：Inbox 那份里域外的一篇都没有，全库那份里**有我那篇**。
       * ⚠️ 别写"全库那份比 Inbox 那份恰好多一篇" —— 夹具里本来就有别的域外候选
       *（P4 基线里 `02_Areas/内容创作 → 02_Areas/每日任务` 那两篇），"恰好 +1"当场假红。
       */
      const outsideIn = (p: RebuildPlan): string[] =>
        p.moves.filter((m) => !m.from.startsWith(`${kbRoot}/${INBOX}/`)).map((m) => m.from);
      eq(outsideIn(scoped).length, 0, 'Inbox 那份里域外的一篇都没有');
      ok(outsideIn(all).includes(outside), `全库那份里**有我那篇域外的**：${outsideIn(all).join(' | ')}`);
      // 清场：域外那篇带走（后面还有真链路与别的 spec 用同一个库）
      const of = app.vault.getAbstractFileByPath(outside);
      if (of) await app.vault.delete(of as TFile, true);
      await H.settle(120);
    });

    await suite.it('纯函数：「原地骨架」= 一个目录都不新建，落点只认已存在的目录', async () => {
      const plan = await planNow();
      eq(plan.newDirs.length, 0, '不新建任何目录（自动动作不替用户建目录）');
      const shape = await vaultShapeOf(app as never, ctx().settings.kbRoot());
      for (const m of plan.moves) {
        ok(shape.dirs.has(m.dirRel), `落点是库里已有的目录：${m.dirRel}`);
      }
    });

    await suite.it('纯函数：落点算不出来的那一篇 → 进 pending 且写明原因（**不许搬**）', async () => {
      /**
       * v2：Inbox 没信号的笔记落点 = 路由表「领域兜底」—— 把兜底**改成排除区里的目录**
       * 就造出"落点不可用"的局面（`fallback-excluded`：不搬、进待定、写明排除）。
       * （v1 的「领域: Meta → 99_Meta」那条别名路由随领域退役已删。）
       */
      const tablePath = `${KB}/99_Meta/02_模板库/标签-目录映射.json`;
      const rawTable = fs.readFileSync(path.join(vaultRoot, tablePath), 'utf8');
      const trimmed = JSON.parse(rawTable);
      trimmed['领域兜底'] = `${KB}/99_Meta`; // 排除区（自动化设置的「排除」里有 99_Meta）
      fs.writeFileSync(path.join(vaultRoot, tablePath), `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      let rel = '';
      try {
        rel = makeInboxNote(`${T}落在排除区`, { tags: '[]' });
        await H.settleIndex(app);
        const plan = await planNow();
        eq(
          plan.moves.find((m) => m.from === rel),
          undefined,
          '落点不可用的**不许搬**',
        );
        const pend = plan.pending.find((p) => p.path === rel);
        ok(pend, `要列进「待定」（待定里现有 ${plan.pending.length} 条）`);
        eq(pend?.code, 'fallback-excluded', '机器码要配套（A2 分组播报认它）');
        contains(pend?.why ?? '', '排除', `原因要写清：${pend?.why}`);
      } finally {
        // 收尾：删掉自造的笔记、把表写回去（别给后面的用例留状态）
        const made = app.vault.getAbstractFileByPath(rel);
        if (made) await app.vault.delete(made as TFile, true);
        fs.writeFileSync(path.join(vaultRoot, tablePath), rawTable, 'utf8');
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app);
      }
    });
  });

  await suite.group('A2 · 真链路：确认流 → 真搬 → 还原', async () => {
    await suite.it('一篇没信号的 Inbox 笔记 → 一键整理 → 搬到兜底目录 + 补「文件位置」→ 快照还原', async () => {
      __resetNotices();
      const name = `${T}没信号`;
      const rel = makeInboxNote(name, { tags: '[]' });
      // 域外再放一篇：整轮跑完它**必须原地不动**（否则"只整理 Inbox"没有真链路判据）
      const outsideRel = makeOutsideNote(`${T}域外`, '02_Areas/灵感杂记');
      await H.settleIndex(app);

      const plan = await planNow();
      /**
       * ⚠️ **落点的期望值不能拿实现的输出当**（P6② 独立审查 B 路 🔴2.2）：
       * `planNow()` 与 `runInboxTidy()` 调的是同一个 `planRebuild` —— 把落点算错
       *（例如兜底优先级写反）两边会**一起错**，用例恒等。
       * 所以这里钉**夹具里的字面量**：B 库路由表的「领域兜底」指到 `02_Areas`（v2 口径）。
       */
      const want = '02_Areas';
      const target = plan.moves.find((m) => m.from === rel);
      ok(target, `这一篇该被搬：${JSON.stringify(plan.pending.map((p) => p.why))}`);
      eq(target?.why, 'fallback', '它是靠「兜底目录」判出来的（不是声明；v2 原 `area`）');
      eq(target?.dirRel, want, '落点 = 路由表「领域兜底」那一档（字面量，不取实现的输出）');

      // 真跑：确认流会弹出来 → 点主按钮
      const running = runInboxTidy(ctx());
      await H.settle(150);
      const modal = H.q(document.body, '.kbw-modal');
      const preview = H.textOf(modal);
      contains(preview, '整理收件箱', '确认流标题写清动作');
      contains(preview, name, '逐条列出"哪篇 → 去哪"');
      contains(preview, target?.dirRel ?? '', '落点要看得见');
      /**
       * **P7.10 · #9：预览改逐篇**（《名》→ 落点）——
       * 不再是"00_Inbox 里 N 篇 → X"那种按目录聚合（FB2-现状-7 的反馈：看不出具体哪篇去哪）。
       */
      const rows = H.qa<HTMLElement>(modal, '.kbw-confirm-preview .kbw-plan-row');
      /**
       * ⚠️ 预览在 >12 篇时会折叠（`ui/confirm.ts`，独立审 🟢 提醒的脆点）：
       * 夹具现在很小、走不到那支；写成带折叠的两段式，将来夹具变大也不会假红。
       */
      eq(
        rows.length,
        Math.min(plan.moves.length, 12) + (plan.moves.length > 12 ? 1 : 0),
        `预览行数 = min(计划篇数,12)+折叠行（逐篇，计划 ${plan.moves.length} 行）`,
      );
      const mine = rows.find((r) => H.textOf(r).includes(`《${name}》`));
      ok(mine, `我那一篇在预览里且是《名》形状：${rows.map((r) => H.textOf(r)).join(' | ')}`);
      ok(
        !/里\s*\d+\s*篇/.test(H.textOf(mine as HTMLElement)),
        '那行不再是"00_Inbox 里 N 篇"的聚合写法',
      );
      /**
       * **蓝栏缩成三句短句**（对表方案 §9；旧长句退役）——
       * 黄（warnings）一个字不动，那半段由上面的 pending 断言照看。
       */
      const infoNotes = H.textOf(H.q<HTMLElement>(modal, '.kbw-msg.is-info'));
      contains(infoNotes, '双链会自动跟着改；搬走的会补上「文件位置」', '短句：双链与文件位置');
      contains(infoNotes, '重名不覆盖：内容相同自动跳过，不同就留着让你看', '短句：重名不覆盖');
      ok(
        !infoNotes.includes('尾链由 Obsidian 在改名那一刻'),
        '旧长句（尾链由…）不再出现',
      );
      const primary = H.q<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn.is-primary');
      ok(primary, '有主按钮');
      H.click(primary);
      const res = await running;
      ok(res, '执行完了');
      await H.settle(250);

      // ⓪ **域外那篇一动不动**（"只整理 Inbox"的真链路判据）
      ok(
        fs.existsSync(path.join(vaultRoot, outsideRel)),
        `域外那篇还在原地（${outsideRel}）`,
      );

      // ① 文件真的到了落点（路径由上面那条**字面量**期望拼出来）
      const landed = `${KB}/${want}/${name}.md`;
      ok(fs.existsSync(path.join(vaultRoot, landed)), `文件在 ${landed}`);
      ok(!fs.existsSync(path.join(vaultRoot, rel)), '原位没有了');
      // ② 「文件位置」被写下来（fallback 档要留痕，否则下次自动归位对它永远不生效）
      const text = fs.readFileSync(path.join(vaultRoot, landed), 'utf8');
      contains(text, '文件位置', `前言里要有「文件位置」：${text.slice(0, 120)}`);
      contains(text, target?.dirRel ?? '', '而且写的是那个目录');

      /**
       * ③ **撤销 = 从快照还原**（真链路那一层的最后一环）。
       * 用最新那份快照（`runInboxTidy` 里那次 mover 调用产生的那一份）。
       */
      const snaps = await ctx().snapshot.list();
      ok(snaps.length > 0, '有快照');
      const restored = await ctx().snapshot.restore(snaps[0].id);
      await H.settle(250);
      eq(restored.blocked.length, 0, `还原没有挡路的：${JSON.stringify(restored.blocked)}`);
      ok(fs.existsSync(path.join(vaultRoot, rel)), '还原之后**回到 Inbox**');
      // 清场（自造的临时笔记与它产生的日志都带走）
      const back = app.vault.getAbstractFileByPath(rel);
      if (back) await app.vault.delete(back as TFile, true);
      const backOut = app.vault.getAbstractFileByPath(outsideRel);
      if (backOut) await app.vault.delete(backOut as TFile, true);
      await ctx().snapshot.remove(snaps[0].id);
      await H.settle(120);
    });

    /**
     * **二级选择**（用户原话："整理收件箱后跳出二级选项，可选择跳转至全部笔记窗口自行整理
     * （即原方式）或一键自动整理"）。判据钉三件事：① 点它**不再直接跳走**；
     * ② 两条路都在菜单里；③ 「去全部笔记自己整理」= **原来那条路**（跳过去 + Inbox + 全选），
     * 一个字都没改（"只加不删"）。
     */
    await suite.it('首页「整理收件箱」：先弹二级选择；「自己整理」仍是老那条路', async () => {
      closeAllMenus();
      const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
        H.textOf(b).includes('首页'),
      );
      ok(nav, '导航里有「首页」');
      H.click(nav as Element);
      await H.settle(120);

      const btn = H.qa<HTMLElement>(document.body, '.kbw-quickrow button').find((b) =>
        H.textOf(b).includes('整理收件箱'),
      );
      ok(btn, '首页有「整理收件箱」');
      H.click(btn as Element);
      await H.settle(80);

      // ① 先弹菜单，**没有**直接跳走
      eq(ctx().store.get().activeModule, 'home', '点一下不该直接跳走（要先给二级选择）');
      const menu = H.q(document.body, '.kbw-menu');
      ok(menu, '二级选择菜单弹出来了');
      const labels = H.qa<HTMLElement>(menu, '.kbw-menu-item').map((i) => H.textOf(i));
      ok(labels.some((t) => t.includes('去全部笔记自己整理')), `有"自己整理"那条：${labels.join(' | ')}`);
      ok(labels.some((t) => t.includes('一键自动整理')), '有"一键自动整理"那条');
      contains(H.textOf(menu), '作用范围', '作用域行常驻（三条硬规矩之一）');

      // ② 点「去全部笔记自己整理」→ 老那条路：跳过去 + Inbox + 全选
      const goOwn = H.qa<HTMLElement>(menu, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('去全部笔记自己整理'),
      );
      H.click(goOwn as Element);
      await H.settle(180);
      eq(ctx().store.get().activeModule, 'notes', '跳到全部笔记');
      ok(
        await H.until(() => ctx().settings.get().treeSelected === '00_Inbox', 1500, 30),
        `带上目录筛选（等到落盘；实际 ${ctx().settings.get().treeSelected}）`,
      );
      ok(
        H.qa(document.body, '.kbw-trow.is-selected').length > 0,
        '筛选结果已全选（原方式一个字都没改）',
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.13a · #4：整理收件箱 —— 作用范围可选（Q11–Q13 拍定）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13a · #4 整理收件箱：作用范围可选（两入口一致）', async () => {
    /** 切到首页并点那枚「整理收件箱」快捷按钮（与既有用例同一手法） */
    async function openChoicesFromButton(): Promise<HTMLElement> {
      const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
        H.textOf(b).includes('首页'),
      );
      ok(nav, '导航里有「首页」');
      H.click(nav as Element);
      await H.settle(150);
      const btn = H.qa<HTMLElement>(document.body, '.kbw-quickrow button').find((b) =>
        H.textOf(b).includes('整理收件箱'),
      );
      ok(btn, '首页有「整理收件箱」');
      H.click(btn as Element);
      await H.settle(80);
      const menu = H.q<HTMLElement>(document.body, '.kbw-menu');
      ok(menu, '菜单弹出来了');
      return menu as HTMLElement;
    }

    await suite.it('「作用范围」行可点：弹一级目录（N 篇现算）→ 选完**就地更新**、动作跟随范围', async () => {
      closeAllMenus();
      try {
        const menu = await openChoicesFromButton();
        const scopeRow = H.q<HTMLElement>(menu, '.kbw-menu-scope');
        contains(H.textOf(scopeRow), '00_Inbox', '默认范围还是 00_Inbox');
        ok(scopeRow.classList.contains('is-pick'), '作用域行可点（is-pick —— Q13 的可选能力）');
        H.click(scopeRow);
        await H.settle(60);
        const menus = H.qa<HTMLElement>(document.body, '.kbw-menu');
        eq(menus.length, 2, '点它弹出选择菜单（**不加额外一栏**：就是那一行本身）');
        const picker = menus[1];
        const texts = H.textsOf(picker, '.kbw-menu-item');
        ok(texts.some((t) => t.includes('00_Inbox')), `列表里有 00_Inbox：${texts.join(' | ')}`);
        ok(
          texts.some((t) => /02_Areas · \d+ 篇/.test(t)),
          `目录行带**现算**篇数：${texts.join(' | ')}`,
        );
        // 选 02_Areas → 菜单就地更新（不闪不关：父菜单还在、子菜单收起）
        const areas = H.qa<HTMLElement>(picker, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('02_Areas'),
        );
        H.click(areas as Element);
        await H.settle(80);
        const menus2 = H.qa<HTMLElement>(document.body, '.kbw-menu');
        eq(menus2.length, 1, '选完**就地更新**（用 refresh：不闪不关，子菜单收起、父菜单还在）');
        const scopeRow2 = H.q<HTMLElement>(menus2[0], '.kbw-menu-scope');
        ok(H.textOf(scopeRow2).includes('02_Areas'), `范围换成 02_Areas：${H.textOf(scopeRow2)}`);
        eq(H.qa<HTMLElement>(menus2[0], '.kbw-menu-item').length, 3, '三项动作还在（不是重开了一扇新的）');
        // 动作跟随范围：点「去全部笔记自己整理」→ 跳去 02_Areas
        const goOwn = H.qa<HTMLElement>(menus2[0], '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('去全部笔记自己整理'),
        );
        H.click(goOwn as Element);
        await H.settle(200);
        eq(ctx().store.get().activeModule, 'notes', '跳到全部笔记');
        ok(
          await H.until(() => ctx().settings.get().treeSelected === '02_Areas', 1500, 30),
          `目录筛选跟随范围（等到落盘；实际 ${ctx().settings.get().treeSelected}）`,
        );
        /** 收尾：把目录选择还回 Inbox（别把 02_Areas 留给后面的用例） */
        await ctx().settings.save({ treeSelected: '00_Inbox' });
      } finally {
        closeAllMenus();
        await H.settle(80);
      }
    });

    await suite.it('首页右键同名项：**同一份实现**（点开的是同一个菜单：范围行可点 + 三项动作）', async () => {
      closeAllMenus();
      const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
        H.textOf(b).includes('首页'),
      );
      H.click(nav as Element);
      await H.settle(150);
      try {
        const host = H.q<HTMLElement>(document.body, '.kbw-home');
        ok(host, '首页宿主在');
        // 空白处右键 = 全局菜单（jsdom 没有 elementFromPoint，直接右键宿主 —— 与 p711 同一手法）
        host.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
        );
        await H.settle(60);
        const homeMenu = H.q<HTMLElement>(document.body, '.kbw-menu');
        ok(homeMenu, '首页菜单弹出');
        const item = H.qa<HTMLElement>(homeMenu, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('整理收件箱'),
        );
        ok(item, '有「整理收件箱」');
        H.click(item as Element);
        await H.settle(80);
        const menus = H.qa<HTMLElement>(document.body, '.kbw-menu');
        eq(menus.length, 1, '旧菜单收掉、只留新开的这一个（同一份实现：不是叠两扇/飞子菜单）');
        const menu = menus[0];
        const scopeRow = H.q<HTMLElement>(menu, '.kbw-menu-scope');
        contains(H.textOf(scopeRow), '00_Inbox', '同一个菜单：作用域行在');
        ok(scopeRow.classList.contains('is-pick'), '范围行可点（两入口一致）');
        const texts = H.textsOf(menu, '.kbw-menu-item');
        for (const w of ['去全部笔记自己整理', '一键自动整理', '整理建议…']) {
          ok(texts.some((t) => t.includes(w)), `三项动作里的「${w}」在：${texts.join(' | ')}`);
        }
      } finally {
        closeAllMenus();
        await H.settle(80);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.12 · #9/#11：AI 预整理并入一次确认（补声明 / 改声明 / 排除点名）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.12 · #9/#11 一键整理：AI 预整理并入一次确认', async () => {
    /** 在 Inbox 的**子目录**里造一篇（受控范围：只有自己造的笔记产生计划） */
    function writeIn(dirRel: string, name: string, body: string): string {
      const dir = path.join(vaultRoot, KB, dirRel);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.md`), body, 'utf8');
      app.vault.rescan();
      app.metadataCache.settle();
      ctx().index.rebuild();
      return `${KB}/${dirRel}/${name}.md`;
    }

    /**
     * 认领这轮自己造的快照并**只移除、不还原**（P7.12 调试一课）：
     * 还原要按"新→旧"对，而"哪份新"取决于 `list()` 的顺序——顺序不对时，
     * 先还原搬动快照（把文件搬回原处）再还原尾链快照（又把它建回**目标路径**）
     * 会留残影。这里的文件本来就是自造的 → 直接删（两处路径都删）+ 移除快照，
     * 等效且不依赖顺序。
     */
    async function dropMine(): Promise<void> {
      const snaps = (await ctx().snapshot.list()).filter(
        (s) => s.reason.includes('整理收件箱') || s.reason.includes('一键整理'),
      );
      for (const s of snaps) await ctx().snapshot.remove(s.id);
    }

    /** 收尾：删掉自造笔记（原位 + 可能的落点两处都删）+ 那个子目录 */
    async function cleanupNotes(made: string[], scope: string, landed: string[] = []): Promise<void> {
      for (const p of [...made, ...landed]) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f as TFile, true);
      }
      fs.rmSync(path.join(vaultRoot, KB, scope), { recursive: true, force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
    }

    await suite.it('AI 预整理：补声明 + 改声明并入同单（chips 明写）→ 搬后补尾链；设计内排除点名', async () => {
      const SCOPE = '00_Inbox/__整理AI箱';
      // 给假模型用的"相对库根"路径（与 `proposeLocus` 喂出去、收回来的是同一口径）
      const relA = `${SCOPE}/__整理AI补.md`;
      const relB = `${SCOPE}/__整理AI改.md`;
      const absA = writeIn(SCOPE, '__整理AI补', '---\ntags: []\n---\n\n正文\n'); // 缺声明 → AI 补
      const absB = writeIn(SCOPE, '__整理AI改', '---\n文件位置:\n  - 02_Areas/不在了\n---\n\n正文\n'); // 指向不存在 → AI 改
      const absC = writeIn(SCOPE, '__整理AI留', '---\ntags: []\n---\n\n正文\n'); // AI 没给值 → 照旧兜底
      const absD = writeIn(SCOPE, '__整理AI结构', '---\n类型: 指南\n文件位置:\n  - 02_Areas/也不在\n---\n\n正文\n'); // 结构性（设计内）
      const absE = writeIn(SCOPE, 'T_整理AI模板', '---\n类型: 模板\n---\n\n# x\n'); // 模板（设计内）
      await H.settleIndex(app);

      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        H.resetAi();
        const stub = H.stubAi({
          raw: JSON.stringify({
            reply: '挑了俩',
            locus: [
              { path: relA, to: '02_Areas/灵感杂记' },
              { path: relB, to: '02_Areas' },
            ],
          }),
        });
        await H.configAi(plugin);
        ctx().ai.transport = ctx().ai.http;
        __resetNotices();
        __resetUndo();

        const running = runInboxTidy(ctx(), { scope: SCOPE });
        ok(
          await H.until(
            () => H.qa(document.body, '.kbw-modal').some((x) => H.textOf(x).includes('即将整理')),
            3000,
          ),
          '确认流弹出来了',
        );
        const cfm = H.qa<HTMLElement>(document.body, '.kbw-modal').find((x) =>
          H.textOf(x).includes('即将整理'),
        )!;
        const rows = H.qa<HTMLElement>(cfm, '.kbw-confirm-preview .kbw-plan-row');
        const rowOf = (name: string): HTMLElement | undefined =>
          rows.find((r) => H.textOf(r).includes(`《${name}》`));

        /**
         * 落点期望全用**字面量**（不取实现的输出）：02_Areas / 02_Areas/灵感杂记
         * 都是夹具里真实存在的目录（路由表「领域兜底」也指 02_Areas）。
         */
        const pathsOf = (row: HTMLElement): string[] =>
          H.qa<HTMLElement>(row, '.kbw-plan-path').map((p) => H.textOf(p));
        const rA = rowOf('__整理AI补');
        ok(rA, `补声明那篇在单上（行：${rows.map((r) => H.textOf(r)).join(' | ')}）`);
        contains(H.textOf(rA!), 'AI 补「文件位置」：02_Areas/灵感杂记', 'chip 明写 AI 的动作与值');
        eq(pathsOf(rA!)[1], '02_Areas/灵感杂记', '落点 = AI 挑的（精确到路径元素）');

        const rB = rowOf('__整理AI改');
        ok(rB, '改声明那篇在单上');
        contains(H.textOf(rB!), 'AI 改声明 → 02_Areas', 'chip 明写"改"');
        eq(pathsOf(rB!)[1], '02_Areas', '落点 = AI 改后的声明');
        ok(H.maybe<HTMLElement>(rB!, '.kbw-plan-chip.is-warn'), 'warn 档在（覆盖旧值要显眼）');

        /**
         * 没拿到值的那篇（未声明 + 没 AI 值 + 在**子目录**范围里）：不进单、原地不动。
         * ⚠️ 子目录范围不走「兜底目录」那条（`planRebuild`：兜底只管 `00_Inbox` **本层**）——
         * 这里钉的是现状语义：**AI 只出值，没值就不动它**。
         */
        eq(rowOf('__整理AI留'), undefined, '没值的没进单（AI 只出值，没值不动）');

        contains(H.textOf(cfm), 'AI 预整理', '蓝栏说清 AI 干了什么');
        contains(H.textOf(cfm), '不参与归位（设计内）', '设计内排除在蓝栏有账');

        H.click(H.q<HTMLElement>(cfm, '.kbw-modal-foot .kbw-btn.is-primary'));
        const res = await running;
        ok(res, '执行完了');
        await H.settle(300);

        const pA = path.join(vaultRoot, KB, '02_Areas/灵感杂记', '__整理AI补.md');
        ok(fs.existsSync(pA), '补声明那篇落到了 AI 挑的目录');
        const tA = fs.readFileSync(pA, 'utf8');
        contains(tA, '文件位置', '搬动把「文件位置」补上了');
        contains(tA, '02_Areas/灵感杂记', '声明 = 它的新家');
        contains(tA, '## 关联笔记', 'AI 动过的那批**搬后补尾链**');

        const pB = path.join(vaultRoot, KB, '02_Areas', '__整理AI改.md');
        ok(fs.existsSync(pB), '改声明那篇落到了 AI 挑的目录');
        const tB = fs.readFileSync(pB, 'utf8');
        ok(!tB.includes('02_Areas/不在了'), '旧声明被覆盖（"改"生效）');
        contains(tB, '02_Areas', '声明 = 它的新家');
        contains(tB, '## 关联笔记', '尾链同样补上');

        ok(fs.existsSync(path.join(vaultRoot, absC)), '没值那篇原地不动');
        ok(!fs.readFileSync(path.join(vaultRoot, absC), 'utf8').includes('文件位置'), '也没被瞎写声明');
        ok(fs.existsSync(path.join(vaultRoot, absD)), '结构性笔记原地不动（设计内）');
        ok(fs.existsSync(path.join(vaultRoot, absE)), '模板原地不动（设计内）');

        ok(stub.calls.length >= 1, `AI 预整理真的调了模型（${stub.calls.length} 次）`);

        // #17：跑完的通知里点名"设计内排除"
        const notice = H.qa<HTMLElement>(document.body, '.kbw-notice').find((n) =>
          H.textOf(n).includes('不参与归位'),
        );
        ok(notice, `#17 通知点名设计内排除（现场：${H.textsOf(document.body, '.kbw-notice').join(' || ')}）`);
        contains(H.textOf(notice!), '模板', '点名模板');
        contains(H.textOf(notice!), '结构性笔记', '点名结构性笔记');
      } finally {
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        H.resetAi();
        await H.configAi(plugin, { apiKey: prevKey });
        await dropMine();
        await cleanupNotes([absA, absB, absC, absD, absE], SCOPE, [
          `${KB}/02_Areas/灵感杂记/__整理AI补.md`,
          `${KB}/02_Areas/__整理AI改.md`,
        ]);
        __resetUndo();
        __resetNotices();
        await H.settle(120);
      }
    });

    await suite.it('AI 预整理出错（假模型 500）→ 轻提示 + 照原件继续（配了也不挡一键整理）', async () => {
      const SCOPE = '00_Inbox/__整理AI箱2';
      const absM = writeIn(SCOPE, '__整理AI搬', '---\n文件位置:\n  - 02_Areas\n---\n\n正文\n'); // 声明有效：不靠 AI 也搬
      const absN = writeIn(SCOPE, '__整理AI挂', '---\ntags: []\n---\n\n正文\n'); // 缺声明：AI 挂了 → 原地不动
      await H.settleIndex(app);

      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        H.resetAi();
        H.stubAi({ status: 500 });
        await H.configAi(plugin);
        ctx().ai.transport = ctx().ai.http;
        __resetNotices();
        __resetUndo();

        const running = runInboxTidy(ctx(), { scope: SCOPE });
        ok(
          await H.until(
            () => H.qa(document.body, '.kbw-modal').some((x) => H.textOf(x).includes('即将整理')),
            3000,
          ),
          'AI 挂了也照常走到确认流（有可搬的）',
        );
        contains(
          H.textsOf(document.body, '.kbw-notice').join(' || '),
          '没跑成',
          'AI 挂了要有轻提示（不静默）',
        );
        const cfm = H.qa<HTMLElement>(document.body, '.kbw-modal').find((x) =>
          H.textOf(x).includes('即将整理'),
        )!;
        eq(H.qa<HTMLElement>(cfm, '.kbw-plan-chip').length, 0, '没有 AI 徽标（原件照跑）');
        H.click(H.q<HTMLElement>(cfm, '.kbw-modal-foot .kbw-btn.is-primary'));
        const res = await running;
        ok(res, '照旧搬成');
        await H.settle(300);
        ok(
          fs.existsSync(path.join(vaultRoot, KB, '02_Areas', '__整理AI搬.md')),
          '声明的照常搬（没被 AI 故障连累）',
        );
        ok(fs.existsSync(path.join(vaultRoot, absN)), '缺声明那篇原地不动（AI 挂了没人替它挑）');
      } finally {
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        H.resetAi();
        await H.configAi(plugin, { apiKey: prevKey });
        await dropMine();
        await cleanupNotes([absM, absN], SCOPE, [`${KB}/02_Areas/__整理AI搬.md`]);
        __resetUndo();
        __resetNotices();
        await H.settle(120);
      }
    });
  });
}
