# Video Generation API Research (January 2026)

## Cost Comparison

### Per-Second Pricing

| Provider | Model | Cost/Second | 10s Video | Notes |
|----------|-------|-------------|-----------|-------|
| MiniMax/Hailuo | 2.3 Fast | $0.034 | $0.34 | Cheapest quality option |
| **Grok Imagine** | Standard | $0.05 | $0.50 | Competitive, fast generation |
| Runway | Gen-4 Turbo | $0.05 | $0.50 | 5 credits/sec @ $0.01/credit |
| Kling AI | Standard | $0.059 | $0.59 | Good quality/price, up to 2 min |
| MiniMax/Hailuo | 2.3 Standard | $0.059 | $0.59 | Good budget option |
| Runway | Gen-4 Standard | $0.10-0.12 | $1.00-1.20 | 10-12 credits/sec |
| Google Veo 2 | Gemini API | $0.35 | $3.50 | 30% cheaper than Vertex |
| Google Veo 2 | Vertex AI | $0.50 | $5.00 | Highest quality |

### Subscription Plans (Alternative to API)

| Platform | Plan | Monthly Cost | Included | Per-Video Cost |
|----------|------|--------------|----------|----------------|
| Runway Standard | 625 credits | $12/mo | ~60s Gen-4 | ~$0.20/sec |
| Runway Pro | 2,250 credits | $28/mo | ~225s Gen-4 | ~$0.12/sec |
| Kling Standard | 660 credits | $10/mo | ~33 videos (10s) | ~$0.30/video |
| MiniMax Unlimited | Unlimited | $95/mo | Unlimited | Best for high volume |
| Luma Unlimited | Unlimited | $30/mo | Unlimited | Good for experimentation |

---

## Image Input Capabilities

### Keyframe Support

| Platform | Image Inputs | Keyframes | Max Duration | Notes |
|----------|--------------|-----------|--------------|-------|
| Runway Gen-3 Alpha | 2 | First + last | 10s | Good control |
| Runway Gen-3 Turbo | 3 | First + middle + last | 10s | Best keyframe control |
| Runway Gen-4 | 1 + references | Character consistency | 5-10s | Reference-based |
| Google Veo 2 | 1-3 subject + style | First + last | 8s | Most reference options |
| Google Veo 3.1 | First + last | Yes | 8s | No style images |
| Kling AI | Multiple | Yes | 120s | Longest duration |
| Grok Imagine | 1 | No | ~6s | Single image only |
| MiniMax/Hailuo | 1 | No | 6s | Single image |

### Reference Image Types (Veo 2)

- **Subject images**: 1-3 images for character/object consistency
- **Style images**: 1 image to transfer visual style
- **First/last frame**: Control start and end of video

---

## Story Book Use Case

### Cost Estimates (12-page story, 5s video per page)

| Tier | Provider | Cost/Page | Total Cost |
|------|----------|-----------|------------|
| Budget | MiniMax/Hailuo | $0.17-0.30 | $2-4 |
| Mid-range | Kling/Grok/Runway Turbo | $0.25-0.50 | $3-6 |
| Premium | Runway Gen-4 | $0.50-0.60 | $6-7 |
| Ultra | Google Veo 2 | $1.75-2.50 | $21-30 |

### Recommended Approach

**For page-to-page transitions:**
- Use **Veo 2** or **Runway** with first/last frame keyframes
- Input: Page N image → animate → Page N+1 image
- Creates smooth transitions between story pages

**For single page animation:**
- Use **Grok Imagine** ($0.05/sec) or **Kling** ($0.059/sec)
- Input: Single page image → add subtle motion
- Good for bringing illustrations to life

**For character consistency across clips:**
- Use **Kling AI** with multiple reference images
- Or **Veo 2** with subject reference images (1-3)

---

## Platform Details

### Runway (Gen-3/Gen-4)

- **API**: Credit-based ($0.01/credit)
- **Gen-4 Turbo**: 5 credits/sec (~$0.05/sec)
- **Gen-4 Standard**: 10-12 credits/sec (~$0.10-0.12/sec)
- **4K upscale**: +2 credits/sec
- **Keyframes**: 2-3 images supported
- **Docs**: https://docs.dev.runwayml.com/guides/pricing/

### Google Veo 2

- **API**: Vertex AI or Gemini API
- **Vertex AI**: $0.50/sec
- **Gemini API**: $0.35/sec (30% cheaper)
- **Duration**: 5-8 seconds per generation
- **References**: 1-3 subject + 1 style image
- **Keyframes**: First + last frame supported
- **Docs**: https://cloud.google.com/vertex-ai/generative-ai/pricing

### Grok Imagine (xAI)

- **API**: Via fal.ai
- **Cost**: $0.05/sec output
- **Image-to-Video (6s)**: $0.302
- **Text-to-Video (6s)**: $0.30
- **Video Editing (6s)**: $0.36
- **Keyframes**: Not supported (single image)
- **Docs**: https://fal.ai/models/xai/grok-imagine-video

### Kling AI

- **API**: Direct or via aggregators
- **Cost**: $0.059/sec
- **Max duration**: 120 seconds (longest)
- **Multi-image**: Supported for consistency
- **Good for**: Natural human motion, longer clips
- **Docs**: https://klingai.com/global/dev/pricing

### MiniMax/Hailuo

- **API**: Via AI/ML API or direct
- **Hailuo 2.3 Fast**: $0.034/sec (cheapest)
- **Hailuo 2.3 Standard**: $0.059/sec
- **Duration**: ~6 seconds
- **Best for**: High volume, budget projects
- **Docs**: https://aimlapi.com/ai-ml-api-pricing

### Luma AI (Ray 2)

- **Pricing**: Per-pixel based (~$0.05-0.10/sec equivalent)
- **Subscription**: $30/mo unlimited
- **Special**: Loop function for animations
- **Good for**: Experimentation, anime-style

---

## Quality Comparison

| Provider | Motion Quality | Character Consistency | Prompt Following |
|----------|---------------|----------------------|------------------|
| Google Veo 2 | Excellent | Very Good (with refs) | Excellent |
| Runway Gen-4 | Excellent | Good | Very Good |
| Kling AI | Very Good | Very Good | Good |
| Grok Imagine | Good | Medium | Good |
| MiniMax/Hailuo | Good | Medium | Good |
| Luma | Good | Medium | Good |

---

## API Integration Notes

### Authentication

| Provider | Auth Method |
|----------|-------------|
| Runway | API key + credits |
| Google Veo | Service account (Vertex) or API key (Gemini) |
| Grok/xAI | API key via fal.ai |
| Kling | API key |
| MiniMax | API key via AI/ML API |

### Aggregator APIs

Several aggregators provide unified access to multiple models:
- **fal.ai** - Grok, Veo, others
- **AI/ML API** - Kling, MiniMax, Veo, Luma
- **Replicate** - Various models, pay-per-use

---

## Sources

- [Runway API Pricing](https://docs.dev.runwayml.com/guides/pricing/)
- [Google Vertex AI Pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Grok Imagine on fal.ai](https://fal.ai/models/xai/grok-imagine-video/image-to-video)
- [Kling AI Pricing](https://klingai.com/global/dev/pricing)
- [AI/ML API Pricing](https://aimlapi.com/ai-ml-api-pricing)
- [Veo Reference Images Guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/use-reference-images-to-guide-video-generation)
- [Video Generation Cost Analysis 2026](https://dev.to/toryreut/everyones-generating-videos-i-calculated-what-ai-video-actually-costs-in-2026-37ag)
- [Best Image-to-Video Generators 2026](https://beebom.com/best-image-to-video-ai/)
