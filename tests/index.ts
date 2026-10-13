/**
 * tests/index.ts —— 测试入口（由 `scripts/test.mjs` 打包后在 jsdom 全局里执行）
 *
 * 四个库分开跑，互不污染：
 *   A 真数据库  —— 夹具库 43 篇的副本（骨架 / 索引 / 菜单 / 通知）
 *   B 动库库    —— 会真的搬文件（mover / snapshot / 还原）
 *   C 夹具库    —— 自己造文件，逐个验健康标记判得对
 *   D 迁移库    —— 属性迁移（跑完属性就变了，所以单独一份、而且必须是"迁移前"的）
 *
 * ⚠️ 数据源是**合成夹具**（`tests/fixture/` 现造、开跑前 `ensureFixtures()` 重建，见 `helpers.ts`），
 *    **不是活的实验库** —— 活库会被探针/迁移改掉，拿它当夹具会让用例整片假红（P2 实测过一次）。
 *    只有 **D 迁移库**例外：它显式传 `PRE_MIGRATION_KB`（合成 pre）。本机调试可用
 *    `KBW_FIXTURE_KB` / `KBW_BACKUP_KB` 指回真备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Suite } from './framework';
import * as H from './helpers';
import { SHARD_K, SHARD_N, SHARD_ON, makeGate } from './shards';
import { ensureFixtures } from './fixture/build';
import { specMount } from './specs/mount';
import { specVaultIndex } from './specs/vault-index';
import { specFlags } from './specs/flags';
import { specConfigs } from './specs/configs';
import { specRedline } from './specs/redline';
import { specMover } from './specs/mover';
import { specMenu } from './specs/menu';
import { specNotify } from './specs/notify';
import { specHarness } from './specs/harness';
import { specNotes } from './specs/notes';
import { specPanels } from './specs/panels';
import { specMigrate } from './specs/migrate';
import { specAutomation } from './specs/automation';
import { specBoard } from './specs/board';
import { specE } from './specs/e';
import { specE2 } from './specs/e2';
import { specF } from './specs/f';
import { specRebuild } from './specs/rebuild';
import { specTidy } from './specs/tidy';
import { specGrid } from './specs/grid';
import { specGraph } from './specs/graph';
import { specP6d } from './specs/p6d';
import { specAi } from './specs/ai';
import { specP73a } from './specs/p73a';
import { specP73c } from './specs/p73c';
import { specWizard } from './specs/wizard';
import { specWholeVault } from './specs/whole-vault';
import { specP72b } from './specs/p72b';
import { specSuggest } from './specs/suggest';
import { specP72c } from './specs/p72c';
import { specSettings } from './specs/settings';
import { specFramework } from './specs/framework';
import { specP71c } from './specs/p71c';
import { specP72a } from './specs/p72a';
import { specP72d } from './specs/p72d';
import { specP75 } from './specs/p75';
import { specP77 } from './specs/p77';
import { specP78 } from './specs/p78';
import { specP79 } from './specs/p79';
import { specP710 } from './specs/p710';
import { specP711 } from './specs/p711';
import { specP713b } from './specs/p713b';
import { specP715 } from './specs/p715';
import { specP716 } from './specs/p716';
import { specP716b } from './specs/p716b';
import { specP717 } from './specs/p717';
import { specP718 } from './specs/p718';
import { specP718b } from './specs/p718b';
import { specP719 } from './specs/p719';
import { specP721 } from './specs/p721';
import { specP721b } from './specs/p721b';
import { specP722a } from './specs/p722a';
import { specP722b } from './specs/p722b';
import { specP723 } from './specs/p723';
import { specP724 } from './specs/p724';
import { specStubContract } from './specs/stub-contract';
import { specReview } from './specs/review';
import { specKeySafety } from './specs/key-safety';

/**
 * 返回**退出码**：0 = 全部通过 · 1 = 有失败 · 2 = 只跑了子集（`KBW_TEST_ONLY`）
 * ⚠️ 2 是必须的：只跑一条也算"通过"的话，收尾时极易自欺（独立审查指出）
 */
