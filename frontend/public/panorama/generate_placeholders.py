"""Generate simple wide placeholder panorama JPEGs (2400x400) for the
Side by Side 360 viewer. A soft sky gradient + skyline silhouette strip is
enough for the demo; real photos will replace these before submission.
"""
import math
import os

from PIL import Image, ImageDraw

WIDTH, HEIGHT = 2400, 400
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# (top sky, mid sky, ground, silhouette) per stop
PALETTES = {
    "bundaran-hi": {
        "sky_top": (186, 224, 255),
        "sky_mid": (230, 244, 255),
        "ground": (245, 245, 245),
        "silhouette": (150, 170, 195),
        "accent": (22, 119, 255),
    },
    "senayan": {
        "sky_top": (255, 224, 186),
        "sky_mid": (255, 240, 230),
        "ground": (245, 245, 245),
        "silhouette": (190, 165, 150),
        "accent": (255, 122, 26),
    },
}


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


def make_panorama(name: str, palette: dict) -> None:
    img = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(img)

    horizon = int(HEIGHT * 0.62)

    # Vertical sky gradient, then flat ground.
    for y in range(HEIGHT):
        if y < horizon:
            t = y / horizon
            color = tuple(lerp(palette["sky_top"][i], palette["sky_mid"][i], t) for i in range(3))
        else:
            color = palette["ground"]
        draw.line([(0, y), (WIDTH, y)], fill=color)

    # Skyline silhouette: deterministic pseudo-random building blocks.
    seed = sum(ord(c) for c in name)
    x = 0
    i = 0
    while x < WIDTH:
        w = 60 + ((seed + i * 37) % 120)
        h = 30 + ((seed + i * 53) % 90)
        top = horizon - h
        draw.rectangle([x, top, x + w, horizon], fill=palette["silhouette"])
        # A few windows.
        for wx in range(x + 8, x + w - 8, 18):
            for wy in range(top + 8, horizon - 8, 22):
                if (wx * 7 + wy * 13 + seed) % 5 == 0:
                    draw.rectangle([wx, wy, wx + 6, wy + 8], fill=palette["sky_mid"])
        x += w + 14
        i += 1

    # Subtle horizontal guide lines (echo the panorama yaw sweep).
    for deg in range(0, 360, 45):
        px = int(deg / 360 * WIDTH)
        draw.line([(px, horizon + 30), (px, HEIGHT - 10)], fill=palette["accent"], width=2)

    out = os.path.join(OUT_DIR, f"{name}.jpg")
    img.save(out, "JPEG", quality=80, optimize=True)
    print(f"wrote {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    for stop, pal in PALETTES.items():
        make_panorama(stop, pal)
