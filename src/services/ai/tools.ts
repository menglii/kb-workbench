/**
 * services/ai/tools.ts —— agent 的**工具定义层**（P7.3b · 交互规格 §11 工具表）
 *
 * 这里只有**数据与纯函数**：工具名、类别、默认档位、参数校验、给人看的一行摘要。
 * 🔴 **没有执行体、import 不到 `ui/` / `modules/` / `mover`**（`tests/specs/redline.ts`
 * 有静态断言钉着）。真正动手的在 `ui/ai-tools.ts` 的 ToolPort 实现里
 * —— 与确认流同一层，动库一律过 `ui/confirm.ts` + `mover` / `fm` / `completion`。
 *
 * ## 为什么工具是"数据"而不是函数
 *
 * 3c 的 skill 机制（能力包 = 指令 + 工具白名单 + 触发词）直接吃这张表：
 * skill 想收窄能力，就是把这里的一组名字列进白名单。执行体不随 skill 走 ——
 * 这是"skills = 数据，不是代码"那句话在这份文件上的落点。
 *
 * ## 三档（禁 / 需确认 / 自动）的默认值
 *
 * 2026-10-02 G4-C3 拍板：**读/搜=自动 · 改属性/标签/新建/搬=需确认 · 删=需确认**
 * （用户改动过建议：删不是"禁"，是确认后可执行）。
 * **P7.22a**：新类「改正文」（`patch_text` / `append`）照旧「需确认」（G9 拍板）；
 * `rename` 归「搬动文件」类。**改这张表 = 改契约**。
 *
 * ⚠️ **写类的「自动」= 自动弹确认框**（不是跳过确认）—— 沿用 §11.2 已拍的口径：
 * 省的是"先点执行"那一步，`ui/confirm.ts` 那一道照旧。红线例外只有拖拽一条。
 */
import { baseName, parentDir, stripExt } from '../../core/paths';

/** 模型能调的工具名（改这里 = 改契约，`交互规格` §11 那张表同步改） */
export type AiToolName =
  | 'search'
  | 'read'
  | 'grep'
  | 'list'
  | 'stats'
  | 'ask_user'
  // 服务族：P7.22b 出提案 + 开面板（L1）→ P7.24 L2：跑到确认卡、用户点完把结算带回来（见 AiToolOutcome.settled）
  | 'suggest'
  | 'triage'
  | 'cleanup'
  | 'set_prop'
  | 'set_tags'
  | 'create'
  | 'move'
  | 'delete'
  | 'rename'
  | 'patch_text'
  | 'append';

/** 权限**类别**（档位按类别配，不按工具 —— 17 个工具收成 7 类） */
export type AiToolClass = 'read' | 'prop' | 'tag' | 'create' | 'move' | 'delete' | 'text';

export type AiToolTier = 'off' | 'confirm' | 'auto';

/** 类别 → 中文（设置面板 3c 用；判据用 id 不认文案） */
export const AI_TOOL_CLASSES: { id: AiToolClass; label: string; hint: string }[] = [
  { id: 'read', label: '读与搜索', hint: '查目录、搜笔记、读正文' },
  { id: 'prop', label: '改属性', hint: '改一篇前言里的某个属性' },
  { id: 'tag', label: '改标签', hint: '加/减 tags' },
  { id: 'create', label: '新建笔记', hint: '在某个目录下新建一篇' },
  { id: 'move', label: '搬动文件', hint: '把笔记移到别的目录或改名' },
  { id: 'delete', label: '删除', hint: '删到回收站' },
  { id: 'text', label: '改正文', hint: '改一篇的正文（替换一段 / 末尾追加）' },
];

/**
 * 每个工具属于哪一类（档位看类别）。
 * ⚠️ `list` / `stats` / `ask_user` / `grep` 都归「读与搜索」（自动档）；
 * ⚠️ `rename` 归「搬动文件」（纯改名也算搬动 —— P7.18b 守卫照旧）；
 * ⚠️ `patch_text` / `append` 归 **`text`（P7.22a 新类）**："改正文"与"改属性"用户心智不同。
 */
