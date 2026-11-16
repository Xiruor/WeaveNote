import Link from "next/link";
import { Notebook } from "@phosphor-icons/react/dist/ssr";
import { getCurrentUser } from "@/lib/auth-utils";

// 笔记库占位页：暂不接数据库，只做登录门禁 + 极简占位。
export default async function NotesPage() {
  await getCurrentUser();

  return (
    <div className="scenic-shell flex min-h-[calc(100dvh-5rem)] flex-1 items-center justify-center text-white">
      <div className="flex flex-col items-center gap-4 px-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/12">
          <Notebook className="size-6 text-primary" weight="duotone" />
        </div>
        <h1 className="text-2xl font-semibold">笔记库</h1>
        <p className="max-w-md text-sm leading-6 text-white/55">
          笔记功能建设中，即将支持 Markdown 编辑与 AI 共笔。
        </p>
        <Link
          href="/agent"
          className="mt-2 rounded-full border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-medium backdrop-blur-xl transition hover:bg-white/16"
        >
          先去和 AI 聊聊
        </Link>
      </div>
    </div>
  );
}
