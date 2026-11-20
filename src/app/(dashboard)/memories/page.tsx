import { requireAuth } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listMemories } from "@/lib/memory/store";
import {
  MemoryManager,
  type MemoryLite,
} from "@/components/memory/memory-manager";

// 记忆管理页：服务端取首屏数据（active 记忆 + 每条最近的原话），交互由 MemoryManager 接管
export default async function MemoriesPage() {
  const user = await requireAuth();

  const records = await listMemories(user.id, { status: "active" });
  const ids = records.map((record) => record.id);

  // evidence 不在 Memory 表上，从 MemoryEvent 里取「最近一条带原话」的事件
  const events =
    ids.length > 0
      ? await prisma.memoryEvent.findMany({
          where: {
            userId: user.id,
            memoryId: { in: ids },
            evidence: { not: null },
          },
          orderBy: { createdAt: "desc" },
          select: { memoryId: true, evidence: true },
        })
      : [];

  const evidenceByMemory = new Map<string, string>();
  for (const event of events) {
    if (
      event.memoryId &&
      event.evidence &&
      !evidenceByMemory.has(event.memoryId)
    ) {
      evidenceByMemory.set(event.memoryId, event.evidence);
    }
  }

  const memories: MemoryLite[] = records.map((record) => ({
    id: record.id,
    kind: record.kind,
    content: record.content,
    importance: record.importance,
    confidence: record.confidence,
    sourceType: record.sourceType,
    updatedAt: record.updatedAt.toISOString(),
    evidence: evidenceByMemory.get(record.id) ?? null,
  }));

  return (
    <div className="scenic-shell flex min-h-[calc(100dvh-5rem)] flex-col">
      <MemoryManager initialMemories={memories} />
    </div>
  );
}
