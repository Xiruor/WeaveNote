import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { makeSnippet } from "@/lib/notes/snippet";

const NOTE_TITLE_MAX = 120;

const noteListSelect = {
  id: true,
  title: true,
  folderId: true,
  pinned: true,
  updatedAt: true,
} as const;

// GET /api/notes?folderId=... — 笔记列表；folderId 缺省=全部，"root"=未归档
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const folderId = new URL(request.url).searchParams.get("folderId");
    const rows = await prisma.note.findMany({
      where: {
        userId: user.id,
        ...(folderId === "root"
          ? { folderId: null }
          : folderId
            ? { folderId }
            : {}),
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      select: { ...noteListSelect, content: true },
    });

    // 附加 snippet（正文摘要）供卡片展示；现有字段与排序语义不变
    const notes = rows.map(({ content, ...rest }) => ({
      ...rest,
      snippet: makeSnippet(content),
    }));

    return NextResponse.json({ notes });
  } catch (error) {
    console.error("Get notes error:", error);
    return NextResponse.json(
      { error: "Failed to get notes" },
      { status: 500 }
    );
  }
}

// POST /api/notes — 新建笔记 { title?, folderId?, content? }
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, NOTE_TITLE_MAX)
        : "未命名笔记";
    const content = typeof body.content === "string" ? body.content : "";
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

    const note = await prisma.note.create({
      data: { userId: user.id, title, content, folderId },
      select: noteListSelect,
    });

    return NextResponse.json({ note });
  } catch (error) {
    console.error("Create note error:", error);
    return NextResponse.json(
      { error: "Failed to create note" },
      { status: 500 }
    );
  }
}
