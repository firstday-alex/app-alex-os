// The kudos repository: photos on wins and saved, named versions of the kudos page.
// See src/store/kudos-repo.js.
//
//   GET  /kudos?photo=<id>                          the photo's bytes
//   GET  /kudos?week=<YYYY-MM-DD>                   { photos: { winKey: photoId } } for that week
//   GET  /kudos?versions=1                          { versions: [...] }, newest first
//   GET  /kudos?version=<id>                        one saved version
//   POST /kudos { photo: dataUrl }                  store a photo → { id }
//   POST /kudos { week, key, photoId|null }         put a photo on a win, or take it off
//   POST /kudos { week, key, star: bool }           star a win so it stands out, or unstar it
//   POST /kudos { save: { name, kind, week } }      save a version
//   POST /kudos { rename: { id, name } }            rename a version
//   POST /kudos { remove: id }                      take a version off the list

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import * as repo from "../../src/store/kudos-repo.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "kudos" } });
  const store = await Store.open({ config, logger });
  const b = store.backend;
  try {
    if (req.method === "GET") {
      const q = new URL(req.url).searchParams;
      if (q.get("photo")) {
        const p = await repo.getPhoto(b, q.get("photo"));
        return new Response(p.bytes, { status: 200, headers: { "content-type": p.type, "cache-control": "private, max-age=86400, immutable" } });
      }
      if (q.get("week")) return json({ photos: await repo.weekPhotos(b, q.get("week")), stars: await repo.weekStars(b, q.get("week")) });
      if (q.get("version")) return json(await repo.getVersion(b, q.get("version")));
      return json({ versions: await repo.listVersions(b) });
    }
    if (req.method !== "POST") return json({ error: "GET or POST." }, 405);
    const body = await req.json().catch(() => ({}));
    if (body.photo) return json({ id: await repo.addPhoto(b, body.photo) });
    if (body.save) return json({ version: await repo.saveVersion(b, body.save), versions: await repo.listVersions(b) });
    if (body.rename) return json({ version: await repo.renameVersion(b, body.rename), versions: await repo.listVersions(b) });
    if (body.remove) {
      await repo.removeVersion(b, { id: body.remove });
      return json({ versions: await repo.listVersions(b) });
    }
    if (body.week && typeof body.star === "boolean") return json({ stars: await repo.setWeekStar(b, { weekId: body.week, key: body.key, star: body.star }) });
    if (body.week) return json({ photos: await repo.setWeekPhoto(b, { weekId: body.week, key: body.key, photoId: body.photoId ?? null }) });
    return json({ error: "What should change?" }, 400);
  } catch (err) {
    if (err instanceof repo.KudosError) return json({ error: err.message }, err.status);
    logger.error("kudos.failed", { err });
    return json({ error: err.message }, 500);
  }
};
