// 生成**分享用的一键安装包**：一个自带插件的 Obsidian 库（**不含任何笔记**）
//
// 用法：
//   npm run build && node scripts/make-share-pack.mjs            → 产出到桌面
//   node scripts/make-share-pack.mjs --out "D:/某处"             → 换个落点
//
// 包里有什么（**没有**：任何 .md 笔记 / data.json / 快照 / AI key）：
//   ├── 一键安装.bat        双击就跑（真正干活的是 install.ps1）
//   ├── install.ps1         找 Obsidian → 放库 → 登记 → 启动
//   ├── 安装说明.md          给收包的人看的
//   └── vault/              这一份就是要打开的"库"
//       ├── .obsidian/      只放两样：插件本体 + community-plugins.json（已启用）
//       └── 01_新知识库/     空骨架：21 个目录 + 7 个骨架页（**通用样板，不是谁的笔记**）
//
// 🔴 **骨架目录清单只有一个真源**：`src/core/config-files.ts` 的 `dirs`。
//    这里用正则把它从源码里读出来（不另抄一份），并当场断言"读出来的东西像那么回事"
//    （数量 ≥ 20、含已知的两个）—— 形状一变就大声失败，不会静默生成一个空骨架。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
/**
 * 落点默认 = **系统认定的"桌面"**，不是 `%USERPROFILE%\Desktop`。
 * 🔴 这两个在开了 OneDrive 的机器上**不是同一个目录**（实测这台：真桌面 =
 * `C:\Users\<你的用户名>\OneDrive\Desktop`，而 `%USERPROFILE%\Desktop` 是个没人看的旧壳）——
 * 第一版按后者写，用户问"安装包放哪了"（桌面上根本看不见）。
 * `[Environment]::GetFolderPath('Desktop')` 认的是**重定向后的真桌面**；拿不到再退回老写法。
 */
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
const PACK = path.join(OUT_BASE, '经纬知识工作台-安装包');
const VAULT = path.join(PACK, 'vault');
const KB = '01_新知识库';

const fail = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

