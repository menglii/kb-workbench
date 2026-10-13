/**
 * modules/notes/filters.ts —— 搜索与筛选（**纯逻辑**，交互规格 §3.6）
 *
 * 三条口径：
 *  ① **搜索与筛选是叠加的**：先筛选，再在结果里搜。
 *  ② 筛选是**多条件 AND**。
 *  ③ 隐藏笔记（`隐藏: true`）不特殊对待 —— 默认照常列出（这是管理屏，
 *     东西不能凭空消失），要只看/排除它在筛选面板里选。
 *
 * 纯函数放这里的原因：表格与批量栏都要用它，"选中但被筛掉"的计数、
 * 首页跳过来的预筛选，全靠同一份口径（两处各写一遍必漂）。
 */
import type { HealthFlag, NoteEntry } from '../../core/vault-index';
import { asList, asString, asBool } from '../../services/schema';
import type { SearchScope } from '../../core/settings';

export interface FilterSet {
  /** 标签（任一命中即可，组内 OR） */
  tags: string[];
  /** 类型 */
  types: string[];
  /** 状态 */
  statuses: string[];
  /** 健康标记（任一命中） */
  health: HealthFlag[];
  /** 隐藏笔记：照常显示 / 只看隐藏 / 排除隐藏 */
  hidden: 'show' | 'only' | 'exclude';
  /**
   * **创建日期**（P7.12 · 合集 21.5，裸写档）：`''` = 不过滤；否则是
   * `2026` / `2026-10` / `2026-W41` / `2026-10-06` 之一（粒度由写法本身承载）。
   * 解析与匹配与搜索框**同一份**（`parseDateTerm` / `dateHitOf`）——
   * "2026 是什么意思"只许有一种解释。
   */
  created: string;
  /** 预筛选：只列这几篇（首页「筛选这几个文件」）；null = 不按路径筛 */
  paths: string[] | null;
}

export function emptyFilters(): FilterSet {
  return { tags: [], types: [], statuses: [], health: [], hidden: 'show', created: '', paths: null };
}

export function hasAnyFilter(f: FilterSet): boolean {
  return (
    f.tags.length > 0 ||
    f.types.length > 0 ||
    f.statuses.length > 0 ||
    f.health.length > 0 ||
    f.hidden !== 'show' ||
    f.created !== '' ||
    f.paths != null
  );
}

/**
 * 目录归属：该条目**就在这一层**吗（**不递归**，P6b ② 改成 Windows 式）。
 *
 * 🔴 **口径在 P6b 变了**（用户 2026-09-27 原话："网格视图单个文件要**在文件夹中**，
 * 点击文件夹才能看到进一步的子文件夹和其他文件；左键双击打开…参考 windows"）：
 * 原先这里是**递归**的，"整个知识库"那一层把 190 篇全倒出来 —— **层级是假的**。
 * 现在当前层 = 本层笔记 + 直接子目录（`foldersFor` 给），与资源管理器一致。
 *
 * ⚠️ **连带**：表格档跟着一起变（同一个目录、两档必须同集合 —— 它们在
 * `computeVisible` 里共用这一条判据）；搜索/筛选不受影响（那是另一条轴）。
 * ⚠️ **看板的板块源另有一份递归的 `inDir`**（`modules/board/sources.ts`，语义是
 * "这个目录下（含子目录）的笔记都收进来"）—— 那是**板块选材**、不是导航，别一起改。
 * ⚠️ 拖动落点的预告（`notes/index.ts` 的 `dropInfo`）**用的是 `underDir`（递归）**，
 * 🔴 **别把这里改成 `inDir`**（独立审查 A🔴1 抓过）：那条预告的 `from` 是树上节点的
 * **含子目录**数 —— 基准与增量必须同口径，否则"从子目录拖到祖先目录"会多报 N。
 */
export function inDir(entry: NoteEntry, dir: string): boolean {
  return entry.effectivePosition === dir;
}

/** 该条目在不在这个目录**之下**（含子目录、含自己）—— 递归口径，"往下找"时用 */
export function underDir(entry: NoteEntry, dir: string): boolean {
  if (!dir) return true;
  return entry.effectivePosition === dir || entry.effectivePosition.startsWith(`${dir}/`);
}

