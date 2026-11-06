import { useEffect, useState } from 'react';

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number };

type Limit = {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  scope: { model?: { display_name?: string | null } | null } | null;
};

type UsageData = {
  tokens: { ready: boolean; today: Tokens; week: Tokens; byModel: Record<string, Tokens> };
  plan: { error?: string; plan?: string | null; limits?: Limit[]; fetchedAt: number };
};

const REFRESH_MS = 60_000;

export function fmt(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function limitName(l: Limit) {
  if (l.kind === 'session') return '5-hour limit';
  if (l.kind === 'weekly_all') return 'Weekly, all models';
  const model = l.scope?.model?.display_name;
  return model ? `Weekly, ${model}` : l.kind.replace(/_/g, ' ');
}

function resets(iso: string | null) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'resetting now';
  const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000);
  const when = h >= 24 ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
  return when ? `resets ${when}` : `resets in ${h ? `${h}h ` : ''}${m}m`;
}

function TokenCard({ title, t }: { title: string; t: Tokens }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="big">{fmt(t.output)} <span className="muted">output</span></div>
      <div className="muted">
        {fmt(t.input)} input · {fmt(t.cacheRead)} cache read · {fmt(t.cacheWrite)} cache write
      </div>
      <div className="muted">{t.messages.toLocaleString()} replies</div>
    </div>
  );
}

export default function Usage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch('/api/usage');
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        setData(body);
        setError('');
        // The first token scan takes a few seconds; check back quickly until it's done.
        timer = setTimeout(load, body.tokens.ready ? REFRESH_MS : 3000);
      } catch (e) {
        setError(`Usage unavailable: ${(e as Error).message}`);
        timer = setTimeout(load, REFRESH_MS);
      }
    };
    load();
    return () => clearTimeout(timer);
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  const { plan, tokens } = data;

  return (
    <section className="usage">
      <div className="card limits">
        <div className="card-title">
          Plan limits{plan.plan ? ` (${plan.plan})` : ''}
          <span className="muted"> · as of {new Date(plan.fetchedAt).toLocaleTimeString()}</span>
        </div>
        {plan.error && <p className="muted">{plan.error}</p>}
        {plan.limits?.map((l) => (
          <div key={limitName(l)} className="limit">
            <div className="limit-head">
              <span>{limitName(l)}</span>
              <span><strong>{l.percent}%</strong> <span className="muted">{resets(l.resetsAt)}</span></span>
            </div>
            <div className="bar">
              <div className={`fill ${l.percent >= 90 ? 'high' : l.percent >= 70 ? 'mid' : ''}`} style={{ width: `${Math.min(100, l.percent)}%` }} />
            </div>
          </div>
        ))}
      </div>
      {tokens.ready ? (
        <>
          <TokenCard title="Tokens today (this PC)" t={tokens.today} />
          <TokenCard title="Tokens last 7 days (this PC)" t={tokens.week} />
        </>
      ) : (
        <div className="card"><div className="card-title">Tokens</div><p className="muted">Reading history files…</p></div>
      )}
    </section>
  );
}
