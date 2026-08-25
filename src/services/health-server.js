import http from 'http';

export default class HealthServer {
  constructor({ host = '0.0.0.0', port = 3000 } = {}) {
    this.host = host;
    this.port = port;
    this.ready = false;
    this.startedAt = Date.now();
    this.server = null;
  }

  setReady(ready) {
    this.ready = Boolean(ready);
  }

  response(pathname) {
    if (pathname === '/health') {
      return { status: 200, body: { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) } };
    }
    if (pathname === '/ready') {
      return { status: this.ready ? 200 : 503, body: { status: this.ready ? 'ready' : 'starting' } };
    }
    return { status: 404, body: { status: 'not_found' } };
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      const result = this.response(new URL(request.url, 'http://localhost').pathname);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
