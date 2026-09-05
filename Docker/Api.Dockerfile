FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATABASE_URL=sqlite:////data/study-helper.db

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ffmpeg nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY backend/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    # yt-dlp-transcript hard-pins an old yt-dlp; YouTube's anti-bot changes break old yt-dlp
    # releases regularly, so this overrides it with a current one after the main install.
    && pip install --no-cache-dir --upgrade "yt-dlp>=2026.8.19"

COPY backend/api/ ./

RUN mkdir -p /data

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
