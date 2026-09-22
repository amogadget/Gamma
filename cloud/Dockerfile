FROM python:3.12-slim
WORKDIR /app
COPY cloud/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY cloud/app.py cloud/manage.py ./
COPY cloud/gammacloud/ ./gammacloud/
ENV GAMMA_CLOUD_DATA_DIR=/data PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 9002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9002/api/health', timeout=3)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9002", "--proxy-headers", "--forwarded-allow-ips", "*"]
