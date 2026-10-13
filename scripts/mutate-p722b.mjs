/**
 * mutate-p722b.mjs —— P7.22b（AI 段二）的突变验红（**5 处最险的新判据**）
 *
 * 纪律全在 `mutate-runner.mjs`（通用运行器）：备份到仓库外 / 锚点自证 / 成绩单 + 失败名单双检 /
 * 对照跑（干净源码必绿）/ 必还原 / 中断安全。这里只写「突哪儿、拿什么词筛、期望谁红」。
 *
 * 五处对应最险的判据（⚠️ P7.24 · L2 起，"handoff 硬收尾/旗标"两处已退役、
 * 重锚到 L2 新面 —— 见 M1/M2 的新注释；幕后模式（D4）的突变试过 M6、会打断套件运行
 * 而报"没跑起来"（无效检验）→ 撤掉——offstage 已有专门断言钉着，不为它强撑突变）：
 *   M1 `ui/ai-tools.ts` 的 **settled 结算映射**（取消 → 'cancelled'）—— 吞掉之后
 *      "取消 = 零字节"那条拿不到 settled 的如实标记（红）；
 *   M2 `ui/cleanup-panel.ts` 的 **键类预勾**（D2 口径）—— 掐掉后预勾为空、run() 直接
 *      "没得做"，"键类全预勾"那条连卡都等不到（红）；
 *   M3 `task-prompts.ts` 的 **预算截断**（超 6000 字切）—— 掐掉后超长文件整段进 system
 *      （纯函数那条与端到端那条都该红）；
 *   M4 `prompt.ts` 的 **附加层注入**（taskNoteBlock 恒空）—— 掐掉后附加层一个字都进不了
 *      system（注入顺序那条红）；
 *   M5 `transport.ts` 的 **anthropic system 块 + cache_control** —— 掐掉后请求形状不对
 *      （prompt caching 的落点没了）。
 *
 * ⚠️ 每处突变 = 一次过滤后的 `npm test`（**独占跑**）—— 跑它的时候别再开别的 `npm test`。
 * ⚠️ 过滤词统一 `P7.22b`（本段新增的 19 条用例）。
 *
 * 跑法：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/mutate-p722b.mjs
 */
import { runMutations } from './mutate-runner.mjs';

const FILTER = 'P7.22b';

const MUTATIONS = [
  {
    id: 'M1-settled 的取消映射吞掉（L2 重锚）',
    file: 'src/ui/ai-tools.ts',
    test: FILTER,
    expect: '取消 = 零字节',
    apply(s) {
      const a =
        "      settled: r.action === 'executed' ? 'executed' : r.action === 'cancelled' ? 'cancelled' : undefined,";
      const b = "      settled: r.action === 'executed' ? 'executed' : undefined, // M1：取消的 settled 吞掉";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null; // 锚点必须**唯一**
      return s.replace(a, b);
    },
  },
  {
    id: 'M2-cleanup 键类预勾掐掉（D2 口径失效）',
    file: 'src/ui/cleanup-panel.ts',
    test: FILTER,
    expect: '键类全预勾',
    apply(s) {
      const a = "        if (keys === 'all' || keys.includes(k.key)) pickedKeys.add(k.key);";
      // ⚠️ 整行注掉（别写 `if (false) {` —— 括号不配平 → esbuild "Unexpected end of file" → 整套起不来）
      const b = "        // if (keys === 'all' || keys.includes(k.key)) pickedKeys.add(k.key); // M2：不预勾（D2 失效）";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M3-附加层的预算截断掐掉（超长整段进 system）',
    file: 'src/services/ai/task-prompts.ts',
    test: FILTER,
    expect: 'clipTaskPrompt 纯函数',
    apply(s) {
      const a = '  if (all.length <= AI_LIMITS.taskNoteChars) return { text: all, truncated: false };';
      const b = '  if (true) return { text: all, truncated: false }; // M3：截断掐掉';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M4-附加层注入掐掉（taskNoteBlock 恒空）',
    file: 'src/services/ai/prompt.ts',
    test: FILTER,
    expect: '注入顺序',
    apply(s) {
      const a = ['export function taskNoteBlock(note: string | undefined): string[] {', '  const t = String(note ?? \'\').trim();', "  if (t === '') return [];"].join('\n');
      const b = ['export function taskNoteBlock(note: string | undefined): string[] {', '  const t = String(note ?? \'\').trim();', '  if (true) return []; // M4：恒空（注：下面这段留着但走不到）'].join('\n');
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M5-anthropic 的 system 块 + cache_control 掐掉（形状退成裸字符串）',
    file: 'src/services/ai/transport.ts',
    test: FILTER,
    expect: 'chat 请求形状',
    apply(s) {
      const a = "      ...(sys !== '' ? { system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }] } : {}),";
      const b = "      ...(sys !== '' ? { system: sys } : {}), // M5：cache_control 掐掉";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p722b' });