/**
 * 这次查询是"**逐层逛**"还是"**往下找**"（P6b ②）。
 *
 * 🔴 两条轴要分开（这是本轮改口径时最容易想拧的一处）：
 *  · **浏览**（没有搜索词、没有筛选）= 资源管理器：只看本层 + 子目录格子（`inDir`）；
 *  · **找东西**（有搜索词或有筛选）= **在当前目录里往下找**（`underDir`，递归）——
 *    与 Windows 一致（在资源管理器里搜索是搜**整棵子树**），也符合直觉：
 *    "搜一个笔记名"却因为它躺在子目录里就搜不到，那叫坏了。
 *
 * ⚠️ 不这么分的话，"在某一层搜东西"会搜不出子目录里的命中 ——
 * 集成用例与真机都会当场看出"搜索坏了"。**P7.1b 反转根层递归之后，这一条尤其是根层
 * 唯一的"看得见深层文件"的路径**（浏览态根层只剩本层 + 文件夹，搜索/筛选必须照旧往下找）。
 */
export function isDeepQuery(q: { search: string; filters: FilterSet }): boolean {
  return q.search.trim() !== '' || hasAnyFilter(q.filters);
}

// ────────────────────────────────────────────────────────────────
// 日期粒度搜索（P7.12 · 合集 21.5「裸写」档）——**解析 / 匹配的唯一一份**
// ────────────────────────────────────────────────────────────────
/**
 * 口径（2026-10-06 拍定，别再发明第二条）：
 *   · 裸写 `2026` → 该年 · `2026-10` → 该月 · `2026-W41` → 该周（**ISO，周一起算**，
 *     跨年周按 ISO 归属）· `2026-10-06` → 当日；混写 `2026-10 计划` = 当月 × 含「计划」；
 *   · 引号 `"2026"` 强制**按字面文字搜**（想搜正文里的 "2026" 就给它加引号）；
 *   · 年月周日按**本地时区自然边界**；
 *   · **写坏了就是文字**：`2026-13` / `2026-02-30` / `2026-W99` 不是日期 →
 *     整条查询照旧走文字搜（不做"猜一半"）。
 *
 * 三条"为什么"：
 *   · 匹配取 `创建日期` 属性（"2026 年创建的"），**不看 mtime** —— 两者的语义差着一次编辑；
 *   · 日期词与文字词是 **AND** 关系（混写那行）；引号段里的日期词**永不**当日期解释；
 *   · 粒度由**写法本身**承载（没有"先选粒度再填值"的第二套输入）。
 */
export type DateGran = 'year' | 'month' | 'week' | 'day';

export interface DateTerm {
  gran: DateGran;
  /** 年（week 档是 **ISO 周年**，不是自然年） */
  y: number;
  /** 月（1–12；month/day 档有） */
  m?: number;
  /** 日（1–31；day 档有） */
  d?: number;
  /** ISO 周号（1–53；week 档有） */
  w?: number;
}

/** 真日期校验（`2026-02-30` 这类"格式对但不存在"的不认） */
function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 某天的 **ISO 周**（周年 + 周号；周一起算，跨年周归年头那一边）。
 * 算法：挪到本周的周四（ISO 定义的"归属日"），它落在哪一年就是周年；
 * 周号 = (周四 − 该年 1/1) / 7 **向下取整** + 1。
 * ⚠️ 必须是 floor —— 固定盘抓过：写成 ceil 时"周四差值不被 7 整除"的年份会多算一周
 *（2027 实际 52 周，ceil 版给 53）。
 */
export function isoWeekOf(y: number, m: number, d: number): { y: number; w: number } {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7; // 周一=1 … 周日=7
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum); // 本周四
  const wy = dt.getUTCFullYear();
  const yearStart = Date.UTC(wy, 0, 1);
  const w = Math.floor((dt.getTime() - yearStart) / 86400000 / 7) + 1;
  return { y: wy, w };
}

/** 这一 ISO 周年有几周（12-28 永远落在最后一周 —— ISO 的常识） */
export function weeksInIsoYear(y: number): number {
  return isoWeekOf(y, 12, 28).w;
}

