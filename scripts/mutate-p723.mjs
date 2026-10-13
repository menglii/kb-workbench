/**
 * mutate-p723.mjs —— P7.23（反馈批 7）的突变验红（**5 处最险的新判据**）
 *
 * 纪律全在 `mutate-runner.mjs`（通用运行器）：备份到仓库外 / 锚点自证 / 成绩单 + 失败名单双检 /
 * 对照跑（干净源码必绿）/ 必还原 / 中断安全。这里只写「突哪儿、拿什么词筛、期望谁红」。
 *
 * 五处对应本轮五条最险的判据：
 *   M1 `grid.ts` 的**构建收尾补刷**（M1 修复的根）：掐掉后"重建之后勾选态 == 选中态"
 *      那条当场红（R-A①）——这正是用户报的"之前勾的被取消勾选"的机制；
 *   M2 `ui/dnd.ts` 的 **ghostTranslate 抓取偏移**：掐掉后浮标落点全靠"指针原样"，
 *      纯函数那条与真链路浮标那条都该红；
 *   M3 `ui/dnd.ts` 的 **followPointer 合帧**：每 move 直写之后，"rAF 未到：还是上一帧的值"
 *      那条红（拖动跟手的性能承诺就这么一条判据钉着）；
 *   M4 `ui/dnd.ts` 的 **MOUSE_THRESHOLD**：阈值掐成 0 → "2px 微动 = 打开"那条红
 *     （"想打开结果搬了"的防呆）；
 *   M5 `settings.ts` 的 **treeShowFiles normalize 收敛**：不收敛之后纯函数那条红
 *      （旧 data.json 里的脏值会原样漏进设置）。
 *
 * ⚠️ 每处突变 = 一次过滤后的 `npm test`（**独占跑**）—— 跑它的时候别再开别的 `npm test`。
 * ⚠️ 过滤词统一 `P7.23`（本段新增的 18 条用例）—— 对照跑按词缓存，只跑一次。
 *
 * 跑法：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/mutate-p723.mjs
 */
import { runMutations } from './mutate-runner.mjs';

const FILTER = 'P7.23';

const MUTATIONS = [
  {
    id: 'M1-构建收尾不刷勾选框（M1 修复的根掐掉）',
    file: 'src/modules/notes/grid.ts',
    test: FILTER,
    expect: 'R-A①',
    apply(s) {
      const a = '  paintSelectionDom(initialSel, opts.cursor);';
      const b = '  // paintSelectionDom(initialSel, opts.cursor); // M1：构建收尾不刷（重建后勾选框留空）';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null; // 锚点必须**唯一**
      return s.replace(a, b);
    },
  },
  {
    id: 'M2-抓取偏移掐掉（ghostTranslate 直接落指针）',
    file: 'src/ui/dnd.ts',
    test: FILTER,
    expect: 'ghostTranslate',
    apply(s) {
      const a = '  return { tx: Math.round(x - g.dx - g.left), ty: Math.round(y - g.dy - g.top) };';
      const b = '  return { tx: Math.round(x), ty: Math.round(y) }; // M2：偏移项掐掉';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M3-合帧掐掉（followPointer 每 move 直写）',
    file: 'src/ui/dnd.ts',
    test: FILTER,
    expect: 'followPointer',
    apply(s) {
      const a = ['      pending = { x, y };', '      if (raf === 0) raf = requestAnimationFrame(frame);'].join('\n');
      const b = ['      pending = { x, y };', '      write(x, y); // M3：每 move 直写（合帧掐掉）', '      if (raf === 0) raf = requestAnimationFrame(frame);'].join('\n');
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M4-鼠标阈值掐掉（2px 微动也算拖）',
    file: 'src/ui/dnd.ts',
    test: FILTER,
    expect: '文件行：单击',
    apply(s) {
      const a = 'export const MOUSE_THRESHOLD = 4;';
      const b = 'export const MOUSE_THRESHOLD = 0; // M4：阈值掐掉';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M5-treeShowFiles 不收敛（脏值原样漏进设置）',
    file: 'src/core/settings.ts',
    test: FILTER,
    expect: 'treeShowFiles 的 normalize',
    apply(s) {
      const a = "        if (Array.isArray(v)) out.treeShowFiles = v.filter((x): x is string => typeof x === 'string');";
      const b = "        // if (Array.isArray(v)) out.treeShowFiles = v.filter((x): x is string => typeof x === 'string'); // M5：不收敛";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    /**
     * M6/M7 = **审后修订补突**（独立审 🔴1 / 🟡2 的修复也要被咬一口）：
     *  🔴1 修的是"截断按面板真实容量（5）"—— 突变 = 抄回提示词层的 10；
     *  🟡2 修的是"树文件行模板不可拖"—— 突变 = 拆守卫。
     */
    id: 'M6-问 AI 截断抄回 10（面板真实容量 5 被绕过）',
    file: 'src/modules/notes/batch-bar.ts',
    test: FILTER,
    expect: '面板真实容量',
    apply(s) {
      const a = 'const capped = cur.slice(0, AI_PANEL_REF_CAP);';
      const b = 'const capped = cur.slice(0, 10); // M6：抄回提示词层的数（面板会再静默砍到 5）';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M7-树文件行的模板守卫拆掉（模板可被拖走）',
    file: 'src/modules/notes/tree.ts',
    test: FILTER,
    expect: '模板文件行',
    apply(s) {
      const a = '  if (f.isTemplate) return row;';
      const b = '  // if (f.isTemplate) return row; // M7：模板守卫拆掉';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p723' });
