import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(args, { cwd, signal, onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    // No auto gc/maintenance: it can detach into the background and race with cleanup
    const child = spawn("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
      cwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const out = [];
    let errTail = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      const text = d.toString("utf8");
      errTail = (errTail + text).slice(-4000);
      // git redraws progress with \r, so split on both
      if (onStderrLine) for (const line of text.split(/[\r\n]+/)) if (line) onStderrLine(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString("utf8"));
      const lines = errTail.split(/[\r\n]+/).filter((l) => l && !/^\S.*:\s+\d+%/.test(l));
      reject(new Error(lines.at(-1)?.replace(/^fatal: /, "") || `git exited ${code}`));
    });
  });
}

const PROGRESS = /^(?:remote: )?([A-Za-z ]+?):\s+(\d+)%/;
const TRAILER_PERSON = /^"?(.*?)"?\s*<([^<>\s]+@[^<>\s]+)>$/;
// Trailers that name people without them having contributed to the commit
const NON_CONTRIBUTOR_TRAILERS = new Set(["cc", "bcc", "to"]);

// Trailers from a raw commit message: the "Key: value" lines of its last paragraph, joined by \x1f
// to match git's %(trailers:only,unfold,separator=%x1f)
export function messageTrailers(message) {
  const paragraphs = message.trim().split(/\n\s*\n/);
  if (paragraphs.length < 2) return "";
  const lines = paragraphs.at(-1).split("\n");
  return lines.every((l) => /^[\w-]+:\s/.test(l) || /^\s/.test(l)) ? lines.join("\x1f") : "";
}

// "Co-authored-by: Name <email>" → ["co-authored-by", "Name", "email"]
function parseTrailers(raw, skip) {
  const people = [];
  for (const trailer of raw.split("\x1f")) {
    const colon = trailer.indexOf(":");
    if (colon < 1) continue;
    const key = trailer.slice(0, colon).trim().toLowerCase();
    if (NON_CONTRIBUTOR_TRAILERS.has(key) || skip.has(key) || skip.has(key.replace(/-by$/, ""))) continue;
    const m = TRAILER_PERSON.exec(trailer.slice(colon + 1).trim());
    if (m) people.push([key, m[1], m[2]]);
  }
  return people;
}

// Counts each commit once (by hash) and credits everyone in it: the author, the committer if different,
// and people named in trailers (Co-authored-by, Signed-off-by, …) unless `trailers` is false.
// `skipTrailers` holds trailer keys to ignore, with or without the "-by" suffix.
export function createTally({ trailers = true, skipTrailers = [] } = {}) {
  const skip = new Set(skipTrailers.map((t) => t.toLowerCase()));
  const seen = new Set();
  const identities = new Map();

  return {
    trailers,
    identities,
    get commits() {
      return seen.size;
    },
    // Returns false if the commit was already counted
    add({ sha, repo, authorName, authorEmail, committerName, committerEmail, trailers: rawTrailers }) {
      if (seen.has(sha)) return false;
      seen.add(sha);

      // Each person counts once per commit, but every role they had in it is recorded
      const people = new Map();
      const credit = (role, name, email) => {
        const key = `${name}\0${email}`;
        if (!people.has(key)) people.set(key, { name, email, roles: new Set() });
        people.get(key).roles.add(role);
      };
      credit("author", authorName, authorEmail);
      if (committerName !== authorName || committerEmail !== authorEmail) {
        credit("committer", committerName, committerEmail);
      }
      if (trailers && rawTrailers) {
        for (const [role, name, email] of parseTrailers(rawTrailers, skip)) credit(role, name, email);
      }

      for (const { name, email, roles } of people.values()) {
        const key = `${name}\0${email}`;
        let entry = identities.get(key);
        if (!entry)
          identities.set(key, (entry = { name, email, commits: 0, roles: new Map(), repos: new Map() }));
        entry.commits++;
        entry.repos.set(repo, (entry.repos.get(repo) ?? 0) + 1);
        for (const role of roles) entry.roles.set(role, (entry.roles.get(role) ?? 0) + 1);
      }
      return true;
    },
    sorted() {
      return [...identities.values()].sort((a, b) => b.commits - a.commits || a.email.localeCompare(b.email));
    },
  };
}