/** 一枚**裸写**词 → 日期词；不是合法日期（含写坏）→ `null`（调用方降级为文字搜） */
export function parseDateTerm(token: string): DateTerm | null {
  const t = token.trim();
  let m = /^(\d{4})$/.exec(t);
  if (m) return { gran: 'year', y: Number(m[1]) };
  m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m) {
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return { gran: 'month', y: Number(m[1]), m: mo };
    return null;
  }
  m = /^(\d{4})-([Ww])(\d{2})$/.exec(t);
  if (m) {
    const y = Number(m[1]);
    const w = Number(m[3]);
    if (w >= 1 && w <= weeksInIsoYear(y)) return { gran: 'week', y, w };
    return null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (isRealDate(y, mo, d)) return { gran: 'day', y, m: mo, d };
    return null;
  }
  return null;
}

/** 给人看的一句解释（筛选面板的即时提示 / 测试断言共用） */
export function describeDateTerm(term: DateTerm): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  if (term.gran === 'year') return `${term.y} 年（全年）`;
  if (term.gran === 'month') return `${term.y} 年 ${term.m} 月`;
  if (term.gran === 'week') return `${term.y} 年第 ${term.w} 周（周一起算）`;
  return `${term.y}-${p2(term.m ?? 1)}-${p2(term.d ?? 1)}`;
}

/**
 * 日期词 × 一篇笔记：命中看 `创建日期` 的**前导 ISO 日期**。
 * 值写坏（如占位符没被替换）→ 不命中任何日期词（它本来就不该冒充日期）。
 * week 档要完整日期才算得出来 —— 只有"2026-10"这种半截值时不命中周查询。
 */
export function dateHitOf(entry: NoteEntry, term: DateTerm): boolean {
  const raw = asString(entry.props['创建日期']).trim();
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(raw);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = m[2] !== undefined ? Number(m[2]) : null;
  const d = m[3] !== undefined ? Number(m[3]) : null;
  switch (term.gran) {
    case 'year':
      return y === term.y;
    case 'month':
      return y === term.y && mo === term.m;
    case 'week': {
      if (mo === null || d === null) return false;
      const wk = isoWeekOf(y, mo, d);
      return wk.y === term.y && wk.w === term.w;
    }
    case 'day':
      return y === term.y && mo === term.m && d === term.d;
  }
}

/**
 * 把一条查询词拆成 **{ 日期词, 文字词 }**（搜索框与筛选面板共用的唯一入口）。
 *
 * 规则（对表见上面的口径注释）：
 *   · 引号段（`"…"`）里的内容**只当文字**（引号本身剥掉）；
 *   · 非引号段里找**第一枚**合法裸写日期词，把它摘出来当日期条件；
 *   · 剩下的（含所有引号段内容）拼成文字词 —— 空串 = 没有文字条件。
 * 边界：`2026-10-6`（非两位日）/ `2026-13` / 被包在更长的数字串里（`12026`）——
 * 都不是日期词，整条查询原样当文字。
 */
export function splitDateQuery(raw: string): { date: DateTerm | null; text: string } {
  const s = String(raw ?? '');
  const segs: { quoted: boolean; text: string }[] = [];
  let i = 0;
  while (i < s.length) {
    const q = s.indexOf('"', i);
    if (q < 0) {
      segs.push({ quoted: false, text: s.slice(i) });
      break;
    }
    if (q > i) segs.push({ quoted: false, text: s.slice(i, q) });
    const close = s.indexOf('"', q + 1);
    if (close < 0) {
      // 没闭合的引号：整段照文字（不猜）
      segs.push({ quoted: true, text: s.slice(q + 1) });
      break;
    }
    segs.push({ quoted: true, text: s.slice(q + 1, close) });
    i = close + 1;
  }

  let date: DateTerm | null = null;
  const parts: string[] = [];
  for (const seg of segs) {
    if (seg.quoted || date !== null) {
      parts.push(seg.text);
      continue;
    }
    // 候选取最长（`2026-10-06` 优先于 `2026-10`），前后不许接数字/连字符
    const re = /\d{4}(?:-(?:\d{2}|[Ww]\d{2})(?:-\d{2})?)?/g;
    let cut: { start: number; end: number } | null = null;
    for (let m = re.exec(seg.text); m !== null; m = re.exec(seg.text)) {
      const before = m.index > 0 ? seg.text[m.index - 1] : '';
      const after = seg.text[m.index + m[0].length] ?? '';
      if (/[\d-]/.test(before) || /[\d-]/.test(after)) continue;
      if (parseDateTerm(m[0]) !== null) {
        cut = { start: m.index, end: m.index + m[0].length };
        break;
      }
    }
    if (cut) {
      date = parseDateTerm(seg.text.slice(cut.start, cut.end));
      parts.push(seg.text.slice(0, cut.start) + ' ' + seg.text.slice(cut.end));
    } else {
      parts.push(seg.text);
    }
  }
  return { date, text: parts.join(' ').replace(/\s+/g, ' ').trim() };
}

