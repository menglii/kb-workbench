// P7.13a · #3 库内容操作（真机 · **只连实验库**，走 cdp-page 的双判据红线）：
//   ① 建 3 个样例模板 `T_样例-*`（六键 + 骨架 + 尾链的完整参考实现，Q7/Q8 拍定）
//   ② 把 10 个旧 `T_*`（除 T_智能新建）＋ 3 篇旧实体删进**回收站**
//      （走 `ctx.mover.trash`：快照 + 操作日志 + 可还原 —— 与设置栏「删除」同一条链）
//
// 用法：Obsidian 带调试端口起来之后 `node scripts/p713a-vault-ops.mjs`
// 幂等：样例已存在就跳过；要删的找不到就记账跳过（可安全重跑）。
//
// ⚠️ Templater 目录规则的清理**不在这里**（那是 Templater 自己的 data.json，
//    得趁 Obsidian 没跑时改 —— 见 `期末交接-P7.13a.md` 的执行记录）。
import { connectSandbox } from './cdp-page.mjs';

/** 样例模板（Q7/Q8 拍定：会议记录 / 读书笔记 / 周记复盘；落 T_样例-*.md） */
const SAMPLES = {
  'T_样例-会议记录.md': [
    '---',
    '类型: 模板',
    '状态:',
    '文件位置:',
    '  - 99_Meta/02_模板库/Templater',
    '创建日期: "{{date}}"',
    'tags: []',
    '收藏: false',
    '---',
    '',
    '# {{title}}',
    '',
    '## 参会人',
    '-',
    '',
    '## 议题与决议',
    '-',
    '',
    '## 待办',
    '- [ ]',
    '',
    '---',
    '## 关联笔记',
    '- 相关笔记：[[]]',
    '- 所属中心：{{center}}',
    '- 返回大地图 {{moc}}',
    '',
  ].join('\n'),
  'T_样例-读书笔记.md': [
    '---',
    '类型: 模板',
    '状态:',
    '文件位置:',
    '  - 99_Meta/02_模板库/Templater',
    '创建日期: "{{date}}"',
    'tags: []',
    '收藏: false',
    '---',
    '',
    '# {{title}}',
    '',
    '## 书目',
    '- 书名：',
    '- 作者：',
    '',
    '## 一句话价值',
    '> 这本书最值得带走的是什么？',
    '',
    '## 摘录与想法',
    '-',
    '',
    '## 行动项',
    '- [ ]',
    '',
    '---',
    '## 关联笔记',
    '- 相关笔记：[[]]',
    '- 所属中心：{{center}}',
    '- 返回大地图 {{moc}}',
    '',
  ].join('\n'),
  'T_样例-周记复盘.md': [
    '---',
    '类型: 模板',
    '状态:',
    '文件位置:',
    '  - 99_Meta/02_模板库/Templater',
    '创建日期: "{{date}}"',
    'tags: []',
    '收藏: false',
    '---',
    '',
    '# {{title}}',
    '',
    '## 本周回看',
    '- 做了什么：',
    '- 卡在哪：',
    '',
    '## 收获与教训',
    '-',
    '',
    '## 下周重点',
    '- [ ]',
    '',
    '---',
    '## 关联笔记',
    '- 相关笔记：[[]]',
    '- 所属中心：{{center}}',
    '- 返回大地图 {{moc}}',
    '',
  ].join('\n'),
};

/** 要收进回收站的（P7.13a · #3 · Q9 拍定：10 个旧 T_* 除脚本模板 + 3 篇旧实体） */
const TO_TRASH = [
  '99_Meta/02_模板库/Templater/T_muban.md',
  '99_Meta/02_模板库/Templater/T_mubanshiyan.md',
  '99_Meta/02_模板库/Templater/T_任务.md',
  '99_Meta/02_模板库/Templater/T_内容作品.md',
  '99_Meta/02_模板库/Templater/T_参考资料.md',
  '99_Meta/02_模板库/Templater/T_实验模板.md',
  '99_Meta/02_模板库/Templater/T_收件箱速记.md',
  '99_Meta/02_模板库/Templater/T_每日任务.md',
  '99_Meta/02_模板库/Templater/T_项目笔记.md',
  '99_Meta/02_模板库/Templater/T_领域笔记.md',
  '04_Archives/旧资料/参考资料模板.md',
  '04_Archives/旧资料/学习笔记模板.md',
  '04_Archives/旧资料/项目笔记模板.md',
];

const expr = `(async () => {
  const ctx = app.plugins.plugins['kb-workbench'].context();
  const kb = ctx.settings.kbRoot();
  const out = { made: [], skipped: [], trashed: [], trashSkipped: [], errors: null, snapshotId: '' };
  const samples = ${JSON.stringify(SAMPLES)};
  for (const [name, text] of Object.entries(samples)) {
    const p = kb + '/99_Meta/02_模板库/Templater/' + name;
    if (app.vault.getAbstractFileByPath(p)) { out.skipped.push(p); continue; }
    await app.vault.create(p, text);
    out.made.push(p);
  }
  const files = [];
  for (const rel of ${JSON.stringify(TO_TRASH)}) {
    const f = app.vault.getAbstractFileByPath(kb + '/' + rel);
    if (f) files.push(f);
    else out.trashSkipped.push(kb + '/' + rel);
  }
  if (files.length > 0) {
    const r = await ctx.mover.trash({ files, source: 'manual', reason: 'P7.13a：旧模板清理（#3 · Q9 拍定）' });
    out.trashed = r.trashed.map((x) => (x && x.path) || String(x));
    out.trashSkipped.push(...r.skipped.map((s) => (s.path || '') + '｜' + (s.note || '')));
    out.errors = r.error || null;
    out.snapshotId = r.snapshotId || '';
  }
  return JSON.stringify(out, null, 2);
})()`;

const cdp = await connectSandbox({ what: 'P7.13a 库内容操作（样例落盘 + 旧模板回收）' });
try {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    console.error('页面里抛异常：');
    console.error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    process.exit(1);
  }
  console.log(typeof r.result?.value === 'string' ? r.result.value : JSON.stringify(r.result?.value, null, 2));
} finally {
  cdp.close();
}
