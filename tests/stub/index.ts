/**
 * tests/stub/index.ts —— 桩 obsidian + 真挂载链的 App
 *
 * 这个文件**冒充 `obsidian` 模块**（esbuild 别名把它换进来），所以它必须导出
 * 插件源码真正 import 的那几个东西：Plugin / ItemView / TFile / TFolder /
 * PluginSettingTab / Setting / setIcon。
 *
 * 三条自我约束（都来自 `obsidian-plugin-dev` 的验证章节）：
 *  ① **必须走真挂载链** —— 视图经 `plugin.registerView` 注册、`leaf.setViewState` 实例化、
 *     `onOpen()` 真的被调到。手调自己新写的函数 = 假绿。
 *  ② **DOM 必须镜像真机容器属性** —— containerEl 带 `data-type="<视图类型>"`，
 *     这样"用属性选择器做作用域"的写法在离线测试里也能命中。
 *  ③ **文件系统是真的** —— 桩 vault 直接读写磁盘（测试用临时副本），
 *     `renameFile` 撞名真的抛 `Destination file already exists!`（S2 实测行为），
 *     双链真的被同步改写。这样 mover / snapshot 的行为才是真被验过的。
 */
import fs from 'node:fs';
import path from 'node:path';

// ────────────────────────────────────────────────────────────────
// 文件模型
// ────────────────────────────────────────────────────────────────
export class TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null = null;
  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
  }
}

