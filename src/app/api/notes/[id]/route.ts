import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { indexNote } from "@/lib/notes/index-note";

const NOTE_TITLE_MAX = 120;

// GET /api/notes/[id] — 笔记详情（归属校验）
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const note = await prisma.note.findFirst({
      where: { id, userId: user.id },
    });
    if (!note) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ note });
  } catch (error) {
    console.error("Get note error:", error);
    return NextResponse.json({ error: "Failed to get note" }, { status: 500 });
  }
}

// PATCH /api/notes/[id] — 更新 { title?, content?, folderId?, pinned? }
// 内容变更时，经 after() 在响应结束后后台重建语义索引（NoteChunk + embedding），
// 不阻塞编辑器的自动保存。
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const existing = await prisma.note.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const data: {
      title?: string;
      content?: string;
      folderId?: string | null;
      pinned?: boolean;
    } = {};

    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title || title.length > NOTE_TITLE_MAX) {
        return NextResponse.json(
          { error: `标题需为 1-${NOTE_TITLE_MAX} 个字符` },
          { status: 400 }
        );
      }
      data.title = title;
    }
    if (typeof body.content === "string") {
      data.content = body.content;
    }
    if (body.folderId !== undefined) {
      const folderId =
        typeof body.folderId === "string" && body.folderId
          ? body.folderId
          : null;
      if (folderId) {
        const folder = await prisma.folder.findFirst({
          where: { id: folderId, userId: user.id },
          select: { id: true },
        });
        if (!folder) {
          return NextResponse.json(
            { error: "文件夹不存在" },
            { status: 400 }
          );
        }
      }
      data.folderId = folderId;
    }
    if (typeof body.pinned === "boolean") {
      data.pinned = body.pinned;
    }

    const note = await prisma.note.update({
      where: { id },
      data,
      select: {
        id: true,
        title: true,
        content: true,
        folderId: true,
        pinned: true,
        updatedAt: true,
      },
    });

    // 响应先回给编辑器，索引在后台跑（失败静默，indexHash 保持旧值）
    if (data.content !== undefined) {
      after(() => {
        void indexNote(id, user.id);
      });
    }

    return NextResponse.json({ note });
  } catch (error) {
    console.error("Update note error:", error);
    return NextResponse.json(
      { error: "Failed to update note" },
      { status: 500 }
    );
  }
}

// DELETE /api/notes/[id]（NoteChunk 级联删除）
export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const note = await prisma.note.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!note) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.note.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete note error:", error);
    return NextResponse.json(
      { error: "Failed to delete note" },
      { status: 500 }
    );
  }
}
