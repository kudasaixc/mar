import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export class SessionStore {
  readonly id: string;
  readonly path: string;

  private constructor(path: string, id: string) {
    this.path = path;
    this.id = id;
  }

  static async create(workspace: string): Promise<SessionStore> {
    const root = process.env.MAR_STATE_DIR
      ? resolve(process.env.MAR_STATE_DIR)
      : join(homedir(), ".local", "state", "mar", "sessions");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const store = new SessionStore(join(root, `${id}.jsonl`), id);
    await store.append("session:start", { workspace: resolve(workspace), marVersion: "0.1.0" });
    return store;
  }

  async append(type: string, data: unknown): Promise<void> {
    const record = JSON.stringify({ timestamp: new Date().toISOString(), type, data });
    await appendFile(this.path, `${record}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
