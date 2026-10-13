/**
 * ui/settings/ai.ts —— 设置面板第 8 栏「AI 助手」（交互规格 §11 / §7）
 *
 * P7.3c（8.2）从"四样设置 + 两件说明"扩成六组：
 *   ① **连接**：`protocol`（协议：OpenAI 兼容 / Anthropic 原生，P7.22b · #4）·
 *      `baseUrl` / `model` / `apiKey` + 「**测试连接**」（17.10③ 的本地模型诊断）
 *   ② **权限**：七类 × 三档（禁 / 需确认 / 自动）→ `ai.toolTiers` ＋ **三按钮整档预设**
 *      （保守 / 标准 / 全权，P7.22a · #13）
 *      （⚠️ P7.5 起旧的 `allowWrite` 开关已退役 —— 见 `core/settings.ts` 的 v4→v5 迁移）
 *   ③ **模型参数**：`maxTokens` / `temperature`（默认值 = 历来写死的那两个）
 *   ③.5 **任务模型**（P7.22b · #5）：逐任务配模型（不填 = 主模型）；顺带指路
 *      「AI 提示词附加层」（`06_工作台/AI提示词/<任务id>.md`，P7.22b · #3）
 *   ④ **成本**：默认单价（回落值）+ **按模型定价**多条（P7.22b · #5；只本地做乘法，不联网）
 *   ⑤ **会话管理**：列表 + 重命名 + 导出 + 删除（D5 拍板；历史抽屉那边**不**加删除）
 *   ⑥ key 存在哪（老的说明，原样）
 *
 * 🔴 **key 的三个纪律**（都在这一个文件里落实）：
 *   ① 存**插件 `data.json`**（`core/settings.ts` 的 `ai`），**不进库** —— 库会同步；
 *   ② 界面上**打码显示**（`type="password"`），配一个「看一眼」的显隐按钮；
 *   ③ **不进任何日志 / 通知 / 报告** —— 这一栏只写 `settings`，不往 `report` 里塞任何东西。
 *
 * ⚠️ **测试连接**会真发一条请求（几厘钱，`maxTokens: 8`）—— 这是 17.10③ 明确要的口子；
 * 旧注释里那句"不测连通性"已作废（当时的理由是"探针里已经有一条真连判据"，
 * 而那是**给开发看的**，用户手里没有）。
 */
import type { AiSettings } from '../../core/settings';
import { AI_DEFAULTS } from '../../core/settings';
import {
  AI_TASK_LIST,
  AI_TOOL_CLASSES,
  DEFAULT_TOOL_TIERS,
  effectiveTier,
  formatSessionMd,
  titleOf,
  type AiTestResult,
  type AiToolClass,
  type AiToolTier,
} from '../../services/ai';
import { confirm } from '../confirm';
import { openNewNoteDialog } from '../new-note';
import { notify } from '../notify';
import { btn, div } from '../primitives';
import { promptText } from '../prompt';
import {
  emptyLine,
  ghostBtn,
  group,
  inputCtl,
  note,
  numberCtl,
  readRow,
  row,
  segCtl,
  setTitle,
  switchCtl,
  toolbar,
} from './kit';
import type { SectionApi, SettingsSection } from './types';

/** 三档（顺序 = 从紧到松；各自的含义见 `AI_TOOL_CLASSES` 的 hint 与下面那条 note） */
const TIER_OPTS: { value: AiToolTier; label: string }[] = [
  { value: 'off', label: '禁' },
  { value: 'confirm', label: '需确认' },
  { value: 'auto', label: '自动' },
];

