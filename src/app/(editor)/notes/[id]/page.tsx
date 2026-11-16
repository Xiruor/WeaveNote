import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { NoteEditorHost } from "@/components/notes/note-editor-host";

// 笔记编辑器（沉浸模式）：服务端校验归属后把笔记交给编辑器宿主。
// 不存在 / 非本人的笔记一律 notFound，不泄露存在性。
export default async function NoteEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireAuth();
  const note = await prisma.note.findFirst({
    where: { id, userId: user.id },
    select: { id: true, title: true, content: true },
  });
  if (!note) notFound();

  return <NoteEditorHost note={note} />;
}
