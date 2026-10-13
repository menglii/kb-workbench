/**
 * mutate-p722a.mjs —— P7.22a（AI 写面扩容）的突变验红（**5 处最险的新判据**）
 *
 * 纪律全在 `mutate-runner.mjs`（通用运行器）：备份到仓库外 / 锚点自证 / 成绩单 + 失败名单双检 /
 * 对照跑（干净源码必绿）/ 必还原 / 中断安全。这里只写「突哪儿、拿什么词筛、期望谁红」。
 *
 * 五处对应本轮五条最险的判据（开工提示词 §2 点名的草案）：
 *   M1 `planPatchText` 的**多命中拒**（>1 处不写）—— 掐掉后"多命中"那条红（会静默换第一处）；
 *   M2 三态幂等的**"已改过"态**（0 处且 replace 在 → 跳过）—— 掐掉后重复执行不再被识别；
 *   M3 `planAppend` 的**尾部包含检查**（幂等的自证口径）—— 掐掉后重复追加会真的写第二遍；
 *   M4 `agent.ts` 的**每步 30 个动作截断**（切片 + 溢出如实说）—— 掐掉后 31 个全执行；
 *   M5 `executeApproved` 属性段的**写前补快照**（#11）—— 掐掉后撤销条还原不了（且"快照失败不写"也失效）。
 *
 * ⚠️ 每处突变 = 一次过滤后的 `npm test`（**独占跑**）—— 跑它的时候别再开别的 `npm test`。
 * ⚠️ 过滤词统一 `P7.22a`（本段新增的 13 条用例）。
 *
 * 跑法：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/mutate-p722a.mjs
 */
import { runMutations } from './mutate-runner.mjs';

const FILTER = 'P7.22a';

const MUTATIONS = [
  {
    id: 'M1-patch_text 多命中拒失效（静默换第一处）',
    file: 'src/services/ai/text-edit.ts',
    test: FILTER,
    expect: '多命中',
    apply(s) {
      const a = ['  if (n === 1) {', '    return { body: body.replace(find, replace) };', '  }'].join('\n');
      const b = ['  if (n >= 1) { // M1：多命中拒掐掉', '    return { body: body.replace(find, replace) };', '  }'].join(
        '\n',
      );
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null; // 锚点必须**唯一**
      return s.replace(a, b);
    },
  },
  {
    id: 'M2-已改过态失效（0 处且 replace 在 → 不再识别为已打）',
    file: 'src/services/ai/text-edit.ts',
    test: FILTER,
    expect: '已改过',
    apply(s) {
      const a = "    if (replace.trim() !== '' && body.includes(replace)) {";
      const b = '    if (false) { // M2：已打态掐掉';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M3-append 尾部包含检查失效（重复追加照写）',
    file: 'src/services/ai/text-edit.ts',
    test: FILTER,
    expect: '重复追加',
    apply(s) {
      const a = '  if (body.trimEnd().endsWith(content.trimEnd())) {';
      const b = '  if (false) { // M3：尾部包含检查掐掉';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M4-一步 30 个动作的截断失效（31 个全执行）',
    file: 'src/services/ai/agent.ts',
    test: FILTER,
    expect: '31 个动作一步',
    apply(s) {
      const a = '      const usableRaw = parsed.actions.slice(0, AI_AGENT_LIMITS.maxCallsPerStep);';
      const b = '      const usableRaw = parsed.actions.slice(0, 999); // M4：30 上限掐掉';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M5-属性段写前补快照掐掉（撤销还原不了 · 快照失败也不拦）',
    file: 'src/ui/ai-tools.ts',
    test: FILTER,
    expect: '逐字节',
    apply(s) {
      /**
       * ⚠️ 锚点随 P7.22a 审后修订更新（🟢11 给 capture 包了 `if (propFiles.length > 0)`，
       * 缩进 +2）——锚点必须跟着实现走，不然会以"锚点没命中"判红（那是假红）。
       */
      const a = [
        '        try {',
        '          const snap = await ctx.snapshot.capture({',
        '            reason: `AI 改属性 / 标签：${propFiles.length} 篇`,',
        '            files: propFiles,',
        '          });',
        '          propSnapId = snap.id;',
      ].join('\n');
      const b = [
        '        try {',
        "          const snap = { id: 'M5-没拍快照' } as { id: string }; // M5：快照掐掉",
        '          propSnapId = snap.id;',
      ].join('\n');
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p722a' });
