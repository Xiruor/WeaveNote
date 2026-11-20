import { beforeEach, describe, expect, it, vi } from "vitest";

// remember 工具的安全边界：不越权写库、evidence 必须是用户原话、正文不超限、
// 同轮幂等。这里 mock 掉 store / manager，只验证工具层逻辑。

const mocks = vi.hoisted(() => ({
  createCandidate: vi.fn(),
  markCandidate: vi.fn(),
  commitCandidate: vi.fn(),
  listActiveMemories: vi.fn(),
  findMemoriesByIds: vi.fn(),
  searchActiveMemoryIdsByVector: vi.fn(),
  embedText: vi.fn(),
  touchToolRead: vi.fn(),
}));

vi.mock("@/lib/memory/store", () => ({
  createCandidate: mocks.createCandidate,
  markCandidate: mocks.markCandidate,
  listActiveMemories: mocks.listActiveMemories,
  findMemoriesByIds: mocks.findMemoriesByIds,
  searchActiveMemoryIdsByVector: mocks.searchActiveMemoryIdsByVector,
}));

vi.mock("@/lib/memory/manager", () => ({
  commitCandidate: mocks.commitCandidate,
}));

vi.mock("@/lib/rag/client", () => ({
  embedText: mocks.embedText,
}));

vi.mock("@/lib/memory/access", () => ({
  touchToolRead: mocks.touchToolRead,
}));

import { createMemoryTools } from "@/lib/tools/memory-tools";

type Exec = (input: unknown, options?: unknown) => Promise<unknown>;
function exec(tool: { execute?: unknown }, input: unknown): Promise<unknown> {
  return (tool.execute as Exec)(input, {
    toolCallId: "tc",
    messages: [],
    context: undefined,
  });
}

const OPTIONS = {
  conversationId: "c1",
  messageId: "m1",
  currentUserText: "记住：我习惯用中文写标题，而且以后都用 Markdown。",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createCandidate.mockResolvedValue({ created: true, candidateId: "cand1" });
  mocks.markCandidate.mockResolvedValue(undefined);
  mocks.commitCandidate.mockResolvedValue({ added: 1 });
});

describe("remember", () => {
  it("evidence 不是用户原话时拒绝写入", async () => {
    const { remember } = createMemoryTools("u1", OPTIONS);

    const result = await exec(remember, {
      memories: [
        {
          kind: "preference",
          content: "用户喜欢用英文写标题",
          evidence: "我习惯用英文写标题",
        },
      ],
    });

    expect(result).toMatchObject({ success: false });
    expect(mocks.createCandidate).not.toHaveBeenCalled();
    expect(mocks.commitCandidate).not.toHaveBeenCalled();
  });

  it("正文超过 200 字时拒绝写入", async () => {
    const longText = "记".repeat(201);
    const { remember } = createMemoryTools("u1", {
      ...OPTIONS,
      currentUserText: longText,
    });

    const result = await exec(remember, {
      memories: [
        { kind: "fact", content: longText, evidence: longText.slice(0, 20) },
      ],
    });

    expect(result).toMatchObject({ success: false });
    expect(mocks.createCandidate).not.toHaveBeenCalled();
  });

  it("同一轮重复调用时提示不要重复，不写候选", async () => {
    mocks.createCandidate.mockResolvedValue({ created: false, candidateId: null });
    const { remember } = createMemoryTools("u1", OPTIONS);

    const result = await exec(remember, {
      memories: [
        {
          kind: "preference",
          content: "用户习惯用中文写标题",
          evidence: "我习惯用中文写标题",
        },
      ],
    });

    expect(result).toMatchObject({ success: false });
    expect(mocks.markCandidate).not.toHaveBeenCalled();
  });

  it("缺少 messageId / 用户原话时安全降级，不碰数据库", async () => {
    const { remember } = createMemoryTools("u1", { conversationId: "c1" });

    const result = await exec(remember, {
      memories: [
        { kind: "fact", content: "用户在学习分布式系统", evidence: "分布式系统" },
      ],
    });

    expect(result).toMatchObject({ success: false });
    expect(mocks.createCandidate).not.toHaveBeenCalled();
  });

  it("合法入参：写 ready 候选并交给 Manager，sourceType 为 note", async () => {
    const { remember } = createMemoryTools("u1", OPTIONS);

    const result = await exec(remember, {
      memories: [
        {
          kind: "preference",
          content: "用户习惯用中文写标题",
          evidence: "我习惯用中文写标题",
          importance: 0.9,
        },
        {
          kind: "habit",
          content: "用户写的笔记都用 Markdown",
          evidence: "以后都用 Markdown",
        },
      ],
    });

    expect(result).toMatchObject({ success: true, count: 2 });
    expect(mocks.createCandidate).toHaveBeenCalledWith({
      userId: "u1",
      conversationId: "c1",
      messageId: "m1",
    });
    expect(mocks.markCandidate).toHaveBeenCalledTimes(1);

    const [, patch] = mocks.markCandidate.mock.calls[0];
    expect(patch.status).toBe("ready");
    expect(patch.operations).toHaveLength(2);
    for (const op of patch.operations) {
      expect(op.op).toBe("ADD");
      expect(op.sourceType).toBe("note");
    }
    expect(patch.operations[0].importance).toBe(0.9);
    expect(mocks.commitCandidate).toHaveBeenCalledWith("cand1");
  });

  it("evidence 里的换行/空格差异不影响原话命中", async () => {
    const { remember } = createMemoryTools("u1", OPTIONS);

    const result = await exec(remember, {
      memories: [
        {
          kind: "preference",
          content: "用户习惯用中文写标题",
          evidence: "我习惯用中文写标题 ， 而且以后都用 Markdown",
        },
      ],
    });

    expect(result).toMatchObject({ success: true, count: 1 });
  });
});
