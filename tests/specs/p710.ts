/**
 * spec：**P7.10 · #8 首入「全部笔记」的一次性讲解**（`ui/notes-intro.ts`）
 *
 * 三件要钉住：
 *   ① **只出一次**：旗标没写过 → 首次挂载弹；「知道了」后**旗标落盘**（data.json 回读，
 *      不只看内存）→ 换出去再进来不再弹；
 *   ② 「去看教程」= 关本卡 + 帮助栏**自动展开《找笔记》**（跨模块复用的"待消费意图"），
 *      且它同样算"看过"（不落盘的话用户得看点开教程的卡再关一次，等于白弹）；
 *   ③ 卡的内容形状：3–6 条「点哪里」+ 一行指路 + 两个按钮（防"卡长回来"）。
 *
 * ⚠️ 共用夹具（`seedDataJson`）显式写 `notesIntroSeen: true`（"这台设备见过"）——
 * 本组自己把它改回 false 来演"全新安装"。真默认那条由这段的裸 false 覆盖。
 * ⚠️ 跑完把旗标留 `true`（收起态），后来的用例不该再被这张卡罩住。
 */
import { Suite, contains, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import * as S from '../stub/index';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import type { WorkbenchContext } from '../../src/core/context';
import { relativeTo } from '../../src/core/paths';
import { AI_AGENT_LIMITS } from '../../src/services/ai';
import { confirm, type PlanRow } from '../../src/ui/confirm';

export async function specP710(suite: Suite, app: StubApp, plugin: KbWorkbenchPlugin): Promise<void> {
  const ctx = (): WorkbenchContext => plugin.context();

  await suite.group('P7.10 · 首入「全部笔记」的讲解（#8）', async () => {
    /** 收干净：讲解浮层 + 设置面板（Esc 逐层关；栈空后 Escape 是安全的） */
    async function closeAll(): Promise<void> {
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      H.keydown(document.body, 'Escape');
      await H.settle(80);
      H.keydown(document.body, 'Escape');
      await H.settle(80);
    }
    /** 演"刚从别处切进全部笔记"（先离再进 = 保证一次**新挂载**，不是聚焦旧模块） */
    async function enterNotesFresh(): Promise<void> {
      ctx().goHome();
      await H.settle(150);
      ctx().goNotes();
      await H.settle(250);
    }

    await suite.it('旗标没写过：首次进入弹一次（3–6 条「点哪里」+ 指路 + 两个按钮）', async () => {
      await closeAll();
      await ctx().settings.save({ notesIntroSeen: false });
      await enterNotesFresh();
      const intro = H.q<HTMLElement>(document.body, '.kbw-noteintro');
      const items = H.qa<HTMLElement>(intro, '.kbw-noteintro-list li');
      ok(
        items.length >= 3 && items.length <= 6,
        `「点哪里」条数在 3–6（实际 ${items.length}）`,
      );
      /**
       * P7.11 · #2（批注定稿）：标题加问号；五条**按眼睛扫屏的顺序重排并通俗化** ——
       * 逐字对表（方案 §2 的表格），别再改字。
       */
      eq(
        H.textOf(H.q<HTMLElement>(intro, '.kbw-panel-title')),
        '第一次来「全部笔记」？',
        '标题逐字（加问号）',
      );
      deepEq(
        items.map((li) => H.textOf(li)),
        [
          '左边是目录树：一层一层点进去',
          '上面有搜索框和筛选，找不到就搜一下',
          '右上角能换两种看法：网格 / 详细信息',
          '双击打开一篇；F2 改名字；Delete 丢进回收站',
          '勾选几篇，顶上会变成批量操作条（迁移 / 属性 / 标签）',
        ],
        '五条逐字 + 顺序（左→上→右上→列表→多选）',
      );
      contains(H.textOf(intro), '教程中心', '有一行指路教程中心');
      const btns = H.qa<HTMLElement>(intro, '.kbw-panel-foot .kbw-btn');
      ok(
        btns.some((b) => H.textOf(b) === '知道了'),
        '有「知道了」',
      );
      ok(
        btns.some((b) => H.textOf(b) === '去看教程'),
        '有「去看教程」',
      );
    });

    await suite.it('「知道了」→ 旗标落盘（data.json 回读）· 换出去再进来不再弹', async () => {
      // 接上一条：浮层还开着
      const intro = H.q<HTMLElement>(document.body, '.kbw-noteintro');
      const ok_ = H
        .qa<HTMLElement>(intro, '.kbw-panel-foot .kbw-btn')
        .find((b) => H.textOf(b) === '知道了') as HTMLElement;
      H.click(ok_);
      await H.settle(120);
      eq(H.maybe(document.body, '.kbw-noteintro'), null, '关掉了');
      eq(ctx().settings.get().notesIntroSeen, true, '内存里是 true');
      // 落盘（`data.json`）—— 不只看内存（本项目的经典假绿形态）
      const raw = JSON.parse(
        await app.vault.adapter.read('.obsidian/plugins/kb-workbench/data.json'),
      ) as { notesIntroSeen?: unknown };
      eq(raw.notesIntroSeen, true, '真的写进 data.json 了（不是只改了内存）');
      // 换出去再进来：新挂载，不再弹
      await enterNotesFresh();
      eq(H.maybe(document.body, '.kbw-noteintro'), null, '再进不再弹');
    });

    await suite.it('「去看教程」→ 关本卡 + 帮助栏自动展开《找笔记》（意图复用）· 也算看过', async () => {
      await closeAll();
      await ctx().settings.save({ notesIntroSeen: false });
      await enterNotesFresh();
      const intro = H.q<HTMLElement>(document.body, '.kbw-noteintro');
      const go = H
        .qa<HTMLElement>(intro, '.kbw-panel-foot .kbw-btn')
        .find((b) => H.textOf(b) === '去看教程') as HTMLElement;
      H.click(go);
      await H.settle(200);
      eq(H.maybe(document.body, '.kbw-noteintro'), null, '本卡关掉了');
      const tab = H.q<HTMLElement>(document.body, '.kbw-set-tab[data-section="help"]');
      ok(tab.classList.contains('is-on'), '落在「帮助」栏');
      const cards = H.qa<HTMLElement>(document.body, '.kbw-tut-card');
      eq(cards.length, 10, '教程十篇（前提）');
      ok(cards[8].classList.contains('is-open'), '《找笔记》（第 9 篇）打开即展开');
      eq(ctx().settings.get().notesIntroSeen, true, '「去看教程」也算看过（不再弹）');
      await closeAll();
    });

    await suite.it('离开全部笔记会收掉浮层，但**不落旗标**（是"你离开了"，不是"你看完了"）', async () => {
      await closeAll();
      await ctx().settings.save({ notesIntroSeen: false });
      await enterNotesFresh();
      ok(H.maybe(document.body, '.kbw-noteintro'), '浮层在（前提）');
      ctx().goHome();
      await H.settle(200);
      eq(H.maybe(document.body, '.kbw-noteintro'), null, '离开这一屏就收掉了');
      eq(ctx().settings.get().notesIntroSeen, false, '旗标没动（下次进来该照弹）');
      // 收尾：留"看过"的稳态（后来的用例不该被这张卡罩住）
      await ctx().settings.save({ notesIntroSeen: true });
      await H.settle(60);
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.10 · #11 历史抽屉的行内动作（导出为笔记 / 删除对话）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.10 · #11 抽屉行内动作', async () => {
    /** 收干净：面板 / 抽屉 / 菜单（Esc 一层层收） */
    async function closeAllAi(): Promise<void> {
      for (let i = 0; i < 5; i += 1) {
        const open =
          H.qa<HTMLElement>(document.body, '.kbw-modal').length +
          H.qa<HTMLElement>(document.body, '.kbw-panel').length;
        if (open === 0) return;
        H.keydown(document.body, 'Escape');
        await H.settle(80);
      }
    }

    /** 跑一轮假模型（search 一步 + 收尾），把会话落进抽屉；返回面板 */
    async function oneTurn(q: string): Promise<HTMLElement> {
      await closeAllAi();
      H.resetAi();
      H.stubAiSeq([
        { reply: '看一眼。', actions: [{ tool: 'search', args: { dir: '00_Inbox' } }] },
        { reply: '就这些。' },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = q;
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(120);
      return panel;
    }

    /** 开抽屉（R4 起「历史对话」收进头部「⋯」菜单）并等列表画出来 */
    async function openDrawer(panel: HTMLElement): Promise<HTMLElement> {
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-morebtn'));
      await H.settle(30);
      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('历史对话'),
        ) as HTMLElement,
      );
      const drawer = await (async () => {
        const got = await H.until(() => Boolean(H.maybe<HTMLElement>(panel, '.kbw-ai-drawer')), 2500);
        return got ? (H.maybe<HTMLElement>(panel, '.kbw-ai-drawer') as HTMLElement) : null;
      })();
      ok(drawer, '抽屉开出来了');
      return drawer as HTMLElement;
    }

    await suite.it('行 = 容器 + 主按钮 + 两枚动作（默认隐藏的类在）；导出 → 新建对话框预填该段', async () => {
      const panel = await oneTurn('看看收件箱里有什么');
      const drawer = await openDrawer(panel);
      const row = H.q<HTMLElement>(drawer, '.kbw-ai-sess');
      ok(H.maybe<HTMLElement>(row, '.kbw-ai-sess-pick'), '行里有主按钮（载入这一段）');
      const acts = H.q<HTMLElement>(row, '.kbw-ai-sess-acts');
      ok(acts, '两枚动作的容器在（默认隐藏走 CSS —— 静态红线另钉）');
      const icons = H.qa<HTMLElement>(acts, '.kbw-iconbtn');
      eq(icons.length, 2, '整整两枚（导出 / 删除）');
      ok(
        (icons[0].getAttribute('aria-label') ?? '').includes('导出'),
        '第一枚是「导出为笔记」',
      );
      ok(
        (icons[1].getAttribute('aria-label') ?? '').includes('删除'),
        '第二枚是「删除对话」',
      );
      // 导出：读**这一段** → 新建笔记对话框预填（标题 + 正文）
      H.click(icons[0]);
      await H.settle(150);
      const dlg = H
        .qa<HTMLElement>(document.body, '.kbw-modal')
        .find((m) => H.textOf(m).includes('新建笔记'));
      ok(dlg, '新建笔记对话框开出来了');
      const title = H.q<HTMLInputElement>(dlg as HTMLElement, '.kbw-form .kbw-input');
      contains(title.value, 'AI 对话', `标题预填成「AI 对话 …」（实际「${title.value}」）`);
      contains(title.value, '看看收件箱里有什么', '带着那一段的标题');
      await closeAllAi();
      H.resetAi();
    });

    await suite.it('删除 → 轻确认小框（"删了不能撤"）→ 文件真没了 + 列表刷新', async () => {
      const panel = await oneTurn('要删的那一段');
      const metas = await ctx().ai.sessions.list();
      ok(metas.length >= 1, `前提：会话列表非空（${metas.length} 段）`);
      const victim = metas[0]; // 最近的那段（抽屉第一行）
      const fileOfVictim = `${ctx().ai.sessions.rootDir()}/${victim.id}.json`;
      ok(await app.vault.adapter.exists(fileOfVictim), '前提：那段会话的文件在');

      const drawer = await openDrawer(panel);
      const row = H.q<HTMLElement>(drawer, '.kbw-ai-sess');
      const del = H
        .qa<HTMLElement>(row, '.kbw-ai-sess-acts .kbw-iconbtn')
        .find((b) => (b.getAttribute('aria-label') ?? '').includes('删除'));
      ok(del, '行里有删除按钮');
      H.click(del as HTMLElement);
      const cfm = await (async () => {
        await H.until(
          () => H.qa<HTMLElement>(document.body, '.kbw-modal').some((m) => H.textOf(m).includes('删除这段对话')),
          2500,
        );
        return H.qa<HTMLElement>(document.body, '.kbw-modal').find((m) =>
          H.textOf(m).includes('删除这段对话'),
        );
      })();
      ok(cfm, '轻确认小框弹出来了');
      contains(H.textOf(cfm as HTMLElement), '删了不能撤', '说清"删了不能撤"');
      /**
       * **先取消：一个字都不许删** —— 这条是"确认真的在管用"的反面判据
       *（没有它，一个"无视确认结果、弹了框也照删"的实现照样绿；突变 M4 就咬这）。
       */
      const cancelBtn = H
        .qa<HTMLElement>(cfm as HTMLElement, '.kbw-modal-foot .kbw-btn')
        .find((b) => H.textOf(b) === '取消');
      ok(cancelBtn, '有「取消」');
      H.click(cancelBtn as HTMLElement);
      await H.settle(150);
      ok(await app.vault.adapter.exists(fileOfVictim), '取消之后文件还在（没有偷偷删）');
      eq((await ctx().ai.sessions.list()).length, metas.length, '列表也没少');
      // 再来一次，这回点「删除」
      H.click(del as HTMLElement);
      await H.until(
        () =>
          H.qa<HTMLElement>(document.body, '.kbw-modal').some((m) =>
            H.textOf(m).includes('删除这段对话'),
          ),
        2500,
      );
      const cfm2 = H
        .qa<HTMLElement>(document.body, '.kbw-modal')
        .find((m) => H.textOf(m).includes('删除这段对话'));
      ok(cfm2, '第二次确认框弹出来了');
      contains(
        H.textOf(cfm2 as HTMLElement),
        '当前这段',
        '删的是当前段 → 确认框如实说"面板会一起清空"（独立审 🟡1）',
      );
      const primary = H
        .qa<HTMLElement>(cfm2 as HTMLElement, '.kbw-modal-foot .kbw-btn')
        .find((b) => H.textOf(b) === '删除');
      ok(primary, '主按钮是「删除」');
      H.click(primary as HTMLElement);
      // ⚠️ `H.until` 只吃**同步**判定 —— 文件存在性是异步 API，这里手动轮询
      let gone = false;
      for (let i = 0; i < 50 && !gone; i += 1) {
        gone = !(await app.vault.adapter.exists(fileOfVictim));
        if (!gone) await H.settle(50);
      }
      ok(gone, '文件真没了（只动插件目录）');
      await H.settle(150);
      const after = await ctx().ai.sessions.list();
      eq(after.length, metas.length - 1, '列表少了一段');
      /**
       * 🔴 **独立审 🟡1 的回归**：删的正是当前载入的那一段 → 面板必须**真的收掉**它
       *（走 newChat 清屏）—— 否则下一轮 `persist()` 会把整段原样写回来（"删了又回来"）。
       */
      ok(!H.maybe(panel, '.kbw-ai-drawer'), '当前段被删：抽屉收起（newChat 那条路）');
      eq(
        H.qa<HTMLElement>(panel, '.kbw-ai-bubble').filter(
          (b) => !b.classList.contains('kbw-ai-intro'),
        ).length,
        0,
        '屏上的对话清空了（只剩开场引导那条气泡）',
      );
      const toast = H
        .qa<HTMLElement>(document.body, '.kbw-notice')
        .find((n) => H.textOf(n).includes('已删除这段对话'));
      ok(toast, '轻提示报了（不打断）');
      // 再问一轮也不许把那段"复活"回来（复活发生在 persist 一端 —— 这里正面验它）
      H.stubAiSeq([{ reply: '收到。' }]);
      const beforeSend = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '再来一句';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > beforeSend, 4000);
      await H.settle(250);
      const backAgain = (await ctx().ai.sessions.list()).some((m) => m.id === victim.id);
      eq(backAgain, false, '再聊一轮之后，被删那段没有复活（新的一段是新 id）');
      await closeAllAi();
      H.resetAi();
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.10 · #12 引用小面板 · 工作目录（scopeDir 收窄）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.10 · #12 引用面板与工作目录', async () => {
    async function closeAll12(): Promise<void> {
      for (let i = 0; i < 6; i += 1) {
        const open =
          H.qa<HTMLElement>(document.body, '.kbw-modal').length +
          H.qa<HTMLElement>(document.body, '.kbw-panel').length;
        if (open === 0) return;
        H.keydown(document.body, 'Escape');
        await H.settle(80);
      }
    }

    await suite.it('@ 面板化：搜索过滤 / 目录下钻 / 文件夹可引用（清单进提示词）', async () => {
      await closeAll12();
      H.resetAi();
      H.stubAiSeq([{ reply: '收到。' }]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      /**
       * ⚠️ **先等"恢复上一段会话"落定**：开面板那一刻会异步读最近一段会话并 `loadInto()`
       * —— 那一步会清掉 refs / 能力包 / 工作目录（"换了一段上下文"）。不等它，
       * 我们在窗口期里设的东西会在恢复回来时被清掉（全量跑时前面组刚落过会话，
       * 单跑反而看不见 —— P7.10 实测栽过）。没有历史会话时这段至多白等 800ms。
       */
      await H.until(() => Boolean(H.maybe<HTMLElement>(panel, '.kbw-ai-hist')), 800);
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-plusbtn'));
      await H.settle(30);
      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('引用一篇笔记'),
        ) as HTMLElement,
      );

      const picker = await (async () => {
        await H.until(() => Boolean(H.maybe<HTMLElement>(document.body, '.kbw-ai-refpanel')), 2500);
        return H.maybe<HTMLElement>(document.body, '.kbw-ai-refpanel');
      })();
      ok(picker, '@ 引用小面板开出来了');
      const search = H.q<HTMLInputElement>(picker as HTMLElement, '.kbw-ai-refsearch');
      // ① 搜索过滤：全库按标题找
      search.value = '9.16';
      search.dispatchEvent(new Event('input'));
      await H.settle(30);
      const hits = H.qa<HTMLElement>(picker as HTMLElement, '.kbw-ai-refitem');
      ok(
        hits.some((r) => H.textOf(r).includes('9.16')),
        `搜索能命中（实际：${hits.map((r) => H.textOf(r)).join(' | ')}）`,
      );
      // ② 目录下钻：点树上的目录 → 列表换成那一层（搜索清空）
      search.value = '';
      search.dispatchEvent(new Event('input'));
      await H.settle(30);
      const treeNode = H
        .qa<HTMLElement>(picker as HTMLElement, '.kbw-ftree-item')
        .find((n) => H.textOf(H.q<HTMLElement>(n, '.kbw-ftree-name')) === '00_Inbox');
      ok(treeNode, '树上有「00_Inbox」（前提）');
      H.click(treeNode as HTMLElement);
      await H.settle(30);
      const notesNow = H.qa<HTMLElement>(picker as HTMLElement, '.kbw-ai-refitem');
      ok(notesNow.length >= 1, `下钻后列表重画（${notesNow.length} 行）`);
      ok(notesNow[0].classList.contains('is-folder'), '首行是「引用这个文件夹」');
      contains(H.textOf(notesNow[0]), '00_Inbox', '文件夹行标明目录');
      // ③ 引用文件夹 → 胶囊
      H.click(notesNow[0]);
      await H.settle(60);
      eq(H.maybe<HTMLElement>(document.body, '.kbw-ai-refpanel'), null, '选完面板自己关掉');
      const chip = H.q<HTMLElement>(panel, '.kbw-ai-ref');
      contains(H.textOf(chip), '文件夹', '胶囊标明这是文件夹引用');
      // ④ 材料进提示词：发一轮，读第一发请求的 body
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '说说这个文件夹';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 4000);
      await H.settle(80);
      // agent 的模型调用走 `requestUrl`（chat 路）→ 记在 `requestLog`（P7.10 实测）
      const first = String(S.requestLog[0]?.body ?? '');
      contains(first, '### 文件夹：', '材料段写了"文件夹："');
      contains(first, '00_Inbox/', '清单里带路径（相对库根）');
      await closeAll12();
      H.resetAi();
    });

    await suite.it('工作目录：越界调用被拒（搜/搬/读/建）· 界内照常 · 无 dir 过滤 · 清掉恢复全库', async () => {
      await closeAll12();
      H.resetAi();
      // 找一篇 02_Areas 里的真笔记当"越界的搬/读"目标（vault A 夹具里有）
      const kbRoot = ctx().settings.kbRoot();
      const outside = ctx()
        .index
        .notes()
        .find((e) => e.path.startsWith(`${kbRoot}/02_Areas/`));
      ok(outside, '前提：库里有 02_Areas 的笔记');
      const outsideRel = relativeTo((outside as { path: string }).path, kbRoot);

      H.stubAiSeq([
        // 第一轮：搜界外的目录（拒）+ 搬界外的篇（拒，预检拦下、连确认都不弹）
        {
          reply: '先到处看看。',
          actions: [
            { tool: 'search', args: { dir: '02_Areas' } },
            { tool: 'move', args: { path: outsideRel, to: '01_Projects' } },
          ],
        },
        // 第二轮：界内搜（放行）
        { reply: '那就看收件箱。', actions: [{ tool: 'search', args: { dir: '00_Inbox' } }] },
        // 第三轮：界外读 + 界外新建落点（都拒 —— 独立审 🟢4 补的分支覆盖）
        {
          reply: '再翻翻。',
          actions: [
            { tool: 'read', args: { path: outsideRel } },
            { tool: 'create', args: { dir: '01_Projects', title: '界外新建' } },
          ],
        },
        // 第四轮：**不带 dir 的搜**（放行，但结果要过滤到范围内 —— 口径的另一半）
        { reply: '全搜一遍。', actions: [{ tool: 'search', args: { query: 'md' } }] },
        { reply: '好了。' },
      ]);
      await H.configAi(plugin);
      ctx().openAi();
      const panel = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      // 先等"恢复上一段会话"落定（它会把窗口期里设的工作目录清掉 —— 见上一条用例那段注释）
      await H.until(() => Boolean(H.maybe<HTMLElement>(panel, '.kbw-ai-hist')), 800);

      // 设工作目录 = 00_Inbox（按钮 → 树 → 点节点）
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-plusbtn'));
      await H.settle(30);
      H.click(
        H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) =>
          H.textOf(i).includes('工作目录'),
        ) as HTMLElement,
      );
      const dirPanel = await (async () => {
        await H.until(() => Boolean(H.maybe<HTMLElement>(document.body, '.kbw-ai-dirpanel')), 2500);
        return H.maybe<HTMLElement>(document.body, '.kbw-ai-dirpanel');
      })();
      ok(dirPanel, '工作目录面板开出来了');
      const node = H
        .qa<HTMLElement>(dirPanel as HTMLElement, '.kbw-ftree-item')
        .find((n) => H.textOf(H.q<HTMLElement>(n, '.kbw-ftree-name')) === '00_Inbox');
      ok(node, '树上有「00_Inbox」');
      H.click(node as HTMLElement);
      await H.settle(80);
      const chip = H.q<HTMLElement>(panel, '.kbw-ai-dirchip');
      contains(H.textOf(chip), '00_Inbox', '工作目录胶囊钉住了范围');

      // 跑一轮：两处越界被拒 + 一处界内放行
      const before = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '看看库里有什么';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before, 5000);
      await H.settle(120);
      const txt = H.textOf(panel);
      contains(txt, '工作目录之外', '越界的调用被拒并如实说明');
      contains(txt, '命中', '界内的 search 照常执行');
      // 没弹过任何确认框（越界的 move 在预检就被拦下 —— 连摆到用户面前都没有）
      eq(
        H.qa<HTMLElement>(document.body, '.kbw-modal').length,
        1,
        '除了面板自己，没有别的模态（确认流没被拉起来）',
      );
      eq(
        (await ctx().ai.sessions.list()).length > 0,
        true,
        '一轮结束（会话照常落盘）',
      );
      // 提示词里也说了范围（第一发请求）；越界被拒的结果随结果带回给模型（第二发）
      const firstBody = String(S.requestLog[0]?.body ?? '');
      contains(firstBody, '这次对话的工作目录：00_Inbox', '提示词里说清了工作目录');
      const secondBody = String(S.requestLog[1]?.body ?? '');
      contains(secondBody, '工作目录之外', '模型也看到了越界被拒的结果（第二发带回去）');
      /**
       * **无 dir 的搜 = 过滤到范围**（独立审 🟢4 补的口径另一半）。
       * ⚠️ 判在**步骤行的命中数**上：`outcome.detail`（逐条路径）只喂给模型、**不进 DOM**；
       * 而整发请求 body 又不能判（提示词材料本身就含全库候选）。命中数则一眼二值：
       * 过滤生效 → 恰 = 范围内全量；没过滤 → 全库命中数（明显更大）。
       * 第 2 轮（dir=00_Inbox）与第 4 轮（无 dir）打的是**同一个集合**，两处都该相等。
       */
      const scopeCount = ctx()
        .index.notes()
        .filter((e) => e.path.startsWith(`${kbRoot}/00_Inbox/`)).length;
      const hitRows = H
        .qa<HTMLElement>(panel, '.kbw-ai-bubble .kbw-ai-step')
        .filter((n) => H.textOf(n).includes('命中'));
      eq(hitRows.length, 2, `两次「命中」都在（界内 dir 一次 + 无 dir 过滤一次；实际 ${hitRows.length}）`);
      /**
       * search 工具上限（`AI_AGENT_LIMITS.searchHits`）—— ⚠️ P7.22a 独立审 🟡6：
       * 原先是硬编码的 `Math.min(scopeCount, 20)`，上限 20→50 后推导就错了（夹具一长过旧值
       * 会假红/假绿）—— 改成从常量取。
       */
      const shownN = Math.min(scopeCount, AI_AGENT_LIMITS.searchHits);
      for (const r of hitRows) {
        contains(
          H.textOf(r),
          `命中 ${shownN} 篇`,
          '命中数 = 范围内全量（过滤生效：没把全库都算进来）',
        );
      }

      // 清掉 → 恢复全库：界外的 search 又行了
      H.click(H.q<HTMLElement>(chip, '.kbw-ai-ref-x'));
      await H.settle(60);
      eq(H.maybe<HTMLElement>(panel, '.kbw-ai-dirchip'), null, '胶囊清掉了');
      H.stubAiSeq([
        { reply: '再看看。', actions: [{ tool: 'search', args: { dir: '02_Areas' } }] },
        { reply: '好。' },
      ]);
      const before2 = panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length;
      H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input').value = '再看看别处';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > before2, 5000);
      await H.settle(120);
      contains(H.textOf(panel), '命中', '清掉工作目录后，界外的 search 恢复');
      await closeAll12();
      H.resetAi();
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.10 · #9 确认流预览折叠（独立审 🟡2 指出的单位回归）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.10 · 确认流预览折叠', async () => {
    await suite.it('超过 12 行才折叠：默认「还有 N 组」· foldUnit=篇 时说「还有 N 篇」', async () => {
      const rows = (n: number): PlanRow[] =>
        Array.from({ length: n }, (_, i) => ({
          kind: 'move' as const,
          from: `《甲${i + 1}》`,
          to: '01_Projects',
          count: 1,
        }));
      // 默认（分组型调用方：migrate / rebuild / suggest…）→「组」
      const p1 = confirm({
        title: '测试折叠',
        preview: rows(14),
        warnings: [],
        notes: [],
        primary: { label: '好' },
      });
      await H.settle(80);
      const m1 = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      contains(H.textOf(m1), '还有 2 组', '默认量词 = 组（分组行口径）');
      eq(
        H.qa<HTMLElement>(m1, '.kbw-confirm-preview .kbw-plan-row').length,
        13,
        '12 行 + 1 折叠行',
      );
      H.keydown(document.body, 'Escape');
      await H.settle(100);
      void p1;
      // tidy 那条路（逐篇预览）→「篇」
      const p2 = confirm({
        title: '测试折叠',
        preview: rows(14),
        warnings: [],
        notes: [],
        primary: { label: '好' },
        foldUnit: '篇',
      });
      await H.settle(80);
      const m2 = H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
      contains(H.textOf(m2), '还有 2 篇', 'foldUnit=篇（一键整理的逐篇预览）');
      H.keydown(document.body, 'Escape');
      await H.settle(100);
      void p2;
    });
  });
}
