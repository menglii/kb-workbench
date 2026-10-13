/**
 * spec：**P7.17 · YAML 专项 · 二**（存量 YAML 补齐）—— 条目真源 `P7.17开工提示词.md` §1；
 * 口径回改在 `交互规格.md` §13 / `属性规范.md` §3/§4。
 *
 * 四组：
 *   · **修洞 + D1（真写盘）**：有前言缺键 → 按行合并补缺键（已有键/正文逐字节不动）·
 *     幂等（补完再扫不再列）· `文件位置` = 实际落点（顶层写 `.`、读侧归一空串）·
 *     `收藏: false` 写齐 · 补完不落"缺文件位置"候选 / 不报错位 · 面板真链路一遍（含撤销）；
 *   · **合并矩阵分档**（真库现算）：旧值待迁（映射表一个真源）· 值认不出（覆盖候选，
 * via 'guess'）· 删键档只进待迁不进覆盖 · 坏前言跳过（逐篇 + 文件一字不动）·
 *     `文件位置` 异常只报告（不存在 / 不一致两档）· 四个键不参与覆盖（对照）；
 *   · **覆盖模式（D2 真链路）**：勾一篇 → 确认 → 快照 → **只改那键**（其余逐字节不动）→ 撤销还原；
 *   · **入口两处**：向导询问卡（N 与 `planTodoCount` 同数 → 去补全开面板；N=0 的形态）·
 *     设置 → 自动化「当前 N 篇可补」。
 *
 * ⚠️ 夹具全带 `__p717` 前缀，每条自己收场（`metadataCache.settle()` 那套安全删法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { joinPath } from '../../src/core/paths';
import { declaredPositions } from '../../src/services/schema';
import { planBackfillOf, planTodoCount } from '../../src/services/backfill';
import { planReconcile } from '../../src/services/reconcile';
import { openBackfillPanel } from '../../src/ui/backfill-panel';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';

export async function specP717(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const KB = '01_新知识库';

  /** kbRoot 拨回默认（每个 spec 自己的库，防御性自证前提 —— 与 p715/p716/p716b 同款） */
  async function ensureKbRootDefault(): Promise<string> {
    if (ctx().settings.kbRoot() !== KB) {
      await ctx().settings.save({ kbRoot: KB });
      await H.settle(150);
    }
    return KB;
  }

  /** 安全带删法（P7.14c 记档）：裸 `fs.rmSync` 之后桩的 metadataCache 还有一个滞后重解析定时器 */
  async function rmFix(abs: string): Promise<void> {
    fs.rmSync(abs, { force: true, recursive: true });
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(120);
  }

  /** 造自用夹具（裸文本；缺键/坏前言这些形状 `H.note` 序列化不出来） */
  async function writeRaw(rel: string, text: string): Promise<string> {
    const abs = joinPath(await ensureKbRootDefault(), rel);
    const full = path.join(vaultRoot, abs);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(150);
    return abs;
  }

  const readAbs = (abs: string): string => fs.readFileSync(path.join(vaultRoot, abs), 'utf8');

  async function untilEl<T>(get: () => T | null | undefined, timeoutMs = 4000): Promise<T | null> {
    const got = await H.until(() => Boolean(get()), timeoutMs);
    return got ? (get() as T) : null;
  }

  function topModal(needle = ''): HTMLElement | null {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal').filter(
      (m) => needle === '' || H.textOf(m).includes(needle),
    );
    return all.length > 0 ? all[all.length - 1] : null;
  }

  function clickModalBtn(modal: HTMLElement, btnText: string): boolean {
    const b = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) =>
      H.textOf(x).includes(btnText),
    );
    if (!b) return false;
    H.click(b);
    return true;
  }

  async function closeEverything(): Promise<void> {
    for (let i = 0; i < 6 && H.maybe(document.body, '.kbw-modal'); i += 1) {
      H.keydown(document.body, 'Escape');
      await H.settle(120);
    }
    closeAllMenus();
    purgeOverlays();
    await H.settle(150);
  }

  // ════════════════════════════════════════════════════════════
  // 一 · 修洞 + D1（真写盘）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.17 · 修洞与 D1（有前言补缺键 · 文件位置=实际落点 · 幂等）', async () => {
    await suite.it('有前言缺键 → 按行合并补缺键：缺的键在、已有键与正文逐字节不动；补完再扫不再列', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '01_Projects/__p717缺键.md';
      const abs = `${kb}/${rel}`;
      /** 缺 状态/文件位置/创建日期/收藏，还缺尾链；已有 类型/tags 与正文必须一字不动 */
      const RAW = '---\n类型: 想法\ntags:\n  - 保留我\n---\n\n正文甲，一字不动。\n';
      try {
        await writeRaw(rel, RAW);
        const file = ctx().index.get(abs)?.file ?? null;
        ok(file, '前提：夹具进索引');
        // 先钉"旧口径会漏"：计划里它是可补项（旧写法会一个字都不碰）
        const plan0 = await planBackfillOf(ctx());
        const it0 = plan0.items.find((i) => i.path === abs);
        ok(it0, `★ 有前言缺键 → 可补（旧口径会漏掉它）——skipped=${plan0.skipped.length}`);
        contains((it0?.yamlAdded ?? []).join('、'), '文件位置', '计划里点出要补「文件位置」（D1）');

        const outcome = await ctx().completion.fillFile(file!, { withPosition: true });
        eq(outcome.kind, 'filled', `★ 真写：${outcome.detail}`);
        const after = readAbs(abs);
        // 成对：缺的键在 + 已有键/正文一字不动
        contains(after, '类型: 想法', '★ 已有键原样（值都没被动）');
        contains(after, '  - 保留我', '★ 块值也一字不动');
        contains(after, '正文甲，一字不动。', '★ 正文逐字节不动');
        contains(after, '状态: 进行中', '缺的键补上（01_Projects 目录默认）');
        contains(after, '文件位置:\n  - 01_Projects', '★ D1：文件位置 = 实际落点');
        contains(after, '收藏: false', '★ D1：收藏写齐');
        ok(/(^|\n)创建日期: \d{4}-\d{2}-\d{2}/.test(after), '创建日期 = 文件创建时间（不是今天）');
        contains(after, '## 关联笔记', '尾链缺就补');
        /**
         * 强度加一档（独立审 🟡4）：子串判据抓得住"值被改写"，抓不住"重排 / 丢行 /
         * 改缩进" —— 再钉一条：**原文本的每一行都按原序出现在产物里**。
         */
        {
          const rawLines = RAW.split('\n');
          let cursor = 0;
          const inOrder = rawLines.every((line) => {
            const at = after.indexOf(line, cursor);
            if (at < 0) return false;
            cursor = at + line.length;
            return true;
          });
          ok(inOrder, '★ 原有每一行按原序都在（重排 / 丢行 / 插错位会红）');
        }

        // 补完的后果两条：不落"缺文件位置"候选（声明非空）+ 不报错位
        // ⚠️ index 的 props/flags 跟着 metadataCache 走（~300ms 滞后）→ 轮询，别写死一拍
        ok(
          await H.until(
            () => declaredPositions(ctx().index.get(abs)?.props ?? {}).length > 0,
            3000,
            50,
          ),
          '★ 声明非空 → 不落"缺文件位置"候选',
        );
        eq(ctx().index.get(abs)?.flags.includes('position-mismatch') ?? true, false, '★ 体检不报错位');
        // 幂等：补完再扫不再列
        const plan1 = await planBackfillOf(ctx());
        eq(plan1.items.some((i) => i.path === abs), false, '★ 补完再扫 = 不再列（幂等）');
      } finally {
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('顶层写「.」（读回归一成空串）· 00_Inbox 不补「状态」（拿不准不猜）', async () => {
      const kb = await ensureKbRootDefault();
      const relTop = '__p717顶层.md';
      const relInbox = '00_Inbox/__p717收件.md';
      const relEmpty = '00_Inbox/__p717空声明.md';
      /** 库根**顶层**（直接躺在 kbRoot 下 → folderRel = ''，写「.」那条路） */
      const absTop = `${kb}/${relTop}`;
      const absInbox = `${kb}/${relInbox}`;
      const absEmpty = `${kb}/${relEmpty}`;
      try {
        await writeRaw(relTop, '---\ntags: []\n---\n\n顶层正文。\n');
        await writeRaw(relInbox, '---\ntags: []\n---\n\n收件正文。\n');
        /** `文件位置: []` = 键在值空（P7.16b 起"未声明"的形状）—— **也要补**（独立审 🟡2） */
        await writeRaw(relEmpty, '---\n类型: 笔记\n文件位置: []\n---\n\n空声明正文。\n');
        const fTop = ctx().index.get(absTop)?.file ?? null;
        const fInbox = ctx().index.get(absInbox)?.file ?? null;
        const fEmpty = ctx().index.get(absEmpty)?.file ?? null;
        ok(fTop && fInbox && fEmpty, '前提：三篇都进索引');
        await ctx().completion.fillFile(fTop!, { withPosition: true });
        await ctx().completion.fillFile(fInbox!, { withPosition: true });
        await ctx().completion.fillFile(fEmpty!, { withPosition: true });
        const t = readAbs(absTop);
        contains(t, '文件位置:\n  - .', '★ 顶层写根标记 `.`（P7.15 口径）');
        eq(declaredPositions(ctx().index.get(absTop)?.props ?? {}).join(','), '', '★ 读侧归一成空串');
        const i = readAbs(absInbox);
        contains(i, '文件位置:\n  - 00_Inbox', '收件箱里写实际落点');
        ok(!/(^|\n)状态:/.test(i), '★ 00_Inbox 不写状态（"还在 Inbox"本身就是待整理）');
        contains(i, '类型: 笔记', '类型按目录默认');
        const e = readAbs(absEmpty);
        contains(e, '文件位置:\n  - 00_Inbox', '★ 键在值空（`[]`）也算缺 → 补成实际落点（独立审 🟡2）');
        ok(!e.includes('文件位置: []'), '……空数组被替换掉（不是叠一段）');
        ok(
          await H.until(
            () => declaredPositions(ctx().index.get(absEmpty)?.props ?? {}).length > 0,
            3000,
            50,
          ),
          '★ 读回非空 → 不落"缺文件位置"候选（D1 的承诺对这类篇也成立）',
        );
      } finally {
        await rmFix(path.join(vaultRoot, absTop));
        await rmFix(path.join(vaultRoot, absInbox));
        await rmFix(path.join(vaultRoot, absEmpty));
      }
    });

    await suite.it('面板真链路：扫描 → 补全 N 篇 → 确认 → 写盘（含撤销条）→ 撤销逐字节还原', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '01_Projects/__p717面板.md';
      const abs = `${kb}/${rel}`;
      const RAW = '---\ntags: []\n---\n\n面板正文。\n';
      try {
        await writeRaw(rel, RAW);
        const h = openBackfillPanel(ctx());
        ok(h, '面板开了');
        const row = await untilEl(() =>
          H.qa<HTMLElement>(document.body, '.kbw-mig-row').find((r) => H.textOf(r).includes('__p717面板')),
        );
        ok(row, '★ 扫描列表里有它');
        contains(H.textOf(row!), '补了：', '行里点出补哪几个键（新报告口径）');
        // 点「补全 N 篇」→ 确认流
        const runBtn = H.qa<HTMLElement>(document.body, '.kbw-modal-foot .kbw-btn').find((b) =>
          /^补全 \d+ 篇$/.test(H.textOf(b)),
        );
        ok(runBtn, '有「补全 N 篇」主按钮');
        H.click(runBtn as Element);
        const cfm = await untilEl(() => topModal('即将补全'));
        ok(cfm, '★ 确认流（动库前确认只能过 ui/confirm）');
        ok(clickModalBtn(cfm!, '补全 '), '点了主按钮');
        ok(
          await H.until(() => readAbs(abs).includes('文件位置:\n  - 01_Projects'), 4000, 40),
          '★ 真写盘：文件位置 = 实际落点（面板传了 withPosition）',
        );
        const t = readAbs(abs);
        contains(t, '收藏: false', '收藏也写齐（D1）');
        contains(t, '面板正文。', '正文不动');
        const u = await untilEl(() => H.currentUndoButton('撤销'));
        ok(u, '★ 补完出撤销条（快照兜底）');
        H.click(u as Element);
        ok(await H.until(() => readAbs(abs) === RAW, 4000, 40), '★ 撤销 = 快照还原：逐字节回到原样');
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 一补 · 快照 ENOENT 修法（P7.16 欠账：陈旧引用者）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.17 · 快照 ENOENT 修法（resolvedLinks 的陈旧引用者）', async () => {
    await suite.it('陈旧引用者不许进快照：move 不许被它整批中止', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p717被搬.md';
      const abs = `${kb}/${rel}`;
      const ghost = `${kb}/00_Inbox/__p717幽灵源.md`; // 从不存在
      const toDirRel = '00_Inbox/__p717目的地';
      const toDir = `${kb}/${toDirRel}`;
      try {
        await writeRaw(rel, '---\n类型: 笔记\n---\n\n被搬正文。\n');
        await app.vault.createFolder(toDir);
        await H.settle(220);
        const file = ctx().index.get(abs)?.file ?? null;
        ok(file, '前提：夹具在索引里');
        /**
         * 造"平台缓存里残留的陈旧 source 键"：桩的 `resolvedLinks` 是**现算 getter**——
         * 直接在实例上罩一个假 getter（真机上是重命名风暴后平台自己的残留，
         * 2026-10-09 真机取证：`来源=extraContents；库注册表=不在`）。
         */
        const mc = app.metadataCache as unknown as Record<string, unknown>;
        Object.defineProperty(mc, 'resolvedLinks', {
          configurable: true,
          get: () => ({ [ghost]: { [abs]: 1 } }),
        });
        try {
          const res = await ctx().mover.move({
            targets: [{ dir: toDir, files: [file!] }],
            source: 'menu',
            reason: '测试：陈旧引用者不许进快照',
          });
          /**
           * ★ 修法口径（`mover.reverseLinkSources` 的陈旧键过滤）：盘上都没有这个文件
           * = 没有内容需要保护 → 不当引用者。没有它：capture 读不到幽灵路径 → 抛 →
           * "失败即停"把这次 move 整批中止（真机症状 = 一拍自动归位被安全取消 + 一条内部报错）。
           */
          eq(res.error ?? '', '', '★ 陈旧引用者不许让快照失败、不许整批中止');
          eq(res.moved.length, 1, '搬照常完成');
          ok(H.exists(vaultRoot, `${toDir}/__p717被搬.md`), '文件到位');
        } finally {
          delete mc.resolvedLinks;
        }
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, toDir));
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('自动归位不把目标定在归集夹（收拢"在途痕迹" —— 残留那一枚的护栏）', async () => {
      const GU = '04_Archives/旧笔记-20260909';
      const raw = `${KB}/02_Areas/_领域中心.md`;
      const e = {
        file: { path: raw, basename: '_领域中心' },
        props: { 文件位置: [GU] },
        flags: [],
        effectivePosition: '02_Areas',
        path: raw,
        basename: '_领域中心',
        isTemplate: false,
        mtime: 0,
        size: 10,
      } as unknown as Parameters<typeof planReconcile>[0][number];
      const plan = planReconcile([e], { [raw]: ['02_Areas'] }, {
        kbRoot: KB,
        exclude: [],
        /** 归集夹"此刻存在"（收拢在途的那一小段）—— 没有护栏这里会真搬进去 → 残留 */
        dirs: new Set([GU, '02_Areas']),
      });
      eq(plan.moves.length, 0, '★ 不搬（旧行为：目标目录存在就搬 → 还原时挡下 → 残留在归集夹）');
      ok(
        plan.skips.some((s) => s.why.includes('归集夹')),
        '只报：目标在收拢的归集夹里（在途痕迹）',
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  // 一补二 · 切库根后报告日志仍可写（本轮探针实测出来的静默停写）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.17 · 切库根后报告日志仍可写（探针实测的红）', async () => {
    await suite.it('先写一条 → 切库根 → 再写一条：第二次不许把它 catch 成静默停写', async () => {
      const kb = await ensureKbRootDefault();
      const scratch = '09_p717另一个根';
      try {
        fs.mkdirSync(path.join(vaultRoot, scratch), { recursive: true });
        app.vault.rescan();
        await app.metadataCache.settle();
        ctx().index.rebuild();
        await H.settle(150);
        // 先在默认库根写一条 —— 把 ReportService 的"已确保"状态打上（旧写法 = ensured 布尔）
        const first = await ctx().report.log({
          action: 'P717日志甲',
          result: 'ok',
          source: 'manual',
          summary: '第一条（打状态用）',
        });
        ok(first != null, '默认库根下能写日志');
        // 切库根（模拟向导 / 设置里换库）→ 再写一条
        await ctx().settings.save({ kbRoot: scratch });
        await H.settle(200);
        ctx().index.rebuild();
        await H.settle(150);
        const second = await ctx().report.log({
          action: 'P717日志乙',
          result: 'ok',
          source: 'manual',
          summary: '第二条（切库根之后）',
        });
        ok(
          second != null,
          `★ 切库根后仍能写日志（旧写法 ensured 布尔短路 → ENOENT 静默停写）——lastError=${ctx().report.lastError ?? '无'}`,
        );
        ok(H.exists(vaultRoot, `${scratch}/99_Meta/05_操作日志`), '新库根下的日志目录被建出来了');
      } finally {
        await ensureKbRootDefault();
        await rmFix(path.join(vaultRoot, scratch));
        // 第一条日志落在默认库根 —— 按标记删掉（同一批用例也在用这个目录）
        const logDir = path.join(vaultRoot, kb, '99_Meta/05_操作日志');
        if (fs.existsSync(logDir)) {
          for (const f of fs.readdirSync(logDir)) {
            if (f.includes('P717日志甲')) fs.rmSync(path.join(logDir, f), { force: true });
          }
          app.vault.rescan();
          await app.metadataCache.settle();
          ctx().index.rebuild();
          await H.settle(150);
        }
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 二 · 合并矩阵分档（真库现算）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.17 · 合并矩阵分档（旧值待迁 / 认不出 / 坏前言 / 位置异常）', async () => {
    await suite.it('旧值待迁（映射表）· 认不出（覆盖候选）· 删键档只进待迁 · 四键不参与覆盖（对照）', async () => {
      const kb = await ensureKbRootDefault();
      const relOld = '00_Inbox/__p717旧值.md';
      const relOdd = '00_Inbox/__p717认不出.md';
      const relFour = '00_Inbox/__p717四键.md';
      const absOld = `${kb}/${relOld}`;
      const absOdd = `${kb}/${relOdd}`;
      const absFour = `${kb}/${relFour}`;
      try {
        await writeRaw(relOld, '---\n类型: 想法\n---\n\n旧值正文。\n');
        await writeRaw(relOdd, '---\n类型: 旷世奇文\n状态: 待整理\n---\n\n认不出正文。\n');
        /**
         * 对照：四个**不参与覆盖**的键就算值再怪也不该冒头
         *（tags / 创建日期 / 收藏 / 文件位置 —— P7.17 · D2 原文）。
         */
        await writeRaw(
          relFour,
          '---\n类型: 笔记\n创建日期: 不是日期\ntags:\n  - x\n收藏: 也许\n文件位置:\n  - 00_Inbox\n---\n\n对照正文。\n',
        );
        const plan = await planBackfillOf(ctx());
        // 旧值档（映射表认得：想法 → 笔记）
        const lOld = plan.legacy.find((x) => x.path === absOld && x.key === '类型');
        ok(lOld, '★ 「想法」进旧值待迁');
        eq(lOld?.to, '笔记', '★ 映射值来自 migrate.ts 的映射表（想法 → 笔记）');
        const cOld = plan.coverage.find((x) => x.path === absOld && x.key === '类型');
        eq(cOld?.via, 'map', '★ 覆盖区含旧值档（§1.1 拍定「含」），via=map');
        eq(cOld?.to, '笔记', '覆盖建议值同源');
        // 认不出档
        const cOdd = plan.coverage.find((x) => x.path === absOdd && x.key === '类型');
        eq(cOdd?.via, 'guess', '★ 认不出的值进覆盖候选（via=guess）');
        eq(cOdd?.to, '笔记', '建议值 = 目录默认兜底');
        // 删键档：只进待迁、不进覆盖
        const lDrop = plan.legacy.find((x) => x.path === absOdd && x.key === '状态');
        ok(lDrop, '★ 「待整理」（删键档）进旧值待迁');
        eq(lDrop?.to, '', '删键档没有"新值"');
        eq(plan.coverage.some((x) => x.path === absOdd && x.key === '状态'), false, '★ 删键档不进覆盖（没有值可写）');
        ok(plan.legacy.some((x) => x.path === absOld), '「N 篇旧值待迁」按篇计数（含旧值那篇）');
        // 对照：四键不参与覆盖
        eq(plan.coverage.some((x) => x.path === absFour), false, '★ 四键（tags/创建日期/收藏/文件位置）不参与覆盖');
        eq(plan.legacy.some((x) => x.path === absFour), false, '……也不进旧值档');
      } finally {
        await rmFix(path.join(vaultRoot, absOld));
        await rmFix(path.join(vaultRoot, absOdd));
        await rmFix(path.join(vaultRoot, absFour));
      }
    });

    await suite.it('坏前言整篇跳过（逐篇列名、文件一字不动）· 文件位置异常只报告（不存在 / 不一致）', async () => {
      const kb = await ensureKbRootDefault();
      const relBad = '00_Inbox/__p717坏前言.md';
      const relGhost = '00_Inbox/__p717幽灵.md';
      const relMis = '00_Inbox/__p717错位.md';
      const absBad = `${kb}/${relBad}`;
      const absGhost = `${kb}/${relGhost}`;
      const absMis = `${kb}/${relMis}`;
      const RAW_BAD = '---\n创建日期: {{date}}\ntags: []\n---\n\n坏前言正文。\n';
      try {
        await writeRaw(relBad, RAW_BAD);
        await writeRaw(relGhost, '---\n类型: 笔记\n文件位置:\n  - 99_p717没这个目录\n---\n\n幽灵正文。\n');
        await writeRaw(relMis, '---\n类型: 笔记\n文件位置:\n  - 02_Areas\n---\n\n错位正文。\n');
        const plan = await planBackfillOf(ctx());
        // 坏前言：进 fragile 档（逐篇列名），items/值档都不见它
        const fBad = plan.fragile.find((x) => x.path === absBad);
        ok(fBad, `★ 坏前言进「跳过」档（${plan.fragile.length} 篇）`);
        contains(fBad?.why ?? '', '创建日期', '逐篇点名坏在哪个键');
        eq(plan.items.some((i) => i.path === absBad), false, '……不列进"可补"');
        eq(plan.coverage.some((x) => x.path === absBad), false, '……不进覆盖候选');
        // 真写一遍也一个字不动（buildFillPlan 的坏前言守卫）
        const f = ctx().index.get(absBad)?.file ?? null;
        ok(f, '前提：坏前言篇在索引里');
        const outcome = await ctx().completion.fillFile(f!, { withPosition: true });
        eq(outcome.kind, 'skipped', '★ 写口整篇跳过');
        eq(readAbs(absBad), RAW_BAD, '★ 文件一字不动（嵌套形状没被写坏）');
        // 位置异常两档
        const g = plan.posIssues.find((x) => x.path === absGhost);
        ok(g, '★ 声明指向不存在的目录 → 报告');
        contains(g?.why ?? '', '99_p717没这个目录', '点出那个不存在的路径');
        const m = plan.posIssues.find((x) => x.path === absMis);
        ok(m, '★ 声明与实际不一致 → 报告');
        contains(m?.why ?? '', '不一致', '措辞是"不一致"');
      } finally {
        await rmFix(path.join(vaultRoot, absBad));
        await rmFix(path.join(vaultRoot, absGhost));
        await rmFix(path.join(vaultRoot, absMis));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 三 · 覆盖模式（D2 真链路）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.17 · 覆盖模式（逐篇勾选 · 只碰那一个键 · 可撤销）', async () => {
    await suite.it('勾一篇 → 确认 → 只改那键（其余逐字节不动）→ 撤销逐字节还原', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p717覆盖.md';
      const abs = `${kb}/${rel}`;
      const RAW =
        '---\n类型: 想法\n状态: 进行中\n文件位置:\n  - 00_Inbox\n创建日期: 2026-01-01\ntags: []\n收藏: false\n---\n\n覆盖正文不动。\n';
      const AFTER = RAW.replace('类型: 想法', '类型: 笔记');
      try {
        await writeRaw(rel, RAW);
        openBackfillPanel(ctx());
        const lab = await untilEl(() =>
          H.qa<HTMLElement>(document.body, '.kbw-mig-cover').find((l) =>
            H.textOf(l).includes('__p717覆盖'),
          ),
        );
        ok(lab, '★ 覆盖区列出它');
        contains(H.textOf(lab!), '类型：想法 → 笔记', '★ 行里是 from → to 的预览（建议来自映射表）');
        // 勾选 → 按钮就绪（默认全不勾 → 勾之前按钮是灰的，也顺手钉了 D2 的"默认")
        const cb = lab!.querySelector('input.kbw-mig-check') as HTMLInputElement | null;
        ok(cb, '行里有勾选框');
        eq(cb!.checked, false, '★ 默认全不勾（D2）');
        const covBtn = (): HTMLElement | undefined =>
          H.qa<HTMLElement>(document.body, '.kbw-mig-op .kbw-btn').find((b) =>
            H.textOf(b).startsWith('覆盖所选'),
          );
        eq(covBtn()?.hasAttribute('disabled') ?? false, true, '没勾时按钮是灰的');
        cb!.checked = true;
        cb!.dispatchEvent(new Event('change', { bubbles: true }));
        await H.settle(80);
        contains(H.textOf(covBtn() ?? document.body), '覆盖所选 1 处', '勾了 → 计数 1');
        H.click(covBtn() as Element);
        const cfm = await untilEl(() => topModal('即将覆盖'));
        ok(cfm, '★ 确认流');
        contains(H.textOf(cfm!), '类型', '确认单写明改哪个键');
        ok(clickModalBtn(cfm!, '覆盖 1 处'), '点了主按钮');
        ok(await H.until(() => readAbs(abs).includes('类型: 笔记'), 4000, 40), '★ 封面生效（fm.set 只碰那一个键）');
        eq(readAbs(abs), AFTER, '★ 其余键与正文逐字节不动（成对判据）');
        const u = await untilEl(() => H.currentUndoButton('撤销'));
        ok(u, '★ 覆盖完出撤销条');
        H.click(u as Element);
        ok(await H.until(() => readAbs(abs) === RAW, 4000, 40), '★ 撤销 = 快照还原：逐字节回到原样');
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // 四 · 入口两处（向导询问卡 · 设置动态提示）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.17 · 入口（向导询问卡 · 设置动态提示）', async () => {
    /** 连点向导底栏主按钮 n 次（p72b 同款：skip 引言 → 第 1 步 → 第 2 步） */
    async function advanceWizard(n: number): Promise<void> {
      for (let i = 0; i < n; i += 1) {
        const b = H.qa<HTMLElement>(document.body, '.kbw-modal-foot .kbw-btn').find(
          (x) => H.textOf(x) === '下一步' || H.textOf(x) === '跳过介绍',
        );
        if (b) H.click(b);
        await H.settle(140);
      }
    }
    async function toggleAutomation(on: boolean): Promise<void> {
      const row = H.qa<HTMLElement>(document.body, '.kbw-wiz-toggle').find((r) =>
        H.textOf(r).includes('笔记自动化'),
      );
      ok(row, '前提：屏 2 有「笔记自动化」开关行');
      const cb = row!.querySelector('.kbw-wiz-check-box') as HTMLInputElement | null;
      ok(cb, '前提：开关行里有勾选框');
      if (cb!.checked !== on) {
        cb!.checked = on;
        cb!.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await H.settle(120);
    }
    const gateBefore = ctx().gate.isOn('automation');

    await suite.it('拨开「笔记自动化」→ 卡滑出（N 与 planTodoCount 同数）→ 去补全开面板', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p717卡.md';
      const abs = `${kb}/${rel}`;
      try {
        await writeRaw(rel, '---\ntags: []\n---\n\n卡正文。\n');
        ctx().openWizard();
        await H.settle(150);
        await advanceWizard(2); // 引言 → 第 1 步 → 第 2 步（模块开关）
        await toggleAutomation(true);
        const card = await untilEl(() => H.maybe<HTMLElement>(document.body, '.kbw-wiz-ask'));
        ok(card, '★ 拨开 → 询问卡出现');
        // 异步扫：等"正在清点…"换成正式文案
        ok(
          await H.until(() => !H.textOf(H.maybe(document.body, '.kbw-wiz-ask')).includes('正在清点'), 4000, 50),
          '扫描完成（卡原地更新）',
        );
        const n = planTodoCount(await planBackfillOf(ctx()));
        ok(n > 0, `前提：有要改的（N=${n}）`);
        contains(H.textOf(H.maybe(document.body, '.kbw-wiz-ask')), `还有 ${n} 篇`, '★ N = planTodoCount 现算的同一个数');
        const go = H.qa<HTMLElement>(document.body, '.kbw-wiz-ask-btns .kbw-btn').find((b) =>
          H.textOf(b).includes('去补全'),
        );
        ok(go, '卡里有「去补全」');
        H.click(go as Element);
        const panel = await untilEl(() => topModal('一键补全存量笔记'));
        ok(panel, '★ 「去补全」→ 补全面板开（带范围：面板自己会扫）');
        await closeEverything();
        // 再拨一次（关掉 → 再拨开）→ 卡重出
        ctx().openWizard();
        await H.settle(150);
        await advanceWizard(2);
        await toggleAutomation(false);
        await H.settle(100);
        eq(H.maybe(document.body, '.kbw-wiz-ask'), null, '关掉开关 → 卡撤掉');
        await toggleAutomation(true);
        ok(await untilEl(() => H.maybe<HTMLElement>(document.body, '.kbw-wiz-ask')), '★ 再拨开 → 卡重新清点');
      } finally {
        await closeEverything();
        await ctx().gate.set('automation', gateBefore);
        await rmFix(path.join(vaultRoot, abs));
      }
    });

    await suite.it('N=0 的形态：库里都是齐的 → 卡写明"都齐了"（不画"0 篇"的假动作）', async () => {
      const emptyKb = '09_p717空库';
      const absEmpty = path.join(vaultRoot, emptyKb);
      try {
        fs.mkdirSync(absEmpty, { recursive: true });
        app.vault.rescan();
        await app.metadataCache.settle();
        await ctx().settings.save({ kbRoot: emptyKb });
        await H.settle(200);
        ctx().index.rebuild();
        await H.settle(150);
        ctx().openWizard();
        await H.settle(150);
        await advanceWizard(2);
        await toggleAutomation(true);
        const card = await untilEl(() => H.maybe<HTMLElement>(document.body, '.kbw-wiz-ask'));
        ok(card, '卡出现了（先出卡、再报数）');
        ok(
          await H.until(() => H.textOf(H.maybe(document.body, '.kbw-wiz-ask')).includes('都'), 4000, 50),
          '扫描完成',
        );
        contains(H.textOf(H.maybe(document.body, '.kbw-wiz-ask')), '齐了', '★ N=0 → 写明"都齐了"');
      } finally {
        await closeEverything();
        await ctx().gate.set('automation', gateBefore);
        await ensureKbRootDefault();
        fs.rmSync(absEmpty, { force: true, recursive: true });
        app.vault.rescan();
        await app.metadataCache.settle();
        ctx().index.rebuild();
        await H.settle(150);
      }
    });

    await suite.it('设置 → 自动化：动态提示「当前 N 篇可补」与现算同数', async () => {
      const kb = await ensureKbRootDefault();
      const rel = '00_Inbox/__p717提示.md';
      const abs = `${kb}/${rel}`;
      try {
        await writeRaw(rel, '---\ntags: []\n---\n\n提示正文。\n');
        ctx().openWorkbenchSettings('automation');
        await H.settle(250);
        const line = await untilEl(
          () =>
            H.qa<HTMLElement>(document.body, '.kbw-set-status').find((el) =>
              H.textOf(el).includes('篇可补'),
            ),
          5000,
        );
        ok(line, '★ 存量笔记组旁出现动态提示');
        const n = planTodoCount(await planBackfillOf(ctx()));
        ok(n > 0, `前提：有要改的（N=${n}）`);
        contains(H.textOf(line!), `当前 ${n} 篇可补`, '★ 与向导卡/面板同一个数');
      } finally {
        await closeEverything();
        await rmFix(path.join(vaultRoot, abs));
      }
    });
  });
}