export class TFile extends TAbstractFile {
  stat: { ctime: number; mtime: number; size: number };
  basename: string;
  extension: string;
  constructor(p: string, stat: { ctime: number; mtime: number; size: number }) {
    super(p);
    this.stat = stat;
    this.extension = p.match(/\.([^.]+)$/)?.[1] ?? '';
    this.basename = this.name.replace(/\.[^.]+$/, '');
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

// ────────────────────────────────────────────────────────────────
// YAML 子集解析/序列化（测试专用；**生产代码不解析 YAML**，属性一律问 metadataCache）
// ────────────────────────────────────────────────────────────────
export function parseFrontmatter(text: string): Record<string, unknown> | null {
  if (!text.startsWith('---')) return null;
  const lines = text.split('\n');
  if (lines[0].trimEnd() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const fm: Record<string, unknown> = {};
  let currentKey: string | null = null;
  for (let i = 1; i < end; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const item = raw.match(/^\s*-\s*(.*)$/);
    if (item && currentKey) {
      const prev = fm[currentKey];
      const arr = Array.isArray(prev) ? prev : [];
      arr.push(scalar(item[1]));
      fm[currentKey] = arr;
      continue;
    }
    const kv = raw.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    currentKey = key;
    if (val === '') {
      fm[key] = null;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(scalar);
    } else if (val.startsWith('{') && val.endsWith('}')) {
      /**
       * **YAML 流式映射**（`创建日期: {{date}}` 这种）。真机（js-yaml）把它解析成**对象**，
       * 而 `processFrontMatter` 的往返会把它改形成嵌套块（P2 真机实测 4 篇）。
       * 🔴 桩原先一律走 `scalar()` 当字符串 —— 于是「非标量守卫」（17.2）在离线判据里
       * **永远不会命中**（"桩比真机宽松"的第 N 次复发）。这里照实模拟：
       * 解析成 `FlowMap`（对象），序列化时写成嵌套块（原文形状确实回不去）。
       */
      fm[key] = new FlowMap(val);
    } else {
      fm[key] = scalar(val);
    }
  }
  return fm;
}

/**
 * YAML 流式映射的桩内表示。`toString()` 保留原文 —— 别处 `String(v)` 的地方不至于变 `[object Object]`。
 * ⚠️ 它必须**不是数组**：17.2 的守卫判据是「对象且非数组」。
 */
export class FlowMap {
  constructor(readonly raw: string) {}
  toString(): string {
    return this.raw;
  }
}

function scalar(s: string): unknown {
  const t = s.replace(/^["']|["']$/g, '');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

export function serializeFrontmatter(fm: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
        continue;
      }
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${String(item)}`);
    } else if (v == null) {
      lines.push(`${k}:`);
    } else if (v instanceof FlowMap) {
      /**
       * 流式映射被"解析再序列化"之后的样子（真机 P2 实测的形状：变成嵌套块、
       * 原文 `{{date}}` 再也回不去）。写在这里是为了**让离线突变能看见改形** ——
       * 守卫关掉时，这一篇的文本会当场变形（判据里断言的就是它一字节没动）。
       */
      lines.push(`${k}:`);
      lines.push(`  "{ ${v.raw.slice(1, -1).replace(/[{}]/g, '').trim()} }":`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n${body}`;
}

export function splitFrontmatter(text: string): { fm: Record<string, unknown> | null; body: string } {
  const fm = parseFrontmatter(text);
  if (!fm) return { fm: null, body: text };
  const lines = text.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === '---') {
      end = i;
      break;
    }
  }
  return { fm, body: lines.slice(end + 1).join('\n') };
}

// ────────────────────────────────────────────────────────────────
// 链接抽取（够用就行：双链与嵌入）
// ────────────────────────────────────────────────────────────────
export interface LinkCacheLike {
  link: string;
  original: string;
  displayText?: string;
}

export function extractLinks(text: string): { links: LinkCacheLike[]; embeds: LinkCacheLike[] } {
  const links: LinkCacheLike[] = [];
  const embeds: LinkCacheLike[] = [];
  const re = /(!?)\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const isEmbed = m[1] === '!';
    const inner = m[2];
    const link = inner.split('|')[0].split('#')[0].trim();
    const item = { link, original: m[0], displayText: inner.includes('|') ? inner.split('|')[1] : undefined };
    if (isEmbed) embeds.push(item);
    else links.push(item);
  }
  return { links, embeds };
}

// ────────────────────────────────────────────────────────────────
// 事件（平台用 EventRef + offref，这里跟着做）
// ────────────────────────────────────────────────────────────────
export interface EventRef {
  __id: number;
}

type Handler = (...args: unknown[]) => void;

class Emitter {
  private map = new Map<string, Map<number, Handler>>();
  private seq = 1;

  /**
   * **还挂着几个处理器**（按事件名）。
   *
   * 为什么要暴露它：真机上"注册了没注销"是**看不见**的（不报错、只是慢慢漏），
   * 而 d 期独立审查 🟡5 正是靠数这个抓到"关面板的短路路径全漏 dispose →
   * 每关一次累加一对 vault 监听"。没有这条判据，那种漏在离线也测不出来。
   */
  count(name?: string): number {
    if (name) return this.map.get(name)?.size ?? 0;
    let n = 0;
    for (const bucket of this.map.values()) n += bucket.size;
    return n;
  }

  on(name: string, handler: Handler): EventRef {
    const id = this.seq++;
    const bucket = this.map.get(name) ?? new Map<number, Handler>();
    bucket.set(id, handler);
    this.map.set(name, bucket);
    return { __id: id };
  }

  offref(ref: EventRef | undefined | null): void {
    if (!ref) return;
    for (const bucket of this.map.values()) bucket.delete(ref.__id);
  }

  trigger(name: string, ...args: unknown[]): void {
    const bucket = this.map.get(name);
    if (!bucket) return;
    for (const handler of Array.from(bucket.values())) {
      try {
        handler(...args);
      } catch (e) {
        console.error(`[stub] ${name} 处理器抛错`, e);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

// ────────────────────────────────────────────────────────────────
// Vault（真读真写磁盘）
// ────────────────────────────────────────────────────────────────
export class StubAdapter {
  constructor(private root: string) {}

  private abs(p: string): string {
    return path.join(this.root, p.replace(/^\/+/, ''));
  }

  async exists(p: string): Promise<boolean> {
    return fs.existsSync(this.abs(p));
  }

  async read(p: string): Promise<string> {
    return fs.readFileSync(this.abs(p), 'utf8');
  }

  /** 二进制读（P7.6：孤儿/重复判据要按**字节**哈希；utf8 往返会吃掉非文本文件） */
  async readBinary(p: string): Promise<ArrayBuffer> {
    const buf = fs.readFileSync(this.abs(p));
    // 拷一份独立 ArrayBuffer（Node 的 Buffer 可能是池化切片，offset 不为 0）
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async write(p: string, data: string): Promise<void> {
    const abs = this.abs(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data, 'utf8');
    /**
     * **写过的路径全都记下来**（P6 收尾按独立审查 🔴1 补）。
     *
     * 为什么非要有它：原来 `P6 · 图谱` 那条用例断言的是桩上那个
     * `wroteConfig = false` 字段 —— 而**全仓库没有任何一处写过它**（只有声明和初值），
     * 于是那条断言**恒真**。它的文案写的是"没写配置文件（程序化注入不落盘）"，
     * 读的人会以为"不落盘"这件事离线验过了。
     * 现在改成**观察真实写入**：谁往 `.obsidian/` 里写了什么，这里都留下痕迹。
     */
    this.writes.push(p);
  }

  /** 走过的每一次 `write`（断言"某条路一个字节都没写"用） */
  writes: string[] = [];

  /**
   * 平台把**库内路径**转成 `app://` 资源地址（真机行为，P7.2b 向导配图用到）。
   * 桩只需要**形状对**：离线判据只看"src 是不是指向 assets/wizard/xx.png"——
   * 所以**不做 URL 编码**（编码会把 `/` 也吃掉，includes 判据全废）。
   */
  getResourcePath(p: string): string {
    return `app://local/${p}`;
  }

  /** S3 实测：平台的一次 mkdir 能建多级 —— 桩跟着照做 */
  async mkdir(p: string): Promise<void> {
    fs.mkdirSync(this.abs(p), { recursive: true });
  }

  async rmdir(p: string, recursive: boolean): Promise<void> {
    const abs = this.abs(p);
    if (!fs.existsSync(abs)) throw new Error(`ENOENT: ${p}`);
    /**
     * 🔴 **真机口径是 `fs.rm`，不是 `fs.rmdir`**（P5 真机探针实测 + 报错原文取证）：
     * `adapter.rmdir(dir, false)` 删目录会抛
     * `SystemError [ERR_FS_EISDIR]: Path is a directory: rm returned EISDIR ...`
     * —— `fs.rm` 删目录**必须** `recursive: true`。
     *
     * ⚠️ 这里原先写的是 `fs.rmdirSync`（"删空目录、非空报 ENOTEMPTY"）—— 那**不是**平台的行为，
     * 而且比真机**宽松**：于是"还原时删掉本次新建的空目录"这条判据**离线恒绿、真机从来没成过**
     *（P5 收尾探针抓到，实验库里留了一副空骨架）。桩必须与真机同宽 —— 这是第 N 次
     * "桩比真机宽松 = 假绿" 的复发。
     */
    if (recursive) fs.rmSync(abs, { recursive: true, force: false });
    else fs.rmSync(abs, { recursive: false, force: false }); // ← 目录会抛 ERR_FS_EISDIR，与真机一致
  }

  /**
   * **改名/移动**（独立审查 A🟡3 补）：真机的 `DataAdapter` 有它（asar 取证：
   * `fsPromises.rename` 之后更新内部表、并对目录**连后代逐个** `trigger("renamed", 新, 旧)`
   * → vault 侧跟着重建缓存树），而桩原先**没有** —— 于是 `renameEmptyDir` 那条路
   * 离线会当场 `TypeError`（被 catch 吃掉、弹"重命名失败"），**既测不出也跑不通**。
   * 口径与真机同宽：先 `renameSync`，再 `scan()` 重建缓存树。
   */
  async rename(from: string, to: string): Promise<void> {
    const a = this.abs(from);
    const b = this.abs(to);
    if (!fs.existsSync(a)) throw new Error(`ENOENT: ${from}`);
    // ⚠️ 目标已存在时**不覆盖**（与 `fs.renameSync` 在 Windows 上的行为一致：抛 EEXIST/EPERM）
    if (fs.existsSync(b)) throw new Error(`EEXIST: ${to}`);
    fs.renameSync(a, b);
    // ⚠️ **缓存树的账归调用方**（与 `mkdir` / `rmdir` 同一口径：本桩不动缓存，
    // 用例自己 `app.vault.rescan()`）—— 真机那边由适配器的事件链自动更新。
  }

  async list(p: string): Promise<{ files: string[]; folders: string[] }> {
    const abs = this.abs(p);
    if (!fs.existsSync(abs)) throw new Error(`ENOENT: ${p}`);
    /**
     * ⚠️ 根级（`p=''`）**不许拼出 `/name`**（P7.14 修）：真机 `FileSystemAdapter.list('')`
     * 给的是库相对路径（`name`，无前导斜杠）—— 桩原先 `''.replace()+ '/' + name` 多了一个
     * 斜杠，而"整个库"模式起手就是 `list('')`（重排的 `vaultShapeOf` 也从这里起步），
     * 会把"桩比真机多一段"混进判据。
     */
    const base = p.replace(/^\/+|\/+$/g, '');
    const join = (name: string): string => (base ? `${base}/${name}` : name);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return {
      files: entries.filter((e) => e.isFile()).map((e) => join(e.name)),
      folders: entries.filter((e) => e.isDirectory()).map((e) => join(e.name)),
    };
  }

  async stat(p: string) {
    const s = fs.statSync(this.abs(p));
    return { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size, type: s.isDirectory() ? 'folder' : 'file' };
  }

  async remove(p: string): Promise<void> {
    fs.rmSync(this.abs(p));
  }
}

export class StubVault extends Emitter {
  adapter: StubAdapter;
  private root: string;
  private byPath = new Map<string, TAbstractFile>();
  private trashOption: 'system' | 'local' | 'none' = 'system';

  constructor(root: string) {
    super();
    this.root = path.resolve(root);
    this.adapter = new StubAdapter(this.root);
    this.scan();
  }

  // ── 索引 ──
  private scan(): void {
    this.byPath.clear();
    const walk = (rel: string, parent: TFolder | null): void => {
      const abs = path.join(this.root, rel);
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue; // .obsidian / .trash / .tooling 不进索引
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          const folder = new TFolder(childRel);
          folder.parent = parent;
          parent?.children.push(folder);
          this.byPath.set(childRel, folder);
          walk(childRel, folder);
        } else {
          const absFile = path.join(this.root, childRel);
          const stat = fs.statSync(absFile);
          const file = new TFile(childRel, { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size });
          file.parent = parent;
          /**
           * 🔴 **`children` 也要挂上**（P6② 独立审查 B 路 §2.6 抓的）：
           * 桩原先只挂 `byPath` 与 `parent`，`TFolder.children` 是**恒空数组** ——
           * 于是所有"按 `dir.children` 取东西"的代码在离线**恒返回空表**
           * （`templateFiles()` 的 4 个调用方、模板下拉、选模板那些面板…），
           * 「模板下拉的第一项是不是默认项」这类判据退化成**自证**（下拉里只有一项）。
           * 这是"桩比真机**少**一块数据模型"的形态：不是宽松也不是严格，是**缺** ——
           * 它让判据静默变成空跑，比"宽松"更难发现。
           */
          parent?.children.push(file);
          this.byPath.set(childRel, file);
        }
      }
    };
    if (fs.existsSync(this.root)) walk('', null);
  }

  rescan(): void {
    this.scan();
    // 新出现的文件"早就存在"了：补进 metadataCache（真机上它们早被解析过）。
    // ⚠️ 这不违反滞后模型 —— 滞后说的是**写盘之后**的重解析（`writeRaw` → `invalidate`）。
    this.metadata?.primeUnknown();
    /**
     * 🔴 **P7.16 补课：盘上没了的文件，缓存也要跟着去掉**（`primeUnknown` 的**对称另一半**）——
     * 真机上删文件会发 `delete` 事件（缓存随之清掉）；而用例的"安全删法"是裸
     * `fs.rmSync` + `rescan`，原先不落这一半 → **同一个路径下一次被重建、内容不同**时，
     * 缓存里还挂着上一份（P7.16 实测：属性块判据读到的是**上一轮**的值，排查半天）。
     */
    this.metadata?.forgetMissing(new Set(this.byPath.keys()));
  }

  getRoot(): string {
    return this.root;
  }

  getConfig(key: string): unknown {
    if (key === 'trashOption') return this.trashOption;
    return null;
  }

  setConfig(key: string, value: unknown): void {
    if (key === 'trashOption') this.trashOption = value as 'system' | 'local' | 'none';
  }

  getAbstractFileByPath(p: string): TAbstractFile | null {
    return this.byPath.get(p.replace(/^\/+|\/+$/g, '')) ?? null;
  }

  /**
   * P7.17 补课：平台有 `getFolderByPath`（P7.15 真机取证里点名过这个口）——
   * 存量补齐的「文件位置指向不存在的目录」分档用它；只认**真的目录节点**，
   * 路径上蹲着一篇文件时返回 null（与平台一致）。
   */
  getFolderByPath(p: string): TFolder | null {
    const node = this.byPath.get(p.replace(/^\/+|\/+$/g, '')) ?? null;
    return node instanceof TFolder ? node : null;
  }

  getMarkdownFiles(): TFile[] {
    return Array.from(this.byPath.values()).filter(
      (f): f is TFile => f instanceof TFile && f.extension === 'md',
    );
  }

  /** 全库文件（含附件）—— 真机口径；P7.6 的孤儿/重复判据要用 */
  getFiles(): TFile[] {
    return Array.from(this.byPath.values()).filter((f): f is TFile => f instanceof TFile);
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return Array.from(this.byPath.values());
  }

  async read(file: TFile): Promise<string> {
    return fs.readFileSync(path.join(this.root, file.path), 'utf8');
  }

  /** 同步读（桩内部用：MarkdownView 的 `editor.getValue` 是同步 API） */
  readSync(p: string): string {
    try {
      return fs.readFileSync(path.join(this.root, p), 'utf8');
    } catch {
      return '';
    }
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const before = await this.read(file);
    const after = fn(before);
    this.writeRaw(file.path, after);
    return after;
  }

  private writeRaw(p: string, text: string): void {
    const abs = path.join(this.root, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    const stat = fs.statSync(abs);
    const existing = this.byPath.get(p);
    if (existing instanceof TFile) {
      existing.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
    } else {
      const file = new TFile(p, { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size });
      /**
       * ⚠️ **children 也要挂上**（与 `scan()` 里那条"桩比真机少一块"同形的补课，P7.9 · ②）：
       * 桩原先只在 `scan()` 时挂 children —— 动态 `create()` 出来的文件对 `dir.children`
       * **不可见**（真机建完就进树）。P7.9 的「＋ 新建模板…」判据第一版就栽在这：
       * 建完 `templateFiles()` 扫不到新模板，下拉"刷新并选中"永远选不中。
       */
      const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      const parent = this.byPath.get(parentPath);
      if (parent instanceof TFolder) {
        file.parent = parent;
        parent.children.push(file);
      }
      this.byPath.set(p, file);
      this.trigger('create', file);
    }
    this.trigger('modify', this.byPath.get(p));
    this.metadata?.invalidate(this.byPath.get(p) as TFile);
  }

  async create(p: string, data: string): Promise<TFile> {
    const norm = p.replace(/^\/+/, '');
    if (this.byPath.has(norm) || fs.existsSync(path.join(this.root, norm))) {
      throw new Error('File already exists.');
    }
    const dir = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
    if (dir && !fs.existsSync(path.join(this.root, dir))) {
      throw new Error(`ENOENT: no such file or directory, open '${norm}'`);
    }
    this.writeRaw(norm, data);
    return this.byPath.get(norm) as TFile;
  }

  async createFolder(p: string): Promise<TFolder> {
    /** 记下建之前的目录集合 —— 下面按"新出现的文件夹"逐个发 create（真机口径） */
    const before = new Set(
      Array.from(this.byPath.values())
        .filter((f): f is TFolder => f instanceof TFolder)
        .map((f) => f.path),
    );
    fs.mkdirSync(path.join(this.root, p), { recursive: true });
    this.scan();
    /**
     * 🔴 **P7.16 补课：`createFolder` 要发 `create` 事件**（"桩比真机少一块"的又一枚）——
     * 真机上它走平台层（`ui/new-folder.ts` 的注释就是为这个改的："缓存即刻登记 +
     * **事件链照发**"），而桩原先只 `scan()`、一个事件都不发 → 依赖
     * `vault.on('create')` 的产品路径（P7.16 小窗属性区的候选刷新就是它）离线**一次都不触发**，
     * 判据只能靠手动 rebuild 兜底 = 假绿。`recursive` 建出来的祖先目录也一并发
     *（真机上它们同样是"新出现的"，一起可见）。
     * ⚠️ **只给 `createFolder` 补**：`rescan()` 保持静默 —— 大量用例靠它"造完文件不触发事件"
     *（见 `helpers` 里那几处 `rescan()` + `index.rebuild()` 的配套）。
     */
    for (const f of this.byPath.values()) {
      if (f instanceof TFolder && !before.has(f.path)) this.trigger('create', f);
    }
    return this.byPath.get(p) as TFolder;
  }

  async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
    // 平台的签名是 delete(file, force?)，桩跟着收 —— 否则测试里传第二个参就编译不过
    fs.rmSync(path.join(this.root, file.path), { force: true });
    this.byPath.delete(file.path);
    // 与 `writeRaw` 的挂接对称：从父目录的 children 里摘掉，别留一个死对象
    const parent = file.parent;
    if (parent) parent.children = parent.children.filter((c) => c !== file && c.path !== file.path);
    this.metadata?.forget(file.path);
    this.trigger('delete', file);
  }

  /**
   * **模拟"别的程序改了库里的文件"**（真机上是 Obsidian 的文件监视器干的）：
   * 写盘 + 更新 stat + 发 `modify` + 安排 metadataCache 的滞后重解析。
   *
   * 与 `create` / `process` 的区别不是实现，是**语义**：调用方不会经过插件代码，
   * 所以没有 `markSelfWrite` → 索引会把它判成「外部改动」并打 `external-change`。
   * 桩原先只能靠 `rescan()`（**不发任何事件**），索引的事件驱动路径因此只被
   * 手动 trigger 覆盖过 —— 增量用例走这条才算真验。
   */
  simulateExternalWrite(p: string, text: string): TFile {
    const norm = p.replace(/^\/+|\/+$/g, '');
    this.writeRaw(norm, text);
    return this.byPath.get(norm) as TFile;
  }

  /** 别处把文件删了（同样只有事件，没有"我们自己调 delete"那层） */
  simulateExternalDelete(p: string): void {
    const norm = p.replace(/^\/+|\/+$/g, '');
    const f = this.byPath.get(norm);
    if (!f) return;
    fs.rmSync(path.join(this.root, norm), { force: true });
    this.byPath.delete(norm);
    this.metadata?.forget(norm);
    this.trigger('delete', f);
  }

  metadata?: StubMetadataCache;

  // ── 改名/搬移：按 S2 实测行为实现 ──
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    const from = file.path;
    const to = newPath.replace(/^\/+/, '');
    if (from === to) return;
    // 平台真的会抛这个（S2 实测：不覆盖、原子）
    if (this.byPath.has(to) || fs.existsSync(path.join(this.root, to))) {
      throw new Error('Destination file already exists!');
    }
    const dir = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
    if (dir && !fs.existsSync(path.join(this.root, dir))) {
      throw new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
    }
    const absFrom = path.join(this.root, from);
    const absTo = path.join(this.root, to);
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.renameSync(absFrom, absTo);
    this.byPath.delete(from);
    // 就地改 path（platform-pitfalls #18）
    file.path = to;
    file.name = to.split('/').pop() ?? to;
    if (file instanceof TFile) file.basename = file.name.replace(/\.[^.]+$/, '');
    this.byPath.set(to, file);
    // 缓存跟着文件走（否则新路径会"没解析过" → 属性读到空）
    this.metadata?.movePath(from, to);
    // 双链：平台在 rename 返回前就改完了（同步）
    if (file instanceof TFile) this.rewriteLinks(from, to, file.basename);
    this.trigger('rename', file, from);
  }

  private rewriteLinks(from: string, to: string, newBasename: string): void {
    const oldBasename = (from.split('/').pop() ?? from).replace(/\.[^.]+$/, '');
    if (oldBasename === newBasename) return;
    for (const candidate of this.getMarkdownFiles()) {
      if (candidate.path === to) continue;
      const text = fs.readFileSync(path.join(this.root, candidate.path), 'utf8');
      const next = text.replace(
        /(!?)\[\[([^\]|#]+)([^\]]*)\]\]/g,
        (whole, bang: string, target: string, rest: string) =>
          target.trim() === oldBasename ? `${bang}[[${newBasename}${rest}]]` : whole,
      );
      if (next !== text) this.writeRaw(candidate.path, next);
    }
  }

  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    if (this.trashOption === 'none') return; // 静默什么都不做（S2 复现的行为）
    if (this.trashOption === 'local' || !system) {
      const trashDir = path.join(this.root, '.trash');
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(path.join(this.root, file.path), path.join(trashDir, file.name));
      this.byPath.delete(file.path);
      this.metadata?.forget(file.path);
      this.trigger('delete', file);
      return;
    }
    // system：真的进系统回收站（桩里退化成删除 + 记录，测试靠 trashOption='local' 验还原）
    this.systemTrashed.push(file.path);
    fs.rmSync(path.join(this.root, file.path), { force: true });
    this.byPath.delete(file.path);
    this.metadata?.forget(file.path);
    this.trigger('delete', file);
  }

  /** 走了"系统回收站"的路径（程序化拿不回） */
  systemTrashed: string[] = [];
}

// ────────────────────────────────────────────────────────────────
// MetadataCache
// ────────────────────────────────────────────────────────────────
export interface CachedMetadataLike {
  frontmatter?: Record<string, unknown>;
  frontmatterPosition?: { start: unknown; end: unknown };
  links?: LinkCacheLike[];
  embeds?: LinkCacheLike[];
  tags?: { tag: string }[];
}

export class StubMetadataCache extends Emitter {
  /**
   * **真机实测（P-1 S3）：写盘之后 metadataCache 要 ~300ms 才更新。**
   * 这之前 `getFileCache` 返回的是**上一次解析的结果**（刚创建的文件则返回 null）。
   *
   * 为什么必须模拟：索引的属性刷新挂的是 `changed` 事件，而"写完立刻读属性会读到旧值"
   * 正是真机上最容易出错的时序（表格/属性编辑器都压在这条上）。桩原先每次现读磁盘
   * ——**零滞后**，于是这类 bug 离线永远抓不到。测试想省时间就 `settle()`。
   */
  lagMs = 300;
  /** 已解析的缓存（path → 结果）。构造时预热：真机启动时全库早就解析完了 */
  private cache = new Map<string, CachedMetadataLike | null>();
  /** 还没结算的重解析（path → 定时器） */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private vault: StubVault) {
    super();
    for (const f of this.vault.getMarkdownFiles()) this.cache.set(f.path, this.build(f));
  }

  /** 把库里"没解析过"的文件补进缓存（rescan 时用） */
  primeUnknown(): void {
    for (const f of this.vault.getMarkdownFiles()) {
      if (!this.cache.has(f.path)) this.cache.set(f.path, this.build(f));
    }
  }

  /** 把滞后的重解析一次性结算掉（真机没有这个口子，测试专用） */
  settle(): void {
    for (const [p, t] of Array.from(this.pending)) {
      clearTimeout(t);
      this.pending.delete(p);
      this.apply(p);
    }
  }

  dispose(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.clear();
    this.cache.clear();
  }

  /** 换路径（rename 时缓存跟着文件走；不这么做新路径会"没解析过"） */
  movePath(from: string, to: string): void {
    const t = this.pending.get(from);
    if (t) {
      clearTimeout(t);
      this.pending.delete(from);
    }
    if (this.cache.has(from)) {
      this.cache.set(to, this.cache.get(from) ?? null);
      this.cache.delete(from);
    }
  }

  /** 文件没了 → 缓存也丢掉 */
  forget(path: string): void {
    const t = this.pending.get(path);
    if (t) clearTimeout(t);
    this.pending.delete(path);
    this.cache.delete(path);
  }

  /**
   * **盘上已经不在的文件：缓存也丢掉**（`StubVault.rescan()` 的对称另一半，P7.16 加）——
   * 传"现在还活着的路径集合"（vault 的 `byPath` 键），其余条目连同待结算的重解析一起清。
   */
  forgetMissing(alive: Set<string>): void {
    for (const p of Array.from(this.cache.keys())) {
      if (!alive.has(p)) this.forget(p);
    }
  }

  /** 重解析一条并广播 `changed`（滞后到期时走这里） */
  private apply(path: string): void {
    const f = this.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      this.cache.set(path, this.build(f));
      this.trigger('changed', f, '', this.cache.get(path));
    } else {
      this.cache.delete(path);
      this.trigger('deleted', path, null);
    }
  }

  get resolvedLinks(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const file of this.vault.getMarkdownFiles()) {
      const text = fs.readFileSync(path.join(this.vault.getRoot(), file.path), 'utf8');
      const { links, embeds } = extractLinks(text);
      const dests: Record<string, number> = {};
      for (const ref of [...links, ...embeds]) {
        const dest = this.getFirstLinkpathDest(ref.link, file.path);
        if (dest) dests[dest.path] = (dests[dest.path] ?? 0) + 1;
      }
      if (Object.keys(dests).length > 0) out[file.path] = dests;
    }
    return out;
  }

  getFileCache(file: TFile | TFolder | null): CachedMetadataLike | null {
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    // 只认已解析的缓存：写盘后要等 `lagMs`（真机 ~300ms）才会更新，
    // 期间返回的是**上一次**的结果；刚创建的文件则返回 null
    return this.cache.get(file.path) ?? null;
  }

  /** 现读磁盘解析一次（滞后到期时用） */
  private build(file: TFile): CachedMetadataLike | null {
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    const text = fs.readFileSync(path.join(this.vault.getRoot(), file.path), 'utf8');
    const fm = parseFrontmatter(text);
    const { links, embeds } = extractLinks(text);
    const tags: { tag: string }[] = [];
    for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.push({ tag: `#${m[2]}` });
    const cache: CachedMetadataLike = { links, embeds, tags };
    if (fm) {
      cache.frontmatter = fm;
      const lineCount = text.split('\n').findIndex((l, i) => i > 0 && l.trimEnd() === '---');
      cache.frontmatterPosition = { start: { line: 0 }, end: { line: lineCount } };
    }
    return cache;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const target = linkpath.split('#')[0].trim();
    if (!target) return null;
    /**
     * 🔴 **桩原先只认 `.md`**（无脑补 `.md` 后缀）—— 真机对**任意扩展名**的引用
     *（`![[图.png]]`、`[[手册.pdf]]`）都会解析到文件本身。P7.6 的「孤儿附件」判据
     * 建立在"嵌入能解析到附件"上，不修的话**被嵌入的图片在桩里也解析不到** → 判据全假红。
     *
     * 口径（与真机同宽）：
     *   ① 原样（全路径 / 带扩展名 —— 含非 md 附件）；② 补 `.md`（Obsidian 惯例：
     *   不带扩展名的 wiki 链接默认指 md）。`9.16` 这类带点的名字：先试原样，
     *   试不到再补 `.md`（不会把 `.16` 当扩展名）。
     */
    const names = target.endsWith('.md') ? [target] : [target, `${target}.md`];
    const dir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    for (const name of names) {
      // 1) 同目录优先，2) 然后按路径原样
      if (dir) {
        const sameDir = `${dir}/${name}`;
        const direct = this.vault.getAbstractFileByPath(sameDir);
        if (direct instanceof TFile) return direct;
      }
      const byPath = this.vault.getAbstractFileByPath(name);
      if (byPath instanceof TFile) return byPath;
    }
    // 3) 再按"文件名"全局找（够用；真机还有最短路径那几档）
    for (const name of names) {
      for (const f of this.vault.getFiles()) {
        if (f.name === name) return f;
      }
    }
    return null;
  }

  /** 写盘后请求重解析 —— **不是立刻**，而是 `lagMs` 之后（真机行为） */
  invalidate(file: TFile): void {
    if (!(file instanceof TFile)) return;
    this.schedule(file.path);
  }

  /** 安排一次滞后重解析（同一路径重复请求只留最后一次） */
  schedule(path: string): void {
    const prev = this.pending.get(path);
    if (prev) clearTimeout(prev);
    if (this.lagMs <= 0) {
      this.apply(path);
      return;
    }
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        this.apply(path);
      }, this.lagMs),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// FileManager
// ────────────────────────────────────────────────────────────────
export class StubFileManager {
  constructor(private vault: StubVault) {}

  async processFrontMatter(file: TFile, fn: (fm: Record<string, unknown>) => void): Promise<void> {
    const text = await this.vault.read(file);
    const { fm, body } = splitFrontmatter(text);
    const obj: Record<string, unknown> = fm ? { ...fm } : {};
    fn(obj);
    await this.vault.process(file, () => serializeFrontmatter(obj, body));
  }

  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    await this.vault.rename(file, newPath);
  }

  async trashFile(file: TAbstractFile): Promise<void> {
    const option = this.vault.getConfig('trashOption');
    await this.vault.trash(file, option === 'system');
  }
}

// ────────────────────────────────────────────────────────────────
// Workspace / Leaf / View
// ────────────────────────────────────────────────────────────────
export class WorkspaceLeaf {
  app: StubApp;
  view: StubView | null = null;
  detached = false;
  constructor(app: StubApp) {
    this.app = app;
    /**
     * ⚠️ **入栈放在构造函数里**（a.5 修正）：真机上 `new WorkspaceLeaf(app)` 也是一片真叶，
     * 而悬浮小窗正是这么造的（不走 `getLeaf`）。早先只有 `getLeaf` 入栈 →
     * 用例里"窗口的编辑器挂上了吗"根本查不到那片叶（`__leaves` 里没有它）。
     */
    app.__leaves.push(this);
  }

  /**
   * 🔴 **桩原先在这里比真机宽松**（d 期独立审查 🔴2 证到）：它只 `await` 一个
   * 立刻 resolve 的 `onOpen()`，于是"叶子挂上去了没"在离线**是同步的**。
   * 真机上 `setViewState` 要建视图、读文件、进编辑器 —— 几十 ms 量级。
   * 那个窗口正是"点开一篇 → 立刻 Esc → 立刻再点同一篇"的竞态所在；
   * 桩同步完成 → 离线**永远看不见**（同一类"桩比真机宽松"的假绿，本项目栽过多次）。
   *
   * 所以补一个**可配的滞后**（默认沿用 `ViewStateLagMs`，与 `metadataCache.lagMs` 同一套路）。
   * ⚠️ 改小/去掉它 → "挂载途中被关掉"那条判据会**静默退回假绿**：
   * 那是本项目最贵的一类 bug，宁可离线多等几十毫秒。
   */
  async setViewState(state: { type: string; active?: boolean; state?: unknown }): Promise<void> {
    const factory = this.app.__viewFactories.get(state.type);
    if (!factory) throw new Error(`未注册的视图类型：${state.type}`);
    /**
     * ⚠️ `state.state` 要**原样交给工厂** —— P4 的悬浮小窗靠 `{file, mode}` 建 markdown 视图；
     * 少了这一步，那个视图在离线里永远是空的（真机有、离线没有 = 假绿）
     */
    const lag = this.app.viewStateLagMs;
    if (lag > 0) await new Promise((r) => setTimeout(r, lag));
    const view = factory(this, state.state);
    this.view = view;
    // 镜像真机：containerEl 带 data-type = 视图类型
    view.containerEl.setAttribute('data-type', state.type);
    document.body.appendChild(view.containerEl);
    await view.onOpen();
  }

  /**
   * 打开一篇笔记。⚠️ 桩原先**没有这个方法** —— 真机有（`WorkspaceLeaf.openFile`），
   * 于是「Ctrl+Enter 新标签打开」那条路在离线里会同步抛 `openFile is not a function`
   * （jsdom 记成"事件处理器里同步抛"，报错却指不到本来那一步）。补上，形状与真机一致。
   */
  async openFile(file: { path: string }): Promise<void> {
    this.opened = file.path;
    await this.setViewState({ type: 'markdown', state: { file: file.path } });
  }

  /** 这个叶开过哪一篇（用例要断言"真的开了那篇"时用） */
  opened: string | null = null;

  /**
   * 🔴 **顺序必须与平台一致：先摘 DOM、再 `onClose()`**（d2 独立审查抓的真缺陷的根）。
   *
   * 原先桩写反了（先 `onClose` 再 `remove`）——**桩比真机宽松 = 那一整类洞离线恒绿**。
   * 平台取证（2026-09-26 从本机 `obsidian.asar` 抽 `app.js`，逐字节 grep）：
   * ```js
   * // View 基类
   * t.prototype.close = function () { … case 0: return this.containerEl.detach(), this.unload(), [4, this.onClose()]; … }
   * // WorkspaceLeaf.detach
   * t.prototype.detach = function () { … e.prototype.detach.call(this); … a && (…, a.close(), …), … }
   * ```
   * 也就是：`containerEl` **先**离开文档，`onClose()` **后**跑。
   *
   * 为什么这件事要紧：插件的 `contentEl` 是 `containerEl` 的后代 —— 于是
   * **视图 `onClose()` 跑的那一刻，停靠在工作台里的东西（`.kbw-dock` 里的面板）已经
   * 不在文档里了**。凡是"用 `isConnected` 判'还开着吗'"的关闭短路，在这一刻都会误判。
   * ⚠️ 别把它改回来：改回去那条 🔴 立刻变假绿（本项目栽过很多次的形状）。
   */
  detach(): void {
    this.detached = true;
    if (this.view) {
      this.view.containerEl.remove();
      void this.view.onClose();
    }
    const i = this.app.__leaves.indexOf(this);
    if (i >= 0) this.app.__leaves.splice(i, 1);
  }
}

export class StubView {
  app: StubApp;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf, _state?: unknown) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement('div');
    this.containerEl.classList.add('workspace-leaf-content');
    this.headerEl = document.createElement('div');
    this.headerEl.classList.add('view-header');
    this.contentEl = document.createElement('div');
    this.contentEl.classList.add('view-content');
    this.containerEl.appendChild(this.headerEl);
    this.containerEl.appendChild(this.contentEl);
  }
  headerEl: HTMLElement;
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  getViewType(): string {
    return '';
  }
  getDisplayText(): string {
    return '';
  }
  getIcon(): string {
    return '';
  }
}

