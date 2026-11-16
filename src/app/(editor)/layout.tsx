// ============================================================
// 编辑器路由组：笔记编辑器等沉浸式工作区。
//
// 与 (dashboard) 平级、不套 TopNav/AgentOrb —— 路径不冲突
// （(dashboard)/notes/page.tsx 是 /notes，这里是 /notes/[id]），
// 编辑器因此天然「沉浸」：满屏工作台，没有站点导航。
// ============================================================
import { requireAuth } from "@/lib/auth-utils";

export default async function EditorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth();
  return <div className="h-[100dvh] w-full">{children}</div>;
}
