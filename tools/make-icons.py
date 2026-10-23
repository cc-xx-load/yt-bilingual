"""生成扩展图标（16/48/128 PNG）。用法: python tools/make-icons.py"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"
MARK = (15, 23, 42, 255)
BORDER = (51, 65, 85, 255)
SOURCE = (248, 250, 252, 255)
TARGET = (56, 189, 248, 255)


def build(size: int = 512) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=MARK)
    d.rounded_rectangle(
        [6, 6, size - 7, size - 7],
        radius=int(size * 0.21),
        outline=BORDER,
        width=max(2, size // 128),
    )
    d.rounded_rectangle(
        [int(size * 0.16), int(size * 0.30), int(size * 0.84), int(size * 0.42)],
        radius=int(size * 0.06),
        fill=SOURCE,
    )
    d.rounded_rectangle(
        [int(size * 0.16), int(size * 0.56), int(size * 0.68), int(size * 0.68)],
        radius=int(size * 0.06),
        fill=TARGET,
    )
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = build()
    for size in (16, 48, 128):
        master.resize((size, size), Image.LANCZOS).save(OUT / f"{size}.png")
    print(f"icons written to {OUT}")


if __name__ == "__main__":
    main()