export async function run(): Promise<number> {
  const suite = new Suite();
  const t0 = Date.now();
  /**
   * ── 分片闸门（P7.20-1）────────────────────────────────────────
   * 每块最外层包一句 `if (G.want('<块名>')) {` —— 调用顺序即块顺序，按 `seq % N === K` 轮转。
   * ⚠️ **每一个块都必须调一次**：漏一个块，后面全部错位（会出现"某块被两片都跑/都不跑"）。
   * ⚠️ 不分片（默认）时 `want()` 恒 true，行为与从前**逐字一致**。
   */
  const G = makeGate();
  // 卡住时 runner 靠它报"跑到哪一条了"；**也是看门狗的心跳载体**（见 tests/heartbeat.ts）
  (globalThis as unknown as { __kbwSuite?: Suite }).__kbwSuite = suite;
  // ⚠️ 顺序：**先建 Suite 再重建夹具** —— 否则 `ensureFixtures()` 那几十毫秒里没有 `__kbwSuite`，
  //    心跳敲空，看门狗口径就少了一截（P7.19）。
  ensureFixtures();
  console.log('经纬 · P0 离线验收\n');

  // ── S：桩-真机**行为契约**（P7.20 · #10）────────────────────
  // ⚠️ 这一块**不 boot 插件**：测的是桩自己（`tests/stub/`），`plugin` 是无关变量。
  //    放最前面还有一个好处 —— 桩要是哪天漂了，**先在这里红**，而不是让后面一千多条
  //    用例各自以奇怪的方式失败（"桩变了"这种根因最难认，得让它第一个冒头）。
  if (G.want('stub')) {
  await specStubContract(suite, path.join(H.tmpRoot(), 'stub-contract'));
  }

  // ── A：真数据库（只读 + 骨架） ────────────────────────────────
  if (G.want('A:real')) {
  const vaultA = H.makeTempVault('real');
  const a = await H.bootPlugin(vaultA);
  H.resetDom();
  await specRedline(suite);   // 纯函数判据，不需要库
  await specMount(suite, a.app, a.plugin, vaultA);
  // P7.7b：动效系统的 JS 侧（浮层闪一下的 reduce 分支 / data-motion 镜像）—— 纯 DOM，不需要动库
  await specP77(suite, a.app, a.plugin);
  await specVaultIndex(suite, a.app, a.plugin, vaultA);
  await specConfigs(suite, a.app, a.plugin, vaultA);
  await specMenu(suite, a.app, a.plugin, vaultA);
  await specNotify(suite, a.app, a.plugin, vaultA);
  await specHarness(suite, a.app, a.plugin, vaultA);
  // P6：图谱（只挂载 + 注入，不写库 → 放只读库 A 就行）
  await specGraph(suite, a.app, a.plugin, vaultA);
  /**
   * P7.10 · #8 首入讲解浮层：只挂模块 + 写插件 data.json（`notesIntroSeen`），
   * 不动库内文件 —— 跟只读库 A（每条自己把旗标演成未看过再复位 true）。
   */
  await specP710(suite, a.app, a.plugin);
  /**
   * P8 收尾 · C7：key 与「这个库在同步」（纯函数 / 探测 / 接线）。
   * 它**自己起库**（`makeTempVault('keysafety*')` 各一条）—— A 只借它一个挂载点，
   * 不碰 A 的夹具（其中"接线"两条要真 boot 带痕迹的库 + 真配 key）。
   */
  await specKeySafety(suite, a.app, a.plugin, vaultA);
  await H.shutdown(a.plugin);
  }

  // ── B：动库库（真的搬文件） ──────────────────────────────────
  if (G.want('B:move')) {
  H.resetDom();
  const vaultB = H.makeTempVault('move');
  const b = await H.bootPlugin(vaultB);
  await specMover(suite, b.app, b.plugin, vaultB);
  await specNotes(suite, b.app, b.plugin, vaultB);
  // P6：网格档（会把格子拖到目录树上真搬文件 → 必须与 B 同库）
  await specGrid(suite, b.app, b.plugin, vaultB);
  await specPanels(suite, b.app, b.plugin, vaultB);
  // P3：自动化（新建补全 / 自动归位 / 目录映射 / 存量补全）—— 也要真写盘，跟 B 用同一个库
  await specAutomation(suite, b.app, b.plugin, vaultB);
  // P4：看板（板块取数 / 卡片 / 悬浮小窗 / 勾选框 / 跨板块拖动）—— 也要真搬文件，跟 B 同库
  await specBoard(suite, b.app, b.plugin, vaultB);
  // P4.5 e 期：分屏 / 预览窗格 Peek / 视图记忆 —— 要真写库内配置、真切模块，跟 B 同库
  await specE(suite, b.app, b.plugin, vaultB);
  // P4.5 e2：用户真机报的两条 bug（勾选框对齐 / 重绘保住滚动）—— 与 B 同库
  await specE2(suite, b.app, b.plugin, vaultB);
  await specF(suite, b.app, b.plugin, vaultB);
  // P5 重排：会真建目录、真搬文件（跑完自己还原 + 清场），与 B 同库
  await specRebuild(suite, b.app, b.plugin, vaultB);
  // P6 段② A2：一键自动整理收件箱（真搬 + 快照还原，跑完自己清场）—— 放最后，别搅前面前提
  await specTidy(suite, b.app, b.plugin, vaultB);
  // P6 段⑥：列头槽 / 双击升格 / editor-menu（会真搬一篇做归位，跑完自己撤销 + 清场）—— 也放最后
  await specP6d(suite, b.app, b.plugin, vaultB);
  /**
   * P6 段④ AI 助手：会**真搬文件**（走确认流 → mover → 撤销条），所以跟 B 同库。
   * ⚠️ 它自己造夹具（`__探针AI*`）并在每条用例里清场 —— 不拿真库那 43 篇当"待搬的"
   *（它们的形状是别的用例的前提，动一篇就会连锁假红）。
   * ⚠️ **离线绝不联网**：模型那一层在用例里换成假传输层（桩的 `requestUrl` 默认抛）。
   */
  await specAi(suite, b.app, b.plugin, vaultB);
  /**
   * P7.3a AI v2：传输层（注入假 fetch）+ 会话存储 + fragile 守卫 —— 要真写插件目录（会话文件），
   * 跟 B 同库（B 是"动库库"，插件目录本来就有快照在写）。
   */
  await specP73a(suite, b.app, b.plugin, vaultB);
  /**
   * P7.3c 集成与交付：skill 机制（真造库内技能文件）/ 执行体白名单（会真搬一篇的**负向**用例）/
   * 成本可见 / 测试连接 / 设置面板（权限 · 会话 · 参数）/ 两个「问 AI」入口。
   * 与 B 同库（会话文件写在插件目录、能力包文件写在库内 `06_工作台/skills/`，每条自己清场）。
   */
  await specP73c(suite, b.app, b.plugin, vaultB);
  /**
   * P7.1c 网格六件 + 列宽自适应 + 2.7：拖 / 删会真动文件，与 B 同库；
   * 排在收尾（它的自造夹具全带 `__小修` 前缀、每条 finally 清场 —— 与 P6d/tidy 同一条纪律）。
   */
  await specP71c(suite, b.app, b.plugin, vaultB);
  /**
   * P7.2a 首页区块（§1.2）：会造 `__探针收藏*` 临时文件再删（收藏标记走 `fm.setMany`），与 B 同库；
   * 它改的主要是**插件 data.json 的 `homeBlocks`**（每条用例收尾复位 `null`），不碰库内配置。
   */
  await specP72a(suite, b.app, b.plugin, vaultB);
  await H.shutdown(b.plugin);
  }

  // ── C：夹具库（确定性健康标记） ──────────────────────────────
  if (G.want('C:fixtures')) {
  H.resetDom();
  const vaultC = H.makeTempVault('fixtures');
  const c = await H.bootPlugin(vaultC);
  await specFlags(suite, c.app, c.plugin, vaultC);
  await H.shutdown(c.plugin);
  }

  // ── D：属性迁移（**唯一还吃"迁移前"数据的库**）────────────────
  // ⚠️ 不能用实验库本体、也不能用 P3 基线 —— 迁移跑过一次之后，
  //    那份数据就"没有旧规范可迁"了，这一组会变成空跑。
  //    夹具 = `.tooling/backup/属性统一-<日期>/`（§7 step 1 的备份，显式传）
  if (G.want('D:migrate')) {
  H.resetDom();
  const vaultD = H.makeTempVault('migrate', H.PRE_MIGRATION_KB);
  const d = await H.bootPlugin(vaultD);
  await specMigrate(suite, d.app, d.plugin, vaultD);
  await H.shutdown(d.plugin);
  }

  // ── E：首次使用向导（**每条形态各起一个自己的实例**）────────────
  /**
   * 为什么单独一组：向导"弹不弹"是 `onload → activate` **那一刻**的属性，
   * 靠改设置改不出来 —— 每种 `data.json` 形态都得自己起一次。
   * 它自己也造库（`makeTempVault('wizard-*')`），不碰上面任何一组的夹具。
   */
  if (G.want('E:wizard')) {
  H.resetDom();
  await specWizard(suite);
  }

  // ── E′：P7.14 整个库模式（kbRoot=''）—— 自己的库，纯数据面 ─────
  if (G.want('Eprime:whole')) {
  H.resetDom();
  await specWholeVault(suite);
  }

  // ── E2：P7.2b 向导与内容（教程中心 / 「?」两处 / 命名模板 / M4 池）────
  /**
   * 自己的库（`makeTempVault('p72b')`）：几条用例会真落一篇教程笔记（在 temp 里，
   * 不用清）+ 会切 `activeModule`/改 `namingTemplate`（每条自己拨回）。
   * 不碰上面任何一组的夹具。
   */
  if (G.want('E2:p72b')) {
  H.resetDom();
  const vaultP72b = H.makeTempVault('p72b');
  const e2b = await H.bootPlugin(vaultP72b);
  await specP72b(suite, e2b.app, e2b.plugin, vaultP72b);
  await H.shutdown(e2b.plugin);
  }

  // ── E3：P7.2c 全局手感（快捕改版/剪藏 · 菜单收起 · 小窗三件）────
  /**
   * 自己的库（`makeTempVault('p72c')`）：会真落/真搬/真删夹具（全带 `__` 前缀、
   * 每条自己收），`requestUrl` 一律注入假响应（桩默认"没注入就抛"）。
   * 不碰上面任何一组的夹具。
   */
  if (G.want('E3:p72c')) {
  H.resetDom();
  const vaultP72c = H.makeTempVault('p72c');
  const e2c = await H.bootPlugin(vaultP72c);
  await specP72c(suite, e2c.app, e2c.plugin, vaultP72c);
  await H.shutdown(e2c.plugin);
  }

  // ── E4：P7.2d 首页卡片批（16.9 图谱卡/钉住的笔记/最近改动桥 ＋ 16.13 新手清单）──
  /**
   * 自己的库（`makeTempVault('p72d')`）：会真落/真改名/真删夹具（全带 `__` 前缀、
   * 每条自己收）；会开**真卡片窗**（挂真编辑器叶）—— 收尾判据就是"叶全 detach"。
   * `homeCards` / `onboarding` / 看板开关 / 图谱核心开关是共享设置，用例各自拨回。
   */
  if (G.want('E4:p72d')) {
  H.resetDom();
  const vaultP72d = H.makeTempVault('p72d');
  const e2d = await H.bootPlugin(vaultP72d);
  await specP72d(suite, e2d.app, e2d.plugin, vaultP72d);
  await H.shutdown(e2d.plugin);
  }

  // ── F：插件设置的版本号与迁移（17.1，P7.0b）────────────────────
  /**
   * 同一条理由：要验的是"**读盘那一刻**有没有迁移"（一份手写的存量 `data.json`），
   * 自己起实例、自己造库（`makeTempVault('settings')`），不碰上面任何一组的夹具。
   */
  if (G.want('F:settings')) {
  H.resetDom();
  await specSettings(suite);
  }

  // ── G：P7.2b 库框架轮（16.1 预设 / 初始化 / 收拢 ＋ 16.2 示例数据）──
  /**
   * 自己的库（`makeTempVault('kbfw')`）：收拢会搬走整库文件、初始化要"空库"
   * （用例在库内另建空目录当 kbRoot）—— 都只在 temp 里造，每条自己收场。
   */
  if (G.want('G:kbfw')) {
  H.resetDom();
  const vaultFw = H.makeTempVault('kbfw');
  const fw = await H.bootPlugin(vaultFw);
  await specFramework(suite, fw.app, fw.plugin, vaultFw);
  await H.shutdown(fw.plugin);
  }

  // ── H：P7.5 设置体检轮（8.1 文案体检 / 8.3 拆类名 / 顺手件）──────────
  /**
   * 自己的库（`makeTempVault('p75')`）：要真开设置面板渲染七栏（各栏读库内配置）；
   * 「问 AI」那条把 `ctx.ai.ask` 换成假实现（**绝不联网**）并临时塞假 key（用例自己拨回）。
   * ⚠️ 夹具里**没有** `06_工作台/看板配置.json` —— M1 判据要的正是"未物化"现场。
   */
  if (G.want('H:p75')) {
  H.resetDom();
  const vaultP75 = H.makeTempVault('p75');
  const e75 = await H.bootPlugin(vaultP75);
  await specP75(suite, e75.app, e75.plugin, vaultP75);
  await H.shutdown(e75.plugin);
  }

  // ── I：P7.6 整理建议（11.1 建议流水线 / 16.4 库维护 / 并族）────
  /**
   * 自己的库（`makeTempVault('p76')`）：面板真链路要**真搬文件 + 真撤销**，
   * MOC 那条要真写《知识地图》页 —— 都只在 temp 里造，跑完不影响别的 spec。
   */
  if (G.want('I:p76')) {
  H.resetDom();
  const vaultSg = H.makeTempVault('p76');
  const sg = await H.bootPlugin(vaultSg);
  await specSuggest(suite, sg.app, sg.plugin, vaultSg);
  await H.shutdown(sg.plugin);
  }

  // ── J：P7.8 待处理 AI 一键（1.5）─────────────────────────────
  /**
   * 自己的库（`makeTempVault('p78')`）：全流程要**真改名 + 真撤销**（自造 `未命名 8.md`
   * 夹具、每条自己收场）；AI 一律假传输层（绝不联网）。
   */
  if (G.want('J:p78')) {
  H.resetDom();
  const vaultP78 = H.makeTempVault('p78');
  const e78 = await H.bootPlugin(vaultP78);
  await specP78(suite, e78.app, e78.plugin, vaultP78);
  await H.shutdown(e78.plugin);
  }

  // ── K：P7.9 用户反馈批（手感件 ③/④/⑤/⑥/② 的回归判据）────────
  /**
   * 自己的库（`makeTempVault('p79')`）：⑤ 一键整理会**真搬 + 补声明**（自造 `__p79*`
   * 夹具、每条自己收场）；② 会真落一个 `T_p79新模板.md`（finally 里删）。
   */
  if (G.want('K:p79')) {
  H.resetDom();
  const vaultP79 = H.makeTempVault('p79');
  const e79 = await H.bootPlugin(vaultP79);
  await specP79(suite, e79.app, e79.plugin, vaultP79);
  await H.shutdown(e79.plugin);
  }

  // ── L：P7.11 反馈批 3（整改轮）的增量判据 ───────────────────
  /**
   * 自己的库（`makeTempVault('p711')`）：#4 菜单/#8 重载/#9 分流/#10 fold/#13 通知都是
   * 真链路（受控子目录里造 `__p711*` 夹具、每条自己收）；#12 B 类会**真写前言 + 真撤销**。
   * AI 一律假传输层（绝不联网）。
   */
  if (G.want('L:p711')) {
  H.resetDom();
  const vaultP711 = H.makeTempVault('p711');
  const e711 = await H.bootPlugin(vaultP711);
  await specP711(suite, e711.app, e711.plugin, vaultP711);
  await H.shutdown(e711.plugin);
  }

  // ── M：P7.13b 反馈批 5（二）待处理右键两改 + 三类自动化（E1/E2/E3）────
  /**
   * 自己的库（`makeTempVault('p713b')`）：①/② 全流程都是真链路（真搬 / 真删 / 真改名 /
   * 真改链 + 真撤销），自造 `__p713b*` 夹具、每条自己收场（E2 还会连库里那组现成重复一起清、
   * 收尾兜底还原内容）；AI 一律假传输层（绝不联网）。
   */
  if (G.want('M:p713b')) {
  H.resetDom();
  const vaultP713b = H.makeTempVault('p713b');
  const e713b = await H.bootPlugin(vaultP713b);
  await specP713b(suite, e713b.app, e713b.plugin, vaultP713b);
  await H.shutdown(e713b.plugin);
  }

  // ── N：P7.15 反馈批 6（文件位置一族 + 空文件夹进树）────────────
  /**
   * 自己的库（`makeTempVault('p715')`）：建空目录 / 拖进空目录 / 顶层新建都是真链路，
   * 自造 `__p715*` 夹具、每条自己收场（`metadataCache.settle()` 那套安全删法）。
   */
  if (G.want('N:p715')) {
  H.resetDom();
  const vaultP715 = H.makeTempVault('p715');
  const e715 = await H.bootPlugin(vaultP715);
  await specP715(suite, e715.app, e715.plugin, vaultP715);
  await H.shutdown(e715.plugin);
  }

  // ── O：P7.16 YAML 专项一（属性块脏检查重画 · 选择器两修 · 坏前言一族）────
  /**
   * 自己的库（`makeTempVault('p716')`）：坏前言夹具是**手写裸文本**（H.note 序列化
   * 不出来），属性块刷新要真建目录 / 真外部写盘 / 真开卡片窗，修前言要走真快照与撤销
   * —— 每条自己收场（`metadataCache.settle()` 那套安全删法）。
   * AI 一律假传输层（绝不联网）。
   */
  if (G.want('O:p716')) {
  H.resetDom();
  const vaultP716 = H.makeTempVault('p716');
  const e716 = await H.bootPlugin(vaultP716);
  await specP716(suite, e716.app, e716.plugin, vaultP716);
  await H.shutdown(e716.plugin);
  }

  // ── P：P7.16b YAML 专项一补（原生面板那一格 · 补声明 · 小窗改名刷新）────
  /**
   * 自己的库（`makeTempVault('p716b')`）：原生面板那一格是**假平台 DOM**（照真机活体
   * 形状造）+ 真搬真撤销；小窗两条也是真链路 —— 每条自己收场（安全删法同 p716）。
   */
  if (G.want('P:p716b')) {
  H.resetDom();
  const vaultP716b = H.makeTempVault('p716b');
  const e716b = await H.bootPlugin(vaultP716b);
  await specP716b(suite, e716b.app, e716b.plugin, vaultP716b);
  await H.shutdown(e716b.plugin);
  }

  // ── Q：P7.17 YAML 专项二（有前言补缺键 · D1 · 分档 · 覆盖 · 入口两处）────
  /**
   * 自己的库（`makeTempVault('p717')`）：缺键/坏前言夹具是**手写裸文本**（`H.note`
   * 序列化不出来）—— 补全与覆盖都是真写盘、真快照、真撤销；向导卡与设置提示是
   * 真演练（会拨模块开关，用例自己拨回）—— 每条自己收场（`metadataCache.settle()` 那套）。
   */
  if (G.want('Q:p717')) {
  H.resetDom();
  const vaultP717 = H.makeTempVault('p717');
  const e717 = await H.bootPlugin(vaultP717);
  await specP717(suite, e717.app, e717.plugin, vaultP717);
  await H.shutdown(e717.plugin);
  }

  // ── R：P7.18 YAML 专项三（退出清理：逐键删 · 足迹清 · 幂等 · 入口）────
  /**
   * 自己的库（`makeTempVault('p718')`）：六件齐 / 坏前言夹具是**手写裸文本**
   *（`H.note` 序列化不出来）；删键与清足迹都是**真写盘、真快照、真撤销**；
   * 足迹类用例自备小库根（拨回 + 删净）——不动合成夹具的 `99_Meta`。
   */
  if (G.want('R:p718')) {
  H.resetDom();
  const vaultP718 = H.makeTempVault('p718');
  const e718 = await H.bootPlugin(vaultP718);
  await specP718(suite, e718.app, e718.plugin, vaultP718);
  await H.shutdown(e718.plugin);
  }

  // ── S：P7.18b 位置口径轮（拖拽补声明 · 菜单「现处 X」写回；用户 2026-10-09 反馈）────
  if (G.want('S:p718b')) {
  H.resetDom();
  const vaultP718b = H.makeTempVault('p718b');
  const e718b = await H.bootPlugin(vaultP718b);
  await specP718b(suite, e718b.app, e718b.plugin, vaultP718b);
  await H.shutdown(e718b.plugin);
  }

  // ── T：P7.19 流水线硬化（二次 restore / 撤销条离场守卫 · B1 转正）────
  /**
   * 自己的库（`makeTempVault('p719')`）：要真拍快照 / 真删快照 / 真还原（读盘 + 写盘），
   * 自造 `__p719*` 夹具、每条自己收场。**不跑真搬**（要的是"撤销条 × 快照"那条缝，
   * 不是 mover 本身 —— mover 那些口径在 B 组与 p713b 里）。
   */
  if (G.want('T:p719')) {
  H.resetDom();
  const vaultP719 = H.makeTempVault('p719');
  const e719 = await H.bootPlugin(vaultP719);
  await specP719(suite, e719.app, e719.plugin, vaultP719);
  await H.shutdown(e719.plugin);
  }

  // ── U：P7.21 AI 地基（任务注册表 / 只读工具 / ask_user / 检索 / 触发词 / 工坊）────
  /**
   * 自己的库（`makeTempVault('p721')`）：注册表判据要往库里造 `__p721*` 夹具、
   * 配假传输层（`H.configAi` + `H.stubAi`）—— 与别的 AI spec 隔开，互不踩。
   */
  if (G.want('U:p721')) {
  H.resetDom();
  const vaultP721 = H.makeTempVault('p721');
  const e721 = await H.bootPlugin(vaultP721);
  await specP721(suite, e721.app, e721.plugin, vaultP721);
  await H.shutdown(e721.plugin);
  }

  // ── U2：P7.21b AI 地基段二（正文检索 / skill 扩展与触发词 / 技能工坊）────
  /**
   * 自己的库（`makeTempVault('p721b')`）：grep 要真扫盘、面板用例要真敲输入框 /
   * 真开 `/` 菜单、工坊要真写盘 —— 与 p721 那套互不踩。
   */
  if (G.want('U:p721b')) {
  H.resetDom();
  const vaultP721b = H.makeTempVault('p721b');
  const e721b = await H.bootPlugin(vaultP721b);
  await specP721b(suite, e721b.app, e721b.plugin, vaultP721b);
  await H.shutdown(e721b.plugin);
  }

  // ── U3：P7.22a 写面扩容（正文编辑 / rename / 上限与继续 / 属性补快照 / 全权预设）──
  /**
   * 自己的库（`makeTempVault('p722a')`）：正文写要真写盘 + 真快照还原、rename 要
   * 真走 mover、「继续」要真开面板跑 6 步 —— 与 p721b 那套互不踩。
   */
  if (G.want('U:p722a')) {
  H.resetDom();
  const vaultP722a = H.makeTempVault('p722a');
  const e722a = await H.bootPlugin(vaultP722a);
  await specP722a(suite, e722a.app, e722a.plugin, vaultP722a);
  await H.shutdown(e722a.plugin);
  }

  // ── U4：P7.22b 段二（服务族 / 提示词附加层 / Anthropic 传输 / 任务级模型）──
  /**
   * 自己的库（`makeTempVault('p722b')`）：服务族要真开面板（suggest / triage / cleanup）、
   * 提示词附加层要真写库内文件（`06_工作台/AI提示词/`）、传输判据全走注入的假实现
   * （假 requestUrl / 假 fetch）—— 与 p722a 那套互不踩。
   */
  if (G.want('U:p722b')) {
  H.resetDom();
  const vaultP722b = H.makeTempVault('p722b');
  const e722b = await H.bootPlugin(vaultP722b);
  await specP722b(suite, e722b.app, e722b.plugin, vaultP722b);
  await H.shutdown(e722b.plugin);
  }

  // ── V：P7.23 反馈批 7（勾选框互踩 · 拖拽跟手 · 树菜单与文件行 · 批量栏两件）────
  /**
   * 自己的库（`makeTempVault('p723')`）：树菜单要真建目录、文件行拖动要真搬（mover + 撤销条）；
   * 「打开所选」真开叶（收尾自己 detach）；AI 一律假传输层（绝不联网）。
   */
  if (G.want('V:p723')) {
  H.resetDom();
  const vaultP723 = H.makeTempVault('p723');
  const e723 = await H.bootPlugin(vaultP723);
  await specP723(suite, e723.app, e723.plugin, vaultP723);
  await H.shutdown(e723.plugin);
  }

  // ── W：P7.24 树收口三件（T1 收起钮 · T2 根可收/迁移 · T3 全部收起 · A22 文件行右键）────
  /**
   * 自己的库（`makeTempVault('p724')`）：T1/T3 要真建目录链 + 完全展开（文件行）；
   * T2 的"切模块往返"走导航项真路径。
   */
  if (G.want('W:p724')) {
  H.resetDom();
  const vaultP724 = H.makeTempVault('p724');
  const e724 = await H.bootPlugin(vaultP724);
  await specP724(suite, e724.app, e724.plugin, vaultP724);
  await H.shutdown(e724.plugin);
  }

  // ── X：P8 · 回顾（数据 / 手动建卡 / 复习流程 / AI 出稿 / 迁键）────
  /**
   * 自己的库（`makeTempVault('review')`）：迁键要**真 rename 事件**（走桩的
   * `fileManager.renameFile` → main.ts 的 `vault.on('rename')` 那条链）、
   * 删除要真 `trashFile`、卡片要真写库内 `复习.json`；AI 出稿一律假传输层（绝不联网）。
   */
  if (G.want('X:review')) {
  H.resetDom();
  const vaultReview = H.makeTempVault('review');
  const eRv = await H.bootPlugin(vaultReview);
  await specReview(suite, eRv.app, eRv.plugin, vaultReview);
  await H.shutdown(eRv.plugin);
  }

  // ── 分片收尾自报（P7.20-1）：跑的是哪几块，写在最显眼的地方 ─────────
  if (SHARD_ON) {
    const r = G.report();
    console.log(
      `\n分片 ${SHARD_K + 1}/${SHARD_N}：本片负责 ${r.mine.length}/${r.all.length} 块 —— ${r.mine.join(' · ')}`,
    );
  }

  // ── 列表模式（KBW_TEST_LIST=1）：只列命中用例名，不跑本体 ──────────
  /**
   * 用来**先确认过滤词**：`KBW_TEST_ONLY='搬到'` 到底选中了哪几条。
   * 命中的名字在上面已经被 `Suite.it` 逐条打出来了（`  · 组 › 用例`），这里只给一句收尾 +
   * 退出码 2（"只列了"不算通过）。**一条都没命中**是这里最想抓的形态（过滤词拼错）。
   * ⚠️ 必须排在**所有 spec 之后**（它 return 2，后面的组就列不出来了）。
   */
  if (suite.listMode) {
    const only = process.env.KBW_TEST_ONLY ?? '';
    if (suite.listed.length > 0) {
      console.log(
        `\n列表模式（KBW_TEST_LIST=1）：命中 ${suite.listed.length} 条` +
          (only ? `（KBW_TEST_ONLY=「${only}」）` : '（没给过滤词 → 全列）') +
          '　—— 只列不跑，退出码 2',
      );
    } else {
      console.log(
        `\n⚠️ 列表模式（KBW_TEST_LIST=1）：**一条都没命中** —— 过滤词 ` +
          `KBW_TEST_ONLY=「${only}」拼错了？（这就是列表模式要抓的形态）`,
      );
    }
    return 2;
  }

  // ── 汇总 ────────────────────────────────────────────────────
  const failed = suite.failed;
  console.log('');
  for (const r of suite.results) {
    if (!r.ok) console.log(`  ✗ ${r.name}\n      ${(r.error ?? '').replace(/\n/g, '\n      ')}`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  /**
   * 最慢的几条 —— "套件为什么慢 / 是不是又慢了一截"的第一手材料。
   * 加它的直接原因：P4.5 查"偶发 90s 超时"时，输出里**只有总数、没有耗时分布**，
   * 于是非要先猜"是不是某条卡住了"，查完才知道全量本来就要 94s（看门狗 90s）。
   */
  const SLOWEST_N = 10;
  const slowest = [...suite.results].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_N);
  if (slowest.length > 0) {
    console.log(
      `  最慢 ${SLOWEST_N} 条：${slowest.map((r) => `${(r.ms / 1000).toFixed(1)}s ${r.name.split(' › ').pop()}`).join(' · ')}`,
    );
  }
  /**
   * **按组直方图**（P7.20 #4）—— 只有"最慢 10 条"看不出**面**在哪：
   * 全量 1200 条里就算每条只 0.4s，摊到二十来个组里也够呛。
   * 组名 = 用例名「组 › 用例」的第一段（`tests/framework.ts` 的 it() 拼的）。
   * 按**组总耗时**降序 + 占比 + 组内均值 —— "717s 都花在哪"一眼能看到；
   * settle 审计（P7.20 #2）就照这张表挑大户，而不是凭感觉。
   */
  const byGroup = new Map<string, { n: number; ms: number }>();
  for (const r of suite.results) {
    const g = r.name.split(' › ')[0] || '(未分组)';
    const cur = byGroup.get(g) ?? { n: 0, ms: 0 };
    cur.n += 1;
    cur.ms += r.ms;
    byGroup.set(g, cur);
  }
  const groupRows = [...byGroup.entries()]
    .map(([g, v]) => ({ g, n: v.n, ms: v.ms }))
    .sort((a, b) => b.ms - a.ms);
  if (groupRows.length > 1) {
    const totalMs = groupRows.reduce((s, r) => s + r.ms, 0) || 1;
    console.log(`  按组耗时（${groupRows.length} 组，合计 ${(totalMs / 1000).toFixed(1)}s）：`);
    for (const r of groupRows) {
      const pct = (r.ms / totalMs) * 100;
      const bar = '█'.repeat(Math.max(1, Math.round(pct / 4)));
      console.log(
        `    ${(r.ms / 1000).toFixed(1).padStart(6)}s ${pct.toFixed(1).padStart(5)}% ${bar} ${r.g}（${r.n} 条，均 ${(r.ms / r.n / 1000).toFixed(2)}s）`,
      );
    }
  }
  /**
   * **软告警**（不判失败）：天花板 15 分钟只防"永远跑不完"，防不住**性能退化** ——
   * 哪天真涨到 5 分钟也照样 `exit 0`。这条不失败（机器负载本来就会漂），
   * 只把"比基线慢了一大截"说出来（独立审查 🟢7：抬高预算与盯住退化，两件事都要有判据）。
   *
   * ── 基线漂移查清了（d2 期，2026-09-26）────────────────────────
   * 那笔旧账是这么记的：「94s（2026-09-25 记），d 期两次实测都是 146s ——
   * 要么重测一个诚实的基线、要么查清那 50s」。
   * 查的结论：**不是某一条退化了，是条数涨了**，而且是线性的 ——
   *   · 94s 那会儿 ≈ 230 条 → **0.41 s/条**
   *   · d 期 146s / 336 条 → **0.43 s/条**
   *   · d2 期 169s / 353 条 → **0.48 s/条**
   * 最慢 5 条也一直是 4–5s 那几条老面孔（每次跑都换），没有新的长尾。
   * 所以那个 94 早就不是"现在的套件"了，留着它只会让告警形同虚设 ——
   * **重测成 165s**（353 条），并把"看 s/条"这条口径写在这儿：
   * 以后涨过 **0.8 s/条** 才算真退化，光看总时长会被"又加了几十条用例"骗过去。
   */
  /**
   * 🔴 **按 s/条 判，别按总时长**（独立审查对 P6b 指出：写死 165s × 2 = 330s，而套件涨到
   * 570 条 ≈ 370s 之后**每一轮都会响** —— 告警响成了背景噪音就等于没有）。
   * 口径就写在上面那段注释里：**涨过 0.8 s/条才算真退化**。
   */
  const PER_CASE_BUDGET_S = 0.8;
  const n = suite.results.length;
  const perCase = n > 0 ? Number(secs) / n : 0;
  /**
   * ⚠️ **子集跑不判这一条**（P7.19 加）。`s/条` 的前提是"**全量**"：
   * 窄过滤下"把二十来个库 boot 起来"的骨架（**实测 81.9s**）会被摊到少数几条用例头上 ——
   * 实测那行是 `用时 81.9s / 1 条 = 81.900 s/条`。每次都响的告警 = 没有告警，
   * 真退化（全量下真的涨过 0.8）会被这行噪音淹掉。
   * 判据：`skipped === 0` 才是全量（`skipped` 只在给了过滤词、且有没命中的用例时才加）。
   */
  if (suite.skipped === 0 && perCase >= PER_CASE_BUDGET_S) {
    console.log(
      `⚠️ 套件用时 ${secs}s / ${n} 条 = ${perCase.toFixed(3)} s/条，超过 0.8 s/条那条口径 —— ` +
        `先看上面"最慢 10 条"和按组直方图，看是不是哪个组退化了`,
    );
  }
  console.log(`\n通过 ${suite.passed} / ${suite.results.length}　失败 ${failed.length}　用时 ${secs}s`);

  /**
   * 退出码 —— ⚠️ **别写 `suite.results.length > 0 &&`**（P5 收尾实测的洞）：
   * 那样一来 `KBW_TEST_ONLY` 拼错、一条都没匹配上时，`results.length === 0` 会让这条判据
   * 短路成"全部通过 ✅、退出码 0" —— **只有 `skipped > 0` 这一半才是真判据**
   *（`skipped` 只在有过滤词、且某条没被选中时才加一）。突变测试时我正好撞上：
   * 跑 `KBW_TEST_ONLY="extraDirs 必须经过"`（名字里其实隔着两个反引号）→ 0 条 → 绿。
   */
  let code: number;
  if (failed.length > 0) {
    code = 1;
  } else if (SHARD_ON) {
    /**
     * 🔴 **分片模式一律 2**（P7.20-1）—— 只跑了一部分，按本项目口径"**不算通过**"。
     * 为什么非要这一条：分片把**整块**跳过时那些用例**根本没注册**，
     * `suite.skipped` 仍是 0 → 若沿下面的逻辑就会 `exit 0` + 打「全部通过 ✅」，
     * 而实际只跑了 1/4。**这是分片自己带来的假绿形态**，必须在这一层堵死。
     * 聚合判定交给 `scripts/test-shards.mjs`（它看各片的成绩单，不看退出码 0/2 的分界）。
     */
    console.log(`⚠️ 分片 ${SHARD_K + 1}/${SHARD_N}：只跑了本片那几块 —— **这不算通过**，退出码 2`);
    code = 2;
  } else if (suite.skipped > 0) {
    console.log(`⚠️ 只跑了子集（跳过 ${suite.skipped} 条）—— **这不算通过**，退出码 2`);
    code = 2;
  } else {
    console.log('全部通过 ✅');
    code = 0;
  }

  /**
   * **成绩单落盘**（P7.19 #3 ①）—— `scripts/mutate-runner.mjs` 靠它判"咬住的是不是**预期那条**"。
   * ⚠️ **一处落盘**：这里手里就有 `results` 与耗时，**别在 `scripts/test.mjs` 再写第二份**
   *    （两处各写一份必漂 —— 本项目的老账）。
   * ⚠️ **判红判绿都要落**：突变跑本来就是红的，那正是最需要看名单的时候。
   * ⚠️ 路径优先取 `KBW_RESULTS_PATH`（`scripts/test.mjs` 会按仓库根设好；这样 cwd 不敏感）。
   */
  try {
    const out =
      process.env.KBW_RESULTS_PATH ??
      path.join(process.cwd(), 'tests', '.tmp', 'last-results.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          exitCode: code,
          total: suite.results.length,
          passed: suite.passed,
          failedCount: failed.length,
          skipped: suite.skipped,
          secs: Number(secs),
          failed: failed.map((r) => r.name),
          slowest: slowest.map((r) => ({ name: r.name, ms: r.ms })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (e) {
    console.error(`⚠️ 成绩单落盘失败（${(e as Error).message}）—— 突变判定会判"成绩单缺失"`);
  }

  /**
   * **per-case 耗时落盘**（P7.20 #4）—— `tests/.tmp/timings.json`。
   * 与 `last-results.json` **分工不同**：那份是"判决书"（突变判定要读），这份是"体检报告"。
   * 内容：全部用例（名 / 组 / ms / 是否过）+ 按组汇总 + 总数与总耗时。
   * 目的：给"717s 都花在哪"一份**可归档、可跨轮对比**的分布材料。
   * ⚠️ 路径走 `KBW_TIMINGS_PATH`（同 `KBW_RESULTS_PATH` 的风格），cwd 不敏感。
   */
  try {
    const tOut =
      process.env.KBW_TIMINGS_PATH ?? path.join(process.cwd(), 'tests', '.tmp', 'timings.json');
    fs.mkdirSync(path.dirname(tOut), { recursive: true });
    fs.writeFileSync(
      tOut,
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          total: n,
          secs: Number(secs),
          cases: suite.results.map((r) => ({
            name: r.name,
            group: r.name.split(' › ')[0] || '(未分组)',
            ms: r.ms,
            ok: r.ok,
          })),
          groups: groupRows.map((r) => ({ group: r.g, n: r.n, ms: r.ms })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (e) {
    console.error(`⚠️ 耗时落盘失败（${(e as Error).message}）`);
  }

  return code;
}
