// ============================================================
// 工具 router —— 按场景声明「给哪些工具 + 配哪段提示词」
//
// 背景：/api/ai 是所有 AI 入口共用的唯一端点。织念改造后只剩两个场景：
//   workspace  跨笔记工作台（原智能体页）
//   note       笔记编辑器侧栏（M1 才接入宿主）
// refId = noteId（note 场景）；workspace 场景为 null。
//
// 原先它把 5 个工具工厂无条件全量展开，学习业务（计划/打卡/待办/知识库）
// 裁掉后，工具只剩只读的长期记忆查询与会话上下文维护。
//
// ⚠️ 工具白名单与提示词分组必须写在同一个常量里。SYSTEM_PROMPT 是全部场景共用的，
//    里面点名了每一个工具并带祈使指令。只裁工具不裁提示词，模型会反复去调
//    一个不存在的工具——比不裁更糟。二者只在一处声明，才谈得上不漂移。
//
// 白名单是 fail-closed：往工厂里加一个新工具，它不会自动出现在任何场景，
// 必须显式列出来。这正是原先缺的那道闸门。
// ============================================================

/** 两个场景。会话表 Conversation.surface 用的就是这两个值。 */
export const AI_SURFACES = ["workspace", "note"] as const;
export type AiSurface = (typeof AI_SURFACES)[number];

/**
 * 提示词分组。每一组对应 deepseek.ts 里**一段连续的原文**，
 * 与 PROMPT_GROUPS 的 key 一一对应，两边必须同一次改齐。
 *
 * 各段含哪些工具名（决定它能不能给场景）：
 *   toolReference  getMyMemories, searchConversationHistory, updateAgentState
 *   conduct        不新增工具名
 */
export const ALL_PROMPT_GROUPS = [
  "toolReference", // 能力清单 / 什么时候用工具
  "conduct", // 行为准则
] as const satisfies readonly string[];

export type PromptGroup = (typeof ALL_PROMPT_GROUPS)[number];

/** 各场景共有的读工具：目前只剩长期记忆查询 */
const READ_TOOLS = [
  "getMyMemories",
] as const;

/**
 * 会话上下文工具（所有入口都需要）：
 *   searchConversationHistory 找回被摘要压缩的原文
 *   updateAgentState          维护当前会话的 workingMemory / todoList
 *
 * updateAgentState 只写 AgentState，不碰业务数据，因此可以给所有场景。
 */
const CONTEXT_TOOLS = [
  "searchConversationHistory",
  "updateAgentState",
] as const;

export interface SurfacePolicy {
  /** 该场景注册的工具白名单（工具名） */
  tools: readonly string[];
  /** 该场景注入的提示词分组 */
  promptGroups: readonly PromptGroup[];
}

export const SURFACE_POLICY: Record<AiSurface, SurfacePolicy> = {
  // 两个场景当前拿同一套只读工具与提示词；差异等 M1（note 宿主接入）再引入。
  workspace: {
    tools: [...READ_TOOLS, ...CONTEXT_TOOLS],
    promptGroups: ALL_PROMPT_GROUPS,
  },

  note: {
    tools: [...READ_TOOLS, ...CONTEXT_TOOLS],
    promptGroups: ALL_PROMPT_GROUPS,
  },
};

/**
 * 把请求体/数据库里的 surface 字符串收敛成合法 AiSurface。
 * 未知值（含历史遗留的 agent/plan/doc）一律兜底 workspace，与
 * route.ts 建会话/读会话两处的口径一致。
 */
export function surfaceOf(surface?: string | null): AiSurface {
  return (AI_SURFACES as readonly string[]).includes(surface ?? "")
    ? (surface as AiSurface)
    : "workspace";
}

export function toolNamesFor(surface: AiSurface): readonly string[] {
  return SURFACE_POLICY[surface].tools;
}

export function promptGroupsFor(surface: AiSurface): readonly PromptGroup[] {
  return SURFACE_POLICY[surface].promptGroups;
}

/**
 * 按白名单过滤候选工具集。
 *
 * 返回类型标成 T 而不是 Partial<T>：AI SDK 的 tools 参数要的是
 * Record<string, Tool>，Partial 会把每个值变成 Tool | undefined，通不过类型检查。
 * 运行时返回的确实是子集，所以这个"谎"只影响这一处的类型，而白名单是常量、
 * 且有测试逐个核对——比在调用点写 as 更收敛。
 *
 * @param candidates 已建好的全部候选工具（当前为 memory + context 两组）
 * @param surface    目标场景
 */
export function pickTools<T extends Record<string, unknown>>(
  candidates: T,
  surface: AiSurface
): T {
  const allowed = new Set<string>(toolNamesFor(surface));
  const picked: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(candidates)) {
    if (allowed.has(name)) picked[name] = tool;
  }
  return picked as T;
}
