/**
 * tests/helpers.ts —— 测试夹具
 *
 * **真数据**：把实验库的 `01_新知识库`（43 篇）拷进临时目录再跑 ——
 * P0 的完成定义是"列出 43 篇"，假数据验不出真问题。
 * 动库的测试全在这个临时副本上做，实验库本体一个字节都不动。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TFile } from 'obsidian';
import KbWorkbenchPlugin from '../src/main';
import type { AiSettings } from '../src/core/settings';
import { beat } from './heartbeat';
import { shardize } from './shards';
import {
  StubApp,
  __resetRequests,
  requestLog,
  setRequestHandler,
  type StubRequestParam,
  type TFile as StubTFile,
  type TFolder,
} from './stub/index';

/**
 * ── 夹具（2026-10-02 起 = **合成数据**）────────────────────────────
 * 离线套件的数据源不再指向本机真备份（隐私 + CI/协作者机器拿不到），
 * 改由 `tests/fixture/` 的生成器按「夹具形状契约」**现造**一份等价形状的假数据，
 * 每次 `npm test` 开跑前全量重建到 `tests/.fixture/`（已 gitignore）。
 *
 * 两块：
 *   · base —— "迁移后基线"（`9.16.md` / 恰好 7 模板 / 未分类=2 … 那套形状）→ A/B/C/E 四组库；
 *   · pre  —— "迁移前"（旧属性键 + 16 处待打补丁 + 生活健康 4 篇）→ 只喂 D 迁移库。
 *
 * 要用**真备份**跑（本机调试）：设 `KBW_FIXTURE_KB` / `KBW_BACKUP_KB` 指回
 * `sandbox-vault/.tooling/backup/<那份>/01_新知识库` 即可（这两个口子一直保留）。
 */
export function fixtureRoot(): string {
  // 分片隔离（P7.20-1）：`ensureFixtures()` 会**先 rmrf 再重建** —— 四个分片同时干这事必然互删。
  // 放成 `.fixture/<tag>` 而不是 `.fixture-<tag>`：后者会脱出 `.gitignore` 里那条忽略规则。
  return shardize(path.join(repoRoot(), 'tests', '.fixture'));
}
export function fixtureKb(name: 'base' | 'pre'): string {
  return path.join(fixtureRoot(), name, '01_新知识库');
}
export const BASE_KB = (process.env.KBW_FIXTURE_KB || fixtureKb('base')).replace(/\\/g, '/');
export const PRE_MIGRATION_KB = (process.env.KBW_BACKUP_KB || fixtureKb('pre')).replace(/\\/g, '/');

export function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * **当前那一条撤销条上的某个按钮**。
 *
 * 🔴 为什么要这个助手，而不是直接 `q('.kbw-undobar-actions .kbw-btn')`：
 * `showUndo()` 换条时**不是立刻删旧的** —— `dismiss()` 给它打上 `is-leaving`，
 * 等 `animationend`（或 400ms 兜底）才 `.remove()`。于是在那最多 400ms 里，
 * **容器里同时挂着两条**，而 `querySelector` 按文档顺序返回**旧的那一条**。
 * P6④ 实测到的症状：点「撤销」撤的是**上一轮**那次操作 —— 文件确实动了一个，
 * 但动的是别人，而报出来是"撤回原位了"失败（读到这儿之前已经查了三轮）。
 *
 * 口径与探针里的 `lastModal`（多个模态叠着时取最后一个）**完全相同**：认"最后出现的那一条"。
 */
export function currentUndoButton(match = ''): HTMLElement | null {
  const bars = qa<HTMLElement>(document.body, '.kbw-undobar').filter(
    (b) => b.dataset.leaving !== '1' && !b.classList.contains('is-leaving'),
  );
  const bar = bars[bars.length - 1];
  if (!bar) return null;
  const btns = qa<HTMLElement>(bar, '.kbw-undobar-actions .kbw-btn');
  return btns.find((b) => textOf(b).includes(match)) ?? null;
}

/**
 * 手动触发一次 ResizeObserver 回调。
 * jsdom 没有 ResizeObserver（runner 装了个记录型的桩），
 * 而"容器变窄"这条正是要用它验的。
 */
