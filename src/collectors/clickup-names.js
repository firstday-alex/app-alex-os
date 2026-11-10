// ClickUp's ROCK and TACTIC dropdowns are meant to carry the same names as the rocks and
// tactics in the marketing standup (Alex, 2026-11-09):
//
//   ROCK   (field f9135883, `bigSwing` in code: it was named Big Swing)   = a quarterly rock
//   TACTIC (field de6b3171, `leadershipPriority` in code: was Rock Reference) = one of its tactics
//
// So a ticket is linked by name, every run, from the current option names. A rock owns
// the ROCK option that names it and the TACTIC options that name its open tactics, on
// top of any link set by hand in the dashboard. What does not line up is listed, so the
// stale values can be renamed in ClickUp rather than discovered one missed ticket at a
// time.

import { suggestOption } from "../store/rock-import.js";

const ids = (xs) => [...new Set(xs.filter(Boolean).map(String))];
const bauName = (label) => /\bbau\b|business as usual/i.test(String(label ?? ""));

/**
 * @param {object[]} rocks   rocks shaped by rocksFromSupabase (each with tactics)
 * @param {{rockOptions: {id,label}[], tacticOptions: {id,label}[]}} options
 * @returns {{rocks: object[], names: object}}
 */
export function linkByName(rocks, { rockOptions = [], tacticOptions = [] } = {}) {
  const usedRock = new Set();
  const usedTactic = new Set();

  const linked = (rocks ?? []).map((rock) => {
    const rockMatch = suggestOption(rock.title, rockOptions);
    if (rockMatch) usedRock.add(rockMatch.id);
    const tactics = (rock.tactics ?? []).map((t) => {
      if (t.status === "done") return t;
      const match = suggestOption(t.title, tacticOptions);
      if (match) usedTactic.add(match.id);
      return { ...t, clickupTacticOptionId: match?.id ?? null, tacticMatch: match ?? null };
    });
    const swingIds = ids([...(rockMatch ? [rockMatch.id] : []), ...(rock.clickupBigSwingOptionIds ?? [])]);
    return {
      ...rock,
      tactics,
      rockMatch: rockMatch ?? null,
      clickupBigSwingOptionIds: swingIds,
      clickupBigSwingOptionId: swingIds[0] ?? null,
      clickupTacticOptionIds: ids(tactics.map((t) => t.clickupTacticOptionId)),
    };
  });

  // Options no rock or tactic names: the old values. BAU is expected work, not a rock.
  const stale = (options, used) => options.filter((o) => !used.has(String(o.id)) && !bauName(o.label)).map((o) => ({ id: String(o.id), label: o.label }));
  return {
    rocks: linked,
    names: {
      staleRockOptions: stale(rockOptions, usedRock),
      staleTacticOptions: stale(tacticOptions, usedTactic),
      rocksUnmatched: linked.filter((r) => !r.bau && !r.rockMatch).map((r) => r.title),
      tacticsUnmatched: linked.flatMap((r) => (r.tactics ?? []).filter((t) => t.status !== "done" && !t.tacticMatch).map((t) => ({ rock: r.title, title: t.title }))),
    },
  };
}

export const tacticIdsOf = (item) => (item?.clickupTacticOptionIds ?? []).map(String);

/** Whether a ticket's TACTIC names one of this rock's tactics. */
export function ownsTactic(item, task) {
  const id = task?.leadershipPriority?.optionId;
  return id != null && tacticIdsOf(item).includes(String(id));
}
