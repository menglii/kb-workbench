// 构建：TypeScript → main.js（CJS，供 Obsidian 宿主 require）
// 约定见 方案设计.md §7.2 / §10：format:cjs · platform:browser · external:['obsidian',…] · target:es2018 · 零运行时依赖
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStyles } from './scripts/styles.mjs';
import { bannerLine, computeFingerprint } from './scripts/build-fingerprint.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WATCH = process.argv.includes('--watch');

/**
 * **构建指纹**（P7.20-9）：把 src 下全部 .ts 的哈希作为一行注释写进产物。
 * 真机探针会拿它跟"当前工作区源码指纹"比 —— 比不齐就整轮中止（见 `scripts/build-fingerprint.mjs`）。
 * ⚠️ watch 模式下这行是**启动那一刻**算的，之后改 src 触发重建也**不会**更新 ——
 *    想让它精确（比如要跑探针），用 `npm run build` 而不是 watch。
 */
const FP = computeFingerprint(ROOT);

// 绝不打包进 bundle —— 运行时由宿主注入（obsidian）或由 Node 提供（electron / 内置模块）
const EXTERNAL = [
  'obsidian',
  'electron',
  // Node 内置（桌面端可能被间接引用，必须外置；手机端由平台兜底）
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https',
  'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'stream', 'string_decoder',
  'timers', 'tty', 'url', 'util', 'zlib', 'node:assert', 'node:buffer', 'node:crypto',
  'node:events', 'node:fs', 'node:os', 'node:path', 'node:process', 'node:stream',
  'node:url', 'node:util',
];

const BANNER =
  '/* 经纬 · 知识工作台 —— 构建产物，请勿直接编辑（源码仓：工作台插件开发/） */\n' +
  bannerLine(FP.fp);

const options = {
  entryPoints: [path.join(ROOT, 'src/main.ts')],
  outfile: path.join(ROOT, 'main.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2018',
  external: EXTERNAL,
  banner: { js: BANNER },
  logLevel: 'warning',
  treeShaking: true,
  sourcemap: false,
  minify: false, // 不压缩：真机排查时栈帧要能对上源码
  legalComments: 'none',
};

if (WATCH) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  buildStyles(ROOT);
  fs.watch(path.join(ROOT, 'styles'), { persistent: true }, () => {
    const n = buildStyles(ROOT);
    console.log(`[styles] styles.css 已重建（${n} 个文件）`);
  });
  console.log('[watch] 监听中……（main.js + styles.css）');
} else {
  await esbuild.build(options);
  const n = buildStyles(ROOT);
  const main = fs.statSync(path.join(ROOT, 'main.js')).size;
  const css = fs.statSync(path.join(ROOT, 'styles.css')).size;
  console.log(
    `[build] main.js ${(main / 1024).toFixed(1)} KB · styles.css ${(css / 1024).toFixed(1)} KB（${n} 个样式文件）` +
      ` · 源码指纹 ${FP.fp}（${FP.files} 个 src .ts）`,
  );
}
