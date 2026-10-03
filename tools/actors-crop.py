# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
# Crop + nearest-upscale a region of a native 256x224 shot for close inspection.
#   uv run tools/actors-crop.py in.png x y w h scale out.png
import sys
from PIL import Image
src, x, y, w, h, k, dst = sys.argv[1], *map(int, sys.argv[2:7]), sys.argv[7]
im = Image.open(src).crop((x, y, x + w, y + h))
im.resize((w * k, h * k), Image.NEAREST).save(dst)