export function triggerResize(): void {
  const reg = (globalThis as unknown as { __kbwResizeObservers?: { cb: () => void }[] })
    .__kbwResizeObservers;
  for (const ro of reg ?? []) ro.cb();
}

/** 清空 DOM（换一次 boot 就清一次，免得上一个实例的视图干扰断言） */
export function resetDom(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

// ────────────────────────────────────────────────────────────────
// AI 助手（P6 段④）—— **离线绝不联网**
// ────────────────────────────────────────────────────────────────

/**
 * 装一个假的模型回话。
 *
 * 桩的 `requestUrl` **默认抛**（见 `tests/stub/index.ts` 那条注释）——
 * 所以"忘了注入"会当场炸在用例里，而不是静默去调真模型。
 *
 * @param advice `null` = 回一段**不是 JSON** 的文本（验 `AiParseError` 那条路）
 * @returns 一个可以直接喂给 `deepEq` 的请求记录读取器
 */
export function stubAi(advice: {
  reply?: string;
  ideas?: { path: string; to: string; why?: string }[];
  raw?: string;
  status?: number;
  /**
   * 服务端报的用量（P7.3c 17.10②）—— 按 OpenAI 兼容的**下划线形状**给
   *（`prompt_tokens` / `completion_tokens`，那是线上真实的样子）。
   * ⚠️ 不给它就等于"这家不吐 usage" → 服务层回落到本地估算（那条路也要验）。
   */
  usage?: { prompt_tokens: number; completion_tokens: number };
}): { calls: StubRequestParam[] } {
  setRequestHandler(() => {
    const body =
      advice.raw != null
        ? advice.raw
        : JSON.stringify({ reply: advice.reply ?? '好的', ideas: advice.ideas ?? [] });
    const json = {
      choices: [{ message: { role: 'assistant', content: body } }],
      ...(advice.usage ? { usage: advice.usage } : {}),
    };
    const payload = advice.status && advice.status >= 400 ? { error: { message: body } } : json;
    return {
      status: advice.status ?? 200,
      text: JSON.stringify(payload),
      json: payload,
      headers: {},
    };
  });
  // `calls` 是**活的引用**（桩那边 push 的是同一个数组的元素）→ 直接读全局那份
  return { calls: requestLog };
}

/** 清掉假回话与请求记录（每条用例起手调一次） */
export function resetAi(): void {
  __resetRequests();
}

/**
 * **按顺序**回话的假模型（P7.3b：agent 的一轮 = 多次模型调用）。
 *
 * 循环的形状：模型回话（带动作）→ 执行 → 结果喂回去 → 模型再回话（终答）。
 * 单发桩（`stubAi`）喂不出一轮完整的 agent —— 用这个：
 *
 * ```ts
 * H.stubAiSeq([
 *   { ideas: [{ path: '00_Inbox/x.md', to: '01_Projects' }] }, // 第一步：提动作
 *   { reply: '搬好了' },                                        // 第二步：收尾
 * ]);
 * ```
 * 次数不够时**重复最后一条**（多轮对话用例照旧能用；跑飞了也不会炸在"没准备"）。
 */
export function stubAiSeq(
  list: {
    reply?: string;
    ideas?: { path: string; to: string; why?: string }[];
    /** agent 的 `actions` 信封（P7.3b）；给了它就按它拼（`ideas` 那个口子照旧） */
    actions?: { tool: string; args?: Record<string, unknown> }[];
    raw?: string;
    status?: number;
    /** 服务端报的用量（P7.3c）—— 与 `stubAi` 同一个口子；不给 = 这家不吐 usage */
    usage?: { prompt_tokens: number; completion_tokens: number };
  }[],
): { calls: StubRequestParam[] } {
  let i = 0;
  setRequestHandler(() => {
    const advice = list[Math.min(i, list.length - 1)] ?? {};
    i += 1;
    const body =
      advice.raw != null
        ? advice.raw
        : advice.actions != null
          ? JSON.stringify({ reply: advice.reply ?? '好的', actions: advice.actions })
          : JSON.stringify({ reply: advice.reply ?? '好的', ideas: advice.ideas ?? [] });
    const json = {
      choices: [{ message: { role: 'assistant', content: body } }],
      ...(advice.usage ? { usage: advice.usage } : {}),
    };
    const payload = advice.status && advice.status >= 400 ? { error: { message: body } } : json;
    return {
      status: advice.status ?? 200,
      text: JSON.stringify(payload),
      json: payload,
      headers: {},
    };
  });
  return { calls: requestLog };
}

/**
 * ⚠️ 想把 `ai.transport` **换回真的**那条：用 `ctx.ai.http`（服务自己留着那一份）。
 * 别在这儿再 `httpTransport()` 造一个 —— 两个实例看不出区别，但"谁是真的"就有两份答案了。
 */

/**
 * 把 AI 服务配好（有 key、指向一个假地址）。
 * ⚠️ **不做连通性检查** —— 传输层是假的，所以这里只填配置。
 */
export function configAi(plugin: KbWorkbenchPlugin, patch: Partial<AiSettings> = {}): Promise<void> {
  const cur = plugin.context().settings.get().ai;
  return plugin.context().settings.save({
    ai: { ...cur, apiKey: 'test-key', ...patch },
  });
}

export function tmpRoot(): string {
  // 分片隔离（P7.20-1）：临时库（`makeTempVault` 的 ~20 个）按片分开，互不踩。
  // ⚠️ 不分片时**必须**仍是 `tests/.tmp` 本身 —— 既有脚本/文档盯着这个路径。
  return shardize(path.join(repoRoot(), 'tests', '.tmp'));
}

/**
 * ── 删目录：扛住 OneDrive / 索引器的**短暂句柄占用**（P7.19 · ENOTEMPTY 修复）──
 *
 * 🔴 为什么不能裸 `fs.rmSync`（2026-10-10 实测）：
 * 本仓库在 **OneDrive 桌面**下（`C:/Users/<你的用户名>/OneDrive/Desktop/工作台插件开发`），
 * `tests/.tmp` 每轮开跑要建/删 ~20 个临时库；OneDrive 的同步进程会在刚写完的目录上
 * **短暂持有句柄**，此时 `fs.rmSync(dir, { recursive: true })` 直接抛
 * `ENOTEMPTY: Directory not empty`（报错路径还是 GBK 乱码 `¹¤×÷Ì¨²å¼þ¿ª·¢`）。
 * 症状极具迷惑性：**子集单跑全绿、连跑就随机挂**，挂的还不是断言而是"测试跑挂了"。
 * 这不是被测代码的问题，是环境的 —— 所以退避重试，而不是让几十条用例陪葬。
 *
 * ⚠️ 只对**句柄抖动那几类** code 重试；其它 code 原样抛：
 *   · 权限/路径错 → 重试也没用，早点报出来
 *   · `node-safe-delete-shim.cjs` 的 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` → 是**环境策略**，
 *     该做的是给全量盖上 `NODE_OPTIONS`（见 `坑/判据与验证.md` · P7.19），别在这儿吞
 *
 * 判据（P7.19 完成定义）：连跑两次 `KBW_TEST_ONLY='P4 · 红线'` 都稳过。
 */
const RM_RETRY_CODES = new Set(['ENOTEMPTY', 'EPERM', 'EBUSY']);

function sleepSync(ms: number): void {
  // 运行器是同步的：这里同步等一小会儿（换成 `await` 会插进一个宏任务、改变用例时序）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 递归删目录，带句柄抖动退避重试（累计 ~900ms 仍失败才真抛） */
export function rmrf(target: string, attempts = 8): void {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (!RM_RETRY_CODES.has(code)) throw e;
      last = e;
      beat(); // 重试也是"还在往前走"，看门狗别把这几十毫秒当卡住
      // 诊断开关（默认静默）：`KBW_DEBUG_RM=1` 时把每次重试打出来 ——
      // "子集第 2 次跑比第 1 次慢 50s"这类事，靠它一眼看出是不是重试在扛
      if (process.env.KBW_DEBUG_RM) {
        console.warn(`[rmrf] 第 ${i + 1} 次删「${target}」撞上 ${code}（句柄抖动）—— 退避 ${25 * (i + 1)}ms 重试`);
      }
      sleepSync(25 * (i + 1)); // 25/50/75…ms 递增退避
    }
  }
  throw last;
}

