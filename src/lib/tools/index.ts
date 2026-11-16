// ============================================================
// Tools 统一导出
//
// M0 裁剪后只剩会话链路需要的部分：
//   context-tools  会话上下文工具（searchConversationHistory / updateAgentState）
//   memory-tools   长期记忆读工具工厂（createMemoryTools → getMyMemories）
//   router         场景白名单 / 提示词分组
//   tool-ui        工具卡片展示元数据
//   utils          safeExecute
// ============================================================

export { createContextTools } from "./context-tools";
export { createMemoryTools, recallMemories } from "./memory-tools";
export {
  AI_SURFACES,
  ALL_PROMPT_GROUPS,
  SURFACE_POLICY,
  type AiSurface,
  type PromptGroup,
  type SurfacePolicy,
  pickTools,
  promptGroupsFor,
  surfaceOf,
  toolNamesFor,
} from "./router";
export { toolUi, type ToolKind, type ToolUiSpec } from "./tool-ui";
export { safeExecute } from "./utils";