/** 本地时区的"现在" → 某粒度的裸写词（列头快捷入口用；与解析器互逆） */
export function dateTokenOf(d: Date, gran: DateGran): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const y = d.getFullYear();
  if (gran === 'year') return String(y);
  const mo = d.getMonth() + 1;
  if (gran === 'month') return `${y}-${p2(mo)}`;
  if (gran === 'day') return `${y}-${p2(mo)}-${p2(d.getDate())}`;
  const wk = isoWeekOf(y, mo, d.getDate());
  return `${wk.y}-W${p2(wk.w)}`;
}

/*
 * ── 根层的口径：**与其它层同款**（P7.1b，2026-10-03 · 反转 P6⑧）────────────
 * （独立审查 🟢2：这段是**浮动的背景说明**、不属于某个函数的文档 —— 用普通块注释，
 *  别写成 `/**` 挂在 `matchesSearch` 头上。）
 *
 * P6⑧（2026-09-29）曾把根层设成"**永远递归**"（`isRootDir('')` 特例）：当时
 * 详细/紧凑档**画不出文件夹**，"整个知识库"不递归就一篇都看不见
 *（用户报的"点全部笔记后两个档都看不到内容"）。
 *
 * **P7.1b 反转它** —— 成因已消失（详细档有了**文件夹行** 2.2、网格档早有文件夹格），
 * 而代价现形了：网格根层把 99_Meta 等深层 216 篇**平铺在文件夹格旁边**
 *（用户 2026-10-03 截图："本该在文件夹内的文件显示在了外面"），层级是假的、
 * 与 Windows 不一致。
 *
 * 现在**所有层一条口径**：浏览 = 本层笔记 + 直接子文件夹（导航交给它们）；
 * **搜索 / 筛选照旧"往下找"**（`underDir`）——那条轴一个字没动。
 * ⚠️ 连带：面包屑计数（`countText()`）根层也写「本层 N 篇」（`isRootDir` 已整个删除）。
 */

export function matchesSearch(entry: NoteEntry, query: string, scope: SearchScope): boolean {
  /**
   * 🔴 P7.12 · 21.5：先拆日期词（`splitDateQuery` —— 引号段照文字、裸写认日期）。
   * 日期条件是 **AND**（混写 `2026-10 计划` = 当月 × 含「计划」）；只剩日期词时
   * 文字条件为空 = 全通过（此时结果就是"那段时间创建的"）。
   */
  const { date, text } = splitDateQuery(query);
  if (date !== null && !dateHitOf(entry, date)) return false;
  const q = text.toLowerCase();
  if (!q) return true;
  const hit = (s: string): boolean => s.toLowerCase().includes(q);
  if (scope === 'title' || scope === 'all') {
    if (hit(entry.basename) || hit(entry.path)) return true;
  }
  if (scope === 'prop' || scope === 'all') {
    for (const [k, v] of Object.entries(entry.props)) {
      if (hit(k)) return true;
      for (const item of asList(v)) if (hit(item)) return true;
      if (typeof v === 'boolean' && hit(String(v))) return true;
    }
  }
  if (scope === 'tag' || scope === 'all') {
    for (const t of asList(entry.props['tags'])) if (hit(t)) return true;
  }
  return false;
}

