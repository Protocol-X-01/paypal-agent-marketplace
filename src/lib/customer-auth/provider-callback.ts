import "server-only";

const OAUTH_SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/;
const ISSUER_VALUE = /^[\x21-\x7E]+$/;
const KNOWN = new Set(["code", "state", "error", "error_description", "error_uri", "scope", "iss"]);
const UNSUPPORTED = new Set(["response", "id_token", "access_token", "token", "token_type", "expires_in", "refresh_token"]);

/** Accept bounded provider extensions without treating them as identity or authority. */
export function parseProviderCallbackQuery(url: URL): URLSearchParams {
  const invalid = () => new Error("Invalid identity callback");
  if (Buffer.byteLength(url.search, "utf8") > 4096) throw invalid();
  const accepted = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (UNSUPPORTED.has(key)) throw invalid();
    if (!KNOWN.has(key)) continue;
    if (accepted.has(key)) throw invalid();
    accepted.append(key, value);
  }
  const state = accepted.get("state"), code = accepted.get("code"), error = accepted.get("error");
  const scope = accepted.get("scope"), issuer = accepted.get("iss");
  if (!state || (accepted.has("code") && accepted.has("error")) || (!code && !error) ||
      (code && (code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code))) || (error && error.length > 128)) throw invalid();
  if ((accepted.has("error_description") || accepted.has("error_uri")) && (!error || accepted.has("code"))) throw invalid();
  if (scope !== null && (!code || accepted.has("error") || scope.length > 1024 || !OAUTH_SCOPE.test(scope))) throw invalid();
  if (issuer !== null && (issuer.length > 2048 || !ISSUER_VALUE.test(issuer))) throw invalid();
  return accepted;
}

/** Forward only protocol inputs needed by OpenID validation, including issuer. */
export function buildProviderCallbackUrl(callback: string, query: URLSearchParams): URL {
  const result = new URL(callback);
  for (const key of ["code", "state", "iss"]) {
    const value = query.get(key); if (value !== null) result.searchParams.append(key, value);
  }
  return result;
}
