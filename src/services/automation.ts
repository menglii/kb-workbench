/**
 * services/automation.ts —— `99_Meta/06_工作台/自动化.json` 的读写与形状
 *
 * 库内配置是**唯一真源**（`方案设计.md` §3.1）：这个文件可见、可手改、可 Git、跟着库走。
 * 插件 `data.json` 只放"这台机器"的东西（比如 `reconcileSeen` 那份"上次看见的声明"）。
 *
 * 两个开关分两层，别混（设置面板会显示两层的关系）：
 *   · **模块开关**（`data.json` 的 `modules.*`）—— 两项功能**各归自己的那个**：
 *     「新建笔记补全」看 `modules.completion`（默认**开**）·
 *     「自动归位」看 `modules.automation`（默认**关**）
 *   · **本文件里的 `completion.enabled` / `reconcile.enabled`** —— 两项功能各自的库内开关
 *   谁的动作就"模块开关 + 本文件那一项**都开**才动"（关掉模块 = 真的停手，`core/modules.ts` 的口径）。
 *   ⚠️ P3 收尾按独立审查改了这里的措辞：原来的注释（和面板告警）写的是"整个自动化模块的电源"，
 *   于是"关掉 automation"看起来该停掉两项 —— 实际只停「自动归位」（补全归 `completion` 管）。
 *
 * ⚠️ 它是**库内 JSON、不是笔记**：不进索引、不受健康检查管，写盘要走
 * `vault.process`（`config-files.ts` 已经做对了这件事）。
 */
import type { ConfigFiles } from '../core/config-files';

export interface AutomationConfig {
  /** ⚠️ 模板目录**不在这里配**：它由库根派生（`settings.templateDir()`），
   *  这里再放一个 `templatesDir` 的话就成了"两处口径"（P3 收尾删掉了那个死键） */
  completion: { enabled: boolean; defaultTemplate: string };
  /** ⚠️ `enabled` v2 起已退役（保留键、不再读）—— 见 `AUTO_DEFAULTS` 的注释 */
  reconcile: { enabled: boolean; exclude: string[] };
}

/**
 * ⚠️ 排除项里那一条写的是**真名**：快照还原把挡路的文件挪到
 * `还原保留-<时间戳>/`（`services/snapshot.ts`），而 `交互规格.md` §7.1 抄的是旧实现的
 * 术语「回滚保留」—— 按字面配的话**一个文件都拦不住**。前缀/段匹配认 `还原保留` 就够
 * （带时间戳的那些目录都命中）。文档那处已回改。
 */
export const AUTO_DEFAULTS: AutomationConfig = {
  completion: {
    enabled: true,
    defaultTemplate: 'T_收件箱速记.md',
  },
  reconcile: {
    /**
     * ⚠️ **v2（P7.12 · #12）起已退役（不再被读）** —— 显式改「文件位置」= 直接搬，
     * 不看这个开关（`services/reconcile.ts` 的文件头）。键**保留**是为了不动库内
     * `自动化.json` 的形状（旧库里的值照旧留着，读了也不生效）。
     */
    enabled: false,
    exclude: ['99_Meta', '02_旧知识库', '还原保留', '.开头'],
  },
};

/** 把读出来的东西收敛成合法形状（文件可能被手改坏，甚至写成一堆乱码） */
export function normalizeAutomation(raw: unknown): AutomationConfig {
  const out = JSON.parse(JSON.stringify(AUTO_DEFAULTS)) as AutomationConfig;
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  const c = src.completion;
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    if (typeof o.enabled === 'boolean') out.completion.enabled = o.enabled;
    if (typeof o.defaultTemplate === 'string' && o.defaultTemplate.trim()) {
      out.completion.defaultTemplate = o.defaultTemplate.trim();
    }
    // （老的 `templatesDir` 键：读了也**不用** —— 模板目录由库根派生，别让它有两个来源）
  }
  const r = src.reconcile;
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (typeof o.enabled === 'boolean') out.reconcile.enabled = o.enabled;
    if (Array.isArray(o.exclude)) {
      const list = o.exclude.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      out.reconcile.exclude = list;
    }
  }
  return out;
}

export class AutomationStore {
  private configs: ConfigFiles;
  private cache: AutomationConfig | null = null;

  constructor(configs: ConfigFiles) {
    this.configs = configs;
  }

  /** 读（带一层缓存；`save()` 会刷新，外部改动走 `configs.onChange` 清缓存） */
  async get(): Promise<AutomationConfig> {
    if (this.cache) return this.cache;
    try {
      this.cache = normalizeAutomation(await this.configs.read('automation'));
    } catch {
      this.cache = normalizeAutomation(null);
    }
    return this.cache;
  }

  /** 写（**不存在就落盘**：这是本文件第一次被创建的时机） */
  async save(next: AutomationConfig): Promise<void> {
    const copy = normalizeAutomation(next);
    await this.configs.write('automation', copy);
    this.cache = copy;
  }

  /**
   * 改一部分（两栏各自改自己的开关，不互相覆盖）。
   * 类型是"**深一点的局部**"：`{ completion: { enabled: true } }` 不用把同组的
   * `defaultTemplate` 也写一遍（那是 `Partial<T>` 做不到的）。
   */
  async patch(patch: {
    completion?: Partial<AutomationConfig['completion']>;
    reconcile?: Partial<AutomationConfig['reconcile']>;
  }): Promise<AutomationConfig> {
    const cur = await this.get();
    const next: AutomationConfig = {
      completion: { ...cur.completion, ...(patch.completion ?? {}) },
      reconcile: { ...cur.reconcile, ...(patch.reconcile ?? {}) },
    };
    await this.save(next);
    return next;
  }

  /** 外部（库内文件被手改 / 同步过来）改了 → 下次重读 */
  invalidate(): void {
    this.cache = null;
  }
}