export function matchesFilters(entry: NoteEntry, f: FilterSet): boolean {
  if (f.paths != null && !f.paths.includes(entry.path)) return false;
  if (f.types.length > 0 && !f.types.includes(asString(entry.props['类型']))) return false;
  if (f.statuses.length > 0 && !f.statuses.includes(asString(entry.props['状态']))) return false;
  if (f.created !== '') {
    /**
     * 面板只往这里存**合法**日期词（非法的不落，就地给提示）—— 这里再解析一次是
     * "解析只有一份"的代价，也让手改过的状态不至于把列表滤成一片空白：
     * 解析不出来就**当没设**（宁可见多，不可静默滤空）。
     */
    const term = parseDateTerm(f.created);
    if (term !== null && !dateHitOf(entry, term)) return false;
  }
  if (f.tags.length > 0) {
    const tags = asList(entry.props['tags']).map((t) => t.replace(/^#/, ''));
    if (!tags.some((t) => f.tags.includes(t))) return false;
  }
  if (f.health.length > 0 && !f.health.some((h) => entry.flags.includes(h))) return false;
  const hidden = asBool(entry.props['隐藏']);
  if (f.hidden === 'only' && !hidden) return false;
  if (f.hidden === 'exclude' && hidden) return false;
  return true;
}

export type SortDir = 'asc' | 'desc';
export interface SortSpec {
  key: string;
  dir: SortDir;
}

export interface VisibleQuery {
  dir: string;
  search: string;
  scope: SearchScope;
  filters: FilterSet;
  sort: SortSpec | null;
  /** 排序取值：列 id → 取值函数（表格的列定义提供） */
  sortValue: (entry: NoteEntry, key: string) => string | number | null;
  /** 兜底排序（表头没给取值函数时） */
  compareFallback?: (a: NoteEntry, b: NoteEntry) => number;
}

/** 筛选 → 搜索 → 排序（顺序即口径） */
export function computeVisible(entries: NoteEntry[], q: VisibleQuery): NoteEntry[] {
  /**
   * 🔴 **显式清单比目录筛选更具体 —— 有了它就**不看目录**（e2 期真机实测的坑）。
   *
   * `filters.paths` 只有"跳过来看这几篇"这一种用法（首页「筛选这几个文件」、
   * §4.1 快速切换跳笔记）。而目录树的选择是**上一次留下的**：真机上从快速切换跳一篇
   * 在 `99_Meta` 里的笔记时，`treeSelected` 还停在 `00_Inbox` → 列表**一片空白**
   *（"跳过去"跳到了一片空 —— 正是这一期要修的那类体验）。
   *
   * 反过来"跳转顺手改用户的目录选择"也不对：那是**持久化**的界面偏好，
   * 不该被一次跳转悄悄改掉。所以规则落在这儿：**显式给的那几篇，不再过目录这一道**。
   */
  const byDir = q.filters.paths == null;
  /**
   * 浏览 = 本层；找东西（搜索/筛选）= 往下找（见 `isDeepQuery`）。
   * ⚠️ **P7.1b 起根层也在"浏览 = 本层"里** —— P6⑧ 那个"根层永远递归"的
   * `isRootDir` 特例已反转（来龙去脉见 `underDir` 与 `isDeepQuery` 之间的那段）。
   */
  const dirHit = isDeepQuery({ search: q.search, filters: q.filters }) ? underDir : inDir;
  const out = entries.filter(
    (e) =>
      (!byDir || dirHit(e, q.dir)) &&
      matchesFilters(e, q.filters) &&
      matchesSearch(e, q.search, q.scope),
  );
  const spec = q.sort;
  if (!spec) {
    out.sort(q.compareFallback ?? ((a, b) => a.basename.localeCompare(b.basename, 'zh')));
    return out;
  }
  const dir = spec.dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    const va = q.sortValue(a, spec.key);
    const vb = q.sortValue(b, spec.key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // 空值永远排末尾（不随方向翻）
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'zh') * dir;
  });
  return out;
}

/** 当前生效的筛选条数（工具栏上的徽标用；目录与搜索不算） */
export function activeFilterCount(f: FilterSet): number {
  let n = 0;
  if (f.tags.length > 0) n += 1;
  if (f.types.length > 0) n += 1;
  if (f.statuses.length > 0) n += 1;
  if (f.health.length > 0) n += 1;
  if (f.hidden !== 'show') n += 1;
  if (f.created !== '') n += 1;
  if (f.paths != null) n += 1;
  return n;
}
