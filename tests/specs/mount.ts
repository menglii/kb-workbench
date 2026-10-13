/**
 * spec：骨架、导航、命令、降级分支
 * 对应完成定义：
 *   · 实验库能打开工作台（左导航 4 项 + 空模块区 + 底部状态）
 *   · 命令面板 4 条能用；`/` 和 `?` 生效；模块开关关掉后命令消失
 *   · 交互规格 §1.5 的降级分支（库根不见了 / 索引未就绪）
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { commandCount } from '../../src/core/commands';
import { normalizeSettings } from '../../src/core/settings';

export async function specMount(suite: Suite, app: StubApp, plugin: KbWorkbenchPlugin, _vaultRoot: string): Promise<void> {
  const ctx = () => plugin.context();

  await suite.group('骨架与导航', async () => {
    await suite.it('打开工作台：挂上一个 .kbw-root，左导航 4 项，底部状态 3 行', async () => {
      await ctx().activate();
      await H.settle();

      const roots = H.qa(document.body, '.kbw-root');
      eq(roots.length, 1, '.kbw-root 数量');

      const nav = H.qa(document.body, '.kbw-navitem');
      eq(nav.length, 5, '导航项数量');
      const labels = H.textsOf(document.body, '.kbw-navitem .kbw-navitem-label');
      eq(labels.join(','), '首页,全部笔记,看板,图谱,回顾', '导航文案与顺序');

      const foot = H.qa(document.body, '.kbw-navfoot-row');
      eq(foot.length, 3, '底部状态行数');
      contains(H.textOf(foot[0]), '自动化', '第一行是自动化状态');
      // 收紧：必须是"库 N 篇"且 N 等于索引里的条目数（'库 索引中…' 会当场露馅）
      eq(H.textOf(foot[2]), `库 ${ctx().index.getAll().length} 篇`, '第三行是库篇数');
    });

    await suite.it('再打开一次 → 聚焦已有标签，不新开第二个', async () => {
      await ctx().activate();
      await H.settle();
      eq(H.qa(document.body, '.kbw-root').length, 1, '.kbw-root 数量');
      eq(app.workspace.getLeavesOfType('kb-workbench-view').length, 1, '视图叶子数量');
    });

    await suite.it('切模块：内容区换成该模块，方向标记跟着变', async () => {
      // 从首页往「全部笔记」走（向下）
      H.click(H.qa(document.body, '.kbw-navitem')[1]);
      await H.settle();
      eq(ctx().store.get().activeModule, 'notes', '当前模块');
      ok(H.maybe(document.body, '.kbw-notes'), '笔记模块真的挂上了（P1 起是真界面，不是占位）');
      eq(H.q(document.body, '.kbw-root').getAttribute('data-dir'), 'down', '切换方向');

      // 回到首页（向上）
      H.click(H.qa(document.body, '.kbw-navitem')[0]);
      await H.settle();
      eq(ctx().store.get().activeModule, 'home', '回到首页');
      eq(H.q(document.body, '.kbw-root').getAttribute('data-dir'), 'up', '切换方向');
    });

    /**
     * **第五栏「回顾」**（P8）：能切栏 · 空态可看 · 图标是 lucide 的 repeat。
     *
     * 为什么这条非有不可：把 `renderReview` 改成 `() => {}`、把 `MODULE_RENDERERS.review`
     * 指错、把图标名写错，`npm run check` 与真机探针**全程绿** —— 只有把这一栏**真的切过去**
     * 才看得见（renderer 抛错还会被 `paintModule` 吞成兜底空态，只留一行 `console.error`）。
     * 图标名那条尤其阴：桩的 `setIcon` 对**任意**名字都造 svg、不校验 → 名字写错 = 真机一片
     * 空白图标、离线全绿。所以照 `board.ts` 那套**双形态**查
     *（桩给 `data-icon`、真机给 `lucide-*`）。
     */
    await suite.it('第五栏「回顾」：能切过去、空态在、图标是 lucide 的 repeat', async () => {
      const items = H.qa<HTMLElement>(document.body, '.kbw-navitem');
      eq(items.length, 5, '前提：第 5 项在（少于此数下面会取到 undefined）');
      /**
       * ⚠️ 图标这条查在**点击之前**：点导航项会让导航区整块重绘（`paintNav` 先清后画），
       * 手里的 `items` 立刻变成**过期快照** —— 拿陈旧节点去查"这一栏现在长什么样"是假证据。
       */
      ok(
        items[4].querySelector('svg[data-icon="repeat"], svg.lucide-repeat') !== null,
        '图标走 lucide 的 repeat（桩看 data-icon、真机看 lucide-*）',
      );

      H.click(items[4]);
      await H.settle();
      eq(ctx().store.get().activeModule, 'review', '当前模块');
      ok(H.maybe(document.body, '.kbw-review'), '回顾模块真的挂上了（不是一片空白）');
      eq(H.textOf(H.q(document.body, '.kbw-empty-title')), '还没有回顾卡', '空态标题');

      /**
       * 空态那个动作**不是死按钮**：点了真能走通。P8 期 4 起它是**「从笔记生成」**
       *（0 张卡时头部那两枚按钮都不画，空态是唯一入口）—— 点它开的是**挑笔记**那个模态
       *（`ui/prompt.ts` 的 `pickOne`），**不切走模块**。
       */
      H.click(H.q<HTMLElement>(document.body, '.kbw-review .kbw-empty-act .kbw-btn'));
      await H.settle(150);
      const picker = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(picker, '空态动作开了挑笔记的模态（不是死按钮）');
      contains(H.textOf(picker), '从哪一篇生成回顾卡', '模态说清在挑什么');
      H.keydown(document.body, 'Escape');
      await H.settle(120);
      eq(ctx().store.get().activeModule, 'review', '挑笔记不切走模块');

      // 收场：回首页 —— 后面那条「标签页标题」用例断言的是首页（导航项**重新取一次**，理由同上）
      H.click(H.qa<HTMLElement>(document.body, '.kbw-navitem')[0]);
      await H.settle();
      eq(ctx().store.get().activeModule, 'home', '收场回首页');
    });

    await suite.it('标签页标题带当前模块', async () => {
      const leaf = app.workspace.getLeavesOfType('kb-workbench-view')[0];
      contains(leaf.view?.getDisplayText() ?? '', '经纬 · ', '标签页标题前缀');
      contains(leaf.view?.getDisplayText() ?? '', '首页', '标签页标题里的模块名');
    });
  });

  // ⚠️ P0 的「开发面板」在 P1 已整块删除（`view/dev-panel.ts` 不存在了）——
  // 那一段的断言随之作废，换成首页真界面的骨架断言。
  await suite.group('首页（P1 真界面）', async () => {
    await suite.it('上半部：标识 + 大搜索框（键位提示 /）+ 四个快捷动作', async () => {
      const host = H.q(document.body, '.kbw-modhost');
      eq(H.textOf(H.maybe(host, '.kbw-hero-name')), '经纬', '居中标识');
      eq(H.textOf(H.maybe(host, '.kbw-hero-sub')), '知识工作台', '副标题');
      const input = H.maybe<HTMLInputElement>(host, '.kbw-gsearch-input');
      ok(input, '大搜索框在');
      // 键位提示必须是 `/`（决策：行为早已锁定为 /，不标 ⌘K）
      eq(H.textOf(H.maybe(host, '.kbw-key')), '/', '键位提示');
      const quick = H.textsOf(host, '.kbw-qbtn');
      eq(quick.length, 4, '四个快捷动作');
      for (const label of ['新建笔记', '整理收件箱', '还原快照', '问 AI']) {
        ok(quick.some((t) => t.includes(label)), `缺快捷动作：${label}`);
      }
    });

    await suite.it('下半部：待处理 + 最近改动 + 底部状态，都从索引来', async () => {
      const host = H.q(document.body, '.kbw-modhost');
      const heads = H.textsOf(host, '.kbw-sec-head h3');
      contains(heads.join('|'), '待处理', '待处理段');
      contains(heads.join('|'), '最近改动', '最近改动段');
      // 待处理要么有行、要么是「库是干净的」——两者必居其一（实验库是活的，不钉数量）
      const rows = H.qa(host, '.kbw-todo').length;
      const clean = H.textOf(host).includes('库是干净的');
      // ⚠️ 不能写成 `rows > 0 || clean`（析取式）：「渲染了但一条规则都没生出来」会放行。
      // 两种合法状态各自断言：有待处理项 → 每行都要有标题；没有 → 必须给出空态那句话
      if (rows > 0) {
        const titles = H.textsOf(host, '.kbw-todo-t');
        eq(titles.length, rows, '每条待处理行都要有标题');
        ok(
          titles.every((t) => t.length > 0),
          `行标题不该是空的：${titles.join(' | ')}`,
        );
      } else {
        ok(clean, '没有待处理项时必须给出「库是干净的」空态');
      }
      ok(H.maybe(host, '.kbw-home-foot'), '底部状态在');
      contains(H.textOf(H.q(host, '.kbw-home-foot')), '库 ', '底部状态要写库 N 篇');
    });

    await suite.it('搜索框：搜不到 → 原地给空态 + 只提议交给 AI（不跳走）', async () => {
      const host = H.q(document.body, '.kbw-modhost');
      const input = H.q<HTMLInputElement>(host, '.kbw-gsearch-input');
      input.value = '这几个字库里绝对没有__zzz';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      H.keydown(input, 'Enter');
      await H.settle(50);
      eq(ctx().store.get().activeModule, 'home', '没匹配时不该跳走');
      contains(H.textOf(H.q(host, '.kbw-hero-msg')), '没有匹配', '原地给空态');
      contains(H.textOf(H.q(host, '.kbw-hero-msg')), 'AI', '只提议交给 AI');
      /**
       * `>` 开头 → 命令模式。
       * ⚠️ 条数 = `core/commands.ts` 那一份（e2 期起 5 条）—— 它涨了这里也要跟着涨，
       * 两处同源（首页那个列表就是读 `COMMANDS` 渲染的）。
       */
      input.value = '>';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(20);
      eq(H.qa(host, '.kbw-hero-cmd').length, commandCount(), `命令模式列出 ${commandCount()} 条`);
      // 清干净，别影响后面的用例
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await suite.it('搜索框：有匹配 → 跳到全部笔记并预填搜索词', async () => {
      const host = H.q(document.body, '.kbw-modhost');
      const input = H.q<HTMLInputElement>(host, '.kbw-gsearch-input');
      const first = ctx().index.notes()[0];
      ok(first, '库里得有笔记');
      input.value = first.basename.slice(0, 2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      H.keydown(input, 'Enter');
      await H.settle(60);
      eq(ctx().store.get().activeModule, 'notes', '应该跳到全部笔记');
      const box = H.maybe<HTMLInputElement>(document.body, '.kbw-search');
      eq(box?.value, first.basename.slice(0, 2), '搜索词要预填上');
      // 回首页
      H.click(H.qa(document.body, '.kbw-navitem')[0]);
      await H.settle();
    });
  });

  await suite.group('命令面板', async () => {
    await suite.it('恰好 5 条，id 与文案都对（第 5 条 = e2 期的快速捕获）', async () => {
      /**
       * ⚠️ **条数 = 口径**：这条断言存在的意义就是拦住"悄悄涨一条"。
       * e2 期加第 5 条（§4.3 快速捕获）时**先让它红、再改它**，并同时回改了
       * `交互规格.md` §1.2 与 `排查报告.md` B5（三处同源）。
       */
      eq(commandCount(), 5, '命令条数');
      const ids = app.commands.all().map((c) => c.id).sort();
      eq(
        ids.join(','),
        [
          'kb-workbench:new-note',
          'kb-workbench:open',
          'kb-workbench:quick-capture',
          'kb-workbench:rebuild',
          'kb-workbench:restore-snapshot',
        ].join(','),
        '命令 id',
      );
    });

    await suite.it('只有"快速捕获"带默认热键（Mod+Alt+N），且键位不与本体的默认键撞', async () => {
      const all = app.commands.all() as unknown as {
        id: string;
        hotkeys?: { modifiers: string[]; key: string }[];
      }[];
      const withKeys = all.filter((c) => (c.hotkeys ?? []).length > 0);
      eq(withKeys.length, 1, `只有一条命令带默认键（实际 ${withKeys.length} 条）`);
      eq(withKeys[0]?.id, 'kb-workbench:quick-capture', '带键的是快速捕获');
      const k = withKeys[0]?.hotkeys?.[0];
      eq(`${k?.modifiers.join('+')}+${k?.key}`, 'Mod+Alt+N', '默认键是 Mod+Alt+N');
    });

    await suite.it('模块开关关掉后命令从面板消失，打开又回来', async () => {
      ok(app.commands.visible().includes('kb-workbench:new-note'), '默认应该看得见');
      await ctx().gate.set('completion', false);
      ok(!app.commands.visible().includes('kb-workbench:new-note'), '关掉后不该出现');
      await ctx().gate.set('completion', true);
      ok(app.commands.visible().includes('kb-workbench:new-note'), '打开后应该回来');
    });

    await suite.it('关掉模块后：命令消失、命令执行不了、残留入口也明确拒绝', async () => {
      const { __resetNotices } = await import('../../src/ui/notify');
      __resetNotices();
      await ctx().gate.set('completion', false);

      // ① 命令面板里看不见
      ok(!app.commands.visible().includes('kb-workbench:new-note'), '关掉后命令不该出现在面板里');
      // ② 强行执行也不该真的跑（checkCallback 会拦住）
      const ran = app.commands.execute('kb-workbench:new-note');
      eq(ran, false, '命令不该被执行');

      // ③ 残留入口（导航项）点了要"说明原因"，不能默默不动
      //    —— 这条走的是 view 里那个 assert 调用，是真入口，不是 helper
      await ctx().gate.set('graph', false);
      __resetNotices();
      const graphNav = H.qa(document.body, '.kbw-navitem')[3];
      ok(graphNav, '找到图谱导航项');
      ok(graphNav.classList.contains('is-off'), '关掉的模块导航项要置灰');
      H.click(graphNav);
      await H.settle();
      const noticeText = H.textOf(H.maybe(document.body, '.kbw-notice'));
      contains(noticeText, '已停手', '残留入口的拒绝文案');
      contains(noticeText, '图谱', '说出是哪个模块');
      eq(ctx().store.get().activeModule !== 'graph', true, '不该真的切过去');

      await ctx().gate.set('graph', true);
      await ctx().gate.set('completion', true);
    });

    await suite.it('打开工作台的命令真的能开出来', async () => {
      for (const leaf of app.workspace.getLeavesOfType('kb-workbench-view')) leaf.detach();
      await H.settle();
      eq(H.qa(document.body, '.kbw-root').length, 0, '先确认已经关掉');
      app.commands.execute('kb-workbench:open');
      await H.settle();
      eq(H.qa(document.body, '.kbw-root').length, 1, '命令打开后的视图数量');
    });
  });

  await suite.group('键盘', async () => {
    await suite.it('? 打开快捷键表；表里有 14 个动作、键位可读', async () => {
      const root = H.q(document.body, '.kbw-root');
      H.keydown(root, '?');
      await H.settle();
      const modal = H.q(document.body, '.kbw-modal');
      contains(H.textOf(modal), '快捷键', '表标题');
      /**
       * ⚠️ 按**身份**认行（`data-keys-row`），不数 `tbody tr` —— D2 之后 tbody 里
       * 还躺着两条分节标题行（`scope` 分组），数总行数会被排版改动带跑偏。
       */
      const rows = H.qa(modal, 'tbody tr[data-keys-row]');
      eq(rows.length, 14, '动作条数');
      contains(H.textOf(modal), '聚焦搜索框', '有一条是聚焦搜索框');
      /**
       * D2：按 `scope` 分了两组（工作台内 / 表格·网格·卡片区），组标题行带**条数**。
       * 判据用**分组名 + 条数**（不是"有没有标题行"—— 那在只有一组时也成立）。
       */
      const groups = H.qa(modal, 'tbody tr.kbw-keys-group').map((g) => H.textOf(g));
      eq(groups.length, 2, 'scope 分组数');
      contains(groups.join('|'), '工作台内 · 4 个动作', '第一组：工作台内 4 个动作');
      contains(groups.join('|'), '表格 / 网格 / 卡片区 · 10 个动作', '第二组：表格/网格/卡片区 10 个动作');
      /**
       * D1：「键位写法」**不在默认视野里**，收进「帮助」按钮。
       *
       * 🔴 **判"看不看得见"不能拿 `H.textOf`**（那是 `textContent`）：收起来的块仍在 DOM 里，
       * textContent 照样读得到 —— 第一版就是这么写的，开场那条直接假红（而且 `ok()` 抛了之后
       * 后面的 Esc 不跑，模态留在屏幕上把后面三条用例一起带红）。
       * 判据落在**它到底显不显示**（我们收起来用的就是 `display:none`）。
       */
      const helpBox = () => H.maybe<HTMLElement>(modal, '.kbw-keys-help');
      const visible = (): boolean => helpBox()?.style.display !== 'none';
      ok(!visible(), '默认收着键位写法（收进「帮助」了）');
      const helpBtn = H.qa<HTMLElement>(modal, '.kbw-modal-foot button').find(
        (b) => H.textOf(b) === '帮助',
      );
      ok(helpBtn, '底栏有「帮助」入口');
      H.click(helpBtn as HTMLElement);
      await H.settle(30);
      ok(visible(), '点开之后摊出来');
      contains(H.textOf(helpBox()), 'arrowup / escape', '里面写着键位写法');
      contains(H.textOf(helpBox()), '撞车怎么办', '还写了冲突怎么办');
      eq((helpBtn as HTMLElement).getAttribute('aria-expanded'), 'true', 'aria-expanded 要跟着变');
      H.click(helpBtn as HTMLElement);
      await H.settle(30);
      ok(!visible(), '再点一下收起来');
      eq((helpBtn as HTMLElement).getAttribute('aria-expanded'), 'false', 'aria-expanded 收回去');
      /**
       * **"挪进帮助" ≠ "两处都留"**（B 路 🟡2.8）：只验"帮助里有"的话，
       * 实现把原来那一行留在最底下也照样绿。判据：那串写法**只出现在 `.kbw-keys-help` 里**。
       */
      const outside = H.textOf(modal).split('键位写法').length - 1;
      const inside = H.textOf(helpBox() ?? document.body).split('键位写法').length - 1;
      eq(outside, 1, '「键位写法」这几个字在整张表里只出现一次');
      eq(inside, 1, '而且就在帮助块里（不是底部还留着一行）');

      // Esc 收掉
      H.keydown(modal, 'Escape');
      await H.settle();
      eq(H.maybe(document.body, '.kbw-modal'), null, 'Esc 之后应该关掉');
    });

    await suite.it('改键位撞车：先拦住 → 确认后旧的解绑 + 明确提醒', async () => {
      const ctx = plugin.context();
      await ctx.settings.save({ keymap: {} });
      ctx.openKeysHelp();
      await H.settle();
      const table = H.q(document.body, '.kbw-modal');
      /**
       * ⚠️ 键帽的类名是 `.kbw-keycap`（P6b 真机抓的 bug：它原来也叫 `.kbw-kbd`，
       * 而工作台**根元素**在键盘模式下带 `kbw-kbd` → 裸选择器把整棵树套上了键帽样式）。
       */
      const chip = H.qa(table, '.kbw-keycap').find((c) => H.textOf(c) === '/');
      ok(chip, '找到「/」胶囊（聚焦搜索框的默认键）');
      H.click(chip);
      await H.tick();
      // 按一个已被占用的键：ArrowUp（上移高亮）
      H.keydown(document.body, 'ArrowUp');
      await H.settle();

      const dialogs = H.qa(document.body, '.kbw-modal');
      eq(dialogs.length, 2, '撞车时**先弹确认流**，不能默默绑上');
      const dialog = dialogs[1];
      contains(H.textOf(dialog), '已经被', '说清被谁占了');
      contains(H.textOf(dialog), '解绑', '说清确认后会解绑旧的');

      const primary = H.q(dialog, '.kbw-modal-foot .kbw-btn.is-primary');
      contains(H.textOf(primary), '解绑', '主按钮说清后果');
      H.click(primary);
      await H.settle();
      const km = ctx.settings.get().keymap as Record<string, string[]>;
      eq((km['focus-search'] ?? []).join(','), 'arrowup', '新动作拿到键');
      eq((km['move-up'] ?? ['(没写)']).join(','), '', '旧动作被**显式解绑**（空数组，不是回落默认）');
      eq(ctx.keymap.keysFor('move-up').length, 0, '旧动作现在一个键都没有');

      // 收尾：恢复默认
      await ctx.settings.save({ keymap: {} });
      H.keydown(H.q(document.body, '.kbw-modal'), 'Escape');
      await H.settle();
    });

    await suite.it('改过的键位：表里标出来，点 × 能单独恢复默认', async () => {
      const ctx = plugin.context();
      await ctx.settings.save({ keymap: { 'shortcuts-help': ['mod+k'] } });
      ctx.openKeysHelp();
      await H.settle();
      const modal = H.q(document.body, '.kbw-modal');
      const chip = H.q(modal, '.kbw-keycap.is-custom');
      contains(H.textOf(chip), 'Ctrl/⌘+K', '显示你改过的键');
      H.click(H.q(chip, '.kbw-x'));
      await H.settle();
      eq(JSON.stringify(ctx.settings.get().keymap), '{}', '点 × 之后这一个恢复默认');
      H.keydown(modal, 'Escape');
      await H.settle();
    });

    await suite.it('键盘用过之后才出现 kbw-kbd 标记（全程鼠标不出现新样式）', async () => {
      const root = H.q(document.body, '.kbw-root');
      root.classList.remove('kbw-kbd');
      H.click(H.q(root, '.kbw-navitem'));
      await H.settle();
      ok(!root.classList.contains('kbw-kbd'), '只点鼠标不该出现');
      H.keydown(root, 'ArrowDown');
      await H.settle();
      ok(root.classList.contains('kbw-kbd'), '按过键之后应该出现');
      /**
       * 🔴 **旗标类名与键帽类名撞车过**（P6b 真机抓的真 bug）：键帽原来也叫 `kbw-kbd`，
       * 裸选择器一命中根元素，整棵树就被套上键帽样式（11px 等宽字 + 边框 + padding +
       * `white-space: nowrap` —— 最后那条**被后代继承**，卡片与小窗预览从此不折行）。
       * 这条判据钉住"两个名字不再是同一个"：根上只能有旗标那个名字。
       */
      // ⚠️ 用 `maybe`（`q` 找不到会**抛** —— 正常情况本来就没有这个元素）
      ok(
        H.maybe(document.body, '.kbw-root .kbw-keycap, .kbw-keycap.kbw-root') == null,
        '键帽类名（kbw-keycap）不该落在根元素上',
      );
    });
  });

  await suite.group('降级分支（交互规格 §1.5）', async () => {
    await suite.it('库根被改名/移走 → 全屏提示 + 指向设置', async () => {
      const before = ctx().settings.get().kbRoot;
      await ctx().settings.save({ kbRoot: '根本没有这个目录' });
      await H.settle();
      const host = () => H.q(document.body, '.kbw-modhost');
      contains(H.textOf(host()), '找不到知识库根目录', '降级提示');
      ok(H.qa(document.body, '.kbw-navitem').length === 5, '导航还在（不影响其余模块）');
      await ctx().settings.save({ kbRoot: before });
      await H.settle();
      eq(H.textOf(host()).includes('找不到知识库根目录'), false, '恢复之后不该再显示');
    });

    await suite.it('容器变窄打 data-w（JS 量宽度，不靠 container-type）', async () => {
      const root = H.q(document.body, '.kbw-root');
      // jsdom 量不到布局 → 直接覆盖属性，再触发一次 ResizeObserver 回调
      Object.defineProperty(root, 'clientWidth', { value: 520, configurable: true });
      H.triggerResize();
      await H.settle();
      eq(root.getAttribute('data-w'), 'narrow', '520px 应该是窄档');

      Object.defineProperty(root, 'clientWidth', { value: 760, configurable: true });
      H.triggerResize();
      eq(root.getAttribute('data-w'), 'mid', '760px 应该是中档');

      Object.defineProperty(root, 'clientWidth', { value: 1200, configurable: true });
      H.triggerResize();
      eq(root.getAttribute('data-w'), 'wide', '1200px 应该是宽档');
    });

    await suite.it('不给容器加 container-type（会打中"浮层从触发点展开"）', async () => {
      const css = stripComments(H.readNote(H.repoRoot(), 'styles.css'));
      ok(!/container-type/.test(css), 'styles.css 里不该出现 container-type');
    });

    await suite.it('触屏规则挂 body.is-mobile，不按视口宽度', async () => {
      const css = stripComments(H.readNote(H.repoRoot(), 'styles.css'));
      contains(css, 'body.is-mobile', '应存在 is-mobile 口径的规则');
      // 顶层 :hover 必须就地包进 @media (hover: hover)
      eq(topLevelHoverCount(css), 0, '顶层 :hover 条数（platform-pitfalls #36）');
    });

    /**
     * ③ **打开工作台时自动收起 Obsidian 左侧栏**（用户 2026-09-28 拍板）。
     *
     * 两条分支都要判（**期望值 ≠ 默认值**，别写成"关了就是 false"那种自证）：
     *   ① 开关开着 + 侧栏本来是开的 → 收起来；
     *   ② 开关关掉 → **一个字都不碰**（这是给用户留的那条退路）。
     * ⚠️ 离线只能判到"那个旗标被写成 true 了" —— 真机上它还连着"工作台变宽、
     * 目录栏不再被窄档藏起来"这条因果链，那条只有探针验得了。
     */
    await suite.it('③ 打开工作台：开关开着才收左侧栏，关掉一个字都不碰', async () => {
      const ws = app.workspace as unknown as {
        leftSplit: { collapsed: boolean; collapseCalls: number };
      };
      const settings = plugin.context().settings;

      // ⚠️ **用例之间不靠顺序**（`KBW_TEST_ONLY` 单跑也要能过）：先自己把工作台开出来
      await plugin.activate();
      await H.settle(80);
      const leaves = app.workspace.getLeavesOfType('kb-workbench-view');
      ok(leaves.length > 0, '工作台已经在');
      leaves.forEach((l) => l.detach());
      await H.settle(60);

      // ① 开关开着（默认就是 true）：从"侧栏开着"出发
      await settings.save({ collapseSidebarOnOpen: true });
      ws.leftSplit.collapsed = false;
      const calls0 = ws.leftSplit.collapseCalls;
      await plugin.activate();
      await H.settle(80);
      eq(ws.leftSplit.collapsed, true, '开关开着 → 打开工作台时收起侧栏');
      /**
       * 🔴 **必须调 `collapse()`，光写字段不算**（真机实测：写字段是静默无效的）。
       * 只断言 `collapsed === true` 的话，"赋值"那条错实现照样绿 ——
       * 这一条计数才是能分辨两者的那半（几何那半在真机探针里）。
       */
      eq(ws.leftSplit.collapseCalls, calls0 + 1, '走的是 collapse()，不是给 collapsed 赋值');

      // ② 关掉开关：再开一次工作台，侧栏必须原样留着
      await settings.save({ collapseSidebarOnOpen: false });
      ws.leftSplit.collapsed = false;
      const calls1 = ws.leftSplit.collapseCalls;
      app.workspace.getLeavesOfType('kb-workbench-view').forEach((l) => l.detach());
      await H.settle(60);
      await plugin.activate();
      await H.settle(80);
      eq(ws.leftSplit.collapsed, false, '开关关掉 → 侧栏一个字都不碰');
      eq(ws.leftSplit.collapseCalls, calls1, '关掉开关时一次 collapse() 都不许调');

      /**
       * ③ **工作台已经是最前面那个视图时，再点一次"打开工作台"不该收**（独立审查 B1：
       * 这条对外承诺原本**零判据** —— 删掉那个判断，全量 582/582 照样全绿）。
       * 为什么它重要：`goNotes` / `goBoard`（首页待处理、快速切换跳转…）也是走 `activate()`，
       * 每次跳一下就替用户把侧栏拍下去会很讨厌。判据只有一条：**`collapse()` 的调用数不许涨**。
       */
      await settings.save({ collapseSidebarOnOpen: true });
      ws.leftSplit.collapsed = false;
      const calls2 = ws.leftSplit.collapseCalls;
      await plugin.activate(); // 不 detach：工作台此刻已经是最前面那个
      await H.settle(80);
      eq(
        ws.leftSplit.collapseCalls,
        calls2,
        '工作台已经在前台时再 activate：一次 collapse() 都不许调（goNotes/goBoard 走的就是这条路）',
      );
      eq(ws.leftSplit.collapsed, false, '侧栏保持原样（没收）');

      // 收拾干净：开关回默认，别把状态漏给后面的用例
      await settings.save({ collapseSidebarOnOpen: true });
    });

    /**
     * `collapseSidebarOnOpen` 的**归一化**：`default` 那一支只收字符串，
     * 少写一条显式 case 的话，存进去的 `false` 会被静默丢掉、回落成 `true`
     * ——症状是"我把开关关了，重开工作台侧栏还是被收走"（本项目在 data.json 上栽过）。
     */
    await suite.it('③ 开关的 false 能活过一轮 normalize（别被默认值顶掉）', () => {
      const back = normalizeSettings({ collapseSidebarOnOpen: false });
      eq(back.collapseSidebarOnOpen, false, '显式的 false 必须原样留着');
      eq(normalizeSettings({}).collapseSidebarOnOpen, true, '没写过 → 默认开');
      eq(normalizeSettings({ collapseSidebarOnOpen: 'no' }).collapseSidebarOnOpen, true, '非法值回落默认');
    });
  });
}

/** 去掉注释：注释里写的 `container-type`、`:hover` 不算规则 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 数一数"没被 @media (hover: hover) 包住的顶层 :hover"。
 * ⚠️ 不能用正则匹配整块（块里还有嵌套的规则花括号）→ 走花括号配对。
 */
function topLevelHoverCount(css: string): number {
  let out = css;
  for (let guard = 0; guard < 50; guard += 1) {
    const start = out.search(/@media\s*\(hover:\s*hover\)/);
    if (start < 0) break;
    const open = out.indexOf('{', start);
    if (open < 0) break;
    let depth = 0;
    let end = out.length - 1;
    for (let i = open; i < out.length; i += 1) {
      if (out[i] === '{') depth += 1;
      else if (out[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out = out.slice(0, start) + out.slice(end + 1);
  }
  return (out.match(/:hover/g) ?? []).length;
}
