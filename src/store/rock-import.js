// Bringing rock names across from the marketing standup.
//
// The standup is where the team names its rocks, and it renames them as the quarter
// moves. This store is where those rocks are linked to ClickUp. Nothing connects the two
// automatically — the standup sits behind its own sign-in — so the bridge is a paste:
// copy the rocks out of the standup, paste them here, check the plan, apply it.
//
// Two halves, kept apart so the plan can be shown before anything is written:
//   parseStandupRocks  - text in, a list of { title, standupId, team, quarter } out
//   planRockImport     - that list plus the current rocks and ClickUp options in, a
//                        proposed rename / create per pasted rock out
//
// The plan only ever proposes. A fuzzy match is a suggestion the person confirms, and a
// rock missing from the paste is reported, never removed.

/** How alike two titles must be before a match is offered rather than a new rock. */
export const ROCK_MATCH_THRESHOLD = 0.5;
/** ClickUp option labels are shorter and terser than rock titles, so ask for more. */
export const OPTION_MATCH_THRESHOLD = 0.6;

export function normalizeTitle(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(["a", "an", "the", "and", "of", "to", "for", "in", "on", "by", "with"]);

function tokens(text) {
  return new Set(normalizeTitle(text).split(" ").filter((t) => t && !STOP_WORDS.has(t)));
}

/** Dice overlap of the meaningful words. 1 is the same words, 0 is none in common. */
export function titleSimilarity(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

function rocksFromJson(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rocks)) return value.rocks;
  if (Array.isArray(value?.board?.rocks)) return value.board.rocks;
  if (Array.isArray(value?.rocksBoard?.rocks)) return value.rocksBoard.rocks;
  return null;
}

/**
 * Reads what was pasted. Two shapes are accepted:
 *
 *   JSON  - the standup's own get-rocks response, or an array of rocks. Preferred: it
 *           carries the standup's rock id, which lets the next paste follow a rename
 *           instead of guessing from the words.
 *   lines - one rock title per line. Bullets and numbering are stripped.
 *
 * Business-as-usual entries are dropped: on the standup they are a per-team bucket, not
 * a rock.
 */
export function parseStandupRocks(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { format: "empty", rocks: [], skipped: [] };

  if (/^<(!doctype|html)\b/i.test(raw) || /<select[^>]*\bdata-rock\b/i.test(raw)) return parseStandupHtml(raw);

  const skipped = [];
  let json = null;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }

  if (json != null) {
    const list = rocksFromJson(json);
    if (!list) throw new Error("That JSON has no rocks list in it. Paste the get-rocks response, or one title per line.");
    const rocks = [];
    for (const item of list) {
      const title = String(item?.title ?? item?.name ?? "").trim();
      if (!title) {
        skipped.push({ reason: "no title", item: item?.id ?? null });
        continue;
      }
      if (item.isBau) {
        skipped.push({ reason: "business as usual", title });
        continue;
      }
      rocks.push({
        title,
        standupId: item.id == null ? null : String(item.id),
        team: item.owner == null ? null : String(item.owner),
        quarter: item.quarter == null ? null : String(item.quarter),
      });
    }
    return { format: "json", rocks: dedupe(rocks), skipped };
  }

  const rocks = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•▪◦]+|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .map((title) => ({ title, standupId: null, team: null, quarter: null }));
  return { format: "lines", rocks: dedupe(rocks), skipped };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name) => ENTITIES[name]);
}

const BAU_TITLE = /^business as usual\b/i;

/**
 * The standup page itself, copied as HTML. Every "Rock this ladders up to" dropdown on
 * the Submit update screen lists every rock in the company with its standup id:
 *
 *   <optgroup label="Web's rocks">   <option value="id">Title · 2026-Q4</option>
 *   <optgroup label="Other teams' rocks"> <option value="id">Title · Team</option>
 *
 * The page's own team is the one named in "<Team>'s rocks". Its rocks carry a quarter;
 * other teams' rocks carry their team instead. Business-as-usual entries are dropped.
 */
export function parseStandupHtml(html) {
  const select = html.match(/<select[^>]*\bdata-rock\b[^>]*>([\s\S]*?)<\/select>/i);
  if (!select) {
    throw new Error("That page has no rock list in it. Copy it from the standup's Submit update screen, where each tactic has a rock dropdown.");
  }

  const rocks = [];
  const skipped = [];
  let ownTeam = null;

  // Walk optgroups and loose options in order, so each option knows its group.
  const parts = select[1].matchAll(/<optgroup[^>]*label="([^"]*)"[^>]*>([\s\S]*?)<\/optgroup>|<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi);
  for (const part of parts) {
    const options = part[1] != null
      ? [...part[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)].map((m) => [m[1], m[2]])
      : [[part[3], part[4]]];
    const group = part[1] != null ? decodeEntities(part[1]) : null;
    const groupTeam = group?.match(/^(.*)'s rocks$/)?.[1] ?? null;
    if (groupTeam && !ownTeam) ownTeam = groupTeam;

    for (const [id, rawText] of options) {
      if (!id) continue; // the "choose a rock" placeholder
      const text = decodeEntities(rawText.replace(/<[^>]*>/g, "")).trim();
      // " · " separates the title from its quarter or team. Split on the last one: a
      // title is free text and could hold one of its own.
      const cut = text.lastIndexOf(" · ");
      const title = (cut > 0 ? text.slice(0, cut) : text).trim();
      const suffix = cut > 0 ? text.slice(cut + 3).trim() : null;
      if (!group || BAU_TITLE.test(title)) {
        skipped.push({ reason: "business as usual", title });
        continue;
      }
      const isQuarter = suffix && /^\d{4}-Q[1-4]$/.test(suffix);
      rocks.push({
        title,
        standupId: decodeEntities(id),
        team: groupTeam ?? (isQuarter ? null : suffix),
        quarter: isQuarter ? suffix : null,
      });
    }
  }

  return { format: "html", rocks: dedupe(rocks), skipped, ownTeam };
}

