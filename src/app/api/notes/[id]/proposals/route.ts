import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";

const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "stale"] as const;
type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

// GET /api/notes/[id]/proposals?status=pending
// 返回某篇笔记的修改提案。默认只返回 pending（内联 diff 在流结束后拉取用），
// status=all 返回全部（供历史查看）。
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    // 归属校验：先确认笔记存在且属于当前用户（防越权列提案）
    const note = await prisma.note.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!note) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const rawStatus = request.nextUrl.searchParams.get("status") ?? "pending";
    const status: ProposalStatus | "all" =
      rawStatus === "all"
        ? "all"
        : (PROPOSAL_STATUSES as readonly string[]).includes(rawStatus)
          ? (rawStatus as ProposalStatus)
          : "pending";

    const proposals = await prisma.noteProposal.findMany({
      where: {
        noteId: id,
        userId: user.id,
        ...(status !== "all" ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        noteId: true,
        newTitle: true,
        newContent: true,
        baseHash: true,
        reason: true,
        status: true,
        createdAt: true,
        decidedAt: true,
      },
    });

    return NextResponse.json({ proposals });
  } catch (error) {
    console.error("List note proposals error:", error);
    return NextResponse.json(
      { error: "Failed to list proposals" },
      { status: 500 }
    );
  }
}
