/**
 * core/modules.ts —— 模块开关（全局层）
 *
 * 方案设计.md §6.2 最后一条「**关掉模块就真的停手**：残留入口调用一律拒绝并说明原因」。
 * 所以这里不只是一个布尔读取器，还有一个 `assert()`：任何会被模块开关影响的动作，
 * 起手先 assert —— 关掉之后即使命令面板、旧按钮、快捷键还能摸到入口，也会明确拒绝。
 */
import { FEATURES, type FeatureId, type SettingsStore, type WorkbenchSettings } from './settings';

export type GateListener = (id: FeatureId, on: boolean) => void;

/** 通知落点由外部注入 —— core 不依赖 ui */
export type GateNotifier = (msg: string) => void;

export class ModuleGate {
  private settings: SettingsStore;
  private notifyFn: GateNotifier;
  private listeners = new Set<GateListener>();

  constructor(settings: SettingsStore, notifyFn: GateNotifier) {
    this.settings = settings;
    this.notifyFn = notifyFn;
  }

  isOn(id: FeatureId): boolean {
    return this.settings.get().modules[id] === true;
  }

  /**
   * 拒绝式检查：关着就**说清原因**并返回 false，调用方直接 return。
   * `what` 用中文动作名（「自动归位」「新建笔记补全」），拼出来的话是给人看的。
   */
  assert(id: FeatureId, what: string): boolean {
    if (this.isOn(id)) return true;
    const label = FEATURES[id]?.label ?? id;
    this.notifyFn(`${what}已停手：「${label}」关着（设置 → 模块开关）`);
    return false;
  }

  async set(id: FeatureId, on: boolean): Promise<void> {
    if (this.isOn(id) === on) return;
    await this.settings.save({ modules: { ...this.settings.get().modules, [id]: on } });
    for (const fn of Array.from(this.listeners)) fn(id, on);
  }

  async toggle(id: FeatureId): Promise<void> {
    await this.set(id, !this.isOn(id));
  }

  onChange(fn: GateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 给设置页/开发面板用的清单 */
  describe(): { id: FeatureId; label: string; desc: string; round: string; on: boolean }[] {
    return (Object.keys(FEATURES) as FeatureId[]).map((id) => ({
      id,
      label: FEATURES[id].label,
      desc: FEATURES[id].desc,
      round: FEATURES[id].round,
      on: this.isOn(id),
    }));
  }
}

/** 设置变更后把开关状态同步进 store（导航栏据此隐藏/置灰） */
export function moduleSnapshot(s: WorkbenchSettings): Record<FeatureId, boolean> {
  return { ...s.modules };
}
