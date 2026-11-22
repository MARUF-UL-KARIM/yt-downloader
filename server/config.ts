import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const require = createRequire(import.meta.url);

function getBundledFfmpegPath(): string | null {
  try {
    const resolved = require('ffmpeg-static') as string | null;
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Optional fallback if package unavailable
  }
  return null;
}

function getBundledFfprobePath(): string | null {
  try {
    const resolved = require('ffprobe-static') as { path?: string } | null;
    if (resolved?.path && fs.existsSync(resolved.path)) {
      return resolved.path;
    }
  } catch {
    // Optional fallback if package unavailable
  }
  return null;
}

function resolveFromPath(binName: string): string | null {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, binName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveBinary(envValue: string | undefined, candidates: Array<string | null>, fallback: string): string {
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return resolveFromPath(fallback) || fallback;
}

const cwd = process.cwd();
export const RUNTIME_BIN_DIR = '/tmp/clipfetch_bin';
export const RUNTIME_YTDLP_PATH = path.join(RUNTIME_BIN_DIR, 'yt-dlp');

export const CONFIG = {
  port: Number.parseInt(process.env.PORT || '3000', 10) || 3000,
  isProduction: process.env.NODE_ENV === 'production',
  tempDir: path.resolve(process.env.TEMP_DIR || '/tmp/clipfetch_jobs'),
  maxFileSizeMb: Number.parseInt(process.env.MAX_FILE_SIZE_MB || '500', 10) || 500,
  maxDurationSec: Number.parseInt(process.env.MAX_DURATION_SEC || '3600', 10) || 3600,
  maxConcurrentJobs: Number.parseInt(process.env.MAX_CONCURRENT_JOBS || '4', 10) || 4,
  jobTimeoutSec: Number.parseInt(process.env.JOB_TIMEOUT_SEC || '600', 10) || 600,
  autoCleanupMinutes: Number.parseInt(process.env.AUTO_CLEANUP_MINUTES || '15', 10) || 15,
  ytdlpBin: resolveBinary(
    process.env.YTDLP_BIN,
    [RUNTIME_YTDLP_PATH, path.join(cwd, 'bin', 'yt-dlp'), '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'],
    RUNTIME_YTDLP_PATH
  ),
  ffmpegBin: resolveBinary(
    process.env.FFMPEG_BIN,
    ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(RUNTIME_BIN_DIR, 'ffmpeg'), getBundledFfmpegPath()],
    'ffmpeg'
  ),
  ffprobeBin: resolveBinary(
    process.env.FFPROBE_BIN,
    ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', path.join(RUNTIME_BIN_DIR, 'ffprobe'), getBundledFfprobePath()],
    'ffprobe'
  ),
  nodeBin: resolveBinary(
    process.env.NODE_BIN,
    [process.execPath, '/usr/local/bin/node', '/usr/bin/node'],
    'node'
  ),
  ytdlpProxy:
    process.env.YTDLP_PROXY && process.env.YTDLP_PROXY.trim().length > 0
      ? process.env.YTDLP_PROXY.trim()
      : null,
  cookiesFile:
    process.env.YTDLP_COOKIES_FILE && fs.existsSync(process.env.YTDLP_COOKIES_FILE)
      ? process.env.YTDLP_COOKIES_FILE
      : null,
  // YouTube-only cookies (Render: Environment > Secret Files > "cookies.txt" -> /etc/secrets/cookies.txt).
  // The secret file is read-only, so a writable copy is used.
  ytCookiesFile: (() => {
    const src = process.env.YT_COOKIES_FILE?.trim() || '/etc/secrets/cookies.txt';
    try {
      if (!fs.existsSync(src)) return process.env.YTDLP_COOKIES_FILE && fs.existsSync(process.env.YTDLP_COOKIES_FILE) ? process.env.YTDLP_COOKIES_FILE : null;
      const dir = path.resolve(process.env.TEMP_DIR || '/tmp/clipfetch_jobs');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dst = path.join(dir, '.yt_cookies.txt');
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o600);
      return dst;
    } catch {
      return null;
    }
  })(),
  allowedSpeeds: [0.5, 1, 1.5, 2, 3] as const,
  allowedVideoContainers: ['mp4', 'webm', 'mkv'] as const,
  allowedAudioContainers: ['mp3', 'm4a'] as const,
};

