/**
 * ui/settings/board.ts —— 设置 · **看板默认值**栏（交互规格 §7.4）
 *
 * ⚠️ 两期的事：**这一栏是 P3 做（写库内 `06_工作台/看板配置.json`），生效在 P4**。
 * 写下去的就是 P4 建板块时的默认档 —— 默认值**只有一份**（`core/config-files.ts` 的
 * `BOARD_VIEW_DEFAULTS`，本栏 import 它）；两处各写一份一定会漂
 * （独立审查在 P3 收尾时抓到过：当时面板里还有第二份活代码）。
 *
 * 「显示属性多选」不在这里：那个的候选是"当前库里真有哪几个属性"，
 * 属于看板自己的视图参数（P4 的 §9 清单），这里给不了有意义的默认值。
 */
import type { WorkbenchContext } from '../../core/context';
import { BOARD_VIEW_DEFAULTS } from '../../core/config-files';
import { CARD_H_MAX, CARD_W_MAX, CARD_W_MIN, PANEL_FONT_MAX, type BoardFlow, type PanelPref, type PanelPropsMode, type PanelContentMode } from '../../modules/board/config';
import { div } from '../primitives';
import { NOTIFY_MS, notify, notifyLight } from '../notify';
import { group, row, segCtl, setTitle, sliderCtl, numberCtl, switchCtl } from './kit';
import type { SectionApi, SettingsSection } from './types';
import type { DockState, PeekDock } from '../dock';

/**
 * ⚠️ 这是 `BoardView` 的一份**窄版**（只列本栏目真的会渲染的字段），不是重复定义。
 * 但**联合类型一律从 `modules/board/config` 引**（`BoardFlow`），别在这儿抄字面量 ——
 * 抄一份就意味着以后加形态要改两处，而漏掉的那处直到 tsc 报错才会发现。
 */
interface BoardView {
  cardMode: 'content' | 'props' | 'both';
  /** 板块形态（§2.1）：列 / 流式。窄档强制流式是 CSS 的事，这里只是"要哪种" */
  flow: BoardFlow;
  /** 「两者」档下属性块占卡片高度的比例；null = 自动（拖卡片里的分隔条会写它） */
  propsRatio: number | null;
  propsRatioByPath: Record<string, number>;
  /**
   * 悬浮小窗显示多少属性 / 正文怎么显示。
   * ⚠️ 这两个字段本身不在这栏里渲染，但**必须列出来**：`BOARD_VIEW_DEFAULTS` 一加新键，
   * 那句 `{...DEFAULTS} as BoardView` 就会因为"目标类型缺键"报 TS2352（已经栽过三次）。
   * 加默认值的时候记得同步这里 —— 这是本文件唯一需要跟着 `core/config-files.ts` 走的地方。
   */
  panelProps: PanelPropsMode;
  panelContent: PanelContentMode;
  /**
   * 预览换行（P6b ⑥）。⚠️ **这一栏会渲染它** —— 上面那段注释说的"缺键就报 TS2352"
   * 仍然成立：加默认值时要同步这份形状（它只在 `save()` 的补丁里用得到）。
   */
  previewWrap: boolean;
  /** 小窗字号（f 期第 2 条）：0 = 用默认（**平台 −2px**，C1 起）。**这一栏会渲染它** */
  panelFont: number;
  /** 小窗里属性块的高度比例（f 期第 5 条）：null = 自动 */
  panelPropsRatio: number | null;
  /** 每篇笔记自己的小窗设置（f 期第 3 条）—— 这里不渲染，但必须列出来（同下面几条的理由） */
  panelByPath: Record<string, PanelPref>;
  /** 面板钉住（d 期）—— 同上：不在这栏渲染，但必须列出来 */
  panelPinned: boolean;
  /**
   * 停靠（d2 期）—— 同上：不在这栏渲染，但必须列出来。
   * 形状从 `ui/dock.ts` 引（那边是唯一出处），别在这儿再描一遍字面量。
   */
  dock: DockState;
  /**
   * 预览窗格（e 期 §3.2）—— 与上面两条**同一类**：这一栏不渲染它（它归看板菜单管），
   * 但必须列出来 —— `DEFAULTS` 那份是 `{...BOARD_VIEW_DEFAULTS} as BoardView`，
   * 少列一个字段这条断言就编不过（TS2352），而那是**对的**：它逼着两处同源。
   */
  peekEnabled: boolean;
  peek: PeekDock;
  cardWidth: number;
  /** 0 = 自动高度（与看板菜单同一口径） */
  cardHeight: number;
  gap: number;
  allowDuplicate: boolean;
  hideEmpty: boolean;
  shelter: boolean;
  summaryLines: number;
  showHidden: boolean;
  stripFrontmatter: boolean;
  stripTail: boolean;
}

