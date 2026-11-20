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
  assert.deepEqual(week.rocks, [{ n: "Bundles", w: [
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
