// The use cases of the skills as library functions: find a politician, their voting record and
// side jobs, find polls and a poll's result. Each composes list/get/count and carries the traps
// the skills document, so no caller has to know them:
// - a name search is a contains-match in the API's order: a full page is not all matches, so
//   the total is counted and reported (`complete`);
// - mandates come with `current_on=all`, else only today's;
// - votes and side jobs hang off a mandate; side jobs are filtered by `mandates` (plural);
// - every page is fetched (page size 1000, the API's maximum) and the count checked, so a
//   tally never covers only the first page; at most `maxPages` pages (default 10) per call;
// - `no_show` is its own tally, never a `no`; side-job income is passed on as declared
//   (`income` or the band `income_level`), never summed or converted.
// Every function takes { signal } and passes it to every request.

import type { AbgeordnetenwatchClient } from "./client.js";
import type { RequestOptions } from "./engine.js";
import { AwParseError, AwValidationError } from "./errors.js";
import type { Entity, EntityCollection, FilterValue, JsonValue } from "./types.js";
import { describeValue, entityIdProblem, normalizeEntityId, textProblem } from "./validate.js";

/** Page size of the operations: the most the API returns per request. */
export const OPERATION_PAGE_SIZE = 1000;

/** Default for {@link OperationOptions.maxPages}. */
export const DEFAULT_MAX_PAGES = 10;

/** Options of every operation. */
export interface OperationOptions extends RequestOptions {
  /** At most this many pages of 1000 per collection read (default 10); more is `truncated`. */
  maxPages?: number;
}

/** A politician as the operations report one. */
export interface PoliticianSummary {
  id: number;
  name: string;
  party: string | null;
  yearOfBirth: number | null;
}

/** The answer of {@link findPolitician}. */
export interface PoliticianSearch {
  /** The filters the name became, e.g. `{ "first_name[cn]": "Olaf", "last_name[cn]": "Scholz" }`. */
  searched: Record<string, string>;
  /** How many politicians match in all. */
  total: number;
  /** The first matches, in the API's order (newest ids first), not by relevance. */
  candidates: PoliticianSummary[];
  /** False when `total` is larger than the candidates listed: narrow the name. */
  complete: boolean;
}

/** A mandate (a seat in one parliament period). */
export interface MandateSummary {
  id: number;
  label: string;
  parliamentPeriod: string | null;
  parliamentPeriodId: number | null;
  startDate: string | null;
  endDate: string | null;
}

/** Who and which mandate an answer is about, or why there is no single one. */
export type Resolved =
  | { status: "ok"; politician: PoliticianSummary; mandate: MandateSummary; otherMandates: MandateSummary[] }
  | { status: "ambiguous"; search: PoliticianSearch }
  | { status: "empty"; search?: PoliticianSearch; politician?: PoliticianSummary; reason: string };

/** Vote counts; `no_show` means the member did not take part, which is not a `no`. */
export interface VoteTally {
  yes: number;
  no: number;
  abstain: number;
  no_show: number;
  other: number;
}

/** The answer of {@link getVotingRecord}. */
export type VotingRecord =
  | (Extract<Resolved, { status: "ok" }> & {
      total: number;
      tally: VoteTally;
      /** Newest first (by poll id, which grows with time), at most `limit`. */
      recent: { pollId: number | null; poll: string | null; vote: string | null; fraction: string | null }[];
      truncated: boolean;
    })
  | Exclude<Resolved, { status: "ok" }>;

/** The answer of {@link findPolls}. */
export interface PollSearch {
  total: number;
  /** Newest first, by poll date. */
  polls: { id: number; label: string; date: string | null; accepted: boolean | null }[];
  complete: boolean;
}

/** The answer of {@link getPollResult}. */
export interface PollResult {
  poll: { id: number; label: string; date: string | null; accepted: boolean | null; parliamentPeriod: string | null; intro: string | null };
  total: number;
  tally: VoteTally;
  /** One row per fraction, the largest first. */
  fractions: ({ fraction: string } & VoteTally & { total: number })[];
  truncated: boolean;
}

/** One side job as declared. */
export interface SideJob {
  id: number;
  job: string | null;
  jobTitleExtra: string | null;
  payer: string | null;
  city: string | null;
  country: string | null;
  /** The exact amount, when declared. */
  income: number | null;
  /** The band code (older periods declare only this); a band is not an amount. */
  incomeLevel: string | null;
  interval: string | null;
  category: string | null;
  topics: string[];
  changed: string | null;
}

