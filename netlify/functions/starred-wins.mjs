// Starred wins, for Kudos › Starred wins. See src/store/starred-wins.js.
//
//   GET  /starred-wins                       every starred win
//   POST /starred-wins  { win, grade }       star a win A+, A or A- (or change its grade)
//   POST /starred-wins  { unstar: key }      take it off the list

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { readStarred, starWin, unstarWin, StarError } from "../../src/store/starred-wins.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "starred-wins" } });
  const store = await Store.open({ config, logger });
  try {
    if (req.method === "GET") return json(await readStarred(store.backend));
    if (req.method !== "POST") return json({ error: "GET or POST." }, 405);
    const body = await req.json().catch(() => ({}));
    if (body.unstar) await unstarWin(store.backend, { key: body.unstar });
    else await starWin(store.backend, { win: body.win, grade: body.grade });
    return json(await readStarred(store.backend));
  } catch (err) {
    if (err instanceof StarError) return json({ error: err.message }, err.status);
    logger.error("starred_wins.failed", { err });
    return json({ error: err.message }, 500);
  }
};
