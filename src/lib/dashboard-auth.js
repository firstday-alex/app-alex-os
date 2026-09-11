// Dashboard auth. The dashboard shows sprint and test data, so it is not left public.
//
// A shared password exchanged for a signed, HttpOnly session cookie. Netlify Identity is
// the alternative if Alex would rather manage real accounts; `isAuthorized` is the only
// place that would need to change.

import crypto from "node:crypto";

const COOKIE = "mos_session";

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function checkPassword(supplied, expected) {
  if (!expected) return false;
  return safeEqual(supplied ?? "", expected);
}

export function issueSession(secret, ttlHours = 12) {
  const expires = Date.now() + ttlHours * 3600_000;
  const payload = String(expires);
  const value = `${payload}.${sign(payload, secret)}`;
  return {
    value,
    expires,
    header: `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ttlHours * 3600)}`,
  };
}

export function readCookie(req, name = COOKIE) {
  const header = req.headers?.get?.("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function isAuthorized(req, env = process.env) {
  const secret = env.DASHBOARD_COOKIE_SECRET;
  if (!secret) return { ok: false, reason: "DASHBOARD_COOKIE_SECRET is not set" };

  const cookie = readCookie(req);
  if (!cookie) return { ok: false, reason: "no session" };

  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return { ok: false, reason: "malformed session" };
  if (!safeEqual(sign(payload, secret), signature)) return { ok: false, reason: "bad signature" };
  if (Number(payload) < Date.now()) return { ok: false, reason: "session expired" };

  return { ok: true };
}

/** Guards the internal pipeline invoke so only the scheduler and refresh can start a run. */
export function isInternalCall(req, env = process.env) {
  const secret = env.DASHBOARD_COOKIE_SECRET;
  if (!secret) return false;
  const supplied = req.headers?.get?.("x-mos-internal");
  return Boolean(supplied) && safeEqual(supplied, secret);
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });
}

export function unauthorized(reason) {
  return json({ error: "unauthorized", reason }, 401);
}
