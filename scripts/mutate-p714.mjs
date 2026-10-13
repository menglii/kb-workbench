/**
 * P7.14 突变验红（一次性脚本，收尾可删）——「新增判据真能红」的证明。
 *
 * 十二处（空串根一族 + 向导新建 + 反馈四件）：
 *   M1  normalizeSettings：把假值兜底加回去 —— 空串存不进/读不回该红
 *   M2  metaRoot：退回字符串手拼（`${kbRoot}/metaDir`）—— 前导斜杠族该红
 *   M3  walkPool：metaPrefix 退回带前导斜杠的形状 —— 随机漫步排除元数据目录该红
 *   M4  underKbRoot：退回 `if (!root) return false` —— 整个库下右键菜单该红
 *   M5  向导「新建」默认名：改回旧值 —— 默认名「经纬知识库」该红
 *   M6  向导「新建」：只落盘不真建（把 createEmptyFolder 调用短路）—— "真建出目录"该红
 *   M7  foldersFor：退回 `f.parent?.path` 比较 —— 根层文件夹格/行该红
 *   M8  rebuildNotesOf：`!kbRoot` 硬拦加回去 —— 重排输入集=全量该红
 *   M9  maintenance：空壳照旧进重复候选 —— "空壳不算重复"该红（P7.14b）
 *   M10 vault-index：编辑器记账不消费 —— "打字不算外改"该红（P7.14b）
 *   M11 menus：拆掉「（清空）」项 —— 枚举删得掉该红（P7.14b）
 *   M12 schema：拆掉库根顶层默认 —— "根层新建带类型"该红（P7.14b）
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
const BACKUP = path.join(os.tmpdir(), 'kbw-p714-mut-backup');
fs.mkdirSync(BACKUP, { recursive: true });

const MUTATIONS = [
  {
    id: 'M1-normalize假值兜底',
    file: 'src/core/settings.ts',
    test: 'normalizeSettings 显式收空串',
    apply(s) {
      const anchor = '  if (!out.metaDir) out.metaDir = DEFAULT_SETTINGS.metaDir;';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '  if (!out.kbRoot) out.kbRoot = DEFAULT_SETTINGS.kbRoot; // 突变：假值兜底回来了（空串被顶回默认）\n' +
          anchor,
      );
    },
  },
  {
    id: 'M2-metaRoot手拼',
    file: 'src/core/settings.ts',
    test: 'metaRoot 族无前导斜杠',
    apply(s) {
      const anchor = "    return joinPath(this.kbRoot(), this.current.metaDir.replace(/^\\/+|\\/+$/g, ''));";
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        "    return `${this.kbRoot()}/${this.current.metaDir.replace(/^\\/+|\\/+$/g, '')}`; // 突变：退回手拼",
      );
    },
  },
  {
    id: 'M3-walk前导斜杠',
    file: 'src/modules/home/blocks/walk.ts',
    test: 'walkPool 排除元数据目录',
    apply(s) {
      const anchor = '  const metaPrefix = `${ctx.settings.metaRoot()}/`;';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  const metaPrefix = `/${ctx.settings.metaRoot()}/`; // 突变：P7.14 前的形状');
    },
  },
  {
    id: 'M4-右键菜单空串拒',
    file: 'src/ui/editor-menu.ts',
    test: '落点候选',
    apply(s) {
      const anchor = '  return inKbScope(path, kbRoot);';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '  const root = String(kbRoot ?? "").replace(/\\/+$/, "");\n' +
          '  if (!root) return false; // 突变：P7.14 前的形状（整个库下菜单整族消失）\n' +
          '  return path === root || path.startsWith(`${root}/`);',
      );
    },
  },
  {
    id: 'M5-向导默认名回退',
    file: 'src/ui/wizard.ts',
    test: '真建目录',
    apply(s) {
      const anchor = "const NEW_FOLDER_DEFAULT = '经纬知识库';";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, "const NEW_FOLDER_DEFAULT = '01_新知识库'; // 突变：默认名回退");
    },
  },
  {
    id: 'M6-只落盘不真建',
    file: 'src/ui/wizard.ts',
    test: '真建目录',
    apply(s) {
      const anchor = '            const r = await createEmptyFolder(ctx, rel);';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        "            const r = 'created' as const; // 突变：只落盘不真建\n" +
          '            void createEmptyFolder;',
      );
    },
  },
  {
    id: 'M7-foldersFor旧口径',
    file: 'src/modules/notes/index.ts',
    test: '网格/详细档根层画得出',
    apply(s) {
      const anchor = '      if (f instanceof TFolder && parentDir(f.path) === base) names.add(f.name);';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '      if (f instanceof TFolder && f.parent?.path === base) names.add(f.name); // 突变：旧口径（顶层恒假）',
      );
    },
  },
  {
    id: 'M8-重排空串硬拦',
    file: 'src/services/rebuild.ts',
    test: '重排输入集',
    apply(s) {
      const anchor = '    if (!isInside(e.path, kbRoot) || e.path === kbRoot) continue;';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '    if (!kbRoot || !isInside(e.path, kbRoot) || e.path === kbRoot) continue; // 突变：空串当缺省',
      );
    },
  },
  {
    id: 'M9-空壳照算重复',
    file: 'src/services/maintenance.ts',
    test: '空壳笔记',
    apply(s) {
      const anchor = '        if (stripTailSection(stripFrontmatter(text)).trim() === \'\') {';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '        if (false) { // 突变：空壳照旧进重复候选',
      );
    },
  },
  {
    id: 'M10-编辑器不记账',
    file: 'src/core/vault-index.ts',
    test: 'editor-change 先记账',
    apply(s) {
      const anchor = '    if (consumeSelfWrite(path) || consumeUserEdit(path)) {';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '    if (consumeSelfWrite(path)) { // 突变：编辑器记账不消费',
      );
    },
  },
  {
    id: 'M11-清空项拆掉',
    file: 'src/modules/notes/menus.ts',
    test: '属性菜单「（清空）」',
    apply(s) {
      const anchor = "      items.push({ kind: 'item', label: '（清空）', icon: 'eraser', run: () => apply(null) });";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '      // 突变：「（清空）」项拆掉');
    },
  },
  {
    id: 'M12-根层默认拆掉',
    file: 'src/services/schema.ts',
    test: '库根顶层新建',
    apply(s) {
      const anchor = "  if (d === '') return { 类型: '笔记' };";
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '  // 突变：顶层默认拆掉');
    },
  },
  {
    id: 'M13-裸mkdir退回',
    file: 'src/ui/new-folder.ts',
    test: '真建目录',
    apply(s) {
      const anchor = '    await ctx.app.vault.createFolder(p);';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, '    await ctx.app.vault.adapter.mkdir(p); // 突变：退回裸 mkdir（不进平台缓存）');
    },
  },
  {
    id: 'M14-删除不过trash',
    file: 'src/modules/notes/menus.ts',
    test: '文件夹重命名/删除',
    apply(s) {
      const anchor = '  const t = await ctx.mover.trash({ files: tfs, source: \'menu\', reason: `删除目录 ${rel}` });';
      if (!s.includes(anchor)) return null;
      return s.replace(
        anchor,
        '  const t = await ctx.mover.trash({ files: [], source: \'menu\', reason: `删除目录 ${rel}` }); // 突变：不过删除',
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