export const AI_TOOL_CLASS_OF: Record<AiToolName, AiToolClass> = {
  search: 'read',
  read: 'read',
  grep: 'read',
  list: 'read',
  stats: 'read',
  ask_user: 'read',
  /**
   * P7.22b · #2 服务族三个工具归「读·搜」（自动档）—— 理由（写进冻结）：
   * **打开面板本身零写库**（动库仍走各面板自己的确认流）；对了要的"收窄只做减法"照旧。
   */
  suggest: 'read',
  triage: 'read',
  cleanup: 'read',
  set_prop: 'prop',
  set_tags: 'tag',
  create: 'create',
  move: 'move',
  delete: 'delete',
  rename: 'move',
  patch_text: 'text',
  append: 'text',
};

export const AI_TOOL_NAMES = Object.keys(AI_TOOL_CLASS_OF) as AiToolName[];

export function isAiToolName(v: unknown): v is AiToolName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AI_TOOL_CLASS_OF, v);
}

/**
 * 提示词里那一行**工具目录**（P7.3c 从 `prompt.ts` 搬来，搬的理由是"改工具表 = 改契约"：
 * 名字、类别、说明本来就该在同一份数据里）。skill 收窄白名单时按它过滤。
 * ⚠️ 文案里出现的路径口径是**相对库根**（与 `validateCall` 的归一同一口径）。
 */
export const AI_TOOL_DOC: Record<AiToolName, string> = {
  search:
    '{"tool":"search","args":{"query":"关键词（可空）","dir":"可选：限定目录"}} —— 搜标题/路径/属性（**不搜正文** —— 找正文里的词用 grep），返回候选',
  read: '{"tool":"read","args":{"path":"…"}} —— 读这一篇的属性与正文',
  grep:
    '{"tool":"grep","args":{"query":"要搜的词","dir":"可选：限定目录"}} —— 搜笔记正文（含前言）：逐篇现扫，回命中片段（哪篇、第几行、一句上下文）',
  list:
    '{"tool":"list","args":{"dir":"可选：相对库根的目录（空 = 本次对话的工作目录，没设就是库根）","recursive":false}} —— 列目录结构：每层篇数 + 本层笔记名（recursive=true 往下多层）',
  stats: '{"tool":"stats","args":{}} —— 库概览：共多少篇 / 最近改动 / 待处理几项',
  ask_user:
    '{"tool":"ask_user","args":{"question":"要问用户的一句话"}} —— 缺关键信息时问用户（会暂停等你回答；**单独一步发它**；用户可能跳过）',
  suggest:
    '{"tool":"suggest","args":{}} —— **跑一遍整理流水线**（规则建议 + 可执行的都预勾好）→ **停在确认卡前等用户点执行/取消**；用户点完之后你才会拿到结果（已执行 / 已取消），然后继续',
  triage:
    '{"tool":"triage","args":{"dir":"可选：限定目录（空 = 本次对话的工作目录，没设就是整个库）"}} —— **跑一遍 AI 分诊**（与首页「待处理」同一条入口）→ 停在确认卡前等用户点；结果（已执行 / 已取消）回来之后继续',
  cleanup:
    '{"tool":"cleanup","args":{"keys":"可选：要清哪些属性键（缺省 = 全部可清的键）","feet":false}} —— **跑一遍退出清理**（笔记属性键 / 可选足迹）→ 停在确认卡前（危险二段确认照旧）等用户点；默认**只预勾属性键**（有快照可还原），足迹（含不可逆面）要显式 feet:true、样例永不预勾',
  set_prop:
    '{"tool":"set_prop","args":{"path":"…","key":"状态","value":"进行中"}} —— 改一个属性（value 给 null = 删掉）',
  set_tags:
    '{"tool":"set_tags","args":{"path":"…","add":["标签A"],"remove":["标签B"]}} —— 加减 tags（可只给一边）',
  create: '{"tool":"create","args":{"dir":"00_Inbox","title":"标题","body":"可选正文"}} —— 新建一篇',
  move: '{"tool":"move","args":{"path":"…","to":"目标目录","why":"一句话理由"}} —— 搬到别的目录',
  delete: '{"tool":"delete","args":{"path":"…"}} —— 删除到回收站',
  rename:
    '{"tool":"rename","args":{"path":"…","name":"新名字"}} —— 重命名这一篇（**只改文件名，不碰目录与 .md**；双链会跟着改）。name 别带目录、别带扩展名',
  patch_text:
    '{"tool":"patch_text","args":{"path":"…","find":"要替换的原文","replace":"换成什么（给空串 = 删掉这一段）"}} —— 改正文：find 必须**原文照抄**（含标点），命中恰好 1 处才改（0 处或不止 1 处都不写）——拿不准就多抄几个字让它唯一',
  append:
    '{"tool":"append","args":{"path":"…","content":"要追加的内容"}} —— 在正文**末尾**追加一段（文末已有同样内容时不会重复加）',
};

