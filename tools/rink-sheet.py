# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
# RINK agent: contact sheet of native 256x224 shots at 2x, with labels.
#   uv run tools/rink-sheet.py <dir> <out.png> [name1 name2 ...]
import sys, pathlib
from PIL import Image, ImageDraw

d = pathlib.Path(sys.argv[1])
out = sys.argv[2]
names = sys.argv[3:] or sorted(p.stem for p in d.glob('*.png') if not p.stem.endswith('-x3') and p.stem != 'ice-texture')
cols = 3
S = 2
W, H = 256 * S, 224 * S + 14
sheet = Image.new('RGB', (cols * W, ((len(names) + cols - 1) // cols) * H), (40, 40, 40))
g = ImageDraw.Draw(sheet)
for i, n in enumerate(names):
    im = Image.open(d / f'{n}.png').convert('RGB').resize((256 * S, 224 * S), Image.NEAREST)
    x, y = (i % cols) * W, (i // cols) * H
    sheet.paste(im, (x, y + 14))
    g.text((x + 4, y + 1), n, fill=(255, 255, 0))
sheet.save(out)
print(out, sheet.size)
