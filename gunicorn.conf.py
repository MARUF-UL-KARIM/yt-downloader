# Picked up automatically by gunicorn (it reads ./gunicorn.conf.py).
# 1 worker because download jobs live in memory; threads so progress streams (SSE),
# polling and page loads work at the same time.
worker_class = "gthread"
workers = 1
threads = 16
timeout = 300