/** The answer of {@link getSideJobs}. */
export type SideJobs =
  | (Extract<Resolved, { status: "ok" }> & { total: number; sideJobs: SideJob[]; truncated: boolean })
  | Exclude<Resolved, { status: "ok" }>;

/** Who an operation is about: an id, or a name to search. Exactly one. */
export interface PoliticianRef {
  politicianId?: number | string | undefined;
  name?: string | undefined;
  /** A mandate of that politician; default: the most recent. */
  mandateId?: number | string | undefined;
}

/** Search politicians by name: "Scholz" (last name contains), "Olaf Scholz" (first and last). */
export async function findPolitician(
  client: AbgeordnetenwatchClient,
  query: { name: string; limit?: number | undefined },
  options: OperationOptions = {},
): Promise<PoliticianSearch> {
  const name = checkedText("name", query.name);
  const limit = checkedLimit("limit", query.limit, 10, 25);
  const words = name.split(/\s+/u);
  const last = words.pop() ?? name;
  const searched: Record<string, string> = words.length > 0 ? { "first_name[cn]": words.join(" "), "last_name[cn]": last } : { "last_name[cn]": last };
  const total = await client.count("politicians", { filters: searched }, signalOf(options));
  const page = total === 0 ? [] : (await client.list("politicians", { filters: searched, rangeEnd: limit }, signalOf(options))).data;
  const candidates = page.map(politicianSummary);
  return { searched, total, candidates, complete: candidates.length >= total };
}

/** A politician's roll-call votes in one mandate: the tally and the most recent votes. */
export async function getVotingRecord(
  client: AbgeordnetenwatchClient,
  query: PoliticianRef & { limit?: number | undefined },
  options: OperationOptions = {},
): Promise<VotingRecord> {
  const limit = checkedLimit("limit", query.limit, 20, 100);
  const resolved = await resolveMandate(client, query, options);
  if (resolved.status !== "ok") return resolved;
  const { items, total, truncated } = await readAll(client, "votes", { mandate: resolved.mandate.id }, options);
  const recent = [...items]
    .sort((a, b) => (refId(b, "poll") ?? 0) - (refId(a, "poll") ?? 0))
    .slice(0, limit)
    .map((vote) => ({ pollId: refId(vote, "poll"), poll: refLabel(vote, "poll"), vote: text(vote, "vote"), fraction: refLabel(vote, "fraction") }));
  return { ...resolved, total, tally: tally(items), recent, truncated };
}

/** The polls of a parliament period, newest first, optionally of one topic or date range. */
export async function findPolls(
  client: AbgeordnetenwatchClient,
  query: { parliamentPeriodId: number | string; topicId?: number | string | undefined; from?: string | undefined; to?: string | undefined; limit?: number | undefined },
  options: OperationOptions = {},
): Promise<PollSearch> {
  const filters: Record<string, FilterValue> = { field_legislature: checkedId("parliamentPeriodId", query.parliamentPeriodId) };
  if (query.topicId !== undefined) filters["field_topics"] = checkedId("topicId", query.topicId);
  if (query.from !== undefined) filters["field_poll_date[gte]"] = checkedDate("from", query.from);
  if (query.to !== undefined) filters["field_poll_date[lte]"] = checkedDate("to", query.to);
  const limit = checkedLimit("limit", query.limit, 20, 100);
  const total = await client.count("polls", { filters }, signalOf(options));
  // Polls can't be sorted by id (HTTP 500); by date they can.
  const page =
    total === 0 ? [] : (await client.list("polls", { filters, rangeEnd: limit, sortBy: "field_poll_date", sortDirection: "desc" }, signalOf(options))).data;
  const polls = page.map((poll) => ({ id: idOf(poll), label: text(poll, "label") ?? "", date: text(poll, "field_poll_date"), accepted: bool(poll, "field_accepted") }));
  return { total, polls, complete: polls.length >= total };
}

