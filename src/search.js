import { headers } from "./github.js";
import { messageTrailers } from "./scan.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(signal.reason);
      },
      { once: true },
    );
  });

// Primary limits report remaining=0; secondary ("abuse") limits only say so in the message
const isRateLimited = (res, body) =>
  res.status === 429 ||
  res.headers.has("retry-after") ||
  res.headers.get("x-ratelimit-remaining") === "0" ||
  /rate limit/i.test(body.message ?? "");

// When to try again, per GitHub's headers; secondary limits without retry-after need at least a minute
function resetTime(res) {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (retryAfter) return Date.now() + retryAfter * 1000;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset) return reset * 1000 + 1000;
  return Date.now() + 60_000;
}

// Finds commits authored by `username` using the commit search API; with `excludeOwn`, only in repos
// they don't own (those are covered by cloning).
// Search stops at 1,000 results per query, so results are sorted newest first and, after each
// 1,000, the query is repeated for commits at or before the last author date seen.
// `state` is mutated live for the UI; `promise` resolves with { commits, error } and only
// rejects when aborted, so a failed search still returns what it found.
export function searchCommits(username, { token, signal, excludeOwn = true } = {}) {
  const state = { total: null, found: 0, waitingUntil: null, startedAt: Date.now(), finishedAt: null };
  const commits = new Map();
  // total_count counts a commit once per repo it's in, so progress is measured in (commit, repo) results
  const results = new Set();

  const waitForReset = async (res) => {
    state.waitingUntil = resetTime(res);
    await sleep(state.waitingUntil - Date.now(), signal);
    state.waitingUntil = null;
  };

  // Spread requests evenly across the per-minute limit (30 with a token, 10 without):
  // bursting through it trips GitHub's secondary rate limit
  let interval = token ? 2000 : 6000;
  let nextAt = 0;

  const request = async (q, page) => {
    const params = new URLSearchParams({ q, sort: "author-date", order: "desc", per_page: "100", page });
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(nextAt - Date.now(), signal);
      const res = await fetch(`https://api.github.com/search/commits?${params}`, {
        headers: headers(token),
        signal,
      });
      const limit = Number(res.headers.get("x-ratelimit-limit"));
      if (limit) interval = 60_000 / limit;
      nextAt = Date.now() + interval;
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        // The search timed out server-side and may be missing commits; retry before trusting it
        if (body.incomplete_results && attempt < 2) continue;
        if (res.headers.get("x-ratelimit-remaining") === "0") await waitForReset(res);
        return body;
      }
      if ((res.status === 403 || res.status === 429) && isRateLimited(res, body)) {
        await waitForReset(res);
        continue;
      }
      throw new Error(`GitHub search error ${res.status}: ${body.message ?? res.statusText}`);
    }
    throw new Error("GitHub search kept failing; giving up");
  };

  const base = excludeOwn ? `author:${username} -user:${username}` : `author:${username}`;
  const promise = (async () => {
    let error = null;
    try {
      let cutoff = null;
      let strict = false;
      while (true) {
        const q = cutoff ? `${base} author-date:${strict ? "<" : "<="}${cutoff}` : base;
        let seen = 0;
        let added = 0;
        let last = null;
        for (let page = 1; page <= 10; page++) {
          const body = await request(q, String(page));
          state.total ??= body.total_count;
          for (const item of body.items) {
            seen++;
            last = item.commit.author.date;
            results.add(`${item.sha} ${item.repository.full_name}`);
            if (commits.has(item.sha)) continue;
            added++;
            commits.set(item.sha, {
              sha: item.sha,
              repo: item.repository.full_name,
              authorName: item.commit.author.name,
              authorEmail: item.commit.author.email,
              committerName: item.commit.committer.name,
              committerEmail: item.commit.committer.email,
              trailers: messageTrailers(item.commit.message),
            });
          }
          state.found = results.size;
          if (body.items.length < 100) break;
        }
        // Fewer than 1,000 results means this query wasn't capped, so nothing older is left
        if (seen < 1000) break;
        if (added === 0) {
          // Over 1,000 commits share the cutoff second; skip past them rather than loop forever
          if (strict) break;
          strict = true;
        } else {
          strict = false;
          cutoff = last;
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      error = err.message;
    }
    state.finishedAt = Date.now();
    return { commits: [...commits.values()], error };
  })();

  return { state, promise };
}
