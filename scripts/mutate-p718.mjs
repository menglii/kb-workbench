/**
 * P7.18 突变验红（薄壳：MUTATIONS 数组 + 通用运行器 `runMutations`）。
 *
 * 五处（本轮 3–5 处最险 —— **删除链优先**）：
 *   M1  只删勾选的键（planKeyWrites 不看勾选、写死两个键）—— 成对判据「其余键逐字节不动」该红
 *   M2  快照先行（快照句柄置空 = 没快照可还原）—— 撤销判据该红
 *   M3  坏前言跳过（扫描侧放它进键计数）—— 「不计进样例 / 一字不动」该红
 *   M4  默认全不勾（勾选框初始就勾上）—— 「默认全不勾」该红
 *   M5  危险两段确认（上膛文案被改掉）—— 第二下点不到「再点一次确认」该红
 *
 * 用法：node scripts/mutate-p718.mjs（**独占跑**：别与全量/部署同时）
 */
import { runMutations } from './mutate-runner.mjs';

const MUTATIONS = [
  {
    id: 'M1-只删勾选的键被破',
    file: 'src/services/cleanup.ts',
    test: '只该键消失',
    apply(s) {
      const anchor = '    const hit = keys.filter((k) => Object.prototype.hasOwnProperty.call(e.props, k));';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        "    const hit = ['类型', '状态'].filter((k) => Object.prototype.hasOwnProperty.call(e.props, k)); // 突变：不看勾选",
      );
    },
  },
  {
    id: 'M2-快照句柄丢了（撤销失效）',
    file: 'src/ui/cleanup-panel.ts',
    test: '只该键消失',
    apply(s) {
      const anchor = '      snapId = snap.id;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, "      snapId = ''; // 突变：快照没拍（撤销条变成空动作）");
    },
  },
  {
    id: 'M3-坏前言放行（扫描侧）',
    file: 'src/services/cleanup.ts',
    test: '坏前言',
    apply(s) {
      const anchor = '    if (bad.length > 0) {\n      fragile.push({ path: e.path, basename: e.basename, why: `前言里有嵌套值（${bad.join(\'、\')}）` });\n      continue; // 整篇跳过：这些篇的键**不计进计数**（写了也会被守卫拦下）\n    }';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '    if (bad.length > 0) {\n      fragile.push({ path: e.path, basename: e.basename, why: `前言里有嵌套值（${bad.join(\'、\')}）` });\n      // 突变：不 continue —— 坏前言篇也计进键计数\n    }',
      );
    },
  },
  {
    id: 'M4-默认就勾上',
    file: 'src/ui/cleanup-panel.ts',
    test: '逐键删',
    apply(s) {
      const anchor = '      cb.checked = pickedKeys.has(k.key);';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      cb.checked = true; // 突变：默认勾上（危险动作不该预勾）');
    },
  },
  {
    id: 'M5-两段确认被拆',
    file: 'src/ui/cleanup-panel.ts',
    test: '坏前言跳过',
    apply(s) {
      const anchor = "        confirmLabel: '再点一次确认',";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, "        confirmLabel: '执行', // 突变：上膛文案没了");
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p718' });