function dedupe(rocks) {
  const seen = new Set();
  return rocks.filter((r) => {
    const key = r.standupId ?? normalizeTitle(r.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The best option on a ClickUp dropdown for a title, if any is close enough. */
export function suggestOption(title, options) {
  const wanted = normalizeTitle(title);
  let best = null;
  for (const option of options ?? []) {
    if (normalizeTitle(option.label) === wanted) return { id: String(option.id), label: option.label, match: "exact" };
    const score = titleSimilarity(title, option.label);
    if (score >= OPTION_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { id: String(option.id), label: option.label, match: "similar", score };
    }
  }
  return best;
}

/**
 * What applying the paste would do, one entry per pasted rock.
 *
 * Matching runs in passes, strongest first, so a weak match never claims a rock that a
 * strong one needs:
 *   1. the standup id stored on a rock by an earlier import
 *   2. the same title, ignoring case and punctuation
 *   3. the most similar remaining title, above ROCK_MATCH_THRESHOLD
 * Anything left over is a new rock.
 *
 * When the paste carries quarters, only the latest quarter is included by default.
 * When it names the page's own team (an HTML paste lists every team's rocks), a new rock
 * from another team starts unticked: a match to a rock already here is still ticked,
 * whoever owns it. Everything stays listed, so any row can be ticked back in.
 */
export function planRockImport({ pasted, rocks, rockReferenceOptions = [], bigSwingOptions = [], ownTeam = null }) {
  const existing = rocks ?? [];
  const claimed = new Map(); // rock id -> index into pasted
  const matchFor = new Array(pasted.length).fill(null);

  const claim = (i, rock, how, score = null) => {
    claimed.set(rock.id, i);
    matchFor[i] = { rock, how, score };
  };

  pasted.forEach((p, i) => {
    if (!p.standupId) return;
    const rock = existing.find((r) => r.standupRockId === p.standupId && !claimed.has(r.id));
    if (rock) claim(i, rock, "standup id");
  });
  pasted.forEach((p, i) => {
    if (matchFor[i]) return;
    const rock = existing.find((r) => !claimed.has(r.id) && normalizeTitle(r.title) === normalizeTitle(p.title));
    if (rock) claim(i, rock, "same title");
  });
  // Highest-scoring pairs first, across every pasted rock, rather than first come first
  // served: otherwise the order of the paste decides who gets the contested rock.
  const candidates = [];
  pasted.forEach((p, i) => {
    if (matchFor[i]) return;
    for (const rock of existing) {
      if (claimed.has(rock.id)) continue;
      const score = titleSimilarity(p.title, rock.title);
      if (score >= ROCK_MATCH_THRESHOLD) candidates.push({ i, rock, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (matchFor[c.i] || claimed.has(c.rock.id)) continue;
    claim(c.i, c.rock, "similar title", Math.round(c.score * 100) / 100);
  }

  const quarters = pasted.map((p) => p.quarter).filter(Boolean).sort();
  const latestQuarter = quarters.length ? quarters[quarters.length - 1] : null;

  const items = pasted.map((p, i) => {
    const m = matchFor[i];
    const rock = m?.rock ?? null;
    const action = !rock ? "create" : rock.title === p.title ? "unchanged" : "rename";

    // Only suggest a ClickUp link where there is none. An existing link was chosen by a
    // person and is held by option id, so a rename does not break it.
    const rockReference = rock?.clickupOptionId ? null : suggestOption(p.title, rockReferenceOptions);
    const bigSwing = rock?.clickupBigSwingOptionId ? null : suggestOption(p.title, bigSwingOptions);

    return {
      index: i,
      title: p.title,
      standupId: p.standupId,
      team: p.team,
      quarter: p.quarter,
      include:
        (!latestQuarter || !p.quarter || p.quarter === latestQuarter) &&
        (action !== "create" || !ownTeam || p.team === ownTeam),
      action,
      rockId: rock?.id ?? null,
      currentTitle: rock?.title ?? null,
      matchedBy: m?.how ?? null,
      matchScore: m?.score ?? null,
      currentRockReferenceId: rock?.clickupOptionId ?? null,
      currentBigSwingId: rock?.clickupBigSwingOptionId ?? null,
      suggestedRockReference: rockReference,
      suggestedBigSwing: bigSwing,
    };
  });

  const notInPaste = existing
    .filter((r) => !claimed.has(r.id) && r.state !== "shipped")
    .map((r) => ({ id: r.id, title: r.title, state: r.state }));

  return { latestQuarter, items, notInPaste };
}
