// 让 Obsidian 重载本插件（等价于设置里"关掉再打开"），走 CDP
//
// 为什么需要它：改完 main.js 必须重载插件才生效。手动点两次很烦，
// 且 P1 之后每次调样式都要重载 —— 一条命令解决。
//
// ⚠️ **红线**：只在**实验库**上重载（`cdp-page.mjs` 逐页问它开着哪个库，
//    按 `vault-guard.mjs` 的双判据挑页）。原先它"只管连第一个调试页"，
//    真库开着时会在真库里重载插件 —— P0 收尾的审查抓到过这条。
//
// 用法：npm run reload      （前置：Obsidian 带 --remote-debugging-port 启动，见 probe:launch）
import { connectSandbox } from './cdp-page.mjs';

const PLUGIN_ID = process.env.KBW_PLUGIN_ID ?? 'kb-workbench';

let cdp;
try {
  cdp = await connectSandbox({ what: '重载插件' });
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

const expr = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
  if (!p) return '插件没加载';
  await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
  await wait(400);
  await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
  await wait(900);
  const again = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
  const orphans = ['.kbw-notices', '.kbw-menu', '.kbw-modal', '.kbw-backdrop', '.kbw-panel', '.kbw-undobar-wrap']
    .map((s) => document.querySelectorAll(s).length).reduce((a, b) => a + b, 0);
  return (again ? '已重载 v' + again.manifest.version : '重载后不见了') + '｜悬挂浮层 DOM=' + orphans;
})()`;

try {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    console.error('✗ 重载时抛异常：');
    console.error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '');
    process.exit(1);
  }
  console.log(`✓ ${r.result?.value ?? '(没有返回)'}｜库=${cdp.vault}`);
} finally {
  cdp.close();
}
