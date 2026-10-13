/**
 * services/review.ts —— 回顾卡的数据层（P8 期 2）
 *
 * 唯一真源：**库内** `99_Meta/06_工作台/复习.json`（`core/config-files.ts` 的第 4 个条目）。
 * 为什么不放插件 `data.json`：① `方案设计.md` §3.1 的"凡是有意义的配置一律放库内"
 * ——复习进度是**用户数据**；② `data.json` 里已经躺着 AI API key，把"凭证"和"学习记录"的
 * 同步/备份面绑一起不划算（C7 那条安全账）。写这个文件**不会**触发笔记索引重建
 *（`vault-index` 只收 `.md`）。
 *
 * ⚠️ 两条本模块的硬约束（计划 §3，实现时别丢）：
 *   · **不写笔记属性** —— 卡片是派生数据，"掌握度"这类扩展字段不进 frontmatter
 *     （属性 v2 刚精简过；红线断言钉着本文件里不许出现 `processFrontMatter`/`fm.setMany`）
 *   · **改笔记名/搬笔记要迁键** —— 卡片存的是笔记路径，不迁就指空，
 *     而且**只有真机上才现形**（与顺序表、比例表同一处账，见 `main.ts` 的 rename 处理）
 *
 * 数据形状（`version: 1`；将来要能按版本迁移，因为它是库内文件）：
 * ```
 * { "version": 1, "cards": [ { id, note, front, back, createdAt, lastReview, nextReview, interval, reps, lapses } ] }
 * ```
 */
import { TFile, type App } from 'obsidian';
import type { ConfigFiles } from '../core/config-files';

export interface ReviewCard {
  /** `ts36-rand`：人能读、够唯一，不用 uuid（零依赖） */
  id: string;
  /** **来源笔记，相对库根**（如 `01_新知识库/02_Areas/内容创作/x.md`）—— 改名要跟着迁 */
  note: string;
  /** 正面（问题） */
  front: string;
  /** 背面（答案） */
  back: string;
  createdAt: number;
  lastReview: number | null;
  /** 时间戳；`<= 今天` 才算今日到期 */
  nextReview: number;
  /** 天 */
  interval: number;
  reps: number;
  lapses: number;
}

export interface ReviewFile {
  version: 1;
  cards: ReviewCard[];
}

/**
 * ⚠️ **形状只留这一处**（`config-files.ts` 的 `reviewDefaults` 调它）——
 * 抄第二份就会漂（`automationDefaults` 那条注释记过同一件事）。
 */
export function reviewDefaults(): ReviewFile {
  return { version: 1, cards: [] };
}

// ────────────────────────────────────────────────────────────────
// 纯函数（判据断得清的那一半）
// ────────────────────────────────────────────────────────────────

/** 当天 0 点（"今天到期"的基准；相减比较放 `dueCards`） */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 新卡：**间隔 1 天、今天到期**（计划 §3 的间隔表）。
 * `nextReview` 取当天 0 点而不是 `now` —— 否则"今天建的卡"要等到明天同一时刻才到期，
 * 与"今天该复习"的直觉不符（`dueCards` 按天比，见下）。
 */
