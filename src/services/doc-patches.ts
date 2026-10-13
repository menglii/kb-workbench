/**
 * services/doc-patches.ts —— **正文补丁**（P2 收尾；用户 2026-09-24 授意"你帮我改"）
 *
 * 为什么单独一个表、而不是让用户手工改：
 *   · 真库的唯一安全写盘路径是 `vault.process`（同步就在插件同一个进程里跑，见 `CLAUDE.md`）
 *     → 所以"改正文"这件事**必须由插件做**，而不是握手写脚本或让人粘贴
 *   · 16 处补丁用一张**声明式**表比"逐处手改"更能审（预演里列出来、报告里记一笔）
 *
 * ⚠️ 三条铁律：
 *   ① `find` 必须**原文照抄**（含全角标点）；命中 0 次或 >1 次都**不写**，报出来
 *   ② 幂等靠**三态**判，而且**先看 `replace`**：`replace` 在 → 已经打过（"追加"型补丁打完之后
 *      `find` 依然在，先看 `find` 会永远算"待打"）；只有 `find` 在 → 待打；
 *      两个都不在 → **miss**（有人手改过这一句？）→ 只报不动
 *   ③ 只碰这 3 篇（都是"说明性文本"），**不碰任何知识笔记的正文**
 */
import type { TFile } from 'obsidian';
import type { NoteEntry } from '../core/vault-index';

export interface DocPatch {
  /** 相对库根的路径 */
  rel: string;
  find: string;
  replace: string;
  why: string;
}

/** 一篇的补丁状态 */
export type PatchState = 'pending' | 'done' | 'missing';

/**
 * 补丁表（P2 的属性迁移连带要改的说明文字）。
 * 每条的 `find` 都是**迁移前**那三篇里的原文。
 */
