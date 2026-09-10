import crypto from 'node:crypto';
import http from 'node:http';
import { KeyStore } from './keys.js';

export interface SettingsConfig {
  adminPassword: string | null;
  publicRelayUrl: string;
  publicTcpHost: string | null;
  publicTcpPort: string | null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkAdminAuth(req: http.IncomingMessage, config: SettingsConfig): boolean {
  if (!config.adminPassword) return false;
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeStringEqual(password, config.adminPassword);
}

function requireAuth(res: http.ServerResponse): void {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="pip-proxy settings", charset="UTF-8"',
    'Content-Type': 'text/plain',
  });
  res.end('Unauthorized');
}

/** The connection details an engine needs, for one freshly-created key. */
export function connectionDetails(config: SettingsConfig, keyId: string, secret: string) {
  const host = config.publicTcpHost;
  const port = config.publicTcpPort;
  const proxyUrl = host && port ? `http://${keyId}:${secret}@${host}:${port}` : null;
  return {
    keyId,
    secret,
    relayUrl: config.publicRelayUrl,
    proxyUrl,
    proxyConfigured: proxyUrl !== null,
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Handles every /settings route. Returns true when the request was consumed,
 * so the caller can fall through to the relay routes otherwise.
 */
export async function handleSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: KeyStore,
  config: SettingsConfig,
): Promise<boolean> {
  const url = req.url || '';
  if (url !== '/settings' && !url.startsWith('/settings/')) return false;

  if (!config.adminPassword) {
    json(res, 503, { error: 'ADMIN_PASSWORD is not set — settings are disabled.' });
    return true;
  }

  if (!checkAdminAuth(req, config)) {
    requireAuth(res);
    return true;
  }

  if (req.method === 'GET' && url === '/settings') {
    const html = renderSettingsPage(config);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  if (req.method === 'GET' && url === '/settings/api/keys') {
    json(res, 200, {
      persistent: store.persistent,
      proxyConfigured: Boolean(config.publicTcpHost && config.publicTcpPort),
      relayUrl: config.publicRelayUrl,
      keys: store.list().map((k) => ({
        id: k.id,
        name: k.name,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
      })),
    });
    return true;
  }

  if (req.method === 'POST' && url === '/settings/api/keys') {
    const body = await readJsonBody(req);
    const name = typeof body.name === 'string' ? body.name : '';
    const { key, secret } = store.create(name);
    json(res, 201, connectionDetails(config, key.id, secret));
    return true;
  }

  const revokeMatch = url.match(/^\/settings\/api\/keys\/([\w-]+)\/revoke$/);
  if (req.method === 'POST' && revokeMatch) {
    const ok = store.revoke(revokeMatch[1]);
    json(res, ok ? 200 : 404, { revoked: ok });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}

function renderSettingsPage(config: SettingsConfig): string {
  const tcpHint = config.publicTcpHost && config.publicTcpPort
    ? `${config.publicTcpHost}:${config.publicTcpPort}`
    : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pip-proxy settings</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #fff; --border: #e4e4e2; --text: #1a1a19;
    --muted: #6b6b68; --accent: #2f6f4e; --danger: #a33; --code-bg: #f4f4f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --panel: #1e1e23; --border: #32323a; --text: #ececf0;
      --muted: #9a9aa5; --accent: #6cc79a; --danger: #e5534b; --code-bg: #26262c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem; background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 780px; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
  p.sub { margin: 0 0 2rem; color: var(--muted); }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 1.25rem; margin-bottom: 1.25rem;
  }
  label { display: block; font-weight: 600; font-size: .82rem; margin-bottom: .4rem; }
  input[type=text] {
    width: 100%; padding: .55rem .7rem; border: 1px solid var(--border);
    border-radius: 7px; background: var(--bg); color: var(--text); font: inherit;
  }
  button {
    padding: .55rem 1rem; border-radius: 7px; border: 1px solid transparent;
    background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.ghost { background: transparent; border-color: var(--border); color: var(--muted); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row { display: flex; gap: .6rem; align-items: flex-end; }
  .row > div { flex: 1; }
  table { width: 100%; border-collapse: collapse; font-size: .87rem; }
  th, td { text-align: left; padding: .55rem .4rem; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-size: .74rem; text-transform: uppercase; letter-spacing: .05em; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .field { margin-bottom: .9rem; }
  .copyline { display: flex; gap: .5rem; align-items: center; }
  .copyline code {
    flex: 1; background: var(--code-bg); padding: .5rem .6rem; border-radius: 6px;
    overflow-x: auto; white-space: nowrap; border: 1px solid var(--border);
  }
  .warn {
    border-left: 3px solid #d29922; padding: .6rem .85rem; background: var(--code-bg);
    border-radius: 0 6px 6px 0; font-size: .87rem; margin-bottom: 1rem;
  }
  .revoked { opacity: .45; text-decoration: line-through; }
  .empty { color: var(--muted); font-size: .88rem; padding: .8rem .4rem; }
</style>
</head>
<body>
<main>
  <h1>pip-proxy access</h1>
  <p class="sub">Generate a key, then paste the link and secret into the engine.</p>

  ${tcpHint ? '' : `<div class="warn"><strong>TCP proxy not configured.</strong> Set <code>PUBLIC_TCP_HOST</code> and <code>PUBLIC_TCP_PORT</code> after enabling Railway's TCP Proxy, or generated keys will not include a <code>yt-dlp</code> proxy URL.</div>`}
  <div id="storage-warn"></div>

  <div class="panel">
    <form id="create-form" class="row">
      <div>
        <label for="name">New access name</label>
        <input type="text" id="name" placeholder="core-engine (production)" required>
      </div>
      <button type="submit">Create access</button>
    </form>
    <div id="created"></div>
  </div>

  <div class="panel">
    <table>
      <thead><tr><th>Key</th><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
      <tbody id="keys"></tbody>
    </table>
    <div id="empty" class="empty" hidden>No access keys yet.</div>
  </div>
</main>

<script>
const fmt = (iso) => iso ? new Date(iso).toLocaleString() : '—';

function copyButton(value) {
  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(value);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  });
  return btn;
}

function copyLine(labelText, value) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  const line = document.createElement('div');
  line.className = 'copyline';
  const code = document.createElement('code');
  code.textContent = value;
  line.append(code, copyButton(value));
  wrap.append(label, line);
  return wrap;
}

async function load() {
  const res = await fetch('/settings/api/keys');
  const data = await res.json();

  const warn = document.getElementById('storage-warn');
  warn.innerHTML = data.persistent ? '' :
    '<div class="warn"><strong>Storage is memory-only.</strong> Attach a Railway volume at <code>DATA_DIR</code> or keys are lost on every redeploy.</div>';

  const tbody = document.getElementById('keys');
  tbody.textContent = '';
  document.getElementById('empty').hidden = data.keys.length > 0;

  for (const key of data.keys) {
    const tr = document.createElement('tr');
    if (key.revokedAt) tr.className = 'revoked';

    const id = document.createElement('td');
    id.innerHTML = '<span class="mono">' + key.id + '</span>';
    const name = document.createElement('td');
    name.textContent = key.name;
    const created = document.createElement('td');
    created.textContent = fmt(key.createdAt);
    const used = document.createElement('td');
    used.textContent = fmt(key.lastUsedAt);
    const action = document.createElement('td');

    if (!key.revokedAt) {
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Revoke';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await fetch('/settings/api/keys/' + key.id + '/revoke', { method: 'POST' });
        load();
      });
      action.append(btn);
    }

    tr.append(id, name, created, used, action);
    tbody.append(tr);
  }
}

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('name');
  const res = await fetch('/settings/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.value }),
  });
  const data = await res.json();

  const box = document.getElementById('created');
  box.textContent = '';

  const warn = document.createElement('div');
  warn.className = 'warn';
  warn.innerHTML = '<strong>Copy the secret now.</strong> It is stored hashed and cannot be shown again.';
  box.append(warn);

  box.append(copyLine('Relay link (status + /relay)', data.relayUrl));
  box.append(copyLine('Secret', data.secret));
  if (data.proxyUrl) {
    box.append(copyLine('yt-dlp proxy URL (for the engine)', data.proxyUrl));
  }

  input.value = '';
  load();
});

load();
</script>
</body>
</html>`;
}
