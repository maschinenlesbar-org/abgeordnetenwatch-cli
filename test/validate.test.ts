import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  entityIdProblem,
  normalizeEntityId,
  type Problem,
} from "../src/client/validate.js";
import { AwError, AwValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import type { AbgeordnetenwatchClient } from "../src/client/client.js";

const notBlank: Problem<string> = (value) =>
  value.trim() === "" ? "Expected a non-empty value." : undefined;

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("sortBy", "last_name", notBlank), "last_name");
});

test("assertValid throws AwValidationError naming the input and the reason", () => {
  assert.throws(
    () => assertValid("sortBy", " ", notBlank),
    (err: unknown) =>
      err instanceof AwValidationError &&
      err instanceof AwError &&
      err.name === "AwValidationError" &&
      err.message === "Invalid sortBy: Expected a non-empty value.",
  );
});

test("the validation layer is part of the library's public surface", () => {
  assert.equal(library.AwValidationError, AwValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("run() maps an AwValidationError from an action to a usage error (exit 2)", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    createClient: () =>
      ({
        list: async () => {
          throw new AwValidationError("Invalid sortDirection: needs sortBy.");
        },
      }) as unknown as AbgeordnetenwatchClient,
  };
  assert.equal(await run(["list", "politicians"], deps), 2);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ["Error: Invalid sortDirection: needs sortBy."]);
});

test("entityIdProblem accepts positive integers as numbers or digit strings", () => {
  for (const id of [1, 42, Number.MAX_SAFE_INTEGER, "1", "0002", "184945"]) {
    assert.equal(entityIdProblem(id), undefined, String(id));
  }
});

test("entityIdProblem rejects zero, blanks, signs, fractions and non-digits", () => {
  for (const id of [0, "0", "000"]) {
    assert.equal(entityIdProblem(id), "Entity ids start at 1.", JSON.stringify(id));
  }
  for (const id of [-1, 1.5, NaN, Infinity, 2 ** 53, "", " ", " 2 ", "abc", "-1", "+1", "1.5", "1e3", "\uff12"]) {
    assert.equal(entityIdProblem(id), "Expected a numeric entity id.", JSON.stringify(id));
  }
});

test("normalizeEntityId drops leading zeros, is idempotent and throws AwValidationError", () => {
  assert.equal(normalizeEntityId("0002"), "2");
  assert.equal(normalizeEntityId(normalizeEntityId("0002")), "2");
  assert.equal(normalizeEntityId(184945), "184945");
  assert.throws(
    () => normalizeEntityId("0"),
    (err: unknown) =>
      err instanceof AwValidationError && err.message === 'Invalid id "0": Entity ids start at 1.',
  );
  assert.throws(
    () => normalizeEntityId("abc"),
    (err: unknown) =>
      err instanceof AwValidationError &&
      err.message === 'Invalid id "abc": Expected a numeric entity id.',
  );
});
