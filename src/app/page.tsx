import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Brain,
  ChatsCircle,
  Leaf,
  Notebook,
  Sparkle,
} from "@phosphor-icons/react/dist/ssr";
import { getCurrentUser } from "@/lib/auth-utils";
import ShinyText from "@/components/landing/ShinyText";
import SplitText from "@/components/landing/SplitText";
import { Footer } from "@/components/landing/footer";

const features = [
  {
    icon: Notebook,
    title: "沉浸写作",
    desc: "干净的编辑器与随景背景，让你只专注于写下此刻的想法。",
  },
  {
    icon: ChatsCircle,
    title: "AI 共笔带来源",
    desc: "AI 和你一起写，每个引用都能回溯到你自己的笔记原文。",
  },
  {
    icon: Brain,
    title: "长期记忆",
    desc: "它读得懂你所有的笔记，也记得你——越用越懂你。",
  },
] as const;

export default async function LandingPage() {
  const user = await getCurrentUser();
  if (user) redirect("/notes");

  return (
    <div className="scenic-shell flex min-h-[100dvh] flex-col text-white">
      <header className="relative z-10 mx-auto flex w-full max-w-5xl items-center justify-between px-6 pt-6">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Leaf className="size-4 text-primary" weight="fill" />
          织念 WeaveNote
        </span>
        <Link
          href="/login"
          className="text-sm text-white/60 transition hover:text-white"
        >
          登录
        </Link>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-10 px-6 py-16 text-center">
        <div className="flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-1.5 text-xs text-white/70 backdrop-blur-xl">
          <Sparkle className="size-3.5 text-primary" weight="fill" />
          与 AI 共笔的沉浸式笔记库
        </div>

        <SplitText
          text="织念"
          tag="h1"
          className="text-6xl font-bold tracking-tight sm:text-7xl"
          delay={140}
        />

        <ShinyText
          text="它读得懂你所有的笔记，也记得你。"
          className="text-base sm:text-lg"
          speed={3}
          color="#9ca3af"
          shineColor="#f0fdf4"
        />

        <div className="grid w-full gap-4 sm:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="rounded-2xl border border-white/12 bg-[var(--surface-card-bg)] p-5 text-left backdrop-blur-xl"
              >
                <div className="flex size-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/12">
                  <Icon className="size-4.5 text-primary" weight="duotone" />
                </div>
                <h2 className="mt-3 text-sm font-semibold">{feature.title}</h2>
                <p className="mt-1.5 text-xs leading-5 text-white/55">
                  {feature.desc}
                </p>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/register"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg transition hover:bg-primary/90"
          >
            开始使用
            <ArrowRight className="size-4" weight="bold" />
          </Link>
          <Link
            href="/login"
            className="rounded-full border border-white/20 bg-white/10 px-6 py-3 text-sm font-semibold backdrop-blur-xl transition hover:bg-white/16"
          >
            登录
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
