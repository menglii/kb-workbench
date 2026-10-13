/**
 * spec：**P7.2d 首页卡片批**（16.9 ＋ 16.13，2026-10-04）
 *
 * 完成定义对应的判据（本文件）：
 *   · 16.9-a 图谱卡：核心插件关着 → 整卡自隐；开着 → 真挂（与模块同一份 `mountGraphInto`）
 *     + 过滤真的注入了（`setQuery` 收到排除串）；
 *   · 16.9-b 钉住的笔记：A 行卡（看板关）/ B 内嵌小窗（看板开）**按开关自动切**；
 *     空自隐；✕ = 取消钉选；sync 收多的加缺的；**不留悬挂叶**（块收尾 detach）；
 *   · 16.9-c 最近改动：桥在 → 小窗（不开标签页）；桥不在/答 false → 退标签页；title 写明两种方式；
 *   · 16.13 新手清单：打勾 = 动作点置位（幂等）；全勾退休自隐；重置复现；完成提示只弹一次；
 *   · 设置键：`homeCards` / `onboarding` 的 null 哨兵 + 非法项收敛；
 *   · 钉选：菜单两向 + 上限 6 不顶旧的 + rename 迁键 / delete 剪枝（插件层监听）。
 *
 * ⚠️ 起手清场纪律（跨用例污染是本项目栽得最多的一类）：
 *   · 夹具全带 `__` 前缀，每条收尾删文件 + `rescan` + `index.rebuild()`；
 *   · `homeCards` / `onboarding` / `homeBlocks` / 看板开关 / 图谱核心开关是**共享设置**，
 *     用例收尾一律拨回（`save(null)` / `gate.set(true)` / `internalPlugins` 还原）；
 *   · 面板/菜单/通知收干净（`closeAllMenus` / `purgeOverlays` / `__resetNotices`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { normalizeSettings } from '../../src/core/settings';
import { HOME_BLOCKS, homeCardsRegionKey } from '../../src/modules/home/blocks';
import { onboardingWizardJustFinished } from '../../src/modules/home/onboarding';
import {
  ensureWindowDeps,
  mergeWindowInto,
  openCardWindow,
} from '../../src/modules/board/editor';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import { __resetNotices } from '../../src/ui/notify';
import { openNewNoteDialog } from '../../src/ui/new-note';

const KB = '01_新知识库';
const BOARD_CFG = `${KB}/99_Meta/06_工作台/看板配置.json`;

function blockBox(id: string): HTMLElement | null {
  return H.qa<HTMLElement>(document.body, '.kbw-hblock').find((b) => b.dataset.block === id) ?? null;
}

/** 每条用例起手：激活工作台 + 切到首页（与 p72a 的 `ensureHome` 同一条纪律） */
async function ensureHome(plugin: KbWorkbenchPlugin): Promise<void> {
  await plugin.context().activate();
  await H.settle(80);
  const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
    H.textOf(n).includes('首页'),
  );
  if (nav && !nav.classList.contains('is-on')) {
    H.click(nav);
    await H.settle(120);
  }
}

async function saveBlocks(plugin: KbWorkbenchPlugin, v: { order: string[]; hidden: string[] } | null): Promise<void> {
  await plugin.context().settings.save({ homeBlocks: v });
  await H.settle(60);
}

/** 只显示这几块（其余全隐）—— 起手把一屏收干净，别的块不进判据 */
async function showOnly(plugin: KbWorkbenchPlugin, ids: string[]): Promise<void> {
  const all = HOME_BLOCKS.map((b) => b.id);
  await saveBlocks(plugin, { order: all, hidden: all.filter((x) => !ids.includes(x)) });
}

