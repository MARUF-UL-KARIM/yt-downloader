import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import HLS from 'hls-parser';
import { ProxyAgent, fetch as undiciFetch, type RequestInfo as UndiciRequestInfo, type RequestInit as UndiciRequestInit } from 'undici';
import { ClientType, Constants, Innertube, Log, Parser, Platform, Session } from 'youtubei.js';
import { CONFIG } from './config.ts';
import type { AnalyzedMedia, VideoFormatOption } from './extractor.ts';
import { safeFetchPublic } from './validators.ts';

// Configure youtubei.js script evaluator cleanly using Node's sandboxed vm (matching Cobalt's youtube.js)
Platform.shim.eval = async (data, _env) => {
  const code = `(() => { ${data.output} })()`;
  return vm.runInNewContext(code, Object.create(null), { timeout: 5000 });
};

// Silence noisy YouTube.js parser JIT introspection warnings (e.g. PlayerErrorCommand / InterstitialView)
Log.setLevel(Log.Level.NONE);
Parser.setParserErrorHandler(() => {});

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);

const COBALT_QUALITY_TIERS = [
  { height: 2160, quality: '2160', label: 'Original (2160p 4K)' },
  { height: 1440, quality: '1440', label: '1440p (QHD)' },
  { height: 1080, quality: '1080', label: '1080p (Full HD)' },
  { height: 720, quality: '720', label: '720p (HD)' },
  { height: 480, quality: '480', label: '480p (SD)' },
  { height: 360, quality: '360', label: '360p' },
] as const;

const YOUTUBE_VIDEO_QUALITIES = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320] as const;
const PLAYER_REFRESH_MS = 15 * 60 * 1000;
const SESSION_REFRESH_MS = 30 * 60 * 1000;

interface YouTubeSessionTokens {
  potoken: string;
  visitor_data: string;
  updated: number;
}

interface CobaltApiResponse {
  status: 'tunnel' | 'redirect' | 'local-processing' | 'picker' | 'error';
  url?: string;
  filename?: string;
  tunnel?: string[];
  type?: string;
  output?: {
    type?: string;
    filename?: string;
  };
  error?: {
    code?: string;
    context?: Record<string, unknown>;
  };
}

interface RawAdaptiveOrMuxedFormat {
  itag: number;
  mime_type?: string;
  bitrate?: number;
  average_bitrate?: number;
  content_length?: number;
  width?: number;
  height?: number;
  fps?: number;
  has_video?: boolean;
  has_audio?: boolean;
  quality_label?: string;
  audio_quality?: string;
  decipher: (player?: unknown) => Promise<string> | string;
}

export interface YouTubeDownloadProgress {
  status?: 'downloading' | 'merging';
  phaseLabel?: string;
  progress?: number | null;
  downloadedBytes?: number;
  totalBytes?: number | null;
  speedText?: string | null;
  etaText?: string | null;
}

export interface YouTubeOAuthCredentials {
  access_token: string;
  refresh_token: string;
  expiry_date: string;
  token_type?: string;
  scope?: string;
  client?: {
    client_id: string;
    client_secret: string;
  };
}

export interface YouTubeAuthOptions {
  oauthCredentials?: YouTubeOAuthCredentials | null;
  cookiesText?: string | null;
  onUpdatedCredentials?: (creds: YouTubeOAuthCredentials) => void;
}

export interface YouTubeDownloadParams {
  url: string;
  mode: 'video' | 'audio';
  formatId: string;
  audioFormatId: string | null;
  needsMerge: boolean;
  container: string;
  workDir: string;
  maxFileSizeBytes: number;
  abortSignal: AbortSignal;
  onActiveChild: (child: ChildProcess | null) => void;
  onProgress: (update: YouTubeDownloadProgress) => void;
  oauthCredentials?: YouTubeOAuthCredentials | null;
  cookiesText?: string | null;
}

let cachedSession: YouTubeSessionTokens | null = null;
let cachedServerOAuth: YouTubeOAuthCredentials | null | undefined;
const cachedInnertubeByClient = new Map<string, { instance: Innertube; createdAt: number }>();
let cachedProxyAgent: ProxyAgent | null = null;

function getProxyAgent(): ProxyAgent | null {
  if (!CONFIG.cobaltProxy) return null;
  if (!/^https?:\/\//i.test(CONFIG.cobaltProxy)) {
    return null;
  }
  if (!cachedProxyAgent) {
    cachedProxyAgent = new ProxyAgent(CONFIG.cobaltProxy);
  }
  return cachedProxyAgent;
}

async function cobaltFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const dispatcher = getProxyAgent();
  if (!dispatcher) {
    return fetch(input, init);
  }

  const reqUrl =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headersObj: Record<string, string> = {};
  const srcHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (srcHeaders) {
    new Headers(srcHeaders).forEach((value, key) => {
      headersObj[key] = value;
    });
  }

  const undiciInit: UndiciRequestInit = {
    method: init?.method || (input instanceof Request ? input.method : 'GET'),
    headers: headersObj,
    body: init?.body as UndiciRequestInit['body'],
    signal: init?.signal ?? undefined,
    redirect: init?.redirect,
    dispatcher,
  };

  const res = await undiciFetch(reqUrl as UndiciRequestInfo, undiciInit);
  return res as unknown as Response;
}