/**
 * 把**夹具库**拷进临时区，返回临时库根。
 *
 * ⚠️ 默认源是 `BASE_KB`（**迁移后**那份：默认 = 合成夹具，`KBW_FIXTURE_KB` 可指回真备份），**不是活的实验库**：
 * 实验库是**会被改的**（P2 跑过迁移、P3 还会跑存量补全与目录映射的改动）。
 * 用例若拿活库当数据源，数据一动就是十几条假红 —— 那跟插件对不对毫无关系。
 * 夹具钉住之后，实验库可以自由演化（它的事归真机探针管）。
 *
 * 两处例外（显式传 `sourceDir`）：
 *   · 属性迁移的 spec → `PRE_MIGRATION_KB`（它要的正是"迁移前"那一份）
 *   · 自己造档的用例 → 传空目录或自造数据
 *
 * 要看"活库此刻什么样"：跑 `npm run probe`（它连的就是实验库）。
 */
export function makeTempVault(name: string, sourceDir = BASE_KB): string {
  beat(); // 心跳：造库也是"往前走了一步"（看门狗别把这段时间当卡住）
  const dest = path.join(tmpRoot(), name);
  rmrf(dest); // ⚠️ 别换回裸 `fs.rmSync` —— OneDrive 句柄抖动会抛 ENOTEMPTY，见 rmrf 的注释
  fs.mkdirSync(dest, { recursive: true });
  if (fs.existsSync(sourceDir)) {
    fs.cpSync(sourceDir, path.join(dest, '01_新知识库'), { recursive: true });
  } else {
    // ⚠️ 静默降级成空库会让 B/C 两库（自造夹具）照样全绿，只有 A 库会红 ——
    // 报错信息要直接说清"源目录不在"，别让人去猜
    console.error(`
⚠️ 找不到真数据源：${sourceDir}
   真数据类断言会失败。换机器/改库名请设 KBW_FIXTURE_KB（当前基线路径见 helpers.ts 顶部）。
   往下几十条会因为这个根因一起红 —— 先修这个，别一条条看。
`);
    fs.mkdirSync(path.join(dest, '01_新知识库'), { recursive: true });
  }
  // 插件目录（快照落这儿）
  fs.mkdirSync(path.join(dest, '.obsidian', 'plugins', 'kb-workbench'), { recursive: true });
  return dest;
}

