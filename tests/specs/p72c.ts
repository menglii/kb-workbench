/**
 * spec：**P7.2c 全局手感**（1.3 快捕改版 + 剪藏 · 7.1 菜单移开收起 · 4.3 小窗 Windows 化）
 *
 * 完成定义对应的判据（本文件）：
 *   · 快捕：文案四处（旧句不留半截）/ 第五类「直接选目录」（真落 + `dir:` 键 + 预选）/
 *     零板块不再拦（面板照开、只剩目录组）；
 *   · 剪藏：正常（粘贴路由 → 标题自动改 → 正文 + 首行链接 + `来源`）·
 *     降级（剥出来是空 → 照落"标题+链接"、通知如实说）/ 纯函数（剥文本、超时、非网页、HTTP 错）；
 *   · 来源：schema 进了属性表 + 默认列隐藏（v3→v4 迁移在 `specSettings`）；
 *   · 丢进板块：按条件画（shelter / 没取值 / 对这篇没用的都不画）+ 三种源各一条真动作；
 *   · 菜单收起：300ms 到点收 / 期间回链内撤销 / 换父项立即切 / **触屏与键盘路径不受影响**；
 *   · 小窗：双击最大化 ⇄ 还原（铺满 `.kbw-root`）/ 几何"结束才报" + `initialGeo` 越界夹回 /
 *     点击置顶（DOM 顺序）/ 停靠态空操作。
 *
 * ⚠️ 起手清场纪律（跨用例污染是本项目栽得最多的一类）：
 *   · 夹具全带 `__` 前缀，每条收尾删文件 + `rescan` + `index.rebuild()`；
 *   · `requestUrl` 注入一律 `__resetRequests()` 收尾（桩默认"没注入就抛"）；
 *   · `lastCapture` / `panelGeo` 是本用例写过的就拨回 `null`；
 *   · 面板/菜单收干净（`closeAllMenus` / `purgeOverlays`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { __resetRequests, setRequestHandler } from '../stub/index';
import { Suite, contains, deepEq, eq, notContains, ok } from '../framework';
import * as H from '../helpers';
import { captureTargets, dirTargets, noteTargets } from '../../src/modules/board/capture';
import { CLIP_TIMEOUT_MS, clipUrl, extractReadable, looksLikeUrl } from '../../src/services/clip';
import { SPEC_BY_NAME } from '../../src/services/schema';
import { DEFAULT_HIDDEN } from '../../src/modules/notes/columns';
import { MENU_SUB_CLOSE_MS, closeAllMenus, showMenu } from '../../src/ui/menu';
import { openFloating, purgeOverlays } from '../../src/ui/panel';
import { __resetNotices } from '../../src/ui/notify';

const KB = '01_新知识库';
const BOARD_CFG = `${KB}/99_Meta/06_工作台/看板配置.json`;

export async function specP72c(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 造一篇笔记并让索引看见（走 modify 事件 = 真链路） */
  async function putNote(rel: string, body: string, props: Record<string, unknown> = {}): Promise<void> {
    H.writeNote(
      vaultRoot,
      rel,
      H.note(body, { 类型: '想法', 领域: '未分类', 状态: '待整理', ...props }),
    );
    app.vault.rescan();
    app.vault.trigger('modify', app.vault.getAbstractFileByPath(rel));
    await H.settleIndex(app, 260);
  }

  /** 收走一篇夹具（删 + 重建索引） */
  async function dropNote(rel: string): Promise<void> {
    fs.rmSync(path.join(vaultRoot, rel), { force: true });
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app, 220);
  }

  async function writeBoardCfg(data: unknown): Promise<void> {
    H.writeNote(vaultRoot, BOARD_CFG, `${JSON.stringify(data, null, 2)}\n`);
    app.vault.rescan();
    const f = app.vault.getAbstractFileByPath(BOARD_CFG);
    app.vault.trigger('modify', f);
    await H.settle(320);
  }

  async function navTo(label: string): Promise<void> {
    const nav = H.qa<HTMLElement>(document.body, '.kbw-navitem').find((b) =>
      H.textOf(b).includes(label),
    );
    ok(nav, `导航里有「${label}」`);
    H.click(nav as Element);
    await H.settle(160);
  }

  /** 打开快速捕获面板（走 ctx 的真入口） */
  async function openCapture(): Promise<HTMLElement> {
    await ctx().activate();
    ctx().quickCapture();
    const modal = await H.until(() => !!H.maybe(document.body, '.kbw-modal'), 800);
    ok(modal, '快速捕获面板该打开了');
    return H.q<HTMLElement>(document.body, '.kbw-modal');
  }

  // ════════════════════════════════════════════════════════════
  // ① 落点解析（纯函数）：第五类 + 「丢进板块」的过滤视图
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2c · 1.3 落点解析（纯函数）', async () => {
    await suite.it('第五类「直接选目录」：键加 dir: 前缀（与板块 id 分开）· 库根有名字 · 落点如实说', () => {
      const got = dirTargets(['', '00_Inbox', '02_Areas/内容创作']);
      eq(got.length, 3, '每个目录一行');
      eq(got[0]?.key, 'dir:', '库根的键是 dir:（空路径照旧有键）');
      eq(got[0]?.label, '库根', '库根不显示成空串');
      eq(got[1]?.key, 'dir:00_Inbox', '键加 dir: 前缀 —— 与板块 id 不会撞（lastCapture 只存字符串）');
      eq(got[1]?.dirRel, '00_Inbox', '落点就是那个目录');
      eq(JSON.stringify(got[1]?.props), '{}', '目录落点不补属性');
      contains(got[1]?.detail ?? '', '直接选', '说明里点破"这是你直接选的目录"');
    });

    await suite.it('noteTargets：shelter / 没取值 / 对这篇没用的（已在那块·已有那标签·值已相同）都不画', () => {
      const cfg = {
        version: 1,
        view: {},
        sections: [
          { id: 'f1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
          { id: 't1', name: '灵感', kind: 'tag', value: '灵感' },
          { id: 'p1', name: '状态', kind: 'prop', value: '状态' },
          { id: 'p2', name: '来源', kind: 'prop', value: '来源' },
          { id: 'x1', name: '收容所', kind: 'shelter', value: '' },
        ],
      } as unknown as Parameters<typeof captureTargets>[0];
      const all = captureTargets(cfg, {
        inbox: '00_Inbox',
        valuesOf: (p) => (p === '来源' ? [] : ['进行中', '已完成']),
      });
      /** 这篇：已在 00_Inbox、有标签 灵感、状态还是 待整理 */
      const usable = noteTargets(all, { dirRel: '00_Inbox', tags: ['#灵感'], props: { 状态: '待整理' } });
      const labels = usable.map((t) => t.label);
      ok(labels.includes('内容创作'), `folder 源可丢（实际 ${labels.join(' | ')}）`);
      ok(!labels.includes('灵感'), '已经有这个标签 → 并集不会变，不画（死选项口径）');
      ok(labels.includes('状态 = 进行中'), '值不同 → 覆盖有意义，画');
      ok(labels.includes('状态 = 已完成'), '同一属性的另一个取值照画');
      ok(!labels.includes('来源'), '属性源一个取值都没有 → 不画（disabled 挡掉）');
      ok(!labels.includes('收容所'), 'shelter 不画（"谁都没命中"的定义，主动丢进去没有语义）');
      /** 已在它目录里 → folder 死选项 */
      const inDir = noteTargets(all, { dirRel: '02_Areas/内容创作', tags: [], props: {} });
      ok(
        !inDir.some((t) => t.label === '内容创作'),
        '已经在那块 → 搬过去是 no-op（mover 会判 already），不画',
      );
      /** 值已相同 → 那条 prop 行不画 */
      const sameVal = noteTargets(all, { dirRel: '', tags: [], props: { 状态: '进行中' } });
      ok(!sameVal.some((t) => t.label === '状态 = 进行中'), '值已相同 → 覆盖不会变，不画');
      ok(sameVal.some((t) => t.label === '状态 = 已完成'), '别的取值照旧在');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 快速捕获面板：文案四处 + 直接选目录（真链路）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2c · 1.3 快速捕获面板（文案 + 直接选目录）', async () => {
    await suite.it('文案四处（副标题/占位/提示/通知）全换 —— 旧句子不许留半截；两组下拉', async () => {
      __resetNotices();
      await writeBoardCfg({
        version: 1,
        view: {},
        sections: [{ id: 't1', name: '灵感', kind: 'tag', value: '灵感' }],
      });
      const modal = await openCapture();
      const text = H.textOf(modal);
      contains(text, '不离开你手头的事', '副标题是新语气的一句人话');
      notContains(text, '落点依据', '旧句子（落点依据跟着通知报出来）不许留半截');
      const title = H.q<HTMLInputElement>(modal, '[data-capture="title"]');
      eq(title.placeholder, '给这一条起个名', '标题占位是新文案');
      const link = H.q<HTMLInputElement>(modal, '[data-capture="link"]');
      contains(link.placeholder, '剪藏', '链接行占位说清"粘上就是剪藏"');
      const sel = H.q<HTMLSelectElement>(modal, '[data-capture="target"]');
      const groups = Array.from(sel.querySelectorAll('optgroup')).map((g) => g.getAttribute('label'));
      deepEq(groups, ['丢进板块', '直接选目录'], '两组：板块 + 第五类目录');
      eq(sel.value, 't1', '默认还是第一个能用的板块（目录组在后面）');
      /** 提示行（选中板块的 detail）也是新语气 */
      contains(text, '顺手加上标签', '落点提示说"顺手补什么"（不再是「补标签 X」的工程话）');
      notContains(text, '· 补标签', '旧提示句式不留半截');
      /** 通知文案：真丢一条看回执 */
      title.value = '__快捕文案';
      const go = H.qa<HTMLButtonElement>(modal, 'button').find((b) => H.textOf(b).includes('丢一条'));
      ok(go, '主按钮是「丢一条」');
      H.click(go as Element);
      await H.settleIndex(app, 420);
      const rel = `${KB}/00_Inbox/__快捕文案.md`;
      ok(H.exists(vaultRoot, rel), '落进收件箱了');
      const notices = H.qa(document.body, '.kbw-notice').map((n) => H.textOf(n));
      ok(
        notices.some((t) => t.includes('已丢进') && t.includes('落在')),
        `通知里如实报落点与补了什么（实际：${JSON.stringify(notices)}）`,
      );
      await dropNote(rel);
      await ctx().settings.save({ lastCapture: null });
    });

    await suite.it('零板块不再拦：面板照开、只剩目录组；选目录 → 真落在那个目录 + lastCapture 记 dir: 键 + 下次预选', async () => {
      __resetNotices();
      await writeBoardCfg({ version: 1, view: {}, sections: [] });
      const modal = await openCapture();
      const notices = H.qa(document.body, '.kbw-notice').map((n) => H.textOf(n));
      ok(
        !notices.some((t) => t.includes('还没有板块')),
        '不再走"看板上还没有板块 → 只弹通知"那条老路（面板照开）',
      );
      const sel = H.q<HTMLSelectElement>(modal, '[data-capture="target"]');
      eq(
        Array.from(sel.querySelectorAll('optgroup')).map((g) => g.getAttribute('label')).join(','),
        '直接选目录',
        '板块组为空 → 只剩目录组',
      );
      sel.value = 'dir:02_Areas';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const title = H.q<HTMLInputElement>(modal, '[data-capture="title"]');
      title.value = '__快捕目录';
      const go = H.qa<HTMLButtonElement>(modal, 'button').find((b) => H.textOf(b).includes('丢一条'));
      H.click(go as Element);
      await H.settleIndex(app, 420);
      const rel = `${KB}/02_Areas/__快捕目录.md`;
      ok(H.exists(vaultRoot, rel), `真的落在那个目录（${rel}）`);
      eq(ctx().settings.get().lastCapture, 'dir:02_Areas', '记住的键带 dir: 前缀');
      await dropNote(rel);
      /** 再开一次：预选 = 上次那个目录（失联合法落回第一个，这里它还在） */
      const modal2 = await openCapture();
      const sel2 = H.q<HTMLSelectElement>(modal2, '[data-capture="target"]');
      eq(sel2.value, 'dir:02_Areas', '下次打开预选上次那个目录');
      H.keydown(modal2, 'Escape');
      await H.settle(80);
      await ctx().settings.save({ lastCapture: null });
    });
  });

  // ════════════════════════════════════════════════════════════
  // ③ 剪藏：正常 / 降级 / 纯函数
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2c · 剪藏（URL → 笔记）', async () => {
    const URL = 'https://example.com/blog/why-notes';
    const HTML_OK = `<html><head><title> 为什么写笔记 </title></head><body>
      <nav>导航别要</nav>
      <article><h1>为什么写笔记</h1><p>第一段。</p><p>第二段。</p></article>
      <script>var junk = 1;</script><style>.x{}</style>
    </body></html>`;

    await suite.it('纯函数：剥正文（优先 article · 去 script/style · 压空白）· looksLikeUrl · 超时契约', async () => {
      const r = extractReadable(HTML_OK);
      eq(r.title, '为什么写笔记', '标题取 <title> 并压空白');
      contains(r.text, '第一段。\n第二段。', '段落之间有换行（块级补 \n）');
      notContains(r.text, 'junk', 'script 整段去掉');
      notContains(r.text, '导航别要', '优先 article —— article 外的内容不进来');
      const empty = extractReadable('<html><head><title>空</title></head><body><script>1</script></body></html>');
      eq(empty.text, '', '只剩脚本的页面剥出来是空');
      ok(looksLikeUrl('https://a.example/x'), 'https 认');
      ok(!looksLikeUrl('ftp://a/x'), 'ftp 不认');
      ok(!looksLikeUrl('看这个 https://a/x'), '夹在话里的不算（整串才认）');
      eq(CLIP_TIMEOUT_MS, 8000, '超时契约 ~8s（Q1 拍板值，改它要连同文案一起改）');
      /** 超时降级（注入短时限 —— 真等 8 秒不适合进套件） */
      setRequestHandler(() => new Promise(() => undefined));
      const t0 = Date.now();
      const slow = await clipUrl('https://慢.example/', 60);
      eq(slow.kind, 'degraded', '超时 = 降级，不抛');
      contains(slow.reason ?? '', '超时', `降级原因说"超时"（实际 ${slow.reason}）`);
      ok(Date.now() - t0 < 2000, '不等满 8 秒（用的是注入的短时限）');
      /** 非网页 / HTTP 错 / 网络不通——三种降级原因各不相同（通知里要说清是哪一种） */
      setRequestHandler(() => ({ status: 200, text: 'x', json: null, headers: { 'content-type': 'application/pdf' } }));
      contains((await clipUrl('https://a.example/f.pdf')).reason ?? '', '不是网页', 'content-type 非 html → 降级');
      /** 独立审 🟡3：拍板原文是"非 HTML 就降级"——`text/*` 也收编是过头（会把 JS/CSV 源码当正文） */
      setRequestHandler(() => ({ status: 200, text: 'var x = 1;', json: null, headers: { 'content-type': 'text/plain' } }));
      contains((await clipUrl('https://a.example/x.txt')).reason ?? '', '不是网页', 'text/plain 也降级（只收 html）');
      setRequestHandler(() => ({ status: 500, text: '', json: null, headers: { 'content-type': 'text/html' } }));
      contains((await clipUrl('https://a.example/500')).reason ?? '', '500', 'HTTP 错 → 降级（说明带状态码）');
      setRequestHandler(() => {
        throw new Error('network down');
      });
      contains((await clipUrl('https://a.example/x')).reason ?? '', '网络', '网络抛错 → 降级');
      __resetRequests();
    });

    await suite.it('正常：粘到面板哪儿都算（粘贴路由）→ 标题自动改 → 落收件箱带 来源 + 正文 + 首行链接', async () => {
      __resetNotices();
      await writeBoardCfg({ version: 1, view: {}, sections: [] });
      setRequestHandler((req) => {
        eq(req.url, URL, '抓的是那一条链接');
        return { status: 200, text: HTML_OK, json: null, headers: { 'content-type': 'text/html; charset=utf-8' } };
      });
      const modal = await openCapture();
      const title = H.q<HTMLInputElement>(modal, '[data-capture="title"]');
      const link = H.q<HTMLInputElement>(modal, '[data-capture="link"]');
      /**
       * 🔴 **粘在"标题框"上**（不是链接框）—— 这正是"粘到哪儿都算"要防的场景：
       * 标题框里默认选着今天的日期，一 Ctrl+V 不路由就等于把 URL 粘进标题。
       */
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { getData: () => URL } });
      title.dispatchEvent(paste);
      await H.settle(120);
      eq(link.value, URL, 'URL 被路由进了链接行');
      notContains(title.value, 'http', '标题框没有被粘进 URL');
      eq(title.value, '为什么写笔记', '标题自动改成网页标题（用户没动过它）');
      const status = H.q<HTMLElement>(modal, '[data-capture="status"]');
      contains(H.textOf(status), '已抓到正文', `状态行说抓到了（实际：${H.textOf(status)}）`);
      const go = H.qa<HTMLButtonElement>(modal, 'button').find((b) => H.textOf(b).includes('剪藏'));
      ok(go, '主按钮改名「剪藏」');
      contains(H.textOf(modal), '剪藏固定', '落点行切成静态信息（剪藏固定收件箱）');
      H.click(go as Element);
      await H.settleIndex(app, 500);
      const rel = `${KB}/00_Inbox/为什么写笔记.md`;
      ok(H.exists(vaultRoot, rel), '落在收件箱');
      const text = H.readNote(vaultRoot, rel);
      contains(text, '来源', '「来源」属性写进去了');
      contains(text, URL, '值是那条 URL');
      contains(text, `[为什么写笔记](${URL})`, '正文首行留着原链接（可点回网页）');
      contains(text, '第一段。', '正文剥进去了');
      notContains(text, 'junk', '脚本文本没进正文');
      const notices = H.qa(document.body, '.kbw-notice').map((n) => H.textOf(n));
      ok(
        notices.some((t) => t.includes('已剪藏') && t.includes('抓到了正文')),
        `通知如实报"抓到了正文"（实际：${JSON.stringify(notices)}）`,
      );
      await dropNote(rel);
      __resetRequests();
      await ctx().settings.save({ lastCapture: null });
    });

    await suite.it('🔴 抢跑：粘贴后**不等抓完**就点「剪藏」→ 名字也用网页标题；剪藏不写 lastCapture', async () => {
      __resetNotices();
      await writeBoardCfg({ version: 1, view: {}, sections: [] });
      /** 一个"掐在手里"的假响应：粘贴后抓取在飞，测试自己决定何时放行 */
      type StubRes = { status: number; text: string; json: null; headers: Record<string, string> };
      let release!: (v: StubRes) => void;
      setRequestHandler(() => new Promise<StubRes>((res) => (release = res)));
      /** 先埋一个值：剪藏**不许**动它（"剪藏不写 lastCapture"是本轮点名口径） */
      await ctx().settings.save({ lastCapture: 'dir:00_Inbox' });
      const modal = await openCapture();
      const title = H.q<HTMLInputElement>(modal, '[data-capture="title"]');
      const link2 = H.q<HTMLInputElement>(modal, '[data-capture="link"]');
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { getData: () => URL } });
      title.dispatchEvent(paste);
      await H.settle(40); // 抓取还在飞（没放行）
      eq(link2.value, URL, 'URL 被路由进了链接行');
      const go = H.qa<HTMLButtonElement>(modal, 'button').find((b) => H.textOf(b).includes('剪藏'));
      ok(go, '按钮已切到「剪藏」档');
      H.click(go as Element); // run() 会 `await` 这次在飞的抓取
      await H.settle(60);
      release({ status: 200, text: HTML_OK, json: null, headers: { 'content-type': 'text/html' } });
      await H.settleIndex(app, 500);
      const rel = `${KB}/00_Inbox/为什么写笔记.md`;
      ok(
        H.exists(vaultRoot, rel),
        `文件名要用网页标题（"粘贴 → 立刻回车"是主路径；用旧名字就会落成今天的日期）`,
      );
      const notices = H.qa(document.body, '.kbw-notice').map((n) => H.textOf(n));
      ok(
        notices.some((t) => t.includes('已剪藏') && t.includes('为什么写笔记')),
        `通知也用现读的名字（实际：${JSON.stringify(notices)}）`,
      );
      eq(
        ctx().settings.get().lastCapture,
        'dir:00_Inbox',
        '剪藏**不写** lastCapture（预先埋的值一个字没动）',
      );
      await dropNote(rel);
      __resetRequests();
      await ctx().settings.save({ lastCapture: null });
    });

    await suite.it('降级：剥出来是空 → 状态行 warn + 按钮变「只存链接」→ 照落"标题+链接"，通知如实说', async () => {
      __resetNotices();
      await writeBoardCfg({ version: 1, view: {}, sections: [] });
      setRequestHandler(() => ({
        status: 200,
        text: '<html><head><title>没正文</title></head><body><script>1</script></body></html>',
        json: null,
        headers: { 'content-type': 'text/html' },
      }));
      const modal = await openCapture();
      const title = H.q<HTMLInputElement>(modal, '[data-capture="title"]');
      const link = H.q<HTMLInputElement>(modal, '[data-capture="link"]');
      link.value = 'https://example.com/empty';
      link.dispatchEvent(new Event('input', { bubbles: true }));
      await H.settle(500); // 防抖 400ms + 抓取
      const status = H.q<HTMLElement>(modal, '[data-capture="status"]');
      contains(H.textOf(status), '没抓到正文', `状态行如实说（实际：${H.textOf(status)}）`);
      const go = H.qa<HTMLButtonElement>(modal, 'button').find((b) => H.textOf(b).includes('只存链接'));
      ok(go, '主按钮改名「只存链接」');
      title.value = '__剪藏降级';
      H.click(go as Element);
      await H.settleIndex(app, 500);
      const rel = `${KB}/00_Inbox/__剪藏降级.md`;
      ok(H.exists(vaultRoot, rel), '照样落一条（不白粘、不阻塞）');
      const text = H.readNote(vaultRoot, rel);
      contains(text, '来源', '来源照样记');
      contains(text, 'https://example.com/empty', '链接在（正文里）');
      notContains(text, '没正文', '没抓到的"正文"不会假装存在');
      const notices = H.qa(document.body, '.kbw-notice').map((n) => H.textOf(n));
      ok(
        notices.some((t) => t.includes('没抓到正文') || t.includes('只存了标题和链接')),
        `通知如实说"没抓到正文，只存了链接"（实际：${JSON.stringify(notices)}）`,
      );
      await dropNote(rel);
      __resetRequests();
      await ctx().settings.save({ lastCapture: null });
    });
  });

  // ════════════════════════════════════════════════════════════
  // ④ 「来源」属性（schema + 默认列隐藏；迁移判据在 specSettings）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2c · 来源属性进属性表', async () => {
    await suite.it('SPECS 里有「来源」（文本、选填）；默认列隐藏里也钉了它', () => {
      const spec = SPEC_BY_NAME['来源'];
      ok(spec, 'schema 里有「来源」');
      eq(spec?.kind, 'text', '文本型（值 = URL）');
      eq(spec?.required, undefined, '选填、不进必填矩阵');
      contains(spec?.hint ?? '', '剪藏', 'hint 一句话说清它是干嘛的');
      ok(DEFAULT_HIDDEN.includes('prop:来源'), '默认列隐藏（与「收藏」「发布进度」同款）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑤ 笔记右键「丢进板块」（真链路：菜单 + 三种源各一条真动作）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2c · 1.3-d 笔记右键「丢进板块」', async () => {
    /** 打开某篇笔记的行菜单（先进到它所在的目录） */
    async function openMenuFor(dir: string, basename: string): Promise<HTMLElement> {
      await ctx().settings.save({ notesView: 'detail' });
      await navTo('全部笔记');
      ok(await H.clickTreeNode(dir), `进到 ${dir}`);
      const row = H.qa<HTMLElement>(document.body, '.kbw-trow').find(
        (r) => (r.dataset.path ?? '').endsWith(basename),
      );
      ok(row, `找到 ${basename} 那一行`);
      (row as HTMLElement).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      );
      await H.settle(60);
      const menu = H.q(document.body, '.kbw-menu');
      return menu;
    }

    /** 展开「改 → 丢进板块」并返回子菜单项（没有那一行时返回 null） */
    async function openCastSub(menu: HTMLElement): Promise<HTMLElement[] | null> {
      const change = H.qa<HTMLElement>(menu, '.kbw-menu-item').find((i) => H.textOf(i).includes('改'));
      ok(change, '「改」组在');
      H.click(change as Element);
      await H.settle(40);
      const sub = H.q(document.body, '.kbw-menu.is-sub');
      const cast = H.qa<HTMLElement>(sub, '.kbw-menu-item').find((i) =>
        H.textOf(i).includes('丢进板块'),
      );
      if (!cast) return null;
      H.click(cast);
      await H.settle(40);
      const subs = H.qa<HTMLElement>(document.body, '.kbw-menu.is-sub');
      const last = subs[subs.length - 1] as HTMLElement;
      return H.qa<HTMLElement>(last, '.kbw-menu-item');
    }

    const CFG = {
      version: 1,
      view: {},
      sections: [
        { id: 'f1', name: '内容创作', kind: 'folder', value: '02_Areas/内容创作' },
        { id: 't1', name: '灵感', kind: 'tag', value: '灵感' },
        { id: 'p1', name: '状态', kind: 'prop', value: '状态' },
        { id: 'x1', name: '收容所', kind: 'shelter', value: '' },
      ],
    };

    await suite.it('按条件画：能表达的三种源都在、右侧标动作；shelter / 死选项不画', async () => {
      await writeBoardCfg(CFG);
      await putNote(`${KB}/00_Inbox/__丢板块甲.md`, '甲', { tags: ['想法'] });
      try {
        const menu = await openMenuFor('00_Inbox', '__丢板块甲.md');
        notContains(H.textOf(menu), '丢进板块', '一级不铺开（收在「改」组里）');
        const items = await openCastSub(menu);
        ok(items, '「改」组里有「丢进板块」');
        const text = (items ?? []).map((i) => H.textOf(i));
        ok(text.some((t) => t.includes('内容创作')), `folder 源在（实际 ${text.join(' | ')}）`);
        ok(text.some((t) => t.includes('灵感')), 'tag 源在');
        ok(!text.some((t) => t.includes('收容所')), 'shelter 不画');
        ok(
          !text.some((t) => t.includes('状态 = 待整理')),
          '对这篇没用的（状态本来就是 待整理）不画',
        );
        /** 右侧小字：动作分流看得见 */
        const row = (items ?? []).find((i) => H.textOf(i).includes('灵感'));
        contains(H.textOf(row as HTMLElement), '加标签', '每项右侧标「加标签」这类动作');
        closeAllMenus();
        await H.settle(30);
      } finally {
        await dropNote(`${KB}/00_Inbox/__丢板块甲.md`);
      }
    });

    await suite.it('tag 源 → 真加标签（并集：原来那枚留着）；prop 源 → 真改属性（覆盖）', async () => {
      await writeBoardCfg(CFG);
      const rel = `${KB}/00_Inbox/__丢板块乙.md`;
      await putNote(rel, '乙', { tags: ['想法'] });
      try {
        const menu = await openMenuFor('00_Inbox', '__丢板块乙.md');
        const items = await openCastSub(menu);
        ok(items, '「丢进板块」在');
        const tag = (items ?? []).find((i) => H.textOf(i).includes('灵感'));
        ok(tag, '「灵感」那一行在');
        H.click(tag as Element);
        await H.settleIndex(app, 500);
        let text = H.readNote(vaultRoot, rel);
        contains(text, '灵感', '标签加上了');
        contains(text, '想法', '原来那枚留着（并集，不是覆盖）');
        /** prop：改成「进行中」（覆盖语义） */
        const menu2 = await openMenuFor('00_Inbox', '__丢板块乙.md');
        const items2 = await openCastSub(menu2);
        const prop = (items2 ?? []).find((i) => H.textOf(i).includes('状态 = 进行中'));
        ok(prop, '「状态 = 进行中」那一行在');
        H.click(prop as Element);
        await H.settleIndex(app, 500);
        text = H.readNote(vaultRoot, rel);
        contains(text, '状态: 进行中', '属性覆盖成新值');
      } finally {
        await dropNote(rel);
      }
    });

    await suite.it('folder 源 → 真搬（走 mover + 撤销条，与「移动到…」同款）', async () => {
      await writeBoardCfg(CFG);
      const rel = `${KB}/00_Inbox/__丢板块丙.md`;
      await putNote(rel, '丙');
      try {
        const menu = await openMenuFor('00_Inbox', '__丢板块丙.md');
        const items = await openCastSub(menu);
        const folder = (items ?? []).find((i) => H.textOf(i).includes('内容创作'));
        ok(folder, '「内容创作」那一行在');
        H.click(folder as Element);
        await H.settleIndex(app, 500);
        const moved = `${KB}/02_Areas/内容创作/__丢板块丙.md`;
        ok(H.exists(vaultRoot, moved), `真搬到它的目录（${moved}）`);
        ok(!H.exists(vaultRoot, rel), '原来的位置没有了');
        ok(H.currentUndoButton(), '搬完有撤销条（mover 那条链路 —— 与「移动到…」同款）');
        await dropNote(moved);
      } finally {
        fs.rmSync(path.join(vaultRoot, rel), { force: true });
        app.vault.rescan();
        ctx().index.rebuild();
        await H.settleIndex(app, 220);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑥ 菜单二级移开自动收起（7.1；只动 hover —— 触屏/键盘不受影响）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2c · 7.1 菜单移开自动收起', async () => {
    /** 开一条带两个子菜单父项的小菜单 */
    function openTestMenu(): { root: HTMLElement } {
      closeAllMenus();
      showMenu({ x: 60, y: 60 }, {
        scope: { kind: 'global', label: '菜单收起测试' },
        items: [
          { kind: 'item', label: '甲', submenu: [{ kind: 'item', label: '甲一' }] },
          { kind: 'item', label: '乙', submenu: [{ kind: 'item', label: '乙一' }] },
        ],
      });
      return { root: H.q(document.body, '.kbw-menu:not(.is-sub)') };
    }
    const rowOf = (root: HTMLElement, label: string): HTMLElement => {
      const row = H.qa<HTMLElement>(root, '.kbw-menu-item').find((i) => H.textOf(i).startsWith(label));
      ok(row, `有「${label}」那一行`);
      return row as HTMLElement;
    };
    const subs = (): HTMLElement[] => H.qa<HTMLElement>(document.body, '.kbw-menu.is-sub');
    const hover = (el: Element): void => {
      el.dispatchEvent(new MouseEvent('mouseenter'));
    };
    /** 派一发"指针离开"（jsdom 不会自己合成 —— 真机上它天然会响） */
    function leave(el: Element, init: { pointerType?: 'mouse' | 'touch'; relatedTarget?: Node } = {}): void {
      const evt = H.pointerEvent('pointerleave', { x: 900, y: 700, pointerType: init.pointerType ?? 'mouse' });
      if (init.relatedTarget) Object.defineProperty(evt, 'relatedTarget', { value: init.relatedTarget });
      el.dispatchEvent(evt);
    }

    await suite.it(`离开整条链 → ${MENU_SUB_CLOSE_MS}ms 到点收起；期间"回到链内"就撤销`, async () => {
      const { root } = openTestMenu();
      hover(rowOf(root, '甲'));
      eq(subs().length, 1, '悬停父项 → 子菜单展开');
      leave(root);
      await H.settle(150);
      eq(subs().length, 1, `未到点（${MENU_SUB_CLOSE_MS}ms）时还在`);
      await H.settle(MENU_SUB_CLOSE_MS - 100 + 60);
      eq(subs().length, 0, '到点自己收起');
      closeAllMenus();

      /** 期间回到链内 → 撤销（"三角内往返不算离开"靠这条 + 延迟兜住） */
      const { root: root2 } = openTestMenu();
      hover(rowOf(root2, '甲'));
      leave(root2);
      await H.settle(100);
      root2.dispatchEvent(H.pointerEvent('pointerenter', { x: 100, y: 100, pointerType: 'mouse' }));
      await H.settle(MENU_SUB_CLOSE_MS + 120);
      eq(subs().length, 1, '回到链内 → 倒计时撤销，子菜单还开着');

      /** 离开父菜单、但指针**进了子菜单**（relatedTarget 在链内）→ 不算离开 */
      const sub = subs()[0];
      leave(root2, { relatedTarget: sub });
      await H.settle(MENU_SUB_CLOSE_MS + 120);
      eq(subs().length, 1, '进子菜单的路（relatedTarget 指过去）不算离开');
      closeAllMenus();
      await H.settle(30);
    });

    await suite.it('移进另一父项 → 立即切换（不等倒计时；旧子菜单不回来）', async () => {
      const { root } = openTestMenu();
      hover(rowOf(root, '甲'));
      await H.settle(30);
      contains(H.textOf(subs()[0] as HTMLElement), '甲一', '开着的是甲的子菜单');
      leave(root);
      await H.settle(100); // 倒计时已经在跑
      hover(rowOf(root, '乙'));
      await H.settle(30);
      const cur = subs();
      eq(cur.length, 1, '只有一个子菜单（立即切换，不叠两个）');
      contains(H.textOf(cur[0] as HTMLElement), '乙一', '已经切到乙的');
      await H.settle(MENU_SUB_CLOSE_MS + 150);
      eq(subs().length, 1, '切换把倒计时撤了（新的子菜单不会 300ms 后被误收）');
      closeAllMenus();
      await H.settle(30);
    });

    await suite.it('🔴 触屏路径不受影响：click 开着的子菜单，pointerleave（touch）不算离开', async () => {
      const { root } = openTestMenu();
      const row = rowOf(root, '甲');
      /**
       * 触屏的打开路径是 **click**（点一下父项 → 飞出子菜单）——
       * 指完就抬，浏览器随后会派一发 `pointerleave(pointerType:'touch')`。
       */
      H.click(row);
      await H.settle(30);
      eq(subs().length, 1, 'click 开出子菜单');
      leave(root, { pointerType: 'touch' });
      await H.settle(MENU_SUB_CLOSE_MS + 150);
      eq(subs().length, 1, '触屏的 pointerleave 不触发收起（它只是"手指抬起来了"）');
      closeAllMenus();
      await H.settle(30);
    });

    await suite.it('🔴 键盘路径一个字没动：ArrowRight 开 · 400ms 后还在（没人派指针事件）· ArrowLeft 退', async () => {
      const { root } = openTestMenu();
      root.focus();
      H.keydown(root, 'ArrowDown');
      await H.settle(20);
      H.keydown(root, 'ArrowRight');
      await H.settle(30);
      eq(subs().length, 1, 'ArrowRight 展开子菜单');
      await H.settle(MENU_SUB_CLOSE_MS + 150);
      eq(subs().length, 1, '键盘开着的子菜单不会被"移开收起"误伤（它只认指针）');
      H.keydown(subs()[0] as Element, 'ArrowLeft');
      await H.settle(30);
      eq(subs().length, 0, 'ArrowLeft 照旧退回');
      closeAllMenus();
      await H.settle(30);
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑦ 小窗 Windows 化（4.3）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.2c · 4.3 小窗 Windows 化', async () => {
    /** 给一个元素装一份"从样式现算"的 rect（jsdom 的 rect 恒 0，窗口类判据全靠它） */
    function fakeRect(el: HTMLElement, read: () => { x: number; y: number; w: number; h: number }): () => void {
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const g = read();
          return {
            left: g.x,
            top: g.y,
            width: g.w,
            height: g.h,
            right: g.x + g.w,
            bottom: g.y + g.h,
            x: g.x,
            y: g.y,
          } as DOMRect;
        },
      });
      return () => {
        delete (el as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      };
    }

    await suite.it('双击标题栏 = 最大化到 .kbw-root 的 rect；再双击还原到"原来的样式原文"', async () => {
      await ctx().activate();
      const wb = H.q<HTMLElement>(document.body, '.kbw-root');
      const undo = fakeRect(wb, () => ({ x: 100, y: 50, w: 800, h: 600 }));
      const geoCalls: { x: number; y: number; w: number; h: number }[] = [];
      const h = openFloating({
        title: '测试小窗',
        width: 'narrow',
        resizable: true,
        origin: { x: 30, y: 30 },
        onGeometryChange: (g) => geoCalls.push(g),
      });
      try {
        const before = { left: h.root.style.left, top: h.root.style.top };
        ok(before.left !== '', '（前提）常态下已经摆好了位置');
        H.q<HTMLElement>(h.root, '.kbw-panel-head').dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
        );
        eq(h.root.style.left, '100px', '铺满的左边 = 工作台 rect 的 left');
        eq(h.root.style.top, '50px', '上边同源');
        eq(h.root.style.width, '800px', '宽 = 工作台整块（不是视口）');
        eq(h.root.style.height, '600px', '高同源');
        /**
         * 🔴 **同时放开 `max-width/max-height`**：`.kbw-panel` 自带 max（真机 520×702 就是被它夹的）
         * —— jsdom 不加载样式表，只判内联这里能不能被"夹回去"就靠这两条。
         */
        eq(h.root.style.maxWidth, 'none', '最大宽放开（否则 CSS 的 max-width 把"铺满"当场夹掉）');
        eq(h.root.style.maxHeight, 'none', '最大高同源');
        ok(h.isMaximized(), '状态上是最大化');
        /** 最大化态下拖头：**不许**把"铺满几何"写进 panelGeo（独立审 🟡4） */
        const head0 = H.q<HTMLElement>(h.root, '.kbw-panel-head');
        await H.pointerSequence(
          [
            { el: head0, type: 'down', init: { x: 100, y: 100 } },
            { el: head0, type: 'move', init: { x: 180, y: 160 } },
          ],
          8,
        );
        H.pointerUp(head0, { x: 180, y: 160 });
        await H.settle(30);
        eq(geoCalls.length, 0, '最大化态拖头不报几何（panelGeo 不该被"铺满几何"污染）');
        H.q<HTMLElement>(h.root, '.kbw-panel-head').dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
        );
        eq(h.root.style.left, before.left, '再双击 → 左侧还原成原来的样式原文');
        eq(h.root.style.top, before.top, '上边同源');
        eq(h.root.style.width, '', '宽度交还给 CSS');
        eq(h.root.style.maxWidth, '', '最大宽也交还给 CSS');
        ok(!h.isMaximized(), '状态回到常态');
      } finally {
        h.close('test');
        undo();
      }
    });

    await suite.it('几何"拖动结束才报"（途中一次都不报）；initialGeo 开窗即用 + 越界夹回', async () => {
      const calls: { x: number; y: number; w: number; h: number }[] = [];
      const h = openFloating({
        title: '测试小窗',
        width: 'narrow',
        resizable: true,
        origin: { x: 30, y: 30 },
        onGeometryChange: (g) => calls.push(g),
      });
      const undo = fakeRect(h.root, () => ({
        x: parseFloat(h.root.style.left) || 0,
        y: parseFloat(h.root.style.top) || 0,
        w: parseFloat(h.root.style.width) || 300,
        h: parseFloat(h.root.style.height) || 200,
      }));
      try {
        const head = H.q<HTMLElement>(h.root, '.kbw-panel-head');
        await H.pointerSequence(
          [
            { el: head, type: 'down', init: { x: 100, y: 100 } },
            { el: head, type: 'move', init: { x: 180, y: 140 } },
            { el: head, type: 'move', init: { x: 200, y: 150 } },
          ],
          8,
        );
        eq(calls.length, 0, '拖动途中一次都不报（别让调用方每帧写盘）');
        H.pointerUp(head, { x: 200, y: 150 });
        await H.settle(40);
        eq(calls.length, 1, '松手才报一次');
        eq(calls[0]?.x, parseFloat(h.root.style.left), '报的是"现在在哪"（与样式一致）');
        h.close('test');
      } finally {
        undo();
      }
      /** initialGeo：开窗直接用；越界（换过显示器）夹回视口 */
      const g = openFloating({
        title: '测试小窗',
        width: 'narrow',
        resizable: true,
        initialGeo: { x: 5000, y: -80, w: 400, h: 300 },
      });
      try {
        const vw = window.innerWidth || 1200;
        const vh = window.innerHeight || 768;
        eq(g.root.style.width, '400px', '尺寸用记住的');
        /**
         * ⚠️ 夹回判据按**区间**写（不是精确值）：夹回量取决于 `measure()` 量到的宽高，
         * 而 jsdom 的几何是桩定的（`scripts/test.mjs`：offsetWidth=200 / offsetHeight=100）
         * —— 钉死数字就把"判夹回"写成了"判桩的常数"。
         */
        const left = parseFloat(g.root.style.left);
        const top = parseFloat(g.root.style.top);
        ok(left >= 4 && left <= vw - 4, `越界往右 → 夹回视口内（left=${left}，vw=${vw}）`);
        ok(top >= 4 && top <= vh - 4, `越界往上 → 夹回（top=${top}）`);
      } finally {
        g.close('test');
      }
    });

    await suite.it('点击置顶：pointerdown → 这一扇排到 DOM 末尾；停靠态不做这两件', async () => {
      const a = openFloating({ title: '甲窗', width: 'narrow' });
      const b = openFloating({ title: '乙窗', width: 'narrow' });
      try {
        /** 只看浮层态的那几扇 —— 停靠的那扇搬到宿主里了，它的"文档序"没有意义 */
        const order = (): HTMLElement[] =>
          H.qa<HTMLElement>(document.body, '.kbw-panel:not(.is-docked)');
        ok(order()[order().length - 1] === b.root, '（前提）后开的乙在最上（DOM 末尾）');
        H.pointerDown(a.root, { x: 10, y: 10 });
        await H.settle(20);
        ok(order()[order().length - 1] === a.root, '点了甲 → 甲排到末尾（置顶）');
        /** 停靠态：不可最大化、pointerdown 不置顶；**内联尺寸要交还 CSS**（独立审 🟡5） */
        const host = document.createElement('div');
        document.body.appendChild(host);
        b.setSize(400, 300);
        eq(b.root.style.width, '400px', '（前提）三档/手柄那份尺寸写在内联上');
        b.setDocked(host);
        eq(b.root.style.width, '', '进窗格 → 内联宽交给 CSS（否则顶掉 .is-docked 的 100%）');
        eq(b.root.style.height, '', '高同源');
        b.setSize(500, 400);
        eq(b.root.style.width, '', '停靠态 setSize 是空操作（尺寸归窗格，写内联只会在浮层形态生效）');
        const before = { w: b.root.style.width, l: b.root.style.left };
        b.toggleMaximize();
        eq(b.root.style.width, before.w, '停靠态 toggleMaximize 是空操作');
        eq(b.isMaximized(), false, '也不进最大化态');
        H.pointerDown(b.root, { x: 10, y: 10 });
        await H.settle(20);
        ok(order()[order().length - 1] === a.root, '停靠态下 pointerdown 不置顶（它在窗格里）');
        b.setDocked(null);
        eq(b.root.style.width, '400px', '取消停靠 → 记着的那份尺寸还回来');
        host.remove();
      } finally {
        a.close('test');
        b.close('test');
        purgeOverlays();
      }
    });

    await suite.it('panelGeo 存取：整份存得住（load 回读）；半份回落 null（"静默丢值"钉成有意）', async () => {
      await ctx().settings.save({ panelGeo: { x: 12.5, y: 34, w: 400, h: 300 } });
      await ctx().settings.load();
      deepEq(
        ctx().settings.get().panelGeo,
        { x: 12.5, y: 34, w: 400, h: 300 },
        '整份对象 load 之后还在（normalize 没把它吞掉 —— data.json 的非字符串值最容易出这种账）',
      );
      await ctx().settings.save({ panelGeo: { x: 1, y: 2 } as never });
      eq(
        ctx().settings.get().panelGeo,
        null,
        '半份 → 回落 null（宁可回默认锚点，也不拿半份坐标去摆窗）',
      );
      await ctx().settings.save({ panelGeo: null });
    });
  });

  /** 收尾：把本用例动过的界面偏好拨回去 */
  await ctx().settings.save({ notesView: null, lastCapture: null, panelGeo: null });
  closeAllMenus();
  purgeOverlays();
}
