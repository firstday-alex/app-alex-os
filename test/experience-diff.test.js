// What is different between control and variant.
//
// A number is unreadable without this. These tests use the real variation configuration
// of "[Broad-KDE-TDK-PDPS] Old vs New PDP", captured live: three product pages, control
// left alone, variant served with a template query parameter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeExperience, describeVariation, testTypeLabels } from "../src/collectors/experience-diff.js";

const PDP = ["kids-enrichment-vitamin", "teens-kickstart-vitamin", "the-no-junk-toddlers-multivitamin"];
const url = (slug) => `https://firstday.com/products/${slug}`;

const REAL = {
  description: "",
  testTypes: { hasTestContentUrl: true, hasTestPricing: false },
  previewPath: url("the-no-junk-toddlers-multivitamin"),
  audience: { filters: [] },
  variations: [
    {
      id: "b5", name: "Old", isControl: true, percentage: 50,
      redirects: PDP.map((s) => ({ originUrl: url(s), destinationUrl: null, skip: true, queryParams: [] })),
    },
    {
      id: "f4", name: "New", isControl: false, percentage: 50,
      redirects: PDP.map((s) => ({ originUrl: url(s), destinationUrl: url(s), skip: false, queryParams: [{ key: "view", value: "uniified-default-v2" }] })),
    },
  ],
};

test("the test type is read from Intelligems' own flags", () => {
  assert.deepEqual(testTypeLabels({ hasTestContentUrl: true }), ["URL / template swap"]);
  assert.deepEqual(testTypeLabels({ hasTestPricing: true, hasTestShipping: true }), ["Price test", "Shipping test"]);
  assert.deepEqual(testTypeLabels(null), []);
});

test("a control that skips every redirect is described as the unchanged baseline", () => {
  const control = describeVariation(REAL.variations[0]);
  assert.equal(control.isControl, true);
  assert.equal(control.unchanged, true, "skip:true on every rule means it sees the site as it is");
  assert.equal(control.changes.length, 3);
  assert.match(control.changes[0].text, /left as it is/);
});

test("a redirect to the SAME url with added params is a template swap, not a redirect", () => {
  // Calling this a redirect makes the test sound like something it is not.
  const variant = describeVariation(REAL.variations[1]);
  assert.equal(variant.unchanged, false);
  assert.match(variant.changes[0].text, /served with \?view=uniified-default-v2/);
  assert.ok(!variant.changes[0].text.includes("→"), "no arrow: the destination is the same page");
  assert.match(variant.changes[0].url, /view=uniified-default-v2/, "the link opens the variant a human can look at");
});

test("a genuine redirect to a different url keeps the arrow", () => {
  const v = describeVariation({
    name: "Elsewhere", redirects: [{ originUrl: url("a"), destinationUrl: "https://firstday.com/pages/sale", skip: false, queryParams: [] }],
  });
  assert.match(v.changes[0].text, /\/products\/a → \/pages\/sale/);
});

test("price, injection, offer and checkout changes are all described", () => {
  const v = describeVariation({
    name: "Kitchen sink",
    priceChange: -10, priceChangeUnit: "percent",
    onsiteInjections: { customJs: "document.body.classList.add('x');", customCss: ".buy-box{color:red}" },
    offer: { name: "GWP" },
    checkoutBlocks: [{ name: "Upsell block" }],
    shippingRateGroups: [{ name: "Free over $60" }],
  });
  const kinds = v.changes.map((c) => c.kind);
  for (const kind of ["price", "js", "css", "offer", "checkout", "shipping"]) {
    assert.ok(kinds.includes(kind), `${kind} should be described`);
  }
  assert.match(v.changes.find((c) => c.kind === "price").text, /Price -10%/);
});

test("a long injection is truncated rather than flooding the card", () => {
  const v = describeVariation({ name: "x", onsiteInjections: { customJs: "a".repeat(500) } });
  assert.ok(v.changes[0].text.length < 200);
  assert.match(v.changes[0].text, /…$/);
});

test("an empty description is reported as missing, and a derived summary stands in", () => {
  const d = describeExperience(REAL);
  assert.equal(d.description, null);
  assert.equal(d.descriptionMissing, true, "every test in this account is in this state");
  assert.match(d.summary, /uniified-default-v2/, "the mechanism is described even though nobody wrote it down");
  assert.deepEqual(d.types, ["URL / template swap"]);
});

test("a written description wins over the derived one", () => {
  const d = describeExperience({ ...REAL, description: "  Testing the unified PDP template against the current one.  " });
  assert.equal(d.description, "Testing the unified PDP template against the current one.");
  assert.equal(d.descriptionMissing, false);
  assert.equal(d.summary, d.description, "a human sentence beats a machine one");
});

test("control and variants are separated, so the difference reads as a comparison", () => {
  const d = describeExperience(REAL);
  assert.equal(d.control.name, "Old");
  assert.equal(d.variants.length, 1);
  assert.equal(d.variants[0].name, "New");
});

/* ------------------------------ cache validity ------------------------------ */

test("an experience detail with no variations is not usable, however truthy it is", async () => {
  // `if (!detail)` passes on {}, which is what a partial or wrapped response leaves
  // behind — and then the test type, the key metrics and the whole difference view
  // silently read empty for a week, because the cache happily served it.
  const usable = (d) => Boolean(d && Array.isArray(d.variations) && d.variations.length > 0);

  assert.equal(usable({}), false, "the exact value that slipped through");
  assert.equal(usable({ variations: [] }), false);
  assert.equal(usable(null), false);
  assert.equal(usable({ variations: [{ id: "a" }] }), true);
});

test("describeExperience degrades honestly on a thin object rather than inventing", () => {
  const d = describeExperience({});
  assert.deepEqual(d.types, []);
  assert.equal(d.control, null);
  assert.deepEqual(d.variants, []);
  assert.equal(d.summary, null);
  assert.equal(d.descriptionMissing, true);
});
