"use client";

import { Check, NotePencil, X } from "@phosphor-icons/react";
import type { DiffHunk, DiffLine, HunkDecision } from "@/lib/diff";

export interface InlineDiffProps {
  /** 标题变更（无则不显示） */
  titleChange: { from: string; to: string } | null;
  lines: DiffLine[];
  hunks: DiffHunk[];
  /** hunk.index → 决定；缺省 = 待定 */
  decisions: Record<number, HunkDecision>;
  /** 是否所有改动都已处置（处置完主按钮变「完成应用」） */
  allDecided: boolean;
  busy: boolean;
  onDecide: (index: number, decision: HunkDecision) => void;
  onApplyAll: () => void;
  onRejectAll: () => void;
}

/**
 * 编辑器内的 AI 改动对照视图：直接替换 markdown 源码区。
 *
 * 视觉约定（按需求）：
 *   · 只用 `+` / `-` 前缀与明暗对比，不用红绿、不加背景色
 *   · 删除行压暗、新增行提亮；相同行保持正文亮度偏弱
 *   · 顶部浮条与页面顶栏同款（h-14 毛玻璃 + 下边框），放 放弃全部 / 应用全部
 *   · 每一段连续改动单独给 放弃 / 应用，处置后只保留该段留下的那一半
 */
export function InlineDiff({
  titleChange,
  lines,
  hunks,
  decisions,
  allDecided,
  busy,
  onDecide,
  onApplyAll,
  onRejectAll,
}: InlineDiffProps) {
  const hunkOfLine = new Map<number, number>();
  for (const hunk of hunks) {
    for (let i = hunk.start; i <= hunk.end; i++) hunkOfLine.set(i, hunk.index);
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部浮条：与页面顶栏同款毛玻璃 */}
      <div className="relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-foreground/8 bg-background/60 px-4 text-foreground backdrop-blur-xl">
        <NotePencil size={16} weight="fill" className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">
            AI 修改建议
            <span className="ml-2 text-[10px] font-normal text-muted-foreground">
              {hunks.length} 处改动
            </span>
          </div>
          {titleChange && (
            <div className="truncate text-[10px] text-muted-foreground">
              标题「{titleChange.from}」→「{titleChange.to}」
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRejectAll}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.04] px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground disabled:opacity-50"
        >
          <X size={14} />
          放弃全部
        </button>
        <button
          type="button"
          onClick={onApplyAll}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
        >
          <Check size={14} weight="bold" />
          {allDecided ? "完成应用" : "应用全部"}
        </button>
      </div>

      {/* 正文对照 */}
      <div className="studio-scroll thin-scrollbar min-h-0 flex-1 overflow-auto py-8 font-mono text-sm leading-7">
        <div
          className="mx-auto"
          style={{
            paddingLeft: "max(2rem, calc((100% - 48rem) / 2 + 2rem))",
            paddingRight: "max(2rem, calc((100% - 48rem) / 2 + 2rem))",
          }}
        >
          {lines.map((line, i) => {
            const hunkIndex = hunkOfLine.get(i);
            const decision =
              hunkIndex === undefined ? undefined : decisions[hunkIndex];

            // 已处置的段只保留留下的那一半：应用 → 只显示新增行；放弃 → 只显示删除行
            if (decision === "accepted" && line.type === "del") return null;
            if (decision === "rejected" && line.type === "add") return null;

            const prefix =
              line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
            const tone =
              line.type === "add"
                ? "text-foreground"
                : line.type === "del"
                  ? "text-muted-foreground/45"
                  : "text-muted-foreground/80";

            // 一段改动的末尾补一行处置操作
            const hunkEnds =
              hunkIndex !== undefined && hunkOfLine.get(i + 1) !== hunkIndex;

            return (
              <div key={i}>
                <div className={`flex whitespace-pre-wrap break-words ${tone}`}>
                  <span className="w-4 shrink-0 select-none opacity-60">
                    {prefix}
                  </span>
                  <span className="min-w-0 flex-1">{line.text || " "}</span>
                </div>
                {hunkEnds && (
                  <div className="flex items-center justify-end gap-1.5 py-1">
                    {decision === undefined ? (
                      <>
                        <button
                          type="button"
                          onClick={() => onDecide(hunkIndex, "rejected")}
                          disabled={busy}
                          className="rounded-md border border-foreground/10 bg-foreground/[0.04] px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground disabled:opacity-50"
                        >
                          放弃
                        </button>
                        <button
                          type="button"
                          onClick={() => onDecide(hunkIndex, "accepted")}
                          disabled={busy}
                          className="rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                        >
                          应用
                        </button>
                      </>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/60">
                        {decision === "accepted" ? "已应用" : "已放弃"}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
