"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MagnifyingGlass, Notebook, Spinner } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SearchResult {
  id: string;
  title: string;
  snippet: string | null;
  updatedAt: string;
}

// Ctrl/Cmd+K 全局笔记搜索（M1 关键词档）
// 挂在 dashboard layout，工作区内任意页面按快捷键即唤起；
// 命中后跳进 /notes/[id]（(editor) 组，无导航的沉浸编辑器）。
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const timerRef = useRef<number | null>(null);
  const seqRef = useRef(0);

  // 全局快捷键：Ctrl/Cmd+K 唤起
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const search = useCallback(async (q: string) => {
    const seq = ++seqRef.current;
    if (!q.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/notes/search?q=${encodeURIComponent(q)}`);
      const data = res.ok ? await res.json() : { results: [] };
      if (seq !== seqRef.current) return; // 过期响应丢弃
      setResults(data.results ?? []);
      setActiveIndex(0);
    } catch {
      if (seq === seqRef.current) setResults([]);
    } finally {
      if (seq === seqRef.current) setSearching(false);
    }
  }, []);

  // 输入防抖搜索
  useEffect(() => {
    if (!open) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void search(query), 200);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [query, open, search]);

  function pick(note: SearchResult) {
    setOpen(false);
    setQuery("");
    setResults([]);
    router.push(`/notes/${note.id}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[activeIndex]) {
      e.preventDefault();
      pick(results[activeIndex]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>搜索笔记</DialogTitle>
          <DialogDescription>按关键词搜索你的全部笔记</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <MagnifyingGlass className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索笔记标题或正文…"
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          {searching && <Spinner className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>
        <div className="max-h-[45vh] overflow-y-auto p-1.5 thin-scrollbar">
          {query.trim() === "" ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground/60">
              输入关键词，回车或点击跳进对应笔记
            </p>
          ) : !searching && results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground/60">
              没有匹配的笔记
            </p>
          ) : (
            results.map((note, i) => (
              <button
                key={note.id}
                type="button"
                onClick={() => pick(note)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  i === activeIndex ? "bg-primary/15" : "hover:bg-white/[0.06]"
                }`}
              >
                <Notebook className="mt-0.5 size-4 shrink-0 text-primary/70" weight="duotone" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {note.title}
                  </span>
                  {note.snippet && (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70">
                      {note.snippet}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
