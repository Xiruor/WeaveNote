// ============================================================
// pgvector 序列化格式契约
//
// 原先住在 rag/retriever.ts（知识库检索管线，已随 M0 下线，M2 以 Note 口径重建）。
// 长期记忆管线（memory/store、memory/lifecycle）仍然每天都要往 vector 列写值，
// 所以把这一个纯函数单独拎出来——它不依赖任何数据库表，是跨模块的格式契约。
// ============================================================

/**
 * 把 embedding 数组序列化成 pgvector 的输入字面量。
 *
 * pgvector 的 vector 输入格式就是 JSON 数组字面量（"[0.1,0.2,...]"），
 * 与 JSON.stringify(number[]) 的输出一致，因此可以直接作为文本参数
 * 传给 `$n::vector` 由 pgvector 解析。
 *
 * 显式命名而非各处散落裸 JSON.stringify：这是一层跨语言的格式契约，
 * 一旦上游换了序列化方式（比如加了空格或换成 Float32Array），
 * 所有写入都会失败或写进错误的值，而这里是有测试兜住的地方。
 */
export function toPgVector(vec: number[]): string {
  return JSON.stringify(vec);
}
