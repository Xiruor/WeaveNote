// ============================================================
// 笔记混合检索的融合层（M2）
//
// 只做纯计算，不碰数据库 / 网络，方便单测与复用：
//   ① rrfFuse             —— Reciprocal Rank Fusion（k=60）
//   ② mergeAdjacentChunks —— 同一笔记同一标题下相邻块拼接
//   ③ fuseCandidates      —— 关键词（note 粒度）与语义（chunk 粒度）融合成
//                            「每篇笔记一个候选」，并支持 noteIds 过滤
//
// 为什么要 RRF 而不是加权分数：关键词命中是布尔（ILIKE）+ 更新时间，
// 语义命中是余弦相似度，两者量纲不同。RRF 只看名次，天然免疫量纲，
// 也是学术界对混合检索最常用的基线。
// ============================================================

import { makeSnippet } from "@/lib/notes/snippet";

/** RRF 常数。60 是原论文与业界最常用的取值：越大越平滑，越小越偏向头部 */
export const RRF_K = 60;

/** 单个候选最多拼接多少字（控制送 cross-encoder 的长度） */
export const MAX_MERGED_CHARS = 1600;

/** 关键词召回的一条（note 粒度） */
export interface KeywordHit {
  noteId: string;
  title: string;
  /** 正文命中处截取的摘要，展示用 */
  snippet: string;
  /** 标题是否命中 —— 融合时同一候选重复计入，实现「标题命中权重 ×2」 */
  titleHit: boolean;
}

/** 语义召回的一条（chunk 粒度） */
export interface ChunkHit {
  chunkId: string;
  noteId: string;
  title: string;
  heading: string | null;
  chunkIndex: number;
  content: string;
  similarity: number;
}

/** 融合后的候选：一篇笔记只留一条，供重排与展示 */
export interface FusedNoteCandidate {
  noteId: string;
  title: string;
  heading: string | null;
  /** 送 cross-encoder 的正文（语义块优先；没有块时退化到关键词摘要） */
  content: string;
  /** 给用户看的摘要（优先含关键词上下文的那段） */
  snippet: string;
  score: number;
}

/**
 * 关键词摘要：正文里截取命中位置附近一段；没有命中就退化成通用摘要。
 * 与 M1 命令面板的行为保持一致（前后各留一点上下文）。
 */
export function keywordSnippet(
  content: string,
  query: string,
  max = 160
): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return makeSnippet(content, max);

  const start = Math.max(0, index - 40);
  const end = Math.min(
    content.length,
    index + query.length + Math.max(40, max - 40)
  );
  return (
    (start > 0 ? "…" : "") +
    content.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < content.length ? "…" : "")
  );
}

/**
 * Reciprocal Rank Fusion：同一 key 在多路里出现就累加 1/(k + rank + 1)。
 *
 * 同一路里重复出现同一个 key 是**故意的**加权手段（标题命中在关键词路
 * 出现两次 → 近似 ×2），所以这里不去重。
 */
