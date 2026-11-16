// ============================================================
// 工具调用的展示元数据
//
// 界面上要把「AI 调了什么工具」渲染成卡片，需要三样东西：动作名、读/写分类
// （读类默认折叠、写类展开）、以及一条落库用的短摘要。
//
// 摘要在**落库时**算好存下来（而不是存原始 input/output），见 lib/ai/parts.ts。
// 好处：列表页不用再关心工具的入参结构，重构入参不会弄坏历史数据的展示。
//
// M0 裁剪后只登记保留的三个工具（getMyMemories / searchConversationHistory /
// updateAgentState）。白名单是 fail-closed：往工具工厂里加一个新工具，它不会
// 自动出现在这里，必须显式登记。漏登记的表现是卡片显示成裸工具名，属于静默降级。
// ============================================================

export type ToolKind = "read" | "write";

export interface ToolUiSpec {
  /** 动作名，完成态显示。进行中显示为「正在${label}…」 */
  label: string;
  /** 读工具默认折叠成一行，写工具展开成卡片 */
  kind: ToolKind;
  /** 落库时算出的短摘要；返回 undefined 表示没什么可补充的 */
  summarize?: (input: unknown, output: unknown) => string | undefined;
}

/** 从工具入参里安全取字段（入参是 unknown，模型给什么都可能） */
function field(source: unknown, key: string): unknown {
  if (source === null || typeof source !== "object") return undefined;
  return (source as Record<string, unknown>)[key];
}

/** 取一个非空字符串，顺带截断——摘要不该比卡片还长 */
function str(value: unknown, max = 40): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export const TOOL_UI: Record<string, ToolUiSpec> = {
  // ---------- 读工具：默认折叠 ----------
  getMyMemories: { label: "回忆长期记忆", kind: "read" },

  searchConversationHistory: {
    label: "检索历史对话",
    kind: "read",
    summarize: (input) => str(field(input, "query")),
  },

  // ---------- 写工具：展开成卡片 ----------
  updateAgentState: {
    label: "更新会话状态",
    kind: "write",
    summarize: (input) => {
      const working = Array.isArray(field(input, "workingMemory"))
        ? (field(input, "workingMemory") as unknown[]).length
        : 0;
      const todos = Array.isArray(field(input, "todoList"))
        ? (field(input, "todoList") as unknown[]).length
        : 0;
      const parts = [
        working > 0 ? `${working} 条任务信息` : "",
        todos > 0 ? `${todos} 条进度` : "",
      ].filter(Boolean);
      return parts.length > 0 ? parts.join("，") : undefined;
    },
  },
};

export function toolUi(toolName: string): ToolUiSpec {
  return TOOL_UI[toolName] ?? { label: toolName, kind: "read" };
}
