// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, the filter parser, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { EngineOptions } from "../client/engine.js";

/**
 * commander value-parser: a non-negative decimal integer.
 *
 * Strict by design — only a plain run of ASCII digits is accepted. This rejects
 * the values `Number()` would otherwise silently coerce: hex/binary/octal
 * literals, scientific notation, a leading `+`, surrounding whitespace, and the
 * empty string. Values beyond `Number.MAX_SAFE_INTEGER` are rejected too.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(
      `Value out of range; must be between 0 and ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return n;
}

/**
 * commander value-parser for `--user-agent`. Control characters (notably CR/LF)
 * are illegal in an HTTP header value: node's http layer throws a low-level
 * TypeError when the request is built, which previously surfaced to the user as
 * an opaque "Unexpected error". Reject them up front as a usage error; this also
 * forecloses header injection via the User-Agent value. Checked by char code so
 * no control-character literal need appear in the source.
 */
export function parseUserAgentArg(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new InvalidArgumentError(
        "Control characters (including CR/LF) are not allowed in --user-agent.",
      );
    }
  }
  return value;
}

/**
 * Parse positional `key=value` filter arguments into a filters object.
 *
 * The key may carry a bracket operator (`year_of_birth[gt]=1990`) or be a plain
 * field / related-entity id (`sex=f`, `politician=184945`); both pass through
 * verbatim to the query string. The value keeps everything after the first `=`,
 * so values may themselves contain `=`. A missing `=` or empty key is an error.
 */
export function parseFilters(args: string[]): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      throw new InvalidArgumentError(
        `Invalid filter "${arg}". Use key=value, e.g. sex=f or 'year_of_birth[gt]=1990'.`,
      );
    }
    filters[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return filters;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
