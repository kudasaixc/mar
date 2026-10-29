import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { SecurityError } from "../errors.js";
import type { SandboxBackend, SandboxConfig } from "../types.js";
import { runProcess } from "./process.js";

export interface WrappedCommand {
  argv: string[];
  env: Record<string, string>;
  onKill?: () => Promise<void>;
}

/**
 * An execution backend for tool commands. `isolated` is true only when the backend
 * provides an OS-level boundary (mount/namespace or container isolation). The
 * `host` backend runs commands as the current user with no isolation.
 */
export interface Sandbox {
  readonly backend: SandboxBackend;
  readonly isolated: boolean;
  readonly network: boolean;
  wrap(argv: string[], cwd: string, env: Record<string, string>): WrappedCommand;
  describe(): string;
}

export interface SandboxOptions extends SandboxConfig {
  /** Directories the command may write (the workspace, worktrees, Git metadata). */
  writablePaths: string[];
}

class HostSandbox implements Sandbox {
  readonly backend = "host" as const;
  readonly isolated = false;
  readonly network = true;
  wrap(argv: string[], _cwd: string, env: Record<string, string>): WrappedCommand {
    return { argv, env };
  }
  describe(): string {
    return "host (no isolation: commands run as your user with full filesystem and network access)";
  }
}

const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/nix", "/snap", "/usr/local"];
const SANDBOX_HOME = "/tmp/mar-home";

class BubblewrapSandbox implements Sandbox {
  readonly backend = "bubblewrap" as const;
  readonly isolated = true;
  constructor(private readonly options: SandboxOptions) {}
  get network(): boolean {
    return this.options.network;
  }

  wrap(argv: string[], cwd: string, env: Record<string, string>): WrappedCommand {
    const args = ["bwrap", "--die-with-parent", "--new-session", "--unshare-all"];
    if (this.options.network) args.push("--share-net");
    const readOnly = new Set([...SYSTEM_PATHS, ...this.options.readOnlyPaths]);
    // Make the running Node.js toolchain visible when it lives outside system paths (nvm, volta, ...).
    const nodePrefix = dirname(dirname(process.execPath));
    if (![...readOnly].some((path) => nodePrefix === path || nodePrefix.startsWith(`${path}/`))) readOnly.add(nodePrefix);
    for (const path of readOnly) args.push("--ro-bind-try", path, path);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", SANDBOX_HOME);
    for (const path of this.options.writablePaths) args.push("--bind", path, path);
    args.push("--chdir", cwd);
    const sandboxEnv = { ...env, HOME: SANDBOX_HOME, TMPDIR: "/tmp" };
    for (const [name, value] of Object.entries(sandboxEnv)) args.push("--setenv", name, value);
    args.push("--", ...argv);
    return { argv: args, env: sandboxEnv };
  }

  describe(): string {
    return `bubblewrap (filesystem limited to the workspace and read-only system paths; home directory hidden; network ${this.options.network ? "enabled" : "disabled"})`;
  }
}

class DockerSandbox implements Sandbox {
  readonly backend = "docker" as const;
  readonly isolated = true;
  constructor(private readonly options: SandboxOptions) {}
  get network(): boolean {
    return this.options.network;
  }

  wrap(argv: string[], cwd: string, env: Record<string, string>): WrappedCommand {
    const name = `mar-${randomUUID().slice(0, 12)}`;
    const args = ["docker", "run", "--rm", "--init", "--name", name, "--network", this.options.network ? "bridge" : "none",
      "--pids-limit", "1024", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      args.push("--user", `${process.getuid()}:${process.getgid()}`);
    }
    for (const path of this.options.writablePaths) args.push("--volume", `${path}:${path}:rw`);
    for (const path of this.options.readOnlyPaths) args.push("--volume", `${path}:${path}:ro`);
    args.push("--workdir", cwd, "--env", `HOME=${SANDBOX_HOME}`);
    for (const [key, value] of Object.entries(env)) {
      if (key === "PATH" || key === "HOME") continue;
      args.push("--env", `${key}=${value}`);
    }
    args.push(this.options.image, ...argv);
    const hostEnv: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "SystemRoot"]) {
      if (process.env[key]) hostEnv[key] = process.env[key]!;
    }
    return {
      argv: args,
      env: hostEnv,
      onKill: async () => {
        await runProcess({ argv: ["docker", "kill", name], cwd, env: hostEnv, timeoutMs: 10_000, maxOutput: 1_000 });
      },
    };
  }

  describe(): string {
    return `docker (${this.options.image}; workspace mounted; capabilities dropped; network ${this.options.network ? "enabled" : "disabled"})`;
  }
}

export interface SandboxProbe {
  backend: SandboxBackend;
  available: boolean;
  detail: string;
}

export async function probeSandbox(backend: SandboxBackend, image = "node:22-bookworm"): Promise<SandboxProbe> {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  if (backend === "host") return { backend, available: true, detail: "always available (not isolated)" };
  if (backend === "bubblewrap") {
    if (process.platform !== "linux") return { backend, available: false, detail: "bubblewrap is Linux-only" };
    const result = await runProcess({
      argv: ["bwrap", "--die-with-parent", "--unshare-all", "--ro-bind", "/", "/", "--", "true"],
      cwd: "/", env, timeoutMs: 10_000, maxOutput: 2_000,
    });
    if (result.spawnError) return { backend, available: false, detail: "bwrap is not installed" };
    if (result.exitCode !== 0) return { backend, available: false, detail: `bwrap cannot create namespaces: ${result.stderr.trim() || `exit ${result.exitCode}`}` };
    return { backend, available: true, detail: "user namespaces available" };
  }
  const result = await runProcess({ argv: ["docker", "image", "inspect", "--format", "{{.Id}}", image], cwd: process.cwd(), env, timeoutMs: 20_000, maxOutput: 2_000 });
  if (result.spawnError) return { backend, available: false, detail: "docker CLI is not installed" };
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim().split("\n")[0] ?? "";
    return { backend, available: false, detail: /no such image/i.test(reason) ? `image ${image} is not present locally (docker pull ${image})` : reason || "docker daemon unavailable" };
  }
  return { backend, available: true, detail: `image ${image} present` };
}

/**
 * Create the configured backend. A requested isolated backend that is unavailable
 * is a hard error: MAR never silently falls back to host execution.
 */
export async function createSandbox(options: SandboxOptions, probe = true): Promise<Sandbox> {
  if (options.backend === "host") return new HostSandbox();
  if (probe) {
    const result = await probeSandbox(options.backend, options.image);
    if (!result.available) {
      throw new SecurityError(`Sandbox backend "${options.backend}" is unavailable: ${result.detail}. ` +
        "Fix the backend or explicitly choose --sandbox host to accept unisolated execution.");
    }
  }
  for (const path of options.writablePaths) {
    if (!existsSync(path)) throw new SecurityError(`Sandbox writable path does not exist: ${path}`);
  }
  return options.backend === "bubblewrap" ? new BubblewrapSandbox(options) : new DockerSandbox(options);
}

export function hostSandbox(): Sandbox {
  return new HostSandbox();
}
