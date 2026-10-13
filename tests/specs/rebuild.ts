/**
 * spec：**库结构重排**（P5 · `services/rebuild.ts` + `ui/rebuild-panel.ts`）
 *
 * 判据分两层（P5 开工提示词定的）：
 *  ① **纯函数**：骨架 normalize / 四条判据 / 树与徽标 —— 计划对不对，全在这层钉住
 *  ② **真链路**：造几篇错位的笔记 → 开面板 → 预览（只读）→ 执行 → 日志分组
 *     → **再执行一次幂等** → 还原（逆 rename + 删掉本次新建的目录）
 *
 * ⚠️ 真链路那一段在**动库库（B）**上跑，跑完必须把库还原回去（最后一条用例就是验这个）——
 * 它后面还有别的 spec 在同一个库上跑。
 * ⚠️ 断言一律"从数据里取"（`plan.newDirs` 这类），**不写死"夹具里缺 4 个目录"**：
 * 夹具换一次（P3 就这么红过 12 条）这些数就变了。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import {
  buildTree,
  detectCollisions,
  executeRebuild,
  normalizeSkeleton,
  planCounts,
  planRebuild,
  planSummary,
  vaultShapeOf,
  type RebuildMove,
  type RebuildNode,
  type RebuildNote,
  type RebuildPlanInput,
  type Skeleton,
} from '../../src/services/rebuild';
import { openRebuildPanel } from '../../src/ui/rebuild-panel';
import { openSettingsPanel } from '../../src/ui/settings-panel';
import { __resetNotices } from '../../src/ui/notify';
import type { PanelHandle } from '../../src/ui/panel';
import { clearViewMemory, recallScroll, rememberScroll, SCROLL_ATTR } from '../../src/core/view-memory';

const KB = '01_新知识库';
/** 自己造的夹具一律带这个前缀（清场靠认它，不靠"跟开工前 diff"） */
const T = '__重排';

