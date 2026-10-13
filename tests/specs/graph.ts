/**
 * spec：图谱（P6 · 交互规格 §5）
 *
 * 判据分三层：
 *  ① **纯函数** —— `graphCoreState`（三态）/ `graphExcludeQuery` / `applyGraphFilter`（三条出路）
 *  ② **真链路** —— 真挂载：切到图谱 → 叶挂上去 + 注入过滤 + 卸载不留悬挂 + 再挂不叠加
 *  ③ 真机探针 —— `scripts/probe.mjs`（真机上还要验"过滤真的把节点数打下去了"）
 *
 * ⚠️ **这个文件不验"过滤算得对不对"** —— 桩只记录"收到了什么查询串"，
 * 不对文件做匹配。过滤到底对不对必须**真机**说话（e2 独立审查 🟡6：
 * "与实现平行的那个参照物抄了实现" = 离线永远绿）。真机那一步在 probe 里造形状逐条验。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp, StubGraphView } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { applyGraphFilter, graphCoreState, graphExcludeQuery, OLD_KB_TOP } from '../../src/modules/graph';
import { closeAllMenus } from '../../src/ui/menu';

export async function specGraph(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  _vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 当前工作台里那份图谱视图（桩把它登记在视图工厂里，这里从 DOM 反查） */
  const graphViews = (): StubGraphView[] =>
    app.__leaves
      .map((l) => l.view)
      .filter((v): v is StubGraphView =>
        Boolean(v && v.getViewType() === 'graph' && (v as StubGraphView).dataEngine),
      );

  /**
   * 工作台得先开着（前面几组用例可能把它关了）—— 走命令，与真机同一条路。
   *
   * ⚠️ **光执行命令不够**：前面的用例可能留下一片**已经没有 DOM 的叶**
   *（`H.resetDom()` 会把 body 清掉，而工作区里那片叶还登记着）——
   * 此时「打开工作台」这条命令认为"已经开着"、只去聚焦那片游离的叶，
   * 界面上什么都不会出现。所以先把残留的叶摘干净再开
   *（`specMount` 里那条"命令真能开出来"用的也是这个套路）。
   */
  async function ensureOpen(): Promise<void> {
    if (H.maybe(document.body, '.kbw-root')) return;
    for (const leaf of app.workspace.getLeavesOfType('kb-workbench-view')) leaf.detach();
    await H.settle(80);
    app.commands.execute('kb-workbench:open');
    await H.settle(140);
    ok(H.maybe(document.body, '.kbw-root'), '工作台开起来了');
  }

  /** 切到「图谱」那一栏（点导航项 —— 与真机同一条路） */
  async function goGraph(): Promise<void> {
    await ensureOpen();
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes('图谱'),
    );
    ok(nav, '导航里有「图谱」');
    H.click(nav as Element);
    await H.settle(140);
  }

  async function goHome(): Promise<void> {
    await ensureOpen();
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes('首页'),
    );
    ok(nav, '导航里有「首页」');
    H.click(nav as Element);
    await H.settle(90);
  }

  // ════════════════════════════════════════════════════════════
  // ① 纯函数层
  // ════════════════════════════════════════════════════════════
  await suite.group('图谱 · 纯函数（核心插件三态 / 过滤表达式 / 注入三条出路）', async () => {
    await suite.it('graphCoreState：ok / disabled / unknown 三态', async () => {
      const okApp = { internalPlugins: { plugins: { graph: { enabled: true } } } };
      const offApp = { internalPlugins: { plugins: { graph: { enabled: false } } } };
      const unknownApp = { internalPlugins: { plugins: { graph: undefined } } };
      const bare = {};
      eq(graphCoreState(okApp as never), 'ok', '开着 → ok');
      eq(graphCoreState(offApp as never), 'disabled', '关着 → disabled');
      eq(graphCoreState(unknownApp as never), 'unknown', '没有记录 → unknown');
      eq(graphCoreState(bare as never), 'unknown', '连 internalPlugins 都没有 → unknown');
      // 形状不对也别当 ok（宁可走"挂载前再判一次"那条说明）
      eq(
        graphCoreState({ internalPlugins: { plugins: { graph: { enabled: 'yes' } } } } as never),
        'unknown',
        'enabled 不是布尔 → unknown',
      );
      /**
       * 形状读不到时**再问一次注册表**（独立审查 F5，§5 给的第二条判据）：
       * `getViewCreatorByType('graph')` 为 null = 这个视图类型没有创建者 = 插件没开。
       * 少了这一问，'unknown' 那档会**照挂**，而核心插件关着时真机会挂出一片
       * 「插件不再活动」占位、`getViewType()` 仍返回 graph（S1）→ 界面上什么都没有说明。
       */
      eq(
        graphCoreState({ internalPlugins: { plugins: { graph: { enabled: 'yes' } } } } as never),
        'unknown',
        '两条判据都读不到才是 unknown',
      );
      eq(
        graphCoreState({
          viewRegistry: { getViewCreatorByType: () => null },
        } as never),
        'disabled',
        '没有 internalPlugins 但注册表里没有 graph 创建者 → 当 disabled 拦下（F5）',
      );
      eq(
        graphCoreState({
          viewRegistry: { getViewCreatorByType: () => () => ({}) },
        } as never),
        'unknown',
        '注册表里有创建者 → 仍归 unknown（照挂 + 说明条）',
      );
    });

    await suite.it('graphExcludeQuery：旧库 + 操作日志两条排除，且路径来自设置（不写死库根）', async () => {
      const q = graphExcludeQuery(ctx());
      contains(q, `-path:${OLD_KB_TOP}`, '排旧库');
      contains(q, `-path:${ctx().settings.logDir()}`, '排操作日志目录（路径从 logDir 取）');
      contains(q, '01_新知识库', '日志那条带上了库根（库根改了它跟着走）');
      /**
       * 🔴 **两条排除之间的分隔符也要判**（独立审查 🟡8）：`join(' ')` 写成 `join('')`
       * 会让 `-path:A-path:B` 被解析成**一个** path 词 → 两条排除**一起失效**。
       * 上面那三条 `contains` 拦不住这种（每一项单独看都对）。
       */
      eq(q, `-path:${OLD_KB_TOP} -path:${ctx().settings.logDir()}`, '表达式要逐字对（含两条之间的那个空格）');
      // 保留 MOC 那条目录：排掉整个 99_Meta 等于把选图谱的原始理由一起排掉
      // ⚠️ 用**正则**判，别写成 `!q.includes('-path:99_Meta ')`（独立审查 🟡9：带尾空格那种
      //    只在"后面还有别的词"时命中；串尾、或带库根的 `-path:01_新知识库/99_Meta` 全都漏）
      ok(!/-path:(\S*\/)?99_Meta(\s|$)/.test(q), '**不是**整片排掉 99_Meta（04_索引与地图 里的 MOC 要留着）');
    });

    await suite.it('applyGraphFilter：注入成功 / 没这个口 / 抛异常 —— 三条出路都不炸', async () => {
      const calls: unknown[] = [];
      const good = { dataEngine: { setQuery: (x: unknown) => calls.push(x) } };
      eq(applyGraphFilter(good, '-path:x'), 'ok', '有 dataEngine.setQuery → ok');
      eq(calls.length, 1, '真的调了一次');
      eq(JSON.stringify(calls[0]), JSON.stringify([{ query: '-path:x', color: null }]), '参数是**数组**');

      eq(applyGraphFilter({}, '-path:x'), 'unsupported', '视图上没有 dataEngine → unsupported');
      eq(applyGraphFilter(null, '-path:x'), 'unsupported', 'null → unsupported');
      eq(
        applyGraphFilter({ dataEngine: {} }, '-path:x'),
        'unsupported',
        'dataEngine 在但没有 setQuery → unsupported',
      );
      // 抛异常也要吞掉（图谱照常显示，只是不过滤）—— §5 的出口是"显示说明"，不是整页崩
      const boom = {
        dataEngine: {
          setQuery: () => {
            throw new TypeError('版本变了');
          },
        },
      };
      eq(applyGraphFilter(boom, '-path:x'), 'unsupported', '抛异常 → unsupported（不往外抛）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 真链路
  // ════════════════════════════════════════════════════════════
  await suite.group('图谱 · 真链路（挂载 / 注入 / 卸载不留悬挂）', async () => {
    await suite.it('切到图谱：叶挂上去了、canvas 在、过滤注入了', async () => {
      await goHome();
      await goGraph();
      const stage = H.maybe<HTMLElement>(document.body, '.kbw-graph-stage');
      ok(stage, '图谱宿主画出来了');
      ok(H.maybe(stage as Element, 'canvas'), 'canvas 挂进来了（S1：挂上就有尺寸，不需要 resize 补丁）');
      /**
       * 🔴 **作用域必须是我们自己那个类**：按 `[data-type="graph"]` 写会连
       * 用户手动打开的官方图谱标签一起打到（排查报告 #53）→ 这条判据钉住"我们那个类在"。
       */
      ok(H.maybe(document.body, '.kbw-graph .kbw-graph-stage'), '内容挂在 `.kbw-graph` 里面（CSS 作用域有落点）');
    });

    await suite.it('过滤真的注入到视图上（数组形参 / hasFilter / 不写 graph.json）', async () => {
      const views = graphViews();
      eq(views.length, 1, `工作台里正好一份图谱实例（实际 ${views.length}）`);
      const v = views[0];
      ok(v.setQueryCalls.length >= 1, 'setQuery 被调过');
      const last = v.setQueryCalls[v.setQueryCalls.length - 1];
      eq(last.length, 1, '一项查询');
      eq(last[0].query, graphExcludeQuery(ctx()), '注入的就是 graphExcludeQuery 算出来的那串');
      eq(last[0].color, null, '没有 color → 图谱把它当**过滤**（带 color 的是颜色组，不是过滤）');
      eq(v.hasFilter, true, 'hasFilter 起来了（S1/真机 spike 的同一个字段）');
      /**
       * 🔴 **判"没写盘"要观察真实写入**（独立审查 🔴1）。
       *
       * 这里原来断言的是桩上那个 `wroteConfig = false` —— 而全仓库没人写过它，
       * 等于给自己的答案打分。突变实测：往 `renderGraph` 里塞一行
       * `adapter.write('.obsidian/graph.json', …)`，那条断言**照样绿**
       *（静态红线也拦不住：`adapter.write` 是经 `ctx` 转手的，模块源码里一个禁字都没有）。
       * 现在数的是桩 adapter 真收到的 `write`。
       */
      eq(
        app.vault.adapter.writes.filter((p) => p.includes('.obsidian')).length,
        0,
        '**没写配置文件**（程序化注入不落盘 —— 用户拍板的那条）',
      );
    });

    await suite.it('切走 → 叶真的 detach 了（不留悬挂）', async () => {
      await goHome();
      await H.settle(80);
      eq(H.maybe(document.body, '.kbw-graph-stage'), null, '图谱宿主没了');
      eq(H.qa(document.body, 'canvas').length, 0, 'canvas 也走了（S1：detach 后渲染循环真停）');
      eq(graphViews().length, 0, '那片叶已经从工作区摘掉了');
    });

    await suite.it('来回切两次：不叠加（再挂还是**一份** canvas）', async () => {
      await goGraph();
      eq(H.qa(document.body, '.kbw-graph-stage canvas').length, 1, '第一次：一份 canvas');
      await goHome();
      await goGraph();
      eq(H.qa(document.body, '.kbw-graph-stage canvas').length, 1, '第二次：还是一份（不叠加，S1 实测）');
      eq(graphViews().length, 1, '叶也只有一片');
      // ⚠️ 每片叶有自己的 dataEngine → 挂载时各自注入一次，互不影响
      ok(graphViews()[0].setQueryCalls.length >= 1, '新那一片也注入了过滤');
    });

    await suite.it('挂载失败 → 有说明 + 「重试」，且不影响别的模块', async () => {
      // 把工厂摘掉 = 模拟"检测过了却仍挂不上"（§5 的第二条出口）
      const factory = app.__viewFactories.get('graph');
      app.__viewFactories.delete('graph');
      try {
        await goHome();
        await goGraph();
        const text = H.textOf(H.maybe(document.body, '.kbw-graph-stage'));
        contains(text, '没挂上', '画的是失败说明');
        const retry = H.qa<HTMLElement>(document.body, '.kbw-graph .kbw-btn').find((b) =>
          H.textOf(b).includes('重试'),
        );
        ok(retry, '有「重试」按钮');

        // 修好之后点重试 → 挂上了（不用离开这一屏）
        app.__viewFactories.set('graph', factory as never);
        H.click(retry as Element);
        await H.settle(140);
        ok(H.maybe(document.body, '.kbw-graph-stage canvas'), '重试之后 canvas 挂上了');
      } finally {
        if (factory) app.__viewFactories.set('graph', factory);
      }
    });

    await suite.it('核心插件关掉 → **挂载之前**就拦住，给「去开启」+「重试」', async () => {
      await goHome();
      const restore = app.internalPlugins.plugins.graph;
      app.internalPlugins.plugins.graph = { enabled: false };
      try {
        await goGraph();
        eq(H.maybe(document.body, '.kbw-graph-stage'), null, '根本不该去挂（挂完再判就晚了 —— S1）');
        const text = H.textOf(H.maybe(document.body, '.kbw-graph'));
        contains(text, '核心插件', '说明里点出是核心插件的事');
        const go = H.qa<HTMLElement>(document.body, '.kbw-graph .kbw-btn').find((b) =>
          H.textOf(b).includes('去开启'),
        );
        ok(go, '有「去开启」按钮');
        const retry = H.qa<HTMLElement>(document.body, '.kbw-graph .kbw-btn').find((b) =>
          H.textOf(b).includes('重试'),
        );
        ok(retry, '也有「重试」（开完回来不用重进这一屏）');

        // 开回来 + 重试 → 挂上
        app.internalPlugins.plugins.graph = restore;
        H.click(retry as Element);
        await H.settle(140);
        ok(H.maybe(document.body, '.kbw-graph-stage canvas'), '开回来重试 → 挂上了');
      } finally {
        app.internalPlugins.plugins.graph = restore;
      }
    });

    await suite.it('静态红线：图谱那一屏**不许**碰 .obsidian/graph.json（注释不算）', async () => {
      /**
       * 🔴 用户 2026-09-27 拍板的那条："程序化注入，不动文件"。
       * "某个脚本必须不调用某个东西"这种约定 → 按本项目的规矩写成**静态断言**
       *（"文档说做了、代码没做"要靠读源码拦，P0 起的老账）。
       *
       * ⚠️ **必须先剥掉注释再判**（这是本项目栽过的形状：P3 那条红线断言
       * **既假绿又假红** —— 判文件名/字符串会被注释骗过）。
       * 这里更直接：本模块的**头注里就写着 `.obsidian/graph.json`**（那正是"为什么
       * 不写它"的理由），不剥注释的话这条判据**恒假**，而且假得毫无信息量。
       */
      const strip = (s: string): string =>
        s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      const dir = path.join(H.repoRoot(), 'src', 'modules', 'graph');
      const raw = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
      const code = strip(raw);
      ok(code.length > 200, '剥完注释还剩得下代码（别把整份文件剥没了还当"通过"）');
      ok(!/graph\.json/.test(code), '图谱模块的**代码**里不许出现 graph.json（注释里说明"为什么不写"是允许的）');
      ok(!/\bwriteFile\b|\badapter\.write\b/.test(code), '图谱模块不许写文件');
      const main = strip(fs.readFileSync(path.join(H.repoRoot(), 'src', 'main.ts'), 'utf8'));
      ok(!/graph\.json/.test(main), 'main.ts 的代码里也不许出现 graph.json');
    });

    await suite.it('收尾：回首页', async () => {
      closeAllMenus();
      await goHome();
      eq(ctx().store.get().activeModule, 'home', '回到首页');
      eq(graphViews().length, 0, '图谱叶收干净了');
    });
  });
}
