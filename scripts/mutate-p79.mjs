/**
 * P7.9 突变验红（一次性脚本，收尾可删）——「新增判据真能红」的证明。
 *
 * 四处（照开工提示词：⑦a 次序 / ③ 悬停 / ④ 还原 / ⑤ 结构页排除）：
 *   M1 ⑦a：把「改属性」段挪回 move 之后 —— 「⑦a 回归」该红
 *   M2 ③：pointerdown 取消 dwell 失效 —— 「点击即取消」该红
 *   M3 ④：applyIntent 不再记 jumpDir —— 「带目录的跳转也有还原」该红
 *   M4 ⑤：tidy 层不过滤结构性笔记 —— 「结构性笔记不参与」该红
 *
 * 纪律（照 `坑/判据与验证.md`）：
 *   · 每次突变**先自证锚点命中**（不命中就退出，别让"没应用"冒充"没咬住"）；
 *   · 突变前把整份源码 `cp` 到**仓库外**的备份目录（别放 tests/.tmp —— 会被 next run 清掉）；
 *   · 判红前**先看汇总行在不在**（"没找到汇总行" = 没跑，不是通过）；
 *   · Windows 下 spawn npm 要 `shell: true`（P7.7c 的教训）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BACKUP = path.join(os.tmpdir(), 'kbw-p79-mut-backup');
fs.mkdirSync(BACKUP, { recursive: true });

const MUTATIONS = [
  {
    id: 'M1-⑦a次序',
    file: 'src/ui/ai-tools.ts',
    test: '⑦a 回归',
    apply(s) {
      // 把「改属性先跑」段挪回 move 段之后（旧次序）—— 用三段锚点做块交换
      const a = s.indexOf('    /**\n     * **改属性 / 标签先跑**');
      const b = s.indexOf('    /** 搬：一次 mover 调用 = 一个快照 = 一个撤销句柄（与手工同口径） */');
      const c = s.indexOf('    /** 新建：走「新建笔记」既有出口');
      if (a < 0 || b < 0 || c < 0 || !(a < b && b < c)) return null;
      return s.slice(0, a) + s.slice(b, c) + s.slice(a, b) + s.slice(c);
    },
  },
  {
    id: 'M2-③悬停',
    file: 'src/modules/home/blocks/quick.ts',
    test: '点击即取消',
    apply(s) {
      const anchor = `  b.addEventListener('pointerdown', (evt) => {\n    if (!isMouse(evt)) return;\n    if (dwell != null) window.clearTimeout(dwell);\n    dwell = null;\n  });`;
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, `  b.addEventListener('pointerdown', () => {\n    /* 突变：取消逻辑失效 */\n  });`);
    },
  },
  {
    id: 'M3-④还原',
    file: 'src/modules/notes/index.ts',
    test: 'goNotes({dir, selectAll})',
    apply(s) {
      const anchor = '    patch.jumpDir = intent.dir != null ? intent.dir : null;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    patch.jumpDir = null; // 突变：不记目录');
    },
  },
  {
    id: 'M4-⑤结构页',
    file: 'src/modules/home/tidy.ts',
    test: '结构性笔记不参与',
    apply(s) {
      const anchor = '    notes: allNotes.filter((n) => !STRUCTURAL_TYPES.has(n.type)),';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    notes: allNotes, // 突变：不过滤结构性笔记');
    },
  },
];

let bad = 0;
for (const m of MUTATIONS) {
  const abs = path.join(ROOT, m.file);
  const bak = path.join(BACKUP, `${m.id}-${path.basename(m.file)}.bak`);
  const src = fs.readFileSync(abs, 'utf8');
  fs.writeFileSync(bak, src, 'utf8'); // 先备份到仓库外（别用 git checkout —— 会吃掉未提交改动）
  const mutated = m.apply(src);
  if (mutated == null || mutated === src) {
    console.log(`✗ ${m.id}：**锚点没命中**（别把"没应用"当成"没咬住"）`);
    bad += 1;
    continue;
  }
  fs.writeFileSync(abs, mutated, 'utf8');
  let out = '';
  try {
    out = execFileSync('npm', ['test'], {
      cwd: ROOT,
      shell: true, // Windows：npm 是 .cmd（P7.7c 教训）
      env: { ...process.env, KBW_TEST_ONLY: m.test },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  } finally {
    fs.writeFileSync(abs, src, 'utf8'); // 还原
  }
  const summaryMatch = out.match(/通过 (\d+) \/ (\d+)　失败 (\d+)/);
  const reds = (out.match(/✗/g) ?? []).length;
  if (!summaryMatch) {
    console.log(`✗ ${m.id}：**没找到汇总行** —— 测试没跑起来（不是"没咬住"）`);
    bad += 1;
  } else if (Number(summaryMatch[2]) === 0) {
    // 🔴 P5 的"拼错过滤词 = 绿"：**总数 0 也是绿汇总**，单看"有没有汇总行"会放它过去
    console.log(`✗ ${m.id}：过滤词一条都没匹配上（KBW_TEST_ONLY="${m.test}"）—— 改词，别当成"没咬住"`);
    bad += 1;
  } else if (reds === 0) {
    console.log(`✗ ${m.id}：突变之后**没红** —— 判据没咬住（测试="${m.test}"）`);
    bad += 1;
  } else {
    console.log(`✓ ${m.id}：突变后红 ${reds} 条（${summaryMatch[0]}）`);
  }
}
console.log(bad === 0 ? '全部突变验红 ✓' : `有 ${bad} 处没咬住/没应用 —— 要查`);
process.exit(bad === 0 ? 0 : 1);
