import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MarError } from "../errors.js";
import { commandEnvironment, runProcess, type ProcessResult } from "../security/process.js";
import { oneLine } from "../util/text.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "MAR", GIT_AUTHOR_EMAIL: "mar@localhost", GIT_COMMITTER_NAME: "MAR", GIT_COMMITTER_EMAIL: "mar@localhost",
};

async function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}, maxOutput = 4_000_000): Promise<ProcessResult> {
  return runProcess({ argv: ["git", ...args], cwd, env: commandEnvironment([], { ...IDENTITY, ...extraEnv }), timeoutMs: 120_000, maxOutput });
}

async function gitOk(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const result = await git(cwd, args, extraEnv);
  if (result.exitCode !== 0) {
    throw new MarError(`git ${args.join(" ")} failed (${result.spawnError ?? `exit ${result.exitCode}`}): ${oneLine(result.stderr || result.stdout, 400)}`);
  }
  if (result.truncated) throw new MarError(`git ${args.join(" ")} produced more output than MAR can handle safely.`);
  return result.stdout;
}

export async function isGitWorkTree(root: string): Promise<boolean> {
  const result = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export function worktreesRoot(stateRoot: string, workspace: string): string {
  return join(stateRoot, createHash("sha256").update(workspace).digest("hex").slice(0, 16));
}

/**
 * Commit the CURRENT working tree (tracked changes plus untracked, non-ignored
 * files) to a dangling commit without touching the user's index, HEAD, branches
 * or working tree. Workers start from this snapshot so they see uncommitted work.
 */
export async function snapshotCommit(root: string, scratchDir: string): Promise<string> {
  await mkdir(scratchDir, { recursive: true });
  const index = join(scratchDir, `index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).stdout.trim();
    await gitOk(root, head ? ["read-tree", head] : ["read-tree", "--empty"], env);
    await gitOk(root, ["add", "-A"], env);
    const tree = (await gitOk(root, ["write-tree"], env)).trim();
    return (await gitOk(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "MAR worker snapshot"], env)).trim();
  } finally {
    await rm(index, { force: true });
  }
}

export interface Worktree {
  path: string;
  base: string;
  /** Per-worktree Git metadata directory (must be writable inside a sandbox). */
  gitDir: string;
  /** The repository's common Git directory (read-only inside a sandbox). */
  commonDir: string;
}

export async function createWorktree(root: string, path: string, base: string): Promise<Worktree> {
  await gitOk(root, ["worktree", "add", "--detach", path, base]);
  const gitDir = (await gitOk(path, ["rev-parse", "--absolute-git-dir"])).trim();
  const common = (await gitOk(path, ["rev-parse", "--git-common-dir"])).trim();
  return { path, base, gitDir, commonDir: common.startsWith("/") ? common : join(path, common) };
}

/** Commit everything in the worktree and return the resulting head (equal to base if nothing changed). */
export async function commitWorktree(worktree: Worktree, message: string): Promise<{ head: string; files: string[]; stat: string }> {
  await gitOk(worktree.path, ["add", "-A"]);
  const pending = await gitOk(worktree.path, ["diff", "--cached", "--name-only"]);
  if (pending.trim()) await gitOk(worktree.path, ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", message]);
  const head = (await gitOk(worktree.path, ["rev-parse", "HEAD"])).trim();
  if (head === worktree.base) return { head, files: [], stat: "" };
  const files = (await gitOk(worktree.path, ["diff", "--name-only", worktree.base, head])).split("\n").filter(Boolean);
  const stat = (await gitOk(worktree.path, ["diff", "--stat", worktree.base, head])).trim();
  return { head, files, stat };
}

export async function worktreeDiff(worktree: Worktree, head: string): Promise<string> {
  return gitOk(worktree.path, ["diff", "--binary", worktree.base, head]);
}

export interface IntegrationResult {
  applied: boolean;
  files: string[];
  /** git apply's explanation when the patch does not apply cleanly. */
  conflict?: string;
}

/**
 * Apply a worker's changes to the main working tree. `git apply --check` runs
 * first; if any hunk conflicts with the current files nothing is written and the
 * worktree is kept for manual resolution. The user's index and HEAD are untouched.
 */
export async function integrateWorktree(root: string, worktree: Worktree, head: string, scratchDir: string): Promise<IntegrationResult> {
  const files = (await gitOk(worktree.path, ["diff", "--name-only", worktree.base, head])).split("\n").filter(Boolean);
  if (!files.length) return { applied: true, files };
  const diff = await worktreeDiff(worktree, head);
  await mkdir(scratchDir, { recursive: true });
  const patchFile = join(scratchDir, `integrate-${process.pid}-${Date.now()}.patch`);
  await writeFile(patchFile, diff, { mode: 0o600 });
  try {
    const check = await git(root, ["apply", "--check", "--whitespace=nowarn", patchFile]);
    if (check.exitCode !== 0) return { applied: false, files, conflict: (check.stderr || check.stdout).trim() || "git apply --check failed" };
    await gitOk(root, ["apply", "--whitespace=nowarn", patchFile]);
    return { applied: true, files };
  } finally {
    await rm(patchFile, { force: true });
  }
}

export async function removeWorktree(root: string, worktree: Worktree): Promise<void> {
  await git(root, ["worktree", "remove", "--force", worktree.path]);
  await rm(worktree.path, { recursive: true, force: true });
  await git(root, ["worktree", "prune"]);
}
