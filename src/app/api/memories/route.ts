import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { listMemories } from "@/lib/memory/store";
import {
  isMemoryKind,
  MEMORY_STATUSES,
  type MemoryKind,
  type MemoryStatus,
} from "@/lib/memory/types";

// GET /api/memories?status=active&kind=preference&q=标题
//
// 记忆管理页的列表接口。默认只返回 active；status=all 返回全部状态。
// 查询一律按 userId 收口，越权可见性为零。
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = request.nextUrl.searchParams;

    const rawStatus = params.get("status") ?? "active";
    const status: MemoryStatus | "all" =
      rawStatus === "all"
        ? "all"
        : (MEMORY_STATUSES as readonly string[]).includes(rawStatus)
          ? (rawStatus as MemoryStatus)
          : "active";

    const rawKind = params.get("kind");
    const kind: MemoryKind | undefined =
      rawKind && isMemoryKind(rawKind) ? rawKind : undefined;

    const q = params.get("q")?.trim() || undefined;

    const memories = await listMemories(user.id, { status, kind, q });

    return NextResponse.json({ memories });
  } catch (error) {
    console.error("List memories error:", error);
    return NextResponse.json(
      { error: "Failed to list memories" },
      { status: 500 }
    );
  }
}
