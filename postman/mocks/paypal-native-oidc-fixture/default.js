const http = require('node:http');
const crypto = require('node:crypto');

// Local-only, fictional OIDC server. It is not a PayPal-owned mock.
const issuer = 'https://www.sandbox.paypal.com';
const api = 'https://api.sandbox.paypal.com';
const client = 'fictional-client';
const callbacks = new Set([
  'https://app.example.test/api/auth/native/paypal/callback',
  'https://app.example.test/api/auth/paypal/callback',
]);
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fictional-key', alg: 'RS256', use: 'sig' };
let authorization = null;
const calls = { discovery: 0, token: 0, jwks: 0, userinfo: 0, prepare: 0, tokenRejections: [] };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  // Postman's local proxy may expose an already parsed request body.
  if (req.body !== undefined && req.body !== null) {
    const value = Buffer.isBuffer(req.body) ? req.body.toString('utf8')
      : typeof req.body === 'string' ? req.body
      : String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')
        ? new URLSearchParams(req.body).toString() : JSON.stringify(req.body);
    if (Buffer.byteLength(value, 'utf8') > 4096) throw new Error('fixture body too large');
    return value;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw new Error('fixture body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/_fixture/stats') return respond(res, 200, calls);
    if (req.method === 'POST' && path === '/_fixture/prepare') {
      const input = JSON.parse(await body(req));
      if (typeof input.nonce !== 'string' || !input.nonce || typeof input.challenge !== 'string' || !input.challenge || !callbacks.has(input.callback)) return respond(res, 400, { error: 'invalid fixture' });
      authorization = { nonce: input.nonce, challenge: input.challenge, callback: input.callback };
      calls.prepare += 1;
      return respond(res, 200, { ready: true });
    }
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      calls.discovery += 1;
      return respond(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/signin/authorize`,
        token_endpoint: `${api}/v1/oauth2/token`,
        userinfo_endpoint: `${api}/v1/oauth2/token/userinfo`,
        jwks_uri: `${api}/v1/oauth2/certs`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        subject_types_supported: ['pairwise'],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (req.method === 'GET' && path === '/v1/oauth2/certs') {
      calls.jwks += 1;
      return respond(res, 200, { keys: [jwk] });
    }
    if (req.method === 'POST' && path === '/v1/oauth2/token') {
      calls.token += 1;
      const params = new URLSearchParams(await body(req));
      const challenge = crypto.createHash('sha256').update(params.get('code_verifier') || '').digest('base64url');
      const checks = { prepared: Boolean(authorization), client: req.headers['x-fixture-client-auth'] === 'validated',
        grant: params.get('grant_type') === 'authorization_code', code: params.get('code') === 'fictional-code',
        redirect: params.get('redirect_uri') === authorization?.callback, challenge: challenge === authorization?.challenge };
      if (Object.values(checks).some((passed) => !passed)) {
        calls.tokenRejections.push(Object.keys(checks).filter((key) => !checks[key]));
        return respond(res, 400, { error: 'invalid_fixture_grant' });
      }
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, aud: client, sub: 'fictional-subject', iat: now - 1, exp: now + 300, nonce: authorization.nonce };
      authorization = null;
      const unsigned = `${encode({ alg: 'RS256', kid: 'fictional-key', typ: 'JWT' })}.${encode(payload)}`;
      const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url');
      return respond(res, 200, { access_token: 'fictional-access-token', token_type: 'Bearer', expires_in: 300, id_token: `${unsigned}.${signature}` });
    }
    if (req.method === 'GET' && path === '/v1/oauth2/token/userinfo') {
      calls.userinfo += 1;
      if (req.headers['x-fixture-token-auth'] !== 'validated') return respond(res, 401, { error: 'invalid_fixture_token' });
      return respond(res, 200, { sub: 'fictional-subject', account_type: 'PERSONAL' });
    }
    return respond(res, 501, { error: 'fixture_path_not_modeled' });
  } catch {
    if (!res.headersSent) respond(res, 400, { error: 'invalid_fixture_request' });
    else res.end();
  }
});
server.listen(process.env.PORT);
