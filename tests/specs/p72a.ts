/**
 * spec：**P7.2a 首页区块体系**（§1.2，2026-10-03）
 *
 * 完成定义对应的判据：
 *   · 区块注册表 + 显隐 + 拖序 + 空态隐藏 + 迁移/默认 —— 各有判据 ≥1（本文件）
 *   · 三个新模块 M1 收藏夹 / M4 随机漫步 / M8 教程卡片 —— 各有判据 ≥1
 *
 * ⚠️ **拖拽的落点在 jsdom 里没有布局**（`offsetTop/offsetHeight` 全是 0）——
 * 落点算法的真判据是纯函数 `insertionRowAt`（本文件第一组，多例）；
 * 拖拽那几个用例钉的是**接线**：起手 → 让位元素出现 → 松手落定 + 落盘 / 取消复原。
 *
 * ⚠️ 首尾清场（跨用例污染是本项目栽得最多的那一类）：
 * · `homeBlocks` 是**共享设置** —— 每条用例收尾 `save({ homeBlocks: null })` 回默认；
 * · 拖拽会在全局留 `dragEndedAt`（150ms 吞 click 窗口）—— 用例之间 `settle` 够长；
 * · 菜单/面板收尾要关干净（`closeAllMenus` + Esc；Esc 只问栈顶）。
 */
import fs from 'node:fs';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import type { HomeBlocks } from '../../src/core/settings';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { closeAllMenus } from '../../src/ui/menu';
import { normalizeSettings, migrateSettings } from '../../src/core/settings';
import {
  HOME_BLOCKS,
  insertionRowAt,
  nextSeed,
  pickRandom,
  resolveHomeBlocks,
  swapNeighbor,
} from '../../src/modules/home/blocks';

const KB = '01_新知识库';

/** 当前首页上画着的块序（DOM 事实；别在拖动进行中调它——gap 也带 .kbw-hblock） */
function blockSeq(): string[] {
  return H.qa<HTMLElement>(document.body, '.kbw-hblock')
    .map((b) => b.dataset.block ?? '')
    .filter(Boolean);
}

function blockBox(id: string): HTMLElement | null {
  return H.qa<HTMLElement>(document.body, '.kbw-hblock').find((b) => b.dataset.block === id) ?? null;
}

async function saveBlocks(plugin: KbWorkbenchPlugin, v: HomeBlocks | null): Promise<void> {
  await plugin.context().settings.save({ homeBlocks: v });
  await H.settle(60);
}

/**
 * 每条用例起手：激活工作台 + **切到首页**（KBW_TEST_ONLY 单跑也自足）。
 *
 * 🔴 **别假设"打开工作台就在首页"**：`activeModule` 是**落盘的**，而前面 spec 的
 * group 顶层准备会把它留在别的栏（specNotes 的顶层就 `openNotes()` 过一次 ——
 * 全量跑时 B 库向来停在「全部笔记」）。切回去要**点导航项**（写 settings + store
 * 两边，与 notes.ts 的 `goHome` 同一条纪律），不能 `store.set`（任何一次落盘会把它顶回去）。
 */
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

