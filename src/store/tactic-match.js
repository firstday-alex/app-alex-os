// Standup tactics against the ClickUp sprint.
//
// The standup is where the team says what it is working on; the sprint is where the
// work is actually ticketed. The two drift: a tactic gets talked about every morning
// with no ticket behind it, and tickets get worked that no tactic mentions. This puts
// them side by side, from the same standup page paste the rock import reads.
//
// Matching is on the names, because nothing else is shared: the standup holds no ClickUp
// ids. A tactic is usually broader than a ticket ("Family Bundle Builder" against
// "Family Bundle Builder V2 test"), so one tactic can match several tickets. Every match
// is shown with its score; this is a list for a person to read, never a link that is
// written anywhere.

import { normalizeTitle, titleSimilarity } from "./rock-import.js";

/** A tactic and a ticket this alike are treated as the same work. */
export const TACTIC_MATCH_THRESHOLD = 0.5;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
function decode(text) {
  return String(text ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name) => ENTITIES[name]);
}

/** The value="" of the first <input data-f="field">, whatever order its attributes are in. */
function inputValue(block, field) {
  const tag = block.match(new RegExp(`<input[^>]*\\bdata-f="${field}"[^>]*>`, "i"))?.[0];
  const value = tag?.match(/\bvalue="([^"]*)"/i)?.[1];
  return value == null ? null : decode(value).trim() || null;
}

/**
 * Every tactic on a standup Submit update page.
 *
 * Each tactic is a `.priority-item` block holding its title, owner and status inputs and
 * a "Rock this ladders up to" dropdown with the chosen rock selected. Parking lot rows
 * share the class but carry a second one, and are not matched.
 */
export function parseStandupTactics(html) {
  const tactics = [];
  const blocks = String(html ?? "").split(/<div class="priority-item">/i).slice(1);
  for (const block of blocks) {
    const title = inputValue(block, "title");
    if (!title) continue;

    const statusSelect = block.match(/<select[^>]*\bdata-f="status"[^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? "";
    const status = statusSelect.match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/i)?.[1] ?? null;

    const rockSelect = block.match(/<select[^>]*\bdata-rock\b[^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? "";
    const rock = rockSelect.match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i);
    const rockText = rock ? decode(rock[2].replace(/<[^>]*>/g, "")).trim() : null;
    const cut = rockText ? rockText.lastIndexOf(" · ") : -1;
    const rockTitle = rockText ? (cut > 0 ? rockText.slice(0, cut) : rockText).trim() : null;

    tactics.push({
      title,
      owner: inputValue(block, "owner"),
      status,
      kpi: inputValue(block, "kpi"),
      rockStandupId: rock?.[1] || null,
      rockTitle,
      isBau: /^business as usual\b/i.test(rockTitle ?? ""),
    });
  }
  return tactics;
}

const peopleOf = (task) =>
  [...(task.taskOwners ?? []), ...(task.assignees ?? [])].map((u) => normalizeTitle(u.username)).filter(Boolean);

/**
 * How alike a tactic and a ticket are, 0 to 1.
 *
 * Word overlap, plus one allowance: when every word of the shorter name appears in the
 * longer one, and the shorter has at least two, they are counted as a match. That is
 * the common case of a ticket being one piece of a tactic. A single shared word is too
 * weak for that ("App" would claim every ticket that mentions an app).
 */
export function tacticTicketScore(tacticTitle, ticketName) {
  let score = titleSimilarity(tacticTitle, ticketName);
  const a = new Set(normalizeTitle(tacticTitle).split(" ").filter(Boolean));
  const b = new Set(normalizeTitle(ticketName).split(" ").filter(Boolean));
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size >= 2 && [...small].every((t) => large.has(t))) score = Math.max(score, 0.8);
  return Math.round(score * 100) / 100;
}

/**
 * Tactics against tickets, both ways.
 *
 *   matched             - each tactic with the tickets that look like it, best first
 *   tacticsWithoutTicket - standup work with nothing in the sprint behind it
 *   ticketsWithoutTactic - open sprint work no tactic mentions
 *
 * Done tickets can still match a tactic, since finished work is still evidence of it,
 * but a done ticket with no tactic is not listed: it is not drifting, it is finished.
 * When a tactic's owner is also on the ticket, the match is noted, not scored up: the
 * name has to carry it, so a shared owner cannot pair two unrelated pieces of work.
 */
export function matchTacticsToTickets({ tactics, tasks }) {
  const tickets = (tasks ?? []).filter((t) => !t.archived);
  const matchedTicketIds = new Set();

  const rows = (tactics ?? []).map((tactic) => {
    const owner = normalizeTitle(tactic.owner);
    const matches = tickets
      .map((task) => ({ task, score: tacticTicketScore(tactic.title, task.name) }))
      .filter((m) => m.score >= TACTIC_MATCH_THRESHOLD)
      .sort((x, y) => y.score - x.score)
      .map(({ task, score }) => {
        matchedTicketIds.add(task.id);
        return {
          id: task.id,
          name: task.name,
          url: task.url,
          status: task.status,
          bucket: task.bucket,
          score,
          sameOwner: Boolean(owner) && peopleOf(task).includes(owner),
        };
      });
    return { tactic, tickets: matches };
  });

  return {
    matched: rows.filter((r) => r.tickets.length),
    tacticsWithoutTicket: rows.filter((r) => !r.tickets.length).map((r) => r.tactic),
    ticketsWithoutTactic: tickets
      .filter((t) => !matchedTicketIds.has(t.id) && t.bucket !== "done" && !t.closed)
      .map((t) => ({
        id: t.id,
        name: t.name,
        url: t.url,
        status: t.status,
        owners: [...new Set([...(t.taskOwners ?? []), ...(t.assignees ?? [])].map((u) => u.username).filter(Boolean))],
        bigSwing: t.bigSwing?.label ?? null,
        rockReference: t.leadershipPriority?.label ?? null,
      })),
  };
}
