/**
 * core/paths.ts —— 路径工具
 *
 * 库里一律用**正斜杠**的相对库根路径（Obsidian 的规范形式）。
 * 单独一个文件是为了让 core/services 不必反向依赖 ui/primitives。
 */

/** 统一写法：反斜杠转正斜杠、合并重复斜杠、去掉首尾斜杠 */
export function normPath(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function joinPath(...parts: (string | undefined | null)[]): string {
  return normPath(parts.filter((p) => p != null && p !== '').join('/'));
}

export function parentDir(p: string): string {
  const n = normPath(p);
  const i = n.lastIndexOf('/');
  return i < 0 ? '' : n.slice(0, i);
}

export function baseName(p: string): string {
  const n = normPath(p);
  const i = n.lastIndexOf('/');
  return i < 0 ? n : n.slice(i + 1);
}

export function stripExt(name: string): string {
  return name.replace(/\.[^./]+$/, '');
}

/** 取扩展名（小写，不含点） */
export function extOf(p: string): string {
  const m = baseName(p).match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

/** 路径是否在某个目录下（含自身） */
export function isInside(path: string, dir: string): boolean {
  const p = normPath(path);
  const d = normPath(dir);
  if (!d) return true;
  return p === d || p.startsWith(d + '/');
}

/**
 * 「在知识库范围内」的**唯一谓词**（P7.14）：在 `kbRoot` 之下、且没有任何 `.` 开头的
 * 路径段（`.obsidian` / `.trash` 这类整条不算）。
 * `kbRoot=''`（整个库）= 全库（除点开头）——这是有意的，别当成"没配"。
 *
 * 收编此前散在四处的同一份口径（vault-index 的 inScope / editor-menu 的 underKbRoot /
 * new-note 的目录候选 / automation 的排除候选）——**别在别处再写前缀判断**
 *（手拼 `` `${kbRoot}/` `` 在空串根下会恒 false，这条有静态红线盯着）。
 */
export function inKbScope(path: string, kbRoot: string): boolean {
  const p = normPath(path);
  if (!isInside(p, kbRoot)) return false;
  return !p.split('/').some((seg) => seg.startsWith('.'));
}

/** 逐级列出祖先目录（从顶层到自身） */
export function ancestors(path: string): string[] {
  const parts = normPath(path).split('/').filter(Boolean);
  const out: string[] = [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

/** 文件名安全化（Windows 上不能出现 `\ / : * ? " < > |`） */
export function sanitizeFileName(name: string, max = 60): string {
  const out = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (out.length > max ? out.slice(0, max) : out) || 'x';
}

/** 路径末段安全化（保目录，只清洗文件名） */
export function sanitizePath(p: string, maxSegment = 60): string {
  return normPath(p)
    .split('/')
    .filter(Boolean)
    .map((seg) => sanitizeFileName(seg, maxSegment))
    .join('/');
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 相对化：把 vault 绝对路径转成相对库根的路径。
 * 健康标记的 `文件位置` 断言就是拿这个跟声明比。
 */
export function relativeTo(path: string, root: string): string {
  const p = normPath(path);
  const r = normPath(root);
  if (!r) return p;
  if (p === r) return '';
  return p.startsWith(r + '/') ? p.slice(r.length + 1) : p;
}
