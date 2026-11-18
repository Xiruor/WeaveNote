// ============================================================
// 笔记工具（M2 → M3）
//
// createNoteTools(userId, opts) 产出六个笔记工具：
//   只读：searchNotes（跨笔记混合检索）/ readNote（读整篇）/ listNotes（列笔记）
//         summarizeNote（服务端读正文返回摘要，不落库）
//   写：  createNote（直接新建）/ proposeNoteEdit（写 NoteProposal，需用户确认）
//
// M2 只有 searchNotes / readNote 两个只读工具；M3 补上其余四个，其中
// proposeNoteEdit 是 diff 确认链路的核心：它只把提案落库、返回 proposalId，
// 绝不直接改笔记正文——正文改动必须等用户在编辑器内联 diff 上点「应用」，由
// apply 接口在事务里校验 baseHash 后才落库。
//
// 权限边界只有一条：所有查询/写入都用 userId 过滤，越权 id 一律返回
// 「不存在或无权访问」，不泄露存在性。
// ============================================================

import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { searchNotes } from "@/lib/notes/search";
import { contentHash } from "@/lib/notes/index-note";
import { completionsWithFallback } from "@/lib/model-pool";
import { safeExecute } from "./utils";

/** 单次 readNote 返回的正文上限（与 scene.ts 的注入上限一致） */
const READ_MAX_CHARS = 12000;
/** summarizeNote 送入模型的正文上限（摘要不需要整篇，控成本） */
const SUMMARIZE_MAX_CHARS = 8000;
/** 笔记标题上限（与 api/notes 的 NOTE_TITLE_MAX 一致） */
const NOTE_TITLE_MAX = 120;

export interface NoteToolsOptions {
  /**
   * note 场景的当前笔记 id：proposeNoteEdit 未显式给 noteId 时默认改它。
   * workspace 场景为 null，proposeNoteEdit 必须显式给 noteId。
   */
  noteId?: string | null;
  /** 当前对话 id：proposeNoteEdit 落库时记在提案上，便于回溯来源 */
  conversationId?: string | null;
}

