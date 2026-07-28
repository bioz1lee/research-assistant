"""
Research Assistant 아이콘 — Squircle Navy
macOS 표준 squircle, 딥 네이비 + 상단 빛기둥 + 블루 꽃
"""
import math, os
from PIL import Image, ImageDraw, ImageFilter


def squircle_mask(size, radius_ratio=0.22):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size, size], radius=r, fill=255)
    return mask


def draw_flower_petals(d, cx, cy, petal_len, petal_w, n, fill, rotation=0):
    for i in range(n):
        rad = math.radians(rotation + (360 / n) * i)
        pts = []
        for t in range(24):
            ta = (2 * math.pi * t) / 24
            lx = math.cos(ta) * petal_w
            ly = math.sin(ta) * petal_len * 0.5 - petal_len * 0.5
            pts.append((
                lx * math.cos(rad) - ly * math.sin(rad) + cx,
                lx * math.sin(rad) + ly * math.cos(rad) + cy,
            ))
        d.polygon(pts, fill=fill)


def draw_icon(size: int) -> Image.Image:
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 배경: squircle 딥 네이비
    d.rounded_rectangle([0, 0, s, s], radius=int(s * 0.22), fill=(4, 8, 20, 255))

    cx, cy = s / 2, s / 2

    # 상단 빛기둥 (앱 배경 그라디언트 재현)
    for alpha, rad_ratio in [(25, 0.5), (40, 0.38), (60, 0.28), (80, 0.18)]:
        gr = s * rad_ratio
        glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        top_cy = cy * 0.2
        gd.ellipse([cx - gr, top_cy - gr, cx + gr, top_cy + gr],
                   fill=(48, 120, 255, alpha))
        glow = glow.filter(ImageFilter.GaussianBlur(radius=s * 0.12))
        img = Image.alpha_composite(img, glow)

    # 중앙 블루 글로우
    for gr, alpha in [(s * 0.35, 35), (s * 0.22, 65), (s * 0.12, 120)]:
        glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([cx - gr, cy - gr, cx + gr, cy + gr],
                   fill=(72, 192, 240, alpha))
        glow = glow.filter(ImageFilter.GaussianBlur(radius=s * 0.08))
        img = Image.alpha_composite(img, glow)

    d = ImageDraw.Draw(img)

    # 꽃 3겹
    draw_flower_petals(d, cx, cy, s*0.22, s*0.065, 6, (215, 242, 255, 120), 0)
    draw_flower_petals(d, cx, cy, s*0.145, s*0.048, 6, (168, 208, 245, 155), 30)
    draw_flower_petals(d, cx, cy, s*0.082, s*0.030, 6, (235, 250, 255, 200), 15)

    # 중심 원
    cr = s * 0.055
    d.ellipse([cx-cr, cy-cr, cx+cr, cy+cr], fill=(235, 250, 255, 220))
    cr2 = s * 0.025
    d.ellipse([cx-cr2, cy-cr2, cx+cr2, cy+cr2], fill=(255, 255, 255, 255))

    # 별 반짝이
    for sx, sy, sr, rot in [
        (cx + s*0.28, cy - s*0.25, s*0.018, 45),
        (cx - s*0.26, cy + s*0.22, s*0.013, 0),
        (cx + s*0.18, cy + s*0.30, s*0.010, 30),
    ]:
        for arm in range(4):
            ar = math.radians(rot + arm * 90)
            d.line([(sx + math.cos(ar)*sr*2.5, sy + math.sin(ar)*sr*2.5),
                    (sx - math.cos(ar)*sr*2.5, sy - math.sin(ar)*sr*2.5)],
                   fill=(215, 242, 255, 180), width=max(1, int(sr * 0.6)))
        d.ellipse([sx-sr*0.6, sy-sr*0.6, sx+sr*0.6, sy+sr*0.6],
                  fill=(255, 255, 255, 220))

    # squircle 마스크
    img.putalpha(squircle_mask(s))
    return img


def make_iconset(out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    for sz in [16, 32, 64, 128, 256, 512, 1024]:
        draw_icon(sz).save(os.path.join(out_dir, f"icon_{sz}x{sz}.png"))
    for sz, sz2 in {16: 32, 32: 64, 128: 256, 256: 512, 512: 1024}.items():
        draw_icon(sz2).save(os.path.join(out_dir, f"icon_{sz}x{sz}@2x.png"))
    print(f"  iconset 생성 완료: {out_dir}")


if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    make_iconset(os.path.join(base, "AppIcon.iconset"))
