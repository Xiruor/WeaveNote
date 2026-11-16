import { beforeEach, describe, expect, it, vi } from "vitest";

// 旧学习业务（plan / document）已从 Prisma schema 删除——mock 里再写它们
// 直接就是类型错误，类型系统本身就是「不许回加」的护栏。
// 这里保留 note 探针：M0 的场景上下文连笔记都不查（只基于 surface + refId），
// 谁提前把查询加回来、又没接好 mock，这里立刻响。标题/正文注入留到 M1。

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
  it("note + refId 不落库（笔记标题/正文注入留到 M1）", async () => {
    const result = await loadSceneContext({
      userId: "u1",
      surface: "note",
      refId: "n1",
    });
    expect(mockNote).not.toHaveBeenCalled();
    expect(result).toEqual({ prompt: "" });
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
