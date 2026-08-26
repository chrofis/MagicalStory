"""
Run MobileSAM in EVERYTHING mode (no box/point prompt) on one page image.
Auto-generates every mask the model finds, colours each distinctly, and
reports how many. Direct contrast to the box-prompted run (samfig-*).
"""
import os
import sys
import json
import numpy as np
from PIL import Image

SP = "C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad"
SRC = os.path.join(SP, "samfig-page.jpg")

# Distinct-ish colour wheel
def color(i):
    import colorsys
    r, g, b = colorsys.hsv_to_rgb((i * 0.61803398875) % 1.0, 0.65, 0.95)
    return np.array([int(r * 255), int(g * 255), int(b * 255)], dtype=np.uint8)

def main():
    from ultralytics import SAM
    m = SAM(os.environ.get("MOBILESAM_WEIGHTS", "mobile_sam.pt"))
    img = Image.open(SRC).convert("RGB")
    W, H = img.size
    # Everything mode: no bboxes/points → automatic mask generation.
    res = m(SRC, imgsz=1024, verbose=False)[0]
    if res.masks is None:
        print("no masks"); return
    masks = res.masks.data.cpu().numpy()  # [n, mh, mw]
    n = masks.shape[0]
    print(f"everything-mode masks: {n}")

    base = np.asarray(img).astype(np.float32)
    overlay = base.copy()
    # Sort by area so small masks paint last (stay visible on top of big ones)
    areas = [(masks[i] > 0.5).sum() for i in range(n)]
    order = sorted(range(n), key=lambda i: -areas[i])
    for rank, i in enumerate(order):
        mk = masks[i] > 0.5
        if mk.shape != (H, W):
            mk = np.asarray(Image.fromarray(mk.astype(np.uint8) * 255).resize((W, H), Image.NEAREST)) > 128
        c = color(rank).astype(np.float32)
        overlay[mk] = overlay[mk] * 0.45 + c * 0.55

    out = Image.fromarray(overlay.clip(0, 255).astype(np.uint8))
    out.save(os.path.join(SP, "sam-everything-page.jpg"), quality=90)
    json.dump({"masks": int(n), "areas_pct": sorted([round(a / (W * H) * 100, 1) for a in areas], reverse=True)[:15]},
              open(os.path.join(SP, "sam-everything-meta.json"), "w"))
    print("saved sam-everything-page.jpg")
    print("top mask areas (% of page):", sorted([round(a / (W * H) * 100, 1) for a in areas], reverse=True)[:12])

if __name__ == "__main__":
    main()
