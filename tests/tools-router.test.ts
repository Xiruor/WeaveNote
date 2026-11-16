import { describe, expect, it, vi } from "vitest";

// 工具按场景裁剪是**权限边界**，不是优化。白名单 fail-closed：往工厂里加新工具
// 不会自动出现在任何场景；反过来，工具已删而白名单漏改，会变成「模型反复调用
// 不存在的工具」。所以这里钉三件事：surface 契约、保留工具集、提示词不带已删业务。

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  AI_SURFACES,
  ALL_PROMPT_GROUPS,
  SURFACE_POLICY,
  pickTools,
  promptGroupsFor,
  surfaceOf,
  toolNamesFor,
} from "@/lib/tools/router";
import { createMemoryTools } from "@/lib/tools/memory-tools";
import { createContextTools } from "@/lib/tools/context-tools";
import { buildSystemPrompt } from "@/lib/deepseek";

/** 统一契约：AI surface 只剩工作台与笔记，保留的 AI 工具只有这三个 */
const RETAINED_TOOLS = [
  "getMyMemories",
  "searchConversationHistory",
  "updateAgentState",
] as const;

/** 已随旧学习业务删除的工具名——任何场景、任何提示词里都不该再出现 */
const DELETED_TOOLS = [
  "createPlan",
  "breakdownPlanTasks",
  "updateTaskStatus",
  "createTodo",
  "updateTodo",
  "deleteTodo",
  "updatePlanInfo",
  "updateDocument",
  "getMyPlans",
  "getRecentCheckins",
  "getStudyStats",
  "searchKnowledgeBase",
  "listKnowledgeDocs",
  "getPlanTasks",
  "getTodayTasks",
  "getMyTodos",
];

/** 已删业务的关键词，提示词里不该残留 */
const DELETED_BUSINESS_KEYWORDS = ["知识库", "待办", "打卡", "学习计划", "番茄钟"];

/** 与 route.ts 同构地建出全部候选工具（契约：只剩 memory 与 context 两个工厂） */
function buildCandidates() {
  return {
    ...createMemoryTools("u1"),
    ...createContextTools("u1", "c1"),
  };
}

describe("AI_SURFACES", () => {
  it("只剩 workspace 与 note 两个场景", () => {
    expect([...AI_SURFACES]).toEqual(["workspace", "note"]);
  });

  it("策略表与场景一一对应", () => {
    expect(Object.keys(SURFACE_POLICY).sort()).toEqual([...AI_SURFACES].sort());
  });
});

describe("surfaceOf", () => {
  it("合法值原样收敛；未知/空值兜底 workspace（含历史遗留的 agent/plan/doc）", () => {
    expect(surfaceOf("workspace")).toBe("workspace");
    expect(surfaceOf("note")).toBe("note");
    expect(surfaceOf(undefined)).toBe("workspace");
    expect(surfaceOf(null)).toBe("workspace");
    expect(surfaceOf("")).toBe("workspace");
    expect(surfaceOf("agent")).toBe("workspace");
    expect(surfaceOf("plan")).toBe("workspace");
    expect(surfaceOf("doc")).toBe("workspace");
  });
});

describe("工具白名单", () => {
  it("两个场景都拿到全部三个保留工具", () => {
    for (const surface of AI_SURFACES) {
      for (const name of RETAINED_TOOLS) {
        expect(toolNamesFor(surface), `${surface} 缺 ${name}`).toContain(name);
      }
    }
  });

  it("⚠️ 白名单里每个名字都能在真实候选集里找到（防漂移）", () => {
    // 工具改名或白名单打错字时，pickTools 会安静地少给一个工具——
    // 没有这条断言，「fail-closed」就退化成「静默失效」。
    const available = new Set(Object.keys(buildCandidates()));
    for (const surface of AI_SURFACES) {
      for (const name of toolNamesFor(surface)) {
        expect(
          available.has(name),
          `白名单里的 ${name}（${surface}）不在候选集里——工具改名了？`
        ).toBe(true);
      }
    }
  });

  it("已删工具名不得出现在任何场景的白名单里", () => {
    for (const surface of AI_SURFACES) {
      for (const name of DELETED_TOOLS) {
        expect(toolNamesFor(surface), `${surface} 不该再有 ${name}`).not.toContain(name);
      }
    }
  });

  it("pickTools 真的按白名单过滤，不夹带", () => {
    for (const surface of AI_SURFACES) {
      const picked = pickTools(buildCandidates(), surface);
      expect(Object.keys(picked).sort()).toEqual([...toolNamesFor(surface)].sort());
    }
  });

  it("pickTools 对塞进候选集的已删工具一律不放行", () => {
    const candidates = { ...buildCandidates(), deleteTodo: { description: "已删" } };
    for (const surface of AI_SURFACES) {
      expect(pickTools(candidates, surface), `${surface} 放行了 deleteTodo`).not.toHaveProperty(
        "deleteTodo"
      );
    }
  });
});

describe("系统提示词裁剪", () => {
  it("每个分组都有对应文案（声明了却没文案 → 该场景拿到空提示词）", () => {
    for (const g of ALL_PROMPT_GROUPS) {
      expect(buildSystemPrompt([g]).length, `分组 ${g} 没有文案`).toBeGreaterThan(0);
    }
  });

  it("每个场景都声明了提示词分组", () => {
    for (const surface of AI_SURFACES) {
      expect(promptGroupsFor(surface).length).toBeGreaterThan(0);
    }
  });

  it("提示词不点名任何已删工具，也不残留已删业务关键词", () => {
    for (const surface of AI_SURFACES) {
      const prompt = buildSystemPrompt(promptGroupsFor(surface));
      for (const t of DELETED_TOOLS) {
        expect(prompt.includes(t), `${surface} 的提示词点名了已删工具 ${t}`).toBe(false);
      }
      for (const k of DELETED_BUSINESS_KEYWORDS) {
        expect(prompt.includes(k), `${surface} 的提示词含已删业务关键词「${k}」`).toBe(false);
      }
    }
  });
});
