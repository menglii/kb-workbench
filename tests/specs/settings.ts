/**
 * spec：**插件设置的版本号 + 迁移**（17.1，P7.0b 建机制 · P7.1 第一条真规则）
 *
 * 判据三件套（P6② 定的模板，缺一不可）：
 *   ① **纯函数** —— `migrateSettings()` 逐种输入（本文件上半）
 *   ② **接线** —— 真的走 `SettingsStore.load()`（本文件下半）+ 落盘行为
 *   ③ **静态红线** —— `load()` 里那次调用必须存在（`tests/specs/redline.ts`）
 *
 * 🔴 **P7.1 起这里有真规则**：
 *   v1→v2（两档化）：① `notesView: 'compact'` → `'detail'`（删「名称+时间」档，等义改名）；
 *   ② `columnsHidden` 是数组时补 `prop:发布进度`（2.4 方案 B，进默认隐藏）。
 *   v2→v3（P7.2a）：③ 补 `prop:收藏`。v3→v4（P7.2c）：④ 补 `prop:来源`（剪藏的新属性）。
 *   ②③④ 三度同形（append、不重排、`null` 不写）。
 *   v4→v5（P7.5 · 8.1 体检）：⑤ **`ai.allowWrite` 退役** —— `true` 先映射成逐类
 *   等价设置（改属性/标签/新建/搬 → `'auto'`，已有显式档位的不覆盖）再删键；`false` 直删。
 *   v5→v6（P7.24 · T2）：⑥ **根进 `open`** —— `treeOpen` 数组补 `''`（根恒开的决策反转，
 *   把渲染特例物化成数据；与②③④三条「补进列」同形：append、缺键/坏形状不写）。
 *   都只在**读盘入口**跑、由版本号保证**幂等**（幂等 ≠ "再跑一遍结果一样"，
 *   而是"**对新版本的文件一个字节都不动**"—— 当前版的文件原样返回那条就是它）。
 *
 * ⚠️ 夹具是**手写的存量 data.json**（`bootPlugin` 的 `rawData` 选项）——
 * 不能借用 `seedDataJson` 那三种形态：它们都有"本轮之后"的键，
 * 而这一轮要验的恰恰是"**迁移前形态的存量文件**"。
 */
import fs from 'node:fs';
import { Suite, deepEq, eq, ok } from '../framework';
import * as H from '../helpers';
import { SETTINGS_VERSION, migrateSettings } from '../../src/core/settings';

