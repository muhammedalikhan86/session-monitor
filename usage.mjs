// Usage stats for the Sessions page.
//  1. Token counts: added up from the transcripts in ~/.claude/projects (this PC only).
//  2. Plan limits: the same numbers `/usage` shows, fetched from Anthropic with the
//     login token Claude Code keeps in ~/.claude/.credentials.json. That address is
//     undocumented and may change. We only ever READ the token: refreshing it ourselves
//     would rotate the refresh token and could log Claude Code out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE = path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE, 'projects');
const WINDOW_MS = 8 * 86400_000; // keep a little over a week of records
const RESCAN_MS = 30_000;

// ---- 1. Token counts -------------------------------------------------------
const offsets = new Map(); // file -> bytes already read
const seen = new Set();    // message ids already counted (one reply is logged as several lines)
let records = [];          // { ts, sessionId, model, input, output, cacheRead, cacheWrite }
let scanning = null;
let ready = false;
let lastScan = 0;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function take(line, cutoff) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  const m = j.message;
  const u = m?.usage;
  if (j.type !== 'assistant' || !u || m.model === '<synthetic>') return;
  const ts = Date.parse(j.timestamp);
  if (!(ts >= cutoff)) return;
  const key = `${m.id}:${j.requestId ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  records.push({
    ts,
    sessionId: j.sessionId,
    model: m.model ?? '?',
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  });
}

// Read the new bytes of one file, line by line, without loading it all at once.
function readNew(file, cutoff) {
  return new Promise((resolve) => {
    let size, mtime;
    try { ({ size, mtimeMs: mtime } = fs.statSync(file)); } catch { return resolve(); }
    let start = offsets.get(file) ?? 0;
    if (size < start) start = 0; // file was replaced
    if (mtime < cutoff || size === start) { offsets.set(file, size); return resolve(); }
    let carry = '';
    let pos = start;
    const stream = fs.createReadStream(file, { start, end: size - 1, encoding: 'utf8' });
    stream.on('data', (chunk) => {
      const text = carry + chunk;
      const lines = text.split('\n');
      carry = lines.pop();
      for (const l of lines) { take(l, cutoff); pos += Buffer.byteLength(l, 'utf8') + 1; }
    });
    // Anything after the last newline is a half-written line; read it next time.
    const done = () => { offsets.set(file, pos); resolve(); };
    stream.on('end', done);
    stream.on('error', done);
  });
}

async function scan() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const file of walk(PROJECTS)) {
    await readNew(file, cutoff);
    await new Promise((r) => setImmediate(r)); // let the web server answer between files
  }
  records = records.filter((r) => r.ts >= cutoff);
  ready = true;
  lastScan = Date.now();
}

function refresh() {
  if (!scanning && Date.now() - lastScan > RESCAN_MS) {
    scanning = scan().catch((e) => console.error('usage scan failed:', e)).finally(() => { scanning = null; });
  }
}

const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
function add(t, r) {
  t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite; t.messages++;
}

export function tokenStats() {
  refresh();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const weekAgo = Date.now() - 7 * 86400_000;
  const today = empty(), week = empty(), bySession = {}, byModel = {};
  for (const r of records) {
    if (r.ts >= weekAgo) {
      add(week, r);
      add((byModel[r.model] ??= empty()), r);
    }
    if (r.ts >= midnight.getTime()) add(today, r);
    add((bySession[r.sessionId] ??= empty()), r);
  }
  return { ready, today, week, byModel, bySession };
}

refresh(); // start the first (slow) scan as soon as the server loads

// ---- 2. Plan limits --------------------------------------------------------
const PLAN_TTL_MS = 60_000;
let plan = null, planAt = 0, planPending = null;

async function fetchPlan() {
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(path.join(CLAUDE, '.credentials.json'), 'utf8')).claudeAiOauth;
  } catch {
    return { error: 'No Claude login found on this PC.' };
  }
  if (!creds?.accessToken) return { error: 'No Claude login found on this PC.' };
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    return { error: 'Login token has expired. Use Claude Code once and it will renew it.' };
  }
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { error: `Anthropic said ${res.status}. Plan limits unavailable right now.` };
  const body = await res.json();
  return {
    plan: creds.subscriptionType ?? null,
    limits: (body.limits ?? []).map((l) => ({
      kind: l.kind, group: l.group, percent: l.percent, severity: l.severity, resetsAt: l.resets_at, scope: l.scope,
    })),
    extraUsage: body.extra_usage?.is_enabled ? body.extra_usage : null,
  };
}

export async function planLimits() {
  if (plan && Date.now() - planAt < PLAN_TTL_MS) return plan;
  planPending ??= fetchPlan()
    .catch((e) => ({ error: `Could not reach Anthropic: ${e.message}` }))
    .then((p) => { plan = { ...p, fetchedAt: Date.now() }; planAt = Date.now(); return plan; })
    .finally(() => { planPending = null; });
  return planPending;
}
