"""
CPU test: MobileSAM + FastSAM-s (both via ultralytics) with BOX prompts on the
10 exported crops. Measures per-image latency and peak process RSS so we know
whether either can live inside photo_analyzer.py on the 16GB machine.

Run with the isolated venv:
  venv-sam-test/Scripts/python.exe scripts/analysis/test-mobilesam-fastsam.py
Outputs mask PNGs (white figure on black) + timing.json into cpu-test/.
"""
import json
import os
import time

import psutil
import numpy as np
from PIL import Image

BASE = os.path.join(os.path.dirname(__file__), "test-output", "sam-vs-rembg", "cpu-test")
proc = psutil.Process()


def rss_mb():
    return proc.memory_info().rss / 1e6


def save_mask(result, out_path, w, h):
    """Union all returned instance masks into one white-on-black PNG."""
    if result.masks is None or len(result.masks.data) == 0:
        Image.new("L", (w, h), 0).save(out_path)
        return 0.0
    m = result.masks.data.cpu().numpy()  # [n, H, W]
    union = (m.max(axis=0) > 0.5).astype(np.uint8) * 255
    img = Image.fromarray(union, mode="L").resize((w, h), Image.NEAREST)
    img.save(out_path)
    return float((np.asarray(img) > 128).mean() * 100)


def main():
    manifest = json.load(open(os.path.join(BASE, "manifest.json")))
    print(f"baseline RSS {rss_mb():.0f} MB")

    from ultralytics import SAM, FastSAM

    timing = {}
    for model_name, model in [
        ("mobilesam", SAM("mobile_sam.pt")),
        ("fastsam", FastSAM("FastSAM-s.pt")),
    ]:
        print(f"\n=== {model_name} === (RSS after load {rss_mb():.0f} MB)")
        times, peak = [], rss_mb()
        for s in manifest:
            img_path = os.path.join(BASE, s["file"])
            t0 = time.time()
            # imgsz capped at 1024 keeps memory bounded (16GB machine rule)
            res = model(img_path, bboxes=[s["box"]], imgsz=1024, verbose=False)[0]
            dt = time.time() - t0
            times.append(dt)
            peak = max(peak, rss_mb())
            pct = save_mask(res, os.path.join(BASE, f"{s['tag']}.{model_name}.png"), s["cropW"], s["cropH"])
            print(f"  {s['tag']}: {dt:.1f}s, mask {pct:.1f}%")
        timing[model_name] = {
            "mean_s": round(sum(times) / len(times), 2),
            "max_s": round(max(times), 2),
            "peak_rss_mb": round(peak),
        }
        print(f"  mean {timing[model_name]['mean_s']}s | max {timing[model_name]['max_s']}s | peak RSS {timing[model_name]['peak_rss_mb']} MB")

    json.dump(timing, open(os.path.join(BASE, "timing.json"), "w"), indent=1)
    print("\ndone:", json.dumps(timing))


if __name__ == "__main__":
    main()
