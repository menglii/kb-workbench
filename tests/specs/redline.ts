/**
 * spec：**红线判据**（「真库不许动」的可断言不变量）
 *
 * 为什么要有这条：文字约定拦不住误操作 —— 所以红线的实际执行点
 * 只剩 `scripts/vault-guard.mjs`（`deploy.mjs` / `probe.mjs` / `reload.mjs` / `cdp-eval.mjs` 共用）。
 * P0 收尾的独立审查实测出两个洞（`deploy` 的 KBW_VAULT_SANDBOX 能被指向真库却仍打印"实验库"、
 * `probe` 的守卫 `??` 导致空串关掉它）—— 这条 spec 把那两个洞钉死。
 *
 * ⚠️ 本 spec **只调纯函数，绝不触发任何写操作**（连 deploy 脚本都不碰）。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Suite, eq, ok } from '../framework';
import { DEFAULT_HIDDEN, DEFAULT_VISIBLE_IDS } from '../../src/modules/notes/columns';
import { SPECS } from '../../src/services/schema';
import { CLEANUP_KEYS } from '../../src/services/cleanup';
import { realTargetAllowed } from '../../scripts/cdp-page.mjs';
import { STYLE_ORDER } from '../../scripts/styles.mjs';
import { MODULES, MODULE_IDS } from '../../src/core/settings';
import {
  assertBackupTarget,
  assertWritableSandbox,
  isRealVault,
  realVault,
  resolveDeployTarget,
  sandboxVault,
} from '../../scripts/vault-guard.mjs';

export async function specRedline(suite: Suite): Promise<void> {
  const real = realVault();
  const sandbox = sandboxVault();
  /** 环境变量把实验库指向真库时（审查实测的那条），"实验库"本身就是真库 —— 期望要跟着变 */
  const sandboxIsReal = isRealVault(sandbox);

  await suite.group('红线判据（真库不许动）', async () => {
    await suite.it('真库路径一律认出来（子路径 / 大小写 / 尾斜杠都不放过）', () => {
      ok(isRealVault(real), '真库根');
      ok(isRealVault(`${real}/.obsidian/plugins/kb-workbench`), '真库下的子路径');
      ok(isRealVault(real.toUpperCase()), '大写混写');
      ok(isRealVault(`${real}/`), '带尾斜杠');
      ok(isRealVault(`${real}${real.includes('\\') ? '\\' : '/'}x`), '另一个分隔符');
    });

    await suite.it('实验库路径**不是**真库（除非环境变量把它指到了真库）', () => {
      eq(isRealVault(sandbox), sandboxIsReal, `sandbox=${sandbox}`);
    });

    await suite.it('assertWritableSandbox：真库拒绝、实验库放行、空串与无关路径拒绝', () => {
      eq(assertWritableSandbox(real, '测试').ok, false, '真库必须拒绝');
      ok(assertWritableSandbox(real, '测试').reason.includes('真库'), '理由里要写明是真库');
      eq(assertWritableSandbox('', '测试').ok, false, '拿不到路径也要拒绝');
      eq(assertWritableSandbox('C:/tmp/随便哪个目录', '测试').ok, false, '非实验库拒绝');
      eq(assertWritableSandbox(sandbox, '测试').ok, !sandboxIsReal, '实验库放行');
    });

    await suite.it('KBW_VAULT_MUST_INCLUDE 空串**不能**关掉守卫（原漏洞）', () => {
      // probe 用 `||` 而不是 `??`：空串要落回默认值
      const asWritten = process.env.KBW_VAULT_MUST_INCLUDE ?? 'sandbox-vault'; // 旧写法
      const fixed = process.env.KBW_VAULT_MUST_INCLUDE || 'sandbox-vault'; // 现在的写法
      if (process.env.KBW_VAULT_MUST_INCLUDE === '') {
        eq(asWritten, '', '`??` 会把空串当有效值（这就是那个漏洞）');
        eq(fixed, 'sandbox-vault', '`||` 会落回默认值');
      }
      // 不管环境变量怎么设，真库都必须被拦住 —— 这条才是真正的保证
      const fakeRealProbe = `(root) => ${JSON.stringify('')}.includes(root)`;
      void fakeRealProbe;
      eq(assertWritableSandbox(real).ok, false, '无论环境变量怎么设，真库都写不了');
    });

    await suite.it('CDP 脚本一律接红线判据（**静态**：防"文档说接了、代码没接"）', () => {
      // 这条是 P1 收尾的独立审查逼出来的：P0 的交接写着"probe 的 `??` 已改 `||`、
      // reload/cdp-eval 也接上了同一判据"，而实际**三处里两处没做** ——
      // 文档说修了、代码没修，只有把源码读出来断言才拦得住
      const root = path.resolve(__dirname, '..', '..');
      const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

      const probe = read('scripts/probe.mjs');
      ok(!/KBW_VAULT_MUST_INCLUDE\s*\?\?/.test(probe), 'probe 的库判据不能用 `??`（空串会放行任何库）');
      ok(probe.includes('assertWritableSandbox'), 'probe 必须用 vault-guard 的双判据挑页');
      ok(probe.includes('guard: true'), '红线那一步要带 guard 标记（不过就整轮中止）');

      for (const f of ['scripts/reload.mjs', 'scripts/cdp-eval.mjs']) {
        const src = read(f);
        ok(src.includes("from './cdp-page.mjs'"), `${f} 必须经 cdp-page 按库路径挑页`);
        ok(!/json\/list/.test(src), `${f} 不许自己裸连调试端口（那正是漏掉判据的写法）`);
      }

      ok(read('scripts/deploy.mjs').includes('KBW_ALLOW_REAL'), 'deploy 的 --yes 要 KBW_ALLOW_REAL=1 双保险');

      // 布尔属性那条：`setAttribute('disabled', 'false')` **在即为禁用** ——
      // 真机症状是"按钮看着亮的、点了毫无反应"，而离线用例与探针都走 `dispatchEvent`
      //（它不吃 disabled）→ 两层全假绿。所以这里把源码读出来钉死（P2 收尾的独立审查抓到）。
      const srcFiles: string[] = [];
      const walkSrc = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walkSrc(full);
          else if (e.name.endsWith('.ts')) srcFiles.push(full);
        }
      };
      walkSrc(path.join(root, 'src'));
      // ⚠️ 判据只认**真形状**（第二个实参就是带引号的 'false'）：写宽了会误伤
      // "解释这个坑的注释"（第一次就这么假红了一次）
      const offenders = srcFiles.filter((f) =>
        /setAttribute\(\s*['"]disabled['"]\s*,\s*['"]false['"]/.test(fs.readFileSync(f, 'utf8')),
      );
      eq(
        offenders.map((f) => path.relative(root, f)).join('、'),
        '',
        "不许用 setAttribute 写 disabled='false'（布尔属性在即为禁用 → 用 toggleAttribute）",
      );
    });

    await suite.it('vault-backup：目的地判据**按行为**验（源码子串会被注释骗过）', () => {
      // ⚠️ 独立审查实测：早先这条是"源码里有 `KBW_ALLOW_REAL` 就算过"——
      // 而文件头与紧邻注释里恰好写着它 → **把双保险整块删掉也照样绿**（单标志后门回来了）。
      // 现在断言的是 `assertBackupTarget` 的**行为**：四种组合逐一验。
      const inReal = `${real}/.tooling/backup/x`;
      eq(assertBackupTarget(inReal).ok, false, '往真库里备份：默认拒绝');
      eq(assertBackupTarget(inReal, { allowReal: true, env: {} }).ok, false, '只给标志还不够');
      eq(
        assertBackupTarget(inReal, { allowReal: true, env: { KBW_ALLOW_REAL: '1' } }).ok,
        true,
        '标志 + 环境变量两个都给才放行',
      );
      eq(
        assertBackupTarget(`${sandbox}/.tooling/backup/x`, { env: {} }).ok,
        !sandboxIsReal,
        '实验库里备份：放行',
      );
      ok(assertBackupTarget(inReal, { allowReal: true, env: {} }).reason.includes('KBW_ALLOW_REAL'), '拒绝理由要说清怎么才能放行');
    });

    await suite.it('vault-backup：--only 不许跑出库外（静态）', () => {
      const root2 = path.resolve(__dirname, '..', '..');
      const backup = fs.readFileSync(path.join(root2, 'scripts/vault-backup.mjs'), 'utf8');
      ok(backup.includes("from './vault-guard.mjs'"), '必须复用 vault-guard 的判据');
      ok(/parts\.includes\('\.\.'\)/.test(backup), '--only 要拦住 `..`（否则能拷走库上一级）');
    });

    await suite.it('真库通道（CDP 挑页）：默认关、缺一个环境变量也不行、两个都给才放行', () => {
      // 2026-09-24 加：用户明确发话"在真库上执行"时才用的临时通道。
      // 这条按**行为**验，不靠"源码里有这个字符串"（上一次那种写法被注释骗过）
      eq(realTargetAllowed(real, {}), null, '默认（没有环境变量）拒绝');
      eq(realTargetAllowed(real, { KBW_ALLOW_REAL: '1' }), null, '只给 KBW_ALLOW_REAL 拒绝');
      eq(realTargetAllowed(real, { KBW_REAL_TARGET: 'real-vault' }), null, '只给目标也拒绝');
      eq(
        realTargetAllowed(real, { KBW_ALLOW_REAL: '1', KBW_REAL_TARGET: '别的库' }),
        null,
        '目标对不上也拒绝',
      );
      ok(
        realTargetAllowed(real, { KBW_ALLOW_REAL: '1', KBW_REAL_TARGET: 'real-vault' }) != null,
        '两个都给、目标也对 → 才放行',
      );
      eq(realTargetAllowed('', { KBW_ALLOW_REAL: '1', KBW_REAL_TARGET: '' }), null, '空目标拒绝（`||` 不是 `??`）');
    });

    await suite.it('resolveDeployTarget：真库判定**按路径**，不看 --real', () => {
      const viaReal = resolveDeployTarget(true);
      eq(viaReal.isReal, true, '--real → 真库');
      const viaPath = resolveDeployTarget(false);
      // 关键：不带 --real，但只要解析出来的目标就是真库（环境变量干的），也必须认出真库
      eq(viaPath.isReal, isRealVault(viaPath.target), '目标路径说了算');
      if (!sandboxIsReal) eq(viaPath.isReal, false, '正常情况下默认目标是实验库');
    });
  });

  /**
   * P4 看板：三条硬规矩的静态断言。
   * 为什么必须钉：P3 的独立审查抓到过"文档说做了、代码没做"；看板这一层
   * 同样容易在后续改动里悄悄绕开 —— 这几条是**源码级**的，不靠人肉 review。
   * 判据一律先剥注释（注释里写不出 `renameFile(` 这种调用形态也照样会被误伤，
   * 见 P3 那条"既假绿又假红"的教训）。
   */
  await suite.group('P4 · 红线（看板的硬规矩钉在源码里）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const boardFiles = fs
      .readdirSync(path.join(root, 'src/modules/board'))
      .filter((f) => f.endsWith('.ts'));
    const boardSrc = boardFiles
      .map((f) => stripComments(fs.readFileSync(path.join(root, 'src/modules/board', f), 'utf8')))
      .join('\n');

    await suite.it('看板不许自己动文件：`renameFile` / `trashFile` / `vault.delete` 一个都不许有', () => {
      ok(!/renameFile\s*\(/.test(boardSrc), '看板里不许直接调 renameFile（要走 services/mover.ts）');
      ok(!/trashFile\s*\(/.test(boardSrc), '看板里不许直接调 trashFile');
      ok(!/vault\.delete\s*\(/.test(boardSrc), '看板里不许直接调 vault.delete');
      ok(!/vault\.create\s*\(/.test(boardSrc), '看板里不许直接调 vault.create（新建笔记要走 completion/new-note）');
    });

    await suite.it('看板不许自建菜单：弹菜单只能过 `ui/menu.ts`', () => {
      ok(!/kbw-menu/.test(boardSrc), '看板里不许出现菜单节点类名（那是 ui/menu.ts 的活儿）');
      ok(/showContextMenu\(/.test(boardSrc), '看板要弹菜单就调 showContextMenu');
    });

    await suite.it('跨板块改属性/标签：写之前必须拍快照（撤销条 = 快照还原）', () => {
      ok(/snapshot\.capture\(/.test(boardSrc), 'drag.ts 那条路要先 snapshot.capture 再写');
      /**
       * ⚠️ **P7.19 收口后形态变了**：`drag.ts` 的 `onUndo` 从
       * `() => void ctx.snapshot.restore(id)`（fire-and-forget —— reject 被 `void` 吞成
       * unhandled rejection）收成 `() => void restoreOrNotify(ctx.snapshot, id)`。
       * **内部仍然是 `snapshot.restore`**，只是多了一层兜底（失败 → warn + 轻提示）。
       * 红线要钉的那件事没变：**撤销走快照还原，不是逆运算**。
       */
      ok(
        /restoreOrNotify\(ctx\.snapshot/.test(boardSrc),
        '撤销走 restoreOrNotify（P7.19 收口；内部仍是 snapshot.restore，不是逆运算）',
      );
    });

    /**
     * 探针脚本必须**能被求值**。
     * 为什么单列：`script: \`...\`` 是模板字符串，注释里混进一个反引号会把它提前结束，
     * 后面的中文注释就变成真代码 —— `node --check` 只查语法、**查不出这种**
     * （它看起来是合法的成员访问），真机上表现为 `ReferenceError: xxx is not defined`。
     * 这条从 P4 起钉住（那半天里踩了四次）。
     */
    await suite.it('探针脚本能被求值（`String.raw` / 步骤模板里混进反引号会被这条抓住）', () => {
      const probe = path.join(root, 'scripts', 'probe.mjs');
      /**
       * ⚠️ **每条步骤的 `script` 也要逐个编译一遍**（2026-09-25 P4.5 补）。
       * 只 `import()` 这个文件查不出"模板字符串里被截断/混进反引号"——
       * 那种错在**外层**看是完全合法的字符串，`node --check` 全绿，
       * 直到真机 `cdp.eval` 才报 `SyntaxError: Unexpected token 'const'`
       *（P4.5 实测：一条步骤里 `probe[0];` 的 `];` 被脚本当成数组结尾，后半句被吃掉）。
       * `new Function(code)` 只编译不执行 —— 正好是"语法合法性"这一条的判据。
       */
      const check = `
        const m = await import(${JSON.stringify(pathToFileURL(probe).href)});
        /**
         * ⚠️ **这条断言自己也要有下限判据**（独立审查抓到）：\`m.STEPS ?? []\` 一旦因为
         * "改名/不再导出"变成空数组，循环 0 次、\`bad\` 为空、子进程退出 0 —— **整条断言空跑**，
         * 而它的全部价值就是拦住被静默截断的步骤脚本。
         * 所以先卡"步骤数"与"真的编译过的条数"，再报编译失败。
         */
        const steps = m.STEPS;
        if (!Array.isArray(steps) || steps.length < 20) {
          console.error('FLOOR:STEPS=' + (Array.isArray(steps) ? steps.length : String(steps)));
          process.exit(4);
        }
        const bad = [];
        let compiled = 0;
        for (const s of steps) {
          if (!s.script) continue;
          compiled += 1;
          try { new Function(s.script); } catch (e) { bad.push(s.name + ' → ' + e.message); }
        }
        if (compiled < 30) { console.error('FLOOR:compiled=' + compiled); process.exit(5); }
        if (bad.length > 0) { console.error('BAD:' + bad.join(' ||| ')); process.exit(3); }
      `;
      try {
        execFileSync(process.execPath, ['--input-type=module', '-e', check], {
          env: { ...process.env, KBW_PROBE_NO_RUN: '1' },
          stdio: 'pipe',
          timeout: 20000,
        });
      } catch (e) {
        const err = e as { stderr?: Buffer; message?: string; status?: number };
        const raw = err.stderr?.toString() ?? err.message ?? '';
        const msg = raw.split('\n').slice(0, 6).join(' ');
        throw new Error(
          `probe.mjs 求值失败（注释里混了反引号，或某条步骤的 script 被截断）：${msg}`,
        );
      }
    });

    /**
     * 🔴 `probe.mjs` 的步骤脚本是**模板字符串**：里面混进一个**未转义的反引号**就会**提前结束模板**。
     * 症状两种：① 多数情况下整个文件语法错（`node --check` 能抓，但**一次只报一条**）；
     * ② 若截断之后**恰好还是合法 JS**，那谁也抓不到 —— 步骤脚本被悄悄吃掉半截，
     *    真机上表现为 `ReferenceError: xxx is not defined`（`node --check` 全绿）。
     *
     * 这条判据直接查**文本**，一次把所有位置列出来（本项目 P4 那半天里栽过四次、本轮又栽过六次，
     * 几乎全是在步骤注释里写 `xxx` 这种"代码样式"的引用）。**写注释用「」**。
     */
    /**
     * 🔴 **"读盘时必须迁移"这种约定只能静态钉**（P6② 独立审查 B 路 🔴2.5 的建议）：
     * `migrateLegacyView` 那个纯函数有判据，但"**读盘那一个入口到底调没调它**"没有 ——
     * 把 `BoardConfigStore.apply` 里那次调用删掉，全仓库照样全绿，而后果是
     * **老用户的 v1 配置永远停在旧默认**（用户提的"小窗默认只显示正文"对他们不生效）。
     * 判据形态照 P0 那条纪律：把源码读出来，钉"这一行必须存在"。
     */
    await suite.it('看板配置的读盘入口必须调用 `migrateLegacyView`（否则存量 v1 永远迁不动）', () => {
      const src = fs.readFileSync(path.join(root, 'src', 'modules', 'board', 'config.ts'), 'utf8');
      ok(
        /this\.data\s*=\s*normalizeBoard\(migrateLegacyView\(raw\)\)/.test(src),
        '读了盘就要迁移（`this.data = normalizeBoard(migrateLegacyView(raw))`）',
      );
      // 反向：迁移**不许**出现在写入口（写的是用户刚选的值，在那儿迁移 = 选了等于没选）
      ok(
        !/normalizeBoard\(migrateLegacyView\(/.test(
          src.slice(src.indexOf('async save('), src.indexOf('async patchView(')),
        ),
        '写入口（`save()`）不许调迁移 —— 那会把用户刚选的档当场改回去',
      );
    });

    await suite.it('探针步骤模板里不许混进反引号（会提前结束模板 —— 注释里也不行）', () => {
      const lines = fs.readFileSync(path.join(root, 'scripts', 'probe.mjs'), 'utf8').split('\n');
      let inStep = false;
      let steps = 0;
      const bad: string[] = [];
      lines.forEach((line, i) => {
        if (/^\s*script: `/.test(line)) {
          inStep = true;
          steps += 1;
          return;
        }
        if (!inStep) return;
        // 收尾那一行（反引号 + 可能的逗号/右括号）
        if (/`\s*[,)]*\s*$/.test(line)) {
          inStep = false;
          return;
        }
        /**
         * 只报**未转义**的（`\`` 是合法的转义写法，别假红）。
         * ⚠️ 这条正则写成 `(^|[^\\])\``：`[^\\]` 里那个反斜杠要**双写**才表示"非反斜杠字符"。
         */
        if (/(^|[^\\])`/.test(line)) bad.push(`第 ${i + 1} 行：${line.trim().slice(0, 60)}`);
      });
      // 下限判据：扫到的步骤数不能是 0（否则这条断言只是空跑）
      ok(steps >= 40, `扫到的步骤脚本数要 ≥ 40（实际 ${steps}）—— 0 就说明这条判据空跑了`);
      ok(!inStep, '模板没有"扫到结尾还没收"的（多半是收尾那行的写法变了）');
      eq(bad.length, 0, `步骤模板里混进了反引号（改用「」）：\n    ${bad.join('\n    ')}`);
    });

    await suite.it('卡片里的任务勾选框不许被负边距顶出去（a.5-4 的另一半，CSS 源级）', () => {
      /**
       * 真机实测（2026-09-25）：平台的 `.task-list-item-checkbox` 自带
       * `margin-inline-start: -24px`，而卡片正文的 ul 只有 1.2em ≈ 15px 缩进
       * → 框左 348 / 正文左 357，被 `overflow: hidden` **切掉半个**（用户截图："左边没显示全"）。
       * 这条钉的是"清零那一行还在"——删了就红，不用等真机截图。
       */
      const css = stripComments(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'));
      ok(
        /\.kbw-card-body li\.task-list-item > input\[type="checkbox"\]\s*\{[^}]*margin-inline-start:\s*0/.test(css),
        'styles.css 里要有「卡片内任务框 margin-inline-start: 0」这条（否则勾选框会被切掉半个）',
      );
      ok(
        /\.kbw-card-body:not\(\.is-open\) li\.kbw-li-over\s*\{\s*display:\s*none/.test(css),
        '「按条数截」的隐藏规则要在（.kbw-li-over）',
      );
      // 长标题：不截断、横向可滚（用户 2026-09-25 反馈"长标题能不能左右滚动看全"）
      ok(
        /\.kbw-card-t\s*\{[^}]*overflow-x:\s*auto/.test(css) &&
          /\.kbw-card-t\s*\{[^}]*white-space:\s*nowrap/.test(css),
        '卡片标题要横向可滚（overflow-x:auto + nowrap），别截成省略号',
      );
    });

    /**
     * 卡片正文的**摘要裁切不许退回 `display:-webkit-box`**（用户 2026-09-25 截图："卡片里文字叠在一起"）。
     *
     * 根因：`-webkit-box` 是 **legacy flexbox** —— 正文里的块级子元素都是它的 flex 项，
     * 容器高度一被 `-webkit-line-clamp` 限住就被**压扁**（不是裁切）。
     * 真机实测：每张卡片 3 处（`P:18<290`、`BLOCKQUOTE:54<91`、`OL:18<91`），
     * 用 Range 量文本矩形是**每卡 2–9 处真实重叠**；换成 `block` + `max-height` 后同一批卡片归零。
     * jsdom 量不到布局 → 只能在源级钉住"用的是哪一种写法"（真机那条判据另见探针）。
     * ⚠️ `--lh-2` 是**无单位倍数**（1.45）→ 必须 `* 1em`；少了它整条 `calc()` 变无效值、
     * `max-height` **静默失效**（第一版实验就栽在这：看着改了，其实没生效）。
     */
    /**
     * 冷启那条「读正文中… → 读完补画」的路，判据必须是**看屏幕**、不是看 token。
     *
     * 真机撞到的死路：读正文途中插进来一次别的重绘（`paintToken` 变了），它画的时候正文还没读完
     * → 屏幕上写着「读正文中…」；等 `ensureTexts` 读完回来，补画那一步一看 token 不同就 return
     * → **再没人补画**；而 `textsRev` 早被置成当前版本（快车道）→ 之后的重绘全判成"缓存命中"
     * → 永久停在占位上（只有重载插件能救）。
     * 修法是判`bodyHost` 里还有没有 `.kbw-card-empty.is-loading`。这两半都要在源码里钉住。
     */
    await suite.it('冷启补画的判据要看屏幕（「读正文中…」不许永久卡住）', () => {
      const src = stripComments(fs.readFileSync(path.join(root, 'src/modules/board/index.ts'), 'utf8'));
      ok(
        /querySelector\(['"]\.kbw-card-empty\.is-loading['"]\)/.test(src),
        '补画前要真的去 bodyHost 里查 `.kbw-card-empty.is-loading` —— 只看 token 的话，读正文途中那次重绘会把补画顶掉',
      );
      const cards = stripComments(
        fs.readFileSync(path.join(root, 'src/modules/board/cards.ts'), 'utf8'),
      );
      ok(
        /is-loading/.test(cards),
        '「读正文中…」那个占位要带 `is-loading` 类（补画的判据靠它认人；类名改了两边就对不上）',
      );
    });

    await suite.it('卡片摘要裁切不许退回 display:-webkit-box（legacy flexbox 会把块级子元素压扁）', () => {
      const css = stripComments(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'));
      /**
       * 🔴 **从"全局禁令"收窄成"点名制"**（P7.1b · 2.6b，有意识地改契约 —— 单独写清代价）：
       * 原禁令是 P4.5 为**卡片正文摘要**立的 —— 那里有**块级子元素**，`-webkit-box` 会把它们
       * 当可收缩的 flex 项**压扁**（真机截图取证：每卡 2–9 处文字重叠）。
       * 2.6b 给 `.kbw-gname` 上 `-webkit-line-clamp` 是**另一回事**：那一格里只有纯文本
       *（无块级子元素），clamp 只裁不压（边界与理由写在 `styles/notes.css` 那段纪律注释里）。
       *
       * 所以禁令不撤、只是改形：① 摘要那条规则**照旧**不许用（下面把 `.kbw-card-body:not(.is-open)`
       * 整块取出来逐项断言的写法一个字没动，它必须仍是 block + max-height）；
       * ② **新增**：凡是用 `display:-webkit-box` 的规则必须**点名在册**（现在有 `.kbw-gname`
       * 与 `.kbw-review-a` 两条 —— 后者是 P8 回顾卡的背面摘要，同一条"那一格里只有纯文本"的理由）
       * —— 将来谁再引入一处，要来这张名单上"签字"，不能悄悄混进来。
       */
      /** ⚠️ 正则**容忍空格与大小写**（独立审查 🟢1：`display : -webkit-box` / 大写变体会绕过严格式） */
      const offenders = cssRules(css).filter((r) => /display\s*:\s*-webkit-box/i.test(r.body));
      const allowed = new Set(['.kbw-gname', '.kbw-review-a']);
      ok(
        offenders.every((r) => allowed.has(r.sel)),
        'display:-webkit-box 只许出现在点名在册的规则里（.kbw-gname / .kbw-review-a）—— 实际：' +
          (offenders.map((r) => r.sel).join(' / ') || '(没有)'),
      );
      /**
       * ⚠️ 先把那条规则**整块取出来**再逐项断言 —— 且**必须锚在行首**。两处都栽过：
       * ① 写成一个长正则时 `calc(var(--lh-2) * …)` 的嵌套括号会让 `[^)]*` 在第一个 `)` 上断掉；
       * ② 不锚行首的话，`.kbw-cards.has-h .kbw-card-body:not(.is-open) {`（豁免档，里面只有
       *    `max-height: none`）**排在前面**、子串照样匹配 → 取到的是那一条 → 假红。
       * 规则本身在 CSS 里一律顶格写，所以 `^\\.kbw-card-body…` + `m` 就够精确。
       */
      const rule = /^\.kbw-card-body:not\(\.is-open\)\s*\{([^}]*)\}/m.exec(css);
      const decl = rule?.[1] ?? '';
      ok(!!rule, 'styles.css 里要能找到 `.kbw-card-body:not(.is-open)` 这条摘要规则');
      ok(
        /max-height:\s*calc\(/.test(decl) && /--lh-2/.test(decl) && /\*\s*1em/.test(decl),
        '摘要要按「行数 × 行高」裁切：max-height: calc(var(--lh-2) * var(--kbw-summary-lines,3) * 1em)（--lh-2 是无单位倍数，少了 * 1em 整条 calc 就无效、max-height 静默失效）',
      );
      ok(
        /display:\s*block/.test(decl),
        '摘要态的 display 要显式写 block（不然回落成别的盒类型、裁切口径会变）',
      );
    });

    /**
     * c 期（§3.5 多选与批量）的两条"必须一直成立"的约定。
     * 都属"同一件事只许有一份实现"那一类 —— 静态可查，不用等真机。
     */
    await suite.it('c 期：批量栏只有一份实现（两屏都得走 notes/batch-bar）', () => {
      const bar = stripComments(
        fs.readFileSync(path.join(root, 'src/modules/notes/batch-bar.ts'), 'utf8'),
      );
      ok(/export function batchBar\(/.test(bar), '共享件 `batchBar(` 得在');
      for (const f of ['src/modules/notes/index.ts', 'src/modules/board/index.ts']) {
        const src = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
        ok(/batchBar\(/.test(src), `${f} 要调共享的 batchBar(（§3.5 的原话是"复用 P1 那一份"）`);
        ok(
          !/kbw-batch-count/.test(src),
          `${f} 里出现了 kbw-batch-count —— 那是又手拼了一条批量栏（两屏会漂）`,
        );
      }
    });

    await suite.it('c 期：选择语义只有一份实现（两屏都得走 board/select）', () => {
      const sel = stripComments(
        fs.readFileSync(path.join(root, 'src/modules/board/select.ts'), 'utf8'),
      );
      ok(/export function toggleSelected\(/.test(sel), '共享件 `toggleSelected(` 在');
      ok(/export function rangeSelected\(/.test(sel), '共享件 `rangeSelected(` 在');
      for (const f of ['src/modules/notes/index.ts', 'src/modules/board/index.ts']) {
        const src = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
        ok(/rangeSelected\(/.test(src), `${f} 要调共享的 rangeSelected(（两屏语义不许各写一份）`);
        ok(/toggleSelected\(/.test(src), `${f} 要调共享的 toggleSelected(（同上）`);
      }
    });

    await suite.it('c 期：框选起手帧先归零到触点（S4 实测过的残影）', () => {
      const src = stripComments(
        fs.readFileSync(path.join(root, 'src/modules/board/index.ts'), 'utf8'),
      );
      /**
       * ⚠️ 断的是**顺序**不只是"有没有"：归零那一句必须排在 `startPointerDrag` **之前** ——
       * 第一帧就要摆成零尺寸，等第一次 `pointermove` 才摆的话，按下那一瞬间会闪出上一次的框。
       */
      const iPlace = src.indexOf('place(start.x, start.y)');
      const iStart = src.indexOf('startPointerDrag(down, 0, {');
      ok(iPlace > 0, '`startMarquee` 里要有"先 place 到起点"那一句');
      ok(iStart > 0, '框选要走 `startPointerDrag` 那个基元（阈值 / pointercancel / Esc 都在它那儿）');
      ok(iPlace < iStart, '归零那一句必须在起拖之前（顺序反了就等于没做）');
      ok(/normRect\(/.test(src), '选框尺寸一律过 `normRect(`（反着拖也要归一化）');
    });

    await suite.it('d 期：tab 列表运算只有一份实现（去重 / 落点 / 改名重映射都得走 board/tabs）', () => {
      const tabs = stripComments(
        fs.readFileSync(path.join(root, 'src/modules/board/tabs.ts'), 'utf8'),
      );
      /**
       * ⚠️ 这三个是**泛型函数**，名字与 `(` 之间隔着 `<T extends HasPath>` ——
       * 写成 `insertTab\(` 会**一条都匹配不到**（第一版就是这么红的：断言看着在、
       * 其实查的是一个永远不存在的形态）。所以用 `[<(]` 兼容两种写法。
       */
      ok(/export function insertTab[<(]/.test(tabs), '共享件 `insertTab(` 得在（去重那一条的唯一定义处）');
      ok(/export function nextActiveAfterClose[<(]/.test(tabs), '共享件 `nextActiveAfterClose(` 得在');
      ok(/export function remapPaths[<(]/.test(tabs), '共享件 `remapPaths(` 得在');
      const src = stripComments(fs.readFileSync(path.join(root, 'src/modules/board/editor.ts'), 'utf8'));
      /**
       * 判"有没有调用"要用**带括号**的形态（注释里写不出这个形态）——
       * 项目里栽过"既假绿又假红"的红线断言，就是判得太松被注释骗过。
       */
      ok(/insertTab\(/.test(src), 'editor.ts 打开一篇必须过 `insertTab(`（同一 path 只许一个叶）');
      ok(/nextActiveAfterClose\(/.test(src), 'editor.ts 关一篇的落点必须过 `nextActiveAfterClose(`');
      ok(/remapPaths\(/.test(src), 'editor.ts 改名重映射必须过 `remapPaths(`');
      ok(
        !/tabs\.push\(/.test(src),
        'editor.ts 里出现了裸 `tabs.push(` —— 那是绕过去重的写法（同一篇会开出第二个编辑器）',
      );
    });

    await suite.it('d 期：面板"先关再拆"（purgeOverlays 不许只 el.remove，那会留悬挂叶）', () => {
      const panel = stripComments(fs.readFileSync(path.join(root, 'src/ui/panel.ts'), 'utf8'));
      ok(/const liveFloaters = new Set/.test(panel), '浮层的"还开着"登记表在');
      ok(/liveFloaters\.add\(close\)/.test(panel), 'openFloating 要把自己的 close 登记进去');
      /**
       * ⚠️ 断的是**顺序**：必须先让每个浮层走完关闭流程（面板那边会 save + detach 真编辑器叶），
       * 再 `el.remove()` 拆 DOM。反过来的话 `close()` 第一句
       * `if (!root.isConnected) return;` 会提前 return，`onClose` 整段不执行 →
       * **叶永远没人 detach**（这就是 P4/a.5 反复记过的那个悬挂叶，直到 d 期才查清机制）。
       */
      const iPurge = panel.indexOf('export function purgeOverlays');
      const iClose = panel.indexOf("close('purge')");
      const iRemove = panel.indexOf("'.kbw-modal'", iPurge);
      ok(iPurge > 0, 'purgeOverlays 在');
      ok(iClose > iPurge, 'purgeOverlays 里要有"先让浮层关闭"那一句');
      ok(iRemove > iClose, '那一句必须排在拆 DOM **之前**（顺序反了等于没做）');
    });

    await suite.it('d 期：切 tab 催重排只许走 `Editor.refresh()`，不许派全局 resize', () => {
      const src = stripComments(
        fs.readFileSync(path.join(root, 'src/modules/board/editor.ts'), 'utf8'),
      );
      /**
       * 🔴 面板自己挂着一句"窗口尺寸变了 → 关窗"（P4 起的行为）。切 tab 时若派一发
       * `window` 的 resize 去催 CodeMirror 重排，**会把自己关掉** ——
       * 症状是"点第二下卡片面板就没了"（离线用例当场抓到）。
       * `Editor.refresh()` 是公开 API，语义就是"重算布局"，没有旁观副作用。
       */
      ok(/\.refresh\?\.\(\)/.test(src), '切 tab 后要调 `Editor.refresh()` 催重排');
      ok(
        !/dispatchEvent\(\s*new Event\(\s*['"]resize['"]/.test(src),
        '不许派全局 resize（会触发面板自己的关窗监听 → 点第二下就没了）',
      );
    });

    await suite.it('d 期：改名跟的是 `vault.on(\'rename\')` 事件，不是改名按钮', () => {
      const src = stripComments(
        fs.readFileSync(path.join(root, 'src/modules/board/editor.ts'), 'utf8'),
      );
      ok(/vault\.on\('rename'/.test(src), "要挂 `vault.on('rename')`（改名有四个入口，挂按钮必漏）");
      ok(/vault\.on\('delete'/.test(src), "也要挂 `vault.on('delete')`（文件被删了那一页得收掉）");
      /**
       * ⚠️ 事件回调必须**把参数收下**（`file` 与 `oldPath`）。
       * 只手握 `TFile` 去读 `file.path` 是不够的 —— 那个对象可能是某次 `rescan()`
       * 之前的旧对象，永远不会被就地改到。离线用例实测抓到过：
       * 文件已经在新路径了，页上的路径纹丝不动。
       */
      ok(/oldPath/.test(src), '改名回调要接 `oldPath` 入参（不接 = 手里那个对象作废时永远追不上）');
    });

    await suite.it('d 期：点卡片不算"点外面"（不然 mousedown 会先把面板关掉，多篇攒不起来）', () => {
      const src = stripComments(
        fs.readFileSync(path.join(root, 'src/modules/board/editor.ts'), 'utf8'),
      );
      /**
       * 🔴 这条是**真机探针抓到的离线假绿**：面板"点外面就关"听的是 mousedown，
       * 而"点卡片 = 再开一篇"这一下**也**发 mousedown → 面板先关、click 再开一扇新的，
       * 上一篇就没了（真机实测：连点三张只攒出 1 页）。
       * 离线的 `H.click` 只派 click、不派 mousedown，所以那一套当时全绿。
       */
      ok(
        /ignoreOutsideClick:/.test(src),
        '面板要声明"点卡片不算外面"（`ignoreOutsideClick:`）—— 摘掉它多篇分页就攒不起来',
      );
      const panel = stripComments(fs.readFileSync(path.join(root, 'src/ui/panel.ts'), 'utf8'));
      ok(/opts\.ignoreOutsideClick\?\.\(t\)/.test(panel), 'ui/panel.ts 那边要真的用上这个豁免');
      /**
       * 也钉住"离线用例走真鼠标序列"这件事：只派 click 的写法会**看不见**上面那类 bug。
       * 判 `realClick(` 出现在用例源码里（带括号的形态，注释骗不过）。
       */
      const spec = stripComments(fs.readFileSync(path.join(root, 'tests/specs/board.ts'), 'utf8'));
      ok(/realClick\(/.test(spec), 'd 期点卡片要用 `H.realClick(`（真鼠标序列），别用只派 click 的那个');
      const helpers = fs.readFileSync(path.join(root, 'tests/helpers.ts'), 'utf8');
      ok(/export function realClick\(/.test(helpers), '`H.realClick` 得在 helpers 里');
    });

    // ── d2 期：停靠（§3.1 的 dock）──────────────────────────────
    await suite.it('d2 期：模块侧不许反过来 import 视图（那是循环 import）', () => {
      /**
       * 🔴 停靠要两头配合：**外壳**建窗格宿主、**面板**搬进去。安全的形状是
       * "外壳建好、通过 `ctx.dock` 交出去"（`view → modules` 单向，与本文件上面那条
       * `view → modules/board/editor` 同一个方向）。一旦 board 侧自己去 import
       * `view/workbench-view`，就成环了 —— 而循环 import 在打包后往往**只表现为
       * 某个模块在某次加载时是 undefined**，报错点离根因十万八千里。
       * 所以拿源码扫一遍（比"作者自觉"可靠）。
       */
      const bad: string[] = [];
      for (const f of tsFilesUnder(path.join(root, 'src/modules'))) {
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        if (/from\s+['"][^'"]*\bview\//.test(src)) bad.push(path.relative(root, f));
      }
      eq(bad.join('、'), '', '模块侧只能通过 ctx/服务拿口子，不许 import view/（方向是 view → modules）');
      // 反向也要有人用：外壳这边确实 import 了（不然上面那条恒真）
      const view = stripComments(fs.readFileSync(path.join(root, 'src/view/workbench-view.ts'), 'utf8'));
      ok(/from '\.\.\/modules\//.test(view), '外壳照旧走 view → modules（收面板那条）');
    });

    await suite.it('d2 期：停靠的尺寸/断点算术只有一份实现（都得走 ui/dock）', () => {
      const dock = stripComments(fs.readFileSync(path.join(root, 'src/ui/dock.ts'), 'utf8'));
      ok(/export function dockFit\(/.test(dock), '`dockFit(` 得在（"放不放得下 / 实际多宽"的唯一定义处）');
      ok(/export function dockReserve\(/.test(dock), '`dockReserve(` 得在（断点扣减的唯一定义处）');
      ok(/export function normalizeDock\(/.test(dock), '`normalizeDock(` 得在（配置解析的唯一定义处）');
      const view = stripComments(fs.readFileSync(path.join(root, 'src/view/workbench-view.ts'), 'utf8'));
      ok(/dockFit\(/.test(view), '外壳判"放不放得下"必须过 `dockFit(`');
      ok(/dockReserve\(/.test(view), '外壳扣 `data-w` 断点必须过 `dockReserve(`');
      /**
       * ⚠️ 外壳**不许自己再写一份**"主区至少多少"的阈值：判据里的 640 与
       * `NARROW_MAX` 同值不同义，两处各写一份的下一步就是有人把它们合并
       * —— 而合并掉那个（把窄档阈值当停靠下限）会让"该退化成窄档的没退化"复发。
       */
      for (const f of [
        'src/view/workbench-view.ts',
        'src/modules/board/editor.ts',
        'src/modules/board/config.ts',
        'src/modules/board/menus.ts',
      ]) {
        ok(
          !/DOCK_MIN_MAIN_W/.test(stripComments(fs.readFileSync(path.join(root, f), 'utf8'))),
          `${f} 不该再写一份"主区下限"阈值（只在 ui/dock.ts 里有一处）`,
        );
      }
    });

    await suite.it('d2 期：停靠搬家搬的是**同一个节点**，不许重建（重建 = 丢光标）', () => {
      const src = stripComments(fs.readFileSync(path.join(root, 'src/modules/board/editor.ts'), 'utf8'));
      const i = src.indexOf('function attachDock(');
      ok(i > 0, '`attachDock(` 在');
      const body = src.slice(i, src.indexOf('\n}', i));
      ok(/setDocked\(/.test(body), '搬家必须走 `setDocked(`（浮层那套行为的分流点就在它里面）');
      ok(
        !/createTab\(|mountEditor\(|new WorkspaceLeaf/.test(body),
        '搬家**不许重建** tab / 重挂编辑器（面板里挂的是真 MarkdownView，重建会丢光标、丢最后几秒输入）',
      );
      const panel = stripComments(fs.readFileSync(path.join(root, 'src/ui/panel.ts'), 'utf8'));
      ok(/host\.appendChild\(root\)/.test(panel), '`setDocked` 里要真的 `appendChild(root)`（搬同一个节点）');
    });

    await suite.it('d2 期：停靠态那几套浮层行为整体失效（点外面 / resize / 头部拖动 / Esc）', () => {
      const panel = stripComments(fs.readFileSync(path.join(root, 'src/ui/panel.ts'), 'utf8'));
      /**
       * 判据按 `docked` **每次事件现读**（与 `pinned` 同一套做法）—— 摘/挂两套监听
       * 迟早会漂。至少三处：ResizeObserver 重摆、点外面就关、resize 就关、头部拖动。
       */
      const n = (panel.match(/if \(docked\) return;/g) ?? []).length;
      ok(n >= 3, `至少三处"停靠态短路"（点外面 / resize / 头部拖动 / 内容长高重摆），实际 ${n} 处`);
      /**
       * 🔴 Esc 那一层必须是**压/弹一对**，不是"停靠时返回 false"：
       * `dispatchEscape()` 的规矩是"层回调返回 false 就把这层**弹掉**"，
       * 图省事那么写的话，取消停靠之后 Esc **再也关不掉它**（很难查的半个状态）。
       */
      ok(/const pullEsc = /.test(panel), '要有 `pullEsc`（停靠时把它弹出栈）');
      ok(/const pushEsc = /.test(panel), '要有 `pushEsc`（取消停靠时压回来）');
      ok(
        /if \(next\) \{[\s\S]{0,600}?pullEsc\(\);/.test(panel),
        '`setDocked(host)` 那条路上要调 `pullEsc()`（停靠 ⇒ Esc 不关）',
      );
    });

    await suite.it('d2 期：模块重建时要把依赖**重新交给面板**（否则配置写入口对它失聪）', () => {
      /**
       * 🔴 这条钉的是一个**真缺陷**（写这段代码时自己走出来的）：面板跨模块存活，
       * 但它订阅的是**那一个** `BoardConfigStore` 实例。切走再切回来，模块是新的、
       * 带一个新 store，旧 store 的 file watcher 随旧模块一起收了 → 从此不再 `emit`
       * → "换停靠边 / 钉住 / 切档"这些**写配置**的入口对它全都失聪（离线先红后修）。
       * 判据：`真链路 · 切走模块再回来，面板仍然跟着配置走`。
       */
      const idx = stripComments(fs.readFileSync(path.join(root, 'src/modules/board/index.ts'), 'utf8'));
      ok(/rebindCardPanel\(/.test(idx), '看板模块挂载/读完配置时要调 `rebindCardPanel(`');
      ok(
        /panelDeps\(\)/.test(idx),
        '依赖束走 `panelDeps()`（`mount` 与"点卡片开一篇"两处各拼一份迟早会漂）',
      );
      const ed = stripComments(fs.readFileSync(path.join(root, 'src/modules/board/editor.ts'), 'utf8'));
      ok(/export function rebindCardPanel\(/.test(ed), '`rebindCardPanel` 得导出');
      /**
       * ⚠️ **配置还没读出来时不许按它重排**：`load()` 是异步的，而且读完**不 emit** ——
       * 那时候 `cfg.get()` 还是默认值（`dock: null`），照着它 `syncDock` 会把刚停靠好的
       * 窗格当场卸掉，此后没人再纠正（离线实测：切模块回来窗格就没了）。
       */
      ok(/isLoaded\(\)/.test(ed), '要先问 `isLoaded()`：没读出来就只接线、不重排');
    });

    await suite.it('d2 期：关闭流程不许用 `isConnected` 判"关过没有"（停靠态下它恒为假）', () => {
      /**
       * 🔴 d2 独立审查抓的真缺陷：平台在 `View.close()` 里是**先 `containerEl.detach()`、
       * 再 `await this.onClose()`**（asar 取证写在桩的 `WorkspaceLeaf.detach` 上）。
       * 停靠态下面板 root 住在工作台外壳的 `.kbw-dock` 里 = `contentEl` 的后代 ⇒
       * 视图 `onClose()` 跑的那一刻它**已经在文档之外** —— 用 `isConnected` 当"关过没有"
       * 就会把整段关闭流程（save + detach 每个叶、dispose、component.unload）全部跳过。
       */
      const panel = stripComments(fs.readFileSync(path.join(root, 'src/ui/panel.ts'), 'utf8'));
      ok(/let didClose = false;/.test(panel), '浮层的 `close()` 要用显式的 `didClose` 标志');
      ok(/if \(didClose\) return;/.test(panel), '判"关过没有"要看 `didClose`');
      /**
       * ⚠️ 锚点要选准：这个文件里**有两个 `close`**（模态与浮层），
       * `indexOf('const close = (reason')` 命中的是**模态**那个 ——
       * 第一版就是这么假红的（模态那边用的是 `!backdrop.isConnected`，本来就不该管）。
       * 这里直接判"整份文件里不许出现 `!root.isConnected`"：那是浮层独有的写法。
       */
      ok(
        !/!root\.isConnected/.test(panel),
        '浮层**不许**退回 `if (!root.isConnected) return;` —— 停靠态下它会把整段关闭流程短路掉',
      );
      /**
       * ⚠️ 桩也必须保持"先摘 DOM 再 onClose"（与平台一致）：桩若写宽松了，
       * 这条 🔴 会**离线恒绿**（本项目栽过很多次的那个形状）。
       */
      const stub = stripComments(fs.readFileSync(path.join(root, 'tests/stub/index.ts'), 'utf8'));
      const k = stub.indexOf('  detach(): void {');
      ok(k > 0, '桩的 `detach()` 在');
      const body = stub.slice(k, k + 700);
      const iRemove = body.indexOf('containerEl.remove()');
      const iClose = body.indexOf('onClose()');
      ok(iRemove > 0 && iClose > 0, '桩的 detach 里两个动作都在');
      ok(
        iRemove < iClose,
        '桩必须先摘 DOM 再 `onClose()`（与平台一致）；反了的话那条 🔴 离线永远绿',
      );
    });

    await suite.it('d2 期：视图侧三条守卫（量不到就别下结论 · 没面板就别申请窗格 · 口子认人）', () => {
      const view = stripComments(fs.readFileSync(path.join(root, 'src/view/workbench-view.ts'), 'utf8'));
      /**
       * ① `clientWidth/Height` 为 0 有两种情况：没布局 / **这一页被藏起来了**。
       *    后者按"不生效"处理会把停靠态的面板踢出窗格、飘到 body 上。
       */
      ok(/const measurable = w > 0 && h > 0;/.test(view), '要先判"量到了没有"');
      ok(/if \(measurable\) this\.paintDock\(fit\);/.test(view), '量不到就**别翻停靠状态**');
      /**
       * ② 指针监听挂在 `document` 上 → "拖到一半面板被关掉"之后 move 照样收得到，
       *    会把窗格显示回一条**空走廊**。
       */
      ok(/if \(!this\.dockApplied\) return;/.test(view), '面板没了就别再申请窗格（拖分隔条那条路）');
      /**
       * ③ `ctx.dock` 是"后开的视图胜"（分屏两个工作台标签）——
       *    视图收尾必须**只撤自己的、把口子交还给还活着的那个**。
       */
      ok(/const livePorts: DockPort\[\] = \[\];/.test(view), '要有"还活着的口子"那张表');
      ok(
        /if \(this\.ctx\.dock === mine\) this\.ctx\.dock = livePorts\[/.test(view),
        'onClose 要**交还**口子，不是无条件清成 undefined（那样关掉任一标签都会让停靠永久失效）',
      );
      /**
       * ④ 面板那一头：**认一次口子、用到底**（从 `ctx.dock` 现取会申请到别人的窗格上）。
       */
      const ed = stripComments(fs.readFileSync(path.join(root, 'src/modules/board/editor.ts'), 'utf8'));
      ok(/const port = p\.dockPort;/.test(ed), '面板要用**建面板时认下的那一个**口子');
      ok(!/const port = p\.deps\.ctx\.dock;/.test(ed), '不许从 `ctx.dock` 现取（多标签会打错窗格）');
    });

    await suite.it('d2 期：拖动的「Esc 中止」必须挂**捕获**阶段（冒泡永远收不到）', () => {
      /**
       * 🟢 d2 审查记账的一条（**既有**问题，不是这一期引入的）：
       * `installGlobalEscape`（`core/keymap.ts`）是 document 上的**捕获**监听，
       * 一旦接住就 `stopPropagation()` —— 而 `ui/dnd.ts` 的 Esc 中止原先挂**冒泡**，
       * 于是"拖到一半按 Esc"**在真实环境里从来没生效过**（栈上恒有看板那层清临时态）。
       * 同一节点上的捕获监听不会被 `stopPropagation()` 挡住，所以挂捕获就收得到。
       */
      const dnd = stripComments(fs.readFileSync(path.join(root, 'src/ui/dnd.ts'), 'utf8'));
      const i = dnd.indexOf("'keydown'");
      ok(i > 0, 'dnd 里那个 keydown 监听在');
      ok(
        /capture: true/.test(dnd.slice(i, i + 700)),
        "Esc 中止要挂 `{ capture: true }`（挂冒泡会被 `installGlobalEscape` 的 stopPropagation 截掉）",
      );
      // 反向：keymap 那条确实是捕获（上面这条的理由就在这儿，别哪天被改成冒泡还不知道）
      const km = stripComments(fs.readFileSync(path.join(root, 'src/core/keymap.ts'), 'utf8'));
      ok(
        /addEventListener\('keydown', handler, true\)/.test(km),
        '`installGlobalEscape` 是捕获监听（这条决定了 dnd 也必须捕获）',
      );
    });

    await suite.it('d2 期：探针跑完要**按标记兜底清场**（逐步 sweep 一定会漏）', () => {
      /**
       * d 期交接里那条"探针自清理漏了一条日志"，d2 查清了：`P.sweep()` 是**逐步**调的，
       * "哪一步需要 sweep"纯靠作者记得 —— 至少 `P4.5 · 拖动落点` 那一步的 `cleanup()`
       * 只删临时文件与库内配置、**从不 sweep**，于是每跑一轮攒一条日志 + 一份快照
       *（实验库里实测积了 38 份）。修法是跑完**兜一次底**，而不是一步步补。
       *
       * ⚠️ 这里读的是**原文**不是 `stripComments` 之后的 —— 那两句话本身就在注释里。
       */
      const probe = fs.readFileSync(path.join(root, 'scripts/probe.mjs'), 'utf8');
      ok(/收尾按标记清场/.test(probe), '跑完最后要兜一次"按标记清场"');
      /**
       * ⚠️ 判"有没有连快照一起删"要**从那段代码自己的锚点起算**：
       * 第一版拿注释里那句中文当锚点，而它同时也出现在下面那行 `console.log` 里 ——
       * `indexOf` 命中的是**后面**那句，于是"往后再找 2600 字有没有 snapshot.remove("
       * 永远找不到（那条断言自己就是假红）。
       * 第二版改锚在 `ctx.report.recent(400)` 上 —— **P5 期又被撞了一次**：
       * 那一步（重排）也要"跑前跑后对一遍日志"，也写了 `recent(400)`，
       * 而它在文件里**排在兜底清场之前** → `indexOf` 命中前面那个 → 断言假红。
       * 教训：**锚点必须在整个文件里唯一**，不是"在某个小范围内唯一"。
       * 现在锚 `const swept = await cdp.eval(`（兜底清场那一句，唯一）。
       */
      const anchor = probe.indexOf('const swept = await cdp.eval(');
      ok(anchor > 0, '兜底清场要遍历日志（`const swept = await cdp.eval(`）');
      ok(
        /snapshot\.remove\(/.test(probe.slice(anchor, anchor + 1600)),
        '清日志时要**连它点名的那份快照一起删**（只删日志的话实验库里会攒快照，实测 38 份）',
      );
      const sweep = probe.indexOf('收尾按标记清场');
      const results = probe.indexOf('未通过的');
      ok(
        sweep > 0 && results > sweep,
        '兜底清场要排在**所有步骤跑完**之后（排在前面等于没兜）',
      );
    });

    /**
     * P4.5 第二波用户反馈三条（2026-09-25 晚）。
     * 三条都只动 CSS / 图标，**jsdom 量不到布局** —— 所以在源级钉住"该在的那行还在"，
     * 真机那边另有一条探针断言（回执的框必须在工具条的框里）。
     */
    await suite.it('第二波三条：标题滚动条藏起来 · 回执待在工具条之内 · 工具条齿轮是 SVG 不是 emoji', () => {
      const css = stripComments(fs.readFileSync(path.join(root, 'styles.css'), 'utf8'));
      /**
       * ① 标题那条横向滚动条**藏起来**（滚动能力留着）。
       * 根因：`scrollbar-width: thin` 的 4px 条在窄卡上几乎**一直显示**，
       * 正好压在标题那一行上 —— 浅色主题下就是用户截图里那条灰条。
       */
      ok(
        /\.kbw-card-t\s*\{[^}]*scrollbar-width:\s*none/.test(css),
        '卡片标题要 `scrollbar-width: none`（那 4px 的条会一直显示、压在标题上 → 灰条）',
      );
      ok(
        /\.kbw-card-t::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(css),
        'webkit 那一半也要藏（`.kbw-card-t::-webkit-scrollbar { display: none }`）',
      );
      ok(
        /\.kbw-card-t\s*\{[^}]*overflow-x:\s*auto/.test(css),
        '⚠️ 只是**藏条**，滚动能力必须还在（别顺手把 overflow-x 改回 hidden）',
      );
      /**
       * ② 回执待在**工具条之内**：窗口一矮，挂在工具条上沿之外的那半截会被裁掉。
       * 判据用"垂直居中"（`translate(-50%, -50%)`）—— 回执比工具条矮，怎么缩都在框里。
       */
      ok(
        /\.kbw-board-receipt\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/.test(css),
        '回执要在工具条里垂直居中（translate(-50%, -50%)）',
      );
      ok(
        !/\.kbw-board-receipt\s*\{[^}]*translate\(-50%,\s*-100%\)/.test(css),
        '回执不许再整体上移到工具条之外（`translate(-50%, -100%)` 就是被裁的那版）',
      );
      ok(
        /\.kbw-board-receipt\s*\{[^}]*pointer-events:\s*none/.test(css),
        '回执只是个提示，别让它盖住底下的按钮（pointer-events: none）',
      );
      /**
       * ③ 工具条那个按钮的图标必须是 **lucide 的 `settings`**（简笔 SVG）。
       * 原先写的是 emoji 字形「⚙」—— 那种字形的长相由**字体**决定，
       * 同一台机器上也会"时不时变成灰色上色的版本"（用户原话）。
       * ⚠️ 断言直接查 board 源码里有没有那个 emoji：**注释已被 stripComments 去掉**，
       * 所以这条只可能命中真代码（不会被"讲解这件事"的注释骗成假红）。
       */
      ok(!/⚙/.test(boardSrc), '看板源码里不许再出现 emoji 字形「⚙」（图标走 lucide 的 SVG）');
      ok(/icon\(\s*'settings'/.test(boardSrc), '那个按钮要用 `icon(\'settings\')`（与右上角全局设置同一个齿轮）');
      /**
       * 附：`settings-2` 那个花哨变体要**绝迹**（P4 追加里换成 `settings` 时漏了 menus.ts 一处）。
       * ⚠️ 判据带**引号**：`'settings-2'` / `"settings-2"` 才算数 ——
       * 注释里写"别用 settings-2"是允许的（判裸字符串会被注释骗过，P3 踩过）。
       */
      const walk = (dir: string, out: string[] = []): string[] => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p, out);
          else if (e.name.endsWith('.ts')) out.push(p);
        }
        return out;
      };
      const leftover = walk(path.join(root, 'src')).filter((f) =>
        /['"]settings-2['"]/.test(stripComments(fs.readFileSync(f, 'utf8'))),
      );
      eq(
        leftover.length,
        0,
        `settings-2 那个变体不许再有真实字面量（注释里提它不算）—— 还在：${leftover.join('、')}`,
      );
    });

    /**
     * 看门狗的判据必须是"**按进展**判卡住"，不是"按总时长"。
     *
     * 为什么值得单列一条红线：P4.5 那批"全量 `npm test` 偶发超时、挂点游走、分片全绿"
     * 查到最后是**一条 90 秒的总时长超时**杀掉了正常跑完的套件（全量本来就要 ~94s）——
     * 判据写错方向时，症状会伪装成"某条用例挂了"，能骗掉一整轮排查。
     * 这里把它钉死：① 有按进展的看门狗 ② 天花板足够宽 ③ 两条都别被 unref 掉。
     */
    await suite.it('离线看门狗：按进展判卡住 + 天花板足够宽（90s 那条会误杀正常跑完的全量）', () => {
      const runner = fs.readFileSync(path.join(root, 'scripts/test.mjs'), 'utf8');
      ok(/KBW_TEST_STALL/.test(runner), '要有"多久没有新结果算卡住"这个可调项（KBW_TEST_STALL）');
      /**
       * ⚠️ 这两条**必须写死形态**（独立审查 🟡5）：原先写的是宽泛的 `/results\.length/`，
       * 而同一个文件里 `bail()` 也读了一次 `suite.results.length`（打印"已通过 X / N"）——
       * 于是把 stall 那个 interval 整段删掉、只留 bail，这条判据**照样绿**
       *（典型的"看起来在测、其实测不到"）。现在钉住那句读取与那个默认值。
       */
      /**
       * 🔴 **口径在 P7.19 反转了**（旧形态留在这儿当"别再改回去"的说明）：原先钉的是
       * `__kbwSuite?.results.length` —— 而窄过滤下**绝大多数用例被 skip（不产结果）**，
       * "把二十来个库 boot 起来"这活照样得干完（实测骨架 **87s**）→ 看门狗在 60s 处
       * 把"boot 库"误报成"卡在某条用例"（**假红**，且卡点随机器负载游走）。
       * 现在口径 = **进度心跳**（`Suite.ticks`：进用例**含被 skip 的** / 进分组 / 造夹具 / boot 库都 +1），
       * `results.length` 只作兜底。
       *
       * ⚠️ **不能写成"标识符存在即绿"**（P7.19 独立审查 🔴2 抓到的假绿 —— 第一版就是这么写的）：
       * 只判 `/progressTick/ && /\.ticks/` 时，把 stall 里**真读的那一行**改回
       * `globalThis.__kbwSuite?.results.length`、只留一个**没人调用**的 `progressTick` 死函数，
       * 断言**照样绿** —— 它拦不住自己声称要拦的那条回归。所以钉**两处真形态**：
       * ① `progressTick` 的**定义体里**读 `.ticks`；② stall 那个 interval 里**真的调** `progressTick()`。
       */
      const tickBody = /function progressTick\(\)[^{]*\{([\s\S]{0,200}?)\n\}/.exec(runner);
      ok(tickBody, '找得到 progressTick() 的定义');
      ok(/\.ticks/.test(tickBody![1]), 'progressTick 的定义体必须读 `Suite.ticks`（进度心跳）');
      const stallAt = runner.indexOf('const stall = setInterval');
      ok(stallAt >= 0, '找得到看门狗的 stall 定时器');
      const stallBlock = runner.slice(stallAt, stallAt + 600);
      ok(
        /progressTick\(\)/.test(stallBlock),
        'stall 定时器里必须**真的调** `progressTick()` —— 留着死函数不算（那是"标识符存在即绿"的假绿）',
      );
      /**
       * 再加一道**反向**断言（独立审查 🔴2 的反例就是这个形态）：stall 块里**不许**读
       * `results.length`。只判"调了 progressTick()"还不够 —— 真形态是"**读的是心跳，
       * 而不是完成了多少条用例**"；把读法改回 `results.length`、再残留一个没人调的死函数，
       * 这条必须**当场红**（`scripts/mutate-p719.mjs` 的反例自证喂的就是这一发）。
       */
      ok(
        !/results\.length/.test(stallBlock),
        'stall 块里不许读 `results.length`（那正是本轮修掉的那个假红口径）',
      );
      ok(/KBW_TEST_STALL\s*\?\?\s*60000/.test(runner), '按进展的阈值默认值（60s）也要钉住');
      const m = /KBW_TEST_TIMEOUT\s*\?\?\s*(\d+)/.exec(runner);
      ok(m, '总时长天花板要可覆盖（KBW_TEST_TIMEOUT ?? <默认值>）');
      const ceiling = Number(m[1]);
      ok(
        ceiling >= 240000,
        `总时长天花板要 ≥ 240s：P4.5 实测全量套件 ~94s，90s 那条会把**正常跑完**的杀掉（实际 ${ceiling}ms）`,
      );
      ok(
        !/\b(stall|ceiling)\.unref\(/.test(runner),
        '两个定时器都不能 unref：unref 掉的话"卡在永不 resolve 的 await"会让子进程静默退 0（看起来像通过）',
      );
    });

    await suite.it('搬文件一律走 mover / NotesOps 那条真链路', () => {
      ok(/mover\.move\(/.test(boardSrc), '看板改名走 ctx.mover.move');
      ok(/moveNow\(/.test(boardSrc), '跨板块搬文件走 NotesOps.moveNow（它内部转绝对路径 + 弹撤销条）');
    });
  });

  /**
   * P4.5 e 期（2026-09-26）：分屏 / 预览窗格 Peek / 视图记忆。
   *
   * 这一期最容易"文档说做了、代码没做"的四条，全部钉成源码级判据。
   * 口径出处：`看板优化方案.md` §6.15（开工时用户拍的七条 + 自己定的三条）。
   */
  await suite.group('P4.5 e · 红线（分屏 / Peek / 视图记忆）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read = (rel: string): string =>
      stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));

    await suite.it('e · 分屏只有一处出处，且**方向必须是 `vertical`**（左右并排，不是上下）', () => {
      /**
       * 🔴 为什么连方向字面量都要钉：平台上 `vertical` 说的是**分隔线竖直** =
       * 左右并排、新叶落在右边（asar 取证，写在 `ops.ts` 的 `open()` 上）。
       * 照直觉把它改成 `'horizontal'` 的话，分屏会变成"上下堆叠"——
       * 而**离线与真机都没有别的判据**看得出来（离线只看参数、真机只看到"多了一片"）。
       */
      const ops = read('src/modules/notes/ops.ts');
      ok(
        /getLeaf\(\s*'split'\s*,\s*'vertical'\s*\)/.test(ops),
        "分屏要写 `getLeaf('split', 'vertical')`（vertical = 左右并排、新的在右）",
      );
      ok(!/'horizontal'/.test(ops), "不许出现 `'horizontal'`（那是上下堆叠，与 §3.3 的「左看板 / 右编辑器」相反）");
      // 菜单里要有那一档（三级菜单靠悬停飞出，jsdom 验不了 → 只能静态查）
      const menus = read('src/modules/notes/menus.ts');
      ok(/label:\s*'在右侧分屏打开'/.test(menus), '「打开」子菜单里要有「在右侧分屏打开」');
      ok(/ops\.open\(entry,\s*'split'\)/.test(menus), '菜单项要真的走 `ops.open(entry, \'split\')`');

      /**
       * ⚠️ **`activate()` 不许被改成"新开第二个工作台"**（分屏口径 = 甲）：
       * 工作台永远只有一份 —— 那是"整套代码照单份写"的前提，也是这一期能小的原因。
       * 真机探针另有一条"分屏之后工作台仍然只有一份"（离线桩里没有多视图这件事）。
       */
      const main = read('src/main.ts');
      ok(
        /existing\.length > 0[\s\S]{0,200}?revealLeaf\(existing\[0\]\)/.test(main),
        '`activate()` 仍然是"已开着就聚焦第一个、不新开"',
      );
      ok(!/activate[\s\S]{0,300}?getLeaf\('split'/.test(main), '`activate()` 不许走分屏（工作台只有一份）');
    });

    await suite.it('e · 预览窗格与编辑面板**不许互相 import**（会成环，仲裁只在看板模块里）', () => {
      /**
       * 🔴 `peek.ts` 需要"把面板收掉"、`editor.ts` 需要"点卡片时把 Peek 收掉" ——
       * 互相 import 就成了环。所以清场那一步由看板模块注入（`PeekDeps.onNeedWindow`），
       * 仲裁只出现在 `modules/board/index.ts` 两处。谁要是图省事直接 import，环就回来了。
       */
      const peek = read('src/modules/board/peek.ts');
      ok(!/from\s*'\.\/editor'/.test(peek), '`peek.ts` 不许 import `./editor`（要收面板就调 `deps.onNeedWindow`）');
      const idx = read('src/modules/board/index.ts');
      ok(/onNeedWindow:/.test(idx), '看板模块要把 `onNeedWindow` 注进去（那是互斥的另一半）');
      /**
       * 🔴 **"开面板就把 Peek 收掉"那条已经删掉了**（正确）：占窗格按**口子的占用者身份**走 ——
       * 面板要停靠就申请，申请让 `owner` 变成 `panel`，Peek 收到通知**自己让位**；
       * 浮层态的面板根本不申请，两者可以同时在（审查实测过：那种"顺手收一下"的写法
       * 会让用户随手点一张卡看看预览就没了，而且 `dock` 改成停靠那条路**完全绕过它**）。
       * 现在钉的是这条链路的三处：面板喊身份 → Peek 认身份让位 → 谁刚被用户动过谁赢。
       */
      ok(
        /if \(isPanelOwner\(s\.owner\)\)[\s\S]{0,160}?closePeek\(/.test(read('src/modules/board/peek.ts')),
        'Peek 收到"窗格被面板抢了"要自己让位（按 `isPanelOwner(owner)`，不是"看有人开面板就收"；f 期占用者名是 `panel#<id>`，比字面量会让这段永不触发）',
      );
      ok(
        /dockMoved && !peekMoved && panelClaimsWindow\(\)/.test(idx),
        '仲裁要有**单一落点**：用户刚动的是 `dock` → 面板赢；刚动的是预览那两个键 → 预览赢',
      );
      ok(/export function viewKeyMoved\(/.test(idx), '"谁刚被动过"要有个可测的纯函数（`viewKeyMoved`）');
      ok(/closePeek\(\{\s*reason:\s*'module-dispose'\s*\}\)/.test(idx), '看板模块卸载时要收掉 Peek（它随模块走）');
    });

    await suite.it('e · 视图记忆：`data-scroll` 谁渲染谁贴，外壳负责捕获、模块负责写回', () => {
      /**
       * 契约只有一处出处（`core/view-memory.ts` 的 `SCROLL_ATTR`）—— 这条判据查的是
       * **贴标记的地方够不够**：少贴一层，那一层的滚动位置就静默不记
       *（症状是"回来时只有一半回到原处"，很难归因）。看板与笔记都有**自己的**滚动容器，
       * 外壳那个 `.kbw-modhost` 则是 home / graph 唯一的滚动容器 —— 三层缺一不可。
       */
      ok(/kbw-modhost',\s*attr:/.test(read('src/view/workbench-view.ts')), '外壳要给 `.kbw-modhost` 贴 `data-scroll`');
      const notes = read('src/modules/notes/index.ts');
      ok(/SCROLL_ATTR\]:\s*'list'/.test(notes), '笔记的列表容器要贴（`list`）');
      ok(/setAttribute\(SCROLL_ATTR,\s*'tree'\)/.test(notes), '目录树的滚动容器要贴（`tree`）');
      const board = read('src/modules/board/index.ts');
      ok(/SCROLL_ATTR\]:\s*'board'/.test(board), '看板自己的滚动容器要贴（`board`）');
      /**
       * 🔴 **列也要贴**（真机实测补的）：列形态下**每一列各自滚**
       *（`styles/board.css` 那条 `> .kbw-cards { overflow-y: auto }`）。真机上那个实验库里
       * 唯一有滚余量的容器就是列（看板体与笔记列表都是 0）—— 只贴 `board` 的话，
       * "切走再回来还在原地"在那种库上**一次都不会生效**（探针第一轮实测就是这个形状）。
       */
      ok(
        /setAttribute\(SCROLL_ATTR,\s*`cards:\$\{g\.key\}`\)/.test(board),
        '看板的**每一列**（`.kbw-cards`）也要贴 `data-scroll`，键带上板块 key',
      );

      /**
       * 🔴 **捕获必须在 `Region.paint` 之前**（`for (const r of this.regions)` 那行之前）：
       * `Region.paint()` 是**先清宿主、再调渲染函数**（`core/store.ts`）——
       * 把捕获放进 `paintModule` 里就晚了，那一刻宿主的 DOM 已经没了、捕回来是**一片空**
       *（离线实测踩到过：`pending` 里什么都没有 → 切回来还是 0；而且
       * "捕获为空就不覆盖"那条守卫会把它**静静地**吞掉，症状看着像"功能没生效"）。
       * 判据的形态照项目那条经验写：认调用形态（`rememberScroll(`），别认文件名或文案。
       */
      const view = read('src/view/workbench-view.ts');
      ok(
        /if \(this\.paintedModule\) rememberScroll\(this\.paintedModule, this\.moduleHost\)[\s\S]{0,400}?for \(const r of this\.regions\) r\.paint\(state\)/.test(
          view,
        ),
        '捕获要写在"批量重画各区域"**之前**（Region 会先清宿主）',
      );
      ok(
        !/paintModule\([\s\S]{0,300}?rememberScroll\(/.test(view),
        '`paintModule` 里**不许**再记一次（那时宿主已经空了，是纯粹的假动作）',
      );
      /**
       * ⚠️ **"宿主会不会整体重建"只有一个出处**：模块区 Region 的 `key` 与视图自己那次
       * "该不该记位置"的判断必须用**同一个函数**（`moduleKey`）—— 各写一份的话迟早出现
       * "Region 重画了但没人记"（视图记忆静默失效）。
       */
      ok(/key: \(s\) => this\.moduleKey\(s\)/.test(view), '模块区 Region 的 key 走 `moduleKey()`');
      ok(/if \(mk !== this\.lastModuleKey\)/.test(view), '视图自己那次判断也走 `moduleKey()` 的产物');

      /** 写回的时机：笔记是同步画（mount 末尾），看板是**画实了那一下**（`!cold`） */
      ok(/recallScroll\('notes',\s*host\)/.test(notes), '笔记画完要写回');
      /**
       * ⚠️ 看板那条路现在**不用 `recallScroll`**了：它先在 `mount()` 里 `claimScroll('board')`
       * 把快照**认领走**（否则外壳那句"同步模块兜底"会在 render 返回时就写一次 ——
       * 那时卡片还没画出来，值会被钳成 0），等 `paintBoard` **画实了**那一趟再 `applyScroll`。
       */
      ok(/this\.snap = claimScroll\('board'\)/.test(board), '看板要在 mount 里**认领**快照（异步画，外壳别替它写）');
      ok(
        /if \(!this\.scrollRestored && !cold && this\.snap\)[\s\S]{0,320}?applyScroll\(this\.bodyHost, this\.snap\)/.test(board),
        '看板要等**画实了**那一趟才写回（冷启第一趟是占位，写早了等于写空容器）',
      );
      /**
       * 🔴 **同步画的模块由外壳兜那一下**（`home` / `graph` 滚动的是 `.kbw-modhost` 自己，
       * 模块够不着它）。审查抓的：原先这两个模块**根本没写回**，而文档写着"三层缺一不可"。
       */
      ok(
        /if \(hasPendingScroll\(state\.activeModule\)\) recallScroll\(state\.activeModule, host\)/.test(view),
        '外壳要在 `render()` 返回后给"还没人认领"的模块兜一次写回（同步画的那些）',
      );
      /**
       * 🔴 `captureScroll` / `applyScroll` 要**把 root 自己也算进来**（审查抓的"捕得到、写不回去"）：
       * `querySelectorAll` 不含自己，而调用方常常正传着那个带标记的元素
       *（看板传 `.kbw-board-body`、外壳兜底传 `.kbw-modhost`）。
       */
      ok(
        /for \(const node of \[root, \.\.\.Array\.from\(root\.querySelectorAll/.test(
          read('src/core/view-memory.ts'),
        ),
        '`captureScroll`/`applyScroll` 都要把 **root 自己**算进来（否则那两个键写了白写）',
      );

      /** 插件卸载要清表（模块作用域的表会跨重载残留 → "刚重载完自己滚到半中间"） */
      const main = read('src/main.ts');
      ok(/clearViewMemory\(\)/.test(main), '`onunload` 要清视图记忆');
    });

    await suite.it('e · 窗格只有一个：`request` 带**占用者身份**，收尾只撤自己的', () => {
      /**
       * 🔴 独立审查抓出来的核心缺陷：窗格从 e 期起有**两个**占用者（编辑面板 / 预览窗格），
       * 而 `request(null)` **不认人** —— 谁都能把别人正占着的窗格收掉（实测："点一张卡看一眼，
       * 旁边的预览凭空没了"）。修法是把**占用者身份**放进口子（`ui/dock.ts` 的 `DockOwner`），
       * 于是"撤窗格"只由**当前占用者**做得成（先问 `owner()`）。
       * 这条钉的就是那条规矩 + 判据的**单一出处**。
       */
      const dockM = read('src/ui/dock.ts');
      ok(/export type DockOwner =/.test(dockM), '口子要有占用者身份这个类型');
      ok(/owner\(\): DockOwner \| null/.test(dockM), '要能问"此刻谁占着"');
      ok(
        /canHold\(where: DockSide, size: number\): boolean/.test(dockM),
        '要能问"这个容器放得下吗"（**与谁占着无关**）—— 拿 `applied` 冒充它会弹假通知（审查实测）',
      );
      const view = read('src/view/workbench-view.ts');
      ok(
        /this\.dockOwner !== nextOwner/.test(view),
        '"变了没"要**连占用者一起比** —— 只比 applied 的话换人时没人收到通知（Peek 的自动让位全押在它身上）',
      );

      const ed = read('src/modules/board/editor.ts');
      ok(
        /dockPort\?\.owner\(\) === p\.owner[\s\S]{0,160}?request\(null/.test(ed),
        '面板关窗时只有"**我**是当前占用者"才 `request(null)`（f 期起"我"是 `panel#<id>`：多窗之后比字面量 `\'panel\'` 等于"任何一扇都认成我自己"）',
      );
      const peek = read('src/modules/board/peek.ts');
      ok(
        /p\.port\?\.owner\(\) === PEEK_OWNER[\s\S]{0,140}?request\(null/.test(peek),
        'Peek 收窗格时同理（先问 `owner()`，占用者名走 `PEEK_OWNER` 常量）',
      );
      /**
       * 🔴 **让位要有两条路**：① 自己要让（`applyPeekPlacement` 请面板让开）；
       * ② **别人抢了要能自己走**（面板申请停靠 → 口子的占用者变成 panel → Peek 收通知让位）。
       * 少了 ②，两个根会**同时挂在一个宿主里**（审查实测：两个 100%×100% 挤在一个
       * `overflow:hidden` 里，后 append 的被裁掉）。
       * ⚠️ f 期：判据不能写成 `s.owner === 'panel'` —— 占用者名已经是 `panel#<id>`，
       * 比字面量会让这段让位逻辑**永远不触发**（而那正是这条要防的事），所以走 `isPanelOwner()`。
       */
      ok(
        /if \(isPanelOwner\(s\.owner\)\)[\s\S]{0,160}?closePeek\(/.test(peek),
        'Peek 收到"窗格被面板抢了"要**自己让位**（`isPanelOwner(s.owner)` → closePeek）',
      );
      /**
       * 🔴 **占用者的"我这一个"要认得出来**（f 期多窗）：`ui/dock.ts` 里得有
       * `panelOwner(id)` / `isPanelOwner()` 两个造名与判名的函数，别处不许手拼字符串。
       */
      ok(
        /export function panelOwner\(id: number\): DockOwner/.test(dockM),
        '占用者名要有一个唯一出处（`panelOwner`）',
      );
      ok(
        /export function isPanelOwner\(o: DockOwner \| null \| undefined\): boolean/.test(dockM),
        '"是不是某个面板"的判据要有唯一出处（`isPanelOwner`）',
      );
      /**
       * 🔴 **Peek 没有浮层形态** —— 建出来就得在停靠宿主里（审查实测：容器 700 时它
       * 以真浮层的样子出现在 body 上、`left/top = 4px`，拉宽之后也没人搬它）。
       */
      ok(
        /if \(p\.port\) p\.h\.setDocked\(p\.port\.host\)/.test(peek),
        '建完立刻 `setDocked(host)` —— 它没有浮层形态，放不下时该是**隐形**而不是飘在左上角',
      );
      /**
       * 🔴 **"放不下"必须是几何事实**，不能拿"别人占着"冒充 —— 否则容器 1400px 也会弹
       * 「预览窗格现在放不下」（审查实测到的假通知）。
       */
      ok(
        /canHold\(v\.peek\.where, v\.peek\.size\)/.test(peek),
        '`warnNoRoom` 要先 `canHold()` 确认"真的放不下"',
      );
      ok(/isLoaded\(\)/.test(peek), '配置没读出来时不许按默认值重排（d2 在面板上踩过同一个坑）');

      /**
       * 🔴 **"让出来之后要能收回去"**（e 期真机探针逼出来的）：占着窗格的那个**走了**之后，
       * 配置里说该占着它的那个得能收回窗格。少了它，症状是"边上空着一条、
       * 界面上什么都没有，而菜单里那一项还勾着"。
       * ⚠️ 听者挂在**模块**上（`onWindowFreed`）而不是 Peek 那个对象上 ——
       * 面板抢窗格时收掉的正是**整个 Peek**，挂在它身上的监听会一起没。
       */
      ok(/notifyWindowFreed\(\)/.test(ed), '面板让出窗格时要喊一声（`onClose` 那条路）');
      ok(
        /onWindowFreed\(/.test(read('src/modules/board/index.ts')),
        '看板模块要听着"窗格让出来了"（该占着就占回去）',
      );
      /**
       * ⚠️ **`detachDock` 那一处不许再有**（审查 🟡4）：它零覆盖，且它注释里写的场景
       * 已经被 `cfg.onChange → syncPeek` 兜住了 —— 守不住又不缺它，就是冗余。
       */
      ok(
        !/function detachDock[\s\S]{0,400}?notifyWindowFreed/.test(ed),
        '`detachDock` 里不要那声喊（审查验过：那条路已被别人兜住，且它零覆盖）',
      );
      ok(
        fs.existsSync(path.join(root, 'src/modules/board/window-seat.ts')),
        '那声喊要有个**两边都只单向 import** 的出处（`window-seat.ts`）—— 不然就是 editor ↔ peek 成环',
      );
      /**
       * 🔴 **搬进/搬出的判据只有一处**（审查 🔴2）：原先 `syncDock`（配置变了）与
       * `dockPort.onChange`（容器尺寸变了）各判一份，而后者**不问配置** ——
       * 于是"挤窄再拉宽"会把浮层态的面板拽进窗格。现在两处都调 `applyPanelDock`。
       */
      ok(
        /function applyPanelDock\(/.test(ed) &&
          /view\.dock\.where != null/.test(ed) &&
          (ed.match(/applyPanelDock\(p\)/g) ?? []).length >= 2,
        '搬进/搬出要走**唯一落点** `applyPanelDock`（判据里必须问配置，不能只看 applied）',
      );
    });

    await suite.it('f · 多悬浮窗：占用者带实例号、停靠只许一扇、拆掉的窗不许再碰口子', () => {
      /**
       * f 期把"面板单例"放成了 N 个实例，于是 e 期那条 🔴（"收尾不认人"）**换了个入口复发**：
       *  · 占用者名必须带实例号（`panel#<n>`）—— 还比字面量 `'panel'` 的话，
       *    "乙窗关一下"会被认成"甲窗占着"（`owner() === 'panel'` 对任何一扇都为真）；
       *  · **停靠仍只许一扇**（单槽）：认领制 + `closeDockingPanel`（只收认领者，
       *    不是"把所有窗一起收掉"）；
       *  · **拆掉的窗不许再碰口子**：`emit()` 是"先拷订阅者再逐个叫"，
       *    同一次配置变更里被收掉的那扇，它的 `onCfg` 仍会被叫一次 ——
       *    少了 `panels.has(p)` 守卫，它会照配置反手把窗格抢回来（真机症状：预览刚开就被关掉）。
       */
      const ed = read('src/modules/board/editor.ts');
      ok(!/owner\(\) === 'panel'/.test(ed), "比占用者不许再用字面量 'panel'（多窗之后那是「任何一扇」）");
      ok(/owner\(\) === p\.owner/.test(ed), '比"是不是我"要用实例身份 `p.owner`');
      /**
       * ⚠️ 判据要**按函数体**取，别在整份文件里找那句守卫：`applyPanelDock` 里也有一句同样的，
       * 文件级匹配会让"`syncDock` 的守卫被删掉"照样绿（第一版就是这么假绿的 ——
       * 突变测试当场验出来了）。
       */
      const bodyOf = (name: string): string =>
        new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`).exec(ed)?.[0] ?? '';
      ok(/function closeDockingPanel\(/.test(ed), '要有"只收认领者"的 `closeDockingPanel`');
      ok(
        /if \(!panels\.has\(p\)\) return;/.test(bodyOf('syncDock')),
        '`syncDock` 要有"拆掉的窗不许碰口子"的守卫（少了它，被收掉的那扇会反手把窗格抢回来）',
      );
      ok(
        /if \(!panels\.has\(p\)\) return;/.test(bodyOf('applyPanelDock')),
        '`applyPanelDock` 同理（同一次配置变更里的 `onChange` 也是"先拷订阅者"的写法）',
      );
      ok(
        /!panels\.has\(p2\)/.test(ed),
        '`onCfg` 里也要挡一句：同一次配置变更里已经被收掉的那扇窗，什么都别做',
      );
      ok(/dockingPanel = p;/.test(ed), '停靠认领制：认领时要记名（`dockingPanel = p`）');
      /**
       * 认领者走的时候**要把名额当场交接**（独立审查 🟡1）：只置空的话，
       * "配置里写着停靠、界面上没人停"会一直保持到用户碰巧改了下一次配置。
       */
      ok(
        /if \(dockingPanel === p\) \{[\s\S]{0,200}?dockingPanel = null;[\s\S]{0,400}?syncDock\(next\)/.test(ed),
        '认领者关窗时要把名额**当场交给还开着的一扇**（置空不够：没人接手就一直是空窗格）',
      );
      const idx = read('src/modules/board/index.ts');
      ok(
        /panelClaimsWindow\(\)\) closeDockingPanel\(/.test(idx),
        'Peek 要窗格时只收**认领的那一扇**（拿 closeCardPanel 会把浮层小窗一起收掉）',
      );
      /**
       * **浮层只走 `ui/panel.ts`**（项目红线）：多窗也是它的实例，不许在 board 里自建浮层容器。
       */
      ok(
        !/appendChild\(document\.body\)/.test(ed),
        '看板里不许自建浮层容器（浮层一律走 `ui/panel.ts` 的 `openFloating`/`openModal`）',
      );
      /**
       * **`panel-ui.ts` 与 `editor.ts` 单向**：控件只吃 DOM 与回调，不许反过来 import 状态机
       *（那样多窗那份 diff 会被绕成一团）。
       */
      ok(
        !/from '\.\/editor'/.test(read('src/modules/board/panel-ui.ts')),
        '`panel-ui.ts` 不许 import `./editor`（控件与状态机单向）',
      );
    });

    await suite.it('f · 每一篇的小窗设置：键要跟着改名迁、字号两处同源、尾链判据复用摘要那一份', () => {
      const idx = read('src/modules/board/index.ts');
      /**
       * `panelByPath` 存的是**路径** → 改名/搬移必须迁（本项目在"表里存路径"上栽过好几次：
       * 顺序表、比例表都迁过）。挂的是 `vault.on('rename')`（改名有四个入口，挂按钮必漏）。
       */
      ok(
        /cfg\.view\.panelByPath = nextPanel/.test(idx) && /pendingPanel/.test(idx),
        '`panelByPath` 要跟着改名迁键（与 `manualOrder` / `propsRatioByPath` 同一处）',
      );
      const ui = read('src/modules/board/panel-ui.ts');
      ok(
        /--font-text-size/.test(ui) && /--kbw-cw-scale/.test(ui),
        '字号要写**两处**（正文那份 + 面板自己那几行那份），少一处就是"只有正文变大"',
      );
      /**
       * 尾链折叠要用 `templates.ts` 的那份判据（**别在别处再写一遍「关联笔记」字面量**）。
       * ⚠️ 调用点在 `panel-ui.ts`（折叠那个控件自己"等文档就绪再算行号"），
       * 所以两个文件都要查 —— 判据跟着实现搬家，别只认老地方（第一版就因为这条假红了）。
       */
      const ed = read('src/modules/board/editor.ts');
      ok(/tailHeadingLine\(/.test(ui), '尾链折叠要用 `templates.ts` 的那份判据（`tailHeadingLine`）');
      ok(
        !/'关联笔记'/.test(ed) && !/'关联笔记'/.test(ui),
        '别在面板这两个文件里再写一遍「关联笔记」字面量（判据只有 `templates.ts` 一处）',
      );
      const css = stripComments(fs.readFileSync(path.join(root, 'styles/board.css'), 'utf8'));
      /**
       * 竖条名字（f 期第 1 条）：**正排 + 最多两行**。
       * 🔴 不许 `-webkit-line-clamp`（本项目踩过：它是 legacy flexbox，会把块级子元素**压扁**
       * → 文字互相重叠）；也不许回到 `vertical-rl`（那正是"一个字一行"的成因）。
       */
      const railRule = /\.kbw-rail-nm\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
      ok(/writing-mode:\s*horizontal-tb/.test(railRule), '竖条名字要正排（`horizontal-tb`）');
      ok(!/vertical-rl|vertical-lr/.test(railRule), '不许回到竖排（`vertical-rl` = 一个字一行）');
      ok(
        /max-height:\s*2(\.3em|lh)/.test(railRule) && !/line-clamp/.test(railRule),
        '名字限高两行（`2lh` 或 `2.3em` 兜底），且不许用 `-webkit-line-clamp`',
      );
      /**
       * 🔴 **另两条是"两行"能不能成立的前提**（真机连着抓了两刀，缺一条就退化成"一整行被裁掉"）：
       *  · `max-width`（≈ 两个字）：竖条是列 flex + `align-items: center`，名字的宽度按 **max-content** 走 ——
       *    不限宽就永远不折行；
       *  · `white-space: normal`：竖条是**真 `<button>`**，平台给按钮的样式里有 `nowrap` ——
       *    不写回来，`word-break` 也白搭。
       */
      ok(/max-width:\s*[\d.]+em/.test(railRule), '名字要限宽（≈ 两个字），否则不会折行');
      ok(/white-space:\s*normal/.test(railRule), '要显式写回 `white-space: normal`（平台给按钮的是 nowrap）');
    });

    await suite.it('e · "放不下"必须说出来（Peek 没有浮层形态，沉默等于"点了没反应"）', () => {
      const peek = read('src/modules/board/peek.ts');
      ok(/function warnNoRoom\(/.test(peek), '要有"放不下"的说明那条路');
      ok(/warnNoRoom\(p\)/.test(peek), '裁决不生效时要调到它');
      /**
       * ⚠️ 去重也是判据的一部分：拖窗口变窄的过程里 `onChange` 会来回翻，
       * 每次都弹一条会把人烦死（真机上那是"通知刷屏"）。
       */
      ok(/warnedNoRoom/.test(peek), '要有一条"已经说过了"的去重标志');
    });
  });

  await suite.group('P5 · 红线（重排库结构：只走唯一出口 + 目录口径不混）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read = (rel: string): string =>
      stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));

    /**
     * 🔴 **重排不许自己动文件**（三条硬规矩之一）。
     * 这一条特别值得钉：重排是"一次动几十个文件"的动作，一旦某天有人图省事在面板里
     * 直接 `fileManager.renameFile`，快照、撞名分组、属性跟随、撤销句柄**全都绕过去了** ——
     * 而那是最容易出事的一期。
     */
    await suite.it('P5 · 重排只走 mover / 确认流（面板里不许出现 renameFile、vault.create、vault.delete）', () => {
      const panel = read('src/ui/rebuild-panel.ts');
      const svc = read('src/services/rebuild.ts');
      for (const [name, src] of [
        ['ui/rebuild-panel.ts', panel],
        ['services/rebuild.ts', svc],
      ] as const) {
        ok(!/renameFile/.test(src), `${name} 不许自己 renameFile（动文件只能过 services/mover.ts）`);
        ok(!/vault\.create\(/.test(src), `${name} 不许自己 vault.create`);
        ok(!/vault\.delete\(/.test(src), `${name} 不许自己 vault.delete`);
        ok(!/adapter\.mkdir/.test(src), `${name} 不许自己 mkdir（新建目录要走 mover 的 extraDirs，否则快照的 newDirs 里没有它们、还原删不掉）`);
      }
      ok(/executeRebuild\(/.test(panel), '面板必须走 `executeRebuild`');
      ok(/confirm\(/.test(panel), '动库前必须走 `ui/confirm.ts`');
      ok(/mover\.move\(/.test(svc), '服务层必须调 `mover.move`（唯一出口）');
    });

    /**
     * 🔴 **两种目录口径别混**（P3 栽过一次、P5 又栽了一次）：`plan.newDirs` 是**相对库根**的，
     * 而 `mover` 要**库内绝对路径**。忘了转的症状是"mover 以为整条链都不存在" →
     * **在 vault 根下建出一个 `02_Areas/`**（不在库根里、索引看不见），而"骨架补全了"照样红。
     * 离线用例能抓到（`执行后骨架不缺目录了`），但那是**间接**的 —— 这里把那一行钉死。
     */
    await suite.it('P5 · `extraDirs` 必须经过"库内绝对路径"的转换（相对库根直接喂 mover 会建到库根之外）', () => {
      const svc = read('src/services/rebuild.ts');
      // ⚠️ 别用 `[^)]*` 去跨 `(d) =>`（那里面就有 `)`）——写成"有限长 + 非贪婪"才拦得住，
      // 而且必须**先确认它在当前代码上真的能通过**（断言本身"恒假"是老毛病了）
      ok(
        /extraDirs:\s*plan\.newDirs\.map\([\s\S]{0,64}?joinPath\([\s\S]{0,48}?kbRoot/.test(svc),
        '`extraDirs` 要写成 `plan.newDirs.map((d) => joinPath(deps.kbRoot, d))` —— 少这一转就建到库根之外',
      );
      ok(
        /RebuildDeps[\s\S]{0,200}?kbRoot:\s*string/.test(svc),
        '`RebuildDeps` 必须带 `kbRoot`（它就是为了这一转存在的）',
      );
    });

    /**
     * 🔴 **四期占位必须真的接上**（P5 那三处 `notYet('P5', …)`）。
     * 这条是"文档说修了、代码没修"那个老毛病的对策：占位删了但没人再查的话，
     * 下一次重构很容易把它变回一句 `notYet`，而那时文档还写着"已接上"。
     */
    /**
     * 🔴 **视图记忆的"改名迁移"必须挂在插件层**（e2 留下的那笔，P5 补）。
     * 反例长什么样：只挂看板模块里 → 重排（从「全部笔记」发起、看板没挂载）时，
     * `card:<板块>:<路径>` 那批键没人迁 → 切回看板整片滚动位置重置。
     * ⚠️ 行为判据在 `rebuild.ts` 里有一条（真搬一次、看能不能认出新键），这条只钉"接线"。
     */
    await suite.it('P5 · 视图记忆的改名迁移挂在**插件层**（看板没挂载时也要生效）', () => {
      const main = read('src/main.ts');
      ok(
        /vault\.on\('rename'[\s\S]{0,140}?remapScrollPath\(/.test(main),
        'main.ts 要挂 `vault.on(rename) → remapScrollPath`（看板模块的监听只在它挂载时才在）',
      );
    });

    await suite.it('P5 · 三处入口都不再是占位（命令 / 快速切换 / 目录树菜单）', () => {
      for (const f of ['src/main.ts', 'src/ui/quick-switch.ts']) {
        const src = read(f);
        ok(!/notYet\(\s*'P5'/.test(src), `${f} 里不该再有 notYet('P5', …)`);
        ok(/openRebuildPanel\(/.test(src), `${f} 要走 openRebuildPanel`);
      }
      const menus = read('src/modules/notes/menus.ts');
      ok(/label:\s*'重排库结构…'/.test(menus), '目录树 ⋯ 里要有「重排库结构…」');
      ok(/openRebuildPanel\(m\.ctx\)/.test(menus), '它要真的打开面板，不是置灰的占位');
      ok(!/P5 提供/.test(menus), '不该还留着「P5 提供」那句置灰理由');
    });

    // ── P6 ① 网格档 ────────────────────────────────────────────
    /**
     * ⚠️ **这一段里的 `read()` 已经剥过注释**（`stripComments`，P5 那段定义的）——
     * 所以"注释里解释为什么不能这么写"**不会**把下面这些红线判红。
     * （独立审查 🟡10 报的就是这一条，P6 收尾时**核对后判定不成立**：`read` 里
     *  `.replace(/\/\*[\s\S]*?\*\//g, '')` 那一步在，注释根本进不来。
     *  留着这句以免下一个人再去"修"一遍。）
     */
    await suite.it('P6 · 自由摆放的顺序表**必须**跟着 rename 迁键，且挂在插件层', () => {
      /**
       * "某个脚本必须调用某个判据"这种约定 → 按本项目的规矩落成**静态断言**
       *（只写在交接里，几个月后谁都不会再查 —— P0 的老账）。
       * ⚠️ 判"有没有调用"要用 `fn\(` 这个**带括号**的形态：注释里写不出这个形态，
       * 判名字会被注释骗过（P3 抓到过一条既假绿又假红的红线）。
       */
      const main = read('src/main.ts');
      ok(
        /vault\.on\('rename'[\s\S]{0,600}?remapOrder\(/.test(main),
        'main.ts 要挂 `vault.on(rename) → remapOrder`（顺序表存的是路径，漏迁 = 那篇从手动顺序里失联）',
      );
      ok(/pruneOrder\(/.test(main), '删掉的笔记要把它的路径从顺序表里剪掉');
      // 挂在模块里必漏：改名有四个入口，而网格多半没挂载（P5 同一条教训）
      const grid = read('src/modules/notes/grid.ts');
      ok(
        !/vault\.on\(/.test(grid),
        '网格模块自己**不该**挂 vault 事件 —— 那意味着"网格没渲染时就不迁键"',
      );
    });

    await suite.it('P6 · 拖完换位必须显式重画（`repaint()` 要带 paintRev，不能只推 rev）', () => {
      /**
       * 两个都是"某字段本该让某机制生效"的形状（P5 那条 shot 的同类）：
       *  ① `Store.set` 对**值相同**的字段跳过通知 → 只推 `rev` 的 `repaint()` 可能一声不响什么都不做；
       *  ② 拖动过程里被拖的那一格是 `display:none` 留在原位的 → 松手时不重画就弹回旧顺序。
       */
      const notes = read('src/modules/notes/index.ts');
      ok(/paintRev:\s*this\.store\.get\(\)\.paintRev \+ 1/.test(notes), 'repaint() 要自增 paintRev');
      ok(!/paintRev/.test(read('src/modules/notes/grid.ts')), 'paintRev 只在模块层用（网格不必知道）');
      ok(
        /applyGridReorder[\s\S]{0,1600}?this\.repaint\(\)/.test(notes),
        'applyGridReorder 末尾必须显式 repaint 一次（否则"拖了等于没拖"）',
      );
    });

    await suite.it('P6 · `data-scroll` 的网格键是 `grid`，不蹭表格的 `list`', () => {
      const grid = read('src/modules/notes/grid.ts');
      ok(/SCROLL_ATTR\]:\s*'grid'|SCROLL_ATTR\]: 'grid'/.test(grid), '网格滚动容器要贴 data-scroll=grid');
      const notes = read('src/modules/notes/index.ts');
      ok(/SCROLL_ATTR\]: 'list'/.test(notes), '表格那边仍然是 list（两个键不能混）');
    });

    // ── P6 ② 图谱 ──────────────────────────────────────────────
    await suite.it('P6 · 图谱的 CSS 作用域**只许认自己的类**，不许按 `[data-type="graph"]` 写', () => {
      /**
       * 排查报告 #53：图谱 leaf 的 `data-type` 就是 `"graph"` ——
       * 按它写会连**用户手动打开的官方图谱标签**一起打到（藏掉人家的 .view-header）。
       * 这是"作用域别按平台属性写"这条红线的现场。
       */
      // ⚠️ 同样要**先剥注释**：那个文件的开头就写着"绝不能按 [data-type=...] 写"（解释为什么）
      const css = stripComments(fs.readFileSync(path.join(root, 'styles', 'graph.css'), 'utf8'));
      ok(!/\[data-type/.test(css), 'graph.css 里不许出现 [data-type=...] 选择器');
      ok(/\.kbw-graph/.test(css), '要按我们自己的类作用域（.kbw-graph / .kbw-graph-stage）');
      const ts = read('src/modules/graph/index.ts');
      ok(!/data-type/.test(ts), '图谱模块的代码里也不许按 data-type 做判定');
    });

    await suite.it('P6 · 图谱模块必须**挂之前**判核心插件，且不许自己读 filterOptions', () => {
      const src = read('src/modules/graph/index.ts');
      ok(/graphCoreState\(ctx\.app\)/.test(src), '挂载前要问 graphCoreState（S1：挂完再看 view type 看不出来）');
      // 注入只走 dataEngine.setQuery 这一个口（真机 spike 取证过的那一个）
      /**
       * ⚠️ 要认**真正的调用形态** `de.setQuery([`（独立审查 🟡11）：原来写成
       * `/setQuery\[/ || /\.setQuery/`，而模块的**类型声明**里就有 `setQuery?: (…)` ——
       * 把真正的调用删掉，那条断言照样绿。带 `([` 的形态注释里写不出来。
       */
      ok(/\.setQuery\(\[/.test(src), '过滤要走 dataEngine.setQuery([{query, color}])');
      ok(/requestUpdateSearch/.test(src) === false, '不必自己去戳 requestUpdateSearch（setQuery 内部会排队）');
    });
  });

  /**
   * 段⑤ 打磨轮（2026-09-28）的四条**静态**不变量。
   *
   * 为什么非要静态判一条：① ⑦ ⑧ 的真判据在探针里（量几何 / 算对比度），
   * 但它们都得**等真机跑**才看得见 —— 而这一轮修的正是"实现漂了、没人发现"那一类。
   * 静态这条是**快速的拦网**：谁把稿子那半截容器规则又删了、把 token 换回去了，
   * 一跑离线就红（真机那条仍然保留，它管"数字对不对"）。
   */
  await suite.group('段⑤ 打磨轮（① 勾选框 · ② 设置标题 · ⑦⑧ 触屏与对比）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read = (rel: string): string =>
      stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));
    /** 取一条**顶格写**的规则块（行首锚定 + `m`；本项目的 CSS 一律顶格） */
    const ruleBody = (css: string, selector: string): string =>
      (new RegExp(`^${selector}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '').trim();

    await suite.it('① 「自动排列」勾选框：容器那三条与 i 的 grid 都在（漏一条 = 箱字错位、零间距）', () => {
      const css = read('styles/notes.css');
      const box = ruleBody(css, '\\.kbw-chk');
      ok(box.length > 0, '要有 `.kbw-chk` 的**容器**规则（这是当初漏掉的那半截）');
      ok(/display:\s*flex/.test(box), '容器要 display:flex（行内排会让箱按基线落）');
      ok(
        /align-items:\s*center/.test(box),
        '容器要 align-items:center —— 少了它箱中心比文字块中心高约 1.8px（真机量到的那个数）',
      );
      ok(/gap:\s*6px/.test(box), '容器要 gap:6px —— 少了它箱右缘直接贴着字');
      const i = ruleBody(css, '\\.kbw-chk i');
      ok(/display:\s*grid/.test(i), '`.kbw-chk i` 要 display:grid（稿子 `.chk i` 那一行）');
      ok(/place-items:\s*center/.test(i), '…并且 place-items:center（对勾靠它居中）');
      ok(/flex:\s*none/.test(i), '…并且 flex:none（别被挤扁）');
    });

    await suite.it('⑧ 非文字对比：勾选框边框与树三角走 `--kbw-nontext`，不许用 `--text-faint`', () => {
      const css = read('styles/notes.css');
      const i = ruleBody(css, '\\.kbw-chk i');
      ok(/border:[^;]*var\(--kbw-nontext\)/.test(i), '勾选框边框要用 --kbw-nontext');
      ok(!/--text-faint/.test(i), '勾选框边框不许回到 --text-faint（真机实测它只有 2.3:1）');
      const caret = ruleBody(css, '\\.kbw-tree-caret');
      ok(/color:\s*var\(--kbw-nontext\)/.test(caret), '树三角要用 --kbw-nontext（实测 --text-faint 只有 2.1:1）');
      const tokens = read('styles/tokens.css');
      ok(
        /--kbw-nontext:\s*color-mix\(/.test(tokens),
        '--kbw-nontext 要定义在 tokens.css 里、且用 color-mix 从主题变量算（别写死灰）',
      );
    });

    await suite.it('⑦ 触屏命中：`body.is-mobile` 下自动排列与树三角要用 padding + 负 margin 撑开', () => {
      const mobile = read('styles/mobile.css');
      for (const [sel, what] of [
        ['\\.kbw-chk', '自动排列勾选框'],
        ['\\.kbw-tree-caret', '树的展开三角'],
      ] as const) {
        const body = ruleBody(mobile, `body\\.is-mobile[^{}]*${sel}`);
        ok(body.length > 0, `mobile.css 里要有 \`body.is-mobile … ${sel.replace(/\\/g, '')}\` 那条（${what}）`);
        ok(/padding[^;]*:/.test(body), `${what}：撑命中要靠 padding`);
        ok(/margin[^;]*:\s*-/.test(body), `${what}：要配**负 margin**（否则视觉尺寸跟着变大，不是"只扩大命中"）`);
      }
    });

    /**
     * **拖拽宿主必须挂上三层抑制的 CSS 两层**（P6⑤ 独立审查 A1 抓的漏项）。
     * 触屏长按 400ms 是我们自己的手势，而平台自己的长按约 500ms —— 抑制少一处，
     * 那一下就会被平台抢走（§3.5 那条注释原话）。名单上原先只有网格档那三个，
     * **看板卡片从 P4 起就一直漏着**（P6⑤ 又给它加了"长按进选择模式"，更该压）。
     */
    await suite.it('触屏拖拽宿主（行 / 树行 / 网格格 / 看板卡片）都要挂长按抑制', () => {
      const css = read('styles/mobile.css');
      for (const cls of ['.kbw-trow', '.kbw-tree-item', '.kbw-gcell', '.kbw-card']) {
        /**
         * ⚠️ 类名后面必须跟**边界**（`(?![\w-])`）：第一版写成 `\.kbw-card`，
         * 于是把选择器改成 `.kbw-card-X`（等于删掉了这条抑制）**照样绿** ——
         * 这是我自己给这条断言做突变测试时抓出来的假绿。
         */
        ok(
          new RegExp(
            `body\\.is-mobile[^{}]*${cls.replace(/\./g, '\\.')}(?![\\w-])[^{}]*\\{[^}]*-webkit-touch-callout`,
          ).test(css),
          `${cls} 那条长按抑制要挂在 body.is-mobile 档下（少了它，平台的 500ms 长按会抢手势）`,
        );
      }
    });

    await suite.it('② 设置面板只剩一层标题；栏顶那句说明搬到左栏项的 `title` 上', () => {
      const panel = read('src/ui/settings-panel.ts');
      ok(
        !/kbw-set-title/.test(panel),
        'settings-panel.ts 里不许再有 `kbw-set-title` —— 那是外层那层 h2，会让「同一个词 54px 内出现两次」',
      );
      ok(
        /title:\s*s\.sub/.test(panel),
        '左栏项要把 `sub` 放进 `title`（它就是那句说明现在唯一的落点）',
      );
      /**
       * 反面判据：那个类在样式表里也不该留规则（留着的话下一个人会以为它还画得出来）。
       * ⚠️ 只查**规则**（`selector {` 形态），注释里提到它不算 —— 注释里正解释着"为什么删了"。
       */
      const sheet = read('styles/settings.css');
      ok(!/^\.kbw-set-title\s*\{/m.test(sheet), 'styles/settings.css 里不该再有 `.kbw-set-title { … }` 规则');
    });

    /**
     * 铁律 2 的另一半（`styles/base.css` 那段注释）：**`:active` 只改颜色、不改尺寸/位移** ——
     * 改尺寸会让"点一下跳一下"。
     *
     * 🔴 为什么这一条**只能**是静态的（2026-09-28 实测确认）：`:active` 是浏览器按**真实输入
     * 事件**维护的状态，而探针里只能派**合成** PointerEvent（`P.pointerDownAt` 走 dispatchEvent）
     * —— 合成事件不会让元素进 `:active`，于是"按下去量一遍"量到的永远是常态：
     * 几何必然相同、底色必然没变，**两条断言都恒真**。
     * 所以那条真机判据撤了（探针里留了一句降级说明），把它钉在这儿：
     * 谁哪天给 button 的 `:active` 加一条 `transform: scale(.96)`，这条当场红。
     */
    await suite.it('铁律 2：`:active` 规则里不许出现尺寸 / 位移类声明（静态）', () => {
      const css = read('styles.css');
      /** 尺寸与位移那一类（`border-color` / `background` 不在里面 —— 按下换个色是允许的） */
      const forbidden = /(?:^|[;\s{])(width|height|min-width|max-width|min-height|max-height|padding|padding-\w+|margin|margin-\w+|transform|translate|scale|font-size|border-width|border-\w+-width|top|left|right|bottom)\s*:/;
      /**
       * 🔴 **口径是"所有 `:active` 规则"，不是"选择器里写着 button 的那些"**
       *（独立审查 B4：第一版只认字面含 `button:active` 的选择器，
       *  于是新加一条 `.kbw-root .kbw-btn:active { transform: translateY(1px) }` **全绿** ——
       *  而 `.kbw-btn` 正是加在 button 上的类）。
       *
       * 例外只有一处，并且**必须点名**：滑块圆点（`::-webkit-slider-thumb`）按下时要**顶掉
       * 平台自己那条**把圆点改回 18px 的规则 —— 它改尺寸是**故意的**（见 components.css 那段）。
       */
      const EXEMPT = '::-webkit-slider-thumb';
      const hits: string[] = [];
      const re = /(^|[},])\s*([^{}@]*:active[^{}]*)\{([^}]*)\}/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(css)) !== null) {
        const sel = m[2].trim().replace(/\s+/g, ' ');
        if (sel.includes(EXEMPT)) continue;
        const body = m[3];
        if (forbidden.test(body)) hits.push(`${sel} → ${body.trim().replace(/\s+/g, ' ')}`);
      }
      ok(
        hits.length === 0,
        `:active 规则里出现了尺寸/位移声明（铁律 2：触屏按下去不该跳）：${hits.join(' ｜ ')}`,
      );
      /**
       * 反面自证：这条断言**得能找到规则**才谈得上守住 —— 一条都找不到的话
       * （比如选择器写法变了）它会变成恒真。所以顺便要求"至少命中一条"。
       */
      ok(
        /\.kbw-root button:active/.test(css),
        'styles/base.css 里那条 `.kbw-root button:active { background: … }` 得在（否则上面那条断言是空转）',
      );
    });
  });

  /**
   * ══════════════════════════════════════════════════════════════════
   * **P6 段⑥ · 结构与手势轮**（2026-09-28）—— 接线类判据
   * ══════════════════════════════════════════════════════════════════
   *
   * 这一组只钉"**约定的接线**"：某个函数必须被谁调用、某个常量必须与谁同源、
   * 某段旧实现必须真的删了。它们本身**验不了行为**（行为在 `p6d.ts` 与探针里），
   * 但它们是"文档说改了、代码没改"这类事的唯一拦路虎 —— 本项目从 P0 起就在这上面栽。
   *
   * ⚠️ 写法三条（都是本项目踩出来的）：
   *  ① **一条 `it` 一条断言**：`ok()` 一失败就抛，同一块后面几条**永远不跑**；
   *  ② **先剥注释再判**：注释里写着类名/字符串会被判成"代码里有"（既假绿又假红都出过）；
   *  ③ **判"有没有调用"用带括号的形态**（`fn\(`）—— 注释里写不出这个形态。
   */
  await suite.group('P6 段⑥ · 结构改动的接线（静态）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
    /**
     * 剥掉注释再判 —— 注释里的词不算数。
     * ⚠️ 这个 JSDoc 里**不能写出块注释的闭合符号**（写了就提前把这段注释结束掉，
     * 后面整片变成"代码"→ 语法错误）。与"探针注释里不许出现反引号"是同一类坑。
     */
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    await suite.it('④-A：旧的 ::before 灰带已经删干净（不是"新加了槽、旧带还在"）', () => {
      const shell = strip(read('styles/shell.css'));
      ok(
        !/\.kbw-topbar::before/.test(shell),
        'shell.css 里不该再出现 `.kbw-topbar::before` —— 灰带已经被列头槽取代了',
      );
      ok(/\.kbw-colslot\s*\{/.test(shell), '.kbw-colslot 的规则得在（槽本体）');
    });

    await suite.it('④-A：槽宽与目录栏宽**同源**（都读 --kbw-col-w）', () => {
      /**
       * 🔴 这条钉的是 P6b 独立审查 A🔴2 那个真破绽的**结构根因**：
       * 灰带 208 vs 目录栏 168 —— 两处各写一个数。改成同一个变量之后，
       * "两边不一致"这类错从结构上就不可能再发生（而不是靠下次记得同步改两处）。
       */
      const shell = strip(read('styles/shell.css'));
      const notes = strip(read('styles/notes.css'));
      ok(
        /\.kbw-colslot[\s\S]{0,400}?width:\s*var\(--kbw-col-w/.test(shell),
        '槽宽要读 --kbw-col-w',
      );
      ok(
        /\.kbw-notes-side\s*\{[\s\S]{0,300}?width:\s*var\(--kbw-col-w/.test(notes),
        '目录栏宽也要读 --kbw-col-w（同源，别各写一个数）',
      );
      ok(/\.kbw-root\s*\{\s*--kbw-col-w:/.test(shell), '变量的默认值要有出处');
    });

    await suite.it('④-A：notes 模块**真的把表头搬进槽**（不是只加了样式）', () => {
      const src = strip(read('src/modules/notes/index.ts'));
      ok(/this\.colSlot\.el\.replaceChildren\(head\)/.test(src), 'paintTree 里要把表头搬进槽');
      ok(
        /this\.colSlot\s*=\s*this\.ctx\.colSlot\s*\?\?\s*null/.test(src),
        '依赖要在 mount 里**认一次**（ctx 是单槽，每次现取会填进别人那一扇）',
      );
    });

    await suite.it('⑤：双击那条路接的是 handOffToTab（不是另写一份"先关后开"）', () => {
      const src = strip(read('src/modules/board/editor.ts'));
      ok(/export async function promoteToTab\(/.test(src), 'promoteToTab 得在');
      ok(
        /await handOffToTab\(hit\.panel,\s*hit\.tab,\s*opts\)/.test(src),
        '升格必须复用 handOffToTab（先 save 再 detach 那条已验证的路）',
      );
      ok(/getLeaf\('tab'\)\.openFile/.test(src), '最后仍然由平台在标签区打开');
    });

    await suite.it('⑤：卡片双击接了线（`onDoubleClick` 是必填项，不是可选项）', () => {
      const cards = strip(read('src/modules/board/cards.ts'));
      const index = strip(read('src/modules/board/index.ts'));
      ok(/onDoubleClick:\s*\(entry: NoteEntry, evt: MouseEvent\) => void;/.test(cards), 'CB 里要有 onDoubleClick');
      ok(/addEventListener\('dblclick'/.test(cards), '卡片上要挂 dblclick 监听');
      ok(/onDoubleClick:\s*\(e, evt\)\s*=>\s*this\.onCardDoubleClick\(e, evt\)/.test(index), '看板模块要接上');
    });

    await suite.it('⑥：编辑器菜单**注册了**，且各路动作走既有出口（R8 两栏版）', () => {
      const main = strip(read('src/main.ts'));
      ok(/registerEditorMenu\(this,\s*\{/.test(main), 'main.ts 要注册 editor-menu');
      /**
       * 🔴 **判据要认"那一处"的调用形态，不能认整个文件里有没有这个名字**
       *（独立审查 B-7 用突变实证过第一版是**恒真**的）：
       * `this.mover.move(` 在 `main.ts` 里有多处（`runReconcile` 从 P3 起就在），
       * 所以把**菜单那条**从 mover 摘掉，`/this\.mover\.move\(/` 照样命中 → 判据不红。
       * 现在改成：把 **`renameFromMenu` 那一段**截出来，只在这个范围内判。
       * 「自动整理」那条链的动作在 `modules/home/tidy.ts`（下面单独判）。
       */
      const sliceFn = (src: string, name: string): string => {
        const i = src.indexOf(`private async ${name}(`);
        if (i < 0) return '';
        const j = src.indexOf('\n  private ', i + 10);
        return src.slice(i, j < 0 ? undefined : j);
      };
      const renameFn = sliceFn(main, 'renameFromMenu');
      ok(renameFn.length > 0, '找得到 renameFromMenu 那一段（R8 的「重命名」）');
      ok(/this\.mover\.move\(/.test(renameFn), '「重命名」要过 mover（硬规矩一）');
      ok(/showMoveUndo\(/.test(renameFn), '搬完要弹撤销条（§8.5：与手工那条完全同一套）');
      // 「问 AI」照旧只开面板不动库（红线不随版面变）
      ok(/this\.ctx\.openAi\(seed, \[ref\]\)/.test(main), '「问 AI」还是只开面板（一个字节都不动库）');
    });

    await suite.it('⑥：菜单的动作与自动那条**共用判据**（不在 UI 层另写一份规则）', () => {
      const menu = strip(read('src/ui/editor-menu.ts'));
      ok(
        !/declaredPositions|isPositionLocked|isExcluded/.test(menu),
        'ui/editor-menu.ts 里不许出现规则本身 —— 它只该把选择转成回调',
      );
      /**
       * R8（拍定 14）：单篇归位并入「自动整理」，判据换成与一键整理**同一条链** ——
       * 「规则只有一份」的原则不变，只是那份规则搬了家。
       */
      const tidy = strip(read('src/modules/home/tidy.ts'));
      ok(/planRebuild\(/.test(tidy), '「自动整理」那条链要用 planRebuild 那份判据（与一键整理同一份）');
      const main = strip(read('src/main.ts'));
      ok(/runInboxTidy\(this\.ctx,\s*\{/.test(main), 'main.ts 的「自动整理」接线要收进 runInboxTidy（收窄档）');
    });

    await suite.it('语义色：`.kbw-flag` 只有一处定义（同权重谁赢看源码顺序）', () => {
      /**
       * 🔴 这条**真抓到过**：`styles/settings.css` 里原先还留着一条
       * `.kbw-flag.flag-green { color: var(--text-on-accent) … }`，而它在 `STYLE_ORDER`
       * 里排在 `components.css` **之后** → 新样式被它**悄悄盖掉**。
       */
      const dir = path.join(root, 'styles');
      const hits: string[] = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.css')) continue;
        const code = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (/\.kbw-flag\s*\{/.test(code) || /\.kbw-flag\.flag-/.test(code)) {
          if (f !== 'components.css') hits.push(f);
        }
      }
      eq(hits.join('、'), '', '除了 components.css，别处不许再定义 .kbw-flag');
    });

    await suite.it('探针：⑧ 那一步**不再量那条已经不存在的 ::before 灰带**', () => {
      /**
       * ⚠️ 这条是"改了实现、判据还在看老东西"的拦路虎（提示词专门点了名的）：
       * 旧判据量的是 `getComputedStyle(topbar, '::before')` —— 槽一上来，
       * 那个伪元素就没了，判据会**量到空值然后静默通过**。
       */
      const probe = fs.readFileSync(path.join(root, 'scripts/probe.mjs'), 'utf8');
      ok(
        !/getComputedStyle\([^)]*'::before'/.test(probe),
        "probe 里不该再有量 '::before' 的判据",
      );
      ok(/\.kbw-colslot/.test(probe), 'probe 要改量列头槽');
      /**
       * 反证（**否则上面两条可能是空转**）：槽那一步得真的在，而且量的是三列头中心差。
       */
      ok(/列头槽/.test(probe) && /headDy/.test(probe), '三列头同一基线那条判据要在');
    });
  });

  await suite.group('P6④ · 红线（AI 助手与向导：四条安全边界落在代码里）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read = (rel: string): string =>
      stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));

    /**
     * 🔴 **AI 这半边不许有自己的写盘路径**（§11 边界 ②）。
     * 这一条特别值得钉：AI 是"别人写的话"驱动的一次批量动库 —— 一旦某天有人图省事
     * 在面板里直接 `renameFile`，快照、撞名自查、双链跟随、日志、撤销句柄**全都绕过去了**，
     * 而那正是安全论证（"AI 没有特权通道"）的地基。
     *
     * ⚠️ **P7.3b 起执行体搬去了 `ui/ai-tools.ts`**（ToolPort 的界面侧实现）——
     * 钉点跟着搬：`ui/ai-panel.ts` 现在**一个字都不许**出现写盘 API（它只管画），
     * 动库那三条形态（confirm / mover / `source:'ai'`）钉在 `ui/ai-tools.ts` 上。
     */
    await suite.it('AI 面板只画不动库：写盘 API 一个字都不许出现（执行体在 ui/ai-tools.ts）', () => {
      const panel = read('src/ui/ai-panel.ts');
      const svc = read('src/services/ai/index.ts');
      for (const [name, src] of [
        ['ui/ai-panel.ts', panel],
        ['services/ai/index.ts', svc],
      ] as const) {
        ok(!/renameFile/.test(src), `${name} 不许自己 renameFile（动文件只能过 services/mover.ts）`);
        ok(!/vault\.create\(/.test(src), `${name} 不许自己 vault.create`);
        ok(!/vault\.delete\(/.test(src), `${name} 不许自己 vault.delete`);
        ok(!/adapter\.mkdir/.test(src), `${name} 不许自己 mkdir`);
        ok(!/processFrontMatter/.test(src), `${name} 不许自己改属性（那是 services/frontmatter.ts 的活）`);
      }
      // 面板连"动库那几个动词"都不许出现 —— 干了活的只能是 ai-tools.ts
      ok(!/mover\.move\(/.test(panel), '面板不许直接调 mover（那是 ui/ai-tools.ts 的活）');
      ok(!/confirm\(/.test(panel), '面板不许直接弹确认流（那是 ui/ai-tools.ts 的活）');
      /**
       * ⚠️ **P7.10 · #11 的搬家与它的新禁令**：会话的两个动作（抽屉行的导出 / 删除）搬去了
       * `ui/session-actions.ts` —— 删除要弹一个**轻确认**，而上面那条不许面板出现 `confirm(`。
       * 那条红线的 why 是**动库**（AI 驱动的批量写盘不许绕开 ai-tools 的口子）；会话管理不是动库，
       * 于是给它配上自己的禁令：**只动插件目录**（`sessions.remove`），库内写盘一个都不许有。
       */
      const sess = read('src/ui/session-actions.ts');
      ok(/ctx\.ai\.sessions\.remove\(/.test(sess), '会话删除走 sessions.remove（插件目录 IO）');
      ok(
        !/vault\.|processFrontMatter|renameFile|mover\./.test(sess),
        '会话动作不碰库（vault / 属性 / mover 全禁）',
      );
      ok(/confirm\(/.test(sess), '删除的轻确认在这里（不在面板里 —— 面板红线不破）');
      const tools = read('src/ui/ai-tools.ts');
      /**
       * 🔴 **负向名单也要套在执行体上**（独立审查 🟡6）：原先它只套在 `ai-panel` 与
       * `services/ai/index.ts` 上，而真正写盘的是 `ai-tools.ts` —— 谁在这儿加一句
       * `vault.create` / `renameFile`，红线全绿（那是"红线的方向反了"）。
       *
       * ⚠️ **P7.22a · #1 的取用方式（有意识）**：正文编辑工具（`patch_text` / `append`）
       * 要写盘，但**不在执行体里开 API** —— 抽了 `ui/doc-write.ts` 做**第五条出口**
       * （快照 → `vault.process` → 日志 → 撤销条；beautify 与 agent 共用同一条链）。
       * 负向名单一个字没松（`vault.process(` 照旧禁），正向**加**"必须调那条新出口"：
       * 两边一起看才成立 —— 谁把 writeDocs 改回直接 vault.process，这条会当场红。
       */
      for (const bad of [
        'renameFile',
        'vault.create(',
        'vault.delete(',
        'adapter.mkdir',
        'processFrontMatter',
        'vault.modify(',
        'vault.process(',
        'fileManager.trashFile(',
      ]) {
        ok(!tools.includes(bad), `src/ui/ai-tools.ts 不许出现 ${bad}（动库只能过 mover / fm / completion / doc-write 的既有出口）`);
      }
      ok(/confirm\(/.test(tools), '动库前必须走 `ui/confirm.ts`');
      ok(/mover\.move\(/.test(tools), '搬运必须调 `mover.move`（唯一出口）');
      ok(/mover\.trash\(/.test(tools), '删除必须调 `mover.trash`（它自己拍快照）');
      ok(/fm\.setMany\(/.test(tools), '改属性/标签走 `fm.setMany`（唯一写路径）');
      ok(/completion\.createNote\(/.test(tools), '新建走 `completion.createNote`（既有出口）');
      ok(/writeDocs\(/.test(tools), '正文写必须调 `ui/doc-write.ts` 的 writeDocs（P7.22a 的第五条出口）');
      ok(/source:\s*'ai'/.test(tools), "`source` 必须是 'ai'（否则日志里读不出「这是 AI 建议的」）");
      /**
       * **第五条出口自身**的实现检查（正向）：`vault.process` 与快照都在它的家里 ——
       * 这两件是"写链完整"的形态特征，缺了任何一件说明出口被掏空/换路了。
       */
      const docWriteSrc = read('src/ui/doc-write.ts');
      ok(/vault\.process\(/.test(docWriteSrc), '`ui/doc-write.ts` 是 vault.process 的家（第五条出口）');
      ok(/snapshot\.capture\(/.test(docWriteSrc), '写前快照（一批一动 = 一快照 = 一撤销句柄）');
    });

    /**
     * 🔴 **工具定义层不许 import `ui/` / `modules/` / `mover`**（P7.3b 的"端口模式"，计划点名的
     * 新静态断言）。理由就是 agent 的"手脚"必须与界面轮解耦：P7.1/2/4/5/7 那些轮会大改
     * `modules/` 与 `ui/` 的其它文件 —— 工具这一层只许吊在 `services/` + `core/` 上，
     * 才不会"别人改界面，agent 悄悄坏了"。
     */
    await suite.it('🔴 工具定义层（tools.ts / agent.ts / prompt.ts / tasks.ts / grep.ts / text-edit.ts）不许 import ui / modules / mover', () => {
      /**
       * ⚠️ P7.21 · #1：`tasks.ts`（任务注册表 + 统一 runner）**进来了** —— 这条名单是硬编码的，
       * 新文件天然逃逸（P7.3c 那次已经吃过一回）；往后 `services/ai/` 每加一个纯逻辑文件，
       * 都要先把它加进这里。⚠️ P7.21b 又加了一个：`grep.ts`（正文检索的纯逻辑件）。
       * ⚠️ P7.22a 又加了 `text-edit.ts`（patch_text / append 的三态幂等与尾部包含检查 ——
       * 纯字符串进纯字符串出，连 obsidian 都不 import）。
       */
      for (const rel of [
        'src/services/ai/tools.ts',
        'src/services/ai/agent.ts',
        'src/services/ai/prompt.ts',
        'src/services/ai/tasks.ts',
        'src/services/ai/grep.ts',
        'src/services/ai/text-edit.ts',
      ]) {
        const src = read(rel);
        ok(!/from\s+'[^']*\/ui\//.test(src), `${rel} 不许 import ui/`);
        ok(!/from\s+'[^']*\/modules\//.test(src), `${rel} 不许 import modules/`);
        ok(!/from\s+'[^']*mover'/.test(src), `${rel} 不许 import mover`);
        ok(!/from\s+'obsidian'/.test(src), `${rel} 不许 import obsidian（纯逻辑层，留给桩也容易）`);
      }
      const agent = read('src/services/ai/agent.ts');
      ok(/ToolPort/.test(agent), 'agent.ts 只认 ToolPort 这个接口（执行体在界面侧）');
      const tools = read('src/services/ai/tools.ts');
      ok(/effectiveTier\(/.test(tools), '档位解析在工具定义层（档位来自设置，模型说什么都不改变它）');
    });

    /**
     * 🔴 **P7.21 · #1：任务注册表是唯一任务源**。
     *
     * 判据钉两件事：
     *  ① **服务层不再自己拼提示词**：八条管线 + agent + ask 的 builder 调用全搬进注册表
     *     （`services/ai/index.ts` 出现任何一个 `buildXxxMessages(` 都是"第二份拼法"回来了）；
     *  ② **横切由 runner 统一递**：`skill` / `workDir` 在 `runAiTask` 里并进每一条任务的
     *     build 输入 —— 静态认调用形态（`skill: cross.skill`），注释里写不出这个形状。
     */
    await suite.it('🔴 P7.21：任务注册表是唯一任务源（服务层不再自己拼提示词 · 横切由 runner 统一递）', () => {
      const tasks = read('src/services/ai/tasks.ts');
      ok(/skill:\s*cross\.skill/.test(tasks), '横切 skill 由 runner 统一并进 build 输入');
      ok(/workDir:\s*cross\.workDir/.test(tasks), '横切 workDir 由 runner 统一并进 build 输入');
      ok(/runAgentLoop\(/.test(tasks), '工具循环那条路也在同一段 runner 里（两种形状一个口）');
      ok(/AI_TASKS\s*=/.test(tasks) && /'fix-fm'/.test(tasks), '注册表本体在（八条管线 + ask + agent 一行一条）');
      const svc = read('src/services/ai/index.ts');
      /**
       * ⚠️ **名单两半都要**（独立审 🟡2，P7.21a）：任务 = `build` + `parse` 两个字段 ——
       * 只钉 builder 等于半个断言（把 `parseAdvice(...)` 加回服务层，原版断言**照绿**，实测过）。
       * 认形用 `/名字\s*\(/`：`includes('buildMessages(')` 会被 `buildMessages (…)` 的空格写法漏过。
       */
      for (const fn of [
        'buildMessages',
        'buildAgentMessages',
        'buildClassifyMessages',
        'buildMocPickMessages',
        'buildTitleMessages',
        'buildLocusMessages',
        'buildLinkFixMessages',
        'buildBeautifyMessages',
        'buildFixFmMessages',
        'parseAdvice',
        'parseTitles',
        'parseLocus',
        'parseLinkFix',
        'parseBeautify',
        'parseFixFm',
        'parseAgentReply',
      ]) {
        ok(
          !new RegExp(`${fn}\\s*\\(`).test(svc),
          `services/ai/index.ts 不许再直接调 ${fn}(（走注册表 —— 别留第二条拼法）`,
        );
      }
      ok(/runAiTaskCore\(/.test(svc), '服务层的接线走统一 runner');
      /**
       * 🟡3：两份文档的工具数口径不许漂（旧口径字样一处不改就是契约漂）。
       * ⚠️ **P7.22b 修**（独立审 R-1 实测）：原先裸判 `includes('七个工具')` ——
       * 而"**十七**个工具"**包含**这个子串 ⇒ 本轮把口径改到十七时，这条当场红
       *（守卫比它要防的东西还宽）。改成**数字前视负向**：前面是数字（十/一…九）的
       * "…七个工具"是合法计数（十七/二十七），只有**裸的**"七个工具"才算漂。
       * 反例自证：`'了七个工具'` 仍命中（喂过）；`'十七个工具'` 不命中。
       */
      const freeze = fs.readFileSync(path.join(root, 'AI接口冻结-P7.3c.md'), 'utf8');
      const spec11 = fs.readFileSync(path.join(root, '交互规格.md'), 'utf8');
      for (const [name, doc] of [
        ['AI接口冻结', freeze],
        ['交互规格', spec11],
      ] as const) {
        ok(
          !/(?<![0-9一二三四五六七八九十])七个工具/.test(doc),
          `${name} 里不许再出现裸的"七个工具"（工具表已扩到十七 —— 三处同改）`,
        );
      }
    });

    /**
     * 🔴 **P7.3c 新加的两层也守着同一条隔离**（能力包 `skills.ts` / 成本 `cost.ts`）。
     *
     * 为什么单独一条：上面那条名单是**硬编码的三个文件**，新文件天然逃逸 ——
     * 而这两个文件恰好又是"最容易被顺手写脏"的（读库内文件 / 算钱，都有一百个理由
     * 想 import 点界面东西）。口径与那条一样：只许吊在 `services/` + `core/` 上。
     */
    await suite.it('🔴 P7.3c：能力包层与成本层不许 import ui / modules / mover（也不许写盘）', () => {
      /**
       * ⚠️ **P7.22b 加 `task-prompts.ts`**（独立审 Y-4）：它自己的头注就写着"redline 有静态
       * 断言钉着这两个文件的形态"，而名单是硬编码的 —— 新文件天然逃逸，别让那条头注说谎。
       */
      for (const rel of ['src/services/ai/skills.ts', 'src/services/ai/cost.ts', 'src/services/ai/task-prompts.ts']) {
        const src = read(rel);
        ok(!/from\s+'[^']*\/ui\//.test(src), `${rel} 不许 import ui/`);
        ok(!/from\s+'[^']*\/modules\//.test(src), `${rel} 不许 import modules/`);
        ok(!/from\s+'[^']*mover'/.test(src), `${rel} 不许 import mover`);
        for (const bad of ['renameFile', 'vault.create(', 'vault.delete(', 'processFrontMatter', 'vault.modify(', 'fileManager.trashFile(']) {
          ok(!src.includes(bad), `${rel} 不许出现 ${bad}`);
        }
      }
      /**
       * `cost.ts` 是**纯算法**（连 obsidian 都不碰 —— 离线用例不装桩就能验）；
       * `skills.ts` 要读盘，所以只对 obsidian 做 **type-only** import（同 `sessions.ts`：
       * 编译后整段消失，检测 bundle 里不会凭空多一个不存在的具名导出）。
       */
      ok(!/from\s+'obsidian'/.test(read('src/services/ai/cost.ts')), 'cost.ts 不许 import obsidian（纯算法）');
      ok(
        /import type \{[^}]*\} from 'obsidian'/.test(read('src/services/ai/skills.ts')),
        'skills.ts 对 obsidian 只做 type-only import',
      );
    });

    /**
     * 🔴 **能力包收窄的落点在执行体**（P7.3c D1 拍板："白名单只做减法"）。
     *
     * 提示词那一侧只是"别让模型白提一条注定被拒的动作"，**真正的拦在有 mover 的那一层**——
     * 只钉提示词的话，收窄会变成"求模型自觉"（而 17.10① 的原话是：模型说的话不算数）。
     */
    await suite.it('🔴 P7.3c：白名单由执行体收窄（提示词那侧只负责少列几个工具）', () => {
      const tools = read('src/ui/ai-tools.ts');
      ok(/deps\.allowTools/.test(tools), '执行体真的读白名单');
      ok(/allowTools[^\n]*includes\(/.test(tools), '按"名单里有它才放行"收窄');
      const prompt = read('src/services/ai/prompt.ts');
      ok(/AI_TOOL_DOC/.test(prompt), '提示词里的工具目录来自工具表（同一份数据，别抄第二份）');
      ok(/input\.skill/.test(prompt), 'skill 收窄在提示词那侧也接了线');
    });

    /**
     * 🔴 **设置里的「测试连接」只许走 `ctx.ai.testConnection`**（17.10③ 拍板：
     * "诊断的输出形状要与 `AiError.kind` 对齐，别另造一套"）。
     * 自己拼一条请求就会长出第二套错误分类 —— 那种事在界面上没人看得出来，
     * 只有静态断言拦得住。
     */
    await suite.it('🔴 P7.3c：设置栏的「测试连接」只许走 ctx.ai.testConnection（别另造一套错误分类）', () => {
      const s = read('src/ui/settings/ai.ts');
      ok(/ctx\.ai\.testConnection\(/.test(s), '调用的是服务层那一个（带括号的调用形态）');
      ok(!/httpTransport\(/.test(s), '不许自己造传输层');
      ok(!/new AiError\(/.test(s), '不许自己造错误（分类只许来自 transport 的 AiError.kind）');
    });

    /**
     * 🔴 **R8：两个子菜单各 ≤3 项（条件项除外），四个预设在 `›` 子菜单里**（§8.5 的新契约）。
     * 判据按**函数切片**数 `sub.addItem(`：把任一栏铺成平级菜单会当场红。
     */
    await suite.it('🔴 R8：editor-menu 两栏各 ≤3 项 · 预设在子菜单里 · 段位走 insert · §8.5 同源', () => {
      const src = read('src/ui/editor-menu.ts');
      const sliceFn = (s: string, name: string): string => {
        const i = s.indexOf(`function ${name}(`);
        if (i < 0) return '';
        const j = s.indexOf('\nexport ', i + 10);
        return s.slice(i, j < 0 ? undefined : j);
      };
      const editorFn = sliceFn(src, 'buildEditorSubmenu');
      const aiFn = sliceFn(src, 'buildAiSubmenu');
      ok(editorFn.length > 0 && aiFn.length > 0, '两个构造器都要在（经纬 / 经纬AI）');
      eq(
        (editorFn.match(/sub\.addItem\(/g) ?? []).length,
        3,
        '经纬栏 ≤3 且恒 3（复制文件路径 / 重命名 / 返回经纬工作台）',
      );
      eq(
        (aiFn.match(/sub\.addItem\(/g) ?? []).length,
        4,
        '经纬AI 栏 = 3 常态 + 1 条件项（问 AI（选中文本））',
      );
      ok(/if \(sel === ''\) return;/.test(aiFn), '条件项：没有选区就不画（点了注定没反应的东西不进菜单）');
      ok(/inner\.addItem\(/.test(aiFn), '四个预设走它的 `›` 子菜单（不在平级铺开）');
      ok(
        /buildEditorSubmenu\(sub, real, deps\)/.test(src) && /buildAiSubmenu\(sub, real, deps, selection\)/.test(src),
        '注册路径要把两个子菜单都建出来',
      );
      ok(/EDITOR_SECTION/.test(src), '段位走 EDITOR_SECTION（放到「插入」之下 —— asar 取证）');
      eq((src.match(/id: '/g) ?? []).length, 4, 'WRITE_PRESETS 正好四条');
      const spec = fs.readFileSync(path.join(root, '交互规格.md'), 'utf8');
      ok(/两个子菜单/.test(spec) && /各\*\*最多 3 项\*\*/.test(spec), '§8.5 写着 R8 的新契约（文档与实现同源）');
    });

    /**
     * 🔴 **两份名单必须一致**（独立审查 🟡7：原先那条用例名写着"两份一致"，函数体
     * 根本没读 `settings.ts` —— 数字写错的用例名比没写更坏）。
     * `core/` 与 `services/` 分层上不互相依赖（该），所以类别名与档位值各写了一份 ——
     * 这条**读两个文件的源文本**把它们对起来（改一处忘另一处 → 当场红）。
     */
    await suite.it('🔴 toolTiers 的两份名单一致（settings.ts 的白名单 ↔ tools.ts 的真源）', () => {
      const settingsSrc = fs.readFileSync(path.join(root, 'src/core/settings.ts'), 'utf8');
      const toolsSrc = fs.readFileSync(path.join(root, 'src/services/ai/tools.ts'), 'utf8');
      const clsInSettings = /const AI_TIER_CLASSES = \[([^\]]*)\] as const/.exec(settingsSrc)?.[1] ?? '';
      const idsInTools = [...toolsSrc.matchAll(/id: '(\w+)'/g)].map((m) => m[1]);
      const listOf = (s: string): string[] =>
        [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
      eq(
        listOf(clsInSettings).join(','),
        [...idsInTools].sort().join(','),
        '类别名单：settings 的白名单与 AI_TOOL_CLASSES 的 id 一致',
      );
      const valsInSettings = /const vals = \[([^\]]*)\] as const/.exec(settingsSrc)?.[1] ?? '';
      eq(listOf(valsInSettings).join(','), 'auto,confirm,off', '档位值三档一致');
      ok(idsInTools.length >= 6, `tools.ts 里认得出类别 id（实际 ${idsInTools.length} 个）`);
    });

    await suite.it('🔴 AI 会话存储（sessions.ts）不碰库：adapter 只许落在 ai-sessions/ 下', () => {
      /**
       * 独立审查 🟢9：上面那张文件名单是硬编码的，新文件天然逃逸 ——
       * `sessions.ts`（P7.3a 新增）用 `adapter.mkdir/write/remove`，按 G4-C1
       * 存**插件目录**不算违规，所以这里**不套上面那套"不许 adapter"**，
       * 单独钉它自己的两条：不许碰库内写盘 API · 存储位置常量必须写着 ai-sessions。
       */
      const src = read('src/services/ai/sessions.ts');
      ok(!/renameFile/.test(src), '不许 renameFile（动文件只能过 services/mover.ts）');
      ok(!/vault\.create\(/.test(src), '不许 vault.create（「导出为笔记」走 completion 的既有出口）');
      ok(!/vault\.delete\(/.test(src), '不许 vault.delete');
      ok(!/processFrontMatter/.test(src), '不许改属性（那是 services/frontmatter.ts 的活）');
      ok(!/from\s+'\.\.\/mover'|from\s+'\.\.\/\.\.\/services\/mover'/.test(src), '不许 import mover');
      ok(/['"]ai-sessions['"]/.test(src), "存储只许落在插件目录的 'ai-sessions' 下（口径常量在这里）");
    });

    await suite.it('🔴 AI **服务层**里不许出现 move —— 它连 mover 都 import 不到', () => {
      const svc = read('src/services/ai/index.ts');
      ok(!/from '\.\.\/mover'/.test(svc), 'services/ai 不许 import mover（类型上就办不到"自己动库"）');
      ok(!/\.move\(/.test(svc), 'services/ai 里不许出现 .move(');
      ok(!/TFile.*create|vault\.process/.test(svc), 'services/ai 不许写盘');
    });

    /**
     * 🔴 **`buildAiPlan` 必须真的调那道闸**。
     * 只断言"有个 `isAiProtected` 函数"是不够的 —— 本项目栽过"函数写好了但没有调用方"
     * （P3 的 `tagDirs()` 就是）。所以判据认**调用形态**（带括号），注释里写不出这个形态。
     */
    await suite.it('🔴 `isAiProtected` 真的被 `buildAiPlan` 调用（不只是存在）', () => {
      const plan = read('src/services/ai/plan.ts');
      ok(/export function isAiProtected\(/.test(plan), '那道闸在');
      ok(/isAiProtected\(/.test(plan.replace(/export function isAiProtected\([\s\S]*?\n}/, '')), '它在 buildAiPlan 里被真的调到（带括号的调用形态）');
      ok(/code:\s*'protected'/.test(plan), '拦下时打的是 protected 这个原因码');
      ok(/aiDir/.test(plan), '闸门的取值来自 aiDir（用户改过元数据目录名之后这道闸仍然有效）');
    });

    /** 边界 ④ 的接线：`source === 'ai'` 必须落到日志的 `ai` 字段上 */
    await suite.it('④ 留痕接线：mover 按 `req.source === \'ai\'` 给日志打 ai 标记', () => {
      const mover = read('src/services/mover.ts');
      ok(/ai:\s*req\.source\s*===\s*'ai'/.test(mover), '日志那条接线在');
      const hits = mover.match(/ai:\s*req\.source\s*===\s*'ai'/g) ?? [];
      ok(hits.length >= 2, `成功那条与中止那条都要标（实际 ${hits.length} 处）`);
    });

    /**
     * §14.4 的写盘口径（**P7.14 起开一个例外**）。
     *
     * 原契约（P7.9）：向导"全程无动作口"，一个字都不写盘。P7.14（用户 2026-10-08 拍板）
     * **方向反转一处**：「新建」分支要**真的把文件夹建出来**（此前只写设置，用户得自己
     * 去 Obsidian 文件列表手建）—— 走 `ui/new-folder.ts` 的 `createEmptyFolder`
     *（轻量族：不过 confirm / 不进快照，先例 = 笔记模块「新建文件夹」，理由在那个文件头）。
     *
     * 所以这条断言从"全禁"改成"**唯一出口**"：黑名单照旧一个都别碰（写盘 API 只许出现在
     * `createEmptyFolder` 里），另加**正向断言**钉住"向导确实接的是那个共享口"——
     * 只 import 不调用也是假的（P6② 的"纯函数有判据 ≠ 接线有判据"）。
     */
    await suite.it('向导写盘只开一个口：黑名单照旧 + 唯一出口 = createEmptyFolder（P7.14 方向反转）', () => {
      const wiz = read('src/ui/wizard.ts');
      for (const bad of ['renameFile', 'vault.create(', 'vault.delete(', 'adapter.mkdir', 'processFrontMatter', 'vault.process(']) {
        ok(!wiz.includes(bad), `ui/wizard.ts 不许出现 ${bad}（唯一的建目录口 = createEmptyFolder）`);
      }
      ok(
        /import\s*\{[^}]*createEmptyFolder[^}]*\}\s*from\s*'\.\/new-folder'/.test(wiz),
        '「新建」真建目录必须走共享口 `ui/new-folder.ts` 的 `createEmptyFolder`',
      );
      ok(/createEmptyFolder\(/.test(wiz), '……而且真的接了线（只 import 不调用 = 假绿）');
      ok(/shouldShowWizard/.test(read('src/main.ts')), '自动弹的判据走那个纯函数（别在 main 里另写一套）');
    });

    /**
     * 🔴 **P7.14 新红线：禁手拼 `${…kbRoot…}/`**（"整个库"模式的安全底座）。
     *
     * 背景：`kbRoot=''`（整个库，= vault 根）是合法配置（`normalizeSettings` 有显式
     * case 收它）—— 手拼前缀在空串下有两副面孔，两副都是静默坏：
     *   · `` `${kbRoot}/x` `` → `/x`（前导斜杠：喂 `index.get()` / 平台 API 必 miss）；
     *   · `path.startsWith(`${kbRoot}/`)` → 恒 false（扫描 / 候选整片空掉）。
     * 全项目 20+ 处曾是这个形态（P7.14 一趟清掉）—— 相对↔绝对换算**只走四个既有函数**：
     * `joinPath` / `isInside` / `relativeTo` / `parentDir`（`core/paths.ts`；四者对 `''`
     * 根全部正确）。范围谓词另走 `inKbScope`。
     *
     * 扫描形态：src 下所有 .ts 文件，**先把注释按行数对位地抹掉**（块注释换成等量换行 +
     * 等量空格 —— 行号不许漂，报错要指得准），再逐行查两个形态：
     *  ① `${…kbRoot…}` 后跟 `/`；② `startsWith(` 的模板串里出现 `${…kbRoot…}`。
     * **白名单初始为空**，例外必须写进白名单并附理由。突变：还原任一站点即红。
     */
    await suite.it('禁手拼 `${…kbRoot…}/`：库内路径换算只能过 joinPath / isInside / relativeTo', () => {
      /** 抹注释但**保住行数**（块注释 → 等量空行；行注释 → 去掉尾巴） */
      const blanked = (src: string): string =>
        src
          .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const hits: string[] = [];
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
          const rel = `${dir}/${e.name}`;
          if (e.isDirectory()) {
            walk(rel);
            continue;
          }
          if (!rel.endsWith('.ts')) continue;
          const lines = blanked(fs.readFileSync(path.join(root, rel), 'utf8')).split('\n');
          lines.forEach((line, i) => {
            if (/\$\{[^}]*\bkbRoot\b[^}]*\}\s*\//.test(line)) hits.push(`${rel}:${i + 1}`);
            else if (/startsWith\(`[^`]*\$\{[^}]*\bkbRoot\b/.test(line)) hits.push(`${rel}:${i + 1}`);
            else if (/\bkbRoot\b\s*\+\s*'\/'/.test(line)) hits.push(`${rel}:${i + 1}`);
          });
        }
      };
      walk('src');
      ok(
        hits.length === 0,
        '这些地方在拼 kbRoot 前缀（空串根=整个库下会静默坏；改走 joinPath / isInside / relativeTo / inKbScope）：' +
          hits.slice(0, 8).join(' · '),
      );
    });

    /**
     * 🔴 **P7.9 · ① 有意识地改契约（方向反转）**：原第 3 步「现场检测」整屏退役
     *（库里缺什么，首页「待处理」里都有）→ 「去建」这个**向导唯一动作口随之退休**
     *（骨架 / 补全入口在首页「待处理」与各自面板）。
     *
     * 契约从"「去建」必须转开 openRebuildPanel"翻成"**向导没有任何动库通道**"：
     * 不许调 `openRebuildPanel`（老动作口）、不许 `configs.ensure`（"不存在就写盘"，
     * 老病根再钉一遍）、也不许把检测屏那份 `planBackfillOf` 扫描复活回来。
     * 理由与先例：`期末交接-P7.9.md`（照 P7.1 删视图档"有意识改契约"的处理）。
     */
    await suite.it('向导不再有动作口：不许 openRebuildPanel / configs.ensure（P7.17 起开一个"询问卡"口）', () => {
      const wiz = read('src/ui/wizard.ts');
      ok(!/openRebuildPanel\(/.test(wiz), '「去建」随检测屏退役 —— 向导不许再转开重排面板');
      ok(!/configs\.ensure\(/.test(wiz), '不许出现 configs.ensure( —— 它是"不存在就把默认值写下去"');
      /**
       * ⚠️ **P7.17 有意识地改的契约**（用户第 1 条 · `P7.17开工提示词.md`）：屏 2 勾开
       * 「笔记自动化」的询问卡带「去补全」——**用户显式点的那一下**才开补全面板，N 走
       * `planTodoCount(await planBackfillOf(ctx))` 现算。旧的"向导里连 `planBackfillOf`
       * 都不许出现"钉的是 P7.9 的"检测屏退役"（那份扫描是自动回挂的）——性质不同：
       * 现在的扫描是**卡片自己发起、给卡片报数**，且写盘仍全在面板的确认流里。
       * 下面两条把它**钉住**（只许这一个口，不许它长成第二个动作口）。
       */
      ok(/planBackfillOf\(/.test(wiz), '★ 询问卡的 N = planBackfillOf 现算（唯一允许的"扫描"）');
      ok(/openBackfillPanel\(/.test(wiz), '★ 「去补全」接补全面板（唯一允许的"动作口"，且要用户点）');
      ok(!/openMigratePanel\(|openRebuildPanel\(|openSnapshotPanel\(/.test(wiz), '其余动库面板一个都不许进来');
    });

    /**
     * **P7.9 · ② 的写盘面收窄**：`ui/new-note.ts` 新增了「＋ 新建模板…」这条路 ——
     * 它走 `vault.create`（**新建**，不覆盖；与设置栏「新建空白模板」同一先例、
     * `uniqueTemplatePath` 也是两边共用），但**别的一切写盘 API 都不许进来**
     *（移动 / 删除 / 改前言都是别人的活：mover / fm）。
     */
    await suite.it('新建笔记对话框：写盘只许 vault.create（新建模板），其余写盘 API 一个都不许', () => {
      const nn = read('src/ui/new-note.ts');
      ok(/vault\.create\(/.test(nn), '「＋ 新建模板…」的落盘口在（vault.create）');
      for (const bad of ['renameFile', 'vault.delete(', 'vault.process(', 'processFrontMatter', 'adapter.mkdir', 'trashFile']) {
        ok(!nn.includes(bad), `ui/new-note.ts 不许出现 ${bad}（新建之外都走 mover / fm）`);
      }
    });

    /**
     * 🔴 **P7.2b 有意识地改的契约**：帮助栏从"一个字都不许写盘"收窄成
     * **"不许出现直接写盘 API"** —— 教程的「导出为笔记」必须走 `ui/new-note.ts`
     * 的对话框那条**既有链路**（用户自己选名字与落点、completion 落盘、通知如实报落点）。
     * ⚠️ 原来那句承诺只写在 `help.ts` 的注释里（还写着"判据在 redline.ts"——
     * 其实全仓没有这条，属"文档说修了、代码没修"的反向版本）——本段把那枚真判据补上。
     */
    await suite.it('帮助栏：不许直接写盘 API；「导出为笔记」必须走 openNewNoteDialog', () => {
      const help = read('src/ui/settings/help.ts');
      for (const bad of ['vault.create(', 'vault.delete(', 'adapter.mkdir', 'processFrontMatter', 'vault.process(', 'renameFile']) {
        ok(!help.includes(bad), `ui/settings/help.ts 不许出现 ${bad}（导出走 openNewNoteDialog，别绕过通道）`);
      }
      ok(/openNewNoteDialog\(/.test(help), '「导出为笔记」必须调用 openNewNoteDialog（带括号的调用形态）');
    });

    /** 两个新样式表必须登记（没登记会被 `styles.mjs` 静默丢掉 → 真机没样式、离线全绿） */
    await suite.it('新增的样式表登记进 STYLE_ORDER', () => {
      const order = fs.readFileSync(path.join(root, 'scripts/styles.mjs'), 'utf8');
      ok(/ai\.css/.test(order), 'styles/ai.css 登记了');
      ok(/wizard\.css/.test(order), 'styles/wizard.css 登记了');
      ok(fs.existsSync(path.join(root, 'styles/ai.css')), 'styles/ai.css 在');
      ok(fs.existsSync(path.join(root, 'styles/wizard.css')), 'styles/wizard.css 在');
      /** 模态头那个新容器**必须有自己的规则**（P6③ 的 `.kbw-panel-actions` 教训） */
      const panel = read('styles/panel.css');
      ok(/\.kbw-modal-actions\s*\{/.test(panel), '`.kbw-modal-actions` 要有样式规则（建了容器不写规则 = 内容被挤成竖排）');
    });

    /**
     * **P7.2b：向导配图五张成品真的在**。它们是**随插件发布**的资产（deploy 与分享包各拷一份）——
     * 少了任何一张，真机上的向导会走"加载失败就隐藏"那条路（不报错、只是没图，
     * 正是本项目最怕的"静默少了一块"）。所以在这儿把文件存在性钉住。
     * ⚠️ 重拍流程在 `素材/向导配图-P7.2/README.md`（改界面后要重拍，别手改 PNG）。
     */
    await suite.it('向导配图：assets/wizard/ 五张成品都在', () => {
      for (const f of ['01-native.png', '02-home.png', '03-tree.png', '04-graph.png', '05-rebuild.png']) {
        ok(fs.existsSync(path.join(root, 'assets', 'wizard', f)), `assets/wizard/${f} 在`);
      }
    });

    /**
     * 🔴 **独立审 2026-10-03 抓到的真回归**：命名模板那组样式（P7.2b）原先裸写 `.kbw-name` ——
     * 撞上了「全部笔记 · 详细信息」名称列的**同名类**（`styles/notes.css` 的
     * `.kbw-table .kbw-name{text-overflow:ellipsis}`）：`display:flex` 把文本变成匿名 flex 项，
     * 省略号**静默失效**、行内徽标被 `flex:1 1 auto` 挤到格右端。离线四层判据全看不见
     *（jsdom 不加载 CSS），只有真机肉眼可见 —— 所以在这儿钉一条静态的。
     */
    await suite.it('命名模板样式收进 .kbw-set-main 作用域（settings.css 不许裸写 .kbw-name）', () => {
      const css = read('styles/settings.css');
      ok(
        !/(^|\n)\.kbw-name\b/.test(css),
        '裸 .kbw-name 会撞上 notes.css 的名称列（display:flex 让 text-overflow:ellipsis 失效）',
      );
      ok(/\.kbw-set-main \.kbw-name\s*\{/.test(css), '作用域版在（`.kbw-set-main .kbw-name`）');
    });
  });

  await suite.group('P6 第八段 · 红线（底栏看得见 / 面板清单不漏）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

    /**
     * ⑧-A 的**结构性那一半**：离线只判得出"底栏不带内联 display:none"，
     * "真的画出来了"靠 `:empty` 那条规则 —— 所以规则本身必须钉住。
     * 🔴 这两条极容易被"顺手清理未使用的 CSS"删掉，而删掉之后**所有离线判据照绿**
     *（内联已经不写了、computed 又只有真机才量）= 静默回到"六个面板没按钮"。
     */
    await suite.it('底栏"空的不占位"那条规则在（⑧-A 的另一半）', () => {
      const css = read('styles/panel.css');
      ok(
        /\.kbw-modal-foot:empty\s*,\s*\.kbw-panel-foot:empty\s*\{[^}]*display:\s*none/.test(css),
        '`.kbw-modal-foot:empty, .kbw-panel-foot:empty { display:none }` 要在（空底栏不占位）',
      );
      // 反证：内联那一句不许回来（回来了就又变成"谁 append 谁记得解开"）
      // ⚠️ **先剥注释再判**（P6③ 的教训，本轮当场又栽了一次）：panel.ts 里那段
      //    解释"原先有一句 foot.style.display = 'none'"的注释，会被裸正则当成真的代码
      const panel = read('src/ui/panel.ts')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      ok(!/foot\.style\.display\s*=\s*'none'/.test(panel), 'panel.ts 不许再给底栏打内联 display:none');
      ok(
        !/kbw-(modal|panel)-foot'[^)]*display:\s*'none'/.test(panel),
        '浮层底栏也不许带内联 display:none（同一条纪律）',
      );
    });

    /**
     * **遍历断言的清单不许漏**：凡是在底栏里 append 过东西的 `openModal` 面板，
     * 都要在 `tests/specs/panels.ts` 的 `FOOT_CASES` 里。
     *
     * 为什么要静态反查：那张表是**手写**的，新加一个面板没人会记得补 ——
     * 而漏掉的表现正是这一轮用户遇到的那条（"按钮点得到、看不见"）。
     * 规矩与"某个脚本必须调用某个判据"同一条：**把源码读出来断言**，别靠人记。
     */
    await suite.it('底栏遍历表没漏面板（从 src 源码反查 FOOT_CASES）', () => {
      /**
       * 判据用**"谁调了 `openModal`"**，不是"谁往 foot 里 append 了东西"。
       *
       * 🔴 后一种写法本轮当场假红一次：`settings-panel.ts` 里有个**同名局部变量**
       * `foot`（那是左栏底部的 `.kbw-set-railfoot`，跟模态底栏毫无关系）——
       * 按"有没有 foot.appendChild"扫会把它当面板收进来。
       * 而"调了 openModal"是个**没有歧义**的事实，也不依赖谁给变量起了什么名字。
       *
       * 🔴 **两处都是被独立审查 B 打回来的**（不是预防性写法）：
       * ① **要递归**：第一版只 `readdirSync('src/ui')` —— 往 `src/ui/settings/` 里塞一个
       *    新模态**照样绿**（那个目录已经有 11 个文件）。现在走 `tsFilesUnder()`。
       * ② **要按调用点计数**，不能只按文件去重：`ui/prompt.ts` 里有**两个** `openModal`
       * 调用点（`promptText` 与 `pickOne`），而表里只有一行 —— `pickOne` 的底栏
       * 从来没被遍历过。所以判据改成"**源码里 `openModal(` 的出现次数 == FOOT_CASES 的行数**"，
       * 多一个调用点就必须多一行。
       */
      const srcFiles = tsFilesUnder(path.join(root, 'src')).filter(
        (f) => path.relative(root, f).split(path.sep).join('/') !== 'src/ui/panel.ts',
      );
      const calls: { file: string; n: number }[] = [];
      for (const f of srcFiles) {
        const n = (fs.readFileSync(f, 'utf8').match(/openModal\(/g) ?? []).length;
        if (n > 0) calls.push({ file: path.basename(f).replace(/\.ts$/, ''), n });
      }
      const totalCalls = calls.reduce((a, c) => a + c.n, 0);
      const offenders = calls.map((c) => c.file).sort();
      ok(
        totalCalls >= 14,
        `该扫到 14 个调用点（实际 ${totalCalls}：${calls.map((c) => c.file + '×' + c.n).join(', ')}）`,
      );
      const spec = read('tests/specs/panels.ts');
      // 表是"被用起来的"才算数：只写常量不遍历 = 装饰
      ok(/for \(const c of FOOT_CASES\)/.test(spec), 'panels.ts 要真的遍历 FOOT_CASES（别只声明不用）');
      const listed = (spec.match(/file:\s*'([a-z0-9-]+)'/g) ?? []).map(
        (m) => /'([a-z0-9-]+)'/.exec(m)?.[1] ?? '',
      );
      eq(
        listed.length,
        totalCalls,
        `FOOT_CASES 的行数要和源码里的调用点数**逐个对上**（表 ${listed.length} 条 vs 调用点 ${totalCalls} 个）`,
      );
      const missing = offenders.filter((f) => !listed.includes(f));
      eq(
        missing.join(', '),
        '',
        `这些模态没进 FOOT_CASES：${missing.join(', ')} —— 补一行，别让它的按钮再整片不见`,
      );
    });

    /**
     * ⑧-C 的「说明默认收起」的**另一半**（离线看不见 CSS）；**P7.5 · 8.3 拆类名后重写**。
     *
     * 🔴 P7.5 之前这里是"收起规则必须**收窄到 `.kbw-set-label` 里**"—— 因为
     * `.kbw-set-hint` 被状态行复用（「已同步 / 有未保存的改动」·「统计中…」），
     * 裸规则会把反馈一起藏掉。8.3 把状态行拆到 `.kbw-set-status`（`kit.ts` 的
     * `statusLine()`）之后这条限制反过来：**全量 `.kbw-set-hint` 默认收起**
     *（它现在纯粹是"解释"，含原先永远显示的那几处独立说明），
     * **`.kbw-set-status` 从不隐藏**（它是"反馈"）。三条同判，缺一不可。
     */
    await suite.it('设置面板：说明全量收起 / 展开规则在 / 状态行从不隐藏（P7.5 · 8.3 新口径）', () => {
      const css = read('styles/settings.css');
      /**
       * ⚠️ **按规则解析，不按文本抓**（独立审查 B🟡5）：
       * 第一版用"裸选择器在行首"这种文本判据 —— 把两条并成一行
       *（`.kbw-set-row .kbw-set-hint, .kbw-set-hint { display:none }`）就能骗过去。
       * 现在把 CSS 拆成"选择器表 + 声明块"，再逐条比选择器。
       */
      const rules = cssRules(css);
      const hideRules = rules.filter((r) => /display:\s*none/.test(r.body));
      const coversAllHints = hideRules.some((r) =>
        r.sel
          .split(',')
          .map((x) => x.trim())
          .includes('.kbw-set-hint'),
      );
      ok(
        coversAllHints,
        '要有一条裸的 `.kbw-set-hint { display:none }`（P7.5 起"解释"整体默认收起）',
      );
      eq(
        rules.filter((r) => r.sel === '.kbw-set-shell.is-showsub .kbw-set-hint').length,
        1,
        '顶上那枚「显示说明」摊开的规则（`.kbw-set-shell.is-showsub .kbw-set-hint`）要在',
      );
      /**
       * 🔴 **状态行从不隐藏**（这条是 8.3 拆类名的目的本身）：它们被藏掉时
       * 用户看到的是"点了没反应"—— 而且没有任何离线 DOM 判据看得见（CSS 的事）。
       *
       * ⚠️ **两处加宽**（独立审 2026-10-04 🟡）：① 判"选择器**包含**这个类"而不是逐字相等
       * —— 后代写法（`.kbw-set-main .kbw-set-status { display:none }`）是第一版漏检的形态；
       * ② 扫 **`styles/` 全部 `.css`**（不只 settings.css）—— 藏它的规则放哪个文件都算。
       */
      const hidingStatus: string[] = [];
      for (const f of fs.readdirSync(path.join(root, 'styles'))) {
        if (!f.endsWith('.css')) continue;
        for (const r of cssRules(read(`styles/${f}`))) {
          if (!/display:\s*none/.test(r.body)) continue;
          if (/\.kbw-set-status\b/.test(r.sel)) hidingStatus.push(`${f}: ${r.sel}`);
        }
      }
      eq(
        hidingStatus.join(' | '),
        '',
        '🔴 `.kbw-set-status` 绝不许被 display:none（后代写法也算 —— 它是"点了之后有没有生效"的唯一说明）',
      );
    });

    /**
     * 🔴 **`.kbw-set-hint` 的字面量只许出现在 kit.ts**（P7.5 · 8.3 拆分到位的证）。
     *
     * 8.3 之前这个类被状态行与四处独立说明各拼一遍；拆完由 kit 的工厂
     *（`row()` / `readRow()`）统一产出，连"读法"（`HINT_SEL`）也只有一份。
     * 判据**剥注释**（kit 与 CSS 的注释里解释这段历史、必然提到类名本身）。
     */
    await suite.it('设置面板类名字面量唯一出处：`kbw-set-hint` 只在 kit.ts（剥注释）', () => {
      const strip = (src: string): string =>
        src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const offenders: string[] = [];
      for (const f of tsFilesUnder(path.join(root, 'src'))) {
        const norm = f.split(path.sep).join('/');
        if (norm.endsWith('/ui/settings/kit.ts')) continue;
        if (strip(fs.readFileSync(f, 'utf8')).includes('kbw-set-hint')) {
          offenders.push(norm.slice(norm.indexOf('/src/') + 1));
        }
      }
      eq(
        offenders.join(', '),
        '',
        '🔴 除了 kit.ts，谁都不许再拼 `kbw-set-hint`（要画说明行就调 kit 的工厂）',
      );
    });

    /**
     * 🔴 **底栏不许有"藏起来"的 CSS 规则**（`:empty` 那一条除外）。
     *
     * 独立审查 B🔴1 实测：给空底栏加一条 `.kbw-modal-foot.is-hidden{display:none}`
     * 并在 `openModal` 里 `classList.add('is-hidden')` —— **四条离线判据全绿**
     *（它们只认内联样式），而真机上那一栏就是没了、用户原症状原样回来。
     * 这一条把"能藏底栏的规则"钉死在源码里。
     */
    await suite.it('底栏不许有"藏起来"的 CSS 规则（除了 :empty 那一条）', () => {
      const bad: string[] = [];
      for (const f of fs.readdirSync(path.join(root, 'styles'))) {
        if (!f.endsWith('.css')) continue;
        for (const r of cssRules(read(`styles/${f}`))) {
          if (!/kbw-(modal|panel)-foot/.test(r.sel)) continue;
          if (/display:\s*none/.test(r.body)) bad.push(`${f}: ${r.sel}`);
        }
      }
      eq(
        bad.join(' | '),
        'panel.css: .kbw-modal-foot:empty, .kbw-panel-foot:empty',
        '底栏"藏起来"只许靠 :empty 那一条（别的写法真机上就是按钮没了）',
      );
    });
  });

  /**
   * ────────────────────────────────────────────────────────────
   * P7.0a · 批 1 的接线红线（都是"看着多余、顺手删了就坏"的高危点）
   *
   * 真机侧有 ①③⑤⑪ 的 computed 判据；这里钉的是**离线也能查**的源码形态 ——
   * 两边各守一半：形态在 + 真机量到效果。
   * ────────────────────────────────────────────────────────────
   */
  await suite.group('P7.0a · 批 1 的接线（静态）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    /** 剥 TS 注释再数 —— 注释里写一句 quiet: true 会把计数骗过去（本项目栽过的形态） */
    const stripTs = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read = (rel: string): string =>
      stripTs(fs.readFileSync(path.join(root, rel), 'utf8'));
    const rawRead = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

    await suite.it('⑦ quiet 接线：**凡是弹撤销条的 mover.move 都传了 quiet**（删一处，顶部通知就重复回来）', () => {
      /**
       * 期望值是**显式数字**：调用数一变（有人加了新入口）就红，回来看这里该不该跟着改。
       * ⚠️ 两个**有意的例外**（都不弹撤销条 → 通知要留，别为了对称把它们也静默了）：
       *  · `main.ts` 的第 2 条是自动归位（`source: 'reconcile'`）；
       *  · 看板的两处就地改名（`board/editor.ts` / `board/index.ts`）不弹撤销条，
       *    走的是内联回执 `setReceipt` —— 它们**不在本表里**（表只登记"弹条方"）。
       * ⚠️ 正则要容忍链式换行写法（`this.ctx.mover\n  .move(`）—— 独立审查指出第一版
       * 用 `mover\.move\(` 会把这种形态**安静地漏掉**（`board/index.ts` 就是这么写的）。
       */
      const cases: [string, number, number][] = [
        ['src/modules/notes/ops.ts', 2, 2], // rename + moveNow，都走 undoForMove
        ['src/main.ts', 2, 1], // 编辑器菜单归位（静）+ 自动归位（不静）
        ['src/ui/ai-tools.ts', 2, 2], // AI 执行（P7.3b 起执行体搬来这儿）· P7.22a 加 rename 段（同样弹撤销条 → 同样 quiet）
        ['src/services/rebuild.ts', 1, 1], // 重排 / 一键整理收件箱（两条下游都弹撤销条）
        ['src/ui/suggest-panel.ts', 1, 1], // 整理建议面板（P7.6：自己弹 showUndo）
      ];
      const moveRe = /mover\s*\.\s*move\(/g;
      /**
       * **quiet 数只数 `mover.move` 调用实参里的**（P7.2d 修正）。
       *
       * 原先全文裸数 `/quiet:\s*true/g` —— P7.2d 给 main.ts 的「最近改动→小窗」桥加了
       * `openCardWindow(..., { quiet: true })`（那是**卡片窗回执**的静音，与撤销条无关），
       * 裸数当场把这条判据撞红。判据的**本意**是"每处弹条方的 mover.move 有没有传 quiet"，
       * 所以改成**括弧配对圈出实参**再找 quiet（`rebuild.ts` 的参数隔着一大段代码，
       * 固定窗口要么误伤要么够不着）—— 本意不变，链式换行照旧能匹配。
       */
      const callSpan = (src: string, openIdx: number): string => {
        let depth = 0;
        for (let i = openIdx; i < src.length; i += 1) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')') {
            depth -= 1;
            if (depth === 0) return src.slice(openIdx, i + 1);
          }
        }
        return src.slice(openIdx);
      };
      const quietAfterMove = (src: string): number => {
        let n = 0;
        moveRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = moveRe.exec(src)) !== null) {
          const span = callSpan(src, m.index + m[0].length - 1); // m[0] 以 '(' 收尾
          if (/quiet:\s*true/.test(span)) n += 1;
        }
        return n;
      };
      for (const [f, wantMoves, wantQuiet] of cases) {
        const src = read(f);
        eq((src.match(moveRe) ?? []).length, wantMoves, `${f}：mover.move 调用数`);
        eq(quietAfterMove(src), wantQuiet, `${f}：mover.move 处传 quiet 的数`);
      }
    });

    await suite.it('③ 平台标题栏：视图贴类 + 样式藏 header，两半都在（缺一半就停旧名）', () => {
      const view = read('src/view/workbench-view.ts');
      ok(/classList\.add\('kbw-workbench-leaf'\)/.test(view), 'onOpen 贴锚点类');
      ok(/classList\.remove\('kbw-workbench-leaf'\)/.test(view), 'onClose 摘掉（别把类留给下一个实例）');
      const shell = read('styles/shell.css');
      ok(
        /\.kbw-workbench-leaf\s+\.view-header\s*\{[^}]*display:\s*none/.test(shell),
        '样式里藏掉 .view-header',
      );
    });

    await suite.it('①②⑤⑪ 的四条样式形态（都是"看着多余、删了就坏"的那种）', () => {
      const rules = (rel: string): { sel: string; body: string }[] => cssRules(rawRead(rel));
      const board = rules('styles/board.css');
      ok(
        board.some((r) => r.sel === '.kbw-cw-leaf' && /--metadata-display-editing:\s*none/.test(r.body)),
        '① 变量覆盖在（删了 → 面板顶上又冒空壳；权重路线实测压不过——平台那条叠到 5 个类，别改回去）',
      );
      ok(
        board.some(
          (r) => r.sel.includes('.kbw-cards.has-h .kbw-card-body') && /mask-image/.test(r.body),
        ),
        '⑪ 固定高度档正文的底缘 mask 在',
      );
      const notes = rules('styles/notes.css');
      ok(
        notes.some((r) => r.sel === '.kbw-seg' && /flex:\s*none/.test(r.body)),
        '⑤ seg flex:none 在（触屏档不再把「网格」裁一半）',
      );
      /**
       * ② 网格名裁切（P7.0a 批 1 上 break-all；**P7.1b 批 2 换完整版** —— 原注释写
       * 「批 2 若换 clamp，这条跟着改」，现在跟改）：三层一起钉 ——
       *  · `-webkit-line-clamp: 2` + `display: -webkit-box`：两行 + **真省略号**；
       *  · `word-break: break-all`：长串在哪儿断（**保留** —— 没有它，无空格长串
       *    横向溢出被切，省略号落不到行尾；分工见 `styles/notes.css` 那段注释）；
       *  · `max-height` **不许回来**：那是批 1 的"先止血"写法（硬裁无省略号），
       *    留着就是两套裁切制度并存。
       */
      ok(
        notes.some(
          (r) =>
            r.sel === '.kbw-gname' &&
            /-webkit-line-clamp:\s*2/.test(r.body) &&
            /display\s*:\s*-webkit-box/i.test(r.body) &&
            /word-break:\s*break-all/.test(r.body) &&
            !/max-height/.test(r.body),
        ),
        '② 网格名 = line-clamp 两行（真省略号）+ break-all 长串断点；批 1 的 max-height 已撤（P7.1b 完整版）',
      );
    });
  });

  /**
   * ────────────────────────────────────────────────────────────
   * P7.0b · 工程小件（17.1 设置迁移的接线 / 17.5 版本同步 / 14.8a goNotes 守卫）
   *
   * 这一组的**共同点**：都是"在 JS 层看不出差别、只有读源码才拦得住"的那种约定 ——
   * 本轮没有任何真实迁移规则、版本号一年也不会动一次、守卫只在传错参数时才响。
   * ────────────────────────────────────────────────────────────
   */
  await suite.group('P7.0b · 工程小件（静态）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    /** 剥 TS 注释再判 —— 注释里写一句解释就能把"源码里有这个词"的断言骗过去（本项目栽过几次） */
    const stripTs = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const rawRead = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

    /**
     * 🔴 P6② 的教训原话："纯函数有判据 ≠ 接线有判据" ——
     * 把 `load()` 里那次 `migrateSettings(` 删掉，纯函数用例照样全绿
     *（本轮还没有任何真实迁移规则，删了在 JS 层看不出差别），
     * 而后果是 **P7.1 删『名称+时间』档时存量 `notesView` 一个都迁不动**。
     * 这里钉三件事：① 读盘入口调了它（顺序也不能反）；② 写入口不许调；③ 默认值必须是 0。
     */
    await suite.it('17.1 设置迁移只挂读盘入口（`load()` 必须调 `migrateSettings`；写入口不许碰）', () => {
      const src = stripTs(rawRead('src/core/settings.ts'));
      const load = src.slice(src.indexOf('async load('), src.indexOf('save(patch'));
      ok(
        /normalizeSettings\(migrateSettings\(raw\)\)/.test(load),
        '读了盘就要迁移：`this.current = normalizeSettings(migrateSettings(raw))`（先迁移原始 JSON、再补默认）',
      );
      const save = src.slice(src.indexOf('save(patch'), src.indexOf('onChange('));
      ok(!/migrateSettings\(/.test(save), '写入口（`save()`）不许迁移 —— 那会把用户刚选的值当场改掉（"选了等于没选"）');
      /**
       * 反向自证：切片真的切到东西了 —— 两个 `indexOf` 要是都返回 -1，
       * 上面两条会**双双空过**（"恒真"的另一种形态）。用两段里各自必然出现的写法兜底。
       */
      ok(
        load.includes('this.current =') && save.includes('saveData'),
        '切片自证：两段都切到了真代码（索引没命中就会切出空串 → 上面两条等于没判）',
      );
      /**
       * 🔴 `DEFAULT_SETTINGS.settingsVersion` **故意是 0**（"没迁移过"）：
       * 写成 `SETTINGS_VERSION` 的话，"load 里没调迁移"在内存里照样是 1（默认值顶的）
       * —— `tests/specs/settings.ts` 那条接线判据当场变成**假绿**。
       */
      ok(
        /settingsVersion:\s*0\b/.test(src),
        'DEFAULT_SETTINGS.settingsVersion 必须是 0（= 没迁移过）；改成 SETTINGS_VERSION 会让接线判据假绿',
      );
    });

    /**
     * 🔴 **`allowWrite` 退役不许复活**（P7.5 · 8.1 体检拍板退役）。
     *
     * 它现在只有一处合法残留：`core/settings.ts` 的 `migrateSettings` v4→v5 段
     *（引用这个名字把存量键删掉 / 映射成逐类）。别的任何 src 文件再出现它 =
     * 有人把"没设过的类别跟随旧开关"那层旧口径加回来了 —— 那正是本轮拆掉的双真源。
     */
    await suite.it('`allowWrite` 已退役：src 里只许出现在 core/settings.ts（迁移段）', () => {
      const offenders: string[] = [];
      for (const f of tsFilesUnder(path.join(root, 'src'))) {
        const norm = f.split(path.sep).join('/');
        if (norm.endsWith('/src/core/settings.ts')) continue;
        if (/\ballowWrite\b/.test(stripTs(fs.readFileSync(f, 'utf8')))) {
          offenders.push(norm.slice(norm.indexOf('/src/') + 1));
        }
      }
      eq(offenders.join(', '), '', '🔴 退役的旧开关不许复活（要放宽权限走逐类 toolTiers）');
      /**
       * 反向自证：迁移段本体（映射 + 删键两句）真在 settings.ts 里 ——
       * 全都删光时上面那条"只许出现在这里"会**恒真**（没有谁再包含它）。
       */
      const core = stripTs(rawRead('src/core/settings.ts'));
      ok(
        /a\.allowWrite === true/.test(core) && /delete a\.allowWrite/.test(core),
        'v4→v5 迁移段本体要在（`a.allowWrite === true` 映射 + `delete a.allowWrite` 删键）',
      );
    });

    await suite.it('17.5 版本号：manifest.json === package.json（versions.json 的最低版本映射也对一眼）', () => {
      const manifest = JSON.parse(rawRead('manifest.json')) as { version: string; minAppVersion: string };
      const pkg = JSON.parse(rawRead('package.json')) as { version: string };
      const versions = JSON.parse(rawRead('versions.json')) as Record<string, string>;
      ok(/^\d+\.\d+\.\d+$/.test(manifest.version), `manifest 版本号该是 x.y.z（实际 ${manifest.version}）`);
      eq(manifest.version, pkg.version, 'manifest.json 与 package.json 的版本必须一致（发版时最容易漏的那一半）');
      eq(pkg.version, manifest.version, '反着再判一次 —— 别让"哪边在前"影响结论');
      ok(
        typeof manifest.minAppVersion === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.minAppVersion),
        'minAppVersion 要有值且成 x.y.z 形',
      );
      /**
       * `versions.json` 是 Obsidian 的"版本 → 最低宿主版本"映射。
       * **只报告不强制**：没发过版的版本号可以不在这里 —— 但真有条目就必须与 manifest 一致
       *（手写漏改一次，用户的旧版 Obsidian 会装上一个装不上的版本）。
       */
      const min = versions[manifest.version];
      if (min !== undefined) {
        eq(min, manifest.minAppVersion, `versions.json 里 ${manifest.version} 的最低宿主版本要与 manifest.minAppVersion 一致`);
      } else {
        ok(true, `versions.json 还没有 ${manifest.version} 这一条（发版时才需要 —— 只报告不强制）`);
      }
    });

    /**
     * 🔴 14.8a 的守卫必须在**产品侧**（不是"探针自己小心点"）：
     * 探针当初把树节点的**标签**（「整个知识库」）当目录传进 `goNotes`，
     * 结果整屏 0 项、看着像功能坏了 —— 静默是这里唯一的罪。
     */
    await suite.it('14.8a `goNotes` 的坏目录守卫在（产品侧 · 报出来 · 只丢 dir 那一个字段）', () => {
      const src = stripTs(rawRead('src/main.ts'));
      const fn = src.slice(src.indexOf('private goNotes('), src.indexOf('private goBoard('));
      ok(fn.length > 200, '切片自证：goNotes 的函数体真的切到了');
      ok(fn.includes('kbDirs()'), '判据要取**库目录清单**（kbDirsOf 那条口径）—— 别自己拼字符串判断');
      ok(/console\.warn\(/.test(fn), '要 `console.warn` 说出来（探针收 `[经纬]` 的 warn —— 别落进没人看的地方）');
      ok(/dir:\s*undefined/.test(fn), '只丢 dir 这**一个**字段（意图的其余条件照旧 —— 别把整条意图一起吞掉）');
      ok(fn.includes('不存在的目录'), '文案里要写清「不存在的目录」（探针那条判据认这几个字）');
    });

    await suite.it('17.5 三条打包链都要带上 `CHANGELOG.md`（收包的人靠它看更新）', () => {
      ok(
        /CHANGELOG\.md/.test(rawRead('scripts/make-share-pack.mjs')),
        '一键安装包（给人用的）要带更新日志',
      );
      ok(
        /CHANGELOG\.md/.test(rawRead('scripts/make-contest-pack.mjs')),
        '参赛提交包（给评委的）要带更新日志',
      );
      ok(
        /'CHANGELOG\.md'/.test(rawRead('scripts/make-public-pack.mjs')),
        '源码分享包要把 CHANGELOG.md 列进 DOCS（它是"有就带"那类，漏了不报错 → 只能静态钉）',
      );
    });

    await suite.it('打包脚本的「骨架正则」读得对：config-files.ts 第一处 `dirs` 就是 21 条完整骨架（P7.2b 审查 🔴1）', () => {
      /**
       * `make-share-pack.mjs` / `make-demo-vault.mjs` 都用 `/dirs:\s*\[([\s\S]*?)\]/`
       * 抓**全文件第一条** `dirs: [` —— 谁把任何含 `dirs: [` 的块挪到 `rebuildDefaults()`
       * **前面**（P7.2b 的 `BASIC_PRESET` 就这么干过），读到的就是"基础版 9 条"，
       * 两脚本当场 fail（而 `npm run check` 不含打包链 → 全靠这条静态钉先红）。
       */
      const src = rawRead('src/core/config-files.ts');
      const m = /dirs:\s*\[([\s\S]*?)\]/.exec(src);
      ok(m != null, '正则读得到 dirs 块（骨架形状没变）');
      const dirs = [...(m as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      eq(
        dirs.length,
        21,
        `第一处 dirs 必须是 21 条的完整骨架（实际 ${dirs.length} 条 —— 是不是有含 dirs 的块被挪到 rebuildDefaults 前面了？）`,
      );
      ok(
        dirs.includes('00_Inbox') && dirs.includes('02_Areas/生活健康'),
        '读到的确实是完整骨架（首条与一条深的都对得上）',
      );
    });

    await suite.it('14.8a 探针把 `[经纬]` 的 **warning** 也收（只收 error 的话这条警告等于没报）', () => {
      const probe = rawRead('scripts/probe.mjs');
      ok(/pluginWarns/.test(probe), '探针要有 warn 收集通道（P7.0b 起）');
      ok(/插件内部 warning/.test(probe), '收完要在汇总里点名报出来（收了不报 = 还是没人看）');
      ok(
        /p\.type === 'warning'/.test(probe) && /consoleWarns?\.push|pluginWarns\.push/.test(probe),
        'warning 分支要真的 push 进那个通道（否则通道是个空壳）',
      );
    });
  });

  /**
   * ────────────────────────────────────────────────────────────
   * P7.1 · 视图体系两档化（静态）
   *
   * 钉的是"**清扫干净了、不许悄悄长回来**"的几处痕迹 —— 每一处删掉/复活
   * 在 JS 层都看不出差别（类型、数组字面量、死样式、事件接线），
   * 只有把源码读出来断言才拦得住（P6② 那条老教训的又一次应用）。
   * ────────────────────────────────────────────────────────────
   */
  await suite.group('P7.1 · 视图两档化的清扫（静态）', async () => {
    const p71Root = path.resolve(__dirname, '..', '..');
    const stripTs71 = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const rawRead71 = (rel: string): string => fs.readFileSync(path.join(p71Root, rel), 'utf8');

    await suite.it('① 视图档类型只剩两档（`NotesView = detail | grid`）', () => {
      const src = stripTs71(rawRead71('src/core/settings.ts'));
      ok(
        /export type NotesView = 'detail' \| 'grid';/.test(src),
        'P7.1 起 NotesView 只有 detail | grid（compact 档已删 —— 想复活它要连迁移一起想清楚）',
      );
    });

    await suite.it('② seg 的档位数组只有 详细信息 + 网格（不许再有「紧凑」那一项）', () => {
      const src = stripTs71(rawRead71('src/modules/notes/index.ts'));
      const m = src.match(/const views: \[NotesView, string\]\[\] = \[([\s\S]*?)\];/);
      ok(m, '找得到 seg 的 views 数组（升级写法/改名了就要同步改这条断言）');
      const body = m?.[1] ?? '';
      ok(body.includes("'详细信息'") && body.includes("'网格'"), `两档都在（实际 ${body.replace(/\s+/g, ' ')}）`);
      ok(!body.includes('紧凑'), '「紧凑」档已删（P7.1 两档化删掉的那一档），别加回来');
    });

    await suite.it('③ 紧凑档的痕迹清干净（compactColumns 没了；样式表里没有 .kbw-tablewrap.is-compact）', () => {
      ok(
        !stripTs71(rawRead71('src/modules/notes/columns.ts')).includes('compactColumns'),
        'columns.ts 里没有 compactColumns（它的唯一调用方随档一起删了）',
      );
      ok(!/\.kbw-tablewrap\.is-compact/.test(rawRead71('styles/notes.css')), 'notes.css 里没有 .kbw-tablewrap.is-compact 死样式');
      ok(!/\.kbw-tablewrap\.is-compact/.test(rawRead71('styles/mobile.css')), 'mobile.css 里没有 .kbw-tablewrap.is-compact 死样式');
    });

    await suite.it('④ 表头右键接线在（table.ts 接住 contextmenu；notes 真的传了 onHeaderContextMenu）', () => {
      const table = stripTs71(rawRead71('src/ui/table.ts'));
      ok(/addEventListener\('contextmenu'/.test(table), 'table.ts 要把表头的 contextmenu 接住（preventDefault + 回调）');
      ok(/onHeaderContextMenu/.test(table), '钩子叫 onHeaderContextMenu（HeaderMenuInfo 那个契约）');
      const notes = stripTs71(rawRead71('src/modules/notes/index.ts'));
      ok(/onHeaderContextMenu:/.test(notes), 'notes 模块要真的把它传进 renderTable（漏了 = 表头右键菜单永远不出现）');
      ok(/showHeaderMenu\(evt,/.test(notes), '而且要接 showHeaderMenu（菜单本体在 menus.ts）');
    });

    await suite.it('⑤ 默认列清单本身对得上（注释里那句"离线断言钉住它"要有真东西）', () => {
      /**
       * `columns.ts` 的注释与合集 2.4 都写着"离线断言钉住它"，而全仓从没引用过
       * （独立审查 Y1 抓的口径不实）—— 这条把它变成真的。
       */
      ok(
        DEFAULT_VISIBLE_IDS.length === 6,
        `默认可见 6 列（v2：领域退役后从 7 收成 6），实际 ${DEFAULT_VISIBLE_IDS.length}：${DEFAULT_VISIBLE_IDS.join(',')}`,
      );
      ok(
        !(DEFAULT_VISIBLE_IDS as readonly string[]).includes('prop:领域'),
        '「领域」不该在默认可见里（v2 退役）',
      );
      ok(
        !DEFAULT_HIDDEN.includes('prop:领域') && !DEFAULT_HIDDEN.some((id) => ['prop:发布进度', 'prop:阶段', 'prop:平台'].includes(id)),
        '已删的专属字段列不该再进 DEFAULT_HIDDEN（列都不存在了）',
      );
    });
  });

  /**
   * P7.0c · **文档单一真源（14.4）**：`CLAUDE.md` 的「坑单索引」表与 `坑/` 目录互为镜像 ——
   * 一边防"索引点名的文件不存在"（悬空引用），另一边防"拆出个没人知道的新文件"（影子文件）；
   * 再加一条体量上限，防 `CLAUDE.md` 从 9 万字节瘦下来之后慢慢长回去（这是拆分唯一的目的）。
   */
  await suite.group('P7.2d · 首页卡片批（静态接线）', async () => {
    const rootP72d = path.resolve(__dirname, '..', '..');
    const rd = (rel: string): string => fs.readFileSync(path.join(rootP72d, rel), 'utf8');

    await suite.it('16.13 置位点接线：三处 created + 向导收尾一处 + notes 两处（删哪个都红）', () => {
      const qc = rd('src/ui/quick-capture.ts');
      eq(
        (qc.match(/recordOnboarding\(ctx, 'created'\)/g) ?? []).length,
        2,
        '快捕 + 剪藏两条成功路各记一次',
      );
      const nn = rd('src/ui/new-note.ts');
      eq((nn.match(/recordOnboarding\(ctx, 'created'\)/g) ?? []).length, 1, '新建对话框成功路记一次');
      const nt = rd('src/modules/notes/index.ts');
      eq(
        (nt.match(/recordOnboarding\(this\.ctx, '(search|view)'\)/g) ?? []).length,
        2,
        'notes：搜索输入 + 视图档切换各一处',
      );
      const wz = rd('src/ui/wizard.ts');
      ok(/onboardingWizardJustFinished\(ctx\)/.test(wz), '向导 finish(true) 要喊"向导收尾"（完成提示的最后一脚）');
    });

    await suite.it('图谱卡与图谱模块共用同一份挂载件（Q1 红线：不抄第二遍）', () => {
      const card = rd('src/modules/home/blocks/graphlink.ts');
      ok(/mountGraphInto\(/.test(card), '图谱卡要调共用件');
      ok(!/new LeafCtor|setViewState/.test(card), '不许自己造裸叶 / 自己 setViewState（那是抄第二遍）');
      const mod = rd('src/modules/graph/index.ts');
      ok(/export function mountGraphInto/.test(mod), '共用件从图谱模块导出');
    });

    await suite.it('内嵌窗的机制红线：不接停靠口子 / 名额不落它 / 把手验活（审 F2/F3）', () => {
      const ed = rd('src/modules/board/editor.ts');
      ok(/if \(p\.embedded\) return;/.test(ed), 'syncDock 要对内嵌窗整体早退');
      ok(/const dockPort = embed \? null :/.test(ed), '内嵌窗不认停靠口子');
      ok(/!next\.embedded/.test(ed), '停靠名额交接要跳过内嵌窗（审 F3）');
      ok(/isAlive\(\): boolean/.test(ed), '把手要有验活（审 F2）');
      const hc = rd('src/modules/home/blocks/homecards.ts');
      ok(/!w\.isAlive\(\)/.test(hc), 'paint 拿到把手先验活、死了重开（审 F2）');
    });
  });

  await suite.group('文档单一真源（14.4 · P7.0c）', async () => {
    const rootDocs = path.resolve(__dirname, '..', '..');
    const claude = fs.readFileSync(path.join(rootDocs, 'CLAUDE.md'), 'utf8');
    // 索引里点到名的 `坑/xxx.md` —— 只认"坑/"路径形态，防被别处的泛泛提及算进来
    const named = new Set<string>();
    for (const m of claude.matchAll(/坑\/([\p{L}\d_-]+\.md)/gu)) named.add(m[1]);
    const pitDir = path.join(rootDocs, '坑');
    const onDisk = new Set(fs.readdirSync(pitDir).filter((f) => f.endsWith('.md')));

    await suite.it('坑单索引：点名的坑文件都存在（防悬空引用）', () => {
      ok(named.size >= 7, `索引里至少要点到七个坑文件（实际 ${named.size} 个：${[...named].join(' ')}）`);
      for (const f of [...named].sort()) {
        ok(fs.existsSync(path.join(pitDir, f)), `CLAUDE.md 点名了坑/${f}，但文件不在（改名/挪走要回索引同步）`);
      }
    });

    await suite.it('坑单索引：坑/ 里每个 .md 都被索引登记（防影子文件）', () => {
      ok(onDisk.size >= 7, `坑/ 里至少该有七本（README + 六个域 + 单槽资源；实际 ${onDisk.size}）`);
      for (const f of [...onDisk].sort()) {
        ok(named.has(f), `坑/${f} 没在 CLAUDE.md 的坑单索引里登记（新拆一本就要回索引加一行）`);
      }
    });

    await suite.it('CLAUDE.md 体量上限（拆完不许慢慢长回去）', () => {
      const bytes = fs.statSync(path.join(rootDocs, 'CLAUDE.md')).size;
      ok(bytes <= 16 * 1024, `CLAUDE.md 已 ${bytes} 字节（上限 16KB）—— 新坑进 坑/ 对应域，别在本文件加节`);
    });
  });

  await suite.group('P7.6 · 整理建议（形状唯一 · 自动归位不扩 · 新接线）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    /**
     * ⚠️ **剥注释版**（独立审 🟢3）：本组末尾那两条"接线在"的断言（`computeTodoItems(` /
     * `computeMaintenance(`）原先用不剥注释的 read —— 注释里提一句就骗过了（"字面出现即绿"）。
     */
    const read = (rel: string): string =>
      fs
        .readFileSync(path.join(root, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    /**
     * 🔴 **完成定义③：建议形状的定义文件只有一个**（三个源都过它）。
     * 判据认"别处没有第二份形状声明" + "消费方真的 import 了它" ——
     * 本项目栽过"两处各写一份、慢慢漂"（P3/P5），这条就是那件事的闸。
     *
     * ⚠️ **独立审查 🟢7 加固**（两个可绕的口子都堵上）：
     *  · 原先只点名 4 个文件 —— 新加一个 `suggest-v2.ts` 再声明一份就绕过了。
     *    改成**扫 `src/` 全树**（`tsFilesUnder`）。
     *  · 原先不剥注释 —— 删掉真 import、留一行注释里的 `from '../services/suggest'`
     *    照样绿（P0 起的老形态）。现在**先剥注释再判**。
     */
    await suite.it('🔴 建议形状唯一出处：全 src 只有 services/suggest.ts 声明 `SuggestItem` / `RawSuggestion`', () => {
      const suggest = read('src/services/suggest.ts');
      ok(/export interface SuggestItem\b/.test(suggest), '形状定义在 suggest.ts');
      ok(/export interface RawSuggestion\b/.test(suggest), '带优先级的原始形状也在');
      const stripTs = (src: string): string =>
        src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const f of tsFilesUnder(path.join(root, 'src'))) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (rel === 'src/services/suggest.ts') continue;
        const src = stripTs(fs.readFileSync(f, 'utf8'));
        ok(!/interface SuggestItem\b/.test(src), `${rel} 不许再声明一份 SuggestItem`);
        ok(!/interface RawSuggestion\b/.test(src), `${rel} 不许再声明一份 RawSuggestion`);
      }
      ok(
        /from '\.\.\/services\/suggest'/.test(stripTs(read('src/ui/suggest-panel.ts'))),
        '面板必须 import services/suggest（预检 / 合并 / 执行判据全从那一份来）',
      );
      ok(
        /from '\.\/suggest-learned'/.test(stripTs(suggest)),
        '学过往源经 suggest.ts 收口（学习的产物由它转成建议形状 —— 适配只有一份）',
      );
    });

    /** 🔴 自动归位的触发条件一个字没扩：reconcile.ts 不许沾"学习/建议"任何东西 */
    await suite.it('🔴 reconcile.ts 不许引用学习/建议（自动触发条件不许扩）', () => {
      const rec = read('src/services/reconcile.ts');
      ok(!/suggest/i.test(rec), 'reconcile 不许 import 或提到 suggest（它是"建议"的反面：自动）');
      ok(!/moveStats|learned/i.test(rec), 'reconcile 不许沾学习记录');
      // 学习只学手动来源（白名单在 suggest-learned；reconcile/ai/rebuild/template 都不在）
      const learned = read('src/services/suggest-learned.ts');
      ok(/LEARN_SOURCES\s*=\s*\[/.test(learned), '学习来源白名单在');
      ok(!/LEARN_SOURCES[\s\S]{0,200}?'reconcile'/.test(learned), "LEARN_SOURCES 里不许有 'reconcile'（自动不学）");
      ok(!/LEARN_SOURCES[\s\S]{0,200}?'ai'/.test(learned), "LEARN_SOURCES 里不许有 'ai'（AI 判断喂回来是放大器）");
    });

    /** 接线：菜单入口 / 学习钩子装配 / 补声明走共用函数（两条执行链同一份） */
    await suite.it('接线在：菜单第三项 · main 装配学习钩子 · 补声明与 rebuild 共用一份', async () => {
      ok(/openSuggestPanel\(/.test(read('src/modules/home/tidy.ts')), '二级菜单要有「整理建议…」入口');
      const main = read('src/main.ts');
      ok(/new MoveLearner\(/.test(main), '学习记录器在 main 装配');
      ok(/LEARN_SOURCES/.test(main), '装配处按来源白名单过滤');
      ok(/onMoved|tagsOf/.test(read('src/services/mover.ts')), 'mover 带 onMoved 回调（可选，缺席零开销）');
      const panel = read('src/ui/suggest-panel.ts');
      ok(/writeDeclaredForMoved\(/.test(panel), '面板的"补声明"走 rebuild.ts 抽出的共用函数（不留第二份）');
      ok(/insertMocBullet\(/.test(panel), 'MOC 插入点走 suggest.ts 的纯函数（只加不删）');
      ok(/markSelfWrite\(/.test(panel), 'MOC 写盘前要登记自写（否则索引判外部改动、还原被守卫挡住）');
    });

    /** 16.4 的落点：三条新规则在 todo.ts 里（写文案时别删了它们） */
    await suite.it('待处理三件：孤儿 / 重复 / 一次性标签的规则行在（id 稳定）', () => {
      const todo = read('src/modules/home/todo.ts');
      for (const id of ['orphan-files', 'dup-files', 'unused-tags']) {
        ok(todo.includes(`'${id}'`), `规则 ${id} 在`);
      }
      /**
       * ⚠️ **P7.13b 回改**：清单组装从 `blocks/todo.ts` 搬去 `todo-actions.ts` 的
       * `computeTodoItems`（渲染与 ①/② 动作读**同一份**）。钉**新形态**：
       * 首页真的调了那份组装；维护三件的计算在那一份里（不是画个空壳）。
       */
      const blocks = read('src/modules/home/blocks/todo.ts');
      ok(/computeTodoItems\(/.test(blocks), '首页真的去算（经 computeTodoItems —— P7.13b 起唯一那份组装）');
      const actions = read('src/modules/home/todo-actions.ts');
      ok(/computeMaintenance\(/.test(actions), '维护三件的计算在 computeTodoItems 那一份里（不是画个空壳）');
      ok(/showInSystemExplorer\(/.test(blocks), '孤儿/重复的"跳转"走系统资源管理器（既有口）');
    });
  });

  /**
   * ── P7.7 · 动效系统（10.1 · 静态）────────────────────────────────
   *
   * 三件：① **动效一律挂 token**（扫全部样式源，不许散写毫秒/曲线）；
   * ② 「减少动效」**两段规则的容器清单**（容器本体也点名 + body 级的撤销条不落空
   * —— 两处洞都是 P7.7 盘点实测挖出来的）；③ 三档曲线落位（退场 → `--ease-exit`）
   * 与倒计时豁免（三截选择器压得住两段 reduce）。
   */
  await suite.group('P7.7 · 动效系统（10.1 · 静态）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
    const stripCssComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '');

    await suite.it('动效一律挂 token：animation/transition 里不许散写毫秒与曲线', () => {
      const bad: string[] = [];
      for (const f of STYLE_ORDER) {
        const src = stripCssComments(fs.readFileSync(path.join(root, 'styles', f), 'utf8'));
        /** 只扫 shorthand 声明（`animation:` / `transition:`）—— `-duration` 之类的长名不吃这条 */
        for (const m of src.matchAll(/(?:^|[;{\n])\s*(animation|transition)\s*:([^;}]*)/g)) {
          const raw = m[2];
          if (raw.trim() === 'none') continue; // 刻意的"掐掉过渡"（拖动克隆体，拖起来不许有过渡）
          const label = `styles/${f}: ${(m[1] + ':' + raw).trim()}`;
          if (!/var\(--t-|var\(--kbw-undo-ms/.test(raw)) bad.push(`${label} —— 时长没挂 token`);
          if (!/var\(--ease|linear/.test(raw)) bad.push(`${label} —— 曲线没挂 token`);
          const noVar = raw.replace(/var\([^)]*\)/g, '');
          if (/[0-9]/.test(noVar)) bad.push(`${label} —— var() 之外还有裸数字`);
          if (/\bease(-in-out|-in|-out)?\b/.test(noVar)) bad.push(`${label} —— var() 之外还有裸曲线`);
        }
      }
      eq(bad.length, 0, `散写的毫秒/曲线要挂 token（--t-* / --ease*）：\n${bad.join('\n')}`);
    });

    await suite.it('「减少动效」两段规则：容器本体也点名、撤销条不落空', () => {
      const base = stripCssComments(read('styles/base.css'));
      const media = base.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
      ok(media, 'base.css 里那条系统偏好的媒体规则在');
      const msel = media?.[1] ?? '';
      const containers = ['.kbw-menu', '.kbw-panel', '.kbw-modal', '.kbw-backdrop', '.kbw-notices', '.kbw-undobar-wrap'];
      /**
       * **本体也点名**：`.kbw-menu *` 只后代 —— 菜单/浮层/模态的**出场动画挂在元素本体**，
       * 只写 `X *` 等于"减少动效下菜单照弹"（P7.7 盘点实测的洞）。
       * 判法：**选择器表逐字比对**（`:is(…)` 里也有逗号，按段拆分会被骗 —— 实测踩过）。
       * 空白归一后比，防换行/缩进漂移。
       */
      const norm = (s: string): string => s.replace(/\s+/g, ' ');
      const mselN = norm(msel);
      for (const name of containers) {
        ok(mselN.includes(name), `媒体段要覆盖 ${name}（撤销条/浮层在 body 上，漏了就照播）`);
      }
      ok(
        mselN.includes(':is(.kbw-root, .kbw-menu, .kbw-panel, .kbw-modal, .kbw-notices, .kbw-undobar-wrap) *,'),
        '媒体段：容器后代（含伪元素那三行）在',
      );
      ok(
        mselN.includes('.kbw-menu, .kbw-panel, .kbw-modal, .kbw-backdrop, .kbw-notices, .kbw-undobar-wrap {'),
        '媒体段：容器**本体**那一行在（缺了它 = 减少动效下菜单/浮层/模态照弹）',
      );

      const dmRules = cssRules(read('styles/settings.css')).filter(
        (r) => r.body.includes('animation-duration: 1ms') && r.sel.includes('data-motion'),
      );
      eq(dmRules.length, 1, 'settings.css 里插件档的减少动效规则恰一条');
      const dselN = norm(dmRules[0].sel);
      for (const name of containers) {
        ok(dselN.includes(name), `插件档要覆盖 ${name}`);
      }
      ok(
        dselN.includes(
          "body[data-motion='reduce'] :is(.kbw-menu, .kbw-panel, .kbw-modal, .kbw-notices, .kbw-undobar-wrap),",
        ),
        '插件档：body 级容器**本体**那一行在（退化成只剩 * 后代 = 菜单照弹）',
      );
      ok(
        dselN.includes("body[data-motion='reduce'] .kbw-backdrop"),
        '插件档：遮罩本体也在（它的渐入动画挂在遮罩自己身上）',
      );
      /**
       * 🔴 **绝不裸写 `body[data-motion='reduce'] *`**：那会打到整个 Obsidian 的 DOM
       * （body 的整棵子树），不是只打我们的容器。
       */
      ok(
        !/body\[data-motion='reduce'\]\s*\*/.test(dmRules[0].sel),
        '不许裸写 body[data-motion] *（会打到整个 Obsidian）',
      );
    });

    await suite.it('倒计时豁免：三截选择器 + !important（压得住两段 reduce）', () => {
      const ex = cssRules(read('styles/notice.css')).filter(
        (r) => r.body.includes('animation-duration') && r.body.includes('var(--kbw-undo-ms'),
      );
      eq(ex.length, 1, '豁免规则恰一条');
      const sel = ex[0].sel;
      ok(
        sel === 'body .kbw-undobar-wrap .kbw-undobar .kbw-undobar-progress',
        `四段链条 = (0,3,1)，压得住 settings 段最高的 (0,2,1)；实测：「${sel}」` +
          '（⚠️ 只写三截是 (0,2,1)——打平后按源序会输给 settings.css，真机探针抓过这条）',
      );
      ok(ex[0].body.includes('!important'), '必须 !important（两段 reduce 都是 important）');
    });

    await suite.it('进出场挂对档：入场 --ease-enter · 退场 --ease-exit；token 三档在册', () => {
      const entrances: Array<[string, string]> = [
        ['styles/menu.css', '.kbw-menu'],
        ['styles/panel.css', '.kbw-modal'],
        ['styles/panel.css', '.kbw-panel'],
        ['styles/panel.css', '.kbw-backdrop'],
        ['styles/notice.css', '.kbw-notice'],
        ['styles/notice.css', '.kbw-undobar'],
      ];
      for (const [file, sel] of entrances) {
        const r = cssRules(read(file)).find((x) => x.sel === sel);
        ok(r, `${file} 的 ${sel} 规则在`);
        ok(r?.body.includes('var(--ease-enter)') === true, `${sel} 入场用进入档`);
      }
      for (const [file, sel] of [
        ['styles/notice.css', '.kbw-notice.is-leaving'],
        ['styles/notice.css', '.kbw-undobar.is-leaving'],
      ] as Array<[string, string]>) {
        const r = cssRules(read(file)).find((x) => x.sel === sel);
        ok(r, `${sel} 规则在`);
        ok(r?.body.includes('var(--ease-exit)') === true, `${sel} 退场用离开档（慢起快走）`);
      }
      const tok = cssRules(read('styles/tokens.css')).find((r) => r.sel === ':root');
      ok(tok, 'tokens 的 :root 块在');
      for (const name of ['--ease-enter:', '--ease-exit:', '--ease:', '--ease-loop:', '--t-flash:', '--t-breathe:', '--t-shimmer:']) {
        ok(tok?.body.includes(name) === true, `tokens.css 里要有 ${name}`);
      }
    });

    await suite.it('data-motion 镜像接线：视图写 body · main 加载清残留 + 卸载不留孤儿', () => {
      ok(
        /document\.body\.setAttribute\('data-motion'/.test(read('src/view/workbench-view.ts')),
        '视图把档镜像到 body（applyAppearance）',
      );
      const removes =
        read('src/main.ts').match(/document\.body\.removeAttribute\('data-motion'\)/g) ?? [];
      ok(removes.length >= 2, `main 两处摘（加载清残留 + 卸载摘掉），实测 ${removes.length} 处`);
    });

    /** 10.2 的反馈矩阵：在册 · 七列齐 · 两条"有意不做"写明（防被当缺口回头补） */
    await suite.it('反馈矩阵（交互规格 §1.8）在册：七列齐 + 「未采纳」两条写明', () => {
      const doc = fs.readFileSync(path.join(root, '交互规格.md'), 'utf8');
      const start = doc.indexOf('### 1.8 反馈矩阵');
      ok(start >= 0, '§1.8 反馈矩阵在册（P7.7 · 10.2）');
      const sec = doc.slice(start, doc.indexOf('\n## 2.', start));
      for (const col of ['悬停', '按下', '键盘焦点', '进行中', '成功', '失败', '撤销']) {
        ok(sec.includes(col), `七列里「${col}」在表头`);
      }
      ok(sec.includes('两条有意不做'), '两条"有意不做"写明（真实进度条 / 统一焦点环）');
      ok(sec.includes('真实进度条') && sec.includes('统一焦点环'), '两条都点名（与决策表「未采纳」同口径）');
    });
  });

  /**
   * ── P7.7c · 批 3（静态对表与形态）────────────────────────────────
   *
   * 三件：① 10.3/10.4 **稿↔实现对表**（稿子先行：G7 已把稿改成实现值，
   * 这里把"两边同值"钉住——任一侧改一个值就红）；② 10.6 危险按钮**常态不许
   * 回到实心红 + 反色字**（拍板：淡底红字，实心只留 hover/上膛）；
   * ③ 10.5 短词：表格标记列不再出现 `⚠` 字形（渲染逐词在 `p77.ts`，
   * 这里防"改回来"只钉一处字面）。
   */
  await suite.group('P7.7c · 批 3（对表与形态 · 静态）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
    /** 稿子的 CSS（全部 <style> 块拼一起；HTML 注释不在其中，无需剥） */
    const draftCss = (): string =>
      [...read('界面设计.html').matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    const normDecls = (body: string): Map<string, string> => {
      const out = new Map<string, string>();
      for (const part of body.split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        /**
         * ⚠️ 逗号后也统一成一个空格：稿子那份 CSS 是压缩写法（`srgb,var(` 没空格），
         * 实现是多行手写（`srgb, var(` 有空格）—— 只归一空白的话 color-mix 这种
         * 带逗号的表达会假红（第一版实测就这么红的）。
         */
        const v = part
          .slice(i + 1)
          .replace(/\s+/g, ' ')
          .replace(/\s*,\s*/g, ', ')
          .trim();
        if (k) out.set(k, v);
      }
      return out;
    };
    const ruleOf = (css: string, sel: string): string => {
      const r = cssRules(css).find((x) => x.sel === sel);
      ok(r, `稿/实现里找得到规则 ${sel}`);
      return r?.body ?? '';
    };
    /** 两边同值对表：逐属性比（表达式天然有差的地方不进来；空白归一后全等） */
    const sameValue = (draftBody: string, implBody: string, props: string[], label: string): void => {
      const d = normDecls(draftBody);
      const m = normDecls(implBody);
      for (const p of props) {
        eq(m.get(p), d.get(p), `${label}：${p} 稿与实现同值`);
      }
    };

    await suite.it('10.3 对表：`.seg button.on` 稿↔实现逐值同（安静版：灰底 + 常规字 + 600）', () => {
      const draft = ruleOf(draftCss(), '.seg button.on');
      const impl = ruleOf(read('styles/notes.css'), '.kbw-seg button.is-on');
      sameValue(draft, impl, ['background', 'color', 'font-weight'], 'seg 选中态');
      // 反例护栏：这三件恰好是 G7 拍板"认安静版"的三件——任一回到 accent 填充即红
      ok(!/interactive-accent/.test(impl), '实现里不许回到 accent 填充（拍板：认安静版）');
    });

    await suite.it('10.4 对表：`.kbw-card` 稿↔实现（圆角 10 · sp-2/sp-3/sp-2 · 常态阴影同源 · hover 只换边框色）', () => {
      const draft = ruleOf(draftCss(), '.card');
      /**
       * ⚠️ `board.css` 里 `.kbw-card` 有**多条**（另两条是别的用途）——认第一条
       * 带 `width: var(--kbw-card-w…)` 的那条（`cssRules` 保序，取第一个同名选择器）。
       */
      const implRules = cssRules(read('styles/board.css')).filter((r) => r.sel === '.kbw-card');
      ok(implRules.length >= 1, 'board.css 里有 .kbw-card');
      const impl = implRules[0].body;
      ok(/--kbw-card-w/.test(impl), '抓的是主卡那条（带宽度变量）');
      sameValue(draft, impl, ['border-radius', 'padding'], '.kbw-card');
      eq(normDecls(impl).get('border-radius'), '10px', '圆角是字面 10px（不是 --radius-m —— 别顺手统一刻度）');
      /**
       * 阴影按**同源断**：稿 `--shadow-s` ⟷ 实现 `--kbw-shadow-2`，靠 tokens 里
       * 那行别名连起来（两边的字面值本来就不同）。
       */
      const dShadow = normDecls(draft).get('box-shadow') ?? '';
      const mShadow = normDecls(impl).get('box-shadow') ?? '';
      eq(dShadow, 'var(--shadow-s)', '稿的常态阴影 = --shadow-s');
      eq(mShadow, 'var(--kbw-shadow-2)', '实现的常态阴影 = --kbw-shadow-2');
      const tokens = read('styles/tokens.css');
      ok(
        /--kbw-shadow-2:\s*var\(--shadow-s/.test(tokens),
        '同源断：tokens 里 --kbw-shadow-2 就是 var(--shadow-s) 的别名',
      );
      // hover：两边都只换边框色（不许出现 background/box-shadow 的其它变化）
      const dHover = normDecls(ruleOf(draftCss(), '.card:hover'));
      eq([...dHover.keys()].join(','), 'border-color', '稿 hover 只有 border-color');
      const hovers = cssRules(read('styles/board.css')).filter((r) => r.sel === '.kbw-card:hover');
      ok(hovers.length >= 1, 'board.css 里有 .kbw-card:hover');
      eq(
        [...normDecls(hovers[0].body).keys()].join(','),
        'border-color',
        '实现 hover 也只有 border-color（常态阴影别在悬停时动）',
      );
    });

    await suite.it('10.6 形态：危险按钮常态 = 淡底红字；不许回到「实心红 + 反色字」', () => {
      const impl = ruleOf(read('styles/components.css'), '.kbw-btn.is-danger');
      const d = normDecls(impl);
      eq(
        d.get('background'),
        'color-mix(in srgb, var(--color-red) 12%, transparent)',
        '常态底色 = 12% 淡红（照稿 .btn.danger）',
      );
      eq(
        d.get('border-color'),
        'color-mix(in srgb, var(--color-red) 30%, transparent)',
        '常态描边 = 30% 淡红',
      );
      /**
       * 🔴 字色是**自适应混合**（红 80% + `--text-normal` 20%），不是裸 `var(--color-red)`：
       * 裸红压淡底实测亮 ~3.9 / 暗 ~4.2，够不到常态 ≥4.5 判据（2026-10-05 拍板，理由在
       * components.css 那段注释）。两边（稿 `.btn.danger` ↔ 实现）同值，改任一侧即红。
       */
      eq(
        d.get('color'),
        'color-mix(in srgb, var(--color-red) 80%, var(--text-normal))',
        '常态文字 = 红 × 常态字色的自适应混合（裸红字实测不足 4.5）',
      );
      sameValue(ruleOf(draftCss(), '.btn.danger'), impl, ['background', 'border-color', 'color'], '危险按钮常态');
      ok(!/text-on-accent/.test(impl), '常态不许用反色字（白字压实心红暗色 3.45:1，P6⑤ 记）');
      // 上膛（两下确认的第一下）那一下保持实心强调；hover 与它**同形态**（hover 真机探针量不了、
      // 由探针量"上膛"那一下代替 —— 所以这里把两条钉成同值，改散即红）
      const armed = ruleOf(read('styles/components.css'), '.kbw-btn.is-danger.is-armed');
      eq(normDecls(armed).get('background'), 'var(--color-red)', '上膛 = 实心红（强调那一下）');
      ok(/text-on-accent/.test(armed), '上膛用反色字（实心红上只有它可读）');
      const hover = ruleOf(read('styles/components.css'), '.kbw-btn.is-danger:hover');
      sameValue(armed, hover, ['background', 'border-color', 'color'], 'hover 与上膛同形态');
    });

    await suite.it('10.5 静态：表格标记列不再画 `⚠` 字形（短词，词表在 columns.ts）', () => {
      const src = read('src/modules/notes/columns.ts');
      ok(!/text: '⚠'/.test(src), 'columns.ts 里不再有画 ⚠ 的字面量（三处渲染点全换短词）');
      // ⚠️ v2（P7.12）：「缺项」随缺必填退休，从词表里去掉
      for (const w of ['错位', '断链', '未名', '空文', '外改', '待整理']) {
        ok(src.includes(w), `词表里「${w}」在（拍板件，不许改词）`);
      }
      /**
       * 🔴 **胶囊不许收缩**（独立审 🟡1 补的判据洞）：`min-width:16px` 会关掉 flex 的
       * min-content 保护 —— 窄列里胶囊被挤到 16px、短词文字溢出血洗（真机实测 19/16）。
       * 探针量的是**宽默认态**（有余量），删了 `flex:none` 也不会红 → 这条静态才是
       * 那个洞的真判据。`white-space: nowrap` 同理（短词不许折行）。
       */
      const flagRule = cssRules(read('styles/components.css')).find((r) => r.sel === '.kbw-flag');
      ok(flagRule, 'components.css 里 .kbw-flag 基底规则在');
      ok(
        /flex:\s*none/.test(flagRule?.body ?? ''),
        '.kbw-flag 要 flex:none（防窄容器挤压文字血洗；删掉它 → 这条红）',
      );
      ok(
        /white-space:\s*nowrap/.test(flagRule?.body ?? ''),
        '.kbw-flag 要 white-space: nowrap（短词不折行）',
      );
    });

    await suite.it('tabular-nums 清单：30 处逐处点名（现状 6 保留 + P7.7c 新补 24；删一处就红）', () => {
      /**
       * 「数字/日期列 · 计数徽标 · 时间列 · 状态行」逐处点名（P7.7c 顺路收四笔的审计表）。
       * 前 6 处是既有的（审计保留），后面是审计"该有而没有"补的 —— 突变删任意一处这里红。
       * ⚠️ 补进来的判据都要能说出"为什么"：数字会变/要竖排对齐的地方才挂；
       * 纯装饰的短字形（`/` 键帽那种也挂了，无害）不追。
       */
      const want: Array<[string, string]> = [
        // 既有（审计确认保留）
        ['styles/board.css', '.kbw-sect-preview'],
        ['styles/board.css', '.kbw-cw-size'],
        ['styles/home.css', '.kbw-key'],
        ['styles/notes.css', '.kbw-tree-preview'],
        ['styles/notes.css', '.kbw-tree-count'],
        ['styles/panel.css', '.kbw-snap-c4'],
        // P7.7c 补：表格数字/日期列
        ['styles/notes.css', ".kbw-table td[data-col='mtime']"],
        ['styles/notes.css', ".kbw-table td[data-col='size']"],
        ['styles/notes.css', '.kbw-tabnum'],
        // P7.7c 补：时间列
        ['styles/panel.css', '.kbw-snap-c1'],
        ['styles/home.css', '.kbw-rec-t'],
        // P7.7c 补：计数徽标 / 状态行
        ['styles/home.css', '.kbw-home-foot'],
        ['styles/home.css', '.kbw-sec-cnt'],
        ['styles/home.css', '.kbw-todo-rest'],
        ['styles/board.css', '.kbw-sect-n'],
        ['styles/board.css', '.kbw-sect-badge'],
        ['styles/notes.css', '.kbw-frow-count'],
        ['styles/notes.css', '.kbw-batch-count'],
        ['styles/notes.css', '.kbw-gstatus'],
        ['styles/notes.css', '.kbw-chip.is-more'],
        // P7.7c 补·独立审 🟡2 追齐（同一口径的兄弟处）
        ['styles/notes.css', '.kbw-gsize'],
        ['styles/notes.css', '.kbw-crumbs-count'],
        ['styles/confirm.css', '.kbw-plan-row .kbw-plan-count'],
        ['styles/migrate.css', '.kbw-mig-count'],
        ['styles/rebuild.css', '.kbw-rb-count'],
        ['styles/board.css', '.kbw-bp-count'],
        ['styles/board.css', '.kbw-rail-n'],
        ['styles/settings.css', '.kbw-log-time'],
        ['styles/settings.css', '.kbw-log-n'],
        ['styles/settings.css', '.kbw-set-hsearch-n'],
      ];
      const missing: string[] = [];
      for (const [file, sel] of want) {
        const rule = cssRules(read(file)).find((r) => r.sel === sel);
        if (!rule) missing.push(`${file} 里找不到 ${sel}`);
        else if (!rule.body.includes('font-variant-numeric: tabular-nums')) {
          missing.push(`${sel}（${file}）没挂 tabular-nums`);
        }
      }
      eq(missing.join('\n'), '', `tabular-nums 应挂未挂：\n${missing.join('\n')}`);
    });

    await suite.it('图标纪律：功能图标一律 icon()（emoji 图标 0 处 · setIcon 的 import 只在 primitives · 不直写 svg · brandMark 只站品牌位/空态）', () => {
      /**
       * P7.7c 审计收口的三条（`primitives.ts` 的 `icon()` / `brandMark()` 是唯一出处）：
       *  ① **emoji 当图标**：`text:` 字面量**整体是一个 emoji** 的算越界（长相由字体决定，
       *     平台间漂移）—— 内容种子（`title:` 里的 📥 收件箱中心那种）是**内容不是图标**，不吃这条；
       *  ② **`setIcon` 的函数 import** 只许在 primitives.ts（菜单那种 `item.setIcon` 是
       *     平台 MenuItem 的方法调用，不在此列）；
       *  ③ **不直写 svg**（`<svg` 串 / `createElementNS`）只许在 primitives.ts；
       *  ④ **`brandMark` 只站品牌位与空态** —— 调用点白名单，新增调用必须是有意为之。
       */
      const files = tsFilesUnder(path.join(root, 'src'));
      const stripFullLineComments = (src: string): string =>
        src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const emojiOnly = /^\s*\p{Emoji_Presentation}+\s*$/u;
      const badEmoji: string[] = [];
      const badSetIcon: string[] = [];
      const badSvg: string[] = [];
      const brandSites: string[] = [];
      const brandAllow = new Set([
        'src/main.ts', // ribbon 图标（品牌位）
        'src/modules/home/blocks/hero.ts', // 首页 hero（品牌位）
        'src/ui/empty.ts', // 空态
        'src/view/workbench-view.ts', // 标签页图标 + 工作台顶栏（品牌位）
      ]);
      for (const f of files) {
        const rel = path.relative(root, f).replace(/\\/g, '/');
        const code = stripFullLineComments(fs.readFileSync(f, 'utf8'));
        for (const m of code.matchAll(/text:\s*(?:'([^']*)'|"([^"]*)")/g)) {
          const v = m[1] ?? m[2] ?? '';
          if (emojiOnly.test(v)) badEmoji.push(`${rel}: text:'${v.trim()}'`);
        }
        if (rel !== 'src/ui/primitives.ts') {
          if (/import\s*\{[^}]*\bsetIcon\b[^}]*\}\s*from\s*'obsidian'/.test(code)) {
            badSetIcon.push(rel);
          }
          if (/<svg|createElementNS/.test(code)) badSvg.push(rel);
          if (/brandMark\(/.test(code) && !brandAllow.has(rel)) brandSites.push(rel);
        }
      }
      eq(badEmoji.join('、'), '', 'emoji 当图标的地方：换 icon()（📸/🔒 那两个 P7.7c 已换）');
      eq(badSetIcon.join('、'), '', 'setIcon 的函数 import 只许在 primitives.ts（别手抄 icon() 的内部）');
      eq(badSvg.join('、'), '', '不直写 svg —— icon()/brandMark() 是唯一出处');
      eq(brandSites.join('、'), '', 'brandMark 只站品牌位与空态（新调用点先想清楚再进白名单）');
    });
  });

  /**
   * ── P7.8 · 待处理 AI 一键（1.5 · 静态）──────────────────────────
   *
   * 三件：① 「AI 起标题」不新开写盘路径（红线：动库全过 confirm + mover）；
   * ② 起标题的任务口径在位（`proposeTitles` + `buildTitleMessages`）且服务层照旧碰不到 mover；
   * ③ 「还没配置 AI」那句话**唯一出处**（面板 / 行内 ✦ 降级 / 起标题面板共引一份，
   *    各写各的文案就是"两处口径迟早漂"的老形态 —— P7.5 起对用户文案上机制）。
   */
  await suite.group('P7.8 · 待处理 AI 一键（静态）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
    const stripTs = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    await suite.it('🔴 AI 起标题不新开写盘路径：走 confirm + mover，不直接碰 vault 写 API', () => {
      const src = stripTs(read('src/ui/title-panel.ts'));
      ok(/confirm\(/.test(src), '确认流在（改名前逐条预览）');
      ok(/mover\.move\(/.test(src), '执行走 mover（快照 / 撤销条 / 日志全在那条链上）');
      ok(/source: 'ai'/.test(src), "source 用 'ai'（日志留痕「AI 建议」+ ai:true，§11.1 边界④）");
      ok(!/vault\.(process|create|modify|delete)\(/.test(src), '不许直接碰 vault 写 API');
      ok(!/\badapter\./.test(src), '不许直接碰 adapter');
      ok(/cleanNewName\(/.test(src), '改名预览调 mover 的 cleanNewName（清洗口径只有一份，预览 = 执行）');
    });

    await suite.it('起标题任务口径在位；services/ai 照旧 import 不到 mover，也没加工具', () => {
      const ai = read('src/services/ai/index.ts');
      const prompt = read('src/services/ai/prompt.ts');
      ok(/async proposeTitles\(/.test(ai), 'proposeTitles 在服务层（单轮任务口径，与 classify 同族）');
      ok(/buildTitleMessages/.test(prompt), '提示词构建器在 prompt.ts');
      ok(/export function parseTitles\(/.test(prompt), '解析器在 prompt.ts');
      const aiCode = stripTs(ai);
      ok(!/from '\.\.\/mover'/.test(aiCode) && !/\.move\(/.test(aiCode), '🔴 services/ai 没有写盘能力（边界①）');
    });

    await suite.it('「还没配置 AI」文案唯一出处：面板定义、行内 ✦ 与起标题面板都引它', () => {
      const needle = '还没配置 AI（设置 → AI 助手 里填 key）';
      const hits: string[] = [];
      for (const f of tsFilesUnder(path.join(root, 'src'))) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (stripTs(fs.readFileSync(f, 'utf8')).includes(needle)) hits.push(rel);
      }
      eq(hits.join(','), 'src/ui/suggest-panel.ts', '字面量只许出现在它的定义处');
      ok(
        /AI_NOT_CONFIGURED/.test(stripTs(read('src/modules/home/blocks/todo.ts'))),
        '行内 ✦ 的降级引共用常量',
      );
      ok(
        /AI_NOT_CONFIGURED/.test(stripTs(read('src/ui/title-panel.ts'))),
        '起标题面板引共用常量',
      );
    });
  });

  /**
   * ── P7.10 · 反馈批 2（静态）──────────────────────────────────
   *
   * 五件源码级事实（各自的"为什么"在用例注释里）：
   *  ① 轻量目录树**唯一出处**（`ui/folder-tree.ts` 三处共用 —— 各写一份迟早漂）；
   *  ② 结语「首页」卡的紫色强调在位（探针只量几何与身份；颜色序列化形态不稳，
   *     static 这条才是"紫色那档"的判据）；
   *  ③ #11 抽屉行内动作**默认隐藏**（opacity 档 + hover / focus-within 揭示 ——
   *     jsdom 测不了计算样式，只能源级钉）；
   *  ④ 向导不再画原生 datalist（#2 换成目录树，别借尸还魂）；
   *  ⑤ `notesIntroSeen` 的布尔键纪律（显式 normalize case）+ notes 挂载按旗标弹。
   */
  await suite.group('P7.10 · 反馈批 2（静态）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
    const stripTs = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    await suite.it('轻量目录树唯一出处：向导 / 引用选择器 / 工作目录共引 folder-tree.ts', () => {
      const ft = stripTs(read('src/ui/folder-tree.ts'));
      ok(/export function folderTree\(/.test(ft), '实现只有一个（ui/folder-tree.ts）');
      for (const f of ['src/ui/wizard.ts', 'src/ui/ai-panel.ts']) {
        const src = stripTs(read(f));
        ok(/from '\.\/folder-tree'/.test(src), `${f} 引的是它`);
        ok(/folderTree\(/.test(src), `${f} 真的用它（调用形态）`);
      }
      // 别处不许再自己造 `.kbw-ftree` 的 DOM（那个类名是这份实现的认人标记）
      const offenders: string[] = [];
      for (const f of tsFilesUnder(path.join(root, 'src'))) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (rel === 'src/ui/folder-tree.ts') continue;
        if (stripTs(fs.readFileSync(f, 'utf8')).includes("'kbw-ftree")) offenders.push(rel);
      }
      eq(offenders.join(','), '', '只有 folder-tree.ts 能写 kbw-ftree 类名');
    });

    await suite.it('结语「首页」卡的紫色强调在位（.kbw-wiz-card.is-home ← accent）· 2×2 两列', () => {
      const css = read('styles/wizard.css');
      ok(
        /\.kbw-wiz-card\.is-home\s*\{[^}]*border-color:\s*var\(--interactive-accent\)/.test(css),
        '卡身描边 = accent',
      );
      ok(
        /\.kbw-wiz-card\.is-home\s+\.kbw-wiz-card-t\s*\{[^}]*color:\s*var\(--interactive-accent\)/.test(css),
        '主文字 = accent',
      );
      ok(/grid-template-columns:\s*repeat\(2,/.test(css), '卡列 2 列（2×2 网格）');
    });

    await suite.it('#11 抽屉行内动作：默认隐藏 + hover / focus-within 揭示（源级）', () => {
      const rules = cssRules(read('styles/ai.css'));
      const base = rules.find((r) => r.sel === '.kbw-ai-sess-acts');
      ok(base, '有基底规则');
      ok(/opacity:\s*0/.test(base!.body), '默认 opacity:0（看不见）');
      ok(/pointer-events:\s*none/.test(base!.body), '默认不吃点击（别"看不见却点得到"）');
      const hover = rules.find((r) => r.sel.includes('.kbw-ai-sess:hover .kbw-ai-sess-acts'));
      ok(hover && /opacity:\s*1/.test(hover.body), 'hover 才现');
      // 独立审 🟢2：**连 @media 上下文一起钉** —— 搬出 `@media (hover: hover)` 就得红（触屏残留）
      ok(
        hover !== undefined && hover.at.includes('hover: hover'),
        `hover 那条在 @media (hover: hover) 里（实际外层「${hover?.at ?? '（没有）'}」）`,
      );
      const focus = rules.find((r) =>
        r.sel.includes('.kbw-ai-sess:focus-within .kbw-ai-sess-acts'),
      );
      ok(focus && /opacity:\s*1/.test(focus.body), 'focus-within 同现（键盘可用）');
    });

    await suite.it('向导：原生 datalist 退役（#2 换成目录树）', () => {
      ok(!/datalist/.test(stripTs(read('src/ui/wizard.ts'))), '向导里不再有 datalist');
    });

    await suite.it('notesIntroSeen：显式 normalize case（布尔键纪律）+ notes 挂载按旗标弹', () => {
      const st = stripTs(read('src/core/settings.ts'));
      ok(/case 'notesIntroSeen'/.test(st), 'settings.ts 显式接（default 支只收字符串）');
      ok(/notesIntroSeen: false/.test(st), '默认 false（全新安装该看到）');
      const idx = stripTs(read('src/modules/notes/index.ts'));
      ok(/notesIntroSeen !== true/.test(idx), 'notes 挂载处按旗标弹');
    });

    /**
     * **教程配图三张成品真的在**（P7.10 · #8）。与向导配图（本文件上方那条）同一条纪律：
     * 它们是**随插件发布**的资产（deploy 与分享包各拷一份）—— 少了任何一张，
     * 真机上会走"加载失败就隐藏"那条路（不报错、只是没图，正是最怕的"静默少一块"）。
     * ⚠️ 重拍流程：`scripts/shoot-tutorial.mjs`（只连演示库；视口 920×760 —— 教程图要放大读）。
     */
    await suite.it('教程配图：assets/tutorial/ 三张成品都在', () => {
      for (const f of ['find-search.png', 'find-filter.png', 'batch-bar.png']) {
        ok(fs.existsSync(path.join(root, 'assets', 'tutorial', f)), `assets/tutorial/${f} 在`);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.12 · 反馈批 4 + 属性 v2（静态钉）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.12 · 静态（属性 v2 / 模板竞态 / 行菜单入口）', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
    const stripTs = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    await suite.it('🔴 新建模板竞态：`pending` **预登记必须排在 `vault.create` 之前**（#6② 真机复现的根因）', () => {
      /**
       * 真机症状：对话框里选 T_muban，补全却按默认模板（含 `<% %>`）走 → 跳过 → 空文件。
       * 根因 = create 事件与 createNote 谁先不定 + 补全 IIFE 可能先读到空参数。
       * 修法 = 在 `vault.create` **之前**把参数挂进 `pending`（`createNote` 里的预登记）——
       * 这条钉的就是那个先后次序：删了预登记、或把预登记挪到 create 之后，这里当场红。
       * （行为面的判据在 `automation.ts` 的「对话框里选的模板真的被用上」——那条断言
       * `fillFile` 收到的实参；两条一守时序、一守行为。）
       */
      const src = stripTs(read('src/services/completion.ts'));
      const pre = src.indexOf('this.pending.set(path, {');
      const create = src.indexOf("vault.create(path, '')");
      ok(pre >= 0, '有预登记那一行（this.pending.set(path, {…})）');
      ok(create >= 0, '有落空文件那一行（vault.create(path, "")）');
      ok(
        pre < create,
        `预登记必须**排在** vault.create 之前（实际 pre=${pre} create=${create}）——` +
          '否则 create 事件那条路会读到空参数，退回默认模板',
      );
    });

    await suite.it('v2 值域单点：schema.ts 是七值 / 三值，且不再导出退役符号', () => {
      const s = stripTs(read('src/services/schema.ts'));
      ok(/export const NOTE_TYPES = \['笔记', '任务', '日志', '模板', '索引', '指南', '规范'\]/.test(s), '类型七值定稿');
      ok(/export const STATUSES = \['进行中', '已完成', '已归档'\]/.test(s), '状态三值定稿');
      for (const gone of ['AREAS', 'DEFAULT_AREA_DIRS', 'TEMP_AREA', 'isAreaMissing', 'missingProps', 'PUBLISH_STAGES']) {
        ok(!new RegExp(`export (const|function|type) ${gone}\\b`).test(s), `退役符号 ${gone} 不许再导出`);
      }
      const vi = stripTs(read('src/core/vault-index.ts'));
      ok(!/'missing-required'/.test(vi), '「缺项」旗标退休（vault-index 里不许再有它）');
    });

    await suite.it('v2 模板约定：skeleton 用引号存法 + 类型: 模板；提取模板同步（P7.13a 升级为六键 + 尾链）', () => {
      const nn = stripTs(read('src/ui/new-note.ts'));
      /**
       * P7.13a · #1：骨架从一行常量升级成 `templateSkeleton(dirRel)` 函数（「文件位置」
       * 要按设置现算）——**钉新形态**（函数调用 + 六键 + 尾链占位行），旧常量名不当唯一判据。
       */
      ok(
        nn.includes('function templateSkeleton(') &&
          nn.includes('类型: 模板') &&
          nn.includes('创建日期: "{{date}}"') &&
          nn.includes('收藏: false') &&
          nn.includes('- 返回大地图 {{moc}}'),
        'skeleton = 六键（类型: 模板 + 引号占位符 + 收藏: false）+ 尾链占位行',
      );
      const tp = stripTs(read('src/services/templates.ts'));
      ok(tp.includes('$1: "{{date}}"'), 'extractTemplate 产出引号存法');
    });

    await suite.it('v2 别名段语义：routes.ts 不再引用 AREAS / DEFAULT_AREA_DIRS', () => {
      const r = stripTs(read('src/services/routes.ts'));
      ok(!/AREAS/.test(r) && !/DEFAULT_AREA_DIRS/.test(r), '退役常量不许回流');
      ok(/export function aliasDirs\(/.test(r), '改名后的唯一读口在');
    });

    await suite.it('R5 静态：待处理行尾 ✦ 的渲染点已删（AI 入口 = 行菜单）', () => {
      const b = stripTs(read('src/modules/home/blocks/todo.ts'));
      // ⚠️ 独立审 B4（P7.12 收尾）：原来只钉 `!kbw-todo-ai` —— 该类已随功能从 src 删掉，
      // 单钉"不存在"恒真；补上**新形态的正锚**（行尾 = 动作文案 + chevron），旧类名留作防回流哨兵。
      ok(
        /kbw-todo-act/.test(b) && /chevron-right/.test(b) && !/kbw-todo-ai/.test(b),
        '行尾 = 动作文案 + chevron（旧 ✦ 节点类不许回流）',
      );
      ok(/✦ AI 处理这一项/.test(b), '行菜单的「✦ AI 处理这一项」在（入口保留）');
      ok(/✦ AI 自动处理/.test(b), '「✦ AI 自动处理 ›」子菜单在（入口保留）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.13a · 静态（#5a 红字全显 —— 布局判据只有 CSS 这一层能钉）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13a · 静态（#5a 红字全显）', async () => {
    const root3 = path.resolve(__dirname, '..', '..');
    await suite.it('#5a：`.kbw-suggest-note.is-bad` 换行全显（覆盖基类 nowrap）；清空按钮排文本后', () => {
      // 先剥注释（在本文件栽过：注释里的话被当规则读）——取**顶格写**的规则块
      const css = fs
        .readFileSync(path.join(root3, 'styles/suggest.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const ruleBody = (sel: string): string =>
        (new RegExp(`^${sel}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '').trim();
      const base = ruleBody('\\.kbw-suggest-note');
      ok(/nowrap/.test(base), '基类保持单行省略（**只给 is-bad 破例** —— 两个方向都钉）');
      const bad = ruleBody('\\.kbw-suggest-note\\.is-bad');
      ok(bad.length > 0, '`.kbw-suggest-note.is-bad` 的规则在');
      ok(/white-space:\s*normal/.test(bad), 'Q14：换行全显（覆盖基类 nowrap）');
      ok(/overflow:\s*visible/.test(bad), 'Q14：不限高、不裁（覆盖基类 overflow:hidden）');
      const btn = ruleBody('\\.kbw-suggest-note\\.is-bad \\.kbw-suggest-clearbtn');
      ok(/margin-left:\s*6px/.test(btn), 'Q14：按钮排文本后留一口气（过长自然另起行）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.13b · 静态（动作层的"只走既有出口" —— 结构上的红线，运行时判不到）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13b · 静态（待处理动作层的出口纪律）', async () => {
    const root13 = path.resolve(__dirname, '..', '..');
    const stripTs13 = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read13 = (rel: string): string =>
      stripTs13(fs.readFileSync(path.join(root13, rel), 'utf8'));

    await suite.it('todo-actions：动库必经 mover / confirm；没有裸写盘 API', () => {
      const src = read13('src/modules/home/todo-actions.ts');
      // 正锚：两条既有出口的**调用形态**都在（注释里写不出 `(` 那种）
      ok(/mover\.move\(/.test(src), '搬动走 mover.move（快照/日志/撤销条全在那条链上）');
      ok(/mover\.trash\(/.test(src), '删除走 mover.trash');
      ok(/confirm\(/.test(src), '动库前确认过 ui/confirm.ts（唯一出口）');
      // 反锚：不许出现裸写盘 API（判"调用形态"带括号，注释骗不过）
      for (const bad of ['renameFile(', 'processFrontMatter(', 'adapter.mkdir(', 'vault.process(', 'vault.create(']) {
        ok(!src.includes(bad), `不许裸写盘：出现 ${bad} 了（动文件只能过 mover / 既有面板链）`);
      }
    });

    await suite.it('修链写盘只经 link-panel 一条链：confirm + 快照 + vault.process + markSelfWrite', () => {
      const lp = read13('src/ui/link-panel.ts');
      ok(/confirm\(/.test(lp), '确认流在（ui/confirm.ts）');
      ok(/snapshot\.capture\(/.test(lp), '写盘前快照（与「美化笔记」同一条链）');
      ok(/vault\.process\(/.test(lp), '写链 = vault.process（按行改，拿当刻文本重算）');
      ok(/markSelfWrite\(/.test(lp), '登记"我们自己写的"（否则判成外部改动）');
      const lf = read13('src/services/link-fix.ts');
      ok(/export function replaceLinkTarget\(/.test(lf), 'replaceLinkTarget（认得出才换的纯函数）在');
    });

    await suite.it('行菜单子菜单 = ①/② 两项形态（todo.ts）；「一键自动整理」不在待处理菜单里', () => {
      const b = read13('src/modules/home/blocks/todo.ts');
      ok(b.includes('① 自动处理本条'), '① 的文案在');
      ok(b.includes('② 一键完全处理'), '② 的文案在');
      ok(/todoActionSubmenu\(/.test(b), '子菜单由 todoActionSubmenu 组装（唯一一处）');
      ok(!b.includes('一键自动整理'), '「一键自动整理」从待处理菜单里退役（能力在「整理收件箱」与 ①）');
      ok(!/todoAiSubmenu/.test(b), '老 todoAiSubmenu 不留残名');
    });
  });

  await suite.group('P7.16 · 静态（修前言链条的出口纪律）', async () => {
    const root16 = path.resolve(__dirname, '..', '..');
    const stripTs16 = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read16 = (rel: string): string =>
      stripTs16(fs.readFileSync(path.join(root16, rel), 'utf8'));

    await suite.it('fm-repair 是纯文本层：不碰 YAML 解析、不写盘（写盘在面板那条链上）', () => {
      const fr = read16('src/services/fm-repair.ts');
      for (const bad of [
        'processFrontMatter(',
        'setMany(',
        'markSelfWrite(',
        'vault.process(',
        'vault.create(',
        'vault.modify(',
        'adapter.write',
      ]) {
        ok(!fr.includes(bad), `fm-repair 是纯文本手术：不许出现 ${bad}`);
      }
      ok(/export function fixBarePlaceholders\(/.test(fr), '确定性修的唯一入口在');
      ok(/export function validateFmRepair\(/.test(fr), 'AI 稿校验在（落盘前的闸）');
    });

    await suite.it('修前言面板：confirm + 快照 + vault.process + markSelfWrite；不走属性写口', () => {
      const fp = read16('src/ui/fm-repair-panel.ts');
      ok(/confirm\(/.test(fp), '确认流在（ui/confirm.ts 唯一出口）');
      ok(/snapshot\.capture\(/.test(fp), '写盘前快照（快照 + 撤销条那条链）');
      ok(/vault\.process\(/.test(fp), '写链 = vault.process（读原文 → 改文本 → 写回）');
      ok(/markSelfWrite\(/.test(fp), '登记"我们自己写的"（否则判成外部改动）');
      ok(
        !fp.includes('processFrontMatter('),
        '🔴 不走属性写口（守卫就是为这类前言设的、往返还会弄坏形状）',
      );
      ok(/fixFrontmatter\(/.test(fp), 'AI 路走服务层 fixFrontmatter（出稿前已过校验）');
    });
  });

  await suite.group('P7.16b · 静态（原生面板那一格的出口纪律与契约面）', async () => {
    const root16b = path.resolve(__dirname, '..', '..');
    const stripTs16b = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read16b = (rel: string): string =>
      stripTs16b(fs.readFileSync(path.join(root16b, rel), 'utf8'));

    await suite.it('新面只当"发起者"：不直连 mover/confirm、不 new NotesOps，走共享链的模块级函数', () => {
      const np = read16b('src/ui/native-position.ts');
      ok(!/mover\s*\.\s*move\(/.test(np), '🔴 原生面板那一格不许自己调 mover（唯一出口是共享链）');
      ok(!/\bconfirm\s*\(/.test(np), '🔴 确认流不许在它这儿另起一份（跑的是 runSetPositionByMove 里那条）');
      ok(!/new\s+NotesOps\b/.test(np), '🔴 不 import 那个类（它要 ctx + refresh，新面给不出）');
      ok(/runSetPositionByMove\(/.test(np), '★ 选目录 = 共享链（与另两处同一份实现）');
      ok(/runDeclarePositionHere\(/.test(np), '★ 「就住这儿」也是共享链');
      ok(/import \{ positionItems \} from '\.\.\/modules\/notes\/menus'/.test(np), '★ 候选用 positionItems 同一份实现（不许抄第二份口径）');
      const ops = read16b('src/modules/notes/ops.ts');
      ok(/export async function runSetPositionByMove\(/.test(ops), '共享链的实现在 ops.ts 的模块级函数上');
      ok(/export async function runDeclarePositionHere\(/.test(ops), '……「就住这儿」那条也在');
      // P7.18b：补声明口径收进 mover 第 7 步（"选目录"链不再有专属收尾；旧的注释口径已反转）
      /**
       * ⚠️ **P7.18b 反转**（用户 2026-10-09 拍板"任何搬动之后声明 = 实际落点"）：
       * 旧的专属收尾 `declareLandingsAfterMove` **已删**（口径上收进 `mover` 第 7 步）——
       * 两处各写一份必漂；现在只有 mover 一处。
       */
      ok(!/declareLandingsAfterMove/.test(ops), '★ 专属补声明收尾已删（并进 mover 第 7 步）');
      const mv18b = read16b('src/services/mover.ts');
      ok(
        !/if \(declared\.length === 0\) continue/.test(mv18b),
        '★ mover 第 7 步不再跳过"未声明"（任何搬动都写实际落点）',
      );
      /**
       * ⚠️ **P7.18b 反转**：旧断言"mover 的属性跟随照旧'没声明就跳过'（拖拽口径未动）"
       * 已废 —— 用户 2026-10-09 拍板全统一，mover 第 7 步对未声明**也写**（断言见上一条）。
       */
    });

    await suite.it('遮蔽平台建议的类名两处同源 + 作用域 CSS 在册', () => {
      const np = read16b('src/ui/native-position.ts');
      ok(np.includes("'kbw-native-menu-open'"), 'TS 里的类名（NATIVE_MENU_OPEN_CLASS）在');
      const css = fs.readFileSync(path.join(root16b, 'styles/menu.css'), 'utf8');
      const hit = cssRules(css).find(
        (r) =>
          r.sel.includes('body.kbw-native-menu-open') &&
          r.sel.includes('.suggestion-container.mod-property-value'),
      );
      ok(hit != null, '★ 作用域 CSS 在（body 类 + 平台属性建议那条选择器）');
      ok(/display\s*:\s*none/.test(hit?.body ?? ''), '……而且是把它藏起来（display:none）');
    });

    await suite.it('小窗订阅里有"目录改名"分支（按 children 认目录 —— 文件改名走索引那条）', () => {
      const ed = read16b('src/modules/board/editor.ts');
      ok(/\.children\s*!==\s*undefined/.test(ed), '★ 目录分支在（P7.16 独立审 🟡#4 的回销）');
      ok(/repaintPropsQuiet\(t\)/.test(ed), '……重画走既有那条（不另拼 DOM）');
    });
  });

  await suite.group('P7.17 · 静态（修洞 / D1 / 覆盖 / 入口的出口纪律）', async () => {
    const root17 = path.resolve(__dirname, '..', '..');
    const stripTs17 = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read17 = (rel: string): string =>
      stripTs17(fs.readFileSync(path.join(root17, rel), 'utf8'));

    await suite.it('存量补齐的「旧值 / 认不出 / 建议值」只有迁移表一个出处（backfill 引 migrate）', () => {
      const bf = read17('src/services/backfill.ts');
      ok(/from '\.\/migrate'/.test(bf), '★ backfill 从 migrate 取映射（别在这抄一份）');
      ok(/legacyValueFix\(/.test(bf), '旧值判定走 legacyValueFix');
      ok(/suggestValueFor\(/.test(bf), '认不出的建议值走 suggestValueFor');
      const mg = read17('src/services/migrate.ts');
      ok(/export function legacyValueFix\(/.test(mg), '…而这两口就长在 migrate.ts 里');
      ok(/export function suggestValueFor\(/.test(mg), '……同一处');
      ok(/export const TYPE_MAP_V2/.test(mg), '映射表本体也在那（TYPE_MAP_V2）');
    });

    await suite.it('D1：扫描与写盘两侧的 withPosition 同源（一边改了另一边不红 = 幂等判据会咬）', () => {
      const bf = read17('src/services/backfill.ts');
      ok(/withPosition: true/.test(bf), '★ 扫描（planBackfill）这边写死 true（D1：文件位置=实际落点）');
      const bp = read17('src/ui/backfill-panel.ts');
      ok(/fillFile\(file, \{ withPosition: true \}\)/.test(bp), '★ 写盘（面板）这边也传 true —— 两处必须一致');
    });

    await suite.it('修洞接线：有前言走"按行合并补缺键"（mergeMissingTemplateKeys），不是"不补"', () => {
      const tp = read17('src/services/templates.ts');
      ok(/export function mergeMissingTemplateKeys\(/.test(tp), '★ 合并口在（fill 模式）');
      ok(/mergeYamlBlock\(text, opts, 'fill'\)/.test(tp), '……与 mergeTemplateYaml 同一台机器（参数化复用）');
      const cf = read17('src/services/completion.ts');
      ok(/yamlMode === 'replace'/.test(cf), '★ 写口认 replace（整块替换）—— 拼开头那条路只留给"整篇没前言"');
      ok(/replaceFrontmatterBlock\(/.test(cf), '……替换函数真的存在（不是只认标志不干活）');
    });

    await suite.it('入口两处同数：向导卡与设置提示都走 planTodoCount（不许各算各的）', () => {
      const wz = read17('src/ui/wizard.ts');
      ok(/openBackfillPanel/.test(wz), '★ 向导「去补全」接的是补全面板');
      ok(/planTodoCount\(/.test(wz), '★ 询问卡的 N 走 planTodoCount（与面板同一个数）');
      ok(/planBackfillOf\(/.test(wz), '……数从 planBackfillOf 现算（异步扫、卡先出）');
      const au = read17('src/ui/settings/automation.ts');
      ok(/planTodoCount\(/.test(au), '★ 设置那条「当前 N 篇可补」同一个数');
      ok(/planBackfillOf\(/.test(au), '……同样现算');
    });

    await suite.it('归集夹常量两处同值（rebuild 导出 vs reconcile 私有 —— 改一处必须两处一起改）', () => {
      const rb = read17('src/services/rebuild.ts');
      const rc = read17('src/services/reconcile.ts');
      const grab = (src: string, name: string): string | undefined =>
        new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(src)?.[1];
      eq(grab(rb, 'COLLECT_PARENT'), '04_Archives', 'rebuild 侧的归集夹父目录');
      eq(grab(rc, 'COLLECT_PARENT'), grab(rb, 'COLLECT_PARENT'), 'reconcile 侧逐字一致（防两处各写一份漂掉）');
      eq(grab(rc, 'COLLECT_PREFIX'), grab(rb, 'COLLECT_PREFIX'), '前缀同理');
      ok(/isCollectDir\(want\)/.test(rc), '★ 自动归位的目标要过"归集夹"守卫（P7.17 真机残留的护栏）');
    });

    await suite.it('覆盖区只碰 类型 / 状态（D2）：写链走 fm.set 单键，不整篇重写', () => {
      const bp = read17('src/ui/backfill-panel.ts');
      ok(/ctx\.fm\.set\(file, cv\.key, cv\.to\)/.test(bp), '★ 覆盖写链 = fm.set(单键)（不是 fm.update / 整篇重写）');
      ok(!/fm\.update\(/.test(bp), '……不许出现 fm.update（那是整篇改写口）');
      const bf = read17('src/services/backfill.ts');
      ok(/for \(const key of \['类型', '状态'\] as const\)/.test(bf), '★ 值档只扫这两个键');
    });
  });

  await suite.group('P7.18 · 静态（退出清理的出口纪律）', async () => {
    const root18 = path.resolve(__dirname, '..', '..');
    const stripTs18 = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const read18 = (rel: string): string =>
      stripTs18(fs.readFileSync(path.join(root18, rel), 'utf8'));

    await suite.it('删除链三条：确认流 → 快照 → 再执行（顺序在源码里也钉住）', () => {
      const cp = read18('src/ui/cleanup-panel.ts');
      const iConfirm = cp.indexOf('await confirm(');
      const iCapture = cp.indexOf('ctx.snapshot.capture(');
      const iRemove = cp.indexOf('ctx.fm.remove(');
      const iTrash = cp.indexOf('fileManager.trashFile(');
      ok(iConfirm >= 0, '★ 动库前确认走 ui/confirm（唯一出口）');
      ok(iCapture > iConfirm, '★ 快照排在确认之后（用户点了才拍）');
      ok(iRemove > iCapture, '★ 删键排在快照之后（快照先行）');
      ok(iTrash > iCapture, '★ 删足迹也排在快照之后');
    });

    await suite.it('删键只走 fm.remove（批量口）；不许 fm.update / 裸 processFrontMatter', () => {
      const cp = read18('src/ui/cleanup-panel.ts');
      ok(/ctx\.fm\.remove\(/.test(cp), '★ fm.remove 批量删除（一次一篇的原子写）');
      ok(!/fm\.update\(/.test(cp), '……不出现 fm.update（那是整篇改写口）');
      ok(!/processFrontMatter/.test(cp), '……不自己碰 processFrontMatter（服务层口径）');
    });

    await suite.it('足迹删除：trashFile + 删完复查；目录壳 rmdir recursive；认不出的不删', () => {
      const cp = read18('src/ui/cleanup-panel.ts');
      ok(/fileManager\.trashFile\(/.test(cp), '★ 走回收站语义的 trashFile');
      ok(
        /还没删掉（Obsidian 的「删除文件」设置/.test(cp),
        '★ 删完复查（trashOption: none 静默不做的对策，照 mover.trash）',
      );
      ok(/adapter\.rmdir\(f\.path, true\)/.test(cp), '★ 目录壳 rmdir recursive=true（P5 EISDIR 教训）');
      ok(/kind !== 'dir'/.test(cp), '……摘壳只对目录做（单文件项不动目录）');
    });

    await suite.it('🔴 本面板不写库内日志（日志目录就在被清名单里 —— 有意与其它面板不同）', () => {
      const cp = read18('src/ui/cleanup-panel.ts');
      ok(!/ctx\.report\.log\(/.test(cp), '★ 不出现 ctx.report.log（写了就"永远差一条"）');
      ok(!/report\.openLatest\(/.test(cp), '……也不指"查看报告"（这次没有库内报告可看）');
    });

    await suite.it('范围与键单：与存量补全同一份范围口径；CLEANUP_KEYS 与 schema 的键真对照', () => {
      const cl = read18('src/services/cleanup.ts');
      ok(/from '\.\/backfill'/.test(cl), '★ 范围共用 backfill 的 inBackfillScope（不抄第二份）');
      ok(/inBackfillScope\(/.test(cl), '……真的调了它');
      const m = /CLEANUP_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(cl);
      ok(m, 'CLEANUP_KEYS 在');
      for (const k of ['类型', '状态', '文件位置', '创建日期', 'tags', '收藏', '位置锁定', '隐藏', '来源']) {
        ok((m?.[1] ?? '').includes(`'${k}'`), `★ 清键单含「${k}」`);
      }
      /**
       * **真对照**（独立审 🟡7 的回销 —— 别只查字面，"说验过但没验准"的同一类）：
       * `schema.SPECS` 加新键时**这里会红** —— 逼你来想"这个键要不要进退出清理清单"。
       * 将来若出现"有意不进清理"的 schema 键，来这里有意识地改判据（像命令面板 5 条那样）。
       */
      eq(
        [...CLEANUP_KEYS].sort().join('、'),
        SPECS.map((s) => s.name)
          .sort()
          .join('、'),
        '★ 清理清单与 schema 的全部键一一对应',
      );
    });

    await suite.it('入口挂「数据」栏；危险两段确认（上膛文案 + irreversible 由 trashOption 决）', () => {
      const sp = read18('src/ui/settings-panel.ts');
      const data = /compose\('data',[\s\S]*?\]/.exec(sp)?.[0] ?? '';
      ok(/makeCleanupSection\(\)/.test(data), '★ 数据栏的 parts 里有退出清理块');
      const sc = read18('src/ui/settings/cleanup.ts');
      ok(/退出插件前的清理/.test(sc), '★ 行名「退出插件前的清理…」');
      ok(/openCleanupPanel\(/.test(sc), '……打开的是清理面板');
      const cp = read18('src/ui/cleanup-panel.ts');
      ok(/danger:\s*\{/.test(cp), '★ 走 danger 两段确认（照删除模板先例）');
      ok(/再点一次确认/.test(cp), '……上膛文案在');
      ok(
        /trashOption\(\)\s*!==\s*'local'/.test(cp),
        '……irreversible 由 trashOption 决（system 回收站不可程序化拿回）',
      );
    });

    await suite.it('补尾链链的汇总措辞与「也会补缺键」对齐（P7.17 欠账 🟡3 的回销）', () => {
      const og = read18('src/ui/organize.ts');
      ok(!/已补尾链/.test(og), '★ 撤销条不再只说"尾链"（fillFile 现在也补缺键）');
      ok(!/篇的「## 关联笔记」段/.test(og), '……日志汇总同款');
      ok(/缺的键与尾链/.test(og), '……新措辞在（改动真的落了）');
    });
  });

  // ════════════════════════════════════════════════════════════
  /**
   * P8 回顾：三条红线。为什么必须钉：卡片是**派生数据** ——
   * 一不小心就会"顺手把掌握度写进笔记属性"（属性 v2 刚精简过）或"绕过 config-files
   * 裸写库内 JSON"（唯一真源原则）。两条都是本项目反复记过的账，不靠人肉 review。
   * 判据照既有那套：**先剥注释再扫源码**。
   */
  await suite.group('P8 · 红线（回顾的硬规矩钉在源码里）', async () => {
    const projRoot = path.resolve(__dirname, '..', '..');
    const stripSrc = (abs: string): string =>
      fs
        .readFileSync(abs, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const svc = stripSrc(path.join(projRoot, 'src/services/review.ts'));
    const modSrc = tsFilesUnder(path.join(projRoot, 'src/modules/review'))
      .map((f) => stripSrc(f))
      .join('\n');
    const flow = stripSrc(path.join(projRoot, 'src/ui/review-create.ts'));

    await suite.it('卡片数据只走 config-files：回顾服务不许裸写库内 JSON', () => {
      ok(!/adapter\.write/.test(svc), '复习服务不许裸 adapter.write（真库同步就在同一进程里跑）');
      ok(!/vault\.create\s*\(/.test(svc), '复习服务不许自己 vault.create（落盘只能过 configs.write）');
      ok(!/vault\.process\s*\(/.test(svc), '复习服务不许自己 vault.process');
      ok(/configs\.write\(/.test(svc), '写链 = configs.write（库内 JSON 的唯一写点）');
    });

    await suite.it('不许写笔记属性：卡片是派生数据，不进 frontmatter', () => {
      ok(!/processFrontMatter/.test(svc), '复习服务不许碰 processFrontMatter');
      ok(!/fm\.setMany/.test(svc), '复习服务不许 fm.setMany');
      ok(!/\.fm\./.test(svc), '复习服务根本不接 frontmatter 服务');
    });

    await suite.it('建卡链与回顾模块不许自己动文件（动文件只能过 mover）', () => {
      ok(!/renameFile\s*\(/.test(modSrc + flow), '回顾模块/建卡链不许 renameFile（迁键读的是平台事件）');
      ok(!/trashFile\s*\(/.test(modSrc + flow), '不许 trashFile（删卡只是删库内一条记录）');
      ok(!/vault\.delete\s*\(/.test(modSrc + flow), '不许 vault.delete');
      ok(!/vault\.create\s*\(/.test(modSrc + flow), '不许 vault.create（卡片不建笔记）');
    });

    await suite.it('建卡链必须过确认流（硬规矩 #3）：断**剥过注释的**源码里的调用点', () => {
      /**
       * ⚠️ 剥注释那一步是**判据的前提**，不是讲究：文件头注释里就写着「`ui/confirm.ts`
       * 的确认流」这类话，拿原文匹配 = 注释一命中、判据恒真（这类账本项目记过）。
       */
      ok(/from '\.\/confirm'/.test(flow), '★ 建卡链 import 了确认流（剥过注释的源码）');
      ok(/confirm\(/.test(flow), '……真的调了它（一次确认、一次落盘）');
      ok(/addCards\(/.test(flow), '……落库走 addCards（一次写盘，不逐张写）');
    });
  });

  // ════════════════════════════════════════════════════════════
  /**
   * **模块清单契约**（P8 · 老账）：`MODULE_IDS` 与 `方案设计.md` §9 的「最终模块命名」
   * 互为真源 —— 只改代码不回文档（或反过来），这条当场红。
   * 锚点：`方案设计.md` 里那一行权威清单（反引号内、` / ` 分隔、以「回顾」收尾的**唯一**一行）。
   */
  await suite.group('P8 · 契约（模块清单 ↔ 文档）', async () => {
    const projRoot = path.resolve(__dirname, '..', '..');
    await suite.it('模块清单契约：MODULE_IDS ↔ 方案设计.md 的导航清单（**顺序也钉**）', async () => {
      const doc = fs.readFileSync(path.join(projRoot, '方案设计.md'), 'utf8');
      const line = doc.split('\n').find((l) => /`[^`]*首页[^`]*回顾[^`]*`/.test(l)) ?? '';
      ok(line !== '', '方案设计.md 里找不到导航清单的锚点（反引号里 `首页 / … / 回顾` 那一行）');
      const inDoc = (line.match(/`([^`]*)`/)?.[1] ?? '')
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      const inSrc = MODULE_IDS.map((id) => MODULES[id].label);
      eq(inDoc.join(','), inSrc.join(','), '文档清单与 MODULE_IDS 不一致（顺序也要一致）');
    });
  });

}

/**
 * 把一份 CSS 拆成"选择器表 + 声明块"（**递归判据用**，别拿正则去抓文本）。
 *
 * ⚠️ `sel` 取的是**最后一个 `{` 之后**那一段 —— `@media (…) { .x {…} }` 这种嵌套
 * 在简单切法下会把 `@media … {` 混进选择器里，取最后一段就干净了。
 * ⚠️ 它**不是**完整的 CSS 解析器（不认字符串里的花括号），够这里用：
 * 这里只问"哪条规则在什么选择器下把东西藏起来"。
 */
function cssRules(src: string): { sel: string; body: string; at: string }[] {
  const out: { sel: string; body: string; at: string }[] = [];
  /**
   * 🔴 **先剥注释**（本项目在静态断言上栽过一次又一次）：注释里写一句
   * 「别改成 `.kbw-modal-foot { display:none }` 那种写法」的话，会被当**真规则**读进来 ——
   * 这一版就这么假红过（报的是注释里那半句话）。
   */
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
  /**
   * 某条规则**所处的 @media 头**（独立审 🟢2 加）：从规则位置往回找最近一个
   * **还没闭合**的 `@media`（按花括号配平数到规则位置）。
   * ⚠️ 不能从正则的 group1 里取 —— `[^{}]*` 不允许跨花括号，外层 `@media` 的 `{`
   * 根本进不了 group1（第一版就这么取到空串，当场假红）。
   */
  const mediaAt = (idx: number): string => {
    for (let i = text.lastIndexOf('@media', idx); i >= 0; i = text.lastIndexOf('@media', i - 1)) {
      let depth = 0;
      let closed = false;
      for (let j = i; j < idx; j += 1) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') {
          depth -= 1;
          if (depth <= 0) {
            closed = true;
            break;
          }
        }
      }
      if (!closed && depth > 0) {
        const brace = text.indexOf('{', i);
        return brace >= 0 ? text.slice(i, brace + 1).trim() : text.slice(i, i + 40);
      }
    }
    return '';
  };
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    out.push({
      sel: raw.slice(raw.lastIndexOf('{') + 1).trim(),
      body: m[2],
      at: mediaAt(m.index),
    });
  }
  return out;
}

/**
 * 把某个目录下所有 `.ts` 列出来（**递归**）。
 *
 * d2 那条"模块侧不许 import 视图"要对 `src/modules` 整棵树设防 ——
 * 只扫已知的那几个文件等于"以后新加的文件不受约束"，而那正是最容易破防的地方。
 */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}
