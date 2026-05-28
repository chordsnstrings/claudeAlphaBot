# Harvest dashboard — DO App Platform / any container host.
# Build context = repo root:  docker build -f research/ui/Dockerfile -t harvest-dash .
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

WORKDIR /app

# deps first (layer cache)
COPY research/ui/requirements.txt ./research/ui/requirements.txt
RUN pip install -r research/ui/requirements.txt

# engine code + cached data + the committed snapshot
COPY research ./research

# run as non-root
RUN useradd -m app && chown -R app /app
USER app
WORKDIR /app/research

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=25s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/health',timeout=3)" || exit 1

CMD ["python", "ui/server.py"]
