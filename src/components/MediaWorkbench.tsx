import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Download, Film, Gauge, Music, RotateCcw, Scissors } from 'lucide-react';
import type { AnalyzedMedia, VideoFormatOption } from '../types';
import {
  formatBytes,
  secondsToTimestamp,
  shortCodec,
  timestampToSeconds,
} from '../utils/formatters';

interface MediaWorkbenchProps {
  media: AnalyzedMedia;
  isSubmitting: boolean;
  jobError: string | null;
  onStartDownload: (payload: {
    url: string;
    title: string;
    mode: 'video' | 'audio';
    formatId: string;
    audioFormatId: string | null;
    needsMerge: boolean;
    container: string;
    isDirectMedia: boolean;
    duration: number | null;
    trim: { enabled: boolean; start: number; end: number };
    speed: number;
  }) => void;
}

const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 3] as const;

export function MediaWorkbenchSkeleton() {
  return (
    <section
      aria-label="Analyzing media"
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6 animate-pulse"
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5 space-y-3">
          <div className="aspect-video min-h-[180px] w-full rounded-xl bg-slate-200 dark:bg-slate-800" />
          <div className="h-6 w-3/4 rounded-lg bg-slate-200 dark:bg-slate-800" />
          <div className="h-4 w-1/2 rounded-lg bg-slate-200 dark:bg-slate-800" />
        </div>
        <div className="lg:col-span-7 space-y-5">
          <div className="h-12 w-full rounded-xl bg-slate-200 dark:bg-slate-800" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="h-16 rounded-xl bg-slate-200 dark:bg-slate-800" />
            <div className="h-16 rounded-xl bg-slate-200 dark:bg-slate-800" />
          </div>
          <div className="h-12 w-full rounded-xl bg-slate-200 dark:bg-slate-800" />
          <div className="h-13 w-full rounded-xl bg-slate-200 dark:bg-slate-800" />
        </div>
      </div>
    </section>
  );
}

