/**
 * services/report.ts —— 操作日志
 *
 * **日志是库内的 `.md` 实体**（`类型: 日志`），不是插件私有数据：
 * 可被双链引用、可被看板检索、能在 Obsidian 里直接读（交互规格 §7.7）。
 *
 * 分工（方案设计.md §6.1 / 交互规格 §10.2）：
 *   **快照负责还原，日志负责给人看** —— 不拿日志做逆运算。
 *
 * 落点：`01_新知识库/99_Meta/05_操作日志/日志-<时间戳>-<动作>.md`
 *
 * ⚠️ 写日志**绝不能让操作本身失败**：任何异常都吞掉 + 控制台报，
 * 顶多让用户少一条记录，不能因为记录失败而回滚一次成功的移动。
 */
import { TFile, type App } from 'obsidian';
import { SettingsStore } from '../core/settings';
import { markSelfWrite } from '../core/writes';
import { joinPath } from '../core/paths';
import { stamp, todayISO } from '../core/util';

export type ReportResult = 'ok' | 'partial' | 'error';

export interface ReportRow {
  label: string;
  detail?: string;
}

export interface ReportSpec {
  /** 「移动」「删除」「改属性」「还原」 */
  action: string;
  result: ReportResult;
  /** 来源：drag / batch / ai / board / rebuild / reconcile / undo / manual */
  source: string;
  /** 「已移动 12 篇笔记」 */
  summary: string;
  rows?: ReportRow[];
  moves?: { from: string; to: string }[];
  skipped?: { path: string; why: string }[];
  blocked?: { path: string; why: string }[];
  already?: string[];
  touched?: string[];
  snapshotId?: string;
  /** 是否 AI 建议的（§11 要求每次动库都留痕，便于事后回看它判断得对不对） */
  ai?: boolean;
  extra?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  drag: '拖拽',
  batch: '批量操作',
  ai: 'AI 建议',
  board: '看板拖动',
  rebuild: '库结构重排',
  reconcile: '自动归位',
  menu: '编辑器菜单',
  template: '模板库',
  suggest: '整理建议',
  todo: '待处理',
  undo: '撤销还原',
  manual: '手动',
};

const RESULT_LABEL: Record<ReportResult, string> = {
  ok: '成功',
  partial: '部分成功',
  error: '失败',
};

export class ReportService {
  private app: App;
  private settings: SettingsStore;
  /**
   * 已确保存在的那个日志目录（**记路径，别记布尔** —— P7.17 探针实测的红）：
   * 旧写法是 `ensured = false/true`，切库根（向导/设置都能换）之后布尔还是 true，
   * `ensureDir()` 直接短路 → 新库根下 `99_Meta/05_操作日志` 根本没建 →
   * `vault.create` ENOENT，日志**从此静默停写**（错误被 catch 成一行 console）。
   * 记路径：目录换了就重新 ensure 一次。
   */
  private ensuredDir: string | null = null;
  /** 测试与排查用：最近一次写日志的失败原因 */
  public lastError: string | null = null;

  constructor(app: App, settings: SettingsStore) {
    this.app = app;
    this.settings = settings;
  }

  dir(): string {
    return this.settings.logDir();
  }

  /** 写一条操作日志。失败只报不改（返回 null） */
  async log(spec: ReportSpec): Promise<TFile | null> {
    try {
      await this.ensureDir();
      const path = await this.uniquePath(spec.action);
      markSelfWrite(path);
      const file = await this.app.vault.create(path, this.render(spec));
      return file;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.error('[经纬] 写操作日志失败（不影响已完成的操作）', e);
      return null;
    }
  }

  private async ensureDir(): Promise<void> {
    const dir = this.dir();
    if (this.ensuredDir === dir) return;
    if (!(await this.app.vault.adapter.exists(dir))) {
      // S3 实测：adapter.mkdir 一次能建多级
      await this.app.vault.adapter.mkdir(dir);
    }
    this.ensuredDir = dir;
  }