export function createNoteTools(userId: string, opts: NoteToolsOptions = {}) {
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

  const listNotesTool = tool({
    description:
      "列出用户的笔记（可选按文件夹筛选），返回 id / title / updatedAt，按置顶与最近更新排序。" +
      "需要知道用户有哪些笔记、或找某篇笔记的 id 时调用。",
    inputSchema: z.object({
      folderId: z.string().optional().describe("按文件夹 id 筛选；省略则列出全部"),
      limit: z.number().optional().describe("返回条数，默认 20，最大 50"),
    }),

    execute: async ({ folderId, limit }) =>
      safeExecute("listNotes", async () => {
        const notes = await prisma.note.findMany({
          where: {
            userId,
            ...(folderId ? { folderId } : {}),
          },
          orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
          take: Math.min(limit ?? 20, 50),
          select: { id: true, title: true, folderId: true, updatedAt: true },
        });

        return {
          success: true as const,
          count: notes.length,
          notes: notes.map((note) => ({
            noteId: note.id,
            title: note.title,
            folderId: note.folderId,
            updatedAt: note.updatedAt.toISOString(),
          })),
          guidance: "这是用户的笔记列表；要细读某篇用 readNote，要检索内容用 searchNotes。",
        };
      }),
  });

  const summarizeNoteTool = tool({
    description:
      "按 noteId 在服务端读取一篇笔记并生成摘要（不修改笔记）。需要快速了解某篇笔记讲了什么时调用，" +
      "比 readNote 更省上下文（返回的是摘要而非整篇正文）。",
    inputSchema: z.object({
      noteId: z.string().min(1).describe("要摘要的笔记 id"),
    }),

    execute: async ({ noteId }) =>
      safeExecute("summarizeNote", async () => {
        const note = await prisma.note.findFirst({
          where: { id: noteId, userId },
          select: { title: true, content: true },
        });
        if (!note) {
          return { success: false as const, error: "笔记不存在或无权访问" };
        }

        if (!note.content.trim()) {
          return {
            success: true as const,
            noteId,
            title: note.title,
            summary: "（这篇笔记还是空的）",
          };
        }

        const body = note.content.slice(0, SUMMARIZE_MAX_CHARS);
        const { data } = await completionsWithFallback(
          "low",
          (entry, client, extraBody) =>
            client.chat.completions.create({
              model: entry.modelName,
              messages: [
                {
                  role: "system",
                  content:
                    "你是笔记摘要助手。用中文简洁概括用户给出的笔记正文，保留关键结论、要点与结构，不要编造正文里没有的内容。",
                },
                {
                  role: "user",
                  content: `标题：${note.title}\n\n正文：\n${body}`,
                },
              ],
              temperature: 0.3,
              ...extraBody,
            }),
          { userId, surface: "note" }
        );

        const summary = data.choices[0]?.message?.content?.trim() ?? "";
        console.log(`[summarizeNote] user=${userId} note=${noteId} → ${summary.length} 字摘要`);

        return {
          success: true as const,
          noteId,
          title: note.title,
          summary: summary || "（摘要生成失败，可改用 readNote 读取原文）",
        };
      }),
  });

  const createNoteTool = tool({
    description:
      "新建一篇笔记（直接落库）。用户明确要求「新建/创建一篇笔记」时调用。" +
      "返回 noteId 与 /notes/<id> 链接。",
    inputSchema: z.object({
      title: z.string().min(1).max(NOTE_TITLE_MAX).describe("笔记标题"),
      content: z.string().optional().describe("Markdown 正文，可留空"),
      folderId: z.string().optional().describe("所属文件夹 id，可省略"),
    }),

    execute: async ({ title, content, folderId }) =>
      safeExecute("createNote", async () => {
        let validFolderId: string | null = null;
        if (folderId) {
          const folder = await prisma.folder.findFirst({
            where: { id: folderId, userId },
            select: { id: true },
          });
          if (!folder) {
            return { success: false as const, error: "文件夹不存在或无权访问" };
          }
          validFolderId = folder.id;
        }

        const note = await prisma.note.create({
          data: {
            userId,
            title: title.trim(),
            content: content ?? "",
            folderId: validFolderId,
          },
          select: { id: true, title: true },
        });

        console.log(`[createNote] user=${userId} note=${note.id} "${note.title}"`);
        return {
          success: true as const,
          noteId: note.id,
          title: note.title,
          link: `/notes/${note.id}`,
          guidance: "已新建笔记。告诉用户已经建好，并给出 /notes/<id> 链接。",
        };
      }),
  });

  const proposeNoteEditTool = tool({
    description:
      "提出对一篇笔记的修改提案（不直接改正文）。用户明确要求「修改/整理/改写某篇笔记」时调用。" +
      "它会生成一份 diff 给用户确认，用户确认前正文不会变。" +
      "调用后必须等待用户确认，不要重复调用，也不要在用户未确认时声称「已修改」。",
    inputSchema: z.object({
      noteId: z.string().optional().describe("要修改的笔记 id；省略则改当前笔记"),
      newTitle: z.string().max(NOTE_TITLE_MAX).optional().describe("新的标题（可选，不传则标题不变）"),
      newContent: z.string().min(1).describe("修改后的完整正文（Markdown）"),
      reason: z.string().optional().describe("一句话说明改了什么"),
    }),

    execute: async ({ noteId, newTitle, newContent, reason }) =>
      safeExecute("proposeNoteEdit", async () => {
        const targetId = (noteId ?? opts.noteId)?.trim();
        if (!targetId) {
          return { success: false as const, error: "未指定要修改的笔记 id" };
        }

        const note = await prisma.note.findFirst({
          where: { id: targetId, userId },
          select: { id: true, content: true },
        });
        if (!note) {
          return { success: false as const, error: "笔记不存在或无权访问" };
        }

        const proposal = await prisma.noteProposal.create({
          data: {
            userId,
            noteId: targetId,
            conversationId: opts.conversationId ?? null,
            newTitle: newTitle?.trim() || null,
            newContent,
            baseHash: contentHash(note.content),
            reason: reason?.trim() || null,
            status: "pending",
          },
          select: { id: true },
        });

        console.log(
          `[proposeNoteEdit] user=${userId} note=${targetId} proposal=${proposal.id}`
        );
        return {
          success: true as const,
          proposalId: proposal.id,
          status: "pending",
          guidance:
            "已生成修改提案，等待用户在面板上确认（应用 / 放弃）。不要重复调用本工具，也不要声称已经修改了笔记。",
        };
      }),
  });

  return {
    searchNotes: searchNotesTool,
    readNote: readNoteTool,
    listNotes: listNotesTool,
    summarizeNote: summarizeNoteTool,
    createNote: createNoteTool,
    proposeNoteEdit: proposeNoteEditTool,
  };
}
