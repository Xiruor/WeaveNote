import { describe, expect, it } from "vitest";
import { diffLines, mergeWithDecisions, splitHunks } from "@/lib/diff";

describe("diffLines（行级 LCS）", () => {
  it("相同文本全部为 same", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("新增行标 add，删除行标 del，顺序保持上下文", () => {
    const result = diffLines("a\nc", "a\nb\nc");
    expect(result).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("替换一行 = 删一行 + 加一行", () => {
    const result = diffLines("第一行", "第二行");
    expect(result).toEqual([
      { type: "del", text: "第一行" },
      { type: "add", text: "第二行" },
    ]);
  });

  it("末尾新增与末尾删除", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
    ]);
    expect(diffLines("a\nb", "a")).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
    ]);
  });

  it("空字符串与单行", () => {
    expect(diffLines("", "x")).toEqual([{ type: "add", text: "x" }]);
    expect(diffLines("x", "")).toEqual([{ type: "del", text: "x" }]);
  });

  it("整段重写不崩、行数守恒", () => {
    const before = "line1\nline2\nline3";
    const after = "new1\nnew2";
    const result = diffLines(before, after);
    // 结果行数 = same + add + del，且 same 行在两边都出现
    const delCount = result.filter((l) => l.type === "del").length;
    const addCount = result.filter((l) => l.type === "add").length;
    expect(delCount).toBe(3);
    expect(addCount).toBe(2);
  });
});

describe("splitHunks（不相邻改动分段）", () => {
  it("被相同行隔开的两处改动拆成两个 hunk", () => {
    const lines = diffLines("A\nB\nC", "A1\nB\nC1");
    const hunks = splitHunks(lines);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ index: 0, removed: ["A"], added: ["A1"] });
    expect(hunks[1]).toMatchObject({ index: 1, removed: ["C"], added: ["C1"] });
  });

  it("首尾相邻的增删属于同一个 hunk", () => {
    const lines = diffLines("A\nB", "A\nX\nY");
    const hunks = splitHunks(lines);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ removed: ["B"], added: ["X", "Y"] });
  });

  it("无改动时没有 hunk", () => {
    expect(splitHunks(diffLines("a\nb", "a\nb"))).toEqual([]);
  });
});

describe("mergeWithDecisions（逐段取舍合成正文）", () => {
  const lines = diffLines("A\nB\nC", "A1\nB\nC1");

  it("全部待定 = 保持原文", () => {
    expect(mergeWithDecisions(lines, {})).toBe("A\nB\nC");
  });

  it("只应用第一段：另一段保留原行", () => {
    expect(mergeWithDecisions(lines, { 0: "accepted" })).toBe("A1\nB\nC");
  });

  it("全部应用 = 提案正文", () => {
    expect(
      mergeWithDecisions(lines, { 0: "accepted", 1: "accepted" })
    ).toBe("A1\nB\nC1");
  });

  it("接受后又放弃，回到原文", () => {
    expect(
      mergeWithDecisions(lines, { 0: "rejected", 1: "rejected" })
    ).toBe("A\nB\nC");
  });

  it("纯新增段：未应用则不加行", () => {
    const insertLines = diffLines("A\nB", "A\nX\nB");
    expect(mergeWithDecisions(insertLines, {})).toBe("A\nB");
    expect(mergeWithDecisions(insertLines, { 0: "accepted" })).toBe("A\nX\nB");
  });
});
