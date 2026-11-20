import { Zhibao } from "@/components/ui/zhibao";

export default function DashboardLoading() {
  return (
    // 与 studio-root 纯黑兜底保持一致，dashboard→studio 路由切换过渡无跳色
    <div className="min-h-[100dvh] flex flex-col pt-20" style={{ backgroundColor: "#050505" }}>
      <div className="product-page px-4 sm:px-6 lg:px-10">
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <Zhibao scale={0.1} />
            <div className="space-y-2">
              <div className="h-3 w-24 bg-white/10 rounded animate-pulse" />
              <div className="h-3 w-16 bg-white/[0.06] rounded animate-pulse" />
            </div>
          </div>
          <div className="h-9 w-52 bg-white/10 rounded animate-pulse" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-28 bg-white/7 rounded-md animate-pulse"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
