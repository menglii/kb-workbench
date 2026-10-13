/**
 * spec：**P7.21b · AI 地基段二**（2026-10-11）—— #4 正文检索 · #5 skill 扩展与触发词 · #6 技能工坊
 *
 * 判据草案来自开工提示词 §1（逐条落）：
 *  · #4 `grep`：离线（命中 / 截断 / 预算 / 大文件 / 无命中）+ 200 篇夹具性能护栏（量了记档）；
 *  · #5：`parseSkill` 纯函数逐条（新键的三种 YAML 形状 + 坏形状）+ 面板行为
 *    （`/` 菜单、自动挂载可撤、参数槽小表单、默认工作目录）；
 *  · #6：写盘位置正确 + 产物过 `parseSkill` + 菜单即时可见 + 重名不覆盖（按既有口径如实提示）。
 *
 * ⚠️ 真机才验得了的（`/` 菜单的真机弹窗、触发词真机打字）在 `scripts/probe.mjs` 的探针步。
 * 🔴 离线绝不联网：传输层全走 `H.stubAi*`（桩的 `requestUrl` 默认抛）。
 */
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import { mkdirSync, writeFileSync } from 'fs';
import { join as joinFs } from 'path';
import { closeAllMenus } from '../../src/ui/menu';
import { purgeOverlays } from '../../src/ui/panel';
import {
  AI_AGENT_LIMITS,
  fillSkillParams,
  grepText,
  matchSkillByTrigger,
  parseSkill,
  TextLru,
  validateCall,
  type AiSkill,
  type AiToolOutcome,
} from '../../src/services/ai';
import { makeAiToolPort, __resetGrepCache } from '../../src/ui/ai-tools';

const KB = '01_新知识库';

