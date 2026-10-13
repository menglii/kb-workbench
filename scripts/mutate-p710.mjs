/**
 * P7.10 突变验红（一次性脚本，收尾可删）——「新增判据真能红」的证明。
 *
 * 四处（照开工提示词：prio / scopeDir / 旗标 / 删除会话）：
 *   M1 #10：`mocRuleRaw` 的 prio 改回 tag 档 —— 「同篇 AI 选节胜出」该红
 *   M2 #12：`inScope()` 恒真（工作目录收窄整段失效）—— 「越界调用被拒」该红
 *   M3 #8：notes mount 的旗标判断短路 —— 「首入弹一次」该红
 *   M4 #11：`removeSessionById` 无视确认结果（取消也照删）—— 「删除→轻确认」该红
 *
 * 纪律（照 `坑/判据与验证.md`）：
 *   · 每次突变**先自证锚点命中**（不命中就退出，别让"没应用"冒充"没咬住"）；
 *   · 突变前把整份源码 `cp` 到**仓库外**的备份目录（别放 tests/.tmp —— 会被 next run 清掉）；
 *   · 判红前**先看汇总行在不在**（"没找到汇总行" = 没跑，不是通过）；
 *   · 过滤词**总数 0 也是绿汇总**（P5 的教训）—— 单独拦；
 *   · Windows 下 spawn npm 要 `shell: true`（P7.7c 的教训）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BACKUP = path.join(os.tmpdir(), 'kbw-p710-mut-backup');
fs.mkdirSync(BACKUP, { recursive: true });

const MUTATIONS = [
  {
    id: 'M1-#10prio',
    file: 'src/services/suggest.ts',
    test: '同篇「自动索引」规则行',
    apply(s) {
      const anchor = '    prio: SUGGEST_PRIO.fallback,\n  }));\n}';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    prio: SUGGEST_PRIO.tag, // 突变：改回旧档\n  }));\n}');
    },
  },
  {
    id: 'M2-#12scope',
    file: 'src/ui/ai-tools.ts',
    test: '越界调用被拒',
    apply(s) {
      const anchor = `  const inScope = (abs: string): boolean => {
    const root = scopeAbs();
    return abs === root || abs.startsWith(\`\${root}/\`);
  };`;
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        `  const inScope = (abs: string): boolean => {
    void abs;
    return true; // 突变：收窄失效
  };`,
      );
    },
  },
  {
    id: 'M3-#8旗标',
    file: 'src/modules/notes/index.ts',
    test: '旗标没写过：首次进入弹一次',
    apply(s) {
      const anchor = '    if (this.ctx.settings.get().notesIntroSeen !== true) {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    if (false) { // 突变：旗标判断短路');
    },
  },
  {
    id: 'M4-#11删除确认',
    file: 'src/ui/session-actions.ts',
    test: '删除 → 轻确认小框',
    apply(s) {
      const anchor = '  if (res.action !== \'primary\') return false;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  void res; // 突变：无视确认结果（取消也照删）');
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
