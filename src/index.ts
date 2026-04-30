import http from 'node:http';

const PORT = parseInt(process.env.PORT || '3128', 10);

export function createProxyServer(): http.Server {
  const server = http.createServer((req, res) => {
    // Health check — not a proxy request
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Placeholder — will be filled in later tasks
    res.writeHead(400);
    res.end('Bad Request');
  });

  return server;
}

// Start server when run directly (not imported by tests)
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  const server = createProxyServer();
  server.listen(PORT, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `proxy listening on port ${PORT}` }));
  });
}
