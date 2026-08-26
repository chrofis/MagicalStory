"""
Test BATCHED GroundingDINO: all character phrases in ONE forward pass (image
encoded once) vs the current per-figure loop (image encoded N times). Measures
speed + whether per-phrase box attribution still works on the page-3 5 figures.
"""
import os, time
import numpy as np
from PIL import Image

SP = "C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad"
SRC = os.path.join(SP, "samfig-page.jpg")
MODEL = "IDEA-Research/grounding-dino-base"

FIGS = [
    ("Emma",   "a preschooler girl with brown hair in a pink top", (21, 70)),
    ("Noah",   "a young boy with blonde hair in a striped shirt", (72, 70)),
    ("Daniel", "an adult man with a beard in a green polo shirt", (56, 38)),
    ("Sarah",  "an adult woman with blonde hair and glasses in a yellow blouse", (73, 47)),
    ("Hans",   "an elderly man with white hair and a white mustache", (65, 20)),
]

def main():
    import torch
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
    proc = AutoProcessor.from_pretrained(MODEL)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(MODEL); model.eval()
    img = Image.open(SRC).convert("RGB"); W, H = img.size

    # GroundingDINO batched text: phrases separated by ". " in ONE query.
    phrases = [f[1] for f in FIGS]
    text = ". ".join(p.lower().strip().rstrip(".") for p in phrases) + "."
    t0 = time.time()
    inputs = proc(images=img, text=text, return_tensors="pt")
    with torch.no_grad():
        out = model(**inputs)
    try:
        res = proc.post_process_grounded_object_detection(out, inputs["input_ids"], threshold=0.25, text_threshold=0.20, target_sizes=[img.size[::-1]])[0]
    except TypeError:
        res = proc.post_process_grounded_object_detection(out, threshold=0.25, text_threshold=0.20, target_sizes=[img.size[::-1]])[0]
    dt = time.time() - t0
    boxes = res["boxes"].cpu().numpy() if len(res["boxes"]) else np.zeros((0, 4))
    scores = res["scores"].cpu().numpy() if len(res["scores"]) else np.zeros((0,))
    labels = res.get("labels") or res.get("text_labels") or [""] * len(boxes)
    print(f"BATCHED: 1 forward pass, {dt:.1f}s, {len(boxes)} boxes total")
    for b, s, l in sorted(zip(boxes.tolist(), scores.tolist(), list(labels)), key=lambda z: -z[1])[:20]:
        cx, cy = (b[0]+b[2])/2/W*100, (b[1]+b[3])/2/H*100
        print(f"  box ({cx:.0f},{cy:.0f}) score {s:.2f} label='{l}'")

    # Attribute: for each figure, find the returned box whose label best matches
    # its phrase AND whose centroid is nearest its truth — report hit.
    print("\n--- attribution (by label keyword + nearest) ---")
    ok = 0
    for name, phrase, truth in FIGS:
        # keyword = the most distinctive noun/colour in the phrase
        best = None
        for b, s, l in zip(boxes.tolist(), scores.tolist(), list(labels)):
            ll = str(l).lower()
            # crude: does the label overlap the phrase's key words?
            keys = [w for w in phrase.lower().split() if w in ("girl","boy","man","woman","elderly","pink","striped","green","yellow","white","brown","blonde")]
            score_match = sum(1 for k in keys if k in ll)
            cand = (score_match, s, b)
            if best is None or cand[:2] > best[:2]:
                best = cand
        if best and best[2]:
            b = best[2]; cx, cy = (b[0]+b[2])/2/W*100, (b[1]+b[3])/2/H*100
            hit = ((cx-truth[0])**2+(cy-truth[1])**2)**0.5 < 18
            if hit: ok += 1
            print(f"  {name}: ({cx:.0f},{cy:.0f}) {'CORRECT' if hit else 'wrong vs '+str(truth)}")
    print(f"=== batched attribution {ok}/5 ===")

if __name__ == "__main__":
    main()
