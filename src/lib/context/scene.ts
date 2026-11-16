// ============================================================
// Scene Context：当前业务数据
//
// M0 裁剪后：计划/文档工作台已删除，场景上下文不再查询任何业务表，
// 仅基于会话归属（surface + refId）生成，保持返回结构 { prompt } 兼容。
// note 场景的 refId 是 noteId，笔记标题/正文的注入留到 M1
// 接入笔记编辑器宿主时补充。
// ============================================================

import type { MemorySurface } from "@/lib/memory/types";

export interface SceneContext {
  prompt: string;
}

export async function loadSceneContext(input: {
  userId: string;
  surface: MemorySurface;
  /** note 场景下为 noteId；M1 用于加载笔记标题/正文 */
  refId: string | null;
}): Promise<SceneContext> {
  // M1：surface === "note" 且 refId 存在时，在此加载笔记标题/正文拼 prompt。
  return { prompt: "" };
}
