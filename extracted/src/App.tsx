import { useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './components/Header';
import { UrlAnalyzerForm } from './components/UrlAnalyzerForm';
import { MediaWorkbench, MediaWorkbenchSkeleton } from './components/MediaWorkbench';
import { DownloadManager } from './components/DownloadManager';
import { TechnicalSections } from './components/TechnicalSections';
import type { AnalyzedMedia, DownloadJob } from './types';

function scrollIntoViewSmooth(el: HTMLElement | null) {
  if (!el) return;
  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
      return 'dark';
    }
    return 'light';
  });

  const [url, setUrl] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [analyzedMedia, setAnalyzedMedia] = useState<AnalyzedMedia | null>(null);
  const [isSubmittingJob, setIsSubmittingJob] = useState<boolean>(false);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);

  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());
  const retryTimersRef = useRef<Map<string, number>>(new Map());
  const analyzeAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef<boolean>(true);
  const workbenchWrapRef = useRef<HTMLDivElement | null>(null);
  const downloadsWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('clipfetch_theme', theme);
    } catch {
      // Ignore storage failures
    }
  }, [theme]);

  useEffect(() => {
    mountedRef.current = true;
    const sourcesMap = eventSourcesRef.current;
    const timersMap = retryTimersRef.current;
    return () => {
      mountedRef.current = false;
      analyzeAbortRef.current?.abort();
      for (const timerId of timersMap.values()) {
        window.clearTimeout(timerId);
      }
      timersMap.clear();
      for (const es of sourcesMap.values()) {
        es.close();
      }
      sourcesMap.clear();
    };
  }, []);

  const activeJobKey = useMemo(
    () =>
      jobs
        .filter(
          (j) =>
            j.status === 'queued' ||
            j.status === 'downloading' ||
            j.status === 'merging' ||
            j.status === 'processing'
        )
        .map((j) => j.jobId)
        .join(','),
    [jobs]
  );

  useEffect(() => {
    if (!activeJobKey) return;
    const activeIds = activeJobKey.split(',').filter(Boolean);

    const intervalId = window.setInterval(() => {
      for (const jobId of activeIds) {
        fetch(`/api/jobs/${jobId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((snapshot: DownloadJob | null) => {
            if (!mountedRef.current || !snapshot) return;
            setJobs((prev) => prev.map((j) => (j.jobId === jobId ? snapshot : j)));
          })
          .catch(() => {});
      }
    }, 2500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeJobKey]);

  const attachJobStream = (jobId: string) => {
    if (!mountedRef.current || eventSourcesRef.current.has(jobId)) return;

    const es = new EventSource(`/api/jobs/${jobId}/events`);
    eventSourcesRef.current.set(jobId, es);

    es.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const updated = JSON.parse(event.data) as DownloadJob;
        setJobs((prev) => prev.map((j) => (j.jobId === jobId ? updated : j)));

        if (
          updated.status === 'ready' ||
          updated.status === 'error' ||
          updated.status === 'cancelled'
        ) {
          es.close();
          eventSourcesRef.current.delete(jobId);
        }
      } catch {
        // Ignore malformed frame
      }
    };

    es.onerror = () => {
      es.close();
      eventSourcesRef.current.delete(jobId);
      fetch(`/api/jobs/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((snapshot: DownloadJob | null) => {
          if (!mountedRef.current || !snapshot) return;
          setJobs((prev) => prev.map((j) => (j.jobId === jobId ? snapshot : j)));
          if (
            snapshot.status !== 'ready' &&
            snapshot.status !== 'error' &&
            snapshot.status !== 'cancelled'
          ) {
            const timerId = window.setTimeout(() => {
              retryTimersRef.current.delete(jobId);
              attachJobStream(jobId);
            }, 1000);
            retryTimersRef.current.set(jobId, timerId);
          }
        })
        .catch(() => {});
    };
  };

  const handleAnalyze = async (overrideUrl?: string) => {
    const targetUrl = (overrideUrl ?? url).trim();
    if (!targetUrl) {
      setAnalyzeError('Please enter or paste a video URL to analyze.');
      return;
    }

    analyzeAbortRef.current?.abort();
    const controller = new AbortController();
    analyzeAbortRef.current = controller;

    setIsAnalyzing(true);
    setAnalyzeError(null);
    setJobError(null);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
        signal: controller.signal,
      });
      const data = await response.json();

      if (controller.signal.aborted || !mountedRef.current) return;

      if (!response.ok) {
        setAnalyzedMedia(null);
        setAnalyzeError(data.error || 'Could not analyze the provided URL.');
        return;
      }

      setAnalyzedMedia(data as AnalyzedMedia);
      window.requestAnimationFrame(() => {
        scrollIntoViewSmooth(workbenchWrapRef.current);
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) {
        setAnalyzeError('Network error while contacting the extraction backend.');
      }
    } finally {
      if (analyzeAbortRef.current === controller) {
        analyzeAbortRef.current = null;
        if (mountedRef.current) {
          setIsAnalyzing(false);
        }
      }
    }
  };

  const handleStartDownload = async (payload: {
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
  }) => {
    setIsSubmittingJob(true);
    setJobError(null);

    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (!response.ok) {
        setJobError(data.error || 'Unable to queue download job.');
        return;
      }

      const newJob = data as DownloadJob;
      setJobs((prev) => [newJob, ...prev]);
      attachJobStream(newJob.jobId);
      window.requestAnimationFrame(() => {
        scrollIntoViewSmooth(downloadsWrapRef.current);
      });
    } catch {
      setJobError('Failed to communicate with the download engine.');
    } finally {
      setIsSubmittingJob(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch {
      // Ignore network race
    }
  };

  const cleanupJobListeners = (jobId: string) => {
    const timerId = retryTimersRef.current.get(jobId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      retryTimersRef.current.delete(jobId);
    }
    const es = eventSourcesRef.current.get(jobId);
    if (es) {
      es.close();
      eventSourcesRef.current.delete(jobId);
    }
  };

  const handleDismissJob = (jobId: string) => {
    cleanupJobListeners(jobId);
    setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
  };

  const handleClearFinished = () => {
    setJobs((prev) => {
      const kept: DownloadJob[] = [];
      for (const job of prev) {
        if (job.status === 'ready' || job.status === 'error' || job.status === 'cancelled') {
          cleanupJobListeners(job.jobId);
        } else {
          kept.push(job);
        }
      }
      return kept;
    });
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header
        theme={theme}
        onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
      />

      <main className="mx-auto max-w-6xl space-y-6 px-3.5 py-5 sm:px-6 sm:py-10">
        <UrlAnalyzerForm
          url={url}
          isAnalyzing={isAnalyzing}
          error={analyzeError}
          onChangeUrl={setUrl}
          onClearError={() => setAnalyzeError(null)}
          onAnalyze={(targetUrl) => void handleAnalyze(targetUrl)}
        />

        <div ref={downloadsWrapRef}>
          <DownloadManager
            jobs={jobs}
            onCancelJob={handleCancelJob}
            onDismissJob={handleDismissJob}
            onClearFinished={handleClearFinished}
          />
        </div>

        <div ref={workbenchWrapRef}>
          {isAnalyzing && !analyzedMedia && <MediaWorkbenchSkeleton />}
          {analyzedMedia && (
            <MediaWorkbench
              media={analyzedMedia}
              isSubmitting={isSubmittingJob}
              jobError={jobError}
              onStartDownload={handleStartDownload}
            />
          )}
        </div>

        <TechnicalSections />
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 py-6 text-center text-xs text-slate-500 dark:text-slate-400 px-4">
        ClipFetch — Only download publicly accessible media you have rights or permission to save.
      </footer>
    </div>
  );
}