export const DOC_PATCHES: DocPatch[] = [
  // ── ① AI操作规范.md（AI 每次开工读的契约；不改会继续教 AI 写旧字段）──
  {
    rel: '99_Meta/03_AI指令集/AI操作规范.md',
    find: '| `02_Areas/` | 领域（长期维护，无终点） | 学业成长、技术栈积累、职业发展、生活健康 |',
    replace: '| `02_Areas/` | 领域（长期维护，无终点） | 内容创作、游戏研究、每日任务、灵感杂记、生活健康 |',
    why: '领域值域变了（学业成长/技术栈积累/职业发展 都不是新值）',
  },
  {
    rel: '99_Meta/03_AI指令集/AI操作规范.md',
    find: '从 `99_Meta/02_模板库/` 选模板：学习→学习笔记模板，项目→项目笔记模板，资料→参考资料模板。',
    replace:
      '从 `99_Meta/02_模板库/Templater/` 选模板：内容作品→`T_内容作品`，项目→`T_项目笔记`，' +
      '领域笔记→`T_领域笔记`，参考资料→`T_参考资料`，每日任务→`T_每日任务`，速记→`T_收件箱速记`。',
    why: '模板早就搬到 Templater/ 下了（旧写法指的是 04_Archives/旧资料 里的副本）',
  },
  {
    rel: '99_Meta/03_AI指令集/AI操作规范.md',
    find: [
      '类型: 学习笔记          # 学习笔记/项目笔记/参考资料/想法/规范/MOC索引/区域中心',
      '领域: 技术栈积累         # 对应所属区域或子分类',
      '主题: C++               # 具体主题关键词',
      '状态: 进行中            # 进行中/已完成/待整理/归档',
      '创建日期: 2026-09-05    # YYYY-MM-DD',
      '标签: [C++, 面向对象]    # 数组，至少1个',
    ].join('\n'),
    replace: [
      '类型: 资料              # 内容作品/项目笔记/任务清单/想法/资料/指南/规范/中心页/MOC/日志',
      '领域: 灵感杂记           # 内容创作/游戏研究/每日任务/灵感杂记/生活健康/项目/Meta/未分类',
      '状态: 进行中            # 待整理/进行中/已完成/持续更新/已归档',
      '创建日期: 2026-09-05    # YYYY-MM-DD',
      'tags: [C++, 面向对象]    # 数组，只放横切标签（不重复「领域」的值）；可以为空',
      '',
      '> 另外两条（2026-09-24 属性迁移后的口径）：',
      '> · `类型: 内容作品` 还要填 `发布进度`（`1-灵感`/`2-选题`/`3-撰写中`/`4-待发布`/`5-已发布`）',
      '> · 已经**没有** `主题` 字段了 —— 标题就是文件名；`标签` 那个中文键并进了 `tags`',
    ].join('\n'),
    why: '这段是给 AI 抄的 YAML 样板：值域、中文键「标签」、`主题` 全过时了',
  },
  {
    rel: '99_Meta/03_AI指令集/AI操作规范.md',
    find: '- 格式 `主题_简短描述.md`，如 `C++_虚函数机制.md`',
    replace: '- 名字用「主题_描述」式的短名（如 `C++_虚函数机制.md`）—— 这只是命名习惯，不再对应任何字段',
    why: '`主题` 字段已删，命名不再"对应字段"',
  },
  {
    rel: '99_Meta/03_AI指令集/AI操作规范.md',
    find: '1. 更新该笔记 YAML 的「领域」「状态」字段（归档时状态改为 `归档`）',
    replace: '1. 更新该笔记 YAML 的「领域」「状态」字段（归档时状态改为 `已归档`）',
    why: '`归档` 改名成 `已归档`（§4.3）',
  },

  // ── ② 知识库使用指南.md ──
  {
    rel: '99_Meta/01_仪表盘/知识库使用指南.md',
    find: '这篇笔记**是什么**？（类型/状态/主题）',
    replace: '这篇笔记**是什么**？（类型/领域/状态）',
    why: '三套系统那张表里列的字段名该换成新的',
  },
  {
    rel: '99_Meta/01_仪表盘/知识库使用指南.md',
    find: '3. **补身份证**：加 YAML 头部（类型/领域/主题/状态/日期/标签）',
    replace: '3. **补身份证**：加 YAML 头部（类型/领域/状态/创建日期/tags）',
    why: '同上：`主题` 已删、`标签` 中文键并进 `tags`',
  },
  {
    rel: '99_Meta/01_仪表盘/知识库使用指南.md',
    find: '2. **整理归类**：周末判断——这是长期技术积累 → 移到 `02_Areas/技术栈积累/编程语言/`',
    replace: '2. **整理归类**：周末判断——这是长期积累 → 移到 `02_Areas/灵感杂记/`（`领域` 同时改成对应值）',
    why: '那个目录在新骨架里不存在；`领域` 也要跟着改',
  },
  {
    rel: '99_Meta/01_仪表盘/知识库使用指南.md',
    find: [
      '类型: 学习笔记',
      '领域: 技术栈积累',
      '主题: Python',
      '状态: 进行中',
      '创建日期: 2026-09-05',
      'tags: [Python, 基础]',
    ].join('\n'),
    replace: ['类型: 资料', '领域: 灵感杂记', '状态: 进行中', '创建日期: 2026-09-05', 'tags: [Python, 基础]'].join(
      '\n',
    ),
    why: '例子里的 YAML：类型收拢、删 `主题`',
  },
  {
    rel: '99_Meta/01_仪表盘/知识库使用指南.md',
    find: 'A：看"主要用途"。为完成某个项目而学 → Projects；系统学习某领域 → Areas。拿不准放 Areas，用标签关联项目。',
    replace:
      'A：看"主要用途"。为完成某个项目而学 → `01_Projects`；系统学习某领域 → `02_Areas` 下对应的领域目录。' +
      '拿不准先放 `00_Inbox`（`领域: 未分类`），用标签关联项目。',
    why: '`Projects`/`Areas` 是旧目录名',
  },

  // ── ③ README_模板自动化设置.md（历史记录；只改会误导人的几处）──
  {
    rel: '99_Meta/02_模板库/README_模板自动化设置.md',
    find: '> 目的：解决「新建笔记时懒得手写 YAML 头和尾部关联链接」的问题。配好之后，**在对应文件夹里新建笔记，YAML 和关联链接会自动填好**，不用再找 AI 补。',
    replace:
      '> 目的：解决「新建笔记时懒得手写 YAML 头和尾部关联链接」的问题。配好之后，**在对应文件夹里新建笔记，YAML 和关联链接会自动填好**，不用再找 AI 补。\n' +
      '>\n' +
      '> ⚠️ **2026-09-24 属性迁移之后**：`主题`、中文键 `标签`、`仅显示于`、`聚焦` **已删除**；\n' +
      '> `状态`（通用生命周期）与 `发布进度`（内容流水线，仅内容作品）**已拆成两个字段**。\n' +
      '> 本文下面记的是**当时的做法**；涉及这两个字段的段落已按新口径改写或标明作废。',
    why: '本文是历史记录：加一条头部注记，挡住"照着重砌旧字段"',
  },
  {
    rel: '99_Meta/02_模板库/README_模板自动化设置.md',
    find: '在目标子文件夹里点「新建笔记」→ 自动套好 YAML + 关联链接 → 改名成 `主题_描述` → 开始写。',
    replace: '在目标子文件夹里点「新建笔记」→ 自动套好 YAML + 关联链接 → 起个名 → 开始写。',
    why: '`主题_描述` 的命名约定随 `主题` 字段一起作废',
  },
  {
    rel: '99_Meta/02_模板库/README_模板自动化设置.md',
    find: '按下去会先问你文件名和放哪，再套模板，这样 YAML 里的「主题」字段能直接取到正确前缀。',
    replace: '按下去会先问你文件名和放哪，再套模板 —— 这样模板里 `<% title %>` 这类取值才拿得到正确的名字。',
    why: '同上',
  },
  {
    rel: '99_Meta/02_模板库/README_模板自动化设置.md',
    find: [
      '### 2. 改名后「主题」字段不跟随 → 每天自动修',
      '',
      'Obsidian 新建笔记默认叫「未命名」，模板在创建的那一刻就把 `主题` 填好了，之后改名**不会**自动更新。',
      '',
      '已配置一个**每天 21:00** 的定时任务，扫描 `01_新知识库` 并自动处理：',
      '',
      '1. YAML「主题」/ 一级标题与文件名不符的 → 以文件名为准修正（取文件名第一个 `_` 前的部分）',
      '2. 缺 YAML 或字段不全 → 按所在目录推断补齐',
      '3. 缺尾部「关联笔记」区 → 补所属中心双链 + 返回 MOC',
      '4. 空文件、NUL 字节 → 只报告不删',
    ].join('\n'),
    replace: [
      '### 2. ~~改名后「主题」字段不跟随~~ → ✅ 这个问题已经没有了（2026-09-24 属性迁移）',
      '',
      '「主题」是标题的副本，改名后就会变旧 —— 迁移时**把整个字段删掉了**：',
      '现在要看标题直接读文件名，不存在「跟不跟随」。原先那条「每天 21:00 定时修正」随之作废。',
      '',
      '巡检里与「主题」无关的部分仍然成立：',
      '',
      '- 缺 YAML 或字段不全 → 按所在目录推断补齐',
      '- 缺尾部「关联笔记」区 → 补所属中心双链 + 返回 MOC',
      '- 空文件、NUL 字节 → 只报告不删',
    ].join('\n'),
    why: '整节都在讲怎么维护 `主题` 字段 —— 该字段没了，这一节随之作废',
  },
  {
    rel: '99_Meta/02_模板库/README_模板自动化设置.md',
    find: '| 内容流水线 | 内容作品按状态分列 | 规则（与内容创作看板同源） |',
    replace: '| 内容流水线 | 内容作品按「发布进度」分列 | 规则（与内容创作看板同源） |',
    why: '流水线值现在住在 `发布进度` 里',
  },
  {
    rel: '99_Meta/02_模板库/README_模板自动化设置.md',
    find: '| `状态`（11 个） | `1-灵感`、`2-选题`、`3-撰写中`、`4-待发布`、`5-已发布`、`进行中`、`待整理`、`已整理`、`持续更新`、`已完成`、`归档` |',
    replace:
      '| `状态`（5 个） | `待整理`、`进行中`、`已完成`、`持续更新`、`已归档` |\n' +
      '| `发布进度`（5 个，仅内容作品） | `1-灵感`、`2-选题`、`3-撰写中`、`4-待发布`、`5-已发布` |',
    why: '那张候选值表列的是旧值域（`已整理`/`归档` 都没了）',
  },
];