export function rrfFuse(
  rankedLists: readonly (readonly string[])[],
  k = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((key, rank) => {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

/**
 * 合并同一笔记、同一标题下 chunkIndex 相邻的块。
 *
 * 为什么只在同标题内合并：标题是语义边界，跨标题拼接会把两个主题
 * 塞进一个候选，重排分反而会被稀释。
 *
 * 输出顺序按每组第一块的原始名次，保证「合并」不改变召回的相对顺序。
 */
export function mergeAdjacentChunks(
  chunks: readonly ChunkHit[],
  maxChars = MAX_MERGED_CHARS
): ChunkHit[] {
  const rankOf = new Map(chunks.map((chunk, index) => [chunk.chunkId, index]));
  const groups = new Map<string, ChunkHit[]>();
  for (const chunk of chunks) {
    const key = `${chunk.noteId}\u0000${chunk.heading ?? ""}`;
    const list = groups.get(key);
    if (list) list.push(chunk);
    else groups.set(key, [chunk]);
  }

  const out: Array<{ chunk: ChunkHit; firstRank: number }> = [];

  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        a.chunkIndex - b.chunkIndex ||
        (rankOf.get(a.chunkId) ?? 0) - (rankOf.get(b.chunkId) ?? 0)
    );

    let current: ChunkHit | null = null;
    let lastIndex = -1;
    let firstRank = 0;

    for (const chunk of group) {
      const ownRank = rankOf.get(chunk.chunkId) ?? 0;
      const canMerge =
        current !== null &&
        chunk.chunkIndex === lastIndex + 1 &&
        current.content.length + chunk.content.length + 1 <= maxChars;

      if (current && canMerge) {
        current.content = `${current.content}\n${chunk.content}`;
        current.similarity = Math.max(current.similarity, chunk.similarity);
        lastIndex = chunk.chunkIndex;
        firstRank = Math.min(firstRank, ownRank);
      } else {
        if (current) out.push({ chunk: current, firstRank });
        current = { ...chunk };
        lastIndex = chunk.chunkIndex;
        firstRank = ownRank;
      }
    }
    if (current) out.push({ chunk: current, firstRank });
  }

  return out
    .sort((a, b) => a.firstRank - b.firstRank)
    .map((entry) => entry.chunk);
}

interface Accumulator {
  noteId: string;
  title: string;
  heading: string | null;
  chunkContent: string | null;
  chunkSimilarity: number;
  keywordSnippet: string;
  score: number;
}

/**
 * 把两路召回融合成「每篇笔记一个候选」，按 RRF 分数降序。
 *
 * 粒度差异的处理：
 *   · 关键词路本来就是 note 粒度，key = `note:<id>`
 *   · 语义路是 chunk 粒度，key = `chunk:<id>`；同一笔记取相似度最高的块
 *     作为代表，其余块只贡献分数（max）
 *
 * noteIds 有值时同时过滤两路（SQL 层也会过滤，这里是纯函数兜底）。
 */
export function fuseCandidates(
  keyword: readonly KeywordHit[],
  chunks: readonly ChunkHit[],
  noteIds?: readonly string[],
  k = RRF_K
): FusedNoteCandidate[] {
  const allow = noteIds && noteIds.length > 0 ? new Set(noteIds) : null;
  const kw = allow ? keyword.filter((hit) => allow.has(hit.noteId)) : keyword;
  const ch = allow ? chunks.filter((hit) => allow.has(hit.noteId)) : chunks;

  const keywordKeys: string[] = [];
  for (const hit of kw) {
    const key = `note:${hit.noteId}`;
    keywordKeys.push(key);
    // 标题命中：同一候选在这一路里出现两次 ≈ 权重 ×2
    if (hit.titleHit) keywordKeys.push(key);
  }
  const semanticKeys = ch.map((hit) => `chunk:${hit.chunkId}`);
  const scores = rrfFuse([keywordKeys, semanticKeys], k);

  const byNote = new Map<string, Accumulator>();
  const touch = (noteId: string, title: string): Accumulator => {
    const existing = byNote.get(noteId);
    if (existing) return existing;
    const next: Accumulator = {
      noteId,
      title,
      heading: null,
      chunkContent: null,
      chunkSimilarity: -1,
      keywordSnippet: "",
      score: 0,
    };
    byNote.set(noteId, next);
    return next;
  };

  for (const hit of kw) {
    const acc = touch(hit.noteId, hit.title);
    acc.score = Math.max(acc.score, scores.get(`note:${hit.noteId}`) ?? 0);
    if (!acc.keywordSnippet) acc.keywordSnippet = hit.snippet;
  }

  for (const hit of ch) {
    const acc = touch(hit.noteId, hit.title);
    acc.score = Math.max(acc.score, scores.get(`chunk:${hit.chunkId}`) ?? 0);
    if (hit.similarity > acc.chunkSimilarity) {
      acc.chunkSimilarity = hit.similarity;
      acc.heading = hit.heading;
      acc.chunkContent = hit.content;
    }
  }

  return [...byNote.values()]
    .map((acc) => {
      const content = acc.chunkContent ?? acc.keywordSnippet;
      return {
        noteId: acc.noteId,
        title: acc.title,
        heading: acc.heading,
        content,
        snippet: acc.keywordSnippet || makeSnippet(content, 160),
        score: acc.score,
      };
    })
    .sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId));
}
