"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Brain,
  Check,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  X,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** 记忆正文上限（与服务端 MEMORY_LIMITS.contentMaxChars 对齐） */
const CONTENT_MAX = 200;

export interface MemoryLite {
  id: string;
  kind: string;
  content: string;
  importance: number;
  confidence: number;
  sourceType: string;
  updatedAt: string;
  /** 最近一条带原话的事件摘录（可能为空） */
  evidence: string | null;
}

const KIND_LABELS: Record<string, string> = {
  goal: "目标",
  skill: "技能",
  weakness: "薄弱点",
  preference: "偏好",
  habit: "习惯",
  fact: "事实",
};

const SOURCE_LABELS: Record<string, string> = {
  user_statement: "对话陈述",
  user_correction: "更正",
  note: "笔记中记录",
  user_edit: "手动编辑",
  consolidation: "合并",
  legacy: "旧数据",
};

const KIND_FILTERS = ["all", ...Object.keys(KIND_LABELS)] as const;

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function MemoryManager({
  initialMemories,
}: {
  initialMemories: MemoryLite[];
}) {
  const [memories, setMemories] = useState(initialMemories);
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoryLite | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return memories.filter((m) => {
      if (kindFilter !== "all" && m.kind !== kindFilter) return false;
      if (q && !m.content.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [memories, kindFilter, query]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of memories) map.set(m.kind, (map.get(m.kind) ?? 0) + 1);
    return map;
  }, [memories]);

  const startEdit = useCallback((memory: MemoryLite) => {
    setEditingId(memory.id);
    setDraft(memory.content);
  }, []);

  async function save(memory: MemoryLite) {
    const content = draft.trim();
    if (!content) {
      toast.error("内容不能为空");
      return;
    }
    if (content === memory.content) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/memories/${memory.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? "保存失败");
        return;
      }
      setMemories((prev) =>
        prev.map((m) =>
          m.id === memory.id
            ? { ...m, content, updatedAt: data.memory.updatedAt }
            : m
        )
      );
      setEditingId(null);
      toast.success("已更新");
    } catch {
      toast.error("保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function remove(memory: MemoryLite) {
    setBusy(true);
    try {
      const res = await fetch(`/api/memories/${memory.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "删除失败");
        return;
      }
      setMemories((prev) => prev.filter((m) => m.id !== memory.id));
      toast.success("已删除");
    } catch {
      toast.error("删除失败，请重试");
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">记忆</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            AI 记住的关于你的目标、偏好与习惯。每条都可追溯来源，也可以随时修改或删除。
          </p>
        </div>
        <Badge variant="secondary">{memories.length} 条</Badge>
      </header>

      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl">
        {/* 筛选区 */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {KIND_FILTERS.map((key) => {
              const active = kindFilter === key;
              const label = key === "all" ? "全部" : KIND_LABELS[key];
              const count = key === "all" ? memories.length : counts.get(key) ?? 0;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setKindFilter(key)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                  }`}
                >
                  {label}
                  <span className="ml-1 opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="relative w-full sm:w-56">
            <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索记忆内容"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        {/* 列表 */}
        {visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/15 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Brain className="size-6" weight="duotone" />
            </span>
            <div>
              <p className="text-sm font-medium">
                {memories.length === 0 ? "还没有长期记忆" : "没有匹配的记忆"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {memories.length === 0
                  ? "在对话里说「记住我喜欢用中文写标题」，AI 就会记下来。"
                  : "换个关键词或类型再试试。"}
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((memory) => {
              const editing = editingId === memory.id;
              return (
                <li
                  key={memory.id}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 transition-colors hover:border-white/15"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {KIND_LABELS[memory.kind] ?? memory.kind}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {SOURCE_LABELS[memory.sourceType] ?? memory.sourceType}
                    </span>
                    <span className="text-[11px] text-muted-foreground/60">
                      置信度 {Math.round(memory.confidence * 100)}%
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground/60">
                      {formatTime(memory.updatedAt)}
                    </span>
                  </div>

                  {editing ? (
                    <div className="mt-2">
                      <Textarea
                        autoFocus
                        value={draft}
                        maxLength={CONTENT_MAX}
                        onChange={(e) => setDraft(e.target.value)}
                        className="min-h-16 text-sm"
                      />
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground/60">
                          {draft.length}/{CONTENT_MAX}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => setEditingId(null)}
                            disabled={busy}
                          >
                            <X className="size-3.5" />
                            取消
                          </Button>
                          <Button
                            size="xs"
                            onClick={() => save(memory)}
                            disabled={busy}
                          >
                            <Check className="size-3.5" />
                            保存
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
                        {memory.content}
                      </p>
                      {memory.evidence && (
                        <p className="mt-1.5 border-l-2 border-primary/30 pl-2 text-[11px] text-muted-foreground/70">
                          原话：{memory.evidence}
                        </p>
                      )}
                      <div className="mt-1.5 flex items-center gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => startEdit(memory)}
                        >
                          <PencilSimple className="size-3.5" />
                          编辑
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-muted-foreground hover:text-red-400"
                          onClick={() => setDeleteTarget(memory)}
                        >
                          <Trash className="size-3.5" />
                          删除
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除这条记忆？</DialogTitle>
            <DialogDescription>
              「{deleteTarget?.content}」将不再被 AI 引用。删除后无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-transparent">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => deleteTarget && remove(deleteTarget)}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
