// Synthetic identities and keys only. No real provider or customer data.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const nativeRequire = createRequire(import.meta.url);

function load(relativePath, aliases = {}) {
  const source = fs.readFileSync(path.join(dirname, '..', relativePath), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const resolve = (name) => {
    if (name === 'server-only') return {};
    if (Object.hasOwn(aliases, name)) return aliases[name];
    return nativeRequire(name);
  };
  new Function('exports', 'require', 'module', code)(loaded.exports, resolve, loaded);
  return loaded.exports;
}

const config = {
  environment: 'sandbox', origin: 'https://app.example.test',
  clientId: 'fixture-client', clientSecret: 'fixture-secret',
  databaseUrl: 'postgresql://fixture:fixture@db.example.test/fixture',
  subjectHmacKey: Buffer.alloc(32, 7).toString('base64url'), accountAttributes: true,
};

const issuer = 'https://www.sandbox.paypal.com';
const base = 'https://api.sandbox.paypal.com';
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/signin/authorize`,
  token_endpoint: `${base}/v1/oauth2/token`,
  userinfo_endpoint: `${base}/v1/oauth2/token/userinfo`,
  jwks_uri: `${base}/v1/oauth2/certs`,
  response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
  id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
  subject_types_supported: ['pairwise'],
};

function fixtureProvider(options = {}) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const requests = [];
  let nonce = 'not-yet-set';
  let expectedChallenge = '';
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const transport = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? 'GET' });
    if (url === `${issuer}/.well-known/openid-configuration`) return response({ ...metadata, ...options.metadata });
    if (url === `${base}/v1/oauth2/certs`) return response({ keys: [jwk] });
    if (url === `${base}/v1/oauth2/token`) {
      if (options.pauseToken) await options.pauseToken();
      const headers = new Headers(init.headers);
      const basic = headers.get('authorization') ?? '';
      const pieces = Buffer.from(basic.replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent);
      if (!basic.startsWith('Basic ') || pieces[0] !== config.clientId || pieces[1] !== config.clientSecret || pieces.length !== 2) throw Error('Unexpected synthetic client authentication');
      const body = new URLSearchParams(String(init.body));
      if (body.get('grant_type') !== 'authorization_code' || body.get('code') !== 'fixture-code' || body.get('redirect_uri') !== `${config.origin}${options.callbackPath ?? '/api/auth/paypal/callback'}`) throw Error('Unexpected synthetic token request');
      const challenge = crypto.createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== expectedChallenge) throw Error('Synthetic PKCE mismatch');
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: options.badIssuer ? 'https://evil.example.test' : issuer,
        aud: options.badAudience ? 'wrong-client' : config.clientId,
        sub: 'synthetic-subject', iat: now - 1, exp: options.expired ? now - 60 : now + 300,
        nonce: options.badNonce ? 'wrong-nonce' : nonce,
      };
      const value = `${encode({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' })}.${encode(payload)}`;
      const signature = crypto.sign('RSA-SHA256', Buffer.from(value), options.badSignature ? wrongPair.privateKey : pair.privateKey).toString('base64url');
      return response({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 300, ...(options.missingIdToken ? {} : { id_token: `${value}.${signature}` }) });
    }
    if (url.startsWith(`${base}/v1/oauth2/token/userinfo`)) {
      const headers = new Headers(init.headers);
      if (headers.get('authorization') !== 'Bearer synthetic-access-token') throw Error('Unexpected synthetic userinfo authorization');
      return response({ sub: options.badSubject ? 'other-synthetic-subject' : 'synthetic-subject', ...(options.accountType === null ? {} : { account_type: options.accountType ?? 'BUSINESS' }) });
    }
    throw Error(`Unexpected synthetic endpoint ${url}`);
  };
  function acceptAuthorization(location) {
    const url = new URL(location);
    nonce = url.searchParams.get('nonce');
    expectedChallenge = url.searchParams.get('code_challenge');
    return url.searchParams.get('state');
  }
  return { transport, requests, acceptAuthorization };
}

function fakeStore() {
  const transactions = new Map();
  const sessions = new Map();
  const families = new Map();
  const checkAvailable = (store) => { if (!store.available) throw Error('fixture unavailable'); };
  return {
    transactions, sessions, families, available: true,
    async ready() { return this.available; },
    async createTransaction(key, context, login, sessionKey, priorKey) {
      checkAvailable(this);
      const session = sessionKey ? sessions.get(sessionKey) : null;
      const previous = !sessionKey && priorKey ? transactions.get(priorKey) : null;
      if (sessionKey && (!session || session.context !== context || session.revoked)) throw Error('invalid session');
      const familyKey = session?.family ?? (previous?.context === context ? previous.family : key);
      if (!families.has(familyKey)) families.set(familyKey, { context, generation: 0 });
      const family = families.get(familyKey);
      if (family.context !== context || (session && session.generation !== family.generation) ||
          (previous && previous.context === context && previous.generation !== family.generation)) throw Error('invalid family');
      transactions.set(key, { context, login, family: familyKey, generation: family.generation, initialSession: sessionKey, status: 'pending' });
    },
    async consumeTransaction(key, context) {
      checkAvailable(this);
      const tx = transactions.get(key);
      if (!tx || tx.status !== 'pending') return null;
      if (tx.context !== context) { tx.status = 'completed'; tx.login = null; return null; }
      tx.status = 'processing';
      return tx.login;
    },
    async createSession(key, context, identity, transactionKey, previousKey) {
      checkAvailable(this);
      const tx = transactions.get(transactionKey);
      const family = tx && families.get(tx.family);
      if (!tx || !family || tx.status !== 'processing' || tx.context !== context || family.context !== context ||
          tx.generation !== family.generation || tx.initialSession !== previousKey) throw Error('invalid transaction');
      if (previousKey) {
        const previous = sessions.get(previousKey);
        if (!previous || previous.revoked || previous.context !== context || previous.family !== tx.family || previous.generation !== family.generation) throw Error('invalid session');
        previous.revoked = true;
      }
      sessions.set(key, { context, family: tx.family, generation: family.generation, revoked: false, identity });
      tx.status = 'completed';
      tx.login = null;
    },
    async readSession(key, context) {
      checkAvailable(this);
      const session = sessions.get(key);
      const family = session && families.get(session.family);
      return session && family && !session.revoked && session.context === context && family.context === context && session.generation === family.generation ? session.identity : null;
    },
    async logout(sessionKey, transactionKey) {
      checkAvailable(this);
      const keys = new Set([sessions.get(sessionKey)?.family, transactions.get(transactionKey)?.family].filter(Boolean));
      for (const key of keys) {
        families.get(key).generation += 1;
        for (const session of sessions.values()) if (session.family === key) session.revoked = true;
        for (const tx of transactions.values()) if (tx.family === key && tx.status !== 'completed') { tx.status = 'completed'; tx.login = null; }
      }
    },
  };
}

export { load, config, metadata, fixtureProvider, fakeStore };
