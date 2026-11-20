import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/model-pool", () => ({
  embeddingWithFallback: vi.fn(async () => ({
    data: [[0.1, 0.2, 0.3]],
    model: "test-embedding",
  })),
}));

vi.mock("@/lib/memory/store", () => ({
  findActiveByKey: vi.fn(),
  findCandidateById: vi.fn(),
  findMemoryById: vi.fn(),
  findMostSimilarActiveMemory: vi.fn(),
  insertMemory: vi.fn(),
  insertMemoryEvent: vi.fn(),
  markCandidate: vi.fn(),
  setMemoryEmbedding: vi.fn(),
  softDeleteMemory: vi.fn(),
  supersedeMemory: vi.fn(),
  withUserMemoryLock: vi.fn(),
}));

import {
  commitCandidate,
  deleteMemoryByUser,
  updateMemoryByUser,
} from "@/lib/memory/manager";
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
} from "@/lib/memory/store";
import type { MemoryOperation, MemoryRecord } from "@/lib/memory/types";

const mockFindCandidate = vi.mocked(findCandidateById);
const mockFindActiveByKey = vi.mocked(findActiveByKey);
const mockFindById = vi.mocked(findMemoryById);
const mockFindSimilar = vi.mocked(findMostSimilarActiveMemory);
const mockInsert = vi.mocked(insertMemory);
const mockEvent = vi.mocked(insertMemoryEvent);
const mockMark = vi.mocked(markCandidate);
const mockSoftDelete = vi.mocked(softDeleteMemory);
const mockSupersede = vi.mocked(supersedeMemory);
const mockLock = vi.mocked(withUserMemoryLock);
const mockSetEmbedding = vi.mocked(setMemoryEmbedding);

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    userId: "u1",
    legacyId: null,
    kind: "skill",
    content: "Vue 熟练",
    normalizedKey: "skill:frontend",
    status: "active",
    importance: 0.7,
    confidence: 0.9,
    validFrom: null,
    validTo: null,
    lastConfirmedAt: new Date("2026-01-01"),
    lastRetrievedAt: null,
    lastInjectedAt: null,
    injectedCount: 0,
    toolReadCount: 0,
    supersedesId: null,
    sourceType: "user_statement",
    sourceConversationId: null,
    sourceMessageId: null,
    embeddingModel: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    deletedAt: null,
    ...overrides,
  };
}

function candidate(operations: MemoryOperation[]) {
  return {
    id: "c1",
    userId: "u1",
    conversationId: "conv1",
    messageId: "msg1",
    status: "ready",
    attempts: 1,
    model: "test",
    rawOutput: null,
    operations,
    error: null,
    createdAt: new Date(),
    processedAt: null,
  };
}

const addOperation: MemoryOperation = {
  op: "ADD",
  kind: "skill",
  content: "React 熟练",
  normalizedKey: "skill:frontend",
  importance: 0.7,
  confidence: 0.9,
  validFrom: null,
  validTo: null,
  evidence: "我现在主要使用 React",
  sourceType: "user_statement",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLock.mockImplementation(async (_userId, fn) => fn({} as never));
  mockInsert.mockResolvedValue("new-id");
  mockSupersede.mockResolvedValue(1);
  mockSoftDelete.mockResolvedValue(1);
  mockEvent.mockResolvedValue(undefined);
  mockMark.mockResolvedValue(undefined);
  mockFindActiveByKey.mockResolvedValue(null);
  mockFindSimilar.mockResolvedValue(null);
});

