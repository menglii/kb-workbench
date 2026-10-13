/**
 * ui/settings/templates.ts —— 设置 · **模板库**栏（交互规格 §7.2）
 *
 * | 项 | 行为 |
 * | 模板列表 | 读 `99_Meta/02_模板库/Templater/*.md` |
 * | 编辑 | 点开 → **直接用 Obsidian 打开那个 `.md`**（同一份文件，不是副本） |
 * | 另存为新模板 | 落在模板库目录 |
 * | 从笔记提取… | 选一篇笔记 → 抽成模板（**占位化**：H1 → `{{title}}`、`创建日期` → `{{date}}`） |
 * | 删除 | 走回收站（经 `mover.trash`，带快照） |
 *
 * ⚠️ 两处「动文件」都走唯一出口：删除走 `services/mover.ts`（三条硬规矩之一），
 * 新建/另存为是**新建**（不移动、不覆盖），走 `vault.create` + `markSelfWrite`。
 */
import type { TFile } from 'obsidian';
import type { WorkbenchContext } from '../../core/context';
import { joinPath, relativeTo } from '../../core/paths';
import { markSelfWrite } from '../../core/writes';
import { extractTemplate, templateFileName, templateFiles } from '../../services/templates';
import { btn, div } from '../primitives';
import { confirm } from '../confirm';
import { pickOne, promptText } from '../prompt';
import { NOTIFY_MS, notify, notifyLight } from '../notify';
import { emptyLine, group, row, setTitle, smallBtn, toolbar } from './kit';
import type { SectionApi, SettingsBlock } from './types';

export function makeTemplatesSection(): SettingsBlock {
  return {
    label: '模板库',
    sub: '列表 · 编辑 · 另存为 · 从笔记提取 · 删除',
    render(host, api) {
      void paint(host, api);
    },
  };
}

async function paint(host: HTMLElement, api: SectionApi): Promise<void> {
  const ctx = api.ctx;
  const dir = ctx.settings.templateDir();
  host.appendChild(setTitle('模板库', `库内目录：${dir}（模板就是普通 .md，改它 = 改库里的文件）`));

  host.appendChild(
    toolbar(
      btn({
        cls: 'kbw-btn is-small',
        text: '＋ 新建空白模板',
        on: { click: () => void newBlank(ctx, api) },
      }),
      btn({
        cls: 'kbw-btn is-small',
        text: '从笔记提取…',
        on: { click: () => void extractFrom(ctx, api) },
      }),
      btn({
        cls: 'kbw-btn is-small is-ghost',
        text: '在系统资源管理器中打开',
        on: { click: () => revealDir(ctx, dir) },
      }),
    ),
  );

  const available = templateFiles(ctx.app, ctx.settings);
  const all = listTemplates(ctx);
  host.appendChild(
    group(
      '模板',
      `${available.length} 个可用模板` +
        (all.length > available.length ? `（另有 ${all.length - available.length} 个脚本类，不参与套用）` : ''),
    ),
  );

  if (all.length === 0) {
    host.appendChild(emptyLine('模板库目录里还没有文件。可以「新建空白模板」，或从一篇笔记提取。'));
    return;
  }

  for (const f of all) {
    const isScript = !available.includes(f);
    const text = await safeRead(ctx, f);
    const usesTemplater = /<%.*?%>/s.test(text);
    const control = div({ cls: 'kbw-set-actions' });
    control.appendChild(
      smallBtn(
        '编辑',
        () => void ctx.app.workspace.getLeaf('tab').openFile(f),
        '用 Obsidian 打开这个 .md（同一份文件，不是副本）',
      ),
    );
    control.appendChild(smallBtn('另存为…', () => void saveAs(ctx, api, f)));
    control.appendChild(
      smallBtn('删除', () => void removeTemplate(ctx, api, f), '走回收站（可以先在快照面板里还原）'),
    );
    const tags: string[] = [];
    if (isScript) tags.push('脚本类（不参与套用）');
    if (usesTemplater) tags.push('含 <% %>（要 Templater 求值）');
    host.appendChild(
      row(
        f.basename,
        control,
        [tags.join(' · '), `改动于 ${new Date(f.stat?.mtime ?? 0).toLocaleString()}`]
          .filter(Boolean)
          .join(' · '),
      ),
    );
  }

  host.appendChild(
    div({
      cls: 'kbw-set-note is-info',
      text:
        '套用规则在「自动化」栏：标签规则 → 文件夹规则（Templater 目录模板，最长前缀）→ 当前模板兜底。' +
        '含 <% %> 的模板由 Templater 求值；它不在、或没求到时，本插件跳过不动手。',
    }),
  );
}

/** 目录下**全部** .md（含 `T_智能新建` 这种脚本类 —— 列表里也要能编辑/删除它） */
function listTemplates(ctx: WorkbenchContext): TFile[] {
  const node = ctx.app.vault.getAbstractFileByPath(ctx.settings.templateDir());
  const children = (node as unknown as { children?: unknown[] } | null)?.children;
  if (!Array.isArray(children)) return [];
  return (children as TFile[])
    .filter((c) => c && typeof c === 'object' && 'extension' in c && c.extension === 'md')
    .sort((a, b) => a.basename.localeCompare(b.basename, 'zh'));
}

async function safeRead(ctx: WorkbenchContext, f: TFile): Promise<string> {
  try {
    return await ctx.app.vault.cachedRead(f);
  } catch {
    return '';
  }
}

