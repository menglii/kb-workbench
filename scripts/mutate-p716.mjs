/**
 * P7.16 突变验红（一次性脚本，收尾可删）——「新增判据真能红」的证明。
 *
 * 九处（#1 属性块刷新 / #2 选择器两修 / #3 坏前言一族）：
 *   M1  vault-index：`computeFlags` 不推 fragile-fm —— 「坏前言」旗标一族该红
 *   M2  fm-repair：确定性修"算了但不换行"（to = 原行）—— 加引号判据该红
 *   M3  board/editor：选择器当前项退回 `select.value = cur`（未声明又冒充库根）—— Q1 该红
 *   M4  board/editor：`moveByPosition` 的「就住这儿」分支拆掉（一律早退）—— 选择器面该红
 *   M5  notes/menus：positionItems 的「就住这儿」退回置灰 —— 菜单面该红
 *   M6  board/editor：面板不订阅 vault create/delete（目录增删不重画）—— #1 建目录该红
 *   M7  board/editor：焦点保护拆掉（聚焦时也重画）—— 焦点判据该红
 *   M8  services/ai：fixFrontmatter 不跑 validateFmRepair —— 拒稿判据该红
 *   M9  fm-repair：validateFmRepair 的围栏检查拆掉（裸 ``` / ~~~ 放行）—— 独立审 🟡补的判据该红
 *
 * 纪律（照 `坑/判据与验证.md`，与 `mutate-p715.mjs` 同款）：
 *   · 每次突变**先自证锚点命中**（不命中就退出，别让"没应用"冒充"没咬住"）；
 *   · 突变前把整份源码 `cp` 到**仓库外**的备份目录（别放 tests/.tmp —— 会被 next run 清掉）；
 *   · 判红前**先看汇总行在不在**（"没找到汇总行" = 没跑，不是通过）；
 *   · 过滤词**总数 0 也是绿汇总** —— 单独拦；
 *   · Windows 下 spawn npm 要 `shell: true`（P7.7c 的教训）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BACKUP = path.join(os.tmpdir(), 'kbw-p716-mut-backup');
fs.mkdirSync(BACKUP, { recursive: true });

const MUTATIONS = [
  {
    id: 'M1-不推坏前言旗标',
    file: 'src/core/vault-index.ts',
    test: '两种坏形状',
    apply(s) {
      const anchor = '      if (fragileKeys(entry.props).length > 0 && !this.inProtectedDir(entry.path)) {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      if (false) { // 突变：不亮坏前言旗标');
    },
  },
  {
    id: 'M2-确定性修不换行',
    file: 'src/services/fm-repair.ts',
    test: '整行裸占位符',
    apply(s) {
      const anchor = '    const to = `${m[1]}${quotePlaceholder(m[2])}${m[3]}`;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    const to = lines[i]; // 突变：算了但不换行（fixes 照记）');
    },
  },
  {
    id: 'M3-未声明又冒充库根',
    file: 'src/modules/board/editor.ts',
    test: '未声明显示',
    apply(s) {
      const anchor = '    select.value = undeclared ? SENTINEL_UNSET : cur;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    select.value = cur; // 突变：空列表又落回「库根」');
    },
  },
  {
    id: 'M4-就住这儿（选择器面）早退',
    file: 'src/modules/board/editor.ts',
    test: '就住这儿（选择器面）',
    apply(s) {
      const anchor = '    if (declaredPositions(entry.props).length === 0) {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    if (false) { // 突变：未声明也一律早退（没法只声明不搬）');
    },
  },
  {
    id: 'M5-就住这儿（菜单面）退回置灰',
    file: 'src/modules/notes/menus.ts',
    test: '就住这儿（菜单面）',
    apply(s) {
      const anchor = '      if (undeclared && onDeclare) {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      if (false) { // 突变：退回置灰');
    },
  },
  {
    id: 'M6-面板不订阅目录增删',
    file: 'src/modules/board/editor.ts',
    test: '建新目录',
    apply(s) {
      const anchor = "    const ref3 = vault.on('create', onVaultTree as never);";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    const ref3 = null; // 突变：不订阅 create（目录增删不重画）');
    },
  },
  {
    id: 'M7-焦点保护拆掉',
    file: 'src/modules/board/editor.ts',
    test: '焦点保护',
    apply(s) {
      const anchor = '      if (tab.propsBlock.contains(document.activeElement)) {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      if (false) { // 突变：聚焦时也重画（抢焦点）');
    },
  },
  {
    id: 'M8-不校验AI修复稿',
    file: 'src/services/ai/index.ts',
    test: '服务层校验',
    apply(s) {
      const anchor = '    const check = validateFmRepair(inner, parsed.inner);';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, "    const check = { ok: true, why: '' }; // 突变：不校验（丢键也放行）");
    },
  },
  {
    id: 'M9-围栏与散文检查拆掉',
    file: 'src/services/fm-repair.ts',
    test: 'AI 稿校验',
    apply(s) {
      /**
       * ⚠️ 两道要**一起**关（首跑只关围栏那条 = 没咬住）：裸 ``` 同时是被"顶格行必须是
       * 键/列表/注释"那条拦下的 —— 两道都是真守卫（冗余但各自成立）；只关一道的红是
       * 被另一道兜住，不是判据假绿（P6 期"两处守卫"那条实测口径）。
       */
      const a1 =
        '    if (FENCE_LINE.test(line)) return { ok: false, why: `混进了围栏行（${line.trim()}）` };';
      const a2 =
        '    return { ok: false, why: `前言里冒出了不是键/列表/注释的行：「${line.trim().slice(0, 24)}」` };';
      if (!s.includes(a1) || !s.includes(a2)) return null;
      return s
        .replace(a1, "    if (false) return { ok: false, why: '' }; // 突变：围栏检查拆掉")
        .replace(a2, '    continue; // 突变：散文/坏行放行');
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
    console.log(`✗ ${m.id}：过滤词一条都没选中（测试没跑，不算咬住）`);
    bad += 1;
  } else if (Number(summaryMatch[3]) > 0 && reds > 0) {
    console.log(`✓ ${m.id}：咬住了（失败 ${summaryMatch[3]} 条）`);
  } else {
    console.log(`✗ ${m.id}：**没咬住** —— 突变后仍全绿（${summaryMatch[0]}）`);
    bad += 1;
  }
}
console.log(bad === 0 ? '\n✓ 全部突变都被咬住' : `\n✗ ${bad} 处有问题`);
process.exit(bad === 0 ? 0 : 1);
