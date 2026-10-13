// 带调试端口启动 Obsidian（真机探针的前置步骤）
//
// ⚠️ Obsidian 是**单实例**应用：已经在运行时，带参数再启动一次参数会被忽略
//    → 必须**先完全退出**（File → Exit / 关掉窗口），再跑这个脚本
//
// 用法：npm run probe:launch          （端口 9222；用 KBW_CDP_PORT 改）
import { execFileSync, spawn } from 'node:child_process';
import { maximizeObsidian, minimizeObsidian } from './win-window.mjs';
import { findObsidianExe, LAUNCH_FLAGS } from './obsidian.mjs';

const PORT = Number(process.env.KBW_CDP_PORT ?? 9222);
const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};


function running() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "Get-Process Obsidian -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"],
      { encoding: 'utf8' },
    );
    return Number(out.trim()) > 0;
  } catch {
    return false;
  }
}

async function portAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

const exe = findObsidianExe();
if (!exe) {
  console.error(c.bad('✗ 找不到 obsidian.exe —— 用 KBW_OBSIDIAN_EXE 环境变量直接指路径'));
  process.exit(1);
}
console.log(`Obsidian：${c.dim(exe)}`);

if (await portAlive()) {
  console.log(c.ok(`✓ 调试端口 ${PORT} 已经在响应 —— Obsidian 已经带参数跑着了，直接 npm run probe 就行`));
  process.exit(0);
}

if (running()) {
  console.error(c.bad('\n✗ Obsidian 正在运行，但调试端口没开。'));
  console.error(`
  单实例应用：必须**先完全退出**再带参数启动，否则参数被忽略。请：

    1. 在 Obsidian 里 File → Exit（或关掉窗口，确保托盘里也没有残留进程）
    2. 再跑一次 npm run probe:launch
`);
  process.exit(1);
}

console.log(`启动中（--remote-debugging-port=${PORT}）…`);
spawn(exe, [`--remote-debugging-port=${PORT}`, ...LAUNCH_FLAGS], { detached: true, stdio: 'ignore' }).unref();

/**
 * **起来之后把窗口摆好**（用户 2026-09-25 要的："呼出时默认最小化，别抢我的焦点，而且最小化也能验证"）。
 *
 * OS 层的两招都在 `scripts/win-window.mjs`（那里写着为什么不能用启动参数 / CDP —— 都实测过 ✗）。
 *
 * ⚠️ 最小化 ≠ 不能验证：探针与 peek 在窗口不可见时会自动切**模拟视口**
 *（`Emulation.setDeviceMetricsOverride`），几何 / 输入 / 截图照常（见 坑/探针.md 的「探针专坑 ④」）。
 * 想看界面时点开它就行 —— 这一步只是**不再由工具把窗口弹到你脸上**。
 * `KBW_LAUNCH_MIN=0` = 想直接看界面（**顺手最大化一次**，P7.0b/14.8b：
 * 窗口只有 868×745 时截图会掉窄档、失败点看着与判据毫无关系）。
 */
async function placeWindow() {
  const skipMinimize = process.env.KBW_LAUNCH_MIN === '0';
  if (skipMinimize) return (await maximizeObsidian()) ? 'maximized' : '';
  return (await minimizeObsidian()) ? 'minimized' : '';
}

const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  if (await portAlive()) {
    console.log(c.ok(`✓ 调试端口 ${PORT} 已就绪`));
    const placed = await placeWindow();
    if (placed === 'minimized') {
      console.log(c.dim('  已**最小化**（验证/开发不再抢你的焦点；要看界面点开它即可）'));
    } else if (placed === 'maximized') {
      console.log(c.dim('  已**最大化**（KBW_LAUNCH_MIN=0：要看界面 / 要截图）'));
    } else {
      console.log(c.dim('  （窗口没动：非 Windows / 没找到窗口 / 没最小化是因为 KBW_LAUNCH_MIN=0）'));
    }
    console.log(c.dim('  下一步：npm run probe'));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 700));
}
console.error(c.bad(`✗ 等了 30 秒端口还没起来 —— 可能 Obsidian 拒绝了该参数（那就只能用它的内置开发者控制台了）`));
process.exit(1);