export function isYouTubeUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return (
      YOUTUBE_HOSTS.has(host) ||
      host.endsWith('.youtube.com') ||
      host.endsWith('.youtu.be') ||
      host.endsWith('.youtube-nocookie.com') ||
      host === 'youtube.googleapis.com'
    );
  } catch {
    return false;
  }
}

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let candidate: string | null = null;

    if (host === 'youtu.be') {
      const seg = parsed.pathname.split('/').filter(Boolean)[0];
      candidate = seg || null;
    } else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
      const vParam = parsed.searchParams.get('v');
      if (vParam) {
        candidate = vParam;
      } else {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
          candidate = parts[1];
        }
      }
    }

    if (!candidate) return null;
    const cleaned = candidate.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(cleaned)) {
      return cleaned;
    }
    return null;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return 'Unknown';
  }
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function fetchYouTubeOembed(videoId: string): Promise<{
  title: string | null;
  uploader: string | null;
  thumbnail: string | null;
}> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await cobaltFetch(oembedUrl, { signal: controller.signal });
      if (!res.ok) {
        return {
          title: null,
          uploader: null,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        };
      }
      const data = (await res.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      return {
        title: data.title || null,
        uploader: data.author_name || null,
        thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return {
      title: null,
      uploader: null,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  }
}

function mapCobaltErrorCode(code: string | undefined): string {
  switch (code) {
    case 'error.api.youtube.login':
      return 'Cobalt reported YouTube bot verification (error.api.youtube.login). The Cobalt server IP requires a valid YOUTUBE_SESSION_SERVER (yt-session-generator) on a clean/non-datacenter IP.';
    case 'error.api.youtube.no_session_tokens':
      return 'Cobalt YOUTUBE_SESSION_SERVER did not return poToken / visitor_data tokens yet (error.api.youtube.no_session_tokens).';
    case 'error.api.youtube.decipher':
      return 'Cobalt could not decipher the YouTube player signature (error.api.youtube.decipher).';
    case 'error.api.content.video.unavailable':
      return 'This YouTube video is unavailable, deleted, or restricted.';
    case 'error.api.content.video.private':
      return 'This YouTube video is private and cannot be downloaded.';
    case 'error.api.content.video.age':
      return 'This YouTube video is age-restricted and requires signed-in account verification.';
    case 'error.api.content.video.live':
      return 'YouTube live streams cannot be pre-analyzed or downloaded as finite files.';
    case 'error.api.content.video.region':
      return 'This YouTube video is geo-restricted and unavailable from the Cobalt server region.';
    case 'error.api.content.too_long':
      return 'This YouTube video exceeds the Cobalt server maximum duration limit.';
    case 'error.api.auth.jwt.missing':
    case 'error.api.auth.jwt.invalid':
    case 'error.api.auth.key.missing':
    case 'error.api.auth.key.invalid':
      return `Self-hosted Cobalt API rejected authentication (${code}). Verify COBALT_API_KEY in server configuration.`;
    default:
      return code ? `Cobalt extraction failed (${code}).` : 'Cobalt extraction failed.';
  }
}

async function callCobaltApi(payload: Record<string, unknown>, signal?: AbortSignal): Promise<CobaltApiResponse> {
  if (!CONFIG.cobaltApiUrl) {
    throw new Error('COBALT_API_URL is not configured.');
  }

  const endpoint = `${CONFIG.cobaltApiUrl}/`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (CONFIG.cobaltApiKey) {
    headers.Authorization = `Api-Key ${CONFIG.cobaltApiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: CobaltApiResponse;
    try {
      parsed = JSON.parse(text) as CobaltApiResponse;
    } catch {
      throw new Error(`Self-hosted Cobalt server returned HTTP ${res.status} (non-JSON response).`);
    }

    if (!res.ok || parsed.status === 'error') {
      throw new Error(mapCobaltErrorCode(parsed.error?.code));
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function loadYouTubeSessionTokens(): Promise<YouTubeSessionTokens | null> {
  if (!CONFIG.youtubeSessionServer) return null;

  const now = Date.now();
  if (cachedSession && now - cachedSession.updated < SESSION_REFRESH_MS) {
    return cachedSession;
  }

  const base = CONFIG.youtubeSessionServer;
  const endpoints: Array<{ url: string; method: 'POST' | 'GET' }> = [
    { url: `${base}/get_pot`, method: 'POST' },
    { url: `${base}/token`, method: 'GET' },
  ];

  let lastErr: Error | null = null;
  for (const ep of endpoints) {
    try {
      const res = await cobaltFetch(ep.url, { method: ep.method });
      if (!res.ok) {
        lastErr = new Error(`Session server ${ep.url} returned HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        potoken?: string;
        poToken?: string;
        visitor_data?: string;
        contentBinding?: string;
        updated?: number;
      };
      const potoken = data.potoken || data.poToken || '';
      const visitor_data = data.visitor_data || data.contentBinding || '';
      if (!potoken || !visitor_data) {
        lastErr = new Error('Session server response missing potoken or visitor_data');
        continue;
      }
      if (potoken.length < 160) {
        console.warn(`[youtube-cobalt] poToken length (${potoken.length}) is < 160 and may be rejected by YouTube.`);
      }
      cachedSession = {
        potoken,
        visitor_data,
        updated: data.updated ? Number(data.updated) : now,
      };
      return cachedSession;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (lastErr) {
    console.warn(`[youtube-cobalt] Failed to query YOUTUBE_SESSION_SERVER: ${lastErr.message}`);
  }
  return null;
}

export function parseYouTubeOAuthCredentials(raw: unknown): YouTubeOAuthCredentials | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.access_token !== 'string' ||
    !obj.access_token ||
    typeof obj.refresh_token !== 'string' ||
    !obj.refresh_token ||
    typeof obj.expiry_date !== 'string' ||
    !obj.expiry_date
  ) {
    return null;
  }

  let client: { client_id: string; client_secret: string } | undefined;
  if (obj.client && typeof obj.client === 'object' && !Array.isArray(obj.client)) {
    const c = obj.client as Record<string, unknown>;
    if (typeof c.client_id === 'string' && c.client_id && typeof c.client_secret === 'string' && c.client_secret) {
      client = {
        client_id: c.client_id.slice(0, 512),
        client_secret: c.client_secret.slice(0, 512),
      };
    }
  }

  return {
    access_token: obj.access_token.slice(0, 4096),
    refresh_token: obj.refresh_token.slice(0, 4096),
    expiry_date: obj.expiry_date.slice(0, 128),
    token_type: typeof obj.token_type === 'string' ? obj.token_type.slice(0, 64) : undefined,
    scope: typeof obj.scope === 'string' ? obj.scope.slice(0, 512) : undefined,
    client,
  };
}

function netscapeCookiesToHeader(rawCookiesText: string | null | undefined): string | null {
  const sourceText =
    rawCookiesText && rawCookiesText.trim().length > 0
      ? rawCookiesText
      : CONFIG.cookiesFile && fs.existsSync(CONFIG.cookiesFile)
        ? fs.readFileSync(CONFIG.cookiesFile, 'utf-8')
        : null;

  if (!sourceText) return null;

  const pairs: string[] = [];
  const seenNames = new Set<string>();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const rawLine of sourceText.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) {
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue;
    }

    const cols = line.split('\t');
    if (cols.length < 7) continue;

    const domain = cols[0].toLowerCase();
    const expiry = Number.parseInt(cols[4], 10);
    const name = cols[5]?.trim();
    const value = cols[6] ?? '';

    if (!name) continue;
    if (Number.isFinite(expiry) && expiry > 0 && expiry < nowSec) continue;
    if (
      domain !== 'youtube.com' &&
      !domain.endsWith('.youtube.com') &&
      domain !== 'google.com' &&
      !domain.endsWith('.google.com')
    ) {
      continue;
    }

    if (!seenNames.has(name)) {
      seenNames.add(name);
      pairs.push(`${name}=${value}`);
    }
  }

  return pairs.length > 0 ? pairs.join('; ') : null;
}

function createCodedError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function loadServerOAuthCredentials(): YouTubeOAuthCredentials | null {
  if (cachedServerOAuth !== undefined) return cachedServerOAuth;
  if (!CONFIG.youtubeOauthJson) {
    cachedServerOAuth = null;
    return null;
  }
  try {
    cachedServerOAuth = parseYouTubeOAuthCredentials(JSON.parse(CONFIG.youtubeOauthJson));
  } catch {
    cachedServerOAuth = null;
  }
  return cachedServerOAuth;
}

