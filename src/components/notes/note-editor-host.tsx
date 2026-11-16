"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { MarkdownStudio } from "@/components/studio/markdown-studio";

interface NoteEditorHostProps {
  note: { id: string; title: string; content: string };
}

// 笔记编辑器宿主：把 MarkdownStudio 接到 /api/notes/[id]。
// · 自动保存（1200ms debounce）/ Ctrl+S / 保存状态由 MarkdownStudio 内建，
//   这里只提供 onSave（PATCH content）与 onRename（PATCH title）
// · AI 面板：context.kind = "note"，会话归属记在 conversation.surface=note + refId
// · 沉浸模式：页面在 (editor) 路由组，无站点导航；ESC 直接回笔记库
//   （MarkdownStudio 卸载时会把未保存改动兜底保存）
export function NoteEditorHost({ note }: NoteEditorHostProps) {
  const router = useRouter();

  const patchNote = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "保存失败");
      }
    },
    [note.id]
  );

  const handleSave = useCallback(
    (content: string) => patchNote({ content }),
    [patchNote]
  );

  const handleRename = useCallback(
    (title: string) => patchNote({ title }),
    [patchNote]
  );

  // ESC 退出沉浸模式。输入框里 ESC 优先留给「取消重命名」等本地交互。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      router.push("/notes");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <MarkdownStudio
      document={note}
      onSave={handleSave}
      onRename={handleRename}
      backHref="/notes"
      backLabel="笔记库"
      ai={{ context: { kind: "note", refId: note.id } }}
    />
  );
}