describe("commitCandidate", () => {
  it("无冲突 ADD → 新建并写 add 事件", async () => {
    mockFindCandidate.mockResolvedValue(candidate([addOperation]) as never);

    await commitCandidate("c1");

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsert.mock.calls[0][1]).toMatchObject({
      content: "React 熟练",
      supersedesId: null,
      sourceType: "user_statement",
    });
    expect(mockEvent.mock.calls[0][1]).toMatchObject({ action: "add" });
    expect(mockMark).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ status: "done" }),
      expect.anything()
    );
  });

  it("normalizedKey 已存在 → 覆盖旧记忆", async () => {
    mockFindCandidate.mockResolvedValue(candidate([addOperation]) as never);
    mockFindActiveByKey.mockResolvedValue(memory());

    await commitCandidate("c1");

    expect(mockSupersede).toHaveBeenCalledWith(
      expect.anything(),
      "m1",
      "u1"
    );
    expect(mockInsert.mock.calls[0][1]).toMatchObject({
      supersedesId: "m1",
      sourceType: "user_correction",
    });
    expect(mockEvent.mock.calls[0][1]).toMatchObject({
      action: "supersede",
    });
  });

  it("向量相似度 ≥ 0.92 → 视为更新而不是新增", async () => {
    mockFindCandidate.mockResolvedValue(candidate([addOperation]) as never);
    mockFindSimilar.mockResolvedValue({
      id: "m2",
      kind: "skill",
      content: "React 还行",
      normalizedKey: null,
      importance: 0.6,
      confidence: 0.8,
      similarity: 0.95,
    });
    mockFindById.mockResolvedValue(memory({ id: "m2", content: "React 还行" }));

    await commitCandidate("c1");

    expect(mockSupersede).toHaveBeenCalled();
    expect(mockInsert.mock.calls[0][1]).toMatchObject({ supersedesId: "m2" });
  });

  it("向量相似度 ≥ 0.97 → 视为重复，不写库", async () => {
    mockFindCandidate.mockResolvedValue(candidate([addOperation]) as never);
    mockFindSimilar.mockResolvedValue({
      id: "m3",
      kind: "skill",
      content: "React 熟练",
      normalizedKey: null,
      importance: 0.7,
      confidence: 0.9,
      similarity: 0.99,
    });

    await commitCandidate("c1");

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockEvent.mock.calls[0][1]).toMatchObject({ action: "noop" });
  });

  it("UPDATE 的 target 已经失效 → noop，不报错", async () => {
    mockFindCandidate.mockResolvedValue(
      candidate([
        {
          op: "UPDATE",
          targetId: "gone",
          kind: "skill",
          content: "React 熟练",
          importance: 0.7,
          confidence: 0.9,
          evidence: "我现在主要使用 React",
          sourceType: "user_correction",
        },
      ]) as never
    );
    mockFindById.mockResolvedValue(null);

    await commitCandidate("c1");

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockEvent.mock.calls[0][1]).toMatchObject({ action: "noop" });
  });

  it("DELETE → 软删除并写 delete 事件", async () => {
    mockFindCandidate.mockResolvedValue(
      candidate([
        {
          op: "DELETE",
          targetId: "m1",
          evidence: "我不用 Vue 了",
          sourceType: "user_correction",
        },
      ]) as never
    );
    mockFindById.mockResolvedValue(memory());

    await commitCandidate("c1");

    expect(mockSoftDelete).toHaveBeenCalledWith(expect.anything(), "m1", "u1");
    expect(mockEvent.mock.calls[0][1]).toMatchObject({ action: "delete" });
  });

  it("done/noop 的候选不会重复提交", async () => {
    mockFindCandidate.mockResolvedValue({
      ...candidate([addOperation]),
      status: "done",
    } as never);

    await commitCandidate("c1");

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockLock).not.toHaveBeenCalled();
  });
});

describe("updateMemoryByUser", () => {
  function withTx() {
    const updateMany = vi.fn();
    mockLock.mockImplementation(async (_userId, fn) =>
      fn({ memory: { updateMany } } as never)
    );
    return updateMany;
  }

  it("越权 / 不存在 → not_found，不开事务", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await updateMemoryByUser("u1", "m-other", {
      content: "新内容",
    });

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(mockLock).not.toHaveBeenCalled();
  });

  it("字段没有变化 → no_change，不写事件", async () => {
    mockFindById.mockResolvedValue(memory({ content: "Vue 熟练" }));

    const result = await updateMemoryByUser("u1", "m1", { content: "Vue 熟练" });

    expect(result).toEqual({ ok: false, reason: "no_change" });
    expect(mockEvent).not.toHaveBeenCalled();
  });

  it("改正文 → 重嵌入 + 写 update 事件（actor=user，保留 sourceType）", async () => {
    const target = memory({ content: "Vue 熟练" });
    mockFindById.mockResolvedValue(target);
    const updateMany = withTx();

    const result = await updateMemoryByUser("u1", "m1", {
      content: "Vue 与 React 都熟练",
      importance: 0.9,
    });

    expect(result.ok).toBe(true);
    expect(mockSetEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      "m1",
      "u1",
      expect.any(Array),
      "test-embedding"
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1", userId: "u1", status: "active" },
        data: expect.objectContaining({
          content: "Vue 与 React 都熟练",
          importance: 0.9,
        }),
      })
    );
    expect(mockEvent.mock.calls[0][1]).toMatchObject({
      action: "update",
      actor: "user",
      userId: "u1",
      memoryId: "m1",
    });
    // sourceType 保留原值（追溯来源），不改成 user_edit
    expect(result.ok && result.memory.sourceType).toBe("user_statement");
  });

  it("同键出现异常重复项时先 supersede 冲突项", async () => {
    mockFindById.mockResolvedValue(
      memory({ id: "m1", normalizedKey: "skill:frontend" })
    );
    mockFindActiveByKey.mockResolvedValue(
      memory({ id: "m2", normalizedKey: "skill:frontend" })
    );
    withTx();

    await updateMemoryByUser("u1", "m1", { content: "新的描述" });

    expect(mockSupersede).toHaveBeenCalledWith(expect.anything(), "m2", "u1");
  });
});

describe("deleteMemoryByUser", () => {
  it("不存在 / 已删除 → false，不写事件", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await deleteMemoryByUser("u1", "m1");

    expect(result).toBe(false);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it("软删并写 delete 事件", async () => {
    mockFindById.mockResolvedValue(memory());

    const result = await deleteMemoryByUser("u1", "m1");

    expect(result).toBe(true);
    expect(mockSoftDelete).toHaveBeenCalledWith(expect.anything(), "m1", "u1");
    expect(mockEvent.mock.calls[0][1]).toMatchObject({
      action: "delete",
      actor: "user",
    });
  });
});
