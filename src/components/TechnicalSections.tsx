const COMPATIBILITY_ROWS = [
  {
    source: 'Direct Video Links (.mp4, .webm, .mov, .m3u8)',
    status: 'Full Support',
    notes: 'Fast direct fetch or stream extraction with trimming and 0.5x–3x playback speed.',
  },
  {
    source: 'Wikimedia Commons / Internet Archive / Vimeo',
    status: 'Full Support',
    notes: 'Public streams and metadata extract cleanly on both cloud and local deployments.',
  },
  {
    source: 'Facebook / Instagram / TikTok / X',
    status: 'Public Only',
    notes: 'Public posts work when not behind login walls or temporary CDN rate limits.',
  },
  {
    source: 'YouTube',
    status: 'Cookies Required',
    notes: 'Works through yt-dlp. Cloud servers usually need fresh YouTube cookies (Render Secret File: cookies.txt).',
  },
  {
    source: 'Private, Paywalled, or DRM Media',
    status: 'Unsupported',
    notes: 'Blocked intentionally. ClipFetch never bypasses DRM, logins, or access controls.',
  },
];

const HOSTING_PROVIDERS = [
  {
    provider: 'Render (Free Web Service)',
    specs: '512 MB RAM · 0.1 CPU · Ephemeral Disk',
    verdict: 'Small clips only (<150 MB)',
    notes: 'Sleeps after 15m idle; 1080p FFmpeg speed re-encoding can hit the 512 MB RAM ceiling.',
  },
  {
    provider: 'Hugging Face Spaces (Docker Free)',
    specs: '16 GB RAM · 2 vCPU · 50 GB Ephemeral',
    verdict: 'Recommended Free Cloud',
    notes: 'Generous RAM for FFmpeg 1080p/4K merging & speed re-encoding; supports custom Dockerfiles.',
  },
  {
    provider: 'Oracle Cloud Always Free VM',
    specs: 'Up to 24 GB RAM · 4 ARM OCPU',
    verdict: 'Best Production Free Tier',
    notes: 'No sleep timeout, persistent storage, full control for FFmpeg and stream tools.',
  },
  {
    provider: 'Vercel / Netlify / Cloudflare Pages',
    specs: 'Serverless (10–60s timeout, no FFmpeg)',
    verdict: 'Not Suitable for Backend',
    notes: 'Cannot host long downloads or FFmpeg pipelines; usable only for static frontend hosting.',
  },
  {
    provider: 'Android Termux (Self-Hosted)',
    specs: 'Device CPU & Storage · Home IP',
    verdict: 'Best Mobile Reliability',
    notes: 'Runs locally on your phone with zero cloud IP restrictions and saves straight to storage.',
  },
];

export function TechnicalSections() {
  return (
    <div className="space-y-6">
      {/* Compatibility Matrix */}
      <section
        id="compatibility"
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6"
      >
        <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
          Supported Platforms
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Real extraction capabilities and current availability across media sources.
        </p>

        {/* Mobile stacked list (fits 360px / 720x1520 cleanly without horizontal scroll) */}
        <div className="mt-4 divide-y divide-slate-200 dark:divide-slate-800 md:hidden">
          {COMPATIBILITY_ROWS.map((row) => (
            <div key={row.source} className="py-3.5 first:pt-1 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
                  {row.source}
                </span>
                <span
                  className={`text-xs font-semibold whitespace-nowrap shrink-0 ${
                    row.status === 'Currently Unavailable'
                      ? 'text-amber-700 dark:text-amber-400'
                      : row.status === 'Unsupported'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {row.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                {row.notes}
              </p>
            </div>
          ))}
        </div>

        {/* Desktop table */}
        <div className="mt-4 hidden md:block overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
                <th className="py-3 pr-4">Source Type</th>
                <th className="py-3 pr-4">Availability</th>
                <th className="py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {COMPATIBILITY_ROWS.map((row) => (
                <tr key={row.source}>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-slate-100">
                    {row.source}
                  </td>
                  <td
                    className={`py-3 pr-4 font-semibold whitespace-nowrap ${
                      row.status === 'Currently Unavailable'
                        ? 'text-amber-700 dark:text-amber-400'
                        : row.status === 'Unsupported'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {row.status}
                  </td>
                  <td className="py-3 text-slate-600 dark:text-slate-400">{row.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Free Hosting Analysis */}
      <section
        id="hosting"
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6"
      >
        <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
          Hosting & Resource Limits
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Video stream merging and FFmpeg speed conversion require memory, temporary disk space, and stable HTTP streams.
        </p>

        {/* Mobile stacked list */}
        <div className="mt-4 divide-y divide-slate-200 dark:divide-slate-800 md:hidden">
          {HOSTING_PROVIDERS.map((item) => (
            <div key={item.provider} className="py-3.5 first:pt-1 last:pb-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {item.provider}
                </span>
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 shrink-0">
                  {item.verdict}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {item.specs}
              </p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                {item.notes}
              </p>
            </div>
          ))}
        </div>

        {/* Desktop table */}
        <div className="mt-4 hidden md:block overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
                <th className="py-3 pr-4">Platform</th>
                <th className="py-3 pr-4">Resources</th>
                <th className="py-3 pr-4">Suitability</th>
                <th className="py-3">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {HOSTING_PROVIDERS.map((item) => (
                <tr key={item.provider}>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-slate-100">
                    {item.provider}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-slate-600 dark:text-slate-400 tabular-nums">
                    {item.specs}
                  </td>
                  <td className="py-3 pr-4 font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">
                    {item.verdict}
                  </td>
                  <td className="py-3 text-slate-600 dark:text-slate-400">{item.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Architecture Overview */}
      <section
        id="architecture"
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6"
      >
        <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
          How ClipFetch Works
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-3 text-sm text-slate-600 dark:text-slate-400">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">Safe URL Verification</h3>
            <p className="mt-1.5 leading-relaxed">
              Every pasted link is validated and DNS-checked to block private networks before fetching. Temporary job files live in isolated folders cleaned automatically after completion.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">Frame-Accurate FFmpeg</h3>
            <p className="mt-1.5 leading-relaxed">
              Standard downloads preserve original quality cleanly, while trims and 0.5x–3x playback speed adjustments synchronize video frames and audio pitch automatically.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">Live Progress Streaming</h3>
            <p className="mt-1.5 leading-relaxed">
              Real-time server events report download bytes, speed, ETA, and FFmpeg progress straight to your browser with instant cancellation and automatic cleanup.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
