# Seedream 4.5 (ByteDance) — Research for MagicalStory

**Date:** 2026-02-20
**Status:** Research / Evaluation
**Purpose:** Evaluate Seedream 4.5 as a potential image generation provider alongside Gemini and Runware

## Pricing

| Provider | Cost/Image | Notes |
|----------|-----------|-------|
| BytePlus (official) | $0.04 | 200 free images trial, first-purchase discounts |
| fal.ai | $0.04 | 25 images per $1, up to 6 per API call |
| OpenRouter | $0.04 | Flat rate regardless of size |
| APIMart | $0.025 | Cheapest third-party option |

### Cost Comparison with Current Stack

| Provider | Cost/Image | Current Use |
|----------|-----------|-------------|
| Gemini 2.5 | ~$0.04-0.08 | Page illustrations, covers, avatars |
| Runware (SDXL) | $0.002 | Dev mode, inpainting |
| Seedream 4.5 | $0.025-0.04 | Not yet integrated |

A 20-page story: ~$0.80 (Seedream) vs ~$0.04 (Runware) vs ~$0.80-1.60 (Gemini).

## Character Consistency

### Reference Image Limits

| Mode | Max Reference Images | Max Output Images |
|------|---------------------|-------------------|
| Edit (single) | Up to 14 | Up to 6 |
| Edit Sequential | Up to 10 | Up to 15 |

### How It Works

- **Subject tracking**: Detects the main subject across all input images and treats them as the same person/object
- **Identity lock**: Preserves facial structure, proportions, and overall identity across every output
- **One prompt, many outputs**: A single instruction drives transformations across the batch
- **Best image first**: The model relies most heavily on the first reference image for identity

### API Parameters (Edit Sequential)

```json
{
  "prompt": "A child riding a bicycle in a park",
  "images": ["ref1.jpg", "ref2.jpg"],
  "max_images": 6,
  "size": "2048x2048"
}
```

### Comparison with Current ACE++ Setup

| Feature | Runware ACE++ | Seedream 4.5 Edit Sequential |
|---------|--------------|------------------------------|
| Reference images | 1 face reference | Up to 10 references |
| Cost/image | ~$0.002 | $0.04 |
| Character consistency | Face-swap style | Full identity tracking |
| Multi-character | Limited | Better but weak with similar-looking subjects |
| Prompt limit | 3,000 chars | Not documented (likely <10k) |
| Resolution | SDXL default | Up to 4K (4096x4096) |

## Seedream 4.5 vs Gemini 2.5 — Head-to-Head

### Seedream 4.5 Strengths

- Excellent at **illustration and stylized content** (anime, watercolor, cartoon) — ideal for children's books
- **Multi-reference consistency**: Up to 10-14 reference images to maintain character identity
- **Edit Sequential mode**: One prompt drives a batch of consistent outputs
- **Faster generation**: 5-10 seconds vs 8-15 seconds (Gemini)
- **Bold, vibrant colors**: Works well for children's content
- **Good with vague prompts**: Strong "safety net" preventing bad compositions
- **20-30% cheaper** than Gemini in most cases

### Seedream 4.5 Weaknesses

- **Text rendering only 60-70% accurate** (vs Gemini's 75-80%)
- **Complex multi-subject scenes** can misalign when characters overlap or interact
- **Similar-looking characters** (siblings, twins) may drift in identity
- **Lower global ranking**: #10 on LM Arena (score 1147) vs Gemini #2-3 (score 1235)
- **Weaker spatial reasoning** — cannot replace Gemini for quality evaluation (bounding boxes)
- **No native multimodal reasoning** — cannot analyze its own output for quality

### Gemini 2.5 Strengths

- **Superior photorealism and detail**
- **Better spatial understanding** — critical for quality eval + auto-repair pipeline
- **Multimodal reasoning** — can evaluate its own images, return bounding boxes for fix targets
- **Better text rendering** (75-80% accuracy)
- **Stronger composition** in complex multi-character scenes
- **30,000 char prompt limit** — supports very detailed scene descriptions
- **Already integrated** — no development cost

### Gemini 2.5 Weaknesses

- **Defaults toward photorealism** — needs more prompting for stylized illustration
- **Slower**: 8-15 seconds per image
- **No built-in multi-reference consistency** — relies on ACE++ and visual bible
- **More expensive** per image
- **Conservative with bold artistic styles**

### Summary Table

| Factor | Seedream 4.5 | Gemini 2.5 | Winner for MagicalStory |
|--------|-------------|------------|-------------------------|
| Illustration style quality | Strong | Needs prompting | Seedream |
| Character consistency (built-in) | 10-14 references | Prompt-based only | Seedream |
| Multi-character scenes | Struggles with overlap | Better spatial | Gemini |
| Quality eval / auto-repair | Not possible | Bounding boxes | Gemini |
| Prompt length support | Unknown (<10k?) | 30,000 chars | Gemini |
| Speed | 5-10s | 8-15s | Seedream |
| Cost | $0.025-0.04 | ~$0.04-0.08 | Seedream |
| Already integrated | No | Yes | Gemini |

## Recommendation

Seedream 4.5 is **not a straight replacement** for Gemini — it cannot handle quality evaluation or auto-repair (bounding box analysis). However, it could work well as a **complementary provider**:

1. **Use Seedream for illustration-heavy stories** where the art style benefits from its strengths
2. **Keep Gemini for quality evaluation** (required for bounding boxes / spatial reasoning)
3. **Use Seedream's edit-sequential** as an alternative to ACE++ for character consistency

### Open Questions

- Does Seedream's prompt limit support our detailed scene descriptions?
- How does edit-sequential perform with 3+ distinct characters in the same story?
- Is there a batch/bulk discount for high-volume usage?
- Which third-party provider (fal.ai, APIMart, etc.) offers the best reliability?

## Sources

- [BytePlus Official Seedream 4.5](https://www.byteplus.com/en/product/Seedream)
- [fal.ai Seedream 4.5](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image)
- [OpenRouter Seedream 4.5](https://openrouter.ai/bytedance-seed/seedream-4.5)
- [APIMart Seedream 4.5](https://apimart.ai/model/seedream-4-5)
- [Replicate Seedream 4.5](https://replicate.com/bytedance/seedream-4.5)
- [Seedream 4.5 Official](https://seed.bytedance.com/en/seedream4_5)
- [WaveSpeed: Gemini vs Seedream 2026](https://wavespeed.ai/blog/posts/gemini-image-vs-seedream-comparison-2026/)
- [WaveSpeed: Edit Sequential](https://wavespeed.ai/models/bytedance/seedream-v4.5/edit-sequential)
- [BytePlus Prompt Guide](https://docs.byteplus.com/en/docs/ModelArk/1829186)
- [Google: Gemini 2.5 Flash Image](https://developers.googleblog.com/introducing-gemini-2-5-flash-image/)
- [ImagineArt Seedream Guide](https://www.imagine.art/blogs/seedream-4-5-guide)
