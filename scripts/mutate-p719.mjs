/**
 * mutate-p719.mjs —— P7.19 的突变验红（**3 处最险的新判据** + 3 条判定器反例自证）
 *
 * 纪律全在 `mutate-runner.mjs`（通用运行器）：备份到仓库外 / 锚点自证 / 成绩单 + 失败名单双检 /
 * 对照跑（干净源码必绿）/ 必还原 / 中断安全。这里只写「突哪儿、拿什么词筛、期望谁红」。
 *
 * ⚠️ 每处突变 = 一次过滤后的 `npm test`（**独占跑**）—— 所以跑它的时候别再开别的 `npm test`。
 * ⚠️ 过滤词统一用 `P7.19`（本轮新增的 4 条用例），**一次对照跑就够**（运行器按词缓存）。
 *
 * 跑法：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/mutate-p719.mjs
 */
import { runMutations } from './mutate-runner.mjs';

const FILTER = 'P7.19';

const MUTATIONS = [
  {
    id: 'M1-离场守卫失效',
    file: 'src/ui/undo-bar.ts',
    test: FILTER,
    expect: '点两次只生效一次',
    /** `gone()` 恒 false = 离场窗口里再点不会被跳过 → 第二次会再调一次 restore */
    apply(s) {
      const a = 'const gone = (): boolean => node.dataset.leaving === \'1\';';
      const b = 'const gone = (): boolean => false; // M1：把离场守卫掐掉';
      return s.includes(a) ? s.replace(a, b) : null;
    },
  },
  {
    id: 'M2-restoreOrNotify 不兜住',
    file: 'src/ui/undo-bar.ts',
    test: FILTER,
    expect: 'restoreOrNotify：快照读不回来',
    /**
     * catch 里改成 `throw e`（**保留 warn、去掉轻提示与兜底**）：
     *  · 用例 1 的"要有轻提示"当场红；
     *  · 用例 2 的 `void restoreOrNotify(...)` 会把 reject 漏成 **unhandled** → 整轮判红。
     */
    apply(s) {
      const a = [
        '      console.warn(`[经纬] 还原失败（快照 ${id}）`, e);',
        "      notifyLight('没撤销成功', '这份快照已经不在了（多半已经撤过一次）');",
        '      return null;',
      ].join('\n');
      const b = [
        '      console.warn(`[经纬] 还原失败（快照 ${id}）`, e);',
        '      throw e; // M2：不兜住了',
      ].join('\n');
      return s.includes(a) ? s.replace(a, b) : null;
    },
  },
  {
    id: 'M3-裸查询退化成按文档顺序取第一个',
    file: 'tests/helpers.ts',
    test: FILTER,
    expect: '快照已被消费',
    /**
     * `currentUndoButton` 退回"不过滤 `is-leaving`、按文档顺序取第一个"——
     * 那正是 B1 那只虫的**测试侧根因**。用例 2 收尾那句
     * `ok(!H.currentUndoButton('撤销'), '条已经走了')` 必须当场红。
     */
    apply(s) {
      const a = [
        '  const bars = qa<HTMLElement>(document.body, \'.kbw-undobar\').filter(',
        "    (b) => b.dataset.leaving !== '1' && !b.classList.contains('is-leaving'),",
        '  );',
        '  const bar = bars[bars.length - 1];',
      ].join('\n');
      const b = [
        "  const bars = qa<HTMLElement>(document.body, '.kbw-undobar'); // M3：不过滤离场",
        '  const bar = bars[0]; // M3：按文档顺序取第一个（原虫形）',
      ].join('\n');
      return s.includes(a) ? s.replace(a, b) : null;
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p719' });
