import { InvalidArgumentError, type Command } from "commander";
import type { CliDeps } from "../io.js";
import { quoteValue } from "../../client/errors.js";
import { action, parseFilters, parseIntArg, parseNonEmpty, renderJson } from "../shared.js";
import {
  ENTITY_COLLECTIONS,
  isEntityCollection,
  type EntityCollection,
  type ListParams,
  type SortDirection,
} from "../../client/types.js";
import {
  entityIdProblem,
  normalizeEntityId,
  sortDirectionProblem,
  sortPairProblem,
} from "../../client/validate.js";
import {
  RESERVED_FILTER_FIELDS,
  filterBlankProblem,
  filterClashProblem,
  filterField,
  filterKeyProblem,
  filterOperatorProblem,
  reservedFilterProblem,
} from "../../client/filters.js";

/**
 * commander argument-parser for the `<entity>` positional. Validating here (as
 * opposed to inside the action) means an unknown entity surfaces as a commander
 * usage error (exit code 2) with the list of valid names, rather than a generic
 * runtime error.
 */
function entityArg(value: string): EntityCollection {
  if (!isEntityCollection(value)) {
    throw new InvalidArgumentError(
      `Unknown entity "${quoteValue(value)}". Valid entities: ${ENTITY_COLLECTIONS.join(", ")}.`,
    );
  }
  return value;
}

/**
 * commander value-parser for the `<id>` positional of `get`: the library's id rule
 * (entityIdProblem) as a usage error (exit 2), and its canonical form
 * (normalizeEntityId, leading zeros dropped) as the value.
 */
function idArg(value: string): string {
  const reason = entityIdProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(`Invalid id "${quoteValue(value)}". ${reason}`);
  return normalizeEntityId(value);
}

/**
 * commander value-parser for `--sort-direction`: the library's rule
 * (sortDirectionProblem: asc or desc, else the API answers HTTP 500) as a usage
 * error (exit 2).
 */
function sortDirectionArg(value: string): SortDirection {
  const reason = sortDirectionProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(`Invalid sort direction "${quoteValue(value)}". ${reason}`);
  return value as SortDirection;
}

/** The `list` option that owns each reserved filter name, for the usage hint. */
const RESERVED_FILTER_OPTIONS: Record<(typeof RESERVED_FILTER_FIELDS)[number], string> = {
  range_start: "--range-start",
  range_end: "--range-end",
  sort_by: "--sort-by",
  sort_direction: "--sort-direction",
};

/**
 * commander value-parser for one `key=value` token of the variadic `[filters...]`
 * argument. Validating here — at parse time — means a malformed filter surfaces as
 * a commander usage error (exit 2) with its guidance printed to stderr, exactly
 * like a bad entity or a bad --range-end. Throwing the same error later, from
 * inside the action (as parseFilters alone did), leaves the message unprinted:
 * commander has already finished parsing, so run.ts maps it to exit 2 but never
 * writes it.
 *
 * The filter rules are the library's (client/filters.ts); this parser only adds
 * what argv needs: the split at the first `=`, the check for an exact repeated key
 * (a filters object cannot hold one), and the CLI's wording.
 *
 * Tokens are accumulated and returned verbatim; the action's parseFilters builds
 * the filters object from these already-validated tokens.
 */
function filterArg(value: string, previous: string[] = []): string[] {
  const eq = value.indexOf("=");
  if (eq <= 0) {
    throw new InvalidArgumentError(
      `Invalid filter "${quoteValue(value)}". Use key=value, e.g. sex=f or 'year_of_birth[gt]=1990'.`,
    );
  }
  const key = value.slice(0, eq);
  const blank = filterBlankProblem([key, value.slice(eq + 1)]);
  if (blank !== undefined) throw new InvalidArgumentError(`Invalid filter "${quoteValue(value)}". ${blank}`);
  const shape = filterKeyProblem(key);
  if (shape !== undefined) throw new InvalidArgumentError(`Invalid filter key "${quoteValue(key)}". ${shape}`);
  const reserved = reservedFilterProblem(key);
  if (reserved !== undefined) {
    const option = RESERVED_FILTER_OPTIONS[filterField(key) as keyof typeof RESERVED_FILTER_OPTIONS];
    throw new InvalidArgumentError(`${reserved} Use ${option} on list instead.`);
  }
  const operator = filterOperatorProblem(key);
  if (operator !== undefined) throw new InvalidArgumentError(operator);
  // Reject an exact repeated key. parseFilters builds a plain object, so a
  // duplicate would otherwise silently win last (`sex=f sex=m` -> sex=m) with no
  // warning. Distinct operators on the same field are different keys
  // (`year_of_birth[gt]` vs `year_of_birth[lt]`) and remain allowed.
  const previousKeys = previous.map((token) => token.slice(0, token.indexOf("=")));
  if (previousKeys.includes(key)) {
    throw new InvalidArgumentError(
      `Duplicate filter key "${quoteValue(key)}". Specify each field (and operator) at most once.`,
    );
  }
  const clash = filterClashProblem([...previousKeys, key]);
  if (clash !== undefined) throw new InvalidArgumentError(clash);
  return [...previous, value];
}

/** Build ListParams from this command's parsed options + positional filters. */
function listParamsFrom(opts: Record<string, unknown>, filterArgs: string[]): ListParams {
  const params: ListParams = {};
  if (opts["rangeStart"] !== undefined) params.rangeStart = opts["rangeStart"] as number;
  if (opts["rangeEnd"] !== undefined) params.rangeEnd = opts["rangeEnd"] as number;
  if (opts["sortBy"] !== undefined) params.sortBy = opts["sortBy"] as string;
  if (opts["sortDirection"] !== undefined) {
    params.sortDirection = opts["sortDirection"] as SortDirection;
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
    .option(
      "--sort-direction <dir>",
      "asc or desc; needs --sort-by, which alone sorts desc",
      sortDirectionArg,
    )
    .option("--data-only", "print just the data array (not the meta envelope)")
    .hook("preAction", (command) => {
      // The library's cross-option rule (sortPairProblem), in flag wording.
      if (sortPairProblem(listParamsFrom(command.opts(), [])) !== undefined) {
        command.error("error: --sort-direction needs --sort-by (the API rejects it on its own).");
      }
    })
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
