# --- Stage 1: build the frontend ---
# Pinned to the build host's platform: the vite output is platform-independent
# static files, and running npm ci under QEMU for the arm64 image hangs.
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Stage 2: runtime ---
FROM python:3.12-slim
WORKDIR /app

# CJK glyphs in the "notes on page" PDF export are drawn as outlines from this
# font (gamma/vector_text.py) — a plain 4 MB .ttf, unlike the .ttc collections
# most CJK font packages ship, which ziafont can't open.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-droid-fallback \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app.py backend/manage.py ./
COPY backend/gamma/ ./gamma/
COPY --from=frontend /build/dist ./static/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV GAMMA_DATA_DIR=/data \
    GAMMA_STATIC_DIR=/app/static \
    PYTHONUNBUFFERED=1

VOLUME /data
EXPOSE 9001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9001/api/health', timeout=3)"

ENTRYPOINT ["docker-entrypoint.sh"]