/** 这篇有哪些补丁（按路径查） */
export function patchesOf(rel: string): DocPatch[] {
  return DOC_PATCHES.filter((p) => p.rel === rel || rel.endsWith('/' + p.rel));
}

/**
 * 一条补丁的状态：找得到 `find` → 待打；只剩 `replace` → 已经打过；
 * 两个都没有 → `missing`（有人手改过这一句？只报不动）。
 */
export function patchState(text: string, p: DocPatch): PatchState {
  /**
   * ⚠️ **先看 `replace`**：有的补丁是"追加"型（`replace` = 原文 + 新注记），
   * 打完之后 `find` **依然在** —— 先看 `find` 的话它会永远算"待打"（预演回不到 0，
   * 而且再点一次执行会**再追加一遍**）。
   */
  if (text.includes(p.replace)) return 'done';
  if (text.includes(p.find)) return 'pending';
  return 'missing';
}

/** 这一篇**待打**的补丁（幂等：打完再算是空的） */
export function pendingPatches(rel: string, text: string | undefined): DocPatch[] {
  if (text == null) return [];
  return patchesOf(rel).filter((p) => patchState(text, p) === 'pending');
}

export interface PatchResult {
  text: string;
  applied: number;
  /** 没命中的（有人手改过 / 原文漂了）→ 不写、报出来 */
  missed: string[];
}

