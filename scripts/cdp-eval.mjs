// 真机求值小工具：把一段 JS 丢进 Obsidian 渲染进程跑，打印返回值
//
// 用法：
//   node scripts/cdp-eval.mjs "document.title"
//   node scripts/cdp-eval.mjs "JSON.stringify(app.vault.getMarkdownFiles().length)"
//   node scripts/cdp-eval.mjs "app.plugins.plugins['kb-workbench'].context().index.getAll().length"
//
// ⚠️ **红线**：只接**实验库**那个页（`cdp-page.mjs` 逐页问它开着哪个库，双判据挑页）。
//    这条命令能执行任意表达式 —— 连到真库页上就等于给真库开了个写入口。
//
// 前置同 probe：Obsidian 要带 --remote-debugging-port 启动（npm run probe:launch）
import { connectSandbox } from './cdp-page.mjs';

const expr = process.argv.slice(2).join(' ');
if (!expr) {
  console.error('用法：node scripts/cdp-eval.mjs "<表达式>"');
  process.exit(1);
}

let cdp;
try {
  cdp = await connectSandbox({ what: '在页面里求值' });
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

try {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    console.error('页面里抛异常：');
    console.error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    process.exit(1);
  }
  const v = r.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
} finally {
  cdp.close();
}
