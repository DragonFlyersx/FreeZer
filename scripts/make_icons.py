"""Render the FreeZer app icon set into static/icons/.

    python3 scripts/make_icons.py

Draws a snowflake on a frost-blue gradient at high resolution and downsamples,
so edges stay crisp at every size. iOS masks its own rounded corners onto the
apple-touch-icon, so the source is a full-bleed square.
"""

from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "static", "icons")

SUPER = 2048  # render size before downsampling
TOP, BOTTOM = (0x3F, 0x9A, 0xF4), (0x14, 0x5C, 0xC2)  # gradient stops
FLAKE = (255, 255, 255)

SIZES = {
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
    "favicon-32.png": 32,
}


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        draw.line([(0, y), (size, y)], fill=color)
    return img


def thick_line(draw: ImageDraw.ImageDraw, a, b, width: float) -> None:
    """A line with round caps, since PIL's own caps are square."""
    draw.line([a, b], fill=FLAKE, width=round(width))
    r = width / 2
    for x, y in (a, b):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=FLAKE)


def snowflake(img: Image.Image) -> None:
    size = img.width
    draw = ImageDraw.Draw(img)
    cx = cy = size / 2
    arm = size * 0.33
    width = size * 0.052

    def point(angle_deg: float, dist: float, origin=(cx, cy)):
        a = math.radians(angle_deg)
        return (origin[0] + math.cos(a) * dist, origin[1] - math.sin(a) * dist)

    for k in range(6):
        angle = 90 + k * 60
        tip = point(angle, arm)
        thick_line(draw, (cx, cy), tip, width)
        # two pairs of side branches, the outer pair shorter
        for frac, length in ((0.42, 0.34), (0.70, 0.24)):
            base = point(angle, arm * frac)
            for side in (-60, 60):
                thick_line(draw, base, point(angle + side, arm * length, base), width * 0.8)

    r = width * 1.15
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FLAKE)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    master = gradient(SUPER)
    snowflake(master)
    for name, size in SIZES.items():
        master.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)
        print(f"wrote {name} ({size}x{size})")


if __name__ == "__main__":
    main()