async function getInnertubeInstance(
  clientName: string,
  sessionTokens: YouTubeSessionTokens | null,
  auth?: {
    oauthCredentials?: YouTubeOAuthCredentials | null;
    cookieHeader?: string | null;
    onUpdatedCredentials?: (creds: YouTubeOAuthCredentials) => void;
  }
): Promise<Innertube> {
  const now = Date.now();
  const clientTypeEnum =
    (ClientType as Record<string, ClientType>)[clientName] ?? ClientType.WEB;

  // Authenticated sessions (OAuth2 or Cookie) must keep their own Session state intact
  if (auth?.oauthCredentials || auth?.cookieHeader) {
    const yt = await Innertube.create({
      fetch: cobaltFetch,
      retrieve_player: true,
      client_type: clientTypeEnum,
      cookie: auth.cookieHeader || undefined,
      po_token: sessionTokens?.potoken,
      visitor_data: sessionTokens?.visitor_data,
    });

    if (auth.oauthCredentials) {
      if (auth.onUpdatedCredentials) {
        yt.session.on('update-credentials', ({ credentials }: { credentials?: YouTubeOAuthCredentials }) => {
          if (credentials) {
            auth.onUpdatedCredentials?.({
              ...credentials,
              client: auth.oauthCredentials?.client || credentials.client,
            });
          }
        });
      }
      try {
        await yt.session.signIn({ ...auth.oauthCredentials });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw createCodedError(
          `Server YouTube authorization expired or was revoked (${msg}).`,
          'YOUTUBE_OAUTH_INVALID'
        );
      }
    }

    return yt;
  }

  const cacheKey = `${clientName}:${sessionTokens ? 'session' : 'anon'}`;
  const cached = cachedInnertubeByClient.get(cacheKey);
  const shouldRefresh = !cached || now - cached.createdAt > PLAYER_REFRESH_MS;

  let baseInnertube = cached?.instance;
  if (!baseInnertube || shouldRefresh || sessionTokens) {
    baseInnertube = await Innertube.create({
      fetch: cobaltFetch,
      retrieve_player: true,
      client_type: clientTypeEnum,
      po_token: sessionTokens?.potoken,
      visitor_data: sessionTokens?.visitor_data,
    });
    cachedInnertubeByClient.set(cacheKey, { instance: baseInnertube, createdAt: now });
  }

  const ytSession = new Session(
    baseInnertube.session.context,
    baseInnertube.session.api_key,
    baseInnertube.session.api_version,
    baseInnertube.session.account_index,
    baseInnertube.session.config_data,
    baseInnertube.session.player,
    undefined,
    cobaltFetch,
    baseInnertube.session.cache,
    sessionTokens?.potoken
  );
  return new Innertube(ytSession);
}

function parseMimeCodec(mimeType: string | undefined): {
  container: string;
  codec: string | null;
} {
  if (!mimeType) return { container: 'mp4', codec: null };
  const [mimePart, paramsPart] = mimeType.split(';').map((s) => s.trim());
  const container = mimePart.split('/')[1]?.toLowerCase() || 'mp4';
  const codecMatch = paramsPart?.match(/codecs="([^"]+)"/i);
  return { container, codec: codecMatch?.[1] || null };
}

function pickBestAudioFormat(formats: RawAdaptiveOrMuxedFormat[]): RawAdaptiveOrMuxedFormat | null {
  const audioOnly = formats.filter((f) => !f.has_video && f.has_audio);
  if (audioOnly.length === 0) return null;
  audioOnly.sort((a, b) => {
    const aIsMp4 = (a.mime_type || '').includes('mp4a') ? 1 : 0;
    const bIsMp4 = (b.mime_type || '').includes('mp4a') ? 1 : 0;
    if (aIsMp4 !== bIsMp4) return bIsMp4 - aIsMp4;
    return (b.average_bitrate || b.bitrate || 0) - (a.average_bitrate || a.bitrate || 0);
  });
  return audioOnly[0];
}

function classifyInnertubeFailure(status: string | undefined, reason: string | undefined): Error {
  const r = (reason || '').toLowerCase();
  if (status === 'LOGIN_REQUIRED') {
    if (r.includes('bot') || r.includes('confirm') || r.includes('sign in')) {
      return createCodedError(
        'YouTube temporarily blocked automated access for this video from our shared cloud server. Please try another public YouTube video or a direct video link.',
        'YOUTUBE_BOT_CHECK'
      );
    }
    if (r.includes('age') || r.includes('inappropriate')) {
      return new Error('This YouTube video is age-restricted and cannot be downloaded without sign-in.');
    }
    if (r.includes('private')) {
      return new Error('This YouTube video is private and cannot be downloaded.');
    }
  }
  if (status === 'UNPLAYABLE') {
    if (r.includes('country') || r.includes('region')) {
      return new Error('This YouTube video is geo-restricted from this server location.');
    }
    return new Error(reason || 'This YouTube video is unplayable.');
  }
  return new Error(reason || 'Could not extract playable YouTube streams.');
}

async function resolveWorkingInnertubeInfo(
  videoId: string,
  auth?: YouTubeAuthOptions
): Promise<{
  yt: Innertube;
  client: string;
  info: Awaited<ReturnType<Innertube['getBasicInfo']>>;
}> {
  const oauthCredentials = auth?.oauthCredentials ?? loadServerOAuthCredentials();
  const cookieHeader = netscapeCookiesToHeader(auth?.cookiesText);
  const sessionTokens = await loadYouTubeSessionTokens();

  const candidates = CONFIG.cobaltInnertubeClient
    ? [CONFIG.cobaltInnertubeClient]
    : oauthCredentials
      ? ['TV', 'TV_SIMPLY', 'WEB_EMBEDDED', 'WEB']
      : cookieHeader
        ? ['WEB', 'WEB_EMBEDDED', 'TV', 'MWEB']
        : sessionTokens
          ? ['WEB_EMBEDDED', 'IOS', 'VISIONOS', 'TV_SIMPLY', 'TV', 'MWEB']
          : ['IOS', 'VISIONOS', 'TV_SIMPLY', 'ANDROID', 'ANDROID_VR', 'TV', 'MWEB', 'WEB_EMBEDDED', 'WEB'];

  let lastFailure: Error | null = null;

  for (const clientName of candidates) {
    try {
      const yt = await getInnertubeInstance(
        clientName,
        clientName === 'WEB_EMBEDDED' || clientName === 'WEB' ? sessionTokens : null,
        {
          oauthCredentials,
          cookieHeader: oauthCredentials ? null : cookieHeader,
          onUpdatedCredentials: auth?.onUpdatedCredentials,
        }
      );
      const info = await yt.getBasicInfo(videoId, {
        client: clientName as NonNullable<Parameters<Innertube['getBasicInfo']>[1]>['client'],
      });
      const status = info.playability_status?.status;
      const reason = info.playability_status?.reason;

      if (status !== 'OK') {
        lastFailure = classifyInnertubeFailure(status, reason);
        continue;
      }

      if (info.basic_info?.is_live) {
        throw new Error('YouTube live streams cannot be pre-analyzed or downloaded as finite files.');
      }

      const adaptive = (info.streaming_data?.adaptive_formats || []) as unknown as RawAdaptiveOrMuxedFormat[];
      const muxed = (info.streaming_data?.formats || []) as unknown as RawAdaptiveOrMuxedFormat[];
      const hlsUrl = info.streaming_data?.hls_manifest_url;

      if (adaptive.length === 0 && muxed.length === 0 && !hlsUrl) {
        lastFailure = new Error(`Cobalt Innertube client ${clientName} returned no playable formats.`);
        continue;
      }

      // Verify at least one format actually deciphers cleanly (or HLS manifest is present)
      const all = [...muxed, ...adaptive];
      let hasPlayableStream = Boolean(hlsUrl);
      if (!hasPlayableStream && all.length > 0) {
        try {
          const sampleUrl = await all[0].decipher(yt.session.player);
          if (sampleUrl && sampleUrl.startsWith('http')) {
            hasPlayableStream = true;
          }
        } catch {
          hasPlayableStream = false;
        }
      }
      if (!hasPlayableStream) {
        lastFailure = new Error(`Cobalt Innertube client ${clientName} returned no decipherable stream URLs.`);
        continue;
      }

      return { yt, client: clientName, info };
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('live streams') ||
          (err as Error & { code?: string }).code === 'YOUTUBE_OAUTH_INVALID')
      ) {
        throw err;
      }
      lastFailure = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw (
    lastFailure ||
    new Error('Cobalt YouTube adapter could not extract this video from any Innertube client.')
  );
}

