// Claude Session Monitor - backend.
// Reads ~/.claude/sessions/<pid>.json (one per live Claude Code session),
// serves the React page from web/dist, and kills sessions on request.
// Listens on 127.0.0.1 only, so nothing else on the network can reach it.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tokenStats, planLimits } from './usage.mjs';

const run = promisify(execFile);
const PORT = Number(process.env.PORT) || 4817;
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web', 'dist');
const CLAUDE_IMAGES = new Set(['claude.exe', 'claude', 'node.exe', 'node']);

function machine() {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  return { host: os.hostname(), ips };
}

// PID -> { image, memKb } for every running process (Windows tasklist).
async function processTable() {
  const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 16 * 1024 * 1024 });
  const table = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
    if (!cols || cols.length < 5) continue;
    table.set(Number(cols[1]), { image: cols[0].toLowerCase(), memKb: Number(cols[4].replace(/[^\d]/g, '')) });
  }
  return table;
}

// --- Renaming -------------------------------------------------------------
// `/rename` in Claude Code appends {"type":"custom-title",...} to the session's
// transcript (~/.claude/projects/<folder>/<sessionId>.jsonl). VS Code's session
// list reads its titles from there, so we write the same line.
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const transcriptCache = new Map(); // sessionId -> { file, size, title }

function findTranscript(sessionId) {
  const hit = transcriptCache.get(sessionId);
  if (hit && fs.existsSync(hit.file)) return hit.file;
  // Folder names differ in drive-letter case (c-- vs C--), so look in all of them.
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    const file = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Latest custom title in the transcript. Only reads bytes added since last time.
function customTitle(sessionId) {
  if (!sessionId) return null;
  const file = findTranscript(sessionId);
  if (!file) return null;
  const size = fs.statSync(file).size;
  let entry = transcriptCache.get(sessionId);
  if (!entry || entry.file !== file || size < entry.size) entry = { file, size: 0, title: null };
  if (size > entry.size) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - entry.size);
    fs.readSync(fd, buf, 0, buf.length, entry.size);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n') + 1; // leave a half-written last line for next time
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.includes('"custom-title"')) continue;
      try { const j = JSON.parse(line); if (j.type === 'custom-title' && j.customTitle) entry.title = j.customTitle; } catch {}
    }
    entry.size += Buffer.byteLength(text.slice(0, end), 'utf8');
  }
  transcriptCache.set(sessionId, entry);
  return entry.title;
}

async function renameSession(pid, title) {
  title = String(title ?? '').trim();
  if (!title || title.length > 200 || /[\r\n]/.test(title)) throw new Error('Name must be 1-200 characters, one line');
  const live = (await listSessions()).find((s) => s.pid === pid);
  if (!live) throw new Error(`No active Claude session with PID ${pid}`);
  const file = live.sessionId && findTranscript(live.sessionId);
  // A brand-new session has no transcript until its first prompt. VS Code can't rename it either.
  if (!file) throw new Error('This session has no history yet. Send it one prompt first, then rename.');
  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: live.sessionId }) + '\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}

async function listSessions() {
  const procs = await processTable();
  const sessions = [];
  for (const file of fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')); } catch { continue; }
    const proc = procs.get(d.pid);
    // Skip leftover files from sessions that already ended (or whose PID was reused).
    if (!proc || !CLAUDE_IMAGES.has(proc.image)) continue;
    let title = null;
    try { title = customTitle(d.sessionId); } catch {}
    sessions.push({
      pid: d.pid,
      sessionId: d.sessionId ?? null,
      name: title ?? d.name ?? '?',
      autoName: d.name ?? '?',
      renamed: Boolean(title),
      status: d.status ?? '?',
      entrypoint: d.entrypoint ?? d.kind ?? '?',
      cwd: d.cwd ?? '',
      startedAt: d.startedAt ?? null,
      updatedAt: d.statusUpdatedAt ?? d.updatedAt ?? null,
      version: d.version ?? '',
      remoteControl: Boolean(d.bridgeSessionId),
      memMb: Math.round(proc.memKb / 1024),
      tokens: tokenStats().bySession[d.sessionId] ?? null,
    });
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name));
}

async function killSession(pid) {
  const live = (await listSessions()).find((s) => s.pid === pid);
  if (!live) throw new Error(`No active Claude session with PID ${pid}`);
  await run('taskkill', ['/PID', String(pid), '/T', '/F']); // /T = its child processes too
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return send(res, 200, { machine: machine(), sessions: await listSessions() });
    }
    if (req.method === 'GET' && url.pathname === '/api/usage') {
      const { ready, today, week, byModel } = tokenStats();
      return send(res, 200, { tokens: { ready, today, week, byModel }, plan: await planLimits() });
    }
    const kill = url.pathname.match(/^\/api\/sessions\/(\d+)\/kill$/);
    if (req.method === 'POST' && kill) {
      await killSession(Number(kill[1]));
      return send(res, 200, { ok: true });
    }
    const rename = url.pathname.match(/^\/api\/sessions\/(\d+)\/rename$/);
    if (req.method === 'POST' && rename) {
      // Only accept JSON posts, so another web page can't trigger this via a plain form.
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 415, { error: 'Expected application/json' });
      }
      const body = await readBody(req);
      await renameSession(Number(rename[1]), body.name);
      return send(res, 200, { ok: true });
    }
    // Static files for the React page.
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream');
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Session Monitor: http://localhost:${PORT}`);
});