export async function specSettings(suite: Suite): Promise<void> {
  await suite.group('17.1 插件设置版本号 + 迁移（P7.0b 建机制 · P7.1 第一条真规则）', async () => {
    await suite.it('纯函数：v0/v1 → 补版本 + 两条规则（compact→detail · 发布进度进列隐藏）；别的键一个不动；当前版幂等', () => {
      eq(SETTINGS_VERSION, 6, '当前版本号（改它就必须在 migrateSettings 里补一段迁移规则）');

      // null / 空对象：全新安装（或读盘失败）—— 给一个最小的当前版形状，补默认是 normalize 的事
      eq(
        (migrateSettings(null) as Record<string, unknown>).settingsVersion,
        SETTINGS_VERSION,
        'null（全新安装 / 读盘失败）→ 当前版本',
      );
      deepEq(migrateSettings({}), { settingsVersion: SETTINGS_VERSION }, '空对象同理');

      /**
       * v0 存量（连 `settingsVersion` 都没有）：各条规则照样生效（ver=0 < 3）——
       * 挑的这两个键**默认值都与它不同**
       *（`notesView` 默认 null、`showSettingHints` 默认 false）——
       * 迁移要是把 raw 换成了别的（比如只返回 `{settingsVersion}`），
       * 归一化之后它们会被默认值顶掉，这条当场红（"挑一个会被默认值顶掉的键"）。
       */
      const v0 = {
        notesView: 'compact',
        columnsHidden: ['prop:tags'],
        showSettingHints: true,
        未来才有的键: 42,
      };
      const out = migrateSettings(v0) as Record<string, unknown>;
      eq(out.settingsVersion, SETTINGS_VERSION, 'v0 → 当前版本');
      eq(out.notesView, 'detail', '🔴 规则①：compact（名称+时间档）→ detail（等义改名）');
      deepEq(
        out.columnsHidden,
        ['prop:tags', 'prop:发布进度', 'prop:收藏', 'prop:来源'],
        '🔴 规则②：动过列的用户，把「发布进度」补进隐藏清单（追加在末尾，别重排用户的选择）' +
          '；🔴 v2→v3 又补了「收藏」、v3→v4 又补了「来源」（一路迁到当前版）',
      );
      eq(out.showSettingHints, true, '别的键一个不动（被默认值顶掉就露馅）');
      eq(out['未来才有的键'], 42, '未知键保留（迁移不做清洗）');
      ok(out !== v0, 'v0 不原地改：返回新对象');

      // v1 存量（P7.0b 写的盘）：同两条规则；不涉及的值一个都不动
      const v1 = { settingsVersion: 1, notesView: 'grid', columnsHidden: null };
      const out1 = migrateSettings(v1) as Record<string, unknown>;
      eq(out1.notesView, 'grid', 'v1 的 grid 照旧（只有 compact 才改）');
      eq(out1.columnsHidden, null, 'columnsHidden 是 null（从没动过列）→ 不写任何东西，新默认渲染时自然生效');
      eq(out1.settingsVersion, 6, 'v1 → 当前版（v2/v3/v4/v5/v6 各段都逐级适用）');
      deepEq(
        migrateSettings({ settingsVersion: 1, notesView: null }),
        { settingsVersion: 6, notesView: null },
        'null（从没切过视图）原样保留 —— 它是"还没切过"的哨兵，动它等于抹掉用户的选择（B7）',
      );
      deepEq(
        (migrateSettings({ settingsVersion: 1, columnsHidden: ['prop:tags', 'prop:发布进度'] }) as Record<string, unknown>)
          .columnsHidden,
        ['prop:tags', 'prop:发布进度', 'prop:收藏', 'prop:来源'],
        '已经在隐藏清单里的不重复补（数组里只出现一次）；「收藏」「来源」照那两段补上',
      );

      // v2 存量（P7.1 写的盘）：v2→v3→v4 补「收藏」「来源」；不涉及的值一个都不动
      deepEq(
        (migrateSettings({ settingsVersion: 2, columnsHidden: ['prop:tags'] }) as Record<string, unknown>)
          .columnsHidden,
        ['prop:tags', 'prop:收藏', 'prop:来源'],
        '🔴 v2→v3→v4：动过列的用户，把「收藏」「来源」依次补进隐藏清单（append，不重排）',
      );
      deepEq(
        (migrateSettings({ settingsVersion: 2, columnsHidden: null }) as Record<string, unknown>)
          .columnsHidden,
        null,
        'columnsHidden 是 null（从没动过列）→ 不写任何东西，新默认渲染时自然生效',
      );

      // v3 存量（P7.2a 写的盘）：v3→v4 只补「来源」
      deepEq(
        (migrateSettings({ settingsVersion: 3, columnsHidden: ['prop:tags', 'prop:收藏'] }) as Record<string, unknown>)
          .columnsHidden,
        ['prop:tags', 'prop:收藏', 'prop:来源'],
        '🔴 v3→v4：动过列的用户，把「来源」补进隐藏清单（P7.2c 剪藏的新属性）',
      );

      /**
       * v4→v5（P7.5）:`ai.allowWrite` 退役。三种存量各判一条：
       * true（真点过旧开关）→ **先映射成逐类等价设置**再删键；false（默认被物化）→ 直删；
       * 以及"键本来就没有"→ 安全 no-op。**已有显式档位的类不许被映射覆盖**（逐类优先原样搬）。
       */
      const v4true = migrateSettings({
        settingsVersion: 4,
        ai: { baseUrl: 'https://x/v1', allowWrite: true, toolTiers: { move: 'off' } },
      }) as { ai: Record<string, unknown> };
      eq('allowWrite' in v4true.ai, false, '🔴 v4→v5：allowWrite 键删掉了（true）');
      deepEq(
        v4true.ai.toolTiers,
        // ⚠️ P7.22a：7 类了 —— 映射循环遍历 AI_TIER_CLASSES（含新类 text），
        // "旧 effectiveTier 对新类一律给 auto"是代码注释写明的设计意图（行为等价）→ 期望跟着加 text
        { move: 'off', prop: 'auto', tag: 'auto', create: 'auto', text: 'auto' },
        '🔴 true → 映射成逐类等价设置（改属性/标签/新建/搬=自动）；显式设过的 move:off 一个字不动',
      );
      eq(v4true.ai.baseUrl, 'https://x/v1', 'ai 里别的键照旧（只动该动的）');

      const v4false = migrateSettings({ settingsVersion: 4, ai: { baseUrl: 'https://x/v1', allowWrite: false } }) as {
        ai: Record<string, unknown>;
      };
      eq('allowWrite' in v4false.ai, false, '🔴 v4→v5：false（默认被物化）也删键');
      ok(!('toolTiers' in v4false.ai), 'false 不凭空长出 toolTiers —— 零行为变化');

      const v4bare = migrateSettings({ settingsVersion: 4, ai: { baseUrl: 'https://x/v1' } }) as {
        ai: Record<string, unknown>;
      };
      ok(!('allowWrite' in v4bare.ai) && !('toolTiers' in v4bare.ai), '没写过该键的：安全 no-op');

      /**
       * 🔴 **手改塞的野值不算"设过"**（独立审 2026-10-04 🔴）：`toolTiers.move: "unknown"`
       * 会被 `normalizeSettings` 丢弃 —— 迁移若只判"键在不在"，野值顶掉映射后又被丢，
       * 该类就从旧口径的「自动」**静默落回**「需确认」，违反"行为等价"承诺。合法三档值才算设过。
       */
      const v4junk = migrateSettings({
        settingsVersion: 4,
        ai: { baseUrl: 'https://x/v1', allowWrite: true, toolTiers: { move: 'unknown' } },
      }) as { ai: Record<string, unknown> };
      deepEq(
        v4junk.ai.toolTiers,
        { move: 'auto', prop: 'auto', tag: 'auto', create: 'auto', text: 'auto' }, // P7.22a：7 类（同上条注释）
        '🔴 野值（"unknown"）不算"设过" —— 映射要把它盖成 auto',
      );

      // 当前版：**原样返回**（同一引用）—— "再 load 一次一个字节都不该变"靠的就是这一条
      const v6 = { settingsVersion: 6, notesView: 'grid', showSettingHints: false };
      ok(migrateSettings(v6) === v6, 'v6 输入原样返回（同一引用，连 key 顺序都不动）');
      deepEq(
        migrateSettings({ settingsVersion: 4, notesView: 'grid', showSettingHints: false }),
        { settingsVersion: 6, notesView: 'grid', showSettingHints: false },
        'v4（无 ai 段）→ 当前版：只升版本号，别的键一个不动（v5→v6 的 treeOpen 规则对缺键文件不写）',
      );
      /**
       * v5→v6（P7.24 · T2）：**根进 `open`** —— `treeOpen` 数组补 `''`（'' = 库根；
       * 迁移前"根恒开"是渲染特例、从不落盘，补上它把那份恒开**物化**成数据、
       * 用户可见行为零变化）。与上面三条「补进列」同形：只 append、缺键/坏形状不写。
       */
      deepEq(
        (migrateSettings({ settingsVersion: 5, treeOpen: ['05_操作日志'] }) as Record<string, unknown>)
          .treeOpen,
        ['05_操作日志', ''],
        "🔴 v5→v6：存量 treeOpen 补 ''（append，别重排用户的展开记忆）",
      );
      deepEq(
        (migrateSettings({ settingsVersion: 5, treeOpen: [] }) as Record<string, unknown>).treeOpen,
        [''],
        "🔴 v5→v6：空数组也补（旧口径下根就是恒开的）",
      );
      ok(
        !('treeOpen' in (migrateSettings({ settingsVersion: 5 }) as Record<string, unknown>)),
        'treeOpen 缺失 → 不写（默认/规范化顶）',
      );
      deepEq(migrateSettings(migrateSettings(v0)), migrateSettings(v0), '迁移幂等（再迁一次不变）');

      // 装过新版又回退的机器：文件里的版本号比当前代码**高** —— 只升不降，别把它拉低
      eq(
        (migrateSettings({ settingsVersion: 9 }) as Record<string, unknown>).settingsVersion,
        9,
        '版本号只升不降（回退插件版本不该把存量文件的版本拉低）',
      );
    });

    await suite.it('接线：v1 存量 data.json（notesView 停在 compact）走 load() → 内存里 detail + 当前版本', async () => {
      const vault = H.makeTempVault('settings');
      const b = await H.bootPlugin(vault, {
        rawData: {
          // ⚠️ 存量形态：**有 settingsVersion: 1**（P7.0b 写的盘）、视图停在已删的紧凑档
          wizardDone: true,
          settingsVersion: 1,
          notesView: 'compact',
          columnsHidden: ['prop:tags'],
          showSettingHints: true,
          kbRoot: '01_新知识库',
          // P7.5：旧开关点过（true）—— 迁移该把它映射成逐类再删键
          ai: { baseUrl: 'https://x/v1', apiKey: 'k', allowWrite: true },
        },
      });
      const s = b.plugin.context().settings.get();
      eq(s.settingsVersion, SETTINGS_VERSION, '🔴 读盘时迁移过（v1 → 当前版）—— 没迁的话这里是 1');
      eq(s.notesView, 'detail', '🔴 存量 compact 迁成 detail（读盘入口做的）');
      ok(
        (s.columnsHidden ?? []).includes('prop:发布进度'),
        `🔴 「发布进度」补进了隐藏清单（实际 ${JSON.stringify(s.columnsHidden)}）`,
      );
      ok((s.columnsHidden ?? []).includes('prop:tags'), '用户原来的选择照旧在');
      eq(s.showSettingHints, true, '别的键照旧（迁移没把 raw 换掉）');
      /**
       * 🔴 **P7.5 的 v4→v5 也走这条路**：`allowWrite: true` 的存量经读盘迁移后
       * 「键没了 + 改属性/标签/新建/搬 变自动」—— 两条成对判（只判"键没了"的话，
       * 一删了之也绿，而那正是这段迁移不许犯的错：权限静默变动）。
       */
      const aiMem = s.ai as unknown as Record<string, unknown>;
      ok(!('allowWrite' in aiMem), '🔴 读盘时 allowWrite 键被删（迁移真的挂着）');
      const tiersMem = (aiMem.toolTiers ?? {}) as Record<string, string>;
      eq(tiersMem.prop, 'auto', '🔴 true 映射成逐类等价设置（改属性=自动）');
      eq(tiersMem.move, 'auto', '搬=自动');
      eq(tiersMem.delete, undefined, '删不在映射里（旧口径下它本来就保持需确认）');
      eq(b.plugin.context().settings.kbRoot(), '01_新知识库', '派生出来的路径也照常');
      await H.shutdown(b.plugin);
    });

    await suite.it('落盘：迁移**自己不写盘**；下一次 save 落当前版；当前版文件再 load+save 一个字节不变', async () => {
      const vault = H.makeTempVault('settings');
      const b = await H.bootPlugin(vault, {
        rawData: { wizardDone: true, settingsVersion: 1, notesView: 'compact' },
      });
      const disk0 = JSON.parse(fs.readFileSync(H.dataJsonPath(vault), 'utf8')) as Record<string, unknown>;
      eq(disk0.settingsVersion, 1, '前提：盘上这份是**迁移前**形态（load 不会顺手改写它）');
      eq(disk0.notesView, 'compact', '前提：盘上的 compact 还在（迁移只改内存）');

      // 任意一次 save（用户点一下什么都会触发）—— 这时才把迁移结果带上盘
      await b.plugin.context().settings.save({ activeModule: 'notes' });
      const disk1 = fs.readFileSync(H.dataJsonPath(vault), 'utf8');
      const parsed1 = JSON.parse(disk1) as Record<string, unknown>;
      eq(parsed1.settingsVersion, SETTINGS_VERSION, '保存一次之后盘上是当前版本');
      eq(parsed1.notesView, 'detail', '迁移结果（compact → detail）跟着那次 save 一起落盘');

      // 当前版的文件再走一遍 load + save：**一个字节都不该变**（幂等，连 key 顺序都算）
      await b.plugin.context().settings.load();
      await b.plugin.context().settings.save({});
      eq(fs.readFileSync(H.dataJsonPath(vault), 'utf8'), disk1, '当前版文件再 load+save：字节级相同（幂等）');
      await H.shutdown(b.plugin);
    });
  });
}