export async function analyzeYouTubeWithCobalt(
  url: string,
  auth?: YouTubeAuthOptions
): Promise<AnalyzedMedia> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    throw new Error(
      'Please enter a single public YouTube video, Shorts, or Share URL (playlists and channels are not supported).'
    );
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Mode A: Self-hosted official Cobalt API server (COBALT_API_URL)
  if (CONFIG.cobaltApiUrl) {
    const [oembed, probeResult] = await Promise.all([
      fetchYouTubeOembed(videoId),
      callCobaltApi({
        url: canonicalUrl,
        videoQuality: '1080',
        youtubeVideoCodec: 'h264',
        filenameStyle: 'basic',
      }),
    ]);

    const videoFormats: VideoFormatOption[] = COBALT_QUALITY_TIERS.map((tier, idx) => ({
      id: `cobalt:${tier.quality}`,
      label: tier.label,
      qualityTag: `${tier.height}p`,
      height: tier.height,
      width: Math.round((tier.height * 16) / 9),
      fps: null,
      ext: 'mp4',
      vcodec: 'h264/vp9',
      acodec: 'aac',
      filesize: null,
      tbr: null,
      hasVideo: true,
      hasAudio: true,
      needsMerge: probeResult.status === 'local-processing',
      audioFormatId: idx === 0 ? 'cobalt:audio:128' : null,
    }));

    const audioFormats: VideoFormatOption[] = [
      {
        id: 'cobalt:audio:320',
        label: '320 kbps (Cobalt Audio)',
        qualityTag: '320kbps',
        height: null,
        width: null,
        fps: null,
        ext: 'mp3',
        vcodec: null,
        acodec: 'mp3',
        filesize: null,
        tbr: 320,
        hasVideo: false,
        hasAudio: true,
        needsMerge: false,
        audioFormatId: null,
      },
      {
        id: 'cobalt:audio:128',
        label: '128 kbps (Cobalt Audio)',
        qualityTag: '128kbps',
        height: null,
        width: null,
        fps: null,
        ext: 'mp3',
        vcodec: null,
        acodec: 'mp3',
        filesize: null,
        tbr: 128,
        hasVideo: false,
        hasAudio: true,
        needsMerge: false,
        audioFormatId: null,
      },
    ];

    return {
      url: canonicalUrl,
      webpageUrl: canonicalUrl,
      title: oembed.title || `YouTube Video (${videoId})`,
      thumbnail: oembed.thumbnail,
      duration: null,
      durationFormatted: 'Unknown',
      uploader: oembed.uploader,
      source: 'YouTube',
      extractor: 'cobalt-api',
      isDirectMedia: false,
      hasAudioTrack: true,
      canTrim: true,
      canChangeSpeed: true,
      videoFormats,
      audioFormats,
      limits: {
        maxFileSizeMb: CONFIG.maxFileSizeMb,
        maxDurationSec: CONFIG.maxDurationSec,
      },
    };
  }

  // Mode B: Embedded Cobalt engine (youtubei.js + optional OAuth / cookies / YOUTUBE_SESSION_SERVER)
  const { client, info } = await resolveWorkingInnertubeInfo(videoId, auth);
  const basic = info.basic_info;
  const duration =
    typeof basic?.duration === 'number' && Number.isFinite(basic.duration)
      ? basic.duration
      : null;

  if (duration && duration > CONFIG.maxDurationSec) {
    throw new Error(
      `Video duration (${formatDuration(duration)}) exceeds the server limit of ${formatDuration(CONFIG.maxDurationSec)}.`
    );
  }

  const adaptive = (info.streaming_data?.adaptive_formats || []) as unknown as RawAdaptiveOrMuxedFormat[];
  const muxed = (info.streaming_data?.formats || []) as unknown as RawAdaptiveOrMuxedFormat[];
  const allFormats = [...muxed, ...adaptive];

  const bestAudio = pickBestAudioFormat(allFormats);
  const hasMuxedAudio = muxed.some((f) => Boolean(f.has_audio));
  const hasAudioTrack = Boolean(bestAudio || hasMuxedAudio);

  const byHeight = new Map<number, VideoFormatOption>();

  for (const f of allFormats) {
    if (!f.has_video || !f.height || f.height <= 0) continue;
    const isMuxed = Boolean(f.has_audio);
    const needsMerge = !isMuxed && Boolean(bestAudio);
    const { container, codec } = parseMimeCodec(f.mime_type);
    const estSize =
      typeof f.content_length === 'number' && Number.isFinite(f.content_length)
        ? f.content_length
        : null;
    const audioSize =
      needsMerge && estSize && bestAudio?.content_length
        ? estSize + bestAudio.content_length
        : estSize;

    const audioCodec = isMuxed
      ? codec?.split(',')[1]?.trim() || 'aac'
      : parseMimeCodec(bestAudio?.mime_type).codec || 'aac';

    const option: VideoFormatOption = {
      id: `yt:${f.itag}`,
      label: `${f.height}p`,
      qualityTag: `${f.height}p`,
      height: f.height,
      width: f.width ?? null,
      fps: f.fps ?? null,
      ext: container === 'webm' ? 'webm' : 'mp4',
      vcodec: codec?.split(',')[0]?.trim() || null,
      acodec: audioCodec,
      filesize: audioSize,
      tbr: f.bitrate ? Math.round(f.bitrate / 1000) : null,
      hasVideo: true,
      hasAudio: isMuxed || Boolean(bestAudio),
      needsMerge,
      audioFormatId: needsMerge && bestAudio ? `yt:${bestAudio.itag}` : null,
    };

    const existing = byHeight.get(f.height);
    if (!existing) {
      byHeight.set(f.height, option);
    } else {
      const score = (opt: VideoFormatOption) => {
        let s = 0;
        if (opt.vcodec?.startsWith('avc1') || opt.vcodec?.startsWith('h264')) s += 1000;
        else if (opt.vcodec?.startsWith('vp9') || opt.vcodec?.startsWith('vp09')) s += 700;
        if (opt.ext === 'mp4') s += 300;
        if (!opt.needsMerge) s += 150;
        s += (opt.tbr || 0) / 100;
        return s;
      };
      if (score(option) > score(existing)) {
        byHeight.set(f.height, option);
      }
    }
  }

  // Fallback to HLS variants if Innertube returned only HLS manifest (iOS client edge case)
  if (byHeight.size === 0 && info.streaming_data?.hls_manifest_url) {
    const hlsRes = await cobaltFetch(info.streaming_data.hls_manifest_url);
    if (hlsRes.ok) {
      const manifestText = await hlsRes.text();
      const parsedHls = HLS.parse(manifestText);
      if (parsedHls && 'variants' in parsedHls && Array.isArray(parsedHls.variants)) {
        for (const variant of parsedHls.variants) {
          const height = variant.resolution?.height;
          if (!height || height <= 0) continue;
          const normalized = YOUTUBE_VIDEO_QUALITIES.find((q) => q >= height) ?? height;
          if (!byHeight.has(normalized)) {
            byHeight.set(normalized, {
              id: `yt-hls:${normalized}`,
              label: `${normalized}p`,
              qualityTag: `${normalized}p`,
              height: normalized,
              width: variant.resolution?.width ?? null,
              fps: null,
              ext: 'mp4',
              vcodec: variant.codecs || 'h264',
              acodec: 'aac',
              filesize: null,
              tbr: variant.bandwidth ? Math.round(Number(variant.bandwidth) / 1000) : null,
              hasVideo: true,
              hasAudio: true,
              needsMerge: false,
              audioFormatId: null,
            });
          }
        }
      }
    }
  }

  const sortedHeights = Array.from(byHeight.values()).sort((a, b) => (b.height || 0) - (a.height || 0));
  const videoFormats: VideoFormatOption[] = [];
  if (sortedHeights.length > 0) {
    videoFormats.push({
      ...sortedHeights[0],
      label: sortedHeights[0].height
        ? `Original (${sortedHeights[0].height}p)`
        : 'Original (Best Available)',
    });
    for (const fmt of sortedHeights.slice(1)) {
      videoFormats.push(fmt);
    }
  }

  const audioOnlyRaw = allFormats
    .filter((f) => !f.has_video && f.has_audio)
    .sort((a, b) => (b.average_bitrate || b.bitrate || 0) - (a.average_bitrate || a.bitrate || 0));

  const audioFormats: VideoFormatOption[] = [];
  const seenAudio = new Set<string>();
  for (const a of audioOnlyRaw.slice(0, 4)) {
    const { container, codec } = parseMimeCodec(a.mime_type);
    const kbps = Math.round((a.average_bitrate || a.bitrate || 0) / 1000);
    const ext = container === 'webm' ? 'webm' : 'm4a';
    const key = `${ext}-${kbps}`;
    if (seenAudio.has(key)) continue;
    seenAudio.add(key);
    audioFormats.push({
      id: `yt:${a.itag}`,
      label: kbps > 0 ? `${kbps} kbps (${ext.toUpperCase()})` : `Audio (${ext.toUpperCase()})`,
      qualityTag: kbps > 0 ? `${kbps}kbps` : 'Audio',
      height: null,
      width: null,
      fps: null,
      ext,
      vcodec: null,
      acodec: codec,
      filesize: typeof a.content_length === 'number' ? a.content_length : null,
      tbr: kbps || null,
      hasVideo: false,
      hasAudio: true,
      needsMerge: false,
      audioFormatId: null,
    });
  }

  if (audioFormats.length === 0 && hasAudioTrack && videoFormats[0]) {
    audioFormats.push({
      id: videoFormats[0].id,
      label: 'Extract Audio from Video',
      qualityTag: 'Extracted',
      height: null,
      width: null,
      fps: null,
      ext: 'mp3',
      vcodec: null,
      acodec: 'mp3',
      filesize: null,
      tbr: 192,
      hasVideo: false,
      hasAudio: true,
      needsMerge: false,
      audioFormatId: null,
    });
  }

  if (videoFormats.length === 0 && audioFormats.length === 0) {
    throw new Error('Cobalt extracted video metadata but found no downloadable streams.');
  }

  const bestThumb =
    basic?.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    url: canonicalUrl,
    webpageUrl: canonicalUrl,
    title: basic?.title || `YouTube Video (${videoId})`,
    thumbnail: bestThumb,
    duration,
    durationFormatted: formatDuration(duration),
    uploader: basic?.author || basic?.channel?.name || null,
    source: 'YouTube',
    extractor: `cobalt-${client.toLowerCase()}`,
    isDirectMedia: false,
    hasAudioTrack,
    canTrim: true,
    canChangeSpeed: videoFormats.length > 0,
    videoFormats,
    audioFormats,
    limits: {
      maxFileSizeMb: CONFIG.maxFileSizeMb,
      maxDurationSec: CONFIG.maxDurationSec,
    },
  };
}

