import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import ClickSpark from "@/components/landing/ClickSpark";
import { BackgroundVideo } from "@/components/layout/background-video";
import { SceneOverlay } from "@/components/layout/scene-overlay";
import { SceneProvider } from "@/context/scene-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "织念 WeaveNote",
  description: "与 AI 共笔的沉浸式笔记库——它读得懂你所有的笔记，也记得你。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className="h-full antialiased"
      // SSR 兜底：先给个默认场景，避免首帧闪白（SceneProvider 挂载后会用 localStorage 值覆盖）
      data-scene="rain"
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <SceneProvider>
          <BackgroundVideo />
          <SceneOverlay />

          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            <div className="relative z-10 flex flex-1 flex-col">
              {/* 不硬编码 sparkColor → 由组件自行读取 --primary CSS 变量，跟随场景变色 */}
              <ClickSpark sparkCount={8} sparkSize={10} sparkRadius={18} duration={450}>
                {children}
              </ClickSpark>
            </div>
            <Toaster closeButton />
          </ThemeProvider>
        </SceneProvider>
      </body>
    </html>
  );
}