export interface Booted {
  app: StubApp;
  plugin: KbWorkbenchPlugin;
}

/**
 * 起一个插件实例：构造 → onload（走真链路）
 *
 * @param opts.deferLayoutReady 布局**没就绪**（索引建不起来）→ 验骨架屏那条分支
 * @param opts.wizard 首次使用向导的初态（**默认 `'done'`**）：
 *   ```
 *   'done'    （默认）data.json 里预写 wizardDone: true —— 向导不弹，既有用例照旧
 *   'fresh'   一个全新的 data.json（**连文件都不建**）：路径是默认值 + 标记是 null → 弹
 *   'later'   预写 wizardDone: false（用户点过「稍后」）→ 也弹
 *   'configured' 预写"配过"的样子：wizardDone 是 null **但路径不是默认值** → 不弹
 *   ```
 *
 * 🔴 **为什么默认是 `'done'` 而不是 `'fresh'`**：向导挂在"打开工作台那一刻"，
 * 而本项目**几十条既有用例**都会 `activate()` —— 默认 fresh 的话它们会集体先撞上一个
 * 模态。那是**夹具污染**，不是判据。
 * ⚠️ 代价是"默认这一路把向导盖住了"，所以 `tests/specs/wizard.ts` **四条形态各起一个实例**
 * 逐条验（含"该弹"的两条）—— 这个口子的正确性靠那一组用例兜，不靠默认值。
 */
export interface BootOptions {
  deferLayoutReady?: boolean;
  wizard?: 'done' | 'fresh' | 'later' | 'configured';
  /**
   * **原样写这份 `data.json`**（不再套 `seedDataJson` 那三种形态）—— 给"存量文件形状"的用例用
   *（P7.0b 的 `settingsVersion` 迁移就是这么造的：一份**没有版本键**的存量 data.json）。
   * ⚠️ 传它就**必须自己写全**：不写 `wizardDone` 会当"从没配过"→ 弹向导（判据会被模态挡）。
   */
  rawData?: Record<string, unknown>;
}