async function revealDir(ctx: WorkbenchContext, dirPath: string): Promise<void> {
  const fn = (ctx.app as unknown as { showInFolder?: (p: string) => Promise<void> }).showInFolder;
  if (typeof fn !== 'function') return;
  try {
    await fn.call(ctx.app, dirPath);
  } catch (e) {
    console.error('[经纬] 打开系统资源管理器失败', e);
  }
}

async function newBlank(ctx: WorkbenchContext, api: SectionApi): Promise<void> {
  const name = await promptText({
    title: '新建空白模板',
    label: '模板名（会自动加 T_ 前缀）',
    placeholder: 'T_我的模板',
    primary: '创建',
  });
  if (!name) return;
  const path = await uniqueTemplatePath(ctx, name);
  markSelfWrite(path);
  const file = await ctx.app.vault.create(path, '# {{title}}\n');
  notifyLight(`已新建模板 ${file.basename}`, '打开它写正文骨架；{{title}} 是占位符');
  await ctx.app.workspace.getLeaf('tab').openFile(file);
  api.rerender();
}

async function saveAs(ctx: WorkbenchContext, api: SectionApi, file: TFile): Promise<void> {
  const name = await promptText({
    title: `另存为（复制 ${file.basename}）`,
    label: '新模板名',
    value: `${file.basename}_副本`,
    primary: '另存为',
  });
  if (!name) return;
  const path = await uniqueTemplatePath(ctx, name);
  const text = await ctx.app.vault.read(file);
  markSelfWrite(path);
  const made = await ctx.app.vault.create(path, text);
  notifyLight(`已另存为 ${made.basename}`);
  api.rerender();
}

async function removeTemplate(ctx: WorkbenchContext, api: SectionApi, file: TFile): Promise<void> {
  const res = await confirm({
    title: `即将把「${file.basename}」删到回收站`,
    preview: [{ kind: 'delete', where: ctx.settings.templateDir(), count: 1 }],
    warnings: [],
    notes: ['先拍快照；还原在快照面板里', '删除之后「套用规则」若指着它，会落到兜底模板'],
    danger: { confirmLabel: '再点一次确认', irreversible: ctx.mover.trashOption() !== 'local' },
    primary: { label: '删除' },
  });
  if (res.action !== 'primary') return;
  const r = await ctx.mover.trash({
    files: [file],
    source: 'template',
    reason: `删除模板：${file.basename}`,
  });
  if (r.trashed.length > 0) notifyLight(`已删除模板 ${file.basename}`);
  else {
    notify({
      kind: 'partial',
      text: '没能删掉',
      detail: r.skipped.map((s) => s.note).join('；'),
      ms: NOTIFY_MS.long,
    });
  }
  api.rerender();
}

async function extractFrom(ctx: WorkbenchContext, api: SectionApi): Promise<void> {
  const notes = ctx.index
    .notes()
    .slice()
    .sort((a, b) => a.basename.localeCompare(b.basename, 'zh'));
  if (notes.length === 0) {
    notify({ kind: 'info', text: '库里还没有笔记可提取', ms: NOTIFY_MS.info });
    return;
  }
  const picked = await pickOne({
    title: '从笔记提取模板',
    sub: '选一篇笔记 → 抽成模板（H1 换 {{title}}、创建日期换 {{date}}，其余原样）',
    items: notes,
    label: (e) => e.basename,
    detail: (e) => relativeTo(e.path, ctx.settings.kbRoot()),
    searchOf: (e) => `${e.basename} ${relativeTo(e.path, ctx.settings.kbRoot())}`,
    empty: '没有匹配的笔记',
  });
  if (!picked) return;

  const text = await ctx.app.vault.read(picked.file);
  const { text: tplText, replaced } = extractTemplate(text);
  const name = await promptText({
    title: '模板名',
    label: '抽出来的模板叫什么',
    value: `T_${picked.basename}`,
    primary: '创建',
  });
  if (!name) return;
  const path = await uniqueTemplatePath(ctx, name);
  markSelfWrite(path);
  const made = await ctx.app.vault.create(path, tplText);
  notify({
    kind: 'success',
    text: `已提取成模板 ${made.basename}`,
    detail: replaced.length > 0 ? `占位化：${replaced.join('、')}` : '没有可占位化的地方（原样复制）',
    ms: NOTIFY_MS.library,
  });
  await ctx.app.workspace.getLeaf('tab').openFile(made);
  api.rerender();
}

/**
 * 模板目录里的唯一路径（`T_<名>.md`，重名加序号；目录不在就建）。
 * **导出给「新建笔记」对话框的「＋ 新建模板…」共用**（P7.9 · ②）——
 * 两条入口（设置栏 / 对话框）各写一份一定会漂。
 */
export async function uniqueTemplatePath(ctx: WorkbenchContext, rawName: string): Promise<string> {
  const base = templateFileName(rawName) || 'T_新模板.md';
  const dir = ctx.settings.templateDir();
  let candidate = joinPath(dir, base);
  let n = 2;
  while (ctx.app.vault.getAbstractFileByPath(candidate)) {
    candidate = joinPath(dir, base.replace(/\.md$/i, ` ${n}.md`));
    n += 1;
    if (n > 500) break;
  }
  if (!(await ctx.app.vault.adapter.exists(dir))) await ctx.app.vault.adapter.mkdir(dir);
  return candidate;
}
