"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MarkdownStudio } from "@/components/studio/markdown-studio";
import {
  diffLines,
  mergeWithDecisions,
  splitHunks,
  type DiffHunk,
  type DiffLine,
  type HunkDecision,
} from "@/lib/diff";

interface NoteEditorHostProps {
  note: { id: string; title: string; content: string };
}

/** GET /api/notes/[id]/proposals 返回的提案行 */
interface PendingProposal {
  id: string;
  noteId: string;
  newTitle: string | null;
  newContent: string;
  reason: string | null;
  status: string;
  createdAt: string;
}

/** 内联对照中正在审阅的提案 */
interface Review {
  proposal: PendingProposal;
  lines: DiffLine[];
  hunks: DiffHunk[];
  /** hunk.index → 决定；缺省 = 待定 */
  decisions: Record<number, HunkDecision>;
}

// 笔记编辑器宿主：把 MarkdownStudio 接到 /api/notes/[id]。
// · 自动保存（1200ms debounce）/ Ctrl+S / 保存状态由 MarkdownStudio 内建，
//   这里只提供 onSave（PATCH content）与 onRename（PATCH title）
// · AI 面板：context.kind = "note"，会话归属记在 conversation.surface=note + refId
// · M3：AI 流结束后拉 pending 提案 → 编辑器右栏内联 diff，逐段 放弃/应用；
//   应用走 proposals/apply（事务里校验 baseHash、写版本快照、重建索引）
// · 沉浸模式：页面在 (editor) 路由组，无站点导航；ESC 直接回笔记库
export function NoteEditorHost({ note }: NoteEditorHostProps) {
  const router = useRouter();

  // live 跟踪编辑器当前已保存的正文/标题，作为 diff 的「改动前」基准。
  // 不用初始 note.content：用户在本会话里编辑并自动保存后，基准必须跟着变，
  // 否则内联 diff 会把用户自己的改动误标成「被 AI 删除」。
  const [live, setLive] = useState({ title: note.title, content: note.content });
  // live 的同步镜像：异步回调（拉提案）里读基准内容，不依赖闭包快照
  const liveRef = useRef(live);
  const updateLive = useCallback((next: { title: string; content: string }) => {
    liveRef.current = next;
    setLive(next);
  }, []);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  // 提交后回写编辑器内容（服务端已落库，不再触发自动保存）
  const [contentOverride, setContentOverride] = useState<{
    content: string;
    nonce: number;
  }>();

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
    async (content: string) => {
      await patchNote({ content });
      updateLive({ ...liveRef.current, content });
    },
    [patchNote, updateLive]
  );

  const handleRename = useCallback(
    async (title: string) => {
      await patchNote({ title });
      updateLive({ ...liveRef.current, title });
    },
    [patchNote, updateLive]
  );

  // AI 流结束后拉取最新一条 pending 提案，进入内联对照
  const fetchProposal = useCallback(async () => {
    try {
      const res = await fetch(`/api/notes/${note.id}/proposals?status=pending`);
      if (!res.ok) return;
      const data = await res.json();
      const list: PendingProposal[] = Array.isArray(data.proposals)
        ? data.proposals
        : [];
      const proposal = list[0];
      if (!proposal) return;
      // 基准取「已保存正文」：编辑区此刻显示的就是它
      const lines = diffLines(liveRef.current.content, proposal.newContent);
      setReview({ proposal, lines, hunks: splitHunks(lines), decisions: {} });
    } catch {
      // 拉取失败不阻塞编辑器
    }
  }, [note.id]);

  const handleAiStreamEnd = useCallback(() => {
    void fetchProposal();
  }, [fetchProposal]);

  // 进入笔记时就检查有没有遗留的待确认提案（例如上一轮对话生成的）
  useEffect(() => {
    void fetchProposal();
  }, [fetchProposal]);

  // 逐段取舍后的草稿：左侧正文实时反映「已应用」的那些改动
  const draftContent = useMemo(() => {
    if (!review) return null;
    const merged = mergeWithDecisions(review.lines, review.decisions);
    return live.content.endsWith("\n") && merged.length > 0
      ? `${merged}\n`
      : merged;
  }, [review, live.content]);

  const allDecided = useMemo(() => {
    if (!review || review.hunks.length === 0) return false;
    return review.hunks.every((hunk) => review.decisions[hunk.index] !== undefined);
  }, [review]);

  const titleChange = useMemo(() => {
    const next = review?.proposal.newTitle?.trim();
    if (!next || next === live.title) return null;
    return { from: live.title, to: next };
  }, [review, live.title]);

  const decide = useCallback((index: number, decision: HunkDecision) => {
    setReview((prev) =>
      prev
        ? { ...prev, decisions: { ...prev.decisions, [index]: decision } }
        : prev
    );
  }, []);

  /** 提交到 apply 接口：content 是逐段取舍后的最终正文 */
  const commit = useCallback(
    async (content: string, title?: string | null) => {
      if (!review) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/notes/proposals/${review.proposal.id}/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(title ? { content, title } : { content }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(body.error ?? "应用失败，请重试");
          if (res.status === 409) setReview(null);
          return;
        }
        const saved = body.note as { id: string; title: string; content: string };
        updateLive({ title: saved.title, content: saved.content });
        setContentOverride({ content: saved.content, nonce: Date.now() });
        setReview(null);
        toast.success("已应用修改");
      } catch {
        toast.error("网络错误，应用失败");
      } finally {
        setBusy(false);
      }
    },
    [review, updateLive]
  );

  const reject = useCallback(async () => {
    if (!review) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/notes/proposals/${review.proposal.id}/reject`,
        { method: "POST" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "放弃失败，请重试");
        return;
      }
      setReview(null);
    } catch {
      toast.error("网络错误，放弃失败");
    } finally {
      setBusy(false);
    }
  }, [review]);

  /** 顶部浮条主按钮：全部待定时 = 应用全部；都已处置 = 完成应用（只提交选中的） */
  const handleApplyAll = useCallback(() => {
    if (!review) return;
    if (!allDecided) {
      void commit(review.proposal.newContent, review.proposal.newTitle);
      return;
    }
    const accepted = review.hunks.some(
      (hunk) => review.decisions[hunk.index] === "accepted"
    );
    if (!accepted) {
      void reject();
      return;
    }
    void commit(draftContent ?? live.content, titleChange?.to);
  }, [review, allDecided, draftContent, live.content, titleChange, commit, reject]);

  // ESC 退出沉浸模式。输入框里 ESC 优先留给「取消重命名」等本地交互；
  // 对照模式下 ESC 先放弃本次提案，避免误退页面。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (review && !busy) {
        void reject();
        return;
      }
      router.push("/notes");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, review, busy, reject]);

  const diffReview = useMemo(
    () =>
      review && draftContent !== null
        ? {
            draftContent,
            lines: review.lines,
            hunks: review.hunks,
            decisions: review.decisions,
            titleChange,
            allDecided,
            busy,
            onDecide: decide,
            onApplyAll: handleApplyAll,
            onRejectAll: () => void reject(),
          }
        : undefined,
    [
      review,
      draftContent,
      titleChange,
      allDecided,
      busy,
      decide,
      handleApplyAll,
      reject,
    ]
  );

  return (
    <div className="h-full">
      <MarkdownStudio
        document={{ id: note.id, title: live.title, content: note.content }}
        onSave={handleSave}
        onRename={handleRename}
        backHref="/notes"
        backLabel="笔记库"
        contentOverride={contentOverride}
        diffReview={diffReview}
        ai={{
          context: { kind: "note", refId: note.id },
          onStreamEnd: handleAiStreamEnd,
        }}
      />
    </div>
  );
}
