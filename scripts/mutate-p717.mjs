/**
 * P7.17 突变验红（薄壳：MUTATIONS 数组 + 通用运行器 `runMutations`）。
 *
 * 七处（本轮 3–5 处最险 + **P7.16b 的两块欠账面**——欠账清单点名要补）：
 *   M1  templates：`mergeMissingTemplateKeys` 退回"什么都不做" —— **修洞**该红（旧口径）
 *   M2  templates：fill 模式不跳已有键（"已有键一个字节不动"被破）—— 成对判据该红
 *   M3  backfill-panel：写盘不传 `withPosition`（D1 两侧漂了）—— 面板真链路该红
 *   M4  templates：拆掉坏前言守卫 —— "整篇跳过 / 文件一字不动"该红
 *   M5  migrate：映射表把「想法」写歪 —— "建议值来自映射表（一个真源）"该红
 *   M6  native-position：拆掉"动作在飞"守卫（P7.16b 真机抓到的那枚）—— 重开菜单判据该红
 *   M7  native-position：关菜单不摘遮蔽类（平台建议恢复原样那条）—— 该红
 *   M8  notes/ops：共享链不写补声明（P7.16b 的补声明口径）—— "未声明也写"该红
 *
 * 用法：node scripts/mutate-p717.mjs（**独占跑**：别与全量/部署同时）
 */
import { runMutations } from './mutate-runner.mjs';

const MUTATIONS = [
  {
    id: 'M1-修洞退回旧口径',
    file: 'src/services/templates.ts',
    test: '修洞',
    apply(s) {
      const anchor = "  return mergeYamlBlock(text, opts, 'fill');";
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '  return { text, added: [] }; // 突变：有前言就一个字都不碰（旧口径）',
      );
    },
  },
  {
    id: 'M2-fill不跳已有键',
    file: 'src/services/templates.ts',
    test: '修洞',
    apply(s) {
      const anchor = '      if (findIdx(key) >= 0) continue;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      // 突变：已有键也照覆盖（"一个字节不动"被破）');
    },
  },
  {
    id: 'M3-D1写盘不传withPosition',
    file: 'src/ui/backfill-panel.ts',
    test: '面板真链路',
    apply(s) {
      const anchor = 'const outcome = await ctx.completion.fillFile(file, { withPosition: true });';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, 'const outcome = await ctx.completion.fillFile(file, {}); // 突变：D1 口径丢了');
    },
  },
  {
    id: 'M4-拆坏前言守卫',
    file: 'src/services/templates.ts',
    test: '坏前言整篇跳过',
    apply(s) {
      const anchor = '  if (fragile.length > 0) {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  if (false) { // 突变：拆掉坏前言守卫');
    },
  },
  {
    id: 'M5-映射表写歪',
    file: 'src/services/migrate.ts',
    test: '旧值待迁',
    apply(s) {
      const anchor = "  想法: '笔记',";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, "  想法: '索引', // 突变：建议值不再来自（正确的）映射表");
    },
  },
  {
    id: 'M6-拆动作在飞守卫', // P7.16b 欠账面（真机首跑抓到的那枚）
    file: 'src/ui/native-position.ts',
    test: 'P7.16b · 原生面板那一格',
    apply(s) {
      const anchor = '    if (actingOn === input) return;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    // 突变：拆掉"动作在飞"守卫（焦点回归会重开菜单）');
    },
  },
  {
    id: 'M7-关菜单不摘遮蔽类', // P7.16b 欠账面（平台建议恢复原样）
    file: 'src/ui/native-position.ts',
    test: 'P7.16b · 原生面板那一格',
    apply(s) {
      const anchor = `    open = null;
    document.body.classList.remove(NATIVE_MENU_OPEN_CLASS);
    cur.handle.close();`;
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        `    open = null;
    cur.handle.close(); // 突变：遮蔽类不摘`,
      );
    },
  },
  {
    id: 'M8-共享链不写补声明', // P7.16b 欠账面（"未声明也写声明"口径）
    file: 'src/modules/notes/ops.ts',
    test: '未声明选目录',
    apply(s) {
      const anchor = '  if (moved && !moved.error) await declareLandingsAfterMove(ctx, moved);';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  if (false && moved && !moved.error) await declareLandingsAfterMove(ctx, moved); // 突变：不补声明');
    },
  },
  {
    id: 'M9-陈旧引用者不过滤', // P7.17 · 快照 ENOENT 修法（真机取证：resolvedLinks 残留 source 键）
    file: 'src/services/mover.ts',
    test: '陈旧引用者',
    apply(s) {
      const anchor = '      if (!(this.app.vault.getAbstractFileByPath(src) instanceof TFile)) continue;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      // 突变：陈旧 source 键不过滤（幽灵路径会进快照 → 整批中止）');
    },
  },
  {
    id: 'M10-空声明不算缺', // 独立审 🟡2：`文件位置: []` 要补（D1 承诺对这类篇也成立）
    file: 'src/services/templates.ts',
    test: '顶层写',
    apply(s) {
      const anchor = "      if (after === '[]') return false;";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, "      if (after === '[]') return true; // 突变：键在值空不算缺");
    },
  },
  {
    id: 'M11-自动归位敢搬进归集夹', // P7.17 真机残留的护栏（收拢在途痕迹）
    file: 'src/services/reconcile.ts',
    test: '归集夹',
    apply(s) {
      const anchor = '    if (isCollectDir(want)) {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    if (false) { // 突变：目标归集夹也敢搬（残留会回来）');
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p717' });
