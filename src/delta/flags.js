// The flag is the unit of attention. Everything the readout asks Alex to look at is one.
//
// Every flag records the rule that raised it and the values that tripped it, so that
// "why did this get flagged" is answered from the log, not reconstructed.

/** Severity drives ordering in the readout. Layer 1 is always checked first. */
export const SEVERITY = { p1: 0, attention: 1, prompt: 2, info: 3 };

/**
 * @param {object} spec
 * @param {1|2|3|'cross'} spec.layer
 * @param {string} spec.rule            dotted rule id, e.g. "clickup.stalled"
 * @param {'p1'|'attention'|'prompt'|'info'} spec.severity
 * @param {{type:string,id:string,label:string,url?:string}} spec.subject
 * @param {string} spec.message         one plain sentence, no hedging
 * @param {object} [spec.values]        the numbers that tripped the rule
 * @param {boolean} [spec.advisable]    show the "Ask for recommendation" button
 */
export function makeFlag(spec, { dateKey } = {}) {
  const subjectId = spec.subject?.id ?? "none";
  return {
    id: `${dateKey ?? "nodate"}:${spec.rule}:${subjectId}`,
    layer: spec.layer,
    rule: spec.rule,
    severity: spec.severity,
    subject: spec.subject,
    message: spec.message,
    values: spec.values ?? {},
    advisable: spec.advisable !== false,
    raisedAt: dateKey ?? null,
  };
}

export function sortFlags(flags) {
  return [...flags].sort((a, b) => {
    const layerRank = (f) => (f.layer === 1 ? 0 : f.layer === "cross" ? 1 : f.layer === 3 ? 2 : 3);
    return (
      layerRank(a) - layerRank(b) ||
      (SEVERITY[a.severity] ?? 9) - (SEVERITY[b.severity] ?? 9) ||
      String(a.rule).localeCompare(String(b.rule)) ||
      String(a.subject?.label ?? "").localeCompare(String(b.subject?.label ?? ""))
    );
  });
}

/** Logs every flag with its rule and values. Called once, centrally, so none is missed. */
export function logFlags(flags, logger) {
  for (const flag of flags) logger?.flag?.(flag);
  return flags;
}
