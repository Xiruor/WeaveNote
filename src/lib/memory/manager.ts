// ============================================================
// Memory v2 Manager：服务端唯一写入者
//
// 职责：
//   · 把候选操作变成真正的数据库变更
//   · 冲突兜底：normalizedKey / 向量相似度
//   · 所有变更写 MemoryEvent，保留 before/after
//   · 同一用户的提交串行化（advisory lock）
//
// 不负责：抽取、门控、检索、上下文渲染。
// ============================================================

import { embeddingWithFallback } from "@/lib/model-pool";
import type { Prisma } from "@prisma-generated/client";
import {
  findActiveByKey,
  findCandidateById,
  findMemoryById,
  findMostSimilarActiveMemory,
  insertMemory,
  insertMemoryEvent,
  markCandidate,
  setMemoryEmbedding,
  softDeleteMemory,
  supersedeMemory,
  withUserMemoryLock,
  type InsertMemoryInput,
} from "./store";
import type {
  MemoryDraft,
  MemoryKind,
  MemoryOperation,
  MemoryRecord,
  MemorySourceType,
} from "./types";

/** 向量相似度阈值：同 kind 且足够像时，ADD 自动降级为重复/更新。 */
const SIMILAR_UPDATE_THRESHOLD = 0.92;
const SIMILAR_NOOP_THRESHOLD = 0.97;

interface PreparedOperation {
  operation: MemoryOperation;
  embedding: number[] | null;
  embeddingModel: string | null;
}

interface CandidateRow {
  userId: string;
  messageId: string;
  conversationId: string | null;
}

function summary(m: MemoryRecord) {
  return {
    id: m.id,
    kind: m.kind,
    content: m.content,
    status: m.status,
    importance: m.importance,
    confidence: m.confidence,
    // Prisma 的 JSON 字段不接受 Date，统一转 ISO 字符串
    validFrom: m.validFrom?.toISOString() ?? null,
    validTo: m.validTo?.toISOString() ?? null,
  };
}

function draftDates(draft: MemoryDraft): {
  validFrom: Date | null;
  validTo: Date | null;
} {
  return {
    validFrom: draft.validFrom ? new Date(draft.validFrom) : null,
    validTo: draft.validTo ? new Date(draft.validTo) : null,
  };
}

function parseStoredOperations(raw: unknown): MemoryOperation[] {
  if (!raw) return [];
  const value =
    typeof raw === "string" ? (JSON.parse(raw) as unknown) : (raw as unknown);
  return Array.isArray(value) ? (value as MemoryOperation[]) : [];
}

async function embedMemory(
  content: string
): Promise<{ embedding: number[] | null; embeddingModel: string | null }> {
  try {
    const { data, model } = await embeddingWithFallback(content);
    return { embedding: data[0] ?? null, embeddingModel: model };
  } catch (error) {
    console.warn("[Memory] 生成 embedding 失败，先以无向量写入:", error);
    return { embedding: null, embeddingModel: null };
  }
}

/** 预生成向量：网络调用不能发生在数据库事务里，否则会长时间持锁。 */
async function prepareOperations(
  operations: MemoryOperation[]
): Promise<PreparedOperation[]> {
  const prepared: PreparedOperation[] = [];
  for (const operation of operations) {
    if (operation.op === "ADD" || operation.op === "UPDATE") {
      const { embedding, embeddingModel } = await embedMemory(operation.content);
      prepared.push({ operation, embedding, embeddingModel });
    } else {
      prepared.push({ operation, embedding: null, embeddingModel: null });
    }
  }
  return prepared;
}

function buildInsertInput(
  candidate: CandidateRow,
  draft: MemoryDraft,
  sourceType: MemorySourceType,
  supersedesId: string | null,
  prepared: PreparedOperation
): InsertMemoryInput {
  const dates = draftDates(draft);
  return {
    userId: candidate.userId,
    kind: draft.kind,
    content: draft.content,
    normalizedKey: draft.normalizedKey ?? null,
    importance: draft.importance,
    confidence: draft.confidence,
    validFrom: dates.validFrom,
    validTo: dates.validTo,
    sourceType,
    sourceConversationId: candidate.conversationId,
    sourceMessageId: candidate.messageId,
    supersedesId,
    embedding: prepared.embedding,
    embeddingModel: prepared.embeddingModel,
  };
}

async function logOp(
  tx: Prisma.TransactionClient,
  candidate: CandidateRow,
  action: string,
  options: {
    memoryId?: string | null;
    before?: unknown;
    after?: unknown;
    evidence?: string | null;
  }
): Promise<void> {
  await insertMemoryEvent(tx, {
    userId: candidate.userId,
    memoryId: options.memoryId ?? null,
    action,
    actor: "extractor",
    before: options.before,
    after: options.after,
    evidence: options.evidence ?? null,
    sourceConversationId: candidate.conversationId,
    sourceMessageId: candidate.messageId,
  });
}

