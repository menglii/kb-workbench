/**
 * ui/settings/routes.ts —— 设置 · **目录映射**栏（交互规格 §7.3；用户 2026-09-24 拍板"并入"）
 *
 * 这一栏是库内那张路由表（`99_Meta/02_模板库/标签-目录映射.json`）的**唯一编辑器**：
 *   · 表格化编辑：标签段 / 别名段（JSON 键仍是 `领域`，v2 起语义是"关键词别名"）/ 兜底目录
 *   · **体检**：目录不存在 / 重复落点 / 兜底目录没配或不存在
 *   · 保存即写回库内 JSON（唯一写点在 `services/routes.ts`）
 *
 * ⚠️ 三件不能动的事：
 *   · **文件名与路径不改**（`T_智能新建` 这个 Templater 脚本读的是同一路径）
 *   · **表里的值是库内绝对路径**（`01_新知识库/…`，与那个脚本同一口径）
 *   · 注释键（`_说明` / `_用法`）原样保留 —— 它们是写给人看的，编辑一次不能弄丢
 *
 * 为什么是**工厂函数**而不是模块级常量：这一栏有"编辑中的草稿"（改了还没保存）。
 * 草稿要活过重画（改一行会触发重画），但又不能在面板关掉之后还留在内存里指着旧库
 * —— 于是"一次打开 = 一份草稿"，由 `makeRoutesSection()` 的闭包持有。
 */
import {
  ROUTE_SECTIONS,
  SECTION_LABEL,
  checkRoutes,
  dirRelOf,
  readRouteTable,
  vaultPathOf,
  writeRouteTable,
  type RouteIssue,
  type RouteSection,
  type RouteTable,
} from '../../services/routes';
import { btn, div, el, span } from '../primitives';
import { confirm } from '../confirm';
import { promptText } from '../prompt';
import { NOTIFY_MS, notify, notifyLight } from '../notify';
import { emptyLine, group, setTitle, smallBtn, statusLine, toolbar } from './kit';
import type { SectionApi, SettingsBlock } from './types';