export async function bootPlugin(vaultRoot: string, opts: BootOptions = {}): Promise<Booted> {
  const app = new StubApp(vaultRoot);
  if (opts.deferLayoutReady) app.workspace.autoLayoutReady = false;
  if (opts.rawData) writeRawDataJson(vaultRoot, opts.rawData);
  else seedDataJson(vaultRoot, opts.wizard ?? 'done');
  const plugin = new KbWorkbenchPlugin(app as never, {
    id: 'kb-workbench',
    dir: '.obsidian/plugins/kb-workbench',
  } as never);
  await plugin.onload();
  /**
   * **把插件挂回桩 `app`**（P8 · 测试基建）：`settleIndex(app)` 手上只有 `app`，
   * 而"排干索引那两枚 debounce"要的是索引（`ctx.index`）。挂这一个引用，
   * 几十处 `settleIndex(app)` 的调用点一个都不用改签名。
   */
  (app as unknown as { __kbwPlugin?: KbWorkbenchPlugin }).__kbwPlugin = plugin;
  beat(); // 心跳：一次 boot 完成（onload 里有真活：读盘、建索引）
  return { app, plugin };
}

/** `data.json` 的落点（离线与真机同形：插件目录下） */
export function dataJsonPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.obsidian', 'plugins', 'kb-workbench', 'data.json');
}

/** 原样写一份 `data.json`（`rawData` 那条路的出口；也方便用例自己回读对比） */
export function writeRawDataJson(vaultRoot: string, data: Record<string, unknown>): void {
  const p = dataJsonPath(vaultRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * 在 `onload` **之前**把 `data.json` 写出来。
 * `fresh` 什么都不写（桩的 `loadData` 会返回 null → `normalizeSettings` 全默认）。
 *
 * 🔴 **夹具前提：这台"设备"显式选过「详细信息」档**（`notesView: 'detail'`）。
 *
 * 为什么要写死：P6 第八段把**产品默认**从"桌面→详细信息"改成了"一律网格"
 *（`resolveNotesView(null, …) === 'grid'`）。而整套离线用例的形态前提是
 * **表格档**（满屏的 `.kbw-trow`）—— 不写这一笔的话，它们会集体在一个
 * 网格档的界面上找表格行（那一片红**与产品行为对错无关**，纯属夹具没跟上）。
 *
 * ⚠️ 换句话说：**这里写的是"用户显式选过"，不是产品默认值**。
 * "全新安装落在网格档"那条判据在 `tests/specs/wizard.ts` 的
 * 「P6⑧ · 默认视图档」那组里（它自己起一个**没有 data.json** 的实例去验）。
 *
 * 🔴 **P7.10 · #8 加的第二笔：`notesIntroSeen: true`**（同样"这台设备见过"的语义）——
 * 首入「全部笔记」的一次性讲解浮层只看这个旗标。不写的话**所有进过 notes 的既有用例**
 * 都会先被那张浮层罩住（形态全变、全是与产品对错无关的红）。
 * 真正默认 = 没写过（`false` → 弹）那条判据在新组 `tests/specs/p710.ts` 里自己起 fresh 实例验。
 */
function seedDataJson(vaultRoot: string, mode: NonNullable<BootOptions['wizard']>): void {
  if (mode === 'fresh') return;
  const dir = path.join(vaultRoot, '.obsidian', 'plugins', 'kb-workbench');
  fs.mkdirSync(dir, { recursive: true });
  const patch: Record<string, unknown> =
    mode === 'done'
      ? { wizardDone: true, notesView: 'detail', notesIntroSeen: true }
      : mode === 'later'
        ? { wizardDone: false, notesView: 'detail', notesIntroSeen: true }
        : // configured：路径非默认。`notesIntroSeen` 三支都种（独立审 🟢3：漏了这一支，
          // 注释却声称"所有进过 notes 的既有用例"都被保护）
          { kbRoot: '02_别的库', metaDir: '99_Meta', notesView: 'detail', notesIntroSeen: true };
  fs.writeFileSync(path.join(dir, 'data.json'), `${JSON.stringify(patch, null, 2)}\n`);
}

// ── DOM 工具 ───────────────────────────────────────────────────
export function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`选择器没命中：${sel}`);
  return el;
}

export function qa<T extends Element = HTMLElement>(root: ParentNode, sel: string): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

export function maybe<T extends Element = HTMLElement>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}

