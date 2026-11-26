const BAD_PAGE_MSG =
  'The server sent an unexpected page instead of data (it may be busy, waking up or restarting). Wait a minute and try again.';

async function readJsonSafely(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(BAD_PAGE_MSG);
  }
}

window.ClipFetchAnalyzer = {
  readJsonSafely,

  // YouTube can take minutes on a small server, so the server answers 202 ("pending")
  // and we ask again every few seconds until the result is ready.
  async analyzeUrl(url, onWait) {
    const started = Date.now();
    let poll = false;
    let badReplies = 0;
    for (;;) {
      let response;
      let data;
      try {
        response = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, poll }),
        });
        data = await readJsonSafely(response);
      } catch (err) {
        // while polling, tolerate a few hiccups (proxy error pages, server restarting)
        if (poll && ++badReplies <= 5) {
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
        throw err;
      }
      if (response.status === 202 && data.pending) {
        poll = true;
        if (Date.now() - started > 5 * 60 * 1000) {
          throw new Error('Still not finished after 5 minutes. Please try again later.');
        }
        if (onWait) onWait(Math.round((Date.now() - started) / 1000));
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Could not analyze URL.');
      }
      return data;
    }
  },

  formatBytes(bytes) {
    if (!bytes || bytes <= 0) return 'Size unknown';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    if (mb >= 1) return mb.toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  },

  secondsToTimestamp(total) {
    const s = Math.max(0, Math.floor(total || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  },

  timestampToSeconds(text) {
    const cleaned = String(text || '').trim();
    if (/^\d+(\.\d+)?$/.test(cleaned)) return parseFloat(cleaned);
    const parts = cleaned.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  },
};
