/**
 * P7.15 突变验红（一次性脚本，收尾可删）——「新增判据真能红」的证明。
 *
 * 八处（#1 根标记 / #2 空目录进树 / #3 目录选择器 / #4 模板路）：
 *   M1  schema：`normalizeDeclaredPos` 不做 `.` → 空串 归一 —— 顶层体检该红
 *   M2  templates.buildYaml：顶层不写 `文件位置`（退回 P7.14 口径）—— 顶层写 `.` 该红
 *   M3  templates.mergeTemplateYaml：新建路也删键（不写 `.`）—— 模板路顶层该红
 *   M4  notes/tree：`realDirs` 那一圈不建节点（退回"只画有笔记的目录"）—— 空目录进树该红
 *   M5  notes/index：树区域 key 去掉真实目录数 —— 删空目录之后树不重画该红
 *   M6  notes/menus.positionItems：把"它就在这儿"的置灰拆掉 —— 当前所在地置灰该红
 *   M7  notes/menus：`文件位置` 那格退回旧实现（当前值本身）—— 目录选择器该红
 *   M8  completion（Templater 托管路）：顶层退回写空数组 —— 与 #1 同口径那半该红
 *
 * 纪律（照 `坑/判据与验证.md`，与 `mutate-p714.mjs` 同款）：
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
const BACKUP = path.join(os.tmpdir(), 'kbw-p715-mut-backup');
fs.mkdirSync(BACKUP, { recursive: true });

const MUTATIONS = [
  {
    id: 'M1-根标记不归一',
    file: 'src/services/schema.ts',
    test: 'normalizeDeclaredPos',
    apply(s) {
      const anchor = "  return s === ROOT_POS ? '' : s;";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  return s; // 突变：`.` 不归一（顶层声明变成错位）');
    },
  },
  {
    id: 'M2-顶层不写文件位置',
    file: 'src/services/templates.ts',
    test: '库根顶层新建',
    apply(s) {
      const anchor = "      if (opts.withPosition) lines.push('文件位置:', `  - ${ctx.folderRel || ROOT_POS}`);";
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        "      if (opts.withPosition && ctx.folderRel) lines.push('文件位置:', `  - ${ctx.folderRel}`); // 突变：退回 P7.14「顶层不写」",
      );
    },
  },
  {
    id: 'M3-模板路顶层不写',
    file: 'src/services/templates.ts',
    test: '依模板新建（套用补齐路）',
    apply(s) {
      const anchor = "    setBlockList('文件位置', [opts.ctx.folderRel || ROOT_POS]);";
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        "    if (opts.ctx.folderRel) setBlockList('文件位置', [opts.ctx.folderRel]); else deleteKey('文件位置'); // 突变：顶层不写",
      );
    },
  },
  {
    id: 'M4-树只画有笔记的',
    file: 'src/modules/notes/tree.ts',
    test: '空目录照画',
    apply(s) {
      const anchor = '  for (const dir of realDirs) if (dir) ensure(dir);';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  // 突变：真实目录那一圈不建节点（退回"只画有笔记的目录"）');
    },
  },
  {
    /**
     * ⚠️ **上一版想钉"树区域 key 里的真实目录数"，实测咬不住** —— 如实换成两条**能被咬住**的：
     * M5a = `buildTreeFromVault` 不喂 realDirs（树退回"只画有笔记的目录"）。
     * ⚠️ 试过两条**钉不住**的，如实记在这里（别再重写第三遍）：
     *  ① "key 里的真实目录数" —— 判据里 rev 每轮都在变，恒绿；
     *  ② "key 里的库指纹" —— 模块**按设计不在 vault 事件上重画**（本轮试了"外部建目录"的
     *     判据，实测红）；那条指纹只在"store 有动静且库也变了"时兜底，离线没有对应用例。
     */
    id: 'M5a-树源不喂真实目录',
    file: 'src/modules/notes/tree.ts',
    test: '真实目录来自 kbDirsOf',
    apply(s) {
      const anchor = '  return buildTree(entries, Array.from(kbDirsOf(app, kbRoot)));';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  return buildTree(entries); // 突变：不喂真实目录（退回旧口径）');
    },
  },
  {
    id: 'M6-置灰拆掉',
    file: 'src/modules/notes/menus.ts',
    test: '目录选择器：候选是真目录',
    apply(s) {
      const anchor = "      return { kind: 'item', label, disabled: '它就在这儿' };";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, "      return { kind: 'item', label }; // 突变：不置灰（能点、点了等于没点）");
    },
  },
  {
    id: 'M7-文件位置退回当前值',
    file: 'src/modules/notes/menus.ts',
    test: '文件位置」= 目录选择器',
    apply(s) {
      const anchor = '            submenu: positionItems(m.ctx, entry, (dir) =>';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        "            submenu: valueItems('文件位置', current, (v) => void m.ops.setProp([entry], '文件位置', v)),\n            /** 突变：退回旧实现 */\n            _unused: ((dir) =>",
      );
    },
  },
  {
    id: 'M8-顶层也删模板的位置',
    file: 'src/services/templates.ts',
    test: '依模板新建（套用补齐路）',
    apply(s) {
      /** 突变：新建路也不写（`withPosition` 判据拆掉）—— 模板自带的位置会漏进产物 */
      const anchor = [
        '  if (opts.withPosition) {',
        "    setBlockList('文件位置', [opts.ctx.folderRel || ROOT_POS]);",
        '  } else {',
      ].join('\n');
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        [
          '  if (false) { // 突变：新建路也不写',
          "    setBlockList('文件位置', [opts.ctx.folderRel || ROOT_POS]);",
          '  } else {',
        ].join('\n'),
      );
    },
  },
  {
    id: 'M9-mover落库根写空数组',
    file: 'src/services/mover.ts',
    test: '声明写 `.`（不是空数组',
    apply(s) {
      const anchor = "        const r = await this.fm.setMany(file, { 文件位置: rel ? [rel] : [ROOT_POS] });";
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        "        const r = await this.fm.setMany(file, { 文件位置: rel ? [rel] : [] }); // 突变：退回空数组",
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
