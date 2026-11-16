import { beforeEach, describe, expect, it, vi } from "vitest";

// M1 起场景上下文按 surface + refId 查业务数据：note 场景查笔记（userId
// 归属校验内联在查询里），workspace 仍无绑定对象。旧学习业务（plan /
// document）已从 Prisma schema 删除——mock 里再写它们直接就是类型错误，
// 类型系统本身就是「不许回加」的护栏。

vi.mock("@/lib/prisma", () => ({
  prisma: {
    note: { findFirst: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { loadSceneContext } from "@/lib/context/scene";

const mockNote = vi.mocked(prisma.note.findFirst);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadSceneContext", () => {
  it("note + refId：查到笔记 → 注入标题与正文", async () => {
    mockNote.mockResolvedValue({
      title: "Raft 论文笔记",
      content: "## 分布式共识\nRaft 把一致性拆成三块……",
    } as never);

    const result = await loadSceneContext({
      userId: "u1",
      surface: "note",
      refId: "n1",
    });

    expect(mockNote).toHaveBeenCalledWith({
      where: { id: "n1", userId: "u1" },
      select: { title: true, content: true },
    });
    expect(result.prompt).toContain("Raft 论文笔记");
    expect(result.prompt).toContain("Raft 把一致性拆成三块");
  });

  it("note：正文超长 → 截断并标注", async () => {
    mockNote.mockResolvedValue({
      title: "长文",
      content: "x".repeat(13000),
    } as never);

    const result = await loadSceneContext({
      userId: "u1",
      surface: "note",
      refId: "n1",
    });

    expect(result.prompt.length).toBeLessThan(13000);
    expect(result.prompt).toContain("已截断");
  });

  it("note：笔记不存在或不属于当前用户 → 空上下文（不泄露存在性）", async () => {
    mockNote.mockResolvedValue(null);

    const result = await loadSceneContext({
      userId: "u1",
      surface: "note",
      refId: "别人的笔记",
    });

    expect(result).toEqual({ prompt: "" });
  });

  it("note：没有 refId → 不落库", async () => {
    const result = await loadSceneContext({
      userId: "u1",
      surface: "note",
      refId: null,
    });
    expect(result).toEqual({ prompt: "" });
    expect(mockNote).not.toHaveBeenCalled();
  });

  it("workspace 没有绑定业务对象 → 空上下文", async () => {
    const result = await loadSceneContext({
      userId: "u1",
      surface: "workspace",
      refId: null,
    });
    expect(result.prompt).toBe("");
    expect(mockNote).not.toHaveBeenCalled();
  });
});
