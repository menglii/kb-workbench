/**
 * blocks/graphlink —— 图谱卡（P7.2d · 16.9-a；**Q1 拍板：嵌真迷你图谱**）
 *
 * 与图谱模块**同一套挂载/过滤封装**（`mountGraphInto` —— Q1 的红线：
 * "先抽件再接线，不抄第二遍"），只是宿主矮一截（卡内 ~240px）。
 *
 * 四条边界（Q1 + 提示词 §1）：
 *  · **核心图谱插件关着 → 整卡自隐**（`return false`；首页不摆"去开启"故障整页）；
 *  · 读不到核心插件状态（`unknown`）→ **照挂**（与模块同口径），挂不上再给一行说明；
 *  · 过滤没注入上 → 图谱照常显示 + 一行小字（不误导成"排干净了"）；
 *  · 挂失败 → 一行说明 + 「重试」（就地重挂，不整页重建）。
 *
 * ⚠️ **每份宿主的收尾归这里**（模块级注册表拿不到宿主）：`mounts` 以宿主元素为键
 * 存把手 —— 多标签分屏时两个首页各有各的宿主，弱引用键天然分清谁是谁。
 * `cleanup(host)` 里 detach，**不留悬挂叶**（本项目老账）。
 */
import type { HomeBlock } from './index';
import { btn, div, el, span } from '../../../ui/primitives';
import { graphCoreState, mountGraphInto, errText, type GraphMountHandle } from '../../graph';

/** 宿主元素 → 这一屏的挂载把手（弱引用：块重建时旧宿主自然退场） */
const mounts = new WeakMap<HTMLElement, GraphMountHandle>();

export const graphLinkBlock: HomeBlock = {
  id: 'graphlink',
  title: '图谱卡',
  hint: '把迷你图谱嵌在首页（官方图谱真渲染，与图谱模块同一套挂载/过滤）；核心插件关着时整卡自隐',
  defaultOn: false,
  paint(ctx, host) {
    // 关着 → 整卡自隐（不是画"去开启"—— 首页不摆故障页）
    if (graphCoreState(ctx.app) === 'disabled') return false;
    const head = div({ cls: 'kbw-sec-head' });
    head.appendChild(el('h3', { text: '图谱' }));
    host.appendChild(head);
    host.appendChild(div({ cls: 'kbw-rule' }));
    const stage = div({ cls: ['kbw-graph-stage', 'kbw-hgraph-stage'] });
    host.appendChild(stage);

    const mount = (): void => {
      mounts.get(stage)?.dispose();
      while (stage.firstChild) stage.removeChild(stage.firstChild);
      mounts.set(
        stage,
        mountGraphInto(stage, ctx, {
          onFail: (e) => {
            while (stage.firstChild) stage.removeChild(stage.firstChild);
            const row = div({ cls: 'kbw-hgraph-fail' });
            row.appendChild(span({ text: `图谱没挂上（${errText(e)}）` }));
            row.appendChild(
              btn({ cls: 'kbw-btn is-small is-ghost', text: '重试', on: { click: mount } }),
            );
            stage.appendChild(row);
          },
          onFilterUnsupported: () => {
            stage.appendChild(
              div({ cls: 'kbw-hgraph-note', text: '过滤没注入上 —— 图谱照常显示，但没有排除旧库。' }),
            );
          },
        }),
      );
    };
    mount();
    return true;
  },
  cleanup(host) {
    const stage = host?.querySelector?.('.kbw-hgraph-stage') as HTMLElement | null;
    if (!stage) return;
    mounts.get(stage)?.dispose();
    mounts.delete(stage);
  },
};
