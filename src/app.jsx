import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import TextInput from "ink-text-input";
import { fetchRepos } from "./github.js";
import { group, isNoreply } from "./scan.js";
import { run } from "./run.js";
import { copy, openUrl } from "./system.js";

const PAGE = 10;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MODES = ["pair", "email", "name"];
const MODE_LABELS = { pair: "name + email", email: "by email", name: "by name" };
// Lines the results view uses besides the table rows; keeps the frame shorter than the terminal
const RESULTS_CHROME = 8;

const num = (n) => n.toLocaleString("en-US");

const ROLE_LABELS = { author: "authored", committer: "committed" };
const roleLabel = (role) => ROLE_LABELS[role] ?? role.replace(/-by$/, "");
const authored = (item) => item.roles.find(([role]) => role === "author")?.[1] ?? 0;

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function useTick(ms = 80) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

// Keeps `cursor` inside a window of `height` rows, scrolling only when it leaves the window
function useScrollOffset(cursor, height, total) {
  const ref = useRef(0);
  let offset = ref.current;
  if (cursor < offset) offset = cursor;
  if (cursor >= offset + height) offset = cursor - height + 1;
  offset = Math.max(0, Math.min(offset, total - height));
  ref.current = offset;
  return offset;
}

// Re-render once without key hints before exiting so the final frame left in the terminal is clean
function useQuit() {
  const { exit } = useApp();
  const [quitting, setQuitting] = useState(false);
  useEffect(() => {
    if (quitting) exit();
  }, [quitting]);
  return [quitting, () => setQuitting(true)];
}

function Bar({ value, width, color = "green" }) {
  const v = Math.max(0, Math.min(1, value || 0));
  const halves = Math.round(v * width * 2);
  const full = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  const empty = width - full - (half ? 1 : 0);
  return (
    <Text>
      <Text color={color}>
        {"━".repeat(full)}
        {half ? "╸" : ""}
      </Text>
      <Text color="gray" dimColor>
        {"━".repeat(empty)}
      </Text>
    </Text>
  );
}

function UsernamePrompt({ onSubmit, onCancel }) {
  const [value, setValue] = useState("");
  useInput((_, key) => key.escape && onCancel());
  return (
    <Box>
      <Text color="cyan">? </Text>
      <Text bold>GitHub username </Text>
      <TextInput
        value={value}
        onChange={setValue}
        placeholder="octocat"
        onSubmit={(v) => v.trim() && onSubmit(v.trim())}
      />
    </Box>
  );
}

function Fetching({ username, found }) {
  const tick = useTick();
  return (
    <Text>
      <Text color="cyan">{SPINNER[tick % SPINNER.length]} </Text>
      Finding repos for <Text bold>{username}</Text>
      <Text dimColor>{found ? ` · ${num(found)} so far` : "…"}</Text>
    </Text>
  );
}

