/**
 * modules/board/capture.ts —— **Quick Capture 的落点解析**（纯函数，P4.5 e2 期 §4.3；
 * **P7.2c 起落点不止板块：第五类「直接选目录」也在这份里**）
 *
 * §4.3 的原话：「全局快捷键（平台级）→ 直接往**指定板块**丢一条，不离开当前工作」。
 *
 * ── 为什么"板块"要解析成"目录 + 属性" ────────────────────────
 * 板块有**四种数据源**（`sources.ts`），而"丢一条"最终只能落到**某个目录**上
 * （平台没有"凭空进板块"这回事）—— 所以口径是：
 *
 * | 源 | 落在哪 | 顺手补什么（这一条才让它**真的出现在那个板块里**） |
 * |---|---|---|
 * | 文件夹 | 就是这个板块的目录 | — |
 * | 标签 | 收件箱 | 并进 `tags`（**并集**：模板已经写了的标签留着） |
 * | 属性值 | 收件箱 | `属性: 值`（**覆盖**：用户显式选了这个落点） |
 * | 收容所 | 收件箱 | — （"谁都没命中"就是它的定义，补了反而进不去） |
 *
 * ⚠️ **属性值源要按"取值"展开成一行一行**：它的板块名 = 属性值（§4.1），
 * 而"往属性值源丢一条"必须说清是**哪个值**（"状态 = 进行中"而不是"状态"）。
 * 取值从索引里现取（`valuesOf`），所以这一层是纯函数 —— 取数由调用方注入。
 *
 * ── 第五类：**直接选目录**（P7.2c · 1.3-b）────────────────────
 * 「没有对应板块、但我知道要哪个目录」是个真实场景（新建笔记一直有落点下拉，
 * 快捕原先没有）。**「普通目录」不是板块**，所以别硬塞进四种源里 ——
 * 它是同一份落点表里的**第五类**（`dirTargets()`），键加 `dir:` 前缀与板块 id 分开
 * （`lastCapture` 只存字符串，撞键就会选错行）。
 * e2 的「落点 = 板块口径」契约**因此回改**为「板块四种源 ＋ 直接选目录」
 *（`交互规格.md` §1.7 同步改过）。
 *
 * ── 为什么这个文件在 `modules/board/`，而用它的是 `ui/quick-capture.ts` ──
 * 它是**看板域**的东西（认的是板块与四种数据源），所以放在 domain 这一侧；
 * 而 `ui/quick-capture.ts` → 本文件是 ui → modules 的**第一处**（P7.2a 起共两处：
 * 第二处是 `ui/settings/home.ts` → `modules/home/blocks`，理由同款——块清单的唯一真源
 * 在 modules 侧）。两处都是**刻意**的：另一个办法是让 `main.ts` 先把候选算好再传进浮层，
 * 但那是"为了层干净而把领域逻辑搬到接线处"。**无环**（本文件只 import `services/schema` 与
 * `./config` 的类型，而 `./config` 只 import `ui/dock`），所以没有循环 import 的风险。
 * ⚠️ 别在这里 import `ui/` 的任何东西（那才会成环）。
 * ⚠️ P7.2c 起 `modules/notes/menus.ts`（笔记右键「丢进板块」）也用它 ——
 * **两处算两遍必漂**，所以只有这一份实现（`noteTargets()` 是给菜单的过滤视图）。
 *
 * ⚠️ **覆盖 vs 并集的那条界线**：用户显式点了"丢进 状态=进行中"，
 * 而模板可能已经写了 `状态: 待办` —— 让位的话就是"点了等于没点"（P4 那类
 * "界面承诺了、代码没做"的老账）。所以**属性覆盖、标签并集**（标签是集合，
 * 覆盖会毁掉模板给的标签），并且**通知里如实报出来**（改了模板什么值）。
 */
import { asString } from '../../services/schema';
import type { BoardConfig, SectionKind } from './config';

export interface CaptureTarget {
  /** 稳定键（记住"上次丢给谁"）：`<板块 id>` 或 `<板块 id>::<取值>` */
  key: string;
  /** 列表里那一行 */
  label: string;
  /** 次要一行：落点 + 会补什么 */
  detail: string;
  kind: SectionKind;
  /** 落点（**相对库根**；`''` = 库根） */
  dirRel: string;
  /** 要写进前言的属性（**覆盖**语义） */
  props: Record<string, unknown>;
  /** 要并进 `tags` 的标签（**并集**语义） */
  tags: string[];
  /** 选不了（属性值源还没有任何取值）——界面上置灰，别让"点了等于没点" */
  disabled?: boolean;
}

