// ============================================================
// 笔记工具（M2）
//
// createNoteTools(userId) 产出两个只读工具：
//   searchNotes  跨笔记混合检索（关键词 + 语义 + 精排，见 lib/notes/search.ts）
//   readNote     按 noteId 读整篇正文（超长截断）
//
// 为什么 M2 只给只读工具：写工具（proposeNoteEdit 等）需要配套的 diff 确认
// 与事务校验，属于 M3。这里先把「能查到、能读到」打通，权限边界只有一条：
// 所有查询都用 userId 过滤，越权 id 一律返回「不存在或无权访问」，不泄露存在性。
// ============================================================

import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { searchNotes } from "@/lib/notes/search";
import { safeExecute } from "./utils";

/** 单次 readNote 返回的正文上限（与 scene.ts 的注入上限一致） */
const READ_MAX_CHARS = 12000;

export function createNoteTools(userId: string) {
  const searchNotesTool = tool({
    description:
      "在用户的全部笔记里做关键词 + 语义混合检索。当问题涉及其他笔记、需要跨笔记汇总/对比，" +
      "或当前笔记里找不到依据时调用。可传 noteIds 限定范围，默认跨全部笔记。" +
      "返回的 sources 带有 index / noteId / title / heading / snippet。" +
      "引用时用 [n] 标注 index；信息够用就停止检索，不要反复换关键词。",

    inputSchema: z.object({
      query: z.string().min(1).describe("检索问题或关键词"),
      noteIds: z
        .array(z.string())
        .optional()
        .describe("只在指定笔记内检索；省略则跨全部笔记"),
      limit: z.number().optional().describe("返回来源条数，默认 5，最大 10"),
    }),

    execute: async ({ query, noteIds, limit }) =>
      safeExecute("searchNotes", async () => {
        const result = await searchNotes(query, userId, {
          noteIds,
          limit: Math.min(limit ?? 5, 10),
        });

        console.log(
          `[searchNotes] user=${userId} query="${query}" ` +
            `scope=${noteIds?.length ?? 0} → ${result.sources.length} 条`
        );

        if (result.sources.length === 0) {
          return {
            success: true as const,
            count: 0,
            query,
            sources: [],
            guidance:
              "没有检索到相关笔记。不要重复换关键词检索；直接说明没有找到，或请用户补充线索。",
          };
        }

        return {
          success: true as const,
          count: result.sources.length,
          query,
          sources: result.sources.map((source, index) => ({
            index: index + 1,
            noteId: source.noteId,
            title: source.title,
            heading: source.heading,
            snippet: source.snippet,
            score: Number(source.score.toFixed(4)),
          })),
          guidance:
            "引用来源时用 [n] 标注 index；回答末尾按「[标题](/notes/noteId)」列出用到的来源。" +
            "如果信息足够请直接回答，不要为同一问题连续检索。",
        };
      }),
  });

  const readNoteTool = tool({
    description:
      "按 noteId 读取一篇笔记的完整正文（过长会截断）。只在需要细读某篇来源时调用，" +
      "通常 noteId 来自 searchNotes 的 sources。",
    inputSchema: z.object({
      noteId: z.string().min(1).describe("笔记 id"),
    }),

    execute: async ({ noteId }) =>
      safeExecute("readNote", async () => {
        const note = await prisma.note.findFirst({
          where: { id: noteId, userId },
          select: { id: true, title: true, content: true, updatedAt: true },
        });
        if (!note) {
          return {
            success: false as const,
            error: "笔记不存在或无权访问",
          };
        }

        const truncated = note.content.length > READ_MAX_CHARS;
        console.log(
          `[readNote] user=${userId} note=${noteId} ` +
            `${truncated ? "截断" : "完整"} ${note.content.length} 字`
        );

        return {
          success: true as const,
          noteId: note.id,
          title: note.title,
          updatedAt: note.updatedAt.toISOString(),
          content: truncated
            ? `${note.content.slice(0, READ_MAX_CHARS)}\n\n[……正文过长，已截断]`
            : note.content,
          truncated,
        };
      }),
  });

  return { searchNotes: searchNotesTool, readNote: readNoteTool };
}
