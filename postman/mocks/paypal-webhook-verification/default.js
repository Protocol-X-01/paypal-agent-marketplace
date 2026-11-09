/* eslint-disable @typescript-eslint/no-require-imports -- Local Postman fixture. */
// This local-only stand-in models only the OAuth and webhook verification
// requests needed by the regression. It never performs signature checks.
const http = require('node:http');

const calls = { token: 0, verification: [] };
const client = 'fixture-client';
const credential = 'fixture-credential';
const token = 'fixture-token';
const expectedBasic = `Basic ${Buffer.from(`${client}:${credential}`).toString('base64')}`;
const expectedHeaders = {
  transmission_id: 'fixture-delivery',
  transmission_time: '2026-11-06T00:00:00Z',
  cert_url: 'https://api-m.sandbox.paypal.com/v1/notifications/certs/TEST-CERT',
  auth_algo: 'SHA256withRSA',
  transmission_sig: 'fixture-signature',
  webhook_id: 'FIXTUREWEBHOOK',
};

function expectedEvent(id) {
  return String.raw`{ "id": "${id}", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource_type": "capture", "resource": { "status": "COMPLETED", "custom_id": "\u0061" } }`;
}

const server = http.createServer((req, res) => {
  const reply = (status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/_fixture/stats') return reply(200, calls);
  if (req.method !== 'POST' || !['/v1/oauth2/token', '/v1/notifications/verify-webhook-signature'].includes(req.url)) {
    return reply(501, { error: 'Synthetic endpoint not modeled.' });
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/v1/oauth2/token') {
      calls.token += 1;
      if (req.headers.authorization !== expectedBasic || raw !== 'grant_type=client_credentials') {
        return reply(401, { error: 'Synthetic OAuth request was invalid.' });
      }
      return reply(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }

    let request;
    try { request = JSON.parse(raw); }
    catch { return reply(400, { error: 'Synthetic verification body was invalid.' }); }
    const id = request.webhook_event?.id;
    calls.verification.push(typeof id === 'string' ? id : 'missing');
    const marker = ',"webhook_event":';
    const markerAt = raw.indexOf(marker);
    const eventRaw = markerAt < 0 ? '' : raw.slice(markerAt + marker.length, -1);
    if (req.headers.authorization !== `Bearer ${token}` ||
        Object.entries(expectedHeaders).some(([key, value]) => request[key] !== value) ||
        typeof id !== 'string' || eventRaw !== expectedEvent(id)) {
      return reply(422, { error: 'Synthetic verification request did not preserve the expected event or headers.' });
    }
    if (id === 'synthetic-success') return reply(200, { verification_status: 'SUCCESS' });
    if (id === 'synthetic-rejected') return reply(200, { verification_status: 'FAILURE' });
    if (id === 'synthetic-unavailable') return reply(503, { error: 'Synthetic provider unavailable.' });
    if (id === 'synthetic-slow') return setTimeout(() => reply(200, { verification_status: 'SUCCESS' }), 7_500);
    return reply(501, { error: 'Synthetic event not modeled.' });
  });
});

server.listen(process.env.PORT);
