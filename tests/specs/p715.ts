/**
 * spec：**P7.15 · 反馈批 6（文件位置一族 + 空文件夹进树）**
 * —— 条目真源 `P7.15开工提示词.md` §1；规格回改 `交互规格.md` §3.1 / §3.3 ·
 *    `属性规范.md` §3/§4。
 *
 * 四块（#1–#4）与各自的判据焦点：
 *   · **#1 库根顶层写「.」** —— 写侧落标记 · **读侧 `normalizeDeclaredPos` 归一**
 *     （只写不归一 = 顶层每篇都变"错位 + 缺声明"，这是本组的主判据）。
 *   · **#2 空文件夹进树** —— 纯函数（`buildTree(entries, realDirs)`）+ 真链路
 *     （新建空目录 → 树里立刻看得见、计数 0；五条既有行为逐条回归）。
 *   · **#3 目录选择器 + 一键迁** —— 候选 = 现算的真实目录（新建目录立刻在列）·
 *     选中 → 确认流 → mover 搬（快照 + 撤销）→ 声明跟随。
 *   · **#4 依模板新建不抄模板的位置** —— 值 = 实际落点（顶层 = `.`）。
 *
 * ⚠️ 夹具全带 `__p715` 前缀，每条自己收场（`metadataCache.settle()` 那套安全删法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { buildTree, buildTreeFromVault, allDirs } from '../../src/modules/notes/tree';
import { declaredPositions } from '../../src/services/schema';
import { kbDirs } from '../../src/ui/new-note';
import { joinPath } from '../../src/core/paths';
import { closeAllMenus } from '../../src/ui/menu';
import { clickMenuPath, findMenuItem, menuLabels } from './menu-helpers';
import type { NoteEntry } from '../../src/core/vault-index';
import type { TFile } from 'obsidian';

/** 造一个 `NoteEntry`（纯函数层用）—— 与 `specs/automation.ts` 同一形状 */
function entry(pathStr: string, dirRel: string, basename?: string): NoteEntry {
  const name = basename ?? (pathStr.split('/').pop() ?? '').replace(/\.md$/, '');
  return {
    file: { path: pathStr, basename: name } as TFile,
    props: {},
    flags: [],
    effectivePosition: dirRel,
    path: pathStr,
    basename: name,
    isTemplate: false,
    mtime: 0,
    size: 10,
  };
}