export function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function textsOf(root: ParentNode, sel: string): string[] {
  return qa(root, sel).map((e) => textOf(e));
}

/**
 * **站进一个"本层有 ≥ n 篇笔记"的目录**（P6b ② 起列表只画本层，根层常常是空的）。
 *
 * 为什么走界面（点目录树节点）而不是 `goNotes({dir})`：列表与树的选中是两条下游，
 * 只有点了节点才两边都对上（与 `goHome` 那条"走界面"同一条纪律）。
 *
 * 🔴 **先等索引就绪**：索引 ready 会让模块**整个重挂一次**（外壳的 `moduleKey` 里有
 * `indexReady`）—— 早于那一刻拿到的 DOM 属于**马上要被拆掉的那个实例**，
 * 点它等于点在一个已经不显示的树上（用例会看到"点了没反应"，而 store 里其实改了）。
 *
 * ⚠️ 候选**从索引里取**（别写死目录名：夹具一换就假红）。只挑**顶层**目录 ——
 * 树默认只展开根节点，深一层（`02_Areas/每日任务`）的节点在 DOM 里根本不存在，点不到。
 *
 * @returns 站进去的那个目录（相对库根）；取不到返回 `''`（调用方的断言会当场说明）
 */
/**
 * **点目录树上的某个节点，并确认它真的选中了**（自证，最多试三次）。
 *
 * 🔴 为什么要自证：界面偏好是**防抖 400ms 落盘**的，而落盘会经 `applySettingsToStore`
 * → 外壳 `store.set` → 模块区**可能整体重挂一次**（`moduleKey` 含 `activeModule`）。
 * 重挂之后这一屏是新的、目录回到默认值 —— 于是"点了没反应"（而 store 里其实改过）。
 * 判据用**树上的选中态**（重挂后它会掉），跨越一次落盘窗口再复查。
 */
export async function clickTreeNode(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = qa<HTMLElement>(document.body, '.kbw-tree-item').find(
      (el) => el.dataset.dir === dir,
    );
    if (!item) return false;
    click(item);
    await settle(480);
    const after = qa<HTMLElement>(document.body, '.kbw-tree-item').find(
      (el) => el.dataset.dir === dir,
    );
    if (after?.classList.contains('is-on')) return true;
  }
  return false;
}

