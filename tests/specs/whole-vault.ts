/**
 * spec：**P7.14 · 「整个库」模式（kbRoot=''）** —— 交互规格 §14 / 方案设计 §3
 *
 * 两块：
 *  ① **语义（纯函数）**：`normalizeSettings` 显式收 `''`（此前被尾部"假值兜底"顶回默认，
 *     是全项目唯一一个"空串存不进"的入口闸）；`inKbScope` 四态；`shouldShowWizard`
 *     把 `''` 当"配过"（整个库是用户显式选出来的）。
 *  ② **行为（自己的库）**：落盘 `''` → save→load 回读仍是 `''` · metaRoot 族无前导斜杠 ·
 *     索引 = 全库篇数 · walkPool 排除元数据目录 · `findMocLink('')` 找得到 · kbDirs /
 *     underKbRoot / rebuildNotesOf 全链正常 · 重开一个实例回读仍是 `''`。
 *
 * 为什么值得单独一组：空串根会把一族"手拼前缀"判据静默打坏（`` `${kbRoot}/` `` → `/x`；
 * `startsWith(`${kbRoot}/`)` → 恒 false）—— 那族站点逐处修完，这里钉**行为面**的回归；
 * 静态面由 `tests/specs/redline.ts` 的「禁手拼 `${…kbRoot…}/`」那条盯着。
 *
 * ⚠️ 夹具库顶层只有 `01_新知识库` 一个真目录（点开头目录本来就进不了索引/列表）——
 * "整个库"的篇数因此按 `H.listFiles` **现算**（不拍数字）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TFile } from 'obsidian';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { DEFAULT_SETTINGS, normalizeSettings, shouldShowWizard } from '../../src/core/settings';
import { inKbScope } from '../../src/core/paths';
import { findMocLink, mergeTemplateYaml, type NoteContext } from '../../src/services/templates';
import { rebuildNotesOf } from '../../src/services/rebuild';
import { planMoveBackToDeclared } from '../../src/services/reconcile';
import { declaredPositions, normalizeDeclaredPos } from '../../src/services/schema';
import { kbDirs } from '../../src/ui/new-note';
import { computeTodoItems } from '../../src/modules/home/todo-actions';
import { underKbRoot } from '../../src/ui/editor-menu';
import { walkPool } from '../../src/modules/home/blocks/walk';
import type { NoteEntry } from '../../src/core/vault-index';

/**
 * 造一个 `NoteEntry`（纯函数层用，不碰库）—— 与 `specs/automation.ts` 同一形状。
 * `dirRel` = 实际所在目录（相对库根；`''` = 库根顶层，与 `effectivePosition` 同口径）。
 */
function pureCtx(folderRel: string, kbRoot: string): NoteContext {
  return {
    title: '新篇',
    date: '2026-10-08',
    folderRel,
    kbRoot,
    center: '',
    moc: '',
  };
}

function pureEntry(pathStr: string, props: Record<string, unknown>, dirRel: string): NoteEntry {
  const basename = (pathStr.split('/').pop() ?? '').replace(/\.md$/, '');
  return {
    file: { path: pathStr, basename } as TFile,
    props,
    flags: [],
    effectivePosition: dirRel,
    path: pathStr,
    basename,
    isTemplate: false,
    mtime: 0,
    size: 10,
  };
}

