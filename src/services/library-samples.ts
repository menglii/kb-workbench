/**
 * services/library-samples.ts —— **示例数据**（16.2 · P7.2b · G3-⑥ 拍板）
 *
 * 初始化 / 补骨架时可以顺手放一套演示数据（勾选触发、默认不勾）：**6 篇 `__示例` 笔记
 * + 1 个示例看板板块** —— 让新库打开就有东西看（首页各块的显形条件都覆盖到：
 * 1 篇带 `收藏: true`、状态各异、1 篇带双链）。
 *
 * 三条纪律：
 *  · **全部带 `__示例` 前缀**（库内造的东西靠名字认领，与探针同一条纪律）→
 *    清理 = 按前缀找齐 + `mover.trash`（回收站，逐个报告）+ 移除示例板块（按 id 精确认领，
 *    绝不按"名字像"乱删用户的板块）；
 *  · 落点都在**两档预设都有的浅目录**（00_Inbox / 01_Projects / 02_Areas / 03_Resources）——
 *    基础版库上放示例也不会"待定"；
 *  · 每篇都写 `文件位置` = 自家目录（声明 == 实际）→ 复跑重排 0 搬动、不产生"位置不一致"。
 *
 * 创建走的是 `mover.extraFiles`（进快照 `newFiles`，还原删得掉）—— 内容在这儿，
 * 写盘路径只有那一条。
 */
import { joinPath } from '../core/paths';
import type { BoardSection } from '../modules/board/config';

/** 示例笔记与清理入口都认这个前缀 */
export const SAMPLE_PREFIX = '__示例';

/** 示例看板板块的 id（清理按它精确认领；见文件头纪律） */
export const SAMPLE_SECTION_ID = '__sample';

export interface SampleFile {
  /** 库内绝对路径 */
  path: string;
  content: string;
}

interface SampleDef {
  rel: string;
  /** `类型` 的值 —— ⚠️ 必须落在 `services/schema.ts` 的 `NOTE_TYPES` 值域里（v2） */
  type: string;
  /** `状态` 的值 —— 必须落在 `STATUSES` 里；不写 = 这篇不带状态（v2：收件箱/结构页可不写） */
  status?: string;
  tags: string[];
  favorite?: boolean;
  title: string;
  lines: string[];
}

/**
 * 6 篇示例笔记的**唯一定义处**（`path` 拼上库根）。
 * 篇数与形态写死在测试与文档里，改这里 = 改交付物（G3-⑥ 的记录）。
 * ⚠️ v2（P7.12）：类型收拢到 7 值域（笔记为主）；不再有「领域」「阶段」。
 */
function defs(): SampleDef[] {
  return [
    {
      rel: `00_Inbox/${SAMPLE_PREFIX} · 灵感速记.md`,
      type: '笔记', status: '进行中', tags: ['示例', '速记'],
      favorite: true,
      title: '💡 灵感速记',
      lines: [
        '> 示例内容 —— 任何一闪而过的念头先扔这儿，之后再慢慢整理。',
        '',
        '这一篇带 `收藏: true` —— 首页「收藏夹」块会把它收进去。',
      ],
    },
    {
      rel: `00_Inbox/${SAMPLE_PREFIX} · 待整理.md`,
      type: '笔记', tags: ['示例'],
      title: '📥 待整理',
      lines: [
        '> 示例内容 —— 还没想好放哪儿的，先留在收件箱（不写状态）。',
        '',
        '把它拖到左边的目录树里，就是一次真正的整理 —— 可以撤销。',
      ],
    },
    {
      rel: `01_Projects/${SAMPLE_PREFIX} · 项目立项.md`,
      type: '笔记', status: '进行中', tags: ['示例', 'GTD'],
      title: '🚀 项目立项',
      lines: [
        '> 示例内容 —— 有明确目标 + 截止时间的事，就是项目。',
        '',
        '顺手记下的那点灵感在 [[__示例 · 灵感速记]]（这条是双链示例）。',
      ],
    },
    {
      rel: `02_Areas/${SAMPLE_PREFIX} · 游戏笔记.md`,
      type: '笔记', status: '进行中', tags: ['示例'],
      title: '🎮 游戏笔记',
      lines: [
        '> 示例内容 —— 需要长期维持的方面（游戏研究）—— 目录本身就是它的分类。',
        '',
        '- 这样的方面不是项目：没有"做完"的那天，只有长期维护。',
      ],
    },
    {
      rel: `02_Areas/${SAMPLE_PREFIX} · 每周回顾.md`,
      type: '笔记', status: '进行中', tags: ['示例'],
      title: '🗓️ 每周回顾',
      lines: [
        '> 示例内容 —— 每周回来看一眼：这周留下了什么。',
        '',
        '- [ ] 收件箱清空',
        '- [ ] 随便翻两篇旧笔记',
      ],
    },
    {
      rel: `03_Resources/${SAMPLE_PREFIX} · 资源收藏.md`,
      type: '笔记', status: '已归档', tags: ['示例'],
      title: '📚 资源收藏',
      lines: [
        '> 示例内容 —— 将来可能有用的素材与参考，囤在「资源」里。',
        '',
        '不再需要的资源可以直接删 —— 删除进回收站，不心疼。',
      ],
    },
  ];
}

/** 示例笔记的完整内容（库内绝对路径 + 文本）—— 面板把它接进 `plan.newFiles` */
export function sampleNotes(kbRoot: string, today: string): SampleFile[] {
  const out: SampleFile[] = [];
  for (const d of defs()) {
    const dir = d.rel.slice(0, d.rel.lastIndexOf('/'));
    const fm = [
      '---',
      `类型: ${d.type}`,
      ...(d.status ? [`状态: ${d.status}`] : []),
      `创建日期: ${today}`,
      'tags:',
      ...d.tags.map((t) => `  - ${t}`),
      ...(d.favorite ? ['收藏: true'] : []),
      '文件位置:',
      `  - ${dir}`,
      '---',
    ];
    const body = [
      '',
      `# ${d.title}`,
      '',
      ...d.lines,
      '',
      '',
      '<!-- 这是「示例数据」—— 在 重排库结构 面板里点「清掉示例数据」可以整批收走。 -->',
      '',
    ];
    out.push({ path: joinPath(kbRoot, d.rel), content: [...fm, ...body].join('\n') });
  }
  return out;
}

/** 示例看板板块（tag 认领：6 篇示例都带 `示例` 标签） */
export function sampleBoardSection(): BoardSection {
  return {
    id: SAMPLE_SECTION_ID,
    name: '示例',
    kind: 'tag',
    value: '示例',
    exclude: [],
    limit: null,
    sort: null,
    cardMode: null,
    props: null,
    width: null,
    height: null,
  };
}
