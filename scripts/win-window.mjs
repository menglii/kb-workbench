// Windows 上对 Obsidian **主窗口**的 OS 级操作（最小化 / 最大化 / 移位 / 状态 / 优雅关闭）
// —— 三条链共用：
//   · `probe-launch.mjs`：起来之后**最小化**（默认，不抢焦点）或**最大化**（`KBW_LAUNCH_MIN=0`）
//   · `probe.mjs`：**截图前**把窗口弄到够大（窗口太小会把截图拍成窄档 —— 见那里的调用点）
//   · `obsidian.mjs`（P7.2d 新工具）：`up/down/park/show/status` 的窗口半边
//
// 🔴 为什么只能走 OS 层（三条都实测过）：
//   · `powershell Start-Process -WindowStyle Minimized` → 这个 app **根本起不来**（端口 30 秒没开）；
//   · `cmd /c start /min` → 能起来，但 Obsidian 会**按自己记住的窗口状态**恢复成可见；
//   · CDP：这个 build 上 `Browser.getWindowForTarget` / `setWindowBounds` **页面连接与浏览器
//     连接上都没有**（实测两次 ✗）。
// 于是只剩拿主窗口句柄调 `ShowWindowAsync` / `SetWindowPos`（异步版：不阻塞、窗口忙时不卡）。
//
// ⚠️ **`park`（移出屏幕外）是 P7.2d 实测过的"隐形 + 全功能"档**：窗口移出屏幕后
//    `document.visibilityState` 仍是 visible、rAF 与计时器照跑、CDP 截图照出
//   —— 而真·最小化（iconic）时合成器停帧，**截图必超时**（P7.2c 一轮环境红的根源）。
//    两个前提：① 该 Obsidian 是用 `obsidian.mjs up` 起的（带了三个反节流开关）；
//    ② 只是"移出屏幕"，别顺手 ShowWindow(MINIMIZE)。
//
// ⚠️ 非 Windows 一律返回 false/''（调用方自己决定"没做成时怎么办"）——
//    这个仓库在 mac/linux 上只保证"核心四命令"（见 17.4）。
import { spawn } from 'node:child_process';

/** `ShowWindow` 的 nCmdShow 常量 */
export const SW_MAXIMIZE = 3;
export const SW_MINIMIZE = 6;
export const SW_RESTORE = 9;

/** 统一的 PowerShell 前缀：拿 Obsidian 主窗口句柄 */
const PS_PRELUDE = `$p = Get-Process -Name Obsidian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;`;

function runPs(script, timeoutMs = 15000) {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    /**
     * ⚠️ **必须带超时**（P7.2d 复审 Y3）：Add-Type 编译卡住 / 杀软干扰时，没超时
     * 会让整条命令永久挂住（`closeObsidian` 的轮询尤其危险）。
     */
    const cap = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 无所谓 */
      }
      finish('');
    }, timeoutMs);
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('close', () => {
      clearTimeout(cap);
      finish(out.trim());
    });
    child.on('error', () => {
      clearTimeout(cap);
      finish('');
    });
  });
}

/**
 * 调一次 `ShowWindowAsync(主窗口句柄, command)`。
 * 返回 `'maximized' | 'minimized' | 'restored' | 'no-window' | ''`（'' = 没跑起来 / 非 Windows）。
 */
export function showWindow(command) {
  const name = command === SW_MAXIMIZE ? 'maximized' : command === SW_MINIMIZE ? 'minimized' : 'restored';
  const ps = `
    Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);';
    ${PS_PRELUDE}
    if ($p) { [W.U]::ShowWindowAsync($p.MainWindowHandle, ${Number(command)}) | Out-Null; 'done' } else { 'no-window' }
  `;
  return runPs(ps).then((out) => (out.includes('done') ? name : out.includes('no-window') ? 'no-window' : ''));
}

export async function maximizeObsidian() {
  return (await showWindow(SW_MAXIMIZE)) === 'maximized';
}

export async function minimizeObsidian() {
  return (await showWindow(SW_MINIMIZE)) === 'minimized';
}

export async function restoreObsidian() {
  return (await showWindow(SW_RESTORE)) === 'restored';
}

/**
 * **窗口现状**（P7.2d 工具化）：进程 id / 句柄 / 最小化 / 最大化 / 位置尺寸 / 是否屏幕外。
 * `null` = 没窗口 / 非 Windows。
 */
