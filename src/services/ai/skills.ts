/**
 * services/ai/skills.ts —— **能力包（skill）**：解析 + 读盘（P7.3c 定形）
 *
 * > **skills = 数据（文本），不是代码。** 一个 skill = 一份库内的 `.md`：
 * > YAML 前言写「名称 / 触发词 / 工具白名单」，正文就是给模型的指令。
 * > 它**不带来任何新能力** —— 只是"把已有工具里的一个子集 + 一段指令"打包起来，
 * > 用户显式选用（3c 只做显式选择；触发词目前只用于提示，自动启用留到以后）。
 *
 * ## 存放（用户 2026-10-02 拍板）
 *
 * `<库根>/<元数据目录>/06_工作台/skills/<名>.md`
 * —— 与 `03_AI指令集` 同一先例：**配置放库内**、可手改、可分享、随库同步。
 * ⚠️ 目录由 `settings.workbenchDir()` 派生（**不是常量**：用户改过元数据目录名之后，
 * 写死的路径会让这个功能在新目录名上静默失效）。
 *
 * ## 前言格式（**只认这六个中文键**，多出来的一律忽略）
 *
 * ```markdown
 * ---
 * 名称: 收件箱速理
 * 触发词: [收件箱, 整理收件箱]
 * 工具白名单: [search, read, move]
 * 参数槽: [主题]
 * 默认工作目录: 00_Inbox
 * 示例问法: [把收件箱里的都归位]
 * ---
 * 你是一个只做"收件箱归位"的助手……
 * ```
 *
 * 口径五条：
 *  · `名称` 缺了就用**文件名**（去扩展名）；
 *  · `工具白名单` **整个键缺了 = 不限制**（吃 `tools.ts` 的 `AI_TOOL_NAMES`）；
 *    给了但**一个都不认识**（或空） = **解析失败**（空能力包是配置错了，不是"什么都不做"）；
 *    认得的留下、不认得的丢掉（在 `warn` 里说出来，别静默）；
 *  · **P7.21b 的三个新键**（全是加法 —— 缺键 = 默认，老文件照旧解析）：
 *    `参数槽`（正文 `{{名字}}` 的收值清单，选中时先问后替）、
 *    `默认工作目录`（一个库内相对目录，没设过工作目录时用它）、
 *    `示例问法`（**只用于显示**）。坏形状不致命：忽略 + `warn` 说一句；
 *  · 正文是空的 = 解析失败（没有指令的能力包没有任何意义）；
 *  · **写了 `参数槽` 时**，正文里的 `{{x}}` 与清单对不齐（有一边缺）→ 进 `warn`
 *    （"填了也不会用"这类事要说出来；不写 `参数槽` 键 = 正文里的 `{{…}}` 当普通文本，不管）。
 *
 * ## 为什么自己解析前言（不调平台的 `parseYaml`）
 *
 * 本文件要能进**纯逻辑那一层**（`tests/specs/p73c.ts` 不装桩就能断言解析规则），
 * 而平台的 `parseYaml` 是个运行时值导出。只认 `key: value` / `key: [a, b]` /
 * `key:` + `- a` 三种形状的子集（**够用且可预测**），其余原样忽略 —— 这条子集
 * 写进 `AI接口冻结-P7.3c.md`，外派写 skill 的人照着它写。
 */
import type { App } from 'obsidian';
import { joinPath } from '../../core/paths';
import { AI_TOOL_NAMES, isAiToolName, type AiToolName } from './tools';