function isSameOriginAsCobaltApi(targetUrl: string): boolean {
  if (!CONFIG.cobaltApiUrl) return false;
  try {
    return new URL(targetUrl).origin === new URL(CONFIG.cobaltApiUrl).origin;
  } catch {
    return false;
  }
}

function getHeadersForClient(clientName: string | undefined): Record<string, string> {
  const c = (clientName || '').toUpperCase();
  if (c === 'IOS') {
    return { 'User-Agent': Constants.CLIENTS.IOS.USER_AGENT };
  }
  if (c === 'VISIONOS') {
    return { 'User-Agent': Constants.CLIENTS.VISIONOS.USER_AGENT };
  }
  if (c === 'ANDROID') {
    return { 'User-Agent': Constants.CLIENTS.ANDROID.USER_AGENT };
  }
  if (c === 'ANDROID_VR') {
    return { 'User-Agent': Constants.CLIENTS.ANDROID_VR.USER_AGENT };
  }
  if (c === 'TV' || c === 'TV_SIMPLY' || c === 'TV_EMBEDDED') {
    return {
      'User-Agent': Constants.CLIENTS.TV.USER_AGENT,
      Origin: 'https://www.youtube.com',
      Referer: 'https://www.youtube.com/',
    };
  }
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
  };
}