function materializeEnvCookies(): void {
  if (CONFIG.cookiesFile) return;

  let decodedCookies = '';
  const b64 = process.env.YTDLP_COOKIES_B64?.trim();
  const rawText = process.env.YTDLP_COOKIES_TEXT?.trim();

  if (b64) {
    try {
      decodedCookies = Buffer.from(b64, 'base64').toString('utf-8').trim();
    } catch {
      decodedCookies = '';
    }
  } else if (rawText) {
    decodedCookies = rawText;
  }

  if (decodedCookies.length > 0) {
    try {
      fs.mkdirSync(CONFIG.tempDir, { recursive: true, mode: 0o700 });
      const envCookiesPath = path.join(CONFIG.tempDir, '.env_cookies.txt');
      fs.writeFileSync(envCookiesPath, decodedCookies + '\n', { mode: 0o600 });
      CONFIG.cookiesFile = envCookiesPath;
    } catch {
      // Best-effort materialization
    }
  }
}

function linkRuntimeBinary(sourcePath: string, name: string): string {
  try {
    fs.chmodSync(sourcePath, 0o755);
  } catch {
    // Best-effort chmod if read-only image layer
  }
  try {
    fs.mkdirSync(RUNTIME_BIN_DIR, { recursive: true });
    const linkPath = path.join(RUNTIME_BIN_DIR, name);
    if (!fs.existsSync(linkPath)) {
      fs.symlinkSync(sourcePath, linkPath);
    }
    return linkPath;
  } catch {
    return sourcePath;
  }
}

const YTDLP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const YTDLP_URLS = [
  // nightly builds get YouTube fixes first; stable is the fallback
  'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux',
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
];

async function downloadYtDlp(): Promise<boolean> {
  fs.mkdirSync(RUNTIME_BIN_DIR, { recursive: true });
  for (const url of YTDLP_URLS) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length < 1_000_000) throw new Error('download too small');
      const tmp = `${RUNTIME_YTDLP_PATH}.tmp`;
      fs.writeFileSync(tmp, buf, { mode: 0o755 });
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, RUNTIME_YTDLP_PATH);
      return true;
    } catch (err) {
      console.warn(`Could not download yt-dlp from ${url}:`, err);
    }
  }
  return false;
}

export async function ensureYtDlpBinary(): Promise<void> {
  materializeEnvCookies();

  // Ensure bundled ffmpeg & ffprobe binaries are executable and co-located when system binaries are absent
  if (!fs.existsSync(CONFIG.ffmpegBin)) {
    const staticFfmpeg = getBundledFfmpegPath();
    if (staticFfmpeg) {
      CONFIG.ffmpegBin = linkRuntimeBinary(staticFfmpeg, 'ffmpeg');
    }
  }
  if (!fs.existsSync(CONFIG.ffprobeBin)) {
    const staticFfprobe = getBundledFfprobePath();
    if (staticFfprobe) {
      CONFIG.ffprobeBin = linkRuntimeBinary(staticFfprobe, 'ffprobe');
    }
  }
  // If ffmpeg and ffprobe live in separate directories (e.g. static npm packages), expose both in RUNTIME_BIN_DIR for yt-dlp
  if (
    fs.existsSync(CONFIG.ffmpegBin) &&
    fs.existsSync(CONFIG.ffprobeBin) &&
    path.dirname(CONFIG.ffmpegBin) !== path.dirname(CONFIG.ffprobeBin)
  ) {
    CONFIG.ffmpegBin = linkRuntimeBinary(CONFIG.ffmpegBin, 'ffmpeg');
    CONFIG.ffprobeBin = linkRuntimeBinary(CONFIG.ffprobeBin, 'ffprobe');
  }

  // yt-dlp that came from the system / YTDLP_BIN is used as-is.
  const managed = CONFIG.ytdlpBin === RUNTIME_YTDLP_PATH;
  if (!managed && fs.existsSync(CONFIG.ytdlpBin)) {
    return;
  }
  if (!managed) {
    const fromPath = resolveFromPath('yt-dlp');
    if (fromPath) {
      CONFIG.ytdlpBin = fromPath;
      return;
    }
  }

  // Managed standalone binary in /tmp: keep it fresh because YouTube changes often.
  const ageMs = fs.existsSync(RUNTIME_YTDLP_PATH)
    ? Date.now() - fs.statSync(RUNTIME_YTDLP_PATH).mtimeMs
    : Number.POSITIVE_INFINITY;
  if (ageMs > YTDLP_MAX_AGE_MS) {
    await downloadYtDlp();
  }
  if (fs.existsSync(RUNTIME_YTDLP_PATH)) {
    CONFIG.ytdlpBin = RUNTIME_YTDLP_PATH;
  }
}
