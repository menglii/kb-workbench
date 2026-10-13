// 探针脚本的 **0.2 秒自检** —— 改完 `scripts/probe.mjs` / `probe-helpers.mjs` 先跑它。
//
// 用法：npm run lint:probe
//
// 为什么要有这个脚本（这一条是拿真实代价换来的）：
//   探针的"步骤模板"与 `HELPERS` 都是 **`String.raw` 模板字符串** —— 里面**不许出现反引号**
//   （一个都会提前结束模板，把后面整段中文注释变成真代码）。而 `node --check` **查不出来**
//   （它只看语法，而"提前结束 + 后面恰好也能解析"这种情况它不报）。
//
//   P6 段④ 这一轮，我在注释里写反引号**栽了 8 次**（`probe.mjs` 6 次 + `probe-helpers.mjs` 2 次），
//   每次都是靠 `KBW_PROBE_NO_RUN=1 node -e "import('./scripts/probe.mjs')"` 当场抓住 ——
//   但那条命令又长又难记，于是每次都要重打一遍。**把它变成一个名字。**
//
//   五条判据（缺一不可）：
//     ① 两个文件**能被 import**（语法错、模板被截断都会在这里炸）
//     ② `HELPERS` 的**函数体能被 `new Function` 求值**（光 import 不够 ——
//        模板截断后剩下的部分有时仍是合法 JS）
//     ③ 两个模板区域里**没有残留的反引号**（逐字符扫，比 ② 更直接）
//     ④ 冒烟名单 `PROBE_SMOKE` **不缩水**（按子串匹配步骤名，改名忘了同步会静默变薄）
//     ⑤ **每条 step 的 `script` 能单独编译**（P7.19 #5 —— "整模块 import 过了、单条却编译不了"
//        那条缝；`new Function(s.script)` 逐条来，报错点名是哪一条 step）
//
// ⚠️ 它**不替代** `tests/specs/redline.ts` 里那条静态断言 —— 那条在 `npm test` 里跑（7 分钟），
// 这一条是**改动时**的即时反馈。两条都留着。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

const problems = [];

/** 把 `export const X = String.raw\`…\`;` 的**模板体**切出来（不含两侧反引号） */
function rawTemplateBody(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return null;
  const start = src.indexOf('`', i + decl.length - 1);
  if (start < 0) return null;
  const open = src.indexOf('`', src.indexOf('String.raw', i));
  if (open < 0) return null;
  // 结尾那个反引号：模板体里**不许有**反引号，所以 body 里第一个反引号就是结尾？
  // —— 不对，正是"有残留"才是我们要抓的。所以从**末尾**往前找最后一个反引号当结尾，
  // 中间的（如果有）全部报出来。
  const end = src.lastIndexOf('`');
  if (end <= open) return null;
  return { body: src.slice(open + 1, end), open, end };
}

// ── ① probe.mjs 能被求值 ────────────────────────────────────────
process.env.KBW_PROBE_NO_RUN = '1';
let probeMod = null;
try {
  probeMod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'probe.mjs')).href);
} catch (e) {
  problems.push(`scripts/probe.mjs 求值失败：${e.message}`);
}

// ── ② probe-helpers.mjs 的 HELPERS 能被求值 ─────────────────────
const helpersPath = path.join(ROOT, 'scripts', 'probe-helpers.mjs');
let helpersSrc = '';
try {
  const mod = await import(pathToFileURL(helpersPath).href);
  const helpers = mod.HELPERS;
  if (typeof helpers !== 'string' || helpers.length === 0) {
    problems.push('probe-helpers.mjs 的 HELPERS 不是非空字符串');
  } else {
    try {
      new Function(helpers);
    } catch (e) {
      problems.push(`HELPERS 的函数体求值失败（多半是模板被截断）：${e.message}`);
    }
  }
  helpersSrc = fs.readFileSync(helpersPath, 'utf8');
} catch (e) {
  problems.push(`scripts/probe-helpers.mjs 求值失败：${e.message}`);
}

// ── ③ 两个模板区域里不许有残留的反引号 ──────────────────────────
/**
 * 逐字符数：`STEPS` 那一段里，**每个 `script: \`` 之后到它配对的 `` `, `` 之间**不许有反引号；
 * `HELPERS` 的模板体里同理。数出来就报行号 —— 别只报"有错"（那还得自己去搜）。
 */
function scanStepTemplates(src, label) {
  const i = src.indexOf('export const STEPS = [');
  if (i < 0) {
    problems.push(`${label}：找不到 STEPS（改名了？这条判据要跟着改）`);
    return;
  }
  const seg = src.slice(i);
  const base = src.slice(0, i).split('\n').length - 1;
  const re = /script: `/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    const start = m.index + m[0].length;
    const end = seg.indexOf('`,', start);
    if (end < 0) {
      problems.push(`${label}：有一个 script 模板没有结束（第 ${base + seg.slice(0, start).split('\n').length} 行起）`);
      break;
    }
    const inner = seg.slice(start, end);
    const at = inner.indexOf('`');
    if (at >= 0) {
      const line = base + seg.slice(0, start + at).split('\n').length;
      const snippet = inner.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, '⏎');
      problems.push(`${label} 第 ${line} 行：步骤模板里有反引号（会提前结束模板）→ …${snippet}…`);
    }
  }
}