/**
 * ⚠️ 默认值**不在这里写第二份** —— 直接取 `core/config-files.ts` 的
 * `BOARD_VIEW_DEFAULTS`（那是唯一真源，P4 建板块时读的也是它）。
 *
 * ⚠️ 断言写 `as unknown as BoardView`：这一份是**给设置面板显示与回写用的"默认集合"**，
 * 而 `BoardView` 里还有几个"由 `normalizeView` 现算/别处管"的键（各 `*ByPath` 表…）
 * 不在这张常量表里。直接 `as BoardView` 会在常量表每次加键时报一句"缺 X" ——
 * 那是**假报错**（缺的那个本来就不该由这里给）。
 *
 * 📌 **`cardHeight` 的账（P7.5 · 8.1 体检 M1 + 独立审加固）**：它当年是历史遗漏 ——
 * 这一栏**会渲染**它、常量表里却没有 → 未物化的库上 `undefined` 流进输入框。
 * 第一版修法是**在这里手补** `cardHeight: 0`（"镜像补丁"）；独立审指出该补在
 * **根上**：它已进 `BOARD_VIEW_DEFAULTS`（`normalizeView` 也改读那里）——
 * 以后"面板会渲染、默认在别处算"的键照这条走，别回到这里一个个打补丁。
 */
const DEFAULTS = { ...BOARD_VIEW_DEFAULTS } as unknown as BoardView;

