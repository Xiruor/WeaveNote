import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";

const FOLDER_NAME_MAX = 60;

// PATCH /api/folders/[id] — 重命名 / 移动文件夹 { name?, parentId? }
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
    const folder = await prisma.folder.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!folder) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const data: { name?: string; parentId?: string | null } = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name || name.length > FOLDER_NAME_MAX) {
        return NextResponse.json(
          { error: `文件夹名需为 1-${FOLDER_NAME_MAX} 个字符` },
          { status: 400 }
        );
      }
      data.name = name;
    }

    if (body.parentId !== undefined) {
      const parentId =
        typeof body.parentId === "string" && body.parentId
          ? body.parentId
          : null;
      if (parentId) {
        if (parentId === id) {
          return NextResponse.json(
            { error: "不能把文件夹移动到自己里面" },
            { status: 400 }
          );
        }
        // 父文件夹必须属于当前用户；且不能是自己的后代（防环）
        const parent = await prisma.folder.findFirst({
          where: { id: parentId, userId: user.id },
          select: { id: true, parentId: true },
        });
        if (!parent) {
          return NextResponse.json(
            { error: "父文件夹不存在" },
            { status: 400 }
          );
        }
        let cursor = parent;
        for (let depth = 0; depth < 20 && cursor.parentId; depth++) {
          if (cursor.parentId === id) {
            return NextResponse.json(
              { error: "不能把文件夹移动到自己的子文件夹里" },
              { status: 400 }
            );
          }
          const next = await prisma.folder.findUnique({
            where: { id: cursor.parentId },
            select: { id: true, parentId: true },
          });
          if (!next) break;
          cursor = next;
        }
      }
      data.parentId = parentId;
    }

    const updated = await prisma.folder.update({
      where: { id },
      data,
      select: { id: true, name: true, parentId: true },
    });

    return NextResponse.json({ folder: updated });
  } catch (error) {
    console.error("Update folder error:", error);
    return NextResponse.json(
      { error: "Failed to update folder" },
      { status: 500 }
    );
  }
}

// DELETE /api/folders/[id]
// 子文件夹级联删除，其中的笔记不删（folderId 置空，回到根目录）
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
    const folder = await prisma.folder.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!folder) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.folder.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete folder error:", error);
    return NextResponse.json(
      { error: "Failed to delete folder" },
      { status: 500 }
    );
  }
}
