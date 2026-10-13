/**
 * spec：**整理建议（P7.6 · 11.1 / 16.4 / 并族）**
 *
 * 判据三层：
 *  ① **纯函数** —— 预检各码 / 优先级合并 / 规则源三信号 / 学过往阈值 / MOC 解析与插入 / 双链打分；
 *  ② **真链路（本 spec 专属的 temp 库）** —— 面板开 → 勾一行 → 确认流 → 真搬 + 撤销还原；
 *     MOC 真写一行（只加不删）→ 快照还原；mover 钩子 → `data.json` 的 `moveStats`；
 *     维护三件真算 × 待处理行；
 *  ③ **AI 分类（假模型）** —— `classify()` 走 `buildAiPlan`，`protected` 照拦。
 *
 * ⚠️ 本 spec 用自己的库（`makeTempVault('p76')`）—— 会真搬文件、真写 MOC 页，
 * 与其它 spec 的夹具互不影响。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TFile } from 'obsidian';
import type KbWorkbenchPlugin from '../../src/main';
import type { StubApp } from '../stub/index';
import { Suite, contains, eq, ok } from '../framework';
import * as H from '../helpers';
import {
  aiPlanRaw,
  finalize,
  generateLocal,
  INBOX_DIR,
  insertMocBullet,
  linkPairs,
  mocAiRaw,
  mocRuleRaw,
  parseSections,
  precheckItems,
  ruleSuggestions,
  titleSimilarity,
  type LinkPair,
  type PrecheckCtx,
  type RawSuggestion,
  type RuleInputs,
  type SuggestItem,
} from '../../src/services/suggest';
import type { RebuildNote } from '../../src/services/rebuild';
import type { MoveStats } from '../../src/core/settings';
import { LEARN_MAX_DIRS, LEARN_MAX_KEYS, recordMoves, suggestLearned } from '../../src/services/suggest-learned';
import { computeMaintenance, __resetMaintenance } from '../../src/services/maintenance';
import { buildTodos } from '../../src/modules/home/todo';
import { openSuggestPanel, appendMocItems } from '../../src/ui/suggest-panel';
import { buildAiPlan } from '../../src/services/ai/plan';
import { closeAllMenus } from '../../src/ui/menu';
import { __resetNotices } from '../../src/ui/notify';
import { __resetUndo } from '../../src/ui/undo-bar';

const KB = '01_新知识库';
const T = '__建议';

export async function specSuggest(
  suite: Suite,
  app: StubApp,
  plugin: KbWorkbenchPlugin,
  vaultRoot: string,
): Promise<void> {
  const ctx = () => plugin.context();
  /** 等等看：条件成立后把"再取一次"的东西拿回来（`H.until` 只等 boolean） */
  async function untilEl<T>(get: () => T | null | undefined, timeoutMs = 2000): Promise<T | null> {
    const got = await H.until(() => Boolean(get()), timeoutMs);
    return got ? (get() as T) : null;
  }

  /** 造一篇笔记（写盘 → rescan → 索引重建） */
  function mkNote(rel: string, frontmatter: Record<string, string>, body = '正文\n'): string {
    const abs = path.join(vaultRoot, KB, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const head = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    fs.writeFileSync(abs, `---\n${head}\n---\n\n${body}`, 'utf8');
    app.vault.rescan();
    void app.metadataCache.settle();
    ctx().index.rebuild();
    return `${KB}/${rel}`;
  }

  function rm(rel: string): void {
    const abs = path.join(vaultRoot, KB, rel);
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* 没了就算了 */
    }
    app.vault.rescan();
    void app.metadataCache.settle();
    ctx().index.rebuild();
  }

  // ════════════════════════════════════════════════════════════
  // ① 纯函数：预检 + 合并
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · 预检与合并（纯函数）', async () => {
    const notes: Record<string, { isTemplate: boolean; dirRel: string }> = {
      '00_Inbox/甲.md': { isTemplate: false, dirRel: '00_Inbox' },
      '01_Projects/乙.md': { isTemplate: false, dirRel: '01_Projects' },
      '02_旧知识库/丙.md': { isTemplate: false, dirRel: '02_旧知识库' },
      '99_Meta/02_模板库/T_x.md': { isTemplate: true, dirRel: '99_Meta/02_模板库' },
      '99_Meta/03_AI指令集/规范.md': { isTemplate: false, dirRel: '99_Meta/03_AI指令集' },
    };
    const pctx = (over: Partial<PrecheckCtx> = {}): PrecheckCtx => ({
      metaDir: '99_Meta',
      exclude: ['99_Meta', '02_旧知识库', '还原保留', '.开头'],
      scope: '',
      dirs: new Set(['', '00_Inbox', '01_Projects', '02_Areas', '99_Meta']),
      noteOf: (rel) => notes[rel],
      aiDirRel: '99_Meta/03_AI指令集',
      ...over,
    });
    const raw = (p: Partial<RawSuggestion> & { path: string; to: string }): RawSuggestion => ({
      id: `move:${p.path}`,
      kind: 'move',
      source: 'rule',
      why: '测试',
      prio: 50,
      ...p,
    });
    const codes = (raws: RawSuggestion[], over: Partial<PrecheckCtx> = {}): string =>
      precheckItems(raws, pctx(over)).dropped.map((d) => d.code).join(',');

    await suite.it('各拦下码各就各位（protected / missing / excluded / no-dir / same-place / out-of-scope）', () => {
      eq(codes([raw({ path: '99_Meta/03_AI指令集/规范.md', to: '01_Projects' })]), 'protected', '源在 AI 指令集 → 硬拦');
      eq(codes([raw({ path: '00_Inbox/甲.md', to: '99_Meta/03_AI指令集' })]), 'protected', '目标要去 AI 指令集 → 硬拦');
      eq(codes([raw({ path: '没有/这篇.md', to: '01_Projects' })]), 'missing', '库里的没有这篇');
      eq(codes([raw({ path: '99_Meta/02_模板库/T_x.md', to: '01_Projects' })]), 'missing', '模板不参与整理');
      eq(codes([raw({ path: '02_旧知识库/丙.md', to: '01_Projects' })]), 'excluded', '源在排除范围');
      eq(codes([raw({ path: '02_旧知识库/丙.md', to: '99_Meta' })]), 'excluded', '目标在排除范围（先于 no-dir）');
      eq(codes([raw({ path: '00_Inbox/甲.md', to: '02_Areas/不存在' })]), 'no-dir', '落点库里没有（不新建）');
      eq(codes([raw({ path: '00_Inbox/甲.md', to: '00_Inbox' })]), 'same-place', '已经在那儿了');
      eq(
        codes([raw({ path: '01_Projects/乙.md', to: '00_Inbox' })], { scope: '00_Inbox' }),
        'out-of-scope',
        '收件箱范围里，库内他处的笔记不进',
      );
    });

    await suite.it('合并：同一篇只出一条，优先级高者先占，被盖的进 dup', () => {
      const a = raw({ path: '00_Inbox/甲.md', to: '01_Projects', prio: 90, evidence: '兜底' });
      const b = raw({ path: '00_Inbox/甲.md', to: '02_Areas', prio: 30, evidence: '标签' });
      const r = finalize([a, b], pctx());
      eq(r.items.length, 1, '只出一条');
      eq(r.items[0].to, '02_Areas', '优先级高的（30）赢');
      eq(r.items[0].evidence, '标签');
      eq(r.dropped.length, 1, '被盖的进拦下');
      eq(r.dropped[0].code, 'dup');

      // 跨源也一样：学过往（40）盖 AI（60）
      const l = raw({ path: '00_Inbox/甲.md', to: '01_Projects', prio: 40, source: 'learned' });
      const ai = raw({ path: '00_Inbox/甲.md', to: '02_Areas', prio: 60, source: 'ai' });
      const r2 = finalize([l, ai], pctx());
      eq(r2.items.length, 1);
      eq(r2.items[0].source, 'learned');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ② 纯函数：规则源（三信号 + 兜底被盖）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · 规则源（纯函数：声明/领域/标签/文件名/内容/兜底）', async () => {
    const mkNote = (rel: string, over: Partial<RebuildNote> = {}): RebuildNote => ({
      path: `${KB}/${rel}`,
      basename: rel.split('/').pop() ?? rel,
      dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
      declared: [],
      type: '',
      isTemplate: false,
      locked: false,
      ...over,
    });
    const tagsMap: Record<string, string[]> = {
      '00_Inbox/丙.md': ['游戏研究'],
      '00_Inbox/辛.md': ['收件箱'],
      '01_Projects/壬.md': ['游戏研究'],
    };
    const headMap: Record<string, string> = {
      '00_Inbox/己.md': '# 游戏研究随记\n\n正文\n',
    };
    const inputs = (scope: string, notes: RebuildNote[]): RuleInputs => ({
      kbRoot: KB,
      metaDir: '99_Meta',
      exclude: ['99_Meta', '02_旧知识库', '还原保留', '.开头'],
      scope,
      dirs: new Set(['', '00_Inbox', '01_Projects', '02_Areas', '02_Areas/内容创作', '02_Areas/游戏研究']),
      files: new Set(),
      notes,
      // v2：路由表「别名段」（关键词 → 目录）——原 `areaDirs` 换名
      aliasDirs: { 内容创作: '02_Areas/内容创作', 游戏研究: '02_Areas/游戏研究' },
      fallbackDir: '02_Areas',
      tagDirs: { 游戏研究: '02_Areas/游戏研究', 收件箱: '00_Inbox' },
      tagsOf: (rel) => tagsMap[rel] ?? [],
      headOf: async (rel) => headMap[rel] ?? '',
    });

    await suite.it('声明 / 兜底两档原样进建议（prio 与 note 文案是 planRebuild 的）', async () => {
      const notes = [
        mkNote('00_Inbox/甲.md', { declared: ['02_Areas/内容创作'] }),
        mkNote('00_Inbox/丁.md'),
      ];
      const raws = await ruleSuggestions(inputs(INBOX_DIR, notes));
      const of = (rel: string): RawSuggestion[] => raws.filter((r) => r.path === rel);
      eq(of('00_Inbox/甲.md')[0]?.to, '02_Areas/内容创作', '声明优先');
      eq(of('00_Inbox/甲.md')[0]?.prio, 20);
      const fb = of('00_Inbox/丁.md');
      eq(fb.length, 1, '没信号的只出一条兜底');
      eq(fb[0]?.prio, 90, '兜底在最后一档');
      contains(fb[0]?.why ?? '', '兜底', '兜底的文案说得出自己是兜底');
      eq(fb[0]?.to, '02_Areas');
    });

    await suite.it('启发层：标签 / 文件名 / 内容三信号各能命中（且都盖过兜底）', async () => {
      const notes = [
        mkNote('00_Inbox/丙.md'), // 标签
        mkNote('00_Inbox/戊 内容创作计划.md'), // 文件名
        mkNote('00_Inbox/己.md'), // 内容（H1）
        mkNote('00_Inbox/辛.md'), // 标签指向收件箱本身 → 不许进
      ];
      const raws = await ruleSuggestions(inputs(INBOX_DIR, notes));
      const fin = finalize(raws, {
        metaDir: '99_Meta',
        exclude: [],
        scope: INBOX_DIR,
        dirs: inputs(INBOX_DIR, notes).dirs,
        noteOf: (rel) => {
          const n = notes.find((x) => x.path === `${KB}/${rel}`);
          return n ? { isTemplate: n.isTemplate, dirRel: n.dir } : undefined;
        },
        aiDirRel: '99_Meta/03_AI指令集',
      });
      const item = (rel: string): SuggestItem | undefined => fin.items.find((i) => i.path === rel && i.kind === 'move');
      eq(item('00_Inbox/丙.md')?.to, '02_Areas/游戏研究', '标签命中');
      contains(item('00_Inbox/丙.md')?.evidence ?? '', '标签', '佐证行说得出信号');
      eq(item('00_Inbox/戊 内容创作计划.md')?.to, '02_Areas/内容创作', '文件名命中');
      contains(item('00_Inbox/戊 内容创作计划.md')?.evidence ?? '', '文件名');
      eq(item('00_Inbox/己.md')?.to, '02_Areas/游戏研究', '内容（H1）命中');
      contains(item('00_Inbox/己.md')?.evidence ?? '', '标题');
      // 辛：标签「收件箱」→ 目标是收件箱本身 → 启发层拒绝；最终落回兜底
      eq(item('00_Inbox/辛.md')?.to, '02_Areas', '往收件箱搬的启发不推（兜底接住）');
      ok(
        !fin.items.some((i) => i.evidence?.includes('收件箱')),
        '没有任何一条建议是"按标签「收件箱」归位"',
      );
      // 每篇只有一条（启发盖掉兜底 → dup 计数 ≥ 3）
      ok(fin.dropped.filter((d) => d.code === 'dup').length >= 3, '被盖的兜底进了拦下计数');
    });

    await suite.it('全库范围：域外没声明的笔记也吃启发层；有声明的不会被猜', async () => {
      const notes = [
        mkNote('01_Projects/壬.md'), // 标签 → 游戏研究
        mkNote('01_Projects/癸.md'), // 无信号 → 什么都不出
        mkNote('01_Projects/子.md', { declared: ['02_旧知识库/x'] }), // 声明指向排除区 → 待定，不许猜
      ];
      const raws = await ruleSuggestions(inputs('', notes));
      eq(raws.filter((r) => r.path === '01_Projects/壬.md')[0]?.to, '02_Areas/游戏研究', '标签命中');
      eq(raws.filter((r) => r.path === '01_Projects/癸.md').length, 0, '没信号的不出');
      eq(raws.filter((r) => r.path === '01_Projects/子.md').length, 0, '有声明的笔记不猜（它的待定另说）');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ③ 纯函数：学过往
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · 学过往（记录 / 阈值 / 上限，纯函数）', async () => {
    const empty = (): MoveStats => ({ tag: {}, dir: {} });

    await suite.it('记录：按标签与来源目录各记一条；原地不记；库根（空键）不记', () => {
      const next = recordMoves(
        empty(),
        [{ from: `${KB}/00_Inbox/甲.md`, to: `${KB}/02_Areas/内容创作/甲.md`, tags: ['内容创作'] }],
        KB,
      );
      eq(next.tag['内容创作']?.['02_Areas/内容创作'], 1, '标签类记上了');
      eq(next.dir['00_Inbox']?.['02_Areas/内容创作'], 1, '目录类记上了');
      const same = recordMoves(next, [{ from: `${KB}/a/x.md`, to: `${KB}/a/x.md`, tags: [] }], KB);
      eq(Object.keys(same.dir['a'] ?? {}).length, 0, '原地不动的不记');
      // 库根（'' 键）跳过（独立审查 🟢9）：settings 读盘收敛会把空键丢掉，学了也存不住
      const rootMove = recordMoves(empty(), [{ from: `${KB}/x.md`, to: `${KB}/02_Areas/x.md`, tags: ['t'] }], KB);
      eq(Object.keys(rootMove.dir).length, 0, '库根来源不记');
      eq(Object.keys(rootMove.tag).length, 0, '库根来源连标签类也不记（去重口径一致）');
    });

    await suite.it('阈值：见过 1 次不出建议，2 次才出（且标签类优先于目录类）', () => {
      let s = empty();
      const bump = (): void => {
        s = recordMoves(s, [{ from: `${KB}/00_Inbox/甲.md`, to: `${KB}/02_Areas/内容创作/甲.md`, tags: ['内容创作'] }], KB);
      };
      bump();
      const note = { pathRel: '00_Inbox/新.md', dirRel: '00_Inbox', tags: ['内容创作'] };
      eq(suggestLearned(s, [note]).length, 0, '只见过 1 次：不出');
      bump();
      const hits = suggestLearned(s, [note]);
      eq(hits.length, 1, '见过 2 次：出');
      eq(hits[0].to, '02_Areas/内容创作');
      contains(hits[0].evidence, '2 次');
      eq(suggestLearned(s, [{ pathRel: '00_Inbox/x.md', dirRel: '00_Inbox', tags: [] }]).length, 1, '没标签的走目录类');
      const both = suggestLearned(s, [{ pathRel: '00_Inbox/x.md', dirRel: '00_Inbox', tags: ['内容创作'] }]);
      contains(both[0].evidence, '标签', '两类都在时标签类优先');
    });

    await suite.it('上限：每类键 ≤ LEARN_MAX_KEYS、每键落点 ≤ LEARN_MAX_DIRS（满了不再长）', () => {
      let s = empty();
      for (let i = 0; i < LEARN_MAX_KEYS + 5; i += 1) {
        s = recordMoves(s, [{ from: `${KB}/00_Inbox/${i}.md`, to: `${KB}/02_Areas/${i}/${i}.md`, tags: [`t${i}`] }], KB);
      }
      eq(Object.keys(s.tag).length, LEARN_MAX_KEYS, `标签类键封顶 ${LEARN_MAX_KEYS}`);
      // 同一个标签搬去很多落点 → 落点封顶
      let s2 = empty();
      for (let i = 0; i < LEARN_MAX_DIRS + 4; i += 1) {
        s2 = recordMoves(s2, [{ from: `${KB}/00_Inbox/${i}.md`, to: `${KB}/02_Areas/d${i}/${i}.md`, tags: ['同标签'] }], KB);
      }
      eq(Object.keys(s2.tag['同标签']).length, LEARN_MAX_DIRS, `每键落点封顶 ${LEARN_MAX_DIRS}`);
    });
  });

  // ════════════════════════════════════════════════════════════
  // ④ 纯函数：MOC（解析 / 插入 / 规则行）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · MOC（只加不删，纯函数）', async () => {
    const page = [
      '# 地图',
      '',
      '## 🌐 五大区域入口',
      '',
      '| a | b |',
      '',
      '## 📇 自动索引',
      '',
      '- 这一节留给自动挂链',
      '',
      '## 相关笔记',
      '- [[01_新知识库/x]]',
      '',
    ].join('\n');

    await suite.it('parseSections 只认 H2（### 子节不算）', () => {
      eq(parseSections('# t\n## 甲\n### 子\n## 乙\n').join(','), '甲,乙');
    });

    await suite.it('插入：落在目标节的末尾（下一个 ## 之前），既有行一个都不动', () => {
      const r = insertMocBullet(page, '📇 自动索引', '- [[01_新知识库/新笔记]]');
      ok(r && !r.already, '插进去了');
      const lines = r!.text.split('\n');
      const iNew = lines.findIndex((l) => l.includes('新笔记'));
      const iNext = lines.findIndex((l) => l === '## 相关笔记');
      const iAnchor = lines.findIndex((l) => l.includes('留给自动挂链'));
      ok(iAnchor < iNew && iNew < iNext, '新行在「挂链目标行之后、下一节之前」');
      eq(lines.filter((l) => l.startsWith('| a')).length, 1, '表行原样');
      eq(lines.find((l) => l.includes('x]]')), '- [[01_新知识库/x]]', '尾部节的既有行原样');
    });

    await suite.it('幂等：已有同链接 → already，一个字节不变', () => {
      const r = insertMocBullet(page, '📇 自动索引', '- [[01_新知识库/x]]');
      ok(r?.already, '认出来了');
      eq(r!.text, page, '文本原样');
    });

    await suite.it('节不存在 → null；空节插入时补一行空行', () => {
      eq(insertMocBullet(page, '不存在的节', '- [[x]]'), null);
      const emptySec = '## 甲\n## 乙\n- [[old]]\n';
      const r = insertMocBullet(emptySec, '甲', '- [[new]]');
      ok(r && !r.already, '空节也插得进（补了空行）');
      const lines = r!.text.split('\n');
      eq(lines[0], '## 甲');
      eq(lines[1], '', '标题后补了空行');
      eq(lines[2], '- [[new]]');
      eq(lines[3], '## 乙', '下一节没被吞');
    });

    await suite.it('规则行：有「自动索引」节才有行，没有就一条都不出', () => {
      const ctxA = {
        page: '99_Meta/04_索引与地图/MOC_知识地图.md',
        pageAbs: `${KB}/99_Meta/04_索引与地图/MOC_知识地图.md`,
        sections: ['🌐 入口', '📇 自动索引'],
        autoSection: '📇 自动索引',
        candidates: [{ pathRel: '01_Projects/甲.md', abs: `${KB}/01_Projects/甲.md`, basename: '甲.md', mtime: 1 }],
      };
      const raws = mocRuleRaw(ctxA);
      eq(raws.length, 1);
      eq(raws[0].kind, 'moc');
      eq(raws[0].to, '📇 自动索引');
      eq(mocRuleRaw({ ...ctxA, autoSection: null }).length, 0, '没有「自动索引」节 → 不出');
    });

    await suite.it('P7.10 · #10：同篇「自动索引」规则行 + AI 选节 → **AI 胜出**（prio 降兜底档）', () => {
      /**
       * 拍板口径（方案 §9 六拍）：「AI 选节」能盖过「自动索引」的规则行 ——
       * 「自动索引」本来就该是兜底堆放（此前 30 < 60，AI 行永远出不来）。
       * 实现 = `mocRuleRaw` 的 prio `tag → fallback`。
       * ⚠️ **突变目标**：把那条 prio 改回 `SUGGEST_PRIO.tag`，本用例当场红
       *（同 id `moc:<path>` 在 finalize 里按 prio 小者胜去重）。
       */
      const ctxA = {
        page: '99_Meta/04_索引与地图/MOC_知识地图.md',
        pageAbs: `${KB}/99_Meta/04_索引与地图/MOC_知识地图.md`,
        sections: ['🌐 入口', '📇 自动索引'],
        autoSection: '📇 自动索引',
        candidates: [
          { pathRel: '01_Projects/甲.md', abs: `${KB}/01_Projects/甲.md`, basename: '甲.md', mtime: 1 },
        ],
      };
      const rule = mocRuleRaw(ctxA);
      eq(rule.length, 1, '规则行在（前提：有「自动索引」节）');
      const ai = mocAiRaw([{ path: '01_Projects/甲.md', to: '🌐 入口', why: '更像这一节' }], ctxA.page);
      eq(ai.length, 1, 'AI 选节行在（前提）');
      const pre: PrecheckCtx = {
        metaDir: '99_Meta',
        exclude: [],
        scope: '',
        dirs: new Set(['', '01_Projects']),
        noteOf: (rel) =>
          rel === '01_Projects/甲.md' ? { isTemplate: false, dirRel: '01_Projects' } : undefined,
        aiDirRel: '99_Meta/03_AI指令集',
        mocSections: new Set(['🌐 入口', '📇 自动索引']),
        mocLinked: () => false,
      };
      const r = finalize([...rule, ...ai], pre);
      eq(r.items.length, 1, '同篇只出一条');
      eq(r.items[0].source, 'ai', 'AI 选节胜出（降档前这里是 rule）');
      eq(r.items[0].to, '🌐 入口', '留下的是 AI 挑的节，不是「自动索引」');
      // 没有 AI 行时规则行照出 —— 行为只在"两者都在"时分叉
      const r2 = finalize([...mocRuleRaw(ctxA)], pre);
      eq(r2.items.length, 1);
      eq(r2.items[0].source, 'rule');
      eq(r2.items[0].to, '📇 自动索引');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑤ 双链推荐（纯打分 + 真库跑一把）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · 双链推荐（只读）', async () => {
    await suite.it('标题相似度：CJK bigram，同标题=1、无关=低', () => {
      eq(titleSimilarity('插件开发计划', '插件开发计划'), 1);
      ok(titleSimilarity('插件开发计划', '游戏研究笔记') < 0.2, '无关的低');
    });

    await suite.it('真库跑一把：共同标签+共链的一对会被推出来；已互链的不推', async () => {
      // A、B 互不认识，但都被 C 链接、且共享标签 → 应出现
      mkNote('03_Resources/__建议双链A.md', { tags: `[${T}链]` }, 'A\n');
      mkNote('03_Resources/__建议双链B.md', { tags: `[${T}链]` }, 'B\n');
      mkNote('03_Resources/__建议双链C.md', { tags: '[]' }, `指向 [[${KB}/03_Resources/__建议双链A]] 与 [[${KB}/03_Resources/__建议双链B]]\n`);
      // D、E 已经互链 → 不许推
      mkNote('03_Resources/__建议双链D.md', { tags: `[${T}链2]` }, `连去 [[${KB}/03_Resources/__建议双链E]]\n`);
      mkNote('03_Resources/__建议双链E.md', { tags: `[${T}链2]` }, `连去 [[${KB}/03_Resources/__建议双链D]]\n`);
      await H.settle(120);
      /**
       * ⚠️ `max: 50`：面板只显示前 5 对（那是 UI 口味），但这条判据要验**打分与过滤**
       * —— 夹具里本来就有别的成对笔记（每日任务 / 示例项目那些），把 cap 收到 5
       * 会把我们的 A↔B 挤出去（第一版就是这么假红的）。
       */
      const pairs: LinkPair[] = linkPairs(
        { app: app as never, settings: ctx().settings, index: ctx().index },
        ['99_Meta'],
        { max: 50 },
      );
      const has = (x: string, y: string): boolean =>
        pairs.some((p) => (p.a.endsWith(x) && p.b.endsWith(y)) || (p.a.endsWith(y) && p.b.endsWith(x)));
      ok(has('__建议双链A.md', '__建议双链B.md'), `A↔B 应被推出（实际 ${pairs.map((p) => `${p.a}↔${p.b}`).join(' | ')}）`);
      ok(!has('__建议双链D.md', '__建议双链E.md'), '已互链的不推');
      for (const rel of ['03_Resources/__建议双链A.md', '03_Resources/__建议双链B.md', '03_Resources/__建议双链C.md', '03_Resources/__建议双链D.md', '03_Resources/__建议双链E.md']) {
        rm(rel);
      }
      await H.settle(80);
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑥ 真链路：面板 → 确认流 → 搬 + 撤销还原
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · 面板真链路（搬 + 撤销）', async () => {
    await suite.it('开面板 → 行出现 → 只勾目标 → 执行 → 真搬 + 撤销条 → 撤销还原', async () => {
      __resetNotices();
      __resetUndo();
      closeAllMenus();
      const noteRel = '00_Inbox/__建议搬我.md';
      const absNote = path.join(vaultRoot, KB, noteRel);
      /**
       * ⚠️ **不给「文件位置」**：给了就等于"声明==现状" → planRebuild 直接跳过它，
       * 一行建议都不出（第一版就是这么绿的：面板算不出行）。不给声明 + 没信号
       *（v2：领域已退役）→ 走**兜底目录**那条路出建议，顺带把"搬完补声明"也真跑上。
       */
      mkNote(noteRel, { tags: '[]' });
      await H.settle(120);

      const before = ctx().index.get(`${KB}/${noteRel}`);
      ok(before !== undefined, '前提：笔记在索引里');

      const h = openSuggestPanel(ctx(), { scope: INBOX_DIR });
      // 等本地源算完（行出现）
      const rows = await untilEl(() => {
        const all = H.qa(h.body, '.kbw-suggest-row');
        return all.some((r) => H.textOf(r).includes('__建议搬我')) ? all : null;
      });
      ok(rows !== null, '面板算出行了');

      // 只勾「__建议搬我」那一行（把其它默认勾选的都点掉 —— 那些是夹具里的别的笔记，不能动）
      for (let guard = 0; guard < 40; guard += 1) {
        const all = H.qa<HTMLElement>(h.body, '.kbw-suggest-row');
        const row = all.find((r) => H.textOf(r).includes('__建议搬我'));
        const others = all.filter((r) => !H.textOf(r).includes('__建议搬我'));
        const otherChecked = others.find((r) => (r.querySelector('input') as HTMLInputElement | null)?.checked);
        if (row && (row.querySelector('input') as HTMLInputElement | null)?.checked && !otherChecked) break;
        if (otherChecked) H.click(otherChecked);
        else if (row) H.click(row);
        await H.settle(20);
      }
      /**
       * P7.11 · #12：执行入口 = **「AI 自动去做」**（老的「搬这 N 篇」按钮退役）。
       * 走一遭真链路：配 key + 空建议桩（分类那一跳不添行）→ 点它 → 确认流。
       */
      const prevKey2 = ctx().settings.get().ai.apiKey;
      await H.configAi(plugin);
      H.resetAi();
      H.stubAi({ reply: '（用例）看了一遍', ideas: [] });
      const runBtn = H.qa<HTMLElement>(h.body, '.kbw-suggest-bar .kbw-btn').find((b) =>
        H.textOf(b).includes('AI 自动去做'),
      );
      ok(runBtn !== undefined, '有「AI 自动去做」按钮');
      contains(
        H.textOf(H.q<HTMLElement>(h.body, '.kbw-suggest-count')),
        '已勾 1 项',
        '只剩那一篇被勾（其它夹具笔记不在本次执行里）',
      );
      H.click(runBtn!);
      /**
       * 确认流：走同一个 confirm（`.kbw-modal`）。
       * ⚠️ **面板自己也是一枚 `.kbw-modal`** —— `H.q` 只取第一个会拿到面板本身
       *（第一版就是这么假红的）。要**遍历所有模态**去找"执行这 N 项"那枚主按钮。
       */
      const primary = await untilEl(() => {
        for (const modal of H.qa<HTMLElement>(document.body, '.kbw-modal')) {
          const b = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) => H.textOf(x).includes('执行这'));
          if (b) return b;
        }
        return null;
      });
      ok(primary !== null, '确认流弹出来了');
      H.resetAi();
      await H.configAi(plugin, { apiKey: prevKey2 });
      H.click(primary!);
      await H.until(() => fs.existsSync(path.join(vaultRoot, KB, '02_Areas/__建议搬我.md')));
      ok(fs.existsSync(path.join(vaultRoot, KB, '02_Areas/__建议搬我.md')), '真搬到落点了（v2：兜底目录 02_Areas）');
      ok(!fs.existsSync(absNote), '老位置没了（成对判）');
      // 补声明：没声明的被搬笔记要写「文件位置」
      const movedText = fs.readFileSync(path.join(vaultRoot, KB, '02_Areas/__建议搬我.md'), 'utf8');
      contains(movedText, '02_Areas', '「文件位置」补上了（这次决定留痕）');
      // 撤销条 → 撤销 → 还原
      // ⚠️ A8（P7.21a 顺带收）：取"最新一条且非离场"的条上那枚「撤销」——
      // 裸 `q('.kbw-undobar')` 按文档顺序拿的是**旧条**（离场窗口里两条并存，P7.19 的教训）
      const undoBtn = await untilEl(() => H.currentUndoButton('撤销'));
      ok(undoBtn !== null, '撤销条在');
      H.click(undoBtn!);
      await H.until(() => fs.existsSync(absNote));
      ok(fs.existsSync(absNote), '撤销 = 从快照还原，搬回来了');
      h.close('test');
      rm('02_Areas/__建议搬我.md');
      await H.settle(80);
    });

    await suite.it('🟡1 回归：用户取消的勾选**不会被"刷新"/重算重新勾上**（独立审 🟡1）', async () => {
      closeAllMenus();
      const h = openSuggestPanel(ctx(), { scope: INBOX_DIR });
      const rows = await untilEl(() => {
        const all = H.qa<HTMLElement>(h.body, '.kbw-suggest-row');
        return all.length > 0 ? all : null;
      });
      ok(rows !== null, '前提：面板有行');
      const target = rows![0];
      const label = H.textOf(target);
      const cb = target.querySelector('input') as HTMLInputElement | null;
      ok(cb != null && cb.checked, '前提：默认是勾上的');
      H.click(target); // 整行点击 = 取消勾选
      await H.settle(30);
      eq(
        (H.qa<HTMLElement>(h.body, '.kbw-suggest-row').find((r) => H.textOf(r) === label)
          ?.querySelector('input') as HTMLInputElement | null)?.checked,
        false,
        '前提：确实取消了',
      );
      /**
       * 点「刷新」= 重算（compose 会重跑）。
       * ⚠️ P7.9 · ⑥：刷新**缩成小图标按钮**（没有文本了）—— 认 `aria-label`
       *（`iconBtn` 的 label 就是'刷新'／忙碌时'刷新中…'），别再按文本找。
       */
      const refreshBtn = H.qa<HTMLElement>(h.body, '.kbw-suggest-head .kbw-iconbtn').find((b) =>
        (b.getAttribute('aria-label') ?? '').includes('刷新'),
      );
      ok(refreshBtn !== undefined, '找得到刷新按钮');
      H.click(refreshBtn!);
      await H.until(
        () =>
          H.qa(h.body, '.kbw-suggest-row').length > 0 &&
          H.qa<HTMLElement>(h.body, '.kbw-suggest-head .kbw-iconbtn').some(
            (b) => (b.getAttribute('aria-label') ?? '') === '刷新',
          ),
        4000,
      );
      const after = H.qa<HTMLElement>(h.body, '.kbw-suggest-row').find((r) => H.textOf(r) === label);
      ok(after !== undefined, '刷新后同一篇还在列表里');
      eq(
        (after!.querySelector('input') as HTMLInputElement | null)?.checked,
        false,
        '🔴 取消了的就是取消的 —— 重算不许把它重新勾上（一次确认会把排除掉的也执行了）',
      );
      h.close('test');
      await H.settle(60);
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑦ MOC 真写（只加不删 + 快照还原）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · MOC 挂链真写', async () => {
    await suite.it('appendMocItems：真加一行、只加不删、幂等、可快照还原', async () => {
      const pageRel = '99_Meta/04_索引与地图/MOC_知识地图.md';
      const absPage = path.join(vaultRoot, KB, pageRel);
      fs.mkdirSync(path.dirname(absPage), { recursive: true });
      const original = ['# 地图', '', '## 📇 自动索引', '', '- 留白', '', '## 相关笔记', '- [[01_新知识库/x]]', ''].join('\n');
      fs.writeFileSync(absPage, original, 'utf8');
      app.vault.rescan();
      void app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(80);

      mkNote('01_Projects/__建议挂我.md', { tags: '[]' });

      const r = await appendMocItems(ctx(), pageRel, [{ path: '01_Projects/__建议挂我.md', to: '📇 自动索引' }]);
      eq(r.added, 1, '加了一条');
      eq(r.missed, 0);
      const after = fs.readFileSync(absPage, 'utf8');
      contains(after, `- [[01_新知识库/01_Projects/__建议挂我]]`, '双链按页面格式（库内绝对路径去扩展名）');
      eq(after.split('\n').filter((l) => l.includes('x]]')).length, 1, '既有行一个不动');
      ok(after.startsWith('# 地图\n\n## 📇 自动索引'), '头部不乱');

      // 幂等：再来一次 → already，不重复
      const r2 = await appendMocItems(ctx(), pageRel, [{ path: '01_Projects/__建议挂我.md', to: '📇 自动索引' }]);
      eq(r2.added, 0);
      eq(r2.already, 1);
      eq(fs.readFileSync(absPage, 'utf8'), after, '第二次一个字节没变');

      // 快照还原 → 页面回到原样（用**第一次**的快照：它是"写入之前"那一份）
      await ctx().snapshot.restore(r.snapshotId);
      eq(fs.readFileSync(absPage, 'utf8'), original, '还原 = 挂链前的页面');

      rm('01_Projects/__建议挂我.md');
      await H.settle(80);
    });

    await suite.it('🟡2 回归：MOC 候选超显示上限时，**看不见的行不进执行集**（独立审 🟡2）', async () => {
      const pageRel = '99_Meta/04_索引与地图/MOC_知识地图.md';
      const absPage = path.join(vaultRoot, KB, pageRel);
      fs.mkdirSync(path.dirname(absPage), { recursive: true });
      const original = ['# 地图', '', '## 📇 自动索引', '', '- 留白', ''].join('\n');
      fs.writeFileSync(absPage, original, 'utf8');
      // 造 21 篇"没挂过"的候选（> 显示上限 20）
      for (let i = 0; i < 21; i += 1) mkNote(`01_Projects/__建议一${i}.md`, { tags: '[]' });
      app.vault.rescan();
      void app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(150);

      const h = openSuggestPanel(ctx(), { scope: INBOX_DIR });
      await untilEl(() => h.body.querySelector('.kbw-suggest-choice'), 3000);
      // P7.11 · #12：切到 C 类（结尾双链 = 挂链行 + 尾链行）
      const optC = H.qa<HTMLElement>(h.body, '.kbw-suggest-opt').find((o) => o.dataset.cls === 'C');
      ok(optC !== undefined, 'C 项在');
      H.click(optC!);
      const mocRowsOf = (): HTMLElement[] =>
        H.qa<HTMLElement>(h.body, '.kbw-suggest-row').filter((r) => {
          const t = r.querySelector('.kbw-suggest-to');
          return t !== null && H.textOf(t).charAt(0) === '「';
        });
      const shown = await untilEl(() => {
        const m = mocRowsOf();
        return m.length > 0 ? m : null;
      }, 4000);
      ok(shown !== null, '挂链行出来了');
      eq(shown!.length, 20, '清单只画 20 行（候选 21 篇 —— 显示上限 20；看不见的行不进执行集）');
      /**
       * ⚠️ C 类里还有**尾链行**（缺「## 关联笔记」段的笔记，含这 21 篇夹具与库里别处）——
       * 它们默认也被勾着。执行前把非挂链行点掉：这条用例只验"挂链只挂画出来的 20 行"，
       * 别顺手把全库的尾链都补了。
       */
      for (let guard = 0; guard < 80; guard += 1) {
        const all = H.qa<HTMLElement>(h.body, '.kbw-suggest-row');
        const isMoc = (r: HTMLElement): boolean => {
          const t = r.querySelector('.kbw-suggest-to');
          return t !== null && H.textOf(t).charAt(0) === '「';
        };
        const otherOn = all.find(
          (r) => (r.querySelector('input') as HTMLInputElement | null)?.checked && !isMoc(r),
        );
        if (!otherOn) break;
        H.click(otherOn);
        await H.settle(20);
      }
      // 执行入口 = 「AI 自动去做」（走一遭真链路：空建议桩）
      const prevKey3 = ctx().settings.get().ai.apiKey;
      await H.configAi(plugin);
      H.resetAi();
      H.stubAi({ reply: '（用例）看了一遍', ideas: [] });
      const bar = H.qa<HTMLElement>(h.body, '.kbw-suggest-bar .kbw-btn').find((x) =>
        H.textOf(x).includes('AI 自动去做'),
      );
      ok(bar !== undefined, '找得到「AI 自动去做」');
      H.click(bar!);
      const mPrimary = await untilEl(() => {
        for (const modal of H.qa<HTMLElement>(document.body, '.kbw-modal')) {
          const b = H.qa<HTMLElement>(modal, '.kbw-modal-foot .kbw-btn').find((x) => H.textOf(x).includes('执行这'));
          if (b) return b;
        }
        return null;
      });
      ok(mPrimary !== null, '挂链确认流弹出来了');
      H.resetAi();
      await H.configAi(plugin, { apiKey: prevKey3 });
      H.click(mPrimary!);
      await H.until(() => fs.readFileSync(absPage, 'utf8').includes('[[01_新知识库/01_Projects/__建议一'), 4000);
      const text = fs.readFileSync(absPage, 'utf8');
      const n = (text.match(/- \[\[01_新知识库\/01_Projects\/__建议一\d+\]\]/g) ?? []).length;
      eq(n, 20, '页面只该多 20 行（显示上限外的那些不许被偷偷挂上）');
      // ⚠️ 别断言"具体哪一篇没挂上"：21 篇的 mtime 几乎并列，排序取的是哪 20 篇不可控 —— 只认总数
      // 收场：还原页面 + 收走 21 篇
      fs.writeFileSync(absPage, original, 'utf8');
      app.vault.rescan();
      void app.metadataCache.settle();
      ctx().index.rebuild();
      for (let i = 0; i < 21; i += 1) rm(`01_Projects/__建议一${i}.md`);
      h.close('test');
      await H.settle(100);
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑧ 学习钩子：mover → data.json
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · 学习钩子（mover → moveStats）', async () => {
    await suite.it('手动来源记两次 → 阈值达标；AI 来源不记；落的是 data.json', async () => {
      mkNote('00_Inbox/__建议学1.md', { tags: '[习惯标签]' });
      mkNote('00_Inbox/__建议学2.md', { tags: '[习惯标签]' });
      await H.settle(120);
      const f1 = app.vault.getAbstractFileByPath(`${KB}/00_Inbox/__建议学1.md`) as TFile;
      const f2 = app.vault.getAbstractFileByPath(`${KB}/00_Inbox/__建议学2.md`) as TFile;
      ok(f1 != null && f2 != null, '前提：两个文件在');

      await ctx().mover.move({
        targets: [{ dir: `${KB}/02_Areas`, files: [f1] }],
        source: 'menu',
        reason: '测试学习（一轮）',
      });
      let stats = ctx().settings.get().moveStats;
      eq(stats.tag['习惯标签']?.['02_Areas'], 1, '第一次记上了');
      eq(stats.dir['00_Inbox']?.['02_Areas'], 1);

      // 阈值判据：只学过一次 → 不出建议
      eq(suggestLearned(stats, [{ pathRel: '00_Inbox/新.md', dirRel: '00_Inbox', tags: ['习惯标签'] }]).length, 0);

      await ctx().mover.move({
        targets: [{ dir: `${KB}/02_Areas`, files: [f2] }],
        source: 'drag', // 拖拽也是手动来源
        reason: '测试学习（二轮）',
      });
      stats = ctx().settings.get().moveStats;
      eq(stats.tag['习惯标签']?.['02_Areas'], 2, '第二次累加');
      eq(suggestLearned(stats, [{ pathRel: '00_Inbox/新.md', dirRel: '00_Inbox', tags: ['习惯标签'] }]).length, 1, '两次后出建议');

      // AI 来源不学
      mkNote('00_Inbox/__建议学3.md', { tags: '[习惯标签]' });
      await H.settle(80);
      const f3 = app.vault.getAbstractFileByPath(`${KB}/00_Inbox/__建议学3.md`) as TFile;
      await ctx().mover.move({ targets: [{ dir: `${KB}/02_Areas`, files: [f3] }], source: 'ai', reason: '测试学习（AI 不该记）' });
      eq(ctx().settings.get().moveStats.tag['习惯标签']?.['02_Areas'], 2, 'AI 来源不记（还是 2）');

      // 落盘：data.json 里真有这个键
      const raw = JSON.parse(fs.readFileSync(H.dataJsonPath(vaultRoot), 'utf8')) as { moveStats?: MoveStats };
      eq(raw.moveStats?.tag?.['习惯标签']?.['02_Areas'], 2, 'data.json 里落着');

      for (const rel of ['02_Areas/__建议学1.md', '02_Areas/__建议学2.md', '02_Areas/__建议学3.md']) rm(rel);
      await ctx().settings.save({ moveStats: { tag: {}, dir: {} } });
      await H.settle(80);
    });

    await suite.it('`moveStats` 是"新键 + 空哨兵"：读 P7.6 之前的旧盘不改 settingsVersion（17.1 口径）', async () => {
      const p = H.dataJsonPath(vaultRoot);
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      const verBefore = raw.settingsVersion;
      delete raw.moveStats; // 模拟 P7.6 之前的 data.json（没有这个键）
      H.writeRawDataJson(vaultRoot, raw);
      await ctx().settings.load(); // **读盘入口**（迁移只挂这一处）
      eq(ctx().settings.get().settingsVersion, verBefore, '版本号原样（moveStats 没配迁移段、也不该配）');
      eq(Object.keys(ctx().settings.get().moveStats.tag).length, 0, 'moveStats 回落默认空表');
      eq(Object.keys(ctx().settings.get().moveStats.dir).length, 0, 'dir 段同理');
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑨ 维护三件（16.4）+ 待处理行
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · 库维护三件（16.4）', async () => {
    await suite.it('孤儿/重复/未使用标签：算得对（引用到的不算、模板的不算）', async () => {
      __resetMaintenance();
      // 孤儿：没人引用；被引：有 embed 指向
      fs.mkdirSync(path.join(vaultRoot, KB, '03_Resources'), { recursive: true });
      fs.writeFileSync(path.join(vaultRoot, KB, '03_Resources/__建议孤儿.png'), 'ORPHAN-PNG-BYTES', 'utf8');
      fs.writeFileSync(path.join(vaultRoot, KB, '03_Resources/__建议被引.png'), 'REFERENCED-PNG', 'utf8');
      mkNote('03_Resources/__建议引者.md', { tags: '[只一次]' }, `![[__建议被引.png]]\n`);
      // 重复：同内容两件（另加一个同 size 不同内容的干扰项）
      fs.writeFileSync(path.join(vaultRoot, KB, '03_Resources/__建议重复甲.bin'), 'SAME-CONTENT-123', 'utf8');
      fs.writeFileSync(path.join(vaultRoot, KB, '03_Resources/__建议重复乙.bin'), 'SAME-CONTENT-123', 'utf8');
      fs.writeFileSync(path.join(vaultRoot, KB, '03_Resources/__建议不同丙.bin'), 'SAME-CONTENT-124', 'utf8'); // 同长度、内容不同
      app.vault.rescan();
      void app.metadataCache.settle();
      ctx().index.rebuild();
      await H.settle(120);

      const f = await computeMaintenance({
        app: app as never,
        settings: ctx().settings,
        index: ctx().index,
        exclude: ['99_Meta', '02_旧知识库', '还原保留', '.开头'],
        revision: ctx().store.get().indexRevision,
      });
      ok(f.orphans.rels.includes('03_Resources/__建议孤儿.png'), `孤儿认出来（${f.orphans.rels.join(' | ')}）`);
      ok(!f.orphans.rels.includes('03_Resources/__建议被引.png'), '被嵌入引用的不算孤儿');
      const dupGroup = f.dups.groups.find((g) => g.includes('03_Resources/__建议重复甲.bin'));
      ok(dupGroup !== undefined, '重复组认出来');
      ok(dupGroup!.length === 2 && dupGroup!.includes('03_Resources/__建议重复乙.bin'), '组里是这两件');
      ok(!dupGroup!.includes('03_Resources/__建议不同丙.bin'), '同长度不同内容的不算（哈希口径）');
      ok(f.unusedTags.tags.includes('只一次'), '一次性标签认出来');
      ok(
        f.unusedTags.notePaths.some((p) => p.endsWith('03_Resources/__建议引者.md')),
        '带它的笔记在跳转清单里',
      );

      // 缓存：同一修订号第二把现成的（对象同一）
      const f2 = await computeMaintenance({
        app: app as never,
        settings: ctx().settings,
        index: ctx().index,
        exclude: ['99_Meta', '02_旧知识库', '还原保留', '.开头'],
        revision: ctx().store.get().indexRevision,
      });
      eq(f === f2, true, '同一修订号走缓存（没重算）');

      // 待处理行：三条规则各就各位
      const todos = buildTodos(
        ctx().index.notes(),
        INBOX_DIR,
        { maintenance: f, migrateCount: 0 },
      );
      ok(todos.some((t) => t.id === 'orphan-files' && t.action === 'orphans'), '孤儿规则行在');
      ok(todos.some((t) => t.id === 'dup-files' && t.action === 'duplicates'), '重复规则行在');
      const tagRow = todos.find((t) => t.id === 'unused-tags');
      ok(tagRow !== undefined, '一次性标签规则行在');
      ok((tagRow?.intent?.paths ?? []).some((p) => p.endsWith('__建议引者.md')), '点它是跳到带这些标签的笔记');

      for (const rel of [
        '03_Resources/__建议孤儿.png',
        '03_Resources/__建议被引.png',
        '03_Resources/__建议引者.md',
        '03_Resources/__建议重复甲.bin',
        '03_Resources/__建议重复乙.bin',
        '03_Resources/__建议不同丙.bin',
      ]) {
        rm(rel);
      }
      __resetMaintenance();
      await H.settle(80);
    });
  });

  // ════════════════════════════════════════════════════════════
  // ⑩ AI 分类（假模型 → buildAiPlan → 面板口径）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.6 · AI 分类（假传输层）', async () => {
    await suite.it('classify → buildAiPlan 拦 protected；aiPlanRaw 换算 + 收件箱口径', async () => {
      const rel = '00_Inbox/__建议AI甲.md';
      mkNote(rel, { tags: '[]' });
      await H.settle(120);
      await H.configAi(plugin);
      H.resetAi();
      H.stubAi({
        reply: '看了一遍',
        ideas: [
          { path: rel, to: '02_Areas/内容创作', why: '内容像创作' },
          { path: rel, to: '99_Meta/03_AI指令集', why: '硬塞进去看看' },
          { path: '00_Inbox/不存在.md', to: '02_Areas', why: '幻觉' },
        ],
      });
      try {
        const res = await ctx().ai.classify({ scopeRel: INBOX_DIR });
        eq(res.plan.rows.length, 1, '只有一条过了闸');
        eq(res.plan.rows[0].dirRel, '02_Areas/内容创作');
        eq(res.plan.blocked.length, 2, 'protected 与 missing 都被拦下');
        ok(
          res.plan.blocked.some((b) => b.code === 'protected'),
          '🔴 硬拦在（AI 指令集）',
        );
        const converted = aiPlanRaw(res.plan, {
          scope: INBOX_DIR,
          dirRelOf: (r) => ctx().index.get(`${KB}/${r}`)?.effectivePosition,
        });
        eq(converted.items.length, 1, '换算出来一条');
        eq(converted.items[0].source, 'ai');
        ok(converted.dropped.some((d) => d.code === 'protected'), '拦下的原因码原样带出');
      } finally {
        H.resetAi();
        ctx().ai.transport = ctx().ai.http; // 换回真的那条（helpers 的口径：别自己再造一个）
      }
      rm(rel);
      await H.settle(80);
    });

    await suite.it('aiPlanRaw 的面板口径：到收件箱的建议剔掉（`to` 是**相对库根**口径）', () => {
      const plan = buildAiPlan({
        // ⚠️ `buildAiPlan` 吃的是**相对库根**的 path/to（模型的口径）——别拿库内绝对路径喂它
        ideas: [{ path: '01_Projects/x.md', to: INBOX_DIR, why: '搬回收件箱' }],
        kbRoot: KB,
        aiDir: `${KB}/99_Meta/03_AI指令集`,
        hasNote: () => true,
        dirs: new Set([`${KB}`, `${KB}/01_Projects`, `${KB}/${INBOX_DIR}`]),
      });
      eq(plan.rows.length, 1, '前提：buildAiPlan 放行了它（它不管"是不是整理"）');
      const r = aiPlanRaw(plan, { scope: '', dirRelOf: () => '01_Projects' });
      eq(r.items.length, 0, '往收件箱搬的建议不进面板');
      ok(r.dropped.some((d) => d.why.includes('收件箱')), '拦下时说得清原因');
    });

    await suite.it('🟡3 回归：**有声明的笔记**不进"学过往"建议、也不进 AI 分诊候选（独立审 🟡3）', async () => {
      const rel = '01_Projects/__建议声明.md';
      mkNote(rel, { 文件位置: '01_Projects', tags: '[声明标签]' });
      await H.settle(120);
      // 给它攒一个"足够强"的学习模式：带「声明标签」的都搬去 02_Areas（≥2 次）
      await ctx().settings.save({ moveStats: { tag: { 声明标签: { '02_Areas': 3 } }, dir: {} } });
      const local = await generateLocal(
        { app: app as never, settings: ctx().settings, index: ctx().index },
        { scope: '', exclude: ['99_Meta', '02_旧知识库', '还原保留', '.开头'], stats: ctx().settings.get().moveStats },
      );
      eq(
        local.learnedItems.find((i) => i.path === rel),
        undefined,
        '🔴 学过往不许对"有声明的"出建议（声明是用户明写的意图，界面上不许直接推翻）',
      );

      // AI 侧：候选清单里不许出现它 —— 读假传输层收到的**请求正文**（提示词全文）
      await H.configAi(plugin);
      H.resetAi();
      const stub = H.stubAi({ reply: '（候选检查）', ideas: [] });
      try {
        await ctx().ai.classify({ scopeRel: '' });
        const body = stub.calls.length > 0 ? String(stub.calls[stub.calls.length - 1]?.body ?? '') : '';
        ok(body.includes('知识库根目录'), `前提：抓到了提示词正文（长度 ${body.length}）`);
        ok(!body.includes('__建议声明'), '🔴 有声明的笔记不许进 AI 分拣候选（模型没机会提它）');
      } finally {
        H.resetAi();
      }
      await ctx().settings.save({ moveStats: { tag: {}, dir: {} } });
      rm(rel);
      await H.settle(80);
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.12 · R1/R2：建议面板版面（去圆点 / 空态下一步 / 底栏主次 / 来源入口带状态）
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.12 · R1/R2 建议面板版面', async () => {
    /** 空的受控范围：A 类一行都算不出来 —— 空态与底栏都在这上面看 */
    const EMPTY_SCOPE = '00_Inbox/__r12空';

    await suite.it('R1：选择题去圆点（选中=描边+淡底）、空态给"下一步"、底栏 AI 升主按钮', async () => {
      closeAllMenus();
      __resetNotices();
      const h = openSuggestPanel(ctx(), { scope: EMPTY_SCOPE });
      const choices = await untilEl(() => {
        const all = H.qa<HTMLElement>(h.body, '.kbw-suggest-opt');
        return all.length >= 4 ? all : null;
      });
      ok(choices !== null, '四选一渲染出来了');
      /**
       * ① 去圆点（照 §R1 稿：选中只靠 `.is-on` 的描边 + 淡底）。
       * ⚠️ 独立审 B4（P7.12 收尾）：原来钉的是 `.kbw-suggest-radio` 不存在 —— 该类已随
       * 功能从 src 删掉，"不存在"恒真；改钉**新形态**：默认恰好一个 `.is-on`，且是 A
       *（拍定：搬笔记是主路径）。
       */
      const onNow = H.qa<HTMLElement>(h.body, '.kbw-suggest-opt.is-on');
      eq(onNow.length, 1, '默认恰好一个选中（单选形态）');
      contains(H.textOf(onNow[0]), 'A ·', '默认选中的是 A');
      contains(H.textOf(choices![1]), 'B ·', '键徽标带「 · 」（照稿 "A · 搬笔记建议"）');
      contains(H.textOf(choices![1]), 'YAML 头建议', '标签还在');
      // ② 空态：主句 + 一句"下一步"
      const emptyBox = await untilEl(() => H.q<HTMLElement>(h.body, '.kbw-suggest-empty'));
      ok(emptyBox !== null, '空态渲染出来了');
      contains(H.textOf(emptyBox!), '没有要整理的', '主句照旧');
      contains(H.textOf(emptyBox!), '换上面别的类，或切「全库」看看', 'R1：空态给了"下一步"（不是孤零零一句）');
      // ③ 底栏主次：自己去整理在左（非主）、AI 在右（主按钮）
      const bar = H.q<HTMLElement>(h.body, '.kbw-suggest-bar');
      const btns = H.qa<HTMLElement>(bar, '.kbw-btn');
      const ai = btns.find((b) => H.textOf(b).includes('AI 自动去做'));
      const man = btns.find((b) => H.textOf(b).includes('自己去整理'));
      ok(ai !== undefined && man !== undefined, '两个动作都在');
      ok(ai!.classList.contains('is-primary'), 'R1：AI 升为主按钮（实心）');
      ok(!man!.classList.contains('is-primary'), '「自己去整理」不是主按钮（主次分明）');
      ok(btns.indexOf(man!) < btns.indexOf(ai!), '顺序：自己去整理在左、AI 在右');
      h.close('test');
      await H.settle(60);
    });

    await suite.it('R2：来源入口亮当前状态；弹层顶部一句人话 + 说明换大白话', async () => {
      closeAllMenus();
      const h = openSuggestPanel(ctx(), { scope: EMPTY_SCOPE });
      const btn = await untilEl(() => H.q<HTMLElement>(h.body, '.kbw-suggest-srcbtn'));
      ok(btn !== null, '来源按钮在');
      contains(H.textOf(btn!), '来源：规则 · 学过往', '入口直接亮出勾了谁（R2）');

      H.click(btn!);
      await H.settle(80);
      const menu = H.q<HTMLElement>(document.body, '.kbw-menu');
      ok(menu !== null, '菜单开了');
      ok(H.maybe(menu!, '.kbw-menu-hintline') !== null, '顶部那句是专门的 hint 行（不接点击）');
      contains(H.textOf(menu!), '这些建议从哪来？勾谁算谁', 'R2：顶部一句人话');
      contains(H.textOf(menu!), '按「文件位置/属性/标签」算', '规则行说明换大白话');
      contains(H.textOf(menu!), '按你以前搬过的同类学', '学过往行说明换大白话');
      contains(H.textOf(menu!), '作用范围', '「作用范围」行照旧（三条硬规矩）');

      // 关掉「学过往」→ 入口状态跟着变（面板就地重画）
      const row = H.qa<HTMLElement>(menu!, '.kbw-menu-item').find((r) => H.textOf(r).includes('学过往'));
      ok(row !== undefined, '「学过往」那行在');
      H.click(row!);
      await H.settle(100);
      const btn2 = H.q<HTMLElement>(h.body, '.kbw-suggest-srcbtn');
      contains(H.textOf(btn2), '来源：规则', '勾选变化 → 入口状态跟着变');
      ok(!H.textOf(btn2).includes('学过往'), '关掉的那个从状态里消失');
      closeAllMenus();
      h.close('test');
      await H.settle(60);
    });
  });

  // ════════════════════════════════════════════════════════════
  // P7.13a · #5a/#5b：红字全显（CSS 判据在 redline）· AI 跑完主动问清空
  // ════════════════════════════════════════════════════════════
  await suite.group('P7.13a · #5a/#5b 整理建议：红字全显 · 跑完主动问清空', async () => {
    /**
     * 🔴 #5b（Q16 拍定）：AI 补声明"没给出值"（`locusNoValue > 0`）→ **跑完自动弹**
     * 清空确认流（`runClearEmpty` 的既有序：预览 → 回收站 + 撤销条）——
     * 用户不用自己去找横幅上那枚「一键清空此类…」。
     * 夹具：两篇缺「文件位置」（AI 全不给值）+ 一篇空壳（唯一可清空的那一篇）。
     * 判据尾巴：**取消 = 一个都不删**（确认流是闸，自动弹不是自动删）。
     */
    await suite.it('#5b：AI 跑完"没给出值" → 自动弹清空确认流（预览点名空壳；取消不删）', async () => {
      mkNote('00_Inbox/__建议缺A.md', { 类型: '笔记' });
      mkNote('00_Inbox/__建议缺B.md', { 类型: '笔记' });
      mkNote('00_Inbox/__建议空壳.md', { 类型: '笔记' }, '## 关联笔记\n- 相关笔记：[[]]\n');
      const prevKey = ctx().settings.get().ai.apiKey;
      try {
        await H.configAi(plugin);
        H.resetAi();
        H.stubAi({ raw: JSON.stringify({ reply: '（用例）读不到有效正文', locus: [] }) });
        const h = openSuggestPanel(ctx(), { scope: '00_Inbox' });
        try {
          await untilEl(() => h.body.querySelector<HTMLElement>('.kbw-suggest-choice'), 4000);
          const optB = H.qa<HTMLElement>(h.body, '.kbw-suggest-opt').find((o) => o.dataset.cls === 'B');
          ok(optB, 'B 项在');
          H.click(optB as Element);
          await untilEl(
            () =>
              H
                .qa<HTMLElement>(h.body, '.kbw-suggest-row')
                .find((r) => H.textOf(r).includes('__建议缺A')) ?? null,
            4000,
          );
          // 点之前：只有面板这一枚模态（没有确认流）
          eq(H.qa<HTMLElement>(document.body, '.kbw-modal').length, 1, '起手只有面板这一枚模态');
          const aiBtn = H
            .qa<HTMLElement>(h.body, '.kbw-suggest-bar .kbw-btn')
            .find((b) => H.textOf(b).includes('AI 自动去做'));
          ok(aiBtn, '「AI 自动去做」在');
          H.click(aiBtn as Element);
          // AI 跑完 → 自动弹清空确认流
          const cfm = await untilEl(() => {
            const m = H
              .qa<HTMLElement>(document.body, '.kbw-modal')
              .find((x) => H.textOf(x).includes('清空这'));
            return m ?? null;
          }, 6000);
          ok(cfm, '清空确认流**自己弹出来了**（不用先去找横幅按钮）');
          contains(H.textOf(cfm!), '回收站', '去处明写 = 回收站');
          const prevText = H.textsOf(cfm!, '.kbw-plan-row').join(' || ');
          contains(prevText, '__建议空壳', `预览点名那几篇：${prevText}`);
          ok(!prevText.includes('__建议缺A'), '有正文的缺声明篇不在清空预览里（判定=剥前言+剥尾链后全空）');
          // #5a 的 DOM 结构判据：红字横幅给**全句**、按钮排在文本后
          const bad = H.q<HTMLElement>(h.body, '.kbw-suggest-note.is-bad');
          ok(bad, '红字横幅在（安全例外）');
          contains(H.textOf(bad), '读不到有效正文', '横幅给全句（截断是 CSS 的锅 —— 布局判据在 redline）');
          const kids = Array.from(bad.children).map((x) => x.tagName);
          eq(kids[kids.length - 1], 'BUTTON', '「一键清空此类…」排在文本**后**');
          // 取消：一个都不删
          H.keydown(document.body, 'Escape');
          await H.settle(250);
          ok(H.exists(vaultRoot, `${KB}/00_Inbox/__建议空壳.md`), '取消 → 空壳**一个都没删**');
        } finally {
          H.keydown(document.body, 'Escape');
          await H.settle(120);
          h.close('test');
          await H.settle(80);
        }
      } finally {
        closeAllMenus();
        H.keydown(document.body, 'Escape');
        await H.settle(120);
        H.resetAi();
        await H.configAi(plugin, { apiKey: prevKey });
        rm('00_Inbox/__建议缺A.md');
        rm('00_Inbox/__建议缺B.md');
        rm('00_Inbox/__建议空壳.md');
        __resetNotices();
        __resetUndo();
        await H.settle(150);
      }
    });
  });
}
