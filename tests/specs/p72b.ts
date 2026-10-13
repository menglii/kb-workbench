/**
 * spec：**P7.2b 向导与内容**（1.1 向导改版 · 1.6 教程三处 · 1.4 命名模板 · M4 池小账）
 * —— **P7.9 · ① 起向导部分按极简版翻新**（四屏、零 lead；脚本见下）。
 *
 * 完成定义对应的判据（本文件 + `specWizard` 的既有组）：
 *   · 向导（P7.9 口径 · **P7.10 徽调**）：四屏流程 / 零 lead（全向导 ≤25 字）/
 *     结语**四卡**各按对（2×2、首页左上）/ **检测屏退役 + 「去建」口退休** / 引言两张配图与缺图降级 /
 *     （P7.10）库配置目录 + 目录树点选；
 *   · 教程：**十篇**折叠卡（P7.10 起九篇、P7.18 加「不想用了怎么办」；后两篇带配图、展开先图后文）/ 导出为笔记（真落一篇）/
 *     M8 落点（打开即展开）；
 *   · 「?」：键表每行一句人话 / 首页四钮悬停出浮层（点击即取消 —— P7.9 · ③ 半步也在 p79）；
 *   · 命名：纯函数多例 / 默认名形状 / 面板落盘与预览 / 非法不落盘；
 *   · M4：漫步池排除元数据目录与 `还原保留-*`。
 *
 * ⚠️ 起手清场（跨用例污染是本项目栽得最多的那一类）：
 * · 向导的结语卡会**切模块**（写 `activeModule`）—— 每条自己把状态摆回；
 * · 命名用例收尾把 `namingTemplate` 拨回 null；
 * · 面板收尾关干净（Esc 只问栈顶 —— 一层一层收）。
 */
import fs from 'node:fs';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import {
  DEFAULT_NAMING_TEMPLATE,
  isNamingTemplateOk,
  namingIssues,
  renderNamingTemplate,
} from '../../src/core/naming';
import { KEY_ACTIONS } from '../../src/core/keymap';
import { openNewNoteDialog } from '../../src/ui/new-note';
import { walkPool } from '../../src/modules/home/blocks/walk';
import type { WorkbenchContext } from '../../src/core/context';
import type { NoteEntry } from '../../src/core/vault-index';

const KB = '01_新知识库';

