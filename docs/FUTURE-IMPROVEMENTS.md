# Future Improvements

## Image Inpainting Alternatives (Researched Dec 2025)

### Current Implementation
- **Model**: Gemini 2.5 Flash Image
- **Cost**: ~$0.04/image
- **Limitation**: No true mask support - uses text-based coordinates
- **Issue**: Large area repairs (>25% of image) fail - we skip them

### Alternative APIs Investigated

| Provider | Model | Cost/Image | Mask Support | API Complexity |
|----------|-------|------------|--------------|----------------|
| **Gemini** (current) | 2.5 Flash | ~$0.04 | Text coords only | Simple (API key) |
| **Google Imagen** | Imagen 3 | $0.04 | Binary mask + dilation | Medium (Vertex AI) |
| **Google Imagen** | Imagen 3 Fast | $0.02 | Binary mask + dilation | Medium (Vertex AI) |
| **Stability AI** | SDXL Inpaint | ~$0.01 | Full mask support | Simple (API key) |
| **Replicate** | FLUX Fill Pro | $0.05 | Paint-based mask | Simple (API key) |
| **OpenAI** | DALL-E 3 | $0.04-0.12 | Mask editing | Simple (API key) |
| **OpenAI** | GPT Image 1 Mini | $0.005-0.05 | Mask editing | Simple (API key) |

### Recommendation: Stability AI SDXL

**Best value for inpainting repairs:**
1. **Cheapest** at $0.01/image (4x cheaper than current)
2. **Simple setup** - just need API key (like Gemini)
3. **True inpainting** with binary mask support
4. Well-documented inpainting endpoint

**Imagen 3 Parameters (if we switch to Vertex AI):**
- `editMode`: `"EDIT_MODE_INPAINT_INSERTION"`
- `baseSteps`: 35-75 (quality vs speed)
- `maskDilation`: 0.01-0.02 (smooth edges)
- `maskMode`: `"MASK_MODE_USER_PROVIDED"`
- `sampleCount`: 1-4 (multiple outputs)

### Implementation Notes

If switching to Stability AI:
1. Get API key from platform.stability.ai
2. Use `/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image/masking` endpoint
3. Send binary mask (white = edit area)
4. Supports `mask_blur` for smooth blending

### Sources
- [Stability AI Pricing](https://platform.stability.ai/pricing)
- [Replicate FLUX Fill Pro](https://replicate.com/black-forest-labs/flux-fill-pro)
- [OpenAI Pricing](https://platform.openai.com/docs/pricing)
- [Vertex AI Pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Gemini Image Generation](https://ai.google.dev/gemini-api/docs/image-generation)
- [Imagen Inpainting Docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/image/edit-insert-objects)

---

## Other Future Improvements

(Add more items here as needed)
