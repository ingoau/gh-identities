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

// Clones every repo (bare, no trees) with a worker pool and tallies commit identities.
// `state` is mutated live so a UI can poll it; `promise` resolves with the final result.
export function scan(repos, { jobs = 8, signal } = {}) {
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
    commits: 0,
    active: new Map(),
    failed: [],
    identities: new Map(),
    startedAt: Date.now(),
    finishedAt: null,
  };
  const seen = new Set();
  let next = 0;

  const add = (name, email, repo) => {
    const key = `${name}\0${email}`;
    let entry = state.identities.get(key);
    if (!entry) state.identities.set(key, (entry = { name, email, commits: 0, repos: new Map() }));
    entry.commits++;
    entry.repos.set(repo, (entry.repos.get(repo) ?? 0) + 1);
  };

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
      // NUL-separated fields, one commit per line: hash, author name/email, committer name/email
      const log = await git(["log", "--all", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce"], {
        cwd: target,
        signal,
      });
      for (const line of log.split("\n")) {
        if (!line) continue;
        const [hash, an, ae, cn, ce] = line.split("\0");
        if (seen.has(hash)) continue; // same commit can appear in multiple repos
        seen.add(hash);
        state.commits++;
        add(an, ae, repo.name);
        if (cn !== an || ce !== ae) add(cn, ce, repo.name);
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
      const identities = [...state.identities.values()].sort(
        (a, b) => b.commits - a.commits || a.email.localeCompare(b.email),
      );
      return {
        identities,
        commits: state.commits,
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

const byCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

// Collapse name+email pairs into groups keyed by email or by name.
// `repos` becomes [[repoName, commits], ...], most commits first.
export function group(identities, mode) {
  if (mode === "pair") {
    return identities.map((i) => ({
      key: `${i.name}\0${i.email}`,
      names: [i.name],
      emails: [i.email],
      commits: i.commits,
      repos: byCount(i.repos),
    }));
  }
  const keyOf = mode === "email" ? (i) => i.email.toLowerCase() : (i) => i.name;
  const groups = new Map();
  for (const i of identities) {
    const key = keyOf(i);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, names: new Map(), emails: new Map(), commits: 0, repos: new Map() }));
    g.commits += i.commits;
    g.names.set(i.name, (g.names.get(i.name) ?? 0) + i.commits);
    g.emails.set(i.email, (g.emails.get(i.email) ?? 0) + i.commits);
    for (const [repo, n] of i.repos) g.repos.set(repo, (g.repos.get(repo) ?? 0) + n);
  }
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      names: byCount(g.names).map(([k]) => k),
      emails: byCount(g.emails).map(([k]) => k),
      commits: g.commits,
      repos: byCount(g.repos),
    }))
    .sort((a, b) => b.commits - a.commits || a.key.localeCompare(b.key));
}