  private async uniquePath(action: string): Promise<string> {
    const base = `日志-${stamp()}-${action.replace(/[\\/:*?"<>|]/g, '')}`;
    let candidate = joinPath(this.dir(), `${base}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = joinPath(this.dir(), `${base}-${n}.md`);
      n += 1;
    }
    return candidate;
  }

  private render(spec: ReportSpec): string {
    const now = new Date();
    const lines: string[] = [];
    // 前言：日志本身也是笔记实体，走 v2 五件套的简写（类型: 日志；领域已退役、不写）
    lines.push('---');
    lines.push('类型: 日志');
    lines.push('状态: 已完成');
    lines.push(`创建日期: ${todayISO(now)}`);
    lines.push('tags: []');
    lines.push('---');
    lines.push('');
    lines.push(`# ${spec.action} · ${stamp(now, false).replace('-', ' ')}`);
    lines.push('');
    lines.push(`**结果**：${RESULT_LABEL[spec.result]}｜**来源**：${SOURCE_LABEL[spec.source] ?? spec.source}`);
    lines.push('');
    lines.push(spec.summary);
    lines.push('');

    if (spec.moves && spec.moves.length > 0) {
      lines.push('## 移动');
      lines.push('');
      lines.push('| 从 | 到 |');
      lines.push('| --- | --- |');
      for (const m of spec.moves) lines.push(`| \`${m.from}\` | \`${m.to}\` |`);
      lines.push('');
    }

    if (spec.rows && spec.rows.length > 0) {
      lines.push('## 明细');
      lines.push('');
      for (const r of spec.rows) {
        lines.push(r.detail ? `- **${r.label}** —— ${r.detail}` : `- ${r.label}`);
      }
      lines.push('');
    }

    if (spec.already && spec.already.length > 0) {
      lines.push('## 已搬过（内容相同，跳过）');
      lines.push('');
      for (const p of spec.already) lines.push(`- \`${p}\``);
      lines.push('');
    }

    if (spec.skipped && spec.skipped.length > 0) {
      lines.push('## 跳过');
      lines.push('');
      for (const s of spec.skipped) lines.push(`- \`${s.path}\` —— ${s.why}`);
      lines.push('');
    }

    if (spec.blocked && spec.blocked.length > 0) {
      lines.push('## 真冲突（目标已有同名文件且内容不同，**未覆盖**）');
      lines.push('');
      for (const b of spec.blocked) lines.push(`- \`${b.path}\` —— ${b.why}`);
      lines.push('');
    }

    if (spec.touched && spec.touched.length > 0) {
      lines.push('## 双链被平台改写的其他文件');
      lines.push('');
      lines.push('（这些文件不在本次操作的目标里，快照已一并存下）');
      lines.push('');
      for (const t of spec.touched) lines.push(`- \`${t}\``);
      lines.push('');
    }

    if (spec.snapshotId) {
      lines.push(`**快照**：\`${spec.snapshotId}\``);
      lines.push('');
    }
    if (spec.ai) {
      lines.push('**这条是 AI 建议的**');
      lines.push('');
    }
    if (spec.extra) {
      lines.push('## 补充');
      lines.push('');
      lines.push(spec.extra);
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 最近的 N 条日志（时间倒序；文件名带时间戳，字典序即时间序） */
  async recent(n = 20): Promise<TFile[]> {
    const dir = this.dir();
    const folder = this.app.vault.getAbstractFileByPath(dir);
    const out: TFile[] = [];
    const walk = (node: { children?: unknown[] } | null): void => {
      if (!node || !Array.isArray(node.children)) return;
      for (const child of node.children as (TFile & { children?: unknown[] })[]) {
        if (child instanceof TFile && child.extension === 'md') out.push(child);
        else walk(child as { children?: unknown[] });
      }
    };
    walk(folder as { children?: unknown[] } | null);
    out.sort((a, b) => b.name.localeCompare(a.name));
    return out.slice(0, n);
  }

  /**
   * 打开最近一条操作日志（「查看报告」的唯一实现点：mover 的通知、撤销条的「查看」
   * 都走这里）。**不要在别处再抄一份** —— 两处口径会漂。
   */
  async openLatest(): Promise<boolean> {
    try {
      const recent = await this.recent(1);
      if (recent.length === 0) return false;
      // ⚠️ 用 `'tab'` 不用 `false`：`false` 会**替换当前叶子**，而当前叶子往往就是工作台 ——
      // "查看报告"点一下工作台就没了（真机踩过，见 `归档/期末交接-P3.md` 真机第 2 条）
      await this.app.workspace.getLeaf('tab').openFile(recent[0]);
      return true;
    } catch (e) {
      console.error('[经纬] 打开操作日志失败', e);
      return false;
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 反向读（设置面板的「日志」栏要列表与筛选 —— §7.7）
// ────────────────────────────────────────────────────────────────
export interface ParsedReport {
  /** 「移动」「删除」「属性迁移」…（取 H1 里 ` · ` 之前那一段） */
  action: string;
  result: ReportResult;
  source: string;
  /** 摘要那一句 */
  summary: string;
  /** 摘要里提到的篇数（没有就 0）——**只在摘要里出现过**，不是精确统计 */
  files: number;
  ai: boolean;
  snapshotId: string;
  at: string;
}

/**
 * 把一篇日志读回结构化（`render()` 的逆）。
 * ⚠️ 它是给人看的日志，**不是数据格式** —— 解析失败一律返回 null（界面上就不显示这一条），
 * 绝不因为"读不出来"而报错或猜。别拿它当数据库用。
 */
export function parseReport(text: string, fallbackName = ''): ParsedReport | null {
  const lines = text.split('\n');
  const h1 = lines.find((l) => l.startsWith('# '));
  let action = '';
  let at = '';
  if (h1) {
    const rest = h1.slice(2);
    const i = rest.indexOf('·');
    action = (i >= 0 ? rest.slice(0, i) : rest).trim();
    at = i >= 0 ? rest.slice(i + 1).trim() : '';
  }
  if (!action && fallbackName) {
    // 文件名形如 `日志-20260924-122600-移动.md`
    const m = fallbackName.match(/^日志-\d{8}-\d{6}-(.+?)(?:-\d+)?\.md$/);
    action = m ? m[1] : '';
  }
  if (!action) return null;

  const resultLine = lines.find((l) => l.startsWith('**结果**'));
  let result: ReportResult = 'ok';
  if (resultLine) {
    if (resultLine.includes('部分成功')) result = 'partial';
    else if (resultLine.includes('失败')) result = 'error';
  }
  const sourceM = resultLine?.match(/来源\*\*：(.+)$/);
  const source = sourceM ? sourceM[1].trim() : '';

  // 摘要 = 结果行之后第一段非空、非标题的正文
  let summary = '';
  const start = resultLine ? lines.indexOf(resultLine) : 0;
  for (let i = start + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#') || t.startsWith('**')) {
      if (summary) break;
      continue;
    }
    summary = t;
    break;
  }
  const n = summary.match(/(\d+)\s*篇/);
  const snapM = text.match(/\*\*快照\*\*：`([^`]+)`/);
  return {
    action,
    result,
    source,
    summary,
    files: n ? Number(n[1]) : 0,
    ai: text.includes('**这条是 AI 建议的**'),
    snapshotId: snapM ? snapM[1] : '',
    at,
  };
}