function main() {
  // ── 1. 构建产物在不在 ─────────────────────────────────────────
  const manifestPath = path.join(ROOT, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail('缺 manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    if (!fs.existsSync(path.join(ROOT, f))) fail(`缺构建产物 ${f} —— 先跑 npm run build`);
  }

  // ── 2. 从源码读骨架目录（唯一真源）+ 当场断言 ──────────────────
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'src/core/config-files.ts'), 'utf8');
  const dirsBlock = /dirs:\s*\[([\s\S]*?)\]/.exec(cfgSrc);
  if (!dirsBlock) fail('从 src/core/config-files.ts 里读不出 dirs —— 它的形状变了，改这个脚本');
  const DIRS = [...dirsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (DIRS.length < 20) fail(`骨架目录只读出 ${DIRS.length} 个（该 ≥ 20）—— 正则没读对，别往下走`);
  for (const must of ['00_Inbox', '99_Meta/06_工作台', '01_Projects/01_执行中']) {
    if (!DIRS.includes(must)) fail(`骨架里少了 ${must} —— 读出来的东西不对`);
  }

  /**
   * 骨架页的**通用样板**（7 个，与 `config-files.ts` 的 `seedFiles` 一一对应）。
   * ⚠️ 正文是**为分享包现写的**，不是从任何人的库里抄的 —— 这一条是"不带具体笔记"的落点。
   */
  const today = new Date().toISOString().slice(0, 10);
  /**
   * ⚠️ **用数组拼、不用多行模板字符串**：这一段代码本身缩进在 `main()` 里，
   * 多行模板会把缩进**写进文件内容** → 生成出来的 YAML 每行带两个空格（前言就废了）。
   */
  const stub = (title, 领域) =>
    [
      '---',
      '类型: 中心页',
      `领域: ${领域}`,
      '状态: 持续更新',
      `创建日期: ${today}`,
      'tags:',
      '  - MOC',
      '---',
      '',
      `# ${title}`,
      '',
      '> 这个页面是**骨架自带的样板**，随你怎么改（删掉也行）。',
      '',
    ].join('\n');
  const SEEDS = {
    '00_Inbox/_收件箱.md': stub('📥 收件箱', 'Meta'),
    '01_Projects/_项目中心.md': stub('🎯 项目中心', 'Meta'),
    '02_Areas/_领域中心.md': stub('📚 领域中心', 'Meta'),
    '03_Resources/_资源中心.md': stub('🗂️ 资源中心', 'Meta'),
    '04_Archives/_归档中心.md': stub('📦 归档中心', 'Meta'),
    '99_Meta/04_索引与地图/MOC_知识地图.md': stub('🗺️ 知识地图', 'Meta'),
    '99_Meta/04_索引与地图/知识库目录说明.md': stub('📂 目录说明', 'Meta'),
  };

  // ── 3. 清掉旧的、重建目录树 ───────────────────────────────────
  fs.rmSync(PACK, { recursive: true, force: true });
  const mk = (p) => fs.mkdirSync(p, { recursive: true });

  for (const d of DIRS) mk(path.join(VAULT, KB, d));
  for (const f of Object.keys(SEEDS)) {
    const abs = path.join(VAULT, KB, f);
    mk(path.dirname(abs));
    fs.writeFileSync(abs, SEEDS[f]);
  }

  const pluginDir = path.join(VAULT, '.obsidian', 'plugins', manifest.id);
  mk(pluginDir);
  for (const f of ['main.js', 'manifest.json', 'styles.css']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(pluginDir, f));
  }
  /**
   * **向导配图等静态资产**（P7.2b）：与 `deploy.mjs` 的 `DIRS` 是同一份口径（两边一起改）。
   * 缺了就**大声提示**——收包的人第一屏就是向导，没图的向导等于白做。
   */
  const assetsSrc = path.join(ROOT, 'assets');
  if (fs.existsSync(assetsSrc)) {
    fs.cpSync(assetsSrc, path.join(pluginDir, 'assets'), { recursive: true });
  } else {
    console.warn('⚠ 缺少 assets/ 目录 —— 这一包里的向导会没有配图（加载失败自动隐藏）');
  }
  // 插件**已启用**（真正的"开社区插件总开关"是应用级 localStorage，脚本够不着 —— 说明里写了）
  fs.writeFileSync(
    path.join(VAULT, '.obsidian', 'community-plugins.json'),
    `${JSON.stringify([manifest.id], null, 2)}\n`,
  );

  // ── 4. 一键安装脚本 ──────────────────────────────────────────
  // ⚠️ `.bat` 存 UTF-8 **不带 BOM**（带 BOM 的话第一行 `@echo off` 会被当成命令报错）；
  //    它靠 `chcp 65001` 让中文标题不花。
  /**
   * **更新日志**（17.5，P7.0b）：收包的人要能看见"这一版跟上一版差在哪"。
   * 有就带、没有不算失败（那说明这个仓库还没建 CHANGELOG.md —— 提示一句就行）。
   */
  const changelogSrc = path.join(ROOT, 'CHANGELOG.md');
  if (fs.existsSync(changelogSrc)) {
    fs.copyFileSync(changelogSrc, path.join(PACK, '更新日志.md'));
  } else {
    console.warn('⚠ 没找到 CHANGELOG.md —— 这一包不带更新日志');
  }

  fs.writeFileSync(path.join(PACK, '一键安装.bat'), BAT, 'utf8');
  /**
   * 🔴 **`.ps1` 必须带 UTF-8 BOM**：Windows PowerShell 5.1 读脚本时**没有 BOM 就按 ANSI(GBK) 解**，
   * 中文提示会全变乱码 —— 更要命的是乱码后的字节可能吃掉引号，于是**整个脚本语法错**、
   * 双击之后一片红字（这一版就是这么被抓出来的：`解析器` 报"字符串缺少终止符"）。
   */
  fs.writeFileSync(path.join(PACK, 'install.ps1'), `﻿${PS1}`, 'utf8');
  fs.writeFileSync(path.join(PACK, '安装说明.md'), readme(manifest.version), 'utf8');

  // ── 5. 打包成 zip（用系统的 Compress-Archive；Node 没有内置 zip）──
  const zip = path.join(OUT_BASE, `经纬知识工作台-安装包-v${manifest.version}.zip`);
  fs.rmSync(zip, { force: true });
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path ${JSON.stringify(path.join(PACK, '*'))} -DestinationPath ${JSON.stringify(zip)} -Force`,
      ],
      { stdio: 'pipe' },
    );
  } catch (e) {
    console.warn(`⚠ zip 没打成（${e.message}）—— 目录本身是可用的，手动右键压缩也一样`);
  }

  // ── 6. 自检：包里一个笔记都不许有 ─────────────────────────────
  const walked = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else walked.push(path.relative(PACK, p).split(path.sep).join('/'));
    }
  };
  walk(PACK);
  /**
   * ⚠️ **只数 `vault/` 里的 .md**（骨架页）—— 包根上还有 `安装说明.md` 与 `更新日志.md`，
   * 一起数进去的话那句"骨架页 N 个"就变成假的了（P7.0b 加更新日志时顺手修）。
   */
  const md = walked.filter((f) => f.endsWith('.md') && f.startsWith('vault/'));
  const forbidden = walked.filter((f) => /(^|\/)(data\.json|snapshots\/|\.trash\/)/.test(f));
  console.log(
    [
      '',
      '✓ 分享包已生成',
      `  目录：${PACK}`,
      `  zip ：${fs.existsSync(zip) ? zip : '（没打成，用目录）'}`,
      `  插件：${manifest.id} v${manifest.version}（${(fs.statSync(path.join(pluginDir, 'main.js')).size / 1024).toFixed(0)} KB）`,
      `  骨架：${DIRS.length} 个目录 + ${md.length} 个骨架页（全部是为分享**现写的通用样板**）`,
      `  ${forbidden.length === 0 ? '✓' : '✗'} 不含 data.json / 快照：${forbidden.length === 0 ? '干净' : forbidden.join(', ')}`,
      '',
    ].join('\n'),
  );
  if (forbidden.length > 0) process.exit(1);
}

// ────────────────────────────────────────────────────────────────
/** 双击入口：只是个壳，真正干活的是 install.ps1 */
const BAT = `@echo off
chcp 65001 >nul
title 经纬 · 知识工作台 —— 一键安装
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
`;

/**
 * 真正的安装逻辑。
 * ⚠️ 写成 .ps1 而不是 .bat：要在 `obsidian.json` 里做 JSON 读写，批处理干不了。
 * ⚠️ 文件用 UTF-8 存（PowerShell 认 BOM / 无 BOM 都行），中文提示才不会乱码。
 */
const PS1 = `# 经纬 · 知识工作台 —— 一键安装
# 做四件事：① 找到 Obsidian ② 把库放到「文档」 ③ 登记给 Obsidian ④ 启动它
# 🔴 只在这台机器上新建/登记一个**库文件夹**；不动别的库、不动 %APPDATA%\\obsidian\\obsidian.json
#    里已有的条目（只加一条）。
$ErrorActionPreference = 'Stop'