async function streamUrlToFile(params: {
  url: string;
  targetPath: string;
  maxBytes: number;
  baseOffset: number;
  knownTotalBytes: number | null;
  headers?: Record<string, string>;
  abortSignal: AbortSignal;
  onProgress: (downloadedBytes: number, totalBytes: number | null, speedText: string | null, etaText: string | null) => void;
}): Promise<number> {
  const fetchFn = isSameOriginAsCobaltApi(params.url)
    ? (u: string, init: RequestInit) => fetch(u, init)
    : CONFIG.cobaltProxy
      ? (u: string, init: RequestInit) => cobaltFetch(u, init)
      : (u: string, init: RequestInit) => safeFetchPublic(u, { headers: init.headers as Record<string, string>, signal: init.signal ?? undefined });

  const response = await fetchFn(params.url, {
    headers: params.headers || {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: params.abortSignal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Cobalt stream download returned HTTP ${response.status}.`);
  }

  const contentLen = response.headers.get('content-length');
  const streamLen = contentLen ? Number.parseInt(contentLen, 10) : null;
  const totalBytes =
    params.knownTotalBytes ?? (streamLen && Number.isFinite(streamLen) ? params.baseOffset + streamLen : null);

  if (streamLen && params.baseOffset + streamLen > params.maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error(`Stream exceeds the ${CONFIG.maxFileSizeMb} MB server limit.`);
  }

  const fileStream = fs.createWriteStream(params.targetPath);
  let streamError: Error | null = null;
  fileStream.on('error', (err) => {
    streamError = err;
  });

  const reader = response.body.getReader();
  let downloadedHere = 0;
  let bytesSinceLast = 0;
  let lastEmit = Date.now();
  let lastSpeedCheck = Date.now();

  try {
    while (true) {
      if (params.abortSignal.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error('Download cancelled by user.');
      }
      if (streamError) throw streamError;

      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      downloadedHere += value.byteLength;
      bytesSinceLast += value.byteLength;

      if (params.baseOffset + downloadedHere > params.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Download aborted: exceeded ${CONFIG.maxFileSizeMb} MB limit.`);
      }

      const ok = fileStream.write(value);
      if (!ok) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            fileStream.off('error', onErr);
            resolve();
          };
          const onErr = (err: Error) => {
            fileStream.off('drain', onDrain);
            reject(err);
          };
          fileStream.once('drain', onDrain);
          fileStream.once('error', onErr);
        });
      }

      const now = Date.now();
      if (now - lastEmit >= 250) {
        const dt = Math.max((now - lastSpeedCheck) / 1000, 0.1);
        const bps = bytesSinceLast / dt;
        const speedText =
          bps > 1024 * 1024
            ? `${(bps / (1024 * 1024)).toFixed(2)} MB/s`
            : `${(bps / 1024).toFixed(0)} KB/s`;
        const totalDownloaded = params.baseOffset + downloadedHere;
        let etaText: string | null = null;
        if (totalBytes && totalBytes > totalDownloaded && bps > 0) {
          etaText = `${Math.round((totalBytes - totalDownloaded) / bps)}s`;
        }
        params.onProgress(totalDownloaded, totalBytes, speedText, etaText);
        lastEmit = now;
        bytesSinceLast = 0;
        lastSpeedCheck = now;
      }
    }

    if (streamError) throw streamError;
  } finally {
    await new Promise<void>((resolve) => fileStream.end(() => resolve()));
  }

  return downloadedHere;
}

async function mergeStreamsWithFfmpeg(params: {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  abortSignal: AbortSignal;
  onActiveChild: (child: ChildProcess | null) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      CONFIG.ffmpegBin,
      ['-y', '-i', params.videoPath, '-i', params.audioPath, '-c', 'copy', params.outputPath],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    params.onActiveChild(child);

    let stderr = '';
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore
      }
    };
    params.abortSignal.addEventListener('abort', onAbort, { once: true });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('error', (err) => {
      params.abortSignal.removeEventListener('abort', onAbort);
      params.onActiveChild(null);
      reject(err);
    });

    child.on('close', (code) => {
      params.abortSignal.removeEventListener('abort', onAbort);
      params.onActiveChild(null);
      if (params.abortSignal.aborted) {
        reject(new Error('Download cancelled by user.'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`FFmpeg stream merge failed (${stderr.trim().split('\n').slice(-2).join(' ') || `code ${code}`}).`));
        return;
      }
      resolve();
    });
  });
}

async function downloadHlsWithFfmpeg(params: {
  hlsUrl: string;
  outputPath: string;
  abortSignal: AbortSignal;
  onActiveChild: (child: ChildProcess | null) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      CONFIG.ffmpegBin,
      ['-y', '-i', params.hlsUrl, '-c', 'copy', params.outputPath],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    params.onActiveChild(child);

    let stderr = '';
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore
      }
    };
    params.abortSignal.addEventListener('abort', onAbort, { once: true });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('error', (err) => {
      params.abortSignal.removeEventListener('abort', onAbort);
      params.onActiveChild(null);
      reject(err);
    });

    child.on('close', (code) => {
      params.abortSignal.removeEventListener('abort', onAbort);
      params.onActiveChild(null);
      if (params.abortSignal.aborted) {
        reject(new Error('Download cancelled by user.'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`FFmpeg HLS download failed (${stderr.trim().split('\n').slice(-2).join(' ') || `code ${code}`}).`));
        return;
      }
      resolve();
    });
  });
}

