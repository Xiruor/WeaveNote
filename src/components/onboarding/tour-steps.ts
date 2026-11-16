// ============================================================
// 新手引导步骤配置（driver.js）
// 按页面分段：driver 只在"当前页面"渲染其步骤，段落播完后自动跳到
// 流程里的下一页（nextPageOf），由 OnboardingProvider 接续播放。
// 流程顺序见 TOUR_ROUTE_ORDER，引导可以"从当前所在页面"开始，
// 例如你正在智能体页，触发引导就先讲智能体页，再往后走。
// ============================================================

export type TourStepSide = "top" | "right" | "bottom" | "left";
export type TourStepAlign = "start" | "center" | "end";

export interface TourStepConfig {
  /** 标题 */
  title: string;
  /** 说明文案 */
  description: string;
  /** 高亮目标 CSS 选择器；缺省 → 全屏居中弹层（欢迎 / 收尾） */
  selector?: string;
  side?: TourStepSide;
  align?: TourStepAlign;
  data?: {
    /** 该步骤高亮期间把顶部原子导航展开（把主导航链接完整露出来） */
    expandNav?: boolean;
  };
}

/** 引导覆盖的页面（顺序即引导播放顺序；段落播完自动进下一页） */
export const TOUR_ROUTE_ORDER = [
  "/notes",
  "/agent",
] as const;

/**
 * 步骤按页面分组；key 与路由路径一致。
 * 调整内容时把 TOUR_VERSION 升级（v2...），已看过旧版的用户会再看一遍新引导。
 */
export const TOUR_VERSION = "v3";

export const TOUR_SEGMENTS: Record<string, TourStepConfig[]> = {
  "/notes": [
    {
      title: "欢迎来到织念 ✨",
      description:
        "与 AI 共笔的沉浸式笔记库——它读得懂你所有的笔记，也记得你。用几步带你逛一圈，马上就能上手。",
    },
    {
      title: "顶部导航",
      description:
        "笔记库和智能体两个入口都在顶栏：笔记库安放你的想法，智能体随时和你共笔。",
      selector: ".atomic-nav",
      side: "bottom",
      data: { expandNav: true },
    },
    {
      title: "点亮 Star ⭐",
      description:
        "喜欢这个项目的话，点一下右上角的 GitHub 按钮去「点亮 Star」——你的每一个 star，都是创作者最大的动力。",
      selector: ".gh-icon-wrap",
      side: "bottom",
    },
    {
      title: "去智能体页看看",
      description:
        "接下来去智能体页：它可以读你的笔记、引用原文，还会记住你们聊过的东西。",
    },
  ],

  "/agent": [
    {
      title: "与 AI 共笔",
      description:
        "左边是你们的对话历史；中间直接和 AI 说——它能结合你的笔记回答，也会长期记住你们聊过的内容。",
      selector: ".rainforest-panel--left",
      side: "right",
    },
    {
      title: "都准备好啦 ✨",
      description:
        "这就是全部啦！回到笔记库写下第一条想法，任何时候点头像 →「新手引导」都能再看一遍。",
    },
  ],
};

/** 当前页在引导流程里的"下一页"（最后一页返回 null，表示流程到此结束） */
export function nextPageOf(page: string): string | null {
  const idx = TOUR_ROUTE_ORDER.indexOf(page as (typeof TOUR_ROUTE_ORDER)[number]);
  if (idx === -1) return null;
  return TOUR_ROUTE_ORDER[idx + 1] ?? null;
}

/** 给每个静态步骤分配全局序号（跨段落连续计数，用于进度文案 "x / N"） */
export const TOUR_STEP_INDEX = new Map<TourStepConfig, number>();
{
  let i = 1;
  for (const page of TOUR_ROUTE_ORDER) {
    for (const step of TOUR_SEGMENTS[page] ?? []) {
      TOUR_STEP_INDEX.set(step, i++);
    }
  }
}

export const TOUR_TOTAL_STEPS = TOUR_STEP_INDEX.size;
