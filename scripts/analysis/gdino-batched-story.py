"""
Batched GroundingDINO on the 4 real story pages (Emma greift in den Schnee).
ONE forward pass per page, all 5 character phrases; attribute boxes to
characters via the per-box label. Overlays each character's best box.
Shows: does batched detection place everyone (esp. Sarah) correctly?
"""
import os, time, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SP = "C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad/story-pages"
MODEL = "IDEA-Research/grounding-dino-base"

# name -> (short prompt, colour). Winter clothing from the story.
FIGS = {
    "Emma":   ("a preschooler girl with brown hair in a red winter jacket", (235, 64, 52)),
    "Noah":   ("a young boy with blonde hair in a green winter jacket", (52, 168, 83)),
    "Daniel": ("an adult man with a beard in a navy winter jacket", (66, 133, 244)),
    "Sarah":  ("an adult woman with blonde hair in a teal winter jacket", (244, 180, 0)),
    "Hans":   ("an elderly man with white hair and a mustache in a brown coat", (171, 71, 188)),
}

def key_tokens(phrase):
    keep = {"girl","boy","man","woman","elderly","preschooler","young","adult",
            "red","green","navy","teal","brown","white","blonde","beard","mustache"}
    return set(w for w in phrase.lower().replace(".", "").split() if w in keep)

def main():
    import torch
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
    proc = AutoProcessor.from_pretrained(MODEL)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(MODEL); model.eval()

    names = list(FIGS.keys())
    text = ". ".join(FIGS[n][0].rstrip(".") for n in names) + "."
    summary = {}
    for pg in [1, 2, 3, 4]:
        path = os.path.join(SP, f"page{pg}.jpg")
        if not os.path.exists(path):
            continue
        img = Image.open(path).convert("RGB"); W, H = img.size
        t0 = time.time()
        inputs = proc(images=img, text=text, return_tensors="pt")
        with torch.no_grad():
            out = model(**inputs)
        try:
            res = proc.post_process_grounded_object_detection(out, inputs["input_ids"], threshold=0.20, text_threshold=0.18, target_sizes=[img.size[::-1]])[0]
        except TypeError:
            res = proc.post_process_grounded_object_detection(out, threshold=0.20, text_threshold=0.18, target_sizes=[img.size[::-1]])[0]
        dt = time.time() - t0
        boxes = res["boxes"].cpu().numpy() if len(res["boxes"]) else np.zeros((0, 4))
        scores = res["scores"].cpu().numpy() if len(res["scores"]) else np.zeros((0,))
        labels = res.get("labels") or res.get("text_labels") or [""] * len(boxes)

        # Attribute: each character takes the highest-score box whose label
        # best matches its phrase tokens; each box used once.
        cand = sorted(zip(range(len(boxes)), scores.tolist(), list(labels)), key=lambda z: -z[1])
        assigned = {}
        used = set()
        for name in names:
            kt = key_tokens(FIGS[name][0])
            best = None
            for i, s, l in cand:
                if i in used:
                    continue
                lt = set(str(l).lower().replace(".", "").split())
                overlap = len(kt & lt)
                if overlap == 0:
                    continue
                if best is None or (overlap, s) > (best[0], best[1]):
                    best = (overlap, s, i)
            if best:
                assigned[name] = best[2]; used.add(best[2])

        ov = img.copy(); d = ImageDraw.Draw(ov)
        row = []
        for name in names:
            if name not in assigned:
                row.append(f"{name}:MISS"); continue
            i = assigned[name]; b = boxes[i]; c = FIGS[name][1]
            d.rectangle([b[0], b[1], b[2], b[3]], outline=c, width=6)
            d.text((b[0]+4, b[1]+4), name, fill=c)
            cx, cy = (b[0]+b[2])/2/W*100, (b[1]+b[3])/2/H*100
            row.append(f"{name}({cx:.0f},{cy:.0f}:{scores[i]:.2f})")
        ov.save(os.path.join(SP, f"batched-page{pg}.jpg"), quality=88)
        summary[pg] = {"dt": round(dt, 1), "nboxes": int(len(boxes)), "row": row}
        print(f"page {pg}: {dt:.1f}s, {len(boxes)} boxes -> {' '.join(row)}")

    json.dump(summary, open(os.path.join(SP, "batched-summary.json"), "w"), indent=1)

if __name__ == "__main__":
    main()
