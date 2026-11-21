// The wins report, for a PDF. Alex, 2026-11-21: "the kudos page will be presented and the PDF
// can be more of a report PDF". Every win with its image printed under it (no hover on paper),
// who did it, when it was done and its ClickUp link, by rock, then kudos by person. Opened in a
// tab that starts the browser's Save as PDF, so text stays selectable and links clickable.
// Nothing on it is written by a model: ticket names, rock names and names from ClickUp.

import { cleanName, doneDate, kudosLine } from "./update-text.js";
import { winKeyOf } from "./kudos.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const day = (ms) => (ms ? new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The report page. `wins` as buildThisWeekWins / buildLastWeekWins give it; `excluded` the
 * unticked ticket ids; `images` a Map of win key → data URL; `handleFor` names an assignee.
 */
export function reportHtml(wins, { excluded = new Set(), images = new Map(), handleFor = (u) => u.username ?? String(u.id), title, weekLabel, pulledAt } = {}) {
  const keep = (t) => !excluded.has(String(t.id));
  const rocks = wins.rocks.map((r) => ({ ...r, tasks: r.tasks.filter(keep) })).filter((r) => r.tasks.length);
  const n = rocks.reduce((sum, r) => sum + r.tasks.length, 0);
  const people = new Set(rocks.flatMap((r) => r.tasks.flatMap((t) => (t.assignees ?? []).map(handleFor))));
  const kudos = wins.kudos.map((p) => kudosLine(p, excluded)).filter(Boolean);

  const win = (t) => {
    const img = images.get(winKeyOf(t.id));
    const who = (t.assignees ?? []).map(handleFor).join(", ");
    const name = esc(cleanName(t.plainName ?? t.name));
    const url = /^https:\/\//.test(String(t.url ?? "")) ? t.url : null;
    return `<article class="win">
      ${typeof img === "string" && IMG.test(img) ? `<div class="shot"><img src="${img}" alt=""></div>` : ""}
      <h3>${url ? `<a href="${esc(url)}">${name}</a>` : name}</h3>
      <p class="meta">${[who, day(doneDate(t)) && `done ${day(doneDate(t))}`].filter(Boolean).map(esc).join(" · ")}${url ? ` · <a href="${esc(url)}">ClickUp ↗</a>` : ""}</p>
    </article>`;
  };

  const heading = `${title}: ${weekLabel}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`Ecom Team wins report: ${weekLabel}`)}</title>
<style>
  @page{size:letter;margin:14mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Nunito Sans',Arial,sans-serif;color:#13261c;background:#fff;font-size:11pt;line-height:1.4;padding:24px;max-width:960px;margin:0 auto}
  .bar{display:flex;gap:12px;align-items:center;margin-bottom:20px;padding:10px 14px;background:#fff8ec;border:1px solid #f2b84b;border-radius:10px;font-size:10pt}
  .bar button{font:inherit;font-weight:700;background:#0f4a33;color:#fff;border:0;border-radius:999px;padding:8px 16px;cursor:pointer}
  header{border-bottom:3px solid #f2b84b;padding-bottom:12px;margin-bottom:16px}
  .eyebrow{font-size:9pt;font-weight:700;letter-spacing:.08em;color:#3d6b55}
  h1{font-size:22pt;color:#0f4a33;margin-top:2px}
  .sub{color:#3d6b55;margin-top:4px}
  .summary{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 18px;padding:0;list-style:none;font-size:10pt}
  .summary b{color:#0f4a33}
  section.rock{margin-bottom:18px}
  h2{font-size:14pt;color:#0f4a33;border-left:5px solid #f2b84b;padding-left:8px;margin-bottom:8px;break-after:avoid}
  h2 .meta{font-size:9.5pt;font-weight:400}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start}
  .win{border:1px solid #d9e3dc;border-radius:8px;padding:10px;break-inside:avoid}
  .shot{background:#f3f6f4;border-radius:6px;margin-bottom:8px;text-align:center}
  .shot img{max-width:100%;max-height:200px;object-fit:contain;display:inline-block;vertical-align:middle}
  h3{font-size:11pt}
  a{color:#0f4a33}
  .meta{color:#5b7466;font-size:9pt;margin-top:2px}
  .kudos{list-style:none;break-inside:avoid}
  .kudos li{padding:4px 0;border-bottom:1px solid #eef2ef}
  @media print{body{padding:0;max-width:none}.bar{display:none}}
  @media (max-width:640px){body{padding:16px}.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="bar"><button type="button" onclick="print()">Save as PDF</button><span>In the print window, choose <b>Save as PDF</b> as the destination.</span></div>
<header>
  <p class="eyebrow">ECOM TEAM · WINS REPORT</p>
  <h1>${esc(heading)}</h1>
  <p class="sub">${esc(`${plural(n, "win", "wins")} across ${plural(rocks.length, "rock", "rocks")}, from ${plural(people.size, "person", "people")}. From ClickUp${pulledAt ? `, as pulled ${new Date(pulledAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}` : ""}.`)}</p>
</header>
<ul class="summary">${rocks.map((r) => `<li><b>${esc(r.label)}</b> ${esc(r.tasks.length)}</li>`).join("")}</ul>
${rocks
  .map(
    (r) => `<section class="rock">
  <h2>${esc(r.label)} <span class="meta">${esc(plural(r.tasks.length, "win", "wins"))}</span></h2>
  <div class="grid">${r.tasks.map(win).join("")}</div>
</section>`,
  )
  .join("")}
${kudos.length ? `<section class="rock"><h2>Kudos</h2><ul class="kudos">${kudos.map((k) => `<li>${esc(k)}</li>`).join("")}</ul></section>` : ""}
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script>
</body></html>`;
}