/** ItemView：真机上是 `View` 的子类，内容挂在 contentEl 里 */
export class ItemView extends StubView {}

/**
 * 官方「关系图谱」视图的桩（**平台自带**，不是我们注册的）。
 *
 * 为什么桩里要有它：P6 的内嵌图谱走 `new WorkspaceLeaf(app)` +
 * `setViewState({type:'graph'})`，而 `setViewState` 找不到工厂会抛
 * 「未注册的视图类型」→ 离线只能走到"挂载失败"那条路，**挂载成功那条零覆盖**。
 *
 * ── 与真机对齐的三处（都是 P6 真机 spike 逐条取证过的，别照记忆改）──
 *  ① **过滤的入口是 `dataEngine.setQuery([{query, color}])`**，参数是**数组**。
 *     传字符串真机不报错但会在解析时炸 —— 桩这里**直接按数组契约收**，
 *     形状不对就抛：这正是我们想要的（"参数形状"这一类错离线就该拦住）。
 *  ② `dataEngine` 上还有 `searchQueries` / `fileFilter` / `hasFilter`，
 *     注入后 `hasFilter` 变 true、`searchQueries` 非空。桩把这三样也摆出来，
 *     免得"注入生效了没"只能靠一个布尔。
 *  ③ **注入不落盘**（真机实测：`setQuery` 自己不调 `onOptionsChange()`）。
 *     ⚠️ 这一条**别在桩上加个自答字段**：原来这里有个 `wroteConfig = false`，
 *     全仓库没人写过它 → 断言它等于给自己打分（独立审查 🔴1 实测：把
 *     `adapter.write('.obsidian/graph.json', …)` 塞进实现，那条断言照样绿）。
 *     现在判据落在 `StubAdapter.writes`（**观察真实写入**）上。
 *
 * ⚠️ **桩不做过滤计算**（e2 独立审查 🟡6 那条"平行参照物抄了实现"）：它只**记录**
 * 收到的查询串，不对文件做匹配 —— 过滤到底对不对由真机探针（造形状逐条验）负责。
 */
