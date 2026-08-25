import http from 'http';
import HealthServer from '../../src/services/health-server.js';

const request = port => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}/health`, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
  }).on('error', reject);
});

describe('HealthServer', () => {
  test('serves a successful liveness response', async () => {
    const server = new HealthServer({ host: '127.0.0.1', port: 0 });
    await server.start();
    const port = server.server.address().port;

    try {
      await expect(request(port)).resolves.toMatchObject({ status: 200, body: { status: 'ok' } });
    } finally {
      await server.stop();
    }
  });

  test('keeps readiness closed until startup completes', () => {
    const server = new HealthServer();
    expect(server.response('/ready').status).toBe(503);
    server.setReady(true);
    expect(server.response('/ready').status).toBe(200);
  });
});