export async function specP715(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const treeItems = (): HTMLElement[] => H.qa(document.body, '.kbw-tree-item');
  const treeNode = (dir: string): HTMLElement | null =>
    treeItems().find((el) => (el.dataset.dir ?? '') === dir) ?? null;

  /**
   * 安全删法（P7.14c 记档）：裸 `fs.rmSync` 之后桩的 `metadataCache` 还有一个
   * ~300ms 的滞后重解析定时器 —— 它会去读一个不存在的文件、**未捕获异常把整个测试
   * 进程干掉**（不是一条用例红）。删完必须 `settle()` + 重建索引。
   */
  async function rmFix(abs: string): Promise<void> {
    fs.rmSync(abs, { force: true, recursive: true });
    app.vault.rescan();
    await app.metadataCache.settle();
    ctx().index.rebuild();
    await H.settle(120);
  }

  // ════════════════════════════════════════════════════════════
  // #2 · 纯函数：buildTree(entries, realDirs)
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.15 · #2：树的数据源 = 真实目录（纯函数）', async () => {
    await suite.it('空目录照画、计数 0；多层空链整条画出来（祖先一并建）', () => {
      const root = buildTree([entry('a/x.md', 'a')], ['a', 'empty', 'deep/mid/leaf']);
      const dirs = allDirs(root).sort();
      eq(
        dirs.join('|'),
        'a|deep|deep/mid|deep/mid/leaf|empty',
        '真实目录全在（含 0 篇的；空的祖先也建出来）',
      );
      const byDir = new Map([root, ...root.children].map((n) => [n.dir, n]));
      const find = (dir: string): ReturnType<typeof buildTree> | undefined => {
        let hit: ReturnType<typeof buildTree> | undefined;
        const walk = (n: ReturnType<typeof buildTree>): void => {
          if (n.dir === dir) hit = n;
          for (const c of n.children) walk(c);
        };
        walk(root);
        return hit ?? byDir.get(dir);
      };
      eq(find('a')?.count, 1, '有笔记的目录：计数照旧');
      eq(find('empty')?.count, 0, '★ 空目录画出来、计数 0（#2 的主判据）');
      eq(find('deep')?.count, 0, '空目录链的祖先也画（计数 0）');
      eq(find('deep/mid/leaf')?.count, 0, '……最深那层也在');
      eq(root.count, 1, '根计数 = 条目数（真实目录不参与计数）');
    });

    await suite.it('对照：不传 realDirs 时口径不变（老调用点不受影响）', () => {
      const root = buildTree([entry('a/x.md', 'a')]);
      eq(allDirs(root).join('|'), 'a', '只画"有笔记的目录"—— 这就是旧口径');
    });

    await suite.it('祖先去重：真实目录与笔记目录重叠时只建一个节点', () => {
      const root = buildTree([entry('a/x.md', 'a/b')], ['a', 'a/b', 'a/b']);
      const dirs = allDirs(root).sort();
      eq(dirs.join('|'), 'a|a/b', '重复的 realDirs 不会建出重复节点');
      const walk = (n: ReturnType<typeof buildTree>): number[] => [
        ...n.children.map((c) => c.count),
        ...n.children.flatMap(walk),
      ];
      eq(JSON.stringify(walk(root)), JSON.stringify([1, 1]), 'a 与 a/b 的计数各算一次');
    });

    await suite.it('buildTreeFromVault：真实目录来自 kbDirsOf（与落点下拉同一份口径）', () => {
      const root = buildTreeFromVault(app as never, ctx().settings.kbRoot(), ctx().index.notes());
      eq(root.dir, '', '根节点');
      const dirs = allDirs(root).sort();
      const real = kbDirs(ctx()).filter(Boolean).sort();
      /**
       * 树里画的目录 ⊇ 库里真实存在的目录（树只可能少"点开头"那类，
       * 而 `kbDirs` 与 `kbDirsOf` 的排除规则是同一份）—— 两边现算比一句全等更稳。
       */
      ok(
        real.every((d) => dirs.includes(d)),
        `真实目录都该画出来（缺：${real.filter((d) => !dirs.includes(d)).join('、') || '无'}）`,
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  // #2 · 真链路：新建空文件夹 → 树里立刻可见 + 五条既有行为回归
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.15 · #2：空文件夹进树（真链路）', async () => {
    await suite.it('新建空文件夹 → 树里立刻可见、计数 0；既有操作照常（点进入/拖入=搬/右键菜单/叶子三角）', async () => {
      const rel = '__p715空夹';
      const kbRoot = ctx().settings.kbRoot();
      const relAbs = joinPath(kbRoot, rel);
      const absDir = path.join(vaultRoot, relAbs);
      try {
        // ── 夹具：在**库根之下**建一个空目录（`vault.createFolder` = 平台层，
        //    与 P7.14c 那条"裸 mkdir 不进缓存"相对）。建到 vault 顶层就在库外了。
        ok(!fs.existsSync(absDir), '前提：这个目录还不存在');
        await app.vault.createFolder(relAbs);
        ctx().index.rebuild();
        await H.settle(160); // 索引 + 重画

        // ── ① 主判据：空目录出现在树里、计数 0
        ctx().goNotes();
        await H.settle(140);
        const node = treeNode(rel);
        ok(node != null, '★ 空目录出现在目录树里（旧口径下这条必红 —— #2 的主判据）');
        eq(H.textOf(node?.querySelector('.kbw-tree-count') as HTMLElement), '0', '计数显 0');

        // ── ② 点节点 = 进入该目录（面包屑写出来）
        H.click(node as Element);
        await H.settle(150);
        contains(H.textOf(document.body), rel, '点节点之后进到那个目录（面包屑同步）');

        // ── ③ 右键 = 文件夹菜单（与网格文件夹格同一份实现）
        const node3 = treeNode(rel);
        node3?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        await H.settle(150);
        const labels = H.qa<HTMLElement>(document.body, '.kbw-menu .kbw-menu-item').map((i) =>
          H.textOf(i),
        );
        ok(labels.length > 0, '右键弹出了菜单（不是空白）');
        contains(labels.join('|'), '在此新建笔记', '目录节点菜单的既有项在（§8.2）');
        closeAllMenus();
        await H.settle(80);

        // ── ④ 空目录在树上是叶子（没子节点）→ 点三角 no-op、不动 treeOpen 记忆
        const leaf = treeNode(rel);
        const caret = leaf?.querySelector('.kbw-tree-caret');
        ok(caret != null, '空目录也画三角位（与有子目录的节点同形）');
        ok(
          (caret as HTMLElement)?.classList.contains('is-leaf'),
          '空目录的三角是叶子态（`renderTree` 按 hasChildren 定 —— 折叠沿用现口径）',
        );
        const before = [...ctx().settings.get().treeOpen];
        H.click(caret as Element);
        await H.settle(140);
        eq(
          JSON.stringify(ctx().settings.get().treeOpen),
          JSON.stringify(before),
          '点叶子三角：treeOpen 一个字节都不动',
        );

        // ── ⑤ 拖一篇进去 = 真搬（即时生效 + 撤销条）—— 指针序列与 notes.ts 那条同款
        /**
         * ⚠️ 拖源用**详细信息档的行**（`.kbw-trow`）：与本仓库既有的鼠标拖拽判据
         * （`notes.ts` 的"拖到文件夹行"）同一条路 —— 那条路是 4px 阈值即刻进拖动；
         * 网格格那半边走的是另一条 pointerdown（长按族），鼠标序列在离线里起不来。
         * 落点：**树的空目录节点**（本 spec 的主角）。
         */
        ctx().goNotes({ dir: '00_Inbox' });
        await H.settle(160);
        const row = H.qa<HTMLElement>(document.body, '.kbw-trow').find((r) =>
          (r.dataset.path ?? '').includes('/00_Inbox/'),
        );
        ok(row != null, '前提：Inbox 里有可拖的笔记行');
        const fromPath = row?.dataset.path ?? '';
        const fromDir = ctx().index.get(fromPath)?.effectivePosition;
        const target = treeNode(rel);
        ok(target != null, '前提：目标节点在（树照旧画着空目录）');
        if (row && target) {
          const rc = row.getBoundingClientRect();
          const tc = (target as HTMLElement).getBoundingClientRect();
          const live = (): Element => treeNode(rel) ?? document.body;
          H.pointerDown(row, { x: rc.left + 20, y: rc.top + 8 });
          await H.tick(10);
          H.pointerMove(document.body, { x: rc.left + 26, y: rc.top + 10 });
          await H.tick(10);
          H.pointerMove(live(), { x: tc.left + 20, y: tc.top + 8 });
          await H.tick(20);
          /** 掠过空目录节点 → 节点上有"就放这儿"的落点高亮（与目录树别的节点同款） */
          ok(
            treeNode(rel)?.classList.contains('is-drop') ?? false,
            '掠过空目录节点 → 落点高亮（.is-drop）',
          );
          H.pointerUp(live(), { x: tc.left + 20, y: tc.top + 8, buttons: 0 });
          await H.settleIndex(app);
          try {
            /**
             * ⚠️ **搬完路径就变了**（mover 是真搬）—— 拿旧全路径查索引当然是 undefined。
             * 按 basename 找新身位，再比 `effectivePosition`。
             */
            const basename = fromPath.split('/').pop() ?? '';
            const after = ctx()
              .index.notes()
              .find((e) => e.path.split('/').pop() === basename);
            eq(after?.effectivePosition, rel, '★ 拖进空目录 = 真搬（§3.1 那条既有行为）');
            ok(
              fs.existsSync(path.join(vaultRoot, relAbs, basename)),
              '磁盘上也真的在新目录里（成对判据：老位置没了、新位置有）',
            );
            ok(H.currentUndoButton('撤销') != null, '搬完出撤销条（与拖到别处同一条链）');
          } finally {
            /** ⚠️ 撤销放 `finally`（notes.ts 那条的纪律）：上面红了也不许把夹具留在库里 */
            const u = H.currentUndoButton('撤销');
            if (u) H.click(u);
            await H.settleIndex(app);
          }
          eq(
            ctx().index.get(fromPath)?.effectivePosition,
            fromDir,
            '撤销之后回到原位（拖拽 = 即时生效 + 撤销条那条例外）',
          );
        }
        /** 收尾前把视野还原到"库根 + 详细档"（跨用例共享状态，别留给后面的 spec） */
        ctx().goNotes({ dir: '' });
        await H.settle(120);
      } finally {
        /**
         * 收尾走**安全删法**（P7.14c 记档）：裸 `fs.rmSync` 之后桩的 `metadataCache`
         * 还有一个 ~300ms 的滞后重解析定时器 —— 它会去读一个不存在的文件、
         * **未捕获异常把整个测试进程干掉**（不是一条用例红）。
         */
        await ctx().settings.save({ notesView: 'detail' });
        closeAllMenus();
        if (fs.existsSync(absDir)) {
          fs.rmSync(absDir, { recursive: true, force: true });
          app.vault.rescan();
          await app.metadataCache.settle();
          ctx().index.rebuild();
          await H.settle(120);
        }
        ok(!fs.existsSync(absDir), '夹具目录已清掉');
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // #1 · 顶层的「.」（真链路补一条：读侧归一之后不报错位）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.15 · #1：库根「.」在真索引里的闭环', async () => {
    await suite.it('顶层新建的笔记：声明读回空串、不报位置不一致、不在"缺声明"候选里', async () => {
      const rel = '__p715顶层闭环.md';
      await ensureKbRootDefault();
      /** ⚠️ 这里的"顶层" = **库根那一层**（默认 kbRoot='01_新知识库'），不是 vault 顶层 */
      await ctx().completion.createNote({ title: '__p715顶层闭环', dirRel: '', noTemplate: true });
      app.vault.rescan();
      await app.metadataCache.settle();
      await H.settle(220);
      /** ⚠️ 索引键是**vault 全路径**（`01_新知识库/名字.md`）—— rel 只是库内相对名 */
      const key = joinPath(ctx().settings.kbRoot(), rel);
      const e = ctx().index.get(key);
      ok(e != null, '索引里有这一篇');
      eq(e?.effectivePosition, '', '实际位置 = 库根（空串口径）');
      eq(declaredPositions(e?.props ?? {})[0], '', '★ 声明读回 = 空串（`.` 被归一）');
      ok(!e?.flags.includes('position-mismatch'), '★ 不报「位置不一致」');
      eq(
        declaredPositions(e?.props ?? {}).length,
        1,
        '声明数 = 1（不是 0）→ 不会落进"缺文件位置"候选',
      );
      await rmFix(path.join(vaultRoot, joinPath(ctx().settings.kbRoot(), rel)));
    });
  });

  /**
   * 把 kbRoot 拨回默认（本 spec 挂在 `p713b` 那个动库实例之后，根是默认值；
   * 这条只是把"测试自己假设的前提"写成断言，免得未来顺序变了静默失真）。
   */
  async function ensureKbRootDefault(): Promise<void> {
    const want = '01_新知识库';
    if (ctx().settings.kbRoot() !== want) {
      await ctx().settings.save({ kbRoot: want });
      await H.settle(150);
    }
  }

  // ════════════════════════════════════════════════════════════
  // #3 · 「文件位置」= 目录选择器 + 一键迁（候选现算 · 确认流 · 真搬 + 撤销）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.15 · #3：目录选择器 + 一键迁', async () => {
    await suite.it('候选 = 现算的真实目录：新目录建完、下一次现算就在列（不许缓存）', async () => {
      await ensureKbRootDefault();
      const before = kbDirs(ctx());
      const rel = '__p715候选夹';
      await app.vault.createFolder(joinPath(ctx().settings.kbRoot(), rel));
      await H.settle(80);
      const after = kbDirs(ctx());
      ok(!before.includes(rel), '前提：建立之前候选里没有它');
      ok(after.includes(rel), '★ 建完之后**同一会话下一次现算**就在列（没有缓存）');
      await rmFix(path.join(vaultRoot, ctx().settings.kbRoot(), rel));
    });

    await suite.it('右键「属性 › 文件位置」= 目录选择器：候选是真目录、「现处 X」在列（P7.18b 起取代置灰）', async () => {
      await ensureKbRootDefault();
      ctx().goNotes(); // helper 要**点在目录树上** —— 先确保在笔记屏
      await H.settle(160);
      /**
       * ⚠️ **用既有 helper 进目录**（`enterTopDirWithNotes`：现算"本层有 ≥n 篇"的顶层目录
       * 并点树进去）—— 写死 `00_Inbox` 在子集跑时可能撞上"那层还没画好"的时序。
       */
      const dir0 = await H.enterTopDirWithNotes(ctx(), 1);
      ok(dir0 !== '', `进到一个本层 ≥1 篇的目录（${dir0 || '取不到'}）`);
      await H.settle(140);
      /**
       * ⚠️ **挑"已声明且声明 == 现处"的那一行**（P7.16 · #2b 之后）：未声明的笔记，
       * "当前所在地"那一项从置灰改成了可点的「就住这儿（写声明，不搬）」
       *（判据在 `p716`）—— 这条守的是**已声明**那一档的置灰语义，不能拿
       * `.kbw-trow[0]` 撞运气（夹具里 00_Inbox 的 `9.16.md` 正是"声明 00_Inbox、
       * 住在 00_Inbox"）。
       */
      const row = H.qa<HTMLElement>(document.body, '.kbw-trow').find((r) => {
        const e0 = ctx().index.get(r.dataset.path ?? '');
        if (!e0) return false;
        const d = declaredPositions(e0.props);
        return d.length > 0 && d[0] === dir0 && e0.effectivePosition === dir0;
      });
      ok(row != null, `前提：这一层里有"已声明且就在声明处"的一行（当前层：${dir0}）`);
      const path0 = row?.dataset.path ?? '';
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await H.settle(150);
      /**
       * 菜单形状：`改 ›` → `属性 ›` → `文件位置：… ›`（P7.12 · R8 起的二级收纳）。
       * 导航走 `menu-helpers`（子菜单项尾带 `›`，一律 startsWith）。
       */
      ok(
        await clickMenuPath('改', '属性', '定位', '文件位置'),
        `走到「属性 › 定位 › 文件位置」：${menuLabels().join(' | ')}`,
      );
      const items = H.qa<HTMLElement>(document.body, '.kbw-menu .kbw-menu-item');
      const labels = items.map((i) => H.textOf(i));
      contains(labels.join('|'), '库根', '选择器第一项是「库根」');
      contains(labels.join('|'), dir0, '候选里是真实目录（旧实现那套只有"当前值本身"）');
      /**
       * ⚠️ **P7.18b 反转**（用户 2026-10-09 拍板）：当前所在地那一项从"置灰「它就在这儿」"
       * 改成**可点的「现处 X（写回当前位置）」**（任何状态可点 —— 补上被删掉的值 / 把错位
       * 的声明纠回现处）；"就住这儿"只在未声明时**另有**一项。
       */
      const hereItem = items.find((i) => H.textOf(i).trim().startsWith(`现处 ${dir0}`));
      ok(hereItem != null, `「现处 ${dir0}」在候选里（旧行为是置灰的目录名）`);
      ok(
        hereItem?.getAttribute('aria-disabled') !== 'true',
        '★ 可点（旧行为：置灰"它就在这儿" —— P7.18b 起是"写回当前位置"的入口）',
      );
      eq(ctx().index.get(path0)?.effectivePosition, dir0, '前提：这一篇确实在那个目录里');
      closeAllMenus();
      await H.settle(80);
    });

    await suite.it('★ 一键迁：确认流 → 真搬 → 声明 == 实际 → 撤销还原（两条后果一致）', async () => {
      await ensureKbRootDefault();
      const rel = '__p715迁入夹';
      const kbRoot = ctx().settings.kbRoot();
      const absDir = path.join(vaultRoot, joinPath(kbRoot, rel));
      try {
        await app.vault.createFolder(joinPath(kbRoot, rel));
        ctx().index.rebuild();
        await H.settle(140);
        ctx().goNotes();
        await H.settle(160);
        const dir0 = await H.enterTopDirWithNotes(ctx(), 1);
        ok(dir0 !== '', `进到一个本层 ≥1 篇的目录（${dir0 || '取不到'}）`);
        await H.settle(140);
        /**
         * ⚠️ 挑**有「文件位置」声明**的那一篇（fixture 里 `9.16.md` 有、`_收件箱.md` 没有）：
         * 本条验的是"搬完声明 == 实际"（P7.18b 起未声明的**也**这么写 —— 见「搬到库根」那条的
         * ② 对照段；这里仍挑已声明的，保证被测的是"跟随"而不是"首写"）。
         */
        const rows = H.qa<HTMLElement>(document.body, '.kbw-trow');
        const row = rows.find((r) =>
          (ctx().index.get(r.dataset.path ?? '')?.props['文件位置'] ?? undefined) !== undefined,
        );
        ok(row != null, '前提：这一层里有带「文件位置」声明的笔记行');
        const fromPath = row?.dataset.path ?? '';

        // 走**产品那条真路径**：右键菜单 → 属性 › → 文件位置 → 选目录 → 确认流
        row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        await H.settle(150);
        ok(
          await clickMenuPath('改', '属性', '定位', '文件位置'),
          `走到「属性 › 定位 › 文件位置」：${menuLabels().join(' | ')}`,
        );
        const target = findMenuItem(rel);
        ok(target != null, `选择器里有刚建的「${rel}」`);
        H.click(target as Element);
        await H.settle(240);

        /** 确认流（模态）：主按钮 = 「搬到『…』」 */
        const goBtn = H.qa<HTMLElement>(document.body, '.kbw-modal button').find((b) =>
          H.textOf(b).includes('搬到'),
        );
        ok(goBtn != null, '★ 弹出了确认流（动库前确认只能过 ui/confirm —— 硬规矩之三）');
        const modal = H.maybe<HTMLElement>(document.body, '.kbw-modal');
        contains(H.textOf(modal ?? document.body), '文件位置', '确认单写明这次改的是「文件位置」');
        H.click(goBtn as Element);
        await H.settleIndex(app, 300);

        const basename = fromPath.split('/').pop() ?? '';
        const findMoved = (): NoteEntry | undefined =>
          ctx()
            .index.notes()
            .find((e) => e.path.split('/').pop() === basename);
        /**
         * ⚠️ 搬 + 属性跟随是**两拍写盘**（mover 第 7 步 `setMany`），而桩的 metadataCache
         * 有 ~300ms 滞后 → 索引两拍都到位才算落定。用 `until` 等到位，别拿固定 settle 赌。
         */
        ok(
          await H.until(
            () => declaredPositions(findMoved()?.props ?? {})[0] === rel,
            3000,
            40,
          ),
          `★ 声明跟到一起（mover 的属性跟随）；实际声明=${JSON.stringify(
            declaredPositions(findMoved()?.props ?? {}),
          )}`,
        );
        const after = findMoved();
        eq(after?.effectivePosition, rel, '★ 真搬到那个目录（mover 那条链）');
        ok(
          !after?.flags.includes('position-mismatch'),
          '……所以不报错位（"搬了没改声明"的假红会在这里露馅）',
        );
        const u = H.currentUndoButton('撤销');
        ok(u != null, '搬完出撤销条（快照兜底）');
        if (u) H.click(u);
        await H.settleIndex(app, 300);
        const back = ctx()
          .index.notes()
          .find((e) => e.path.split('/').pop() === basename);
        eq(back?.effectivePosition, dir0, '撤销之后回到原目录（原件还原）');
      } finally {
        if (fs.existsSync(absDir)) await rmFix(absDir);
        closeAllMenus();
        ctx().goNotes({ dir: '' });
        await H.settle(120);
      }
    });

    await suite.it('★ 搬到**库根**：声明写 `.`（不是空数组 —— 那会被当成"没声明过"）', async () => {
      /**
       * 独立审查 🔴1 补的判据：mover 的属性跟随原来在 `rel === ''` 时写**空数组**
       * → `declaredPositions()` 为空 → 这篇**立刻**落进「整理建议 · 缺文件位置」
       * 与 AI 补声明候选（而它明明刚被声明过）。现在写 `ROOT_POS`（`.`）。
       * ⚠️ P7.18b 起"没声明过的搬走也不补声明"那条旧口径**已反转**（见 ② 对照段：
       * 未声明的搬完**也写**实际落点 —— 用户 2026-10-09 拍板）。
       */
      await ensureKbRootDefault();
      const kbRoot = ctx().settings.kbRoot();
      // ① 有声明的一篇：搬到库根 → 声明变 `.`
      const declTitle = '__p715搬根甲';
      await ctx().completion.createNote({ title: declTitle, dirRel: '00_Inbox', noTemplate: true });
      /**
       * ⚠️ **建完之后要让平台把缓存结算干净再读属性**（P-1 S3 的老账：真机 metadataCache
       * 有 ~300ms 滞后；紧跟 `rescan + settle` 再等索引自己的 120ms 防抖）。
       */
      app.vault.rescan();
      await app.metadataCache.settle();
      await H.settle(220);
      let e1 = ctx().index.get(`${kbRoot}/00_Inbox/${declTitle}.md`);
      ok(e1 != null, '前提：有声明的那一篇进了索引');
      eq(declaredPositions(e1?.props ?? {})[0], '00_Inbox', '前提：它声明的是 00_Inbox');
      await ctx().mover.move({
        targets: [{ dir: kbRoot, files: [e1?.file as never] }],
        source: 'batch',
        reason: 'P7.15 判据：搬到库根',
        quiet: true,
      });
      await H.settleIndex(app, 320);
      const moved1 = ctx()
        .index.notes()
        .find((e) => e.basename === declTitle);
      eq(moved1?.effectivePosition, '', '真的搬到库根了');
      eq(
        declaredPositions(moved1?.props ?? {})[0],
        '',
        '★ 声明 = `.`（读回归一成空串）—— 不是空数组',
      );
      eq(
        declaredPositions(moved1?.props ?? {}).length,
        1,
        '★ 声明数 = 1（不是 0）→ 不会落进"缺文件位置"候选',
      );

      // ② 对照（**P7.18b 反转**）：**没声明过**的一篇搬走 → **也补声明**（= 新落点；搬到库根 → `.`）
      const bareTitle = '__p715搬根乙';
      const bareRel = `00_Inbox/${bareTitle}.md`;
      H.writeNote(vaultRoot, `${kbRoot}/${bareRel}`, H.note('# 没声明过的\n', { 类型: '笔记' }));
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(200);
      const e2 = ctx().index.get(`${kbRoot}/${bareRel}`);
      ok(e2 != null, '前提：没声明的那一篇在索引里');
      eq(declaredPositions(e2?.props ?? {}).length, 0, '前提：它确实没声明');
      await ctx().mover.move({
        targets: [{ dir: kbRoot, files: [e2?.file as never] }],
        source: 'batch',
        reason: 'P7.15 判据：没声明的搬库根',
        quiet: true,
      });
      await H.settleIndex(app, 320);
      ok(
        await H.until(
          () =>
            declaredPositions(
              ctx()
                .index.notes()
                .find((e) => e.basename === bareTitle)?.props ?? {},
            ).length > 0,
          3000,
          40,
        ),
        '★ P7.18b：没声明过的搬走**也补声明**（旧口径"留空的保持留空"已反转）',
      );
      eq(
        declaredPositions(
          ctx()
            .index.notes()
            .find((e) => e.basename === bareTitle)?.props ?? {},
        )[0],
        '',
        '……搬到库根 → 声明 = `.`（读侧归一空串）',
      );

      await rmFix(path.join(vaultRoot, kbRoot, `${declTitle}.md`));
      await rmFix(path.join(vaultRoot, kbRoot, `${bareTitle}.md`));
    });
  });

  // ════════════════════════════════════════════════════════════
  // #2 · 产品的"新建子文件夹"路径（不许靠判据自己 rebuild 兜底）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.15 · #2：新建子文件夹 → 树里自然刷新（走产品路径）', async () => {
    await suite.it('★ 右键「新建子文件夹」→ 建完**不手动 rebuild**，树里自己出现', async () => {
      await ensureKbRootDefault();
      const kbRoot = ctx().settings.kbRoot();
      const rel = '__p715产品新建';
      /** 空白处菜单建在**当前目录**（store.dir）—— 用例开头回库根，所以它落在库根那一层 */
      const absDir = path.join(vaultRoot, kbRoot, rel);
      try {
        ctx().goNotes();
        await H.settle(160);
        /**
         * 走**产品那条路**：**空白处右键**（目录树的空区）→「新建文件夹」→ 填名 → 确认。
         *
         * ⚠️ 为什么不用目录节点右键：**P7.15 当时节点菜单里没有「新建子文件夹」**
         * （`showFolderMenu` 只有 在此新建笔记/展开全部子目录/在资源管理器中打开/重排；
         *  「新建子文件夹」在**网格文件夹菜单** `showGridFolderMenu` 与**空白处菜单**里）——
         * 那条菜单面不一致**已由 P7.23 补上**（节点菜单新增「在此新建目录」，与网格那份
         * 同一实现）。这条用例继续走空白路（两条路都是产品路径，各验各的），不再改。
         *
         * 🔴 独立审查 🟡4：旧实现这条路的回调不传 `onFolderCreated` ——
         * `createFolder` 不产 `.md` → 索引不 bump → 树一次都不重画
         *（真机症状 = "建完要再点一下才出现"）。
         * 判据**故意不调 `index.rebuild()`**：要验的就是"路径自己会刷新"。
         */
        const treeHost = H.q<HTMLElement>(document.body, '.kbw-tree-body');
        ok(treeHost != null, '前提：目录树本体在');
        treeHost?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        await H.settle(150);
        ok(
          await clickMenuPath('新建文件夹'),
          `空白处菜单里有「新建文件夹」：${menuLabels().join(' | ')}`,
        );
        await H.settle(200);
        const prompt = H.q(document.body, '.kbw-modal');
        ok(prompt != null, '弹出了取名对话框');
        H.q<HTMLInputElement>(prompt as HTMLElement, 'input.kbw-input').value = rel;
        H.click(H.q<HTMLElement>(prompt as HTMLElement, '.kbw-modal-foot .kbw-btn.is-primary'));
        await H.settle(360);

        ok(fs.existsSync(absDir), '目录真的建出来了');
        /** ★ 主判据：**不手动 rebuild**，树里自己看得见（`onOpenDir` → `repaint`） */
        /**
         * ★ 主判据：**不手动 rebuild**，树里自己看得见。
         * 树里它挂在 00_Inbox 下 —— `00_Inbox` 默认是**折叠**的，但 `onOpenDir(rel)`
         * 会把新目录并进展开集合（用户此刻"就站在里面"），所以那一行直接可见。
         */
        ok(
          treeNode(rel) != null,
          '★ 建完树里自己出现（没有手动 rebuild —— 产品路径自己刷新）',
        );
      } finally {
        if (fs.existsSync(absDir)) await rmFix(absDir);
        closeAllMenus();
        ctx().goNotes({ dir: '' });
        await H.settle(120);
      }
    });
  });
}
