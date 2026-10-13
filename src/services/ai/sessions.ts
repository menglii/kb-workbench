/**
 * services/ai/sessions.ts —— AI 会话的持久化（5.1a；G4-C1 拍板 2026-10-02）
 *
 * **存哪**：插件目录 `ai-sessions/`（**不进库** —— 库会同步、会搜、会被当数据；
 * 它的出口是「导出为笔记」）。与 `snapshots/` 同一先例。
 *
 * **怎么存**：
 *   · 走 `vault.adapter`（**不是 Node `fs`** —— `isDesktopOnly:false` 下手机端不崩，同 `snapshot.ts`）；
 *   · 一次 `adapter.mkdir` 能建多级（S3 实测）；**写完回读校验**
 *     （`saveData` 静默吞 ENOENT 那条教训的现实对策）；
 *   · 一个会话 = 一个 JSON 文件，不搞索引文件（会话数量少，列目录即可）。
 *
 * **格式带版本号**（照 `SETTINGS_VERSION` / `BOARD_CONFIG_VERSION` 的形状）：
 * 读盘一律过 `migrateSession()` —— 升级后仍能读旧会话；读不动的（未来版本 / 形状烂了）
 * **跳过而不是猜**（列表里少一份，好过整屏报错）。
 *
 * 🔴 本文件**不做任何库内写盘**（`services/ai` 的红线照旧：import 不到 `mover`）——
 * 会话文件在插件目录，`vault` 的索引都看不见它。
 */
import type { App } from 'obsidian';
import { joinPath } from '../../core/paths';
import { stamp } from '../../core/util';
import { fmtTokens } from './cost';
import type { AiTurn } from './index';

/** 会话文件的当前版本号。改它 = 同时在 `migrateSession()` 补一段"从上一版迁过来" */
export const AI_SESSIONS_VERSION = 1;

/** 列表里露出来的那几项（不把整个 turns 拖出来） */
export interface AiSessionMeta {
  id: string;
  /** 第一问截 20 字；没有就用「新对话」 */
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

export interface AiSession extends AiSessionMeta {
  version: number;
  turns: AiTurn[];
}

/** 从第一问取标题（截断别太短：列表里要认得出是哪一段） */
export function titleOf(firstQuestion: string): string {
  const q = String(firstQuestion ?? '').trim().replace(/\s+/g, ' ');
  if (q === '') return '新对话';
  return q.length > 20 ? `${q.slice(0, 20)}…` : q;
}

/** 开一份空会话 */
export function newSession(): AiSession {
  const now = Date.now();
  return {
    version: AI_SESSIONS_VERSION,
    id: '',
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    turns: [],
  };
}

/**
 * 读盘迁移（纯函数）：认版本号 · 幂等 · 读不动就 null（**别猜**）。
 * 现有版本还没有"迁"的内容（v1 是首版），函数先把**防御性整形**做了：
 * 形状烂的轮次丢掉、缺的字段补齐 —— 会话文件是长期资产，别让一条烂数据带崩整个面板。
 */
export function migrateSession(raw: unknown): AiSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const ver = typeof o.version === 'number' ? o.version : 0;
  if (ver > AI_SESSIONS_VERSION) return null; // 未来版本：不猜，跳过
  const id = typeof o.id === 'string' && o.id !== '' ? o.id : '';
  if (id === '') return null;
  const turns = Array.isArray(o.turns) ? o.turns.map(shapedTurn).filter((t): t is AiTurn => t !== null) : [];
  return {
    version: AI_SESSIONS_VERSION,
    id,
    title: typeof o.title === 'string' && o.title !== '' ? o.title : '新对话',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
    turnCount: turns.length,
    turns,
  };
}

