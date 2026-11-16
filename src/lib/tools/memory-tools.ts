// ============================================================
// Memory v2 读工具实现
//
// createMemoryTools(userId) 产出 getMyMemories 工具（AI SDK tool），
// 由 tools/router.ts 注册进各 AI 场景；recallMemories 负责查询与
// 访问信号，方便单测与复用。
//
// 工具是只读的：不提供 ADD/UPDATE/DELETE。
// 记忆写入只能走抽取 → Manager，避免模型无约束改库。
// ============================================================

import { tool } from "ai";
import { z } from "zod";
import { embedText } from "@/lib/rag/client";
import {
  findMemoriesByIds,
  listActiveMemories,
  searchActiveMemoryIdsByVector,
} from "@/lib/memory/store";
import { touchToolRead } from "@/lib/memory/access";
import { isQueryWorthEmbedding } from "@/lib/memory/retrieval";
import { MEMORY_KINDS, type MemoryKind, type MemoryRecord } from "@/lib/memory/types";
import { safeExecute } from "./utils";

export interface RecallMemoriesInput {
  query?: string;
  kinds?: MemoryKind[];
  limit?: number;
}

export interface RecallMemoriesResult {
  success: true;
  count: number;
  query: string;
  kinds: MemoryKind[] | null;
  limit: number;
  hasMore: boolean;
  /** 给模型的停止提示：信息够用就不要再换关键词重复查 */
  guidance: string;
  memories: Array<{
    id: string;
    kind: MemoryKind;
    content: string;
    importance: number;
    confidence: number;
    updatedAt: string;
    sourceType: string;
    sourceMessageId: string | null;
    similarity?: number;
  }>;
  message?: string;
}

function toView(memory: MemoryRecord, similarity?: number) {
  return {
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    importance: memory.importance,
    confidence: memory.confidence,
    updatedAt: memory.updatedAt.toISOString(),
    sourceType: memory.sourceType,
    sourceMessageId: memory.sourceMessageId,
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

export async function recallMemories(
  userId: string,
  input: RecallMemoriesInput = {}
): Promise<RecallMemoriesResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
  const kinds = input.kinds?.length ? new Set(input.kinds) : null;
  const query = input.query?.trim() ?? "";

  let memories: MemoryRecord[] = [];
  let similarityById: Map<string, number> | undefined;

  if (isQueryWorthEmbedding(query)) {
    const embedding = await embedText(query);
    const hits = await searchActiveMemoryIdsByVector(userId, embedding, 30);
    if (hits.length > 0) {
      memories = await findMemoriesByIds(
        hits.map((hit) => hit.id),
        userId
      );
      similarityById = new Map(hits.map((hit) => [hit.id, hit.similarity]));
    }
  } else {
    // 无 query / 短 query：返回按重要度排序的 active 记忆
    const all = await listActiveMemories(userId);
    memories = all.sort(
      (a, b) =>
        b.importance - a.importance || b.updatedAt.getTime() - a.updatedAt.getTime()
    );
  }

  if (kinds) {
    memories = memories.filter((m) => kinds.has(m.kind));
  }
  const matched = memories.length;
  const hasMore = matched > limit;
  memories = memories.slice(0, limit);

  const ids = memories.map((m) => m.id);
  void touchToolRead(ids);

  const guidance =
    memories.length === 0
      ? "没有匹配的长期记忆。不要重复换关键词查询；直接根据当前对话回答，或说明你没有这条记录。"
      : hasMore
        ? `已返回最相关的 ${memories.length} 条；如果信息足够请直接回答，不要为同一问题连续换词重复查询。`
        : "已返回全部匹配的记忆；如果信息足够请直接回答，不要重复查询。";

  return {
    success: true,
    count: memories.length,
    query,
    kinds: input.kinds ?? null,
    limit,
    hasMore,
    guidance,
    memories: memories.map((m) => toView(m, similarityById?.get(m.id))),
    ...(memories.length === 0
      ? { message: "我目前还没有关于你的长期记忆。多和我聊聊吧！" }
      : {}),
  };
}

/**
 * 创建针对特定用户的长期记忆读工具集（自原 study-tools.ts 的 getMyMemories 迁入）。
 *
 * 每个会话轮次新建一次工厂，闭包内的调用计数与缓存只在**同一轮**生效：
 * 同一轮最多做 2 次不同的记忆查询，完全相同的查询直接复用结果。
 */
export function createMemoryTools(userId: string) {
  /** 同一轮最多做 2 次不同的记忆查询；完全相同的查询直接复用结果。 */
  let memoryRecallCalls = 0;
  const memoryRecallCache = new Map<
    string,
    Awaited<ReturnType<typeof recallMemories>>
  >();

  const getMyMemories = tool({
    description:
      "查询 AI 对用户的长期记忆（目标、技能、薄弱点、偏好、习惯、背景）。" +
      "系统每轮已自动注入 <memory_context>，先检查那里；只有确实缺少信息时才调用本工具。" +
      "传 query 按语义搜索，传 kinds 按类型筛选，可一次同时传。只读，不会修改记忆。" +
      "一次查询尽量覆盖需求，不要重复换关键词；同一轮最多做 2 次不同查询。",

    inputSchema: z.object({
      limit: z.number().optional().describe("返回条数，默认 10，最大 20"),
      query: z.string().optional().describe("语义搜索关键词，如'React'"),
      kinds: z
        .array(z.enum(MEMORY_KINDS))
        .optional()
        .describe("按记忆类型筛选，如 ['skill', 'goal']"),
    }),

    execute: async ({ limit = 10, query, kinds }) => {
      const cacheKey = JSON.stringify({
        query: query ?? "",
        kinds: [...(kinds ?? [])].sort(),
        limit,
      });

      const cached = memoryRecallCache.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          guidance: `${cached.guidance}（本轮已经查过完全相同的条件，直接使用上面的结果。）`,
        };
      }

      if (memoryRecallCalls >= 2) {
        return {
          success: false as const,
          error:
            "同一轮最多查询 2 次不同的长期记忆条件。请基于已返回的结果回答，不要继续换关键词查询。",
        };
      }
      memoryRecallCalls++;

      const result = await safeExecute("getMyMemories", async () => {
        console.log(
          `[getMyMemories] 查询用户 ${userId} 的记忆, query: ${query || "(无)"}, kinds: ${kinds?.join(",") || "(全部)"}`
        );
        const recalled = await recallMemories(userId, { limit, query, kinds });
        console.log(`[getMyMemories] ✅ 返回 ${recalled.count} 条记忆`);
        return recalled;
      });

      if ("count" in result) {
        memoryRecallCache.set(
          cacheKey,
          result as Awaited<ReturnType<typeof recallMemories>>
        );
      }
      return result;
    },
  });

  return { getMyMemories };
}
