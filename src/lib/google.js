// Google, read only, as a service account. Used for the site changelog sheet.
//
// A service account signs a short JWT with its private key and trades it for a one hour
// access token (the OAuth 2.0 JWT bearer grant). No library: node:crypto signs RS256.
// The scope is spreadsheets.readonly, so nothing this app holds can write to a sheet.
//
// Two ways to give the credentials, both Netlify secrets, never in the repo:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY   (preferred: smaller, and Netlify
//                                                        functions share a 4 KB env limit)
//   GOOGLE_SERVICE_ACCOUNT_JSON                         (the whole key file, as a string)
// The sheet must be shared with the service account's email as a Viewer.

import { createSign } from "node:crypto";
import { httpJson } from "./http.js";

export const SHEETS_READONLY = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The service account from the environment, or null when none is set. */
export function serviceAccountFrom(env = process.env) {
  if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY) {
    return { email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim(), key: unescapeKey(env.GOOGLE_PRIVATE_KEY) };
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file.");
    }
    if (!parsed.client_email || !parsed.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON has no client_email or private_key.");
    return { email: parsed.client_email, key: unescapeKey(parsed.private_key) };
  }
  return null;
}

// A key pasted into an env var often arrives with literal "\n" instead of line breaks.
const unescapeKey = (key) => String(key).replace(/\\n/g, "\n");

const b64url = (input) => Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The signed assertion. Pure apart from the clock, which is passed in. */
export function signedJwt({ email, key }, scope, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(key))}`;
}

// One token per warm function instance, reused until five minutes before it expires.
const cache = new Map();

export async function googleAccessToken({ account, scope = SHEETS_READONLY, fetchImpl, sleep, logger, now = () => Date.now() }) {
  const cacheKey = `${account.email}|${scope}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt - 5 * 60_000 > now()) return hit.token;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signedJwt(account, scope, now()),
  }).toString();
  const res = await httpJson(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    label: "google.token",
    maxAttempts: 3,
    fetchImpl,
    sleep,
    logger,
  });
  const token = res.body?.access_token;
  if (!token) throw new Error("Google did not return an access token for the service account.");
  const ttl = Number(res.body?.expires_in ?? 3600);
  cache.set(cacheKey, { token, expiresAt: now() + ttl * 1000 });
  return token;
}

/** Test hook. */
export function clearGoogleTokenCache() {
  cache.clear();
}
