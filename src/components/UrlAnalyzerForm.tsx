import { useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ClipboardPaste, Loader2, Search, X } from 'lucide-react';

interface UrlAnalyzerFormProps {
  url: string;
  isAnalyzing: boolean;
  error: string | null;
  onChangeUrl: (next: string) => void;
  onClearError: () => void;
  onAnalyze: (targetUrl?: string) => void;
}

const SAMPLE_URLS = [
  {
    label: 'MDN Flower (MP4, 5s)',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  },
  {
    label: 'Big Buck Bunny (WebM, 360p)',
    url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm',
  },
];

export function UrlAnalyzerForm({
  url,
  isAnalyzing,
  error,
  onChangeUrl,
  onClearError,
  onAnalyze,
}: UrlAnalyzerFormProps) {
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setClipboardNotice(null);
    onAnalyze();
  };

  const handlePaste = async () => {
    setClipboardNotice(null);
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      inputRef.current?.focus();
      setClipboardNotice('Clipboard shortcut unavailable here. Long-press the URL box and tap Paste.');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        onChangeUrl(text.trim());
        onClearError();
      } else {
        setClipboardNotice('Clipboard is empty.');
      }
    } catch {
      inputRef.current?.focus();
      setClipboardNotice('Clipboard access blocked. Long-press inside the URL box to paste.');
    }
  };

  return (
    <section
      id="downloader"
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-8"
    >
      <div className="max-w-3xl">
        <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
          Download, trim, and convert public online videos
        </h1>
        <p className="mt-2.5 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
          Paste a public video page or direct media link to inspect resolutions, trim clips,
          adjust speed, and save straight to your device.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-5 sm:mt-6">
        <div className="flex flex-col lg:flex-row lg:items-stretch">
          <div className="flex flex-1 min-w-0 items-center rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-3.5 pr-1.5 focus-within:border-blue-600 focus-within:bg-white dark:focus-within:bg-slate-950 focus-within:ring-2 focus-within:ring-blue-600/15 transition-colors mb-3 lg:mb-0 lg:mr-3">
            <input
              ref={inputRef}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => {
                onChangeUrl(e.target.value);
                if (error) onClearError();
              }}
              placeholder="Paste public video URL or direct .mp4 link"
              aria-label="Video URL"
              className="w-full min-w-0 min-h-[50px] bg-transparent py-2.5 pr-2 text-base sm:text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none"
            />

            {url.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onChangeUrl('');
                  onClearError();
                  setClipboardNotice(null);
                  inputRef.current?.focus();
                }}
                aria-label="Clear URL"
                className="mr-1 inline-flex min-h-[42px] min-w-[42px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            )}

            <button
              type="button"
              onClick={handlePaste}
              className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
            >
              <ClipboardPaste className="mr-1.5 h-3.5 w-3.5 shrink-0" />
              <span>Paste</span>
            </button>
          </div>

          <button
            type="submit"
            disabled={isAnalyzing}
            className="inline-flex min-h-[52px] w-full lg:w-auto items-center justify-center rounded-xl bg-blue-600 px-6 py-3 text-sm sm:text-base font-semibold text-white hover:bg-blue-700 active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed transition-all whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            {isAnalyzing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin shrink-0" />
                <span>Analyzing...</span>
              </>
            ) : (
              <>
                <Search className="mr-2 h-4 w-4 shrink-0" />
                <span>Analyze URL</span>
              </>
            )}
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-center text-xs text-slate-500 dark:text-slate-400">
        <span className="mr-3 py-1">Try sample links:</span>
        {SAMPLE_URLS.map((sample) => (
          <button
            key={sample.url}
            type="button"
            disabled={isAnalyzing}
            onClick={() => {
              setClipboardNotice(null);
              onChangeUrl(sample.url);
              onAnalyze(sample.url);
            }}
            className="mr-4 min-h-[40px] py-1 font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50 text-left whitespace-nowrap"
          >
            {sample.label}
          </button>
        ))}
      </div>

      {clipboardNotice && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" role="status">
          {clipboardNotice}
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-800 dark:text-red-200"
        >
          <div className="flex items-start min-w-0">
            <AlertCircle className="mr-2.5 mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
            <span className="leading-snug break-words">{error}</span>
          </div>

          <button
            type="button"
            onClick={() => {
              onChangeUrl('');
              onClearError();
              inputRef.current?.focus();
            }}
            className="mt-2.5 sm:mt-0 sm:ml-4 self-start sm:self-auto min-h-[36px] rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-red-950/60 px-3 py-1.5 text-xs font-semibold text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/60 transition-colors whitespace-nowrap shrink-0"
          >
            Clear Link
          </button>
        </div>
      )}
    </section>
  );
}