/** 一个能力包 */
export interface AiSkill {
  /** 库内绝对路径（唯一标识；同名不同文的两个文件靠它区分） */
  path: string;
  /** 显示名（前言 `名称`；缺了用文件名） */
  name: string;
  /**
   * 触发词（P7.21b 起**真的有用**）：输入框 `/` 出菜单；打开"自动挂载"开关后，
   * 输入的话命中触发词会自动挂上这个包（可撤、面板明示来源）。
   */
  triggers: string[];
  /** 工具白名单：**null = 不限制**；否则只允许这些（执行体照它收窄） */
  tools: AiToolName[] | null;
  /** 参数槽（P7.21b）：正文 `{{名字}}` 的名字清单 —— 选中时先问值、替换后再进 system；空 = 没有槽 */
  params: string[];
  /** 默认工作目录（P7.21b；相对库根，空串 = 不设）。库里没这个目录时**不设**并如实说 */
  workDir: string;
  /** 示例问法（P7.21b；**只用于显示** —— 能力包菜单里的一行提示） */
  examples: string[];
  /** 正文 = 指令（拼进 system 提示词那一段） */
  instructions: string;
  /** 解析时的非致命提醒（白名单里认不出的名字 / 参数槽对不齐之类）—— 界面上如实说一句 */
  warn?: string;
}

export type SkillParseResult =
  | { ok: true; skill: Omit<AiSkill, 'path'> }
  | { ok: false; why: string };

/** 前言的六个键（写进冻结说明；这里只认中文键，不做别名）。⚠️ P7.21b 加了后三个 */
export const SKILL_KEYS = {
  name: '名称',
  triggers: '触发词',
  tools: '工具白名单',
  params: '参数槽',
  workDir: '默认工作目录',
  examples: '示例问法',
} as const;

/** 指令正文的上限（防手滑把一整篇文章贴进去撑爆提示词） */
export const SKILL_MAX_CHARS = 4000;

/**
 * 解析一份 skill 文本（**纯函数**，可离线逐条断言）。
 *
 * @param text  文件全文
 * @param fallbackName 文件名（`名称` 缺了时用它）
 */
