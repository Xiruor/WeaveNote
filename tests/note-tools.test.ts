import { beforeEach, describe, expect, it, vi } from "vitest";

// 笔记工具的权限边界是安全面：所有查询/写入都必须用 userId 过滤，越权 id 一律
// 「不存在或无权访问」。这里用 mock prisma 直接验证工具层逻辑，不碰真实数据库。

const mocks = vi.hoisted(() => ({
  noteFindFirst: vi.fn(),
  noteCreate: vi.fn(),
  proposalCreate: vi.fn(),
  folderFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    note: { findFirst: mocks.noteFindFirst, create: mocks.noteCreate },
    noteProposal: { create: mocks.proposalCreate },
    folder: { findFirst: mocks.folderFindFirst },
  },
}));

import { createNoteTools } from "@/lib/tools/note-tools";
import { contentHash } from "@/lib/notes/index-note";

// AI SDK tool() 的 execute 第二个参数（toolCallId/messages/context）与本测试无关，
// 这里收窄成一个只传 input 的调用助手，避免和 SDK 的泛型签名纠缠。
type Exec = (input: unknown, options?: unknown) => Promise<unknown>;
function exec(tool: { execute?: unknown }, input: unknown): Promise<unknown> {
  return (tool.execute as Exec)(input, { toolCallId: "tc", messages: [], context: undefined });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.noteFindFirst.mockResolvedValue(null);
  mocks.noteCreate.mockResolvedValue({ id: "n2", title: "新笔记" });
  mocks.proposalCreate.mockResolvedValue({ id: "p1" });
  mocks.folderFindFirst.mockResolvedValue(null);
});

describe("proposeNoteEdit", () => {
  it("笔记不存在/不属于当前用户时拒绝，不写提案", async () => {
    const { proposeNoteEdit } = createNoteTools("u1", { noteId: "n1", conversationId: "c1" });
    mocks.noteFindFirst.mockResolvedValue(null);

    const result = await exec(proposeNoteEdit, {
      noteId: "other-user-note",
      newContent: "改写后的正文",
    });

    expect(result).toEqual({ success: false, error: "笔记不存在或无权访问" });
    expect(mocks.proposalCreate).not.toHaveBeenCalled();
  });

  it("未给 noteId 且场景也没传当前笔记时拒绝", async () => {
    const { proposeNoteEdit } = createNoteTools("u1", {});

    const result = await exec(proposeNoteEdit, { newContent: "x" });

    expect(result).toEqual({ success: false, error: "未指定要修改的笔记 id" });
    expect(mocks.proposalCreate).not.toHaveBeenCalled();
  });

  it("成功：写提案带 baseHash / conversationId / status=pending，标题理由去首尾空格", async () => {
    const { proposeNoteEdit } = createNoteTools("u1", { noteId: "n1", conversationId: "c1" });
    mocks.noteFindFirst.mockResolvedValue({ id: "n1", content: "旧正文" });
    mocks.proposalCreate.mockResolvedValue({ id: "p1" });

    const result = await exec(proposeNoteEdit, {
      newTitle: "  新标题  ",
      newContent: "新正文",
      reason: " 整理成小节 ",
    });

    expect(mocks.proposalCreate).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        noteId: "n1",
        conversationId: "c1",
        newTitle: "新标题",
        newContent: "新正文",
        baseHash: contentHash("旧正文"),
        reason: "整理成小节",
        status: "pending",
      },
      select: { id: true },
    });
    expect(result).toEqual({
      success: true,
      proposalId: "p1",
      status: "pending",
      guidance: expect.any(String),
    });
  });
});

describe("createNote", () => {
  it("folderId 不属于当前用户时拒绝", async () => {
    const { createNote } = createNoteTools("u1", {});
    mocks.folderFindFirst.mockResolvedValue(null);

    const result = await exec(createNote, {
      title: "t",
      content: "c",
      folderId: "other-folder",
    });

    expect(result).toEqual({ success: false, error: "文件夹不存在或无权访问" });
    expect(mocks.noteCreate).not.toHaveBeenCalled();
  });

  it("成功：以当前 userId 建笔记，标题去首尾空格", async () => {
    const { createNote } = createNoteTools("u1", {});
    mocks.noteCreate.mockResolvedValue({ id: "n2", title: "新笔记" });

    const result = await exec(createNote, { title: "  新笔记  ", content: "正文" });

    expect(mocks.noteCreate).toHaveBeenCalledWith({
      data: { userId: "u1", title: "新笔记", content: "正文", folderId: null },
      select: { id: true, title: true },
    });
    expect(result).toEqual({
      success: true,
      noteId: "n2",
      title: "新笔记",
      link: "/notes/n2",
      guidance: expect.any(String),
    });
  });
});
