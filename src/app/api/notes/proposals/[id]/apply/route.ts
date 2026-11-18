import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { contentHash, indexNote } from "@/lib/notes/index-note";

// POST /api/notes/proposals/[id]/apply
//
// 应用一条修改提案。body 可带 `content` / `title`：内联 diff 视图允许用户
// 逐段取舍，最终提交的是「只保留选中的改动」后的正文，而不是提案原文。
//
// 在事务里严格按序：
//   1. 校验归属（proposal.userId === user.id）
//   2. status === "pending"，否则 409（已处理）
//   3. baseHash === contentHash(当前正文)，不等说明用户后来编辑过笔记，
//      置 stale 并返回 409，要求让 AI 重新生成
//   4. 写 NoteVersion 快照（回滚来源，M5 展示）
//   5. 更新 Note 标题/正文
//   6. 置 accepted + decidedAt
//   响应后 after() 后台重建语义索引（不阻塞响应）。
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 可选的部分应用结果：逐段取舍后合成的新正文
    const body = (await request.json().catch(() => null)) as
      | { content?: unknown; title?: unknown }
      | null;

    const { id } = await context.params;
    const proposal = await prisma.noteProposal.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        noteId: true,
        newTitle: true,
        newContent: true,
        baseHash: true,
        status: true,
      },
    });
    if (!proposal) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (proposal.status !== "pending") {
      return NextResponse.json(
        { error: "提案已处理，无法再次应用" },
        { status: 409 }
      );
    }

    const note = await prisma.note.findFirst({
      where: { id: proposal.noteId, userId: user.id },
      select: { id: true, title: true, content: true },
    });
    if (!note) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // 并发冲突检测：提案基于的正文哈希与当前不一致 → 用户已改过 → 置 stale
    if (proposal.baseHash !== contentHash(note.content)) {
      await prisma.noteProposal.update({
        where: { id },
        data: { status: "stale", decidedAt: new Date() },
      });
      return NextResponse.json(
        { error: "笔记已被编辑，请让 AI 重新生成修改建议" },
        { status: 409 }
      );
    }

    const newTitle =
      (typeof body?.title === "string" && body.title.trim()) ||
      proposal.newTitle?.trim() ||
      note.title;
    const newContent =
      typeof body?.content === "string" ? body.content : proposal.newContent;

    const updated = await prisma.$transaction(async (tx) => {
      // 快照：记录应用前的版本，供撤销 / 版本历史（M5）
      await tx.noteVersion.create({
        data: {
          noteId: note.id,
          userId: user.id,
          title: note.title,
          content: note.content,
        },
      });

      const saved = await tx.note.update({
        where: { id: note.id },
        data: { title: newTitle, content: newContent },
        select: {
          id: true,
          title: true,
          content: true,
          folderId: true,
          pinned: true,
          updatedAt: true,
        },
      });

      await tx.noteProposal.update({
        where: { id },
        data: { status: "accepted", decidedAt: new Date() },
      });

      return saved;
    });

    after(() => {
      void indexNote(note.id, user.id);
    });

    return NextResponse.json({ note: updated });
  } catch (error) {
    console.error("Apply note proposal error:", error);
    return NextResponse.json(
      { error: "Failed to apply proposal" },
      { status: 500 }
    );
  }
}
