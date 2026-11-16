// ============================================================
// Scene Context：当前业务数据
//
// M1：note 场景按 refId（noteId）加载笔记标题/正文注入 prompt，
// 让编辑器侧栏的 AI 知道「当前在改哪篇笔记」。归属校验（userId）
// 内联在查询里——非本人的笔记查不到，返回空上下文，不泄露存在性。
// workspace 场景仍无绑定业务对象，恒为空。
// ============================================================

import type { MemorySurface } from "@/lib/memory/types";
import { prisma } from "@/lib/prisma";

export interface SceneContext {
  prompt: string;
}

/** 笔记正文注入上限：只留 AI 看得完的量，超过截断（记忆侧 token 预算另算） */
const NOTE_CONTENT_MAX_CHARS = 12000;

export async function loadSceneContext(input: {
  userId: string;
  surface: MemorySurface;
  /** note 场景下为 noteId */
  refId: string | null;
}): Promise<SceneContext> {
  const { userId, surface, refId } = input;
  if (surface === "note" && refId) {
    const note = await prisma.note.findFirst({
      where: { id: refId, userId },
      select: { title: true, content: true },
    });
    if (!note) return { prompt: "" };

    const content =
      note.content.length > NOTE_CONTENT_MAX_CHARS
        ? `${note.content.slice(0, NOTE_CONTENT_MAX_CHARS)}\n\n[……笔记过长，正文已截断]`
        : note.content;

    return {
      prompt: [
        "<current_note>",
        "用户正在编辑下面这篇笔记，修改类指令针对它的正文：",
        `标题：${note.title}`,
        "正文：",
        content,
        "</current_note>",
      ].join("\n"),
    };
  }
  return { prompt: "" };
}
