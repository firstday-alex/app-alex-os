// The kudos repository: photos on wins, and saved, named versions of the kudos page.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as repo from "../src/store/kudos-repo.js";

const memory = () => {
  const m = new Map();
  return { get: async (k) => structuredClone(m.get(k) ?? null), set: async (k, v) => void m.set(k, structuredClone(v)), keys: () => [...m.keys()] };
};
const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("a photo is stored, read back as bytes, and put on (and taken off) a win for a week", async () => {
  const b = memory();
  const id = await repo.addPhoto(b, PNG);
  const p = await repo.getPhoto(b, id);
  assert.equal(p.type, "image/png");
  assert.ok(p.bytes.length > 0);
  assert.deepEqual(await repo.setWeekPhoto(b, { weekId: "2026-11-16", key: "tabc", photoId: id }), { tabc: id });
  assert.deepEqual(await repo.setWeekPhoto(b, { weekId: "2026-11-16", key: "tabc", photoId: null }), {});
  assert.ok(await repo.getPhoto(b, id), "the photo itself stays, for saved versions");
});

test("only images, real week and win keys", async () => {
  const b = memory();
  await assert.rejects(repo.addPhoto(b, "data:text/html;base64,PHNjcmlwdD4="), repo.KudosError);
  await assert.rejects(repo.setWeekPhoto(b, { weekId: "../x", key: "tabc", photoId: null }), repo.KudosError);
  await assert.rejects(repo.setWeekPhoto(b, { weekId: "2026-11-16", key: "<b>", photoId: null }), repo.KudosError);
});

test("a version is saved with its name, cleaned (photo refs only, https links only), listed newest first, renamed and removed", async () => {
  const b = memory();
  const id = await repo.addPhoto(b, PNG);
  const week = { id: "2026-11-09", label: "Week of Nov 9", rocks: [{ n: "Bundles", c: 1, w: [{ k: "ta1", t: "Gift box", u: "javascript:alert(1)", i: `photo:${id}` }, { k: "ta2", t: "Quiz", u: "https://app.clickup.com/t/a2", i: "data:image/png;base64,AAAA" }] }] };
  const one = await repo.saveVersion(b, { name: "Final for Drew", kind: "lastweek", week, now: new Date("2026-11-20T10:00:00Z") });
  await repo.saveVersion(b, { name: "", kind: "lastweek", week, now: new Date("2026-11-21T10:00:00Z") });
  assert.equal(one.wins, 2);
  assert.equal(one.photos, 1);
  const saved = await repo.getVersion(b, one.id);
  assert.equal(saved.week.rocks[0].w[0].u, undefined);
  assert.equal(saved.week.rocks[0].w[1].i, undefined);
  const list = await repo.listVersions(b);
  assert.deepEqual(list.map((v) => v.name), ["Week of Nov 9", "Final for Drew"]);
  await repo.renameVersion(b, { id: one.id, name: "Final v2" });
  assert.equal((await repo.getVersion(b, one.id)).name, "Final v2");
  assert.equal(await repo.removeVersion(b, { id: one.id }), true);
  assert.equal((await repo.listVersions(b)).length, 1);
});

test("a win can be starred for a week, and a saved version keeps its star", async () => {
  const b = memory();
  assert.deepEqual(await repo.setWeekStar(b, { weekId: "2026-11-23", key: "tabc", star: true }), { tabc: true });
  assert.deepEqual(await repo.weekStars(b, "2026-11-23"), { tabc: true });
  assert.deepEqual(await repo.setWeekStar(b, { weekId: "2026-11-23", key: "tabc", star: false }), {});
  await assert.rejects(repo.setWeekStar(b, { weekId: "2026-11-23", key: "<b>", star: true }), repo.KudosError);
  const clean = repo.cleanWeek({ id: "2026-11-23", rocks: [{ n: "Rock", w: [{ k: "ta", t: "Starred", s: 1 }, { k: "tb", t: "Plain" }] }] });
  assert.equal(clean.rocks[0].w[0].s, 1);
  assert.equal(clean.rocks[0].w[1].s, undefined);
});