/** 一轮的形状检查（缺关键字段就丢掉这一轮，不整份作废） */
function shapedTurn(raw: unknown): AiTurn | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.question !== 'string') return null;
  const plan = (t.plan ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(plan.rows) ? plan.rows : [];
  const blocked = Array.isArray(plan.blocked) ? plan.blocked : [];
  return {
    question: t.question,
    kind: t.kind === 'advice' ? 'advice' : t.kind === 'agent' ? 'agent' : 'chat',
    reply: typeof t.reply === 'string' ? t.reply : '',
    ideas: Array.isArray(t.ideas) ? (t.ideas as AiTurn['ideas']) : [],
    plan: { rows: rows as AiTurn['plan']['rows'], blocked: blocked as AiTurn['plan']['blocked'] },
    proposed: typeof t.proposed === 'number' ? t.proposed : 0,
    dropped: typeof t.dropped === 'number' ? t.dropped : 0,
    // 引用材料（`@` 引用）原样带回：重试要用它。形状烂了就当没有（这一轮照样能显示）
    refs: Array.isArray(t.refs) ? (t.refs as AiTurn['refs']) : undefined,
    // agent 轮的"干活过程"（P7.3b）：历史重画要读它 —— 逐层整形，烂的条目丢掉
    steps: shapedSteps(t.steps),
    // ⚠️ 'handoff'（P7.22b 的开面板收尾）—— P7.24 · L2 起不再产生；这里的读入分支只为老会话
    stopped:
      t.stopped === 'limit'
        ? 'limit'
        : t.stopped === 'done'
          ? 'done'
          : t.stopped === 'handoff'
            ? 'handoff'
            : undefined,
    parseError: t.parseError === true ? true : undefined,
    aborted: t.aborted === true ? true : undefined,
    failNote: typeof t.failNote === 'string' && t.failNote !== '' ? t.failNote : undefined,
    // 用量（P7.3c 17.10②）：历史/导出里也看得到"这段对话花了多少"。逐项收敛，烂的丢掉
    usage: shapedUsage(t.usage),
    skill: typeof t.skill === 'string' && t.skill !== '' ? t.skill : undefined,
  };
}

/** 一轮用量的形状检查（缺的字段补 0、非数字丢掉；全丢就返回 undefined） */
function shapedUsage(raw: unknown): AiTurn['usage'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const p = num(o.promptTokens);
  const c = num(o.completionTokens);
  if (p === null && c === null) return undefined;
  return {
    promptTokens: p ?? 0,
    completionTokens: c ?? 0,
    estimated: o.estimated === true,
    calls: num(o.calls) ?? 0,
  };
}

/**
 * `steps` 的防御性整形（P7.3b）。会话文件是**长期资产**（手改 / 旧版本都可能），
 * 而历史重画会直接 `steps.flatMap(...items.map(...outcome.summary))` ——
 * 一条缺 `items` 的烂数据就够让整面板打不开。层层检查，烂的丢，好的留。
 */
function shapedSteps(raw: unknown): AiTurn['steps'] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<AiTurn['steps']> = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const items: NonNullable<AiTurn['steps']>[number]['items'] = [];
    for (const it of Array.isArray(o.items) ? o.items : []) {
      if (!it || typeof it !== 'object') continue;
      const r = it as Record<string, unknown>;
      const call = r.call as Record<string, unknown> | undefined;
      const outcome = r.outcome as Record<string, unknown> | undefined;
      if (!call || typeof call.tool !== 'string') continue;
      if (!outcome || typeof outcome.summary !== 'string') continue;
      items.push({
        call: {
          tool: call.tool,
          args: (call.args && typeof call.args === 'object' && !Array.isArray(call.args)
            ? call.args
            : {}) as Record<string, unknown>,
        },
        outcome: {
          ok: outcome.ok === true,
          summary: outcome.summary,
          detail: typeof outcome.detail === 'string' ? outcome.detail : undefined,
          changed: outcome.changed === true,
        },
      });
    }
    out.push({ prose: typeof o.prose === 'string' ? o.prose : '', items });
  }
  return out.length > 0 ? out : undefined;
}

export class AiSessionStore {
  constructor(
    private app: App,
    private pluginDir: string,
  ) {}

  rootDir(): string {
    return joinPath(this.pluginDir.replace(/^\/+|\/+$/g, ''), 'ai-sessions');
  }

  private fileOf(id: string): string {
    return joinPath(this.rootDir(), `${id}.json`);
  }

