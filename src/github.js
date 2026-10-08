import { execFileSync } from "node:child_process";

// Token from the GitHub CLI's login, or null if gh isn't installed or logged in
export function ghCliToken() {
  try {
    return (
      execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export const headers = (token) => ({
  Accept: "application/vnd.github+json",
  "User-Agent": "gh-identities",
  ...(token && { Authorization: `Bearer ${token}` }),
});

export async function fetchRepos(username, { token, signal, onProgress } = {}) {
  const repos = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&type=owner&page=${page}`,
      { headers: headers(token), signal },
    );
    if (res.status === 404) throw new Error(`GitHub user "${username}" not found`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const hint =
        res.status === 403 || res.status === 429
          ? " (use --gh-auth or GITHUB_TOKEN to raise the rate limit)"
          : "";
      throw new Error(`GitHub API error ${res.status}: ${body.message ?? res.statusText}${hint}`);
    }
    const batch = await res.json();
    repos.push(...batch);
    onProgress?.(repos.length);
    if (batch.length < 100) break;
  }
  return repos;
}