export class StubGraphView extends StubView {
  /** 每一次注入都记下来（断言"注入了什么"用） */
  setQueryCalls: { query: string; color: null }[][] = [];
  searchQueries: { query: string; color: null }[] | null = null;
  hasFilter = false;
  fileFilter: Record<string, boolean> = {};
  dataEngine: {
    setQuery: (q: unknown) => void;
  };

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.containerEl.appendChild(document.createElement('canvas'));
    this.dataEngine = {
      setQuery: (q: unknown) => {
        if (!Array.isArray(q)) {
          // 真机：传字符串会在解析每一"项"时炸（`o[r].query` 是 undefined）
          throw new TypeError('图谱 setQuery 要的是数组（[{query, color}]）');
        }
        for (const item of q) {
          if (!item || typeof (item as { query?: unknown }).query !== 'string') {
            throw new TypeError('图谱 setQuery 的每一项要有 query 字符串');
          }
        }
        this.setQueryCalls.push(q as { query: string; color: null }[]);
        this.searchQueries = q as { query: string; color: null }[];
        this.hasFilter = (q as { color: unknown }[]).some((x) => !x.color);
      },
    };
  }
  getViewType(): string {
    return 'graph';
  }
  getDisplayText(): string {
    return '关系图谱';
  }
}

/**
 * Component —— 真机上 `Plugin` / `MarkdownView` 都是它的子类。
 * P4 起 `MarkdownRenderer.render(app, md, el, path, component)` 的**第 5 参必须是它**
 * （传 null 核心会从插件栈帧报内存泄漏）→ 桩也得有，否则那条调用离线走不到。
 */
