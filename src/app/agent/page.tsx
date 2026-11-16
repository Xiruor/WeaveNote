import { requireAuth } from "@/lib/auth-utils";
import { OnboardingProvider } from "@/components/onboarding/onboarding-provider";
import { RainforestExplorer } from "@/components/agent/rainforest-explorer";

// 智能体独立全屏页面：不在 (dashboard) 布局下 → 无顶部导航、无悬浮球；根布局提供背景视频。
// ?new=1（从外部入口跳转）→ 预填开场提示，引导用户直接开始。
// 新手引导覆盖 /agent 段落：/notes → /agent 跨布局跳页时 Provider 会重挂载，
// 这里单独挂一份 OnboardingProvider，段落才能接续播放。
export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const user = await requireAuth();
  const { new: isNew } = await searchParams;
  return (
    <OnboardingProvider userId={user.id}>
      <RainforestExplorer initialPlanner={isNew === "1"} />
    </OnboardingProvider>
  );
}
