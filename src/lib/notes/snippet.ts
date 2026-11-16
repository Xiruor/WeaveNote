// 把 Markdown 正文压成卡片展示用的纯文本摘要。
// 纯展示辅助，不含任何业务/权限逻辑；列表接口与首屏 SSR 共用，保证两处一致。
export function makeSnippet(content: string, max = 160): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, " ") // 代码块
    .replace(/`[^`\n]*`/g, " ") // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接留文字
    .replace(/^#{1,6}\s+/gm, "") // 标题符号
    .replace(/^\s*[-*+]\s+/gm, "") // 列表符号
    .replace(/^\s*>\s?/gm, "") // 引用符号
    .replace(/[*_]{1,3}/g, "") // 加粗/斜体
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}