export function makeBoardSection(): SettingsSection {
  let view: BoardView | null = null;
  let exists = false;

  return {
    id: 'board',
    label: '看板',
    icon: 'layout-grid',
    /**
     * ⚠️ **副标题不许写"只影响新建的板块"**（独立审 2026-10-04 抓的假陈述）：这一栏写的是
     * **活的** `看板配置.json` 的 `view` 段 —— `gap` / `hideEmpty` / `allowDuplicate` /
     * `shelter` / `showHidden` / 各项小窗默认等**改完立即生效**（既有看板直接读它），
     * 只有 卡片显示 / 属性列 / 排序 这些有板块级覆盖。写窄了会让用户以为"改了不生效"。
     */
    sub: '看板的默认档 —— 多数项改完立即生效',
    render(host, api) {
      void paint(host, api);
    },
  };

  async function load(ctx: WorkbenchContext): Promise<void> {
    if (view) return;
    exists = await ctx.configs.exists('board');
    const raw = (await ctx.configs.read('board')) as { view?: Partial<BoardView> } | null;
    view = { ...DEFAULTS, ...(raw?.view ?? {}) };
  }

  async function save(ctx: WorkbenchContext, patch: Partial<BoardView>, api: SectionApi): Promise<void> {
    await load(ctx);
    const next = { ...(view as BoardView), ...patch };
    view = next;
    const cur = (await ctx.configs.read('board')) as Record<string, unknown> | null;
    const data = { ...(cur && typeof cur === 'object' ? cur : { version: 1 }), view: next };
    try {
      await ctx.configs.write('board', data);
      exists = true;
      notifyLight('看板默认值已保存', '建新板块时按它来');
      api.rerender();
    } catch (e) {
      notify({
        kind: 'error',
        text: '保存失败',
        detail: e instanceof Error ? e.message : String(e),
        ms: NOTIFY_MS.long,
      });
    }
  }

  async function paint(host: HTMLElement, api: SectionApi): Promise<void> {
    const ctx = api.ctx;
    await load(ctx);
    const v = view as BoardView;

    host.appendChild(
      setTitle('看板默认值', '库内配置：99_Meta/06_工作台/看板配置.json（看板自己也能就地改）'),
    );
    host.appendChild(
      div({
        cls: 'kbw-set-note is-info',
        text: exists
          ? '这一栏写的是看板级默认 —— 多数项改完立即生效；卡片显示 / 属性列 / 排序这些，' +
            '在板块菜单里单独设过就以那个板块为准。'
          : '库里还没有这个文件 —— 改一下就会落盘（建看板时也会用它）。',
      }),
    );

    host.appendChild(
      group(
        '视图',
        '看板的默认视图参数。「显示属性多选」不在这里 —— 它的候选是"库里真有哪几个属性"，在看板上就地选',
      ),
    );
    host.appendChild(
      row(
        '卡片显示档位',
        segCtl<'content' | 'props' | 'both'>(
          v.cardMode,
          [
            { value: 'content', label: '只内容' },
            { value: 'props', label: '只属性' },
            { value: 'both', label: '两者' },
          ],
          (val) => void save(ctx, { cardMode: val }, api),
        ),
        '默认「只内容」',
      ),
    );
    host.appendChild(
      row(
        '板块形态',
        segCtl<BoardFlow>(
          v.flow,
          [
            { value: 'columns', label: '列' },
            { value: 'flow', label: '流式' },
          ],
          (val) => void save(ctx, { flow: val }, api),
        ),
        '默认「列」：板块并排、各自纵向滚。窄窗（<640px）强制流式',
      ),
    );
    /**
     * 悬浮小窗显示什么（用户 2026-09-25 要的）。**小窗头上那个 ⚙ 也有一份同样的开关** ——
     * 他先在设置面板找、也可能在小窗上找，两处都给（同一个字段，不会漂）。
     */
    host.appendChild(
      row(
        '小窗属性',
        segCtl<'few' | 'all' | 'none'>(
          v.panelProps,
          [
            { value: 'few', label: '前 6 行' },
            { value: 'all', label: '全部' },
            { value: 'none', label: '不显示' },
          ],
          (val) => void save(ctx, { panelProps: val }, api),
        ),
        '默认「不显示」（只看正文）；「前 6 行」= 铺前 6 行，其余收在「显示全部属性」后面',
      ),
    );
    host.appendChild(
      row(
        '小窗正文',
        segCtl<'editor' | 'preview' | 'none'>(
          v.panelContent,
          [
            { value: 'editor', label: '可编辑' },
            { value: 'preview', label: '只读预览' },
            { value: 'none', label: '不显示' },
          ],
          (val) => void save(ctx, { panelContent: val }, api),
        ),
        '「只读预览」会剥掉前言与结尾双链（真编辑器里那两段藏不掉）；要就地编辑就用「可编辑」',
      ),
    );
    host.appendChild(
      row(
        '小窗字号',
        numberCtl(v.panelFont, (val) => void save(ctx, { panelFont: val }, api), {
          min: 0,
          max: PANEL_FONT_MAX,
          // 0 = "没设过"的哨兵 → 留空 + placeholder「默认」，别把 0 画出来（P7.0a 批 1⑧）
          emptyAt: 0,
          placeholder: '默认',
        }),
        `px；留空 = 用默认字号（比平台小一号，跟着平台字号走）。面板里 Ctrl+滚轮 也能缩放，两者是同一个字段`,
      ),
    );
    host.appendChild(
      row(
        '预览换行',
        segCtl<'wrap' | 'scroll'>(
          v.previewWrap ? 'wrap' : 'scroll',
          [
            { value: 'wrap', label: '换行' },
            { value: 'scroll', label: '横向滚动' },
          ],
          // ⚠️ 这是**两档**不是开关：写进配置的必须是真布尔（`segCtl` 给的是字符串）
          (val) => void save(ctx, { previewWrap: val === 'wrap' }, api),
        ),
        '默认换行：卡片摘要与小窗只读预览都按它走。关掉之后文本按原样、容器横向滚 —— ' +
          '⚠️ white-space 只管文本，表格 / 代码块本来就按内容宽度排（那是 Markdown 的语义）。每一篇可在面板 ⚙ 里单独设',
      ),
    );
    host.appendChild(
      row(
        '卡片宽度',
        sliderCtl(v.cardWidth, CARD_W_MIN, CARD_W_MAX, 10, (val) => void save(ctx, { cardWidth: val }, api)),
        `${CARD_W_MIN}–${CARD_W_MAX} px（也能在看板上按 Ctrl+滚轮 缩放）`,
      ),
    );
    host.appendChild(
      row(
        '卡片高度',
        numberCtl(v.cardHeight, (val) => void save(ctx, { cardHeight: val }, api), { min: 0, max: CARD_H_MAX }),
        'px；0 = 自动（按摘要行数）。设了固定高度：正文填满、卡片内可滚',
      ),
    );
    host.appendChild(
      row('网格间距', numberCtl(v.gap, (val) => void save(ctx, { gap: val }, api), { min: 0, max: 64 }), 'px'),
    );
    host.appendChild(
      row(
        '摘要行数',
        numberCtl(v.summaryLines, (val) => void save(ctx, { summaryLines: val }, api), { min: 0, max: 10 }),
        '卡面上正文摘要显示几行（0 = 不显示）',
      ),
    );

    host.appendChild(group('内容处理', '卡面渲染前的两步剥离'));
    host.appendChild(
      row(
        '剥前言',
        switchCtl(v.stripFrontmatter, (val) => void save(ctx, { stripFrontmatter: val }, api)),
        '默认开：不剥的话摘要里全是 YAML',
      ),
    );
    host.appendChild(
      row(
        '剥结尾双链段',
        switchCtl(v.stripTail, (val) => void save(ctx, { stripTail: val }, api)),
        '默认开：不剥的话摘要尾部是 [[…]] 噪音',
      ),
    );

    host.appendChild(group('显示', ''));
    host.appendChild(
      row(
        '允许重复',
        switchCtl(v.allowDuplicate, (val) => void save(ctx, { allowDuplicate: val }, api)),
        '同一篇笔记可以出现在多个板块里',
      ),
    );
    host.appendChild(
      row('隐藏空板块', switchCtl(v.hideEmpty, (val) => void save(ctx, { hideEmpty: val }, api)), ''),
    );
    host.appendChild(
      row(
        '显示收容所',
        switchCtl(v.shelter, (val) => void save(ctx, { shelter: val }, api)),
        '默认关：收容所放"哪条规则都没命中的笔记"',
      ),
    );
    host.appendChild(
      row(
        '查看隐藏的文件',
        switchCtl(v.showHidden, (val) => void save(ctx, { showHidden: val }, api)),
        '「隐藏: true」的笔记默认淡出',
      ),
    );

  }
}
