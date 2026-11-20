import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

type SpriteStyle = CSSProperties & { "--s"?: number };

interface ZhibaoProps {
  /** 缩放系数：宽高、background-size、keyframes 位移三者共用（默认 1 = 460×482） */
  scale?: number;
  className?: string;
}

/**
 * 织宝逐帧动画。
 *
 * 必须是 div + background-image（整张 16 帧雪碧图横条），不能用 <img>，
 * 否则会把 7360px 的长条整张贴出来。逐帧逻辑全部在 styles/zhibao.css。
 */
export function Zhibao({ scale = 1, className }: ZhibaoProps) {
  return (
    <div
      className={cn("zhibao", className)}
      style={{ "--s": scale } as SpriteStyle}
      aria-hidden
    />
  );
}

interface ThinkingStatusProps {
  /** 是否正在思考（只切 class，DOM 始终保留） */
  active: boolean;
  label?: string;
  scale?: number;
  className?: string;
}

/** 思考中状态行：织宝动画 + 微光扫过的文字 */
export function ThinkingStatus({
  active,
  label = "正在思考中…",
  scale = 0.1,
  className,
}: ThinkingStatusProps) {
  return (
    <div
      className={cn("zhibao-thinking", active && "is-on", className)}
      role="status"
      aria-live="polite"
      aria-hidden={!active || undefined}
    >
      <Zhibao scale={scale} />
      <span className="zhibao-status-text">{label}</span>
    </div>
  );
}
