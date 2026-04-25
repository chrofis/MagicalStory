# Use Node.js 18 base image with Python pre-installed
FROM node:18

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

# Install Node.js dependencies for server
RUN npm install --production

# Install Python dependencies (--break-system-packages is safe in Docker containers)
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copy client package files and install dependencies
COPY client/package*.json ./client/
RUN cd client && npm install

# Copy all application files
COPY . .

# Pass VITE_ env vars as build args so they're baked into the frontend bundle
# (these are public frontend keys, not secrets — safe to use in ARG)
# hadolint ignore=DL3028
# check=skip=SecretsUsedInArgOrEnv
ARG VITE_TURNSTILE_SITE_KEY
ARG VITE_API_URL
ARG VITE_GOOGLE_OAUTH_CLIENT_ID

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