  /**
   * 列表（按最近更新倒序）。读不动的文件**跳过**（`migrateSession` 返回 null），
   * 不让一份烂数据把整张列表带崩。
   */
  async list(): Promise<AiSessionMeta[]> {
    const dir = this.rootDir();
    const adapter = this.app.vault.adapter;
    let files: string[] = [];
    try {
      if (!(await adapter.exists(dir))) return [];
      files = (await adapter.list(dir)).files;
    } catch {
      return [];
    }
    const out: AiSessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const s = await this.loadFile(f);
      if (s) out.push({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, turnCount: s.turns.length });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  async load(id: string): Promise<AiSession | null> {
    if (!/^[\w.-]+$/.test(id)) return null; // 防路径拼接出花（id 一律是我们造的）
    return this.loadFile(this.fileOf(id));
  }

  /** 最近一份（面板打开时恢复用） */
  async latest(): Promise<AiSession | null> {
    const l = await this.list();
    return l.length > 0 ? this.load(l[0].id) : null;
  }

  /**
   * 存一份。空 id 就现取一个（`stamp()`，撞了就加序号 —— 同 `snapshot` 的 `dirOf` 那种循环）。
   * **写完回读校验**：长度对不上就当失败抛出来（静默"存了像没存"是本项目的著名坑）。
   */
  async save(session: AiSession): Promise<AiSession> {
    const adapter = this.app.vault.adapter;
    const dir = this.rootDir();
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir); // 一次建多级（S3 实测）
    let id = session.id;
    if (id === '') {
      id = stamp();
      let n = 2;
      while (await adapter.exists(this.fileOf(id))) {
        id = `${stamp()}-${n}`;
        n += 1;
        if (n > 50) id = `${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
      }
    }
    const next: AiSession = { ...session, id, version: AI_SESSIONS_VERSION, turnCount: session.turns.length };
    const text = JSON.stringify(next, null, 1);
    const path = this.fileOf(id);
    await adapter.write(path, text);
    const back = await adapter.read(path);
    if (back !== text) throw new Error(`会话没写成功（回读不一致）：${path}`);
    return next;
  }

  async remove(id: string): Promise<void> {
    if (!/^[\w.-]+$/.test(id)) return;
    const path = this.fileOf(id);
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
  }

  private async loadFile(path: string): Promise<AiSession | null> {
    try {
      const text = await this.app.vault.adapter.read(path);
      return migrateSession(JSON.parse(text));
    } catch {
      return null;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 导出为笔记的格式化（纯函数；面板拿去当 `createNote` 的正文）
// ────────────────────────────────────────────────────────────────

/**
 * 一轮 → Markdown。**动作记录原样保留**（那是这一轮真正值钱的东西）：
 * agent 轮取 `steps` 里的执行结果；v1 的建议轮退回 `plan.rows`。
 * 路径用相对口径（与界面一致）—— 笔记里再写库内绝对路径，读者看不懂。
 */
export function formatTurnMd(t: AiTurn): string {
  const out: string[] = [`**我**：${t.question}`, '', `**助手**：${t.reply || '（没有回话）'}`];
  if (t.steps && t.steps.length > 0) {
    const lines = t.steps.flatMap((s) => s.items.map((it) => `- ${it.outcome.summary}`));
    if (lines.length > 0) out.push('', '做了：', ...lines);
    out.push(...usageNote(t));
    return out.join('\n');
  }
  const rows = t.plan.rows;
  if (rows.length > 0) {
    out.push('', '建议：');
    for (const r of rows) out.push(`- \`${r.rel}\` → \`${r.dirRel}\`${r.why ? `（${r.why}）` : ''}`);
  }
  out.push(...usageNote(t));
  return out.join('\n');
}

/** 导出时那一行用量脚注（P7.3c 17.10②）—— 费用不写进来（单价是设置里的，导出的笔记该自成一体） */
function usageNote(t: AiTurn): string[] {
  if (!t.usage) return [];
  const bits = [
    `用量：输入 ${fmtTokens(t.usage.promptTokens)} / 输出 ${fmtTokens(t.usage.completionTokens)} token`,
  ];
  if (t.usage.estimated) bits.push('估算');
  if (t.skill) bits.push(`能力包：${t.skill}`);
  return ['', `> ${bits.join(' · ')}`];
}

/** 整个会话 → Markdown（「导出为笔记」的正文）。标题行 + 每轮之间空行分隔 */
export function formatSessionMd(session: AiSession): string {
  const lines: string[] = [`> 由「经纬 · 工作台」AI 助手导出（${new Date(session.updatedAt).toLocaleString()}）`];
  for (const t of session.turns) {
    lines.push('', '---', '', formatTurnMd(t));
  }
  return lines.join('\n').trim() + '\n';
}
