import { describe, expect, it } from "vitest";

// 工具卡片的展示元数据是 fail-closed 白名单：新加的工具不会自动出现在卡片上，
// 漏登记的表现是「卡片显示成裸工具名」（能跑，但用户看到的是英文标识符）。
// 注册表按契约裁剪后覆盖保留工具；与 router 白名单的互相核对仍然保留，
// 两边漂移了不会报错，只能靠测试钉住。

import { SURFACE_POLICY } from "@/lib/tools/router";
import { TOOL_UI, toolUi } from "@/lib/tools/tool-ui";

/** 统一契约里保留的 AI 工具（M2：+ 笔记检索；M3：+ 读/写工具；M4：+ remember） */
const RETAINED_TOOLS = [
  "getMyMemories",
  "remember",
  "searchConversationHistory",
  "updateAgentState",
  "searchNotes",
  "readNote",
  "listNotes",
  "summarizeNote",
  "createNote",
  "proposeNoteEdit",
] as const;

/** 所有场景白名单的并集 = 真正可能被模型调用的全部工具 */
function allWhitelistedTools(): string[] {
  const names = new Set<string>();
  for (const policy of Object.values(SURFACE_POLICY)) {
    for (const name of policy.tools) names.add(name);
  }
  return [...names].sort();
}

describe("TOOL_UI 注册表", () => {
  it("注册表只含保留工具", () => {
    expect(Object.keys(TOOL_UI).sort()).toEqual([...RETAINED_TOOLS].sort());
  });

  it("每个能到达模型的工具都有展示元数据（防漏登记）", () => {
    const missing = allWhitelistedTools().filter((name) => !(name in TOOL_UI));
    expect(missing).toEqual([]);
  });

  it("没有登记了却不在白名单里的僵尸条目", () => {
    const whitelisted = new Set(allWhitelistedTools());
    const stale = Object.keys(TOOL_UI).filter((name) => !whitelisted.has(name));
    expect(stale).toEqual([]);
  });

  it("每条登记都有动作名和合法分类", () => {
    for (const [name, spec] of Object.entries(TOOL_UI)) {
      expect(spec.label.trim(), `${name} 的动作名为空`).not.toBe("");
      expect(["read", "write"], `${name} 分类非法`).toContain(spec.kind);
    }
  });

  it("读/写分类：检索/读笔记/列笔记/总结是 read，写笔记、提案与记忆写入是 write", () => {
    expect(TOOL_UI.getMyMemories?.kind).toBe("read");
    expect(TOOL_UI.searchConversationHistory?.kind).toBe("read");
    expect(TOOL_UI.searchNotes?.kind).toBe("read");
    expect(TOOL_UI.readNote?.kind).toBe("read");
    expect(TOOL_UI.listNotes?.kind).toBe("read");
    expect(TOOL_UI.summarizeNote?.kind).toBe("read");
    expect(TOOL_UI.createNote?.kind).toBe("write");
    expect(TOOL_UI.proposeNoteEdit?.kind).toBe("write");
    expect(TOOL_UI.remember?.kind).toBe("write");
    expect(TOOL_UI.updateAgentState?.kind).toBe("write");
  });
});

describe("toolUi 兜底", () => {
  it("未登记的工具不崩，退化成裸名", () => {
    expect(toolUi("someBrandNewTool")).toEqual({
      label: "someBrandNewTool",
      kind: "read",
    });
  });

  it("summarize 面对畸形入参不抛错", () => {
    for (const spec of Object.values(TOOL_UI)) {
      if (!spec.summarize) continue;
      expect(() => spec.summarize!(null, undefined)).not.toThrow();
      expect(() => spec.summarize!("not an object", 42)).not.toThrow();
      expect(() => spec.summarize!({ content: 123 }, {})).not.toThrow();
    }
  });
});