export function parseSkill(text: string, fallbackName = ''): SkillParseResult {
  const raw = String(text ?? '').replace(/^﻿/, '');
  let fm = '';
  let body = raw;
  /**
   * 前言只在**第一行就是 `---`** 时才算数（照 CommonMark/Frontmatter 的通行口径）——
   * 正文里出现的 `---` 分隔线不该把正文劈成两半。
   */
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (m) {
    fm = m[1];
    body = raw.slice(m[0].length);
  }
  const fields = fm === '' ? {} : parseMiniYaml(fm);

  const name = cleanScalar(fields[SKILL_KEYS.name]) || String(fallbackName ?? '').trim();
  if (name === '') return { ok: false, why: '这个文件既没有「名称」，也没法从文件名取名' };

  const triggers = cleanList(fields[SKILL_KEYS.triggers]);
  /** 非致命提醒都收这儿（最后合成一句 `warn` —— 界面上一处说全） */
  const warns: string[] = [];

  let tools: AiToolName[] | null = null;
  if (Object.prototype.hasOwnProperty.call(fields, SKILL_KEYS.tools)) {
    const listed = cleanList(fields[SKILL_KEYS.tools]);
    const kept: AiToolName[] = [];
    const unknown: string[] = [];
    for (const t of listed) {
      if (isAiToolName(t)) {
        if (!kept.includes(t)) kept.push(t);
      } else {
        unknown.push(t);
      }
    }
    if (kept.length === 0) {
      return {
        ok: false,
        why:
          listed.length === 0
            ? '「工具白名单」是空的 —— 空能力包什么也做不了（要么删掉这个键 = 不限制，要么写上工具名）'
            : `「工具白名单」里没有一个认识的工具（认得的是：${AI_TOOL_NAMES.join(' / ')}）`,
      };
    }
    tools = kept;
    if (unknown.length > 0) warns.push(`白名单里认不出的名字已忽略：${unknown.join('、')}`);
  }

  /** `参数槽`（P7.21b）：名字归一化 —— 写 `{{主题}}` 或 `主题` 都算同一个槽；去重 */
  const params: string[] = [];
  for (const raw of cleanList(fields[SKILL_KEYS.params])) {
    const slot = raw.replace(/[{}]/g, '').trim();
    if (slot !== '' && !params.includes(slot)) params.push(slot);
  }

  /**
   * `默认工作目录`（P7.21b）：只收**库内相对目录**（绝对路径 / `..` / 盘符一律忽略 + warn）——
   * 这个值会直接设进"工作目录"，坏值会让整段对话全被拒（不如不收）。
   * ⚠️ 开头的 `/` **不是"帮着归一掉"**：`/绝对/路径` 与库内相对写法是两种意思，
   * 静默重解释会让"我明明写的是绝对路径"变成"它悄悄钻进了某个同名相对目录"。
   */
  let workDir = '';
  const rawWd = cleanScalar(fields[SKILL_KEYS.workDir]);
  if (rawWd !== '') {
    const wd = rawWd.replace(/\\/g, '/').replace(/\/+$/, '');
    const bad =
      wd === '' ||
      wd.startsWith('/') ||
      /^[a-zA-Z]:/.test(wd) ||
      wd.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
    if (bad) warns.push(`「默认工作目录」不是一个库内相对目录，已忽略：${rawWd}`);
    else workDir = wd;
  }

  /** `示例问法`（P7.21b）：只用于显示（菜单里的一行提示） */
  const examples = cleanList(fields[SKILL_KEYS.examples]);

  const instructions = body.trim().slice(0, SKILL_MAX_CHARS);
  if (instructions === '') return { ok: false, why: '正文是空的 —— 能力包的正文就是给模型的指令' };

  /**
   * **参数槽 ↔ 正文占位符的对表**（P7.21b；只认显式的 `参数槽` 键当开关）：
   * 正文里的 `{{x}}` 不在清单里 / 清单里的名字正文里没有 —— 两边都进 `warn`
   *（"填了也不会用"这类事必须说出来，静默是这套机制最坏的一种失败）。
   */
  if (Object.prototype.hasOwnProperty.call(fields, SKILL_KEYS.params)) {
    const inBody: string[] = [];
    for (const m of instructions.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const slot = String(m[1]).trim();
      if (slot !== '' && !inBody.includes(slot)) inBody.push(slot);
    }
    const ghostInBody = inBody.filter((s) => !params.includes(s));
    if (ghostInBody.length > 0) {
      warns.push(`正文里这些 {{…}} 不在「参数槽」清单里（选中时不会问你填）：${ghostInBody.join('、')}`);
    }
    const unusedSlots = params.filter((s) => !inBody.includes(s));
    if (unusedSlots.length > 0) {
      warns.push(`「参数槽」里这些名字在正文里没出现（填了也不会用）：${unusedSlots.join('、')}`);
    }
  }

  return {
    ok: true,
    skill: { name, triggers, tools, params, workDir, examples, instructions, warn: warns.length > 0 ? warns.join('；') : undefined },
  };
}

/** 正则转义（参数名可能含正则元字符） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * **参数槽填值**（P7.21b 纯函数）：把正文里的 `{{名字}}` 换成用户填的值。
 *
 * 口径（"只做加法/替换，不解释成工具参数"）：
 *  · 只换**清单里有名字**的那些（名字照参数槽归一化后的写法匹配，`{{ 名字 }}` 的松散写法也认）；
 *  · **空值 = 原样留着**（用户没填 ≠ 删掉那个记号 —— 不瞎填）；
 *  · 值里带 `$&` 这类替换模式不受影响（用回调替换，别用字符串替换）。
 */
export function fillSkillParams(instructions: string, values: Record<string, string>): string {
  let out = String(instructions ?? '');
  for (const [k, v] of Object.entries(values ?? {})) {
    const name = String(k ?? '').replace(/[{}]/g, '').trim();
    const val = String(v ?? '').trim();
    if (name === '' || val === '') continue;
    out = out.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, 'g'), () => val);
  }
  return out;
}

/**
 * **触发词命中**（P7.21b 纯函数）：输入的一段话里"包含"某个包的触发词 → 回那个包。
 *
 * 口径：包含即算（中文没有词边界，"精确 = 整句相等"没法用）；大小写不敏感；
 * 多个包同时命中取**第一个**（列表按名字排序 → 结果确定，不是"碰巧哪个先"）。
 * 空话（只有空白）永远回 `null`。
 */