/** 默认档位（G4-C3 拍板；P7.22a 加 `text` 类——照旧「需确认」）。⚠️ 改它 = 改契约 */
export const DEFAULT_TOOL_TIERS: Record<AiToolClass, AiToolTier> = {
  read: 'auto',
  prop: 'confirm',
  tag: 'confirm',
  create: 'confirm',
  move: 'confirm',
  delete: 'confirm',
  text: 'confirm',
};

/**
 * 当前这一档到底是哪一档（唯一取值处）。
 *
 * 口径：**显式配置 > 默认表**（两句）。
 * ⚠️ **P7.5 起没有第三句了**：旧的 `allowWrite` 粗档开关已退役（8.1 体检拍板）——
 * 它当年就是"没设过的类别跟随它"的兜底，逐类设置已完整覆盖；存量 true 由
 * `migrateSettings()` 的 v4→v5 段映射成逐类等价设置（改属性/标签/新建/搬 → 「自动」）。
 */
export function effectiveTier(
  cls: AiToolClass,
  conf: { toolTiers?: Partial<Record<AiToolClass, AiToolTier>> },
): AiToolTier {
  const explicit = conf.toolTiers?.[cls];
  if (explicit === 'off' || explicit === 'confirm' || explicit === 'auto') return explicit;
  return DEFAULT_TOOL_TIERS[cls];
}

// ────────────────────────────────────────────────────────────────
// 参数形状
// ────────────────────────────────────────────────────────────────
/** 模型提出的一次工具调用（**原始**；过 `validateCall` 之后才是能执行的） */
export interface AiToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** 校验过的调用（`path` / `dir` / `to` 都是**相对库根**口径，已归一） */
export interface AiValidCall {
  tool: AiToolName;
  args: Record<string, unknown>;
}

export type AiCallCheck = { ok: true; call: AiValidCall } | { ok: false; why: string };

/** 字符串参数的上限（模型偶尔会塞一篇文章进来；截断好过拒掉） */
const MAX_ARG_CHARS = 400;

/**
 * **正文写面的长度上限**（`patch_text.replace` / `append.content`）。
 *
 * 🔴 与上面的 `MAX_ARG_CHARS` **反过来**：这里**超了直接拒、绝不截断** ——
 * 参数被截断顶多是"这一条没执行"（模型看得到原因会重试），而**替换内容被截断
 * = 把半截话写进用户的正文**（P7.12 的"超长正文由服务层拒绝"同一条理由：
 * 整篇替换的截断 = 数据丢失）。
 */
const TEXT_ARG_MAX = 4000;
/** `patch_text.find` 的上限（找的原文一般不长；引导它"多抄几个字让命中唯一"） */
const FIND_ARG_MAX = 2000;

/**
 * 相对路径归一 + 形状检查。**只认相对库根的写法**（`00_Inbox/x.md`）——
 * 绝对路径、`..`、驱动器号一律拒（那三类要么是模型胡编，要么是想跳出库）。
 */
