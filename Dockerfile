FROM python:3.12-slim

# ffmpeg (+ffprobe) for merging / trimming / speed, libstdc++ for Node
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

# Node.js (needed by yt-dlp to solve YouTube's JavaScript challenge)
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -U -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend
COPY app.py .

ENV PYTHONUNBUFFERED=1
EXPOSE 10000

# 1 worker (job state is in memory) + threads (for SSE progress streams)
CMD ["sh", "-c", "gunicorn -w 1 -k gthread --threads 16 -t 120 -b 0.0.0.0:${PORT:-10000} app:app"]
