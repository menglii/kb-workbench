// 样式拼接：styles/*.css → styles.css（顺序即层叠顺序）
// 单独一个模块，好让构建脚本与测试脚本用**同一份**逻辑 ——
// 否则会出现"跑了 npm run build 才过测试"这种假绿。
import fs from 'node:fs';
import path from 'node:path';

export const STYLE_ORDER = [
  'tokens.css',
  'base.css',
  'shell.css',
  'components.css',
  'empty.css',
  'notice.css',
  'menu.css',
  'panel.css',
  'confirm.css',
  'notes.css',
  'board.css',
  'graph.css',
  'home.css',
  'review.css',
  'migrate.css',
  'rebuild.css',
  'suggest.css',
  'ai.css',
  'wizard.css',
  'settings.css',
  'mobile.css',
];

/** 返回拼进去的文件数 */
export function buildStyles(root) {
  const dir = path.join(root, 'styles');
  if (!fs.existsSync(dir)) return 0;
  // ⚠️ 新增的 styles/*.css 若没登记进 STYLE_ORDER 会被**静默丢掉** ——
  // 症状是"真机没样式、离线全绿"（离线只查样式源）。这里直接报错拦住。
  const unregistered = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.css') && !STYLE_ORDER.includes(f));
  if (unregistered.length > 0) {
    throw new Error(
      `styles/ 里有没登记的样式文件：${unregistered.join(' / ')} —— ` +
        '请把它加进 scripts/styles.mjs 的 STYLE_ORDER（否则不会进 styles.css）',
    );
  }
  const present = STYLE_ORDER.filter((f) => fs.existsSync(path.join(dir, f)));
  const css = present
    .map((f) => `/* ══ styles/${f} ══ */\n${fs.readFileSync(path.join(dir, f), 'utf8').trim()}`)
    .join('\n\n');
  fs.writeFileSync(path.join(root, 'styles.css'), `${css}\n`);
  return present.length;
}
