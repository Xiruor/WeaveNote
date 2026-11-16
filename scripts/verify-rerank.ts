/* ============================================================
 * Rerank 验证：打真实 API，确认 cross-encoder 精排真的在起作用
 *
 * 用法:  tsx scripts/verify-rerank.ts
 *
 * 覆盖：
 *   ① 契约正确性 —— 明显相关的文档必须排第一；分数是数字、降序
 *
 * （旧版还有基于 documentChunk 真实语料的名次变化与延迟基准，
 *   知识库下线、documentChunk 表删除后随之移除。）
 *
 * ⚠️ 为什么必须 loadEnv 之后**动态** import：
 *    model-pool 的 PROVIDER_CONFIG 是模块级 const，在 import 时就读 process.env。
 *    ESM 的 import 语句会被提升到模块顶部、先于 loadEnv() 求值，静态引入会拿到
 *    空 API key，报出误导性的"embedding/rerank 档无可用的模型"。
 * ============================================================ */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ms = (t: number) => `${t.toFixed(0)}ms`;

async function main() {
  const { rerankWithFallback, getRerankChain } = await import("../src/lib/model-pool");

  console.log(`链路: ${getRerankChain().map((m) => m.modelName).join(" → ")}\n`);

  // ============================================================
  console.log("① 契约正确性（固定语料）");
  // ============================================================
  const query = "什么是 pgvector 的余弦距离算子";
  const docs = [
    "今天天气不错，适合出门散步", // 无关
    "pgvector 用 <=> 计算余弦距离，ORDER BY 升序即最相似", // 明显相关
    "PostgreSQL 的索引类型有 B-tree、GIN 和 GiST", // 弱相关
  ];

  const t0 = Date.now();
  let res: Awaited<ReturnType<typeof rerankWithFallback>>;
  try {
    res = await rerankWithFallback(query, docs);
  } catch (err) {
    check("重排调用成功", false, String(err));
    console.log("\n⚠️ 重排不可用，验证中止");
    process.exit(1);
  }
  const rerankMs = Date.now() - t0;

  check("重排调用成功", true, `model=${res.model} 耗时=${ms(rerankMs)}`);
  check(
    "明显相关的那篇排第一",
    res.data[0]?.index === 1,
    `top1 = docs[${res.data[0]?.index}] "${docs[res.data[0]?.index]?.slice(0, 24)}…"`
  );
  check(
    "分数都是有限数字",
    res.data.every((s) => Number.isFinite(s.score) && typeof s.score === "number"),
    res.data.map((s) => s.score.toFixed(4)).join(", ")
  );
  const sorted = [...res.data].sort((a, b) => b.score - a.score);
  check(
    "服务端已按相关性降序返回",
    res.data.every((s, i) => s.index === sorted[i].index)
  );

  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ 验证脚本异常:", err);
  process.exit(1);
});
