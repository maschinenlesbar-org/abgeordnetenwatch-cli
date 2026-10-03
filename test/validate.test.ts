import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
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