export interface CaptureTargetOptions {
  /** 收件箱（相对库根；`''` = 库根）—— 标签 / 属性值 / 收容所三种源的落点 */
  inbox: string;
  /** 某个属性的全部取值（属性值源按它展开；索引里现取） */
  valuesOf: (prop: string) => string[];
}

/** 这个板块能不能当"丢一条"的落点（四种源都能 —— 区别只在落点与补什么） */
export function captureTargets(cfg: BoardConfig, opts: CaptureTargetOptions): CaptureTarget[] {
  const out: CaptureTarget[] = [];
  for (const sec of cfg.sections) {
    if (sec.kind === 'folder') {
      const dirRel = normalizeDir(sec.value);
      out.push({
        key: sec.id,
        label: sec.name,
        detail: `就落在它的目录：${dirRel || '库根'}`,
        kind: sec.kind,
        dirRel,
        props: {},
        tags: [],
      });
      continue;
    }
    if (sec.kind === 'tag') {
      out.push({
        key: sec.id,
        label: sec.name,
        detail: `落在 ${opts.inbox || '库根'}，顺手加上标签 ${sec.value}`,
        kind: sec.kind,
        dirRel: opts.inbox,
        props: {},
        tags: [sec.value],
      });
      continue;
    }
    if (sec.kind === 'prop') {
      const values = opts.valuesOf(sec.value);
      for (const v of values) {
        /**
         * 取值里可能有 `::`（板块 key 的分隔符）—— 记住的键要能还原，所以**转义**掉。
         * 不转义的话 `状态::甲::乙` 会被切成两段（回读时认不出是哪个板块）。
         */
        out.push({
          key: `${sec.id}::${keyOf(v)}`,
          label: `${sec.name} = ${v}`,
          detail: `落在 ${opts.inbox || '库根'}，顺手把 ${sec.value} 改成 ${v}`,
          kind: sec.kind,
          dirRel: opts.inbox,
          props: { [sec.value]: v },
          tags: [],
        });
      }
      if (values.length === 0) {
        /** 一个取值都还没有 → 这一源暂时没有落点（如实说出来，别让它悄悄消失） */
        out.push({
          key: `${sec.id}::`,
          label: `${sec.name}（还没有取值）`,
          detail: `「${sec.value}」还没有任何取值 —— 先在看板上给它建一个`,
          kind: sec.kind,
          dirRel: opts.inbox,
          props: {},
          tags: [],
          disabled: true,
        });
      }
      continue;
    }
    // 收容所：落收件箱，什么都不补（"谁都没命中"就是它的定义）
    out.push({
      key: sec.id,
      label: sec.name,
      detail: `落在 ${opts.inbox || '库根'}（收容所：谁都没命中的都在这儿）`,
      kind: sec.kind,
      dirRel: opts.inbox,
      props: {},
      tags: [],
    });
  }
  return out;
}

/**
 * **第五类落点：直接选目录**（P7.2c · 1.3-b）。
 *
 * 键 = `dir:<相对路径>`（与板块 id 分开 —— `lastCapture` 只存字符串，撞键会选错行）。
 * `kind` 记成 `'folder'`：落点语义就是"去这个目录"（没有别的补料）——
 * 与「文件夹源板块」同一类落点，只是它不是某个板块。
 */
export function dirTargets(dirs: string[]): CaptureTarget[] {
  return dirs.map((raw) => {
    const dirRel = normalizeDir(raw);
    return {
      key: `dir:${dirRel}`,
      label: dirRel || '库根',
      detail: `就落在 ${dirRel || '库根'}（你直接选的那个）`,
      kind: 'folder' as SectionKind,
      dirRel,
      props: {},
      tags: [],
    };
  });
}

