// ============================================================
// 行级 LCS diff（M3）
//
// 提案应用前，把「当前正文」与「AI 提案的新正文」逐行对比，
// 产出 { type: same|add|del, text }[]；再按「连续改动」切成 hunk，
// 供内联 diff 视图逐段 放弃 / 应用。纯函数，不碰 DOM / 网络。
// ============================================================

export type DiffLineType = "same" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** 一段连续改动（中间不夹相同行） */
export interface DiffHunk {
  index: number;
  /** 在 DiffLine[] 里的起止下标（含） */
  start: number;
  end: number;
  removed: string[];
  added: string[];
}

/** 单段改动的处置结果；缺省 = 待定 */
export type HunkDecision = "accepted" | "rejected";

/**
 * 把 diff 行按「连续改动」切成 hunk。
 *
 * 相同行是分段边界：一段新增/删除里夹了相同行，就拆成两段，
 * 用户才能对不相邻的改动分别选择 放弃 / 应用。
 */
export function splitHunks(lines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === "same") {
      current = null;
      continue;
    }
    if (!current) {
      current = { index: hunks.length, start: i, end: i, removed: [], added: [] };
      hunks.push(current);
    }
    current.end = i;
    if (line.type === "del") current.removed.push(line.text);
    else current.added.push(line.text);
  }
  return hunks;
}

/**
 * 按 hunk 决定合成正文：
 *   · accepted → 用新增行替换删除行
 *   · rejected / 待定 → 保留原行（删除行照常输出、新增行不输出）
 *
 * 末尾换行符单独保留在 base 上（splitLines 视其为行终止符）。
 */
export function mergeWithDecisions(
  lines: DiffLine[],
  decisions: Record<number, HunkDecision>
): string {
  const hunkOfLine = new Map<number, number>();
  for (const hunk of splitHunks(lines)) {
    for (let i = hunk.start; i <= hunk.end; i++) hunkOfLine.set(i, hunk.index);
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === "same") {
      out.push(line.text);
      continue;
    }
    const decision = decisions[hunkOfLine.get(i) ?? -1];
    if (line.type === "del" && decision !== "accepted") out.push(line.text);
    if (line.type === "add" && decision === "accepted") out.push(line.text);
  }
  return out.join("\n");
}

/**
 * 把文本按行拆分。
 *
 * 空文本 → 零行；末尾的换行符是「行终止符」而非一行内容，不产生幽灵空行。
 * 中间的连续换行（如 "a\n\nb"）仍保留空行。
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * 行级 LCS（最长公共子序列）diff。
 *
 * 动态规划求两行序列的 LCS 长度表，再从右下角回溯成操作序列。
 * 时间 O(n*m)、空间 O(n*m)。笔记正文在万字级，行数通常 < 几千，
 * 二维表在这个量级可接受；内联 diff 只在单条提案渲染时调用一次。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push({ type: "same", text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      result.push({ type: "del", text: a[i - 1] });
      i--;
    } else {
      result.push({ type: "add", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    result.push({ type: "del", text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    result.push({ type: "add", text: b[j - 1] });
    j--;
  }

  return result.reverse();
}
