"""Draw the app icon (target rings) as PNG without extra libraries.

Usage: python tools/make_icons.py
"""
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "icons"
BG = (17, 20, 24)
RING = (232, 235, 239)
ACCENT = (242, 165, 22)


def pixel(x: float, y: float, size: int) -> tuple:
    c = size / 2
    r = ((x - c) ** 2 + (y - c) ** 2) ** 0.5 / (size / 2)  # 0 at centre, 1 at edge
    if r < 0.12:
        return ACCENT
    for ring in (0.30, 0.48, 0.66):
        if abs(r - ring) < 0.035:
            return RING
    return BG


def write_png(path: pathlib.Path, size: int) -> None:
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # no filter
        for x in range(size):
            rows.extend(pixel(x + 0.5, y + 0.5, size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)
    print("wrote", path)


OUT.mkdir(exist_ok=True)
write_png(OUT / "icon-180.png", 180)
write_png(OUT / "icon-512.png", 512)