/**
 * **第一个"能用的"落点**（跳过置灰行）—— 界面拿它当默认值。
 *
 * 为什么单独一个函数（e2 期独立审查 🟢3）：置灰行（属性值源还没有取值）如果是第一行，
 * 老写法会让它成为默认选中项 —— 用户一按回车只收到"这个落点现在用不了"（白按一次）。
 * 挑默认值是**纯逻辑**，所以放在这一层、能被离线用例钉住。
 */
export function firstUsable(list: CaptureTarget[], key: string | null | undefined): CaptureTarget | null {
  return pickTarget(list.filter((t) => !t.disabled), key);
}

/** 记住的那个键还在不在（板块被删 / 取值没了 → 落回第一个，别拿一个失联的键去写） */
export function pickTarget(list: CaptureTarget[], key: string | null | undefined): CaptureTarget | null {
  if (list.length === 0) return null;
  if (!key) return list[0];
  return list.find((t) => t.key === key) ?? list[0];
}

/** 通知里如实报一句"落在哪、顺手补了什么"（用户要知道它凭什么落进那个板块） */
export function describeTarget(t: CaptureTarget): string {
  const bits: string[] = [`落在 ${t.dirRel || '库根'}`];
  for (const [k, v] of Object.entries(t.props)) bits.push(`顺手把 ${k} 改成 ${asString(v)}`);
  if (t.tags.length > 0) bits.push(`顺手加上标签 ${t.tags.join(' ')}`);
  return bits.join(' · ');
}

/** 一篇笔记的现状（判"丢进去到底会不会发生什么"要用的事实，由调用方从索引读） */
export interface NoteFacts {
  /** 这篇现在在哪（相对库根；`''` = 库根） */
  dirRel: string;
  /** 现有的标签（不必去 `#` —— 这里会去） */
  tags: string[];
  /** 现有属性值（读它判 `prop` 类的"值已相同"） */
  props: Record<string, unknown>;
}

/**
 * **笔记右键「丢进板块」的候选**（P7.2c · 1.3-d，G2-b 拍板 + 「死选项」口径）。
 *
 * 输入是**与快速捕获完全同一份** `captureTargets()` 的产物（两处算两遍必漂）——
 * 这里只做"哪些能给它看"的过滤：
 *
 *   · `disabled`（属性源还没有取值）→ 不画（G2-b 原话）；
 *   · `shelter` 收容所 → 不画：它的定义是"谁都没命中"，**主动往里丢没有语义**
 *     （丢进去还会被它"收留"，比不画更 confusing）；
 *   · **对这篇没用的不画**（沿用「移动到当前目录」那条死选项口径，P7.0a 批 1⑨）：
 *     已在那块（folder 类目录一致）/ 已有那标签（并集不变）/ 值已相同（覆盖不变）——
 *     点了等于没点的那几行不该出现在菜单里。
 *   · 过滤后为空 → 调用方**整条不画**（一个能做的都没有）。
 */
export function noteTargets(list: CaptureTarget[], facts: NoteFacts): CaptureTarget[] {
  const tags = new Set(facts.tags.map((t) => String(t).replace(/^#/, '').trim()));
  return list.filter((t) => {
    if (t.disabled) return false;
    if (t.kind === 'shelter') return false;
    if (t.kind === 'folder') return normalizeDir(facts.dirRel) !== t.dirRel;
    if (t.kind === 'tag') return !t.tags.every((x) => tags.has(x));
    return Object.entries(t.props).some(([k, v]) => asString(facts.props[k]) !== asString(v));
  });
}

/** 三种能表达的源各走哪个动作（菜单右侧那行小字 + 执行分流共用一份口径） */
export function actionOf(kind: SectionKind): 'move' | 'tag' | 'prop' | null {
  if (kind === 'folder') return 'move';
  if (kind === 'tag') return 'tag';
  if (kind === 'prop') return 'prop';
  return null;
}

/**
 * 取值的键编码：**必须单射**（独立审查 🟢2）。
 * 早先是把 `::` 换成 `:：` —— 那**不是单射**（取值里本来就有 `:：` 时两个不同的值会撞成同一个键，
 * `pickTarget` 可能选到另一行）。`encodeURIComponent` 是单射、且键不给人看，随手就行。
 */
function keyOf(value: string): string {
  return encodeURIComponent(value);
}

function normalizeDir(dir: string): string {
  return String(dir ?? '').replace(/^\/+|\/+$/g, '');
}