export async function specWholeVault(suite: Suite): Promise<void> {
  await suite.group('P7.14 · 整个库（kbRoot 空串）· 语义（纯函数）', async () => {
    await suite.it('normalizeSettings 显式收空串（突变点：尾部 `!out.kbRoot` 假值兜底）', () => {
      eq(normalizeSettings({ kbRoot: '' }).kbRoot, '', '空串必须原样保留（= 整个库）');
      eq(normalizeSettings({}).kbRoot, DEFAULT_SETTINGS.kbRoot, '键不在 → 兜底默认（行为不变）');
      eq(normalizeSettings({ kbRoot: 123 }).kbRoot, DEFAULT_SETTINGS.kbRoot, '类型不对 → 兜底默认');
      eq(normalizeSettings({ kbRoot: '/01_新知识库/' }).kbRoot, '01_新知识库', 'normPath 归一');
      eq(
        normalizeSettings({ metaDir: '' }).metaDir,
        DEFAULT_SETTINGS.metaDir,
        '对照：metaDir 空串仍顶默认（它没有"整个库"语义）',
      );
    });

    await suite.it('空串不算「没配过」：shouldShowWizard 三态', () => {
      eq(
        shouldShowWizard({ wizardDone: null, kbRoot: '', metaDir: DEFAULT_SETTINGS.metaDir }),
        false,
        '选过「整个库」= 配过，不许再弹',
      );
      eq(
        shouldShowWizard({ wizardDone: true, kbRoot: '', metaDir: DEFAULT_SETTINGS.metaDir }),
        false,
        'true 不弹（照旧）',
      );
      eq(
        shouldShowWizard({
          wizardDone: null,
          kbRoot: DEFAULT_SETTINGS.kbRoot,
          metaDir: DEFAULT_SETTINGS.metaDir,
        }),
        true,
        '真·没配过 → 弹（对照）',
      );
    });

    await suite.it('inKbScope 四态（唯一范围谓词；整个库 = 全库除点开头）', () => {
      ok(inKbScope('00_Inbox/x.md', ''), '空串根：库顶层的笔记在范围内');
      ok(inKbScope('任意/深层/x.md', ''), '空串根：任意深层也在');
      ok(!inKbScope('.obsidian/x.md', ''), '空串根：点开头段不算');
      ok(!inKbScope('.foo/x.md', '01_新知识库'), '非空根：点开头段也不算');
      ok(inKbScope('01_新知识库/x.md', '01_新知识库'), '非空根：根下的算');
      ok(!inKbScope('01_新知识库-备份/x.md', '01_新知识库'), '非空根：前缀撞名的不许算（-备份 那条老账）');
    });
  });

  await suite.group('P7.14 · 整个库 · 行为（自己的库）', async () => {
    const vault = H.makeTempVault('whole-vault');
    const { app, plugin } = await H.bootPlugin(vault);
    const ctx = () => plugin.context();

    /** 全库 .md 数（除点开头段）——「整个库」的表征数，现算 */
    const allNotes = (): number =>
      H.listFiles(vault, '').filter(
        (p) => p.endsWith('.md') && !p.split('/').some((s) => s.startsWith('.')),
      ).length;

    /**
     * **子集自足**（`KBW_TEST_ONLY` 会把"把 kbRoot 拨成 ''"的第一条过滤掉，而 group 顶层照跑）：
     * 依赖 `kbRoot=''` 的用例自己在开头确保一下 —— 不然子集单跑时根还是默认的
     * `01_新知识库`，判据会指着"它的子目录"说事（实测踩过）。
     */
    const ensureWhole = async (): Promise<void> => {
      if (ctx().settings.kbRoot() !== '') {
        await ctx().settings.save({ kbRoot: '' });
        await H.settle(120);
      }
    };

    await suite.it("落盘 '' → 回读仍是 ''（save 也走 normalize —— 前面那个入口闸的接线）", async () => {
      const before = ctx().index.size();
      ok(before > 0, `前提：默认范围非空（${before} 篇）`);
      await ctx().settings.save({ kbRoot: '' });
      eq(ctx().settings.kbRoot(), '', '内存里是空串');
      const raw = JSON.parse(
        await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json'),
      ) as { kbRoot?: unknown };
      eq(raw.kbRoot, '', 'data.json 里真的写的是空串（不是默认值）');
      await H.settle(120); // 索引重建归 main.ts 的 onChange（rootKey 变了）
      eq(ctx().index.size(), allNotes(), `索引 = 全库篇数（${allNotes()}）`);
    });

    await suite.it('metaRoot 族无前导斜杠（曾经拼出 `/99_Meta` 那种形状）', async () => {
      await ensureWhole();
      eq(ctx().settings.metaRoot(), '99_Meta', 'metaRoot 走 joinPath 了');
      eq(ctx().settings.workbenchDir(), '99_Meta/06_工作台', '配置目录派生正确');
      eq(ctx().settings.logDir(), '99_Meta/05_操作日志', '日志目录派生正确');
      eq(ctx().settings.templateDir(), '99_Meta/02_模板库/Templater', '模板目录派生正确');
      eq(
        ctx().settings.routeTablePath(),
        '99_Meta/02_模板库/标签-目录映射.json',
        '路由表派生正确',
      );
      // ⚠️ 不查"这个派生在库里指得到东西"：夹具库的元数据在 `01_新知识库/99_Meta`
      // 之下，整库模式指向的是"vault 顶层的 99_Meta"（那个在夹具里本来就不存在）——
      // 存在性断言要有人真配了顶层元数据才有意义，离线上只钉**形状**（无前导斜杠）。
    });

    await suite.it('walkPool 排除元数据目录（真机的雷：metaRoot 带前导斜杠 → 前缀恒不匹配）', async () => {
      /**
       * ⚠️ **这条必须在子目录模式（默认库根）下跑**（实测修正过一版）：
       * 夹具的元数据真身在 `01_新知识库/99_Meta`，而 `NoteEntry.path` 永远是 **vault 全路径**
       *（带 `01_新知识库/` 前缀）—— 在"整个库"模式下 `metaRoot()='99_Meta'` 是个**库里不存在
       * 的顶层目录**，前缀当然匹配不上任何东西，判据会退化成测空气（突变验红时抓到：M3 杀不动它）。
       * 真机的雷长在子目录模式：`metaRoot()` 若带前导斜杠（旧 `metaRoot()` 的 `/01...` 形状），
       * 前缀就与真实路径对不上 → 日志/模板进随机漫步。这里按那个形态钉。
       */
      if (ctx().settings.kbRoot() !== DEFAULT_SETTINGS.kbRoot) {
        await ctx().settings.save({ kbRoot: DEFAULT_SETTINGS.kbRoot });
        await H.settle(120);
      }
      const metaPrefixAbs = `${ctx().settings.metaRoot()}/`; // '01_新知识库/99_Meta/'
      const pool = walkPool(ctx());
      ok(pool.length > 0, '有可漫步的（不然这条测的是空气）');
      ok(
        !pool.some((e) => e.path.startsWith(metaPrefixAbs)),
        `元数据目录下的（日志/模板/地图）一个都不在池里（前缀 ${metaPrefixAbs}）`,
      );
      // 第二道：拿路径段再兜一次（防"前缀口径又漂"时静默放行）
      ok(!pool.some((e) => e.path.includes('/99_Meta/')), '……按「/99_Meta/」路径段复查也没有');
    });

    await suite.it("findMocLink('')：全库找 MOC（此前前缀过滤恒空 → {{moc}} 那行消失）", () => {
      const link = findMocLink(app as never, '');
      ok(link.includes('MOC_'), `找得到知识地图：${link}`);
    });

    await suite.it('落点候选 / 右键菜单 / 重排输入集 全链正常', async () => {
      await ensureWhole();
      const dirs = kbDirs(ctx());
      contains(dirs.join('|'), '01_新知识库', 'kbDirs 列出库顶层目录');
      ok(dirs.includes('01_新知识库/00_Inbox'), '子目录也在');
      eq(dirs[0], '', '第一项仍是"库根"（= 整个库）');

      ok(
        underKbRoot('01_新知识库/00_Inbox/x.md', ''),
        '空串根：编辑器右键菜单在（此前 if(!root) return false 会整族消失）',
      );
      ok(!underKbRoot('.obsidian/x.md', ''), '点开头仍不给菜单');

      const notes = ctx().index.notes();
      const input = rebuildNotesOf(notes, '');
      eq(input.length, notes.length, '重排输入集 = 全量（此前手拼前缀恒 false → 整片空）');
      ok(
        input.every((n) => !n.dir.startsWith('/')),
        '相对口径（没有 `/` 前导）',
      );
    });

    await suite.it('网格/详细档根层画得出库顶层文件夹（parentDir 口径；`f.parent?.path` 两边都恒假那条已修）', async () => {
      await ensureWhole();
      H.resetDom();
      await plugin.activate();
      await H.settle(150);
      ctx().goNotes();
      await H.settle(250);
      /**
       * 默认档是「详细信息」（夹具 seed 显式选过）→ 根层的文件夹走**文件夹行**（`.kbw-frow`，
       * P7.1b）—— 与网格的 `.kbw-gcell.is-folder` 同源（都吃 `foldersFor`），取哪个都行。
       */
      const rows = H.qa<HTMLElement>(document.body, '.kbw-frow');
      ok(rows.length > 0, `根层要画文件夹行，实际 ${rows.length} 行`);
      contains(rows.map((f) => H.textOf(f)).join('|'), '01_新知识库', '……其中就有夹具的顶层目录');
    });

    await suite.it('库根顶层新建 → YAML 有「类型: 笔记」（P7.14 顶层兜底）· 文件位置写 `.`（P7.15 · #1 口径反转）· 不写状态', async () => {
      await ensureWhole();
      await ctx().completion.createNote({ title: '__p714根层新建', dirRel: '', noTemplate: true });
      await H.settle(120);
      const abs = path.join(vault, '__p714根层新建.md');
      ok(fs.existsSync(abs), '新建落到库根顶层了');
      const text = fs.readFileSync(abs, 'utf8');
      contains(text, '类型: 笔记', '类型默认「笔记」（全值域兜底）；此前顶层什么都不写');
      ok(!text.includes('状态:'), '顶层不写状态（与 00_Inbox 同理：还没归类）');
      /**
       * 🔴 **口径反转（P7.15 · #1，用户 2026-10-08）**：原判据是"顶层不写文件位置
       * （无从表达）"—— 用户否了："要求保留此条属性，文件位置就写他目前的文件路径"。
       * 现在写 `.`（`ROOT_POS` 根标记）；读侧由 `normalizeDeclaredPos` 映射回空串，
       * 所以声明 == 实际、不报「位置不一致」。
       */
      contains(text, '文件位置:', '顶层也写「文件位置」这一条（#1 反转）');
      contains(text, '  - .', '……值 = `.`（库根标记）');
      contains(text, 'tags: []', 'tags 照写');
      // 收尾（安全删法：settle 滞后解析定时器，裸 rmSync 会把测试进程干掉）
      fs.rmSync(abs, { force: true });
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(120);
    });

    await suite.it('把 99_Meta 整个删掉：插件照常工作，配置下次用到时以默认值重建（用户问过的那件事）', async () => {
      await ensureWhole();
      // 前提：先让库配置目录物化一次（打开看板那类动作会 ensure —— 这里直接调同一个口）
      await ctx().configs.ensure('board');
      const metaAbs = path.join(vault, '99_Meta');
      ok(fs.existsSync(path.join(metaAbs, '06_工作台', '看板配置.json')), '前提：库配置目录已物化');

      fs.rmSync(metaAbs, { recursive: true, force: true }); // 整棵删掉（等价"用户手删"）
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(120);

      // ① 索引与待处理照常算（不炸、不空）
      eq(ctx().index.size(), allNotes(), '索引照常 = 全库篇数（没有 99_Meta 也活）');
      const items = await computeTodoItems(ctx());
      ok(Array.isArray(items), '待处理清单算得出来');

      // ② 配置读 → 默认值（不落盘）；下次用到（ensure）→ 以默认值自动重建
      eq(await ctx().configs.exists('board'), false, '删掉后 exists = false');
      const defaults = await ctx().configs.read<{ version: number }>('board');
      eq(defaults.version, 1, '读回默认值（读不落盘）');
      await ctx().configs.ensure('board');
      ok(
        fs.existsSync(path.join(metaAbs, '06_工作台', '看板配置.json')),
        '再次用到时以默认值自动重建',
      );
    });

    await suite.it("负向：'' 不许被当「没配」—— 重开一个实例回读", async () => {
      /**
       * ⚠️ 重开实例必须走 `rawData` **原样回写当前盘上那份** —— `bootPlugin` 默认会把
       * `data.json` 重新 seed 成 'done' 形态（那份里没有 kbRoot），拿它测"读盘保留 ''
       * 还是回落默认"测的就是 seed，不是产品。
       */
      const saved = JSON.parse(
        await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json'),
      ) as Record<string, unknown>;
      await H.shutdown(plugin);
      const b2 = await H.bootPlugin(vault, { rawData: saved });
      eq(b2.plugin.context().settings.kbRoot(), '', '新实例读盘：还是空串（整个库）');
      eq(b2.plugin.context().index.size(), allNotes(), '新实例索引也按全库建');
      await H.shutdown(b2.plugin);
    });

    /**
     * ── P7.15 · #1：库根顶层的「文件位置」= `.`（根标记）────────────────
     *
     * 用户 2026-10-08 推翻了 P7.14 的"顶层无从表达 → 不写"口径："要求保留此条属性，
     * 文件位置就写他目前的文件路径"。表示法 `ROOT_POS = '.'`：**写**在新建路落 `.`，
     * **读**侧 `normalizeDeclaredPos` 统一映射回空串（= `effectivePosition` 的库根口径）。
     *
     * 这一组的价值全在"读侧归一"上 —— 只写 `.` 不归一的话，「位置不一致」体检、
     * 缺声明候选、搬回声明处会**同时**坏掉（顶层新建的每一篇都变成错位/缺声明）。
     *
     * ⚠️ 本组跟着 P7.14 组跑用的是**同一个夹具实例**（`kbRoot` 被那组拨成了 `''`），
     * 正好就是「整个库」模式 —— 而它正是用户报这个问题的场景（整个库 / 空库时顶层新建）。
     */
    await suite.group('P7.15 · #1：库根顶层写「.」——写侧落标记 · 读侧归一', async () => {
    await suite.it('normalizeDeclaredPos：`.` → 空串；其余照旧（剥两侧斜杠）', () => {
      eq(normalizeDeclaredPos('.'), '', '根标记 → 空串（与实际位置口径对齐）');
      eq(normalizeDeclaredPos('00_Inbox'), '00_Inbox', '普通目录原样');
      eq(normalizeDeclaredPos('/02_Areas/'), '02_Areas', '两侧斜杠照旧剥掉');
      eq(normalizeDeclaredPos(''), '', '空串还是空串');
      eq(
        declaredPositions({ 文件位置: ['.'] })[0],
        '',
        'declaredPositions 是唯一读门：`. ` 出口就是空串',
      );
      eq(
        declaredPositions({ 文件位置: ['02_Areas', '/03_Resources/'] }).join('|'),
        '02_Areas|03_Resources',
        '列表逐项归一',
      );
    });

    await suite.it('纯函数闭环：顶层声明 `.` 的笔记 —— 不算错位、不进「搬回声明处」的搬动表', () => {
      const e = pureEntry('__p715顶层.md', { 文件位置: ['.'] }, '');
      const plan = planMoveBackToDeclared([e], {
        kbRoot: '',
        exclude: [],
        dirs: new Set(['', '00_Inbox']),
      });
      eq(plan.moves.length, 0, '声明 == 实际（都在库根）→ 一个搬动都不该有');
      eq(plan.missing.length, 0, '也不该被当成"目标目录不存在"');
      eq(plan.skips.length, 0, '更不该进跳过表');
      /**
       * 对照：真错位的（声明 00_Inbox、实际在根）照旧要进搬动表 ——
       * 证明上面那个"0"不是因为 `planMoveBackToDeclared` 整个失灵。
       */
      const e2 = pureEntry('__p715错位.md', { 文件位置: ['00_Inbox'] }, '');
      const plan2 = planMoveBackToDeclared([e2], {
        kbRoot: '',
        exclude: [],
        dirs: new Set(['', '00_Inbox']),
      });
      eq(plan2.moves.length, 1, '对照：真错位的一篇必须进搬动表');
      eq(plan2.moves[0].declared, '00_Inbox', '……目标是声明的那个目录');
    });

    await suite.it('真机路（自己的库）：`建在库根 → 声明 `.` → 索引不报错位 → 读回还是 `.`', async () => {
      await ensureWhole();
      await ctx().completion.createNote({ title: '__p715根层声明', dirRel: '', noTemplate: true });
      await H.settle(150);
      const abs = path.join(vault, '__p715根层声明.md');
      ok(fs.existsSync(abs), '新建落到了夹具库的顶层');
      const text = fs.readFileSync(abs, 'utf8');
      contains(text, '  - .', 'YAML 落的是根标记 `.`');

      /**
       * ⚠️ **写盘之后属性读回要显式让平台走完两段延时**（P-1 S3 的老账，本轮又踩一次）：
       *   ① `metadataCache` 有 ~300ms 滞后重解析（桩照实模拟，`settle()` 是测试口子）；
       *   ② 索引的属性刷新挂 `changed` 事件 + 自己的 120ms 防抖（`flush`）——
       *      `settle()` 之后**还得再等一拍**，否则读到的还是"事件前"那份空 props
       *      （本轮实测：cache 里 frontmatter 已经对了、索引条目还是 `{}`）。
       * 两步都走完，读回才与真机一致。
       */
      app.vault.rescan();
      await app.metadataCache.settle();
      await H.settle(200);
      const e = ctx().index.get('__p715根层声明.md');
      ok(e != null, '索引里找得到这一篇');
      eq(e?.effectivePosition, '', '实际位置 = 库根（空串口径）');
      eq(declaredPositions(e?.props ?? {})[0], '', '声明读回来 = 空串（`. ` 被归一）');
      ok(
        !e?.flags.includes('position-mismatch'),
        '★ 不该报「位置不一致」（写 `.`、读不归一的话这里必红 —— 本组的主判据）',
      );

      // 收尾：安全删法（settle 滞后解析定时器；裸 rmSync 会把测试进程干掉）
      fs.rmSync(abs, { force: true });
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(120);
    });

    await suite.it('依模板新建（套用补齐路）：合并前言也写 `.`（不是模板自己那个错声明）', () => {
      /**
       * 纯函数层验 `mergeTemplateYaml` —— 模板静态前言里写着模板库的位置
       * （用户真机截图那条：`文件位置: 99_Meta/02_模板库/Templater`），
       * 新建路必须把它换成**实际落点**；落点是库根时 = `.`（与 `buildYaml` 同口径）。
       */
      const tpl = [
        '---',
        '类型: 模板',
        '文件位置:',
        '  - 99_Meta/02_模板库',
        'tags: []',
        '---',
        '',
        '# {{title}}',
        '',
      ].join('\n');
      const out = mergeTemplateYaml(tpl, {
        ctx: pureCtx('', ''),
        templateText: null,
        templatePath: '',
        withPosition: true,
      });
      contains(out, '  - .', '库根新建：模板带来的错值被换成根标记 `.`');
      ok(!out.includes('99_Meta/02_模板库'), '模板自己那个位置不许漏进产物（#4 的那条）');
      /**
       * 对照（非顶层）：子目录里依模板新建 → 值 = 那个子目录（不是 `.`）。
       */
      const out2 = mergeTemplateYaml(tpl, {
        ctx: pureCtx('02_Areas', '01_新知识库'),
        templateText: null,
        templatePath: '',
        withPosition: true,
      });
      contains(out2, '  - 02_Areas', '对照：非顶层写的是那个目录本身');
      /**
       * 对照（存量路）：`withPosition` 不带 → 整键删掉（P7.13a 口径不动）。
       */
      const out3 = mergeTemplateYaml(tpl, {
        ctx: pureCtx('', '01_新知识库'),
        templateText: null,
        templatePath: '',
      });
      ok(!out3.includes('文件位置'), '对照：存量补全路照旧把「文件位置」整键删掉（不写 `.`）');
    });

    await suite.it('「缺「文件位置」声明」的候选判据：顶层写了 `.` 的不算缺（AI/整理建议同门）', () => {
      /**
       * AI 补属性（`proposeLocus`）与整理建议的候选口径是
       * `declaredPositions(e.props).length === 0` —— 读门归一之后，写了 `.` 的顶层笔记
       * 声明数 = 1（不是 0），于是**不再**落进"缺声明"候选。这一条把这个承诺钉死：
       * 只写不归一的话，顶层新建的每一篇都会一直挂在"缺文件位置"清单里。
       */
      eq(declaredPositions({ 文件位置: ['.'] }).length, 1, '声明了根 ≠ 没声明');
      eq(declaredPositions({ 文件位置: [] }).length, 0, '对照：真没声明（空列表）才是 0');
      eq(declaredPositions({}).length, 0, '对照：键都没有也是 0');
    });
    });
  });
}
