// 真机 peek：把窗口抬到前台（+ 焦点模拟）→ 求值 → 可选截图 → 打印
//
// 为什么有它：真机检查里最常干的三件事是「看一眼界面 / 量一个几何 / 确认某个状态」，
// 而这三件都必须先解决**窗口可见 + 有焦点**（原因见 `cdp-page.mjs` 的 `bringToFront` 注释：
// 不可见 → 所有元素 0 几何；没焦点 → 截图可能是上一帧）。
// 以前每查一次都要手搓一个临时脚本（P4.5 b 期一轮就搓了四个），这里把它固化下来。
//
// 用法：
//   npm run peek -- "document.title"
//   npm run peek -- --probe "JSON.stringify(P.qa('.kbw-sect').map(s => Math.round(s.getBoundingClientRect().width)))"
//   npm run peek -- --shot tests/.tmp/probe/peek.png --probe "(async () => { await P.wait(300); return 'ok'; })()"
//
// ⚠️ 红线：只接**实验库**那个页（`connectSandbox` 逐页问它开着哪个库）。这条命令能执行任意表达式 ——
//    连到真库页上就等于给真库开了个写入口。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bringToFront, cdpEval, connectSandbox } from './cdp-page.mjs';
import { HELPERS } from './probe-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
let shot = '';
let clip = '';
let withProbe = false;
let file = '';
let wheel = '';
let scroll = '';
let ghost = false;
let reload = false;
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--shot') {
    shot = argv[i + 1] ?? '';
    i += 1;
  } else if (argv[i] === '--file') {
    file = argv[i + 1] ?? '';
    i += 1;
  } else if (argv[i] === '--wheel') {
    wheel = argv[i + 1] ?? '';
    i += 1;
  } else if (argv[i] === '--scroll') {
    scroll = argv[i + 1] ?? '';
    i += 1;
  } else if (argv[i] === '--clip') {
    clip = argv[i + 1] ?? '';
    i += 1;
  } else if (argv[i] === '--ghost') {
    ghost = true;
  } else if (argv[i] === '--reload') {
    reload = true;
  } else if (argv[i] === '--probe') {
    withProbe = true;
  } else {
    rest.push(argv[i]);
  }
}
/**
 * ⚠️ 多行的表达式**走 `--file`**：命令行里那段会被 shell / npm 折成一行，
 * 长一点的表达式就容易截断（本轮实测：一坨 20 行的诊断表达式在页面上报 `Unexpected end of input`）。
 *   npm run peek -- --probe --file tests/.tmp/diag.js
 */
const expr = file
  ? (await import('node:fs')).readFileSync(path.isAbsolute(file) ? file : path.resolve(ROOT, file), 'utf8')
  : rest.join(' ');
if (!expr) {
  console.error('用法：npm run peek -- [--probe] [--shot <文件>] [--file <表达式文件>] "<表达式>"');
  process.exit(1);
}

