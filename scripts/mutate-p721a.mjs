/**
 * mutate-p721a.mjs —— P7.21a（AI 地基段一）的突变验红（**5 处最险的新判据**）
 *
 * 纪律全在 `mutate-runner.mjs`（通用运行器）：备份到仓库外 / 锚点自证 / 成绩单 + 失败名单双检 /
 * 对照跑（干净源码必绿）/ 必还原 / 中断安全。这里只写「突哪儿、拿什么词筛、期望谁红」。
 *
 * 五处对应本轮五条最险的判据：
 *   M1 注册表分派（tools 非 null 走工具循环）—— 掐掉后 agent 那条链当场塌；
 *   M2 工作目录横切（挑材料单轮任务的 `inWorkDir` 过滤）—— 恰掉后候选不再收窄；
 *   M3 能力包横切（runner 统一并 skill 进 build 输入）—— 掐掉后管线任务收不到 skill；
 *   M4 ask_user 的跳过口径（跳过不是错误）—— 改成 ok:false 后"跳过"那条判据红；
 *   M5 list 的截断预算（`listLines` 上限）—— 掐掉后 65 个目录全量列出、不再写"还有 N 个"。
 *
 * ⚠️ 每处突变 = 一次过滤后的 `npm test`（**独占跑**）—— 跑它的时候别再开别的 `npm test`。
 * ⚠️ 过滤词统一 `P7.21`（本段新增的 22 条用例）；M1 用 `工具循环：同一批`（打的是既有 agent 判据）。
 *
 * 跑法：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/mutate-p721a.mjs
 */
import { runMutations } from './mutate-runner.mjs';

const FILTER = 'P7.21';

const MUTATIONS = [
  {
    id: 'M1-注册表分派失效（agent 不走工具循环）',
    file: 'src/services/ai/tasks.ts',
    test: '工具循环：同一批',
    expect: '工具循环',
    /** `def.tools !== null` 恒 false = 所有任务都走单轮路 → agent 的循环结果拿不到 */
    apply(s) {
      const a = '  if (def.tools !== null) {';
      const b = '  if (false) { // M1：分派掐掉（agent 也走单轮路）';
      return s.includes(a) ? s.replace(a, b) : null;
    },
  },
  {
    id: 'M2-工作目录横切失效（locus 候选不收窄）',
    file: 'src/services/ai/index.ts',
    test: FILTER,
    expect: '任务 B（locus）',
    /**
     * ⚠️ 锚点要**撑到四处**才锁得死（独立审 🟡5 复核过：只带 `if (only) return only.has(rel);`
     * 三行的话，`index.ts` 里 locus / links **两处逐字同款**、`replace` 命中的是第一处 ——
     * 咬对纯靠 locus 恰好在前面；把两个函数调个序就会悄悄突错地方）。
     * 第 4 行才是独有的：locus 是 `return declaredPositions(...)`、links 是 `return true;`。
     * P7.21a 第一次跑更早的版本还咬错过 classify（锚点只写"注释 + if"两行时）。
     */
    apply(s) {
      const a = [
        '        // 工作目录收窄（横切 · P7.21）：候选也收在范围内',
        '        if (!inWorkDir(rel, input.workDir)) return false;',
        '        if (only) return only.has(rel);',
        '        return declaredPositions(e.props).length === 0;',
      ].join('\n');
      const b = [
        '        // M2：收窄掐掉',
        '        if (only) return only.has(rel);',
        '        return declaredPositions(e.props).length === 0;',
      ].join('\n');
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null; // 锚点必须**唯一**（satisfies runner 的自证口径）
      return s.replace(a, b);
    },
  },
  {
    id: 'M3-能力包横切失效（runner 不并 skill）',
    file: 'src/services/ai/tasks.ts',
    test: FILTER,
    expect: '任务 A（classify）',
    apply(s) {
      const a = `  const messages = def.build({
    ...input,
    skill: cross.skill,
    workDir: cross.workDir,
  });`;
      const b = `  const messages = def.build({
    ...input,
    skill: undefined, // M3：横切掐掉
    workDir: cross.workDir,
  });`;
      return s.includes(a) ? s.replace(a, b) : null;
    },
  },
  {
    id: 'M4-ask_user 跳过当错误',
    file: 'src/ui/ai-tools.ts',
    test: FILTER,
    expect: '跳过两条路',
    apply(s) {
      const a = "    if (text === '') return { ok: true, summary: '用户跳过（没有回答这个问题）' };";
      const b = "    if (text === '') return { ok: false, summary: '用户跳过（没有回答这个问题）' }; // M4：跳过当错误";
      return s.includes(a) ? s.replace(a, b) : null;
    },
  },
  {
    id: 'M5-list 截断预算失效',
    file: 'src/ui/ai-tools.ts',
    test: FILTER,
    expect: 'list 截断',
    apply(s) {
      const a = '    for (const d of shown.slice(0, AI_AGENT_LIMITS.listLines)) {';
      const b = '    for (const d of shown) { // M5：截断掐掉';
      return s.includes(a) ? s.replace(a, b) : null;
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p721a' });
