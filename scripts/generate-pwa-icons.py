"""PWA用の幾何学アイコンを生成する。Python標準ライブラリのみ使用。"""
from pathlib import Path
import struct
import zlib


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def pixel(x, y):
    # 512x512の座標。主要図形を中央のsafe zoneに収める。
    if 246 <= x < 266 and 105 <= y < 155:
        return (255, 255, 255)
    if (x - 256) ** 2 + (y - 105) ** 2 <= 17 ** 2:
        return (255, 255, 255)
    if 132 <= x < 380 and 155 <= y < 357:
        if (178 <= x < 215 or 297 <= x < 334) and 207 <= y < 254:
            return (51, 102, 204)
        if 192 <= x < 320 and 295 <= y < 313:
            return (51, 102, 204)
        return (255, 255, 255)
    if (110 <= x < 132 or 380 <= x < 402) and 216 <= y < 291:
        return (255, 255, 255)
    return (51, 102, 204)


def png(size):
    # 4倍のサンプリングで境界を滑らかにする。PNGは不透明RGB。
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            colors = [pixel((x + dx) * 512 / size, (y + dy) * 512 / size)
                      for dx, dy in ((.25, .25), (.75, .25), (.25, .75), (.75, .75))]
            rows.extend(round(sum(c[i] for c in colors) / 4) for i in range(3))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    output = Path(__file__).resolve().parents[1] / 'public' / 'icons'
    output.mkdir(exist_ok=True)
    for filename, size in [('icon-192.png', 192), ('icon-512.png', 512),
                           ('icon-maskable-512.png', 512), ('apple-touch-icon.png', 180)]:
        (output / filename).write_bytes(png(size))
