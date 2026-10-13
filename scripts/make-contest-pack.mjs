// 生成**参赛提交包**：根级「说明.md + 讲解页.html」＋「方式一-一键安装」＋「方式二-纯插件」。
//
// 与另外三条打包链的分工（都别混）：
//   · `make-share-pack.mjs`   → 给**使用者**的一键安装包（空骨架库；Obsidian 要自己去官网装）
//   · `make-public-pack.mjs`  → 给**外部开发者**的源码包（脱敏）
//   · `make-dev-pack.mjs`     → 给**内部外派执行者**的副本（含任务/协作文件）
//   · **本脚本**              → 给**评委/收件方**的参赛提交包（结构由用户 2026-10-13 拍板）
//
// 产出（默认落桌面；`--out` 可换）：
//   经纬-知识工作台-参赛包/
//   ├── 说明.md                        ← 根级简要说明（本脚本生成）
//   ├── 设计文档.md                     ← 从仓库 `参赛-设计文档.md` 拷入（给评委）
//   ├── 效果佐证.md                     ← 从仓库 `参赛-效果佐证.md` 拷入（测试与验证记录）
//   ├── 经纬-知识工作台-讲解页.html      ← 从 F: 现拷（自包含单文件；拷前验"没有外链"）
//   ├── 方式一-一键安装/
//   │   ├── 一键安装.bat / install.ps1   ← 找/装 Obsidian → 放库 → 登记 → 启动
//   │   ├── Obsidian-1.14.4.exe          ← 官方原版安装器（拍板：随包附带，离线也能装）
//   │   ├── 安装说明.md / 更新日志.md
//   │   └── vault/                       ← 示例库（21 目录骨架 + 14 篇虚构笔记 + 候选文件夹）
//   └── 方式二-纯插件/
//       ├── kb-workbench/                ← main.js / manifest.json / styles.css / assets/
//       └── 安装说明.md
//
// 🔴 三条口径（别在这里另起炉灶）：
//   ① **库内容不自己造**：委托 `make-demo-vault.mjs` 生成（与讲解页截图同一套内容——它自己
//      从 `config-files.ts` 正则读骨架目录）。本脚本只做两件收尾：**删掉 data.json**（让首次
//      向导照常弹——那是新用户的第一体验，不该被"配过的稳态"跳过去）、整个包进包结构。
//      要改演示内容 → 改 make-demo-vault，两包一起变。
//   ② **安装器缓存**在仓库 `.pack-cache/`（已 gitignore）：一次下载、反复复用；下载失败就
//      当场失败 —— 不许静默出一个"说好附带安装器、其实没有"的假包。
//   ③ 自检先行：无真笔记 / 无 data.json / 安装器完整 / 讲解页自包含 / zip 里有 `.obsidian`
//      —— 一条不过就 exit 1。
//
// 用法：
//   node scripts/make-contest-pack.mjs                     → 产出到桌面（系统认定的桌面）
//   node scripts/make-contest-pack.mjs --out "D:/x"        → 换落点
//   node scripts/make-contest-pack.mjs --html "F:/x.html"  → 换讲解页源文件
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const htmlIdx = args.indexOf('--html');

/** 讲解页默认取 F: 的定稿（679 KB、自包含单文件）；桌面那份 280 KB 是 8.24 前的旧版，别拿错 */
const HTML_SRC = path.resolve(
  htmlIdx >= 0 ? args[htmlIdx + 1] : 'F:/04_Projects/01_Web/经纬-知识工作台-讲解页.html',
);

/**
 * 随包附带的 Obsidian 安装器。版本与直链**写死**：参赛包要可复现，不追 latest
 *（链接模式 = GitHub release 资产，2026-10-13 实测 HEAD 200 / 341,331,008 B）。
 * 要换新版：改这三行 + 删掉 `.pack-cache/` 里的旧文件。
 */
const OBSIDIAN_VER = '1.14.4';
const OBSIDIAN_EXE = `Obsidian-${OBSIDIAN_VER}.exe`;
const OBSIDIAN_URL = `https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VER}/${OBSIDIAN_EXE}`;
const CACHE_DIR = path.join(ROOT, '.pack-cache');
/** 实测 341,331,008 B（325 MiB）——低于 300 MB 一律当"下载坏了"，别把半截文件发出去 */
const MIN_INSTALLER = 300 * 1024 * 1024;

/** 落点默认 = 系统认定的"桌面"（OneDrive 重定向时 ≠ %USERPROFILE%\Desktop，见 make-share-pack 的教训） */
function defaultOutBase() {
  try {
    const p = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { encoding: 'utf8' },
    ).trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* 走下面的兜底 */
  }
  return path.join(process.env.USERPROFILE || ROOT, 'Desktop');
}
const OUT_BASE = outIdx >= 0 ? args[outIdx + 1] : defaultOutBase();
const PACK = path.join(OUT_BASE, '经纬-知识工作台-参赛包');
const M1 = path.join(PACK, '方式一-一键安装');
const M2 = path.join(PACK, '方式二-纯插件');
const VAULT = path.join(M1, 'vault');

