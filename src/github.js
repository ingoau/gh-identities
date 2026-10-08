export async function fetchRepos(username, { signal, onProgress } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "gh-identities",
    ...(token && { Authorization: `Bearer ${token}` }),
  };
  const repos = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&type=owner&page=${page}`,
      { headers, signal },
    );
    if (res.status === 404) throw new Error(`GitHub user "${username}" not found`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const hint =
        res.status === 403 || res.status === 429 ? " (set GITHUB_TOKEN to raise the rate limit)" : "";
      throw new Error(`GitHub API error ${res.status}: ${body.message ?? res.statusText}${hint}`);
    }
    const batch = await res.json();
    repos.push(...batch);
    onProgress?.(repos.length);
    if (batch.length < 100) break;
  }
  return repos;
}
