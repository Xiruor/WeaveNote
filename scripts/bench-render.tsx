/* ============================================================
 * 渲染性能基准：文档阅读器（优化前后对比用）
 *
 * 跑法：npx tsx scripts/bench-render.tsx
 *
 * 量的是「渲染策略」而不是某个组件的最终浏览器表现，所以优化前后都能跑，
 * 数字可以直接对比：
 *   · full     —— 优化前：整篇一次性渲染
 *   · windowed —— 优化后：只渲染视口窗口内的若干块（Virtuoso 的实际行为）
 *
 * 口径说明：这里是 Node + react-dom/server 的**渲染成本**（耗时 + 产出 DOM 节点数）；
 * 浏览器里的滚动 FPS 需要真机才能测，脚本里不做假设。
 * ============================================================ */

import { performance } from "node:perf_hooks";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../src/components/ai/markdown-renderer";
import { splitMarkdownBlocks, type MarkdownBlock } from "../src/lib/studio/markdown-blocks";

// 一屏能放下的块数（实测参考值）+ overscan
const DOC_VIEWPORT_BLOCKS = 8;
const DOC_OVERSCAN_BLOCKS = 3;

/* ────────────────────────── 指标 ────────────────────────── */

interface Metric {
  ms: number;
  htmlBytes: number;
  domNodes: number;
}

function countDomNodes(html: string): number {
  const opens = html.match(/<[a-zA-Z][^>]*>/g)?.length ?? 0;
  const selfClosing = html.match(/<[a-zA-Z][^>]*\/>/g)?.length ?? 0;
  const voids = html.match(/<(img|br|hr|input|meta|link)\b[^>]*>/g)?.length ?? 0;
  return opens - selfClosing - voids;
}

/** 每项跑多轮取最小值：最小值受机器负载干扰最小，是算力基准的惯例口径 */
const RUNS = 3;

function measure(render: () => ReactElement): Metric {
  let best: Metric | null = null;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const html = renderToStaticMarkup(render());
    const ms = performance.now() - t0;
    if (!best || ms < best.ms) {//取最小的ms
      best = { ms, htmlBytes: Buffer.byteLength(html, "utf8"), domNodes: countDomNodes(html) };
    }
  }
  return best!;
}

/** 只量耗时（切块这类不产出 DOM 的步骤） */
function measureMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const fmt = (n: number, d = 1) => n.toFixed(d);
const kb = (b: number) => `${fmt(b / 1024)} KB`;

function row(cells: string[]) {
  console.log(cells.map((c) => c.padEnd(12)).join(""));
}

/* ────────────────────── 合成 Markdown 文档 ────────────────────── */

type BlockKind = "heading" | "paragraph" | "code" | "table" | "list" | "image";
const CYCLE: BlockKind[] = [
  "heading",
  "paragraph",
  "paragraph",
  "code",
  "list",
  "paragraph",
  "table",
  "image",
];

function makeBlock(kind: BlockKind, i: number): string {
  switch (kind) {
    case "heading":
      return `## 第 ${i} 节 主题标题\n`;
    case "paragraph":
      return (
        `这是第 ${i} 段正文内容，用于模拟真实文档中的说明文字。` +
        `其中包含 **加粗**、*斜体*、\`行内代码\` 与 [链接](https://example.com/${i})，` +
        `长度接近真实段落，以便测量换行后的实际高度。\n`
      );
    case "code":
      return (
        "```ts\n" +
        `// 代码块 ${i}\n` +
        "export function solve(n: number): number {\n" +
        "  if (n <= 1) return n;\n" +
        "  return solve(n - 1) + solve(n - 2);\n" +
        "}\n" +
        "```\n"
      );
    case "table":
      return (
        "| 字段 | 类型 | 说明 |\n" +
        "| --- | --- | --- |\n" +
        `| id | string | 第 ${i} 项唯一标识 |\n` +
        "| name | string | 名称 |\n" +
        "| score | number | 评分 |\n"
      );
    case "list":
      return (
        `- 第 ${i} 项要点一\n` +
        `- 第 ${i} 项要点二，稍微长一点的描述文字\n` +
        `- [x] 第 ${i} 项已完成的任务\n`
      );
    case "image":
      return `![示意图 ${i}](https://example.com/img/${i}.png)\n`;
  }
}

function makeDoc(totalBlocks: number): string {
  const parts: string[] = ["# 压力测试文档\n"];
  for (let i = 1; i < totalBlocks; i++) parts.push(makeBlock(CYCLE[i % CYCLE.length], i));
  return parts.join("\n");
}

/* ────────────────────────── 文档基准 ────────────────────────── */

function benchDocs() {
  console.log("【文档阅读器】整篇渲染 vs 虚拟窗口渲染\n");
  row(["顶层块数", "策略", "耗时 ms", "HTML", "DOM 节点", "渲染块数", "切块 ms"]);

  const docTotals = [100, 500, 1000, 3000];
  for (const n of docTotals) {
    const doc = makeDoc(n);
    const full = measure(() => createElement(MarkdownRenderer, { content: doc }) as ReactElement);
    row([String(n), "full", fmt(full.ms), kb(full.htmlBytes), String(full.domNodes), String(n), "—"]);

    // 切块本身也是新增开销，如实量出来（它只扫一遍源串，不解析 Markdown）
    let blocks: MarkdownBlock[] = [];
    const splitMs = measureMs(() => {
      blocks = splitMarkdownBlocks(doc);
    });
    const window = blocks.slice(0, DOC_VIEWPORT_BLOCKS + DOC_OVERSCAN_BLOCKS);
    const win = measure(
      () =>
        createElement(
          "div",
          null,
          ...window.map((b, i) =>
            createElement(MarkdownRenderer, { key: i, content: b.source })
          )
        ) as ReactElement
    );
    row([
      String(n),
      "windowed",
      fmt(win.ms),
      kb(win.htmlBytes),
      String(win.domNodes),
      String(window.length),
      fmt(splitMs),
    ]);
    console.log("");
  }

  // 对照模式：改一个字符，阅读面板要重渲染多少
  console.log("【文档阅读器】对照模式改一个字符后的重渲染代价");
  const doc = makeDoc(3000);
  const blocks = splitMarkdownBlocks(doc);
  const fullMs = measureMs(() => {
    renderToStaticMarkup(createElement(MarkdownRenderer, { content: doc + "a" }) as ReactElement);
  });
  const mid = blocks[Math.floor(blocks.length / 2)];
  const blockMs = measureMs(() => {
    renderToStaticMarkup(createElement(MarkdownRenderer, { content: mid.source + "a" }) as ReactElement);
  });
  console.log(`  优化前（整篇重解析）       ${fmt(fullMs)} ms`);
  console.log(`  优化后（只重解析被改的块）   ${fmt(blockMs)} ms`);
  console.log(`  倍数                       ${fmt(fullMs / Math.max(blockMs, 0.01), 0)}×\n`);
}

/* ────────────────────────── 主流程 ────────────────────────── */

function main() {
  console.log("渲染性能基准（Node + react-dom/server，对比的是渲染成本）\n");
  console.log(
    `  窗口设定：文档 ${DOC_VIEWPORT_BLOCKS} 块 + overscan ${DOC_OVERSCAN_BLOCKS} 块\n`
  );
  benchDocs();
}

main();
