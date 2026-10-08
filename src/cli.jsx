#!/usr/bin/env node
import { parseArgs } from "node:util";
import { render } from "ink";
import App from "./app.jsx";
import { fetchRepos } from "./github.js";
import { isNoreply, scan } from "./scan.js";

const HELP = `Usage: gh-identities [username] [options]

Clones every public, non-fork repo of a GitHub user (bare, tree-less) and lists
the names and emails used to commit, most used first. Commit authors, committers
and people named in trailers like Co-authored-by or Signed-off-by are counted.

Options:
  --include-forks        Also clone forked repositories
  --no-trailers          Only count commit authors and committers
  --skip-trailer <name>  Ignore one trailer, e.g. signed-off-by (repeatable)
  --show-noreply         Include noreply@github.com and *@users.noreply.github.com
                         (hidden by default; press n to toggle in the results)
  -j, --jobs <n>         Repos to clone in parallel (default 8)
  --json                 Print results as JSON instead of the interactive view
  -h, --help             Show this help

Set GITHUB_TOKEN (or GH_TOKEN) to raise the GitHub API rate limit.`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      "include-forks": { type: "boolean" },
      "no-trailers": { type: "boolean" },
      "skip-trailer": { type: "string", multiple: true },
      "show-noreply": { type: "boolean" },
      jobs: { type: "string", short: "j" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const jobs = Number(values.jobs ?? 8);
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error("--jobs must be a positive integer");
  process.exit(2);
}

const username = positionals[0];
const includeForks = Boolean(values["include-forks"]);
const showNoreply = Boolean(values["show-noreply"]);
const scanOptions = { jobs, trailers: !values["no-trailers"], skipTrailers: values["skip-trailer"] ?? [] };
const controller = new AbortController();

if (process.stdin.isTTY && process.stdout.isTTY && !values.json) {
  const app = render(
    <App
      initialUsername={username}
      includeForks={includeForks}
      showNoreply={showNoreply}
      scanOptions={scanOptions}
      signal={controller.signal}
    />,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  // Stop any git processes still running if the user quit mid-scan
  controller.abort();
} else {
  await runPlain();
}

async function runPlain() {
  if (!username) {
    console.error(`A username is required when not running interactively.\n\n${HELP}`);
    process.exit(2);
  }
  process.on("SIGINT", () => controller.abort());
  const status = (msg) => process.stderr.isTTY && process.stderr.write(`\r\x1b[2K${msg}`);

  try {
    status(`Finding repos for ${username}…`);
    const all = await fetchRepos(username, { signal: controller.signal });
    const repos = includeForks ? all : all.filter((r) => !r.fork);
    const { state, promise } = scan(repos, { ...scanOptions, signal: controller.signal });
    const timer = setInterval(() => status(`Cloning ${state.done}/${state.total}`), 100);
    const result = await promise.finally(() => clearInterval(timer));
    status("");
    for (const f of result.failed) console.error(`skipped ${f.repo}: ${f.error}`);

    const identities = showNoreply ? result.identities : result.identities.filter((i) => !isNoreply(i.email));
    const rows = identities.map((i) => ({
      name: i.name,
      email: i.email,
      commits: i.commits,
      roles: Object.fromEntries([...i.roles].sort((a, b) => b[1] - a[1])),
      repos: Object.fromEntries([...i.repos].sort((a, b) => b[1] - a[1])),
    }));
    if (values.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    const commitsW = String(rows[0]?.commits ?? 0).length;
    const nameW = Math.min(32, Math.max(0, ...rows.map((r) => r.name.length)));
    for (const r of rows) {
      console.log(`${String(r.commits).padStart(commitsW)}  ${r.name.padEnd(nameW)}  ${r.email}`);
    }
  } catch (err) {
    status("");
    if (controller.signal.aborted) process.exit(130);
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
