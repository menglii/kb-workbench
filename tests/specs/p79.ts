/**
 * spec：**P7.9 · 用户反馈批**（2026-10-05）——四件手感件 / 界面的回归判据
 *
 * 自造库（`makeTempVault('p79')`）—— 会真造 / 真搬 / 真删几篇 `__p79*` 夹具（每条自己收），
 * 与 p78 同一条纪律。动库那两条（⑤ 一键整理）走真确认流 + 快照，跑完手工清场。
 *
 * 覆盖面（判据与轮次条目的对应）：
 *   · ③ 悬停提示：点击即取消 dwell，跨过 600ms 不再冒；重新悬停照常出
 *   · ④ 跳转回头路：`goNotes({dir, selectAll})` → 批量栏出现「还原」→ 点击回默认态
 *     （目录回库根 + 清选中；用户自己点目录后口子消失）
 *   · ⑤ 一键整理：结构性笔记不进计划也不进 pending；播报单句；其余 pending 的
 *     why 是「原因 → 出路」（句式判据在 rebuild.ts 组同名断言，这里盯集成面）
 *   · ⑥ 整理建议极简：副标题已删 · 没有「拦下」行 · 来源压成菜单（关掉规则 → 行消失）·
 *     关联提示折叠（有对子时）· 刷新是图标按钮 · 「✦ AI 分类」是正式按钮且排执行按钮前
 *   · ② 新建笔记：三行零小字 ·「笔记位置」·「＋ 新建模板…」落 `T_` 文件并选中 ·
 *     条件警告（补全关着 → "不会生效"）
 *
 * ⚠️ 清场纪律（跨用例污染是本项目栽得最多的那一类）：自造文件、`completion` 开关、
 * 面板 / 菜单 —— 每条 finally 里原值归还。
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
import { openNewNoteDialog } from '../../src/ui/new-note';
import { runInboxTidy } from '../../src/modules/home/tidy';
import { pendingLineOf } from '../../src/services/rebuild';

const KB = '01_新知识库';
const TPL_DIR = `${KB}/99_Meta/02_模板库/Templater`;

export async function specP79(
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

  // ════════════════════════════════════════════════════════════
  // ③ 悬停提示：点击即取消（用户复现的缺陷）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.9 · ③ 快捷按钮的悬停提示', async () => {
    await suite.it('点击即取消计时：进按钮 250ms 内点一下 → 跨过 600ms 不再冒；重新悬停照常出', async () => {
      closeAllMenus();
      await ensureHome();
      const btn = H.qa<HTMLElement>(document.body, '.kbw-qbtn').find((b) =>
        H.textOf(b).includes('整理收件箱'),
      );
      ok(btn, '前提：首页四钮在');
      const panels = (): number => H.qa(document.body, '.kbw-panel').length;
      const enter = (el: HTMLElement): void => {
        el.dispatchEvent(H.pointerEvent('pointerenter', { x: 5, y: 5, pointerType: 'mouse' }));
      };
      const down = (el: HTMLElement): void => {
        el.dispatchEvent(H.pointerEvent('pointerdown', { x: 5, y: 5, pointerType: 'mouse' }));
      };
      const leave = (el: HTMLElement): void => {
        el.dispatchEvent(H.pointerEvent('pointerleave', { x: 200, y: 200, pointerType: 'mouse' }));
      };
      try {
        eq(panels(), 0, '起手没有浮层');
        enter(btn as HTMLElement);
        await H.settle(250); // 不足 dwell（600ms）
        eq(panels(), 0, '停留不足不出（对照）');
        down(btn as HTMLElement); // 用户点了一下（浮层的"点外面关"会收掉已开的那扇）
        await H.settle(700); // 跨过 dwell
        eq(panels(), 0, '点击之后跨过 600ms 不再冒（③ 的核心断言 —— 旧实现这里会冒出半截提示）');
        /**
         * 取消不是把功能关掉：先离开、再重新悬停（**新的 pointerenter**）照常出。
         */
        leave(btn as HTMLElement);
        await H.settle(320);
        enter(btn as HTMLElement);
        await H.settle(750);
        eq(panels(), 1, '重新悬停（离开再回）照常出提示');
        leave(btn as HTMLElement);
        await H.settle(400);
        eq(panels(), 0, '移开关掉');
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑦b 历史抽屉的「＋ 新建对话」（用户原话：没找到入口）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.9 · ⑦b 助手历史抽屉', async () => {
    await suite.it('抽屉顶部「＋ 新建对话」：点了清屏开新段（抽屉收起、面板还在）', async () => {
      closeAllMenus();
      try {
        ctx().openAi();
        const panel = await untilEl(() =>
          H.qa<HTMLElement>(document.body, '.kbw-modal').find((m) =>
            H.textOf(m).includes('经纬助手'),
          ),
        );
        ok(panel, 'AI 面板开了');
        // R4 起「历史对话」收进头部「⋯」菜单（图标不再单列；行为不变）
        ok(H.maybe<HTMLElement>(panel!, '.kbw-ai-morebtn'), '头部有「⋯」（历史对话收在这里）');
        H.click(H.q<HTMLElement>(panel!, '.kbw-ai-morebtn'));
        await H.settle(30);
        H.click(
          H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
            H.textOf(i).includes('历史对话'),
          ) as HTMLElement,
        );
        const drawer = await untilEl(() => H.maybe<HTMLElement>(panel!, '.kbw-ai-drawer'));
        ok(drawer, '抽屉开出来了');
        const newBtn = H
          .qa<HTMLElement>(drawer!, '.kbw-btn')
          .find((b) => H.textOf(b).includes('新建对话'));
        ok(newBtn, '抽屉顶部有「＋ 新建对话」（P7.9 · ⑦b）');
        H.click(newBtn as Element);
        await H.settle(250);
        ok(!H.maybe(panel!, '.kbw-ai-drawer'), '点了之后抽屉收起（走的是既有 newChat）');
        ok(H.maybe(panel!, '.kbw-ai-log'), '对话区还在（面板没被关掉）');
        H.keydown(document.body, 'Escape');
        await H.settle(120);
      } finally {
        /**
         * 模态**一层层收干净**（全量跑时这是下一组用例的前提 —— 留一扇板子的话，
         * 后面那组的 Esc 会被它先吃掉；第一版就是这一条把 ④ 的"清预选中"顶掉的）。
         */
        for (let i = 0; i < 3 && H.qa(document.body, '.kbw-modal').length > 0; i += 1) {
          H.keydown(document.body, 'Escape');
          await H.settle(150);
        }
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ④ 跳转回头路：带目录的跳转也有「还原」（用户复现：jumpRestoreButton=null）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.9 · ④ 跳转后的「还原」', async () => {
    await suite.it('goNotes({dir, selectAll}) → 批量栏出现「还原」→ 点击：目录回库根 + 清预选中', async () => {
      closeAllMenus();
      const restore = (): HTMLElement | undefined =>
        H
          .qa<HTMLElement>(document.body, '.kbw-batch-tail .kbw-btn, .kbw-notes-tools .kbw-btn')
          .find((b) => H.textOf(b) === '还原');
      try {
        // ⚠️ 起手先激活工作台（子集跑时前一条用例可能被跳过 —— 不激活就切不到模块，跳转落空）
        await ensureHome();
        ctx().goNotes({ dir: '00_Inbox', selectAll: true });
        await H.settle(300);
        ok(H.maybe(document.body, '.kbw-notes-bar.is-batch'), '全选跳转 → 批量栏在');
        ok(
          restore(),
          '带目录的跳转也有「还原」（旧实现这里查不到 —— 用户复现 jumpRestoreButton=null）：' +
            H.textsOf(document.body, '.kbw-batch-tail .kbw-btn').join(' | '),
        );
        const title = restore()?.getAttribute('title') ?? '';
        contains(title, '目录', 'title 说清会把目录一起收掉');
        H.click(restore() as Element);
        await H.settle(250);
        ok(!H.maybe(document.body, '.kbw-notes-bar.is-batch'), '预选中清了（工具条回来）');
        ok(!restore(), '还原之后口子自己消失');
        await H.until(() => ctx().settings.get().treeSelected === '', 1500);
        eq(ctx().settings.get().treeSelected, '', '目录回库根（落盘也跟上了）');

        // 再来一次，用户自己点别的目录 → 一次性清单到此为止（与 A3 同一规则）
        ctx().goNotes({ dir: '00_Inbox', selectAll: true });
        await H.settle(300);
        ok(restore(), '再跳一次，口子又回来了');
        // ⚠️ 行的 textContent 带折叠箭头（'▸02_Areas · N 篇'）—— 认名字那一格，别 startsWith 整行
        const node = H
          .qa<HTMLElement>(document.body, '.kbw-tree-item')
          .find((n) => H.textOf(H.q<HTMLElement>(n, '.kbw-tree-name')) === '02_Areas');
        ok(node, '前提：树上有 02_Areas');
        H.click(node as Element);
        await H.settle(250);
        ok(!restore(), '用户自己点了别的目录 → 还原口子消失（判据：现在生效的目录不是跳转给的那份了）');

        /**
         * 🔴 **独立审 🔴2 回归**：用户**自己设的筛选**出现之后，口子也要消失 ——
         * 目录跳转没带筛选，"基准 = 空筛选"：他设过了就说明动过，按钮留着会把他的筛选一并抹掉
         *（title / 规格都写着"你自己动过之后它自动消失"）。
         */
        ctx().goNotes({ dir: '00_Inbox', selectAll: true });
        await H.settle(300);
        ok(restore(), '第三次跳转，口子又在（下一条的前提）');
        /**
         * 清预选中 → 工具条回来（「筛选」在它里面）。
         * ⚠️ 用**批量栏的 ✕**（`iconBtn('x','清空选择（Esc）')`），别用模拟 Esc ——
         * 全量跑时 Esc 可能先被别的层吃掉（上一组用例的模态 / 面板），点 ✕ 是同步的
         *（与坑单"清选择点批量栏的 ✕"同一条）。
         */
        const xBtn = H
          .qa<HTMLElement>(document.body, '.kbw-notes-bar.is-batch .kbw-iconbtn')
          .find((b) => (b.getAttribute('aria-label') ?? '').includes('清空选择'));
        ok(xBtn, '批量栏上有「清空选择」的 ✕');
        H.click(xBtn as Element);
        await H.settle(300);
        ok(!H.maybe(document.body, '.kbw-notes-bar.is-batch'), '✕ 之后批量栏收了（工具条回来）');
        const openFilters = async (): Promise<HTMLElement | null> => {
          const fb = H
            .qa<HTMLElement>(document.body, '.kbw-notes-tools .kbw-btn')
            .find((b) => H.textOf(b).startsWith('筛选'));
          if (!fb) return null;
          H.click(fb);
          await H.settle(160);
          return H.maybe<HTMLElement>(document.body, '.kbw-panel');
        };
        const pnl = await openFilters();
        ok(pnl, '「筛选」面板开得出来');
        const chip = H
          .qa<HTMLElement>(pnl!, '.kbw-chip.is-pickable')
          .find((c) => H.textOf(c) === '只看隐藏');
        ok(chip, '筛选面板里有「只看隐藏」（借它当"用户自己设的筛选"）');
        H.click(chip as Element);
        await H.settle(200);
        H.keydown(document.body, 'Escape');
        await H.settle(200);
        ok(
          !restore(),
          '🔴 用户自己设过筛选 → 口子消失（独立审 🔴2：不许把他的筛选留着、又被"还原"抹掉）',
        );
        // 收尾：把那条筛选点掉（别把非空筛选留给后面的用例）
        const pnl2 = await openFilters();
        const chip2 = pnl2
          ? H.qa<HTMLElement>(pnl2, '.kbw-chip.is-pickable').find((c) => H.textOf(c) === '只看隐藏')
          : null;
        if (chip2 && chip2.classList.contains('is-on')) H.click(chip2);
        await H.settle(160);
        H.keydown(document.body, 'Escape');
        await H.settle(160);
      } finally {
        closeAllMenus();
        await ctx().settings.save({ treeSelected: '' });
        await H.settle(120);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑤ 一键整理：结构性笔记排除 + 单句播报（真确认流）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.9 · ⑤ 一键自动整理的反馈', async () => {
    await suite.it('结构性笔记不参与（不进计划也不进 pending）· 播报单句 · 其余照旧能搬', async () => {
      closeAllMenus();
      __resetNotices();
      __resetUndo();
      const CENTER = '00_Inbox/__p79中心.md';
      const MOVABLE = '00_Inbox/__p79可搬.md';
      /** ⚠️ `H.exists` / `readNote` 收的是**带 KB 前缀的 vault 相对路径**；`rmFix` 收相对库根（别混） */
      const MOVED_REL = '02_Areas/__p79可搬.md';
      const MOVED = `${KB}/${MOVED_REL}`;
      /**
       * 中心页：`类型: 索引`（v2：中心页收拢为索引） + 一条**指向不存在目录**的陈旧声明 ——
       * 旧逻辑下这条正是用户看到的"声明的位置既不在骨架里、库里也没有"噪音源
       *（真机上的 `_收件箱.md` 同款形状）。
       */
      writeFix(CENTER, '---\n类型: 索引\n文件位置:\n  - 04_Archives/不存在的地方\n---\n\n# 中心\n');
      writeFix(MOVABLE, '---\n类型: 笔记\n---\n\n正文\n');
      // ⚠️ 属性要等 metadataCache 落定（不等的话计划读到的类型是空的 → 结构性判定拿不准）
      await H.settleIndex(app);
      try {
        void runInboxTidy(ctx());
        const cfm = await untilEl(() => {
          const m = H.qa<HTMLElement>(document.body, '.kbw-modal').find((x) =>
            H.textOf(x).includes('即将整理收件箱'),
          );
          return m ?? null;
        });
        ok(cfm, '确认流弹出来了（有可搬的）');
        const cfmText = H.textOf(cfm!);
        contains(cfmText, '结构性笔记不参与整理', '播报**单句**（P7.9 · ⑤-①）');
        ok(!cfmText.includes('__p79中心'), '结构性笔记不进 warnings（不再逐篇给噪音理由）');
        const warnText = H.textOf(H.maybe<HTMLElement>(cfm!, '.kbw-msg.is-warn'));
        ok(!warnText.includes('__p79中心'), 'warnings 里也没有它');
        const primary = H.q<HTMLElement>(cfm!, '.kbw-modal-foot .kbw-btn.is-primary');
        ok(primary, '有执行按钮');
        H.click(primary);
        await H.until(() => H.exists(vaultRoot, MOVED), 3000);
        ok(
          H.exists(vaultRoot, MOVED),
          '可搬的那篇真搬走了（排除只挡结构性笔记，不挡正常整理）—— 现场：' +
            `确认框「${cfmText.replace(/\s+/g, ' ').slice(0, 220)}」 · ` +
            `老位置还在=${H.exists(vaultRoot, MOVABLE)} · ` +
            `内容创作里现有=${(() => {
              try {
                return fs
                  .readdirSync(path.join(vaultRoot, KB, '02_Areas/内容创作'))
                  .filter((f) => f.includes('p79'))
                  .join(',') || '（没有 p79*）';
              } catch {
                return '（目录不在）';
              }
            })()}`,
        );
        ok(!H.exists(vaultRoot, MOVABLE), '老位置没了（成对判）');
        contains(H.readNote(vaultRoot, MOVED), '02_Areas', '搬完照旧补「文件位置」（v2：兜底目录的落点）');
      } finally {
        // 收尾：关模态/撤销条 + 清场（搬走的那篇也删掉，避免留下 02_Areas 里的孤儿）
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        rmFix([CENTER, MOVABLE, MOVED_REL]);
        __resetUndo();
        __resetNotices();
      }
    });

    await suite.it('pending 的 why 是「原因 → 出路」句式（与分组行同源 —— pendingLineOf）', () => {
      contains(pendingLineOf('missing-dir', 2), '「文件位置」指向不存在的目录', '分组行 = 原因');
      contains(pendingLineOf('missing-dir', 2), '先建那个目录', '分组行 = 出路');
      contains(pendingLineOf('no-fallback', 1), '又没配「兜底目录」', 'v2：没有信号 + 没配兜底那类');
      contains(pendingLineOf('missing-dir', 2), '2 篇', '带篇数');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑥ 整理建议面板（P7.11 · #12：选择题重构）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.11 · #12 整理建议面板（选择题版）', async () => {
    await suite.it('四选一（默认 A）· 两个动作 · 零说明 · 关掉「规则」建议撤掉 · C 类的 AI 跳命中 classifyMoc', async () => {
      closeAllMenus();
      /**
       * 造一张**没有「自动索引」节**的《知识地图》—— 这是真机探针抓到过的那条回归的形状：
       * 规则源对它恒 0 条，而「AI 选节」正是它唯一的挂链入口（AI 从现有 H2 里挑）。
       * P7.11 · #12 起这个入口 = C 类底部的「AI 自动去做」。
       */
      const MOC = '99_Meta/04_索引与地图/MOC_知识地图.md';
      writeFix(MOC, '# 知识地图\n\n## 🌐 区域入口\n- 留白\n\n## 🧭 笔记流转\n- 留白\n');
      /**
       * ⚠️ 自备一篇**会出 A 类行**的夹具：全量跑里这一步的**上一条用例（⑤ 一键整理）**
       * 已经把收件箱里可搬的笔记都真搬走了（它点的是整批确认）—— 不再自己造的话
       * 「前提：A 类有行」当场假红（子集跑顺序不同、反而看不到）。
       */
      const FIX_A = '00_Inbox/__p79行数.md';
      writeFix(FIX_A, '---\n类型: 想法\n领域: 灵感杂记\n---\n\n探针造的（p79 行数），用完会删。\n');
      await H.settleIndex(app);
      const ai0 = ctx().settings.get().ai;
      try {
        await ctx().settings.save({
          ai: { ...ai0, baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'test-key' },
        });
        await H.settle(60);
        H.resetAi();
        /**
         * 挑一篇**真实候选**（MOC 的候选 = 未挂过、非模板、非 Meta 的笔记）给假模型用 ——
         * 用索引现取，别写死（夹具会漂）。
         */
        const candRel = ((): string => {
          const kbRoot = ctx().settings.kbRoot();
          const e = ctx()
            .index.notes()
            .find((x) => !x.isTemplate && !x.path.startsWith(`${kbRoot}/99_Meta/`));
          return e ? e.path.slice(kbRoot.length + 1) : '';
        })();
        ok(candRel !== '', '前提：有可用的 MOC 候选（非 Meta 的笔记）');
        const stub = H.stubAi({ ideas: [{ path: candRel, to: '🌐 区域入口', why: '用例假模型' }] });
        const h = openSuggestPanel(ctx(), { scope: '00_Inbox' });
        // 等本地源算完（四选一画出来 = 算完了）
        const choice = await untilEl(() => h.body.querySelector<HTMLElement>('.kbw-suggest-choice'), 4000);
        ok(choice, '面板算完了（四选一在）');
        eq(H.qa<HTMLElement>(h.body, '.kbw-modal-sub').length, 0, '副标题整句删除（P7.9 · ⑥ 口径照旧）');
        ok(!H.textOf(h.body).includes('拦下'), '「拦下 N 条」不摆一行（进悬停）');
        ok(
          H.qa<HTMLElement>(h.body, '.kbw-suggest-head .kbw-iconbtn').some(
            (b) => (b.getAttribute('aria-label') ?? '').includes('刷新'),
          ),
          '刷新缩成小图标按钮',
        );
        // ① 四选一：A/B/C/D 纵横排列，默认 A
        const opts = H.qa<HTMLElement>(h.body, '.kbw-suggest-opt');
        eq(opts.length, 4, '四选一（A 搬笔记 / B YAML 头 / C 结尾双链 / D 我全都要）');
        eq(
          opts.map((o) => H.textOf(o)).join('|'),
          'A ·搬笔记建议|B ·YAML 头建议|C ·结尾双链建议|D ·我全都要',
          '四项文案与顺序逐字（R1：键徽标带「 · 」—— 去圆点后的新形态）',
        );
        ok(opts[0].classList.contains('is-on'), '默认选 A（搬笔记是主路径）');
        // ② 底部两个动作：自己去整理 / AI 自动去做
        const bar = await untilEl(() => h.body.querySelector<HTMLElement>('.kbw-suggest-bar'), 2000);
        ok(bar, '按钮条在');
        const btnTexts = H.qa<HTMLElement>(bar as HTMLElement, '.kbw-btn').map((b) => H.textOf(b));
        eq(btnTexts.join('/'), '自己去整理/AI 自动去做', '两个动作逐字');
        // ③「选 A 只出 A 类行」：A 类视图里没有 B/C 类行的印记
        const rowCount = (): number => H.qa<HTMLElement>(h.body, '.kbw-suggest-row').length;
        const beforeA = rowCount();
        ok(beforeA > 0, `前提：A 类有行（${beforeA}）`);
        ok(!H.textOf(h.body).includes('缺「文件位置」'), 'A 类视图里没有 B 类（YAML 头）的行');
        // ④ 来源菜单：关掉「规则」→ A 类行整体撤掉（菜单真的接线了；multi 行点了不关窗）
        const srcBtn = H.q<HTMLElement>(h.body, '.kbw-suggest-srcbtn');
        ok(srcBtn, '来源开关压成了一枚「来源」按钮');
        H.click(srcBtn);
        const menu = await untilEl(() => {
          const m = H.qa<HTMLElement>(document.body, '.kbw-menu').pop();
          return m && H.textOf(m).includes('规则') && H.textOf(m).includes('学过往') ? m : null;
        });
        ok(menu, '菜单里有 规则 / 学过往 两个开关');
        const ruleRow = H
          .qa<HTMLElement>(menu as HTMLElement, '.kbw-menu-item')
          .find((r) => H.textOf(r).includes('规则'));
        ok(ruleRow, '找得到「规则」那一行');
        H.click(ruleRow as Element);
        await H.until(() => rowCount() < beforeA, 2000);
        ok(rowCount() < beforeA, `关掉「规则」→ A 类行撤掉（${beforeA} → ${rowCount()}）`);
        // 同一扇菜单里再点一次关回来（multi 行 stay —— 菜单不会自己收）
        H.click(ruleRow as Element);
        await H.until(() => rowCount() === beforeA, 2000);
        ok(rowCount() === beforeA, '再点一次 → 规则行回来（菜单两次都接上了）');
        closeAllMenus();
        // ⑤ 切 C 类 → 「AI 自动去做」命中 classifyMoc（替身计一次调用）→ AI 选节行进清单
        const optOf = (key: string): HTMLElement =>
          H.qa<HTMLElement>(h.body, '.kbw-suggest-opt').find((o) => o.dataset.cls === key) as HTMLElement;
        H.click(optOf('C'));
        await untilEl(() => H.maybe<HTMLElement>(h.body, '.kbw-suggest-opt.is-on[data-cls="C"]'), 2500);
        const caiBtn = await untilEl(
          () =>
            H.qa<HTMLElement>(h.body, '.kbw-suggest-bar .kbw-btn').find(
              (b) => H.textOf(b).includes('AI 自动去做'),
            ) ?? null,
          2000,
        );
        ok(caiBtn, 'C 类的「AI 自动去做」在（MOC 页无「自动索引」节也照常 —— 段的有无跟页面走）');
        H.click(caiBtn as Element);
        const aiRow = await untilEl(
          () =>
            H.qa<HTMLElement>(h.body, '.kbw-suggest-row').find(
              (r) => H.textOf(r).includes('区域入口') && !!r.querySelector('.kbw-suggest-src.is-ai'),
            ) ?? null,
          4000,
        );
        ok(
          aiRow,
          'AI 选节落了（classifyMoc 替身被调）—— 现场：调用 ' +
            `${stub.calls.length} 次 · 行：` +
            H.qa<HTMLElement>(h.body, '.kbw-suggest-row').map((r) => H.textOf(r)).join(' || '),
        );
        ok(stub.calls.length >= 1, '假模型真的被叫了一次（classifyMoc 那条路）');
        /**
         * ⑥ 关键回归（突变咬合点）：**B 类的数据加载之后，切回 A 仍然只出搬类行**。
         * ⚠️ 第一版在这里留过洞：A 视图的"没有 B 类行"在**懒算数据还没加载**时两边都恒真
         *（突变 `kindsOf('A')` 返回全部类别照样绿）。先把 B 的现算拉起来，再切回 A 判。
         */
        H.keydown(document.body, 'Escape'); // 先收掉上面可能叠着的确认流
        await H.settle(120);
        H.click(optOf('B'));
        await untilEl(
          () =>
            H.qa<HTMLElement>(h.body, '.kbw-suggest-row').find((r) =>
              H.textOf(r).includes('缺「文件位置」'),
            ) ?? null,
          4000,
        );
        ok(
          H.qa<HTMLElement>(h.body, '.kbw-suggest-row').some((r) => H.textOf(r).includes('缺「文件位置」')),
          'B 类加载出「缺「文件位置」」行（前提：现算数据真的拉起来了）',
        );
        H.click(optOf('A'));
        await H.settle(150);
        ok(
          !H.textOf(h.body).includes('缺「文件位置」'),
          '切回 A 之后**没有** B 类的行（选 A 只出 A 类 —— 数据已加载，不是恒真）',
        );
        ok(rowCount() > 0, `A 类行回来了（${rowCount()} 行）`);
        // 关联提示：只摆折叠行，点开才画对子（对子数看夹具，有才对）
        const fold = H.maybe<HTMLElement>(h.body, '.kbw-suggest-fold');
        if (fold) {
          contains(H.textOf(fold), '对', '折叠行写着「关联提示 · N 对」');
          ok(!H.maybe(h.body, '.kbw-suggest-pair'), '默认收起（只摆折叠行 —— 它是开关不是说明）');
          H.click(fold);
          await H.settle(80);
          ok(H.qa<HTMLElement>(h.body, '.kbw-suggest-pair').length > 0, '展开后画出对子');
        }
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        h.close('test');
        await H.settle(80);
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        H.resetAi();
        rmFix([MOC, FIX_A]); // 造的《知识地图》与行数夹具收走（别留给后面的用例）
        await ctx().settings.save({ ai: ai0 });
        await H.settle(60);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 新建笔记（极简 + 「＋ 新建模板…」+ 条件警告）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.9 · ② 新建笔记对话框', async () => {
    await suite.it('三行零小字 ·「笔记位置」· 常态无警告', async () => {
      closeAllMenus();
      try {
        openNewNoteDialog(ctx());
        await H.settle(80);
        const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
        eq(H.qa<HTMLElement>(modal, '.kbw-modal-sub').length, 0, '子标题已删');
        eq(
          H.textsOf(modal, '.kbw-form-label').join(' / '),
          '文件名 / 笔记位置 / 模板',
          '三行标签（「落点」→「笔记位置」）',
        );
        const visibleHints = H
          .qa<HTMLElement>(modal, '.kbw-form-hint')
          .filter((el) => el.style.display !== 'none');
        eq(visibleHints.length, 0, '常态零小字（条件警告也没出现）');
        H.keydown(modal, 'Escape');
        await H.settle(80);
      } finally {
        H.keydown(document.body, 'Escape');
        await H.settle(80);
      }
    });

    await suite.it('「＋ 新建模板…」：问名字 → 落 T_文件（骨架六键 + 尾链）→ 下拉刷新并选中 → 通知带「打开它」', async () => {
      closeAllMenus();
      const made = `${TPL_DIR}/T_p79新模板.md`;
      try {
        openNewNoteDialog(ctx());
        await H.settle(80);
        const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
        const selects = H.qa<HTMLSelectElement>(modal, 'select.kbw-select');
        const tplSel = selects.find((s) =>
          Array.from(s.options).some((o) => o.textContent === '＋ 新建模板…'),
        );
        ok(tplSel, '模板下拉底部有「＋ 新建模板…」');
        const last = (tplSel as HTMLSelectElement).options[
          (tplSel as HTMLSelectElement).options.length - 1
        ];
        eq(last.textContent, '＋ 新建模板…', '就排在最后一项');
        (tplSel as HTMLSelectElement).value = last.value;
        (tplSel as HTMLSelectElement).dispatchEvent(new Event('change'));
        /**
         * ⚠️ 认**标题**，别认整篇 textContent —— 新建笔记面板自己的下拉里就有
         * 「＋ 新建模板…」这个选项，`textOf().includes('新建模板')` 会先命中它（第一版就这么栽的）。
         */
        const prompt = await untilEl(() => {
          const m = H
            .qa<HTMLElement>(document.body, '.kbw-modal')
            .find((x) => H.textOf(H.q<HTMLElement>(x, '.kbw-modal-title')) === '新建模板');
          return m ?? null;
        });
        ok(prompt, '弹出了问名字的小对话框');
        const input = H.q<HTMLInputElement>(prompt as HTMLElement, '.kbw-input');
        input.value = 'p79新模板';
        input.dispatchEvent(new Event('input'));
        const create = H
          .qa<HTMLElement>(prompt as HTMLElement, '.kbw-modal-foot .kbw-btn')
          .find((b) => H.textOf(b).includes('创建'));
        ok(create, '有「创建」');
        H.click(create as Element);
        await H.until(() => H.exists(vaultRoot, made), 2500);
        ok(H.exists(vaultRoot, made), '模板落在模板目录（T_ 前缀自动加上了）');
        const text = fs.readFileSync(path.join(vaultRoot, made), 'utf8');
        // P7.13a · #1 拍定：六键（五件套全上 + 收藏: false）+ 骨架 + 尾链段三行占位符
        contains(text, '类型: 模板', '骨架：类型 = 模板（套用时的真类型由补全按目录换算）');
        ok(text.includes('\n状态:\n'), '骨架：状态键在且空置（往返安全性 → 真机验证项）');
        ok(
          text.includes(`文件位置:\n  - ${TPL_DIR.slice(KB.length + 1)}`),
          '骨架：文件位置 = 模板库目录（相对库根）',
        );
        contains(text, '创建日期: "{{date}}"', '骨架：占位符带引号存（裸的是流式映射，会被写坏）');
        contains(text, 'tags: []', '骨架：tags 空数组');
        contains(text, '收藏: false', '骨架：收藏 = false（六件口径）');
        contains(text, '# {{title}}', '骨架带正文标题占位');
        for (const line of ['## 关联笔记', '- 相关笔记：[[]]', '- 所属中心：{{center}}', '- 返回大地图 {{moc}}']) {
          ok(text.includes(line), `骨架带尾链占位行：${line}`);
        }
        await H.until(() => (tplSel as HTMLSelectElement).value === made, 2000);
        eq((tplSel as HTMLSelectElement).value, made, '下拉刷新并选中刚建的那个');
        const notice = await untilEl(
          () =>
            H.qa<HTMLElement>(document.body, '.kbw-notice').find((n) =>
              H.textOf(n).includes('已新建模板'),
            ) ?? null,
        );
        ok(notice, '通知报出来了（不打断当前流程）');
        ok(
          H.qa<HTMLElement>(notice as HTMLElement, '.kbw-btn').some((b) =>
            H.textOf(b).includes('打开它'),
          ),
          '通知里带「打开它」',
        );
        H.keydown(document.body, 'Escape');
        await H.settle(120);
      } finally {
        H.keydown(document.body, 'Escape');
        await H.settle(80);
        rmFix([made.replace(`${KB}/`, '')]);
        await H.settle(80);
      }
    });

    await suite.it('P7.10 · 「如何新建模板」左下按钮（#7）：关掉问名字框 + 帮助栏自动展开该篇', async () => {
      closeAllMenus();
      try {
        openNewNoteDialog(ctx());
        await H.settle(80);
        const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
        const tplSel = H
          .qa<HTMLSelectElement>(modal, 'select.kbw-select')
          .find((s) => Array.from(s.options).some((o) => o.textContent === '＋ 新建模板…'));
        ok(tplSel, '模板下拉在');
        const last = (tplSel as HTMLSelectElement).options[
          (tplSel as HTMLSelectElement).options.length - 1
        ];
        (tplSel as HTMLSelectElement).value = last.value;
        (tplSel as HTMLSelectElement).dispatchEvent(new Event('change'));
        const prompt = await untilEl(() => {
          const m = H
            .qa<HTMLElement>(document.body, '.kbw-modal')
            .find((x) => H.textOf(H.q<HTMLElement>(x, '.kbw-modal-title')) === '新建模板');
          return m ?? null;
        });
        ok(prompt, '问名字框弹出（前提）');
        const link = H
          .qa<HTMLElement>(prompt as HTMLElement, '.kbw-modal-foot .kbw-btn')
          .find((b) => H.textOf(b) === '如何新建模板');
        ok(link, '左下角有「如何新建模板」');
        // 位置：**最左**（spacer 之前 —— 与「取消 / 创建」分居两头）
        ok(
          H.q<HTMLElement>(prompt as HTMLElement, '.kbw-modal-foot').firstElementChild === link,
          '它排在最左（spacer 之前）',
        );
        H.click(link as Element);
        await H.settle(150);
        ok(!(prompt as HTMLElement).isConnected, '点它先关掉问名字框（按取消算）');
        // 帮助栏开了 + 《如何新建模板》直接展开（待消费的意图 —— 与 M8「看教程」同路）
        const tab = H.q<HTMLElement>(document.body, '.kbw-set-tab[data-section="help"]');
        ok(tab.classList.contains('is-on'), '落在「帮助」栏');
        const cards = H.qa<HTMLElement>(document.body, '.kbw-tut-card');
        const nt = cards[6];
        ok(
          nt && H.textOf(H.q<HTMLElement>(nt, '.kbw-tut-title')) === '如何新建模板',
          `第 7 篇是《如何新建模板》（当前第 7 篇：${nt ? H.textOf(H.q<HTMLElement>(nt, '.kbw-tut-title')) : '（缺）'}）`,
        );
        ok(nt.classList.contains('is-open'), '打开即展开该篇');
        // 消费一次即清：关掉重开帮助栏，不再自动展开
        H.keydown(document.body, 'Escape'); // 收设置面板
        await H.settle(100);
        H.keydown(document.body, 'Escape'); // 收底下还开着的「新建笔记」
        await H.settle(100);
        ctx().openWorkbenchSettings('help');
        await H.settle(150);
        const again = H.qa<HTMLElement>(document.body, '.kbw-tut-card')[6];
        ok(!again.classList.contains('is-open'), '手动重开时不再自动展开（意图只消费一次）');
      } finally {
        H.keydown(document.body, 'Escape');
        await H.settle(80);
        H.keydown(document.body, 'Escape');
        await H.settle(80);
      }
    });

    await suite.it('条件警告（P1）：补全关着 + 选了模板 → 一行「不会生效」', async () => {
      closeAllMenus();
      const wasOn = ctx().gate.isOn('completion');
      try {
        openNewNoteDialog(ctx());
        await H.settle(80);
        const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
        const tplSel = H
          .qa<HTMLSelectElement>(modal, 'select.kbw-select')
          .find((s) => Array.from(s.options).some((o) => o.textContent === '＋ 新建模板…'));
        ok(tplSel, '模板下拉在');
        const firstReal = Array.from((tplSel as HTMLSelectElement).options).find(
          (o) => o.value !== '' && o.textContent !== '＋ 新建模板…',
        );
        ok(firstReal, `前提：下拉里有真模板（${Array.from((tplSel as HTMLSelectElement).options).map((o) => o.textContent).join(' | ')}）`);
        await ctx().gate.set('completion', false);
        await H.settle(60);
        (tplSel as HTMLSelectElement).value = firstReal!.value;
        (tplSel as HTMLSelectElement).dispatchEvent(new Event('change'));
        const warn = await untilEl(() => {
          const el = H.qa<HTMLElement>(modal, '.kbw-form-hint.is-warn').find(
            (x) => x.style.display !== 'none' && H.textOf(x).includes('不会生效'),
          );
          return el ?? null;
        });
        ok(warn, '补全关着时出现一行条件警告（"你的选择现在不生效"的必要告知）');
        contains(H.textOf(warn), '不会生效', '文案如实');
        const visibleWarns = (): HTMLElement[] =>
          H.qa<HTMLElement>(modal, '.kbw-form-hint.is-warn').filter((x) => x.style.display !== 'none');
        /**
         * 🟡3 修的第二支（独立审）：补全关着 + **「不使用模板」** → 旧长说明那句的接棒 ——
         * 落的是**空文件**，要如实说（这不是"模板不生效"，是"多/少了一段内容"的另一种意外）。
         */
        (tplSel as HTMLSelectElement).value = '';
        (tplSel as HTMLSelectElement).dispatchEvent(new Event('change'));
        const warn2 = await untilEl(() => {
          const el = visibleWarns().find((x) => H.textOf(x).includes('空文件'));
          return el ?? null;
        });
        ok(warn2, '「不使用模板 + 补全关」也给一行（这次只落一个空文件）');
        // 补全开回去 → 「不使用模板」不再有警告（常态零小字）
        await ctx().gate.set('completion', true);
        await H.settle(60);
        (tplSel as HTMLSelectElement).value = '';
        (tplSel as HTMLSelectElement).dispatchEvent(new Event('change'));
        await H.settle(120);
        eq(visibleWarns().length, 0, '补全开着 + 没选模板 → 警告消失（常态零小字）');
        H.keydown(document.body, 'Escape');
        await H.settle(80);
      } finally {
        await ctx().gate.set('completion', wasOn);
        H.keydown(document.body, 'Escape');
        await H.settle(120);
      }
    });

    /**
     * P7.13a · #2 · Q6"拆两层"：**补全关着 + 普通模板（不含 `<% %>`）** → 模板照套、
     * 只落原文 —— 警告如实说"少了什么"，不再写"不会生效"（拆两层之后那句是假话）。
     * ⚠️ 夹具模板必须**不含 `<% %>`**：含的话谁都不套（那是上面那条警告在管的情形）。
     */
    await suite.it('条件警告（P7.13a · #2）：补全关着 + 普通模板 → 「只套用模板原文」', async () => {
      closeAllMenus();
      const relMade = `${TPL_DIR.slice(KB.length + 1)}/T_p79只套原文.md`;
      const made = `${KB}/${relMade}`;
      const wasOn = ctx().gate.isOn('completion');
      try {
        writeFix(relMade, '---\n类型: 模板\n创建日期: "{{date}}"\ntags: []\n---\n\n# {{title}}\n');
        await ctx().gate.set('completion', false);
        openNewNoteDialog(ctx());
        await H.settle(80);
        const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
        const tplSel = H
          .qa<HTMLSelectElement>(modal, 'select.kbw-select')
          .find((s) => Array.from(s.options).some((o) => o.value === made));
        ok(tplSel, `自造的普通模板进了下拉（${made}）`);
        (tplSel as HTMLSelectElement).value = made;
        (tplSel as HTMLSelectElement).dispatchEvent(new Event('change'));
        /**
         * ⚠️ 按**文案**轮询（别按"有一行可见警告"就收）——切下拉前 NO_TEMPLATE 那一行
         * 「只落一个空文件」正亮着，`refreshWarn` 又是异步的，先收到的是它（第一版就这么假红）。
         */
        const warn = await untilEl(() => {
          const el = H
            .qa<HTMLElement>(modal, '.kbw-form-hint.is-warn')
            .find((x) => x.style.display !== 'none' && H.textOf(x).includes('只套用模板原文'));
          return el ?? null;
        });
        ok(warn, '补全关着 + 普通模板 → 一行「只套用模板原文」的警告');
        ok(!H.textOf(warn as HTMLElement).includes('不会生效'), '不再写"不会生效"（拆两层后它是假话）');
        ok(!H.textOf(warn as HTMLElement).includes('空文件'), '也不是「不使用模板」那条（换了个对象）');
        // 补全开回去 → 警告消失（常态零小字）
        await ctx().gate.set('completion', true);
        await H.settle(60);
        (tplSel as HTMLSelectElement).dispatchEvent(new Event('change'));
        await H.settle(120);
        eq(
          H.qa<HTMLElement>(modal, '.kbw-form-hint.is-warn').filter((x) => x.style.display !== 'none')
            .length,
          0,
          '补全开着 + 普通模板 → 警告消失',
        );
        H.keydown(document.body, 'Escape');
        await H.settle(80);
      } finally {
        await ctx().gate.set('completion', wasOn);
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        rmFix([relMade]);
      }
    });
  });
}
