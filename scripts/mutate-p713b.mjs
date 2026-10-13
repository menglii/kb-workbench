/**
 * P7.13b 突变验红（一次性脚本，收尾可删）——「新增判据真能红」的证明。
 *
 * 十二处（域 D 落点 / 菜单形态 · E1 修链链 · ① 搬回声明处 · E2/E3 · ② 串行）：
 *   M1  replaceLinkTarget："整段相等"放宽成 includes —— 「模板集 ≠ 模板」该红
 *   M2  replaceLinkTarget：别名/`#节` 保留拆掉 —— 别名保留该红
 *   M3  link-panel：日志漏传 `ai: true` —— 「这条是 AI 建议的」留痕该红（真实缺陷形态）
 *   M4  proposeLinks：候选不复核值域 —— 清单外目标判丢该红
 *   M5  runDupKeepNewest：keeper 方向反 —— 保最新变保最旧，E2 确认单该红
 *   M6  E2 的撤销条拆掉 —— "搬完给回头路"该红（⚠️ 原先设计的是"摘掉收尾的 index.rebuild"
 *        ——实测不红：mover 写操作日志也会 bump 索引修订号，与 rebuild **互为冗余**；
 *       rebuild 的价值在"日志写失败/要即时重画"那两个角落，不是唯一守卫）
 *   M7  E3 落点算错（丢元数据目录前缀）—— "挪进 99_Meta/05_待清理"该红
 *   M8  planMoveBackToDeclared："已一致"的早退拆掉 —— 纯逻辑"就住这儿不进"该红
 *   M9  runMoveBack："不建目录"也照搬 —— PM-2"不建 → 没动"该红
 *   M10 runFullProcess：取消 = 中断（不是跳过继续）—— 汇总"跳过 2 行"该红
 *   M11 面板型动作不再 await 面板关 —— "面板还开着 Promise 不收尾"该红
 *   M12 #6a：菜单落点回退成"行锚点"（鼠标坐标不再直传）—— D1 该红
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
const BACKUP = path.join(os.tmpdir(), 'kbw-p713b-mut-backup');
fs.mkdirSync(BACKUP, { recursive: true });

const MUTATIONS = [
  {
    id: 'M1-整段相等',
    file: 'src/services/link-fix.ts',
    test: 'replaceLinkTarget',
    apply(s) {
      const anchor = '    if (tgt !== old) return whole;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    if (!tgt.includes(old)) return whole; // 突变：放宽成"包含"');
    },
  },
  {
    id: 'M2-别名保留',
    file: 'src/services/link-fix.ts',
    test: 'replaceLinkTarget',
    apply(s) {
      const anchor = '    return `[[${next}${head}${tail}]]`;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    return `[[${next}]]`; // 突变：别名/节丢了');
    },
  },
  {
    id: 'M3-AI留痕',
    file: 'src/ui/link-panel.ts',
    test: 'E1 修链',
    apply(s) {
      const anchor = '        ai: true,';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '        ai: false, // 突变：日志少一行 AI 标记');
    },
  },
  {
    id: 'M4-候选复核',
    file: 'src/services/ai/index.ts',
    test: 'proposeLinks',
    apply(s) {
      const anchor = '      const options = row.options.filter((o) => allowed.has(o));';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      const options = row.options.slice(); // 突变：不复核值域');
    },
  },
  {
    id: 'M5-keeper方向',
    file: 'src/modules/home/todo-actions.ts',
    test: 'E2：',
    apply(s) {
      const anchor = '      if (it.mtime > keeper.mtime || (it.mtime === keeper.mtime && it.rel < keeper.rel)) keeper = it;';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '      if (it.mtime < keeper.mtime) keeper = it; // 突变：保最旧',
      );
    },
  },
  {
    id: 'M6-E2撤销条',
    file: 'src/modules/home/todo-actions.ts',
    test: 'E2：',
    apply(s) {
      const anchor = '  if (t.trashed.length > 0 && t.snapshotId) {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  if (false) { // 突变：删完不给撤销条');
    },
  },
  {
    id: 'M7-E3落点',
    file: 'src/modules/home/todo-actions.ts',
    test: 'E3：',
    apply(s) {
      const anchor = "  const targetRel = metaDir ? `${metaDir}/05_待清理` : '05_待清理';";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, "  const targetRel = '05_待清理'; // 突变：丢了元数据目录前缀");
    },
  },
  {
    id: 'M8-已一致早退',
    file: 'src/services/reconcile.ts',
    test: 'planMoveBackToDeclared',
    apply(s) {
      const anchor = '    if (declared.includes(e.effectivePosition)) continue; // 声明里有一个就是现在这里 → 不用动';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    // 突变：去掉"就住这儿"的早退');
    },
  },
  {
    id: 'M9-不建也搬',
    file: 'src/modules/home/todo-actions.ts',
    test: '声明目录不存在',
    apply(s) {
      const anchor = '    if (res.action === \'primary\') {';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    if (true) { // 突变：不建也照搬');
    },
  },
  {
    id: 'M10-取消也记完成',
    file: 'src/modules/home/todo-actions.ts',
    test: '逐条串行',
    apply(s) {
      const anchor = '      if (still) skippedLines.push(`· 没弄掉：${still.text}`);\n      else done += 1;';
      if (!s.includes(anchor)) return null;
      // ⚠️ 第一版突变成"取消即断"是**假突变**：清单里就两行、被取消的是最后一行，
      // break 与 continue 等价（跑出来照样绿）。改成"取消也记完成"——真能改变汇总数字。
      return s.replace(
        anchor,
        '      if (still) { skippedLines.push(`· 没弄掉：${still.text}`); done += 1; } // 突变：取消也记完成\n      else done += 1;',
      );
    },
  },
  {
    id: 'M11-面板不await',
    file: 'src/modules/home/todo-actions.ts',
    test: '面板型动作',
    apply(s) {
      const anchor = '      await openTitlePanel(ctx).closed;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      openTitlePanel(ctx); // 突变：不等面板关');
    },
  },
  {
    id: 'M12-落点回行锚',
    file: 'src/modules/home/blocks/todo.ts',
    test: '#6a',
    apply(s) {
      const anchor = `  if (evt.clientX === 0 && evt.clientY === 0) {
    // 键盘呼出（坐标为 0）→ 回退行锚点
    const r = row.getBoundingClientRect();
    showMenu({ x: r.left + 24, y: r.top + 8 }, spec);
  } else {
    showContextMenu(evt, spec);
  }`;
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        `  const r = row.getBoundingClientRect();
  showMenu({ x: r.left + 24, y: r.top + 8 }, spec); // 突变：永远行锚点（鼠标坐标没用上）`,
      );
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