/** How a roll-call vote went, in all and fraction by fraction. */
export async function getPollResult(
  client: AbgeordnetenwatchClient,
  query: { pollId: number | string },
  options: OperationOptions = {},
): Promise<PollResult> {
  const pollId = checkedId("pollId", query.pollId);
  const poll = (await client.get("polls", pollId, signalOf(options))).data;
  const { items, total, truncated } = await readAll(client, "votes", { poll: pollId }, options);
  const byFraction = new Map<string, Entity[]>();
  for (const vote of items) {
    const fraction = refLabel(vote, "fraction") ?? "—";
    byFraction.set(fraction, [...(byFraction.get(fraction) ?? []), vote]);
  }
  const fractions = [...byFraction]
    .map(([fraction, votes]) => ({ fraction, ...tally(votes), total: votes.length }))
    .sort((a, b) => b.total - a.total || a.fraction.localeCompare(b.fraction));
  return {
    poll: {
      id: idOf(poll),
      label: text(poll, "label") ?? "",
      date: text(poll, "field_poll_date"),
      accepted: bool(poll, "field_accepted"),
      parliamentPeriod: refLabel(poll, "field_legislature"),
      intro: text(poll, "field_intro"),
    },
    total,
    tally: tally(items),
    fractions,
    truncated,
  };
}

/** A politician's declared side jobs (Nebentätigkeiten) in one mandate. */
export async function getSideJobs(client: AbgeordnetenwatchClient, query: PoliticianRef, options: OperationOptions = {}): Promise<SideJobs> {
  const resolved = await resolveMandate(client, query, options);
  if (resolved.status !== "ok") return resolved;
  // The filter is `mandates`, the array field's name: `mandate=` is an HTTP 500.
  const { items, total, truncated } = await readAll(client, "sidejobs", { mandates: resolved.mandate.id }, options);
  const sideJobs = items.map((job) => ({
    id: idOf(job),
    job: text(job, "label"),
    jobTitleExtra: text(job, "job_title_extra"),
    payer: refLabel(job, "sidejob_organization"),
    city: refLabel(job, "field_city"),
    country: refLabel(job, "field_country"),
    income: num(job, "income"),
    incomeLevel: text(job, "income_level"),
    interval: text(job, "interval"),
    category: text(job, "category"),
    topics: labels(job, "field_topics"),
    changed: text(job, "data_change_date"),
  }));
  return { ...resolved, total, sideJobs, truncated };
}

/** The politician (by id, or a name with exactly one match) and the mandate the question is about. */
export async function resolveMandate(client: AbgeordnetenwatchClient, query: PoliticianRef, options: OperationOptions = {}): Promise<Resolved> {
  if ((query.politicianId === undefined) === (query.name === undefined)) {
    throw new AwValidationError("Give either politicianId or name, not both and not neither.");
  }
  let politician: PoliticianSummary;
  if (query.politicianId !== undefined) {
    politician = politicianSummary((await client.get("politicians", checkedId("politicianId", query.politicianId), signalOf(options))).data);
  } else {
    const search = await findPolitician(client, { name: query.name ?? "", limit: 10 }, options);
    if (search.total === 0) return { status: "empty", search, reason: `No politician matches ${describeSearch(search)}.` };
    const only = search.candidates[0];
    if (search.total > 1 || only === undefined) return { status: "ambiguous", search };
    politician = only;
  }
  // `current_on=all`: without it the API returns only the mandate current today.
  const records = (await client.list("candidacies-mandates", { filters: { politician: politician.id, current_on: "all" }, rangeEnd: 100 }, signalOf(options))).data;
  const mandates = records.filter((record) => text(record, "type") === "mandate").map(mandateSummary);
  if (mandates.length === 0) return { status: "empty", politician, reason: `${politician.name} (${politician.id}) has no mandate in abgeordnetenwatch's records, only candidacies.` };
  let mandate = mandates[0] as MandateSummary;
  if (query.mandateId !== undefined) {
    const wanted = Number(checkedId("mandateId", query.mandateId));
    const found = mandates.find((m) => m.id === wanted);
    if (found === undefined) {
      throw new AwValidationError(`Mandate ${wanted} is not one of ${politician.name}'s (${mandates.map((m) => m.id).join(", ")}).`);
    }
    mandate = found;
  }
  return { status: "ok", politician, mandate, otherMandates: mandates.filter((m) => m.id !== mandate.id) };
}

/**
 * Every item of a filtered collection, page by page (1000 each), at most `maxPages` pages.
 * Throws when the pages hold fewer items than the count said: a tally of a partial answer
 * would look complete.
 */
