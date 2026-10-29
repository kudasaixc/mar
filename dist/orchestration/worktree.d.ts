export declare function isGitWorkTree(root: string): Promise<boolean>;
export declare function worktreesRoot(stateRoot: string, workspace: string): string;
/**
 * Commit the CURRENT working tree (tracked changes plus untracked, non-ignored
 * files) to a dangling commit without touching the user's index, HEAD, branches
 * or working tree. Workers start from this snapshot so they see uncommitted work.
 */
export declare function snapshotCommit(root: string, scratchDir: string): Promise<string>;
export interface Worktree {
    path: string;
    base: string;
    /** Per-worktree Git metadata directory (must be writable inside a sandbox). */
    gitDir: string;
    /** The repository's common Git directory (read-only inside a sandbox). */
    commonDir: string;
}
export declare function createWorktree(root: string, path: string, base: string): Promise<Worktree>;
/** Commit everything in the worktree and return the resulting head (equal to base if nothing changed). */
export declare function commitWorktree(worktree: Worktree, message: string): Promise<{
    head: string;
    files: string[];
    stat: string;
}>;
export declare function worktreeDiff(worktree: Worktree, head: string): Promise<string>;
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
export declare function integrateWorktree(root: string, worktree: Worktree, head: string, scratchDir: string): Promise<IntegrationResult>;
export declare function removeWorktree(root: string, worktree: Worktree): Promise<void>;
//# sourceMappingURL=worktree.d.ts.map