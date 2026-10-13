/**
 * spec：**P7.2b 库框架轮**（16.1 库框架初始化 + 16.2 示例数据）
 *
 * 四件的判据（开工提示词 §2 的次序）：
 *  ① **骨架预设**：两档清单（基础 9 / 完整 21+7）· 对表显示 · 覆写（本组）
 *  ② **初始化模式**：空库建框架 · 种子页进快照可还原（extraFiles / newFiles 链）
 *  ③ **收拢**：全部文件按原相对路径进归集夹 · 补声明 · 撞名跳过 · 可还原 · 复跑重排 0 搬动
 *  ④ **示例数据**：建 / 清（`__示例` 前缀 + 看板板块）
 *
 * ⚠️ 用自己的库（`makeTempVault('kbfw')`）：收拢会**搬走整库文件**、初始化要**空库** ——
 * 都只在 temp 里造，不碰任何共享夹具。每条用例自己收场（配置写回 / 面板关掉）。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { BASIC_PRESET, seedContentOf, skeletonPresets } from '../../src/core/config-files';
import { relativeTo } from '../../src/core/paths';
import { stamp } from '../../src/core/util';
import { NOTE_TYPES, STATUSES } from '../../src/services/schema';
import { SAMPLE_SECTION_ID, sampleNotes } from '../../src/services/library-samples';
import {
  collectDirOf,
  normalizeSkeleton,
  planCollect,
  presetOfSkeleton,
  vaultShapeOf,
  withPreset,
} from '../../src/services/rebuild';
import { openRebuildPanel } from '../../src/ui/rebuild-panel';
import type { PanelHandle } from '../../src/ui/panel';

const KB = '01_新知识库';

export async function specFramework(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  // ════════════════════════════════════════════════════════════
  // ① 骨架预设（G3-①：基础版 9 目录 / 完整版 21+7 / 手改 = 自定义）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 骨架预设（纯函数）', async () => {
    await suite.it('normalizeSkeleton：preset 只认三档；没写 / 写了别的 → custom', () => {
      eq(normalizeSkeleton({ dirs: [] }).preset, 'custom', '没写 → custom');
      eq(normalizeSkeleton({ dirs: [], preset: 'basic' }).preset, 'basic', 'basic 保留');
      eq(normalizeSkeleton({ dirs: [], preset: 'full' }).preset, 'full', 'full 保留');
      eq(normalizeSkeleton({ dirs: [], preset: '定制' }).preset, 'custom', '怪值 → custom');
      eq(normalizeSkeleton({ dirs: [], preset: 42 }).preset, 'custom', '非字符串 → custom');
    });

    await suite.it('presetOfSkeleton 对表：完全一致才认那一档（顺序无关；多 / 少一条 → custom）', () => {
      const P = skeletonPresets();
      eq(presetOfSkeleton(normalizeSkeleton({ dirs: P.basic.dirs, seedFiles: P.basic.seedFiles })), 'basic', '基础版清单 → basic');
      eq(presetOfSkeleton(normalizeSkeleton({ dirs: P.full.dirs, seedFiles: P.full.seedFiles })), 'full', '完整版清单 → full');
      // 顺序无关（normalize 会排序；这里直接拿乱序喂，防"排序恰好对齐"的假绿）
      eq(
        presetOfSkeleton(normalizeSkeleton({ dirs: [...P.basic.dirs].reverse(), seedFiles: P.basic.seedFiles })),
        'basic',
        '顺序无关',
      );
      eq(
        presetOfSkeleton(normalizeSkeleton({ dirs: [...P.basic.dirs, '90_我的额外目录'], seedFiles: P.basic.seedFiles })),
        'custom',
        '多一条 → custom（手改过）',
      );
      eq(
        presetOfSkeleton(normalizeSkeleton({ dirs: P.basic.dirs.slice(1), seedFiles: P.basic.seedFiles })),
        'custom',
        '少一条 → custom',
      );
      eq(
        presetOfSkeleton(normalizeSkeleton({ dirs: P.full.dirs, seedFiles: [] })),
        'custom',
        '目录像 full、种子页不同 → custom',
      );
      // ⚠️ 显示口径的唯一出处：**标记撒谎也认对表**（手改过的文件标着 full，照样算 custom）
      eq(
        presetOfSkeleton(normalizeSkeleton({ dirs: [...P.basic.dirs, '90_x'], seedFiles: [], preset: 'full' })),
        'custom',
        '标记写 full 但清单被手改 → 对表照旧 custom',
      );
    });

    await suite.it('withPreset：覆写 dirs/seedFiles + 写标记；rootName / excludedTop / keepTop / version 保留', () => {
      const P = skeletonPresets();
      eq(BASIC_PRESET.dirs.length, 9, '基础版是 9 个目录（G3-① 拍板）');
      eq(BASIC_PRESET.seedFiles.length, 0, '基础版 0 种子页');
      eq(P.full.dirs.length, 21, '完整版 21 个目录');
      eq(P.full.seedFiles.length, 7, '完整版 7 个种子页');
      // 完整版清单就是从骨架默认派生的那一份（唯一真源：谁也不许抄第二份）
      eq(presetOfSkeleton(normalizeSkeleton(P.full)), 'full', '完整版清单 = 默认骨架（对得上表）');

      const sk = normalizeSkeleton({
        dirs: P.full.dirs,
        seedFiles: P.full.seedFiles,
        rootName: '我的库',
        excludedTop: ['.obsidian', '02_旧知识库', '90_不碰'],
        keepTop: ['02_Areas/游戏研究'],
        version: 3,
      });
      const down = withPreset(sk, 'basic');
      eq(down.preset, 'basic', '标记写成 basic');
      eq(down.dirs.length, 9, '清单覆写成基础版');
      eq(down.seedFiles.length, 0, '种子页清单也覆写（基础版 0）');
      eq(down.rootName, '我的库', 'rootName 保留（它是这台库的名，不是清单的一部分）');
      eq(down.excludedTop.includes('90_不碰'), true, 'excludedTop 保留');
      eq(down.keepTop.join(','), '02_Areas/游戏研究', 'keepTop 保留');
      eq(down.version, 3, '版本号保留');
      // 升档：basic → full 只加不删（对表回 full）
      const up = withPreset(down, 'full');
      eq(presetOfSkeleton(up), 'full', '升档后对表回 full');
      eq(up.dirs.length, 21, '完整版 21 目录');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 面板：预设下拉（真链路；G3-③ 的入口之一）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 重排面板：预设下拉', async () => {
    let panel: PanelHandle | null = null;
    let raw0: unknown = null;

    await suite.it('下拉显示对表档；切档 → 确认流 → 覆写清单 → 预览重算（树头计数跟着变）', async () => {
      raw0 = await ctx().configs.read('rebuild');
      panel = openRebuildPanel(ctx());
      await H.settle(140);
      ok(
        await H.until(() => H.maybe(document.body, '.kbw-rb-preset') != null, 2000),
        '树头有预设下拉（.kbw-rb-preset）',
      );
      const selEl = H.maybe<HTMLSelectElement>(document.body, '.kbw-rb-preset') as HTMLSelectElement;
      const cur = presetOfSkeleton(normalizeSkeleton(raw0));
      eq(selEl.value, cur, `下拉值 = 对表算出的当前档（实际 ${selEl.value}）`);

      // 切到另一档（本来就是 basic 就切 full —— 目标是"真的切一次并覆写"）
      const target: 'basic' | 'full' = cur === 'basic' ? 'full' : 'basic';
      selEl.value = target;
      selEl.dispatchEvent(new Event('change'));
      await H.settle(90);
      const modal = lastModal();
      contains(H.textOf(modal), '覆写成', '弹了覆写确认流');
      const primary = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) => H.textOf(b).startsWith('覆写成'));
      ok(primary, '确认流主按钮写着覆写动作');
      H.click(primary as Element);
      await H.settle(160);

      // 配置真写了（磁盘回读）—— 不是只改了内存
      const after = normalizeSkeleton(await ctx().configs.read('rebuild'));
      eq(after.preset, target, `库结构.json 的 preset 标记 = ${target}`);
      eq(presetOfSkeleton(after), target, `覆写后对表 = ${target}`);
      const P = skeletonPresets()[target];
      eq(after.dirs.length, P.dirs.length, `目录数 = ${P.dirs.length}`);
      const dirSet = new Set(P.dirs);
      ok(after.dirs.every((d) => dirSet.has(d)), '每一条都是该档清单里的（没有多抄）');
      eq(after.seedFiles.length, P.seedFiles.length, `种子页数 = ${P.seedFiles.length}`);

      // 预览重算：树头计数与下拉都跟上
      const ok1 = await H.until(() => {
        const s = H.maybe<HTMLSelectElement>(document.body, '.kbw-rb-preset');
        const cnt = H.maybe<HTMLElement>(document.body, '.kbw-rb-count');
        return !!s && s.value === target && !!cnt && H.textOf(cnt).startsWith(`${P.dirs.length} 个目录`);
      }, 3000);
      ok(ok1, '预览已重算：下拉回显新档、树头计数跟着变（不是停在旧骨架）');
    });

    await suite.it('选「自定义」= 没有清单可覆写：拨回原档 + 一句说明（不弹确认流）', async () => {
      const sel = H.maybe<HTMLSelectElement>(document.body, '.kbw-rb-preset') as HTMLSelectElement;
      ok(!!sel, '前提：面板还开着');
      const before = sel.value;
      /**
       * ⚠️ 判"没弹确认流"要数**模态增量**：重排面板自己就是一枚 `.kbw-modal`
       * （第一版写"模态数 == 0"当场假红 —— 把面板本身数进去了）。
       */
      const modalsBefore = H.qa<HTMLElement>(document.body, '.kbw-modal').length;
      sel.value = 'custom';
      sel.dispatchEvent(new Event('change'));
      await H.settle(90);
      eq(sel.value, before, '拨回原档（自定义不是可切的目标）');
      const txt = H.textOf(document.body);
      contains(txt, '自定义', '给了一句说明（别留"点了没反应"）');
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-modal').length,
        modalsBefore,
        '没有弹确认流（模态数没变）',
      );
    });

    await suite.it('收场：面板关掉 + 库结构.json 还原到开测前', async () => {
      panel?.close('test');
      await H.settle(60);
      /**
       * 还原成"开测前那份"：开测前**没有**这份文件时写回默认值（语义等价 ——
       * `ensure()` 本来就是"没有就落默认"），别走"删文件"那条路：
       * 删除会让配置层的防抖重读撞上 ENOENT、在日志里刷一片假"解析失败"。
       */
      await ctx().configs.write('rebuild', raw0);
      await H.settle(80);
      const back = normalizeSkeleton(await ctx().configs.read('rebuild'));
      eq(
        JSON.stringify(back.dirs),
        JSON.stringify(normalizeSkeleton(raw0).dirs),
        '骨架目录清单回原样',
      );
      panel = null;
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 初始化模式（空库建框架）：extraFiles → 快照 newFiles → 可还原
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 初始化模式（空库建框架）', async () => {
    let panel: PanelHandle | null = null;
    let kb0 = '';
    /** 点执行前的库现状（还原断言按它派生 —— 跨两条用例） */
    let shape1: Awaited<ReturnType<typeof vaultShapeOf>> | null = null;
    const emptyKb = '__空库';
    const P = skeletonPresets();

    await suite.it('空库进来 = 初始化档：种子页默认开、收拢开关不画；执行 → 建骨架 + 7 种子页 → 幂等', async () => {
      kb0 = ctx().settings.kbRoot();
      // 库内另建一个空目录当 kbRoot（**面板 open 时捕获 kbRoot** —— 必须先切、再开）
      if (!(await app.vault.adapter.exists(emptyKb))) await app.vault.adapter.mkdir(emptyKb);
      await ctx().settings.save({ kbRoot: emptyKb });
      await H.settle(100);
      // 骨架 = 完整版预设（本组要验种子页创建）
      await ctx().configs.write('rebuild', {
        version: 1,
        rootName: emptyKb,
        dirs: [...P.full.dirs],
        seedFiles: [...P.full.seedFiles],
        excludedTop: ['.obsidian', '.trash', '.tooling', '02_旧知识库'],
        keepTop: [],
      });
      panel = openRebuildPanel(ctx());
      await H.settle(180);

      ok(
        H.maybe(document.body, '.kbw-rb-plan') != null,
        '有 ①「体检范围与标准」带（R7 三块式；输入仍在最上面）',
      );
      const reorg = radioRow('归拢重整');
      ok(reorg != null, '空库 = 初始化档：归拢重整**仍画出**（R7：不再是不画）');
      ok(reorg?.classList.contains('is-disabled') ?? false, '但置灰（空库没有可归拢的）');
      const seedsCb = checkBox('索引页');
      ok(seedsCb != null, '「索引页」勾选框在');
      eq(seedsCb?.checked, true, '默认勾着（初始化档）');
      /**
       * P7.11 · #14：种子页不再是一行摘要句（「将创建 7 个种子页」），而是
       * 「会做」档里**逐条**列出、行尾 why「执行时创建」。
       */
      const side0 = H.maybe<HTMLElement>(document.body, '.kbw-rb-side') as HTMLElement;
      contains(H.textOf(side0), '执行时创建', '右栏「会做」档逐条预告种子页会创建');
      contains(H.textOf(side0), '_收件箱.md', '七篇种子页在列（以 _收件箱.md 为例）');

      const runBtn = runButton();
      contains(H.textOf(runBtn), '开始初始化', `执行按钮换代（实际「${H.textOf(runBtn)}」）`);
      contains(H.textOf(runBtn), '个目录', '按钮写清建几个目录');
      /**
       * 点执行前量一次库现状 —— 还原断言按它派生（**别枚举哪些是配置层预建的**：
       * ensure 建了 `99_Meta/06_工作台`、预览报告又落了 `99_Meta/05_操作日志`，
       * 枚举法连着栽两次；"newDirs 之外的一律保留"才是与实现同源的口径）。
       */
      shape1 = await vaultShapeOf(app as never, emptyKb);
      H.click(runBtn);
      await H.settle(120);
      const modal = lastModal();
      contains(H.textOf(modal), '初始化', '确认流标题写「初始化库框架」');
      const primary = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) => H.textOf(b).startsWith('建这'));
      ok(
        primary != null && /建这 \d+ 个目录 \+ 7 个文件/.test(H.textOf(primary as Element)),
        `主按钮 = 建这 N 个目录 + 7 个文件（重复数量；实际「${H.textOf(primary as Element)}」）`,
      );
      H.click(primary as Element);

      ok(
        await H.until(() => H.exists(vaultRoot, `${emptyKb}/00_Inbox/_收件箱.md`), 8000),
        '种子页建出来了（_收件箱.md）',
      );
      for (const d of P.full.dirs) {
        if (!H.exists(vaultRoot, `${emptyKb}/${d}`)) {
          ok(false, `目录该建出来：${d}`);
          break;
        }
      }
      const seedText = H.readNote(vaultRoot, `${emptyKb}/00_Inbox/_收件箱.md`);
      contains(seedText, '类型: 索引', '种子页有前言（v2：中心页收拢为索引；不是空文件糊弄）');
      contains(seedText, '- 00_Inbox', '种子页的「文件位置」写着自家目录（复跑重排 0 搬动的底）');
      ok(
        H.exists(vaultRoot, `${emptyKb}/99_Meta/04_索引与地图/MOC_知识地图.md`),
        '99_Meta 里的种子也建了',
      );
      // 幂等：再预览 = 没有要做的
      ok(
        await H.until(() => H.textOf(runButton()) === '没有要做的', 8000),
        `初始化后再预览该「没有要做的」（实际「${H.textOf(runButton())}」）`,
      );
    });

    await suite.it('还原这次初始化：种子页删回、空目录收回（newFiles 进快照的兑现）', async () => {
      const list = await ctx().snapshot.list();
      ok(list.length > 0, '前提：执行落了快照');
      const r = await ctx().snapshot.restore(list[0].id);
      eq(r.filesRemoved, P.full.seedFiles.length, `删回 ${P.full.seedFiles.length} 个新建的种子页`);
      eq(H.exists(vaultRoot, `${emptyKb}/00_Inbox/_收件箱.md`), false, '种子页没了');
      eq(H.exists(vaultRoot, `${emptyKb}/99_Meta/04_索引与地图/MOC_知识地图.md`), false, '99_Meta 里的也没了');
      /**
       * 口径与实现同源，外加两条**明知且正当**的保留：
       *  · 执行前就存在的目录不进 `newDirs` → 还原不删（配置层 ensure 预建的）；
       *  · `99_Meta/05_操作日志` 是**执行完写日志**才出现的（快照照不到它，
       *    也不该删 —— 那是本次操作的记录；③ 也只会删**空**目录）。
       */
      const keepAnyway = new Set(['99_Meta', '99_Meta/05_操作日志', '99_Meta/06_工作台']);
      for (const d of P.full.dirs) {
        const keep = (shape1?.dirs.has(d) ?? false) || keepAnyway.has(d);
        eq(H.exists(vaultRoot, `${emptyKb}/${d}`), keep, `还原后目录状态：${d}（${keep ? '保留' : '已收回'}）`);
      }
      ok(H.exists(vaultRoot, `${emptyKb}/99_Meta/05_操作日志`), '操作日志目录留着（本次操作的记录）');
      /**
       * ⚠️ 唯一一条**已知且正当**的没做到：这次初始化把 `05_操作日志` 当骨架目录建了出来，
       * 紧接着执行日志写了进去 → 还原时目录里有东西，没删（如实报告、目录保留）。
       * 非空库上没有这一幕（那个目录本来就在，不进 newDirs）。除它以外必须零问题。
       */
      const unexpected = r.problems.filter((x) => !x.includes('05_操作日志'));
      eq(unexpected.length, 0, `除操作日志目录非空外的还原问题（实际：${unexpected.join('；')}）`);
      // 还原后预览：又能建了（可反复执行）——R7 动词三选一，认"有事可做"这一态
      //（⚠️ 还原之后的库**不是空库**了：操作日志那几篇 .md 还在 → 走「常规纠偏」分支，
      //  按钮是「开始纠偏 —— 建这 N 个目录」；写死"开始初始化"会被这一态打红）
      await H.settle(150);
      ok(
        await H.until(
          () => /^(开始纠偏|开始归拢|开始初始化)/.test(H.textOf(runButton())),
          8000,
        ),
        `还原之后预览回到「可以建」（可反复执行）—— 实际按钮「${H.textOf(runButton())}」`,
      );
    });

    await suite.it('收场：面板关掉 + kbRoot 切回', async () => {
      panel?.close('test');
      await H.settle(60);
      await ctx().settings.save({ kbRoot: kb0 });
      await H.settle(100);
      panel = null;
    });
  });

  // ════════════════════════════════════════════════════════════
  // ③ 收拢（旧笔记 → 归集夹）+ 与重排的互操作
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 收拢（旧笔记归集夹）', async () => {
    await suite.it('planCollect（纯函数）：三类排除齐全 · 附件照搬 · 归集夹层级进 newDirs', () => {
      /**
       * 面板流程会兜住口径的大部分，但**排除规则本身**（尤其"旧归集夹不再套娃"）
       * 只经面板路径是零直接判据（P7.2b 审查 🟢2）—— 这里直接喂纯函数。
       */
      const files = new Set([
        '00_Inbox/a.md',
        '02_Areas/深层/b.png', // 附件（非 .md）也要收
        '99_Meta/06_工作台/库结构.json', // 工具区 → 不收
        '02_旧知识库/old.md', // 排除名单 → 不收
        '04_Archives/旧笔记-20260101/y.md', // 既有归集夹 → 不收（防套娃）
        '04_Archives/_归档中心.md', // 04_Archives 直下的散文件 → 照收
      ]);
      const cp = planCollect({
        kbRoot: KB,
        files,
        metaDir: '99_Meta',
        excludedTop: ['02_旧知识库'],
        collectDir: '04_Archives/旧笔记-20260102',
      });
      const froms = cp.moves.map((m) => relativeTo(m.from, KB));
      ok(froms.includes('00_Inbox/a.md'), '普通笔记要收');
      ok(froms.includes('02_Areas/深层/b.png'), '附件也要收');
      ok(froms.includes('04_Archives/_归档中心.md'), '04_Archives 直下的散文件照收（只防"旧笔记-*"套娃）');
      ok(!froms.some((f) => f.startsWith('99_Meta/')), '工具区不收');
      ok(!froms.some((f) => f.startsWith('02_旧知识库/')), '排除名单不收');
      ok(!froms.some((f) => f.startsWith('04_Archives/旧笔记-')), '既有归集夹不收（防套娃）');
      eq(cp.skipped.length, 3, '跳过项如实记账（工具区 / 排除名单 / 旧归集夹）');
      const deep = cp.moves.find((m) => relativeTo(m.from, KB) === '02_Areas/深层/b.png');
      eq(deep?.dirRel, '04_Archives/旧笔记-20260102/02_Areas/深层', '目标目录保留原相对层级');
      ok(cp.newDirs.includes('04_Archives/旧笔记-20260102'), '归集夹在 newDirs 里');
      ok(
        cp.newDirs.includes('04_Archives/旧笔记-20260102/02_Areas/深层'),
        '深层层级也在 newDirs 里（还原删空目录靠它）',
      );
    });

    let panel: PanelHandle | null = null;
    let raw0: unknown = null;
    const aRel = `${KB}/00_Inbox/__收拢甲.md`;
    const bRel = `${KB}/00_Inbox/__收拢乙.bin`;
    const cRel = `${KB}/02_旧知识库/__收拢丙.md`;
    const today = stamp().slice(0, 8);
    const 归集 = `${KB}/${collectDirOf(today)}`;
    /** 夹具里老 `_收件箱.md` 的原内容（还原顺序缺陷的回归判据用） */
    let seed0 = '';

    await suite.it('收拢开关 → 计划换代；执行 →（.md 与附件）按原相对路径进归集夹 + 补声明 + 撤销条', async () => {
      raw0 = await ctx().configs.read('rebuild');
      const P = skeletonPresets();
      await ctx().configs.write('rebuild', {
        version: 1,
        rootName: KB,
        dirs: [...P.full.dirs],
        seedFiles: [...P.full.seedFiles],
        excludedTop: ['.obsidian', '.trash', '.tooling', '02_旧知识库'],
        keepTop: [],
      });
      // 夹具：一篇带声明的 .md + 一个附件 + 一篇在排除目录里的（丙不能被收拢）
      await ensureFile(plugin, app, aRel, ['---', '类型: 想法', '领域: 灵感杂记', '文件位置:', '  - 00_Inbox', '---', '', '# 甲', ''].join('\n'));
      await ensureFile(plugin, app, bRel, 'zz-附件-zz');
      await ensureFile(plugin, app, cRel, ['---', '类型: 想法', '领域: 灵感杂记', '---', '', '# 丙', ''].join('\n'));
      // 夹具里的老种子页（收拢会把它搬走、再在原位建新的 —— 还原时两者的次序最容易搞反）
      seed0 = H.readNote(vaultRoot, `${KB}/00_Inbox/_收件箱.md`);

      panel = openRebuildPanel(ctx());
      await H.settle(180);
      const reorg = radioRow('归拢重整');
      ok(reorg != null, '非空库：归拢重整单选画出来了');
      ok(reorg != null && !reorg.classList.contains('is-on'), '默认是「常规纠偏」（归拢重整没选）');
      H.click(reorg as Element);
      await H.settle(250);

      const runBtn = runButton();
      contains(H.textOf(runBtn), '开始归拢', `选归拢后执行按钮换代（实际「${H.textOf(runBtn)}」）`);
      contains(H.textOf(document.body), `旧笔记-${today}`, '动作说明里写明归集夹（含日期）');

      H.click(runBtn);
      await H.settle(120);
      const modal = lastModal();
      const mt = H.textOf(modal);
      contains(mt, '收拢', '确认流标题有「收拢」');
      contains(mt, '撞名', '确认流写明撞名 N（三个数之一）');
      contains(mt, '建', '确认流写明建 N 目录');
      const primary = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) => H.textOf(b).startsWith('收拢这'));
      ok(primary != null, '主按钮 = 「收拢这 N 篇」');
      H.click(primary as Element);

      ok(
        await H.until(() => H.exists(vaultRoot, `${归集}/00_Inbox/__收拢甲.md`), 10000),
        '甲按原相对路径进了归集夹',
      );
      ok(H.exists(vaultRoot, `${归集}/00_Inbox/__收拢乙.bin`), '乙（附件）也进了归集夹');
      /**
       * 🔴 **附件字节不许被碰**（P7.18b 独立审 🔴1 的回销）：mover 第 7 步现在对**搬过的**
       * 文件写「文件位置」——非 `.md` 必须拦住（`processFrontMatter` 对二进制文件 = 灾难：
       * 会把「YAML 头 + 乱码正文」写回去；Py 桩里此前就是这么"静默变坏"的，没人断言）。
       */
      eq(
        H.readNote(vaultRoot, `${归集}/00_Inbox/__收拢乙.bin`),
        'zz-附件-zz',
        '★ 附件内容逐字节不动（没被写前言）',
      );
      eq(H.exists(vaultRoot, aRel), false, '甲不在原位了（成对判）');
      eq(H.exists(vaultRoot, bRel), false, '乙不在原位了');
      ok(H.exists(vaultRoot, cRel), '丙在 02_旧知识库（排除项）里 —— 没被收拢');
      ok(H.exists(vaultRoot, `${KB}/99_Meta/06_工作台/库结构.json`), '99_Meta 里的库结构.json 没被收拢');
      eq(H.exists(vaultRoot, `${归集}/99_Meta/06_工作台/库结构.json`), false, '归集夹里没有 99_Meta 的影子');
      contains(
        H.readNote(vaultRoot, `${归集}/00_Inbox/__收拢甲.md`),
        `${collectDirOf(today)}/00_Inbox`,
        '甲的「文件位置」= 收拢后的新相对路径（复跑重排 0 搬动的前提）',
      );
      /**
       * 🔴 **无声明的笔记也要补声明**（收拢「每篇都写」的那半段 —— 有声明的那半段
       * 由 `mover` 第 7 步的属性跟随捎带覆盖）。夹具里的老 `_收件箱.md` **没有**
       * `文件位置`：收拢后它必须被写上归集夹的新路径。
       * （突变实测的必要性：只判"有声明的那篇"时，把"无声明也补"整段关掉照样绿 ——
       * 属性跟随把有声明的兜住了。）
       */
      contains(
        H.readNote(vaultRoot, `${归集}/00_Inbox/_收件箱.md`),
        `${collectDirOf(today)}/00_Inbox`,
        '原本没声明的笔记也被补上「文件位置」（每篇都写，不只跟已有声明）',
      );
      /**
       * ⚠️ 撤销条是**执行全部完成之后**才弹的（甲在改名循环里先到位）——直接断言会撞上
       * "条还没出现"的竞态（宽过滤跑时实测红过一次）。用轮询捕获，别拿时序赌。
       */
      ok(
        await H.until(() => {
          const ub = H.maybe(document.body, '.kbw-undobar');
          return ub != null && H.textOf(ub).includes('已收拢');
        }, 8000),
        '弹了「已收拢」撤销条（一次移动 = 一个快照）',
      );
    });

    await suite.it('收拢后复跑重排 = 0 搬动（声明已改写；面板重算即证）', async () => {
      /**
       * 🔴 **先让索引跟上真机的节拍**：桩里 `fileManager.renameFile` 批量搬完不会自动重扫，
       * 不重建的话预览拿的是**搬家前的旧位置**算 —— "0 搬动"就成了陈旧数据下的**假绿**
       * （突变实测：把"收拢补声明"整段关掉，这条照样绿）。真机上平台事件会把索引带到位，
       * 这里手动 `index.rebuild()` 补上同一节拍。
       */
      await ctx().index.rebuild();
      await H.settle(500);
      ok(
        await H.until(() => H.textOf(runButton()) === '没有要做的', 10000),
        `收拢完再预览该 0 搬动（实际「${H.textOf(runButton())}」）`,
      );
      contains(H.textOf(H.q(document.body, '.kbw-rb-side')), '0 篇要搬', '摘要写明「重跑预览：0 篇要搬 ✅」');
    });

    await suite.it('还原收拢：全部搬回原位、新建的种子页删回、归集夹收回', async () => {
      const list = await ctx().snapshot.list();
      ok(list.length > 0, '前提：收拢落了快照');
      const r = await ctx().snapshot.restore(list[0].id);
      /**
       * 收拢时只有**被收走原件的那些种子**才重建：`99_Meta` 里的两个（MOC / 目录说明）
       * 属于工具区、不收拢也不动 → 存在性判定让它们原样还在，不进 `filesRemoved`。
       */
      const seeds = skeletonPresets().full.seedFiles;
      const keptSeeds = seeds.filter((x) => x.startsWith('99_Meta/'));
      eq(r.filesRemoved, seeds.length - keptSeeds.length, `删回新建的种子页（${r.filesRemoved} 个 = 7 − 99_Meta 原样保留的 ${keptSeeds.length}）`);
      ok(H.exists(vaultRoot, `${KB}/99_Meta/04_索引与地图/MOC_知识地图.md`), '99_Meta 的种子原样还在（没被收拢、也没被重建）');
      ok(await H.until(() => H.exists(vaultRoot, aRel), 6000), '甲搬回原位');
      ok(H.exists(vaultRoot, bRel), '乙搬回原位');
      contains(H.readNote(vaultRoot, aRel), '- 00_Inbox', '甲的「文件位置」也回原值（内容写回，不是留新值）');
      eq(
        H.readNote(vaultRoot, `${KB}/00_Inbox/_收件箱.md`),
        seed0,
        '老 _收件箱.md 原样回到原位（内容写回兜的底）',
      );
      /**
       * 🔴 **还原顺序的判据看"让路"数，不看内容**：把「删新建文件」挪到「逆搬运」之后，
       * 老文件会被挪去「还原保留」、再被删、再被 ② 内容写回**原地重建** —— 最终内容一模一样
       * （突变实测：只判内容时那条会绿）。真正露馅的是 `keptAside`：
       * 正确顺序 = 新建的先删干净 → 老文件搬回时**无人在位** → 让路数恒 0。
       */
      eq(r.keptAside.length, 0, '无文件需要"让路"（先删新建的：老文件搬回时位置是空的）');
      ok(!H.exists(vaultRoot, 归集), '归集夹收回了（空目录删除）');
      ok(H.exists(vaultRoot, cRel), '丙始终没动');
    });

    await suite.it('收场：面板关掉 + 骨架回开测前 + 夹具收走', async () => {
      panel?.close('test');
      await H.settle(60);
      await ctx().configs.write('rebuild', raw0);
      await H.settle(60);
      for (const rel of [aRel, bRel, cRel]) {
        const f = app.vault.getAbstractFileByPath(rel);
        if (f) await app.vault.delete(f);
      }
      await H.settle(80);
      panel = null;
    });
  });

  // ════════════════════════════════════════════════════════════
  // ④ 示例数据（16.2）：建 / 清
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 示例数据（16.2）', async () => {
    await suite.it('值域自查：示例笔记与种子页的类型 / 领域 / 状态 / 阶段全在 schema 枚举里', () => {
      /**
       * 示例数据是给新用户"看效果"的门面 —— 值出了枚举会一出生就挂「缺必填」黄旗
       * （`missingProps` 把"类型不在值域"记成 empty，P7.2b 独立审查 🟡1 实测过）。
       * 这条**从产物内容里取值**对表：改内容不跟枚举对齐，这里先红。
       */
      const pick = (text: string, key: string): string => {
        const m = new RegExp(`^${key}: (.+)$`, 'm').exec(text);
        return m ? m[1].trim() : '';
      };
      const seedRels = skeletonPresets().full.seedFiles;
      const texts = [
        ...sampleNotes('X', '2026-10-04').map((s) => s.content),
        ...seedRels.map((r) => seedContentOf(r, '2026-10-04') ?? ''),
      ];
      ok(texts.every((t) => t.length > 0), '每个产物都有内容（没收录的种子会返回 null —— 名单里不该有）');
      const seenTypes: string[] = [];
      for (const text of texts) {
        const t = pick(text, '类型');
        seenTypes.push(t);
        ok((NOTE_TYPES as readonly string[]).includes(t), `类型在 v2 七值域：${t}`);
        ok(!text.includes('领域:'), `v2 不该再有「领域」：${t}`);
        const st = pick(text, '状态');
        // 状态可以不写（收件箱 / 结构页），写了就必须在三值域里
        if (st !== '') ok((STATUSES as readonly string[]).includes(st), `状态在值域：${st}（${t}）`);
      }
      ok(seenTypes.includes('笔记'), '示例里有「笔记」档');
      ok(seenTypes.includes('索引'), '种子页都是「索引」/「规范」档（v2：中心页收拢为索引）');
    });

    let panel: PanelHandle | null = null;
    let kb0 = '';
    const demoKb = '__示例空库';

    await suite.it('勾选「放示例数据」→ 6 篇 + 示例板块同一次执行里创建（基础版预设的空库）', async () => {
      kb0 = ctx().settings.kbRoot();
      if (!(await app.vault.adapter.exists(demoKb))) await app.vault.adapter.mkdir(demoKb);
      await ctx().settings.save({ kbRoot: demoKb });
      await H.settle(100);
      // 基础版预设（9 目录 / 0 种子页）—— 顺带覆盖"基础版也能放示例"
      const P = skeletonPresets();
      await ctx().configs.write('rebuild', {
        version: 1,
        preset: 'basic',
        rootName: demoKb,
        dirs: [...P.basic.dirs],
        seedFiles: [...P.basic.seedFiles],
        excludedTop: ['.obsidian', '.trash', '.tooling', '02_旧知识库'],
        keepTop: [],
      });
      panel = openRebuildPanel(ctx());
      await H.settle(180);
      const cb = checkBox('放几篇示例笔记');
      ok(cb != null, '「放几篇示例笔记」勾选框在（初始化档）');
      ok(cb != null && !cb.checked, '默认不勾（演示数据是可选件）');
      H.click(cb as Element);
      await H.settle(250);
      // P7.11 · #14：逐条列出（行尾「执行时创建」）—— 文案从"一行摘要"改成了行
      contains(H.textOf(H.q(document.body, '.kbw-rb-side')), '__示例', '右栏逐条预告 6 个示例文件');
      const runBtn = runButton();
      contains(H.textOf(runBtn), '开始初始化', `执行按钮（实际「${H.textOf(runBtn)}」）`);
      H.click(runBtn);
      await H.settle(120);
      const modal = lastModal();
      const primary = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) => H.textOf(b).startsWith('建这'));
      ok(
        primary != null && /建这 \d+ 个目录 \+ 6 个文件/.test(H.textOf(primary as Element)),
        `主按钮带目录数与文件数（实际「${H.textOf(primary as Element)}」）`,
      );
      H.click(primary as Element);

      const wanted = sampleNotes(demoKb, '2000-01-01'); // 只取路径（内容日期无所谓）
      ok(
        await H.until(() => wanted.every((s) => H.exists(vaultRoot, s.path)), 10000),
        `6 篇示例都建出来了（${wanted.length} 篇）`,
      );
      const fav = wanted.find((s) => s.path.includes('灵感速记'));
      contains(H.readNote(vaultRoot, (fav as { path: string }).path), '收藏: true', '有一篇带收藏（首页收藏夹块的显形条件）');
      const linked = wanted.find((s) => s.path.includes('项目立项'));
      contains(H.readNote(vaultRoot, (linked as { path: string }).path), '[[__示例', '有一篇带双链');
      // 示例看板板块进了 看板配置.json（磁盘回读）
      const board = JSON.parse(H.readNote(vaultRoot, `${demoKb}/99_Meta/06_工作台/看板配置.json`)) as {
        sections?: { id?: string; kind?: string; value?: string }[];
      };
      const sec = (board.sections ?? []).find((s) => s.id === SAMPLE_SECTION_ID);
      ok(sec != null, '示例板块追加进了看板配置');
      eq(sec?.kind, 'tag', '板块是 tag 型（认「示例」标签）');
      eq(sec?.value, '示例', '板块认的标签值');
      // 幂等：再预览 = 没有要做的
      await ctx().index.rebuild();
      await H.settle(200);
      ok(
        await H.until(() => H.textOf(runButton()) === '没有要做的', 8000),
        `放过示例后再预览该「没有要做的」（实际「${H.textOf(runButton())}」）`,
      );
    });

    await suite.it('「清掉示例数据」：6 篇走回收站 + 示例板块移除（认前缀与 id，不误伤别的）', async () => {
      await ctx().index.rebuild();
      await H.settle(200);
      const row = actRow(`清掉示例数据（6 篇）`);
      ok(row != null, '有「清掉示例数据」那一行（认前缀才画）');
      const btn = H.qa<HTMLElement>(row as HTMLElement, '.kbw-btn').find((b) => H.textOf(b).startsWith('清掉'));
      ok(btn != null, '清掉按钮');
      H.click(btn as Element);
      await H.settle(120);
      const modal = lastModal();
      contains(H.textOf(modal), '回收站', '说明写清删除去回收站');
      const primary = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) => H.textOf(b).startsWith('清掉这'));
      ok(primary != null, '确认按钮');
      H.click(primary as Element);

      const wanted = sampleNotes(demoKb, '2000-01-01');
      ok(
        await H.until(() => wanted.every((s) => !H.exists(vaultRoot, s.path)), 10000),
        '6 篇示例都清掉了',
      );
      const board = JSON.parse(H.readNote(vaultRoot, `${demoKb}/99_Meta/06_工作台/看板配置.json`)) as {
        sections?: { id?: string }[];
      };
      eq(
        (board.sections ?? []).some((s) => s.id === SAMPLE_SECTION_ID),
        false,
        '示例板块从看板配置里移除了',
      );
    });

    await suite.it('收场：面板关掉 + kbRoot 切回', async () => {
      panel?.close('test');
      await H.settle(60);
      await ctx().settings.save({ kbRoot: kb0 });
      await H.settle(100);
      panel = null;
    });
  });
}


