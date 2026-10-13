/**
 * spec：**P6 段④ · 首次使用向导**（2026-09-28）—— 交互规格 §14
 *
 * 三条要钉住的：
 *   ① **判据**是纯函数 `shouldShowWizard()`（`wizardDone` 三态 + 默认值双判），四态各一条
 *   ② **触发时机** = 打开工作台那一刻（不是插件加载期）—— 四条形态各起一个实例真跑
 *   ③ **第 1 步要真的生效**：改完目录名，**索引真的重建了**（判据落在篇数上，
 *      不是"设置里存进去了" —— 存进去了而索引没重建是本项目的经典假绿形态）
 *
 * ⚠️ **负向判据两条**（`'done'` 与 `'configured'` 都不许弹）：
 * 少了它们，"永远弹"也会绿。
 *
 * ⚠️ 这里**每条形态各起一个插件实例**（`bootPlugin` 的 `wizard` 选项）——
 * 因为"弹不弹"是 `onload → activate` 那一刻的属性，改设置改不出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import type { BootOptions } from '../helpers';
import { DEFAULT_SETTINGS, shouldShowWizard } from '../../src/core/settings';

type Mode = NonNullable<BootOptions['wizard']>;

export async function specWizard(suite: Suite): Promise<void> {
  // ════════════════════════════════════════════════════════════
  // §A 判据（纯函数 —— 四态逐条）
  // ════════════════════════════════════════════════════════════
  await suite.group('P6④ 向导 · 「从未配置过」的判据（纯函数）', async () => {
    const D = { kbRoot: DEFAULT_SETTINGS.kbRoot, metaDir: DEFAULT_SETTINGS.metaDir };
    const C = { kbRoot: '02_别的库', metaDir: '别的元数据' };

    await suite.it('四态逐条：true 不弹 · false 弹 · null+默认路径 弹 · null+改过路径 不弹', () => {
      eq(shouldShowWizard({ wizardDone: true, ...D }), false, '走完过 → 不再弹（负向）');
      eq(shouldShowWizard({ wizardDone: true, ...C }), false, '走完过（改过路径也是）→ 不再弹');
      eq(shouldShowWizard({ wizardDone: false, ...D }), true, '点过「稍后」→ 下次还来');
      eq(shouldShowWizard({ wizardDone: false, ...C }), true, '点过「稍后」→ 下次还来（与路径无关）');
      eq(shouldShowWizard({ wizardDone: null, ...D }), true, '🔴 存量 data.json（没这个键）+ 默认路径 → 认作没配过');
      eq(shouldShowWizard({ wizardDone: null, ...C }), false, '🔴 没这个键但路径改过 → 那就是配过（别打扰）');
    });

    await suite.it('只改一半路径（改了 metaDir）也算"配过"', () => {
      eq(
        shouldShowWizard({ wizardDone: null, kbRoot: DEFAULT_SETTINGS.kbRoot, metaDir: '别的元数据' }),
        false,
        '两个路径**都**是默认值才算没配过 —— 只判一个会在"改了元数据目录"那种库上反复弹',
      );
    });
  });

  // ════════════════════════════════════════════════════════════
  // §B 触发时机（各起一个实例真跑）
  // ════════════════════════════════════════════════════════════
  await suite.group('P6④ 向导 · 什么时候弹（打开工作台那一刻）', async () => {
    /** 起一个指定形态的实例并打开工作台；返回有没有弹 */
    async function bootAndOpen(mode: Mode, name: string): Promise<{ b: H.Booted; shown: boolean }> {
      const vault = H.makeTempVault(name);
      const b = await H.bootPlugin(vault, { wizard: mode });
      H.resetDom();
      await b.plugin.activate();
      await H.settle(60);
      return { b, shown: !!H.maybe(document.body, '.kbw-wiz-steps') };
    }

    await suite.it('`fresh`：全新 data.json（路径默认 + 没那个键）→ 弹（落在引言屏）→ 跳过介绍进第 1 步', async () => {
      const { b, shown } = await bootAndOpen('fresh', 'wizard-fresh');
      ok(shown, '弹了');
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      // P7.2b 改版：先落在**引言屏**（两栏对照），可整段跳过
      ok(H.maybe(modal, '.kbw-wiz-intro'), '引言屏画出来了（原生 vs 经纬两栏）');
      const skip = H
        .qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn')
        .find((x) => H.textOf(x).includes('跳过介绍'));
      ok(skip, '引言屏的跳过按钮写着「跳过介绍」');
      H.click(skip as Element);
      await H.settle(90);
      const steps = H.textsOf(modal, '.kbw-wiz-step');
      // v2（P7.12 · #3）：第 3 格「到处看看」加上了（结语屏自己就是它）
      eq(steps.length, 3, '三格都在条上');
      contains(steps[0], '工作文件夹', '第 1 步是工作文件夹');
      contains(steps[2], '到处看看', '第 3 步是「到处看看」');
      /**
       * P7.11 · #11（Q8 拍板）：**不预选** —— 未选时下方什么都不画；
       * 点某张卡才出内容区（「用现成的」输入框预填当前值）。
       * ⚠️ P7.12 · #8 → **P7.14**：选项从两张卡长成**三张**（第三张「整个库」，
       * 用户 2026-10-08 拍板）—— textOf 是拼接文本（svg 图标不带文本），标题/小字照旧逐字。
       */
      const opts = H.qa<HTMLElement>(modal, '.kbw-wiz-opt');
      eq(opts.length, 3, '三张选择卡');
      eq(
        opts.map((o) => H.textOf(o)).join('|'),
        '新建起个名字|用现成的选已有文件夹|整个库不用再选文件夹',
        '卡内文案与 DOM 顺序（新建 → 用现成的 → 整个库）',
      );
      ok(!opts.some((o) => o.classList.contains('is-on')), '默认一个都不选（丢掉"按现状猜"）');
      // 独立审 B4（P7.12 收尾）：原来钉的是 `.kbw-wiz-radio` 不存在 —— 该类已随 #1 从 src
      // 删掉，"不存在"恒真。改钉**新形态**：#8 卡片化后每张卡带图标（图标+标题+小字）。
      ok(opts.every((o) => o.querySelector('svg')), '三张卡各带图标（#8 卡片化形态）');
      eq(
        H.qa(modal, '.kbw-wiz-field .kbw-input').length,
        0,
        '未选 → 下方什么都不画（没有输入框）',
      );
      H.click(opts[1]);
      await H.settle(80);
      eq(
        H.qa<HTMLInputElement>(modal, '.kbw-wiz-field .kbw-input')[0]?.value,
        DEFAULT_SETTINGS.kbRoot,
        '点「用现成的」→ 内容区出来，工作文件夹预填当前值',
      );
      // P7.14：第三张卡「整个库」—— 只出「库配置目录」一个字段（整库模式没有"工作文件夹"可填）
      H.click(opts[2]);
      await H.settle(80);
      const fields = H.qa<HTMLElement>(modal, '.kbw-wiz-field');
      eq(fields.length, 1, '「整个库」分支只出一个字段');
      contains(H.textOf(fields[0]), '库配置目录', '……那个字段是「库配置目录」');
      eq(
        H.qa<HTMLInputElement>(modal, '.kbw-wiz-field .kbw-input')[0]?.value,
        DEFAULT_SETTINGS.metaDir,
        '库配置目录预填当前值',
      );
      await H.shutdown(b.plugin);
    });

    await suite.it('负向①：`done`（走完过）→ **一次都不许弹**', async () => {
      const { b, shown } = await bootAndOpen('done', 'wizard-done');
      eq(shown, false, '不弹');
      eq(H.maybe(document.body, '.kbw-modal'), null, '屏幕上没有模态');
      await H.shutdown(b.plugin);
    });

    await suite.it('负向②：`configured`（键是 null 但路径改过）→ 也不许弹', async () => {
      const { b, shown } = await bootAndOpen('configured', 'wizard-configured');
      eq(shown, false, '不弹（老用户升级上来不该被向导拦住）');
      await H.shutdown(b.plugin);
    });

    await suite.it('`later`（点过「稍后」）→ 下次打开工作台还会来', async () => {
      const { b, shown } = await bootAndOpen('later', 'wizard-later');
      ok(shown, '又弹了（「稍后」的语义就是"下次再说"）');
      await H.shutdown(b.plugin);
    });

    await suite.it('🔴 **同一次会话里最多弹一次**（会话旗标；这一条原来零覆盖）', async () => {
      /**
       * 独立审查 B🔴3：原来那句"同一次会话里不会再来一次"被 `wizardDone === true` **挡着** ——
       * 那一刻它本来就返回 false，**换成"没有会话旗标的世界"照样绿**。
       * 两道守卫管的是**不同的事**：`wizardDone` 管"以后还弹不弹"，会话旗标管"**这一次会话里**弹过没有"。
       * 只有 `wizardDone === false`（点过「稍后」）+ 同一会话再打开工作台，才**只有旗标**挡得住 ——
       * 下面这条就是那个组合。
       */
      const vault = H.makeTempVault('wizard-session');
      const b = await H.bootPlugin(vault, { wizard: 'later' }); // wizardDone: false
      H.resetDom();
      await b.plugin.activate();
      await H.settle(60);
      ok(H.maybe(document.body, '.kbw-wiz-steps'), '第一次打开工作台：弹');

      // 点「跳过教程」收掉 —— 此时 `wizardDone === false`，「下次打开」按判据是**还会弹的**
      // （P7.10 二拍②：按钮由「稍后」改名，语义不变）
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const later = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) =>
        H.textOf(x).includes('跳过教程'),
      );
      H.click(later as Element);
      await H.settle(80);
      eq(b.plugin.context().settings.get().wizardDone, false, '记成"跳过教程"了');
      eq(H.maybe(document.body, '.kbw-wiz-steps'), null, '向导收掉了');

      // ⚠️ 关掉模态之后**再**打开一次 —— 连着 activate 两次的话第二次什么也不会发生
      //   （第一次已经弹过、模态还开着），那样测的是空气（审查者第一版就踩了这个）
      await b.plugin.activate();
      await H.settle(120);
      eq(
        H.maybe(document.body, '.kbw-wiz-steps'),
        null,
        '🔴 同一次会话里第二次打开工作台 —— **会话旗标**该挡住它（wizardDone=false 挡不住）',
      );
      await H.shutdown(b.plugin);
    });

    await suite.it('🔴 直接关掉（点 ✕）按「稍后」处理 —— `onClose` 那一行原来零覆盖', async () => {
      /**
       * 独立审查 B🟡2：`wizard.ts` 的 `onClose`（"Esc / 点 X 也算稍后"）没有任何判据 ——
       * 两条出口用例走的都是「稍后」/「完成」按钮。
       * 这里点 ✕（与 Esc 走的是**同一个** `onClose` 分支）。
       */
      const vault = H.makeTempVault('wizard-close');
      const b = await H.bootPlugin(vault, { wizard: 'fresh' });
      H.resetDom();
      await b.plugin.activate();
      await H.settle(60);
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(modal, '向导开着');
      const x = modal.querySelector<HTMLElement>('.kbw-modal-head .kbw-iconbtn');
      ok(x, '头上有 ✕');
      H.click(x as Element);
      await H.settle(80);
      eq(H.maybe(document.body, '.kbw-wiz-steps'), null, '关掉了');
      eq(
        b.plugin.context().settings.get().wizardDone,
        false,
        '✕ 也按「稍后」记账（关掉一次 = 下次还来，这是刻意选成确定性的——不给"关掉就等于永远不再出现"这种猜用户意思的分支）',
      );
      await H.shutdown(b.plugin);
    });
  });

  // ════════════════════════════════════════════════════════════
  // §C 走一遍（两步 / 跳过 / 出口 / 第 1 步真的生效 / 全程只读）
  // ════════════════════════════════════════════════════════════
  await suite.group('P6④ 向导 · 走一遍', async () => {
    const vault = H.makeTempVault('wizard-walk');
    const { app, plugin } = await H.bootPlugin(vault, { wizard: 'fresh' });
    const ctx = () => plugin.context();

    /**
     * **库内全部文件的清单**（内容 + 路径）—— "第 3 步是只读的"那条判据用它。
     *
     * 🔴 **不能只看 `.md`**（独立审查 A🔴1 抓到的真缺陷）：向导第 3 步原来调的是
     * `configs.ensure('rebuild')`，而 `ensure` 是"不存在就把默认值写下去 + mkdir 祖先" ——
     * 它建出来的是 **`<kbRoot>/<metaDir>/06_工作台/库结构.json`**（一个 `.json`）
     * 加上一整棵目录。第一版这条判据只 hash `.md`，于是**四层判据全都看不见它**
     * （探针只数 `getMarkdownFiles()`、红线只查裸写 API、真机实验库里那个文件本来就存在）。
     * 它只在"**从没用过工作台的库**"上现形 —— 恰恰是向导存在的那个场景。
     * ⇒ **全库、全扩展名、路径 + 内容一起比**。
     */
    function snapshotKb(): string {
      return H.listFiles(vault, '')
        .filter((p) => !p.includes('.obsidian'))
        .map((p) => `${p}:${H.readNote(vault, p)}`)
        .sort()
        .join('\n');
    }

    /** 找模态底部的按钮（按文字） */
    function foot(text: string): HTMLElement {
      const m = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const b = H.qa<HTMLElement>(m, '.kbw-modal-foot .kbw-btn').find((x) => H.textOf(x).includes(text));
      ok(b, `底部有「${text}」`);
      return b as HTMLElement;
    }

    H.resetDom();
    await plugin.activate();
    await H.settle(60);

    await suite.it('弹出来了，且第 1 步真的改得动（输入 → 下一步 → 落盘）', async () => {
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(modal, '向导开着');
      const before = ctx().index.size();
      ok(before > 0, `起手索引非空（${before} 篇）—— 不然"篇数跟着变"这条测的是空气`);

      // P7.2b：引言屏先「下一步」进第 1 步
      H.click(foot('下一步'));
      await H.settle(90);

      // P7.11 · #11：先选「用现成的」才有输入框（未选 → 下方什么都不画）
      const pickMode = (word: string): void => {
        const o = H
          .qa<HTMLElement>(modal, '.kbw-wiz-opt')
          .find((x) => H.textOf(x).includes(word));
        ok(o, `前提：找得到「${word}」选项`);
        H.click(o as Element);
      };
      pickMode('用现成的');
      await H.settle(80);

      // 换成库根下一个**真有笔记**的子目录：变的是"工作台看哪一片"
      const input = H.qa<HTMLInputElement>(modal, '.kbw-wiz-field .kbw-input')[0];
      ok(input, '工作文件夹那个输入框在');
      input.value = `${DEFAULT_SETTINGS.kbRoot}/02_Areas`;
      input.dispatchEvent(new Event('input'));
      await H.settle(20);
      H.click(foot('下一步'));
      await H.settle(200);

      eq(ctx().settings.kbRoot(), `${DEFAULT_SETTINGS.kbRoot}/02_Areas`, '设置里真的改了');
      const after = ctx().index.size();
      ok(after > 0, `索引还建得起来（${after} 篇）`);
      ok(after < before, `🔴 索引真的重建了：${before} → ${after}（存进去而没重建 = 经典假绿）`);
      contains(H.textOf(document.body), '模块开关', '进到第 2 步了');
    });

    await suite.it('P7.10 · 标题随屏切换 + 「上一步」三段行为 + 「跳过教程」文案（#1/#5/#6）', async () => {
      /**
       * 三件一起验（都是 P7.10 域 A 的）：
       *  · #1 标题随屏切（引言长 / 其余短）——走的是 `PanelHandle.setTitle` 那条口；
       *  · #5 「上一步」：引言不画 · 第 1 步起出现 · **退回不落盘** ·
       *    跳过后退回再前进**重新走跳过判定**（这一趟就走到了保存那一下）；
       *  · #6 副标题 =「约 1 分钟 · 可在设置中再次观看」（「每步可跳过」不再写）。
       * 进组状态：上一条跑完停在第 2 步、kbRoot 已落盘为 `<库根>/02_Areas`。
       *
       * ⚠️ **子集跑的自足**（`KBW_TEST_ONLY` 会把上面那条造状态的用例过滤掉，而 group 顶层
       * 照跑）：起手可能停在**引言屏**、kbRoot 也可能还是默认值 —— 所以这里
       * ①自己往前走到第 2 步（kbRoot 值没变时"正向离开第 1 步"的 `changed=false` 不落盘，
       * 顺手也不污染）；②**基线 kbRoot 是现读的**，不是写死 02_Areas。
       */
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const footTexts = (): string[] =>
        H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').map((b) => H.textOf(b));
      const footBtn = (text: string, exact = false): HTMLElement =>
        H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((b) =>
          exact ? H.textOf(b) === text : H.textOf(b).includes(text),
        ) as HTMLElement;
      const titleText = (): string =>
        H.textOf(H.q<HTMLElement>(modal, '.kbw-modal-title') as HTMLElement);
      const kbBase = ctx().settings.kbRoot(); // 起手基线（全量里 = <库根>/02_Areas）
      if (H.maybe(modal, '.kbw-wiz-intro')) {
        H.click(footBtn('下一步', true));
        await H.settle(90);
      }
      if (H.qa(modal, '.kbw-wiz-toggle').length === 0) {
        H.click(footBtn('下一步', true)); // 第 1 步 → 第 2 步
        await H.settle(120);
      }

      // ① 第 2 步：短标题；「上一步」「跳过教程」都在；旧文案「稍后」不在了
      eq(titleText(), '首次使用向导', '#1：第 2 步回到短标题');
      ok(footTexts().includes('上一步'), '#5：第 2 步有「上一步」');
      ok(footTexts().includes('跳过教程'), '#5：出口按钮叫「跳过教程」');
      ok(!footTexts().some((t) => t.includes('稍后')), '#5：旧文案「稍后」不再出现');

      // ② 上一步 → 第 1 步（还在）
      H.click(footBtn('上一步', true));
      await H.settle(90);
      contains(H.textOf(modal), '工作文件夹', '退回第 1 步');
      ok(footTexts().includes('上一步'), '#5：第 1 步也有「上一步」');

      // ③ 第 1 步改个不存在的目录 → 再退到引言：退回不落盘；引言 = 长标题 + 不画「上一步」
      // P7.11 · #11：先点「用现成的」才有输入框（退回第 1 步时选择**不重置**，
      // 但子集跑里可能从没选过 —— 显式补一下，幂等）
      const existingOpt = H
        .qa<HTMLElement>(modal, '.kbw-wiz-opt')
        .find((x) => H.textOf(x).includes('用现成的'));
      if (existingOpt && !existingOpt.classList.contains('is-on')) {
        H.click(existingOpt);
        await H.settle(80);
      }
      const input = H.q<HTMLInputElement>(modal, '.kbw-wiz-field .kbw-input') as HTMLInputElement;
      input.value = '99_不存在p710';
      input.dispatchEvent(new Event('input'));
      await H.settle(20);
      H.click(footBtn('上一步', true));
      await H.settle(90);
      ok(H.maybe(modal, '.kbw-wiz-intro'), '退回到引言屏');
      eq(titleText(), '首次使用向导 · 为什么用经纬？', '#1：引言屏用长标题');
      eq(footTexts().join('/'), '跳过介绍/跳过教程/下一步', '#5：引言屏不画「上一步」');
      contains(
        H.textOf(H.q<HTMLElement>(modal, '.kbw-modal-sub') as HTMLElement),
        '可在设置中再次观看',
        '#6：副标题新句',
      );
      ok(!H.textOf(modal).includes('每步可跳过'), '#6：旧句「每步可跳过」不再出现');

      // ④ 前进回第 1 步 → 「跳过这一步」→ 第 2 步：跳过不落盘（kbRoot 不动）
      H.click(footBtn('下一步', true));
      await H.settle(90);
      H.click(footBtn('跳过这一步'));
      await H.settle(120);
      eq(ctx().settings.kbRoot(), kbBase, '退回 + 跳过都没落盘（kbRoot 一个字没动）');

      // ⑤ 再退回 → 这次按「下一步」前进：重新走跳过判定 → 保存发生
      H.click(footBtn('上一步', true));
      await H.settle(90);
      H.click(footBtn('下一步', true));
      await H.settle(250);
      eq(ctx().settings.kbRoot(), '99_不存在p710', '跳过后退回再前进 = 重新走跳过判定（这趟保存了）');

      // 还原 kbRoot —— 后面的用例还在这份库上走
      await ctx().settings.save({ kbRoot: kbBase });
      await H.settle(200);
      eq(ctx().settings.kbRoot(), kbBase, 'kbRoot 已还原');
    });

    await suite.it('第 2 步：**两个**开关都真的接线（原来只拨过 automation 那个）', async () => {
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      /**
       * P7.10 · #3（独立审 🟡3 补的正向半边）：**向导这一处** label 必须叫「笔记自动化」——
       * 负向半边（设置栏 / 底栏仍是「自动化」）在 `tests/specs/automation.ts` 的 deepEq 兜着；
       * 这里补的是"把它改回「自动化」、或两行 label 换错位照样绿"的那个洞。
       */
      eq(
        H.textsOf(modal, '.kbw-wiz-toggle-label').join('/'),
        '图谱/笔记自动化',
        '第 2 步两个开关的 label（只向导这一处是「笔记自动化」）',
      );
      const boxes = H.qa<HTMLInputElement>(modal, '.kbw-wiz-toggle .kbw-wiz-check-box');
      eq(boxes.length, 2, '图谱 / 笔记自动化两个开关');
      /**
       * ⚠️ 独立审查 B🟡3：原来**只拨 `boxes[1]`（automation）**，`boxes[0]`（图谱）从没被动过 ——
       * 把图谱那一行整段接错（比如 `gate.set('automation', …)`）**照样全绿**。
       * 两个都拨、都从 `gate` 读回来。
       */
      for (const [i, id] of [[0, 'graph'], [1, 'automation']] as const) {
        const box = boxes[i];
        const was = ctx().gate.isOn(id);
        box.checked = !was;
        box.dispatchEvent(new Event('change'));
        await H.settle(60);
        eq(ctx().gate.isOn(id), !was, `「${id}」那个开关动的是真的 gate`);
        box.checked = was;
        box.dispatchEvent(new Event('change'));
        await H.settle(60);
        eq(ctx().gate.isOn(id), was, `「${id}」拨回原样`);
      }
    });

    await suite.it('向导只读面：剩下的屏走完（第 2 步 → 结语），库内**任何文件**（含 .json）都没多、没变', async () => {
      /**
       * ⚠️ **P7.14**：向导开了一个写盘口（「新建」分支真建目录）—— 但它在**第 1 步正向
       * 离开**那一下；这条判据走的是第 2 步 → 结语，路上仍然一个字都不许写
       *（「新建」真建那一路的判据在 §E 那组）。
       *
       * P7.9 · ①：原「现场检测」屏**整屏退役** —— 这条判据转型成"只读"：
       * 走完剩下的屏（第 2 步「下一步」直接进结语，不再有任何检测行），
       * 库内任何文件（含 .json）都不许多、不许变。
       *
       * ⚠️ **路径清单与内容快照分开取**：`snapshotKb` 里塞了文件内容，
       * 而内容是多行的 → 拿它 `split(':')` 出来的"路径"会混进 JSON 的片段
       *（历史上第一版就是这么报的：多出来的里夹着 `"version"`、`"dirs"` 这种行）。
       */
      const pathsOf = (): string[] => H.listFiles(vault, '').filter((p) => !p.includes('.obsidian'));
      const beforePaths = pathsOf();
      const before = snapshotKb();
      H.click(foot('下一步')); // ②模块开关 → 结语（检测屏已退役）
      await H.settle(200);
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-check-row').length, 0, '不再有检测行（第 3 屏整屏退役）');
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-card').length, 4, '落在了结语屏（四张去处卡 —— P7.10 · #4）');
      const after = snapshotKb();
      const added = pathsOf().filter((p) => !beforePaths.includes(p));
      ok(
        added.length === 0,
        `🔴 这一段号称不写库，却写盘了 —— 多出来的：${added.slice(0, 5).join('、')}` +
          `（历史上 \`configs.ensure()\` 会"不存在就写默认值 + mkdir 祖先" ——` +
          ` 这类封装出现在只读界面上就是错的）`,
      );
      eq(after, before, '🔴 走完向导剩下的屏，库内文件一个字符都没变');
    });

    await suite.it('「完成」→ `wizardDone: true` 落盘；再打开工作台**不再弹**', async () => {
      /**
       * P7.9：第 2 步的「下一步」直接进**结语屏**（三张去处卡）——上一条已把屏停在结语，
       * 「完成」在结语屏的底栏。（点卡片 = 记「完成」+ 切过去那条在 `p72b` spec 里。）
       */
      H.click(foot('完成'));
      await H.settle(80);
      eq(H.maybe(document.body, '.kbw-wiz-steps'), null, '向导收掉了');
      eq(ctx().settings.get().wizardDone, true, '内存里是 true');
      // 落盘（`data.json`）—— 重开一次插件才知道是不是真存住了
      // ⚠️ `adapter.read` 吃的是**相对库根**的路径（传绝对路径会被再拼一次根 → ENOENT）
      const raw = JSON.parse(
        await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json'),
      ) as { wizardDone?: unknown };
      eq(raw.wizardDone, true, '真的写进 data.json 了（不是只改了内存）');

      // 同一次会话里再打开一次工作台：`wizardShownThisSession` 也该挡住它
      await plugin.activate();
      await H.settle(60);
      eq(H.maybe(document.body, '.kbw-wiz-steps'), null, '同一次会话里不会再来一次');
      await H.shutdown(plugin);
    });

    await suite.it('重启一个实例：走完之后**永远不再自动弹**', async () => {
      const b2 = await H.bootPlugin(vault, { wizard: 'done' });
      H.resetDom();
      await b2.plugin.activate();
      await H.settle(60);
      eq(H.maybe(document.body, '.kbw-wiz-steps'), null, '不再弹');
      await H.shutdown(b2.plugin);
    });
  });

  // ════════════════════════════════════════════════════════════
  // §D 出口与重开
  // ════════════════════════════════════════════════════════════
  await suite.group('P6④ 向导 · 出口（稍后 / 跳过）与重开入口', async () => {
    await suite.it('「跳过这一步」不落盘任何设置（跳过 ≠ 替我确认）', async () => {
      const vault = H.makeTempVault('wizard-skip');
      const b = await H.bootPlugin(vault, { wizard: 'fresh' });
      H.resetDom();
      await b.plugin.activate();
      await H.settle(60);
      const ctx = () => b.plugin.context();
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      /** P7.2b：引言屏的按钮叫「跳过介绍」——先点「下一步」进第 1 步再验"跳过" */
      const nextOn = (m: HTMLElement): void => {
        const n = H
          .qa<HTMLElement>(m, '.kbw-modal-foot .kbw-btn')
          .find((x) => H.textOf(x).includes('下一步'));
        H.click(n as Element);
      };
      nextOn(modal);
      await H.settle(90);
      // P7.11 · #11：先点「用现成的」才出输入框（未选 → 下方什么都不画）
      const existingOpt = H
        .qa<HTMLElement>(modal, '.kbw-wiz-opt')
        .find((x) => H.textOf(x).includes('用现成的'));
      ok(existingOpt, '前提：「用现成的」选项在');
      H.click(existingOpt as Element);
      await H.settle(80);
      const input = H.qa<HTMLInputElement>(modal, '.kbw-wiz-field .kbw-input')[0];
      ok(input, '前提：内容区的输入框在');
      input.value = '99_根本不存在';
      input.dispatchEvent(new Event('input'));
      await H.settle(20);
      const skip = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) =>
        H.textOf(x).includes('跳过'),
      );
      ok(skip, '第 1 步有「跳过这一步」');
      H.click(skip as Element);
      await H.settle(60);
      eq(ctx().settings.kbRoot(), DEFAULT_SETTINGS.kbRoot, '跳过了就一个字都不动（用户没确认过的改动不该替他应用）');
      contains(H.textOf(document.body), '模块开关', '跳到第 2 步了');
      await H.shutdown(b.plugin);
    });

    await suite.it('「跳过教程」（P7.10 由「稍后」改名）→ `wizardDone: false` 落盘', async () => {
      const vault = H.makeTempVault('wizard-later2');
      const b = await H.bootPlugin(vault, { wizard: 'fresh' });
      H.resetDom();
      await b.plugin.activate();
      await H.settle(60);
      const modal = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const later = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) =>
        H.textOf(x).includes('跳过教程'),
      );
      ok(later, '有「跳过教程」');
      H.click(later as Element);
      await H.settle(60);
      eq(b.plugin.context().settings.get().wizardDone, false, '记成"跳过教程"');
      await H.shutdown(b.plugin);
    });

    await suite.it('设置里能重开（**帮助**栏里那个按钮）—— 且**不涨命令面板条数**', async () => {
      const vault = H.makeTempVault('wizard-reopen');
      const b = await H.bootPlugin(vault, { wizard: 'done' });
      H.resetDom();
      await b.plugin.activate();
      await H.settle(60);
      eq(H.maybe(document.body, '.kbw-wiz-steps'), null, '起手不弹（done）');

      /**
       * 走真入口：工作台设置面板 → **帮助**那一栏。
       *
       * 🔴 为什么是「帮助」：向导自己的副标题写着「设置 → 帮助 → 重新运行首次向导」，
       * 而 `交互规格.md` §14.2 那张表也这么写 —— **三处一处都不能少**。
       * 这一条盯的就是"文案与实现同处一处"：第一版把按钮放进了新加的「AI 助手」栏，
       * 界面上那句话于是指着一个没有这个按钮的地方（本项目最烦的一类）。
       * ⚠️ 位置变过一次：P6 第八段用户第 4 条说"首次使用向导别放外观里"，
       * 由「外观」搬到「帮助」（依据是**语义**：向导是"带我走一遍"，与外观无关）。
       */
      b.plugin.context().openWorkbenchSettings();
      await H.settle(60);
      const settings = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      ok(settings, '设置面板开着');
      const WIZ_HOME = '帮助';
      const tab = H.qa<HTMLElement>(settings, '.kbw-set-tab').find((x) =>
        H.textOf(x).includes(WIZ_HOME),
      );
      ok(tab, `左栏有「${WIZ_HOME}」`);
      H.click(tab as Element);
      await H.settle(60);
      const btn = H.qa<HTMLElement>(settings, '.kbw-set-main .kbw-btn').find((x) =>
        H.textOf(x).includes('重新运行首次向导'),
      );
      ok(btn, '重开入口在设置里');
      H.click(btn as Element);
      await H.settle(120);
      ok(H.maybe(document.body, '.kbw-wiz-steps'), '重开出来了');
      /**
       * ⚠️ 独立审查 B🟡4：只判"向导开出来了"是不够的 —— 两个模态叠着时
       * `Esc` 只会关掉最上面那个，**下面的设置面板会留在屏幕上**挡着后面的东西
       *（探针里"关不干净"的最常见来源）。所以这里还要判"设置面板已经收了"。
       */
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-set-shell').length,
        0,
        '重开向导之前要**先收掉设置面板**（否则它会留在底下，Esc 只关最上面那个）',
      );
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-modal').length,
        1,
        '屏幕上只该剩向导这一层模态',
      );
      // B5 拍过：命令面板那 5 条是固定的，不许涨
      const commands = b.app.commands.visible().filter((id) => id.startsWith('kb-workbench:'));
      ok(
        commands.every((c) => !c.includes('wizard') && !c.includes('向导')),
        `命令面板不许加「向导」第 6 条（现有：${commands.join(', ')}）`,
      );
      await H.shutdown(b.plugin);
    });

    /**
     * ⚠️ P7.9 · ①：「现场检测」屏整屏退役 —— 原来钉「待补属性现算」的那条**随之删除**
     *（它测的界面不存在了；`planBackfillOf` 与补全面板报同一个数那条接线，由
     * `tests/specs/automation.ts` 的补全组继续盯着）。
     */

  });

  // ════════════════════════════════════════════════════════════
  // §E P7.14 · 向导「新建」真建目录 + 第三卡「整个库」
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.14 · 向导「新建」真建目录 + 第三卡「整个库」', async () => {
    const vault = H.makeTempVault('wizard-p714');
    const { app, plugin } = await H.bootPlugin(vault, { wizard: 'fresh' });
    const ctx = () => plugin.context();

    const modal = (): HTMLElement =>
      H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
    function foot(text: string): HTMLElement {
      const b = H
        .qa<HTMLElement>(modal(), '.kbw-modal-foot .kbw-btn')
        .find((x) => H.textOf(x).includes(text));
      ok(b, `底部有「${text}」`);
      return b as HTMLElement;
    }
    function pickMode(word: string): void {
      const o = H.qa<HTMLElement>(modal(), '.kbw-wiz-opt').find((x) => H.textOf(x).includes(word));
      ok(o, `前提：找得到「${word}」选项`);
      H.click(o as Element);
    }
    /**
     * **子集自足**：把向导带到「第 1 步 + 新建分支」再动手（`KBW_TEST_ONLY` 单跑时，
     * 前面几条造状态的用例被过滤掉，向导可能停在引言屏或别的屏 —— 实测踩过）。
     */
    async function ensureStep1New(): Promise<void> {
      for (let i = 0; i < 4 && !H.textOf(modal()).includes('工作文件夹放在哪'); i += 1) {
        const txt = H.textOf(modal());
        if (H.maybe(modal(), '.kbw-wiz-intro')) H.click(foot('下一步'));
        else if (txt.includes('模块开关')) H.click(foot('上一步'));
        else break;
        await H.settle(120);
      }
      ok(H.textOf(modal()).includes('工作文件夹放在哪'), '前提：向导停在第 1 步');
      /**
       * ⚠️ 判分支要看**字段标签**（「目录名」只属于"新建"）—— 别用"有没有输入框"：
       * 「整个库」分支也有一个（库配置目录），照那个判会把后面几条全带进 whole 分支里跑
       *（实测：撞名那条的 kbRoot 一直不动，就是这个）。
       */
      const labels = H.qa<HTMLElement>(modal(), '.kbw-wiz-field-label').map((l) => H.textOf(l));
      if (!labels.includes('目录名')) {
        pickMode('新建');
        await H.settle(80);
      }
    }
    /** 顶层目录（走 adapter.list —— `H.listFiles` 只列文件，空目录看不见） */
    const topDirs = async (): Promise<string[]> =>
      (await app.vault.adapter.list('')).folders.slice().sort();
    const pathsOf = (): string[] =>
      H.listFiles(vault, '').filter((p) => !p.includes('.obsidian')).sort();

    H.resetDom();
    await plugin.activate();
    await H.settle(60);
    /** 默认库根（01_新知识库）下的全量篇数 —— 整个库模式的对照数 */
    const totalNotes = ctx().index.size();
    ok(totalNotes > 0, `前提：默认范围内索引非空（${totalNotes} 篇）`);

    await suite.it('「新建」：默认名 =「经纬知识库」，点「下一步」**真的把目录建出来**（只多这一个）', async () => {
      H.click(foot('下一步')); // 引言 → 第 1 步
      await H.settle(90);
      pickMode('新建');
      await H.settle(80);
      const input = H.qa<HTMLInputElement>(modal(), '.kbw-wiz-field .kbw-input')[0];
      ok(input, '目录名输入框在');
      eq(input.value, '经纬知识库', '默认名 =「经纬知识库」（P7.14 拍板）');

      const beforeDirs = await topDirs();
      const beforeFiles = pathsOf();
      H.click(foot('下一步'));
      await H.settle(200);
      const addedDirs = (await topDirs()).filter((d) => !beforeDirs.includes(d));
      eq(addedDirs.join('、'), '经纬知识库', '🔴 库里真的多出「经纬知识库」这一个目录（且只多它）');
      eq(pathsOf().join('\n'), beforeFiles.join('\n'), '文件清单一个字没动（只建目录）');
      eq(ctx().settings.kbRoot(), '经纬知识库', '设置里落盘了');
      /**
       * 🔴 **平台缓存也要立刻认账**（P7.14b 真机反馈修正的正主——「跑完向导还是
       * 找不到库根目录，要点一下别的面板按钮才加载」）。判据 = `getAbstractFileByPath`
       * 当场非空：裸 `adapter.mkdir` 只落盘、缓存/事件链全不知道；`vault.createFolder`
       * 才走平台层。突变：把 helper 换回 adapter.mkdir，这条必红。
       */
      ok(
        app.vault.getAbstractFileByPath('经纬知识库') != null,
        '新建的目录立刻进平台缓存（免得工作台喊"找不到库根"）',
      );
      contains(H.textOf(document.body), '模块开关', '进到第 2 步');
    });

    await suite.it('在建出来的库里再建子目录、往子目录里新建笔记 → `文件位置` 写的是那个子目录', async () => {
      /**
       * ⚠️ 口径提醒（**P7.15 · #1 反转**）：**库根顶层**的笔记现在**也写** `文件位置`，
       * 值 = `.`（`ROOT_POS` 根标记 —— 用户 2026-10-08 否掉了"顶层无从表达"那条旧口径）。
       * 这里验的是**非顶层**那半边：子目录里的笔记写"我该在哪"（真机上目录若没进
       * 平台缓存，落点会退空、连这一条都写不出来 —— P7.14b 反馈的另一半）。
       */
      fs.mkdirSync(path.join(vault, '经纬知识库', '子夹'), { recursive: true });
      app.vault.rescan();
      await H.settle(60);
      await ctx().completion.createNote({ title: '__p714位置', dirRel: '子夹', noTemplate: true });
      await H.settle(120);
      const abs = path.join(vault, '经纬知识库', '子夹', '__p714位置.md');
      ok(fs.existsSync(abs), '笔记落进子夹了');
      const text = fs.readFileSync(abs, 'utf8');
      contains(text, '文件位置:', '有「文件位置」这一条');
      contains(text, '  - 子夹', '……值是所在目录（相对库根）');
      // 收尾：跟着工程里的安全删法（`metadataCache.settle()` 把滞后解析的定时器跑完 ——
      // 裸 rmSync 后会有一个"解析一个不存在的文件"的未捕获错，能把整个测试进程干掉）
      fs.rmSync(abs, { force: true });
      app.vault.rescan();
      await app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(80);
    });

    await suite.it("第三卡「整个库」：落盘 kbRoot=''，索引切到全库篇数", async () => {
      await ensureStep1New();
      pickMode('整个库');
      await H.settle(80);
      ok(
        H.textOf(modal()).includes('管理库内所有笔记'),
        '范围说明行在（整库模式没有"工作文件夹"可填）',
      );
      ok(H.maybe(modal(), '.kbw-wiz-treebox') == null, '不画目录树（整库 = 不选层级）');
      H.click(foot('下一步'));
      await H.settle(200);
      eq(ctx().settings.kbRoot(), '', "🔴 kbRoot 落盘空串（= 整个库）");
      eq(ctx().index.size(), totalNotes, '索引 = 全库篇数（此前是空目录「经纬知识库」→ 0 篇）');
    });

    await suite.it('「新建」撞名：库里已有同名 → 不建、只把库根指过去', async () => {
      await ensureStep1New();
      const input = H.qa<HTMLInputElement>(modal(), '.kbw-wiz-field .kbw-input')[0];
      input.value = DEFAULT_SETTINGS.kbRoot; // 库里真有的那个目录
      input.dispatchEvent(new Event('input'));
      await H.settle(20);
      const beforeDirs = await topDirs();
      const beforeFiles = pathsOf();
      H.click(foot('下一步'));
      await H.settle(200);
      eq((await topDirs()).join('、'), beforeDirs.join('、'), '没建目录（已存在 → 只落盘）');
      eq(pathsOf().join('\n'), beforeFiles.join('\n'), '也没动文件');
      eq(ctx().settings.kbRoot(), DEFAULT_SETTINGS.kbRoot, '库根指过去了');
      eq(ctx().index.size(), totalNotes, '索引切回 01_新知识库 那片');
    });

    await suite.it('「新建」名字不合法：不建不落、**允许离开**（只提示不拦）', async () => {
      await ensureStep1New();
      const input = H.qa<HTMLInputElement>(modal(), '.kbw-wiz-field .kbw-input')[0];
      input.value = '.隐藏库';
      input.dispatchEvent(new Event('input'));
      await H.settle(20);
      ok(H.maybe(modal(), '.kbw-wiz-hint.is-warn'), '提示行标了警告');
      const beforeDirs = await topDirs();
      const kb0 = ctx().settings.kbRoot();
      H.click(foot('下一步'));
      await H.settle(200);
      eq((await topDirs()).join('、'), beforeDirs.join('、'), '没建');
      eq(ctx().settings.kbRoot(), kb0, '也没落盘');
      contains(H.textOf(document.body), '模块开关', '但允许离开（没填的卷子不改分）');
    });

    await suite.it('建失败 → 留在第 1 步（唯一"拦"点）：桩注入 mkdir 抛错', async () => {
      await ensureStep1New();
      const input = H.qa<HTMLInputElement>(modal(), '.kbw-wiz-field .kbw-input')[0];
      input.value = '会失败的库';
      input.dispatchEvent(new Event('input'));
      await H.settle(20);
      /**
       * ⚠️ 注入点 = **`vault.createFolder` 与 `adapter.mkdir` 两个都要挡**：
       * helper 现在先走平台层（`createFolder`）、失败才退 `adapter.mkdir` ——
       * 只挡一个的话另一个会兜住，失败演不出来。
       */
      const vaultAny = app.vault as unknown as { createFolder: (p: string) => Promise<unknown> };
      const origCF = vaultAny.createFolder;
      const adapter = app.vault.adapter as unknown as { mkdir: (p: string) => Promise<void> };
      const origMk = adapter.mkdir;
      const boom = async (): Promise<never> => {
        throw new Error('注入的失败');
      };
      vaultAny.createFolder = boom;
      adapter.mkdir = boom;
      H.click(foot('下一步'));
      await H.settle(200);
      vaultAny.createFolder = origCF;
      adapter.mkdir = origMk;
      contains(H.textOf(modal()), '工作文件夹放在哪', '还在第 1 步（没离开）');
      ok(ctx().settings.kbRoot() !== '会失败的库', '库根没落盘');
      await H.shutdown(plugin);
    });
  });

  /**
   * ────────────────────────────────────────────────────────────────
   * P6⑧ · 默认视图档（**全新安装**）—— 用户真机第 5 条"网格视图设为默认视图"
   *
   * 为什么放在这一组（向导的两个都是"全新安装"）：`notesView === null` 这个形态
   * **只有起一个没有 data.json 的实例**才造得出来（改设置改不出来 —— 档位是
   * `mount()` 那一刻由 `resolveNotesView()` 解析进 store 的）。
   *
   * 🔴 反面对照：**别处的夹具**（`tests/helpers.ts` 的 `seedDataJson`）显式写着
   * `notesView: 'detail'` —— 那是"这台设备选过"，不是产品默认。两者分工别混。
   */
  await suite.group('P6⑧ · 默认视图档（全新安装 → 网格）', async () => {
    await suite.it('🔴 从没切过档 → 打开「全部笔记」就是网格档', async () => {
      const vault = H.makeTempVault('grid-default');
      // `fresh` = 一个键都没有的 data.json（`notesView` 自然是 null）
      const b = await H.bootPlugin(vault, { wizard: 'fresh' });
      H.resetDom();
      await b.plugin.activate();
      await H.settle(120);
      // `fresh` 形态下向导本来就会弹（那是另一条判据）—— 先关掉它再验视图档
      const wiz = H.qa<HTMLElement>(document.body, '.kbw-modal').pop();
      if (wiz) {
        H.click(H.q<HTMLElement>(wiz, '.kbw-iconbtn[aria-label="关闭"]'));
        await H.settle(120);
      }
      const ctx = b.plugin.context();
      eq(ctx.settings.get().notesView, null, '前提：这台设备**从没切过**档');
      ctx.goNotes();
      await H.settle(200);
      const on = H.textsOf(document.body, '.kbw-seg .kbw-segbtn.is-on').join(',');
      eq(on, '网格', '停在高亮的那一档上（判据认按钮的选中态，不认"有没有格子"）');
      ok(
        H.qa(document.body, '.kbw-gcell').length > 0,
        '网格格子真的画出来了（夹具里那 43 篇全在子目录里 —— P7.1b 起根层画的是文件夹格，它们也是 .kbw-gcell）',
      );
      eq(H.qa(document.body, '.kbw-trow').length, 0, '不是表格档');
      await H.shutdown(b.plugin);
    });
  });
}
