import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";

// POST /api/notes/proposals/[id]/reject
// 放弃一条修改提案（仅 pending 可放弃）。
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const proposal = await prisma.noteProposal.findFirst({
      where: { id, userId: user.id },
      select: { id: true, status: true },
    });
    if (!proposal) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (proposal.status !== "pending") {
      return NextResponse.json(
        { error: "提案已处理，无法再次放弃" },
        { status: 409 }
      );
    }

    await prisma.noteProposal.update({
      where: { id },
      data: { status: "rejected", decidedAt: new Date() },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Reject note proposal error:", error);
    return NextResponse.json(
      { error: "Failed to reject proposal" },
      { status: 500 }
    );
  }
}
