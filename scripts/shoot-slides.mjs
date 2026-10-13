// 拍讲解页配图（2026-10-13 · 8 张）
//
// 连 CDP → 钉 1400×900 视口 → 逐屏把演示库布置成目标状态 → 截图。
// 产出：`素材/讲解页-2026-10-13/`
//   · `NN-xxx-full.png` = 整幅（1400×900，存档）
//   · `NN-xxx.png`      = 裁到工作台视图区（`.kbw-shell` 的矩形）—— 插进讲解页用这一份
//
// 命令行（按顺序走，与 shoot-wizard 同一套）：
//   1) npm run build && node scripts/make-demo-vault.mjs --force   ← 演示库（全假内容）
//   2) node scripts/shoot-wizard.mjs --register                    ← 登记演示库（Obsidian 必须完全退出）
//   3) KBW_LAUNCH_MIN=0 npm run probe:launch                       ← 带调试端口启动（截图要可见窗）
//   4) KBW_VAULT_SANDBOX="<演示库>" node scripts/shoot-slides.mjs  ← 拍
//   5) （退出 Obsidian 后）node scripts/shoot-wizard.mjs --restore ← 还原 obsidian.json
//
// 拍前演示库要有的东西（make-demo-vault 之后另配，一次性）：
//   · `.obsidian/plugins/kb-workbench/data.json`：抄一份 AI 配置（study 用）+ wizardDone/notesIntroSeen
//   · `01_新知识库/99_Meta/06_工作台/复习.json`：3 张今日到期的卡（第 5 张用）
//   · `01_新知识库/99_Meta/06_工作台/skills/收件箱速理.md`：能力包（第 6 / 8 张用）
//   · 本脚本自己会补：看板配置 4 板块（第 4 张）、技术笔记 +3 篇（第 2 张）
//
// 判据（脚本自己盯的）：
//   · **只连演示库**：走 cdp-page 的沙盒守卫（KBW_VAULT_SANDBOX 必须指向演示库，否则拒跑）；
//   · 窗口不可见 → 直接失败（截图会超时/拿到陈旧帧）；
//   · 每张拍完立刻**回读文件存在且非空**；每一步的状态断言不成立 → 拍一张 `_debug` 图再退出；
//   · 动库的步骤都带自清理（撤销 / 取消 / 还原），收尾把主题拨回明色。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectSandbox, bringToFront } from './cdp-page.mjs';
import { sandboxVault } from './vault-guard.mjs';
import { HELPERS } from './probe-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.resolve(process.env.KBW_DEMO_VAULT || 'C:/Users/<你的用户名>/OneDrive/Desktop/插件演示库');
const OUT = path.join(ROOT, '素材', '讲解页-2026-10-13');

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};
const fail = (m) => {
  console.error(`\n${c.bad('✗')} ${m}\n`);
  process.exit(1);
};