export async function readAll(
  client: AbgeordnetenwatchClient,
  collection: EntityCollection,
  filters: Record<string, FilterValue>,
  options: OperationOptions = {},
): Promise<{ items: Entity[]; total: number; truncated: boolean }> {
  const maxPages = checkedLimit("maxPages", options.maxPages, DEFAULT_MAX_PAGES, 100);
  const total = await client.count(collection, { filters }, signalOf(options));
  const pages = Math.min(Math.ceil(total / OPERATION_PAGE_SIZE), maxPages);
  const items: Entity[] = [];
  for (let page = 0; page < pages; page++) {
    const { data } = await client.list(collection, { filters, rangeStart: page * OPERATION_PAGE_SIZE, rangeEnd: OPERATION_PAGE_SIZE }, signalOf(options));
    items.push(...data);
    if (data.length < OPERATION_PAGE_SIZE) break;
  }
  const truncated = pages * OPERATION_PAGE_SIZE < total;
  const expected = truncated ? pages * OPERATION_PAGE_SIZE : total;
  if (items.length !== expected) {
    throw new AwParseError(`${collection}: the count said ${total}, the pages held ${items.length}${truncated ? ` of the first ${expected}` : ""}.`);
  }
  return { items, total, truncated };
}

function signalOf(options: OperationOptions): RequestOptions | undefined {
  return options.signal === undefined ? undefined : { signal: options.signal };
}

function describeSearch(search: PoliticianSearch): string {
  return Object.entries(search.searched)
    .map(([key, value]) => `${key.replace("[cn]", "")} containing ${describeValue(value)}`)
    .join(" and ");
}

function checkedText(name: string, value: unknown): string {
  if (typeof value !== "string") throw new AwValidationError(`Invalid ${name}: expected text, got ${describeValue(value)}.`);
  const problem = textProblem(value);
  if (problem !== undefined) throw new AwValidationError(`Invalid ${name} ${describeValue(value)}: ${problem}`);
  return value.normalize("NFC").trim();
}

function checkedLimit(name: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new AwValidationError(`Invalid ${name}: expected a whole number from 1 to ${max}, got ${describeValue(value)}.`);
  }
  return value;
}

function checkedId(name: string, value: number | string): string {
  const problem = entityIdProblem(value);
  if (problem !== undefined) throw new AwValidationError(`Invalid ${name} ${describeValue(value)}: ${problem}`);
  return normalizeEntityId(value);
}

/**
 * A calendar date as YYYY-MM-DD. `Date.parse` alone rolled an impossible day over
 * (2026-02-30 became March 2) and the date went out as it was; a date must read back the same.
 */
function checkedDate(name: string, value: unknown): string {
  const time = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new AwValidationError(`Invalid ${name}: expected an existing date YYYY-MM-DD, got ${describeValue(value)}.`);
  }
  return value;
}

function politicianSummary(entity: Entity): PoliticianSummary {
  return { id: idOf(entity), name: text(entity, "label") ?? "", party: refLabel(entity, "party"), yearOfBirth: num(entity, "year_of_birth") };
}

function mandateSummary(entity: Entity): MandateSummary {
  return {
    id: idOf(entity),
    label: text(entity, "label") ?? "",
    parliamentPeriod: refLabel(entity, "parliament_period"),
    parliamentPeriodId: refId(entity, "parliament_period"),
    startDate: text(entity, "start_date"),
    endDate: text(entity, "end_date"),
  };
}

function tally(votes: readonly Entity[]): VoteTally {
  const counts: VoteTally = { yes: 0, no: 0, abstain: 0, no_show: 0, other: 0 };
  for (const vote of votes) {
    const value = text(vote, "vote");
    if (value === "yes" || value === "no" || value === "abstain" || value === "no_show") counts[value] += 1;
    else counts.other += 1;
  }
  return counts;
}

function idOf(entity: Entity): number {
  const id = entity["id"];
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new AwParseError(`An entity without a numeric id: ${describeValue(id)}.`);
  return id;
}

function text(entity: Entity, key: string): string | null {
  const value = entity[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function num(entity: Entity, key: string): number | null {
  const value = entity[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(entity: Entity, key: string): boolean | null {
  const value = entity[key];
  return typeof value === "boolean" ? value : null;
}

function ref(entity: Entity, key: string): Record<string, JsonValue> | null {
  const value = entity[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function refLabel(entity: Entity, key: string): string | null {
  const value = ref(entity, key)?.["label"];
  return typeof value === "string" ? value : null;
}

function refId(entity: Entity, key: string): number | null {
  const value = ref(entity, key)?.["id"];
  return typeof value === "number" ? value : null;
}

function labels(entity: Entity, key: string): string[] {
  const value = entity[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "object" && item !== null && !Array.isArray(item) && typeof item["label"] === "string" ? [item["label"]] : []));
}