export async function specP72b(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 模态栈顶（一次操作之后取"刚开的那个"） */
  function topModal(): HTMLElement {
    const all = H.qa<HTMLElement>(document.body, '.kbw-modal');
    const last = all[all.length - 1];
    ok(last, '该有模态在屏幕上');
    return last;
  }

  /**
   * **把浮层收干净**（模态 + 浮层，一层一层 Esc —— Esc 只问栈顶）。
   * 为什么每条相关用例起手/收尾都要它：一个没收掉的设置面板会**叠在下面**，
   * 之后按类名找元素会命中旧面板里的那份（"点了没反应 / 数出两个面板"那类假红）。
   */
  async function closeOverlays(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      const open =
        H.qa<HTMLElement>(document.body, '.kbw-modal').length +
        H.qa<HTMLElement>(document.body, '.kbw-panel').length;
      if (open === 0) return;
      H.keydown(document.body, 'Escape');
      await H.settle(90);
    }
  }

  // ════════════════════════════════════════════════════════════
  // §1 命名模板：纯函数（渲染 / 问题扫描 / 合法性）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 命名模板（纯函数）', async () => {
    // 固定时间：判据不跟"现在几点"跑（2026-10-03 21:05:07）
    const D = new Date(2026, 9, 3, 21, 5, 7);

    await suite.it('renderNamingTemplate：默认模板 / 中英混排 / 未识别原样保留', () => {
      eq(renderNamingTemplate(DEFAULT_NAMING_TEMPLATE, D), '2026-10-03 2105', '默认模板');
      eq(renderNamingTemplate('YYYY年MM月DD日 HH-mm-ss', D), '2026年10月03日 21-05-07', '分隔符随便写');
      eq(renderNamingTemplate('QQmm', D), 'QQ05', '未识别的字母串原样保留（mm 照常当分钟）');
      eq(renderNamingTemplate('YYYYY', D), '2026Y', 'YYYY 先吃掉四个字符');
      eq(renderNamingTemplate('MM与mm是两回事', D), '10与05是两回事', '大小写有意义');
    });

    await suite.it('namingIssues：未知串按"被变量截断"分段报（QQmm → QQ）', () => {
      deepEq(namingIssues('QQmm').unknown, ['QQ'], 'QQmm 只报 QQ');
      deepEq(namingIssues('mmoo').unknown, ['oo'], 'mmoo 报 oo');
      deepEq(namingIssues('YYYY-MM-DD HHmm').unknown, [], '默认模板没有未知串');
      deepEq(namingIssues('HH:mm').illegal, [':'], '冒号是 Windows 禁字');
      eq(namingIssues('   ').empty, true, '全空白 = 空');
      eq(namingIssues('YYYY').empty, false, '正常模板不是空');
    });

    await suite.it('isNamingTemplateOk：空 / 未知 / 禁字，三者任一都不行', () => {
      eq(isNamingTemplateOk('YYYY-MM-DD HHmm'), true, '默认模板合法');
      eq(isNamingTemplateOk(''), false, '空不合法');
      eq(isNamingTemplateOk('笔记-YYYY'), true, '中文字面量合法');
      eq(isNamingTemplateOk('YYYY/MM'), false, '斜杠不合法（它会被 sanitize 换成下划线）');
      eq(isNamingTemplateOk('QQ-YYYY'), false, '未知变量不合法');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §2 命名模板：面板（落盘 / 预览 / 非法不落盘）+ 新建默认名
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 命名模板（面板与落点）', async () => {
    /** 重新打开设置面板并落到「自动化」栏；返回那一栏的根（`.kbw-set-main`） */
    async function openAutomation(): Promise<HTMLElement> {
      ctx().openWorkbenchSettings('automation');
      await H.settle(120);
      const modal = topModal();
      return H.q<HTMLElement>(modal, '.kbw-set-main');
    }
    /** 关干净：设置面板是一层，别留给下一条（Esc 只问栈顶） */
    async function closeSettings(): Promise<void> {
      H.keydown(document.body, 'Escape');
      await H.settle(100);
    }

    await suite.it('默认名形状：不动设置时是「YYYY-MM-DD HHmm」的渲染（年-月-日 + 四位时分）', async () => {
      eq(ctx().settings.get().namingTemplate, null, '前提：没改过（null）');
      openNewNoteDialog(ctx());
      await H.settle(80);
      const nm = topModal();
      const title = H.q<HTMLInputElement>(nm, '.kbw-form .kbw-input');
      ok(
        /^\d{4}-\d{2}-\d{2} \d{4}$/.test(title.value),
        `默认名 = 年-月-日 + 四位时分（实际「${title.value}」）`,
      );
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      void app;
    });

    await suite.it('面板：改模板 → 回读 data.json；预览跟着输入走', async () => {
      const main = await openAutomation();
      const input = H.q<HTMLInputElement>(main, '.kbw-name .kbw-input');
      eq(input.value, DEFAULT_NAMING_TEMPLATE, '输入框预填当前模板（没改过 = 默认）');
      contains(H.textOf(main), '预览：', '有预览行');

      // 输入（实时）：预览立即变，但**不落盘**
      input.value = 'YYYY年MM月';
      input.dispatchEvent(new Event('input'));
      await H.settle(40);
      contains(H.textOf(main), String(new Date().getFullYear()), '预览跟着输入走（出现当前年份）');
      const before = JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')) as {
        namingTemplate?: unknown;
      };
      ok(before.namingTemplate == null, '只 input 不落盘（落盘只认 change；null/undefined 都算"没写过"）');

      // change（失焦/回车）：落盘 + 回读**磁盘**
      input.dispatchEvent(new Event('change'));
      await H.settle(80);
      const after = JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')) as {
        namingTemplate?: unknown;
      };
      eq(after.namingTemplate, 'YYYY年MM月', '真的写进 data.json 了（不是只改了内存）');

      // 新模板真的用在默认名上（形状判据，别跟"现在是几月"较劲）
      openNewNoteDialog(ctx());
      await H.settle(80);
      const nm = topModal();
      const title = H.q<HTMLInputElement>(nm, '.kbw-form .kbw-input');
      ok(/^\d{4}年\d{2}月$/.test(title.value), `新建默认名按新模板渲染（实际 ${title.value}）`);
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      await closeSettings();
    });

    await suite.it('非法 token：预览照实渲染 + 黄提示 + **不落盘**（保持上一个有效值）', async () => {
      const main = await openAutomation();
      const input = H.q<HTMLInputElement>(main, '.kbw-name .kbw-input');
      eq(input.value, 'YYYY年MM月', '起手是上一个有效值');
      input.value = 'YYYY年MM月 QQmm';
      input.dispatchEvent(new Event('input'));
      await H.settle(40);
      ok(input.classList.contains('is-warn'), '输入框进了非法态');
      const warn = H.q<HTMLElement>(main, '.kbw-name-warn');
      ok(warn.classList.contains('is-on'), '提示行亮着');
      contains(H.textOf(warn), 'QQ', '提示里点名了那个不认识的串');

      input.dispatchEvent(new Event('change'));
      await H.settle(80);
      const disk = JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')) as {
        namingTemplate?: unknown;
      };
      eq(disk.namingTemplate, 'YYYY年MM月', '非法值没有落盘（data.json 保持上一个有效值）');

      // 修好 → 落盘
      input.value = 'YYYY年MM月DD日';
      input.dispatchEvent(new Event('change'));
      await H.settle(80);
      const fixed = JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')) as {
        namingTemplate?: unknown;
      };
      eq(fixed.namingTemplate, 'YYYY年MM月DD日', '修好即存');
      await closeSettings();
    });

    await suite.it('「恢复默认」→ 存 null（哨兵）；清空输入**不落盘**', async () => {
      const main = await openAutomation();
      const input = H.q<HTMLInputElement>(main, '.kbw-name .kbw-input');
      // 清空 = 非法：不落盘
      input.value = '';
      input.dispatchEvent(new Event('change'));
      await H.settle(80);
      let disk = JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')) as {
        namingTemplate?: unknown;
      };
      eq(disk.namingTemplate, 'YYYY年MM月DD日', '清空没落盘（想回默认要点按钮，不是清空）');

      const btn = H.qa<HTMLElement>(main, '.kbw-name .kbw-btn').find((b) =>
        H.textOf(b).includes('恢复默认'),
      );
      ok(btn, '有「恢复默认」');
      H.click(btn as Element);
      await H.settle(80);
      eq(input.value, DEFAULT_NAMING_TEMPLATE, '输入框回到默认模板');
      disk = JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')) as {
        namingTemplate?: unknown;
      };
      eq(disk.namingTemplate, null, '落盘的是 null（"没改过"的哨兵）');
      await closeSettings();
    });

    await suite.it('变量 chips：点一下在下方展开释义（再点收起）', async () => {
      const main = await openAutomation();
      const chip = H.qa<HTMLElement>(main, '.kbw-name-chips .kbw-chip')[0];
      ok(chip, 'chips 在');
      H.click(chip);
      await H.settle(30);
      const explain = H.q<HTMLElement>(main, '.kbw-name-explain');
      eq(explain.style.display, '', '释义行展开了');
      contains(H.textOf(explain), 'YYYY', '讲的是 YYYY 的含义');
      H.click(chip);
      await H.settle(30);
      eq(explain.style.display, 'none', '再点同一枚收起');
      await closeSettings();
    });
  });

  // ════════════════════════════════════════════════════════════
  // §3 教程中心（帮助栏）：折叠 / 导出为笔记 / M8 落点
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 教程中心', async () => {
    async function openHelp(): Promise<HTMLElement> {
      ctx().openWorkbenchSettings('help');
      await H.settle(120);
      return H.q<HTMLElement>(topModal(), '.kbw-set-main');
    }

    await suite.it('十篇折叠卡：标题齐、默认全收起（P7.10 六→九 · P7.18 加第十篇）', async () => {
      const main = await openHelp();
      const cards = H.qa<HTMLElement>(main, '.kbw-tut-card');
      eq(cards.length, 10, '十篇');
      eq(
        H.textsOf(main, '.kbw-tut-title').join(' / '),
        '从工作文件夹开始 / 全部笔记：视图与筛选 / 看板与板块 / AI 助手怎么用 / 快捷键与「?」 / 常见问题 / 如何新建模板 / 批量操作：迁移·属性·标签 / 找笔记：搜索·筛选·收藏 / 不想用了怎么办',
        '标题与顺序（前六篇拍板口径不变；后三篇 P7.10 · #7/#8 追加；第十篇 P7.18 退出清理的文档三层）',
      );
      eq(cards.filter((c) => c.classList.contains('is-open')).length, 0, '默认全收起');
      await H.settle(60);
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });

    await suite.it('展开 → 正文渲染出来（Markdown 过的是面板自己的 Component）；再点收起', async () => {
      const main = await openHelp();
      const first = H.qa<HTMLElement>(main, '.kbw-tut-card')[0];
      const head = H.q<HTMLElement>(first, '.kbw-tut-head');
      ok(head, '卡头在');
      H.click(head);
      await H.settle(120);
      ok(first.classList.contains('is-open'), '展开了');
      const body = H.q<HTMLElement>(first, '.kbw-tut-body');
      // ⚠️ P7.9 · ①：第一篇正文换了 —— 挑一句**新文案里真有**的（旧句"工作文件夹"不再是子串）
      contains(H.textOf(body), '工作台只管一个文件夹', '正文渲染出来了（不是空的）');
      ok(H.qa<HTMLElement>(body, 'p').length > 0, '渲染出的是块级结构（桩的 mini 渲染器画的段落）');
      H.click(head);
      await H.settle(60);
      ok(!first.classList.contains('is-open'), '再点收起');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });

    await suite.it('「导出为笔记」：打开新建对话框（预填标题+正文）→ 真的落一篇', async () => {
      const main = await openHelp();
      const cards = H.qa<HTMLElement>(main, '.kbw-tut-card');
      const exportBtn = H.q<HTMLElement>(cards[1], '.kbw-tut-export');
      ok(exportBtn, '第 2 篇卡头有「导出为笔记」');
      /**
       * 键盘路径（独立审 2026-10-03 🟡3）：焦点在导出按钮上按 Enter，
       * 卡头的 keydown 处理器**不许 preventDefault**（那会取消按钮自己的激活 ——
       * 症状是'按 Enter 对话框不开、卡片翻一下'）。离线能验的就是这个没被吃。
       */
      const kbEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      exportBtn.dispatchEvent(kbEv);
      ok(!kbEv.defaultPrevented, '导出按钮上的 Enter 没有被卡头吃掉（没被 preventDefault）');
      ok(!cards[1].classList.contains('is-open'), '按 Enter 也没顺手把折叠翻一下');
      H.click(exportBtn);
      await H.settle(120);
      const nm = topModal();
      ok(nm !== main.closest('.kbw-modal'), '新建笔记对话框叠在上面');
      /**
       * P7.9 · ② 极简：子标题与"导出为笔记"那句正文说明都删了 —— 认导出路径改看
       * **结构**：模板那一行整行不画（导出不套模板），文件名预填 = 教程标题。
       */
      eq(H.qa<HTMLElement>(nm, '.kbw-modal-sub').length, 0, '子标题已删（极简版）');
      eq(H.qa<HTMLElement>(nm, '.kbw-form-row').length, 2, '只剩两行：文件名 / 笔记位置（没有模板那一行）');
      const title = H.q<HTMLInputElement>(nm, '.kbw-form .kbw-input');
      eq(title.value, '全部笔记：视图与筛选', '文件名预填 = 教程标题');

      // 落点默认收件箱 → 点「新建」真落一篇
      const mk = H.qa<HTMLElement>(nm, '.kbw-modal-foot .kbw-btn').find((b) =>
        H.textOf(b).includes('新建'),
      );
      ok(mk, '底部有「新建」');
      H.click(mk as Element);
      await H.settle(300);
      /**
       * ⚠️ `H.listFiles(vaultRoot, dir)` 返回的是**相对那个 dir** 的名字（不是相对库根）——
       * 第一版直接拿它去 `readNote` 会 ENOENT（真机探针那边同款：认路径前先想清楚基准）。
       */
      const hit = H
        .listFiles(vaultRoot, `${KB}/00_Inbox`)
        .filter((p) => p.includes('全部笔记：视图与筛选'));
      ok(hit.length === 1, `库里真的多了一篇教程笔记（${hit.join('、') || '没有'}）`);
      contains(
        H.readNote(vaultRoot, `${KB}/00_Inbox/${hit[0]}`),
        '两档视图',
        '正文是那篇教程的内容',
      );
      // 收尾：把设置面板等浮层收干净（新建成功后对话框自己关了；设置面板还开着）
      await closeOverlays();
    });

    await suite.it('🔴 M8 「看教程」→ 帮助栏 + **自动展开第一篇**（待消费的意图）', async () => {
      await closeOverlays(); // 上一条收尾后仍是"干净起手"的前提
      // 打开教程卡所在块：homeBlocks 只显示 tutorial
      // ⚠️ P7.2d 起注册表 10 块 —— 不把新两块写进 hidden 的话它们会被 resolve 接到末尾
      // 并画出来（"只显示 tutorial"的原意就破了，还会多挂一块图谱卡）
      await ctx().settings.save({
        homeBlocks: {
          order: ['hero', 'quick', 'todo', 'recent', 'foot', 'fav', 'walk', 'tutorial', 'graphlink', 'homeCards'],
          hidden: ['fav', 'walk', 'graphlink', 'homeCards'],
        },
      });
      await ctx().activate();
      await H.settle(120);
      const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
        H.textOf(n).includes('首页'),
      );
      if (nav && !nav.classList.contains('is-on')) {
        H.click(nav);
        await H.settle(150);
      }
      const look = H.qa<HTMLElement>(document.body, '.kbw-tut button').find((b) =>
        H.textOf(b).includes('看教程'),
      );
      ok(look, '教程卡片上有「看教程」');
      H.click(look as HTMLElement);
      await H.settle(160);
      const tab = H.q<HTMLElement>(document.body, '.kbw-set-tab[data-section="help"]');
      ok(tab.classList.contains('is-on'), '落在「帮助」栏');
      const first = H.qa<HTMLElement>(document.body, '.kbw-tut-card')[0];
      ok(first.classList.contains('is-open'), '第一篇**打开即展开**（意图被消费了）');
      // 消费一次即清：手动重开帮助栏不该再自动展开
      await closeOverlays();
      ctx().openWorkbenchSettings('help');
      await H.settle(120);
      const again = H.qa<HTMLElement>(document.body, '.kbw-tut-card')[0];
      ok(!again.classList.contains('is-open'), '手动打开时不再自动展开（意图只消费一次）');
      await closeOverlays();
      await ctx().settings.save({ homeBlocks: null });
      await H.settle(60);
    });

    await suite.it('P7.10 · 配图篇（#8）：展开先出图（src 指向 assets/tutorial/）· 加载失败整块隐藏', async () => {
      const main = await openHelp();
      const cards = H.qa<HTMLElement>(main, '.kbw-tut-card');
      /** 第 8 篇 = 《批量操作》（前六篇 + 如何新建模板 = 7，它是第 8） */
      const batch = cards[7];
      ok(
        H.textOf(H.q<HTMLElement>(batch, '.kbw-tut-title')) === '批量操作：迁移·属性·标签',
        '第 8 篇是《批量操作》（前提）',
      );
      H.click(H.q<HTMLElement>(batch, '.kbw-tut-head'));
      await H.settle(120);
      const shots = H.qa<HTMLElement>(batch, '.kbw-tut-shot');
      eq(shots.length, 1, '批量操作配 1 张图');
      const img = H.q<HTMLImageElement>(shots[0], '.kbw-tut-img');
      contains(
        img.getAttribute('src') ?? '',
        'assets/tutorial/batch-bar.png',
        'src 指向随插件发布的 assets/tutorial/',
      );
      const body = H.q<HTMLElement>(batch, '.kbw-tut-body');
      ok(body.firstElementChild === shots[0], '**先图后文**（配图排在正文之前）');
      // 加载失败 → 整块藏起来（不摆破图）
      img.dispatchEvent(new Event('error'));
      await H.settle(30);
      ok(shots[0].classList.contains('is-missing'), '加载失败时整块隐藏');
      // 没写 shots 的篇一张图都不画
      const first = cards[0];
      H.click(H.q<HTMLElement>(first, '.kbw-tut-head'));
      await H.settle(120);
      eq(H.qa<HTMLElement>(first, '.kbw-tut-shot').length, 0, '没 shots 的篇不画图');
      // 《找笔记》配 2 张
      const find = cards[8];
      H.click(H.q<HTMLElement>(find, '.kbw-tut-head'));
      await H.settle(120);
      eq(H.qa<HTMLElement>(find, '.kbw-tut-shot').length, 2, '找笔记配 2 张图');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });
  });

  // ════════════════════════════════════════════════════════════
  // §4 教程两处补全：键表一句人话 + 首页四钮的提示（P7.7 起改悬停停留触发）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 教程两处补全（键表 / 四钮提示）', async () => {
    await suite.it('键表：14 个动作**每行都有**一句人话（从 KEY_ACTIONS[].note 来）', async () => {
      await closeOverlays();
      ctx().openKeysHelp();
      await H.settle(100);
      const modal = topModal();
      const rows = H.qa<HTMLElement>(modal, 'tbody tr[data-keys-row]');
      eq(rows.length, KEY_ACTIONS.length, `每个动作一行（${KEY_ACTIONS.length}）`);
      for (const r of rows) {
        const id = r.dataset.keysRow;
        const desc = H.q<HTMLElement>(r, '.kbw-keys-desc');
        ok(desc, `「${id}」那行有说明行`);
        const note = KEY_ACTIONS.find((a) => a.id === id)?.note;
        // 先钉"字段本身非空"（独立审 🟢8：只比"desc === note"的话，两边都是空串也会绿）
        ok(typeof note === 'string' && note.length > 0, `${id} 的 note 字段非空（一句人话）`);
        eq(H.textOf(desc as Element), note, `${id} 的说明 = note 字段（同一份数据）`);
      }
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });

    await suite.it('首页四钮：悬停停留出解释（触屏不接）· 换一枚不叠扇 · 移开 / Esc 关得掉', async () => {
      await closeOverlays();
      await ctx().activate();
      await H.settle(100);
      const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((n) =>
        H.textOf(n).includes('首页'),
      );
      if (nav && !nav.classList.contains('is-on')) {
        H.click(nav);
        await H.settle(150);
      }
      /**
       * ⚠️ **P7.7 收（用户真机 2026-10-05）**：四枚「?」徽标退役（"小问号太多"）→
       * 悬停停留 600ms 自动出同一扇小浮层。这一条同时是"徽标不许回来"的回归钉。
       */
      eq(H.qa<HTMLElement>(document.body, '.kbw-qbtn-tip').length, 0, '不再有「?」徽标');
      const buttons = H.qa<HTMLElement>(document.body, '.kbw-qbtn');
      ok(buttons.length >= 4, `快捷动作在（${buttons.length} 个）`);
      const enter = (el: Element, t: 'mouse' | 'touch'): void => {
        el.dispatchEvent(H.pointerEvent('pointerenter', { x: 5, y: 5, pointerType: t }));
      };
      const leave = (el: Element): void => {
        el.dispatchEvent(H.pointerEvent('pointerleave', { x: 200, y: 200 }));
      };
      const panels = (): number => H.qa<HTMLElement>(document.body, '.kbw-panel').length;

      // ① 触屏：pointerenter 有、hover 语义没有 —— 直接不接（记档的代价，见 quick.ts 文件头）
      enter(buttons[0], 'touch');
      await H.settle(750);
      eq(panels(), 0, '触屏停留不出提示');

      // ② 鼠标：停留不足不出（划过不吵）；停留够了出，且**不许**触发按钮动作
      enter(buttons[0], 'mouse');
      await H.settle(300);
      eq(panels(), 0, '停留不足不出');
      await H.settle(500); // 累计 > 600ms
      eq(H.qa<HTMLElement>(document.body, '.kbw-modal').length, 0, '悬停不触发按钮动作（没弹对话框）');
      eq(panels(), 1, '停留够了出一扇');
      const tip = H.q<HTMLElement>(document.body, '.kbw-panel');
      contains(H.textOf(tip), '新建笔记', '浮层标题 = 按钮名');
      contains(H.textOf(tip), '模板', '浮层正文是那句解释');

      // ③ 换一枚：只留一扇
      enter(buttons[1], 'mouse');
      await H.settle(750);
      eq(panels(), 1, '换一枚不会叠出第二扇');
      contains(
        H.textOf(H.q<HTMLElement>(document.body, '.kbw-panel')),
        '整理收件箱',
        '现在是「整理收件箱」那扇',
      );

      // ④ 移开：先留宽限（够移到浮层上继续读）、宽限过了关掉
      leave(buttons[1]);
      await H.settle(100);
      eq(panels(), 1, '刚移开还在（宽限中）');
      await H.settle(400);
      eq(panels(), 0, '宽限过了关掉');

      // ⑤ Esc 关得掉（重开一枚再按）
      enter(buttons[2], 'mouse');
      await H.settle(700);
      eq(panels(), 1, '再开一扇');
      H.keydown(document.body, 'Escape');
      await H.settle(120);
      eq(panels(), 0, 'Esc 关得掉');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §5 向导新形态（流程在 specWizard 里还有一整套；这里钉改版新增的）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 向导：引言 / 工作文件夹 / 结语 / 去建 / 配图', async () => {
    /** 点一次底栏主按钮（下一步 / 完成）——**往前一屏** */
    async function advance(): Promise<void> {
      /** ⚠️ 认**最上面那扇**模态的底栏 —— 叠着旧向导时会点到旧的那扇（找按钮的通用教训） */
      const modals = H.qa<HTMLElement>(document.body, '.kbw-modal');
      const top = modals[modals.length - 1];
      ok(top, '步进时该有向导模态');
      const btn = H.qa<HTMLElement>(top, '.kbw-modal-foot .kbw-btn').find((b) => {
        const t = H.textOf(b);
        return t.includes('下一步') || t.includes('完成');
      });
      ok(btn, '底栏有主按钮（下一步/完成）');
      H.click(btn as Element);
      await H.settle(120);
    }
    /** 从**当前屏**连点 n 次（屏序：0 引言 · 1 工作文件夹 · 2 模块 · 3 检测 · 4 结语） */
    async function advanceN(n: number): Promise<void> {
      for (let i = 0; i < n; i += 1) await advance();
    }

    await suite.it('引言屏：两栏对照 + 「跳过介绍」直达第 1 步', async () => {
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      const modal = topModal();
      ok(H.maybe(modal, '.kbw-wiz-intro'), '引言屏在');
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-col').length, 2, '两栏对照（原生 / 经纬）');
      const skip = H
        .qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn')
        .find((b) => H.textOf(b).includes('跳过介绍'));
      ok(skip, '引言屏的跳过按钮写着「跳过介绍」');
      H.click(skip as Element);
      await H.settle(90);
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-step').length, 3, '三格（v2 · #3 加了「到处看看」）');
      contains(H.textsOf(modal, '.kbw-wiz-step')[0], '工作文件夹', '第 1 步叫「工作文件夹」');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });

    await suite.it('第 1 步 fork（P7.11 · #11 试卷选项）：默认不选 · 未选无内容区 · 点「新建」→ 只出目录名 · 只落 kbRoot', async () => {
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      const modal = topModal();
      await advanceN(1);
      const opts = H.qa<HTMLElement>(modal, '.kbw-wiz-opt');
      // P7.14：两张 → **三张**（第三张「整个库」；那是向导 §E / whole-vault 两组的正主，这里只核在不在）
      eq(opts.length, 3, '三张选择卡（DOM 顺序照旧：新建在前）');
      // ⚠️ v2 · #8：卡片化（图标 + 标题 + 小字），「——」分隔与圆点都退役 —— textOf 是拼接文本
      eq(H.textOf(opts[0]), '新建起个名字', '第一张卡 = 新建（标题 + 小字）');
      eq(H.textOf(opts[1]), '用现成的选已有文件夹', '第二张卡 = 用现成的');
      ok(!opts.some((o) => o.classList.contains('is-on')), '默认不预选（Q8：丢掉"按现状猜"）');
      eq(H.qa(modal, '.kbw-wiz-field .kbw-input').length, 0, '未选 → 下方什么都不画');
      eq(H.maybe(modal, '.kbw-ftree'), null, '未选 → 也不画树');

      const fresh = opts[0];
      H.click(fresh);
      await H.settle(80);
      // ⚠️ 切模式会整屏重画 —— 旧引用是游离节点，判态要**重新取**
      const opts2 = H.qa<HTMLElement>(modal, '.kbw-wiz-opt');
      ok(
        opts2[0].classList.contains('is-on') && H.textOf(opts2[0]).includes('新建'),
        '切到「新建」（选中态挪到那一行）',
      );
      eq(H.qa(modal, '.kbw-wiz-field-label').map((l) => H.textOf(l)).join('/'), '目录名', '「新建」只出「目录名」一行');
      eq(H.maybe(modal, '.kbw-ftree'), null, '「新建」不画树');
      const input = H.q<HTMLInputElement>(modal, '.kbw-wiz-field .kbw-input');
      input.value = '我的知识库';
      input.dispatchEvent(new Event('input'));
      await H.settle(30);
      const metaBefore = ctx().settings.get().metaDir;
      const next = H
        .qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn')
        .find((b) => H.textOf(b).includes('下一步'));
      H.click(next as Element);
      await H.settle(200);
      // P7.14：「新建」正向离开时**真的把目录建出来**（轻量族 createEmptyFolder）
      ok(await app.vault.adapter.exists('我的知识库'), '「新建」真的把目录建出来了');
      eq(ctx().settings.kbRoot(), '我的知识库', '工作文件夹真的改了');
      eq(ctx().settings.get().metaDir, metaBefore, '「新建」不动元数据目录名');
      // 还原，别把后面的用例带进这个新库根
      await ctx().settings.save({ kbRoot: KB });
      await H.settle(150);
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });

    await suite.it('P7.10 · 库配置目录 + 库目录树（#2）：点节点 → 输入值变 · 手输口仍在 · 新建模式不画树', async () => {
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      const modal = topModal();
      await advanceN(1); // 引言 → 第 1 步
      // P7.11 · #11：**先点「用现成的」**才出内容区（树 + 两个输入框）
      const pickExisting = H
        .qa<HTMLElement>(modal, '.kbw-wiz-opt')
        .find((o) => H.textOf(o).includes('用现成的'));
      ok(pickExisting, '前提：「用现成的」选项在');
      H.click(pickExisting as Element);
      await H.settle(100);

      // ① 改名：label「元数据目录名」→「库配置目录」（旧名不再出现）
      const labels = H.textsOf(modal, '.kbw-wiz-field-label').join('/');
      contains(labels, '库配置目录', 'label 换成「库配置目录」');
      ok(!labels.includes('元数据目录名'), '旧名「元数据目录名」不再出现');

      // ② 树画出来了（替代原生 datalist）：点「01_新知识库」→「02_Areas」→ 输入值变
      const tree = H.q<HTMLElement>(modal, '.kbw-ftree');
      ok(tree, '库目录树画出来了');
      eq(H.qa(modal, 'datalist').length, 0, '原生 datalist 退役');
      // ⚠️ 认**名字那一格**（`.kbw-ftree-name`），不是整行 —— 行里还有三角字符
      //（`textOf(整行)` = '▸01_新知识库'，第一版就是这么假红的）
      const itemByName = (name: string): HTMLElement | undefined =>
        H.qa<HTMLElement>(tree, '.kbw-ftree-item').find(
          (el) => H.textOf(H.q<HTMLElement>(el, '.kbw-ftree-name') as HTMLElement) === name,
        );
      const kbNode = itemByName('01_新知识库');
      ok(kbNode, '树顶有「01_新知识库」');
      // 子层懒建：先点三角展开，才有「02_Areas」
      H.click(H.q<HTMLElement>(kbNode as HTMLElement, '.kbw-ftree-tri') as Element);
      await H.settle(30);
      const areaNode = itemByName('02_Areas');
      ok(areaNode, '展开后看得见「02_Areas」');
      const input = H.q<HTMLInputElement>(modal, '.kbw-wiz-field .kbw-input') as HTMLInputElement;
      H.click(areaNode as Element);
      await H.settle(30);
      eq(input.value, `${KB}/02_Areas`, '点节点 → 输入值跟着变');
      ok(areaNode!.classList.contains('is-sel'), '选中态挂在点过的那个节点上');

      // ③ 「新建」模式不画树（目录还不存在，没有可点的东西）；切回来树又有了
      const optOf = (word: string): HTMLElement =>
        H.qa<HTMLElement>(modal, '.kbw-wiz-opt').find((o) => H.textOf(o).includes(word)) as HTMLElement;
      H.click(optOf('新建'));
      await H.settle(80);
      eq(H.maybe(modal, '.kbw-ftree'), null, '「新建」模式没有树');
      H.click(optOf('用现成'));
      await H.settle(80);
      ok(H.maybe(modal, '.kbw-ftree'), '切回「用现成」树回来了（整屏重画，重新取过）');

      // ④ 手输口仍在：手动改输入框 → 「下一步」照样落盘（保留那个小口的目的）
      const input2 = H.q<HTMLInputElement>(modal, '.kbw-wiz-field .kbw-input') as HTMLInputElement;
      input2.value = `${KB}/00_Inbox`;
      input2.dispatchEvent(new Event('input'));
      await H.settle(20);
      H.click(
        H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((b) => H.textOf(b) === '下一步') as Element,
      );
      await H.settle(200);
      eq(ctx().settings.kbRoot(), `${KB}/00_Inbox`, '手输口照样能落盘');
      // 还原 kbRoot，别把后面的用例带进这个目录
      await ctx().settings.save({ kbRoot: KB });
      await H.settle(150);
      H.keydown(document.body, 'Escape');
      await H.settle(100);
    });

    await suite.it('检测屏退役：两步走完直接结语（不画检测行、不留「去建」动作口）', async () => {
      /**
       * P7.9 · ① 拍板：原第 3 步「现场检测」整屏去掉（库里缺什么，首页「待处理」里都有）——
       * 连带**「去建」这个向导唯一动作口一起退役**（骨架 / 补全的入口在各自的位置）。
       * 这条判据盯的就是"旧屏没有借尸还魂"。
       */
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      const modal = topModal();
      await advanceN(2); // 引言 → 第 1 步 → 第 2 步
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-toggle').length, 2, '第 2 步两个开关');
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-check-row').length, 0, '没有任何检测行');
      contains(H.textsOf(modal, '.kbw-wiz-step').join(' '), '模块开关', '停在第 2 步');
      await advanceN(1);
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-card').length, 4, '第 2 步的「下一步」直接进结语屏（P7.10 · #4：四张卡）');
      const retired = H
        .qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn')
        .find((b) => H.textOf(b).includes('去建') || H.textOf(b).includes('框架'));
      ok(!retired, '不再有「去建 / 建框架」动作口');
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-check-row').length, 0, '结语屏也没有检测行');
      H.keydown(document.body, 'Escape');
      await H.settle(100);
      await ctx().settings.save({ wizardDone: true });
      await H.settle(120);
    });

    await suite.it('结语屏：四张卡各按对（首页 / 全部笔记 / 看板 / AI）—— 点卡 = 完成 + 直切', async () => {
      /**
       * P7.10 · #4：三张 → **四张 2×2**（「首页」在左上、`is-home` 紫色强调；
       * 二拍① 卡内不再放小字）。「首页」是新加的出口 —— 原先想去首页得先随便切一个再点导航。
       */
      // 首页（新增；第一张 = 2×2 的左上）
      // ⚠️ 先切去「全部笔记」：不然"点首页卡切过去了"在本来就停在首页时**测不出东西**（自证）
      await closeOverlays();
      ctx().goNotes();
      await H.settle(150);
      eq(ctx().settings.get().activeModule, 'notes', '前提：起手在全部笔记（不在首页）');
      ctx().openWizard();
      await H.settle(100);
      await advanceN(3);
      const cards = H.qa<HTMLElement>(document.body, '.kbw-wiz-card');
      eq(cards.length, 4, '四张');
      eq(
        H.textsOf(document.body, '.kbw-wiz-card-t').join('/'),
        '首页/全部笔记/看板/AI 助手',
        '四张的标题与顺序（首页在首个）',
      );
      eq(H.qa<HTMLElement>(document.body, '.kbw-wiz-card-s').length, 0, '卡内不再有小字（二拍①）');
      ok(cards[0].classList.contains('is-home'), '「首页」卡带 is-home（紫色强调那档）');
      H.click(cards[0]);
      await H.settle(200);
      eq(ctx().settings.get().activeModule, 'home', '点「首页」切过去了（ctx.goHome 那条路）');
      eq(ctx().settings.get().wizardDone, true, '按「完成」记账');
      eq(H.maybe(document.body, '.kbw-wiz-card'), null, '向导收了');

      // 全部笔记
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      await advanceN(3);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-wiz-card')[1]);
      await H.settle(200);
      eq(ctx().settings.get().activeModule, 'notes', '点「全部笔记」切过去了');

      // 看板
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      await advanceN(3);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-wiz-card')[2]);
      await H.settle(200);
      eq(ctx().settings.get().activeModule, 'board', '点「看板」切过去了');

      // AI：打开的是 AI 面板（不是切模块）
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      await advanceN(3);
      H.click(H.qa<HTMLElement>(document.body, '.kbw-wiz-card')[3]);
      await H.settle(200);
      ok(H.maybe(document.body, '.kbw-ai-log'), 'AI 面板开出来了（认对话区那个类名）');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      await ctx().settings.save({ activeModule: 'home', wizardDone: true });
      await H.settle(100);
    });

    await suite.it('配图：引言两栏各一张 <img> 指向 assets/wizard/；**加载失败整块隐藏**', async () => {
      /**
       * P7.9 · ①：极简后只有**引言屏**在用配图（对比图即主视觉）——
       * 第 1/2 步的截图随字段注一起退役（效果稿里那两屏的主图示是选项卡 / 开关行）。
       */
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      const modal = topModal();
      const imgs = H.qa<HTMLImageElement>(modal, '.kbw-wiz-shot .kbw-wiz-img');
      ok(imgs.length >= 2, `引言两栏各一张配图（实际 ${imgs.length}）`);
      contains(imgs[0].getAttribute('src') ?? '', 'assets/wizard/', '地址指向随插件发布的 assets/wizard/');
      // 加载失败 → 整块藏起来（不摆破图）
      const box = imgs[0].closest('.kbw-wiz-shot') as HTMLElement;
      imgs[0].dispatchEvent(new Event('error'));
      await H.settle(30);
      ok(box.classList.contains('is-missing'), '加载失败时整块隐藏');
      await advanceN(2);
      eq(H.qa<HTMLElement>(modal, '.kbw-wiz-shot').length, 0, '第 1/2 步不再有截图（主图示 = 选项卡 / 开关行）');
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });

    await suite.it('字数纪律：全向导 lead 只剩结语一句（零 lead 拍板 —— P7.9 · ①）', async () => {
      /**
       * P7.9 · ① 拍板："每屏说明性文字 ≤25 字、**零 lead**" —— 引言 / 第 1 步 / 第 2 步的
       * lead 全删，只剩结语那句"都齐了。接下来去哪？"。这条判据盯的就是"lead 长回来"。
       */
      await closeOverlays();
      ctx().openWizard();
      await H.settle(100);
      const modal = topModal();
      const leads: string[] = [];
      for (let i = 0; i <= 3; i += 1) {
        leads.push(...H.textsOf(modal, '.kbw-wiz-lead'));
        if (i < 3) await advance();
      }
      const total = leads.join('').length;
      ok(total <= 25, `四屏 lead 合计 ${total} 字（零 lead 拍板：只剩结语那一句）`);
      ok(total >= 5, `不是空话（${total} 字）—— 防"全删了也绿"`);
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    });
  });

  // ════════════════════════════════════════════════════════════
  // §6 M4 漫步池：排除元数据目录与「还原保留-*」（2a 小账销账）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2b · 随机漫步的池（小账）', async () => {
    await suite.it('排除：元数据目录之下 / 还原保留-* / 「隐藏: true」；普通笔记保留', () => {
      const mk = (path: string, props: Record<string, unknown> = {}): NoteEntry =>
        ({ path, props }) as unknown as NoteEntry;
      /** 只用到 `.index.notes()` 与 `.settings.metaRoot()` 两样 —— 照最小面构造 */
      const fake = {
        index: {
          notes: () => [
            mk(`${KB}/00_Inbox/普通笔记.md`),
            mk(`${KB}/02_Areas/另一篇.md`),
            mk(`${KB}/99_Meta/05_操作日志/日志-20261003.md`),
            mk(`${KB}/99_Meta/02_模板库/Templater/T_x.md`),
            mk(`${KB}/还原保留-20261003/x.md`),
            mk(`${KB}/00_Inbox/藏起来的.md`, { 隐藏: true }),
            mk('02_别的库/00_Inbox/别的库的.md'),
          ],
        },
        settings: { metaRoot: () => `${KB}/99_Meta` },
      } as unknown as WorkbenchContext;
      deepEq(
        walkPool(fake).map((e) => e.path),
        [`${KB}/00_Inbox/普通笔记.md`, `${KB}/02_Areas/另一篇.md`, '02_别的库/00_Inbox/别的库的.md'],
        '元数据目录（日志/模板）、还原保留、隐藏项全排除；别的库不受影响',
      );
    });
  });
}
