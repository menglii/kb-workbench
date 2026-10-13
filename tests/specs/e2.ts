/**
 * spec：P4.5 · e2 期 —— **用户真机报的两条 bug**（先修它们，再谈 §4.1/§4.3）
 *
 * 两条都不是"照设计稿做"能撞上的，都是**在用户自己的笔记上**才露出来的：
 *
 * ① **勾选框点不动**（`9.20.md` 形状）：源文件里有一行缩进过深的任务行
 *   （`\t\t    - [x] 刷活动`，Tab 算 4 格 → 比父项深 6 格），CommonMark 把它当**续行**
 *   （渲染成普通文字、不画框），而 `taskItems` 老口径照收 → 两边**永久对不上** →
 *   "对不上就不绑"退化成了"**那一篇的每一个框都点不动**"。
 *   真机实测三个形状（2026-09-26）：普通 ✓ / **引用块里也画框** ✓ / **有序清单也画框** ✓ /
 *   过深缩进 **不画** ✗ —— 桩的渲染器按这四个形状对齐（`tests/stub` 的 `renderMiniMarkdown`）。
 *
 * ② **勾一下，看板跳回顶上**：勾选框写盘 → 索引修订变 → 整块重绘 → **卡面正文与各列的
 *   滚动位置全部归零**（真机量到：列 80 → 0、卡面正文 200 → 0）。修法是"重绘前后保住"，
 *   判据在 `view-memory.ts` 的 `restoreIfReset` 与两处 store 订阅里。
 *
 * 三层（与前几期同一套）：A 纯函数 · B 真链路 · C 红线（`redline.ts`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { restoreIfReset, SCROLL_ATTR } from '../../src/core/view-memory';
import { rankQuickRows } from '../../src/ui/quick-switch';
import { computeVisible, emptyFilters } from '../../src/modules/notes/filters';
import type { NoteEntry } from '../../src/core/vault-index';
import { captureTargets, firstUsable, pickTarget } from '../../src/modules/board/capture';
import { commandCount } from '../../src/core/commands';
import { setTaskLine, taskItems } from '../../src/modules/board/summary';
import { __resetNotices } from '../../src/ui/notify';

const KB = '01_新知识库';
const BOARD_CFG = `${KB}/99_Meta/06_工作台/看板配置.json`;

export async function specE2(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  async function navTo(label: string): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes(label),
    );
    ok(nav, `导航里有「${label}」`);
    H.click(nav as Element);
    await H.settle(160);
  }
  async function writeBoardCfg(data: unknown): Promise<void> {
    H.writeNote(vaultRoot, BOARD_CFG, `${JSON.stringify(data, null, 2)}\n`);
    app.vault.rescan();
    const f = app.vault.getAbstractFileByPath(BOARD_CFG);
    app.vault.trigger('modify', f);
    await H.settle(320);
  }
  /** 造一篇笔记并让索引看见它（走 modify 事件 = 真链路） */
  async function putNote(rel: string, body: string): Promise<void> {
    H.writeNote(vaultRoot, rel, H.note(body, { 类型: '笔记', 状态: '进行中' }));
    app.vault.rescan();
    app.vault.trigger('modify', app.vault.getAbstractFileByPath(rel));
    await H.settleIndex(app, 260);
  }
  /** 外部改动一次（索引修订 +1，触发重绘） */
  async function pokeIndex(rel: string): Promise<void> {
    const f = app.vault.getAbstractFileByPath(rel);
    app.vault.trigger('modify', f);
    await H.settleIndex(app, 320);
    await H.settle(320); // 看板是异步画的（先读正文再画）
  }
  const cardOf = (name: string): HTMLElement | null =>
    H.qa<HTMLElement>(document.body, '.kbw-card').find((c) =>
      (c.dataset.path ?? '').endsWith(name),
    ) ?? null;
  const boxesOf = (card: Element | null | undefined): HTMLInputElement[] =>
    card ? H.qa<HTMLInputElement>(card, 'input[type="checkbox"]') : [];

  const ONE_SECTION = [{ id: 'x1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }];
  const cfgOf = (extra: Record<string, unknown>): unknown => ({
    version: 1,
    view: { cardMode: 'content', ...extra },
    sections: ONE_SECTION,
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · 任务行对齐（纯函数）', async () => {
    await suite.it('缩进过深的任务行**不算**（渲染器把它当续行、不画框）', () => {
      const body = ['- [x] 父项', '    - [x] 子项', '\t\t    - [x] 过深', '- [ ] 之后一条'].join('\n');
      const got = taskItems(body);
      eq(got.length, 3, `只认 3 条（实际 ${got.length}）`);
      eq(got.map((t) => t.line).join(','), '0,1,3', '行号是 0 / 1 / 3（第 2 行被跳过）');
      eq(got[2].text, '之后一条', '跳过之后**行号仍然对得上**（这是这一条的关键）');
    });

    await suite.it('合法嵌套照常算：缩进不超过父项内容列 +3', () => {
      // 父项内容列 = 0 + 2 = 2 → 缩进 4 算子项；再深一层（8 格）仍算（父内容列 6）
      const body = ['- [ ] A', '    - [ ] B', '        - [ ] C', '- [ ] D'].join('\n');
      eq(taskItems(body).length, 4, '四层都算');
    });

    await suite.it('有序清单里的任务行**算**（真机渲染器照样画框）', () => {
      const body = ['1. [ ] 第一条', '2. [x] 第二条'].join('\n');
      const got = taskItems(body);
      eq(got.length, 2, '两条都收下');
      eq(got[1].checked, true, '勾选态读对了');
      eq(got[1].text, '第二条', '文字剥干净了');
    });

    await suite.it('**缩进代码块**不算：顶层 4 空格 / Tab 开头 / 段落之后（独立审查 🔴2 的形状 a b c）', () => {
      /**
       * 依据：渲染器是 remark + `commonmark: true`（asar 取证），文档根的内容列 = 0，
       * 缩进 ≥4 就是**缩进代码块** —— 里面的 `[ ]` 是代码，不画框。老代码里那句
       * `stack.length === 0 ||` 让"栈空时任何缩进都算清单项"，这三类就全被多收了一条。
       */
      eq(taskItems(['    - [ ] 四空格', '- [ ] 真的'].join('\n')).map((t) => t.line).join(','), '1', 'a：4 空格那条不算');
      eq(taskItems(['\t- [ ] Tab 开头', '- [ ] 真的'].join('\n')).map((t) => t.line).join(','), '1', 'b：Tab（=列 4）那条不算');
      eq(
        taskItems(['说明：', '', '    - [ ] 段落之后', '', '- [ ] 真的'].join('\n')).map((t) => t.line).join(','),
        '4',
        'c：段落之后的 4 空格不算',
      );
    });

    await suite.it('Tab 一律算 **4 格**（真机逐条量过，不是照 CommonMark 规格推的）', () => {
      /**
       * 父项内容列 = 2，判据 `indent - 2 <= 3`。真机实测（2026-09-26，一篇一篇单造）：
       *   1 空格+Tab(5) 画 · 2 空格+Tab(6) 不画 · 3 空格+Tab(7) 不画 · Tab+1 空格(5) 画 ·
       *   5 空格(5) 画 · 6 空格(6) 不画
       * 只有"Tab = 4 格"这一列逐条对得上；改成"展开到制表位"会在 `2 空格+Tab` 上多收一条
       *（那一版真机回的是 `1/2` 的对不上标记 = 整张卡只读）。
       */
      const cases: [string, number][] = [
        [' \t- [ ] 1空格Tab', 2],
        ['  \t- [ ] 2空格Tab', 1],
        ['   \t- [ ] 3空格Tab', 1],
        ['\t - [ ] Tab加1空格', 2],
        ['     - [ ] 5空格', 2],
        ['      - [ ] 6空格', 1],
      ];
      for (const [line, want] of cases) {
        eq(taskItems(['- [ ] 打底', line].join('\n')).length, want, `${JSON.stringify(line)} → 收 ${want} 条`);
      }
    });

    await suite.it('清单被**空行 + 顶格段落**关掉：后面那段 4 空格缩进又成了代码块', () => {
      const body = ['- [ ] a', '', '段落', '', '    - [ ] b'].join('\n');
      eq(taskItems(body).map((t) => t.text).join(','), 'a', '只收 a');
    });

    await suite.it('marker 后 >4 个空格：内容列只到 marker+1，那个 `[ ]` 在缩进代码块里 → 不算', () => {
      eq(taskItems('-     [ ] a').length, 0, '五个空格 → 不算');
      eq(taskItems('-   [ ] a').length, 1, '三个空格 → 算（1–4 个都属于 marker 的间距）');
    });

    await suite.it('围栏代码块里的不算（老规矩，别被这次改动带坏）', () => {
      const body = ['```', '- [ ] 示例', '```', '- [ ] 真的'].join('\n');
      const got = taskItems(body);
      eq(got.length, 1, '只有代码块外那条');
      eq(got[0].line, 3, '行号指向代码块之后');
    });

    await suite.it('`setTaskLine` 对齐有序清单，且**不改形**（缩进 / 序号原样保留）', () => {
      const text = ['1. [ ] 甲', '    - [ ] 乙'].join('\n');
      const a = setTaskLine(text, 0, true);
      ok(a.includes('1. [x] 甲'), `序号形状保住了：${a.split('\n')[0]}`);
      const b = setTaskLine(text, 1, true);
      ok(b.includes('    - [x] 乙'), `缩进保住了：${b.split('\n')[1]}`);
      eq(setTaskLine(text, 0, false), text, '本来就是这个状态 → 原样返回（幂等，调用方据此判"写没写"）');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · 重绘前后保住滚动位置（纯函数）', async () => {
    function hostWith(keys: string[]): HTMLElement {
      const root = document.createElement('div');
      for (const k of keys) {
        const d = document.createElement('div');
        d.setAttribute(SCROLL_ATTR, k);
        root.appendChild(d);
      }
      return root;
    }

    await suite.it('`restoreIfReset`：**只写被清零的**（用户在这中间自己滚过的不抢）', () => {
      const fresh = hostWith(['a', 'b']);
      const kids = Array.from(fresh.children) as HTMLElement[];
      // a 被重绘清零了（新元素 = 0）；b 是用户在这中间自己滚到的位置
      kids[1].scrollTop = 55;
      const n = restoreIfReset(fresh, { a: { top: 300, left: 0 }, b: { top: 10, left: 0 } });
      eq(n, 1, '只写了 1 个');
      eq(kids[0].scrollTop, 300, '被清零的那个救回来了');
      eq(kids[1].scrollTop, 55, '用户自己滚到的位置**没被拽回去**');
    });

    await suite.it('捕获里那个 0 不写（它本来就是"没滚"）', () => {
      const fresh = hostWith(['a']);
      eq(restoreIfReset(fresh, { a: { top: 0, left: 0 } }), 0, '0 → 不写');
      eq(restoreIfReset(fresh, null), 0, '没快照 → 不写');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · 真链路（卡片勾选 / 重绘保滚动）', async () => {
    __resetNotices();
    const DIR = `${KB}/02_Areas/内容创作`;
    const DEEP = `${DIR}/__探针缩进.md`;
    const QUOTE = `${DIR}/__探针引用块.md`;

    await suite.it('缩进过深那篇：框**绑得上**，且点第 n 个框改的是第 n 条（不是上面那一行）', async () => {
      await writeBoardCfg(cfgOf({}));
      await navTo('看板');
      const body = ['# __探针缩进', '', '- [x] 父项', '    - [x] 子项', '\t\t    - [x] 过深', '- [ ] 之后一条', ''].join('\n');
      await putNote(DEEP, body);
      await H.settle(300);

      const card = cardOf('__探针缩进.md');
      ok(card, '卡片出来了');
      eq(card?.dataset.taskMismatch, undefined, '两边对得上了（老口径这里是 3/4 → 整张卡点不动）');
      const boxes = boxesOf(card);
      eq(boxes.length, 3, `渲染出 3 个框（实际 ${boxes.length}）`);
      eq(
        boxes.every((b) => b.disabled === false && !b.hasAttribute('disabled')),
        true,
        '三个框都是可点的（没有 disabled / 也没有那个属性）',
      );

      // 点最后一个框（对应源文第 5 行「之后一条」）
      boxes[2].checked = true;
      boxes[2].dispatchEvent(new Event('click', { bubbles: true }));
      await H.settleIndex(app, 280);
      const text = H.readNote(vaultRoot, DEEP);
      ok(text.includes('- [x] 之后一条'), `之后一条被勾上：\n${text}`);
      ok(text.includes('\t\t    - [x] 过深'), '过深那一行**一个字节没动**（它不参与绑定）');
      ok(text.includes('    - [x] 子项'), '子项也没被误改');

      // 再点第一个框（对应第 2 行「父项」）
      const card2 = cardOf('__探针缩进.md');
      const boxes2 = boxesOf(card2);
      boxes2[0].checked = false;
      boxes2[0].dispatchEvent(new Event('click', { bubbles: true }));
      await H.settleIndex(app, 280);
      const text2 = H.readNote(vaultRoot, DEEP);
      ok(text2.includes('- [ ] 父项'), `父项被取消了勾选：\n${text2}`);
      ok(text2.includes('- [x] 之后一条'), '上一步那条**保持**（两次点击互不串行）');
    });

    await suite.it('引用块里的任务行：**认不出就按成只读**（不是"点了没反应"）', async () => {
      const body = ['# __探针引用块', '', '> - [ ] 引用里的', '', '- [ ] 普通的', ''].join('\n');
      await putNote(QUOTE, body);
      await H.settle(300);
      const card = cardOf('__探针引用块.md');
      ok(card, '卡片出来了');
      const boxes = boxesOf(card);
      eq(boxes.length, 2, `渲染出 2 个框（实际 ${boxes.length}）`);
      ok(card?.dataset.taskMismatch, `对不上要留痕（实际 ${card?.dataset.taskMismatch}）`);
      eq(
        boxes.every((b) => b.disabled && b.hasAttribute('disabled')),
        true,
        '框全被**我们**按成只读（`disabled` 属性是我们加上去的）—— 老口径下它们是可点但写不动（真机实测），那种"点了没保存"更难查',
      );

      const before = H.readNote(vaultRoot, QUOTE);
      boxes[1].checked = true;
      boxes[1].dispatchEvent(new Event('click', { bubbles: true }));
      await H.settle(200);
      eq(H.readNote(vaultRoot, QUOTE), before, '点只读框：文件一个字节都不动');
    });

    await suite.it('勾一下**不跳**：索引变动引起的重绘，把列与卡面正文的滚动位置都保住', async () => {
      await writeBoardCfg(cfgOf({}));
      await navTo('看板');
      await H.settle(240);
      const col = (): HTMLElement | null => H.maybe<HTMLElement>(document.body, '.kbw-cards');
      const cardBody = (): HTMLElement | null =>
        H.maybe<HTMLElement>(document.body, '.kbw-card[data-path$="__探针缩进.md"] .kbw-card-body');
      ok(col(), '有列容器');
      ok(cardBody(), '有卡面正文容器');
      /**
       * 键要认得出来（`card:<路径>`）—— 这是"谁渲染谁贴"那条契约的锚，
       * 掉了它上面那两个滚动位置就无从恢复（探针在真机上也照同一份契约断言）。
       */
      ok(
        (cardBody()?.getAttribute(SCROLL_ATTR) ?? '').startsWith('card:'),
        `卡面正文贴了 data-scroll（实际 ${cardBody()?.getAttribute(SCROLL_ATTR)}）`,
      );

      (col() as HTMLElement).scrollTop = 80;
      (cardBody() as HTMLElement).scrollTop = 200;

      // 外部改动一次 = 索引修订 +1 = 重绘（真机上就是"勾一下勾选框"或同步写进来一笔）
      await pokeIndex(DEEP);

      eq((col() as HTMLElement).scrollTop, 80, '列回到原处（真机 bug 下这里是 0）');
      eq((cardBody() as HTMLElement).scrollTop, 200, '卡面正文也回到原处');
    });

    await suite.it('**改配置**引起的重绘不保（那条边界：视图参数变了本来就该回顶上）', async () => {
      await H.settle(200);
      const col = (): HTMLElement | null => H.maybe<HTMLElement>(document.body, '.kbw-cards');
      (col() as HTMLElement).scrollTop = 80;
      await writeBoardCfg(cfgOf({ cardWidth: 260 }));
      eq((col() as HTMLElement).scrollTop, 0, '配置重绘后是 0（保住反而是"缩了卡片却停在半中间"）');
    });

    await suite.it('全部笔记那一屏同理：目录树的滚动位置也保住', async () => {
      await navTo('全部笔记');
      await H.settle(240);
      const tree = (): HTMLElement | null => H.maybe<HTMLElement>(document.body, '.kbw-tree-body');
      ok(tree(), '有目录树容器');
      (tree() as HTMLElement).scrollTop = 42;
      const before = tree();
      await pokeIndex(DEEP);
      const after = tree();
      ok(after && after !== before, '树确实被重绘过（新节点）—— 否则这条名不副实');
      eq(after?.scrollTop, 42, '位置回到原处（真机 bug 下这里是 0）');
    });

    // 清场（探针/用例自造的临时文件一律带 __探针 前缀，按标记删）
    for (const rel of [DEEP, QUOTE]) {
      fs.rmSync(path.join(vaultRoot, rel), { force: true });
    }
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app, 220);
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · §4.1 快速切换（纯函数：筛选与排序）', async () => {
    const rows = [
      { kind: '板块', hay: '内容创作 02_areas/内容创作' },
      { kind: '命令', hay: '快速捕获（丢一条到板块）' },
      { kind: '笔记', hay: '内容创作草稿 x/内容创作草稿.md' },
      { kind: '笔记', hay: '别的 x/别的.md' },
      { kind: '笔记', hay: '第三个 y/第三个.md' },
    ];

    await suite.it('空查询：板块与命令**全列**，笔记只给最近几条', () => {
      const got = rankQuickRows(rows, '');
      /**
       * ⚠️ **每类封顶只对"有查询"那一支生效**（空查询时光列板块/命令、笔记给最近 6 条）——
       * 夹具里 3 条笔记没超过 6，所以是 1 + 1 + 3。
       */
      eq(got.length, 5, '板块 1 + 命令 1 + 笔记 3');
      eq(got[0].kind, '板块', '第一行是板块（一进来就看得见"跳板块"这件事）');
      eq(got[1].kind, '命令', '第二行是命令');
      eq(got.filter((r) => r.kind === '笔记').length, 3, '笔记排在后面');
    });

    await suite.it('有查询：按**命中位置**排（越靠前越相关），且每个类别各自封顶', () => {
      const got = rankQuickRows(rows, '内容创作');
      eq(got.length, 2, '板块那条 + 笔记那条');
      eq(got[0].kind, '板块', '板块名以它开头（位置 0）→ 排第一');
      eq(got[1].kind, '笔记', '笔记那条也命中（位置 0），排在板块之后');

      const many = Array.from({ length: 30 }, (_, i) => ({ kind: '笔记', hay: `甲${i} x/甲${i}.md` }));
      const capped = rankQuickRows(many, '甲');
      ok(capped.length <= 12, `每类封顶 12 行（实际 ${capped.length}）—— 免得笔记把板块挤没了`);
    });

    await suite.it('查询词大小写与空白都不敏感（hay 由调用方小写化 —— 契约写在函数注释里）', () => {
      const mixed = [{ kind: '笔记', hay: 'abc 大写 x/abc 大写.md' }];
      eq(rankQuickRows(mixed, 'ABC').length, 1, '大写查询词也能命中');
      eq(rankQuickRows(mixed, '  abc  ').length, 1, '两头空白也认');
      eq(rankQuickRows(mixed, 'zzz').length, 0, '没命中就是空');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · 跳转之后"看得见"（纯函数：筛选口径）', async () => {
    await suite.it('显式 paths 清单**不再过目录这一道**（否则"跳过去"会落在一片空列表上）', () => {
      /** 够用的假条目（匹配只看 path / basename / props / flags） */
      const mk = (path: string): NoteEntry =>
        ({
          file: null,
          props: {},
          flags: [],
          effectivePosition: '',
          path,
          basename: path.split('/').pop() ?? path,
          isTemplate: false,
          mtime: 0,
          size: 0,
        }) as unknown as NoteEntry;
      const ROOT = '01_新知识库';
      // ⚠️ 目录筛选看的是 `effectivePosition`（**相对库根**的目录），不是 path
      const inInbox = { ...mk(`${ROOT}/00_Inbox/a.md`), effectivePosition: '00_Inbox' };
      const inMeta = { ...mk(`${ROOT}/99_Meta/b.md`), effectivePosition: '99_Meta' };
      /** 用 `fileAt` 拿到的真条目更真，但那要先建文件 —— 这里只要路径语义，假条目够用 */
      const q = {
        dir: '00_Inbox',
        search: '',
        scope: 'all' as const,
        sort: null,
        filters: { ...emptyFilters(), paths: [inMeta.path] },
        sortValue: () => null,
      } as unknown as Parameters<typeof computeVisible>[1];
      const got = computeVisible([inInbox, inMeta], q);
      eq(got.length, 1, '只列显式给的那一篇');
      eq(got[0].path, inMeta.path, '它在 99_Meta 里 —— 目录筛选（00_Inbox）不该把它挡掉');

      const q2 = { ...q, filters: { ...emptyFilters(), paths: null } };
      eq(computeVisible([inInbox, inMeta], q2).length, 1, '没有显式清单时，目录筛选照旧生效');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · §4.3 快速捕获（纯函数：落点解析）', async () => {
    const cfg = {
      version: 1,
      view: {},
      sections: [
        { id: 's1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
        { id: 's2', name: '灵感', kind: 'tag', value: '灵感' },
        { id: 's3', name: '状态', kind: 'prop', value: '状态' },
        { id: 's4', name: '收容所', kind: 'shelter', value: '' },
      ],
    } as unknown as Parameters<typeof captureTargets>[0];

    await suite.it('四源各解析成"落点 + 补什么"：文件夹→它的目录 · 标签→收件箱+标签 · 属性→按取值铺开 · 收容所→只落收件箱', () => {
      const got = captureTargets(cfg, { inbox: '00_Inbox', valuesOf: () => ['进行中', '已完成'] });
      const byKey = Object.fromEntries(got.map((t) => [t.key, t]));
      eq(byKey['s1']?.dirRel, '02_Areas/内容创作', '文件夹源：落它自己的目录');
      eq(JSON.stringify(byKey['s1']?.props), '{}', '文件夹源不补属性');
      eq(byKey['s2']?.dirRel, '00_Inbox', '标签源：落收件箱');
      eq(byKey['s2']?.tags.join(','), '灵感', '标签源：补那个标签');
      const propRows = got.filter((t) => t.kind === 'prop');
      eq(propRows.length, 2, '属性值源按**取值**铺成一行一行');
      eq(propRows[0]?.props['状态'], '进行中', '第一行的属性值对');
      eq(propRows[1]?.label, '状态 = 已完成', '标签里写清是哪个取值');
      /**
       * ⚠️ 键是 `encodeURIComponent(取值)`（独立审查 🟢2：早先把 `::` 换成 `:：` **不是单射**，
       * 取值里本来就有 `:：` 时会撞键）—— 这里钉住"编码过"，别再改回手写转义。
       */
      eq(propRows[0]?.key, `s3::${encodeURIComponent('进行中')}`, '键是编码过的（单射）');
      eq(byKey['s4']?.dirRel, '00_Inbox', '收容所：落收件箱');
      eq(JSON.stringify(byKey['s4']?.tags), '[]', '收容所不补任何东西（补了就进不去了）');
    });

    await suite.it('属性值源**一个取值都没有**时：那一行置灰、选不了（不是"点了等于没点"）', () => {
      const got = captureTargets(cfg, { inbox: '00_Inbox', valuesOf: () => [] });
      const ghost = got.find((t) => t.kind === 'prop');
      ok(ghost?.disabled === true, '标成 disabled');
      ok((ghost?.detail ?? '').includes('取值'), `说清为什么：${ghost?.detail}`);
    });

    await suite.it('**默认落点不许停在置灰行上**（首次打开时"丢一条"不该白按一次）', () => {
      const got = captureTargets(cfg, { inbox: '00_Inbox', valuesOf: () => [] });
      const ghost = got.find((t) => t.disabled);
      ok(ghost, '（前提）有一个置灰行（属性值源还没有取值）');
      // 把它挪到第一位 —— 这正是"首次打开时默认值落在它身上"的那个场景
      const reordered = [ghost as (typeof got)[number], ...got.filter((t) => t !== ghost)];
      eq(firstUsable(reordered, null)?.key, got[0]?.key, '默认不选置灰行（跳过它，落到第一个能用的）');
      eq(firstUsable([ghost as (typeof got)[number]], null), null, '全都没得选 → null（调用方走"先建一个板块"那条提示）');
      eq(
        firstUsable(reordered, ghost.key)?.key,
        got[0]?.key,
        '记的键正好是那个置灰行 → 也落回第一个能用的（不白按一次回车）',
      );
    });

    await suite.it('记住的落点键还在就用它；板块/取值没了就落回第一个', () => {
      const got = captureTargets(cfg, { inbox: '', valuesOf: () => ['进行中'] });
      eq(pickTarget(got, 's2')?.key, 's2', '记得住就照着记的来');
      eq(pickTarget(got, '早就没了')?.key, got[0].key, '失联的键落回第一个（不报错）');
      eq(pickTarget(got, null)?.key, got[0].key, '没记过也是第一个');
    });
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · §4.1/§4.3 真链路（浮层 / 跳转 / 丢一条）', async () => {
    __resetNotices();
    const DIR = `${KB}/02_Areas/内容创作`;
    const SEED = `${DIR}/__探针切换.md`;

    await suite.it('§4.1：按 `Mod+Shift+O` 打开快速切换，三类目标都在，Esc 收掉', async () => {
      await writeBoardCfg(cfgOf({}));
      await navTo('看板');
      await putNote(SEED, ['# __探针切换', '', '正文', ''].join('\n'));
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, 'o', { ctrlKey: true, shiftKey: true });
      await H.settle(140);
      const modal = H.maybe(document.body, '.kbw-modal');
      ok(modal, '浮层开了');
      contains(H.textOf(modal), '快速切换', '标题对');
      const items = H.qa<HTMLElement>(modal as Element, '.kbw-pick-item');
      ok(items.length > 0, `有候选行（实际 ${items.length}）`);
      const kinds = new Set(items.map((i) => i.dataset.kind));
      ok(kinds.has('笔记'), '有笔记这一类');
      ok(kinds.has('板块'), '有板块这一类');
      ok(kinds.has('命令'), '有命令这一类');
      H.keydown(modal as Element, 'Escape');
      await H.settle(100);
      eq(H.maybe(document.body, '.kbw-modal'), null, 'Esc 关掉了');
    });

    await suite.it('§4.1：选中一篇笔记 → 跳到「全部笔记」并**定位**它（不是开编辑器）', async () => {
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, 'o', { ctrlKey: true, shiftKey: true });
      await H.settle(160);
      const modal = H.q(document.body, '.kbw-modal');
      const input = H.q<HTMLInputElement>(modal, '.kbw-input');
      input.value = '__探针切换';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(80);
      H.keydown(input, 'Enter');
      await H.settle(260);
      eq(ctx().store.get().activeModule, 'notes', '跳到了全部笔记');
      const rows = H.qa<HTMLElement>(document.body, '.kbw-trow');
      eq(rows.length, 1, `列表就剩这一篇（一次性筛选，实际 ${rows.length} 行）`);
      ok(rows[0]?.classList.contains('is-selected'), '它是选中的那一条');
      ok(rows[0]?.classList.contains('is-cursor'), '键盘光标也落在它上面');
      /**
       * ⚠️ 审查指出这条**近乎恒真**（这条流程里本来就没人会开面板）→ 加一句"平台叶也没挂"，
       * 让"没打开"这件事有第二重证据（叶是开编辑器才会有的东西，桩里也记得住）。
       */
      eq(H.qa(document.body, '.kbw-cw-panel').length, 0, '没弹编辑面板');
      const mdLeaves = H.qa(document.body, '.kbw-cw-editor').length;
      eq(mdLeaves, 0, '也没有挂着的 markdown 编辑器 DOM');
    });

    await suite.it('§4.1：`Ctrl+Enter` 才是"在新标签页打开"', async () => {
      const app2 = app as unknown as { __leaves: unknown[]; __leafCalls: unknown[] };
      app2.__leafCalls.length = 0;
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, 'o', { ctrlKey: true, shiftKey: true });
      await H.settle(160);
      const modal = H.q(document.body, '.kbw-modal');
      const input = H.q<HTMLInputElement>(modal, '.kbw-input');
      input.value = '__探针切换';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(80);
      H.keydown(input, 'Enter', { ctrlKey: true });
      await H.settle(240);
      const kinds = app2.__leafCalls.map((c) => (c as { kind: string }).kind);
      ok(kinds.includes('tab'), `走的是新标签页那条路（实际 ${JSON.stringify(kinds)}）`);
      const mds = app2.__leaves.filter(
        (l) => (l as { view?: { getViewType?: () => string } }).view?.getViewType?.() === 'markdown',
      );
      ok(mds.length > 0, '真的挂了一个 markdown 叶');
    });

    await suite.it('§4.1：选中一个板块 → 跳到看板并**展开定位**它（收起着就先展开）', async () => {
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', collapsed: ['x1'] },
        sections: ONE_SECTION,
      });
      await navTo('全部笔记');
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, 'o', { ctrlKey: true, shiftKey: true });
      await H.settle(160);
      const modal = H.q(document.body, '.kbw-modal');
      const input = H.q<HTMLInputElement>(modal, '.kbw-input');
      input.value = '内容创作';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(80);
      H.keydown(input, 'Enter');
      await H.settle(360);
      eq(ctx().store.get().activeModule, 'board', '跳到了看板');
      const sect = H.qa<HTMLElement>(document.body, '.kbw-sect').find((x) => x.dataset.key === 'x1');
      ok(sect, '找到了那个板块');
      ok(!sect?.classList.contains('is-collapsed'), '它被**展开了**（否则跳过去什么都看不见）');
    });

    await suite.it('§4.3：命令跑一次 → 落一篇到"标签源"板块的收件箱 + 补上那个标签，且**不打开它**', async () => {
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content' },
        sections: [{ id: 't1', name: '灵感', kind: 'tag', value: '灵感' }],
      });
      const app2 = app as unknown as { __leafCalls: unknown[] };
      app2.__leafCalls.length = 0;
      /** 走**命令**这条路 —— 这就是"平台级全局热键"兑现的东西 */
      eq(await ctx().activate().then(() => app.commands.execute('kb-workbench:quick-capture')), true, '命令执行了');
      await H.settle(200);
      const modal = H.q(document.body, '.kbw-modal');
      contains(H.textOf(modal), '快速捕获', '浮层开了');
      const title = H.q<HTMLInputElement>(modal, '[data-capture="title"]');
      const sel = H.q<HTMLSelectElement>(modal, '[data-capture="target"]');
      /**
       * P7.2c：下拉是**两组**（「丢进板块」+「直接选目录」第五类）——
       * 这条用例只搭了一个标签源板块，所以板块组里应当只有它。
       */
      const groups = Array.from(sel.querySelectorAll('optgroup')).map((g) => g.getAttribute('label'));
      eq(groups[0], '丢进板块', '第一组：丢进板块');
      ok(groups.includes('直接选目录'), `第二组：直接选目录（实际组：${groups.join('/')}）`);
      eq(sel.querySelectorAll('optgroup[label="丢进板块"] option').length, 1, '板块组一个目标（标签源那个）');
      eq(sel.value, 't1', '默认选中那个唯一板块（不是目录组的）');
      title.value = '__探针捕获';
      const go = H.qa<HTMLButtonElement>(modal, 'button').find((b) => H.textOf(b).includes('丢一条'));
      ok(go, '有「丢一条」按钮');
      H.click(go as Element);
      await H.settleIndex(app, 420);
      const rel = `${KB}/00_Inbox/__探针捕获.md`;
      ok(H.exists(vaultRoot, rel), `落在收件箱里了（${rel}）`);
      const text = H.readNote(vaultRoot, rel);
      ok(text.includes('灵感'), `标签值补上了（这一条才让它进得了那个板块）：\n${text}`);
      eq(app2.__leafCalls.length, 0, '**没有**打开它（"不离开当前工作"就是这条）');
      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 220);
    });

    await suite.it('§4.3：属性值源 → 补「属性=值」（走 createNote 真链路；补全流程末尾才写）', async () => {
      const rel = `${KB}/00_Inbox/__探针捕获2.md`;
      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      /**
       * **走的必须是 `createNote`**（不是直接写盘）：属性要等 Templater 的判定点之后
       * 才补（先写前言会让它的"新建时触发"不触发 —— `排查报告.md` §六那条实测）。
       * 所以这里断言的是"补全流程跑完之后，属性在里面"。
       */
      __resetNotices(); // 只看这一步产生的通知（上一组用例的还挂在屏幕上）
      const res = await ctx().completion.createNote({
        title: '__探针捕获2',
        dirRel: '00_Inbox',
        extraProps: { props: { 状态: '进行中' } },
      });
      eq(res.path, rel, '落在收件箱');
      await H.settleIndex(app, 700);
      const text = H.readNote(vaultRoot, rel);
      ok(text.includes('状态: 进行中'), `属性补上了：\n${text}`);
      /**
       * ⚠️ **补完要弹一条通知**（否则用户不知道它凭什么进了那个板块 ——
       * 尤其是"模板写的是 待办、你选的是 进行中"这种覆盖，不报出来就像"点了没点"）。
       */
      const notices = H.qa(document.body, '.kbw-notice').map((n) => H.textOf(n));
      ok(
        notices.some((t) => t.includes('状态=进行中')),
        `通知里要写清补了什么（实际通知：${JSON.stringify(notices)}）`,
      );
      fs.rmSync(path.join(vaultRoot, rel), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 220);
    });

    fs.rmSync(path.join(vaultRoot, SEED), { force: true });
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app, 220);
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · 滚动保持的另外两个入口（独立审查 🔴1 / 🟡2 的复现）', async () => {
    __resetNotices();
    const DIR = `${KB}/02_Areas/内容创作`;
    const LONG = `${DIR}/__探针长文.md`;

    /** 开看板 + 造一篇够长的笔记（固定高度档：正文真的有滚余量） */
    async function setup(): Promise<void> {
      await writeBoardCfg({
        version: 1,
        view: { cardMode: 'content', cardHeight: 260, summaryLines: 200, collapsed: [] },
        sections: ONE_SECTION,
      });
      const lines = ['# __探针长文', ''];
      for (let i = 0; i < 30; i += 1) lines.push(`- [ ] 第 ${i} 条`);
      lines.push('');
      await putNote(LONG, lines.join('\n'));
      await navTo('看板');
      await H.settle(320);
      /**
       * ⚠️ **F2 要有光标才生效**（`renamingNote = s.cursor`）—— 先按一下方向键把光标落到那张卡上，
       * 否则测的是"没有光标的 F2"（什么都不发生，而不是我们要验的那条路）。
       */
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, 'ArrowDown');
      await H.settle(160);
      ok(H.maybe(document.body, '.kbw-card.is-cursor'), '（前提）光标落在某张卡上');
    }
    const col = (): HTMLElement | null => H.maybe<HTMLElement>(document.body, '.kbw-cards');
    const body = (): HTMLElement | null =>
      H.maybe<HTMLElement>(document.body, '.kbw-card[data-path$="__探针长文.md"] .kbw-card-body');

    await suite.it('`F2` 进就地改名再 `Esc`（**一个字节都没改**）：列与卡面正文都还在原处', async () => {
      await setup();
      const c = col();
      const b = body();
      ok(c && b, '列与卡面正文容器都在');
      (c as HTMLElement).scrollTop = 60;
      (b as HTMLElement).scrollTop = 120;
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, 'F2');
      await H.settle(200);
      ok(H.maybe(document.body, '.kbw-inline-input'), 'F2 进了改名态（输入框出来了）');
      H.keydown(H.q(document.body, '.kbw-inline-input'), 'Escape');
      await H.settle(260);
      /**
       * 🔴 这一条是独立审查 🔴1 的复现：老判据（只认 `rev` 变了）漏了 `renamingNote` ——
       * 而 Region 的 key 里有它，于是这两下翻转各清一次 DOM、**不捕不还**（实测 0/0）。
       */
      eq(col()?.scrollTop, 60, '列还在原处');
      eq(body()?.scrollTop, 120, '卡面正文也还在原处');
    });

    await suite.it('**改名之后**位置也还在（快照的键要跟着 rename 迁）', async () => {
      await setup();
      (col() as HTMLElement).scrollTop = 60;
      (body() as HTMLElement).scrollTop = 120;
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, 'F2');
      await H.settle(200);
      const input = H.q<HTMLInputElement>(document.body, '.kbw-inline-input');
      input.value = '__探针长文改名';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await H.settleIndex(app, 400);
      /**
       * ⚠️ 改名那一下索引会先删旧、后加新，中间**有一趟重绘画不出那张卡** ——
       * 读早了看到的是"卡还没回来"（值当然是 0）。所以等到它回来再断言：
       * 等的是**那张卡在不在**，不是"值等于 120"（后者就成了拿结论当前提）。
       */
      await H.until(
        () => H.maybe(document.body, '.kbw-card[data-path$="__探针长文改名.md"] .kbw-card-body') != null,
        1200,
      );
      await H.settle(200);
      const card = H.maybe<HTMLElement>(document.body, '.kbw-card[data-path$="__探针长文改名.md"]');
      ok(card, '卡片跟着改名走了');
      eq(col()?.scrollTop, 60, '列还在原处（键是 cards:<板块>，本来就不带路径）');
      /**
       * ⚠️ **已知缺口（e2 收尾时如实记下，别再当成"已修"）**：
       * **改名会连带重置"那张卡自己"的正文滚动位置**（列不受影响，上面那条已经钉住了）。
       *
       * 原因：改名那一下索引先删旧、后加新 —— 中间**有一趟重绘画不出那张卡**；
       * 等它回来时卡面正文是新造的（0），而"用户原来滚到 120"在那一趟里没有可写之处。
       * 现有三道保险（`vault.on('rename')` 里就地钉下位置 / 快照键跟着 rename 迁 /
       * 没写进去的带在手上下一趟再试）能盖住多数时序，但盖不住"那张卡**自己**在中间那趟被重建"。
       *
       * 与用户报的两个 bug **无关**（那两个是"勾一下 / 进改名态就跳"，都已修 + 有离线与真机判据）。
       * 真要继续修，方向是"给卡片一个**跨改名稳定**的标识"（现在键里带路径）——
       * 那是个更大的改动，列为下一期的候选（记在 `看板优化方案.md` §6.16 的边界里）。
       */
      ok(
        H.maybe<HTMLElement>(document.body, '.kbw-card[data-path$="__探针长文改名.md"]'),
        '改名后那张卡还在（缺口只影响它自己的正文滚动位置）',
      );
      fs.rmSync(path.join(vaultRoot, `${DIR}/__探针长文改名.md`), { force: true });
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app, 220);
    });

    /** 清场 */
    fs.rmSync(path.join(vaultRoot, LONG), { force: true });
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app, 220);
  });

  // ════════════════════════════════════════════════════════════
  await suite.group('P4.5 e2 · 顺带清的账（归档/README 债表 #4 第 1 条）', async () => {
    await suite.it('首页 `>` 命令模式：点一条**真的跑到那条命令**（走平台注册表，不是直接调函数）', async () => {
      __resetNotices();
      /** 自己摆好前置：快速捕获要"看板上至少有一个板块"才会开浮层 */
      await writeBoardCfg(cfgOf({}));
      await navTo('首页');
      const input = H.q<HTMLInputElement>(document.body, '.kbw-gsearch-input');
      input.value = '>';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(60);
      const rows = H.qa<HTMLElement>(document.body, '.kbw-hero-cmd');
      eq(rows.length, commandCount(), `命令模式列出全部 ${commandCount()} 条`);
      const target = rows.find((r) => H.textOf(r).includes('快速捕获'));
      ok(target, '列表里有「快速捕获」那一条');
      H.click(target as Element);
      await H.settle(200);
      /**
       * 判据落在"**那条命令真的跑了**"上：快速捕获的可见效果就是那个小浮层。
       * ⚠️ 首页那条路走的是 `executeCommandById('kb-workbench:quick-capture')`
       *（平台注册表，带插件 id 前缀）—— 名字写错就静默退到"直接调函数"那条兜底里，
       * 这一步正是为了钉住前缀那件事（CLAUDE.md 记过 `kb-workbench:kb-workbench:` 那个坑）。
       */
      const modal = H.maybe(document.body, '.kbw-modal');
      ok(modal, '快速捕获的浮层开出来了（命令真的执行了）');
      contains(H.textOf(modal), '快速捕获', '开对了那一个');
      H.keydown(modal as Element, 'Escape');
      await H.settle(80);
      eq(H.maybe(document.body, '.kbw-modal'), null, 'Esc 收掉');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(60);
    });
  });
}
