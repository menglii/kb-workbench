/**
 * P7.18b 突变验红（薄壳：MUTATIONS 数组 + 通用运行器 `runMutations`）。
 *
 * 四处（本轮两条口径反转的最险点）：
 *   M1  mover 第 7 步"未声明跳过"复活（旧行为）—— 「搬完也写」判据该红
 *   M2  「现处 X」项点了没反应（run 置空）—— 点它写回的两条链该红
 *   M3  未声明时不画「就住这儿」（并列被拆）—— 并列两项判据该红
 *   M4  搬到库根写空数组（P7.15 老 bug 复活）—— 「声明写 `.`」判据该红
 *
 * 用法：node scripts/mutate-p718b.mjs（**独占跑**：别与全量/部署同时）
 */
import { runMutations } from './mutate-runner.mjs';

const MUTATIONS = [
  {
    id: 'M1-未声明跳过复活',
    file: 'src/services/mover.ts',
    test: '没声明过',
    apply(s) {
      const anchor = '        const rel = relativeTo(parentDir(moved.to), this.settings.kbRoot());';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        `        if (declared.length === 0) continue; // 突变：未声明跳过（旧行为，"留空的保持留空"）
${anchor}`,
      );
    },
  },
  {
    id: 'M2-现处项点了没反应',
    file: 'src/modules/notes/menus.ts',
    test: '现处',
    apply(s) {
      const anchor = `        run: () => onDeclare(),
      });
      return at;`;
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        `        run: () => {}, // 突变：「现处 X」点了没反应
      });
      return at;`,
      );
    },
  },
  {
    id: 'M3-不画「就住这儿」（并列被拆）',
    file: 'src/modules/notes/menus.ts',
    test: 'P7.18b',
    apply(s) {
      const anchor = `      if (undeclared) {
        at.push({`;
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        `      if (false) { // 突变：未声明也不画「就住这儿」
        at.push({`,
      );
    },
  },
  {
    id: 'M4-库根写空数组（P7.15 老 bug 复活）',
    file: 'src/services/mover.ts',
    test: '搬到',
    apply(s) {
      const anchor = '        const r = await this.fm.setMany(file, { 文件位置: rel ? [rel] : [ROOT_POS] });';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '        const r = await this.fm.setMany(file, { 文件位置: rel ? [rel] : [] }); // 突变：库根写空数组',
      );
    },
  },
  {
    id: 'M5-拆非 md 守卫（附件会被写坏）', // 独立审 🔴1 的回销
    file: 'src/services/mover.ts',
    test: '不写前言',
    apply(s) {
      const anchor = "        if (!moved.to.toLowerCase().endsWith('.md')) continue;";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '        // 突变：拆掉非 .md 守卫（附件会被 processFrontMatter 写坏）');
    },
  },
  {
    id: 'M6-拆纯改名守卫（收件箱链被顶掉）', // 独立审 🔴2 的回销
    file: 'src/services/mover.ts',
    test: '纯改名',
    apply(s) {
      const anchor =
        '        if (declared.length === 0 && parentDir(moved.from) === parentDir(moved.to)) continue;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '        // 突变：纯改名也写声明（Inbox 的"未表态"信号被顶掉）');
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p718b' });