/** 打补丁（**纯函数**）：命中恰好一次才换 */
export function applyPatches(text: string, patches: DocPatch[]): PatchResult {
  let out = text;
  let applied = 0;
  const missed: string[] = [];
  for (const p of patches) {
    const n = countOccurrences(out, p.find);
    if (n === 1) {
      out = out.replace(p.find, p.replace);
      applied += 1;
    } else if (n === 0) {
      missed.push(`${p.rel}：找不到「${p.find.slice(0, 20)}…」`);
    } else {
      missed.push(`${p.rel}：「${p.find.slice(0, 20)}…」命中 ${n} 次（要恰好 1 次）`);
    }
  }
  return { text: out, applied, missed };
}

/**
 * ⚠️ P7.22a：导出给 `services/ai/text-edit.ts` 复用（`patch_text` 的"恰好 1 处"判定
 * 与这里的"命中恰好一次才换"是同一条计数口径 —— 两处各写一份必漂）。
 */
export function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** 补丁表覆盖的路径（读正文时用） */
export const PATCHED_RELS: string[] = Array.from(new Set(DOC_PATCHES.map((p) => p.rel)));

/**
 * 读"要判正文"的文件：**v2 起 = 全部**（模板 + 补丁覆盖的那几篇 + 每一篇笔记）。
 * 为什么全读：v2 的正文修整（📌 页脚行 / 尾链存量重排）要对**任意一篇**判"有没有得修"
 * —— 不读就判不了（读的是 `cachedRead`，平台内存缓存，几十上百篇的开销可接受；
 * 读失败的**不放进表**：模板那边=保守地列成"没核对"、笔记那边=跳过正文修整，等下次）。
 */
export async function collectTexts(
  vault: { cachedRead(file: TFile): Promise<string> },
  entries: NoteEntry[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    try {
      out[e.path] = await vault.cachedRead(e.file);
    } catch (err) {
      console.error('[经纬] 读正文失败（先当它需要处理）', e.path, err);
    }
  }
  return out;
}

