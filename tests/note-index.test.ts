import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  embedTexts: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    note: { findFirst: mocks.findFirst, update: mocks.update },
    noteChunk: { deleteMany: mocks.deleteMany },
    $executeRawUnsafe: mocks.executeRaw,
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/rag/client", () => ({ embedTexts: mocks.embedTexts }));
vi.mock("@/lib/rag/vector", () => ({
  toPgVector: (values: number[]) => `[${values.join(",")}]`,
}));

import { contentHash, indexNote } from "@/lib/notes/index-note";

const sha = (value: string) =>
  createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(null);
  mocks.update.mockResolvedValue({});
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.executeRaw.mockResolvedValue(1);
  mocks.embedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
  mocks.transaction.mockImplementation(async (operations: unknown) =>
    Promise.all(operations as Promise<unknown>[])
  );
});

describe("indexNote（hash 增量）", () => {
  it("indexHash 已等于当前内容时直接跳过，不重新向量化", async () => {
    const content = "## 标题\n\n正文内容";
    mocks.findFirst.mockResolvedValue({
      content,
      indexHash: sha(content),
    });

    await indexNote("n1", "u1");

    expect(mocks.embedTexts).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("内容变化时重新分块、向量化并回写 indexHash", async () => {
    const content = "## 标题\n\n正文内容";
    mocks.findFirst.mockResolvedValue({ content, indexHash: null });

    await indexNote("n1", "u1");

    expect(mocks.embedTexts).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "n1" },
      data: { indexHash: sha(content) },
    });
  });

  it("空笔记只清旧块，不烧 embedding", async () => {
    mocks.findFirst.mockResolvedValue({ content: "   ", indexHash: null });

    await indexNote("n1", "u1");

    expect(mocks.embedTexts).not.toHaveBeenCalled();
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "n1" },
      data: { indexHash: sha("   ") },
    });
  });

  it("并发触发同一篇笔记只向量化一次", async () => {
    const content = "## 标题\n\n正文内容";
    mocks.findFirst.mockResolvedValue({ content, indexHash: null });

    await Promise.all([indexNote("n1", "u1"), indexNote("n1", "u1")]);

    expect(mocks.embedTexts).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("contentHash", () => {
  it("相同内容稳定、不同内容不同", () => {
    expect(contentHash("abc")).toBe(sha("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});
