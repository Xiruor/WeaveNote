// ============================================================
// 笔记语义索引：写入链路的后台任务（M1）
//
// PATCH /api/notes/[id] 落库成功后，经 next/server 的 after() 在响应
// 结束后排入后台执行（不阻塞编辑器的保存请求）。职责：
//   ① hash 增量 —— indexHash 已等于当前内容的 sha256 时直接返回（幂等）
//   ② splitMarkdown 按 ## 标题语义分块
//   ③ embedTexts 批量向量化（1024 维，与 NoteChunk.embedding 的
//      vector(1024) 列对齐）
//   ④ 事务：删旧 NoteChunk → 原始 SQL 写新块（Prisma 没有 Unsupported
//      vector 字段的 CreateInput，与 memory/store.ts 同一套写法）
//   ⑤ 全部成功后回写 indexHash；中途失败静默退出，indexHash 保持旧值，
//      检索侧的懒建兜底（indexHash !== content）下次还会再触发
// ============================================================

import { createHash, randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { splitMarkdown } from "@/lib/rag/chunk";
import { embedTexts } from "@/lib/rag/client";
import { toPgVector } from "@/lib/rag/vector";

/** 从分块文本提取所属标题（chunk 以 "#"/"## " 开头时），来源引用用 */
function headingOf(chunk: string): string | null {
  const firstLine = chunk.split("\n", 1)[0] ?? "";
  return firstLine.startsWith("#") ? firstLine.trim() : null;
}

/**
 * 笔记正文的索引指纹。
 *
 * 导出成独立函数是为了让检索侧与写入侧用**同一个**哈希口径：
 * 任何一处换了算法，另一处的「已索引」判断就会永远为假（每次都重建索引）。
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 同一篇笔记的并发索引去重。
 *
 * 写入链路的 after() 与检索侧的懒建可能同时触发同一篇笔记；
 * 没有这层去重时两边都会先看到「hash 不一致」再各烧一次 embedding。
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * 为一篇笔记重建语义索引。
 *
 * 只做增量：内容没变（indexHash 相等）就跳过，所以同一次编辑触发的
 * 多次重试、或检索侧懒建与写入链路并发触发，都不会重复烧 embedding。
 */
export function indexNote(noteId: string, userId: string): Promise<void> {
  const key = `${userId}:${noteId}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = runIndexNote(noteId, userId).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

async function runIndexNote(noteId: string, userId: string): Promise<void> {
  try {
    const note = await prisma.note.findFirst({
      where: { id: noteId, userId },
      select: { content: true, indexHash: true },
    });
    if (!note) return;

    const hash = contentHash(note.content);
    if (note.indexHash === hash) return;

    const chunks = splitMarkdown(note.content);

    // 空笔记/纯空白：清掉旧块即可，不用烧 embedding
    if (chunks.length === 0) {
      await prisma.$transaction([
        prisma.noteChunk.deleteMany({ where: { noteId } }),
        prisma.note.update({
          where: { id: noteId },
          data: { indexHash: hash },
        }),
      ]);
      return;
    }

    const embeddings = await embedTexts(chunks);

    // embedding 列是 Unsupported("vector")，Prisma 没有它的 CreateInput，
    // 走原始 SQL 写入（与 memory/store.ts 的 insertMemory 同一契约）。
    await prisma.$transaction([
      prisma.noteChunk.deleteMany({ where: { noteId } }),
      ...chunks.map((content, i) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "notechunk"
             (id, "noteId", "userId", "chunkIndex", heading, content, embedding, "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, NOW())`,
          randomUUID(),
          noteId,
          userId,
          i,
          headingOf(content),
          content,
          toPgVector(embeddings[i])
        )
      ),
    ]);

    await prisma.note.update({
      where: { id: noteId },
      data: { indexHash: hash },
    });

    console.log(`[NoteIndex] ${noteId}: ${chunks.length} 块已索引`);
  } catch (err) {
    // 静默失败：索引落后不影响功能（检索可走懒建/关键词兜底），不打扰用户
    console.error(`[NoteIndex] ${noteId}: 索引失败，等待下次重试`, err);
  }
}
