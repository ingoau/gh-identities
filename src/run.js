import { createTally, scan } from "./scan.js";
import { searchCommits } from "./search.js";

// Runs the clone scan and, with `inDepth`, a commit search over repos the user doesn't own.
// Search results are merged once both finish, so commits the clone scan already counted are skipped.
// `searchOnly` skips cloning and searches every repo instead.
// Returns live state for the UI plus a promise of the final result.
export function run(repos, { username, inDepth, searchOnly, token, jobs, signal, trailers, skipTrailers }) {
  const startedAt = Date.now();
  const tally = createTally({ trailers, skipTrailers });
  const clone = searchOnly ? null : scan(repos, { tally, jobs, signal });
  const search =
    inDepth || searchOnly ? searchCommits(username, { token, signal, excludeOwn: !searchOnly }) : null;

  const promise = Promise.all([clone?.promise, search?.promise]).then(([cloned, searched]) => {
    let summary = null;
    if (searched) {
      const added = searched.commits.filter((c) => tally.add(c));
      summary = {
        found: searched.commits.length,
        added: added.length,
        repos: new Set(added.map((c) => c.repo)).size,
        error: searched.error,
        duration: search.state.finishedAt - search.state.startedAt,
      };
    }
    return {
      repos: cloned?.repos ?? 0,
      failed: cloned?.failed ?? [],
      cloneDuration: cloned?.duration ?? null,
      identities: tally.sorted(),
      commits: tally.commits,
      search: summary,
      duration: Date.now() - startedAt,
    };
  });
  return { tally, clone: clone?.state, search: search?.state, promise };
}
