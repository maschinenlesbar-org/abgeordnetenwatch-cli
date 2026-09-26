import { InvalidArgumentError, type Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseFilters, parseIntArg, parseNonEmpty, renderJson } from "../shared.js";
import {
  ENTITY_COLLECTIONS,
  isEntityCollection,
  type EntityCollection,
  type ListParams,
} from "../../client/types.js";

/**
 * commander argument-parser for the `<entity>` positional. Validating here (as
 * opposed to inside the action) means an unknown entity surfaces as a commander
 * usage error (exit code 2) with the list of valid names, rather than a generic
 * runtime error.
 */
function entityArg(value: string): EntityCollection {
  if (!isEntityCollection(value)) {
    throw new InvalidArgumentError(
      `Unknown entity "${value}". Valid entities: ${ENTITY_COLLECTIONS.join(", ")}.`,
    );
  }
  return value;
}

/**
 * commander value-parser for the `<id>` positional of `get`. The API treats
 * `/<collection>/0` as the collection itself, so `get politicians 0` silently
 * dumped the whole list instead of one entity; a non-numeric id round-tripped to
 * a generic HTTP 500. Validating here rejects both as a usage error (exit 2) with
 * a clear message. Ids are positive integers (the API numbers entities from 1).
 * Leading zeros are dropped: the API looks the id up as a string, so `0002` was
 * "no such entity" although party 2 exists.
 */
function idArg(value: string): string {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError(`Invalid id "${value}". Expected a numeric entity id.`);
  }
  if (/^0+$/.test(value)) {
    throw new InvalidArgumentError(`Invalid id "${value}". Entity ids start at 1.`);
  }
  return value.replace(/^0+/, "");
}

/**
 * commander value-parser for `--sort-direction`. The API only accepts asc/desc
 * and answers anything else with an HTTP 500; validate locally so a typo is a
 * usage error (exit 2) with a clear message.
 */
function sortDirectionArg(value: string): "asc" | "desc" {
  if (value !== "asc" && value !== "desc") {
    throw new InvalidArgumentError(`Invalid sort direction "${value}". Use "asc" or "desc".`);
  }
  return value;
}

/**
 * Valid bracket-filter operators, mirroring the FilterOperator union in
 * client/types.ts. Kept as a runtime list so the CLI can reject an unknown
 * operator locally instead of forwarding it to a generic API HTTP 500.
 */
const FILTER_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "cn", "sw"] as const;

/**
 * Query parameters the `list` options own. As filters they would override the
 * validated `--range-end`/`--sort-direction` (and `count`'s `range_end=1`) and skip
 * their checks, so they are rejected with a pointer to the option.
 */
const RESERVED_FILTER_FIELDS = new Map([
  ["range_start", "--range-start"],
  ["range_end", "--range-end"],
  ["sort_by", "--sort-by"],
  ["sort_direction", "--sort-direction"],
]);

/** A filter key: a field name, optionally followed by one `[op]` suffix. */
const FILTER_KEY = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?$/;

/**
 * commander value-parser for one `key=value` token of the variadic `[filters...]`
 * argument. Validating here — at parse time — means a malformed filter surfaces as
 * a commander usage error (exit 2) with its guidance printed to stderr, exactly
 * like a bad entity or a bad --range-end. Throwing the same error later, from
 * inside the action (as parseFilters alone did), leaves the message unprinted:
 * commander has already finished parsing, so run.ts maps it to exit 2 but never
 * writes it.
 *
 * Tokens are accumulated and returned verbatim; the action's parseFilters builds
 * the filters object from these already-validated tokens.
 */
function filterArg(value: string, previous: string[] = []): string[] {
  const eq = value.indexOf("=");
  if (eq <= 0) {
    throw new InvalidArgumentError(
      `Invalid filter "${value}". Use key=value, e.g. sex=f or 'year_of_birth[gt]=1990'.`,
    );
  }
  // Reject an exact repeated key. parseFilters builds a plain object, so a
  // duplicate would otherwise silently win last (`sex=f sex=m` -> sex=m) with no
  // warning. Distinct operators on the same field are different keys
  // (`year_of_birth[gt]` vs `year_of_birth[lt]`) and remain allowed.
  const key = value.slice(0, eq);
  // A blank key or value (`sex=`, `sex= `, ` =f`, often an unset shell
  // variable) would be sent as an empty parameter, so the command ran
  // effectively unfiltered and exited 0. A blank filter is never meaningful.
  if (key.trim() === "" || value.slice(eq + 1).trim() === "") {
    throw new InvalidArgumentError(
      `Invalid filter "${value}". Both key and value must be non-empty, e.g. sex=f.`,
    );
  }
  // The key is a field name, optionally followed by one bracket operator. The API
  // silently ignores anything else: a bare `[gt]=1990` drops the filter entirely
  // (the unfiltered total, exit 0) and `field[gt]x` loses the trailing text.
  const parts = FILTER_KEY.exec(key);
  if (!parts) {
    throw new InvalidArgumentError(
      `Invalid filter key "${key}". Use a field name, optionally with one operator: ` +
        `sex=f or 'year_of_birth[gt]=1990'.`,
    );
  }
  const reserved = RESERVED_FILTER_FIELDS.get(parts[1] ?? "");
  if (reserved !== undefined) {
    throw new InvalidArgumentError(
      `"${parts[1]}" is a paging or sorting parameter, not a filter. Use ${reserved} on list instead.`,
    );
  }
  // If the key carries a bracket operator (`field[op]`), validate the operator
  // against the known set so a typo (`last_name[zz]`) is caught here rather than
  // surfacing as an opaque API HTTP 500. A plain field or related-entity id has
  // no bracket and is passed through untouched.
  const op = parts[2];
  if (op !== undefined) {
    if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
      throw new InvalidArgumentError(
        `Unknown filter operator "[${op}]" in "${key}". Valid operators: ${FILTER_OPERATORS.join(", ")}.`,
      );
    }
  }
  const previousKeys = previous.map((token) => token.slice(0, token.indexOf("=")));
  if (previousKeys.includes(key)) {
    throw new InvalidArgumentError(
      `Duplicate filter key "${key}". Specify each field (and operator) at most once.`,
    );
  }
  // A plain key and a bracket key on the same field (`year_of_birth=1990` plus
  // `year_of_birth[gt]=2000`) are different keys, but the API parses them into one
  // parameter and keeps only the last, so one filter would be dropped silently.
  const field = filterField(key);
  const clash = previousKeys.find(
    (prev) => filterField(prev) === field && (prev === field || key === field),
  );
  if (clash !== undefined) {
    throw new InvalidArgumentError(
      `Conflicting filters "${clash}" and "${key}": the API keeps only one of a plain and a ` +
        `bracket filter on the same field. Use operators only, e.g. '${field}[eq]=…'.`,
    );
  }
  return [...previous, value];
}