// ── 助手 ─────────────────────────────────────────────────────
function lastModal(): HTMLElement {
  const all = H.qa<HTMLElement>(document.body, '.kbw-modal');
  const last = all[all.length - 1];
  ok(last, '该有模态在屏幕上');
  return last;
}

/** 脚上那枚执行按钮（「执行（…）」或「没有要做的」） */
function runButton(): HTMLElement {
  const btns = H.qa<HTMLElement>(document.body, '.kbw-btn');
  const b = btns.find((x) => {
    const t = H.textOf(x);
    // R7 动词：开始纠偏 / 开始归拢 / 开始初始化（「没有要做的」照旧）
    return /^(开始纠偏|开始归拢|开始初始化|没有要做)/.test(t);
  });
  ok(b != null, '该有执行按钮');
  return b as HTMLElement;
}

/** ③「执行方式」里的单选行（按名字找；`.kbw-rb-radio`） */
function radioRow(label: string): HTMLElement | null {
  return (
    H.qa<HTMLElement>(document.body, '.kbw-rb-radio').find(
      (r) => H.textOf(H.maybe(r, '.kbw-rb-radio-label') ?? r) === label,
    ) ?? null
  );
}

/** ③「顺手补建」里的勾选框（按标签文字找；返回 input 本体） */
function checkBox(label: string): HTMLInputElement | null {
  const wrap = H.qa<HTMLElement>(document.body, '.kbw-rb-check').find((r) =>
    H.textOf(r).includes(label),
  );
  return wrap ? H.maybe<HTMLInputElement>(wrap, 'input.kbw-check') : null;
}

/** 库里有 `__示例` 时那一行「清掉示例数据…」（仍走 `.kbw-rb-act` 那套） */
function actRow(label: string): HTMLElement | null {
  return (
    H.qa<HTMLElement>(document.body, '.kbw-rb-act').find(
      (r) => H.textOf(H.maybe(r, '.kbw-rb-actname')) === label,
    ) ?? null
  );
}

/** 造夹具文件（带父目录 + 索引跟上）——夹具都在 temp 库里，不怕残留 */
async function ensureFile(
  plugin: KbWorkbenchPlugin,
  app: StubApp,
  rel: string,
  text: string,
): Promise<void> {
  const dir = rel.slice(0, rel.lastIndexOf('/'));
  if (dir && !(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  if (!app.vault.getAbstractFileByPath(rel)) await app.vault.create(rel, text);
  await plugin.context().index.rebuild();
  await H.settle(80);
}
