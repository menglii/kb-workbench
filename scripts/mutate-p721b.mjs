/**
 * mutate-p721b.mjs —— P7.21b（AI 地基段二）的突变验红（**5 处最险的新判据**）
 *
 * 纪律全在 `mutate-runner.mjs`（通用运行器）：备份到仓库外 / 锚点自证 / 成绩单 + 失败名单双检 /
 * 对照跑（干净源码必绿）/ 必还原 / 中断安全。这里只写「突哪儿、拿什么词筛、期望谁红」。
 *
 * 五处对应本轮五条最险的判据（开工提示词 §2 点名的草案）：
 *   M1 `grep` 预算截断（到上限不再扫）—— 掐掉后段数超上限、不再写"可能还有更多"；
 *   M2 LRU 失效口径（指纹对不上即作废）—— 掐掉后库变了还拿旧正文、"旧词搜不到"那条红；
 *   M3 参数槽替换（`{{名字}}` 换成填的值）—— 掐掉后正文里残留 `{{主题}}`；
 *   M4 自动挂载的撤下语义（文字不再命中 → 自动撤）—— 掐掉后"文字不命中自动撤下"那条红；
 *   M5 工坊的白名单带过去（当前包的工具白名单进前言）—— 掐掉后产物白名单变"不限制"。
 *
 * ⚠️ 每处突变 = 一次过滤后的 `npm test`（**独占跑**）—— 跑它的时候别再开别的 `npm test`。
 * ⚠️ 过滤词统一 `P7.21b`（本段新增的 26 条用例）。
 *
 * 跑法：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/mutate-p721b.mjs
 */
import { runMutations } from './mutate-runner.mjs';

const FILTER = 'P7.21b';

const MUTATIONS = [
  {
    id: 'M1-grep 预算截断失效（到上限继续扫、不写提示）',
    file: 'src/ui/ai-tools.ts',
    test: FILTER,
    expect: '预算截断',
    apply(s) {
      const a = [
        '      if (hits >= AI_AGENT_LIMITS.grepHits) {',
        '        truncated = true;',
        '        break;',
        '      }',
      ].join('\n');
      const b = '      // M1：预算截断掐掉（全扫、全列）';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null; // 锚点必须**唯一**
      return s.replace(a, b);
    },
  },
  {
    id: 'M2-LRU 指纹失效口径掐掉（库变了还拿旧正文）',
    file: 'src/services/ai/grep.ts',
    test: FILTER,
    expect: '库变即失效',
    apply(s) {
      const a = [
        '    if (hit.fp !== fp) {',
        '      this.map.delete(path);',
        '      return null;',
        '    }',
      ].join('\n');
      const b = [
        '    if (false) { // M2：指纹校验掐掉',
        '      this.map.delete(path);',
        '      return null;',
        '    }',
      ].join('\n');
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M3-参数槽替换失效（正文里残留 {{名字}}）',
    file: 'src/services/ai/skills.ts',
    test: FILTER,
    expect: 'fillSkillParams',
    apply(s) {
      const a = "    out = out.replace(new RegExp(`\\\\{\\\\{\\\\s*${escapeRegExp(name)}\\\\s*\\\\}\\\\}`, 'g'), () => val);";
      const b = '    // M3：替换掐掉（值收下但不落地）';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M4-自动挂载撤下语义掐掉（文字不命中了也不撤）',
    file: 'src/ui/ai-panel.ts',
    test: FILTER,
    expect: '开关开着：命中自动挂',
    apply(s) {
      const a = [
        '    if (!hit) {',
        '      triggerMuted = null; // 文字不再命中任何触发词 → 解除"别再挂它"',
        '      withdrawTriggerSkill();',
        '      return;',
        '    }',
      ].join('\n');
      const b = [
        '    if (!hit) {',
        '      triggerMuted = null; // M4：撤下掐掉',
        '      return;',
        '    }',
      ].join('\n');
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M5-工坊白名单丢失（当前包的白名单没进产物）',
    file: 'src/ui/ai-panel.ts',
    test: FILTER,
    expect: '当前白名单带过去',
    apply(s) {
      const a = "    if (activeSkill?.tools) props['工具白名单'] = activeSkill.tools.slice();";
      const b = '    // M5：白名单带过去掐掉（产物 = 不限制）';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p721b' });
