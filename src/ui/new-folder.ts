/**
 * ui/new-folder.ts —— 「新建文件夹」（B1，用户 2026-09-27 提：右键即可新建笔记或文件夹）
 *
 * **怎么建**：走 `adapter.mkdir`（**不是 `mover`**）—— 用户 2026-09-27 拍板。
 * 理由：一个空目录建错了，手动删掉即可，没有任何数据损失；这与「新建笔记」同级
 *（新建笔记同样不进快照）。P5 那条"骨架里的目录必须由 mover 建"说的是**重排时批量建的目录** ——
 * 那批目录是"一次搬动"的产物、要跟着那次快照一起还原；"用户手建一个空文件夹"不是一类。
 *
 * **P7.14（用户 2026-10-08 拍板）**：**向导第 1 步「新建」也归这一族** —— 造出这个对话框
 * 之外的第二个入口（`createEmptyFolder`，向导的「下一步」就是用户的确认动作，所以同样
 * 不过 confirm / 不进快照）。本文件的"轻量族"边界对两个入口都成立。
 *
 * 三条自查（每条都会**当场说清原因**，不让它变成"点了没反应"）：
 *   · 名字为空 / 全是非法字符 → 拒（Windows 上 `\ / : * ? " < > |` 不能进文件名）
 *   · 同目录下已经有同名的文件或目录 → 拒（**不覆盖、不静默改名**）
 *   · 以 `.` 开头 → 拒（点开头的目录整条不进工作台：建了它用户在插件里根本看不见）
 */
import type { WorkbenchContext } from '../core/context';
import { baseName, joinPath, normPath, parentDir, relativeTo } from '../core/paths';
import { sanitize } from '../services/completion';
import { NOTIFY_MS, notify, notifyError } from './notify';
import { promptText } from './prompt';

/** 目录名不能整段是这些（Windows 保留名，建出来平台也读不了） */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 目录名的**形状**问题（空 / 点开头 / 含 `\ / : * ? " < > |` / Windows 保留名）——
 * 没问题就 null。**撞名不在内**（两个入口的文案不同：对话框「已经有同名的了」、
 * 向导「想用它请切到用现成的」—— 撞名各自现读现查）。
 *
 * 纯函数：`wizard.ts` 与下面的对话框**共用同一份判据**，别各写一份。
 */
export function folderNameProblem(name: string): string | null {
  if (name === '') return '先给它取个名字';
  if (name.startsWith('.')) return '点开头的目录不会出现在工作台里（插件看不见它）';
  if (name !== sanitize(name)) return '名字里不能有 \\ / : * ? " < > |';
  if (RESERVED.test(name)) return `${name} 是 Windows 保留名，换一个`;
  return null;
}

/**
 * **只建一个空目录**（轻量族唯一落盘点）—— 「新建文件夹」对话框与向导第 1 步共用。
 *
 * `abs` = 要建的 **vault 绝对路径**（调用方自己换算：对话框给 `joinPath(库根, dirRel, 名字)`，
 * 向导第 1 步的名字本来就是"库的顶层"，直接用它）—— 两个入口的"相对谁"不同，
 * 换算留在各自手里比塞进这里清楚。
 *
 * 返回：`'created'` 建成了（自带成功通知，显示路径按当前库根相对化）· `'exists'` 已存在
 *（**没动它**，文案归调用方）· `'failed'` 失败（自带错误通知）。
 */
export async function createEmptyFolder(
  ctx: WorkbenchContext,
  abs: string,
): Promise<'created' | 'exists' | 'failed'> {
  const p = normPath(abs);
  // 第二道闸：缓存树可能是旧的（刚在哪建过 / 同步刚拉下来）→ 落盘前再问一次文件系统
  if (await ctx.app.vault.adapter.exists(p)) return 'exists';
  try {
    /**
     * 🔴 **走 `vault.createFolder`（平台层），不是裸 `adapter.mkdir`**（P7.14 真机反馈修正）：
     * 裸 mkdir 只落盘、**不进平台缓存也不发 create 事件** —— 向导刚建完的目录
     * `getAbstractFileByPath` 查不到：工作台喊"找不到库根目录（要点一下别的按钮才加载）"、
     * 新建笔记对话框的落点列表里也没有它（于是那一篇连 `文件位置` 都写不出来）。
     * `createFolder` 走 vault 层：缓存即刻登记 + 事件链照发。轻量族口径（不过 confirm /
     * 不进快照 / 无日志）一个字不变。
     */
    await ctx.app.vault.createFolder(p);
  } catch (e) {
    if (await ctx.app.vault.adapter.exists(p)) return 'exists'; // 竞态：刚好有人建了同名
    try {
      // 退路：父级还不存在这类少见形状（`adapter.mkdir` 一次建多级，S3 已验证）
      await ctx.app.vault.adapter.mkdir(p);
    } catch {
      notifyError('新建文件夹失败', e instanceof Error ? e.message : String(e));
      return 'failed';
    }
  }
  notify({
    kind: 'success',
    text: `已新建文件夹「${baseName(p)}」`,
    detail: relativeTo(p, ctx.settings.kbRoot()),
    ms: NOTIFY_MS.light,
  });
  return 'created';
}

/**
 * 在 `dirRel`（**相对库根**，'' = 库根）下新建一个文件夹。
 * 返回新文件夹的**相对库根路径**（取消 / 失败 = null）—— 调用方拿它去"跳进去"。
 */
export async function openNewFolderDialog(
  ctx: WorkbenchContext,
  dirRel: string,
): Promise<string | null> {
  const kbRoot = ctx.settings.kbRoot();
  const parentAbs = joinPath(kbRoot, dirRel);
  const parentRel = dirRel || kbRoot || '库根';

  /** 同目录下已经有的名字（缓存树 + 适配器两边都问 —— 刚建出来的目录可能还没进缓存） */
  const taken = new Set<string>();
  for (const f of ctx.app.vault.getAllLoadedFiles()) {
    /**
     * ⚠️ 顶层比较用**纯路径**（`parentDir(f.path)`），不用 `f.parent?.path`：
     * 库顶层两边都不可靠 —— 离线桩的顶层条目 `parent = null`，真机上平台根是 `'/'` 而不是 `''`。
     */
    if (parentDir(f.path) === parentAbs) taken.add(f.name);
  }

  const name = await promptText({
    title: '新建文件夹',
    label: `在 ${parentRel} 下`,
    placeholder: '文件夹名',
    primary: '新建',
    hint:
      '只建一个空目录（不进快照：建错了在文件列表里删掉即可）；' +
      '建完直接进到里面 —— 目录树与网格都画真实目录，进去就能看见它',
    validate: (v) => folderNameProblem(v) ?? (taken.has(v) ? '这个目录下已经有同名的了' : null),
  });
  if (name == null) return null;

  const rel = joinPath(dirRel, name);
  const r = await createEmptyFolder(ctx, joinPath(parentAbs, name));
  if (r === 'exists') {
    notifyError('已经有同名的了', `${rel} 已存在，没有动它`);
    return null;
  }
  if (r === 'failed') return null;
  return rel;
}
