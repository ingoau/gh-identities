#!/usr/bin/env node
import { parseArgs } from "node:util";
import { render } from "ink";
import App from "./app.jsx";
import { fetchRepos, ghCliToken } from "./github.js";
import { isNoreply } from "./scan.js";
import { run } from "./run.js";

const HELP = `Usage: gh-identities [username] [options]

Clones every public, non-fork repo of a GitHub user (bare, tree-less) and lists
the names and emails used to commit, most used first. Commit authors, committers
and people named in trailers like Co-authored-by or Signed-off-by are counted.

Options:
  --include-forks        Also clone forked repositories
  --in-depth             Also search GitHub for the user's commits in repos they
                         don't own (slow: paced by the search rate limit; use a
                         token). Commits only in the user's forks aren't searched.
  --no-trailers          Only count commit authors and committers
  --skip-trailer <name>  Ignore one trailer, e.g. signed-off-by (repeatable)
  --show-noreply         Include noreply@github.com and *@users.noreply.github.com
                         (hidden by default; press n to toggle in the results)
  --gh-auth              Use the GitHub CLI's token (gh auth token)
  --token <token>        Use this GitHub token
  -j, --jobs <n>         Repos to clone in parallel (default 8)
  --json                 Print results as JSON instead of the interactive view
  -h, --help             Show this help

A token raises the GitHub API rate limit. Without --gh-auth or --token,
GITHUB_TOKEN or GH_TOKEN is used if set.`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      "include-forks": { type: "boolean" },
      "in-depth": { type: "boolean" },
      "no-trailers": { type: "boolean" },
      "skip-trailer": { type: "string", multiple: true },
      "show-noreply": { type: "boolean" },
      "gh-auth": { type: "boolean" },
      token: { type: "string" },
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

let token = values.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
if (values["gh-auth"]) {
  token = ghCliToken();
  if (!token) {
    console.error(
      "--gh-auth: couldn't get a token from the GitHub CLI. Is gh installed and logged in (gh auth login)?",
    );
    process.exit(2);
  }
}

const username = positionals[0];
const includeForks = Boolean(values["include-forks"]);
const showNoreply = Boolean(values["show-noreply"]);
const scanOptions = {
  inDepth: Boolean(values["in-depth"]),
  jobs,
  trailers: !values["no-trailers"],
  skipTrailers: values["skip-trailer"] ?? [],
};
const controller = new AbortController();

if (process.stdin.isTTY && process.stdout.isTTY && !values.json) {
  const app = render(
    <App
      initialUsername={username}
      includeForks={includeForks}
      showNoreply={showNoreply}
      scanOptions={scanOptions}
      token={token}
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
    const all = await fetchRepos(username, { token, signal: controller.signal });
    const repos = includeForks ? all : all.filter((r) => !r.fork);
    if (scanOptions.inDepth && !token) {
      console.error("No GitHub token: search is limited to 10 requests a minute (use --gh-auth or --token)");
    }
    const { clone, search, promise } = run(repos, {
      ...scanOptions,
      username,
      token,
      signal: controller.signal,
    });
    const timer = setInterval(() => {
      let msg = `Cloning ${clone.done}/${clone.total}`;
      if (search) {
        msg += ` · searching ${search.found}/${search.total ?? "?"}`;
        if (search.waitingUntil)
          msg += ` (rate limited, ${Math.ceil((search.waitingUntil - Date.now()) / 1000)}s)`;
      }
      status(msg);
    }, 100);
    const result = await promise.finally(() => clearInterval(timer));
    status("");
    for (const f of result.failed) console.error(`skipped ${f.repo}: ${f.error}`);
    if (result.search?.error) console.error(`search stopped early: ${result.search.error}`);

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
