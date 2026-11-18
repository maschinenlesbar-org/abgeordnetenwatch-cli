// Smoke-test a CLI image the way users run it: read-only, no capabilities, an arbitrary uid,
// bounded memory and processes. What is repo-specific (a request command and the mock's
// answers) is in tools/image/smoke.json.
//
//   node tools/image/smoke.mjs --app cli --image 127.0.0.1:5000/abgeordnetenwatch-cli@sha256:…
//
// Checks: --version is the image's version label; --help exits 0; with --network none the
// command fails with the network exit code and exactly one ERROR record on stderr; against a
// mock upstream on an internal network the command succeeds; `docker stop` ends a call that
// waits on the upstream within 5 s with 143 (SIGTERM), not the kill after 10 s.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerEnv, fail, here, parseArgs, run } from "./docker.mjs";

const args = parseArgs(process.argv.slice(2), ["app", "image"]);
if (args.app !== "cli") fail(`no smoke test for --app ${args.app} yet`);
const config = JSON.parse(readFileSync(args.config ?? join(here, "smoke.json"), "utf8"));
const env = dockerEnv();
const image = args.image;
const id = randomBytes(4).toString("hex");
const network = `smoke-${id}`;
const mock = `smoke-mock-${id}`;
const waiting = `smoke-stop-${id}`;
const hardened = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--pids-limit", "64", "--user", "12345:12345"];
const docker = (dockerArgs, options = {}) => run("docker", dockerArgs, { env, ...options });
const ok = (label) => process.stdout.write(`ok ${label}\n`);
const check = (label, condition, detail) => (condition ? ok(label) : fail(`${label}: ${detail}`));

// The mock answers each path in config.answers on port 8080 and never answers on port 8081.
const MOCK = `
const http = require("node:http");
const answers = JSON.parse(process.env.MOCK_ANSWERS);
http.createServer((req, res) => {
  const body = answers[new URL(req.url, "http://mock").pathname];
  res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify(body ?? { error: "no such path" }));
}).listen(8080);
http.createServer((req) => console.log("waiting " + req.url)).listen(8081, () => console.log("ready"));
`;

function waitForLog(container, text) {
  for (let i = 0; i < 100; i += 1) {
    if (docker(["logs", container], { allowFail: true }).stdout.includes(text)) return;
    run("sleep", ["0.1"]);
  }
  fail(`${container} never logged ${JSON.stringify(text)}`);
}

// An image loaded from an archive (the arm64 check) is already there and has no registry.
if (docker(["image", "inspect", image], { allowFail: true }).status !== 0) docker(["pull", "--quiet", image]);
try {
  const version = docker(["image", "inspect", "--format", '{{ index .Config.Labels "org.opencontainers.image.version" }}', image]).stdout.trim();
  const printed = docker(["run", "--rm", ...hardened, image, "--version"], { allowFail: true });
  check("--version", printed.status === 0 && printed.stdout.trim() === version, `exit ${printed.status}, printed ${JSON.stringify(printed.stdout)}, label ${version}`);

  const help = docker(["run", "--rm", ...hardened, image, "--help"], { allowFail: true });
  check("--help", help.status === 0 && help.stdout.includes("Usage:"), `exit ${help.status}`);

  const offline = docker(["run", "--rm", ...hardened, "--network", "none", image, ...config.command], { allowFail: true });
  const records = offline.stderr.trim().split("\n");
  const record = new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+Z ERROR \\[${config.bin}\\.\\w+\\] `);
  check(
    "no network: the network exit code and one ERROR record",
    offline.status === config.networkErrorExit && records.length === 1 && record.test(records[0]),
    `exit ${offline.status}, stderr ${JSON.stringify(offline.stderr)}`,
  );

  docker(["network", "create", "--internal", network]);
  docker([
    "run", "--detach", "--name", mock, "--network", network, "--network-alias", "mock", ...hardened,
    "--entrypoint", "/nodejs/bin/node", "--env", `MOCK_ANSWERS=${JSON.stringify(config.answers)}`, image, "-e", MOCK,
  ]);
  waitForLog(mock, "ready");

  const answered = docker(["run", "--rm", ...hardened, "--network", network, image, "--base-url", "http://mock:8080", ...config.command], { allowFail: true });
  check("a request to the mock upstream", answered.status === 0 && answered.stdout.includes(config.expectStdout), `exit ${answered.status}, stdout ${JSON.stringify(answered.stdout.slice(0, 300))}, stderr ${JSON.stringify(answered.stderr.slice(0, 300))}`);

  docker(["run", "--detach", "--name", waiting, ...hardened, "--network", network, image, "--base-url", "http://mock:8081", ...config.command]);
  waitForLog(mock, "waiting");
  const started = Date.now();
  docker(["stop", "--time", "10", waiting]);
  const took = Date.now() - started;
  const exitCode = Number(docker(["inspect", "--format", "{{ .State.ExitCode }}", waiting]).stdout.trim());
  check("docker stop ends a waiting call with SIGTERM's 143, in under 5 s", exitCode === 143 && took < 5000, `exit ${exitCode} after ${took} ms`);
} finally {
  docker(["rm", "--force", mock, waiting], { allowFail: true });
  docker(["network", "rm", network], { allowFail: true });
}