// Clones every repo (bare, no trees) with a worker pool and adds their commits to `tally`.
// `state` is mutated live so a UI can poll it; `promise` resolves when every repo is done.
export function scan(repos, { tally, jobs = 8, signal } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gh-identities-"));
  const remove = (path) => {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  };
  const cleanup = () => remove(dir);
  process.once("exit", cleanup);

  const state = {
    total: repos.length,
    done: 0,
    active: new Map(),
    failed: [],
    startedAt: Date.now(),
    finishedAt: null,
  };
  let next = 0;

  const processRepo = async (repo) => {
    const job = { name: repo.name, phase: "starting", percent: null, startedAt: Date.now() };
    state.active.set(repo.full_name, job);
    try {
      const target = join(dir, `${repo.name}.git`);
      await git(["clone", "--bare", "--filter=tree:0", "--progress", repo.clone_url, target], {
        signal,
        onStderrLine: (line) => {
          const m = PROGRESS.exec(line);
          if (m) {
            const phase = m[1].replace(/ objects$/, "").toLowerCase();
            if (phase !== job.phase) job.phaseStartedAt = Date.now();
            job.phase = phase;
            job.percent = Number(m[2]);
          }
        },
      });
      job.phase = "reading log";
      job.percent = null;
      // NUL-separated fields, records ended by \x1e: hash, author name/email, committer name/email,
      // then trailers separated by \x1f
      const format = `%H%x00%an%x00%ae%x00%cn%x00%ce%x00${tally.trailers ? "%(trailers:only,unfold,separator=%x1f)" : ""}%x1e`;
      const log = await git(["log", "--all", `--format=${format}`], { cwd: target, signal });
      for (const record of log.split("\x1e")) {
        const [sha, an, ae, cn, ce, rawTrailers] = record.replace(/^\n/, "").split("\0");
        if (!sha) continue;
        // add() skips commits already counted, e.g. the same commit in multiple repos
        tally.add({
          sha,
          repo: repo.full_name,
          authorName: an,
          authorEmail: ae,
          committerName: cn,
          committerEmail: ce,
          trailers: rawTrailers,
        });
      }
      remove(target);
    } catch (err) {
      if (signal?.aborted) throw err;
      state.failed.push({ repo: repo.full_name, error: err.message });
    } finally {
      state.active.delete(repo.full_name);
      state.done++;
    }
  };

  const worker = async () => {
    while (next < repos.length && !signal?.aborted) await processRepo(repos[next++]);
  };

  // allSettled so that on abort every git process has exited before the temp dir is removed
  const promise = Promise.allSettled(Array.from({ length: Math.min(jobs, repos.length) }, worker))
    .then((outcomes) => {
      const rejected = outcomes.find((o) => o.status === "rejected");
      if (rejected) throw rejected.reason;
      state.finishedAt = Date.now();
      return {
        repos: state.total - state.failed.length,
        failed: state.failed,
        duration: state.finishedAt - state.startedAt,
      };
    })
    .finally(() => {
      cleanup();
      process.off("exit", cleanup);
    });

  return { state, promise };
}

// GitHub's generated addresses: web commits/merges and the per-user privacy address
const NOREPLY = /^noreply@github\.com$|@users\.noreply\.github\.com$/i;
export const isNoreply = (email) => NOREPLY.test(email);

const byCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

// Collapse name+email pairs into groups keyed by email or by name.
// `roles` and `repos` become [[key, commits], ...], most commits first.
export function group(identities, mode) {
  if (mode === "pair") {
    return identities.map((i) => ({
      key: `${i.name}\0${i.email}`,
      names: [i.name],
      emails: [i.email],
      commits: i.commits,
      roles: byCount(i.roles),
      repos: byCount(i.repos),
    }));
  }
  const keyOf = mode === "email" ? (i) => i.email.toLowerCase() : (i) => i.name;
  const groups = new Map();
  for (const i of identities) {
    const key = keyOf(i);
    let g = groups.get(key);
    if (!g)
      groups.set(
        key,
        (g = { key, names: new Map(), emails: new Map(), commits: 0, roles: new Map(), repos: new Map() }),
      );
    g.commits += i.commits;
    g.names.set(i.name, (g.names.get(i.name) ?? 0) + i.commits);
    g.emails.set(i.email, (g.emails.get(i.email) ?? 0) + i.commits);
    for (const [repo, n] of i.repos) g.repos.set(repo, (g.repos.get(repo) ?? 0) + n);
    for (const [role, n] of i.roles) g.roles.set(role, (g.roles.get(role) ?? 0) + n);
  }
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      names: byCount(g.names).map(([k]) => k),
      emails: byCount(g.emails).map(([k]) => k),
      commits: g.commits,
      roles: byCount(g.roles),
      repos: byCount(g.repos),
    }))
    .sort((a, b) => b.commits - a.commits || a.key.localeCompare(b.key));
}