export function makeAiSection(): SettingsSection {
  return {
    id: 'ai',
    label: 'AI 助手',
    icon: 'sparkles',
    sub: '模型与 key · 权限与成本',
    render(host, api) {
      const ctx = api.ctx;
      const cfg = (): AiSettings => ctx.settings.get().ai;
      /** 改一项就落盘一次（`inputCtl` 是 change 才回调 —— 不是每敲一个键） */
      const save = (patch: Partial<AiSettings>): void => {
        void ctx.settings.save({ ai: { ...cfg(), ...patch } });
      };

      host.appendChild(
        setTitle('AI 助手', '面板里能查库、给方案，动库前都要你确认；这一栏管「连哪个模型」「它有多大权限」「花了多少钱」'),
      );

      // ── ① 连接 ────────────────────────────────────────────
      host.appendChild(
        group(
          '连接',
          '两路协议：OpenAI 兼容（POST <baseURL>/chat/completions —— DeepSeek / OpenAI / 本地模型都是这一份实现）· ' +
            'Anthropic 原生（Messages API + prompt caching）',
        ),
      );
      /**
       * **协议**（P7.22b · #4）：选路的**唯一来源**（不做 baseUrl 自动识别 ——
       * 显式可测，也覆盖中转 / 代理域名）。默认 OpenAI 兼容 = 现状零变化。
       */
      host.appendChild(
        row(
          '协议',
          segCtl(
            cfg().protocol,
            [
              { value: 'openai', label: 'OpenAI 兼容' },
              { value: 'anthropic', label: 'Anthropic 原生' },
            ],
            (v) => {
              save({ protocol: v });
              // segCtl 的行内选中态是**建时算死的** —— 不重画则 is-on 不动（独立审 Y-3 实测）
              api.rerender();
            },
          ),
          'Anthropic 原生 = Messages API（自带 prompt caching）。它要求 maxTokens 有值（0 = 发 4096 兜底）、温度上限 1',
        ),
      );
      host.appendChild(
        row(
          'baseURL',
          inputCtl(cfg().baseUrl, (v) => save({ baseUrl: v.trim() }), {
            placeholder: AI_DEFAULTS.baseUrl,
            width: '260px',
          }),
          'OpenAI 兼容：写到 /v1 为止（不带 /chat/completions）；Anthropic 原生：填域名/前缀即可（带 /v1 也认）',
        ),
      );
      host.appendChild(
        row(
          '模型',
          inputCtl(cfg().model, (v) => save({ model: v.trim() }), {
            placeholder: AI_DEFAULTS.model,
            width: '200px',
          }),
          '填那家文档里给的模型名，例如 deepseek-chat',
        ),
      );
      host.appendChild(apiKeyRow(cfg, save));

      /**
       * **「测试连接」**（17.10③）：发一条最短的消息，把失败**按 `AiError.kind` 分类**报出来。
       * 结果行常驻在按钮下面（不是通知 —— 通知一闪就没了，而诊断要能对着看）。
       */
      const testOut = note('还没测过 —— 换了 baseURL / 模型 / key 之后点一下', 'info');
      const testBtn = btn({ cls: 'kbw-btn is-small', text: '测试连接' });
      testBtn.addEventListener('click', () => void runTest());
      host.appendChild(
        row(
          '测试连接',
          toolbar(testBtn),
          '真发一条最短的消息（几厘钱）。连不上时会说清是哪一类：key 不对 / 地址不对 / 连不上 / 走了哪条路',
        ),
      );
      host.appendChild(testOut);

      host.appendChild(
        note(
          '本地模型：把 baseURL 换成 Ollama（http://localhost:11434/v1）或 LM Studio（http://localhost:1234/v1）' +
            '就能接，模型名填它们加载的那个。本地口多半不吐流式增量 —— 插件会自动降级成整包回传（面板里看得出来）。',
        ),
      );

      // ── ② 权限 ────────────────────────────────────────────
      host.appendChild(
        group('权限', '七类操作各自一档。默认：读与搜索自动、其余需确认（安全底线不随档位变化）'),
      );
      /**
       * **三按钮整档预设**（P7.22a · #13「全权套件」）：一键把七类档位写成某一种组合。
       * 口径 = **一次性写显式档位**（逐类面板照旧是最细的口子 —— 预设只是"一次写全"）。
       *   · **保守** = *只读顾问*（读·搜自动、写类**全禁**）—— AI 帮看帮想，一个字节不动库；
       *   · **标准** = **今天的默认表**（读/搜自动，其余需确认）—— 必须恒等于 `DEFAULT_TOOL_TIERS`；
       *   · **全权** = 七类全自动（写类的"自动"照旧 = **自动弹确认框**，确认本身永远不省）。
       * 🔴 「全权」只能被**用户显式点**出来 —— 与「提权只能来自用户设置操作」同一条
       * （模型不能自我授权）；预设也**不许被任何代码静默应用**（点了才写）。
       */
      const PRESETS: Record<'conservative' | 'standard' | 'full', Record<AiToolClass, AiToolTier>> = {
        conservative: { read: 'auto', prop: 'off', tag: 'off', create: 'off', move: 'off', delete: 'off', text: 'off' },
        /**
         * ⚠️ **「标准」直接展开默认表**（独立审 🟡4）：不许手抄第二份 ——
         * "标准 = 今天的默认表" 是拍板口径，手抄的字面量将来必与
         * `DEFAULT_TOOL_TIERS` 漂（点过"标准"的还会被旧值钉住）。
         */
        standard: { ...DEFAULT_TOOL_TIERS },
        full: { read: 'auto', prop: 'auto', tag: 'auto', create: 'auto', move: 'auto', delete: 'auto', text: 'auto' },
      };
      const PRESET_KEYS: { key: 'conservative' | 'standard' | 'full'; label: string }[] = [
        { key: 'conservative', label: '保守' },
        { key: 'standard', label: '标准' },
        { key: 'full', label: '全权' },
      ];
      /** 当前档明示：按**实际生效**的七类组合去对预设（对不上 = 自定义） */
      const currentPreset = (): string => {
        const c = cfg();
        for (const p of PRESET_KEYS) {
          if (AI_TOOL_CLASSES.every((cl) => effectiveTier(cl.id, c) === PRESETS[p.key][cl.id])) return p.label;
        }
        return '自定义';
      };
      const applyPreset = (key: 'conservative' | 'standard' | 'full'): void => {
        save({ toolTiers: { ...PRESETS[key] } });
        api.rerender();
      };
      host.appendChild(
        row(
          '整档预设',
          toolbar(
            ghostBtn('保守', () => applyPreset('conservative')),
            ghostBtn('标准', () => applyPreset('standard')),
            ghostBtn('全权', () => applyPreset('full')),
          ),
          `当前：${currentPreset()} · 保守 = 只读顾问（写类全禁）· 标准 = 默认表 · 全权 = 全部自动（写类照旧弹确认框）`,
        ),
      );
      for (const c of AI_TOOL_CLASSES) {
        /**
         * 显示的是**当前实际生效**的那一档（`effectiveTier`），写下去的是**显式值** ——
         * 两者在存量数据上不一定一样（没设过的类别靠默认表兜底）；显示显式值会让
         * 用户看到"我明明是自动，怎么写着需确认"。
         */
        host.appendChild(
          row(
            c.label,
            segCtl(effectiveTier(c.id, cfg()), TIER_OPTS, (v) => {
              save({ toolTiers: { ...(cfg().toolTiers ?? {}), [c.id]: v } });
              api.rerender();
            }),
            c.hint,
          ),
        );
      }
      host.appendChild(
        note('「自动」对可写的类别 = 自动弹出确认框 —— 省的只是「先点执行」那一小步，确认本身不省；删除永远是危险两段。'),
      );
      host.appendChild(
        toolbar(
          ghostBtn('全部恢复默认（读/搜自动，其余需确认）', () => {
            // 清空 = 没有显式档位 → 回落到默认表（逐类那一份是"显式覆盖"）
            save({ toolTiers: {} });
            api.rerender();
          }),
        ),
      );

      // ── ②.5 能力包（P7.21b）────────────────────────────────
      host.appendChild(
        group('能力包', '库内 06_工作台/skills/ 下的 .md（一段指令 + 工具白名单）；这一栏管"怎么选中它"'),
      );
      host.appendChild(
        row(
          '触发词自动挂载',
          switchCtl(cfg().triggerAutoMount, (v) => save({ triggerAutoMount: v })),
          '默认关。开了之后：输入的话里命中某个能力包的「触发词」→ 自动挂上它（胶囊写明来源、点 ✕ 即撤）；' +
            '关了就用输入框「/」或「＋ → 能力包…」手动选',
        ),
      );
      host.appendChild(
        note('它只影响"要不要自动挂"—— 挂上之后能力包照旧只做减法（工具白名单只会更窄，权限一个字不动）。'),
      );

      // ── ③ 模型参数 ────────────────────────────────────────
      host.appendChild(
        group('模型参数', '默认值就是历来写死的那两个（1200 / 0）—— 不动它们 = 行为一个字不变'),
      );
      host.appendChild(
        row(
          '单次回答上限（token）',
          numberCtl(cfg().maxTokens, (v) => save({ maxTokens: v }), { min: 0, max: 200_000, width: '96px' }),
          '0 = 不限定。调小可以让"跑飞"的回答早点断，代价是长回答会被截断',
        ),
      );
      host.appendChild(
        row(
          '温度（0–2）',
          numberCtl(cfg().temperature, (v) => save({ temperature: v }), { min: 0, max: 2, step: 0.1, width: '76px' }),
          '整理归类要的是稳定，默认 0；往上调会更"有想法"，也更爱自由发挥',
        ),
      );

      // ── ③.5 任务模型（P7.22b · #5）────────────────────────
      host.appendChild(
        group(
          '任务模型',
          '逐任务配模型：不填 = 跟着上面的主模型。分类这种一次过很多篇的可以配便宜的小模型，写作配强的',
        ),
      );
      for (const t of AI_TASK_LIST) {
        host.appendChild(
          row(
            t.label,
            inputCtl(
              cfg().taskModels[t.id] ?? '',
              (v) => {
                const next = { ...cfg().taskModels };
                const name = v.trim();
                if (name === '') delete next[t.id];
                else next[t.id] = name;
                save({ taskModels: next });
              },
              { placeholder: '（跟主模型）', width: '200px' },
            ),
            `任务 id：${t.id}`,
          ),
        );
      }
      host.appendChild(
        note(
          '另外：在 06_工作台/AI提示词/ 下新建以任务 id 命名的 .md（如 修失效双链 对应 links.md），' +
            '正文就是那条任务的附加要求 —— 每次都会自动拼进提示词（只做加法，硬规矩与输出格式不受影响）。',
        ),
      );

      // ── ④ 成本 ────────────────────────────────────────────
      host.appendChild(
        group('成本', '下面三个数是默认单价（回落值）；「按模型定价」命中就用它。只本地做乘法，不联网'),
      );
      host.appendChild(
        row(
          '输入单价',
          numberCtl(cfg().priceIn, (v) => save({ priceIn: v }), { min: 0, step: 0.01, width: '90px' }),
          `默认（回落）每百万 token。默认 ${AI_DEFAULTS.priceIn} 填的是 DeepSeek deepseek-chat 的高峰时段价（偏保守，` +
            '空闲时段约一半；缓存命中的输入低得多）——以你家的价目表为准',
        ),
      );
      host.appendChild(
        row(
          '输出单价',
          numberCtl(cfg().priceOut, (v) => save({ priceOut: v }), { min: 0, step: 0.01, width: '90px' }),
          `默认（回落）每百万 token。默认 ${AI_DEFAULTS.priceOut}（同上，高峰期；实际往往更低）`,
        ),
      );
      host.appendChild(
        row(
          '货币符号',
          inputCtl(cfg().priceUnit, (v) => save({ priceUnit: v.trim().slice(0, 4) }), {
            placeholder: AI_DEFAULTS.priceUnit,
            width: '60px',
          }),
          '只用于显示（¥ / $ / 空都行）—— 这里不换算汇率',
        ),
      );
      /**
       * **按模型定价**（P7.22b · #5）：多模型多条（命中就用它 —— 模型名逐字相等；
       * 没命中的回落到上面三个数）。条目的增删走这一组；改一行就地落盘。
       */
      host.appendChild(
        row(
          '按模型定价',
          toolbar(ghostBtn('添加一条', () => void addPriceRow())),
          '命中就用它（模型名要和「模型」栏里逐字一致）；没命中的回落到上面三个数',
        ),
      );
      cfg().modelPrices.forEach((entry, i) => {
        const patch = (part: Partial<{ model: string; priceIn: number; priceOut: number }>): void => {
          const rows = cfg().modelPrices.map((x, j) => (j === i ? { ...x, ...part } : x));
          save({ modelPrices: rows });
        };
        host.appendChild(
          row(
            `条目 ${i + 1}`,
            toolbar(
              inputCtl(entry.model, (v) => patch({ model: v.trim() }), { placeholder: '模型名', width: '200px' }),
              numberCtl(entry.priceIn, (v) => patch({ priceIn: v }), { min: 0, step: 0.01, width: '80px' }),
              numberCtl(entry.priceOut, (v) => patch({ priceOut: v }), { min: 0, step: 0.01, width: '80px' }),
              ghostBtn('删', () => {
                save({ modelPrices: cfg().modelPrices.filter((_, j) => j !== i) });
                api.rerender();
              }),
            ),
            '模型名 · 输入单价 · 输出单价（每百万 token）',
          ),
        );
      });

      /** 加一条按模型定价：先问模型名（空条目不落盘 —— 读盘收敛会把空名条目丢掉） */
      async function addPriceRow(): Promise<void> {
        const name = await promptText({
          title: '加一条按模型定价',
          label: '模型名（要和上面「模型」栏里逐字一致）',
          primary: '添加',
          validate: (v) => (v.trim() === '' ? '模型名不能是空的' : null),
        });
        if (name == null) return;
        save({ modelPrices: [...cfg().modelPrices, { model: name.trim(), priceIn: 0, priceOut: 0 }] });
        api.rerender();
      }

      // ── ⑤ 会话管理（D5）────────────────────────────────────
      host.appendChild(
        group('会话', '存在插件目录 ai-sessions/（不进库、不随同步）—— 这里的删除只删对话记录，不碰笔记'),
      );
      const sessBox = div({ cls: 'kbw-set-sesslist' });
      host.appendChild(sessBox);
      void fillSessions(sessBox, api);

      // ── ⑥ key 存在哪（用户有权知道）────────────────────────
      host.appendChild(group('key 存在哪'));
      host.appendChild(
        readRow(
          '落盘位置',
          '.obsidian/plugins/kb-workbench/data.json',
          '这台机器的插件配置。不进知识库 —— 库会同步，key 不该跟着笔记上云；也不进任何日志与报告',
        ),
      );

      /**
       * 「测试连接」的动作。⚠️ **结果写在 `testOut` 那一行里**（不是通知）：
       * 诊断的话通常有两三句（分类 + 怎么办），通知放不下也留不住。
       */
      async function runTest(): Promise<void> {
        testBtn.disabled = true;
        testBtn.textContent = '测试中…';
        paintTest(testOut, { ok: true, hint: '正在发一条最短的消息…' }, true);
        const res = await ctx.ai.testConnection();
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
        paintTest(testOut, res);
      }

      /**
       * ⚠️ 「重新运行首次向导」**不在这里** —— 它现在在**「帮助」栏**（`settings/help.ts`）。
       * 位置变过两次，每次都是"文案与实现各说各话"那一类：第一版放在这一栏，
       * 而向导的副标题写着"设置 → 外观 →…"；P6 第八段用户第 4 条又把它从「外观」
       * 搬到了「帮助」（依据是**语义**：向导是"带我走一遍"，与外观无关）。
       */
      return undefined;
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 测试连接的呈现（纯函数，可离线断言）
// ────────────────────────────────────────────────────────────────
/**
 * 把 `AiTestResult` 画成一行话。
 *
 * 🔴 **分类只说一类**（与 `AiError.kind` 同一份），但要**对症**：404 与 401 的处理方向
 * 完全不同（一个是地址写错、一个是 key 不对），混成一句"连接失败"等于没说。
 */
export function diagnoseTest(res: AiTestResult): { text: string; kind: 'info' | 'warn' | 'error' } {
  if (res.ok) {
    const via = res.via === 'stream' ? '流式（fetch + SSE）' : '整包（requestUrl）';
    return { text: `连上了 ✓ 走的是 ${via}${res.note ? ` —— ${res.note}` : ''}`, kind: 'info' };
  }
  const status = res.status != null ? `（HTTP ${res.status}）` : '';
  const head = `没连上${status}：${res.hint ?? '原因不明'}`;
  const advice: string[] = [];
  if (res.kind === 'no-key') advice.push('去上面两栏填好 baseURL / 模型 / API key');
  if (res.kind === 'auth') advice.push('key 抄错了，或者这个 key 没有该模型的权限');
  if (res.kind === 'http' && res.status === 404) {
    advice.push('多半是 baseURL 写错：写到 /v1 为止，别带 /chat/completions；本地模型还要确认端口');
  }
  if (res.kind === 'network') {
    advice.push('查地址 / 端口 / 网络三样；本地模型要先把 Ollama、LM Studio 自己跑起来');
  }
  if (res.kind === 'rate') advice.push('等一会儿再试，或者换一个 key');
  if (res.kind === 'shape') advice.push('对方回了东西但不是模型回答 —— 地址多半指向了一个网站而不是 API');
  if (advice.length === 0) advice.push('检查上面几样：地址 / 模型名 / key / 网络');
  return { text: `${head}。${advice.join('；')}`, kind: 'error' };
}

function paintTest(out: HTMLElement, res: AiTestResult, testing = false): void {
  if (testing) {
    out.className = 'kbw-set-note is-info';
    out.textContent = res.hint ?? '测试中…';
    return;
  }
  const d = diagnoseTest(res);
  out.className = `kbw-set-note is-${d.kind}`;
  out.textContent = res.detail ? `${d.text}（对方原话：${res.detail.slice(0, 120)}）` : d.text;
}

// ────────────────────────────────────────────────────────────────
// 会话管理（D5：列表 + 重命名 + 导出 + 删除；历史抽屉那边**不**加删除）
// ────────────────────────────────────────────────────────────────
/**
 * 会话列表。三件动作都在**行内**（与快照列表同一形态）：
 *   · **重命名** = 改这一段的标题（就是抽屉里显示的那一行；不动正文）；
 *   · **导出** = 走「新建笔记」那条既有出口（`openNewNoteDialog` 带 `bodyText`）——
 *     与面板头部那枚「导出为笔记」是**同一份** `formatSessionMd`；
 *   · **删除** = 删插件目录里那一个 JSON。⚠️ **过 `ui/confirm.ts`**（危险态那一段）——
 *     删东西就过一次确认，不因为"它不是库内文件"就少这一道（快照清理也是这么做的）。
 */
async function fillSessions(host: HTMLElement, api: SectionApi): Promise<void> {
  const ctx = api.ctx;
  const metas = await ctx.ai.sessions.list();
  host.replaceChildren();
  if (metas.length === 0) {
    host.appendChild(emptyLine('还没有对话 —— 在面板里问过一轮之后，这里会出现那一段'));
    return;
  }
  for (const m of metas) {
    host.appendChild(
      row(
        m.title,
        toolbar(
          ghostBtn('重命名', () => void rename(m.id, m.title)),
          ghostBtn('导出', () => void exportOne(m.id)),
          ghostBtn('删除', () => void removeOne(m.id, m.title)),
        ),
        `${timeOf(m.updatedAt)} · ${m.turnCount} 轮`,
      ),
    );
  }

  async function rename(id: string, cur: string): Promise<void> {
    const next = await promptText({
      title: '重命名这段对话',
      label: '标题（只改列表里显示的名字，不动内容）',
      value: cur,
      primary: '改名',
      validate: (v) => (v.trim() === '' ? '标题不能是空的' : null),
    });
    if (next == null) return; // 取消
    const s = await ctx.ai.sessions.load(id);
    if (!s) {
      notify({ kind: 'error', text: '这段对话读不出来', ms: 4000 });
      return;
    }
    await ctx.ai.sessions.save({ ...s, title: next.trim() });
    api.rerender();
  }

  async function exportOne(id: string): Promise<void> {
    const s = await ctx.ai.sessions.load(id);
    if (!s) {
      notify({ kind: 'error', text: '这段对话读不出来', ms: 4000 });
      return;
    }
    // 与面板头部那枚「导出为笔记」同一个出口（`createNote` 的既有写盘路径）
    openNewNoteDialog(ctx, { presetTitle: `AI 对话 ${s.title || titleOf('')}`, bodyText: formatSessionMd(s) });
  }

  async function removeOne(id: string, title: string): Promise<void> {
    const res = await confirm({
      title: `即将删除对话「${title}」`,
      preview: [{ kind: 'delete', where: '插件目录 ai-sessions/', count: 1 }],
      warnings: [],
      notes: ['删的是这段对话的记录（插件目录里的一个文件）——不碰任何笔记'],
      danger: { confirmLabel: '再点一次确认', irreversible: true },
      primary: { label: '删除这段对话' },
    });
    if (res.action !== 'primary') return;
    await ctx.ai.sessions.remove(id);
    api.rerender();
  }
}

/** 列表里的时间：今天只写时分，其余写月-日（与抽屉那份口径一致） */
function timeOf(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return `今天 ${hm}`;
  }
  return `${d.getMonth() + 1}-${two(d.getDate())} ${hm}`;
}

/**
 * key 那一行。
 *
 * ⚠️ **必须 `type="password"`**（默认打码）：设置面板常常开着被人从背后看到，
 * 而这一格是全屏最不该裸奔的内容。配一个显隐按钮是给"我想核对一下复制对没对"用的。
 *
 * ⚠️ `cfg` / `save` 由调用方传进来，**不能**提到 `makeAiSection` 外面 ——
 * 它们闭包在 `render(host, api)` 的作用域里（`api` 每次开面板都是新的）。
 */
function apiKeyRow(cfg: () => AiSettings, save: (patch: Partial<AiSettings>) => void): HTMLElement {
  const input = inputCtl(cfg().apiKey, (v) => save({ apiKey: v.trim() }), {
    placeholder: '还没填',
    width: '260px',
  });
  input.type = 'password';
  input.autocomplete = 'off';

  let shown = false;
  const eye = ghostBtn('看一眼', () => {
    shown = !shown;
    input.type = shown ? 'text' : 'password';
    eye.textContent = shown ? '藏起来' : '看一眼';
  });

  const line = row('API key', input, '只存在这台机器上；打码显示');
  // 把显隐按钮塞在输入框右边（`kit.row` 只吃一个控件，所以自己往 ctl 里补一个）
  line.querySelector('.kbw-set-ctl')?.appendChild(toolbar(eye));
  return line;
}
