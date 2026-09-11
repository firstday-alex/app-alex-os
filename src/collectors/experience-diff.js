// What is actually different between control and variant.
//
// A number without this is unreadable. "RPV down 1.6%" means nothing until you know the
// variant was a different PDP template; then the four strongly-down funnel steps become a
// story about a layout, and the test becomes a lesson rather than a result.
//
// Two sources, in order of trust:
//
//   1. The `description` field on the experience, written by a human. Best, and empty on
//      every test in this account today.
//   2. The variation configuration itself, which is machine-readable and always present.
//      Redirects, onsite edits, injected CSS/JS, price changes, offers, checkout blocks.
//
// The second is what makes this useful immediately: it describes the mechanism without
// anyone having written a word.

/** The kind of test, from Intelligems' own flags, in the order worth reading. */
const TEST_TYPE_LABELS = [
  ["hasTestPricing", "Price test"],
  ["hasTestShipping", "Shipping test"],
  ["hasTestContentUrl", "URL / template swap"],
  ["hasTestContentTheme", "Theme test"],
  ["hasTestContentTemplate", "Template test"],
  ["hasTestContentOnsite", "Onsite content edit"],
  ["hasTestContentAdvanced", "Advanced content"],
  ["hasTestOnsiteInjections", "Injected CSS/JS"],
  ["hasTestCheckoutBlocks", "Checkout block"],
  ["hasTestPostPurchase", "Post-purchase offer"],
  ["hasTestOnsiteUpsell", "Onsite upsell"],
  ["hasTestCampaign", "Campaign test"],
  ["hasTestContent", "Content test"],
];

export function testTypeLabels(testTypes) {
  if (!testTypes) return [];
  return TEST_TYPE_LABELS.filter(([key]) => testTypes[key]).map(([, label]) => label);
}

function shortUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url);
  }
}

/**
 * Describe one variation's configuration in plain language.
 *
 * Deliberately factual. It reports what the variation DOES, never whether that is a good
 * idea: the moment this starts editorialising it stops being a reliable description of
 * the mechanism.
 */
export function describeVariation(variation) {
  const changes = [];

  for (const redirect of variation?.redirects ?? []) {
    const from = shortUrl(redirect.originUrl);
    if (redirect.skip || !redirect.destinationUrl) {
      changes.push({ kind: "redirect", text: `${from} — left as it is`, url: redirect.originUrl });
      continue;
    }
    const params = (redirect.queryParams ?? []).map((p) => `${p.key}=${p.value}`).join("&");
    const to = shortUrl(redirect.destinationUrl);
    const sameTarget = redirect.originUrl === redirect.destinationUrl;
    changes.push({
      kind: "redirect",
      // Same URL with added params is a template swap, not a redirect, and calling it a
      // redirect makes the test sound like something it is not.
      text: sameTarget && params ? `${from} — served with ?${params}` : `${from} → ${to}${params ? `?${params}` : ""}`,
      url: redirect.destinationUrl + (params ? `${redirect.destinationUrl.includes("?") ? "&" : "?"}${params}` : ""),
    });
  }

  for (const edit of variation?.onsiteEdits ?? []) {
    changes.push({ kind: "edit", text: `Onsite edit: ${edit.selector ?? edit.name ?? "element"}${edit.action ? ` (${edit.action})` : ""}` });
  }

  const injections = variation?.onsiteInjections;
  if (injections?.customJs) {
    const js = String(injections.customJs).trim();
    changes.push({ kind: "js", text: `Injected JS: ${js.length > 120 ? `${js.slice(0, 120)}…` : js}` });
  }
  if (injections?.customCss) {
    const css = String(injections.customCss).trim();
    changes.push({ kind: "css", text: `Injected CSS: ${css.length > 120 ? `${css.slice(0, 120)}…` : css}` });
  }

  if (variation?.priceChange != null) {
    const unit = variation.priceChangeUnit === "percent" ? "%" : "";
    const sign = variation.priceChange > 0 ? "+" : "";
    changes.push({ kind: "price", text: `Price ${sign}${variation.priceChange}${unit}` });
  }

  if (variation?.offer) {
    changes.push({ kind: "offer", text: `Offer: ${variation.offer.name ?? variation.offer.type ?? "configured"}` });
  }

  for (const group of variation?.shippingRateGroups ?? []) {
    changes.push({ kind: "shipping", text: `Shipping rates: ${group.name ?? "changed"}` });
  }

  for (const block of variation?.checkoutBlocks ?? []) {
    changes.push({ kind: "checkout", text: `Checkout block: ${block.name ?? block.type ?? "configured"}` });
  }

  return {
    id: variation?.id ?? null,
    name: variation?.name ?? null,
    isControl: Boolean(variation?.isControl),
    percentage: variation?.percentage ?? null,
    changes,
    // A variation with no configuration at all is the baseline, and saying "unchanged"
    // is more useful than showing nothing.
    unchanged: changes.length === 0 || changes.every((c) => c.kind === "redirect" && c.text.endsWith("left as it is")),
  };
}

/**
 * The whole picture: type, human description, per-variation mechanics, preview link.
 *
 * @param {object} detail the experience object from GET /experiences/{id}
 */
export function describeExperience(detail) {
  if (!detail) return null;

  const variations = (detail.variations ?? []).map(describeVariation);
  const control = variations.find((v) => v.isControl) ?? null;
  const variants = variations.filter((v) => !v.isControl);
  const description = String(detail.description ?? "").trim();

  return {
    description: description || null,
    // Every test in this account has an empty description. Saying so, with the id, is
    // more actionable than leaving a blank space.
    descriptionMissing: !description,
    types: testTypeLabels(detail.testTypes),
    previewPath: detail.previewPath ?? null,
    audience: detail.audience?.filters?.length ? "targeted" : "all visitors",
    control,
    variants,
    // One line for a collapsed row: what the variant does that the control does not.
    summary: (() => {
      if (description) return description;
      const first = variants[0];
      if (!first || first.changes.length === 0) return null;
      const kinds = [...new Set(first.changes.map((c) => c.kind))];
      const lead = first.changes[0].text;
      return first.changes.length > 1 ? `${lead}, and ${first.changes.length - 1} more ${kinds.join("/")} change(s)` : lead;
    })(),
  };
}