export async function downloadYouTubeWithCobalt(params: YouTubeDownloadParams): Promise<string> {
  const videoId = extractYouTubeVideoId(params.url);
  if (!videoId) {
    throw new Error('Invalid YouTube video URL.');
  }
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Mode A: Self-hosted official Cobalt API server
  if (CONFIG.cobaltApiUrl && (params.formatId.startsWith('cobalt:') || params.formatId === 'best')) {
    params.onProgress({
      status: 'downloading',
      phaseLabel: 'Requesting Cobalt YouTube stream',
      progress: 5,
    });

    let videoQuality = '1080';
    let audioBitrate = '128';
    if (params.formatId.startsWith('cobalt:audio:')) {
      audioBitrate = params.formatId.slice('cobalt:audio:'.length) || '128';
    } else if (params.formatId.startsWith('cobalt:')) {
      videoQuality = params.formatId.slice('cobalt:'.length) || '1080';
    }

    const payload: Record<string, unknown> = {
      url: canonicalUrl,
      downloadMode: params.mode === 'audio' ? 'audio' : 'auto',
      videoQuality,
      youtubeVideoCodec: params.container === 'webm' ? 'vp9' : 'h264',
      youtubeVideoContainer:
        params.mode === 'video' && ['mp4', 'webm', 'mkv'].includes(params.container)
          ? params.container
          : 'auto',
      audioFormat: params.mode === 'audio' ? (params.container === 'mp3' ? 'mp3' : 'best') : 'best',
      audioBitrate,
      filenameStyle: 'basic',
    };

    const cobaltRes = await callCobaltApi(payload, params.abortSignal);

    if ((cobaltRes.status === 'tunnel' || cobaltRes.status === 'redirect') && cobaltRes.url) {
      const extFromName = cobaltRes.filename
        ? path.extname(cobaltRes.filename).toLowerCase()
        : '';
      const targetExt = extFromName || (params.mode === 'audio' ? `.${params.container}` : '.mp4');
      const sourcePath = path.join(params.workDir, `source${targetExt}`);

      params.onProgress({
        status: 'downloading',
        phaseLabel: 'Downloading stream via Cobalt',
      });

      await streamUrlToFile({
        url: cobaltRes.url,
        targetPath: sourcePath,
        maxBytes: params.maxFileSizeBytes,
        baseOffset: 0,
        knownTotalBytes: null,
        abortSignal: params.abortSignal,
        onProgress: (downloadedBytes, totalBytes, speedText, etaText) => {
          const pct = totalBytes && totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : null;
          params.onProgress({
            status: 'downloading',
            phaseLabel: 'Downloading stream via Cobalt',
            progress: pct,
            downloadedBytes,
            totalBytes,
            speedText,
            etaText,
          });
        },
      });
      return sourcePath;
    }

    if (cobaltRes.status === 'local-processing' && Array.isArray(cobaltRes.tunnel) && cobaltRes.tunnel.length > 0) {
      if (cobaltRes.tunnel.length === 1) {
        const ext = cobaltRes.output?.filename
          ? path.extname(cobaltRes.output.filename).toLowerCase()
          : params.mode === 'audio'
            ? `.${params.container}`
            : '.mp4';
        const sourcePath = path.join(params.workDir, `source${ext || '.mp4'}`);
        await streamUrlToFile({
          url: cobaltRes.tunnel[0],
          targetPath: sourcePath,
          maxBytes: params.maxFileSizeBytes,
          baseOffset: 0,
          knownTotalBytes: null,
          abortSignal: params.abortSignal,
          onProgress: (downloadedBytes, totalBytes, speedText, etaText) => {
            const pct = totalBytes && totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : null;
            params.onProgress({
              status: 'downloading',
              phaseLabel: 'Downloading stream via Cobalt',
              progress: pct,
              downloadedBytes,
              totalBytes,
              speedText,
              etaText,
            });
          },
        });
        return sourcePath;
      }

      const rawVideoPath = path.join(params.workDir, 'raw_video.bin');
      const rawAudioPath = path.join(params.workDir, 'raw_audio.bin');
      const vBytes = await streamUrlToFile({
        url: cobaltRes.tunnel[0],
        targetPath: rawVideoPath,
        maxBytes: params.maxFileSizeBytes,
        baseOffset: 0,
        knownTotalBytes: null,
        abortSignal: params.abortSignal,
        onProgress: (downloadedBytes, totalBytes, speedText, etaText) => {
          const pct = totalBytes && totalBytes > 0 ? Math.min(75, Math.round((downloadedBytes / totalBytes) * 75)) : null;
          params.onProgress({
            status: 'downloading',
            phaseLabel: 'Downloading video stream via Cobalt',
            progress: pct,
            downloadedBytes,
            totalBytes,
            speedText,
            etaText,
          });
        },
      });
      await streamUrlToFile({
        url: cobaltRes.tunnel[1],
        targetPath: rawAudioPath,
        maxBytes: params.maxFileSizeBytes,
        baseOffset: vBytes,
        knownTotalBytes: null,
        abortSignal: params.abortSignal,
        onProgress: (downloadedBytes, totalBytes, speedText, etaText) => {
          const pct = totalBytes && totalBytes > 0 ? Math.min(95, Math.round((downloadedBytes / totalBytes) * 95)) : 80;
          params.onProgress({
            status: 'downloading',
            phaseLabel: 'Downloading audio stream via Cobalt',
            progress: pct,
            downloadedBytes,
            totalBytes,
            speedText,
            etaText,
          });
        },
      });

      const mergedExt = ['mp4', 'webm', 'mkv'].includes(params.container) ? params.container : 'mp4';
      const mergedPath = path.join(params.workDir, `source.${mergedExt}`);
      params.onProgress({
        status: 'merging',
        phaseLabel: 'Merging Cobalt video & audio with FFmpeg',
        progress: 96,
      });
      await mergeStreamsWithFfmpeg({
        videoPath: rawVideoPath,
        audioPath: rawAudioPath,
        outputPath: mergedPath,
        abortSignal: params.abortSignal,
        onActiveChild: params.onActiveChild,
      });
      fs.rmSync(rawVideoPath, { force: true });
      fs.rmSync(rawAudioPath, { force: true });
      return mergedPath;
    }

    throw new Error('Cobalt API returned an unsupported response payload.');
  }

  // Mode B: Embedded Cobalt Innertube engine (youtubei.js)
  params.onProgress({
    status: 'downloading',
    phaseLabel: 'Connecting via Cobalt Innertube engine',
    progress: 2,
  });

  const { yt, client, info } = await resolveWorkingInnertubeInfo(videoId, {
    oauthCredentials: params.oauthCredentials,
    cookiesText: params.cookiesText,
  });
  const streamHeaders = getHeadersForClient(client);
  const adaptive = (info.streaming_data?.adaptive_formats || []) as unknown as RawAdaptiveOrMuxedFormat[];
  const muxed = (info.streaming_data?.formats || []) as unknown as RawAdaptiveOrMuxedFormat[];
  const allFormats = [...muxed, ...adaptive];

  // Handle HLS fallback format
  if (params.formatId.startsWith('yt-hls:') && info.streaming_data?.hls_manifest_url) {
    const hlsRes = await cobaltFetch(info.streaming_data.hls_manifest_url, {
      signal: params.abortSignal,
    });
    if (!hlsRes.ok) {
      throw new Error(`Failed to fetch YouTube HLS manifest (HTTP ${hlsRes.status}).`);
    }
    const parsedHls = HLS.parse(await hlsRes.text());
    const targetHeight = Number.parseInt(params.formatId.slice('yt-hls:'.length), 10) || 1080;
    const variants =
      parsedHls && 'variants' in parsedHls && Array.isArray(parsedHls.variants)
        ? [...parsedHls.variants].sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth))
        : [];
    const chosen =
      variants.find((v) => (v.resolution?.height || 0) <= targetHeight) || variants[0];
    if (!chosen?.uri) {
      throw new Error('No compatible HLS stream variant found.');
    }
    const sourcePath = path.join(params.workDir, 'source.mp4');
    params.onProgress({
      status: 'downloading',
      phaseLabel: 'Downloading HLS stream via FFmpeg',
      progress: 35,
    });
    await downloadHlsWithFfmpeg({
      hlsUrl: chosen.uri,
      outputPath: sourcePath,
      abortSignal: params.abortSignal,
      onActiveChild: params.onActiveChild,
    });
    return sourcePath;
  }

  const requestedItag = params.formatId.startsWith('yt:')
    ? Number.parseInt(params.formatId.slice('yt:'.length), 10)
    : Number.NaN;

  let primaryFormat = Number.isFinite(requestedItag)
    ? allFormats.find((f) => f.itag === requestedItag) || null
    : null;

  if (!primaryFormat) {
    if (params.mode === 'audio') {
      primaryFormat = pickBestAudioFormat(allFormats);
    } else {
      const videoCandidates = allFormats
        .filter((f) => f.has_video && f.height)
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      primaryFormat = videoCandidates[0] || allFormats[0] || null;
    }
  }

  if (!primaryFormat) {
    throw new Error('Selected YouTube format is no longer available.');
  }

  const audioItag =
    params.audioFormatId && params.audioFormatId.startsWith('yt:')
      ? Number.parseInt(params.audioFormatId.slice('yt:'.length), 10)
      : Number.NaN;
  const separateAudioFormat =
    params.mode === 'video' && !primaryFormat.has_audio
      ? (Number.isFinite(audioItag)
          ? allFormats.find((f) => f.itag === audioItag) || pickBestAudioFormat(allFormats)
          : pickBestAudioFormat(allFormats))
      : null;

  const primaryUrl = await primaryFormat.decipher(yt.session.player);
  const { container: primaryExt } = parseMimeCodec(primaryFormat.mime_type);
  const primaryTotal =
    typeof primaryFormat.content_length === 'number' ? primaryFormat.content_length : null;
  const audioTotal =
    separateAudioFormat && typeof separateAudioFormat.content_length === 'number'
      ? separateAudioFormat.content_length
      : 0;
  const combinedTotal = primaryTotal ? primaryTotal + audioTotal : null;

  const tryHlsFallback = async (): Promise<string | null> => {
    if (!info.streaming_data?.hls_manifest_url || params.mode === 'audio') return null;
    const hlsRes = await cobaltFetch(info.streaming_data.hls_manifest_url, {
      signal: params.abortSignal,
    });
    if (!hlsRes.ok) return null;
    const parsedHls = HLS.parse(await hlsRes.text());
    const targetHeight = primaryFormat.height || 1080;
    const variants =
      parsedHls && 'variants' in parsedHls && Array.isArray(parsedHls.variants)
        ? [...parsedHls.variants].sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth))
        : [];
    const chosen = variants.find((v) => (v.resolution?.height || 0) <= targetHeight) || variants[0];
    if (!chosen?.uri) return null;
    const hlsOutPath = path.join(params.workDir, 'source.mp4');
    params.onProgress({
      status: 'downloading',
      phaseLabel: 'Downloading HLS stream via FFmpeg',
      progress: 35,
    });
    await downloadHlsWithFfmpeg({
      hlsUrl: chosen.uri,
      outputPath: hlsOutPath,
      abortSignal: params.abortSignal,
      onActiveChild: params.onActiveChild,
    });
    return hlsOutPath;
  };

  if (!separateAudioFormat) {
    const ext =
      params.mode === 'audio'
        ? primaryExt === 'webm'
          ? 'webm'
          : 'm4a'
        : primaryExt === 'webm'
          ? 'webm'
          : 'mp4';
    const sourcePath = path.join(params.workDir, `source.${ext}`);
    try {
      await streamUrlToFile({
        url: primaryUrl,
        targetPath: sourcePath,
        maxBytes: params.maxFileSizeBytes,
        baseOffset: 0,
        knownTotalBytes: combinedTotal,
        headers: streamHeaders,
        abortSignal: params.abortSignal,
        onProgress: (downloadedBytes, totalBytes, speedText, etaText) => {
          const pct = totalBytes && totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : null;
          params.onProgress({
            status: 'downloading',
            phaseLabel: 'Downloading YouTube media stream',
            progress: pct,
            downloadedBytes,
            totalBytes,
            speedText,
            etaText,
          });
        },
      });
      return sourcePath;
    } catch (streamErr) {
      if (streamErr instanceof Error && streamErr.message.includes('403')) {
        const hlsPath = await tryHlsFallback();
        if (hlsPath) return hlsPath;
      }
      throw streamErr;
    }
  }

  const audioUrl = await separateAudioFormat.decipher(yt.session.player);
  const { container: audioExt } = parseMimeCodec(separateAudioFormat.mime_type);
  const videoPartPath = path.join(params.workDir, `video_part.${primaryExt === 'webm' ? 'webm' : 'mp4'}`);
  const audioPartPath = path.join(params.workDir, `audio_part.${audioExt === 'webm' ? 'webm' : 'm4a'}`);

  let downloadedVideoBytes = 0;
  try {
    downloadedVideoBytes = await streamUrlToFile({
      url: primaryUrl,
      targetPath: videoPartPath,
      maxBytes: params.maxFileSizeBytes,
      baseOffset: 0,
      knownTotalBytes: combinedTotal,
      headers: streamHeaders,
      abortSignal: params.abortSignal,
      onProgress: (downloadedBytes, totalBytes, speedText, etaText) => {
        const pct = totalBytes && totalBytes > 0 ? Math.min(90, Math.round((downloadedBytes / totalBytes) * 90)) : null;
        params.onProgress({
          status: 'downloading',
          phaseLabel: 'Downloading video stream',
          progress: pct,
          downloadedBytes,
          totalBytes,
          speedText,
          etaText,
        });
      },
    });
  } catch (streamErr) {
    if (streamErr instanceof Error && streamErr.message.includes('403')) {
      const hlsPath = await tryHlsFallback();
      if (hlsPath) return hlsPath;
    }
    throw streamErr;
  }

  await streamUrlToFile({
    url: audioUrl,
    targetPath: audioPartPath,
    maxBytes: params.maxFileSizeBytes,
    baseOffset: downloadedVideoBytes,
    knownTotalBytes: combinedTotal,
    headers: streamHeaders,
    abortSignal: params.abortSignal,
    onProgress: (downloadedBytes, totalBytes, speedText, etaText) => {
      const pct = totalBytes && totalBytes > 0 ? Math.min(95, Math.round((downloadedBytes / totalBytes) * 95)) : 92;
      params.onProgress({
        status: 'downloading',
        phaseLabel: 'Downloading audio stream',
        progress: pct,
        downloadedBytes,
        totalBytes,
        speedText,
        etaText,
      });
    },
  });

  // Match container safely: MP4 cannot hold Opus/WebM audio in copy mode without MKV/re-encode
  const compatibleMp4Merge = primaryExt !== 'webm' && audioExt !== 'webm';
  const mergeExt = compatibleMp4Merge ? 'mp4' : 'mkv';
  const mergedPath = path.join(params.workDir, `source.${mergeExt}`);

  params.onProgress({
    status: 'merging',
    phaseLabel: 'Merging video & audio streams with FFmpeg',
    progress: 96,
  });

  await mergeStreamsWithFfmpeg({
    videoPath: videoPartPath,
    audioPath: audioPartPath,
    outputPath: mergedPath,
    abortSignal: params.abortSignal,
    onActiveChild: params.onActiveChild,
  });

  fs.rmSync(videoPartPath, { force: true });
  fs.rmSync(audioPartPath, { force: true });
  return mergedPath;
}
