"""
LOCAL GroundingDINO (CPU) = the free, on-server equivalent of the Replicate
Grounded-SAM text->figure step. Find each of page 3's 5 figures by its full
identity prompt, entirely on-machine. Reports box + score + whether it landed
on the right figure, and PEAK RSS (to confirm it fits the 16GB rule).
"""
import os, json, time
import psutil
import numpy as np
from PIL import Image, ImageDraw

SP = "C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad"
SRC = os.path.join(SP, "samfig-page.jpg")
MODEL = "IDEA-Research/grounding-dino-tiny"
proc = psutil.Process()
def rss(): return proc.memory_info().rss / 1e6

# full-identity prompts (same as the Replicate run)
FIGS = [
    ("Emma",   "a preschooler girl with brown hair in a pink top and blue jeans", (21,70), (235,64,52)),
    ("Noah",   "a young boy with blonde hair in a blue and white striped shirt and navy trousers", (72,70), (52,168,83)),
    ("Daniel", "an adult man with dark brown hair and a short beard in a green polo shirt", (56,38), (66,133,244)),
    ("Sarah",  "an adult woman with blonde hair and glasses in a yellow blouse and grey trousers", (73,47), (244,180,0)),
    ("Hans",   "an elderly man with white hair and a white mustache in a beige shirt", (65,20), (171,71,188)),
]

def main():
    print(f"baseline RSS {rss():.0f} MB")
    import torch
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
    t0 = time.time()
    processor = AutoProcessor.from_pretrained(MODEL)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(MODEL)
    model.eval()
    print(f"model loaded in {time.time()-t0:.1f}s, RSS {rss():.0f} MB")

    img = Image.open(SRC).convert("RGB")
    W, H = img.size
    peak = rss()
    results = []
    for name, prompt, truth, color in FIGS:
        text = prompt.lower().strip()
        if not text.endswith("."):
            text += "."
        t1 = time.time()
        inputs = processor(images=img, text=text, return_tensors="pt")
        with torch.no_grad():
            out = model(**inputs)
        try:
            res = processor.post_process_grounded_object_detection(
                out, inputs["input_ids"], threshold=0.25, text_threshold=0.20,
                target_sizes=[img.size[::-1]])[0]
        except TypeError:
            res = processor.post_process_grounded_object_detection(
                out, threshold=0.25, text_threshold=0.20,
                target_sizes=[img.size[::-1]])[0]
        peak = max(peak, rss())
        dt = time.time() - t1
        boxes = res["boxes"].cpu().numpy() if len(res["boxes"]) else np.zeros((0,4))
        scores = res["scores"].cpu().numpy() if len(res["scores"]) else np.zeros((0,))
        if len(boxes) == 0:
            print(f"  {name}: NO BOX ({dt:.1f}s)")
            results.append({"name": name, "hit": "EMPTY", "score": None})
            continue
        bi = int(scores.argmax())
        x1, y1, x2, y2 = boxes[bi]
        cx = (x1 + x2) / 2 / W * 100
        cy = (y1 + y2) / 2 / H * 100
        dist = ((cx - truth[0]) ** 2 + (cy - truth[1]) ** 2) ** 0.5
        hit = "CORRECT" if dist < 18 else f"WRONG(centroid {cx:.0f},{cy:.0f} vs {truth})"
        print(f"  {name}: score {scores[bi]:.2f}, {len(boxes)} boxes, best centroid ({cx:.0f},{cy:.0f}) -> {hit}  [{dt:.1f}s]")
        results.append({"name": name, "hit": hit, "score": float(scores[bi]), "box": [float(v) for v in boxes[bi]], "nboxes": int(len(boxes))})
        # overlay
        ov = img.copy(); d = ImageDraw.Draw(ov, "RGBA")
        for b, s in zip(boxes, scores):
            a = 200 if (b == boxes[bi]).all() else 90
            d.rectangle([b[0], b[1], b[2], b[3]], outline=color + (a,), width=6 if a == 200 else 3)
        strip = Image.new("RGB", (W*2+10, H), "white")
        strip.paste(img.resize((W//2, H//2)), (0,0))
        strip.paste(ov.resize((W//2, H//2)), (W//2+10, 0))
        strip = strip.crop((0,0,W//2*2+10, H//2))
        strip.save(os.path.join(SP, f"gdino-{name}.jpg"), quality=86)

    json.dump({"results": results, "peak_rss_mb": round(peak)}, open(os.path.join(SP, "gdino-results.json"), "w"), indent=1)
    ncorrect = sum(1 for r in results if r["hit"] == "CORRECT")
    print(f"\n=== {ncorrect}/5 correct | peak RSS {peak:.0f} MB ===")

if __name__ == "__main__":
    main()