scanStepTemplates(fs.readFileSync(path.join(ROOT, 'scripts', 'probe.mjs'), 'utf8'), 'probe.mjs');
if (helpersSrc) {
  const t = rawTemplateBody(helpersSrc, 'export const HELPERS');
  if (!t) {
    problems.push('probe-helpers.mjs：切不出 HELPERS 的模板体');
  } else {
    // 模板体里出现反引号 = 提前结束（我们的切法已经取了最后一个当结尾，所以中间的都算残留）
    const inner = t.body;
    const at = inner.indexOf('`');
    if (at >= 0) {
      const line = helpersSrc.slice(0, t.open + 1 + at).split('\n').length;
      problems.push(`probe-helpers.mjs 第 ${line} 行：HELPERS 模板体里有反引号 → …${inner.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, '⏎')}…`);
    }
  }
}

// ── ④ 冒烟名单不缩水（2026-10-09 加 · 检查流程优化）────────────────
/**
 * `PROBE_SMOKE`（标准轮跑的那 ~18 步）按**子串**匹配步骤名 —— 步骤改名却忘了同步名单时，
 * 它**静默变薄**（"看起来 18 步全过"其实只剩 12 步在跑）。这正是本项目最怕的形状
 * （"改名/删东西之后负向断言恒真"那一族），所以让它在 0.2 秒自检里红出来。
 * ⚠️ 与 runner 里 `--smoke` 的自证是**两条**（一道 lint、一道运行期）——不是冗余：
 * lint 是改 probe 时的即时反馈，runner 那条是"名单/步骤被人改过但没跑 lint"的兜底。
 */
if (probeMod) {
  const steps = Array.isArray(probeMod.STEPS) ? probeMod.STEPS : [];
  const smoke = Array.isArray(probeMod.PROBE_SMOKE) ? probeMod.PROBE_SMOKE : [];
  if (steps.length === 0 || smoke.length === 0) {
    problems.push('probe.mjs 里找不到 STEPS / PROBE_SMOKE（改名了？这条判据要跟着改）');
  } else {
    for (const n of smoke) {
      if (!steps.some((s) => !s.setup && s.name.includes(n))) {
        problems.push(
          `冒烟名单「${n}」没命中任何步骤 —— 步骤改名要同步改 PROBE_SMOKE（名单静默缩水 = 冒烟档悄悄变薄）`,
        );
      }
    }
  }
}

// ── ⑤ 每条 step 的 `script` 能单独编译（2026-10-10 加 · P7.19 #5）──────
/**
 * 补 P7.11 留下的那条缝：① 只证明**整个模块**能求值，但"模板被截断后剩下的部分恰好也是
 * 合法 JS"时，`new Function(s.script)` **单条**编译仍可能红，而 import 看不出来。
 *
 * 为什么要**逐条**：19000 行的 `STEPS` 里某一条炸了，你面对的是"import 失败了"一句 ——
 * 还得自己二分去找。这里逐条报**下标 + 步骤名**，直接指到那一行附近。
 *
 * 只编译 `script`（字符串）；`before` / `after` 是**函数**不是模板（跳过，它们的语法错在 ① 就炸）。
 */
if (probeMod) {
  const steps = Array.isArray(probeMod.STEPS) ? probeMod.STEPS : [];
  let compiled = 0;
  steps.forEach((s, i) => {
    const label = `STEPS[${i}]「${s && s.name ? String(s.name).slice(0, 32) : '（无名）'}」`;
    const src = s && s.script;
    if (typeof src !== 'string') return;
    try {
      new Function(src);
      compiled += 1;
    } catch (e) {
      problems.push(`${label} 的 script 编译失败：${e.message}`);
    }
  });
  if (steps.length > 0 && compiled === 0) {
    problems.push('STEPS 里一条带 script 的步骤都没编译到（字段改名了？这条判据要跟着改）');
  } else {
    console.log(dim(`  · 已逐条编译 ${compiled} 条 step 的 script`));
  }
}

if (problems.length > 0) {
  console.error(red('\n✗ 探针脚本自检没过：\n'));
  for (const p of problems) console.error(`  · ${p}`);
  console.error(dim('\n（模板里的注释要用「」，别用反引号）\n'));
  process.exit(1);
}
console.log(green('✓ 探针脚本自检通过') + dim('（能求值 · 模板里没有反引号 · 冒烟名单不缩水 · 每条 step 能编译）'));
