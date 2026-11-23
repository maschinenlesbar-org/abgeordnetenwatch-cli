// The use-case operations against a mock upstream, with the skills' traps as cases: a full page
// of names is not all matches, mandates need current_on=all, side jobs are filtered by
// `mandates`, a poll has more votes than one page holds, no_show is not a no, income is passed
// on as declared, and a count the pages don't match is an error, not a short tally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AbgeordnetenwatchClient } from "../src/client.js";
import { AwNetworkError, AwParseError, AwValidationError } from "../src/errors.js";
import type { HttpRequest } from "../src/http.js";
import { findPolitician, findPolls, getPollResult, getSideJobs, getVotingRecord } from "../src/operations.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

type Item = Record<string, unknown>;

/** A list envelope for `items` (all of the collection's matches), paged by range_start/range_end. */
function page(items: Item[], url: URL) {
  const start = Number(url.searchParams.get("range_start") ?? 0);
  const size = Number(url.searchParams.get("range_end") ?? 100);
  const data = items.slice(start, start + size);
  return { meta: { status: "ok", status_message: "", result: { count: data.length, total: items.length, range_start: start, range_end: start + data.length } }, data };
}

/** A transport that answers each collection path with the items `route` gives for its query. */
function upstream(route: (collection: string, url: URL) => Item[] | Item | undefined) {
  return makeMockTransport((request: HttpRequest) => {
    const url = new URL(request.url);
    const [, , , collection, id] = url.pathname.split("/");
    const found = route(id === undefined ? (collection ?? "") : `${collection}/${id}`, url);
    if (found === undefined) return jsonResponse({ error: "not found" }, 404);
    if (Array.isArray(found)) return jsonResponse(page(found, url));
    return jsonResponse({ meta: { status: "ok", status_message: "", result: { entity_id: String(found["id"]), entity_type: "x" } }, data: found });
  });
}

const politician = (id: number, label: string): Item => ({ id, label, party: { id: 1, label: "SPD" }, year_of_birth: 1958 });
const mandate = (id: number, period: string): Item => ({ id, type: "mandate", label: `${period} mandate`, parliament_period: { id: id + 1, label: period }, start_date: "2025-03-25", end_date: null });
const vote = (id: number, pollId: number, value: string, fraction = "SPD"): Item => ({ id, vote: value, poll: { id: pollId, label: `Poll ${pollId}` }, fraction: { id: 9, label: fraction } });

test("findPolitician: first and last name become contains-filters, and a full page says it is not complete", async () => {
  const many = Array.from({ length: 37 }, (_, i) => politician(100 + i, `Olaf Scholz ${i}`));
  const mock = upstream((collection) => (collection === "politicians" ? many : undefined));
  const client = new AbgeordnetenwatchClient({ transport: mock.transport });
  const result = await findPolitician(client, { name: "  Olaf   Scholz " , limit: 10 });
  assert.deepEqual(result.searched, { "first_name[cn]": "Olaf", "last_name[cn]": "Scholz" });
  assert.equal(result.total, 37);
  assert.equal(result.candidates.length, 10);
  assert.equal(result.complete, false);
  assert.deepEqual(result.candidates[0], { id: 100, name: "Olaf Scholz 0", party: "SPD", yearOfBirth: 1958 });
  assert.match(mock.last().url, /first_name%5Bcn%5D=Olaf&last_name%5Bcn%5D=Scholz|last_name%5Bcn%5D=Scholz/);
});

test("getVotingRecord: one match goes on to the most recent mandate (current_on=all), every page of votes, no_show apart from no", async () => {
  const votes = [
    ...Array.from({ length: 1200 }, (_, i) => vote(i, i, "yes")),
    ...Array.from({ length: 200 }, (_, i) => vote(2000 + i, 1200 + i, "no")),
    ...Array.from({ length: 50 }, (_, i) => vote(3000 + i, 1400 + i, "no_show")),
    vote(4000, 5000, "abstain"),
  ];
  const mock = upstream((collection, url) => {
    if (collection === "politicians") return [politician(7, "Olaf Scholz")];
    if (collection === "candidacies-mandates") {
      assert.equal(url.searchParams.get("current_on"), "all");
      return [mandate(70, "Bundestag 2025 - 2029"), { id: 71, type: "candidacy" }, mandate(60, "Bundestag 2021 - 2025")];
    }
    if (collection === "votes") {
      assert.equal(url.searchParams.get("mandate"), "70");
      return votes;
    }
    return undefined;
  });
  const record = await getVotingRecord(new AbgeordnetenwatchClient({ transport: mock.transport }), { name: "Olaf Scholz", limit: 3 });
  assert.equal(record.status, "ok");
  if (record.status !== "ok") return;
  assert.equal(record.mandate.id, 70);
  assert.deepEqual(record.otherMandates.map((m) => m.id), [60]);
  assert.equal(record.total, votes.length);
  assert.deepEqual(record.tally, { yes: 1200, no: 200, abstain: 1, no_show: 50, other: 0 });
  assert.deepEqual(record.recent.map((r) => r.pollId), [5000, 1449, 1448], "newest poll first");
  assert.equal(record.truncated, false);
  const votePages = mock.calls.filter((c) => c.url.includes("/votes") && !c.url.includes("range_end=1&") && !c.url.endsWith("range_end=1"));
  assert.deepEqual(votePages.map((c) => new URL(c.url).searchParams.get("range_start")), ["0", "1000"]);
});

