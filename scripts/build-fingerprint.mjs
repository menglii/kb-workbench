/**
 * scripts/build-fingerprint.mjs —— **构建指纹**（P7.20-9）
 *
 * 回答一个此前没人能回答的问题：
 *   **真机上那个跑着的插件实例，是不是"当前这份源码"构建出来的？**
 *
 * 为什么需要它（这是本轮**实测**踩出来的坑，不是假想题）：
 *   · 探针的 `重载插件` 前置只是 `disablePlugin` → `enablePlugin`，它读的是**库里的 main.js**
 *     （`<库>/.obsidian/plugins/kb-workbench/main.js`）；
 *   · 而 `npm run build` 只写**工作区**的 `main.js` —— 中间还差一步 `npm run deploy:sandbox`（拷贝）；
 *   · ⇒ 于是"改了 src、build 了、没 deploy"这一种状态下，探针会**心安理得地在旧代码上跑完**
 *     并报 158/158 全绿。数字是真的，被测的东西是旧的 —— 正是本项目最忌讳的那类假绿。
 *     反方向也一样：改了 src、连 build 都没跑，探针照样"绿"。
 *
 * 做法（**零运行时副作用**）：
 *   ① 构建时把 src 下全部 .ts 的内容哈希（sha256 截 8 位）作为**一行注释**写进 main.js 的 banner；
 *   ② 探针在库内读 `<库>/.obsidian/plugins/kb-workbench/main.js`，抠出那行注释里的指纹；
 *   ③ 跟"当前工作区源码指纹"比 —— 一致才算"跑的是这份源码"，不一致就**整轮中止**（红线步里做）。
 *
 * ⚠️ 为什么用**注释**而不是 esbuild `define` + 一个变量：
 *   注释不产生任何运行时代码、不动 bundle 布局、不改产物字节数（除这一行本身），
 *   而 `define` 要求在 src 里多一处引用（多一处"为了工具存在的生产代码"）。
 *   抠指纹的代价是一个正则 —— 值。
 *
 * ⚠️ 范围**只有 `src/`**（bundle 的唯一来源）。`styles/` 不进 main.js（它进 styles.css），
 *   所以"样式源改了没重建"这一类它**认不出** —— 这条边界写在 `FINGERPRINT_DIRS` 旁边，
 *   别以为它管得比实际宽。
 *
 * ⚠️ `last-green.mjs` 那个"指纹"是**另一回事**（源码指纹，范围含 tests/scripts/styles/manifest，
 *   存在 `.tmp/.last-green.json`，答的是"基线能不能免跑"）。别混用、别互相比。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 进指纹的范围（相对仓库根）。**只有 src/**：它是 main.js 的全部来源。 */
export const FINGERPRINT_DIRS = ['src'];

/** 写进 banner 的标记名。改它要同步改这里（唯一真源），别在别处硬编码。 */
export const MARK = 'KBW-BUILD-FINGERPRINT';

/** 抠指纹用的正则（唯一真源）：探针把它 `.source` 拼进页面脚本来用，不在页面里另写一份。 */
export const FINGERPRINT_RE = new RegExp(MARK + ':([0-9a-f]{8})');

/** 递归收集文件（只收 .ts），**排序**由调用方做 —— 顺序必须与机器无关。 */
function walk(dir, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 算工作区源码指纹：`src/**...ts` 的**路径 + 内容**喂进 sha256，取前 8 位。
 * ⚠️ 路径也喂进去（否则"把 A 改名成 B"这类改动不算变化）；用 `/` 归一（跨平台一致）。
 */
export function computeFingerprint(root) {
  const files = [];
  for (const d of FINGERPRINT_DIRS) walk(path.join(root, d), files);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(root, f).replace(/\\/g, '/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return { fp: h.digest('hex').slice(0, 8), files: files.length };
}

/** 从任意文本（main.js 的内容）里抠出指纹；没有 → 空串（= 旧构建 / 不是我们的产物）。 */
export function readFingerprint(text) {
  const m = FINGERPRINT_RE.exec(typeof text === 'string' ? text : '');
  return m ? m[1] : '';
}

/** 生成 main.js 顶部那行注释（构建脚本用）。 */
export function bannerLine(fp) {
  return `/* ${MARK}:${fp} —— 源码指纹（src/**.ts）；真机探针拿它自证"跑的份是不是这份源码（P7.20-9）" */`;
}
