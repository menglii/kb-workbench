/**
 * spec：**桩-真机行为契约**（P7.20 · #10）
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────
 * `tests/stub/` 是"冒充 obsidian 模块"的那一层。它**不是**真机，而整套离线用例
 * （1200+ 条）全都压在它的行为上 —— 于是它有一个反复咬人的失效模式：
 *
 *   **桩悄悄跟真机不一样了，而没有任何一条用例会红。**
 *
 * 本项目栽过的形态至少三种（注释散落在 `tests/stub/index.ts` 各处）：
 *   · **桩比真机少一块**：`TFolder.children` 恒空（P6②）→ 所有"按 dir.children 取数"的
 *     代码离线**恒返回空表**，「模板下拉第一项是不是默认项」这类判据退化成自证；
 *   · **桩比真机宽松**：`setViewState` 同步完成（d 期）→ "点开一篇→立刻 Esc→立刻再点"
 *     那条竞态离线**永远看不见**；
 *   · **桩发的事件与真机不同**：`createFolder` 不发 `create`（P7.16）→ 依赖
 *     `vault.on('create')` 的产品路径离线**一次都不触发**，判据只能靠手动 rebuild 兜底 = 假绿。
 *
 * 这些修完之后，**修好本身又没有任何东西守着** —— 谁哪天"顺手"把 `createFolder` 的事件
 * 去掉、把 `lagMs` 设成 0、把 `detach` 的顺序写回去，全量照样可能绿。
 * 本文件就是那道守门的：把桩**故意与真机对齐**的那些口径逐条钉成断言。
 *
 * ── 设计（与其余 spec 不同）─────────────────────────────────────
 * · **不起插件实例** —— 测的是桩自己，`plugin` 是个无关变量。直接 `new StubApp(空目录)`，
 *   既快（不起 ~20 个库、不 boot）又准（没有产品代码掺进来）。
 * · 自己的库（`tests/.tmp/stub-contract`），每条用例起一份**全新空库**，互不污染。
 * · 断言写"**为什么**"：这些口径都是踩出来的，改了会怎样得写在失败信息里。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as Stub from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';

export async function specStubContract(suite: Suite, root: string): Promise<void> {
  /** 上一个用例留下的 app（起新库前要先把它的滞后定时器清掉，见 `fresh` 的注释） */
  let prev: Stub.StubApp | null = null;

  /** 起一份全新的空库（契约与夹具无关，空库最干净、最快） */
  function fresh(): Stub.StubApp {
    /**
     * 🔴 **必须先 `dispose()` 上一个 app 的 metadataCache**（本文件第一次跑就踩到）：
     * `writeRaw()` 会排一个 `lagMs`(300ms) 的**滞后重解析定时器**，而用例是同步结束的 ——
     * 不等它。下一条用例 `rmrf` 掉整个库、过 300ms 那个定时器醒来去读盘 →
     * `build()` 里裸 `readFileSync` → `ENOENT` → **不是某条用例红，是整个 runner 崩**
     * （第一次跑就是这样挂的，栈顶在 `Timeout._onTimeout`）。
     * ⚠️ 根因是"**旧 vault 对象在盘被删之后仍然记得那个文件**"（`byPath` 是内存里的）——
     * 真机上不会这样（vault 与文件系统同步），用例间共享 root 才会。
     * `dispose()` 把 pending 全 `clearTimeout` 掉，最省事也最对。
     */
    prev?.metadataCache.dispose();
    H.rmrf(root);
    fs.mkdirSync(root, { recursive: true });
    const app = new Stub.StubApp(root);
    prev = app;
    return app;
  }
  const abs = (rel: string): string => path.join(root, rel);

  /** 装事件记录器：返回 { 事件名 → 收到的 path 列表 } */
  function watch(app: Stub.StubApp, names: string[]): Record<string, string[]> {
    const got: Record<string, string[]> = {};
    for (const n of names) {
      got[n] = [];
      app.vault.on(n, (...args: unknown[]) => {
        const a = args[0];
        got[n].push(typeof a === 'string' ? a : ((a as { path?: string })?.path ?? '?'));
      });
    }
    return got;
  }

  /** 拿一个 `getFileCache` 认的 TFile（桩的类与 obsidian 声明不是同一个 → 显式转换） */
  function fileAt(app: Stub.StubApp, rel: string): Stub.TFile {
    const f = app.vault.getAbstractFileByPath(rel);
    if (!(f instanceof Stub.TFile)) throw new Error(`库里没有这个文件：${rel}`);
    return f;
  }

  /** 走桩的 `processFrontMatter`（签名是 obsidian 的 → 显式转换） */
  function editFm(
    app: Stub.StubApp,
    rel: string,
    fn: (fm: Record<string, unknown>) => void,
  ): Promise<void> {
    /**
     * ⚠️ **别把方法摘下来调用**（`const m = obj.method; m(...)`）—— 那样丢了 `this`，
     * 而 `StubFileManager.processFrontMatter` 第一句就是 `this.vault.read(file)` →
     * `Cannot read properties of undefined (reading 'vault')`。
     * 第一次写这条时正是这么红的：看着像桩缺功能，其实是调用姿势错了。
     */
    return app.fileManager.processFrontMatter(fileAt(app, rel) as never, fn as never);
  }

  // ════════════════════════════════════════════════════════════
  // ① vault 事件契约 —— 最容易被"顺手改掉"的一组
  // ════════════════════════════════════════════════════════════
  await suite.group('契约 · vault 事件：rescan 静默 vs createFolder 发事件', async () => {
    await suite.it('rescan() **静默**：造/删文件后一个 vault 事件都不发（但索引已更新）', () => {
      /**
       * 🔴 这条是**大量用例的前提**：`helpers` 里满地都是
       * `fs.writeFileSync(...) + app.vault.rescan() + ctx().index.rebuild()` 的三连 ——
       * 靠的正是"造完文件不触发事件、由用例自己决定什么时候重建索引"。
       * 哪天 `rescan()` 开始发事件，那批用例的重建节拍会**多出一拍**，
       * 症状是各种时序假红，而没人会想到是桩变了。
       * ⚠️ 与之成对的是 `createFolder()`：**它发事件**（下一条）—— 两者是故意的差异。
       */
      const app = fresh();
      const got = watch(app, ['create', 'delete', 'modify', 'rename']);
      fs.mkdirSync(abs('__契/a'), { recursive: true });
      fs.writeFileSync(abs('__契/a/x.md'), '# x\n', 'utf8');
      app.vault.rescan();
      eq(got.create.length + got.modify.length + got.delete.length + got.rename.length, 0,
        `rescan 必须静默（实际收到 ${JSON.stringify(got)}）`);
      ok(app.vault.getAbstractFileByPath('__契/a/x.md') instanceof Stub.TFile,
        '但索引得跟上 —— rescan 该干的活一样都不能少');
    });

    await suite.it('createFolder() **发 create**：recursive 建出来的祖先目录也各发一次', async () => {
      /**
       * 🔴 P7.16 补课（"桩比真机少一块"的又一枚）：真机上建目录走平台层、
       * **事件链照发**；桩原先只 `scan()` —— 于是依赖 `vault.on('create')` 的产品路径
       * （小窗属性区的候选刷新）离线**一次都不触发**，判据只能靠手动 rebuild 兜底 = 假绿。
       * ⚠️ 祖先目录一并发：真机上它们同样是"新出现的"，一起可见。
       */
      const app = fresh();
      const got = watch(app, ['create']);
      await app.vault.createFolder('__契/a/b/c');
      /**
       * ⚠️ 是 **4 个**不是 3 个：`fresh()` 之后库是空的，`__契` 本身也是这次建的。
       * （第一次写这条时按 "a / a/b / a/b/c" 数了 3 —— 当场红；数字自己说话，
       *  这也正是"基线要跑一遍"的意义。）
       */
      eq(got.create.length, 4,
        `__契 / __契/a / __契/a/b / __契/a/b/c 四个新目录各发一次（实际 [${got.create.join(', ')}]）`);
      for (const p of ['__契', '__契/a', '__契/a/b', '__契/a/b/c']) {
        ok(got.create.includes(p), `祖先也要发：${p}`);
      }
    });

    await suite.it('create() 发 create + modify；delete() 发 delete 且从父目录 children 摘掉', async () => {
      const app = fresh();
      const got = watch(app, ['create', 'modify', 'delete']);
      await app.vault.createFolder('__契');
      const f = await app.vault.create('__契/x.md', '# x\n');
      ok(got.create.includes('__契/x.md'), '新建文件要发 create');
      ok(got.modify.includes('__契/x.md'), '紧接着还有一次 modify（写盘了）');

      const parent = app.vault.getAbstractFileByPath('__契');
      ok(parent instanceof Stub.TFolder, '前提：拿到父目录');
      ok((parent as Stub.TFolder).children.some((c) => c.path === '__契/x.md'),
        '前提：挂在父目录的 children 上');

      const before = got.delete.length;
      await app.vault.delete(f);
      eq(got.delete.length, before + 1, 'delete() 要发 delete 事件');
      ok(!(parent as Stub.TFolder).children.some((c) => c.path === '__契/x.md'),
        '并且从父目录 children 里摘掉（别留一个指向已删文件的死对象）');
    });

    await suite.it('rename() 发 rename（改名没发生时不发，也不动盘）', async () => {
      const app = fresh();
      await app.vault.createFolder('__契');
      const f = await app.vault.create('__契/旧.md', '# 旧\n');
      const got = watch(app, ['rename', 'create', 'delete']);
      await app.vault.rename(f, '__契/新.md');
      eq(got.rename.length, 1, '改名要发一次 rename');
      ok(fs.existsSync(abs('__契/新.md')), '盘上是新名字');
      ok(!fs.existsSync(abs('__契/旧.md')), '盘上没旧名字');

      // 同名 → 早返回（真机上也不该发事件）
      const n = got.rename.length;
      await app.vault.rename(f, '__契/新.md');
      eq(got.rename.length, n, '路径没变 → 不发事件（早返回）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 树模型契约 —— "桩比真机少一块"的高发区
  // ════════════════════════════════════════════════════════════
  await suite.group('契约 · 树模型：children 双向挂接', async () => {
    await suite.it('scan() 要挂 children 与 parent（TFolder.children **不能恒空**）', () => {
      /**
       * 🔴 P6② 独立审查抓的：桩原先只挂 `byPath` 与 `parent`，**`TFolder.children` 是恒空数组** ——
       * 所有"按 `dir.children` 取东西"的代码在离线**恒返回空表**（`templateFiles()` 的 4 个调用方、
       * 模板下拉、选模板那些面板…）。
       * 这不是"宽松"也不是"严格"，是**缺** —— 它让判据静默变成空跑，比"宽松"更难发现。
       */
      const app = fresh();
      fs.mkdirSync(abs('__契/子'), { recursive: true });
      fs.writeFileSync(abs('__契/甲.md'), '# 甲\n', 'utf8');
      fs.writeFileSync(abs('__契/子/乙.md'), '# 乙\n', 'utf8');
      app.vault.rescan();

      const top = app.vault.getAbstractFileByPath('__契');
      ok(top instanceof Stub.TFolder, '拿到顶层目录');
      const names = (top as Stub.TFolder).children.map((c) => c.name).sort();
      eq(names.join(','), '子,甲.md', `children 里该有那两件（实际 [${names.join(', ')}]）`);

      const child = app.vault.getAbstractFileByPath('__契/子');
      ok(child instanceof Stub.TFolder, '拿到子目录');
      ok((child as Stub.TFolder).parent === top, 'parent 要指回去（双向）');
      ok((top as Stub.TFolder).children.includes(child as Stub.TFolder), 'children 里有它（双向）');
    });

    await suite.it('动态 create() 出来的文件对 dir.children **可见**（真机建完就进树）', async () => {
      /**
       * 🔴 P7.9 · ②：桩原先只在 `scan()` 时挂 children —— 动态 `create()` 出来的文件对
       * `dir.children` **不可见**（真机建完就进树）。
       * 那轮「＋ 新建模板…」判据第一版就栽在这：建完 `templateFiles()` 扫不到新模板，
       * 下拉"刷新并选中"永远选不中。
       */
      const app = fresh();
      await app.vault.createFolder('__契');
      const dir = app.vault.getAbstractFileByPath('__契') as Stub.TFolder;
      await app.vault.create('__契/新建.md', '# 新\n');
      ok(dir.children.some((c) => c.path === '__契/新建.md'),
        'create() 之后要出现在父目录的 children 里（不是等下一次 scan）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ③ 链接解析契约（getFirstLinkpathDest）—— 桩比真机"窄"过
  // ════════════════════════════════════════════════════════════
  await suite.group('契约 · 链接解析：任意扩展名 / 补 .md / 同目录优先 / 剥锚点', async () => {
    await suite.it('**任意扩展名**：`![[图.png]]` 解析到文件本身，不是去找 `图.png.md`', async () => {
      /**
       * 🔴 桩原先只认 `.md`（无脑补后缀）—— 真机对**任意扩展名**的引用
       * （`![[图.png]]`、`[[手册.pdf]]`）都解析到文件本身。
       * P7.6 的「孤儿附件」判据建立在"嵌入能解析到附件"上：不修的话被嵌入的图片
       * 在桩里也解析不到 → 判据全假红。
       */
      const app = fresh();
      await app.vault.createFolder('d');
      await app.vault.create('d/图.png', 'PNG');
      await app.vault.create('d/手册.pdf', 'PDF');
      eq(app.metadataCache.getFirstLinkpathDest('图.png', 'd/来源.md')?.path, 'd/图.png',
        '带扩展名的附件引用要原样命中');
      eq(app.metadataCache.getFirstLinkpathDest('手册.pdf', 'd/来源.md')?.path, 'd/手册.pdf',
        '非图片的附件同理');
    });

    await suite.it('不带扩展名 → 补 `.md`（Obsidian 惯例）', async () => {
      const app = fresh();
      await app.vault.createFolder('d');
      await app.vault.create('d/笔记.md', '# n\n');
      eq(app.metadataCache.getFirstLinkpathDest('笔记', 'd/来源.md')?.path, 'd/笔记.md',
        '不带扩展名的 wiki 链接默认指 md');
    });

    await suite.it('**同目录优先**：两处同名 → 取同目录那个（不是"第一个找到的"）', async () => {
      const app = fresh();
      await app.vault.createFolder('d');
      await app.vault.createFolder('e');
      await app.vault.create('d/同名.md', 'd 的');
      await app.vault.create('e/同名.md', 'e 的');
      eq(app.metadataCache.getFirstLinkpathDest('同名', 'd/来源.md')?.path, 'd/同名.md',
        'd/ 里引用的先看 d/');
      eq(app.metadataCache.getFirstLinkpathDest('同名', 'e/来源.md')?.path, 'e/同名.md',
        'e/ 里引用的先看 e/（换成全局按名找就会拿错那一篇）');
    });

    await suite.it('带点的名字（`9.16`）：**先试原样**，试不到再补 `.md`', async () => {
      /**
       * 🔴 别把 `.16` 当扩展名 —— `names = [target, target + '.md']` 这个顺序是故意的：
       * 真的存在一个叫 `9.16`（无扩展名）的文件时，必须命中它本身。
       */
      const app = fresh();
      await app.vault.createFolder('d');
      await app.vault.create('d/版本1.2', '无扩展名的原始文件');
      await app.vault.create('d/9.16.md', '# 9.16\n');
      eq(app.metadataCache.getFirstLinkpathDest('版本1.2', 'd/来源.md')?.path, 'd/版本1.2',
        '原样命中：同名无扩展名文件优先于"补 .md"出来的那个');
      eq(app.metadataCache.getFirstLinkpathDest('9.16', 'd/来源.md')?.path, 'd/9.16.md',
        '原样没有再补 .md');
    });

    await suite.it('`#` 锚点要剥掉：`[[笔记#小节]]` → 笔记.md', async () => {
      const app = fresh();
      await app.vault.createFolder('d');
      await app.vault.create('d/笔记.md', '# n\n');
      eq(app.metadataCache.getFirstLinkpathDest('笔记#小节', 'd/来源.md')?.path, 'd/笔记.md',
        '锚点是定位用的，不参与找文件');
      eq(app.metadataCache.getFirstLinkpathDest('', 'd/来源.md'), null, '空链接 → null');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ④ metadataCache 滞后契约 —— 真机 ~300ms，桩必须照抄
  // ════════════════════════════════════════════════════════════
  await suite.group('契约 · metadataCache：滞后 / settle / 预热 / 清缺失', async () => {
    await suite.it('刚写盘 **不立即可读**（滞后模型）：`getFileCache` 先回 null，`settle()` 后才有', async () => {
      /**
       * 🔴 真机实测（P-1 S3）：写盘之后 metadataCache 要 ~300ms 才更新。
       * 这之前 `getFileCache` 返回**上一次**的结果（刚创建的则是 null）。
       * 索引的属性刷新挂在这条上 ——"写完立刻读属性会读到旧值"正是真机最容易出错的时序。
       * 桩原先每次现读磁盘（零滞后）→ 这类 bug 离线永远抓不到。
       * ⚠️ 别把 `lagMs` 改成 0 图省事：那是把一整类竞态判据静默阉掉。
       */
      const app = fresh();
      ok(app.metadataCache.lagMs > 0, `默认滞后必须 > 0（实际 ${app.metadataCache.lagMs}ms）`);
      const f = await app.vault.create('新.md', '# 新\n');
      eq(app.metadataCache.getFileCache(f as never), null, '刚创建：还没解析过 → null');
      app.metadataCache.settle();
      ok(app.metadataCache.getFileCache(f as never) != null, 'settle() 结算滞后解析 → 读得到了');
    });

    await suite.it('rescan() 会**预热**新文件的缓存（`primeUnknown`）', async () => {
      /**
       * 新出现的文件"早就存在"了：真机上它们早被解析过。
       * ⚠️ 这不违反滞后模型 —— 滞后说的是**写盘之后**的重解析（`writeRaw` → `invalidate`）。
       */
      const app = fresh();
      fs.writeFileSync(abs('外来的.md'), '# 外来\n', 'utf8'); // 不经 vault.create
      app.vault.rescan();
      const f = fileAt(app, '外来的.md');
      ok(app.metadataCache.getFileCache(f as never) != null, 'rescan 后缓存里就该有它');
    });

    await suite.it('rescan() 也**清掉盘上已没了的**缓存（`forgetMissing`，`primeUnknown` 的对称另一半）', async () => {
      /**
       * 🔴 P7.16 补课：用例的"安全删法"是裸 `fs.rmSync` + `rescan`（不走 `vault.delete`）。
       * 原先只预热、不清理 → **同一路径下一次被重建、内容不同**时，缓存里还挂着上一份
       * （P7.16 实测：属性块判据读到的是**上一轮**的值，排查半天）。
       */
      const app = fresh();
      const f = await app.vault.create('将删.md', '# x\n');
      app.metadataCache.settle();
      ok(app.metadataCache.getFileCache(f as never) != null, '前提：先有一份缓存');

      fs.rmSync(abs('将删.md'), { force: true }); // 裸删（模拟"别的程序删的"）
      app.vault.rescan();
      eq(app.metadataCache.getFileCache(f as never), null, '盘上没了 → 缓存也要跟着丢');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑤ WorkspaceLeaf 契约 —— 顺序与异步都栽过
  // ════════════════════════════════════════════════════════════
  await suite.group('契约 · WorkspaceLeaf：入栈 / 异步挂载 / detach 顺序', async () => {
    await suite.it('`new WorkspaceLeaf(app)` **直接入栈**（悬浮小窗不走 getLeaf）', () => {
      const app = fresh();
      const before = app.__leaves.length;
      const leaf = new Stub.WorkspaceLeaf(app);
      eq(app.__leaves.length, before + 1, '构造即入栈 —— 否则"窗口的编辑器挂上了吗"根本查不到那片叶');
      ok(app.__leaves.includes(leaf), '……而且在表里');
    });

    await suite.it('`setViewState` **是异步的**：还没 await 完，视图没挂上', async () => {
      /**
       * 🔴 d 期独立审查 🔴2：桩原先只 await 一个立刻 resolve 的 `onOpen()` ——
       * 于是"叶子挂上去了没"在离线**是同步的**，而真机上要建视图、读文件、进编辑器（几十 ms）。
       * 那个窗口正是"点开一篇 → 立刻 Esc → 立刻再点同一篇"的竞态所在。
       * 桩同步完成 → 离线**永远看不见**（同一类"桩比真机宽松"的假绿）。
       */
      const app = fresh();
      ok(app.viewStateLagMs > 0, `默认滞后必须 > 0（实际 ${app.viewStateLagMs}ms）`);
      const leaf = new Stub.WorkspaceLeaf(app);
      const view = new Stub.StubView(leaf);
      app.__viewFactories.set('契约视图', () => view);
      const pending = leaf.setViewState({ type: '契约视图' });
      eq(leaf.view, null, '同步检查时**还没**挂上（真机是几十 ms 的异步，别退回同步）');
      await pending;
      eq(leaf.view, view, 'await 之后才挂上');
      ok(view.containerEl.isConnected, '且进了文档（真机容器属性镜像）');
      eq(view.containerEl.getAttribute('data-type'), '契约视图',
        'containerEl 带 data-type —— 靠属性选择器做作用域的写法离线才命中');
    });

    await suite.it('`detach()` **先摘 DOM、再 onClose**（平台顺序，写反过）', async () => {
      /**
       * 🔴 d2 独立审查抓的真缺陷的根：桩原先写反了（先 onClose 再 remove）。
       * 平台取证（`obsidian.asar` 逐字节 grep）：
       *   `View.close` → `containerEl.detach()` **先**、`this.onClose()` **后**。
       *
       * 为什么这件事要紧：插件的 `contentEl` 是 `containerEl` 的后代 —— 于是
       * **视图 `onClose()` 跑的那一刻，停靠在工作台里的东西已经不在文档里了**。
       * 凡是"用 `isConnected` 判'还开着吗'"的关闭短路，在这一刻都会误判。
       * ⚠️ 改回去 → 那一整类判据立刻变假绿。
       */
      const app = fresh();
      const leaf = new Stub.WorkspaceLeaf(app);
      const view = new Stub.StubView(leaf);
      let connectedInOnClose: boolean | null = null;
      view.onClose = async (): Promise<void> => {
        connectedInOnClose = view.containerEl.isConnected;
      };
      app.__viewFactories.set('契约视图', () => view);
      await leaf.setViewState({ type: '契约视图' });
      ok(view.containerEl.isConnected, '前提：先挂上去了');

      leaf.detach();
      eq(connectedInOnClose, false,
        '`onClose()` 跑的那一刻 containerEl **已经**离开文档（先摘后关）');
      ok(leaf.detached, 'detach 标记置上');
      ok(!app.__leaves.includes(leaf), '也从活跃叶表里摘掉了（别漏）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑥ 文件模型契约
  // ════════════════════════════════════════════════════════════
  await suite.group('契约 · 文件模型：扩展名与两个取数口', async () => {
    await suite.it('TFile 的 extension / basename；getMarkdownFiles 只 md、getFiles 含附件', () => {
      const app = fresh();
      fs.writeFileSync(abs('笔记.md'), '# n\n', 'utf8');
      fs.writeFileSync(abs('图.png'), 'PNG', 'utf8');
      app.vault.rescan();
      const md = fileAt(app, '笔记.md');
      eq(md.extension, 'md', 'extension');
      eq(md.basename, '笔记', 'basename 剥掉扩展名');
      eq(md.name, '笔记.md', 'name 是带扩展名的');
      eq(app.vault.getMarkdownFiles().length, 1, 'getMarkdownFiles 只 md（附件不算）');
      eq(app.vault.getFiles().length, 2, 'getFiles 含附件（P7.6 孤儿/重复判据要的口径）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑦ 设置面板与属性往返（计划书点名要钉的另外两项）
  // ════════════════════════════════════════════════════════════
  await suite.group('契约 · Setting 勾选框可点 / processFrontMatter 往返不变形', async () => {
    await suite.it('`Setting.addToggle` 的勾选框**可用**（不带 disabled）', () => {
      /**
       * 🔴 P6⑤ 期踩过"勾选框"那一族：桩若把 checkbox 画成 `disabled`，
       * 用例里"点了勾选框"其实**点不动** —— 而用例照样绿（它只查了别的量）。
       * 真机上 `Setting.addToggle` 造的是**可点**的 checkbox。
       */
      const host = document.createElement('div');
      const s = new Stub.Setting(host);
      let changed: boolean | null = null;
      s.addToggle((t) => {
        t.setValue(false);
        t.onChange((v) => {
          changed = v;
        });
      });
      const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
      ok(box, '画出了 checkbox（type=checkbox）');
      eq(box.disabled, false, '勾选框必须可用 —— 带 disabled 的话"点了"只是假装点过（静默假绿）');
      eq(box.checked, false, 'setValue 生效');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      eq(changed, true, 'onChange 真的接了线（change 能回到回调）');
      /**
       * ⚠️ `addText` 要用**另一个** Setting 来验：上面那个实例里已经有一个 checkbox 了，
       * `querySelector('input')` 会先命中它（值是默认的 `'on'`）—— 第一次写这条就栽在这，
       * 报的是"期望 值，实际 on"，看着像 addText 坏了，其实是选择器选错了元素。
       */
      const host2 = document.createElement('div');
      new Stub.Setting(host2).addText((t) => t.setValue('值'));
      eq(host2.querySelector<HTMLInputElement>('input')?.value, '值', 'addText 的 setValue 也要接线');
    });

    await suite.it('`processFrontMatter` 往返：日期**不加引号**、原样回写', async () => {
      /**
       * 🔴 真机取证（P2）：属性里的日期（`创建日期: 2026-09-01`）解析后是**字符串**，
       * 往返写回**不加引号、不变形**（不是 `"2026-09-01"`、也不是数值）。
       * 桩要是把它改了形，"属性迁移后这一篇一字节没动"那族判据会莫名其妙地红 ——
       * 更糟的是反过来：真变形了却判绿。
       */
      const app = fresh();
      await app.vault.create(
        'd.md',
        ['---', '创建日期: 2026-09-01', '类型: 笔记', '---', '', '正文', ''].join('\n'),
      );
      await editFm(app, 'd.md', (fm) => {
        fm['类型'] = '想法';
      });
      const after = fs.readFileSync(abs('d.md'), 'utf8');
      contains(after, '创建日期: 2026-09-01', '日期原样回写（不加引号、不变成数值形式）');
      contains(after, '类型: 想法', '改的那一项写进去了');
      contains(after, '正文', '正文没丢');
    });
  });

  // 收尾：最后一个 app 的滞后定时器也清掉（别让它在 spec 跑完之后醒来读盘）
  // ⚠️ `prev` 只在 `fresh()` 里被赋值，TS 的控制流分析看不到 → 这里必须显式 `as`，
  //    否则它把 `prev` 当成恒 `null`，`?.` 之后收到 `never`。
  (prev as Stub.StubApp | null)?.metadataCache.dispose();
}