export function matchSkillByTrigger(skills: AiSkill[], text: string): AiSkill | null {
  const hay = String(text ?? '').toLowerCase();
  if (hay.trim() === '') return null;
  for (const s of skills) {
    for (const t of s.triggers) {
      const needle = t.trim().toLowerCase();
      if (needle !== '' && hay.includes(needle)) return s;
    }
  }
  return null;
}

/** `key: value` 的迷你解析（值三种形状：标量 / 行内数组 / 块列表） */
function parseMiniYaml(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const kv = /^([^:#][^:]*):(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const rest = kv[2].trim();
    if (rest === '') {
      // 块列表：往下收 `- item` 行（收到第一个不是列表项的行为止）
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        i += 1;
        items.push(cleanScalar(lines[i].replace(/^\s*-\s+/, '')));
      }
      out[key] = items.filter((x) => x !== '');
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest
        .slice(1, -1)
        .split(',')
        .map((x) => cleanScalar(x))
        .filter((x) => x !== '');
      continue;
    }
    out[key] = cleanScalar(rest);
  }
  return out;
}

/** 去引号与空白（YAML 里 `"a"` / `'a'` / `a` 都算同一个值） */
function cleanScalar(v: unknown): string {
  const s = String(v ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** 标量当单元素列表；数组原样（去空） */
function cleanList(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => cleanScalar(x)).filter((x) => x !== '');
}

// ────────────────────────────────────────────────────────────────
// 读盘（与 `sessions.ts` 同一个形状：`vault.adapter`，不碰库内写盘）
// ────────────────────────────────────────────────────────────────
/** 一次列目录的结果：能用的 + 读不动的（**读不动的要说出来**，别静默少一个） */
export interface AiSkillList {
  skills: AiSkill[];
  skipped: { file: string; why: string }[];
}

export class AiSkillStore {
  constructor(
    private app: App,
    /**
     * 技能目录（**现取**，不是构造时定死）—— 用户改过库根 / 元数据目录名之后，
     * 下一次 list 就该看新目录（口径与 `configs` 的"路径都由 settings 派生"一致）。
     */
    private dirOf: () => string,
  ) {}

  rootDir(): string {
    return this.dirOf().replace(/^\/+|\/+$/g, '');
  }

  /** 列全部能力包（按名字排序）。目录不存在 = 空表（不是错） */
  async list(): Promise<AiSkillList> {
    const dir = this.rootDir();
    const adapter = this.app.vault.adapter;
    let files: string[] = [];
    try {
      if (!(await adapter.exists(dir))) return { skills: [], skipped: [] };
      files = (await adapter.list(dir)).files;
    } catch {
      return { skills: [], skipped: [] };
    }
    const skills: AiSkill[] = [];
    const skipped: { file: string; why: string }[] = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue; // 只认 .md（模板 / 说明放这儿也不会被当能力包）
      const base = f.split('/').pop() ?? f;
      try {
        const text = await adapter.read(f);
        const parsed = parseSkill(text, base.replace(/\.md$/i, ''));
        if (parsed.ok) skills.push({ ...parsed.skill, path: f });
        else skipped.push({ file: base, why: parsed.why });
      } catch {
        skipped.push({ file: base, why: '读不出来' });
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return { skills, skipped };
  }

  /** 按路径取一个（面板选中之后重新读一遍当前内容——文件可能刚被手改过） */
  async load(path: string): Promise<AiSkill | null> {
    const dir = this.rootDir();
    if (!path.startsWith(`${dir}/`)) return null;
    try {
      const text = await this.app.vault.adapter.read(path);
      const parsed = parseSkill(text, (path.split('/').pop() ?? '').replace(/\.md$/i, ''));
      return parsed.ok ? { ...parsed.skill, path } : null;
    } catch {
      return null;
    }
  }
}

/** 技能目录的**唯一拼法**（`settings.workbenchDir()` 之下；别在别处再拼一份） */
export function skillsDirOf(workbenchDir: string): string {
  return joinPath(workbenchDir.replace(/^\/+|\/+$/g, ''), 'skills');
}
