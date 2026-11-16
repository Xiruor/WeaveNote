// ============================================================
// 笔记混合检索服务（M2）
//
// searchNotes(query, userId, opts) 四步：
//   0. 懒建索引 —— 扫最近更新的笔记，indexHash 落后就补建（最多 3 篇）
//   1. 关键词召回 Top20 —— note.title/content ILIKE（pg_trgm GIN 索引），
//      标题命中排前面
//   2. 语义召回 Top20 —— embedText(query) → notechunk HNSW 近邻
//   3. RRF 融合 + 相邻块合并（纯函数在 fusion.ts）
//   4. cross-encoder 精排 Top5；重排失败降级为融合序（现有 rerank 行为）
//
// opts.noteIds 有值时即「单笔记/指定笔记」模式，为空即「跨全部笔记」。
//
// 设计约束：
//   · 语义路任何失败（embedding 配额 / 数据库）都只降级为空召回，
//     关键词路仍然可用——检索不能因为一个可选增强而整体挂掉。
//   · 索引懒建是「检索前补一把」，不是同步阻塞建库；最多处理 3 篇，
//     避免一次搜索把整库 embedding 配额烧光。
// ============================================================

import { prisma } from "@/lib/prisma";
import { contentHash, indexNote } from "@/lib/notes/index-note";
import { makeSnippet } from "@/lib/notes/snippet";
import {
  fuseCandidates,
  keywordSnippet,
  mergeAdjacentChunks,
  type ChunkHit,
  type KeywordHit,
} from "@/lib/notes/fusion";
import { embedText } from "@/lib/rag/client";
import { rerankChunks } from "@/lib/rag/rerank";
import { toPgVector } from "@/lib/rag/vector";

const KEYWORD_TOP_K = 20;
const SEMANTIC_TOP_K = 20;
/** 送精排的候选数（与 rerank.ts 的 MAX_DOC_COUNT=50 留足余量） */
const RERANK_POOL = 20;
/** 检索前最多补建几篇笔记的索引 */
const MAX_LAZY_INDEX = 3;
/** 懒建扫描窗口：最近的 N 篇（PATCH 链路正常情况下已索引，只有 after 失败才落后） */
const LAZY_SCAN = 50;

/**
 * 命令面板（Ctrl+K）的语义召回相似度下限。
 *
 * text-embedding-v4 对中文无关文本的余弦基线约 0.2~0.38，真正相关的命中
 * 通常在 0.42 以上（实测：Raft 相关 0.48~0.93，无关/噪声 0.19~0.38）。
 * 命令面板是「找得到才有用」的展示场景，低于这个线就不展示；
 * AI 工具侧不设阈值（召回优先，由精排挑出真正相关的来源）。
 */
export const PALETTE_MIN_SIMILARITY = 0.42;

/**
 * 精排分数的噪声地板。
 *
 * qwen3-rerank 对完全不相关文档会给 0.00x 量级的分（实测无关 0.002，
 * 相关 0.9~1.0）。只过滤明确的噪声，不按分数做「相关性淘汰」——
 * 阈值淘汰在不同 rerank 模型间不可迁移，这里只去掉「明显是 0」的候选。
 */
const MIN_RERANK_SCORE = 0.01;

export interface NoteSource {
  noteId: string;
  title: string;
  heading: string | null;
  snippet: string;
  score: number;
}

export interface SearchNotesOptions {
  /** 限定在这些笔记内检索；空 = 跨全部笔记 */
  noteIds?: readonly string[];
  /** 返回来源条数，默认 8，最大 20 */
  limit?: number;
  /**
   * 是否做 cross-encoder 精排，默认 true。
   * 命令面板这类「按键即搜」的场景可以关掉换延迟——融合序已经够用。
   */
  rerank?: boolean;
  /**
   * 语义召回的最低余弦相似度，默认 0（召回优先）。
   * 命令面板展示建议传 PALETTE_MIN_SIMILARITY。
   */
  minSimilarity?: number;
}

export interface SearchNotesResult {
  query: string;
  sources: NoteSource[];
  /** 本次检索前补建索引的笔记数（诊断用） */
  reindexed: number;
}

interface SemanticRow {
  id: string;
  noteId: string;
  chunkIndex: number;
  heading: string | null;
  content: string;
  title: string;
  similarity: number;
}

/**
 * 关键词召回：Prisma 的 `contains + insensitive` 生成 ILIKE，
 * 正好走 note.title / note.content 上的 pg_trgm GIN 索引。
 */
async function keywordRecall(
  userId: string,
  query: string,
  noteIds?: readonly string[]
): Promise<KeywordHit[]> {
  const rows = await prisma.note.findMany({
    where: {
      userId,
      ...(noteIds?.length ? { id: { in: [...noteIds] } } : {}),
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { content: { contains: query, mode: "insensitive" } },
      ],
    },
    // 同分时新笔记优先；标题命中的加权在排序与融合层体现
    orderBy: { updatedAt: "desc" },
    take: KEYWORD_TOP_K,
    select: { id: true, title: true, content: true },
  });

  const lowered = query.toLowerCase();
  return rows
    .map((row) => ({
      noteId: row.id,
      title: row.title,
      snippet: keywordSnippet(row.content, query),
      titleHit: row.title.toLowerCase().includes(lowered),
    }))
    .sort((a, b) => Number(b.titleHit) - Number(a.titleHit));
}

/**
 * 语义召回：query 向量 → notechunk HNSW 余弦近邻。
 * 查询向量化失败（配额 / 网络）时返回空数组，让关键词路独立工作。
 */
