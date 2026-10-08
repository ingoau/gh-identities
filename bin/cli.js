#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const PAGE_SIZE = 10;
const CONCURRENCY = 6;

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2);
const bold = c(1);
const cyan = c(36);
const yellow = c(33);

function usage() {
  console.log(`Usage: gh-identities [username] [--include-forks]

Clones every public, non-fork repo of a GitHub user (bare, tree-less) and lists the
names and emails used to commit, most used first.

Options:
  --include-forks  Also clone forked repositories
  -h, --help       Show this help

Set GITHUB_TOKEN (or GH_TOKEN) to raise the GitHub API rate limit.`);
}

function status(msg) {
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${msg}`);
}

function clearStatus() {
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
}

async function askUsername() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("GitHub username: ");
  rl.close();
  return answer.trim();
}

async function fetchRepos(username) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "gh-identities",
    ...(token && { Authorization: `Bearer ${token}` }),
  };
  const repos = [];
  for (let page = 1; ; page++) {
    status(`Fetching repo list… ${repos.length}`);
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&type=owner&page=${page}`,
      { headers },
    );
    if (res.status === 404) throw new Error(`GitHub user "${username}" not found`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`GitHub API error ${res.status}: ${body.message ?? res.statusText}`);
    }
    const batch = await res.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  clearStatus();
  return repos;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `${cmd} exited ${code}`));
    });
  });
}

async function cloneAndLog(repo, dir) {
  const target = join(dir, `${repo.name}.git`);
  await run("git", ["clone", "--bare", "--filter=tree:0", "--quiet", repo.clone_url, target]);
  // NUL-separated fields, one commit per line: hash, author name/email, committer name/email
  return run("git", ["log", "--all", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce"], { cwd: target });
}

async function collect(repos, dir) {
  const seen = new Set();
  const counts = new Map();
  const failed = [];
  let done = 0;
  let next = 0;

  const add = (name, email) => {
    const key = `${name}\0${email}`;
    const entry = counts.get(key) ?? { name, email, commits: 0 };
    entry.commits++;
    counts.set(key, entry);
  };

  const worker = async () => {
    while (next < repos.length) {
      const repo = repos[next++];
      try {
        const log = await cloneAndLog(repo, dir);
        for (const line of log.split("\n")) {
          if (!line) continue;
          const [hash, an, ae, cn, ce] = line.split("\0");
          if (seen.has(hash)) continue; // same commit can appear in multiple repos
          seen.add(hash);
          add(an, ae);
          if (cn !== an || ce !== ae) add(cn, ce);
        }
      } catch (err) {
        failed.push({ repo: repo.full_name, error: err.message.split("\n")[0] });
      }
      done++;
      status(`Cloning ${done}/${repos.length} ${dim(repo.name)}`);
    }
  };

  status(`Cloning 0/${repos.length}`);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length) }, worker));
  clearStatus();

  const identities = [...counts.values()].sort(
    (a, b) => b.commits - a.commits || a.email.localeCompare(b.email),
  );
  return { identities, commits: seen.size, failed };
}

function formatRows(rows, start, all) {
  const rankW = String(all.length).length;
  const countW = String(all[0].commits).length;
  const nameW = Math.min(28, Math.max(4, ...all.map((r) => r.name.length)));
  return rows
    .map((r, i) => {
      const name = r.name.length > nameW ? `${r.name.slice(0, nameW - 1)}…` : r.name.padEnd(nameW);
      return `${dim(String(start + i + 1).padStart(rankW))}  ${yellow(String(r.commits).padStart(countW))}  ${bold(name)}  ${cyan(r.email)}`;
    })
    .join("\n");
}

function paginate(identities) {
  let shown = 0;
  const showMore = (n) => {
    const rows = identities.slice(shown, shown + n);
    console.log(formatRows(rows, shown, identities));
    shown += rows.length;
  };

  showMore(PAGE_SIZE);
  if (shown >= identities.length) return Promise.resolve();
  if (!process.stdin.isTTY || !tty) {
    showMore(Infinity);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const prompt = () =>
      process.stdout.write(
        dim(`-- ${shown}/${identities.length} -- `) +
          `${bold("space")} more  ${bold("a")} all  ${bold("q")} quit`,
      );
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onKey);
      resolve();
    };
    const onKey = (buf) => {
      const key = buf.toString();
      process.stdout.write("\r\x1b[2K");
      if (key === "q" || key === "Q" || key === "\x1b" || key === "\x03") return finish();
      if (key === " " || key === "\r" || key === "\n" || key === "j" || key === "\x1b[B") showMore(PAGE_SIZE);
      else if (key === "a" || key === "A") showMore(Infinity);
      if (shown >= identities.length) return finish();
      prompt();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
    prompt();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) return usage();
  const includeForks = args.includes("--include-forks");
  const username = args.find((a) => !a.startsWith("-")) || (await askUsername());
  if (!username) return usage();

  let repos = await fetchRepos(username);
  if (!includeForks) repos = repos.filter((r) => !r.fork);
  if (repos.length === 0) {
    console.log(`No public repos found for ${username}.`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "gh-identities-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  let result;
  try {
    result = await collect(repos, dir);
  } finally {
    cleanup();
  }

  const { identities, commits, failed } = result;
  for (const f of failed) console.error(dim(`skipped ${f.repo}: ${f.error}`));
  console.log(
    `${bold(identities.length)} identities across ${bold(commits)} commits in ${bold(repos.length - failed.length)} repos\n`,
  );
  if (identities.length) await paginate(identities);
}

main().catch((err) => {
  clearStatus();
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
