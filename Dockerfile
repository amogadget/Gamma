# --- Stage 1: build the frontend ---
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- Stage 2: runtime ---
FROM python:3.12-slim
WORKDIR /app

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