export async function specRebuild(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  // ════════════════════════════════════════════════════════════
  // ① 纯函数：骨架 / 计划 / 树
  // ════════════════════════════════════════════════════════════
  await suite.group('P5 · 重排库结构（骨架与计划，纯函数）', async () => {
    await suite.it('normalizeSkeleton：只加不删 + 脏值收口（剥库根前缀 / 补父目录 / 排除项不收）', () => {
      const sk = normalizeSkeleton({
        version: 'x',
        rootName: '01_新知识库/',
        // 脏值全家桶：带库根前缀、首尾空格、空串、重复、排除项之下、字符串当数组
        dirs: ['01_新知识库/00_Inbox', '02_Areas/新领域', '  02_Areas/新领域  ', '', '02_旧知识库/x', '.trash'],
        seedFiles: '02_Areas/_领域中心.md',
        excludedTop: ['.trash', '02_旧知识库'],
      });
      eq(sk.rootName, '01_新知识库', '库根名的尾斜杠去掉');
      eq(sk.version, 1, '版本号不是数字 → 退回 1');
      ok(sk.dirs.includes('00_Inbox'), '带库根前缀的写成 `01_新知识库/00_Inbox` 也能收回来');
      ok(sk.dirs.includes('02_Areas'), '隐含的父目录补上（手加子目录时不用连着写父目录）');
      ok(sk.dirs.includes('02_Areas/新领域'), '带空格的那条收回来了');
      eq(sk.dirs.filter((d) => d === '02_Areas/新领域').length, 1, '重复项去掉');
      ok(!sk.dirs.some((d) => d.startsWith('02_旧知识库')), '排除项之下的一条都不收');
      ok(!sk.dirs.some((d) => d.startsWith('.trash')), '`.trash` 也不收');
      ok(sk.seedFiles.includes('02_Areas/_领域中心.md'), 'seedFiles 写成字符串也收（脏值收口）');
      ok(sk.seedFiles.includes('02_Areas/_领域中心.md'), '种子文件在骨架里');
      ok(sk.excludedTop.includes('02_旧知识库'), 'excludedTop 原样保留');
      // 整个字段写成字符串（手改 JSON 时的常见脏值）也要收成一条
      eq(normalizeSkeleton({ excludedTop: '02_旧知识库', dirs: [] }).excludedTop.length, 1);
      // 顺序：浅 → 深（面板的树与"先建父目录"都靠它）
      const depth = (d: string): number => d.split('/').length;
      let ordered = true;
      for (let i = 1; i < sk.dirs.length; i += 1) if (depth(sk.dirs[i - 1]) > depth(sk.dirs[i])) ordered = false;
      ok(ordered, '骨架目录按浅 → 深排好');
    });

    await suite.it('判据①：声明优先 —— 声明与实际不符才搬；声明里有一个就是现在的位置就不动', () => {
      const p = planRebuild(
        inputOf([
          noteOf('00_Inbox/甲.md', { declared: ['02_Areas/灵感杂记'] }),
          noteOf('02_Areas/灵感杂记/乙.md', { declared: ['02_Areas/灵感杂记'] }),
          // 声明了两个位置，现在就在其中之一 → 不搬
          noteOf('02_Areas/灵感杂记/丙.md', { declared: ['02_Areas/内容创作', '02_Areas/灵感杂记'] }),
        ]),
      );
      eq(p.moves.length, 1, '只有甲要搬');
      eq(p.moves[0].path, `${KB}/00_Inbox/甲.md`);
      eq(p.moves[0].to, `${KB}/02_Areas/灵感杂记/甲.md`);
      eq(p.moves[0].dirRel, '02_Areas/灵感杂记', '目标目录是"相对库根"的口径（树上的徽标按它归位）');
      eq(p.moves[0].why, 'declared');
      contains(p.moves[0].note, '声明', '理由里要写清是"按声明"搬的');
    });

    await suite.it('判据②：兜底**只在 Inbox** —— 别处的"没声明"不是"没归位"', () => {
      const p = planRebuild(
        inputOf([
          noteOf('00_Inbox/甲.md', {}),
          // 归档区里没声明的：不划范围的话会被"归位"走
          noteOf('04_Archives/旧资料/乙.md', { type: '笔记' }),
          // 兜底也没配（见 `fallbackDir: null`）→ 待定
          noteOf('00_Inbox/丙.md', {}),
          // 结构性笔记（`_收件箱.md` 那种）的功能位置就是所在目录
          noteOf('00_Inbox/丁.md', { type: '索引' }),
          // 直接躺在库根下
          noteOf('戊.md', {}),
        ], { fallbackDir: null }),
      );
      eq(p.moves.length, 0, '兜底目录也关掉 → 一篇都不搬');
      ok(!p.moves.some((m) => m.path.includes('乙')), '归档区的没声明笔记不动（判据②的范围）');
      ok(p.undeclared.some((r) => r.includes('乙')), '但它要出现在"没声明（不动）"那一栏里');
      ok(
        p.pending.some((x) => x.path.includes('丙') && x.code === 'no-fallback'),
        '没声明、兜底也没配 → 待定（no-fallback）',
      );
      ok(!p.moves.some((m) => m.path.includes('丁')), '结构性的不兜底');
      ok(p.pending.some((x) => x.path.includes('戊')), '躺在库根下的 → 待定（它不属于任何目录）');
    });

    await suite.it('兜底目录：没信号的 Inbox 笔记去路由表的「领域兜底」', () => {
      const p = planRebuild(inputOf([noteOf('00_Inbox/甲.md', {})]));
      eq(p.moves.length, 1, '没信号但有兜底目录 → 照搬');
      eq(p.moves[0].dirRel, '02_Areas', '落点是路由表的「领域兜底」');
      eq(p.moves[0].why, 'fallback', 'v2：why = fallback（原 `area`）');
      contains(p.moves[0].note, '兜底', '理由里写清是兜底目录');
    });

    await suite.it('模板不动（与 reconcile 同口径）：`T_*.md` 落进 Inbox 也不被兜底搬走', () => {
      const p = planRebuild(
        inputOf([
          noteOf('00_Inbox/T_甲.md', { isTemplate: true }),
          noteOf('00_Inbox/乙.md', {}),
        ]),
      );
      ok(!p.moves.some((m) => m.path.includes('T_甲')), '模板不参与（它的落点由模板库/功能定）');
      eq(p.moves.length, 1, '同目录里的普通笔记照搬');
      // 声明优先那条路也不该把模板搬走
      const p2 = planRebuild(
        inputOf([noteOf('00_Inbox/T_丙.md', { declared: ['02_Areas/灵感杂记'], isTemplate: true })]),
      );
      eq(p2.moves.length, 0, '带声明的模板也不动');
    });

    await suite.it('判据③：`99_Meta` 里的文件一律不动（但目标可以是 `99_Meta`）', () => {
      const p = planRebuild(
        inputOf(
          [
            // 工具区里的文件：哪怕声明写着别处，也不动（模板/日志的位置由各自功能定）
            noteOf('99_Meta/05_操作日志/日志-1.md', { declared: ['02_Areas/灵感杂记'], type: '日志' }),
            // 反过来：Inbox 没信号的笔记，兜底目录配成 99_Meta —— 照搬
            noteOf('00_Inbox/甲.md', {}),
          ],
          { fallbackDir: '99_Meta' },
        ),
      );
      eq(p.moves.length, 1, '只有 Inbox 那篇动');
      eq(p.moves[0].to, `${KB}/99_Meta/甲.md`);
      ok(!p.moves.some((m) => m.from.includes('99_Meta/')), '来源在工具区的一律不搬');
    });

    await suite.it('判据④：目标既不在骨架里、库里也没有 → 待定（不替你在库里长目录）', () => {
      const p = planRebuild(
        inputOf([
          noteOf('00_Inbox/甲.md', { declared: ['02_Areas/查无此目录'] }),
          noteOf('00_Inbox/乙.md', { declared: ['02_旧知识库/想都别想'] }),
        ]),
      );
      eq(p.moves.length, 0, '一个都不搬');
      eq(p.pending.length, 2);
      // P7.9 · ⑤：why 改「原因 → 出路」句式（判据与 A2 的分组播报 `pendingLineOf` 同源）
      contains(p.pending[0].why, '「文件位置」指向不存在的目录', 'why 的"原因"那一半');
      contains(p.pending[0].why, '——', 'why 是「原因 → 出路」两句式');
      eq(p.pending[0].code, 'missing-dir', '机器码与文案配套（A2 分组播报认它）');
      contains(p.pending[1].why, '排除');
    });

    await suite.it('同一批里两篇同名抢同一个落点 → **两篇都待定**（不猜谁先谁后）', () => {
      const p = planRebuild(
        inputOf([
          noteOf('00_Inbox/同名.md', { declared: ['02_Areas/灵感杂记'] }),
          noteOf('04_Archives/同名.md', { declared: ['02_Areas/灵感杂记'] }),
        ]),
      );
      eq(p.moves.length, 0, '谁都不搬（猜错了就是把一篇盖成另一篇）');
      eq(p.pending.length, 2);
      contains(p.pending[0].why, '同名');
    });

    await suite.it('目录三态：新建 / 保留 / 骨架外（**只加不删**）', () => {
      const p = planRebuild(inputOf([], { skeleton: skel({ dirs: [...BASE_DIRS, '02_Areas/新领域'] }) }));
      ok(p.newDirs.includes('02_Areas/新领域'), '骨架里有、库里没有 → 新建');
      ok(p.keptDirs.includes('02_Areas/灵感杂记'), '骨架里有、库里也有 → 保留');
      ok(p.extraDirs.includes('04_Archives/旧资料'), '库里在、骨架没有 → 保留（骨架外），不删');
      ok(!p.newDirs.some((d) => d.startsWith('02_旧知识库')), '排除项不参与');
    });

    await suite.it('种子文件：在不在分开报（重排**不创建**文件）', () => {
      const p = planRebuild(
        inputOf([], { skeleton: skel({ seedFiles: ['00_Inbox/_收件箱.md', '03_Resources/_资源中心.md'] }) }),
      );
      ok(p.seedPresent.includes('00_Inbox/_收件箱.md'), '在的报"在"');
      ok(p.seedMissing.includes('03_Resources/_资源中心.md'), '不在的报"缺"');
    });

    await suite.it('撞名自查（预览用）：同名**同内容** = 已搬过；同名**不同内容** = 真冲突', async () => {
      const moves: RebuildMove[] = [
        move('00_Inbox/甲.md', '02_Areas/灵感杂记'),
        move('00_Inbox/乙.md', '02_Areas/灵感杂记'),
        move('00_Inbox/丙.md', '02_Areas/灵感杂记'),
      ];
      const files = new Map<string, string>([
        [`${KB}/02_Areas/灵感杂记/甲.md`, '同样的内容'],
        [`${KB}/02_Areas/灵感杂记/乙.md`, '不一样的内容'],
      ]);
      const cl = await detectCollisions(moves, {
        exists: (p) => files.has(p),
        read: async (p) => (p.includes('00_Inbox/甲') ? '同样的内容' : files.get(p) ?? null),
      });
      eq(cl.length, 2, '丙的目标不存在 → 不算撞名');
      eq(cl.find((c) => c.path.includes('甲'))?.kind, 'already', '内容相同 = 已搬过（重复执行的正常情况）');
      eq(cl.find((c) => c.path.includes('乙'))?.kind, 'blocked', '内容不同 = 真冲突');
    });

    await suite.it('树与徽标：新建 / 保留 / 搬入 N / 撞名 N（决策 17）', async () => {
      const p = planRebuild(
        inputOf(
          [
            noteOf('00_Inbox/甲.md', { declared: ['02_Areas/灵感杂记'] }),
            noteOf('00_Inbox/乙.md', { declared: ['02_Areas/灵感杂记'] }),
            noteOf('00_Inbox/丙.md', { declared: ['02_Areas/新领域'] }),
          ],
          { skeleton: skel({ dirs: [...BASE_DIRS, '02_Areas/新领域'] }) },
        ),
      );
      ok(p.moves.length === 3, '三篇都要搬');
      const cl = await detectCollisions(p.moves, {
        exists: (x) => x.endsWith('灵感杂记/乙.md'),
        // 目标那份与源那份内容不同 → 乙是「真冲突」（读出来一样的话会被判成 already）
        read: async (x) => (x.endsWith('灵感杂记/乙.md') ? '目标那份' : '源那份'),
      });
      const root = buildTree(p, cl);
      const area = findNode(root, '02_Areas');
      const ling = findNode(root, '02_Areas/灵感杂记');
      const xin = findNode(root, '02_Areas/新领域');
      ok(ling && xin && area, '树上该有这三个节点');
      eq(area?.status, 'keep', '`02_Areas` 已存在 → 保留');
      eq(xin?.status, 'new', '`02_Areas/新领域` 不存在 → 新建');
      eq(ling?.status, 'keep');
      eq(ling?.incoming.length, 2, '「搬入 N」只算这个目录自己的（不含子目录）');
      eq(xin?.incoming.length, 1);
      eq(ling?.blocked, 1, '「撞名 N」只算真冲突（`already` 是正常情况，不进徽标）');
      eq(area?.incoming.length, 0, '父目录不把子目录的搬入算进来');
      // 骨架外那个目录也要在树上（只加不删必须看得见）
      eq(findNode(root, '04_Archives/旧资料')?.status, 'extra');
    });

    await suite.it('planSummary 把三个数写在一行（确认流标题与面板副标题共用）', async () => {
      const p = planRebuild(
        inputOf([noteOf('00_Inbox/甲.md', { declared: ['02_Areas/灵感杂记'] })], {
          skeleton: skel({ dirs: [...BASE_DIRS, '02_Areas/新领域'] }),
        }),
      );
      const c = planCounts(p, [{ path: 'x', to: 'y', kind: 'blocked', note: '' }]);
      eq(c.newDirs, 1);
      eq(c.moved, 1);
      eq(c.blocked, 1);
      const s = planSummary(p, [{ path: 'x', to: 'y', kind: 'blocked', note: '' }]);
      contains(s, '新建 1 目录');
      contains(s, '搬入 1 篇');
      contains(s, '真冲突 1');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 真链路：预览 → 执行 → 幂等 → 还原
  // ════════════════════════════════════════════════════════════
  await suite.group('P5 · 重排库结构（真链路）', async () => {
    writeFixture(vaultRoot);
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app);

    /** 造出来的那几篇（断言时只认它们，别赌夹具里还有别的什么） */
    const inbox = (name: string): string => `${KB}/00_Inbox/${name}`;
    const ling = (name: string): string => `${KB}/02_Areas/灵感杂记/${name}`;
    /** v2：没信号的 Inbox 笔记落「兜底目录」= B 库路由表的 02_Areas（甲/己 走这条） */
    const fall = (name: string): string => `${KB}/02_Areas/${name}`;
    const digest = (): Map<string, string> => vaultDigest(vaultRoot);

    let panel: PanelHandle | null = null;
    /** 执行前的库快照（**排除日志目录**：执行会新写日志，而日志不该被还原动） */
    let before = new Map<string, string>();
    /** 执行**之前**骨架里缺的目录 = 这一轮该新建的（从数据里取，别写死"缺 4 个"） */
    let expectCreated: string[] = [];

    await suite.it('打开面板 → 预览（只读）：出报告、**不动任何文件**、可反复点', async () => {
      panel = openRebuildPanel(ctx());
      await H.until(() => document.body.querySelector('.kbw-rb-node') != null, 3000);
      const p = panel;
      ok(p, '面板开出来了');
      ok(document.body.querySelector('.kbw-rb-node'), '树画出来了');

      // 树上真有徽标（P7.11 · #14 徽标减噪：**只标偏离** —— 新建 / 搬入 / 撞名）
      const chips = H.textsOf(document.body, '.kbw-rb-node .kbw-chip');
      ok(chips.some((t) => t.startsWith('新建')), '有「新建」徽标');
      ok(chips.some((t) => t.startsWith('搬入')), '有「搬入 N」徽标');
      ok(chips.some((t) => t.startsWith('撞名')), '有「撞名 N」徽标（丁的目标内容不同）');
      ok(
        !chips.some((t) => t.startsWith('保留')),
        `「保留」是常态、默认不标（实际徽标：${chips.join(' | ')}）`,
      );
      ok(
        H.maybe(document.body, '.kbw-rb-legend') != null,
        '树底有一行图例（灰行 = 骨架外目录）',
      );

      /**
       * R7 三块式（照 §R7 稿；逻辑零改）：① 体检范围与标准 · ② 问题清单 · ③ 执行方式。
       * 数字仍**从数据取、与计划对表**（不写死）。
       */
      const side = document.body.querySelector('.kbw-rb-side') as HTMLElement;
      ok(side, '右栏在');
      const band = H.maybe<HTMLElement>(side, '.kbw-rb-plan');
      ok(band, '① 体检范围与标准 在（.kbw-rb-plan）');
      contains(H.textOf(band as HTMLElement), '体检范围与标准', '① 块标题对表');
      contains(H.textOf(band as HTMLElement), '范围', '有「范围」');
      contains(H.textOf(band as HTMLElement), '标准', '有「标准」');
      ok(H.maybe<HTMLElement>(band as HTMLElement, '.kbw-rb-preset'), '标准下拉在 ① 里');
      contains(H.textOf(band as HTMLElement), '重新检查', '「生成预览」已改名叫「重新检查」');
      const blocks = H.qa<HTMLElement>(side, '.kbw-rb-block');
      eq(blocks.length, 2, '②③ 两块在（.kbw-rb-block）');
      contains(H.textOf(blocks[0]), '问题清单', '② 问题清单');
      contains(H.textOf(blocks[1]), '执行方式', '③ 执行方式');
      ok(H.maybe(side, '.kbw-rb-grp.is-do.is-open') != null, '「会做的」档在且默认展开（▾）');
      ok(H.maybe(side, '.kbw-rb-grp.is-warn.is-open') != null, '「要你拿主意」档在且默认展开');
      ok(H.maybe(side, '.kbw-rb-grp.is-keep') != null, '「不动的」档在');
      ok(
        H.maybe(side, '.kbw-rb-grp.is-keep.is-open') == null,
        '「不动的」默认收起（点开看名单）',
      );
      // 一句总述与数据对表（该搬的篇数 = 会做组里逐条列出的搬动行数）
      const sent = H.q<HTMLElement>(side, '.kbw-rb-sumsent');
      const moveRows = H
        .qa<HTMLElement>(side, '.kbw-rb-grp.is-do .kbw-rb-row')
        .filter((r) => H.textOf(H.maybe(r, '.kbw-rb-why') ?? r).startsWith('→')).length;
      contains(
        H.textOf(sent),
        `查完了：${moveRows} 篇该搬`,
        '总述的"该搬"数 = 会做组里逐条列出的搬动数',
      );

      // 「看目录结构示意」：点一下展开示意树（读的是**标准**，不掺库现状的徽标）
      // ⚠️ 点它会重画右栏 —— 每次都要**重新取节点**（旧引用已脱离文档）
      H.click(H.q<HTMLElement>(document.body, '.kbw-rb-skelpick'));
      await H.settle(30);
      const skel = H.maybe<HTMLElement>(document.body, '.kbw-rb-plan .kbw-rb-skel');
      ok(skel, '示意树展开（点标准即展开 / 点开关同一条路）');
      const skDirs = normalizeSkeleton(await ctx().configs.read('rebuild')).dirs.length;
      eq(
        H.qa<HTMLElement>(skel as HTMLElement, '.kbw-rb-skelrow').length,
        skDirs,
        '示意树逐条画出标准里的目录（数 = 骨架 dirs）',
      );
      contains(H.textOf(skel as HTMLElement), '个索引页', '索引页总数写在示意树里');
      H.click(H.q<HTMLElement>(document.body, '.kbw-rb-skelpick'));
      await H.settle(30);
      eq(H.maybe(document.body, '.kbw-rb-plan .kbw-rb-skel'), null, '再点一下收起');

      // 可折叠组：点组头真的收合（类 + computed 双判 —— 与树收起那条同一纪律）
      const keepHead = H.q<HTMLElement>(side, '.kbw-rb-grp.is-keep .kbw-rb-grphead');
      const keepBody = H.q<HTMLElement>(side, '.kbw-rb-grp.is-keep .kbw-rb-grpbody');
      eq(getComputedStyle(keepBody).display, 'none', '（前提）「不动的」默认收着');
      H.click(keepHead);
      eq(getComputedStyle(keepBody).display !== 'none', true, '点组头 → 展开');
      H.click(keepHead);
      eq(getComputedStyle(keepBody).display, 'none', '再点 → 收回');

      // 反复点：只读扫描 —— **笔记与配置一个字节都不许变**
      //（⚠️ 预览报告本身会新写一条日志，那是 §6 定的落点；
      //   `digest()` 已经把 `05_操作日志` 排除在外，所以这里比的是"库里的笔记"）
      const btn = panelBtn('重新检查');
      H.click(btn);
      await H.settle(250);
      const d0 = digest();
      H.click(btn);
      await H.settle(250);
      sameVault(digest(), d0, '预览一个字节都没改');
      ok(
        H.listFiles(vaultRoot, `${KB}/99_Meta/05_操作日志`).some((f) => f.includes('重排预览')),
        '预览写了报告进 99_Meta/05_操作日志/（§6 的落点那一栏）',
      );
    });

    await suite.it('R7 · ①范围：切到别的目录 → 候选收窄（会做里没甲了）；切回全库恢复', async () => {
      const doTxt = (): string =>
        H.textOf(H.maybe<HTMLElement>(document.body, '.kbw-rb-grp.is-do') ?? document.body);
      const sel0 = H.q<HTMLSelectElement>(document.body, '.kbw-rb-range');
      ok(
        Array.from(sel0.options).some((o) => o.value === '04_Archives'),
        '范围下拉里有库里的目录（全库 + 各目录）',
      );
      ok(doTxt().includes('甲'), '（前提）全库时 甲 在会做里');
      // 甲在 00_Inbox —— 把范围切到 04_Archives，它就不该再出现在候选里
      sel0.value = '04_Archives';
      sel0.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settle(400);
      ok(!doTxt().includes('甲'), '范围切到 04_Archives → 会做里没有甲了（候选收窄生效）');
      // 切回全库
      const sel1 = H.q<HTMLSelectElement>(document.body, '.kbw-rb-range');
      sel1.value = '';
      sel1.dispatchEvent(new Event('change', { bubbles: true }));
      await H.settle(400);
      ok(doTxt().includes('甲'), '切回全库 → 甲 回来（范围与计划联动）');
    });

    await suite.it('树上点一下能收起（`is-collapsed` 贴在 CSS 认的那个元素上）', () => {
      /**
       * 🔴 独立审查 🟡2 抓到的那条：类原先贴在**外层 wrap** 上，而 CSS 认的是
       * `.kbw-rb-kids.is-collapsed` → 点了箭头变、子节点不动，而且**离线/真机都不报错**。
       * ⚠️ 判据走 `getComputedStyle`（jsdom 里已注入真 `styles.css`，`board.ts` 有先例）——
       * 只断言"类名在不在"的话，两份判定再漂一次照样绿。
       */
      const parent = H.qa<HTMLElement>(document.body, '.kbw-rb-node').find(
        (n) => (n.dataset.rel ?? '').split('/').length === 1 && !!n.nextElementSibling,
      );
      ok(parent, '该有一个一级节点（它下面才有子节点）');
      const wrap = parent.parentElement as HTMLElement;
      const kids = wrap.querySelector('.kbw-rb-kids') as HTMLElement;
      ok(kids, '节点下面该有子节点容器');
      eq(getComputedStyle(kids).display !== 'none', true, '（前提）一开始是展开的');
      H.click(parent);
      eq(getComputedStyle(kids).display, 'none', '点一下 → 子节点真的收起来了');
      H.click(parent);
      eq(getComputedStyle(kids).display !== 'none', true, '再点一下 → 又展开');
    });

    await suite.it('预览的判据与实测一致：甲要搬、丙是「已搬过」、丁是「真冲突」、乙待定', () => {
      const side = document.body.querySelector('.kbw-rb-side');
      ok(side, '右栏在');
      const body = H.textOf(side);
      contains(body, '要你拿主意', '有「要你拿主意」那一组');
      contains(body, '已搬过', '已搬过在「不动的」名单里（DOM 里在，组收着）');
      /** 🔴 R7：三组按类判（别再对整栏找词 —— 折叠组的文本也在 DOM 里，会两头假红） */
      const doTxt = H.textOf(H.maybe<HTMLElement>(document.body, '.kbw-rb-grp.is-do') ?? document.body);
      const warnTxt = H.textOf(
        H.maybe<HTMLElement>(document.body, '.kbw-rb-grp.is-warn') ?? document.body,
      );
      contains(doTxt, '甲', '甲在「会做的」（要搬的）清单里');
      contains(warnTxt, '丁', '丁（真冲突：不覆盖）在「要你拿主意」里');
      contains(warnTxt, '乙', '乙（目标目录不存在）也在「要你拿主意」里');
      /** 「不动的」组里那份可折叠摘要行还在（点开看名单） */
      ok(
        H.maybe(document.body, '.kbw-rb-grp.is-keep .kbw-rb-keeper') != null,
        '「已搬过」是可折叠摘要行（不动的组内）',
      );
      /**
       * P7.11 · #14：这条**按档**判 —— 旧写法对整个右栏 `!includes('戊')`，
       * 而"无声明留原位"的名单在「不动的」档（折叠但文本在 DOM 里）→ 会假红。
       * 要判的本来就是"别进要搬的清单"（会做档）。
       */
      ok(!doTxt.includes('戊'), '归档区那篇不在「会做」（要搬的）清单里');
    });

    await suite.it('执行：确认流写明"新建 N 目录 / 搬入 N 篇" → 真搬 → 位置锁定要说出来', async () => {
      before = digest();
      const sk0 = normalizeSkeleton(await ctx().configs.read('rebuild'));
      const shape0 = await vaultShapeOf(app as never, KB);
      expectCreated = sk0.dirs.filter((d) => !shape0.dirs.has(d));
      ok(expectCreated.length > 0, `这一轮该新建目录（夹具里缺：${expectCreated.join(' / ')}）`);
      const runBtn = panelBtn('开始纠偏');
      H.click(runBtn);
      await H.settle(80);
      const modal = topModal();
      const title = H.textOf(modal.querySelector('.kbw-panel-title') ?? modal);
      contains(title, '新建', `确认流标题要写清数量与动作：实际是「${title}」`);
      contains(title, '搬入');
      contains(H.textOf(modal), '位置锁定', '设了「位置锁定」的要说"将一并移动"，不是"已跳过"');
      // 主按钮上的数量 = 计划里要搬的篇数（不是"确定"）
      const primary = H.qa<HTMLElement>(modal, '.kbw-btn').find((b) => H.textOf(b).startsWith('搬这'));
      ok(primary, '主按钮要重复数量');
      H.click(primary as Element);
      await H.settle(60);

      ok(await H.until(() => H.exists(vaultRoot, fall(`${T}甲.md`)), 4000), '甲被搬到了兜底目录 02_Areas');
      ok(await H.until(() => H.exists(vaultRoot, fall(`${T}己.md`)), 4000), '设了位置锁定的己也搬了（重排是"手动发起"，锁不拦）');
      ok(!H.exists(vaultRoot, inbox(`${T}甲.md`)), '甲不在 Inbox 了');
      ok(app.vault.getAbstractFileByPath(fall(`${T}甲.md`)), '平台索引里也已到位（不是只动了盘）');
      ok(H.exists(vaultRoot, inbox(`${T}乙.md`)), '乙（目标目录不存在）留在原地');
      ok(H.exists(vaultRoot, inbox(`${T}丙.md`)), '丙（已搬过）留在原地 —— 绝不覆盖');
      ok(H.exists(vaultRoot, inbox(`${T}丁.md`)), '丁（真冲突）留在原地');
      ok(H.exists(vaultRoot, `${KB}/04_Archives/旧资料/${T}戊.md`), '戊（归档区）没被动过');
      ok(H.exists(vaultRoot, ling(`${T}丙.md`)), '丙在目标位置的那一份也还在');

      // 骨架目录齐了（完成定义：执行 = 补目录 + 分送）
      const shape = await vaultShapeOf(app as never, KB);
      const sk = normalizeSkeleton(await ctx().configs.read('rebuild'));
      const missing = sk.dirs.filter((d) => !shape.dirs.has(d));
      eq(missing.length, 0, `执行后骨架不缺目录了（缺的：${missing.join(' / ')}）`);
    });

    await suite.it('报告：`已搬过` 与 `真冲突` 分组写进操作日志，且写明来源与快照', async () => {
      await H.settle(200);
      const logs = H.listFiles(vaultRoot, `${KB}/99_Meta/05_操作日志`).filter((f) => f.includes('移动'));
      ok(logs.length > 0, '写了一条移动日志（重排走的就是 mover）');
      // 认时间戳最大的那条（文件名就是时间序）
      const latest = logs.sort().reverse()[0];
      const text = H.readNote(vaultRoot, `${KB}/99_Meta/05_操作日志/${latest}`);
      contains(text, '库结构重排', '来源写着「库结构重排」');
      contains(text, '## 已搬过', '「已搬过」成组');
      contains(text, '## 真冲突', '「真冲突」成组且写明未覆盖');
      contains(text, '新建目录', '新建了几个目录也要落在报告里（不看报告就没人知道）');
      contains(text, '**快照**', '快照 id 在，事后能还原');
    });

    await suite.it('再点一次执行 = **幂等**（结果相同、不产生第二个库根）', async () => {
      /**
       * ⚠️ 顺序很重要：**幂等要在还原之前验**。
       * 还原之后库回到"错位"那一版 → 预览当然又说"N 篇要搬"，那验的是还原、不是幂等。
       * 幂等的口径（§6 三条机制）：目录已存在就不建；笔记已在位就不排；**没搬成的下一篇还是
       * 「已搬过 / 真冲突」，绝不覆盖** —— 所以第二轮的**盘上结果是零变化**。
       */
      const before2 = digest();
      const isRunBtn = (x: HTMLElement): boolean => /^(开始纠偏|开始归拢|开始初始化|没有要做)/.test(H.textOf(x));
      await H.until(() => H.qa<HTMLElement>(document.body, '.kbw-btn').find(isRunBtn) != null, 3000);
      const runBtn = H.qa<HTMLElement>(document.body, '.kbw-btn').find(isRunBtn);
      ok(runBtn, '面板还在，执行按钮还在');
      H.click(runBtn as Element);
      await H.settle(80);
      const primary = H.qa<HTMLElement>(topModal(), '.kbw-btn').find(
        (b) => H.textOf(b).startsWith('搬这') || H.textOf(b).startsWith('建这'),
      );
      /**
       * ⚠️ 这里**不能写成 `if (primary) { … }`**（独立审查指出的假绿洞）：核心断言
       * "盘上零变化"在"第二轮压根没跑"时是**天然满足**的。硬判据：第二轮要么真开了确认流
       * （点了主按钮），要么面板明确说"没有要做的" —— 两者都不是才红。
       */
      ok(
        primary != null || H.textOf(runBtn as Element).includes('没有要做'),
        `第二轮要么真跑一遍、要么明说"没有要做的"（按钮文案是「${H.textOf(runBtn as Element)}」）`,
      );
      if (primary) {
        // 第一轮没搬成的（丙「已搬过」）还会排进第二轮的计划 —— 这正是"条目级识别"要处理的
        H.click(primary);
        await H.settle(400);
      }
      sameVault(digest(), before2, '第二轮盘上零变化（已搬过的跳过、不覆盖、不产生第二个库根）');
      ok(!fs.existsSync(path.join(vaultRoot, `${KB} 1`)), '没有第二个库根');
      ok(
        !fs.readdirSync(vaultRoot).some((n) => n.startsWith(KB) && n !== KB),
        'vault 根下没有多出「库名1」这类并列库',
      );
      // 新建的目录还在（它们上一轮就建好了，这一轮是"已存在 → 不建"）
      const shape2 = await vaultShapeOf(app as never, KB);
      const sk2 = normalizeSkeleton(await ctx().configs.read('rebuild'));
      eq(sk2.dirs.filter((d) => !shape2.dirs.has(d)).length, 0, '骨架还是齐的');
    });

    /**
     * 🟡1（独立审查）：**确认流开着的时候库变了 → 不执行用户没看过的那份计划**。
     *
     * 为什么这条重要：`plan` 是个会被防抖重画随时替换的模块级变量。没有这道守卫的话，
     * 用户点的是"搬 1 篇"，执行的可能是"搬 3 篇"——**确认流承诺的范围被破防**，
     * 而日志里的 `reason`（旧数）与 `extraRows`（新数）互相矛盾（§6.2 点名的那类错）。
     */
    await suite.it('确认流开着时库变了：不执行「用户没看过的那份计划」', async () => {
      const logsBefore = H.listFiles(vaultRoot, `${KB}/99_Meta/05_操作日志`).length;
      const runBtn = H.qa<HTMLElement>(document.body, '.kbw-btn').find((x) =>
        /^(开始纠偏|开始归拢|开始初始化|没有要做)/.test(H.textOf(x)),
      );
      ok(runBtn, '面板上该有执行按钮');
      H.click(runBtn as Element);
      await H.settle(120);
      const primary = H.qa<HTMLElement>(topModal(), '.kbw-btn').find(
        (b) => H.textOf(b).startsWith('搬这') || H.textOf(b).startsWith('建这'),
      );
      ok(primary, '前提：这一轮有东西可做（确认流开出来了）');

      // **确认流还开着**的时候，库里多了一篇（同步拉进来 / 别处写的 / 索引滞后落定）
      const drift = `${KB}/00_Inbox/${T}新来的.md`;
      H.writeNote(vaultRoot, drift, H.note('新来的'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      await H.settle(500); // 让面板的防抖重画（300ms）跑完

      H.click(primary);
      await H.settle(600);
      // 执行**没有发生**：日志一条没多
      eq(
        H.listFiles(vaultRoot, `${KB}/99_Meta/05_操作日志`).length,
        logsBefore,
        '没有写新的操作日志 —— 说明这一轮**根本没执行**',
      );
      const notices = H.textsOf(document.body, '.kbw-notice').join(' | ');
      contains(notices, '库刚变了', '而且要明确告诉用户"库刚变了，再看一眼"');

      // 收尾：把"新来的"删掉（还原那条要按执行前的清单逐条比）
      const df = app.vault.getAbstractFileByPath(drift);
      if (df) await app.vault.delete(df, true);
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      await H.settle(500);
    });

    await suite.it('还原：逆 rename + 删掉本次新建的目录（库回到执行前）', async () => {
      /**
       * ⚠️ **P7.19 收编**（独立审查 🟡3 指出，与 `migrate.ts` 同一形态）：
       * 原来是 `H.qa(document.body, '.kbw-undobar .kbw-btn.is-primary')[0]` ——
       * **按文档顺序取第一个**，可能命中上一条用例留下的**离场中孤儿条**。
       * 改用 `H.currentUndoButton('撤销')`：取**最后一条且非离场**的。
       */
      const undo = H.currentUndoButton('撤销');
      ok(undo, '执行完该有撤销条（重排这种大动作最需要一键回滚）');
      H.click(undo);
      await H.settle(200);
      ok(await H.until(() => H.exists(vaultRoot, inbox(`${T}甲.md`)), 4000), '甲回到 Inbox');
      ok(H.exists(vaultRoot, inbox(`${T}己.md`)), '己回到 Inbox');
      sameVault(digest(), before, '库回到了执行前（含搬回来的文件、含新建的目录被删掉）');
      const shape = await vaultShapeOf(app as never, KB);
      const nowMissing = normalizeSkeleton(await ctx().configs.read('rebuild')).dirs.filter(
        (d) => !shape.dirs.has(d),
      );
      // 还原后"缺的目录"应当正好是这一轮新建的那些（多一个少一个都说明还原不干净）
      eq(
        nowMissing.slice().sort().join('|'),
        expectCreated.slice().sort().join('|'),
        `还原后缺的目录应当正好是本次新建的（本次新建：${expectCreated.join(' / ')}）`,
      );
    });

    /**
     * 🔴 **"还原不干净"必须说出来**（P5 真机抓到的那条：`adapter.rmdir(dir, false)`
     * 在真机上对目录抛 `ERR_FS_EISDIR` —— 平台的 `FileSystemAdapter.rmdir` 走的是 `fs.rm`，
     * 而 `fs.rm` 删目录**必须** recursive。桩原先用 `fs.rmdirSync`（比真机宽松）→ 这条判据
     * 离线恒绿、真机从来没成过）。这条用例的两半：
     *   ① 目录里被塞了东西 → **不删**（不能顺手把用户刚拖进去的删掉）
     *   ② 而且这件事**必须弹出来**（`RestoreResult.notifications` 原先一处都没显示）
     */
    await suite.it('还原：新建的目录里被塞了东西 → 不删、并且弹出来说清楚', async () => {
      const dirAbs = `${KB}/02_Areas/${T}临时目录`;
      fs.mkdirSync(path.join(vaultRoot, dirAbs), { recursive: true });
      app.vault.rescan();
      const snap = await ctx().snapshot.capture({
        reason: '用例：非空目录不删',
        files: [],
        newDirs: [dirAbs],
      });
      // 塞一篇进去 —— 这时"删掉这个空目录"就不该发生了
      H.writeNote(vaultRoot, `${dirAbs}/有人.md`, H.note('有人'));
      app.vault.rescan();
      await H.settleIndex(app);
      __resetNotices(); // 台面上只留这一条要看的通知（前面用例的通知会挂 6 秒）
      const r = await ctx().snapshot.restore(snap.id);
      await H.settle(80);

      eq(r.dirsRemoved, 0, '有东西的目录不删');
      ok(
        r.problems.some((t) => t.includes('没删')),
        `而且要说出来（实际：${r.problems.join(' / ')}）`,
      );
      const notice = H.textsOf(document.body, '.kbw-notice').join(' | ');
      contains(notice, '还原', '这条"没做到"必须弹给用户看，不能只在返回值里躺着');
      contains(notice, '没做到', '文案要说清是"没做到几项"（不是含糊的"已完成"）');
      eq(H.qa(document.body, '.kbw-notice').length, 1, '只弹这一条（不要调用方再叠一条重复的）');

      /**
       * ⚠️ **正常结果不许报成"没做到"**（独立审查 🟡5）：`keptAside`（挡路的文件挪去了
       * 「还原保留」，那是设计、不是失败）原先和失败项挤在同一个 `notifications` 里 →
       * 一次**完全正常**的还原也会弹"有 1 项没做到"，用户没法判断到底要不要管。
       *
       * 夹具必须**真的造出一次 keptAside**（第一版没造，于是这条判据恒绿 —— 突变测试抓到的）：
       * ① `A` 位蹲着一个"快照里没有"的文件（还原时要给它让路）② `B` 位的文件在快照**之前**就存在
       *（否则会撞上还原①那条"快照之后这里出现了新文件"的守卫，走不到让路那一支）。
       */
      __resetNotices();
      const A = `${KB}/00_Inbox/${T}挡路源.md`;
      const B = `${KB}/02_Areas/灵感杂记/${T}挡路源.md`;
      H.writeNote(vaultRoot, B, H.note('先搬过去的那一篇'));
      H.writeNote(vaultRoot, A, H.note('后来蹲在这个位置的另一篇'));
      app.vault.rescan();
      await H.settleIndex(app);
      const snap2 = await ctx().snapshot.capture({
        reason: '用例：正常项不算没做到',
        files: [],
        moves: [{ from: A, to: B }],
      });
      const r2 = await ctx().snapshot.restore(snap2.id);
      await H.settle(80);
      eq(r2.keptAside.length, 1, '前提：这一次**真的**挪走了一个挡路的文件（否则这条判据验不到东西）');
      eq(
        r2.problems.length,
        0,
        `"挪去还原保留"是正常结果，不算"没做到"（实际 problems：${r2.problems.join(' / ')}）`,
      );
      eq(H.qa(document.body, '.kbw-notice').length, 0, '正常还原不该弹"没做到"');

      // 收尾：把让路挪出来的东西与那个"还原保留"目录一起清掉
      for (const d of fs.readdirSync(path.join(vaultRoot, KB))) {
        if (d.startsWith('还原保留')) fs.rmSync(path.join(vaultRoot, KB, d), { recursive: true, force: true });
      }
      for (const p2 of [A, B]) {
        const f2 = app.vault.getAbstractFileByPath(p2);
        if (f2) await app.vault.delete(f2, true);
      }
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      await ctx().snapshot.remove(snap2.id);

      // 收尾：删掉这一篇与目录，再删这份快照
      const f = app.vault.getAbstractFileByPath(`${dirAbs}/有人.md`);
      if (f) await app.vault.delete(f, true);
      fs.rmSync(path.join(vaultRoot, dirAbs), { recursive: true, force: true });
      app.vault.rescan();
      await ctx().snapshot.remove(snap.id);
    });

    /**
     * 🔴 **搬移之后"视图记忆"里的卡面键要跟着改名走**（e2 留下的那笔，P5 补上）。
     *
     * 为什么这一期必须修：重排是**一次搬几十篇**，而它是从「全部笔记」那边发起的 ——
     * 那一刻看板模块**根本没挂载**，于是看板自己那套 rename 处理不在场，
     * `pendingScroll` 里那些 `card:<板块>:<路径>` 就全成了死键 → 切回看板时整片滚动位置重置
     *（用户会当成"重排把我的位置搞没了"）。修法是把迁移挂到**插件层**（`main.ts` 的 vault rename）。
     *
     * ⚠️ 这条走的是**真链路**：夹具笔记经 `mover` 真搬一次（走平台 rename 事件），
     * 而不是直接调 `remapScrollPath` —— 直接调的话，"有没有接线"这件事**根本没被验**。
     */
    await suite.it('搬移之后卡面的滚动位置跟着改名走（看板没挂载也生效）', async () => {
      const from = inbox(`${T}庚.md`);
      const to = ling(`${T}庚.md`);
      H.writeNote(vaultRoot, from, H.note('庚'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);

      // 假一屏：一个带 `card:<板块>:<路径>` 键的可滚容器（看板卡面正文就是这么贴的）
      clearViewMemory();
      const host = document.createElement('div');
      const scroller = div0();
      scroller.setAttribute(SCROLL_ATTR, `card:sec1:${from}`);
      host.appendChild(scroller);
      document.body.appendChild(host);
      scroller.scrollTop = 137;
      rememberScroll('board', host); // = "在那一列里滚过、然后切走"那一下
      host.remove();

      // 真搬一次（经 mover → 平台 rename 事件 → 插件层的迁移监听）
      const file = app.vault.getAbstractFileByPath(from);
      ok(file, '前提：夹具文件在库里');
      const mv = await ctx().mover.move({
        targets: [{ dir: `${KB}/02_Areas/灵感杂记`, files: [file as never] }],
        source: 'rebuild',
        reason: '视图记忆改名迁移（用例）',
      });
      eq(mv.moved.length, 1, '前提：真搬成了');
      await H.settleIndex(app);

      const host2 = document.createElement('div');
      const scroller2 = div0();
      scroller2.setAttribute(SCROLL_ATTR, `card:sec1:${to}`);
      host2.appendChild(scroller2);
      document.body.appendChild(host2);
      const applied = recallScroll('board', host2);
      const got = scroller2.scrollTop;
      host2.remove();
      clearViewMemory();

      // 收尾：把它搬回去（用的是 mover 自己的快照）
      if (mv.snapshotId) await ctx().snapshot.restore(mv.snapshotId);
      await H.settleIndex(app);

      eq(applied, 1, '认出了**改名后**的那个键（没迁的话它是个死键，认不出来）');
      eq(got, 137, '位置跟着新路径回来了');
    });

    /**
     * 🟡6：计划里有、**进 mover 之前就没了**的文件必须被说出来 ——
     * 日志里"计划搬 N 篇 / 已移动 M 篇"的差额得有人解释（§6.2 点名的最危险的错）。
     */
    await suite.it('计划里的文件在确认期间消失了：不静默丢，报告里要有这一行', async () => {
      const gone = `${KB}/00_Inbox/${T}消失.md`;
      H.writeNote(vaultRoot, gone, H.note('消失'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);

      const move = {
        path: gone,
        from: gone,
        to: `${KB}/02_Areas/灵感杂记/${T}消失.md`,
        dirRel: '02_Areas/灵感杂记',
        why: 'fallback' as const,
        note: '用例',
        locked: false,
      };
      // 执行前把它删掉（模拟"确认流开着的时候被别处删了/改名了"）
      const f = app.vault.getAbstractFileByPath(gone);
      if (f) await app.vault.delete(f, true);
      app.vault.rescan();

      const runRes = await executeRebuild(
        { app: ctx().app, kbRoot: KB, mover: ctx().mover, fm: ctx().fm },
        { ...emptyPlan(), moves: [move] },
        '用例：源文件不在了',
      );
      eq(runRes.result.moved.length, 0, '没搬成（它已经不在原位）');
      ok(
        runRes.warnings.some((t) => t.includes('不在原位')),
        `要说出来（实际 warnings：${runRes.warnings.join(' / ') || '（空）'}）`,
      );
    });

    /**
     * R6（2026-10-06 批注）：原先只有"出事时才弹出来"的情境入口，设置里没有 ——
     * 这里钉"常驻入口在「自动化」栏 + 点开真的到面板"。**命令面板不加**（5 条契约，B5）。
     */
    await suite.it('R6：设置 →「自动化」栏有「库体检」常驻入口，点「打开」就到面板', async () => {
      const h = openSettingsPanel(ctx(), 'automation');
      await H.settle(250);
      const main = H.q<HTMLElement>(document.body, '.kbw-set-main');
      const rowEl = H.qa<HTMLElement>(main, '.kbw-set-row').find((r) =>
        H.textOf(r).includes('库体检'),
      );
      ok(rowEl, '「自动化」栏里有「库体检」那一行');
      const open = H.qa<HTMLElement>(rowEl as Element, '.kbw-btn').find(
        (b) => H.textOf(b) === '打开',
      );
      ok(open, '有「打开」按钮');
      H.click(open as Element);
      ok(
        await H.until(() => H.maybe(document.body, '.kbw-rb') != null, 2000),
        '点开就是「库体检」面板（.kbw-rb 在）',
      );
      /**
       * 清场：**先关自己开的那扇面板、再关设置** —— 两处都容易关错，写清楚：
       * ① 组内前面还开着**另一扇**库体检面板（本组的"打开面板"那条留着的，由清场用例收）——
       *    所以要关的是 `.kbw-modal` 里含 `.kbw-rb` 的**最后一扇**（最上面那扇 = 我刚开的）；
       * ② 按"第一个带「关闭」的底栏按钮"找更不行（设置那扇在前）。
       * 2026-10-06 全量实测：第一版按第一个找，两扇都留着 → 后面整串 spec 的 `topModal()`
       * 全拿到库体检面板（真机链 / 美化笔记 / 教程中心的 Enter 连环假红）。
       */
      const rbModals = H.qa<HTMLElement>(document.body, '.kbw-modal').filter(
        (m) => H.maybe(m, '.kbw-rb') != null,
      );
      ok(rbModals.length > 0, '找得到库体检面板（含组内早先那扇）');
      const beforeN = rbModals.length;
      const rbModal = rbModals[beforeN - 1];
      const rbClose = H.qa<HTMLElement>(rbModal, '.kbw-modal-foot .kbw-btn').find(
        (b) => H.textOf(b) === '关闭',
      );
      ok(rbClose, '库体检面板底栏有「关闭」');
      H.click(rbClose as Element);
      await H.settle(80);
      h.close('test');
      await H.settle(80);
      // 自证：**我开的这扇**关了（组内早先那扇归"清场"用例收，不在这一条的账上）
      const afterN = H.qa<HTMLElement>(document.body, '.kbw-modal').filter(
        (m) => H.maybe(m, '.kbw-rb') != null,
      ).length;
      eq(afterN, beforeN - 1, '自己开的库体检面板关掉了（别留给下一个 spec）');
      eq(H.maybe(document.body, '.kbw-set-main'), null, '设置面板关掉了（不留 DOM）');
    });

    await suite.it('清场：夹具笔记删掉，库回到这一段开工前的样子', async () => {
      panel?.close('test');
      await H.settle(50);
      // 认标记清场（**不靠"跟开工前 diff"**）—— 它可能被搬到任何目录里，所以按整库找
      for (const rel of H.listFiles(vaultRoot, KB).filter((f) => f.includes(T))) {
        const f = app.vault.getAbstractFileByPath(`${KB}/${rel}`);
        if (f) await app.vault.delete(f, true);
      }
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      const left = H.listFiles(vaultRoot, KB).filter((f) => f.includes(T));
      eq(left.length, 0, `自己造的夹具一个不剩（还剩：${left.join('、')}）`);
    });
  });
}

// ════════════════════════════════════════════════════════════════
// 纯函数层的夹具（不碰真库）
// ════════════════════════════════════════════════════════════════
const BASE_DIRS = [
  '00_Inbox',
  '01_Projects',
  '02_Areas',
  '02_Areas/内容创作',
  '02_Areas/灵感杂记',
  '03_Resources',
  '04_Archives',
  '99_Meta',
  '99_Meta/05_操作日志',
];

function skel(over: Partial<Skeleton> = {}): Skeleton {
  return normalizeSkeleton({
    version: 1,
    rootName: '01_新知识库',
    dirs: BASE_DIRS,
    seedFiles: ['00_Inbox/_收件箱.md'],
    excludedTop: ['.obsidian', '.trash', '02_旧知识库'],
    ...over,
  });
}

function noteOf(
  rel: string,
  opts: { declared?: string[]; type?: string; locked?: boolean; isTemplate?: boolean } = {},
): RebuildNote {
  const i = rel.lastIndexOf('/');
  return {
    path: `${KB}/${rel}`,
    basename: rel.slice(i + 1).replace(/\.md$/, ''),
    dir: i < 0 ? '' : rel.slice(0, i),
    declared: opts.declared ?? [],
    type: opts.type ?? '笔记',
    // ⚠️ 模板判定由**索引**算（`T_` 前缀 / 在模板目录下），测试直接给 —— 这一处夹具与实现不同源
    isTemplate: opts.isTemplate ?? false,
    locked: opts.locked ?? false,
  };
}

function inputOf(notes: RebuildNote[], over: Partial<RebuildPlanInput> = {}): RebuildPlanInput {
  return {
    skeleton: skel(),
    kbRoot: KB,
    metaDir: '99_Meta',
    // ⚠️ `04_Archives/旧资料` 故意**不在骨架里**（真实骨架的 `04_Archives` 没有子目录）——
    // 它就是"骨架外、保留"那条的样本，所以只进 existingDirs
    existingDirs: new Set(['', ...BASE_DIRS, '04_Archives/旧资料']),
    exists: (rel) => rel === '00_Inbox/_收件箱.md',
    notes,
    // v2：没有信号的 Inbox 笔记只去「兜底目录」（原先的 areaDirs 别名映射已删）
    fallbackDir: '02_Areas',
    ...over,
  };
}

function move(from: string, dirRel: string): RebuildMove {
  return {
    path: `${KB}/${from}`,
    from: `${KB}/${from}`,
    to: `${KB}/${dirRel}/${from.split('/').pop()}`,
    dirRel,
    why: 'declared',
    note: '',
    locked: false,
  };
}

function findNode(root: RebuildNode, rel: string): RebuildNode | null {
  if (root.rel === rel) return root;
  for (const c of root.children) {
    const hit = findNode(c, rel);
    if (hit) return hit;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
// 真链路的夹具与工具
// ════════════════════════════════════════════════════════════════
/**
 * 造一份"错位"的夹具（v2 口径）：
 *   甲  Inbox 没声明（没信号）           → 兜底搬进 02_Areas（路由表「领域兜底」）
 *   乙  Inbox 声明指向一个不存在的目录    → 待定（不猜）
 *   丙  Inbox 声明=灵感杂记，目标已有一份**同内容**的 → 已搬过（跳过，不覆盖）
 *   丁  Inbox 声明=灵感杂记，目标已有一份**不同内容**的 → 真冲突（blocked）
 *   己  Inbox 没声明、设了位置锁定        → 照搬（锁只挡自动…v2 里连自动也不挡了，这里走的是重排=手动）+ 确认流里要说出来
 * 另外一篇放在归档区（戊）验"兜底只在 Inbox"。
 */
function writeFixture(vaultRoot: string): void {
  const at = (rel: string): string => `${KB}/${rel}`;
  H.writeNote(vaultRoot, at(`00_Inbox/${T}甲.md`), H.note('甲'));
  H.writeNote(
    vaultRoot,
    at(`00_Inbox/${T}乙.md`),
    H.note('乙', {}, { 位置: ['99_查无此目录'] }),
  );
  const bingText = H.note('丙', {}, { 位置: ['02_Areas/灵感杂记'] });
  H.writeNote(vaultRoot, at(`00_Inbox/${T}丙.md`), bingText);
  H.writeNote(vaultRoot, at(`02_Areas/灵感杂记/${T}丙.md`), bingText); // 同内容 → 已搬过
  H.writeNote(
    vaultRoot,
    at(`00_Inbox/${T}丁.md`),
    H.note('丁', {}, { 位置: ['02_Areas/灵感杂记'] }),
  );
  H.writeNote(vaultRoot, at(`02_Areas/灵感杂记/${T}丁.md`), H.note('丁（库里原来就有的另一篇）'));
  H.writeNote(
    vaultRoot,
    at(`00_Inbox/${T}己.md`),
    H.note('己', { 位置锁定: true }),
  );
  // 归档区里"没声明"的：不该被兜底搬走（判据②的范围）
  H.writeNote(vaultRoot, at(`04_Archives/旧资料/${T}戊.md`), H.note('戊'));
}

/** 库的摘要（相对路径 → sha256）。**排除日志目录**：执行会新写日志，而日志不该被还原动。 */
function vaultDigest(vaultRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = path.join(vaultRoot, KB);
  const walk = (dir: string, prefix: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) {
        if (rel === '99_Meta/05_操作日志') continue;
        walk(path.join(dir, e.name), `${rel}/`);
      } else {
        const buf = fs.readFileSync(path.join(dir, e.name));
        out.set(rel, crypto.createHash('sha256').update(buf).digest('hex'));
      }
    }
  };
  walk(root, '');
  return out;
}

function digestOf(m: Map<string, string>): string {
  return Array.from(m, ([k, v]) => `${k}:${v}`).sort().join('\n');
}

/** 只报差异（断言失败时看得见"哪几个文件不一样"，不然只有一坨哈希） */
function countDiff(a: Map<string, string>, b: Map<string, string>): string {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out: string[] = [];
  for (const k of keys) {
    if (a.get(k) !== b.get(k)) out.push(`${k}（${a.has(k) ? '' : '新'}${b.has(k) ? '' : '缺'}）`);
  }
  return out.slice(0, 6).join('、');
}

/**
 * 比两份库摘要。⚠️ 失败时**必须说出是哪几个文件不一样** ——
 * 只比两个哈希串的话，红了之后还得自己去 diff 才知道是"没还原"还是"多了个目录"。
 */
function sameVault(a: Map<string, string>, b: Map<string, string>, msg: string): void {
  if (digestOf(a) === digestOf(b)) return;
  throw new Error(`${msg}：以下文件不一样 → ${countDiff(a, b)}`);
}

/** 面板脚上的按钮（按可见文案找） */
function panelBtn(match: string): HTMLElement {
  const all = H.qa<HTMLElement>(document.body, '.kbw-btn');
  const hit = all.find((b) => H.textOf(b).includes(match));
  ok(hit, `面板上该有「${match}」按钮`);
  return hit as HTMLElement;
}

/** 一份"什么都没算出来"的计划壳（用例只要 moves 那一栏时用） */
function emptyPlan(): Parameters<typeof executeRebuild>[1] {
  return {
    skeleton: skel(),
    newDirs: [],
    keptDirs: [],
    extraDirs: [],
    moves: [],
    pending: [],
    seedMissing: [],
    seedPresent: [],
    undeclared: [],
    rootMismatch: null,
  };
}

/** 造一个可滚容器（jsdom 里 scrollTop 可写；真机上是 `.kbw-card-body` 那种） */
function div0(): HTMLElement {
  return document.createElement('div');
}

function topModal(): HTMLElement {
  const all = H.qa<HTMLElement>(document.body, '.kbw-modal');
  const last = all[all.length - 1];
  ok(last, '该有模态在屏幕上');
  return last;
}
