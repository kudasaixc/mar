import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { SecurityError } from "../errors.js";
import { runProcess } from "./process.js";
class HostSandbox {
    backend = "host";
    isolated = false;
    network = true;
    wrap(argv, _cwd, env) {
        return { argv, env };
    }
    describe() {
        return "host (no isolation: commands run as your user with full filesystem and network access)";
    }
}
const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/nix", "/snap", "/usr/local"];
const SANDBOX_HOME = "/tmp/mar-home";
class BubblewrapSandbox {
    options;
    backend = "bubblewrap";
    isolated = true;
    constructor(options) {
        this.options = options;
    }
    get network() {
        return this.options.network;
    }
    wrap(argv, cwd, env) {
        const args = ["bwrap", "--die-with-parent", "--new-session", "--unshare-all"];
        if (this.options.network)
            args.push("--share-net");
        const readOnly = new Set([...SYSTEM_PATHS, ...this.options.readOnlyPaths]);
        // Make the running Node.js toolchain visible when it lives outside system paths (nvm, volta, ...).
        const nodePrefix = dirname(dirname(process.execPath));
        if (![...readOnly].some((path) => nodePrefix === path || nodePrefix.startsWith(`${path}/`)))
            readOnly.add(nodePrefix);
        for (const path of readOnly)
            args.push("--ro-bind-try", path, path);
        args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", SANDBOX_HOME);
        for (const path of this.options.writablePaths)
            args.push("--bind", path, path);
        args.push("--chdir", cwd);
        const sandboxEnv = { ...env, HOME: SANDBOX_HOME, TMPDIR: "/tmp" };
        for (const [name, value] of Object.entries(sandboxEnv))
            args.push("--setenv", name, value);
        args.push("--", ...argv);
        return { argv: args, env: sandboxEnv };
    }
    describe() {
        return `bubblewrap (filesystem limited to the workspace and read-only system paths; home directory hidden; network ${this.options.network ? "enabled" : "disabled"})`;
    }
}
class DockerSandbox {
    options;
    backend = "docker";
    isolated = true;
    constructor(options) {
        this.options = options;
    }
    get network() {
        return this.options.network;
    }
    wrap(argv, cwd, env) {
        const name = `mar-${randomUUID().slice(0, 12)}`;
        const args = ["docker", "run", "--rm", "--init", "--name", name, "--network", this.options.network ? "bridge" : "none",
            "--pids-limit", "1024", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
        if (typeof process.getuid === "function" && typeof process.getgid === "function") {
            args.push("--user", `${process.getuid()}:${process.getgid()}`);
        }
        for (const path of this.options.writablePaths)
            args.push("--volume", `${path}:${path}:rw`);
        for (const path of this.options.readOnlyPaths)
            args.push("--volume", `${path}:${path}:ro`);
        args.push("--workdir", cwd, "--env", `HOME=${SANDBOX_HOME}`);
        for (const [key, value] of Object.entries(env)) {
            if (key === "PATH" || key === "HOME")
                continue;
            args.push("--env", `${key}=${value}`);
        }
        args.push(this.options.image, ...argv);
        const hostEnv = {};
        for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "SystemRoot"]) {
            if (process.env[key])
                hostEnv[key] = process.env[key];
        }
        return {
            argv: args,
            env: hostEnv,
            onKill: async () => {
                await runProcess({ argv: ["docker", "kill", name], cwd, env: hostEnv, timeoutMs: 10_000, maxOutput: 1_000 });
            },
        };
    }
    describe() {
        return `docker (${this.options.image}; workspace mounted; capabilities dropped; network ${this.options.network ? "enabled" : "disabled"})`;
    }
}
export async function probeSandbox(backend, image = "node:22-bookworm") {
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    if (backend === "host")
        return { backend, available: true, detail: "always available (not isolated)" };
    if (backend === "bubblewrap") {
        if (process.platform !== "linux")
            return { backend, available: false, detail: "bubblewrap is Linux-only" };
        const result = await runProcess({
            argv: ["bwrap", "--die-with-parent", "--unshare-all", "--ro-bind", "/", "/", "--", "true"],
            cwd: "/", env, timeoutMs: 10_000, maxOutput: 2_000,
        });
        if (result.spawnError)
            return { backend, available: false, detail: "bwrap is not installed" };
        if (result.exitCode !== 0)
            return { backend, available: false, detail: `bwrap cannot create namespaces: ${result.stderr.trim() || `exit ${result.exitCode}`}` };
        return { backend, available: true, detail: "user namespaces available" };
    }
    const result = await runProcess({ argv: ["docker", "image", "inspect", "--format", "{{.Id}}", image], cwd: process.cwd(), env, timeoutMs: 20_000, maxOutput: 2_000 });
    if (result.spawnError)
        return { backend, available: false, detail: "docker CLI is not installed" };
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
export async function createSandbox(options, probe = true) {
    if (options.backend === "host")
        return new HostSandbox();
    if (probe) {
        const result = await probeSandbox(options.backend, options.image);
        if (!result.available) {
            throw new SecurityError(`Sandbox backend "${options.backend}" is unavailable: ${result.detail}. ` +
                "Fix the backend or explicitly choose --sandbox host to accept unisolated execution.");
        }
    }
    for (const path of options.writablePaths) {
        if (!existsSync(path))
            throw new SecurityError(`Sandbox writable path does not exist: ${path}`);
    }
    return options.backend === "bubblewrap" ? new BubblewrapSandbox(options) : new DockerSandbox(options);
}
export function hostSandbox() {
    return new HostSandbox();
}
//# sourceMappingURL=sandbox.js.map