/** The field name of a filter key: `year_of_birth[gt]` -> `year_of_birth`. */
function filterField(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

/** Build ListParams from this command's parsed options + positional filters. */
function listParamsFrom(opts: Record<string, unknown>, filterArgs: string[]): ListParams {
  const params: ListParams = {};
  if (opts["rangeStart"] !== undefined) params.rangeStart = opts["rangeStart"] as number;
  if (opts["rangeEnd"] !== undefined) params.rangeEnd = opts["rangeEnd"] as number;
  if (opts["sortBy"] !== undefined) params.sortBy = opts["sortBy"] as string;
  if (opts["sortDirection"] !== undefined) {
    params.sortDirection = opts["sortDirection"] as "asc" | "desc";
  }
  const filters = parseFilters(filterArgs);
  if (Object.keys(filters).length > 0) params.filters = filters;
  return params;
}

export function registerEntityCommands(program: Command, deps: CliDeps): void {
  program
    .command("list")
    .description("List a collection, with optional filters, sorting and paging")
    .argument("<entity>", `entity collection (${ENTITY_COLLECTIONS.length} available; see 'entities')`, entityArg)
    .argument("[filters...]", "field filters as key=value, e.g. sex=f 'year_of_birth[gt]=1990'", filterArg)
    .option("--range-start <n>", "0-based offset of the first item", parseIntArg)
    .option(
      "--range-end <n>",
      "page size (number of items; API honours up to 1000, else falls back to 100)",
      parseIntArg,
    )
    .option("--sort-by <field>", "field name to sort by (e.g. last_name, id)", parseNonEmpty)
    .option("--sort-direction <dir>", "asc or desc", sortDirectionArg)
    .option("--data-only", "print just the data array (not the meta envelope)")
    .addHelpText(
      "after",
      "\nFilter operators use a bracket suffix: field[op]=value with op one of " +
        "eq, ne, gt, gte, lt, lte, cn (contains), sw (starts-with).\n" +
        "Filter by a related entity with its id, e.g. `list votes poll=6569`.\n" +
        "Examples:\n" +
        "  abgeordnetenwatch list politicians sex=f --sort-by last_name --range-end 5\n" +
        "  abgeordnetenwatch list votes poll=6569 --data-only",
    )
    .action(
      action(deps, async ({ client, global, opts }, positionals) => {
        const entity = positionals[0] as EntityCollection;
        const filterArgs = (positionals[1] as unknown as string[] | undefined) ?? [];
        const res = await client.list(entity, listParamsFrom(opts, filterArgs));
        renderJson(deps, global, opts["dataOnly"] ? res.data : res);
      }),
    );

  program
    .command("get")
    .description("Fetch a single entity by id")
    .argument("<entity>", "entity collection (see 'entities')", entityArg)
    .argument("<id>", "numeric entity id", idArg)
    .option("--data-only", "print just the data object (not the meta envelope)")
    .action(
      action(deps, async ({ client, global, opts }, positionals) => {
        const entity = positionals[0] as EntityCollection;
        const id = positionals[1] as string;
        const res = await client.get(entity, id);
        renderJson(deps, global, opts["dataOnly"] ? res.data : res);
      }),
    );

  program
    .command("count")
    .description("Count how many entities match the given filters")
    .argument("<entity>", "entity collection (see 'entities')", entityArg)
    .argument("[filters...]", "field filters as key=value", filterArg)
    .action(
      action(deps, async ({ client, global, opts }, positionals) => {
        const entity = positionals[0] as EntityCollection;
        const filterArgs = (positionals[1] as unknown as string[] | undefined) ?? [];
        const total = await client.count(entity, listParamsFrom(opts, filterArgs));
        renderJson(deps, global, { entity, total });
      }),
    );

  program
    .command("entities")
    .description("List the available entity collections")
    .action(
      action(deps, async ({ global }) => {
        renderJson(deps, global, { entities: [...ENTITY_COLLECTIONS] });
      }),
    );
}