export async function getObsidianWindow() {
  const ps = `
    Add-Type -AssemblyName System.Windows.Forms;
    Add-Type -Namespace W -Name U -MemberDefinition '
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    public struct RECT { public int L, T, R, B; }';
    ${PS_PRELUDE}
    if (-not $p) { 'no-window'; exit }
    $h = $p.MainWindowHandle;
    $r = New-Object W.U+RECT; [W.U]::GetWindowRect($h, [ref]$r) | Out-Null;
    'ok|' + $p.Id + '|' + $h + '|' + [W.U]::IsIconic($h) + '|' + [W.U]::IsZoomed($h) + '|' + $r.L + '|' + $r.T + '|' + $r.R + '|' + $r.B + '|' + [System.Windows.Forms.SystemInformation]::VirtualScreen.Left
  `;
  const out = await runPs(ps);
  if (!out.startsWith('ok|')) return null;
  const parts = out.split('|');
  const pid = Number(parts[1]);
  const handle = Number(parts[2]);
  const iconic = parts[3] === 'True';
  const zoomed = parts[4] === 'True';
  const left = Number(parts[5]);
  const top = Number(parts[6]);
  const right = Number(parts[7]);
  const bottom = Number(parts[8]);
  const vsLeft = Number(parts[9]);
  return {
    pid,
    handle,
    iconic,
    zoomed,
    rect: { left, top, right, bottom },
    /** 屏幕外的判据：完全落在虚拟屏左界之外（park 就是移到 -32000） */
    offscreen: right < vsLeft + 4,
  };
}

/**
 * **把窗口移到某个坐标**（不改大小、不激活）。`park`（-32000,-32000）与
 * `show`（还原坐标）都走它 —— 移位只有这一条路。
 *
 * 🔴 **必须带 `SWP_NOSIZE`(0x0001)**：`SetWindowPos` 的 w/h 传 0 且不带 NOSIZE 时
 * 会把窗口**缩到最小**（P7.2d 首测实测：窗口被缩成 214×157，截图悄悄变小、
 * 还被平台记进工作区）—— 0x0001|0x0004|0x0010 = NOSIZE | NOZORDER | NOACTIVATE。
 */
export async function moveObsidian(x, y) {
  const ps = `
    Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);';
    ${PS_PRELUDE}
    if ($p) { [W.U]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, ${Math.round(x)}, ${Math.round(y)}, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010) | Out-Null; 'done' } else { 'no-window' }
  `;
  return (await runPs(ps)).includes('done');
}

/**
 * **改窗口尺寸**（保持当前位置、不激活）—— `park` 垫尺寸 / `show` 还尺寸都用它。
 * 🔴 flags = `SWP_NOMOVE(0x0002)|NOZORDER(0x0004)|NOACTIVATE(0x0010)`：**必须有 NOMOVE** ——
 * 缺了它 x/y 传的 0,0 会被当真，窗口当场被搬到屏幕左上角（P7.2d 复审修补时实测：park 完
 * 窗口冒上屏，(0,0) 现形）。这条是 `moveObsidian` 的对称物：一个只动位置、一个只动尺寸。
 */
export async function resizeObsidian(wpx, hpx) {
  const ps = `
    Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int ht, uint f);';
    ${PS_PRELUDE}
    if ($p) { [W.U]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, 0, 0, ${Math.round(wpx)}, ${Math.round(hpx)}, 0x0002 -bor 0x0004 -bor 0x0010) | Out-Null; 'done' } else { 'no-window' }
  `;
  return (await runPs(ps)).includes('done');
}

/** 窗口的显示名（给日志/状态用） */
export function windowStateName(w) {
  if (!w) return 'no-window';
  if (w.iconic) return 'minimized';
  if (w.zoomed) return 'maximized';
  return w.offscreen ? 'parked（屏幕外）' : 'visible';
}

/**
 * **优雅关闭 Obsidian**（`CloseMainWindow` = 照点窗口右上角 ✕ 那一套：平台自己
 * 存 workspace / 落盘配置）。返回 `'closed' | 'still-running' | 'no-window' | ''`。
 * ⚠️ 不在这里 `taskkill` —— 强杀不落盘，下次启动可能丢工作区状态；要强杀由调用方显式做。
 */
export async function closeObsidian({ waitMs = 12000 } = {}) {
  const first = await runPs(`${PS_PRELUDE} if ($p) { $p.CloseMainWindow() | Out-Null; 'closing' } else { 'no-window' }`);
  if (first.includes('no-window')) return 'no-window';
  if (!first.includes('closing')) return '';
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const count = await runPs(`(Get-Process Obsidian -ErrorAction SilentlyContinue | Measure-Object).Count`);
    /**
     * ⚠️ **查询失败（''）不许当"已关闭"**（P7.2d 复审 Y2）：`Number('') === 0` 会让
     * "PowerShell 起不来"伪装成"优雅退出成功"（假绿）。查询失败 → 'unknown'，如实报。
     */
    if (count === '') return 'unknown';
    if (Number(count) === 0) return 'closed';
    if (Date.now() - t0 > waitMs) return 'still-running';
  }
}
