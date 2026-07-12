# BuildKit parser directive — silence the SecretsUsedInArgOrEnv warning for
# the VITE_* ARGs below. They are public frontend keys (Turnstile site key,
# API URL, Google OAuth client ID), not secrets — safe to bake into the
# client bundle. This directive must sit before any instruction; an inline
# `# check=skip=` next to the ARG itself doesn't work.
# check=skip=SecretsUsedInArgOrEnv

# Use Node.js 22 LTS base image with Python pre-installed.
# Bumped from Node 18 (EOL for AWS SDK v3 in Jan 2026); Node 22 is the
# current LTS, supported through April 2027.
FROM node:22

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files for server
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies for server (--omit=dev replaces the deprecated
# --production flag).
RUN npm install --omit=dev

# Torch CPU build FIRST — requirements.txt's ultralytics depends on torch,
# and without a preinstalled CPU build pip resolves the default Linux wheels,
# which drag in ~2.5GB of CUDA libraries this CPU-only container can't use.
#
# numpy MUST be co-pinned here to the same version requirements.txt pins.
# Without it, torch pulls numpy 2.x, and the later `-r requirements.txt`
# DOWNGRADE to numpy==1.24.3 leaves a mixed 2.x/1.x tree in dist-packages
# (--break-system-packages overlay) → `AttributeError: numpy._globals has no
# attribute '_signature_descriptor'` at import → the whole Python service
# (face detection, rembg, MobileSAM) failed to boot on every staging deploy
# from 2026-07-10 21:28 onward. Co-pinning makes the second install a no-op
# for numpy so no downgrade ever happens.
RUN pip3 install --no-cache-dir --break-system-packages \
    --timeout 120 --retries 5 \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    torch torchvision "numpy==1.24.3"

# Install Python dependencies. mediapipe / opencv are large (>30 MB each) and
# files.pythonhosted.org occasionally stalls mid-download — give pip more
# breathing room and let it retry rather than failing the whole build.
# (--break-system-packages is safe in Docker containers.)
RUN pip3 install --no-cache-dir --break-system-packages \
    --timeout 120 --retries 5 \
    -r requirements.txt

# MobileSAM weights baked into the image so cold starts don't re-download.
# photo_analyzer.py reads MOBILESAM_WEIGHTS (get_mobilesam).
RUN curl -fL -o /app/mobile_sam.pt \
    https://github.com/ultralytics/assets/releases/download/v8.3.0/mobile_sam.pt
ENV MOBILESAM_WEIGHTS=/app/mobile_sam.pt

# GroundingDINO-base weights pre-fetched into the image (~900MB) so the
# /detect-figures-text cold start doesn't download from HuggingFace at runtime.
# Cache lives under HF_HOME; photo_analyzer.py reads GROUNDINGDINO_MODEL. Only
# used when FIGURE_DETECTION_BACKEND=grounding-dino. NON-FATAL: prod defaults to
# 'gemini' and never needs this, so a flaky HF fetch must not break the build —
# if the pre-fetch fails, get_groundingdino() downloads it lazily on first use.
ENV HF_HOME=/app/.hf_cache
ENV GROUNDINGDINO_MODEL=IDEA-Research/grounding-dino-base
RUN python3 -c "from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection; \
    AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-base'); \
    AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-base')" \
    || echo "WARN: GroundingDINO pre-fetch failed — will download lazily at runtime if used"

# Copy client package files and install dependencies
COPY client/package*.json ./client/
RUN cd client && npm install

# Copy all application files
COPY . .

# Pass VITE_ env vars as build args so they're baked into the frontend bundle.
# These are public frontend keys (Turnstile site key, API URL, Google OAuth
# client ID) — not secrets. The `# check=skip=SecretsUsedInArgOrEnv` parser
# directive at the top of this file silences BuildKit's warning about them.
# hadolint ignore=DL3028
ARG VITE_TURNSTILE_SITE_KEY
ARG VITE_API_URL
ARG VITE_GOOGLE_OAUTH_CLIENT_ID
# GA4 measurement id (G-XXXXXXXXXX) — public key; client analytics ships
# inert until this is set (client/src/utils/analytics.ts).
ARG VITE_GA4_ID

# BASE_URL is needed by scripts/prerender.mjs (via server/lib/seoMeta.js)
# at BUILD time — the prerender step bakes canonical / og:url / hreflang
# into the static HTML files for each route. Without this ARG + ENV, the
# build can't see the Railway service's BASE_URL env var, the prerender
# falls back to the hardcoded prod URL, and any non-prod environment
# (staging / preview) hits React hydration mismatch on first render.
# Railway forwards service-level env vars as build args when they're
# declared here.
ARG BASE_URL
ENV BASE_URL=${BASE_URL}

# Build the React client + SSR bundle, then pre-render all SEO routes.
# `cd client && npm run build` runs: tsc -b && vite build && vite build --ssr ...
#   → produces dist/ (client bundle + manifest) and client/dist-ssr/ (SSR bundle)
# `node scripts/prerender.mjs` then writes dist/prerendered/{path}.{lang}.html
# for all 333 SEO routes × 3 languages (~999 files, ~5 seconds).
# Vite has emptyOutDir:true so any committed dist/prerendered/ from the repo
# is wiped first — the prerender step is what populates it in production.
RUN cd client && npm run build && cd .. && node scripts/prerender.mjs

# Expose ports
EXPOSE 3000 5000

# Start both services
CMD ["bash", "start.sh"]
