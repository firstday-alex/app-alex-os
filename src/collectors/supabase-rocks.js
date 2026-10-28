// Layer 1's source of truth: the rocks and tactics in the marketing standup's Supabase
// project.
//
// READ ONLY, always. This module is the only code that talks to Supabase, and the one
// request it can make is a GET through `select` below. There is no insert, update,
// upsert, delete or rpc anywhere, and test/supabase-rocks.test.js fails if one appears.
// The key is the project's service_role key, because the tables only show rows to
// signed-in users; it could write, so the guarantee lives here, in code, instead.
//
// What is read, for one team (config system.supabase.team):
//   sub_functions        the team's id
//   rocks                the team's rocks this quarter
//   rock_latest_status   each rock's latest green / amber / red check-in
//   rock_milestones      each rock's monthly deliverables
//   priorities_effective the team's tactics, with the rock each ladders up to
//
// Shaping those into the queue items the Layer 1 rules read is rocksFromSupabase, which
// also overlays what only this app holds: who owns each one in ClickUp terms, and the
// Big Swing option tickets reach it through (src/store/rock-links.js).

import { httpJson } from "../lib/http.js";
import { zonedParts } from "../lib/time.js";
import { resolveOwner } from "./leadership.js";

/** The only verb this module uses. Anything else is refused before a request is made. */
const READ_METHOD = "GET";

/** Supabase's traffic light, in the dashboard's two health states. */
const STATUS_FROM_COLOR = { green: "on_track", amber: "at_risk", red: "at_risk" };

export class SupabaseUnavailable extends Error {}

/** A GET of one table or view through PostgREST. `query` is the URL query string. */
export async function select(table, query, { config, env = process.env, logger, fetchImpl }) {
  const sb = config.system.supabase ?? {};
  const key = env.SUPABASE_SERVICE_KEY;
  if (!sb.url) throw new SupabaseUnavailable("No Supabase project is configured (system.supabase.url).");
  if (!key) throw new SupabaseUnavailable("SUPABASE_SERVICE_KEY is not set.");
  const http = config.system.http ?? {};
  const headers = { apikey: key };
  // A legacy JWT key goes in Authorization too. The newer sb_secret_ keys only take apikey.
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  const { body } = await httpJson(`${sb.url.replace(/\/+$/, "")}/rest/v1/${table}?${query}`, {
    method: READ_METHOD,
    headers,
    logger,
    label: `supabase.${table}`,
    fetchImpl,
    timeoutMs: http.timeoutMs,
    maxAttempts: http.maxAttempts,
    backoffMsSchedule: http.backoffMsSchedule,
  });
  if (!Array.isArray(body)) throw new SupabaseUnavailable(`Supabase answered ${table} with something other than rows.`);
  return body;
}

/** "2026-Q4" for a date, in the readout's timezone. */
export function quarterOf(now, timeZone) {
  const { dateKey } = zonedParts(now, timeZone);
  const [year, month] = dateKey.split("-").map(Number);
  return `${year}-Q${Math.ceil(month / 3)}`;
}

/** The first and last month of a quarter, as YYYY-MM. */
export function quarterMonths(quarter) {
  const m = String(quarter ?? "").match(/^(\d{4})-Q([1-4])$/);
  if (!m) return { first: null, last: null };
  const pad = (n) => String(n).padStart(2, "0");
  const q = Number(m[2]);
  return { first: `${m[1]}-${pad(q * 3 - 2)}`, last: `${m[1]}-${pad(q * 3)}` };
}

const inList = (ids) => `in.(${ids.map(encodeURIComponent).join(",")})`;
const trim = (s) => (s == null ? null : String(s).trim() || null);

/**
 * The team's rocks for the current quarter, each with its latest status, its monthly
 * milestones and its tactics. Falls back to the latest quarter the team has rocks for,
 * so the first days of a quarter, before the new rocks are entered, still show something.
 */
