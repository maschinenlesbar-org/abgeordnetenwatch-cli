import { InvalidArgumentError, type Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseFilters, parseIntArg, renderJson } from "../shared.js";
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
 */
function idArg(value: string): string {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError(`Invalid id "${value}". Expected a numeric entity id.`);
  }
  if (/^0+$/.test(value)) {
    throw new InvalidArgumentError(`Invalid id "${value}". Entity ids start at 1.`);
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
  // If the key carries a bracket operator (`field[op]`), validate the operator
  // against the known set so a typo (`last_name[zz]`) is caught here rather than
  // surfacing as an opaque API HTTP 500. A plain field or related-entity id has
  // no bracket and is passed through untouched.
  const bracket = /\[([^\]]*)\]$/.exec(key);
  if (bracket) {
    const op = bracket[1] ?? "";
    if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
      throw new InvalidArgumentError(
        `Unknown filter operator "[${op}]" in "${key}". Valid operators: ${FILTER_OPERATORS.join(", ")}.`,
      );
    }
  }
  if (previous.some((token) => token.slice(0, token.indexOf("=")) === key)) {
    throw new InvalidArgumentError(
      `Duplicate filter key "${key}". Specify each field (and operator) at most once.`,
    );
  }
  return [...previous, value];
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
    .option("--range-end <n>", "page size (number of items; API caps at 100)", parseIntArg)
    .option("--sort-by <field>", "field name to sort by (e.g. last_name, id)")
    .option("--sort-direction <dir>", "asc or desc")
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
