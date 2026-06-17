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
    .argument("[filters...]", "field filters as key=value, e.g. sex=f 'year_of_birth[gt]=1990'")
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
    .argument("<id>", "numeric entity id")
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
    .argument("[filters...]", "field filters as key=value")
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
