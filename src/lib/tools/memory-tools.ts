// ============================================================
// Memory v2 工具实现
//
// createMemoryTools(userId, opts) 产出两个工具（由 tools/router.ts 注册）：
//   getMyMemories  只读查询长期记忆
//   remember       把用户**明确要求**记住的内容写成候选，交给 Manager 落库
//
// remember 刻意不走裸写库：createCandidate → markCandidate(ready) →
// commitCandidate，复用 0.92 更新 / 0.97 去重、normalizedKey 冲突兜底
// 与 MemoryEvent。候选的 messageId 用**当前用户消息 id**，天然幂等：
// 同一轮重复调用会拿到 created=false，直接提示模型不要重复。
// ============================================================

import { tool } from "ai";
import { z } from "zod";
import { embedText } from "@/lib/rag/client";
import {
  createCandidate,
  findMemoriesByIds,
  listActiveMemories,
  markCandidate,
  searchActiveMemoryIdsByVector,
} from "@/lib/memory/store";
import { commitCandidate } from "@/lib/memory/manager";
import { touchToolRead } from "@/lib/memory/access";
import { isQueryWorthEmbedding } from "@/lib/memory/retrieval";
import {
  normalizeMemoryContent,
  normalizeNormalizedKey,
  clampScore,
  evidenceMatchesUserMessages,
} from "@/lib/memory/validation";
import {
  MEMORY_KINDS,
  MEMORY_LIMITS,
  type MemoryKind,
  type MemoryOperation,
  type MemoryRecord,
} from "@/lib/memory/types";
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

export interface MemoryToolsOptions {
  /** 当前对话 id：写进候选 / 事件，便于回溯来源 */
  conversationId?: string | null;
  /** 当前用户消息 id：候选的幂等键（messageId 唯一） */
  messageId?: string | null;
  /** 本轮用户原话：evidence 必须是它的子串 */
  currentUserText?: string | null;
}

/**
 * 创建针对特定用户的长期记忆工具集。
 *
 * opts 只在 remember 写入候选时必须：conversationId + messageId 定位来源，
 * currentUserText 用于校验 evidence 确实是用户原话。缺任何一项时 remember
 * 会安全降级（不写库，提示模型改为直接询问用户）。
 */
export function createMemoryTools(
  userId: string,
  opts: MemoryToolsOptions = {}
) {
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

  const remember = tool({
    description:
      "把用户**明确要求**记住的内容写入长期记忆（如「记住…」「记一下…」「以后都按这个来」）。" +
      "只在用户主动要求时调用；不要主动把每条对话都固化成记忆。" +
      "content 要写成一句独立、可复用的事实或偏好；evidence 必须逐字摘录用户原话。" +
      "一次最多 3 条。写入后简要告诉用户记住了什么，不要重复调用同一内容。",

    inputSchema: z.object({
      memories: z
        .array(
          z.object({
            kind: z.enum(MEMORY_KINDS).describe("记忆类型"),
            content: z
              .string()
              .describe(`要记住的内容，一句独立陈述，不超过 ${MEMORY_LIMITS.contentMaxChars} 字`),
            evidence: z
              .string()
              .describe("用户原话摘录，必须是本轮用户消息里逐字出现的片段"),
            importance: z.number().optional().describe("重要度 0~1，默认 0.7"),
            confidence: z.number().optional().describe("置信度 0~1，默认 0.9"),
            normalizedKey: z
              .string()
              .optional()
              .describe("可选去重键，如 skill:react（小写，仅 a-z0-9:_-.)"),
          })
        )
        .min(1)
        .max(MEMORY_LIMITS.maxOperationsPerTurn)
        .describe("要写入的记忆，1~3 条"),
    }),

    execute: async ({ memories }) =>
      safeExecute("remember", async () => {
        const conversationId = opts.conversationId ?? null;
        const messageId = opts.messageId ?? null;
        const userText = opts.currentUserText?.trim() ?? "";

        // 安全降级：没有来源定位就不写库。否则会造出一条无法追溯的候选。
        if (!conversationId || !messageId || !userText) {
          return {
            success: false as const,
            error:
              "当前场景无法写入长期记忆。请直接把要记住的内容告诉用户，或请用户再明确说一次。",
          };
        }

        const operations: MemoryOperation[] = [];
        const problems: string[] = [];

        for (const item of memories) {
          const content = normalizeMemoryContent(item.content);
          if ("error" in content) {
            problems.push(`内容不合法(${content.error})`);
            continue;
          }

          const evidence = item.evidence.trim();
          if (!evidenceMatchesUserMessages(evidence, [userText])) {
            problems.push(`evidence 不是用户原话：「${evidence.slice(0, 30)}」`);
            continue;
          }

          operations.push({
            op: "ADD",
            kind: item.kind,
            content: content.value,
            normalizedKey: normalizeNormalizedKey(item.normalizedKey),
            importance: clampScore(item.importance, 0.7),
            confidence: clampScore(item.confidence, 0.9),
            validFrom: null,
            validTo: null,
            evidence: evidence.slice(0, MEMORY_LIMITS.evidenceMaxChars),
            sourceType: "note",
          });
        }

        if (problems.length > 0) {
          return {
            success: false as const,
            error: `没有写入任何记忆：${problems.join("；")}`,
          };
        }

        const { created, candidateId } = await createCandidate({
          userId,
          conversationId,
          messageId,
        });
        if (!created || !candidateId) {
          return {
            success: false as const,
            error: "本轮已经记录过记忆了，不要重复调用。直接用一句话确认即可。",
          };
        }

        await markCandidate(candidateId, {
          status: "ready",
          operations,
          processedAt: new Date(),
        });
        await commitCandidate(candidateId);

        console.log(
          `[remember] user=${userId} conversation=${conversationId} → ${operations.length} 条`
        );

        return {
          success: true as const,
          count: operations.length,
          guidance:
            "已记录到长期记忆。用一句话告诉用户你记住了什么，不要重复调用本工具。",
        };
      }),
  });

  return { getMyMemories, remember };
}