function Cloning({ username, state, tally }) {
  const tick = useTick();
  const { columns } = useWindowSize();
  const elapsed = Date.now() - state.startedAt;
  const active = [...state.active.values()].sort((a, b) => a.startedAt - b.startedAt);
  // Count in-flight downloads fractionally so the bar and ETA move while a big repo is cloning
  const partial = active.reduce((sum, j) => sum + (j.phase === "receiving" ? j.percent / 100 : 0), 0);
  const progress = state.done + partial;
  const ratio = state.total ? progress / state.total : 0;
  // Average pace across repos, but never less than the slowest download's own estimate
  const jobEtas = active
    .filter((j) => j.phase === "receiving" && j.percent >= 2)
    .map((j) => ((Date.now() - j.phaseStartedAt) / j.percent) * (100 - j.percent));
  const eta = progress > 0 ? Math.max((elapsed / progress) * (state.total - progress), ...jobEtas) : null;
  const nameW = Math.min(32, Math.max(12, ...active.map((j) => j.name.length)));
  const barW = Math.max(10, Math.min(40, columns - 44));

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">{SPINNER[tick % SPINNER.length]} </Text>
        Cloning <Text bold>{username}</Text>'s repos
      </Text>
      <Box marginLeft={2}>
        <Bar value={ratio} width={barW} />
        <Text>
          {"  "}
          <Text bold>{state.done}</Text>
          <Text dimColor>/{state.total}</Text>
          {"  "}
          {String(Math.floor(ratio * 100)).padStart(3)}%{"  "}
          <Text dimColor>
            {duration(elapsed)}
            {eta != null && state.done < state.total ? ` · ~${duration(eta)} left` : ""}
          </Text>
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>
          {num(tally.commits)} commits · {num(tally.identities.size)} identities
        </Text>
        {state.failed.length > 0 && <Text color="yellow"> · {state.failed.length} skipped</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {active.map((job, i) => (
          <Box key={job.name} marginLeft={2}>
            <Text color="cyan">{SPINNER[(tick + i * 3) % SPINNER.length]} </Text>
            <Box width={nameW} marginRight={2}>
              <Text wrap="truncate-end">{job.name}</Text>
            </Box>
            <Box width={13}>
              <Text dimColor>{job.phase}</Text>
            </Box>
            {job.percent != null && (
              <>
                <Bar value={job.percent / 100} width={16} color="blue" />
                <Text dimColor> {String(job.percent).padStart(3)}%</Text>
              </>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Detail({ username, item, onBack }) {
  const { rows, columns } = useWindowSize();
  const [cursor, setCursor] = useState(0);
  const [quitting, quit] = useQuit();
  const total = item.repos.length;
  const aliases = (item.names.length > 1 ? 1 : 0) + (item.emails.length > 1 ? 1 : 0);
  const height = Math.max(1, Math.min(total, rows - 9 - aliases));
  const offset = useScrollOffset(cursor, height, total);
  const visible = item.repos.slice(offset, offset + height);
  const top = item.repos[0]?.[1] ?? 1;
  const commitsW = Math.max(7, num(top).length);
  // The user's own repos show by name, other people's as owner/repo
  const label = (repo) => (repo.startsWith(`${username}/`) ? repo.slice(username.length + 1) : repo);
  const nameW = Math.min(40, Math.max(4, ...item.repos.map(([r]) => label(r).length)));
  const barW = Math.max(0, Math.min(30, columns - nameW - commitsW - 10));

  const move = (i) => setCursor(Math.max(0, Math.min(i, total - 1)));
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) quit();
    else if (key.escape || key.backspace || key.delete || key.leftArrow || input === "h") onBack();
    else if (key.upArrow || input === "k") move(cursor - 1);
    else if (key.downArrow || input === "j") move(cursor + 1);
    else if (key.pageUp) move(cursor - height);
    else if (key.pageDown || input === " ") move(cursor + height);
    else if (key.home || input === "g") move(0);
    else if (key.end || input === "G") move(total - 1);
    else if (key.return || input === "o") {
      const [repo] = item.repos[cursor];
      openUrl(`https://github.com/${repo}/commits?author=${encodeURIComponent(item.emails[0])}`);
    }
  });

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color="cyan">◆ </Text>
        <Text bold>{item.names[0]}</Text>
        <Text color="cyan"> &lt;{item.emails[0]}&gt;</Text>
      </Text>
      <Text dimColor>
        {"  "}
        {num(item.commits)} commits across {num(total)} repo{total === 1 ? "" : "s"}
      </Text>
      <Text wrap="truncate-end">
        {"  "}
        {item.roles.map(([role, n], i) => (
          <Text key={role}>
            {i > 0 && <Text dimColor> · </Text>}
            <Text dimColor>{roleLabel(role)} </Text>
            <Text color="yellow">{num(n)}</Text>
          </Text>
        ))}
      </Text>
      {item.names.length > 1 && (
        <Text dimColor wrap="truncate-end">
          {"  "}also named {item.names.slice(1).join(", ")}
        </Text>
      )}
      {item.emails.length > 1 && (
        <Text dimColor wrap="truncate-end">
          {"  "}also as {item.emails.slice(1).join(", ")}
        </Text>
      )}
      <Text> </Text>
      <Text dimColor>
        {"  "}
        {"commits".padStart(commitsW)}
        {"  "}repo
      </Text>
      {visible.map(([repo, commits], i) => {
        const isSel = !quitting && offset + i === cursor;
        return (
          <Box key={repo}>
            <Text color="cyan">{isSel ? "❯ " : "  "}</Text>
            <Text color="yellow">{num(commits).padStart(commitsW)}</Text>
            <Text>{"  "}</Text>
            <Box width={nameW} marginRight={2}>
              <Text bold={isSel} color={isSel ? "cyan" : undefined} wrap="truncate-end">
                {label(repo)}
              </Text>
            </Box>
            {barW > 0 && <Bar value={commits / top} width={barW} color="magenta" />}
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor>
        {offset + 1}–{offset + visible.length} of {num(total)}
      </Text>
      {!quitting && (
        <Text dimColor wrap="truncate-end">
          <Text bold>↑↓</Text> move · <Text bold>enter</Text> open commits on GitHub · <Text bold>esc</Text>{" "}
          back · <Text bold>q</Text> quit
        </Text>
      )}
    </Box>
  );
}

function Results({ username, result, initialShowNoreply }) {
  const { rows, columns } = useWindowSize();
  const [mode, setMode] = useState("pair");
  const [limit, setLimit] = useState(PAGE);
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [flash, setFlash] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showNoreply, setShowNoreply] = useState(initialShowNoreply);
  const [quitting, quit] = useQuit();

  const real = useMemo(() => result.identities.filter((i) => !isNoreply(i.email)), [result]);
  const hiddenCount = result.identities.length - real.length;
  const grouped = useMemo(
    () => group(showNoreply ? result.identities : real, mode),
    [result, real, mode, showNoreply],
  );
  const filtered = useMemo(() => {
    const ranked = grouped.map((g, i) => ({ ...g, rank: i + 1 }));
    const q = query.toLowerCase();
    if (!q) return ranked;
    return ranked.filter((g) => [...g.names, ...g.emails].some((s) => s.toLowerCase().includes(q)));
  }, [grouped, query]);

  // A search shows every match; otherwise only the rows expanded so far
  const expanded = query ? filtered.length : Math.min(limit, filtered.length);
  const height = Math.max(1, Math.min(expanded, rows - RESULTS_CHROME));
  const cur = Math.min(cursor, Math.max(0, expanded - 1));

  const offset = useScrollOffset(cur, height, expanded);
  const visible = filtered.slice(offset, offset + height);
  const selected = filtered[cur];

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(id);
  }, [flash]);

  const moveTo = (i) => {
    const target = Math.max(0, Math.min(i, filtered.length - 1));
    if (target >= limit) setLimit(target + 1);
    setCursor(target);
  };

  useInput(
    (input, key) => {
      if (searching) {
        if (key.return) setSearching(false);
        else if (key.escape) {
          setSearching(false);
          setQuery("");
          setCursor(0);
        } else if (key.backspace || key.delete) {
          setQuery((q) => q.slice(0, -1));
          setCursor(0);
        } else if (input && !key.ctrl && !key.meta) {
          setQuery((q) => q + input);
          setCursor(0);
        }
        return;
      }
      if (input === "q" || key.escape || (key.ctrl && input === "c")) quit();
      else if (key.upArrow || input === "k") moveTo(cur - 1);
      else if (key.downArrow || input === "j") moveTo(cur + 1);
      else if (key.pageUp) moveTo(cur - height);
      else if (key.pageDown) moveTo(cur + height);
      else if (key.home || input === "g") moveTo(0);
      else if (key.end || input === "G") moveTo(filtered.length - 1);
      else if (key.return && selected) setDetail(selected);
      else if (input === " ") {
        if (expanded < filtered.length) {
          setLimit(expanded + PAGE);
          setCursor(expanded);
        }
      } else if (input === "a") setLimit(Infinity);
      else if (key.tab) {
        const i = MODES.indexOf(mode) + (key.shift ? MODES.length - 1 : 1);
        setMode(MODES[i % MODES.length]);
        setCursor(0);
      } else if (input === "/") setSearching(true);
      else if (input === "n") {
        setShowNoreply(!showNoreply);
        setCursor(0);
        setFlash(`${showNoreply ? "Hiding" : "Showing"} ${num(hiddenCount)} GitHub noreply identities`);
      } else if (input === "c" && selected) {
        copy(selected.emails[0]);
        setFlash(`Copied ${selected.emails[0]}`);
      }
    },
    { isActive: !detail },
  );

  if (detail) return <Detail username={username} item={detail} onBack={() => setDetail(null)} />;

  const rankW = Math.max(1, String(grouped.length).length);
  const commitsW = Math.max(7, num(grouped[0]?.commits ?? 0).length);
  const authoredW = 8;
  const reposW = 5;
  const rest = columns - 2 - rankW - commitsW - authoredW - reposW - 10;
  const longestName = Math.max(4, ...visible.map((g) => g.names.join(", ").length));
  const nameW = Math.max(8, Math.min(longestName, Math.floor(rest * 0.4)));

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">◆ </Text>
        <Text bold>{username}</Text>
        <Text dimColor>
          {"  "}
          {num(showNoreply ? result.identities.length : real.length)} identities
          {!showNoreply && hiddenCount > 0 ? ` (${num(hiddenCount)} noreply hidden)` : ""} ·{" "}
          {num(result.commits)} commits · {num(result.repos)} repos · {duration(result.duration)}
        </Text>
      </Text>
      <Text> </Text>
      <Box>
        {MODES.map((m) => (
          <Box key={m} marginRight={1}>
            <Text inverse={m === mode} color={m === mode ? "cyan" : undefined} dimColor={m !== mode}>
              {` ${MODE_LABELS[m]} `}
            </Text>
          </Box>
        ))}
        {(searching || query) && (
          <Text>
            {"  "}
            <Text color="cyan">/</Text>
            {query}
            {searching ? <Text inverse> </Text> : ""}
            <Text dimColor>
              {" "}
              {num(filtered.length)} match{filtered.length === 1 ? "" : "es"}
            </Text>
          </Text>
        )}
      </Box>
      <Box>
        <Text dimColor>
          {"  "}
          {"#".padStart(rankW)}
          {"  "}
          {"commits".padStart(commitsW)}
          {"  "}
          {"authored".padStart(authoredW)}
          {"  "}
          {"repos".padStart(reposW)}
          {"  "}
        </Text>
        <Box width={nameW} marginRight={2}>
          <Text dimColor>{mode === "email" ? "names" : "name"}</Text>
        </Box>
        <Text dimColor>{mode === "name" ? "emails" : "email"}</Text>
      </Box>
      {visible.length === 0 && <Text dimColor> No matches</Text>}
      {visible.map((g) => {
        const isSel = !quitting && g === selected;
        return (
          <Box key={g.key}>
            <Text color="cyan">{isSel ? "❯ " : "  "}</Text>
            <Text color={isSel ? "cyan" : undefined} dimColor={!isSel}>
              {String(g.rank).padStart(rankW)}
            </Text>
            <Text color="yellow">
              {"  "}
              {num(g.commits).padStart(commitsW)}
            </Text>
            <Text color="green" dimColor={authored(g) === 0}>
              {"  "}
              {num(authored(g)).padStart(authoredW)}
            </Text>
            <Text color="magenta">
              {"  "}
              {String(g.repos.length).padStart(reposW)}
              {"  "}
            </Text>
            <Box width={nameW} marginRight={2}>
              <Text bold={isSel} wrap="truncate-end">
                {g.names.join(", ")}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color="cyan" bold={isSel} wrap="truncate-end">
                {g.emails.join(", ")}
              </Text>
            </Box>
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor wrap="truncate-end">
        {filtered.length ? `${offset + 1}–${offset + visible.length} of ${num(filtered.length)}` : "0 of 0"}
        {!quitting && expanded < filtered.length ? ` · ${num(filtered.length - expanded)} more` : ""}
      </Text>
      {!quitting &&
        (flash ? (
          <Text color="green">✓ {flash}</Text>
        ) : searching ? (
          <Text dimColor>type to filter · enter done · esc clear</Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            <Text bold>↑↓</Text> move · <Text bold>enter</Text> repos · <Text bold>space</Text> more ·{" "}
            <Text bold>a</Text> all · <Text bold>tab</Text> group · <Text bold>/</Text> search ·{" "}
            <Text bold>n</Text> {showNoreply ? "hide" : "show"} noreply · <Text bold>c</Text> copy email ·{" "}
            <Text bold>q</Text> quit
          </Text>
        ))}
    </Box>
  );
}

export default function App({ initialUsername, includeForks, showNoreply, scanOptions, token, signal }) {
  const { exit } = useApp();
  const [username, setUsername] = useState(initialUsername ?? "");
  const [phase, setPhase] = useState(initialUsername ? "fetching" : "input");
  const [found, setFound] = useState(0);
  const [handle, setHandle] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [log, setLog] = useState([]);
  useInput((input, key) => {
    // Results and Detail treat ctrl+c like q
    if (key.ctrl && input === "c" && phase !== "results") {
      process.exitCode = 130;
      setPhase(phase === "input" ? "done" : "cancelled");
    }
  });

  const addLog = (...items) =>
    setLog((l) => [...l, ...items.map((it, i) => ({ id: `${l.length + i}`, ...it }))]);

  useEffect(() => {
    if (phase !== "fetching") return;
    fetchRepos(username, { token, signal, onProgress: setFound })
      .then((all) => {
        const repos = includeForks ? all : all.filter((r) => !r.fork);
        const forks = all.length - repos.length;
        if (!repos.length) {
          throw new Error(`No public ${includeForks ? "" : "non-fork "}repos found for ${username}`);
        }
        addLog({
          icon: "✓",
          color: "green",
          text: `Found ${num(repos.length)} repos for ${username}${forks ? ` (${forks} forks skipped)` : ""}`,
        });
        const h = run(repos, { ...scanOptions, signal });
        setHandle(h);
        setPhase("cloning");
        return h.promise;
      })
      .then((res) => {
        addLog(
          {
            icon: "✓",
            color: "green",
            text: `Cloned ${num(res.repos)} repos in ${duration(res.duration)} · ${num(res.commits)} commits`,
          },
          ...res.failed.map((f) => ({ icon: "!", color: "yellow", text: `Skipped ${f.repo}: ${f.error}` })),
        );
        setResult(res);
        setPhase(res.identities.length ? "results" : "empty");
      })
      .catch((err) => {
        if (signal.aborted) return;
        setError(err.message);
        setPhase("error");
      });
  }, [phase]);

  useEffect(() => {
    if (phase === "error") process.exitCode = 1;
    if (["error", "empty", "cancelled", "done"].includes(phase)) exit();
  }, [phase]);

  return (
    <>
      <Static items={log}>
        {(item) => (
          <Text key={item.id}>
            <Text color={item.color}>{item.icon} </Text>
            {item.text}
          </Text>
        )}
      </Static>
      {phase === "input" && (
        <UsernamePrompt
          onCancel={exit}
          onSubmit={(name) => {
            setUsername(name);
            setPhase("fetching");
          }}
        />
      )}
      {phase === "fetching" && <Fetching username={username} found={found} />}
      {phase === "cloning" && handle && (
        <Cloning username={username} state={handle.clone} tally={handle.tally} />
      )}
      {phase === "results" && (
        <Results username={username} result={result} initialShowNoreply={showNoreply} />
      )}
      {phase === "empty" && <Text dimColor>No commits found.</Text>}
      {phase === "error" && <Text color="red">✗ {error}</Text>}
      {phase === "cancelled" && <Text color="yellow">✗ Cancelled</Text>}
    </>
  );
}
