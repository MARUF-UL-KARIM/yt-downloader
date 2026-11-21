import { AlertCircle, CheckCircle2, Download, Loader2, Trash2, XCircle } from 'lucide-react';
import type { DownloadJob } from '../types';
import { formatBytes } from '../utils/formatters';

interface DownloadManagerProps {
  jobs: DownloadJob[];
  onCancelJob: (jobId: string) => void;
  onDismissJob: (jobId: string) => void;
  onClearFinished: () => void;
}

export function DownloadManager({
  jobs,
  onCancelJob,
  onDismissJob,
  onClearFinished,
}: DownloadManagerProps) {
  if (jobs.length === 0) {
    return null;
  }

  const hasFinished = jobs.some(
    (j) => j.status === 'ready' || j.status === 'error' || j.status === 'cancelled'
  );

  return (
    <section
      id="downloads"
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6"
    >
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="flex items-baseline min-w-0">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white mr-2.5 whitespace-nowrap">
            Downloads
          </h2>
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
            {jobs.length} {jobs.length === 1 ? 'task' : 'tasks'}
          </span>
        </div>

        {hasFinished && (
          <button
            type="button"
            onClick={onClearFinished}
            className="min-h-[36px] rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            Clear finished
          </button>
        )}
      </div>

      <div className="divide-y divide-slate-200 dark:divide-slate-800">
        {jobs.map((job) => {
          const isActive =
            job.status === 'queued' ||
            job.status === 'downloading' ||
            job.status === 'merging' ||
            job.status === 'processing';
          const isReady = job.status === 'ready';
          const isError = job.status === 'error';
          const isCancelled = job.status === 'cancelled';
          const progressValue = job.progress ?? 0;

          return (
            <div key={job.jobId} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1 mb-3 sm:mb-0 sm:mr-4">
                  <div className="flex items-center">
                    {isActive && (
                      <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin text-blue-600" />
                    )}
                    {isReady && (
                      <CheckCircle2 className="mr-2 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                    {isError && (
                      <AlertCircle className="mr-2 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    )}
                    {isCancelled && (
                      <XCircle className="mr-2 h-4 w-4 shrink-0 text-slate-500" />
                    )}

                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                      {job.filename || job.phaseLabel}
                    </p>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span>{job.phaseLabel}</span>
                    {job.downloadedBytes > 0 && (
                      <>
                        <span className="mx-2" aria-hidden="true">·</span>
                        <span>
                          {formatBytes(job.downloadedBytes)}
                          {job.totalBytes && !isReady ? ` / ${formatBytes(job.totalBytes)}` : ''}
                        </span>
                      </>
                    )}
                    {job.speedText && (
                      <>
                        <span className="mx-2" aria-hidden="true">·</span>
                        <span>{job.speedText}</span>
                      </>
                    )}
                    {job.etaText && (
                      <>
                        <span className="mx-2" aria-hidden="true">·</span>
                        <span>ETA {job.etaText}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center shrink-0">
                  {isActive && (
                    <button
                      type="button"
                      onClick={() => onCancelJob(job.jobId)}
                      className="min-h-[44px] w-full sm:w-auto inline-flex items-center justify-center rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-2 text-xs font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors whitespace-nowrap"
                    >
                      <XCircle className="mr-1.5 h-4 w-4 shrink-0" />
                      <span>Cancel</span>
                    </button>
                  )}

                  {isReady && job.downloadUrl && (
                    <a
                      href={job.downloadUrl}
                      download={job.filename || 'video'}
                      className="min-h-[46px] flex-1 sm:flex-initial inline-flex items-center justify-center rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 active:scale-[0.99] transition-all whitespace-nowrap mr-2"
                    >
                      <Download className="mr-2 h-4 w-4 shrink-0" />
                      <span>Save ({formatBytes(job.fileSize)})</span>
                    </a>
                  )}

                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => onDismissJob(job.jobId)}
                      aria-label="Remove item from list"
                      className="min-h-[46px] min-w-[46px] inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors shrink-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {isActive && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mb-1.5">
                    <span>{job.status === 'processing' ? 'FFmpeg Processing' : 'Transfer Progress'}</span>
                    <span>{job.progress !== null ? `${progressValue}%` : 'Streaming...'}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-[width] duration-200"
                      style={{ width: `${job.progress !== null ? progressValue : 35}%` }}
                    />
                  </div>
                </div>
              )}

              {isError && job.error && (
                <div className="mt-2.5 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300 leading-relaxed">
                  {job.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
