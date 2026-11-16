import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";

const FOLDER_NAME_MAX = 60;

// GET /api/folders — 当前用户的文件夹列表（扁平，前端组树）
export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const folders = await prisma.folder.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, parentId: true, createdAt: true },
    });

    return NextResponse.json({ folders });
  } catch (error) {
    console.error("Get folders error:", error);
    return NextResponse.json(
      { error: "Failed to get folders" },
      { status: 500 }
    );
  }
}

// POST /api/folders — 新建文件夹 { name, parentId? }
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > FOLDER_NAME_MAX) {
      return NextResponse.json(
        { error: `文件夹名需为 1-${FOLDER_NAME_MAX} 个字符` },
        { status: 400 }
      );
    }

    // 父文件夹必须存在且属于当前用户
    const parentId =
      typeof body.parentId === "string" && body.parentId ? body.parentId : null;
    if (parentId) {
      const parent = await prisma.folder.findFirst({
        where: { id: parentId, userId: user.id },
        select: { id: true },
      });
      if (!parent) {
        return NextResponse.json(
          { error: "父文件夹不存在" },
          { status: 400 }
        );
      }
    }

    const folder = await prisma.folder.create({
      data: { userId: user.id, name, parentId },
      select: { id: true, name: true, parentId: true, createdAt: true },
    });

    return NextResponse.json({ folder });
  } catch (error) {
    console.error("Create folder error:", error);
    return NextResponse.json(
      { error: "Failed to create folder" },
      { status: 500 }
    );
  }
}