async function semanticRecall(
  userId: string,
  query: string,
  noteIds?: readonly string[],
  minSimilarity = 0
): Promise<ChunkHit[]> {
  let embedding: number[];
  try {
    embedding = await embedText(query);
  } catch (err) {
    console.warn("[NoteSearch] 查询向量化失败，退化为关键词检索:", err);
    return [];
  }

  try {
    const rows = noteIds?.length
      ? await prisma.$queryRawUnsafe<SemanticRow[]>(
          `SELECT c.id, c."noteId", c."chunkIndex", c.heading, c.content, n.title,
                  (1 - (c.embedding <=> $2::vector))::float8 AS similarity
           FROM notechunk c
           JOIN note n ON n.id = c."noteId"
           WHERE c."userId" = $1
             AND n."userId" = $1
             AND c.embedding IS NOT NULL
             AND c."noteId" = ANY($3::text[])
           ORDER BY c.embedding <=> $2::vector
           LIMIT $4`,
          userId,
          toPgVector(embedding),
          [...noteIds],
          SEMANTIC_TOP_K
        )
      : await prisma.$queryRawUnsafe<SemanticRow[]>(
          `SELECT c.id, c."noteId", c."chunkIndex", c.heading, c.content, n.title,
                  (1 - (c.embedding <=> $2::vector))::float8 AS similarity
           FROM notechunk c
           JOIN note n ON n.id = c."noteId"
           WHERE c."userId" = $1
             AND n."userId" = $1
             AND c.embedding IS NOT NULL
           ORDER BY c.embedding <=> $2::vector
           LIMIT $3`,
          userId,
          toPgVector(embedding),
          SEMANTIC_TOP_K
        );

    return rows
      .filter((row) => row.similarity >= minSimilarity)
      .map((row) => ({
        chunkId: row.id,
        noteId: row.noteId,
        title: row.title,
        heading: row.heading,
        chunkIndex: row.chunkIndex,
        content: row.content,
        similarity: row.similarity,
      }));
  } catch (err) {
    console.warn("[NoteSearch] 语义召回失败，退化为关键词检索:", err);
    return [];
  }
}

/**
 * 检索前补建落后的索引。
 *
 * 只扫最近更新的 LAZY_SCAN 篇：写入链路正常时它们都已索引，只有 after()
 * 被打断才会落后。一次最多补 3 篇，宁可这次少召回一点，也不让一次搜索
 * 变成一次全库重建。
 */
async function ensureIndexed(
  userId: string,
  noteIds?: readonly string[]
): Promise<number> {
  try {
    const notes = await prisma.note.findMany({
      where: {
        userId,
        ...(noteIds?.length ? { id: { in: [...noteIds] } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: LAZY_SCAN,
      select: { id: true, content: true, indexHash: true },
    });

    const stale = notes
      .filter((note) => contentHash(note.content) !== note.indexHash)
      .slice(0, MAX_LAZY_INDEX);

    if (stale.length === 0) return 0;

    await Promise.all(stale.map((note) => indexNote(note.id, userId)));
    console.log(`[NoteSearch] 懒建索引 ${stale.length} 篇`);
    return stale.length;
  } catch (err) {
    // 懒建失败不影响检索本身：关键词路照常，语义路用旧索引
    console.error("[NoteSearch] 懒建索引失败:", err);
    return 0;
  }
}

/**
 * 笔记混合检索。返回带来源信息的候选（noteId / title / heading / snippet / score）。
 */
export async function searchNotes(
  query: string,
  userId: string,
  options: SearchNotesOptions = {}
): Promise<SearchNotesResult> {
  const q = query.trim();
  if (!q) return { query: "", sources: [], reindexed: 0 };

  const limit = Math.max(1, Math.min(options.limit ?? 8, 20));
  const noteIds = options.noteIds?.map((id) => id.trim()).filter(Boolean);

  const reindexed = await ensureIndexed(userId, noteIds);

  const [keywordHits, chunkHits] = await Promise.all([
    keywordRecall(userId, q, noteIds),
    semanticRecall(userId, q, noteIds, options.minSimilarity ?? 0),
  ]);

  const fused = fuseCandidates(
    keywordHits,
    mergeAdjacentChunks(chunkHits),
    noteIds
  );
  if (fused.length === 0) return { query: q, sources: [], reindexed };

  const pool = fused.slice(0, RERANK_POOL);

  let ordered = pool;
  let scoreByNote: Map<string, number> | null = null;

  if (options.rerank !== false) {
    const outcome = await rerankChunks(
      q,
      pool.map((candidate) => ({
        id: candidate.noteId,
        // 标题一起送检：用户经常按标题里的术语提问
        content: `${candidate.title}\n${candidate.content}`,
      }))
    );
    if (outcome) {
      const byId = new Map(pool.map((candidate) => [candidate.noteId, candidate]));
      ordered = outcome.ordered
        .map((item) => byId.get(item.id))
        .filter((candidate): candidate is (typeof pool)[number] => !!candidate)
        // 只剔除「精排几乎为 0」的明确噪声；没拿到分数的候选保留
        .filter((candidate) => {
          const score = outcome.scoreById.get(candidate.noteId);
          return score === undefined || score >= MIN_RERANK_SCORE;
        });
      scoreByNote = outcome.scoreById;
    }
  }

  const sources = ordered.slice(0, limit).map((candidate) => ({
    noteId: candidate.noteId,
    title: candidate.title,
    heading: candidate.heading,
    snippet: candidate.snippet || makeSnippet(candidate.content, 160),
    score: scoreByNote?.get(candidate.noteId) ?? candidate.score,
  }));

  return { query: q, sources, reindexed };
}