test("a name that matches several politicians is ambiguous: no mandate or vote is read", async () => {
  const mock = upstream((collection) => (collection === "politicians" ? [politician(1, "Anna Müller"), politician(2, "Hans Müller")] : undefined));
  const record = await getVotingRecord(new AbgeordnetenwatchClient({ transport: mock.transport }), { name: "Müller" });
  assert.equal(record.status, "ambiguous");
  assert.ok(mock.calls.every((c) => c.url.includes("/politicians")));
});

test("a name that matches nobody is empty, and says what was searched", async () => {
  const mock = upstream((collection) => (collection === "politicians" ? [] : undefined));
  const record = await getSideJobs(new AbgeordnetenwatchClient({ transport: mock.transport }), { name: "Nobody" });
  assert.equal(record.status, "empty");
  if (record.status === "empty") assert.match(record.reason, /last_name containing "Nobody"/);
});

test("getSideJobs filters by mandates (plural) and passes income on as declared", async () => {
  const mock = upstream((collection, url) => {
    if (collection === "politicians/7") return politician(7, "Stephan Stracke");
    if (collection === "candidacies-mandates") return [mandate(70, "Bundestag 2025 - 2029")];
    if (collection === "sidejobs") {
      assert.equal(url.searchParams.get("mandates"), "70");
      assert.equal(url.searchParams.get("mandate"), null);
      return [
        { id: 1, label: "Stadtrat", sidejob_organization: { label: "Stadt Kaufbeuren" }, income: 70, income_level: "1", field_city: { label: "Kaufbeuren" }, field_country: { label: "Deutschland" }, field_topics: [{ label: "Kommunen" }] },
        { id: 2, label: "Beirat", income: null, income_level: "3" },
      ];
    }
    return undefined;
  });
  const jobs = await getSideJobs(new AbgeordnetenwatchClient({ transport: mock.transport }), { politicianId: "0007" });
  assert.equal(jobs.status, "ok");
  if (jobs.status !== "ok") return;
  assert.deepEqual(jobs.sideJobs.map((j) => [j.job, j.payer, j.income, j.incomeLevel]), [["Stadtrat", "Stadt Kaufbeuren", 70, "1"], ["Beirat", null, null, "3"]]);
  assert.deepEqual(jobs.sideJobs[0]?.topics, ["Kommunen"]);
});

test("getPollResult: fraction by fraction, the largest first", async () => {
  const votes = [vote(1, 9, "yes", "SPD"), vote(2, 9, "yes", "SPD"), vote(3, 9, "no", "AfD"), vote(4, 9, "no_show", "SPD")];
  const mock = upstream((collection) => {
    if (collection === "polls/9") return { id: 9, label: "Gesetz", field_poll_date: "2026-10-01", field_accepted: true, field_legislature: { id: 1, label: "Bundestag 2025 - 2029" } };
    if (collection === "votes") return votes;
    return undefined;
  });
  const result = await getPollResult(new AbgeordnetenwatchClient({ transport: mock.transport }), { pollId: 9 });
  assert.deepEqual(result.poll, { id: 9, label: "Gesetz", date: "2026-10-01", accepted: true, parliamentPeriod: "Bundestag 2025 - 2029", intro: null });
  assert.deepEqual(result.fractions.map((f) => [f.fraction, f.yes, f.no, f.no_show, f.total]), [["SPD", 2, 0, 1, 3], ["AfD", 0, 1, 0, 1]]);
});