async function applyUpdate(
  tx: Prisma.TransactionClient,
  candidate: CandidateRow,
  old: MemoryRecord,
  draft: MemoryDraft,
  evidence: string,
  sourceType: MemorySourceType,
  prepared: PreparedOperation
): Promise<void> {
  if (old.content === draft.content) {
    await logOp(tx, candidate, "noop", {
      memoryId: old.id,
      evidence,
      after: { reason: "duplicate_content" },
    });
    return;
  }

  // 新内容带着 normalizedKey 时，可能和另一条 active 记忆撞键。
  // 先把它也 supersede 掉，否则部分唯一索引会让整个事务失败。
  if (draft.normalizedKey) {
    const conflict = await findActiveByKey(
      candidate.userId,
      draft.normalizedKey,
      tx
    );
    if (conflict && conflict.id !== old.id) {
      await supersedeMemory(tx, conflict.id, candidate.userId);
      await logOp(tx, candidate, "supersede", {
        memoryId: conflict.id,
        before: summary(conflict),
        evidence,
        after: { reason: "normalized_key_conflict" },
      });
    }
  }

  await supersedeMemory(tx, old.id, candidate.userId);
  const newId = await insertMemory(
    tx,
    buildInsertInput(candidate, draft, sourceType, old.id, prepared)
  );

  await logOp(tx, candidate, "supersede", {
    memoryId: newId,
    before: summary(old),
    after: { ...draft, id: newId, supersedesId: old.id },
    evidence,
  });
}

async function applyAdd(
  tx: Prisma.TransactionClient,
  candidate: CandidateRow,
  operation: Extract<MemoryOperation, { op: "ADD" }>,
  prepared: PreparedOperation
): Promise<void> {
  // 1) 精确键冲突
  if (operation.normalizedKey) {
    const existing = await findActiveByKey(
      candidate.userId,
      operation.normalizedKey,
      tx
    );
    if (existing) {
      await applyUpdate(
        tx,
        candidate,
        existing,
        operation,
        operation.evidence,
        "user_correction",
        prepared
      );
      return;
    }
  }

  // 2) 向量相似兜底
  if (prepared.embedding) {
    const similar = await findMostSimilarActiveMemory(
      candidate.userId,
      prepared.embedding,
      operation.kind,
      tx
    );
    if (similar && similar.similarity >= SIMILAR_NOOP_THRESHOLD) {
      await logOp(tx, candidate, "noop", {
        memoryId: similar.id,
        evidence: operation.evidence,
        after: { reason: "semantic_duplicate", similarity: similar.similarity },
      });
      return;
    }
    if (similar && similar.similarity >= SIMILAR_UPDATE_THRESHOLD) {
      const existing = await findMemoryById(similar.id, candidate.userId, tx);
      if (existing && existing.status === "active") {
        await applyUpdate(
          tx,
          candidate,
          existing,
          operation,
          operation.evidence,
          "user_correction",
          prepared
        );
        return;
      }
    }
  }

  // 3) 新建
  const id = await insertMemory(
    tx,
    buildInsertInput(
      candidate,
      operation,
      operation.sourceType,
      null,
      prepared
    )
  );
  await logOp(tx, candidate, "add", {
    memoryId: id,
    after: { ...operation, id },
    evidence: operation.evidence,
  });
}

async function applyOperation(
  tx: Prisma.TransactionClient,
  candidate: CandidateRow,
  prepared: PreparedOperation
): Promise<void> {
  const operation = prepared.operation;

  if (operation.op === "NOOP") {
    await logOp(tx, candidate, "noop", {
      after: { reason: operation.reason ?? "model_noop" },
    });
    return;
  }

  if (operation.op === "DELETE") {
    const target = await findMemoryById(operation.targetId, candidate.userId, tx);
    if (!target || target.status !== "active") {
      await logOp(tx, candidate, "noop", {
        memoryId: operation.targetId,
        evidence: operation.evidence,
        after: { reason: "target_not_active" },
      });
      return;
    }
    await softDeleteMemory(tx, operation.targetId, candidate.userId);
    await logOp(tx, candidate, "delete", {
      memoryId: operation.targetId,
      before: summary(target),
      evidence: operation.evidence,
    });
    return;
  }

  if (operation.op === "UPDATE") {
    const target = await findMemoryById(operation.targetId, candidate.userId, tx);
    if (!target || target.status !== "active") {
      await logOp(tx, candidate, "noop", {
        memoryId: operation.targetId,
        evidence: operation.evidence,
        after: { reason: "target_not_active" },
      });
      return;
    }
    await applyUpdate(
      tx,
      candidate,
      target,
      operation,
      operation.evidence,
      "user_correction",
      prepared
    );
    return;
  }

  await applyAdd(tx, candidate, operation, prepared);
}

/**
 * 提交一个候选批次。
 *
 * 幂等：只处理 ready/running 的候选；done/noop 直接返回。
 * 原子性：所有变更 + candidate.status=done 在同一个事务里。
 */