async function main() {
  // ── 守卫 ────────────────────────────────────────────────────────
  const sb = sandboxVault();
  if (path.resolve(sb).toLowerCase() !== DEMO.toLowerCase()) {
    fail(
      `KBW_VAULT_SANDBOX 必须指向演示库（当前 ${sb} / 期望 ${DEMO}）——\n` +
        `  即：KBW_VAULT_SANDBOX="${DEMO}" node scripts/shoot-slides.mjs`,
    );
  }
  if (!fs.existsSync(DEMO)) fail(`演示库不存在：${DEMO} —— 先跑 node scripts/make-demo-vault.mjs --force`);

  const cdp = await connectSandbox({ what: '拍讲解页配图' });
  try {
    const { visible } = await bringToFront(cdp, { allowMinimized: false });
    if (!visible) {
      fail('窗口不可见（最小化/被遮住）—— 截图会超时或拿到陈旧帧。用 KBW_LAUNCH_MIN=0 npm run probe:launch 重启');
    }
    // 钉视口：1400×900、dsf 1 —— 与拍图规范一致
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.enable').catch(() => {});

    const evalJs = async (expression, timeoutMs = 60000) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        timeoutMs,
      );
      if (r.exceptionDetails) {
        throw new Error(`页面里异常：${r.exceptionDetails.text ?? ''} ${r.exceptionDetails.exception?.description ?? ''}`);
      }
      return r.result?.value;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    fs.mkdirSync(OUT, { recursive: true });
    await evalJs(HELPERS); // 页内工具集（P.xxx）
    console.log(`连上了：${cdp.vault}\n`);

    /** 拍两张：整幅存档 + 裁到工作台视图区的成品；返回成品像素尺寸 */
    const shot = async (name) => {
      // 清平台通知（toast 是会话态，会飘在角上）；插件自己的通知栈也清掉孩子们（容器留着，不影响后续通知）
      await evalJs(`(() => {
        document.querySelectorAll('.notice-container').forEach((n) => n.remove());
        const kn = document.querySelector('.kbw-notices');
        if (kn) Array.from(kn.children).forEach((k) => k.remove());
        return true;
      })()`).catch(() => {});
      const full = path.join(OUT, `${name}-full.png`);
      const r1 = await cdp.send('Page.captureScreenshot', { format: 'png' }, 30000);
      fs.writeFileSync(full, Buffer.from(r1.data, 'base64'));
      const clip = await evalJs(
        `(() => { const el = document.querySelector('.kbw-shell'); if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(Math.max(0, r.left)), y: Math.round(Math.max(0, r.top)),
                   width: Math.round(Math.min(r.width, window.innerWidth - Math.max(0, r.left))),
                   height: Math.round(Math.min(r.height, window.innerHeight - Math.max(0, r.top))) }; })()`,
      );
      if (!clip || clip.width < 200 || clip.height < 200) fail(`取景失败（.kbw-shell 不在？）—— 拍 ${name} 时`);
      const one = path.join(OUT, `${name}.png`);
      const r2 = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } }, 30000);
      fs.writeFileSync(one, Buffer.from(r2.data, 'base64'));
      const size = fs.statSync(one).size;
      if (size <= 0) fail(`截图写出来是空的：${one}`);
      console.log(`  · ${name}.png ${clip.width}×${clip.height} ${(size / 1024).toFixed(0)} KB`);
      return { w: clip.width, h: clip.height };
    };

    /** 状态断言不成立 → 拍一张 _debug 再退；`--only <前缀>` 只跑匹配的那步（"0 布置"永远跑） */
    const ONLY = (() => {
      const i = process.argv.indexOf('--only');
      return i >= 0 ? String(process.argv[i + 1] ?? '') : '';
    })();
    /** `--stub-ai`：第 6/8 张用**演示桩**回话（探针证据图的同款做法）——
     *  真跑的流程里，需确认拦截会把每条动作的存在性探测画成红行（「库里找不到 …」），
     *  真机实测三次都有；成图要干净就用桩（UI 与真跑一字不差）。 */
    const STUB = process.argv.includes('--stub-ai');
    const step = async (label, fn) => {
      if (ONLY && !label.startsWith('0') && !label.startsWith(ONLY)) {
        console.log(`  · 跳过 ${label}（--only ${ONLY}）`);
        return { ok: true, skipped: true };
      }
      const r = await fn();
      if (!r || r.ok !== true) {
        await shot(`_debug-${label.replace(/[^\w-]/g, '')}`).catch(() => {});
        fail(`[${label}] ${r ? r.info : '没有返回'}`);
      }
      console.log(`${c.ok('✓')} ${label} ${c.dim(r.info ?? '')}`);
      return r;
    };

    // ── 0 · 布置：工作台开出 + 造 3 篇笔记（第 2 张的行数）+ 看板配置（第 4 张）──
    await step('0 布置', async () => {
      const r = await evalJs(`(async () => {
        const app = window.app; const P = window.__kbwProbe; const ctx = P.ctx(); const w = P.wait;
        if (app.workspace.getLeavesOfType('kb-workbench-view').length === 0) {
          const l = app.workspace.getLeaf('tab');
          await l.setViewState({ type: 'kb-workbench-view', active: true });
          await w(1500);
        }
        P.closeAll(4); await w(400);
        const NL = String.fromCharCode(10);
        const fm = (title) => ['---','类型: 笔记','状态: 进行中','创建日期: 2026-09-18','文件位置:','  - 03_Resources/技术笔记','收藏: false','tags:','  - 笔记法','---','','# ' + title,''].join(NL);
        const mk = async (name, text) => {
          const rel = ctx.settings.kbRoot() + '/03_Resources/技术笔记/' + name + '.md';
          if (!app.vault.getAbstractFileByPath(rel)) await app.vault.create(rel, fm(name) + NL + text);
        };
        await mk('为什么笔记要常重读', '重读时才发现：当时以为记下的「要点」，一半是想当然。');
        await mk('读书笔记的三层结构', '摘录 → 转述 → 自己的问题。停在第一层，等于没读。');
        await mk('每周回顾怎么做', '周五留二十分钟：过一遍「最近改动」，删掉三篇，剩下的各写一行为什么留。');
        await w(900);
        // 回首页再数（.kbw-todo 只在首页有）
        const homeNav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('首页'));
        if (homeNav) P.click(homeNav);
        await w(1100);
        // 看板配置：4 个文件夹源板块（已在就跳过）
        const brd = ctx.settings.kbRoot() + '/99_Meta/06_工作台/看板配置.json';
        const cur = app.vault.getAbstractFileByPath(brd);
        let txt = ''; try { txt = cur ? await app.vault.read(cur) : ''; } catch (e) {}
        if (txt.indexOf('sec-a') < 0) {
          const sec = (id, name, value) => ({ id, name, kind: 'folder', value, exclude: [], limit: null, sort: null, cardMode: null, props: null });
          const cfg = JSON.stringify({ version: 1, view: {}, sections: [
            sec('sec-a','收件箱','00_Inbox'), sec('sec-b','项目','01_Projects'),
            sec('sec-c','领域','02_Areas'), sec('sec-d','资源','03_Resources') ] }, null, 2);
          if (cur) await app.vault.modify(cur, cfg); else await app.vault.create(brd, cfg);
          await w(700);
        }
        const todo = P.qa('.kbw-todo').length;
        return { ok: todo >= 2, info: '待处理行 ' + todo };
      })()`);
      return r;
    });

    // ── 1 · 首页 ────────────────────────────────────────────────────
    await step('1 首页', async () => {
      const r = await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('首页')); P.click(nav);
        await w(1100);
        const hasPend = (P.text(document.querySelector('.kbw-home')) || '').indexOf('待处理') >= 0;
        return { ok: hasPend, info: hasPend ? '' : '首页没看到「待处理」' };
      })()`);
      if (r.ok) await shot('01-home');
      return r;
    });

    // ── 2 · 全部笔记：勾 4 篇、批量栏出现 ───────────────────────────
    await step('2 全部笔记', async () => {
      const r = await evalJs(`(async () => {
        const P = window.__kbwProbe; const ctx = P.ctx(); const w = P.wait;
        const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('全部笔记')); P.click(nav); await w(800);
        ctx.goNotes({ dir: '03_Resources/技术笔记' }); await w(1300);
        await P.useView('详细信息'); await w(700);
        const rows = P.qa('.kbw-trow[data-path]');
        if (rows.length < 4) return { ok: false, info: '行数只有 ' + rows.length + '（要 ≥4）' };
        // ⚠️ P.click **不吃修饰键**（helpers 版固定无 init）—— ctrl 点选必须自己发事件
        const ctrl = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
        P.click(rows[0]); await w(300);
        for (let i = 1; i <= 3; i++) { ctrl(rows[i]); await w(220); }
        await w(500);
        const bar = P.q('.kbw-notes-bar.is-batch');
        const txt = bar ? P.text(bar) : '';
        return { ok: !!bar && txt.indexOf('已选 4 篇') >= 0, info: txt.slice(0, 40) };
      })()`);
      if (r.ok) await shot('02-notes');
      return r;
    });

    // ── 3 · 笔记确认卡（迁移到 02_Areas → 确认卡 → 取消）────────────
    await step('3 笔记确认卡', async () => {
      const r = await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        const bar = P.q('.kbw-notes-bar.is-batch');
        if (!bar) return { ok: false, info: '批量栏不在（第 2 步的选中丢了？）' };
        P.click(P.btnByText('迁移', bar)); await w(700);
        const node = P.qa('.kbw-menu .kbw-menu-item').find((i) => P.text(i).includes('02_Areas'));
        if (!node) return { ok: false, info: '迁移菜单里没有 02_Areas' };
        node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await w(700);
        const pick = P.qa('.kbw-menu .kbw-menu-item').find((i) => P.text(i).includes('移到「02_Areas」'));
        if (!pick) return { ok: false, info: '子菜单里没有「移到 02_Areas」' };
        P.click(pick); await w(1400);
        const m = P.lastModal();
        const txt = m ? P.text(m) : '';
        return { ok: !!m && txt.indexOf('即将移动') >= 0, info: txt.slice(0, 60) };
      })()`);
      if (r.ok) await shot('03-notes-confirm');
      await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        const m = P.lastModal(); if (m) { const x = P.btnByText('取消', m); if (x) { P.click(x); await w(1000); } }
        const bar = P.q('.kbw-notes-bar.is-batch');
        if (bar) { const x = P.qa('button', bar).find((b) => (b.getAttribute('aria-label') || '').indexOf('清空选择') >= 0); if (x) { P.click(x); await w(500); } }
        return true;
      })()`);
      return r;
    });

    // ── 4 · 看板：拖一张卡换栏（撤销条在屏）→ 撤销还原 ──────────────
    await step('4 看板拖动', async () => {
      const r = await evalJs(`(async () => {
        const P = window.__kbwProbe; const ctx = P.ctx(); const w = P.wait;
        const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('看板')); P.click(nav); await w(1600);
        const card = P.qa('[data-card]').find((c2) => (c2.getAttribute('data-path') || '').indexOf('灵感：周报自动化') >= 0);
        const drops = P.qa('[data-drop="sec-b"]');
        const target = drops[drops.length - 1];
        if (!card) return { ok: false, info: '源卡片不在（板块没配好？）' };
        if (!target) return { ok: false, info: '目标放置区 sec-b 不在' };
        const bodyEl = P.q('.kbw-board-body');
        const scrollBody = (el, frac) => {
          if (!bodyEl || !el) return;
          const b = bodyEl.getBoundingClientRect(); const rr = el.getBoundingClientRect();
          bodyEl.scrollTop += Math.round(rr.top - b.top - b.height * frac);
          document.documentElement.scrollTop = 0;
        };
        scrollBody(card, 0.15); await w(300);
        let fromPt = P.rectAt(card); let toPt = P.rectAt(target);
        const hits = (pt, el) => { const u = P.elAt(pt.x, pt.y); return !!u && (u === el || el.contains(u)); };
        if (!(hits(fromPt, card) && hits(toPt, target))) { scrollBody(target, 0.6); await w(320); fromPt = P.rectAt(card); toPt = P.rectAt(target); }
        if (!(hits(fromPt, card) && hits(toPt, target)) || !fromPt.visible || !toPt.visible) {
          return { ok: false, info: '两个点打不到实体/不在视野（源 ' + JSON.stringify(fromPt) + ' 目标 ' + JSON.stringify(toPt) + '）' };
        }
        P.pointerDownAt(fromPt.x, fromPt.y); await w(40);
        for (let t = 1; t <= 8; t++) {
          P.pointerMoveTo(fromPt.x + (toPt.x - fromPt.x) * t / 8, fromPt.y + (toPt.y - fromPt.y) * t / 8);
          await w(25);
        }
        P.pointerUpAt(toPt.x, toPt.y);
        await w(1200);
        const undo = P.q('.kbw-undobar');
        const moved = !!app.vault.getAbstractFileByPath(ctx.settings.kbRoot() + '/01_Projects/灵感：周报自动化.md');
        return { ok: !!undo && moved, info: '撤销条=' + !!undo + ' 已搬=' + moved };
      })()`);
      if (r.ok) await shot('04-board');
      await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        const undo = P.q('.kbw-undobar');
        const btn = undo ? P.btnByText('撤销', undo) : null;
        if (btn) { P.click(btn); await w(2400); }
        return true;
      })()`);
      return r;
    });

    // ── 5 · 复习：开浮层 → 空格翻面 ────────────────────────────────
    await step('5 复习', async () => {
      const r = await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('回顾')); P.click(nav); await w(1000);
        const start = P.q('.kbw-review-start');
        if (!start || start.hasAttribute('disabled')) return { ok: false, info: '「开始复习」不在/置灰（卡没到期？）' };
        P.click(start); await w(700);
        if (!P.q('.kbw-review-session')) return { ok: false, info: '复习浮层没开出来' };
        P.key(' '); await w(600);
        const face = P.q('.kbw-rs-face');
        return { ok: !!face && P.text(face).length > 0, info: '卡面 ' + P.text(face).slice(0, 24) };
      })()`);
      if (r.ok) await shot('05-review');
      await evalJs(`(async () => { const P = window.__kbwProbe; const w = P.wait; P.key('Escape'); await w(800); return true; })()`);
      return r;
    });

    // ── 6 · 助手：跑「整理收件箱」→ 提案表（--stub-ai 时用演示桩）────────
    await step('6 助手提案', async () => {
      if (STUB) {
        const okStub = await evalJs(`(() => {
          const P = window.__kbwProbe;
          return P.stubAi(JSON.stringify({
            reply: '收件箱里这两篇：读书笔记归 02_Areas/内容创作，周报那条灵感归 03_Resources/灵感杂记；两篇顺手把状态改成「进行中」。',
            ideas: [
              { path: '00_Inbox/读《卡片笔记写作法》.md', to: '02_Areas/内容创作', why: '读书方法论笔记，归内容创作' },
              { path: '00_Inbox/灵感：周报自动化.md', to: '03_Resources/灵感杂记', why: '自动化灵感，归灵感杂记' }
            ]
          }));
        })()`);
        if (!okStub) return { ok: false, info: 'stubAi 没装上' };
      }
      const open = await evalJs(`(async () => {
        const P = window.__kbwProbe; P.closeAll(4); await P.wait(400);
        // 清掉历史会话 —— 面板会恢复上一次会话，残留的旧提案表会冒充"这一轮的提案"
        const store = P.ctx().ai.sessions;
        for (const m of await store.list()) await store.remove(m.id);
        await P.wait(300);
        return await P.openAiPanel();
      })()`);
      if (open !== '') return { ok: false, info: '开面板失败：' + open };
      const r = await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        const err = await P.askAi('帮我把收件箱整理一下');
        if (err) return { ok: false, info: err };
        let answered = false; let n = 0;
        const done = () => P.qa('.kbw-ai-plan .kbw-ai-row').length > 0 || !!P.q('.kbw-ai-acts') || !!P.q('.kbw-ai-bubble.is-error');
        while (n < 90 && !done()) {
          const ask = P.q('.kbw-ai-ask');
          if (ask && !answered) {
            const input = P.q('.kbw-ai-ask-input');
            const ans = P.qa('.kbw-ai-ask .kbw-btn').find((b) => P.text(b) === '回答');
            if (input && ans) {
              input.value = '读书笔记归 02_Areas/内容创作；周报那条放 03_Resources/灵感杂记就行';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              P.click(ans); answered = true; await w(600); continue;
            }
          }
          await w(1300); n += 1;
        }
        const rows = P.qa('.kbw-ai-plan .kbw-ai-row').length;
        const errBubble = !!P.q('.kbw-ai-bubble.is-error');
        return { ok: rows > 0 && !!P.q('.kbw-ai-acts') && !errBubble, info: '提案 ' + rows + ' 行·等待 ' + Math.round((n * 1.3)) + 's' + (errBubble ? '（红框报错）' : '') };
      })()`, 180000);
      if (r.ok) await shot('06-ai-plan');
      return r;
    });

    // ── 8 · 助手确认卡（从第 6 步的提案表往下走）→ 取消 ─────────────
    await step('8 助手确认卡', async () => {
      const r = await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        const run = P.qa('.kbw-ai-acts .kbw-btn').find((b) => P.text(b).indexOf('执行这') === 0);
        if (!run) return { ok: false, info: '没有「执行这 N 项」（第 6 步的提案表没了？）' };
        P.click(run); await w(1100);
        const m = P.lastModal();
        const txt = m ? P.text(m) : '';
        // 两种文案都认：纯移动 =「即将按 AI 的建议移动 N 篇」；混了属性改动 =「AI 要做 N 项改动」
        const ok = !!m && (txt.indexOf('即将按 AI 的建议') >= 0 || txt.indexOf('AI 要做') >= 0);
        return { ok, info: txt.slice(0, 50) };
      })()`);
      if (r.ok) await shot('08-ai-confirm');
      await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        const m = P.lastModal(); if (m) { const x = P.btnByText('取消', m); if (x) { P.click(x); await w(2500); } }
        P.closeAll(4); await w(600);
        return true;
      })()`);
      return r;
    });

    // ── 7 · 暗色（最后一拍；拍完拨回明色）───────────────────────────
    await step('7 暗色', async () => {
      const r = await evalJs(`(async () => {
        const P = window.__kbwProbe; const w = P.wait;
        P.closeAll(4); await w(400);
        P.setTheme('obsidian'); await w(900);
        const dark = P.isDark();
        const nav = P.qa('.kbw-navitem').find((b) => P.text(b).includes('首页')); P.click(nav); await w(1100);
        return { ok: dark, info: dark ? '' : '没切到暗色' };
      })()`);
      if (r.ok) await shot('07-dark');
      await evalJs(`(async () => { const P = window.__kbwProbe; P.setTheme('moonstone'); await P.wait(700); return !P.isDark(); })()`);
      return r;
    });

    console.log(`\n${c.ok('全部拍完')} → ${path.relative(ROOT, OUT)}`);
    console.log(c.dim('  下一步：压缩转换（WebP/JPEG）→ 内嵌进讲解页；收尾记得 shoot-wizard --restore'));
  } finally {
    cdp.close();
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
