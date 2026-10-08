import { spawn, spawnSync } from "node:child_process";

const commands = {
  darwin: [["pbcopy"]],
  win32: [["clip"]],
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
};

export function copy(text) {
  for (const [cmd, ...args] of commands[process.platform] ?? []) {
    const res = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (!res.error && res.status === 0) return true;
  }
  // OSC 52: ask the terminal itself to set the clipboard
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  return true;
}

export function openUrl(url) {
  const [cmd, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  spawn(cmd, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}