export async function specP72d(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  const leavesOfType = (t: string): unknown[] =>
    (app as unknown as { __leaves: { view?: { getViewType?: () => string } }[] }).__leaves.filter(
      (l) => l.view?.getViewType?.() === t,
    );

  /** 造一篇笔记并让索引看见（走 modify 事件 = 真链路） */
  async function putNote(rel: string, props: Record<string, unknown> = {}): Promise<void> {
    H.writeNote(vaultRoot, rel, H.note(`# ${path.basename(rel, '.md')}\n`, { 类型: '想法', 领域: '未分类', 状态: '待整理', ...props }));
    app.vault.rescan();
    const f = app.vault.getAbstractFileByPath(rel);
    if (f) app.vault.trigger('modify', f);
    await H.settleIndex(app, 260);
  }

  /** 收走一篇夹具（删 + 重建索引） */
  async function dropNote(rel: string): Promise<void> {
    fs.rmSync(path.join(vaultRoot, rel), { force: true });
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app, 220);
  }

  /** 起手把这一组用例的共享设置都拨回基线 */
  async function resetShared(): Promise<void> {
    closeAllMenus();
    purgeOverlays();
    __resetNotices();
    await ctx().settings.save({ homeCards: null, onboarding: null });
    await saveBlocks(plugin, null);
    await H.settle(40);
  }

  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2d · 设置键（homeCards / onboarding 的哨兵与收敛）', async () => {
    await suite.it('homeCards：null 原样保留；数组只收字符串；落盘回读', async () => {
      eq(normalizeSettings({}).homeCards, null, '缺项 → null（还没钉过）');
      eq(normalizeSettings({ homeCards: null }).homeCards, null, 'null 原样保留');
      deepEq(
        normalizeSettings({ homeCards: [1, 'a.md', {}, 'b.md', null] }).homeCards,
        ['a.md', 'b.md'],
        '只收字符串（手改 data.json 的容错）',
      );
      await ctx().settings.save({ homeCards: ['x/a.md', 'x/b.md'] });
      deepEq(ctx().settings.get().homeCards, ['x/a.md', 'x/b.md'], '存 → 读：数组回来');
      await ctx().settings.save({ homeCards: null });
      await H.settle(40);
      eq(ctx().settings.get().homeCards, null, '拨回 null');
    });

    await suite.it('onboarding：null 原样保留；只收认识的 id（wizard 不在表里）', async () => {
      eq(normalizeSettings({}).onboarding, null, '缺项 → null（一项都没做过）');
      eq(normalizeSettings({ onboarding: null }).onboarding, null, 'null 原样保留');
      deepEq(
        normalizeSettings({ onboarding: ['created', 'zzz', 'view', 42] }).onboarding,
        ['created', 'view'],
        '白名单外的 id 丢掉（第 1 项读 wizardDone，不在这张表里——写进来也不收）',
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2d · 钉选（菜单 / 上限 / 迁键剪枝）', async () => {
    const REL = `${KB}/00_Inbox/__探针钉选.md`;

    await suite.it('右键「钉到首页」→ homeCards 落盘；再点「取消钉」→ 去掉', async () => {
      await resetShared();
      await putNote(REL, { 收藏: false });
      await ensureHome(plugin);
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(150);
      // 声明详细档前提（P7.1c 教训的离线镜像：档位是落盘偏好，全量跑时可能是网格）
      const segDetail = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
        H.textOf(b).includes('详细信息'),
      );
      if (segDetail && !segDetail.classList.contains('is-on')) {
        H.click(segDetail);
        await H.settle(250);
      }
      await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-trow').some((r) => r.dataset.path === REL),
        2500,
      );
      const openOther = async (): Promise<HTMLElement> => {
        const row = H.qa<HTMLElement>(document.body, '.kbw-trow').find((r) => r.dataset.path === REL);
        ok(row, '前提：列表里能看到那一行');
        row?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }),
        );
        await H.settle(60);
        const other = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('其他'),
        );
        ok(other, '菜单里有「其他」组');
        other?.dispatchEvent(new MouseEvent('mouseenter'));
        await H.settle(60);
        // 子菜单里找目标项（「收藏」旁的那一条）
        return other as HTMLElement;
      };
      const clickSub = async (label: string): Promise<boolean> => {
        const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).trim() === label && !i.classList.contains('is-parent'),
        );
        if (!item) return false;
        H.click(item);
        await H.settle(80);
        return true;
      };

      await openOther();
      ok(await clickSub('钉到首页'), '「钉到首页」在「其他」组里（与「收藏」同族）');
      ok(
        await H.until(() => ctx().settings.get().homeCards?.includes(REL) === true, 1500),
        '钉选落进 homeCards',
      );
      closeAllMenus();
      await H.settle(60);

      await openOther();
      await H.settle(60);
      ok(await clickSub('取消钉'), '已钉时这一条变成「取消钉」');
      ok(
        await H.until(() => (ctx().settings.get().homeCards ?? []).includes(REL) === false, 1500),
        '取消钉 → 从表里去掉',
      );
      closeAllMenus();
      await dropNote(REL);
    });

    await suite.it('上限 6：第 7 篇只通知、一个字都不写（不顶掉旧的）', async () => {
      await resetShared();
      await putNote(REL);
      await ensureHome(plugin);
      // 先塞满 6 条（路径不必真存在 —— 上限判据只看表长）
      const six = Array.from({ length: 6 }, (_, i) => `${KB}/00_Inbox/__占位${i}.md`);
      await ctx().settings.save({ homeCards: six });
      await H.settle(60);
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(150);
      await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-trow').some((r) => r.dataset.path === REL),
        2500,
      );
      const row = H.qa<HTMLElement>(document.body, '.kbw-trow').find((r) => r.dataset.path === REL);
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
      await H.settle(60);
      const other = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('其他'),
      );
      other?.dispatchEvent(new MouseEvent('mouseenter'));
      await H.settle(60);
      const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).trim() === '钉到首页',
      );
      ok(item, '菜单项在');
      __resetNotices();
      H.click(item as HTMLElement);
      await H.settle(120);
      deepEq(ctx().settings.get().homeCards, six, '第 7 篇被拒：表原样（不顶掉旧的）');
      contains(H.textOf(H.maybe(document.body, '.kbw-notice')), '上限', '通知说清为什么');
      closeAllMenus();
      await ctx().settings.save({ homeCards: null });
      await dropNote(REL);
    });

    await suite.it('rename 迁键 / delete 剪枝（插件层两条监听，与 gridOrder 同一处）', async () => {
      await resetShared();
      const OLD = `${KB}/00_Inbox/__钉选迁键.md`;
      const NEW = `${KB}/00_Inbox/__钉选迁键-改名.md`;
      await putNote(OLD);
      await ctx().settings.save({ homeCards: [OLD] });
      await H.settle(60);

      const file = app.vault.getAbstractFileByPath(OLD);
      ok(file, '前提：文件在');
      await app.vault.rename(file as never, NEW);
      ok(
        await H.until(() => ctx().settings.get().homeCards?.[0] === NEW, 1500),
        '改名 → homeCards 里的旧路径跟着迁（漏迁 = 首页块里"失联"）',
      );

      const f2 = app.vault.getAbstractFileByPath(NEW);
      await app.vault.delete(f2 as never);
      ok(
        await H.until(() => (ctx().settings.get().homeCards ?? []).length === 0, 1500),
        '删除 → 路径剪掉（不留死键）',
      );
      await dropNote(NEW);
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2d · 钉住的笔记（A 行卡 / B 内嵌小窗）', async () => {
    const P1 = `${KB}/00_Inbox/__钉卡甲.md`;
    const P2 = `${KB}/00_Inbox/__钉卡乙.md`;

    await suite.it('A 档（看板关）：行卡画出来、点击开新标签；空 = 自隐', async () => {
      await resetShared();
      await ctx().gate.set('board', false);
      await putNote(P1, { 状态: '撰写中' });
      await putNote(P2);
      await ctx().settings.save({ homeCards: [P1, P2] });
      await showOnly(plugin, ['homeCards']);
      await ensureHome(plugin);
      await H.settle(150);
      const box = blockBox('homeCards');
      ok(box && !(box as HTMLElement).hidden, '钉了两篇 → 块在（A 档：行卡）');
      contains(H.textOf(box as HTMLElement), '钉住的笔记', '块头在');
      const rows = H.qa<HTMLElement>(box as HTMLElement, '.kbw-rec');
      eq(rows.length, 2, '一行一篇');
      contains(H.textOf(rows[0]), '状态：撰写中', '中列 = 状态（与稿子的行形态一致）');
      ok(!H.maybe(box as HTMLElement, '.kbw-cw-panel'), 'A 档没有小窗');

      // 点击 → 开新标签页
      const before = leavesOfType('markdown').length;
      H.click(rows[0]);
      await H.settle(200);
      eq(leavesOfType('markdown').length, before + 1, '点行 → 开了一篇（标签页那条路）');

      // 空 → 自隐
      await ctx().settings.save({ homeCards: null });
      ok(
        await H.until(() => {
          const b = blockBox('homeCards');
          return b === null || (b as HTMLElement).hidden === true;
        }, 1500),
        '一篇都没钉 → 整块自隐',
      );
      await ctx().gate.set('board', true);
      await dropNote(P1);
      await dropNote(P2);
      await resetShared();
    });

    await suite.it('B 档（看板开）：块内停真卡片窗（tab 条 = 钉住的几篇）；节点保活不重建', async () => {
      await resetShared();
      await putNote(P1);
      await putNote(P2);
      await ctx().settings.save({ homeCards: [P1, P2] });
      await showOnly(plugin, ['homeCards']);
      await ensureHome(plugin);
      await H.settle(250);
      const box = blockBox('homeCards') as HTMLElement;
      ok(box && !box.hidden, 'B 档：块在');
      const win = H.maybe<HTMLElement>(box, '.kbw-hcard-win .kbw-cw-panel');
      ok(win, '块内停着一扇真卡片窗');
      ok(win?.classList.contains('is-docked'), '停靠档（.is-docked —— 复用，不造第二套样式）');
      const tabs = H.qa<HTMLElement>(box, '.kbw-cw-tabs .kbw-cw-tab');
      eq(tabs.length, 2, 'tab 条 = 钉住的几篇');
      ok(win?.querySelector('.kbw-cw-editor'), '挂的是真编辑器那套 DOM');

      /**
       * **保活**：钉选变了 → Region 重画 → 窗被"放回新宿主"（`rehost`），
       * 而**不是重建** —— 节点身份不变、叶不变（同一个活编辑器换父，不丢光标）。
       */
      const winNode = win;
      const leavesBefore = leavesOfType('markdown').length;
      await ctx().settings.save({ homeCards: [P1] });
      await H.settle(300);
      const winAfter = H.maybe<HTMLElement>(box, '.kbw-hcard-win .kbw-cw-panel');
      ok(winAfter === winNode, '重画之后还是**同一个**窗节点（没重建）');
      // 退场口径与看板小窗一致：只剩 1 篇时 tab 条**整条藏起**（元素也清空）
      eq(
        H.qa<HTMLElement>(box, '.kbw-cw-tabs .kbw-cw-tab').length,
        0,
        'sync 收多了的：只剩 1 篇 → tab 条收起来（<2 篇的既有口径）',
      );
      ok(!H.textOf(box).includes('钉卡乙'), '被取消钉的那一篇不再出现在窗里');
      eq(
        (H.q(box, '.kbw-cw-title') as HTMLInputElement).value,
        '__钉卡甲',
        '标题输入框停在剩下那一篇上',
      );
      ok(
        await H.until(() => leavesOfType('markdown').length === leavesBefore - 1, 2000),
        '退场那一篇的叶也被收（save + detach，不多不少一片）',
      );

      // sync 的**加缺**方向（独立审 F4b：原来只有真机探针压这条）——钉回来，还是同一个窗
      await ctx().settings.save({ homeCards: [P1, P2] });
      ok(
        await H.until(
          () => H.qa<HTMLElement>(box, '.kbw-cw-tabs .kbw-cw-tab').length === 2,
          2000,
        ),
        'sync 加缺：钉回来 → tab 配齐（在线补，不是等重建）',
      );
      ok(
        H.maybe<HTMLElement>(box, '.kbw-hcard-win .kbw-cw-panel') === winNode,
        '加回来还是**同一个**窗节点（编辑器重挂，窗不重建）',
      );

      await ctx().settings.save({ homeCards: null });
      await dropNote(P1);
      await dropNote(P2);
      await resetShared();
    });

    await suite.it('B 档：tab 的 ✕ = 取消钉选（拍定）；点完 homeCards 少一条', async () => {
      await resetShared();
      await putNote(P1);
      await putNote(P2);
      await ctx().settings.save({ homeCards: [P1, P2] });
      await showOnly(plugin, ['homeCards']);
      await ensureHome(plugin);
      await H.settle(250);
      const box = blockBox('homeCards') as HTMLElement;
      const x = H.qa<HTMLElement>(box, '.kbw-cw-tabx')[1];
      ok(x, '第二枚 tab 的 ✕ 在（≥2 篇才画 tab 条）');
      eq(x.getAttribute('title'), '取消钉选（从首页移除，不删笔记）', '✕ 的 title 写明去取消钉');
      H.click(x);
      ok(
        await H.until(() => (ctx().settings.get().homeCards ?? []).length === 1, 1500),
        '✕ → homeCards 少一条（不是"关上又被同步加回来"）',
      );
      await H.settle(250);
      eq(
        H.qa<HTMLElement>(box, '.kbw-cw-tabs .kbw-cw-tab').length,
        0,
        '同步之后只剩 1 篇 → tab 条收起（= 窗里真的少了那一篇）',
      );
      ok(!H.textOf(box).includes('钉卡乙'), '被取消钉的那一篇退场');
      await ctx().settings.save({ homeCards: null });
      await dropNote(P1);
      await dropNote(P2);
      await resetShared();
    });

    await suite.it('🔴 切模块 → 窗收干净（叶全 detach，不留悬挂叶）', async () => {
      await resetShared();
      await putNote(P1);
      await putNote(P2);
      await ctx().settings.save({ homeCards: [P1, P2] });
      await showOnly(plugin, ['homeCards']);
      await ensureHome(plugin);
      await H.settle(250);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '前提：窗开着');
      const mdBefore = leavesOfType('markdown').length;

      // 切走（点导航「全部笔记」—— 与 ensureHome 同一条"点导航"纪律）
      const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
        H.textOf(n).includes('全部笔记'),
      );
      ok(nav, '有「全部笔记」导航项');
      H.click(nav as Element);
      await H.settle(400);
      eq(H.maybe(document.body, '.kbw-cw-panel'), null, '块收尾 → 窗拆掉（DOM 层面）');
      ok(
        await H.until(() => leavesOfType('markdown').length === mdBefore - 2, 2000),
        '★★ 两个编辑器的叶都 detach 了（多一片 = 悬挂叶；这条是这个用例的意义）',
      );

      await ctx().settings.save({ homeCards: null });
      await dropNote(P1);
      await dropNote(P2);
      await resetShared();
    });

    await suite.it('审 F2：窗被"块外"的路收掉 → 块不剩空框（把手验活 + 重开）', async () => {
      await resetShared();
      const P3 = `${KB}/00_Inbox/__钉卡丙.md`;
      await putNote(P1);
      await putNote(P2);
      await putNote(P3);
      await ctx().settings.save({ homeCards: [P1, P2] });
      await showOnly(plugin, ['homeCards']);
      await ensureHome(plugin);
      await H.settle(250);
      const box = blockBox('homeCards') as HTMLElement;
      const emb = H.q<HTMLElement>(box, '.kbw-hcard-win .kbw-cw-panel');
      const embId = Number(emb.dataset.win ?? '');
      ok(embId > 0, '拿到内嵌窗的实例号');

      /**
       * 造"块外被收"：另开一扇浮层小窗（放 P3），用 `mergeWindowInto` 把内嵌窗并过去 ——
       * 内嵌窗被搬空 → 自拆（这正是"被别的路收掉"的真实形态，独立审 F2）。
       */
      const deps = ensureWindowDeps(ctx());
      const e3 = ctx().index.get(P3);
      ok(e3, 'P3 在索引里');
      if (e3) openCardWindow(e3, deps, undefined, { quiet: true });
      await H.settle(300);
      const floating = H.qa<HTMLElement>(document.body, '.kbw-panel').find(
        (p) => !p.closest('.kbw-hcard-win'),
      );
      ok(floating, '浮层小窗开了');
      const floatId = Number(floating?.dataset.win ?? '');
      ok(mergeWindowInto(embId, floatId), '并入成功（内嵌窗被搬空 → 自拆）');
      await H.settle(300);
      ok(!H.maybe(box, '.kbw-cw-panel'), '前提：块外那一路真的把窗收掉了（此刻是死把手）');

      // 触发一次重画（改钉选）→ 死把手该被弃掉重开
      await ctx().settings.save({ homeCards: [P1] });
      ok(
        await H.until(() => !!H.maybe(box, '.kbw-cw-panel'), 2000),
        '★★ 重画之后块里**重新有一扇活窗**（不是 400px 空框——F2 修的就是这个）',
      );
      // 收尾：关浮层（P2/P3 还在里面）、清钉选、清夹具
      closeAllMenus();
      purgeOverlays();
      await H.settle(200);
      await ctx().settings.save({ homeCards: null });
      await dropNote(P1);
      await dropNote(P2);
      await dropNote(P3);
      await resetShared();
    });

    await suite.it('审 F1：外部改的看板配置**当窗跟着走**（单例的 watchExternal）', async () => {
      await resetShared();
      await putNote(P1, { 状态: '撰写中' }); // 有属性（默认档不画；下面外部改档才该出现）
      await ctx().settings.save({ homeCards: [P1] });
      await showOnly(plugin, ['homeCards']);
      await ensureHome(plugin);
      await H.settle(300);
      const box = blockBox('homeCards') as HTMLElement;
      /**
       * ⚠️ 小窗属性的**默认档是 `none`**（C2 拍板"默认只显示正文"）——
       * 所以判据做**双向**：外部写 few → 行出现；外部写 none → 行消失。两次都走
       * `configs.write` + watch 广播（设置面板改「看板默认值」就是这么写的）。
       */
      eq(H.qa<HTMLElement>(box, '.kbw-cw-row').length, 0, '起手：默认档不画属性行');

      /**
       * ⚠️ **必须写 `version: 2`**（= 当前 `BOARD_CONFIG_VERSION`）：写 version 1 的话
       * `migrateLegacyView` 会把 `panelProps: 'few'` 当"旧默认被物化"**特意迁成 `none`**
       *（C2 拍板的一次性迁移，行为是对的）—— 判据第一版就栽在这儿（store 里始终是 none，
       * 看起来像"watch 没接上"，其实是写的值被迁移吃了）。
       */
      await ctx().configs.write('board', {
        version: 2,
        view: { panelProps: 'few' },
        sections: [],
      });
      ok(
        await H.until(() => H.qa<HTMLElement>(box, '.kbw-cw-row').length >= 1, 2000),
        '★★ 外部写「属性=前 6 行」→ 内嵌窗当场画出来（F1 修的"设置改了没用"）',
      );

      await ctx().configs.write('board', {
        version: 2,
        view: { panelProps: 'none' },
        sections: [],
      });
      ok(
        await H.until(() => H.qa<HTMLElement>(box, '.kbw-cw-row').length === 0, 2000),
        '外部再写回「藏掉」→ 行收掉（同一个 watch 通道的另一个方向）',
      );

      // 收尾：把看板配置删掉（别把它留给后面的用例）+ 清钉选夹具
      const cfgFile = app.vault.getAbstractFileByPath(BOARD_CFG);
      if (cfgFile) await app.vault.delete(cfgFile as never, true);
      await H.settle(300);
      purgeOverlays();
      await ctx().settings.save({ homeCards: null });
      await dropNote(P1);
      await resetShared();
    });

    await suite.it('看板开关一翻 → 档位自动切（B ↔ A）；homeCardsRegionKey 的口径', async () => {
      await resetShared();
      await putNote(P1);
      await ctx().settings.save({ homeCards: [P1] });
      await showOnly(plugin, ['homeCards']);
      await ensureHome(plugin);
      await H.settle(200);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '看板开着 → B 档（有窗）');
      await ctx().gate.set('board', false);
      await H.settle(300);
      const box = blockBox('homeCards') as HTMLElement;
      ok(!H.maybe(box, '.kbw-cw-panel'), '关掉看板 → 窗收掉（档位跟着切）');
      eq(H.qa<HTMLElement>(box, '.kbw-rec').length, 1, 'A 档的行卡顶上');
      await ctx().gate.set('board', true);
      await H.settle(300);
      ok(H.maybe(document.body, '.kbw-cw-panel'), '再开看板 → 回到 B 档');
      await ctx().settings.save({ homeCards: null });
      await dropNote(P1);
      await resetShared();

      // key 的口径（纯函数）：行卡档吃 rev、窗档不吃（里面是真编辑器，重画会摘焦点）
      const st = { rev: 1, cards: '["a"]' };
      const winK1 = homeCardsRegionKey({ gate: { isOn: () => true } } as never, st);
      const winK2 = homeCardsRegionKey({ gate: { isOn: () => true } } as never, { rev: 2, cards: '["a"]' });
      eq(winK1, winK2, '窗档：rev 变 key 不变（不吃 index —— 重画会摘编辑器的焦点）');
      const rowK1 = homeCardsRegionKey({ gate: { isOn: () => false } } as never, st);
      const rowK2 = homeCardsRegionKey({ gate: { isOn: () => false } } as never, { rev: 2, cards: '["a"]' });
      ok(rowK1 !== rowK2, '行卡档：rev 变 key 变（行要跟着索引新）');
      ok(winK1 !== rowK1, '两档的 key 不同（翻开关必重画一次）');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2d · 图谱卡（16.9-a）', async () => {
    await suite.it('核心插件关着 → 整卡自隐；开着 → 真挂 + 过滤注入', async () => {
      await resetShared();
      // ⚠️ 先关核心插件**再**重建块（块是"重建时判一次"的 —— 先建后关不会自动翻）
      const restore = app.internalPlugins.plugins.graph;
      app.internalPlugins.plugins.graph = { enabled: false };
      await showOnly(plugin, ['graphlink']);
      await ensureHome(plugin);
      await H.settle(150);
      const hiddenBox = blockBox('graphlink');
      ok(hiddenBox === null || (hiddenBox as HTMLElement).hidden === true, '核心关着 → 整卡自隐（不摆故障页）');

      app.internalPlugins.plugins.graph = { enabled: true };
      // 重挂：块没重建的入口 —— 用 mountBlocks 那条真路（切显隐再切回来不如直接切走切回）
      const navB = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
        H.textOf(n).includes('全部笔记'),
      );
      H.click(navB as Element);
      await H.settle(200);
      await ensureHome(plugin);
      await H.settle(400);
      const box = blockBox('graphlink') as HTMLElement | null;
      ok(box && !box.hidden, '核心开着 → 整卡画出来');
      const stage = H.maybe<HTMLElement>(box as HTMLElement, '.kbw-hgraph-stage');
      ok(stage, '有图谱画布宿主（复用 .kbw-graph-stage 的那套作用域规则）');
      const view = (stage as unknown as { kbwGraphView?: { setQueryCalls?: unknown[] } } | undefined)
        ?.kbwGraphView;
      ok(view, '裸叶真的挂上了（探针把手 = kbwGraphView）');
      ok(
        Array.isArray(view?.setQueryCalls) && view.setQueryCalls.length > 0,
        '与图谱模块同一套：挂上后注入了过滤（setQuery 收到排除串）',
      );
      const q = JSON.stringify(view?.setQueryCalls?.[0] ?? []);
      contains(q, '02_旧知识库', '过滤里排旧库');
      contains(q, '操作日志', '过滤里排操作日志（日志目录从设置取，不写死）');

      // 收尾：切走 → 叶 detach
      const graphBefore = leavesOfType('graph').length;
      H.click(navB as Element);
      await H.settle(300);
      ok(
        await H.until(() => leavesOfType('graph').length < graphBefore, 1500),
        '切走 → 图谱裸叶 detach（与模块同一条收尾）',
      );
      app.internalPlugins.plugins.graph = restore;
      await resetShared();
    });

    await suite.it('图谱卡：挂失败 → 一行说明 +「重试」；工厂回来重试即恢复', async () => {
      await resetShared();
      await showOnly(plugin, ['graphlink']);
      /**
       * 造"挂失败"：把桩的 graph 视图工厂撤掉 —— `setViewState` 找不到工厂会抛
       *（桩头注明写这条与真机对齐），正好走 `mountGraphInto` 的 `onFail` 那条路。
       */
      const factories = (app as unknown as { __viewFactories: Map<string, unknown> }).__viewFactories;
      const saved = factories.get('graph');
      factories.delete('graph');
      await ensureHome(plugin);
      await H.settle(300);
      const box = blockBox('graphlink') as HTMLElement | null;
      ok(box && !box.hidden, '挂失败不把整卡藏掉（只有"核心插件关着"才自隐）');
      ok(
        await H.until(() => !!H.maybe(box as HTMLElement, '.kbw-hgraph-fail'), 1500),
        '失败说明条出现（一行，不是"去开启"那种整页）',
      );
      contains(H.textOf(H.maybe(box as HTMLElement, '.kbw-hgraph-fail')), '图谱没挂上', '说明写人话');
      factories.set('graph', saved);
      const retry = H.qa<HTMLElement>(box as HTMLElement, '.kbw-hgraph-fail button').find((b) =>
        H.textOf(b).includes('重试'),
      );
      ok(retry, '有条内「重试」');
      H.click(retry as Element);
      ok(
        await H.until(() => !H.maybe(box as HTMLElement, '.kbw-hgraph-fail'), 2000),
        '重试之后失败条收了（就地重挂，不整页重建）',
      );
      // 收尾：切走 detach
      const navB = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
        H.textOf(n).includes('全部笔记'),
      );
      H.click(navB as Element);
      await H.settle(250);
      await resetShared();
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2d · 最近改动（16.9-c 的桥）', async () => {
    await suite.it('桥在 → 小窗（不开标签页）；桥不在/答 false → 退标签页；title 写明两种', async () => {
      await resetShared();
      const REL = `${KB}/00_Inbox/__最近桥.md`;
      await putNote(REL);
      await showOnly(plugin, ['recent']);
      await ensureHome(plugin);
      await H.settle(200);
      const box = blockBox('recent') as HTMLElement;
      const row = H.qa<HTMLElement>(box, '.kbw-rec').find((r) =>
        H.textOf(r).includes('__最近桥'),
      );
      ok(row, '最近改动里有那一篇（mtime 最新）');
      contains(row?.getAttribute('title') ?? '', '小窗', 'title 写明"以小窗打开"');
      contains(row?.getAttribute('title') ?? '', '标签页', 'title 同时写明退路（看板关着 → 新标签页）');

      // ① 桥在：spy 记到 path；不开标签页
      const calls: string[] = [];
      const orig = ctx().openNoteWindow;
      ctx().openNoteWindow = (p: string) => {
        calls.push(p);
        return true;
      };
      const tabsBefore = leavesOfType('markdown').length;
      H.click(row as HTMLElement);
      await H.settle(150);
      deepEq(calls, [REL], '桥收到了这一篇（就这一篇）');
      eq(leavesOfType('markdown').length, tabsBefore, '桥处理了 → **不开**标签页');

      // ② 桥答 false → 退标签页（真机里 = 看板模块关着那条退化路）
      calls.length = 0;
      ctx().openNoteWindow = (p: string) => {
        calls.push(p);
        return false;
      };
      H.click(row as HTMLElement);
      await H.settle(200);
      eq(leavesOfType('markdown').length, tabsBefore + 1, '桥答 false → 退"开标签页"（Q3 的退化口径）');

      // ③ 桥根本没接（离线单测手搓 ctx / 看板关着没装配）→ 同样退标签页
      ctx().openNoteWindow = undefined;
      H.click(row as HTMLElement);
      await H.settle(200);
      eq(leavesOfType('markdown').length, tabsBefore + 2, '没桥 → 也退标签页（缺席 ≠ 报错）');
      ctx().openNoteWindow = orig;
      await dropNote(REL);
      await resetShared();
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2d · 新手清单（16.13）', async () => {
    await suite.it('打勾 = 动作点置位（幂等）；全勾 → 退休自隐', async () => {
      await resetShared();
      // ⚠️ 旗标先归零：前面用例点过视图档（真动作点置位，不是幻觉）—— 这条用例要的是干净起点
      await ctx().settings.save({ onboarding: null, wizardDone: null });
      await showOnly(plugin, ['tutorial']);
      await ensureHome(plugin);
      await H.settle(150);
      const box = blockBox('tutorial') as HTMLElement;
      ok(box && !box.hidden, '起手：向导没走完、三项旗标为空 → 卡片在');
      eq(H.qa<HTMLElement>(box, '.kbw-tut-item').length, 4, '四项（走完向导 / 建过笔记 / 切过视图或进过看板 / 用过搜索或按过 ?）');
      eq(
        H.qa<HTMLElement>(box, '.kbw-tut-item.is-done').length,
        0,
        '一项都没打勾（动作点置位：做过才勾）',
      );

      // 走真实触发路径：搜索输入（notes 模块）→ 'search'
      ctx().goNotes();
      await H.settle(200);
      const search = H.maybe<HTMLInputElement>(document.body, '.kbw-search');
      ok(search, 'notes 的搜索框在');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
      ok(
        await H.until(() => ctx().settings.get().onboarding?.includes('search') === true, 1500),
        '用过搜索 → onboarding 记 search',
      );

      // 向导那项：wizardDone（直接用现成的三态）
      await ctx().settings.save({ wizardDone: true });
      await H.settle(100);
      await ensureHome(plugin);
      await H.settle(200);
      const box2 = blockBox('tutorial') as HTMLElement;
      eq(
        H.qa<HTMLElement>(box2, '.kbw-tut-item.is-done').length,
        2,
        '向导 + 搜索两项打勾（块跟着旗标重画）',
      );

      // 全勾 → 退休
      await ctx().settings.save({ onboarding: ['created', 'view', 'search'] });
      ok(
        await H.until(() => {
          const b = blockBox('tutorial');
          return b === null || (b as HTMLElement).hidden === true;
        }, 1500),
        '四步全完成 → 卡片退休自隐',
      );

      // 重置 → 卡片回来（wizard 那项照旧打勾）
      await ctx().settings.save({ onboarding: null });
      ok(
        await H.until(() => {
          const b = blockBox('tutorial') as HTMLElement | null;
          return !!b && !b.hidden;
        }, 1500),
        '重置 onboard → 卡片回来',
      );
      const box3 = blockBox('tutorial') as HTMLElement;
      eq(H.qa<HTMLElement>(box3, '.kbw-tut-item').length, 4, '四项都在');
      eq(
        H.qa<HTMLElement>(box3, '.kbw-tut-item.is-done').length,
        1,
        '只剩「走完向导」打勾（wizardDone 不受重置影响）',
      );
      await ctx().settings.save({ wizardDone: null });
      await resetShared();
    });

    await suite.it('全勾那一瞬弹一次完成提示（补全的那一脚是谁都认；直接写设置不算）', async () => {
      await resetShared();
      __resetNotices();
      // 三项已齐、只差搜索 —— 直接 save 不算"动作"（不弹）；真用一次搜索才弹
      await ctx().settings.save({ wizardDone: true, onboarding: ['created', 'view'] });
      await H.settle(60);
      ok(!H.maybe(document.body, '.kbw-modal'), '设置直接写入不触发（提示只跟"真实动作点"走）');
      ctx().goNotes();
      await H.settle(200);
      const search = H.maybe<HTMLInputElement>(document.body, '.kbw-search');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
      ok(
        await H.until(() => H.maybe(document.body, '.kbw-modal') != null, 1500),
        '最后一脚（用过搜索）→ 弹完成提示',
      );
      // v2（P7.12 · #2 拍定，用户逐字定的）：标题「最后几句话」+ 正文两行
      contains(H.textOf(H.maybe(document.body, '.kbw-modal')), '最后几句话', '标题是「最后几句话」');
      contains(H.textOf(H.maybe(document.body, '.kbw-modal')), '谢谢你体验我做的插件', '第一行');
      contains(H.textOf(H.maybe(document.body, '.kbw-modal')), '教程可在设置中重新观看', '第二行');
      H.keydown(document.body, 'Escape');
      await H.settle(120);
      // 再输入一次（同一项的重复动作）→ 不再弹（幂等：arr 已含 search，transition 不成立）
      __resetNotices();
      search?.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(200);
      ok(!H.maybe(document.body, '.kbw-modal'), '重复的同一项动作 → 不重复弹');

      // "向导是最后一脚"那条路：走的是 `onboardingWizardJustFinished`（wizard.ts 的调用点）
      await ctx().settings.save({ onboarding: null });
      await ctx().settings.save({ onboarding: ['created', 'view', 'search'] });
      ok(!H.maybe(document.body, '.kbw-modal'), '还差向导 → 不弹');
      onboardingWizardJustFinished(ctx());
      ok(
        await H.until(() => H.maybe(document.body, '.kbw-modal') != null, 1500),
        '向导补上最后一脚 → 弹（wizard.ts finish 调的就是这个函数）',
      );
      H.keydown(document.body, 'Escape');
      await H.settle(120);
      await ctx().settings.save({ wizardDone: null });
      await resetShared();
    });

    await suite.it('16.13 置位点（真路径）：快捕 / 新建对话框真走一遍 → created 打上', async () => {
      await resetShared();
      // 只差 created：走真流程之后它才该被点上（独立审 F4a：三条置位点此前无断言）
      await ctx().settings.save({ onboarding: null, wizardDone: true });
      await H.settle(60);
      ok(!(ctx().settings.get().onboarding ?? []).includes('created'), '前提：created 还没打上');

      // ① 快速捕获真流程（capture.ts 快捕那条成功点）
      await ctx().activate();
      await H.settle(80);
      ctx().quickCapture();
      ok(await H.until(() => !!H.maybe(document.body, '.kbw-modal'), 900), '快捕面板开了');
      const qc = H.q<HTMLElement>(document.body, '.kbw-modal');
      const qcTitle = H.q<HTMLInputElement>(qc, '.kbw-form .kbw-input');
      ok(qcTitle, '有标题输入框');
      qcTitle.value = '__置位快捕';
      const go = H.qa<HTMLButtonElement>(qc, 'button').find((b) => H.textOf(b).includes('丢一条'));
      ok(go, '有「丢一条」');
      H.click(go as Element);
      ok(
        await H.until(() => ctx().settings.get().onboarding?.includes('created') === true, 2000),
        '快捕成功 → created 打上',
      );
      await H.settleIndex(app, 300);
      closeAllMenus();
      purgeOverlays();
      await dropNote(`${KB}/00_Inbox/__置位快捕.md`);
      await ctx().settings.save({ lastCapture: null });

      // ② 新建对话框真流程（ui/new-note.ts 的成功点）
      await ctx().settings.save({ onboarding: null });
      await H.settle(60);
      openNewNoteDialog(ctx());
      ok(await H.until(() => !!H.maybe(document.body, '.kbw-modal'), 900), '新建对话框开了');
      const nm = H.q<HTMLElement>(document.body, '.kbw-modal');
      const nmTitle = H.q<HTMLInputElement>(nm, '.kbw-form .kbw-input');
      ok(nmTitle, '有标题输入框');
      nmTitle.value = '__置位新建';
      const mk = H.qa<HTMLButtonElement>(nm, 'button').find((b) => H.textOf(b).includes('新建'));
      ok(mk, '有「新建」');
      H.click(mk as Element);
      ok(
        await H.until(() => ctx().settings.get().onboarding?.includes('created') === true, 2000),
        '新建成功 → created 打上',
      );
      await H.settleIndex(app, 300);
      purgeOverlays();
      await dropNote(`${KB}/00_Inbox/__置位新建.md`);
      await ctx().settings.save({ wizardDone: null });
      await resetShared();
    });

    await suite.it('设置「首页」栏：「重置新手清单」完成过才可用、按下去真清旗标', async () => {
      await resetShared();
      await ctx().settings.save({ wizardDone: true, onboarding: ['created', 'view', 'search'] });
      ctx().openWorkbenchSettings('home');
      await H.settle(150);
      const btn = H.qa<HTMLElement>(document.body, '.kbw-set-bar button').find((b) =>
        H.textOf(b).includes('重置新手清单'),
      );
      ok(btn, '「首页」栏有「重置新手清单」');
      ok(!(btn as HTMLButtonElement).disabled, '完成过 → 可用');

      H.click(btn as HTMLElement);
      ok(
        await H.until(() => ctx().settings.get().onboarding === null, 1500),
        '按下去 → onboarding 清成 null（卡片回来）',
      );
      await H.settle(150);
      const btn2 = H.qa<HTMLElement>(document.body, '.kbw-set-bar button').find((b) =>
        H.textOf(b).includes('重置新手清单'),
      );
      ok((btn2 as HTMLButtonElement).disabled, '重置后 → 置灰（要再全勾一轮才可用）');
      H.keydown(document.body, 'Escape');
      await H.settle(120);
      await ctx().settings.save({ wizardDone: null });
      await resetShared();
    });
  });
}
