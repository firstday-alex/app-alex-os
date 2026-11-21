// The kudos repository (Alex, 2026-11-21: "be able to have photos added ... and/or ability to
// save down versions with names into kudos repository").
//
//   kudos/photos/<id>.json          one photo: { type, data } (base64), shrunk in the browser first
//   kudos/week-photos/<week>.json   which photo goes on which win that week: { [winKey]: photoId }
//   kudos/versions.json             the saved pages: { items: { [id]: { id, name, weekId, ... } } }
//   kudos/versions/<id>.json        one saved page's week; each image a link to the ClickUp
//                                   attachment, or "photo:<id>" for a photo kept here
//
// A saved version points at the exact attachment it showed (not "the newest on the ticket"),
// so a newer image on the ticket does not change it. Alex, 2026-11-21: "the saved kudos
// versions can just be html and links to the images since they are hosted in clickup".

import { randomUUID } from "node:crypto";

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
const WIN = /^t[A-Za-z0-9_.-]{1,200}$/;
const ID = /^[0-9a-f-]{36}$/;
const PHOTO_REF = /^photo:([0-9a-f-]{36})$/;

/** A link to an image on ClickUp's own hosts. */
export function isClickUpImageUrl(v) {
  if (typeof v !== "string" || v.length > 1000) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && /(^|\.)(clickup\.com|clickup-attachments\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

export class KudosError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const check = (ok, message, status) => {
  if (!ok) throw new KudosError(message, status);
};

/** Store a photo; returns its id. */
export async function addPhoto(backend, dataUrl) {
  const m = String(dataUrl ?? "").match(DATA_URL);
  check(m, "Send a PNG, JPG, GIF or WebP image.");
  check(m[2].length * 0.75 <= MAX_PHOTO_BYTES, "That image is too big, even shrunk. Try a smaller one.");
  const id = randomUUID();
  await backend.set(`kudos/photos/${id}.json`, { type: m[1], data: m[2] });
  return id;
}

export async function getPhoto(backend, id) {
  check(ID.test(String(id ?? "")), "Which photo?");
  const p = await backend.get(`kudos/photos/${id}.json`);
  check(p?.data, "No such photo.", 404);
  return { type: p.type, bytes: Buffer.from(p.data, "base64") };
}

export async function weekPhotos(backend, weekId) {
  check(WEEK.test(String(weekId ?? "")), "Which week?");
  return (await backend.get(`kudos/week-photos/${weekId}.json`)) ?? {};
}

/** Put a photo on a win for a week, or take it off (photoId null). The photo itself is kept,
    since a saved version may use it. */
export async function setWeekPhoto(backend, { weekId, key, photoId }) {
  check(WIN.test(String(key ?? "")), "Which win?");
  if (photoId != null) check(ID.test(String(photoId)), "Which photo?");
  const map = await weekPhotos(backend, weekId);
  if (photoId) map[key] = photoId;
  else delete map[key];
  await backend.set(`kudos/week-photos/${weekId}.json`, map);
  return map;
}

const clip = (v, n) => String(v ?? "").trim().slice(0, n);

/** The week as the page needs it, cleaned: only photo refs as images, only https links. */
export function cleanWeek(week) {
  check(week && WEEK.test(String(week.id ?? "")), "Which week?");
  const rocks = (Array.isArray(week.rocks) ? week.rocks : []).slice(0, 40).map((r) => ({
    n: clip(r?.n, 80),
    ...(Number.isInteger(r?.c) && r.c >= 0 && r.c <= 2 ? { c: r.c } : {}),
    w: (Array.isArray(r?.w) ? r.w : []).slice(0, 80).flatMap((x) => {
      if (!WIN.test(String(x?.k ?? "")) || !clip(x?.t, 240)) return [];
      return [{ k: x.k, t: clip(x.t, 240), ...(/^https:\/\//.test(String(x.u ?? "")) ? { u: String(x.u).slice(0, 500) } : {}), ...(PHOTO_REF.test(String(x.i ?? "")) || isClickUpImageUrl(x.i) ? { i: x.i } : {}) }];
    }),
  })).filter((r) => r.n && r.w.length);
  check(rocks.length, "There are no wins on that page.");
  return { id: week.id, label: clip(week.label, 80) || `Week of ${week.id}`, at: clip(week.at, 40), rocks };
}

const summaryOf = (v) => ({ id: v.id, name: v.name, weekId: v.week.id, weekLabel: v.week.label, kind: v.kind, savedAt: v.savedAt, wins: v.week.rocks.reduce((n, r) => n + r.w.length, 0), photos: v.week.rocks.reduce((n, r) => n + r.w.filter((x) => x.i).length, 0) });

export async function listVersions(backend) {
  const doc = (await backend.get("kudos/versions.json")) ?? {};
  return Object.values(doc.items ?? {}).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

export async function saveVersion(backend, { name, kind, week, now = new Date() }) {
  const clean = cleanWeek(week);
  const v = { id: randomUUID(), name: clip(name, 120) || `${clean.label}`, kind: kind === "thisweek" ? "thisweek" : "lastweek", savedAt: now.toISOString(), week: clean };
  await backend.set(`kudos/versions/${v.id}.json`, v);
  const doc = (await backend.get("kudos/versions.json")) ?? {};
  doc.items = { ...(doc.items ?? {}), [v.id]: summaryOf(v) };
  await backend.set("kudos/versions.json", doc);
  return summaryOf(v);
}

export async function getVersion(backend, id) {
  check(ID.test(String(id ?? "")), "Which version?");
  const v = await backend.get(`kudos/versions/${id}.json`);
  check(v, "No such version.", 404);
  return v;
}

export async function renameVersion(backend, { id, name }) {
  const v = await getVersion(backend, id);
  check(clip(name, 120), "Give it a name.");
  v.name = clip(name, 120);
  await backend.set(`kudos/versions/${id}.json`, v);
  const doc = (await backend.get("kudos/versions.json")) ?? {};
  doc.items = { ...(doc.items ?? {}), [id]: summaryOf(v) };
  await backend.set("kudos/versions.json", doc);
  return summaryOf(v);
}

/** Take a version off the list. Its record and photos stay in storage. */
export async function removeVersion(backend, { id }) {
  check(ID.test(String(id ?? "")), "Which version?");
  const doc = (await backend.get("kudos/versions.json")) ?? {};
  const had = Boolean(doc.items?.[id]);
  if (had) {
    delete doc.items[id];
    await backend.set("kudos/versions.json", doc);
  }
  return had;
}