const fail = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

/** 递归收文件（相对基目录，正斜杠） */
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
const fsize = (p) => fs.statSync(p).size;
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/** PowerShell 单引号字符串字面量（路径里若带单引号就翻倍——理论不会有，防御性写） */
const psLit = (s) => `'${s.replace(/'/g, "''")}'`;

// ────────────────────────────────────────────────────────────────
function main() {
  // ── 0. 前置：构建产物 + 讲解页 ────────────────────────────────
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    if (!fs.existsSync(path.join(ROOT, f))) fail(`缺构建产物 ${f} —— 先跑 npm run build`);
  }
  if (!fs.existsSync(HTML_SRC)) {
    fail(`讲解页文件不在：${HTML_SRC}\n  用 --html 指到正确位置（默认取 F: 的定稿）`);
  }
  assertSelfContainedHtml(HTML_SRC);
  // 评审文档两件是参赛包必需件（源在仓库根）：缺了当场说清，别等拷到一半才炸
  for (const f of ['参赛-设计文档.md', '参赛-效果佐证.md']) {
    if (!fs.existsSync(path.join(ROOT, f))) fail(`缺评审文档源 ${f} —— 参赛包必需（仓库根应有这两份）`);
  }

  // ── 1. 重建包目录 ─────────────────────────────────────────────
  fs.rmSync(PACK, { recursive: true, force: true });
  fs.mkdirSync(M1, { recursive: true });
  fs.mkdirSync(M2, { recursive: true });

  // ── 2. 方式一：vault（委托演示库生成器）+ 安装器 + 脚本 ────────
  console.log('· 生成示例库（make-demo-vault --force）…');
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/make-demo-vault.mjs'), '--out', VAULT, '--force'],
    { stdio: 'inherit' },
  );
  /**
   * 🔴 删掉 data.json —— 演示库生成器写它（wizardDone/notesView/notesIntroSeen）是为了"截图稳态"；
   * 参赛包要的是**第一次打开照常弹首次向导**（拍板 2026-10-13：「带演示笔记」+ 向导不跳过）。
   * 它也是自检项之一（见 selfCheck ②：vault 里任何位置都不许有 data.json）。
   */
  fs.rmSync(path.join(VAULT, '.obsidian', 'plugins', manifest.id, 'data.json'), { force: true });

  const installer = ensureInstaller();
  fs.copyFileSync(installer, path.join(M1, OBSIDIAN_EXE));

  fs.writeFileSync(path.join(M1, '一键安装.bat'), BAT, 'utf8'); // ⚠️ 无 BOM！
  fs.writeFileSync(path.join(M1, 'install.ps1'), `\uFEFF${PS1}`, 'utf8'); // ⚠️ 要 BOM！
  fs.writeFileSync(path.join(M1, '安装说明.md'), M1_README(manifest.version), 'utf8');
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(M1, '更新日志.md'));

  // ── 3. 方式二：纯插件（文件夹名必须 == manifest.id，否则 Obsidian 认不出）──
  const p2 = path.join(M2, manifest.id);
  fs.mkdirSync(p2, { recursive: true });
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(p2, f));
  }
  const assetsSrc = path.join(ROOT, 'assets');
  if (fs.existsSync(assetsSrc)) {
    fs.cpSync(assetsSrc, path.join(p2, 'assets'), { recursive: true });
  } else {
    console.warn('⚠ 缺少 assets/ 目录 —— 向导配图会走"加载失败就隐藏"那条路');
  }
  fs.writeFileSync(path.join(M2, '安装说明.md'), M2_README(manifest.version), 'utf8');

  // ── 4. 根：说明.md + 讲解页 + 两份评委文档 ─────────────────────
  fs.writeFileSync(path.join(PACK, '说明.md'), ROOT_README(manifest.version), 'utf8');
  fs.copyFileSync(HTML_SRC, path.join(PACK, '经纬-知识工作台-讲解页.html'));
  /**
   * **评审文档两件**（2026-10-13 加）：源在仓库根、带 `参赛-` 前缀（避免与仓库自己的
   * `方案设计.md` 撞名）；进包时去掉前缀——评委看到的就是「设计文档.md / 效果佐证.md」。
   * 缺一个 → 自检 ⑥ 直接红（这两份是提交物必需件，不许静默少件）。
   */
  fs.copyFileSync(path.join(ROOT, '参赛-设计文档.md'), path.join(PACK, '设计文档.md'));
  fs.copyFileSync(path.join(ROOT, '参赛-效果佐证.md'), path.join(PACK, '效果佐证.md'));

  // ── 5. zip（含 341MB 安装器；用系统自带的 bsdtar）──────────────
  /**
   * 🔴 **别用 PS 5.1 的 `Compress-Archive`**（第一版就栽在这）：它的 zip 条目用**反斜杠**
   * 分隔（非规范 zip —— Mac/Linux 解压会得到一串"名字里带反斜杠"的平铺文件）。改用 Windows
   * 自带的 bsdtar（`%SystemRoot%\System32\tar.exe`，Win10 1803+）：条目是规范的 `/` + UTF-8 中文名。
   * ⚠️ 必须写**绝对路径**——在 git-bash 的 PATH 里 `tar.exe` 会解析到 msys 的 GNU tar，
   * 它不认识 zip，`-a -f x.zip` 产出的是披着 zip 后缀的 tar 包（"找不到中央目录结尾记录"）。
   * zip 里连**顶层文件夹名**一起打进去：解压出来是一个完整文件夹，不是一地文件。
   */
  const zip = path.join(OUT_BASE, '经纬-知识工作台-参赛包.zip');
  fs.rmSync(zip, { force: true });
  console.log('· 打 zip（把 341MB 安装器拷进去，稍等）…');
  const SYS_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  let zipOk = false;
  try {
    if (process.platform === 'win32' && fs.existsSync(SYS_TAR)) {
      execFileSync(SYS_TAR, ['-a', '-c', '-f', zip, '-C', OUT_BASE, path.basename(PACK)], {
        stdio: 'pipe',
      });
    } else {
      // 兜底（老 Windows 没有 bsdtar）：Compress-Archive —— 条目分隔符是 `\`，核验逻辑两种都认
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path ${psLit(path.join(PACK, '*'))} -DestinationPath ${psLit(zip)} -Force`,
        ],
        { stdio: 'pipe' },
      );
    }
    zipOk = true;
  } catch (e) {
    console.warn(`⚠ zip 没打成（${e.message}）—— 目录本身是可用的，手动右键压缩也一样`);
  }
  const zipInfo = zipOk ? verifyZip(zip) : null;

  // ── 6. 自检 + 报告 ────────────────────────────────────────────
  const s = selfCheck(manifest.id);
  console.log('');
  console.log('✓ 参赛提交包已生成');
  console.log(`  目录：${PACK}`);
  console.log(`  zip ：${zipOk ? `${zip}（${mb(fsize(zip))}）` : '（没打成 —— 用目录）'}`);
  console.log(`  · 方式一：安装器 ${mb(fsize(path.join(M1, OBSIDIAN_EXE)))}（${OBSIDIAN_EXE}）`);
  console.log(`           示例库：骨架目录已建 · 虚构笔记 ${s.notes} 篇（含 02_旧知识库/README.md）`);
  console.log(`  · 方式二：${manifest.id}/（main.js ${kb(fsize(path.join(p2, 'main.js')))}` +
    ` · styles.css ${kb(fsize(path.join(p2, 'styles.css')))} · assets ${s.assetsN} 个）`);
  console.log(`  · 根：说明.md · 设计文档 · 效果佐证 · 讲解页 ${kb(fsize(path.join(PACK, '经纬-知识工作台-讲解页.html')))}（自包含 ✓）`);
  if (zipInfo) {
    console.log(`  · zip 内容核验：条目 ${zipInfo.total} 个 · .obsidian 相关 ${zipInfo.obsidian} 条 · 安装器在包内 ${zipInfo.exe > 0 ? '✓' : '✗'}`);
  }
  // 🔴 zip 核验**要咬人**：第一版只打印不判定，".obsidian 0 条"的假警报就那么混过去了
  if (zipOk && !zipInfo) s.problems.push('zip 核验读不出来 —— PowerShell 打不开这个 zip？');
  if (zipInfo && (zipInfo.obsidian < 10 || zipInfo.exe < 1 || zipInfo.total < 60)) {
    s.problems.push(
      `zip 内容不对：.obsidian ${zipInfo.obsidian} 条 / 安装器 ${zipInfo.exe} / 总条目 ${zipInfo.total}（该分别 ≥ 10 / ≥ 1 / ≥ 60）`,
    );
  }
  if (s.problems.length === 0) {
    console.log('  自检：无真笔记 ✓ · 无 data.json ✓ · 安装器完整 ✓ · 讲解页自包含 ✓');
  } else {
    console.error('\n✗ 自检没过：');
    for (const p of s.problems) console.error('  · ' + p);
    process.exit(1);
  }
  console.log('');
}

// ────────────────────────────────────────────────────────────────
/**
 * 讲解页必须是**自包含单文件**：资源引用（img / script / link / iframe…）一律内嵌（data: / #锚点）。
 * ⚠️ `<a href>` 例外：**文字链接**允许外链（如指向 GitHub 仓库），但不许是相对文件（那种是坏链）。
 *    最早的一刀切版本把 `https://` 也拦了——2026-10-13 给讲解页加仓库链接时当场误红，改这里。
 */
function assertSelfContainedHtml(p) {
  const html = fs.readFileSync(p, 'utf8');
  const resRefs = [
    ...html.matchAll(/<(?:img|script|link|iframe|video|audio|source)\b[^>]*?\b(?:src|href)\s*=\s*"([^"]+)"/g),
  ].map((m) => m[1]);
  const aRefs = [...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const bad = [
    ...resRefs.filter((u) => !u.startsWith('data:') && !u.startsWith('#')),
    ...aRefs.filter((u) => !u.startsWith('#') && !/^https?:\/\//.test(u) && !u.startsWith('mailto:')),
  ];
  if (bad.length) fail(`讲解页不是自包含单文件（还有外链）：${bad.slice(0, 5).join(' , ')}`);
  /**
   * 体积 sanity：定稿 679 KB（图片内嵌）。< 500 KB 多半是拷贝时拿错了旧版
   *（桌面那份 280 KB 是 8.24 前的）——宁可当场红，也别把旧页发出去。
   */
  if (fsize(p) < 500 * 1024) fail(`讲解页只有 ${kb(fsize(p))} —— 疑似拷错旧版（定稿约 663 KB），先核对文件`);
}

/** 安装器：缓存里有就用；没有就现下（一次下载、反复复用）。失败即退出——不做"没有安装器的参赛包" */
function ensureInstaller() {
  const cached = path.join(CACHE_DIR, OBSIDIAN_EXE);
  if (fs.existsSync(cached) && fsize(cached) >= MIN_INSTALLER) return cached;
  console.log(`· 本地缓存没有 ${OBSIDIAN_EXE} —— 开始下载（约 325 MB，一次就好，之后复用）…`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const part = `${cached}.part`;
  fs.rmSync(part, { force: true });
  try {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    execFileSync(
      curl,
      ['-L', '--fail', '--retry', '3', '--connect-timeout', '30', '-o', part, OBSIDIAN_URL],
      { stdio: 'inherit' },
    );
  } catch (e) {
    fail(`下载安装器失败：${e.message}\n  检查网络后重跑；或手动下载 ${OBSIDIAN_URL} 放到 ${cached}`);
  }
  const size = fsize(part);
  if (size < MIN_INSTALLER) fail(`下载完的文件只有 ${mb(size)} —— 不对（该 325 MB），先查网络再重跑`);
  fs.renameSync(part, cached);
  return cached;
}

/** zip 内容核验：`.obsidian` 必须在（漏了它整包就废了——Windows 通配符打包的经典坑位） */
function verifyZip(zip) {
  const cmd = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `$z = [IO.Compression.ZipFile]::OpenRead(${psLit(zip)});`,
    '$n = $z.Entries.Count;',
    // ⚠️ 模式**不写分隔符**（`*/.obsidian/*` 只认 `/`，而 PS 5.1 的 Compress-Archive 写的是 `\`
    //    —— 第一版就是这么漏检的）——两种风格都放行
    "$obs = ($z.Entries | Where-Object { $_.FullName -like '*.obsidian*' }).Count;",
    "$exe = ($z.Entries | Where-Object { $_.FullName -like '*Obsidian-*.exe' }).Count;",
    '$z.Dispose();',
    'Write-Output "$n|$obs|$exe"',
  ].join(' ');
  try {
    const [n, obs, exe] = execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' })
      .trim()
      .split('|')
      .map(Number);
    return { total: n, obsidian: obs, exe };
  } catch {
    return null;
  }
}

/** 发出去之前最后一道闸：包里不能有任何"不该出门的东西" */
function selfCheck(pluginId) {
  const problems = [];
  // ① vault 顶层只允许这三样（多出来的东西 = 有人往这塞了什么，先查清）
  const top = fs.readdirSync(VAULT).sort();
  const want = ['.obsidian', '01_新知识库', '02_旧知识库'].sort();
  if (JSON.stringify(top) !== JSON.stringify(want)) {
    problems.push(`vault 顶层目录不对：${top.join(' / ')}（该是 ${want.join(' / ')}）`);
  }
  // ② 任何深度都不许有 data.json / snapshots / .trash（配过的稳态与隐私残留）
  const files = walk(VAULT);
  const banned = files.filter((f) => /(^|\/)(data\.json|snapshots|\.trash)(\/|$)/.test(f));
  if (banned.length) problems.push(`vault 里出现不该有的：${banned.slice(0, 5).join(' , ')}`);
  // ③ 笔记数量 sanity（太少说明生成器没跑对——它是"截图同套内容"的唯一来源）
  const notes = files.filter((f) => f.endsWith('.md') && f.startsWith('01_新知识库/'));
  if (notes.length < 10) problems.push(`示例笔记只有 ${notes.length} 篇（该 ≥ 10）—— make-demo-vault 没跑对？`);
  // ④ 安装器在包内、且与缓存逐字节同大小
  const inst = path.join(M1, OBSIDIAN_EXE);
  if (!fs.existsSync(inst)) problems.push('方式一里没有 Obsidian 安装器');
  else if (fsize(inst) !== fsize(path.join(CACHE_DIR, OBSIDIAN_EXE))) problems.push('安装器拷贝后大小不一致');
  // ⑤ 方式二插件文件齐（assets 允许缺——deploy 同款口径：警告不阻断，但这里要报出来）
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    if (!fs.existsSync(path.join(M2, pluginId, f))) problems.push(`方式二缺 ${f}`);
  }
  const assetsN = fs.existsSync(path.join(M2, pluginId, 'assets'))
    ? walk(path.join(M2, pluginId, 'assets')).length
    : 0;
  if (assetsN < 1) problems.push('方式二没有 assets/（向导配图）');
  // ⑥ 根文件齐（两份评审文档是必需件——少了直接红）
  for (const f of ['说明.md', '设计文档.md', '效果佐证.md', '经纬-知识工作台-讲解页.html']) {
    if (!fs.existsSync(path.join(PACK, f))) problems.push(`根目录缺 ${f}`);
  }
  return { problems, notes: notes.length, assetsN };
}

// ────────────────────────────────────────────────────────────────
/** 双击入口：壳而已，真正干活的是 install.ps1。⚠️ 存 UTF-8 **不带 BOM**（带 BOM 第一行 @echo off 会被当命令），靠 chcp 65001 让中文不花 */
const BAT = `@echo off
chcp 65001 >nul
title 经纬 · 知识工作台 —— 一键安装
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
`;

/**
 * 一键安装：① 找到（没有就用**包内附带的官方安装器**静默装好）② 把示例库放到「文档」
 * ③ 登记进 Obsidian 的库列表（只加一条）④ 启动。
 * ⚠️ 存的时候带 UTF-8 **BOM**（没有 BOM 时 PowerShell 5.1 按 GBK 解，中文乱码可能直接吃掉引号、
 *    整个脚本语法错）——写文件的调用处已经加了 \\uFEFF，这行注释是给未来改动的人看的。
 */
const PS1 = `# 经纬 · 知识工作台 —— 一键安装
# 做四件事：① 找到（没有就装好）Obsidian ② 把示例库放到「文档」 ③ 登记给 Obsidian ④ 启动它
# 🔴 只在这台机器上新建/登记一个**库文件夹**；不动别的库、不动 obsidian.json 里已有的条目（只加一条）。
# 🔴 装 Obsidian 用的是**官方原版安装器**（包内附带，未改动）；已经装好就整段跳过。
$ErrorActionPreference = 'Stop'

function Say($t) { Write-Host $t }
function Ok($t) { Write-Host "  ✓ $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'vault'
$dest = Join-Path ([Environment]::GetFolderPath('MyDocuments')) '经纬知识库'

# ── 找 Obsidian：命令行 → 注册表(obsidian:// 处理器) → 常见路径 ──
function Find-Obsidian {
  $cmd = Get-Command Obsidian.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($key in @('HKCU:\\Software\\Classes\\obsidian\\shell\\open\\command', 'HKLM:\\Software\\Classes\\obsidian\\shell\\open\\command')) {
    try {
      $v = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
      if ($v -match '"([^"]+Obsidian\\.exe)"') { return $Matches[1] }
    } catch { }
  }
  foreach ($p in @(
    "$env:LOCALAPPDATA\\Obsidian\\Obsidian.exe",
    "$env:ProgramFiles\\Obsidian\\Obsidian.exe",
    "\${env:ProgramFiles(x86)}\\Obsidian\\Obsidian.exe"
  )) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

# ── 找到或装好 Obsidian；拿不到返回 $null（该打的指引都打了）──
function Get-Obsidian {
  $exe = Find-Obsidian
  if ($exe) { return $exe }

  Say ''
  Say '这台机器上还没装过 Obsidian —— 现在替你装一个（官方原版，个人使用免费）。'

  # 包内自带的安装器优先（全程离线）；万一没有，再从 GitHub 官方发布页下载
  $installer = $null
  $bundled = Get-ChildItem -Path $root -Filter 'Obsidian-*.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($bundled) {
    $installer = $bundled.FullName
    Ok "用包里自带的安装器：$($bundled.Name)"
  } else {
    $url = 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.14.4/Obsidian-1.14.4.exe'
    $tmp = Join-Path $env:TEMP 'Obsidian-1.14.4.exe'
    Say '  包里没带安装器 —— 从 GitHub 官方发布页下载（约 325 MB，慢的话要等几分钟）…'
    try {
      if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L --fail --retry 3 --connect-timeout 30 -o $tmp $url
      } else {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $tmp
      }
    } catch { }
    if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 100MB) {
      Warn '下载没成功。'
      Say '  请去官网手动下载安装（免费）：https://obsidian.md/download'
      Say '  装完之后，**再双击一次这个「一键安装.bat」**就行。'
      Start-Process 'https://obsidian.md/download'
      return $null
    }
    $installer = $tmp
  }

  # 装的时候 Obsidian 不能开着
  if (Get-Process Obsidian -ErrorAction SilentlyContinue) {
    Warn 'Obsidian 正在运行 —— 先把它完全关掉，再双击一次这个脚本。'
    return $null
  }

  # 去掉"来自网络"标记（防 SmartScreen 拦），再静默装（/S = NSIS 静默；/currentuser = 只装当前用户）
  Unblock-File -Path $installer -ErrorAction SilentlyContinue
  Say '  静默安装中（不弹界面，十几秒）…'
  Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser' -Wait
  Start-Sleep -Seconds 3
  $exe = Find-Obsidian
  if (-not $exe) {
    # 静默没成（老安装器不认 /S 之类）→ 打开安装界面，人工点几步
    Warn '静默安装没成功 —— 现在打开安装界面，你点几下「下一步」就行。'
    Start-Process -FilePath $installer -Wait
    $exe = Find-Obsidian
  }
  if (-not $exe) {
    Warn '还是没找到 Obsidian —— 可能安装被取消了。'
    Say '  装好之后，**再双击一次这个「一键安装.bat」**就行。'
    return $null
  }
  return $exe
}

Say ''
Say '=== 经纬 · 知识工作台 · 一键安装 ==='
Say ''

if (-not (Test-Path $src)) { Warn "包里没有 vault 目录，是不是解压不完整？"; exit 1 }

# ── ① 找到 / 装好 Obsidian ────────────────────────────────────
$exe = Get-Obsidian
if (-not $exe) { exit 0 }
Ok "找到 Obsidian：$exe"

# ── ② 把库放到「文档」 ────────────────────────────────────────
if (Test-Path (Join-Path $dest '.obsidian')) {
  Warn "已经有一个库了：$dest（就用它，不覆盖）"
} else {
  if (Test-Path $dest) { Warn "$dest 已存在但不是库，往里面补" }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
  Ok "库已放到：$dest"
}

# ── ③ 登记到 Obsidian 的库列表（只加一条）──────────────────────
$reg = Join-Path $env:APPDATA 'obsidian\\obsidian.json'
$running = Get-Process Obsidian -ErrorAction SilentlyContinue
if ($running) {
  Warn 'Obsidian 正开着 —— **先把它完全关掉**再双击一次这个脚本，否则登记会被它覆盖掉。'
  Say ''
  Say '  或者：在 Obsidian 里「打开文件夹作为库」→ 选：'
  Say "    $dest"
  exit 0
}
$obj = $null
if (Test-Path $reg) {
  try { $obj = Get-Content $reg -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $obj = $null }
}
if (-not $obj) { $obj = [pscustomobject]@{ vaults = [pscustomobject]@{} } }
if (-not $obj.vaults) { $obj | Add-Member -NotePropertyName vaults -NotePropertyValue ([pscustomobject]@{}) -Force }
$already = $null
foreach ($p in $obj.vaults.PSObject.Properties) {
  if ($p.Value.path -eq $dest) { $already = $p.Name }
  $p.Value | Add-Member -NotePropertyName open -NotePropertyValue $false -Force
}
$id = if ($already) { $already } else { -join ((1..16) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) }) }
$entry = [pscustomobject]@{ path = $dest; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); open = $true }
$obj.vaults | Add-Member -NotePropertyName $id -NotePropertyValue $entry -Force
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reg) | Out-Null
# 🔴 **无 BOM 写**：PowerShell 5.1 的 Set-Content -Encoding UTF8 会加 BOM，
#    而这是 Obsidian 的**库列表**（里面还有别人别的库）—— 带 BOM 的 JSON 会让 JSON.parse
#    直接抛，最坏的情况是 Obsidian 认不出整个列表。用 .NET 的 UTF8Encoding($false) 写。
[System.IO.File]::WriteAllText($reg, ($obj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
Ok "已登记这个库（\${id}）"

# ── ④ 启动 ───────────────────────────────────────────────────
Start-Process $exe
Ok 'Obsidian 起来了 —— 它会直接打开这个库'

Say ''
Say '=== 还差一步（Obsidian 的要求，脚本代劳不了）==='
Say '  第一次打开时，Obsidian 会问「是否信任作者、启用社区插件」：'
Say '    → 点「开启社区插件」（或 设置 → 第三方插件 → 关掉「受限模式」）'
Say '  然后「经纬」就活了：左边会出现工作台图标（或按 Ctrl+P 搜「打开工作台」）。'
Say ''
Say '  第一次打开工作台会弹出**首次使用向导**，跟着走一遍就行。'
Say ''
`;

/** 方式一的安装说明（给判卷/收件人看；详细版） */
function M1_README(version) {
  return `# 经纬 · 知识工作台 —— 安装说明（方式一 · Windows 一键安装）（v${version}）

一个装在 **Obsidian** 里的知识库工作台：把整个知识库当数据库看 ——
全库笔记在一张表里看得见、选得中、批量动得了，**任何动库操作都能一键还原**。

---

## 一、装（就一步）

双击 **\`一键安装.bat\`**。脚本会：

1. 找 Obsidian —— 没装过就用**包里自带的官方安装器**替你装好（离线也能装，十几秒）
2. 把示例库（\`vault/\`）放到 **「文档\\经纬知识库」**（已有同名库就用它，不覆盖）
3. 把它登记进 Obsidian 的库列表
4. 启动 Obsidian，直接打开这个库

然后还差一步（Obsidian 的安全设计，脚本代劳不了）：第一次打开时它会问
**是否启用社区插件** → 点「开启社区插件」。之后左侧就会出现工作台图标
（或 \`Ctrl+P\` 搜「打开工作台」）。

> 已有 Obsidian、只想要插件本体？见 \`../方式二-纯插件/\`（跟这里装的是同一份）。
> Mac / Linux / 手机同理 —— 用方式二。

---

## 二、这个库里有什么

| 东西 | 说明 |
|---|---|
| \`vault/.obsidian/plugins/kb-workbench/\` | 插件本体（\`main.js\` / \`manifest.json\` / \`styles.css\` / \`assets/\` 向导配图） |
| \`vault/.obsidian/community-plugins.json\` | 已经把这个插件列进"启用名单" |
| \`vault/01_新知识库/\` | 21 个目录骨架 + **14 篇虚构示例笔记**（写作 / 露营 / 游戏研究之类，随便改、随便删） |
| \`vault/02_旧知识库/\` | 一个空的候选文件夹（演示"切换工作文件夹"用） |
| \`Obsidian-1.14.4.exe\` | Obsidian 官方安装器（原版未改动；装完可删，下次换机器还用得上） |

**没有什么**（都是刻意的）：任何人的真实笔记 · 插件的 \`data.json\`（所以不会有别人的
API key、也不会有别人的界面偏好）· 快照 · 回收站。

---

## 三、上手三件事

1. **首次使用向导**（第一次打开工作台自动弹）：选工作文件夹 → 过一遍模块开关 →
   现场检测（会报告库里已有什么；示例库是齐的，直接往下走）。
2. **「全部笔记」**：主力屏。默认网格档，右上角可切「详细信息 / 网格」；点卡片开小窗
   就地改，拖拽能搬文件，**每次都能撤销**。
3. **「看板」**：把笔记按目录 / 标签 / 属性分成几列（先「建板块」，再拖）。

> 遇到不熟的按钮：点它旁边的小 **?**；想系统看一遍：设置（⚙）→ 帮助栏 →「教程中心」。

> **AI 助手**是可选的：设置 → AI 助手 → 填自己的 baseURL / 模型 / API key（默认指向 DeepSeek）。
> **key 只存在你这台机器上**，不进库、不上传。不填也能用，只是「问 AI」那几处不工作。

---

## 四、常见问题

**Q：装完打开是空的 / 没有工作台图标？**
A：Obsidian 的「社区插件」总开关是**应用级**的，脚本改不了 ——
在 Obsidian 里点一次「开启社区插件」即可（设置 → 第三方插件）。

**Q：没网能装吗？**
A：能。Obsidian 的安装器就在这个文件夹里，全程离线。

**Q：脚本改了系统里的什么？**
A：就三处，全是"只加不改"：往「文档」放了一个库文件夹；在 Obsidian 的库列表里加了一条；
（如未安装）装了官方 Obsidian。**已有库的登记一条都不会动**。

**Q：不想要了怎么办？**
A：删掉「文档\\经纬知识库」这个文件夹（或只删 \`.obsidian/plugins/kb-workbench/\`），
笔记一篇都不会动。插件设置里还有「退出插件前的清理」（设置 → 数据）：
能逐项清掉插件写过的属性键与工具区文件，清前自动快照、可一键还原。

**Q：我的笔记会被上传吗？**
A：不会。这个插件是纯本地的：不联网（除非你自己配了 AI 助手），不发送任何数据。

---

## 五、想自己改骨架？

- **目录结构**：库内 \`01_新知识库/99_Meta/06_工作台/库结构.json\` 是真源，改它 →
  「全部笔记」右上角 \`⋯\` → 重排库结构 → 先看预览、再执行（能还原）。
- **目录映射**（按标签/领域归位）：设置 → 自动化 → 目录映射。
`;
}

/** 方式二的安装说明（给已有 Obsidian 的人；短版） */
function M2_README(version) {
  return `# 经纬 · 知识工作台 —— 纯插件包（方式二）（v${version}）

给**已经装好 Obsidian** 的人：拷一个文件夹、开一个开关就能用。
（没装过 Obsidian / 想体验完整示例库 → 用 \`../方式一-一键安装/\`。）

---

## 一、装（三步）

1. 把 **\`kb-workbench\`** 整个文件夹拷进你某个库的插件目录：

   \`<你的库>/.obsidian/plugins/kb-workbench/\`

   > \`plugins\` 目录不存在就自己建一个；注意别拷成两层 ——
   > \`manifest.json\` 要**直接**在 \`kb-workbench/\` 里。换个名字 Obsidian 会认不出。

2. 打开 Obsidian → 设置 → 第三方插件 → 先关掉「受限模式」（如果开着）→
   在列表里找到「经纬」→ 打开。

3. \`Ctrl+P\` 搜「打开工作台」（或点左侧的工作台图标）。第一次打开会弹**首次使用向导**，
   跟着走一遍：它会帮你建好目录框架，或收拢你现有的笔记。

---

## 二、里面有什么

\`kb-workbench/\`：\`main.js\`（本体）/ \`manifest.json\`（版本与兼容声明）/
\`styles.css\`（样式）/ \`assets/\`（向导配图；删了也能跑，只是向导少几张图）。

## 三、升级 / 卸载 / 隐私

- **升级**：用新版覆盖 \`kb-workbench/\` 里的同名文件即可（设置与笔记都不受影响）。
- **卸载**：在设置里关掉插件，或删掉 \`kb-workbench/\` 文件夹 —— **笔记一篇都不会动**。
  插件设置里还有「退出插件前的清理」（设置 → 数据）：能逐项清掉插件写过的属性键与
  工具区文件，清前自动快照、可一键还原。
- **隐私**：纯本地。不联网、不上传；AI 助手要自己配 key（只存本机）后才工作。
- **要求**：Obsidian ≥ 1.13.0；Windows / macOS / Linux / 移动端都行。
`;
}

/** 根级简要说明（提交包的"门面"） */
function ROOT_README(version) {
  const today = new Date().toISOString().slice(0, 10);
  return `源码仓库（GitHub，已脱敏）：https://github.com/menglii/kb-workbench

# 经纬 · 知识工作台 —— 参赛提交包

给 **Obsidian** 做的知识库工作台插件：把整个知识库当数据库看 ——
全库笔记在一张表里看得见、选得中、批量动得了，**任何动库操作都能一键还原**。

- 版本：**v${version}**（${today}）
- 作者：Mengligaga
- 规模：158 个 TypeScript 源文件 · 约 7.1 万行（含大量设计注释），零运行时依赖；离线验收用例 1400+ 条

## 包里有什么

| 位置 | 是什么 |
|---|---|
| \`方式一-一键安装/\` | **Windows 一键脚本**：装 Obsidian（安装器随包附带，离线可用）→ 建库 → 装插件 → 启动 |
| \`方式二-纯插件/\` | **纯插件文件夹**（\`kb-workbench/\`）——已有 Obsidian 的话，拖进任意库就能用 |
| \`经纬-知识工作台-讲解页.html\` | 单文件介绍页：双击用浏览器打开，功能演示、上手步骤、常见问题都在里面 |
| \`设计文档.md\` | 设计与技术方案：应用场景 / 设计思路 / 技术方案 / 主要功能 / 安全与合规 |
| \`效果佐证.md\` | 测试与验证记录：五层测试体系、验收数据、随包安装器的校验值 |
| \`说明.md\` | 你正在看的这份 |

## 怎么装

- **方式一（Windows，推荐）**：双击 \`方式一-一键安装/一键安装.bat\`，其余交给脚本。
  详细步骤与常见问题见 \`方式一-一键安装/安装说明.md\`。
- **方式二（任意平台）**：把 \`方式二-纯插件/kb-workbench/\` 拷到
  \`<你的库>/.obsidian/plugins/\` 下 → Obsidian 设置 → 第三方插件 → 启用「经纬」。
  详细步骤见 \`方式二-纯插件/安装说明.md\`。

## 系统要求

- **Obsidian ≥ 1.13.0**（方式一会自动装最新版；方式二需要你已有 Obsidian）
- 方式一：Windows 10 / 11；方式二：Windows / macOS / Linux / 移动端（Obsidian 能跑的地方都行）
- 无需联网（方式一的安装器随包附带；插件的 AI 助手要自己配 key 后才联网）

## 插件能干什么（一屏速览）

- **五栏导航**：首页 / 全部笔记 / 看板 / 图谱 / 回顾
- **「全部笔记」**：全库一张表；就地改属性、拖拽搬文件、批量操作，**每一步都有快照与撤销**
- **自动化整理**：一键整理收件箱、按映射自动归位、重排库结构 —— 全部"先预览、再确认、可还原"
- **回顾**：从笔记生成间隔复习卡（可让 AI 出初稿），按 1 → 3 → 6 … 天复习
- **AI 助手**（可选）：接入自己的模型（默认 DeepSeek），整理类任务会跑到确认卡前等你拍板
- **纯本地**：不联网、不上传；卸载不带走任何笔记

## 示例库说明

方式一装的库里带一整套**虚构示例笔记**（14 篇，与讲解页截图同一套内容），
是为演示准备的，随便改、随便删。方式二装进你自己的库则是从零开始 ——
首次向导会带你建结构。

## 卸载

删掉 \`<库>/.obsidian/plugins/kb-workbench/\` 即可（或在 Obsidian 里关掉插件）。
插件设置里还有「退出插件前的清理」（设置 → 数据）：能逐项清掉插件写过的属性键与
工具区文件，清前自动快照、可一键还原。
`;
}

main();
