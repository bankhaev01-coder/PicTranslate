FROM python:3.13-slim

# ── Системные зависимости ── (Tesseract для local/offline OCR + RU/EN пакеты) ──
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python-зависимости ──
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Приложение (build context — ./backend, поэтому app/ лежит в корне контекста) ──
COPY app/ ./app/

# ── Необязательный локальный файловый кеш результатов перевода ──
RUN mkdir -p /app/cache

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