export class Component {
  loaded = false;
  private children: Component[] = [];
  private cleanups: (() => void)[] = [];
  onload(): void {}
  onunload(): void {}
  load(): this {
    if (this.loaded) return this;
    this.loaded = true;
    this.onload();
    return this;
  }
  unload(): void {
    if (!this.loaded) return;
    for (const c of this.children.splice(0)) c.unload();
    for (const fn of this.cleanups.splice(0)) fn();
    this.onunload();
    this.loaded = false;
  }
  addChild(c: Component): Component {
    this.children.push(c);
    if (this.loaded) c.load();
    return c;
  }
  register(fn: () => void): void {
    this.cleanups.push(fn);
  }
  registerDomEvent(el: EventTarget, type: string, cb: EventListener): void {
    el.addEventListener(type, cb);
    this.cleanups.push(() => el.removeEventListener(type, cb));
  }
}

/**
 * MarkdownView —— 就地挂真编辑器用的那个视图（platform-pitfalls #30）。
 * 桩里给足三样：`.view-header`（**真机自带，要 CSS 藏**）、`editor`（读写正文）、
 * `save()`（**detach 前必须调**，否则丢最后几秒的输入）。
 */
export class MarkdownView extends StubView {
  file: TFile | null = null;
  /** 编辑器里当前的内容（没 save 之前只是"草稿"） */
  private draft: string | null = null;
  saveCount = 0;
  constructor(leaf: WorkspaceLeaf, state?: unknown) {
    super(leaf, state);
    const st = (state ?? {}) as { file?: string; mode?: string };
    this.mode = st.mode ?? 'source';
    if (st.file) {
      const f = leaf.app.vault.getAbstractFileByPath(st.file);
      if (f instanceof TFile) this.file = f;
    }
  }
  private mode: string;
  getViewType(): string {
    return 'markdown';
  }
  getMode(): string {
    return this.mode;
  }
  getDisplayText(): string {
    return this.file?.basename ?? '';
  }
  /**
   * 模拟 CodeMirror 的读写面。
   * P4 只用 setValue / getValue / save；
   * a.5-5 起多了**定位三件**（`lineCount` / `setCursor` / `scrollIntoView`）——
   * "单击看板某一处 → 小窗从那一行开始"要靠它们，桩里记下调用（用例据此断言）。
   */
  cursorAt: { line: number; ch: number } | null = null;
  scrolledTo: { from: { line: number } } | null = null;
  focusCount = 0;
  /**
   * `Editor.refresh()` 被调过几次（d 期多篇分页用）。
   * ⚠️ 桩里**必须真有这个方法**：切 tab 时页面被 `display:none` 藏过、再显示要催一次重排，
   * 桩若缺了它，那句 `ed?.refresh?.()` 会静默跳过 —— 而真机上它是要跑的
   *（"桩与真机行为不同"正是本项目假绿的温床）。
   */
  refreshCount = 0;
  /**
   * 编辑器选区里的文字（真 CodeMirror 的 `getSelection`）。
   * ⚠️ 桩原先**没有这两个方法** —— "桩比真机少一块"的老形态（同 TFolder.children 那次）：
   * 少了它，P7.3a「@ 引用当前选区」那条路在离线**永远走不进去**，只能靠真机探针兜。
   * 这里给足可设可读：`setSelection` 按行列切出选中文字（真机的语义）。
   */
  selectionText = '';
  get editor(): {
    getValue: () => string;
    setValue: (v: string) => void;
    lineCount: () => number;
    getCursor: () => { line: number; ch: number };
    setCursor: (pos: { line: number; ch: number }) => void;
    scrollIntoView: (range: { from: { line: number } }, center?: boolean) => void;
    focus: () => void;
    refresh: () => void;
    getSelection: () => string;
    setSelection: (anchor: { line: number; ch: number }, head?: { line: number; ch: number }) => void;
  } {
    const text = (): string =>
      this.draft ?? (this.file ? this.app.vault.readSync(this.file.path) : '');
    const offsetOf = (pos: { line: number; ch: number }): number => {
      const lines = text().split('\n');
      let off = 0;
      for (let i = 0; i < pos.line && i < lines.length; i += 1) off += lines[i].length + 1;
      return off + pos.ch;
    };
    return {
      getValue: text,
      setValue: (v: string) => {
        this.draft = v;
      },
      lineCount: () => text().split('\n').length,
      /** ⚠️ 落点逻辑第一步就读它（a.5-5）：桩少了这个 → 桩里永远早退，"落到哪一行"离线就验不到 */
      getCursor: () => this.cursorAt ?? { line: 0, ch: 0 },
      setCursor: (pos) => {
        this.cursorAt = pos;
      },
      scrollIntoView: (range) => {
        this.scrolledTo = range;
      },
      focus: () => {
        this.focusCount += 1;
      },
      refresh: () => {
        this.refreshCount += 1;
      },
      getSelection: () => this.selectionText,
      setSelection: (anchor, head) => {
        const a = offsetOf(anchor);
        const b = head ? offsetOf(head) : a;
        this.selectionText = text().slice(Math.min(a, b), Math.max(a, b));
      },
    };
  }
  /** 真机上 `save()` 把编辑器内容落盘（TextFileView 的公开方法） */
  async save(): Promise<void> {
    this.saveCount += 1;
    if (!this.file || this.draft == null) return;
    const text = this.draft;
    await this.app.vault.process(this.file, () => text);
    this.draft = null;
  }
}

/**
 * MarkdownRenderer —— 真机由核心提供。这里做一个**够用的镜像**：
 * 段落 / 标题 / 列表 / 任务勾选框（**渲染出来是 disabled**）/ 围栏代码块。
 *
 * ⚠️ 桩与真机在渲染细节上必然有差（这正是"假绿"的温床）：P4 的「勾选框 ↔ 任务行」
 * 对齐逻辑**依赖两者的对应关系**，所以这里的规则刻意与 `summary.taskItems` 对齐
 * （行首 `-`/`*`/`+` + `[ ]`，fenced code 内不算）—— 真机上如果不一致，
 * 那条路会走成"宁可不绑"，探针里能看出来（卡片会带 `data-task-mismatch`）。
 */
export const MarkdownRenderer = {
  /**
   * **渲染次数计数器**（P4.5 加的）。
   * 用例靠它断言「收起/展开**不触发整块重绘**」—— 判据只能用这个数：
   * DOM 节点可以重建得一模一样（`isConnected`、文字都对），
   * 而"每张卡的正文又被 `MarkdownRenderer` 过了一遍"只有计数看得见。
   * 用例自己负责在开测前归零（`MarkdownRenderer.calls = 0`）。
   */
  calls: 0,
  async render(
    _app: StubApp,
    markdown: string,
    el: HTMLElement,
    _path: string,
    component?: Component,
  ): Promise<void> {
    MarkdownRenderer.calls += 1;
    if (!component) {
      // 真机上第 5 参缺失时核心会报内存泄漏 —— 桩里直接说出来，别让它静默通过
      console.warn('[stub] MarkdownRenderer.render 少了第 5 参 Component');
    }
    renderMiniMarkdown(markdown, el);
  },
};

