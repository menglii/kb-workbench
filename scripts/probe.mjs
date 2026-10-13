// 真机探针：通过 CDP 接进 Obsidian 的渲染进程，在里面**真的点、真的读样式、真的截图**
//
// 为什么需要它：离线验收台（jsdom）验不了三件事 ——
//   ① 主题变量的实际解析（":root" 挂错层级这种错，jsdom 永远抓不到）
//   ② 真实排版与观感（靠截屏 + getComputedStyle）
//   ③ 真实调用链里有没有未捕获异常（靠 CDP 的 console / exception 事件）
//
// 前置：Obsidian 必须带 "--remote-debugging-port=<PORT>" 启动
//   ⚠️ Obsidian 是单实例应用 —— 先完全退出，再带参数启动，否则参数会被忽略
//
// 用法：
//   npm run probe                     # 接上、跑全套、存截图
//   npm run probe -- --only 样式        # 只跑名字含「样式」的那几步（调一条时省时间）
//   KBW_CDP_PORT=9333 npm run probe   # 换端口
//
// 🔴 红线：脚本**只在实验库上跑** —— 选页用 "vault-guard.assertWritableSandbox"
//    （正反双判：既"像实验库"又"不是真库"），红线那一步不过就**整轮中止**。
//    它到底写什么（别按"只动一个临时笔记"评估风险）：探针自造的临时笔记（用完删）
//    · 那些操作产生的**快照目录**与**库内操作日志**（自清理按 id/标记删，只删自己造的）
//    · 危险态那一步会经平台把自造文件移进 ".trash"
//    · 插件 "data.json" 的界面偏好（"goNotes" 写 currentModule、界面偏好防抖落盘）
//    ⇒ **跑探针时别同时在实验库里手动动库**（自清理只认自己造的，但你手造的会被写进基线之外）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWritableSandbox } from './vault-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tests', '.tmp', 'probe');
const PORT = Number(process.env.KBW_CDP_PORT ?? 9222);
const BASE = `http://127.0.0.1:${PORT}`;
// ⚠️ 用 "||" 不用 "??"：空串会落回默认值，而 "'任何路径'.includes('') === true"
//    —— 那等于用一句环境变量把红线关掉（P0 记过一次，P1 的独立审查发现这行当时没真改）
const VAULT_MUST_INCLUDE = process.env.KBW_VAULT_MUST_INCLUDE || 'sandbox-vault';

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ── CDP 客户端（Node 24 自带 WebSocket，零依赖）─────────────────
class Cdp {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error(`WebSocket 连不上：${e?.message ?? e}`)), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  /** 在页面里求值。表达式应当是 "(async () => {…})()" 这种形态 */
  async eval(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
    const r = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
        allowUnsafeEvalBlockedByCSP: false,
      },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = d.exception?.description ?? d.text ?? '未知异常';
      throw new Error(desc.split('\n').slice(0, 3).join('\n'));
    }
    return r.result?.value;
  }

  /**
   * 截图。"fromSurface: false" = **渲染器侧**出图（不经合成器）。
   *
   * 🔴 窗口最小化/被遮住时**必须**用它（2026-09-25 实测）：那种状态下合成器不产帧，
   * "fromSurface: true"（默认）会**等 60 秒然后超时**，而且**时好时坏**（上一张成功、下一张挂住），
   * 一挂就把整轮探针带崩（"Page.captureScreenshot" 的 CDP 超时是抛异常 ✗）。
   */
  async screenshot(file, { fromSurface = true, timeoutMs = 20000 } = {}) {
    const r = await this.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false, fromSurface },
      timeoutMs,
    );
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

// ── 注入页面的探针小工具 ────────────────────────────────────────
// ⚠️ 必须用 String.raw：这段是"字符串里的代码"，里面有正则；
// 普通模板字符串会把 "\(" 里的反斜杠吃掉 → 正则静默变味（真踩过：对比度算出 NaN）
import { HELPERS } from './probe-helpers.mjs';
import { FINGERPRINT_RE, MARK, computeFingerprint } from './build-fingerprint.mjs';
import { bringToFront } from './cdp-page.mjs';
import { getObsidianWindow, maximizeObsidian } from './win-window.mjs';

/**
 * **工作区源码指纹**（P7.20-9）—— 跟构建写进 `main.js` 的那个**用同一份实现**算出来，
 * 好让"环境"那条红线步能自证：**真机上跑的实例就是这份源码构建的**。
 * 算一次（146 个 .ts，几毫秒），全轮用同一个值。
 * ⚠️ 见 `build-fingerprint.mjs` 的文件头：它**只覆盖 src/**，不管 styles/。
 */
const WORKSPACE_FP = computeFingerprint(ROOT).fp;

// ── 探针步骤 ────────────────────────────────────────────────────
/** 每步返回 {ok, info}；ok=false 记为失败但继续跑后面的 */
/**
 * 步骤形状："{ name, setup?, script?, shot?, before?, after? }"
 *  · "setup: true" → "--only" 时也一定先跑（视图没打开的话单步必然失败）
 *  · "script" 返回 "{ok, info}"；"shot" 是截图文件名
 */
/**
 * 真机步骤表。**导出给离线红线用**（"tests/specs/redline.ts" 会逐条把 "script" 编译一遍：
 * 模板字符串里混进反引号、或者被脚本处理截断，"node --check" 看不出来，真机才炸）。
 */
/**
 * ── 功能域（P7.20-6）─────────────────────────────────────────────
 *
 * 「域档」= **第三档**。冒烟档挑的是"跨轮共享链的哨兵"（~20 步），全量是 158 步 ——
 * 中间缺一档："我只改了看板，想只跑看板那些步"。
 *
 * 归类口径：**显式 `step.domain` 优先**；没写的按下面这张**名字规则表**推。
 * 为什么不做成"158 步逐个加标签"：收益/风险不成比例；表是**一处、可审**的。
 * ⚠️ 名字规则**只管归类**，不参与判据 —— 归错了最多是"这一步被多跑/少跑一次"，
 *    不会让任何判据变假绿（`--domain` 的选取自证见 `DOMAIN_ARG`）。
 * ⚠️ 表是**有序**的（先匹配到的赢），所以"看板/拖动"这类要排在前面。
 *   （`P4 · 看板：跨板块拖动` 名字里同时有"看板"和"搬"，靠顺序落到 `board`。）
 */
export const DOMAIN_RULES = [
  ['board', /看板|卡片|板块|悬浮小窗|拖动/],
  ['graph', /图谱|graph/i],
  ['ai', /AI|✦|MOC|起标题|自动命名|美化|整理建议/],
  ['property', /属性|前言|元数据|迁移|旧规范|标签|必填/],
  ['write-path', /移动|重命名|新建|删除|清理|归位|收拢|快照|撤销|自动整理|待处理/],
  ['panel', /面板|设置|菜单|向导|快捷键|通知|确认流|模态|右键/],
  ['shell', /挂载|骨架|布局|容器|主题|对比度|可读性|图标|样式|索引|库框架/],
];

/** 某一步属于哪个域（显式 `domain` 优先，否则按名字规则；都不中 → `misc`） */
export function domainOf(step) {
  if (step.domain) return step.domain;
  for (const [name, re] of DOMAIN_RULES) if (re.test(step.name)) return name;
  return 'misc';
}

export const STEPS = [
  {
    setup: true,
    name: '重载插件（确保跑的是最新构建）',
    script: `(async () => {
      const P = window.__kbwProbe;
      if (!P.plugin()) return { ok: false, info: '插件本来就没加载' };
      await app.plugins.disablePlugin('kb-workbench');
      await P.wait(400);
      await app.plugins.enablePlugin('kb-workbench');
      await P.wait(900);
      const again = P.plugin();
      // 重载不许在 body 上留孤儿 DOM（P-1 就吃过"卸载不干净"的亏）
      const orphan = ['.kbw-notices', '.kbw-menu', '.kbw-modal', '.kbw-panel', '.kbw-backdrop']
        .map((sel) => sel + '×' + document.querySelectorAll(sel).length)
        .filter((x) => !x.endsWith('×0'));
      /**
       * **开工基线：首入讲解浮层先标"看过"**（P7.10 · #8 新增）。
       * 为什么必须在基线上种：它是「openFloating」的真实浮层，会罩在「全部笔记」列表上 ——
       * 后面大量步骤用 **真鼠标坐标**（「P.rightClickAt」等走 elementFromPoint），
       * 浮层一罩就点空（本轮 P7.1c · 2.7「移动到」当场红：重开的右键全落在浮层上）。
       * 真行为由专步「P7.10 · #8 首入讲解」演 —— 它自己置 false → 弹 → 关。
       *
       * ⚠️ **跑完一轮，这面旗会留在 true**（独立审 🟡4 实测定性）：#8 步还原的是
       * "它开跑时的值"（= 基线种的 true，步内对称——与其余步骤同纪律）；而若中途把
       * false 还回去，后续任何一步进「全部笔记」都会**重新武装浮层**、再被乱 Esc 关掉
       * 又写回 true（试过，守不住）。**用户在实验库想重看首入卡**：
       * 把 data.json 的 notesIntroSeen 删掉、或改成 false（本会话收尾也人工归过一次）。
       */
      await P.ctx().settings.save({ notesIntroSeen: true });
      /**
       * 🔴 **基线卫生：把 treeOpen 里的 __探针* 条目清掉**（P7.15 收尾抓到的一族）。
       *
       * 为什么必须有：treeOpen 是**落盘的展开记忆** —— 探针某一步展开过 __探针网格A，
       * 收尾把**目录**删了，可是**配置里那条记忆还在**。#2 之后空目录也进树，于是这些
       * 记忆条目在新一轮里**把已经不存在的节点记成"该展开"**……更糟的是它会让
       * 树节点数随"历史跑过多少轮探针"**单调涨**（每轮留几条、永不回收）——
       * 症状 = P1「树节点数」与 P7.1「本层文件夹行」这些**看起来毫不相干**的步骤
       * 逐轮变红（2026-10-08 实测：连跑五轮之后 P1 的 6 列口径、2.2 的文件夹行全掉）。
       * 与"notesIntroSeen 基线"同一条纪律：**探针跑完不许给下一轮留持久状态**。
       */
      try {
        const st = P.ctx().settings.get();
        const all = st.treeOpen || [];
        const kept = all.filter(function (d) { return String(d).indexOf('__探针') < 0; });
        /* P7.24 · T2：根也是普通节点（'' = 库根）—— 基线固定"根开"。
           不清 __探针 的记忆条清完可能连 '' 一起没了（= 根收起）→ 后续找树的步全塌；
           反过来，上一轮谁把根收着走的，这里也顺手扶直（探针要的是确定起点）。 */
        /* ⚠️ 判定用**显式 changed 旗**、别比长度（独立审 🟡4）：恰 1 条 __探针 记忆 + 根被
           收着时，"滤掉 1 条"和"补 1 条 ''"长度正好抵消 → 旧版不比不保存 → 根保持收起、
           记忆留盘，后续树相关步成片红（红得莫名）。 */
        let changed = kept.length !== all.length;
        if (kept.indexOf('') < 0) {
          kept.push('');
          changed = true;
        }
        if (changed) {
          await P.ctx().settings.save({ treeOpen: kept });
          await P.wait(300);
        }
      } catch (e) { /* 卫生，不是断言 */ }
      await P.wait(300);
      return {
        ok: !!again && orphan.length === 0,
        info: (again ? '已重载 ' + again.manifest.version : '重载后不见了') +
              '｜孤儿 DOM=' + (orphan.length ? orphan.join(' ') : '无') +
              '｜基线：notesIntroSeen=true（防浮层罩真鼠标步）+ treeOpen 清 __探针 记忆（保根开）',
      };
    })()`,
  },
  {
    setup: true,
    guard: true, // ⚠️ 这一步不过就**整轮中止**（红线的实际强度全在这里）
    name: '环境：库是实验库 + 插件已加载',
    script: `(async () => {
      const P = window.__kbwProbe;
      const root = P.vaultRoot();
      if (!root.includes(${JSON.stringify(VAULT_MUST_INCLUDE)})) {
        return { ok: false, info: '当前库不是实验库，红线拦住：' + root };
      }
      const plugin = P.plugin();
      if (!plugin) return { ok: false, info: '插件没加载（kb-workbench 不在 app.plugins.plugins 里）' };
      /**
       * ── **构建指纹自证**（P7.20-9）──────────────────────────────
       * 读**库内那份** main.js（探针的"重载插件"读的就是它），抠出构建时写进 banner 的
       * 源码指纹，跟工作区源码指纹比 —— 比不齐就**当场红 + 整轮中止**（这一步是 guard）。
       *
       * 为什么必须红而不是"提醒一句"：这是**假绿**的一种 —— 数字全绿、被测的是旧代码。
       * 本项目对这类"看着通过了其实没测到"的态度一贯是"当场拦住"。
       * ⚠️ 它就是本步的判据，**不做降级**：读不到 / 没有标记 / 不一致，一律 false。
       *    这条链上任何一环"宽一下"，整条检查就回到"看着绿"。
       */
      const S = ' ｜';
      let fpInfo;
      let fpOk;
      try {
        const text = await app.vault.adapter.read(app.vault.configDir + '/plugins/kb-workbench/main.js');
        const pageFp = (new RegExp(${JSON.stringify(FINGERPRINT_RE.source)}).exec(text) || [])[1] || '';
        const want = ${JSON.stringify(WORKSPACE_FP)};
        if (!pageFp) {
          fpOk = false;
          fpInfo = '库内 main.js 里没有「${MARK}」标记（旧构建，或产物被手改过）→ 先 npm run sandbox（build + deploy + reload）';
        } else if (pageFp !== want) {
          fpOk = false;
          fpInfo = '库内=' + pageFp + ' ≠ 工作区源码=' + want + ' → 库里跑的不是这份源码；先 npm run sandbox';
        } else {
          fpOk = true;
          fpInfo = '构建指纹 ' + want + ' ✓（库内联产物 = 当前源码）';
        }
      } catch (e) {
        fpOk = false;
        fpInfo = '读库内 main.js 失败：' + (e?.message ?? e);
      }
      const ctx = P.ctx();
      return {
        ok: fpOk,
        info: '库=' + root + S + '插件版本=' + (plugin.manifest?.version ?? '?') + S +
              '索引=' + ctx.index.getAll().length + ' 篇' + S + fpInfo,
      };
    })()`,
  },
  {
    setup: true,
    name: '打开工作台（命令入口）',
    script: `(async () => {
      const P = window.__kbwProbe;
      /**
       * 窗口太小就先放大（**只在小于 1400×900 时**动）。
       * 为什么必须做：工作台窄到 <640px 就是"窄档"，**目录树会被 CSS 藏起来** ——
       * 依赖"拖到树节点"的步骤拿到的目标尺寸是 0、指针落在窗口左上角，
       * 于是拖拽步骤假红（真机实测：窗口 806px 时连红两轮）。
       * 影响面：会改变 Obsidian 窗口大小（探针是开发工具，跑之前心里有数）。
       */
      const before = [window.innerWidth, window.innerHeight];
      let resized = false;
      if (before[0] < 1400 || before[1] < 900) {
        try {
          window.resizeTo(Math.max(1400, before[0]), Math.max(900, before[1]));
          await P.wait(700);
          resized = true;
        } catch (e) { /* 不让改就算了 */ }
      }
      const cmdOk = await app.commands.executeCommandById('kb-workbench:open');
      await P.wait(700);
      /**
       * 工作台被别的标签页挤窄了就先清场（**只在真的窄的时候**动）。
       * 为什么必须做：窄档（<640px）下目录树被 CSS 藏起来 → 依赖"拖到树节点"的步骤
       * 拿到的目标尺寸是 0，指针落在窗口左上角（真机实测：拖拽步骤因此假红了两轮）。
       * 影响面：**只关主区里的 markdown 标签页**（实验库里的笔记），侧栏不动；
       * 已经在跑探针的库上，别指望自己的笔记标签页还开着。
       */
      let wb = app.workspace.getLeavesOfType('kb-workbench-view')[0];
      let swept = 0;
      if (wb && wb.view?.containerEl?.clientWidth < 900) {
        for (const l of app.workspace.getLeavesOfType('markdown')) {
          l.detach();
          swept += 1;
        }
        await app.workspace.revealLeaf(wb);
        await P.wait(500);
        wb = app.workspace.getLeavesOfType('kb-workbench-view')[0];
      }
      const root = P.q('.kbw-root');
      const leaves = app.workspace.getLeavesOfType('kb-workbench-view').length;
      const allLeaves = app.workspace.getLeavesOfType('kb-workbench-view').map((l) => l.view?.getViewType?.() ?? '(无视图)');
      if (!root) {
        return { ok: false, info: '没挂上 .kbw-root｜命令返回=' + cmdOk + '｜工作台叶子=' + leaves + ' ' + JSON.stringify(allLeaves) +
          '｜注册的命令=' + JSON.stringify(Object.keys(app.commands.commands ?? {}).filter((k) => k.startsWith('kb-workbench'))) +
          '｜叶子总数=' + app.workspace.getLeavesOfType('markdown').length + '/' + (app.workspace.activeLeaf?.view?.getViewType?.() ?? '?') };
      }
      const nav = P.qa('.kbw-navitem');
      const foot = P.qa('.kbw-navfoot-row');
      const width = wb ? Math.round(wb.view.containerEl.clientWidth) : -1;
      return { ok: nav.length === 4 && foot.length === 3, info: '导航 ' + nav.length + ' 项 / 状态 ' + foot.length + ' 行｜标题=' + P.text(P.q('.kbw-topbar h2')) + '｜命令返回=' + cmdOk + '｜工作台宽=' + width + (resized ? '（窗口 ' + before.join('×') + ' → ' + window.innerWidth + '×' + window.innerHeight + '）' : '') + (swept > 0 ? '（清掉了 ' + swept + ' 个挤窄它的标签页）' : '') };
    })()`,
  },
  {
    name: '索引与真实库一致（跨源核对）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kbRoot = ctx.settings.kbRoot();
      const onDisk = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(kbRoot + '/') && !f.path.split('/').some((s) => s.startsWith('.'))).length;
      const idx = ctx.index.getAll().length;
      const flags = ctx.index.flagCounts();
      return { ok: idx === onDisk, info: '索引 ' + idx + ' 篇 / 库里 ' + onDisk + ' 篇｜标记 ' + JSON.stringify(flags) };
    })()`,
  },
  {
    name: '样式：弹出层不透明 + 主题变量别名真的解析（真机才验得出）',
    script: `(async () => {
      const P = window.__kbwProbe;
      P.ctx().goNotes();
      await P.wait(600);
      /**
       * ⚠️ **P6b ② 起两条口径都变了**，这一步要的"有行的表格"得自己摆出来：
       *  ① 视图档是**落盘**的 —— 上一轮若停在网格档，表格行（.kbw-trow）一个都不会有；
       *  ② 列表**只画本层** —— 库根那一层常常一篇都没有。
       */
      await P.useView('详细信息');
      // P7.0b / 14.8a：返回空串 = "没有'本层有笔记 **且** 盘上真有'的目录" —— 视野没摆好，别静默往下走
      const seeded = await P.enterDirWithNotes();
      if (!seeded) return { ok: false, info: 'enterDirWithNotes 一个可用目录都没找到（本层有笔记且盘上真有）—— 这条判据的前提不成立' };
      const row = P.q('.kbw-trow');
      if (!row) return { ok: false, info: '表格里没有行（视图档/目录没摆对？）' };
      // ① 别名解析（P0 真机第一轮"菜单透明"就是这个挂错层级）：
      //    造一个探针元素直接吃 var(--surface-1) —— 无效值会算成 rgba(0,0,0,0)
      const probe = document.createElement('div');
      probe.style.background = 'var(--surface-1)';
      probe.style.boxShadow = 'var(--kbw-shadow-2)';
      document.body.appendChild(probe);
      const resolvedBg = getComputedStyle(probe).backgroundColor;
      const resolvedShadow = getComputedStyle(probe).boxShadow;
      probe.remove();
      // ② 右键真菜单
      const c = P.center(row);
      P.rightClickAt(c.x, c.y);
      await P.wait(350);
      const menu = P.q('.kbw-menu');
      if (!menu) return { ok: false, info: '右键没弹出菜单' };
      const st = P.styleOf('.kbw-menu');
      const a = P.alpha(st.background);
      P.key('Escape');
      await P.wait(200);
      // ③ 选中行的底：P1 新样式用了 color-mix，真机解析要能出非透明色
      P.click(row);
      await P.wait(250);
      const sel = P.q('.kbw-trow.is-selected');
      const selBg = sel ? getComputedStyle(sel).backgroundColor : '';
      const selA = sel ? P.alpha(selBg) : -1;
      return {
        ok: a > 0.9 && P.alpha(resolvedBg) > 0.9 && resolvedShadow !== 'none' && selA > 0.05,
        info: '菜单底=' + st.background + '（alpha=' + a + '）｜--surface-1 解析=' + resolvedBg +
              '（alpha=' + P.alpha(resolvedBg) + '）｜--kbw-shadow-2=' + resolvedShadow.slice(0, 32) +
              '｜选中行底=' + selBg + '（alpha=' + selA + '，color-mix 生效）',
      };
    })()`,
  },
  {
    name: '布局：容器宽度档位 + 导航是否显示文字',
    script: `(async () => {
      const P = window.__kbwProbe;
      const root = P.q('.kbw-root');
      const label = P.q('.kbw-navitem-label');
      const cs = label ? getComputedStyle(label) : null;
      const w = root ? root.clientWidth : -1;
      // 档位要**算出来比**，不能只打印（否则永远 wide 也绿）
      const expect = w <= 0 ? '?' : w < 640 ? 'narrow' : w < 900 ? 'mid' : 'wide';
      const actual = root?.getAttribute('data-w') ?? '?';
      const labelBox = (label && label.getBoundingClientRect && label.getBoundingClientRect()) || { width: 0 };
      return {
        ok: actual === expect && !!cs && cs.display !== 'none' && cs.visibility !== 'hidden' &&
            Number(cs.opacity) > 0 && labelBox.width > 0,
        info: '容器宽=' + w + 'px｜data-w=' + actual + '（期望 ' + expect + '）' +
              '｜导航文字 display=' + (cs?.display ?? '找不到标签元素') + ' 宽=' + Math.round(labelBox.width) +
              '｜叶子宽=' + Math.round(P.q('.workspace-leaf-content')?.getBoundingClientRect().width ?? -1),
      };
    })()`,
  },
  {
    name: '可读性：通知/菜单/模态的文字对比度 ≥ 4.5:1',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      ctx.notYet('P9', '对比度自检');
      await P.wait(400);
      const n = P.q('.kbw-notice');
      if (!n) return { ok: false, info: '通知没弹出来' };
      const cs = getComputedStyle(n);
      const txt = getComputedStyle(n.querySelector('.kbw-notice-text'));
      const ratio = P.contrast(txt.color, cs.backgroundColor);
      return {
        ok: ratio >= 4.5,
        info: '通知：' + txt.color + ' on ' + cs.backgroundColor + ' → 对比度 ' + ratio + ':1' +
              '（主题 ' + (document.body.className.match(/theme-\\w+/) || ['?'])[0] + '）',
      };
    })()`,
  },
  {
    name: '截图：通知条（顶部落点 + 配色）',
    shot: '03-notice.png',
    async before(cdp) {
      await cdp.eval(`(async () => { const P = window.__kbwProbe; P.ctx().notYet('P9', '通知截图'); await P.wait(300); return true; })()`);
    },
  },
  {
    name: '截图：菜单展开态（右键一行）',
    shot: '01-menu.png',
    async before(cdp) {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        P.ctx().goNotes();
        await P.wait(500);
        /**
         * ⚠️ **视野要自己摆**（P7.1b）：视图档是落盘的、目录树选择也可能停在库根 ——
         * 而 2.8 起**库根这一层没有笔记行**（不再平铺），.kbw-trow 会是空的 →
         * 右键那一发落空 → 截到的图里没有菜单（截图步"静默降级"的老形态）。
         */
        await P.useView('详细信息');
        /**
         * ⚠️ **返回空串 = 视野没摆好**（helper 的契约）——截图步没有 note 通道，
         * 但也不许**静默降级**（独立审查 🟡5）：找不到可进的目录时把话说出来，
         * 免得下一次从"这张图的列表怎么是空的"这个谜面查起。
         */
        const seeded = await P.enterDirWithNotes();
        if (!seeded) console.error('[探针] 01-menu 截图：没找到"本层有笔记且盘上真有"的目录 —— 这张图会拍到空列表');
        await P.wait(400);
        const row = P.q('.kbw-trow');
        if (row) { const c = P.center(row); P.rightClickAt(c.x, c.y); }
        await P.wait(400);
        return true;
      })()`);
    },
    async after(cdp) {
      await cdp.eval(`window.__kbwProbe.key('Escape'), true`);
    },
  },
  {
    name: '确认流：批量迁移 → 模态不透明 → 取消后一个文件都没动',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const before = ctx.index.getAll().length;
      ctx.goNotes({ dir: '00_Inbox' });
      await P.wait(600);
      await P.useView('详细信息');
      await P.wait(300);
      if (!P.clickByText('全选', P.q('.kbw-notes-bar'))) {
        const row = P.q('.kbw-trow');
        if (!row) return { ok: false, info: 'Inbox 里没有笔记可用' };
        P.click(row);
        await P.wait(250);
      }
      if (!P.clickByText('迁移', P.q('.kbw-notes-bar'))) return { ok: false, info: '找不到「迁移」' };
      await P.wait(350);
      // 菜单是树形的：展开第一个带子菜单的分组，再找「移到「X」」
      const group = P.qa('.kbw-menu-item').find((i) => i.getAttribute('aria-haspopup') === 'true');
      if (!group) return { ok: false, info: '迁移菜单里没有可展开的分组' };
      P.click(group);
      await P.wait(300);
      let pick = P.qa('.kbw-menu-item').find((i) => P.text(i).includes('移到「'));
      if (!pick) {
        const g2 = P.qa('.kbw-menu-item').find((i) => i.getAttribute('aria-haspopup') === 'true');
        if (g2) { P.click(g2); await P.wait(300); pick = P.qa('.kbw-menu-item').find((i) => P.text(i).includes('移到「')); }
      }
      if (!pick) return { ok: false, info: '没找到「移到「目录」」那一项' };
      P.click(pick);
      await P.wait(450);
      const modal = P.q('.kbw-modal');
      if (!modal) return { ok: false, info: '确认流没弹出来' };
      const st = P.styleOf('.kbw-modal');
      const a = P.alpha(st.background);
      const title = P.text(modal.querySelector('.kbw-modal-title') ?? modal).slice(0, 40);
      const primary = Array.from(modal.querySelectorAll('.kbw-btn')).find((b) => (b.textContent ?? '').includes('移动'));
      const hasTitle = /即将移动 \\d+ 篇/.test(P.text(modal));
      const hasPreview = modal.querySelectorAll('.kbw-confirm-preview > *').length > 0;
      // 取消（Esc）→ 一个文件都不该动
      P.key('Escape');
      await P.wait(400);
      const after = ctx.index.getAll().length;
      const closed = !P.q('.kbw-modal');
      return {
        ok: a > 0.9 && hasTitle && hasPreview && !!primary && closed && after === before,
        info: '模态底=' + st.background + '（alpha=' + a + '）｜标题带数量=' + hasTitle + '｜预览行=' + hasPreview +
              '｜主按钮=' + (primary?.textContent ?? '无') + '｜Esc 关掉=' + closed + '｜条目数 ' + before + '→' + after + '（取消不该动手）',
      };
    })()`,
  },
  {
    name: '危险态：删除探针自造的临时笔记（第一下上膛 / 第二下执行 / 撤销条能找回 · 对比度两主题 ≥4.5）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      const kb = ctx.settings.kbRoot();
      const rel = kb + '/00_Inbox/__探针危险态.md';
      const old = app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(rel, '---\\n类型: 想法\\n领域: 灵感杂记\\n状态: 进行中\\n创建日期: 2026-09-24\\ntags: []\\n---\\n# 探针危险态\\n');
      await P.wait(900);

      ctx.goNotes({ dir: '00_Inbox' });
      await P.wait(600);
      await P.useView('详细信息');
      await P.wait(300);
      const row = P.rowByPath(rel);
      if (!row) return { ok: false, info: '临时笔记没进表格：' + rel };
      P.click(row);
      await P.wait(250);
      if (!P.clickByText('更多', P.q('.kbw-notes-bar'))) return { ok: false, info: '找不到「更多」' };
      await P.wait(350);
      const items = P.qa('.kbw-menu-item');
      const delBtn = items.find((i) => i.classList.contains('is-danger'));
      if (!delBtn) return { ok: false, info: '「更多」菜单里没有危险项' };
      const isLast = delBtn === items[items.length - 1];
      const sepBefore = delBtn.previousElementSibling?.classList.contains('kbw-menu-sep');
      P.click(delBtn);
      await P.wait(450);
      const modal = P.q('.kbw-modal');
      const danger = modal && modal.querySelector('.kbw-btn.is-danger');
      if (!danger) return { ok: false, info: '确认流里没有危险按钮' };

      /* ── P7.7c · 10.6：危险按钮对比度（两主题各量一次；上膛那一下也量数记档）──
       * 常态口径 ≥4.5（按钮字 14px/600，不算大字号）。底色按**合成**算：
       * 按钮自己那层是 12% 淡红（alpha 0.12），bgSolid 会跳过它 —— 跟 P6⑤⑧ 徽标那步同款，
       * 把淡红层按 alpha 合到下面的实底上再量（上膛态底色是实心红，tintA=1 同一公式天然成立）。
       * ⚠️ hover 真机造不出来（见 probe-helpers 那段），hover 与上膛**同值**由离线静态断言钉住，
       * 这里量到的"上膛"数就是 hover 的数。
       */
      const ratioOf = () => {
        const cs = getComputedStyle(danger);
        const solid = P.bgSolid(danger.parentElement || danger);
        const tintRgb = P.colorRgb(cs.backgroundColor);
        const tintA = P.alphaAny(cs.backgroundColor);
        const solidRgb = P.colorRgb(solid);
        let bg = solid;
        if (tintRgb && solidRgb && tintA > 0) {
          bg = 'rgb(' + tintRgb.map(function (v, i) { return Math.round(v * tintA + solidRgb[i] * (1 - tintA)); }).join(',') + ')';
        }
        return P.contrastAny(cs.color, bg);
      };
      const theme0b = P.theme();
      const normalRatios = [];
      const armedRatios = [];
      const normalRows = [];
      const armedRows = [];
      try {
        for (const t of [['暗', 'obsidian'], ['亮', 'moonstone']]) {
          if (!P.setTheme(t[1])) { note('切不到主题 ' + t[1] + '（app.changeTheme 变了？）'); continue; }
          await P.wait(600);
          if (P.isDark() !== (t[1] === 'obsidian')) note('切到 ' + t[1] + ' 之后 body 主题类不对（这一轮量的是别的主题）');
          const r = ratioOf();
          normalRatios.push(r);
          normalRows.push(t[0] + '=' + (r === null ? '?' : r));
        }
        P.click(danger); // 第一下：上膛
        await P.wait(300);
        for (const t of [['暗', 'obsidian'], ['亮', 'moonstone']]) {
          if (!P.setTheme(t[1])) continue;
          await P.wait(600);
          const r = ratioOf();
          armedRatios.push(r);
          armedRows.push(t[0] + '=' + (r === null ? '?' : r));
        }
      } finally {
        P.setTheme(theme0b);
        await P.wait(500);
        if (P.theme() !== theme0b) note('主题没切回去：' + theme0b + ' → ' + P.theme());
      }
      const normalOk = normalRatios.length === 2 && normalRatios.every(function (r) { return r !== null && r >= 4.5; });
      if (!normalOk) note('常态对比度不足 4.5（实测 ' + normalRows.join(' / ') + '）—— 拍板形态的自适应混合没落地？');

      const armed = (danger.textContent ?? '').includes('再点一次确认');
      P.click(danger);
      await P.wait(1200);
      // 这一步会造快照（删除 + 撤销重建）→ 记下"最新那一份"的 id，收尾只删它
      const snapId = await P.snapTop();
      const gone = !app.vault.getAbstractFileByPath(rel);
      const bar = !!P.q('.kbw-undobar');
      const undoBtn = P.btnByText('撤销', P.q('.kbw-undobar'));
      if (undoBtn) {
        P.click(undoBtn);
        await P.wait(1400);
      }
      const back = !!app.vault.getAbstractFileByPath(rel);
      const content = back ? await app.vault.read(app.vault.getAbstractFileByPath(rel)) : '';
      const f = app.vault.getAbstractFileByPath(rel);
      if (f) await app.vault.delete(f, true);
      await P.wait(300);
      const swept = await P.sweep([snapId]); // 日志按 __探针 标记清
      void ctx;
      return {
        ok: armed && gone && bar && back && content.includes('探针危险态') && isLast && sepBefore && normalOk && problems.length === 0,
        info: '危险项末位=' + isLast + '/上方有分隔线=' + sepBefore + '｜第一下上膛=' + armed + '｜第二下真删=' + gone +
              '｜出撤销条=' + bar + '｜撤销后找回=' + back + '（内容完整=' + content.includes('探针危险态') + '）' +
              '｜常态对比度(判≥4.5) ' + normalRows.join(' / ') + '｜上膛对比度(记档，hover 同值) ' + armedRows.join(' / ') +
              '｜自清理：快照 -' + swept.snaps + ' / 日志 -' + swept.logs +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ''),
      };
    })()`,
  },
  {
    name: 'P1 · 全部笔记：目录树 + 表格（31px 行高实测 + 默认列数）',
    script: `(async () => {
      const P = window.__kbwProbe;
      // 上一步可能留了选中（选中时工具条整块换成批量栏）→ 先清掉再看工具条
      const root = P.q('.kbw-notes');
      if (root) { root.setAttribute('tabindex', '-1'); root.focus(); }
      P.key('Escape');
      await P.wait(250);
      P.ctx().goNotes();
      await P.wait(700);
      P.key('Escape');
      await P.wait(250);
      /**
       * ⚠️ **P6b ② 起两条口径都变了**，这一步要的"有行的表格"得自己摆出来：
       *  ① 视图档是**落盘**的 —— 上一轮若停在网格档，表格行（.kbw-trow） 一个都不会有；
       *  ② 列表**只画本层** —— 库根那一层常常一篇都没有。
       */
      await P.useView('详细信息');
      // P7.0b / 14.8a：空串 = 视野没摆好（见 enterDirWithNotes 的注释）—— 说出来，别静默
      const seeded = await P.enterDirWithNotes();
      if (!seeded) return { ok: false, info: 'enterDirWithNotes 一个可用目录都没找到（本层有笔记且盘上真有）—— 这条判据的前提不成立' };
      const tree = P.qa('.kbw-tree-item');
      const rows = P.qa('.kbw-trow');
      const ths = P.qa('.kbw-table th');
      const rowH = rows[0] ? rows[0].getBoundingClientRect().height : -1;
      const rootItem = tree[0];
      // 默认列数：check + 标记 + 名称 + 类型 + 状态 + 修改时间 = **6**
      // （v2 · P7.12：「领域」随退役出局；P7.1 起「发布进度」等专属列进默认隐藏。
      //  真机抓到过：默认隐藏没生效 → 25 列 / 3126px 宽）
      // ⚠️ 这条口径与离线 p6d 的「默认该是 6 列」同一份；运行环境里若有人手动开过列，
      //    数字会漂 —— 以"默认配置 + 未动列菜单"为前提（本步跑在开头，前提自然成立）。
      const defaultCols = ths.length;
      const inbox = P.qa('[data-drop]').find((i) => i.getAttribute('data-drop') === '00_Inbox');
      if (inbox) { P.click(inbox); await P.wait(500); }
      const scoped = P.qa('.kbw-trow').every((r) => (r.getAttribute('data-path') ?? '').includes('/00_Inbox/'));
      /**
       * P7.1 两档化：seg 只剩「详细信息 / 网格」（原「紧凑」档已删，存量 notesView 由
       * migrateSettings 在读盘时改写）。这里**只数钮、不切档** —— 这一屏的表格判据要求
       * 停在详细信息，切档了要自己拨回来（历史上漏拨把后面一串步骤带红过）。
       * 网格档 P6 起可用（不再是置灰占位）——「不可用」那条反面判据保留。
       */
      const segBtn = (label) => P.qa('.kbw-seg button').find((b) => P.text(b) === label);
      const segCount = P.qa('.kbw-seg button').length;
      const gridBtn = segBtn('网格');
      const onDetail = !!segBtn('详细信息') && segBtn('详细信息').classList.contains('is-on');
      return {
        ok: tree.length >= 5 && rows.length > 0 && defaultCols === 6 &&
            Math.abs(rowH - 31) < 1.5 && segCount === 2 && !segBtn('紧凑') &&
            scoped && !!gridBtn && !gridBtn.hasAttribute('disabled') && onDetail,
        info: '树节点=' + tree.length + '（根节点="' + P.text(rootItem) + '"）｜默认列=' + defaultCols + '（口径 6）｜行=' + rows.length +
              '｜行高=' + Math.round(rowH) + 'px（口径 31）｜seg=' + segCount + ' 钮（口径 2：详细信息/网格）' +
              '｜点 Inbox 后只剩该目录=' + scoped + '｜网格档可用=' + (!!gridBtn && !gridBtn.hasAttribute('disabled')) +
              '｜停在详细信息=' + onDetail,
      };
    })()`,
  },
  {
    /**
     * P7.1 · 表头右键（2.1/D2）。真机判据四件：
     *  ① 右键真的开在那一列上（作用域行写「列「类型」」）；
     *  ② 「隐藏这一列」：表头消失 + 内存 + **回读 data.json**（"存了像没存"是本项目最著名那类坑）；
     *  ③ 名称列：「隐藏这一列」置灰并写出原因（硬规矩：置灰而不是不画）；
     *  ④ 「打开列设置…」**就地换内容**（不关窗重开），并从它里面把「类型」勾回来（顺带还原）。
     * 收尾把 `columnsHidden` 拨回开工前的值（可能是 null —— 那是"没选过"的哨兵，照写）。
     */
    name: 'P7.1 · 表头右键：隐藏这一列（落盘后还原）· 名称列置灰 · 打开列设置就地换内容',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      ctx.goNotes();
      await P.wait(700);
      await P.useView('详细信息');
      await P.wait(300);
      const savedHidden = ctx.settings.get().columnsHidden; // 收尾要原样还回去（可能是 null）
      const thOf = (id) => P.q('.kbw-table th[data-col="' + id + '"]');
      /** 把「类型」列拨回可见（走「列」按钮那扇菜单）——失败路径和成功路径都靠它还原 */
      const restoreType = async () => {
        if (thOf('prop:类型')) return true;
        const colsBtn = P.qa('.kbw-notes-tools .kbw-btn').find((b) => P.text(b) === '列');
        if (!colsBtn) return false;
        P.click(colsBtn);
        await P.wait(350);
        P.clickAny('常用');
        await P.wait(300);
        const clicked = P.clickAny('类型');
        await P.wait(500);
        return clicked && !!thOf('prop:类型');
      };
      const bail = async (why) => {
        await restoreType();
        await P.wait(700);
        await ctx.settings.save({ columnsHidden: savedHidden });
        P.closeAll(4);
        return { ok: false, info: why };
      };
      if (!thOf('prop:类型')) return await bail('前提不成立：详细信息档下看不到「类型」列的表头');

      // ① 右键「类型」表头（走 elementFromPoint 的真右键）→ 菜单开在这一列上
      const r0 = thOf('prop:类型').getBoundingClientRect();
      const x0 = Math.min(Math.max(8, r0.left + 10), window.innerWidth - 8);
      const y0 = Math.min(Math.max(8, r0.top + r0.height / 2), window.innerHeight - 8);
      P.rightClickAt(x0, y0);
      await P.wait(400);
      const m1 = P.q('.kbw-menu');
      const scopeOk = !!m1 && P.text(m1).indexOf('列「类型」') >= 0;
      if (!scopeOk) return await bail('表头右键没开出「列「类型」」的菜单（实际 ' + (m1 ? P.text(m1).slice(0, 80) : '没有菜单') + '）');

      // ② 隐藏这一列 → 表头消失 + 内存 + 回读 data.json
      const clickedHide = P.clickAny('隐藏这一列');
      await P.wait(900);
      const gone = !thOf('prop:类型');
      if (!gone) note('点了「隐藏这一列」但表头还在（clicked=' + clickedHide + '）');
      const memHidden = ctx.settings.get().columnsHidden || [];
      if (memHidden.indexOf('prop:类型') < 0) note('隐藏没进内存里的 columnsHidden（实际 ' + JSON.stringify(memHidden) + '）');
      let diskHidden = null;
      try {
        const raw = await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json');
        diskHidden = JSON.parse(raw).columnsHidden;
      } catch (e) {
        note('data.json 回读失败：' + String(e && e.message ? e.message : e));
      }
      if (!Array.isArray(diskHidden) || diskHidden.indexOf('prop:类型') < 0) {
        note('隐藏只改了内存 —— data.json 的 columnsHidden 里没有 prop:类型（实际 ' + JSON.stringify(diskHidden) + '）');
      }

      // ③ 名称列：「隐藏这一列」置灰 + 写出原因
      if (m1 && document.body.contains(m1)) P.key('Escape');
      await P.wait(250);
      const rN = thOf('name').getBoundingClientRect();
      P.rightClickAt(Math.min(Math.max(8, rN.left + 10), window.innerWidth - 8), Math.min(Math.max(8, rN.top + rN.height / 2), window.innerHeight - 8));
      await P.wait(400);
      const nameItem = P.qa('.kbw-menu-item').find((i) => P.text(i).indexOf('隐藏这一列') >= 0);
      let nameGrayOk = false;
      if (!nameItem) note('名称列的菜单里没有「隐藏这一列」（置灰而不是不画 —— 硬规矩）');
      else if (nameItem.getAttribute('aria-disabled') !== 'true') note('名称列上「隐藏这一列」没置灰');
      else if (P.text(nameItem).indexOf('名称列不可隐藏') < 0) note('置灰没写出原因（该写「名称列不可隐藏」）');
      else nameGrayOk = true;
      P.key('Escape');
      await P.wait(250);

      // ④ 「打开列设置…」就地换内容 + **从换出来的那扇菜单里**把「类型」勾回来（顺带还原）
      const rS = thOf('prop:状态').getBoundingClientRect();
      P.rightClickAt(Math.min(Math.max(8, rS.left + 10), window.innerWidth - 8), Math.min(Math.max(8, rS.top + rS.height / 2), window.innerHeight - 8));
      await P.wait(400);
      const swapped = P.clickAny('打开列设置');
      await P.wait(400);
      const m4 = P.q('.kbw-menu');
      const swapOk = swapped && !!m4 && P.text(m4).indexOf('表格的列') >= 0;
      if (!swapOk) note('「打开列设置…」没有把菜单就地换成「表格的列」（swapped=' + swapped + '）');
      /** 用换出来的那扇菜单还原（走的就是用户的路：常用 › 类型）——失败再退回工具条「列」按钮 */
      let restored = false;
      if (swapOk) {
        P.clickAny('常用');
        await P.wait(300);
        P.clickAny('类型');
        await P.wait(500);
        restored = !!thOf('prop:类型');
      }
      if (!restored) restored = await restoreType();
      if (!restored) note('没能从列设置里把「类型」勾回来（收尾还原失败）');
      await P.wait(700);
      await ctx.settings.save({ columnsHidden: savedHidden });

      return {
        ok: problems.length === 0 && scopeOk && gone && nameGrayOk && swapOk && restored,
        info: '作用域=列「类型」' + scopeOk + '｜隐藏后表头消失=' + gone + '｜名称列置灰写明原因=' + nameGrayOk +
              '｜打开列设置就地换内容=' + swapOk + '｜还原=' + restored +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1-表头右键.png',
  },
  {
    /**
     * P7.1b · **2.8 根层口径**（反转 P6⑧，用户 2026-10-03 截图立案）。
     * 三个方向都要在真机上钉住：
     *  ① 两档**浏览态**根层都只画本层 —— 深层文件不再平铺（用户报的那条）；
     *  ② 根层的文件夹格 / 文件夹行照旧在（导航没丢，"根层什么都没有"才是真坏了）；
     *  ③ **搜索照旧往下找** —— 在根层要搜得到深层那篇（那条轴一个字没动）。
     */
    name: 'P7.1 · 2.8 根层口径：两档都不再平铺（本层 + 文件夹）· 搜索仍往下找',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const view0 = ctx.settings.get().notesView;
      await P.scopeAll(); // 摆好：库根 + 无搜索/筛选 + 网格档
      await P.wait(400);
      const batch = P.q('.kbw-notes-bar.is-batch');
      if (batch) {
        const x = Array.from(batch.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x) { P.click(x); await P.wait(400); }
      }

      /** 库根这一层 = effectivePosition 为空串的那些（从索引现取，别写死数字） */
      const all = ctx.index.notes();
      const level = all.filter(function (e) { return e.effectivePosition === ''; });
      const levelSet = new Set(level.map(function (e) { return e.path; }));

      // ① 网格档：只画本层；文件夹格照旧在
      const cells = P.qa('.kbw-gcell[data-path]');
      const flat = cells.filter(function (c) { return !levelSet.has(String(c.dataset.path || '')); });
      if (flat.length > 0) {
        note('网格根层平铺了 ' + flat.length + ' 篇深层文件（本该在文件夹里）：' + flat.slice(0, 3).map(function (c) { return String(c.dataset.path).split('/').pop(); }).join('、'));
      }
      if (cells.length !== level.length) note('网格根层笔记格 ' + cells.length + ' 个，本层该是 ' + level.length + ' 篇');
      const folders = P.qa('.kbw-gcell.is-folder');
      if (folders.length === 0) note('网格根层一个文件夹格都没有（导航丢了才是真坏了）');

      // ② 详细档：同样只画本层；**文件夹行要在**（根层"什么都没有"的成因就是靠它消掉的）
      await P.useView('详细信息');
      await P.wait(700);
      const rows = P.qa('.kbw-trow[data-path]');
      const badRows = rows.filter(function (r) { return !levelSet.has(String(r.dataset.path || '')); });
      if (badRows.length > 0) note('详细档根层平铺了 ' + badRows.length + ' 篇深层文件');
      if (rows.length !== level.length) note('详细档根层 ' + rows.length + ' 行，本层该是 ' + level.length + ' 篇');
      const frows = P.qa('.kbw-frow');
      if (frows.length === 0) note('详细档根层没有文件夹行（2.2 没生效？）');
      const crumbs = P.q('.kbw-crumbs-count');
      if (!crumbs || P.text(crumbs) !== '本层 ' + level.length + ' 篇') {
        note('根层面包屑该写「本层 N 篇」（P7.1b 起不写「全部」；实际 ' + (crumbs ? P.text(crumbs) : '(没有)') + '）');
      }

      // ③ 搜索照旧往下找：拿一篇"深层"笔记的名字当关键词，在根层必须搜得到
      const deep = all.find(function (e) { return e.effectivePosition !== ''; });
      let searched = false;
      if (!deep) note('实验库里没有深层笔记 —— 搜索那条判据空转');
      if (deep) {
        const kw = String(deep.basename || '').slice(0, 2);
        const box = P.q('.kbw-search');
        if (!box) note('找不到搜索框');
        if (box) {
          box.value = kw;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          await P.wait(900);
          searched = P.qa('.kbw-trow[data-path]').some(function (r) { return r.dataset.path === deep.path; });
          if (!searched) note('在根层搜「' + kw + '」搜不到深层那篇（' + deep.path + '）—— "往下找"那条轴坏了');
          const c2 = P.q('.kbw-crumbs-count');
          if (c2 && P.text(c2).indexOf('命中') !== 0) note('搜索态面包屑该写「命中 N 篇」（实际 ' + P.text(c2) + '）');
          box.value = '';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          await P.wait(700);
        }
      }

      /**
       * **视线也切回去**（点 seg）——只 save 设置的话本会话的模块还停在网格，
       * 后面依赖表格行的步骤会看到空屏（P7.1b 实测：两条 P1 拖拽步就这么红的）。
       * ⚠️ view0 是 **null**（从没切过档）时也要照还原：写回 null = "没选过"，
       * 点过 seg 之后若只 save 原值是 null 会被跳过 —— "没选过"就悄悄变成"选过 detail"了
       * （独立审查 🟢4）。
       */
      await P.useView(view0 === 'detail' ? '详细信息' : '网格');
      await ctx.settings.save({ notesView: view0 });
      await P.wait(400);
      return {
        ok: problems.length === 0,
        info: '本层 ' + level.length + ' 篇 / 全库 ' + all.length + ' 篇｜网格格 ' + cells.length + '（文件夹 ' + folders.length + '）｜详细行 ' + rows.length + '（文件夹行 ' + frows.length + '）｜根层搜得到深层=' + searched +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    /**
     * P7.1b · **2.2 文件夹行（详细档）**。真机一条走全七件事：
     * 置顶 / 单击选中（不进目录、不进选择集）/ 双击进入 / Enter 进入（Space 不做）/
     * 搜索时不画 / 右键复用那扇目录菜单 / **拖一篇到行上真搬（走 mover）+ 撤销条能撤回**。
     * ⚠️ 整段自造夹具（__探针夹行：2 篇 + 子目录「子」），收尾 dropGridDir 删掉 ——
     * 别依赖实验库当时的形态（前面几十步会搬文件）。
     */
    name: 'P7.1 · 2.2 文件夹行：置顶 · 单击选中 · 双击/Enter 进入 · 右键菜单 · 拖入=搬（可撤销）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      /** ⚠️ 先清选择：有选择时工具条整条被批量栏顶掉 —— useView 的 seg 会找不到（老坑） */
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      await P.useView('详细信息');
      await P.wait(500);

      await P.dropGridDir('夹行');
      const dirRel = await P.seedGridDir('夹行', 2);
      const node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dirRel; });
      if (node) { P.click(node); await P.wait(900); }
      else { ctx.goNotes({ dir: dirRel }); await P.wait(900); }
      await P.useView('详细信息');
      await P.wait(600);

      const frows = P.qa('.kbw-frow');
      if (frows.length === 0) return { ok: false, info: '这一层的文件夹行一条都没画（2.2 没生效？）' };
      const row0 = frows[0];
      const toDir = row0.dataset.dir;
      if (!toDir) note('文件夹行没带 data-dir');

      // 置顶：全部文件夹行排在笔记行之前
      const trs = P.qa('.kbw-table tbody tr');
      const lastF = trs.map(function (r) { return r.classList.contains('kbw-frow'); }).lastIndexOf(true);
      const firstN = trs.findIndex(function (r) { return r.classList.contains('kbw-trow'); });
      if (!(lastF >= 0 && firstN >= 0 && lastF < firstN)) note('文件夹行没有全部排在笔记行之前（置顶口径）');

      // 计数与身份（⚠️ 判据写**全等**不是 indexOf —— '· 11 篇' 也含「1 篇」；独立审查 🟢5）
      const cntEl = row0.querySelector('.kbw-frow-count');
      if (!cntEl || P.text(cntEl) !== '· 1 篇') note('计数该是「· 1 篇」（子目录里就 1 篇；实际 ' + (cntEl ? P.text(cntEl) : '(没有)') + '）');
      /**
       * ⚠️ P7.12 · #7 收尾修正（真机抓到）：计数改成**去 title 留 aria-label**
       *（黑色气泡走平台的 aria-label 提示）—— 旧判据盯的是 title，批1 改完后这条恒红。
       */
      if (cntEl && (cntEl.getAttribute('aria-label') || '').indexOf('含子目录') < 0) {
        note('计数的 aria-label 该写「含子目录」（实际 ' + (cntEl.getAttribute('aria-label') || '(没有)') + '）');
      }
      if (row0.dataset.path != null) note('文件夹行带上了 data-path（会被当成笔记行）');
      if ((row0.dataset.drop || '') !== toDir) note('文件夹行没有 data-drop（落点解析靠它）');
      if (row0.querySelector('.kbw-rowcheck')) note('文件夹行里有复选框（它不该进选择集）');

      // ① 单击 = 只选中（不进目录、不进"选 N 篇"）
      P.click(row0);
      await P.wait(500);
      if (!row0.classList.contains('is-selected')) note('单击没有选中文件夹行');
      if (ctx.settings.get().treeSelected !== dirRel) note('单击就进目录了（那是双击的活）');
      if (P.q('.kbw-trow.is-selected')) note('文件夹行进了笔记的选中集（它是导航，不该进）');

      // ② 双击 = 进入（真派三发：click click dblclick）
      const r0 = row0.getBoundingClientRect();
      const pt = { x: Math.round(r0.left + r0.width / 2), y: Math.round(r0.top + r0.height / 2) };
      P.elAt(pt.x, pt.y).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y }));
      P.elAt(pt.x, pt.y).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y }));
      P.elAt(pt.x, pt.y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y }));
      await P.wait(900);
      if (ctx.settings.get().treeSelected !== toDir) note('双击没进目录（期望 ' + toDir + '，实际 ' + ctx.settings.get().treeSelected + '）');
      const back = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dirRel; });
      if (back) { P.click(back); await P.wait(800); }

      // ③ Enter 进入；Space **不做**（含"不许泄漏给全局键"—— Space 在键表里是"选中/取消选中"）
      const rowK = P.qa('.kbw-frow')[0];
      if (!rowK) note('回层之后找不到文件夹行了（重画后就没了？）');
      if (rowK) {
        rowK.focus();
        rowK.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        await P.wait(500);
        if (ctx.settings.get().treeSelected !== dirRel) note('Space 不该进入目录（"不做"就是不做）');
        if (P.q('.kbw-trow.is-selected')) note('Space 泄漏到了全局键（把笔记选上了）—— 文件夹行该就地按住它');
        rowK.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await P.wait(900);
        if (ctx.settings.get().treeSelected !== toDir) note('Enter 没进目录（期望 ' + toDir + '，实际 ' + ctx.settings.get().treeSelected + '）');
        const back2 = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dirRel; });
        if (back2) { P.click(back2); await P.wait(800); }
      }

      // ④ 搜索时不画（与网格文件夹格同一条判据）
      const box = P.q('.kbw-search');
      if (!box) note('找不到搜索框');
      if (box) {
        box.value = '笔记1';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(700);
        const still = P.qa('.kbw-frow').length;
        if (still > 0) note('搜索时还画着 ' + still + ' 条文件夹行');
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(700);
      }

      // ⑤ 右键 = 那一扇目录菜单（与网格文件夹格**同一份实现**）
      const rowM = P.qa('.kbw-frow')[0];
      if (rowM) {
        const rm = rowM.getBoundingClientRect();
        P.rightClickAt(Math.round(rm.left + 40), Math.round(rm.top + rm.height / 2));
        await P.wait(500);
        const menu = P.lastMenu();
        const mt = menu ? P.text(menu) : '';
        if (mt.indexOf('进入这个目录') < 0) note('文件夹行的右键菜单里没有「进入这个目录」（' + mt.slice(0, 60) + '）');
        if (mt.indexOf('在此新建笔记') < 0) note('文件夹行的右键菜单里没有「在此新建笔记」');
        P.key('Escape');
        await P.wait(400);
      }

      // ⑥ 拖一篇到文件夹行上 = 搬（走 mover）+ 撤销条能撤回
      const srcRow = P.qa('.kbw-trow[data-path]')[0];
      let moved = false;
      if (!srcRow) note('那一层没有笔记行可拖（seed 没生效？）');
      if (srcRow && rowM) {
        const fromPath = srcRow.dataset.path;
        const grip = srcRow.querySelector('td[data-col="name"]') || srcRow;
        /**
         * 取点：先 aim 源（滚动到它），再 **rectAt 目标**（不滚动 —— 免得把源点坐标做废；
         * 见坑单"center() 每次都 scrollIntoView"那条）。两点都要可见才拖。
         */
        const s = P.aimAt(grip);
        const d = P.rectAt(rowM);
        if (!s || !s.visible) note('拖动源不在视野里');
        if (!d || !d.visible) note('落点（文件夹行）不在视野里');
        if (s && d) {
          await P.dragMouse({ x: s.x, y: s.y }, { x: d.x, y: d.y }, 8);
          await P.wait(1500);
          const want = KB + '/' + toDir + '/' + fromPath.split('/').pop();
          moved = !!app.vault.getAbstractFileByPath(want);
          if (!moved) note('拖到文件夹行上没搬文件（' + want + ' 不存在）');
          if (app.vault.getAbstractFileByPath(fromPath)) { moved = false; note('新位置有了、老位置还在 —— 这不是"搬"'); }
          if (moved) {
            const undoBar = P.q('.kbw-undobar');
            const undoBtn = undoBar ? P.btnByText('撤销', undoBar) : null;
            if (undoBtn) { P.click(undoBtn); await P.wait(2200); } else note('搬完没出撤销条（与拖到目录树同一条链，该出的）');
            if (!app.vault.getAbstractFileByPath(fromPath)) note('撤销之后没回到原位：' + fromPath);
          }
        }
      }

      // 收尾：删自造目录（连带子目录）→ 视图档与目录树选择拨回基线
      await P.dropGridDir('夹行');
      // **视线也切回去**（见 2.8 那步的注释；null 照还原 —— 独立审查 🟢4）
      await P.useView(view0 === 'detail' ? '详细信息' : '网格');
      await ctx.settings.save({ notesView: view0 });
      await P.wait(400);
      const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
      if (rootNode) { P.click(rootNode); await P.wait(600); }
      return {
        ok: problems.length === 0,
        info: '文件夹行 ' + frows.length + ' 条｜单击/双击/Enter/Space/搜索/右键/拖入=搬 七件事' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1-文件夹行.png',
  },
  {
    /**
     * P7.1b · **2.6b 网格名裁切完整版**（G1-b 已点头）。
     * 判据必须来自**真机几何**（坑单原话：别只看 CSS 写没写）：
     *  ① computed 真的换成了 -webkit-box + line-clamp:2；
     *  ② 长名格是**两行高**（≈ 2×lineHeight）且内容溢出被裁（scrollHeight > clientHeight）；
     *  ③ 短名格仍是一行高（clamp 没把"一行的事"弄坏）。
     * "省略号形态"computed 读不到（伪元素）—— 交给截图人眼复核。
     */
    name: 'P7.1 · 2.6b 网格名裁切：两行 + 真省略号（line-clamp 完整版 · 真机几何）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      /** ⚠️ 先清选择：有选择时工具条整条被批量栏顶掉 —— useView 的 seg 会找不到（老坑） */
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      await P.useView('网格');
      await P.wait(500);

      // 自造：一个目录 + 一个超长名 + 一个短名（收尾全清）
      await P.dropGridDir('名裁');
      const dirRel = '__探针名裁';
      try { await app.vault.createFolder(KB + '/' + dirRel); } catch (e) { /* 已存在 */ }
      const NL = String.fromCharCode(10);
      const body = ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-10-03', 'tags: []', '---', '# 名裁'].join(NL) + NL;
      const longName = '__探针超长名-20261003-abcdefghijklmnopqrstuvwxyz-两行才放得下的网格名';
      const longPath = KB + '/' + dirRel + '/' + longName + '.md';
      const shortPath = KB + '/' + dirRel + '/__探针短.md';
      if (!app.vault.getAbstractFileByPath(longPath)) await app.vault.create(longPath, body);
      if (!app.vault.getAbstractFileByPath(shortPath)) await app.vault.create(shortPath, body);
      for (let i = 0; i < 20; i += 1) {
        await P.wait(200);
        if (ctx.index.notes().some(function (e) { return e.path === longPath; })) break;
      }
      const node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dirRel; });
      if (node) { P.click(node); await P.wait(900); }
      else { ctx.goNotes({ dir: dirRel }); await P.wait(900); }
      await P.useView('网格');
      await P.wait(600);

      const cellOf = function (p) {
        return P.qa('.kbw-gcell[data-path]').find(function (c) { return c.dataset.path === p; });
      };
      const cellL = cellOf(longPath);
      const cellS = cellOf(shortPath);
      if (!cellL || !cellS) {
        await P.dropGridDir('名裁');
        return { ok: false, info: '自造的两篇没在网格里（长=' + !!cellL + ' 短=' + !!cellS + '）' };
      }
      const g = cellL.querySelector('.kbw-gname');
      const gs = cellS.querySelector('.kbw-gname');
      const cs = getComputedStyle(g);
      /**
       * ⚠️ **读数两坑（真机实测，第一版就是栽在这）**：
       *  ① 计算样式里的 display 对 -webkit-box 的**序列化值不可靠** —— 这条 Chromium 报
       *     flow-root（CSS 明明生效，clamp 也真的在两行处截住）→ **不钉这个字符串**，
       *     行为判据看下面两条（clamp 属性 + 两行高 + 内容溢出）；
       *  ② getPropertyValue 的写法比驼峰存取器稳（驼峰在旧版本读不到）——两个都试。
       * ⚠️⚠️ 还有个更隐蔽的：**info 必须在清场之前拼好**（第一版把「溢出=…」那种表达式
       * 留在 return 里现算 —— 那时自造文件已删、元素已被重画摘掉，读到的是**游离节点的 0/空串**，
       * 报出来是 clamp 空 + 溢出=false（两条"看着像坏了"的假线索，真断言其实都过了）。
       */
      const clampVal = (cs.getPropertyValue('-webkit-line-clamp') || cs.webkitLineClamp || '').trim();
      const dispSerialized = String(cs.display); // 快照：清场后再读 cs 会变成空串（见上面的信息注释）
      if (clampVal !== '2') note('line-clamp 不是 2（实际「' + clampVal + '」）');
      const lh = parseFloat(cs.lineHeight) || 0;
      if (!(lh > 0)) note('lineHeight 量不到（' + cs.lineHeight + '）');
      const hL = g.getBoundingClientRect().height;
      if (lh > 0 && !(hL > lh * 2 - 3 && hL <= lh * 2 + 3)) note('长名格该是两行高（h=' + Math.round(hL) + ' lh=' + lh + '）');
      /** 内容比可视区高 = 第 3 行起真的被"裁在布局里"（真机复核：clamp 生效时 scrollHeight=91 > clientHeight=36） */
      const overflowed = g.scrollHeight > g.clientHeight + 1;
      if (!overflowed) {
        note('长名的内容没有溢出（scrollHeight ' + g.scrollHeight + ' vs clientHeight ' + g.clientHeight + '）—— clamp 这条判据空转（名不够长？）');
      }
      const hS = gs.getBoundingClientRect().height;
      if (!(hS > 0 && hS <= lh + 3)) note('短名格该是一行高（h=' + Math.round(hS) + ' lh=' + lh + '）');

      // 收尾：删自造的两篇 + 目录；视图档/目录选择拨回基线
      const f1 = app.vault.getAbstractFileByPath(longPath);
      if (f1) await app.vault.delete(f1, true);
      const f2 = app.vault.getAbstractFileByPath(shortPath);
      if (f2) await app.vault.delete(f2, true);
      await P.dropGridDir('名裁');
      // 把**视线**也切回去（点 seg；理由见 2.8 那步的注释；null 照还原 —— 独立审查 🟢4）
      await P.useView(view0 === 'detail' ? '详细信息' : '网格');
      await ctx.settings.save({ notesView: view0 });
      await P.wait(500);
      const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
      if (rootNode) { P.click(rootNode); await P.wait(600); }
      return {
        ok: problems.length === 0,
        info: '长名 h=' + Math.round(hL) + ' / lh=' + lh + '（clamp「' + clampVal + '」· display 序列化=' + dispSerialized + '，不钉它）｜溢出=' + overflowed + '｜短名 h=' + Math.round(hS) +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1-网格名裁切.png',
  },
  {
    /**
     * P7.1c · **2.7「移动到…」目录直选**（G1-a 已拍"提前"）。
     * 真机走全：右键一篇 → 改 › 移动到… → **树形子菜单**（没有文本框了）→
     * 当前所在目录那项不画 → 点一项真搬 + 撤销条能撤回。
     * 夹具自造（__探针移选：1 篇 + 子目录「子」——保证当前目录是"非叶子"形态）——收尾 dropGridDir。
     */
    name: 'P7.1c · 2.7 移动到：树形子菜单（无文本框）· 当前目录不画 · 点一项真搬 + 撤销',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      // 视野是会话态：搜索词残留会让列表空掉
      const sbox = P.q('.kbw-search');
      if (sbox && sbox.value) { sbox.value = ''; sbox.dispatchEvent(new Event('input', { bubbles: true })); await P.wait(500); }

      await P.dropGridDir('移选');
      const dirRel = await P.seedGridDir('移选', 1);
      const node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dirRel; });
      if (node) { P.click(node); await P.wait(900); }
      else { ctx.goNotes({ dir: dirRel }); await P.wait(900); }
      await P.useView('详细信息');
      await P.wait(600);

      const fromPath = KB + '/' + dirRel + '/笔记1.md';
      const row = P.q('.kbw-trow[data-path="' + fromPath + '"]') || P.qa('.kbw-trow[data-path]')[0];
      if (!row) return { ok: false, info: '这一层没有可右键的笔记行（seed 没生效？）' };
      const from = row.dataset.path;
      let movedTo = null;
      let undone = false;
      try {
        const rc = P.rectAt(row);
        P.rightClickAt(rc.x, rc.y);
        await P.wait(600);
        // 改 › 移动到…（菜单项是 div.kbw-menu-item，不是 button）
        if (!P.clickMenu('改')) note('单篇菜单里找不到「改」分组');
        await P.wait(500);
        // **没有文本框了**（旧实现是原地输入目录名）—— 2.7 最直白的身份变化
        const inputs = document.querySelectorAll('.kbw-menu input').length;
        if (inputs > 0) note('菜单里还有 ' + inputs + ' 个输入框（旧的"原地输入目录名"没撤干净？）');
        if (!P.clickMenu('移动到')) note('「改」里找不到「移动到…」');
        await P.wait(600);
        const itemTexts = Array.from(document.querySelectorAll('.kbw-menu-item')).map(function (i) { return P.text(i); });
        if (!itemTexts.some(function (t) { return /（[0-9]+）/.test(t); })) note('「移动到…」的子菜单没列出目录树：' + itemTexts.join(' | '));
        if (!itemTexts.some(function (t) { return t.indexOf('移到库根') >= 0; })) note('不在库根的笔记该有「移到库根」一项');
        /**
         * 抓下**顶层节点**清单（此刻菜单停在这一层：全是树根级目录）。
         * ⚠️ 必须在"点开当前目录节点"**之前**抓 —— 点开之后子节点也躺在 DOM 里，
         * 从全量里挑会挑到「子（1）」这种孙节点，接着点「移到「子」」落点目录不存在，
         * 探针假红（第一版就这么红的）。
         */
        const rootTexts = Array.from(document.querySelectorAll('.kbw-menu-item'))
          .map(function (i) { return P.text(i); })
          .filter(function (t) { return /（[0-9]+）/.test(t) && t.indexOf(dirRel) !== 0 && t.indexOf('__探针') !== 0; });
        // 当前目录（带子目录「子」→ 非叶子）：节点留着，但「移到它」不许画（死选项，P7.0a ⑨ 同一份实现）
        const curNode = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf(dirRel + '（') === 0; });
        if (!curNode) note('当前目录「' + dirRel + '」下面还有子目录，节点该留着');
        if (curNode) {
          P.click(curNode);
          await P.wait(500);
          const inner = Array.from(document.querySelectorAll('.kbw-menu-item')).map(function (i) { return P.text(i); });
          if (inner.some(function (t) { return t.indexOf('移到「' + dirRel + '」') >= 0; })) note('当前所在目录是死选项却还在画：' + inner.join(' | '));
        }
        /**
         * 换一个别的**树根级**目录：真搬 + 撤销。
         * ⚠️ **重新开一遍菜单**再挑 —— 点开过子节点之后，旧的菜单层会被收走
         *（探针实测：此刻 DOM 里只剩新开的「子（1）」，全局扫是扫不到树根级节点的）。
         */
        /**
         * ⚠️ **只按"还需要按的"那几下 Esc**（本轮真机定位，P7.1c · 2.7 连红两轮）：
         * 固定按 4 下时，多余的 Esc 会**落空到 Obsidian 全局** —— 它的默认行为把
         * **活动叶翻到笔记标签页**（工作台当场被盖住）→ 之后"重开菜单"的真右键
         * （elementFromPoint）落在笔记的属性输入框上，菜单一个都不出。
         * 菜单收完就停（通常 1–2 下）；再保险一道：重开前把工作台重新激活。
         */
        for (let i = 0; i < 4 && document.querySelectorAll('.kbw-menu').length > 0; i += 1) {
          P.key('Escape');
          await P.wait(250);
        }
        if (
          app.workspace.activeLeaf &&
          app.workspace.activeLeaf.view &&
          app.workspace.activeLeaf.view.getViewType &&
          app.workspace.activeLeaf.view.getViewType() !== 'kb-workbench-view'
        ) {
          await ctx.activate();
          await P.wait(600);
        }
        const hit2 = P.rightClickAt(rc.x, rc.y); // 返回值 = elementFromPoint 命中元素的类名（诊断用）
        await P.wait(600);
        P.clickMenu('改');
        await P.wait(500);
        P.clickMenu('移动到');
        await P.wait(600);
        const freshRoots = Array.from(document.querySelectorAll('.kbw-menu-item'))
          .map(function (i) { return P.text(i); })
          .filter(function (t) { return /（[0-9]+）/.test(t) && t.indexOf(dirRel) !== 0 && t.indexOf('__探针') !== 0; });
        const other = freshRoots.length > 0
          ? Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i) === freshRoots[0]; })
          : null;
        if (!other) {
          const nowTexts = Array.from(document.querySelectorAll('.kbw-menu-item')).map(function (i) { return P.text(i); });
          note('重开之后树里没有别的目录节点可选（freshRoots=' + freshRoots.join(' | ') + '；此刻菜单=' + nowTexts.join(' | ') +
            '；右键命中=' + hit2 + '；菜单数=' + document.querySelectorAll('.kbw-menu').length + '）');
        }
        if (other) {
          P.click(other);
          await P.wait(500);
          const leaf = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('移到「') === 0; });
          if (!leaf) note('别的目录子菜单里没有「移到「X」」');
          if (leaf) {
            const leafText = P.text(leaf);
            const target = leafText.slice(3, leafText.length - 1);
            // 判据前置自证：目标得是**盘上真有的树根级目录**（否则下面那条会以别的形态报）
            if (!app.vault.getAbstractFileByPath(KB + '/' + target)) note('目标的目录不存在（' + target + '）—— 这条判据的前提不成立');
            P.click(leaf);
            await P.wait(2000);
            movedTo = KB + '/' + target + '/' + from.split('/').pop();
            if (!app.vault.getAbstractFileByPath(movedTo)) { note('点「' + leafText + '」之后没搬（' + movedTo + ' 不存在）'); movedTo = null; }
            if (movedTo && app.vault.getAbstractFileByPath(from)) { note('新位置有了、老位置还在 —— 这不是搬'); movedTo = null; }
            if (movedTo) {
              const undoBar = P.q('.kbw-undobar');
              const undoBtn = undoBar ? P.btnByText('撤销', undoBar) : null;
              if (undoBtn) { P.click(undoBtn); await P.wait(2200); undone = !!app.vault.getAbstractFileByPath(from); if (!undone) note('撤销之后没回原位：' + from); }
              else note('搬完没出撤销条（单篇那条链该出的）');
            }
          }
        }
      } finally {
        P.key('Escape');
        await P.wait(300);
        // 兜底：还没撤销成 → 手动搬回（别把自造夹具漏在别的目录里）
        if (movedTo && !app.vault.getAbstractFileByPath(from)) {
          const f = app.vault.getAbstractFileByPath(movedTo);
          if (f) { await app.fileManager.renameFile(f, from); await P.wait(1200); }
        }
        await P.dropGridDir('移选');
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: (movedTo ? '搬去 ' + movedTo + '（撤销=' + undone + '）' : '（没走到"搬"那一步）') +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-移动到子菜单.png',
  },
  {
    /**
     * P7.1c · **① F2 就地改名（网格）** —— 输入框挂进 `.kbw-gname`（`is-renaming` 解 clamp）、
     * Enter 真改名 + 撤销、Esc 取消不动文件。夹具 __探针F2改（1 篇）。
     * ⚠️ F2 发给**工作台根元素**（键盘处理器挂在 .kbw-root 上；P.key 派给 activeElement 收不到）。
     */
    name: 'P7.1c · F2 网格改名：输入框进名称格 · Enter 真改名 · 撤销 / Esc 取消',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      const sbox = P.q('.kbw-search');
      if (sbox && sbox.value) { sbox.value = ''; sbox.dispatchEvent(new Event('input', { bubbles: true })); await P.wait(500); }
      const sendF2 = () => {
        const root = P.q('.kbw-root');
        if (!root) return false;
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        root.focus();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
        return true;
      };

      await P.dropGridDir('F2改');
      const dirRel = await P.seedGridDir('F2改', 1);
      const node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dirRel; });
      if (node) { P.click(node); await P.wait(900); }
      else { ctx.goNotes({ dir: dirRel }); await P.wait(900); }
      await P.useView('网格');
      await P.wait(600);

      const oldPath = KB + '/' + dirRel + '/笔记1.md';
      const newPath = KB + '/' + dirRel + '/__探针F2改新名.md';
      const escPath = KB + '/' + dirRel + '/__探针别采用我.md';
      let renamed = false;
      let undone = false;
      let escOk = false;
      try {
        const cell = P.q('.kbw-gcell[data-path="' + oldPath + '"]');
        if (!cell) note('网格里找不到自造的那一格');
        if (cell) {
          P.click(cell);
          await P.wait(500);
          if (!sendF2()) note('找不到 .kbw-root（F2 发不出去）');
          await P.wait(500);
          const input = P.q('.kbw-gcell .kbw-gname .kbw-inline-input');
          if (!input) note('F2 之后网格的名称格里没有输入框（① 没生效？）');
          // ⚠️ 认**正在改名的那一格**（首个 .kbw-gname 是文件夹格 —— 第一版就查错了对象）
          const gnameR = P.q('.kbw-gcell .kbw-gname.is-renaming');
          if (!gnameR) note('名称格没贴 is-renaming（line-clamp 没解 —— 输入框会被压扁）');
          if (input) {
            if (input.value !== '笔记1') note('输入框没预填旧名（实际「' + input.value + '」）');
            input.value = '__探针F2改新名';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await P.wait(2200);
            renamed = !!app.vault.getAbstractFileByPath(newPath);
            if (!renamed) note('Enter 之后没改名（' + newPath + ' 不存在）');
            if (renamed) {
              const undoBar = P.q('.kbw-undobar');
              const undoBtn = undoBar ? P.btnByText('撤销', undoBar) : null;
              if (undoBtn) { P.click(undoBtn); await P.wait(2400); undone = !!app.vault.getAbstractFileByPath(oldPath); if (!undone) note('撤销之后没回旧名'); }
              else note('改名没出撤销条');
            }
          }
        }
        // Esc 取消：再来一次，这次按 Esc —— 文件一个字节都不许动
        const cell2 = P.q('.kbw-gcell[data-path="' + oldPath + '"]');
        if (cell2) {
          P.click(cell2);
          await P.wait(400);
          sendF2();
          await P.wait(500);
          const input2 = P.q('.kbw-gcell .kbw-gname .kbw-inline-input');
          if (!input2) note('第二次 F2 没开输入框');
          if (input2) {
            input2.value = '__探针别采用我';
            input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await P.wait(900);
            escOk = !app.vault.getAbstractFileByPath(escPath) && !!app.vault.getAbstractFileByPath(oldPath);
            if (!escOk) note('Esc 取消之后文件不该动（或盘上多了「__探针别采用我」）');
          }
        }
      } finally {
        P.key('Escape');
        await P.wait(300);
        // 兜底：改名没撤销成 → 手动改回来 + 删掉可能的别名
        if (app.vault.getAbstractFileByPath(newPath) && !app.vault.getAbstractFileByPath(oldPath)) {
          const f = app.vault.getAbstractFileByPath(newPath);
          if (f) { await app.fileManager.renameFile(f, oldPath); await P.wait(1200); }
        }
        const stray = app.vault.getAbstractFileByPath(escPath);
        if (stray) await app.vault.delete(stray, true);
        await P.dropGridDir('F2改');
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: 'Enter 改名=' + renamed + ' · 撤销=' + undone + ' · Esc 取消=' + escOk +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-F2网格改名.png',
  },
  {
    /**
     * P7.1c · **② Del 删除**（2.3 拍板的安全语义）。
     * local → **直删**（不进确认流）+ 撤销条能还原；system → 弹确认流、取消之后文件一个没动。
     * 🔴 动的是**用户的平台设置**（vault config trashOption）—— 起手记原值、finally 还原。
     */
    name: 'P7.1c · Del：local 直删 + 撤销还原 · system 弹确认流（取消不动）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      const sendKey = (k) => {
        const root = P.q('.kbw-root');
        if (!root) return false;
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        root.focus();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        return true;
      };
      const opt0 = app.vault.getConfig('trashOption');
      const rel = KB + '/__探针Del/笔记1.md';
      let direct = false;
      let undone = false;
      let systemModal = false;
      let systemIntact = false;
      try {
        app.vault.setConfig('trashOption', 'local');
        await P.dropGridDir('Del');
        const dirRel = await P.seedGridDir('Del', 1);
        const node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dirRel; });
        if (node) { P.click(node); await P.wait(900); }
        else { ctx.goNotes({ dir: dirRel }); await P.wait(900); }
        await P.useView('详细信息');
        await P.wait(600);
        const row = P.q('.kbw-trow[data-path="' + rel + '"]');
        if (!row) note('这一层没有自造的行');
        if (row) {
          P.click(row);
          await P.wait(400);
          sendKey('Delete');
          await P.wait(1600);
          const modalCount = P.qa('.kbw-modal').length;
          if (modalCount > 0) note('local 直删不该进确认流（却有 ' + modalCount + ' 个模态）');
          direct = !app.vault.getAbstractFileByPath(rel);
          if (!direct) note('Del（local）之后文件还在');
          if (direct) {
            const undoBar = P.q('.kbw-undobar');
            const undoBtn = undoBar ? P.btnByText('撤销', undoBar) : null;
            if (undoBtn) { P.click(undoBtn); await P.wait(2400); undone = !!app.vault.getAbstractFileByPath(rel); if (!undone) note('撤销没把删除带回来'); }
            else note('Del 删除后没出撤销条');
          }
        }
        // system 档：弹确认流；取消（Esc）之后文件一个没动
        app.vault.setConfig('trashOption', 'system');
        const row2 = P.q('.kbw-trow[data-path="' + rel + '"]');
        if (row2) {
          P.click(row2);
          await P.wait(400);
          sendKey('Delete');
          await P.wait(900);
          const modal = P.q('.kbw-modal');
          systemModal = !!modal;
          if (!systemModal) note('system 档 Del 没弹确认流（不该直删）');
          if (modal) {
            P.key('Escape');
            await P.wait(700);
          }
          systemIntact = !!app.vault.getAbstractFileByPath(rel);
          if (!systemIntact) note('system 档取消之后文件不该动');
        }
      } finally {
        // 🔴 用户设置 + 残留文件：无论红绿都要拨回来
        app.vault.setConfig('trashOption', opt0);
        P.key('Escape');
        await P.wait(200);
        // 撤不回的原件可能在库内 .trash（adapter 那条路，索引看不见它）——尽最大努力清掉
        try {
          await app.vault.adapter.remove('.trash/' + rel);
        } catch (e) { /* 不在就不在 */ }
        await P.dropGridDir('Del');
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: 'trashOption 原值=' + opt0 + '｜local：直删=' + direct + ' 撤销=' + undone + '｜system：弹确认=' + systemModal + ' 取消后原样=' + systemIntact +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-Del删除.png',
  },
  {
    /**
     * P7.1c · **③ 拖到面包屑 = 上移**。
     * 夹具 __探针面包（1 篇 + 子目录「子」）→ 站进「子」→ 拖子笔记到**祖先段**面包屑：
     * 拖动期间工具条**让位给面包屑**（检查批量栏不在场）· 落点高亮 `.is-drop` ·
     * 松手真搬到上一级 + 撤销；松手后批量栏回来。
     */
    name: 'P7.1c · 拖到面包屑 = 上移：拖动中工具条让位（批量栏不在）· 落点高亮 · 真搬 + 撤销',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      const sbox = P.q('.kbw-search');
      if (sbox && sbox.value) { sbox.value = ''; sbox.dispatchEvent(new Event('input', { bubbles: true })); await P.wait(500); }

      await P.dropGridDir('面包');
      const dirRel = await P.seedGridDir('面包', 1);
      const subRel = dirRel + '/子';
      ctx.goNotes({ dir: subRel });
      await P.wait(1200);
      await P.useView('详细信息');
      await P.wait(600);

      const fromPath = KB + '/' + subRel + '/子笔记.md';
      const row = P.q('.kbw-trow[data-path="' + fromPath + '"]') || P.qa('.kbw-trow[data-path]')[0];
      if (!row) return { ok: false, info: '「子」那一层没有笔记行（seed 没生效？）' };
      const from = row.dataset.path;
      let moved = false;
      let undone = false;
      let battedAway = false;
      let highlight = false;
      try {
        const s = P.aimAt(row);
        if (!s || !s.visible) note('拖动源不在视野里');
        P.pointerDownAt(s.x, s.y);
        await P.wait(80);
        P.pointerMoveTo(s.x + 40, s.y + 40); // 越过 4px 阈值 → dragActive
        await P.wait(450);
        battedAway = !P.q('.kbw-notes-bar.is-batch');
        if (!battedAway) note('拖动期间工具条还是批量栏（没有让位给面包屑）');
        const crumbs = P.qa('.kbw-crumb[data-drop]');
        if (crumbs.length === 0) note('拖动期间面包屑段不在场（每一段该是落点）');
        const ancestor = crumbs.find(function (c) { return c.dataset.drop === dirRel; });
        if (!ancestor) note('面包屑里找不到祖先段 ' + dirRel + '（实际：' + crumbs.map(function (c) { return c.dataset.drop; }).join(' / ') + '）');
        if (ancestor) {
          const tc = P.rectAt(ancestor);
          P.pointerMoveTo(tc.x, tc.y);
          await P.wait(450);
          highlight = ancestor.classList.contains('is-drop');
          if (!highlight) note('掠过面包屑段没有落点高亮（.is-drop）');
          P.pointerUpAt(tc.x, tc.y);
          await P.wait(2200);
          const want = KB + '/' + dirRel + '/子笔记.md';
          moved = !!app.vault.getAbstractFileByPath(want);
          if (!moved) note('拖到面包屑上没搬（' + want + ' 不存在）');
          if (moved && app.vault.getAbstractFileByPath(from)) { moved = false; note('新位置有了、老位置还在 —— 不是搬'); }
          if (moved) {
            const undoBar = P.q('.kbw-undobar');
            const undoBtn = undoBar ? P.btnByText('撤销', undoBar) : null;
            if (undoBtn) { P.click(undoBtn); await P.wait(2400); undone = !!app.vault.getAbstractFileByPath(from); if (!undone) note('撤销之后没回原位：' + from); }
            else note('搬完没出撤销条');
          }
          /**
           * 收尾要**干净**：拖动状态全撤（根上的 kbw-dragging 摘掉、浮标收掉）。
           * ⚠️ 别再断言"批量栏回来"—— 搬完之后那篇的**路径变了**，选中集会被
           * 「syncFromIndex」按"还活着"的口径剔掉 → 工具条回到常规那一条是**正确**的
           *（第一版把这条写成判据，假红）。
           */
          await P.wait(500);
          if (document.documentElement.classList.contains('kbw-dragging')) note('松手后 kbw-dragging 还挂在根上（拖动没收干净）');
          if (P.q('.kbw-dragghost')) note('松手后拖动浮标还在');
        }
      } finally {
        P.pointerCancelAt(0, 0);
        await P.wait(200);
        // 兜底：还没撤销成 → 手动搬回
        if (!app.vault.getAbstractFileByPath(from)) {
          const wantPath = KB + '/' + dirRel + '/子笔记.md';
          const f = app.vault.getAbstractFileByPath(wantPath);
          if (f) { await app.fileManager.renameFile(f, from); await P.wait(1200); }
        }
        const bar = P.q('.kbw-notes-bar.is-batch');
        if (bar) {
          const x2 = Array.from(bar.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
          if (x2) { P.click(x2); await P.wait(300); }
        }
        await P.dropGridDir('面包');
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: '拖动中让位=' + battedAway + ' · 落点高亮=' + highlight + ' · 真搬=' + moved + '（撤销=' + undone + '）' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-拖到面包屑.png',
  },
  {
    /**
     * P7.1c · **④ 拖拽悬停展开树节点**。
     * 夹具：__探针悬包（1 篇 + 子）里现造一篇 笔记9；__探针悬展（1 篇 + 子）作**折叠的**目标节点。
     * 三件事：掠过 250ms 就移开 → **不展开**；停够 ~500ms → aria-expanded 变 true；
     * **同一手势里直接落进去**（真搬 + 撤销）。
     */
    name: 'P7.1c · 悬停展开树节点：提前移开不展开 · 停留 ~500ms 展开 · 同一手势落进去',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      const NL = String.fromCharCode(10);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      const sbox = P.q('.kbw-search');
      if (sbox && sbox.value) { sbox.value = ''; sbox.dispatchEvent(new Event('input', { bubbles: true })); await P.wait(500); }

      await P.dropGridDir('悬包');
      await P.dropGridDir('悬展');
      const srcRel = await P.seedGridDir('悬包', 1);
      const tgtRel = await P.seedGridDir('悬展', 1);
      // 拖的那篇叫 笔记9（seedGridDir 没造它；dropGridDir 的 1..60 能收走它）
      const dragPath = KB + '/' + srcRel + '/笔记9.md';
      if (!app.vault.getAbstractFileByPath(dragPath)) {
        await app.vault.create(dragPath, ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-10-03', 'tags: []', '---', '# 笔记9'].join(NL) + NL);
      }
      for (let i = 0; i < 20; i += 1) {
        await P.wait(250);
        const seen = ctx.index.notes().filter(function (e) { return e.path === dragPath; }).length;
        if (seen >= 1) break;
      }
      ctx.goNotes({ dir: srcRel });
      await P.wait(1200);
      await P.useView('详细信息');
      await P.wait(600);

      const tgtPath = KB + '/' + tgtRel + '/笔记9.md';
      const backPath = dragPath;
      let earlyExpanded = null;
      let expanded = false;
      let moved = false;
      let undone = false;
      try {
        let node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === tgtRel; });
        if (!node) { note('树里找不到目标节点 ' + tgtRel); }
        if (node && node.getAttribute('aria-expanded') === 'true') {
          P.click(node.querySelector('.kbw-tree-caret'));
          await P.wait(500);
          node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === tgtRel; });
        }
        if (node && node.getAttribute('aria-expanded') !== 'false') note('前提：目标节点该是折叠的（实际 aria-expanded=' + (node ? node.getAttribute('aria-expanded') : '(无)') + '）');
        const row = P.q('.kbw-trow[data-path="' + dragPath + '"]') || P.qa('.kbw-trow[data-path]')[0];
        if (!row) note('这一层没有可拖的行');
        if (node && row) {
          const s = P.aimAt(row);
          const t = P.rectAt(node);
          P.pointerDownAt(s.x, s.y);
          await P.wait(80);
          P.pointerMoveTo(s.x + 40, s.y + 40); // 越过阈值 → 进入拖动
          await P.wait(350);
          // ① 掠过 250ms 就移开 —— 不该展开
          P.pointerMoveTo(t.x, t.y);
          await P.wait(250);
          P.pointerMoveTo(s.x + 60, s.y + 60);
          await P.wait(600);
          const n1 = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === tgtRel; });
          earlyExpanded = n1 ? n1.getAttribute('aria-expanded') : null;
          if (earlyExpanded === 'true') note('提前移开也展开了（计时器没被清）');
          // ② 再掠回：停够 ~500ms → 真展开
          P.pointerMoveTo(t.x, t.y);
          await P.wait(900);
          const n2 = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === tgtRel; });
          expanded = !!n2 && n2.getAttribute('aria-expanded') === 'true';
          if (!expanded) note('停留 ~500ms 没展开（aria-expanded=' + (n2 ? n2.getAttribute('aria-expanded') : '(节点没了)') + '）');
          // ③ 同一手势直接落进去（松手点还在那个节点上；展开会让树重绘 —— 坐标不变）
          P.pointerUpAt(t.x, t.y);
          await P.wait(2400);
          moved = !!app.vault.getAbstractFileByPath(tgtPath);
          if (!moved) note('展开之后同一手势没落进去（' + tgtPath + ' 不存在）');
          if (moved && app.vault.getAbstractFileByPath(backPath)) { moved = false; note('新位置有了、老位置还在 —— 不是搬'); }
          if (moved) {
            const undoBar = P.q('.kbw-undobar');
            const undoBtn = undoBar ? P.btnByText('撤销', undoBar) : null;
            if (undoBtn) { P.click(undoBtn); await P.wait(2400); undone = !!app.vault.getAbstractFileByPath(backPath); if (!undone) note('撤销之后没回原位'); }
            else note('搬完没出撤销条');
          }
        }
      } finally {
        P.pointerCancelAt(0, 0);
        await P.wait(200);
        if (!app.vault.getAbstractFileByPath(backPath)) {
          const f = app.vault.getAbstractFileByPath(tgtPath);
          if (f) { await app.fileManager.renameFile(f, backPath); await P.wait(1200); }
        }
        await P.dropGridDir('悬包');
        await P.dropGridDir('悬展');
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: '提前移开=' + (earlyExpanded === 'false' ? '未展开 ✓' : String(earlyExpanded)) + ' · 停留后展开=' + expanded + ' · 落进去=' + moved + '（撤销=' + undone + '）' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-悬停展开树.png',
  },
  {
    /**
     * P7.1c · **⑤ 多选整组拖**（代码 P6 起就有，本轮补真机判据）：
     * 网格里选中 3 篇 → 拖其中一格 → 浮标「3 篇」· 一次搬完 · **一条撤销条把 3 篇全带回来**。
     * 夹具自造（__探针三拖 + 甲/乙/丙 三篇 —— 名字刻意不叫「笔记N」，避免与目标目录撞名）。
     */
    name: 'P7.1c · 多选整组拖：浮标「3 篇」· 一次搬完 · 一条撤销条全还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      const NL = String.fromCharCode(10);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      const sbox = P.q('.kbw-search');
      if (sbox && sbox.value) { sbox.value = ''; sbox.dispatchEvent(new Event('input', { bubbles: true })); await P.wait(500); }

      const dirRel = '__探针三拖';
      const names = ['甲', '乙', '丙'];
      const body = function (name) {
        return ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-10-03', 'tags: []', '---', '# ' + name].join(NL) + NL;
      };
      let movedAll = false;
      let undoneAll = false;
      let ghostText = null;
      try {
        try { await app.vault.createFolder(KB + '/' + dirRel); } catch (e) { /* 已存在 */ }
        for (const n of names) {
          const p = KB + '/' + dirRel + '/' + n + '.md';
          if (!app.vault.getAbstractFileByPath(p)) await app.vault.create(p, body(n));
        }
        for (let i = 0; i < 20; i += 1) {
          await P.wait(250);
          const seen = ctx.index.notes().filter(function (e) { return e.effectivePosition === dirRel; }).length;
          if (seen >= 3) break;
        }
        ctx.goNotes({ dir: dirRel });
        await P.wait(1200);
        await P.useView('网格');
        await P.wait(600);

        const target = '00_Inbox';
        const clash = names.filter(function (n) { return app.vault.getAbstractFileByPath(KB + '/' + target + '/' + n + '.md'); });
        if (clash.length > 0) note('目标目录里已有同名文件（撞名会跳过）：' + clash.join('、'));
        const cells = P.qa('.kbw-gcell[data-path]');
        if (cells.length < 3) note('网格里只有 ' + cells.length + ' 格（seed 没生效？）');
        if (cells.length >= 3 && clash.length === 0) {
          // 选中 3 格：先点第一格，再 Ctrl 加选两格
          const pt = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width, 100) / 2), y: Math.round(r.top + r.height / 2) }; };
          P.click(cells[0]);
          await P.wait(300);
          for (const c of [cells[1], cells[2]]) {
            const p = pt(c);
            c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, ctrlKey: true }));
            await P.wait(250);
          }
          const selCount = P.qa('.kbw-gcell.is-selected').length;
          if (selCount !== 3) note('选中数该是 3（实际 ' + selCount + '）');
          const src = cells[0];
          const s = P.aimAt(src);
          const node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === target; });
          if (!node) note('树里找不到 ' + target + ' 节点');
          const t = P.rectAt(node);
          P.pointerDownAt(s.x, s.y);
          await P.wait(80);
          P.pointerMoveTo(s.x + 40, s.y + 40);
          await P.wait(400);
          const ghost = P.q('.kbw-dragghost');
          ghostText = ghost ? P.text(ghost) : null;
          if (ghostText !== '3 篇') note('拖动浮标该写「3 篇」（实际「' + ghostText + '」）');
          P.pointerMoveTo(t.x, t.y);
          await P.wait(400);
          P.pointerUpAt(t.x, t.y);
          await P.wait(2600);
          movedAll = names.every(function (n) { return !!app.vault.getAbstractFileByPath(KB + '/' + target + '/' + n + '.md'); });
          if (!movedAll) note('不是 3 篇都搬到了 ' + target);
          const leftOld = names.filter(function (n) { return !!app.vault.getAbstractFileByPath(KB + '/' + dirRel + '/' + n + '.md'); });
          if (leftOld.length > 0) note('老的还在（不是搬）：' + leftOld.join('、'));
          if (movedAll) {
            const undoBar = P.q('.kbw-undobar');
            const undoBtn = undoBar ? P.btnByText('撤销', undoBar) : null;
            if (undoBtn) {
              P.click(undoBtn);
              await P.wait(2600);
              undoneAll = names.every(function (n) { return !!app.vault.getAbstractFileByPath(KB + '/' + dirRel + '/' + n + '.md'); });
              if (!undoneAll) note('一条撤销条没把 3 篇全带回来（这是"一次 mover = 一条撤销"的判据）');
            } else note('整组搬完没出撤销条');
          }
        }
      } finally {
        P.pointerCancelAt(0, 0);
        await P.wait(200);
        // 兜底：两边位置都清（认名字，只删自造的 甲/乙/丙）
        for (const n of names) {
          const stray = app.vault.getAbstractFileByPath(KB + '/00_Inbox/' + n + '.md');
          if (stray) await app.vault.delete(stray, true);
        }
        const dir = app.vault.getAbstractFileByPath(KB + '/' + dirRel);
        if (dir) await app.vault.delete(dir, true);
        await P.wait(800);
        const bar = P.q('.kbw-notes-bar.is-batch');
        if (bar) {
          const x2 = Array.from(bar.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
          if (x2) { P.click(x2); await P.wait(300); }
        }
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: '浮标「' + ghostText + '」· 3 篇全搬=' + movedAll + ' · 一条撤销全还原=' + undoneAll +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-多选整组拖.png',
  },
  {
    /**
     * P7.1c · **⑥ 边缘自动滚动 + Home / End**（同一步，两者都吃"列表够长"这个前提）。
     * 夹具：__探针滚（60 篇 —— 网格 6 排左右，真机上有滚余量）。
     * ① 拖动中把指针压进网格下缘带 → scrollTop **真的涨**（>20）；移回中间 → 停（两次采样差 ≤2）；
     *    Esc 中止（不许留在拖动里）。
     * ② End → 光标到最后一格且它滚进了视野；Home → 光标回头格、scrollTop 归零附近。
     */
    name: 'P7.1c · 边缘自动滚动（拖动中 scrollTop 真涨、离开即停）· Home/End 光标到首尾并滚进视野',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      const sbox = P.q('.kbw-search');
      if (sbox && sbox.value) { sbox.value = ''; sbox.dispatchEvent(new Event('input', { bubbles: true })); await P.wait(500); }
      const sendKey = (k) => {
        const root = P.q('.kbw-root');
        if (!root) return false;
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        root.focus();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        return true;
      };

      await P.dropGridDir('滚');
      const dirRel = await P.seedGridDir('滚', 60);
      const node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dirRel; });
      if (node) { P.click(node); await P.wait(1200); }
      else { ctx.goNotes({ dir: dirRel }); await P.wait(1200); }
      /**
       * 明细档（60 行 × 31px ≈ 1860px，任何窗口都有滚余量）。
       * ⚠️ 第一版用网格：60 格在宽窗口里恰好塞得下（scrollHeight-clientHeight≈0），
       * "前提不成立"当场红 —— 滚的是两档共用那一份助手，明细档验它一样算数。
       */
      await P.useView('详细信息');
      await P.wait(700);

      let scrolledDuring = -1;
      let stoppedAfterLeave = null;
      let endOk = false;
      let homeOk = false;
      try {
        const g = P.q('.kbw-notes-list');
        if (!g) return { ok: false, info: '找不到 .kbw-notes-list（明细档没起来？）' };
        g.scrollTop = 0;
        await P.wait(200);
        const overflow = g.scrollHeight - g.clientHeight;
        if (overflow < 20) note('前提不成立：列表没有滚余量（scrollHeight-clientHeight=' + overflow + '）—— 这条会空转');
        const rowsL = P.qa('.kbw-trow[data-path]');
        if (rowsL.length < 10) note('列表里只有 ' + rowsL.length + ' 行（seed 没生效？）');

        // ① 拖动中压进下缘带
        const src = rowsL[0];
        const s = P.aimAt(src);
        P.pointerDownAt(s.x, s.y);
        await P.wait(80);
        P.pointerMoveTo(s.x + 40, s.y + 40);
        await P.wait(350);
        const dragOn = document.documentElement.classList.contains('kbw-dragging');
        if (!dragOn) note('拖动没起来（根上没有 kbw-dragging）—— 下面的滚判据都不算数');
        if (!P.q('.kbw-dragghost')) note('拖动浮标不在（拖动没起来？）');
        const r = g.getBoundingClientRect();
        const bandX = Math.round(r.left + r.width / 2);
        const bandY = Math.round(r.bottom - 8); // 距下缘 8px：带内、速度约 5/6 满速
        P.pointerMoveTo(bandX, bandY);
        await P.wait(250);
        P.pointerMoveTo(bandX, bandY - 2); // 再喂一发移动（速度按最新位置重算）
        await P.wait(900);
        scrolledDuring = g.scrollTop;
        if (!(scrolledDuring > 20)) note('拖到下缘带 1 秒，scrollTop 还是 ' + Math.round(scrolledDuring) + '（该滚起来）');
        // 移回中间 → 该停
        const midY = Math.round(r.top + r.height / 2);
        P.pointerMoveTo(bandX, midY);
        await P.wait(500);
        const st1 = g.scrollTop;
        await P.wait(400);
        const st2 = g.scrollTop;
        stoppedAfterLeave = Math.abs(st2 - st1);
        if (!(stoppedAfterLeave <= 2)) note('离开边缘带之后还在滚（两次采样差 ' + Math.round(stoppedAfterLeave) + '）');
        // Esc 中止拖动（不许留在拖动里）
        P.key('Escape');
        await P.wait(500);
        if (P.q('.kbw-dragghost')) note('Esc 之后拖动浮标还在（拖动没中止）');

        // ② Home / End（明细档；网格档那半边离线用例管着，这里量"滚进视野"）
        sendKey('End');
        await P.wait(700);
        const cur = P.qa('.kbw-trow.is-cursor');
        const lastRow = rowsL[rowsL.length - 1];
        endOk = cur.length === 1 && cur[0] === lastRow;
        if (!endOk) note('End 之后光标该在最后一行（实际 ' + cur.length + ' 个 is-cursor）');
        if (endOk) {
          const cr = lastRow.getBoundingClientRect();
          const gr = g.getBoundingClientRect();
          const visible = cr.top >= gr.top - 4 && cr.bottom <= gr.bottom + 4;
          if (!visible) note('End 之后最后一行没滚进视野（几何：行 ' + Math.round(cr.top) + '-' + Math.round(cr.bottom) + ' vs 容器 ' + Math.round(gr.top) + '-' + Math.round(gr.bottom) + '）');
        }
        sendKey('Home');
        await P.wait(700);
        const cur2 = P.qa('.kbw-trow.is-cursor');
        homeOk = cur2.length === 1 && cur2[0] === rowsL[0];
        if (!homeOk) note('Home 之后光标该回第一行');
        if (homeOk) {
          /**
           * 判据 = **首行可见**（不是 scrollTop 归 0）：表头是 sticky 的，
           * 「scrollIntoView(block:'nearest')」把首行对到**表头之下**就够了 ——
           * 那时 scrollTop 本来就停在表头高度那一段（第一版写 scrollTop<=4，假红）。
           */
          const r0 = rowsL[0].getBoundingClientRect();
          const gr2 = g.getBoundingClientRect();
          if (!(r0.top >= gr2.top - 4 && r0.bottom <= gr2.bottom + 4)) note('Home 之后首行没滚进视野（行 ' + Math.round(r0.top) + '-' + Math.round(r0.bottom) + ' vs 容器 ' + Math.round(gr2.top) + '-' + Math.round(gr2.bottom) + '，scrollTop=' + Math.round(g.scrollTop) + '）');
        }
      } finally {
        P.pointerCancelAt(0, 0);
        await P.wait(200);
        const bar = P.q('.kbw-notes-bar.is-batch');
        if (bar) {
          const x2 = Array.from(bar.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
          if (x2) { P.click(x2); await P.wait(300); }
        }
        await P.dropGridDir('滚');
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: '拖动中 scrollTop=' + Math.round(scrolledDuring) + '（>20 才算滚起来）· 离开后差=' + (stoppedAfterLeave == null ? '(没采到)' : Math.round(stoppedAfterLeave)) + ' · End=' + endOk + ' · Home=' + homeOk +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-边缘滚动与HomeEnd.png',
  },
  {
    /**
     * P7.1c · **⑦ 列宽双击自适应**（合集 17.9③）。
     * 夹具：__探针列宽（一篇超长名 + 一篇短名）。先把名称列拖窄（长名溢出 —— 前提自证），
     * 再双击列宽抓手 → 宽度长到"刚好放下"（该列所有名称格都不再溢出）+ 宽度真的落盘。
     */
    name: 'P7.1c · 列宽双击自适应：拖窄 → 双击抓手 → 宽到刚好放下 + 落盘',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      const NL = String.fromCharCode(10);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      const widths0 = Object.assign({}, ctx.settings.get().columnWidths);

      const dirRel = '__探针列宽';
      const longName = '__探针超长名字测一测双击自适应能不能把它装下-一二三四五六七八九十';
      const longPath = KB + '/' + dirRel + '/' + longName + '.md';
      const shortPath = KB + '/' + dirRel + '/短.md';
      const body = function (name) {
        return ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-10-03', 'tags: []', '---', '# ' + name].join(NL) + NL;
      };
      let narrowW = 0;
      let fitW = 0;
      let overflowed = false;
      let stillOver = -1;
      let saved = null;
      try {
        try { await app.vault.createFolder(KB + '/' + dirRel); } catch (e) { /* 已存在 */ }
        if (!app.vault.getAbstractFileByPath(longPath)) await app.vault.create(longPath, body('长名'));
        if (!app.vault.getAbstractFileByPath(shortPath)) await app.vault.create(shortPath, body('短'));
        for (let i = 0; i < 20; i += 1) {
          await P.wait(250);
          const seen = ctx.index.notes().filter(function (e) { return e.effectivePosition === dirRel; }).length;
          if (seen >= 2) break;
        }
        ctx.goNotes({ dir: dirRel });
        await P.wait(1200);
        await P.useView('详细信息');
        await P.wait(700);

        const th = P.qa('.kbw-table th').find(function (t) { return t.dataset.col === 'name'; });
        /**
         * ⚠️ 量**列宽**要读「col 元素」的 width，别读 th 实宽：表格是 width:100%，
         * 列宽总和小于容器时浏览器会按比例**拉伸**各列 —— th 实宽 ≠ 写下去的那个数
         *（第一版拿 th 实宽和落盘值比，差 78px 假红）。
         */
        const colW = function () {
          const col = P.q('.kbw-table col[data-col="name"]');
          return col ? (parseFloat(col.style.width || '0') || 0) : 0;
        };
        if (!th) { note('找不到名称列表头'); }
        if (th) {
          const grip = th.querySelector('.kbw-col-grip');
          if (!grip) note('名称列上没有列宽抓手');
          if (grip) {
            /**
             * 前提自证：**长名那一格真的在溢出**（span 是 ellipsis 容器：scrollWidth 才是全文宽）。
             * ⚠️ "先拖窄"只是**准备动作**、不是判据 —— 当前宽度装不下就直接开测
             *（第一版把"必须拖到 ≤200"写成前提，拖拽是合成的、命中区又窄，
             * 每轮夹到的数都不一样，白白假红）。溢出成立 ⇒ 自适应必然**变宽**，
             * "变宽"那条判据由它兜住。
             */
            const spanOver = function () {
              const td = P.q('.kbw-trow[data-path="' + longPath + '"] td[data-col="name"]');
              const nm = td ? td.querySelector('.kbw-name') : null;
              return !!nm && nm.scrollWidth > nm.clientWidth + 1;
            };
            if (!spanOver()) {
              const g0 = P.center(grip);
              await P.dragMouse({ x: g0.x, y: g0.y }, { x: 8, y: g0.y }, 10);
              await P.wait(500);
            }
            narrowW = colW();
            overflowed = spanOver();
            if (!overflowed) note('前提不成立：长名没在溢出（列宽 ' + Math.round(narrowW) + '）—— 判据会空转');
            // 双击抓手 = 按内容自适应
            // ⚠️ 重新取：刚才那次拖动会顺带落盘 → 列表重画 → 旧抓手已成**游离节点**
            //（在游离节点上派事件量到的是死树，全 0 宽 —— 第一版就这么假红的）
            const grip2 = P.q('.kbw-table th[data-col="name"] .kbw-col-grip') || grip;
            grip2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
            await P.wait(800);
            fitW = colW();
            if (!(fitW > narrowW + 10)) note('双击之后没变宽（' + Math.round(narrowW) + ' → ' + Math.round(fitW) + '）');
            // 宽到刚好放下：这一列所有名称格都不再溢出
            const over = P.qa('.kbw-trow td[data-col="name"] .kbw-name').filter(function (n) { return n.scrollWidth > n.clientWidth + 1; });
            stillOver = over.length;
            if (stillOver > 0) note('自适应之后还有 ' + stillOver + ' 格在溢出（没"宽到刚好放下"）');
            if (fitW > 900 + 1) note('宽度超了上限 900（实际 ' + Math.round(fitW) + '）');
            // 落盘：设置里的宽度 ≈ 界面量到的
            saved = ctx.settings.get().columnWidths['name'];
            if (!(typeof saved === 'number' && Math.abs(saved - fitW) <= 3)) note('落盘宽度与界面差太多（盘 ' + saved + ' vs 界面 ' + Math.round(fitW) + '）');
          }
        }
      } finally {
        // 列宽是落盘偏好 —— 拨回基线（这批宽度别漏给下一轮/别的步骤）
        await ctx.settings.save({ columnWidths: widths0 });
        await P.wait(300);
        for (const p of [longPath, shortPath]) {
          const f = app.vault.getAbstractFileByPath(p);
          if (f) await app.vault.delete(f, true);
        }
        const d = app.vault.getAbstractFileByPath(KB + '/' + dirRel);
        if (d) await app.vault.delete(d, true);
        await P.wait(600);
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: '拖窄到 ' + Math.round(narrowW) + '（溢出前提=' + overflowed + '）→ 双击自适应 ' + Math.round(fitW) + ' · 剩余溢出格=' + stillOver + ' · 落盘=' + saved +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-列宽自适应.png',
  },
  {
    /**
     * P7.1c · **文件夹行加条**（用户 2026-10-03）：标记聚合 / 属性列横杠 / 创建日期。
     * 夹具三个顶层目录：__探针夹标（缺.md 空文件 → 有标记）/ __探针夹净（齐活儿 → 「—」）/
     * __探针夹空（空目录 → 短词「空」）。顺带把「创建日期」列从列菜单里勾出来，
     * 验它给的是**文件夹的真创建时间**（adapter.stat 的 ctime 现算对照）。
     *
     * P7.7c · 10.5 扩：短词（待整理/空/错位·断链·未名）+ **笔记行几何** ——
     * 新增夹具 __探针夹三/未命名.md（错位+断链+未名 三枚并排）：三枚不重叠、不裁切、
     * 标记列列宽双边（装得下两三枚短词、也没被撑爆）。
     * ⚠️ P7.12 收尾修正（真机抓到）：「缺项」随 v2 退休（#21.4）—— 第三枚从"缺必填"
     * 换成**断链**（指向不存在目标的 [[双链]]）；夹具每次**重写刷新**，防旧跑残留。
     */
    name: 'P7.1c+P7.7c · 文件夹行短词（待整理/空）· 笔记行三枚短词不重叠不裁切 · 列宽双边 · 属性列横杠 · 创建日期',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      const NL = String.fromCharCode(10);
      P.closeAll(4);
      await P.wait(400);
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x0 = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x0) { P.click(x0); await P.wait(400); }
      }
      const view0 = ctx.settings.get().notesView;
      const sbox = P.q('.kbw-search');
      if (sbox && sbox.value) { sbox.value = ''; sbox.dispatchEvent(new Event('input', { bubbles: true })); await P.wait(500); }

      const dFlag = '__探针夹标';
      const dClean = '__探针夹净';
      const dEmpty = '__探针夹空';
      const dThree = '__探针夹三';
      const body = function (name) {
        return ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-10-03', 'tags: []', '文件位置: []', '---', '# ' + name].join(NL) + NL;
      };
      const cdateVisible = () => !!P.q('.kbw-table th[data-col="prop:创建日期"]');
      for (const d of [dFlag, dClean, dEmpty, dThree]) {
        try { await app.vault.createFolder(KB + '/' + d); } catch (e) { /* 已存在 */ }
      }
      const goodA = KB + '/' + dFlag + '/好.md';
      const goodB = KB + '/' + dClean + '/好.md';
      const bad = KB + '/' + dFlag + '/缺.md';
      /** 三标笔记：文件位置 声明 00_Inbox（实际在夹三 → 错位红）+ 一条指向不存在目标的 [[双链]]
       *（断链红）+ 名字就是占位名「未命名」（未名黄）→ 三枚并排（P7.7c · 10.5 的几何夹具）。
       * ⚠️ P7.12 收尾：「缺项」随 v2 退休 —— 原来的第三枚是"缺 状态/创建日期"，已换成断链。 */
      const three = KB + '/' + dThree + '/未命名.md';
      const threeText = ['---', '类型: 笔记', '文件位置: [00_Inbox]', 'tags: []', '---', '# 未命名', '', '[[__探针断链目标__]]'].join(NL) + NL;
      if (!app.vault.getAbstractFileByPath(goodA)) await app.vault.create(goodA, body('好'));
      if (!app.vault.getAbstractFileByPath(goodB)) await app.vault.create(goodB, body('好'));
      if (!app.vault.getAbstractFileByPath(bad)) await app.vault.create(bad, '');
      // ⚠️ 每次**重写刷新**：上一次跑留下的旧内容（缺项版）会让本步恒红 —— 夹具要自刷新
      {
        const oldThree = app.vault.getAbstractFileByPath(three);
        if (oldThree) await app.vault.delete(oldThree, true);
        await app.vault.create(three, threeText);
      }
      for (let i = 0; i < 24; i += 1) {
        await P.wait(250);
        const seen = ctx.index.notes().filter(function (e) {
          return e.effectivePosition === dFlag || e.effectivePosition === dClean || e.effectivePosition === dThree;
        }).length;
        if (seen >= 4) break;
      }
      let ctimeCell = '';
      let ctimeExpect = '';
      let ctimeOk = false;
      let flagOk = false;
      let cleanOk = false;
      let emptyOk = false;
      let dashOk = false;
      let wordsOk = false;
      let overlapOk = false;
      let clipOk = false;
      let bleedOk = false;
      let colW = 0;
      let widthOk = false;
      let widths0 = null;
      try {
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode) { P.click(rootNode); await P.wait(900); }
        await P.useView('详细信息');
        await P.wait(700);

        const rowOf = (d) => P.qa('.kbw-frow').find(function (r) { return r.dataset.dir === d; });
        const flagOf = (r) => (r ? r.querySelector('td[data-col="flags"] .kbw-flag') : null);
        const rFlag = rowOf(dFlag);
        const rClean = rowOf(dClean);
        const rEmpty = rowOf(dEmpty);
        const rThree = rowOf(dThree);
        if (!rFlag || !rClean || !rEmpty || !rThree) note('四个自造目录的文件夹行没画齐（' + [rFlag, rClean, rEmpty, rThree].map(Boolean).join('/') + '）');
        // ① 有标记的 → 短词「待整理」（这里只有黄类：空文件 → 该上黄）
        const f1 = flagOf(rFlag);
        flagOk = !!f1;
        if (!flagOk) note('带标记的文件夹该画胶囊');
        if (f1 && f1.className.indexOf('flag-yellow') < 0) note('只有黄类标记时该上黄（实际 class：' + f1.className + '）');
        if (f1 && P.text(f1).indexOf('待整理') < 0) note('有标记的文件夹该画短词「待整理」（实际「' + P.text(f1) + '」）');
        // ①b 子树里有红类（错位）→ 红档 + 同样「待整理」（轻重才分色，字形不分）
        const f4 = flagOf(rThree);
        if (!f4) note('夹三（有红类标记）该画胶囊');
        else {
          if (f4.className.indexOf('flag-red') < 0) note('子树里有红类（错位）时该上红（实际 class：' + f4.className + '）');
          if (P.text(f4).indexOf('待整理') < 0) note('夹三该画「待整理」（实际「' + P.text(f4) + '」）');
        }
        // ② 都干净的 → 「—」
        const cell2 = rClean ? rClean.querySelector('td[data-col="flags"]') : null;
        cleanOk = !!cell2 && P.text(cell2).indexOf('—') >= 0 && !cell2.querySelector('.kbw-flag');
        if (!cleanOk) note('都干净的文件夹该画「—」');
        // ③ 空目录 → 短词「空」（拍板：按原话，空目录也是"要留意"；悬停全句保留）
        const f3 = flagOf(rEmpty);
        emptyOk = !!f3;
        if (!emptyOk) note('空目录该画胶囊（拍板按原话）');
        if (f3 && P.text(f3).indexOf('空') < 0) note('空目录该画短词「空」（实际「' + P.text(f3) + '」）');
        if (f3 && (f3.getAttribute('aria-label') || '').indexOf('还没有笔记') < 0) note('空目录的胶囊悬停该写「文件夹里还没有笔记」（aria-label，P7.12 #7 起不再挂 title）');
        // ④ 属性列（类型/状态）→ 横杠（不是空格子）
        // ⚠️ **P8 收口（2026-10-12 · 老账）改的**：「领域」v2（P7.12）已退役、
        //    默认可见列里没有它 —— 在**默认设置**的库上「prop:领域」那一格恒 null，
        //    旧判据（三栏都要）是一颗**潜伏雷**（存量设置里恰好还显示着它时才碰巧绿）。
        //    判据收成 类型/状态 **两栏**。⚠️ 本步**未在本机真机跑过**（随探针欠账）。
        const t = rClean ? rClean.querySelector('td[data-col="prop:类型"]') : null;
        const s = rClean ? rClean.querySelector('td[data-col="prop:状态"]') : null;
        dashOk = [t, s].every(function (c) { return !!c && P.text(c).indexOf('—') >= 0; });
        if (!dashOk) note('类型/状态 两栏该给横杠（' + [t, s].map(function (c) { return c ? P.text(c) : '(无格)'; }).join('/') + '）');
        // ⑤ 创建日期列：从列菜单勾出来 → 文件夹行给真创建时间
        if (!cdateVisible()) {
          const colBtn = P.qa('.kbw-notes-tools .kbw-btn').find(function (b) { return P.text(b) === '列'; });
          if (colBtn) {
            P.click(colBtn);
            await P.wait(400);
            if (!P.clickMenu('其他')) note('列菜单里找不到「其他」分组');
            await P.wait(400);
            if (!P.clickMenu('创建日期')) note('「其他」里找不到「创建日期」');
            await P.wait(600);
            P.key('Escape');
            await P.wait(400);
          } else note('工具条上找不到「列」按钮');
        }
        if (cdateVisible()) {
          let cell = null;
          for (let i = 0; i < 10; i += 1) {
            await P.wait(300);
            const r = rowOf(dClean);
            cell = r ? r.querySelector('td[data-col="prop:创建日期"]') : null;
            if (cell && /[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(P.text(cell))) break;
          }
          ctimeCell = cell ? P.text(cell) : '(没有格)';
          const st = await app.vault.adapter.stat(KB + '/' + dClean);
          if (st && st.ctime > 0) {
            const dd = new Date(st.ctime);
            const pad = (n) => String(n).padStart(2, '0');
            ctimeExpect = dd.getFullYear() + '-' + pad(dd.getMonth() + 1) + '-' + pad(dd.getDate());
          }
          if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(ctimeCell)) note('创建日期没补上真值（实际「' + ctimeCell + '」）');
          else if (ctimeCell !== ctimeExpect) note('创建日期与 adapter.stat 对不上（界面 ' + ctimeCell + ' vs stat ' + ctimeExpect + '）');
          else ctimeOk = true;
          // 验完把列藏回去（不把显隐偏好留给下一轮）
          const colBtn2 = P.qa('.kbw-notes-tools .kbw-btn').find(function (b) { return P.text(b) === '列'; });
          if (colBtn2) {
            P.click(colBtn2);
            await P.wait(400);
            P.clickMenu('其他');
            await P.wait(400);
            P.clickMenu('创建日期');
            await P.wait(500);
            P.key('Escape');
            await P.wait(400);
          }
          if (cdateVisible()) note('创建日期列没藏回去（显隐偏好会漏给下一轮）');
        } else {
          note('创建日期列没勾出来（列菜单那条路没走通）');
        }

        /* ⑦ P7.7c · 10.5：笔记行的短词 + 几何 —— 进「夹三」量那篇三标笔记（错位+断链+未名） */
        /**
         * ⚠️ **存量列宽会盖过新默认**（真机实测：本实验库存着 flags:60 —— 那是挤压态，
         * 短词被压到 16px、文字溢出血洗 19/16）。量之前把「标记」列的**存量宽度临时摘掉**
         * （量的是 124 这个新默认），收尾在 finally 里原样还回去（宽度是用户配置，不能吞）。
         * ⚠️ 模块**不订阅** settings 变化（「widths」是构造时抄进 store 的）→ 必须换模块
         * 重建一次（首页 ↔ 全部笔记），光 save 不重画（第一版就是这么量到旧值的）。
         */
        widths0 = Object.assign({}, ctx.settings.get().columnWidths);
        const widthsNoFlags = Object.assign({}, widths0);
        delete widthsNoFlags.flags;
        await ctx.settings.save({ columnWidths: widthsNoFlags });
        ctx.store.set({ activeModule: 'home' });
        await P.wait(500);
        ctx.goNotes({ dir: dThree });
        await P.wait(900);
        const node3 = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === dThree; });
        if (!node3) note('目录树里找不到 ' + dThree);
        else {
          P.click(node3);
          await P.wait(900);
          const row3 = P.rowByPath(KB + '/' + dThree + '/未命名.md');
          const cell3 = row3 ? row3.querySelector('td[data-col="flags"]') : null;
          if (!row3 || !cell3) note('三标笔记的行没画出来（' + dThree + '/未命名.md）');
          else {
            const chips = Array.from(cell3.querySelectorAll('.kbw-flag'));
            const words = chips.map(function (c) { return P.text(c); });
            const want = ['错位', '断链', '未名'];
            wordsOk = chips.length === 3 && want.every(function (w) { return words.indexOf(w) >= 0; });
            if (!wordsOk) note('三标笔记的短词不对（实际 ' + words.join('/') + '，要 错位+断链+未名 各一）');
            if (P.text(cell3).indexOf('⚠') >= 0) note('标记列还在画 ⚠ 字形（该全是短词）');
            const geo = chips.map(function (c) { return c.getBoundingClientRect(); });
            if (!geo.every(function (r) { return r.width > 0 && r.height > 0; })) {
              note('短词胶囊量不到几何（' + (chips[0] ? P.zeroGeoWhy(chips[0]) : '没有胶囊') + '）');
            } else {
              // 不重叠：逐对相邻（后一枚的左边 ≥ 前一枚的右边 − 0.5 容差）
              overlapOk = true;
              for (let i = 1; i < geo.length; i += 1) {
                if (geo[i].left < geo[i - 1].right - 0.5) overlapOk = false;
              }
              if (!overlapOk) note('三枚短词互相重叠（列宽塞不下或 flex 没排开）');
              // 不裁切：格内无横向溢出 + 每枚完整落在格内
              const cr = cell3.getBoundingClientRect();
              clipOk = cell3.scrollWidth <= cell3.clientWidth + 1 &&
                geo.every(function (r) { return r.left >= cr.left - 0.5 && r.right <= cr.right + 0.5; });
              if (!clipOk) note('短词被裁切（scrollWidth ' + cell3.scrollWidth + ' vs clientWidth ' + cell3.clientWidth +
                '；三枚 2 字短词 + 间距 ≈ 102px，列宽 124 − 内边距 20 = 104 是账面）');
              // 挤压：每枚的文字不许溢出自己的胶囊（实测过：窄列把胶囊挤到 16px、文字血洗 19/16）
              bleedOk = chips.every(function (c) { return c.scrollWidth <= c.clientWidth + 1; });
              if (!bleedOk) note('短词文字溢出胶囊（被挤压）—— components.css 里 .kbw-flag 的 flex:none 或列宽没生效');
            }
            // 列宽双边：装得下两三枚短词（≥100）、也没被撑爆（≤170）
            const th = document.querySelector('.kbw-table th[data-col="flags"]');
            colW = th ? Math.round(th.getBoundingClientRect().width) : 0;
            widthOk = colW >= 100 && colW <= 170;
            if (!widthOk) note('标记列宽 ' + colW + 'px 出了双边范围（100–170；账面 124 = 三枚 102 + 内边距 20 + 余量）');
          }
        }
      } finally {
        P.key('Escape');
        for (const p of [goodA, goodB, bad, three]) {
          const f = app.vault.getAbstractFileByPath(p);
          if (f) await app.vault.delete(f, true);
        }
        for (const d of [dFlag, dClean, dEmpty, dThree]) {
          const f = app.vault.getAbstractFileByPath(KB + '/' + d);
          if (f) await app.vault.delete(f, true);
        }
        if (widths0) {
          await ctx.settings.save({ columnWidths: widths0 });
          // 再把模块重建一次：store 里那份 widths 是构造时抄的，不重建就与 settings 不一致
          ctx.store.set({ activeModule: 'home' });
          await P.wait(400);
          ctx.goNotes();
          await P.wait(700);
        }
        await P.wait(800);
        await P.useView(view0 === 'detail' ? '详细信息' : '网格');
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
        const rootNode2 = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
        if (rootNode2) { P.click(rootNode2); await P.wait(600); }
      }
      return {
        ok: problems.length === 0,
        info: '有标记「待整理」=' + flagOk + ' · 干净「—」=' + cleanOk + ' · 空目录「空」=' + emptyOk + ' · 三栏横杠=' + dashOk +
              ' · 创建日期「' + ctimeCell + '」（stat 对照 ' + ctimeExpect + '，对上=' + ctimeOk + '）' +
              ' · 三标短词=' + wordsOk + ' · 不重叠=' + overlapOk + '/不裁切=' + clipOk + '/不挤压=' + bleedOk + '/列宽=' + colW + 'px(' + widthOk + ')' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.1c-文件夹标记与创建时间.png',
  },
  {
    name: '快捷键表：点 ⌨ 就能开 · 14 个动作 · Esc 关闭（按键路径看绑定）· **默认键不与本体冲突**',
    script: `(async () => {
      const P = window.__kbwProbe;
      // ① 点顶栏 ⌨（真实鼠标路径）
      const gear = P.qa('.kbw-topbar-actions button').find((b) => (b.getAttribute('aria-label') ?? '').includes('快捷键'));
      if (!gear) return { ok: false, info: '找不到顶栏 ⌨ 按钮' };
      P.click(gear);
      await P.wait(300);
      // ⚠️ 按**身份**数动作行（D2 之后 tbody 里还有 scope 分组标题行）——
      // 数 tbody 的总行数会被排版改动带跑偏（这条判据原先就是那么写的）
      const keysModal = P.q('.kbw-modal');
      const byClick = keysModal ? keysModal.querySelectorAll('tbody tr[data-keys-row]').length : 0;
      const keyGroups = keysModal ? Array.from(keysModal.querySelectorAll('tbody tr.kbw-keys-group')).map((r) => P.text(r)) : [];
      P.key('Escape');
      await P.wait(200);
      // ② 点一下模块区把焦点交给工作台，再按 ?
      P.click(P.q('.kbw-modhost'));
      await P.wait(120);
      const km = P.ctx().keymap;
      const boundKey = (km.keysFor ? km.keysFor('shortcuts-help') : ['?'])[0];
      const kmInfo = {
        shortcutKeys: km.keysFor ? km.keysFor('shortcuts-help') : '(没有 keysFor)',
        overrides: P.ctx().settings.get().keymap,
        activeEl: (document.activeElement?.className ?? document.activeElement?.tagName ?? '?') + '',
      };
      // 事件到底有没有到根元素
      const rootEl = P.q('.kbw-root');
      let reached = 0;
      const spy = () => { reached += 1; };
      rootEl.addEventListener('keydown', spy, true);
      const focusOwner = P.key(boundKey);
      await P.wait(300);
      rootEl.removeEventListener('keydown', spy, true);
      const byKey = P.q('.kbw-modal') ? P.q('.kbw-modal').querySelectorAll('tbody tr[data-keys-row]').length : 0;
      const root = P.q('.kbw-root');
      P.key('Escape');
      await P.wait(250);
      const closed = !P.q('.kbw-modal');
      const shadowed = !!km.ownerOf(boundKey, 'shortcuts-help');
      // 键位被别的动作占着 → 是用户自己改的配置。这时**不假装验过**：
      // 按键路径明确标成"跳过"，而不是硬判通过
      const keyOk = shadowed ? true : byKey === 14;
      /**
       * **默认键位不与本体冲突**（e2 期 §4.1 开工时那条要求："先在真机上核对，
       * 别照记忆抄一张本体键位表"）。做法是**枚举**：把本体每个命令的默认键拿出来，
       * 与插件 14 个动作的默认键求交集 —— 交上了就是"抢键"，直接判红。
       * ⚠️ 两处口径：
       *  ① 只比**默认键**（用户自己改过的键位不算冲突 —— 那是他的选择）；
       *  ② contextmenu 那个动作**跳过**：它本来就是在抢平台的右键（F10 那档），
       *     而平台自己也拿它当默认键（这是设计上故意的重叠）。
       * ⚠️ 注释里不许出现反引号（这一段是模板字符串，一个反引号就提前结束它）。
       */
      const nativeKeys = new Set();
      try {
        const hm = app.hotkeyManager;
        for (const id of Object.keys(app.commands.commands)) {
          /**
           * ⚠️ **排除我们自己的命令**（e2 独立审查 🟡5）：这个枚举是"本体默认键"的来源，
           * 而插件自己的命令也在那个表里 —— 不排除的话，
           * "我们第 5 条命令的 Mod+Alt+N"会被当成**本体**的键，于是"我方动作撞自己命令"
           * 会被误报成本体冲突，而"命令那条键有没有撞本体"反而没人比。
           */
          if (id.indexOf('kb-workbench:') === 0) continue;
          const list = (hm.getDefaultHotkeys && hm.getDefaultHotkeys(id)) || [];
          for (const h of list) nativeKeys.add(((h.modifiers || []).join('+') + '+' + h.key).toLowerCase());
        }
      } catch (e) { /* 拿不到就不判（下面会如实写出来） */ }
      const actionIds = ['focus-search','move-up','move-down','move-left','move-right','toggle-select','range-up','range-down','select-all','open','context-menu','escape','shortcuts-help','quick-switch'];
      const mine = [];
      for (const id of actionIds) {
        for (const k of km.keysFor(id)) mine.push({ id: id, key: k });
      }
      /**
       * 🔴 **raw 键也要进这张网**（独立审查 🟡8）：F2 那笔 P1 老账就是这么活到 P7.1c 的
       * —— 平台默认键撞了，而这张网只比键位表里的 14 个动作。键位写法与 keysFor() 同一套。
       * ⚠️ **已知撞车两条，都是真机实测过的**（写在这里防漂）：
       *   · f2 —— 平台 workspace:edit-file-title 默认键，**真的吃**（document 层
       *     stopImmediatePropagation，工作台根监听收不到）→ 已用工作台 Scope 接管（见坑单）；
       *   · mod+enter —— 平台 editor:open-link-in-new-leaf 默认键，**不吃**（editor 域；
       *     工作台里实测穿过）。
       * 除这两条之外再冒出新撞车 → 当轮红（平台改了绑定 / 我们新加的键撞上了）。
       */
      const RAW_KEYS = [
        { id: 'raw:F2（就地改名）', key: 'f2' },
        { id: 'raw:Del（删除）', key: 'delete' },
        { id: 'raw:Home', key: 'home' },
        { id: 'raw:End', key: 'end' },
        { id: 'raw:mod+Enter（新标签打开）', key: 'mod+enter' },
        { id: 'raw:alt+ArrowUp（回上一级）', key: 'alt+arrowup' },
      ];
      for (const r of RAW_KEYS) mine.push({ id: r.id, key: r.key });
      /**
       * **插件命令自己的默认键也要比**（第 5 条命令的 Mod+Alt+N）——
       * 它是"平台级热键"，撞上本体就是抢键（e2 独立审查 🟡5）。
       */
      try {
        const hm2 = app.hotkeyManager;
        for (const id of Object.keys(app.commands.commands)) {
          if (id.indexOf('kb-workbench:') !== 0) continue;
          const list = (hm2.getDefaultHotkeys && hm2.getDefaultHotkeys(id)) || [];
          for (const h of list) mine.push({ id: id, key: ((h.modifiers || []).join('+') + '+' + h.key).toLowerCase() });
        }
      } catch (e) { /* 同上 */ }
      /**
       * ⚠️ 平台那侧的写法是 「(modifiers.join('+') + '+' + key)」 —— 无修饰键会带一个**前导 +**
       *（「+f2」），与 「keysFor()」 的裸名写法对不上 → 两边**统一归一化**再比
       *（归一化对既有 14 个动作不新增碰撞，真机实测过）。
       */
      const normKey = (k) => { const t = String(k).toLowerCase(); return t.charAt(0) === '+' ? t.slice(1) : t; };
      const nativeNorm = new Set(Array.from(nativeKeys).map(normKey));
      const KNOWN_CLASH = ['f2', 'mod+enter']; // 见 RAW_KEYS 那段（两条都实测过）
      const clash = mine.filter((x) => nativeNorm.has(normKey(x.key)) && x.id !== 'context-menu' && KNOWN_CLASH.indexOf(normKey(x.key)) < 0);
      const skippedKey = shadowed ? '（按键路径跳过：键位被占，见键位表）' : '';
      /**
       * D2：按 scope 分了两组（工作台内 4 / 表格·网格·卡片区 10），组标题行带条数。
       * ⚠️ 判据要**成对**判（组标题存在 **且** 每组条数对），只判"有标题行"在只有一组时也成立。
       */
      const groupsOk = keyGroups.length === 2 &&
        keyGroups.join('|').indexOf('工作台内 · 4 个动作') >= 0 &&
        keyGroups.join('|').indexOf('表格 / 网格 / 卡片区 · 10 个动作') >= 0;
      return {
        ok: byClick === 14 && keyOk && closed && clash.length === 0 && groupsOk,
        info: '点 ⌨ 开出 ' + byClick + ' 条｜分组=' + (keyGroups.length ? keyGroups.join(' / ') : '（没读到）') +
              '｜按 ? 开出 ' + byKey + ' 条（焦点在 ' + focusOwner + '）｜Esc 关闭=' + closed +
              '｜与本体默认键的冲突=' + (clash.length ? JSON.stringify(clash) : '无（比了 ' + nativeNorm.size + ' 个本体默认键，14 动作 + 6 个 raw 键）') +
              '｜raw 已知撞车=' + RAW_KEYS.filter((r) => nativeNorm.has(r.key)).map((r) => r.key).join('/') + '（f2 = 真吃·Scope 接管；mod+enter = editor 域·实测穿过）' +
              '｜键盘标记=' + (root?.classList.contains('kbw-kbd') ?? false) +
              '｜按的键=' + JSON.stringify(boundKey) + skippedKey + '（当前绑定 ' + JSON.stringify(kmInfo.shortcutKeys) + '，覆盖 ' + JSON.stringify(kmInfo.overrides) + '）' +
              '｜事件到达根=' + reached + '｜按下前焦点=' + kmInfo.activeEl,
      };
    })()`,
  },
  {
    name: '真移动链路：造一篇 → mover 搬 → 快照 → 还原 → 清理',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const src = kb + '/00_Inbox/__探针临时.md';
      const dst = kb + '/02_Areas/内容创作/__探针临时.md';
      // 造
      const existing = app.vault.getAbstractFileByPath(src);
      if (existing) await app.vault.delete(existing, true);
      const file = await app.vault.create(src, '---\\n类型: 想法\\n领域: 灵感杂记\\n状态: 进行中\\n创建日期: 2026-09-24\\ntags: []\\n---\\n# 探针临时\\n\\n这是真机探针造的，用完会删掉。\\n');
      await P.wait(400);

      const before = (await ctx.report.recent(200)).map((f) => f.path);
      const r = await ctx.mover.move({ targets: [{ dir: kb + '/02_Areas/内容创作', files: [file] }], source: 'batch', reason: '真机探针：移动链路' });
      await P.wait(300);
      const notice = P.text(P.q('.kbw-notice'));
      const after = (await ctx.report.recent(200)).map((f) => f.path);
      const created = after.filter((p) => !before.includes(p));

      const restored = await ctx.snapshot.restore(r.snapshotId);
      await P.wait(500);
      const back = !!app.vault.getAbstractFileByPath(src);
      // 清理
      const f2 = app.vault.getAbstractFileByPath(src);
      if (f2) await app.vault.delete(f2, true);
      const strayDest = app.vault.getAbstractFileByPath(dst);
      if (strayDest) await app.vault.delete(strayDest, true);

      // 探针自己造的日志与快照都顺手删掉，别把用户的库越堆越脏
      for (const p of created) { const f = app.vault.getAbstractFileByPath(p); if (f) await app.vault.delete(f, true); }
      const snapsBefore = (await ctx.snapshot.list()).length;
      await ctx.snapshot.remove(r.snapshotId);
      const snapsAfter = (await ctx.snapshot.list()).length;

      const ok = r.moved.length === 1 && !!r.snapshotId && created.length === 1 && back && restored.blocked.length === 0;
      return { ok: ok && snapsAfter === snapsBefore - 1, info: 'moved=' + r.moved.length + '｜快照=' + (r.snapshotId || '无') + '（已清理）｜日志 +' + created.length + '（已清理）｜通知="' + notice.slice(0, 24) + '"｜还原回到原位=' + back + '｜不让路=' + restored.blocked.length };
    })()`,
  },
  {
    name: '撞名护栏：目标已有同名且内容不同 → 拦住、不覆盖、通知写明',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const a = kb + '/00_Inbox/__探针撞名.md';
      const b = kb + '/02_Areas/内容创作/__探针撞名.md';
      for (const p of [a, b]) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      const fm = '---\\n类型: 想法\\n领域: 灵感杂记\\n状态: 进行中\\n创建日期: 2026-09-24\\ntags: []\\n---\\n';
      const src = await app.vault.create(a, fm + '# 源笔记\\n');
      await app.vault.create(b, fm + '# 目标笔记（内容不同）\\n');
      await P.wait(900);
      const r = await ctx.mover.move({
        targets: [{ dir: kb + '/02_Areas/内容创作', files: [src] }],
        source: 'batch',
        reason: '真机探针：撞名护栏',
      });
      await P.wait(600);
      // 通知栈是**最新的在最上面**？不 —— 通知是往下追加的，取"提到撞名"的那条
      const notices = P.qa('.kbw-notice').map((n) => P.text(n));
      const notice = notices.find((t) => t.includes('撞名')) ?? notices[notices.length - 1] ?? '';
      const kept = !!app.vault.getAbstractFileByPath(a);
      const dstFile = app.vault.getAbstractFileByPath(b);
      const dstText = dstFile ? await app.vault.read(dstFile) : '';
      for (const p of [a, b]) {
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      await P.wait(300);
      const swept = await P.sweep([]); // 日志按 __探针 标记清（撞名日志正文里只有文件名）
      const dstOk = dstText.includes('目标笔记');
      const movedOk = r.moved.length === 0;
      const blockedOk = r.blocked.length === 1;
      const noticeOk = notice.includes('撞名');
      return {
        ok: movedOk && blockedOk && kept && dstOk && noticeOk,
        info: 'moved=' + r.moved.length + '｜blocked=' + r.blocked.length + '（' + (r.blocked[0] && r.blocked[0].why) + '）｜源还在=' + kept +
              '｜目标没被覆盖=' + dstOk + '（目标正文="' + dstText.split('#').pop().slice(0, 24) + '"）' +
              '｜通知="' + notice.slice(0, 40) + '"（共 ' + notices.length + ' 条）' +
              '｜自清理：日志 -' + swept.logs + '｜判定：moved=' + movedOk + ' blocked=' + blockedOk + ' kept=' + kept + ' dst=' + dstOk + ' notice=' + noticeOk,
      };
    })()`,
  },
  {
    name: 'P1 · 拖拽（指针序列 helper）：行 → 目录树 → 文件真搬了 + 撤销条撤回',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const rel = kb + '/00_Inbox/__探针拖拽.md';
      const old = app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      const fm = '---\\n类型: 想法\\n领域: 灵感杂记\\n状态: 进行中\\n创建日期: 2026-09-24\\ntags: []\\n---\\n';
      await app.vault.create(rel, fm + '# 探针拖拽\\n');
      await P.wait(900);

      ctx.goNotes({ dir: '00_Inbox' });
      await P.wait(700);
      /**
       * ⚠️ **视图档要自己声明**（P7.1b 补）：这一步要的是**表格行**（.kbw-trow），
       * 而视图档是会话态 —— 前面任何一步停在网格，这里就"一行都找不到"（实测就这么红的）。
       * ⚠️ 先清选择：有选择时工具条整条被批量栏顶掉，seg 按钮根本不在（独立审查 🟢6）。
       * ⚠️ 本步没有 note()（不是那个形状）——失败信息一律走 info。
       */
      const batchX = P.q('.kbw-notes-bar.is-batch');
      if (batchX) {
        const cx = Array.from(batchX.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (cx) { P.click(cx); await P.wait(400); }
      }
      const okView = await P.useView('详细信息');
      await P.wait(400);
      const row = P.rowByPath(rel);
      const nodes = P.qa('[data-drop]');
      const node = nodes.find((i) => i.getAttribute('data-drop') === '02_Areas/内容创作')
        ?? nodes.find((i) => i.getAttribute('data-drop') === '02_Areas');
      if (!row || !node) return { ok: false, info: '行=' + !!row + '｜目标节点=' + !!node + '｜切到详细信息=' + okView };
      const from = P.center(row);
      const to = P.center(node);
      const trail = await P.dragMouse(from, to, 8);
      await P.wait(1200);
      const snapId = await P.snapTop();
      const movedPath = kb + '/02_Areas/内容创作/__探针拖拽.md';
      const altPath = kb + '/02_Areas/__探针拖拽.md';
      const moved = !!app.vault.getAbstractFileByPath(movedPath) || !!app.vault.getAbstractFileByPath(altPath);
      const bar = !!P.q('.kbw-undobar');
      const undoBtn = P.btnByText('撤销', P.q('.kbw-undobar'));
      if (undoBtn) { P.click(undoBtn); await P.wait(1500); }
      const back = !!app.vault.getAbstractFileByPath(rel);
      for (const cand of [rel, movedPath, altPath]) {
        const f = app.vault.getAbstractFileByPath(cand);
        if (f) await app.vault.delete(f, true);
      }
      await P.wait(300);
      const swept = await P.sweep([snapId]);
      const viewTypes = (() => {
        const t = [];
        app.workspace.iterateAllLeaves((l) => t.push(l.view ? l.view.getViewType() : '?'));
        return t;
      })();
      const wbW = (() => {
        const w = app.workspace.getLeavesOfType('kb-workbench-view')[0];
        return w ? Math.round(w.view.containerEl.getBoundingClientRect().width) : -1;
      })();
      return {
        ok: moved && bar && !!undoBtn && back,
        info: '指针序列已发（' + trail.length + ' 步）｜切到详细信息=' + okView + '｜搬到内容创作=' + moved + '｜出撤销条=' + bar +
              '｜撤销后回 Inbox=' + back + '｜自清理：快照 -' + swept.snaps + ' / 日志 -' + swept.logs +
              '｜诊断：视图=' + JSON.stringify(viewTypes) + ' · 工作台宽=' + wbW,
      };
    })()`,
  },
  {
    name: 'P1 · 触屏长按拖动（pointerType=touch，按住 450ms 才进拖动）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const rel = kb + '/00_Inbox/__探针触屏拖.md';
      const old = app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      const fm = '---\\n类型: 想法\\n领域: 灵感杂记\\n状态: 进行中\\n创建日期: 2026-09-24\\ntags: []\\n---\\n';
      await app.vault.create(rel, fm + '# 探针触屏拖\\n');
      await P.wait(900);
      ctx.goNotes({ dir: '00_Inbox' });
      await P.wait(700);
      /** ⚠️ 先清选择 + 视图档自己声明（P7.1b 补，理由见上一条 P1 拖拽步）—— 本步同样没有 note() */
      const batchX = P.q('.kbw-notes-bar.is-batch');
      if (batchX) {
        const cx = Array.from(batchX.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (cx) { P.click(cx); await P.wait(400); }
      }
      const okView = await P.useView('详细信息');
      await P.wait(400);
      const row = P.rowByPath(rel);
      const nodes = P.qa('[data-drop]');
      const node = nodes.find((i) => i.getAttribute('data-drop') === '02_Areas/灵感杂记')
        ?? nodes.find((i) => i.getAttribute('data-drop') === '02_Areas');
      if (!row || !node) return { ok: false, info: '行=' + !!row + '｜目标=' + !!node + '｜切到详细信息=' + okView };
      const r = await P.dragTouch(P.center(row), P.center(node), 4);
      await P.wait(1300);
      const snapId = await P.snapTop();
      const dstPath = kb + '/02_Areas/灵感杂记/__探针触屏拖.md';
      const altPath = kb + '/02_Areas/__探针触屏拖.md';
      const moved = !!app.vault.getAbstractFileByPath(dstPath) || !!app.vault.getAbstractFileByPath(altPath);
      const undoBtn = P.btnByText('撤销', P.q('.kbw-undobar'));
      if (undoBtn) { P.click(undoBtn); await P.wait(1500); }
      const back = !!app.vault.getAbstractFileByPath(rel);
      for (const cand of [rel, dstPath, altPath]) {
        const f = app.vault.getAbstractFileByPath(cand);
        if (f) await app.vault.delete(f, true);
      }
      await P.wait(300);
      const swept = await P.sweep([snapId]);
      return {
        ok: r.held && moved && back,
        info: '长按 450ms 后药丸出现=' + r.held + '（触屏不靠位移阈值启动）｜搬走了=' + moved + '｜撤销回来=' + back +
              '｜自清理：快照 -' + swept.snaps + ' / 日志 -' + swept.logs +
              '｜⚠️ 这是桌面上的合成 touch 事件；真手机手感仍是 P6 的复验项',
      };
    })()`,
  },
  {
    name: 'P1 · 快照面板：列表 / 保留策略（20 个 · 30 天）/ 能关掉',
    script: `(async () => {
      const P = window.__kbwProbe;
      const panel = P.ctx().openSnapshotPanel();
      await P.wait(800);
      const modal = P.q('.kbw-modal');
      if (!modal) return { ok: false, info: '快照面板没打开' };
      const rows = P.qa('.kbw-snap-row:not(.is-head)');
      const head = P.q('.kbw-snap-row.is-head');
      const foot = P.text(modal.querySelector('.kbw-modal-foot') ?? modal);
      const hasPolicy = foot.includes('20') && foot.includes('30') && foot.includes('清理');
      /**
       * ⚠️ 表头只在**有存档时**才画（空列表是一句空态文案）——
       * 探针自己会清掉它造的存档，所以"0 份"是正常状态，不该判红。
       */
      const hasCols = rows.length === 0 ? true : !!head && P.text(head).includes('触发操作');
      const first = rows[0] ? P.text(rows[0]).slice(0, 60) : '（还没有快照）';
      P.key('Escape');
      await P.wait(500);
      const closed = !P.q('.kbw-modal');
      void panel;
      return {
        ok: hasPolicy && hasCols && closed,
        info: '快照 ' + rows.length + ' 份｜表头=' + hasCols + '（0 份时不要求表头）｜保留策略（20 个 / 30 天 + 清理）=' + hasPolicy +
              '｜首行="' + first + '"｜Esc 关掉=' + closed,
      };
    })()`,
  },
  {
    name: 'P2 · 属性迁移：首页那行 → 面板预演（只读，一个字节都不动）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      ctx.store.set({ activeModule: 'home' });
      await P.wait(900);
      const row = P.qa('.kbw-todo').find((t) => P.text(t).includes('的属性还是旧规范'));
      if (!row) {
        /**
         * 迁移是**单向**的：迁完之后首页那行就没了 → 这一步的"完整预演"只在**迁移前**跑得动。
         * 那时也不能空转：断言终态。
         * ⚠️ P7.12（v2）：「缺必填」标记随 #21.4 退休 —— 旧终态断言「flags['missing-required'] === 0」
         * 在 v2 恒假（那个 key 不回 0 而是不存在）。改成对**本步要找的东西**下锚：首页确实没有
         * 「旧规范」那一行（row 为空就是它）+ 把待处理清单原样报出来。
         * 要重新完整验一遍预演：把 .tooling 的迁移前备份换回实验库再跑（preview-recheck）。
         */
        return {
          ok: true,
          info: '这一轮没有可迁的（**已经迁过了**）→ 终态：首页无「旧规范」那行=true｜待处理=' +
                (P.qa('.kbw-todo-t').map((t) => P.text(t)).join(' / ') || '（空）'),
        };
      }
      const rowText = P.text(row);
      const snapsBefore = (await ctx.snapshot.list()).length;
      P.click(row);
      await P.wait(1000);
      const modal = P.q('.kbw-modal');
      if (!modal) return { ok: false, info: '点了那一行没弹出迁移面板' };
      const sub = P.text(modal.querySelector('.kbw-mig-sub') ?? modal);
      const rows = modal.querySelectorAll('.kbw-mig-row').length;
      const fields = modal.querySelectorAll('.kbw-mig-field').length;
      const tplChips = Array.from(modal.querySelectorAll('.kbw-chip')).filter((c) => P.text(c) === '模板').length;
      const st = P.styleOf('.kbw-modal');
      const a = P.alpha(st ? st.background : '');
      // 只读：快照数不该变（预演不写盘，也不拍快照）
      const snapsAfter = (await ctx.snapshot.list()).length;
      P.key('Escape');
      await P.wait(400);
      const closed = !P.q('.kbw-modal');
      return {
        ok: rows > 0 && /\\d+ 篇要改/.test(sub) && a > 0.9 && closed && snapsAfter === snapsBefore,
        info: '首页那行=「' + rowText + '」｜面板=' + sub + '｜列出 ' + rows + ' 行（模板 ' + tplChips + '）· ' + fields +
              ' 处待你定｜模态底 alpha=' + a + '｜快照 ' + snapsBefore + '→' + snapsAfter + '（只读）｜Esc 关掉=' + closed,
      };
    })()`,
    shot: 'p2-迁移预演.png',
  },
  {
    name: 'P6⑧ · 设置面板七栏（P7.2a 加「首页」）：说明默认收起（真机计算值）· 搜索能跳 · 问 AI 在 · 对比度',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      // 起手先把屏幕收干净（上一步漏关的浮层会让"点哪都没反应"）
      for (let i = 0; i < 5 && P.q('.kbw-modal'); i += 1) { P.key('Escape'); await P.wait(200); }
      ctx.openWorkbenchSettings();
      await P.wait(1100);
      const modal = P.q('.kbw-modal');
      if (!modal) return { ok: false, info: '设置面板没打开' };
      const tabs = P.qa('.kbw-set-tab').filter((t) => !t.classList.contains('is-ghost'));
      /**
       * P6 第八段把八栏收成六栏（用户第 3、6 条）：模板库/目录映射收进「自动化」、
       * 快照+日志收成「数据」、向导搬到新的「帮助」栏。
       * ⚠️ **P7.2a 起七栏**：加「首页」（首页内部区块的显隐与顺序，§2.0）。
       */
      const want = ['自动化', '看板', '首页', '外观', 'AI 助手', '数据', '帮助'];
      const got = tabs.map((t) => P.text(t));
      const order = want.every((w, i) => got[i] === w);
      const empties = [];
      const headBad = [];
      for (const t of tabs) {
        P.click(t);
        await P.wait(560);
        const b = P.q('.kbw-set-body');
        if (!b || P.text(b).length < 10) empties.push(P.text(t));
        // 一栏只有一份大标题（合并之后子块降级成小节标题）—— 真机几何上看就是 h2/h3 各 1 个
        const heads = P.qa('.kbw-set-main h2, .kbw-set-main h3').length;
        if (heads !== 1) headBad.push(P.text(t) + '→' + heads);
      }
      // 「帮助」栏里要有向导的重开入口（用户第 4 条：向导别放外观里）
      const helpTab = tabs.find((t) => P.text(t) === '帮助');
      let wizBtn = false;
      if (helpTab) {
        P.click(helpTab);
        await P.wait(520);
        wizBtn = P.qa('.kbw-set-main .kbw-btn').some((b) => P.text(b).indexOf('重新运行首次向导') >= 0);
      }
      // 回到第一栏（下面几条判据都在这一栏上）
      P.click(tabs[0]);
      await P.wait(760);
      const body = P.q('.kbw-set-body');
      const label = body.querySelector('.kbw-set-label-t') || body.querySelector('.kbw-set-group-t') || body;
      // ⚠️ 用 P6⑤ 补的那两个（老的 contrast / bgOf 只吃 rgb()，遇到 color(srgb …) 会当场抛）
      const ratio = P.contrastAny(getComputedStyle(label).color, P.bgSolid(label));
      const switches = P.qa('.kbw-switch').length;
      /**
       * 🔴 说明默认收起 —— 这一条**只有真机量得出来**（离线没有样式表）。
       * 判据是**计算值**：每一处行内说明的 display 都是 none、且**同一句话挂在行标签的 title 上**。
       * 光判"文本里有没有那句话"是假绿（textOf 读得到藏起来的字）。
       */
      /**
       * ⚠️ **先把「显示说明」归一到收起档再验**（P7.11 真机实测）：这一档是**落盘的界面
       * 偏好** —— 库里存着「true」（用户/前几轮留下的）时，"默认收起"这条判据量到的就是
       * 摊开态（假红）。归一走**面板自己的开关**（外部「settings.save」只落盘、不会换
       * 已渲染的类名）；量完在收尾**还原原值**（探针不留痕）。
       */
      const hints0 = ctx.settings.get().showSettingHints;
      if (hints0) {
        const toggleEarly = P.qa('.kbw-modal-actions button').find((b) => P.text(b).indexOf('说明') >= 0);
        if (toggleEarly) {
          P.click(toggleEarly);
          await P.wait(500);
        }
      }
      const hintEls = P.qa('.kbw-set-label .kbw-set-hint');
      const hintHidden = hintEls.length > 0 && hintEls.every((h) => getComputedStyle(h).display === 'none');
      /**
       * 🔴 状态 / 动态行**不吃那个开关**（P7.5 · 8.3 拆类名）：它们是"点了之后有没有生效"
       * 的唯一说明，折叠态下也要照常显示。判据认**计算值** + **元素真的在**（两条缺一不可：
       * 只判 display 的话，元素被删/没画出来时 every 恒真）。
       */
      const statusEls = P.qa('.kbw-set-status');
      const statusShown = statusEls.length > 0 && statusEls.every((s) => getComputedStyle(s).display !== 'none');
      const titled = hintEls.filter((h) => {
        const row = h.closest('.kbw-set-row');
        const t = row ? row.querySelector('.kbw-set-label-t') : null;
        return !!(t && t.getAttribute('title'));
      }).length;
      // 「显示说明」摊开 → 真的占位（display 变回 block + 高度 > 0），再点回收起
      const toggle = P.qa('.kbw-modal-actions button').find((b) => P.text(b).indexOf('说明') >= 0);
      if (!toggle) return { ok: false, info: '面板头上没有「显示说明」那枚开关' };
      /**
       * ── P7.11 · #9：切「显示说明」= **纯界面偏好**（只落盘）——不许把工作台重画一遍 ──
       * 判据：首页块的段头**节点身份不变**（重画会换元素）；耗时只报不判（防抖/计时器
       * 让绝对值没意义，卡顿那笔账由"身份"这条咬住）。设置面板是模态，底下先切回首页。
       */
      ctx.goHome();
      await P.wait(900);
      const homeHead0 = P.q('.kbw-hblock[data-block="todo"] .kbw-sec-head');
      const hintT0 = performance.now();
      P.click(toggle);
      await P.wait(460);
      const hintMs = Math.round(performance.now() - hintT0);
      const homeHead1 = P.q('.kbw-hblock[data-block="todo"] .kbw-sec-head');
      if (!homeHead0) note('#9：首页 todo 块没在（身份判据没锚点）');
      else if (homeHead0 !== homeHead1) {
        note('#9：切「显示说明」把首页块**重画了**（DOM 身份变了 —— 应该只落盘）');
      }
      const shownDisplay = getComputedStyle(hintEls[0]).display;
      const shownH = Math.round(hintEls[0].getBoundingClientRect().height);
      /** 摊开态下状态行同样要显示（两态都判 —— 只判一态的话，规则写反了也能混过去） */
      const statusShownOpen = statusEls.length > 0 && statusEls.every((s) => getComputedStyle(s).display !== 'none');
      P.click(toggle);
      await P.wait(460);
      const backHidden = getComputedStyle(hintEls[0]).display;
      // 「问 AI」：每一栏标题右边一枚
      const askAi = P.qa('.kbw-set-askai').length;
      // 搜索：打一个词 → 命中清单 → 点一条跳过去并点亮那一行
      const box = P.q('.kbw-set-search');
      box.value = '自动归位';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      let results = [];
      for (let i = 0; i < 30; i += 1) {
        await P.wait(140);
        results = P.qa('.kbw-set-result');
        if (results.length > 0) break;
      }
      const hitOne = results.find((x) => P.text(x).indexOf('自动归位') >= 0);
      let jumped = false;
      let flashed = 0;
      if (hitOne) {
        P.click(hitOne);
        await P.wait(900);
        const mainTxt = P.text(P.q('.kbw-set-main'));
        jumped = mainTxt.indexOf('自动归位') >= 0;
        flashed = P.qa('.kbw-set-row.is-flash').length;
      }
      P.key('Escape');
      await P.wait(520);
      const closed = !P.q('.kbw-modal');
      // 收尾：把「显示说明」还原成开跑前的原值（归一时动过它 —— 探针不留痕）
      if (hints0) {
        await ctx.settings.save({ showSettingHints: hints0 });
        await P.wait(300);
      }
      return {
        ok: tabs.length === 7 && order && empties.length === 0 && headBad.length === 0 &&
            // ⚠️ 开关数**不写死**（原来写「等于 2」）：这一栏将来多一个开关不该让整步红，
            //    真正要盯的是「有没有开关」；具体数字在 info 里报出来。
            //    P7.12 · #12 修正（真机抓到）：**「自动归位」开关退役** —— 这一栏常态就剩
            //    「新建笔记补全」一枚 → 下限从 2 降到 1。
            closed && ratio >= 4.5 && switches >= 1 && hintHidden && titled === hintEls.length &&
            shownDisplay !== 'none' && shownH > 0 && backHidden === 'none' &&
            statusShown && statusShownOpen &&
            (!homeHead0 || homeHead0 === homeHead1) &&
            askAi === 1 && results.length > 0 && jumped && flashed === 1 && wizBtn,
        info: '七栏=' + got.join('/') + '（顺序对=' + order + '）｜画不出来的=' + (empties.join('、') || '无') +
              '｜标题数不对的=' + (headBad.join('、') || '无') + '｜帮助栏有向导入口=' + wizBtn +
              '｜说明默认收起=' + hintHidden + '（挂 title 的 ' + titled + '/' + hintEls.length + '）' +
              '｜摊开=' + shownDisplay + '/' + shownH + 'px，收起=' + backHidden +
              '｜#9 首页块身份不变=' + (!homeHead0 ? '（没锚点）' : homeHead0 === homeHead1) + '（' + hintMs + 'ms）' +
              '｜状态行显示（折叠/摊开）=' + statusShown + '/' + statusShownOpen + '（共 ' + statusEls.length + ' 枚）' +
              '｜问AI=' + askAi + '｜搜索命中=' + results.length + '，跳过去=' + jumped + '，点亮=' + flashed +
              '｜自动化栏开关数=' + switches + '｜正文对比度=' + ratio + ':1｜Esc 关掉=' + closed,
      };
    })()`,
    shot: 'p6f-设置面板.png',
  },
  {
    name: 'P3 · 外观栏：密度 31/26px 真的生效 · 动效「减少」真的把 transition 掐掉',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      ctx.goNotes({ dir: '00_Inbox' });
      await P.wait(900);
      const root = P.q('.kbw-root');
      const rowH = () => {
        const r = P.q('.kbw-trow');
        return r ? Math.round(r.getBoundingClientRect().height) : -1;
      };
      /**
       * 这两项是"这台机器"的偏好（写插件 data.json），落到根元素的 data-* 上、
       * 由 CSS 认（styles/settings.css）—— 所以要验的是**真机上的计算值**：
       * 31px → 26px 的行高、以及 reduce 时 transition-duration 被压到 1ms。
       */
      const before = { density: root.getAttribute('data-density'), h: rowH() };
      await ctx.settings.save({ density: 'compact', motion: 'reduce' });
      await P.wait(800);
      const after = {
        density: root.getAttribute('data-density'),
        motion: root.getAttribute('data-motion'),
        h: rowH(),
        transition: getComputedStyle(P.q('.kbw-trow')).transitionDuration,
      };
      await ctx.settings.save({ density: 'standard', motion: 'system' });
      await P.wait(800);
      const back = { density: root.getAttribute('data-density'), h: rowH() };
      const okDensity = before.h === 31 && after.h === 26 && back.h === 31;
      const okMotion = after.motion === 'reduce' && parseFloat(after.transition) <= 0.01;
      return {
        ok: okDensity && okMotion,
        info: '密度：' + before.density + '/' + before.h + 'px → ' + after.density + '/' + after.h + 'px → ' +
              back.density + '/' + back.h + 'px｜动效：data-motion=' + after.motion +
              ' · transition-duration=' + after.transition + '（≤10ms 才算真的掐掉）｜已还原',
      };
    })()`,
  },
  {
    name: 'P3 · 目录映射：体检 → 补上缺失的领域落点 → 保存（经插件写库内那张表）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const path = ctx.settings.routeTablePath();
      const f = app.vault.getAbstractFileByPath(path);
      if (!f) return { ok: false, info: '库里找不到路由表：' + path };
      const beforeObj = JSON.parse(await app.vault.read(f));
      ctx.openWorkbenchSettings();
      await P.wait(900);
      const modal = P.lastModal();
      if (!modal) return { ok: false, info: '设置面板没打开' };
      P.clickByText('目录映射', modal);
      await P.wait(900);
      if (!P.text(P.q('.kbw-set-body')).includes('标签-目录映射.json')) {
        return { ok: false, info: '没切到目录映射栏' };
      }
      const issuesBefore = P.qa('.kbw-set-note').map((n) => P.text(n));
      const rows = P.qa('.kbw-set-row.is-route').length;
      const added = [];
      // 只加不删：缺的领域落点按默认值补行，然后保存
      const filled = P.clickByText('补上缺失的领域落点', modal);
      await P.wait(700);
      if (filled) {
        P.clickByText('保存', P.lastModal());
        await P.wait(900);
        // 体检有错误时会弹确认流 → 点「仍然保存」
        const confirm = P.lastModal();
        if (confirm && P.text(confirm).includes('仍要保存')) {
          P.clickByText('仍然保存', confirm);
          await P.wait(1000);
        }
      }
      const afterObj = JSON.parse(await app.vault.read(f));
      const kept = typeof afterObj['_说明'] === 'string' && afterObj['_说明'] === beforeObj['_说明'];
      for (const k of Object.keys(afterObj['领域'] || {})) {
        if (!(k in (beforeObj['领域'] || {}))) added.push(k);
      }
      const hasRes = String((afterObj['领域'] || {})['资源'] || '').indexOf('03_Resources') >= 0;
      const hasArc = String((afterObj['领域'] || {})['归档'] || '').indexOf('04_Archives') >= 0;
      // 标签段不该被动过
      const tagSame = JSON.stringify(beforeObj['标签']) === JSON.stringify(afterObj['标签']);
      const issuesAfter = P.qa('.kbw-set-note').map((n) => P.text(n));
      P.closeAll();
      await P.wait(300);
      return {
        ok: rows >= 10 && kept && tagSame && hasRes && hasArc && issuesAfter.length <= issuesBefore.length,
        info: '表里 ' + rows + ' 行｜体检 ' + issuesBefore.length + ' → ' + issuesAfter.length + ' 条' +
              '｜新补的落点=' + (added.join('、') || '无') + '（资源→03_Resources=' + hasRes + '·归档→04_Archives=' + hasArc + '）' +
              '｜注释键保住=' + kept + '｜标签段一个字节没动=' + tagSame,
      };
    })()`,
  },
  {
    name: 'P3 · 存量补全：扫描只读（不拍快照/不动文件）→ 执行 → 重扫 0 篇',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const snapsBefore = (await ctx.snapshot.list()).length;
      const inbox = app.vault.getAbstractFileByPath(kb + '/00_Inbox');
      const victim = inbox && inbox.children ? inbox.children.find((c) => c.extension === 'md') : null;
      const textBefore = victim ? await app.vault.read(victim) : '';
      ctx.openWorkbenchSettings();
      await P.wait(900);
      const setModal = P.lastModal();
      if (!setModal) return { ok: false, info: '设置面板没打开' };
      P.clickByText('自动化', setModal);
      await P.wait(700);
      P.clickByText('扫描', setModal);
      await P.wait(2800);
      const panel = P.lastModal();
      if (!panel || !P.text(panel).includes('一键补全')) return { ok: false, info: '补全面板没打开' };
      const sum = P.text(panel.querySelector('.kbw-mig-sum') || panel);
      const sub = P.text(panel.querySelector('.kbw-mig-sub') || panel);
      const rows = panel.querySelectorAll('.kbw-mig-row').length;
      const snapsScan = (await ctx.snapshot.list()).length;
      const textAfterScan = victim ? await app.vault.read(victim) : '';
      const readOnly = textBefore === textAfterScan && snapsScan === snapsBefore;
      const runBtn = P.btnByText('补全', panel);
      const label = runBtn ? P.text(runBtn) : '（无按钮）';
      let exec = '扫描就是 0 篇 → 没得可补（幂等已经成立）';
      if (runBtn && !runBtn.hasAttribute('disabled') && label.indexOf('没有要补的') < 0) {
        P.click(runBtn);
        await P.wait(800);
        const confirm = P.lastModal();
        if (!confirm || !P.text(confirm).includes('即将补全')) {
          return { ok: false, info: '确认流没弹出来' };
        }
        const primary = P.btnByText('补全', confirm);
        if (primary) P.click(primary);
        await P.wait(5000);
        P.clickByText('重新扫描', P.lastModal());
        await P.wait(3000);
        const panel3 = P.lastModal();
        exec = '执行过一轮 → 重扫：' + P.text(panel3.querySelector('.kbw-mig-sum') || panel3).slice(0, 80);
      }
      P.closeAll();
      await P.wait(300);
      return {
        ok: readOnly,
        info: sum + '｜' + sub + '｜列出 ' + rows + ' 行｜主按钮="' + label + '"｜' +
              '扫描只读（文件没变 + 没拍快照）=' + readOnly + '｜' + exec,
      };
    })()`,
    shot: 'p3-存量补全.png',
  },
  {
    name: 'P3 · 新建笔记：命令 → 对话框 → 选样例模板 → 插件补齐链落盘（六件 + 尾链 · 键不重复）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const name = '__探针新建' + Date.now().toString().slice(-6);
      const ok0 = app.commands.executeCommandById('kb-workbench:new-note');
      await P.wait(900);
      const modal = P.lastModal();
      if (!modal) return { ok: false, info: '新建对话框没打开（命令返回 ' + ok0 + '）' };
      if (!P.text(modal).includes('新建笔记')) {
        return { ok: false, info: '弹出的是别的模态：' + P.text(modal).slice(0, 60) };
      }
      const dirSel = modal.querySelectorAll('select')[0];
      const tplSel = modal.querySelectorAll('select')[1];
      /**
       * ⚠️ **A1（2026-09-27）起模板下拉的第一项是「不使用模板」且默认选中**，
       * 而这一步要验的是"**选一个真模板**"那条路（不显式挑的话走的是"我们一次落盘"
       * 的另一条路）。P7.13a · #3 起模板库里是三个样例（T_样例-*）—— 挑第一个真模板即可。
       */
      const tplOpt = Array.from(tplSel.options).find(function (o) { return o.value !== ''; });
      if (!tplOpt) return { ok: false, info: '模板下拉里一个真模板都没有（模板库空了？）' };
      tplSel.value = tplOpt.value;
      const input = modal.querySelector('input.kbw-input');
      if (!input) return { ok: false, info: '对话框里没有文件名输入框' };
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      P.clickByText('新建', modal);
      await P.wait(4000);   // 落空文件 → 判定点 → 插件补齐链落盘
      const file = app.vault.getAbstractFileByPath(kb + '/00_Inbox/' + name + '.md');
      if (!file) return { ok: false, info: '文件没建出来：' + kb + '/00_Inbox/' + name + '.md' };
      const text = await app.vault.read(file);
      /**
       * 🔴 P7.13a · #2/#3 起这条路走的是**插件自己的补齐链**（Inbox 的 Templater 目录规则
       * 已随旧模板一并撤掉、没有重建）：样例模板里的「类型: 模板」按**目录默认**换算
       *（Inbox → 笔记）、六件齐全（含「文件位置 = 所在目录」「收藏: false」）、
       * 尾链缺就补、正文保真（样例标题渲染成文件名）。
       * 判据钉五件：类型换算 / 标题 / 无 <% 语法 / **键不重复**（没被补第二遍）/ 六件 + 尾链。
       */
      const typeOk = text.indexOf('类型: 笔记') >= 0;
      const nameOk = text.indexOf(name) >= 0;
      const noTemplateSyntax = text.indexOf('<%') < 0;
      // ⚠️ **不能数横线的个数**（样例正文里本来就有分隔线）；真判据 = 每样只出现一次
      const once = (needle) => text.split(needle).length - 1 === 1;
      const notDoubled = once('类型:') && once('tags:') && once('## 关联笔记');
      const sixOk = text.indexOf('文件位置:') >= 0 && text.indexOf('  - 00_Inbox') >= 0 &&
                    text.indexOf('收藏: false') >= 0;
      // 自清理：删掉这篇（经插件自己的删除口，带快照）
      const snap = await P.snapTop();
      const trashed = await ctx.mover.trash({ files: [file], source: 'manual', reason: '探针新建测试（用完删）' });
      // 关掉它开出来的那个标签页（别给下一轮留一堆空标签）
      for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        if (leaf.view && leaf.view.file && leaf.view.file.path === file.path) leaf.detach();
      }
      await P.sweep([snap], '__探针');
      // 新建会把这篇在编辑器里打开 → 把工作台那一页重新激活（否则后面的步骤容器宽=0）
      await ctx.activate();
      await P.wait(600);
      return {
        ok: typeOk && nameOk && noTemplateSyntax && notDoubled && sixOk,
        info: '文件=' + file.path +
              '｜「类型: 笔记」（目录默认换算）=' + typeOk + '｜标题=' + nameOk +
              '｜没有残留 <% %>=' + noTemplateSyntax +
              '｜键不重复（没被补第二遍）=' + notDoubled +
              '｜六件+尾链=' + sixOk +
              '｜前言实测=' + text.slice(0, 120).split(String.fromCharCode(10)).join('⏎') +
              '｜删掉=' + (trashed.trashed.length === 1),
      };
    })()`,
  },
  {
    name: 'P3 · 自动归位：改标签不搬 · 改「文件位置」才搬 · 位置锁定不搬 · 关掉不搬',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const auto = ctx.automation;
      // ⚠️ 名字里带 __探针（**双下划线**）：自清理靠这个标记认自己造的日志
      // （P.sweep 只删正文里含标记的）—— 写成单下划线的话，移动/删除日志会一轮轮攒下来
      const base = '__探针归位' + Date.now().toString().slice(-6);
      const snaps = [];
      /**
       * 等**索引真的看见**它。刚 create 完的那 120ms 里 index.get() 还是空的 ——
       * 这时 tick() 等于没登记，等索引真看见它时"上次看见的"已经是**新值**了，
       * 于是"第一次见只登记不搬"的规则把它吃掉（真机实测：这一步因此假红）。
       */
      const waitIndexed = async (p2) => {
        for (let i = 0; i < 40; i += 1) {
          if (ctx.index.get(p2)) return true;
          await P.wait(100);
        }
        return false;
      };
      const mk = async (suffix) => {
        const p = kb + '/00_Inbox/' + base + suffix + '.md';
        await app.vault.create(p, '---\\n类型: 想法\\n领域: 未分类\\n状态: 待整理\\n创建日期: 2026-09-24\\ntags: []\\n---\\n\\n正文\\n');
        await waitIndexed(p);
        return app.vault.getAbstractFileByPath(p);
      };
      // 开自动归位（写库内配置）
      await auto.patch({ reconcile: { enabled: true } });
      await P.wait(600);
      const a = await mk('A');
      // ① 先让它"登记"一次（不带声明）
      await ctx.reconcile.tick();
      await P.wait(400);
      // ② 改**标签** → 不该搬
      await ctx.fm.update(a, (fm) => { fm.tags = ['内容创作']; });
      await P.wait(1400);
      const stillA = !!(await app.vault.getAbstractFileByPath(a.path));
      // ③ 改**文件位置** → 该搬（走到 02_Areas/内容创作）
      const b = await mk('B');
      const bOld = b.path;   // ⚠️ rename 会**就地改** file.path → 旧路径必须先抄下来（P-1 实测过）
      await ctx.reconcile.tick();
      await P.wait(400);
      await ctx.fm.update(b, (fm) => { fm['文件位置'] = ['02_Areas/内容创作']; });
      await P.wait(3000);   // 索引 debounce + 归位 debounce + 真搬
      const movedB = !!(await app.vault.getAbstractFileByPath(kb + '/02_Areas/内容创作/' + base + 'B.md'))
        && !(await app.vault.getAbstractFileByPath(bOld));
      // 口径混了的话会落到 **vault 根**下（真机踩过）→ 单独记一笔，好一眼看出
      const stray = !!(await app.vault.getAbstractFileByPath('02_Areas/内容创作/' + base + 'B.md'));
      if (movedB) snaps.push(await P.snapTop());
      // ④ 位置锁定 → 不搬（但要有说明）
      const c = await mk('C');
      await ctx.reconcile.tick();
      await P.wait(400);
      await ctx.fm.update(c, (fm) => { fm['文件位置'] = ['02_Areas/内容创作']; fm['位置锁定'] = true; });
      await P.wait(2200);
      const lockedStayed = !!(await app.vault.getAbstractFileByPath(c.path));
      // ⑤ 关掉 → 改也不搬
      await auto.patch({ reconcile: { enabled: false } });
      await P.wait(500);
      const d = await mk('D');
      await ctx.reconcile.tick();
      await P.wait(400);
      await ctx.fm.update(d, (fm) => { fm['文件位置'] = ['02_Areas/内容创作']; });
      await P.wait(2200);
      const stayedD = !!(await app.vault.getAbstractFileByPath(d.path));
      // 自清理：把搬走的搬回来（走 mover），其余删掉
      const moved = await app.vault.getAbstractFileByPath(kb + '/02_Areas/内容创作/' + base + 'B.md');
      if (moved) {
        await ctx.mover.move({ targets: [{ dir: kb + '/00_Inbox', files: [moved] }], source: 'manual', reason: '探针归位测试（搬回去）' });
        snaps.push(await P.snapTop());
      }
      /**
       * ⚠️ P7.12 收尾真机修正：原清场只找「00_Inbox/base+[A-D]」—— 但 C/D 那两篇会被
       * 归位链已搬进「02_Areas/内容创作/」（真机实测：上两轮各留了 C/D 两篇孤儿在内容创作，
       * 还排到看板最前、把 e 步的键盘走格带偏）。改成**按名字前缀全库扫**（base 带时间戳、唯一）。
       */
      const files = app.vault.getMarkdownFiles().filter((f) => f.basename.indexOf(base) === 0);
      if (files.length > 0) {
        const t = await ctx.mover.trash({ files, source: 'manual', reason: '探针归位测试（用完删）' });
        snaps.push(t.snapshotId);
      }
      await P.sweep(snaps, '__探针');
      await auto.patch({ reconcile: { enabled: false } });
      return {
        ok: stillA && movedB && lockedStayed && stayedD && !stray,
        info: '改标签没搬=' + stillA + '｜改「文件位置」搬了=' + movedB + '（落进库根之下=' + !stray + '）' +
              '｜位置锁定没搬=' + lockedStayed + '｜关掉之后没搬=' + stayedD +
              '｜（走的是 mover：快照 + 日志 + 撤销条）' +
              '｜诊断：轮数=' + ctx.reconcile.runs + ' · 最近 6 轮=' +
              JSON.stringify(ctx.reconcile.recent.slice(-6).map((r) => [r.on ? '开' : '关', r.moves + '/' + r.skips, r.registered])) +
              ' · B 上次看见的=' + JSON.stringify(ctx.settings.get().reconcileSeen[bOld] || '（没登记）'),
      };
    })()`,
  },
  {
    name: 'P3 · 模板库：列表（含脚本类）/ 另存为 / 删除走回收站',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const dir = ctx.settings.templateDir();
      ctx.openWorkbenchSettings();
      await P.wait(800);
      const modal = P.q('.kbw-modal');
      P.clickByText('模板库', modal);
      await P.wait(900);
      const rows = P.qa('.kbw-set-row').filter((r) => r.querySelector('.kbw-set-actions'));
      const names = rows.map((r) => P.text(r).split(' ')[0]);
      const scriptRow = P.qa('.kbw-set-row').find((r) => P.text(r).indexOf('脚本类') >= 0);
      const snaps = [];
      /**
       * ⚠️ 这一步真的动过库（走的是 mover.trash）→ 会写一条删除日志，而**那条日志正文里没有
       * __探针 标记**（被删的是 T_…_副本.md，名字由平台拼）→ 按标记 sweep 认不出来，
       * 实测每跑一轮积一条（2026-09-28 清了三轮留下的三条）。所以**点名删**：
       * 记下开工时的日志清单，收尾把新增的那几条删掉。
       */
      const logsBefore = (await ctx.report.recent(400)).map(function (f) { return f.path; });
      // 另存为：复制一份 → 立刻删掉（删除走 mover.trash，带快照）
      let saved = '';
      const firstRow = rows[0];
      const saveBtn = firstRow
        ? Array.from(firstRow.querySelectorAll('button')).find((b) => P.text(b) === '另存为…')
        : null;
      if (saveBtn) {
        P.click(saveBtn);
        await P.wait(800);
        const prompt = P.lastModal();
        if (prompt && prompt.querySelector('.kbw-input')) {
          P.clickByText('另存为', prompt); // 问一句那个模态的主按钮
          await P.wait(1000);
          const folder = app.vault.getAbstractFileByPath(dir);
          const made = folder && folder.children ? folder.children.filter((c) => c.name.indexOf('副本') >= 0) : [];
          saved = made.map((m) => m.name).join('、');
          if (made.length > 0) {
            const r = await ctx.mover.trash({ files: made, source: 'template', reason: '探针模板库测试（用完删）' });
            snaps.push(r.snapshotId);
          }
        }
      }
      await P.sweep(snaps, '__探针');
      // 点名删掉上面那条删除日志（正文里没有 __探针 标记，标记 sweep 认不出它）
      let logCleared = 0;
      for (const p of (await ctx.report.recent(400)).map(function (f) { return f.path; })) {
        if (logsBefore.indexOf(p) >= 0) continue;
        const f = app.vault.getAbstractFileByPath(p);
        if (f) { await app.vault.delete(f, true); logCleared += 1; }
      }
      P.closeAll();
      await P.wait(300);
      return {
        /**
         * ⚠️ P7.13a · #3 回改：旧门槛「>= 7」是**旧库内容的耦合**——模板库清理后
         * 只剩 3 个样例 + 1 个脚本类（T_智能新建）= 4 行，那条门恒红。
         * 新形态 = 内容无关的下限：**列表真的画了不止一行**（≥2）+ 脚本类那行认得出。
         */
        ok: rows.length >= 2 && !!scriptRow && saved.indexOf('副本') >= 0,
        info: '模板 ' + rows.length + ' 个=' + names.slice(0, 8).join('/') + '｜脚本类那行认出来了=' + !!scriptRow +
              '｜另存为→' + (saved || '（没成功）') + '（已删回）｜删除走的是 mover.trash（有快照）' +
              '｜自清理：这条的删除日志 -' + logCleared,
      };
    })()`,
  },
  {
    /**
     * P3 期遗留（2026-09-24 拍板：值域加回 资源 / 归档，那两棵树的 6 篇跟着改）。
     * ⚠️ **P7.12 收尾（v2）：本步停用为只读报告** —— 「领域」随 21.10 退役、迁移链会**连值删**；
     * 这步再"收尾"等于每轮把退役键**重新种回** 6 篇（还多写一份快照 + 日志）：真机实测
     * probe2 一轮就给迁移链制造了 6 篇多余目标。留成只读报告：它们现在带不带「领域」照实报出来
     *（迁移链跑过之后应为"不带"）。
     */
    name: 'P3 · 领域收尾（v2 停用：只读报告 —— 领域随退役，迁移链连值删）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const dirty = ctx.index.notes().filter((e) => {
        const pos = e.effectivePosition;
        return (
          (pos === '03_Resources' || pos.indexOf('03_Resources/') === 0 ||
            pos === '04_Archives' || pos.indexOf('04_Archives/') === 0) &&
          '领域' in e.props
        );
      });
      return {
        ok: true,
        info: dirty.length === 0
          ? '只读报告：03_Resources / 04_Archives 都不带「领域」（v2 口径 ✓）'
          : '只读报告：还有 ' + dirty.length + ' 篇带「领域」（' +
            dirty.slice(0, 6).map((e) => e.basename + '：' + String(e.props['领域'])).join('、') +
            '）—— 归迁移链连值删，本步不再动手',
      };
    })()`,
  },
  {
    name: 'P1 · 首页：标识 / 搜索框（键位提示 /）/ 四个快捷动作 / 待处理 / 最近改动 / 底部状态',
    script: `(async () => {
      const P = window.__kbwProbe;
      /**
       * ⚠️ 切模块要**点导航项**，不能只 store.set({activeModule})：
       * 只改内存的话，只要之后有任何一次设置落盘（P3 起「自动归位」会悄悄记
       * reconcileSeen），main.ts 的 applySettingsToStore() 就会按 data.json
       * 把它**复位**回上一栏 —— 首页刚渲染出来又被换走（真机实测：这一步因此假红）。
       * 点导航项 = 真路径（它同时写 settings + store），两边一致。
       */
      P.clickByText('首页', P.q('.kbw-navitems'));
      await P.wait(800);
      const name = P.text(P.q('.kbw-hero-name'));
      const key = P.text(P.q('.kbw-key'));
      const quick = P.qa('.kbw-qbtn').map((b) => P.text(b));
      const heads = P.qa('.kbw-sec-head h3').map((h) => P.text(h));
      const todos = P.qa('.kbw-todo').length;
      const recs = P.qa('.kbw-rec').length;
      const foot = P.text(P.q('.kbw-home-foot'));
      const input = P.q('.kbw-gsearch-input');
      if (input) {
        input.value = '绝对没有这个词__zzz';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await P.wait(500);
      }
      const msg = P.text(P.q('.kbw-hero-msg'));
      const stillHome = P.ctx().store.get().activeModule === 'home';
      return {
        ok: name === '经纬' && key === '/' && quick.length === 4 && heads.includes('待处理') &&
            heads.includes('最近改动') && recs > 0 && foot.includes('库 ') && msg.includes('没有匹配') && stillHome,
        info: '标识=' + name + '｜键位提示=' + JSON.stringify(key) + '｜快捷动作=' + JSON.stringify(quick) +
              '｜段落=' + JSON.stringify(heads) + '｜待处理 ' + todos + ' 条 / 最近改动 ' + recs + ' 条' +
              '｜底部="' + foot + '"｜搜不到时原地提示=' + msg.includes('没有匹配') + '（没跳走=' + stillHome + '）',
      };
    })()`,
  },
  {
    name: '截图：首页',
    shot: '04-home.png',
    async before(cdp) {
      await cdp.eval(`(async () => { window.__kbwProbe.ctx().store.set({ activeModule: 'home' }); await window.__kbwProbe.wait(600); return true; })()`);
    },
  },
  {
    name: '截图：全部笔记（详情档 + 一行选中）',
    shot: '02-workbench.png',
    async before(cdp) {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        P.ctx().goNotes();
        await P.wait(800);
        /**
         * ⚠️ **视野要自己摆**（P7.1b · 2.8）：库根这一层不再有笔记行 —— 不先站进一个
         * 有笔记的目录，这张"详情档 + 一行选中"的图就没有那一行可点（静默降级）。
         */
        await P.useView('详细信息');
        /** ⚠️ 返回空串 = 视野没摆好（见 01-menu 那条的注释，独立审查 🟡5）——别静默降级 */
        const seeded = await P.enterDirWithNotes();
        if (!seeded) console.error('[探针] 02-workbench 截图：没找到"本层有笔记且盘上真有"的目录 —— 这张图会拍到空列表');
        await P.wait(400);
        const row = P.q('.kbw-trow');
        if (row) P.click(row);
        await P.wait(400);
        return true;
      })()`);
    },
  },
  {
    name: '截图：撤销条（动库之后的底部）',
    shot: '05-undobar.png',
    async before(cdp) {
      // ⚠️ 必须走**界面**动库：撤销条是界面层（modules/notes/ops）发的，
      // 直接调 "ctx.mover.move()" 只有通知、没有撤销条（第一版就这么截了个空）
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        const ctx = P.ctx();
        const kb = ctx.settings.kbRoot();
        const rel = kb + '/00_Inbox/__探针截图.md';
        const old = app.vault.getAbstractFileByPath(rel);
        if (old) await app.vault.delete(old, true);
        await app.vault.create(rel, '---\\n类型: 想法\\n领域: 灵感杂记\\n状态: 进行中\\n创建日期: 2026-09-24\\ntags: []\\n---\\n# 截图用\\n');
        await P.wait(900);
        ctx.goNotes({ dir: '00_Inbox' });
        await P.wait(700);
        const row = P.rowByPath(rel);
        const nodes = P.qa('[data-drop]');
        const node = nodes.find((i) => i.getAttribute('data-drop') === '02_Areas/内容创作')
          ?? nodes.find((i) => i.getAttribute('data-drop') === '02_Areas');
        if (row && node) {
          await P.dragMouse(P.center(row), P.center(node), 6);
          await P.wait(900);
        }
        window.__kbwProbe.__shotSnap = await P.snapTop();
        return true;
      })()`);
    },
    async after(cdp) {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        const ctx = P.ctx();
        const kb = ctx.settings.kbRoot();
        const undo = P.btnByText('撤销', P.q('.kbw-undobar'));
        if (undo) { P.click(undo); await P.wait(1600); }
        for (const cand of [kb + '/00_Inbox/__探针截图.md', kb + '/02_Areas/内容创作/__探针截图.md']) {
          const f = app.vault.getAbstractFileByPath(cand);
          if (f) await app.vault.delete(f, true);
        }
        await P.sweep([window.__kbwProbe.__shotSnap]);
        return true;
      })()`);
    },
  },
  // ── P4 · 看板（2026-09-25）────────────────────────────────────
  // ⚠️ 这几步会**真的写实验库**：建看板板块（写 06_工作台/看板配置.json）、
  //    造 __探针* 临时笔记（用完自己删）。自清理只认自己造的那些。
  {
    name: 'P4 · 看板：切过去 + 用板块管理建一个文件夹源板块 + 卡片数对上',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      P.closeAll(3);
      const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (!nav) return { ok: false, info: '导航里没有「看板」' };
      P.click(nav);
      await P.wait(900);
      let board = P.q('.kbw-board');
      if (!board) return { ok: false, info: '看板模块没挂上（.kbw-board 不在）' };

      /**
       * ⚠️ 先清成"没有板块"再走界面：实验库是**反复跑**的，上一轮留下的板块会让
       * 这一轮的卡片数翻倍（第一轮就是这么假红的）。清完点「重载」让看板按文件现状重建。
       */
      const cfg0 = (await ctx.configs.read('board')) || { version: 1, view: {} };
      const dirtyCfg = cfg0.view && cfg0.view.cardMode && cfg0.view.cardMode !== 'content';
      if ((Array.isArray(cfg0.sections) && cfg0.sections.length > 0) || dirtyCfg) {
        await ctx.configs.write('board', { ...cfg0, view: { ...(cfg0.view || {}), cardMode: 'content' }, sections: [] });
        /**
         * 🔴 **write 会经文件 watcher 触发看板 reloadCfg —— 体与工具条是「异步重画」的**：
         * 以前"写完立刻取 .kbw-board-body"恰好落在**清空窗口**里，拿到 null →
         * getBoundingClientRect 当场抛（单跑两次的形态）。先等它画回来；真没回来就明说，
         * 别再拿 null 往下走。
         */
        await P.wait(700);
        const bd = P.q('.kbw-board-body');
        if (!bd) return { ok: false, info: '清了板块配置之后看板体没画回来（异步重画窗口 —— 稍后复跑，别当成看板坏了）' };
        const rr = bd.getBoundingClientRect();
        P.rightClickAt(Math.round(rr.left + 14), Math.round(rr.top + 8));
        await P.wait(500);
        await P.clickMore('重载');
        await P.wait(1500);
      }

      /**
       * 用**界面**建板块（真路径：面板 → 选类型 → 选值 → 建）。
       * ⚠️ 工具条同样是异步画的：给「板块」按钮一次重试窗口（全量那轮的
       * "找不到按钮"就是重载后立刻来找、还没画回来）。
       */
      let gm = P.sectMgr();
      if (!gm) {
        await P.wait(900);
        gm = P.sectMgr();
      }
      if (!gm) {
        // 现场取证：那一刻页面到底长什么样（别让下一次又从头猜）
        const dbg = 'active=' + ctx.store.get().activeModule +
          '｜有 .kbw-board=' + !!P.q('.kbw-board') +
          '｜有 toolbar=' + !!P.q('.kbw-board-toolbar') +
          '｜工具条文字=' + P.qa('.kbw-board-toolbar button').map((b) => P.text(b)).join('/') +
          '｜全页 button 数=' + P.qa('button').length;
        return { ok: false, info: '工具条上找不到「板块」按钮（' + dbg + '）' };
      }
      P.click(gm);
      await P.wait(700);
      const panel = P.lastPanel();
      if (!panel) return { ok: false, info: '板块管理面板没开' };
      P.clickByText('＋ 添加板块', panel);
      await P.wait(600);
      const add = panel.querySelector('.kbw-bp-add');
      if (!add) return { ok: false, info: '面板里没有「添加板块」那一块' };
      const row = P.qa('.kbw-bp-add-row')[0];
      const sel = row.querySelector('select');
      const want = '02_Areas/内容创作';
      const opt = Array.from(sel.options).find((o) => o.value === want);
      if (!opt) {
        return { ok: false, info: '目录下拉里没有 ' + want + '（前几个：' + Array.from(sel.options).slice(0, 6).map((o) => o.value).join('/') + '）' };
      }
      sel.value = want;
      const build = Array.from(row.querySelectorAll('button')).find((b) => P.text(b) === '建');
      P.click(build);
      await P.wait(1400);
      const rows = P.qa('.kbw-bp-row');
      const countTxt = rows.length > 0 ? P.text(rows[0].querySelector('.kbw-bp-count')) : '（没行）';
      P.closeAll(3);
      await P.wait(600);

      const expect = ctx.index.notes()
        .filter((e) => e.path.startsWith(ctx.settings.kbRoot() + '/' + want + '/')).length;
      const cards = P.qa('[data-card]');
      const heads = P.qa('.kbw-sect-nm').map((h) => P.text(h));
      return {
        ok: cards.length === expect && expect > 0 && /\\d+/.test(countTxt),
        info: '板块头=' + heads.join('/') + '｜卡片 ' + cards.length + ' 张 / 那个目录下 ' + expect + ' 篇' +
              '｜面板里的实时计数=' + countTxt,
      };
    })()`,
    shot: 'p4-看板-总览.png',
  },
  {
    name: 'P4 · 看板：卡片摘要剥了两层 + 卡片有实底与阴影（真机样式）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      // 先确保「只内容」档：看板配置是**库内文件**，上一轮可能把它改成别的档并留档了
      const c0 = (await ctx.configs.read('board')) || { view: {} };
      if (c0.view && c0.view.cardMode !== 'content') {
        await ctx.configs.write('board', { ...c0, view: { ...c0.view, cardMode: 'content' } });
        const bd = P.q('.kbw-board-body');
        const rr = bd.getBoundingClientRect();
        P.rightClickAt(Math.round(rr.left + 14), Math.round(rr.top + 8));
        await P.wait(500);
        await P.clickMore('重载');
        await P.wait(1800);
      }
      const cards = P.qa('[data-card]');
      if (cards.length === 0) return { ok: false, info: '没有卡片' };
      let withBody = null;
      for (const c of cards) {
        const b = c.querySelector('.kbw-card-body');
        if (b && P.text(b).length > 8) { withBody = c; break; }
      }
      if (!withBody) return { ok: false, info: '没有一张卡片带正文（摘要都是空的？）' };
      const bodyText = P.text(withBody.querySelector('.kbw-card-body'));
      const bad = ['类型:', '状态:', '创建日期:', '关联笔记', '所属中心', '---'].filter((k) => bodyText.indexOf(k) >= 0);
      const cs = getComputedStyle(withBody);
      const bg = P.alpha(cs.backgroundColor);
      const shadow = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 44) : '(无)';
      const bodyEl = withBody.querySelector('.kbw-card-body');
      const bcs = getComputedStyle(bodyEl);
      const clamp = bcs.webkitLineClamp || bcs.lineClamp || '(没截断)';
      return {
        ok: bad.length === 0 && bg > 0.9 && shadow !== '(无)',
        info: '摘要=' + bodyText.slice(0, 40) + '…｜不该露的=' + (bad.length ? bad.join(' ') : '干净') +
              '｜卡片底 alpha=' + bg + '｜阴影=' + shadow + '｜正文截断=' + clamp,
      };
    })()`,
  },
  {
    name: 'P4 · 看板：单击开悬浮小窗 = 真 CodeMirror（挂上/藏头/关掉/不悬挂）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const card = P.qa('[data-card]')[0];
      if (!card) return { ok: false, info: '没有卡片' };
      const before = app.workspace.getLeavesOfType('markdown').length;
      P.click(card.querySelector('.kbw-card-t'));
      await P.wait(1600);
      const panel = P.lastPanel();
      if (!panel) return { ok: false, info: '悬浮小窗没出来' };
      const hasCm = !!panel.querySelector('.kbw-cw-editor .cm-editor');
      const contentEl = panel.querySelector('.kbw-cw-editor .cm-content');
      const header = panel.querySelector('.kbw-cw-editor .view-header');
      const headerDisplay = header ? getComputedStyle(header).display : '(没有 view-header)';
      const props = P.qa('.kbw-cw-props select').length + P.qa('.kbw-cw-props .kbw-multiselect').length;
      const btns = P.qa('button', panel).map((b) => P.text(b)).filter(Boolean).join('/');
      const editor = panel.querySelector('.kbw-cw-editor');
      const editorW = editor ? Math.round(editor.getBoundingClientRect().width) : 0;
      const editorH = editor ? Math.round(editor.getBoundingClientRect().height) : 0;

      P.key('Escape');
      await P.wait(1000);
      const stillOpen = !!P.q('.kbw-panel');
      const after = app.workspace.getLeavesOfType('markdown').length;
      const orphan = P.qa('.kbw-cw-leaf').length;
      /**
       * ⚠️ 判据里去掉了早先那条「props > 0」：**C2（2026-09-27）起小窗默认只看正文**，
       * 属性块按档位不画了（默认档 = none）—— 那一条已经不再是「应该有属性」的证据。
       * 「属性控件是真控件」由离线用例覆盖（board · b 那条会显式把档位设成前 6 行）；
       * 这一条只管「真 CodeMirror 挂上了 / 头藏了 / 关干净了」。
       */
      void props;
      return {
        ok: hasCm && !!contentEl && headerDisplay === 'none' && !stillOpen && orphan === 0,
        info: '真 CodeMirror=' + hasCm + '｜.cm-content=' + !!contentEl + '｜自带 view-header 被藏=' + headerDisplay +
              '｜属性控件 ' + props + ' 个｜编辑器 ' + editorW + '×' + editorH +
              '｜按钮=' + btns + '｜Esc 关掉=' + !stillOpen +
              '｜关闭后残留编辑器 DOM=' + orphan + '｜markdown 叶 ' + before + ' → ' + after,
      };
    })()`,
    shot: 'p4-看板-悬浮小窗.png',
    before: async (cdp) => {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        const card = P.qa('[data-card]')[0];
        if (card) P.click(card.querySelector('.kbw-card-t'));
        await P.wait(1700);
        return true;
      })()`);
    },
    after: async (cdp) => {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        P.key('Escape');
        await P.wait(1000);
        return true;
      })()`);
    },
  },
  {
    name: 'P4 · 看板：正文里的勾选框直写那一行（且不弹小窗）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const rel = kb + '/02_Areas/内容创作/__探针勾选.md';
      /** ⚠️ 照**模板产出的形状**造：正文首行就是「# 文件名」（夹具里 17 篇如此）。
       * 造规范的假笔记的话，「抹同名 H1」那一支根本不走，而行号偏移的 bug
       * 恰好只在那一支出错（独立审查 R1）。注释里不许出现反引号：这段是
       * String.raw 模板，一个反引号就会提前结束它。 */
      const lines = ['---', '类型: 内容作品', '领域: 内容创作', '状态: 进行中', '创建日期: 2026-09-25', 'tags: []', '文件位置: []', '---', '# __探针勾选', '', '- [ ] 探针第一条', '- [ ] 探针第二条', ''];
      const text = lines.join('\\n');
      const old = await app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(rel, text);
      await P.wait(2000);
      const drop = async () => {
        const f0 = await app.vault.getAbstractFileByPath(rel);
        if (f0) await app.vault.delete(f0, true);
        await P.wait(700);
      };
      const card = P.qa('[data-card]').find((c) => (c.getAttribute('data-path') || '').indexOf('__探针勾选') >= 0);
      if (!card) { await drop(); return { ok: false, info: '那张卡片没出来（索引没跟上？）' }; }
      const boxes = P.qa('input[type="checkbox"]', card);
      const mismatch = card.getAttribute('data-task-mismatch');
      if (boxes.length !== 2) {
        await drop();
        return { ok: false, info: '勾选框数=' + boxes.length + '（该 2 个）｜框数对不上标记=' + mismatch +
          '｜卡片档=' + (card.querySelector('.kbw-card-kv') ? '只属性/两者' : '只内容') };
      }
      P.click(boxes[1]); // ← 点第二条：偏移算错的话，被改的是第一条
      await P.wait(1800);
      const f = await app.vault.getAbstractFileByPath(rel);
      const after = f ? await app.vault.read(f) : '';
      const line1 = after.indexOf('- [ ] 探针第一条') >= 0;
      const line2 = after.indexOf('- [x] 探针第二条') >= 0;
      const opened = !!P.q('.kbw-panel');
      const still = await app.vault.getAbstractFileByPath(rel);
      if (still) await app.vault.delete(still, true);
      await P.wait(1000);
      return {
        ok: line1 && line2 && !opened && !mismatch,
        info: '第 1 行没动=' + line1 + '｜第 2 行勾上了=' + line2 + '｜弹了悬浮小窗=' + opened +
              '｜框数对不上标记=' + (mismatch || '无'),
      };
    })()`,
  },
  {
    /**
     * e2 期修的两条（都是用户在真机上报的）：
     *  ① **勾一下会跳**：勾选框写盘 → 索引修订变 → 整块重绘 → 卡面正文与各列的滚动
     *     位置全部归零（真机量到：列 80 → 0、卡面正文 200 → 0）。修法见 view-memory
     *     的 restoreIfReset 与看板 store 订阅里那段。
     *  ② **整张卡的框点不动**：源文里有一行缩进过深的任务行（渲染器当续行、不画框），
     *     老口径照收 → 框数与任务行数永久对不上 → "对不上就不绑"（"9.20.md" 就长这样）。
     * ⚠️ 注释里不许出现反引号（这段是模板字符串）。
     */
    name: 'e2 · 勾一下**不跳**：列与卡面正文的滚动位置都保住（缩进过深那篇也勾得动）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const kbc = await ctx.configs.read('board');
      const rel = kb + '/02_Areas/内容创作/__探针不跳.md';
      /**
       * 造一篇**长且带一行缩进过深**的笔记：
       *  · 长 → 卡面正文有滚余量（才谈得上"位置被保住了吗"）
       *  · 那一行过深的任务行 → 老口径下框数与任务行数对不上，整张卡的框点不动
       */
      const lines = ['---', '类型: 内容作品', '领域: 内容创作', '状态: 进行中', 'tags: []', '---', '# __探针不跳', ''];
      for (let i = 0; i < 20; i += 1) lines.push('- [ ] 探针第 ' + i + ' 条');
      /**
       * 各种"口径边界"的形状（独立审查 🔴2 只能靠真机定性）：
       *  · 声称**要收**的：普通行、5 空格缩进的子项（列 5 = 父内容列 2 + 3，真机画框）
       *  · 声称**不收**的：2 空格 + Tab（真机不画）、6 空格、marker 后 5 空格、过深续行
       * 判据 = 卡片的 data-task-mismatch 不出现（两边条数一致）；差一条就会整张卡只读。
       */
      lines.push('\\t\\t    - [x] 缩进过深这条');
      lines.push('- [ ] 父项');
      lines.push('  \\t- [ ] 空格加 Tab 的子项');
      lines.push('    - [ ] 四空格是代码块');
      lines.push('\\t- [ ] Tab 开头也是代码块');
      lines.push('-     [ ] marker 后五空格');
      lines.push('- [ ] 最后一条');
      lines.push('');
      const text0 = lines.join('\\n');
      const old = await app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(rel, text0);
      /**
       * 看板配置：一个文件夹源板块 + **固定卡片高度** ——
       * 自动高度档下卡面正文不滚（没有"位置"可保），这条就名不副实了。
       */
      await ctx.configs.write('board', {
        version: 1,
        view: Object.assign({}, kbc && kbc.view, { cardMode: 'content', cardHeight: 260, summaryLines: 200 }),
        sections: [{ id: 'e2-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' }],
      });
      await P.wait(2600);
      const pick = () => P.qa('[data-card]').find((c) => (c.getAttribute('data-path') || '').indexOf('__探针不跳') >= 0);
      const drop = async () => {
        const f0 = await app.vault.getAbstractFileByPath(rel);
        if (f0) await app.vault.delete(f0, true);
        await P.wait(700);
      };
      const card = pick();
      if (!card) { await drop(); return { ok: false, info: '那张卡片没出来（索引没跟上？）' }; }
      const boxes = P.qa('input[type=\"checkbox\"]', card);
      const mismatch = card.getAttribute('data-task-mismatch');
      const disabled = boxes.filter((b) => b.disabled).length;
      const body = card.querySelector('.kbw-card-body');
      const col = P.qa('.kbw-cards').filter((c) => c.scrollHeight > c.clientHeight + 5)[0] || null;
      const colKey = col ? col.getAttribute('data-scroll') : '';
      body.scrollTop = 120;
      if (col) col.scrollTop = 60;
      await P.wait(300);
      const beforeBody = body.scrollTop;
      const beforeCol = col ? col.scrollTop : -1;
      const target = boxes[3] || boxes[0];
      const want = (target.parentElement && target.parentElement.textContent || '').trim();
      P.click(target);
      await P.wait(2200);
      const card2 = pick();
      const body2 = card2 ? card2.querySelector('.kbw-card-body') : null;
      const col2 = colKey ? P.q('.kbw-cards[data-scroll=\"' + colKey + '\"]') : null;
      const afterBody = body2 ? body2.scrollTop : -1;
      const afterCol = col2 ? col2.scrollTop : -1;
      const f = await app.vault.getAbstractFileByPath(rel);
      const text1 = f ? await app.vault.read(f) : '';
      const l0 = text0.split('\\n');
      const l1 = text1.split('\\n');
      const changed = [];
      for (let i = 0; i < Math.max(l0.length, l1.length); i += 1) if (l0[i] !== l1[i]) changed.push(i);
      const changedLine = changed.length === 1 ? l1[changed[0]] : '';
      /**
       * 判据四条：
       *  ① 框数对得上、没有只读框（= 缩进过深那行不再破坏绑定）
       *  ② **恰好改了一行**，且那一行就是点中的那条（不是上面那一行）
       *  ③ 缩进过深那行**一个字节没动**
       *  ④ 卡面正文与列的滚动位置都在原处
       */
      const oneLine = changed.length === 1 && changedLine.indexOf(want) >= 0 && changedLine.indexOf('[x]') >= 0;
      const deepOk = text1.indexOf('\\t\\t    - [x] 缩进过深这条') >= 0;
      const scrollOk = beforeBody === afterBody && (!col || beforeCol === afterCol);
      /**
       * ⚠️ 条数**不写死**（形状加一个就得改一次），判据落在"**两边对得上**"上 ——
       * 那正是渲染器与 taskItems 的口径一致性（data-task-mismatch 不出现）。
       */
      const okAll = !mismatch && disabled === 0 && oneLine && deepOk && scrollOk;
      /**
       * **已知缺口（只有一条）**：引用块里的任务行 —— 真机渲染器**会**给它画框，我们认不出。
       * 这里**只量、不断言**（那一篇本来就该被按成只读）：把 框数/条数 报出来，
       * 将来真要修时有个基线。⚠️ 按真机实测（2026-09-26）：HTML 块那条**不成立**
       *（渲染器照样画框、我们与它一致），所以这里只造引用块这一种。
       */
      let gapInfo = '（缺口那篇没量）';
      try {
        const gapRel = kb + '/02_Areas/内容创作/__探针缺口.md';
        const gapLines = ['---', '类型: 内容作品', '领域: 内容创作', '状态: 进行中', 'tags: []', '---', '# __探针缺口', ''];
        gapLines.push('- [ ] 打底');
        gapLines.push('> - [ ] 引用块里的');
        const g0 = await app.vault.getAbstractFileByPath(gapRel);
        if (g0) await app.vault.delete(g0, true);
        await app.vault.create(gapRel, gapLines.join('\\n'));
        await P.wait(2200);
        const gCard = P.qa('[data-card]').find((c) => (c.getAttribute('data-path') || '').indexOf('__探针缺口') >= 0);
        gapInfo = gCard
          ? '引用块缺口：框/条 = ' + (gCard.getAttribute('data-task-mismatch') || '无（！那说明它已经能收了）')
          : '缺口那篇的卡片没出来';
        const g1 = await app.vault.getAbstractFileByPath(gapRel);
        if (g1) await app.vault.delete(g1, true);
        await P.wait(800);
      } catch (e) {
        gapInfo = '缺口那篇没量成：' + e;
      }
      await drop();
      // 收尾：把看板配置拨回这一轮开工前那份（每步自己把状态拨回基线）
      if (kbc) await ctx.configs.write('board', kbc);
      await P.wait(600);
      return {
        ok: okAll,
        info: '框数=' + boxes.length + '｜对不上标记=' + (mismatch || '无') + '｜只读框=' + disabled +
              '｜恰好改一行=' + oneLine + '（' + (changedLine || '改了 ' + changed.length + ' 行') + '）' +
              '｜过深那行没动=' + deepOk +
              '｜卡面滚动 ' + beforeBody + '→' + afterBody +
              '｜列 ' + (col ? beforeCol + '→' + afterCol : '这轮没有可滚的列（没验成）') +
              '｜' + gapInfo,
      };
    })()`,
  },
  {
    name: 'P4 · 看板：跨板块拖动（文件夹源）→ 真搬 + 撤销条能撤回',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const snaps = [];
      const rel = kb + '/02_Areas/内容创作/__探针拖拽P4.md';
      const lines = ['---', '类型: 内容作品', '领域: 内容创作', '状态: 进行中', '创建日期: 2026-09-25', 'tags: []', '文件位置: []', '---', '拖拽用', ''];
      const old = await app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(rel, lines.join('\\n'));
      await P.wait(1800);

      // 换成两个文件夹源板块（写库内配置 + 空白处右键「重载」= 真路径）
      await ctx.configs.write('board', {
        version: 1,
        /**
         * ⚠️ 卡片设**矮**一点（90px）：这一屏要同时容下两个板块（源卡片 + 目标那一块），
         * 窗口一矮，目标就落到看板可视区之外 —— 指针打在 modhost 上、拖动根本没开始，
         * 而报出来的是"文件没搬过去"（真机上反复假红过两次）。矮卡片让两块都进视野。
         */
        view: { cardMode: 'content', cardHeight: 90, collapsed: [] },
        sections: [
          { id: 'p4-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
          { id: 'p4-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        ],
      });
      const body = P.q('.kbw-board-body');
      const r0 = body.getBoundingClientRect();
      P.rightClickAt(Math.round(r0.left + 14), Math.round(r0.top + 8));
      await P.wait(600);
      const clicked = await P.clickMore('重载');
      await P.wait(2000);

      // ⚠️ 早退之前**先清场**：第一轮就是这么把 __探针拖拽P4.md 留在库里的
      const cleanup = async () => {
        for (const cand of [rel, kb + '/02_Areas/每日任务/__探针拖拽P4.md']) {
          const f = await app.vault.getAbstractFileByPath(cand);
          if (f) await app.vault.delete(f, true);
        }
        await P.sweep(snaps, '__探针');
        await P.wait(900);
      };
      const card = P.qa('[data-card]').find((c) => (c.getAttribute('data-path') || '').indexOf('__探针拖拽P4') >= 0);
      if (!card) { await cleanup(); return { ok: false, info: '源卡片没出来（重载点了=' + clicked + '，板块头=' + P.qa('.kbw-sect-nm').map((h) => P.text(h)).join('/') + '）' }; }
      const target = P.qa('[data-drop="p4-b"]')[P.qa('[data-drop="p4-b"]').length - 1];
      if (!target) { await cleanup(); return { ok: false, info: '目标板块的放置区没找到（板块头=' + P.qa('.kbw-sect-nm').map((h) => P.text(h)).join('/') + '）' }; }

      /**
       * ⚠️ 顺序要紧：**先 aim 目标**（它可能在折叠下方，要滚），再 aim 源。
       * 反过来用 center() 的话，第二次 scrollIntoView 会把源滚出视野 ——
       * 第一段坐标却已经算好了（第一轮就是这么"拖了个寂寞"的）。
       */
      /**
       * 顺序：**先把源滚进视野正中**（源卡片可能在工具栏底下一条缝里 —— 那时指针会落在
       * 工具栏上、拖动根本没开始，报出来却是"文件没搬过去"），再取两个点。
       * ⚠️ 取点用**卡片本身**（不是 16px 高的标题格）：卡片的中心一定在卡片里。
       */
      /**
       * 🔴 **不能用 scrollIntoView**：它会连**整个文档**一起滚（真机实测：卡片被顶到
       * y=10、压到工具栏底下，指针down打在 view-content 上 → 拖动压根没开始，
       * 而报出来的是"文件没搬过去"）。只滚**看板自己的容器**。
       */
      const bodyEl = P.q('.kbw-board-body');
      const scrollBody = (el, frac) => {
        if (!bodyEl || !el) return;
        const b = bodyEl.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        bodyEl.scrollTop += Math.round(r.top - b.top - b.height * frac);
        document.documentElement.scrollTop = 0; // 顺手把可能被滚掉的文档拉回来
      };
      scrollBody(card, 0.15);
      await P.wait(300);
      let fromPt = P.rectAt(card);
      let toPt = P.rectAt(target);
      /**
       * ⚠️ 兜底再滚一次之后，**两个点都要重新取**：只重取目标点的话，
       * 源点坐标是滚动之前的（指针落空 → 报出来却是"文件没搬过去"）。
       * 真机第一次就是这么假红的（轨迹末点落在 modhost 上）。
       */
      if (!fromPt.visible || !toPt.visible) {
        scrollBody(target, 0.5);
        await P.wait(300);
        fromPt = P.rectAt(card);
        toPt = P.rectAt(target);
      }
      /**
       * ⚠️ "在视口里"还不够：看板区自己会滚，元素可能**被祖先的 overflow 裁掉**
       * （rect 落在视口内、elementFromPoint 却打不到它 —— 指针落到 modhost 上，
       * 症状就是"拖了个寂寞"，报出来却是"文件没搬过去"）。所以用**真实命中**来判，
       * 不中就把目标换两个姿势滚一下重来。
       */
      /**
       * ⚠️ 判据**只认"点在它里面或就是它"**（el.contains(under)），
       * 不能写 under.contains(el) —— 那会让**任何祖先**（一路到工作台根元素）都算命中，
       * 于是"点在工具栏上"也会被当成"点中了卡片"，瞄准循环白转（真机实测栽在这）。
       */
      const hits = (pt, el) => {
        const under = P.elAt(pt.x, pt.y);
        return !!under && (under === el || el.contains(under));
      };
      let aimed = hits(fromPt, card) && hits(toPt, target);
      for (let i = 0; i < 4 && !aimed; i += 1) {
        scrollBody(target, i % 2 === 0 ? 0.75 : 0.5);
        await P.wait(320);
        fromPt = P.rectAt(card);
        toPt = P.rectAt(target);
        aimed = hits(fromPt, card) && hits(toPt, target);
      }
      if (!aimed) {
        await cleanup();
        return {
          ok: false,
          info: '两个点打不到实体[压在上面的是 ' + [fromPt, toPt].map((q) => { const u = q ? P.elAt(q.x, q.y) : null; return u ? u.tagName + '.' + String(u.className).slice(0, 44) : '(null)'; }).join(' / ') + '｜窗=' + P.qa('.kbw-cw-panel').length + ']（源 ' + JSON.stringify(fromPt.rect) + ' 命中=' + hits(fromPt, card) +
                '｜目标 ' + JSON.stringify(toPt.rect) + ' 命中=' + hits(toPt, target) + '）',
        };
      }
      if (!fromPt.visible || !toPt.visible) {
        await cleanup();
        return { ok: false, info: '两个点没能同时在视野里（源 ' + (fromPt.rect || '?') + ' 可见=' + fromPt.visible + '｜目标 ' + (toPt.rect || '?') + ' 可见=' + toPt.visible + '）' };
      }
      // 起手点到底打在哪 —— 这一条能把"拖动压根没开始"和"放下了但没改对"分开
      const downOn = P.elAt(fromPt.x, fromPt.y);
      const downCls = downOn ? (downOn.className || downOn.tagName) : '?';
      P.pointerDownAt(fromPt.x, fromPt.y);
      await P.wait(40);
      for (const t of [1, 2, 3]) {
        const x = fromPt.x + ((toPt.x - fromPt.x) * t) / 8;
        const y = fromPt.y + ((toPt.y - fromPt.y) * t) / 8;
        P.pointerMoveTo(x, y);
        await P.wait(25);
      }
      const ghostOn = !!P.q('.kbw-dragghost');
      for (let t = 4; t <= 8; t += 1) {
        const x = fromPt.x + ((toPt.x - fromPt.x) * t) / 8;
        const y = fromPt.y + ((toPt.y - fromPt.y) * t) / 8;
        P.pointerMoveTo(x, y);
        await P.wait(25);
      }
      P.pointerUpAt(toPt.x, toPt.y);
      const trail = ['down@' + downCls + '，拖动药丸=' + ghostOn];
      await P.wait(3000);
      const movedTo = kb + '/02_Areas/每日任务/__探针拖拽P4.md';
      const moved = !!(await app.vault.getAbstractFileByPath(movedTo));
      const stray = !!(await app.vault.getAbstractFileByPath('02_Areas/__探针拖拽P4.md')) ||
                    !!(await app.vault.getAbstractFileByPath('__探针拖拽P4.md'));
      const undo = P.q('.kbw-undobar');
      const undoText = undo ? P.text(undo) : '(没有撤销条)';
      if (moved) snaps.push(await P.snapTop());
      const undoBtn = P.btnByText('撤销', undo);
      if (undoBtn) { P.click(undoBtn); await P.wait(2600); }
      const backHome = !!(await app.vault.getAbstractFileByPath(rel));
      const back = await app.vault.getAbstractFileByPath(rel);
      if (back) await app.vault.delete(back, true);
      const leftover = await app.vault.getAbstractFileByPath(movedTo);
      if (leftover) await app.vault.delete(leftover, true);
      await P.sweep(snaps, '__探针');
      await P.wait(1200);
      return {
        ok: moved && !stray && !!undo && backHome,
        info: '拖进目标板块=' + moved + '｜野文件落到库根=' + stray +
              '｜撤销条=' + undoText + '｜撤销后回原位=' + backHome +
              '｜轨迹末点=' + (trail[trail.length - 1] || '?') +
              '｜源点 ' + JSON.stringify(fromPt.rect) + ' → 目标点 ' + JSON.stringify(toPt.rect) +
              '｜manualOrder=' + JSON.stringify(((await P.ctx().configs.read('board')).view || {}).manualOrder || {}),
      };
    })()`,
  },
  {
    name: 'P4 · 看板：三套菜单的作用域行 + 板块管理面板（计数 / 两下确认）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const scopes = {};
      const pos = (sel, dx, dy) => {
        const el = P.q(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return [Math.round(b.left + dx), Math.round(b.top + dy)];
      };
      /**
       * 🔴 **起手声明前提：这一步全程用看板** —— 全量跑时靠上一步恰好把它留在看板
       * 而"侥幸绿"；单跑（前面 it 全跳）时 activeModule 停在上个 spec 的栏，
       * 「.kbw-board-body」为 null → 下面 getBoundingClientRect 当场抛
       *（单跑两次红都是这个形态 —— "步骤之间视野是会话态"的新例）。切模块点导航项。
       */
      if (!P.q('.kbw-board-body')) {
        const navB = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
        if (navB) { P.click(navB); await P.wait(900); }
      }
      if (!P.q('.kbw-board-body')) return { ok: false, info: '不在看板 / 切过去也没画出来' };
      const bodyPos = (() => {
        const b = P.q('.kbw-board-body');
        const r = b.getBoundingClientRect();
        return [Math.round(r.left + 14), Math.round(r.top + 8)];
      })();
      P.rightClickAt(bodyPos[0], bodyPos[1]);
      await P.wait(500);
      scopes.global = P.text(P.q('.kbw-menu-scope'));

      // ④ 点别处空白 → 菜单要关（用户 2026-09-25 真机反馈：以前关不掉）
      const opened = !!P.q('.kbw-menu');
      P.pointerDownAt(Math.round(window.innerWidth - 24), Math.round(window.innerHeight - 24));
      await P.wait(400);
      const closedByOutside = !P.q('.kbw-menu');
      if (!closedByOutside) P.closeAll(2);
      await P.wait(300);

      const sp = P.aimAt(P.q('.kbw-sect-head'));
      if (!sp) return { ok: false, info: '没有板块头（看板上没有板块？）' };
      await P.wait(200);
      P.rightClickAt(sp.x, sp.y);
      await P.wait(500);
      scopes.section = P.text(P.q('.kbw-menu-scope'));
      const sectionItems = P.qa('.kbw-menu-item').map((i) => P.text(i)).join('/');
      P.closeAll(2);
      await P.wait(300);

      const card = P.qa('[data-card]')[0];
      if (!card) return { ok: false, info: '没有卡片' };
      const cp = P.aimAt(card.querySelector('.kbw-card-t') || card);
      await P.wait(200);
      P.rightClickAt(cp.x, cp.y);
      await P.wait(500);
      scopes.note = P.text(P.q('.kbw-menu-scope'));
      const noteItems = P.qa('.kbw-menu-item').length;
      P.closeAll(2);
      await P.wait(300);

      /**
       * 🔴 **先清选择**（坑单老账的看板现场版）：**有选择时工具条整条被批量栏顶掉**
       * （§3.4）→「板块」按钮根本不在。本次取证实录：
       * toolbar 里全是"迁移/属性/标签/更多/全选 10 篇"——三步菜单操作留下的选择。
       * 清法**认 aria-label**（不认类名）——与"全部笔记"那几处的老写法同源。
       */
      const batchBar2 = P.q('.kbw-board-toolbar .kbw-notes-bar.is-batch') ?? P.q('.kbw-notes-bar.is-batch');
      if (batchBar2) {
        const x2 = Array.from(batchBar2.querySelectorAll('button')).find(
          (b) => (b.getAttribute('aria-label') || '').includes('清空选择'),
        );
        if (x2) { P.click(x2); await P.wait(400); }
      }
      /**
       * ⚠️ 前面三处「P.closeAll」（连按 Esc）之后看板可能**正处在重挂/异步重画的窗口**里——
       * 工具条是后画的：给「板块」按钮一次重试（全量那轮的"找不到按钮"就是这个窗口）。
       */
      let gm2 = P.sectMgr();
      if (!gm2) {
        await P.wait(900);
        gm2 = P.sectMgr();
      }
      if (!gm2) {
        const dbg2 = 'active=' + P.ctx().store.get().activeModule +
          '｜有board=' + !!P.q('.kbw-board') +
          '｜有toolbar=' + !!P.q('.kbw-board-toolbar') +
          '｜工具条按钮=' + P.qa('.kbw-board-toolbar button').map((b) => P.text(b)).join('/') +
          '｜有批量栏=' + !!P.q('.kbw-notes-bar.is-batch') +
          '｜全页按钮数=' + P.qa('button').length;
        return { ok: false, info: '工具条上找不到「板块」按钮（' + dbg2 + '）' };
      }
      P.click(gm2);
      await P.wait(800);
      const rows = P.qa('.kbw-bp-row');
      const cnt = rows.length > 0 ? P.text(rows[0].querySelector('.kbw-bp-count')) : '?';
      const firstDelBtn = () => {
        const r0 = P.qa('.kbw-bp-row')[0];
        return r0 ? Array.from(r0.querySelectorAll('.kbw-iconbtn')).pop() : null;
      };
      const before = rows.length;
      const b0 = firstDelBtn();
      if (b0) { P.click(b0); await P.wait(700); }
      // ⚠️ 点完**重取**：面板会整块重画，抓着旧节点读到的是它改之前的样子
      const midTxt = (function () { const b = firstDelBtn(); return b ? P.text(b) : '?'; })();
      const stillThere = P.qa('.kbw-bp-row').length;
      P.closeAll(3);
      await P.wait(500);
      return {
        ok: scopes.global.indexOf('全部板块') >= 0 && scopes.section.indexOf('内容创作') >= 0 &&
            scopes.note.indexOf('.md') < 0 && noteItems > 0 && stillThere === before &&
            midTxt.indexOf('再点一次') >= 0 && opened && closedByOutside,
        info: '空白=' + scopes.global + '｜板块头(aim ' + JSON.stringify(sp.rect) + ')=' + scopes.section + '（项=' + sectionItems + '）' +
              '｜卡片=' + scopes.note + '（P1 菜单 ' + noteItems + ' 项）｜面板计数=' + cnt +
              '｜删第一下没删=' + (stillThere === before) + ' 按钮变「' + midTxt + '」' +
              '｜点别处空白关菜单=' + (opened && closedByOutside),
      };
    })()`,
  },
  {
    name: 'P4 · 看板：卡片显示三档 / 宽度拉杆 / 显示属性多选（改设置不关窗 + 顶上一行回执）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const body = P.q('.kbw-board-body');
      const r = body.getBoundingClientRect();
      const at = [Math.round(r.left + 14), Math.round(r.top + 8)];
      P.rightClickAt(at[0], at[1]);
      await P.wait(500);
      // 卡片显示 →（子菜单）只属性。⚠️ 菜单项是 div，不是 button
      const openedSub = P.clickAny('卡片显示');
      await P.wait(500);
      const pickedProps = P.clickAny('只属性');
      await P.wait(1400);
      const kvCards = P.qa('.kbw-card-kv').length;
      const receiptEl = P.q('.kbw-board-receipt');
      const receipt = receiptEl ? P.text(receiptEl) : '(没有回执)';
      /**
       * 🔴 第二波反馈那条第 2 项的真机判据：**回执的框要整个落在工具条的框里**。
       * 用户截图：窗口一矮，顶上那条紫色回执被裁掉一小截 —— 它原先挂在工具条**上沿之外**
       * （top: -2px + translate(-50%, -100%)），可见性取决于工具条上方还有没有空间。
       * 判据用"包含关系"而不是"top 等于几"：包含关系才是"看不看得见"的几何表达。
       * ⚠️ 局限照实说：窗口够高时**旧写法也能过**这条（旧版是"超出上沿"、不是"越出屏幕"）；
       * 真正拦回归的是离线那条 CSS 源级断言（transform 不许是 -100%）。
       */
      let receiptInBar = false;
      let receiptBox = '（没有回执元素）';
      const barEl = P.q('.kbw-board-bar');
      if (receiptEl && barEl) {
        const rb = receiptEl.getBoundingClientRect();
        const bb = barEl.getBoundingClientRect();
        receiptInBar = rb.height > 0 && rb.top >= bb.top - 0.5 && rb.bottom <= bb.bottom + 0.5;
        receiptBox =
          '回执 ' + Math.round(rb.top) + '–' + Math.round(rb.bottom) +
          ' ⊂ 工具条 ' + Math.round(bb.top) + '–' + Math.round(bb.bottom);
      }
      const stillContent = P.qa('.kbw-segbtn').filter((b) => b.classList.contains('is-on')).map((b) => P.text(b)).join('/');
      P.closeAll(2);
      await P.wait(400);

      // 宽度拉杆：160–480
      P.rightClickAt(at[0], at[1]);
      await P.wait(500);
      menu = P.q('.kbw-menu');
      const range = (P.lastMenu() || document).querySelector('input[type="range"]');
      let widthOk = false;
      let w = '';
      if (range) {
        range.value = '360';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(1200);
        const holder = P.q('.kbw-cards');
        w = holder ? holder.style.getPropertyValue('--kbw-card-w') : '';
        widthOk = w === '360px';
      }
      P.closeAll(2);
      await P.wait(400);

      // ⑤ 固定高度（用户 2026-09-25 要的）：卡片等高、正文填满、不再画「展开」
      P.rightClickAt(at[0], at[1]);
      await P.wait(500);
      const ranges = (P.lastMenu() || document).querySelectorAll('input[type="range"]');
      let heightOk = false;
      let heightInfo = '（没拿到高度拉杆）';
      if (ranges.length >= 2) {
        ranges[1].value = '320';
        ranges[1].dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(1400);
        P.closeAll(2);
        await P.wait(300);
        const holder = P.q('.kbw-cards');
        const card = P.q('[data-card]');
        const h = card ? Math.round(card.getBoundingClientRect().height) : 0;
        heightOk =
          !!holder && holder.classList.contains('has-h') && h >= 300 && P.qa('.kbw-card-more').length === 0;
        heightInfo =
          '卡片高=' + h + '｜has-h=' + (holder ? holder.classList.contains('has-h') : '?') +
          '｜还画着「展开」=' + P.qa('.kbw-card-more').length;
      }

      // ⑥ Ctrl+滚轮缩放：宽度要变，且配置跟着落盘
      const beforeW = P.q('.kbw-cards') ? P.q('.kbw-cards').style.getPropertyValue('--kbw-card-w') : '';
      /**
       * 🔴 还要量**用户真正看到的那个宽度**（独立审查 🟡1）：原先只读 .kbw-cards 的内联
       * --kbw-card-w —— 那正是代码写的地方，所以"列形态下列宽纹丝不动"这个 bug 它**量不到**
       *（卡片被 max-width:100% 夹在列里、列又没变 → 手势期间整个看板不动，只有回执在滚数字）。
       * 列宽读的是 .kbw-sect 上那一份 → 量**板块的 rect 宽度**，且在**防抖落盘之前**量
       *（落盘后会整块重绘"跳"一下，那时候变是假的）。
       */
      const sectEl0 = P.q('.kbw-sect');
      const sectBefore = sectEl0 ? Math.round(sectEl0.getBoundingClientRect().width) : 0;
      const bd = P.q('.kbw-board-body');
      const rc = bd.getBoundingClientRect();
      const at2 = [Math.round(rc.left + 40), Math.round(rc.top + 40)];
      const wheelAt = (dy, ctrl) => {
        bd.dispatchEvent(new WheelEvent('wheel', {
          deltaY: dy, ctrlKey: ctrl, bubbles: true, cancelable: true, clientX: at2[0], clientY: at2[1],
        }));
      };
      wheelAt(-120, false);
      await P.wait(150);
      const afterPlain = P.q('.kbw-cards').style.getPropertyValue('--kbw-card-w');
      wheelAt(-120, true);
      wheelAt(-120, true);
      await P.wait(150);
      const afterZoom = P.q('.kbw-cards').style.getPropertyValue('--kbw-card-w');
      const sectAfterZoom = sectEl0 ? Math.round(sectEl0.getBoundingClientRect().width) : 0;
      await P.wait(1000);
      const ctx = P.ctx();
      const savedW = (await ctx.configs.read('board')).view.cardWidth;
      /**
       * 判据取**两种形态都成立的不变量**：声明的卡片宽度必须装得进板块宽度。
       * （不写成"板块宽必须变"：流式下板块本来就是一整行，宽度不随卡片宽度变 → 会假红。
       * 写成"装得下"刚好卡住这个 bug：列形态下卡片区那份写到了 340，而列还停在 256 →
       * 卡片被 max-width: 100% 夹回 256，用户看到的就是"滚了没反应"。）
       */
      const declaredW = parseInt(afterZoom, 10);
      const sectOk = sectBefore === 0 || sectAfterZoom >= declaredW - 4;
      const zoomOk =
        afterPlain === beforeW && afterZoom !== beforeW && savedW === declaredW && sectOk;
      P.closeAll(2);
      await P.wait(300);

      // 收尾：档位与尺寸都拨回默认（这一步是**写库内配置**的，别给下一轮留状态）
      const c1 = (await ctx.configs.read('board')) || { view: {} };
      await ctx.configs.write('board', {
        ...c1,
        view: { ...c1.view, cardMode: 'content', cardWidth: 240, cardHeight: 0 },
      });
      await P.wait(500);
      return {
        // 回执"待在工具条里"也进判据 —— 它就是这个步骤名下那半句（第二波反馈第 2 项）
        ok: kvCards > 0 && widthOk && heightOk && zoomOk && receiptInBar,
        info: '开子菜单=' + openedSub + ' 选中只属性=' + pickedProps + '｜带 kv 的卡片=' + kvCards +
              ' 张｜工具条高亮档=' + stillContent + '｜回执=' + receipt + '｜' + receiptBox +
              '（在工具条内=' + receiptInBar + '）｜拉杆 → --kbw-card-w=' + (w || '(没拿到)') +
              '｜固定高度：' + heightInfo + '｜Ctrl+滚轮：' + beforeW + ' → ' + afterZoom +
              '（不按 Ctrl 时 ' + afterPlain + ' 没变）｜落盘 cardWidth=' + savedW +
              '｜板块宽 ' + sectBefore + ' → ' + sectAfterZoom + '（要 ≥ 卡片宽 ' + (afterZoom || '?') + '）'
      };
    })()`,
    shot: 'p4-看板-只属性档.png',
    // 截图前先切到「只属性」并给一个能看清属性行的宽度（截完拨回去）
    before: async (cdp) => {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        const ctx = P.ctx();
        const cur = await ctx.configs.read('board');
        await ctx.configs.write('board', {
          ...cur,
          view: { ...cur.view, cardMode: 'props', cardWidth: 300, cardHeight: 0 },
        });
        await P.wait(1400);
        return true;
      })()`);
    },
    after: async (cdp) => {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        const ctx = P.ctx();
        const cur = await ctx.configs.read('board');
        await ctx.configs.write('board', {
          ...cur,
          view: { ...cur.view, cardMode: 'content', cardWidth: 240, cardHeight: 0 },
        });
        await P.wait(1200);
        return true;
      })()`);
    },
  },
  {
    name: 'P4.5 · 拉杆：圆点与横杆**同心**（真机几何；伪元素量不到 rect → 构造性判据 + 截图人眼）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const body = P.q('.kbw-board-body');
      if (!body) return { ok: false, info: '看板没开着（这一步要有看板）' };
      const r = body.getBoundingClientRect();
      P.rightClickAt(Math.round(r.left + 14), Math.round(r.top + 8));
      await P.wait(600);
      const menu = P.lastMenu() || document;
      const range = menu.querySelector('input[type="range"]');
      if (!range) { P.closeAll(2); return { ok: false, info: '菜单里没找到拉杆' }; }
      /**
       * 🔴 **先自证"伪元素几何读不读得到"**（独立审查点出的假绿风险，校准当场证实）：
       * 往圆点伪元素注入一个**只有伪元素才可能有的高度**（33px，输入框仍是 12px），再读回来：
       *   读到 33 → 这把尺子量的是伪元素（下面的几何判据可信）
       *   读到 12 → 它量的是**输入框自己** → 几何判据恒真、删光 CSS 也照样绿 → **不能用它当判据**
       * 实测（Obsidian 1.13.7 / Electron）：读回 **12** → 所以下面走的是**层叠级**判据，不再假装量几何。
       */
      const cal = document.createElement('style');
      cal.textContent =
        'input[type="range"].kbw-range::-webkit-slider-thumb, input[type="range"].kbw-range::-webkit-slider-runnable-track' +
        ' { height: 33px !important; }';
      document.head.appendChild(cal);
      const calH = parseFloat(getComputedStyle(range, '::-webkit-slider-thumb').height) || 0;
      const calTrack = parseFloat(getComputedStyle(range, '::-webkit-slider-runnable-track').height) || 0;
      cal.remove();
      const pseudoReadable = calH === 33 && calTrack === 33;
      /**
       * ① **元素级事实**（读得到、也可靠）：输入框高 == 圆点直径（变量），轨道盒也按同一变量画。
       */
      const cs = getComputedStyle(range);
      const dot = cs.getPropertyValue('--kbw-range-dot').trim();
      const bar = cs.getPropertyValue('--kbw-range-bar').trim();
      const inputH = parseFloat(cs.height) || 0;

      /**
       * ② 🔴 **伪元素的几何在这平台上读不到** —— 上一步的自证（注入 33px 读回 ' + 12 那个数）就是证据：
       *    getComputedStyle(el, 伪元素选择器) 返回的是**输入框自己**的计算样式，
       *    所以"圆点高 == 轨道盒高 == 输入框高"这种判据**恒真**（三条读的是同一个东西）——
       *    删光我们的 CSS 它照样绿。这条是独立审查点出来的，校准当场证实（读回 12 而不是 33）。
       *    因此判据改成**层叠级**：把样式表里命中"圆点伪元素"的规则全摊开，
       *    按 (特异度, 出现顺序) 算出每个属性的**赢家**，断言赢家是**我们那条**规则 ——
       *    它能挡住"有人删了 position:static/top:auto/margin:0"或"平台加了更狠的规则"。
       */
      const specOf = (sel) => {
        const clean = sel.replace(/::[a-z-]+/gi, '');
        let ids = 0, cls = 0, el = 0;
        for (const m of clean.matchAll(/(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])|(:[\w-]+(?:\([^)]*\))?)?/g)) {
          const tok = m[0];
          if (!tok) continue;
          if (tok.startsWith('#')) ids += 1;
          else if (tok.startsWith('.') || tok.startsWith('[') || tok.startsWith(':')) {
            if (!tok.includes('not(')) cls += 1;
          } else if (/^[a-z]/i.test(tok)) el += 1;
        }
        const pseudoEls = (sel.match(/::[a-z-]+/gi) || []).length + (sel.match(/:(?:before|after|first-line|marker)/gi) || []).length;
        return [ids, cls, el + pseudoEls];
      };
      /**
       * ⚠️ **我们那份 CSS 在 document.styleSheets 里解析出 0 条规则**（平台注入方式使然，实测）——
       * 所以把它的文本重新丢进一个临时 style 表再枚举（同源、必然被解析）。
       */
      const ourCss = Array.from(document.querySelectorAll('style'))
        .map((el) => el.textContent || '')
        .find((t) => t.includes('kbw-range')) || '';
      const tempSheet = document.createElement('style');
      tempSheet.textContent = ourCss;
      document.head.appendChild(tempSheet);
      /** 命中"圆点"的规则：选择器里既要有 input[type=range] 又要有 thumb 伪元素 */
      const thumbRules = [];
      let order = 0;
      let sheetCount = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = Array.from(sheet.cssRules || []); } catch (e) { continue; }
        sheetCount += 1;
        const walk = (list) => {
          for (const r of list) {
            /**
             * ⚠️ 顺序要紧：**先看这条规则自己，再往下钻**。
             * 新版 Chromium 给样式规则也挂了 cssRules（CSS 嵌套用，通常是空表）——
             * 先判 r.cssRules 就会 continue 掉，一条普通规则都扫不到（实测踩过：规则数 0）。
             */
            if (r.selectorText && /input\\[type=['"]?range['"]?\\]/i.test(r.selectorText)) {
              for (const sel of r.selectorText.split(',')) {
                if (!/::-webkit-slider-thumb/.test(sel)) continue;
                /**
                 * ⚠️ **只看"默认态"那条**：:hover / :active 也声明了同样的几何，
                 * 把它们算进候选，"基础块被删掉"就会被 hover 块掩盖（突变实验证实过一次）——
                 * 而决定"平时圆点是否骑在中线上"的正是默认态那条。静态检查没法评估状态伪类，
                 * 索性按"默认态"判：谁赢了 position/top/margin-top/height，就是谁在管观感。
                 */
                if (/:(hover|active|focus)/.test(sel)) continue;
                order += 1;
                thumbRules.push({ sel: sel.trim(), spec: specOf(sel), order, style: r.style });
              }
            }
            if (r.cssRules && r.cssRules.length) walk(Array.from(r.cssRules));
          }
        };
        walk(rules);
      }
      if (pseudoReadable) {
        const t = getComputedStyle(range, '::-webkit-slider-thumb');
        const tr = getComputedStyle(range, '::-webkit-slider-runnable-track');
        const same = parseFloat(t.height) === parseFloat(tr.height) && parseFloat(t.height) === inputH;
        const noOffset = t.position === 'static' && (t.top === 'auto' || parseFloat(t.top) === 0) && parseFloat(t.marginTop) === 0;
        if (!same || !noOffset) {
          P.closeAll(2);
          return { ok: false, info: '几何不对：圆点 ' + t.height + ' / 轨道盒 ' + tr.height + ' / 输入框 ' + inputH + '，position=' + t.position + ' top=' + t.top + ' margin-top=' + t.marginTop };
        }
      }
      const props = ['position', 'top', 'margin-top', 'height'];
      const winners = {};
      for (const p of props) {
        let best = null;
        for (const r of thumbRules) {
          const v = r.style.getPropertyValue(p);
          if (v === '') continue;
          const imp = r.style.getPropertyPriority(p) ? 1 : 0;
          const key = [imp, r.spec[0], r.spec[1], r.spec[2], r.order];
          if (!best || key.join() > best.key.join()) best = { key, v, sel: r.sel, ours: /\.kbw-range|\.kbw-slider/.test(r.sel) };
        }
        winners[p] = best;
      }
      tempSheet.remove();
      const bad = props.filter((p) => !winners[p] || !winners[p].ours);
      const detail = props.map((p) => p + '=' + (winners[p] ? winners[p].v + (winners[p].ours ? '〔我们〕' : '〔别人:' + winners[p].sel + '〕') : '（没有规则设它）')).join('｜');
      return {
        ok: bad.length === 0 && inputH > 0 && dot !== '' && bar !== '',
        info: (bad.length === 0 ? '' : 'FLOOR:这几个属性的赢家不是我们那条 → ' + bad.join('/') + '；') +
              '规则条数=' + thumbRules.length + '（扫了 ' + sheetCount + ' 张表）｜赢家：' + detail +
              '｜输入框高=' + inputH + '｜变量 --kbw-range-dot=' + dot + ' / -bar=' + bar +
              (pseudoReadable
                ? '【伪元素几何读得到（注入 33px 读回 ' + calH + 'px）→ 几何判据也过了】'
                : '【伪元素几何读不到（注入 33px 读回 ' + calH + 'px，读到的是输入框自己）→ 判据走层叠级；真机上再看截图】'),
      };
    })()`,
    shot: 'p45-拉杆-几何.png',
    after: async (cdp) => {
      await cdp.eval(`(async () => { window.__kbwProbe.closeAll(2); await window.__kbwProbe.wait(300); return true; })()`);
    },
  },
  {
    name: 'P4.5 · Ctrl+滚轮：**自动高度档缩放之后笔记真的变高**（锁成固定高度 + 配置落盘）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const cur = await ctx.configs.read('board');
      // 先把这块拨到"自动高度 + 宽度 300，不按 Ctrl 的滚轮不动它"
      await ctx.configs.write('board', {
        ...cur,
        view: { ...cur.view, cardMode: 'content', cardWidth: 300, cardHeight: 0, collapsed: [] },
      });
      await P.wait(1400);
      P.closeAll(2);
      await P.wait(300);
      const holder = P.q('.kbw-cards');
      const card = P.q('[data-card]');
      if (!holder || !card) return { ok: false, info: '看板上没有卡片可量' };
      const beforeH = Math.round(card.getBoundingClientRect().height);
      const beforeHasH = holder.classList.contains('has-h');
      const bd = P.q('.kbw-board-body');
      const rb = bd.getBoundingClientRect();
      const at = [Math.round(rb.left + 40), Math.round(rb.top + 40)];
      bd.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true, clientX: at[0], clientY: at[1],
      }));
      await P.wait(1200);
      const holder2 = P.q('.kbw-cards');
      const card2 = P.q('[data-card]');
      const afterH = card2 ? Math.round(card2.getBoundingClientRect().height) : 0;
      const afterHasH = holder2 ? holder2.classList.contains('has-h') : false;
      const saved = (await ctx.configs.read('board')).view;
      // 收尾：拨回默认（这一步会写库内配置）
      await ctx.configs.write('board', {
        ...cur,
        view: { ...cur.view, cardMode: 'content', cardWidth: 240, cardHeight: 0 },
      });
      await P.wait(900);
      return {
        ok: beforeH > 0 && afterH > beforeH && !beforeHasH && afterHasH && saved.cardHeight > 0,
        info: '卡片高 ' + beforeH + ' → ' + afterH + 'px｜has-h ' + beforeHasH + ' → ' + afterHasH +
              '｜落盘 cardHeight=' + saved.cardHeight + '（自动档首次缩放锁成固定高度）',
      };
    })()`,
  },
  {
    name: 'P4.5 · 同板块拖动：**指示线画的缝 == 松手落点**（"差一格"那个 bug 的真机判据）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      /** 早退也要清场：这一步会写库内配置（顺序表 + 手动档）+ 自造的目录 */
      const cleanup = async () => {
        await ctx.configs.write('board', backup);
        await P.wait(900);
        await P.dropGridDir('网格B');
      };
      await ctx.configs.write('board', {
        version: 1,
        view: { cardMode: 'content', cardHeight: 90, collapsed: [], manualOrder: {} },
        sections: [
          { id: 'p45s', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        ],
      });
      await P.wait(1200);
      const bodyEl = P.q('.kbw-board-body');
      const rb = bodyEl.getBoundingClientRect();
      P.rightClickAt(Math.round(rb.left + 14), Math.round(rb.top + 8));
      await P.wait(500);
      await P.clickMore('重载');
      await P.wait(2000);

      const pathsNow = () => P.qa('[data-drop="p45s"] [data-card]').map((c) => c.getAttribute('data-path') || '');
      const order0 = pathsNow();
      if (order0.length < 4) { await cleanup(); return { ok: false, info: '这一块至少要有 4 张卡（现在 ' + order0.length + '）' }; }

      const cards = P.qa('[data-drop="p45s"] [data-card]');
      const src = cards[0];
      const tgt = cards[2];
      const scrollBody = (el, frac) => {
        if (!bodyEl || !el) return;
        const b = bodyEl.getBoundingClientRect();
        const rr = el.getBoundingClientRect();
        bodyEl.scrollTop += Math.round(rr.top - b.top - b.height * frac);
        document.documentElement.scrollTop = 0;
      };
      scrollBody(src, 0.3);
      await P.wait(300);
      const hits = (pt, el) => {
        const under = P.elAt(pt.x, pt.y);
        return !!under && (under === el || el.contains(under));
      };
      /**
       * ⚠️ **取点前先确认两个点都可见**：rectAt 对不可见元素不给 x/y（undefined）——
       * 直接拿去做 elementFromPoint 会抛 "double value is non-finite"（第一次就是这么红的）。
       * 打不到就换个姿势再滚一次，两个点必须重取（老账：只重取目标点会让源点坐标作废）。
       */
      let fromPt = P.rectAt(src);
      let toPt = P.rectAt(tgt);
      const usable = (a, b) =>
        a.visible && b.visible && Number.isFinite(a.x) && Number.isFinite(b.y);
      if (!usable(fromPt, toPt) || !hits(fromPt, src) || !hits(toPt, tgt)) {
        scrollBody(tgt, 0.5);
        await P.wait(320);
        fromPt = P.rectAt(src);
        toPt = P.rectAt(tgt);
      }
      if (!usable(fromPt, toPt) || !hits(fromPt, src) || !hits(toPt, tgt)) {
        await cleanup();
        return { ok: false, info: '两个点打不到实体（源 ' + JSON.stringify(fromPt) + '｜目标 ' + JSON.stringify(toPt) + '）' };
      }
      /**
       * 指针落在**第 3 张卡的左半边**（左 1/3 处）→ 应当"插到它前面"：
       * 线画在第 2 张与第 3 张之间；松手后第 1 张应当**紧挨在第 3 张前面**。
       */
      // ⚠️ rectAt 回的是**数组** [left, top, width, height]（不是对象）—— 别按对象取
      /**
       * 🔴 **取点与判据必须同一个轴**（独立审查 🟡2，b 期补）：
       * 这一条原先固定取"第 3 张卡的左半边、垂直中心"（toPt.y），而列形态判"前半张/后半张"
       * 用的是**严格大于**卡片中心 —— 取在正好中心上，落前还是落后就由那个中心的**小数部分**决定
       *（Math.round 往上一点就翻面）。真机上一旦翻面，inGap 与"紧挨在第 3 张前面"**一起红**，
       * 报出来是"落点不对"，其实是**尺子踩在等号边界上**。
       * 现在：先在**拖动之前**用几何定轴（下面的 vertical，与 drag.ts 的 cardsAxis 同口径），
       * 纵向就取目标卡**上四分之一**处（明确落在"前半张"里），横向仍取左 1/4。
       */
      const preRects = P.qa('[data-drop="p45s"] [data-card]').map((c) => c.getBoundingClientRect());
      const vertical = preRects.length >= 2 &&
        Math.abs(preRects[1].top - preRects[0].top) > Math.abs(preRects[1].left - preRects[0].left);
      const dropX = vertical
        ? Math.round(toPt.rect[0] + toPt.rect[2] / 2)
        : Math.round(toPt.rect[0] + Math.min(24, toPt.rect[2] / 4));
      const dropY = vertical ? Math.round(toPt.rect[1] + toPt.rect[3] * 0.25) : toPt.y;
      P.pointerDownAt(fromPt.x, fromPt.y);
      await P.wait(40);
      for (let t = 1; t <= 8; t += 1) {
        P.pointerMoveTo(fromPt.x + ((dropX - fromPt.x) * t) / 8, fromPt.y + ((dropY - fromPt.y) * t) / 8);
        await P.wait(28);
      }
      const line = P.q('.kbw-dropline');
      const live = P.qa('[data-drop="p45s"] [data-card]');
      const c2 = live[1] ? live[1].getBoundingClientRect() : null;
      const c3 = live[2] ? live[2].getBoundingClientRect() : null;
      const lb = line ? line.getBoundingClientRect() : null;
      /**
       * ⚠️ **判据要跟着布局的轴走**（2026-09-25 b 期补）：这一条原先只看 x
       *（"线的左沿落在前一张的右边与后一张的左边之间"）—— 那是**流式**（横排）的几何。
       * 列形态下卡片是**纵向**堆的，指示线自己也转了 90°（横条），此时两张卡的左右边必然重叠
       *（都在同一列里），x 判据**必然为假**，而落点其实完全正确
       *（同一轮里"松手后紧挨在第 3 张前面=true"就是证据 —— 真红的是判据，不是功能）。
       * 现在按**几何**选轴，与 drag.ts 的 cardsAxis 同一个口径：纵向堆就看上下。
       */
      const inGap = !!(lb && c2 && c3 && (vertical
        ? lb.top >= c2.bottom - 10 && lb.top <= c3.top + 10
        : lb.left >= c2.right - 10 && lb.left <= c3.left + 10));
      if (!line) { P.pointerUpAt(dropX, dropY); await P.wait(600); await cleanup(); return { ok: false, info: '拖动途中没有指示线（拖动真的开始了吗？）' }; }
      P.pointerUpAt(dropX, dropY);
      await P.wait(1500);
      const order1 = pathsNow();
      const dragged = order0[0];
      const at = order1.indexOf(dragged);
      const before = order1[at + 1] || '';
      const landedBeforeC3 = at >= 0 && before === order0[2];
      const lineWhere = lb
        ? Math.round(lb.width) + '×' + Math.round(lb.height) + 'px 在 ' + (vertical
            ? '纵轴 ' + Math.round(lb.top) + '（第2张下边 ' + Math.round(c2.bottom) + '、第3张上边 ' + Math.round(c3.top) + '）'
            : '横轴 ' + Math.round(lb.left) + '（第2张右边 ' + Math.round(c2.right) + '、第3张左边 ' + Math.round(c3.left) + '）')
        : '(没有)';
      await cleanup();
      return {
        ok: inGap && landedBeforeC3,
        info: '拖动前顺序=' + order0.map((p) => p.split('/').pop()).join('>') +
              '｜线的位置=' + lineWhere + '，落在两卡之间=' + inGap +
              '｜松手后顺序=' + order1.map((p) => p.split('/').pop()).join('>') +
              '｜它紧挨在第3张前面=' + landedBeforeC3,
      };
    })()`,
  },
  {
    name: 'a.5-1 拖出去再拖回原处松手：**不开窗、顺序一个字节没变**（真机几何）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      const cleanup = async () => {
        await ctx.configs.write('board', backup);
        await P.wait(900);
      };
      await ctx.configs.write('board', {
        version: 1,
        view: { cardMode: 'content', cardHeight: 90, collapsed: [], manualOrder: {} },
        sections: [
          { id: 'a5d', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: { key: '名称', dir: 'asc' }, cardMode: null, props: null },
        ],
      });
      await P.wait(1200);
      const bodyEl = P.q('.kbw-board-body');
      const rb = bodyEl.getBoundingClientRect();
      P.rightClickAt(Math.round(rb.left + 14), Math.round(rb.top + 8));
      await P.wait(500);
      await P.clickMore('重载');
      await P.wait(2000);

      const pathsNow = () => P.qa('[data-drop="a5d"].kbw-cards [data-card]').map((c) => c.getAttribute('data-path') || '');
      const order0 = pathsNow();
      const holder = P.q('[data-drop="a5d"].kbw-cards');
      if (!holder || order0.length < 3) { await cleanup(); return { ok: false, info: '这块卡片不够（' + order0.length + '）' }; }
      const cards = P.qa('[data-drop="a5d"].kbw-cards [data-card]');
      const src = cards[0];
      const scrollBody = (el, frac) => {
        if (!bodyEl || !el) return;
        const b = bodyEl.getBoundingClientRect();
        const rr = el.getBoundingClientRect();
        bodyEl.scrollTop += Math.round(rr.top - b.top - b.height * frac);
        document.documentElement.scrollTop = 0;
      };
      scrollBody(src, 0.3);
      await P.wait(300);
      const hits = (pt, el) => {
        const under = P.elAt(pt.x, pt.y);
        return !!under && (under === el || el.contains(under));
      };
      let fromPt = P.rectAt(src);
      if (!fromPt.visible || !Number.isFinite(fromPt.x) || !hits(fromPt, src)) {
        scrollBody(src, 0.5);
        await P.wait(320);
        fromPt = P.rectAt(src);
      }
      if (!fromPt.visible || !Number.isFinite(fromPt.x) || !hits(fromPt, src)) {
        await cleanup();
        return { ok: false, info: '源卡片的点打不到实体（' + JSON.stringify(fromPt) + '）' };
      }
      const awayX = Math.min(window.innerWidth - 30, Math.round(fromPt.x + 260));
      P.pointerDownAt(fromPt.x, fromPt.y);
      await P.wait(40);
      for (let t = 1; t <= 6; t += 1) {
        P.pointerMoveTo(fromPt.x + ((awayX - fromPt.x) * t) / 6, fromPt.y + 26 * (t / 6));
        await P.wait(28);
      }
      await P.wait(150);
      // 拖回来：落点就是它自己身上（松手那一下会补一发 click —— 那正是要吞掉的）
      P.pointerMoveTo(fromPt.x, fromPt.y);
      await P.wait(60);
      P.pointerUpAt(fromPt.x, fromPt.y);
      await P.wait(30); // ⚠️ 要**立刻**补那一发（浏览器就在 pointerup 之后几 ms 补；等 400ms 早过窗口了）
      /**
       * 🔴 **补一发"完整鼠标序列"**（独立审查 🟡4）：合成的 pointerup **不会**让浏览器补 click，
       * 所以"松手后没有浮层"这条判据**删掉守卫也照样绿**。这里显式补上那一发
       *（P.click 走 pointerdown/mousedown/mouseup/click 全套 —— 与真机上浏览器补的那一下等价）。
       */
      const srcNow = P.qa('.kbw-cards[data-drop="a5d"] [data-card]')[0];
      if (srcNow) P.click(srcNow);
      await P.wait(400);
      const panelAfterDrop = P.qa('.kbw-panel').length;
      const order1 = pathsNow();
      const saved = (await ctx.configs.read('board')) || {};
      const sec = (saved.sections || []).find((s) => s.id === 'a5d') || {};
      const wroteOrder = !!(saved.view && saved.view.manualOrder && saved.view.manualOrder.a5d);
      const same = order0.join('|') === order1.join('|');
      await cleanup();
      return {
        ok: panelAfterDrop === 0 && same && !wroteOrder && (sec.sort || {}).key === '名称',
        info: '松手后浮层=' + panelAfterDrop + '（应为 0）｜顺序没变=' + same +
              '｜写了顺序表=' + wroteOrder + '（应为 false）｜这一块的排序=' + ((sec.sort || {}).key || '(空)') +
              '｜顺序 ' + order0.map((p) => p.split('/').pop()).join('>'),
      };
    })()`,
  },
  {
    name: 'a.5-4 任务清单卡：勾选框**不被切**（框左 ≥ 正文左）+ 按条数截（展开能看全）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      /**
       * ⚠️ 认「看板」为当前模块再开工（P7.9 补）：全量跑里前面的步骤已经停在看板，
       * 但「--only」单跑时模块可能还在别处 —— 那时「.kbw-board-body」不存在，
       * 下面直接 TypeError（不是功能坏了，是这一步没有自足前提）。
       */
      const navBoard = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (navBoard && !navBoard.classList.contains('is-on')) { P.click(navBoard); await P.wait(900); }
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      /** 自备夹具（P7.13a 回改，见下面那段注释）—— cleanup 一起把它收走 */
      const kb2 = ctx.settings.kbRoot();
      const fixPath = kb2 + '/00_Inbox/__探针任务卡.md';
      const cleanup = async () => {
        const fx = app.vault.getAbstractFileByPath(fixPath);
        if (fx) await app.vault.delete(fx, true);
        await ctx.configs.write('board', backup);
        await P.wait(900);
      };
      await ctx.configs.write('board', {
        version: 1,
        view: { cardMode: 'content', cardHeight: 0, collapsed: [], summaryLines: 3, manualOrder: {} },
        sections: [
          { id: 'a5t', name: '收件箱', kind: 'folder', value: '00_Inbox', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        ],
      });
      await P.wait(1200);
      /**
       * ⚠️ **自备夹具**（P7.13a · 探针回改）：这一步原先蹭"收件箱里正好有一张 ≥5 条任务的卡" ——
       * 用户把收件箱清到 1 篇之后**恒红**（2026-10-07 立案前就红，不是功能坏）。
       * 现在自己造「/00_Inbox/__探针任务卡.md」（6 条任务），cleanup 收走 —— 判据不再依赖库内容。
       */
      {
        const oldFix = app.vault.getAbstractFileByPath(fixPath);
        if (oldFix) await app.vault.delete(oldFix, true);
        await app.vault.create(fixPath, ['---', '类型: 笔记', 'tags: []', '---', '', '# __探针任务卡', '',
          '- [ ] 任务一', '- [ ] 任务二', '- [ ] 任务三',
          '- [ ] 任务四', '- [ ] 任务五', '- [ ] 任务六', ''].join('\\n'));
        await P.wait(1600);
      }
      const bodyEl = P.q('.kbw-board-body');
      const rb = bodyEl.getBoundingClientRect();
      P.rightClickAt(Math.round(rb.left + 14), Math.round(rb.top + 8));
      await P.wait(500);
      await P.clickMore('重载');
      await P.wait(2200);

      const cards = P.qa('[data-drop="a5t"].kbw-cards [data-card]');
      let target = null;
      for (const c of cards) {
        const boxes = c.querySelectorAll('input[type=checkbox]');
        if (boxes.length >= 5) { target = c; break; }
      }
      if (!target) {
        await cleanup();
        return { ok: false, info: '收件箱里没有任务条数 ≥5 的卡片（卡数 ' + cards.length + '）' };
      }
      const name = (target.getAttribute('data-path') || '').split('/').pop();
      const body = target.querySelector('.kbw-card-body');
      bodyEl.scrollTop += Math.round(body.getBoundingClientRect().top - rb.top - 60);
      await P.wait(200);
      const br = body.getBoundingClientRect();
      const box = body.querySelector('input[type=checkbox]');
      const xr = box.getBoundingClientRect();
      const clipped = xr.left < br.left - 0.5;
      const liAll = Array.from(body.querySelectorAll('li'));
      const marked = Array.from(body.querySelectorAll('li.kbw-li-over'));
      /**
       * ⚠️ **折叠态可见条数要真的等于摘要行数**（独立审查：早先 ok 只看"标记了多少 / 展开后多了多少"，
       * 与 is-list-body 解耦 → 判据假绿）。
       */
      const summaryLines = 3;
      const topLevel = Array.from(body.querySelectorAll('ul, ol'))
        .filter((l) => !l.closest('li') || !body.contains(l.closest('li')))
        .flatMap((l) => Array.from(l.children).filter((c) => c.tagName === 'LI'));
      const shownTop = topLevel.filter((li) => !li.classList.contains('kbw-li-over')).length;
      // 展开 → 被标记的那些该回来
      const more = target.querySelector('.kbw-card-more');
      if (more) { P.click(more); await P.wait(400); }
      const opened = body.classList.contains('is-open');
      const stillThere = marked.every((li) => body.contains(li));
      const ok =
        !clipped && xr.width > 6 && marked.length > 0 && shownTop === summaryLines &&
        opened && stillThere;
      await cleanup();
      return {
        ok,
        info: '卡片=' + name + '｜框左=' + Math.round(xr.left) + ' 正文左=' + Math.round(br.left) +
              '（被切=' + clipped + '，应为 false）｜框 ' + Math.round(xr.width) + '×' + Math.round(xr.height) +
              '｜任务总条数=' + liAll.length + '，折叠态被标记=' + marked.length +
              '，顶级显示=' + shownTop + '/' + summaryLines +
              '｜展开后 is-open=' + opened + '（被藏的那些还在 DOM 里=' + stillThere + '）' +
              '｜折叠态顶级可见=' + shownTop,
      };
    })()`,
  },
  {
    name: 'P4.5 第二波 · 卡片标题：横向还能滚，但滚动条不再占高度压着标题',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      P.closeAll(3);
      const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (!nav) return { ok: false, info: '导航里没有「看板」' };
      P.click(nav);
      await P.wait(900);
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      /**
       * 自己造一张**长标题卡**（用完删）。
       * 为什么非造不可：第一版这一步拿现有笔记量，160px 窄卡下 6 个标题**一个都没溢出** ——
       * "没有滚动条"于是毫无信息量（下限判据把它抓成了红，才没让它假绿过去）。
       * 用户截图里那条灰条的条件就是"长标题 + 窄卡"，所以这两个条件都得**造出来**。
       */
      const rel = kb + '/02_Areas/内容创作/__探针超长标题_横向滚动条不该压住这一行_第二波反馈.md';
      const old = await app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(rel, ['---', '类型: 内容作品', '领域: 内容创作', '状态: 进行中',
        '创建日期: 2026-09-25', 'tags: []', '文件位置: []', '---', '标题滚动条用', ''].join('\\n'));
      await P.wait(1600);
      const cleanup = async () => {
        const f = await app.vault.getAbstractFileByPath(rel);
        if (f) await app.vault.delete(f, true);
        await ctx.configs.write('board', backup);
        await P.wait(900);
      };
      // 卡压到**最窄**（拉杆下限 160）——与长标题一起，复现用户看到的那条灰条
      const cur = (await ctx.configs.read('board')) || { version: 1, view: {} };
      await ctx.configs.write('board', {
        ...cur,
        view: { ...(cur.view || {}), cardMode: 'content', cardWidth: 160 },
        sections: [{ id: 'p45t', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作',
                     exclude: [], limit: null, sort: null, cardMode: null, props: null }],
      });
      await P.wait(1800);
      const w = P.q('.kbw-cards') ? P.q('.kbw-cards').style.getPropertyValue('--kbw-card-w') : '';
      const titles = P.qa('.kbw-card-t');
      /**
       * 判据是**几何**：有横向滚动条时 clientHeight 会比 offsetHeight 小（条吃掉那 4px）。
       * 为什么不在 DOM 里找滚动条节点：滚动条不是元素，只能靠这个差量看它占没占位。
       * ⚠️ 下限判据（防空跑）：必须有 ≥1 个标题**真的溢出**（scrollWidth > clientWidth），
       * 否则"没有条"是因为压根不用滚 —— 那是假绿。
       */
      let overflowing = 0;
      let eating = 0;
      let sample = '';
      for (const t of titles) {
        const over = t.scrollWidth > t.clientWidth + 1;
        if (over) overflowing += 1;
        const eats = t.offsetHeight - t.clientHeight;
        if (eats > 1) eating += 1;
        if (!sample && over) {
          sample = '「' + P.text(t).slice(0, 20) + '」' + t.scrollWidth + '>' + t.clientWidth + '，条占 ' + eats + 'px';
        }
      }
      await cleanup();
      return {
        ok: w === '160px' && overflowing >= 1 && eating === 0,
        info: '卡宽 --kbw-card-w=' + (w || '(没拿到)') + '｜标题 ' + titles.length + ' 个：溢出 ' + overflowing +
              ' 个（要 ≥1，否则这条是空跑）｜滚动条占高度的 ' + eating + ' 个（应为 0）' +
              '｜样例：' + (sample || '(没有溢出的标题)'),
      };
    })()`,
  },
  {
    name: 'a.5-2/3 面板头拖得动；小窗开着时源卡片带「编辑中」标记',
    script: `(async () => {
      const P = window.__kbwProbe;
      const gear = P.sectMgr();
      if (!gear) return { ok: false, info: '找不到工具条上的「板块」按钮（按纯文字全等认）' };
      /**
       * 🔴 第二波反馈第 3 项的真机判据：那个图标必须是**真 SVG 节点**（lucide 的齿轮），
       * 且按钮文字里再没有 emoji 字形「⚙」。
       * 为什么这条要落在**节点**上：emoji 的长相由字体决定，用户看到它"时不时变成灰色上色的版本"
       * —— 判"文字里没有 ⚙"只能拦住写法，判"有 svg 子节点"才能拦住"图标又变回字体渲染"。
       */
      const gearSvg = gear.querySelector('svg');
      const gearTxt = P.text(gear);
      const gearIsSvg = !!gearSvg && gearTxt.indexOf('⚙') < 0 && gearTxt.indexOf('板块') >= 0;
      const gearInfo = '文字=「' + gearTxt + '」｜svg=' + !!gearSvg +
        (gearSvg ? '（class=' + (gearSvg.getAttribute('class') || '(无)') + ' data-icon=' + (gearSvg.getAttribute('data-icon') || '(无)') + '）' : '');
      P.click(gear);
      await P.wait(500);
      const panel = P.lastPanel();
      if (!panel) return { ok: false, info: '板块管理面板没开' };
      const head = panel.querySelector('.kbw-panel-head');
      if (!head) return { ok: false, info: '面板没有头' };
      const r0 = panel.getBoundingClientRect();
      const hr = head.getBoundingClientRect();
      const hx = Math.round(hr.left + Math.min(60, hr.width / 3));
      const hy = Math.round(hr.top + hr.height / 2);
      P.pointerDownAt(hx, hy);
      await P.wait(40);
      for (let t = 1; t <= 5; t += 1) {
        P.pointerMoveTo(hx + (90 * t) / 5, hy + (50 * t) / 5);
        await P.wait(26);
      }
      P.pointerUpAt(hx + 90, hy + 50);
      await P.wait(400);
      const r1 = panel.getBoundingClientRect();
      const moved = Math.round(r1.left - r0.left) + ',' + Math.round(r1.top - r0.top);
      const inView = r1.left >= 0 && r1.top >= 0 && r1.right <= window.innerWidth + 1 && r1.bottom <= window.innerHeight + 1;
      P.closeAll(2);
      await P.wait(300);

      // 「编辑中」标记：开一张卡的小窗，看源卡片类名
      const card = P.q('[data-card]');
      const path = card ? card.getAttribute('data-path') : '';
      const title = card ? card.querySelector('.kbw-card-t') : null;
      if (title) P.click(title);
      await P.wait(700);
      const live = P.qa('[data-card]').find((c) => c.getAttribute('data-path') === path);
      const markedOn = !!live && live.classList.contains('is-editing-source');
      P.closeAll(2);
      await P.wait(600);
      const live2 = P.qa('[data-card]').find((c) => c.getAttribute('data-path') === path);
      const markedOff = !!live2 && !live2.classList.contains('is-editing-source');
      return {
        ok: moved === '90,50' && inView && markedOn && markedOff && gearIsSvg,
        info: '面板位移=' + moved + '（应为 90,50）｜还在视口里=' + inView +
              '｜小窗开着时标记=' + markedOn + '｜关窗后标记=' + markedOff +
              '｜工具条齿轮=' + gearInfo + '（是 SVG 且无 emoji=' + gearIsSvg + '）',
      };
    })()`,
  },
  {
    name: 'a.5-5 单击任务行 → 小窗的光标**落在那一行**',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      // ⚠️ 认「看板」为当前模块再开工（同 a.5-4：「--only」单跑时模块不一定在看板）
      const navBoard = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (navBoard && !navBoard.classList.contains('is-on')) { P.click(navBoard); await P.wait(900); }
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      /** 自备夹具（P7.13a 回改，同 a.5-4：不再蹭用户库里的"≥5 条任务卡"） */
      const kb2 = ctx.settings.kbRoot();
      const fixPath = kb2 + '/00_Inbox/__探针任务卡.md';
      const cleanup = async () => {
        const fx = app.vault.getAbstractFileByPath(fixPath);
        if (fx) await app.vault.delete(fx, true);
        await ctx.configs.write('board', backup);
        await P.wait(900);
      };
      await ctx.configs.write('board', {
        version: 1,
        view: { cardMode: 'content', cardHeight: 0, collapsed: [], summaryLines: 6, manualOrder: {} },
        sections: [
          { id: 'a5g', name: '收件箱', kind: 'folder', value: '00_Inbox', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        ],
      });
      await P.wait(1200);
      {
        const oldFix = app.vault.getAbstractFileByPath(fixPath);
        if (oldFix) await app.vault.delete(oldFix, true);
        await app.vault.create(fixPath, ['---', '类型: 笔记', 'tags: []', '---', '', '# __探针任务卡', '',
          '- [ ] 任务一', '- [ ] 任务二', '- [ ] 任务三',
          '- [ ] 任务四', '- [ ] 任务五', '- [ ] 任务六', ''].join('\\n'));
        await P.wait(1600);
      }
      const bodyEl = P.q('.kbw-board-body');
      const rb = bodyEl.getBoundingClientRect();
      P.rightClickAt(Math.round(rb.left + 14), Math.round(rb.top + 8));
      await P.wait(500);
      await P.clickMore('重载');
      await P.wait(2200);

      const cards = P.qa('[data-drop="a5g"].kbw-cards [data-card]');
      let target = null;
      for (const c of cards) {
        if (c.querySelectorAll('input[type=checkbox]').length >= 5) { target = c; break; }
      }
      if (!target) { await cleanup(); return { ok: false, info: '没有任务条数 ≥5 的卡片' }; }
      const path = target.getAttribute('data-path') || '';
      // 源文里第 3 条任务的行号（页面侧自己数，与实现同一口径：行首 - [ ]）
      const full = await app.vault.read(app.vault.getAbstractFileByPath(path));
      const lines = full.split('\\n');
      let seen = 0;
      let want = -1;
      const idx = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (/^\\s*[-*+]\\s+\\[[ xX]\\]/.test(lines[i])) { idx.push(i); seen += 1; }
      }
      if (idx.length < 3) { await cleanup(); return { ok: false, info: '源文里任务不足 3 条（' + idx.length + '）' }; }
      want = idx[2];
      const body = target.querySelector('.kbw-card-body');
      bodyEl.scrollTop += Math.round(body.getBoundingClientRect().top - rb.top - 60);
      await P.wait(250);
      const lis = Array.from(body.querySelectorAll('li')).filter((li) => li.querySelector('input[type=checkbox]'));
      if (lis.length < 3) { await cleanup(); return { ok: false, info: '卡面任务行不足 3 条（' + lis.length + '）' }; }
      const li = lis[2];
      /**
       * ⚠️ 直接派发到**那一行**，不用坐标：坐标点要处理滚动/换行/嵌套的偏移，
       * 而这一步验的是"行映射对不对"（命中测试另有步骤管）。
       * 期望行号**按那一行的文字**从源文里取（不按"第 n 条"数）：文字是唯一的，
       * 数第 n 条则要跟实现的计数口径分毫不差 —— 那种断言红了也说不清是实现的错还是断言写错。
       */
      const liText = (li.textContent || '').trim().split(String.fromCharCode(10))[0].trim();
      const wantByText = lines.findIndex((l) => l.indexOf(liText) >= 0 && /^\\s*[-*+]\\s+\\[[ xX]\\]/.test(l));
      if (wantByText < 0) {
        const hits = lines.filter((l) => l.indexOf(liText) >= 0);
        await cleanup();
        return {
          ok: false,
          info: '源文里找不到这一行的文字：' + liText + '｜含它的行数=' + hits.length +
                '｜正则自测=' + /^\s*[-*+]\s+\[[ xX]\]/.test('    - [x] 刷活动') +
                '｜样例=' + JSON.stringify(hits.slice(0, 2)),
        };
      }
      const domList = Array.from(body.querySelectorAll('li')).filter((x) => x.querySelector('input[type="checkbox"]'));
      const domDump = domList.map((x, i) => i + ':' + (x.textContent || '').trim().split(String.fromCharCode(10))[0].slice(0, 6));
      const lr = li.getBoundingClientRect();
      const under = P.elAt(Math.round(lr.left + 20), Math.round(lr.top + lr.height / 2));
      P.click(li);
      /**
       * ⚠️ **轮询等它落定**（独立审查 🟡9）：实现那边是"文档进编辑器就落点、最多 ~4.5s"，
       * 固定等 900ms 是踩运气 —— 慢一点就读到 '(没写)' 而假红。
       */
      let gotoAttr = '(没写)';
      for (let i = 0; i < 30; i += 1) {
        await P.wait(200);
        // ⚠️ d 期起这两个诊断数据写在**页**上（每个 tab 各有各的落点行，写面板上会互相覆盖）
        const pg = P.q('.kbw-cw-page');
        const v = pg ? pg.dataset.cursorLine || '' : '';
        if (v !== '') { gotoAttr = v; break; }
      }
      const _unused = (() => {
        const pg = P.q('.kbw-cw-page');
        return pg ? (pg.dataset.gotoLine || '(没写)') : '(窗没了)';
      })();
      void _unused;
      /**
       * ⚠️ **不去 workspace 里找那片叶**：小窗的叶是 new WorkspaceLeaf(app) 造的，
       * **不注册进工作区**（真机实测：getLeavesOfType 里根本没有它，
       * 拿到的是别的笔记视图 —— 早先就是这么读到"另一个编辑器"的光标 16 的）。
       * 改判据：直接从**小窗自己的 DOM** 读（CodeMirror 只渲染可见行 + 光标元素）——
       * ① 那一行的文字在可见区里（编辑器真的滚过去了）
       * ② 光标元素（.cm-cursor，渲染出来时）与那一行**同高**（±2px）
       * 两条都不依赖插件自报的行号。
       */
      const host = P.q('.kbw-cw-leaf');
      const visibleLines = host ? Array.from(host.querySelectorAll('.cm-line')) : [];
      const rowEl = visibleLines.find((l) => (l.textContent || '').indexOf(liText) >= 0) || null;
      const hostTop = host ? Math.round(host.getBoundingClientRect().top) : -1;
      const rowTop = rowEl ? Math.round(rowEl.getBoundingClientRect().top) : -1;
      const cursorEl = host ? host.querySelector('.cm-cursor') : null;
      const cursorTop = cursorEl ? Math.round(cursorEl.getBoundingClientRect().top) : -1;
      const scrolledThere = !!rowEl && rowTop >= hostTop - 2 && rowTop <= hostTop + 240;
      const cursorOnRow = !cursorEl || Math.abs(cursorTop - rowTop) <= 2;
      /** 小窗自己报的"编辑器停在哪一行"（.cm-cursor 只在聚焦时渲染，不能当唯一判据） */
      const panelEl = P.q('.kbw-cw-page');
      const cursorAttr = panelEl ? (panelEl.dataset.cursorLine || '(没写)') : '(窗没了)';
      const seenLines = visibleLines.map((l) => (l.textContent || '').trim().slice(0, 6)).slice(0, 6);
      P.closeAll(2);
      await P.wait(500);
      await cleanup();
      return {
        ok: cursorAttr === String(wantByText),
        info: '点的那一行=「' + liText + '」（源文第 ' + (wantByText + 1) + ' 行）｜文件=' + path.split('/').pop() +
              '｜那一行在窗内可见=' + scrolledThere + '（行 top=' + rowTop + '，窗 top=' + hostTop + '）' +
              '｜光标与那一行同高=' + cursorOnRow + '（光标 top=' + cursorTop +
              '，' + (cursorEl ? '有光标元素' : '没有光标元素，跳过这一条') + '）' +
              '｜编辑器停在哪一行（窗自报）=' + cursorAttr + '（期望 ' + wantByText + '）' +
              '｜那一行是否在窗框内（附加证据）=' + scrolledThere + '｜窗内可见头几行=' + JSON.stringify(seenLines) +
              '｜小窗收到的行号=' + gotoAttr + '｜DOM 任务序=' + JSON.stringify(domDump) +
              '｜点在=' + domList.indexOf(li) +
              '｜该坐标下是=' + (under ? ((under.className || under.tagName) + '') : '(null)'),
      };
    })()`,
  },
  {
    name: 'a 期遗留①：「只排序（不动库）」菜单项 —— 只写顺序表、文件一个字节没动',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const rel = kb + '/02_Areas/内容创作/__探针只排序A5.md';
      const old = await app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(rel, ['---', '类型: 内容作品', '领域: 内容创作', '状态: 进行中', '创建日期: 2026-09-25', 'tags: []', '文件位置: []', '---', '只排序用', ''].join('\\n'));
      await P.wait(1600);
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      const cleanup = async () => {
        const f = await app.vault.getAbstractFileByPath(rel);
        if (f) await app.vault.delete(f, true);
        const f2 = await app.vault.getAbstractFileByPath(kb + '/02_Areas/每日任务/__探针只排序A5.md');
        if (f2) await app.vault.delete(f2, true);
        await ctx.configs.write('board', backup);
        await P.wait(900);
      };
      await ctx.configs.write('board', {
        version: 1,
        view: { cardMode: 'content', cardHeight: 90, collapsed: [], manualOrder: {} },
        sections: [
          { id: 'a5s-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
          { id: 'a5s-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        ],
      });
      await P.wait(1200);
      const bodyEl = P.q('.kbw-board-body');
      const rb = bodyEl.getBoundingClientRect();
      P.rightClickAt(Math.round(rb.left + 14), Math.round(rb.top + 8));
      await P.wait(500);
      await P.clickMore('重载');
      await P.wait(2200);

      const card = P.qa('[data-card]').find((c) => (c.getAttribute('data-path') || '').indexOf('__探针只排序A5') >= 0);
      if (!card) { await cleanup(); return { ok: false, info: '源卡片没出来' }; }
      const cr = card.getBoundingClientRect();
      P.rightClickAt(Math.round(cr.left + 30), Math.round(cr.top + 20));
      await P.wait(500);
      P.clickAny('在这一块里');
      await P.wait(400);
      P.clickAny('只排序（不动库）');
      await P.wait(400);
      const picked = P.clickAny('每日任务');
      await P.wait(1500);
      const saved = (await ctx.configs.read('board')) || {};
      const order = (saved.view && saved.view.manualOrder && saved.view.manualOrder['a5s-b']) || [];
      const stillThere = !!(await app.vault.getAbstractFileByPath(rel));
      const movedAway = !!(await app.vault.getAbstractFileByPath(kb + '/02_Areas/每日任务/__探针只排序A5.md'));
      await cleanup();
      return {
        ok: picked && order.some((p) => p.indexOf('__探针只排序A5') >= 0) && stillThere && !movedAway,
        info: '选了目标=' + picked + '｜顺序表里有了=' + order.some((p) => p.indexOf('__探针只排序A5') >= 0) +
              '（' + JSON.stringify(order.map((p) => p.split('/').pop())) + '）｜文件还在原目录=' + stillThere +
              '｜被搬走了=' + movedAway + '（应为 false）',
      };
    })()`,
  },
  {
    name: 'P4.5 · 收起/展开 = **就地切 class**（不重绘卡片：量正文节点的同一性）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const tool = (label) => P.qa('.kbw-board-toolbar .kbw-btn').find((b) => P.text(b).includes(label));
      const cards = () => P.qa('[data-card]');
      if (!P.q('.kbw-board-body') || cards().length === 0) {
        return { ok: false, info: '看板没开着或没有卡片（这一步要有看板）' };
      }
      /**
       * 判据：**抓住卡片正文里的那个节点本身**，收起再展开之后必须还是它。
       * 整块重绘会把 DOM 全清重建 —— 节点的同一性就断了（文字、类名看起来一模一样，
       * 离线用例量的是 MarkdownRenderer 的调用次数，这里量的是真机的节点身份）。
       */
      const probe = cards().map((c) => {
        const b = c.querySelector('.kbw-card-body');
        return b && b.firstElementChild ? b.firstElementChild : null;
      }).filter(Boolean);
      if (probe.length === 0) return { ok: false, info: '卡片正文里没渲染出节点（先确认正文真的在）' };
      const target = probe[0];
      const t0 = performance.now();
      P.click(tool('全部收起'));
      await P.wait(500);
      const collapsedClass = P.qa('.kbw-sect').every((s) => s.classList.contains('is-collapsed'));
      const keepDom = P.qa('.kbw-cards').length;
      const hiddenNow = target.isConnected;
      P.click(tool('全部展开'));
      await P.wait(500);
      const ms = Math.round(performance.now() - t0);
      const sameNodes = probe.filter((n) => n.isConnected).length;
      return {
        ok: collapsedClass && keepDom > 0 && hiddenNow && sameNodes === probe.length,
        info: '收起后都带 is-collapsed=' + collapsedClass + '｜卡片区仍在 DOM 里=' + keepDom +
              ' 块｜收起+展开共 ' + ms + 'ms｜正文节点还是原来那些=' + sameNodes + '/' + probe.length,
      };
    })()`,
  },
  {
    name: 'P4.5 · 拖动落点：指示线 + 源卡占位 + 「N → M」预告（**松手前**就要看得见）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const rel = kb + '/02_Areas/内容创作/__探针落点P45.md';
      const movedTo = kb + '/02_Areas/每日任务/__探针落点P45.md';
      const old = await app.vault.getAbstractFileByPath(rel);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(rel, ['---', '类型: 内容作品', '领域: 内容创作', '状态: 进行中', '创建日期: 2026-09-25', 'tags: []', '文件位置: []', '---', '落点用', ''].join('\\n'));
      await P.wait(1600);
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      await ctx.configs.write('board', {
        version: 1,
        view: { cardMode: 'content', cardHeight: 90, collapsed: [] },
        sections: [
          { id: 'p45-a', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
          { id: 'p45-b', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        ],
      });
      await P.wait(1200);
      const bodyEl = P.q('.kbw-board-body');
      const rb = bodyEl.getBoundingClientRect();
      P.rightClickAt(Math.round(rb.left + 14), Math.round(rb.top + 8));
      await P.wait(500);
      await P.clickMore('重载');
      await P.wait(2000);

      /** 早退之前也要清场（老账：第一轮把临时笔记留在库里了） */
      const cleanup = async () => {
        for (const cand of [rel, movedTo]) {
          const f = await app.vault.getAbstractFileByPath(cand);
          if (f) await app.vault.delete(f, true);
        }
        await ctx.configs.write('board', backup);
        await P.wait(900);
      };
      const card = P.qa('[data-card]').find((c) => (c.getAttribute('data-path') || '').indexOf('__探针落点P45') >= 0);
      const holderB = P.qa('[data-drop="p45-b"]').pop();
      if (!card || !holderB) {
        await cleanup();
        return { ok: false, info: '源卡片或目标板块没出来（板块头=' + P.qa('.kbw-sect-nm').map((h) => P.text(h)).join('/') + '）' };
      }
      const scrollBody = (el, frac) => {
        if (!bodyEl || !el) return;
        const b = bodyEl.getBoundingClientRect();
        const rr = el.getBoundingClientRect();
        bodyEl.scrollTop += Math.round(rr.top - b.top - b.height * frac);
        document.documentElement.scrollTop = 0;
      };
      scrollBody(card, 0.12);
      await P.wait(300);
      let fromPt = P.rectAt(card);
      let toPt = P.rectAt(holderB);
      if (!fromPt.visible || !toPt.visible) {
        scrollBody(holderB, 0.62);
        await P.wait(320);
        fromPt = P.rectAt(card);
        toPt = P.rectAt(holderB);
      }
      if (!fromPt.visible || !toPt.visible) {
        await cleanup();
        return { ok: false, info: '两个点没能同时在视野里（源 ' + JSON.stringify(fromPt.rect) + '｜目标 ' + JSON.stringify(toPt.rect) + '）' };
      }
      P.pointerDownAt(fromPt.x, fromPt.y);
      await P.wait(40);
      for (let t = 1; t <= 8; t += 1) {
        P.pointerMoveTo(fromPt.x + ((toPt.x - fromPt.x) * t) / 8, fromPt.y + ((toPt.y - fromPt.y) * t) / 8);
        await P.wait(28);
      }
      /** 拖动途中（松手之前）读三样东西 */
      const line = P.q('.kbw-dropline');
      const lineBox = line ? line.getBoundingClientRect() : null;
      const inTarget = line ? !!line.closest('[data-drop="p45-b"]') : false;
      const src = P.q('.kbw-card.is-dragging');
      const srcPath = src ? (src.getAttribute('data-path') || '') : '';
      const preview = P.q('.kbw-sect-preview');
      const previewText = preview ? P.text(preview) : '(没有预告)';
      const holderCards = P.qa('[data-drop="p45-b"] [data-card]').length;
      P.pointerUpAt(toPt.x, toPt.y);
      await P.wait(1400);
      const lineGone = !P.q('.kbw-dropline') && !P.q('.kbw-sect-preview') && !P.q('.kbw-card.is-dragging');
      await cleanup();
      return {
        ok: !!line && inTarget && !!src && srcPath.indexOf('__探针落点P45') >= 0 && !!preview &&
            previewText.replace(/\\s/g, '') === holderCards + '→' + (holderCards + 1) && lineGone,
        info: '指示线=' + (lineBox ? Math.round(lineBox.width) + '×' + Math.round(lineBox.height) + 'px' : '(没有)') +
              '｜在目标板块里=' + inTarget + '｜源卡占位=' + (srcPath ? srcPath.split('/').pop() : '(没有)') +
              '｜预告=「' + previewText + '」（目标现有 ' + holderCards + ' 张）｜松手后三样都收干净=' + lineGone,
      };
    })()`,
  },
  // ── b 期 · 列形态 + 竖条折叠（2026-09-25）────────────────────
  // ⚠️ 这两步都会**改窗口大小**（窄档那步）与库内看板配置 —— 各自收尾时都拨回去。
  {
    name: 'b · 列形态：板块**并排**（列宽 = 卡片宽度、列高撑满、列内可滚）· 收起留 40px 竖条、点它展开',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      P.closeAll(3);
      const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (!nav) return { ok: false, info: '导航里没有「看板」' };
      P.click(nav);
      await P.wait(900);
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      const cleanup = async () => { await ctx.configs.write('board', backup); await P.wait(900); };
      /**
       * 两块 + 固定高度 200：**固定高度是故意的** —— 让列内必然溢出，
       * 否则"列内可滚"这条判据可能在卡片少的时候空跑（那是假绿）。
       */
      await ctx.configs.write('board', {
        version: 1,
        view: { cardMode: 'content', flow: 'columns', cardWidth: 240, cardHeight: 200, collapsed: [], manualOrder: {} },
        sections: [
          { id: 'b1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
          { id: 'b2', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        ],
      });
      await P.wait(1900);
      const sects = P.qa('.kbw-sect');
      if (sects.length < 2) { await cleanup(); return { ok: false, info: '板块不足两块（' + sects.length + '），判不了并排' }; }
      const first = sects[0];
      const last = sects[sects.length - 1];
      const r0 = first.getBoundingClientRect();
      const r1 = last.getBoundingClientRect();
      // ① 并排：最后一块在第一块的**右边**（回流式则是下面 —— 那正是窄档要验的反面）
      const sideBySide = r1.left >= r0.right - 2;
      const sameTop = Math.abs(r1.top - r0.top) <= 2;
      // ② 列宽：比卡片宽一点（列自己的内边距），但不是"半个屏幕"
      const card = first.querySelector('[data-card]');
      const cw = card ? Math.round(card.getBoundingClientRect().width) : 0;
      const colW = Math.round(r0.width);
      const bodyRect = P.q('.kbw-board-body').getBoundingClientRect();
      // ③ 列高撑满可用高度（不是被内容撑开的一小条）
      const fullHeight = r0.height >= bodyRect.height - 48;
      // ④ 列内可滚：卡片区自己滚，而不是整页滚
      const cardsBox = first.querySelector('.kbw-cards');
      const innerScroll = !!cardsBox && cardsBox.scrollHeight > cardsBox.clientHeight + 1;
      /**
       * ⚠️ 这几个数**必须在量的时候抄下来**：cleanup() 一跑，看板整块重绘，
       * 手里这些节点就脱离文档了 —— 之后再去读它们的 scrollHeight 全是 0
       *（第一版就是照旧写法拼 info，打出来一行 "0>0"，与判据说的"可滚=true"自相矛盾）。
       */
      const scrollNow = cardsBox ? cardsBox.scrollHeight + '>' + cardsBox.clientHeight : '(没有卡片区)';
      const cardCount = first.querySelectorAll('[data-card]').length;
      const diag = {
        sectPad: getComputedStyle(first).paddingLeft + '/' + getComputedStyle(first).paddingRight,
        cardsW: cardsBox ? cardsBox.offsetWidth + '/' + cardsBox.clientWidth : '?',
        cardW: card ? card.offsetWidth + '（rect ' + Math.round(cw) + '）' : '?',
        alignSelf: card ? getComputedStyle(card).alignSelf : '?',
      };
      // ⑤ 竖条档：收起第一块
      const caret = first.querySelector('.kbw-sect-caret');
      if (!caret) { await cleanup(); return { ok: false, info: '板块头没有三角（.kbw-sect-caret）' }; }
      P.click(caret);
      await P.wait(800);
      const collapsed = first.classList.contains('is-collapsed');
      const rail = first.querySelector('.kbw-sect-rail');
      const railBox = rail ? rail.getBoundingClientRect() : null;
      const railText = rail ? P.text(rail) : '';
      const nm = rail ? rail.querySelector('.kbw-rail-nm') : null;
      const wm = nm ? getComputedStyle(nm).writingMode : '';
      /**
       * 竖条里名字的几何（f 期第 1 条，用户 2026-09-26 的截图："一个字一行"）。
       * 新口径（**正排 + 最多两行**）：
       *  · writing-mode 必须是 horizontal-tb（旧的是 vertical-rl）；
       *  · 名字块**窄而两行**：高 ≤ 2 行（12.5px × 1.15 × 2 ≈ 29，留到 34），宽 ≥ 两字（≈ 25px）。
       *  · ⚠️ 两边都要判：只判"高 ≤ 2 行"的话，"根本没渲染/量到 0"也会过（假绿的经典形状）。
       */
      const railNmBox = nm ? nm.getBoundingClientRect() : null;
      const railNmH = railNmBox ? Math.round(railNmBox.height) : -1;
      const railNmW = railNmBox ? Math.round(railNmBox.width) : -1;
      /**
       * ⚠️ 两个上界都要卡：
       *  · railNmW <= 34 —— 名字**必须窄到竖条里**（40px 减两边），
       *    少了这条，"一整行被裁掉"也算过（真机第一版就是这样：102px 的单行、只显示前三个字）；
       *  · railNmH >= 20 —— 4 个字**必须折成两行**（一行 14px、两行 29px）；
       *    只有上界的话"根本没折"照样绿。
       */
      const nmTwoLine = wm.indexOf('horizontal') >= 0 && railNmH >= 20 && railNmH <= 34 && railNmW >= 20 && railNmW <= 34;
      const colW2 = Math.round(first.getBoundingClientRect().width);
      const cardsKept = !!first.querySelector('.kbw-cards');
      const cardNodeBefore = cardsBox ? cardsBox.querySelector('.kbw-card-body') : null;
      // 收起态：竖条必须是**可见**的（上面 railBox.width 那条已经在判了 ✓）
      P.click(rail);
      await P.wait(800);
      const expanded = !first.classList.contains('is-collapsed');
      const colW3 = Math.round(first.getBoundingClientRect().width);
      /**
       * 🔴 展开态：竖条必须**藏起来**。
       * 这条判据是拿真机截图换来的（第一版没有它）：竖条那条 display:flex 忘了限定
       * 漏了 .is-collapsed 那半截，于是展开的列里也冒出一个竖条，把板块头的名字挤成"一列一个字" ——
       * 列宽/列高/可滚/收起/展开**全部照样绿**。量得出来的都对了，错的是"多了一个元素"，
       * 所以判据得直接问**这个元素在不在**（display 与 offsetParent 双保险）。
       */
      const railAfter = first.querySelector('.kbw-sect-rail');
      const railHidden = !!railAfter && getComputedStyle(railAfter).display === 'none';
      const headNm = first.querySelector('.kbw-sect-nm');
      const nmH = headNm ? Math.round(headNm.getBoundingClientRect().height) : -1;
      /**
       * ⚠️ **必须写大于 0**：第一版只写了"小于等于 40"，于是"元素根本没渲染/量到 0"也会过 ——
       * 而那正是**假绿**（当时窗口被遮住，Chromium 给所有元素 0 几何）。
       * 一行 14px 的名字高约 20px；被竖条挤成"一列一个字"会是 60px 以上。
       */
      const nmOneLine = nmH > 0 && nmH <= 40;
      // 展开必须还是**原来那些节点**（就地切 class，不是整块重绘）
      const sameNode = !!cardNodeBefore && cardNodeBefore.isConnected;
      await cleanup();
      return {
        ok: sideBySide && sameTop && Math.abs(cw - 240) <= 1 && colW >= cw + 4 && colW <= cw + 48 && fullHeight &&
            innerScroll && cardCount > 0 && collapsed && !!railBox &&
            railBox.width >= 36 && railBox.width <= 48 && nmTwoLine &&
            cardsKept && expanded && colW3 >= colW - 2 && sameNode && railHidden && nmOneLine &&
            colW2 >= 36 && colW2 <= 48,
        info: '并排=' + sideBySide + '（第 1 块 ' + Math.round(r0.left) + '–' + Math.round(r0.right) +
              '，最后一块左 ' + Math.round(r1.left) + '）｜顶边齐=' + sameTop +
              '｜列宽=' + colW + '（卡片 ' + cw + '，' + cardCount + ' 张）｜列高 ' + Math.round(r0.height) +
              '/' + Math.round(bodyRect.height) + '（撑满=' + fullHeight + '）' +
              '｜列内可滚=' + innerScroll + '（' + scrollNow + '）' +
              '｜诊断：sect padding ' + diag.sectPad + '、卡片区 offset/client ' + diag.cardsW +
              '、卡片 offset ' + diag.cardW + '、alignSelf ' + diag.alignSelf + '｜' +
              '｜收起：宽 ' + colW2 + '、竖条 ' + (railBox ? Math.round(railBox.width) + 'px' : '(没有)') +
              '「' + railText + '」writing-mode=' + (wm || '(空)') + '、名字 ' + railNmW + '×' + railNmH + '（≤两行=' + nmTwoLine + '）' +
              '、卡片区还在=' + cardsKept +
              '｜点竖条展开=' + expanded + '（宽 ' + colW3 + '，节点没变=' + sameNode + '）' +
              '｜展开后竖条已藏=' + railHidden + '、板块名还是一行=' + nmOneLine + '（高 ' + nmH + 'px）',
      };
    })()`,
    shot: 'p45-b-列形态与竖条.png',
    /**
     * 截图是在**步骤跑完之后**拍的，所以"拍成什么样"由 before/after 定，不由步骤定：
     * before 先摆一个"三块并排、其中一块收成竖条"的状态 —— 步骤自己的 cleanup 会把配置还原成
     * 这个状态，于是快门按下时正好是它。after 再把**真正的**备份还回去。
     * 备份存在页面里（"window.__kbwBBackup"）：before / 步骤 / after 是三次独立求值，闭包不共享。
     */
    before: async (cdp) => {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        const ctx = P.ctx();
        window.__kbwBBackup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
        await ctx.configs.write('board', {
          version: 1,
          view: { cardMode: 'content', flow: 'columns', cardWidth: 240, cardHeight: 0, collapsed: ['b2'], manualOrder: {} },
          sections: [
            { id: 'b1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
            { id: 'b2', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务', exclude: [], limit: null, sort: null, cardMode: null, props: null },
            { id: 'b3', name: '收件箱', kind: 'folder', value: '00_Inbox', exclude: [], limit: null, sort: null, cardMode: null, props: null },
          ],
        });
        await P.wait(1800);
        return true;
      })()`);
    },
    after: async (cdp) => {
      await cdp.eval(`(async () => {
        const P = window.__kbwProbe;
        const ctx = P.ctx();
        if (window.__kbwBBackup) await ctx.configs.write('board', window.__kbwBBackup);
        delete window.__kbwBBackup;
        await P.wait(1200);
        return true;
      })()`);
    },
  },
  {
    name: 'b · 窄档（<640px）强制回流式 + 触屏（body.is-mobile）：都不许横向溢出',
    /** 视口由 runner 用 CDP 设（不再靠 resizeTo —— 模拟视口下它会失效） */
    viewport: [600, 820],
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      P.closeAll(3);
      const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (!nav) return { ok: false, info: '导航里没有「看板」' };
      P.click(nav);
      await P.wait(900);
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      const restore = async () => {
        document.body.classList.remove('is-mobile');
        await ctx.configs.write('board', backup);
        await P.wait(1000);
      };
      // 配置里**明确要列**：窄档下必须被 CSS 压成流式（配置说了不算）
      await ctx.configs.write('board', {
        version: 1,
        view: { cardMode: 'content', flow: 'columns', cardWidth: 240, cardHeight: 0, collapsed: [], manualOrder: {} },
        sections: [
          { id: 'b1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
          { id: 'b2', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        ],
      });
      await P.wait(1600);
      // 视口由 runner 设好了（步骤上声明的 viewport: [600, 820]），这里直接量
      await P.wait(400);
      const root = P.q('.kbw-root');
      const dw = root ? root.getAttribute('data-w') : '(没有 .kbw-root)';
      const sects = P.qa('.kbw-sect');
      const bodyEl = P.q('.kbw-board-body');
      let stacked = false;
      if (sects.length >= 2) {
        const a = sects[0].getBoundingClientRect();
        const b = sects[sects.length - 1].getBoundingClientRect();
        // 回流式 = 后一块在**下面**（列形态则是在右边）
        stacked = b.top >= a.bottom - 2;
      }
      const noOverflowBody = !!bodyEl && bodyEl.scrollWidth <= bodyEl.clientWidth + 1;
      const noOverflowRoot = !!root && root.scrollWidth <= root.clientWidth + 1;
      // 触屏：伪造 is-mobile（CSS 只看这个类）。量"有没有横向越界"——§2.1 的老规矩
      document.body.classList.add('is-mobile');
      await P.wait(500);
      const noOverflowTouch = !!bodyEl && bodyEl.scrollWidth <= bodyEl.clientWidth + 1;
      const rootTouch = !!root && root.scrollWidth <= root.clientWidth + 1;
      await restore();
      const dwAfter = root ? root.getAttribute('data-w') : '';
      return {
        ok: dw === 'narrow' && stacked && noOverflowBody && noOverflowRoot && noOverflowTouch && rootTouch,
        info: '缩到 600×820 → data-w=' + dw + '｜板块上下堆叠=' + stacked +
              '｜横向溢出：看板主体=' + (noOverflowBody ? '无' : '有') + '、工作台根=' + (noOverflowRoot ? '无' : '有') +
              '｜伪造 is-mobile 之后：主体=' + (noOverflowTouch ? '无' : '有') + '、根=' + (rootTouch ? '无' : '有') +
              '｜视口由 runner 收回（data-w=' + dwAfter + '）',
      };
    })()`,
  },
  {
    name: 'b2 · 第二轮反馈六条：标题不被压扁 · 图标是自己的 · 主体可纵向滚 · 卡片不漏字 · 分隔条生效 · 竖条名字可见',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      P.closeAll(3);
      const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (nav) P.click(nav);
      await P.wait(900);
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      const r2 = (n) => Math.round(n);
      const box = (el) => (el ? [r2(el.getBoundingClientRect().width), r2(el.getBoundingClientRect().height)] : null);
      const SEC = [{ id: 'c1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null }];
      const out = {};

      // ① 标题：卡片压到最矮，标题仍要占一整行（修前会被挤成 0 高）
      await ctx.configs.write('board', { version: 1, view: { cardMode: 'content', flow: 'columns', cardWidth: 240, cardHeight: 120, collapsed: [], manualOrder: {} }, sections: SEC });
      await P.wait(1800);
      const t1 = P.q('.kbw-card .kbw-card-t');
      out.titleH = t1 ? r2(t1.getBoundingClientRect().height) : 0;

      // ② 图标 / ③ 主体纵向可滚 / ④ 卡片是裁剪盒
      const ribbon = Array.from(document.querySelectorAll('.side-dock-ribbon-action')).find((el) => ((el.getAttribute('aria-label') || el.getAttribute('title') || '').includes('经纬')));
      out.iconIsMark = !!(ribbon && ribbon.querySelector('svg.kbw-brand-mark'));
      const bodyEl = P.q('.kbw-board-body');
      out.bodyOverflowY = bodyEl ? getComputedStyle(bodyEl).overflowY : '';
      out.cardOverflow = (() => { const c = P.q(".kbw-card"); if (!c) return ""; const cs = getComputedStyle(c); return cs.overflowX + "/" + cs.overflowY; })();

      // ⑤ 分隔条：拖到 ~25% 处 → 属性块高度要变 + 比例落盘
      await ctx.configs.write('board', { version: 1, view: { cardMode: 'both', flow: 'columns', cardWidth: 320, cardHeight: 300, collapsed: [], manualOrder: {} }, sections: SEC });
      await P.wait(1800);
      const card = P.q('.kbw-card');
      const split = card && card.querySelector('.kbw-card-split');
      const kv = card && card.querySelector('.kbw-card-kv');
      const kv0 = box(kv);
      const card0 = box(card);
      let kv1 = null;
      if (split && kv && card) {
        const cr = card.getBoundingClientRect();
        const x = Math.round(cr.left + cr.width / 2);
        const y0 = Math.round(split.getBoundingClientRect().top + 4);
        const y1 = Math.round(cr.top + cr.height * 0.25);
        P.pointerDownAt(x, y0);
        await P.wait(40);
        for (let i = 1; i <= 6; i += 1) {
          P.pointerMoveTo(x, Math.round(y0 + ((y1 - y0) * i) / 6));
          await P.wait(26);
        }
        P.pointerUpAt(x, y1);
        await P.wait(1600);
        kv1 = box(P.q('.kbw-card-kv'));
      }
      const cfg = await ctx.configs.read('board');
      /**
       * ⚠️ 比例现在是**每条笔记一份**（a.9 起：propsRatioByPath[路径]），全局那份是默认值 ——
       * 判据要读**这一条**那一份（第一版忘了跟，读的是全局字段 → 落盘=null 假红）。
       */
      const byPath = cfg.view.propsRatioByPath || {};
      const splitPath = Object.keys(byPath)[0];
      out.splitRatio = splitPath ? byPath[splitPath] : cfg.view.propsRatio;
      out.splitSavedFor = splitPath || '(没写)';
      out.cardH = card0 ? card0[1] : 0;
      out.kv = { before: kv0, after: kv1 };

      // ⑥ 竖条：**用"同时改别的字段"的写法**收起（那正是抓到 bug 的入口）
      await ctx.configs.write('board', { version: 1, view: { cardMode: 'content', flow: 'columns', cardWidth: 240, cardHeight: 300, collapsed: ['c1'], manualOrder: {} }, sections: SEC });
      await P.wait(1800);
      const sect = P.q('.kbw-sect[data-key="c1"]');
      const rail = sect && sect.querySelector('.kbw-sect-rail');
      const nm = rail && rail.querySelector('.kbw-rail-nm');
      out.rail = {
        hasClass: !!(sect && sect.classList.contains('is-collapsed')),
        railBox: box(rail),
        nameBox: box(nm),
        wm: nm ? getComputedStyle(nm).writingMode : '',
        text: rail ? P.text(rail) : '',
      };

      await ctx.configs.write('board', backup);
      await P.wait(1000);
      return {
        // 标题只钉"**没被压没**"（那个 bug 是 h=0）：
        // ⚠️ 实测两次跑出 26px（孤立跑）与 16px（全量跑到这一步时）—— 都>0、都看得见，
        //    但差在哪还没查清（疑似前面某步留下的状态让行盒更紧）。别把下限写死，
        //    否则会变成"同一份代码两次跑出两个结论"的假红。
        /**
         * ⚠️ 分隔条这条钉**"比例 × 卡片高 ≈ 属性块高"**，不钉"比拖动前高多少"：
         * 全量跑到这一步时"拖动前"的高度会受前面步骤留下的布局影响（实测 59 vs 孤立跑的 110），
         * 而"拖完之后高度 = 比例 × 内容高"这一条**两次都成立**（0.236×284 ≈ 67，实测 68 / 65 ✓）。
         */
        ok: out.titleH > 0 && out.titleH <= 40 && out.iconIsMark && out.bodyOverflowY === 'auto' &&
            out.cardOverflow === 'hidden/hidden' && !!out.splitRatio && out.kv.after &&
            Math.abs(out.kv.after[1] - out.splitRatio * (out.cardH - 16)) < 30 &&
            out.splitRatio > 0.15 && out.splitRatio < 0.4 &&
            /**
             * 竖条名字（f 期第 1 条）：**正排 + 最多两行**。
             * ⚠️ 旧判据是「nameBox[1] > 60」（竖排 4 个字 = 4 行 ≈ 60+），现在反过来了 ——
             * 两行封顶，所以这里改成"高 ≤ 34 且宽 ≥ 20（≈ 两个字）"，两边都判。
             */
            out.rail.hasClass && out.rail.railBox[0] >= 36 && out.rail.railBox[0] <= 48 &&
            out.rail.wm.indexOf('horizontal') >= 0 && out.rail.nameBox[1] >= 20 &&
            out.rail.nameBox[1] <= 34 && out.rail.nameBox[0] >= 20 && out.rail.nameBox[0] <= 34 &&
            out.rail.text.length > 2,
        info: '标题高=' + out.titleH + '｜图标是自己的=' + out.iconIsMark + '｜主体 overflow-y=' + out.bodyOverflowY +
              '｜卡片 overflow=' + out.cardOverflow + '｜分隔条：' + JSON.stringify(out.kv.before) + '→' + JSON.stringify(out.kv.after) +
              '、卡片高=' + out.cardH + '、落盘=' + out.splitRatio + '（' + out.splitSavedFor + '）' + '｜竖条：类=' + out.rail.hasClass + ' ' + JSON.stringify(out.rail.railBox) +
              '、名字 ' + out.rail.nameBox[0] + '×' + out.rail.nameBox[1] + '（' + out.rail.wm + '）「' + out.rail.text + '」',
      };
    })()`,
  },
  {
    name: 'b3 · 拖到别的列再拖回来 ＝ 什么都不动（不搬文件/不写顺序表/滚动不跳）；拖过分隔条之后不开小窗',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      P.closeAll(3);
      const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (!nav) return { ok: false, info: '导航里没有「看板」' };
      P.click(nav);
      await P.wait(900);
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      const SEC = [
        { id: 'z1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作', exclude: [], limit: null, sort: null, cardMode: null, props: null },
        { id: 'z2', name: '每日任务', kind: 'folder', value: '02_Areas/每日任务', exclude: [], limit: null, sort: null, cardMode: null, props: null },
      ];
      const write = async (view) => {
        await ctx.configs.write('board', { version: 1, view, sections: SEC });
        await P.wait(2000);
      };
      await write({ cardMode: 'content', flow: 'columns', cardWidth: 240, cardHeight: 0, collapsed: [], manualOrder: {} });
      const sects = P.qa('.kbw-sect');
      if (sects.length < 2) { await ctx.configs.write('board', backup); return { ok: false, info: '板块不足两块' }; }
      const mid = sects[1].querySelector('[data-card]');
      const left = sects[0].querySelector('[data-card]');
      if (!mid || !left) { await ctx.configs.write('board', backup); return { ok: false, info: '两块里至少一块没卡片' }; }
      const pathBefore = mid.dataset.path;
      const bodyEl = P.q('.kbw-board-body');
      const scroll0 = bodyEl.scrollTop;
      const mr = mid.getBoundingClientRect();
      const lr = left.getBoundingClientRect();
      const from = { x: Math.round(mr.left + 14), y: Math.round(mr.top + 10) };
      const away = { x: Math.round(lr.left + 14), y: Math.round(lr.top + 10) };
      const slide = async (a, b) => {
        for (let t = 1; t <= 6; t += 1) {
          P.pointerMoveTo(Math.round(a.x + ((b.x - a.x) * t) / 6), Math.round(a.y + ((b.y - a.y) * t) / 6));
          await P.wait(30);
        }
        await P.wait(200);
      };
      P.pointerDownAt(from.x, from.y);
      await P.wait(40);
      await slide(from, away);
      await slide(away, from);
      P.pointerUpAt(from.x, from.y);
      await P.wait(1800);
      const cfg1 = await ctx.configs.read('board');
      const name = pathBefore.split('/').pop();
      const stillThere = !!(await app.vault.getAbstractFileByPath(pathBefore));
      const strays = [];
      for (const dir of ['02_Areas/内容创作', '02_Areas/每日任务', '00_Inbox']) {
        const p = ctx.settings.kbRoot() + '/' + dir + '/' + name;
        if (p !== pathBefore && (await app.vault.getAbstractFileByPath(p))) strays.push(p);
      }
      const noWrite = Object.keys(cfg1.view.manualOrder || {}).length === 0;
      const noSort = (cfg1.sections || []).every((s) => s.sort == null);
      const scrollOk = P.q('.kbw-board-body').scrollTop === scroll0;

      // ── 拖过分隔条之后那一发 click 不许开小窗
      await write({ cardMode: 'both', flow: 'columns', cardWidth: 300, cardHeight: 320, collapsed: [], manualOrder: {} });
      const card2 = P.q('.kbw-sect .kbw-card');
      const split = card2 && card2.querySelector('.kbw-card-split');
      let windowOpened = null;
      if (!split) {
        windowOpened = 'no-splitter';
      } else {
        const sb = split.getBoundingClientRect();
        const cr = card2.getBoundingClientRect();
        const sx = Math.round(sb.left + sb.width / 2);
        const sy = Math.round(sb.top + sb.height / 2);
        P.pointerDownAt(sx, sy);
        await P.wait(40);
        for (let t = 1; t <= 5; t += 1) { P.pointerMoveTo(sx, Math.round(sy + t * 6)); await P.wait(28); }
        P.pointerUpAt(sx, sy + 30);
        // ⚠️ 补的那发 click 要**紧跟松手**（真机就是几十毫秒后补的）——
        // 抑制窗口只有 150ms，判据里等 600ms 再补就等于在测"过期之后"（第一版就是这么假红的）
        P.click(card2);
        await P.wait(800);
        const ratioSaved = (await ctx.configs.read('board')).view.propsRatioByPath || {};
        windowOpened = P.q('.kbw-panel') ? 'opened' : 'suppressed';
        await ctx.configs.write('board', backup);
        await P.wait(900);
        return {
          ok: stillThere && strays.length === 0 && noWrite && noSort && scrollOk && windowOpened === 'suppressed',
          info: '拖出去再拖回来：文件还在原处=' + stillThere + '、别处冒出副本=' + (strays.length === 0 ? '无' : strays.join('、')) +
                '｜顺序表没写=' + noWrite + '、板块排序没动=' + noSort + '、滚动没跳=' + scrollOk +
                '（' + scroll0 + '→' + P.q('.kbw-board-body').scrollTop + '）' +
                '｜拖分隔条落盘条数=' + Object.keys(ratioSaved).length + '（应有 1）｜补的那发 click：' + windowOpened + '（应为 suppressed）',
        };
      }
      await ctx.configs.write('board', backup);
      await P.wait(900);
      return {
        ok: stillThere && strays.length === 0 && noWrite && noSort && scrollOk && windowOpened === 'suppressed',
        info: '拖出去再拖回来：文件还在原处=' + stillThere + '、别处副本=' + (strays.length === 0 ? '无' : strays.join('、')) +
              '｜顺序表没写=' + noWrite + '、排序没动=' + noSort + '、滚动没跳=' + scrollOk + '｜分隔条=' + windowOpened,
      };
    })()`,
  },
  {
    /**
     * c 期（§3.5 多选与批量）的真机判据 —— 这一批**离线测不出来**：
     * "elementFromPoint" 之下的框选命中、挂在 "document.body" 上的 fixed 选框的坐标口径、
     * 4px 阈值那一刻的起手帧（残影）、以及「有选择时工具条整条换掉」这件事本身。
     *
     * ⚠️ 本步**不动库**（只点选 / 拖框；不做整组拖动 —— 那会真搬用户的文件，
     * 交给离线那条真链路用例去验，见 tests/specs/board.ts 的「拖整组」）。
     */
    name: 'c 期 · 多选：Ctrl/Shift 点选 · 批量栏顶掉工具条 · 框选（含起手帧）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const q = (sel) => P.q(sel);
      const qa = (sel) => P.qa(sel);
      const text = (el) => (el ? (el.textContent || '').trim() : '');
      const selN = () => qa('.kbw-card.is-selected').length;
      const batch = () => q('.kbw-board-toolbar .kbw-batch-count');
      const tools = () => q('.kbw-board-toolbar .kbw-board-tools');
      const clearBtn = () => q('.kbw-board-toolbar .kbw-batch-tail .kbw-iconbtn');
      const click = (el, init) => el.dispatchEvent(new MouseEvent('click', Object.assign({ bubbles: true, cancelable: true }, init || {})));

      // 收干净上一步可能留下的临时态（回执 / 选择 / 光标各一层 Esc）
      for (let i = 0; i < 4; i++) {
        const root = q('.kbw-root');
        if (root) root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await P.wait(60);
      }
      const preClear = clearBtn();
      if (preClear) { click(preClear); await P.wait(140); }

      const all = qa('.kbw-card');
      if (all.length < 3) {
        return { ok: false, info: '看板里只有 ' + all.length + ' 张卡片（要 ≥ 3）—— 得先有板块才谈得上多选' };
      }

      // ① Ctrl+点两张 → 工具条整条换成批量栏
      click(all[0], { ctrlKey: true }); await P.wait(90);
      click(all[1], { ctrlKey: true }); await P.wait(90);
      const n2 = selN();
      const bar = text(batch());
      const toolsGone = tools() == null;

      // ② Shift 从锚点取一段（锚点是上一步点的 all[1]）
      // ⚠️ 是**替换**不是并集（merge 那一位由 hasMod 决定，只有 Ctrl+Shift 才是并集）——
      // 所以这里该是 [all[1], all[2]] 两张，不是三张（第一版判据写错，红了一次）
      click(all[2], { shiftKey: true }); await P.wait(90);
      const n3 = selN();

      // ③ ✕ 清空 → 工具条回来
      const cb = clearBtn();
      if (cb) click(cb);
      await P.wait(140);
      const n0 = selN();
      const toolsBack = tools() != null;

      // ④ 框选：卡片区空白处按下 → 拖过一片 → 松手
      const host = q('.kbw-board-body');
      const hr = host.getBoundingClientRect();
      const x0 = Math.round(hr.left + 3);
      const y0 = Math.round(hr.top + 3);
      const pe = (type, x, y) => host.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
        buttons: type === 'pointerup' ? 0 : 1, pointerId: 3, pointerType: 'mouse', isPrimary: true,
      }));
      pe('pointerdown', x0, y0); await P.wait(40);
      // 刚跨过 4px 阈值那一刻：选框该**贴着触点**（不是上一次的残影）
      pe('pointermove', x0 + 7, y0 + 7); await P.wait(50);
      const m0 = q('.kbw-marquee');
      const m0w = m0 ? parseInt(m0.style.width || '0', 10) : -1;
      for (let i = 1; i <= 6; i++) { pe('pointermove', x0 + i * 80, y0 + i * 50); await P.wait(30); }
      const m1 = q('.kbw-marquee');
      const m1w = m1 ? parseInt(m1.style.width || '0', 10) : -1;
      pe('pointerup', x0 + 520, y0 + 330); await P.wait(180);
      const nBox = selN();
      const mGone = q('.kbw-marquee') == null;

      // 收尾：清选择，别把状态漏给后面的步骤
      const c2 = clearBtn();
      if (c2) { click(c2); await P.wait(140); }

      const ok = n2 === 2 && bar.indexOf('已选 2 篇') === 0 && toolsGone
        && n3 === 2 && n0 === 0 && toolsBack
        && m0w >= 0 && m0w <= 12 && m1w > 100 && nBox > 0 && mGone;
      return {
        ok,
        info: 'Ctrl 两张→' + n2 + ' 张（栏「' + bar + '」·工具条让位=' + toolsGone + '）｜Shift 取段（**替换**）→' + n3 +
              ' 张（该 2）｜✕→' + n0 + '（工具条回来=' + toolsBack + '）｜框选起手宽 ' + m0w + 'px（要 ≤12，残影会是上一次的宽度）·拖动中 ' + m1w +
              'px（要 >100）·命中 ' + nBox + ' 张（选框收掉=' + mGone + '）',
      };
    })()`,
  },

  // ── d 期 · 多篇分页 + 钉住（2026-09-26）───────────────────────
  /**
   * 这一批**离线测不出来**的：
   *  ① **真 CodeMirror 在"藏了又显"之后还会不会排版** —— 切 tab 走的是
   *     "display:none" ↔ 显示，被藏过的 CM 量到的是 0 几何；"Editor.refresh()" 在真机上
   *     到底管不管用、编辑器还在不在，只有真机能答（离线桩的 editor 是个假对象）。
   *  ② **"pin" 住点外面不关** —— 走的是 "document" 上的 mousedown 监听，
   *     离线那条已经钉过（真派了 mousedown），但真机还要确认"点看板/点别处"确实不关。
   *  ③ **卸载之后有没有孤儿叶** —— 这是本期修的那个真 bug 的正面判据。
   *
   * ⚠️ 本步**不动库**（只开窗/切 tab/关窗，一个字都不写）。
   */
  {
    name: 'd 期 · 多篇分页：开 3 篇 · 切 tab 真编辑器还在 · 关一篇另两篇还在 · 全关不留叶',
    script: `(async () => {
      const P = window.__kbwProbe;
      const q = (s) => P.q(s);
      const qa = (s) => P.qa(s);
      const pages = () => qa('.kbw-cw-page');
      const tabs = () => qa('.kbw-cw-tab');
      const editors = () => qa('.kbw-cw-editor .cm-editor');
      const leavesInDom = () => qa('.kbw-cw-leaf').length;
      /**
       * 平台**看得见**的 markdown 叶数 —— 只当证据，不当判据：
       * new WorkspaceLeaf(app) 造的那些叶**不在**平台的叶树里（本项目实测），
       * 所以这个数在真机上很可能**一直是 0**，里面反映的是"别处开着的真标签"。
       * 判"有没有孤儿叶"只能数 DOM（下面那个 domLeft）。
       */
      const mdLeaves = () => app.workspace.getLeavesOfType('markdown').length;
      const mdBefore = mdLeaves();

      // 收干净上一步可能留下的临时态（浮层/回执/选择层层 Esc）
      P.closeAll(4);
      await P.wait(200);

      const cards = qa('[data-card]');
      if (cards.length < 3) {
        return { ok: false, info: '看板里只有 ' + cards.length + ' 张卡片（要 ≥3）—— 得先有板块才谈得上分页' };
      }

      // ① 连开三篇（**P6b ③ 起 = 一文件一扇窗**，再合并成一扇才有 tab 条）
      for (let i = 0; i < 3; i += 1) {
        const c = qa('[data-card]')[i];
        const t = c && c.querySelector('.kbw-card-t');
        if (t) P.click(t);
        await P.wait(900);
      }
      /**
       * 🔴 **P6b ③ 起「单击 = 一文件一扇窗」** → 三下单击是三扇窗，而这一条要的是
       * **一扇窗里三页**（tab 条 / 切 tab / 关中间一篇那套）。所以先走**真入口**合并：
       * 卡片菜单 →「打开 › 并入别的窗…」→ 选那一扇。
       */
      const mergeViaMenu = async (cardIdx) => {
        const c = qa('[data-card]')[cardIdx];
        const t = c && c.querySelector('.kbw-card-t');
        if (!t) return '(没有卡)';
        /**
         * ⚠️ **右键直接派在这张卡上**（不用坐标）：小窗就开在卡片那一列上，
         * 坐标右键会打到**面板**身上（f 期踩过的坑）→ 菜单根本不出来。
         */
        const r = t.getBoundingClientRect();
        t.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
        }));
        await P.wait(400);
        const a = await P.clickMenu('打开');
        await P.wait(300);
        const b = await P.clickMenu('并入别的窗');
        await P.wait(300);
        const d2 = await P.clickMenu('小窗 #');
        await P.wait(900);
        return a + '/' + b + '/' + d2;
      };
      const mergeLog = [];
      for (let i = 1; i < 3; i += 1) {
        if (P.qa('.kbw-cw-panel').length >= 2) mergeLog.push(await mergeViaMenu(i));
      }
      await P.wait(600);
      const panel = P.lastPanel();
      if (!panel) return { ok: false, info: '开了三篇却没有面板' };
      const p3 = pages().length;
      const t3 = tabs().length;
      const e3 = editors().length;
      const paths3 = pages().map((x) => x.dataset.path).join('｜');
      // 每页各自一个真编辑器（不是共用一份），这是"多篇同时编辑"的硬条件
      const stripShown = (() => {
        const s = q('.kbw-cw-tabs');
        return !!s && getComputedStyle(s).display !== 'none';
      })();

      // ② 切 tab：真编辑器要还在、且量得到宽度（被 display:none 藏过一轮之后还能排版）
      const firstPath = pages()[0] && pages()[0].dataset.path;
      const lastPath = pages()[2] && pages()[2].dataset.path;
      const lastTab = tabs().filter((t) => t.dataset.path === lastPath)[0];
      if (lastTab) P.click(lastTab);
      await P.wait(700);
      const activeNow = pages().filter((x) => x.style.display !== 'none');
      const activePath = activeNow.length > 0 ? activeNow[0].dataset.path : null;
      const cm = activeNow.length > 0 ? activeNow[0].querySelector('.cm-editor') : null;
      const cmW = cm ? Math.round(cm.getBoundingClientRect().width) : 0;
      const cmH = cm ? Math.round(cm.getBoundingClientRect().height) : 0;
      // 内容真的在（不是空壳）
      const cmText = cm ? (cm.textContent || '').trim().length : 0;

      // ③ 关中间那一篇（tab 条上的 ✕）→ 另两篇还在
      const midPath = pages()[1] && pages()[1].dataset.path;
      const midTab = tabs().filter((t) => t.dataset.path === midPath)[0];
      if (midTab) {
        const x = midTab.querySelector('.kbw-cw-tabx');
        if (x) P.click(x);
        await P.wait(900);
      }
      const pathsAfter = pages().map((x) => x.dataset.path);
      const nAfter = pathsAfter.length;
      const midGone = pathsAfter.indexOf(midPath) < 0;
      const othersThere = pathsAfter.indexOf(firstPath) >= 0 && pathsAfter.indexOf(lastPath) >= 0;

      // ④ 钉住：图钉点亮 + 点外面不关
      const pin = q('.kbw-panel-actions .kbw-iconbtn');
      let pinOn = false;
      let stayedPinned = false;
      let hitClass = '';
      if (pin) {
        P.click(pin);
        await P.wait(700);
        pinOn = pin.classList.contains('is-on');
        /**
         * 点一片**面板之外**的地方。⚠️ 必须派**真 mousedown** ——
         * 面板"点外面就关"听的就是它（ui/panel.ts 里 on(document,'mousedown')）；
         * 派 pointerdown 是够不到的（pointer 事件不会自动变成 mouse 事件）。
         * 也顺便回报"那一点到底命中谁"，免得点在面板自己身上还判成"没关"。
         */
        const outside = q('.kbw-board-body') || q('.kbw-board') || document.body;
        const r = outside.getBoundingClientRect();
        const ox = Math.round(r.left + 6);
        const oy = Math.round(Math.max(4, r.top + 6));
        const hit = P.elAt(ox, oy);
        hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ox, clientY: oy, view: window }));
        hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ox, clientY: oy, view: window }));
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: ox, clientY: oy, view: window }));
        await P.wait(500);
        hitClass = (hit.className || hit.tagName || '').toString().slice(0, 60);
        stayedPinned = !!P.lastPanel();
        // 取消钉住（别把状态漏给后面的步骤）
        P.click(pin);
        await P.wait(600);
      }

      // ⑤ 全部关闭 → 面板没了、叶也没了（本期修的那个真 bug 的正面判据）
      /**
       * ⚠️「全部关闭」那个按钮**只在 ≥2 篇时画出来**。
       * 只有一篇时走 **Esc** 兜底 —— ⚠️ **别去点面板头上的按钮**：
       * 浮层的头**没有 ✕**（那是模态才有的），头上那两个是**图钉与齿轮**，
       * 点齿轮只会弹出设置菜单（第一版就是这么写的，等于没关）。
       */
      const all = q('.kbw-cw-tabclose-all');
      if (all) P.click(all);
      await P.wait(900);
      P.closeAll(3);
      await P.wait(600);
      const panelGone = !P.q('.kbw-cw-panel');
      const domLeft = leavesInDom();
      const mdAfter = mdLeaves();

      return {
        ok: p3 === 3 && t3 === 3 && e3 === 3 && stripShown
          && activePath === lastPath && cmW > 100 && cmH > 80 && cmText > 0
          && nAfter === 2 && midGone && othersThere
          && (!pin || (pinOn && stayedPinned))
          && panelGone && domLeft === 0,
        info: '开 3 篇：页 ' + p3 + ' · tab ' + t3 + ' · 真编辑器 ' + e3 + '｜合并=' + mergeLog.join(' | ') + '｜tab 条可见=' + stripShown +
              '｜切到最后那篇：当前=' + String(activePath === lastPath) + ' 编辑器 ' + cmW + '×' + cmH + ' 正文 ' + cmText + ' 字' +
              '｜关中间一篇后剩 ' + nAfter + ' 页（中间那篇走了=' + midGone + '，另两篇都在=' + othersThere + '）' +
              '｜钉住：点亮=' + pinOn + ' 点外面不关=' + stayedPinned + '（点到了 ' + hitClass + '）' +
              '｜全关：面板收掉=' + panelGone + ' 残留编辑器 DOM=' + domLeft +
              '｜平台可见的 markdown 叶 ' + mdBefore + ' → ' + mdAfter + '（只当证据：自造叶不在平台叶树里）',
        };
      })()`,
    shot: 'd-期-多篇分页.png',
  },

  /**
   * d 期 · **窄档 + 触屏回归**（§7 的验收清单：每期都要各跑一遍）。
   *
   * 这一期新加的是 tab 条与图钉 —— 要确认它们**不会把面板/页面撑宽**，
   * 以及**触屏上关得掉某一篇**（触屏没有悬停，✕ 若只在 hover 时出现就等于没有）。
   * 视口由 runner 声明（"viewport: [600, 820]"）——⚠️ 不用 "window.resizeTo"
   * （模拟视口下它失效，这是项目里记过的一条）。
   */
  {
    name: 'd 期 · 窄档 + 触屏：tab 条不撑宽（面板不出视口、页面不横溢）· 触屏上 ✕ 常显',
    viewport: [600, 820],
    script: `(async () => {
      const P = window.__kbwProbe;
      P.closeAll(3);
      await P.wait(300);
      const cs = P.qa('[data-card]');
      if (cs.length < 3) return { ok: false, info: '卡片不够：' + cs.length };
      for (let i = 0; i < 3; i += 1) {
        const c = P.qa('[data-card]')[i];
        const t = c && c.querySelector('.kbw-card-t');
        if (t) P.click(t);
        await P.wait(800);
      }
      /**
       * 🔴 P6b ③ 起"单击 = 一文件一扇窗" → 三下单击是三扇窗，而这一条要量的是**一扇窗里的
       * tab 条**。先走**真入口**合并：卡片菜单 →「打开 › 并入别的窗…」→ 选那一扇。
       */
      for (let i = 1; i < 3; i += 1) {
        if (P.qa('.kbw-cw-panel').length < 2) break;
        const c2 = P.qa('[data-card]')[i];
        const t2 = c2 && c2.querySelector('.kbw-card-t');
        if (!t2) continue;
        const r2 = t2.getBoundingClientRect();
        t2.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round(r2.left + r2.width / 2), clientY: Math.round(r2.top + r2.height / 2),
        }));
        await P.wait(400);
        await P.clickMenu('打开');
        await P.wait(300);
        await P.clickMenu('并入别的窗');
        await P.wait(300);
        await P.clickMenu('小窗 #');
        await P.wait(900);
      }
      const panel = P.q('.kbw-cw-panel');
      if (!panel) return { ok: false, info: '窄档下开不出面板' };
      const strip = P.q('.kbw-cw-tabs');
      const pr = panel.getBoundingClientRect();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      /** 双边判据（量到 0 也要算失败 —— 那是"窗口不可见"那种假绿的形状） */
      const inside = pr.left >= 0 && pr.right <= vw + 1 && pr.top >= 0 && pr.bottom <= vh + 1;
      const stripW = strip ? Math.round(strip.getBoundingClientRect().width) : 0;
      const stripScrolls = strip ? strip.scrollWidth >= strip.clientWidth : false;
      // 页面根节点不许横向溢出（窄档的铁律）
      const rootEl = P.q('.kbw-root');
      const rootOverflow = rootEl ? rootEl.scrollWidth > rootEl.clientWidth + 1 : false;
      const docOverflow = document.documentElement.scrollWidth > vw + 1;
      // 触屏：✕ 必须**常显**（没有悬停可依赖）
      document.body.classList.add('is-mobile');
      await P.wait(200);
      const xs = P.qa('.kbw-cw-tab .kbw-cw-tabx');
      const opacities = xs.map((x) => getComputedStyle(x).opacity);
      const allVisible = opacities.length > 0 && opacities.every((o) => parseFloat(o) > 0.3);
      document.body.classList.remove('is-mobile');
      await P.wait(150);
      // 收尾
      const all = P.q('.kbw-cw-tabclose-all');
      if (all) P.click(all);
      await P.wait(700);
      P.closeAll(3);
      await P.wait(400);
      return {
        ok: inside && !rootOverflow && !docOverflow && allVisible
          && stripW > 0 && stripW <= Math.round(vw),
        info: '视口 ' + vw + '×' + vh + '｜面板 ' + Math.round(pr.width) + '×' + Math.round(pr.height) +
              ' @' + Math.round(pr.left) + ',' + Math.round(pr.top) + '｜整个在视口里=' + inside +
              '｜tab 条宽 ' + stripW + '（可横滚=' + stripScrolls + '）' +
              '｜页面横溢：工作台根=' + rootOverflow + ' 文档=' + docOverflow +
              '｜触屏下 ✕ 的 opacity=' + JSON.stringify(opacities) + '（要都 >0.3，否则触屏关不掉某一篇）',
      };
    })()`,
  },

  /**
   * d2 期 · **停靠**（§3.1 的 dock）。
   *
   * 这一批**离线测不出来**的：
   *  ① **布局真的没横溢** —— 窗口宽度是 1400 上下，扣掉 152 导航与 380 窗格之后
   *     主区还剩 ~870（宽档）；离线那套只有纯算术，".kbw-stage" 这条 flex 链
   *     与"列形态在窄了的主区里会不会把页面撑宽"只有真机能量。
   *  ② **真 CodeMirror 搬进窗格之后还在排版** —— 从 "position:fixed" 变成流式元素，
   *     宽高都变了，"Editor.refresh()" 到底救不救得回来。
   *  ③ **停靠态那几套浮层行为整体失效** —— 点外面 / Esc 都不该关。
   *
   * ⚠️ 本步**不动库**（只开窗/换边/关窗，一个字都不写）。
   * ⚠️ 入口**只有菜单**（d2 拍板：拖到边缘那套留给后面单独一期），所以这里就走菜单
   *    ——顺带把"这条入口真的通"也验了。
   * ⚠️ 收尾**必须把停靠关掉**：停靠态下 "Esc" 不关面板，而 "P.closeAll()" 正是按 Esc 的
   *    —— 留着不停靠会让后面每一步都清不干净（那种"某一步莫名其妙失败"最难查）。
   */
  {
    name: 'd2 · 停靠：菜单停靠到左侧（面板进窗格 · 主区不横溢 · 真编辑器还在）· 换到底部 · 取消停靠回浮层',
    script: `(async () => {
      const P = window.__kbwProbe;
      const q = (s) => P.q(s);
      const qa = (s) => P.qa(s);
      const stage = () => q('.kbw-stage');
      const host = () => q('.kbw-dock');
      const panelEl = () => P.lastPanel();
      /** 停靠形态（none / left / right / bottom）—— 判据看的是**舞台上的属性**，不是我们的假设 */
      const where = () => (stage() ? stage().getAttribute('data-dock') : null);

      /**
       * 走菜单停靠：空白处右键 → 更多显示 → 停靠面板 → 某某。
       * ⚠️ 菜单项是 **div.kbw-menu-item 不是 button**，一律用 clickMenu（clickByText 会静默点空）。
       * ⚠️ 右键**只派 contextmenu**（不派 mousedown），所以浮层那句"点外面就关"不会被误触发。
       */
      const dockViaMenu = async (label) => {
        const blank = q('.kbw-board-body') || q('.kbw-board');
        if (!blank) return { err: '找不到看板空白处' };
        const r = blank.getBoundingClientRect();
        const x = Math.round(Math.max(8, r.left + 12));
        const y = Math.round(Math.max(8, r.top + 12));
        const hit = P.elAt(x, y);
        // 那一点上压着别的东西（菜单/浮层没清干净）→ 直接算失败，别硬点
        if (hit.closest && hit.closest('.kbw-menu, .kbw-panel, .kbw-modal')) {
          return { err: '右键那一点被 ' + String(hit.className).slice(0, 40) + ' 压着' };
        }
        P.rightClickAt(x, y);
        await P.wait(320);
        const a = P.clickMenu('更多显示');
        await P.wait(280);
        const b = P.clickMenu('停靠面板');
        await P.wait(280);
        const c = P.clickMenu(label);
        await P.wait(700);
        return { a, b, c };
      };

      P.closeAll(4);
      await P.wait(300);

      // ① 面板还**没开**的时候就选边 —— 顺带验"这是偏好，下次开还停在那儿"
      const menu1 = await dockViaMenu('停靠到左侧');
      if (menu1.err) return { ok: false, info: '菜单这条路走不通：' + menu1.err };
      if (!menu1.c) return { ok: false, info: '菜单三级没点到底：' + JSON.stringify(menu1) };
      /**
       * ⚠️ 面板没开的时候 data-dock 就是 none —— **这是对的**，不是 bug：
       * 窗格宿主由外壳建、但"要不要占地方"是**面板**在申请（port.request）。
       * 没有面板就没人申请，工作台边上不该空出一条 380px 的走廊。
       * 所以这一句只是个**观察值**（写进 info 供人看），判据放在下面"开了面板之后"。
       */
      const whereIdle = where();

      /**
       * ①.5 **把宽度拨回已知值**（菜单里那三档预设）。
       *
       * 🔴 为什么必须拨：view.dock.size 是**库内配置**，会跨轮次留着 ——
       * 上一轮若拖过分隔条，这一轮开出来就是那个宽度。第一版判据写的是
       * "宽必须在 [200, 420]"，于是**第二轮自己把自己跑红了**（380 → 496）。
       * 判据要相对几何，不能写死一个绝对区间。顺带这也把"预设"那条路（拖动之外的另一条）验了。
       */
      const preset = await dockViaMenu('大小：中（380）');
      await P.wait(400);

      // ② 开两篇 → 面板应当**直接出现在窗格里**（不是先浮一下再搬）
      const cards = qa('[data-card]');
      if (cards.length < 2) return { ok: false, info: '看板里只有 ' + cards.length + ' 张卡片（要 >=2）' };
      for (let i = 0; i < 2; i += 1) {
        const c = qa('[data-card]')[i];
        const t = c && c.querySelector('.kbw-card-t');
        if (t) P.click(t);
        await P.wait(900);
      }
      /**
       * 🔴 **P6b ③ 起"单击 = 一文件一扇窗"** → 两下单击是**两扇窗**，而这一条要的是
       * "一扇窗里两篇、而且它停在窗格里"。所以这里走**真入口**把它们并起来：
       * 卡片菜单 →「打开 › 并入别的窗…」→ 选那一扇（这也是 WCAG 要的非拖动等价物）。
       */
      let mergeOk = '(没走合并)';
      if (P.qa('.kbw-cw-panel').length >= 2) {
        const c2 = qa('[data-card]')[1];
        const t2 = c2 && c2.querySelector('.kbw-card-t');
        if (t2) {
          // ⚠️ 右键**直接派在卡片上**（坐标右键会被小窗挡住 —— f 期那条坑）
          const r2 = t2.getBoundingClientRect();
          t2.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true,
            clientX: Math.round(r2.left + r2.width / 2), clientY: Math.round(r2.top + r2.height / 2),
          }));
          await P.wait(400);
          const m1 = await P.clickMenu('打开');
          await P.wait(300);
          const m2 = await P.clickMenu('并入别的窗');
          await P.wait(300);
          const m3 = await P.clickMenu('小窗 #');
          await P.wait(900);
          mergeOk = '打开=' + m1 + ' 并入=' + m2 + ' 选窗=' + m3 + ' → ' + P.qa('.kbw-cw-panel').length + ' 扇';
        }
      }
      const panel = panelEl();
      if (!panel) return { ok: false, info: '开了两篇却没有面板' };
      const h = host();
      const inHost = !!h && panel.parentElement === h;
      const hostW = h ? Math.round(h.getBoundingClientRect().width) : 0;
      const hostH = h ? Math.round(h.getBoundingClientRect().height) : 0;
      const panelW = Math.round(panel.getBoundingClientRect().width);
      const panelH = Math.round(panel.getBoundingClientRect().height);

      /**
       * ③ 布局：主区还在、页面不横溢（**双边判据** —— 只有上界的比较遇到"量到 0"会假绿）。
       *
       * ⚠️ 宽度关系是「shell = 导航 + 舞台」「舞台 = 窗格 + 主区」，而断点判的是
       * **「根宽 − 窗格宽」**（= 导航 + 主区）。所以这一期真正要守住的不变量是
       * **「导航 + 主区 >= 640」**，不是"主区自己 >= 640"（那样在宽档下会多要求 152px）。
       */
      const root = q('.kbw-root');
      const nav = q('.kbw-nav');
      const main = q('.kbw-main');
      const rootW = root ? root.clientWidth : 0;
      // dockFit 允许的最大窗格宽（ui/dock.ts 的 DOCK_MIN_MAIN_W = 640）
      const maxW = Math.max(0, rootW - 640);
      const navW = nav ? Math.round(nav.getBoundingClientRect().width) : 0;
      const mainW = main ? Math.round(main.getBoundingClientRect().width) : 0;
      const stageW = navW + mainW;
      /** 乘 380 那条预设可能被容器挤小（窗口太窄时），所以判"不大于它、也不小于下限" */
      const wantW = Math.min(380, maxW);
      const rootOverflow = root ? root.scrollWidth > root.clientWidth + 1 : true;
      const docOverflow = document.documentElement.scrollWidth > (window.innerWidth || 0) + 1;

      /**
       * ④ 真编辑器搬进窗格之后还在排版（这一条离线测不出来）。
       *
       * 🔴 **必须取"当前那一页"的编辑器**：多篇分页下每个 tab 各挂一个 CM，
       * 不在前台的那些页是 display:none —— 直接 q('.kbw-cw-editor .cm-editor')
       * 拿到的是**文档里第一个**，很可能就是藏起来的那一页，量出来恒为 0×0
       * （第一次跑就是这么假红的；判据得取对对象）。
       */
      const activePage = () => qa('.kbw-cw-page').filter((x) => x.style.display !== 'none')[0] || null;
      const editorOf = (pg) => (pg ? pg.querySelector('.cm-editor') : null);
      const cm = editorOf(activePage());
      const cmW = cm ? Math.round(cm.getBoundingClientRect().width) : 0;
      const cmH = cm ? Math.round(cm.getBoundingClientRect().height) : 0;
      const cmText = cm ? (cm.textContent || '').trim().length : 0;

      // ⑤ 停靠态：点外面**不关**（真派 mousedown —— 那条监听就在它上面）
      const outside = q('.kbw-board-body') || document.body;
      const or = outside.getBoundingClientRect();
      const ox = Math.round(Math.max(4, or.left + 8));
      const oy = Math.round(Math.max(4, or.top + 8));
      const oHit = P.elAt(ox, oy);
      oHit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ox, clientY: oy, view: window }));
      oHit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ox, clientY: oy, view: window }));
      await P.wait(450);
      const afterOutside = !!panelEl();
      // ⑥ 停靠态：Esc 也**不关**（停靠 ≈ 恒钉住）
      P.key('Escape');
      await P.wait(400);
      const afterEsc = !!panelEl();

      // ⑦ 拖分隔条：窗格跟着变宽，且主区**不横溢**（这个手势离线量不到几何 —— jsdom 的 rect 全是 0）
      const grip = q('.kbw-dock-grip');
      let gripOk = false;
      let hostWDragged = 0;
      let dragOverflow = null;
      if (grip) {
        const from = P.rectAt(grip);
        const to = { x: Math.round(from.x + 120), y: from.y };
        await P.dragMouse(from, to, 8);
        await P.wait(700);
        const h3 = host();
        hostWDragged = h3 ? Math.round(h3.getBoundingClientRect().width) : 0;
        const r2 = q('.kbw-root');
        dragOverflow = r2 ? r2.scrollWidth > r2.clientWidth + 1 : true;
        /**
         * 跟手：应当涨到"拖动前 + 120"上下，但**不许超过 dockFit 的上限** maxW
         * （拖过头会被夹住 —— 那是对的，不是 bug）。所以上界取两者里小的那个。
         */
        gripOk =
          hostWDragged >= hostW + 80 &&
          hostWDragged <= Math.min(hostW + 120, maxW) + 6 &&
          !dragOverflow;
      }

      // ⑧ 换到底部（面板开着的时候换边 —— 这是"就地搬"那条路，不是"下次开才生效"）
      const menu2 = await dockViaMenu('停靠到底部');
      const whereBottom = where();
      const h2 = host();
      const hostH2 = h2 ? Math.round(h2.getBoundingClientRect().height) : 0;
      const inHost2 = !!h2 && !!panelEl() && panelEl().parentElement === h2;
      const cm2 = editorOf(activePage());
      const cm2W = cm2 ? Math.round(cm2.getBoundingClientRect().width) : 0;
      const cm2H = cm2 ? Math.round(cm2.getBoundingClientRect().height) : 0;

      // ⑨ 取消停靠 → 回浮层（并且 Esc 又能关）
      const menu3 = await dockViaMenu('不停靠（回浮层）');
      await P.wait(400);
      const whereNone = where();
      const backToBody = !!panelEl() && panelEl().parentElement === document.body;
      P.key('Escape');
      await P.wait(600);
      const escCloses = !panelEl();
      // 收尾：把可能剩下的收干净，并确认没有孤儿编辑器 DOM
      P.closeAll(4);
      await P.wait(600);
      const domLeft = qa('.kbw-cw-leaf').length;
      const bandLeft = qa('.kbw-cw-tabs').length;

      return {
        ok: preset.c && inHost && hostW > 200 && hostW <= Math.max(248, wantW + 6) && hostH > 200
          && panelW > 200 && panelW <= hostW + 6 && panelH > 200
          && stageW >= 640 && mainW > 300 && !rootOverflow && !docOverflow
          && cmW > 100 && cmH > 80 && cmText > 0
          && afterOutside && afterEsc
          && gripOk
          && menu2.c && whereBottom === 'bottom' && hostH2 > 120 && hostH2 <= 640 && inHost2
          && cm2W > 100 && cm2H > 40
          && menu3.c && whereNone === 'none' && backToBody && escCloses
          && domLeft === 0 && bandLeft === 0,
        info: '菜单停靠（面板没开时选边 → data-dock=' + whereIdle + '，**这是对的**：没面板就不占地方）' +
              '｜合并=' + mergeOk +
              '｜开两篇后：在窗格里=' + inHost + ' 窗格 ' + hostW + '×' + hostH +
              ' 面板 ' + panelW + '×' + panelH + '（预设 380，容器上限 ' + maxW + '）' +
              '｜根宽 ' + rootW + ' = 导航 ' + navW + ' + 窗格 ' + hostW + ' + 主区 ' + mainW +
              '（导航+主区 ' + stageW + '，必须 >= 640）' +
              '｜横溢：工作台根=' + rootOverflow + ' 文档=' + docOverflow +
              '｜真编辑器 ' + cmW + '×' + cmH + ' 正文 ' + cmText + ' 字' +
              '｜停靠态：点外面不关=' + afterOutside + ' Esc 不关=' + afterEsc +
              '｜拖分隔条：宽 ' + hostW + ' → ' + hostWDragged + '（跟手=' + gripOk + ' 横溢=' + dragOverflow + '）' +
              '｜换到底部=' + whereBottom + '（在窗格里=' + inHost2 + ' 窗格高 ' + hostH2 + ' 编辑器 ' + cm2W + '×' + cm2H + '）' +
              '｜取消停靠=' + whereNone + ' 回到 body=' + backToBody + ' Esc 又能关=' + escCloses +
              '｜收尾：残留编辑器 DOM=' + domLeft + ' 残留 tab 条=' + bandLeft,
      };
    })()`,
    shot: 'd2-停靠.png',
  },

  /**
   * ⚠️ **d2 那条 🔴 没有真机步骤 —— 故意的，理由写在这儿**（2026-09-26）。
   *
   * 那条缺陷是：停靠态关掉工作台标签时，"ui/panel.ts" 的 "close()" 被
   * "if (!root.isConnected) return;" 短路 → 每个 tab 的 "save()" + "detach()" 全不跑。
   *
   * 审查者给的取证路子是"停靠 + 敲字 + 关标签 + 重开 + 读文件"。**实测过，它分辨不出来**：
   * 在**故意带着缺陷**的构建上量了一轮 —— 编辑那一刻盘上确实还没变（"编辑时已落盘=false"，
   * 前提成立），可 **"detach()" 之后 158ms** 文件就被写掉了。也就是说
   * **平台自己的编辑器在视图关闭时会把 buffer 存掉**，与我们的 "save()" 无关。
   * 于是"文件变没变"两种实现都成立 → 写出来就是一条**永远不会红的判据**
   *（本项目最烦的"看起来在测、其实测不到"）。孤儿的叶/DOM 在页面里也数不出来
   *（自造叶不在平台叶树里，DOM 随视图一起没了）。
   *
   * 所以这条 🔴 的判据落在**离线**那一层，靠的是"**桩按平台取证对齐**"这个前提：
   * 平台在 "View.close()" 里是**先 "containerEl.detach()" 再 "await this.onClose()"**
   *（asar 逐字节取证 + 复核，写在 "tests/stub" 的 "WorkspaceLeaf.detach" 上），
   * 桩照着改了，于是离线那条 "真链路 🔴 停靠态关掉工作台标签" 真的会红（突变验过）。
   * 桩要是哪天被改宽松，红线里有一条专门盯着它（"桩必须先摘 DOM 再 onClose"）。
   */
  {
    /**
     * e 期（2026-09-26）· §3.3 分屏 + §3.2 预览窗格 Peek + §4.4 视图记忆。
     *
     * ── 为什么这三条**必须**真机验 ────────────────────────────────
     * ① **分屏**：开工时拍的"甲"是"另一半只放笔记、**工作台仍只有一份**"。
     *    而"工作台有几份"这件事**离线桩里根本没有**（桩的 "getLeaf" 一律造一个叶、
     *    "ctx.dock" 也就一个口子）—— 离线只能验到"传下去的参数对不对"。
     *    更要紧的是：分屏一来，工作台那一页就**被挤窄了** —— "data-w" 断点、
     *    已停靠的窗格放不放得下，全是"只有真机的布局链"才有的问题。
     * ② **Peek**：它复用 d2 那个停靠宿主。真机上要看的正是"搬进窗格之后"
     *    那些浮层行为是不是整体失效、"与编辑面板互斥"到底谁让谁、
     *    以及**键盘光标**能不能真的把窗格里的内容换掉（离线桩只有 DOM 语义）。
     * ③ **视图记忆**：滚动位置在真机上会被浏览器**按内容高度钳掉** ——
     *    离线那是"赋值多少读回来多少"（jsdom 没有布局），根本量不出
     *    "回来之后位置到底在不在"。
     *
     * ── 口径（都在 "看板优化方案.md" §6.15）─────────────────────────
     *  · 分屏走菜单（§8.3 的「打开」子菜单第 4 项）；平台语义 'vertical' = 左右并排、新的在右
     *  · Peek 只跟**键盘光标**；与停靠面板**互斥**（同一个宿主，开一个收另一个）
     *  · 视图记忆记滚动位置 + 光标 + 展开态，**不记选中集**
     *
     * ⚠️ 本步**不动库**（只是开关窗格/切模块/滚一滚）—— 唯一写的是**库内看板配置**
     *  里的 "peekEnabled"，收尾**必须拨回 false**（与"每步自己把状态拨回基线"同一条）。
     * ⚠️ 分屏那一片叶**收尾必须 detach**：留着的话后面每一步都在一个被挤窄的工作台上跑
     *  （那种"某步莫名其妙失败"最难查 —— d2 的停靠步也只因为收尾没清干净踩过）。
     */
    name: 'e · 分屏（右侧只放笔记 · 工作台仍只有一份）· Peek 窗格（跟键盘光标 + 与面板互斥）· 视图记忆（切走再回来还在原地）',
    /**
     * ⚠️ **声明视口**（1400×900，别靠窗口大小）：这一步要量"分屏之后还挂不挂得住"
     * 与"窗格放不放得下"，两者都是**纯几何**判据 —— 用 "window.resizeTo" 那套在模拟视口下
     * 已经证明失效（P4.5 那条），声明的视口两种状态下都生效且尺寸可复现。
     */
    viewport: [1400, 900],
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const wbLeaves = () => app.workspace.getLeavesOfType('kb-workbench-view');
      const mdLeaves = () => app.workspace.getLeavesOfType('markdown');
      /**
       * 编辑面板 / 预览窗格**各自的类名**，不许用 P.lastPanel()。
       * 🔴 这是个真踩到的探针坑：Peek 也是 .kbw-panel（它走的是同一个 openFloating），
       * 于是 lastPanel() 返回的可能是 Peek —— 用它判"编辑面板开没开"会把 Peek 自己
       * 认成编辑面板，互斥那两条判据**双向都假绿**（第一轮实测就是这么被误导的）。
       */
      const editPanel = () => P.q('.kbw-cw-panel');
      const peekEl = () => P.q('.kbw-peek');
      const cursorPath = () => {
        const c = P.q('[data-card].is-cursor');
        return c ? c.getAttribute('data-path') || '' : '';
      };
      /** 最近的"分屏祖先"（沿 parent 往上找第一个带 direction 的容器）：direction 就是左右/上下的判据 */
      const splitAncestor = (leaf) => {
        let p = leaf && leaf.parent;
        let guard = 0;
        while (p && guard++ < 8) {
          if (typeof p.direction === 'string') return p;
          p = p.parent;
        }
        return null;
      };
      const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const navTo = (label) => {
        const b = P.qa('.kbw-navitem').find((x) => P.text(x).indexOf(label) >= 0);
        if (!b) return false;
        P.click(b);
        return true;
      };
      /**
       * 发一个键给**工作台根元素**。
       * ⚠️ 不用 P.key()：它派给 document.activeElement（多半是 body 或别的控件），
       * 而工作台的键盘处理器挂在 .kbw-root 上 —— 派给 body 的元素**收不到**
       *（事件不向下传播，与离线那条"键要派给根元素"同源）。
       */
      const sendKey = (k) => {
        const el2 = P.q('.kbw-root');
        if (!el2) return false;
        if (!el2.hasAttribute('tabindex')) el2.setAttribute('tabindex', '-1');
        el2.focus();
        el2.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        return true;
      };
      /**
       * 找一个**没被挡住**的空白点（右键有菜单的地方）。
       * ⚠️ 第一轮实测踩到：编辑面板开着的时候它的位置正是"列顶居中"——
       * 于是"左上角那一小块"被面板压着，右键点到的其实是面板，菜单根本不出来
       *（日志里那句「菜单=没点到」）。所以候选点要**挨个试**，只认真的落到看板空白上的那个。
       */
      const freePoint = () => {
        const blank = P.q('.kbw-board-body') || P.q('.kbw-board');
        if (!blank) return null;
        const r = blank.getBoundingClientRect();
        const cands = [
          [r.left + 14, r.bottom - 14],
          [r.right - 14, r.bottom - 14],
          [r.right - 14, r.top + 14],
          [r.left + 14, r.top + 14],
          [(r.left + r.right) / 2, r.bottom - 12],
        ];
        for (const c of cands) {
          const x = Math.round(Math.max(8, Math.min(window.innerWidth - 8, c[0])));
          const y = Math.round(Math.max(8, Math.min(window.innerHeight - 8, c[1])));
          const hit = P.elAt(x, y);
          if (hit.closest && hit.closest('.kbw-menu, .kbw-panel, .kbw-modal, [data-card], button, input')) continue;
          if (!hit.closest('.kbw-board')) continue;
          return { x, y };
        }
        return null;
      };
      /** 看板空白处的菜单三级：更多显示 → 预览窗格 → 某一项 */
      const peekViaMenu = async (leafLabel) => {
        const pt = freePoint();
        if (!pt) return { err: '找不到没被挡住的看板空白处' };
        P.rightClickAt(pt.x, pt.y);
        await P.wait(340);
        const a = P.clickMenu('更多显示');
        await P.wait(300);
        const b = P.clickMenu('预览窗格');
        await P.wait(300);
        const c = P.clickMenu(leafLabel);
        await P.wait(820);
        return { a, b, c, at: pt.x + ',' + pt.y };
      };
      /** 库内看板配置的 view 段（读盘，不是读内存） */
      const cfgView = async () => {
        const raw = await ctx.configs.read('board');
        return (raw && raw.view) || {};
      };
      /**
       * 把"窗格该归谁"那几个键拨到指定值（**走库内配置**：它是真源，界面跟着它走）。
       * dock 一起写是有意的：那几个用例的差别就在"面板是停靠还是浮层"。
       */
      const setPeekEnabled = async (on, dockWhere) => {
        const raw = (await ctx.configs.read('board')) || { version: 1, view: {}, sections: [] };
        await ctx.configs.write('board', {
          ...raw,
          view: {
            ...(raw.view || {}),
            peekEnabled: on,
            peek: { where: 'right', size: 380 },
            dock: { where: dockWhere === undefined ? null : dockWhere, size: 380 },
          },
        });
        await P.wait(900);
      };
      /**
       * **关掉编辑面板**（走按钮，别只按 Esc）。
       * 🔴 停靠态的面板 **Esc 不关**（d2 拍板："停靠 ≈ 恒钉住"），
       * 而 P.closeAll() 就是连按几次 Esc —— 拿它当"关面板"会让判据变成
       * "面板根本没关，所以预览当然不会回来"（第四轮探针的假红就是这么来的）。
       */
      const closeEditPanel = async () => {
        const all = P.q('.kbw-cw-tabclose-all');
        if (all) {
          P.click(all);
          await P.wait(900);
          return !P.q('.kbw-cw-panel');
        }
        /**
         * ⚠️ 底部那条是 .kbw-panel-foot（浮层**共用**的那一块，ui/panel.ts 建的），
         * 不是 .kbw-cw-panel-foot —— 后者在 DOM 里根本不存在（第一版写错，
         * foot 恒为 null → 悄悄退到"按 Esc" → 停靠态下等于没关）。
         */
        const foot = P.q('.kbw-cw-panel .kbw-panel-foot') || P.q('.kbw-cw-panel');
        const done = foot ? P.btnByText('完成', foot) : null;
        if (done) {
          P.click(done);
          await P.wait(900);
          return !P.q('.kbw-cw-panel');
        }
        P.closeAll(3);
        await P.wait(600);
        return !P.q('.kbw-cw-panel');
      };
      /** 点第一张卡片的标题（= 开编辑面板） */
      const openCardPanel = async () => {
        const c = P.qa('[data-card]')[0];
        const t = c ? c.querySelector('.kbw-card-t') : null;
        const at = P.aimAt(t || c);
        if (at && at.visible) {
          P.click(P.elAt(at.x, at.y));
          await P.wait(1100);
        }
        return !!editPanel();
      };

      const notes = [];
      const bad = [];
      const note = (s) => notes.push(s);

      P.closeAll(4);
      await P.wait(400);
      if (wbLeaves().length !== 1) return { ok: false, info: '前提不成立：工作台有 ' + wbLeaves().length + ' 份' };
      /**
       * 🔴 **先把工作台这一页弄成"真的可见"**（这一步后面全是几何判据）：
       * P6b 收尾实测过一次 —— 工作台被切成**后台标签**时一切几何都是 0，
       * 报出来的是"第一张卡片不在视野里"（谜面像看板坏了）。
       * ⚠️ 必须在取「wbRect0」**之前**救，否则基准是 0 → "分屏之后没被挤窄（0 → 578）"假红。
       */
      if (await P.ensureWorkbench()) note('（开工时工作台在后台标签里，已 re-reveal 再量）');
      if (!navTo('看板')) return { ok: false, info: '导航里找不到「看板」' };
      await P.wait(800);
      // 拨回基线：上一轮可能把 peekEnabled 留成开着（收尾失败时就会）
      await setPeekEnabled(false);
      await closeEditPanel();
      P.closeAll(3);
      await P.wait(300);

      /**
       * ⚠️ 上面那几发「closeAll」**会把工作台踢到后台**（Esc 落到平台层 → 平台把别的标签
       * 切成活动叶 → 工作台 display:none → 几何全 0）。取基准之前再确认一次可见性，
       * 否则「wbRect0」量到 0 → 后面"分屏之后没被挤窄（0 → 578）"整条假红。
       */
      if (await P.ensureWorkbench()) note('（取基准前发现工作台在后台，已 re-reveal）');
      const wbLeaf = wbLeaves()[0];
      const wbRect0 = rectOf(wbLeaf.containerEl);

      // ════════ ① 分屏 ════════
      const mdBefore = new Set(mdLeaves());
      const card = P.qa('[data-card]')[0];
      if (!card) return { ok: false, info: '看板上没有卡片（先把板块配好再跑这一步）' };
      /**
       * 🔴 **量不到几何时再救一次 + 把"为什么"报出来**（同一类坑 f 期记过一次：
       * 多余的 markdown 标签 → 工作台 display:none → 几何全 0）。上面已经救过一回，
       * 这里再兜一次是为了"救也救不回来"的那种（窗口被最小化 / 被别的窗口压住）。
       */
      let pt = P.aimAt(card);
      if (!pt || !pt.visible) {
        if (await P.ensureWorkbench()) {
          const again = P.qa('[data-card]')[0];
          pt = again ? P.aimAt(again) : null;
          if (pt && pt.visible) note('（又救了一次：工作台不在前台）');
        }
      }
      if (!pt || !pt.visible) {
        return { ok: false, info: '第一张卡片不在视野里（' + JSON.stringify(pt) + '）｜诊断：' + P.zeroGeoWhy(card) };
      }
      P.rightClickAt(pt.x, pt.y);
      await P.wait(400);
      const m1 = P.clickMenu('打开');
      await P.wait(320);
      const m2 = P.clickMenu('在右侧分屏打开');
      await P.wait(1200);
      if (!(m1 && m2)) return { ok: false, info: '分屏菜单没点到底（打开=' + m1 + ' 分屏=' + m2 + '）' };

      const opened = mdLeaves().filter((l) => !mdBefore.has(l));
      let splitBad = 0;
      if (opened.length !== 1) {
        bad.push('分屏之后新开的笔记叶数=' + opened.length + '（期望 1）');
        splitBad += 1;
      } else {
        const newLeaf = opened[0];
        const sp = splitAncestor(newLeaf);
        const spWb = splitAncestor(wbLeaf);
        note('分屏子树 direction=' + (sp ? sp.direction : '(没找到)') +
             '｜与工作台同一个分屏容器=' + (sp != null && sp === spWb));
        if (!sp || sp.direction !== 'vertical') {
          bad.push('分屏方向不是 vertical（拿到 ' + (sp ? sp.direction : 'null') + '）—— 左右并排才对');
          splitBad += 1;
        }
        if (sp && sp !== spWb) { bad.push('新笔记与工作台不在同一个分屏容器里（那就不叫分屏了）'); splitBad += 1; }
        const rNote = rectOf(newLeaf.containerEl);
        const rWb = rectOf(wbLeaf.containerEl);
        note('分屏后：工作台 ' + (rWb ? rWb.w : '?') + ' × ' + (rWb ? rWb.h : '?') +
             '｜笔记窗格 ' + (rNote ? rNote.w : '?') + ' × ' + (rNote ? rNote.h : '?') +
             '（分屏前工作台 ' + (wbRect0 ? wbRect0.w : '?') + '）');
        /**
         * 几何判据一律**双边**（坑/探针.md 那条：窗口不可见时 Chromium 给所有元素 0 几何，
         * 只有上界的比较会"空过"）：两边都得有正的宽高，且**横向不重叠**。
         */
        if (!rNote || rNote.w <= 0 || rNote.h <= 0 || !rWb || rWb.w <= 0) {
          bad.push('分屏之后有两片量不到尺寸（窗口不可见？）');
          splitBad += 1;
        } else {
          if (!(rNote.l >= rWb.r - 2)) {
            bad.push('笔记窗格没有在工作台右侧（工作台 right=' + rWb.r + '，笔记 left=' + rNote.l + '）');
            splitBad += 1;
          }
          if (wbRect0 && rWb.w >= wbRect0.w - 4) {
            bad.push('分屏之后工作台没被挤窄（' + wbRect0.w + ' → ' + rWb.w + '）—— 那它多半没真分屏');
            splitBad += 1;
          }
        }
      }

      /**
       * 🔴 **"工作台仍然只有一份"** —— 这是甲的口径，也是这一期能小下去的全部理由。
       * 两问都要：① 分屏没多出第二个工作台标签；② **再调一次"打开工作台"也不会多开**。
       */
      const opAfterSplit = wbLeaves().length;
      await ctx.activate();
      await P.wait(800);
      const opAfterActivate = wbLeaves().length;
      note('工作台份数：分屏后=' + opAfterSplit + '｜再点一次「打开工作台」=' + opAfterActivate);
      if (opAfterSplit !== 1) bad.push('分屏之后工作台变成了 ' + opAfterSplit + ' 份');
      if (opAfterActivate !== 1) bad.push('分屏 + activate 之后工作台变成了 ' + opAfterActivate + ' 份');
      if (wbLeaves()[0] !== wbLeaf) bad.push('activate 之后工作台换了一片叶（不再"聚焦已有"）');

      // 分屏把工作台挤窄了：断点必须跟着走，且**不许横向溢出**
      const wbNow = P.q('.kbw-root');
      const dataW = wbNow ? wbNow.getAttribute('data-w') : null;
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      note('分屏后 data-w=' + dataW + '｜文档横向溢出=' + overflow);
      if (overflow > 2) bad.push('分屏之后文档横向溢出了 ' + overflow + 'px');

      /**
       * ⚠️ **分屏立刻收掉再往下走**：后面两节要在一个**完整宽度**的工作台上验
       *（Peek 那条尤其 —— 主区不够 640 时它"放不下"是**正确行为**，拿它当失败会误判；
       * 第一轮实测就是这么栽的）。
       */
      if (opened.length === 1) {
        try { opened[0].detach(); } catch (e) { /* 忽略 */ }
        await P.wait(900);
      }
      const wbRect1 = rectOf(wbLeaves()[0] ? wbLeaves()[0].containerEl : null);
      const backWide = !!(wbRect1 && wbRect0 && Math.abs(wbRect1.w - wbRect0.w) <= 4);
      note('分屏收尾：工作台宽 ' + (wbRect1 ? wbRect1.w : '?') + '（原 ' + (wbRect0 ? wbRect0.w : '?') + '，回位=' + backWide + '）');
      if (splitBad === 0 && !backWide) bad.push('分屏收起来了但工作台宽度没回到原样');
      if (splitBad > 0 && opened.length === 1) note('（分屏有问题，仍先收掉它再往下）');

      // ════════ ② 预览窗格 Peek ════════
      const peekOn = await peekViaMenu('显示预览窗格（只读）');
      if (peekOn.err) return { ok: false, info: 'Peek 菜单走不通：' + peekOn.err };
      if (!peekOn.c) return { ok: false, info: '「预览窗格」三级没点到底：' + JSON.stringify(peekOn) };
      const pe = peekEl();
      const host = P.q('.kbw-dock');
      const whereNow = () => {
        const st = P.q('.kbw-stage');
        return st ? st.getAttribute('data-dock') : null;
      };
      /** 窗格真的看得见吗（**存在 ≠ 看得见**：让位期间 DOM 留着、宿主被 display:none 藏起来） */
      const peekVisible = () => {
        const e2 = peekEl();
        if (!e2) return false;
        const st = P.q('.kbw-stage');
        if (!st || st.getAttribute('data-dock') === 'none') return false;
        const r = e2.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      if (!pe) {
        bad.push('菜单点了，但窗格里没有 .kbw-peek（配置写进去了吗？放不下？）');
      } else {
        note('Peek：在停靠宿主里=' + (pe.parentElement === host) + '｜data-dock=' + whereNow() +
             '｜窗格宽=' + (host ? host.style.width : '?'));
        if (pe.parentElement !== host) bad.push('Peek 没搬进停靠宿主（浮在那儿了）');
        if (whereNow() !== 'right') bad.push('Peek 开着但舞台不是 data-dock=right（拿到 ' + whereNow() + '）');
        if (!pe.classList.contains('is-docked')) bad.push('Peek 没有切到停靠态（浮层那几套还活着）');
      }

      // 键盘光标 → 内容跟着换（**只跟键盘**，鼠标不让它动）
      const peekPath = () => {
        const m = P.q('.kbw-peek-md');
        return m ? m.getAttribute('data-path') || '' : '';
      };
      /**
       * ⚠️ P7.12 收尾真机修正：原判"data-path 必须非空、且两格不同" —— 但**正文为空的卡**
       * 走上去时 peek 正确地画「（这一篇没有正文）」占位（没有 .kbw-peek-md）→ 被误读成
       * "窗格里还是没有内容"（真机两轮实测：第二跳落在空正文卡上，稳定假红）。
       * 改判**跟没跟光标**：拿「.kbw-card.is-cursor」的 data-path 对照；空正文的卡允许
       * "无 data-path"（占位就是对的），只要求**光标真走了一格**、且渲染出内容时必是光标那篇。
       */
      const curCardPath = () => {
        const c = P.q('.kbw-card.is-cursor');
        return c ? c.getAttribute('data-path') || '' : '';
      };
      const shown = (c, p) => (p ? p.split('/').pop() : c ? '空正文占位(' + c.split('/').pop() + ')' : '(空)');
      sendKey(']');
      await P.wait(800);
      const c1 = curCardPath();
      const p1 = peekPath();
      sendKey(']');
      await P.wait(800);
      const c2 = curCardPath();
      const p2 = peekPath();
      note('Peek 内容：第一格=' + shown(c1, p1) + '｜第二格=' + shown(c2, p2) +
        '（光标 ' + (c1.split('/').pop() || '(空)') + ' → ' + (c2.split('/').pop() || '(空)') + '）');
      if (!c1 || !c2) bad.push('按了方向键，光标没落上卡（.kbw-card.is-cursor 空）');
      else if (c1 === c2) bad.push('走了一格，光标没换（还是 ' + c1 + '）');
      if (p1 && c1 && p1 !== c1) bad.push('第一格预览的不是光标那篇（预览 ' + p1 + ' vs 光标 ' + c1 + '）');
      if (p2 && c2 && p2 !== c2) bad.push('第二格预览的不是光标那篇（预览 ' + p2 + ' vs 光标 ' + c2 + '）');

      // ── ②-1 浮层态的编辑面板**不占窗格** → 点卡片看一篇，预览不该凭空消失 ──
      await setPeekEnabled(true, null); // dock 明确写成 null = 面板只会是浮层
      const panelFloat = await openCardPanel();
      const peekAfterFloat = peekVisible();
      note('点卡片（浮层面板）之后：编辑面板=' + panelFloat + '｜预览还看得见=' + peekAfterFloat +
           '｜data-dock=' + whereNow());
      if (!panelFloat) bad.push('点卡片没打开编辑面板');
      if (!peekAfterFloat) bad.push('浮层态的面板不该挤掉预览（拍板说的是"同一个宿主"的两种占用）');
      if (!(await closeEditPanel())) bad.push('（收尾）浮层态的编辑面板没关掉');
      await P.wait(400);

      // ── ②-2 停靠的编辑面板要窗格 → 预览让位（互斥的另一半）────────────────
      // 先让面板停靠起来（预览此刻开着，配置里 dock 还是 null）
      await setPeekEnabled(true, null);
      const panelDock = await openCardPanel();
      if (!panelDock) bad.push('（前提）面板没开起来，下面没法验');
      await setPeekEnabled(false, 'left'); // 面板停靠到左边（预览先关掉，避免同时要窗格）
      await P.wait(400);
      note('面板停靠后：data-dock=' + whereNow() + '（应是 left）');
      if (whereNow() !== 'left') bad.push('面板没停靠成功（data-dock=' + whereNow() + '）');
      // 再把预览打开 → 面板必须让位
      const peekBack = await peekViaMenu('显示预览窗格（只读）');
      const panelAfter = !!editPanel();
      note('再开预览之后：编辑面板=' + panelAfter + '｜预览看得见=' + peekVisible() +
           '｜data-dock=' + whereNow() + '｜菜单=' + (peekBack.c ? '点到' : '没点到'));
      if (panelAfter) bad.push('预览回来了，停靠的编辑面板却没让位（互斥只有一半）');
      if (!peekVisible()) bad.push('第二次开预览没开起来／看不见');
      if (whereNow() !== 'right') bad.push('窗格没归预览（data-dock=' + whereNow() + '）');

      // ── ②-3 占着窗格的面板走了 → 预览**自己回来**（配置说开着就得在）──────────
      /**
       * 🔴 这条是第二轮探针逼出来的真缺陷：互斥只做"我要用就把别人请走"是**一半** ——
       * 少了这一半，症状是"边上空着一条、界面上什么都没有，而菜单里那一项还勾着"。
       */
      await setPeekEnabled(true, 'left'); // 预览开着 + 面板要停靠
      const panelTake = await openCardPanel(); // 点卡片 → 面板抢走窗格、预览让位（但配置里还开着）
      const peekWhilePanel = peekVisible();
      note('面板抢窗格之后：面板=' + panelTake + '｜预览看得见=' + peekWhilePanel);
      if (!panelTake) bad.push('（前提）面板没开起来');
      if (peekWhilePanel) bad.push('停靠的面板来了，预览却还占着窗格');
      if (!(await closeEditPanel())) bad.push('（前提）停靠着的编辑面板没关掉 —— 下面那一条就无从谈起');
      await P.wait(900);
      const peekReturned = peekVisible();
      note('关掉面板之后：预览看得见=' + peekReturned + '｜data-dock=' + whereNow());
      if (!peekReturned) bad.push('面板走了，预览**没有自己回来**（配置里它开着 —— 用户得点两下才回得来）');

      // ════════ ③ 视图记忆 ════════
      /**
       * 🔴 **主判据放在"列"上**（真机实测逼出来的）：这个库里唯一有滚余量的容器就是
       * 看板的列（看板体 643−643、笔记列表 674−674 都是 0，两列分别是 411 / 91）。
       * 列形态下每列各自滚 —— 视图记忆必须把每一列也记上，只记 .kbw-board-body
       * 的话，在真实的库上"回来还在原地"**一次都不会生效**（第一轮探针就是这么发现的）。
       */
      const cur0 = cursorPath();
      const cols = P.qa('.kbw-cards[data-scroll]');
      const withRoom = cols
        .map((c) => ({ c: c, room: c.scrollHeight - c.clientHeight }))
        .filter((x) => x.room > 20)
        .sort((a, b) => b.room - a.room);
      if (cols.length === 0) {
        bad.push('看板的卡片区没有贴 data-scroll（每一列都该有一份：cards:<板块 key>）');
      } else if (withRoom.length === 0) {
        note('每一列都没有可滚余量（' + cols.map((c) => c.scrollHeight - c.clientHeight).join('/') + '）—— 列这一条这次没验成');
      } else {
        const pick = withRoom[0];
        const key = pick.c.getAttribute('data-scroll');
        const want = Math.min(pick.room, 90);
        pick.c.scrollTop = want;
        const got = pick.c.scrollTop;
        note('视图记忆（列 ' + key + '）：可滚 ' + pick.room + '，设 ' + want + '（读回 ' + got + '）');
        navTo('全部笔记');
        await P.wait(1000);
        navTo('看板');
        await P.wait(2400);
        const same = P.qa('.kbw-cards[data-scroll]').find((c) => c.getAttribute('data-scroll') === key);
        const back = same ? same.scrollTop : -1;
        note('切走再回来 = ' + back + '（那一列还在=' + !!same + '）');
        if (got < 1) bad.push('往列里写 scroll 没生效（读回 ' + got + '）—— 前提就不成立');
        else if (!same) bad.push('切回来之后找不到原来那一列（键没对上：' + key + '）');
        else if (Math.abs(back - got) > 2) bad.push('列的位置没回来（期望 ' + got + '，实际 ' + back + '）');
      }
      // 看板体：**这个库里量不到余量**，如实报出来（别硬写一个值当"验过了"）
      const bdM = P.q('.kbw-board-body');
      note('看板体可滚余量=' + (bdM ? bdM.scrollHeight - bdM.clientHeight : '?'));
      if (cur0) {
        const cur1 = cursorPath();
        note('切回来之后光标：' + (cur1 === cur0 ? '还在原处' : '变了（' + (cur1 ? cur1.split('/').pop() : '没了') + '）'));
        if (cur1 !== cur0) bad.push('切走再回来，看板光标没回到原来那张卡');
      }

      // 全部笔记那一屏（另一个模块、另一套容器）
      navTo('全部笔记');
      await P.wait(900);
      /**
       * 🔴 **自造一个"够长"的目录**：这一条量的是"笔记列表的滚动位置记得住吗"，
       * 而**列表没滚余量时判据恒不成立** —— 上一轮真机实测就是「这一条这次没验成（0）」，
       * 而它在库里成不成立**完全看当时选中哪个目录**（=依赖环境状态，迟早变成假绿/假红）。
       * 36 篇是为了**两种形态都撑得起来**（详细档 31px 行、网格档 123×125 的格）。
       */
      await P.dropGridDir('视图记忆');
      const memDir = await P.seedGridDir('视图记忆', 36);
      const memNode = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === memDir; });
      if (memNode) { P.click(memNode); } else { ctx.goNotes({ dir: memDir }); }
      await P.wait(1200);
      /**
       * 取**带 data-scroll、且真有滚余量**的那个容器 —— 不写死类名（视图档是**落盘**的会话态，
       * 两档的滚动容器不是同一个：详细档滚的是 .kbw-notes-list，网格档在它里面另起一格、
       * 键也不同，见 grid.ts 那条注释）。跟着 data-scroll 契约走。
       */
      const scrollables = P.qa('.kbw-notes [data-scroll]')
        .map(function (c) { return { c: c, key: c.getAttribute('data-scroll'), room: c.scrollHeight - c.clientHeight }; })
        .filter(function (x) { return x.room > 20; })
        .sort(function (a, b) { return b.room - a.room; });
      if (scrollables.length === 0) {
        bad.push('自造的目录没撑出滚余量（' +
          P.qa('.kbw-notes [data-scroll]').map(function (c) { return c.getAttribute('data-scroll') + ':' + (c.scrollHeight - c.clientHeight); }).join(' ') +
          '）—— 这一条没验成（夹具的问题，不是功能）');
      } else {
        const pickL = scrollables[0];
        const wantL = Math.min(pickL.room, 70);
        pickL.c.scrollTop = wantL;
        const gotL = pickL.c.scrollTop;
        navTo('看板');
        await P.wait(900);
        navTo('全部笔记');
        await P.wait(1400);
        const sameL = P.qa('.kbw-notes [data-scroll]').find(function (c) { return c.getAttribute('data-scroll') === pickL.key; });
        const backL = sameL ? sameL.scrollTop : -1;
        note('视图记忆（笔记 ' + pickL.key + '）：可滚 ' + pickL.room + '，设 ' + wantL + '（读回 ' + gotL + '） → 切走再回来 = ' + backL);
        if (gotL < 1) bad.push('往 ' + pickL.key + ' 里写 scroll 没生效（读回 ' + gotL + '）—— 前提就不成立');
        else if (!sameL) bad.push('切回来之后找不到原来那个滚动容器（键 ' + pickL.key + '）');
        else if (Math.abs(backL - gotL) > 2) bad.push('笔记列表的位置没回来（期望 ' + gotL + '，实际 ' + backL + '）');
      }
      /**
       * 清场：自造的目录**当场删掉**（别留给 P5 那三步 —— 它那 36 篇会被重排计划当成
       * "要搬进 02_Areas/灵感杂记"的活，一次性把"搬入 1 篇"的账搅乱）。
       * 目录树的选择也拨回「整个知识库」：selection 是**落盘**的，留着指向一个已经不存在的目录
       * 会让后面那几步看到的列表是空的。
       */
      await P.dropGridDir('视图记忆');
      const rootNode2 = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir === '') || (i.dataset.dir == null); });
      if (rootNode2) { P.click(rootNode2); await P.wait(700); }

      // ════════ 收尾：把状态拨回基线 ════════
      /**
       * ⚠️ 收尾**显式拨回 false**（别只读一下就走）：上面互斥②那一步有可能没点到菜单
       *（比如编辑面板压住了空白处），那时 peekEnabled 会**留在 true** ——
       * 它是**库内文件**，留着就是给下一轮埋雷（下一轮开头又会拨回基线，
       * 于是"到底有没有收干净"永远看不出来）。这里以配置为真源写回去。
       */
      await setPeekEnabled(false);
      const viewAfter = await cfgView();
      const offOk = !peekEl() && viewAfter.peekEnabled !== true;
      note('收尾：Peek 关掉了=' + offOk + '｜配置里 peekEnabled=' + viewAfter.peekEnabled);
      if (!offOk) bad.push('收尾没把 Peek 关掉（配置会留成开着）');
      P.closeAll(4);
      await P.wait(400);
      const leftover = P.q('.kbw-peek') || P.q('.kbw-cw-panel');
      if (leftover) bad.push('收尾之后还留着 ' + String(leftover.className).slice(0, 30));
      if (mdLeaves().length !== mdBefore.size) {
        note('收尾后平台可见 markdown 叶 ' + mdLeaves().length + '（开工前 ' + mdBefore.size + '）');
      }

      return {
        ok: bad.length === 0,
        info: (bad.length ? '✗ ' + bad.join('；') + ' ｜ ' : '') + notes.join(' ｜ '),
      };
    })()`,
    shot: 'e-分屏-Peek-视图记忆.png',
  },
  {
    /**
     * e 期 · **容器放不下时，预览窗格不许"飘成浮层"**（独立审查 🔴1 的真机判据）。
     *
     * 为什么非要单独一步、还非要换个窄视口：上一步声明的是 1400×900，而
     * "dockFit" 要 "容器宽 − 640 ≥ 240" 才生效 ⇒ 工作台窄于 **880px** 才会"放不下" ——
     * 1400 的视口**永远走不到那条分支**。审查者正是抓住这一点：那个 bug
     *（放不下时 Peek 以真浮层的样子出现在 body 左上角）**离线 30 条与上一步探针全绿**，
     * 只会在用户机器上出现。
     *
     * 判据四条，全是**真机几何**：
     *  ① 放不下 ⇒ 舞台 "data-dock=none"；
     *  ② 窗格的根**必须挂在停靠宿主里**（不能挂在 body 上 —— 那就是"飘成浮层"）；
     *  ③ 宿主此刻 "display:none"；
     *  ④ 于是窗格的**几何恰好是 0×0**（看得见就是那个 bug）。
     *
     * ⚠️ "拉宽之后它自己出现在窗格里"那半条**没法在这一步里验**：视口由 runner 在步骤开始时
     * 设好（"viewport:"），步骤脚本里改不了（"window.resizeTo" 在模拟视口下失效，
     * 项目里早有记录）。那半条落在**离线**（"setBox(700)" → "setBox(1400)"，
     * 见 "tests/specs/e.ts" 的「🔴 放不下时…」）。这里只守"放不下那一态"。
     * ⚠️ 收尾把 "peekEnabled" 拨回 false（库内配置是**真源**，留着就是给下一轮埋雷）。
     */
    name: 'e · 窄视口：放不下时预览窗格**不许飘成浮层**（不在 body 上 · 宿主藏着 · 几何恰好 0×0）',
    viewport: [700, 900],
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const navTo = (label) => {
        const b = P.qa('.kbw-navitem').find((x) => P.text(x).indexOf(label) >= 0);
        if (!b) return false;
        P.click(b);
        return true;
      };
      const peek = () => P.q('.kbw-peek');
      const host = () => P.q('.kbw-dock');
      const where = () => {
        const st = P.q('.kbw-stage');
        return st ? st.getAttribute('data-dock') : null;
      };
      const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top) };
      };
      const setPeek = async (on) => {
        const raw = (await ctx.configs.read('board')) || { version: 1, view: {}, sections: [] };
        await ctx.configs.write('board', {
          ...raw,
          view: { ...(raw.view || {}), peekEnabled: on, peek: { where: 'right', size: 380 } },
        });
        await P.wait(900);
      };
      /** 关掉编辑面板：停靠态 Esc 不关（d2 拍板"停靠 ≈ 恒钉住"），要走按钮 */
      const closePanel = async () => {
        const all = P.q('.kbw-cw-tabclose-all');
        if (all) {
          P.click(all);
          await P.wait(800);
          return;
        }
        if (!P.q('.kbw-cw-panel')) return;
        const foot = P.q('.kbw-cw-panel .kbw-panel-foot') || P.q('.kbw-cw-panel');
        const done = foot ? P.btnByText('完成', foot) : null;
        if (done) {
          P.click(done);
          await P.wait(800);
        }
      };

      const notes = [];
      const bad = [];
      const note = (s) => notes.push(s);

      P.closeAll(4);
      await P.wait(300);
      await closePanel();
      if (!navTo('看板')) return { ok: false, info: '导航里找不到「看板」' };
      await P.wait(900);
      await setPeek(false); // 拨回基线
      P.closeAll(3);
      await P.wait(300);

      const rootEl = P.q('.kbw-root');
      const rootW = rootEl ? rootEl.clientWidth : 0;
      await setPeek(true);
      await P.wait(700);

      const pe = peek();
      if (!pe) {
        bad.push('配置写了 peekEnabled 却没有 .kbw-peek');
      } else {
        const h = host();
        const r = rectOf(pe);
        const hostDisp = h ? h.style.display : '?';
        note('根宽=' + rootW + '｜data-dock=' + where() + '｜在停靠宿主里=' + (pe.parentElement === h) +
             '｜宿主 display=' + (hostDisp || '(空=显示)') + '｜窗格几何=' + (r ? r.w + '×' + r.h + '@' + r.l + ',' + r.t : '?'));
        if (rootW >= 880) {
          note('（这个视口其实放得下，这一步没验到"放不下那一态"——看 info 里的根宽）');
        } else if (where() !== 'none') {
          bad.push('容器 ' + rootW + ' 这么窄，窗格本该不生效（data-dock=' + where() + '）');
        }
        if (pe.parentElement !== h) {
          bad.push('**窗格的根没挂在停靠宿主里** —— 它飘成了浮层（审查 🔴1 的那个形状）');
        }
        if (rootW < 880 && hostDisp !== 'none') bad.push('宿主没藏起来（display=' + hostDisp + '）');
        /**
         * 几何判据一律**双边**（坑/探针.md 那条：窗口不可见时 Chromium 给所有元素 0 几何，
         * 只有上界的比较会"空过"）：这里要的就是"**恰好是 0**"，所以两边都写。
         */
        if (rootW < 880 && r && !(r.w === 0 && r.h === 0)) {
          bad.push('窗格在界面上**看得见**（' + r.w + '×' + r.h + '）—— 那就是审查说的"飘在左上角"');
        }
      }

      // 收尾：关掉预览、把配置拨回 false（库内配置是真源）
      await setPeek(false);
      const cfg = (await ctx.configs.read('board')) || { view: {} };
      if (cfg.view && cfg.view.peekEnabled === true) bad.push('收尾没把 peekEnabled 拨回 false');
      if (peek()) bad.push('收尾之后 .kbw-peek 还留着');
      P.closeAll(3);

      return {
        ok: bad.length === 0,
        info: (bad.length ? '✗ ' + bad.join('；') + ' ｜ ' : '') + notes.join(' ｜ '),
      };
    })()`,
    shot: 'e-窄视口-预览不飘.png',
  },
  {
    /**
     * §4.1 快速切换（e2 期）。判据四件：
     *  ① 按 "Mod+Shift+O" **真的开得起来**（键位是本体的快速切换器 + Shift，本体没占）
     *  ② 三类目标都在（笔记 / 板块 / 命令）
     *  ③ 选中一篇笔记 → 跳到「全部笔记」并**只列这一篇**
     *  ④ Esc 收得掉（浮层走 ui/panel.ts 那一套 → Esc 层由它压）
     * ⚠️ 注释里不许出现反引号（这一段是模板字符串）。
     */
    name: 'e2 · §4.1 快速切换：Mod+Shift+O 开 · 三类目标 · 跳笔记 · Esc 关',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const bad = [];
      // 先把工作台亮出来（这一步依赖"当前在工作台里"）
      await ctx.activate();
      await P.wait(900);
      const root = P.q('.kbw-root');
      if (!root) return { ok: false, info: '工作台没打开' };
      /**
       * ⚠️ **焦点要在工作台里，键才走得到**（键位表写的是"工作台内"）。
       * P.key 派在 document.activeElement 上，而 .kbw-root 不是可聚焦元素 ——
       * root.focus() 不生效时焦点可能停在 body 或别处（实测：整轮跑过几遍之后偶发）。
       * 所以：先按真实路径试一次，没开出来就**直接派到根元素上**（并如实记下来）。
       */
      /** 按一次 Mod+Shift+O 并等浮层（两条路：真焦点 / 直接派到根元素） */
      const openSwitch = async () => {
        root.focus?.();
        P.key('o', { ctrlKey: true, shiftKey: true });
        await P.wait(400);
        let m = P.q('.kbw-modal');
        let by = '焦点路径';
        if (!m) {
          root.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          await P.wait(400);
          m = P.q('.kbw-modal');
          by = m ? '直接派到工作台根' : '两条路都没开';
        }
        return { m: m, by: by };
      };
      const first = await openSwitch();
      let modal = first.m;
      const how = first.by;
      if (!modal) return { ok: false, info: '按 Mod+Shift+O 之后没有浮层（键位没绑上？）｜' + how };
      const title = (modal.querySelector('.kbw-modal-title') || {}).textContent || '';
      if (title.indexOf('快速切换') < 0) bad.push('开出来的不是快速切换：' + title);
      const items = P.qa('.kbw-pick-item', modal);
      const kinds = {};
      for (const it of items) kinds[it.getAttribute('data-kind')] = (kinds[it.getAttribute('data-kind')] || 0) + 1;
      for (const k of ['笔记', '板块', '命令']) if (!kinds[k]) bad.push('缺这一类：' + k);
      // 挑一篇真实的笔记：拿索引里 mtime 最大的那篇的标题当查询词
      const notes = ctx.index.notes().slice().sort((a, b) => b.mtime - a.mtime);
      const target = notes[0];
      let jumped = '（没有笔记可跳）';
      if (target) {
        const input = modal.querySelector('.kbw-input');
        input.value = target.basename;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(300);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await P.wait(900);
        const mod = ctx.store.get().activeModule;
        if (mod !== 'notes') bad.push('跳笔记之后停在 ' + mod + '（该是 notes）');
        const rows = P.qa('.kbw-trow');
        jumped = '跳到全部笔记=' + (mod === 'notes') + '｜那一屏的行数=' + rows.length +
                 '（要么只剩这一篇、要么它已在筛选里）';
        if (rows.length === 0) bad.push('跳过去之后列表是空的（一次性的"只列这一篇"没生效）');
      }
      // Esc 收浮层（这条确认浮层走的是 ui/panel.ts 那一套）
      const second = await openSwitch();
      if (!second.m) bad.push('第二次按没开出来（' + second.by + '）');
      else {
        P.key('Escape');
        await P.wait(300);
        if (P.q('.kbw-modal')) bad.push('Esc 没收掉浮层');
      }
      return {
        ok: bad.length === 0,
        info: (bad.length ? '✗ ' + bad.join('；') + ' ｜ ' : '') +
              '三类条数=' + JSON.stringify(kinds) + '｜开法=' + how + '｜' + jumped,
      };
    })()`,
    shot: 'e2-快速切换.png',
  },
  {
    /**
     * §4.3 快速捕获（e2 期）。判据四件：
     *  ① 命令 "kb-workbench:quick-capture" 在平台里**注册成功**（这就是"全局热键"兑现的东西）
     *  ② 跑一次 → 浮层开出、目标下拉里有板块
     *  ③ 丢一条 → **文件真的落盘**（落点与补的属性/标签都对）
     *  ④ **没打开它**（"不离开当前工作"就是这一条）
     * 用完删掉自己造的那篇（标记 __探针）。
     */
    name: 'e2 · §4.3 快速捕获：命令能跑 · 丢一条真的落盘 · **不打开它**',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const bad = [];
      const kb = ctx.settings.kbRoot();
      const name = '__探针捕获-' + Date.now();
      const tag = '__探针标签';
      const cfg0 = await ctx.configs.read('board');
      /**
       * 先摆一个**标签源**板块当落点：这一路才验得到"顺手补标签"那件事
       *（文件夹源目标本来就落一个**空**文件 —— 正文交给 Templater/补全，
       *  而实验库没装 Templater，"文件非空"是个假判据）。
       */
      await ctx.configs.write('board', {
        version: 1,
        view: Object.assign({}, cfg0 && cfg0.view),
        sections: [{ id: 'probe-cap', name: '探针标签源', kind: 'tag', value: tag }],
      });
      const before = app.workspace.getLeavesOfType('markdown').length;
      await ctx.activate();
      await P.wait(1200);
      const ran = app.commands.executeCommandById('kb-workbench:quick-capture');
      if (!ran) bad.push('命令 kb-workbench:quick-capture 执行不了（没注册上？）');
      await P.wait(700);
      const modal = P.q('.kbw-modal');
      if (!modal) return { ok: false, info: '命令跑了但没有浮层（看板没有板块？）' };
      const sel = modal.querySelector('[data-capture="target"]');
      const title = modal.querySelector('[data-capture="title"]');
      if (!sel || !title) return { ok: false, info: '浮层里没有目标下拉 / 标题框' };
      const opts = Array.from(sel.options).map((o) => o.textContent);
      title.value = name;
      // 选那个标签源（摆好的落点）
      const usable = Array.from(sel.options).find((o) => (o.textContent || '').indexOf('探针标签源') >= 0)
        || Array.from(sel.options).find((o) => !o.disabled);
      if (!usable) return { ok: false, info: '目标下拉里一个可用项都没有' };
      sel.value = usable.value;
      const go = Array.from(modal.querySelectorAll('button')).find((b) => (b.textContent || '').indexOf('丢一条') >= 0);
      if (!go) return { ok: false, info: '找不到「丢一条」按钮' };
      P.click(go);
      await P.wait(2600);
      /**
       * 判据是**"它真的进得了那个板块"**：标签源目标必须落在收件箱、且前言里带上那个标签
       *（少了标签它就进不了板块 —— 那才是这一条真正的承诺）。
       */
      const hit = app.vault.getMarkdownFiles().find((x) => x.basename === name);
      let landed = '（没找到）';
      if (!hit) {
        bad.push('点了「丢一条」但全库都找不到 ' + name + '（目标=' + usable.textContent + '）');
      } else {
        landed = hit.path;
        const text = await app.vault.read(hit);
        if (text.indexOf(tag) < 0) bad.push('落下来没有那个标签（它就进不了那个板块）：' + JSON.stringify(text.slice(0, 120)));
      }
      const after = app.workspace.getLeavesOfType('markdown').length;
      if (after > before) bad.push('它**打开了**编辑器（"不离开当前工作"要求不打开）');
      // 清理：删掉自己造的那篇 + 把看板配置拨回原来的样子
      const hit2 = app.vault.getMarkdownFiles().find((x) => x.basename === name);
      if (hit2) await app.vault.delete(hit2, true);
      if (cfg0) await ctx.configs.write('board', cfg0);
      await P.wait(600);
      return {
        ok: bad.length === 0,
        info: (bad.length ? '✗ ' + bad.join('；') + ' ｜ ' : '') +
              '命令能跑=' + ran + '｜目标数=' + opts.length + '（' + opts.slice(0, 3).join(' / ') + '）' +
              '｜落在 ' + landed + '｜markdown 叶 ' + before + ' → ' + after,
      };
    })()`,
    shot: 'e2-快速捕获.png',
  },
  // ── f 期 · 多悬浮窗 + 六条优化（2026-09-26，看板最后一轮）─────────
  /**
   * 这一批**离线只能验到一半**，所以真机这几步是主判据：
   *  · **多窗**：两扇各自一套 DOM/编辑器/退出层 —— 离线能验（f.ts），但"Esc 关的是**最近点的**那扇"
   *    要靠真实的 pointerdown 打点；
   *  · **字号**："--font-text-size" 到底有没有作用到**真 CodeMirror 的字号**上（离线桩里没有 CM）；
   *  · **尾链折叠**：折叠指示器是**平台画的**（".cm-fold-indicator"），离线只能验"找得到它"，
   *    "点它真的折"只有真机能答；
   *  · **标签页图标**：宿主是**平台**的 tab 头，离线是自造的假 DOM。
   * ⚠️ 这几步**不动库**（只开窗 / 改显示档配置，不碰任何笔记文件）。
   */
  {
    name: 'f · 多悬浮窗：两扇并存 · 跨窗去重 · Esc 只关"最近交互的那一扇"',
    script: `(async () => {
      const P = window.__kbwProbe;
      const panels = () => P.qa('.kbw-cw-panel');
      const pagesOf = (p) => Array.from(p.querySelectorAll('.kbw-cw-page'));
      /** 把工作台拉回前台：前一步的 Esc 可能把焦点让给了别的标签（那会让看板量到 0 几何） */
      const wb = app.workspace.getLeavesOfType('kb-workbench-view')[0];
      if (wb && app.workspace.activeLeaf !== wb) app.workspace.setActiveLeaf(wb, { focus: true });
      P.closeAll(4);
      await P.wait(300);
      const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板'));
      if (nav) { P.click(nav); await P.wait(900); }
      const closeOne = async () => {
        const p = panels()[0];
        if (!p) return;
        const all = p.querySelector('.kbw-cw-tabclose-all');
        if (all) P.click(all);
        else {
          const done = P.btnByText('完成', p);
          if (done) P.click(done);
          else P.key('Escape');
        }
        await P.wait(600);
      };
      while (panels().length > 0) await closeOne();

      const cards = P.qa('[data-card]');
      if (cards.length < 2) return { ok: false, info: '看板里只有 ' + cards.length + ' 张卡片（要 ≥2）' };

      // ① 第一扇：单击卡片
      P.click(cards[0].querySelector('.kbw-card-t'));
      await P.wait(1000);
      const one = panels().length;
      /** 第一扇里那一篇 —— 右键目标要**避开它**（同一篇走"新窗"只会跳过去，不会新开） */
      const firstOpened = panels()[0] ? (panels()[0].querySelector('.kbw-cw-page') || {}).dataset?.path ?? '' : '';

      // ② 第二扇：右键第二张卡 → 打开 › 在新悬浮窗中打开（菜单那条真路）
      /**
       * 🔴 要挑一张**没被小窗压住**的卡片：第一扇窗就开在"被点那一列的顶部居中"，
       * 正好盖住那一列的头几张卡 —— 拿 cards[1] 右键，那一发 contextmenu 会落在**窗**上，
       * 菜单根本弹不出来（f 期第一版就是这么假红的：菜单层数=0）。
       * 判据用**真实命中**：那一点必须落在卡片自己（或它的后代）里。
       */
      const freeCards = () =>
        P.qa('[data-card]')
          /** ⚠️ 别挑第一扇里已经开着的那一篇：同一篇走"新窗"只会**跳过去**（跨窗去重），不会新开 */
          .filter((c) => (c.getAttribute('data-path') || '') !== firstOpened)
          .map((c) => {
            const t = c.querySelector('.kbw-card-t') || c;
            const pt = P.rectAt(t);
            if (!pt || !pt.visible) return null;
            const under = P.elAt(pt.x, pt.y);
            if (!under || !(under === c || c.contains(under))) return null;
            return { c, pt };
          })
          .filter(Boolean);
      let targets = freeCards();
      /**
       * 一张都打不到 → **把小窗拖开**（它开在"被点那一列的顶部居中"，正好盖住卡片）。
       * 走的是面板头那条真拖动（ui/panel.ts 的 dragHandle）：pointerdown 在头上、
       * move/up 在 document 上（拖动基元就是这么听的）。
       * ⚠️ 先试「把看板滚一滚」是没用的：实验库这一屏 scrollHeight == clientHeight（没得滚）。
       */
      for (let i = 0; i < 2 && targets.length === 0; i += 1) {
        const head = P.q('.kbw-cw-panel .kbw-panel-head');
        const p0 = head ? head.getBoundingClientRect() : null;
        if (!head || !p0) break;
        const sx = Math.round(p0.left + p0.width / 2);
        const sy = Math.round(p0.top + Math.min(12, p0.height / 2));
        // 往右下拖（夹在视口内），一次不够就再来一次
        const tx = Math.min(window.innerWidth - 40, sx + 420);
        const ty = Math.min(window.innerHeight - 40, sy + 300);
        head.dispatchEvent(P.mkPointer('pointerdown', sx, sy, 'mouse'));
        for (let k = 1; k <= 5; k += 1) {
          const x = Math.round(sx + ((tx - sx) * k) / 5);
          const y = Math.round(sy + ((ty - sy) * k) / 5);
          document.dispatchEvent(P.mkPointer('pointermove', x, y, 'mouse'));
        }
        document.dispatchEvent(P.mkPointer('pointerup', tx, ty, 'mouse'));
        await P.wait(500);
        targets = freeCards();
      }
      if (targets.length === 0) {
        return { ok: false, info: '所有卡片都被小窗或别的浮层压着（右键打不到卡片）' };
      }
      const t2 = targets[0];
      P.rightClickAt(t2.pt.x, t2.pt.y);
      await P.wait(500);
      const opened = P.clickAny('打开');
      await P.wait(320);
      const picked = P.clickAny('在新悬浮窗中打开');
      await P.wait(1100);
      const two = panels().length;
      const wins = panels().map((p) => p.dataset.win);
      const each = panels().map((p) => pagesOf(p).length);
      /** 早退要**说清是哪一步没成**（不然只剩一个 undefined 崩溃，什么也看不出来） */
      if (two < 2) {
        return { ok: false, info: '第二扇没开出来（第一扇=' + one + '，菜单两级=' + opened + '/' + picked + '，菜单层数=' + P.qa('.kbw-menu').length + '）' };
      }

      // ③ Esc → 只关"最近交互的那一扇"（第二扇刚开、刚被点过）
      P.key('Escape');
      await P.wait(700);
      const afterEsc = panels().length;
      const leftWin = panels()[0] ? panels()[0].dataset.win : null;
      if (afterEsc !== 1 || !panels()[0]) {
        return { ok: false, info: 'Esc 之后应当只剩一扇（实际 ' + afterEsc + ' 扇）' };
      }

      /**
       * ③b **点"先建的那一扇"再按 Esc**（f 期独立审查 M2 指出的盲点）：
       * 上面那一下点的偏偏是"最后建的那一扇"，而它与"最近交互"**天然重合**
       *（Esc 栈的默认顺序就是最后建的在上）—— 也就是说「把 raise() 里那次层重排删掉」
       * 这一步照样绿。补一轮"点先建的"才验得到它。
       */
      const back = P.qa('[data-card]').find((c) => (c.getAttribute('data-path') || '') === firstOpened);
      let escFirstOk = false;
      let escFirstInfo = '';
      if (back) {
        P.click(back.querySelector('.kbw-card-t'));
        await P.wait(600); // 它已经在第一扇里 → 跳过去（不新开）
        await P.wait(400);
        const n1 = panels().length;
        // 再开一扇（另一个 path），让"先建的"与"最后建的"分开
        const other = freeCards()[0];
        if (other && n1 === 1) {
          const firstWinId = panels()[0].dataset.win;
          P.rightClickAt(other.pt.x, other.pt.y);
          await P.wait(500);
          P.clickAny('打开');
          await P.wait(320);
          P.clickAny('在新悬浮窗中打开');
          await P.wait(1100);
          const opened2 = panels().length === 2;
          // 点**先建的那一扇**（它现在是"最近交互"），再 Esc
          const target = panels().find((x) => x.dataset.win === firstWinId);
          if (opened2 && target) {
            const r = target.querySelector('.kbw-panel-head').getBoundingClientRect();
            const cx = Math.round(r.left + Math.min(80, r.width / 2));
            const cy = Math.round(r.top + 8);
            target.dispatchEvent(P.mkPointer('pointerdown', cx, cy, 'mouse'));
            target.dispatchEvent(P.mkPointer('pointerup', cx, cy, 'mouse'));
            await P.wait(300);
            P.key('Escape');
            await P.wait(700);
            const gone = !P.qa('.kbw-cw-panel').some((x) => x.dataset.win === firstWinId);
            escFirstOk = gone && panels().length === 1;
            escFirstInfo = '点先建的再 Esc：它' + (gone ? '关掉了' : '**没关**（Esc 关错了扇）') + '、剩 ' + panels().length + ' 扇';
          }
        }
      }

      // ④ 跨窗去重：再点第一张卡（它已经在第一扇里）→ **窗数不许变**
      const firstPath = panels()[0] ? (pagesOf(panels()[0])[0] || {}).dataset?.path ?? '' : '';
      const again = P.qa('[data-card]').find((c) => (c.getAttribute('data-path') || '') === firstPath);
      if (again) { P.click(again.querySelector('.kbw-card-t')); await P.wait(900); }
      const afterDedup = panels().length;

      while (panels().length > 0) await closeOne();
      const closed = panels().length;

      return {
        ok: one === 1 && opened && picked && two === 2 && wins[0] !== wins[1] &&
            each[0] === 1 && each[1] === 1 &&
            afterEsc === 1 && leftWin === wins[0] && escFirstOk &&
            !!again && afterDedup === 1 && closed === 0,
        info: '第一扇=' + one + '｜菜单两级=' + opened + '/' + picked + '｜两扇=' + two +
              '（实例号 ' + wins.join(' / ') + '，各 ' + each.join(' / ') + ' 篇）' +
              '｜Esc 后=' + afterEsc + '（留下的是实例 ' + leftWin + '，应为第一扇）' +
              '｜' + escFirstInfo +
              '｜再点第一篇之后窗数=' + afterDedup + '（跨窗去重：不许变）' +
              '｜收尾=' + closed + ' 扇',
      };
    })()`,
  },
  {
    name: 'f · 面板显示（第 2/4/5 条）：Ctrl+滚轮缩字号 · 拖分隔条改比例 · 尾链**自动折叠**',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const panels = () => P.qa('.kbw-cw-panel');
      const backup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      /**
       * ⚠️ **C2（2026-09-27）起小窗默认只看正文**（属性块不画），而这一步要拖的是
       * "属性块 / 正文"之间那根分隔条 —— 没属性块就没得拖（第一次跑就是这儿红的：
       * 比例 undefined、is-split=false）。
       * 所以先按"用户真的选过"把档位设成「前 6 行」，跑完用 backup 原样写回去。
       * ⚠️ 版本号要写 2：v1 文件里那个 few 会被一次性迁移当成旧默认吃掉（见 migrateLegacyView）。
       */
      await ctx.configs.write('board', {
        ...backup,
        version: 2,
        view: { ...(backup.view || {}), panelProps: 'few' },
      });
      await P.wait(900);

      const wb = app.workspace.getLeavesOfType('kb-workbench-view')[0];
      if (wb && app.workspace.activeLeaf !== wb) app.workspace.setActiveLeaf(wb, { focus: true });
      P.closeAll(4);
      await P.wait(300);
      const closeOne = async () => {
        const p = panels()[0];
        if (!p) return;
        const b = p.querySelector('.kbw-cw-tabclose-all') || P.btnByText('完成', p);
        if (b) P.click(b); else P.key('Escape');
        await P.wait(500);
      };
      while (panels().length > 0) await closeOne();
      const cards = P.qa('[data-card]');
      if (cards.length < 1) return { ok: false, info: '看板上没有卡片' };

      // 挑一篇**有结尾双链段**的（尾链折叠那一条要有东西可折）
      let target = null;
      for (const c of cards) {
        const path = c.getAttribute('data-path') || '';
        const f = app.vault.getAbstractFileByPath(path);
        if (!f) continue;
        const text = await app.vault.cachedRead(f);
        if (text.indexOf('## 关联笔记') >= 0) { target = { card: c, path }; break; }
      }
      if (!target) return { ok: false, info: '这一屏没有带「## 关联笔记」的卡片（尾链折叠判不了）' };

      P.click(target.card.querySelector('.kbw-card-t'));
      await P.wait(1600);
      const p = panels()[0];
      if (!p) return { ok: false, info: '面板没开出来' };
      const page = p.querySelector('.kbw-cw-page');
      const cm = p.querySelector('.cm-content');
      const cmBefore = cm ? parseFloat(getComputedStyle(cm).fontSize) : 0;

      /**
       * ① Ctrl+滚轮 → 这一篇的字号 +1（写在 panelByPath 里）
       * 🔴 **P6b ④ 起"在哪儿滚"有语义**：只有**光标在正文上**才缩字
       *（在面板头/属性区上滚 = 缩放**窗口**）。所以这一发必须打在 .cm-content 上 ——
       * 打在面板根上（老写法）现在会走"缩放窗口"那条路。
       */
      const wheelTarget = cm || p;
      const wr = wheelTarget.getBoundingClientRect();
      wheelTarget.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100,
        clientX: Math.round(wr.left + Math.min(wr.width / 2, 40)),
        clientY: Math.round(wr.top + Math.min(wr.height / 2, 20)),
      }));
      await P.wait(900);
      const cmAfter = cm ? parseFloat(getComputedStyle(cm).fontSize) : 0;
      const saved = await ctx.configs.read('board');
      const mine = (saved.view.panelByPath || {})[target.path] || {};

      // ② 拖分隔条 → 比例落盘（真机上按**页的真实高度**算）
      const bar = p.querySelector('.kbw-cw-split');
      let ratio = null;
      let splitClass = false;
      if (bar) {
        const pr = page.getBoundingClientRect();
        const br = bar.getBoundingClientRect();
        const from = { x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2) };
        const toY = Math.round(pr.top + pr.height * 0.35);
        const el1 = P.elAt(from.x, from.y);
        el1.dispatchEvent(P.mkPointer('pointerdown', from.x, from.y, 'mouse'));
        for (let i = 1; i <= 4; i += 1) {
          const y = Math.round(from.y + ((toY - from.y) * i) / 4);
          P.elAt(from.x, y).dispatchEvent(P.mkPointer('pointermove', from.x, y, 'mouse'));
        }
        P.elAt(from.x, toY).dispatchEvent(P.mkPointer('pointerup', from.x, toY, 'mouse'));
        await P.wait(900);
        const saved2 = await ctx.configs.read('board');
        ratio = ((saved2.view.panelByPath || {})[target.path] || {}).ratio;
        splitClass = page.classList.contains('is-split');
      }

      // ③ 尾链折叠：那一行的折叠指示器要带 is-collapsed（平台画的、我们点的）
      const inds = P.qa('.kbw-cw-leaf .cm-fold-indicator');
      const collapsed = inds.filter((i) => i.classList.contains('is-collapsed'));
      const foldedText = collapsed.some((i) => P.text(i.parentElement).indexOf('关联笔记') >= 0);
      const lineTexts = P.qa('.kbw-cw-leaf .cm-line').map((l) => P.text(l));
      const ellipsis = lineTexts.some((t) => t.indexOf('关联笔记…') >= 0 || t.indexOf('关联笔记...') >= 0);

      // 收尾：把配置拨回去（这一篇的字号/比例是探针自己写进去的）
      await ctx.configs.write('board', backup);
      await P.wait(700);
      while (panels().length > 0) await closeOne();

      return {
        ok: cmAfter > cmBefore && mine.font === Math.round(cmAfter) &&
            !!bar && ratio != null && ratio > 0.15 && ratio < 0.85 && splitClass &&
            inds.length > 0 && foldedText && ellipsis,
        info: '字号 ' + cmBefore + ' → ' + cmAfter + '（落盘 ' + JSON.stringify(mine.font) + '）' +
              '｜分隔条=' + !!bar + '（比例 ' + ratio + '，is-split=' + splitClass + '）' +
              '｜折叠指示器 ' + inds.length + ' 个、其中 is-collapsed ' + collapsed.length +
              '、折的是尾链=' + foldedText + '、行文本带省略号=' + ellipsis,
      };
    })()`,
  },
  {
    name: 'f · 标签页图标是自己的标记（平台重建之后要补上）· 看板全局菜单一级 ≤ 8',
    script: `(async () => {
      const P = window.__kbwProbe;
      const iconOf = () => {
        const box = P.q('.workspace-tab-header[data-type="kb-workbench-view"] .workspace-tab-header-inner-icon');
        return box ? box.querySelector('svg') : null;
      };
      const mine = () => { const s = iconOf(); return !!s && s.classList.contains('kbw-tab-mark'); };
      const svgIconCls = () => { const s = iconOf(); return !!s && s.classList.contains('svg-icon'); };
      const first = mine();
      // 平台会在 layout-change 之后重建那个头 —— 我们要能自己补上
      app.workspace.trigger('layout-change');
      await P.wait(800);
      const afterLayout = mine();

      // 菜单：一级项数（硬规矩 2 是 8）
      P.closeAll(3);
      await P.wait(300);
      const body = P.q('.kbw-board-body');
      if (!body) return { ok: false, info: '看板体不在（跑这一步前得先在看板上）' };
      const br = body.getBoundingClientRect();
      P.rightClickAt(Math.round(br.left + 14), Math.round(br.top + 8));
      await P.wait(500);
      const menu = P.lastMenu();
      const top = menu ? Array.from(menu.querySelectorAll('.kbw-menu-item')) : [];
      const labels = top.map((i) => P.text(i));
      const more = P.clickMenu('更多显示', menu);
      await P.wait(400);
      const reloadInSub = P.qa('.kbw-menu-item').some((i) => P.text(i).indexOf('重载') >= 0);
      P.key('Escape');
      await P.wait(300);

      return {
        ok: first && afterLayout && svgIconCls() && top.length > 0 && top.length <= 8 && more && reloadInSub,
        info: '图标是自己的标记=' + first + '（layout-change 之后=' + afterLayout + '、带 svg-icon=' + svgIconCls() + '）' +
              '｜菜单一级 ' + top.length + ' 项：' + labels.join(' / ') +
              '｜「更多显示」点得开=' + more + '、里面找得到「重载」=' + reloadInSub,
      };
    })()`,
  },

  // ── P5 · 库结构重排（2026-09-26，第一次"大规模真动库"的一期）─────
  /**
   * 这一批**对着实验库真跑一轮**（P5 开工提示词里那条：真机全量一轮，跑完把库恢复原状）。
   * 三步共用 "window.__p5" 里的一份状态：
   *   ① 预览（只读）—— 树 / 徽标 / 报告，**一个字节都不动**
   *   ② 执行 + 幂等 —— 确认流的数**与报告对得上**、骨架补齐、再点一次盘上零变化
   *   ③ 还原 + 清场 —— 笔记回到起点（sha256 清单逐条比），新建的目录被删掉
   *
   * ⚠️ 清单口径：**只比笔记**（".md"），排除 "99_Meta/05_操作日志/"（这一轮会往里写报告）
   * 与 "99_Meta/06_工作台/"（"库结构.json" 是这一期第一次落的盘，那是配置不是笔记）。
   */
  {
    name: 'P5 · 重排预览（只读）：树 + 徽标 + 报告，一个字节都不动',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const digest = async () => {
        const out = [];
        const walk = async (dir) => {
          const l = await app.vault.adapter.list(dir);
          for (const f of (l.files || [])) {
            if (f.slice(-3) !== '.md') continue;
            const rel = f.slice(KB.length + 1);
            if (rel.indexOf('99_Meta/05_操作日志/') === 0) continue;
            if (rel.indexOf('99_Meta/06_工作台/') === 0) continue;
            const text = await app.vault.adapter.read(f);
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
            out.push(rel + ':' + Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''));
          }
          for (const d of (l.folders || [])) await walk(d);
        };
        await walk(KB);
        return out.sort().join('\\n');
      };
      const logNames = async () => (await ctx.report.recent(400)).map(function (f) { return f.path; });
      // 清场时把"重排那三步"造的那篇临时笔记删掉（它可能已经被搬走 → 两个位置都找）

      P.closeAll(4);
      await P.wait(500);
      /**
       * 🔴 **先造一篇"注定要被搬"的笔记**：重排的计划 = "实际目录 vs 规则算出来的目录"
       * 不一致的那些 —— 实验库被前几轮探针整理过之后**计划是空的**（徽标全 0、执行按钮
       * 根本不画），这一步会以"搬入 0 篇"整片假红（红的原因是"没东西可做"）。
       * 收尾由"还原 + 清场"那一步删掉它。
       */
      await P.dropMisplacedNote();
      await P.seedMisplacedNote();
      /**
       * 🔴 **骨架里也塞一条"库里还没有的目录"**：另外两样夹具（要搬的那篇笔记）只撑起
       * 「搬入」那半截 —— 「新建 N 目录」= 骨架声明了而盘上没有的目录，实验库现在**一个不缺**，
       * 于是"新建"那枚徽标恒为 0、这一步的子条件整片假红（红的原因是"没东西可做"）。
       * 收尾由"还原 + 清场"那一步抹掉（只抹配置那一条，盘上的目录归还原删）。
       */
      await P.dropSkeletonDir();
      await P.seedSkeletonDir();
      await P.wait(600);
      // 进「全部笔记」——目录树 ⋯ 是这一期的入口之一，先把它验了
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const node = P.q('.kbw-tree-body .kbw-tree-row') || P.q('.kbw-tnode') || P.q('.kbw-tree-body > *');
      let menuHas = false;
      if (node) {
        const pt = P.aimAt(node);
        if (pt && pt.visible) {
          P.rightClickAt(pt.x, pt.y);
          await P.wait(500);
          const menu = P.lastMenu();
          menuHas = !!menu && Array.from(menu.querySelectorAll('.kbw-menu-item')).some(function (i) { return P.text(i).indexOf('重排库结构') >= 0; });
          P.key('Escape');
          await P.wait(300);
        }
      }

      const before = await digest();
      const logsBefore = await logNames();
      // 开面板：走**命令面板那条真路**（不进命令面板 UI，直接执行那条命令 —— 与用户按快捷键等价）
      const ran = app.commands.executeCommandById('kb-workbench:rebuild');
      await P.wait(1600);
      const modal = P.lastModal();
      const nodes = P.qa('.kbw-rb-node');
      const chips = P.qa('.kbw-rb-node .kbw-chip').map(function (c) { return P.text(c); });
      const side = P.q('.kbw-rb-side');
      /**
       * ── R7 三块式（2026-10-06；逻辑零改）──
       * ① 体检范围与标准（范围下拉 / 标准 / 看目录结构示意 / 重新检查）在右栏**最上面**；
       * ② 问题清单 = 一句总述 + 三组可折叠；③ 执行方式 = 单选 + 补建勾选 + 只读承诺。
       */
      const planBand = P.q('.kbw-rb-plan');
      const sumSent = P.q('.kbw-rb-sumsent');
      const bandBeforeSent = !!(planBand && sumSent &&
        (planBand.compareDocumentPosition(sumSent) & Node.DOCUMENT_POSITION_FOLLOWING));
      const grpCount = {
        do: P.qa('.kbw-rb-grp.is-do').length,
        warn: P.qa('.kbw-rb-grp.is-warn').length,
        keep: P.qa('.kbw-rb-grp.is-keep').length,
      };
      const presetInBand = !!(planBand && planBand.querySelector('.kbw-rb-preset'));
      const rangeInBand = !!(planBand && planBand.querySelector('.kbw-rb-range'));
      const blockN = P.qa('.kbw-rb-block').length;
      const radioN = P.qa('.kbw-rb-radio').length;
      const checkN = P.qa('.kbw-rb-check').length;
      const sentText = sumSent ? P.text(sumSent) : '';
      // 树徽标减噪：「保留」不再是逐节点徽标（树底该有一行图例说清灰行）
      const hasKeptChip = chips.some(function (t) { return t.indexOf('保留') >= 0; });
      const legend = P.q('.kbw-rb-legend');
      // 再点一次「重新检查」（① 那一带）：只读、可反复点
      const btn = P.qa('.kbw-rb-recheck')[0] || null;
      if (btn) { P.click(btn); await P.wait(1200); }
      const after = await digest();
      const logsAfter = await logNames();
      const newLogs = logsAfter.filter(function (p) { return logsBefore.indexOf(p) < 0; });

      /**
       * **点一下节点能真的收起**（离线审查 🟡2 抓到的那条：类贴在别的元素上、没人报错）。
       * 判据用 computed style + 几何：只查 class 的话，两份判定再漂一次照样绿。
       */
      let foldOk = false;
      /**
       * ⚠️ 要挑一个**真有子节点**的：第一版只判了"有兄弟节点"（= 顶层），
       * 于是挑到 00_Inbox 这种空目录 —— 它的 kids 本来就是 0 高，
       * 判据成了「0 > 0」的假红（真机上第一次跑就是这么红的）。
       */
      const parent = P.qa('.kbw-rb-node').find(function (n) {
        const kids = n.parentElement && n.parentElement.querySelector('.kbw-rb-kids');
        return kids && kids.children.length > 0;
      });
      if (parent) {
        const kids = parent.parentElement.querySelector('.kbw-rb-kids');
        const beforeH = kids ? kids.getBoundingClientRect().height : -1;
        const pt = P.aimAt(parent);
        if (pt && pt.visible) P.click(parent);
        await P.wait(400);
        const afterH = kids ? kids.getBoundingClientRect().height : -1;
        const disp = kids ? getComputedStyle(kids).display : '';
        foldOk = beforeH > 0 && afterH === 0 && disp === 'none';
        window.__p5Fold = { beforeH: beforeH, afterH: afterH, display: disp };
      }

      window.__p5 = { before: before, logsBefore: logsBefore, kbRoot: KB, sum: sentText };

      return {
        // ⚠️ side 要**现取**：面板是异步建出来的，早取到的是 null（本轮加了预热步骤后时序变了）
        ok: !!ran && !!modal && nodes.length >= 20 && menuHas && !!P.q('.kbw-rb-side') &&
            chips.some(function (t) { return t.indexOf('新建') >= 0; }) &&
            chips.some(function (t) { return t.indexOf('搬入') >= 0; }) &&
            !hasKeptChip && !!legend &&
            bandBeforeSent && grpCount.do > 0 && grpCount.warn > 0 && grpCount.keep > 0 &&
            presetInBand && rangeInBand && blockN === 2 && radioN === 2 && checkN === 2 &&
            sentText.indexOf('查完了') >= 0 && sentText.indexOf('该搬') >= 0 && !!btn &&
            after === before && foldOk &&
            newLogs.some(function (p) { return p.indexOf('重排预览') >= 0; }),
        info: '子条件[ran=' + !!ran + ' modal=' + !!modal + ' nodes=' + nodes.length +
              ' menuHas=' + menuHas + ' side=' + !!P.q('.kbw-rb-side') +
              ' chips=[' + chips.join(' | ') + ']（无「保留」徽标=' + !hasKeptChip + ' · 图例=' + !!legend + '）' +
              ' ①在总述前=' + bandBeforeSent + ' 三组=' + JSON.stringify(grpCount) +
              ' 标准在①=' + presetInBand + ' 范围在①=' + rangeInBand +
              ' ②③块数=' + blockN + ' 单选=' + radioN + ' 勾选=' + checkN +
              ' 总述含查完了=' + (sentText.indexOf('查完了') >= 0) + ' 重新检查=' + !!btn +
              ' digest=' + (after === before) +
              ' fold=' + foldOk + ' log=' + newLogs.some(function (p) { return p.indexOf('重排预览') >= 0; }) + ']' +
              '｜命令能跑=' + ran + '｜树节点 ' + nodes.length + ' 个｜徽标 ' + chips.length +
              ' 枚（新建 ' + chips.filter(function (t) { return t.indexOf('新建') >= 0; }).length +
              ' / 搬入 ' + chips.filter(function (t) { return t.indexOf('搬入') >= 0; }).length +
              ' / 撞名 ' + chips.filter(function (t) { return t.indexOf('撞名') >= 0; }).length + '）' +
              '｜总述「' + sentText + '」｜目录树 ⋯ 里有那条菜单=' + menuHas +
              '｜反复点预览：笔记清单' + (after === before ? '一个字节没变 ✓' : '变了 ✗') +
              '｜点一下能收起=' + foldOk + '（高度 ' + (window.__p5Fold ? window.__p5Fold.beforeH + '→' + window.__p5Fold.afterH : '?') +
              '、display=' + (window.__p5Fold ? window.__p5Fold.display : '?') + '）' +
              '｜新写的报告 ' + newLogs.length + ' 条（' + newLogs.map(function (p) { return p.split('/').pop(); }).join(' / ') + '）',
      };
    })()`,
    /**
     * ⚠️ "shot" 必须是**步骤对象的字段**（与 "script" 平级）——P5 第一版把它写进了
     * "script" 的返回值里，于是 "step.shot" 恒为 undefined：**截图一次都不产生、且不报错**
     *（跑完还显示"全绿"，只是没有证据）。这类"静默不生效"正是本项目最防的那种。
     */
    shot: 'P5-重排预览.png',
  },
  {
    name: 'P5 · 执行 + 幂等：确认流的数与报告对得上 · 骨架补齐 · 再点一次盘上零变化',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = window.__p5 ? window.__p5.kbRoot : ctx.settings.kbRoot();
      const digest = async () => {
        const out = [];
        const walk = async (dir) => {
          const l = await app.vault.adapter.list(dir);
          for (const f of (l.files || [])) {
            if (f.slice(-3) !== '.md') continue;
            const rel = f.slice(KB.length + 1);
            if (rel.indexOf('99_Meta/05_操作日志/') === 0) continue;
            if (rel.indexOf('99_Meta/06_工作台/') === 0) continue;
            out.push(rel);
          }
          for (const d of (l.folders || [])) await walk(d);
        };
        await walk(KB);
        return out.sort().join('\\n');
      };
      const exists = async (p) => { try { return await app.vault.adapter.exists(p); } catch (e) { return false; } };

      if (!P.q('.kbw-rb')) {
        app.commands.executeCommandById('kb-workbench:rebuild');
        await P.wait(1600);
      }
      /**
       * ⚠️ **单独跑这一条时**（probe 的 --only 过滤）面板是刚开的：先把夹具补齐，
       * 否则「骨架缺 1 个」那条前提不成立（全量跑时上一步已经播过了，这里是幂等的）。
       */
      await P.seedSkeletonDir();
      const cfg = await ctx.configs.read('rebuild');
      const dirs = (cfg.dirs || []);
      const missingBefore = [];
      for (const d of dirs) if (!(await exists(KB + '/' + d))) missingBefore.push(d);

      const plan = await digest();
      // ① 点执行 → 确认流
      const isRun = function (t) { return /^(开始纠偏|开始归拢|开始初始化)/.test(t); };
      const runBtn = P.qa('.kbw-modal-foot .kbw-btn').find(function (b) { return isRun(P.text(b)); });
      if (!runBtn) return { ok: false, info: '面板脚上没有执行按钮' };
      P.click(runBtn);
      await P.wait(700);
      const confirmModal = P.lastModal();
      const title = P.text(P.q('.kbw-panel-title', confirmModal) || confirmModal);
      const num = function (re) { const m = title.match(re); return m ? Number(m[1]) : -1; };
      const sayNew = num(/新建 (\\d+) 个?目录/);
      const sayMove = num(/搬入 (\\d+) 篇/);
      const primary = P.qa('.kbw-btn', confirmModal).find(function (b) { return P.text(b).indexOf('搬这') === 0 || P.text(b).indexOf('建这') === 0; });
      if (primary) { P.click(primary); await P.wait(400); }
      // 等它做完（面板侧栏会出现「上次执行：」那行）
      for (let i = 0; i < 40; i += 1) {
        if (P.q('.kbw-rb-last')) break;
        await P.wait(300);
      }
      await P.wait(1200);

      const afterRun = await digest();
      const missingAfter = [];
      for (const d of dirs) if (!(await exists(KB + '/' + d))) missingAfter.push(d);
      // 报告对账：「已移动 N 篇」必须等于确认流上写的那个 N
      const logs = await ctx.report.recent(6);
      let said = -1;
      let grouped = false;
      for (const f of logs) {
        const text = await app.vault.read(f);
        if (text.indexOf('库结构重排') < 0 || text.indexOf('上次执行') >= 0) continue;
        const m = text.match(/已移动 (\\d+) 篇/);
        if (m) { said = Number(m[1]); grouped = text.indexOf('## 已搬过') >= 0 || text.indexOf('## 真冲突') >= 0; break; }
      }
      const side = P.text(P.q('.kbw-rb-side'));

      // ② 再点一次执行 = 幂等（盘上零变化、没有第二个库根）
      const plan2 = afterRun;
      const runBtn2 = P.qa('.kbw-modal-foot .kbw-btn').find(function (b) { return /^(开始纠偏|开始归拢|开始初始化)/.test(P.text(b)) || P.text(b).indexOf('没有要做') >= 0; });
      if (runBtn2) { P.click(runBtn2); await P.wait(700); }
      const primary2 = P.qa('.kbw-btn', P.lastModal()).find(function (b) { return P.text(b).indexOf('搬这') === 0 || P.text(b).indexOf('建这') === 0; });
      if (primary2) { P.click(primary2); await P.wait(2500); }
      const afterSecond = await digest();
      const roots = (await app.vault.adapter.list('')).folders.map(function (p) { return p.split('/').pop(); });
      const twin = roots.filter(function (n) { return n !== KB && n.indexOf(KB) === 0; });

      window.__p5.afterRun = afterRun;
      window.__p5.missingBefore = missingBefore;

      return {
        ok: missingBefore.length > 0 && missingAfter.length === 0 && plan !== afterRun &&
            said >= 0 && said === sayMove && sayNew === missingBefore.length &&
            afterSecond === plan2 && twin.length === 0,
        info: '确认流「' + title + '」｜新写的移动报告说「已移动 ' + said + ' 篇」' +
              '｜骨架：执行前缺 ' + missingBefore.length + ' 个 [' + missingBefore.join(' ') + '] → 执行后缺 ' + missingAfter.length +
              '｜盘上：' + plan.split('\\n').length + ' 篇 → ' + afterRun.split('\\n').length + ' 篇' +
              '｜再点一次零变化=' + (afterSecond === plan2) + '｜并列库=' + (twin.length === 0 ? '无 ✓' : twin.join(',')) +
              '｜侧栏「' + side.slice(0, 60) + '」',
      };
    })()`,
    shot: 'P5-重排执行.png',
  },
  {
    name: 'P5 · 还原 + 清场：笔记逐条回到起点（sha256）· 新建的目录被删掉',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = window.__p5 ? window.__p5.kbRoot : ctx.settings.kbRoot();
      const digest = async () => {
        const out = [];
        const walk = async (dir) => {
          const l = await app.vault.adapter.list(dir);
          for (const f of (l.files || [])) {
            if (f.slice(-3) !== '.md') continue;
            const rel = f.slice(KB.length + 1);
            if (rel.indexOf('99_Meta/05_操作日志/') === 0) continue;
            if (rel.indexOf('99_Meta/06_工作台/') === 0) continue;
            const text = await app.vault.adapter.read(f);
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
            out.push(rel + ':' + Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''));
          }
          for (const d of (l.folders || [])) await walk(d);
        };
        await walk(KB);
        return out.sort().join('\\n');
      };
      const exists = async (p) => { try { return await app.vault.adapter.exists(p); } catch (e) { return false; } };
      const before = window.__p5 ? window.__p5.before : '';
      const missingBefore = (window.__p5 && window.__p5.missingBefore) || [];

      // 撤销条（执行完就在屏幕上）—— 它接的就是快照还原那条真路
      const undo = P.qa('.kbw-undobar .kbw-btn').find(function (b) { return P.text(b).indexOf('撤销') >= 0; });
      if (!undo) {
        await P.dropMisplacedNote();
        return { ok: false, info: '屏幕上没有撤销条（执行那一步是不是没走到？）' };
      }
      P.click(undo);
      await P.wait(1000);
      for (let i = 0; i < 30; i += 1) {
        const now = await digest();
        if (now === before) break;
        await P.wait(400);
      }
      const after = await digest();
      /**
       * 🔴 **清场要放在"还原之后"**（P7.15 全量跑抓到）：这一篇是"重排那三步"造的临时笔记，
       * 而**快照还原会把它写回来**（它当初就在快照里）—— 先删再还原 = 白删，它就一直留在
       * 00_Inbox 里，十几步之后 P7.14b/P7.15 的"自清理后不该有探针残留"判据全被它点着
       *（2026-10-08 实测：01_新知识库/00_Inbox/__探针重排.md 就是这么留下来的）。
       * ⚠️ 顺序：digest() 是"与起点逐条比"的判据，**它跑完再删**（先删会让比对恒真）。
       */
      await P.dropMisplacedNote();
      const stillThere = [];
      const inVaultCache = [];
      for (const d of missingBefore) {
        if (await exists(KB + '/' + d)) stillThere.push(d);
        // ⚠️ 文件系统侧删掉了，**平台缓存里的 TFolder 也该没**（fs.rm 绕过了 vault 事件，
        // 缓存要等 watcher 补上 —— 这条就是问"补上了没有"）
        if (app.vault.getAbstractFileByPath(KB + '/' + d)) inVaultCache.push(d);
      }

      // 清场：关面板 + 删掉这一轮新写的报告（**只删我点名的这几条**，不是按标记扫）
      P.closeAll(4);
      await P.wait(400);
      /**
       * ⚠️ **把夹具那条"库里还没有的目录"从骨架里抹掉**（顺序很重要：上面那两条判据
       * 已经量完了才轮到它）。**盘上那个目录不在这儿删** —— 它归上面那次还原，
       * 顺手删掉的话"还原时删掉新建的目录"就成了恒真。
       */
      const skeletonDropped = await P.dropSkeletonDir();
      const logsNow = (await ctx.report.recent(400)).map(function (f) { return f.path; });
      const mine = logsNow.filter(function (p) { return (window.__p5.logsBefore || []).indexOf(p) < 0; });
      let removed = 0;
      for (const p of mine) {
        const f = app.vault.getAbstractFileByPath(p);
        if (!f) continue;
        const text = await app.vault.read(f);
        if (text.indexOf('库结构重排') < 0 && text.indexOf('重排预览') < 0) continue;
        await app.vault.delete(f, true);
        removed += 1;
      }

      return {
        ok: !!before && after === before && stillThere.length === 0 && inVaultCache.length === 0 &&
            removed === mine.length && skeletonDropped > 0,
        info: '还原后清单与开工前' + (after === before ? '逐条一致 ✓' : '不一致 ✗') +
              '｜这一轮新建的目录 ' + missingBefore.length + ' 个，还原后还留着 ' + stillThere.length + ' 个' +
              '（' + (stillThere.join(' ') || '都删掉了 ✓') + '）、平台缓存里还认得 ' + inVaultCache.length + ' 个' +
              '｜清掉本轮报告 ' + removed + ' / ' + mine.length + ' 条' +
              '｜骨架里那条夹具抹掉 ' + skeletonDropped + ' 条' +
              '（⚠️ 库结构.json 留着 —— 它是这一期的配置产物，与 看板配置.json 同一类）',
      };
    })()`,
    shot: 'P5-还原.png',
  },

  // ══════════════════════════════════════════════════════════════
  // P7.2b · 库框架（16.1 初始化 / 收拢 ＋ 16.2 示例数据）—— 沙箱真跑
  // ══════════════════════════════════════════════════════════════
  {
    name: 'P7.2b · 库框架初始化：空库 → 骨架 + 种子页 + 示例数据 → 幂等 → 快照还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = function (m) { problems.push(m); };
      const exists = async function (p) { try { return await app.vault.adapter.exists(p); } catch (e) { return false; } };
      const waitUntil = async function (fn, ms) { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await P.wait(200); } };
      const footBtn = function (prefix) {
        return P.qa('.kbw-modal-foot .kbw-btn').find(function (b) { return P.text(b).indexOf(prefix) === 0; });
      };

      P.closeAll(4);
      await P.wait(400);
      const kb0 = ctx.settings.kbRoot();
      const emptyKb = '__探针空库';
      if (!(await exists(emptyKb))) await app.vault.adapter.mkdir(emptyKb);
      await ctx.settings.save({ kbRoot: emptyKb });
      await P.wait(700);
      // 骨架 = 默认（完整版 21+7）：ensure 落的默认值就是它；把 rootName 改成这个测试库根
      const raw = await ctx.configs.ensure('rebuild');
      await ctx.configs.write('rebuild', Object.assign({}, raw, { rootName: emptyKb }));
      await P.wait(400);
      // 开面板：走命令面板那条真路（与用户按快捷键等价）
      app.commands.executeCommandById('kb-workbench:rebuild');
      await P.wait(1800);

      const head = P.text(P.q('.kbw-rb-treehead'));
      if (head.indexOf('21 个目录') < 0) note('树头没写 21 个目录（实际：' + head + '）');
      // 初始化档（R7）：归拢重整置灰、索引页默认勾、示例笔记可勾
      const reorgRadio = P.qa('.kbw-rb-radio').find(function (r) { return P.text(r).indexOf('归拢重整') >= 0; });
      if (!reorgRadio) note('没画「归拢重整」单选');
      else if (reorgRadio.className.indexOf('is-disabled') < 0) note('空库上「归拢重整」该置灰');
      const seedsRow = P.qa('.kbw-rb-check').find(function (r) { return P.text(r).indexOf('索引页') >= 0; });
      const seedsCb = seedsRow ? seedsRow.querySelector('input') : null;
      if (!seedsCb || !seedsCb.checked) note('「索引页」没默认勾（初始化档）');
      // 示例数据也勾上（16.2 真机一并验）—— 点 label（勾选框本体）
      const samRow = P.qa('.kbw-rb-check').find(function (r) { return P.text(r).indexOf('示例笔记') >= 0; });
      const samCb = samRow ? samRow.querySelector('input') : null;
      if (!samCb) note('没有「放几篇示例笔记」勾选框');
      else { samCb.click(); await P.wait(800); }

      const runBtn = footBtn('开始初始化');
      if (!runBtn) note('执行按钮不在（初始化档该能建）');
      else {
        P.click(runBtn);
        await P.wait(900);
        const modal = P.lastModal();
        const mt = P.text(modal);
        if (mt.indexOf('初始化') < 0) note('确认流标题没写初始化（实际：' + mt.slice(0, 60) + '）');
        const primary = Array.from(modal.querySelectorAll('.kbw-btn')).find(function (b) { return P.text(b).indexOf('建这') === 0; });
        if (!primary) note('确认流没有主按钮');
        else P.click(primary);
      }
      // 等真建出来（种子页 + 示例）
      const seedOk = await waitUntil(function () { return exists(emptyKb + '/00_Inbox/_收件箱.md'); }, 20000);
      if (!seedOk) note('种子页 _收件箱.md 没建出来');
      const sampleOk = await waitUntil(function () { return exists(emptyKb + '/00_Inbox/__示例 · 灵感速记.md'); }, 10000);
      if (!sampleOk) note('示例笔记没建出来');
      if (!(await exists(emptyKb + '/99_Meta/04_索引与地图/MOC_知识地图.md'))) note('99_Meta 里的种子没建');
      /**
       * 示例看板板块（磁盘回读）——⚠️ **板块是执行完"之后"才异步写的**
       * （appendSampleSection 在 executeRebuild 返回后才跑），拿"种子文件在"当完成信号
       * 直接读 = 竞态（全量首跑就红在这里，而同轮"示例 ✓ / 幂等 ✓"都绿着 = 只是读早了）。
       * 轮询等它出现。
       */
      const secOk = await waitUntil(async function () {
        try {
          const bRaw = await app.vault.adapter.read(emptyKb + '/99_Meta/06_工作台/看板配置.json');
          const bj = JSON.parse(bRaw);
          return Array.isArray(bj.sections) && bj.sections.some(function (s) { return s && s.id === '__sample'; });
        } catch (e) { return false; }
      }, 20000);
      if (!secOk) note('示例看板板块没进看板配置.json（等了 20s）');
      // 幂等：再预览 = 没有要做的
      const zero = await waitUntil(function () {
        const b = P.qa('.kbw-modal-foot .kbw-btn').find(function (x) {
          return /^(开始纠偏|开始归拢|开始初始化)/.test(P.text(x)) || P.text(x) === '没有要做的';
        });
        return !!b && P.text(b) === '没有要做的';
      }, 15000);
      if (!zero) note('初始化后再预览不是「没有要做的」');
      // 还原（与撤销条同一条服务路）
      const list = await ctx.snapshot.list();
      const r = list.length > 0 ? await ctx.snapshot.restore(list[0].id) : null;
      let restoredN = -1;
      if (!r) note('快照列表为空（执行没落快照？）');
      else {
        restoredN = r.filesRemoved;
        if (r.filesRemoved < 13) note('新建文件没删干净（filesRemoved=' + r.filesRemoved + '，期望 13=7 种子+6 示例）');
        if (await exists(emptyKb + '/00_Inbox/_收件箱.md')) note('还原后种子页还在');
        if (await exists(emptyKb + '/00_Inbox/__示例 · 灵感速记.md')) note('还原后示例还在');
      }

      // 收场：关面板 + kbRoot 切回 + 整个测试根删掉（它是这一轮专属造物）
      P.closeAll(4);
      await P.wait(400);
      await ctx.settings.save({ kbRoot: kb0 });
      await P.wait(500);
      try { await app.vault.adapter.rmdir(emptyKb, true); } catch (e) { note('测试库根没删掉：' + e.message); }

      return {
        ok: problems.length === 0,
        info: '空库=' + emptyKb + '｜原子化建出 21 目录/' + (seedOk ? '种子 ✓' : '种子 ✗') +
              (sampleOk ? ' + 示例 ✓' : ' + 示例 ✗') + '｜示例板块=' + secOk + '｜幂等=' + zero +
              '｜还原删掉新建文件 ' + restoredN + ' 个' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.2b-初始化.png',
  },
  {
    name: 'P7.2b · 收拢：全库按原相对路径进归集夹 → 复跑重排 0 搬动 → 快照还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = function (m) { problems.push(m); };
      const NL = String.fromCharCode(10);
      const KB = ctx.settings.kbRoot();
      const pad = function (n) { return String(n).padStart(2, '0'); };
      const d0 = new Date();
      const today = '' + d0.getFullYear() + pad(d0.getMonth() + 1) + pad(d0.getDate());
      const GU = KB + '/04_Archives/旧笔记-' + today;
      const exists = async function (p) { try { return await app.vault.adapter.exists(p); } catch (e) { return false; } };
      const waitUntil = async function (fn, ms) { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await P.wait(200); } };
      const footBtn = function (prefix) {
        return P.qa('.kbw-modal-foot .kbw-btn').find(function (b) { return P.text(b).indexOf(prefix) === 0; });
      };

      P.closeAll(4);
      await P.wait(400);
      // 夹具：一篇带声明的笔记 + 一个附件（__探针 前缀 —— 兜底清场认得出）
      const aRel = KB + '/00_Inbox/__探针收拢甲.md';
      const bRel = KB + '/00_Inbox/__探针收拢乙.bin';
      const aText = ['---', '类型: 想法', '领域: 灵感杂记', '文件位置:', '  - 00_Inbox', '---', '', '# 探针收拢甲', ''].join(NL);
      if (!(await exists(aRel))) await app.vault.create(aRel, aText);
      if (!(await exists(bRel))) await app.vault.create(bRel, '探针附件');
      await P.wait(900);

      app.commands.executeCommandById('kb-workbench:rebuild');
      await P.wait(1800);
      // R7：收拢 = ③「执行方式」里的单选「归拢重整」（不再是开关）
      const reorgRadio = P.qa('.kbw-rb-radio').find(function (r) { return P.text(r).indexOf('归拢重整') >= 0; });
      if (!reorgRadio) note('非空库上没有「归拢重整」单选');
      if (reorgRadio && P.text(reorgRadio).indexOf('旧笔记-' + today) < 0) note('动作说明没写今天的归集夹名');
      if (reorgRadio) { P.click(reorgRadio); await P.wait(1000); }
      const runBtn = footBtn('开始归拢');
      if (!runBtn || P.text(runBtn).indexOf('收拢') < 0) note('执行按钮没换代（实际：' + (runBtn ? P.text(runBtn) : '无') + '）');
      else {
        P.click(runBtn);
        await P.wait(900);
        const modal = P.lastModal();
        const mt = P.text(modal);
        if (mt.indexOf('收拢') < 0 || mt.indexOf('撞名') < 0) note('确认流没写三个数（实际：' + mt.slice(0, 90) + '）');
        const primary = Array.from(modal.querySelectorAll('.kbw-btn')).find(function (b) { return P.text(b).indexOf('收拢这') === 0; });
        if (!primary) note('确认流没有「收拢这 N 篇」主按钮');
        else P.click(primary);
      }
      // 甲与附件进归集夹（保持原相对路径）
      const hitOk = await waitUntil(function () { return exists(GU + '/00_Inbox/__探针收拢甲.md'); }, 40000);
      if (!hitOk) note('甲没进归集夹');
      if (!(await exists(GU + '/00_Inbox/__探针收拢乙.bin'))) note('附件没进归集夹');
      if (await exists(aRel)) note('甲还在原位（成对判：目标有 且 原位没）');
      if (!(await exists(KB + '/99_Meta/06_工作台/库结构.json'))) note('99_Meta 被收拢了 —— 工具区失守');
      /**
       * ⚠️ **声明是在"全部搬完"之后才写的**（executeRebuild 的补声明循环在 mover.move 返回后）——
       * 甲是改名循环里最先到位的那批，到位 ≠ 声明已写。拿"文件在"当完成信号直接读 = 竞态
       * （真机首跑红过一次；同一轮的"0 搬动"绿着 = 声明其实写上了，只是读早了）。
       * 判**内容**要用轮询等它收敛。
       */
      const declOk = await waitUntil(async function () {
        try {
          const t = await app.vault.adapter.read(GU + '/00_Inbox/__探针收拢甲.md');
          return t.indexOf('旧笔记-' + today + '/00_Inbox') >= 0;
        } catch (e) { return false; }
      }, 30000);
      if (!declOk) note('甲的「文件位置」没写成新路径（等了 30s）');
      // 复跑重排 0 搬动（等索引跟上真机节拍）
      const zero = await waitUntil(function () {
        const b = P.qa('.kbw-modal-foot .kbw-btn').find(function (x) {
          return /^(开始纠偏|开始归拢|开始初始化)/.test(P.text(x)) || P.text(x) === '没有要做的';
        });
        return !!b && P.text(b) === '没有要做的';
      }, 40000);
      if (!zero) note('收拢后复跑重排不是 0 搬动');
      // 还原（快照面板同一条服务路）
      const list = await ctx.snapshot.list();
      const r = list.length > 0 ? await ctx.snapshot.restore(list[0].id) : null;
      let removedN = -1;
      if (!r) note('快照列表为空');
      else {
        removedN = r.filesRemoved;
        if (!(await waitUntil(function () { return exists(aRel); }, 20000))) note('甲没搬回原位');
        if (await exists(GU)) note('归集夹没收回');
        if (r.filesRemoved < 5) note('新建的种子页没删回（filesRemoved=' + r.filesRemoved + '，期望 >=5）');
      }
      // 清场：关面板 + 删夹具（原位与归集夹两处都找 —— 还原失败时兜底）
      P.closeAll(4);
      await P.wait(400);
      for (const rel of [aRel, bRel, GU + '/00_Inbox/__探针收拢甲.md', GU + '/00_Inbox/__探针收拢乙.bin']) {
        const f = app.vault.getAbstractFileByPath(rel);
        if (f) await app.vault.delete(f, true);
      }

      return {
        ok: problems.length === 0,
        info: '归集夹=' + GU + '｜甲/附件进夹=' + hitOk + '｜复跑重排 0 搬动=' + zero +
              '｜还原删回新建文件 ' + removedN + ' 个' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.2b-收拢.png',
  },

  // ══════════════════════════════════════════════════════════════
  // P6 ① 网格档（交互规格 §3.5）
  // ══════════════════════════════════════════════════════════════
  {
    name: 'P6 · 网格档：渲染 / 每格刻度 / 选中口径 / 框选（**起手帧不残影**）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(700); }
      /**
       * ⚠️ **P6b ② 起列表只画本层** —— 库根那一层常常一篇都没有（笔记都在子目录里）→
       * 网格里也就一格都没有。先站进一个"本层笔记最多"的顶层目录。
       */
      const levelByDir = {};
      P.ctx().index.notes().forEach(function (e) {
        const d = e.effectivePosition;
        if (!d || d.indexOf('/') >= 0) return;
        levelByDir[d] = (levelByDir[d] || 0) + 1;
      });
      const topDir = Object.keys(levelByDir).sort(function (a, b) { return levelByDir[b] - levelByDir[a]; })[0];
      const dirNode = topDir ? P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === topDir; }) : null;
      if (dirNode) { P.click(dirNode); await P.wait(1000); }

      /**
       * 🔴 **先把这一轮要动的界面偏好记下来**，P6 最后一步原样还回去。
       * 为什么必须做：视图档 / 顺序表 / 自动排列都是**落盘的**偏好 ——
       * 探针把它们改成"网格 + 一长串手排顺序"之后，下一轮跑起来时
       * 「P1 · 全部笔记」那几步会看到一张**没有行的表格**（实测：整片假红，
       * 而失败点看着跟网格毫无关系）。本项目的老规矩：自造的配置用完拨回基线。
       */
      if (!window.__p6saved) {
        const s0 = P.ctx().settings.get();
        window.__p6saved = {
          notesView: s0.notesView,
          gridOrder: (s0.gridOrder || []).slice(),
          gridAutoArrange: s0.gridAutoArrange,
          gridSort: s0.gridSort,
          treeSelected: s0.treeSelected,
        };
      }
      /**
       * 🔴 **开场先把这个屏的"视野"摆成确定的**（全库 + 无搜索 + 无筛选）。
       *
       * 为什么必须做：这些都是**会话态 / 落盘的**，前面的步骤会把它们留在半路 ——
       *  · 目录树选择落盘，上一轮可能停在 00_Inbox（只有 8 篇）；
       *  · 搜索框的内容、filters.paths（快速切换跳一篇时会设）留在模块上，
       *    而且**切模块回来还会被"待消费的意图"重新应用一次** —— 于是列表只剩**1 篇**。
       * 实测（全量跑时）：网格只剩一格/一行，框选与换位两条判据连**前提**都不成立，
       * 报出来的却是"窗口太窄？"（真正的起因在十几步之前）。
       */
      /**
       * 🔴 **别用 scopeAll() 收场**（P6b ② 起它会把视野摆回**库根**那一层，而本层常常
       * 一篇都没有 → 网格 0 格、"框选/换位"连前提都不成立）。
       * 🔴 也别"从实验库里挑一个够大的目录"—— **那是在依赖环境状态**（前面几十步会搬文件，
       * 同一份脚本前一轮挑得到、后一轮挑不到，实测踩过）。**自造一个**再进去，收尾删掉。
       */
      const seedTag = '网格A';
      await P.dropGridDir(seedTag);
      /**
       * ⚠️ **格子数要够撑出两行**（下面那条"框选"判据的前提，本轮实测踩到）：
       * 格宽固定 **100px**、容器实测 **972px** ⇒ 一行能放 **8 个**；
       * 原来只造 6 篇（+1 个文件夹格）= **正好一行** → 「tops.length < 2」当场红，
       * 报出来的是"只有一行格子（窗口太窄？）"，看着像环境问题，其实是**夹具太小**。
       * 24 篇 = 3 行（972px）／2 行（1700px 的真窗口），两种窗口下都够。
       */
      const seedDir = await P.seedGridDir(seedTag, 24);
      await P.useView('网格');
      // P7.0b / 14.8a：空串 = 视野没摆好。这一步紧接着会点**自造**的 seedDir，
      // 所以这里只记一笔、不早退（早退会丢掉下面那一整组判据）
      const seeded = await P.enterDirWithNotes(1);
      if (!seeded) note('enterDirWithNotes 没找到可用目录（本层有笔记且盘上真有）—— 视野没摆好，下面的前提存疑');
      const nodeSeed = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === seedDir; });
      if (nodeSeed) { P.click(nodeSeed); await P.wait(1000); }
      const cellsNow = P.qa('.kbw-gcell[data-path]').length;
      if (cellsNow === 0) return { ok: false, info: '摆好视野之后网格里一格都没有（自造的 ' + seedDir + ' 没进去？）' };

      const body = P.q('.kbw-grid');
      const inner = P.q('.kbw-grid-inner');
      /**
       * ⚠️ **只取笔记格**：P6 段② B3 起网格里还有文件夹格（kbw-gcell is-folder，
       * 没有 data-path）。不排掉的话 cells[0] 会是文件夹 —— 后面"每格刻度/单击选中/
       * 大小那一行"全是对着一个文件夹量的（离线用例同样栽过这一跤）。
       */
      const cells = P.qa('.kbw-gcell[data-path]');
      if (!body || !inner) return { ok: false, info: '网格容器没画出来' };
      // data-scroll 要贴对（视图记忆靠它；蹭了 list 的话切档会串位置）
      if (body.getAttribute('data-scroll') !== 'grid') note('滚动容器的 data-scroll 不是 grid');

      const c0 = cells[0];
      if (!c0) return { ok: false, info: '一格都没有' };
      const r0 = c0.getBoundingClientRect();
      if (r0.width < 100) note('每格宽度 ' + Math.round(r0.width) + 'px < 100px（§3.2 的下限）');
      if (!c0.querySelector('.kbw-gthumb svg')) note('格子里没有纸页图标');
      const nameTxt = P.text(c0.querySelector('.kbw-gname'));
      const sizeTxt = P.text(c0.querySelector('.kbw-gsize'));
      if (!nameTxt) note('格子里没有名称');
      if (!/^[0-9.]+ ?(B|KB|MB)$/.test(sizeTxt)) note('大小那一格不像大小：' + sizeTxt);

      const tools = P.text(P.q('.kbw-notes-tools') || document.body);
      if (tools.indexOf('列') >= 0) note('网格档的工具条上还留着「列」按钮');
      if (P.text(P.q('.kbw-sortbar') || document.body).indexOf('排序') < 0) note('排序条没画出来');
      if (P.text(P.q('.kbw-gstatus') || document.body).indexOf('共') < 0) note('底部状态行没画出来');

      // ── 选中口径：单击 / Ctrl 加选（与表格共用同一份纯函数）
      P.click(cells[0]);
      await P.wait(180);
      const selAfter1 = P.qa('.kbw-gcell.is-selected').length;
      if (selAfter1 !== 1) note('单击之后选中的格数 = ' + selAfter1 + '（应为 1）');
      if (cells[1]) {
        cells[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
        await P.wait(180);
      }
      const selAfter2 = P.qa('.kbw-gcell.is-selected').length;
      if (cells[1] && selAfter2 !== 2) note('Ctrl 加选之后 = ' + selAfter2 + '（应为 2）');
      const clearSel = function () {
        const b = P.qa('.kbw-notes-bar.is-batch button').find(function (x) { return (x.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (b) P.click(b);
      };
      clearSel();
      await P.wait(260);

      // ── 框选起手帧：**第一帧不许带上一次的尺寸**（S4 手机实测的残影 bug）
      // 起点必须落在空白上：取第一行与第二行之间的缝（那里最上面的是 inner，不是格子）
      const rows = cells.map(function (c) { return c.getBoundingClientRect(); });
      const tops = Array.from(new Set(rows.map(function (r) { return Math.round(r.top); }))).sort(function (a, b) { return a - b; });
      if (tops.length < 2) return { ok: false, info: '只有一行格子，框选验不了（窗口太窄？）' };
      const firstRow = rows.filter(function (r) { return Math.round(r.top) === tops[0]; })[0];
      const gapY = Math.round((tops[0] + firstRow.height + tops[1]) / 2);
      const startX = Math.round(rows[0].left + 30);
      const atStart = P.elAt(startX, gapY);
      if (String(atStart && atStart.className || '').indexOf('kbw-gcell') >= 0) {
        return { ok: false, info: '框选起点落在格子上（夹具挑错了）' };
      }

      P.pointerDownAt(startX, gapY, 'mouse');
      await P.wait(20);
      P.pointerMoveTo(startX + 5, gapY + 2, 'mouse');   // 刚过 4px 阈值
      await P.wait(50);
      const mq = P.q('.kbw-marquee');
      let startFrame = null;
      if (mq) {
        const mr = mq.getBoundingClientRect();
        startFrame = [Math.round(mr.left), Math.round(mr.top), Math.round(mr.width), Math.round(mr.height)];
        /**
         * ⚠️ **双边判据**（独立审查 🟡6）：写成"只判上界"的话，窗口不可见时几何量到 0
         * 会**空过**（0 <= 40 恒真）。本项目的老账：几何判据一律双边。
         *
         * ⚠️ 也说清这条**实际**能看见什么：取样点在"按下 → 动 5px → 再等 50ms"之后，
         * 那时选框已按"触点→当前点"正规摆好 —— 所以它抓的是
         * **"尺寸从来没被更新过 / 原点不在触点上"**（例如 place() 整个没被调用、
         * 或复用了上一次那个矩形元素）。"只在第一帧闪一下"那种残影靠的是实现结构
         *（grid.ts 里 place() 在 appendChild **之前**跑完）—— 这条是那个结构不变量的回归守卫。
         */
        if (!(mr.width > 0 && mr.width <= 40 && mr.height > 0 && mr.height <= 40)) {
          note('框选起手帧的尺寸不对（应是个小不点，实际 ' + startFrame.join(',') + '）');
        }
        if (Math.abs(mr.left - startX) > 8 || Math.abs(mr.top - gapY) > 8) note('框选起手的原点不在触点上：' + startFrame.join(','));
      } else {
        note('按下之后没有框选矩形（空白判定或阈值不对）');
      }
      /**
       * ⚠️ 落点要挑**起点下方那一行之后**的格子（探针自己第一版挑了 cells[5]，
       * 而真机上每行有十来格 → cells[5] 还在**第 0 行**，框选实际是**往上**拉的
       * → "起点上方那一行"当然会被圈中。夹具挑错会让判据假红，先按几何挑：
       * 找**第二行的第一个**，再往后两格。）
       */
      const secondRowStart = rows.findIndex(function (r) { return r.top > rows[0].top + rows[0].height; });
      const farIdx = Math.min(cells.length - 1, (secondRowStart < 0 ? 5 : secondRowStart) + 2);
      const far = P.rectAt(cells[farIdx]);
      const farPath = cells[farIdx].dataset.path;
      P.pointerMoveTo(far.x, far.y, 'mouse');
      await P.wait(80);
      const during = P.qa('.kbw-gcell.is-selected').length;
      if (during < 1) note('框选途中没有预览高亮（圈中即选中）');
      P.pointerUpAt(far.x, far.y, 'mouse');
      await P.wait(350);
      const selNow = P.qa('.kbw-gcell.is-selected').map(function (c) { return c.dataset.path; });
      if (selNow.length < 1) note('松手之后没有提交选择');
      if (P.q('.kbw-marquee')) note('松手之后框选矩形没收掉');
      /**
       * 🔴 **逐路径比，不能只数个数**（独立审查 🔴2，突变实测）：
       * 离线那边所有元素同坐标（jsdom 桩）→ 「marqueeHit」 退化成"要么全中要么全不中"，
       * 而探针原来只判 「during >= 1」 —— **"框一个小角却整屏全选"同样满足它**。
       * 真机有真几何，所以这里判三件事：
       *  ① 目标格 「cells[5]」 **在**选中集里；② **第一行那几格不在**（全选会露馅）；
       *  ③ 选中数 < 总数（同上）。
       */
      if (farPath && selNow.indexOf(farPath) < 0) note('框到的那一格（第 6 格）没被选中');
      const topRowPaths = cells.filter(function (c) {
        return Math.round(c.getBoundingClientRect().top) === Math.round(rows[0].top);
      }).map(function (c) { return c.dataset.path; });
      const wrongly = topRowPaths.filter(function (p) { return selNow.indexOf(p) >= 0; });
      if (wrongly.length > 0) note('**起点上方那一行**也被选中了 ' + wrongly.length + ' 格（框选命中算错了？）');
      if (selNow.length >= cells.length) note('整屏都被选中了（框选命中算错了？）');
      const committed = selNow.length;
      clearSel();
      await P.wait(260);

      /**
       * 🔴 **收尾必须把自己的夹具删掉**（P7.15 全量跑抓到）：这一步开头 dropGridDir('网格A')
       * 只是"清上一轮的残留"，**自己没有收尾** —— 于是 __探针网格A 一直留在实验库里
       * （25 篇），而 #2 之后**空目录也会进树**、有笔记的更在树里 → 后面几步的
       * "自清理后不该有 __探针 残留"判据全被它点着（假红一片，真凶在十几步之前）。
       * ⚠️ 别删这条：dropGridDir 是**幂等**的，删了不存在的也不会炸。
       */
      await P.dropGridDir(seedTag);

      return {
        ok: problems.length === 0,
        info: '格子 ' + cells.length + ' 个｜每格 ' + Math.round(r0.width) + 'x' + Math.round(r0.height) + 'px｜' +
              '单击选中 ' + selAfter1 + '、Ctrl 加选 ' + selAfter2 + '｜框选起手帧 ' +
              (startFrame ? startFrame.join(',') : '（无）') + ' → 圈中 ' + during + ' 松手提交 ' + committed +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6-网格.png',
  },

  {
    name: 'P6 · 网格档：拖动换位（让位/顺序落盘）+ 拖到目录树真搬文件（可撤销）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      const KB = ctx.settings.kbRoot();
      const cellPaths = () => P.qa('.kbw-gcell[data-path]').map(function (c) { return c.dataset.path; });
      P.closeAll(4);
      await P.wait(400);

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(700); }
      // 同一条开场：把视野摆成"全库 + 无搜索 + 无筛选 + 网格档"
      await P.scopeAll();
      /**
       * ⚠️ **P6b ② 起列表只画本层** —— 库根那一层常常一篇都没有 → 网格里一格都没有。
       * 先站进一个"本层笔记最多"的顶层目录，再摆回网格档。
       */
      const levelByDir = {};
      ctx.index.notes().forEach(function (e) {
        const d = e.effectivePosition;
        if (!d || d.indexOf('/') >= 0) return;
        levelByDir[d] = (levelByDir[d] || 0) + 1;
      });
      /**
       * 🔴 **自造一个够大的目录**（这条要验拖动换位，格子太少前提就不成立）——
       * 靠实验库当时的形态去挑是"依赖环境状态"（实测：同一份脚本前后两轮挑到的目录不一样）。
       */
      await P.dropGridDir('网格B');
      const dragSeed = await P.seedGridDir('网格B', 6);
      const segGrid = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '网格'; });
      if (segGrid) { P.click(segGrid); await P.wait(700); }
      const dirNode = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dragSeed; });
      if (dirNode) { P.click(dirNode); await P.wait(1000); }
      if (!P.q('.kbw-grid')) return { ok: false, info: '没进网格档' };

      // ── 拖动换位：把第一格拖到第三格右边
      const before = cellPaths();
      if (before.length < 4) return { ok: false, info: '格子太少，换位验不了（' + before.length + '）' };
      /**
       * ⚠️ **只取笔记格**：P6 段② B3 起网格里还有文件夹格（kbw-gcell is-folder，
       * 没有 data-path）。不排掉的话 cells[0] 会是文件夹 —— 后面"每格刻度/单击选中/
       * 大小那一行"全是对着一个文件夹量的（离线用例同样栽过这一跤）。
       */
      const cells = P.qa('.kbw-gcell[data-path]');
      const src = P.aimAt(cells[0]);
      const dst = P.rectAt(cells[2]);
      if (!src || !src.visible || !dst || !dst.visible) return { ok: false, info: '拖动源/目标不在视野里' };
      P.pointerDownAt(src.x, src.y, 'mouse');
      await P.wait(30);
      P.pointerMoveTo(src.x + 20, src.y, 'mouse');   // 过 4px 阈值
      await P.wait(70);
      const floated = !!P.q('.kbw-gfloat') || !!P.q('.kbw-dragghost');
      if (!floated) note('进入拖动之后没有浮标/浮起态');
      const gapSeen = !!P.q('.kbw-gap');
      if (!gapSeen) note('拖动中没有"空出来的位置"（让位的落点看不见）');
      P.pointerMoveTo(dst.x + 60, dst.y, 'mouse');
      await P.wait(100);
      P.pointerUpAt(dst.x + 60, dst.y, 'mouse');
      await P.wait(500);

      const after = cellPaths();
      if (after.join('|') === before.join('|')) note('拖完之后顺序没变（拖了个寂寞）');
      if (after.length !== before.length) note('拖完之后格子数变了：' + before.length + ' → ' + after.length);
      /**
       * 🔴 **落点要判位置**（独立审查 🔴3，突变实测）：原来只判"顺序变了没"，
       * 而"落点永远在末尾"（「insertionIndexAt」 直接返回 boxes.length）同样让它变 ——
       * 拖到第三格右边、东西却飞到末尾，判据照样绿。
       * 源点与目标点都是我们自己算的（第一格 → 第三格右侧），落点区间是已知的。
       */
      const at = after.indexOf(before[0]);
      if (after.length === before.length && !(at >= 1 && at <= 4)) {
        note('落点不对：拖到第 3 格右边，却排在第 ' + (at + 1) + ' 位（期望 2–5 位之间）');
      }
      const chk = P.q('.kbw-sortbar .kbw-chk');
      const chkOn = !!(chk && chk.classList.contains('is-on'));
      if (chkOn) note('拖完「自动排列」还勾着（顺序会被排序规则顶回去）');
      // 顺序表落盘（data.json 的 gridOrder）—— 防抖 400ms，等一等
      await P.wait(700);
      const order = ctx.settings.get().gridOrder || [];
      if (order.length === 0) note('顺序表没落盘（gridOrder 还是空的）');
      else if (order.indexOf(before[0]) < 0) note('顺序表里找不到被拖的那一篇');

      // ── 拖到左侧目录节点 = 搬文件（走 mover）
      /**
       * 🔴 **源格自造**（别按"这一层里正好有一篇 00_Inbox 的笔记"去找）。
       * 老写法是「data-path 含 /00_Inbox/」—— 而 P6b ② 起列表**只画本层**，本层是自造的
       * __探针网格B，那条一个都命中不了 → **整段静默跳过、这一步照样报"全部通过"**
       * （最后一轮真机实测：info 里写着「没有 00_Inbox 的笔记可拖」而状态是 PASS）。
       * 自造的那篇**名字带 __探针**：这一档真的会动库（搬过去 + 撤销搬回来），
       * 万一撤销没成，兜底清场按名字标记能把它收走 —— 用种子目录里的「笔记N.md」就不会被认出来。
       */
      let treeResult = '（拖拽那一档没跑成）';
      const moveRel = dragSeed + '/__探针网格迁.md';
      if (!app.vault.getAbstractFileByPath(KB + '/' + moveRel)) {
        const NL2 = String.fromCharCode(10);
        await app.vault.create(KB + '/' + moveRel, ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中',
          '创建日期: 2026-09-27', 'tags: []', '---', '# 网格迁'].join(NL2) + NL2);
      }
      let boxed = null;
      for (let i = 0; i < 20; i += 1) {
        await P.wait(250);
        boxed = P.qa('.kbw-gcell[data-path]').find(function (c) { return String(c.dataset.path || '').indexOf('__探针网格迁') >= 0; });
        if (boxed) break;
      }
      const inboxBefore = boxed ? boxed.dataset.path : null;
      if (!boxed) note('这一层里等不到 __探针网格迁 那格（拖到目录树那一档没跑成）');
      if (boxed && inboxBefore) {
        // 展开 02_Areas（**已经展开就别再点** —— 会收起）
        const areas = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === '02_Areas'; });
        if (areas) {
          const caret = areas.querySelector('.kbw-tree-caret');
          if (caret && !caret.classList.contains('is-open')) { P.click(caret); await P.wait(350); }
        }
        const node = P.qa('.kbw-tree-item[data-drop]').find(function (n) { return String(n.dataset.drop || '').slice(-4) === '内容创作'; });
        const cA = P.aimAt(boxed);
        const cB = node ? P.rectAt(node) : null;
        if (cA && cA.visible && cB && cB.visible) {
          P.pointerDownAt(cA.x, cA.y, 'mouse');
          await P.wait(30);
          P.pointerMoveTo(cA.x + 20, cA.y, 'mouse');
          await P.wait(70);
          P.pointerMoveTo(cB.x, cB.y, 'mouse');
          await P.wait(150);
          const hot = !!P.q('.kbw-tree-item.is-drop');
          P.pointerUpAt(cB.x, cB.y, 'mouse');
          await P.wait(1600);
          const nm = String(inboxBefore).split('/').pop();
          const inTarget = await app.vault.adapter.exists(KB + '/02_Areas/内容创作/' + nm);
          if (!inTarget) note('拖到目录树之后文件没搬过去：' + nm);
          if (!hot) note('掠过目录节点时没有高亮（§3.1）');
          treeResult = nm + ' → 内容创作 ' + (inTarget ? '✓' : '✗') + '（掠过高亮 ' + (hot ? '有' : '无') + '）';
          const undo = P.qa('.kbw-undobar button, .kbw-undobar .kbw-btn').find(function (b) { return P.text(b).indexOf('撤销') >= 0; });
          if (undo) {
            P.click(undo);
            await P.wait(1800);
            const back = await app.vault.adapter.exists(String(inboxBefore));
            if (!back) note('撤销没能把文件放回原位');
            treeResult += '｜撤销 ' + (back ? '回到原位 ✓' : '没回来 ✗');
          } else {
            note('拖拽之后没有撤销条');
          }
        } else {
          note('拖到目录树那一档没跑成（源或目标不在视野里）');
        }
      }

      /**
       * ⚠️ **收尾**（P7.15 全量跑抓到同一族）：与本步开头的 dropGridDir('网格B') 配成对 ——
       * 只清不删的话夹具会留在库里，后面的"自清理后不该有 __探针 残留"判据全被它点着。
       */
      await P.dropGridDir('网格B');

      return {
        ok: problems.length === 0,
        info: '第一格 ' + before[0] + ' → 现在排第 ' + (after.indexOf(before[0]) + 1) + '/' + after.length +
              '｜自动排列取消 ' + (chkOn ? '✗' : '✓') + '｜顺序表 ' + order.length + ' 项｜' + treeResult +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6-网格拖动.png',
  },

  // ══════════════════════════════════════════════════════════════
  // P6 ② 图谱（交互规格 §5）—— 「过滤真的生效」只有真机能证
  // ══════════════════════════════════════════════════════════════
  {
    name: 'P6 · 图谱：挂载 + 过滤**真把节点数打下去** + 卸载不留悬挂 + graph.json 一字节没动',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const sha = async (path) => {
        const text = await app.vault.adapter.read(path);
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      };
      const cfgPath = app.vault.configDir + '/graph.json';
      /**
       * ⚠️ **别用"数页面的 rAF"来判"图谱的渲染循环停没停"**（第一版就是这么写的，**恒绿**）：
       * 自己排一条 rAF 链去数帧，量到的是**整页的帧率**，跟图谱跑不跑没有半点关系 ——
       * 挂载中 98、切走后还是 98（实测），看起来像"没停"，其实什么都没测。
       * 真实信号是**图谱渲染器自己的空闲帧计数**：循环在跑它就在涨，detach 之后不涨。
       */
      const countRaf = () => 0;
      /** 采样图谱渲染器的空闲帧（它自己那个循环的计数器） */
      const idleOf = (v) => (v && v.renderer && typeof v.renderer.idleFrames === 'number' ? v.renderer.idleFrames : null);
      const deltaIdle = async (v, ms) => {
        const a = idleOf(v);
        if (a == null) return null;
        await P.wait(ms);
        const b = idleOf(v);
        return b == null ? null : b - a;
      };

      P.closeAll(4);
      await P.wait(400);
      let cfgBefore = null;
      try { cfgBefore = await sha(cfgPath); } catch (e) { cfgBefore = null; }

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('图谱') >= 0; });
      if (!nav) return { ok: false, info: '导航里没有「图谱」' };
      P.click(nav);
      await P.wait(3200);   // 等视图 load + 搜索队列跑完

      const stage = P.q('.kbw-graph-stage');
      if (!stage) return { ok: false, info: '图谱宿主没画出来' };
      const canvas = P.q('.kbw-graph-stage canvas');
      if (!canvas) return { ok: false, info: 'canvas 没挂进来（挂载失败？）' };
      const cr = canvas.getBoundingClientRect();
      // 双边判据：不可见窗口下几何会是 0 —— 只写上界会假绿
      if (!(cr.width > 0 && cr.height > 0)) note('canvas 尺寸是 ' + Math.round(cr.width) + 'x' + Math.round(cr.height));

      // 自带的导航条要藏掉（认 computed style，不认"有没有这个元素"）
      const header = P.q('.kbw-graph-stage .view-header');
      const headerShown = header ? getComputedStyle(header).display !== 'none' : false;
      if (headerShown) note('.view-header 还看得见（工作台里那排死按钮没藏掉）');
      /**
       * 🔴 作用域：只许命中我们自己那个宿主 —— **用户手动打开的官方图谱标签不许被连带**
       *（排查报告 #53：图谱 leaf 的 data-type 就是 graph，按它写就会打到别人）。
       * 判据落在"工作台外那个图谱视图的 header 还看得见"上，而不是数全局 header 的个数。
       */
      const outsideGraphs = P.qa('.workspace-leaf-content[data-type="graph"]').filter(function (h) {
        return !h.closest('.kbw-graph');
      });
      const leaked = outsideGraphs.filter(function (h) {
        const hd = h.querySelector('.view-header');
        return hd && getComputedStyle(hd).display === 'none';
      }).length;
      if (leaked > 0) note('工作台外的 ' + leaked + ' 个官方图谱被我们的 CSS 连带藏掉了 header');

      // ── 过滤真的生效了吗（**只有真机能证**：桩只记录查询串、不跑真匹配）
      let filterInfo = '（拿不到视图实例）';
      let total = -1, oldKb = -1, logs = -1;
      const v = stage.kbwGraphView;
      if (v && v.dataEngine) {
        const de = v.dataEngine;
        // searchQueries 里存的是**解析后的查询对象**（setQuery 内部 new 了一个解析器），
        // 直接 String() 会印成 [object Object] —— 挑几个可能的字符串字段展示
        const qo = (de.searchQueries && de.searchQueries[0] && de.searchQueries[0].query) || null;
        const q = (qo && (qo.query || qo.source || qo.raw)) || (typeof qo === 'string' ? qo : '');
        const nodes = (v.renderer && v.renderer.nodes) || [];
        total = nodes.length;
        oldKb = nodes.filter(function (n) { return String(n.id || '').indexOf('02_旧知识库') >= 0; }).length;
        logs = nodes.filter(function (n) { return String(n.id || '').indexOf('05_操作日志') >= 0; }).length;
        filterInfo = 'hasFilter=' + de.hasFilter + '，查询=' + (String(q).slice(0, 70) || '（解析后对象，形状 ' + (qo ? qo.constructor.name : 'null') + '）');
        if (!de.hasFilter) note('过滤没注入（hasFilter 是 false）');
        if (oldKb !== 0) note('图上还有 ' + oldKb + ' 个「02_旧知识库」节点（过滤没生效）');
        if (logs !== 0) note('图上还有 ' + logs + ' 个操作日志节点');
        if (!(total > 0)) note('图上节点数是 ' + total);
      } else {
        note('拿不到图谱视图实例（注入是否生效无法判）');
      }

      const idleMounted = await deltaIdle(v, 900);

      // ── 切走 → 卸载干净
      const home = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (home) { P.click(home); await P.wait(1300); }
      if (P.q('.kbw-graph-stage')) note('切走之后图谱宿主还在');
      if (P.q('.kbw-graph-stage canvas')) note('切走之后 canvas 还在（没 detach）');
      if (app.workspace.getLeavesOfType('graph').length !== 0) note('工作区里还留着图谱叶');
      // 宿主元素要真的离开文档（不只是被移走）
      if (v && v.containerEl && v.containerEl.isConnected) note('切走之后图谱的 containerEl 还连着文档');
      /**
       * 🔴 **这一条才是"detach 真被调了"的主判据**（独立审查 🟡7）：
       * 上面那三条 DOM 判据在"容器被 removeChild、但没调 detach()"这个失败形态下**全绿**
       *（「containerEl」 是 stage 的后代，stage 随区域重绘一起没了）。
       * 「_loaded」 只有 unload() 会翻成 false —— 而 detach() 内部就会走到它。
       * 它**不依赖出帧**，最小化的窗口下照样成立。
       */
      if (v && typeof v._loaded === 'boolean' && v._loaded) note('切走之后视图的 _loaded 还是 true（没 unload ⟹ detach 没真跑）');
      const idleAfter = await deltaIdle(v, 900);
      /**
       * "渲染循环真停"的判据：**图谱渲染器自己的空闲帧计数停止增长**（挂载中应在涨 → 切走后不涨）。
       * ⚠️ 两个前提不成立时**不当判据用**（只报数）：
       *  ① 拿不到 「renderer.idleFrames」（字段改名了 / 版本不同）；
       *  ② 挂载中它本来就没涨（窗口不可见时不产帧）——此时"切走后也没涨"什么都没证明。
       */
      const idleValid = idleMounted != null && idleMounted > 0;
      if (idleValid && idleAfter != null && idleAfter > 0) {
        note('切走之后图谱的渲染循环还在跑（空闲帧又涨了 ' + idleAfter + '）');
      }

      /**
       * ── graph.json 一字节不许动（用户 2026-09-27 拍板：程序化注入，不写文件）
       *
       * ⚠️ **sha 判据有两种"绿"要分清**（独立审查 🟢1）：读不到文件时两次都是 「null」
       * → 「cfgTouched」 恒 false → 与"真没动"**同一条文案**。所以：
       *  ① 读失败单独说一句（别混进"没动 ✓"）；
       *  ② **再加一条落到内容上的判据** —— 我们的过滤串如果被写进去，
       *     那份 JSON 的 「search」 就不可能是空的。这条比 sha **指向更明确**。
       */
      let cfgAfter = null;
      let readFail = '';
      try { cfgAfter = await sha(cfgPath); } catch (e) { readFail = String((e && e.message) || e).slice(0, 80); }
      const cfgTouched = cfgBefore != null && cfgAfter != null && cfgBefore !== cfgAfter;
      if (cfgTouched) note('graph.json **被改了**（我们的注入写盘了）');
      if (cfgBefore == null || cfgAfter == null) note('graph.json 读不到（' + readFail + '）→ sha 那条判据这次没跑成');
      let searchKey = '（读不到）';
      try {
        const raw = await app.vault.adapter.read(cfgPath);
        searchKey = JSON.stringify(JSON.parse(raw).search);
        if (JSON.parse(raw).search !== '') note('graph.json 的 search 非空（' + searchKey + '）—— 我们的过滤被写进文件了');
      } catch (e) {
        searchKey = '（读不到）';
      }

      /**
       * 收尾 ①：**把 P6 动过的界面偏好还回去**（顺序表 / 自动排列 / 排序 / 视图档）。
       * 不还的话，下一轮探针的「P1 · 全部笔记」会看到一张没有行的表格
       *（实测：视图档停在网格 → 那一步整片假红，而失败点看着与网格毫无关系）。
       */
      const saved = window.__p6saved;
      if (saved) {
        await P.ctx().settings.save({
          notesView: saved.notesView,
          gridOrder: saved.gridOrder,
          gridAutoArrange: saved.gridAutoArrange,
          gridSort: saved.gridSort,
          treeSelected: saved.treeSelected,
        });
        window.__p6saved = null;
      }
      const notes = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (notes) {
        P.click(notes);
        await P.wait(700);
        // 档位由 settings 决定，但 store 里存的是启动那一刻的值 → 点一下让它重新按配置解析
        const seg = (label) => P.qa('.kbw-seg button').find(function (b) { return P.text(b) === label; });
        // P7.1 两档化：存着的只可能是 detail / grid / null
        const target = saved && saved.notesView === 'grid' ? seg('网格') : seg('详细信息');
        if (target && !target.classList.contains('is-on')) { P.click(target); await P.wait(400); }
      }
      /**
       * 收尾 ②：**最后留回「图谱」**——截图是脚本返回**之后**才拍的，
       * 收尾要是把界面切走了，拍到的就是别的屏（第一版就是这么拿到一张表格的）。
       * 各步骤开头都会自己导航，所以留在这儿不影响下一步。
       */
      P.click(nav);
      await P.wait(2000);
      void countRaf;

      return {
        ok: problems.length === 0,
        info: 'canvas ' + Math.round(cr.width) + 'x' + Math.round(cr.height) +
              '｜header 藏掉 ' + (headerShown ? '✗' : '✓') + '（工作台外的图谱 ' + outsideGraphs.length + ' 个，被连带 ' + leaked + '）｜' +
              '图上节点 ' + total + '（旧库 ' + oldKb + ' · 日志 ' + logs + '）｜' + filterInfo +
              '｜空闲帧 挂载中 +' + idleMounted + ' → 切走后 +' + idleAfter + (idleValid ? '' : '（拿不到/没在跑，只当参考）') +
              '｜graph.json ' + (cfgTouched ? '被改了 ✗' : cfgAfter == null ? '读不到 ⚠️' : '没动 ✓') +
              '（search=' + searchKey + '）' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6-图谱.png',
  },
  // ════════════════════════════════════════════════════════════
  // P6 段② · 整体优化（用户 2026-09-27 真机体验后的 9 条）
  // 判据一律"按身份/精确值"，不数数量（段① 的血账）；动库那两步要**验收回收尾**。
  // ════════════════════════════════════════════════════════════
  {
    name: 'P6② · A1 新建笔记「不使用模板」：下拉第一项且默认 · 落盘 = 前言 + 尾链、正文留空',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      // 走**真入口**：首页＋新建笔记（与用户点那个按钮同一个对话框）
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (nav) { P.click(nav); await P.wait(700); }
      const plus = P.qa('.kbw-quickrow button').find(function (b) { return P.text(b).indexOf('新建笔记') >= 0; });
      if (!plus) return { ok: false, info: '首页没有「新建笔记」' };
      P.click(plus);
      await P.wait(700);
      const modal = P.lastModal();
      if (!modal) return { ok: false, info: '新建对话框没开出来' };

      const selects = Array.from(modal.querySelectorAll('select.kbw-select'));
      const tplSel = selects.find(function (s) {
        return ((s.options[0] && s.options[0].textContent) || '').indexOf('不使用模板') >= 0;
      });
      if (!tplSel) return { ok: false, info: '模板下拉里没有「不使用模板」这一项' };
      if (tplSel.options[0] !== tplSel.options[tplSel.selectedIndex]) note('默认选中的不是第一项');
      if (tplSel.value !== '') note('第一项的值不是空串（值=' + JSON.stringify(tplSel.value) + '）');

      // 换一次落点 → 下拉整块重画，第一项与默认选中都不许丢
      const dirSel = selects.find(function (s) { return s !== tplSel; });
      if (dirSel && dirSel.options.length > 1) {
        dirSel.selectedIndex = dirSel.options.length - 1;
        dirSel.dispatchEvent(new Event('change', { bubbles: true }));
        await P.wait(500);
        if (tplSel.options[0] !== tplSel.options[tplSel.selectedIndex]) note('换落点之后默认项被顶掉了');
      }

      /**
       * ⚠️ 造之前把落点**拨回 00_Inbox**：上面那一步把 selectedIndex 拨到了最后一个目录
       * （那往往就是 99_Meta/06_工作台 —— 探针不该往配置目录里造笔记）。
       */
      const inboxOpt = Array.from(dirSel.options).find(function (o) { return o.value === '00_Inbox'; });
      if (inboxOpt) {
        dirSel.value = '00_Inbox';
        dirSel.dispatchEvent(new Event('change', { bubbles: true }));
        await P.wait(500);
      }
      // 造一篇：文件名带 __探针 标记（自清理靠它认）
      const title = '__探针A1不用模板';
      const titleInput = modal.querySelector('input.kbw-input');
      titleInput.value = title;
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      const createBtn = Array.from(modal.querySelectorAll('.kbw-modal-foot button'))
        .find(function (b) { return P.text(b).indexOf('新建') >= 0; });
      if (!createBtn) return { ok: false, info: '找不到「新建」按钮' };
      P.click(createBtn);
      await P.wait(1800);

      const dirRel = dirSel ? dirSel.value : '00_Inbox';
      const path = (dirRel ? KB + '/' + dirRel : KB) + '/' + title + '.md';
      const f = app.vault.getAbstractFileByPath(path);
      if (!f) return { ok: false, info: '没建成（没找到 ' + path + '）' };
      const text = await app.vault.read(f);
      if (text.length === 0) note('落的是空文件（那是"交给 Templater"那条路，不是"不使用模板"）');
      if (text.indexOf('---') !== 0) note('开头不是前言');
      if (text.indexOf('创建日期') < 0) note('前言里没有 创建日期');
      if (text.indexOf('## 关联笔记') < 0) note('没补尾部双链');
      if (text.indexOf('<%') >= 0) note('正文里进了模板语法');
      const headEnd = text.indexOf('---\\n');
      const headEnd2 = text.indexOf('\\n---\\n');
      const tailAt = text.indexOf('## 关联笔记');
      const mid = (headEnd2 > 0 && tailAt > headEnd2) ? text.slice(headEnd2 + 5, tailAt).trim() : '(形状不对)';
      if (mid !== '') note('前言与尾链之间还有东西：' + JSON.stringify(mid.slice(0, 40)));
      void headEnd;

      await app.vault.delete(f, true);
      await P.wait(600);
      const gone = !app.vault.getAbstractFileByPath(path);
      if (!gone) note('自造的临时笔记没删掉（留在库里了）');

      return {
        ok: problems.length === 0,
        info: '第一项 = ' + JSON.stringify(tplSel.options[0].textContent) + '｜默认选中 = ' + (tplSel.value === '') +
              '｜落点 ' + dirRel + '｜落盘 ' + text.length + ' 字｜前言与尾链之间 ' + JSON.stringify(mid.slice(0, 20)) +
              '｜清理=' + gone +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P6② · A2 一键自动整理收件箱：二级选择 → 确认流 → 真搬 + 补「文件位置」→ 还原逐字节',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const INBOX = KB + '/00_Inbox';
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const hash = (t) => { let h = 0; for (let i = 0; i < t.length; i += 1) { h = (h * 31 + t.charCodeAt(i)) | 0; } return h + ':' + t.length; };
      /**
       * 🔴 **快照要覆盖全库**（P6② 独立审查 B 路 §4.1）：只看 "00_Inbox" 一层的话，
       * "一键整理顺手把别处也搬了"这件事**它看不见** —— 而那正是用户原话里点名的一半。
       * 排除两类必然变动的：① 操作日志（这一轮会写一条）② 库内配置（看板/自动化/库结构）。
       */
      const SNAP_SKIP = ['/99_Meta/05_操作日志/', '/99_Meta/06_工作台/'];
      const snapshotAll = async () => {
        const out = {};
        for (const f of app.vault.getMarkdownFiles()) {
          const p = f.path;
          if (p.indexOf(KB + '/') !== 0) continue;
          if (SNAP_SKIP.some(function (x) { return p.indexOf(x) >= 0; })) continue;
          out[p] = hash(await app.vault.read(f));
        }
        return out;
      };
      const name = '__探针A2有领域';
      const src = INBOX + '/' + name + '.md';
      const old = app.vault.getAbstractFileByPath(src);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(src, '---\\n领域: 灵感杂记\\ntags: []\\n---\\n\\n探针造的，用完会删。\\n');
      await P.wait(1000);
      /**
       * ⚠️ 基准要在**造完夹具之后**取：先取基准的话，"撤销把这一篇还原回 Inbox"
       * 会被算成"库变了"（第一版就是这么假红的 —— 差额 +1 正是我自己造的那一篇）。
       */
      const before = await snapshotAll();
      const logsBefore = (await ctx.report.recent(200)).map(function (f) { return f.path; });
      const snapsBeforeIds = (await ctx.snapshot.list()).map(function (sn) { return sn.id; });
      /**
       * ⚠️ P7.12 收尾（真机抓到）：#9/#11 起「一键自动整理」= **AI 预整理并入一次确认** ——
       * 配了 AI 的库上点击会先跑一轮「proposeLocus」（真实模型调用，秒级起步），确认流在它之后才弹
       *（旧步只等 1.2s → 假红"没弹确认流"，还会把后续十几步的节奏一起带崩）。
       * 给它一个**确定性桩**（与离线用例同形状：fed/items 全空）——不碰网络、确认流立即弹；
       * 本步验的还是"确认流 → 真搬 → 补「文件位置」→ 撤销还原"这条链（AI 出值那条在离线判据里）。
       */
      const aiLocus0 = ctx.ai.proposeLocus.bind(ctx.ai);
      ctx.ai.proposeLocus = async function () { return { fed: [], items: [] }; };
      const restoreAiLocus = () => { ctx.ai.proposeLocus = aiLocus0; };

      // ── 真入口：首页「整理收件箱」→ 二级选择 → 一键自动整理
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const quick = P.qa('.kbw-quickrow button').find(function (b) { return P.text(b).indexOf('整理收件箱') >= 0; });
      if (!quick) return { ok: false, info: '首页没有「整理收件箱」' };
      P.click(quick);
      await P.wait(600);
      const menu = P.lastMenu();
      if (!menu) return { ok: false, info: '没弹二级选择菜单' };
      const labels = P.qa('.kbw-menu-item').map(function (i) { return P.text(i); }).join(' | ');
      if (labels.indexOf('去全部笔记自己整理') < 0) note('二级菜单里没有「去全部笔记自己整理」');
      if (labels.indexOf('一键自动整理') < 0) note('二级菜单里没有「一键自动整理」');
      if (P.text(menu).indexOf('作用范围') < 0) note('菜单缺作用域行');
      const oneClick = P.qa('.kbw-menu-item').find(function (i) { return P.text(i).indexOf('一键自动整理') >= 0; });
      if (!oneClick) return { ok: false, info: '点不到「一键自动整理」' };
      P.click(oneClick);
      // 轮询等确认流（桩在的情况下一两拍就弹；上限 10s 兜真机偶发慢帧）
      let confirmModal = null;
      for (let i = 0; i < 40 && !confirmModal; i += 1) { await P.wait(250); confirmModal = P.lastModal(); }
      if (!confirmModal) { restoreAiLocus(); return { ok: false, info: '没弹确认流' }; }
      const ctext = P.text(confirmModal);
      if (ctext.indexOf('整理收件箱') < 0) note('确认流标题没写清动作');
      if (ctext.indexOf(name) < 0) note('确认流里没逐条列出那一篇');
      const primary = Array.from(confirmModal.querySelectorAll('.kbw-modal-foot button'))
        .find(function (b) { return b.classList.contains('is-primary'); });
      if (!primary) { restoreAiLocus(); return { ok: false, info: '确认流没有主按钮' }; }
      P.click(primary);
      await P.wait(2200);

      /**
       * ⚠️ P7.12（v2）：落点**不再可预判** —— 路由含兜底 + "**学你过往的修正**"
       *（沙盒有大量探针搬动史），同一夹具历轮落点会变（实测过 02_Areas 与
       * 02_Areas/内容创作 两处）。按"它现在在哪"对账：搬出 Inbox，落在哪、声明写哪；
       * 失败时把实际位置一并报出来（现场自诊断）。
       */
      const found = app.vault.getMarkdownFiles().filter((f) => f.basename === name);
      const movedFile = found.find((f) => f.path !== src) || null;
      if (!movedFile) note('没搬走（它现在在：' + (found.map((f) => f.path).join('、') || '（找不到——可能没被搬过）') + '）');
      if (app.vault.getAbstractFileByPath(src)) note('原位还在（没搬走）');
      let fmOk = false;
      if (movedFile) {
        const t = await app.vault.read(movedFile);
        const destDir = movedFile.path.slice(KB.length + 1, movedFile.path.lastIndexOf('/'));
        fmOk = t.indexOf('文件位置') >= 0 && t.indexOf(destDir) >= 0;
        if (!fmOk) note('被搬笔记的「文件位置」没补成落点（应在 ' + destDir + '）');
      }

      // 撤销：优先走**撤销条**（真入口）；没有就用最新一份快照还原
      let undoHow = '快照'
      const undoBtn = P.qa('.kbw-undo button, .kbw-undobar button, .kbw-undo-bar button')
        .find(function (b) { return P.text(b).indexOf('撤销') >= 0; });
      if (undoBtn) {
        undoHow = '撤销条';
        P.click(undoBtn);
        await P.wait(2200);
      } else {
        const snaps = await ctx.snapshot.list();
        if (snaps.length > 0) await ctx.snapshot.restore(snaps[0].id);
        await P.wait(1800);
      }
      const after = await snapshotAll();
      const keysSame = JSON.stringify(Object.keys(after).sort()) === JSON.stringify(Object.keys(before).sort());
      const onlyAfter = Object.keys(after).filter(function (k) { return !(k in before); });
      const onlyBefore = Object.keys(before).filter(function (k) { return !(k in after); });
      if (!keysSame) {
        note('还原之后**全库**的文件集合与跑之前不一样（多了 ' + JSON.stringify(onlyAfter) +
             '，少了 ' + JSON.stringify(onlyBefore) + '）');
      }
      let bytesSame = true;
      for (const k of Object.keys(before)) {
        if (after[k] !== before[k]) { bytesSame = false; note('还原之后内容变了：' + k); }
      }
      const backFiled = !!app.vault.getAbstractFileByPath(src);

      // ── 清场：自造的笔记 + 它的快照
      // ⚠️ v2 起落点不可预判（want 没了）—— 按名字全库扫着清（src + 它可能落到的任何地方）
      for (const f of app.vault.getMarkdownFiles().filter((x) => x.basename === name)) {
        await app.vault.delete(f, true);
      }
      await P.wait(800);
      /**
       * 本步自己造的东西自己带走：
       *  · 日志按**差集**删（跑之前那份清单之外的才是这一轮写的）；
       *  · 快照删除**吞掉错误** —— 探针收尾还有一套按标记的兜底清场，两边都删会撞 ENOENT
       *    （第一版就是这么在"插件内部报错"里挂了一条，整轮判红）。
       */
      const logsAfter = (await ctx.report.recent(200)).map(function (f) { return f.path; });
      for (const p of logsAfter) {
        if (logsBefore.indexOf(p) >= 0) continue;
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      const snaps2 = await ctx.snapshot.list();
      for (const sn of snaps2) {
        if (!sn.id) continue;
        /**
         * 只删**本步之后新出现的**那一份（按 id 与跑之前那份清单比）——
         * 无脑全删会连"别人上一轮留下的"一起删，而那正是"删快照 ENOENT"的来源。
         */
        if (snapsBeforeIds.indexOf(sn.id) >= 0) continue;
        try {
          await ctx.snapshot.remove(sn.id);
        } catch (e) {
          void e;
        }
      }

      restoreAiLocus();
      return {
        ok: problems.length === 0 && !!movedFile && fmOk && keysSame && bytesSame,
        info: '搬到 02_Areas（兜底）=' + !!movedFile + '｜「文件位置」补上=' + fmOk +
              '｜撤销走' + undoHow + '｜回到起点（集合=' + keysSame + ' 逐字节=' + bytesSame +
              ' 差额=+' + onlyAfter.length + '/-' + onlyBefore.length + ' ' + JSON.stringify(onlyAfter.concat(onlyBefore).slice(0, 4)) + '）｜回位=' + backFiled +
              '｜二级选择 = ' + labels +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-A2-整理收件箱.png',
  },
  {
    name: 'P6② · A3 跳转之后有「还原显示」：清筛选 + 清预选中，回到原来那批（逐路径比）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const rowPaths = () => P.qa('.kbw-trow').map(function (r) { return r.dataset.path; });
      /**
       * ⚠️ **进场那一档视图要还回去**："P.scopeAll()" 会把视图切到网格（它是给网格那些步骤用的），
       * 而视图档是**落盘的** —— 上一轮就是这么把库留在网格档上的：下一轮开跑时
       * 「样式 / 确认流 / 危险态 / P1」看到一张没有行的表格（全片假红，失败点看着跟本步毫无关系）。
       */
      const view0 = P.ctx().settings.get().notesView;

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      await P.scopeAll();
      const segDetail = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '详细信息'; });
      if (segDetail) { P.click(segDetail); await P.wait(600); }
      const batch = P.q('.kbw-notes-bar.is-batch');
      if (batch) {
        const x = Array.from(batch.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x) { P.click(x); await P.wait(500); }
      }
      /**
       * ⚠️ **把上一次跳转留下的筛选清干净**（会话里"待消费的意图"会在模块重挂时再放一遍，
       * 上面 scopeAll 清不掉它）—— 不清的话这一屏只剩一篇（实测：前几行只有一个日志文件），
       * 判据的前提"这个目录下不止两篇"直接不成立。
       */
      const rst0 = P.qa('.kbw-batch-tail .kbw-btn, .kbw-notes-tools .kbw-btn')
        .find(function (b) { return P.text(b).trim() === '还原'; });
      if (rst0) { P.click(rst0); await P.wait(700); }
      /**
       * ⚠️ **P6b ② 起列表只画本层** —— 库根那一层常常一篇都没有（笔记都在子目录里）。
       * 这些步骤原来点「整个知识库」就以为能看到全库，现在得**先站进一个有笔记的目录**。
       * 挑法：从索引里取"顶层、且本层笔记最多"的那个目录。
       */
      const levelByDir = {};
      ctx.index.notes().forEach(function (e) {
        const d = e.effectivePosition;
        if (!d || d.indexOf('/') >= 0) return;
        levelByDir[d] = (levelByDir[d] || 0) + 1;
      });
      const topDir = Object.keys(levelByDir).sort(function (a, b) { return levelByDir[b] - levelByDir[a]; })[0];
      const dirNode = topDir ? P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === topDir; }) : null;
      if (dirNode) { P.click(dirNode); await P.wait(900); }
      const before = rowPaths();
      if (before.length < 2) {
        const searchEl = P.q('.kbw-search');
        const fbtn = P.qa('.kbw-notes-tools .kbw-btn').find(function (b) { return P.text(b).indexOf('筛选') >= 0; });
        return {
          ok: false,
          info: '当前目录下不足两篇，判据前提不成立（' + before.length + '）｜搜索=' +
                JSON.stringify(searchEl ? searchEl.value : '(没有搜索框)') +
                '｜筛选按钮=' + JSON.stringify(fbtn ? P.text(fbtn) : '(没有)') +
                '｜工具条=' + JSON.stringify(P.text(P.q('.kbw-notes-bar') || document.body).slice(0, 60)) +
                '｜前几行=' + JSON.stringify(before.slice(0, 3)),
        };
      }

      const all = ctx.index.notes();
      const pick = all.find(function (e) { return before.indexOf(e.path) < 0; }) || all[0];
      // 真入口：快速切换 / 首页待处理走的都是 goNotes 意图
      ctx.goNotes({ paths: [pick.path], selectPaths: [pick.path] });
      await P.wait(1000);

      const jumped = rowPaths();
      if (jumped.length !== 1 || jumped[0] !== pick.path) note('跳转的筛选没生效（只列这一篇）：' + jumped.length);
      const restoreBtn = () => P.qa('.kbw-batch-tail .kbw-btn, .kbw-notes-tools .kbw-btn')
        .find(function (b) { return P.text(b).trim() === '还原'; });
      if (!restoreBtn()) note('批量栏上没有「还原」（P6b ① 起文案从「还原显示」改成「还原」）');
      const selN = P.qa('.kbw-trow.is-selected').length;
      if (selN !== 1) note('预选中没生效（选中 ' + selN + ' 篇）');
      if (restoreBtn()) {
        P.click(restoreBtn());
        await P.wait(900);
      }
      const after = rowPaths();
      if (after.join(',') !== before.join(',')) note('还原之后没有回到原来那批（' + after.length + ' vs ' + before.length + '）');
      if (restoreBtn()) note('还原之后那个按钮还在（没有可还原的却还挂着）');
      if (P.q('.kbw-notes-bar.is-batch')) note('预选中没被清掉（工具条还被批量栏顶着）');
      if (P.qa('.kbw-trow.is-selected').length !== 0) note('还有行处于选中态');

      if (view0 !== null && view0 !== undefined) {
        await P.ctx().settings.save({ notesView: view0 });
        await P.wait(400);
      }
      // 目录树选择也拨回"整个知识库"（它同样是落盘的，别留给下一步）
      const rootEnd = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
      if (rootEnd) { P.click(rootEnd); await P.wait(500); }
      return {
        ok: problems.length === 0,
        info: '跳转后 ' + jumped.length + ' 篇 → 还原后 ' + after.length + ' 篇（与跳转前逐路径一致=' + (after.join(',') === before.join(',')) + '）' +
              '｜按钮取消=' + !restoreBtn() + '｜预选中清空=' + !P.q('.kbw-notes-bar.is-batch') +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P6② · B1 空白处右键：列表 / 目录树 / 首页都弹菜单；「新建文件夹」真建出目录',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const view0 = P.ctx().settings.get().notesView; // 见 A3 那条注释（视图档是落盘的，用完要还）
      const items = () => P.qa('.kbw-menu-item').map(function (i) { return P.text(i); });
      const has = (t) => items().some(function (s) { return s.indexOf(t) >= 0; });
      const clickItem = (t) => {
        const it = P.qa('.kbw-menu-item').find(function (i) { return P.text(i).indexOf(t) >= 0; });
        if (!it) return false;
        P.click(it);
        return true;
      };

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      await P.scopeAll();
      const segDetail = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '详细信息'; });
      if (segDetail) { P.click(segDetail); await P.wait(600); }
      const batch0 = P.q('.kbw-notes-bar.is-batch');
      if (batch0) {
        const x = Array.from(batch0.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x) { P.click(x); await P.wait(500); }
      }

      // ① 列表空白处
      const list = P.q('.kbw-notes-list');
      const lr = list.getBoundingClientRect();
      P.rightClickAt(Math.round(lr.left + 30), Math.round(lr.bottom - 12));
      await P.wait(500);
      if (!P.lastMenu()) note('列表空白处右键没弹菜单');
      if (!has('在此新建笔记')) note('缺「在此新建笔记」');
      if (!has('新建文件夹')) note('缺「新建文件夹」');
      const menuTxt = P.text(P.lastMenu() || document.body);
      if (menuTxt.indexOf('作用范围') < 0) note('缺作用域行');
      /**
       * ⚠️ 一级项数要在**这一条菜单**里数：菜单是**叠着**的（子菜单展开过就留在 DOM 里），
       * 全局数会把别层算进来 → "> 8" 假红（B 路 §4.4）。
       */
      const topMenu = P.lastMenu();
      const topCount = topMenu ? P.qa('.kbw-menu-item', topMenu).length : 0;
      if (topCount > 8) note('一级菜单 ' + topCount + ' 项（硬规矩是最多 8）');

      // ② 目录树空白处
      P.closeAll(2);
      await P.wait(400);
      const tree = P.q('.kbw-tree-body') || P.q('.kbw-notes-side');
      const tr = tree.getBoundingClientRect();
      P.rightClickAt(Math.round(tr.left + 20), Math.round(Math.min(window.innerHeight - 8, tr.bottom - 6)));
      await P.wait(500);
      if (!P.lastMenu()) note('目录树空白处右键没弹菜单');
      else if (!has('重排库结构')) note('目录树空白菜单里缺「重排库结构…」');
      P.closeAll(2);
      await P.wait(400);

      // ③ 真建一个文件夹（自造的目录带 __探针 前缀）
      const name = '__探针B1新目录';
      const dirNow = ctx.settings.get().treeSelected || '';
      const list2 = P.q('.kbw-notes-list');
      const lr2 = list2.getBoundingClientRect();
      P.rightClickAt(Math.round(lr2.left + 30), Math.round(lr2.bottom - 12));
      await P.wait(500);
      if (!clickItem('新建文件夹')) return { ok: false, info: '点不到「新建文件夹」' };
      await P.wait(800);
      const promptModal = P.lastModal();
      if (!promptModal) return { ok: false, info: '没弹取名对话框' };
      const input = promptModal.querySelector('input.kbw-input');
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const okBtn = Array.from(promptModal.querySelectorAll('.kbw-modal-foot button'))
        .find(function (b) { return b.classList.contains('is-primary'); });
      P.click(okBtn);
      await P.wait(1500);
      const abs = (dirNow ? KB + '/' + dirNow : KB) + '/' + name;
      const made = app.vault.getAbstractFileByPath(abs);
      if (!made) note('目录没建出来：' + abs);
      if (!P.text(P.q('.kbw-notice') || document.body).includes(name)) note('通知里没报出这个名字');
      // 建完**站进去了**（B1 的反馈）：面包屑上该有它
      if (P.text(P.q('.kbw-crumbs') || document.body).indexOf(name) < 0) note('建完没进到新目录（面包屑上看不见它）');

      /**
       * ③b **同名再建一次**（B 路 §3 / §4.4：真机侧原来没验这条）：
       * 真机上 "adapter.mkdir" 会经文件监视器让缓存树认得它（异步），所以要么对话框当场拦住
       * （校验用的就是缓存树），要么第二道闸 "adapter.exists" 事后报"已经有同名的了"。
       * 两条路**都算通过**，但必须有**一条**给回执，且目录只有一个。
       */
      P.closeAll(2);
      await P.wait(400);
      /**
       * ⚠️ **先退回上一层**：建完文件夹模块会**站进新目录**（B1 的反馈），
       * 不退回的话第二次的父目录就是那个新目录，重名根本不成立
       *（第一版就是这么"既没拦住也没回执"的 —— 它真的又套了一层同名目录）。
       */
      const rootBack = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
      if (rootBack) { P.click(rootBack); await P.wait(700); }
      const list3 = P.q('.kbw-notes-list');
      const lr3 = list3.getBoundingClientRect();
      P.rightClickAt(Math.round(lr3.left + 30), Math.round(lr3.bottom - 12));
      await P.wait(500);
      if (clickItem('新建文件夹')) {
        await P.wait(800);
        const pm = P.lastModal();
        if (pm) {
          const inp = pm.querySelector('input.kbw-input');
          inp.value = name;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          const ok2 = Array.from(pm.querySelectorAll('.kbw-modal-foot button'))
            .find(function (b) { return b.classList.contains('is-primary'); });
          P.click(ok2);
          await P.wait(900);
          const stillOpen = !!P.lastModal();
          const inlineErr = stillOpen && P.text(P.lastModal()).indexOf('已经有同名') >= 0;
          const noticed = P.qa('.kbw-notice').some(function (x) { return P.text(x).indexOf('已经有同名') >= 0; });
          if (!inlineErr && !noticed) note('同名再建一次：既没当场拦住、也没有回执');
          if (stillOpen) { P.key('Escape'); await P.wait(400); }
        } else note('同名第二次：对话框都没弹出来');
      } else note('同名第二次：菜单里点不到「新建文件夹」');
      P.closeAll(2);
      await P.wait(300);

      // ④ 首页空白处
      const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome) { P.click(navHome); await P.wait(800); }
      const home = P.q('.kbw-home');
      const hr = home.getBoundingClientRect();
      /**
       * 🔴 **空白点要现扫**（P7.7c 全量两跑都在这里红）：硬写「宿主左缘 + 40」只在
       * 宿主远宽于块（max 720）时才算空白 —— 宿主一窄（分屏/停靠残留），居中块就压到这个点上，
       * 右键落在「待处理／教程」等块上弹的是**块的菜单**（7.7b 起组件右键归块），全局菜单那五条全"缺"。
       * 扫法：沿宿主左缘自下而上找第一个**不在任何 kbw-hblock 里、也不是浮层/控件**的点。
       */
      let bp = null;
      for (let y = Math.round(hr.bottom - 10); y > hr.top + 20; y -= 20) {
        const el = document.elementFromPoint(Math.round(hr.left + 8), y);
        if (!el) continue;
        const blk = el.closest ? el.closest('.kbw-hblock') : null;
        const bad = el.closest ? el.closest('button, input, a, select, textarea, .kbw-notice, .kbw-menu, .kbw-panel, .kbw-modal, .kbw-undobar-wrap') : null;
        if (!blk && !bad) { bp = [Math.round(hr.left + 8), y]; break; }
      }
      if (!bp) note('首页找不到一块"空白"位置可点（布局被块/浮层占满？）');
      else {
        P.rightClickAt(bp[0], bp[1]);
        await P.wait(500);
        if (!P.lastMenu()) note('首页空白处右键没弹菜单');
        const missingHome = ['新建笔记', '整理收件箱', '还原快照', '工作台设置', '快捷键一览'].filter(function (w) { return !has(w); });
        if (missingHome.length) {
          note('首页菜单缺「' + missingHome.join('」；缺「') + '」——实际菜单项：' +
            items().slice(0, 12).join(' / ') + '（DOM 里菜单数 ' + P.qa('.kbw-menu').length +
            '，空白点 @' + bp[0] + ',' + bp[1] + ' 宿主宽 ' + Math.round(hr.width) + '）');
        }
      }
      P.closeAll(2);
      await P.wait(400);

      // ── 清场：删掉自造目录 → 当前目录拨回「整个知识库」
      const dirFile = app.vault.getAbstractFileByPath(abs);
      if (dirFile) await app.vault.delete(dirFile, true);
      // 防御：第二次万一真套了一层同名目录，一起带走（我们那次 delete 是递归的）
      await P.wait(800);
      P.closeAll(2);
      const navBack = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (navBack) { P.click(navBack); await P.wait(700); }
      const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
      if (rootNode) { P.click(rootNode); await P.wait(600); }
      const gone = !app.vault.getAbstractFileByPath(abs);
      if (!gone) note('自造目录没删掉');
      if (view0 !== null && view0 !== undefined) {
        await P.ctx().settings.save({ notesView: view0 });
        await P.wait(400);
      }

      return {
        ok: problems.length === 0 && !!made && gone,
        info: '列表/树/首页三处菜单都弹了｜一级 ' + topCount + ' 项｜建出 ' + abs + '=' + !!made + '｜清理=' + gone +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-B1-空白右键.png',
  },
  {
    name: 'P6② · B2 点列表空白取消选中；点单元格不算（那是选中/加选）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const view0 = P.ctx().settings.get().notesView; // 见 A3 那条注释
      const sel = () => P.qa('.kbw-trow.is-selected').length;

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      await P.scopeAll();
      const segDetail = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '详细信息'; });
      if (segDetail) { P.click(segDetail); await P.wait(600); }
      const batch = P.q('.kbw-notes-bar.is-batch');
      if (batch) {
        const x = Array.from(batch.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x) { P.click(x); await P.wait(500); }
      }
      /**
       * ⚠️ **P6b ② 起列表只画本层** —— 库根那一层常常一篇都没有（笔记都在子目录里）。
       * 这些步骤原来点「整个知识库」就以为能看到全库，现在得**先站进一个有笔记的目录**。
       * 挑法：从索引里取"顶层、且本层笔记最多"的那个目录。
       */
      const levelByDir = {};
      P.ctx().index.notes().forEach(function (e) {
        const d = e.effectivePosition;
        if (!d || d.indexOf('/') >= 0) return;
        levelByDir[d] = (levelByDir[d] || 0) + 1;
      });
      const topDir = Object.keys(levelByDir).sort(function (a, b) { return levelByDir[b] - levelByDir[a]; })[0];
      const dirNode = topDir ? P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === topDir; }) : null;
      if (dirNode) { P.click(dirNode); await P.wait(900); }

      const row = P.q('.kbw-trow');
      if (!row) return { ok: false, info: '一行都没有（这个目录本层也没笔记？）' };
      P.click(row);
      await P.wait(500);
      if (sel() !== 1) note('点行没选中（' + sel() + '）');

      // ① 点**单元格**：不许清空（那是行自己的命中区）
      const cell = row.querySelector('[data-col="name"]') || row;
      P.click(cell);
      await P.wait(500);
      const afterCell = sel();
      if (afterCell === 0) note('点单元格把选择清掉了（那是行自己的活）');

      // ② 点**列表空白**：清空
      /**
       * ⚠️ **扫候选点，别用固定几何点**（P7.2d 全量红过一次：固定点「lr.bottom-12」
       * 在 park 档窗口宽（1426）下命中了行内勾选框 INPUT.kbw-rowcheck →
       * "点空白没清掉选择"）。判据：从列表右下角往左上扫，选第一个不在
       * .kbw-trow / button / input 里的点；一个都扫不到就如实 note（不装点成功）。
       */
      const list = P.q('.kbw-notes-list');
      const lr = list.getBoundingClientRect();
      const cands = [];
      for (let dy = 12; dy <= 240 && cands.length < 60; dy += 16) {
        for (let dx = 20; dx <= 140 && cands.length < 60; dx += 30) {
          cands.push({ x: Math.round(lr.right - dx), y: Math.round(Math.min(window.innerHeight - 8, lr.bottom - dy)) });
        }
      }
      let hit = null;
      for (const c of cands) {
        const h = P.elAt(c.x, c.y);
        if (h && !(h.closest && h.closest('.kbw-trow, button, input'))) { hit = h; break; }
      }
      if (!hit) {
        const xBlank = Math.round(lr.left + 20);
        const yBlank = Math.round(Math.min(window.innerHeight - 8, lr.bottom - 12));
        hit = P.elAt(xBlank, yBlank);
        note('扫不到干净的空白点（扫了 ' + cands.length + ' 个候选），退回固定点');
      }
      if (hit && hit.closest && hit.closest('.kbw-trow, button, input')) {
        note('挑的空白点其实命中了 ' + hit.tagName + '.' + String(hit.className).slice(0, 40));
      }
      if (hit) {
        P.click(hit); // 没有 clickAt 这个助手：拿 elementFromPoint 的结果再派完整鼠标序列
      } else {
        note('取不到那个空白点（elementFromPoint 给了 null）—— 这一发点击根本没发生');
      }
      await P.wait(600);
      const afterBlank = sel();
      if (afterBlank !== 0) note('点空白没清掉选择（还剩 ' + afterBlank + '）');
      if (view0 !== null && view0 !== undefined) {
        await P.ctx().settings.save({ notesView: view0 });
        await P.wait(400);
      }

      return {
        ok: problems.length === 0,
        info: '点行 → 选中 1｜点单元格后仍选中 = ' + afterCell + '｜点空白后 = ' + afterBlank +
              '｜空白点命中 ' + (hit ? hit.tagName + '.' + String(hit.className).slice(0, 30) : '(null)') +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P6② · B3 网格文件夹：混排在最前 · 点它进目录 · 拖笔记到它上面真搬（可撤销）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const view0 = ctx.settings.get().notesView; // 见 A3 那条注释
      await P.scopeAll(); // 摆好：全库 + 网格档
      const batch = P.q('.kbw-notes-bar.is-batch');
      if (batch) {
        const x = Array.from(batch.querySelectorAll('button')).find(function (b) { return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0; });
        if (x) { P.click(x); await P.wait(500); }
      }

      const folders = P.qa('.kbw-gcell.is-folder');
      if (folders.length === 0) return { ok: false, info: '整个知识库这一层没有文件夹格子（B3 没生效？）' };
      /**
       * ⚠️ **"混排在最前"的顺序判据挪到 ① 进目录之后**（P7.1b · 2.8 反转根层递归）：
       * 库根这一层现在只剩文件夹格（本层没笔记）→ 在这里比对**必然空转**。
       * 自造的 __探针网夹 里"有笔记、也有一个子目录"，那才是真正的"混排"场景。
       */
      const noPath = folders.filter(function (c) { return c.dataset.path != null; });
      if (noPath.length > 0) note('文件夹格子带上了 data-path（会被当成笔记选中）');
      const noDrop = folders.filter(function (c) { return (c.dataset.drop || '') !== (c.dataset.dir || ''); });
      if (noDrop.length > 0) note('文件夹格子没有 data-drop（拖上去落不了）');

      /**
       * ① **Windows 式**（P6b ②）：单击 = 选中、**双击 = 进那个目录**。
       * 先验"单击只选中"（老实现是单击就进），再真双击。
       *
       * ⚠️ 挑**自己刚造的那个**（__探针网夹/）：实验库里别的目录可能是上一步遗留的、
       * 也可能刚被 P5 的"重排执行"搬空（实测：进了一个 **0 篇**的目录 → 后面那半段空转）。
       */
      const ownCell = folders.find(function (c) {
        return String(c.dataset.dir || '').indexOf('__探针') === 0;
      });
      const target = ownCell || folders[0];
      const targetDir = target.dataset.dir;
      const targetName = P.text(target.querySelector('.kbw-gname'));
      const beforeDir = P.ctx().settings.get().treeSelected;
      P.click(target);
      await P.wait(500);
      if (!target.classList.contains('is-selected')) note('单击没有选中文件夹格子');
      if (P.ctx().settings.get().treeSelected !== beforeDir) {
        note('单击就进目录了（P6b ② 起那是双击的活）');
      }
      const tr = target.getBoundingClientRect();
      const tpt = { x: Math.round(tr.left + tr.width / 2), y: Math.round(tr.top + tr.height / 2) };
      P.elAt(tpt.x, tpt.y).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: tpt.x, clientY: tpt.y }));
      P.elAt(tpt.x, tpt.y).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: tpt.x, clientY: tpt.y }));
      P.elAt(tpt.x, tpt.y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: tpt.x, clientY: tpt.y }));
      await P.wait(1200);
      const crumbs = P.text(P.q('.kbw-crumbs') || document.body);
      if (crumbs.indexOf(targetName) < 0) note('面包屑没跟着走（' + crumbs.slice(0, 40) + '）');
      const inside = P.qa('.kbw-gcell[data-path]').map(function (c) { return c.dataset.path; });
      const outsider = inside.filter(function (p) { return p.indexOf('/' + targetDir + '/') < 0; });
      if (inside.length === 0) note('进了目录却一篇都没画（下面那条"没有 outsider"是空转）');
      if (outsider.length > 0) note('进了目录，网格里还有 ' + outsider.length + ' 篇不属于它');
      /**
       * **混排顺序的判据放这儿**（2.8 之后根层只剩文件夹格，那里空转）：这个自造目录里
       * 既有笔记格、又有一个子目录格 —— 文件夹格必须**全部排在笔记格之前**。
       */
      const all = P.qa('.kbw-gcell');
      let seenNote = false;
      const orderBad = [];
      for (const c of all) {
        const isFolder = c.classList.contains('is-folder');
        if (!isFolder) seenNote = true;
        else if (seenNote) orderBad.push(P.text(c.querySelector('.kbw-gname')));
      }
      if (orderBad.length > 0) note('文件夹格子没排在最前：' + orderBad.join('、'));
      if (!all.some(function (c) { return !c.classList.contains('is-folder'); })) {
        note('进了目录却没有笔记格 —— 混排顺序判据空转（自造的目录里该有 2 篇）');
      }

      // ② 拖一篇 Inbox 的笔记到文件夹格子上 = 搬到那个目录（走 mover + 撤销条）
      await P.scopeAll();
      /**
       * ⚠️ P6b ② 起要**先站进 00_Inbox**（列表只画本层）：不进去的话，网格里根本
       * 没有"一篇 Inbox 的格子"可拖（这一整段会静默降级成"跳过"）。
       */
      /**
       * 🔴 **落点是一个"文件夹格子"** = 当前层的子目录 → 这一层必须"既有笔记、又有子目录"。
       * P6b ② 之后这不是随便哪层都成立，而且**实验库当时的形态会变**（前面几十步会搬文件）
       * → **自造一个**：__探针网夹/ 放 2 篇 + 一个子目录「子」（1 篇）；收尾删掉。
       */
      await P.dropGridDir('网夹');
      const dragLevel = await P.seedGridDir('网夹', 2);
      const dragNode = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === dragLevel; });
      if (dragNode) { P.click(dragNode); await P.wait(900); }
      else { ctx.goNotes({ dir: dragLevel }); await P.wait(900); }
      const segGrid2 = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '网格'; });
      if (segGrid2) { P.click(segGrid2); await P.wait(700); }
      const dragCell = P.qa('.kbw-gcell[data-path]')[0];
      let moved = null;
      let dragPath = '';
      if (!dragCell) note('那一层里没有笔记格（拖拽那条判据跳过）');
      if (dragCell) {
        dragPath = dragCell.dataset.path;
        /**
         * 🔴 目标要挑**另一棵树**上的目录，不能是这一篇现在所在的目录：
         * 第一次跑挑中的是 00_Inbox（正好是被拖那篇的老家）→ mover 判成"已经在那儿"、
         * 什么都不做，而"目标路径存在吗"这条判据**照样为真**（假绿），
         * 于是"没出撤销条"被当成怪事。判据要**成对**：新位置有 **且** 老位置没了。
         */
        const dragDirRel = dragPath.slice(KB.length + 1).split('/').slice(0, -1).join('/');
        /**
         * ⚠️ **别再要求"格子是顶层目录"**（老口径）：P6b ② 起文件夹格子画的是**当前层的
         * 直接子目录** —— 它的 data-dir 必然带斜杠（__探针网夹/子），
         * 拿 indexOf(斜杠) < 0 去筛**一个都找不到**（这正是本轮它假红的原因）。
         * 现在只要"是格子、且不是被拖那篇自己的目录"。
         */
        const folderCell = P.qa('.kbw-gcell.is-folder').find(function (c) {
          return c.dataset.dir && c.dataset.dir !== dragDirRel;
        });
        if (!folderCell) note('找不到一个"另一棵树"上的文件夹格子当落点');
        else {
          const toDir = folderCell.dataset.dir;
          const s = P.aimAt(dragCell);
          const d = P.aimAt(folderCell);
          await P.dragMouse({ x: s.x, y: s.y }, { x: d.x, y: d.y }, 8);
          await P.wait(1500);
          const want = KB + '/' + toDir + '/' + dragPath.split('/').pop();
          moved = app.vault.getAbstractFileByPath(want);
          if (!moved) note('拖到文件夹格子上没搬文件（' + want + ' 不存在）');
          if (app.vault.getAbstractFileByPath(dragPath)) {
            moved = null;
            note('新位置有了、老位置还在 —— 这不是"搬"，是复制或压根没动（落点 ' + toDir + '）');
          }
          if (moved) {
            /**
             * ⚠️ 撤销条的类名是 kbw-undobar（第一版写成 .kbw-undo/.kbw-undo-bar 三选一，
             * 一个都没命中 → "搬完没出撤销条"这句是**假红**：条就在屏幕上）。
             */
            const undoBar = P.q('.kbw-undobar');
            const undoBtn = undoBar ? P.btnByText('撤销', undoBar) : null;
            if (undoBtn) {
              P.click(undoBtn);
              await P.wait(2200);
            } else {
              note('搬完没出撤销条（body 上的浮层：' +
                P.qa('body > div').map(function (d) { return String(d.className).slice(0, 20); })
                  .filter(Boolean).join(' / ') + '）');
            }
            if (!app.vault.getAbstractFileByPath(dragPath)) note('撤销之后没回到原位：' + dragPath);
            const stillThere = app.vault.getAbstractFileByPath(
              KB + '/' + (folderCell ? folderCell.dataset.dir : '') + '/' + dragPath.split('/').pop(),
            );
            if (moved && stillThere) note('撤销之后新位置还留着副本');
          }
        }
      }

      // ③ 搜索时不画文件夹（那时它是噪音）
      await P.scopeAll();
      /**
       * ⚠️ 先清选择：有选择时工具条整条被批量栏顶掉 —— .kbw-search 根本不在
       *（第一版就在这儿报"找不到搜索框"，其实是选择没清）。
       */
      const batch3 = P.q('.kbw-notes-bar.is-batch');
      if (batch3) {
        const x3 = Array.from(batch3.querySelectorAll('button')).find(function (b) {
          return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0;
        });
        if (x3) { P.click(x3); await P.wait(500); }
      }
      const search = P.q('.kbw-search');
      if (search) {
        search.value = 'zzz-探针搜不到-zzz';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(800);
        const still = P.qa('.kbw-gcell.is-folder').length;
        if (still > 0) note('搜索时还画着 ' + still + ' 个文件夹格子');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(800);
      } else note('找不到搜索框');

      if (view0 !== null && view0 !== undefined) {
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
      }
      // 目录树选择也拨回"整个知识库"（落盘的偏好，别留给下一步）
      const rootEnd2 = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
      if (rootEnd2) { P.click(rootEnd2); await P.wait(500); }
      /**
       * ⚠️ **收尾**（P7.15 全量跑抓到同一族）：与开头的 dropGridDir('网夹') 配成对。
       * 建的是空目录 + 2 篇 + 子目录「子」—— 只清不删的话它一直留在库里。
       */
      await P.dropGridDir('网夹');
      return {
        ok: problems.length === 0,
        info: '文件夹格 ' + folders.length + ' 个（' + folders.slice(0, 4).map(function (c) { return P.text(c.querySelector('.kbw-gname')); }).join('、') + '）' +
              '｜点它进目录 ' + targetDir + '（里面 ' + inside.length + ' 篇笔记）｜拖上去真搬=' + !!moved +
              '｜撤销回得来=' + (moved && dragPath ? !!app.vault.getAbstractFileByPath(dragPath) : '（没走到）') +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-B3-网格文件夹.png',
  },
  {
    name: 'P6② · C1/C2 小窗默认：不画属性块 + 正文 = 平台−2px（真机量的 computed；P6b ⑤ 从 −1 降了一档）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      const baseRaw = getComputedStyle(document.body).getPropertyValue('--font-text-size');
      const base = parseFloat(baseRaw) || 16;

      /**
       * ⚠️ 真机上"存量 v1"这条要**自己造出来**（B 路 🔴2.5 第 3 条）：实验库那份配置
       * 早就被迁成 v2 了，直接跑永远验不到"老用户那份 v1 会不会被吃掉"。
       * 自造夹具 = v1 + panelProps few，跑完把配置拨回原样（备份 → 写 → 验 → 还原）。
       */
      const cfgBackup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      await ctx.configs.write('board', {
        ...cfgBackup,
        version: 1,
        view: { ...(cfgBackup.view || {}), panelProps: 'few' },
      });
      await P.wait(700);

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('看板') >= 0; });
      if (nav) { P.click(nav); await P.wait(1400); }
      const card = P.qa('[data-card]')[0];
      if (!card) return { ok: false, info: '看板上一张卡都没有' };
      P.click(card.querySelector('.kbw-card-t'));
      await P.wait(2000);
      const panel = P.q('.kbw-cw-panel');
      if (!panel) return { ok: false, info: '小窗没开出来' };

      // ① C2：默认不画属性块（属性档 = none）
      const propsBlock = panel.querySelector('.kbw-cw-props');
      if (propsBlock) note('小窗默认还画着属性块');
      const contentBlock = panel.querySelector('.kbw-cw-editor');
      if (!contentBlock) note('小窗里连正文块都没有（那就不对了）');

      // ② C1/C2：正文页上的字号变量 = 平台 − **2**（P6b ⑤ 从 −1 降了一档），且 .cm-content 的**计算值**跟着它
      const page = panel.querySelector('.kbw-cw-page');
      const setVar = page ? parseFloat(page.style.getPropertyValue('--font-text-size')) : NaN;
      if (!(Math.abs(setVar - (base - 2)) < 0.01)) note('页上的 --font-text-size = ' + setVar + '（应为 平台 ' + base + ' − 2）');
      const cm = panel.querySelector('.cm-content');
      const cmFont = cm ? parseFloat(getComputedStyle(cm).fontSize) : NaN;
      // ⚠️ 编辑器没挂上要报出来（B 路 §4.7）：不然这条判据会静默降级成通过
      if (!cm) note('小窗里没有 .cm-content（真编辑器没挂上）');
      if (cm && !(Math.abs(cmFont - (base - 2)) < 0.5)) {
        note('.cm-content 的 computed 字号 = ' + cmFont + '（应为 ' + (base - 2) + '）');
      }
      const scale = page ? parseFloat(page.style.getPropertyValue('--kbw-cw-scale')) : NaN;
      if (!(Math.abs(scale - (base - 2) / base) < 0.01)) note('--kbw-cw-scale = ' + scale + '（应为 ' + ((base - 2) / base).toFixed(3) + '）');

      // 收尾之一：配置拨回进场那一份（上面自造的 v1 夹具）
      await ctx.configs.write('board', cfgBackup);
      await P.wait(500);

      // 收尾：关小窗（Esc；停靠态按底部的「完成」）
      const foot = Array.from(panel.querySelectorAll('button')).find(function (b) { return P.text(b) === '完成'; });
      if (foot) { P.click(foot); await P.wait(900); }
      else { P.key('Escape'); await P.wait(900); }
      if (P.q('.kbw-cw-panel')) note('小窗没关掉');

      return {
        ok: problems.length === 0,
        info: '平台基准 ' + base + 'px｜页上写的 ' + setVar + 'px｜.cm-content 实测 ' + cmFont + 'px｜比例 ' + scale +
              '｜属性块 ' + (propsBlock ? '还画着 ✗' : '默认不画 ✓') +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-C1C2-小窗默认.png',
  },
  {
    name: 'P6② · E 设置面板：左栏**靠左**（图标 x 全同）· 分组标题比行标签小（层次）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      ctx.openWorkbenchSettings();
      await P.wait(1200);
      const modal = P.lastModal();
      if (!modal) return { ok: false, info: '设置面板没开' };

      const tabs = Array.from(modal.querySelectorAll('.kbw-set-tab')).filter(function (t) { return !t.classList.contains('is-ghost'); });
      if (tabs.length < 7) note('左栏只有 ' + tabs.length + ' 项（应 7，P7.2a 起七栏）');
      const justify = tabs.length ? getComputedStyle(tabs[0]).justifyContent : '(无)';
      if (justify !== 'flex-start') note('左栏的 justify-content = ' + justify + '（居中就是这条的锅）');
      /**
       * 真机判据：**七个图标的左边缘要落在同一个 x**。
       * 居中时它们各自居中（实测 x = 549/549/541/534/556…）。
       */
      const xs = tabs.map(function (t) {
        const ico = t.querySelector('.kbw-ico, svg');
        return ico ? Math.round(ico.getBoundingClientRect().left) : -1;
      });
      const uniq = Array.from(new Set(xs.filter(function (x) { return x >= 0; })));
      /**
       * ⚠️ 判据要写"**恰好一个**唯一值"而不是"不能多于一个"（B 路 §4.8）：
       * 一个图标都取不到时后者**空过**（空集长度 0，不大于 1）。
       */
      if (uniq.length !== 1) note('图标左边缘不是一个唯一值：' + xs.join('/') + '（取到 ' + xs.filter(function (x) { return x >= 0; }).length + ' 个图标）');

      // E2 层次：分组标题的字号要**小于**行标签（原来是同号，看着没层次）
      const groupT = modal.querySelector('.kbw-set-group-t');
      const labelT = modal.querySelector('.kbw-set-label-t');
      let gFs = 0;
      let lFs = 0;
      if (!groupT || !labelT) {
        note('读不到分组标题或行标签（类名变了？这条判据会静默跳过）');
      } else {
        gFs = parseFloat(getComputedStyle(groupT).fontSize);
        lFs = parseFloat(getComputedStyle(labelT).fontSize);
        if (!(gFs < lFs)) note('分组标题 ' + gFs + 'px 不小于行标签 ' + lFs + 'px（层次没拉开）');
      }

      P.key('Escape');
      await P.wait(800);
      const closed = !P.q('.kbw-modal');
      if (!closed) note('设置面板没关掉');

      return {
        ok: problems.length === 0,
        info: '左栏 ' + tabs.length + ' 项｜justify=' + justify + '｜图标 x = ' + uniq.join('/') + '（唯一值 ' + uniq.length + ' 个）' +
              '｜分组标题 ' + gFs + 'px vs 行标签 ' + lFs + 'px｜Esc 关掉=' + closed +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-E-设置面板.png',
  },
  // ────────────────────────────────────────────────────────────
  // P6b（用户 2026-09-27 第二轮反馈：① 还原三入口 ② 网格 Windows 式 ③ 悬浮窗
  //      ④ 手势分流 ⑤ 小窗顶部压缩 ⑥ 预览换行 ⑦⑧ 设置层次 + 目录栏往上拓展）
  // ⚠️ 这一批里有几条是**离线测不了的**：拖头合并 / 拖 tab 拆窗依赖真实命中测试
  //    （jsdom 没有 elementFromPoint）；手势分流要证"没被平台吃掉"。它们只能在这儿验。
  {
    name: 'P6b · ① 还原三入口：点目录 / Esc 两次 / 按钮（逐路径比）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      /**
       * ⚠️ **切屏要点导航项**（不能只 ctx.store.set({activeModule})）：那一下只改内存，
       * 而任何一次设置落盘都会经 applySettingsToStore 把 activeModule **按 data.json 复位**
       *（本项目的现成坑）→ 屏幕回到别的模块，这一条就量到 0 行。
       */
      const navNotes = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (navNotes) { P.click(navNotes); await P.wait(900); }
      ctx.store.set({ activeModule: 'notes' });
      await P.wait(400);
      const view0 = ctx.settings.get().notesView;
      await P.scopeAll();
      await P.wait(300);
      /**
       * ⚠️ P.scopeAll() 会把视图切到**网格**（它是给网格那些步骤用的），而这一条要量的
       * 是**表格**的行（.kbw-trow）—— 不切回来的话「本层 N 篇」永远是 0（假红）。
       */
      const segDetail = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '详细信息'; });
      if (segDetail) { P.click(segDetail); await P.wait(700); }

      /** 站进一个本层有笔记的目录（库根那一层常常是空的 —— P6b ② 起只画本层） */
      const index = ctx.index;
      const byDir = {};
      index.notes().forEach(function (e) {
        const d = e.effectivePosition;
        if (!d || d.indexOf('/') >= 0) return;
        byDir[d] = (byDir[d] || 0) + 1;
      });
      const pick = Object.keys(byDir).sort(function (a, b) { return byDir[b] - byDir[a]; })[0];
      if (!pick) return { ok: false, info: '夹具/实验库里没有一个"顶层且本层有笔记"的目录' };
      const node = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === pick; });
      if (node) {
        P.click(node);
        await P.wait(800);
      } else {
        /**
         * 树里没这个节点（没展开 / 刚重挂完）→ 退回**真入口** goNotes({dir})
         *（首页跳转走的就是它），别让"找不到节点"变成假红。
         */
        ctx.goNotes({ dir: pick });
        await P.wait(900);
      }

      const rowPaths = () => P.qa('.kbw-trow').map(function (r) { return r.dataset.path; }).sort();
      const level = index.notes().filter(function (e) {
        return e.effectivePosition === pick;
      }).map(function (e) { return e.path; }).sort();
      if (rowPaths().join('|') !== level.join('|')) {
        note('浏览态该只画本层：期望 ' + level.length + ' 篇，实际 ' + rowPaths().length + ' 篇');
      }
      const crumbs = P.q('.kbw-crumbs-count');
      if (!crumbs || P.text(crumbs) !== '本层 ' + level.length + ' 篇') {
        note('面包屑该写「本层 N 篇」（实际 ' + (crumbs ? P.text(crumbs) : '(没有)') + '）');
      }

      /** 挑一篇**不在本层**的来跳（跳过去才看得出差别） */
      const outside = index.notes().find(function (e) { return level.indexOf(e.path) < 0; });
      if (!outside) return { ok: false, info: '库里没有"本层之外"的笔记，这条验不出差别' };
      const restoreBtn = () => P.qa('.kbw-batch-tail .kbw-btn, .kbw-notes-tools .kbw-btn, .kbw-notes-bar.is-batch .kbw-btn')
        .find(function (b) { return P.text(b) === '还原'; });

      // ①-a 跳转（首页「去看看」/快速切换走的就是这条意图）
      ctx.goNotes({ paths: [outside.path], selectPaths: [outside.path] });
      await P.wait(700);
      const jumped = rowPaths();
      if (jumped.join('|') !== outside.path) note('跳转没生效（实际 ' + jumped.length + ' 篇）');
      if (!restoreBtn()) note('跳转之后没有「还原」按钮');
      const noticeTexts = P.qa('.kbw-notice').map(function (n) { return P.text(n); }).join(' | ');
      if (noticeTexts.indexOf('可还原') < 0) note('跳转时没给那条轻通知（实际：' + noticeTexts + '）');

      // ①-b 点目录 → 一次性清单结束
      const node2 = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === pick; });
      if (node2) { P.click(node2); await P.wait(600); }
      if (rowPaths().join('|') !== level.join('|')) note('点目录之后没回到本层那一批');
      if (restoreBtn()) note('点目录之后「还原」还挂着（一次性清单没结束）');

      // ①-c Esc 两次：先清选择、再清筛选
      ctx.goNotes({ paths: [outside.path], selectPaths: [outside.path] });
      await P.wait(700);
      P.key('Escape');
      await P.wait(500);
      if (P.q('.kbw-notes-bar.is-batch')) note('第一次 Esc：批量栏还在（选择没清）');
      if (rowPaths().join('|') !== outside.path) note('第一次 Esc 动了筛选（那是第二层的事）');
      P.key('Escape');
      await P.wait(600);
      if (rowPaths().join('|') !== level.join('|')) note('第二次 Esc 之后没回到本层（筛选没清）');
      if (restoreBtn()) note('第二次 Esc 之后「还原」还挂着');
      P.closeAll(2);
      /** 视图档拨回基线（它是落盘的偏好，不还回去下一轮开头那些表格步骤会看到空屏） */
      if (view0) {
        await ctx.settings.save({ notesView: view0 });
        await P.wait(400);
      }
      await P.wait(300);
      return {
        ok: problems.length === 0,
        info: '目录=' + pick + '｜本层 ' + level.length + ' 篇｜跳转→点目录→Esc×2 四条都对上' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    /**
     * P7.9 · ④（用户真机缺陷：跳转后**没有任何回头路**）：
     * 「整理收件箱 → 去全部笔记自己整理」带的是**目录 + 全选** —— 旧 A3 只看筛选，
     * 那条路上「还原」从来不出现（用户复现 `jumpRestoreButton=null`）。
     * 现在带目录的跳转也记一笔：批量栏/工具条出现「还原」→ 点击 = 目录回库根 +
     * 清筛选 + 清预选中；用户自己点别的目录 → 口子消失（与 A3 同规则）。
     */
    name: 'P7.9 · ④ 带目录的跳转也有「还原」：点击回默认态（目录回库根 + 清选中）· 自己点目录后消失',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const dirPrev = ctx.settings.get().treeSelected;
      const restoreBtn = () => P.qa('.kbw-batch-tail .kbw-btn, .kbw-notes-tools .kbw-btn, .kbw-notes-bar.is-batch .kbw-btn')
        .find(function (b) { return P.text(b) === '还原'; });
      /** 面包屑「本层 N 篇」与该层的真实篇数对（判断"目录到底在哪一层"） */
      const crumbsOk = function (dir) {
        // ⚠️ 走 ctx.index（这一屏没有裸 index 全局 —— 第一版 ReferenceError 当场红）
        const want = ctx.index.notes().filter(function (e) { return e.effectivePosition === dir; }).length;
        const crumbs = P.q('.kbw-crumbs-count');
        return !!crumbs && P.text(crumbs) === '本层 ' + want + ' 篇';
      };
      try {
        ctx.store.set({ activeModule: 'notes' });
        await P.wait(600);
        // 真入口口径：与首页二级菜单「去全部笔记自己整理」同一条意图
        ctx.goNotes({ dir: '00_Inbox', selectAll: true });
        await P.wait(1300);
        if (!P.q('.kbw-notes-bar.is-batch')) note('全选跳转之后批量栏不在');
        if (!restoreBtn()) note('带目录的跳转没有「还原」（P7.9 · ④ 回归了 —— 用户原话"只能手动点树根"）');
        else {
          P.click(restoreBtn());
          await P.wait(700);
          if (P.q('.kbw-notes-bar.is-batch')) note('点了「还原」批量栏还在（预选中没清）');
          if (restoreBtn()) note('点了「还原」之后口子还挂着（没有可还原的却还在）');
          if (!crumbsOk('')) note('还原之后目录没回库根（面包屑：' + (P.q('.kbw-crumbs-count') ? P.text(P.q('.kbw-crumbs-count')) : '无') + '）');
          await P.wait(600); // persist 的 400ms 防抖
          if (ctx.settings.get().treeSelected !== '') note('还原之后 treeSelected 没回库根（' + ctx.settings.get().treeSelected + '）');

          // 负向：用户自己点别的目录 → 一次性清单到此为止
          ctx.goNotes({ dir: '00_Inbox', selectAll: true });
          await P.wait(1100);
          if (!restoreBtn()) note('再来一次跳转，「还原」没回来（负向那半的前提不成立）');
          const other = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === '02_Areas'; });
          if (!other) note('树上没有 02_Areas（负向那半没验成）');
          else {
            P.click(other);
            await P.wait(900);
            if (restoreBtn()) note('用户自己点了别的目录之后「还原」还挂着（判据该是"现在生效的还是不是跳转给的那份"）');
          }
        }
      } finally {
        await ctx.settings.save({ treeSelected: dirPrev });
        P.closeAll(3);
        await P.wait(400);
      }
      return {
        ok: problems.length === 0,
        info: '带目录跳转 →「还原」在 → 点击回库根 + 清选中 · 自己点目录后口子消失' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.10 · #8 首入「全部笔记」的讲解：弹一次 · 居中偏右 · 关掉永不再弹（原值归还）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      /**
       * 原值 = **这一步开跑时读到的值**（基线种的 true —— 步内对称，见基线那段注释：
       * "跑完留在 true"是如实接受的稳态，用户重看法见基线注释）。
       */
      const orig = ctx.settings.get().notesIntroSeen;
      const introEl = () => P.q('.kbw-noteintro');
      try {
        await ctx.settings.save({ notesIntroSeen: false });
        // 换出去再进来 = 一次**新挂载**（不是聚焦旧模块；intro 只看 mount 那一刻）
        ctx.store.set({ activeModule: 'home' });
        await P.wait(700);
        ctx.store.set({ activeModule: 'notes' });
        await P.wait(1300);
        const el = introEl();
        if (!el) note('首入没弹讲解浮层（旗标 false 时该弹）');
        else {
          // ── 几何：在视口内 + 「居中偏右」──
          const r = el.getBoundingClientRect();
          const vw = window.innerWidth;
          if (r.width < 200) note('浮层宽度异常（' + Math.round(r.width) + '）');
          if (r.left < 0 || r.top < 0 || r.right > vw) {
            note('浮层超出视口（left=' + Math.round(r.left) + ' right=' + Math.round(r.right) + ' vw=' + vw + '）');
          }
          /**
           * 「居中偏右」的**参照系是模块宿主**（「.kbw-notes」），不是视口 ——
           * 卡片按"宿主宽度 60% 处"摆（「ui/notes-intro.ts」的 center 公式）；
           * 宿主的左缘还在 152px 导航之后，拿视口中线比会误判（本轮首跑就红在这）。
           */
          const cx = r.left + r.width / 2;
          const hostEl = P.q('.kbw-notes');
          const hr = hostEl ? hostEl.getBoundingClientRect() : null;
          if (!hr || hr.width <= 0) {
            note('量不到模块宿主（.kbw-notes）—— "居中偏右"没法判');
          } else if (!(cx > hr.left + hr.width / 2 + 40)) {
            note('没有"居中偏右"（卡中线 x=' + Math.round(cx) + ' vs 宿主中线 ' +
              Math.round(hr.left + hr.width / 2) + '）');
          }
          // ── 内容形状：3–6 条 + 两个按钮 ──
          const items = P.qa('.kbw-noteintro-list li', el).length;
          if (items < 3 || items > 6) note('「点哪里」条数不在 3–6（实际 ' + items + '）');
          const footBtns = Array.from(el.querySelectorAll('.kbw-panel-foot .kbw-btn')).map(function (b) { return P.text(b); });
          if (footBtns.indexOf('知道了') < 0 || footBtns.indexOf('去看教程') < 0) {
            note('浮层缺按钮（' + footBtns.join(' / ') + '）');
          }
          // ── 知道了 → 关 + 旗标落盘 → 再进不再出 ──
          const okBtn = Array.from(el.querySelectorAll('.kbw-panel-foot .kbw-btn')).find(function (b) { return P.text(b) === '知道了'; });
          if (okBtn) P.click(okBtn);
          await P.wait(800);
          if (introEl()) note('点了「知道了」浮层没收');
          if (ctx.settings.get().notesIntroSeen !== true) note('「知道了」之后旗标不是 true');
          ctx.store.set({ activeModule: 'home' });
          await P.wait(700);
          ctx.store.set({ activeModule: 'notes' });
          await P.wait(1300);
          if (introEl()) note('关掉之后重进又弹了（"永不再弹"破了）');
        }
      } finally {
        await ctx.settings.save({ notesIntroSeen: orig });
        ctx.store.set({ activeModule: 'home' });
        P.closeAll(3);
        await P.wait(500);
      }
      return {
        ok: problems.length === 0,
        info: '首入弹一次 ✓ · 几何（居中偏右）· 知道了→旗标→不重弹 · 原值归还（' + String(orig) + '）' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.10 · #11/#12 助手半步：抽屉行动作（默认藏 / focus 现）· 引用面板与工作目录面板',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(5);
      await P.wait(400);
      const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      try {
        ctx.openAi();
        await P.wait(1000);
        const panel = P.lastModal();
        if (!panel) return { ok: false, info: 'AI 面板没开出来' };

        /**
         * ── #11：历史抽屉行的两枚动作（默认藏 / focus 现）──
         * ⚠️ P7.12 · R4（#16）：入口从"头部左上角图标"换成「⋯」菜单「历史对话」。
         */
        const moreBtn = panel.querySelector('.kbw-ai-morebtn');
        if (!moreBtn) note('「⋯」不在（R4 收纳）');
        else {
          click(moreBtn);
          await P.wait(400);
          const histItem = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('历史对话') >= 0; });
          if (!histItem) note('「⋯」菜单里没有「历史对话」');
          else click(histItem);
          await P.wait(900);
          const row = panel.querySelector('.kbw-ai-sess');
          if (!row) note('抽屉里没有会话行（实验库该有历史会话 —— 之前探针问过好几轮）');
          else {
            const acts = row.querySelector('.kbw-ai-sess-acts');
            if (!acts) note('行里没有动作容器（#11 回归了？）');
            else {
              const icons = acts.querySelectorAll('.kbw-iconbtn');
              if (icons.length !== 2) note('动作按钮该 2 枚，实际 ' + icons.length);
              const op0 = Number(getComputedStyle(acts).opacity);
              if (!(op0 < 0.05)) note('动作默认没藏住（computed opacity=' + op0 + '）');
              /**
               * 揭示走 **focus-within 真路径**（可编程聚焦，真 Chromium 生效）。
               * hover 那条同理但合成事件不触发 :hover（CSS 层的 hover/focus 两条选择器
               * 由 redline 静态钉着 —— 这里验的是"确实有一条能真把人放进来"）。
               */
              if (icons[0]) icons[0].focus();
              await P.wait(500);
              const op1 = Number(getComputedStyle(acts).opacity);
              if (!(op1 > 0.9)) note('焦点进入后动作没现身（opacity=' + op1 + '）');
              if (document.activeElement) document.activeElement.blur();
              await P.wait(500);
              const op2 = Number(getComputedStyle(acts).opacity);
              if (!(op2 < 0.05)) note('焦点离开后动作没收（opacity=' + op2 + '）');
              // 关抽屉：同一入口再点一次（toggle）
              click(moreBtn);
              await P.wait(400);
              const histAgain = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('历史对话') >= 0; });
              if (histAgain) click(histAgain);
              await P.wait(600);
            }
          }
        }

        // ── #12：@ 引用小面板（搜索 + 目录树 + 列表）──
        // ⚠️ P7.12 · R4（#16）：入口从独立「@」按钮换成底栏「＋」菜单「引用一篇笔记…」。
        const plusBtn = panel.querySelector('.kbw-ai-plusbtn');
        if (!plusBtn) note('「＋」不在（R4 收纳）');
        else {
          click(plusBtn);
          await P.wait(400);
          const refItem = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('引用一篇笔记') >= 0; });
          if (!refItem) note('「＋」菜单里没有「引用一篇笔记…」');
          else click(refItem);
          await P.wait(800);
          const picker = document.querySelector('.kbw-ai-refpanel');
          if (!picker) note('引用小面板没开（#12 面板化回归了？）');
          else {
            if (!picker.querySelector('.kbw-ai-refsearch')) note('引用面板里没有搜索框');
            if (!picker.querySelector('.kbw-ftree')) note('引用面板里没有目录树');
            if (picker.querySelectorAll('.kbw-ai-refitem').length < 1) note('引用面板列表一行都没有');
            P.key('Escape');
            await P.wait(500);
            if (document.querySelector('.kbw-ai-refpanel')) note('Esc 没关掉引用面板');
          }
        }

        // ── #12：工作目录（胶囊出现 → ✕ 清掉恢复全库）──
        // ⚠️ P7.12 · R4（#16）：入口从 composer 最左那枚换成「＋」菜单「工作目录…」。
        const plusBtn2 = panel.querySelector('.kbw-ai-plusbtn');
        if (!plusBtn2) note('「＋」不在（R4 收纳）');
        else {
          click(plusBtn2);
          await P.wait(400);
          const dirItem = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('工作目录') >= 0; });
          if (!dirItem) note('「＋」菜单里没有「工作目录…」');
          else click(dirItem);
          await P.wait(800);
          const dirPanel = document.querySelector('.kbw-ai-dirpanel');
          if (!dirPanel) note('工作目录面板没开');
          else {
            const node = Array.from(dirPanel.querySelectorAll('.kbw-ftree-item')).find(function (n) {
              const name = n.querySelector('.kbw-ftree-name');
              return !!name && P.text(name) === '00_Inbox';
            });
            if (!node) note('工作目录树里没有 00_Inbox');
            else {
              click(node);
              await P.wait(700);
              const chip = panel.querySelector('.kbw-ai-dirchip');
              if (!chip) note('选中目录后工作目录胶囊没出现');
              else {
                if (P.text(chip).indexOf('00_Inbox') < 0) note('胶囊没写目录名（' + P.text(chip) + '）');
                click(chip.querySelector('.kbw-ai-ref-x'));
                await P.wait(600);
                if (panel.querySelector('.kbw-ai-dirchip')) note('点 ✕ 之后胶囊还在（没恢复全库）');
              }
            }
          }
        }
      } finally {
        P.closeAll(5);
        await P.wait(400);
      }
      return {
        ok: problems.length === 0,
        info: '抽屉行动作（藏/现/收）· 引用面板结构 · 工作目录胶囊（出现/清掉）' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P6b · ② 网格 Windows 式：单击只选中 / 双击进入 / Alt+↑ / 空目录可见',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      ctx.store.set({ activeModule: 'notes' });
      await P.scopeAll();
      await P.wait(400);
      const view0 = ctx.settings.get().notesView;

      // 库根那一层：本层没笔记，但有文件夹格子
      const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir || '') === ''; });
      if (rootNode) { P.click(rootNode); await P.wait(600); }
      const cells = () => P.qa('.kbw-gcell.is-folder');
      // 等网格画出来（切档 + 点根节点之后还有一次区域重绘）
      for (let i = 0; i < 10 && cells().length === 0; i += 1) await P.wait(200);
      if (cells().length === 0) note('库根那一层没有文件夹格子（P6b ② 起这儿应该只有文件夹）');

      /** 真子目录口径：格子的 dir 集合 == 库里真实的顶层子目录集合 */
      const kbRoot = ctx.settings.kbRoot();
      const relOf = (abs) => String(abs || '').indexOf(kbRoot) === 0 ? String(abs).slice(kbRoot.length + 1) : String(abs || '');
      const realDirs = new Set();
      app.vault.getAllLoadedFiles().forEach(function (f) {
        if (!f || !f.children) return; // 只认目录（TFolder 有 children）
        if (f.parent && f.parent.path === kbRoot) realDirs.add(relOf(f.path));
      });
      const shown = new Set(cells().map(function (c) { return c.dataset.dir; }));
      realDirs.forEach(function (d) { if (!shown.has(d)) note('真实子目录「' + d + '」没在网格里（数据源还是"有笔记的目录"？）'); });

      /** 单击 = 选中（不进目录）；双击 = 进入 */
      const c0 = cells()[0];
      const dir0 = c0.dataset.dir;
      const before2 = ctx.settings.get().treeSelected;
      P.click(c0);
      await P.wait(400);
      if (!c0.classList.contains('is-selected')) note('单击没有选中文件夹格子');
      if (ctx.settings.get().treeSelected !== before2) note('单击就进目录了（P6b ② 起那是双击的活）');
      // 双击：真派两下 click + dblclick
      const r = c0.getBoundingClientRect();
      const pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      P.elAt(pt.x, pt.y).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y }));
      P.elAt(pt.x, pt.y).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y }));
      P.elAt(pt.x, pt.y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y }));
      await P.wait(700);
      if (ctx.settings.get().treeSelected !== dir0) {
        note('双击没进目录（期望 ' + dir0 + '，实际 ' + ctx.settings.get().treeSelected + '）');
      }
      const crumbs = P.q('.kbw-crumbs-count');
      if (crumbs && P.text(crumbs).indexOf('本层') !== 0) note('面包屑没写「本层 N 篇」（实际 ' + P.text(crumbs) + '）');

      // Alt+↑ 回上一级
      const host = P.q('.kbw-notes') || document.body;
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
      /**
       * ⚠️ **轮询等它落定**（最多 2 秒）：目录是**防抖 400ms 落盘**的，而"落盘 → 外壳
       * store → 模块可能重挂一次"这条链在真机上要几百毫秒 —— 固定 700ms 会假红
       *（实测：手动派这一发是好的，步骤里等太短）。
       */
      let upOk = false;
      for (let i = 0; i < 10; i += 1) {
        await P.wait(220);
        if (ctx.settings.get().treeSelected === '') { upOk = true; break; }
      }
      if (!upOk) note('Alt+↑ 没回上一级（实际 ' + ctx.settings.get().treeSelected + '）');

      // 树上的数字要写明口径（含子目录）
      let cnt = null;
      for (let i = 0; i < 8 && !cnt; i += 1) {
        cnt = P.q('.kbw-tree-item .kbw-tree-count');
        if (!cnt) await P.wait(200);
      }
      if (!cnt) note('树上找不到那个数字（.kbw-tree-count）');
      else if ((cnt.getAttribute('aria-label') || '').indexOf('含子目录') < 0) {
        note('树上那个数字没写「含子目录」（aria-label=' + (cnt.getAttribute('aria-label') || '(没有)') + '）');
      }
      // 收尾：视图档拨回基线（P7.1 两档化：只可能是 grid / detail）
      if (view0) P.qa('.kbw-seg button').forEach(function (b) {
        if (P.text(b) === (view0 === 'grid' ? '网格' : '详细信息')) P.click(b);
      });
      await P.wait(400);
      return {
        ok: problems.length === 0,
        info: '文件夹格子 ' + cells().length + ' 个｜真实子目录 ' + realDirs.size + ' 个｜单击只选中 / 双击进入 / Alt+↑ / 含子目录 tooltip' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-② 网格文件夹.png',
  },
  {
    name: 'P6b · ④ 手势分流：Ctrl+Shift+滚轮改窗口 · Ctrl+滚轮在正文上改字号（没被平台吃掉）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      ctx.store.set({ activeModule: 'board' });
      await P.wait(900);

      const card = P.q('[data-card] .kbw-card-t') || P.q('[data-card]');
      if (!card) return { ok: false, info: '看板上没有卡片' };
      P.click(card);
      await P.wait(900);
      const panel = P.q('.kbw-cw-panel');
      if (!panel) return { ok: false, info: '小窗没开出来' };

      /** 一发真滚轮（带修饰键）——先确认**我们收到了**（处理器跑 = 没被平台吞掉） */
      /**
       * 一发真滚轮（带修饰键）。⚠️ **直接打在目标元素上**，不用 elementFromPoint 找 ——
       * 面板里层套层（.cm-content / .cm-scroller / .kbw-cw-editor），
       * 取到的那个点未必落在我们想验的那一层上（第一次跑就是这么把"正文上缩字"
       * 判成"改了窗口"的）。
       */
      const wheelAt = (el, init) => {
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + Math.min(r.width / 2, 60));
        const y = Math.round(r.top + Math.min(r.height / 2, 20));
        el.dispatchEvent(new WheelEvent('wheel', Object.assign({
          bubbles: true, cancelable: true, clientX: x, clientY: y,
        }, init)));
      };
      const rootW = P.q('.kbw-root');
      const rootW0 = rootW ? Math.round(rootW.getBoundingClientRect().width) : 0;

      // ① Ctrl+Shift+滚轮（任意处）→ 改窗口尺寸
      const head = P.q('.kbw-cw-panel .kbw-panel-head');
      const before = Math.round(panel.getBoundingClientRect().width);
      wheelAt(head, { ctrlKey: true, shiftKey: true, deltaY: -120 });
      await P.wait(400);
      const after = Math.round(panel.getBoundingClientRect().width);
      if (!(after > before)) note('Ctrl+Shift+滚轮 没有把窗口放大（' + before + ' → ' + after + '）—— 被平台吃掉了？');
      const badge = P.q('.kbw-cw-size');
      if (!badge || !badge.classList.contains('is-on')) note('没有出现「宽 × 高」那一行浮标');
      else if (P.text(badge).indexOf('×') < 0) note('浮标文案不对：' + P.text(badge));

      // ② Ctrl+滚轮 在**面板头**上 → 也改窗口（用户的语义是"正文上才缩字"）
      const w1 = Math.round(panel.getBoundingClientRect().width);
      wheelAt(head, { ctrlKey: true, deltaY: -120 });
      await P.wait(400);
      const w2 = Math.round(panel.getBoundingClientRect().width);
      if (!(w2 > w1)) note('Ctrl+滚轮 在面板头上没有改窗口（' + w1 + ' → ' + w2 + '）');

      // ③ Ctrl+滚轮 在**正文**上 → 改这一篇的字号（窗口不该变）
      const body = P.q('.kbw-cw-panel .cm-content') || P.q('.kbw-cw-panel .kbw-cw-editor');
      const bodySel = P.q('.kbw-cw-panel .cm-content') ? '.cm-content' : '.kbw-cw-editor';
      if (!body) {
        note('找不到正文容器（跳过了"正文上缩字"那半条）');
      } else {
        const w3 = Math.round(panel.getBoundingClientRect().width);
        const fs0 = parseFloat(getComputedStyle(body).fontSize);
        wheelAt(body, { ctrlKey: true, deltaY: -120 });
        await P.wait(700);
        const fs1 = parseFloat(getComputedStyle(body).fontSize);
        const w4 = Math.round(panel.getBoundingClientRect().width);
        if (!(fs1 > fs0)) note('Ctrl+滚轮 在正文（' + bodySel + '）上没有把字号调大（' + fs0 + ' → ' + fs1 + '）');
        if (Math.abs(w4 - w3) > 4) note('正文上滚轮把**窗口**也改了（' + w3 + ' → ' + w4 + '，两件事该互不干扰）');
      }

      // ④ 平台自己的界面缩放**没被我们带跑**（拿工作台根元素的几何当尺子）
      const rootW1 = rootW ? Math.round(rootW.getBoundingClientRect().width) : 0;
      if (rootW0 && Math.abs(rootW1 - rootW0) > 4) {
        note('整个工作台被缩放了（' + rootW0 + ' → ' + rootW1 + '）—— preventDefault 的范围没控住');
      }
      P.closeAll(3);
      await P.wait(600);
      return {
        ok: problems.length === 0,
        info: '窗口 ' + before + '→' + after + 'px｜浮标=' + (badge ? P.text(badge) : '(无)') +
              '｜工作台宽度 ' + rootW0 + '→' + rootW1 +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-④ 手势分流.png',
  },
  {
    name: 'P6b · ③ 悬浮窗：一文件一扇窗 · 点到已开闪一下 · 拖头合并 · 拖 tab 拆窗',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      /**
       * ⚠️ **点导航切看板，不能只「store.set」**（P2 的老坑，P7.2c 又栽一次）：
       * 只 store.set 的话 settings.activeModule 还是旧值 —— 而这一步里
       * **拖窗结束要写「panelGeo」（settings.save，P7.2c 新功能）** →
       * applySettingsToStore 把 activeModule 顶回旧值 → 看板模块**整体重挂** →
       * keepPinnedPanel 把两扇小窗全关掉（症状："松手之后没并成一扇（0）"）。
       */
      const navB = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('看板') >= 0; });
      if (navB) P.click(navB);
      else ctx.store.set({ activeModule: 'board' });
      await P.wait(900);

      const cards = P.qa('[data-card]');
      if (cards.length < 2) return { ok: false, info: '看板卡片不足两张' };
      const paths = cards.slice(0, 2).map(function (c) { return c.dataset.path; });
      /**
       * 🔴 **每次点之前重新取那张卡**：面板一开，看板就重画过，先前拿到的 DOM 引用
       * 已经是**游离节点** —— 点它等于没点（真机实测：闪一下那条判据因此恒假）。
       */
      const clickCardByPath = (path) => {
        const c = P.qa('[data-card]').find(function (el) { return el.dataset.path === path; });
        if (!c) return false;
        P.click(c.querySelector('.kbw-card-t') || c);
        return true;
      };
      const panels = () => P.qa('.kbw-cw-panel');
      const pages = (root) => Array.from(root.querySelectorAll('.kbw-cw-page')).map(function (p) { return p.dataset.path; });
      const leaves = () => P.qa('.kbw-cw-leaf').length;

      // ① 单击两篇 = **两扇窗**（一文件一扇窗）
      if (!clickCardByPath(paths[0])) note('点不到第一张卡（DOM 重绘？）');
      await P.wait(1000);
      if (!clickCardByPath(paths[1])) note('点不到第二张卡');
      await P.wait(1000);
      if (panels().length !== 2) note('单击两篇该开两扇窗（实际 ' + panels().length + '）');

      // ② 再点第一张 → 不新开，抬到最前 + 闪一下
      if (!clickCardByPath(paths[0])) note('第二下点不到第一张卡');
      /**
       * ⚠️ **点完"立刻"查**（同步那一瞬间）：动画只有 600ms，
       * 而 animationend 一到类就被摘了 —— 隔着一堆 await 再查会「看不见」
       *（第一版就是这么写错的：判据等 80ms，实测类确实在、但那一趟的时序不同）。
       * 降级形态（动效=减少）是 is-flash-static，两种都算数。
       */
      const flashedSync = panels().filter(function (p) {
        return p.classList.contains('is-flash') || p.classList.contains('is-flash-static');
      }).length;
      await P.wait(80);
      if (panels().length !== 2) note('点到已开的笔记又开了一扇（' + panels().length + '）');
      const flashed80 = panels().filter(function (p) {
        return p.classList.contains('is-flash') || p.classList.contains('is-flash-static');
      }).length;
      if (flashedSync !== 1 && flashed80 !== 1) {
        note('点到已开的那一篇应该**闪一下**（同步查到 ' + flashedSync + ' 扇、80ms 后 ' + flashed80 +
             ' 扇；类名=' + panels().map(function (p) { return p.className; }).join(' / ') + '）');
      }
      await P.wait(500);
      if (leaves() !== 2) note('这一刻该有两个活编辑器（实际 ' + leaves() + '）');

      // ③ 拖**窗 A 的头**到窗 B 身上 → 合并成一扇、两页
      const A = panels()[0];
      const B = panels()[1];
      /**
       * ⚠️ **起手点要落在头的"空白"那一段**（左边那几像素的内边距）：头的中间是
       * **标题输入框**（P6b ⑤ 起它就是输入框），点在上面不会起拖动。
       */
      const headA = P.q('.kbw-panel-head', A);
      const ra = headA.getBoundingClientRect();
      const from = { x: Math.round(ra.left + 5), y: Math.round(ra.top + Math.min(ra.height / 2, 18)), visible: ra.height > 0 };
      const headB = P.q('.kbw-panel-head', B);
      void headB;
      /**
       * ⚠️ 目标点要落在 B 的**窗身**上（不是它的头 —— 头也是拖拽源）。
       * 取 B 的中心偏下一点，确保 elementFromPoint 拿到的是 B 这个窗。
       */
      const rb = B.getBoundingClientRect();
      const drop = { x: Math.round(rb.left + rb.width / 2), y: Math.round(rb.top + Math.min(rb.height - 20, 120)) };
      if (from && from.visible) {
        // 真拖：按下 → 越过 4px 阈值 → 移到目标 → 松手
        P.pointerDownAt(from.x, from.y);
        await P.wait(60);
        P.pointerMoveTo(from.x + 12, from.y + 12);
        await P.wait(60);
        P.pointerMoveTo(drop.x, drop.y);
        await P.wait(160);
        const target = P.qa('.kbw-cw-panel').filter(function (p) { return p.classList.contains('is-merge-target'); });
        const srcCls = A.classList.contains('is-merge-source');
        if (target.length !== 1) {
          note('拖到另一扇身上时目标窗没被点亮（is-merge-target ' + target.length +
               '，源窗 is-merge-source=' + srcCls + '，落点 ' + drop.x + ',' + drop.y +
               ' 上是 ' + String((P.elAt(drop.x, drop.y).className || '')).slice(0, 40) + '）');
        }
        const hint = P.q('.kbw-panel-merge-hint');
        if (!hint) note('没有「松手并入这一扇」那条提示');
        P.pointerUpAt(drop.x, drop.y);
        await P.wait(900);
        if (panels().length !== 1) note('松手之后没并成一扇（' + panels().length + '）');
        else if (pages(panels()[0]).length !== 2) note('合并之后该有两页（' + pages(panels()[0]).length + '）');
        if (leaves() !== 2) note('合并之后叶的总数该还是 2（实际 ' + leaves() + '，搬的不是同一个节点？）');
      } else {
        note('取不到源窗头部的坐标（跳过了合并那一段）');
      }

      // ④ 拖 **tab 出去** → 拆成一扇新窗
      const alone = panels()[0];
      const tabs = P.qa('.kbw-cw-tab', alone);
      if (tabs.length >= 2) {
        const tb = P.qa('.kbw-cw-tab', alone)[1];
        const src = P.rectAt(tb);
        const rp = alone.getBoundingClientRect();
        // 落点：窗**外面**的空白（往右下角挪一段，保证在外面）
        const out = {
          x: Math.round(Math.min(window.innerWidth - 40, rp.right + 120)),
          y: Math.round(Math.min(window.innerHeight - 40, rp.bottom + 80)),
        };
        if (src) {
          const beforeCount = panels().length;
          P.pointerDownAt(src.x, src.y);
          await P.wait(60);
          P.pointerMoveTo(src.x + 12, src.y + 12);
          await P.wait(60);
          P.pointerMoveTo(out.x, out.y);
          await P.wait(120);
          P.pointerUpAt(out.x, out.y);
          await P.wait(900);
          if (panels().length !== beforeCount + 1) {
            note('拖 tab 到窗外该拆出一扇新窗（' + beforeCount + ' → ' + panels().length + '）');
          }
          const newOne = panels().find(function (p) { return pages(p).length === 1; });
          if (!newOne) note('拆出来的那一扇该只有一篇');
        }
      } else {
        note('合并之后 tab 条上没有两篇（跳过了拆窗那一段）');
      }

      P.closeAll(4);
      await P.wait(700);
      const left = P.qa('.kbw-cw-panel').length + P.qa('.kbw-cw-leaf').length;
      if (left !== 0) note('收尾之后还留着 ' + left + ' 个面板/叶');
      return {
        ok: problems.length === 0,
        info: '两扇→合并一扇→拆出一扇｜提示条 / 目标高亮 / 叶数不变 逐条查' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-③ 悬浮窗合并.png',
  },
  {
    name: 'P6b · ⑤⑥ 小窗顶部压缩（非正文一行）· 默认字号 = 平台−2 · 预览换行真机生效',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      ctx.store.set({ activeModule: 'board' });
      await P.wait(900);
      const card = P.q('[data-card] .kbw-card-t') || P.q('[data-card]');
      if (!card) return { ok: false, info: '看板上没有卡片' };
      P.click(card);
      await P.wait(1000);
      const panel = P.q('.kbw-cw-panel');
      if (!panel) return { ok: false, info: '小窗没开出来' };

      // ⑤-1 非正文部分的总高度（头 + tab 条 + 任何 kbw-cw-row / 「正文」标签）
      const body = P.q('.kbw-cw-panel .kbw-cw-page');
      const head = P.q('.kbw-cw-panel .kbw-panel-head');
      const rp = panel.getBoundingClientRect();
      const rb = body ? body.getBoundingClientRect() : null;
      const nonBody = rb ? Math.round(rb.top - rp.top) : -1;
      const headH = head ? Math.round(head.getBoundingClientRect().height) : -1;
      /**
       * 🔴 **几何判据要写成双边**（独立审查 §5.1）：只写「大于 64」的话，"量到 0"
       * （窗口不可见 / 取不到元素）会**空过** —— 本项目踩过的老形状。
       */
      if (!(nonBody > 0 && nonBody <= 64)) {
        note('非正文那一段的高度不对劲：' + nonBody + 'px（目标 ≈ 57，改前 ≈ 140）');
      }
      /**
       * ⚠️ **别拿 .kbw-cw-row 当"标题行还在"的判据**（独立审查 A🟡5）：那个类名现在正是
       * **属性行**的（propRow）—— 用户把「小窗属性」调成前 6 行时，这一步会报一条
       * 与声明无关的假红。改成正面判据：标题输入框在**面板头**里（下面那条）就够了。
       */
      if (P.qa('.kbw-cw-page .kbw-cw-k').some(function (k) { return P.text(k) === '标题'; })) {
        note('页里还留着一行「标题」标签 —— P6b ⑤ 起标题并进面板头');
      }
      const secs = P.qa('.kbw-cw-sec').map(function (x) { return P.text(x); });
      if (secs.indexOf('正文') >= 0) note('「正文」那个标签还在（P6b ⑤ 起不该画）');
      // 标题输入框必须**在面板头那一行里**
      const titleIn = P.q('.kbw-cw-panel .kbw-panel-head .kbw-cw-title');
      if (!titleIn) note('标题输入框不在面板头里（.kbw-panel-head .kbw-cw-title）');
      const tabStrip = P.q('.kbw-cw-panel .kbw-cw-tabs');
      if (tabStrip && tabStrip.style.display !== 'none') note('只有一篇时 tab 条不该显示');

      // ⑤-2 默认字号 = 平台 − 2（真机量的 computed）
      const cm = P.q('.kbw-cw-panel .cm-content');
      const base = parseFloat(getComputedStyle(document.body).getPropertyValue('--font-text-size')) || 16;
      const fs = cm ? parseFloat(getComputedStyle(cm).fontSize) : NaN;
      if (!cm) note('找不到编辑器正文（.cm-content），字号这条跳过了');
      else if (Math.abs(fs - (base - 2)) > 1.5) {
        note('小窗正文默认字号该是平台 ' + base + ' − 2 = ' + (base - 2) + '（实际 ' + fs + '）');
      }

      // ⑥ 预览换行：卡片摘要的 computed white-space / overflow-wrap
      P.closeAll(3);
      await P.wait(700);
      const cardBody = P.q('.kbw-card-body');
      if (!cardBody) note('看板上没有卡片正文（.kbw-card-body）');
      else {
        const csNormal = getComputedStyle(cardBody);
        if (String(csNormal.overflowWrap) !== 'anywhere') {
          note('卡片正文没有折行（overflow-wrap = ' + csNormal.overflowWrap + '）');
        }
        if (String(csNormal.whiteSpace) === 'nowrap') note('卡片正文默认该是正常折行（现在是 nowrap）');
      }

      // 关掉换行 → 真机样式跟着变（view.previewWrap = false）
      const ctx2 = P.ctx();
      if (ctx2 && ctx2.configs) {
        const raw = await ctx2.configs.read('board');
        const backup = JSON.parse(JSON.stringify(raw));
        await ctx2.configs.write('board', Object.assign({}, raw, {
          view: Object.assign({}, raw.view, { previewWrap: false }),
        }));
        await P.wait(1200);
        const after = P.q('.kbw-card-body');
        const cs2 = after ? getComputedStyle(after) : null;
        if (!after || !after.classList.contains('is-nowrap')) {
          note('关掉「预览换行」之后卡片没有切到横向滚动（没有 is-nowrap）');
        } else if (String(cs2.whiteSpace) !== 'nowrap') {
          note('关掉之后 white-space 不是 nowrap（实际 ' + cs2.whiteSpace + '）');
        }
        await ctx2.configs.write('board', backup);
        await P.wait(1200);
        const back = P.q('.kbw-card-body');
        if (back && back.classList.contains('is-nowrap')) note('切回折行之后 is-nowrap 没摘掉');
      } else {
        note('拿不到库内配置读写口（跳过换行开关那两半）');
      }

      P.closeAll(3);
      await P.wait(600);
      return {
        ok: problems.length === 0,
        info: '非正文 ' + nonBody + 'px（头 ' + headH + '，改前 ≈140）｜正文字号 ' + (Number.isFinite(fs) ? fs : '?') +
              'px（平台 ' + base + '−2）｜换行开关切了两趟' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-⑤⑥ 小窗顶部与换行.png',
  },
  {
    name: 'P6b · ⑦⑧+④-A 设置栏标题有分隔线 · **顶栏列头槽**（三列头同一基线 / 槽宽 == 目录栏宽）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      // ⑦ 设置面板：栏标题下有一条通栏分隔线，且**离下面那一组比离上面更近**
      ctx.openWorkbenchSettings();
      await P.wait(1400);
      const modal = P.lastModal();
      if (!modal) return { ok: false, info: '设置面板没开' };
      const h = P.q('.kbw-set-h', modal);
      let border = '';
      if (!h) note('找不到栏标题（.kbw-set-h）');
      else {
        const cs = getComputedStyle(h);
        border = cs.borderBottomWidth + ' ' + cs.borderBottomStyle;
        /**
         * ⚠️ **别拿「>= 1px」当判据**：真机 DPR 1.5 时，1px 会报成 **0.6667px**
         *（第一次跑就是这么假红的）。判"有没有这条线"要看"宽度 > 0 且是实线"。
         */
        if (!(parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle === 'solid')) {
          note('栏标题下没有分隔线（border-bottom = ' + border + '）');
        }
        const rH = h.getBoundingClientRect();
        const group = P.q('.kbw-set-group', modal);
        if (group) {
          const rG = group.getBoundingClientRect();
          const below = Math.round(rG.top - rH.bottom);
          // 上面那一块：栏标题自己上面的空白（拿左栏起点近似不了，就用"标题高度 + 下间距"比）
          const above = Math.round(parseFloat(cs.marginTop || '0'));
          if (!(below < 40)) note('栏标题离下面那一组太远（' + below + 'px）—— 层次没拉开');
          void above;
        }
      }
      P.key('Escape');
      await P.wait(800);

      /**
       * ⑧+④-A **顶栏列头槽**（P6 段⑥ 换的实现 —— 老那段「::before 灰带」已经没有了）
       *
       * 量四件事：
       *   ① 三个列头（经纬 / 目录 / 全部笔记）的文字块**中心**在同一水平线上
       *   ② 槽宽 == 目录栏宽（两处读同一个变量 --kbw-col-w）
       *   ③ 灰底连成一条通高带：槽底接上目录栏顶、槽顶铺满顶栏那一行
       *   ④ 灰底同色 + **目录树里不再有表头那一行**（只能是"搬走了"，不能两边都有/两边都没有）
       *
       * ⚠️ 判据一律**双边**（写成 大于 0 且 小于等于 2）：只有上界的话，
       *   窗口不可见时量到 0 会**假绿**（P6b 那条老账）。
       * ⚠️ 这四条**取代**了改前量 ::before 的三条（宽度 / 上缘 / padding-left）——
       *   改了实现还留着老判据，就是"看着在测、其实在看一个已经不存在的伪元素"。
       */
      ctx.store.set({ activeModule: 'notes' });
      await P.wait(900);
      const slot = P.q('.kbw-colslot');
      const side = P.q('.kbw-notes-side');
      const topbar = P.q('.kbw-topbar');
      /**
       * ⚠️ nav 得**自己取**：原稿那句 const nav = P.q('.kbw-nav') 在 ⑦ 段里，
       * 而 ⑧ 段是另起的（本轮重写这一段时把它一起删了 → 真机第一次跑就
       * ReferenceError: nav is not defined，整步什么都没验）。
       */
      const nav = P.q('.kbw-nav');
      let headDy = null;
      let slotW = 0;
      let slotBg = '';
      if (!nav || !slot || !side || !topbar) {
        note('找不到导航栏 / 列头槽 / 目录栏 / 顶栏（类名变了？）');
      } else {
        const rs = side.getBoundingClientRect();
        const rt = topbar.getBoundingClientRect();
        const rl = slot.getBoundingClientRect();
        // ① 三列头的**文字块中心**对齐（量文字，不量容器：容器高度不一样，中心会差）
        const heads = [
          ['经纬', P.q('.kbw-brand-name')],
          ['目录', P.q('.kbw-tree-title')],
          ['全部笔记', P.q('.kbw-topbar h2')],
        ];
        const ys = [];
        for (const pair of heads) {
          const el = pair[1];
          if (!el) {
            note('找不到列头「' + pair[0] + '」');
            continue;
          }
          const r = el.getBoundingClientRect();
          if (!(r.height > 0 && r.width > 0)) {
            note('列头「' + pair[0] + '」量不到几何：' + P.zeroGeoWhy(el));
            continue;
          }
          ys.push(Math.round(r.top + r.height / 2));
        }
        if (ys.length === 3) {
          headDy = Math.max.apply(null, ys) - Math.min.apply(null, ys);
          /**
           * ⚠️ **差值这里只判上界**（<= 2），**不要**再写 headDy 大于 0。
           *
           * "0 = 量不到"那条守卫的正确落点是**每一个测量本身**（上面已经用
           * r.height 与 r.width 都大于 0 + zeroGeoWhy 逐个挡住了）——
           * 搬到"差值"上就变成"**完美对齐（0）反而算失败**"。
           * 真机第一次跑就是这么红的：三个中心都是 121、差 0px，判据却说不在同一基线。
           * 那条双边纪律管的是**长度/高度**类判据（0 是个可疑的读数），不是"两个读数之差"。
           */
          if (!(headDy <= 2)) {
            note('三个列头不在同一基线：中心差 ' + headDy + 'px（' + ys.join(' / ') + '）');
          }
        }
        // ② 槽宽 == 目录栏宽
        slotW = Math.round(rl.width);
        if (!(slotW > 0 && Math.abs(slotW - Math.round(rs.width)) <= 2)) {
          note('槽宽 ' + slotW + ' 与目录栏宽 ' + Math.round(rs.width) + ' 不一致');
        }
        // ③ 灰底连成一条通高带
        const seam = Math.round(Math.abs(rl.bottom - rs.top));
        if (!(seam <= 2)) note('列头槽与目录栏接不上：缝 ' + seam + 'px');
        if (Math.abs(rl.top - rt.top) > 1) note('列头槽没有铺满顶栏那一行（顶边对不上）');
        const gapX = Math.round(rt.left - nav.getBoundingClientRect().right);
        if (gapX > 2) note('导航栏与顶栏之间空着 ' + gapX + 'px（两块灰底中间露白）');
        // ④ 同色 + 树表头那一行真的没了
        slotBg = getComputedStyle(slot).backgroundColor;
        const sideBg = getComputedStyle(side).backgroundColor;
        if (slotBg !== sideBg) note('列头槽的底色与目录栏不一致（' + slotBg + ' vs ' + sideBg + '）');
        if (P.q('.kbw-notes-side .kbw-tree-head')) {
          note('目录树里还留着一份表头（那一行该整行取消）');
        }
        if (!P.q('.kbw-colslot .kbw-tree-title')) note('「目录」两个字没在槽里（标题不能两边都没有）');
        /**
         * 🔴 **触屏那一支也要量**（P6b 独立审查 A🔴2 的老账）：触屏目录栏是 168 不是 208 ——
         * 临时挂上 body.is-mobile 量一遍再摘掉（不改用户的真实状态）。
         */
        const wasMobile = document.body.classList.contains('is-mobile');
        document.body.classList.add('is-mobile');
        await P.wait(400);
        const sideM = P.q('.kbw-notes-side');
        const slotM = P.q('.kbw-colslot');
        const wSideM = sideM ? Math.round(sideM.getBoundingClientRect().width) : 0;
        const wSlotM = slotM ? Math.round(slotM.getBoundingClientRect().width) : 0;
        if (!(wSideM > 0 && wSlotM > 0 && Math.abs(wSlotM - wSideM) <= 2)) {
          note('触屏档（body.is-mobile）下槽 ' + wSlotM + ' 与目录栏 ' + wSideM + ' 不一致');
        }
        /**
         * ⚠️ **还要把 168 这个数钉住**（独立审查 A🟢10 指出的）：只判"两处一致"的话，
         * 把 mobile.css 那条 168 **整条删掉**照样绿 —— 两个数会一起变成 208，
         * "一致"依旧成立。而 168 是**规格里写死的触屏口径**
         *（P6b A🔴2 那条账就是"灰带 208 vs 目录栏 168"）。
         */
        if (wSideM !== 168) note('触屏档目录栏宽 ' + wSideM + '（规格写的是 168）');
        if (!wasMobile) document.body.classList.remove('is-mobile');
        await P.wait(300);
      }
      return {
        ok: problems.length === 0,
        info: '栏标题分隔线 = ' + border + '｜三列头中心差 ' + (headDy === null ? '?' : headDy) + 'px｜槽宽 ' + slotW +
              'px（色 ' + slotBg + '）' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6b-⑦⑧ 设置与目录栏.png',
  },

  /* ══════════════════════════════════════════════════════════════════
     P6 段⑤ 打磨轮（2026-09-28）—— ① ② ③ ⑦ ⑧ + 断点复验 + 看板选择模式
     每条都对应 「归档/设计建议-收尾优化轮.md」 §1/§2 里量到的那个数字。
     口径统一：**几何判据一律双边**（单边上界遇到"量到 0"会假绿 —— P6 那笔血账）。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P6⑤ · ① 勾选框：箱与字居中对齐 + 有间距（稿子那两条容器规则）· ② 设置栏只有一个标题',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      // ── ① 「自动排列」在**网格档的排序条**上（这是唯一一个自研 .kbw-chk）
      const view0 = ctx.settings.get().notesView;
      ctx.store.set({ activeModule: 'notes' });
      await P.wait(700);
      const gridBtn = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '网格'; });
      if (gridBtn) { P.click(gridBtn); await P.wait(800); }
      const chk = P.q('.kbw-sortbar .kbw-chk');
      let geo = '';
      if (!chk) note('找不到 .kbw-sortbar .kbw-chk（没进网格档？）');
      else {
        const box = chk.querySelector('i');
        const txt = chk.querySelector('span');
        if (!box || !txt) note('勾选框里没有 i / span');
        else {
          const rb = box.getBoundingClientRect();
          const rt = txt.getBoundingClientRect();
          const dy = Math.abs((rb.top + rb.height / 2) - (rt.top + rt.height / 2));
          const gap = rt.left - rb.right;
          geo = '箱中心−文字中心 ' + dy.toFixed(2) + 'px ｜ 箱右缘→字左缘 ' + gap.toFixed(2) + 'px';
          /**
           * 🔴 量到的修复前：dy = 1.8px、gap = 0（箱右缘贴着「自」）。
           * 双边：对齐 ≤1px；间距 4–12px（稿子 gap:6px，允许 ±，但**不许是 0**）。
           */
          if (!(dy <= 1)) note('箱与字没居中对齐：差 ' + dy.toFixed(2) + 'px（口径 ≤1）');
          if (!(gap >= 4 && gap <= 12)) note('箱与字的间距 = ' + gap.toFixed(2) + 'px（口径 4–12，稿子 6）');
          if (!(rb.width >= 12 && rb.width <= 16)) note('箱的宽 = ' + rb.width.toFixed(1) + 'px（稿子 13）');
        }
      }

      // ── ② 设置栏：一栏里 h2/h3 **恰好一个**；左栏每一项都有悬停提示
      ctx.openWorkbenchSettings();
      await P.wait(1500);
      const modal = P.lastModal();
      let headInfo = '';
      if (!modal) note('设置面板没开');
      else {
        const tabs = P.qa('.kbw-set-tab', modal).filter(function (t) { return !t.classList.contains('is-ghost'); });
        const bad = [];
        for (const t of tabs) {
          P.click(t);
          await P.wait(420);
          const main = P.q('.kbw-set-main', modal);
          const heads = P.qa('h2, h3', main).map(function (h) { return P.text(h); });
          if (heads.length !== 1) bad.push(P.text(t) + '=' + heads.length + '[' + heads.join('/') + ']');
        }
        if (bad.length) note('有栏的标题不是恰好 1 个：' + bad.join('，'));
        const noTitle = tabs.filter(function (t) { return !(t.getAttribute('title') || '').trim(); })
          .map(function (t) { return P.text(t); });
        if (noTitle.length) note('左栏项没有悬停提示：' + noTitle.join('、'));
        headInfo = '七栏标题数=' + (bad.length ? bad.join('，') : '各 1 ✓') +
                   '｜左栏 title 空=' + (noTitle.length ? noTitle.join('、') : '无 ✓');
      }
      P.key('Escape');
      await P.wait(800);

      /**
       * ⑩ 对表补一条：**分段控件的内层按钮必须是方角**（稿子 .seg 是"外层圆角 + overflow 裁"）。
       * 平台的 button 自带 border-radius: var(--button-radius)（默认 5px），
       * 而 base.css 那组按钮复位**不含圆角** —— 少写一行 border-radius: 0，
       * 中段按钮的 hover / 当前档就变成 5px 圆角小块、格间还露缝
       *（P6⑤ 独立审查 A5 抓到的回归：我在搬内边距时把它连带删了）。
       */
      const segBtn = P.qa('.kbw-seg button')[0];
      let segRadius = '(没有 .kbw-seg button)';
      if (segBtn) {
        segRadius = getComputedStyle(segBtn).borderTopLeftRadius;
        if (parseFloat(segRadius) !== 0) note('分段控件的按钮圆角 = ' + segRadius + '（口径 0px，方角）');
      }

      /**
       * 收尾：视图档是**落盘偏好**，探针动过就得还回去（否则下一轮前面的表格类步骤看到 0 行）。
       * ⚠️ 用 try/finally：中途抛异常（选择器没找到之类）**也要还回去** ——
       * 否则这一轮把库状态留脏，**下一轮**的判据会以看不懂的样子红（2026-09-28 真踩过）。
       */
      try {
        return {
          ok: problems.length === 0,
          info: '① ' + (geo || '没量到') + '｜② ' + headInfo + '｜seg 按钮圆角=' + segRadius +
                (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        if (view0 !== ctx.settings.get().notesView) {
          await ctx.settings.save({ notesView: view0 });
          await P.wait(500);
        }
      }
    })()`,
    shot: 'P6⑤-①② 勾选框与设置标题.png',
  },

  {
    name: 'P6⑤ · ③ 打开工作台收起左侧栏：开关开着 → collapsed=true 且工作台变宽（>640）· 关掉 → 一个字都不碰',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      const ws = app.workspace;
      const split = ws.leftSplit;
      if (!split) return { ok: false, info: '这台机器上拿不到 workspace.leftSplit' };
      P.closeAll(4);
      await P.wait(300);

      const settings = ctx.settings;
      const setting0 = settings.get().collapseSidebarOnOpen;
      const collapsed0 = split.collapsed;
      const winW = Math.round(window.innerWidth);
      const rootW = function () {
        const r = P.q('.kbw-root');
        return r ? Math.round(r.getBoundingClientRect().width) : -1;
      };
      /** 走**用户那条路**：关掉工作台那一页 → 执行「打开工作台」命令 */
      const reopen = async () => {
        ws.getLeavesOfType('kb-workbench-view').forEach(function (l) { l.detach(); });
        await P.wait(500);
        app.commands.executeCommandById('kb-workbench:open');
        await P.wait(1500);
      };
      await P.ensureWorkbench();
      await P.wait(700);

      /**
       * ⚠️ 摆状态要用 expand()，**不能给 collapsed 赋值**（真机实测赋值是静默无效的 ——
       * 同一个文件 ② 那条注释写着，这里第一版自己违反了）。expand 不在就退回赋值（老版本）。
       */
      const openSidebar = function () {
        if (typeof split.expand === 'function') split.expand();
        else split.collapsed = false;
      };
      // ① 开关开着：侧栏开着 → 打开工作台之后该被收起、工作台应该变宽
      await settings.save({ collapseSidebarOnOpen: true });
      openSidebar();
      await P.wait(700);
      /** 侧栏此刻**真的占宽度吗**（空侧栏 / 抽屉态可能是 0）—— 决定"变宽"那条适不适用 */
      const sideEl = function () {
        const el = P.q('.mod-left-split');
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
      };
      const wWithSidebar = rootW();
      const sideW = sideEl();
      await reopen();
      const collapsedOn = split.collapsed === true;
      const wAfter = rootW();
      if (!collapsedOn) note('开关开着，但打开工作台没收起侧栏');
      /**
       * 🔴 **双边**：> 640（"窄档"那条线，正是这个功能要解决的事：修前量到 586 → 目录栏被
       * 窄档 CSS 整个藏掉）且 < 窗口宽（否则量到的不是这个容器）。
       */
      if (!(wAfter > 640)) note('打开之后工作台容器只有 ' + wAfter + 'px（口径 >640）');
      if (!(wAfter < winW)) note('工作台容器 ' + wAfter + ' 不小于窗口宽 ' + winW + '（量错元素了？）');
      /**
       * "变宽"这条**只在侧栏真占宽度时才成立**：这台机器上侧栏内容为空时它只有 ~0px
       * （实测：collapsed=false 时 .mod-left-split 就是 0），那时"收起来"当然不会让谁变宽。
       * ⚠️ 这是**降级**，不是放宽 —— 判据在 info 里**如实说**这一条这次适不适用
       *（本项目那条纪律：降级要说清，不许悄悄算过）。
       */
      const wantWider = sideW > 60;
      if (wantWider && !(wAfter > wWithSidebar + 60)) {
        note('收起侧栏之后容器没变宽（' + wWithSidebar + ' → ' + wAfter + '，侧栏当时 ' + sideW + 'px）');
      }

      // ② 开关关掉：同一个动作，侧栏必须原样留着
      await settings.save({ collapseSidebarOnOpen: false });
      openSidebar();
      await P.wait(400);
      await reopen();
      const collapsedOff = split.collapsed === true;
      if (collapsedOff) note('开关**关着**却还是把侧栏收走了（"一个字都不碰"这条没兑现）');

      // 收尾：开关与侧栏都还原成开工时的样子（同样走命令，不赋值）
      await settings.save({ collapseSidebarOnOpen: setting0 });
      if (collapsed0) { if (split.collapse) split.collapse(); } else if (split.expand) split.expand();
      await P.wait(600);
      return {
        ok: problems.length === 0,
        info: '开=' + winW + 'px ｜ 侧栏开着时容器 ' + wWithSidebar + 'px（侧栏本身 ' + sideW +
              'px）→ 打开后 ' + wAfter + 'px（collapsed=' + collapsedOn + '）｜开关关掉后 collapsed=' +
              collapsedOff + '（要 false）｜' +
              (wantWider ? '变宽那一条适用（要求 ≥ +60px）' : '⚠️ 侧栏此刻只有 ' + sideW + 'px 宽 → "变宽"这条不适用（只判 flag 与 >640）') +
              '｜收尾已还原（开关=' + setting0 + ' 侧栏=' + collapsed0 + '）' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6⑤-③ 收侧栏.png',
  },

  {
    name: 'P6⑤ · ⑦ 触屏命中 ≥36px（自动排列 / 视图档 / 筛选 / 树行 / 树三角）· :active 只改颜色不改尺寸',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const view0 = ctx.settings.get().notesView;
      ctx.store.set({ activeModule: 'notes' });
      await P.wait(700);
      const gridBtn = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '网格'; });
      if (gridBtn) { P.click(gridBtn); await P.wait(800); }

      const wasMobile = document.body.classList.contains('is-mobile');
      document.body.classList.add('is-mobile');
      await P.wait(500);
      /**
       * 🔴 **量布局盒（offsetWidth/Height），不量 getBoundingClientRect()** ——
       * 后者**含 transform**：树三角展开态挂着 transform: rotate(90deg)，
       * 于是宽高**被交换**（实测：一个 38 宽的三角量出来是 16×38，
       * 看着像"padding 没生效"，其实一直生效着）。本项目在 FLIP 让位那条上
       * 已经吃过同一课（坑/探针.md：几何用布局坐标）。rect 仍然报出来当参考。
       */
      const size = function (el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          w: el.offsetWidth,
          h: el.offsetHeight,
          rect: Math.round(r.width) + '×' + Math.round(r.height),
        };
      };
      /**
       * 第三个字段 = **这一轮是否用"padding + 负 margin"撑过它**。
       * ⚠️ 只有这两件要求"布局占位两档一样"：另外三件（视图档 / 筛选 / 树行）是 **P1 就故意抬高**的
       * （min-height 40/44、行高 36），它们本来就该在两档下不一样 ——
       * 第一版把五件一起判，等于拿一条错口径去红（真机复跑当场抓到）。
       */
      const items = [
        ['自动排列', P.q('.kbw-sortbar .kbw-chk'), true],
        ['视图档按钮', P.qa('.kbw-seg button')[0], false],
        ['筛选', P.qa('.kbw-notes-toolbar .kbw-btn').find(function (b) {
          return P.text(b).indexOf('筛选') === 0;
        }), false],
        ['树行', P.q('.kbw-tree-item'), false],
        ['树三角', P.q('.kbw-tree-caret'), true],
      ];
      /**
       * 布局占位 = 布局盒 + 两侧 margin（负 margin 把它抵回原来的地方）。
       * ⚠️ **这一条是给"视觉尺寸不变"那句承诺配的判据**（独立审查 B3）：
       * 原先只钉了"命中 ≥36"，于是把 neg-margin 从 -9px 改成 -1px（padding 再也抵不掉、
       * 控件被真撑大 8px）**照样绿** —— offsetWidth 不含 margin，谁都看不见。
       */
      const foot = function (el) {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const num = function (v) { return parseFloat(v) || 0; };
        return {
          w: Math.round((el.offsetWidth + num(cs.marginLeft) + num(cs.marginRight)) * 10) / 10,
          h: Math.round((el.offsetHeight + num(cs.marginTop) + num(cs.marginBottom)) * 10) / 10,
        };
      };
      const measured = [];
      const footTouch = [];
      for (const pair of items) {
        const label = pair[0];
        const el = pair[1];
        const s = size(el);
        if (!s) { note('找不到「' + label + '」'); continue; }
        measured.push(label + ' ' + s.w + '×' + s.h);
        if (pair[2]) footTouch.push([label, foot(el)]);
        /**
         * 双边：**≥36**（这一轮的口径）且 **≤60**（上界防"把控件吹成一块巨砖"——
         * 走的是 padding + 负 margin 的路线，视觉尺寸本来就不该跟着涨）。
         */
        if (!(s.h >= 36)) note(label + ' 命中高 ' + s.h + 'px（口径 ≥36）');
        if (!(s.w >= 36)) note(label + ' 命中宽 ' + s.w + 'px（口径 ≥36）');
        if (!(s.h <= 60 && s.w <= 320)) note(label + ' 命中被撑爆了（' + s.w + '×' + s.h + '）');
      }
      // 摘掉 is-mobile，量**桌面档**的布局占位 —— 两档必须一样（"视觉尺寸一个像素都不动"）
      document.body.classList.remove('is-mobile');
      await P.wait(500);
      for (const pair of items) {
        if (!pair[2]) continue;   // 见上面那段：只有"这一轮撑过的"才要求两档占位一样
        const label = pair[0];
        const desk = foot(pair[1]);
        const t = (footTouch.find(function (x) { return x[0] === label; }) || [])[1];
        if (!desk || !t) continue;
        if (Math.abs(t.w - desk.w) > 1 || Math.abs(t.h - desk.h) > 1) {
          note(label + ' 的**布局占位**在触屏档被撑大了（桌面 ' + desk.w + '×' + desk.h +
               ' → 触屏 ' + t.w + '×' + t.h + '）—— 负 margin 没抵消掉，视觉尺寸变了');
        }
      }
      document.body.classList.add('is-mobile');
      await P.wait(400);

      /**
       * ⚠️ **铁律 2（:active 只改颜色、不改尺寸）在这一步验不了 —— 如实记下，别假装验过**：
       * :active 是**浏览器按真实输入事件**维护的状态，而我们在这里只能派**合成**
       * PointerEvent（P.pointerDownAt 走 dispatchEvent）—— 合成事件**不会**让元素进 :active，
       * 于是"按下去量一遍"量到的永远是常态：几何必然相同、底色必然没变，
       * 两条断言**都是恒真**的（本项目最怕的那种"看起来在测、其实测不到"）。
       * 这条路留给**离线静态断言**（tests/specs/redline.ts：button 的 :active 规则体里
       * 不许出现尺寸/位移类声明）—— 它才拦得住"谁哪天加一条 transform: scale(.96)"。
       */

      /**
       * 🔴 收尾用 try/finally：这一条临时挂过 body.is-mobile、也动过视图档 ——
       * **中途抛异常也必须还原**，否则下一轮所有判据都跑在"伪造的触屏档"上
       *（2026-09-28 就是照这个味道踩过一次：⑧ 抛了异常没还原，库状态留脏）。
       */
      try {
        return {
          ok: problems.length === 0,
          info: '触屏档量到：' + measured.join(' ｜ ') +
                '｜⚠️ 降级说明：:active 只改颜色不改尺寸这条**真机验不了**（合成 PointerEvent 不进 :active，' +
                '两条断言都恒真）—— 它由离线静态断言管；同样地，触屏 :hover 残留也验不了（媒体特性模拟无效）' +
                (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        if (!wasMobile) document.body.classList.remove('is-mobile');
        await P.wait(400);
        if (view0 !== ctx.settings.get().notesView) {
          await ctx.settings.save({ notesView: view0 });
          await P.wait(500);
        }
      }
    })()`,
    shot: 'P6⑤-⑦ 触屏命中.png',
  },

  {
    name: 'P6⑤ · ⑧ 非文字对比 ≥3:1（勾选框边框 / 树三角 / ⋯ 图标）—— **明暗两个主题各量一次**',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const view0 = ctx.settings.get().notesView;
      ctx.store.set({ activeModule: 'notes' });
      await P.wait(700);
      const gridBtn = P.qa('.kbw-seg button').find(function (b) { return P.text(b) === '网格'; });
      if (gridBtn) { P.click(gridBtn); await P.wait(800); }

      /**
       * 要量的三件（都是"必须看得见的线/字形"，非文字对比口径 ≥3:1）。
       * ⚠️ **用 contrastAny / bgSolid（新助手），不是 contrast / bgOf（老助手）**：
       * color-mix 与 oklch 的**计算值**会序列化成 color(srgb …) / oklch(…)，
       * 而老 rgb() 只认 rgb() 形态 → 返回 null → lum(null) **当场抛**
       *（这一步第一版就是这条：TypeError: Cannot read properties of null (reading '0')）。
       * 老 alpha() 也认不出 / .15 那种写法，会把**半透明的底当成实色**。
       */
      const pick = function () {
        const out = [];
        const box = P.q('.kbw-sortbar .kbw-chk i');
        if (box) out.push(['勾选框边框', getComputedStyle(box).borderTopColor, box]);
        const caret = P.q('.kbw-tree-caret');
        if (caret) out.push(['树三角', getComputedStyle(caret).color, caret]);
        /**
         * ⚠️ 第三个候选**换过地方**（P6 段⑥ ④-A）：那颗 ⋯（重排库结构）原先住在
         * 目录树的**表头**里（.kbw-notes-side），而表头那一行随 ④-A 整行取消、
         * ⋯ 搬到了**面包屑行**（.kbw-notes-toolbar）。
         * 不改这一行的话，这里会**只量到 2 件**（第三件永远找不到）——
         * 这正是"改了实现、判据还在看老东西"的形态，真机第一次跑就报出来了。
         */
        const more = P.q('.kbw-gmore') || P.q('.kbw-card-morebtn') || P.q('.kbw-notes-toolbar .kbw-iconbtn');
        if (more) out.push(['⋯ 图标', getComputedStyle(more).color, more]);
        return out;
      };

      const theme0 = P.theme();
      const rows = [];
      const themes = [['暗（obsidian）', 'obsidian'], ['亮（moonstone）', 'moonstone']];
      for (const t of themes) {
        if (!P.setTheme(t[1])) { note('切不到主题 ' + t[1] + '（app.changeTheme 变了？）'); continue; }
        await P.wait(700);
        const dark = P.isDark();
        /**
         * 🔴 **主题真的切过去了吗**（独立审查 B5）：dark 原先只进 info、没有断言 ——
         * 那么"两轮都停在同一个主题"时，info 照样会写"暗 / 亮各一次"（"看起来在测"的经典形状）。
         */
        const wantDark = t[1] === 'obsidian';
        if (dark !== wantDark) {
          note('切到 ' + t[1] + ' 之后 body 不是 ' + (wantDark ? 'theme-dark' : 'theme-light') +
               '（实际 ' + (dark ? 'theme-dark' : 'theme-light') + '）—— 这一轮量的是别的主题');
        }
        const parts = [];
        const targets = pick();
        for (const item of targets) {
          const fg = item[1];
          const bg = P.bgSolid(item[2]);
          const ratio = P.contrastAny(fg, bg);
          if (ratio == null) {
            note(t[0] + '：' + item[0] + ' 的颜色量不出来（' + fg + ' / ' + bg + '）');
            continue;
          }
          parts.push(item[0] + ' ' + ratio + ':1');
          if (!(ratio >= 3)) note(t[0] + '：' + item[0] + ' 只有 ' + ratio + ':1（非文字口径 ≥3）');
        }
        /**
         * ⚠️ **下限**：pick() 是"找不到就少测一件"，不设下限的话三件全找不到也会算出"全过"
         * （独立审查 B5）。这一轮要量的就是这三件，少一件都不行。
         */
        if (targets.length < 3) {
          note(t[0] + '：只量到 ' + targets.length + ' 件（要 3 件：勾选框边框 / 树三角 / ⋯ 图标）');
        }
        rows.push(t[0] + '（body=' + (dark ? 'theme-dark' : 'theme-light') + '）' + parts.join(' / '));
      }
      // ⚠️ 用完**必须切回去** —— changeTheme 写的是库的 appearance.json（真机取证过）
      P.setTheme(theme0);
      await P.wait(600);
      const back = P.theme();
      if (back !== theme0) note('主题没切回去：' + theme0 + ' → ' + back);

      /** 同 ⑦：主题与视图档都是**落盘偏好**，抛异常也得还回去（见 ⑦ 那段注释） */
      try {
        return {
          ok: problems.length === 0,
          info: rows.join(' ｜ ') + '｜收尾切回 ' + back +
                (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        if (P.theme() !== theme0) P.setTheme(theme0);
        await P.wait(400);
        if (view0 !== ctx.settings.get().notesView) {
          await ctx.settings.save({ notesView: view0 });
          await P.wait(500);
        }
      }
    })()`,
    shot: 'P6⑤-⑧ 非文字对比（亮）.png',
  },

  {
    name: 'P6⑤ · 断点①：600px 视口 → data-w=narrow · 目录栏被窄档藏掉 · 不横向溢出',
    viewport: [600, 820],
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      P.closeAll(3);
      ctx.store.set({ activeModule: 'notes' });
      /**
       * 🔴 **先把 Obsidian 侧栏收掉**：它开着时吃掉 ~200px（实测 244），
       * 于是"视口 820"量到的容器只有 576 → 判据以"data-w 不对"的样子红，
       * 真因是**容器宽 ≠ 视口宽**。收起之后两者才对得上（这正是 ③ 那个功能的效果）。
       * ⚠️ 必须用 collapse() —— 给 collapsed 赋值在真机上是**静默无效**的（探针 ③ 量到过）。
       */
      const split = app.workspace.leftSplit;
      const sideWas = split ? split.collapsed : null;
      if (split && !split.collapsed) { split.collapse(); await P.wait(700); }
      await P.wait(900);
      const root = P.q('.kbw-root');
      if (!root) return { ok: false, info: '没有 .kbw-root' };
      const dw = root.getAttribute('data-w');
      const side = P.q('.kbw-notes-side');
      const sideShown = !!side && side.getBoundingClientRect().width > 0;
      const noOverflow = root.scrollWidth <= root.clientWidth + 1;
      const problems = [];
      if (dw !== 'narrow') problems.push('data-w=' + dw + '（600 视口该是 narrow）');
      if (sideShown) problems.push('窄档下目录栏居然还画着（宽 ' + Math.round(side.getBoundingClientRect().width) + 'px）');
      if (!noOverflow) problems.push('横向溢出 ' + (root.scrollWidth - root.clientWidth) + 'px');
      return {
        ok: problems.length === 0,
        info: '视口 600×820 → data-w=' + dw + '｜目录栏宽度=' + (side ? Math.round(side.getBoundingClientRect().width) : '(没有)') +
              '（窄档该是 0）｜横向溢出=' + (noOverflow ? '无 ✓' : '有') +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P6⑤ · 断点②：820px 视口 → data-w=mid（三档里中间那档，取数真落在这儿）',
    viewport: [820, 820],
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      P.closeAll(3);
      ctx.store.set({ activeModule: 'notes' });
      /**
       * 🔴 **先把 Obsidian 侧栏收掉**：它开着时吃掉 ~200px（实测 244），
       * 于是"视口 820"量到的容器只有 576 → 判据以"data-w 不对"的样子红，
       * 真因是**容器宽 ≠ 视口宽**。收起之后两者才对得上（这正是 ③ 那个功能的效果）。
       * ⚠️ 必须用 collapse() —— 给 collapsed 赋值在真机上是**静默无效**的（探针 ③ 量到过）。
       */
      const split = app.workspace.leftSplit;
      const sideWas = split ? split.collapsed : null;
      if (split && !split.collapsed) { split.collapse(); await P.wait(700); }
      await P.wait(900);
      const root = P.q('.kbw-root');
      if (!root) return { ok: false, info: '没有 .kbw-root' };
      const dw = root.getAttribute('data-w');
      const w = Math.round(root.getBoundingClientRect().width);
      // 断点：<640 narrow · <900 mid · 其余 wide（workbench-view.ts 的两个常量）
      if (split && sideWas === false) split.expand();
      const noOverflow = root.scrollWidth <= root.clientWidth + 1;
      return {
        ok: dw === 'mid' && noOverflow && w > 640 && w < 900,
        info: '视口 820×820 → 容器 ' + w + 'px · data-w=' + dw + '（口径 mid）｜横向溢出=' +
              (noOverflow ? '无 ✓' : '有') + '｜⚠️ 双边：容器宽必须 >640 且 <900，否则量到的不是这一档',
      };
    })()`,
  },
  {
    name: 'P6⑤ · 断点③：1400px 视口 → data-w=wide；挂 body.is-mobile 之后仍 wide、不横溢（触屏那一支）',
    /** ⚠️ 标题写着 1400 就得**声明** —— 不声明就跟着跑的时候那个窗口尺寸走（独立审查 B6） */
    viewport: [1400, 900],
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(3);
      ctx.store.set({ activeModule: 'notes' });
      /**
       * 🔴 **先把 Obsidian 侧栏收掉**：它开着时吃掉 ~200px（实测 244），
       * 于是"视口 820"量到的容器只有 576 → 判据以"data-w 不对"的样子红，
       * 真因是**容器宽 ≠ 视口宽**。收起之后两者才对得上（这正是 ③ 那个功能的效果）。
       * ⚠️ 必须用 collapse() —— 给 collapsed 赋值在真机上是**静默无效**的（探针 ③ 量到过）。
       */
      const split = app.workspace.leftSplit;
      const sideWas = split ? split.collapsed : null;
      if (split && !split.collapsed) { split.collapse(); await P.wait(700); }
      await P.wait(900);
      const root = P.q('.kbw-root');
      if (!root) return { ok: false, info: '没有 .kbw-root' };
      const dw = root.getAttribute('data-w');
      if (dw !== 'wide') note('data-w=' + dw + '（宽视口该是 wide）');
      const noOverflow = root.scrollWidth <= root.clientWidth + 1;
      if (!noOverflow) note('宽档横向溢出');

      /**
       * 触屏那一支：伪造 body.is-mobile 再量一遍。
       * ⚠️ **触屏 hover 残留真机验不了**：本机实测 Emulation.setEmulatedMedia 的
       * hover/pointer 特性**不生效**（matchMedia 照样 hover:hover，带不带 media 字段都试了）
       * —— 那条只有离线那条静态断言管（顶层 :hover 必须包在 @media (hover:hover) 里）。
       * 这里只验触屏档**布局**这一半：仍判 wide、且不横向溢出。
       */
      const wasMobile = document.body.classList.contains('is-mobile');
      document.body.classList.add('is-mobile');
      await P.wait(600);
      const dwM = P.q('.kbw-root').getAttribute('data-w');
      const noOverflowM = P.q('.kbw-root').scrollWidth <= P.q('.kbw-root').clientWidth + 1;
      if (dwM !== 'wide') note('触屏档 data-w=' + dwM + '（口径仍是 wide —— 触屏与窄是两回事）');
      if (!noOverflowM) note('触屏档横向溢出');
      if (!wasMobile) document.body.classList.remove('is-mobile');
      await P.wait(400);
      return {
        ok: problems.length === 0,
        info: '1400 视口 → data-w=' + dw + '（容器 ' + Math.round(root.getBoundingClientRect().width) +
              'px）｜触屏档 data-w=' + dwM + '｜横向溢出：常态=' + (noOverflow ? '无' : '有') +
              '／触屏=' + (noOverflowM ? '无' : '有') +
              '｜⚠️ 触屏 :hover 残留这条 CDP 验不了（媒体特性模拟无效），由离线静态断言管' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },

  {
    name: 'P6⑤ · 看板「选择模式 → ⋯」：触屏长按 400ms 进选择模式 · 每张卡冒 ⋯ · 点它开的是**单篇菜单**',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const wasMobile = document.body.classList.contains('is-mobile');
      document.body.classList.add('is-mobile');
      ctx.store.set({ activeModule: 'board' });
      await P.wait(1400);

      const cards = () => P.qa('.kbw-card');
      const inSelectMode = () => cards().some(function (c) { return c.classList.contains('is-selectmode'); });
      const first = cards()[0];
      if (!first) {
        if (!wasMobile) document.body.classList.remove('is-mobile');
        return { ok: false, info: '看板上一张卡都没有（板块配置是空的？）' };
      }
      const before = cards().map(function (c) { return c.getAttribute('data-path'); }).join(',');

      const pt = P.aimAt(first);
      P.pointerDownAt(pt.x, pt.y, 'touch');
      await P.wait(150);
      const early = inSelectMode();
      await P.wait(450);
      const late = inSelectMode();
      const moreBtn = cards()[0].querySelector('.kbw-card-morebtn');
      const moreOpacity = moreBtn ? getComputedStyle(moreBtn).opacity : '(没有 ⋯)';
      P.pointerUpAt(pt.x, pt.y, 'touch');
      await P.wait(400);

      if (early) note('长按还没到 400ms 就进了选择模式');
      if (!late) note('长按 400ms 之后没进选择模式');
      if (!moreBtn) note('选择模式下卡片上没有 ⋯（触屏就没有别的路子进单篇菜单了）');
      else if (Number(moreOpacity) < 0.5) note('⋯ 没显形（opacity=' + moreOpacity + '）');
      if (cards().map(function (c) { return c.getAttribute('data-path'); }).join(',') !== before) {
        note('长按不动就松手，卡片顺序却变了');
      }

      // 点 ⋯ → 单篇菜单（与桌面右键同一份实现）
      let menuInfo = '';
      if (moreBtn) {
        const mp = P.aimAt(moreBtn);
        P.click(elAt_(mp.x, mp.y) || moreBtn);
        await P.wait(400);
        const menu = P.lastMenu ? P.lastMenu() : P.q('.kbw-menu');
        const items = P.qa('.kbw-menu-item').map(function (x) { return P.text(x); });
        menuInfo = '菜单项 ' + items.length + ' 条：' + items.slice(0, 5).join(' / ');
        if (!menu) note('点 ⋯ 没弹出菜单');
        if (items.length === 0) note('菜单里一条都没有');
        /**
         * ⚠️ **"弹出来了"不够，得是"单篇菜单"那一份**（独立审查 B6）：菜单头上那行
         * kbw-menu-scope 会带 is-note（ui/menu.ts 按 scope.kind 打的），
         * 而且得**认这一篇**（文案里有它的名字）—— 否则"弹了个别的菜单"也照样绿。
         */
        const scope = menu ? menu.querySelector('.kbw-menu-scope') : null;
        if (!scope || !scope.classList.contains('is-note')) {
          note('弹出来的不是**单篇**菜单（scope 缺 is-note）');
        } else if (P.text(scope).indexOf(cards()[0] ? P.text(cards()[0].querySelector('.kbw-card-t') || cards()[0]) : '') < 0) {
          note('菜单的作用对象不是这一篇（scope=' + P.text(scope) + '）');
        }
        P.key('Escape');
        await P.wait(300);
      }

      // Esc：退出选择模式（走的是分层栈那条路）
      P.key('Escape');
      await P.wait(400);
      const exited = !inSelectMode();
      if (!exited) note('Esc 没退出选择模式');
      if (!wasMobile) document.body.classList.remove('is-mobile');
      await P.wait(400);
      return {
        ok: problems.length === 0,
        info: '长按前=' + early + '（要 false）· 长按后=' + late + '（要 true）｜⋯ opacity=' + moreOpacity +
              '｜' + menuInfo + '｜Esc 退出=' + exited +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
      function elAt_(x, y) { return document.elementFromPoint(x, y); }
    })()`,
    shot: 'P6⑤-看板选择模式.png',
  },

  /* ══════════════════════════════════════════════════════════════════
     P6 段⑥ · 结构与手势轮（2026-09-28）
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P6⑥ · ④-A 窄档不画列头槽（那时目录栏本来就被藏了）',
    viewport: [600, 820],
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      P.ctx().store.set({ activeModule: 'notes' });
      await P.wait(900);
      const slot = P.q('.kbw-colslot');
      const side = P.q('.kbw-notes-side');
      const root = P.q('.kbw-root');
      const dw = root ? root.getAttribute('data-w') : '';
      if (dw !== 'narrow') note('视口 600 没落到窄档（data-w=' + dw + '）');
      if (!slot) {
        note('找不到列头槽（类名变了？）');
      } else {
        const r = slot.getBoundingClientRect();
        const cs = getComputedStyle(slot);
        /**
         * ⚠️ 判据是"**没画**"，不是"宽度是 0" —— display:none 的元素宽度也是 0，
         * 所以两条一起写：光看宽度的话，将来有人改成"画一条 0 宽的槽"也照样绿，
         * 而那时它已经**占了 flex 里的一格**（只是看不见）。
         */
        if (cs.display !== 'none') note('窄档下槽还是画着的（display=' + cs.display + '）');
        if (r.width !== 0) note('窄档下槽占了宽度 ' + Math.round(r.width) + 'px');
      }
      // 目录栏那时本来就该被藏（两件事同源：少一条就是"槽没了、目录栏还在"）
      if (side && getComputedStyle(side).display !== 'none') {
        note('窄档下目录栏还在显示（它该被 CSS 藏掉）');
      }
      return {
        ok: problems.length === 0,
        info: 'data-w=' + dw + '｜槽 display=' + (slot ? getComputedStyle(slot).display : '?') +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P6⑥ · ⑤ 双击卡片 = 升格成标签页（窗里走了 + 平台开了那一篇 + 只有一个编辑器）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      await P.ensureWorkbench();
      // 视野先摆干净（搜索 / 筛选 / 目录树选择都会顺着会话污染下一步）
      await P.scopeAll();
      await P.wait(600);
      /**
       * ⚠️ **点导航切看板，不能只「store.set」**（P2 的老坑，P7.2c 又栽一次）：
       * 只 store.set 的话 settings.activeModule 还是旧值 —— 一旦这一步里发生了
       * settings.save（如"把小窗拖开"结束写「panelGeo」）→ applySettingsToStore
       * 把 activeModule 顶回旧值 → 看板模块**整体重挂** → 「keepPinnedPanel」
       * 把小窗全收走（P7.2c 首跑的症状：cards()[0] 是 undefined 的那个 TypeError）。
       */
      const navB = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('看板') >= 0; });
      if (navB) P.click(navB);
      else P.ctx().store.set({ activeModule: 'board' });
      await P.wait(1400);
      const cards = () => P.qa('.kbw-card');
      if (cards().length === 0) {
        return { ok: false, info: '⚠️ 看板上一张卡都没有，这一条没验成' };
      }
      const path = cards()[0].getAttribute('data-path') || '';
      const title = cards()[0].querySelector('.kbw-card-t') || cards()[0];
      /**
       * 🔴 **先把这一篇在平台里已有的标签页收干净**（第二轮跑出来的）：
       * 升格是"在平台开一个标签"—— 上一轮留下的那个**不会自己关**，于是第二轮
       * workspace.getLeavesOfType('markdown') 会数到 **2 个**（旧的 + 新升格的），
       * 报出来是"留了第二个 buffer"，其实是**探针自己的残留**。
       * 收尾也照收（见最后那段）—— 判据必须是**可重跑的**，否则第二轮起就是在测残留。
       */
      for (const l of app.workspace.getLeavesOfType('markdown')) {
        const f = l.view && l.view.file;
        if (f && f.path === path) l.detach();
      }
      await P.wait(500);
      const at = P.rectAt(title);
      if (!at || !at.visible) note('第一张卡不在视野里：' + (at ? at.rect.join(',') : '量不到'));
      // ① 前置：单击把它开进小窗（主路径一个字没变）
      P.click(title);
      await P.wait(900);
      const panel = P.q('.kbw-cw-panel');
      if (!panel) note('单击没有开出小窗（前置不成立）');
      /**
       * ② **量一下"小窗盖不盖住这张卡"** —— 这是 交互规格 里写明的已知代价：
       *    小窗落在"被点那一列的顶部居中"，第二下有可能打在小窗上。
       *    这一步**不拿它当失败**（已知行为），但必须**说出来** ——
       *    否则下一次看到"双击不灵"又要从头查一遍。
       */
      const overlaps = function (el, box) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return !(r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom);
      };
      let covered = '没到量';
      let movedWindow = false;
      if (panel) {
        const rb = cards()[0].getBoundingClientRect();
        covered = overlaps(panel, rb) ? '盖住了' : '没盖住';
        /**
         * 🔴 **盖住了就把小窗拖开**，别让这条变成假红。
         *
         * 为什么必须处理：小窗开在"被点那一列的顶部居中"（「交互规格」§4.2 记的已知代价），
         * 所以第二下有可能打在小窗上、根本到不了卡片 —— 那时这一段测的是"窗挡不挡"，
         * 不是"双击升不升格"。而**面板头是可以拖的**（ui/panel.ts 的 dragHandle），
         * 探针里"小窗挡住目标"的既有解法就是把它拖开（见 坑/探针.md 那条）。
         */
        if (covered === '盖住了') {
          const head = P.q('.kbw-cw-panel .kbw-panel-head');
          const hAt = P.rectAt(head);
          if (hAt && hAt.visible) {
            const vw = window.innerWidth || 1200;
            const vh = window.innerHeight || 800;
            await P.dragMouse({ x: hAt.x, y: hAt.y }, { x: Math.round(vw * 0.78), y: Math.round(vh * 0.82) }, 8);
            await P.wait(500);
            const rb2 = cards()[0].getBoundingClientRect();
            const p2 = P.q('.kbw-cw-panel');
            covered = overlaps(p2, rb2) ? '盖住了（拖开之后仍盖着）' : '盖住了（已拖开）';
            movedWindow = true;
          }
        }
      }
      // ③ 双击（派两次 click + 一次 dblclick，与真机的事件序列一致）
      const card2 = cards()[0];
      const a2 = P.rectAt(card2);
      const pt = a2 && a2.visible ? a2 : P.aimAt(card2);
      const x = pt ? pt.x : 40;
      const y = pt ? pt.y : 40;
      const hit = document.elementFromPoint(x, y);
      const hitOnCard = !!(hit && hit.closest('.kbw-card'));
      if (!hitOnCard) {
        note('双击那一点没打在卡片上（打在 ' + (hit ? hit.className : 'null') + '）');
      }
      const seq = ['pointerdown', 'pointerup', 'click', 'click', 'dblclick'];
      for (const type of seq) {
        P.elAt(x, y).dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          detail: type === 'dblclick' ? 2 : 1,
        }));
        await P.wait(60);
      }
      await P.wait(1200);
      // ④ 三件事：平台开了这一篇 / 小窗里那一篇没了 / 同一时刻只有一个编辑器
      const leaves = app.workspace.getLeavesOfType('markdown').filter(function (l) {
        const f = l.view && l.view.file;
        return f && f.path === path;
      });
      if (leaves.length !== 1) {
        note('平台那一篇的编辑器有 ' + leaves.length + ' 个（要 1 个）—— 升格之后不许留第二个 buffer');
      }
      const panelAfter = P.q('.kbw-cw-panel');
      const stillInPanel = panelAfter ? !!panelAfter.querySelector('[data-path="' + path + '"]') : false;
      if (stillInPanel) note('升格之后那一篇**还留在小窗里**（升格 = 走掉，不是复制一份）');
      if (stillInPanel && leaves.length > 0) note('同一份文件同时有两个活编辑器（要丢字的）');
      /**
       * ⚠️ **这条判据够不着什么**（独立审查 B-1，如实记下）：
       * getLeavesOfType('markdown') **看不见小窗自己造的那个叶** —— 它是
       * new WorkspaceLeaf(app) 挂在自有容器里的，**不进平台的叶树**（本项目取证过三次）。
       * 所以"列表里摘掉了、叶却还活着"（同一份文件两个 buffer）**在真机这一层是无形的**：
       * 那种叶的 DOM 随页面一起被摘掉、CodeMirror 实例却还在跑。
       * ⇒ 这条守着的是**可见的那一半**（平台确实开了那一篇、窗里确实没了、只有一份平台叶）；
       *   "叶有没有真 detach"那一半只有**离线**能看（桩的 __leaves 连自造叶也算）——
       *   在 tests/specs/p6d.ts 的「不留第二个 buffer」那条里，它已被突变验证过能红。
       */
      /**
       * **收尾清场**：把升格出来的那个标签页关掉（探针开的自己收），
       * 否则下一轮跑起来会数到它（上面那段注释说的就是这个）。
       */
      for (const l of app.workspace.getLeavesOfType('markdown')) {
        const f = l.view && l.view.file;
        if (f && f.path === path) l.detach();
      }
      await P.wait(400);
      return {
        ok: problems.length === 0,
        info: '双击那一点落在卡上？' + hitOnCard + '（包围盒相交：' + covered + (movedWindow ? '，拖过窗' : '') + '）' +
              '｜平台编辑器 ' + leaves.length + ' 个｜窗里还在？' + stillInPanel +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6⑥-双击升格.png',
  },
  {
    name: 'P6⑥ · ⑤b 触屏双击不升格（触屏单击=开窗、长按=菜单，不参与双击）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      await P.ensureWorkbench();
      await P.scopeAll();
      await P.wait(600);
      /**
       * ⚠️ **点导航切看板，不能只「store.set」**（P2 的老坑，P7.2c 又栽一次）：
       * 只 store.set 的话 settings.activeModule 还是旧值 —— 一旦这一步里发生了
       * settings.save（如"把小窗拖开"结束写「panelGeo」）→ applySettingsToStore
       * 把 activeModule 顶回旧值 → 看板模块**整体重挂** → 「keepPinnedPanel」
       * 把小窗全收走（P7.2c 首跑的症状：cards()[0] 是 undefined 的那个 TypeError）。
       */
      const navB = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('看板') >= 0; });
      if (navB) P.click(navB);
      else P.ctx().store.set({ activeModule: 'board' });
      await P.wait(1400);
      const cards = () => P.qa('.kbw-card');
      if (cards().length === 0) return { ok: false, info: '⚠️ 看板上没有卡片，这一条没验成' };
      const path = cards()[0].getAttribute('data-path') || '';
      const count = () => app.workspace.getLeavesOfType('markdown').filter(function (l) {
        const f = l.view && l.view.file;
        return f && f.path === path;
      }).length;
      const wasMobile = document.body.classList.contains('is-mobile');
      document.body.classList.add('is-mobile');
      try {
        await P.wait(400);
        const title = cards()[0].querySelector('.kbw-card-t') || cards()[0];
        P.click(title);
        await P.wait(900);
        const before = count();
        const a2 = P.rectAt(cards()[0]) || P.aimAt(cards()[0]);
        const x = a2 ? a2.x : 40;
        const y = a2 ? a2.y : 40;
        for (const type of ['click', 'dblclick']) {
          P.elAt(x, y).dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 2,
          }));
          await P.wait(80);
        }
        await P.wait(900);
        if (count() > before) note('触屏下双击把这一篇升格了（触屏不参与这个手势）');
        const panel = P.q('.kbw-cw-panel');
        const inPanel = panel ? !!panel.querySelector('[data-path="' + path + '"]') : false;
        if (!inPanel) note('触屏单击之后小窗里没有这一篇（单击=开窗那条主路径被弄坏了）');
      } finally {
        if (!wasMobile) document.body.classList.remove('is-mobile');
        await P.wait(300);
      }
      P.closeAll(3);
      await P.wait(500);
      return {
        ok: problems.length === 0,
        info: '触屏：双击前后平台编辑器数没变 · 小窗仍在' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P6⑥ · ⑥ 编辑器右键菜单（R8 两栏）：经纬/经纬AI · 库外/非 md 不出现 · 自动整理走确认流+mover+撤销条',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      /**
       * 假菜单：**形状最小**（被测代码只调 addItem + 那几个 setter）。
       * 真机上探针在渲染进程里、没有 obsidian 模块出口，拿不到 Menu 构造器，
       * 而这里要验的是**我们注册的那个监听器**，不是平台的菜单渲染 ——
       * 所以假菜单正好：它比真菜单更严格（只允许被测代码碰那几个方法）。
       */
      function mkMenu() {
        const m = { items: [] };
        m.addItem = function (cb) {
          const rec = { title: '', sub: null, run: null, section: '' };
          const handle = {
            setTitle(t) { rec.title = t; return handle; },
            setIcon() { return handle; },
            setSection(s) { rec.section = s; return handle; },
            onClick(fn) { rec.run = fn; return handle; },
            setSubmenu() { const s = mkMenu(); rec.sub = s; return s; },
          };
          cb(handle);
          m.items.push(rec);
          return m;
        };
        return m;
      }
      /**
       * 🔴 **只认我们自己那一项**（经纬），**不数总项数**。
       *
       * 第一版断言"一级只有 1 项"，在**传假 editor** 时碰巧成立 —— 因为别的插件的
       * onEditorMenu 处理器拿到假 editor 先抛异常、什么都没加（那一轮还刷出 20 条页面异常）。
       * 换成**真编辑器**之后（这是对的），别的插件正常往同一个菜单里加项了
       *（实测出现了「新建数据库」）→ "总项数 == 1"当场变红。
       * 这本来就不是我们的口径：**平台菜单是共用的**，我们能保证的只有"自己加了几项"。
       */
      async function menuFor(file, editor) {
        const root = mkMenu();
        app.workspace.trigger('editor-menu', root, editor || {}, { file: file });
        await P.wait(500);
        /**
         * ⚠️ R8 起我们有**两个**一级项（经纬 / 经纬AI）—— 两栏都要摘出来。
         * 「ours」判据随之从 1 改 2（见下面那条）。
         */
        const ourTitles = ['经纬', '经纬AI'];
        const ours = root.items.filter(function (i) { return ourTitles.indexOf(i.title) >= 0; });
        const mine = ours.filter(function (i) { return i.title === '经纬'; })[0] || null;
        const ai = ours.filter(function (i) { return i.title === '经纬AI'; })[0] || null;
        return {
          mine: mine,
          ai: ai,
          /** 我们自己铺了几个一级项（**要等于 2** —— 见下面那条判据） */
          ours: ours.length,
          total: root.items.length,
          items: mine && mine.sub ? mine.sub.items : [],
          aiItems: ai && ai.sub ? ai.sub.items : [],
        };
      }
      const kb = ctx.settings.kbRoot();
      /**
       * 🔴 **要拿一个"真的编辑器"来触发**（第一版传了个空对象，平台自己的
       * onEditorMenu 处理器收到假 editor → t.getCursor is not a function，
       * 一轮刷出 **20 条**页面异常 —— 那会淹掉真异常）。
       * 做法：**先把这篇在标签页里打开**，再从活动叶的 view 上取 .editor。
       * 这同时让这一步更接近真实场景（用户就是在打开的笔记里右键的）。
       * ⚠️ 收尾要把它关掉（探针开的自己收）。
       */
      let openedPath = '';
      async function realEditorFor(file) {
        await app.workspace.getLeaf('tab').openFile(file);
        await P.wait(1200);
        const view = app.workspace.activeLeaf && app.workspace.activeLeaf.view;
        const ed = view && view.editor ? view.editor : null;
        if (ed) openedPath = file.path;
        return ed;
      }
      // ① 库根之下的普通 .md：子菜单在、入口只有一项
      const anyNote = ctx.index.getAll().filter(function (e) { return !e.isTemplate; })[0];
      if (!anyNote) return { ok: false, info: '⚠️ 库里一篇笔记都没有，这一条没验成' };
      const firstFile = app.vault.getAbstractFileByPath(anyNote.path);
      const editor1 = await realEditorFor(firstFile);
      if (!editor1) note('拿不到真编辑器（这一条会退化，平台处理器可能报异常）');
      const got1 = await menuFor(firstFile, editor1);
      /**
       * ⚠️ **"我们铺了几个一级项"要单独判**（独立审查 B-8）：把入口改成"把动作直接铺进一级"
       * 这种退化，只认 mine 的写法**看不出来**。口径是 §8.5 的"收进子菜单、一级不铺开"——
       * R8 起是两个一级项（经纬 / 经纬AI）。
       */
      if (got1.ours !== 2) {
        note('我们自己铺了 ' + got1.ours + ' 个一级项（该是 2 个：经纬 + 经纬AI）');
      }
      if (!got1.mine) {
        note('子菜单入口「经纬」没加上（一级共 ' + got1.total + ' 项）');
      } else if (!got1.items.some(function (i) { return i.title === '返回经纬工作台'; })) {
        note('「经纬」子菜单里没有「返回经纬工作台」');
      }
      if (!got1.ai) {
        note('子菜单入口「经纬AI」没加上');
      } else if (!got1.aiItems.some(function (i) { return i.title === '自动整理'; })) {
        note('「经纬AI」子菜单里没有「自动整理」');
      }
      /**
       * 段位：两项都该挂着「insert」（放到平台「插入」之下的实现——asar 取证的段名）。
       * 这个假菜单只记录**我们调了什么**；真机渲染顺序（插入之下）另由截图肉眼复核。
       */
      if (got1.mine && got1.mine.section !== 'insert') {
        note('「经纬」没挂 insert 段（实际 ' + got1.mine.section + '）');
      }
      if (got1.ai && got1.ai.section !== 'insert') {
        note('「经纬AI」没挂 insert 段（实际 ' + got1.ai.section + '）');
      }
      // ② 非 md（目录对象）与库根之外的 md：我们**一项都不许加**
      //（editor 仍用 editor1：这不是"文件对不上"，是**别让平台自己的处理器收到假 editor**）
      const got2 = await menuFor(app.vault.getAbstractFileByPath(kb + '/99_Meta/05_操作日志') || null, editor1);
      if (got2.mine) note('在非笔记对象上也加了我们的菜单项');
      const got3 = await menuFor({ path: '不在库里/x.md', basename: 'x', extension: 'md' }, editor1);
      if (got3.mine) note('库根之外的 md 也加了我们的菜单项（只该管库根之下）');
      /**
       * ③ **动作真的走到底**：造一篇声明与实际不符的笔记 → 「经纬AI › 自动整理」那一项在 →
       *    点它 → 确认流 → mover → **撤销条 + 文件真的到了声明的位置**。
       *    ⚠️ 判据认**撤销条**，不认"菜单弹出来了"（提示词的原话）。
       *    （R8：原来的「按规则归位这一篇」并入「自动整理」——判据换成与一键整理同一条链。）
       */
      const rel = await P.seedMenuMisplaced();
      const target = app.vault.getAbstractFileByPath(rel);
      const got4 = await menuFor(target, await realEditorFor(target));
      const item = got4.aiItems.filter(function (i) { return i.title === '自动整理'; })[0];
      if (!item) {
        await P.dropMenuMisplaced();
        note('「经纬AI」里没有「自动整理」');
        return { ok: false, info: '⚠️ ' + problems.join('；') };
      }
      item.run();
      await P.wait(1000);
      const modal = P.lastModal();
      if (!modal) {
        note('点了菜单项没有弹确认流（动库必须过 ui/confirm.ts）');
      } else {
        const primary = P.qa('button', modal).filter(function (b) {
          return P.text(b).indexOf('搬这') >= 0;
        })[0];
        if (!primary) {
          note('确认流里找不到「搬这 N 篇」那个主按钮');
          P.key('Escape');
        } else {
          P.click(primary);
          await P.wait(1800);
        }
      }
      const dest = kb + '/02_Areas/内容创作/__探针菜单归位.md';
      const movedOk = !!app.vault.getAbstractFileByPath(dest);
      const oldGone = !app.vault.getAbstractFileByPath(rel);
      if (!movedOk) note('文件没有落在声明的位置（' + dest + '）');
      /** ⚠️ 成对判：只看"新位置有"的话，"根本没动"也会绿（P6② 那条） */
      if (!oldGone) note('老位置还留着');
      const undobar = P.q('.kbw-undobar');
      if (!undobar) note('没有撤销条（§8.5：与手工那条完全同一套）');
      // 撤销回去 + 清场（这一篇是探针造的，认 __探针 标记）
      if (undobar) {
        const undoBtn = P.qa('button', undobar).filter(function (b) {
          return P.text(b).indexOf('撤销') >= 0;
        })[0];
        if (undoBtn) {
          P.click(undoBtn);
          await P.wait(1800);
        }
      }
      await P.dropMenuMisplaced();
      // 收尾：把为拿真编辑器而开的标签页关掉（探针开的自己收）
      for (const l of app.workspace.getLeavesOfType('markdown')) {
        const f = l.view && l.view.file;
        if (f && (f.path === rel || f.path === (anyNote && anyNote.path))) l.detach();
      }
      await P.wait(500);
      void openedPath;
      return {
        ok: problems.length === 0,
        info: '两栏=' + (got1.mine ? '经纬在' : '经纬缺') + '/' + (got1.ai ? '经纬AI在' : '经纬AI缺') +
              '（铺了 ' + got1.ours + ' 个一级项；一级共 ' + got1.total + ' 项，含别家插件）' +
              '｜经纬 ' + got1.items.map(function (i) { return i.title; }).join('/') +
              '｜经纬AI ' + got1.aiItems.map(function (i) { return i.title; }).join('/') +
              '｜自动整理：落到目标=' + movedOk + ' 老位置没了=' + oldGone + ' 撤销条=' + !!undobar +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6⑥-编辑器菜单归位.png',
  },
  {
    name: 'P6⑥ · 语义色收口：徽标文字对比度 ≥4.5:1 且底色是淡的（暗/亮两主题）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      /**
       * ⚠️ **这个计数要在步骤顶层声明**：它的赋值在下面「暗色主题」那一支里，
       * 而拼 info 的「return」在**外层** —— 声明写在块里就是 ReferenceError
       *（第一版就是这么修的，探针当场又红了一次）。
       */
      let logRows = 0;
      const was = P.theme();
      const ctx = P.ctx();
      await P.ensureWorkbench();
      /**
       * 🔴 **先把屏摆成"有徽标可量"的样子** —— 第一版直接量当前这一屏，
       * 结果两轮都是「0 处：一个徽标都没在屏上」（那一条**不算通过**，但整步白跑）。
       * 徽标只在两处出现：表格的「标记」列、以及设置面板的**日志栏**。所以要：
       *  ① 从索引里**取一篇真有标记的笔记**，点它所在的目录（断言从数据里取，别写死）；
       *  ② 顺带把设置面板的日志栏也打开量一份。
       */
      const withFlag = ctx.index.getAll().filter(function (e) {
        return e.flags.length > 0 && !e.isTemplate;
      });
      let dirPicked = '';
      if (withFlag.length > 0) {
        const pick = withFlag.filter(function (e) {
          return e.effectivePosition.indexOf('/') < 0;
        })[0] || withFlag[0];
        dirPicked = pick.effectivePosition;
        /**
         * 🔴 **切模块一律点导航项，别用 store.set**（本项目记过这条，本轮又踩到）：
         * settingsStore.onChange → applySettingsToStore() 会**按设置里的值重设
         * activeModule** —— 只要这几步之间落了一次设置写盘，store.set 就被顶回去，
         * 于是这一步在**首页**上量徽标（诊断实测：模块=home、树节点=空、行数=0），
         * 报出来却是"一个徽标都没在屏上（这一条没验成）"，看着像色点没做出来。
         * 导航项那条路会 settings.save({activeModule})，落盘之后就没人顶得回去了。
         */
        const navNotes = P.qa('.kbw-navitem').filter(function (b) {
          return P.text(b).indexOf('全部笔记') >= 0;
        })[0];
        if (navNotes) P.click(navNotes);
        await P.wait(900);
        await P.scopeAll();
        await P.wait(500);
        /**
         * 🔴 **必须切回表格档**：P.scopeAll() 会把视图档切到**网格**（那是落盘偏好），
         * 而「标记」列只存在于**表格**档 —— 网格里根本没有 .kbw-flagcell。
         * 第一版就是这么在网格档上量到 0 个徽标的（"这一条没验成"）。
         * ⚠️ 动过视图档的步骤收尾要还回去（与 P6② 那条"探针动过的界面偏好要拨回基线"同一条）。
         */
        await P.useView('详细信息');
        await P.wait(700);
        const node = P.qa('.kbw-tree-item').filter(function (n) {
          return n.dataset.dir === dirPicked;
        })[0];
        if (node) {
          P.click(node);
          await P.wait(900);
        }
      }
      const rows = [];
      for (const t of ['dark', 'light']) {
        P.setTheme(t);
        await P.wait(600);
        const cells = [];
        for (const c of P.qa('.kbw-flagcell .kbw-flag')) cells.push(['标记列', c]);
        for (const c of P.qa('.kbw-flag.has-label')) cells.push(['日志', c]);
        if (cells.length === 0) {
          note(
            t + ' 主题下一个徽标都没在屏上（这一条没验成，不是通过）—— ' +
              '库里有标记的笔记 ' + withFlag.length + ' 篇，点进的目录「' + dirPicked + '」',
          );
          continue;
        }
        for (const pair of cells) {
          const el = pair[1];
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) {
            note(t + ' 的' + pair[0] + '徽标量不到几何（' + P.zeroGeoWhy(el) + '）');
            continue;
          }
          const cs = getComputedStyle(el);
          /**
           * ⚠️ **底色要"合成"出来，不能直接取祖先的实底**：胶囊自己那层是
           * 16% 的淡底（color-mix 算出来的 alpha 0.16），而 bgSolid 只认 alpha 大于 0.5 的层，
           * 于是它会**跳过胶囊**、直接拿下面的行底色 —— 那等于假装淡底不存在。
           * 这里按 alpha 把胶囊那层合到它下面的实底上（这正是 contrastAny 对**前景**做的事，
           * 只是这一处要作用在**背景**上）。
           */
          const solid = P.bgSolid(el.parentElement || el);
          const tintRgb = P.colorRgb(cs.backgroundColor);
          const tintA = P.alphaAny(cs.backgroundColor);
          const solidRgb = P.colorRgb(solid);
          let bg = solid;
          if (tintRgb && solidRgb && tintA > 0) {
            bg = 'rgb(' + tintRgb.map(function (v, i) {
              return Math.round(v * tintA + solidRgb[i] * (1 - tintA));
            }).join(',') + ')';
          }
          const c = P.contrastAny(cs.color, bg);
          /**
           * 🔴 **底色必须是淡的**（alpha < 1）：改前是"语义色满底 + 反色文字"，
           * 只量对比度的话，把白字换成黑字也能过（黄那档当年就是这么过的）——
           * 而设计系统要的是"色在文字**旁边**"，不是"压在文字底下"。
           */
          const alpha = P.alphaAny(cs.backgroundColor);
          if (!(alpha < 1)) note(t + ' 的' + pair[0] + '徽标底色是满色（alpha=' + alpha + '）');
          if (!(c !== null && c >= 4.5)) {
            note(t + ' 的' + pair[0] + '徽标文字对比 ' + (c === null ? '算不出' : c) + ':1（要 ≥4.5）');
          }
          rows.push(t + '/' + pair[0] + '=' + (c === null ? '?' : c));
        }
        /**
         * 🔴 **日志行那一种徽标也要量**（独立审查 A🟢9）：本轮给 .kbw-flag 加的那个**色点**
         * 只出现在带文字的胶囊上（日志行），而第一版的注释写着"顺带把设置面板的日志栏也打开"
         * ——**代码没打开**。于是"色点"这半边一次都没量到，覆盖全靠上一步有没有顺手留着面板。
         * 这里补上：开设置 → 日志栏 → 量一遍（面板自己管自己关）。
         */
        if (t === 'dark') {
          P.ctx().openWorkbenchSettings();
          await P.wait(900);
          const modal = P.lastModal();
          /**
           * ⚠️ P6 第八段把八栏收成六栏：日志那一块现在住在**「数据」栏**里
           *（快照 + 日志 = 同一件事的两头）。
           * 🔴 顺带修一个真错：「logRows」原来**没声明**（只在某个分支里赋值）——
           * 走"找不到那一栏"的分支时，下面拼 info 那一行会
           * 「ReferenceError: logRows is not defined」（本轮实测踩到）。
           */
          if (modal) {
            const tab = P.qa('.kbw-set-tab', modal).filter(function (x) {
              return P.text(x).indexOf('数据') >= 0;
            })[0];
            if (tab) {
              P.click(tab);
              await P.wait(900);
              const logFlags = P.qa('.kbw-set-body .kbw-flag.has-label');
              if (logFlags.length === 0) {
                note('日志栏里一个带色点的徽标都没有（色点这半边没量到）');
              } else {
                logRows = logFlags.length;
              }
            } else {
              note('设置面板里找不到「数据」栏（日志那一块住在里面）');
            }
            P.key('Escape');
            await P.wait(600);
          } else {
            note('设置面板没打开（日志徽标没量到）');
          }
        }
      }
      P.setTheme(was);
      await P.wait(400);
      return {
        ok: problems.length === 0,
        info: rows.length + ' 处：' + rows.slice(0, 8).join(' · ') + '｜日志栏色点徽标 ' + logRows + ' 个' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6⑥-语义色徽标.png',
  },

  /* ══════════════════════════════════════════════════════════════════
     P6 段④ · AI 助手 + 首次使用向导（2026-09-28）
     ──────────────────────────────────────────────────────────────────
     ⚠️ 这几步排在「真的写整个库」那一步**之前**（那一步必须留在最后）。
     ⚠️ **默认不联网**：AI 那两步用 `P.stubAi()` 装假回话；
       真连接单独一条判据（下面「真连接」那一步），没配 key 时它**报没验成，不报通过**。
     ⚠️ 向导那两步会**重载插件**（`wizardShownThisSession` 是会话态，不重载演不出来），
       收尾一律把 `wizardDone` 落回 `true` —— 那是配过的库该有的稳态。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P6④ · AI 助手：建议表勾选 → 确认流 → mover → 日志留痕 → 撤销整批',
    script: `(async () => {
      /**
       * 🔴 **整段包在 try/finally 里**（独立审查 A🔴2 抓到的真缺陷）：
       * 这一步要装一把**假 key**（面板没配 key 时不让问，而这一步用的是假传输层），
       * 第一版把还原写成「收尾那一行」，于是 —— 两条**早退**路径 + 末尾**截图演示**又装了一次
       * —— 假 key 就留在真机的 data.json 里，**把用户自己的 key 覆盖掉了**
       *（真机取证：20:42 是假 key，20:43 被手工贴回真 key）。
       * 放进 finally 之后，「每一条出路都还原」是**结构**保证的，不靠作者记得。
       * ⚠️ 探针里凡是要动**用户凭据**的地方，一律这个形状。
       */
      const P = window.__kbwProbe;   // ⚠️ 必须在 try **外面**：finally 里也要用它
      let prevKey = null;
      const sessBefore = await P.sessionIds();   // P7.3a：面板会存会话，跑完按 diff 收走自己造的
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        const ctx = P.ctx();
        const kb = ctx.settings.kbRoot();
        const problems = [];
        const note = (m) => problems.push(m);
        const A = '__探针AI甲';
        const B = '__探针AI乙';
        const relA = kb + '/00_Inbox/' + A + '.md';
        const relB = kb + '/00_Inbox/' + B + '.md';
        const destA = kb + '/01_Projects/' + A + '.md';
        const destB = kb + '/01_Projects/' + B + '.md';
        const snapsBefore = (await ctx.snapshot.list()).length;

        await P.seedAiNotes([A, B]);
        /**
         * ⚠️ **探针自己装一把假 key**（带 __探针 标记）：面板在没配 key 时**根本不让问**
         * （显示"还没配置"），而这一步用的是假传输层、不需要真 key。
         * 不装的话整步卡在"还没配置"上，报出来是"计划表 0 行"，看着像功能坏了。
         * 收尾一律还原（prevKey）—— 否则真连接那一步会拿着假 key 去真调。
         */
        P.stubAiSeq([
          {
            reply: '这两篇都像项目笔记，建议归到 01_Projects。',
            ideas: [
              { path: '00_Inbox/' + A + '.md', to: '01_Projects', why: '有明确目标、会结束' },
              { path: '00_Inbox/' + B + '.md', to: '01_Projects', why: '有明确目标、会结束' }
            ]
          },
          { reply: '好，先这样。', ideas: [] }
        ]);

        const openErr = await P.openAiPanel();
        if (openErr) { await P.dropAiNotes([A, B]); return { ok: false, info: openErr }; }
        const panel = P.lastModal();
        /**
         * ⚠️ P7.12 · R4（#16）：档位胶囊「改库需确认」**整体撤掉**（12:55 二拍：安全语义由
         * 确认流承担）—— 改钉新形态：说明挂在「⋯」的 tooltip 上（refreshHead 刷的那句）。
         */
        const moreTitle = (P.q('.kbw-ai-morebtn') || {}).getAttribute
          ? P.q('.kbw-ai-morebtn').getAttribute('title') || ''
          : '';
        if (moreTitle.indexOf('改库前都会弹确认框') < 0) {
          note('「⋯」tooltip 没扛起安全说明（当前是哪一档必须看得见）：' + moreTitle.slice(0, 40));
        }

        const askErr = await P.askAi('把收件箱那两篇归到项目里');
        if (askErr) { P.closeAll(3); await P.dropAiNotes([A, B]); return { ok: false, info: askErr }; }

        const rows = P.qa('.kbw-ai-plan .kbw-ai-row');
        if (rows.length !== 2) note('计划表该有 2 行，实际 ' + rows.length + ' 行');

        // 勾掉第一条：按钮上的 N 要跟着变（"勾了等于没勾"是这一屏最容易出的错）
        const boxes = P.qa('.kbw-ai-plan .kbw-ai-check');
        if (boxes.length === 2) {
          boxes[0].checked = false;
          boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
          await P.wait(200);
        } else {
          note('计划表里的勾选框不是 2 个，实际 ' + boxes.length);
        }
        const runBtn = P.qa('.kbw-ai-acts .kbw-btn').find((b) => P.text(b).indexOf('执行这') === 0);
        const runLabel = runBtn ? P.text(runBtn) : '';
        if (runLabel.indexOf('1') < 0) note('勾掉一行之后按钮该写「执行这 1 项」，实际「' + runLabel + '」');

        // 走确认流（**与手工那条同一份**：标题要写清是 AI 的建议）
        if (runBtn) P.click(runBtn);
        await P.wait(700);
        const cfm = P.lastModal();
        const cfmText = P.text(cfm);
        const saidOne = cfmText.indexOf('即将按 AI 的建议移动 1 篇') >= 0;
        if (!saidOne) note('确认流没弹 / 文案不对：' + cfmText.slice(0, 120));
        const primary = cfm ? Array.from(cfm.querySelectorAll('.kbw-modal-foot .kbw-btn')).find((b) => P.text(b).indexOf('移动这') === 0) : null;
        if (primary) P.click(primary);
        await P.wait(1600);

        // 「搬成功了」要**成对判**：新位置有 且 老位置没了
        const hasA1 = !!app.vault.getAbstractFileByPath(relA);
        const hasB1 = !!app.vault.getAbstractFileByPath(relB);
        const hasB2 = !!app.vault.getAbstractFileByPath(destB);
        if (!hasA1) note('勾掉的那篇被搬走了（勾选没生效）');
        if (hasB1) note('勾上的那篇还在原位');
        if (!hasB2) note('勾上的那篇没到目标位置');
        const rulePath = kb + '/99_Meta/03_AI指令集/AI操作规范.md';
        if (!app.vault.getAbstractFileByPath(rulePath)) note('AI 指令集那个文件不见了');

        // ④ 留痕：日志里读得出这是 AI 建议的
        let logText = '';
        for (const f of await ctx.report.recent(10)) {
          const t = await app.vault.read(f);
          if (t.indexOf(B) >= 0) { logText = t; break; }
        }
        if (!logText) note('没找到写着这一篇的操作日志');
        else {
          if (logText.indexOf('这条是 AI 建议的') < 0) note('日志里没有「这条是 AI 建议的」那一行');
          /**
           * ⚠️ **别判裸串 AI 建议**（独立审查 B🟡9）：reason 就是
           * 「AI 建议：把 N 篇归到指定目录」，所以那句话**一定**包含这四个字 ——
           * 判它等于恒真，验不出 「source「 到底对不对。
           * 真判据是**来源那一栏**（由 source 决定）。
           */
          if (logText.indexOf('来源**：AI 建议') < 0) note('日志的「来源」那栏不是「AI 建议」（别拿 reason 里的那四个字充数）');
        }

        // ② 撤销条在，而且能整批撤回（撤销 = 快照还原）
        const undoBtn = P.lastUndo('撤销');
        if (!undoBtn) note('没弹撤销条');
        else {
          P.click(undoBtn);
          await P.wait(2200);
          if (!app.vault.getAbstractFileByPath(relB)) note('撤销之后它没回原位');
          if (app.vault.getAbstractFileByPath(destB)) note('撤销之后目标位置那份还在');
        }

        // 收场：删夹具 + 按标记扫掉这一轮的快照与日志 + 把 key 还原
        P.closeAll(3);
        await P.dropAiNotes([A, B]);
        P.realAi();
        const snaps = (await ctx.snapshot.list()).slice(0, Math.max(1, (await ctx.snapshot.list()).length - snapsBefore)).map((s) => s.id);
        const swept = await P.sweep(snaps, '__探针');
        /**
         * 🔴 **截图是脚本返回之后才拍的** —— 收尾把面板关了的话，拍到的是**别的屏**
         *（P6① 记过这条：拿到过一张表格，而那一步测的是图谱。本轮第一次跑就是拍到了首页）。
         * 所以最后**重新把面板开出来停在建议表这一屏**：用两篇**真笔记**演一遍
         *（**不执行** —— 执行那条路上面已经验过了，这里只是留一张证据图，一个字都不动库）。
         */
        const demoNotes = ctx.index.notes().filter(function (e) {
          return !e.isTemplate && e.effectivePosition === '00_Inbox';
        }).slice(0, 2);
        if (demoNotes.length === 2) {
          P.stubAi(JSON.stringify({
            reply: '（截图用）这两篇看着像是该进项目。',
            ideas: demoNotes.map(function (e) {
              return { path: '00_Inbox/' + e.basename + '.md', to: '01_Projects', why: '有明确目标、会结束' };
            })
          }));
          // ⚠️ openAiPanel() **成功时返回空串**（失败才返回原因）—— 别写成 if (await ...)
          //    那等于 if ('') = 假，演示那一步**永远不会执行**（本轮实测：截到一张空面板）
          if ((await P.openAiPanel()) === '') await P.askAi('把收件箱这两篇归到项目里');
        }
        const info = '计划 2 行 · 勾掉 1 行 → 「' + runLabel + '」· 确认流=' + (saidOne ? '文案对' : '不对') +
          ' · 甲没动=' + hasA1 + ' 乙搬走=' + hasB2 + ' 日志留痕=' + (logText.indexOf('这条是 AI 建议的') >= 0) +
          ' · 撤销=' + !app.vault.getAbstractFileByPath(destB) + '｜清场 日志 ' + swept.logs + ' / 快照 ' + swept.snaps +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓');
        return { ok: problems.length === 0, info: info };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        await P.dropNewSessions(sessBefore);
      }
    })()`,
    shot: 'P6④-AI建议表.png',
  },
  {
    name: 'P6④ · 硬拦：模型建议搬「AI操作规范」→ 被拦下，且那个文件一字节没动',
    script: `(async () => {
      /**
       * 🔴 **整段包在 try/finally 里**（独立审查 A🔴2 抓到的真缺陷）：
       * 这一步要装一把**假 key**（面板没配 key 时不让问，而这一步用的是假传输层），
       * 第一版把还原写成「收尾那一行」，于是 —— 两条**早退**路径 + 末尾**截图演示**又装了一次
       * —— 假 key 就留在真机的 data.json 里，**把用户自己的 key 覆盖掉了**
       *（真机取证：20:42 是假 key，20:43 被手工贴回真 key）。
       * 放进 finally 之后，「每一条出路都还原」是**结构**保证的，不靠作者记得。
       * ⚠️ 探针里凡是要动**用户凭据**的地方，一律这个形状。
       */
      const P = window.__kbwProbe;   // ⚠️ 必须在 try **外面**：finally 里也要用它
      let prevKey = null;
      const sessBefore = await P.sessionIds();   // P7.3a：面板会存会话，跑完按 diff 收走自己造的
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        const ctx = P.ctx();
        const kb = ctx.settings.kbRoot();
        const problems = [];
        const note = (m) => problems.push(m);
        const C = '__探针AI丙';
        const relC = kb + '/00_Inbox/' + C + '.md';
        const destC = kb + '/01_Projects/' + C + '.md';
        const ruleRel = '99_Meta/03_AI指令集/AI操作规范.md';
        const ruleAbs = kb + '/' + ruleRel;

        await P.seedAiNotes([C]);
        const ruleFile = app.vault.getAbstractFileByPath(ruleAbs);
        if (!ruleFile) { await P.dropAiNotes([C]); return { ok: false, info: '库里没有 AI操作规范.md，这一步验不了' }; }
        const before = await app.vault.read(ruleFile);

        P.stubAiSeq([
          {
            reply: '一条能搬、一条是我乱说的。',
            ideas: [
              { path: '00_Inbox/' + C + '.md', to: '01_Projects', why: '这条合规' },
              { path: ruleRel, to: '01_Projects', why: '这条不许（红线）' }
            ]
          },
          { reply: '好，先这样。', ideas: [] }
        ]);
        const openErr = await P.openAiPanel();
        if (openErr) { await P.dropAiNotes([C]); return { ok: false, info: openErr }; }
        const askErr = await P.askAi('随便整理一下');
        if (askErr) { P.closeAll(3); await P.dropAiNotes([C]); return { ok: false, info: askErr }; }

        const panelText = P.text(P.lastModal());
        const blockedShown = panelText.indexOf('只能读、不能改') >= 0;
        if (!blockedShown) note('面板上没写「只能读、不能改」——拦下来的必须**说出来**，静默丢弃会让用户以为模型没想到');
        const rows = P.qa('.kbw-ai-plan .kbw-ai-row').length;
        if (rows !== 1) note('计划表该只剩合规那 1 行，实际 ' + rows + ' 行');

        const runBtn = P.qa('.kbw-ai-acts .kbw-btn').find((b) => P.text(b).indexOf('执行这') === 0);
        if (runBtn) P.click(runBtn);
        await P.wait(700);
        const cfm = P.lastModal();
        const primary = cfm ? Array.from(cfm.querySelectorAll('.kbw-modal-foot .kbw-btn')).find((b) => P.text(b).indexOf('移动这') === 0) : null;
        if (primary) P.click(primary);
        await P.wait(1600);

        // 🔴 核心判据：那个文件**一字节没动、还在原位**
        const after = app.vault.getAbstractFileByPath(ruleAbs);
        if (!after) note('AI操作规范.md 被搬走了');
        else {
          const now = await app.vault.read(after);
          if (now !== before) note('AI操作规范.md 的内容变了（' + before.length + ' → ' + now.length + ' 字符）');
        }
        if (app.vault.getAbstractFileByPath(kb + '/01_Projects/AI操作规范.md')) note('它出现在了 01_Projects 里');
        if (!app.vault.getAbstractFileByPath(destC)) note('合规那条没搬成（那闸门把好人也拦了）');
        if (app.vault.getAbstractFileByPath(relC)) note('合规那条还在原位');

        P.closeAll(3);
        const undoBtn = P.lastUndo('撤销');
        if (undoBtn) { P.click(undoBtn); await P.wait(2200); }
        await P.dropAiNotes([C]);
        P.realAi();
        const swept = await P.sweep((await ctx.snapshot.list()).slice(0, 1).map((s) => s.id), '__探针');
        /**
         * 截图停在「只能读、不能改」那一屏（理由同上一步：截图在脚本**返回之后**拍）。
         * 用一篇真笔记 + 那条红线文件演一遍 —— **不执行**，一个字都不动库。
         */
        const demoOne = ctx.index.notes().filter(function (e) {
          return !e.isTemplate && e.effectivePosition === '00_Inbox';
        })[0];
        if (demoOne) {
          P.stubAi(JSON.stringify({
            reply: '（截图用）一条合规、一条是我乱说的。',
            ideas: [
              { path: '00_Inbox/' + demoOne.basename + '.md', to: '01_Projects', why: '这条合规' },
              { path: '99_Meta/03_AI指令集/AI操作规范.md', to: '01_Projects', why: '这条不许（红线）' }
            ]
          }));
          if ((await P.openAiPanel()) === '') await P.askAi('随便整理一下');
        }
        return {
          ok: problems.length === 0,
          info: '拦下并说出来=' + blockedShown + ' · 计划剩 ' + rows + ' 行 · 规范文件仍在原位=' +
            !!after + ' 内容未变=' + (!!after && (await app.vault.read(after)) === before) +
            ' · 合规那条搬成了=' + !app.vault.getAbstractFileByPath(relC) +
            '｜清场 ' + swept.logs + ' 日志 / ' + swept.snaps + ' 快照' +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        await P.dropNewSessions(sessBefore);
      }
    })()`,
    shot: 'P6④-硬拦.png',
  },
  {
    name: 'P6④ · 真连接：真调一次模型（验 key 与网络通；没配 key 报「没验成」）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const cfg = ctx.settings.get().ai;
      /**
       * ⚠️ **没配 key（或者只有探针自己装的那把假 key）就说"没验成"，不报通过** ——
       * 这与"几何判据在拿不到视图实例时不许降级成通过"是同一条纪律。
       */
      if (!ctx.ai.isConfigured() || cfg.apiKey === P.AI_FAKE_KEY) {
        return { ok: false, info: '没配真 API key —— 这一条**没验成**（不是"通过"）。去「设置 → AI 助手」填上 key 再跑一次；baseURL=' + cfg.baseUrl + ' 模型=' + cfg.model };
      }
      P.realAi();
      const t0 = Date.now();
      let turn = null;
      let err = null;
      try {
        turn = await ctx.ai.ask({ question: '只回两个字：收到。不要给任何建议。' });
      } catch (e) { err = e; }
      const ms = Date.now() - t0;
      if (err) return { ok: false, info: '真调用失败（' + ms + 'ms）：' + (err.hint || err.message || String(err)) };
      const reply = (turn && turn.reply ? turn.reply : '').trim();
      if (reply.length === 0) return { ok: false, info: '回来了但 reply 是空的（' + ms + 'ms）——解析或形状不对' };
      const leaked = reply.indexOf(cfg.apiKey) >= 0;
      return {
        ok: !leaked,
        info: 'baseURL=' + cfg.baseUrl + ' 模型=' + cfg.model + ' 用时 ' + ms + 'ms｜reply=' + reply.slice(0, 40) +
          '｜建议 ' + turn.proposed + ' 条（过闸 ' + turn.plan.rows.length + ' 条）' +
          (leaked ? ' ｜⚠️ 回话里出现了 key —— 不该发生' : ' ｜真连接通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.3a · AI 会话恢复 + 选区引用：关面板再开还在 · @ 菜单认得当前选区',
    script: `(async () => {
      const P = window.__kbwProbe;
      let prevKey = null;
      const sessBefore = await P.sessionIds();
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        const ctx = P.ctx();
        const kb = ctx.settings.kbRoot();
        const problems = [];
        const note = (m) => problems.push(m);
        const NL = String.fromCharCode(10);
        const A = '__探针AI恢复';
        const rel = kb + '/00_Inbox/' + A + '.md';
        const marker = '被引用的一行文字';
        const old = app.vault.getAbstractFileByPath(rel);
        if (old) await app.vault.delete(old, true);
        const file = await app.vault.create(rel, ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中',
          '创建日期: 2026-10-02', 'tags: []', '---', '', marker + '。', ''].join(NL));
        await P.wait(700);

        /**
         * ── 第一段：@ 引用里的「当前选区」 ──
         * 选区只有真机有（离线桩里没有编辑器选区那一层），所以这一节只能在这里验：
         * 把这篇文章开成标签页 → 设一个选区 → 打开面板 → 点「@ 引用」→ 菜单里该有「当前选区」那一项。
         */
        const leaf = app.workspace.getLeaf('tab');
        await leaf.openFile(file);
        await P.wait(900);
        let selLen = 0;
        try {
          const ed = leaf.view && leaf.view.editor;
          if (ed && ed.setSelection) {
            const lines = String(ed.getValue() || '').split(NL);
            const li = lines.findIndex((l) => l.indexOf(marker) >= 0);
            if (li >= 0) ed.setSelection({ line: li, ch: 0 }, { line: li, ch: 5 });
            await P.wait(250);
            selLen = String((ed.getSelection && ed.getSelection()) || '').length;
          }
        } catch (e) { /* 下面按"没验成"处理 */ }

        const openErr = await P.openAiPanel();
        if (openErr) {
          note('打开 AI 面板失败：' + openErr);
        } else {
          /**
           * ⚠️ P7.12 · R4（#16）：旧的「@ 引用」独立按钮**收进底栏「＋」菜单**了
           *（条目「引用一篇笔记…」）—— 从那儿点开小面板，链条照旧验。
           */
          const plusBtn = P.q('.kbw-ai-plusbtn');
          if (!plusBtn) note('面板里没有底栏「＋」（R4 收纳）');
          else {
            P.click(plusBtn);
            await P.wait(400);
            const refItem = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('引用一篇笔记') >= 0; });
            if (!refItem) note('「＋」菜单里没有「引用一篇笔记…」');
            else P.click(refItem);
            await P.wait(600);
            /**
             * ⚠️ **P7.10 · #12：@ 引用从小菜单升级成小面板**（搜索 + 目录树 + 列表）——
             * 「当前选区」那一行现在住「.kbw-ai-refitem」里（面板最上；有选区才画）。
             */
            const picker = document.querySelector('.kbw-ai-refpanel');
            if (!picker) note('@ 引用小面板没开（#12 面板化回归了？）');
            const items = picker ? Array.from(picker.querySelectorAll('.kbw-ai-refitem')) : [];
            const selItem = items.find((it) => (it.textContent || '').indexOf('当前选区') >= 0);
            if (selLen > 0 && !selItem) note('编辑器里有选区（' + selLen + ' 字），引用面板里却没有「当前选区」');
            else if (selLen === 0 && selItem) note('编辑器里没有选区，面板却出了「当前选区」');
            else if (selLen === 0) note('这一节没验成：选区没设上（看上面那条）');
            if (!selItem) { /* 已记 */ }
            else {
              P.click(selItem);
              await P.wait(300);
              const chip = P.q('.kbw-ai-ref');
              if (!chip) note('点了「当前选区」但胶囊没出现');
              else if ((chip.textContent || '').indexOf('选区') < 0) note('胶囊文案不对：' + (chip.textContent || ''));
            }
          }
        }

        /**
         * ── 第二段：会话恢复（完成定义那条：关掉面板再打开，上一段对话还在）──
         * 假传输层（P.stubAi 换的是没有 stream 的 transport）→ 面板走打字机降级，
         * 不联网、输出稳定。askAi 内部等 1400ms，盖得过打字机（约 256ms）。
         */
        const Q = '恢复判据用的问题';
        const R = '收到，这是恢复判据用的回答。';
        P.stubAi(JSON.stringify({ reply: R, ideas: [] }));
        const askErr = await P.askAi(Q);
        if (askErr) note('提问失败：' + askErr);
        const firstText = P.text(document.querySelector('.kbw-ai-log')) || '';
        if (firstText.indexOf(R) < 0) note('第一轮的回答没上屏');

        P.closeAll(3);   // 关面板（closeAll 末尾会把工作台带回前台）
        await P.wait(500);
        if (document.querySelector('.kbw-ai-log')) note('关掉之后面板还在');
        const reopenErr = await P.openAiPanel();
        if (reopenErr) {
          note('重开面板失败：' + reopenErr);
        } else {
          await P.wait(1200);   // 恢复是读盘 + 重画，给它一拍
          const hist = document.querySelector('.kbw-ai-hist');
          if (!hist) note('重开之后没有 .kbw-ai-hist（会话没恢复出来）');
          else {
            const t = P.text(hist) || '';
            if (t.indexOf(Q) < 0) note('恢复块里没有上一段的问题');
            if (t.indexOf(R) < 0) note('恢复块里没有上一段的回答');
          }
        }

        // ── 收尾一：关面板 / 关掉自己开的标签页 / 删夹具 ──
        P.closeAll(3);
        app.workspace.getLeavesOfType('markdown').forEach(function (l) {
          if (l.view && l.view.file && l.view.file.path === rel) l.detach();
        });
        await P.wait(300);
        const left = app.vault.getAbstractFileByPath(rel);
        if (left) await app.vault.delete(left, true);
        await P.wait(400);

        /**
         * ── 收尾二：**重新把面板开出来停在「恢复块」这一屏** ──
         * 截图是脚本 return **之后**才拍的 —— 收尾把它关了的话，拍到的是别的屏
         *（P6① 与 P6④ 各栽过一次）。会话文件由 finally 收走，但 DOM 已经画好了，拍得到。
         */
        if ((await P.openAiPanel()) === '') await P.wait(1200);

        return {
          ok: problems.length === 0,
          info: '选区 ' + selLen + ' 字 · @ 菜单认领=' + (problems.length === 0 && selLen > 0 ? '过了' : (selLen > 0 ? '见下' : '没验成')) +
            ' · 恢复（关→开）=' + (problems.length === 0 ? '过了' : '见下') +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        await P.dropNewSessions(sessBefore);
      }
    })()`,
    shot: 'P7.3a-会话恢复.png',
  },
  {
    name: 'P7.3b · agent：搜索的步骤行落地即画 + 历史对话抽屉能开能选',
    script: `(async () => {
      const P = window.__kbwProbe;
      let prevKey = null;
      const sessBefore = await P.sessionIds();
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        const ctx = P.ctx();
        const problems = [];
        const note = (m) => problems.push(m);
        const A = '__探针AI抽屉';
        const rel = ctx.settings.kbRoot() + '/00_Inbox/' + A + '.md';
        await P.seedAiNotes([A]);
        /**
         * 两步假回话：**同一批里** search（只读类，自动执行）+ move（需确认，停卡片）。
         * 放同一批是为了让"搜索的步骤行先于待确认卡"成为**真**判据（独立审查 🟢8：
         * 分两批的话，把回调改成"整批 await 完才报"这条断言照样过）。
         * 然后点「跳过」把这一轮收干净（不搬文件）。
         */
        P.stubAiSeq([
          {
            reply: '我先看一眼收件箱。',
            actions: [
              { tool: 'search', args: { dir: '00_Inbox' } },
              { tool: 'move', args: { path: '00_Inbox/' + A + '.md', to: '01_Projects', why: '看一眼' } }
            ]
          },
          { reply: '查到 ' + A + ' 在收件箱里。', ideas: [] }
        ]);
        const openErr = await P.openAiPanel();
        if (openErr) { await P.dropAiNotes([A]); return { ok: false, info: openErr }; }
        const askErr = await P.askAi('看看收件箱里有什么');
        if (askErr) { P.closeAll(3); await P.dropAiNotes([A]); return { ok: false, info: askErr }; }

        const panel = P.lastModal();
        const steps = P.qa('.kbw-ai-step');
        if (steps.length < 1) note('没有步骤行（agent 的干活过程要看得见）');
        const stepText = steps.map(function (s) { return P.text(s); }).join(' ｜ ');
        if (stepText.indexOf('命中') < 0) note('搜索那一步没有画出结果（步骤行该写着「命中 N 篇」），实际：' + stepText);
        const cardRows = P.qa('.kbw-ai-plan .kbw-ai-row').length;
        if (cardRows !== 1) note('待确认卡该有 1 行（搬运那条），实际 ' + cardRows + ' 行');
        const skipBtn = P.qa('.kbw-ai-acts .kbw-btn').find(function (b) { return P.text(b).indexOf('跳过') >= 0; });
        if (!skipBtn) note('待确认卡上没有「跳过」');
        else {
          const beforeOps = document.querySelectorAll('.kbw-ai-ops').length;
          P.click(skipBtn);
          const settled = await P.waitFor(function () { return document.querySelectorAll('.kbw-ai-ops').length > beforeOps; }, 12000);
          if (!settled) note('点了「跳过」之后这一轮没收尾');
        }
        if (P.text(panel).indexOf('在收件箱里') < 0) note('收尾那句话没上屏');
        if (P.text(panel).indexOf('什么都没改') < 0 && P.text(panel).indexOf('已跳过') < 0) note('跳过之后没有如实说明');

        /**
         * ── 历史对话抽屉：点左上角图标 → 左侧滑出 → 选中一段 → 载入 ──
         * 会话是**刚才这一轮**存下的（面板每完成一轮就落一份），抽屉里该看得到它。
         */
        /**
         * ⚠️ P7.12 · R4（#16）：头部左侧的「历史对话」图标**收进「⋯」菜单** ——
         * 抽屉照旧验，入口换成：点「⋯」→ 菜单「历史对话」。
         * P7.9 · ⑦c 的光学补偿断言随之**退役**（它量的是"头部左侧图标 vs 标题"——
         * R4 后左侧不再有图标，前提不存在；补偿样式仍在「histbtn」上，留作回归）。
         */
        const moreBtn = document.querySelector('.kbw-ai-morebtn');
        if (!moreBtn) note('头部没有「⋯」（R4 收纳）');
        else {
          P.click(moreBtn);
          await P.wait(400);
          const histItem = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('历史对话') >= 0; });
          if (!histItem) note('「⋯」菜单里没有「历史对话」');
          else P.click(histItem);
          await P.wait(700);
          const drawer = document.querySelector('.kbw-ai-drawer');
          if (!drawer) note('点了「历史对话」但抽屉没出来');
          else {
            const items = Array.from(drawer.querySelectorAll('.kbw-ai-sess'));
            if (items.length < 1) note('抽屉里一条会话都没有（刚才这一轮该存下了一份）');
            else {
              if (!drawer.querySelector('.kbw-ai-sess.is-active')) note('当前这一段没有高亮（is-active）');
              items[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              await P.wait(900);
              if (document.querySelector('.kbw-ai-drawer')) note('选了会话之后抽屉没收起');
              const hist = document.querySelector('.kbw-ai-hist');
              if (!hist) note('载入之后没有会话块（.kbw-ai-hist）');
              else if (P.text(hist).indexOf('看看收件箱里有什么') < 0) note('载入的会话里没有刚问的那一句');

              /**
               * ── P7.9 · ⑦b 半步：「＋ 新建对话」（用户原话"没找到入口"）——
               * 抽屉顶部一枚**全宽**按钮；点了 = 清屏开新段（旧段落盘仍在 —— 抽屉里该还有它）。
               */
              // 重开抽屉：走新入口（⋯ 菜单 → 历史对话；R4 之前是再点一次头部图标）
              P.click(moreBtn);
              await P.wait(400);
              const histItem2 = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('历史对话') >= 0; });
              if (histItem2) P.click(histItem2);
              await P.wait(800);
              const drawer2 = document.querySelector('.kbw-ai-drawer');
              if (!drawer2) note('重开抽屉失败（⑦b 半步的前提）');
              else {
                if (drawer2.querySelectorAll('.kbw-ai-sess').length < 1) note('旧对话不见了（新对话不该删旧的）');
                const newBtn = Array.from(drawer2.querySelectorAll('.kbw-btn')).find(function (b) {
                  return P.text(b).indexOf('新建对话') >= 0;
                });
                if (!newBtn) note('抽屉顶部没有「＋ 新建对话」（P7.9 · ⑦b 回归了）');
                else {
                  const nr = newBtn.getBoundingClientRect();
                  const dr = drawer2.getBoundingClientRect();
                  if (nr.width < dr.width * 0.7) note('「＋ 新建对话」不是全宽（' + Math.round(nr.width) + ' / ' + Math.round(dr.width) + '）');
                  newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                  await P.wait(900);
                  if (document.querySelector('.kbw-ai-drawer')) note('点了「新建对话」抽屉没收起');
                  const log2 = document.querySelector('.kbw-ai-log');
                  if (log2 && P.text(log2).indexOf('看看收件箱里有什么') >= 0) note('「新建对话」没有清屏（旧对话还挂着）');
                }
              }
            }
          }
        }

        P.closeAll(3);
        await P.dropAiNotes([A]);
        /**
         * 截图停在抽屉这一屏（脚本返回之后才拍）：重新开面板 → 打开抽屉。
         */
        if ((await P.openAiPanel()) === '') {
          await P.wait(900);
          const b = document.querySelector('.kbw-modal-leading .kbw-iconbtn');
          if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          await P.wait(600);
        }
        return {
          ok: problems.length === 0,
          info: '步骤行=' + steps.length + '（' + stepText.slice(0, 60) + '）· 抽屉/载入=' + (problems.length === 0 ? '过了' : '见下') +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        await P.dropNewSessions(sessBefore);
      }
    })()`,
    shot: 'P7.3b-历史对话抽屉.png',
  },
  /* ══════════════════════════════════════════════════════════════════
     P7.3c · 集成与交付（2026-10-02）
     ⚠️ 与 AI 那几步同一条纪律：**默认不联网**（P.stubAiSeq 装假回话）；
        要动用户凭据的地方一律 try/finally（假 key、能力包文件、探针造的笔记都要收走）。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.3c · 三处集成：笔记菜单「问 AI」/ editor-menu 四个预设 / 能力包收窄 + 成本行',
    script: `(async () => {
      const P = window.__kbwProbe;
      let prevKey = null;
      const sessBefore = await P.sessionIds();
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const NL = String.fromCharCode(10);
      const A = '__探针AI问';
      const skillDir = ctx.settings.workbenchDir() + '/skills';
      const skillPath = skillDir + '/__探针只搜不动.md';
      /** 三段各自的结论（return 在 finally 之后拼，所以要在这里能读到） */
      let menuOk = '没验成';
      let presetOk = '没验成';
      let skillOk = '没验成';
      let usageText = '';
      /**
       * 假菜单（形状最小）：真机上探针在渲染进程里、拿不到 obsidian 的 Menu 构造器，
       * 而这一步要验的是**我们注册的那个监听器**，不是平台的菜单渲染（与 P6⑥ 那一步同）。
       */
      function mkMenu() {
        const m = { items: [] };
        m.addItem = function (cb) {
          const rec = { title: '', sub: null, run: null };
          const handle = {
            setTitle(t) { rec.title = t; return handle; },
            setIcon() { return handle; },
            setSection() { return handle; },
            onClick(fn) { rec.run = fn; return handle; },
            setSubmenu() { const s = mkMenu(); rec.sub = s; return s; },
          };
          cb(handle);
          m.items.push(rec);
          return m;
        };
        return m;
      }
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await P.seedAiNotes([A]);
        /**
         * 🔴 **顺序刻意是「先 editor-menu、后笔记菜单」**（2026-10-02 真机试出来的）：
         * 笔记菜单那一段要用 P.closeAll() 收面板，而 closeAll 结尾会 revealLeaf
         * 把工作台带回前台 —— 之后再开一篇笔记给它设选区，setSelection 不报错、
         * 但 getSelection() **当场是空的**（实测：文档长度 68、活动叶 true、试 8 轮都空）。
         * 所以把要选区的那一段放在最前面：那时还没开关过任何面板。
         */
        // ══ ② editor-menu：有选区 → 「问 AI（选中文本）› 四个预设」→ 点了带引用 + 预填 ══
        const file = app.vault.getAbstractFileByPath(kb + '/00_Inbox/' + A + '.md');
        if (!file) {
          note('拿不到探针造的那一篇（editor-menu 这条没验成）');
        } else {
          /**
           * ⚠️ **选区这一格：真机合成选区在这条路径上屡试不成，所以只把 getSelection 打桩**
           *（2026-10-03 实测，证据留档：文档长度 68 字、叶是活动叶、mode=source、.cm-content
           *  已挂载、view.file 就是那一篇、setSelection 不报错，但 getSelection() 连试 8 轮都是空；
           *  同一段代码在 scripts/cdp-eval.mjs 里单跑**一次就成**（选区「# 」），差异至今没定位到）。
           *
           * 于是这一条**验的是"我们注册的处理链"**：平台事件 → 我们的子菜单（有选区才画）
           * → 四个预设 → 点了之后面板带引用 + 预填。**"用户真选的文字能不能读出来"** 由
           * P7.3a 的「@ 当前选区」那一步负责（它跑通过，选区 5 字）。
           * 打桩用 Object.create(真编辑器)：只换 getSelection，别的（getCursor 之类）走原型链
           * —— 平台与别的插件的 onEditorMenu 处理器拿到它不会抛（传空对象会刷一屏异常，P6⑥ 记过）。
           */
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(file, { state: { mode: 'source' } });
          await P.wait(1200);
          const liveEd = leaf.view && leaf.view.editor ? leaf.view.editor : null;
          if (!liveEd) {
            note('拿不到真编辑器（editor-menu 这条没验成）');
          } else {
            const selText = '探针选中的一段';
            const ed = Object.create(liveEd);
            ed.getSelection = function () { return selText; };
            const root = mkMenu();
            app.workspace.trigger('editor-menu', root, ed, { file: file });
            await P.wait(500);
            /**
             * ⚠️ P7.12 · R8（批 3）：editor-menu 改**两栏** ——「问 AI（选中文本）」搬进
             * **经纬AI ›**（有选区才出现）；四个预设仍是它的二级项。入口换、链条照验。
             */
            const ours = root.items.filter(function (i) { return i.title === '经纬AI'; })[0];
            const sub = ours && ours.sub ? ours.sub.items : [];
            const askItem = sub.filter(function (i) { return i.title.indexOf('问 AI') >= 0; })[0];
            if (!askItem) {
              note('有选区时 经纬AI 里没有「问 AI（选中文本）」（子菜单：' + sub.map(function (i) { return i.title; }).join('/') + '）');
            } else {
              const presets = askItem.sub ? askItem.sub.items : [];
              if (presets.length !== 4) note('四个预设没齐（实际 ' + presets.length + ' 个）');
              else {
                presets[0].run();
                await P.wait(900);
                const chip2 = P.q('.kbw-ai-ref');
                const input2 = P.q('.kbw-ai-input');
                if (!input2) note('点了预设之后面板没开');
                else if (!chip2) note('预设进来没带选区引用');
                else if (String(chip2.textContent || '').indexOf(selText) !== 0 &&
                         String(chip2.textContent || '').indexOf('选区') < 0) {
                  note('胶囊不像"某篇的选区"：' + String(chip2.textContent || ''));
                } else if (!input2.value) note('预设没有预填那句话');
                else presetOk = presets.length + ' 个预设 · 引用=' + String(chip2.textContent || '').slice(0, 12) + ' · 预填=' + String(input2.value).slice(0, 8) + '…（选区是打桩的）';
              }
            }
            // ②b 没选区 → 那一项**不该**画（判据是"没有"，与上面那条成对）
            const edEmpty = Object.create(liveEd);
            edEmpty.getSelection = function () { return ''; };
            const root2 = mkMenu();
            app.workspace.trigger('editor-menu', root2, edEmpty, { file: file });
            await P.wait(400);
            const ours2 = root2.items.filter(function (i) { return i.title === '经纬'; })[0];
            const sub2 = ours2 && ours2.sub ? ours2.sub.items : [];
            if (sub2.some(function (i) { return i.title.indexOf('问 AI') >= 0; })) {
              note('没有选区时不该画「问 AI」（点了没反应的东西不该出现在菜单里）');
            }
          }
        }
        P.closeAll(2);
        await P.wait(300);
        // ══ ① 工作台笔记菜单：右键一篇 → 「问 AI（这一篇）」→ 面板 + 引用胶囊 ══
        ctx.goNotes();
        await P.wait(700);
        await P.useView('详细信息');
        await P.enterDirWithNotes();
        /** 优先找我们刚造的那一篇；不在本层就站进 00_Inbox 再找 */
        const findRow = function () {
          return P.qa('.kbw-trow').filter(function (r) {
            return (r.getAttribute('data-path') || '').indexOf(A) >= 0;
          })[0];
        };
        let row = findRow();
        if (!row) {
          const node = P.qa('.kbw-tree-item').filter(function (i) {
            return i.getAttribute('data-dir') === '00_Inbox';
          })[0];
          if (node) { P.click(node); await P.wait(900); }
          row = findRow();
        }
        if (!row) {
          note('列表里找不到刚造的那一篇（' + A + '）—— 笔记菜单这条没验成');
        } else {
          const c = P.center(row);
          P.rightClickAt(c.x, c.y);
          await P.wait(400);
          const item = P.qa('.kbw-menu-item').filter(function (i) {
            return P.text(i).indexOf('问 AI') >= 0;
          })[0];
          if (!item) {
            note('笔记菜单里没有「问 AI（这一篇）」');
          } else {
            P.click(item);
            await P.wait(700);
            const panel = P.lastModal();
            const chip = P.q('.kbw-ai-ref');
            if (!panel || !P.q('.kbw-ai-input')) note('点了「问 AI（这一篇）」面板没开');
            else if (!chip) note('面板里没有引用胶囊（那一篇没带上 —— 只塞 seed 是不行的）');
            else if (P.text(chip).indexOf(A) < 0) note('胶囊上不是右键的那一篇：' + P.text(chip));
            else menuOk = '引用=' + P.text(chip).slice(0, 24);
          }
          P.closeAll(2);
          await P.wait(400);
        }
        // ══ ③ 能力包：造一个"只开 search"的 → 面板选它 → 一问 → 白名单外的 move 被拒 + 成本行 ══
        await app.vault.adapter.mkdir(skillDir);
        await app.vault.adapter.write(skillPath, ['---', '名称: __探针只搜不动', '工具白名单: [search]', '---', '只看不动手。'].join(NL));
        P.stubAiSeq([
          { reply: '我先搜一下。', actions: [{ tool: 'search', args: { dir: '00_Inbox' } }] },
          { reply: '那篇我搬不动。', actions: [{ tool: 'move', args: { path: '00_Inbox/' + A + '.md', to: '01_Projects', why: '试试' } }] },
          { reply: '那就到这儿。' },
        ]);
        const openErr = await P.openAiPanel();
        if (openErr) {
          note('开 AI 面板失败：' + openErr);
        } else {
          // ⚠️ P7.12 · R4（#16）：能力包入口从独立图标换成「＋」菜单「能力包…」。
          const sbtn = P.q('.kbw-ai-plusbtn');
          if (!sbtn) {
            note('面板里没有「＋」（R4 收纳）');
          } else {
            P.click(sbtn);
            await P.wait(400);
            const sMenu = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('能力包') >= 0; });
            if (!sMenu) note('「＋」菜单里没有「能力包…」');
            else P.click(sMenu);
            await P.wait(600);
            const sitem = P.qa('.kbw-menu-item').filter(function (i) {
              return P.text(i).indexOf('__探针只搜不动') >= 0;
            })[0];
            if (!sitem) {
              note('能力包菜单里没有刚造的那个（目录或解析哪一步没通）');
            } else {
              P.click(sitem);
              await P.wait(500);
              const chip3 = P.q('.kbw-ai-skillchip');
              if (!chip3) note('选中能力包之后没有胶囊（当前带着什么必须看得见）');
              else {
                /**
                 * 🔴 **要量几何，不是"在 DOM 里"**（独立审查 🔴1 抓的缺陷正是这种形态：
                 * 元素在 DOM 里、而整排 display:none —— 用户看不见、✕ 也点不到）。
                 * 真机能量 rect，就量它。
                 */
                const r3 = chip3.getBoundingClientRect();
                if (!(r3.width > 20 && r3.height > 8)) {
                  note('能力包胶囊在 DOM 里但**看不见**（rect ' + Math.round(r3.width) + 'x' + Math.round(r3.height) + '）');
                }
              }
              const askErr = await P.askAi('看看收件箱里有什么');
              if (askErr) note(askErr);
              else {
                const txt = P.text(P.lastModal());
                if (txt.indexOf('没有开') < 0) note('白名单外的 move 没有被拒（该写着"这个能力包没有开"）');
                const usage = P.q('.kbw-ai-usage');
                if (!usage) note('这一轮没有用量脚注（17.10② 的成本行）');
                else {
                  usageText = P.text(usage);
                  // ⚠️ 假传输层不报 usage → **必须**回落估算并标出来（不标等于拿估算当实数）
                  if (usageText.indexOf('估算') < 0) note('假传输层不报 usage，估算是应标出来的：' + usageText);
                }
                const moved = app.vault.getAbstractFileByPath(kb + '/01_Projects/' + A + '.md');
                if (moved) note('🔴 白名单外的 move 居然真的执行了（文件被搬走了）');
                const still = app.vault.getAbstractFileByPath(kb + '/00_Inbox/' + A + '.md');
                if (!still) note('🔴 那一篇不在原位了（白名单没拦住）');
                else skillOk = chip3 ? '白名单外的 move 被拒 · 文件没动' : '见下';
              }
            }
          }
        }
        P.closeAll(3);
        await P.wait(400);
        return {
          ok: problems.length === 0,
          info: '笔记菜单=' + menuOk + '｜editor-menu=' + presetOk + '｜能力包=' + skillOk +
                '｜成本行=' + (usageText || '（没量到）') +
                (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        await P.dropNewSessions(sessBefore);
        try { await app.vault.adapter.remove(skillPath); } catch (e) { /* 没造过或已删 */ }
        await P.dropAiNotes([A]);
        for (const l of app.workspace.getLeavesOfType('markdown')) {
          const f = l.view && l.view.file;
          if (f && f.path === kb + '/00_Inbox/' + A + '.md') l.detach();
        }
        await P.wait(300);
      }
    })()`,
  },
  {
    name: 'P7.3c · 设置：权限六类三档真的写盘 + 「测试连接」把结果写进那一行',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      const prevAi = Object.assign({}, ctx.settings.get().ai);
      let tierOk = '没验成';
      let testOk = '没验成';
      try {
        /**
         * 权限面板：**从空表起手**（显式档位为空 = 一切走默认表），点「禁」→
         * ① 内存里写进 toolTiers.move；② **回读 data.json** 确认真的落盘
         *（内存写了、盘上没写 = 本项目最著名的那一类坑）。
         */
        await ctx.settings.save({ ai: Object.assign({}, ctx.settings.get().ai, { toolTiers: {} }) });
        ctx.openWorkbenchSettings();
        await P.wait(900);
        const modal = P.lastModal();
        const tab = modal && P.qa('.kbw-set-tab', modal).filter(function (x) {
          return P.text(x).indexOf('AI 助手') >= 0;
        })[0];
        if (!tab) {
          note('设置面板里找不到「AI 助手」栏');
        } else {
          P.click(tab);
          await P.wait(900);
          const moveRow = P.qa('.kbw-set-row', modal).filter(function (r) {
            return P.text(r).indexOf('搬动文件') >= 0;
          })[0];
          if (!moveRow) {
            note('权限面板里没有「搬动文件」那一行');
          } else {
            const segs = P.qa('.kbw-segbtn', moveRow);
            if (segs.length !== 3) note('那一行不是三档（实际 ' + segs.length + ' 个按钮）');
            else {
              /** 默认态：三档里亮的应当是「需确认」（显示的是**生效值**，不是"存过的值"） */
              if (P.text(segs[1]).indexOf('需确认') >= 0 && !segs[1].classList.contains('is-on')) {
                note('默认该亮「需确认」，实际亮的不是它');
              }
              P.click(segs[0]);
              await P.wait(800);
              const written = ctx.settings.get().ai.toolTiers || {};
              if (written.move !== 'off') {
                note('点了「禁」但内存里的 toolTiers.move 不是 off（实际 ' + JSON.stringify(written) + '）');
              } else {
                tierOk = '搬动文件=禁';
              }
              const raw = await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json');
              if (raw.indexOf('"move": "off"') < 0 && raw.indexOf('"move":"off"') < 0) {
                note('toolTiers 只改了内存 —— data.json 里没有这一档（"存了像没存"）');
              } else {
                tierOk = '搬动文件=禁（已落盘）';
              }
              /** 「全部恢复默认」把显式表清空（回落到默认表）—— 这一栏必须能一键退回去 */
              const reset = P.qa('.kbw-btn', modal).filter(function (b) {
                return P.text(b).indexOf('全部恢复默认') >= 0;
              })[0];
              if (!reset) note('没有「全部恢复默认」那枚按钮');
              else {
                P.click(reset);
                await P.wait(800);
                const after = ctx.settings.get().ai.toolTiers || {};
                if (Object.keys(after).length !== 0) note('「全部恢复默认」之后 toolTiers 还留着东西');
              }
            }
          }
          // ── 「测试连接」：装上假传输层（**不联网**），点一下，看结果写进那一行 ──
          const fake = { chat: async function () { return { text: 'ok' }; } };
          const real = ctx.ai.http;
          ctx.ai.transport = fake;
          const testBtn = P.qa('.kbw-btn', modal).filter(function (b) {
            return P.text(b).indexOf('测试连接') >= 0;
          })[0];
          if (!testBtn) {
            note('连接那一组里没有「测试连接」按钮');
          } else {
            P.click(testBtn);
            await P.wait(1200);
            const line = P.qa('.kbw-set-note', modal).filter(function (n) {
              return P.text(n).indexOf('连上了') >= 0 || P.text(n).indexOf('没连上') >= 0;
            })[0];
            if (!line) note('点了「测试连接」之后结果没有写出来');
            else if (P.text(line).indexOf('连上了') < 0) note('假传输层回了 ok，却报"没连上"：' + P.text(line));
            else testOk = P.text(line).slice(0, 40);
          }
          ctx.ai.transport = real;
        }
        P.key('Escape');
        await P.wait(500);
        return {
          ok: problems.length === 0,
          info: '权限=' + tierOk + '｜测试连接=' + testOk +
                (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        /** 用户的设置**必须原样还回去**（这一步为了验写盘动过 toolTiers） */
        await ctx.settings.save({ ai: prevAi });
        P.realAi();
        P.closeAll(2);
        await P.wait(300);
      }
    })()`,
  },
  {
    name: 'P6④ · 向导：从未配置过 → 弹 · 三步都能跳过 · 第 1 步真的生效 · 只读面（P7.14：新建分支真建目录那一路在本轮之后单独验）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      /**
       * 演"存量用户"：把 wizardDone 抹成 null（那个键从来没写过）+ **重载插件**
       *（"这次会话弹过没有"是会话态，不重载演不出来）。
       */
      const origRoot = P.ctx().settings.kbRoot();
      await P.setWizardDone(null);
      if (!(await P.reloadPlugin())) return { ok: false, info: '重载插件失败' };
      const ctx = P.ctx();
      if (ctx.settings.get().wizardDone !== null) note('wizardDone 没保持 null（存量用户的样子）');
      const filesBefore = app.vault.getMarkdownFiles().length;

      await ctx.activate();
      await P.wait(1500);
      let w = P.wizard();
      if (!w) {
        await P.setWizardDone(true);
        return { ok: false, info: '没弹出来 —— wizardDone=null + 路径是默认值，按 §14.1 就该弹（当前 kbRoot=' + ctx.settings.kbRoot() + ' metaDir=' + ctx.settings.get().metaDir + '）' };
      }
      /**
       * ── P7.9 · ① 四屏：引言 → ①工作文件夹 → ②模块开关 → 结语 ──
       * （检测屏已整屏退役）引言屏**不算一步**：先验它 + 步骤条不画，再「下一步」进第 1 步。
       */
      if (!P.q('.kbw-wiz-intro', w)) note('引言屏（原生 vs 经纬两栏对照）没画出来');
      const steps0 = P.qa('.kbw-wiz-step', w).length;
      if (steps0 !== 0) note('引言屏不该画步骤条，实际 ' + steps0 + ' 个');
      /**
       * ── P7.10 · #1/#5/#6（引言屏那一半）──
       * 长标题只在引言屏；「上一步」引言**不画**；副标题换了新句。
       */
      const footHas = function (label) {
        const ww = P.wizard();
        return !!ww && Array.from(ww.querySelectorAll('.kbw-modal-foot .kbw-btn')).some(function (b) { return P.text(b).indexOf(label) >= 0; });
      };
      const titleNow = function () {
        const t = P.q('.kbw-modal-title', P.wizard());
        return t ? P.text(t) : '';
      };
      if (titleNow().indexOf('为什么用经纬') < 0) note('引言屏标题该是长款（首次使用向导 · 为什么用经纬？），实际「' + titleNow() + '」');
      if (footHas('上一步')) note('引言屏不该画「上一步」（P7.10 · #5）');
      if (P.text(w).indexOf('可在设置中再次观看') < 0) note('副标题没换新句（P7.10 · #6，该含「可在设置中再次观看」）');
      if (P.text(w).indexOf('每步可跳过') >= 0) note('副标题旧句「每步可跳过」还在（P7.10 · #6）');
      P.wizardFoot('下一步');
      await P.wait(600);
      const steps = P.qa('.kbw-wiz-step', w).length;
      // ⚠️ P7.12 · #3：结语屏自己就是第 3 格「到处看看」→ 步骤条 2 → 3。
      if (steps !== 3) note('步骤条该有 3 步（P7.12 · #3：工作文件夹 / 模块开关 / 到处看看），实际 ' + steps);
      if (titleNow().indexOf('为什么用经纬') >= 0) note('第 1 步标题该回到短款（P7.10 · #1），实际「' + titleNow() + '」');
      if (!footHas('上一步')) note('第 1 步该有「上一步」（P7.10 · #5），却没画');
      /**
       * ── P7.11 · #11：第 1 步 = 试卷选项（不预选；**选中才出内容区**）──
       * 老交互（起手就铺树 + 输入框）在这一步之后被替换，别再把"直接读输入框"当前提。
       */
      const fork = P.qa('.kbw-wiz-opt', w);
      // P7.14：两张 → **三张**（第三张「整个库」）；P7.12 · #8 起是**横排卡片**（"上下堆叠"是更早的措辞）
      if (fork.length !== 3) note('第 1 步该有三张卡（新建/用现成的/整个库），实际 ' + fork.length);
      if (fork.some(function (o) { return o.classList.contains('is-on'); })) note('第 1 步默认**不预选**（Q8），实际有 is-on');
      if (P.qa('.kbw-wiz-field .kbw-input', w).length !== 0) note('未选时下方不该画输入框（选中才出内容区）');
      if (P.q('.kbw-ftree', w)) note('未选时也不该画目录树');
      const pickMode = function (word) {
        const o = P.qa('.kbw-wiz-opt', P.wizard()).find(function (x) { return P.text(x).indexOf(word) >= 0; });
        if (o) { P.click(o); return true; }
        return false;
      };

      /**
       * ── Pass A：**改目录名 → 真的生效**（§14 的硬要求）──
       *
       * 走两趟的原因：第 1 步一旦离开就回不去，而"改了要生效"与"跳过不落盘"
       * 是两条**方向相反**的判据，只能各走一趟。
       *
       * 🔴 这一趟还兼任另一件事：它把 kbRoot 挪到「库根/02_Areas」，
       * 于是**下一趟剩下的屏**在一个"本来没有 99_Meta 的库根"上跑 ——
       * 那才是能照出"向导偷偷写盘"的场景（在库根上写的话，配置文件本来就存在，
       * 判据会恒绿；独立审查 A🔴1 的缺陷就是这么躲过四层判据的）。
       */
      const altRoot = origRoot + '/02_Areas';
      const idxBefore = ctx.index.size();
      let idxAfter = idxBefore;
      // P7.11 · #11：先点「用现成的」才出内容区（未选 → 下方什么都不画）
      if (!pickMode('用现成的')) note('点不到「用现成的」选项');
      await P.wait(400);
      const inpA = P.qa('.kbw-wiz-field .kbw-input', w)[0];
      if (!inpA) note('第 1 步没有那个输入框');
      else {
        inpA.value = altRoot;
        inpA.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(200);
        if (!P.wizardFoot('下一步')) note('第 1 步没有「下一步」');
        await P.wait(2200);
        if (ctx.settings.kbRoot() !== altRoot) {
          note('第 1 步改了目录名，设置里却没变（实际 ' + ctx.settings.kbRoot() + '）');
        }
        idxAfter = ctx.index.size();
        if (idxAfter === idxBefore) {
          note('🔴 库根改了但索引没重建（' + idxBefore + ' → ' + idxAfter + '）—— 存进去而没重建是经典假绿');
        }
        // 收掉这一趟（「跳过教程」= wizardDone false），下一趟重新开
        // （P7.10 二拍②：按钮由「稍后」改名，语义不变）
        P.wizardFoot('跳过教程');
        await P.wait(900);
        if (P.wizard()) note('「跳过教程」没能关掉向导');
      }
      ctx.openWizard();
      await P.wait(900);
      w = P.wizard();
      if (!w) {
        await P.setWizardDone(true);
        return { ok: false, info: '走完 Pass A 之后重开向导失败（kbRoot 现在是 ' + ctx.settings.kbRoot() + '）' };
      }
      // 又一次重开 → 又落在引言屏：先「下一步」进第 1 步
      P.wizardFoot('下一步');
      await P.wait(600);

      // ── Pass B · 第 1 步：改一个不存在的目录，然后点「跳过这一步」→ 一个字都不该落盘 ──
      // P7.11 · #11：重开之后**又是未选态**（mode 是这一次向导会话的），照旧先点选项
      if (P.qa('.kbw-wiz-field .kbw-input', w).length === 0 && !pickMode('用现成的')) {
        note('Pass B：点不到「用现成的」选项');
      }
      await P.wait(400);
      const input = P.qa('.kbw-wiz-field .kbw-input', w)[0];
      if (!input) note('第 1 步没有那个输入框');
      else {
        input.value = '99_根本不存在';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(200);
      }
      if (!P.wizardFoot('跳过这一步')) note('第 1 步没有「跳过这一步」');
      await P.wait(800);
      if (ctx.settings.kbRoot() !== altRoot) note('点了「跳过」却把 kbRoot 改了（跳过的意思是不替用户确认）');
      if (!P.text(P.wizard()).includes('模块开关')) note('跳过之后没进到第 2 步');

      // ── 第 2 步：两个开关真的接线 ──
      const boxes = P.qa('.kbw-wiz-check-box');
      if (boxes.length !== 2) note('第 2 步该有 2 个开关（图谱 / 自动化），实际 ' + boxes.length);
      /**
       * ⚠️ **两个都拨**（独立审查 B🟡3）：原来只拨 boxes[1]（automation），
       * 把图谱那一行整段接错（比如也去 set automation）**照样绿**。
       */
      const SWITCHES = [[0, 'graph'], [1, 'automation']];
      for (const pair of SWITCHES) {
        const i = pair[0];
        const id = pair[1];
        if (!boxes[i]) continue;
        const was = ctx.gate.isOn(id);
        boxes[i].checked = !was;
        boxes[i].dispatchEvent(new Event('change', { bubbles: true }));
        await P.wait(700);
        if (ctx.gate.isOn(id) !== !was) note('拨「' + id + '」那个开关没动到真的 gate');
        boxes[i].checked = was;
        boxes[i].dispatchEvent(new Event('change', { bubbles: true }));
        await P.wait(700);
      }

      // ── 第 2 步 → 结语：检测屏已退役（P7.9 · ①），顺手把「全程只读」再验一遍 ──
      /**
       * 🔴 独立审查 A🔴1 的历史现场：向导曾号称只读却写盘 —— 「configs.ensure()」会
       * "不存在就把默认值写下去 + mkdir 祖先"，建出来的是
       * <kbRoot>/<metaDir>/06_工作台/库结构.json（**一个 .json**）加一整棵目录，
       * 而旧判据只数 getMarkdownFiles()，看不见它。
       * P7.9 检测屏退役后这条判据**转型成全程只读**：走完剩下的屏，
       * 工作台范围内的**全部路径**（含目录 / .json）一个都不许多。
       * 场景照旧成立：kbRoot 在 Pass A 已被挪到 <kbRoot>/02_Areas（下面本来没有 99_Meta），
       * 有 ensure 类写入的话这里一照就现形（在实验库根上写的话，那个文件本来就存在，恒绿）。
       */
      const pathsOf = () => app.vault.getAllLoadedFiles().map((f) => f.path).sort();
      const pathsBefore = pathsOf();
      if (!P.wizardFoot('下一步')) note('没有「下一步」');
      await P.wait(1500);
      const w3 = P.wizard();
      let checkRows = 0;
      if (!w3) note('第 2 步的「下一步」之后向导不见了');
      else {
        checkRows = P.qa('.kbw-wiz-check-row', w3).length;
        if (checkRows !== 0) note('检测行该整屏退役（P7.9 · ①），实际还有 ' + checkRows + ' 行');
        if (P.text(w3).indexOf('现场检测') >= 0) note('「现场检测」字样不该再出现');
        const cardsNow = P.qa('.kbw-wiz-card', w3).length;
        if (cardsNow !== 4) note('第 2 步的下一步该直接进结语屏（四张卡，P7.10 · #4），实际 ' + cardsNow + ' 张');
      }
      const added = pathsOf().filter((x) => pathsBefore.indexOf(x) < 0);
      if (added.length > 0) {
        note('🔴 向导号称只读却写盘了 —— 多出来的：' + added.slice(0, 4).join('、'));
      }
      const filesAfter = app.vault.getMarkdownFiles().length;
      if (filesAfter !== filesBefore) note('跑向导改了库里的文件数（' + filesBefore + ' → ' + filesAfter + '）—— 向导是全程只读的');

      // ── 结语屏（P7.10 · #4：四张卡 2×2）→ 点「看板」卡 = 记「完成」+ 直切 ──
      const cards = P.qa('.kbw-wiz-card', w);
      if (cards.length !== 4) note('结语屏该有 4 张去处卡（P7.10 · #4），实际 ' + cards.length);
      else {
        /**
         * **2×2 网格几何**（真机才量得到 —— jsdom 的 rect 是全同坐标）：
         * 前两张同一行、后两张同一行、第 2 行在第 1 行下面、同列左缘对齐。
         * 左上那张必须是「首页」（紫色强调那档由 CSS 源级断言钉，这里认身份）。
         */
        const rc = cards.map(function (x) { return x.getBoundingClientRect(); });
        if (Math.abs(rc[0].top - rc[1].top) > 2) note('2×2 几何：第 1、2 张不在同一行（top 差 ' + Math.round(Math.abs(rc[0].top - rc[1].top)) + 'px）');
        if (Math.abs(rc[2].top - rc[3].top) > 2) note('2×2 几何：第 3、4 张不在同一行');
        if (!(rc[2].top > rc[0].bottom - 2)) note('2×2 几何：第 2 行没有落在第 1 行下面');
        if (Math.abs(rc[0].left - rc[2].left) > 2) note('2×2 几何：第 1、3 张没在同一列');
        if (!(rc[1].left > rc[0].right - 2)) note('2×2 几何：第 2 张没有在第 1 张右边');
        if (P.text(cards[0]).indexOf('首页') < 0) note('左上那张该是「首页」，实际「' + P.text(cards[0]) + '」');
      }
      const boardCard = cards.find(function (x) { return P.text(x).indexOf('看板') >= 0; });
      let jumped = false;
      if (!boardCard) note('结语屏没有「看板」那张卡');
      else {
        P.click(boardCard);
        await P.wait(1200);
        if (P.wizard()) note('点卡片之后向导还开着');
        if (ctx.settings.get().wizardDone !== true) note('点卡片之后 wizardDone 不是 true，实际 ' + String(ctx.settings.get().wizardDone));
        jumped = ctx.settings.get().activeModule === 'board';
        if (!jumped) note('点「看板」卡没有切过去（activeModule=' + ctx.settings.get().activeModule + '）');
      }
      // 再走一遍验「完成」按钮本身（上一条验的是卡片那条路）；四屏 = 三次「下一步」到结语
      ctx.openWizard();
      await P.wait(700);
      for (let i = 0; i < 3; i += 1) { P.wizardFoot('下一步'); await P.wait(450); }
      if (!P.wizardFoot('完成')) note('结语屏没有「完成」');
      await P.wait(900);
      if (P.wizard()) note('点了「完成」向导还开着');
      if (ctx.settings.get().wizardDone !== true) note('「完成」之后 wizardDone 不是 true，实际 ' + String(ctx.settings.get().wizardDone));

      /**
       * **把 kbRoot 还原**（Pass A 把它挪到了 02_Areas）——
       * 不还原的话后面每一步都只看 02_Areas 那一片，症状会是"索引只剩几十篇"那种
       * 看着与向导毫无关系的假红。（这也是"探针动过的界面偏好要拨回基线"那条口径。）
       */
      await ctx.settings.save({ kbRoot: origRoot });
      await P.wait(1600);
      if (ctx.settings.kbRoot() !== origRoot) note('kbRoot 没还原回去（' + ctx.settings.kbRoot() + '）');

      /**
       * 截图停在**结语屏**（三张卡 + 首页底纹）。
       * 顺路**逐屏验配图**：图片真的加载出来没有 —— 这条**只有真机验得到**
       *（离线 jsdom 不加载图片，只能断言 src 字符串）。
       * ⚠️ 截图是脚本**返回之后**拍的：收尾别把向导关掉（第一次跑就拍到过首页）。
       * P7.9 · ①：配图只剩**引言两栏**（对比即主视觉）—— 第 1/2 步的截图随字段注一起退役。
       */
      ctx.openWizard();
      await P.wait(800);
      const shotsSeen = [];
      const introImgs = P.qa('.kbw-wiz-shot .kbw-wiz-img', P.wizard());
      if (introImgs.length < 2) note('引言屏该有 2 张对比图，实际 ' + introImgs.length);
      introImgs.forEach(function (img, i) {
        if (!(img.complete && img.naturalWidth > 0)) {
          note('引言配图 ' + (i + 1) + ' 没加载出来（naturalWidth=' + img.naturalWidth + '）');
        } else {
          shotsSeen.push(img.naturalWidth + 'x' + img.naturalHeight);
        }
      });
      P.wizardFoot('下一步'); await P.wait(600);
      if (P.qa('.kbw-wiz-shot', P.wizard()).length > 0) note('第 1 步不该再有截图（极简版：主图示是选项卡）');
      P.wizardFoot('下一步'); await P.wait(600);
      if (P.qa('.kbw-wiz-shot', P.wizard()).length > 0) note('第 2 步不该再有截图（极简版：主图示是开关行）');
      P.wizardFoot('下一步'); await P.wait(900);
      const bg = P.q('.kbw-wiz-cardbg');
      if (!bg) note('结语屏没有底图');
      else if (!(bg.complete && bg.naturalWidth > 0)) note('结语屏底图没加载出来');

      // 收尾把模块切回首页（上面点过「看板」卡）—— 别把这个状态留给后面的步骤
      const navHome2 = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome2) { P.click(navHome2); await P.wait(700); }

      return {
        ok: problems.length === 0,
        info: '引言✓ · 三步条=' + steps + ' · 第 1 步生效（索引 ' + idxBefore + '→' + idxAfter + '）· 跳过不落盘 · 开关接线 · 检测行（应 0）=' + checkRows +
          ' · 卡片四张/直切=' + jumped + ' · 配图（引言）=' + (shotsSeen.join(',') || '无') +
          ' · 库内文件数未变=' + (filesAfter === filesBefore) + ' · wizardDone=' + String(ctx.settings.get().wizardDone) +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P6④-向导.png',
  },
  /* ══════════════════════════════════════════════════════════════════
     P7.21a · AI 地基段一（任务注册表 / 只读工具族 / ask_user）
     ⚠️ 与 AI 那几步同一条纪律：默认不联网（stub 假回话）；
        要动用户凭据 / 探针自造文件的地方一律 try/finally。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.21a · 只读工具族：list/stats 真链路 + skill 收窄对新工具生效',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const NL = String.fromCharCode(10);
      const A = '__探针AI工具';
      const skillDir = ctx.settings.workbenchDir() + '/skills';
      const skillPath = skillDir + '/__探针只读一枚.md';
      let narrowOk = '没验成';
      /**
       * ⚠️ 假 key 与会话快照的**取与还都在 try 里**（独立审 🟡6）：前置两行若抛，
       * finally 不会跑 —— 假 key 就留在部署库的 data.json 里（P6④ 那条真机事故就是这个形状）。
       */
      let prevKey = null;
      let sessBefore = null;
      try {
        sessBefore = await P.sessionIds();
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await P.seedAiNotes([A]);
        // ① list/stats 同一批（都是只读自动档）：步骤行落地即画、结果如实
        P.stubAiSeq([
          { reply: '我先看看库。', actions: [
            { tool: 'stats', args: {} },
            { tool: 'list', args: { dir: '00_Inbox' } },
          ] },
          { reply: '看完了。' },
        ]);
        const openErr = await P.openAiPanel();
        if (openErr) { await P.dropAiNotes([A]); return { ok: false, info: openErr }; }
        const askErr = await P.askAi('先看看库的结构');
        if (askErr) { P.closeAll(3); await P.dropAiNotes([A]); return { ok: false, info: askErr }; }
        await P.waitFor(function () { return document.querySelectorAll('.kbw-ai-ops').length > 0; }, 12000);
        const stepsText = P.qa('.kbw-ai-step').map(function (s) { return P.text(s); }).join(' ｜ ');
        if (stepsText.indexOf('库概览') < 0) note('stats 那一步没有画出结果：' + stepsText);
        if (stepsText.indexOf('列了') < 0) note('list 那一步没有画出结果：' + stepsText);
        /**
         * ⚠️ 步骤行画的是 out.summary（**只有计数**）—— 笔记名在 detail 里、只喂模型不上屏。
         * 第一次跑红就栽在这儿（断言去找 '__探针AI工具'，而 summary 写的是「本层 N 篇」）。
         * 这里断"这一层至少列到 1 篇"（数字随沙盒现状漂，别钉死）。
         */
        if (!/本层 [0-9]+ 篇/.test(stepsText) || /本层 0 篇/.test(stepsText)) {
          note('list 的 summary 没带本层计数（或本层 0 篇 —— 刚造的夹具该在）：' + stepsText);
        }

        // ② skill 收窄对**新工具**生效：白名单 [search] 里没有 list —— 调用必须被拒且如实说明
        await app.vault.adapter.mkdir(skillDir);
        await app.vault.adapter.write(skillPath, ['---', '名称: __探针只读一枚', '工具白名单: [search]', '---', '只看不动手。'].join(NL));
        P.stubAiSeq([
          { reply: '我列一下。', actions: [{ tool: 'list', args: { dir: '00_Inbox' } }] },
          { reply: '好吧，那就不列了。' },
        ]);
        const sbtn = P.q('.kbw-ai-plusbtn');
        if (!sbtn) note('面板里没有「＋」（能力包入口）');
        else {
          P.click(sbtn);
          await P.wait(400);
          const sMenu = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('能力包') >= 0; });
          if (!sMenu) note('「＋」菜单里没有「能力包…」');
          else P.click(sMenu);
          await P.wait(600);
          const sitem = P.qa('.kbw-menu-item').filter(function (i) {
            return P.text(i).indexOf('__探针只读一枚') >= 0;
          })[0];
          if (!sitem) note('能力包菜单里没有刚造的那个（目录或解析哪一步没通）');
          else {
            P.click(sitem);
            await P.wait(500);
            const askErr2 = await P.askAi('列一下收件箱');
            if (askErr2) note(askErr2);
            else {
              const txt = P.text(P.lastModal());
              if (txt.indexOf('没有开') < 0) note('白名单少 list 时没有被拒（该写着"这个能力包没有开"）');
              const steps2 = P.qa('.kbw-ai-step').map(function (s) { return P.text(s); }).join(' ｜ ');
              narrowOk = txt.indexOf('没有开') >= 0 ? 'list 被拒：' + steps2.slice(-40) : '见下';
            }
          }
        }
        P.closeAll(3);
        await P.wait(400);
        return {
          ok: problems.length === 0,
          info: 'list/stats=' + (stepsText ? '过了' : '见下') + '（' + stepsText.slice(0, 60) + '）· 收窄=' + narrowOk +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        if (sessBefore !== null) await P.dropNewSessions(sessBefore);
        try { await app.vault.adapter.remove(skillPath); } catch (e) { /* 没造过或已删 */ }
        await P.dropAiNotes([A]);
      }
    })()`,
    shot: 'P7.21a-只读工具.png',
  },
  {
    name: 'P7.21a · ask_user：轻弹层能开能收（回答喂回 → 收尾 · 输入框解锁）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const A = '__探针AI问句';
      /** ⚠️ 取与还都在 try 里（独立审 🟡6；同上面那步的解释） */
      let prevKey = null;
      let sessBefore = null;
      try {
        sessBefore = await P.sessionIds();
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await P.seedAiNotes([A]);
        P.stubAiSeq([
          { reply: '我先问一句。', actions: [{ tool: 'ask_user', args: { question: '这批笔记按哪年归档？' } }] },
          { reply: '好，按 2026。' },
        ]);
        const openErr = await P.openAiPanel();
        if (openErr) { await P.dropAiNotes([A]); return { ok: false, info: openErr }; }
        // askAi 的"这一轮画完"信号已含 .kbw-ai-ask（探针 helper P7.21 加）——不会干等 12s
        const askErr = await P.askAi('帮我归档');
        if (askErr) { P.closeAll(3); await P.dropAiNotes([A]); return { ok: false, info: askErr }; }
        const appeared = await P.waitFor(function () { return document.querySelector('.kbw-ai-ask'); }, 12000);
        if (!appeared) {
          note('ask_user 的轻弹层没出现');
        } else {
          const q = P.q('.kbw-ai-ask .kbw-ai-ask-q');
          if (!q || P.text(q).indexOf('按哪年归档') < 0) note('弹层上没有模型的问题');
          const inp = P.q('.kbw-ai-ask-input');
          if (!inp) note('弹层没有输入框');
          else {
            inp.value = '按 2026 年';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            const okBtn = P.qa('.kbw-ai-ask-acts .kbw-btn').find(function (b) { return P.text(b).indexOf('回答') >= 0; });
            if (!okBtn) note('弹层上没有「回答」');
            else {
              P.click(okBtn);
              const done = await P.waitFor(function () { return document.querySelectorAll('.kbw-ai-ops').length > 0; }, 12000);
              if (!done) note('回答之后这一轮没收尾');
              const st = P.qa('.kbw-ai-step').map(function (s) { return P.text(s); }).join(' ｜ ');
              if (st.indexOf('用户回答') < 0) note('步骤行没写着「用户回答」：' + st);
              if (st.indexOf('按 2026 年') < 0) note('答案没有落到步骤行上：' + st);
              if (document.querySelector('.kbw-ai-ask')) note('回答之后弹层没收掉');
              const input = P.q('.kbw-ai-input');
              if (input && input.disabled) note('收尾后输入框还锁着');
            }
          }
        }
        P.closeAll(3);
        await P.wait(300);
        return {
          ok: problems.length === 0,
          info: '开=' + (appeared ? '过了' : '见下') + '· 收=' + (problems.length === 0 ? '过了（答案进步骤行）' : '见下') +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        if (sessBefore !== null) await P.dropNewSessions(sessBefore);
        await P.dropAiNotes([A]);
      }
    })()`,
    shot: 'P7.21a-ask_user.png',
  },
  {
    name: 'P7.21b · 能力包菜单与触发词挂载（/ 菜单 · 自动挂 · 来源写明 · 可撤）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const NL = String.fromCharCode(10);
      const skillDir = ctx.settings.workbenchDir() + '/skills';
      const skillName = '__探针斜杠包';
      const skillPath = skillDir + '/' + skillName + '.md';
      const triggerWord = '__探针触发词';
      /**
       * ⚠️ 这一步**不动 AI key**（「/」菜单与自动挂载都不需要模型）—— 没有假 key 的取还，
       * 也就没有"假 key 留在部署库"那条形状（与那批旧步不同，这里是有意的）。
       */
      let prevAuto = null;
      try {
        // 造一个带触发词与示例问法的能力包（跑完就删；技能读取直接走 adapter，不用 rescan）
        await app.vault.adapter.mkdir(skillDir);
        await app.vault.adapter.write(skillPath, ['---', '名称: ' + skillName, '触发词: [' + triggerWord + ']', '示例问法: [把探针的事办了]', '---', '只做探针的事。'].join(NL));
        await P.wait(200);

        const openErr = await P.openAiPanel();
        if (openErr) return { ok: false, info: openErr };
        const input = P.q('.kbw-ai-input');
        if (!input) return { ok: false, info: '面板里没有输入框' };
        const type = (v) => {
          input.value = v;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };

        // ── ① 输入框打 / → 弹出能力包菜单（含刚造的那个 + 示例问法提示） ──
        type('/');
        const menuUp = await P.waitFor(function () {
          return Array.from(document.querySelectorAll('.kbw-menu-item')).some(function (i) { return P.text(i).indexOf(skillName) >= 0; });
        }, 6000);
        if (!menuUp) note('打了 / 之后没弹出能力包菜单（或菜单里没有刚造的那个）');
        /**
         * 🔴 **焦点必须留在输入框**（独立审 R1 真缺陷的真机判据）：菜单默认会 root.focus()
         * 一抢焦点，之后敲的字全落进菜单根（非可编辑元素）→ "继续打字就地过滤"做不到。
         * 本步的打字是"程序性改值 + 派事件"（不经键盘）—— 行为上验不出来，所以**直接盯 activeElement**。
         */
        if (document.activeElement !== input) {
          note('打完 / 之后焦点被菜单抢走了（activeElement=' + (document.activeElement && document.activeElement.className || '?') + '）—— 继续打字会被吞');
        }
        const item = Array.from(document.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf(skillName) >= 0; });
        if (item && P.text(item).indexOf('把探针的事办了') < 0) note('菜单里没带「示例问法」的提示行');

        // ── ② 选中 → 挂上 + 输入框里的 /命令 清掉 ──
        if (item) P.click(item);
        const chipUp = await P.waitFor(function () { return P.q('.kbw-ai-skillchip'); }, 4000);
        if (!chipUp) note('从 / 菜单选中之后胶囊没出现');
        else if (P.text(P.q('.kbw-ai-skillchip')).indexOf(skillName) < 0) note('胶囊写的不是刚选的那个包');
        if (input.value !== '') note('选中之后输入框里的 /命令 没清掉（实际「' + input.value.slice(0, 20) + '」）');
        const x0 = P.q('.kbw-ai-skillchip .kbw-ai-ref-x');
        if (x0) P.click(x0);
        await P.wait(200);

        // ── ③ 触发词自动挂载：开关打开 → 打字命中 → 自动挂 + **来源写明** ──
        prevAuto = ctx.settings.get().ai.triggerAutoMount === true;
        await ctx.settings.save({ ai: Object.assign({}, ctx.settings.get().ai, { triggerAutoMount: true }) });
        type('帮我 ' + triggerWord + ' 干个活');
        const autoUp = await P.waitFor(function () {
          const c = P.q('.kbw-ai-skillchip');
          return c && P.text(c).indexOf(skillName) >= 0;
        }, 6000);
        if (!autoUp) note('触发词命中了但没自动挂上');
        else if (P.text(P.q('.kbw-ai-skillchip')).indexOf('触发词') < 0) note('自动挂的胶囊没写明来源（该带「（触发词）」）');

        // ── ④ ✕ 可撤：撤掉之后**这段还命中着的文字**里不再自动挂它（防抖那一拍也不挂回来） ──
        const x1 = P.q('.kbw-ai-skillchip .kbw-ai-ref-x');
        if (x1) P.click(x1);
        await P.wait(700);
        if (P.q('.kbw-ai-skillchip')) note('✕ 之后又被自动挂回来了');
        type('还是 ' + triggerWord + ' 这句');
        await P.wait(700);
        if (P.q('.kbw-ai-skillchip')) note('撤过之后、文字仍命中 —— 又被挂回来了（该 muted）');

        // ── ⑤ 文字不再命中（muted 解除）→ 再命中 → 重新挂；清空 → 自动撤下 ──
        type('换个说法');
        await P.wait(700);
        type('再 ' + triggerWord + ' 一下');
        const again = await P.waitFor(function () { return P.q('.kbw-ai-skillchip'); }, 6000);
        if (!again) note('文字换过一轮之后重新命中没再挂上（muted 没解除？）');
        type('');
        const gone = await P.waitFor(function () { return !P.q('.kbw-ai-skillchip'); }, 6000);
        if (!gone) note('文字清空之后自动挂的胶囊没撤下');

        P.closeAll(3);
        await P.wait(300);
        return {
          ok: problems.length === 0,
          info: '命令菜单=' + (menuUp ? '过' : '见下') + ' · 自动挂=' + (autoUp ? '过（来源写明 · 可撤 · 可重挂）' : '见下') +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        if (prevAuto !== null) {
          await ctx.settings.save({ ai: Object.assign({}, ctx.settings.get().ai, { triggerAutoMount: prevAuto }) });
        }
        P.closeAll(3);
        try { await app.vault.adapter.remove(skillPath); } catch (e) { /* 没造过或已删 */ }
      }
    })()`,
    shot: 'P7.21b-菜单与触发词.png',
  },
  /* ══════════════════════════════════════════════════════════════════
     P7.22a · 写面扩容（正文编辑 / rename / 属性快照）
     ⚠️ 与 AI 那几步同一条纪律：默认不联网（stub 假回话）；
        要动用户凭据 / 探针自造文件的地方一律 try/finally。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.22a · 正文编辑：真机改一篇（patch_text + diff 预览 + append）→ 撤销逐字节还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const A = '__探针AI正文';
      const rel = ctx.settings.kbRoot() + '/00_Inbox/' + A + '.md';
      /**
       * 撤销还原是"读回去写盘"的异步链 —— 轮询到逐字节一致再断（别赌固定时长）。
       * ⚠️ P.waitFor 的回调是**同步**判的（!!fn()）—— 异步读取只能手写这个轮询。
       */
      const readBack = async (path, want) => {
        let cur = '';
        for (let i = 0; i < 24; i += 1) {
          await P.wait(250);
          try { cur = await app.vault.adapter.read(path); } catch (e) { cur = ''; }
          if (cur === want) break;
        }
        return cur;
      };
      /**
       * **等写落盘**：轮询**真实文件**直到出现 needle。
       *
       * 🔴 为什么不等面板文本（"改好了"那种）—— P7.22a 首次复跑抓到的**假红根因**：
       * AI 面板打开时会**恢复最近一段会话**（静态重画），而本步**复跑**时最近的会话
       * 就是上一次跑本步的那段——里面已经有"改好了"三个字 → 面板文本里 indexOf 那句
       * **立即为真** → 读盘时写还没完成 → "没改到"（盘上还是旧句）。全量首跑时前一段
       * 会话不含这句，所以真等到了、也真绿。**等"用户能看到的新信号"，别等可能来自历史的字。**
       */
      const waitWrote = async (path, needle) => {
        let cur = '';
        for (let i = 0; i < 40; i += 1) {
          await P.wait(250);
          try { cur = await app.vault.adapter.read(path); } catch (e) { cur = ''; }
          if (cur.indexOf(needle) >= 0) break;
        }
        return cur;
      };
      let prevKey = null;
      let sessBefore = null;
      try {
        sessBefore = await P.sessionIds();
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await P.seedAiNotes([A]);
        const before = await app.vault.adapter.read(rel);

        // ── ① patch_text：单独一轮（单条正文写 → 确认框该带 diff 对比框）──
        P.stubAiSeq([
          { reply: '我来改这一句。', actions: [
            { tool: 'patch_text', args: { path: '00_Inbox/' + A + '.md', find: '# ' + A, replace: '# ' + A + '（改过）' } }
          ] },
          { reply: '改好了。' },
        ]);
        const openErr = await P.openAiPanel();
        if (openErr) { await P.dropAiNotes([A]); return { ok: false, info: openErr }; }
        const askErr = await P.askAi('把这篇开头的标题改一下');
        if (askErr) { P.closeAll(3); await P.dropAiNotes([A]); return { ok: false, info: askErr }; }

        const hasRunBtn = await P.waitFor(function () {
          return P.qa('.kbw-ai-acts .kbw-btn').some(function (b) { return P.text(b).indexOf('执行这') === 0; });
        }, 8000);
        if (!hasRunBtn) note('正文写没有停在待确认卡上');
        const runBtn = P.qa('.kbw-ai-acts .kbw-btn').find(function (b) { return P.text(b).indexOf('执行这') === 0; });
        if (runBtn) P.click(runBtn);

        // 确认框（面板 + 确认框 = 两个模态）：等它出现再点主按钮
        let confirmModal = null;
        for (let i = 0; i < 30 && !confirmModal; i += 1) {
          await P.wait(150);
          const ms = P.qa('.kbw-modal');
          if (ms.length >= 2) confirmModal = ms[ms.length - 1];
        }
        if (!confirmModal) note('点了「执行这」之后确认框没弹出来');
        else {
          if (!confirmModal.querySelector('.kbw-diff')) note('确认框里没有 diff 对比框（G9：正文写该带预览）');
          const planText = P.text(confirmModal.querySelector('.kbw-confirm-preview') || confirmModal);
          if (planText.indexOf('改正文') < 0) note('确认单上没有"改正文"的行：' + planText.slice(0, 80));
          const okBtn = confirmModal.querySelector('.kbw-modal-foot .kbw-btn.is-primary');
          if (!okBtn) note('确认框没有主按钮');
          else P.click(okBtn);
        }
        /** 等**盘上**出现改后的句子（别等"改好了"——历史会话里可能就有，见 waitWrote 顶注） */
        const after1 = await waitWrote(rel, A + '（改过）');
        if (after1.indexOf(A + '（改过）') < 0) note('patch_text 没真的改到标题（盘上还是旧句）');
        if (after1.indexOf('类型: 想法') < 0) note('前言被动了（正文写只该动正文那一半）');

        // ── ② 撤销：点撤销条 → 逐字节还原 ──
        await P.waitFor(function () { return !!P.lastUndo('撤销'); }, 4000);
        const ub = P.lastUndo('撤销');
        if (!ub) note('撤销条上没有「撤销」');
        else {
          P.click(ub);
          const restored = await readBack(rel, before);
          if (restored !== before) note('撤销之后没有逐字节还原（现 ' + restored.length + ' 字符 / 原 ' + before.length + '）');
        }

        // ── ③ append：再来一轮（同一条写链的另一个工具）──
        P.stubAiSeq([
          { reply: '末尾补一句。', actions: [
            { tool: 'append', args: { path: '00_Inbox/' + A + '.md', content: '正文末尾追加的一句。' } }
          ] },
          { reply: '补好了。' },
        ]);
        const askErr2 = await P.askAi('在末尾补一句');
        if (askErr2) note(askErr2);
        else {
          const hasRun2 = await P.waitFor(function () {
            return P.qa('.kbw-ai-acts .kbw-btn').some(function (b) { return P.text(b).indexOf('执行这') === 0; });
          }, 8000);
          if (!hasRun2) note('append 没有停在待确认卡上');
          const runBtn2 = P.qa('.kbw-ai-acts .kbw-btn').find(function (b) { return P.text(b).indexOf('执行这') === 0; });
          if (runBtn2) P.click(runBtn2);
          let cm2 = null;
          for (let i = 0; i < 30 && !cm2; i += 1) {
            await P.wait(150);
            const ms = P.qa('.kbw-modal');
            if (ms.length >= 2) cm2 = ms[ms.length - 1];
          }
          if (cm2) {
            const ok2 = cm2.querySelector('.kbw-modal-foot .kbw-btn.is-primary');
            if (ok2) P.click(ok2);
          } else note('append 那轮确认框没弹出来');
          const after2 = await waitWrote(rel, '正文末尾追加的一句。');
          if (after2.indexOf('正文末尾追加的一句。') < 0) note('append 没真的追加到末尾');
          // 收干净：撤销这条 append（还原到初始态，dropAiNotes 照常收）
          await P.waitFor(function () { return !!P.lastUndo('撤销'); }, 4000);
          const ub2 = P.lastUndo('撤销');
          if (ub2) {
            P.click(ub2);
            await readBack(rel, before);
          }
        }

        P.closeAll(3);
        await P.wait(300);
        return {
          ok: problems.length === 0,
          info: 'patch_text（含 diff 预览）· 撤销逐字节还原 · append —— ' +
            (problems.length ? '⚠️ ' + problems.join('；') : '全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        if (sessBefore !== null) await P.dropNewSessions(sessBefore);
        await P.dropAiNotes([A]);
      }
    })()`,
    shot: 'P7.22a-正文编辑.png',
  },
  {
    name: 'P7.22a · rename 与属性快照：真改名 / 真改属性 → 撤销逐字节还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const B = '__探针AI改名';
      const relB = ctx.settings.kbRoot() + '/00_Inbox/' + B + '.md';
      const relRenamed = ctx.settings.kbRoot() + '/00_Inbox/' + B + '甲.md';
      const readBack = async (path, want) => {
        let cur = '';
        for (let i = 0; i < 24; i += 1) {
          await P.wait(250);
          try { cur = await app.vault.adapter.read(path); } catch (e) { cur = ''; }
          if (cur === want) break;
        }
        return cur;
      };
      /** 待确认卡 → 执行 → 确认框 → 点主按钮（写类通用的那一串） */
      const runOneWrite = async () => {
        const has = await P.waitFor(function () {
          return P.qa('.kbw-ai-acts .kbw-btn').some(function (b) { return P.text(b).indexOf('执行这') === 0; });
        }, 8000);
        if (!has) { note('写类动作没有停在待确认卡上'); return false; }
        P.click(P.qa('.kbw-ai-acts .kbw-btn').find(function (b) { return P.text(b).indexOf('执行这') === 0; }));
        let cm = null;
        for (let i = 0; i < 30 && !cm; i += 1) {
          await P.wait(150);
          const ms = P.qa('.kbw-modal');
          if (ms.length >= 2) cm = ms[ms.length - 1];
        }
        if (!cm) { note('确认框没弹出来'); return false; }
        const ok = cm.querySelector('.kbw-modal-foot .kbw-btn.is-primary');
        if (!ok) { note('确认框没有主按钮'); return false; }
        P.click(ok);
        await P.wait(400);
        return true;
      };
      let prevKey = null;
      let sessBefore = null;
      try {
        sessBefore = await P.sessionIds();
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await P.seedAiNotes([B]);
        const before = await app.vault.adapter.read(relB);

        // ── ① rename：真改名（确认单上「改名」行）→ 撤销还原原名 ──
        P.stubAiSeq([
          { reply: '我把名字加一个字。', actions: [
            { tool: 'rename', args: { path: '00_Inbox/' + B + '.md', name: B + '甲' } }
          ] },
          { reply: '改好了。' },
        ]);
        const openErr = await P.openAiPanel();
        if (openErr) { await P.dropAiNotes([B]); return { ok: false, info: openErr }; }
        const askErr = await P.askAi('给这篇改个名');
        if (askErr) { P.closeAll(3); await P.dropAiNotes([B]); return { ok: false, info: askErr }; }
        const renamed = await runOneWrite();
        if (renamed) {
          await P.waitFor(function () { return !!app.vault.getAbstractFileByPath(relRenamed); }, 6000);
          if (!app.vault.getAbstractFileByPath(relRenamed)) note('rename 之后新名字的文件不在');
          if (app.vault.getAbstractFileByPath(relB)) note('rename 之后旧名字还在');
          let content = '';
          try { content = await app.vault.adapter.read(relRenamed); } catch (e) { content = ''; }
          if (content !== before) note('改名动了内容（该逐字节不动）');
          await P.waitFor(function () { return !!P.lastUndo('撤销'); }, 4000);
          const ub = P.lastUndo('撤销');
          if (!ub) note('改名没弹撤销条');
          else {
            P.click(ub);
            const back = await readBack(relB, before);
            if (back !== before) note('撤销之后原名没还原（或内容变了）');
          }
        }

        // ── ② 属性批改（P7.22a · #11 补的快照）：改「状态」→ 撤销逐字节还原 ──
        P.stubAiSeq([
          { reply: '我改一下状态。', actions: [
            { tool: 'set_prop', args: { path: '00_Inbox/' + B + '.md', key: '状态', value: '已完成' } }
          ] },
          { reply: '改好了。' },
        ]);
        const askErr2 = await P.askAi('把状态改成已完成');
        if (askErr2) note(askErr2);
        else {
          const okProp = await runOneWrite();
          if (okProp) {
            await P.wait(500); // 写盘是异步的 —— 先给一拍再读回
            const mid = await app.vault.adapter.read(relB);
            if (mid.indexOf('已完成') < 0) note('set_prop 没真的改到状态');
            await P.waitFor(function () { return !!P.lastUndo('撤销'); }, 4000);
            const ub2 = P.lastUndo('撤销');
            if (!ub2) note('属性改写没弹撤销条（#11 补的就是它）');
            else {
              P.click(ub2);
              const back2 = await readBack(relB, before);
              if (back2 !== before) note('属性撤销之后没有逐字节还原');
            }
          }
        }

        P.closeAll(3);
        await P.wait(300);
        return {
          ok: problems.length === 0,
          info: 'rename（真改名 · 撤销还原）· set_prop（快照还原）—— ' +
            (problems.length ? '⚠️ ' + problems.join('；') : '全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        if (sessBefore !== null) await P.dropNewSessions(sessBefore);
        // 改名若中途失败没还原：两个名字都收（dropAiNotes 找不到就跳过）
        await P.dropAiNotes([B, B + '甲']);
      }
    })()`,
    shot: 'P7.22a-改名与属性.png',
  },
  /* ══════════════════════════════════════════════════════════════════
     P7.24 · 服务族 L2（跑到确认卡 —— #9/G11；P7.22b 的"打开即停"已退役）
     ⚠️ 同一条纪律：默认不联网（stub 假回话）；动凭据/造夹具一律 try/finally。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.24 · 服务族 L2：跑到确认卡（幕后无面板）→ 执行 → 真搬 → 撤销还原 · 循环照常继续',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const NL = String.fromCharCode(10);
      const DIR = '__探针L2';
      const FILE = DIR + '/甲.md';
      const MOVED = '02_Areas/内容创作/甲.md';
      const SENT = 'P724L2_SENTINEL_第三拍';
      let prevKey = null;
      let sessBefore = null;
      try {
        sessBefore = await P.sessionIds();
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        /* 夹具：__探针L2/甲.md（假模型会提议把它搬去 02_Areas/内容创作） */
        const jia = KB + '/' + FILE;
        try { await app.vault.createFolder(KB + '/' + DIR); } catch (e) { /* 已存在 */ }
        if (!app.vault.getAbstractFileByPath(jia)) {
          await app.vault.create(jia, ['---', 'tags: []', '---', '', '# 甲'].join(NL) + NL);
        }
        const seeded = await P.until(function () {
          return !!app.vault.getAbstractFileByPath(jia) &&
            ctx.index.notes().some(function (e) { return e.path === jia; });
        }, 8000);
        if (!seeded) return { ok: false, info: '夹具没进索引' };
        /**
         * 假模型**三拍**（顺序敏感）：
         *  ① agent 那一拍：调 triage（dir=夹具目录 —— triage 吃 dir 收窄）；
         *  ② 分诊那一拍：回一条**确定性的**提案（把甲搬去 02_Areas/内容创作）→ 确认卡出；
         *  ③ 哨兵：用户点完卡之后**该**被消费（循环拿着结算继续跑 —— L2 不再"打开即停"）。
         */
        P.stubAiSeq([
          { reply: '我来跑一趟整理。', actions: [{ tool: 'triage', args: { dir: DIR } }] },
          { reply: '分诊看完了', ideas: [{ path: FILE, to: '02_Areas/内容创作', why: '探针' }] },
          { reply: SENT },
        ]);
        const realChat = ctx.ai.transport.chat;
        const returned = [];
        ctx.ai.transport.chat = async function (req, opts) {
          const r = await realChat(req, opts);
          returned.push(String(r.text));
          return r;
        };
        const openErr = await P.openAiPanel();
        if (openErr) return { ok: false, info: openErr };
        const askErr = await P.askAi('看看库里有什么可以整理的');
        if (askErr) { P.closeAll(3); return { ok: false, info: askErr }; }
        /* ① 确认卡到（没贴 kbw-offstage 的那种 backdrop 里的那张「即将整理」卡） */
        const cardUp = await P.waitFor(function () {
          return P.qa('.kbw-backdrop:not(.kbw-offstage) .kbw-modal').some(function (m) {
            return P.text(m).indexOf('即将整理') >= 0;
          });
        }, 12000);
        if (!cardUp) note('确认卡没到（跑到卡前停下那一步）');
        /* ② 幕后：suggest 面板挂着、但它的 backdrop 藏住（用户只该看见确认卡） */
        const off = P.q('.kbw-backdrop.kbw-offstage');
        const sugg = P.q('.kbw-suggest');
        if (!sugg) note('suggest 面板没挂（幕后模式的前提）');
        if (!off) note('幕后面板不在（backdrop 应贴 kbw-offstage）');
        else {
          const cs = getComputedStyle(off);
          if (cs.display !== 'none') note('幕后面板没藏住（display=' + cs.display + '）—— 用户会看见面板');
        }
        /* ③ 点执行（确认卡主按钮）→ 真搬 → 撤销还原 */
        const card = P.qa('.kbw-backdrop:not(.kbw-offstage) .kbw-modal').find(function (m) {
          return P.text(m).indexOf('即将整理') >= 0;
        });
        const btn = card
          ? Array.from(card.querySelectorAll('.kbw-modal-foot .kbw-btn')).find(function (b) {
              return b.classList.contains('is-primary') || b.classList.contains('is-danger');
            })
          : null;
        if (!btn) {
          note('确认卡上找不到主按钮');
        } else {
          P.click(btn);
          await P.wait(400);
          const moved = await P.until(function () {
            return !!app.vault.getAbstractFileByPath(KB + '/' + MOVED);
          }, 8000);
          if (!moved) note('点执行之后甲没搬过去（' + MOVED + ' 不在）');
          if (app.vault.getAbstractFileByPath(jia)) note('旧位置还在（不是搬、是复制？）');
          const undo = P.lastUndo('撤销');
          if (!undo) note('搬完没有撤销条');
          else {
            P.click(undo);
            const back = await P.until(function () { return !!app.vault.getAbstractFileByPath(jia); }, 8000);
            if (!back) note('撤销没能把文件放回原位');
          }
        }
        /* ④ 循环继续了：哨兵被消费（L2 不再"打开即停"） */
        const consumed = await P.until(function () {
          return returned.some(function (t) { return t.indexOf('P724L2_SENTINEL') >= 0; });
        }, 4000);
        if (!consumed) note('用户点完之后循环没继续（哨兵没被消费 —— 还停在 handoff 的老口径？）');
        /* ⚠️ 次数也要钉（独立审 🔴1 的教训：只查"哨兵出现过"会被**重复分诊**提前消费而假绿）——
           正确序列 = agent 拍 + 分诊拍 + 收尾拍 = 3 次 */
        if (returned.length !== 3) {
          note('模型调用数应为 3（agent/分诊/收尾），实际 ' + returned.length + ' —— 查重复分诊或循环没继续');
        }
        await P.wait(300);
        return {
          ok: problems.length === 0,
          info: '确认卡=' + cardUp + ' · 幕后面板=' + (off ? '藏住' : '不在') +
            ' · 模型调用数=' + returned.length + ' · 哨兵被消费=' + consumed +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        P.realAi();
        if (prevKey !== null) await P.setAiKey(prevKey);
        if (sessBefore !== null) await P.dropNewSessions(sessBefore);
        for (const rel of [FILE, MOVED]) {
          const f = app.vault.getAbstractFileByPath(KB + '/' + rel);
          if (f) await app.vault.delete(f, true);
        }
        const d = app.vault.getAbstractFileByPath(KB + '/' + DIR);
        if (d) await app.vault.delete(d, true);
        await P.wait(400);
      }
    })()`,
    shot: 'P7.24-服务族L2.png',
  },
  {
    name: 'P7.14 · 向导「新建」真建目录（默认名）+「整个库」落盘与冒烟',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx0 = P.ctx();
      const origRoot = ctx0.settings.kbRoot();
      const origDone = ctx0.settings.get().wizardDone === true;
      const madeName = '__探针新建-' + Date.now();
      let made = false;
      let restored = false;
      try {
        // 演"从没配过" → 弹（"这次会话弹过没有"是会话态，必须重载）
        await P.setWizardDone(null);
        if (!(await P.reloadPlugin())) return { ok: false, info: '重载插件失败' };
        const ctx = P.ctx();
        await ctx.activate();
        await P.wait(1500);
        let w = P.wizard();
        if (!w) return { ok: false, info: '向导没弹（kbRoot=' + ctx.settings.kbRoot() + '）' };
        P.wizardFoot('下一步');
        await P.wait(600);
        const pickMode = function (word) {
          const o = P.qa('.kbw-wiz-opt', P.wizard()).find(function (x) { return P.text(x).indexOf(word) >= 0; });
          if (o) { P.click(o); return true; }
          return false;
        };
        const fork = P.qa('.kbw-wiz-opt', w);
        if (fork.length !== 3) note('第 1 步该有三张卡，实际 ' + fork.length);

        // ── ① 新建：默认名「经纬知识库」+ 点「下一步」**真的建出目录** ──
        //    （改成 __ 前缀的探针名 —— 别在实验库里留一个叫「经纬知识库」的真目录）
        if (!pickMode('新建')) note('点不到「新建」');
        await P.wait(400);
        const inp = P.qa('.kbw-wiz-field .kbw-input', P.wizard())[0];
        if (!inp) note('新建分支没有目录名输入框');
        else {
          if (inp.value !== '经纬知识库') note('新建默认名该是「经纬知识库」，实际「' + inp.value + '」');
          inp.value = madeName;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await P.wait(200);
        }
        P.wizardFoot('下一步');
        await P.wait(1400);
        made = await app.vault.adapter.exists(madeName);
        if (!made) note('🔴「新建」没把目录真建出来（' + madeName + ' 不存在）');
        if (ctx.settings.kbRoot() !== madeName) note('新建之后 kbRoot 没落盘（实际 ' + ctx.settings.kbRoot() + '）');
        // P7.14b：目录还要**立刻进平台缓存** —— 否则工作台喊"找不到库根"、要点一下别处才认
        if (!app.vault.getAbstractFileByPath(madeName)) {
          note('🔴 新建的目录没立刻进平台缓存（真机症状：向导跑完还是"找不到库根目录"）');
        }
        P.wizardFoot('跳过教程');
        await P.wait(800);
        if (P.wizard()) note('「跳过教程」没关掉向导');

        // ── ② 整个库：落盘空串 → 冒烟（只读）→ 立刻还原 ──
        ctx.openWizard();
        await P.wait(900);
        w = P.wizard();
        if (!w) note('重开向导失败');
        else {
          P.wizardFoot('下一步');
          await P.wait(600);
          if (!pickMode('整个库')) note('点不到「整个库」');
          await P.wait(400);
          if (P.qa('.kbw-wiz-field .kbw-input', P.wizard()).length !== 1) {
            note('整个库分支该只出「库配置目录」一个字段');
          }
          P.wizardFoot('下一步');
          await P.wait(1600);
          if (ctx.settings.kbRoot() !== '') note('「整个库」没落盘空串（实际「' + ctx.settings.kbRoot() + '」）');
          const metaRel = ctx.settings.metaRoot();
          if (metaRel.indexOf('/') === 0) note('metaRoot 带前导斜杠（' + metaRel + '）—— joinPath 那条没生效');
          const allMd = app.vault.getMarkdownFiles().filter(function (f) {
            return !f.path.split('/').some(function (s) { return s.indexOf('.') === 0; });
          }).length;
          if (ctx.index.size() !== allMd) note('整个库的索引篇数对不上（' + ctx.index.size() + ' vs 全库 ' + allMd + '）');
          if (P.wizard()) { P.wizardFoot('跳过教程'); await P.wait(700); }
          // 立刻还原 —— 后面每一步都靠正常库根跑
          await ctx.settings.save({ kbRoot: origRoot });
          await P.wait(1400);
          restored = ctx.settings.kbRoot() === origRoot;
          if (!restored) note('kbRoot 没还原回 ' + origRoot);
        }
      } finally {
        // 自清理：还原 kbRoot / 删掉探针建的目录 / wizardDone 回基线 / 关掉向导
        try {
          if (!restored) { await P.ctx().settings.save({ kbRoot: origRoot }); await P.wait(1200); }
          if (made) await app.vault.adapter.rmdir(madeName, true);
          await P.setWizardDone(origDone);
          if (P.wizard()) { P.wizardFoot('跳过教程'); await P.wait(600); }
        } catch (e) {
          note('自清理出错：' + String(e));
        }
      }
      return {
        ok: problems.length === 0,
        info: '三卡✓ · 默认名「经纬知识库」/真建=' + made + ' · 整个库落盘空串/篇数对账/还原=' + restored +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.14-向导新建与整个库.png',
  },
  {
    name: 'P7.14b · 反馈四件：空壳不算重复 / 编辑不标外改 / 属性可清空 / 根层新建带类型',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const made = [];
      try {
        // ── ① 两篇空壳笔记：不算重复、进「还没写内容」 ──
        const A = at('00_Inbox/__探针空壳甲.md');
        const B = at('00_Inbox/__探针空壳乙.md');
        const shell = '---\\n创建日期: 2026-10-08\\ntags: []\\n---\\n\\n';
        await app.vault.adapter.write(A, shell);
        await app.vault.adapter.write(B, shell);
        made.push(A, B);
        await P.wait(1800);
        const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (navHome) { P.click(navHome); await P.wait(1500); }
        const bodyText = P.text(document.body);
        if (bodyText.indexOf('还没写内容') < 0) note('「还没写内容」行没出现（空壳没被认领）');
        if (bodyText.indexOf('文件内容重复') >= 0) note('两篇空壳被算成"内容重复"了（老毛病复发）');

        // ── ② 编辑器打字（editor-change 先记账）→ 不算外部改动；无预告的写照旧标 ──
        /**
         * 🔴 **对照必须换一篇没被预告过的**（P7.15 补跑时抓到）：用户编辑器簿是
         * **按路径**记账（TTL 12s · hits 3）—— 在 A 上登记一次预告之后，A 接下来的
         * 两次写照旧被认领："没预告的写"这条对照会**假红**。离线套件里是
         * clearUserEdits() 显式清账（harness 那句注释写着同一件事），探针没有那个钩子
         * —— 换到 B（从没登记过的路径）即等价，且比加调试钩子干净。
         */
        app.workspace.trigger('editor-change', {}, { file: { path: A } });
        await app.vault.adapter.write(A, shell + '用户打的字\\n');
        await P.wait(1500);
        let flags = (ctx.index.get(A) || {}).flags || [];
        if (flags.indexOf('external-change') >= 0) note('编辑器打字之后被标了 external-change（老毛病复发）');
        await app.vault.adapter.write(B, shell + '别处又改了一下\\n');
        await P.wait(1500);
        flags = (ctx.index.get(B) || {}).flags || [];
        if (flags.indexOf('external-change') < 0) note('没有 editor-change 的写没标外改（口径放宽过头了）');

        // ── ③ 属性可清空：设了「类型」再删键 ──
        const f = app.vault.getAbstractFileByPath(A);
        await ctx.fm.setMany(f, { 类型: '笔记' });
        await P.wait(1200);
        let text = await app.vault.adapter.read(A);
        if (text.indexOf('类型:') < 0) note('前提：设「类型」没写进去');
        const r = await ctx.fm.setMany(f, { 类型: null });
        await P.wait(1200);
        text = await app.vault.adapter.read(A);
        if (text.indexOf('类型:') >= 0) note('「（清空）」那条的底层（null = 删键）在真机没生效');
        if (r.skipped.length > 0) note('清空被守卫拦了：' + r.skipped.join(','));

        // ── ③.5 非空目录的「重命名…/删除…」必须**可用**（此前置灰 —— 用户"无法删除或重命名"）──
        const navNotes = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
        if (navNotes) { P.click(navNotes); await P.wait(1200); }
        /**
         * ⚠️ **先回库根**（P7.15 补跑时抓到）：点「全部笔记」只切模块，**目录记忆照旧**
         * （上一轮 P7.14 步把视野留在了 99_Meta/01_仪表盘），所以不点根节点就会在
         * "根层"这个前提下扑空。根节点身份 = data-dir === ''（与 6948 行同一取法）。
         */
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return (i.dataset.dir === '') || (i.dataset.dir == null); });
        if (rootNode) { P.click(rootNode); await P.wait(900); }
        /**
         * 🔴 **两档都要认**（P7.15 补跑时抓到）：这里原先只找 .kbw-gcell.is-folder
         * （网格档的文件夹格），而实验库落盘的 notesView 是 **detail** —— 详细档画的是
         * .kbw-frow 文件夹行，选择器恒空 ⇒ 前提永远不满足、这半步从来没真验过。
         * 两种节点都带 data-dir（与目录树、拖放落点同一份身份），按它取根层那个。
         */
        const folderCell = P.qa('.kbw-gcell.is-folder, .kbw-frow').find(function (c) {
          const d = c.dataset.dir || '';
          return d === '00_Inbox' || P.text(c).indexOf('00_Inbox') >= 0;
        });
        if (!folderCell) note('前提没满足：根层找不到 00_Inbox 的文件夹（两档都没画？）');
        else {
          const rc = folderCell.getBoundingClientRect();
          folderCell.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true,
            clientX: Math.round(rc.left + rc.width / 2), clientY: Math.round(rc.top + rc.height / 2),
          }));
          await P.wait(450);
          const menuItems = P.qa('.kbw-menu .kbw-menu-item');
          const findItem = function (s) {
            return menuItems.find(function (i) { return P.text(i).indexOf(s) >= 0; });
          };
          const rn = findItem('重命名');
          const dl = findItem('删除');
          if (!rn) note('文件夹菜单里没有「重命名…」');
          else if (rn.getAttribute('aria-disabled') === 'true') note('「重命名…」被置灰了（00_Inbox 非空，P7.14 起应可用）');
          if (!dl) note('文件夹菜单里没有「删除…」');
          else if (dl.getAttribute('aria-disabled') === 'true') note('「删除…」被置灰了（P7.14 起应可用）');
          P.key('Escape'); // 关菜单，一项都不点
          await P.wait(300);
        }

        // ── ④ 库根顶层新建 → 带「类型: 笔记」（状态 / 文件位置不写）──
        const relC = at('__探针根层新建.md');
        const r2 = await ctx.completion.createNote({ title: '__探针根层新建', dirRel: '', noTemplate: true });
        await P.wait(1200);
        made.push(relC);
        const textC = await app.vault.adapter.read(relC);
        if (textC.indexOf('类型: 笔记') < 0) note('根层新建没写「类型: 笔记」：' + textC.split('\\n').slice(0, 6).join(' / '));
        if (textC.indexOf('状态:') >= 0) note('根层新建不该写状态');
        if (r2 && r2.outcome && String(r2.outcome).indexOf('fail') >= 0) note('根层新建落了失败档：' + String(r2.outcome));
      } finally {
        for (const p of made) {
          try { await app.vault.adapter.remove(p); } catch (e) { /* 尽力 */ }
        }
        await P.wait(1200);
        /**
         * 🔴 **只查插件自己的面**（P7.15 补跑时抓到）：全 body 扫 '__探针空壳' 会撞上
         * **原生 Bases 视图的残帧** —— 实验库里 .obsidian 之外还开着用户自己的
         * _收件箱.md（内嵌 base 表），它渲染的是删除前的缓存行，跟本插件的清理
         * 无关（实测：文件与索引里都已 0 条，树/列表/网格也都干净，只有那个 base 还挂着
         * 悬空链接）。删掉的三个名字只可能出现在插件画的行/格里，扫它们即可。
         * ⚠️ 那个原生 base 的残帧**不归本步管**：那是用户开的叶子 + 平台自己的重绘时机，
         * 探针只负责证明"本插件清干净了"（收尾全量跑时它随平台刷新自愈）。
         */
        const surfaces = ['.kbw-tree-item', '.kbw-frow', '.kbw-trow', '.kbw-gcell', '.kbw-cw-props'];
        const residueNow2 = function () {
          return surfaces.filter(function (sel) {
            return P.qa(sel).some(function (el) { return P.text(el).indexOf('__探针') >= 0; });
          });
        };
        const idxNow2 = function () {
          return ctx.index.getAll().filter(function (e) { return e.path.indexOf('__探针') >= 0; }).length;
        };
        /**
         * ⚠️ **轮询**（与 P7.15 步同款）：删完 → 索引/重画是异步两拍，写死一次读会把
         * 时序报成残留（P7.15 全量跑实测：树上已经干净、索引还挂着 1 条，再一拍就没了）。
         */
        for (let i = 0; i < 8 && (residueNow2().length > 0 || idxNow2() > 0); i++) {
          ctx.index.rebuild();
          await P.wait(500);
        }
        const still = residueNow2();
        if (still.length > 0) {
          const txt = P.qa('.kbw-tree-item')
            .map(function (el) { return P.text(el); })
            .filter(function (t) { return t.indexOf('__探针') >= 0; })
            .slice(0, 3).join(' / ');
          const who = surfaces.map(function (sel) {
            return P.qa(sel).filter(function (el) { return P.text(el).indexOf('__探针') >= 0; })
              .map(function (el) { return sel + ':' + (P.text(el).trim() || el.getAttribute('title') || el.getAttribute('aria-label') || '(空)'); })
              .slice(0, 2).join('，');
          }).filter(Boolean).join('｜');
          note('自清理后插件自己的面上还看得见探针残留：' + still.join('、') + '（' + who + '）');
        }
        const idxLeft = idxNow2();
        if (idxLeft > 0) {
          const paths = ctx.index.getAll().filter(function (e) { return e.path.indexOf('__探针') >= 0; })
            .map(function (e) { return e.path; }).slice(0, 3).join('，');
          note('索引里还剩 ' + idxLeft + ' 条探针条目（自清理没落干净；' + paths + '）');
        }
      }
      return {
        ok: problems.length === 0,
        info: '空壳/重复分流 ✓ 或 ⚠ · editor-change 记账 ✓ 或 ⚠ · null 删键 ✓ 或 ⚠ · 根层类型 ✓ 或 ⚠' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.15 · 反馈批 6：空目录进树 · 顶层写「.」· 目录选择器一键迁',
    shot: 'P7.15-空目录与目录选择器.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const made = [];
      const madeDirs = [];
      /**
       * ⚠️ 实验库的 kbRoot 可能是「整个库」（空串，P7.14 那轮就留过）—— 这一轮的
       * 判据在两种模式下都成立（都是"相对库根"的口径），不额外拨设置。
       */
      try {
        // ── ① 空目录进树（#2）：建一个空目录 → 树里立刻可见、计数 0 ──
        const emptyRel = '__探针空夹';
        const emptyAbs = at(emptyRel);
        if (!(await app.vault.adapter.exists(emptyAbs))) {
          await app.vault.createFolder(emptyAbs);
        }
        /** 一律记上（哪怕这轮没新建）—— 上一轮失败留下的残留也要被清掉 */
        madeDirs.push(emptyAbs);
        ctx.index.rebuild();
        await P.wait(1200);
        const navNotes = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
        if (navNotes) { P.click(navNotes); await P.wait(1200); }
        const rootNode = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === '' || i.dataset.dir == null; });
        if (rootNode) { P.click(rootNode); await P.wait(800); }
        const emptyNode = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === emptyRel; });
        if (!emptyNode) note('🔴 空目录没进树（' + emptyRel + '；#2 的主判据）');
        else {
          const cnt = emptyNode.querySelector('.kbw-tree-count');
          if (!cnt || P.text(cnt) !== '0') note('空目录的计数该是 0，实际「' + (cnt ? P.text(cnt) : '(没有)') + '」');
        }

        // ── ② 顶层写「.」（#1）：库根顶层新建 → 属性区/前言里有 FilePosition = . ──
        const topTitle = '__探针顶层点';
        const topRel = topTitle + '.md';
        const topAbs = at(topRel);
        await ctx.completion.createNote({ title: topTitle, dirRel: '', noTemplate: true });
        await P.wait(1200);
        made.push(topAbs);
        const topText = await app.vault.adapter.read(topAbs);
        if (topText.indexOf('  - .') < 0) {
          note('🔴 顶层新建的「文件位置」没写「.」（#1 反转；前言：' + topText.split('\\n').slice(0, 8).join(' / ') + '）');
        }
        // 读侧归一：索引里不该报「位置不一致」（写「.」不归一的话这里必红）
        await P.wait(900);
        const topEntry = ctx.index.get(topAbs);
        if (!topEntry) note('顶层的这一篇没进索引');
        else if ((topEntry.flags || []).indexOf('position-mismatch') >= 0) {
          note('🔴 顶层声明「.」被当成错位了（读侧没归一 —— 体检会全库假红）');
        }

        // ── ③ 目录选择器一键迁（#3）：右键 → 属性 › 定位 › 文件位置 → 选空目录 → 确认流 → 真搬 ──
        /**
         * 先造一篇**有声明**的笔记放在 00_Inbox 之外可搬的位置 —— 选实验库里现成的一篇
         * 更好（"别只信合成夹具"），但现成的那篇搬出去会改用户的库；所以自备。
         * ⚠️ 自备的这篇**必须带「文件位置」声明**：mover 的属性跟随只对已声明的生效。
         */
        const mvTitle = '__探针搬迁点';
        await ctx.completion.createNote({ title: mvTitle, dirRel: '00_Inbox', noTemplate: true });
        await P.wait(1400);
        const mvAbs = at('00_Inbox/' + mvTitle + '.md');
        made.push(mvAbs);
        ctx.index.rebuild();
        await P.wait(1200);

        // 回库根 → 树里点 00_Inbox 进那一层 → 找到这一行
        if (rootNode) { P.click(rootNode); await P.wait(600); }
        const inboxNode = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === '00_Inbox'; });
        if (inboxNode) { P.click(inboxNode); await P.wait(1200); }
        const mvRow = P.qa('.kbw-trow').find(function (r) { return (r.dataset.path || '') === mvAbs; });
        if (!mvRow) note('前提没满足：00_Inbox 里找不到刚造的那一行');
        else {
          const rc = mvRow.getBoundingClientRect();
          mvRow.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true,
            clientX: Math.round(rc.left + 40), clientY: Math.round(rc.top + 8),
          }));
          await P.wait(500);
          const pickMenu = function (label) {
            const it = P.qa('.kbw-menu .kbw-menu-item').find(function (i) { return P.text(i).trim().indexOf(label) === 0; });
            if (it) { P.click(it); return true; }
            return false;
          };
          if (!pickMenu('改')) note('行菜单里没有「改」');
          await P.wait(350);
          if (!pickMenu('属性')) note('「改」里没有「属性」');
          await P.wait(350);
          if (!pickMenu('定位')) note('「属性」里没有「定位」');
          await P.wait(350);
          if (!pickMenu('文件位置')) note('「定位」里没有「文件位置」');
          await P.wait(450);
          const curItem = P.qa('.kbw-menu .kbw-menu-item').find(function (i) { return P.text(i).indexOf(emptyRel) >= 0; });
          if (!curItem) note('目录选择器里没有刚建的空目录（候选 = 现算的真实目录）');
          else if (curItem.getAttribute('aria-disabled') === 'true') note('空目录那一项被置灰了（该可选）');
          else {
            P.click(curItem);
            await P.wait(600);
            // 确认流（模态）：主按钮 = 「搬到『…』」
            const go = P.qa('.kbw-modal button').find(function (b) { return P.text(b).indexOf('搬到') >= 0; });
            if (!go) note('🔴 选完目录没弹确认流（动库前确认只能过 ui/confirm）');
            else {
              P.click(go);
              await P.wait(2000);
              const movedOk = await app.vault.adapter.exists(at(emptyRel + '/' + mvTitle + '.md'));
              const oldGone = !(await app.vault.adapter.exists(mvAbs));
              if (!movedOk || !oldGone) note('🔴 一键迁没真搬（新位置=' + movedOk + ' 旧位置还在=' + !oldGone + '）');
              // 声明跟到一起（读前言）
              if (movedOk) {
                const t2 = await app.vault.adapter.read(at(emptyRel + '/' + mvTitle + '.md'));
                if (t2.indexOf(emptyRel) < 0) note('🔴 搬了但「文件位置」没跟（两条后果不一致 → 会报错位）');
              }
              // 撤销还原（撤销条在 → 点它）
              const undo = P.qa('.kbw-undobar .kbw-btn').find(function (b) { return P.text(b).indexOf('撤销') >= 0; });
              if (undo) { P.click(undo); await P.wait(1600); }
              const backOk = await app.vault.adapter.exists(mvAbs);
              if (undo && !backOk) note('撤销之后没回到原位（快照那条链）');
            }
          }
        }
      } finally {
        /**
         * 自清理：**删自己造的**（文件 + 空目录）。顺序照 P7.14c 的两段式精神 ——
         * 先删文件再删壳；删之前复查目录里没有别人塞进来的东西（探针期间用户可能动库）。
         */
        for (const p of made) {
          try { await app.vault.adapter.remove(p); } catch (e) { /* 尽力 */ }
        }
        /**
         * 🔴 **删目录的两个真机坑（本轮连着踩）**：
         *   ① adapter.rmdir(d, false) 抛 ERR_FS_EISDIR —— 平台实现是 fs.rm，
         *      删目录必须 recursive（坑/平台.md 的 P5 那条实测）；
         *   ② **本机 Obsidian 1.14 的 vault 上根本没有 deleteFolder**（实测
         *      typeof app.vault.deleteFolder === 'undefined'）—— 走它 = 静默 TypeError，
         *      被 catch 吞掉 → 目录一直在树里 → "残留"判据假红。
         * 正解 = **vault.delete(TAbstractFile, force)**（拿 getFolderByPath 取节点）。
         * ⚠️ 清之前**复查目录里没有别人塞进来的东西**（探针期间用户可能动库）——
         * 有就不删（留着比误删好）。
         */
        for (const d of madeDirs) {
          try {
            const listing = await app.vault.adapter.list(d);
            const files = (listing.files || []).filter(function (f) { return f.indexOf('__探针') >= 0; });
            for (const f of files) { try { await app.vault.adapter.remove(f); } catch (e) { /* 尽力 */ } }
            const after2 = await app.vault.adapter.list(d);
            const leftFiles = (after2.files || []).length;
            const leftDirs = (after2.folders || []).length;
            if (leftFiles === 0 && leftDirs === 0) {
              const node = app.vault.getAbstractFileByPath(d);
              if (node) await app.vault.delete(node, true);
            }
          } catch (e) { /* 尽力 */ }
        }
        /**
         * ⚠️ 删完要**走产品那条重扫路**（ctx.index.rebuild() + 等一拍）再断言：
         * 裸删盘面时平台的目录监听还没到，树自然还挂着旧节点 —— 那是**时序**不是残留
         * （P7.15 补跑时实测：adapter.remove 之后 1.2s 树里还有）。
         */
        const surfaces = ['.kbw-tree-item', '.kbw-frow', '.kbw-trow', '.kbw-gcell'];
        const residueNow = function () {
          return surfaces.filter(function (sel) {
            return P.qa(sel).some(function (el) { return P.text(el).indexOf('__探针') >= 0; });
          });
        };
        const idxNow = function () {
          return ctx.index.getAll().filter(function (e) { return e.path.indexOf('__探针') >= 0; }).length;
        };
        /**
         * 轮询等重画落地（最多 ~4s）：删完是"索引 → 模块重画"两拍，写死等待会看运气
         * （P7.15 两轮补跑都栽在同一个时序上）。真残留会一直在 → 照样红。
         * ⚠️ **索引余量也要进轮询条件**（P7.15 第三次补跑实测：树上干净了、索引还挂着 1 条
         * —— 那是删除之后的**异步滞后**，再等一拍就没了；写死一次读会把时序当残留报）。
         */
        for (let i = 0; i < 8 && (residueNow().length > 0 || idxNow() > 0); i++) {
          ctx.index.rebuild();
          await P.wait(500);
        }
        const still = residueNow();
        if (still.length > 0) {
          const txt = P.qa('.kbw-tree-item')
            .map(function (el) { return P.text(el); })
            .filter(function (t) { return t.indexOf('__探针') >= 0; })
            .slice(0, 3).join(' / ');
          const who = surfaces.map(function (sel) {
            return P.qa(sel).filter(function (el) { return P.text(el).indexOf('__探针') >= 0; })
              .map(function (el) { return sel + ':' + (P.text(el).trim() || el.getAttribute('title') || el.getAttribute('aria-label') || '(空)'); })
              .slice(0, 2).join('，');
          }).filter(Boolean).join('｜');
          note('自清理后插件自己的面上还看得见探针残留：' + still.join('、') + '（' + who + '）');
        }
        const idxLeft = idxNow();
        if (idxLeft > 0) {
          const paths = ctx.index.getAll().filter(function (e) { return e.path.indexOf('__探针') >= 0; })
            .map(function (e) { return e.path; }).slice(0, 3).join('，');
          note('索引里还剩 ' + idxLeft + ' 条探针条目（' + paths + '）');
        }
      }
      return {
        ok: problems.length === 0,
        info: '空目录进树 ✓ 或 ⚠ · 顶层「.」 ✓ 或 ⚠ · 目录选择器一键迁 ✓ 或 ⚠' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    /**
     * P7.16 · YAML 专项一 真机半步（用户四条诉求里的第 4 条 + D5）：
     *   ① 小窗「文件位置」候选随**新建目录**刷新（不重开面板）—— #1 的主判据；
     *   ② 未声明笔记的「就住这儿（写声明，不搬）」（右键菜单面）——确认流 → 写声明、
     *      文件一个字节不动；已声明那档照旧置灰（对照）；
     *   ③ 坏前言：旗标亮 + 首页待处理行 → ① 修前言（确定性修）→ 正文一字不动 →
     *      旗标灭 → 撤销还原（快照）。
     * 夹具全部自备（`__探针*` 前缀）+ finally 复扫删净（P7.13a 的纪律）。
     * 小窗属性档替 `few` 跑完写回原样（照 f · 面板显示那一步的先例）。
     */
    name: 'P7.16 · 小窗候选刷新（建目录）· 就住这儿 · 坏前言旗标/修/撤销',
    shot: 'P7.16-坏前言与就住这儿.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const made = [];
      const madeDirs = [];
      const boardBackup = JSON.parse(JSON.stringify(await ctx.configs.read('board')));
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      try {
        // ── 0. 小窗属性档拨成「前 6 行」（C2 起默认只看正文；跑完照原样写回）──
        //   ⚠️ 版本号写 2：v1 文件里的 few 会被一次性迁移当成旧默认吃掉（migrateLegacyView）
        await ctx.configs.write('board', { ...boardBackup, version: 2, view: { ...(boardBackup.view || {}), panelProps: 'few' } });
        await P.wait(900);

        // ── ① 小窗候选刷新：#1 的直接病灶 ──
        const panelTitle = '__探针面板点';
        await ctx.completion.createNote({ title: panelTitle, dirRel: '00_Inbox', noTemplate: true });
        await P.wait(1500);
        const panelAbs = at('00_Inbox/' + panelTitle + '.md');
        made.push(panelAbs);
        const opened = ctx.openNoteWindow ? ctx.openNoteWindow(panelAbs) : false;
        if (!opened) note('开小窗没成功（ctx.openNoteWindow 返回 false —— 看板模块关着？）');
        else {
          await P.wait(1500);
          const panel = P.q('.kbw-cw-panel');
          if (!panel) note('小窗没出现');
          else {
            const selOf = function () {
              const rows = Array.from(panel.querySelectorAll('.kbw-cw-row'));
              const row = rows.find(function (r) {
                const k = r.querySelector('.kbw-cw-k');
                return k && P.text(k) === '文件位置';
              });
              return row ? row.querySelector('select') : null;
            };
            const sel = selOf();
            if (!sel) note('小窗里没有「文件位置」选择器（属性档没生效？）');
            else if (sel.value !== '00_Inbox') note('当前项该是声明值 00_Inbox，实际「' + sel.value + '」');
            else {
              const newDirRel = '__探针修夹';
              await app.vault.createFolder(at(newDirRel));
              madeDirs.push(at(newDirRel));
              await P.wait(1200);
              const sel2 = selOf();
              const opts = sel2 ? Array.from(sel2.options).map(function (o) { return o.value; }) : [];
              if (opts.indexOf(newDirRel) < 0) note('🔴 建完目录后小窗下拉里没有它（候选不刷新 —— #1 的病）');
              if (sel2 && sel2.value !== '00_Inbox') note('重画之后当前项该还在声明值上，实际「' + sel2.value + '」');
            }
          }
        }
        if (P.closeAll) P.closeAll(4);
        await P.wait(500);

        // ── ② 就住这儿（菜单面）：未声明 → 可点；写声明、不搬文件 ──
        const stayTitle = '__探针就住儿';
        await ctx.completion.createNote({ title: stayTitle, dirRel: '00_Inbox', noTemplate: true });
        await P.wait(1400);
        const stayAbs = at('00_Inbox/' + stayTitle + '.md');
        made.push(stayAbs);
        const stayFile = app.vault.getAbstractFileByPath(stayAbs);
        if (!stayFile) note('就住这儿夹具没建出来');
        else {
          await ctx.fm.setMany(stayFile, { 文件位置: null }); // 削掉声明 → 真·未声明
          await P.wait(1300);
          const navNotes = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
          if (navNotes) { P.click(navNotes); await P.wait(1100); }
          const inboxNode = P.qa('.kbw-tree-item').find(function (i) { return i.dataset.dir === '00_Inbox'; });
          if (inboxNode) { P.click(inboxNode); await P.wait(1100); }
          const row = P.qa('.kbw-trow').find(function (r) { return (r.dataset.path || '') === stayAbs; });
          if (!row) note('前提：就住这儿那行不在（' + stayAbs + '）');
          else {
            const rc = row.getBoundingClientRect();
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(rc.left + 40), clientY: Math.round(rc.top + 8) }));
            await P.wait(500);
            const pick = function (label) {
              const it = P.qa('.kbw-menu .kbw-menu-item').find(function (i) { return P.text(i).trim().indexOf(label) === 0; });
              if (it) { P.click(it); return true; }
              return false;
            };
            if (!pick('改')) note('行菜单里没有「改」');
            await P.wait(350);
            if (!pick('属性')) note('「改」里没有「属性」');
            await P.wait(350);
            if (!pick('定位')) note('「属性」里没有「定位」');
            await P.wait(350);
            if (!pick('文件位置')) note('「定位」里没有「文件位置」');
            await P.wait(450);
            const stay = P.qa('.kbw-menu .kbw-menu-item').find(function (i) { return P.text(i).indexOf('就住这儿') >= 0; });
            if (!stay) note('🔴 未声明的笔记在菜单里没有「就住这儿（写声明，不搬）」');
            else if (stay.getAttribute('aria-disabled') === 'true') note('「就住这儿」被置灰了（该可点）');
            else {
              P.click(stay);
              await P.wait(700);
              const go = P.qa('.kbw-modal button').find(function (b) { return P.text(b).indexOf('只写声明') >= 0; });
              if (!go) note('选「就住这儿」没弹确认流');
              else {
                P.click(go);
                await P.wait(1200);
                const still = await app.vault.adapter.exists(stayAbs);
                if (!still) note('🔴 文件被搬走了（只写声明、不该动文件）');
                const txt = still ? await app.vault.adapter.read(stayAbs) : '';
                if (txt.indexOf('文件位置') < 0) note('声明没写进前言（文件：' + txt.split('\\n').slice(0, 6).join(' / ') + '）');
                const okIdx = await P.until(function () {
                  const e1 = ctx.index.get(stayAbs);
                  if (!e1 || e1.props['文件位置'] == null) return false;
                  if ((e1.flags || []).indexOf('position-mismatch') >= 0) note('声明写上却报错位（两条后果不一致）');
                  return true;
                }, 4000);
                if (!okIdx) note('声明没进索引（重解析/索引没跟上？）');
              }
            }
          }
        }

        // ── ③ 坏前言：旗标 → 首页行 ① → 确定性修 → 正文不动 → 旗标灭 → 撤销 ──
        const badAbs = at('__探针坏前言.md');
        const badText = ['---', '类型: 笔记', '创建日期: {{date}}', 'tags: []', '---', '', '# 探针坏前言', '正文一字不动。', ''].join(String.fromCharCode(10));
        await app.vault.create(badAbs, badText);
        made.push(badAbs);
        ctx.index.rebuild();
        await P.wait(1600);
        const eBad = ctx.index.get(badAbs);
        if (!eBad) note('坏前言夹具没进索引');
        else if ((eBad.flags || []).indexOf('fragile-fm') < 0) note('🔴 坏前言旗标没亮');
        const homeNav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (homeNav) { P.click(homeNav); await P.wait(1300); }
        const shown = await P.revealTodoRows(['前言里有嵌套值']);
        const todoRow = P.todoRow('前言里有嵌套值');
        if (!shown || !todoRow) {
          note('「坏前言」行挤不进可见区（当前行：' + P.qa('.kbw-todo').map(function (r) { return P.text(r).slice(0, 14); }).join(' / ') + '）');
        } else {
          const clicked = await P.clickTodoAi(todoRow, '①');
          if (clicked !== true) note('行菜单 ① 没点到（' + clicked + '）');
          else {
            await P.wait(1600);
            const panel = P.qa('.kbw-modal').find(function (m) { return P.text(m).indexOf('修前言') >= 0; });
            if (!panel) note('① 没打开修前言面板');
            else {
              const card = Array.from(panel.querySelectorAll('.kbw-title-row')).find(function (r) { return P.text(r).indexOf('探针坏前言') >= 0; });
              if (!card) note('面板里没有坏前言那张卡');
              const runBtn = Array.from(panel.querySelectorAll('.kbw-title-bar .kbw-btn')).find(function (b) { return P.text(b).indexOf('修能修的') >= 0; });
              if (!runBtn) note('面板底栏没有「修能修的」按钮');
              else {
                P.click(runBtn);
                await P.wait(700);
                const cfm = P.qa('.kbw-modal').find(function (m) { return P.text(m).indexOf('只加引号') >= 0; });
                if (!cfm) note('没弹确认流');
                else {
                  const go = Array.from(cfm.querySelectorAll('button')).find(function (b) { return P.text(b).indexOf('修这') >= 0; });
                  if (go) P.click(go);
                  await P.wait(2200);
                  const after = await app.vault.adapter.read(badAbs);
                  if (after.indexOf('"{{date}}"') < 0) note('🔴 确定性修没写进去（' + after.split('\\n').slice(0, 6).join(' / ') + '）');
                  if (after.indexOf('正文一字不动。') < 0) note('🔴 正文被动过（成对判据）');
                  const okFlag = await P.until(function () {
                    const e2 = ctx.index.get(badAbs);
                    return !!e2 && ((e2.flags || []).indexOf('fragile-fm') < 0);
                  }, 4000);
                  if (!okFlag) note('修完旗标还亮（索引没跟上？）');
                  const undo = P.qa('.kbw-undobar .kbw-btn').find(function (b) { return P.text(b).indexOf('撤销') >= 0; });
                  if (!undo) note('撤销条不在');
                  else {
                    P.click(undo);
                    await P.wait(1800);
                    const back = await app.vault.adapter.read(badAbs);
                    if (back.indexOf('创建日期: {{date}}') < 0) note('撤销之后没回到原样');
                  }
                }
              }
              P.key('Escape');
              await P.wait(400);
            }
          }
        }
      } finally {
        try { if (P.closeAll) P.closeAll(4); } catch (e) { /* 尽力 */ }
        for (const p of made) {
          try {
            const f = app.vault.getAbstractFileByPath(p);
            if (f) await app.vault.delete(f, true);
            else await app.vault.adapter.remove(p);
          } catch (e) { /* 尽力 */ }
        }
        for (const d of madeDirs) {
          try {
            const listing = await app.vault.adapter.list(d);
            const files = (listing.files || []).filter(function (f) { return f.indexOf('__探针') >= 0; });
            for (const f of files) { try { await app.vault.adapter.remove(f); } catch (e) { /* 尽力 */ } }
            const after2 = await app.vault.adapter.list(d);
            if ((after2.files || []).length === 0 && (after2.folders || []).length === 0) {
              const node = app.vault.getAbstractFileByPath(d);
              if (node) await app.vault.delete(node, true);
            }
          } catch (e) { /* 尽力 */ }
        }
        try { await ctx.configs.write('board', boardBackup); } catch (e) { /* 尽力 */ }
        try { await ctx.settings.save({ homeDismissed: dismissedPrev }); } catch (e) { /* 尽力 */ }
        await P.wait(600);
        const idxNow = function () { return ctx.index.getAll().filter(function (e) { return e.path.indexOf('__探针') >= 0; }).length; };
        for (let i = 0; i < 8 && idxNow() > 0; i += 1) {
          ctx.index.rebuild();
          await P.wait(500);
        }
        if (idxNow() > 0) note('自清理后索引里还剩 ' + idxNow() + ' 条探针条目');
      }
      return {
        ok: problems.length === 0,
        info: '小窗候选刷新（建目录）✓ 或 ⚠ · 就住这儿 ✓ 或 ⚠ · 坏前言旗标/修/撤销 ✓ 或 ⚠' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    /**
     * P7.16b · **原生属性面板「文件位置」那一格**（本轮唯一的新面）：
     *   ① 点那一格 → **我们的**目录菜单出现（作用域行 + 现算候选 + 自备目录在列 + 「库根」）；
     *   ② 菜单开着时**平台自己的**属性建议（.suggestion-container.mod-property-value）
     *      该被藏住（body 类 + 作用域 CSS 的哨兵；两个菜单不许同屏打架）；
     *   ③ 选目录 → 确认流 → 文件到位 + 「文件位置」写成实际落点（未声明的也写 —— 本轮新口径）；
     *   ④ 撤销还原（快照）。
     *
     * 🔴 这一步同时是**平台 DOM 契约的哨兵**：钩子靠 .metadata-property 的
     *    data-property-key 与 .multi-select-input 认那一格 —— 平台升级改了结构，
     *    这里会报「那一格没找到」或「菜单没弹」，先于用户发现"钩子失联"。
     * 夹具自备（__探针前缀）+ finally 复扫删净；开的标签页当场 detach 收走（别留给后面步骤）。
     */
    name: 'P7.16b · 原生属性面板那一格：我们的目录菜单 · 选目录搬+声明 · 撤销还原',
    shot: 'P7.16b-原生面板选目录.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const NL = String.fromCharCode(10);
      const madeDirs = [];
      const title = '__探针原生面板';
      const dirRel = '00_Inbox/__探针原生夹';
      const origRel = at('00_Inbox/' + title + '.md');
      const destRel = at(dirRel + '/' + title + '.md');
      let leaf = null;
      try {
        // ── 0. 夹具：带「文件位置: []」的笔记（键在 → 原生面板画得出那一格；空数组 = 未声明）──
        const old = app.vault.getAbstractFileByPath(origRel);
        if (old) await app.vault.delete(old, true);
        const file = await app.vault.create(origRel, ['---', '类型: 笔记', '文件位置: []', 'tags: []', '---', '', '# 探针原生面板', '正文一字不动。', ''].join(NL));
        if (!(await app.vault.adapter.exists(at(dirRel)))) await app.vault.createFolder(at(dirRel));
        madeDirs.push(at(dirRel));
        const inIdx = await P.until(function () { return !!ctx.index.get(origRel); }, 4000);
        if (!inIdx) note('夹具没进索引（后面会连带失败，先看这一条）');

        // 打开成**平台自己的**标签页（原生属性面板只住在平台的笔记视图里）
        leaf = app.workspace.getLeaf('tab');
        await leaf.openFile(file);
        await P.wait(1500);

        // ── ① 找那一格 → 点它 → 我们的菜单 ──
        const cell = P.q('.metadata-property[data-property-key="文件位置"]');
        if (!cell) {
          note('原生面板里找不到「文件位置」那一格（属性展示关着？平台 DOM 变了？—— 钩子失联的哨兵）');
        } else {
          const input = cell.querySelector('.multi-select-input') || cell.querySelector('input, [contenteditable]') || cell.querySelector('.multi-select-container');
          if (!input) note('那一格里找不到 .multi-select-input（平台结构变了）');
          else {
            P.click(input);
            await P.wait(900);
            const menu = P.lastMenu();
            if (!menu) {
              note('点了那一格，我们的目录菜单没有出现（钩子没接上？看 body 上有没有 kbw-native-menu-open）');
            } else {
              if (P.text(menu).indexOf('作用范围') < 0) note('菜单缺作用域行（硬规矩 1）');
              if (P.text(menu).indexOf(title) < 0) note('作用域行没写清改的是哪一篇');
              if (P.text(menu).indexOf('__探针原生夹') < 0) note('候选里没有探针自备目录（现算口径没生效？）');
              if (P.text(menu).indexOf('库根') < 0) note('候选里没有「库根」那一项');
              /** ② 遮蔽哨兵：菜单开着时 body 上该有我们的类；平台建议**真弹了**才量它的 computed display */
              if (!document.body.classList.contains('kbw-native-menu-open')) note('菜单开着，body 上却没有遮蔽类（kbw-native-menu-open）');
              const sug = P.q('.suggestion-container.mod-property-value');
              if (sug && getComputedStyle(sug).display !== 'none') note('平台的属性建议没被藏住 —— 两个菜单会同屏打架');
              // ── ③ 选目录 → 确认 → 搬 + 写声明 ──
              const item = P.qa('.kbw-menu .kbw-menu-item').find(function (i) { return P.text(i).indexOf('__探针原生夹') >= 0; });
              if (!item) {
                note('菜单里点不到自备目录那一项');
              } else {
                P.click(item);
                await P.wait(800);
                /**
                 * 现场取证（P7.16b 首跑抓到）：菜单关掉之后，body 上的遮蔽类**没摘**。
                 * 在每个路标上记一笔（类在不在 / 眼下有没有我们的菜单），
                 * 用来分辨"没摘"还是"摘了又被谁开回来"。
                 */
                const seenClass = document.body.classList.contains('kbw-native-menu-open');
                const seenMenus = P.qa('.kbw-menu').length;
                if (seenClass) note('选完项后：遮蔽类还在（菜单数=' + seenMenus + '）');
                const cfm = P.lastModal();
                if (!cfm || P.text(cfm).indexOf('搬到') < 0) note('选目录之后没有弹确认流（动库前确认只能过 confirm）');
                else {
                  const go = Array.from(cfm.querySelectorAll('button')).find(function (b) { return P.text(b).indexOf('搬到') >= 0; });
                  if (!go) note('确认单里点不到主按钮（搬到「…」）');
                  else {
                    P.click(go);
                    const okMove = await P.until(function () {
                      const landed = app.vault.getAbstractFileByPath(destRel);
                      if (!landed) return false;
                      const e2 = ctx.index.get(destRel);
                      return !!e2 && e2.props['文件位置'] != null;
                    }, 6000);
                    if (!okMove) note('确认之后：文件没到位、或「文件位置」没写成实际落点（未声明也写没生效？）');
                    if (app.vault.getAbstractFileByPath(origRel)) note('原位置还留着一份（没搬干净）');
                    if (document.body.classList.contains('kbw-native-menu-open')) {
                      note('搬完之后：遮蔽类还在（眼下菜单数=' + P.qa('.kbw-menu').length + ' —— 0 = 没摘；>0 = 被开回来了）');
                    }
                    // ── ④ 撤销还原 ──
                    const undo = P.qa('.kbw-undobar .kbw-btn').find(function (b) { return P.text(b).indexOf('撤销') >= 0; });
                    if (!undo) note('搬完没出撤销条');
                    else {
                      P.click(undo);
                      const okBack = await P.until(function () {
                        return !!app.vault.getAbstractFileByPath(origRel) && !app.vault.getAbstractFileByPath(destRel);
                      }, 6000);
                      if (!okBack) note('撤销之后没回到原位（快照还原？）');
                    }
                  }
                }
              }
            }
          }
        }
      } finally {
        try { if (P.closeAll) P.closeAll(4); } catch (e) { /* 尽力 */ }
        try { if (leaf) leaf.detach(); } catch (e) { /* 尽力 */ }
        // 夹具可能停在两个位置里的任一个
        for (const p of [origRel, destRel]) {
          try {
            const f2 = app.vault.getAbstractFileByPath(p);
            if (f2) await app.vault.delete(f2, true);
          } catch (e) { /* 尽力 */ }
        }
        for (const d of madeDirs) {
          try {
            const listing = await app.vault.adapter.list(d);
            const files = (listing.files || []).filter(function (f) { return f.indexOf('__探针') >= 0; });
            for (const f of files) { try { await app.vault.adapter.remove(f); } catch (e) { /* 尽力 */ } }
            const after = await app.vault.adapter.list(d);
            if ((after.files || []).length === 0 && (after.folders || []).length === 0) {
              const node = app.vault.getAbstractFileByPath(d);
              if (node) await app.vault.delete(node, true);
            }
          } catch (e) { /* 尽力 */ }
        }
        await P.wait(600);
        const idxNow = function () { return ctx.index.getAll().filter(function (e) { return e.path.indexOf('__探针') >= 0; }).length; };
        for (let i = 0; i < 8 && idxNow() > 0; i += 1) {
          ctx.index.rebuild();
          await P.wait(500);
        }
        if (idxNow() > 0) note('自清理后索引里还剩 ' + idxNow() + ' 条探针条目');
      }
      return {
        ok: problems.length === 0,
        info: '原生面板那一格 → 我们的目录菜单 · 选目录搬+声明 · 撤销还原' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    /**
     * P7.18b · **位置口径（真机整链）**：用户 2026-10-09 反馈整改的两条。
     *   ① 拖拽链搬**未声明**篇 → 「文件位置」= 新落点（旧行为：留空 —— 已反转）；
     *   ② 原生面板那格菜单里的「**现处 X（写回当前位置）**」→ 把错位的声明纠回现处（文件不动）。
     *
     * ⚠️ 自备两个目录 + 两篇夹具（不动实验库本体任何既有笔记的位置属性），收尾删净。
     */
    name: 'P7.18b · 位置口径：拖拽补声明 · 「现处 X」写回（未声明/错位）',
    shot: 'P7.18b-位置口径.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const NL = String.fromCharCode(10);
      const dirA = '__探针P718b从';
      const dirB = '__探针P718b到';
      const A = at(dirA + '/__探针P718b拖.md');
      const B = at(dirB + '/__探针P718b错位.md');
      const A_MOVED = at(dirB + '/__探针P718b拖.md');
      const RAW_A = ['---', '类型: 笔记', 'tags: []', '---', '', '__探针P718b拖拽正文', ''].join(NL);
      const RAW_B = ['---', '类型: 笔记', '文件位置:', '  - ' + dirA, 'tags: []', '---', '', '__探针P718b错位正文', ''].join(NL);
      const waitUntil = async (fn, ms) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await P.wait(200); } };
      const declaredOf = (p) => { const e = ctx.index.get(p); if (!e) return null; const v = e.props['文件位置']; if (v == null) return []; if (Array.isArray(v)) return v.filter((x) => x != null && x !== '').map(String); return [String(v)]; };
      /** ⚠️ 附件小节的三个名字**声明在 try 外**（finally 的收尾清单要引用 —— 声明在 try 块内会 ReferenceError，首跑抓到的） */
      const BIN = at(dirA + '/__探针P718b附件.bin');
      const BIN_MOVED = at(dirB + '/__探针P718b附件.bin');
      const BIN_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80];
      let leaf = null;
      try {
        P.closeAll(4);
        await P.wait(400);
        // ── 0. 夹具：A 未声明（搬去 dirB）；B 声明 dirA、实际住 dirB（错位）──
        if (!(await app.vault.adapter.exists(at(dirA)))) await app.vault.createFolder(at(dirA));
        if (!(await app.vault.adapter.exists(at(dirB)))) await app.vault.createFolder(at(dirB));
        for (const pair of [[A, RAW_A], [B, RAW_B]]) {
          const old = app.vault.getAbstractFileByPath(pair[0]);
          if (old) await app.vault.delete(old, true);
          await app.vault.create(pair[0], pair[1]);
        }
        if (!(await waitUntil(() => !!ctx.index.get(A) && !!ctx.index.get(B), 8000))) note('夹具没进索引（后面会连带失败，先看这条）');

        // ── ① 拖拽链（source='drag'，走 mover 第 7 步）：A 未声明 → 声明 = 新落点 ──
        const fileA = app.vault.getAbstractFileByPath(A);
        if (!fileA) note('A 不在（先看上面夹具那条）');
        else {
          const resA = await ctx.mover.move({ targets: [{ dir: at(dirB), files: [fileA] }], source: 'drag', reason: 'P7.18b 探针：拖拽补声明' });
          if (!resA || resA.moved.length !== 1) note('A 没搬成');
          else {
            const got = await waitUntil(() => { const d = declaredOf(A_MOVED); return !!d && d.length > 0; }, 8000);
            if (!got) note('★ 未声明的拖拽搬完没写声明（旧行为"留空的保持留空"回来了？）');
            else {
              const d = declaredOf(A_MOVED);
              if (d[0] !== dirB) note('声明写歪了：' + JSON.stringify(d) + '（该是 ' + dirB + '）');
            }
          }
        }

        // ── ①b 附件（非 .md）搬动：字节不动（第 7 步必须拦住 —— 独立审 🔴1 的真机哨兵）──
        try {
          const oldBin = app.vault.getAbstractFileByPath(BIN);
          if (oldBin) await app.vault.delete(oldBin, true);
          await app.vault.createBinary(BIN, new Uint8Array(BIN_BYTES).buffer);
          const binNode = await waitUntil(() => !!app.vault.getAbstractFileByPath(BIN), 4000);
          if (!binNode) note('附件夹具没建出来');
          else {
            const resBin = await ctx.mover.move({ targets: [{ dir: at(dirB), files: [app.vault.getAbstractFileByPath(BIN)] }], source: 'batch', reason: 'P7.18b 探针：附件搬家', quiet: true });
            if (!resBin || resBin.moved.length !== 1) note('附件没搬成');
            else {
              const back = new Uint8Array(await app.vault.adapter.readBinary(BIN_MOVED));
              let same = back.length === BIN_BYTES.length;
              if (same) for (let i = 0; i < BIN_BYTES.length; i += 1) { if (back[i] !== BIN_BYTES[i]) { same = false; break; } }
              if (!same) note('★ 附件字节被动了（第 7 步没拦住非 .md？—— processFrontMatter 会把二进制写坏）');
            }
          }
        } catch (e) {
          note('附件小节出错：' + String(e));
        }

        // ── ② 原生面板那格菜单 → 「现处 X」→ 确认 → 声明纠回、文件不动 ──
        const fileB = app.vault.getAbstractFileByPath(B);
        if (!fileB) note('B 不在（先看上面夹具那条）');
        else {
          leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(fileB);
          await P.wait(1600);
          const cell = P.q('.metadata-property[data-property-key="文件位置"]');
          if (!cell) note('那一格找不到（属性展示关着？）');
          else {
            const input = cell.querySelector('.multi-select-input') || cell.querySelector('input, [contenteditable], .multi-select-container');
            if (!input) note('那一格没有 .multi-select-input');
            else {
              P.click(input);
              await P.wait(900);
              const menu = P.lastMenu();
              if (!menu) note('菜单没弹');
              else {
                if (P.text(menu).indexOf('现处 ' + dirB) < 0) note('菜单里没有「现处 ' + dirB + '」（P7.18b 新项？）');
                const item = P.qa('.kbw-menu .kbw-menu-item').find((i) => P.text(i).indexOf('现处 ' + dirB) >= 0);
                if (!item) note('点不到「现处」项');
                else {
                  P.click(item);
                  await P.wait(800);
                  const cfm = P.lastModal();
                  if (!cfm || P.text(cfm).indexOf('只写声明') < 0) note('确认流没弹（或文案不含"只写声明"）');
                  else {
                    const go = Array.from(cfm.querySelectorAll('button')).find((b) => P.text(b).indexOf('只写声明') >= 0);
                    if (!go) note('确认单里找不到「只写声明」');
                    else {
                      P.click(go);
                      const okB = await waitUntil(() => { const d = declaredOf(B); return !!d && d.length > 0 && d[0] === dirB; }, 8000);
                      if (!okB) note('★ 点「现处」之后声明没纠回 ' + dirB + '（实际：' + JSON.stringify(declaredOf(B)) + '）');
                      if (!app.vault.getAbstractFileByPath(B)) note('B 被搬了（"只写声明"不该动文件）');
                    }
                  }
                }
              }
            }
          }
        }
      } finally {
        try { if (P.closeAll) P.closeAll(4); } catch (e) { /* 尽力 */ }
        try { if (leaf) leaf.detach(); } catch (e) { /* 尽力 */ }
        for (const p of [A, A_MOVED, B, BIN, BIN_MOVED]) {
          try { const f = app.vault.getAbstractFileByPath(p); if (f) await app.vault.delete(f, true); } catch (e) { /* 尽力 */ }
        }
        for (const d of [at(dirA), at(dirB)]) {
          try { const node = app.vault.getAbstractFileByPath(d); if (node) await app.vault.delete(node, true); } catch (e) { /* 尽力 */ }
        }
        await P.wait(800);
        const idxNow = () => ctx.index.getAll().filter((e) => e.path.indexOf('__探针P718b') >= 0).length;
        for (let i = 0; i < 8 && idxNow() > 0; i += 1) {
          ctx.index.rebuild();
          await P.wait(500);
        }
        if (idxNow() > 0) note('自清理后索引里还剩 ' + idxNow() + ' 条探针条目');
      }
      return {
        ok: problems.length === 0,
        info: '拖拽补声明（未声明也写）+ 「现处 X」纠错位（不动文件）' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    /**
     * P7.17 · **存量补齐（真机半步）**：修洞（有前言补缺键）+ D1（文件位置=实际落点 + 收藏）
     * + 合并矩阵分档（旧值待迁 / 覆盖区 / 坏前言跳过）+ 覆盖真链路 + 撤销还原。
     *
     * ⚠️ **把库根拨到自备小库**（`__探针P717库`）再跑：全库补全在实验库本体上会连锁改写
     * 几十篇（别的探针步的夹具前提都在里面）—— 小库根让 N 完全可预期（= 2 篇），
     * 走的仍是**用户那条路**（设置 → 自动化 → 扫描…）。收尾拨回 + 删净。
     * 分档的 UI 断言（坏前言逐篇列名 / 旧值待迁行 / 覆盖区 from→to）也都在这一步钉着。
     */
    name: 'P7.17 · 存量补齐：缺键合并 · 覆盖区 · 坏前言跳过 · 撤销还原（自备小库根）',
    shot: 'P7.17-存量补齐与覆盖.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      const NL = String.fromCharCode(10);
      const KB0 = ctx.settings.kbRoot();
      const SCRATCH = '__探针P717库';
      const dir = SCRATCH + '/00_Inbox';
      const A = dir + '/__探针P717缺键.md';
      const B = dir + '/__探针P717旧值.md';
      const C = dir + '/__探针P717坏前言.md';
      const A_RAW = ['---', '类型: 笔记', 'tags:', '  - 保留我', '---', '', '__探针P717缺键正文', ''].join(NL);
      const B_RAW = ['---', '类型: 想法', '---', '', '__探针P717旧值正文', ''].join(NL);
      const C_RAW = ['---', '创建日期: {{date}}', 'tags: []', '---', '', '__探针P717坏前言正文', ''].join(NL);
      const read = async (p) => { try { return await app.vault.adapter.read(p); } catch (e) { return ''; } };
      const exists = async (p) => { try { return await app.vault.adapter.exists(p); } catch (e) { return false; } };
      const waitUntil = async (fn, ms) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await P.wait(200); } };
      const modalWith = (needle) => { const all = P.qa('.kbw-modal'); for (let i = all.length - 1; i >= 0; i -= 1) { if (P.text(all[i]).indexOf(needle) >= 0) return all[i]; } return null; };
      const footFind = (modal, test) => Array.from(modal.querySelectorAll('.kbw-modal-foot .kbw-btn')).find((b) => test(P.text(b)));
      try {
        P.closeAll(4);
        await P.wait(400);
        // ── 0. 自备小库根 + 三篇夹具（缺键 / 旧值 / 坏前言）──
        if (!(await exists(dir))) await app.vault.createFolder(dir);
        for (const pair of [[A, A_RAW], [B, B_RAW], [C, C_RAW]]) {
          const old = app.vault.getAbstractFileByPath(pair[0]);
          if (old) await app.vault.delete(old, true);
          await app.vault.create(pair[0], pair[1]);
        }
        await ctx.settings.save({ kbRoot: SCRATCH });
        const scoped = await waitUntil(() => !!ctx.index.get(A), 8000);
        if (!scoped) note('换库根之后夹具没进索引（后面会连带失败，先看这条）');

        // ── ① 次入口：设置 → 自动化，「当前 N 篇可补」= 2（补 1 + 覆盖 1；坏前言不计）──
        ctx.openWorkbenchSettings('automation');
        await P.wait(1200);
        /**
         * ⚠️ P.until 返回**布尔**（不是 fn 的值 —— 探针助手就是这么写的）：
         * 等它绿了再自己取元素，别把 true 当元素用（P.text(true) = 空串）。
         */
        await P.until(() => P.qa('.kbw-set-status').some((el) => P.text(el).indexOf('篇可补') >= 0), 8000);
        const hint = P.qa('.kbw-set-status').find((el) => P.text(el).indexOf('篇可补') >= 0);
        if (!hint) note('设置里没有「当前 N 篇可补」那行提示');
        else if (P.text(hint).indexOf('当前 2 篇可补') < 0) note('提示数不对（期望 2：缺键 1 + 旧值 1；实际「' + P.text(hint) + '」）');
        const scanBtn = P.qa('.kbw-set-main .kbw-btn').find((b) => P.text(b).indexOf('扫描') >= 0);
        if (!scanBtn) return { ok: false, info: '设置里找不到「扫描…」按钮' };
        P.click(scanBtn);
        await P.wait(1500);
        const panel = modalWith('一键补全存量笔记');
        if (!panel) return { ok: false, info: '补全面板没开' };
        const pText = () => P.text(panel);
        const ready = await waitUntil(() => pText().indexOf('坏前言') >= 0, 8000);
        if (!ready) note('扫描迟迟没出分档（坏前言那档没出现）');
        if (pText().indexOf('覆盖区') < 0) note('覆盖区没画出来');
        if (pText().indexOf('类型：想法 → 笔记') < 0) note('覆盖区没列「类型：想法 → 笔记」（建议值来自映射表）');
        if (pText().indexOf('旧值待迁') < 0) note('「旧值待迁」那行没出现');
        if (pText().indexOf('__探针P717坏前言') < 0) note('坏前言没逐篇列名');
        const aRow = Array.from(panel.querySelectorAll('.kbw-mig-row')).find((r) => P.text(r).indexOf('__探针P717缺键') >= 0);
        if (!aRow || P.text(aRow).indexOf('补了：') < 0) note('缺键篇那行没写「补了：…」');
        else {
          const at = P.text(aRow);
          if (at.indexOf('文件位置') < 0 || at.indexOf('收藏') < 0) note('缺键篇没点出要补「文件位置 / 收藏」（D1）');
        }

        // ── ② 覆盖区：勾「旧值」→ 覆盖所选 1 处 → 只改那键 → 撤销逐字节还原 ──
        const lab = P.qa('.kbw-mig-cover').find((l) => P.text(l).indexOf('__探针P717旧值') >= 0);
        if (!lab) note('覆盖区里没有旧值篇那一行');
        else {
          const cb = lab.querySelector('input.kbw-mig-check');
          if (!cb || cb.checked) note('覆盖行没有勾选框 / 默认不是未勾（D2：默认全不勾）');
          else {
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            await P.wait(250);
            const covBtn = P.qa('.kbw-mig-op .kbw-btn').find((b) => P.text(b).indexOf('覆盖所选 1 处') >= 0);
            if (!covBtn) note('勾了之后按钮没变成「覆盖所选 1 处」');
            else {
              P.click(covBtn);
              await P.wait(800);
              const cfm = modalWith('即将覆盖');
              if (!cfm) note('覆盖没有走确认流');
              else {
                const go = footFind(cfm, (t) => t.indexOf('覆盖 1 处') >= 0);
                if (!go) note('确认流没有「覆盖 1 处」主按钮');
                else P.click(go);
              }
            }
          }
        }
        const coverOk = await waitUntil(async () => (await read(B)).indexOf('类型: 笔记') >= 0, 12000);
        if (!coverOk) note('覆盖没写进（旧值篇的 类型 应变成 笔记）');
        else {
          const bt = await read(B);
          if (bt.indexOf('__探针P717旧值正文') < 0) note('覆盖把正文动了（应只碰那一个键）');
          if (bt.indexOf('状态') >= 0) note('覆盖顺手写了别的键（不该）');
        }
        const undo1 = P.qa('.kbw-undobar .kbw-btn').find((b) => P.text(b).indexOf('撤销') >= 0);
        if (!undo1) note('覆盖完没出撤销条');
        else {
          P.click(undo1);
          const back = await waitUntil(async () => (await read(B)) === B_RAW, 12000);
          if (!back) note('撤销覆盖没有逐字节还原旧值篇');
        }

        // ── ③ 补全：缺键篇补齐（含 D1 两键）· 坏前言一字不动 · 撤销还原 ──
        P.closeAll(4);
        await P.wait(400);
        ctx.openWorkbenchSettings('automation');
        await P.wait(1000);
        const scanBtn2 = P.qa('.kbw-set-main .kbw-btn').find((b) => P.text(b).indexOf('扫描') >= 0);
        if (scanBtn2) P.click(scanBtn2);
        await P.wait(1500);
        const panel2 = modalWith('一键补全存量笔记');
        if (!panel2) note('第二次没开成面板');
        else {
          /**
           * ⚠️ 用 [0-9] 别写反斜杠转义：这一整段是**外层模板串**，转义会被外层吃掉
           * —— 正则永远不中（本轮首跑就是这么红的：按钮明明是「补全 2 篇」）。
           */
          const runBtn = footFind(panel2, (t) => /^补全 [0-9]+ 篇$/.test(t));
          if (!runBtn) note('面板里没有「补全 N 篇」主按钮');
          else {
            P.click(runBtn);
            await P.wait(800);
            const cfm2 = modalWith('即将补全');
            if (!cfm2) note('补全没有走确认流');
            else {
              const go2 = footFind(cfm2, (t) => t.indexOf('补全 ') === 0);
              if (!go2) note('补全确认流没有主按钮');
              else P.click(go2);
            }
          }
        }
        const fillOk = await waitUntil(async () => {
          const t = await read(A);
          return t.indexOf('文件位置:') >= 0 && t.indexOf('收藏: false') >= 0;
        }, 12000);
        if (!fillOk) note('补全没写进（缺键篇应补上 文件位置 / 收藏 等）');
        else {
          const t = await read(A);
          if (t.indexOf('  - 保留我') < 0) note('已有 tags 被动过（成对判据：已有键一字不动）');
          if (t.indexOf('__探针P717缺键正文') < 0) note('正文被动过');
          if (t.indexOf('  - 00_Inbox') < 0) note('文件位置没写实际落点（D1）');
          if (t.indexOf('类型: 笔记') < 0) note('已有的 类型 被动过');
        }
        if ((await read(C)) !== C_RAW) note('坏前言篇被写了（应整篇跳过、一字不动）');
        const undo2 = P.qa('.kbw-undobar .kbw-btn').find((b) => P.text(b).indexOf('撤销') >= 0);
        if (!undo2) note('补全完没出撤销条');
        else {
          P.click(undo2);
          const back2 = await waitUntil(async () => (await read(A)) === A_RAW, 12000);
          if (!back2) note('撤销补全没有逐字节还原缺键篇');
        }
      } finally {
        try { if (P.closeAll) P.closeAll(4); } catch (e) { /* 尽力 */ }
        try {
          if (ctx.settings.kbRoot() !== KB0) await ctx.settings.save({ kbRoot: KB0 });
          await P.wait(1200);
        } catch (e) { /* 尽力 */ }
        try {
          const node = app.vault.getAbstractFileByPath(SCRATCH);
          if (node) await app.vault.delete(node, true);
        } catch (e) { /* 尽力 */ }
        await P.wait(800);
        const idxNow = () => ctx.index.getAll().filter((e) => e.path.indexOf('__探针P717') >= 0).length;
        for (let i = 0; i < 8 && idxNow() > 0; i += 1) {
          ctx.index.rebuild();
          await P.wait(500);
        }
        if (idxNow() > 0) note('自清理后索引里还剩 ' + idxNow() + ' 条探针条目');
      }
      return {
        ok: problems.length === 0,
        info: '自备小库根 · 缺键合并 + 覆盖区 + 坏前言跳过 + 撤销还原' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    /**
     * P7.18 · **退出清理（真机整链）**：设置 → 数据 → 那行 → 面板（默认全不勾）→
     * 勾一个键 + 一项足迹 → 危险两段确认 → 真删 → 撤销逐字节还原。
     *
     * ⚠️ **自备小库根**（__探针P718库）：全库删键会连锁改实验库本体几十篇（别的探针步的
     * 夹具前提都在里面）—— 小库让"会删到的"完全可预期，走的仍是用户那条路。
     * ⚠️ 本面板**不写库内日志**（日志目录就在被清名单里）—— 所以收尾不用清日志。
     */
    name: 'P7.18 · 退出清理：删键与足迹 · 撤销还原（自备小库根）',
    shot: 'P7.18-退出清理.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      const NL = String.fromCharCode(10);
      const KB0 = ctx.settings.kbRoot();
      const SCRATCH = '__探针P718库';
      const A = SCRATCH + '/00_Inbox/__探针P718六件.md';
      const WBDIR = SCRATCH + '/99_Meta/06_工作台';
      const AUTO = WBDIR + '/自动化.json';
      const A_RAW = ['---', '类型: 笔记', '状态: 进行中', 'tags:', '  - 保留我', '---', '', '__探针P718正文', ''].join(NL);
      const AUTO_RAW = '{ "version": 1 }' + NL;
      const read = async (p) => { try { return await app.vault.adapter.read(p); } catch (e) { return ''; } };
      const exists = async (p) => { try { return await app.vault.adapter.exists(p); } catch (e) { return false; } };
      const waitUntil = async (fn, ms) => { const t0 = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t0 > ms) return false; await P.wait(200); } };
      const modalWith = (needle) => { const all = P.qa('.kbw-modal'); for (let i = all.length - 1; i >= 0; i -= 1) { if (P.text(all[i]).indexOf(needle) >= 0) return all[i]; } return null; };
      const footFind = (modal, test) => Array.from(modal.querySelectorAll('.kbw-modal-foot .kbw-btn')).find((b) => test(P.text(b)));
      try {
        P.closeAll(4);
        await P.wait(400);
        // ── 0. 小库 + 夹具（一篇六件齐 + 一个配置 json）──
        if (!(await exists(SCRATCH + '/00_Inbox'))) await app.vault.createFolder(SCRATCH + '/00_Inbox');
        if (!(await exists(WBDIR))) await app.vault.createFolder(WBDIR);
        for (const pair of [[A, A_RAW], [AUTO, AUTO_RAW]]) {
          const old = app.vault.getAbstractFileByPath(pair[0]);
          if (old) await app.vault.delete(old, true);
          await app.vault.create(pair[0], pair[1]);
        }
        await ctx.settings.save({ kbRoot: SCRATCH });
        if (!(await waitUntil(() => !!ctx.index.get(A), 8000))) note('换库根之后夹具没进索引（后面会连带失败，先看这条）');

        // ── ① 入口：设置 → 数据 → 「退出插件前的清理…」→ 打开面板 ──
        ctx.openWorkbenchSettings('data');
        await P.wait(1200);
        const setRow = Array.from(document.querySelectorAll('.kbw-set-row')).find((r) => P.text(r).indexOf('退出插件前的清理') >= 0);
        if (!setRow) note('数据栏里找不到「退出插件前的清理…」行');
        const openBtn = setRow ? Array.from(setRow.querySelectorAll('.kbw-btn')).find((b) => P.text(b).indexOf('打开') >= 0) : null;
        if (!openBtn) note('那行里没有「打开…」按钮');
        else P.click(openBtn);
        if (!(await waitUntil(() => !!modalWith('退出插件前的清理'), 5000))) note('清理面板没开');

        // ── ② 扫描：两行在 · 默认全不勾 ──
        const scanned = await waitUntil(() => {
          const rows = Array.from(document.querySelectorAll('.kbw-clean-pick'));
          return rows.some((r) => P.text(r).indexOf('「状态」') >= 0) && rows.some((r) => P.text(r).indexOf('工作台配置') >= 0);
        }, 6000);
        if (!scanned) note('扫描没扫出「状态」键行 / 「工作台配置」行');
        const picks = Array.from(document.querySelectorAll('.kbw-clean-pick'));
        if (picks.some((r) => { const cb = r.querySelector('input.kbw-mig-check'); return !!cb && cb.checked; })) {
          note('默认全不勾被破：有勾选框初始就是勾上的');
        }
        const kRow = picks.find((r) => P.text(r).indexOf('「状态」') >= 0);
        const fRow = picks.find((r) => P.text(r).indexOf('工作台配置') >= 0);
        const arm = (r) => { const cb = r ? r.querySelector('input.kbw-mig-check') : null; if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } };
        arm(kRow); arm(fRow);
        await P.wait(300);

        // ── ③ 清理：主按钮 → 确认流 → 危险两段 ──
        const runBtn = Array.from(document.querySelectorAll('.kbw-modal-foot .kbw-btn')).find((b) => P.text(b).indexOf('清理所选') >= 0);
        if (!runBtn) note('找不到「清理所选」主按钮');
        else P.click(runBtn);
        const cfmOk = await waitUntil(() => !!modalWith('即将清理'), 5000);
        const cfm = cfmOk ? modalWith('即将清理') : null;
        if (!cfm) note('确认流没弹（动库前确认只能过 confirm）');
        else {
          const go = footFind(cfm, (t) => t.indexOf('清理 2 项') >= 0);
          if (!go) note('确认单里点不到「清理 2 项」主按钮');
          else {
            P.click(go);
            await P.wait(250);
            const again = footFind(cfm, (t) => t.indexOf('再点一次确认') >= 0);
            if (!again) note('危险两段确认丢了：第二下找不到「再点一次确认」');
            else P.click(again);
            if (!(await waitUntil(async () => (await read(A)).indexOf('状态:') < 0, 8000))) note('「状态」键没删掉（面板执行链）');
            const after = await read(A);
            if (after.indexOf('tags:') < 0 || after.indexOf('保留我') < 0) note('别的键被动了（只该删勾中的那个键）');
            if (after.indexOf('__探针P718正文') < 0) note('正文被动了');
            if (await exists(AUTO)) note('自动化.json 没删掉（足迹链）');
          }
        }

        // ── ④ 撤销还原 ──
        const undoOk = await waitUntil(() => P.qa('.kbw-undobar .kbw-btn').some((x) => P.text(x).indexOf('撤销') >= 0), 5000);
        if (!undoOk) note('删完没出撤销条（快照兜底）');
        else {
          P.click(P.qa('.kbw-undobar .kbw-btn').find((x) => P.text(x).indexOf('撤销') >= 0));
          if (!(await waitUntil(async () => (await read(A)) === A_RAW, 12000))) note('撤销之后笔记没逐字节回到原样');
          else if (!(await exists(AUTO))) note('撤销之后配置文件没回来');
        }
      } finally {
        try { if (P.closeAll) P.closeAll(4); } catch (e) { /* 尽力 */ }
        try {
          if (ctx.settings.kbRoot() !== KB0) await ctx.settings.save({ kbRoot: KB0 });
          await P.wait(1200);
        } catch (e) { /* 尽力 */ }
        try {
          const node = app.vault.getAbstractFileByPath(SCRATCH);
          if (node) await app.vault.delete(node, true);
        } catch (e) { /* 尽力 */ }
        await P.wait(800);
        const idxNow = () => ctx.index.getAll().filter((e) => e.path.indexOf('__探针P718') >= 0).length;
        for (let i = 0; i < 8 && idxNow() > 0; i += 1) {
          ctx.index.rebuild();
          await P.wait(500);
        }
        if (idxNow() > 0) note('自清理后索引里还剩 ' + idxNow() + ' 条探针条目');
      }
      return {
        ok: problems.length === 0,
        info: '设置→数据入口 · 默认全不勾 · 危险两段确认 · 删键+删足迹 · 撤销逐字节还原' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2b · 教程中心（折叠/正文渲染）· 首页四钮悬停提示 · 键表一句人话 · 命名模板预览',
    shot: 'P7.2b-教程与命名.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(500);

      // ── ① 键表：每个动作一行说明（14 行） ──
      ctx.openKeysHelp();
      await P.wait(800);
      const keyRows = P.qa('tbody tr[data-keys-row]');
      const keyDescs = P.qa('.kbw-keys-desc');
      if (keyRows.length !== 14) note('键表该有 14 个动作，实际 ' + keyRows.length);
      const missingDesc = keyRows.filter(function (r) { return !P.q('.kbw-keys-desc', r); });
      if (missingDesc.length > 0) note('键表里有 ' + missingDesc.length + ' 行没有「一句人话」');
      P.key('Escape');
      await P.wait(600);

      // ── ② 首页四钮：悬停停留 ~600ms 出解释浮层 / 不带出对话框 / 移开关得掉 ──
      //    ⚠️ P7.7 收（用户真机 2026-10-05）：四枚「?」徽标退役 → 这半步同时钉"徽标不许回来"
      const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome) { P.click(navHome); await P.wait(900); }
      const badges = P.qa('.kbw-qbtn-tip');
      if (badges.length !== 0) note('「?」徽标该退役了，实际还有 ' + badges.length + ' 枚');
      const quickBtns = P.qa('.kbw-qbtn');
      let tipOk = false;
      if (quickBtns.length < 4) note('首页四钮不在（' + quickBtns.length + ' 个）');
      else {
        const b0 = quickBtns[0];
        b0.dispatchEvent(P.mkPointer('pointerenter', 40, 40, 'mouse'));
        await P.wait(300);
        if (P.q('.kbw-panel')) note('停留不足就出了提示（划过就弹会很吵）');
        await P.wait(600);
        if (P.q('.kbw-modal')) note('悬停把对话框带出来了（该只开小浮层）');
        const tip = P.q('.kbw-panel');
        tipOk = !!tip && P.text(tip).indexOf('新建笔记') >= 0;
        if (!tipOk) note('悬停停留的小浮层没开出来（或标题不对）');
        b0.dispatchEvent(P.mkPointer('pointerleave', 200, 200, 'mouse'));
        await P.wait(700);
        if (P.q('.kbw-panel')) note('移开之后小浮层没关掉');
      }
      /**
       * ── ②b 点击即取消（P7.9 · ③ 用户复现的缺陷）：进按钮 250ms 内点一下（pointerdown）
       * → 跨过 600ms **不再冒**；离开再回来（新的 pointerenter）照常出。 ──
       * 旧实现：dwell 不理会点击 —— 点开菜单后到点提示照常冒出（挤在菜单后面）。
       */
      if (quickBtns.length >= 4) {
        const b1 = quickBtns[1];
        b1.dispatchEvent(P.mkPointer('pointerenter', 60, 60, 'mouse'));
        await P.wait(250);
        b1.dispatchEvent(P.mkPointer('pointerdown', 60, 60, 'mouse'));
        b1.dispatchEvent(P.mkPointer('pointerup', 60, 60, 'mouse'));
        await P.wait(800);
        if (P.q('.kbw-panel')) note('点过之后再跨过 dwell 还冒出提示（P7.9 · ③ 回归了）');
        b1.dispatchEvent(P.mkPointer('pointerleave', 300, 300, 'mouse'));
        await P.wait(500);
        b1.dispatchEvent(P.mkPointer('pointerenter', 60, 60, 'mouse'));
        await P.wait(800);
        if (!P.q('.kbw-panel')) note('点击取消之后重新悬停也不出提示了（取消过头 = 把功能关掉了）');
        b1.dispatchEvent(P.mkPointer('pointerleave', 300, 300, 'mouse'));
        await P.wait(500);
        if (P.q('.kbw-panel')) note('收尾没关掉（②b 之后浮层还挂着）');
      }

      // ── ③ 命名模板：默认形状 + 预览跟着输入走（改完复原） ──
      ctx.openWorkbenchSettings('automation');
      await P.wait(1000);
      const nameInput = P.q('.kbw-name .kbw-input');
      let nameOk = false;
      if (!nameInput) note('自动化栏里没有命名模板输入框');
      else {
        const v = nameInput.value;
        /**
         * ⚠️ 输入框里是**模板本身**（「YYYY-MM-DD HHmm」）——渲染出来的名字形状在**预览行**
         * 与新建对话框里（下面那条就是预览）。第一版把这里当"渲染后的名字"验，判据写反了。
         */
        nameOk = v === 'YYYY-MM-DD HHmm';
        if (!nameOk) note('默认名模板不是「YYYY-MM-DD HHmm」（实际 ' + v + '）');
        const old = nameInput.value;
        nameInput.value = 'YYYY';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(400);
        const prev = P.q('.kbw-name-prev');
        if (!prev || prev.textContent.indexOf(String(new Date().getFullYear())) < 0) note('命名预览没有跟着输入走');
        nameInput.value = old;
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await P.wait(300);
      }
      P.key('Escape');
      await P.wait(700);

      // ── 收尾：开教程中心、展开第一篇 —— 截图停这一屏 ──
      ctx.openWorkbenchSettings('help');
      await P.wait(1000);
      const tCards = P.qa('.kbw-tut-card');
      // P7.10 · #7/#8：六篇 → 九篇；P7.18 加第十篇「不想用了怎么办」
      if (tCards.length !== 10) note('教程中心该有 10 篇，实际 ' + tCards.length);
      const firstHead = P.q('.kbw-tut-head');
      if (firstHead) { P.click(firstHead); await P.wait(900); }
      const firstBody = P.q('.kbw-tut-card .kbw-tut-body');
      const bodyText = firstBody ? P.text(firstBody) : '';
      // P7.9 · ①：第一篇正文重写 —— 认新文案里的一句（旧句"工作文件夹"不再是子串）
      if (bodyText.indexOf('工作台只管一个文件夹') < 0) note('教程第一篇的正文没渲染出来');
      /**
       * P7.10 · #8：**配图篇**（第 8 篇《批量操作》）—— 展开它，图必须真加载出来。
       * 这是配图唯一验得到的层次：离线只断言 src 字符串，jsdom 不加载图片（同向导配图那条）。
       */
      const batchCard = tCards[7];
      // ⚠️ **必须用原生 querySelector 限定在这张卡里** —— 「P.q(s)」只吃**一个**参数
      //（它内部是「document.querySelector(s)」，第二个参数会被**静默忽略**）：
      // 第一版写「P.q('.kbw-tut-head', batchCard)」实际取到的是**第 1 张卡的头**，
      // 一"点"把上一步刚展开的第一篇收了回去 → 第 8 篇从没展开 → 报"没有配图"（首跑就是这么假的）
      const batchHead = batchCard ? batchCard.querySelector('.kbw-tut-head') : null;
      if (!batchCard) note('第 8 篇（批量操作）不在');
      else if (!batchHead) note('第 8 篇没有卡头');
      else {
        P.click(batchHead);
        await P.wait(900);
        const shotImg = batchCard.querySelector('.kbw-tut-shot .kbw-tut-img');
        if (!shotImg) note('《批量操作》篇没有配图（shots 渲染丢了？）');
        else if (!(shotImg.complete && shotImg.naturalWidth > 0)) {
          note('《批量操作》配图没加载出来（naturalWidth=' + shotImg.naturalWidth + '）');
        }
      }

      return {
        ok: problems.length === 0,
        info: '键表说明=' + keyDescs.length + ' 行 · 四钮提示（悬停）=' + (tipOk ? '开合正常' : '✗') +
          ' · 命名默认形状=' + nameOk + ' · 教程卡=' + tCards.length +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P6④ · 向导：走完之后**不再弹**（负向）· 设置里能重开 · 命令面板不涨条数',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      /** 在**它开着的时候**记下来 —— 收尾再读的话一个都读不到（那会让 info 说反话） */
      let reopened = false;
      if (!(await P.reloadPlugin())) return { ok: false, info: '重载插件失败' };
      const ctx = P.ctx();
      if (ctx.settings.get().wizardDone !== true) note('上一步结束时 wizardDone 不是 true，实际 ' + String(ctx.settings.get().wizardDone));

      // ── 负向判据：走完之后打开工作台**一次都不许弹** ──
      await ctx.activate();
      await P.wait(1500);
      const popped = !!P.wizard();
      if (popped) note('wizardDone=true 之后**又弹了**（负向判据）');

      // ── 设置里能重开（入口在设置面板，**不是**命令面板 —— B5 拍过）──
      ctx.openWorkbenchSettings();
      await P.wait(900);
      const settings = P.lastModal();
      if (!settings) note('设置面板没开');
      /**
       * ⚠️ 认的是**帮助**那一栏 —— 向导自己的副标题写着「设置 → 帮助 → 重新运行首次向导」，
       * 交互规格.md §14.2 那张表也这么写。第一版把按钮放进了新加的「AI 助手」栏，
       * 于是界面上那句话指着一个没有这个按钮的地方（本步就是盯这一条的）。
       * 顺带：六栏各自都画得出来这件事由「设置面板六栏」那一步管，不在这儿重复。
       */
      const tab = settings ? Array.from(settings.querySelectorAll('.kbw-set-tab')).find((t) => P.text(t).indexOf('帮助') >= 0) : null;
      if (!tab) note('设置面板左栏没有「帮助」那一栏');
      else {
        P.click(tab);
        await P.wait(800);
        const btn = Array.from(document.querySelectorAll('.kbw-set-main .kbw-btn')).find((b) => P.text(b).indexOf('重新运行首次向导') >= 0);
        if (!btn) note('「重新运行首次向导」那个入口不在');
        else {
          P.click(btn);
          await P.wait(1400);
          reopened = !!P.wizard();
          if (!reopened) note('点了「重新运行首次向导」也没开出来');
        }
      }
      const cmds = Object.keys(app.commands.commands).filter((id) => id.indexOf('kb-workbench:') === 0);
      const wizardCmd = cmds.filter((id) => id.toLowerCase().indexOf('wizard') >= 0);
      if (wizardCmd.length > 0) note('命令面板里多了向导命令：' + wizardCmd.join(', '));

      // 收场：按「完成」收掉 + 把 wizardDone 落回 true（配过的库该有的稳态）
      if (P.wizard()) P.wizardFoot('完成');
      await P.wait(900);
      P.closeAll(4);
      await P.setWizardDone(true);
      return {
        ok: problems.length === 0,
        info: '走完之后不再弹=' + !popped + ' · 设置里能重开=' + reopened + ' · 命令条数=' + cmds.length +
          '（无向导命令）' + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },

  /* ══════════════════════════════════════════════════════════════════
     P7.0a · 批 1 的四条**真机判据**（① 小窗属性空壳 · ③ 平台标题栏 · ⑤ 触屏 seg · ⑪ 卡片底缘淡出）
     ──────────────────────────────────────────────────────────────────
     全是 computed style / 几何 —— jsdom 没有样式表，离线判不到，只能在这儿量。
     每条都**双边**（量到 0 不许算过，P6⑤ 的红线）。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.0a · ① 小窗属性：平台 metadata 外壳藏干净（computed none）· 自有属性行 ≥1',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      // 夹具：属性档 = 全部（v2 显式值 → 不走迁移），这样我们自己的属性行一定画
      //（配置缺席时兜个空壳 —— 换库跑第一轮别在 backup.view 上对 null 取值炸掉）
      const backup = JSON.parse(
        JSON.stringify((await ctx.configs.read('board')) || { version: 2, view: {} }),
      );
      await ctx.configs.write('board', Object.assign({}, backup, {
        version: 2,
        view: Object.assign({}, backup.view, { panelProps: 'all' }),
      }));
      await P.wait(700);

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('看板') >= 0; });
      if (nav) { P.click(nav); await P.wait(1400); }
      const card = P.qa('[data-card]')[0];
      if (!card) {
        await ctx.configs.write('board', backup);
        return { ok: false, info: '看板上一张卡都没有（夹具前提不成立）' };
      }
      P.click(card.querySelector('.kbw-card-t'));
      await P.wait(2000);
      const panel = P.q('.kbw-cw-panel');
      if (!panel) {
        await ctx.configs.write('board', backup);
        return { ok: false, info: '小窗没开出来（夹具前提不成立）' };
      }

      // 判据 ① 平台那份外壳的 computed display 必须是 none
      //（修法 = **变量覆盖**：.kbw-cw-leaf 上声明 --metadata-display-editing: none。
      //  asar 事实：该变量定义在平台 body{} 里；消费规则的选择器有 **5 个类**
      //  （:not() 里的类也计权重）——所以"重复类名"那版压不过，别再试权重路线）
      const shell = panel.querySelector('.metadata-container');
      const shellDisplay = shell ? getComputedStyle(shell).display : '(面板里没有 metadata-container)';
      if (shell && shellDisplay !== 'none') note('平台 metadata 外壳还看得见：display=' + shellDisplay);
      if (!shell) note('面板里找不到 .metadata-container（平台结构变了？判据失效）');

      // 判据 ② 我们自己的属性行 ≥1 —— 两条一起，否则"把整块藏干净"也能让第一条绿
      const ourRows = panel.querySelectorAll('.kbw-cw-props .kbw-cw-row').length;
      if (!(ourRows >= 1)) note('自有属性行 0 条（属性档=all 时该 ≥1）');

      // 收尾：关小窗（停靠态按底部「完成」，否则 Esc）+ 配置还原
      const foot = Array.from(panel.querySelectorAll('button')).find(function (b) { return P.text(b) === '完成'; });
      if (foot) { P.click(foot); await P.wait(900); }
      else { P.key('Escape'); await P.wait(900); }
      if (P.q('.kbw-cw-panel')) note('小窗没关掉');
      await ctx.configs.write('board', backup);
      await P.wait(600);

      return {
        ok: problems.length === 0,
        info: '外壳 display=' + shellDisplay + '｜自有属性行 ' + ourRows + ' 条' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.0a-①小窗属性.png',
  },
  {
    name: 'P7.0a · ③ 平台标题栏藏掉（工作台 leaf 的 .view-header computed none；自有顶栏标题还在）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(2);
      await P.wait(300);
      await P.ensureWorkbench();

      // 锚点是我们自己贴的类（不按 data-type 写 —— 图谱那次栽过）
      const leafs = P.qa('.kbw-workbench-leaf');
      if (leafs.length < 1) note('没找到 .kbw-workbench-leaf（视图 onOpen 没贴类 → 下面的判据会空过）');
      const heads = P.qa('.kbw-workbench-leaf .view-header');
      if (heads.length < 1) note('.kbw-workbench-leaf 里没有 .view-header 元素（平台结构变了？）');
      let shown = '';
      for (const h of heads) {
        const d = getComputedStyle(h).display;
        if (d !== 'none') shown += (shown ? ' / ' : '') + d;
      }
      if (shown) note('.view-header 还看得见：display=' + shown);

      // 反向：**我们自己的**顶栏标题必须还在（证明藏的是平台那条，没误伤）
      const t = P.q('.kbw-topbar h2');
      const titleText = t ? P.text(t) : '';
      if (!titleText) note('工作台自己的顶栏标题没了（藏错了对象？）');

      return {
        ok: problems.length === 0,
        info: 'leaf 数=' + leafs.length + '｜view-header 元素 ' + heads.length + ' 个（display ' +
              (shown || 'none') + '）｜自有顶栏「' + titleText + '」' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.0a · ⑤ 触屏 seg 不被裁（is-mobile 下 scrollWidth<=clientWidth 且末钮不越右缘）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      // 站到「全部笔记」（点导航项，别 store.set —— 设置层会把 activeModule 顶回去）
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(1200); }

      const wasMobile = document.body.classList.contains('is-mobile');
      document.body.classList.add('is-mobile');
      await P.wait(500);

      const seg = P.q('.kbw-seg');
      const btns = P.qa('.kbw-seg button');
      let info = '';
      if (!seg) note('找不到 .kbw-seg（工具条没画出来？）');
      // P7.1 两档化：档位按钮该是 2 个（详细信息 / 网格）；不是 2 就是有新档回来了
      if (btns.length !== 2) note('seg 里档位按钮不是 2 个（P7.1 两档化；实际 ' + btns.length + '）');
      if (seg) {
        const cw = seg.clientWidth;
        const sw = seg.scrollWidth;
        // 双边：量到 0 不许算过（P6⑤ 红线）
        if (!(cw > 0)) note('seg clientWidth=0（布局没起来 / 窗口不可见）');
        if (!(sw <= cw + 1)) note('seg 内容被裁：scrollWidth ' + sw + ' > clientWidth ' + cw);
        const last = btns[btns.length - 1];
        let lr = 0;
        let sr = 0;
        if (last) {
          lr = last.getBoundingClientRect().right;
          sr = seg.getBoundingClientRect().right;
          if (!(lr <= sr + 1)) note('末个档位按钮越出 seg 右缘：' + Math.round(lr) + ' > ' + Math.round(sr));
        } else note('seg 里一个按钮都没有');
        /**
         * 整行不横溢（独立审查 🟡6）：「flex: none」之后压力会**从 seg 转到整行** ——
         * 搜索框缩到地板（min-width 96px）还放不下时，右端工具按钮会被推出可视区，
         * 而上面 seg 自身两条判据**照样绿**。这里补量它所在的工具行。
         */
        const tools = seg.closest('.kbw-notes-tools');
        let toolsInfo = '';
        if (tools) {
          const tw = tools.clientWidth;
          const tsw = tools.scrollWidth;
          if (!(tw > 0)) note('工具行 clientWidth=0（布局没起来）');
          if (!(tsw <= tw + 1)) note('工具行横溢：scrollWidth ' + tsw + ' > clientWidth ' + tw);
          toolsInfo = '｜工具行 ' + tw + '/' + tsw;
        } else note('找不到 .kbw-notes-tools（结构变了？）');
        info = 'seg ' + cw + '/' + sw + '（client/scroll）｜末钮 right=' + Math.round(lr) +
               ' vs seg right=' + Math.round(sr) + '｜钮数=' + btns.length + toolsInfo;
      }

      if (!wasMobile) document.body.classList.remove('is-mobile');
      await P.wait(300);
      return {
        ok: problems.length === 0,
        info: info + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.0a · ⑪ 卡片正文底缘淡出（固定高度档 mask 生效 · 有滚余量才算数）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      // 夹具：固定高度档（has-h）+ 正文够长（有滚余量才"看得见"淡出的意义）
      const backup = JSON.parse(
        JSON.stringify((await ctx.configs.read('board')) || { version: 2, view: {} }),
      );
      await ctx.configs.write('board', Object.assign({}, backup, {
        view: Object.assign({}, backup.view, { cardMode: 'content', cardHeight: 260, collapsed: [] }),
      }));
      await P.wait(1400);

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('看板') >= 0; });
      if (nav) { P.click(nav); await P.wait(1400); }

      const holder = P.q('.kbw-cards');
      const hasH = !!(holder && holder.classList.contains('has-h'));
      if (!hasH) note('固定高度档没生效（.kbw-cards 没有 has-h —— 夹具前提不成立）');

      const body = P.q('.kbw-cards.has-h .kbw-card-body');
      let maskText = '(没有卡片正文)';
      let over = 0;
      if (!body) note('找不到 .kbw-cards.has-h 下的 .kbw-card-body');
      else {
        const cs = getComputedStyle(body);
        maskText = String(cs.maskImage || '') + ' ' + String(cs.webkitMaskImage || '');
        if (maskText.indexOf('gradient') < 0) note('底缘淡出没生效（mask-image 里没有 gradient）：' + maskText);
        over = body.scrollHeight - body.clientHeight;
        // 前提（不判红）：有滚余量才看得见淡出；报出来供人眼对照截图
      }

      await ctx.configs.write('board', backup);
      await P.wait(900);
      return {
        ok: problems.length === 0,
        info: 'has-h=' + hasH + '｜滚余量=' + over + 'px｜mask=' + maskText.replace(/\\s+/g, ' ') +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.0a-⑪卡片底缘淡出.png',
  },

  /* ══════════════════════════════════════════════════════════════════
     P7.0b · 14.8a：`goNotes` 收到**不存在的目录** —— 故意踩一次，看它报不报
     ──────────────────────────────────────────────────────────────────
     为什么要有这一步：当初把树节点的**标签**（「整个知识库」）当目录传进去，
     整屏 0 项、看着像功能坏了，查了一轮才排除 —— 静默是这里唯一的罪。
     产品侧的守卫会把 dir 丢掉 + console.warn；这一步**临时接管 console.warn**
     把那条抓下来断言（顺带：接管之后它不会进探针的 console 收集器，两边不打架）。
     还配两条反向判据：① 树选择**没被改**（坏目录没被应用）；② **真目录照样跳得进去**
     （守卫不许把正常的跳转一起拦掉 —— 只验"坏目录被拦"的话，一个"永远拒绝"的实现也会绿）。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.0b · 14.8a goNotes 坏目录：报出来 + 只丢 dir · 真目录照旧跳得进去',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (nav) { P.click(nav); await P.wait(900); }

      const before = ctx.settings.get().treeSelected;
      const BAD = '__探针不存在的目录';

      // ① 坏目录（"整个知识库"那个标签是真机上踩过的值，这里用自造标记值：
      //    它出现在 warn 文案里，收尾的清场/排查一眼能认出是探针造的）
      const cap = [];
      const origWarn = console.warn;
      console.warn = function () {
        cap.push(Array.prototype.map.call(arguments, function (x) { return String(x); }).join(' '));
      };
      let threw = '';
      try {
        ctx.goNotes({ dir: BAD });
        await P.wait(900);
      } catch (e) { threw = String(e); } finally { console.warn = origWarn; }

      if (threw) note('goNotes 抛异常了：' + threw);
      const hit = cap.some(function (t) { return t.indexOf('goNotes') >= 0 && t.indexOf(BAD) >= 0; });
      if (!hit) note('没有报出来（console.warn 里没有 goNotes + 坏目录那条）—— 14.8a 的守卫没生效？抓到 ' + cap.length + ' 条 warn');
      const dirApplied = ctx.settings.get().treeSelected !== before;
      if (dirApplied) {
        note('坏目录被应用了：treeSelected「' + before + '」→「' + ctx.settings.get().treeSelected + '」');
      }

      // ② 真目录照样跳得进去（反向判据：守卫不许把正常跳转一起拦掉）
      const dirs = P.dirsUnder(ctx.settings.kbRoot());
      const byDir = {};
      ctx.index.notes().forEach(function (e) {
        const d = e.effectivePosition;
        if (!d || d.indexOf('/') >= 0) return;
        if (dirs.indexOf(d) < 0) return;
        byDir[d] = (byDir[d] || 0) + 1;
      });
      const good = Object.keys(byDir).sort(function (a, b) { return byDir[b] - byDir[a]; })[0];
      let goodJump = '没验成';
      if (!good) {
        note('库里没有一个"盘上真有 + 本层有笔记"的目录 —— 反向判据没验成（这是夹具问题，不是守卫问题）');
      } else {
        ctx.goNotes({ dir: good });
        await P.wait(900);
        const now = ctx.settings.get().treeSelected;
        goodJump = now === good ? '✓' : '✗（实际「' + now + '」）';
        if (now !== good) note('真目录没跳进去：期望「' + good + '」，实际「' + now + '」');
      }

      // 收尾：把树选择拨回原样（它是**落盘**的界面偏好 —— 别留给下一轮）
      const back = dirs.indexOf(before) >= 0 ? before : '';
      ctx.goNotes({ dir: back });
      await P.wait(700);
      const restored = ctx.settings.get().treeSelected === back;

      return {
        ok: problems.length === 0 && restored,
        info: '坏目录「' + BAD + '」：报出来=' + hit + ' · 坏目录被应用=' + dirApplied +
              ' · 真目录「' + (good || '（无）') + '」跳得进去=' + goodJump +
              ' · 收尾拨回「' + back + '」=' + restored +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },

  /* ══════════════════════════════════════════════════════════════════
     P7.0b · 菜单的**呈现清晰性**（硬规矩 2 放宽之后的那半条判据）
     ──────────────────────────────────────────────────────────────────
     2026-10-02 用户拍板：一级项数**不设硬线**（软目标 8 项），判据是"一眼扫得完" ——
     离线那半条在 `ui/menu.ts` 的 `validateMenuSpec`（长且一条分隔线都没有 → 违规）；
     **真机这半条在这里**：长菜单的几何不许超出视口（超了就是被裁掉一截，那才叫不清晰）。
     量的是两个"真机上最长"的菜单：板块菜单（9 项，固定）与**批量迁移菜单**
     （每个顶层目录一项 —— 随库结构变长，库大起来最容易出问题的那一个）。
     ⚠️ 几何判据一律**双边**：量到 0（没弹出来 / 不在布局里）不许算过。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.0b · 菜单清晰性：长菜单不超出视口（板块菜单 · 批量迁移菜单）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const vw = window.innerWidth || 1400;
      const vh = window.innerHeight || 900;

      /**
       * 量**最后一条**菜单（子菜单会叠在上面）：项数 / 分隔线数 / 矩形。
       * 判据：① 高度 > 0 且底边不越视口；② 右缘不越视口；③ 长菜单（> 软目标 8 项）要有分隔线。
       */
      const measureLast = (label) => {
        const menus = P.qa('.kbw-menu');
        const m = menus[menus.length - 1];
        if (!m) { note(label + '：菜单没弹出来'); return null; }
        const r = m.getBoundingClientRect();
        const n = m.querySelectorAll('.kbw-menu-item').length;
        const seps = m.querySelectorAll('.kbw-menu-sep').length;
        if (!(r.height > 0)) note(label + '：菜单高度量到 ' + Math.round(r.height) + '（不在布局里？）');
        if (!(r.bottom <= vh + 1)) note(label + '：底边 ' + Math.round(r.bottom) + ' 越出视口 ' + vh + '（被裁掉一截）');
        if (!(r.right <= vw + 1)) note(label + '：右缘 ' + Math.round(r.right) + ' 越出视口 ' + vw);
        if (n > 8 && seps === 0) note(label + '：一级 ' + n + ' 项却一条分隔线都没有（长菜单要有台阶）');
        return { n, seps, h: Math.round(r.height) };
      };

      // ① 看板的**板块菜单**（9 项 —— 放宽之前它在每轮探针里报 warn）
      const navB = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('看板') >= 0; });
      if (navB) { P.click(navB); await P.wait(1400); }
      const sec = P.q('.kbw-sect');
      let a = null;
      if (!sec) note('看板上一个板块都没有（夹具前提不成立）');
      else {
        const head = sec.querySelector('.kbw-sect-head') || sec.firstElementChild;
        head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
        await P.wait(500);
        a = measureLast('板块菜单');
        P.key('Escape');
        await P.wait(300);
        document.body.click();
        await P.wait(300);
      }

      // ② **批量迁移菜单**（每个顶层目录一项 —— 真机上最长的那一个）
      const navN = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
      if (navN) { P.click(navN); await P.wait(1200); }
      await P.useView('详细信息');
      const seeded = await P.enterDirWithNotes(1);
      if (!seeded) note('批量迁移那一半没验成：没有"本层有笔记"的目录');
      const row = P.q('.kbw-trow');
      let b = null;
      if (!row) note('批量迁移那一半没验成：表格里没有行');
      else {
        P.click(row);
        await P.wait(600);
        const mv = P.qa('.kbw-notes-bar .kbw-btn, .kbw-btn').find(function (x) { return P.text(x) === '迁移'; });
        if (!mv) note('批量栏里没有「迁移」按钮（选中没生效？）');
        else {
          P.click(mv);
          await P.wait(500);
          b = measureLast('批量迁移菜单');
        }
      }
      document.body.click();
      await P.wait(300);
      P.key('Escape');
      await P.wait(300);

      const fmt = (x) => x ? (x.n + ' 项/' + x.seps + ' 分隔线/' + x.h + 'px') : '没量到';
      return {
        ok: problems.length === 0,
        info: '视口 ' + vw + '×' + vh + '｜板块菜单 ' + fmt(a) + '｜批量迁移 ' + fmt(b) +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜两个都不越视口 · 全部通过 ✓'),
      };
    })()`,
  },

  {
    name: 'P7.2a · 首页区块：hover 工具 + 真机拖序落盘 + ⋯ 菜单隐藏',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);

      // 切模块一律点导航项（store.set 会被设置落盘顶回去 —— P6 段⑥ 的老账）
      const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome) { P.click(navHome); await P.wait(800); }
      if (!P.q('.kbw-home')) return { ok: false, info: '没进首页' };

      const blocks = function () {
        return P.qa('.kbw-hblock').map(function (b) { return b.dataset.block || ''; }).filter(Boolean);
      };
      const disk = async function () {
        try {
          const raw = await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json');
          return JSON.parse(raw).homeBlocks;
        } catch (e) { return undefined; }
      };

      // 起手摆回基线：实验库的 homeBlocks 基线 = null（P7.2a 之前没这个键；与 scopeAll 同一条纪律）
      await ctx.settings.save({ homeBlocks: null });
      await P.wait(600);
      const seq0 = blocks().join(',');
      if (seq0 !== 'hero,quick,todo,recent,foot') note('默认形态不对：期望 hero,quick,todo,recent,foot，实际 ' + seq0);

      /**
       * ── ① 块头工具的"浮现 / 收回"（双态 opacity）
       *
       * ⚠️ **真 hover 这一半验不了，不装验**：本步的合成指针（pointerMoveTo）是
       * JS 事件，**不改变浏览器的 :hover 状态机**；「Emulation.setEmulatedMedia」
       * 模拟 hover 特性本机也无效（P6⑤ 实测记档）。所以这里验**等价路径**：
       * 键盘聚焦拖柄（「:focus-within」规则同样把工具点亮 —— 它本来就是"键盘可达"
       * 的那一条），加上"默认 opacity:0"，覆盖同一机制的进出两端；
       * 纯 hover 那一半归离线静态规则 + 人眼（**如实标注，不假装验过**）。
       */
      const opa = function () {
        const t = P.q('.kbw-hblock[data-block="todo"] .kbw-hblock-tools');
        return t ? Number(getComputedStyle(t).opacity) : -1;
      };
      const base = opa();
      if (base < 0) note('todo 块上没有工具容器（.kbw-hblock-tools）');
      else if (!(base < 0.1)) note('没唤出时工具就露着（opacity=' + base + '，期望 0）');
      let focusOpa = -1;
      const grip2 = P.q('.kbw-hblock[data-block="todo"] .kbw-hblock-grip');
      if (!grip2) note('todo 块上没有拖柄（.kbw-hblock-grip）');
      else {
        grip2.focus();
        await P.wait(450);
        focusOpa = opa();
        if (!(focusOpa > 0.9)) note('键盘聚焦到拖柄后工具 opacity=' + focusOpa + '（期望 1，:focus-within 那条）');
        grip2.blur();
        await P.wait(450);
        const back = opa();
        if (!(back < 0.1)) note('失焦后工具没收回去（opacity=' + back + '，期望 0）');
      }

      /**
       * ── ①b 间距等价账（拆块承诺"视觉一字不变"；独立审查算出"兄弟 margin 塌陷"
       * 会把两笔折算各吃掉一截 —— 这两条几何判据是真机上的定案：
       *   快捷动作行底 → 分隔线顶 = 48（sp-6*2；拆前 hero 底 padding 24 + 线 margin-top 24）
       *   分隔线底 → 「待处理」标题顶 = 28（sp-5 + sp-2；拆前 body padding-top 8 + 标题 20）
       * 容差 ±3（DPR 舍入）。）
       */
      const qrEl = P.q('.kbw-hblock[data-block="quick"] .kbw-quickrow');
      const divEl = P.q('.kbw-hblock[data-block="quick"] .kbw-home-div');
      const headEl = P.q('.kbw-hblock[data-block="todo"] .kbw-sec-head');
      let gapA = -1;
      let gapB = -1;
      if (qrEl && divEl && headEl) {
        gapA = Math.round(divEl.getBoundingClientRect().top - qrEl.getBoundingClientRect().bottom);
        gapB = Math.round(headEl.getBoundingClientRect().top - divEl.getBoundingClientRect().bottom);
        if (!(gapA >= 45 && gapA <= 51)) note('「快捷动作→分隔线」间距 ' + gapA + 'px（期望 48±3 —— 塌陷账没对）');
        if (!(gapB >= 25 && gapB <= 31)) note('「分隔线→待处理」间距 ' + gapB + 'px（期望 28±3 —— 塌陷账没对）');
      } else {
        note('间距等价账的锚点没找齐（quickrow / home-div / sec-head）');
      }

      /**
       * ── ①c 块头工具与段头右端**不重叠**（用户真机截图：⠿/⋯ 压住「N 项」计数）。
       * **判据双边**（P7.11 独立审 🟡1 的教训）：计数右缘该在工具左缘之左（≥ -1），
       * **而且要紧贴**（≤ 60px）—— 只判"不重叠"的话，两份 margin-left:auto 平分空白
       * 把计数推到行中段也照样绿（越分开越绿）。让位不再靠 padding（那条已退役）。
       */
      const cntEl = P.q('.kbw-hblock[data-block="todo"] .kbw-sec-cnt');
      const toolsEl2 = P.q('.kbw-hblock[data-block="todo"] .kbw-hblock-tools');
      let gapTool = -999;
      if (cntEl && toolsEl2) {
        gapTool = Math.round(
          toolsEl2.getBoundingClientRect().left - cntEl.getBoundingClientRect().right,
        );
        if (!(gapTool >= -1)) note('计数与块头工具重叠 ' + -gapTool + 'px（cnt 右缘该在工具左缘左侧）');
        else if (!(gapTool <= 60)) {
          note('计数与工具之间空了 ' + gapTool + 'px（计数该紧贴工具 —— 两份 auto 平分空白的形态）');
        }
      } else {
        note('重叠判据的锚点没找齐（sec-cnt / hblock-tools）');
      }

      /**
       * ── ①d 块头工具与段头首行**同一条中线**。判据双边：中线差 |Δ| ≤ 2px。
       * 撑它的是 P7.11 · #6/#7 的**「同排实排」**：渲染循环把工具挪进首行当行内 flex 项
       *（home.css 的「.kbw-hblock-tools.is-inline」）—— 早先「算 top 值」那版被批注打回
       *（「量值算得对、视觉仍偏」），别再改回绝对值。
       */
      let dyAlign = -999;
      if (cntEl && toolsEl2) {
        const cR = cntEl.getBoundingClientRect();
        const tR = toolsEl2.getBoundingClientRect();
        dyAlign = Math.round(tR.top + tR.height / 2 - (cR.top + cR.height / 2));
        if (!(Math.abs(dyAlign) <= 2)) note('块头工具与「N 项」中线差 ' + dyAlign + 'px（期望 ±2 内）');
      }
      /**
       * ── ①e 同一条纪律扩到 **foot / 随机漫步**（P7.11 · #6/#7 用户实拍那两块）：
       * 工具中线 vs **首行文字**中线，双边 ±2。foot 量第一枚状态文字；
       * 漫步量标题 h3（工具挨着「换一批」，中线该与标题文字对齐）。
       */
      const alignDyOf = function (blockId, firstSel) {
        const box = P.q('.kbw-hblock[data-block="' + blockId + '"]');
        if (!box) return 'no-box';
        const tools = box.querySelector('.kbw-hblock-tools');
        const first = box.querySelector(firstSel);
        if (!tools || !first) return 'no-anchor';
        const tR = tools.getBoundingClientRect();
        const fR = first.getBoundingClientRect();
        return Math.round(tR.top + tR.height / 2 - (fR.top + fR.height / 2));
      };
      const dyFoot = alignDyOf('foot', '.kbw-home-foot-item');
      if (dyFoot === 'no-box' || dyFoot === 'no-anchor') note('foot 对齐锚点没找齐（' + dyFoot + '）');
      else if (typeof dyFoot === 'number' && Math.abs(dyFoot) > 2) {
        note('底部状态：工具与首行文字中线差 ' + dyFoot + 'px（期望 ±2 内）');
      }
      /**
       * ⚠️ 漫步**默认关着**（defaultOn: false）——量之前先把它摆出来，量完立刻还原 null
       *（后面的拖序/隐藏那几步都建立在"基线 5 块"上）。
       */
      await ctx.settings.save({ homeBlocks: { order: [], hidden: ['fav', 'tutorial', 'graphlink', 'homeCards'] } });
      await P.wait(900);
      const dyWalk = alignDyOf('walk', '.kbw-sec-head h3');
      if (dyWalk === 'no-box') note('随机漫步块摆出来了却不在（homeBlocks 没生效？）');
      else if (dyWalk === 'no-anchor') note('漫步对齐锚点没找齐');
      else if (typeof dyWalk === 'number' && Math.abs(dyWalk) > 2) {
        note('随机漫步：工具与标题中线差 ' + dyWalk + 'px（期望 ±2 内）');
      }
      const walkTools = P.q('.kbw-hblock[data-block="walk"] .kbw-hblock-tools');
      if (walkTools && (!walkTools.parentElement ||
          walkTools.parentElement.className.indexOf('kbw-sec-head') < 0)) {
        note('漫步工具没进首行（父=' + (walkTools.parentElement ? walkTools.parentElement.className : '?') + '）');
      }
      await ctx.settings.save({ homeBlocks: null });
      await P.wait(900);
      /**
       * 同排实排的**结构面**：工具得是首行的**行内子节点**（不是还在容器上绝对定位）——
       * 只量中线的话，"碰巧算得对"的旧方案也能绿一小段；这条钉"它真的入了行"。
       */
      const toolsInline = toolsEl2 ? toolsEl2.className.indexOf('is-inline') >= 0 : false;
      const toolsParentIsHead = !!(toolsEl2 && toolsEl2.parentElement &&
        toolsEl2.parentElement.className.indexOf('kbw-sec-head') >= 0);
      if (!toolsInline || !toolsParentIsHead) {
        note('todo 块工具没进首行（is-inline=' + toolsInline + '，父=' +
          (toolsEl2 && toolsEl2.parentElement ? toolsEl2.parentElement.className : '?') + '）');
      }
      const footTools = P.q('.kbw-hblock[data-block="foot"] .kbw-hblock-tools');
      if (footTools && (!footTools.parentElement ||
          footTools.parentElement.className.indexOf('kbw-home-foot') < 0)) {
        note('foot 块工具没进首行（父=' + (footTools.parentElement ? footTools.parentElement.className : '?') + '）');
      }

      // ── ② 真机拖序：拖 hero 的拖柄到 quick 的下半（应插在 quick 之后）
      const grip = P.q('.kbw-hblock[data-block="hero"] .kbw-hblock-grip');
      const quickBox = P.q('.kbw-hblock[data-block="quick"]');
      const g = grip ? P.aimAt(grip) : null;
      const d = quickBox ? P.rectAt(quickBox) : null;
      /**
       * ⚠️ P.rectAt 返回的是 { x, y, visible, rect: [left, top, width, height] } ——
       * **没有 height 字段**（第一版写了「d.y + d.height * 0.75」→ NaN →
       * elementFromPoint 抛「double value is non-finite」，整步崩在这）。
       * 落点 y = quick 块 top 起 0.75 高（中线以下 = 应插到它后面），再夹进视口。
       */
      const ty = d ? Math.round(Math.min((window.innerHeight || 800) - 8, d.rect[1] + d.rect[3] * 0.75)) : NaN;
      if (!g || !g.visible || !d || !d.visible) note('拖序的源/目标不在视野里');
      else if (!Number.isFinite(ty)) note('落点 y 算出来不是有限值（rect 拿错了？）');
      else {
        P.pointerDownAt(g.x, g.y, 'mouse');
        await P.wait(40);
        P.pointerMoveTo(g.x + 24, g.y + 6, 'mouse');  // 过 4px 阈值
        await P.wait(140);
        if (!P.q('.kbw-hgap')) note('拖动中没有空位（.kbw-hgap）');
        if (!P.q('.kbw-hfloat')) note('拖动中没有跟随的浮块（.kbw-hfloat）');
        P.pointerMoveTo(d.x, ty, 'mouse');
        await P.wait(200);
        P.pointerUpAt(d.x, ty, 'mouse');
        await P.wait(900);
      }
      const seq1 = blocks();
      const heroAt = seq1.indexOf('hero');
      /**
       * 落点要判**位置**（"落点永远在末尾"也让它变 —— 网格那条的教训）：
       * 拖到 quick 的下半 → hero 应插在 quick 后面（第 2 位；几何误差留 1 位）。
       */
      if (!(heroAt >= 1 && heroAt <= 2)) {
        note('拖到 quick 下半之后 hero 应排在第 2 位上下（实际第 ' + (heroAt + 1) + ' 位）：' + seq1.join(','));
      }
      // 回读 data.json（磁盘）——"内存写了、盘上没写"是本项目最著名的那类坑
      const disk1 = await disk();
      if (!disk1 || !Array.isArray(disk1.order)) note('data.json 里没有 homeBlocks.order（拖序没落盘？）');
      else {
        const head = disk1.order.slice(0, seq1.length).join(',');
        if (head !== seq1.join(',')) note('磁盘 order 前段与可见 DOM 序不一致：disk=' + head + ' ◎ dom=' + seq1.join(','));
        ['fav', 'walk', 'tutorial'].forEach(function (id) {
          if (disk1.order.indexOf(id) < 0) note('落盘 order 里少了隐藏块 ' + id);
        });
      }

      // ── ③ ⋯ 菜单 →「隐藏这块」：块消失 + 落盘 + 通知里给找回的路
      const more = P.q('.kbw-hblock[data-block="recent"] .kbw-hblock-more');
      if (!more) note('recent 块上没有 ⋯ 按钮（"Region 清宿主把工具一起清掉"的形态）');
      else { P.click(more); await P.wait(260); }
      const clicked = P.clickAny('隐藏这块');
      if (!clicked) note('⋯ 菜单里没点着「隐藏这块」');
      await P.wait(700);
      if (P.q('.kbw-hblock[data-block="recent"]')) note('隐藏之后 recent 块还在');
      const disk2 = await disk();
      if (!disk2 || !Array.isArray(disk2.hidden) || disk2.hidden.indexOf('recent') < 0) {
        note('hidden 没落盘（实际 ' + JSON.stringify(disk2 && disk2.hidden) + '）');
      }
      const nt = P.q('.kbw-notices');
      const ntText = nt ? P.text(nt) : '';
      if (ntText.indexOf('已隐藏') < 0) note('没弹「已隐藏」通知（实际：' + ntText.slice(0, 60) + '）');
      else if (ntText.indexOf('设置') < 0) note('通知里没给找回的路（设置 → 首页）');

      // 收尾：偏好拨回基线（这一步没改库文件；残留会让后面步骤的首页形态不对）
      await ctx.settings.save({ homeBlocks: null });
      await P.wait(500);
      return {
        ok: problems.length === 0,
        info: '默认序=' + seq0 + '｜拖后=' + seq1.join(',') + '（hero 在第 ' + (heroAt + 1) + ' 位）' +
              '｜间距 quick→线=' + gapA + ' / 线→待处理=' + gapB +
              '｜工具默认/聚焦 opacity=' + base + '/' + focusOpa + '（真 hover 验不了：合成指针不触发 :hover）' +
              '｜工具让位间隙=' + gapTool + 'px' +
              '｜工具·计数中线差=' + dyAlign + 'px' +
              '｜隐藏落盘=' + JSON.stringify(disk2 && disk2.hidden) +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2b · 图谱卡：真拖保活（拖后 canvas 不归零）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome) { P.click(navHome); await P.wait(800); }
      if (!P.q('.kbw-home')) return { ok: false, info: '没进首页' };

      // 核心图谱插件关着 → 整卡自隐，本步无对象：如实报，不算红
      const ip = app.internalPlugins && app.internalPlugins.plugins && app.internalPlugins.plugins.graph;
      if (!(ip && ip.enabled)) return { ok: true, info: '「图谱」核心插件关着 —— 本步跳过（卡片自隐，无对象可拖）' };

      // 记一份家底：收尾原样还回去（探针纪律：动过的偏好要拨回）
      const diskHB = async function () {
        try {
          const raw = await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json');
          return JSON.parse(raw).homeBlocks;
        } catch (e) { return undefined; }
      };
      const hb0 = await diskHB();

      // 夹具：让图谱卡出场（其余维持默认显隐）
      await ctx.settings.save({ homeBlocks: { order: ['hero','quick','todo','recent','graphlink','foot','fav','walk','tutorial','homeCards'], hidden: ['fav','walk','tutorial','homeCards'] } });
      await P.wait(2600);

      const box = P.q('.kbw-hblock[data-block="graphlink"]');
      const stage = box && box.querySelector('.kbw-hgraph-stage');
      const cv0 = stage && stage.querySelector('canvas');
      if (!box || !stage || !cv0) {
        await ctx.settings.save({ homeBlocks: hb0 === undefined ? null : hb0 });
        return { ok: false, info: '图谱卡没挂上（核心开着却没 canvas —— 看卡里的 .kbw-hgraph-fail 说明）' };
      }
      const w0 = cv0.width, h0 = cv0.height;
      if (!(w0 > 0 && h0 > 0)) note('前提不成立：拖动前 canvas 就是 ' + w0 + '×' + h0);

      // 拖它自己（走真实指针路径）：拖柄 → 过阈值 → 往**上**挪 260px（落进上一块的地界，保证真换位）→ 松手
      // ⚠️ 不用"另一个块的 rect 当落点"：卡片滚到视野中央时相邻块可能在视野外（首跑就栽在这）。
      const grip = P.q('.kbw-hblock[data-block="graphlink"] .kbw-hblock-grip');
      const g = grip ? P.aimAt(grip) : null;
      const seqOf = function () {
        return P.qa('.kbw-hblock').map(function (b) { return b.dataset.block || ''; }).filter(Boolean).join(',');
      };
      const seq0 = seqOf();
      const ty = g ? Math.max(40, Math.round(g.y - 260)) : NaN;
      if (!g || !g.visible) note('拖柄不在视野里');
      else if (!Number.isFinite(ty)) note('落点 y 不是有限值（rect 拿错？）');
      else {
        P.pointerDownAt(g.x, g.y, 'mouse');
        await P.wait(40);
        P.pointerMoveTo(g.x + 24, g.y + 6, 'mouse');
        await P.wait(160);
        if (!P.q('.kbw-hgap')) note('拖动中没有空位（.kbw-hgap）');
        P.pointerMoveTo(g.x + 24, ty, 'mouse');
        await P.wait(220);
        P.pointerUpAt(g.x + 24, ty, 'mouse');
        await P.wait(1400);
        const seq1 = seqOf();
        if (seq1 === seq0) note('落点没换位（gap 没挪动）——这一步没测到"真移动"');
      }

      /**
       * 判据：拖后 canvas 在世、尺寸回来（双边：>0 且约等于卡面 css 尺寸）。
       * 坏态的形状（P7.2b 立案时真机取证）：移动 DOM → 图谱 iframe 重建 →
       * 平台当场量尺寸，那一刻原块若还是 display:none 就量到 0×0、空白定格。
       */
      const box2 = P.q('.kbw-hblock[data-block="graphlink"]');
      const stage2 = box2 && box2.querySelector('.kbw-hgraph-stage');
      const cv = stage2 && stage2.querySelector('canvas');
      let info = 'canvas 没量到';
      if (!cv) note('拖后图谱卡里连 canvas 都没了');
      else {
        const w = cv.width, h = cv.height;
        const cw = stage2.clientWidth, ch = stage2.clientHeight;
        if (!(w > 0 && h > 0)) note('拖后 canvas 归零（' + w + '×' + h + '）——iframe 重载量到 0 的回归');
        else if (Math.abs(w - cw) > 2 || Math.abs(h - ch) > 2) note('拖后 canvas ' + w + '×' + h + ' 与卡面 ' + cw + '×' + ch + ' 不符');
        info = 'canvas=' + w + '×' + h + '（卡面 ' + cw + '×' + ch + '）';
        /**
         * 画面里还得有东西：借渲染器自己的截图口（坏态 0×0 时它自己会抛）。
         * 数"与左上角底色不同的像素"，下限 500（干净态实测 ~9.5k）。
         */
        try {
          const r = stage2.kbwGraphView && stage2.kbwGraphView.renderer;
          const shot = r && r.getBackgroundScreenshot ? r.getBackgroundScreenshot() : null;
          if (!(shot instanceof HTMLCanvasElement)) note('拿不到图谱截图（renderer 口变了？）');
          else {
            const c2 = document.createElement('canvas');
            c2.width = Math.max(1, shot.width); c2.height = Math.max(1, shot.height);
            const x2 = c2.getContext('2d');
            x2.drawImage(shot, 0, 0);
            const dd = x2.getImageData(0, 0, c2.width, c2.height).data;
            const bg = dd[0] + ',' + dd[1] + ',' + dd[2];
            let diff = 0;
            for (let i = 0; i < dd.length; i += 4) {
              if (dd[i] + ',' + dd[i+1] + ',' + dd[i+2] !== bg) diff += 1;
            }
            if (diff < 500) note('拖后图谱是空画面（异色像素只有 ' + diff + '）');
            info += '· 画面异色像素=' + diff;
          }
        } catch (e) {
          note('拖后图谱截图直接抛（典型坏态）：' + (e && e.message ? e.message : e));
        }
      }

      // 收尾：家底还回去
      await ctx.settings.save({ homeBlocks: hb0 === undefined ? null : hb0 });
      await P.wait(600);
      return {
        ok: problems.length === 0,
        info: '拖前=' + w0 + '×' + h0 + '｜' + info + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2a · 三新模块：收藏夹（真机行）/ 随机漫步换一批 / 教程卡 → 教程中心（展开第一篇）',
    shot: 'P7.2a-home-blocks.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      const problems = [];
      const note = (m) => problems.push(m);
      const NJ = String.fromCharCode(10);
      P.closeAll(4);
      await P.wait(400);
      const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome) { P.click(navHome); await P.wait(800); }
      if (!P.q('.kbw-home')) return { ok: false, info: '没进首页' };

      /**
       * 摆展示态：三块全开（截图要的就是这一屏；偏好还原在下一步）。
       * P7.2d：注册表长到 10 块 —— 图谱卡 / 钉住的笔记显式写进 hidden
       *（不写的话 resolve 会把它们接进 order 末尾并画出来，这一屏的展示态就飘了）。
       */
      await ctx.settings.save({ homeBlocks: { order: ['hero', 'quick', 'todo', 'recent', 'foot', 'fav', 'walk', 'tutorial', 'graphlink', 'homeCards'], hidden: ['graphlink', 'homeCards'] } });
      await P.wait(700);

      // M1 收藏夹：造一篇带 收藏: true 的夹具（名字带标记，兜底清场收得走）
      const kb = ctx.settings.kbRoot();
      const favRel = kb + '/00_Inbox/__探针收藏.md';
      if (!app.vault.getAbstractFileByPath(favRel)) {
        await app.vault.create(favRel, ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中',
          '创建日期: 2026-10-03', 'tags: []', '收藏: true', '---', '# 探针收藏'].join(NJ) + NJ);
      }
      await P.wait(1300);
      const favBox = P.q('.kbw-hblock[data-block="fav"]');
      if (!favBox) note('收藏夹块没画出来');
      else {
        if (favBox.hidden) note('有收藏却还自隐着（等索引？）');
        if (P.text(favBox).indexOf('探针收藏') < 0) note('收藏夹里没有那篇 __探针收藏');
      }

      // M4 随机漫步：3 行；「换一批」= **图标按钮**（P7.11 · #7b），行数不变 + 三行真换
      const walkBox = P.q('.kbw-hblock[data-block="walk"]');
      if (!walkBox) note('随机漫步块没画出来');
      else {
        const n0 = P.qa('.kbw-hblock[data-block="walk"] .kbw-rec').length;
        if (n0 !== 3) note('随机漫步该 3 行（实际 ' + n0 + '）');
        const refresh = P.q('.kbw-hblock[data-block="walk"] .kbw-walk-refresh');
        if (!refresh) note('随机漫步没有「换一批」');
        else {
          if (refresh.tagName !== 'BUTTON' || refresh.className.indexOf('kbw-iconbtn') < 0) {
            note('「换一批」该是图标按钮（kbw-iconbtn），实际 ' + refresh.tagName + '.' + refresh.className);
          }
          if ((refresh.getAttribute('aria-label') || '') !== '换一批') {
            note('「换一批」的 aria-label 不对：' + refresh.getAttribute('aria-label'));
          }
          const before = P.qa('.kbw-hblock[data-block="walk"] .kbw-rec')
            .map(function (r) { return P.text(r); }).join('|');
          P.click(refresh);
          await P.wait(250);
          const n1 = P.qa('.kbw-hblock[data-block="walk"] .kbw-rec').length;
          if (n1 !== 3) note('换一批之后行数变了：' + n0 + ' → ' + n1);
          const after = P.qa('.kbw-hblock[data-block="walk"] .kbw-rec')
            .map(function (r) { return P.text(r); }).join('|');
          if (before === after) note('换一批之后三行没变（同种子？）—— ' + after);
        }
      }

      /**
       * ⚠️ **P7.2d 起教程卡 = 新手清单，全勾会退休自隐** —— 而探针**前面的步骤本身就是真实动作**
       *（搜索输入 / 切视图 / 快捕建笔记……），跑着跑着「动作点」就攒满、卡片当场退休
       *（P7.2d 全量实测红过一次：本步"教程卡上没有「看教程」"）。
       * 这里先对角：**在退休态（或块莫名不画）就先收旗标让它出场**；收完仍不画 = 真问题，照旧红。
       * 跑完**不还原**（沙盒里这排旗标本来就是探针动作攒的；收尾步会把它归零）。
       */
      const tutState = ctx.settings.get();
      const tutRetired = tutState.wizardDone === true && !!tutState.onboarding &&
        ['created', 'view', 'search'].every(function (k) { return tutState.onboarding.indexOf(k) >= 0; });
      if (tutRetired) {
        await ctx.settings.save({ onboarding: null });
        await P.wait(700);
      }
      // M8 教程卡 →「看教程」应把设置面板开到「帮助」栏、并**自动展开教程第一篇**（P7.2b 改的落点）
      const tutBox = P.q('.kbw-hblock[data-block="tutorial"]');
      let panelOk = false;
      let tutOpen = false;
      if (!tutBox) note('教程卡片没画出来');
      else {
        const b = P.qa('.kbw-hblock[data-block="tutorial"] button').find(function (x) { return P.text(x).indexOf('看教程') >= 0; });
        if (!b) note('教程卡上没有「看教程」');
        else {
          P.click(b);
          await P.wait(900);
          /**
           * ⚠️ **认最后一扇设置面板**（多个模态叠加时取最后一个 —— 坑单里那条老规矩）：
           * 按裸选择器找「.kbw-set-tab」会命中**先开的那扇**（它的 help 页签不是 on）→
           * 假红了一次（2026-10-03 真机首跑）。
           */
          const shells = P.qa('.kbw-set-shell');
          const shell = shells[shells.length - 1];
          const tabHelp = shell ? P.q('.kbw-set-tab[data-section="help"]', shell) : null;
          panelOk = !!shell && !!tabHelp && tabHelp.classList.contains('is-on');
          if (!panelOk) note('「看教程」没把设置面板开到帮助栏');
          // P7.2b：落点从"帮助栏"改到**教程中心第一篇**（打开即展开）—— 2a 留的口子销账
          const firstCard = shell ? P.q('.kbw-tut-card', shell) : P.qa('.kbw-tut-card')[0];
          tutOpen = !!firstCard && firstCard.classList.contains('is-open');
          if (panelOk && !tutOpen) note('「看教程」没有自动展开教程第一篇（P7.2b 的落点）');
        }
      }
      // 关面板 —— 截图（脚本返回后拍）要拍三块同屏的展示态
      P.key('Escape');
      await P.wait(500);
      /**
       * 🔴 **把三块滚进视野再返回**：截图是脚本返回之后拍的 —— 第一版拍到的
       * 是页面上半（hero/待处理/最近改动），fav/walk/tutorial 全在视口外
       *（收藏夹那张截图等于没拍到）。block:"end" = tutorial 的底对齐视口底，
       * 三块（各 ~150px）一起进来。
       */
      const tutEl = P.q('.kbw-hblock[data-block="tutorial"]');
      if (tutEl) tutEl.scrollIntoView({ block: 'end' });
      await P.wait(450);

      return {
        ok: problems.length === 0,
        info: '收藏夹=' + (favBox && !favBox.hidden ? '有行' : '空') +
              '｜漫步=' + P.qa('.kbw-hblock[data-block="walk"] .kbw-rec').length + ' 行｜教程→帮助栏=' + panelOk + '（展开第一篇=' + tutOpen + '）' +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2a · 收尾还原：homeBlocks 回基线 null + 收走 __探针收藏夹具',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      await ctx.settings.save({ homeBlocks: null });
      await P.wait(500);
      const kb = ctx.settings.kbRoot();
      const favRel = kb + '/00_Inbox/__探针收藏.md';
      const f = app.vault.getAbstractFileByPath(favRel);
      if (f) await app.vault.delete(f, true);
      await P.wait(500);
      // 视线切回首页（收尾把视线切回去 —— 1b 的教训）
      const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome) { P.click(navHome); await P.wait(500); }
      // 真判据（不降级成"永远通过"）：磁盘回 null + 默认五块 + 夹具真没了
      let diskOk = false;
      try {
        const raw = await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json');
        diskOk = JSON.parse(raw).homeBlocks === null;
      } catch (e) { diskOk = false; }
      const seq = P.qa('.kbw-hblock').map(function (b) { return b.dataset.block || ''; }).filter(Boolean).join(',');
      const gone = !app.vault.getAbstractFileByPath(favRel);
      const okAll = diskOk && seq === 'hero,quick,todo,recent,foot' && gone;
      return {
        ok: okAll,
        info: '磁盘 homeBlocks=' + diskOk + '｜回归序=' + seq + '｜夹具已收=' + gone +
              (okAll ? ' ｜还原完成 ✓' : ' ｜⚠️ 还原不完全'),
      };
    })()`,
  },

  /* ══════════════════════════════════════════════════════════════════
     P7.2c · 全局手感（快捕/剪藏 · 丢进板块 · 菜单收起 · 小窗三件）
     —— 都排在 P7.2a 收尾之后、全库迁移（最后那步）之前
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.2c · 快速捕获：新文案 + 「直接选目录」真机一条 + 收走夹具',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(350);
      ctx.quickCapture();
      await P.wait(900);
      const modal = P.lastModal();
      if (!modal) return { ok: false, info: '快速捕获面板没开出来' };
      const head = P.text(modal);
      if (head.indexOf('不离开你手头的事') < 0) note('副标题不是新文案（旧句还在？）');
      const sel = P.q('[data-capture="target"]', modal);
      const groups = sel ? P.qa('optgroup', sel).map((g) => g.getAttribute('label')) : [];
      if (groups.indexOf('直接选目录') < 0) note('下拉里没有「直接选目录」组（实际：' + groups.join('/') + '）');
      const opts = sel ? Array.from(sel.querySelectorAll('option')) : [];
      const dirOpt = opts.find((o) => (o.value || '').indexOf('dir:') === 0);
      if (!dirOpt) note('没有 dir: 前缀的目录候选');
      /** 真丢一条到 00_Inbox（目录组那一支）—— 落完连夹具一起收走 */
      let landed = false;
      let noticeOk = false;
      if (dirOpt) {
        const kb = ctx.settings.kbRoot();
        const rel = kb + '/00_Inbox/__探针快捕.md';
        const old = app.vault.getAbstractFileByPath(rel);
        if (old) { await app.vault.delete(old, true); await P.wait(300); }
        const title = P.q('[data-capture="title"]', modal);
        title.value = '__探针快捕';
        sel.value = 'dir:00_Inbox';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const go = P.btnByText('丢一条', modal);
        if (!go) note('找不到「丢一条」按钮');
        else { P.click(go); await P.wait(1500); }
        landed = !!app.vault.getAbstractFileByPath(rel);
        if (!landed) note('那条没落进 00_Inbox');
        else {
          const notices = P.qa('.kbw-notice').map((n) => P.text(n));
          noticeOk = notices.some((t) => t.indexOf('已丢进') >= 0 && t.indexOf('落在') >= 0);
          if (!noticeOk) note('通知没说清落点：' + notices.join(' / '));
        }
        const f = app.vault.getAbstractFileByPath(rel);
        if (f) await app.vault.delete(f, true);
        await ctx.settings.save({ lastCapture: null });
        await P.wait(400);
      }
      P.closeAll(4);
      await P.wait(250);
      return {
        ok: problems.length === 0,
        info: '文案=' + (head.indexOf('不离开你手头的事') >= 0 ? '新句 ✓' : '旧句 ✗') +
              '｜下拉组=' + groups.join('/') + '｜目录候选=' + (dirOpt ? dirOpt.value : '无') +
              '｜真落盘=' + landed + '｜通知报落点=' + noticeOk +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2c · 剪藏：真机抓一条真实链接（example.com）→ 抓取态/标题/来源 + 收走',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      const kb = ctx.settings.kbRoot();
      const URL = 'https://example.com/';
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(350);
      const before = app.vault.getFiles().map((f) => f.path);
      ctx.quickCapture();
      await P.wait(900);
      const modal = P.lastModal();
      if (!modal) return { ok: false, info: '快速捕获面板没开出来' };
      const link = P.q('[data-capture="link"]', modal);
      const title = P.q('[data-capture="title"]', modal);
      if (!link || !title) return { ok: false, info: '面板里没有链接行' };
      link.value = URL;
      link.dispatchEvent(new Event('input', { bubbles: true }));
      /** 防抖 400ms + 抓取（上限 8s，留点余量） */
      await P.wait(9000);
      const statusEl = P.q('[data-capture="status"]', modal);
      const status = statusEl ? P.text(statusEl) : '';
      const gotOk = status.indexOf('已抓到') >= 0;
      const gotBad = status.indexOf('没抓到') >= 0;
      /**
       * ⚠️ **网络不可达不算产品红**（Q1 定稿里说好的）：降级路径本身也是要验的行为 ——
       * 如实报在 info 里，判据落在"降级也照落一条、来源照记"上。
       */
      if (P.text(modal).indexOf('剪藏固定') < 0) note('粘上链接后没切到「剪藏固定」的静态落点行');
      const go = P.btnByText(gotOk ? '剪藏' : '只存链接', modal);
      if (!go) return { ok: false, info: '主按钮没按档位改名（status=' + status + '）' };
      const titleNow = title.value;
      P.click(go);
      await P.wait(1800);
      /** 收走：找"这次新出现、且写着这条 URL"的那一篇 */
      let found = false;
      let content = '';
      for (const f of app.vault.getFiles()) {
        if (before.indexOf(f.path) >= 0) continue;
        const c = await app.vault.read(f);
        if (c.indexOf(URL) >= 0) { content = c; await app.vault.delete(f, true); found = true; break; }
      }
      if (!found) note('没找到剪藏落下来的那篇（抓取=' + (gotOk ? '成功' : gotBad ? '降级' : '未知') + '）');
      else {
        if (content.indexOf('来源') < 0) note('正文里没有「来源」属性');
        if (gotOk) {
          if (titleNow !== 'Example Domain') note('标题没自动改成网页标题（实际 ' + titleNow + '）');
          if (content.indexOf('[' + titleNow + '](' + URL + ')') < 0) note('正文首行没有原链接');
          if (content.indexOf('Example Domain') < 0) note('正文没剥到网页文本');
          const notice = P.qa('.kbw-notice').map((n) => P.text(n)).join(' / ');
          if (notice.indexOf('已剪藏') < 0) note('成功通知没出现：' + notice);
        } else {
          const notice = P.qa('.kbw-notice').map((n) => P.text(n)).join(' / ');
          if (notice.indexOf('没抓到正文') < 0 && notice.indexOf('只存了') < 0) note('降级通知没如实说：' + notice);
        }
      }
      await ctx.settings.save({ lastCapture: null });
      await P.wait(500);
      P.closeAll(4);
      return {
        ok: problems.length === 0,
        info: '抓取=' + (gotOk ? '成功' : gotBad ? '降级（网络不可达？如实走降级）' : '未知：' + status) +
              '｜标题=' + titleNow + '｜来源/链接在=' + (content.indexOf(URL) >= 0) + '｜夹具已收=' + found +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2c · 丢进板块：夹具右键「改 → 丢进板块」→ 真点一个目标 → 真生效 → 收走',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      const kb = ctx.settings.kbRoot();
      const NJ = String.fromCharCode(10);
      const rel = kb + '/00_Inbox/__探针丢板块.md';
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      const old = app.vault.getAbstractFileByPath(rel);
      if (old) { await app.vault.delete(old, true); await P.wait(250); }
      await app.vault.create(rel, ['---', '类型: 想法', '领域: 灵感杂记', '状态: 待整理',
        '创建日期: 2026-10-04', 'tags: []', '---', '# 探针丢板块'].join(NJ) + NJ);
      await P.wait(900);
      ctx.goNotes({ dir: '00_Inbox' });
      await P.wait(700);
      await P.useView('详细信息');
      await P.wait(400);
      const row = P.rowByPath(rel);
      if (!row) return { ok: false, info: '夹具没进表格：' + rel };
      const c = P.center(row);
      P.rightClickAt(c.x, c.y);
      await P.wait(450);
      const menu = P.q('.kbw-menu');
      if (!menu) return { ok: false, info: '行菜单没开' };
      if (P.text(menu).indexOf('丢进板块') >= 0) note('「丢进板块」摊在一级了（该收在「改」组里）');
      if (!P.clickMenu('改', menu)) return { ok: false, info: '「改」组点不开' };
      await P.wait(350);
      if (!P.clickMenu('丢进板块', P.lastMenu())) note('「改」组里没有「丢进板块」');
      await P.wait(350);
      const cast = P.lastMenu();
      const items = cast ? P.qa('.kbw-menu-item', cast) : [];
      let action = '';
      let picked = null;
      for (const it of items) {
        const t = P.text(it);
        if (t.indexOf('加标签') >= 0) { action = 'tag'; picked = it; break; }
      }
      if (!picked) {
        for (const it of items) {
          if (P.text(it).indexOf('改属性') >= 0) { action = 'prop'; picked = it; break; }
        }
      }
      const texts = items.map((i) => P.text(i));
      if (!picked) { picked = items[0] || null; action = picked ? 'folder' : ''; }
      if (!picked) return { ok: false, info: '丢进板块子菜单是空的' };
      const beforeText = await app.vault.read(app.vault.getAbstractFileByPath(rel));
      const pickedText = P.text(picked);
      P.click(picked);
      await P.wait(1500);
      /** 真生效 = 文件内容变了（tag/prop 两类都写前言）；folder 类会搬家 —— 按名字找 */
      let after = app.vault.getAbstractFileByPath(rel);
      if (!after) {
        after = app.vault.getFiles().find((f) => f.basename === '__探针丢板块') || null;
      }
      let changed = false;
      let landedAt = '';
      if (after) {
        landedAt = after.path;
        const afterText = await app.vault.read(after);
        /** folder 类会**搬家**（文件内容一字不变）——"生效" = 内容变了**或**路径变了（首跑就栽在只看内容上） */
        changed = afterText !== beforeText || landedAt !== rel;
      }
      if (!changed) note('点了「' + pickedText + '」但文件没变（' + action + '）');
      if (after) await app.vault.delete(after, true);
      await P.wait(400);
      return {
        ok: problems.length === 0,
        info: '子菜单项=' + texts.length + '（' + texts.slice(0, 5).join('｜') + '）｜动手=' + action +
              '（' + pickedText + '）｜真生效=' + changed + '｜落在=' + (landedAt || '（没找到）') +
              '｜夹具已收=' + !app.vault.getAbstractFileByPath(landedAt || rel) +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2c · 菜单收起：指针离开 300ms 收（触屏/键盘不动）· 只收子菜单不收整条',
    shot: 'P7.2c-菜单收起.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(300);
      const navBoard = P.qa('.kbw-navitem').find((b) => P.text(b).indexOf('看板') >= 0);
      if (navBoard) { P.click(navBoard); await P.wait(900); }
      const card = P.q('.kbw-card');
      if (!card) return { ok: false, info: '看板上没有卡片可右键' };
      const subs = () => P.qa('.kbw-menu.is-sub').length;
      const root = () => P.q('.kbw-menu:not(.is-sub)');
      const openByClick = async () => {
        P.closeAll(4);
        await P.wait(300);
        const c = P.center(card);
        P.rightClickAt(c.x, c.y);
        await P.wait(450);
        if (!P.clickMenu('改', P.q('.kbw-menu'))) return false;
        await P.wait(350);
        return !!P.q('.kbw-menu.is-sub');
      };
      /** ① 鼠标离开整条链 → 480ms 后：子菜单收掉、**整条菜单还在** */
      if (!(await openByClick())) return { ok: false, info: '打不开「改」子菜单（前提不成立）' };
      root().dispatchEvent(P.mkPointer('pointerleave', 900, 700, 'mouse'));
      await P.wait(480);
      const afterLeave = subs();
      const menuAlive = !!root();
      if (afterLeave !== 0) note('鼠标移开 480ms 后子菜单还在');
      if (!menuAlive) note('整条菜单也被收了（只该收子菜单）');
      /** ② 触屏：pointerleave(touch) 不算离开 */
      if (!(await openByClick())) return { ok: false, info: '第二轮「改」子菜单打不开' };
      root().dispatchEvent(P.mkPointer('pointerleave', 900, 700, 'touch'));
      await P.wait(480);
      const touchKept = subs() === 1;
      if (!touchKept) note('触屏的 pointerleave 把子菜单收了（不该）');
      /** ③ 键盘路径：新开一条菜单，ArrowDown→ArrowRight 开子菜单，**不会被 300ms 误收**（没人派指针事件） */
      P.closeAll(4);
      await P.wait(300);
      const c2 = P.center(card);
      P.rightClickAt(c2.x, c2.y);
      await P.wait(450);
      P.key('ArrowDown');
      await P.wait(150);
      P.key('ArrowRight');
      await P.wait(450);
      const kbdKept = subs() === 1;
      if (!kbdKept) note('键盘开着子菜单 → 450ms 后没了（"移开收起"不该碰键盘路径）');
      P.key('ArrowLeft');
      await P.wait(250);
      const kbdClosed = subs() === 0;
      if (!kbdClosed) note('ArrowLeft 没退掉子菜单');
      P.closeAll(4);
      await P.wait(250);
      /** 截图态：把「改 → 丢进板块」展开留着（返回之后拍） */
      await openByClick();
      await P.wait(250);
      return {
        ok: problems.length === 0,
        info: '鼠标离开后子菜单=' + afterLeave + '（该 0）｜整条菜单还在=' + menuAlive +
              '｜触屏离开后还在=' + touchKept + '｜键盘开=不误收=' + kbdKept + '、ArrowLeft 退=' + kbdClosed +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2c · 小窗：双击标题栏最大化 ⇄ 还原（量 .kbw-root）+ 拖缩后 panelGeo 落盘 + 点击置顶',
    shot: 'P7.2c-小窗.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      const problems = [];
      const note = (m) => problems.push(m);
      const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 3 : tol);
      P.closeAll(4);
      await P.wait(300);
      const navBoard = P.qa('.kbw-navitem').find((b) => P.text(b).indexOf('看板') >= 0);
      if (navBoard) { P.click(navBoard); await P.wait(900); }
      const card = P.q('.kbw-card');
      if (!card) return { ok: false, info: '看板上没有卡片可点' };
      P.click(card);
      await P.wait(900);
      const panels = P.qa('.kbw-cw-panel');
      if (panels.length === 0) return { ok: false, info: '点卡片没开小窗' };
      const panel = panels[panels.length - 1];
      const head = P.q('.kbw-panel-head', panel);
      const rootEl = P.q('.kbw-root');
      if (!head || !rootEl) return { ok: false, info: '小窗头 / 工作台根没找到' };
      const rootRect = rootEl.getBoundingClientRect();
      const pre = panel.getBoundingClientRect();
      /**
       * 🔴 **双击要打在"真鼠标点得到、且过得了守卫"的位置上**（独立审 🟡7c）：
       * 直接往 head 派 dblclick 的 target 就是 head 本身，绕过了
       * 「closest(button, input, select, a)」守卫、也没过命中测试 ——
       * 而小窗的标题本身就是输入框，真正"双击得到的非控件区"只剩几条窄边。
       * 这里用 elementFromPoint 在头上扫一处合法落点；一处都找不到就**报出来**。
       */
      const findHeadSpot = () => {
        const hr = head.getBoundingClientRect();
        for (let fx = 0.02; fx <= 0.98; fx += 0.02) {
          const x = Math.round(hr.left + hr.width * fx);
          const y = Math.round(hr.top + hr.height / 2);
          const el = document.elementFromPoint(x, y);
          if (el && head.contains(el) && !el.closest('button, input, select, a')) return { x: x, y: y, el: el };
        }
        return null;
      };
      const dblclickAtSpot = (spot) => {
        if (!spot) return;
        spot.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: spot.x, clientY: spot.y, view: window }));
      };
      const spot1 = findHeadSpot();
      if (!spot1) note('头上找不到"非控件"的可双击点（守卫会把真鼠标双击全挡掉）');
      dblclickAtSpot(spot1);
      await P.wait(500);
      const max = panel.getBoundingClientRect();
      const fills = near(max.left, rootRect.left) && near(max.top, rootRect.top) &&
        near(max.width, rootRect.width) && near(max.height, rootRect.height);
      if (!fills) note('最大化没铺满工作台：窗=' + [max.left, max.top, max.width, max.height].map(Math.round).join(',') +
        ' 工作台=' + [rootRect.left, rootRect.top, rootRect.width, rootRect.height].map(Math.round).join(','));
      dblclickAtSpot(findHeadSpot());
      await P.wait(500);
      const back = panel.getBoundingClientRect();
      const restored = near(back.left, pre.left) && near(back.top, pre.top) && near(back.width, pre.width) && near(back.height, pre.height);
      if (!restored) note('再双击没还原到原几何：' + JSON.stringify({ back: [back.left, back.top, back.width], pre: [pre.left, pre.top, pre.width] }));
      /**
       * 拖缩（缩放手柄）**结束**那一下 → panelGeo 落盘。
       * ⚠️ 不用头拖：小窗标题就是输入框、头中心落在它身上会被"别抢控件"守卫拦掉（演成"拖不动"）。
       */
      const grip = P.q('.kbw-panel-grip', panel);
      if (!grip) note('小窗没有缩放手柄');
      else {
        const gc = P.center(grip);
        await P.dragMouse({ x: gc.x, y: gc.y }, { x: gc.x + 80, y: gc.y + 60 });
        await P.wait(900);
        let geo = null;
        try {
          const raw = await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json');
          geo = JSON.parse(raw).panelGeo;
        } catch (e) { geo = null; }
        if (!geo) note('拖缩结束之后 panelGeo 没落盘');
        else {
          const r2 = panel.getBoundingClientRect();
          const geoOk = near(geo.x, r2.left, 6) && near(geo.y, r2.top, 6) && near(geo.w, r2.width, 6) && near(geo.h, r2.height, 6);
          if (!geoOk) note('panelGeo 与实际几何对不上：' + JSON.stringify(geo) + ' vs ' + [r2.left, r2.top, r2.width, r2.height].map(Math.round).join(','));
        }
      }
      /** 点击置顶：再开第二扇 → 在第一扇身上按一下 → 第一扇排到最上（DOM 末尾） */
      let topOk = null;
      const card2 = P.qa('.kbw-card')[1];
      if (card2) {
        P.click(card2);
        await P.wait(900);
        const all = P.qa('.kbw-cw-panel');
        const first = all[0];
        const bodyEl = P.q('.kbw-panel-body', first) || first;
        const pt = P.center(bodyEl);
        first.dispatchEvent(P.mkPointer('pointerdown', pt.x, pt.y, 'mouse'));
        await P.wait(300);
        const after = P.qa('.kbw-cw-panel');
        topOk = after[after.length - 1] === first;
        if (!topOk) note('点第一扇之后它没排到 DOM 末尾（没置顶）');
      } else {
        topOk = '（只有一张卡，跳过）';
      }
      /** 收干净 → 重开一扇、最大化着留给截图（返回之后拍） */
      P.closeAll(6);
      await P.wait(500);
      const cardA = P.q('.kbw-card');
      if (cardA) {
        P.click(cardA);
        await P.wait(900);
        const ps = P.qa('.kbw-cw-panel');
        const keep = ps[ps.length - 1];
        if (keep) {
          const h2 = P.q('.kbw-panel-head', keep);
          h2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          await P.wait(500);
        }
      }
      /** 界面偏好拨回去（探针不留 panelGeo —— 与 homeBlocks 收尾同一条纪律） */
      await ctx.settings.save({ panelGeo: null });
      await P.wait(300);
      return {
        ok: problems.length === 0,
        info: '最大化铺满=' + fills + '｜还原=' + restored + '｜点击置顶=' + topOk +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },

  /* ══════════════════════════════════════════════════════════════════
     P7.2d · 首页卡片批（16.9 图谱卡/钉住的笔记/最近改动桥 ＋ 16.13 新手清单）
     —— 展示态留给截图；偏好还原在**下一步**（P7.2a 收尾那条同款）
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.2d · 首页卡片：图谱卡真渲染 / 钉住的笔记 B 档（✕=取消钉、窗不退）/ 最近改动→小窗 / 新手清单',
    shot: 'P7.2d-home-cards.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = function (m) { problems.push(m); };
      P.closeAll(4);
      await P.wait(400);
      // 切模块一律点导航项（老账：store.set 会被设置落盘顶回去）
      const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome) { P.click(navHome); await P.wait(800); }
      if (!P.q('.kbw-home')) return { ok: false, info: '没进首页' };

      // 展示态：只留三块（图谱卡 / 钉住的笔记 / 新手清单）
      const ALL = ['hero', 'quick', 'todo', 'recent', 'foot', 'fav', 'walk', 'tutorial', 'graphlink', 'homeCards'];
      const keep = ['graphlink', 'homeCards', 'tutorial'];
      const hideAllBut = function (keepIds) {
        return ctx.settings.save({ homeBlocks: { order: ALL, hidden: ALL.filter(function (x) { return keepIds.indexOf(x) < 0; }) } });
      };
      await hideAllBut(keep);

      // 钉两篇真笔记（只写 data.json，不动库）
      const picks = ctx.index.notes().filter(function (n) {
        return n.path.indexOf('99_Meta') < 0 && n.path.indexOf('02_旧知识库') < 0;
      }).slice(0, 2).map(function (n) { return n.path; });
      if (picks.length < 2) note('库里的普通笔记不足两篇，钉选判据打折');
      await ctx.settings.save({ homeCards: picks });
      await P.wait(1400);

      // ① 图谱卡：真挂 + 过滤注入（与图谱模块同一套 mountGraphInto）
      const gbox = P.q('.kbw-hblock[data-block="graphlink"]');
      if (!gbox) note('图谱卡没画出来');
      else {
        if (gbox.hidden) note('图谱卡自隐了（核心插件开着却自隐？）');
        const stage = P.q('.kbw-hgraph-stage', gbox);
        const gv = stage && stage.kbwGraphView;
        if (!gv) note('图谱裸叶没挂上（stage.kbwGraphView 缺席）');
        else {
          /**
           * ⚠️ 真机形状（P7.2d 首跑取证，别再猜）：searchQueries 项是
           * { query: { query: 字符串, app: 圆形引用... }, color } —— 直接 JSON.stringify
           * 会炸（Converting circular structure to JSON），所以逐层取串 + try/catch。
           * **主判据用 fileFilter**（路径 → boolean）——它直接说"这些文件被排掉了"，
           * 比读查询串更贴近"过滤到底生效没有"（串只是输入，fileFilter 是结果）。
           */
          const de = gv.dataEngine || {};
          let qs = '';
          try {
            qs = (de.searchQueries || []).map(function (x) {
              const inner = x && x.query;
              if (inner && typeof inner.query === 'string') return inner.query;
              return typeof inner === 'string' ? inner : '';
            }).join(' ');
          } catch (e) { qs = ''; }
          let ffSaysExcluded = null;
          try {
            const ff = de.fileFilter || {};
            const oldKb = Object.keys(ff).filter(function (k) { return k.indexOf('02_旧知识库') >= 0; });
            if (oldKb.length > 0) ffSaysExcluded = oldKb.every(function (k) { return ff[k] === false; });
          } catch (e) { ffSaysExcluded = null; }
          if (de.hasFilter !== true) note('图谱过滤没注入（hasFilter 不为真）');
          else if (ffSaysExcluded === false) note('fileFilter 里旧库文件没被排掉（过滤没生效）');
          else if (ffSaysExcluded === null && qs.indexOf('02_旧知识库') < 0) {
            note('既读不到 fileFilter 的旧库条目、查询串里也没有排除——过滤去哪了？');
          }
        }
        if (stage && !P.q('canvas', stage)) note('图谱画布没有 canvas');
      }

      // ② 钉住的笔记（B 档）：块内真窗 + tab 条 + 真编辑器
      const cbox = P.q('.kbw-hblock[data-block="homeCards"]');
      let win = null;
      if (!cbox) note('钉住的笔记块没画出来');
      else {
        if (cbox.hidden) note('钉了两篇却自隐');
        win = P.q('.kbw-hcard-win .kbw-cw-panel', cbox);
        if (!win) note('B 档：块内没有卡片窗（看板开着）');
        else {
          if (!win.classList.contains('is-docked')) note('内嵌窗不是 .is-docked 档');
          const tabs = P.qa('.kbw-cw-tabs .kbw-cw-tab', cbox);
          if (tabs.length !== picks.length) note('tab 条 ≠ 钉住的篇数（' + tabs.length + ' vs ' + picks.length + '）');
          const cm = P.q('.cm-content', win);
          if (!cm || cm.getAttribute('contenteditable') !== 'true') note('窗里没有可编辑的真编辑器');
          if (P.q('.kbw-iconbtn[aria-label="钉住（点外面不关）"]', win)) note('内嵌窗不该有图钉');
          const footEl = P.q('.kbw-panel-foot', win);
          if (footEl && footEl.getBoundingClientRect().height > 0) note('内嵌窗不该显示底部按钮');
        }
      }

      // ③ ✕ = 取消钉选：钉少一篇、窗**不消失**（"✕ 之后窗闪没"的单次读数盯这一形态）
      let unpinOk = null;
      let pinsBack = null;
      if (win) {
        const xs = P.qa('.kbw-cw-tabx', cbox);
        if (xs.length < 2) note('✕ 不足两枚（tab 条应列两篇）');
        else {
          const xTitle = xs[xs.length - 1].getAttribute('title') || '';
          if (xTitle.indexOf('取消钉选') < 0) note('✕ 的 title 没写"取消钉选"（实际：' + xTitle + '）');
          P.click(xs[xs.length - 1]);
          await P.wait(700);
          const pins = (ctx.settings.get().homeCards || []).length;
          if (pins !== picks.length - 1) note('✕ 之后 homeCards 该少一篇（现在 ' + pins + '）');
          const still = P.q('.kbw-hcard-win .kbw-cw-panel', cbox);
          if (!still) note('✕ 之后窗整个消失了（应该还剩一篇、窗还在）');
          else {
            const tLeft = P.qa('.kbw-cw-tabs .kbw-cw-tab', cbox).length;
            if (tLeft !== 0) note('剩 1 篇时 tab 条该收起（实际还画着 ' + tLeft + ' 枚）');
            unpinOk = true;
          }
          await ctx.settings.save({ homeCards: picks });
          await P.wait(700);
          const back = P.qa('.kbw-cw-tabs .kbw-cw-tab', cbox).length;
          if (back !== picks.length) note('重新钉回之后 tab 没配齐（' + back + '）');
          pinsBack = back === picks.length;
        }
      }

      // ④ 最近改动 → 小窗（桥）：挑一条**没被钉住**的（钉住的那篇会走"抬到最前"那条路）
      await hideAllBut(keep.concat(['recent']));
      await P.wait(800);
      let bridgeOk = null;
      const recs = P.qa('.kbw-hblock[data-block="recent"] .kbw-rec');
      const rec = recs.find(function (r) {
        const n = P.q('.kbw-rec-n', r);
        return n && picks.indexOf(n.getAttribute('title') || '') < 0;
      });
      if (!rec) note('最近改动没有"没被钉住"的行可点（样本太巧了）');
      else {
        const t = rec.getAttribute('title') || '';
        if (t.indexOf('小窗') < 0 || t.indexOf('标签页') < 0) note('最近改动的 title 没写明两种打开方式');
        P.click(rec);
        await P.wait(900);
        const floating = P.qa('.kbw-panel').filter(function (p) { return !p.closest('.kbw-hcard-win'); });
        bridgeOk = floating.length >= 1;
        if (!bridgeOk) note('点最近改动没开出小窗（桥断了？）');
        // 收掉它：点外面（这扇没钉住）
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await P.wait(500);
        const left = P.qa('.kbw-panel').filter(function (p) { return !p.closest('.kbw-hcard-win'); });
        if (left.length > 0) note('小窗没收掉（点外面那一下）');
      }

      // ⑤ 新手清单：四项在（或"已退休"——沙盒里先前的动作可能已经全勾）
      const tbox = P.q('.kbw-hblock[data-block="tutorial"]');
      let tutOk = null;
      if (!tbox) note('新手清单块没画出来');
      else if (tbox.hidden) tutOk = '已退休（全勾过）';
      else {
        const items = P.qa('.kbw-tut-item', tbox);
        if (items.length !== 4) note('新手清单该 4 项（实际 ' + items.length + '）');
        else tutOk = true;
      }

      // 截图留展示态（滚到顶；返回之后拍）
      const home = P.q('.kbw-home');
      if (home) home.scrollIntoView(true);
      await P.wait(500);
      return {
        ok: problems.length === 0,
        info: '图谱卡=' + (gbox && !gbox.hidden ? '挂上' : '✗') +
              '｜钉住的笔记=' + (win ? 'B 档' : '✗') + '（✕收一篇=' + unpinOk + '·钉回复原=' + pinsBack + '）' +
              '｜最近改动→小窗=' + bridgeOk +
              '｜新手清单=' + tutOk +
              (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
  },
  {
    name: 'P7.2d · 收尾还原：homeBlocks / homeCards 回基线 null（磁盘回读）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const app = ctx.app;
      /**
       * ⚠️ onboarding 也归零（P7.2d 全量实测之后加的）：探针跑一轮的过程本身就是
       * 一排"真实动作"（搜索/切视图/快捕），会把新手清单**攒到全勾退休** ——
       * 不归零的话下一轮探针一进来卡片就是退休态（P7.2a 那步曾因此红）。
       * **不动 wizardDone**：那一位另有 P6④ 两步在验（真走/不弹），归零会让它们失据。
       */
      await ctx.settings.save({ homeBlocks: null, homeCards: null, onboarding: null });
      await P.wait(600);
      // 视线切回首页（收尾把视线切回去 —— 1b 的教训）
      const navHome = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (navHome) { P.click(navHome); await P.wait(500); }
      // 块收尾真发生：块内那扇窗的 DOM 不在、真编辑器不悬着
      const leftovers = P.qa('.kbw-cw-panel').filter(function (p) { return !!p.closest('.kbw-hcard-win'); });
      // 真判据（不降级成"永远通过"）：磁盘两键回 null + 默认五块
      let disk = null;
      try {
        const raw = await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json');
        disk = JSON.parse(raw);
      } catch (e) { disk = null; }
      const diskOk = !!disk && disk.homeBlocks === null && disk.homeCards === null && disk.onboarding === null;
      const seq = P.qa('.kbw-hblock').map(function (b) { return b.dataset.block || ''; }).filter(Boolean).join(',');
      const okAll = diskOk && seq === 'hero,quick,todo,recent,foot' && leftovers.length === 0;
      return {
        ok: okAll,
        info: '磁盘 homeBlocks/homeCards/onboarding 回 null=' + diskOk + '｜回归序=' + seq +
              '｜块内残留窗=' + leftovers.length +
              (okAll ? ' ｜还原完成 ✓' : ' ｜⚠️ 还原不完全'),
      };
    })()`,
  },

  /* ══════════════════════════════════════════════════════════════════
     ⚠️ **这一步排在最后**（2026-09-28 挪的，别再挪回去）
     ──────────────────────────────────────────────────────────────────
     它是**全库写操作**：面板里的「全部用推荐值 + 执行」作用在**库里所有待改的笔记**上，
     不是只动它自己造的夹具。原来它在 P2 的位置（前十步），于是
     ① 它写盘之后，后面几十步依赖的库内形态就变了 —— 本轮实测连红三条
        （`P4.5 · 拖动落点` / `b · 列形态` / `e2 · §4.1 快速切换`，而这三条此前每轮都过）；
     ② 它还会落一份快照 + 一篇日志（收尾能按标记清掉，但也多占一次清场）。
     ⇒ **凡是"真的写整个库"的步骤，一律放最后。**（只读的「预演」那一步留在原处没问题。）
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P2 · 属性迁移：执行 → 重跑预演 0 篇（首页那条自己消失）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const kb = ctx.settings.kbRoot();
      const snapsBefore = (await ctx.snapshot.list()).length;
      ctx.store.set({ activeModule: 'home' });
      await P.wait(900);
      const row = P.qa('.kbw-todo').find((t) => P.text(t).includes('的属性还是旧规范'));
      let note = '';
      /**
       * ⚠️ **这一步里 note 是个字符串变量**（存摘要），**不是**别的步骤里那个
       * "往 problems 里推一条"的函数 —— 上一版我在这儿写 note('...') 直接
       * TypeError: note is not a function（页面里抛异常，整步什么都没验）。
       * 所以这一段的错误单独收在 errs 里。
       */
      const errs = [];
      /**
       * 预演里报的「N 篇跳过（值会被写坏）」——**这批是设计上就不动的**
       * （典型：创建日期写成 {{date}} 这种非标量值，processFrontMatter 一往返就改形，
       * services/migrate.ts 的 fragile 守卫整篇跳过）。真机在**迁移前**的数据上跑时
       * 一定有这 4 篇（04_Archives/旧资料/ 那批归档副本），所以下面的终态断言要按它算账，
       * 不能硬要求"旧键一个不剩"。
       */
      let skippedFromPreview = 0;
      /**
       * **播种一篇旧规范**（P6 段⑥ 顺手项；照 P6③ 的做法）。
       *
       * 为什么：实验库**早就迁完了** —— 首页那条「旧规范」虽然还在（它把 fragile 跳过的
       * 那几篇也算进去），但面板里是「0 处改动」→ 点「执行」什么都不弹 →
       * 这一步整片红，而红的原因是"没东西可做"，不是功能坏了。
       * 库里没有旧数据时，**造一篇出来**才是唯一能真验"执行"的办法。
       *
       * ⚠️ 收尾一律 dropLegacyNote()（名字带 __探针，符合本项目的临时文件约定）。
       */
      /**
       * ⚠️ **无条件播种**（第一版写成"首页没有那条时才播"，然后照旧红）：
       * 首页那条「旧规范」**在**不代表有活可干 —— 首页把 fragile 跳过的那几篇
       * 也算进去，所以它是"有跳过"的信号、不是"有改动"的信号。
       * 判据要用**面板里的改动数**，而那要开了面板才知道 → 干脆每次都造一篇
       * （seedLegacyNote 自己会先删掉旧的，重复跑是幂等的）。
       */
      await P.seedLegacyNote();
      const seeded = true;
      /**
       * 🔴 **切模块必须点导航项，不能只 store.set**（这一轮量出来的，两轮都栽在它上面）。
       *
       * 因果链（真机读出来的）：播种 → 索引变更 → 自动归位的 saveSeen（防抖 800ms）落盘
       * → settingsStore.onChange → main.ts 的 applySettingsToStore() **把 activeModule
       * 顶回设置里那个值**（上一次点导航落盘的 notes）→ 首页模块当场被卸掉 →
       * **.kbw-todo 一行都不剩**（采样 12 次全是空）→ 点了个 null → "面板没打开"。
       * 而点导航项走的是 ctx.settings.save({activeModule}) 那条真路径，落盘之后谁也顶不回去。
       */
      const homeNav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('首页'));
      if (homeNav) {
        P.click(homeNav);
      } else {
        errs.push('导航里找不到「首页」');
      }
      await P.wait(1400);
      /**
       * 🔴 **要等那一行"不再被换掉"再点** —— 光"点之前现取一次"是不够的。
       *
       * 真机量到的（这一轮抓了两轮才看清）：播种写盘之后，首页待处理**会连着重绘好几拍**
       * （索引变更 → 模块重画），而 P.click() 是**四个事件依次 dispatch**；
       * 第一发 pointerdown 就可能触发下一拍重绘 → 后三发打在**已经游离**的行上 →
       * 面板当然不开。实测读数：点完 row.isConnected === false，
       * 而"再等一下就有行"（第二次找还可能 no-row，因为那一拍正好在中间态）。
       *
       * 办法与看板用例那条 quiet() 同一个：**连续两拍拿到同一个节点**才算稳。
       */
      let stable = null;
      for (let i = 0; i < 14; i += 1) {
        const cand = P.qa('.kbw-todo').find((t) => P.text(t).includes('的属性还是旧规范'));
        if (cand && cand === stable && cand.isConnected) break;
        stable = cand;
        await P.wait(500);
      }
      let modal = null;
      for (let attempt = 0; attempt < 4 && !modal; attempt += 1) {
        const todo = P.qa('.kbw-todo').find((t) => P.text(t).includes('的属性还是旧规范'));
        if (!todo) {
          await P.wait(600);
          continue;
        }
        P.click(todo);
        await P.wait(1100);
        modal = P.q('.kbw-modal');
      }
      {
        /**
         * 🔴 **面板没打开也不再"提前 return"**：原来那句 return 写在本步骤的
         * **清场之前**（dropLegacyNote），于是**失败的那一轮会把播种那篇留在库里** ——
         * 下一轮的家底就变了（本项目对"夹具残留改变下一轮前提"付过不止一次代价）。
         * 现在改成记一条 note 再往下走：账照记、但收尾一定跑到。
         */
        if (!modal) errs.push('迁移面板没打开（点了那一行没反应）');
        const subText = modal ? P.text(modal.querySelector('.kbw-mig-sub') || modal) : '';
        const m = subText.match(/(\\d+) 篇跳过/);
        skippedFromPreview = m ? Number(m[1]) : 0;
        /** 「N 处待你定」= blocked：首页那条把它也算进去（见上面 pendingFromPreview 的注释） */
        const m2 = subText.match(/(\\d+) 处待你定/);
        pendingFromPreview = m2 ? Number(m2[1]) : 0;
        if (modal) {
          P.clickByText('全部用推荐值', modal);
          await P.wait(500);
          P.clickByText('执行', modal);
          await P.wait(700);
          const confirm = P.qa('.kbw-modal').find((m2) => P.text(m2).includes('即将改动'));
          if (!confirm) {
            note('确认流没弹出来（执行那条路没走通）');
          } else {
            const primary = P.btnByText('改这', confirm);
            if (!primary) {
              note('确认流里没有主按钮');
            } else {
              P.click(primary);
              await P.wait(3000); // 逐篇写 + 索引刷新（metadataCache 有 ~300ms 滞后）
              note = (seeded ? '（播了一篇旧规范）' : '') + '执行过一轮（预演里有 ' + skippedFromPreview + ' 篇跳过）';
            }
          }
        }
      }
      // 终态一：首页那条自己消失（面板里"重跑预演 0 篇"的界面表达）
      ctx.store.set({ activeModule: 'home' });
      await P.wait(900);
      const stillThere = !!P.qa('.kbw-todo').find((t) => P.text(t).includes('的属性还是旧规范'));
      const noArea = !!P.qa('.kbw-todo').find((t) => P.text(t).includes('缺「领域」'));
      // 终态二：索引里不该有任何一篇还带旧键 / 缺必填 / 未分类
      const legacy = ['主题', '标签', '仅显示于', '聚焦'];
      const notes = ctx.index.notes();
      const withLegacy = notes.filter((e) => legacy.some((k) => k in e.props)).map((e) => e.basename);
      const flags = ctx.index.flagCounts();
      // 终态三（跨源）：直接读一份原文件，确认「标签」真并进了 tags
      const p = kb + '/99_Meta/03_AI指令集/AI操作规范.md';
      const f = app.vault.getAbstractFileByPath(p);
      const text = f ? await app.vault.read(f) : '';
      const fmEnd = text.indexOf('---', 3);
      const head = fmEnd > 0 ? text.slice(0, fmEnd) : '';
      const legacyInFile = legacy.filter((k) => new RegExp('^' + k + ':', 'm').test(head));
      // 中文键「标签」并进 tags：**看索引的属性**（文件里 tags 可能是块状列表，
      // 用正则去正文里找 AI 会假红 —— 第一版就是这么错的）
      const props = (ctx.index.get(p) || {}).props || {};
      const merged = !('标签' in props) && Array.isArray(props.tags) && props.tags.indexOf('AI') >= 0;
      const snapsAfter = (await ctx.snapshot.list()).length;
      /**
       * 终态的账要按「预演里报的跳过数」来算：
       *   · 旧键**只该剩在那批被跳过的篇里**（跳过 = 设计上不动，不是失败）
       *   · 首页「旧规范」那条也只在有跳过时才该留着（首页把 blocked 也算进去，
       *     这是 P2 独立审查专门修的：不这样的话"跳过 4 篇"会从界面上一声不响地消失）
       * 数据是干净的时候（迁移后再跑）跳过数 = 0，这一套就退化成"一个旧键都不许剩"。
       */
      const expectedLeft = skippedFromPreview;
      const got = withLegacy.length;
      /**
       * 清场：播种那一篇（认 __探针 标记）。放在**算完账之后**（withLegacy 是这一轮执行的
       * 证据，先删它就等于把自己刚验的东西抹了），而且**无条件跑** —— 上面任何一条
       * 走不通都不许把它留在库里（那会改掉下一轮的前提）。
       */
      await P.dropLegacyNote();
      return {
        ok: errs.length === 0 && got === expectedLeft && merged && legacyInFile.length === 0 &&
            /**
             * ⚠️ 右边是**两个来源之和**：首页那条把「跳过」与「待你定」都算进去 ——
             * 只按跳过算会在"跳过 0、待定 2"时假红（本轮实测）。
             */
            stillThere === (expectedLeft > 0 || pendingFromPreview > 0),
        info: (errs.length ? '⚠️ ' + errs.join('；') + '｜' : '') + note + '｜旧键还在的 ' + got + ' 篇（预演里报跳过 ' + expectedLeft + ' 篇，应相等）｜待你定 ' + pendingFromPreview + ' 处：' +
              (withLegacy.join('、') || '无') + '｜缺必填标记=' + flags['missing-required'] +
              '｜首页「旧规范」那条还在=' + stillThere + '（有跳过时就该还在）· 「缺领域」那条还在=' + noArea +
              '｜AI操作规范：旧键残留=' + (legacyInFile.join('/') || '无') + ' · 中文键已并入 tags=' + merged +
              '｜快照 ' + snapsBefore + '→' + snapsAfter,
      };
    })()`,
    shot: 'p2-迁移后.png',
  },
  {
    name: 'P7.11 · #12 整理建议面板：真入口 → 四选一 → 只勾一篇 → AI 自动去做（stub）→ 确认流 → 真搬 + 补「文件位置」→ 撤销还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const INBOX = KB + '/00_Inbox';
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const name = '__探针P76搬我';
      const src = INBOX + '/' + name + '.md';
      const old = app.vault.getAbstractFileByPath(src);
      if (old) await app.vault.delete(old, true);
      /**
       * 夹具不带「文件位置」：给了声明且声明==现状的话，planRebuild 直接跳过它，
       * 面板一行建议都算不出来（离线用例第一版就栽在这）。
       */
      await app.vault.create(src, '---\\n领域: 灵感杂记\\ntags: []\\n---\\n\\n探针造的，用完会删。\\n');
      await P.wait(1200);
      const logsBefore = (await ctx.report.recent(200)).map(function (f) { return f.path; });
      const snapsBefore = (await ctx.snapshot.list()).map(function (s) { return s.id; });
      /**
       * P7.11 · #12：执行入口只剩「AI 自动去做」——**假 key + 桩**走一遭
       *（红线：动凭据一律 try/finally；classify 桩回空建议，不加新行）。
       * ⚠️ P7.21b（A17 收编）：prevKey 初值 **null**（不是 ''）——"没取过"与"取过、
       * 原来是空 key"要分得开：取 key 那行若抛，还的时候不能拿 '' 把真 key 冲掉。
       */
      let prevKey = null;
      /**
       * ⚠️ 返回语句用到的结果变量**在外层声明**：包进 try 的话它们是块级作用域，
       * 出 try 之后「return」里就是「moved is not defined」（P7.11 真机实测）。
       */
      let moved = false;
      let fmOk = false;
      let back = false;
      let undoHow = '快照';
      let rows = [];
      let labels = '';
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        P.stubAi(JSON.stringify({ reply: '（探针）看了一遍', ideas: [] }));

      // ── 真入口：首页「整理收件箱」→ 二级菜单 → 整理建议…
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const quick = P.qa('.kbw-quickrow button').find(function (b) { return P.text(b).indexOf('整理收件箱') >= 0; });
      if (!quick) return { ok: false, info: '首页没有「整理收件箱」' };
      P.click(quick);
      await P.wait(600);
      labels = P.qa('.kbw-menu-item').map(function (i) { return P.text(i); }).join(' | ');
      if (labels.indexOf('一键自动整理') < 0) note('二级菜单里「一键自动整理」不见了（现行为该原样保留）');
      const entry = P.qa('.kbw-menu-item').find(function (i) { return P.text(i).indexOf('整理建议') >= 0; });
      if (!entry) return { ok: false, info: '二级菜单里没有「整理建议…」：' + labels };
      P.click(entry);
      await P.wait(1400);

      const panel = P.lastModal();
      if (!panel) return { ok: false, info: '面板没开' };
      // 四选一（P7.11 · #12）：四项在、默认 A
      let choice = null;
      for (let i = 0; i < 40 && !choice; i += 1) {
        await P.wait(200);
        choice = P.qa('.kbw-suggest-opt', panel);
        if (choice.length !== 4) choice = null;
      }
      if (!choice) note('四选一没画出来（或不是 4 项）');
      else {
        const texts = choice.map(function (o) { return P.text(o); }).join('|');
        if (texts.indexOf('搬笔记建议') < 0 || texts.indexOf('我全都要') < 0) note('四选一文案不对：' + texts);
        if (choice[0].className.indexOf('is-on') < 0) note('四选一默认该选 A');
      }
      rows = [];
      for (let i = 0; i < 40 && rows.length === 0; i += 1) {
        await P.wait(200);
        rows = P.qa('.kbw-suggest-row');
      }
      if (rows.length === 0) return { ok: false, info: '面板一行都没算出来' };
      const headText = P.text(panel.querySelector('.kbw-suggest-head') || panel);
      if (headText.indexOf('收件箱') < 0) note('头部没有范围 seg');

      // 只勾目标那行：其它默认勾选的行（夹具里别的笔记）全点掉 —— 不能碰夹具
      for (let round = 0; round < 50; round += 1) {
        const all = P.qa('.kbw-suggest-row');
        const mine = all.filter(function (r) { return P.text(r).indexOf(name) >= 0; });
        const others = all.filter(function (r) { return P.text(r).indexOf(name) < 0; });
        const otherOn = others.find(function (r) { const c = r.querySelector('input'); return c && c.checked; });
        const mineCb = mine[0] ? mine[0].querySelector('input') : null;
        if (mineCb && mineCb.checked && !otherOn) break;
        if (otherOn) P.click(otherOn);
        else if (mine[0]) P.click(mine[0]);
        await P.wait(80);
      }
      // 底部两个动作：勾选计数在右端的「已勾 N 项」
      const runBtn = P.qa('.kbw-suggest-bar .kbw-btn').find(function (b) { return P.text(b).indexOf('AI 自动去做') >= 0; });
      if (!runBtn) return { ok: false, info: '没有「AI 自动去做」按钮' };
      const cnt = P.q('.kbw-suggest-count', panel);
      if (!cnt || P.text(cnt).indexOf('已勾 1 项') < 0) note('勾选计数不对：' + (cnt ? P.text(cnt) : '（缺）'));
      P.click(runBtn);
      await P.wait(1200);

      // 确认流：面板自己也是 .kbw-modal —— 遍历所有模态去找「执行这」主按钮
      let primary = null;
      for (let i = 0; i < 30 && !primary; i += 1) {
        await P.wait(150);
        for (const m of document.querySelectorAll('.kbw-modal')) {
          const b = Array.from(m.querySelectorAll('.kbw-modal-foot button'))
            .find(function (x) { return P.text(x).indexOf('执行这') >= 0; });
          if (b) { primary = b; break; }
        }
      }
      if (!primary) return { ok: false, info: '确认流没弹出来' };
      P.click(primary);
      await P.wait(2400);

      /**
       * ⚠️ P7.12（v2）：落点**不再可预判** —— 面板 A 类的来源含"**学你过往的修正**"
       *（沙盒里有大量探针搬动史）→ 同一篇夹具历轮落点不同（实测过 02_Areas 与
       * 02_Areas/内容创作 两处）。本步真正要验的是"只勾一篇 → 真搬 + 补声明 → 撤销还原"
       * 这条链 —— 改成**按"它现在在哪"对账**：搬出 Inbox，且落在哪、声明就写哪。
       */
      const found = app.vault.getMarkdownFiles().filter((f) => f.basename === name);
      const dest = found.find((f) => f.path !== src) || null;
      moved = dest !== null && !app.vault.getAbstractFileByPath(src);
      if (!moved) {
        note('没搬走（它现在在：' + (found.map((f) => f.path).join('、') || '（找不到——可能没被搬过）') + '）');
      }
      if (app.vault.getAbstractFileByPath(src)) note('原位还在（没搬走）');
      if (moved && dest) {
        const t = await app.vault.read(dest);
        const destDir = dest.path.slice(KB.length + 1, dest.path.lastIndexOf('/'));
        fmOk = t.indexOf('文件位置') >= 0 && t.indexOf(destDir) >= 0;
        if (!fmOk) note('被搬笔记的「文件位置」没补成落点（应在 ' + destDir + '）');
      }

      // 撤销：优先走真入口（撤销条）
      const undoBtn = P.qa('.kbw-undobar-actions .kbw-btn').find(function (b) { return P.text(b) === '撤销'; });
      if (undoBtn) {
        undoHow = '撤销条';
        P.click(undoBtn);
        await P.wait(2400);
      } else {
        const snaps = await ctx.snapshot.list();
        if (snaps.length > 0) await ctx.snapshot.restore(snaps[0].id);
        await P.wait(1800);
      }
      back = !!app.vault.getAbstractFileByPath(src);

      // ── 清场：夹具 + 本步新日志 + 本步新快照（与 A2 同一条纪律）
      // ⚠️ v2 起落点不可预判（want 没了）—— 按名字全库扫着清
      for (const f of app.vault.getMarkdownFiles().filter((x) => x.basename === name)) {
        await app.vault.delete(f, true);
      }
      await P.wait(600);
      const logsAfter = (await ctx.report.recent(200)).map(function (f) { return f.path; });
      for (const p of logsAfter) {
        if (logsBefore.indexOf(p) >= 0) continue;
        const f = app.vault.getAbstractFileByPath(p);
        if (f) await app.vault.delete(f, true);
      }
      const snaps2 = await ctx.snapshot.list();
      for (const sn of snaps2) {
        if (!sn.id || snapsBefore.indexOf(sn.id) >= 0) continue;
        try { await ctx.snapshot.remove(sn.id); } catch (e) { void e; }
      }
      } finally {
        // 凭据红线：假 key 一律 finally 归还（P6④ 记过的那条）；没取过就不还（P7.21b）
        if (prevKey !== null) await P.setAiKey(prevKey);
      }

      return {
        ok: problems.length === 0 && !!moved && fmOk && back,
        info: '行数 ' + rows.length + '｜搬到落点=' + !!moved + '｜补「文件位置」=' + fmOk +
          '｜撤销走' + undoHow + '｜回到原位=' + back + '｜二级菜单 = ' + labels +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.6-整理建议面板.png',
  },
  {
    name: 'P7.6 · AI 两跳（stub）：分类出行不执行 · AI 选节 → 挂链真写一行（只加不删）→ 撤销还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const INBOX = KB + '/00_Inbox';
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      /**
       * ⚠️ 夹具名里**不许含 'AI' 这种会被断言扫到的字眼**（第一版叫「__探针P76AI甲」，
       * 行断言用 text 里有没有 'AI' 去认 AI 行 —— 命中的是**文件名**里的 AI，
       * 而那一行其实是被规则盖过的（徽标"规则"）。判据要**认徽标元素**、夹具名别蹭词。
       * 也不给「领域」：给了领域就有规则档（prio 20）盖住 AI 行，AI 行根本看不见。
       */
      const nameA = '__探针P76甲';
      const nameB = '__探针P76挂我';
      const srcA = INBOX + '/' + nameA + '.md';
      const srcB = INBOX + '/' + nameB + '.md';
      for (const p of [srcA, srcB]) {
        const old = app.vault.getAbstractFileByPath(p);
        if (old) await app.vault.delete(old, true);
      }
      await app.vault.create(srcA, '---\\ntags: []\\n---\\n\\n探针造的，用完会删。\\n');
      await app.vault.create(srcB, '---\\ntags: []\\n---\\n\\n探针造的，用完会删。\\n');
      await P.wait(1200);
      let prevKey = null;
      /**
       * 🔴 **临时清空「学过往」统计**：实验库攒了「收件箱 → 某目录 搬过 10 次」这类模式，
       * 而按设计**学过往（40）优先于 AI（60）** —— 不清空的话每篇 Inbox 笔记都被学过往
       * 盖住，AI 行永远看不见（"AI 行没出现"其实是设计在对：先信过量的）。
       * 收尾**原值恢复**（探针不留痕）。
       */
      const statsPrev = ctx.settings.get().moveStats;
      await ctx.settings.save({ moveStats: { tag: {}, dir: {} } });
      const logsBefore = (await ctx.report.recent(200)).map(function (f) { return f.path; });
      const snapsBefore = (await ctx.snapshot.list()).map(function (s) { return s.id; });
      // 🔴 从这里到「全库 seg」之后全部有 try/finally 包着（凭据红线：中途抛异常
      //   也不许把假 key 留在真机 data.json 里 —— P7.11 实测丢过一次）
      //   ⚠️ 返回语句用到的变量一律**在外层声明**（try 里的是块级作用域）。
      let mocText0 = '';
      let secs = [];
      let aiRow = null;
      let stillThere = false;
      let scopeOk = false;
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
      /** MOC 页现状（给"只加一行 + 撤销还原"当基准） */
      const mocRel = ctx.settings.get().metaDir + '/04_索引与地图/MOC_知识地图.md';
      const mocFile = app.vault.getAbstractFileByPath(KB + '/' + mocRel);
      if (mocFile) {
        mocText0 = await app.vault.read(mocFile);
        secs = mocText0.split('\\n').filter(function (l) { return l.indexOf('## ') === 0; })
          .map(function (l) { return l.slice(3).trim(); });
      }

      // 开面板（真入口：首页 → 整理收件箱 → 整理建议…）
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (nav) { P.click(nav); await P.wait(800); }
      const quick = P.qa('.kbw-quickrow button').find(function (b) { return P.text(b).indexOf('整理收件箱') >= 0; });
      if (!quick) return { ok: false, info: '首页没有「整理收件箱」' };
      P.click(quick);
      await P.wait(600);
      const entry = P.qa('.kbw-menu-item').find(function (i) { return P.text(i).indexOf('整理建议') >= 0; });
      if (!entry) return { ok: false, info: '二级菜单里没有「整理建议…」' };
      P.click(entry);
      await P.wait(1400);
      let rows = [];
      for (let i = 0; i < 40 && rows.length === 0; i += 1) {
        await P.wait(200);
        rows = P.qa('.kbw-suggest-row');
      }
      if (rows.length === 0) return { ok: false, info: '面板一行都没算出来' };

      // ── 跳一：AI 分类（P7.11 · #12 起入口 = A 类的「AI 自动去做」——
      //    它出建议后**自动走到确认流**；这里不点主按钮 = 只出建议表，不动文件）
      P.stubAi(JSON.stringify({
        reply: '（探针）这篇看着该进领域。',
        ideas: [{ path: '00_Inbox/' + nameA + '.md', to: '02_Areas/灵感杂记', why: '探针假模型' }],
      }));
      const aiBtn = P.qa('.kbw-suggest-bar .kbw-btn').find(function (b) { return P.text(b).indexOf('AI 自动去做') >= 0; });
      if (!aiBtn) return { ok: false, info: '没有「AI 自动去做」按钮（key 没配上？）' };
      P.click(aiBtn);
      aiRow = null;
      for (let i = 0; i < 40 && !aiRow; i += 1) {
        await P.wait(200);
        // 认「AI 来源徽标」这个**元素**，不认文本里有没有 'AI'（夹具名会蹭）
        aiRow = P.qa('.kbw-suggest-row').find(function (r) {
          return P.text(r).indexOf(nameA) >= 0 && !!r.querySelector('.kbw-suggest-src.is-ai');
        });
      }
      if (!aiRow) note('AI 分类没出行（或行上没有 AI 来源徽标）');
      stillThere = !!app.vault.getAbstractFileByPath(srcA);
      if (!stillThere) note('AI 分类不该动文件（只出建议表 —— 确认流还没点主按钮）');
      /**
       * 这一跳会把确认流带到屏上（"不执行"= 不点它）——**收掉它**再走跳二，
       * 否则后面所有点击都打在确认流上（P3 的"浮层没关、后面步骤全错"同款）。
       */
      P.key('Escape');
      await P.wait(500);

      // ── 跳二：C 类（结尾双链）的「AI 自动去做」→ AI 选节 → 挂进 MOC 的第一个真实 H2
      if (!mocFile || secs.length === 0) {
        note('实验库没有《知识地图》或它没有 H2 节 —— MOC 这条跳过');
      } else {
        const sec = secs[0];
        // P7.11 · #12：先切到 C 类（四选一），才有「选节」这一跳
        const optC = P.qa('.kbw-suggest-opt', P.lastModal()).find(function (o) { return o.getAttribute('data-cls') === 'C'; });
        if (!optC) note('四选一里没有 C 项');
        else {
          P.click(optC);
          await P.wait(1200);
        }
        P.stubAi(JSON.stringify({
          reply: '（探针）挂到第一节。',
          ideas: [{ path: '00_Inbox/' + nameB + '.md', to: sec, why: '探针假模型' }],
        }));
        const mocAiBtn = P.qa('.kbw-suggest-bar .kbw-btn').find(function (b) { return P.text(b).indexOf('AI 自动去做') >= 0; });
        if (!mocAiBtn) note('没有「AI 自动去做」按钮');
        else {
          P.click(mocAiBtn);
          let mocRow = null;
          for (let i = 0; i < 40 && !mocRow; i += 1) {
            await P.wait(200);
            /**
             * ⚠️ 认 MOC 行的**形态**（落点那一格是「节名」带引号），不认"行里有这篇的名字"——
             * 同一篇还会有别的行（move/尾链），按名字 find 会先撞上它（第一版就是这样
             * 揪出来的是 move 行；只不过勾选循环把"含名字的行"都算 mine，才侥幸把挂链跑通）。
             */
            mocRow = P.qa('.kbw-suggest-row').find(function (r) {
              const toEl = r.querySelector('.kbw-suggest-to');
              return P.text(r).indexOf(nameB) >= 0 && toEl != null && P.text(toEl).charAt(0) === '「';
            });
          }
          if (!mocRow) note('AI 选节没出行');
          else {
            // 第一跳把确认流带屏上了 —— 先收掉它，才能点下面的勾选行（点遮罩会把面板关掉）
            P.key('Escape');
            await P.wait(500);
            /**
             * 只勾**这一篇**的行（C 类里尾链行的候选可能一大堆 —— 全勾会把整个库的
             * 尾链都补一遍，那可不是探针该干的）。
             */
            for (let round = 0; round < 50; round += 1) {
              const all = P.qa('.kbw-suggest-row');
              const mine = all.filter(function (r) { return P.text(r).indexOf(nameB) >= 0; });
              const others = all.filter(function (r) { return P.text(r).indexOf(nameB) < 0; });
              const otherOn = others.find(function (r) { const c = r.querySelector('input'); return c && c.checked; });
              const mineOn = mine.find(function (r) { const c = r.querySelector('input'); return c && c.checked; });
              if (mineOn && !otherOn) break;
              if (otherOn) P.click(otherOn);
              else if (mine[0]) P.click(mine[0]);
              await P.wait(80);
            }
            // 执行入口还是那枚 —— AI 已跳过（行已在），再点一次直接进确认流
            P.click(mocAiBtn);
            await P.wait(1200);
            let mPrimary = null;
            for (let i = 0; i < 30 && !mPrimary; i += 1) {
              await P.wait(150);
              for (const m of document.querySelectorAll('.kbw-modal')) {
                const b = Array.from(m.querySelectorAll('.kbw-modal-foot button'))
                  .find(function (x) { return P.text(x).indexOf('执行这') >= 0; });
                if (b) { mPrimary = b; break; }
              }
            }
            if (!mPrimary) note('确认流没弹出来（挂链那一段）');
            else {
              P.click(mPrimary);
              await P.wait(2000);
                const mocText1 = await app.vault.read(mocFile);
                const added = mocText1.split('\\n').length - mocText0.split('\\n').length;
                if (mocText1.indexOf('[[' + KB + '/00_Inbox/' + nameB + ']]') < 0) note('MOC 页里没有新挂的双链');
                if (added !== 1) note('只该加一行，实际行差 ' + added);
                let keptAll = true;
                for (const l of mocText0.split('\\n')) {
                  if (l.trim() === '') continue;
                  if (mocText1.indexOf(l) < 0) { keptAll = false; note('既有行没了：' + l.slice(0, 30)); break; }
                }
                // 撤销 → 页面逐字节回原样
                let u2 = null;
                for (let i = 0; i < 30 && !u2; i += 1) {
                  await P.wait(150);
                  u2 = P.qa('.kbw-undobar-actions .kbw-btn').find(function (b) { return P.text(b) === '撤销'; });
                }
                if (!u2) note('挂链后没有撤销条');
                else {
                  P.click(u2);
                  await P.wait(2200);
                  const mocText2 = await app.vault.read(mocFile);
                  if (mocText2 !== mocText0) note('撤销之后 MOC 页没有逐字节还原');
                }
                void keptAll;
              }
            }
          }
        }
      // ⚠️ 上面这一串闭括号 = P7.11 重排时踩过的坑：把「挂这 N 篇」那层 else 拆掉时
      // 少删了一个闭括号 → 整个 step 求值炸在后面的 let 上（lint:probe 抓不到 ——
      // 它只管整份文件能求值；redline 的「逐条编译每个 step」当场咬住）。改动这段先对括号。

      // ── 范围 seg：切到「全库」一次（重算并出行即算过），再切回默认
      scopeOk = false;
      const segAll = P.qa('.kbw-suggest-head .kbw-segbtn').find(function (b) { return P.text(b) === '全库'; });
      if (!segAll) note('头部没有「全库」seg 按钮');
      else {
        P.click(segAll);
        for (let i = 0; i < 40 && !scopeOk; i += 1) {
          await P.wait(250);
          scopeOk = P.qa('.kbw-suggest-row').length > 0;
        }
        if (!scopeOk) note('切「全库」之后一行都没算出来');
      }

      // ── 清场（🔴 **整段走 finally**，P7.11 实测的教训：本步中途一旦抛异常，
      //    线性收尾就整段跳过 —— 假的 API key 会**留在真机 data.json 里**，
      //    后面的「真连接」步当场报"没配真 key"（与 P6④ 记过的凭据红线同一条））
      } finally {
        for (const p of [srcA, srcB]) {
          const cur = app.vault.getAbstractFileByPath(p);
          if (cur) await app.vault.delete(cur, true);
        }
        if (prevKey !== null) await P.setAiKey(prevKey);
        await ctx.settings.save({ moveStats: statsPrev });
        await P.wait(600);
        const logsAfter = (await ctx.report.recent(200)).map(function (f) { return f.path; });
        for (const p of logsAfter) {
          if (logsBefore.indexOf(p) >= 0) continue;
          const f = app.vault.getAbstractFileByPath(p);
          if (f) await app.vault.delete(f, true);
        }
        const snaps2 = await ctx.snapshot.list();
        for (const sn of snaps2) {
          if (!sn.id || snapsBefore.indexOf(sn.id) >= 0) continue;
          try { await ctx.snapshot.remove(sn.id); } catch (e) { void e; }
        }
      }
      /**
       * ⚠️ **面板故意不收**：截图是脚本返回之后拍的（P7.3c 记过这条）——
       * 收尾把面板关了，拍到的是首页。下一步起手自己会 closeAll。
       */

      return {
        ok: problems.length === 0,
        info: 'AI 分类行=' + !!aiRow + '（文件没动=' + stillThere + '）｜MOC 节=' + JSON.stringify(secs.slice(0, 3)) +
          '｜全库 seg=' + scopeOk +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.6-AI与MOC.png',
  },
  {
    name: 'P7.6 · 首页待处理三件：孤儿附件 / 重复文件 / 一次性标签（行出现 + 点开轻菜单）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const orphanRel = '03_Resources/__探针P76孤儿.png';
      const dupARel = '03_Resources/__探针P76重复甲.bin';
      const dupBRel = '03_Resources/__探针P76重复乙.bin';
      const tagNoteRel = '03_Resources/__探针P76一次性标签.md';
      for (const rel of [orphanRel, dupARel, dupBRel, tagNoteRel]) {
        const old = app.vault.getAbstractFileByPath(KB + '/' + rel);
        if (old) await app.vault.delete(old, true);
      }
      await app.vault.create(KB + '/' + orphanRel, 'ORPHAN-BYTES-探针');
      await app.vault.create(KB + '/' + dupARel, 'SAME-CONTENT-探针');
      await app.vault.create(KB + '/' + dupBRel, 'SAME-CONTENT-探针');
      await app.vault.create(KB + '/' + tagNoteRel, '---\\ntags: [__探针P76只一次]\\n---\\n\\n探针造的，用完会删。\\n');
      await P.wait(1500);

      // 回首页，等待处理重画
      const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
      if (nav) { P.click(nav); await P.wait(1200); }
      /**
       * 🔴 **列表会折叠**（§2.3：超过 5 条收进「还有 N 项」）——三条新规则是蓝档、
       * 排在最后，实验库里前面还有一堆别的规则 → **默认看不见**（第一次跑就这么红的：
       * 截图上明明"8 项 / 还有 3 项"，但我们扫描的只是可见的 5 行）。
       * 办法：把挡在前面的行点「忽略」（写进 homeDismissed）直到三条露出来，
       * **跑完把 homeDismissed 恢复原值**（忽略是用户的设置，探针不许留痕）。
       */
      /**
       * ⚠️ 三条的**匹配词要互相不串**：孤儿行的 meta 会列出夹具文件名（里面就有「重复」
       * 两个字）—— 第一版用 '重复' 去配行，配中的是孤儿行本身（点了两次孤儿菜单，
       * 报出来却是"重复菜单没出来"）。用各行**独有**的措辞配。
       */
      const sawOrphan = function () { return todoText.indexOf('件附件没人引用') >= 0; };
      const sawDup = function () { return todoText.indexOf('组文件内容重复') >= 0; };
      const sawTag = function () { return todoText.indexOf('只用过一次') >= 0; };
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      let todoText = '';
      const findThree = function () {
        todoText = P.qa('.kbw-todo').map(function (t) { return P.text(t); }).join(' || ');
        const hasAll = sawOrphan() && sawDup() && sawTag();
        const foldLine = P.text(P.q('.kbw-todo-rest') || document.createElement('div'));
        const folded = foldLine.indexOf('还有') >= 0;
        if (!hasAll && folded) {
          const x = P.q('.kbw-todo .kbw-todo-x');
          if (x) P.click(x);
        }
      };
      for (let i = 0; i < 60; i += 1) {
        await P.wait(250);
        findThree();
        if (sawOrphan() && sawDup() && sawTag()) break;
      }
      if (!sawOrphan()) note('没有「附件没人引用」那一行');
      if (!sawDup()) note('没有「重复」那一行');
      if (!sawTag()) note('没有「标签只用过一次」那一行');

      // 点孤儿那行 → 轻菜单列文件
      let menuRows = 0;
      const orphanRow = P.qa('.kbw-todo').find(function (t) { return P.text(t).indexOf('件附件没人引用') >= 0; });
      if (orphanRow) {
        P.click(orphanRow);
        await P.wait(1000);
        const menu = P.lastMenu();
        menuRows = menu ? P.qa('.kbw-menu-item').length : 0;
        if (!menu || menuRows === 0) note('孤儿行点开没有菜单');
        P.closeAll(2);
        await P.wait(300);
      } else {
        note('找不到孤儿那一行（点不开）');
      }
      // 点重复那行 → 轻菜单（每组一个子菜单）—— 匹配词用「组文件内容重复」防串行
      const dupRow = P.qa('.kbw-todo').find(function (t) { return P.text(t).indexOf('组文件内容重复') >= 0; });
      let dupMenuOk = false;
      let dupDebug = '';
      if (dupRow) {
        P.click(dupRow);
        await P.wait(1000);
        const menu = P.lastMenu();
        dupMenuOk = !!menu && P.text(menu).indexOf('组重复文件') >= 0;
        dupDebug = 'menus=' + document.querySelectorAll('.kbw-menu').length +
          ' lastMenu=' + JSON.stringify(menu ? P.text(menu).slice(0, 60) : null);
        if (!dupMenuOk) note('重复行点开没有按组的菜单（' + dupDebug + '）');
        P.closeAll(2);
        await P.wait(300);
      } else {
        dupDebug = '找不到重复行（当前行=' + P.qa('.kbw-todo').map(function (t) { return P.text(t).slice(0, 14); }).join(' / ') + '）';
      }

      // 清场：夹具收走 + 「忽略」恢复原值，等重画
      for (const rel of [orphanRel, dupARel, dupBRel, tagNoteRel]) {
        const cur = app.vault.getAbstractFileByPath(KB + '/' + rel);
        if (cur) await app.vault.delete(cur, true);
      }
      await ctx.settings.save({ homeDismissed: dismissedPrev });
      await P.wait(1200);

      return {
        ok: problems.length === 0,
        info: '三行文案 = ' + (sawOrphan() ? '孤儿✓' : '孤儿✗') +
          ' / ' + (sawDup() ? '重复✓' : '重复✗') +
          ' / ' + (sawTag() ? '标签✓' : '标签✗') +
          '｜孤儿菜单 ' + menuRows + ' 项｜重复菜单=' + dupMenuOk + '（' + dupDebug + '）' +
          (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
      };
    })()`,
    shot: 'P7.6-待处理三件.png',
  },
  {
    /**
     * P7.7 · 10.1 的真机判据：**减少动效的两段规则在真级联上真的压到/豁免了该压的东西**。
     *
     * 为什么必须真机：这全是**特异性与 :is() 求值**的问题（`.kbw-menu *` 只后代、
     * `body[data-motion] :is(…)` 打不打得到、三截选择器压不压得住 !important）——
     * 离线静态断言只能证明"文本在"，证明不了"浏览器这么算"。合成几个容器直接量
     * computed 值即可：类名/DOM 位置（body 之子）与真浮层完全同构，而省掉整段
     * "开真菜单真面板"的编排（那会引入一堆与级联无关的失败面）。
     *
     * 量完**原样还回去**（body/root 的 data-motion、临时节点全清）。
     */
    name: 'P7.7 · 动效：reduce 级联（本体被压 · 倒计时豁免 · 档位曲线）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (msg) => { problems.push(msg); };
      const made = [];
      const mk = (cls, parent) => {
        const d = document.createElement('div');
        d.className = cls;
        (parent || document.body).appendChild(d);
        made.push(d);
        return d;
      };
      const dur = (el) => Math.round(parseFloat(getComputedStyle(el).animationDuration) * 1000);
      const tdur = (el) => Math.round(parseFloat(getComputedStyle(el).transitionDuration) * 1000);
      const curve = (el) => getComputedStyle(el).animationTimingFunction;
      const body0 = document.body.getAttribute('data-motion');
      const root = P.q('.kbw-root');
      const root0 = root ? root.getAttribute('data-motion') : null;
      try {
        const menu = mk('kbw-menu');
        const panel = mk('kbw-panel');
        const modal = mk('kbw-modal');
        const backdrop = mk('kbw-backdrop');
        const wrap = mk('kbw-undobar-wrap');
        const undo = mk('kbw-undobar', wrap);
        // ⚠️ 形状要与真实 DOM 同构（undo-bar.ts：wrap > undobar > progress）——
        //    挂错父级会量到另一个选择器的结果（第一版就这么假红了一次）
        const prog = mk('kbw-undobar-progress', undo);
        const leaving = mk('kbw-notice is-leaving');
        const seg = mk('kbw-seg', root);
        const segBtn = document.createElement('button');
        seg.appendChild(segBtn);
        made.push(segBtn);

        /**
         * ⓪ 系统偏好开着 reduce 的机器上，"常态值"无从谈起 —— 如实说明并跳过那三条，
         * 级联部分（下面 ②③）照测。
         */
        const sysReduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const before = sysReduce ? null : {
          menu: dur(menu), modal: dur(modal), undo: dur(undo), prog: dur(prog),
          segT: tdur(segBtn),
        };
        if (before) {
          if (before.menu !== 150) note('常态菜单入场应为 150ms（--t-base），实测 ' + before.menu);
          if (before.modal !== 120) note('常态模态入场应为 120ms（--t-fast），实测 ' + before.modal);
          if (before.undo !== 150) note('常态撤销条入场应为 150ms，实测 ' + before.undo);
          if (before.prog !== 5000) note('常态倒计时应为 5000ms，实测 ' + before.prog);
          if (before.segT !== 150) note('常态分段按钮过渡应为 150ms，实测 ' + before.segT);
        } else {
          note('系统偏好开着 reduce，常态时长三条跳过（级联部分照测）');
        }

        /**
         * ① 曲线分档真的解析出来了（var 名字写错会静默回落成 ease —— 静态断言查不出）。
         */
        const tEnter = curve(menu);
        const tExit = curve(leaving);
        if (tEnter !== 'cubic-bezier(0.2, 0.8, 0.3, 1)') note('入场曲线应是进入档，实测 ' + tEnter);
        if (tExit !== 'cubic-bezier(0.4, 0, 1, 1)') note('退场曲线应是离开档（慢起快走），实测 ' + tExit);

        /**
         * ② reduce 档（插件档那条腿：body + root 同时打上，与 applyAppearance 同源）：
         * 容器**本体**必须被压到 1ms（这正是"只写 X * 会漏"的那一批），
         * 倒计时**豁免**必须保持 5000ms（豁免的作用就是扛住这两段 !important）。
         */
        document.body.setAttribute('data-motion', 'reduce');
        if (root) root.setAttribute('data-motion', 'reduce');
        const after = {
          menu: dur(menu), panel: dur(panel), modal: dur(modal), backdrop: dur(backdrop),
          undo: dur(undo), prog: dur(prog), segT: tdur(segBtn),
        };
        if (after.menu !== 1) note('reduce 下菜单本体应压到 1ms，实测 ' + after.menu);
        if (after.panel !== 1) note('reduce 下浮层本体应压到 1ms，实测 ' + after.panel);
        if (after.modal !== 1) note('reduce 下模态本体应压到 1ms，实测 ' + after.modal);
        if (after.backdrop !== 1) note('reduce 下遮罩本体应压到 1ms，实测 ' + after.backdrop);
        if (after.undo !== 1) note('reduce 下撤销条本体应压到 1ms，实测 ' + after.undo);
        if (after.prog !== 5000) note('reduce 下倒计时**豁免**应保持 5000ms，实测 ' + after.prog);
        if (after.segT !== 1) note('reduce 下工作台内的过渡应压到 1ms，实测 ' + after.segT);

        return {
          ok: problems.length === 0,
          info: '常态 ' + (before ? JSON.stringify(before) : '（系统 reduce，跳过）') +
            '｜reduce ' + JSON.stringify(after) +
            '｜曲线 入场=' + tEnter + ' 退场=' + tExit +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        if (body0 === null) document.body.removeAttribute('data-motion');
        else document.body.setAttribute('data-motion', body0);
        if (root) {
          if (root0 === null) root.removeAttribute('data-motion');
          else root.setAttribute('data-motion', root0);
        }
        for (const el of made) el.remove();
      }
    })()`,
  },
  {
    /**
     * P7.8 · 首页待处理的 ✦（1.5）——真机三件：
     *  ① ✦ 的**有无**与**几何**（jsdom 量不到布局；画不出来 / 点不到只会在真机现形）；
     *  ② 点收件箱行的 ✦ → 整理建议面板开 + **自动落 AI 那一跳**（Q2 拍板"点了就出计划"）
     *     —— 判据就是"没点「让 AI 分类」，AI 行自己出现"；
     *  ③ 行本身的点击不跟着走（stopPropagation）：点完还停在「首页」。
     *
     * 靶子是**自造**的（无声明、空领域、无标签、名字与正文都不含关键词）：
     * 拿夹具里「领域」在路由表有落点的 Inbox 笔记会被权威档（prio 20）先接走，
     * AI 行根本不会出现 —— 那不是坏了，是"先信权威档"的设计在对。
     * 与 P7.6 的两步同款：清空「学过往」（它 prio 40 盖过 AI 60）+ 收尾原值恢复。
     */
    name: 'P7.8 · 首页待处理 ✦：几何在位 · 点 ✦ 自动落 AI 跳（stub）· 不跳走',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const targetRel = '00_Inbox/__探针P78靶.md';
      const targetAbs = KB + '/' + targetRel;
      const old = app.vault.getAbstractFileByPath(targetAbs);
      if (old) await app.vault.delete(old, true);
      await app.vault.create(targetAbs, '探针造的一小段正文，用完会删。\\n');
      await P.wait(1200);
      let prevKey = null;
      const statsPrev = ctx.settings.get().moveStats;
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await ctx.settings.save({ moveStats: { tag: {}, dir: {} } });
        // 回首页
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (nav) { P.click(nav); await P.wait(1000); }
        // 把三行配了 AI 的行挤进可见区（折叠只画 5 条 —— 与 P7.6 三件那步同款）
        const isAiRow = function (t) {
          return t.indexOf('收件箱有') >= 0 || t.indexOf('标题还是「未命名」') >= 0;
        };
        /**
         * ⚠️ P7.12（v2）：「缺领域」行**随领域退役退场**（home/todo.ts 注释钉着）——
         * 配 AI 的待处理只剩两档：收件箱 / 未命名。这里也别再等第三行（等了会白等 15s）。
         */
        const sawAll = function () {
          const t = P.qa('.kbw-todo').map(function (r) { return P.text(r); }).join(' || ');
          return t.indexOf('收件箱有') >= 0 && t.indexOf('标题还是「未命名」') >= 0;
        };
        for (let i = 0; i < 60 && !sawAll(); i += 1) {
          await P.wait(250);
          const rows = P.qa('.kbw-todo');
          const idx = rows.findIndex(function (r) { return isAiRow(P.text(r)) !== true; });
          if (idx >= 0) { const x = rows[idx].querySelector('.kbw-todo-x'); if (x) P.click(x); }
        }
        const rows = P.qa('.kbw-todo');
        /**
         * ⚠️ P7.12 · R5/#18：行尾 ✦ 全撤 —— 改钉**新形态**：每行行尾 = 动作文案 + **恰好一枚**箭头
         *（独立审 B4 同款口径：钉已删类名"不存在"是恒真断言；钉"新长什么样"才有牙）。
         */
        for (const r of rows) {
          const act = r.querySelector('.kbw-todo-act');
          if (!act || act.querySelectorAll('svg').length !== 1 || P.text(act).length === 0) {
            note('行尾不是「动作文案 + 单枚箭头」：' + P.text(r).slice(0, 40));
          }
          if (P.text(r).indexOf('✦') >= 0) note('行上又出现了 ✦（R5 全撤）：' + P.text(r).slice(0, 40));
        }
        const inboxRow = rows.find(function (r) { return P.text(r).indexOf('收件箱有') >= 0; });
        if (!inboxRow) note('三行没露全（收件箱行不在可见区）');
        /**
         * ── P7.11 · #4：两扇右键菜单（真机半步）──
         * 行上 → 「这一项」；块上（非行）→ 块菜单（**AI 置顶 + 重载此板块 + 默认四项**）；
         * AI 项悬停 → 子菜单（一键自动整理 + 分割线 + **目录行现算**，Meta 不列）。
         */
        if (inboxRow) {
          const tEl = inboxRow.querySelector('.kbw-todo-t') || inboxRow;
          const pt = P.aimAt(tEl);
          if (pt && pt.visible) {
            P.rightClickAt(pt.x, pt.y);
            await P.wait(500);
            const menu = P.lastMenu();
            const mtext = menu ? P.text(menu) : '';
            if (mtext.indexOf('处理这一项') < 0) note('行上右键没开「这一项」菜单：' + mtext.slice(0, 60));
            if (mtext.indexOf('忽略这一项') < 0) note('行菜单缺「忽略这一项」（Q3）');
            if (mtext.indexOf('✦ AI 自动处理') < 0) note('行菜单缺「✦ AI 自动处理 ›」');
            P.key('Escape');
            await P.wait(300);
          } else note('行上右键的落点不可见（跳过 #4 行菜单）');
        }
        const headEl = P.q('.kbw-hblock[data-block="todo"] .kbw-sec-head');
        const hp = headEl ? P.aimAt(headEl) : null;
        if (hp && hp.visible) {
          P.rightClickAt(hp.x, hp.y);
          await P.wait(500);
          const menu = P.lastMenu();
          const items = menu ? Array.from(menu.querySelectorAll('.kbw-menu-item')) : [];
          const first = items[0] ? P.text(items[0]) : '';
          /**
           * ⚠️ P7.13b · Q25 回改：块菜单的 AI 项**升成一级项「✦ 一键完全处理」**（不套子菜单）；
           * 老的「✦ AI 自动处理 ›」+（一键自动整理 + 目录行）随 P7.13b 退役 —— 目录列表那份
           * 目录行现算的新家是「整理收件箱」的作用域行（P7.13a · #4）。
           */
          if (first.indexOf('✦ 一键完全处理') < 0) note('块菜单第一项该是「✦ 一键完全处理」，实际「' + first + '」');
          if (!items.some(function (i) { return P.text(i).indexOf('重载此板块') >= 0; })) note('块菜单缺「重载此板块」');
          if (!items.some(function (i) { return P.text(i).indexOf('上移一位') >= 0; })) note('块菜单缺默认四项（上移一位）');
          if (!items.some(function (i) { return P.text(i).indexOf('首页设置') >= 0; })) note('块菜单缺默认四项（首页设置…）');
          const aiItem = items.find(function (i) { return P.text(i).indexOf('✦ 一键完全处理') >= 0; });
          if (aiItem) {
            // 一级项**不套子菜单**：悬停不许飞出第二层（老 AI 项正是靠这一发展开的）
            const before = P.qa('.kbw-menu').length;
            aiItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
            await P.wait(500);
            if (P.qa('.kbw-menu').length !== before) note('「✦ 一键完全处理」悬停飞出了子菜单（Q25：一级项，不套）');
            if (P.text(P.lastMenu()).indexOf('一键自动整理') >= 0) note('老「一键自动整理」还在块菜单里（Q21：退役）');
          }
          P.key('Escape');
          await P.wait(300);
        } else note('块头右键的落点不可见（跳过 #4 块菜单）');
        /**
         * ⚠️ **量之前重新取一次行**（P7.11 实测的真形状）：挤行的循环末尾点了一下
         * 「忽略」→ 那次重画**还没落地**，上面那批「rows」引用在重画落地后就成了游离节点
         *（量几何 = 0×0 —— "✦ 点不到"的谜面其实是**旧引用**；菜单那段的几拍等待正好
         * 让重画落了地）。同 P7.1c 的"重绘后重新取 DOM"。
         */
        const freshInboxRow = P.qa('.kbw-todo').find(function (r) { return P.text(r).indexOf('收件箱有') >= 0; });
        if (!freshInboxRow) note('收件箱行不在可见区（AI 跳验不了）');
        if (freshInboxRow) {
          /**
           * ── P7.12 · R5/#18 起：**行尾 ✦ 全撤**，AI 入口 = 行右键菜单「✦ AI 处理这一项」——
           * "点它 → 自动落 AI 跳（stub）→ 不跳走" 这条链照旧验，入口换到菜单。
           */
          P.stubAi(JSON.stringify({
            reply: '（探针）看了一遍。',
            ideas: [{ path: targetRel, to: '02_Areas/灵感杂记', why: '探针假模型' }],
          }));
          const tEl2 = freshInboxRow.querySelector('.kbw-todo-t') || freshInboxRow;
          const pt2 = P.aimAt(tEl2);
          let opened = false;
          if (pt2 && pt2.visible) {
            /**
             * 右键开行菜单：**重试一拍**（真机实测：上一扇块菜单刚 Esc、重绘未落定时，
             * 第一发右键可能只关不弹 —— probe2 就是这么红的）。认"行菜单"的标记 =
             * 有「处理这一项」，拿不对就 Esc 重来。
             */
            let menu2 = null;
            for (let i = 0; i < 4 && !menu2; i += 1) {
              P.rightClickAt(pt2.x, pt2.y);
              await P.wait(450);
              const m2 = P.lastMenu();
              if (m2 && P.text(m2).includes('处理这一项')) menu2 = m2;
              else { P.key('Escape'); await P.wait(300); }
            }
            const aiItem2 = menu2 ? Array.from(menu2.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('✦ AI 处理这一项') >= 0; }) : null;
            if (!aiItem2) note('行菜单里没有「✦ AI 处理这一项」（R5 后这是行上唯一的 AI 入口）');
            if (aiItem2) { P.click(aiItem2); opened = true; }
            await P.wait(500);
          } else note('收件箱行的落点不可见（跳过 AI 跳）');
          let modal = null;
          if (opened) {
            for (let i = 0; i < 40 && !modal; i += 1) {
              await P.wait(250);
              const m = P.lastModal();
              if (m && P.text(m).indexOf('整理建议') >= 0) modal = m;
            }
          }
          if (opened && !modal) note('点了「✦ AI 处理这一项」没有开整理建议面板');
          const onNav = P.qa('.kbw-navitem').find(function (n) { return n.classList.contains('is-on'); });
          if (!onNav || P.text(onNav).indexOf('首页') < 0) {
            note('「✦ AI 处理这一项」的点击把人带走了（应停在首页）：' + P.text(onNav));
          }
          if (modal) {
            let aiRow = null;
            for (let i = 0; i < 60 && !aiRow; i += 1) {
              await P.wait(250);
              /**
               * ⚠️ P7.9 · ⑥：行上的**全路径进了悬停 title** —— 认标题（《…》里的名字），
               * 别拿整条相对路径去 P.text 里找（那条会永远找不到）。
               */
              aiRow = P.qa('.kbw-suggest-row', modal).find(function (r) {
                return P.text(r).indexOf('探针P78靶') >= 0 && !!r.querySelector('.kbw-suggest-src.is-ai');
              });
            }
            if (!aiRow) {
              note('AI 那一跳没有自动落（没点按钮，AI 行没出现）—— AI 按钮 title：' +
                ((P.q('.kbw-suggest-aibtn', modal) || {}).title || '（没有按钮）'));
            }
            const on = modal.querySelector('.kbw-segbtn.is-on');
            if (!on || P.text(on).indexOf('收件箱') < 0) note('scope 应从行来（收件箱）：' + P.text(on));
          }
          if (app.vault.getAbstractFileByPath(targetAbs) === null) note('AI 分类只出建议表，不该动文件');
        }
      } finally {
        /**
         * 收尾只关**自己的**那一层（点面板的 ✕，不盲按 Esc —— 栈空之后漏给平台的 Esc
         * 会切活动叶把工作台藏起来，closeAll 的注释里记过这笔账）。
         * ⚠️ 这一步的截图一度连着几跑拿不到（20s CDP 超时）—— 真因是**窗口被别的窗口遮住**
         *（visibilityState=hidden，Chromium 不出帧；npm run obsidian -- show 抬到前台即好，
         * 实测复跑两次都正常）。**与本步骤的收尾动作无关**，别按那条假线索改判据。
         */
        const closer = P.lastModal() ? P.lastModal().querySelector('.kbw-iconbtn[aria-label="关闭"]') : null;
        if (closer) P.click(closer);
        await P.wait(300);
        const gone = app.vault.getAbstractFileByPath(targetAbs);
        if (gone) await app.vault.delete(gone, true);
        if (prevKey !== null) await P.setAiKey(prevKey);
        await ctx.settings.save({ moveStats: statsPrev });
        await ctx.settings.save({ homeDismissed: dismissedPrev });
        await P.wait(1200);
      }
      return {
        ok: problems.length === 0,
        info: problems.length ? problems.join('；')
          : '行尾全是「文案 + 单枚箭头」（R5 后无 ✦）· 行菜单「✦ AI 处理这一项」自动出 AI 行 · 没跳走 · 未动文件',
      };
    })()`,
    shot: 'P7.8-待处理AI跳.png',
  },
  {
    /**
     * P7.8 · 「AI 起标题」全流程（1.5 的未命名行）——**真动库**那一步：
     * 未命名行 ✦ → 面板 → 候选（假模型）→ 点候选填值 → 手改 → 确认流（改名预览）
     * → 真改名（source 'ai'）→ 撤销条 → 还原。
     * 自造 `未命名 77.md`（占位标题必须字面匹配 `未命名 N`，没法加 __探针 前缀），
     * 跑完两个名字都清掉。
     */
    name: 'P7.8 · AI 起标题：未命名行 → 面板 → 候选/手改 → 确认流 → 真改名 → 撤销还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const fixRel = '00_Inbox/未命名 77.md';
      const fixAbs = KB + '/' + fixRel;
      const newBase = '__探针P78改名后';
      const newAbs = KB + '/00_Inbox/' + newBase + '.md';
      for (const p of [fixAbs, newAbs]) {
        const o = app.vault.getAbstractFileByPath(p);
        if (o) await app.vault.delete(o, true);
      }
      await app.vault.create(fixAbs, '探针造的一小段正文：这篇讲的是把整理建议接进首页待处理。用完会删。\\n');
      await P.wait(1200);
      let prevKey = null;
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        P.stubAi(JSON.stringify({
          reply: '（探针）看了一遍',
          titles: [{ path: fixRel, options: ['《探针候选甲》', '探针候选二'] }],
        }));
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (nav) { P.click(nav); await P.wait(1000); }
        // 露未命名行
        const sawRow = function () {
          return P.qa('.kbw-todo').some(function (r) { return P.text(r).indexOf('标题还是「未命名」') >= 0; });
        };
        for (let i = 0; i < 60 && !sawRow(); i += 1) {
          await P.wait(250);
          const rows = P.qa('.kbw-todo');
          const idx = rows.findIndex(function (r) { return P.text(r).indexOf('标题还是「未命名」') < 0; });
          if (idx >= 0) { const x = rows[idx].querySelector('.kbw-todo-x'); if (x) P.click(x); }
        }
        const row = P.qa('.kbw-todo').find(function (r) { return P.text(r).indexOf('标题还是「未命名」') >= 0; });
        if (!row) return { ok: false, info: '未命名行没露出来' };
        /**
         * ⚠️ P7.12 · R5/#18：行尾 ✦ 全撤 —— AI 入口 = 行右键菜单「✦ AI 处理这一项」
         *（"未命名行 → 起标题面板"这条链照旧验，入口换到菜单）。
         */
        const tEl = row.querySelector('.kbw-todo-t') || row;
        const pt = P.aimAt(tEl);
        if (!pt || !pt.visible) return { ok: false, info: '未命名行的落点不可见' };
        P.rightClickAt(pt.x, pt.y);
        await P.wait(500);
        const menu = P.lastMenu();
        const aiItem = menu ? Array.from(menu.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('✦ AI 处理这一项') >= 0; }) : null;
        if (!aiItem) return { ok: false, info: '行菜单里没有「✦ AI 处理这一项」' };
        P.click(aiItem);
        let modal = null;
        for (let i = 0; i < 40 && !modal; i += 1) {
          await P.wait(250);
          const m = P.lastModal();
          if (m && P.text(m).indexOf('AI 起标题') >= 0) modal = m;
        }
        if (!modal) return { ok: false, info: '「AI 起标题」面板没开' };
        /**
         * ── P7.11 · #3 卡片化：A/B 候选 + C 我来取名 + D 看看笔记 ──
         * 老 chips/独立输入行退役；这里走"选 A → 再点 C 就地改"两步。
         */
        if (P.q('.kbw-modal-sub', modal)) note('副标题该删（P7.11 · #3）');
        if (!P.q('.kbw-modal-head .kbw-title-star', modal)) note('面板头该有 ✦（accent 标识）');
        const cardOf = function () {
          return P.qa('.kbw-title-row', modal).find(function (r) { return P.text(r).indexOf(fixRel) >= 0; });
        };
        let optA = null;
        for (let i = 0; i < 40 && !optA; i += 1) {
          await P.wait(250);
          const c = cardOf();
          const o = c ? c.querySelector('.kbw-title-opt[data-key="A"]') : null;
          if (o && P.text(o).indexOf('探针候选甲') >= 0) optA = o;
        }
        if (!optA) note('候选没出来（A 项该是剥过书名号的候选甲）');
        if (optA) {
          P.click(optA);
          await P.wait(250);
          const live = cardOf() ? cardOf().querySelector('.kbw-title-opt[data-key="A"]') : null;
          if (!live || live.className.indexOf('is-on') < 0) note('点 A 之后该项没亮（选中态）');
        }
        // 点 C「我来取名」→ 同项就地变输入框 → 敲新名（最终以输入为准）
        const optC = cardOf() ? cardOf().querySelector('.kbw-title-opt[data-key="C"]') : null;
        if (!optC) note('C「我来取名」没画出来');
        else {
          P.click(optC);
          await P.wait(300);
          const input = cardOf() ? cardOf().querySelector('.kbw-title-input') : null;
          if (!input) note('点 C 之后没变成输入框');
          else {
            input.value = newBase;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await P.wait(250);
          }
        }
        /**
         * ── P7.11 · #3：D「看看笔记」走**既有桥**开真小窗 ──
         * ⚠️ **放在改名执行之前**：改名成功后那一行会从面板撤下（「runRename」会 splice），
         * 收尾再点就找不着卡了（第一版就是这么假红的）。开出来的小窗用一次 Esc 收掉
         *（它是当时最上面的浮层，Esc 归它 —— 起标题模态不受影响）。
         */
        const dCard = cardOf();
        const optD = dCard ? dCard.querySelector('.kbw-title-opt[data-key="D"]') : null;
        if (!optD) note('D「看看笔记」没画出来');
        else {
          P.click(optD);
          let win = null;
          for (let i = 0; i < 30 && !win; i += 1) {
            await P.wait(250);
            win = P.q('.kbw-cw-panel');
          }
          if (!win) note('点 D 没开出小窗（看板开着时该走 ctx.openNoteWindow 桥）');
          P.key('Escape');
          await P.wait(500);
          if (P.q('.kbw-cw-panel')) note('D 开的小窗没收掉（Esc 没被它接住？）');
        }
        const runBtn = P.qa('.kbw-title-bar .kbw-btn').find(function (b) { return P.text(b).indexOf('改成这') >= 0; });
        if (!runBtn) return { ok: false, info: '没有「改成这 N 篇的名字」按钮' };
        P.click(runBtn);
        // 确认流（可能叠在面板之上 —— 遍历所有模态找「即将改」那条）
        let primary = null;
        for (let i = 0; i < 40 && !primary; i += 1) {
          await P.wait(250);
          for (const m of P.qa('.kbw-modal')) {
            if (P.text(m).indexOf('即将改') < 0) continue;
            primary = Array.from(m.querySelectorAll('.kbw-modal-foot .kbw-btn'))
              .find(function (b) { return P.text(b).indexOf('改这') >= 0; }) || null;
            if (primary) break;
          }
        }
        if (!primary) note('确认流没弹出来');
        else {
          const plan = P.qa('.kbw-plan-row').map(function (r) { return P.text(r); }).join(' || ');
          if (plan.indexOf('改名') < 0) note('预览里没有「改名」档');
          if (plan.indexOf('未命名 77.md') < 0) note('预览里没有旧名');
          if (plan.indexOf(newBase + '.md') < 0) note('预览里没有新名');
          P.click(primary);
        }
        let renamed = false;
        for (let i = 0; i < 40 && !renamed; i += 1) {
          await P.wait(250);
          renamed = app.vault.getAbstractFileByPath(newAbs) !== null;
        }
        if (!renamed) note('没有真改名（新名不在）');
        if (app.vault.getAbstractFileByPath(fixAbs)) note('老名还在（成对判）');
        const undo = (await P.until(function () { return !!P.lastUndo('撤销'); }, 8000)) ? P.lastUndo('撤销') : null; // 等条出现（大批量动库时它来得晚）
        if (!undo) note('撤销条没出来');
        else {
          P.click(undo);
          let back = false;
          for (let i = 0; i < 40 && !back; i += 1) {
            await P.wait(250);
            back = app.vault.getAbstractFileByPath(fixAbs) !== null;
          }
          if (!back) note('撤销没有还原原名');
          if (app.vault.getAbstractFileByPath(newAbs)) note('还原后新名还在');
        }
      } finally {
        P.closeAll(4);
        if (prevKey !== null) await P.setAiKey(prevKey);
        await ctx.settings.save({ homeDismissed: dismissedPrev });
        for (const p of [fixAbs, newAbs]) {
          const o = app.vault.getAbstractFileByPath(p);
          if (o) await app.vault.delete(o, true);
        }
        await P.wait(400);
      }
      return {
        ok: problems.length === 0,
        info: problems.length ? problems.join('；')
          : '候选（剥包裹）→ 手改 → 改名预览 → 真改名 → 撤销还原，全通',
      };
    })()`,
    shot: 'P7.8-AI起标题.png',
  },
  {
    /**
     * P7.13b · #6a/#6b 真机半步：**菜单开在鼠标处**（Q19）· 行菜单子菜单 = ①/②（Q21/Q25）·
     * 块菜单「✦ 一键完全处理」一级项（Q25）· **Q20 复核结案**（截图里"两扇同开"。
     * 静态分析 = 行菜单 + 其悬停子菜单的正常级联；真机看到的若不是这条级联，当场红）。
     * 只开菜单、不点任何动作项，不动库。
     */
    name: 'P7.13b · 待处理右键：菜单开在鼠标处 · 子菜单 ①/② · 块菜单一级项 · Q20 复核',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const problems = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      try {
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (nav) { P.click(nav); await P.wait(900); }
        const shown = await P.revealTodoRows(['收件箱有']);
        const row = P.todoRow('收件箱有');
        if (!shown || !row) { note('收件箱行挤不进可见区（当前行：' + P.qa('.kbw-todo').map(function (r) { return P.text(r).slice(0, 12); }).join(' / ') + '）'); return { ok: false, info: problems.join('；') }; }
        const pt = P.aimAt(row.querySelector('.kbw-todo-t') || row);
        if (!pt || !pt.visible) { note('行的落点不可见'); return { ok: false, info: problems.join('；') }; }
        // ── ① 鼠标右键 = 鼠标落点（Q19）：菜单左上角应在点位 +4,+4 处（placeAt 的内缩）──
        P.rightClickAt(pt.x, pt.y);
        await P.wait(500);
        const menu = P.lastMenu();
        if (!menu || P.text(menu).indexOf('处理这一项') < 0) { note('右键没开「这一项」菜单'); return { ok: false, info: problems.join('；') }; }
        const mr = menu.getBoundingClientRect();
        const dx = Math.round(mr.left - (pt.x + 4));
        const dy = Math.round(mr.top - (pt.y + 4));
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) note('菜单不在鼠标落点（偏移 ' + dx + ',' + dy + '）');
        if (P.text(menu).indexOf('忽略这一项') < 0) note('行菜单缺「忽略这一项」');
        // ── ② 悬停「✦ AI 自动处理」→ 子菜单恰好 ①/②；顺带 Q20 复核 ──
        const ai = Array.from(menu.querySelectorAll('.kbw-menu-item')).find(function (i) { return P.text(i).indexOf('✦ AI 自动处理') >= 0; });
        let subInfo = '';
        if (!ai) note('行菜单缺「✦ AI 自动处理 ›」');
        else {
          ai.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          await P.wait(500);
          const all = P.qa('.kbw-menu');
          const last = all[all.length - 1];
          const subItems = last ? Array.from(last.querySelectorAll('.kbw-menu-item')).map(function (i) { return P.text(i); }) : [];
          const cascade = all.length === 2 && !!last && last.classList.contains('is-sub');
          if (!cascade) note('悬停后的两层不是"行菜单 + .is-sub 子菜单"（层数=' + all.length + '）');
          subInfo = '｜Q20 复核：' + (cascade ? '两扇同开 = 行菜单 + 其悬停子菜单的正常级联（结案）' : '级联不符！');
          if (subItems.length !== 2) note('子菜单不是恰好两项：' + subItems.join(' | '));
          if (subItems[0] === undefined || subItems[0].indexOf('① 自动处理本条（') !== 0 || subItems[0].slice(-1) !== '）') note('第一项不是「① 自动处理本条（行量词）」：' + subItems[0]);
          if (subItems[1] !== '② 一键完全处理') note('第二项不是「② 一键完全处理」：' + subItems[1]);
          if (subItems.some(function (t) { return t.indexOf('一键自动整理') >= 0; })) note('老「一键自动整理」还在子菜单里（Q21：退役）');
        }
        P.key('Escape');
        await P.wait(300);
        // ── ③ 块菜单：「✦ 一键完全处理」一级项、不套子菜单 ──
        const headEl = P.q('.kbw-hblock[data-block="todo"] .kbw-sec-head');
        const hp = headEl ? P.aimAt(headEl) : null;
        let blockInfo = '';
        if (!hp || !hp.visible) note('块头落点不可见（跳过块菜单复核）');
        else {
          P.rightClickAt(hp.x, hp.y);
          await P.wait(500);
          const items = P.lastMenu() ? Array.from(P.lastMenu().querySelectorAll('.kbw-menu-item')) : [];
          const first = items[0] ? P.text(items[0]) : '';
          if (first.indexOf('✦ 一键完全处理') < 0) note('块菜单第一项该是「✦ 一键完全处理」，实际「' + first + '」');
          const aiItem = items.find(function (i) { return P.text(i).indexOf('✦ 一键完全处理') >= 0; });
          if (aiItem) {
            const before = P.qa('.kbw-menu').length;
            aiItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
            await P.wait(450);
            if (P.qa('.kbw-menu').length !== before) note('「✦ 一键完全处理」悬停飞出了子菜单（Q25：一级项，不套）');
            else blockInfo = '｜块菜单一级项在（悬停不套子菜单）';
          }
          P.key('Escape');
          await P.wait(250);
        }
        return {
          ok: problems.length === 0,
          info: '落点偏移=' + dx + ',' + dy + '（+4,+4 内缩）' + subInfo + blockInfo + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓'),
        };
      } finally {
        P.closeAll(3);
        await ctx.settings.save({ homeDismissed: dismissedPrev });
        await P.wait(400);
      }
    })()`,
    shot: 'P7.13b-右键落点与两项子菜单.png',
  },
  {
    /**
     * P7.13b · **撤行判据（Q24）· 直跑三件**：收件箱 → 一键自动整理；位置不一致 →
     * 搬回声明处；空文件 → 清空此类。每类：造探针夹具 → 行出现（记 N）→ 行菜单 ① →
     * 确认流 → **跑完该行消失/N 变小** → 撤销还原（"行消失"= 底层真修好，行是现算的）。
     * ⚠️ AI 一律假 key + 假传输层（tidy 的 AI 预整理不出值，确认单只列探测器的）。
     * ⚠️ 清空此类是**全库扫** —— 预览混进非探针件就**取消**（绝不动用户内容）。
     */
    name: 'P7.13b · 撤行①·直跑三件：收件箱 / 位置不一致 / 空文件（跑完行消失 + 撤销还原）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      const results = [];
      P.closeAll(4);
      await P.wait(400);
      let prevKey = null;
      P.stubAi(JSON.stringify({ reply: '（探针）没有把握，不给落点', locus: [] }));
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      /*
       * ⚠️ 夹具一律用 **类型: 笔记**（v2 七值内）—— 首跑用「资料」时每篇夹具都把自己
       * 挂进「旧规范」行（资料不在 v2 值域、迁移预演会认领），把 S4 的迁移档搅黄了。
       */
      const INBOX_FIX = '00_Inbox/__探针P713B速记.md';
      const PM = '03_Resources/__探针P713B位偏.md';
      const EMPTY = '03_Resources/__探针P713B空.md';
      const rmFix = async (rel) => {
        const f = app.vault.getAbstractFileByPath(KB + '/' + rel);
        if (f) await app.vault.delete(f, true);
      };
      const ntxt = (needle) => { const n = P.todoRowN(needle); return n === null ? '无' : String(n); };
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await rmFix(INBOX_FIX);
        await rmFix(PM);
        await rmFix(EMPTY);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (nav) { P.click(nav); await P.wait(1000); }
        // ── ① 收件箱 → 一键自动整理 ──
        {
          /*
           * 首跑教训：库里那 2 篇都带「文件位置」（新建即配置补的）→ tidy 无一可搬、不弹确认流。
           * 夹具要**没有声明**（fallback 档才有落点）——这才是"有待整理"的真形态。
           */
          await app.vault.create(KB + '/' + INBOX_FIX, '---\\n类型: 笔记\\ntags: []\\n---\\n\\n探针造的（收件箱待整理），用完会删。\\n');
          await P.wait(1500);
          const shown = await P.revealTodoRows(['收件箱有']);
          const n0 = P.todoRowN('收件箱有');
          if (!shown || n0 === null) note('收件箱行不在（跳过这一档）');
          else {
            const clicked = await P.clickTodoAi(P.todoRow('收件箱有'), '①');
            if (clicked !== true) note('收件箱行 ① 点不到（' + clicked + '）');
            else {
              const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('即将整理') >= 0; }, 6000);
              if (!got) note('整理确认流没弹（收件箱 N=' + n0 + '）');
              else {
                P.clickLastModalBtn('搬这');
                const moved = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + INBOX_FIX) === null; }, 8000);
                if (!moved) note('夹具没被整理搬走');
                else results.push('收件箱：共 ' + n0 + ' 篇，探针夹具已搬走 ✓');
                const undo = (await P.until(function () { return !!P.lastUndo('撤销'); }, 8000)) ? P.lastUndo('撤销') : null; // 等条出现（大批量动库时它来得晚）
                if (!undo) note('整理后没出撤销条');
                else {
                  P.click(undo);
                  const back = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + INBOX_FIX) !== null; }, 8000);
                  if (!back) note('撤销没把收件箱夹具搬回');
                  else results.push('收件箱撤销还原 ✓（行 ' + ntxt('收件箱有') + '）');
                }
              }
            }
          }
        }
        // ── ② 位置不一致 → 搬回声明处（声明到一个**真有的、非排除区**目录）──
        P.closeAll(3);
        await P.wait(400);
        {
          /*
           * ⚠️ 目标目录必须过三关：真存在 · 不在排除区（段名含 99_Meta / 还原保留 / .开头 ——
           * 首跑抽到 02_Areas/99_Meta 就是被排除守卫拦下的：那**是对的**，是夹具选错了）；
           * 库里本来那篇「_收件箱」声明指向一个不存在的目录 → 会先弹「要顺手建出来吗」——
           * 本步**点「不建」**（绝不给用户库建目录/搬他的笔记），再走主确认单。
           */
          let wantDir = '';
          const badSeg = function (rel) {
            return rel.split('/').some(function (s) { return s.indexOf('99_Meta') === 0 || s.indexOf('还原保留') === 0 || s.indexOf('.') === 0; });
          };
          try {
            for (const base of ['02_Areas', '01_Projects', '03_Resources']) {
              const ls = await app.vault.adapter.list(KB + '/' + base);
              const hit = (ls.folders || []).map(function (p) { return p.slice(KB.length + 1); }).find(function (r) { return !badSeg(r); });
              if (hit) { wantDir = hit; break; }
              if (!badSeg(base) && (ls.folders || []).length === 0) { wantDir = base; break; }
            }
          } catch (e) { /* 兜底 */ }
          if (!wantDir) wantDir = '01_Projects';
          await app.vault.create(KB + '/' + PM, '---\\n类型: 笔记\\ntags: []\\n文件位置:\\n  - ' + wantDir + '\\n---\\n\\n探针造的，用完会删。\\n');
          await P.wait(1500);
          const shown = await P.revealTodoRows(['位置不一致']);
          const n0 = P.todoRowN('位置不一致');
          if (!shown || n0 === null) note('位置不一致行不在（夹具声明 = ' + wantDir + '）');
          else {
            const clicked = await P.clickTodoAi(P.todoRow('位置不一致'), '①');
            if (clicked !== true) note('位置不一致行 ① 点不到（' + clicked + '）');
            else {
              // 可能先弹「要顺手建出来吗」（库里别的篇声明指向不存在的目录）→ 点「不建」
              const firstDlg = await P.until(function () {
                const m = P.lastModal();
                return !!m && (P.text(m).indexOf('即将搬回声明处') >= 0 || P.text(m).indexOf('目标目录还不存在') >= 0);
              }, 6000);
              if (!firstDlg) note('搬回流程没弹任何确认（目标 ' + wantDir + '）');
              else {
                const m0 = P.lastModal();
                if (P.text(m0).indexOf('目标目录还不存在') >= 0) {
                  P.clickLastModalBtn('不建');
                  await P.wait(400);
                }
                const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('即将搬回声明处') >= 0; }, 5000);
                if (!got) note('主确认单没弹（目标 ' + wantDir + '）');
                else {
                  P.clickLastModalBtn('搬这');
                  const dest = wantDir + '/__探针P713B位偏.md';
                  const moved = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + dest) !== null; }, 6000);
                  if (!moved) note('没搬回声明处（目标 ' + wantDir + '）');
                  else {
                    const after = P.todoRowN('位置不一致');
                    if (!(after === null || after < n0)) note('搬回后行没消（' + n0 + ' → ' + after + '）');
                    else results.push('位置不一致：搬到 ' + wantDir + '，行 ' + n0 + ' → ' + ntxt('位置不一致') + ' ✓');
                    const undo = (await P.until(function () { return !!P.lastUndo('撤销'); }, 8000)) ? P.lastUndo('撤销') : null; // 等条出现（大批量动库时它来得晚）
                    if (!undo) note('搬回后没出撤销条');
                    else {
                      P.click(undo);
                      const back = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + PM) !== null; }, 6000);
                      if (!back) note('撤销没搬回原位');
                      else results.push('位置不一致撤销还原 ✓');
                    }
                  }
                }
              }
            }
          }
        }
        // ── ③ 空文件 → 清空此类（全库扫 —— 预览混进非探针件就取消）──
        P.closeAll(3);
        await P.wait(400);
        {
          await app.vault.create(KB + '/' + EMPTY, '');
          await P.wait(1500);
          const shown = await P.revealTodoRows(['还没写内容']);
          const n0 = P.todoRowN('还没写内容');
          if (!shown || n0 === null) note('空文件行不在');
          else {
            const clicked = await P.clickTodoAi(P.todoRow('还没写内容'), '①');
            if (clicked !== true) note('空文件行 ① 点不到（' + clicked + '）');
            else {
              const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('清空这') >= 0; }, 5000);
              if (!got) note('清空确认流没弹');
              else {
                /*
                 * ⚠️ 清空是**全库扫**（#10 口径）——首跑实测预览里还有 10 行"剥前言尾链后空"
                 * 的用户空壳（2026-10-06 那批 + 别的）。照跑（用户点 ① 也是这个形态），
                 * 但**一件都不许丢**：撤销之后按名逐件断言全回来（同 E2/E3）。
                 */
                const names = P.qa('.kbw-plan-row .kbw-plan-kind').map(function (k) { return P.text(k).replace(/[《》]/g, ''); });
                const hasMine = names.some(function (t) { return t.indexOf('__探针') >= 0; });
                if (!hasMine) note('清空预览里没有探针件（判定不对？）');
                P.clickLastModalBtn('清空这');
                // 🔴 先等整批完成（撤销条 = trash 链收尾信号）再判"行消失"（同 E2 的竞态注释）
                const barOk = await P.until(function () { return !!P.lastUndo('撤销'); }, 12000);
                const gone = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + EMPTY) === null; }, 6000);
                if (!gone) note('空文件没被清掉');
                else {
                  const afterOk = await P.until(function () { const n1 = P.todoRowN('还没写内容'); return n1 === null || n1 < n0; }, 5000);
                  if (!afterOk) note('清空后行没消（' + n0 + ' → ' + ntxt('还没写内容') + '）');
                  else results.push('空文件：' + n0 + ' → ' + ntxt('还没写内容') + ' ✓');
                  const undo = barOk ? P.lastUndo('撤销') : null;
                  if (!undo) note('清空后没出撤销条');
                  else {
                    P.click(undo);
                    const back = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + EMPTY) !== null; }, 8000);
                    /*
                     * ⚠️ 清空流的预览格是「《basename》」——**不带 .md**（runClearEmpty 的 prop 口径）
                     * 而 f.name 带扩展名 → 比对要**补 .md 变体**（首跑在这里假红过一次，
                     * 库里的件其实全回来了）。
                     */
                    const inLib = function (n) {
                      const files = app.vault.getFiles().map(function (f) { return f.name; });
                      return files.indexOf(n) >= 0 || files.indexOf(n + '.md') >= 0;
                    };
                    const restored = await P.until(function () { return names.every(inLib); }, 8000);
                    if (!back) note('撤销没把空文件写回');
                    else if (!restored) note('撤销后还有件没回（缺：' + names.filter(function (n) { return !inLib(n); }).join('、') + '）');
                    else results.push('空文件撤销还原 ✓（含库里那批 ' + names.length + ' 件全数回）');
                  }
                }
              }
            }
          }
        }
      } finally {
        P.closeAll(4);
        if (prevKey !== null) await P.setAiKey(prevKey);
        P.realAi();
        await rmFix(INBOX_FIX);
        await rmFix(PM);
        await rmFix(EMPTY);
        await ctx.settings.save({ homeDismissed: dismissedPrev });
        await P.wait(500);
      }
      return { ok: problems.length === 0, info: results.join('；') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
    })()`,
    shot: 'P7.13b-撤行-直跑三件.png',
  },
  {
    /**
     * P7.13b · **撤行判据（Q24）· 三类自动化**：失效双链 → AI 修链（stub）；重复文件 →
     * 保最新一份；孤儿附件 → 挪 99_Meta/05_待清理。每类造探针夹具、① 跑完**行消失/N 变小**、
     * 撤销还原（"跑完行消失"= Q24 验收口径：行是现算的，底层真修好才消）。
     * ⚠️ 修链的候选值域 = 全库标题 —— stub 指的候选是**探针自己造的目标笔记**；
     * ⚠️ 重复/孤儿的确认单是**全库**性质 —— 预览混进非探针件就取消（不动用户内容）。
     */
    name: 'P7.13b · 撤行①·三类自动化：AI 修链（stub）/ 重复保一份 / 孤儿挪待清理',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      const results = [];
      P.closeAll(4);
      await P.wait(400);
      let prevKey = null;
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      const SRC = '03_Resources/__探针P713B修链源.md';
      const DST = '03_Resources/__探针P713B修链目标.md';
      const DUP_A = '03_Resources/__探针P713B重复甲.bin';
      const DUP_B = '03_Resources/__探针P713B重复乙.bin';
      const ORPH = '03_Resources/__探针P713B孤儿.png';
      const CLEAN_DIR = '99_Meta/05_待清理';
      // ⚠️ 类型: 笔记（v2 值域内）—— 首跑用「资料」时夹具自己挂进了「旧规范」行
      const SRC_TEXT = '---\\n类型: 笔记\\ntags: []\\n---\\n\\n开头 [[__探针P713B旧目标]] 结尾。\\n';
      const rmFix = async (rel) => {
        const f = app.vault.getAbstractFileByPath(KB + '/' + rel);
        if (f) await app.vault.delete(f, true);
      };
      const ntxt = (needle) => { const n = P.todoRowN(needle); return n === null ? '无' : String(n); };
      const readAbs = async (rel) => {
        const f = app.vault.getAbstractFileByPath(KB + '/' + rel);
        return f ? await app.vault.read(f) : null;
      };
      /**
       * 确认单上的所有将动件名：取**每行第一格**（set/删除类 = .kbw-plan-kind 的《名》；
       * move 类**没有 kind 格** —— 第一格是 .kbw-plan-path 的《名》。两档都认，别只认一种。
       */
      const listedNames = () => P.qa('.kbw-plan-row').map(function (r) {
        const c = r.querySelector('.kbw-plan-kind') || r.querySelector('.kbw-plan-path');
        return c ? P.text(c).replace(/[《》]/g, '') : '';
      });
      /** 这些名字在库里还有吗（撤还原的兜底断言：一件都不能丢） */
      const allBack = (names) => {
        const files = app.vault.getFiles().map(function (f) { return f.name; });
        return names.every(function (n) { return files.indexOf(n) >= 0; });
      };
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        for (const r of [SRC, DST, DUP_A, DUP_B, ORPH]) await rmFix(r);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (nav) { P.click(nav); await P.wait(1000); }
        // ── ① 失效双链 → AI 修链（stub 只给我的夹具出候选）──
        {
          await app.vault.create(KB + '/' + DST, '---\\n类型: 笔记\\ntags: []\\n---\\n\\n（探针造的候选目标，用完会删。）\\n');
          await app.vault.create(KB + '/' + SRC, SRC_TEXT);
          await P.wait(1600);
          P.stubAi(JSON.stringify({
            reply: '（探针）猜了一个目标',
            links: [{ path: SRC, from: '__探针P713B旧目标', options: ['__探针P713B修链目标'] }],
          }));
          const shown = await P.revealTodoRows(['失效双链']);
          const n0 = P.todoRowN('失效双链');
          if (!shown || n0 === null) note('失效双链行不在');
          else {
            const clicked = await P.clickTodoAi(P.todoRow('失效双链'), '①');
            if (clicked !== true) note('失效双链行 ① 点不到（' + clicked + '）');
            else {
              const panel = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('AI 修链') >= 0; }, 5000);
              if (!panel) note('修链面板没开');
              else {
                const optA = await P.until(function () { return P.q('.kbw-title-opt[data-key="A"]') !== null; }, 6000);
                if (!optA) note('候选没出来（stub 没接上？）');
                else {
                  P.click(P.q('.kbw-title-opt[data-key="A"]'));
                  await P.wait(250);
                  const runBtn = P.btnByText('改这', P.lastModal());
                  if (!runBtn) note('面板里没有「改这 N 条链」按钮');
                  else {
                    P.click(runBtn);
                    const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('即将改') >= 0; }, 4000);
                    if (!got) note('修链确认流没弹');
                    else {
                      P.clickLastModalBtn('改这');
                      /*
                       * ⚠️ 首跑教训：确认之后**要等写盘落地**（快照 + vault.process 要一两秒），
                       * 立刻读回读到的是原文 —— 等"新目标出现"才算数（否则假红成"链没改成"）。
                       */
                      const wrote = await P.until(async function () {
                        const t = await readAbs(SRC);
                        return t !== null && t.indexOf('[[__探针P713B修链目标]]') >= 0;
                      }, 8000);
                      const text = await readAbs(SRC);
                      if (!wrote) note('链没改成（读回：' + String(text).slice(0, 80) + '）');
                      else if (text !== null && text.indexOf('__探针P713B旧目标') >= 0) note('旧目标还在（没换干净）');
                      else results.push('修链：[[旧]] → [[目标]] ✓');
                      // 行减弱（首跑时机对：写盘落地后 N 才会变）
                      const after = await P.until(function () { const n1 = P.todoRowN('失效双链'); return n1 === null || n1 < n0; }, 5000);
                      if (!after) note('修链后行没消（' + n0 + ' → ' + ntxt('失效双链') + '）');
                      else results.push('失效双链行 ' + n0 + ' → ' + ntxt('失效双链') + ' ✓');
                      P.key('Escape');
                      await P.wait(400);
                      const undo = (await P.until(function () { return !!P.lastUndo('撤销'); }, 8000)) ? P.lastUndo('撤销') : null; // 等条出现（大批量动库时它来得晚）
                      if (!undo) note('修链后没出撤销条');
                      else {
                        P.click(undo);
                        const back = await P.until(async function () { const t = await readAbs(SRC); return t !== null && t.indexOf('__探针P713B旧目标') >= 0; }, 8000);
                        if (!back) note('撤销没把链改回去');
                        else results.push('修链撤销还原 ✓');
                      }
                    }
                  }
                }
              }
            }
          }
        }
        // ── ② 重复文件 → 保最新一份（甲先写、乙后写 ⇒ 乙更新）──
        P.closeAll(3);
        await P.wait(400);
        {
          const nBefore = P.todoRowN('文件内容重复');
          await app.vault.create(KB + '/' + DUP_A, 'SAME-CONTENT-P713B');
          await P.wait(1300);
          await app.vault.create(KB + '/' + DUP_B, 'SAME-CONTENT-P713B');
          await P.wait(1200);
          /*
           * 🔴 **非 md 夹具不动索引 → 维护三件的缓存不失效**（第二次首跑的教训：确认单里
           * 只有库里那组、没有任何探针件 —— 照跑就等于清用户的东西）。显式重扫 + 等"组数
           * 涨了"才往下走；确认单里若还是没有探针件 → **取消**（护栏）。
           */
          ctx.index.rebuild();
          await P.wait(1000);
          const shown = await P.revealTodoRows(['文件内容重复']);
          const grew = await P.until(function () {
            const n = P.todoRowN('文件内容重复');
            return n !== null && n > (nBefore === null ? 0 : nBefore);
          }, 6000);
          const n0 = P.todoRowN('文件内容重复');
          if (!shown || n0 === null) note('重复行不在（两件内容相同、应该成组）');
          else if (!grew) note('重复行没算进探针那组（N=' + n0 + '，重建后该 +1）');
          else {
            const clicked = await P.clickTodoAi(P.todoRow('文件内容重复'), '①');
            if (clicked !== true) note('重复行 ① 点不到（' + clicked + '）');
            else {
              const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('重复文件只留最新的一份') >= 0; }, 5000);
              if (!got) note('重复确认流没弹');
              else {
                /*
                 * ⚠️ 库里**自带一组真重复**（首跑实测：2026-10-06 那批）——这单是**全库**性质，
                 * 照跑（用户点 ① 也是这个行为），但**一件都不许丢**：撤销之后逐名断言全回来了。
                 */
                const names = listedNames();
                const hasMine = names.some(function (t) { return t.indexOf('__探针') >= 0; });
                if (!hasMine) {
                  P.clickLastModalBtn('取消');
                  note('确认单里没有探针件 —— 已取消（护栏：绝不清非探针件）');
                } else {
                P.clickLastModalBtn('清这');
                /*
                 * 🔴 **先等"整批完成"再判**（独立审 🔴1：真机全量跑里这条是竞态 ——
                 * 行是现算的，**任意一组**先删到只剩 1 件它的 N 就掉，"行变小"会在批次
                 * 中途成立 → 早收工、撤销还原整段被跳过）。整批收尾的信号 = 撤销条出现
                 * （showUndo 在 trash 循环之后），以它为闸。
                 */
                const barOk = await P.until(function () { return !!P.lastUndo('撤销'); }, 12000);
                const goneA = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + DUP_A) === null; }, 6000);
                const keepB = app.vault.getAbstractFileByPath(KB + '/' + DUP_B) !== null;
                if (!goneA) note('甲没进回收站');
                else if (!keepB) note('乙也被清了（该留最新的它）');
                else results.push('重复：甲（旧）清了、乙（新）在 ✓');
                const after = P.until(function () { const n1 = P.todoRowN('文件内容重复'); return n1 === null || n1 < n0; }, 5000);
                const afterOk = await after;
                if (!afterOk) note('清完重复行没消（' + n0 + ' → ' + ntxt('文件内容重复') + '）');
                else results.push('重复行 ' + n0 + ' → ' + ntxt('文件内容重复') + ' ✓');
                const undo = barOk ? P.lastUndo('撤销') : null;
                if (!undo) note('清重复后没出撤销条');
                else {
                  P.click(undo);
                  const backA = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + DUP_A) !== null; }, 6000);
                  const allRestored = await P.until(function () { return allBack(names); }, 6000);
                  if (!backA) note('撤销没把甲找回来');
                  else if (!allRestored) note('撤销后还有件没回来：' + names.filter(function (n) {
                    const files = app.vault.getFiles().map(function (f) { return f.name; });
                    return files.indexOf(n) < 0;
                  }).join('、'));
                  else results.push('重复撤销还原 ✓（含库里那组 ' + names.length + ' 件全数回）');
                }
                }
              }
            }
          }
        }
        // ── ③ 孤儿附件 → 挪 99_Meta/05_待清理 ──
        P.closeAll(3);
        await P.wait(400);
        {
          let cleanExisted = false;
          try { cleanExisted = await app.vault.adapter.exists(KB + '/' + CLEAN_DIR); } catch (e) { /* 当不存在 */ }
          const nBefore = P.todoRowN('附件没人引用');
          await app.vault.create(KB + '/' + ORPH, 'ORPHAN-BYTES-P713B');
          await P.wait(1200);
          // 非 md 夹具 → 索引不跟 → 显式重扫（同 E2 的注释）
          ctx.index.rebuild();
          await P.wait(1000);
          const shown = await P.revealTodoRows(['附件没人引用']);
          const grew = await P.until(function () {
            const n = P.todoRowN('附件没人引用');
            return n !== null && n > (nBefore === null ? 0 : nBefore);
          }, 6000);
          const n0 = P.todoRowN('附件没人引用');
          if (!shown || n0 === null) note('孤儿行不在');
          else if (!grew) note('孤儿行没算进探针那件（N=' + n0 + '，重建后该 +1）');
          else {
            const clicked = await P.clickTodoAi(P.todoRow('附件没人引用'), '①');
            if (clicked !== true) note('孤儿行 ① 点不到（' + clicked + '）');
            else {
              const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('没人引用的附件挪到') >= 0; }, 5000);
              if (!got) note('孤儿确认流没弹');
              else {
                // 同 E2：库里自带孤儿（首跑实测：封面示例.png）——照跑，撤销后全数回
                const names = listedNames();
                const hasMine = names.some(function (t) { return t.indexOf('__探针') >= 0; });
                if (!hasMine) {
                  P.clickLastModalBtn('取消');
                  note('确认单里没有探针件 —— 已取消（护栏：绝不挪非探针件）');
                } else {
                P.clickLastModalBtn('挪这');
                const destRel = CLEAN_DIR + '/__探针P713B孤儿.png';
                const moved = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + destRel) !== null; }, 6000);
                if (!moved) note('没挪进 ' + CLEAN_DIR + '/');
                else results.push('孤儿：挪进 ' + CLEAN_DIR + '/ ✓（目录' + (cleanExisted ? '本来就有' : '随 mover 建') + '）');
                // 🔴 先等整批完成（撤销条 = trash/move 链收尾信号）再判"行消失"（同 E2 的竞态注释）
                const barOk = await P.until(function () { return !!P.lastUndo('撤销'); }, 12000);
                const afterOk = await P.until(function () { const n1 = P.todoRowN('附件没人引用'); return n1 === null || n1 < n0; }, 5000);
                if (!afterOk) note('挪完孤儿行没消（' + n0 + ' → ' + ntxt('附件没人引用') + '）');
                else results.push('孤儿行 ' + n0 + ' → ' + ntxt('附件没人引用') + ' ✓');
                const undo = barOk ? P.lastUndo('撤销') : null;
                if (!undo) note('挪孤儿后没出撤销条');
                else {
                  P.click(undo);
                  const back = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + ORPH) !== null; }, 6000);
                  const allRestored = await P.until(function () { return allBack(names); }, 6000);
                  if (!back) note('撤销没把探针附件挪回来');
                  else if (!allRestored) note('撤销后还有孤儿没回原位（按名查缺失）：' + names.join('、'));
                  else results.push('孤儿撤销还原 ✓（含库里那件）');
                  if (!cleanExisted) {
                    const cleared = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + CLEAN_DIR) === null; }, 2500);
                    if (!cleared) note('撤销后 ' + CLEAN_DIR + ' 目录还在（快照 newDirs 该收回它）');
                  }
                }
                }
              }
            }
          }
        }
      } finally {
        P.closeAll(4);
        if (prevKey !== null) await P.setAiKey(prevKey);
        P.realAi();
        for (const r of [SRC, DST, DUP_A, DUP_B, ORPH]) await rmFix(r);
        await ctx.settings.save({ homeDismissed: dismissedPrev });
        await P.wait(500);
      }
      return { ok: problems.length === 0, info: results.join('；') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
    })()`,
    shot: 'P7.13b-撤行-三类自动化.png',
  },
  {
    /**
     * P7.13b · **撤行判据（Q24）· 面板类**：未命名 → 起标题面板（stub 候选 → 改名）；
     * 旧规范 → 迁移面板（全部用推荐值 → 执行）。两类都是"① 开面板 → 你在面板里做完 →
     * 关掉面板 → 行消失"的形态（② 的"等面板关"就靠这一份）。
     * ⚠️ 旧规范夹具动手前先验"库是干净的迁移终态"（行不在）——否则取消不动（不迁用户存量）。
     */
    name: 'P7.13b · 撤行①·面板类：未命名起标题 / 旧规范迁移（面板做完 → 行消失）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const note = (m) => problems.push(m);
      const results = [];
      P.closeAll(4);
      await P.wait(400);
      let prevKey = null;
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      const PLACE = '03_Resources/未命名 713.md';
      const RENAMED = '03_Resources/__探针P713B改名后.md';
      const OLD = '03_Resources/__探针P713B旧规.md';
      const rmFix = async (rel) => {
        const f = app.vault.getAbstractFileByPath(KB + '/' + rel);
        if (f) await app.vault.delete(f, true);
      };
      const ntxt = (needle) => { const n = P.todoRowN(needle); return n === null ? '无' : String(n); };
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await rmFix(PLACE); await rmFix(RENAMED); await rmFix(OLD);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (nav) { P.click(nav); await P.wait(1000); }
        // ── ① 未命名 → 起标题面板（stub 给一个候选 → A → 改名）──
        {
          // ⚠️ 类型: 笔记（v2 值域内）—— 用「资料」的话夹具自己挂进「旧规范」行（首跑教训）
          await app.vault.create(KB + '/' + PLACE, '---\\n类型: 笔记\\ntags: []\\n---\\n\\n探针造的（这篇讲的是撤行判据里的改标题），用完会删。\\n');
          await P.wait(1600);
          P.stubAi(JSON.stringify({ reply: '（探针）给了个候选', titles: [{ path: PLACE, options: ['__探针P713B改名后'] }] }));
          const shown = await P.revealTodoRows(['未命名']);
          const n0 = P.todoRowN('未命名');
          if (!shown || n0 === null) note('未命名行不在');
          else {
            const clicked = await P.clickTodoAi(P.todoRow('未命名'), '①');
            if (clicked !== true) note('未命名行 ① 点不到（' + clicked + '）');
            else {
              const panel = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('AI 起标题') >= 0; }, 5000);
              if (!panel) note('起标题面板没开');
              else {
                const optA = await P.until(function () {
                  const o = P.q('.kbw-title-opt[data-key="A"]');
                  return o && P.text(o).indexOf('__探针P713B改名后') >= 0;
                }, 6000);
                if (!optA) note('候选没出来（stub 没接上？）');
                else {
                  P.click(P.q('.kbw-title-opt[data-key="A"]'));
                  await P.wait(250);
                  const runBtn = P.btnByText('改成这', P.lastModal());
                  if (!runBtn) note('面板里没有「改成这 N 篇的名字」按钮');
                  else {
                    P.click(runBtn);
                    const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('即将改') >= 0; }, 4000);
                    if (!got) note('改名确认流没弹');
                    else {
                      P.clickLastModalBtn('改这');
                      const renamed = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + RENAMED) !== null; }, 6000);
                      if (!renamed) note('没真改名（新名不在）');
                      else if (app.vault.getAbstractFileByPath(KB + '/' + PLACE)) note('老名还在（成对判）');
                      else results.push('未命名：改名成功 ✓');
                      P.key('Escape');
                      await P.wait(400);
                      const after = P.todoRowN('未命名');
                      if (!(after === null || after < n0)) note('改名后未命名行没消（' + n0 + ' → ' + after + '）');
                      else results.push('未命名行 ' + n0 + ' → ' + ntxt('未命名') + ' ✓');
                      const undo = (await P.until(function () { return !!P.lastUndo('撤销'); }, 8000)) ? P.lastUndo('撤销') : null; // 等条出现（大批量动库时它来得晚）
                      if (!undo) note('改名后没出撤销条');
                      else {
                        P.click(undo);
                        const back = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + PLACE) !== null; }, 6000);
                        if (!back) note('撤销没改回原名');
                        else results.push('未命名撤销还原 ✓');
                      }
                    }
                  }
                }
              }
            }
          }
        }
        // ── ② 旧规范 → 迁移面板（先验终态：无旧规范行才动手）──
        {
          const before = P.todoRowN('旧规范');
          if (before !== null) note('库里本来就有旧规范行（N=' + before + '）—— 跳过这一档，不动用户存量 ｜现场：' + P.text(P.todoRow('旧规范')));
          else {
            await app.vault.create(KB + '/' + OLD, '---\\n类型: 学习笔记\\ntags: []\\n主题: 探针\\n---\\n\\n探针造的旧规范夹具，用完会删。\\n');
            await P.wait(1600);
            const shown = await P.revealTodoRows(['旧规范']);
            const n0 = P.todoRowN('旧规范');
            if (!shown || n0 !== 1) note('旧规范行没出现、或不止我这一篇（N=' + n0 + '）—— 跳过');
            else {
              const clicked = await P.clickTodoAi(P.todoRow('旧规范'), '①');
              if (clicked !== true) note('旧规范行 ① 点不到（' + clicked + '）');
              else {
                const panel = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('属性迁移') >= 0; }, 5000);
                if (!panel) note('迁移面板没开');
                else {
                  const ready = await P.until(function () { return P.text(P.lastModal()).indexOf('篇要改') >= 0 || P.text(P.lastModal()).indexOf('1 篇') >= 0; }, 8000);
                  if (!ready) note('迁移预演没出结果（面板：' + P.text(P.lastModal()).slice(0, 100) + '）');
                  else {
                    P.clickByText('全部用推荐值', P.lastModal());
                    await P.wait(300);
                    const execBtn = P.btnByText('执行', P.lastModal());
                    if (!execBtn) note('迁移面板没有「执行」按钮');
                    else {
                      P.click(execBtn);
                      const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('即将改动') >= 0; }, 4000);
                      if (!got) note('迁移确认流没弹');
                      else {
                        P.clickLastModalBtn('改这');
                        const cleaned = await P.until(async function () {
                          const f = app.vault.getAbstractFileByPath(KB + '/' + OLD);
                          if (!f) return false;
                          const t = await app.vault.read(f);
                          return t.indexOf('主题') < 0 && t.indexOf('学习笔记') < 0;
                        }, 8000);
                        if (!cleaned) note('旧规范没被迁掉（读回还有旧键）');
                        else results.push('旧规范：迁移面板执行完，旧键清掉 ✓');
                        P.key('Escape');
                        await P.wait(500);
                        const after = P.todoRowN('旧规范');
                        if (after !== null) note('迁移完旧规范行还在（N=' + after + '）');
                        else results.push('旧规范行消失 ✓');
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } finally {
        P.closeAll(4);
        if (prevKey !== null) await P.setAiKey(prevKey);
        P.realAi();
        await rmFix(PLACE); await rmFix(RENAMED); await rmFix(OLD);
        await ctx.settings.save({ homeDismissed: dismissedPrev });
        await P.wait(500);
      }
      return { ok: problems.length === 0, info: results.join('；') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
    })()`,
    shot: 'P7.13b-撤行-面板类.png',
  },
  {
    /**
     * P7.13b · **② 一键完全处理**真机：把其余行全忽略（只留两条探针夹具：一条可跑
     * 的孤儿 + 一条置灰的外改）→ 块菜单一级项开跑 → 逐条串行：外改**跳过并写明原因**、
     * 孤儿**确认流 → 真挪** → 汇总「完成 1 行 / 跳过 1 行」→ 撤销还原。
     */
    name: 'P7.13b · ②一键完全处理：串行 + 外改行跳过写明原因 + 汇总（完成 X / 跳过 Y）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const problems = [];
      const results = [];
      const note = (m) => problems.push(m);
      P.closeAll(4);
      await P.wait(400);
      /*
       * 🔴 **假 key + 假传输层打底**（首跑教训）：本库配着真 key —— 清单里若有半路没
       * 被忽略掉的行（比如失效双链），①/② 的 AI 链会**真联网**。假 key 一装，
       * 任何意外行最多弹"还没配置"或读到 stub，不会打真接口。
       */
      let prevKey = null;
      P.stubAi(JSON.stringify({ reply: '（探针）不给值', locus: [] }));
      const dismissedPrev = (ctx.settings.get().homeDismissed || []).slice();
      const ORPH = '03_Resources/__探针P713B串行孤儿.png';
      const EXT = '03_Resources/__探针P713B外改.md';
      const CLEAN_DIR = '99_Meta/05_待清理';
      const rmFix = async (rel) => {
        const f = app.vault.getAbstractFileByPath(KB + '/' + rel);
        if (f) await app.vault.delete(f, true);
      };
      const allBack = function (names) {
        const files = app.vault.getFiles().map(function (f) { return f.name; });
        return names.every(function (n) { return files.indexOf(n) >= 0; });
      };
      try {
        prevKey = await P.setAiKey(P.AI_FAKE_KEY);
        await rmFix(ORPH); await rmFix(EXT);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('首页') >= 0; });
        if (nav) { P.click(nav); await P.wait(1000); }
        // 外改夹具：平台写一笔（不经插件自写登记 ⇒ 打 external-change 旗标）
        await app.vault.create(KB + '/' + EXT, '---\\n类型: 笔记\\ntags: []\\n---\\n\\n外改前。\\n');
        await app.vault.create(KB + '/' + ORPH, 'ORPHAN-BYTES-P713B-SEQ');
        await P.wait(1200);
        const extF = app.vault.getAbstractFileByPath(KB + '/' + EXT);
        if (extF) await app.vault.modify(extF, '---\\n类型: 笔记\\ntags: []\\n---\\n\\n外改后 —— 别处动过。\\n');
        await P.wait(1500);
        // 非 md 夹具（那张 png）不推索引 → 显式重扫（否则孤儿行算不到它，同 S3 的教训）
        ctx.index.rebuild();
        await P.wait(900);
        /*
         * **只留两条夹具行**（其余逐个忽略 —— 首跑只用 reveal 没做到，② 跑到了别的行：
         * 第一行直接开修链面板、还差点打真接口）。dismissAllExcept 会先把折叠展开、
         * 再把非目标行全部忽略；homeDismissed finally 原值归还。
         */
        const only = await P.dismissAllExcept(['附件没人引用', '外部改动']);
        if (!only) note('行没清干净（只该剩两条夹具行）—— 现场：' + P.qa('.kbw-todo').map(function (r) { return P.text(r).slice(0, 14); }).join(' / '));
        // 块菜单一级项开跑
        const headEl = P.q('.kbw-hblock[data-block="todo"] .kbw-sec-head');
        const hp = headEl ? P.aimAt(headEl) : null;
        if (!hp || !hp.visible) note('块头落点不可见');
        else {
          P.rightClickAt(hp.x, hp.y);
          await P.wait(500);
          if (!P.clickMenu('✦ 一键完全处理')) note('点不到块菜单「✦ 一键完全处理」');
          else {
            // 第一行（外改）静默跳过 → 第二行（孤儿）弹确认流
            const got = await P.until(function () { return !!P.lastModal() && P.text(P.lastModal()).indexOf('没人引用的附件挪到') >= 0; }, 10000);
            if (!got) note('孤儿的确认流没弹（② 的串行卡住了？现场：' + (P.lastModal() ? P.text(P.lastModal()).slice(0, 80) : '无模态') + '）');
            else {
              // 库里自带孤儿（首跑实测：封面示例.png）——照跑（用户点 ② 也是这个形态），撤销后全数回
              // ⚠️ move 类行没有 .kbw-plan-kind 格 —— 取**每行第一格**（kind 或 path），与 S3 同口径
              const names = P.qa('.kbw-plan-row').map(function (r) {
                const c = r.querySelector('.kbw-plan-kind') || r.querySelector('.kbw-plan-path');
                return c ? P.text(c).replace(/[《》]/g, '') : '';
              });
              P.clickLastModalBtn('挪这');
              const summary = await P.until(function () {
                return !!P.q('.kbw-notices') && P.text(P.q('.kbw-notices')).indexOf('一键完全处理：完成') >= 0;
              }, 12000);
              if (!summary) note('汇总通知没出（现场：' + (P.q('.kbw-notices') ? P.text(P.q('.kbw-notices')).slice(0, 120) : '无通知栈') + '）');
              else {
                const st = P.text(P.q('.kbw-notices'));
                if (st.indexOf('完成 1 行 / 跳过 1 行') < 0) note('汇总数字不对：' + st.slice(0, 140));
                else results.push('汇总「完成 1 行 / 跳过 1 行」✓');
                if (st.indexOf('亲自过目') < 0) note('外改行的跳过原因没写明：' + st.slice(0, 160));
                else results.push('外改行跳过 + 原因在明细里 ✓');
              }
              const dest = app.vault.getAbstractFileByPath(KB + '/' + CLEAN_DIR + '/__探针P713B串行孤儿.png');
              if (!dest) note('孤儿没挪到 ' + CLEAN_DIR + '/（② 没真跑完）');
              else results.push('孤儿已挪进待清理 ✓');
              const undo = (await P.until(function () { return !!P.lastUndo('撤销'); }, 8000)) ? P.lastUndo('撤销') : null; // 等条出现（大批量动库时它来得晚）
              if (!undo) note('② 跑完没出撤销条');
              else {
                P.click(undo);
                const back = await P.until(function () { return app.vault.getAbstractFileByPath(KB + '/' + ORPH) !== null; }, 8000);
                const restored = await P.until(function () { return allBack(names); }, 6000);
                if (!back) note('撤销没把孤儿挪回来');
                else if (!restored) note('撤销后还有件没回（缺：' + names.filter(function (n) {
                  const files = app.vault.getFiles().map(function (f) { return f.name; });
                  return files.indexOf(n) < 0;
                }).join('、') + '）');
                else results.push('撤销还原 ✓（含库里那件）');
              }
            }
          }
        }
      } finally {
        P.closeAll(4);
        if (prevKey !== null) await P.setAiKey(prevKey);
        P.realAi();
        await rmFix(ORPH); await rmFix(EXT);
        await ctx.settings.save({ homeDismissed: dismissedPrev });
        await P.wait(500);
      }
      return { ok: problems.length === 0, info: results.join('；') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
    })()`,
    shot: 'P7.13b-一键完全处理-汇总.png',
  },

  /* ══════════════════════════════════════════════════════════════════
     P7.23 · 反馈批 7（勾选互踩 / 拖动跟手 / 树文件行）
     ⚠️ 三条都在**自造夹具**上跑（__探针树 / __探针跟手 / __探针勾选），finally 里全清；
       动过的落盘偏好（视图档 / 自动排列 / 顺序表 / treeOpen / treeShowFiles / treeSelected）
       记一份原值、收尾原样还回去（P6② 那条纪律）。
     ══════════════════════════════════════════════════════════════════ */
  {
    name: 'P7.23 · 拖动跟手：单篇浮标 40 步偏差不累积 + 大跳 200px + scale 并串 + 松手即收',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const NL = String.fromCharCode(10);
      const DIR = '__探针跟手';
      const view0 = ctx.settings.get().notesView;
      const arrange0 = ctx.settings.get().gridAutoArrange;
      const order0 = (ctx.settings.get().gridOrder || []).slice();
      const sel0 = ctx.settings.get().treeSelected;
      const body = function (name) {
        return ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-10-11',
          'tags: []', '---', '# ' + name].join(NL) + NL;
      };
      /** 拖完会写顺序表 + 取消自动排列（都是落盘的）—— 开场记、收尾还 */
      try {
        P.closeAll(4);
        await P.wait(400);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
        if (nav) { P.click(nav); await P.wait(700); }
        // ── 夹具：__探针跟手 25 篇（**无子目录** —— 拖动路径不掠过文件夹格）
        try { await app.vault.createFolder(KB + '/' + DIR); } catch (e) { /* 已存在 */ }
        for (let i = 1; i <= 25; i += 1) {
          const rel = KB + '/' + DIR + '/笔记' + i + '.md';
          if (!app.vault.getAbstractFileByPath(rel)) await app.vault.create(rel, body('笔记' + i));
        }
        const seeded = await P.until(function () {
          return ctx.index.notes().filter(function (e) { return e.effectivePosition === DIR; }).length >= 25;
        }, 8000);
        if (!seeded) return { ok: false, info: '夹具 25 篇没进索引' };
        await P.scopeAll();
        await P.useView('网格');
        const dirNode = P.qa('.kbw-tree-item[data-drop]').find(function (i) { return i.dataset.dir === DIR; });
        if (!dirNode) return { ok: false, info: '树里找不到 ' + DIR };
        P.click(dirNode);
        await P.wait(1000);
        const cells = P.qa('.kbw-gcell[data-path]');
        if (cells.length < 25) return { ok: false, info: '网格里只有 ' + cells.length + ' 格（要 >=25）' };
        const src = P.aimAt(cells[0]);
        if (!src || !src.visible) return { ok: false, info: '起点格不在视野里' };

        // ── 起手：按下 → 过 4px 阈值 → 浮标出现（scale 必须并进同一串 transform）
        P.pointerDownAt(src.x, src.y, 'mouse');
        await P.wait(40);
        P.pointerMoveTo(src.x + 8, src.y + 4, 'mouse');
        await P.wait(120);
        const floatEl = P.q('.kbw-gfloat');
        if (!floatEl) return { ok: false, info: '过阈值之后没有单篇浮标' };
        const tr0 = floatEl.style.transform || '';
        if (tr0.indexOf('translate3d') < 0) note('浮标位移不是 transform（实际「' + tr0 + '」）');
        if (tr0.indexOf('scale(1.04)') < 0) note('起手 scale 没并进同一串 transform（实际「' + tr0 + '」）');
        const r0 = floatEl.getBoundingClientRect();
        if (!(r0.width > 0 && r0.height > 0)) note('浮标矩形量到 0（' + Math.round(r0.width) + ' x ' + Math.round(r0.height) + '）');
        /** 抓取偏移锁死之后，"浮标中心 − 指针"应当是一个恒定锚 */
        const anchor0 = { dx: r0.left + r0.width / 2 - (src.x + 8), dy: r0.top + r0.height / 2 - (src.y + 4) };

        // ── ① 对角 40 步（每步约 8px：+7 / −3，往右上走、别撞状态行）：偏差 <=4px 且后期不累积
        const errs = [];
        let px = src.x + 8;
        let py = src.y + 4;
        for (let i = 1; i <= 40; i += 1) {
          px += 7;
          py -= 3;
          P.pointerMoveTo(px, py, 'mouse');
          await P.wait(30);
          const el = P.q('.kbw-gfloat');
          if (!el) { note('第 ' + i + ' 步浮标不见了'); break; }
          const r = el.getBoundingClientRect();
          errs.push(Math.hypot(r.left + r.width / 2 - (px + anchor0.dx), r.top + r.height / 2 - (py + anchor0.dy)));
        }
        const maxOf = function (arr) { return arr.reduce(function (a, b) { return Math.max(a, b); }, 0); };
        const maxAll = errs.length > 0 ? maxOf(errs) : 999;
        if (errs.length === 0) note('40 步一步都没量到');
        else {
          if (maxAll > 4) note('跟手偏差超过 4px（最大 ' + maxAll.toFixed(1) + 'px）');
          const early = maxOf(errs.slice(0, 10));
          const late = maxOf(errs.slice(-10));
          if (late > early + 2) note('偏差在累积增大（前 10 步 ' + early.toFixed(1) + 'px → 后 10 步 ' + late.toFixed(1) + 'px）');
        }

        // ── ② 大跳 200px：一帧内仍 <=4px
        P.pointerMoveTo(px + 200, py, 'mouse');
        await P.wait(30);
        const elJ = P.q('.kbw-gfloat');
        if (!elJ) note('大跳之后浮标不见了');
        else {
          const rj = elJ.getBoundingClientRect();
          const devJ = Math.hypot(rj.left + rj.width / 2 - (px + 200 + anchor0.dx), rj.top + rj.height / 2 - (py + anchor0.dy));
          if (devJ > 4) note('大跳 200px 后偏差 ' + devJ.toFixed(1) + 'px（>4）');
        }

        // ── ④ 松手：浮标与空档都收掉
        P.pointerUpAt(px + 200, py, 'mouse');
        await P.wait(700);
        if (P.q('.kbw-gfloat')) note('松手后浮标还在（悬挂）');
        if (P.q('.kbw-gap')) note('松手后空档还在');
        return {
          ok: problems.length === 0,
          info: '40 步最大偏差 ' + (errs.length > 0 ? maxAll.toFixed(1) : '-') + 'px（上限 4）' +
            '｜scale 并串 ' + (tr0.indexOf('scale(1.04)') >= 0 ? '✓' : '✗') +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        // 视图档 / 自动排列 / 顺序表 / **树选中** 全是落盘偏好，原样还回去（P6② 那条纪律；
        // treeSelected 是独立审 🟡3 补的 —— 点了夹具目录节点就会落盘指过去，删了夹具就成死引用）
        await ctx.settings.save({ gridAutoArrange: arrange0, gridOrder: order0, treeSelected: sel0 });
        await P.wait(400);
        if (view0) await ctx.settings.save({ notesView: view0 });
        const f = app.vault.getAbstractFileByPath(KB + '/' + DIR);
        if (f) await app.vault.delete(f, true);
        await P.wait(700);
      }
    })()`,
    shot: 'P7.23-拖动跟手.png',
  },
  {
    name: 'P7.23 · 勾选互踩：命中区 29px + 连勾三格 = 3 + 重建（自动排列切换）后勾选态保持',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const NL = String.fromCharCode(10);
      const DIR = '__探针勾选';
      const arrange0 = ctx.settings.get().gridAutoArrange;
      const order0 = (ctx.settings.get().gridOrder || []).slice();
      const sel0 = ctx.settings.get().treeSelected;
      const view0 = ctx.settings.get().notesView;
      const body = function (name) {
        return ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-10-11',
          'tags: []', '---', '# ' + name].join(NL) + NL;
      };
      /** 纪律：任何时刻 DOM 勾选态 == 选中态（本轮 M1 的机器化定义） */
      const consistency = function () {
        return P.qa('.kbw-gcell[data-path]').filter(function (c) {
          const b = c.querySelector('.kbw-rowcheck');
          return b && (b.checked !== c.classList.contains('is-selected'));
        }).length;
      };
      const checkedCount = function () {
        return P.qa('.kbw-gcell[data-path]').filter(function (c) {
          const b = c.querySelector('.kbw-rowcheck');
          return b && b.checked;
        }).length;
      };
      try {
        P.closeAll(4);
        await P.wait(400);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
        if (nav) { P.click(nav); await P.wait(700); }
        try { await app.vault.createFolder(KB + '/' + DIR); } catch (e) { /* 已存在 */ }
        for (let i = 1; i <= 6; i += 1) {
          const rel = KB + '/' + DIR + '/笔记' + i + '.md';
          if (!app.vault.getAbstractFileByPath(rel)) await app.vault.create(rel, body('笔记' + i));
        }
        const seeded = await P.until(function () {
          return ctx.index.notes().filter(function (e) { return e.effectivePosition === DIR; }).length >= 6;
        }, 8000);
        if (!seeded) return { ok: false, info: '夹具 6 篇没进索引' };
        await P.scopeAll();
        await P.useView('网格');
        const dirNode = P.qa('.kbw-tree-item[data-drop]').find(function (i) { return i.dataset.dir === DIR; });
        if (!dirNode) return { ok: false, info: '树里找不到 ' + DIR };
        P.click(dirNode);
        await P.wait(1000);
        const cells = P.qa('.kbw-gcell[data-path]');
        if (cells.length < 4) return { ok: false, info: '网格里只有 ' + cells.length + ' 格（要 >=4）' };

        // ── 命中区/视觉尺寸（P7.23：29x29 命中、15px 视觉 —— 双边判据）
        const gcb = cells[0].querySelector('.kbw-gcb');
        const box = cells[0].querySelector('.kbw-rowcheck');
        if (!gcb || !box) return { ok: false, info: '格子里没有勾选框（.kbw-gcb / .kbw-rowcheck）' };
        const gw = gcb.offsetWidth;
        const gh = gcb.offsetHeight;
        /** ⚠️ 视觉框宽度**当场取一份**再进 info —— 重画之后旧节点脱离文档，offsetWidth 读回 0
         *（首跑 info 里那句"视觉框 0"就是这么来的：当场断言是对的、事后读的是死节点） */
        const bw = box.offsetWidth;
        if (!(gw >= 25 && gw <= 33)) note('勾选框命中区宽=' + gw + '（要 25–33，目标 29）');
        if (!(gh >= 25 && gh <= 33)) note('勾选框命中区高=' + gh + '（要 25–33，目标 29）');
        if (bw > 16) note('视觉小框被撑大了（' + bw + 'px，应为 15）');

        // ── ① 快节奏连勾三格（点命中区本身 = 框周围留白也算点框）
        for (let i = 0; i < 3; i += 1) {
          const g = P.qa('.kbw-gcell[data-path]')[i].querySelector('.kbw-gcb');
          P.click(g);
          await P.wait(60);
        }
        const selN = P.qa('.kbw-gcell.is-selected').length;
        if (selN !== 3) note('连勾三格之后选中数=' + selN + '（要 3）');
        if (checkedCount() !== 3) note('勾选数=' + checkedCount() + '（要 3）');
        const batchN = P.q('.kbw-batch-count') ? P.text(P.q('.kbw-batch-count')) : '';
        if (batchN.indexOf('已选 3 篇') < 0) note('批量栏没写「已选 3 篇」（实际「' + batchN + '」）');

        // ── ② 重建之后不许丢：切「自动排列」= 列表整块重画（M1 的现形点，P7.23 修）
        const chk = P.q('.kbw-sortbar .kbw-chk');
        if (!chk) note('没有「自动排列」勾选框（切重建验不了）');
        else {
          P.click(chk);
          await P.wait(600);
          const c1 = consistency();
          if (c1 > 0) note('重建后勾选态与选中态不一致：' + c1 + ' 格（M1 复发）');
          if (checkedCount() !== 3) note('重建后勾选数=' + checkedCount() + '（要 3）');
          if (P.qa('.kbw-gcell.is-selected').length !== 3) note('重建后选中数变了');
          P.click(chk); // 切回去（模块态与落盘都回到原值附近）
          await P.wait(500);
        }

        // ── 清场：清选择（批量栏的 ✕）
        const batch = P.q('.kbw-notes-bar.is-batch');
        if (batch) {
          const x = Array.from(batch.querySelectorAll('button')).find(function (b) {
            return (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0;
          });
          if (x) { P.click(x); await P.wait(300); }
        }
        return {
          ok: problems.length === 0,
          info: '命中区 ' + gw + ' x ' + gh + '（视觉框 ' + bw + '）· 连勾 3 格=3 · 重建后一致 ' +
            (consistency() === 0 ? '✓' : '✗') +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        // 同「拖动跟手」步：落盘偏好原样还（含 treeSelected —— 独立审 🟡3）
        await ctx.settings.save({ gridAutoArrange: arrange0, gridOrder: order0, treeSelected: sel0 });
        await P.wait(400);
        if (view0) await ctx.settings.save({ notesView: view0 });
        const f = app.vault.getAbstractFileByPath(KB + '/' + DIR);
        if (f) await app.vault.delete(f, true);
        await P.wait(700);
      }
    })()`,
    shot: 'P7.23-勾选互踩.png',
  },
  {
    name: 'P7.23 · 树文件行：完全展开列文件行 + 拖一行进目录节点真搬 + 撤销还原',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const NL = String.fromCharCode(10);
      const DIR = '__探针树';
      const open0 = (ctx.settings.get().treeOpen || []).slice();
      const files0 = (ctx.settings.get().treeShowFiles || []).slice();
      const sel0 = ctx.settings.get().treeSelected;
      const body = function (name) {
        return ['---', '类型: 想法', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-10-11',
          'tags: []', '---', '# ' + name].join(NL) + NL;
      };
      const fileRows = function () { return P.qa('.kbw-tree-file'); };
      try {
        P.closeAll(4);
        await P.wait(400);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
        if (nav) { P.click(nav); await P.wait(700); }
        // ── 夹具：__探针树/A/甲.md + __探针树/A/B/乙.md（两层，够验"递归展开 + 文件行"）
        for (const d of [DIR, DIR + '/A', DIR + '/A/B']) {
          try { await app.vault.createFolder(KB + '/' + d); } catch (e) { /* 已存在 */ }
        }
        const jia = KB + '/' + DIR + '/A/甲.md';
        const yi = KB + '/' + DIR + '/A/B/乙.md';
        if (!app.vault.getAbstractFileByPath(jia)) await app.vault.create(jia, body('甲'));
        if (!app.vault.getAbstractFileByPath(yi)) await app.vault.create(yi, body('乙'));
        const seeded = await P.until(function () {
          return !!app.vault.getAbstractFileByPath(jia) && !!app.vault.getAbstractFileByPath(yi) &&
            ctx.index.notes().filter(function (e) { return e.effectivePosition.indexOf(DIR) === 0; }).length >= 2;
        }, 8000);
        if (!seeded) return { ok: false, info: '夹具没进索引' };

        // ── 右键 __探针树 节点 →「完全展开（含所有子文件夹与文件）」
        const node0 = P.qa('.kbw-tree-item[data-drop]').find(function (i) { return i.dataset.dir === DIR; });
        if (!node0) return { ok: false, info: '树里找不到 ' + DIR };
        const b0 = P.aimAt(node0);
        if (!b0 || !b0.visible) return { ok: false, info: '节点不在视野里' };
        P.rightClickAt(b0.x, b0.y);
        await P.wait(500);
        const menuUp = P.qa('.kbw-menu-item').some(function (i) { return P.text(i).indexOf('完全展开') >= 0; });
        if (!menuUp) return { ok: false, info: '节点菜单里没有「完全展开」' };
        if (!P.clickAny('完全展开')) return { ok: false, info: '点不到「完全展开」' };
        await P.wait(800);

        // ── ① 文件行出现（递归两层都要有）+ 排在子目录之后
        const rowsNow = fileRows();
        const names = rowsNow.map(function (r) { return P.text(r); }).join('|');
        if (rowsNow.length < 2) note('完全展开后文件行只有 ' + rowsNow.length + ' 条（要 2：甲 + 乙）');
        if (names.indexOf('甲') < 0 || names.indexOf('乙') < 0) note('文件行里找不到 甲/乙（实际「' + names + '」）');
        const nodeB = P.qa('.kbw-tree-item[data-drop]').find(function (i) { return i.dataset.dir === DIR + '/A/B'; });
        if (!nodeB) note('B 的目录行没出现（递归没生效）');

        // ── ② 拖「甲」那一行到 __探针树 节点上 = 真搬（mover + 撤销条）
        const rowJia = fileRows().find(function (r) { return P.text(r) === '甲'; });
        if (!rowJia) return { ok: false, info: '找不到「甲」的文件行' };
        const a = P.aimAt(rowJia);
        const tgt = P.qa('.kbw-tree-item[data-drop]').find(function (i) { return i.dataset.dir === DIR; });
        const bT = P.rectAt(tgt);
        if (!a || !a.visible || !bT || !bT.visible) return { ok: false, info: '拖动源/目标不在视野里' };
        P.pointerDownAt(a.x, a.y, 'mouse');
        await P.wait(40);
        P.pointerMoveTo(a.x + 24, a.y + 6, 'mouse');
        await P.wait(120);
        const ghostUp = !!P.q('.kbw-dragghost');
        if (!ghostUp) note('拖过阈值没有药丸（拖动没起来）');
        const rowHot = !!(P.q('.kbw-tree-file.is-dragging'));
        if (!rowHot) note('拖动中的文件行没有 is-dragging 观感');
        P.pointerMoveTo(bT.x, bT.y, 'mouse');
        await P.wait(200);
        const dropHot = !!P.q('.kbw-tree-item.is-drop');
        if (!dropHot) note('掠过目录节点没有落点高亮');
        P.pointerUpAt(bT.x, bT.y, 'mouse');
        const moved = await P.until(function () { return !!app.vault.getAbstractFileByPath(KB + '/' + DIR + '/甲.md'); }, 8000);
        if (!moved) note('拖到目录节点之后文件没搬过去（' + DIR + '/甲.md 不在）');
        const stale = !!app.vault.getAbstractFileByPath(jia);
        if (stale) note('旧位置的文件还在（不是搬、是复制？）');
        const undo = P.lastUndo('撤销');
        if (!undo) note('搬完没有撤销条');
        else {
          P.click(undo);
          const back = await P.until(function () { return !!app.vault.getAbstractFileByPath(jia); }, 8000);
          if (!back) note('撤销没能把文件放回原位');
        }
        // 停在树上（截图拍这一屏）
        await P.wait(500);
        return {
          ok: problems.length === 0,
          info: '文件行 ' + rowsNow.length + ' 条（' + names + '）· 拖动药丸 ' + ghostUp + ' · 落点高亮 ' + dropHot +
            ' · 真搬 ' + (moved && !stale ? '✓' : '✗') + ' · 撤销还原 ' + (undo ? (app.vault.getAbstractFileByPath(jia) ? '✓' : '✗') : '无撤销条') +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        await ctx.settings.save({ treeOpen: open0, treeShowFiles: files0, treeSelected: sel0 });
        await P.wait(400);
        for (const rel of [DIR + '/A/甲.md', DIR + '/A/B/乙.md', DIR + '/甲.md']) {
          const f = app.vault.getAbstractFileByPath(KB + '/' + rel);
          if (f) await app.vault.delete(f, true);
        }
        for (const d of [DIR + '/A/B', DIR + '/A', DIR]) {
          const f = app.vault.getAbstractFileByPath(KB + '/' + d);
          if (f) await app.vault.delete(f, true);
        }
        await P.wait(700);
      }
    })()`,
    shot: 'P7.23-树文件行.png',
  },
  /**
   * **P7.24 · 树收口**（用户 2026-10-11 真机手验点名的三件）：
   *  · T1：完全展开后行尾「收起」真点 —— 子树行/文件行全收、按钮消失；
   *  · T3：根菜单「全部收起」—— **连根一起收**（只剩「整个知识库」一行）。
   *  T2（点根 caret 真收真开）在下一条。
   */
  {
    name: 'P7.24 · 树收口 T1+T3：行尾「收起」真点收子树 · 根菜单「全部收起」只剩根一行',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const NL = String.fromCharCode(10);
      const DIR = '__探针收';
      const open0 = (ctx.settings.get().treeOpen || []).slice();
      const files0 = (ctx.settings.get().treeShowFiles || []).slice();
      const sel0 = ctx.settings.get().treeSelected;
      const body = function (name) {
        return ['---', '类型: 想法', '创建日期: 2026-10-11', 'tags: []', '---', '# ' + name].join(NL) + NL;
      };
      const nodeOf = function (dir) {
        return P.qa('.kbw-tree-item[data-drop]').find(function (i) { return i.dataset.dir === dir; });
      };
      const allDirsNow = function () {
        return P.qa('.kbw-tree-item[data-drop]').map(function (i) { return i.dataset.dir; });
      };
      const jia = KB + '/' + DIR + '/A/甲.md';
      try {
        P.closeAll(4);
        await P.wait(400);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
        if (nav) { P.click(nav); await P.wait(700); }
        for (const d of [DIR, DIR + '/A']) {
          try { await app.vault.createFolder(KB + '/' + d); } catch (e) { /* 已存在 */ }
        }
        if (!app.vault.getAbstractFileByPath(jia)) await app.vault.create(jia, body('甲'));
        const seeded = await P.until(function () {
          return !!app.vault.getAbstractFileByPath(jia) &&
            ctx.index.notes().some(function (e) { return e.path === jia; });
        }, 8000);
        if (!seeded) return { ok: false, info: '夹具没进索引' };
        /* 起手根得是开的（基线步保根开；这里双保险再点一下） */
        if ((ctx.settings.get().treeOpen || []).indexOf('') < 0) {
          const r0 = nodeOf('');
          if (r0) { P.click(r0.querySelector('.kbw-tree-caret')); await P.wait(600); }
        }
        let node = nodeOf(DIR);
        if (!node) return { ok: false, info: '树里找不到 ' + DIR };
        const b0 = P.aimAt(node);
        if (!b0 || !b0.visible) return { ok: false, info: '节点不在视野里' };
        P.rightClickAt(b0.x, b0.y);
        await P.wait(500);
        if (!P.clickAny('完全展开')) return { ok: false, info: '点不到「完全展开」' };
        await P.wait(800);

        // ① 行尾「收起」按钮：展开态在；未展开的目录不画它（99_Meta 被谁扩过就跳过这条）
        node = nodeOf(DIR);
        const btn = node ? node.querySelector('.kbw-tree-collapse') : null;
        if (!btn) note('展开态的行尾没有「收起」按钮');
        const metaExpanded = (ctx.settings.get().treeOpen || []).indexOf('99_Meta') >= 0 ||
          (ctx.settings.get().treeShowFiles || []).indexOf('99_Meta') >= 0;
        const other = nodeOf('99_Meta');
        if (!metaExpanded && other && other.querySelector('.kbw-tree-collapse')) {
          note('未展开的 99_Meta 也画了「收起」（显示条件错了）');
        }
        const filesBefore = P.qa('.kbw-tree-file').length;
        let kidGone = null;
        let stillBtn = null;
        if (btn) {
          P.click(btn);
          await P.wait(700);
          kidGone = !nodeOf(DIR + '/A');
          const node2 = nodeOf(DIR);
          stillBtn = !!(node2 && node2.querySelector('.kbw-tree-collapse'));
          if (!kidGone) note('点了「收起」但子目录 A 的行还在');
          if (P.qa('.kbw-tree-file').length !== 0) note('点了「收起」但文件行还在');
          if (stillBtn) note('收起后按钮没消失');
        }

        // ② 根菜单「全部收起」：连根一起收 —— 只剩根一行
        const rootNode = nodeOf('');
        let restLen = null;
        if (!rootNode) {
          note('根行不在');
        } else {
          const rb = P.aimAt(rootNode);
          if (!rb || !rb.visible) {
            note('根行不在视野里');
          } else {
            P.rightClickAt(rb.x, rb.y);
            await P.wait(500);
            if (!P.clickAny('全部收起')) {
              note('根菜单里没有「全部收起」');
            } else {
              await P.wait(700);
              const rest = allDirsNow();
              restLen = rest.length;
              if (rest.length !== 1 || rest[0] !== '') {
                note('「全部收起」之后树不止根一行（实际 ' + JSON.stringify(rest) + '）');
              }
            }
          }
        }
        await P.wait(400);
        return {
          ok: problems.length === 0,
          info: '收起前文件行=' + filesBefore +
            ' · 点钮：子目录行没了=' + kidGone + ' 按钮消失=' + (stillBtn === null ? '(没钮可点)' : !stillBtn) +
            ' · 全部收起后行数=' + restLen +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        await ctx.settings.save({ treeOpen: open0, treeShowFiles: files0, treeSelected: sel0 });
        await P.wait(400);
        /* ⚠️ settings.save 只恢复落盘值、**不会推给活模块**（笔记模块的 store 是自己一份，
           main 的 applySettingsToStore 只管 activeModule/modules/lastSnapshotAt）——
           按 open0 的根态把 live 树**点回来**，否则后续步看到的是"收着的树"（P7.24 实测栽过） */
        const wantRootOpen = open0.indexOf('') >= 0;
        const rAlign = nodeOf('');
        const nowOpen = rAlign ? rAlign.getAttribute('aria-expanded') === 'true' : false;
        if (rAlign && wantRootOpen !== nowOpen) {
          P.click(rAlign.querySelector('.kbw-tree-caret'));
          await P.wait(600);
        }
        const f = app.vault.getAbstractFileByPath(jia);
        if (f) await app.vault.delete(f, true);
        for (const d of [DIR + '/A', DIR]) {
          const g = app.vault.getAbstractFileByPath(KB + '/' + d);
          if (g) await app.vault.delete(g, true);
        }
        await P.wait(700);
      }
    })()`,
    shot: 'P7.24-树收起.png',
  },
  {
    name: 'P7.24 · 树收口 T2：根 caret 真收真开（只剩根一行 → 恢复）· 落盘记忆',
    script: `(async () => {
      const P = window.__kbwProbe;
      const problems = [];
      const note = (m) => problems.push(m);
      const ctx = P.ctx();
      const open0 = (ctx.settings.get().treeOpen || []).slice();
      const files0 = (ctx.settings.get().treeShowFiles || []).slice();
      const nodeOf = function (dir) {
        return P.qa('.kbw-tree-item[data-drop]').find(function (i) { return i.dataset.dir === dir; });
      };
      const allDirsNow = function () {
        return P.qa('.kbw-tree-item[data-drop]').map(function (i) { return i.dataset.dir; });
      };
      try {
        P.closeAll(4);
        await P.wait(400);
        const nav = P.qa('.kbw-navitem').find(function (b) { return P.text(b).indexOf('全部笔记') >= 0; });
        if (nav) { P.click(nav); await P.wait(700); }
        /* ⚠️ 起手按 **DOM 自证**（**不查 settings** —— 上一步 finally 的 save 只写落盘值、
           不同步活模块的 store，settings 说"开着"而树其实收着 —— P7.24 实测栽过这条）；
           根要是收着的，先点开 */
        let root = nodeOf('');
        if (!root) return { ok: false, info: '根行不在' };
        if (root.getAttribute('aria-expanded') !== 'true') {
          P.click(root.querySelector('.kbw-tree-caret'));
          await P.wait(700);
        }
        const before = allDirsNow().length;
        if (before < 2) note('起手树里顶层行太少（' + before + '）—— 先看基线');
        // ① 点根 caret → 只剩根一行 + 落盘
        root = nodeOf('');
        if (!root) return { ok: false, info: '点收：根行找不到了' };
        P.click(root.querySelector('.kbw-tree-caret'));
        await P.wait(700);
        const after = allDirsNow();
        if (after.length !== 1 || after[0] !== '') {
          note('点根 caret 之后该只剩根一行（实际 ' + JSON.stringify(after) + '）');
        }
        const persisted = await P.until(function () {
          return (ctx.settings.get().treeOpen || []).indexOf('') < 0;
        }, 3000);
        if (!persisted) note('收起没有落盘（treeOpen 里空串还在）');
        // ② 再点 → 顶层行全数回来 + 落盘
        root = nodeOf('');
        if (!root) {
          note('再开：根行找不到了');
        } else {
          P.click(root.querySelector('.kbw-tree-caret'));
          await P.wait(700);
          const back = allDirsNow().length;
          if (back < before) note('再点回来顶层行没恢复（' + back + ' < ' + before + '）');
          const persistedBack = await P.until(function () {
            return (ctx.settings.get().treeOpen || []).indexOf('') >= 0;
          }, 3000);
          if (!persistedBack) note('展开没有落盘（treeOpen 里空串不在）');
        }
        return {
          ok: problems.length === 0,
          info: '起手顶层 ' + before + ' 行 · 收起后 ' + after.length + ' 行 · 再开 ' + allDirsNow().length + ' 行' +
            (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全部通过 ✓'),
        };
      } finally {
        await ctx.settings.save({ treeOpen: open0, treeShowFiles: files0 });
        await P.wait(400);
        /* 同 T1+T3 步：settings.save 不推活模块 —— 按 open0 的根态把 live 树点对齐 */
        const wantRootOpen = open0.indexOf('') >= 0;
        const rAlign = nodeOf('');
        const nowOpen = rAlign ? rAlign.getAttribute('aria-expanded') === 'true' : false;
        if (rAlign && wantRootOpen !== nowOpen) {
          P.click(rAlign.querySelector('.kbw-tree-caret'));
          await P.wait(600);
        }
      }
    })()`,
    shot: 'P7.24-根收起.png',
  },

  // ══════════════════════════════════════════════════════════════
  // P8 · 回顾（期 2 数据 + 手动建卡 / 期 3 复习流程 / 期 4 AI 出稿）
  //
  // 为什么必须上真机（外部交付线计划 §5.3 点名 + 期 3 独立审的结论，移植时原样保留）：
  //   · 期 2/3 的**迁键**（改笔记名 → 卡片的 note 跟着走）只有真机上才现形
  //   · 期 3 浮层的**焦点与键送达**离线判据**咬不住**（jsdom 不复现"禁用一个已聚焦控件
  //     会把焦点弹走"这条 Chromium 行为 —— 实测：拆掉 keepFocus()，离线用例仍然绿）
  //   · 「今日/全部」头部与浮层几何，离线只有字符串判据
  //
  // 夹具一律 `__探针回顾*`（跑完按标记兜底清场会扫它们）+ **每条自己收场**。
  // 卡片落点是**库内** `99_Meta/06_工作台/复习.json`；断言读 `ctx.review.load()`
  //（与面板/服务同一条读盘路径），不是去翻文件找字符串。
  //
  // ⚠️ **模板字面量里换行要转义两次**：这条脚本本身住在反引号模板里，
  //    所以 `join('\\n')` 在这儿必须写成 `join('\\\\n')` —— 只写一个反斜杠，
  //    求值出来的页面代码里就是**一个真换行**，整条步骤当场 SyntaxError
  //（外部交付线踩过：四条一起报 Invalid or unexpected token，而 lint:probe 不咬这一条）。
  //
  // ⏳ **本批五步尚未在本机真机跑过**（随交接 §6 的欠账 —— 下一轮跑一遍即清）。
  // ══════════════════════════════════════════════════════════════
  {
    name: 'P8 期 2 · 建卡链：笔记右键「生成回顾卡」→ 对话框 → 确认流 → 落库（来源笔记逐字节不变）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const results = [];
      const REL = at('00_Inbox/__探针回顾.md');
      P.closeAll(4);
      await P.wait(300);

      /* 夹具：一篇带前言的笔记（写盘走平台口） */
      const body = [
        '---', '类型: 笔记', '状态: 进行中', '创建日期: 2026-10-10',
        '文件位置:', '  - ' + (KB ? '00_Inbox' : ''), '收藏: false', 'tags: []', '---', '',
        '# __探针回顾', '', '这一篇用来验「建卡链」。', '',
      ].join('\\n');
      const old = app.vault.getAbstractFileByPath(REL);
      if (old) await app.vault.delete(old);
      await app.vault.create(REL, body);
      ctx.index.rebuild();
      await P.wait(700);
      const beforeText = await app.vault.read(app.vault.getAbstractFileByPath(REL));

      P.clickByText('全部笔记', P.q('.kbw-navitems'));
      await P.wait(600);
      /**
       * ⚠️ 让夹具那一行**真的在表里**（外部交付线首跑栽过："找不到夹具那一行"）：
       *   ① 列表画的是**当前目录**的笔记 —— 上一轮可能停在别处 → 用产品自己的导航落到 00_Inbox
       *   ② 表格档才有 .kbw-trow（网格档是 .kbw-gcell）→ 先切「详细信息」
       * ⚠️ 这条注释本身住在**模板字面量**里：里面**不许出现反引号** —— 类名一律裸写或加「」。
       */
      await P.useView('详细信息');
      ctx.goNotes({ dir: '00_Inbox' });
      await P.wait(1000);
      const row = P.rowByPath(REL);
      if (!row) { const f = app.vault.getAbstractFileByPath(REL); if (f) await app.vault.delete(f); return { ok: false, info: '「全部笔记」里找不到夹具那一行（索引没跟上？）' }; }
      const r = row.getBoundingClientRect();
      P.rightClickAt(r.left + 40, r.top + r.height / 2);
      await P.wait(600);
      /**
       * ⚠️ **两条回顾卡入口收进了一个子菜单**（P8 期 4 收尾：笔记菜单一级最多 8 项）——
       * 所以先认父项「回顾卡」，**点开它**再点子项；子菜单里的项点开父项之前不在 DOM 里。
       */
      const menuText = P.text(P.lastMenu());
      const menuHas = menuText.indexOf('回顾卡') >= 0;
      if (!menuHas) { P.closeAll(4); const f0 = app.vault.getAbstractFileByPath(REL); if (f0) await app.vault.delete(f0); return { ok: false, info: '笔记右键菜单里没有「回顾卡」那一项（实际：' + menuText.slice(0, 90) + '）' }; }
      P.clickMenu('回顾卡');
      await P.wait(400);
      if (!P.clickMenu('生成回顾卡')) { P.closeAll(4); const f0b = app.vault.getAbstractFileByPath(REL); if (f0b) await app.vault.delete(f0b); return { ok: false, info: '子菜单里没有「生成回顾卡」' }; }
      await P.wait(700);
      const dlg = P.lastModal();
      if (!dlg) { P.closeAll(4); const f1 = app.vault.getAbstractFileByPath(REL); if (f1) await app.vault.delete(f1); return { ok: false, info: '建卡对话框没开出来' }; }
      const tas = P.qa('.kbw-review-input', dlg);
      if (tas.length !== 2) { P.closeAll(4); const f2 = app.vault.getAbstractFileByPath(REL); if (f2) await app.vault.delete(f2); return { ok: false, info: '对话框里不是两栏（实际 ' + tas.length + '）' }; }
      tas[0].value = '真机问句';
      tas[1].value = '真机答句';
      P.clickByText('下一步', dlg);
      await P.wait(700);

      const cf = P.lastModal();
      if (!cf) { P.closeAll(4); const f3 = app.vault.getAbstractFileByPath(REL); if (f3) await app.vault.delete(f3); return { ok: false, info: '确认流没开（硬规矩 #3：动库前必须过 confirm）' }; }
      const cfText = P.text(cf);
      const sawFaces = cfText.indexOf('真机问句') >= 0 && cfText.indexOf('真机答句') >= 0;
      if (!sawFaces) note('确认单里看不到正反面（预览那一块没画？）');
      if (cfText.indexOf('不拍快照') < 0) note('确认单没把"不拍快照"那句换成真话');
      P.clickByText('新建这张卡', cf);
      await P.wait(800);

      const file = await ctx.review.load();
      const card = (file.cards || []).find((c) => c.note === REL);
      const landed = !!card && card.front === '真机问句' && card.back === '真机答句';
      if (!landed) note('卡片没落进 复习.json（现在 ' + (file.cards || []).length + ' 张）');

      const afterText = await app.vault.read(app.vault.getAbstractFileByPath(REL));
      const bytesSame = afterText === beforeText;
      if (!bytesSame) note('来源笔记被改了（应当逐字节不变）');

      results.push('菜单里有「生成回顾卡」=' + menuHas + '｜两栏=' + (tas.length === 2) +
        '｜确认单见正反面=' + sawFaces + '｜落库=' + landed + '｜来源笔记逐字节不变=' + bytesSame);

      if (card) await ctx.review.removeCard(card.id);
      const f4 = app.vault.getAbstractFileByPath(REL);
      if (f4) await app.vault.delete(f4);
      await P.wait(300);
      const left = (await ctx.review.load()).cards.filter((c) => c.note === REL).length;
      if (left !== 0) note('自清理没干净（还剩 ' + left + ' 张）');

      return { ok: problems.length === 0, info: results.join('') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
    })()`,
  },
  {
    name: 'P8 期 2 · 面板：列表 / 头部计数 / 今日筛选 / 删除走确认流（取消不动 → 两下确认才删）',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const results = [];
      const REL = at('00_Inbox/__探针回顾面板.md');
      const body = ['---', '类型: 笔记', '状态: 进行中', '创建日期: 2026-10-10', '文件位置:', '  - ' + (KB ? '00_Inbox' : ''), '收藏: false', 'tags: []', '---', '', '# __探针回顾面板', ''].join('\\n');
      const cleanup = async () => {
        for (const c of (await ctx.review.load()).cards.filter((x) => x.note === REL)) await ctx.review.removeCard(c.id);
        const f = app.vault.getAbstractFileByPath(REL);
        if (f) await app.vault.delete(f);
        await P.wait(300);
      };
      P.closeAll(4);
      await P.wait(300);

      const old = app.vault.getAbstractFileByPath(REL);
      if (old) await app.vault.delete(old);
      await app.vault.create(REL, body);
      await ctx.review.addCard({ note: REL, front: '面板问句一', back: '面板答句一' });
      await ctx.review.addCard({ note: REL, front: '面板问句二', back: '面板答句二' });
      ctx.index.rebuild();
      await P.wait(700);

      P.clickByText('回顾', P.q('.kbw-navitems'));
      await P.wait(900);
      if (!P.q('.kbw-review')) { await cleanup(); return { ok: false, info: '「回顾」栏没挂上' }; }
      const head = P.text(P.q('.kbw-review-head'));
      const rows = P.qa('.kbw-review-row').filter((el) => P.text(el).indexOf('面板问句') >= 0);
      results.push('头部=' + head.slice(0, 70) + '｜本夹具行数=' + rows.length);
      if (rows.length !== 2) note('列表里没画出两张卡（实际 ' + rows.length + '）');
      const startBtn = P.q('.kbw-review-start');
      if (!startBtn) note('头部没有「开始复习」');
      else if (startBtn.hasAttribute('disabled')) note('有到期卡时「开始复习」不该置灰');
      const scope = P.text(P.q('.kbw-review-scope'));
      if (scope.indexOf('今日 2') < 0 || scope.indexOf('全部 2') < 0) note('档位开关数字不对（实际：' + scope + '）');

      /* 删除①：取消 → 卡还在 */
      const pickDel = () => P.qa('.kbw-review-del').filter((b) => {
        const rowEl = b.closest('.kbw-review-row');
        return rowEl && P.text(rowEl).indexOf('面板问句') >= 0;
      })[0];
      const del = pickDel();
      if (!del) note('找不到删除按钮');
      else {
        P.click(del);
        await P.wait(700);
        const cf = P.lastModal();
        if (!cf || P.text(cf).indexOf('面板问句') < 0) note('删除没走确认流 / 确认单里看不到是哪一张');
        if (cf) { P.clickByText('取消', cf); await P.wait(600); }
        const still = (await ctx.review.load()).cards.filter((c) => c.note === REL).length;
        if (still !== 2) note('取消之后卡少了（应当还是 2，实际 ' + still + '）');

        /* 删除②：两下确认 → 真删一张 */
        const del2 = pickDel();
        P.click(del2);
        await P.wait(700);
        const cf2 = P.lastModal();
        if (!cf2) note('第二次删除没弹确认流');
        else {
          P.clickByText('删除这张卡', cf2);
          await P.wait(400);
          P.clickByText('再点一次删除', P.lastModal() || cf2);
          await P.wait(800);
        }
        const after = (await ctx.review.load()).cards.filter((c) => c.note === REL).length;
        if (after !== 1) note('两下确认之后应当是 1 张（实际 ' + after + '）');
        results.push('删除：取消不动（2 张）→ 两下确认 → 剩 ' + after + ' 张');
      }

      await cleanup();
      return { ok: problems.length === 0, info: results.join('｜') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
    })()`,
  },
  {
    /**
     * ⚠️ **要可见窗口**（这条带截图）：最小化时几何与截图都拿不到真值 ——
     * 跑之前的 `probe:launch` 用 `KBW_LAUNCH_MIN=0`。
     */
    name: 'P8 期 3 · 复习浮层：翻面 → 三键 → 小结；**焦点与键送达**（离线咬不住的那条）+ 几何',
    shot: 'P8-回顾-复习浮层.png',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const results = [];
      const REL = at('00_Inbox/__探针回顾复习.md');
      const SESSION = '.kbw-review-session';
      const body = ['---', '类型: 笔记', '状态: 进行中', '创建日期: 2026-10-10', '文件位置:', '  - ' + (KB ? '00_Inbox' : ''), '收藏: false', 'tags: []', '---', '', '# __探针回顾复习', ''].join('\\n');
      const cleanup = async () => {
        for (const c of (await ctx.review.load()).cards.filter((x) => x.note === REL)) await ctx.review.removeCard(c.id);
        const f = app.vault.getAbstractFileByPath(REL);
        if (f) await app.vault.delete(f);
        await P.wait(300);
      };
      P.closeAll(4);
      await P.wait(300);

      const old = app.vault.getAbstractFileByPath(REL);
      if (old) await app.vault.delete(old);
      await app.vault.create(REL, body);
      const c1 = await ctx.review.addCard({ note: REL, front: '浮层正面一', back: '浮层背面一' });
      const c2 = await ctx.review.addCard({ note: REL, front: '浮层正面二', back: '浮层背面二' });
      ctx.index.rebuild();
      await P.wait(700);

      P.clickByText('回顾', P.q('.kbw-navitems'));
      await P.wait(900);
      const startBtn = P.q('.kbw-review-start');
      if (!startBtn) { await cleanup(); return { ok: false, info: '头部没有「开始复习」（回顾栏没挂上？）' }; }
      P.click(startBtn);
      await P.wait(600);
      if (!P.q(SESSION)) { await cleanup(); return { ok: false, info: '复习浮层没开出来' }; }

      const sess = P.q(SESSION);
      const inSession = (el) => !!el && (sess === el || sess.contains(el));
      const progress0 = P.text(P.q('.kbw-rs-progress', sess));
      const hFront = Math.round(P.q('.kbw-rs-face', sess).getBoundingClientRect().height);

      /* ① 开窗即焦点在浮层里（键才送得到） */
      const focusAtOpen = inSession(document.activeElement);
      if (!focusAtOpen) note('开窗时焦点不在浮层里（activeElement=' + (document.activeElement && document.activeElement.className) + '）');

      /* ② 没翻面：三键置灰 + **按 1 不算数**（键盘绕过 disabled 属性，闸在处理函数里） */
      const btns0 = P.qa('.kbw-rs-actions .kbw-btn', sess);
      const allDisabled = btns0.length === 3 && btns0.every((b) => b.hasAttribute('disabled'));
      if (!allDisabled) note('没翻面时三键该置灰（实际 ' + btns0.map((b) => b.hasAttribute('disabled')).join('/') + '）');
      P.key('1');
      await P.wait(500);
      const untouched = (await ctx.review.load()).cards.find((c) => c.id === c1.id).interval === 1;
      if (!untouched) note('没翻面按 1 竟然落盘了（闸没拦住）');
      results.push('开窗焦点在浮层=' + focusAtOpen + '｜三键置灰=' + allDisabled + '｜没翻面按 1 不算数=' + untouched + '｜卡面 ' + hFront + 'px');

      /* ③ 空格翻面 → 三键可用 */
      P.key(' ');
      await P.wait(500);
      const face1 = P.text(P.q('.kbw-rs-face', sess));
      const flipped = face1.indexOf('浮层背面一') >= 0;
      if (!flipped) note('空格没翻面（卡面还是 ' + face1 + '）');
      const usable = P.qa('.kbw-rs-actions .kbw-btn', sess).every((b) => !b.hasAttribute('disabled'));
      if (!usable) note('翻面后三键该可用');
      results.push('空格翻面=' + flipped + '｜三键可用=' + usable);

      /* ④ 按 1 记住 → 落盘 + 自动下一张 + ★焦点**仍在**浮层里（真机才会现形的那条） */
      P.key('1');
      await P.wait(800);
      const after = (await ctx.review.load()).cards.find((c) => c.id === c1.id);
      const landed = after.interval === 3 && after.reps === 1;
      if (!landed) note('按 1 之后没落盘（interval=' + after.interval + ' reps=' + after.reps + '）');
      const progress1 = P.text(P.q('.kbw-rs-progress', sess));
      const advanced = progress1.indexOf('第 2 / 2') >= 0;
      if (!advanced) note('没自动到下一张（实际 ' + progress1 + '）');
      const focusAfter = inSession(document.activeElement);
      if (!focusAfter) note('★ 评完一张之后焦点跑出浮层了（activeElement=' + (document.activeElement && document.activeElement.className) + '）—— 键会静默失灵，正是 keepFocus() 要防的那条');
      results.push('记住：落盘=' + landed + '｜到下一张=' + advanced + '｜★焦点仍在浮层=' + focusAfter);

      /* ⑤ 第二张：空格 + 3（忘记）→ 小结 */
      P.key(' ');
      await P.wait(400);
      P.key('3');
      await P.wait(900);
      const sum = P.text(P.q('.kbw-rs-hint', sess));
      const summary = P.text(P.q('.kbw-rs-progress', sess)).indexOf('本轮完成') >= 0;
      if (!summary) note('第 2 张评完没出小结');
      const sumOk = sum.indexOf('记住 1') >= 0 && sum.indexOf('忘记 1') >= 0;
      if (!sumOk) note('小结计数不对（实际：' + sum + '）');
      const c2After = (await ctx.review.load()).cards.find((c) => c.id === c2.id);
      if (c2After.interval !== 1 || c2After.lapses !== 1) note('忘记该把间隔压回 1 且 lapses++（实际 ' + c2After.interval + '/' + c2After.lapses + '）');
      results.push('小结=' + sum + '｜忘记落盘=' + (c2After.lapses === 1));

      /* ⑥ 完成 → 关窗；面板头改口「今天没有到期的卡」+ 开始复习置灰 */
      P.clickByText('完成', P.lastModal() || document);
      await P.wait(900);
      const closed = !P.q(SESSION);
      if (!closed) note('点「完成」之后浮层还在');
      const head2 = P.text(P.q('.kbw-review-head'));
      const start2 = P.q('.kbw-review-start');
      const greyed = !!start2 && start2.hasAttribute('disabled');
      if (!greyed) note('两张都推后了，「开始复习」该置灰');
      results.push('关窗=' + closed + '｜头=' + head2.slice(0, 46));

      await cleanup();
      return { ok: problems.length === 0, info: results.join('｜') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
    })()`,
  },
  {
    name: 'P8 期 2 · 改名迁键（真机才现形那类）：改笔记名 → 卡片的 note 跟着走；改别的笔记 → 一个字节不动',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const results = [];
      const A = at('00_Inbox/__探针回顾改名A.md');
      const B = at('00_Inbox/__探针回顾改名B.md');
      const OTHER = at('00_Inbox/__探针回顾无关.md');
      const OTHER2 = at('00_Inbox/__探针回顾无关2.md');
      const body = (t) => ['---', '类型: 笔记', '状态: 进行中', '创建日期: 2026-10-10', '文件位置:', '  - ' + (KB ? '00_Inbox' : ''), '收藏: false', 'tags: []', '---', '', '# ' + t, ''].join('\\n');
      P.closeAll(4);
      await P.wait(300);
      for (const p of [A, B, OTHER, OTHER2]) { const f = app.vault.getAbstractFileByPath(p); if (f) await app.vault.delete(f); }
      await app.vault.create(A, body('__探针回顾改名A'));
      await app.vault.create(OTHER, body('__探针回顾无关'));
      const card = await ctx.review.addCard({ note: A, front: '改名问句', back: '改名答句' });
      ctx.index.rebuild();
      await P.wait(700);

      /* ① 改一篇**没有卡**的笔记 → 复习.json 逐字节不许动 */
      const rawBefore = JSON.stringify(await ctx.review.load());
      await app.fileManager.renameFile(app.vault.getAbstractFileByPath(OTHER), OTHER2);
      await P.wait(900);
      const rawAfter = JSON.stringify(await ctx.review.load());
      const untouched = rawBefore === rawAfter;
      if (!untouched) note('改别的笔记也把卡动了（应当一个字节不动）');

      /* ② 改**有卡**的那一篇 → note 跟着迁 */
      await app.fileManager.renameFile(app.vault.getAbstractFileByPath(A), B);
      await P.wait(1000);
      const moved = (await ctx.review.load()).cards.find((c) => c.id === card.id);
      const followed = !!moved && moved.note === B;
      if (!followed) note('改名之后卡片的 note 没跟着走（现在指向 ' + (moved && moved.note) + '）—— 真机上就是"点了打不开"');
      if (moved && (moved.front !== '改名问句' || moved.back !== '改名答句')) note('迁键顺手改了正反面（不该动）');
      results.push('改无关笔记逐字节不动=' + untouched + '｜改名后 note 跟着走=' + followed);

      /* 自清理 */
      const back = app.vault.getAbstractFileByPath(B);
      if (back) await app.fileManager.renameFile(back, A);
      await P.wait(600);
      for (const c of (await ctx.review.load()).cards.filter((x) => x.note === A || x.note === B)) await ctx.review.removeCard(c.id);
      for (const p of [A, B, OTHER, OTHER2]) { const f = app.vault.getAbstractFileByPath(p); if (f) await app.vault.delete(f); }
      await P.wait(300);
      return { ok: problems.length === 0, info: results.join('｜') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
    })()`,
  },
  {
    /**
     * P8 期 4 · **从笔记生成（AI）**：假传输层出稿 → 改一张删一张 → 入库；
     * 再来一遍"模型回废话" → **报出来且不写盘**。
     *
     * ⚠️ 探针默认装假传输层（P.stubAi）+ 假 key（P.setAiKey(P.AI_FAKE_KEY)），**不联网**；
     * 跑完把真传输与真 key 还回去（仓里那条"真调模型只留一条判据"的纪律）。
     * ⚠️ **反引号的规矩**：本段注释住在 STEPS 数组里（普通 JS，反引号随便写）；
     * 真正要小心的是 **script 之后那个模板字面量里面** —— 那里的注释与字符串都**不许出现反引号**
     *（会把模板当场截断，`lint:probe` 会咬）。写步骤时最容易混的就是这一点。
     */
    name: 'P8 期 4 · 从笔记生成（AI）：假传输层出稿 → 改一张删一张 → 入库；模型回废话 → 报出来不写盘',
    script: `(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      const KB = ctx.settings.kbRoot();
      const at = (rel) => (KB ? KB + '/' + rel : rel);
      const problems = [];
      const note = (m) => problems.push(m);
      const results = [];
      const REL = at('00_Inbox/__探针回顾AI.md');
      const body = ['---', '类型: 笔记', '状态: 进行中', '创建日期: 2026-10-10', '文件位置:', '  - ' + (KB ? '00_Inbox' : ''), '收藏: false', 'tags: []', '---', '', '# __探针回顾AI', '', '间隔重复的核心是"在快忘的时候再问一遍"。', '', '- 新卡间隔 1 天', '- 记住之后翻倍', ''].join('\\n');
      const mine = async () => (await ctx.review.load()).cards.filter((c) => c.note === REL);
      const prevKey = await P.setAiKey(P.AI_FAKE_KEY);
      const clean = async () => {
        for (const c of await mine()) await ctx.review.removeCard(c.id);
        const f = app.vault.getAbstractFileByPath(REL);
        if (f) await app.vault.delete(f);
        await P.setAiKey(prevKey);
        P.realAi();
        await P.wait(300);
      };
      const pickFixture = async () => {
        const modal = P.lastModal();
        if (!modal) return false;
        const item = P.qa('.kbw-pick-item', modal).find((i) => P.text(i).indexOf('__探针回顾AI') >= 0);
        if (!item) return false;
        P.click(item);
        return true;
      };

      try {
      P.closeAll(4);
      await P.wait(300);
      const old = app.vault.getAbstractFileByPath(REL);
      if (old) await app.vault.delete(old);
      await app.vault.create(REL, body);
      ctx.index.rebuild();
      await P.wait(700);
      const beforeText = await app.vault.read(app.vault.getAbstractFileByPath(REL));

      /* ① 出稿 → 面板（2 行）→ 改第 1 行背面 + 删第 2 行 → 入库 1 张 */
      P.stubAi('[{"front":"AI问一","back":"AI答一"},{"front":"AI问二","back":"AI答二"}]');
      P.clickByText('回顾', P.q('.kbw-navitems'));
      await P.wait(900);
      if (!P.q('.kbw-review')) { await clean(); return { ok: false, info: '「回顾」栏没挂上' }; }
      // 入口有两处形态：**头部按钮**（有卡时）与**空态动作**（0 张卡时头部那两枚都不画）——
      // 两条都要认，否则"库里还没卡"的库上这条步骤会以"入口不在"假红。
      const genEntry = () => P.q('.kbw-review-gen') || P.q('.kbw-review .kbw-empty-act .kbw-btn');
      const genBtn = genEntry();
      if (!genBtn) { await clean(); return { ok: false, info: '回顾栏既没有头部「从笔记生成」、也没有空态动作' }; }
      P.click(genBtn);
      await P.wait(700);
      if (!(await pickFixture())) { P.closeAll(4); await clean(); return { ok: false, info: '挑笔记模态里找不到夹具那一篇' }; }
      if (!(await P.waitFor(() => P.q('.kbw-gen-row'), 8000))) {
        await clean();
        return { ok: false, info: '出稿面板没出来（假传输层给了 2 张 JSON）' };
      }
      const rows = P.qa('.kbw-gen-row');
      if (rows.length !== 2) note('面板该 2 行（实际 ' + rows.length + '）');
      /**
       * ⚠️ **按内容定位行，不按索引**（外部交付线真机首跑栽过：按 rows[1] 去点删除，
       * 落库的却是第 2 张 —— 说明那一按删掉的不是我以为的那一行）。
       * 内容寻址之后，下面还有一条"删的确实是问二那行"的断言兜着。
       */
      const rowByFront = (txt) =>
        P.qa('.kbw-gen-row').find((r) => {
          const t = P.qa('textarea', r)[0];
          return t && t.value.indexOf(txt) >= 0;
        });
      const rowA = rowByFront('AI问一');
      const rowB = rowByFront('AI问二');
      if (!rowA || !rowB) note('两张出稿行按内容都没找齐（A=' + !!rowA + ' B=' + !!rowB + '）');
      if (rowA) {
        const ta = P.qa('textarea', rowA);
        if (ta.length < 2) note('出稿行里该有两个输入框（实际 ' + ta.length + '）');
        else ta[1].value = '真机改过的答案';
      }
      if (rowB) P.click(P.q('.kbw-gen-del', rowB));
      await P.wait(400);
      const left = P.qa('.kbw-gen-row');
      if (left.length !== 1) note('删掉一张之后该剩 1 行（实际 ' + left.length + '）');
      else {
        const f = P.qa('textarea', left[0])[0];
        if (!f || f.value.indexOf('AI问一') < 0) note('★ 删错行了：剩下的不是"问一"那一行（实际 front=' + (f && f.value) + '）');
      }
      const footBtn = P.qa('.kbw-btn').find((b) => P.text(b).indexOf('入库') >= 0);
      if (!footBtn) note('找不到「入库」按钮');
      else {
        if (P.text(footBtn).indexOf('入库 1 张') < 0) note('删掉一张之后主按钮该写「入库 1 张」（实际：' + P.text(footBtn) + '）');
        P.click(footBtn);
        await P.wait(700);
      }
      const cf = P.lastModal();
      if (!cf) note('入库前没弹确认流（硬规矩 #3）');
      else {
        if (P.text(cf).indexOf('真机改过的答案') < 0) note('确认单里不是"改过之后"的稿');
        P.clickByText('新建这张卡', cf);
        await P.wait(900);
      }
      const mineCards = await mine();
      const okOne = mineCards.length === 1 && mineCards[0].back === '真机改过的答案' && mineCards[0].front === 'AI问一';
      if (!okOne) note('落库不对：' + mineCards.length + ' 张，背面=' + (mineCards[0] && mineCards[0].back));
      const afterText = await app.vault.read(app.vault.getAbstractFileByPath(REL));
      const bytesSame = afterText === beforeText;
      if (!bytesSame) note('来源笔记被改了（应当逐字节不变）');
      results.push('出稿 2 张 → 改 1 删 1 → 入库 ' + mineCards.length + ' 张（背面=' + (mineCards[0] && mineCards[0].back) + '）｜来源笔记逐字节不变=' + bytesSame);

      /* ② 模型回废话 → 报出来、**不写盘**（盘上还是刚才那 1 张） */
      P.stubAi('好的，我看完了这篇笔记。它主要讲了间隔重复的基本思路，建议如下……');
      P.click(genEntry());
      await P.wait(700);
      if (!(await pickFixture())) { P.closeAll(4); await clean(); return { ok: false, info: '第二段：挑笔记模态里找不到夹具' }; }
      await P.wait(1500);
      const notices = P.qa('.kbw-notice').map((n) => P.text(n)).join('｜');
      const reported = notices.indexOf('没看懂') >= 0;
      if (!reported) note('解析失败没报出来（通知：' + notices.slice(0, 90) + '）');
      const still = (await mine()).length;
      if (still !== mineCards.length) note('解析失败时写盘了（应当还是 ' + mineCards.length + ' 张，实际 ' + still + '）');
      const noPanel = !P.q('.kbw-gen-row');
      if (!noPanel) note('解析失败不该开面板（没有可改的东西）');
      results.push('模型回废话 → 报出来=' + reported + '｜盘上仍 ' + still + ' 张｜没开面板=' + noPanel);

      return { ok: problems.length === 0, info: results.join('｜') + (problems.length ? ' ｜⚠️ ' + problems.join('；') : ' ｜全通 ✓') };
      } finally {
        // ⚠️ **finally 里收场**（外部交付线独立审）：中途抛出时也得把假传输层、假 key、
        // 夹具笔记还回去 —— 否则后面的步骤会在"模型永远回废话 + 库里多一篇夹具"的状态下跑。
        await clean();
      }
    })()`,
  },
];
  // ── /P4（上面这批是 P4 看板的真机步骤）
  // ── /P4（上面这批是 P4 看板的真机步骤）

/**
 * **冒烟名单**（2026-10-09 拍定 · 检查流程优化）——「标准轮」档跑的 ~18 步：
 * 挑的是**跨轮的共享链与平台契约的哨兵**，一条覆盖一类：
 *   · 写库链：真移动链路（mover→快照→还原）/ 确认流 / 危险态（上膛+撤销）
 *   · 三条硬规矩的日常面：全部笔记表格 / 看板小窗（真编辑器挂载）/ 跨板块拖动
 *   · 平台契约：编辑器右键菜单（editor-menu）/ **原生属性面板那一格（P7.16b）**
 *   · 主要屏冒烟：图谱挂载 / 首页待处理 / 快捷键表 / 快速捕获
 *   · 自动化链：一键整理（tidy）/ 整理建议面板（AI stub）/ 待处理直跑三件 / 属性迁移（写整个库，保持队尾）
 *   · 上两轮的整链：P7.15（选择器一键迁）/ P7.16（小窗刷新+坏前言）/ P7.16b（原生面板）
 *
 * 口径（写进 CLAUDE.md「开发方式」）：
 *   · **标准轮** = `npm run probe -- --smoke`（~3–5 分钟）；
 *   · **大轮 / 滚动轮** = 全量 `npm run probe`（~20 分钟）；
 *   · 加/改步骤时若要进冒烟档：**往下面名单加一行**。
 *     ⚠️ 每个词必须至少命中一步 —— `probe-lint` 有一条判据盯着（步骤改名后这里静默缩水的那种坑，
 *     本项目栽过 N 次，所以让它在 0.2 秒的自检里红出来，而不是等一轮跑完"看起来全绿"）。
 *   · 匹配 = 子串（与 `--only` 同口径），顺序照 STEPS 原序（**别重排**：P2 那条"写整个库"的
 *     步骤必须留在它原来的队尾位置）。
 */
export const PROBE_SMOKE = [
  '真移动链路',
  '确认流：批量迁移',
  '危险态：删除探针',
  /** P7.21a：ask_user 的轻弹层链（面板输入 → 循环暂停 → 回答喂回）—— 跨轮共享交互链 */
  'P7.21a · ask_user',
  /** P7.21b：能力包 `/` 菜单与触发词自动挂载（同一条面板交互链的新入口） */
  'P7.21b · 能力包菜单与触发词挂载',
  /** P7.22a：正文编辑的写链（确认 → diff 预览 → 改 → 撤销逐字节还原）—— 新写面，跨轮共享 */
  'P7.22a · 正文编辑',
  /** P7.24：服务族 L2 —— agent 把管线跑到确认卡（幕后无面板）+ 执行/撤销链，跨轮共享 */
  'P7.24 · 服务族 L2',
  /** P7.23：跟手浮标（rAF 合帧 + 抓取偏移锁）—— 拖动视觉链的新基座，跨轮共享 */
  'P7.23 · 拖动跟手',
  /** P7.23：勾选三连 + 重建保持（选择链哨兵；"勾选互踩"修复的机器化定义） */
  'P7.23 · 勾选互踩',
  /** P7.23：树文件行拖（mover 链的新入口：树 → 树搬一行） */
  'P7.23 · 树文件行',
  /** P7.24：树收口 T1+T3（行尾起收钮 + 根菜单全部收起）—— 树的新交互面哨兵 */
  'P7.24 · 树收口 T1+T3',
  /** P7.24：根 caret 真收真开（"根恒开"反转后的机器化定义） */
  'P7.24 · 树收口 T2',
  'P1 · 全部笔记：目录树',
  'P4 · 看板：单击开悬浮小窗',
  'P4 · 看板：跨板块拖动',
  'P6 · 图谱：挂载',
  'P6② · A2 一键自动整理',
  '编辑器右键菜单',
  'P7.2c · 快速捕获',
  'P7.6 · 首页待处理三件',
  'P7.11 · #12 整理建议面板',
  'P7.13b · 撤行①·直跑三件',
  'P7.15 · 反馈批 6',
  'P7.16 · 小窗候选刷新',
  'P7.16b · 原生属性面板',
  'P7.18 · 退出清理',
  'P7.18b · 位置口径',
  '快捷键表',
  'P2 · 属性迁移：执行',
];

// ── 主流程 ──────────────────────────────────────────────────────
async function discoverTarget() {
  const deadline = Date.now() + 8000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/json/list`);
      const targets = await res.json();
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pages.length > 0) return pages;
      lastErr = '没有 page 类型的调试目标';
    } catch (e) {
      lastErr = e?.message ?? String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(lastErr || '发现不了调试目标');
}

/**
 * 截图要求的窗口尺寸（= 模拟视口那套基准 1400×900，两种状态的"宽"口径因此一致）。
 * 为什么是它：窗口小到 868×745 时截图直接掉**窄档**（`.kbw-notes-side` 被 CSS 藏掉），
 * 而失败点看着与判据毫无关系（`设计建议-P6第九段` §3 的取证）。
 */
const SHOT_MIN_W = 1400;
const SHOT_MIN_H = 900;

/**
 * **截图前把窗口弄够大**（P7.0b / 14.8b）。
 *
 * 只做两件事：量一次 `innerWidth/Height`（不够大才动手）→ 走 OS 层最大化
 *（`win-window.mjs` 的 `maximizeObsidian`）→ **复量**。够大就一句话都不说
 *（绝大多数截图都走这条短路，只花一次 CDP 往返）。
 *
 * ⚠️ **不推翻**"visible = 真机口径、不套模拟视口"那条设计：窗口不可见时这一手整个不跑
 *（那会儿量的是模拟视口，本来就 1400×900）。
 * ⚠️ 仍不达标（小屏幕 / 非 Windows / 没最大化成功）只**报出来**，不让整轮判红 ——
 * 那是环境事实，不是缺陷（"看得见，别静默"）。
 * 返回 ''（没什么可说）或一句要打到日志/终端的话。
 */
async function ensureShotWindow(cdp) {
  const readSize = async () =>
    await cdp.eval('({ w: window.innerWidth, h: window.innerHeight })').catch(() => null);
  const size = await readSize();
  if (!size || (size.w >= SHOT_MIN_W && size.h >= SHOT_MIN_H)) return '';
  /**
   * ⚠️ **parked（屏幕外）的窗口不许再 maximize**（P7.2d 复审 R1，跨工具互踩）：
   * `SW_MAXIMIZE` 会把完全在屏幕外的窗口按 Windows 语义拽到"最近的显示器"上 ——
   * 当场把 obsidian.mjs 的"隐形档"破坏（窗口跳上屏 + 抢焦点）。
   * 工具那边 `park` 已把窗口尺寸垫到 ≥ 截图基准（绝大多数情况上面一行就短路了）；
   * 这条是兜底：真小尺寸 + parked 就**如实报**，不碰窗口。
   */
  const winInfo = await getObsidianWindow();
  if (winInfo?.offscreen) {
    return `窗口 parked（屏幕外，${size.w}×${size.h}）：不最大化（会把它拽回屏幕）—— 这张图可能偏窄`;
  }
  const maxed = await maximizeObsidian();
  await new Promise((r) => setTimeout(r, 700)); // ShowWindowAsync 是异步的：给它一拍再复量
  const after = (await readSize()) ?? size;
  if (after.w >= SHOT_MIN_W && after.h >= SHOT_MIN_H) {
    return `窗口 ${size.w}×${size.h} 偏小 → 已最大化为 ${after.w}×${after.h}`;
  }
  return (
    `⚠️ 窗口 ${after.w}×${after.h}（< ${SHOT_MIN_W}×${SHOT_MIN_H}）—— 这张图可能是窄档` +
    (maxed ? '（已最大化）' : '（没能最大化：非 Windows / 没找到窗口）')
  );
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 每一轮的结论单独一份（独立审查 🟢8）："info" 里会有"只当参考"这类降级说明，
  // 不落盘的话事后没法复查"这一轮到底验证到了什么"
  try {
    fs.writeFileSync(path.join(OUT_DIR, 'last-run.txt'), '', 'utf8');
  } catch {
    /* 忽略 */
  }
  console.log(c.bold(`\n经纬 · 真机探针（CDP :${PORT}）`));
  console.log(c.dim(`截图目录：${OUT_DIR}\n`));

  let pages;
  try {
    pages = await discoverTarget();
  } catch (e) {
    console.error(c.bad(`✗ 连不上 Obsidian 的调试端口（${PORT}）`));
    console.error(c.dim(`  原因：${e.message}`));
    console.error(`
  处理办法：**完全退出 Obsidian**（单实例应用，带着旧进程启动会被忽略参数），然后：

    powershell -Command "Start-Process 'C:\\Program Files\\Obsidian\\obsidian.exe' -ArgumentList '--remote-debugging-port=${PORT}'"

  或者直接跑： npm run probe:launch
`);
    process.exit(1);
  }

  console.log(`发现 ${pages.length} 个页面目标：`);
  for (const p of pages) console.log(c.dim(`  · ${p.title} — ${p.url}`));

  // 选页：**逐页问它开着哪个库**，只有"像实验库且不是真库"的才放行
  //（判据与 deploy 同一份：`vault-guard.assertWritableSandbox`；不认命令行标志、不看 URL）
  let cdp = null;
  let target = null;
  const seen = [];
  for (const p of pages) {
    const c = await Cdp.connect(p.webSocketDebuggerUrl);
    try {
      const root = await c.eval(
        `(window.__kbwProbeInstalled = true), (window.app?.vault?.adapter?.getBasePath?.() ?? window.app?.vault?.adapter?.basePath ?? '')`,
      );
      const vault = typeof root === 'string' ? root : '';
      const verdict = assertWritableSandbox(vault, '真机探针');
      // 保留"像实验库"这层可配的口径（KBW_VAULT_MUST_INCLUDE 之外还允许用户改）
      if (verdict.ok && vault.includes(VAULT_MUST_INCLUDE)) {
        cdp = c;
        target = p;
        break;
      }
      seen.push(`${vault || '(空)'}${verdict.ok ? '' : `（${verdict.reason}）`}`);
      c.close();
    } catch {
      seen.push('(问不到)');
      c.close();
    }
  }
  if (!cdp) {
    console.error(c.bad(`✗ ${pages.length} 个页面里没有"可写的实验库"那个 —— 探针一律不在真库上跑`));
    if (seen.length > 0) console.error(c.dim(`  实际开着：${seen.join(' ｜ ')}`));
    console.error(c.dim(`  （要求：路径含「${VAULT_MUST_INCLUDE}」，且不是真库）`));
    process.exit(1);
  }
  console.log(c.dim(`\n接上：${target.title}\n`));
  probeLiveCdp = cdp; // 交给 SIGINT 钩子（见文件下方）：挨中断时用它换 token / 关连接

  /**
   * 🔴 **先把窗口抬到前台**（2026-09-25 实测发现的一类"莫名其妙的假绿/假红"的根因）：
   * 窗口只要被最小化 / 被别的窗口遮住，Chromium 就把 `document.visibilityState` 记成 hidden，
   * 而**此时所有 `getBoundingClientRect()` 都返回 0** —— 于是：
   *   · 量"有没有横向溢出"这类判据会**空过**（0 <= 0 恒真）；
   *   · 量"元素宽高"的判据则是 0，真红得莫名其妙；
   *   · `Page.captureScreenshot` 还可能给一帧**陈旧的**画面（截图会骗人）。
   * 这一条大概率也是项目里"探针冷启动首跑容易抖"的一部分（首跑时窗口常在后台）。
   * `bringToFront` 之后可见性立刻恢复（实测：hidden → visible，几何从 0 → 256）。
   */
  /** 这一轮是不是跑在**模拟视口**下（窗口不可见时的兜底，见下面那段守卫） */
  let ghostApplied = false;
  const { visible, focused } = await bringToFront(cdp);
  if (!visible) {
    /**
     * 窗口最小化/被遮住 → 这时**所有元素几何都是 0**，跑下去全是假绿/假红。
     * 两条出路：① 让它可见（bringToFront 里已经试过 `Page.bringToFront`，但**最小化的窗口叫不回来**）；
     * ② **模拟视口**（`Emulation.setDeviceMetricsOverride`）—— 在渲染进程里钉一个固定视口，
     *    于是**不碰你的窗口也能量**（用户 2026-09-25 点名要的："最小化了也能操作"）。
     * 默认走 ②（不再直接停）：视口固定 1400×900，与"打开工作台"那步强制的最小尺寸一致 ——
     * 几何判据因此还多一层**尺寸可复现**的好处。`KBW_PROBE_GHOST=0` 可退回"直接停"。
     */
    if (process.env.KBW_PROBE_GHOST === '0') {
      console.error(c.bad('\n✗ 窗口不是可见状态 —— 所有元素几何都是 0，跑了也是白跑。'));
      console.error(c.dim('  还原窗口再跑，或别设 KBW_PROBE_GHOST=0（默认会走模拟视口）。\n'));
      process.exit(1);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    ghostApplied = true;
    await new Promise((r) => setTimeout(r, 900));
    console.log(
      c.dim('⚠️ 窗口不可见 → 已切**模拟视口 1400×900**（不碰你的窗口；量到的是这个视口下的布局）'),
    );
  }
  if (!focused) {
    console.log(c.dim('⚠️ 窗口没有焦点：几何测量照样有效，但**截图可能是上一帧**（Chromium 不为后台窗口出新帧）'));
  } else {
    /**
     * ⚠️ 窗口可见时**主动清一次模拟视口**：`setDeviceMetricsOverride` 贴在 target 上，
     * 前面哪个脚本（peek/上一轮探针）忘了撤，这一轮就会在一个**假的 1400×900** 上跑 ——
     * 真机实测的症状是"跟布局有关的老步骤（表格默认列数/行高）莫名其妙全红"。
     */
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }

  // 控制台与异常捕获 —— 这是真机探针最有价值的一项
  const consoleErrors = [];
  /**
   * **`[经纬]` 前缀的 warning**（P7.0b / 14.8a）——与 error 同一处置（汇总里报出来 + 整轮判红）：
   * 插件把"不该发生的事"分两档记（error / warn），而探针原先**只收 error**，
   * 于是 `goNotes` 那条"收到不存在的目录"（warn 级）会落在**没人看的地方**。
   * ⚠️ 只收**带插件前缀**的 —— 平台/第三方插件的 warning 不归我们管。
   * ⚠️ 故意踩这条守卫的那一步（`P7.0b · 14.8a`）在页面里**临时接管 console.warn**，
   * 那种调用根本走不到这里（它自己断言"报出来了"），两边不打架。
   */
  const pluginWarns = [];
  /**
   * ⚠️ **已知并接受的 warn**（开收 warn 时发现的**存量**，不是 P7.0b 引入的）：
   *   · `勾选框未绑定` —— 探针自造夹具 `__探针缺口.md`（渲染 2 框 / 源文 1 行）**故意**踩的
   *     那条已知口径差（e2 期就记着：引用块里的任务行仍是缺口）。它要验的正是"对不上时按只读"。
   * （原先还有一条「菜单违反硬规矩 一级 N 项」——2026-10-02 用户拍板把"≤8 项"从硬线
   *  改成"合理范围 + 清晰性"之后，板块菜单与批量迁移菜单都不再触发，条目已删；
   *  新的判据在 `ui/menu.ts` 的 `MENU_TOP_COMFORT` 与下面那步**菜单几何**里。）
   * 除此以外，**任何** `[经纬]` warn 一律当失败（同 error 处置）——
   * 收进通道是为了点名，不是为了存档。
   */
  const KNOWN_WARNS = [/勾选框未绑定/];
  const exceptions = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      if (p.type === 'error') consoleErrors.push(text.slice(0, 300));
      else if (text.includes('[经纬]')) pluginWarns.push(text.slice(0, 300));
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    exceptions.push((d?.exception?.description ?? d?.text ?? '').split('\n').slice(0, 2).join(' ').slice(0, 300));
  });

  await cdp.eval(HELPERS);
  /**
   * ── 起手注入本轮 run token（P7.20-8）──────────────────────────────
   * 两件事，一件都不能少：
   *   ① **踢掉上一轮的残留步**：上一轮若崩在中途，页面里可能还挂着它的 `P.wait` 定时器 /
   *      异步步。换上我们的新 token → 那些等待下一拍就发现"token 变了"而**立刻 reject**，
   *      不会在我们跑的时候偷偷动库。
   *   ② **给本轮自己的 `P.wait` 一个校验基准**（见 `probe-helpers.mjs`）：主循环每步开头
   *      也拿它跟页面里的比，不等就停（别人把我们踢了）。
   * ⚠️ 必须紧跟 `HELPERS` 求值之后 —— 早于它，`window.__kbwProbe` 都还没建；
   *    晚于第一个 `P.wait`，那一拍就会因为"页面里是 undefined ≠ RUN_TOKEN"而假 stale。
   * ⚠️ 用 `JSON.stringify` 而不是模板字面量：token 是随机串，插值进代码要防它带着引号/反斜杠。
   */
  await cdp.eval(`window.__kbwProbeRun = ${JSON.stringify(RUN_TOKEN)};`);

  // `--only` / `--smoke` 都要带上前置步骤（否则视图都没打开，单步必然失败）
  // ⚠️ 参数本身在文件顶部（`ONLY_ARG` / `SMOKE_FLAG` / `SMOKE_STEPS`）**连接机器之前**就校验过了 ——
  //    名单/参数错就别去碰 Obsidian。
  const steps = ONLY_ARG
    ? [...STEPS.filter((s) => s.setup), ...STEPS.filter((s) => !s.setup && s.name.includes(ONLY_ARG))]
    : SMOKE_FLAG
      ? [...STEPS.filter((s) => s.setup), ...SMOKE_STEPS]
      : DOMAIN_ARG
        ? [...STEPS.filter((s) => s.setup), ...STEPS.filter((s) => !s.setup && domainOf(s) === DOMAIN_ARG)]
        : STEPS;

  let pass = 0;
  const fails = [];
  /** 每步耗时（P7.20-5）—— 收尾打"最慢 10 步"，用来回答"20 分钟到底花在哪" */
  const timings = [];
  /** 被 `KBW_PROBE_SKIP_SHOT=1` 跳掉的截图（P7.20-7）—— 收尾点名，免得把旧图当新的 */
  const skippedShots = [];
  /**
   * 落一行 `last-run.txt`。
   * 🔴 P7.20-5：**行尾新增 ms 列**（`PASS\t名字\tinfo\t123ms`）—— 前 3 列语义**不变**，
   * 所以文档 / 审查报告里"第 72 行"、"PASS 且 info 有数"那些引用照旧成立。
   */
  const logRun = (verdict, name, info, ms) => {
    try {
      fs.appendFileSync(
        path.join(OUT_DIR, 'last-run.txt'),
        `${verdict}\t${name}\t${info}\t${ms}ms\n`,
        'utf8',
      );
    } catch {
      /* 落盘失败不影响跑 */
    }
  };
  for (const step of steps) {
    const stepT0 = Date.now();
    /**
     * ── **run token 校验**（P7.20-8）──────────────────────────────
     * 每步开头问一次：页面里的 token 还是本轮那个吗？
     * 不是 → 说明**有另一个 runner 起手把我们踢了**（或我们自己挨了 SIGINT）——
     * 立刻停，别在别人的页面上继续动库（P7.18b 那"三连坑"的机器解）。
     * ⚠️ 查不到（页面没就绪）就放过：`setup` 步会把页面拉起来。
     */
    try {
      const tok = await cdp.eval('window.__kbwProbeRun');
      if (tok !== RUN_TOKEN) {
        console.log(
          c.bad(`\n✗ 页面 token 已经是「${tok}」—— 本轮（${RUN_TOKEN}）被取代，停在这里，不再动库`),
        );
        break;
      }
    } catch {
      /* 页面没就绪：由 setup 步负责拉起来 */
    }

    /**
     * ⚠️ **每一步开始前先把上一轮留下的浮层收干净**。
     * 模态/菜单挂在 `body` 上，漏一个就会盖住后面所有步骤 —— 症状是"某一步莫名其妙失败"
     * （P3 实测：设置面板没关 → 后面 P1 的拖拽指针全打在面板上，拖不动文件）。
     */
    if (!step.setup) {
      try {
        const pre = await cdp.eval(`(async () => {
          const P = window.__kbwProbe;
          P.closeAll(4);
          // ⚠️ 顺带把工作台那一页**重新激活**：前一步若在编辑器里打开了笔记（比如"新建笔记"
          // 之后自动打开），工作台就成了后台标签 → 容器宽 = 0 → 依赖布局的步骤全失败
          const wb = app.workspace.getLeavesOfType('kb-workbench-view');
          if (wb.length > 0) await app.workspace.revealLeaf(wb[0]);
          await P.wait(180);
          /**
           * 🔴 **revealLeaf 一次不一定把工作台带回前台**（P6b 收尾实测：e 那一步量到
           * 「rect [0,0,0,0]」，报的却是"第一张卡片不在视野里" —— 谜面像看板坏了，
           * 谜底是标签在后台）。所以这里**量一下**：真没回来就再救一次，并**说出来**
           *（沉默地救 = 下一次谁也不知道它又发生了；这一条正是本项目反复栽的那类账）。
           */
          const rootEl = document.querySelector('.kbw-root');
          if (rootEl && wb.length > 0 && rootEl.getBoundingClientRect().width === 0) {
            await app.workspace.revealLeaf(wb[0]);
            await P.wait(400);
            return rootEl.getBoundingClientRect().width > 0 ? 'reveal2' : 'still0';
          }
          return '';
        })()`);
        if (pre === 'reveal2' || pre === 'still0') {
          console.log(c.dim(`      ⚠️ 工作台当时不在前台（${pre === 'reveal2' ? 're-reveal 救回来了' : '救不回来'}）—— 上一步把它挤到后台了`));
        }
      } catch {
        /* 页面没就绪就算了（setup 步会把它拉起来） */
      }
    }
    /**
     * **步骤可以声明它要的视口**（`viewport: [宽, 高]`）—— 由 CDP 设，不靠 `window.resizeTo`。
     * 为什么改口径（用户 2026-09-25 要"最小化也能验证"）：
     *   · 窗口最小化/不可见时我们切的是**模拟视口**，而 `resizeTo` 在模拟视口下**被忽略** ✗
     *     → 依赖"缩到 600px 看窄档"的步骤在那种状态下必然假红；
     *   · `Emulation.setDeviceMetricsOverride` 在**两种状态下都生效**，而且视口尺寸**可复现**
     *     （不再受"这次窗口多大"影响）。
     * 跑完这一步就把覆盖撤掉（本身在 --ghost 下则恢复成 1400×900 那个基准视口）。
     */
    if (step.viewport) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: step.viewport[0],
        height: step.viewport[1],
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise((r) => setTimeout(r, 900)); // 等 ResizeObserver → data-w 落定
    }
    if (step.script) {
      let r;
      try {
        r = await cdp.eval(step.script, { timeoutMs: 60000 });
      } catch (e) {
        r = { ok: false, info: `页面里抛异常：${e.message.split('\n')[0]}` };
      }
      const good = r?.ok === true;
      const stepMs = Date.now() - stepT0;
      if (good) pass += 1;
      else fails.push({ name: step.name, info: r?.info ?? '（没有返回信息）' });
      console.log(`${good ? c.ok('  ✓') : c.bad('  ✗')} ${step.name}${c.dim(`  ${stepMs}ms`)}`);
      console.log(c.dim(`      ${r?.info ?? ''}`));
      /**
       * **每一步的结论落一份盘**（P6 收尾按独立审查 🟢8 补）。
       * 为什么要它："info" 里可能写着"（窗口不可见，只当参考）"这类**降级说明** ——
       * 而那句话只出现在当场那次终端里，跑完就没了；"这一轮到底有几条判据没真跑"
       * 事后无法复查。现在逐行追加，一行一步（P7.20-5 起行尾多一列 ms）。
       */
      logRun(good ? 'PASS' : 'FAIL', step.name, r?.info ?? '', stepMs);
      /**
       * 收进 `timings`（P7.20-5）—— 收尾打"最慢 10 步" + 落 `step-timings.json`。
       * ⚠️ 只记**带 script 的步**：`setup` / 纯截图步在页面上没几毫秒，
       * 混进来会把真耗时淹掉（探针 20 分钟里的大头是页面内等待，不是 runner 侧）。
       */
      timings.push({ name: step.name, ms: stepMs });
      // ⚠️ 红线步不过 = 后面每一步都可能打在错的库上 → **立刻停**
      if (!good && step.guard) {
        console.error(c.bad('\n✗ 红线守卫没过 —— 整轮中止（后面每一步都不再跑）'));
        cdp.close();
        process.exit(1);
      }
    }
    if (step.shot) {
      if (step.before) await step.before(cdp);
      /**
       * **截图前先确认窗口够大**（P7.0b / 14.8b）：不够大就 OS 层最大化 + 复量，
       * 仍不达标就**报出来**（"这张图可能是窄档"）—— 静默的话下一次又要从"谜面"查起。
       * ⚠️ 窗口不可见时（ghost 模拟视口）这一手整个不跑：那会儿量的是 1400×900 的模拟视口。
       */
      // P7.20-7：`KBW_PROBE_SKIP_SHOT=1` 时连"把窗口撑到够大"也跳过 —— 它同样只为截图服务
      if (!SKIP_SHOT && !ghostApplied) {
        const shotNote = await ensureShotWindow(cdp).catch(() => '');
        if (shotNote) {
          console.log(shotNote.startsWith('⚠️') ? c.bad(`      ${shotNote}`) : c.dim(`      ${shotNote}`));
          try {
            fs.appendFileSync(
              path.join(OUT_DIR, 'last-run.txt'),
              `${shotNote.startsWith('⚠️') ? 'WARN' : 'INFO'}\t📷 ${step.name}\t${shotNote}\n`,
              'utf8',
            );
          } catch {
            /* 落盘失败不影响跑 */
          }
        }
      }
      const file = path.join(OUT_DIR, step.shot);
      /**
       * ⚠️ 截图**失败不该把整轮带崩**（它只是证据，不是判据）：
       * 实测最小化状态下合成器不出帧 → `captureScreenshot` 超时抛异常 ✗ 整轮就没了。
       * 现在按"这一步的截图没拿到"记一笔（进 `fails`，跑完一起报），继续往下跑。
       * 同时：`ghostApplied` 时走渲染器侧出图（`fromSurface:false`，见那个方法的注释）。
       */
      /**
       * 🔴 P7.20-7：`SKIP_SHOT` 时**连截图本身也跳过**（原先只跳了撑窗口 —— 那不够：
       *    `captureScreenshot` 才是大头，而且每张图都往 `tests/.tmp/probe/` 再堆一份）。
       * 迭代轮里截图是**证据不是判据** —— 跳，但要**留痕**：
       *    `last-run.txt` 记一行 `SKIP`（列 1 是 `SKIP`，跟 `PASS`/`FAIL` 分得开），
       *    收尾还有一句横幅点总数。**"这轮没图"必须一眼可见**，
       *    否则下次谁翻到目录里的旧图，会以为那是刚跑的。
       */
      if (SKIP_SHOT) {
        skippedShots.push(step.name);
        try {
          fs.appendFileSync(
            path.join(OUT_DIR, 'last-run.txt'),
            `SKIP\t📷 ${step.name}\t（KBW_PROBE_SKIP_SHOT=1，本轮不截图）\n`,
            'utf8',
          );
        } catch {
          /* 落盘失败不影响跑 */
        }
      } else {
        try {
          await cdp.screenshot(file, { fromSurface: !ghostApplied });
          console.log(`${c.ok('  📷')} ${step.name} → ${path.relative(ROOT, file)}`);
        } catch (e) {
          fails.push({ name: `📷 截图失败：${step.name}`, info: e?.message ?? String(e) });
          console.log(`${c.bad('  📷')} ${step.name}（截图没拿到：${e?.message ?? e}）`);
        }
      }
      if (step.after) await step.after(cdp);
    }
    // 撤掉这一步声明的视口（ghost 模式下回到基准视口，普通模式回到真实窗口）
    if (step.viewport) {
      if (ghostApplied) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1400,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
      } else {
        await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  // 收尾：关掉可能还开着的菜单/模态
  await cdp.eval(`(async () => { window.__kbwProbe.key('Escape'); await window.__kbwProbe.wait(100); window.__kbwProbe.key('Escape'); return true; })()`);

  /**
   * 收尾：**按标记清场**（日志 + 它们点名的那份快照）。
   *
   * 🔴 为什么要有这一手（d2 期查清的老账："探针自清理漏了一条日志"）：
   * `P.sweep()` 是**逐步**调的，而"哪一步需要 sweep"纯靠作者记得 —— 实测至少漏了
   * `P4.5 · 拖动落点` 那一步（它的 `cleanup()` 只删临时文件与库内配置、**从不 sweep**），
   * 于是每跑一轮就攒下一条移动日志 + 一份快照（实测实验库里积了 38 份快照）。
   * 与其一步步补（还有十来步同样没 sweep），不如在**整轮跑完之后兜一次底**。
   *
   * ⚠️ **不许用"与开工前 diff"**（那等于"凡是我没见过的都归我删" —— 用户在窗口期
   * 自己造的存档会被误删，`P.sweep` 的注释里写着这条）。这里认的是两条**硬标记**：
   *   ① 日志正文里含 `__探针`（探针造的临时文件都叫这个名字，日志明细会带上它的路径）
   *   ② 日志里 `**快照**：<id>` 那一行点名的快照 —— 精确到"这一轮真的动过库"的那几份
   */
  const sweepVault = async () => {
  try {
    const swept = await cdp.eval(`(async () => {
      const P = window.__kbwProbe;
      const ctx = P.ctx();
      let logs = 0;
      let snaps = 0;
      for (const f of await ctx.report.recent(400)) {
        let text = '';
        try { text = await app.vault.read(f); } catch (e) { continue; }
        if (text.indexOf('__探针') < 0) continue;
        /**
         * ⚠️ 日志里那份 id 是**反引号包着**的（\`20260926-094634\`）——
         * 用 [\\x60] 匹配它，**别直接写反引号**：这段是模板字面量，一个反引号就把
         * 整段 JS 提前结束了（本项目栽过好几次的那种错）。第一次漏删就是这么漏的。
         */
        for (const id of text.match(/\\*\\*快照\\*\\*[：:][\\x60\\s]*([0-9]{8}-[0-9]{6})/g) || []) {
          const one = /([0-9]{8}-[0-9]{6})/.exec(id);
          if (!one) continue;
          try { await ctx.snapshot.remove(one[1]); snaps += 1; } catch (e) { /* 已经被别的步骤删了就跳过 */ }
        }
        try { await app.vault.delete(f, true); logs += 1; } catch (e) { /* 同上 */ }
      }
      /**
       * 🔴 **兜底 ③：删掉这一轮自造的 __探针* 文件/目录**。
       *
       * 为什么要有：逐步的 dropXxx() 全靠"作者记得" —— 而**任何一步早退/失败都会跳过它**
       * （本轮实测：P5 那三步失败之后，造的那篇 __探针重排.md 留在了库里 →
       *  **下一轮的 P2 属性迁移步骤**看到它、判据当场变红，而失败点看着与 P5 毫无关系）。
       * 认的是**硬标记**（名字前缀），不是"与开工前 diff"（那条是同一条老账）。
       */
      let files = 0;
      try {
        const KB = ctx.settings.kbRoot();
        const walk = async (dir) => {
          const l = await app.vault.adapter.list(dir);
          for (const f of (l.files || [])) {
            const name = f.slice(f.lastIndexOf('/') + 1);
            if (name.indexOf('__探针') !== 0) continue;
            const hit = app.vault.getAbstractFileByPath(f);
            if (hit) { await app.vault.delete(hit, true); files += 1; }
          }
          for (const d of (l.folders || [])) {
            const name = d.slice(d.lastIndexOf('/') + 1);
            if (name.indexOf('__探针') === 0) {
              const hit = app.vault.getAbstractFileByPath(d);
              if (hit) { await app.vault.delete(hit, true); files += 1; }
              continue;
            }
            await walk(d);
          }
        };
        await walk(KB);
      } catch (e) { /* 清场是卫生，别把整轮带崩 */ }
      /**
       * 🔴 **兜底 ④：抹掉探针塞进骨架里的那一条**（库内 库结构.json 的 dirs 里带 __探针 的项）。
       *
       * 为什么：P5 那两步现在会往骨架里塞一条"库里还没有的目录"当夹具
       * （probe-helpers 的 seedSkeletonDir），逐步的 dropSkeletonDir() 同样靠"作者记得" ——
       * 任何一步早退/失败都会把它留在配置里，下一轮的"重排预览"就会看到一条假的「新建 1 目录」。
       * 它是**配置文件里的一条数据**，不是 __探针* 文件/目录，兜底 ③ 那套按名字前缀扫的认不出它。
       */
      let skel = 0;
      try {
        const cfg = await ctx.configs.read('rebuild');
        const all = Array.isArray(cfg.dirs) ? cfg.dirs : [];
        const kept = all.filter(function (d) { return String(d).indexOf('__探针') < 0; });
        if (kept.length !== all.length) {
          await ctx.configs.write('rebuild', Object.assign({}, cfg, { dirs: kept }));
          skel = all.length - kept.length;
        }
      } catch (e) { /* 同上：卫生，不是断言 */ }
      return { logs, snaps, files, skel };
    })()`);
    if (swept && (swept.logs > 0 || swept.snaps > 0 || swept.files > 0 || swept.skel > 0)) {
      console.log(c.dim(`\n  收尾按标记清场：日志 ${swept.logs} 条 · 快照 ${swept.snaps} 份 · 自造文件/目录 ${swept.files} 个 · 骨架条目 ${swept.skel} 条`));
    }
  } catch (e) {
    // 清场失败不影响判据（它是**卫生**，不是断言）——但要说出来，别静默
    console.log(c.dim(`\n  收尾清场没跑起来（不影响判据）：${e?.message ?? e}`));
  }
  };
  /**
   * 🔴 **把清场挂给中断钩子**（P7.20-8 补的缺口）——
   * 原先"中断"与"正常跑完"是两条路：后者清场、前者不清，于是中断一次就留一地夹具。
   * 现在挂成同一份实现：中断时钩子会 `await sweepOnInterrupt()`。
   * ⚠️ 顺序：先在下面 `await sweepVault()` 跑本次收尾，**挂载要在那之前** ——
   *    万一清场过程中挨了中断，钩子也拿得到它。
   */
  sweepOnInterrupt = sweepVault;
  await sweepVault();

  if (skippedShots.length > 0) {
    console.log(
      c.bad(
        `\n⚠️ 本轮跳过了 ${skippedShots.length} 张截图（KBW_PROBE_SKIP_SHOT=1）—— ` +
          `tests/.tmp/probe 里的图**不是这一轮的**，别拿来当证据`,
      ),
    );
  }

  console.log(c.bold(`\n${pass} / ${pass + fails.length} 步通过`));
  if (fails.length > 0) {
    console.log(c.bad('\n未通过的：'));
    for (const f of fails) console.log(`  ✗ ${f.name}\n      ${f.info}`);
  }
  // 插件的错误分支全是 console.error('[经纬] …') + 继续 —— 只看未捕获异常会漏掉
  // "整块模块渲染崩了但界面还在"这种情况
  const pluginErrors = consoleErrors.filter((t) => t.includes('[经纬]'));
  if (pluginErrors.length > 0) {
    console.log(c.bad('\n插件内部报错 ' + pluginErrors.length + ' 条（它自己咽下去了，但探针不放过）：'));
    for (const e of [...new Set(pluginErrors)].slice(0, 6)) console.log('  ! ' + e);
    fails.push({ name: '插件内部 console.error', info: pluginErrors.length + ' 条，见上' });
  }
  // `[经纬]` 的 warning 同罪（P7.0b / 14.8a）：收进通道是为了**在这里点名**，
  // 不是为了存档 —— 只收不报等于还是没人看。**两条已知的除外**（见 KNOWN_WARNS）。
  const unknownWarns = pluginWarns.filter((t) => !KNOWN_WARNS.some((re) => re.test(t)));
  const knownWarns = pluginWarns.filter((t) => KNOWN_WARNS.some((re) => re.test(t)));
  if (knownWarns.length > 0) {
    console.log(c.dim('\n已知并接受的 warning ' + knownWarns.length + ' 条（见 scripts/probe.mjs 的 KNOWN_WARNS）：'));
    for (const w of [...new Set(knownWarns)].slice(0, 4)) console.log(c.dim('  · ' + w));
  }
  if (unknownWarns.length > 0) {
    console.log(c.bad('\n插件内部 warning ' + unknownWarns.length + ' 条（[经纬] 前缀，同 error 处置）：'));
    for (const w of [...new Set(unknownWarns)].slice(0, 6)) console.log('  ! ' + w);
    fails.push({ name: '插件内部 console.warn', info: unknownWarns.length + ' 条，见上' });
  }
  if (exceptions.length > 0) {
    console.log(c.bad(`\n页面里抛出的异常 ${exceptions.length} 条：`));
    for (const e of [...new Set(exceptions)].slice(0, 8)) console.log(`  ! ${e}`);
  } else {
    console.log(c.ok('\n没有未捕获异常 ✓'));
  }
  if (consoleErrors.length > 0) {
    console.log(c.dim(`\nconsole.error ${consoleErrors.length} 条（前 6 条）：`));
    for (const e of [...new Set(consoleErrors)].slice(0, 6)) console.log(c.dim(`  · ${e}`));
  }

  /**
   * ── 最慢 10 步（P7.20-5）───────────────────────────────────────
   * 回答那句一直没人答上的问题："探针跑 20 分钟，时间到底花在哪？"
   *   · 只算**带 script 的步**（见循环里的 `timings.push`）；
   *   · 顺带落 `step-timings.json`，给"提速前后对照"（P7.20-3）当基线 ——
   *     提速不能靠感觉，得跟这份数字比。
   */
  if (timings.length > 0) {
    const total = timings.reduce((s, t) => s + t.ms, 0);
    const sorted = [...timings].sort((a, b) => b.ms - a.ms);
    console.log(
      c.dim(`\n每步耗时合计 ${(total / 1000).toFixed(1)}s（${timings.length} 步）。最慢 10 步：`),
    );
    for (const t of sorted.slice(0, 10)) {
      console.log(c.dim(`  ${String(t.ms).padStart(7)}ms  ${t.name}`));
    }
    try {
      const p = path.join(OUT_DIR, 'step-timings.json');
      fs.writeFileSync(
        p,
        JSON.stringify({ total, count: timings.length, steps: sorted }, null, 2),
        'utf8',
      );
      console.log(c.dim(`  （清单：${p}）`));
    } catch {
      /* 落盘失败不影响判分 */
    }
  }

  probeLiveCdp = null;
  cdp.close();
  process.exit(fails.length > 0 || exceptions.length > 0 ? 1 : 0);
}

// ── 参数（2026-10-09：挪到连接机器**之前**校验 —— 名单/参数错就别去碰 Obsidian）──
/**
 * ⚠️ `--only` 两个都要拦（P0 修过一次，P1 大改时丢过）：
 *   · 后面没参数 → 不报错就会**跑全套**（含所有写库步骤）
 *   · 没有一步匹配 → 只跑前置然后打印"3/3 步通过"、退出码 0（收尾时的经典假绿）
 */
const ONLY_ARG = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return '';
  const v = process.argv[i + 1] ?? '';
  if (!v || v.startsWith('-')) {
    console.error(c.bad('✗ --only 后面要跟一个子串（比如：--only 样式）'));
    process.exit(1);
  }
  if (!STEPS.some((s) => !s.setup && s.name.includes(v))) {
    console.error(c.bad(`✗ 没有一步的名字含「${v}」—— 别以为"跑过了"`));
    console.error(c.dim('  可用的步骤：'));
    for (const s of STEPS) console.error(c.dim(`    ${s.setup ? '·' : ' '} ${s.name}`));
    process.exit(1);
  }
  return v;
})();
/**
 * **冒烟档**（`--smoke`，2026-10-09 拍定）：名单 = 上面的 `PROBE_SMOKE`（~18 步，跨轮共享链
 * 与平台契约的哨兵）；标准轮跑它、大轮/滚动轮跑全量。⚠️ **名单自证**：每个词必须至少命中
 * 一步 —— 步骤改名后名单静默缩水（"看起来 18 步全过"其实只剩 12 步）正是本项目最怕的形状，
 * 这里当场红（`probe-lint` 有一条同样的判据，改完 probe 的 0.2 秒自检里就会咬住）。
 */
const SMOKE_FLAG = process.argv.includes('--smoke');
if (SMOKE_FLAG && ONLY_ARG) {
  console.error(c.bad('✗ --smoke 与 --only 别一起用（一个走名单、一个走单串）'));
  process.exit(1);
}
const SMOKE_STEPS = SMOKE_FLAG
  ? STEPS.filter((s) => !s.setup && PROBE_SMOKE.some((n) => s.name.includes(n)))
  : [];
if (SMOKE_FLAG) {
  const missed = PROBE_SMOKE.filter((n) => !STEPS.some((s) => !s.setup && s.name.includes(n)));
  if (missed.length > 0) {
    console.error(c.bad(`✗ 冒烟名单里有 ${missed.length} 个词没命中任何步骤（步骤改名了？）：`));
    for (const n of missed) console.error(c.dim(`    ${n}`));
    console.error(c.dim('  改步骤名要同步改 PROBE_SMOKE —— 名单静默缩水 = 冒烟档悄悄变薄。'));
    process.exit(1);
  }
}
/**
 * **域档**（`--domain <名>`，P7.20-6）：只跑该域的步（+ 全部前置）。
 * ⚠️ 与 `--only` 同一条纪律：**参数错就别去碰 Obsidian**（这里当场校验，没命中就退出）。
 */
const DOMAIN_ARG = (() => {
  const i = process.argv.indexOf('--domain');
  if (i < 0) return '';
  const v = process.argv[i + 1] ?? '';
  if (!v || v.startsWith('-')) {
    console.error(c.bad('✗ --domain 后面要跟一个域名（比如：--domain board）'));
    process.exit(1);
  }
  const hit = STEPS.filter((s) => !s.setup && domainOf(s) === v);
  if (hit.length === 0) {
    const known = [...new Set(STEPS.filter((s) => !s.setup).map((s) => domainOf(s)))].sort();
    console.error(c.bad(`✗ 没有一步属于域「${v}」—— 别以为"跑过了"`));
    console.error(c.dim(`  已知的域：${known.join(' / ')}`));
    process.exit(1);
  }
  return v;
})();
if (DOMAIN_ARG && (ONLY_ARG || SMOKE_FLAG)) {
  console.error(c.bad('✗ --domain 与 --only / --smoke 别一起用（三档互斥）'));
  process.exit(1);
}

/**
 * `KBW_PROBE_SKIP_SHOT=1`（P7.20-7）—— **迭代轮跳过截图**。
 * 截图里每张都要 `ensureShotWindow` + `captureScreenshot`，是**证据不是判据**；
 * 改一步跑一轮时那些开销白花。**默认不跳**（收尾轮要留证据）。
 */
const SKIP_SHOT = process.env.KBW_PROBE_SKIP_SHOT === '1';

/**
 * **run token**（P7.20-8）—— 本轮的唯一标识，注入页面给 `P.wait` 校验（见 `probe-helpers.mjs`）。
 * 换掉它 = "叫停一切在跑的等待"：① 起手换 → 踢掉上一轮的残留步；② SIGINT 换 → 干净收尾。
 * ⚠️ 在参数段（连接机器**之前**）生成，主流程拿它注入页面。
 */
const RUN_TOKEN = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * ── 中断收尾钩子（P7.20-8）────────────────────────────────────
 * 🔴 **Ctrl+C 的默认行为是"立即终止"，会跳过所有 `finally`** —— 这就是 P7.20 实测过
 *    **两次**的那个后遗症：探针中断后 ① `obsidian.json` 停在实验库（外层 runner 的
 *    `finally` 没走到）② 实验库里留下 `__探针*` 夹具（页面内的收尾清场没走到）。
 *    两次都是**手工**复原的 —— 手工的东西会漏第三次。
 *
 * 这里把中断接管成**有序收尾**：
 *   ① 换掉页面 token → 正在跑的 `P.wait` 下一拍就发现 stale 而 reject，**不再动库**
 *      （这是"停手"的**机器解**，不依赖谁记得去关窗口）；
 *   ② 关掉 CDP 连接；
 *   ③ `exit(130)`（= 128 + SIGINT，跟"判据失败 = 1"分开，一眼能认出是挨了中断）。
 * ⚠️ `SIGINT` 与 `SIGTERM` **都接** —— 外部工具（含 宿主工具链 的 TaskStop）通常发 TERM，
 *    只接 SIGINT 的话第二种来源照样漏。
 * ⚠️ 钩子注册在**连接机器之前**：连接过程中挨了中断同样要干净退出。
 * ⚠️ 只做**这轮自己**的收尾；`obsidian.json` 的复原在**外层** `probe-run.mjs`
 *    （它也有自己的 SIGINT 钩子，见那文件）—— 两层各管自己那摊。
 */
let probeLiveCdp = null;
/**
 * 中断时要兜的那一手**收尾清场**（`main` 把它的实现挂到这里，见 `sweepOnInterrupt = sweepVault`）。
 * 为什么非要接上：清场是"按硬标记删 `__探针*` 文件/目录 + 点名删快照 + 抹骨架里那条"，
 * 原先只在**整轮跑完之后**调 —— 一挨中断就跳过，库里就留夹具（P7.20 实测过一次，
 * 手工 `rm` 清的）。挂上它之后，"中断"与"正常跑完"走**同一份**清场代码，不再两套。
 */
let sweepOnInterrupt = null;
let intHandled = false;
const onInterrupt = (sig) => {
  if (intHandled) process.exit(130); // 连按两下 = 别再等，立刻走
  intHandled = true;
  console.error(c.dim(`\n\n收到 ${sig} —— 停手：换 token / 关连接，收尾后就退`));
  const done = () => process.exit(130);
  if (!probeLiveCdp) return done();
  (async () => {
    // ① 先换 token：在跑的等待下一拍自己 reject —— **停手**要赶在清场之前，
    //    否则清场扫库的时候还有步在写库（那就是"边扫边写"）
    try {
      await probeLiveCdp.eval(`window.__kbwProbeRun = ${JSON.stringify('cancel-' + Date.now())};`);
      console.error(c.dim('  已换掉页面 token：在跑的等待会自己停'));
    } catch {
      /* 页面没了 / 连不上 —— 那本来也没东西在跑 */
    }
    // ② 兜一手收尾清场：把这一轮自造的 __探针* 文件/目录 + 点名的快照删掉。
    //    ⚠️ 这一步正是"中断后库里留夹具"那个后遗症的机器解 —— 不接上它，等于没修。
    if (sweepOnInterrupt) {
      try {
        await sweepOnInterrupt();
        console.error(c.dim('  已按标记清场（__探针* / 快照 / 骨架条目）'));
      } catch (e) {
        console.error(c.dim(`  中断清场没跑起来（库里可能留 __探针* 夹具）：${e?.message ?? e}`));
      }
    }
    try {
      probeLiveCdp.close();
    } catch {
      /* 同上 */
    }
    done();
  })();
};
process.on('SIGINT', () => onInterrupt('SIGINT'));
process.on('SIGTERM', () => onInterrupt('SIGTERM'));

// 档位横幅（在连接前打——参数错了上面就退了，不会留下"像是跑过了"的印象）
if (ONLY_ARG) {
  const nMatch = STEPS.filter((s) => !s.setup && s.name.includes(ONLY_ARG)).length;
  console.log(`（只跑名字含「${ONLY_ARG}」的 ${nMatch} 步 + ${STEPS.filter((s) => s.setup).length} 个前置）\n`);
} else if (SMOKE_FLAG) {
  console.log(
    `（冒烟档：${SMOKE_STEPS.length} 步（PROBE_SMOKE 名单）+ ${STEPS.filter((s) => s.setup).length} 个前置；` +
      `全量请跑不带参数的 npm run probe）\n`,
  );
}

/**
 * ⚠️ `KBW_PROBE_NO_RUN=1` → **只加载、不跑**（给 `tests/specs/redline.ts` 的静态断言用）：
 * 那条断言 `import()` 这个文件，只为验证"整份脚本**能被求值**" ——
 * 步骤模板里混进一个反引号会提前结束模板、把后面的中文注释变成真代码
 * （`node --check` 只查语法、**查不出**这种，P4 那半天里栽过四次）。
 */
if (process.env.KBW_PROBE_NO_RUN === '1') {
  // 只求值，不连 CDP
} else {
  main().catch((e) => {
    console.error(c.bad(`\n探针跑挂了：${e?.stack ?? e}`));
    process.exit(1);
  });
}
