/**
 * mutate-p8.mjs —— P8「回顾」（外部交付移植）的突变验红（**5 处最险的新判据**）
 *
 * 纪律全在 `mutate-runner.mjs`（通用运行器）：备份到仓库外 / 锚点自证 / 成绩单 + 失败名单双检 /
 * 对照跑（干净源码必绿）/ **expect 名单**（"预期那条"进失败名单才算咬住）/ 必还原 / 中断安全。
 *
 * 五处对应本批最险的五条判据：
 *   M1 `review.ts` 的 `applyGrade` 记住档 —— **1→3 改回 1→2**（交付件特意说明"跳 2 太碎"）：
 *      「记住」用例钉的绝对值当场红；
 *   M2 `review.ts` 的 `addDays` —— 换成注释里明说要避免的 `ts + n*86400000`：
 *      半自证的用例（期望值由 addDays 自己算）**照样绿**，唯一能咬住的是
 *      「addDays 钉**绝对值**」那条（人算死的跨月/跨年/闰年）—— 这条突变就是为它设的；
 *   M3 `prompt.ts` 的 `parseReview` —— **放水**（缺一面不拦、补空串放行）：
 *      「解析失败**报出原因**」当场红（这是"AI 解析失败要报出来、不去猜"那条纪律的闸）；
 *   M4 `review-create.ts` 的确认流闸 —— `res.action !== 'primary'` 掐掉：
 *      **只有取消反例会红**（"一路点到底"的真链路线看不出来 —— 这正是要验的分辨力）；
 *   M5 `review.ts` 的 `remapCards` 整目录前缀分支 —— 掐掉只留精确命中：
 *      「精确命中 + 整目录前缀」红（改文件夹名时底下所有卡会一起指空，只有真机才现形的账）。
 *
 * ⚠️ 每处突变 = 一次过滤后的 `npm test`（**独占跑**）—— 跑它的时候别再开别的 `npm test`。
 * ⚠️ 过滤词统一 `P8`（本批新增用例名都带 `P8 ·`；对照跑按词缓存）。
 * ⏳ 候补（本轮未突，记交接欠账）：C7 接线的 `void this.checkKeySafety();` 拔掉 →
 *    只红「接线：配了 key + 库有痕迹」一条（外部交付线验过同款；本仓下一轮补突）。
 *
 * 跑法：
 *   NODE_OPTIONS="--require C:/Users/<你的用户名>/.tooling/shims/kbw-spawn-fix.cjs" \
 *     "F:/03_DevTools/Node.js/node.exe" scripts/mutate-p8.mjs
 */
import { runMutations } from './mutate-runner.mjs';

const FILTER = 'P8';

const MUTATIONS = [
  {
    // ⚠️ id 会进备份文件名 —— 不许含 Windows 非法字符（| / : * ? " < >）
    id: 'M1-记住档 1→3 改回 1→2（跳 2 太碎那条拍板）',
    file: 'src/services/review.ts',
    test: FILTER,
    expect: '记住：1 → 3',
    apply(s) {
      const a = '    const interval = card.interval <= 1 ? 3 : card.interval * 2;';
      const b = '    const interval = card.interval <= 1 ? 2 : card.interval * 2; // M1：改回 1→2';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null; // 锚点必须**唯一**
      return s.replace(a, b);
    },
  },
  {
    id: 'M2-addDays 换成 ts + n×86400000（跨天判据差一格的经典错）',
    file: 'src/services/review.ts',
    test: FILTER,
    expect: 'addDays 钉',
    apply(s) {
      const a = [
        'export function addDays(ts: number, days: number): number {',
        '  const d = new Date(startOfDay(ts));',
        '  d.setDate(d.getDate() + days);',
        '  return d.getTime();',
        '}',
      ].join('\n');
      const b = [
        'export function addDays(ts: number, days: number): number {',
        '  return ts + days * 86400000; // M2：注释里明说要避免的那一行',
        '}',
      ].join('\n');
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M3-parseReview 放水（缺一面不拦、补空串放行）',
    file: 'src/services/ai/prompt.ts',
    test: FILTER,
    expect: '解析失败**报出原因**',
    apply(s) {
      const a = '    if (front === \'\' || back === \'\') {';
      const b = '    if (false) { // M3：放水（缺面不拦）';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M4-确认流闸掐掉（res.action !== primary）',
    file: 'src/ui/review-create.ts',
    test: FILTER,
    expect: '反例：确认流里取消',
    apply(s) {
      const a = "  if (res.action !== 'primary') return 0;";
      const b = "  if (false) return 0; // M4：确认流闸掐掉";
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
  {
    id: 'M5-迁键整目录前缀分支掐掉（只留精确命中）',
    file: 'src/services/review.ts',
    test: FILTER,
    expect: '整目录前缀',
    apply(s) {
      const a = '    if (c.note.startsWith(prefix)) {';
      const b = '    if (false) { // M5：前缀分支掐掉';
      if (!s.includes(a)) return null;
      if (s.split(a).length !== 2) return null;
      return s.replace(a, b);
    },
  },
];

await runMutations(MUTATIONS, { tag: 'p8' });