export async function enterTopDirWithNotes(
  ctx: {
    index: { isReady(): boolean; notes(): { effectivePosition: string }[] };
  },
  n = 3,
  opts: { exclude?: string[] } = {},
): Promise<string> {
  await until(() => ctx.index.isReady(), 4000);
  await settle(80);
  const byDir = new Map<string, number>();
  for (const e of ctx.index.notes()) {
    const dir = e.effectivePosition;
    if (!dir || dir.includes('/')) continue; // 只看顶层（树里点得到）
    if (opts.exclude?.includes(dir)) continue;
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const hit = Array.from(byDir.entries())
    .filter(([, c]) => c >= n)
    .sort((a, b) => b[1] - a[1])[0];
  if (!hit) return '';
  return (await clickTreeNode(hit[0])) ? hit[0] : '';
}

/** 让定时器与微任务跑完（区域重绘、debounce 都靠它） */
export async function tick(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function settle(ms = 220): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * 等到条件成立（或超时）。
 * 界面偏好是**防抖 400ms** 落盘的（真实行为）—— 用固定 `settle(450)` 会让整轮变慢，
 * 用轮询既快又不会因为机器慢而假红。
 */
export async function until(
  pred: () => boolean,
  timeoutMs = 1500,
  stepMs = 25,
): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function click(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

/**
 * **走完整鼠标序列**的点击：`pointerdown → mousedown → pointerup → mouseup → click`。
 *
 * 🔴 为什么要有它（d 期真机探针抓到的假绿）：
 * 上面的 `click()` **只派 `click`**，而真机上一次点击**先发 `mousedown`** ——
 * 凡是挂在 `document` 上的 mousedown 监听（浮层的"点外面就关"、"点了工作台就把焦点交给容器"）
 * 在离线都被跳过了。d 期的"单击卡片 = 再开一篇"正是栽在这上面：
 * 真机上 mousedown 先把面板关掉，紧跟着的 click 又开一扇新的，**上一篇就没了**；
 * 而离线用例全绿（只派 click 时那条监听根本不跑）。
 *
 * ⚠️ 不是把 `click()` 改掉：`click()` 被上百条既有用例依赖，改它会连带改掉一批行为；
 * 新写的、**依赖 mousedown 语义**的用例用这个。
 */
export function realClick(el: Element, init: MouseEventInit = {}): void {
  const base: MouseEventInit = { bubbles: true, cancelable: true, view: window, ...init };
  const pe = (type: string): Event =>
    typeof PointerEvent === 'function'
      ? new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, base);
  el.dispatchEvent(pe('pointerdown'));
  el.dispatchEvent(new MouseEvent('mousedown', base));
  el.dispatchEvent(pe('pointerup'));
  el.dispatchEvent(new MouseEvent('mouseup', base));
  el.dispatchEvent(new MouseEvent('click', base));
}

export function keydown(
  el: Element,
  key: string,
  mods: Partial<KeyboardEventInit> = {},
): KeyboardEvent {
  const evt = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  el.dispatchEvent(evt);
  return evt;
}

// ── metadataCache 滞后（桩模拟真机的 ~300ms）─────────────────────
/**
 * 让「写盘 → metadataCache 重解析 → 索引 debounce」这条链走完。
 *
 * 🔴 **P8 收口改：走"排干"，不猜时长**（原先 = `metadataCache.settle()` + 猜 200ms）。
 * 为什么改：跑的是**固定的墙钟毫秒**时，赌的其实是机器负载 —— 本项目三条固有 flake
 * （`P7.1c · 移动到` / `P7.1c · F2 就地改名` / `网格 · 拖到目录树`）都是这个形态：
 * 写完之后"立刻读"。
 * 现在**轮询排干**：`metadataCache.settle()` → `index.settle()`（把索引那两枚
 * debounce 直接点着）→ 让一轮事件走完；三轮收敛，最后那点 `settle(ms)` 保留
 *（其它非索引的 debounce 还靠它 —— 数量没变、只是"索引那一份不确定"被排掉了）。
 *
 * 🔴 **顺序要紧**：先 `metadataCache.settle()`（那次重解析的 `changed` 才会**同步**
 * 把路径记进索引的 `pending` 并挂上 `flush`），再调 `index.settle()`。反过来调 = 排了个空。
 * ⚠️ 索引引用取 `app.__kbwPlugin`（`bootPlugin` 挂的）—— 没 boot 过（纯桩用例）时为
 * `undefined`，那就只剩原先那 200ms 的路（行为与从前一致，不会更糟）。
 */
export async function settleIndex(app: StubApp, ms = 200): Promise<void> {
  const index = (app as unknown as { __kbwPlugin?: KbWorkbenchPlugin }).__kbwPlugin?.context().index;
  for (let i = 0; i < 3; i += 1) {
    app.metadataCache.settle();
    index?.settle();
    await tick(0);
  }
  await settle(ms);
}

/**
 * 模拟"别的程序改了库里的文件"：写盘 + 发 `modify` + 安排滞后重解析。
 * **不登记 self-write** → 索引会判成「外部改动」（`external-change`）。
 */
export function externalWrite(app: StubApp, relPath: string, text: string): StubTFile {
  return app.vault.simulateExternalWrite(relPath, text);
}

// ── 指针序列（拖拽 / 长按 全靠它） ───────────────────────────────
//
// jsdom 有 `PointerEvent` 这个构造器，但**不认 init 里的 pointerId / pointerType**
// （实测：传 'touch' 拿到 ''）→ 这里构造完再 `defineProperty` 补上，
// 否则"触屏走长按、鼠标走 4px 阈值"这条分支离线根本走不到。
export interface PointerInit {
  x: number;
  y: number;
  pointerType?: 'mouse' | 'touch' | 'pen';
  pointerId?: number;
  button?: number;
  buttons?: number;
}

export function pointerEvent(type: string, init: PointerInit): Event {
  const base = { bubbles: true, cancelable: true, clientX: init.x, clientY: init.y };
  const evt = new MouseEvent(type, base);
  const fields: Record<string, unknown> = {
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    isPrimary: true,
    clientX: init.x,
    clientY: init.y,
    pageX: init.x,
    pageY: init.y,
    button: init.button ?? 0,
    buttons: init.buttons ?? (type === 'pointerup' ? 0 : 1),
  };
  for (const [k, v] of Object.entries(fields)) {
    try {
      Object.defineProperty(evt, k, { value: v, configurable: true });
    } catch {
      /* 忽略 */
    }
  }
  return evt;
}

export function pointerDown(el: Element, init: PointerInit): Event {
  const evt = pointerEvent('pointerdown', init);
  el.dispatchEvent(evt);
  return evt;
}

export function pointerMove(el: Element, init: PointerInit): Event {
  const evt = pointerEvent('pointermove', init);
  el.dispatchEvent(evt);
  return evt;
}

export function pointerUp(el: Element, init: PointerInit): Event {
  const evt = pointerEvent('pointerup', init);
  el.dispatchEvent(evt);
  return evt;
}

export function pointerCancel(el: Element, init: PointerInit): Event {
  const evt = pointerEvent('pointercancel', init);
  el.dispatchEvent(evt);
  return evt;
}

/**
 * 走一遍完整指针序列：`down → move×N → up`。
 * 中间每步 `await tick(stepMs)`，让 400ms 长按这类定时器有机会触发。
 * `path` 里每一步都给一个元素 —— jsdom 没有命中测试，目标元素得由调用方指定
 * （真机上事件天然带正确的 target，代码里按 `evt.target.closest(...)` 取）。
 */
export async function pointerSequence(
  steps: { el: Element; init: PointerInit; type: 'down' | 'move' | 'up' | 'cancel' }[],
  stepMs = 8,
): Promise<void> {
  for (const s of steps) {
    if (s.type === 'down') pointerDown(s.el, s.init);
    else if (s.type === 'move') pointerMove(s.el, s.init);
    else if (s.type === 'up') pointerUp(s.el, s.init);
    else pointerCancel(s.el, s.init);
    await tick(stepMs);
  }
}

/** 把一串坐标插值成 `count` 步（拖拽路径） */
export function interpolate(
  from: { x: number; y: number },
  to: { x: number; y: number },
  count: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 1; i <= count; i += 1) {
    const t = i / count;
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return out;
}

// ── 文件工具（测试自己造夹具用） ───────────────────────────────
export function writeNote(vaultRoot: string, relPath: string, text: string): void {
  const abs = path.join(vaultRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

export function readNote(vaultRoot: string, relPath: string): string {
  return fs.readFileSync(path.join(vaultRoot, relPath), 'utf8');
}

export function exists(vaultRoot: string, relPath: string): boolean {
  return fs.existsSync(path.join(vaultRoot, relPath));
}

export function note(
  body: string,
  fm: Record<string, unknown> = {},
  opts: { 类型?: string; 状态?: string; 位置?: string[] } = {},
): string {
  const lines = ['---'];
  // v2：五件套（类型/状态/创建日期/tags/文件位置）——「领域」已退役，不再有默认值
  const merged = {
    类型: opts.类型 ?? '笔记',
    状态: opts.状态 ?? '进行中',
    创建日期: '2026-09-01',
    tags: [],
    文件位置: opts.位置 ?? [],
    ...fm,
  };
  for (const [k, v] of Object.entries(merged)) {
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${String(item)}`);
      }
    } else if (v == null) {
      lines.push(`${k}:`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n${body}`;
}

export function findByPath(files: (StubTFile | TFolder)[], p: string): StubTFile | null {
  for (const f of files) if (f.path === p) return f as StubTFile;
  return null;
}

/**
 * 从桩 vault 里取一个文件，按**插件 API 期望的 TFile 类型**返回。
 * 桩的类与 obsidian 的声明注定不是同一个（这正是桩的意义），所以这里做一次显式转换。
 */
export function fileAt(app: StubApp, p: string): TFile {
  const f = app.vault.getAbstractFileByPath(p);
  if (!f) throw new Error(`库里没有这个文件：${p}`);
  return f as unknown as TFile;
}

/** 卸载插件（把 registerEvent / register 的回调都放掉） */
export async function shutdown(plugin: KbWorkbenchPlugin): Promise<void> {
  await (plugin as unknown as { __unload: () => Promise<void> }).__unload();
}

export function listFiles(vaultRoot: string, rel: string): string[] {
  const abs = path.join(vaultRoot, rel);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  walk(abs, '');
  return out.sort();
}
