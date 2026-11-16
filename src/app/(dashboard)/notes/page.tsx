import { requireAuth } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { makeSnippet } from "@/lib/notes/snippet";
import { NotesLibrary } from "@/components/notes/notes-library";

// 笔记库列表页：服务端取首屏数据（文件夹 + 笔记），交互由 NotesLibrary 接管
export default async function NotesPage() {
  const user = await requireAuth();

  const [folders, noteRows] = await Promise.all([
    prisma.folder.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, parentId: true, createdAt: true },
    }),
    prisma.note.findMany({
      where: { userId: user.id },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      select: {
        id: true,
        title: true,
        folderId: true,
        pinned: true,
        updatedAt: true,
        content: true,
      },
    }),
  ]);

  // 与 GET /api/notes 同构：附加 snippet 供卡片展示
  const notes = noteRows.map(({ content, ...rest }) => ({
    ...rest,
    snippet: makeSnippet(content),
  }));

  return (
    <div className="scenic-shell flex min-h-[calc(100dvh-5rem)] flex-col">
      <NotesLibrary initialFolders={folders} initialNotes={notes} />
    </div>
  );
}
