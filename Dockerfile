# BuildKit parser directive — silence the SecretsUsedInArgOrEnv warning for
# the VITE_* ARGs below. They are public frontend keys (Turnstile site key,
# API URL, Google OAuth client ID), not secrets — safe to bake into the
# client bundle. This directive must sit before any instruction; an inline
# `# check=skip=` next to the ARG itself doesn't work.
# check=skip=SecretsUsedInArgOrEnv

# WHY THIS IS A MULTI-STAGE BUILD (2026-09-03).
#
# Railway bills container memory, and a container's page cache counts toward
# that. The container writes its whole image to the overlay filesystem at
# startup; those pages stay resident for the life of the container because Linux
# evicts page cache only under memory pressure, and a long-lived service never
# gets that pressure. Measured on production: 2,062 MB of page cache of which
# 2,036 MB was `inactive_file` (read once, never referenced again), against a
# /app of 2.2 GB — while the two processes inside held 567 MB between them.
#
# So the IMAGE SIZE is the memory bill. The single-stage build shipped the client
# build toolchain into the runtime image: `cd client && npm install` left
# client/node_modules (159 MB) and the SSR bundle (14 MB) behind, neither of
# which the server ever reads. Splitting the client build into a discarded stage
# removes them without an allowlist — nothing has to be enumerated, they simply
# never exist in the runtime stage. The rest of the reduction is .dockerignore
# (tests/, docs/ except story-ideas, scripts/analysis, scripts/ads, noah.json).
#
# What must STAY, verified rather than assumed:
#   - .hf_cache (892 MB) — production runs FIGURE_DETECTION_BACKEND=grounding-dino
#     (confirmed via /api/health/config). An older comment here claimed prod
#     defaults to 'gemini' and never needs these weights; that is stale.
#   - .deepface (131 MB) ArcFace, mobile_sam.pt (39 MB) — avatar likeness + SAM
#   - dist/ (60 MB, served), images/ (17 MB, served at /images)
#   - scripts/lib/ — required at RUNTIME by server/lib/failureLog.js and
#     server/lib/storyMetrics.js (`require('../../scripts/lib/chTime')`)
#   - docs/story-ideas/ — read at RUNTIME by server/lib/swissStories.js:65
#
# ─────────────────────────────────────────────────────────────────────────────
# STAGE 0 — shared system layer.
#
# Both stages need the same system libraries: the root package.json pulls
# `canvas` and `sharp`, whose install steps want build-essential/python3-dev,
# and the runtime additionally needs python for photo_analyzer.py. Defining it
# once means the builder and the runtime can never drift apart on system libs.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22 AS base

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─────────────────────────────────────────────────────────────────────────────
# STAGE 1 — client builder. Everything here is DISCARDED; only dist/ is copied
# into the runtime stage. This is where the 173 MB of build toolchain dies.
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS client-builder

# Root deps are needed here too, NOT just the client's: scripts/prerender.mjs
# imports `beasties` (a root dependency) and requires server/lib/seoMeta.js.
# Dev dependencies are wanted in this stage — hence no --omit=dev.
COPY package*.json ./
RUN npm install

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

# ─────────────────────────────────────────────────────────────────────────────
# STAGE 2 — runtime. The layer order below is deliberate and load-bearing; the
# comments on each pip step record bugs that the ordering fixes. Do not reorder.
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS runtime

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
# Cache lives under HF_HOME; photo_analyzer.py reads GROUNDINGDINO_MODEL.
# REQUIRED IN PRODUCTION as of 2026-08-17: FIGURE_DETECTION_BACKEND defaults to
# grounding-dino in every environment, confirmed live via /api/health/config.
# The pre-fetch stays NON-FATAL so a flaky HuggingFace fetch cannot break the
# build — get_groundingdino() downloads lazily on first use — but a failure here
# means the first detection call pays a ~900MB download, so it is worth noticing.
ENV HF_HOME=/app/.hf_cache
ENV GROUNDINGDINO_MODEL=IDEA-Research/grounding-dino-base
# MUST RUN BEFORE THE DINO PRE-FETCH (bug staging-analyzer-dino-crashloop,
# 2026-08-22): requirements.txt's TF 2.13 resolution DOWNGRADES
# typing_extensions below torch/transformers' floor, so the pre-fetch import
# below failed, its || WARN swallowed the failure, and the image shipped
# WITHOUT DINO weights — every runtime load then re-downloaded ~900MB from
# HF and died. Ordered here, both the pre-fetch and runtime see the working
# version.
# deepface's import chain needs typing_extensions>=4.10 (TypeIs) while
# tensorflow 2.13 declares <4.6, so pip refuses to resolve both from one
# requirements file. TF runs fine against the newer one — install it separately,
# after requirements.txt, exactly as the torch CPU build is sequenced above.
RUN pip3 install --no-cache-dir --break-system-packages "typing_extensions>=4.12"

RUN python3 -c "from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection; \
    AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-base'); \
    AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-base')" \
    || echo "WARN: GroundingDINO pre-fetch failed — will download lazily at runtime if used"


# ArcFace recognition weights (~137MB) baked in so the first avatar check does
# not stall on a download. DeepFace looks in $DEEPFACE_HOME/.deepface/weights.
# NON-FATAL, same reasoning as GroundingDINO above: likeness scoring is a
# quality gate, not a rendering dependency, so a flaky fetch must not break the
# build — evaluate_avatar_likeness falls back to a lazy download on first use.
ENV DEEPFACE_HOME=/app
RUN python3 -c "from deepface import DeepFace; \
    DeepFace.build_model('ArcFace')" \
    || echo "WARN: ArcFace pre-fetch failed — will download lazily on first use"

# Application source. `dist` is in .dockerignore, so nothing stale from a local
# build can shadow the built bundle copied in below.
COPY . .

# The built client + pre-rendered SEO HTML, from the discarded builder stage.
# This is the ONLY thing that crosses the stage boundary — no node_modules, no
# client source, no SSR bundle.
COPY --from=client-builder /app/dist ./dist

# Expose ports
EXPOSE 3000 5000

# Start both services
CMD ["bash", "start.sh"]
