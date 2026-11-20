// The kudos page: Alex's page template filled with the ticked wins from Last week's wins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kudosWeek, kudosPage, kudosFileName, mondayOf } from "../public/kudos.js";

const wins = {
  from: new Date(2026, 10, 11, 15).getTime(), // Wednesday
  rocks: [
    { label: "Bundles", tasks: [
      { id: "a1", name: "DEV - Bundle page", url: "https://app.clickup.com/t/a1" },
      { id: "a2", name: "Gift box </script><b>", url: "javascript:alert(1)" },
    ] },
    { label: "Quiz", tasks: [{ id: "q1", name: "Quiz fix", url: "https://app.clickup.com/t/q1" }] },
  ],
};

test("the week: Monday's label, ticket names cleaned, unticked and empty rocks left out, only https links kept", () => {
  assert.equal(mondayOf(wins.from).getDate(), 9);
  const week = kudosWeek(wins, new Set(["q1"]));
  assert.equal(week.id, "2026-11-09");
  assert.equal(week.label, "Week of Nov 9");
  assert.deepEqual(week.rocks, [{ n: "Bundles", c: 0, w: [
    { k: "ta1", t: "Bundle page", u: "https://app.clickup.com/t/a1" },
    { k: "ta2", t: "Gift box </script><b>" },
  ] }]);
  assert.equal(kudosFileName(week), "ecom-kudos-2026-11-09.html");
});

test("the page: the real template filled, nothing left unfilled, a ticket name cannot break out of the script", () => {
  const template = readFileSync(new URL("../public/kudos/template.html", import.meta.url), "utf8");
  const week = kudosWeek(wins);
  const html = kudosPage(template, week, "data:image/png;base64,AAAA");
  assert.match(html, /<title>Ecom Team KUDOS: Week of Nov 9<\/title>/);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
  assert.ok(!/\/\*__WEEK__\*\/null|<title>__TITLE__|src="__MONSTER__"/.test(html));
  assert.equal(html.split("</script>").length - 1, 1, "only the template's own </script>");
  const json = html.match(/var DEFAULT=(.*);\n/)[1];
  assert.deepEqual(JSON.parse(json), week);
  assert.throws(() => kudosPage("<html></html>", week, "x"), /missing/);
});

import { imageAttachments, ticketImage, isClickUpHost, MAX_IMAGE_BYTES } from "../src/send/kudos-image.js";
import { addImages, taskIdOf } from "../public/kudos.js";

const config = { clickup: { apiBase: "https://api.clickup.com/api/v2" } };
const resp = (body, { status = 200, type = "application/json" } = {}) => ({
  ok: status < 300, status, headers: { get: () => type },
  json: async () => body, arrayBuffer: async () => (body instanceof Uint8Array ? body : new Uint8Array()).buffer,
});

test("ticket images: newest image only, ClickUp hosts only, deleted and non-images skipped", () => {
  const task = { attachments: [
    { title: "spec.pdf", extension: "pdf", url: "https://t1.p.clickup-attachments.com/a.pdf", date: "9" },
    { title: "old.png", extension: "png", url: "https://t1.p.clickup-attachments.com/old.png", date: "1" },
    { title: "new.jpg", extension: "jpg", url: "https://t1.p.clickup-attachments.com/new.jpg", date: "5" },
    { title: "gone.png", extension: "png", url: "https://t1.p.clickup-attachments.com/g.png", date: "8", deleted: true },
    { title: "evil.png", extension: "png", url: "https://evil.example/x.png", date: "7" },
  ] };
  assert.deepEqual(imageAttachments(task).map((a) => a.title), ["new.jpg", "old.png"]);
  assert.equal(isClickUpHost("https://attachments.clickup.com/x"), true);
  assert.equal(isClickUpHost("https://clickup.com.evil.io/x"), false);
  assert.equal(isClickUpHost("http://attachments.clickup.com/x"), false);
});

test("ticket image: tries without the token, then with it; too big falls back to the thumbnail; none gives null", async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push([url, Boolean(opts?.headers?.authorization)]);
    if (url.endsWith("/task/abc")) return resp({ attachments: [{ title: "s.png", extension: "png", url: "https://t.p.clickup-attachments.com/big.png", thumbnail_large: "https://t.p.clickup-attachments.com/thumb.png", date: "2" }] });
    if (url.endsWith("big.png")) return resp(new Uint8Array(MAX_IMAGE_BYTES + 1), { type: "image/png" });
    if (url.endsWith("thumb.png")) return opts.headers.authorization ? resp(png, { type: "image/png" }) : resp(null, { status: 403, type: "text/html" });
    if (url.endsWith("/task/none")) return resp({ attachments: [] });
    throw new Error("unexpected " + url);
  };
  const got = await ticketImage({ taskId: "abc", config, token: "pk_1", fetchImpl });
  assert.equal(got.type, "image/png");
  assert.deepEqual([...got.bytes], [...png]);
  assert.deepEqual(calls.slice(-2), [["https://t.p.clickup-attachments.com/thumb.png", false], ["https://t.p.clickup-attachments.com/thumb.png", true]]);
  assert.equal(await ticketImage({ taskId: "none", config, token: "pk_1", fetchImpl }), null);
  await assert.rejects(ticketImage({ taskId: "../x", config, token: "pk_1", fetchImpl }), /Bad ticket id/);
});

test("images go into the week only as image data URLs, and the page carries them", () => {
  const week = kudosWeek(wins);
  assert.equal(taskIdOf("ta1"), "a1");
  const n = addImages(week, new Map([["ta1", "data:image/png;base64,iVBORw0KGgo="], ["ta2", "javascript:alert(1)"]]));
  assert.equal(n, 1);
  assert.equal(week.rocks[0].w[0].i, "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(week.rocks[0].w[1].i, undefined);
  const template = readFileSync(new URL("../public/kudos/template.html", import.meta.url), "utf8");
  assert.match(kudosPage(template, week, "x"), /"i":"data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(template, /seedShots\[x\.k\]=x\.i/);
});

test("BAU always sits in the last column: its column swaps with column 3", async () => {
  const { placeColumns } = await import("../public/kudos.js");
  const w = (n) => Array.from({ length: n }, (_, i) => ({ k: `k${i}`, t: "x" }));
  const rocks = placeColumns([{ n: "BAU", w: w(8) }, { n: "New Products", w: w(7) }, { n: "Bundles", w: w(4) }, { n: "Quiz", w: w(1) }]);
  assert.deepEqual(rocks.map((r) => [r.n, r.c]), [["BAU", 2], ["New Products", 1], ["Bundles", 0], ["Quiz", 0]]);
  const none = placeColumns([{ n: "Bundles", w: w(3) }, { n: "Quiz", w: w(1) }]);
  assert.deepEqual(none.map((r) => r.c), [0, 1]);
});
