import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  PALETTE_MIN_SIMILARITY,
  searchNotes,
} from "@/lib/notes/search";

// GET /api/notes/search?q=... — Ctrl+K 全局搜索
//
// M2 起走混合检索（关键词 ILIKE + 语义向量 + RRF 融合，见 lib/notes/search.ts）。
// 命令面板是「按键即搜」，关掉 cross-encoder 精排换延迟：融合序对 Top20
// 的展示已经足够稳定。
//
// 返回结构保持 M1 不变（id/title/snippet/updatedAt），命令面板无需改动。
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
    if (!q) {
      return NextResponse.json({ results: [] });
    }

    const { sources } = await searchNotes(q, user.id, {
      limit: 20,
      rerank: false,
      // 展示场景：过滤掉余弦基线级的「伪相关」，避免每敲一个字都冒出一堆无关笔记
      minSimilarity: PALETTE_MIN_SIMILARITY,
    });

    // 检索层只关心排序与内容，updatedAt 由这里补上（命令面板按它展示时间）
    const ids = sources.map((source) => source.noteId);
    const rows = ids.length
      ? await prisma.note.findMany({
          where: { id: { in: ids }, userId: user.id },
          select: { id: true, updatedAt: true },
        })
      : [];
    const updatedById = new Map(rows.map((row) => [row.id, row.updatedAt]));

    return NextResponse.json({
      results: sources.map((source) => ({
        id: source.noteId,
        title: source.title,
        snippet: source.snippet,
        updatedAt: updatedById.get(source.noteId) ?? null,
      })),
    });
  } catch (error) {
    console.error("Search notes error:", error);
    return NextResponse.json(
      { error: "Failed to search notes" },
      { status: 500 }
    );
  }
}
