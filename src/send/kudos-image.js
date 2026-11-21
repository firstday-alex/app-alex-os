// The hover screenshot for a win on the kudos page: the newest image attached to its ClickUp
// ticket. Alex, 2026-11-19: "can it pull an image for hover from the clickup ticket to show in
// the html kudos file?" The token stays on the server; the browser gets the bytes and puts
// them inside the page.
//
// Adding a photo attaches it to the ticket (attachImage), so it becomes the newest image and
// the page shows it. Alex, 2026-11-21: "should the photos just upload to the clickup" / "i
// dont think we need to delete right because app takes most recent photo". Nothing is deleted.

const IMAGE = /^(png|jpe?g|gif|webp)$/i;
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
// Netlify sends binary responses base64'd, with a 6 MB cap on the encoded body.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Only ClickUp's own attachment hosts: the URL comes from ClickUp, but never fetch elsewhere. */
export function isClickUpHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)(clickup\.com|clickup-attachments\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

const extOf = (a) => String(a.extension ?? String(a.title ?? "").split(".").pop() ?? "").toLowerCase();

/** The ticket's image attachments, newest first. */
export function imageAttachments(task) {
  return (task?.attachments ?? [])
    .filter((a) => a && !a.deleted && !a.hidden && !a.is_folder && IMAGE.test(extOf(a)) && (isClickUpHost(a.url) || isClickUpHost(a.thumbnail_large)))
    .sort((a, b) => Number(b.date ?? 0) - Number(a.date ?? 0));
}

async function download(url, token, fetchImpl) {
  // ClickUp's attachment links usually open without a token, and a signed storage link can
  // refuse one, so try without first.
  for (const headers of [{}, { authorization: token }]) {
    const res = await fetchImpl(url, { headers, redirect: "follow" });
    const type = String(res.headers.get("content-type") ?? "");
    if (!res.ok || /text\/html/i.test(type)) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length && bytes.length <= MAX_IMAGE_BYTES) return { bytes, type };
    if (bytes.length > MAX_IMAGE_BYTES) return { tooBig: true };
  }
  return null;
}

/**
 * The newest image on a ticket: { bytes, type, title } or null when it has none (or none
 * that could be read under the size cap). Falls back to ClickUp's large thumbnail when the
 * original is too big.
 */
export async function ticketImage({ taskId, config, token, fetchImpl = fetch, logger }) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(taskId ?? ""))) throw Object.assign(new Error("Bad ticket id."), { status: 400 });
  if (!token) throw Object.assign(new Error("CLICKUP_TOKEN is not set."), { status: 500 });
  const res = await fetchImpl(`${config.clickup.apiBase}/task/${encodeURIComponent(taskId)}`, { headers: { authorization: token } });
  if (!res.ok) throw Object.assign(new Error(`ClickUp said ${res.status} for that ticket.`), { status: res.status === 404 ? 404 : 502 });
  const task = await res.json();
  for (const a of imageAttachments(task).slice(0, 3)) {
    for (const url of [a.url, a.thumbnail_large]) {
      if (!isClickUpHost(url)) continue;
      const got = await download(url, token, fetchImpl).catch((err) => {
        logger?.warn?.("kudos_image.download_failed", { err });
        return null;
      });
      if (got?.bytes) {
        const type = /^image\/(png|jpeg|gif|webp)$/.test(got.type) ? got.type : TYPES[extOf(a)] ?? "image/png";
        return { bytes: got.bytes, type, title: String(a.title ?? "") };
      }
    }
  }
  return null;
}

const DATA_URL = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;
const EXT = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };

/**
 * Attach a photo (a data URL, shrunk in the browser) to a ClickUp ticket. Returns { url } of
 * the new attachment. Named kudos-<date>.<ext> so it reads as what it is on the ticket.
 */
export async function attachImage({ taskId, dataUrl, config, token, fetchImpl = fetch, now = new Date() }) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(taskId ?? ""))) throw Object.assign(new Error("Bad ticket id."), { status: 400 });
  if (!token) throw Object.assign(new Error("CLICKUP_TOKEN is not set."), { status: 500 });
  const m = String(dataUrl ?? "").match(DATA_URL);
  if (!m) throw Object.assign(new Error("Send a PNG, JPG, GIF or WebP image."), { status: 400 });
  const bytes = Buffer.from(m[3], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("That image is too big, even shrunk. Try a smaller one."), { status: 400 });
  const name = `kudos-${now.toISOString().slice(0, 10)}.${EXT[m[2]]}`;
  const form = new FormData();
  form.append("attachment", new Blob([bytes], { type: m[1] }), name);
  const res = await fetchImpl(`${config.clickup.apiBase}/task/${encodeURIComponent(taskId)}/attachment`, { method: "POST", headers: { authorization: token }, body: form, signal: AbortSignal.timeout(60000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`ClickUp did not take the photo: ${body.err ?? `HTTP ${res.status}`}`), { status: 502 });
  return { url: body.url ?? null, name };
}
