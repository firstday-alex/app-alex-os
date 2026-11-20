// Groups starred wins by the week or the month the work was completed, newest first;
// within a group A+ first, then A, then A-, then newest. Pure, so it is tested in node.

import { mondayOf } from "./kudos.js";

const RANK = { "A+": 0, A: 1, "A-": 2 };
const pad = (n) => String(n).padStart(2, "0");

/** @returns {{ id, label, items }[]} */
export function groupStarred(items, by = "week") {
  const groups = new Map();
  for (const it of items) {
    const d = new Date(it.completedAt ?? it.starredAt);
    if (Number.isNaN(d.getTime())) continue;
    let id, label;
    if (by === "month") {
      id = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      label = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    } else {
      const m = mondayOf(d.getTime());
      id = `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
      label = `Week of ${m.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    }
    if (!groups.has(id)) groups.set(id, { id, label, items: [] });
    groups.get(id).items.push(it);
  }
  const when = (it) => String(it.completedAt ?? it.starredAt ?? "");
  for (const g of groups.values()) g.items.sort((a, b) => (RANK[a.grade] ?? 9) - (RANK[b.grade] ?? 9) || when(b).localeCompare(when(a)));
  return [...groups.values()].sort((a, b) => b.id.localeCompare(a.id));
}