export async function commitCandidate(candidateId: string): Promise<void> {
  const candidate = await findCandidateById(candidateId);
  if (!candidate) return;
  if (candidate.status === "done" || candidate.status === "noop") return;
  if (candidate.status !== "ready" && candidate.status !== "running") return;

  const operations = parseStoredOperations(candidate.operations);
  if (operations.length === 0) {
    await markCandidate(candidateId, {
      status: "noop",
      processedAt: new Date(),
    });
    return;
  }

  const prepared = await prepareOperations(operations);

  await withUserMemoryLock(candidate.userId, async (tx) => {
    const row: CandidateRow = {
      userId: candidate.userId,
      messageId: candidate.messageId,
      conversationId: candidate.conversationId,
    };
    for (const item of prepared) {
      await applyOperation(tx, row, item);
    }
    await markCandidate(
      candidateId,
      { status: "done", processedAt: new Date() },
      tx
    );
  });
}

/** 供测试与调试使用的最小导出。 */
export const MEMORY_SIMILARITY_THRESHOLDS = {
  update: SIMILAR_UPDATE_THRESHOLD,
  noop: SIMILAR_NOOP_THRESHOLD,
} as const;

// ============================================================
// 用户手动编辑（M4 记忆管理页）
//
// 与抽取链路分开：这里没有候选、没有 evidence 校验，入参已在 API 层
// 用 normalizeMemoryContent / clampScore 收口。仍然遵守两条铁律：
//   · 只有 Manager 写库（事务 + advisory lock）；
//   · 任何变更都写 MemoryEvent（actor=user）。
//
// sourceType 决策：**保留原值**，不改成 user_edit。追溯「这条记忆最初从
// 哪来」比「它被手改过」更有价值；手动修改这件事由 MemoryEvent 的
// actor=user 记录。
// ============================================================

export interface UpdateMemoryByUserInput {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
}

export type UpdateMemoryByUserResult =
  | { ok: true; memory: MemoryRecord }
  | { ok: false; reason: "not_found" | "no_change" };

export async function updateMemoryByUser(
  userId: string,
  memoryId: string,
  patch: UpdateMemoryByUserInput
): Promise<UpdateMemoryByUserResult> {
  const before = await findMemoryById(memoryId, userId);
  if (!before || before.status !== "active") {
    return { ok: false, reason: "not_found" };
  }

  const content =
    patch.content !== undefined && patch.content !== before.content
      ? patch.content
      : undefined;
  const kind =
    patch.kind !== undefined && patch.kind !== before.kind
      ? patch.kind
      : undefined;
  const importance =
    patch.importance !== undefined && patch.importance !== before.importance
      ? patch.importance
      : undefined;

  if (content === undefined && kind === undefined && importance === undefined) {
    return { ok: false, reason: "no_change" };
  }

  // 网络调用不能发生在事务里，否则会长时间持有 advisory lock。
  const prepared = content
    ? await embedMemory(content)
    : { embedding: null, embeddingModel: null };

  const updated = await withUserMemoryLock(userId, async (tx) => {
    const current = await findMemoryById(memoryId, userId, tx);
    if (!current || current.status !== "active") return null;

    // 键冲突兜底：正常不会发生（同键只能有一条 active），但数据异常时
    // 直接更新会撞部分唯一索引，让整笔事务失败。
    if (content !== undefined && current.normalizedKey) {
      const conflict = await findActiveByKey(
        userId,
        current.normalizedKey,
        tx
      );
      if (conflict && conflict.id !== current.id) {
        await supersedeMemory(tx, conflict.id, userId);
        await insertMemoryEvent(tx, {
          userId,
          memoryId: conflict.id,
          action: "supersede",
          actor: "user",
          before: summary(conflict),
          after: { reason: "normalized_key_conflict" },
        });
      }
    }

    await tx.memory.updateMany({
      where: { id: memoryId, userId, status: "active" },
      data: {
        ...(content !== undefined ? { content } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(importance !== undefined ? { importance } : {}),
        lastConfirmedAt: new Date(),
      },
    });

    if (prepared.embedding) {
      await setMemoryEmbedding(
        tx,
        memoryId,
        userId,
        prepared.embedding,
        prepared.embeddingModel
      );
    }

    const after = await findMemoryById(memoryId, userId, tx);
    if (after) {
      await insertMemoryEvent(tx, {
        userId,
        memoryId,
        action: "update",
        actor: "user",
        before: summary(current),
        after: summary(after),
      });
    }
    return after;
  });

  if (!updated) return { ok: false, reason: "not_found" };
  return { ok: true, memory: updated };
}

/** 用户手动删除（软删）。返回 false 表示不存在 / 无权访问 / 已删除。 */
export async function deleteMemoryByUser(
  userId: string,
  memoryId: string
): Promise<boolean> {
  return withUserMemoryLock(userId, async (tx) => {
    const target = await findMemoryById(memoryId, userId, tx);
    if (!target || target.status === "deleted") return false;

    await softDeleteMemory(tx, memoryId, userId);
    await insertMemoryEvent(tx, {
      userId,
      memoryId,
      action: "delete",
      actor: "user",
      before: summary(target),
    });
    return true;
  });
}

export type { MemoryKind };