test("a count the pages don't hold is an error, never a short tally", async () => {
  const mock = makeMockTransport((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/polls/9")) return jsonResponse({ meta: { status: "ok" }, data: { id: 9, label: "x" } });
    const total = 1500;
    const data = url.searchParams.get("range_end") === "1" ? [vote(1, 9, "yes")] : [vote(1, 9, "yes")];
    return jsonResponse({ meta: { status: "ok", result: { count: data.length, total, range_start: 0, range_end: 1 } }, data });
  });
  await assert.rejects(getPollResult(new AbgeordnetenwatchClient({ transport: mock.transport }), { pollId: 9 }), AwParseError);
});

test("more pages than maxPages: the first pages, marked truncated", async () => {
  const votes = Array.from({ length: 2500 }, (_, i) => vote(i, i, "yes"));
  const mock = upstream((collection) => (collection === "polls/9" ? { id: 9, label: "x" } : collection === "votes" ? votes : undefined));
  const result = await getPollResult(new AbgeordnetenwatchClient({ transport: mock.transport }), { pollId: 9 }, { maxPages: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.total, 2500);
  assert.equal(result.tally.yes, 2000);
});

test("findPolls sorts by poll date (sorting polls by id is an HTTP 500) and filters dates", async () => {
  const mock = upstream((collection, url) => {
    if (collection !== "polls") return undefined;
    if (url.searchParams.get("range_end") !== "1") {
      assert.equal(url.searchParams.get("sort_by"), "field_poll_date");
      assert.equal(url.searchParams.get("sort_direction"), "desc");
    }
    assert.equal(url.searchParams.get("field_legislature"), "161");
    assert.equal(url.searchParams.get("field_poll_date[gte]"), "2026-01-01");
    return [{ id: 1, label: "A", field_poll_date: "2026-02-01", field_accepted: false }];
  });
  const result = await findPolls(new AbgeordnetenwatchClient({ transport: mock.transport }), { parliamentPeriodId: 161, from: "2026-01-01" });
  assert.deepEqual(result.polls, [{ id: 1, label: "A", date: "2026-02-01", accepted: false }]);
  await assert.rejects(findPolls(new AbgeordnetenwatchClient({ transport: mock.transport }), { parliamentPeriodId: 161, from: "1.1.2026" }), AwValidationError);
});

test("inputs are checked before any request", async () => {
  const mock = upstream(() => []);
  const client = new AbgeordnetenwatchClient({ transport: mock.transport });
  await assert.rejects(getVotingRecord(client, { name: "x", politicianId: 1 }), AwValidationError);
  await assert.rejects(getVotingRecord(client, {}), AwValidationError);
  await assert.rejects(findPolitician(client, { name: "\u200b" }), AwValidationError);
  await assert.rejects(findPolitician(client, { name: "Scholz", limit: 500 }), AwValidationError);
  await assert.rejects(getPollResult(client, { pollId: "-1" }), AwValidationError);
  assert.equal(mock.calls.length, 0);
});

test("a mandate that is not the politician's is refused", async () => {
  const mock = upstream((collection) => (collection === "politicians/7" ? politician(7, "X") : collection === "candidacies-mandates" ? [mandate(70, "P")] : []));
  await assert.rejects(getVotingRecord(new AbgeordnetenwatchClient({ transport: mock.transport }), { politicianId: 7, mandateId: 99 }), /Mandate 99 is not one of X's \(70\)/);
});

test("the signal reaches every request", async () => {
  const mock = upstream(() => []);
  await assert.rejects(findPolitician(new AbgeordnetenwatchClient({ transport: mock.transport }), { name: "Scholz" }, { signal: AbortSignal.abort() }), AwNetworkError);
  assert.equal(mock.calls.length, 0);
});

test("findPolls refuses a date that doesn't exist (Feb 30, Apr 31) instead of sending it", async () => {
  const mock = upstream(() => []);
  const client = new AbgeordnetenwatchClient({ transport: mock.transport });
  for (const [key, value] of [["from", "2026-02-30"], ["to", "2025-04-31"], ["from", "2025-02-29"], ["to", "2026-13-01"], ["from", "2026-00-10"]] as const) {
    await assert.rejects(findPolls(client, { parliamentPeriodId: 161, [key]: value }), (err: Error) => err instanceof AwValidationError && err.message.includes(`Invalid ${key}`), value);
  }
  assert.equal(mock.calls.length, 0);
  await findPolls(client, { parliamentPeriodId: 161, from: "2024-02-29", to: "2026-12-31" });
});
