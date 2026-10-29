import { KeyedMutex } from "../util/async.js";

interface WriteRecord {
  hash: string;
  agent: string;
  at: string;
}

/**
 * Tracks which version of each file every agent last observed. Overwrites based on
 * a stale view are rejected so concurrent agents (or the user's editor) cannot be
 * silently clobbered. One ledger is shared by all agents using the same directory.
 */
export class FileLedger {
  private readonly seen = new Map<string, Map<string, string>>();
  private readonly writes = new Map<string, WriteRecord>();
  readonly locks = new KeyedMutex();

  noteRead(agent: string, path: string, hash: string): void {
    let files = this.seen.get(agent);
    if (!files) this.seen.set(agent, files = new Map());
    files.set(path, hash);
  }

  noteWrite(agent: string, path: string, hash: string): void {
    this.noteRead(agent, path, hash);
    this.writes.set(path, { hash, agent, at: new Date().toISOString() });
  }

  noteDelete(agent: string, path: string): void {
    this.seen.get(agent)?.delete(path);
    this.writes.set(path, { hash: "", agent, at: new Date().toISOString() });
  }

  /**
   * Returns a conflict explanation when `agent` would overwrite content it has not
   * seen. `current` is the hash of the file on disk (undefined when absent).
   */
  conflict(agent: string, path: string, display: string, current: string | undefined): string | undefined {
    if (current === undefined) return undefined;
    const known = this.seen.get(agent)?.get(path);
    if (known === current) return undefined;
    if (known === undefined) {
      return `${display} already exists and you have not read it. Read it first, then edit it (prefer edit_file or apply_patch).`;
    }
    const last = this.writes.get(path);
    const by = last && last.hash === current && last.agent !== agent ? `agent "${last.agent}" at ${last.at}` : "someone else (another agent, the user, or a command)";
    return `${display} was modified by ${by} after you last read it. Re-read it and reapply your change; MAR will not overwrite unseen changes.`;
  }

  lastWriter(path: string): string | undefined {
    return this.writes.get(path)?.agent;
  }
}
