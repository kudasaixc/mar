import { KeyedMutex } from "../util/async.js";
/**
 * Tracks which version of each file every agent last observed. Overwrites based on
 * a stale view are rejected so concurrent agents (or the user's editor) cannot be
 * silently clobbered. One ledger is shared by all agents using the same directory.
 */
export declare class FileLedger {
    private readonly seen;
    private readonly writes;
    readonly locks: KeyedMutex;
    noteRead(agent: string, path: string, hash: string): void;
    noteWrite(agent: string, path: string, hash: string): void;
    noteDelete(agent: string, path: string): void;
    /**
     * Returns a conflict explanation when `agent` would overwrite content it has not
     * seen. `current` is the hash of the file on disk (undefined when absent).
     */
    conflict(agent: string, path: string, display: string, current: string | undefined): string | undefined;
    lastWriter(path: string): string | undefined;
}
//# sourceMappingURL=ledger.d.ts.map