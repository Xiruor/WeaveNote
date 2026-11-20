import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { deleteMemoryByUser, updateMemoryByUser } from "@/lib/memory/manager";
import {
  clampScore,
  normalizeMemoryContent,
} from "@/lib/memory/validation";
import { isMemoryKind, type MemoryKind } from "@/lib/memory/types";

// PATCH /api/memories/[id] —— 手动改记忆正文 / 类型 / 重要度
//
// 归属校验与 404 口径对齐 /api/notes/[id]/proposals：不存在与无权访问
// 一律返回 404，不泄露存在性。
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
    const body = (await request.json().catch(() => null)) as {
      content?: unknown;
      kind?: unknown;
      importance?: unknown;
    } | null;

    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const patch: {
      content?: string;
      kind?: MemoryKind;
      importance?: number;
    } = {};

    if (body.content !== undefined) {
      const normalized = normalizeMemoryContent(body.content);
      if ("error" in normalized) {
        return NextResponse.json(
          { error: `正文不合法：${normalized.error}` },
          { status: 400 }
        );
      }
      patch.content = normalized.value;
    }

    if (body.kind !== undefined) {
      const kind = asKind(body.kind);
      if (!kind) {
        return NextResponse.json({ error: "记忆类型不合法" }, { status: 400 });
      }
      patch.kind = kind;
    }

    if (body.importance !== undefined) {
      patch.importance = clampScore(body.importance);
    }

    if (
      patch.content === undefined &&
      patch.kind === undefined &&
      patch.importance === undefined
    ) {
      return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
    }

    const result = await updateMemoryByUser(user.id, id, patch);
    if (!result.ok) {
      if (result.reason === "no_change") {
        return NextResponse.json({ error: "内容没有变化" }, { status: 400 });
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ memory: result.memory });
  } catch (error) {
    console.error("Update memory error:", error);
    return NextResponse.json(
      { error: "Failed to update memory" },
      { status: 500 }
    );
  }
}

// DELETE /api/memories/[id] —— 软删（保留事件与审计链）
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
    const deleted = await deleteMemoryByUser(user.id, id);
    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete memory error:", error);
    return NextResponse.json(
      { error: "Failed to delete memory" },
      { status: 500 }
    );
  }
}

function asKind(value: unknown): MemoryKind | null {
  return isMemoryKind(value) ? value : null;
}
