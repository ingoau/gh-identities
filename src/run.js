import { createTally, scan } from "./scan.js";

// Runs the clone scan and returns live state for the UI plus a promise of the final result
export function run(repos, { jobs, signal, trailers, skipTrailers }) {
  const tally = createTally({ trailers, skipTrailers });
  const clone = scan(repos, { tally, jobs, signal });
  const promise = clone.promise.then((cloned) => ({
    ...cloned,
    identities: tally.sorted(),
    commits: tally.commits,
  }));
  return { tally, clone: clone.state, promise };
}
