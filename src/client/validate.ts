// Input validation shared by the client and the CLI. Each rule is a pure
// `Problem` function: it returns the reason a value is invalid, or undefined when
// the value is fine. The client enforces a rule with assertValid() before it sends
// a request; the CLI's commander parsers call the same Problem functions, so a
// rule is written once and both layers reject exactly the same inputs.

import { AwValidationError } from "./errors.js";

/**
 * A validation rule: returns the reason `value` is invalid (one sentence, e.g.
 * `"Expected a non-empty value."`), or `undefined` when it is valid.
 */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Enforce a rule: throw {@link AwValidationError} with the message
 * `Invalid <name>: <reason>` when `problem(value)` reports one, else return `value`
 * unchanged. Client methods that return a promise call it inside the async body,
 * so a rejected input rejects the promise (and sends no request) instead of
 * throwing synchronously.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new AwValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * Rule for an entity id (`get`). Ids are positive decimal integers: a number must
 * be a safe integer of at least 1, a string a run of ASCII digits that is not all
 * zeros. The API treats `/<collection>/0` (and an empty id) as the collection
 * itself, and answers anything else that is not a number with a generic HTTP 500.
 */
export const entityIdProblem: Problem<number | string> = (id) => {
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id) || id < 0) return "Expected a numeric entity id.";
    return id === 0 ? "Entity ids start at 1." : undefined;
  }
  if (typeof id !== "string" || !/^[0-9]+$/.test(id)) return "Expected a numeric entity id.";
  return /^0+$/.test(id) ? "Entity ids start at 1." : undefined;
};

/**
 * The canonical form of an entity id: checked with {@link entityIdProblem} (throws
 * AwValidationError), leading zeros dropped. The API looks the id up as a string,
 * so `0002` would be "no such entity" although party 2 exists. Idempotent.
 */
export function normalizeEntityId(id: number | string): string {
  assertValid(`id "${String(id)}"`, id, entityIdProblem);
  return String(id).replace(/^0+/, "");
}
