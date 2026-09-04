FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY templates templates
COPY static static

# Data lives on a volume; run as an unprivileged user that owns it.
ENV FREEZER_DB=/data/freezer.db \
    PYTHONUNBUFFERED=1
RUN useradd --system --create-home freezer \
    && mkdir -p /data && chown freezer:freezer /data
USER freezer
VOLUME /data

EXPOSE 5177
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5177/api/meta')" || exit 1

CMD ["gunicorn", "--bind", "0.0.0.0:5177", "--workers", "2", "--access-logfile", "-", "app:app"]