function cleanRel(v: unknown): string | null {
  const s = String(v ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (s === '') return null;
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const segs = s.split('/');
  if (segs.some((seg) => seg === '' || seg === '..' || seg === '.')) return null;
  return s;
}

function cleanStr(v: unknown, max = MAX_ARG_CHARS): string {
  return String(v ?? '').trim().slice(0, max);
}

/** 字符串列表（去空、去重、截断），非法项丢掉 */
function cleanList(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const it of v) {
    const s = cleanStr(it, 60);
    if (s !== '' && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 一次调用的参数校验（**纯函数**）。
 *
 * 三条口径：
 *   · **不认识的字段直接丢掉**（17.10① 的落点之一：模型塞 `force:true` / `confirmed:true`
 *     这类"自我授权"的字段**不会进执行体**，也永远不会改变档位）；
 *   · 缺必填 / 形状不对 → `ok:false` + 一句人话（这一条**不执行**，模型会看到原因）；
 *   · 长度截断（模型偶尔把整篇正文塞进 `body`）。
 */
export function validateCall(raw: unknown): AiCallCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: '这一条不是对象' };
  const o = raw as Record<string, unknown>;
  if (!isAiToolName(o.tool)) return { ok: false, why: `不认识的工具「${cleanStr(o.tool, 40) || '（空）'}」` };
  const tool = o.tool;
  const a = (o.args && typeof o.args === 'object' && !Array.isArray(o.args) ? o.args : {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  const needPath = (): string | null => cleanRel(a.path);

  switch (tool) {
    case 'search': {
      const query = cleanStr(a.query, 120);
      const dir = a.dir == null || cleanStr(a.dir) === '' ? '' : cleanRel(a.dir);
      if (dir === null) return { ok: false, why: 'search 的 dir 得是库内相对目录' };
      // query 与 dir 至少有一样（两样都空 = 让我列整个库？那也太宽了，拒）
      if (query === '' && dir === '') return { ok: false, why: 'search 至少给 query 或 dir 一样' };
      args.query = query;
      args.dir = dir ?? '';
      break;
    }
    case 'read':
    case 'delete': {
      const p = needPath();
      if (p === null) return { ok: false, why: `${tool} 要一个相对库根的 path` };
      args.path = p;
      break;
    }
    case 'grep': {
      /** 与 `search` 同款的 dir 口径；`query` 必填（"搜整个库"不是 grep 的语义 —— 那是 search） */
      const query = cleanStr(a.query, 120);
      const dir = a.dir == null || cleanStr(a.dir) === '' ? '' : cleanRel(a.dir);
      if (dir === null) return { ok: false, why: 'grep 的 dir 得是库内相对目录' };
      if (query === '') return { ok: false, why: 'grep 要一个 query（要搜的词）' };
      args.query = query;
      args.dir = dir ?? '';
      break;
    }
    case 'list': {
      /** 与 `search` 的 dir 同口径：空 = 当前层（不含库根本身那条空串……见执行体）；给了必须是库内相对目录 */
      const rawDir = String(a.dir ?? '').trim();
      const dirRel = rawDir === '' ? '' : cleanRel(rawDir);
      if (dirRel === null) return { ok: false, why: 'list 的 dir 得是库内相对目录（空 = 本次对话的工作目录，没设就是库根）' };
      args.dir = dirRel;
      args.recursive = a.recursive === true;
      break;
    }
    case 'stats': {
      // 没有参数（不认识的字段照旧在门口丢掉 —— 上面 args 是新建的干净对象）
      break;
    }
    case 'ask_user': {
      const q = cleanStr(a.question, 300);
      if (q === '') return { ok: false, why: 'ask_user 要一个 question（要说清问用户什么）' };
      args.question = q;
      break;
    }
    case 'suggest': {
      // 无参数（不认识的字段照旧在门口丢掉 —— 上面 args 是新建的干净对象）
      break;
    }
    case 'cleanup': {
      /**
       * **P7.24 · L2**：`keys`（属性键名数组；可省 = 全部可清的键）/ `feet`（布尔；默认 false）。
       * 🔴 独立审 🔴2 修：第一版把 cleanup 并进"无参"分支，模型按 `AI_TOOL_DOC` 发的
       * keys/feet **在门口被吞**（文档承诺与实现互相打架、且无一句"参数被忽略"）。
       * 口径不变：**不自我授权** —— 非法项一律丢掉（键名走 `cleanList` 通用清洗；
       * `feet` 只认严格的 `=== true`）。
       */
      // ⚠️ **只在模型真给了数组时才落 `keys`** —— 缺省要保持"**没给**"语义（执行体按
      // "没给 = 全部可清的键"走）；`cleanList(undefined)` 会落一个 `[]`，把缺省吞成"一个都不要"
      if (Array.isArray(a.keys)) args.keys = cleanList(a.keys, 30);
      args.feet = a.feet === true;
      break;
    }
    case 'triage': {
      /** 与 `list` 的 dir 同口径：空 = 本次对话的工作目录（没设 = 整个库）；给了必须是库内相对目录 */
      const rawDir = String(a.dir ?? '').trim();
      const dirRel = rawDir === '' ? '' : cleanRel(rawDir);
      if (dirRel === null) {
        return { ok: false, why: 'triage 的 dir 得是库内相对目录（空 = 工作目录，没设就是整个库）' };
      }
      args.dir = dirRel;
      break;
    }
    case 'move': {
      const p = needPath();
      const to = cleanRel(a.to);
      if (p === null) return { ok: false, why: 'move 要一个相对库根的 path' };
      if (to === null) return { ok: false, why: 'move 要一个相对库根的 to（落点目录）' };
      args.path = p;
      args.to = to;
      args.why = cleanStr(a.why, 200);
      break;
    }
    case 'set_prop': {
      const p = needPath();
      const key = cleanStr(a.key, 40);
      if (p === null) return { ok: false, why: 'set_prop 要一个相对库根的 path' };
      if (key === '') return { ok: false, why: 'set_prop 要一个 key（属性名）' };
      const v = a.value;
      const okV =
        v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
      if (!okV) return { ok: false, why: 'set_prop 的 value 只能是字符串/数字/布尔或 null（null = 删掉这个属性）' };
      args.path = p;
      args.key = key;
      args.value = typeof v === 'string' ? cleanStr(v) : v;
      break;
    }
    case 'set_tags': {
      const p = needPath();
      const add = cleanList(a.add);
      const remove = cleanList(a.remove);
      if (p === null) return { ok: false, why: 'set_tags 要一个相对库根的 path' };
      if (add.length === 0 && remove.length === 0) return { ok: false, why: 'set_tags 的 add / remove 至少要给一样' };
      args.path = p;
      args.add = add;
      args.remove = remove;
      break;
    }
    case 'create': {
      /**
       * ⚠️ `dir` 允许空串 = **落在库根**（与「新建笔记」对话框的 `dirRel: ''` 同一口径，
       * 独立审查 🟢10 指出两处曾不一致）；`move.to` 那边照旧不许空。
       */
      const rawDir = String(a.dir ?? '').trim();
      const dirRel = rawDir === '' ? '' : cleanRel(rawDir);
      const title = cleanStr(a.title, 80);
      if (dirRel === null) return { ok: false, why: 'create 的 dir 得是库内相对目录（空 = 库根）' };
      if (title === '') return { ok: false, why: 'create 要一个 title' };
      args.dir = dirRel;
      args.title = title;
      args.body = cleanStr(a.body, 4000);
      break;
    }
    case 'rename': {
      /** 只改 basename（不碰目录、不碰 `.md` —— 扩展名由 mover 的 `cleanNewName` 兜） */
      const p = needPath();
      const name = String(a.name ?? '').trim();
      if (p === null) return { ok: false, why: 'rename 要一个相对库根的 path' };
      if (name === '') return { ok: false, why: 'rename 要一个 name（新名字）' };
      if (name.includes('/') || name.includes('\\')) {
        return { ok: false, why: 'rename 的 name 只要文件名部分（不带目录）' };
      }
      if (name.length > 80) return { ok: false, why: 'rename 的 name 太长了（上限 80 字符）' };
      args.path = p;
      args.name = name;
      break;
    }
    case 'patch_text': {
      /**
       * `find` **原文照抄**（含标点/空白，连首尾空白都照原样拿去比对 —— 不做 trim：
       * 用户正文里真有"  "这类片段时，trim 会把合法补丁变成命中不了）；空判用 trim。
       */
      const p = needPath();
      const find = String(a.find ?? '');
      const replace = String(a.replace ?? '');
      if (p === null) return { ok: false, why: 'patch_text 要一个相对库根的 path' };
      if (find.trim() === '') return { ok: false, why: 'patch_text 要一个 find（要找的原文，一字不差地抄）' };
      if (find.length > FIND_ARG_MAX) {
        return { ok: false, why: `patch_text 的 find 太长了（上限 ${FIND_ARG_MAX} 字符）—— 只抄要替换的那一段` };
      }
      if (replace.length > TEXT_ARG_MAX) {
        return {
          ok: false,
          why: `patch_text 的 replace 太长了（上限 ${TEXT_ARG_MAX} 字符）—— 大段改写请用整篇替换那条路（美化笔记）`,
        };
      }
      args.path = p;
      args.find = find;
      args.replace = replace;
      break;
    }
    case 'append': {
      const p = needPath();
      const content = String(a.content ?? '');
      if (p === null) return { ok: false, why: 'append 要一个相对库根的 path' };
      if (content.trim() === '') return { ok: false, why: 'append 要一个 content（要追加的内容）' };
      if (content.length > TEXT_ARG_MAX) {
        return { ok: false, why: `append 的 content 太长了（上限 ${TEXT_ARG_MAX} 字符）` };
      }
      args.path = p;
      args.content = content;
      break;
    }
  }
  return { ok: true, call: { tool, args } };
}

// ────────────────────────────────────────────────────────────────
// 给人看的一行
// ────────────────────────────────────────────────────────────────
/** 待确认卡的一行（面板画它；名字/细节都是纯字符串，别在这层碰 DOM） */
export interface AiCallRow {
  name: string;
  /** 一行动作说明（`A → B` / `状态：旧 → 新` 这种） */
  detail: string;
  why: string;
  /** 危险动作（删除）—— 面板据此标红 */
  danger: boolean;
}

/** 校验过的调用 → 界面上那一行 */
export function rowOfCall(call: AiValidCall): AiCallRow {
  const a = call.args;
  const nameOf = (p: unknown): string => stripExt(baseName(String(p ?? '')));
  switch (call.tool) {
    case 'search':
      return {
        name: '搜索',
        detail: `${String(a.query || '（整个目录）')}${a.dir ? ` · ${String(a.dir)}` : ''}`,
        why: '',
        danger: false,
      };
    case 'read':
      return { name: nameOf(a.path), detail: '读这篇', why: '', danger: false };
    case 'grep':
      return {
        name: '搜正文',
        detail: `${String(a.query || '')}${a.dir ? ` · ${String(a.dir)}` : ''}`,
        why: '',
        danger: false,
      };
    case 'list':
      return {
        name: '列目录',
        detail: `${String(a.dir || '（当前层）')}${a.recursive === true ? ' · 递归' : ''}`,
        why: '',
        danger: false,
      };
    case 'stats':
      return { name: '库概览', detail: '', why: '', danger: false };
    case 'ask_user':
      return { name: '问一句', detail: String(a.question ?? ''), why: '', danger: false };
    case 'suggest':
      return { name: '整理建议', detail: '跑到确认卡（等用户点）', why: '', danger: false };
    case 'triage':
      return {
        name: 'AI 分诊',
        detail: `${String(a.dir || '（工作目录 / 整个库）')} · 跑到确认卡（等用户点）`,
        why: '',
        danger: false,
      };
    case 'cleanup':
      return { name: '待清理', detail: '跑到确认卡（等用户点）', why: '', danger: false };
    case 'move': {
      const from = parentDir(String(a.path)) || '（库根）';
      return { name: nameOf(a.path), detail: `${from} → ${String(a.to)}`, why: String(a.why ?? ''), danger: false };
    }
    case 'set_prop':
      return {
        name: nameOf(a.path),
        detail: `${String(a.key)}：${a.value === null ? '（删掉）' : String(a.value)}`,
        why: '',
        danger: false,
      };
    case 'set_tags': {
      const add = (a.add as string[]) ?? [];
      const rm = (a.remove as string[]) ?? [];
      const parts: string[] = [];
      if (add.length > 0) parts.push(`+${add.join(' +')}`);
      if (rm.length > 0) parts.push(`−${rm.join(' −')}`);
      return { name: nameOf(a.path), detail: `标签 ${parts.join('，')}`, why: '', danger: false };
    }
    case 'create':
      return { name: String(a.title), detail: `新建到 ${String(a.dir)}`, why: '', danger: false };
    case 'rename':
      return { name: nameOf(a.path), detail: `改名 → ${String(a.name ?? '')}`, why: '', danger: false };
    case 'patch_text': {
      const f = oneLine(String(a.find ?? ''));
      const r = oneLine(String(a.replace ?? ''));
      return {
        name: nameOf(a.path),
        detail: r === '' ? `正文删掉一段：${f}` : `正文替换：${f} → ${r}`,
        why: '',
        danger: false,
      };
    }
    case 'append':
      return {
        name: nameOf(a.path),
        detail: `正文末尾追加 ${String(a.content ?? '').length} 字符`,
        why: '',
        danger: false,
      };
    case 'delete':
      return { name: nameOf(a.path), detail: '删除到回收站', why: '', danger: true };
  }
}

/** 待确认卡那一行的摘要用：多行合成单行 + 截断（那一行放不下长文本；`ui/ai-tools.ts` 也拿它拼预览） */
export function oneLine(s: string, max = 24): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 工具结果的形状（ToolPort 的返回；`changed` = 真的动了库） */
export interface AiToolOutcome {
  ok: boolean;
  /** 一行结果（给面板画步骤行，也给模型看） */
  summary: string;
  /** 细节（模型看的；面板放进 title） */
  detail?: string;
  /** 这次调用有没有真的改动库（决定要不要提撤销条之类） */
  changed?: boolean;
  /**
   * **服务族 L2 的结算**（P7.24 · #9/G11 —— 取代 P7.22b 的 `handoff`）：执行体把管线
   * 跑到**确认卡前**停下、等用户点执行/取消之后把结果带回来（见 `ui/confirm.ts` 的
   * `PipeSettle`）。只有两个"用户真的表过态"的值进这里；`empty`（没得跑）/ `blocked`
   * （没配 AI 之类）**不设标记**，如实写在 summary 里。
   * ⚠️ `handoff`（"打开即收尾"）已退役：类型里删掉，`stopped:'handoff'` 只在**老会话
   * 读盘**时还可能遇到（`sessions.ts` 保留该值的读入分支）。
   */
  settled?: 'executed' | 'cancelled';
}

// ────────────────────────────────────────────────────────────────
// 上限（改这一处）
// ────────────────────────────────────────────────────────────────
export const AI_AGENT_LIMITS = {
  /**
   * 一轮最多几步（一次模型回话 = 一步）；到顶就收手并说明。
   * ⚠️ **步数预算口径**（P7.21 · #3 轮内定，写进冻结说明）：
   * `ask_user` **不额外占步数** —— 它是那一步里的一个动作（占 `maxCallsPerStep` 的名额）；
   * **等用户回答的时间不计入任何预算**，也**不设硬超时**：跟随本轮取消（关面板 / 跳过 →
   * 执行体如实回"用户跳过"，别挂死；等回答时那个键是禁用的 —— 与待确认卡同款）。
   */
  maxSteps: 6,
  /**
   * 一步最多执行几个动作（多出来的**不执行**，在结果里说明）。
   * ⚠️ P7.22a 从 12 放宽到 **30**（全权套件的硬瓶颈之一）——「没跑完」的另一半
   * 由面板的「继续」按钮兜（`stopped:'limit'` 收尾处一步续跑）。
   */
  maxCallsPerStep: 30,
  /** read 工具返回的正文上限（字符）。⚠️ P7.22a 4000 → 6000 */
  readChars: 6000,
  /** search 工具最多回几条。⚠️ P7.22a 20 → 50 */
  searchHits: 50,
  /** `grep`（P7.21b · #4）最多回几篇命中（一篇给一段）—— 到顶就**不再往下扫**（如实写"可能还有更多"） */
  grepHits: 10,
  /** `grep` 每段片段的宽度（字符；两头对称剪 + 省略号，命中词尽量居中） */
  grepSnippet: 160,
  /**
   * `grep` 跳过的单文件大小上限（字节）—— 一篇几十万字的笔记扫起来不值当，
   * 跳过并**如实写"跳过了几个大文件"**（静默跳过 = 让模型以为"库里没有"）。
   */
  grepMaxFileBytes: 512 * 1024,
  /** `grep` 现扫缓存最多留几篇的正文（LRU；指纹 = mtime+size，对不上即失效） */
  grepCacheFiles: 200,
  /**
   * `grep` 现扫缓存的**总字符预算**（独立审 G5）：只封条数的话理论最坏 ~100MB
   *（200 篇 × 单文件 512KB）—— 超预算从最旧的开始淘汰；单条超过预算的不进缓存。
   */
  grepCacheChars: 8 * 1024 * 1024,
  /** `ask_user` 回给模型的答案上限（字符；超了截断并在结果里如实写） */
  askChars: 1000,
  /**
   * `list` 工具最多列几行目录（P7.21 · #2；超了如实写"还有 N 个目录没列"）
   */
  listLines: 60,
  /** `list` 工具最多列几个**本层笔记名**（目录结构是重点，笔记名只给个抓手） */
  listNames: 20,
  /** `stats` 工具最多列几条待处理明细（与首页那份规则同源；列不下的写"还有 N 项"） */
  statsTodos: 8,
} as const;
