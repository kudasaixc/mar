import { spawn } from "node:child_process";
import { BoundedBuffer } from "../util/text.js";

export interface ProcessOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Maximum characters retained per stream (head and tail are kept). */
  maxOutput: number;
  signal?: AbortSignal;
  /** Extra cleanup when the process must be killed (for example `docker kill`). */
  onKill?: () => Promise<void>;
  /** Live output observer (background processes). */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
  /** Set when the program could not be started at all. */
  spawnError?: string;
}

const KILL_GRACE_MS = 2_000;

/**
 * Run a program without a shell. On POSIX the child gets its own process group so
 * that timeouts and cancellation terminate the whole tree (SIGTERM, then SIGKILL).
 */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const [file, ...args] = options.argv;
  if (!file) return Promise.resolve(failure("Empty command.", started));
  const stdout = new BoundedBuffer(options.maxOutput);
  const stderr = new BoundedBuffer(options.maxOutput);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve(failure(error instanceof Error ? error.message : String(error), started));
      return;
    }
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        // The group already exited.
      }
    };
    const terminate = (): void => {
      if (killTimer) return;
      void options.onKill?.().catch(() => undefined);
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      // A grandchild that escaped the group may hold the pipes open; stop waiting eventually.
      forceTimer = setTimeout(() => finish(null, "SIGKILL"), KILL_GRACE_MS * 2);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode: code,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        cancelled,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
        ...(spawnError ? { spawnError } : {}),
      });
    };
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout.push(chunk);
      options.onOutput?.("stdout", chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr.push(chunk);
      options.onOutput?.("stderr", chunk);
    });
    child.on("error", (error) => finish(null, null, error.message));
    child.on("close", (code, signal) => {
      // Reap anything left in the group (background jobs started by the command).
      if (process.platform !== "win32") killTree("SIGKILL");
      finish(code, signal);
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function failure(message: string, started: number): ProcessResult {
  return {
    exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false,
    truncated: false, durationMs: Date.now() - started, spawnError: message,
  };
}

const SAFE_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "TMPDIR", "TEMP", "TMP",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  "ProgramFiles", "ProgramData", "NUMBER_OF_PROCESSORS", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "NVM_DIR", "NVM_BIN", "VOLTA_HOME", "PNPM_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "JAVA_HOME",
  "PYENV_ROOT", "VIRTUAL_ENV", "CONDA_PREFIX",
]);

/**
 * Build the environment for tool commands: a minimal allowlist plus explicitly
 * configured pass-through variables. Provider API keys are never forwarded unless
 * the user names them in `runtime.envPassthrough`.
 */
export function commandEnvironment(passthrough: string[], extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = new Set([...SAFE_ENV, ...passthrough]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowed.has(name) || name.startsWith("LC_")) env[name] = value;
  }
  return { ...env, CI: env.CI ?? "1", NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0", ...extra };
}

export function shellArgv(command: string): string[] {
  return process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/sh", "-c", command];
}