export function makeRoutesSection(): SettingsBlock {
  /** 编辑中的草稿（null = 还没读/已放弃，要从盘上重读） */
  let draft: RouteTable | null = null;
  let dirty = false;

  return {
    label: '目录映射',
    sub: '标签 / 关键词别名 → 目录（库内那张表的唯一编辑器）',
    render(host, api) {
      void paint(host, api);
    },
  };

  async function paint(host: HTMLElement, api: SectionApi): Promise<void> {
    const ctx = api.ctx;
    const read = await readRouteTable(ctx.app, ctx.settings);
    if (!draft) {
      draft = JSON.parse(JSON.stringify(read.table)) as RouteTable;
      dirty = false;
    }
    const table = draft;

    host.appendChild(
      setTitle(
        '目录映射',
        `库内文件：${ctx.settings.routeTablePath()}（Templater 脚本 T_智能新建 读的是同一份）` +
          '；表格里填的是库内绝对路径',
      ),
    );

    if (read.broken) {
      host.appendChild(warnNote(`读表时有问题：${read.broken} —— 这里显示的是兜底默认值，保存会覆盖文件。`));
    } else if (!read.exists) {
      host.appendChild(warnNote('库里还没有这张表（按默认值显示）。点「保存」就会落盘。'));
    }

    const saveBtn = btn({
      cls: 'kbw-btn is-small is-primary',
      text: '保存',
      attr: { title: '改完点它才写回库里' },
      on: { click: () => void save() },
    });
    const dirtyLine = statusLine();
    const paintDirty = (): void => {
      dirtyLine.textContent = dirty ? '有未保存的改动' : '已同步';
      saveBtn.toggleAttribute('disabled', !dirty);
      saveBtn.classList.toggle('is-disabled', !dirty);
    };

    host.appendChild(
      toolbar(
        saveBtn,
        btn({
          cls: 'kbw-btn is-small is-ghost',
          text: '放弃改动',
          on: {
            click: () => {
              draft = null;
              api.rerender();
            },
          },
        }),
        dirtyLine,
      ),
    );

    for (const section of ROUTE_SECTIONS) {
      host.appendChild(group(SECTION_LABEL[section], `${Object.keys(table[section] ?? {}).length} 条`));
      const rowsBox = div({ cls: 'kbw-set-rows' });
      const keys = Object.keys(table[section] ?? {});
      if (keys.length === 0) rowsBox.appendChild(emptyLine('这一段还是空的'));
      for (const key of keys) rowsBox.appendChild(editRow(section, key, rowsBox));
      host.appendChild(rowsBox);
      host.appendChild(
        toolbar(
          smallBtn('＋ 加一行', () => {
            void addRow(section);
          }),
        ),
      );
    }

    // 兜底目录（JSON 键仍叫 `领域兜底` —— 脚本契约，见 services/routes.ts）
    host.appendChild(group('兜底目录', '没有任何信号的笔记（无标签 / 无关键词 / 未声明）落到哪儿'));
    const fbInput = el('input', {
      cls: 'kbw-input',
      attr: { type: 'text', value: String(table['领域兜底'] ?? '') },
    });
    fbInput.style.width = '100%';
    fbInput.addEventListener('change', () => {
      const v = fbInput.value.trim();
      if (v) table['领域兜底'] = v;
      else delete table['领域兜底'];
      dirty = true;
      paintDirty();
    });
    const fbBox = div({ cls: 'kbw-set-row is-plain' });
    fbBox.appendChild(span({ cls: 'kbw-set-label-t', text: '兜底目录' }));
    fbBox.appendChild(fbInput);
    host.appendChild(fbBox);

    // 体检
    const issueBox = div({ cls: 'kbw-set-issues' });
    host.appendChild(issueBox);
    paintIssues(issueBox);
    paintDirty();

    // ── 内部 ──────────────────────────────────────────────────
    function editRow(section: RouteSection, key: string, rowsBox: HTMLElement): HTMLElement {
      const rowBox = div({ cls: 'kbw-set-row is-plain is-route' });
      const nameInput = el('input', { cls: 'kbw-input', attr: { type: 'text', value: key } });
      nameInput.style.width = '140px';
      const dirInput = el('input', {
        cls: 'kbw-input',
        attr: { type: 'text', value: String(table[section]?.[key] ?? '') },
      });
      dirInput.style.flex = '1';

      // 改名：只换键、保留值；改名之后**整栏重画**（键变了，行要重排）
      nameInput.addEventListener('change', () => {
        const next = nameInput.value.trim();
        const sec = { ...(table[section] ?? {}) };
        const dir = sec[key];
        delete sec[key];
        if (next) sec[next] = dir;
        table[section] = sec;
        dirty = true;
        api.rerender();
      });
      dirInput.addEventListener('change', () => {
        table[section] = { ...(table[section] ?? {}), [key]: dirInput.value.trim() };
        dirty = true;
        paintDirty();
        paintIssues(issueBox);
      });

      rowBox.appendChild(nameInput);
      rowBox.appendChild(span({ cls: 'kbw-set-arrow', text: '→' }));
      rowBox.appendChild(dirInput);
      rowBox.appendChild(
        smallBtn(
          '×',
          () => {
            const sec = { ...(table[section] ?? {}) };
            delete sec[key];
            table[section] = sec;
            rowBox.remove();
            dirty = true;
            paintDirty();
            paintIssues(issueBox);
            void rowsBox;
          },
          '删掉这一条',
        ),
      );
      if (section === '领域') {
        const dirRel = dirRelOf(String(table.领域?.[key] ?? ''), ctx.settings.kbRoot());
        rowBox.appendChild(statusLine(dirRel ? `（归位用：${dirRel}）` : '（不在库根下）'));
      }
      return rowBox;
    }

    async function addRow(section: RouteSection): Promise<void> {
      const key = await promptText({
        title: section === '领域' ? '加一条关键词别名' : '加一条标签落点',
        label: section === '领域' ? '关键词（文件名 / 正文里提到的词）' : '标签名',
        hint: section === '领域' ? '归位的启发层：文件名或正文标题提到它时，按这条落到对应目录' : undefined,
        validate: (v) => (v === '' ? '不能是空的' : null),
      });
      if (!key) return;
      const dir = await promptText({
        title: '落到哪个目录',
        label: '库内路径（写相对库根的也行，保存时补上库根）',
        value: '',
        primary: '加这一行',
      });
      if (dir == null) return;
      table[section] = { ...(table[section] ?? {}), [key]: vaultPathOf(dir, ctx.settings.kbRoot()) };
      dirty = true;
      api.rerender();
    }

    function paintIssues(box: HTMLElement): void {
      while (box.firstChild) box.removeChild(box.firstChild);
      const issues = checkRoutes(table, {
        exists: (p) => ctx.app.vault.getAbstractFileByPath(p) != null,
        kbRoot: ctx.settings.kbRoot(),
      });
      box.appendChild(group('体检'));
      // “N 个错误 · N 个提醒”是改表后的**动态反馈** → 状态行（不吃「显示说明」，见 logs.ts 同款注释）
      box.appendChild(statusLine(summarizeIssues(issues)));
      if (issues.length === 0) {
        box.appendChild(emptyLine('目录都在、值都在值域里、没有重复落点 ✅'));
        return;
      }
      for (const i of issues) box.appendChild(div({ cls: ['kbw-set-note', issueClass(i)], text: i.msg }));
    }

    async function save(): Promise<void> {
      const issues = checkRoutes(table, {
        exists: (p) => ctx.app.vault.getAbstractFileByPath(p) != null,
        kbRoot: ctx.settings.kbRoot(),
      });
      const errs = issues.filter((i) => i.level === 'error');
      if (errs.length > 0) {
        const res = await confirm({
          title: `体检有 ${errs.length} 个错误，仍要保存吗`,
          preview: [],
          warnings: errs.slice(0, 4).map((e) => e.msg),
          notes: ['保存不会拦住你 —— 表是给人改的', '但落点目录不存在时，自动归位会跳过那些笔记'],
          primary: { label: '仍然保存' },
        });
        if (res.action !== 'primary') return;
      }
      try {
        await writeRouteTable(ctx.app, ctx.settings, table);
        dirty = false;
        draft = null;
        notifyLight(
          '目录映射已保存',
          `${Object.keys(table.标签 ?? {}).length} 条标签 · ${Object.keys(table.领域 ?? {}).length} 条别名`,
        );
        api.ctx.index.rebuild();
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
  }
}

function summarizeIssues(issues: RouteIssue[]): string {
  if (issues.length === 0) return '全部通过 ✅';
  const n = (lv: RouteIssue['level']): number => issues.filter((i) => i.level === lv).length;
  return `${n('error')} 个错误 · ${n('warn')} 个提醒 · ${n('info')} 条说明`;
}

function issueClass(i: RouteIssue): string {
  return i.level === 'error' ? 'is-error' : i.level === 'warn' ? 'is-warn' : 'is-info';
}

function warnNote(text: string): HTMLElement {
  return div({ cls: 'kbw-set-note is-warn', text });
}
