/**
 * mutate-p724.mjs —— P7.24 段 0（树收口三件）的突变验红（**5 处最险的新判据**）
 *
 * 纪律全在 `mutate-runner.mjs`（通用运行器）：备份到仓库外 / 锚点自证 / 成绩单 + 失败名单双检 /
 * 对照跑（干净源码必绿）/ 必还原 / 中断安全。这里只写「突哪儿、拿什么词筛、期望谁红」。
 *
 * 五处对应段 0 最险的五条判据：
 *   M1 `tree.ts` 的 walk 根分支 —— **根恒开复活**（T2 反转的就这一行）：掐回 `isRoot ||`
 *      之后"点根 caret 真收"当场红；
 *   M2 `index.ts` 树 Region key 的 `JSON.stringify(s.open)` —— **join(',') 碰撞复活**：
 *      `[]` 与 `['']` join 都是空串 → "全部收起 → 点根 caret 开回来"不重绘（T3 用例抓到的
 *      就是这个真 bug，这条突变把它钉死）；
 *   M3 `settings.ts` 的 v5→v6 迁移 —— 不补 `''` 之后存量用户的根会静默收起（迁移用例红）；
 *   M4 `tree.ts` 的「收起」按钮显示条件 —— 无脑画之后"未展开的目录不画它"红；
 *   M5 `menus.ts` 根菜单的「全部收起」条目 —— 掐掉之后菜单字面（8 项）与 T3 行为都红。
 *
 * ⚠️ 每处突变 = 一次过滤后的 `npm test`（**独占跑**）—— 跑它的时候别再开别的 `npm test`。
 * ⚠️ 过滤词统一 `P7.24`（本段新增 6 条用例 + 跟着改的 p723 根菜单那 1 条）—— 对照跑按词缓存。
 *
 * 跑法：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/mutate-p724.mjs
 */
import { runMutations } from './mutate-runner.mjs';

const FILTER = 'P7.24';

const MUTATIONS = [
  {
    // ⚠️ id 会进备份文件名 —— 不许含 Windows 非法字符（| / : * ? " < >），上一版带 '||' 当场 ENOENT
    id: 'M1-根恒开复活（isRoot 短路掐回来）',
    file: 'src/modules/notes/tree.ts',
    test: FILTER,
    expect: 'T2：点根 caret',
    apply(s) {
      const a = '    if (opts.open.includes(node.dir)) {\n      for (const child of node.children) walk(child, depth + 1, false);';
      const b = '    if (isRoot || opts.open.includes(node.dir)) { // M1：根恒开复活\n      for (const child of node.children) walk(child, depth + 1, false);';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null; // 锚点必须**唯一**
      return s.replace(a, b);
    },
  },
  {
    id: "M2-树 key 的 join 碰撞复活（JSON.stringify(s.open) 换回 join）",
    file: 'src/modules/notes/index.ts',
    test: FILTER,
    expect: 'T3：根菜单',
    apply(s) {
      const a = '`${s.rev}|${JSON.stringify(s.open)}|${JSON.stringify(s.treeShowFiles)}|${s.dir}|';
      const b = "`${s.rev}|${s.open.join(',')}|${JSON.stringify(s.treeShowFiles)}|${s.dir}|";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M3-v5→v6 迁移不补（存量根静默收起）',
    file: 'src/core/settings.ts',
    test: FILTER,
    expect: 'T2 迁移',
    apply(s) {
      const a = "    if (Array.isArray(to6) && !to6.includes('')) next.treeOpen = [...to6, ''];";
      const b = "    // if (Array.isArray(to6) && !to6.includes('')) next.treeOpen = [...to6, '']; // M3：不补";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M4-「收起」按钮显示条件无脑画（未展开也画）',
    file: 'src/modules/notes/tree.ts',
    test: FILTER,
    expect: 'T1：行尾',
    apply(s) {
      const a = '  if (hasChildren && (isOpen || opts.showFiles.includes(node.dir))) {';
      const b = '  if (hasChildren && true) { // M4：无脑画（未展开也画）';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M5-根菜单「全部收起」条目掐掉',
    file: 'src/modules/notes/menus.ts',
    test: FILTER,
    expect: '根 8 项',
    apply(s) {
      const a = [
        "    ...(dir === ''",
        '      ? [',
        '          {',
        "            kind: 'item',",
        "            label: '全部收起',",
        "            icon: 'chevrons-up',",
        '            run: () => m.onCollapseAll?.(),',
        '          } as MenuItem,',
        '        ]',
        '      : []),',
      ].join('\n');
      const b = ["    ...(dir === ''", '      ? [] // M5：全部收起掐掉', '      : []),'].join('\n');
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    /**
     * M6/M7 = **审后补突**（独立审 🔴2/🟢 家族；照 P7.23 的先例）：
     *  M6 突 A22 的接线（文件行 contextmenu 掐掉 —— A22 此前零突变覆盖）；
     *  M7 把 onTreeKey 的"根恒开"特例放回去（评审 🔴2 的漏网点，用键盘用例咬）。
     */
    id: 'M6-文件行右键接线掐掉（A22 零覆盖补突）',
    file: 'src/modules/notes/tree.ts',
    test: FILTER,
    expect: 'A22：文件行右键',
    apply(s) {
      const a = '  row.addEventListener(\'contextmenu\', (evt) => opts.onFileMenu(f.path, evt));';
      const b = "  // row.addEventListener('contextmenu', (evt) => opts.onFileMenu(f.path, evt)); // M6：接线掐掉";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    /**
     * M8 = **段一 #12 补突**（注释按独立审 🟢11 如实修）：存在性门掐掉后，缺失态走的是
     * `getAbstractFileByPath`（拿不到）→ `JSON.parse('')` 抛 → catch → 报的是
     * "**读不出来**" —— 红的是 #12b 里 `contains('没有这份配置')` 那条
     *（不是"0 个目录"那条 —— 块内已不走 configs.read，不会拿 defaults 造值）。
     */
    id: 'M8-#12 的存在性门掐掉（缺失时拿 defaults() 造默认值）',
    file: 'src/ui/ai-tools.ts',
    test: FILTER,
    expect: '#12b',
    apply(s) {
      const a = '        if (!(await ctx.configs.exists(name))) {';
      const b = '        if (false) { // M8：存在性门掐掉（缺失也读 → 造默认值）';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M7-onTreeKey 根恒开特例放回（评审漏网点）',
    file: 'src/modules/notes/index.ts',
    test: FILTER,
    expect: 'T2 补：根收起时树键盘',
    apply(s) {
      const a = '      if (s.open.includes(n.dir)) for (const c of n.children) walk(c, depth + 1);';
      const b = "      if (s.open.includes(n.dir) || n.dir === '') for (const c of n.children) walk(c, depth + 1); // M7：特例放回";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p724' });
