# 经纬 · 知识工作台（kb-workbench）

给 Obsidian 做的个人知识库工作台插件：导航（首页 / 全部笔记 / 看板 / 图谱 / 回顾）+ AI 助手 +
自动化整理（自动归位 / 一键整理收件箱 / 库结构重排，全部带快照与撤销）。
约 7.1 万行 TypeScript，**零运行时依赖**（devDependencies 只有 esbuild / jsdom / typescript / @types）。

> 本仓库是**脱敏分享版**：原作者环境里的用户名与库路径已替换为占位（见 `README-分享说明.md`／上层的
> 说明文件）。夹具与设计稿里的示例笔记名是项目早期用于演示/测试的公开示例，保留原样。

---

## 速查

```bash
npm install            # 依赖（零运行时依赖）
npm run build          # esbuild 出 main.js + styles.css（tsc 不参与打包）
npm run watch          # 监听源码与 styles/*.css
npm run typecheck      # tsc --noEmit
npm test               # 离线全量验收（jsdom + 桩 obsidian + 真调用链，约 14 分钟 / 1400 条）
npm run check          # typecheck + test

# 真机相关（需要本机装了 Obsidian，且各路径用环境变量指到你自己那边）：
npm run probe:launch   # 带调试端口启动 Obsidian（真机探针前置；单实例，先完全退出）
npm run probe          # 真机探针：CDP 接进渲染进程，上百步真点真量，末尾自清理
npm run probe -- --only 样式   # 只跑某几步（自动带上前置步骤）
```

## 仓库结构

| 目录 | 内容 |
|---|---|
| `src/` | 插件源码（core 内核 / services 服务层 / modules 四个模块 / ui 控件与面板 / view 工作台外壳） |
| `styles/` | 分文件 CSS（构建时按 `STYLE_ORDER` 拼成 styles.css） |
| `tests/` | 离线验收套件（约 1400 条用例）+ 合成夹具生成器 + obsidian 桩 |
| `scripts/` | 构建 / 部署 / 真机探针（CDP）/ 打包工具链 |
| `界面设计.html` | 视觉稿（浏览器直接打开，可切明暗） |
| `坑/` | 实测坑单（200 条按域拆七本）+ 单槽资源总表 —— `CLAUDE.md` 里有「动什么 → 读哪本」索引 |

## 设计要点（读代码前值得先知道的）

- **三条架构硬规矩**：动文件只能过 `services/mover.ts`；弹菜单只能过 `ui/menu.ts`；
  动库前确认只能过 `ui/confirm.ts`（唯一例外是拖拽 = 即时生效 + 撤销条 + 快照兜底）。
- **动库一律有快照**：每次移动/删除/重排前自动拍快照，"撤销"从来是从快照还原，不做逆运算。
- **平台行为全部实测**：`坑/` 里 200 条坑单（按域拆）＋ asar 全表 39 条，是从 Obsidian 1.13.7 的
  asar 源码取证 + 真机探针量出来的，改代码前强烈建议扫一眼相关条目（`CLAUDE.md` 里有索引）。
- 每个目录的 `index.ts` / 模块文件头部都有大段注释解释"为什么这么写"——那是这个项目的主要文档形态。

## 更多文档

`CLAUDE.md`（开发约定 + 平台坑单）· `交互规格.md`（每个控件的行为规格）· `方案设计.md`（架构与决策表）·
`属性规范.md`（YAML 属性 schema）· `开发计划.md`（分期与接口契约）· `排查报告.md`（平台实测记录）·
`看板优化方案.md`（看板模块口径）。