function Say($t) { Write-Host $t }
function Ok($t) { Write-Host "  ✓ $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'vault'
$dest = Join-Path ([Environment]::GetFolderPath('MyDocuments')) '经纬知识库'

Say ''
Say '=== 经纬 · 知识工作台 · 一键安装 ==='
Say ''

if (-not (Test-Path $src)) { Warn "包里没有 vault 目录，是不是解压不完整？"; exit 1 }

# ── ① 找 Obsidian：命令行 → 注册表(obsidian:// 处理器) → 常见路径 ──
$exe = $null
$cmd = Get-Command Obsidian.exe -ErrorAction SilentlyContinue
if ($cmd) { $exe = $cmd.Source }
if (-not $exe) {
  foreach ($key in @('HKCU:\\Software\\Classes\\obsidian\\shell\\open\\command', 'HKLM:\\Software\\Classes\\obsidian\\shell\\open\\command')) {
    try {
      $v = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
      if ($v -match '"([^"]+Obsidian\\.exe)"') { $exe = $Matches[1]; break }
    } catch { }
  }
}
if (-not $exe) {
  foreach ($p in @(
    "$env:LOCALAPPDATA\\Obsidian\\Obsidian.exe",
    "$env:ProgramFiles\\Obsidian\\Obsidian.exe",
    "\${env:ProgramFiles(x86)}\\Obsidian\\Obsidian.exe"
  )) { if ($p -and (Test-Path $p)) { $exe = $p; break } }
}
if (-not $exe) {
  Warn '这台机器上没找到 Obsidian。'
  Say '  请先去官网装一个（免费）：https://obsidian.md/download'
  Say '  装完之后，**再双击一次这个「一键安装.bat」**就行。'
  Start-Process 'https://obsidian.md/download'
  exit 0
}
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
Say '  第一次打开工作台会弹出**首次使用向导**（两步），跟着走一遍就行。'
Say ''
`;

/** 给收包的人看的说明（也是"包里有什么/没有什么"的说明书） */
function readme(version) {
  return `# 经纬 · 知识工作台 —— 安装说明（v${version}）

一个装在 **Obsidian** 里的知识库工作台：把整个知识库当数据库看 ——
全库笔记在一张表里看得见、选得中、批量动得了，**任何动库操作都能一键还原**。

---

## 一、装（两种方式，挑一种）

### 方式 A：一键安装（推荐）

1. 双击 **\`一键安装.bat\`**
2. 脚本会：找 Obsidian → 把库放到「文档\\经纬知识库」→ 登记 → 启动
3. 第一次打开时 Obsidian 会问要不要启用社区插件 → 点**开启**
4. 打开工作台（左侧图标 / \`Ctrl+P\` 搜「打开工作台」）→ 弹出**首次使用向导**，跟着走

> 没装 Obsidian？脚本会**自动打开官网下载页**；装完**再双击一次**就行。
> Obsidian 是免费软件（个人使用免费），本包**不附带**它的安装器。

### 方式 B：手动

1. 装 Obsidian：<https://obsidian.md/download>
2. 把 \`vault\` 文件夹放到任意位置（比如「文档」）
3. Obsidian 里「打开文件夹作为库」→ 选这个 \`vault\`
4. 设置 → 第三方插件 → 关掉「受限模式」→ 确认「经纬」是开着的

---

## 二、这个包里有什么

| 东西 | 说明 |
|---|---|
| \`vault/.obsidian/plugins/kb-workbench/\` | 插件本体（\`main.js\` / \`manifest.json\` / \`styles.css\` / \`assets/\` —— 向导配图） |
| \`vault/.obsidian/community-plugins.json\` | 已经把这个插件列进"启用名单" |
| \`vault/01_新知识库/\` | **空骨架**：21 个目录 + 7 个骨架页（中心页样板） |
| \`一键安装.bat\` / \`install.ps1\` | 一键安装脚本（Windows） |
| \`更新日志.md\` | 每一版改了什么（换新版时先看它） |

**包里没有什么**（都是刻意的）：

- ❌ 任何人的笔记 —— 骨架里那 7 个页面是**通用样板**，随便改或删
- ❌ 插件的 \`data.json\`（所以不会有别人的 API key、也不会有别人的界面偏好）
- ❌ 快照目录、回收站、别的库

---

## 三、上手三件事

1. **首次使用向导**（打开工作台时自动弹）：工作文件夹（新建一个 / 或选现成目录）→ 模块开关 → 现场检测。
   第 3 步会告诉你骨架缺什么 —— 缺的话点那一行右端的按钮（空库「建一套目录框架？」/
   「收拢旧笔记 + 建新框架？」），直达「重排库结构」（先预览、再确认）。
2. **「全部笔记」**：这是主力屏。默认是**网格档**（图标 + 名字），
   右上角能切「详细信息 / 网格」；点卡片开小窗就地改，拖拽能搬文件、每次都能撤销。
3. **「看板」**：把笔记按目录 / 标签 / 属性分成几列（先「建板块」，再拖）。

> 遇到不熟的按钮：点它旁边的小 **?**；要系统看一遍就翻**教程 6 篇** ——
> 设置（⚙）→ 帮助栏 →「教程中心」（每篇都能「导出为笔记」存进库里慢慢看）。

> **AI 助手**是可选的：设置 → AI 助手 → 填自己的 baseURL / 模型 / API key
> （默认指向 DeepSeek）。**key 只存在你这台机器上**，不进库、不上传。
> 不填也能用，只是「问 AI」那几处不工作。

---

## 四、常见问题

**Q：装完打开是空的 / 没有工作台图标？**
A：Obsidian 的「社区插件」总开关是**应用级**的，脚本改不了 ——
在 Obsidian 里点一次「开启社区插件」即可（设置 → 第三方插件）。

**Q：能装到 Mac / 手机上吗？**
A：插件本身支持（\`isDesktopOnly: false\`），但本包的一键脚本只写了 Windows。
Mac / 手机：把 \`vault\` 整个文件夹拿过去，用「打开文件夹作为库」即可。

**Q：我的笔记会被上传吗？**
A：不会。这个插件是纯本地的：不联网（除非你自己配了 AI 助手），
不发送任何数据；AI 的 key 也只存在本机。

**Q：怎么卸载？**
A：删掉 \`vault/.obsidian/plugins/kb-workbench/\`（或在 Obsidian 里关掉这个插件）。
你的笔记一个都不会动。

---

## 五、想自己改骨架？

- **目录结构**：库内 \`01_新知识库/99_Meta/06_工作台/库结构.json\` 是真源，
  改它 → 「全部笔记」右上角 \`⋯\` → 重排库结构 → 先看预览、再执行（能还原）。
- **新建笔记套的模板**：\`01_新知识库/99_Meta/02_模板库/Templater/\`（本包是空的，自己放；
  不装 Templater 插件也能用，只是模板里的 \`<% %>\` 不会被求值）。
- **目录映射**（按标签/领域归位）：设置 → 自动化 → 目录映射。本包没有这张表，
  按插件自带的默认值显示，点「保存」就会落盘成库内 JSON。
`;
}

main();