export async function specP721b(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();

  /** 造一篇笔记（本轮的 `__p721b*` 夹具）+ 索引跟上 */
  async function mk(rel: string, text: string): Promise<string> {
    H.writeNote(vaultRoot, `${KB}/${rel}`, text);
    app.vault.rescan();
    ctx().index.rebuild();
    await H.settleIndex(app);
    return rel;
  }

  /**
   * 造一个能力包文件（写在**库内 skills 目录** —— 与真用户放的位置同一处）。
   * ⚠️ 写盘之后 **`rescan()`**：能力包读取走 adapter（直接看盘）不需要它，但
   * "重名不覆盖"那条判据靠 `createNote` 的撞名自查（`getAbstractFileByPath` 认的是
   * **vault 的文件表**）—— 不让 vault 知道这个文件，"重名"根本演不出来（假红）。
   */
  function writeSkill(file: string, text: string): string {
    const dir = `${ctx().settings.workbenchDir()}/skills`;
    mkdirSync(joinFs(vaultRoot, dir), { recursive: true });
    writeFileSync(joinFs(vaultRoot, dir, file), text, 'utf8');
    app.vault.rescan();
    return `${dir}/${file}`;
  }

  /** 删能力包文件（用例之间别互相看见） */
  function dropSkill(file: string): void {
    try {
      H.rmrf(joinFs(vaultRoot, `${ctx().settings.workbenchDir()}/skills/${file}`));
    } catch {
      /* 没造过 */
    }
  }

  /** 收干净浮层与菜单（面板用例的起手/收尾仪式） */
  function sweep(): void {
    purgeOverlays();
    closeAllMenus();
  }

  /** 输入框"打字"：改值 + 派 input 事件（面板的 `/` 菜单与自动挂载都挂在这个事件上） */
  function type(inputEl: HTMLTextAreaElement, v: string): void {
    inputEl.value = v;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 等一个**元素**出现（`H.until` 只回布尔 —— 这里回元素本身，省一次查询） */
  async function untilEl<T>(fn: () => T | null | undefined, ms = 3000): Promise<T | null> {
    const hit = await H.until(() => fn() != null, ms);
    return hit ? ((fn() as T) ?? null) : null;
  }

  /** 打开 AI 面板并返回它（`openAi()` 是同步开、同步画） */
  function openPanel(): HTMLElement {
    ctx().openAi();
    return H.qa<HTMLElement>(document.body, '.kbw-modal').pop() as HTMLElement;
  }

  // ════════════════════════════════════════════════════════════
  // §F · #4 正文检索（grep）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21b · #4 正文检索（grep 纯函数）', async () => {
    await suite.it('grepText：命中给行号 + 片段 · 大小写不敏感 · 空 query / 无命中回 null', () => {
      const hit = grepText('第一行\n第二行有 关键词 在这里\n第三行', '关键词', 160);
      ok(hit, '要命中');
      eq(hit?.line, 2, '行号对（1 起）');
      contains(hit?.excerpt ?? '', '关键词', '片段里有那个词');
      const ci = grepText('Hello World', 'hello', 160);
      eq(ci?.line, 1, '大小写不敏感');
      eq(grepText('abc', '   ', 160), null, '空 query（只有空白）= 不命中');
      eq(grepText('abc', 'zzz', 160), null, '没这个词 = null');
      eq(grepText('', 'a', 160), null, '空文本 = null');
    });

    await suite.it('grepText 长行：两头对称剪 + 省略号，命中词留在片段里', () => {
      const line = `${'前'.repeat(300)}命中词${'后'.repeat(300)}`;
      const hit = grepText(line, '命中词', 60);
      ok(hit, '要命中');
      const ex = hit?.excerpt ?? '';
      contains(ex, '命中词', '命中词不能被剪掉');
      ok(ex.length <= 60 + 2, `片段宽度上限内（实际 ${ex.length}）`);
      ok(ex.startsWith('…') && ex.endsWith('…'), '两头都剪了 → 两头都有省略号（如实）');
      const short = grepText('短行命中词', '命中词', 60);
      eq(short?.excerpt, '短行命中词', '短行原样给（不加省略号）');
    });

    await suite.it('TextLru：指纹一致才命中 · 指纹变了即失效（库变即失效的落点）· 容量淘汰最旧', () => {
      const lru = new TextLru(2);
      lru.put('/a.md', '1:10', '甲');
      eq(lru.get('/a.md', '1:10'), '甲', '指纹一致 → 命中');
      eq(lru.get('/a.md', '2:10'), null, '指纹不一致（mtime 变了）→ 失效回 null');
      eq(lru.get('/a.md', '1:10'), null, '失效是**真的清了**（旧指纹也回 null，别留半条命）');
      lru.put('/b.md', '1:1', '乙');
      lru.put('/c.md', '1:1', '丙');
      eq(lru.size, 2, '容量封顶');
      lru.put('/d.md', '1:1', '丁'); // 超容量这一下才触发淘汰
      eq(lru.get('/b.md', '1:1'), null, '最旧的被淘汰（b 先于 c/d 进）');
      eq(lru.get('/c.md', '1:1'), '丙', '后进两个里的先者还在');
      eq(lru.get('/d.md', '1:1'), '丁', '最新的在');
      // 刷新新鲜度：get 过的条目不该先被淘汰
      const lru2 = new TextLru(2);
      lru2.put('/x.md', '1:1', 'X');
      lru2.put('/y.md', '1:1', 'Y');
      eq(lru2.get('/x.md', '1:1'), 'X', 'get x（x 变成最新）');
      lru2.put('/z.md', '1:1', 'Z');
      eq(lru2.get('/x.md', '1:1'), 'X', 'x 因刚被用过而留下');
      eq(lru2.get('/y.md', '1:1'), null, 'y 才是被淘汰的那个');
      /**
       * **总字符预算**（独立审 G5：只封条数的话理论最坏 ~100MB）：超预算从最旧的淘汰；
       * **单条就超预算的不进缓存**（不然它自己就把别人全挤出去）。
       */
      const lru3 = new TextLru(10, 100);
      lru3.put('/big.md', '1:1', 'x'.repeat(101));
      eq(lru3.size, 0, '单条超预算 = 不进缓存');
      lru3.put('/a.md', '1:1', 'a'.repeat(60));
      lru3.put('/b.md', '1:1', 'b'.repeat(60));
      eq(lru3.get('/a.md', '1:1'), null, '总字符超预算 → 最旧的被淘汰');
      ok(lru3.get('/b.md', '1:1') !== null, '新进的那篇还在');
      eq(lru3.chars, 60, `字符账对得上（实际 ${lru3.chars}）`);
    });
  });

  await suite.group('P7.21b · #4 正文检索（执行体 · 真扫索引里的笔记）', async () => {
    /** 直接驱动执行体（只读工具不用走面板那一圈 —— 与 p721 §D 同一套） */
    const port = (opts: { allowTools?: string[] | null; scopeDir?: string } = {}) =>
      makeAiToolPort({
        ctx: ctx(),
        askPending: async () => [],
        allowTools: (opts.allowTools ?? null) as never,
        scopeDir: opts.scopeDir,
      });
    const run = async (
      call: { tool: string; args: Record<string, unknown> },
      opts: { allowTools?: string[] | null; scopeDir?: string } = {},
    ): Promise<AiToolOutcome> => {
      const out = await port(opts).runBatch([{ tool: call.tool, args: call.args }], {});
      return out[0] as AiToolOutcome;
    };

    await suite.it('命中：篇数 + 每行「路径（第 N 行）：片段」', async () => {
      __resetGrepCache();
      await mk('__p721b命中甲.md', '---\ntags: []\n---\n\nalpha 独角兽丙 出现了\n');
      await mk('__p721b命中乙.md', '---\ntags: []\n---\n\n没有那个词\n第二行 独角兽丙 在这里\n');
      const out = await run({ tool: 'grep', args: { query: '独角兽丙' } });
      eq(out.ok, true, `搜得出来（实际：${out.summary}）`);
      contains(out.summary, '搜到 2 篇', '篇数如实');
      const detail = String(out.detail ?? '');
      contains(detail, '__p721b命中甲.md（第 5 行）', '甲：路径 + 行号（前言 3 行 + 空行，正文在第 5 行）');
      contains(detail, '__p721b命中乙.md（第 6 行）', '乙：正文第二行 = 第 6 行');
      contains(detail, '独角兽丙', '片段里有那个词');
    });

    await suite.it('无命中：如实说"没搜到"（不带截断之类的话）', async () => {
      const out = await run({ tool: 'grep', args: { query: '__绝不可能出现的词__' } });
      eq(out.ok, true, '没搜到不是错误');
      contains(out.summary, '没搜到', '如实说没搜到');
      ok(!String(out.summary).includes('可能还有更多'), '没命中不说截断的话');
    });

    await suite.it('预算截断：到上限就不扫（真截 —— 段数恰好 = 上限）+ 如实说"可能还有更多"', async () => {
      // 造比上限多的命中篇（每篇一个独立名字，正文含同一个词）
      const n = AI_AGENT_LIMITS.grepHits + 4;
      for (let i = 0; i < n; i += 1) {
        await mk(`__p721b多${String(i).padStart(2, '0')}.md`, `---\ntags: []\n---\n\n独角兽丁 第 ${i} 篇\n`);
      }
      const out = await run({ tool: 'grep', args: { query: '独角兽丁' } });
      eq(out.ok, true, '搜得出来');
      const lines = String(out.detail ?? '')
        .split('\n')
        .filter((l) => l.startsWith('- '));
      eq(lines.length, AI_AGENT_LIMITS.grepHits, `命中段数**恰好**等于上限（真截；实际 ${lines.length}）`);
      contains(out.summary, `搜到 ${AI_AGENT_LIMITS.grepHits} 篇`, 'summary 的计数 = 截出来的条数');
      contains(out.summary, '可能还有更多', '截断如实说（不假装列全）');
    });

    await suite.it('大文件：跳过并数出来（静默跳过 = 让模型以为"库里没有"）', async () => {
      // 造一个 > 上限的文件（词只在它里面 —— 搜不到时必须写明"跳过了大文件"）
      const big = `---\ntags: []\n---\n\n独角兽戊 ${'填充'.repeat(AI_AGENT_LIMITS.grepMaxFileBytes / 6)}\n`;
      await mk('__p721b大文件.md', big);
      const out = await run({ tool: 'grep', args: { query: '独角兽戊' } });
      eq(out.ok, true, '不报错');
      contains(out.summary, '没搜到', '大文件里的词搜不到（跳过是明账）');
      contains(out.summary, '跳过了 1 个太大的文件', '跳过几个要数出来（不静默）');
    });

    /**
     * ⬇️ **A19 余 ⑦（P7.22a 顺带收）**：这两条是 P7.21b 独立审列的判据缺口 ——
     * `unreadable` 分支与"最近改动在前"排序一直没被判据钉过（写好了但没人验）。
     */
    await suite.it('读失败：数出来（不冒充"没搜到"）· 命中顺序 = 最近改动在前（截断时先看新篇 —— A19⑦）', async () => {
      __resetGrepCache();
      const q = '__p721b排序词__';
      await mk('__p721b排序旧.md', `---\ntags: []\n---\n\n${q} 先写的那篇\n`);
      await H.settle(30); // 让两篇的 mtime 明确拉开（NTFS 精度足够，30ms 绰绰有余）
      await mk('__p721b排序新.md', `---\ntags: []\n---\n\n${q} 后写的那篇\n`);
      const sorted = await run({ tool: 'grep', args: { query: q } });
      const d = String(sorted.detail ?? '');
      const iNew = d.indexOf('__p721b排序新.md');
      const iOld = d.indexOf('__p721b排序旧.md');
      ok(iNew >= 0 && iOld >= 0, '两篇都命中（前提自证 —— 少一篇时下面的顺序断言会假绿）');
      ok(iNew < iOld, '最近改动的在前（与 search 同口径；预算截断时"先看新篇"）');
      /**
       * **读不出来的一篇**：patch `cachedRead` 让它对特定文件抛错 —— 执行体该
       * `unreadable += 1` 并**数出来**（静默跳过 = 让模型以为"库里没有这个词"）。
       */
      const origRead = app.vault.cachedRead.bind(app.vault);
      (app.vault as unknown as Record<string, unknown>).cachedRead = (f: { path: string }): Promise<string> => {
        if (f.path.includes('__p721b读瞎')) return Promise.reject(new Error('模拟读失败'));
        return origRead(f as never);
      };
      try {
        await mk('__p721b读瞎.md', `---\ntags: []\n---\n\n${q} 读不出来的那篇\n`);
        const out = await run({ tool: 'grep', args: { query: q } });
        contains(out.summary, '1 篇读不出来', '读失败**数出来**（不静默）');
        eq(String(out.detail ?? '').includes('__p721b读瞎'), false, '读不出来的篇不进命中列表（别拿半截内容充数）');
      } finally {
        // 原型方法没有被覆盖过 —— delete 实例属性即恢复（比赋回 bind 版更干净）
        delete (app.vault as unknown as Record<string, unknown>).cachedRead;
      }
    });

    await suite.it('库变即失效：改了文件再搜，拿的是**新**内容（指纹失效路径）', async () => {
      __resetGrepCache();
      await mk('__p721b变异.md', '---\ntags: []\n---\n\n独角兽己-旧\n');
      const before = await run({ tool: 'grep', args: { query: '独角兽己-旧' } });
      contains(before.summary, '搜到 1 篇', '先搜到旧的（这条同时把正文进了缓存）');
      // 同路径改写内容（mtime/size 变）→ 重建索引 → 再搜
      await mk('__p721b变异.md', '---\ntags: []\n---\n\n独角兽己-新\n');
      const oldGone = await run({ tool: 'grep', args: { query: '独角兽己-旧' } });
      contains(oldGone.summary, '没搜到', '旧词搜不到了（缓存没有拿旧内容骗人）');
      const newHit = await run({ tool: 'grep', args: { query: '独角兽己-新' } });
      contains(newHit.summary, '搜到 1 篇', '新词搜得到（重读过了）');
    });

    await suite.it('dir 不存在 = 拒（"目录不存在"不许被说成"没搜到"）· dir 越界拒 · scope 收窄', async () => {
      const noDir = await run({ tool: 'grep', args: { query: '独角兽丙', dir: '00_Inbox/__没有这个目录' } });
      eq(noDir.ok, false, '不存在的目录 = 拒绝');
      contains(noDir.summary, '库里没有', '如实说"没有这个目录"');
      // 库根（'' 那条）照常可搜
      const root = await run({ tool: 'grep', args: { query: '独角兽丙', dir: '' } });
      eq(root.ok, true, '空 dir 照常（= 工作目录/库根）');
      // 工作目录收窄：dir 在范围外 → 拒；无 dir → 结果收在范围内
      const outScope = await run({ tool: 'grep', args: { query: '独角兽丙', dir: '01_Projects' } }, { scopeDir: '00_Inbox' });
      eq(outScope.ok, false, 'dir 越界 = 拒');
      contains(outScope.summary, '工作目录', '越界的话术与 search 同款');
      const scoped = await run({ tool: 'grep', args: { query: '独角兽丙' } }, { scopeDir: '01_Projects' });
      contains(scoped.summary, '没搜到', '收在 01_Projects 里 = 那两篇（在 00_Inbox）搜不到');
    });

    await suite.it('validateCall + 白名单收窄：缺 query / 坏 dir / 乱塞字段 / 能力包没开它', async () => {
      eq(validateCall({ tool: 'grep', args: {} }).ok, false, '缺 query = 拒');
      eq(validateCall({ tool: 'grep', args: { query: 'x', dir: '/绝对路径' } }).ok, false, '坏 dir = 拒');
      const junk = validateCall({ tool: 'grep', args: { query: 'x', force: true, confirmed: true } });
      ok(junk.ok, '正常调用照过');
      if (junk.ok) {
        eq(Object.keys(junk.call.args).sort().join(','), 'dir,query', '自我授权字段在门口丢掉（force/confirmed 进不来）');
      }
      const denied = await run({ tool: 'grep', args: { query: '独角兽丙' } }, { allowTools: ['search'] });
      eq(denied.ok, false, '白名单里没有 grep = 拒');
      contains(denied.summary, '没有开', '如实说"这个能力包没有开"');
    });

    await suite.it('200 篇夹具性能护栏：现扫一次的可接受预算（量了记档）', async () => {
      __resetGrepCache();
      const dir = '__p721b批量';
      mkdirSync(joinFs(vaultRoot, KB, dir), { recursive: true });
      for (let i = 0; i < 200; i += 1) {
        const lines = [`---`, `tags: []`, `---`, ``, `第 ${i} 篇`, `这是批量夹具的第 ${i} 段文字。`, `河马戊 只在单篇里 ${i}`];
        writeFileSync(joinFs(vaultRoot, KB, dir, `n${String(i).padStart(3, '0')}.md`), lines.join('\n'), 'utf8');
      }
      app.vault.rescan();
      ctx().index.rebuild();
      await H.settleIndex(app);
      /**
       * ⚠️ 量"整个扫一遍"要用**零命中**的词：有命中的查询到 10 段就停了（预算生效），
       * 那量的是"扫 10 篇"、不是 200 篇（第一版就是这么量的，1ms —— 数字好得不真实）。
       */
      const t0 = Date.now();
      const cold = await run({ tool: 'grep', args: { query: '__这个词不会命中__', dir } });
      const coldMs = Date.now() - t0;
      eq(cold.ok, true, '搜得出来');
      contains(cold.summary, '没搜到', '零命中 —— 这条查询的意义就是逼它把 200 篇全扫一遍');
      const t1 = Date.now();
      await run({ tool: 'grep', args: { query: '__这个词不会命中__', dir } });
      const warmMs = Date.now() - t1;
      // 顺带证明命中路也走这个夹具 + 预算生效（到上限就停）
      const hitOut = await run({ tool: 'grep', args: { query: '河马戊', dir } });
      contains(hitOut.summary, `搜到 ${AI_AGENT_LIMITS.grepHits} 篇`, '200 篇里命中到上限就停（预算生效）');
      contains(hitOut.summary, '可能还有更多', '截断如实说');
      /**
       * 反证"这 200 篇真的都在索引里、真的被扫到了"（不然"零命中"可能只是"索引里没有"）——
       * 查**最后写的那一篇**的独有词（`只在单篇里 199` 只出现在 n199.md）。
       */
      const deep = await run({ tool: 'grep', args: { query: '只在单篇里 199', dir } });
      contains(deep.summary, '搜到 1 篇', '第 200 篇（最"深"的那篇）能被扫到 —— 全扫是真的');
      // 记档（护栏数字随机器漂，这里只钉一个宽松上限）
      console.log(`　　[P7.21b 记档] grep 200 篇全扫：冷扫 ${coldMs}ms · 缓存后 ${warmMs}ms`);
      ok(coldMs < 2500, `冷扫 200 篇在预算内（实际 ${coldMs}ms < 2500ms —— 超了要么夹具异常要么实现退化）`);
      ok(warmMs < 2500, `缓存后那一遍也在预算内（实际 ${warmMs}ms）`);
      H.rmrf(joinFs(vaultRoot, KB, dir));
      app.vault.rescan();
    });
  });

  // ════════════════════════════════════════════════════════════
  // §G · #5 skill 扩展（parseSkill / fillSkillParams / matchSkillByTrigger 纯函数）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21b · #5 skill 扩展（解析器逐条）', async () => {
    await suite.it('老文件零回归：只写三个键照旧解析，新字段回默认（缺键 = 默认）', () => {
      const r = parseSkill('---\n名称: 老包\n触发词: [甲]\n工具白名单: [search]\n---\n正文。', 'x');
      ok(r.ok, '老形状照过');
      if (r.ok) {
        eq(r.skill.params.length, 0, 'params 默认空');
        eq(r.skill.workDir, '', 'workDir 默认空');
        eq(r.skill.examples.length, 0, 'examples 默认空');
        eq(r.skill.warn, undefined, '没提醒（不凭空冒 warn）');
      }
    });

    await suite.it('新键三种 YAML 形状都认：行内数组 / 块列表 / 标量（含 {{}} 归一）', () => {
      const inline = parseSkill(
        '---\n名称: 甲\n参数槽: [主题, {{年份}}]\n默认工作目录: 00_Inbox\n示例问法: [帮我归位]\n---\n主体 {{主题}} {{年份}}',
        'x',
      );
      ok(inline.ok, '行内形状照过');
      if (inline.ok) {
        eq(inline.skill.params.join(','), '主题,年份', '行内数组 + `{{年份}}` 归一成 年份 + 去重');
        eq(inline.skill.workDir, '00_Inbox', '标量默认目录');
        eq(inline.skill.examples.join(','), '帮我归位', '行内示例');
        eq(inline.skill.warn, undefined, '槽与正文对得上 = 没提醒');
      }
      const block = parseSkill(
        '---\n名称: 乙\n参数槽:\n  - 主题\n  - 语气\n默认工作目录: 01_Projects\n示例问法:\n  - 帮我看看\n---\n用 {{主题}} 的 {{语气}} 写。',
        'x',
      );
      ok(block.ok, '块列表形状照过');
      if (block.ok) {
        eq(block.skill.params.join(','), '主题,语气', '块列表两个槽');
        eq(block.skill.examples.join(','), '帮我看看', '块列表示例');
      }
    });

    await suite.it('坏形状：非法默认目录忽略 + warn · 槽与正文对不齐 warn（两边都报）· 不写参数槽不管 {{}}', () => {
      const badWd = parseSkill('---\n名称: 丙\n默认工作目录: ../跑出库\n---\n正文。', 'x');
      ok(badWd.ok, '坏目录不致命');
      if (badWd.ok) {
        eq(badWd.skill.workDir, '', '非法目录 = 忽略（不设）');
        contains(String(badWd.skill.warn), '默认工作目录', '如实提醒');
      }
      const absWd = parseSkill('---\n名称: 丙2\n默认工作目录: /绝对/路径\n---\n正文。', 'x');
      if (absWd.ok) eq(absWd.skill.workDir, '', '绝对路径 = 忽略');
      const mismatch = parseSkill('---\n名称: 丁\n参数槽: [主题, 没用的槽]\n---\n正文里有 {{主题}} 和 {{漏网}}。', 'x');
      ok(mismatch.ok, '对不齐不致命');
      if (mismatch.ok) {
        contains(String(mismatch.skill.warn), '漏网', '正文有、清单没有 → 报出来（选中时不会问你填）');
        contains(String(mismatch.skill.warn), '没用的槽', '清单有、正文没有 → 也报（填了也不会用）');
      }
      const noKey = parseSkill('---\n名称: 戊\n---\n正文里有 {{date}} 这种记号。', 'x');
      ok(noKey.ok, '不写参数槽键照过');
      if (noKey.ok) eq(noKey.skill.warn, undefined, '不写「参数槽」= 正文里的 {{…}} 当普通文本，不提醒');
    });

    await suite.it('fillSkillParams：替换 · 空值原样留着 · 值里的 $& 不被当替换模式', () => {
      eq(fillSkillParams('关于 {{主题}} 的 {{语气}} 文', { 主题: '收纳', 语气: '轻松' }), '关于 收纳 的 轻松 文', '两个槽都替');
      eq(fillSkillParams('关于 {{主题}} 的文', { 主题: '  ' }), '关于 {{主题}} 的文', '空值 = 原样留着（不瞎填）');
      eq(fillSkillParams('关于 {{ 主题 }} 的文', { 主题: '收纳' }), '关于 收纳 的文', '松散写法也认');
      eq(fillSkillParams('关于 {{主题}} 的文', { 主题: '$&钱' }), '关于 $&钱 的文', '值里的 $& 原样落（别用字符串替换）');
      eq(fillSkillParams('没有槽', { 主题: '收纳' }), '没有槽', '没有 {{…}} = 一字不动');
    });

    await suite.it('matchSkillByTrigger：包含即算 · 大小写不敏感 · 空文本 null · 多命中取第一个（名字序）', () => {
      const s1: AiSkill = {
        path: '/a', name: 'A包', triggers: ['收件箱'], tools: null, params: [], workDir: '', examples: [], instructions: 'x',
      };
      const s2: AiSkill = {
        path: '/b', name: 'B包', triggers: ['Inbox'], tools: null, params: [], workDir: '', examples: [], instructions: 'x',
      };
      eq(matchSkillByTrigger([s1, s2], '把收件箱理一下')?.path, '/a', '包含即命中');
      eq(matchSkillByTrigger([s1, s2], 'inbox 里的东西')?.path, '/b', '大小写不敏感');
      eq(matchSkillByTrigger([s1, s2], '   '), null, '空文本不命中');
      eq(matchSkillByTrigger([s1, s2], '收件箱和 inbox 都提到')?.path, '/a', '多命中取第一个（列表顺序即名字序）');
      const empty2: AiSkill = { ...s1, path: '/c', triggers: ['', '  '] };
      eq(matchSkillByTrigger([empty2], '任何话'), null, '空触发词不命中（别把空串当"人人命中"）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // §H · #5 触发词与面板（/ 菜单 · 自动挂载 · 参数槽表单 · 默认工作目录）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21b · #5 触发词落地（面板行为）', async () => {
    await suite.it('开关关着：命中触发词也不自动挂（默认关是硬口径）', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      writeSkill('__p721b触发甲.md', '---\n名称: __p721b触发甲\n触发词: [河马触发词]\n---\n只做甲事。');
      const panel = openPanel();
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      type(inputEl, '河马触发词 帮我干活');
      await H.settle(600); // 防抖 300ms + 列表读盘
      eq(panel.querySelectorAll('.kbw-ai-skillchip').length, 0, '开关关着 = 不挂');
      sweep();
      dropSkill('__p721b触发甲.md');
    });

    await suite.it('开关开着：命中自动挂（胶囊写明来源）· ✕ 可撤且这段文字里不再挂 · 文字不命中自动撤下', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: true });
      // 这个包带「默认工作目录」——顺便钉 Y1：触发词自动挂 **不设** 工作目录（只对显式选择生效）
      writeSkill('__p721b触发乙.md', '---\n名称: __p721b触发乙\n触发词: [狐狸触发词]\n默认工作目录: 01_Projects\n---\n只做乙事。');
      const panel = openPanel();
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      type(inputEl, '狐狸触发词 帮我干活');
      const chip = await untilEl(() => panel.querySelector<HTMLElement>('.kbw-ai-skillchip'));
      ok(chip, '命中 → 自动挂上（胶囊出现）');
      contains(H.textOf(chip), '__p721b触发乙', '胶囊写着是哪个包');
      contains(H.textOf(chip), '触发词', '**来源写明**（"为什么挂着"必须看得见）');
      contains(String(chip?.getAttribute('title') ?? ''), '触发词', 'title 里也解释了来源');
      eq(
        panel.querySelectorAll('.kbw-ai-dirchip').length,
        0,
        '触发词自动挂的包**不设**默认工作目录（两个顺带件都只对"显式选它"生效 —— 独立审 Y1）',
      );
      // ✕ 撤掉：这段文字里不再自动挂（防抖那一拍不会把它挂回来）
      H.click(H.q<HTMLElement>(chip as HTMLElement, '.kbw-ai-ref-x'));
      await H.settle(600);
      eq(panel.querySelectorAll('.kbw-ai-skillchip').length, 0, '✕ 之后不在了（也没被自动挂回来）');
      // 文字不再是命中的样子 → 撤下语义已覆盖；清空重打 → 重新挂上（muted 解除）
      type(inputEl, '');
      await H.settle(400);
      type(inputEl, '狐狸触发词 再来');
      const again = await untilEl(() => panel.querySelector<HTMLElement>('.kbw-ai-skillchip'));
      ok(again, '清空后重打 → 重新自动挂上（muted 解除）');
      // 文字不再命中 → 自动撤下（存活 = "文字还命中它"）
      type(inputEl, '换个说法');
      const withdrawn = await H.until(() => panel.querySelector('.kbw-ai-skillchip') === null, 3000);
      /**
       * 🔴 **这条必须是真断言**（M4 突变实测的教训 —— 第一版写成 `ok(true, …)`，
       * 把"撤下掐掉"的突变放了过去：26/26 全绿、假绿一条）：等得到才算数。
       */
      ok(withdrawn, '文字不再命中 → 自动撤下（撤下要等得到，别拿恒真断言充数）');
      sweep();
      dropSkill('__p721b触发乙.md');
    });

    await suite.it('手动选的不被触发词顶掉（用户显式选择优先）', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: true });
      writeSkill('__p721b占用.md', '---\n名称: __p721b占用\n---\n空闲包。');
      writeSkill('__p721b触发丙.md', '---\n名称: __p721b触发丙\n触发词: [狼触发词]\n---\n只做丙事。');
      const panel = openPanel();
      // 先写好一句问题（独立审的覆盖缺口 2：`＋ → 能力包…` 这条路**不清输入框**——正式判据）
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      type(inputEl, '先写好的话');
      // 手动选「占用」（走 ＋ → 能力包…）
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-plusbtn'));
      await H.settle(300);
      const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('能力包') && H.textOf(i).includes('…'));
      ok(item, '＋ 菜单里有「能力包…」');
      H.click(item as HTMLElement);
      await H.settle(500);
      const manual = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('__p721b占用'));
      ok(manual, '能力包菜单列出了刚造的包');
      H.click(manual as HTMLElement);
      await H.settle(500);
      contains(H.textOf(panel.querySelector('.kbw-ai-skillchip')), '__p721b占用', '手动选上「占用」');
      eq(inputEl.value, '先写好的话', '＋ 这条路**不清输入框**（用户先写好的问题留着 —— 与 `/` 命令那条路刻意不同）');
      // 打字命中另一个包的触发词 → 不该被顶掉
      type(inputEl, '狼触发词 出手');
      await H.settle(700);
      contains(H.textOf(panel.querySelector('.kbw-ai-skillchip')), '__p721b占用', '手动选的还在（没被顶掉）');
      sweep();
      dropSkill('__p721b占用.md');
      dropSkill('__p721b触发丙.md');
    });

    /**
     * ⬇️ **A19 余 ⑥（P7.22a 顺带收）**：`mountSkill` 的 `warn` 展示判据 ——
     * P7.21b 写好了"坏形状不静默"这条路（`if (s.warn) notifyInfo(s.warn)`），
     * 但当时没造夹具验过它真的弹得出来。
     */
    await suite.it('带提醒的能力包：挂上时把 warn 说出来（坏形状不静默 —— A19⑥）', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      // 白名单里混着一个不认识的（parseSkill 口径：认得的留下、认不出的丢掉 + warn）
      writeSkill('__p721b警甲.md', '---\n名称: __p721b警甲\n工具白名单: [search, fly]\n---\n只做警事。');
      const panel = openPanel();
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-plusbtn'));
      await H.settle(300);
      const menuItem = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find(
        (i) => H.textOf(i).includes('能力包') && H.textOf(i).includes('…'),
      );
      H.click(menuItem as HTMLElement);
      await H.settle(500);
      const target = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('__p721b警甲'));
      ok(target, 'warn 不影响可选（照旧列出来）');
      H.click(target as HTMLElement);
      await H.settle(300);
      contains(H.textOf(panel.querySelector('.kbw-ai-skillchip')), '__p721b警甲', '挂上了（前提自证）');
      const notices = H.textsOf(document.body, '.kbw-notice').join('｜');
      contains(notices, '已忽略', 'warn 如实说出来（坏形状不静默）');
      contains(notices, 'fly', '点名认不出的那个名字');
      sweep();
      dropSkill('__p721b警甲.md');
    });

    await suite.it('`/` 菜单：打 / 弹能力包菜单 · 继续打字过滤 · 选中即挂 + 清掉命令文本', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      writeSkill('__p721b斜杠甲.md', '---\n名称: __p721b斜杠甲\n示例问法: [把甲事办了]\n---\n只做甲事。');
      writeSkill('__p721b斜杠乙.md', '---\n名称: __p721b斜杠乙\n---\n只做乙事。');
      const panel = openPanel();
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      type(inputEl, '/');
      const first = await untilEl(
        () => H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('__p721b斜杠甲')),
      );
      ok(first, '打 / 弹出能力包菜单（列出了库里的包）');
      contains(H.textOf(first as HTMLElement), '把甲事办了', '示例问法当提示显示在菜单里');
      /**
       * 🔴 **焦点必须还在输入框**（独立审 R1 的真缺陷：菜单默认 `root.focus()` 抢焦点 →
       * 真机上继续打字全被吞、"就地过滤"根本做不到；离线/探针过去都用程序性改值打字，
       * 两道闸门全盲）。菜单现在走 `keepFocus` —— 这条把闸门补上。
       */
      eq(document.activeElement, inputEl, '菜单不抢焦点：activeElement 仍是输入框（R1）');
      // 继续打字 = 就地过滤（同一扇菜单）—— ⚠️ 等的是"刷新后的状态"：
      // 乙本来就在旧菜单里（第一版只等"乙在"，那一拍立刻为真、其实刷新还没跑，假红）
      type(inputEl, '/斜杠乙');
      const filtered = await H.until(() => {
        const items = H.qa<HTMLElement>(document.body, '.kbw-menu-item');
        return (
          items.some((i) => H.textOf(i).includes('__p721b斜杠乙')) &&
          !items.some((i) => H.textOf(i).includes('__p721b斜杠甲'))
        );
      }, 3000);
      ok(filtered, '过滤生效：不匹配的那个不在了');
      // Enter = 选中过滤后的第一项（菜单不抢焦点 → Enter 落在输入框上，不该当"发送"）
      H.keydown(inputEl, 'Enter');
      await H.settle(500);
      contains(H.textOf(panel.querySelector('.kbw-ai-skillchip')), '__p721b斜杠乙', 'Enter 选中第一项 → 挂上');
      eq(inputEl.value, '', '/* 命令文本被清掉（那是命令，不是问题）');
      sweep();
      dropSkill('__p721b斜杠甲.md');
      dropSkill('__p721b斜杠乙.md');
    });

    await suite.it('参数槽：选中带槽的包 → 小表单 → 填值替换 {{名字}} 再进 system（只做替换）', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      writeSkill('__p721b槽.md', '---\n名称: __p721b槽\n参数槽: [主题]\n---\n专门处理 {{主题}} 的事情。');
      const panel = openPanel();
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      type(inputEl, '/槽');
      await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) => H.textOf(i).includes('__p721b槽')),
        3000,
      );
      H.click(H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('__p721b槽')) as HTMLElement);
      const form = await untilEl(() => document.querySelector<HTMLElement>('.kbw-ai-paramform'));
      ok(form, '带参数槽的包：先弹小表单');
      const slot = H.q<HTMLInputElement>(form as HTMLElement, '.kbw-ai-param-input');
      slot.value = '收纳';
      H.click(H.qa<HTMLElement>(form as HTMLElement, '.kbw-btn').find((b) => H.textOf(b) === '挂上') as HTMLElement);
      await H.settle(300);
      contains(H.textOf(panel.querySelector('.kbw-ai-skillchip')), '__p721b槽', '填完挂上');
      // 真链路：发一句，看 system 里是替换后的正文
      const calls = H.stubAi({ reply: '知道了' });
      inputEl.value = '帮我办';
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > 0, 6000);
      const body = JSON.parse(String(calls.calls[0]?.body ?? '{}')) as { messages: { role: string; content: string }[] };
      const system = body.messages?.[0]?.content ?? '';
      contains(system, '专门处理 收纳 的事情', '正文里的 {{主题}} 被替换成填的值');
      ok(!system.includes('{{主题}}'), '替换后没有残留的槽标记');
      sweep();
      dropSkill('__p721b槽.md');
    });

    await suite.it('默认工作目录：没设过才设上（可清）· 目录不存在就不设且如实说 · 已设过不动', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      writeSkill('__p721b目录.md', '---\n名称: __p721b目录\n默认工作目录: 01_Projects\n---\n在项目里干活。');
      writeSkill('__p721b目录二.md', '---\n名称: __p721b目录二\n默认工作目录: 00_Inbox\n---\n在收件箱里干活。');
      writeSkill('__p721b没目录.md', '---\n名称: __p721b没目录\n默认工作目录: __没这个目录\n---\n干活。');
      const panel = openPanel();
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      const pickByName = async (name: string): Promise<void> => {
        type(inputEl, `/${name}`);
        await H.until(
          () => H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) => H.textOf(i).includes(name)),
          3000,
        );
        H.click(H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes(name)) as HTMLElement);
        await H.settle(400);
      };
      await pickByName('__p721b目录');
      contains(H.textOf(panel.querySelector('.kbw-ai-dirchip')), '01_Projects', '默认工作目录设上了（工作目录胶囊出现）');
      /**
       * **已设过不动**（独立审的覆盖缺口 3：标题写了、正文没验）：这时再选一个
       * 「默认工作目录 = 00_Inbox」的包 —— 已有的 01_Projects **不许被顶掉**。
       */
      await pickByName('__p721b目录二');
      contains(H.textOf(panel.querySelector('.kbw-ai-dirchip')), '01_Projects', '已设过的工作目录不被新包的默认值顶掉');
      // 用户清掉工作目录（✕）→ 再选同一个包，仍"没设过"→ 会再设一次（口径：只在没设时设）
      H.click(H.q<HTMLElement>(panel.querySelector('.kbw-ai-dirchip') as HTMLElement, '.kbw-ai-ref-x'));
      await H.settle(200);
      eq(panel.querySelectorAll('.kbw-ai-dirchip').length, 0, '用户清掉了');
      // 换个没有目录的包：库里没这个目录 → 不设 + 如实说
      await pickByName('__p721b没目录');
      eq(panel.querySelectorAll('.kbw-ai-dirchip').length, 0, '目录不存在 → 没设');
      contains(H.textsOf(document.body, '.kbw-notice').join('｜'), '没这个目录', '如实说了为什么没设');
      sweep();
      dropSkill('__p721b目录.md');
      dropSkill('__p721b目录二.md');
      dropSkill('__p721b没目录.md');
    });

    await suite.it('带参数槽的包不参与自动挂载（要填值 —— 先手动选，独立审的覆盖缺口 1）', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: true });
      writeSkill('__p721b槽触发.md', '---\n名称: __p721b槽触发\n触发词: [大象触发词]\n参数槽: [主题]\n---\n处理 {{主题}}。');
      const panel = openPanel();
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      type(inputEl, '帮我 大象触发词 的忙');
      await H.settle(800); // 防抖 + 列表读盘：该挂的话早挂了
      eq(panel.querySelectorAll('.kbw-ai-skillchip').length, 0, '带参数槽的包：触发词命中了也不自动挂');
      sweep();
      dropSkill('__p721b槽触发.md');
    });

    await suite.it('设置页「触发词自动挂载」开关：点一下值落盘（正面判据 —— 独立审 Y4）', async () => {
      sweep();
      ctx().openWorkbenchSettings();
      await H.settle(200);
      const tab = H.qa<HTMLElement>(document.body, '.kbw-set-tab').find((t) => H.textOf(t).includes('AI 助手'));
      ok(tab, '设置里能找到「AI 助手」栏');
      H.click(tab as HTMLElement);
      await H.settle(200);
      const row = H.qa<HTMLElement>(document.body, '.kbw-set-row').find((r) => H.textOf(r).includes('触发词自动挂载'));
      ok(row, '「能力包」组里有「触发词自动挂载」开关行');
      const sw = H.q<HTMLElement>(row as HTMLElement, '.kbw-switch');
      const before = ctx().settings.get().ai.triggerAutoMount === true;
      H.click(sw);
      await H.settle(150);
      eq(ctx().settings.get().ai.triggerAutoMount === true, !before, '点一下 → 值落盘（取反）');
      H.click(sw);
      await H.settle(150);
      eq(ctx().settings.get().ai.triggerAutoMount === true, before, '再点一下 → 回到原值');
      sweep();
    });
  });

  // ════════════════════════════════════════════════════════════
  // §I · #6 技能工坊（对话 → 能力包）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.21b · #6 技能工坊 v0', async () => {
    /** 面板里跑一轮对话（工作坊要有"这一段对话"可存） */
    async function runOneTurn(panel: HTMLElement, q: string): Promise<void> {
      H.stubAiSeq([{ reply: '好，办完了。' }]);
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      type(inputEl, q);
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-send .kbw-btn'));
      await H.until(() => panel.querySelectorAll('.kbw-ai-log .kbw-ai-ops').length > 0, 6000);
    }

    /** ⋯ → 把本段对话存成能力包 → 填名 → 存 */
    async function runWorkshop(panel: HTMLElement, name: string): Promise<void> {
      H.click(H.q<HTMLElement>(panel, '.kbw-ai-morebtn'));
      await H.settle(300);
      const item = H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('把本段对话存成能力包'));
      ok(item, '⋯ 菜单里有「把本段对话存成能力包」');
      H.click(item as HTMLElement);
      const modal = await untilEl(() => H.qa<HTMLElement>(document.body, '.kbw-modal').find((m) => H.textOf(m).includes('把本段对话存成能力包')));
      ok(modal, '名字对话框弹出来了');
      const inp = H.q<HTMLInputElement>(modal as HTMLElement, '.kbw-input');
      inp.value = name;
      H.click(H.qa<HTMLElement>(modal as HTMLElement, '.kbw-btn').find((b) => H.textOf(b) === '存成能力包') as HTMLElement);
      await H.settle(600);
    }

    await suite.it('存成能力包：写进 skills/ · 产物过 parseSkill · 名称与（没挂包时）不限白名单 · 菜单立刻可见', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      const panel = openPanel();
      await runOneTurn(panel, '把收件箱里的笔记按内容归位');
      await runWorkshop(panel, '__p721b工坊甲');
      const skillsRel = `${ctx().settings.workbenchDir()}/skills`;
      ok(H.exists(vaultRoot, `${skillsRel}/__p721b工坊甲.md`), '文件落在库内 skills/ 下（写盘位置正确）');
      const text = H.readNote(vaultRoot, `${skillsRel}/__p721b工坊甲.md`);
      const parsed = parseSkill(text, '__p721b工坊甲');
      ok(parsed.ok, `产物过 parseSkill（实际：${parsed.ok ? '' : parsed.why}）`);
      if (parsed.ok) {
        eq(parsed.skill.name, '__p721b工坊甲', '名称 = 用户填的名');
        eq(parsed.skill.tools, null, '没挂能力包 → 不写白名单 = 不限制');
        contains(parsed.skill.instructions, '把收件箱里的笔记按内容归位', '正文带着这一段对话');
      }
      // 菜单立刻可见（重新打开挑包菜单）
      type(H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input'), '/工坊甲');
      const seen = await untilEl(
        () => H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('__p721b工坊甲')),
      );
      ok(seen, '存完立刻出现在能力包菜单里');
      sweep();
      dropSkill('__p721b工坊甲.md');
    });

    await suite.it('当前白名单带过去：挂着只开 search 的包 → 产物白名单 = [search]', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      writeSkill('__p721b窄包.md', '---\n名称: __p721b窄包\n工具白名单: [search]\n---\n只搜不动。');
      const panel = openPanel();
      const inputEl = H.q<HTMLTextAreaElement>(panel, '.kbw-ai-input');
      type(inputEl, '/窄包');
      await H.until(
        () => H.qa<HTMLElement>(document.body, '.kbw-menu-item').some((i) => H.textOf(i).includes('__p721b窄包')),
        3000,
      );
      H.click(H.qa<HTMLElement>(document.body, '.kbw-menu-item').find((i) => H.textOf(i).includes('__p721b窄包')) as HTMLElement);
      await H.settle(400);
      await runOneTurn(panel, '帮我看看');
      await runWorkshop(panel, '__p721b工坊乙');
      const text = H.readNote(vaultRoot, `${ctx().settings.workbenchDir()}/skills/__p721b工坊乙.md`);
      const parsed = parseSkill(text, '__p721b工坊乙');
      ok(parsed.ok, '产物过 parseSkill');
      if (parsed.ok) eq((parsed.skill.tools ?? []).join(','), 'search', '当前白名单带过去了（只做减法那条线继续收窄）');
      sweep();
      dropSkill('__p721b窄包.md');
      dropSkill('__p721b工坊乙.md');
    });

    await suite.it('重名不覆盖：同名文件在 → 存成「名字 2.md」，旧文件一字没动 + 通知如实说', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      writeSkill('__p721b重名.md', '---\n名称: 旧的\n---\n旧内容，别被覆盖。');
      const before = H.readNote(vaultRoot, `${ctx().settings.workbenchDir()}/skills/__p721b重名.md`);
      const panel = openPanel();
      await runOneTurn(panel, '随便说一句');
      await runWorkshop(panel, '__p721b重名');
      const skillsRel = `${ctx().settings.workbenchDir()}/skills`;
      eq(H.readNote(vaultRoot, `${skillsRel}/__p721b重名.md`), before, '旧文件一字没动（重名不覆盖 —— createNote 既有口径）');
      ok(H.exists(vaultRoot, `${skillsRel}/__p721b重名 2.md`), '新的存成了「名字 2.md」');
      contains(H.textsOf(document.body, '.kbw-notice').join('｜'), '存成了', '通知里把实际落点如实报出来（不假装叫那个名）');
      sweep();
      dropSkill('__p721b重名.md');
      dropSkill('__p721b重名 2.md');
    });

    await suite.it('补全开着也照过 parseSkill（前言由标称出口落，不被顶成正文）', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      /** 打开"新建笔记补全"（模块闸 + 自动化开关）—— 这条路的产物也要过 parseSkill */
      const gateWas = ctx().gate.isOn('completion');
      const autoWas = (await ctx().automation.get()).completion.enabled;
      try {
        await ctx().gate.set('completion', true);
        await ctx().automation.patch({ completion: { enabled: true } });
        const panel = openPanel();
        await runOneTurn(panel, '补全开着也存一次');
        await runWorkshop(panel, '__p721b工坊丙');
        const text = H.readNote(vaultRoot, `${ctx().settings.workbenchDir()}/skills/__p721b工坊丙.md`);
        const parsed = parseSkill(text, '__p721b工坊丙');
        ok(parsed.ok, `补全开着时产物照过 parseSkill（实际：${parsed.ok ? '' : parsed.why}）`);
        if (parsed.ok) contains(parsed.skill.instructions, '补全开着也存一次', '正文还是这段对话（前言没被顶成正文）');
      } finally {
        await ctx().gate.set('completion', gateWas);
        await ctx().automation.patch({ completion: { enabled: autoWas } });
        sweep();
        dropSkill('__p721b工坊丙.md');
      }
    });

    /**
     * ⬇️ **A19 余 ⑤（P7.22a 顺带收）**：工坊的**失败路**判据 ——
     * P7.21b 写好了两条失败路（`createNote` 抛错 / 回读自检不过），当时没造夹具验过。
     * 夹具手法：临时替换 `ctx.completion.createNote`（它是被 saveAsSkill 调的那个出口）。
     */
    await suite.it('失败路：createNote 抛错如实报 · 回读自检不过说"读不回来"（不假装成功 —— A19⑤）', async () => {
      sweep();
      H.resetAi();
      await H.configAi(plugin, { triggerAutoMount: false });
      const panel = openPanel();
      await runOneTurn(panel, '存失败路的一段对话');
      const skillsRel = `${ctx().settings.workbenchDir()}/skills`;
      const completion = ctx().completion as unknown as Record<string, unknown>;
      const origCreate = completion.createNote;
      try {
        // ① 写盘出口抛错 → '存能力包失败'（带原因），库里零产物
        completion.createNote = (): Promise<never> => Promise.reject(new Error('磁盘写不进去'));
        await runWorkshop(panel, '__p721b工坊败甲');
        const notices1 = H.textsOf(document.body, '.kbw-notice').join('｜');
        contains(notices1, '存能力包失败', '抛错如实报（不静默）');
        contains(notices1, '磁盘写不进去', '把原因带出来');
        eq(H.exists(vaultRoot, `${skillsRel}/__p721b工坊败甲.md`), false, '没有假装写出东西');

        // ② 写得出来、但产物读回来过不了 parseSkill（空正文）→ '存出来了但读不回来'
        completion.createNote = (): Promise<unknown> => {
          H.writeNote(vaultRoot, `${skillsRel}/__p721b工坊败乙.md`, '---\n名称: 空壳\n---\n');
          app.vault.rescan();
          return Promise.resolve({ path: `${skillsRel}/__p721b工坊败乙.md` });
        };
        await runWorkshop(panel, '__p721b工坊败乙');
        const notices2 = H.textsOf(document.body, '.kbw-notice').join('｜');
        contains(notices2, '读不回来', '自检失败如实说（"存出来了但读不回来" —— 不假装成功）');
      } finally {
        completion.createNote = origCreate;
        sweep();
        dropSkill('__p721b工坊败乙.md');
      }
    });
  });
}
