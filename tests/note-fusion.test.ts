import { describe, expect, it } from "vitest";
import {
  fuseCandidates,
  keywordSnippet,
  mergeAdjacentChunks,
  rrfFuse,
  type ChunkHit,
  type KeywordHit,
} from "@/lib/notes/fusion";

function chunk(overrides: Partial<ChunkHit> & Pick<ChunkHit, "chunkId">): ChunkHit {
  return {
    noteId: "n1",
    title: "笔记一",
    heading: "## 标题",
    chunkIndex: 0,
    content: "正文",
    similarity: 0.8,
    ...overrides,
  };
}

function keyword(overrides: Partial<KeywordHit> & Pick<KeywordHit, "noteId">): KeywordHit {
  return {
    title: "笔记",
    snippet: "摘要",
    titleHit: false,
    ...overrides,
  };
}

describe("rrfFuse", () => {
  it("同一 key 在多路命中时分数累加，且名次越靠前越高", () => {
    const scores = rrfFuse([["a", "b"], ["b", "a"]], 60);
    expect(scores.get("a")).toBeCloseTo(1 / 61 + 1 / 62);
    expect(scores.get("b")).toBeCloseTo(1 / 62 + 1 / 61);
    expect(scores.get("a")).toBeCloseTo(scores.get("b")!);
  });

  it("同一路里重复出现的 key 会被累加（标题命中 ×2 的实现基础）", () => {
    const scores = rrfFuse([["a", "a", "b"]], 60);
    expect(scores.get("a")).toBeCloseTo(1 / 61 + 1 / 62);
    expect(scores.get("b")).toBeCloseTo(1 / 63);
  });
});

describe("mergeAdjacentChunks", () => {
  it("同一笔记同一标题下相邻的块会拼接，跳过缺失的块不合并", () => {
    const merged = mergeAdjacentChunks([
      chunk({ chunkId: "c0", chunkIndex: 0, content: "第一段" }),
      chunk({ chunkId: "c1", chunkIndex: 1, content: "第二段", similarity: 0.6 }),
      chunk({ chunkId: "c3", chunkIndex: 3, content: "第四段" }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0].chunkId).toBe("c0");
    expect(merged[0].content).toBe("第一段\n第二段");
    expect(merged[0].similarity).toBe(0.8); // 保留组内最高相似度
    expect(merged[1].chunkId).toBe("c3");
  });

  it("不同标题 / 不同笔记不合并", () => {
    const merged = mergeAdjacentChunks([
      chunk({ chunkId: "a0", heading: "## A", chunkIndex: 0 }),
      chunk({ chunkId: "b0", heading: "## B", chunkIndex: 1 }),
      chunk({ chunkId: "c0", noteId: "n2", heading: "## A", chunkIndex: 1 }),
    ]);

    expect(merged).toHaveLength(3);
    expect(merged.map((item) => item.chunkId).sort()).toEqual(["a0", "b0", "c0"]);
  });

  it("合并后不超过字数上限", () => {
    const merged = mergeAdjacentChunks(
      [
        chunk({ chunkId: "c0", chunkIndex: 0, content: "a".repeat(10) }),
        chunk({ chunkId: "c1", chunkIndex: 1, content: "b".repeat(10) }),
      ],
      15
    );
    expect(merged).toHaveLength(2);
  });
});

describe("fuseCandidates", () => {
  it("按 RRF 分数排序：关键词与语义都命中的笔记胜出", () => {
    const fused = fuseCandidates(
      [keyword({ noteId: "n1", titleHit: false })],
      [
        chunk({ chunkId: "c1", noteId: "n1", chunkIndex: 1 }),
        chunk({ chunkId: "c2", noteId: "n2" }),
      ]
    );

    expect(fused.map((item) => item.noteId)).toEqual(["n1", "n2"]);
    expect(fused[0].heading).toBe("## 标题");
    expect(fused[0].content).toBe("正文");
  });

  it("标题命中权重 ×2：排名靠后的标题命中可以反超", () => {
    const fused = fuseCandidates(
      [
        keyword({ noteId: "n2", titleHit: false }),
        keyword({ noteId: "n1", titleHit: true }),
      ],
      []
    );

    expect(fused.map((item) => item.noteId)).toEqual(["n1", "n2"]);
  });

  it("noteIds 有值时只保留指定笔记（两路都过滤）", () => {
    const fused = fuseCandidates(
      [keyword({ noteId: "n1" }), keyword({ noteId: "n2" })],
      [chunk({ chunkId: "c2", noteId: "n2" })],
      ["n1"]
    );

    expect(fused.map((item) => item.noteId)).toEqual(["n1"]);
    expect(fused[0].content).toBe("摘要");
  });

  it("每篇笔记只留一个候选，摘要优先取关键词命中上下文", () => {
    const fused = fuseCandidates(
      [keyword({ noteId: "n1", snippet: "…Raft 选举…" })],
      [
        chunk({ chunkId: "c1", noteId: "n1", content: "语义块一" }),
        chunk({ chunkId: "c2", noteId: "n1", chunkIndex: 2, content: "语义块二", similarity: 0.9 }),
      ]
    );

    expect(fused).toHaveLength(1);
    expect(fused[0].snippet).toBe("…Raft 选举…");
    expect(fused[0].content).toBe("语义块二"); // 相似度最高的块作为代表
  });
});

describe("keywordSnippet", () => {
  it("截取命中位置附近的内容并补省略号", () => {
    const content = `${"前".repeat(100)}leader 选举${"后".repeat(100)}`;
    const snippet = keywordSnippet(content, "leader 选举", 80);
    expect(snippet).toContain("leader 选举");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("没有命中时退化为普通摘要", () => {
    const snippet = keywordSnippet("这是一段没有关键词的正文", "raft");
    expect(snippet.length).toBeGreaterThan(0);
    expect(snippet).not.toContain("…");
  });
});