export async function fetchSupabaseRocks({ config, env = process.env, logger, fetchImpl, now = new Date() }) {
  const ctx = { config, env, logger, fetchImpl };
  const teamName = config.system.supabase?.team;
  if (!teamName) throw new SupabaseUnavailable("No Supabase team is configured (system.supabase.team).");

  const [team] = await select("sub_functions", `select=id,name,owners&name=eq.${encodeURIComponent(teamName)}`, ctx);
  if (!team) throw new SupabaseUnavailable(`Supabase has no team called "${teamName}".`);

  const all = await select(
    "rocks",
    `select=id,title,quarter,definition_of_done,is_bau,created_at&owner_sub_function_id=eq.${team.id}&archived_at=is.null&order=created_at`,
    ctx,
  );
  const current = quarterOf(now, config.system.timezone);
  const quarters = [...new Set(all.map((r) => r.quarter).filter(Boolean))].sort();
  const quarter = quarters.includes(current) ? current : quarters.at(-1) ?? current;
  const rocks = all.filter((r) => r.quarter === quarter);
  const ids = rocks.map((r) => r.id);

  const [statuses, milestones, tactics] = ids.length
    ? await Promise.all([
        select("rock_latest_status", `select=rock_id,entry_date,status,reason,action_plan,note,submitted_by&rock_id=${inList(ids)}`, ctx),
        select(
          "rock_milestones",
          `select=id,rock_id,month,deliverable,done_at,blocker,sort_order&rock_id=${inList(ids)}&archived_at=is.null&order=month,sort_order`,
          ctx,
        ),
        select(
          "priorities_effective",
          `select=id,kind,title,kpi,start_date,checkin_date,status,effective_status,notes,rock_sub_tasks(rock_id,sort_order)&sub_function_id=eq.${team.id}&archived_at=is.null`,
          ctx,
        ),
      ])
    : [[], [], []];

  const statusOf = new Map(statuses.map((s) => [s.rock_id, s]));
  const rockIdOf = (t) => (Array.isArray(t.rock_sub_tasks) ? t.rock_sub_tasks[0] : t.rock_sub_tasks)?.rock_id ?? null;
  const sortOf = (t) => (Array.isArray(t.rock_sub_tasks) ? t.rock_sub_tasks[0] : t.rock_sub_tasks)?.sort_order ?? 0;

  return {
    takenAt: now.toISOString(),
    team: { id: team.id, name: team.name, owners: team.owners ?? null },
    quarter,
    rocks: rocks.map((r) => {
      const s = statusOf.get(r.id);
      return {
        id: r.id,
        title: trim(r.title),
        quarter: r.quarter,
        definitionOfDone: trim(r.definition_of_done),
        isBau: Boolean(r.is_bau),
        latestStatus: s
          ? { date: s.entry_date, color: s.status, reason: trim(s.reason), actionPlan: trim(s.action_plan), note: trim(s.note), by: s.submitted_by ?? null }
          : null,
        milestones: milestones
          .filter((m) => m.rock_id === r.id)
          .map((m) => ({ id: m.id, month: String(m.month ?? "").slice(0, 7), deliverable: trim(m.deliverable), done: Boolean(m.done_at), blocker: trim(m.blocker) })),
        tactics: tactics
          .filter((t) => rockIdOf(t) === r.id)
          .sort((a, b) => sortOf(a) - sortOf(b))
          .map((t) => ({
            id: t.id,
            title: trim(t.title),
            kind: t.kind ?? null,
            kpi: trim(t.kpi),
            startDate: t.start_date ?? null,
            checkInDate: t.checkin_date ?? null,
            status: t.effective_status ?? t.status ?? null,
            notes: trim(t.notes),
          })),
      };
    }),
  };
}

/**
 * The Supabase rocks as Layer 1 queue items: the same shape the rules have always read,
 * with the rock's tactics and milestones carried along, and the app's own links laid
 * over each rock and tactic.
 *
 * A rock reaches tickets through every Big Swing linked to it or to one of its tactics,
 * so `clickupBigSwingOptionIds` is the union; `clickupBigSwingOptionId` is the first of
 * them, for anything that only shows one.
 */
export function rocksFromSupabase(source, links = {}, people = {}) {
  const linkOf = (id) => links[id] ?? {};
  const { first, last } = quarterMonths(source.quarter);
  return source.rocks.map((r) => {
    const own = linkOf(r.id);
    const tactics = r.tactics.map((t) => {
      const l = linkOf(t.id);
      return { ...t, owner: l.owner ? resolveOwner(l.owner, people) : null, clickupBigSwingOptionId: l.clickupBigSwingOptionId ?? null };
    });
    const swings = [own.clickupBigSwingOptionId, ...tactics.filter((t) => t.status !== "done").map((t) => t.clickupBigSwingOptionId)]
      .filter(Boolean)
      .map(String);
    const ids = [...new Set(swings)];
    // The per-team bucket Supabase flags is_bau, and a rock that is BAU by name: neither
    // is a goal to hold to a status, a KPI or an owner.
    const bau = r.isBau || /\bbau\b|business as usual/i.test(r.title ?? "");
    return {
      id: r.id,
      title: r.title,
      type: bau ? "bau" : "rock",
      bau,
      state: "active",
      status: STATUS_FROM_COLOR[r.latestStatus?.color] ?? "on_track",
      statusColor: r.latestStatus?.color ?? null,
      statusReason: r.latestStatus?.reason ?? null,
      actionPlan: r.latestStatus?.actionPlan ?? null,
      owner: own.owner ? resolveOwner(own.owner, people) : null,
      kpi: r.definitionOfDone,
      startDate: first ? `${first}-01` : null,
      targetMonth: last,
      checkInDate: r.latestStatus?.date ?? null,
      lastMiniReadoutAt: r.latestStatus?.date ?? null,
      shippedAt: null,
      quarter: r.quarter,
      clickupOptionId: null,
      clickupFieldId: null,
      clickupBigSwingOptionId: ids[0] ?? null,
      clickupBigSwingOptionIds: ids,
      // The one set on the rock itself, apart from its tactics', for the editor.
      ownBigSwingOptionId: own.clickupBigSwingOptionId ?? null,
      intelligemsExperienceId: null,
      experimentLinks: own.experimentLinks ?? [],
      reportLinks: own.reportLinks ?? [],
      websiteUrl: own.websiteUrl ?? null,
      notes: own.notes ?? null,
      milestones: r.milestones,
      tactics,
      priority: "P1",
      source: "supabase",
    };
  });
}
