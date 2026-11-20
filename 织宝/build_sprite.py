# -*- coding: utf-8 -*-
"""
织宝 sprite sheet 生成器
- 输入：织宝.png（RGBA，透明背景）
- 输出：zhibao-sprite.png（横排 16 帧，RGBA 透明）
- 动作：呼吸（纵向缩放）+ 上下浮动 + 轻微摇摆，循环首尾无缝

调整参数即可复用：FRAMES 帧数、BREATH 呼吸幅度、FLOAT 浮动像素、SWAY 摇摆角度
"""
import math
from PIL import Image

SRC = "织宝.png"
OUT = "zhibao-sprite.png"
PREVIEW = "frames-preview.png"

FRAMES = 16          # 帧数
CELL_W, CELL_H = 460, 482   # 单帧画布（含安全边距）
BASE_W, BASE_H = 380, 398   # 主体基准尺寸
BREATH = 0.015    # 呼吸幅度
FLOAT = 2           # 上下浮动像素
SWAY = 1           # 摇摆角度

src = Image.open(SRC).convert("RGBA")
base = src.resize((BASE_W, BASE_H), Image.LANCZOS)

sheet = Image.new("RGBA", (CELL_W * FRAMES, CELL_H), (0, 0, 0, 0))
frames = []

for i in range(FRAMES):
    t = 2 * math.pi * i / FRAMES
    breath = math.sin(t)
    sy = 1 + BREATH * breath
    sx = 1 - BREATH * 0.55 * breath        # 横向反向补偿，保持体积感
    dy = -FLOAT * math.cos(t)              # 与呼吸错相位，避免机械感
    rot = SWAY * math.sin(t + 0.9)

    fw, fh = max(1, int(round(BASE_W * sx))), max(1, int(round(BASE_H * sy)))
    frame = base.resize((fw, fh), Image.LANCZOS)
    frame = frame.rotate(rot, resample=Image.BICUBIC, expand=True)

    cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    px = (CELL_W - frame.width) // 2
    py = (CELL_H - frame.height) // 2 + int(round(dy))
    cell.alpha_composite(frame, (max(0, px), max(0, py)))
    sheet.paste(cell, (CELL_W * i, 0))
    frames.append(cell)

sheet.save(OUT, "PNG")
print("sprite:", sheet.size, sheet.mode)

# 自检预览：4x4 网格 + 棋盘格底（用于确认每帧完整、透明、无裁切）
cols, rows = 4, FRAMES // 4
tw, th = CELL_W // 2, CELL_H // 2
preview = Image.new("RGBA", (cols * tw, rows * th), (255, 255, 255, 255))
sq = 12
for y in range(0, preview.height, sq):
    for x in range(0, preview.width, sq):
        if (x // sq + y // sq) % 2:
            preview.paste((215, 215, 215, 255), (x, y, min(x + sq, preview.width), min(y + sq, preview.height)))
for idx, f in enumerate(frames):
    c, r = idx % cols, idx // cols
    preview.alpha_composite(f.resize((tw, th), Image.LANCZOS), (c * tw, r * th))
preview.convert("RGB").save(PREVIEW, quality=92)
print("preview:", preview.size)
