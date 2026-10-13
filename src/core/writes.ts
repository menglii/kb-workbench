/**
 * core/writes.ts —— 「这次写是我们自己干的」登记簿
 *
 * 为什么需要它：健康标记里的 `external-change`（外部改动未合并，交互规格 §3.3）
 * 要求区分"文件变了"里哪些是插件自己写的、哪些是别处改的。
 * 平台在写入时不带来源标记，所以只能自己登记：**谁写盘，谁先记账**。
 *
 * 约定：所有经过本插件改库的地方（frontmatter.setX / mover / snapshot 还原 /
 * report 写日志）**在动笔前**调 `markSelfWrite(path)`。
 *
 * ⚠️ 这是一条**约定**而不是强制机制：忘了登记不会丢数据，只会多出一个
 *    `external-change` 假警告 —— 所以宁可多登记，不可少登记。
 *
 * ── P7.14 第二条簿：「用户正在编辑器里写」────────────────────────
 * 原口径"不是插件的写 = 外部改动"把**用户在 Obsidian 编辑器里打字**也算了进去
 * （平台自动保存 → modify → 紫标 + 「外部改动没合并」行，而那条行撤不掉 —— Q24）——
 * 用户真机反馈："我刚建的、刚写的，哪来的外部？"（2026-10-08）。
 * 判据来源 = `workspace.on('editor-change')`：编辑器里每次输入先发这个事件，
 * 随后的自动保存就可认领。**语义边界**：只吞"有人在编辑器里打字"；
 * 同步/别的程序拉进来的写不会发 editor-change → 照旧标外改（那是这枚旗标要保的价值）。
 */
interface Entry {
  /** 过了这个时刻就不再认（毫秒时间戳） */
  until: number;
  /** 允许被消费的次数 —— 一次写盘可能触发多轮 modify 事件 */
  hits: number;
}

/** 两张簿（自写 / 用户编辑器写）共用同一套"登记 → 消费"机制，别各写一份 */
function makeRegistry(defaultTtl: number, defaultHits: number) {
  const pending = new Map<string, Entry>();
  const live = (path: string): Entry | null => {
    const e = pending.get(path);
    if (!e) return null;
    if (e.until < Date.now() || e.hits <= 0) {
      pending.delete(path);
      return null;
    }
    return e;
  };
  return {
    mark(path: string, ttlMs = defaultTtl, hits = defaultHits): void {
      if (!path) return;
      pending.set(path, { until: Date.now() + ttlMs, hits });
    },
    consume(path: string): boolean {
      const e = live(path);
      if (!e) return false;
      e.hits -= 1;
      if (e.hits <= 0) pending.delete(path);
      return true;
    },
    peek(path: string): boolean {
      return live(path) != null;
    },
    count(): number {
      return pending.size;
    },
    clear(): void {
      pending.clear();
    },
  };
}

/**
 * 允许被消费几次。
 * 一次 `processFrontMatter` 通常只触发一个 `modify` 事件 → 严格说 1 次就够；
 * 留到 2 是给"平台自己又补发一个事件"的余量。
 * ⚠️ 别调大：命中次数越多，**我们写完之后的真外部改动**越容易被当成自己写的而漏报。
 */
const DEFAULT_TTL = 8000;
const DEFAULT_HITS = 2;
const selfWrites = makeRegistry(DEFAULT_TTL, DEFAULT_HITS);

export function markSelfWrite(path: string, ttlMs = DEFAULT_TTL, hits = DEFAULT_HITS): void {
  selfWrites.mark(path, ttlMs, hits);
}

/** 改名/搬移要登记两个路径（旧路径与新路径都会收到事件） */
export function markSelfWritePair(from: string, to: string, ttlMs?: number): void {
  markSelfWrite(from, ttlMs);
  markSelfWrite(to, ttlMs);
}

/** 消费一次（用掉了就减一次；modify 事件里用这个） */
export function consumeSelfWrite(path: string): boolean {
  return selfWrites.consume(path);
}

/** 只查不消费（同一批事件里多处要判断时用） */
export function isRecentSelfWrite(path: string): boolean {
  return selfWrites.peek(path);
}

export function clearSelfWrites(): void {
  selfWrites.clear();
}

/** 仅供测试/排查：当前登记了多少条 */
export function selfWriteCount(): number {
  return selfWrites.count();
}

// ────────────────────────────────────────────────────────────────
// 用户编辑器登记簿（P7.14；理由见文件头 P7.14 段）
// ────────────────────────────────────────────────────────────────
/**
 * ⚠️ **TTL 比自写那条长**：Obsidian 的编辑器保存有个"停笔 ≈2s"的节流 ——
 * 最后一次击键到落盘之间隔着那一段，8s 会踩尾巴；12s 给足余量。
 * hits 同样别乱加：命中越多，**打字之后紧跟着来的真外部写**越容易被吞。
 */
const EDITOR_TTL = 12000;
const EDITOR_HITS = 3;
const userEdits = makeRegistry(EDITOR_TTL, EDITOR_HITS);

/** 用户在编辑器里敲了一下（`workspace.on('editor-change')` 的接线在 `vault-index.attach`） */
export function markUserEdit(path: string, ttlMs = EDITOR_TTL, hits = EDITOR_HITS): void {
  userEdits.mark(path, ttlMs, hits);
}

/** modify 事件到达时消费：在账上 = 这多半是"编辑器自动保存"，不算外部改动 */
export function consumeUserEdit(path: string): boolean {
  return userEdits.consume(path);
}

export function clearUserEdits(): void {
  userEdits.clear();
}

/** 仅供测试/排查 */
export function userEditCount(): number {
  return userEdits.count();
}
