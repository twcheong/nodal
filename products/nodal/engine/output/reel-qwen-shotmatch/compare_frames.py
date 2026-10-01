"""Read-only QA sheets; production frames are never modified here."""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).parent
SOURCE = ROOT.parent / "reel-DcvQpQfJ6EB"
REFERENCES = [4, 5, 6, 8, 10, 12, 14, 16, 17, 20, 24.3]


def main() -> None:
    pairs = []
    thumbnails = []
    destination = ROOT / "qa"
    destination.mkdir(exist_ok=True)
    review_path = destination / "frame-review.json"
    reviews = (
        json.loads(review_path.read_text(encoding="utf-8"))["shots"] if review_path.exists() else []
    )
    selected = {entry["shot"]: entry for entry in reviews}
    for number, seconds in enumerate(REFERENCES, 1):
        entry = selected.get(number, {})
        generated = ROOT / (entry.get("selected") or f"frames/shot-{number:02d}.png")
        if not generated.exists():
            continue
        source = SOURCE / (
            f"frame-{seconds:05.1f}.png" if number != 11 else "transition-24.300.png"
        )
        pair = Image.new("RGB", (1920, 580), "#181b1d")
        draw = ImageDraw.Draw(pair)
        draw.text((12, 12), f"SHOT {number:02d} | SOURCE {seconds}s", fill="white")
        state = entry.get("status", "not reviewed").upper()
        draw.text((972, 12), f"QWEN | {state}", fill="white")
        for x, path in ((0, source), (960, generated)):
            with Image.open(path) as image:
                preview = ImageOps.contain(image.convert("RGB"), (960, 540))
                pair.paste(preview, (x, 40))
        pair.save(destination / f"shot-{number:02d}-comparison.jpg", quality=94)
        pairs.append(pair.resize((1280, 387)))
        tile = Image.new("RGB", (512, 316), "#181b1d")
        with Image.open(generated) as image:
            tile.paste(ImageOps.contain(image.convert("RGB"), (512, 288)), (0, 28))
        ImageDraw.Draw(tile).text((10, 8), f"SHOT {number:02d} | {state}", fill="white")
        thumbnails.append(tile)
    if pairs:
        sheet = Image.new("RGB", (1280, 387 * len(pairs)), "#181b1d")
        for index, pair in enumerate(pairs):
            sheet.paste(pair, (0, index * 387))
        sheet.save(destination / "shot-comparisons.jpg", quality=92)
        board = Image.new("RGB", (1536, 316 * ((len(thumbnails) + 2) // 3)), "#181b1d")
        for index, tile in enumerate(thumbnails):
            board.paste(tile, ((index % 3) * 512, (index // 3) * 316))
        board.save(destination / "storyboard-contact-sheet.jpg", quality=94)
    print(f"Reviewed-source comparison sheets available: {len(pairs)}")


if __name__ == "__main__":
    main()
