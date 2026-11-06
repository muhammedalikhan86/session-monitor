import { useCallback, useEffect, useState } from 'react';
import './App.css';
import Usage, { fmt, type Tokens } from './Usage';

type Session = {
  pid: number;
  sessionId: string | null;
  name: string;
  autoName: string;
  renamed: boolean;
  status: string;
  entrypoint: string;
  cwd: string;
  startedAt: number | null;
  updatedAt: number | null;
  version: string;
  remoteControl: boolean;
  memMb: number;
  tokens: Tokens | null;
};

type Data = { machine: { host: string; ips: string[] }; sessions: Session[] };

const REFRESH_MS = 3000;

function ago(ms: number | null) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [killing, setKilling] = useState<number | null>(null);
  const [updated, setUpdated] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setData(body);
      setError('');
      setUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setError(`Can't reach the monitor server: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  async function rename(s: Session) {
    const name = prompt(`New name for "${s.name}":`, s.name)?.trim();
    if (!name || name === s.name) return;
    try {
      const res = await fetch(`/api/sessions/${s.pid}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
    } catch (e) {
      alert(`Could not rename it: ${(e as Error).message}`);
    } finally {
      load();
    }
  }

  async function kill(s: Session) {
    if (!confirm(`Kill "${s.name}" (PID ${s.pid})?\n\nAnything unsaved in that session is lost.`)) return;
    setKilling(s.pid);
    try {
      const res = await fetch(`/api/sessions/${s.pid}/kill`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
    } catch (e) {
      alert(`Could not kill it: ${(e as Error).message}`);
    } finally {
      setKilling(null);
      load();
    }
  }

  return (
    <main>
      <header>
        <div>
          <h1>Claude Sessions</h1>
          {data && (
            <p className="machine">
              <strong>{data.machine.host}</strong>
              {data.machine.ips.map((ip) => (
                <span key={ip} className="ip">{ip}</span>
              ))}
            </p>
          )}
        </div>
        <div className="actions">
          <span className="muted">{updated && `Updated ${updated}`}</span>
          <button onClick={load}>Refresh</button>
        </div>
      </header>

      <Usage />

      {error && <p className="error">{error}</p>}

      {data && data.sessions.length === 0 && <p className="muted">No active sessions.</p>}

      {data && data.sessions.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="session-col">Session</th>
                <th>Status</th>
                <th>Started from</th>
                <th>Machine / IP</th>
                <th>PID</th>
                <th>Started</th>
                <th>Last activity</th>
                <th>Memory</th>
                <th title="Output tokens this session, last 8 days">Tokens</th>
                <th>Remote</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.pid}>
                  <td className="session-col">
                    <div className="name" title={s.renamed ? `${s.name} (auto name: ${s.autoName})` : s.name}>{s.name}</div>
                    <div className="cwd" title={s.cwd}><span dir="ltr">{s.cwd}</span></div>
                  </td>
                  <td><span className={`pill ${s.status}`}>{s.status}</span></td>
                  <td>{s.entrypoint}</td>
                  <td>
                    <div>{data.machine.host}</div>
                    <div className="muted">{data.machine.ips[0] ?? ''}</div>
                  </td>
                  <td className="mono">{s.pid}</td>
                  <td>{ago(s.startedAt)}</td>
                  <td>{ago(s.updatedAt)}</td>
                  <td>{s.memMb} MB</td>
                  <td title={s.tokens ? `${fmt(s.tokens.input)} input, ${fmt(s.tokens.cacheRead)} cache read, ${fmt(s.tokens.cacheWrite)} cache write, ${s.tokens.messages} replies` : undefined}>
                    {s.tokens ? `${fmt(s.tokens.output)} out` : '–'}
                  </td>
                  <td>{s.remoteControl ? 'on' : 'off'}</td>
                  <td className="row-actions">
                    <button onClick={() => rename(s)}>Rename</button>
                    <button className="danger" disabled={killing === s.pid} onClick={() => kill(s)}>
                      {killing === s.pid ? 'Killing…' : 'Kill'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