export function newCard(
  note: string,
  front: string,
  back: string,
  now: number,
  id?: string,
): ReviewCard {
  return {
    id: id ?? `rv-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    note,
    front: front.trim(),
    back: back.trim(),
    createdAt: now,
    lastReview: null,
    nextReview: startOfDay(now),
    interval: 1,
    reps: 0,
    lapses: 0,
  };
}

/**
 * 今日到期（含**逾期**与**今天建的**）：`nextReview <= 今天 0 点`。
 * ⚠️ 边界口径（计划 §5.1 有专门用例）：今天建的卡（`nextReview === 今天 0 点`）**算今日**；
 * 昨天到期的算；明天到期的不算。
 */
export function dueCards(cards: readonly ReviewCard[], now: number): ReviewCard[] {
  const today = startOfDay(now);
  /**
   * ⚠️ **两边都归到"天"再比**（`startOfDay(c.nextReview) <= today`），不是拿时间戳直接比。
   * 起初写的是 `c.nextReview <= today` —— 那是**错的**：卡上的 `nextReview` 可能带着当天
   * 某个时刻（P8 期 3 的「记住/模糊」会写"今天 + 间隔"那种值），直接比时间戳会把
   * **今天到期的卡判成不到期**（本仓的用例当场逮住：`2026-10-10 08:00` 的卡在 09:00 判不出到期）。
   * 语义就是"哪一天该复习"，不是"哪一刻"。
   */
  return cards.filter((c) => startOfDay(c.nextReview) <= today);
}

/**
 * 改名/搬移之后把卡片上的 `note` 迁过去（**表里存的是路径，就得跟着 rename 走**）。
 *
 * 与 `remapOrder`（网格顺序表）/ 看板顺序表同一条纪律、同一处挂载点。**两处比它们严**：
 *   · 精确命中：`note === oldPath` → `newPath`
 *   · **整目录前缀命中**：`note` 在 `oldPath/` 之下 → 换成 `newPath/` 之下
 *     （改文件夹名在平台上是**一个** rename 事件。不认前缀的话，用户改一次文件夹名，
 *     那底下所有笔记的卡片**一起指空** —— 卡片是用户手写的问答，丢了找不回，
 *     比顺序表掉末尾严重得多）
 * 未命中时**原样返回**（调用方据此不写盘：`不改名时不许动` 是用例之一）。
 */
export function remapCards(
  cards: readonly ReviewCard[],
  oldPath: string,
  newPath: string,
): ReviewCard[] {
  if (!oldPath || !newPath || oldPath === newPath) return [...cards];
  const prefix = `${oldPath}/`;
  let hit = false;
  const out = cards.map((c) => {
    if (c.note === oldPath) {
      hit = true;
      return { ...c, note: newPath };
    }
    if (c.note.startsWith(prefix)) {
      hit = true;
      return { ...c, note: `${newPath}/${c.note.slice(prefix.length)}` };
    }
    return c;
  });
  return hit ? out : [...cards];
}

/**
 * 笔记真被删了 → 把它的卡片剪掉（死键会一直攒着，且面板里会画出点不开的卡）。
 *
 * ⚠️ **与 `remapCards` 对称：也认整目录前缀**（独立审 2026-10-10 指出的不对称）：
 * 删掉一个文件夹时平台发的是**那一个** delete 事件（与改名同款）—— 只认精确命中，
 * 就会把底下所有笔记的卡留成死键（面板整片写「来源已不在」，而用户已经没法从 UI 修）。
 */
export function pruneCards(cards: readonly ReviewCard[], removed: string): ReviewCard[] {
  if (!removed) return [...cards];
  const prefix = `${removed}/`;
  const out = cards.filter((c) => c.note !== removed && !c.note.startsWith(prefix));
  return out.length === cards.length ? [...cards] : out;
}

/** 比两份 cards 是否逐字段相同（决定要不要写盘；数组顺序也算 —— 顺序变了就是变了） */
export function sameCards(a: readonly ReviewCard[], b: readonly ReviewCard[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => JSON.stringify(c) === JSON.stringify(b[i]));
}

/** 一张卡的两个面都非空才算填完（对话框与菜单的置灰原因都用它） */
export function cardIncomplete(front: string, back: string): boolean {
  return front.trim() === '' || back.trim() === '';
}

// ────────────────────────────────────────────────────────────────
// 间隔推进（P8 期 3；规则 = 计划 §3 那张表，固定倍增，**不做 SM-2**）
// ────────────────────────────────────────────────────────────────

/** 三个档（缺一档就分不出"会了但不利索"） */
export type ReviewGrade = 'remember' | 'fuzzy' | 'forgot';

/** 一轮复习的计数（小结那一屏用） */
export interface ReviewTally {
  total: number;
  remember: number;
  fuzzy: number;
  forgot: number;
}

export function emptyTally(): ReviewTally {
  return { total: 0, remember: 0, fuzzy: 0, forgot: 0 };
}

/** 记一笔（**唯一出处**：小结与用例都读它，别在别处再数一遍） */
export function countTally(t: ReviewTally, grade: ReviewGrade): ReviewTally {
  return {
    total: t.total + 1,
    remember: t.remember + (grade === 'remember' ? 1 : 0),
    fuzzy: t.fuzzy + (grade === 'fuzzy' ? 1 : 0),
    forgot: t.forgot + (grade === 'forgot' ? 1 : 0),
  };
}

/**
 * **按天**加减（不用 `ts + n*86400000`：那是"24 小时 ×N"，跨天判据会差一格）。
 * 输入先归到当天 0 点，所以日间调用方拿到的都是**本地 0 点**（与 `dueCards` 的粒度对齐 ——
 * "哪一天该复习"，不是"哪一刻"）。
 * ⚠️ 诚实一句边界：走 `setDate` 在"夏令时切换发生在午夜"的时区（巴西/智利一类）会落到 01:00 ——
 * 行为无害（`dueCards` 两边都 `startOfDay`），但别把上面那句当"永远是 0 点"读。
 */
export function addDays(ts: number, days: number): number {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * 复习一张卡之后的新卡（**纯函数** —— 判据断得清的那一半；写盘在 `ReviewStore.grade`）。
 *
 * | 档 | 效果 |
 * |---|---|
 * | 记住 | `interval = 原为 1 ? 3 : 原 × 2`（**1 → 3 是刻意的**：跳 2 太碎，用户会觉得"怎么又来"）；`reps++` |
 * | 模糊 | `interval` **不变**，只把 `nextReview` 推到 `今天 + interval` |
 * | 忘记 | `interval` 回到 1、`lapses++`，明天再来 |
 *
 * 三档都写 `lastReview = now`（"最近一次复习是什么时候"与档位无关）。
 * ⚠️ 只改这几格：正面/背面/来源/createdAt 一个字节不动（用例逐字段比）。
 */
export function applyGrade(card: ReviewCard, grade: ReviewGrade, now: number): ReviewCard {
  const base: ReviewCard = { ...card, lastReview: now };
  if (grade === 'remember') {
    const interval = card.interval <= 1 ? 3 : card.interval * 2;
    return { ...base, interval, reps: card.reps + 1, nextReview: addDays(now, interval) };
  }
  if (grade === 'fuzzy') {
    return { ...base, nextReview: addDays(now, card.interval) };
  }
  return { ...base, interval: 1, lapses: card.lapses + 1, nextReview: addDays(now, 1) };
}

// ────────────────────────────────────────────────────────────────
// 读写的口子
// ────────────────────────────────────────────────────────────────

/**
 * **文件读不动 → 拒绝写**（独立审 2026-10-10 🔴 抓的）。
 *
 * 为什么要有这个类型，而不是"静默当空表处理"：`复习.json` 是**用户数据**，而且被鼓励手改
 *（面板头就写着「库内文件：…」）。解析失败时若照空表往下走，一次 read-modify-write 就会
 * 拼出整份新文件、**把用户所有卡片抹掉**。宁可让这次写失败、把原因报出来。
 */
export class ReviewRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ReviewRefusedError';
  }
}

export class ReviewStore {
  private app: App;
  private configs: ConfigFiles;

  /**
   * **写的串行队列**（独立审 2026-10-10 🔴 抓的）：改名/删除是**平台事件流驱动**的 ——
   * 批量搬 N 篇 = N 个 rename 事件紧挨着来，而每个处理都是
   * "异步 load() → 拼整份数组 → 整文件 write()" 的 read-modify-write。没有队列的话，
   * 多份 read 会落在第一次 write 之前 → **只有最后一次迁键保住**，其余卡片指空
   *（更重的：用户此刻新建的卡会被整份覆盖掉）。
   * `SettingsStore.save` 早就把写入串行化了（本仓记过那条账），这是同一条账的第二处；
   * 队列放在本 store 里 —— 不动 `ConfigFiles` 的公共语义。
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(app: App, configs: ConfigFiles) {
    this.app = app;
    this.configs = configs;
  }

  /** 把一次「读—改—写」排进队列；前一个失败也要继续（`then(fn, fn)`） */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** 动笔之前先确认"这个文件能不能动"：坏了就抛（调用方把它报出来） */
  private async writable(): Promise<ReviewFile> {
    const res = await this.loadDetailed();
    if (res.broken) throw new ReviewRefusedError(res.broken);
    return res.file;
  }

  /** 库内那个文件的路径（相对库根）—— 面板里"这个文件在哪儿"要用真路径 */
  path(): string {
    return this.configs.pathOf('review');
  }

  /**
   * 读 + **把"文件坏了"这件事带出来**（`broken` 非空 = 存在但读不动）。
   * ⚠️ 与 `exists: false`（还没建）**必须区别对待**：坏的**不许写**。
   * 这里不抛 —— 面板要能画出"这个文件坏了"那行，而不是整块白掉。
   */
  async loadDetailed(): Promise<{ file: ReviewFile; exists: boolean; broken: string | null }> {
    const r = await this.configs.readDetailed<ReviewFile>('review');
    const cards = Array.isArray(r.data?.cards) ? r.data.cards : [];
    /**
     * **version 也要认**：文件头写着"将来要能按版本迁移" —— 读到不认识的 version 时
     * 当"读不动"处理（既不按 v1 解释，更不许把它降级写回 v1）。真要迁移时在这儿加。
     */
    const raw = r.data as { version?: unknown } | null;
    const badVersion =
      r.broken == null && raw?.version !== 1
        ? `文件里的 version 是 ${JSON.stringify(raw?.version)}（这一版只认 1）`
        : null;
    /**
     * ⚠️ **version 不认识时，连卡都不许带出来**（独立审 🟡5）：`r.data` 那个对象照读不误
     * （比如 `{"version":2,"cards":[…数百张…]}`）—— 面板会把「读不出来」那行画在列表位，
     * 但**头部与右键菜单的「已有 N 张」会照那些卡报数**（"不按 v1 解释"的自我约束只做了一半）。
     * 所以坏版本一律回空表：读不动就是读不动，报表也只报"坏"。
     */
    const safeCards = badVersion == null ? cards : [];
    return { file: { version: 1, cards: safeCards }, exists: r.exists, broken: r.broken ?? badVersion };
  }

  /** 读（文件不存在 → 空表，**不写盘**；坏的也返回空表 —— 写的那一侧由 `writable()` 拦） */
  async load(): Promise<ReviewFile> {
    return (await this.loadDetailed()).file;
  }

  /**
   * 同步读缓存（菜单那一帧要用；**没热过就 null**，调用方按"先不画"处理）。
   * ⚠️ **version 也要认**（独立审 🟡5）：缓存的可能是插件之外写进来的 v2 文件 ——
   * 同 loadDetailed 的口径，不认识的版本一律当"没热过"（菜单不报数，别拿 v1 解释它）。
   */
  cached(): ReviewFile | null {
    const raw = this.configs.cached<ReviewFile>('review');
    if (!raw || raw.version !== 1 || !Array.isArray(raw.cards)) return null;
    return { version: 1, cards: raw.cards };
  }

  /** 某篇笔记身上的卡片（菜单要显示"已建 N 张"） */
  cardsOf(file: ReviewFile | null, notePath: string): ReviewCard[] {
    return (file?.cards ?? []).filter((c) => c.note === notePath);
  }

  /** 加一张卡（**第一次落盘由这里负责**：`configs.write` 会建目录 + 建文件） */
  async addCard(input: {
    note: string;
    front: string;
    back: string;
    now?: number;
  }): Promise<ReviewCard> {
    return this.serial(async () => {
      const file = await this.writable();
      const card = newCard(input.note, input.front, input.back, input.now ?? Date.now());
      const next: ReviewFile = { version: 1, cards: [...file.cards, card] };
      await this.configs.write('review', next);
      return card;
    });
  }

  /**
   * **批量加卡**（P8 期 4）：AI 生成那种"一次进好几张"的走它 ——
   * 逐张 `addCard` 会写 N 次盘（每次都整文件替换），既吵又多 N 倍的丢更新窗口。
   * 传空数组 = 什么都不做（**连盘都不写**）。
   */
  async addCards(
    inputs: { note: string; front: string; back: string; now?: number }[],
  ): Promise<ReviewCard[]> {
    return this.serial(async () => {
      if (inputs.length === 0) return [];
      const file = await this.writable();
      const at = Date.now();
      const made = inputs.map((i) => newCard(i.note, i.front, i.back, i.now ?? at));
      await this.configs.write('review', { version: 1, cards: [...file.cards, ...made] });
      return made;
    });
  }

  /** 删一张卡（返回是否真删掉了） */
  async removeCard(id: string): Promise<boolean> {
    return this.serial(async () => {
      const file = await this.writable();
      const next = file.cards.filter((c) => c.id !== id);
      if (next.length === file.cards.length) return false;
      await this.configs.write('review', { version: 1, cards: next });
      return true;
    });
  }

  /**
   * **复习一张卡**（P8 期 3）：按档位推进间隔并落盘，返回更新后的那张卡
   *（找不到这个 id → `null`，不写盘）。
   *
   * 走同一条串行队列：复习一屏一屏地做，而"改名迁键"很可能同时在外头发生
   *（用户切出去改个名字再回来继续复习）—— 两条路都得排同一条队，否则一定丢更新。
   */
  async grade(id: string, grade: ReviewGrade, now?: number): Promise<ReviewCard | null> {
    return this.serial(async () => {
      const file = await this.writable();
      const at = now ?? Date.now();
      let updated: ReviewCard | null = null;
      const cards = file.cards.map((c) => {
        if (c.id !== id) return c;
        updated = applyGrade(c, grade, at);
        return updated;
      });
      if (!updated) return null;
      await this.configs.write('review', { version: 1, cards });
      return updated;
    });
  }

  /**
   * 改名/搬移的迁键（`main.ts` 的 `vault.on('rename')` 调）。
   * **没命中就不写盘** —— 用例钉着"不改名时不许动"。
   */
  async remapNote(oldPath: string, newPath: string): Promise<number> {
    return this.serial(async () => {
      const file = await this.writable();
      const next = remapCards(file.cards, oldPath, newPath);
      if (sameCards(file.cards, next)) return 0;
      await this.configs.write('review', { version: 1, cards: next });
      const before = new Map(file.cards.map((c) => [c.id, c.note]));
      return next.filter((c) => before.get(c.id) !== c.note).length;
    });
  }

  /** 笔记被删 → 剪掉它的卡片（没命中不写盘） */
  async pruneNote(removed: string): Promise<number> {
    return this.serial(async () => {
      const file = await this.writable();
      const next = pruneCards(file.cards, removed);
      if (next.length === file.cards.length) return 0;
      await this.configs.write('review', { version: 1, cards: next });
      return file.cards.length - next.length;
    });
  }

  /** 这些卡片指向的笔记**现在还在不在**（面板要标出"来源已不在"那种卡） */
  missingNotes(file: ReviewFile | null): Set<string> {
    const missing = new Set<string>();
    for (const c of file?.cards ?? []) {
      if (!(this.app.vault.getAbstractFileByPath(c.note) instanceof TFile)) missing.add(c.note);
    }
    return missing;
  }

  /** 面板头部那行「库内文件：…」用的短路径 */
  displayPath(): string {
    return this.path();
  }
}

/** 供面板/菜单拼文案：来源笔记的短名（`01_新知识库/02_Areas/内容创作/x.md` → `x`） */
export function noteLabel(notePath: string): string {
  const base = notePath.split('/').pop() ?? notePath;
  return base.replace(/\.md$/i, '');
}
