-- ============================================================
-- 笔记检索索引：notechunk.embedding 的 HNSW + note 标题/正文的 pg_trgm
--
-- 为什么需要本脚本
--   schema §4（笔记库 Folder / Note / NoteChunk / NoteProposal）里能建的
--   都是 Prisma DSL 表达得了的普通 B-tree 索引，而检索需要两类它建不了的索引：
--     · notechunk.embedding 的 HNSW 向量索引（语义检索，查询用 <=> 余弦距离）
--     · note.title / note.content 的 pg_trgm GIN 索引（ILIKE 关键词召回）
--   与 add-memory-v2.sql 的处理方式相同：表结构交给 prisma db push，
--   索引由本脚本补齐。
--
-- 配合
--   表结构见 schema.prisma §4（Folder / Note / NoteChunk / NoteProposal）。
--
-- 部署流程
--   1. npx prisma db push     （建/改表，含 folder、note、notechunk、noteproposal）
--   2. 执行本脚本             （补 HNSW / trgm 索引）
--
-- 幂等性
--   · 扩展用 IF NOT EXISTS；索引先 DROP INDEX IF EXISTS 再 CREATE，可重复执行。
--   · pgvector 的 vector 扩展已随 migrate-to-pgvector.sql 启用，这里不重复建。
--
-- 执行方式
--   npx prisma db execute --file prisma/add-note-search.sql
--   （不要用 psql 元命令 \echo —— prisma db execute 只认纯 SQL）
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS notechunk_embedding_hnsw;
CREATE INDEX notechunk_embedding_hnsw
  ON notechunk USING hnsw (embedding vector_cosine_ops);

DROP INDEX IF EXISTS note_title_trgm;
CREATE INDEX note_title_trgm
  ON note USING gin (title gin_trgm_ops);

DROP INDEX IF EXISTS note_content_trgm;
CREATE INDEX note_content_trgm
  ON note USING gin (content gin_trgm_ops);

-- 校验（应列出三个索引）
SELECT indexname, indexdef FROM pg_indexes
WHERE indexname IN ('notechunk_embedding_hnsw', 'note_title_trgm', 'note_content_trgm');