export async function specP72a(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 显隐/顺序的纯函数（唯一解析口）', async () => {
    await suite.it('resolveHomeBlocks(null)：五老块全开、五新块默认关（"还没动过"）', () => {
      const r = resolveHomeBlocks(null);
      deepEq(
        r.order,
        ['hero', 'quick', 'todo', 'recent', 'foot', 'fav', 'walk', 'tutorial', 'graphlink', 'homeCards'],
        'null = 注册表序（10 块）',
      );
      deepEq(
        [...r.hidden].sort(),
        ['fav', 'graphlink', 'homeCards', 'tutorial', 'walk'].sort(),
        '新模块默认关（P7.2d 起 5 个）',
      );
      eq(r.touched, false, 'touched = 还没动过');
    });

    await suite.it('resolveHomeBlocks(对象)：去重 · 丢不认识的 id · 缺口按注册表序补齐', () => {
      const r = resolveHomeBlocks({
        order: ['todo', 'zzz', 'todo', 'hero'],
        hidden: ['walk', 'zzz'],
      });
      deepEq(
        r.order,
        ['todo', 'hero', 'quick', 'recent', 'foot', 'fav', 'walk', 'tutorial', 'graphlink', 'homeCards'],
        '表里的按表排（去重 + 丢 zzz），没有的按注册表序补到末尾',
      );
      deepEq([...r.hidden], ['walk'], 'hidden 里不认识的 id 丢掉');
      eq(r.touched, true, '动过');
    });

    await suite.it('swapNeighbor：换位 / 到边原样 / 邻居集合过滤', () => {
      deepEq(swapNeighbor(['a', 'b', 'c'], 'b', -1, ['a', 'b', 'c']), ['b', 'a', 'c'], '中间上移');
      deepEq(swapNeighbor(['a', 'b', 'c'], 'a', -1, ['a', 'b', 'c']), ['a', 'b', 'c'], '到顶原样（不循环）');
      deepEq(swapNeighbor(['a', 'b', 'c'], 'c', 1, ['a', 'b', 'c']), ['a', 'b', 'c'], '到底原样');
      deepEq(
        swapNeighbor(['a', 'b', 'c', 'd'], 'c', -1, ['a', 'c', 'd']),
        ['c', 'b', 'a', 'd'],
        '邻居集合过滤：b 不可当邻居 → c 直接和 a 换（首页 ⋯ 菜单"可见邻居"那条口径）',
      );
      deepEq(swapNeighbor(['a', 'b'], 'zzz', 1, ['a', 'b']), ['a', 'b'], '不在表里的 id 原样');
    });

    await suite.it('insertionRowAt：单列插入位（中线判定 / 首尾 / 空表）', () => {
      const rows = [
        { top: 0, height: 100 },
        { top: 100, height: 100 },
        { top: 200, height: 100 },
      ];
      eq(insertionRowAt(rows, 10), 0, '第一块上半 → 最前');
      eq(insertionRowAt(rows, 60), 1, '过第一块中线（>50）→ 插它后面');
      eq(insertionRowAt(rows, 260), 3, '都过了 → 最后');
      eq(insertionRowAt([], 0), 0, '空表 → 0');
    });

    await suite.it('pickRandom：同种子稳定 · 不放回 · n 超池给全部；nextSeed 真推进', () => {
      const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      const a1 = pickRandom(pool, 12345, 3).join(',');
      const a2 = pickRandom(pool, 12345, 3).join(',');
      eq(a1, a2, '同种子 = 同一批（判据可钉，Math.random 做不到）');
      eq(new Set(pickRandom(pool, 999, 5)).size, 5, '不放回抽取');
      deepEq(pickRandom(['x', 'y'], 7, 5).sort(), ['x', 'y'], 'n 超过池子 → 给全部');
      const b2 = pickRandom(pool, nextSeed(12345), 3).join(',');
      ok(a1 !== b2, '换种子（换一批那一步）之后结果真的不同');
      ok(nextSeed(12345) !== 12345, '种子推进');
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 默认形态与拆块（五块搬家不带功能变化）', async () => {
    await suite.it('默认（homeBlocks=null）：五块按注册表序都在，三个新模块都不在', async () => {
      await ensureHome(plugin);
      eq(ctx().settings.get().homeBlocks, null, '前提：还没动过（夹具 data.json 里没这个键）');
      deepEq(blockSeq(), ['hero', 'quick', 'todo', 'recent', 'foot'], '默认 DOM 序');
      // 拆块烟测：五块的内容都在（逐块各点名一件）
      ok(H.maybe(document.body, '.kbw-hblock[data-block="hero"] .kbw-gsearch-input'), 'hero：搜索框在');
      eq(H.qa(document.body, '.kbw-hblock[data-block="quick"] .kbw-qbtn').length, 4, '快捷动作 4 个');
      contains(H.textOf(blockBox('todo')), '待处理', '待处理标题');
      contains(H.textOf(blockBox('recent')), '最近改动', '最近改动标题');
      contains(H.textOf(blockBox('foot')), '库 ', '底部状态');
    });

    await suite.it('homeBlocks 对象落盘 → 重读还在（钉 normalize 的显式 case，防静默丢对象）', async () => {
      const v: HomeBlocks = { order: ['recent', 'hero'], hidden: ['todo'] };
      await saveBlocks(plugin, v);
      const raw = await plugin.loadData();
      const back = normalizeSettings(migrateSettings(raw)).homeBlocks;
      deepEq(back, v, '从磁盘重读后值还在（对象被 default 分支静默丢掉的经典坑）');
      await saveBlocks(plugin, null);
      ok(ctx().settings.get().homeBlocks === null, '恢复默认');
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 显隐与顺序（即时生效）', async () => {
    await suite.it('hidden 里的块不画；移出 hidden 立刻回来', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, { order: HOME_BLOCKS.map((b) => b.id), hidden: ['todo', 'recent'] });
      ok(!blockBox('todo'), 'todo 被隐藏 → 容器不在');
      ok(!blockBox('recent'), 'recent 被隐藏 → 容器不在');
      ok(blockBox('hero'), 'hero 照旧在');

      await saveBlocks(plugin, { order: HOME_BLOCKS.map((b) => b.id), hidden: [] });
      ok(blockBox('todo'), '移出 hidden → 立刻回来');
      ok(blockBox('recent'), '同上');
      await saveBlocks(plugin, null);
    });

    await suite.it('order 决定 DOM 序', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, {
        order: ['foot', 'recent', 'todo', 'quick', 'hero'],
        hidden: [],
      });
      const seq = blockSeq();
      const at = (id: string): number => seq.indexOf(id);
      ok(
        at('foot') < at('recent') && at('recent') < at('todo') && at('todo') < at('quick') && at('quick') < at('hero'),
        `DOM 序应随 order：实际 ${seq.join(',')}`,
      );
      await saveBlocks(plugin, null);
      deepEq(blockSeq().slice(0, 5), ['hero', 'quick', 'todo', 'recent', 'foot'], '恢复默认序');
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 拖序接线（真机落点由探针钉）', async () => {
    await suite.it('拖柄起手 → 空位/浮块出现 → 松手落定 + 落盘', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, null);
      const hero = blockBox('hero');
      ok(hero, '前提：hero 在');
      const grip = H.q<HTMLElement>(hero as HTMLElement, '.kbw-hblock-grip');

      H.pointerDown(grip, { x: 100, y: 100 });
      H.pointerMove(grip, { x: 100, y: 300 }); // > 4px 阈值 → begin
      await H.settle(30);
      ok(H.maybe(document.body, '.kbw-hgap'), '拖动中：空位出现');
      ok(H.maybe(document.body, '.kbw-hfloat'), '拖动中：跟随的浮块出现');
      eq((blockBox('hero') as HTMLElement).style.display, 'none', '原块藏起来（空位替它占地方）');

      H.pointerMove(grip, { x: 100, y: 320 });
      await H.settle(30);
      H.pointerUp(grip, { x: 100, y: 320 });
      await H.settle(30);
      ok(!H.maybe(document.body, '.kbw-hgap'), '松手：空位收了');
      ok(!H.maybe(document.body, '.kbw-hfloat'), '松手：浮块收了');
      ok(await H.until(() => ctx().settings.get().homeBlocks !== null, 1500), '松手后落盘（homeBlocks 从 null 物化）');
      /**
       * ⚠️ jsdom 里 `offsetTop/offsetHeight` 全是 0 → `insertionRowAt` 恒判"插到末尾" ——
       * 这不是产品行为，是**测试环境的几何事实**。落点算法本身由纯函数组钉住，
       * 这里只当"拖动确实跑完了接线"的证据。
       */
      deepEq(
        ctx().settings.get().homeBlocks?.order,
        ['quick', 'todo', 'recent', 'foot', 'hero', 'fav', 'walk', 'tutorial', 'graphlink', 'homeCards'],
        '（jsdom 几何下）hero 被落到可见序末尾；隐藏块按原相对次序接在后面',
      );
      deepEq(
        ctx().settings.get().homeBlocks?.hidden,
        ['fav', 'walk', 'tutorial', 'graphlink', 'homeCards'],
        '物化时把"默认关"也写进 hidden（P7.2d 起 5 个）',
      );
      await saveBlocks(plugin, null);
      await H.settle(220); // 让 dragEndedAt 吞 click 的窗口过期
    });

    await suite.it('落位顺序：先恢复 display 再移动 DOM（图谱卡 iframe 保活的根，P7.2b 补）', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, null);
      const hero = blockBox('hero');
      ok(hero, '前提：hero 在');
      const heroEl = hero as HTMLElement;
      const grip = H.q<HTMLElement>(heroEl, '.kbw-hblock-grip');

      /**
       * 真机取证（P7.2b）：`gap.replaceWith(box)` 移动 DOM 会让 box 里嵌的
       * **真 iframe**（图谱卡）整棵浏览上下文重建 → 平台在 iframe load 里重建
       * canvas 并**当场量尺寸**。若移动这一刻 box 还挂着 display:none，量到
       * 0×0 → 新 canvas 定格空白（用户报的"拖图谱块后内容消失"）。
       * jsdom 没有 iframe 语义，这条**只钉顺序本身**：蹲在 replaceWith 上，
       * 记录"gap 换出 box"那一刻 box 的 display。顺序被改回去 → 变 'none' → 红。
       */
      const proto = Element.prototype as unknown as { replaceWith: (...n: Node[]) => void };
      const orig = proto.replaceWith;
      let movedN = 0;
      let displayAtMove: string | null = null;
      proto.replaceWith = function (this: Element, ...nodes: Node[]) {
        const gapEl = this as HTMLElement;
        if (gapEl.classList?.contains('kbw-hgap') && nodes[0] === heroEl) {
          movedN += 1;
          displayAtMove = heroEl.style.display;
        }
        return orig.apply(this, nodes);
      };
      try {
        H.pointerDown(grip, { x: 100, y: 100 });
        H.pointerMove(grip, { x: 100, y: 300 });
        await H.settle(30);
        H.pointerMove(grip, { x: 100, y: 320 });
        await H.settle(30);
        H.pointerUp(grip, { x: 100, y: 320 });
        await H.settle(30);
      } finally {
        proto.replaceWith = orig;
      }
      eq(movedN, 1, '前提：落位走的就是 gap.replaceWith(box)（实现形状变了这条要重写）');
      eq(displayAtMove, '', '移动那一刻 box 必须已恢复 display（顺序反了 = 真机图谱卡拖后空白）');
      await saveBlocks(plugin, null);
      await H.settle(220);
    });

    await suite.it('取消（pointercancel）→ 顺序不动、DOM 复原', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, null);
      const hero = blockBox('hero');
      ok(hero, '前提：hero 在');
      const grip = H.q<HTMLElement>(hero as HTMLElement, '.kbw-hblock-grip');
      H.pointerDown(grip, { x: 100, y: 100 });
      H.pointerMove(grip, { x: 100, y: 300 });
      await H.settle(30);
      ok(H.maybe(document.body, '.kbw-hgap'), '前提：拖起来了');
      H.pointerCancel(document.body, { x: 100, y: 300 });
      await H.settle(30);
      ok(!H.maybe(document.body, '.kbw-hgap'), '取消：空位收了');
      ok(!H.maybe(document.body, '.kbw-hfloat'), '取消：浮块收了');
      eq((blockBox('hero') as HTMLElement).style.display, '', '原块显示回来');
      eq(ctx().settings.get().homeBlocks, null, '取消 = 什么都没写');
      deepEq(blockSeq().slice(0, 5), ['hero', 'quick', 'todo', 'recent', 'foot'], 'DOM 序没动');
      await H.settle(220);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 每块的「⋯」菜单（非拖拽等价物）', async () => {
    await suite.it('上移一位：DOM 与落盘同步', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, null);
      const todo = blockBox('todo');
      ok(todo, '前提：todo 在');
      H.click(H.q<HTMLElement>(todo as HTMLElement, '.kbw-hblock-more'));
      await H.settle(40);
      const up = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('上移一位'),
      );
      ok(up, '菜单里有「上移一位」');
      H.click(up as HTMLElement);
      await H.settle(60);
      const seq = blockSeq();
      ok(seq.indexOf('todo') < seq.indexOf('quick'), `上移后 todo 应在 quick 前：实际 ${seq.join(',')}`);
      ok(
        await H.until(
          () =>
            (ctx().settings.get().homeBlocks?.order ?? []).indexOf('todo') <
            (ctx().settings.get().homeBlocks?.order ?? []).indexOf('quick'),
          1500,
        ),
        '顺序落盘',
      );
      closeAllMenus();
      await saveBlocks(plugin, null);
    });

    await suite.it('到顶置灰（写明原因）；「隐藏这块」→ 块消失 + hidden 落盘 + 通知给找回的路', async () => {
      const hero = blockBox('hero');
      ok(hero, '前提：hero 在');
      H.click(H.q<HTMLElement>(hero as HTMLElement, '.kbw-hblock-more'));
      await H.settle(40);
      const up = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('上移一位'),
      );
      ok(up?.classList.contains('is-disabled'), '第一块再上移 → 置灰');
      contains(H.textOf(up), '最上面', '置灰要写明原因（"改不动就别留着"的反面）');

      const hide = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('隐藏这块'),
      );
      ok(hide, '菜单里有「隐藏这块」');
      H.click(hide as HTMLElement);
      await H.settle(60);
      ok(!blockBox('hero'), '隐藏后容器没了');
      ok(
        await H.until(() => ctx().settings.get().homeBlocks?.hidden.includes('hero') === true, 1500),
        'hidden 落盘',
      );
      const notices = H.textOf(H.maybe(document.body, '.kbw-notices'));
      ok(notices.includes('已隐藏'), `要有"已隐藏"通知：实际「${notices}」`);
      ok(notices.includes('设置'), '通知里给找回的路（设置 → 首页）');
      closeAllMenus();
      await saveBlocks(plugin, null);
      ok(blockBox('hero'), '恢复默认后 hero 回来');
    });

    /**
     * **P7.7 收（用户真机 2026-10-05：「首页右键无法直接对首页组件进行设置」）**：
     * 组件上右键 → **这块的菜单**（⋯ 同款 + 「首页设置…」）；空白处 → 全局菜单（§8.1 不变）。
     */
    await suite.it('组件上右键 = 这块的菜单（含「首页设置…」）· 空白处右键 = 全局菜单', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, null);
      const todo = blockBox('todo');
      ok(todo, '前提：todo 在');
      const rightClick = (el: Element): void => {
        el.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
        );
      };
      // ① 段头标题上右键 → 这块的菜单：作用范围 = 块名，⋯ 同款项 +「首页设置…」
      const h3 = H.q<HTMLElement>(todo as HTMLElement, '.kbw-sec-head h3');
      rightClick(h3);
      await H.settle(40);
      contains(H.textOf(H.q<HTMLElement>(document.body, '.kbw-menu-scope')), '待处理', '作用范围 = 这一块');
      const set = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('首页设置'),
      );
      ok(set, '菜单里有「首页设置…」');
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) =>
          H.textOf(i).includes('上移一位'),
        ),
        '⋯ 同款项（上移一位）也在',
      );
      H.click(set as HTMLElement);
      await H.settle(140);
      ok(H.maybe(document.body, '.kbw-modal'), '「首页设置…」打开设置面板');
      const tab = H.q<HTMLElement>(document.body, '.kbw-set-tab[data-section="home"]');
      ok(tab.classList.contains('is-on'), '落在「首页」栏');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      closeAllMenus();
      // ② 待处理行上右键 → **「这一项」菜单**（P7.11 · #4 改的口径：行上另起一扇、
      //    与块菜单不叠 —— 作用范围那一行 = 这一项的文案，不是块名）
      const row = H.q<HTMLElement>(todo as HTMLElement, '.kbw-todo-t');
      ok(row, '前提：待处理行在');
      rightClick(row);
      await H.settle(40);
      const rowScope = H.textOf(H.q<HTMLElement>(document.body, '.kbw-menu-scope'));
      ok(!rowScope.includes('待处理'), `行上是「这一项」菜单（不是块菜单）：作用范围「${rowScope}」`);
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) =>
          H.textOf(i).includes('处理这一项'),
        ),
        '行菜单里有「处理这一项」',
      );
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) =>
          H.textOf(i).includes('忽略这一项'),
        ),
        '行菜单里有「忽略这一项」（Q3）',
      );
      closeAllMenus();
      // ③ 空白处（宿根本身）→ 全局菜单：作用范围 = 首页
      const host = (todo as HTMLElement).parentElement;
      ok(host, '前提：宿根在');
      rightClick(host as Element);
      await H.settle(40);
      contains(H.textOf(H.q<HTMLElement>(document.body, '.kbw-menu-scope')), '首页', '空白处 = 首页全局菜单');
      ok(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) =>
          H.textOf(i).includes('快速捕获'),
        ),
        '全局菜单项在（快速捕获）',
      );
      closeAllMenus();
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 全隐空态（给动作）', async () => {
    await suite.it('全部隐藏 → 空态 + 「显示模块」→ 打开设置面板「首页」栏', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, {
        order: HOME_BLOCKS.map((b) => b.id),
        hidden: HOME_BLOCKS.map((b) => b.id),
      });
      const empty = H.maybe<HTMLElement>(document.body, '.kbw-empty');
      ok(empty, '全隐 → 空态在（不是白板）');
      const btn = H.qa<HTMLElement>(empty as HTMLElement, 'button').find((b) =>
        H.textOf(b).includes('显示模块'),
      );
      ok(btn, '空态给一个动作（照 ui/empty.ts 的纪律）');
      H.click(btn as HTMLElement);
      await H.settle(120);
      ok(H.maybe(document.body, '.kbw-modal'), '面板打开了');
      const tab = H.q<HTMLElement>(document.body, '.kbw-set-tab[data-section="home"]');
      ok(tab.classList.contains('is-on'), '落在「首页」栏（不是第一栏）');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      await saveBlocks(plugin, null);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 设置「首页」栏（开关 + ↑↓ + 恢复默认）', async () => {
    await suite.it('十行都在；开关与 ↑↓ 真实落盘；「全部恢复默认」回 null', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, null);
      ctx().openWorkbenchSettings('home');
      await H.settle(120);
      const rows = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-set-body .kbw-set-row');
      eq(rows().length, 10, '十个区块各一行（P7.2d 起：五老 + 五新）');
      const todoRow = rows().find((r) => H.textOf(r).includes('待处理'));
      ok(todoRow, '有「待处理」行');
      // 开→关：hidden 应含 todo
      H.click(H.q<HTMLElement>(todoRow as HTMLElement, '.kbw-switch'));
      await H.settle(80);
      ok(
        await H.until(() => ctx().settings.get().homeBlocks?.hidden.includes('todo') === true, 1500),
        '开关 → hidden 含 todo（落盘）',
      );

      // ↑：把「最近改动」往上挪一位（重取行：栏重画过了）
      const recentRow = rows().find((r) => H.textOf(r).includes('最近改动'));
      ok(recentRow, '重画后仍有「最近改动」行');
      const before = (ctx().settings.get().homeBlocks?.order ?? []).indexOf('recent');
      const upBtn = H.qa<HTMLElement>(recentRow as HTMLElement, 'button').find((b) => H.textOf(b) === '↑');
      ok(upBtn, '有 ↑ 按钮');
      H.click(upBtn as HTMLElement);
      await H.settle(80);
      ok(
        await H.until(
          () => (ctx().settings.get().homeBlocks?.order ?? []).indexOf('recent') === before - 1,
          1500,
        ),
        '↑ → order 前移一位',
      );

      // 全部恢复默认
      const reset = H.qa<HTMLElement>(document.body, '.kbw-set-body button').find((b) =>
        H.textOf(b).includes('全部恢复默认'),
      );
      ok(reset, '有「全部恢复默认」');
      H.click(reset as HTMLElement);
      await H.settle(80);
      ok(await H.until(() => ctx().settings.get().homeBlocks === null, 1500), '恢复默认 = homeBlocks 回 null');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 三个新模块', async () => {
    await suite.it('M1 收藏夹：没收藏 → 容器自隐；有收藏 → 画行；取消后又自隐', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, { order: HOME_BLOCKS.map((b) => b.id), hidden: ['walk', 'tutorial'] });
      const box = blockBox('fav');
      ok(box, 'fav 容器在（打开了）');
      ok((box as HTMLElement).hidden === true, '一篇收藏都没有 → 容器自隐（D3：渲染后自报）');

      const rel = `${KB}/00_Inbox/__探针收藏.md`;
      H.writeNote(vaultRoot, rel, H.note('# 探针收藏\n', { 收藏: true }));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      ok(
        await H.until(() => {
          const b = blockBox('fav');
          return b !== null && b.hidden === false;
        }, 1500),
        '有一篇收藏 → 容器显示出来',
      );
      contains(H.textOf(blockBox('fav')), '探针收藏', '行里就是那一篇');

      /**
       * 取消收藏走**应用自己的写路径**（与右键「取消收藏」同一条 `fm.setMany`）——
       * 裸 `writeNote + rescan` 的事件链不完整（第一次新建能过，改值那次
       * metadataCache 的滞后 + 索引 debounce 对不上，until 会空等超时）。
       */
      await ctx().fm.setMany(H.fileAt(app, rel), { 收藏: false });
      await H.settleIndex(app);
      ok(
        await H.until(() => (blockBox('fav') as HTMLElement | null)?.hidden === true, 2500),
        '取消收藏 → 又自隐回去',
      );
      // 清场
      fs.rmSync(`${vaultRoot}/${rel}`, { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(80);
      await saveBlocks(plugin, null);
    });

    await suite.it('M4 随机漫步：3 行来自全库；「换一批」不重画整页', async () => {
      await ensureHome(plugin);
      await saveBlocks(plugin, { order: HOME_BLOCKS.map((b) => b.id), hidden: ['fav', 'tutorial'] });
      const box = blockBox('walk');
      ok(box, 'walk 容器在');
      ok((box as HTMLElement).hidden === false, '库里有笔记 → 显示');
      const rows = (): HTMLElement[] => H.qa<HTMLElement>(blockBox('walk') as HTMLElement, '.kbw-rec');
      eq(rows().length, 3, '一次 3 篇');
      const paths = new Set(ctx().index.notes().map((e) => e.path));
      for (const r of rows()) {
        ok(paths.has(H.q<HTMLElement>(r, '.kbw-rec-n').title), '抽出来的每一篇都来自全库（不是编的）');
      }
      // 「换一批」：行数不变、页面没被整块重画（拿 hero 的搜索框实例当哨兵）
      const heroInput = H.q<HTMLElement>(document.body, '.kbw-hblock[data-block="hero"] .kbw-gsearch-input');
      const refresh = H.q<HTMLElement>(box as HTMLElement, '.kbw-walk-refresh');
      H.click(refresh);
      await H.settle(60);
      eq(rows().length, 3, '换一批之后还是 3 行');
      ok(heroInput.isConnected, '整页没被重画（hero 的搜索框还是同一个实例）');
      await saveBlocks(plugin, null);
    });

    await suite.it('M8 教程卡片：壳在；「看教程」→ 设置面板「帮助」栏', async () => {
      // 独立审查 🟡5：全组唯一漏了 ensureHome 的用例 —— 单跑时 activeModule 停在上一个
      // spec 留下的栏，会假红（全量跑因为前一条刚切过首页而侥幸绿）
      await ensureHome(plugin);
      await saveBlocks(plugin, { order: HOME_BLOCKS.map((b) => b.id), hidden: ['fav', 'walk'] });
      const box = blockBox('tutorial');
      ok(box, 'tutorial 容器在');
      ok(H.maybe(box as HTMLElement, '.kbw-tut'), '教程卡（壳）画出来了');
      const view = H.qa<HTMLElement>(box as HTMLElement, 'button').find((b) =>
        H.textOf(b).includes('看教程'),
      );
      ok(view, '有「看教程」');
      H.click(view as HTMLElement);
      await H.settle(120);
      ok(H.maybe(document.body, '.kbw-modal'), '打开设置面板');
      const tab = H.q<HTMLElement>(document.body, '.kbw-set-tab[data-section="help"]');
      ok(tab.classList.contains('is-on'), '落在「帮助」栏');
      // P7.2b：落点已经改到**教程中心第一篇**（打开即展开）——「壳暂落帮助栏」的口子销账
      const first = H.qa<HTMLElement>(document.body, '.kbw-tut-card')[0];
      ok(first?.classList.contains('is-open'), '「看教程」打开即展开教程第一篇（2b 改的落点）');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      await saveBlocks(plugin, null);
    });
  });

  // ────────────────────────────────────────────────────────────
  await suite.group('P7.2a · 收藏入口（笔记右键「其他」组，G2-a 配套）', async () => {
    await suite.it('右键「收藏」→ 文件写 收藏: true；再点「取消收藏」→ 写回 false', async () => {
      await ensureHome(plugin);
      const rel = `${KB}/00_Inbox/__探针右键收藏.md`;
      H.writeNote(vaultRoot, rel, H.note('# 右键收藏\n'));
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);

      // 进「全部笔记」，列表只画本层 → 站进 00_Inbox
      ctx().goNotes({ dir: '00_Inbox' });
      await H.settle(150);
      /**
       * 🔴 **声明视图档前提**（P7.1c 探针教训的离线镜像）：前面的 spec 可能把
       * 「全部笔记」的视图档留在网格（那是**落盘偏好**）——而本用例要右键的是
       * **详细档的行**（`.kbw-trow`）。不声明的话全量跑（前面 spec 动过档位）会
       * 找不到行，而单跑子集（前面 it 全 skip）永远绿 —— "子集绿、全量红"的经典形态。
       */
      const segDetail = H.qa<HTMLElement>(document.body, '.kbw-seg button').find((b) =>
        H.textOf(b).includes('详细信息'),
      );
      if (segDetail && !segDetail.classList.contains('is-on')) {
        H.click(segDetail);
        await H.settle(250);
      }
      // 等列表把那一行画出来（机器忙时一轮未必够 —— 别写死短 settle）
      await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-trow').some((r) => r.dataset.path === rel),
        2500,
      );
      const openFavItem = async (label: string): Promise<HTMLElement> => {
        const row = H.qa<HTMLElement>(document.body, '.kbw-trow').find((r) => r.dataset.path === rel);
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
        const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes(label),
        );
        ok(item, `子菜单里有「${label}」`);
        return item as HTMLElement;
      };

      H.click(await openFavItem('收藏'));
      await H.settle(80);
      ok(await H.until(() => H.readNote(vaultRoot, rel).includes('收藏: true'), 2000), '文件里写进了 收藏: true');

      // 反向：现在应显示「取消收藏」
      closeAllMenus();
      await H.settleIndex(app);
      H.click(await openFavItem('取消收藏'));
      await H.settle(80);
      ok(await H.until(() => H.readNote(vaultRoot, rel).includes('收藏: false'), 2000), '写回 false');

      // 清场
      closeAllMenus();
      fs.rmSync(`${vaultRoot}/${rel}`, { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settle(80);
    });
  });
}