let cdp;
try {
  cdp = await connectSandbox({ what: 'peek 求值' });
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

try {
  /**
   * **隐身模式**（`--ghost`）：**不碰你的窗口**，也不要求它可见/有焦点。
   * 做法是 CDP 的 `Emulation.setDeviceMetricsOverride` —— 在渲染进程里**强制一个固定视口**
   * （默认 1400×900），于是：
   *   · 窗口最小化 / 被遮住时**照样有真实布局**（否则 Chromium 给所有元素 0 几何）；
   *   · 不抢焦点、不把窗口弹到前台（你可以在旁边干别的）；
   *   · 顺带**尺寸确定** —— 每次都是同一个视口，几何判据不会因为"这次窗口多宽"而漂。
   * 代价：量到的是**模拟视口**下的结果（不是你屏幕上那个窗口），截图也走渲染器侧（`fromSurface: false`）。
   * 要"用户此刻看到的样子"就别加 `--ghost`（那时才需要窗口真的可见）。
   */
  const state = await bringToFront(cdp); // 最小化的窗口叫不回来（CDP 没有窗口状态域）
  /**
   * ⚠️ 窗口不可见就**自动走模拟视口**（与探针开跑前那条守卫同一口径）：
   * 最小化时 Chromium 给所有元素 0 几何，量什么都是 0（假绿/假红）。
   * 用户 2026-09-25 明确要"最小化也能验证" —— 所以这里不再报错劝人还原窗口。
   */
  if (!state.visible && !ghost) {
    console.error('⚠️ 窗口不可见 → 自动切**模拟视口 1400×900**（不碰你的窗口）');
    ghost = true;
  }
  if (ghost) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 900));
  }
  if (!state.visible && !ghost) {
    console.error(
      '✗ 窗口不是可见状态 —— 此时**所有元素几何都是 0**（量出来全是 0，别当成真的）。',
    );
    console.error('  要么把窗口还原到前台，要么加 --ghost（隐身模式，不动你的窗口）。');
    process.exit(1);
  }
  if (!state.focused && !ghost) {
    console.error('⚠️ 窗口没有焦点：几何仍然有效，但**截图可能是上一帧**（已开焦点模拟）');
  }

  if (withProbe) await cdpEval(cdp, HELPERS);

  /**
   * `--reload`：**先重载插件**再量。
   * ⚠️ 少这一步会白量：`npm run deploy:sandbox` 只换磁盘上的 `styles.css` / `main.js`，
   * **页面里那份样式表还是旧的**（插件不重载就不会重新读）—— 本轮实测踩过：
   * 改完 CSS、量出来和修之前一模一样，差点当成"修了没用"。
   * 规矩：**改完源码 → deploy → peek --reload → 再量**。
   */
  if (reload) {
    await cdpEval(
      cdp,
      `(async () => {
        await app.plugins.disablePlugin('kb-workbench');
        await new Promise((r) => setTimeout(r, 400));
        await app.plugins.enablePlugin('kb-workbench');
        await new Promise((r) => setTimeout(r, 1200));
        return 'reloaded';
      })()`,
    );
    console.log('♻️ 插件已重载（页面里的样式/代码是新构建了）');
  }

  /**
   * `--wheel x,y,deltaY[,x2,y2,dy2…]`：派**真滚轮**（`Input.dispatchMouseEvent` 的 mouseWheel）。
   * ⚠️ 这一步非有不可：JS 里 `dispatchEvent(new WheelEvent(...))` **不会真的滚动**
   *（滚动是合成器干的，合成事件进不了那条路）—— 于是"滚轮到底滚没滚"这类问题
   * 在页面里自测**永远测不出来**（用户报的"列形态下滚不动"正是这一类）。
   */
  if (wheel) {
    const nums = wheel.split(',').map((x) => Number(x.trim()));
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const [x, y, dy] = [nums[i], nums[i + 1], nums[i + 2]];
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: dy,
        button: 'none',
      });
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  /**
   * `--scroll x,y,dy[,x2,y2,dy2…]`：派**真的滚动**（`Input.synthesizeScrollGesture`）。
   *
   * 🔴 与 `--wheel` 的分工必须分清（2026-09-25 实测踩过）：
   *   · `--wheel` 走 `Input.dispatchMouseEvent(mouseWheel)` —— **只派事件、不产生滚动**！
   *     于是"事件到了、没人 preventDefault、可 scrollTop 还是 0"这种读数**是我的工具失真**，
   *     不是产品 bug（我差点据此去改代码）。
   *   · `--scroll` 走合成手势，**真的会让最近的滚动容器滚** —— 验"滚轮到底滚没滚"必须用它。
   * 一句话：**测处理器用 --wheel，测滚动用 --scroll**。
   */
  if (scroll) {
    const nums = scroll.split(',').map((x) => Number(x.trim()));
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const [x, y, dy] = [nums[i], nums[i + 1], nums[i + 2]];
      await cdp.send('Input.synthesizeScrollGesture', {
        x,
        y,
        xDistance: 0,
        yDistance: -dy, // CDP 的 yDistance：**正数向上滚**，所以往下滚要取负
        gestureSourceType: 'mouse',
        speed: 1200,
      });
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const value = await cdpEval(cdp, expr, { timeoutMs: 60000 });
  if (value !== undefined) {
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }

  if (shot) {
    const file = path.isAbsolute(shot) ? shot : path.join(ROOT, shot);
    try {
      // 隐身模式走**渲染器侧**截图（`fromSurface: false`）
      const opts = { format: 'png', fromSurface: !ghost };
      /**
       * `--clip x,y,w,h`：只截一块（设计审查用 —— 一个放大的局部比整屏更容易看清
       * 对齐/间距/字重，也省 token）。坐标是 **CSS 像素**（与 `getBoundingClientRect` 同一套口径），
       * 倍数用 `KBW_CLIP_SCALE`（默认 2）。
       */
      if (clip) {
        const n = clip.split(',').map((v) => Number(String(v).trim()));
        if (n.length === 4 && n.every((v) => Number.isFinite(v))) {
          opts.clip = { x: n[0], y: n[1], width: n[2], height: n[3], scale: Number(process.env.KBW_CLIP_SCALE ?? 2) };
        } else {
          console.error(`⚠️ --clip 参数看不懂（要 x,y,w,h）：${clip}`);
        }
      }
      const r = await cdp.send('Page.captureScreenshot', opts, 20000);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log(`📷 ${path.relative(ROOT, file)}`);
    } catch (e) {
      /**
       * ⚠️ 最小化/被遮住时**截图就是拿不到**（实测：`fromSurface:false` 也一样等不到帧）。
       * 这是已知边界，不是 bug —— 所以给一句能直接照做的话，别让人对着超时猜。
       */
      console.error(`✗ 截图没拿到：${e?.message ?? e}`);
      if (!state.visible) {
        console.error(
          '  窗口最小化/被遮住时 Chromium 不出帧 → 截图拿不到（几何与输入不受影响）。',
        );
        console.error('  要截图：把 Obsidian 点开，或 `KBW_LAUNCH_MIN=0 npm run probe:launch` 起一个可见的窗口。');
      }
    }
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  /**
   * ⚠️ **用完必须把模拟视口撤掉**（2026-09-25 实测踩到）：`setDeviceMetricsOverride` 是**贴在 target 上**的，
   * 不撤就会残留给**下一个连上来的脚本** —— 症状是"探针那一轮里无关的步骤开始红"
   * （真机实测："全部笔记"那屏的默认列数 3≠8、行高 26≠31 —— 因为布局还是 1400×900 的）。
   * 与"每步自己把状态拨回基线"同一条纪律。
   */
  if (ghost) {
    try {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, 5000);
    } catch {
      /* 清不掉就算了（下一轮探针开跑时也会自己清） */
    }
  }
  cdp.close();
}
