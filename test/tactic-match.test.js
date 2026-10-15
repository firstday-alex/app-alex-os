// Standup tactics against the sprint. What matters: tactics are read off the page as the
// team wrote them, a ticket that is one piece of a tactic still matches, a single shared
// word does not, and both leftover lists say what is missing on each side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStandupTactics, matchTacticsToTickets, tacticTicketScore } from "../src/store/tactic-match.js";

// Shaped like a tactic block on the standup's Submit update page.
const tactic = ({ title, owner = "", status = "on_track", rockId, rockText }) => `<div class="priority-item">
      <button class="remove" title="Remove">✕</button>
      <div class="row"><div style="flex:2;"><label>Tactic</label>
          <input type="text" data-f="title" value="${title}" placeholder="e.g. Get Meta to $100K/day spend"></div>
        <div><label>Tactic owner</label>
          <input type="text" data-f="owner" maxlength="200" list="tactic-owner-names" value="${owner}" placeholder="Who's driving it"></div>
        <div><label>Status</label><select data-f="status">
            <option value="on_track"${status === "on_track" ? ' selected=""' : ""}>On track</option>
            <option value="at_risk"${status === "at_risk" ? ' selected=""' : ""}>At risk</option>
          </select></div></div>
      <div class="row"><div style="flex:2;"><label>KPI</label><input type="text" data-f="kpi" value="+2% CVR"></div></div>
      <div class="row rock-pick-row"><select data-rock="" aria-label="Rock this priority ladders up to"><option value="">— choose a rock —</option>
        <optgroup label="Web's rocks"><option value="r0">Other rock · 2026-Q4</option><option value="${rockId}" selected="">${rockText}</option></optgroup></select></div>
    </div>`;

const PAGE = `<html><body><div id="priority-rows">
  ${tactic({ title: "Family Bundle Builder", owner: "Cristobal Alanis", rockId: "r1", rockText: "Bundles 3.0 · 2026-Q4" })}
  ${tactic({ title: "OTP Discount Reduction &lt;-- 0% Off", owner: "Blake Tucker", status: "at_risk", rockId: "r2", rockText: "Subs &amp; Payback · 2026-Q4" })}
  ${tactic({ title: "📱 Mobile App ", rockId: "bau", rockText: "Business as usual (Web)" })}
  </div>
  <div class="priority-item parking-row-item"><span class="parking-note">A parking lot note</span></div>
</body></html>`;

test("tactics are read off the page with owner, status and the rock they ladder up to", () => {
  const tactics = parseStandupTactics(PAGE);
  assert.deepEqual(tactics.map((t) => t.title), ["Family Bundle Builder", "OTP Discount Reduction <-- 0% Off", "📱 Mobile App"]);
  assert.deepEqual(tactics[0], {
    title: "Family Bundle Builder", owner: "Cristobal Alanis", status: "on_track", kpi: "+2% CVR",
    rockStandupId: "r1", rockTitle: "Bundles 3.0", isBau: false,
  });
  assert.equal(tactics[1].status, "at_risk");
  assert.equal(tactics[1].rockTitle, "Subs & Payback");
  assert.equal(tactics[2].owner, null, "a blank owner is no owner, not an empty string");
  assert.equal(tactics[2].isBau, true);
});

test("a ticket that is one piece of a tactic matches; one shared word does not", () => {
  assert.ok(tacticTicketScore("Family Bundle Builder", "[Test] Family Bundle Builder V2") >= 0.8);
  assert.ok(tacticTicketScore("📱 Mobile App", "Mobile app MVP scoping") >= 0.8);
  assert.ok(tacticTicketScore("Mobile App", "Fix app crash on checkout") < 0.5);
});

test("both leftover lists come out, and finished tickets match but are never listed as drift", () => {
  const tactics = parseStandupTactics(PAGE);
  const tasks = [
    { id: "1", name: "Family Bundle Builder V2 test", url: "u1", status: "in progress", bucket: "inProgress", assignees: [{ username: "Cristobal Alanis" }] },
    { id: "2", name: "Mobile app MVP scoping", url: "u2", status: "complete", bucket: "done", closed: true },
    { id: "3", name: "Homepage star ratings on PLP", url: "u3", status: "to do", bucket: "notStarted", taskOwners: [{ username: "Akky" }], bigSwing: { label: "CRO" } },
    { id: "4", name: "Old cleanup", url: "u4", status: "complete", bucket: "done", closed: true },
  ];
  const result = matchTacticsToTickets({ tactics, tasks });

  assert.deepEqual(result.matched.map((m) => [m.tactic.title, m.tickets.map((k) => k.id)]), [
    ["Family Bundle Builder", ["1"]],
    ["📱 Mobile App", ["2"]],
  ]);
  assert.equal(result.matched[0].tickets[0].sameOwner, true);
  assert.deepEqual(result.tacticsWithoutTicket.map((t) => t.title), ["OTP Discount Reduction <-- 0% Off"]);
  assert.deepEqual(result.ticketsWithoutTactic.map((t) => [t.id, t.owners, t.bigSwing]), [["3", ["Akky"], "CRO"]]);
});