export function MediaWorkbench({
  media,
  isSubmitting,
  jobError,
  onStartDownload,
}: MediaWorkbenchProps) {
  const [mode, setMode] = useState<'video' | 'audio'>(
    media.videoFormats.length > 0 ? 'video' : 'audio'
  );
  const [selectedVideoId, setSelectedVideoId] = useState<string>(
    media.videoFormats[0]?.id || ''
  );
  const [selectedAudioId, setSelectedAudioId] = useState<string>(
    media.audioFormats[0]?.id || ''
  );
  const [container, setContainer] = useState<string>('mp4');
  const [speed, setSpeed] = useState<number>(1);
  const [trimEnabled, setTrimEnabled] = useState<boolean>(false);
  const [trimStartSec, setTrimStartSec] = useState<number>(0);
  const [trimEndSec, setTrimEndSec] = useState<number>(
    media.duration ? Math.max(1, Math.round(media.duration)) : 0
  );
  const [startInput, setStartInput] = useState<string>('00:00');
  const [endInput, setEndInput] = useState<string>(
    media.duration ? secondsToTimestamp(Math.max(1, Math.round(media.duration))) : ''
  );
  const [thumbFailed, setThumbFailed] = useState<boolean>(false);
  const [useProxyThumb, setUseProxyThumb] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    const initialMode = media.videoFormats.length > 0 ? 'video' : 'audio';
    setMode(initialMode);
    setSelectedVideoId(media.videoFormats[0]?.id || '');
    setSelectedAudioId(media.audioFormats[0]?.id || '');
    setContainer(initialMode === 'video' ? 'mp4' : 'mp3');
    setSpeed(1);
    setTrimEnabled(false);
    setTrimStartSec(0);
    const maxDur = media.duration ? Math.max(1, Math.round(media.duration)) : 0;
    setTrimEndSec(maxDur);
    setStartInput('00:00');
    setEndInput(maxDur > 0 ? secondsToTimestamp(maxDur) : '');
    setThumbFailed(false);
    setUseProxyThumb(false);
    setValidationError(null);
  }, [media]);

  const activeFormats: VideoFormatOption[] =
    mode === 'video' ? media.videoFormats : media.audioFormats;

  const selectedFormat = useMemo(() => {
    const targetId = mode === 'video' ? selectedVideoId : selectedAudioId;
    return activeFormats.find((f) => f.id === targetId) || activeFormats[0] || null;
  }, [activeFormats, mode, selectedAudioId, selectedVideoId]);

  const containerOptions = mode === 'video' ? ['mp4', 'webm', 'mkv'] : ['mp3', 'm4a'];

  const handleModeChange = (nextMode: 'video' | 'audio') => {
    setMode(nextMode);
    setContainer(nextMode === 'video' ? 'mp4' : 'mp3');
    setValidationError(null);
  };

  const syncTrimStart = (nextSec: number) => {
    const totalDur = media.duration ? Math.max(1, Math.round(media.duration)) : 3600;
    const maxBound = Math.max(0, totalDur - 1);
    const clamped = Math.max(0, Math.min(nextSec, maxBound));
    setTrimStartSec(clamped);
    setStartInput(secondsToTimestamp(clamped));
    // Preserve open-ended trim (trimEndSec === 0 when duration is unknown)
    const isOpenEnded = !media.duration && trimEndSec === 0 && !endInput.trim();
    if (!isOpenEnded && clamped >= trimEndSec) {
      const bumpedEnd = media.duration ? Math.min(totalDur, clamped + 1) : clamped + 5;
      setTrimEndSec(bumpedEnd);
      setEndInput(secondsToTimestamp(bumpedEnd));
    }
  };

  const syncTrimEnd = (nextSec: number) => {
    const maxBound = media.duration ? Math.max(1, Math.ceil(media.duration)) : 3600;
    const clamped = Math.max(trimStartSec + 1, Math.min(nextSec, maxBound));
    setTrimEndSec(clamped);
    setEndInput(secondsToTimestamp(clamped));
  };

  const resetTrimRange = () => {
    const maxDur = media.duration ? Math.max(1, Math.round(media.duration)) : 0;
    setTrimStartSec(0);
    setStartInput('00:00');
    setTrimEndSec(maxDur);
    setEndInput(maxDur > 0 ? secondsToTimestamp(maxDur) : '');
    setValidationError(null);
  };

  const applyStartText = () => {
    const parsed = timestampToSeconds(startInput);
    if (parsed === null) {
      setStartInput(secondsToTimestamp(trimStartSec));
      return;
    }
    syncTrimStart(parsed);
  };

  const applyEndText = () => {
    if (!media.duration && !endInput.trim()) {
      setTrimEndSec(0);
      setEndInput('');
      return;
    }
    const parsed = timestampToSeconds(endInput);
    if (parsed === null) {
      setEndInput(trimEndSec > 0 ? secondsToTimestamp(trimEndSec) : '');
      return;
    }
    syncTrimEnd(parsed);
  };

  const handleDownloadClick = () => {
    setValidationError(null);
    if (!selectedFormat) {
      setValidationError('No downloadable format is selected.');
      return;
    }

    let finalStart = trimStartSec;
    let finalEnd = trimEndSec;

    if (trimEnabled) {
      const parsedStart = timestampToSeconds(startInput);
      if (parsedStart === null) {
        setValidationError('Enter a valid MM:SS timestamp for trim start.');
        return;
      }
      finalStart = Math.max(0, parsedStart);

      const trimmedEndRaw = endInput.trim();
      if (!media.duration && trimmedEndRaw === '') {
        finalEnd = 0;
        if (finalStart === 0) {
          setValidationError('Enter a trim start or end time, or turn Trim off for the full video.');
          return;
        }
      } else {
        const parsedEnd = timestampToSeconds(trimmedEndRaw);
        if (parsedEnd === null) {
          setValidationError('Enter valid MM:SS timestamps for trim start and end.');
          return;
        }
        finalEnd = parsedEnd;
        if (finalEnd <= finalStart) {
          setValidationError('Trim end time must be greater than start time.');
          return;
        }
        if (media.duration && finalEnd > Math.ceil(media.duration) + 1) {
          setValidationError('Trim end time cannot exceed the video duration.');
          return;
        }
      }
    }

    onStartDownload({
      url: media.url,
      title: media.title,
      mode,
      formatId: selectedFormat.id,
      audioFormatId: selectedFormat.audioFormatId,
      needsMerge: selectedFormat.needsMerge,
      container,
      isDirectMedia: media.isDirectMedia,
      duration: media.duration,
      trim: {
        enabled: trimEnabled,
        start: finalStart,
        end: finalEnd,
      },
      speed,
    });
  };

  const thumbnailSrc = media.thumbnail
    ? useProxyThumb
      ? `/api/thumbnail?url=${encodeURIComponent(media.thumbnail)}`
      : media.thumbnail
    : null;

  const trimmedDuration = Math.max(0, trimEndSec - trimStartSec);
  const outputDurationEstimate =
    speed !== 1
      ? (trimEnabled ? trimmedDuration : media.duration || 0) / speed
      : trimEnabled
        ? trimmedDuration
        : media.duration || 0;

  const totalDurBar = media.duration && media.duration > 0 ? Math.max(1, Math.ceil(media.duration)) : 0;
  const trimBarLeftPct = totalDurBar > 0 ? Math.min(100, Math.max(0, (trimStartSec / totalDurBar) * 100)) : 0;
  const trimBarWidthPct =
    totalDurBar > 0
      ? Math.min(100 - trimBarLeftPct, Math.max(2, ((trimEndSec - trimStartSec) / totalDurBar) * 100))
      : 100;

  const needsContainerTranscode =
    mode === 'video' &&
    Boolean(selectedFormat) &&
    selectedFormat!.ext.toLowerCase() !== container.toLowerCase() &&
    !trimEnabled &&
    speed === 1;

  const combinedError = validationError || jobError;

  return (
    <section
      id="workbench"
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6"
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
        {/* Left: Video Preview & Metadata */}
        <div className="lg:col-span-5">
          <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 aspect-video min-h-[180px] relative">
            {thumbnailSrc && !thumbFailed ? (
              <img
                src={thumbnailSrc}
                alt={media.title}
                referrerPolicy="no-referrer"
                onError={() => {
                  if (!useProxyThumb) {
                    setUseProxyThumb(true);
                  } else {
                    setThumbFailed(true);
                  }
                }}
                className="h-full w-full object-cover"
              />
            ) : media.isDirectMedia && media.videoFormats.length > 0 ? (
              <video
                src={media.url}
                controls
                preload="metadata"
                playsInline
                className="h-full w-full bg-black object-contain"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center p-4 text-slate-400 dark:text-slate-600">
                <Film className="h-10 w-10 mb-2" />
                <span className="text-xs font-medium text-center">{media.source}</span>
              </div>
            )}
          </div>

          <h2 className="mt-4 text-lg sm:text-xl font-bold text-slate-900 dark:text-white leading-snug break-words">
            {media.title}
          </h2>

          <div className="mt-2 flex flex-wrap items-center text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            <span>{media.source}</span>
            <span className="mx-2" aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">Duration: {media.durationFormatted}</span>
            {media.uploader && (
              <>
                <span className="mx-2" aria-hidden="true">·</span>
                <span className="truncate max-w-[200px]">{media.uploader}</span>
              </>
            )}
          </div>

          <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-3 flex flex-wrap items-center text-xs text-slate-500 dark:text-slate-400">
            <span>
              Engine: <span className="font-medium text-slate-700 dark:text-slate-200">{media.extractor}</span>
            </span>
            <span className="mx-2" aria-hidden="true">·</span>
            <span>
              Max size: <span className="font-mono tabular-nums">{media.limits.maxFileSizeMb} MB</span>
            </span>
          </div>
        </div>

        {/* Right: Format, Quality, Trim & Playback Speed Controls */}
        <div className="lg:col-span-7 space-y-5">
          {/* Mode Tabs */}
          <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-950 p-1 border border-slate-200 dark:border-slate-800">
            <button
              type="button"
              disabled={media.videoFormats.length === 0}
              onClick={() => handleModeChange('video')}
              className={`min-h-[44px] inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                mode === 'video'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white disabled:opacity-40'
              }`}
            >
              <Film className="mr-2 h-4 w-4 shrink-0" />
              <span>Video</span>
            </button>

            <button
              type="button"
              disabled={!media.hasAudioTrack && media.audioFormats.length === 0}
              onClick={() => handleModeChange('audio')}
              className={`min-h-[44px] inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                mode === 'audio'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white disabled:opacity-40'
              }`}
            >
              <Music className="mr-2 h-4 w-4 shrink-0" />
              <span>Audio Only</span>
            </button>
          </div>

          {/* Quality Selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                {mode === 'video' ? 'Video Quality' : 'Audio Quality'}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {activeFormats.length} {activeFormats.length === 1 ? 'option' : 'options'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-60 overflow-y-auto pr-0.5">
              {activeFormats.map((fmt, index) => {
                const isSelected = selectedFormat?.id === fmt.id && selectedFormat?.label === fmt.label;
                const codecs = [shortCodec(fmt.vcodec), shortCodec(fmt.acodec)].filter(Boolean).join(' + ');

                return (
                  <button
                    key={`${fmt.id}-${fmt.qualityTag}-${index}`}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      if (mode === 'video') setSelectedVideoId(fmt.id);
                      else setSelectedAudioId(fmt.id);
                    }}
                    className={`min-h-[58px] w-full rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                      isSelected
                        ? 'border-blue-600 bg-blue-50/80 dark:bg-blue-950/40 text-slate-900 dark:text-white'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 text-slate-800 dark:text-slate-200 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center text-sm font-bold truncate min-w-0">
                        {isSelected && (
                          <Check className="mr-1.5 h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                        )}
                        <span className="truncate">{fmt.label}</span>
                      </span>
                      <span className="font-mono text-xs font-medium text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                        {formatBytes(fmt.filesize)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center text-xs text-slate-500 dark:text-slate-400 truncate">
                      <span>{fmt.ext.toUpperCase()}</span>
                      {codecs && (
                        <>
                          <span className="mx-1.5" aria-hidden="true">·</span>
                          <span>{codecs}</span>
                        </>
                      )}
                      {fmt.fps && fmt.fps > 30 && (
                        <>
                          <span className="mx-1.5" aria-hidden="true">·</span>
                          <span className="tabular-nums">{fmt.fps}fps</span>
                        </>
                      )}
                      {fmt.needsMerge && (
                        <>
                          <span className="mx-1.5" aria-hidden="true">·</span>
                          <span>Auto-merge</span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Output Container + Playback Speed */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-slate-200 dark:border-slate-800">
            <div>
              <span className="block text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2">
                Output Format
              </span>
              <div className="grid grid-cols-3 gap-2">
                {containerOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={container === c}
                    onClick={() => setContainer(c)}
                    className={`min-h-[44px] rounded-xl border px-2 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${
                      container === c
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="flex items-center text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2">
                <Gauge className="mr-1.5 h-4 w-4 text-slate-500 shrink-0" />
                <span>Playback Speed</span>
              </span>
              <div className="grid grid-cols-5 gap-1.5">
                {SPEED_OPTIONS.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    aria-pressed={speed === sp}
                    onClick={() => setSpeed(sp)}
                    className={`min-h-[44px] rounded-xl border px-1 py-2 font-mono text-xs font-semibold tabular-nums transition-colors ${
                      speed === sp
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {sp}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Trim Controls */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center min-w-0">
                <Scissors className="mr-2 h-4 w-4 text-slate-600 dark:text-slate-400 shrink-0" />
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
                  Trim Clip
                </span>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={trimEnabled}
                disabled={!media.canTrim}
                onClick={() => {
                  setValidationError(null);
                  setTrimEnabled((prev) => !prev);
                }}
                className={`min-h-[40px] rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 whitespace-nowrap shrink-0 ${
                  trimEnabled
                    ? 'bg-blue-600 text-white'
                    : 'border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {media.canTrim ? (trimEnabled ? 'Trim On' : 'Trim Off') : 'Unavailable'}
              </button>
            </div>

            {trimEnabled && (
              <div className="mt-4 space-y-3.5">
                {totalDurBar > 0 && (
                  <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-800 relative overflow-hidden">
                    <div
                      className="absolute top-0 bottom-0 rounded-full bg-blue-600"
                      style={{
                        left: `${trimBarLeftPct}%`,
                        width: `${trimBarWidthPct}%`,
                      }}
                    />
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="trim-start-input"
                      className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                    >
                      Start Time (MM:SS)
                    </label>
                    <input
                      id="trim-start-input"
                      type="text"
                      inputMode="numeric"
                      value={startInput}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setStartInput(raw);
                        const parsed = timestampToSeconds(raw);
                        if (parsed !== null && parsed >= 0) {
                          setTrimStartSec(parsed);
                        }
                      }}
                      onBlur={applyStartText}
                      className="w-full min-h-[44px] rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 font-mono text-base sm:text-sm tabular-nums text-slate-900 dark:text-white focus:border-blue-600 focus:outline-none"
                    />
                    {media.duration && media.duration > 1 ? (
                      <input
                        type="range"
                        min={0}
                        max={Math.max(1, Math.floor(media.duration) - 1)}
                        value={trimStartSec}
                        onChange={(e) => syncTrimStart(Number(e.target.value))}
                        aria-label="Trim start slider"
                        className="clipfetch-range mt-1.5 w-full"
                      />
                    ) : null}
                  </div>

                  <div>
                    <label
                      htmlFor="trim-end-input"
                      className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1"
                    >
                      End Time (MM:SS)
                    </label>
                    <input
                      id="trim-end-input"
                      type="text"
                      inputMode="numeric"
                      value={endInput}
                      placeholder={media.duration ? 'MM:SS' : 'End of video (or MM:SS)'}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setEndInput(raw);
                        if (!raw.trim() && !media.duration) {
                          setTrimEndSec(0);
                          return;
                        }
                        const parsed = timestampToSeconds(raw);
                        if (parsed !== null && parsed >= 0) {
                          setTrimEndSec(parsed);
                        }
                      }}
                      onBlur={applyEndText}
                      className="w-full min-h-[44px] rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 font-mono text-base sm:text-sm tabular-nums text-slate-900 dark:text-white focus:border-blue-600 focus:outline-none"
                    />
                    {media.duration && media.duration > 1 ? (
                      <input
                        type="range"
                        min={1}
                        max={Math.ceil(media.duration)}
                        value={trimEndSec}
                        onChange={(e) => syncTrimEnd(Number(e.target.value))}
                        aria-label="Trim end slider"
                        className="clipfetch-range mt-1.5 w-full"
                      />
                    ) : null}
                  </div>
                </div>

                {!media.duration && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    Leave End Time blank to cut from your start timestamp through the true end of the video.
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
                  <div className="flex flex-wrap items-center">
                    <button
                      type="button"
                      onClick={() => {
                        const targetEnd = media.duration ? Math.min(15, Math.max(1, Math.round(media.duration))) : 15;
                        setTrimStartSec(0);
                        setStartInput('00:00');
                        setTrimEndSec(targetEnd);
                        setEndInput(secondsToTimestamp(targetEnd));
                        setValidationError(null);
                      }}
                      className="mr-2 mb-1 min-h-[38px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      First 15s
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const targetEnd = media.duration ? Math.min(30, Math.max(1, Math.round(media.duration))) : 30;
                        setTrimStartSec(0);
                        setStartInput('00:00');
                        setTrimEndSec(targetEnd);
                        setEndInput(secondsToTimestamp(targetEnd));
                        setValidationError(null);
                      }}
                      className="mr-2 mb-1 min-h-[38px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      First 30s
                    </button>
                    {media.duration && media.duration > 0 && (
                      <button
                        type="button"
                        onClick={resetTrimRange}
                        className="mr-2 mb-1 min-h-[38px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                      >
                        Full Length
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={resetTrimRange}
                      aria-label="Reset trim timestamps"
                      className="mb-1 min-h-[38px] inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />
                      <span>Reset</span>
                    </button>
                  </div>

                  <span className="font-mono tabular-nums">
                    {trimEndSec === 0 && !media.duration
                      ? `From ${secondsToTimestamp(trimStartSec)} to End`
                      : `Clip: ${secondsToTimestamp(trimmedDuration)}${
                          speed !== 1 ? ` · Output: ${secondsToTimestamp(Math.round(outputDurationEstimate))}` : ''
                        }`}
                  </span>
                </div>
              </div>
            )}
          </div>

          {combinedError && (
            <div
              role="alert"
              className="flex items-start rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300"
            >
              <AlertCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
              <span>{combinedError}</span>
            </div>
          )}

          {/* Primary Download CTA */}
          <button
            type="button"
            disabled={isSubmitting || !selectedFormat}
            onClick={handleDownloadClick}
            className="w-full min-h-[52px] inline-flex items-center justify-center rounded-xl bg-blue-600 px-6 py-3.5 text-base font-bold text-white hover:bg-blue-700 active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <Download className="mr-2.5 h-5 w-5 shrink-0" />
            <span>
              {isSubmitting
                ? 'Starting Download...'
                : `Download ${mode === 'audio' ? 'Audio' : selectedFormat?.qualityTag || 'Video'} (${container.toUpperCase()})`}
            </span>
          </button>

          {(speed !== 1 || trimEnabled || selectedFormat?.needsMerge || needsContainerTranscode) && (
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {speed !== 1
                ? `FFmpeg will adjust playback speed to ${speed}x while keeping audio synchronized.`
                : trimEnabled
                  ? 'FFmpeg will extract only your selected time range before serving the file.'
                  : needsContainerTranscode
                    ? `Converting ${selectedFormat!.ext.toUpperCase()} to ${container.toUpperCase()}; select ${selectedFormat!.ext.toUpperCase()} above for instant direct save.`
                    : 'FFmpeg will merge the highest-quality video and audio streams automatically.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