/**
 * 空白串的视觉宽度：Tab 一律算 4 格 —— **真机实测的口径**（2026-09-26 逐条量过：
 * ` \t` 画框、`  \t` 不画、`   \t` 不画、`\t ` 画、5 空格画、6 空格不画）。
 * ⚠️ 中途照 CommonMark 规格正文改成过"展开到制表位"，被真机打回（那条会多收 `  \t`）。
 * ⚠️ 桩与实现**同源**这件事本身有风险（一起错就离线永远绿，独立审查 🟡6）——
 * 所以这一类形状的最终判据在**真机探针**（e2 那一步造了全部形状，看 data-task-mismatch）。
 */
function stubIndent(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === '\t' ? 4 : 1;
  return n;
}

function renderMiniMarkdown(markdown: string, el: HTMLElement): void {
  const lines = markdown.split('\n');
  let fence: string | null = null;
  let list: HTMLElement | null = null;
  let para: string[] = [];
  /** 还开着的清单项的**内容列**（缩进 + 标记宽度）—— 判"缩进算不算清单项"用 */
  const stack: number[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    const p = document.createElement('p');
    p.textContent = para.join(' ');
    el.appendChild(p);
    para = [];
  };
  const closeList = (): void => {
    if (list) {
      el.appendChild(list);
      list = null;
    }
  };
  for (const raw of lines) {
    const f = raw.trim().match(/^(```+|~~~+)/);
    if (f) {
      flushPara();
      closeList();
      if (fence === null) {
        fence = f[1][0];
        const pre = document.createElement('pre');
        pre.dataset.fence = 'open';
        el.appendChild(pre);
      } else if (f[1][0] === fence) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      const pre = el.querySelector('pre[data-fence="open"]');
      if (pre) pre.textContent = `${pre.textContent ?? ''}${raw}\n`;
      continue;
    }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const node = document.createElement(`h${h[1].length}`);
      node.textContent = h[2];
      el.appendChild(node);
      continue;
    }
    /**
     * 任务行 —— **三件事按真机对齐**（2026-09-26 真机实测三种形状 + 逐条核对）：
     *  ① 有序清单也算（`1. [ ] x`）；② 引用块里的任务行**也画框**（`> - [ ] x`）；
     *  ③ **缩进比所在清单项深超过 3 格的，不是清单项**（是上一段的续行）→ **不画框**。
     * 第 ③ 条是真机撞出来的（实验库 `9.20.md`：源文件 34 条任务行、渲染 33 个框），
     * 桩要是照旧"长得像就画框"，离线就会与真机**反着走**（那种假绿最难查）。
     */
    const bq = raw.match(/^(\s*(?:>\s?)*)([\s\S]*)$/);
    const quote = bq ? bq[1] : '';
    const after = bq ? bq[2] : raw;
    const marker = after.match(/^(\s*)((?:[-*+]|\d+[.)]))(\s+)/);
    if (marker) {
      const indent = stubIndent(quote) + stubIndent(marker[1]);
      while (stack.length > 0 && indent < stack[stack.length - 1]) stack.pop();
      const top = stack.length > 0 ? stack[stack.length - 1] : 0;
      /**
       * 缩进比栈顶深超过 3 格 = 续行；**栈空时也一样**（文档根内容列 0 → 缩进 ≥4 = 缩进代码块）。
       * marker 后 >4 空格时内容列只到 marker+1（剩下那几格开一个缩进代码块）。
       */
      const isItem = indent - top <= 3;
      if (!isItem) continue; // 续行/代码块：不画框
      stack.push(indent + marker[2].length + (marker[3].length <= 4 ? marker[3].length : 1));
    } else if (after.trim() !== '' && after.trim() === after) {
      /** 非空、非清单项、**顶格**的一行 → 关掉上面那个清单（CommonMark：空行 + 段落结束清单） */
      while (stack.length > 0 && 0 < stack[stack.length - 1]) stack.pop();
    }
    const task = after.match(/^(\s*)((?:[-*+]|\d+[.)]))[ \t]{1,4}\[([ xX])\]\s?(.*)$/);
    if (task) {
      flushPara();
      if (!list) {
        list = document.createElement('ul');
        list.classList.add('task-list');
      }
      const li = document.createElement('li');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = task[3].toLowerCase() === 'x';
      /**
       * 🔴 **与真机对齐，不给 `disabled`**（2026-09-26 真机实测：`卡面渲染出来的框
       * disabled 全为 false`）。原先这里给 true 且注释写着"真机就是这样" ——
       * 那是**错的**，而且代价很实：`bindTaskBoxes` 里"对不上就把它按成只读"那条分支
       * 在桩里**永远看不出效果**（框本来就是只读），一条断言写成"框是 disabled 的"照样绿。
       * 反过来，桩给 enabled 之后，"勾上时要**自己摘掉** disabled"这句就成了空操作 ——
       * 那是真机上的既成事实（平台给的本来就能点），不必在离线验。
       */
      li.appendChild(box);
      li.appendChild(document.createTextNode(task[4]));
      list.appendChild(li);
      continue;
    }
    const item = after.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      if (!list) list = document.createElement('ul');
      const li = document.createElement('li');
      li.textContent = item[2];
      list.appendChild(li);
      continue;
    }
    if (raw.trim() === '') {
      flushPara();
      closeList();
      continue;
    }
    para.push(raw.trim());
  }
  flushPara();
  closeList();
}

export class StubWorkspace extends Emitter {
  layoutReady = true;
  /**
   * true（默认）＝ `onLayoutReady` **立刻**回调（真机上打开工作台时布局早就绪）。
   * false → 回调排队，等 `fireLayoutReady()`。
   * 桩原先只有同步这一种，于是「骨架屏 / 索引未就绪」分支**从来没被渲染过**。
   */
  autoLayoutReady = true;
  private readyCbs: (() => void)[] = [];

  constructor(private app: StubApp) {
    super();
  }

  onLayoutReady(cb: () => void): void {
    if (this.autoLayoutReady) cb();
    else this.readyCbs.push(cb);
  }

  /** 布局就绪（延迟模式下由测试手动触发）—— 索引在这里才建起来 */
  fireLayoutReady(): void {
    const cbs = [...this.readyCbs];
    this.readyCbs = [];
    for (const cb of cbs) cb();
  }

  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.app.__leaves.filter((l) => l.view && l.view.getViewType() === type);
  }

  /**
   * **`iterateAllLeaves`（P7.16b 补课）**："桩比真机少一块"的老形态又一枚 ——
   * 真机上它是公开 API（`obsidian.d.ts` 有），P7.16b 的**原生属性面板钩子**靠它
   * 从 DOM 反认"这是哪一片叶的笔记"（`ui/native-position.ts` 的 `fileForEl`）：
   * 桩原先没有这个方法 → 那条路在离线**永远退到兜底分支**（假绿温床）。
   * ⚠️ 与真机同一口径：**先拷贝一份再遍历**（回调里拆叶是合法用法）。
   */
  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    for (const l of [...this.app.__leaves]) cb(l);
  }

  /**
   * 真机上的 `leftSplit` 是 `WorkspaceSidedock`。③ 的「打开工作台收起侧栏」只碰它。
   *
   * 🔴 **真机实测（2026-09-28）：光写 `collapsed` 字段是静默无效的** ——
   * 赋值之后侧栏元素仍然是 200px、class 也没变；**只有调 `collapse()` 才真的收**
   * （200px → 0px + `is-sidedock-collapsed`）。类型定义里两个都有，编译器拦不住。
   * 所以桩也把这个区别做出来：**`collapseCalls` 计数**（离线判据认它），
   * 而"宽度真的变了"那条只有真机探针验得了（别在离线里假装验过几何）。
   */
  leftSplit: {
    collapsed: boolean;
    collapseCalls: number;
    expandCalls: number;
    collapse(): void;
    expand(): void;
    toggle(): void;
  } = {
    collapsed: false,
    collapseCalls: 0,
    expandCalls: 0,
    collapse(): void {
      this.collapseCalls += 1;
      this.collapsed = true;
    },
    expand(): void {
      this.expandCalls += 1;
      this.collapsed = false;
    },
    toggle(): void {
      if (this.collapsed) this.expand();
      else this.collapse();
    },
  };

  /**
   * `getActiveViewOfType(type)`：真机上 = "当前活动叶的视图，**类型对得上才返回**"（否则 null）。
   * 桩按 `activeLeaf`（= 最后建的那个叶，见上面那条 getter）同一口径实现 ——
   * 于是「工作台已经是最前面那个」与「从别处切过来」这两条分支在离线上都能被摆出来
   * （③ 的收起逻辑靠它区分这两条路）。
   */
  getActiveViewOfType(type: abstract new (...args: never[]) => object): object | null {
    const view = this.activeLeaf?.view as object | undefined;
    if (!view) return null;
    return view instanceof (type as unknown as new () => object) ? view : null;
  }

  getLeaf(
    kind?: 'tab' | 'split' | 'window' | false,
    direction?: 'vertical' | 'horizontal',
  ): WorkspaceLeaf {
    // 入栈在构造函数里，别在这儿再推一次；**调用参数要记**（见 `__leafCalls` 那段）
    this.app.__leafCalls.push({ kind: kind ?? false, direction: direction ?? null });
    return new WorkspaceLeaf(this.app);
  }

  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.app.__revealed = leaf;
  }

  get activeLeaf(): WorkspaceLeaf | null {
    return this.app.__leaves[this.app.__leaves.length - 1] ?? null;
  }

  trigger(name: string, ...args: unknown[]): void {
    super.trigger(name, ...args);
  }
}

// ────────────────────────────────────────────────────────────────
// 命令与视图注册表
// ────────────────────────────────────────────────────────────────
export interface CommandLike {
  id: string;
  name: string;
  icon?: string;
  callback?: () => void;
  checkCallback?: (checking: boolean) => boolean;
}

/**
 * **`obsidian.Scope` 的最小面**（P7.1c · F2 撞车修复的离线判据用）。
 *
 * 真机上平台自己的键盘管线会把每个 keydown 先问一遍 scope 栈（实测：连合成派发的事件
 * 也走这条管线）；桩里没有平台管线，所以：存下注册项 + 让用例能**像平台那样**派一发
 *（`__dispatch`）—— 这正是"路由对不对"的那一半判据，另一半（平台真的会先问我们）
 * 归真机探针。
 */
export class Scope {
  readonly handlers: { modifiers: string[] | null; key: string | null; fn: (evt: KeyboardEvent) => unknown }[] = [];
  register(modifiers: string[] | null, key: string | null, fn: (evt: KeyboardEvent) => unknown): { key: string | null } {
    this.handlers.push({ modifiers, key, fn });
    return { key };
  }
  unregister(): void {}
  /** 用例用：像平台的键盘管线那样拿一个事件来问（没人注册这个键 = 不存在匹配） */
  __dispatch(evt: KeyboardEvent): { matched: boolean; result?: unknown } {
    const hit = this.handlers.find((h) => h.key === evt.key);
    if (!hit) return { matched: false };
    return { matched: true, result: hit.fn(evt) };
  }
}

export class StubCommands {
  private map = new Map<string, CommandLike>();

  add(cmd: CommandLike): void {
    this.map.set(cmd.id, cmd);
  }

  /** 命令面板里"看得见"的命令 */
  visible(): string[] {
    return Array.from(this.map.values())
      .filter((c) => (c.checkCallback ? c.checkCallback(true) : true))
      .map((c) => c.id);
  }

  all(): CommandLike[] {
    return Array.from(this.map.values());
  }

  /** 执行命令；**不可用时不抛、返回 false**（跟"命令没跑"这件事对齐，便于断言） */
  execute(id: string): boolean {
    const cmd = this.map.get(id);
    if (!cmd) throw new Error(`没有这个命令：${id}`);
    if (cmd.checkCallback) return cmd.checkCallback(false);
    cmd.callback?.();
    return true;
  }

  /**
   * **平台的按 id 执行那一个**（`app.commands.executeCommandById`）。
   *
   * 🔴 之前**桩里没有它** —— 于是首页 `>` 命令模式（`modules/home` 的 `runCommand` 走的就是这一条）
   * 在离线永远落进"命令没注册"那条兜底分支：**那条真链路从来没被验过**
   *（`归档/README.md` 债表 #4 第 1 条就是这个，e2 期补的）。
   *
   * 语义对齐平台：**id 不存在 → 返回 false**（不抛）；命令关着（`checkCallback(true)` 为假）→ 也不跑、返回 false。
   * 顺带钉住那条前缀口径：`Plugin.addCommand` 会自动给 id 加插件前缀，自己再写一遍就变成
   * `kb-workbench:kb-workbench:open` —— 那种错在这里会**查不到 id → false**（真机探针也抓过一次）。
   */
  executeCommandById(id: string): boolean {
    const cmd = this.map.get(id);
    if (!cmd) return false;
    if (cmd.checkCallback && !cmd.checkCallback(true)) return false;
    return this.execute(id);
  }
}

// ────────────────────────────────────────────────────────────────
// Setting（够用就行——P0 只用到 text / toggle / button）
// ────────────────────────────────────────────────────────────────
interface TextLike {
  setValue(v: string): TextLike;
  setPlaceholder(v: string): TextLike;
  onChange(fn: (v: string) => void): TextLike;
  inputEl: HTMLInputElement;
}
interface ToggleLike {
  setValue(v: boolean): ToggleLike;
  onChange(fn: (v: boolean) => void): ToggleLike;
}
interface ButtonLike {
  setButtonText(v: string): ButtonLike;
  setCta(): ButtonLike;
  onClick(fn: () => void): ButtonLike;
}

export class Setting {
  settingEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = document.createElement('div');
    this.settingEl.classList.add('setting-item');
    containerEl.appendChild(this.settingEl);
  }

  setName(name: string): this {
    const el = document.createElement('div');
    el.classList.add('setting-item-name');
    el.textContent = name;
    this.settingEl.appendChild(el);
    return this;
  }

  setDesc(desc: string): this {
    const el = document.createElement('div');
    el.classList.add('setting-item-description');
    el.textContent = desc;
    this.settingEl.appendChild(el);
    return this;
  }

  addText(cb: (t: TextLike) => void): this {
    const input = document.createElement('input');
    this.settingEl.appendChild(input);
    const api: TextLike = {
      inputEl: input,
      setValue: (v) => {
        input.value = v;
        return api;
      },
      setPlaceholder: (v) => {
        input.placeholder = v;
        return api;
      },
      onChange: (fn) => {
        input.addEventListener('input', () => fn(input.value));
        return api;
      },
    };
    cb(api);
    return this;
  }

  addToggle(cb: (t: ToggleLike) => void): this {
    const input = document.createElement('input');
    input.type = 'checkbox';
    this.settingEl.appendChild(input);
    const api: ToggleLike = {
      setValue: (v) => {
        input.checked = v;
        return api;
      },
      onChange: (fn) => {
        input.addEventListener('change', () => fn(input.checked));
        return api;
      },
    };
    cb(api);
    return this;
  }

  addButton(cb: (b: ButtonLike) => void): this {
    const button = document.createElement('button');
    this.settingEl.appendChild(button);
    const api: ButtonLike = {
      setButtonText: (v) => {
        button.textContent = v;
        return api;
      },
      setCta: () => api,
      onClick: (fn) => {
        button.addEventListener('click', fn);
        return api;
      },
    };
    cb(api);
    return this;
  }
}

export class PluginSettingTab {
  app: StubApp;
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: StubApp, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
    this.containerEl.classList.add('vertical-tab-content');
    document.body.appendChild(this.containerEl);
  }
  display(): void {}
  hide(): void {}
}

// ────────────────────────────────────────────────────────────────
// Plugin
// ────────────────────────────────────────────────────────────────
export class Plugin {
  app: StubApp;
  manifest: { id: string; dir?: string; name?: string; version?: string };
  private cleanups: (() => void)[] = [];
  data: unknown = null;
  settingTabs: PluginSettingTab[] = [];
  ribbonIcons: { icon: string; title: string; cb: () => void }[] = [];

  constructor(app: StubApp, manifest: { id: string; dir?: string }) {
    this.app = app;
    this.manifest = manifest;
    if (!this.manifest.dir) this.manifest.dir = `.obsidian/plugins/${manifest.id}`;
  }

  registerView(type: string, factory: (leaf: WorkspaceLeaf, state?: unknown) => StubView): void {
    this.app.__viewFactories.set(type, factory);
  }

  addRibbonIcon(icon: string, title: string, cb: () => void): HTMLElement {
    this.ribbonIcons.push({ icon, title, cb });
    return document.createElement('div');
  }

  addCommand(cmd: CommandLike): void {
    // ⚠️ 平台会给命令 id **自动加插件 id 前缀** —— 桩必须照着做，
    // 否则"id 写重了"这种错在离线测试里是假绿（真机探针抓到过一次）
    this.app.commands.add({ ...cmd, id: `${this.manifest.id}:${cmd.id}` });
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  register(cb: () => void): void {
    this.cleanups.push(cb);
  }

  registerEvent(ref: EventRef): void {
    this.cleanups.push(() => {
      this.app.vault.offref(ref);
      this.app.metadataCache.offref(ref);
      this.app.workspace.offref(ref);
    });
  }

  async loadData(): Promise<unknown> {
    const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    const abs = path.join(this.app.vault.getRoot(), dir, 'data.json');
    if (!fs.existsSync(abs)) return null;
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      return null;
    }
  }

  async saveData(data: unknown): Promise<void> {
    const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    const abs = path.join(this.app.vault.getRoot(), dir, 'data.json');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(data, null, 2), 'utf8');
  }

  onload(): Promise<void> | void {}
  onunload(): void {}

  async __unload(): Promise<void> {
    await this.onunload();
    for (const cb of this.cleanups.splice(0)) cb();
  }
}

// ────────────────────────────────────────────────────────────────
// App
// ────────────────────────────────────────────────────────────────
export class StubApp {
  vault: StubVault;
  metadataCache: StubMetadataCache;
  fileManager: StubFileManager;
  workspace: StubWorkspace;
  /**
   * `WorkspaceLeaf.setViewState()` 的滞后（毫秒）—— **镜像真机，默认就是非 0**。
   *
   * 🔴 真机上它是几十 ms 的异步（建视图 / 读文件 / 进编辑器），而**那个窗口正是竞态的所在**：
   * "点开一篇 → 立刻 Esc → 立刻再点同一篇"。桩原先同步完成 → 那条竞态离线**永远看不见**
   * （d 期独立审查 🔴2 就是这么证到的：给桩补上异步之后当场复现"同一篇两个活叶"）。
   *
   * 与 `metadataCache.lagMs = 300`（真机 ~300ms）同一套路：**默认照真机来**，
   * 别让它退回 0 —— 一退回去，那类判据就静默变假绿了（测试台那条规格里写着这条纪律）。
   * 想放大窗口的用例可以自己调大（见"挂载途中被关掉"那条）。
   */
  viewStateLagMs = 60;
  commands = new StubCommands();
  setting = { open: (): void => {}, openTabById: (_id: string): void => {} };
  /**
   * 键作用域栈（P7.1c）：桩原先是个 no-op——F2 修复要靠它做离线判据，所以改成**记账**：
   * push 进数组、pop 出数组；用例既能查"注册了没有"，也能拿 `scopes[i].__dispatch(evt)`
   * 像平台那样问它。
   */
  keymap: { scopes: Scope[]; pushScope: (s: Scope) => void; popScope: (s: Scope) => void } = {
    scopes: [],
    pushScope: (sc) => {
      this.keymap.scopes.push(sc);
    },
    popScope: (sc) => {
      const i = this.keymap.scopes.indexOf(sc);
      if (i >= 0) this.keymap.scopes.splice(i, 1);
    },
  };
  /**
   * 核心插件门（真机取证：`app.internalPlugins.plugins.graph.enabled`，S1）。
   * 桩原先没有这个 → `graphCoreState()` 的三个分支零覆盖。
   * 置 `plugins.graph = undefined` 验 'unknown'，`{enabled:false}` 验 'disabled'。
   */
  internalPlugins: { plugins: Record<string, { enabled?: boolean } | undefined>; getPluginById?: (id: string) => unknown } = {
    plugins: { graph: { enabled: true } },
    getPluginById: (id: string) => (id === 'graph' ? { enabled: true } : undefined),
  };
  __leaves: WorkspaceLeaf[] = [];
  /**
   * **`getLeaf()` 的调用参数**（e 期加）。
   *
   * 为什么必须有：真机上 `'split'` / `'tab'` / `'window'` 是**三个完全不同的落点**，
   * 而桩原先一律"造一个新叶"、把参数丢掉 —— 于是「分屏那条路走对了没」
   * 离线**一次都验不到**（分屏那条新用例只会量到"多了个叶"，用标签页打开也照样绿）。
   * 记下来之后用例可以断言"传的是 `'split'` + `'vertical'`"。
   * ⚠️ 平台**语义**（`'vertical'` 到底是左右还是上下）桩证不了 —— 那条靠 asar 取证
   *（写在 `src/modules/notes/ops.ts` 的 `open()` 上）+ 真机探针守着。
   */
  __leafCalls: { kind: 'tab' | 'split' | 'window' | false; direction: 'vertical' | 'horizontal' | null }[] = [];
  /** 视图工厂：`(leaf, state)` —— state 是 `setViewState({state})` 里那份（markdown 靠它取 file） */
  __viewFactories = new Map<string, (leaf: WorkspaceLeaf, state?: unknown) => StubView>();
  __revealed: WorkspaceLeaf | null = null;
  __trashOption: 'system' | 'local' | 'none' = 'system';
  /**
   * 第三方插件的注册表（真机是 `app.plugins.plugins['templater-obsidian']`）。
   * ⚠️ 桩原先**没有这个字段** → `services/templates.ts` 的 `readTemplater` 恒返回"没装"
   * → 「目录被 Templater 接管就只补属性」「交互式模板突破封顶」这两条路径**离线一次都没走到**
   * （独立审查的突变测试实测：把那两处改坏，225 条全绿 = 假绿）。
   * 用法：`app.plugins.plugins['templater-obsidian'] = { settings: {...} }`（测试自己塞）。
   */
  plugins: { plugins: Record<string, { settings?: Record<string, unknown> } | undefined>; enabledPlugins?: string[] } = {
    plugins: {},
    enabledPlugins: [],
  };

  constructor(root: string) {
    this.vault = new StubVault(root);
    this.metadataCache = new StubMetadataCache(this.vault);
    this.vault.metadata = this.metadataCache;
    this.fileManager = new StubFileManager(this.vault);
    this.workspace = new StubWorkspace(this);
    /**
     * core 视图：真机上 `markdown` 是**核心注册的**（不是插件注册的）——
     * P4 的悬浮小窗靠 `setViewState({type:'markdown'})` 就地挂编辑器，
     * 桩里不注册这一个，那条路径离线就**永远走不到**（假绿）。
     */
    this.__viewFactories.set('markdown', (leaf, state) => new MarkdownView(leaf, state));
    /**
     * 「关系图谱」是**核心插件**提供的视图（真机 `internalPlugins.plugins.graph`）。
     * 桩把它注册好，P6 的内嵌挂载才有一条能走通的路。
     *
     * ⚠️ **核心插件被关掉时怎么演**：真机（S1 取证）是"叶照样建得出来、
     * `getViewType()` 仍返回 `'graph'`，但内容是「插件不再活动」占位" ——
     * 所以**关掉时不要摘掉这个工厂**（摘了就变成抛异常，那是另一条路），
     * 要演就得让视图照建、内容为空。用例按 `internalPlugins.plugins.graph.enabled`
     * 自己切换，`renderGraph` 的 `disabled` 分支在**挂载之前**就拦住了。
     */
    this.__viewFactories.set('graph', (leaf) => new StubGraphView(leaf));
  }
}

// ────────────────────────────────────────────────────────────────
// 杂项（插件源码用到的那几个）
// ────────────────────────────────────────────────────────────────
export function setIcon(el: HTMLElement, name: string): void {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `lucide-${name}`);
  svg.setAttribute('data-icon', name);
  el.appendChild(svg);
}

export class Notice {
  constructor(_msg: string, _ms?: number) {}
  setMessage(): void {}
  hide(): void {}
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
}

export const Platform = {
  isMobile: false,
  isDesktop: true,
  isMobileApp: false,
};

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function moment(): unknown {
  throw new Error('桩里没有 moment');
}

// ────────────────────────────────────────────────────────────────
// requestUrl（P6 段④ 的 AI 传输层用）
// ────────────────────────────────────────────────────────────────
/**
 * **默认拒绝**：没装处理器就抛。
 *
 * 🔴 这一条是刻意选的（不是偷懒）：`services/ai/transport.ts` 的真实现会发**真请求**，
 * 而离线套件绝不该联网。桩默认放行的话，某条用例忘了注入假响应会**真去调模型**
 * ——花钱、慢、而且输出还会变（本项目最怕的"失败集合每轮不一样"）。
 * 抛出来就一眼看得见是哪条用例没准备。
 *
 * 注入方式：`setRequestHandler(fn)`（`tests/helpers.ts` 的 `stubAi` 包了一层好用的）。
 */
export interface StubRequestParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}

export interface StubRequestResponse {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
}

type RequestHandler = (req: StubRequestParam) => Promise<StubRequestResponse> | StubRequestResponse;

let requestHandler: RequestHandler | null = null;
/** 发出去的每一条请求（判据用：验"到底调没调"、以及**调用时带的是什么**） */
export const requestLog: StubRequestParam[] = [];

export function setRequestHandler(fn: RequestHandler | null): void {
  requestHandler = fn;
}

export function __resetRequests(): void {
  requestHandler = null;
  requestLog.length = 0;
  // P7.3a：fetch 那条路与 requestUrl 同一条纪律（见下面 fetch 守卫）
  fetchHandler = null;
  fetchLog.length = 0;
}

export async function requestUrl(req: StubRequestParam | string): Promise<StubRequestResponse> {
  const param: StubRequestParam = typeof req === 'string' ? { url: req } : req;
  requestLog.push(param);
  if (!requestHandler) {
    throw new Error(
      `桩：requestUrl 没有处理器就发请求了（${param.url}）—— ` +
        '离线用例请用 H.stubAi() 注入假响应，别真联网',
    );
  }
  return requestHandler(param);
}

/** 造一个 OpenAI 兼容的成功响应（用例的起手式） */
export function stubChatResponse(content: string, status = 200): StubRequestResponse {
  const json = { choices: [{ message: { role: 'assistant', content } }] };
  return { status, text: JSON.stringify(json), json, headers: {} };
}

// ────────────────────────────────────────────────────────────────
// fetch（P7.3a 的流式传输层用）
// ────────────────────────────────────────────────────────────────
/**
 * **与 `requestUrl` 同一条纪律：默认拒绝。**
 *
 * `httpTransport().stream` 走的是全局 `fetch`（真机实测：它能带 CORS 打到 DeepSeek）。
 * 离线套件里不拦的话，某个用例忘了注入假响应就会**真去调模型** —— 而且症状比
 * "慢/花钱"阴得多：过不了 CORS 的假想下会降级成静默走 `requestUrl`，
 * 过得去的时候（本机真的联网）会拿到一个 401，**被分类成 `auth` 错误**
 * —— 于是"桩没准备"演成了"key 不对"，判据红得莫名其妙（P7.3a 当场踩到）。
 *
 * 装了守卫之后：没注入 handler 的 `fetch` 抛 `TypeError` —— 而 `httpTransport.stream`
 * 把"连接层 TypeError"当"这家不通"处理，**自动降级走 `requestUrl`**。
 * 于是既有用例一个字不用改（它们的 `stubAi` 拦在 requestUrl 上），
 * 而想验真流式的用例用 `setFetchHandler()` 注入 SSE 假响应。
 */
type FetchHandler = (url: string, init: RequestInit) => Promise<Response> | Response;
let fetchHandler: FetchHandler | null = null;
/** 走 fetch 的每一条请求（判据用） */
export const fetchLog: { url: string; init: RequestInit }[] = [];

export function setFetchHandler(fn: FetchHandler | null): void {
  fetchHandler = fn;
}

/** 换掉全局 `fetch`（模块加载时就装 —— 生产代码用的是同一格全局） */
function installFetchGuard(): void {
  const g = globalThis as { fetch?: typeof fetch };
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push({ url, init: init ?? {} });
    if (!fetchHandler) {
      throw new TypeError(
        `桩：fetch 没有处理器就发请求了（${url}）—— ` +
          '离线用例别真联网；这条会触发传输层降级到 requestUrl（stubAi 拦在那里）',
      );
    }
    return fetchHandler(url, init ?? {});
  }) as typeof fetch;
}
installFetchGuard();
