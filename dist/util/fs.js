import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
/** Write a file atomically: temporary file in the same directory, fsync, then rename. */
export async function writeFileAtomic(path, content, mode = 0o600) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    const handle = await open(temporary, "wx", mode);
    try {
        await handle.writeFile(content);
        await handle.sync();
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true });
        throw error;
    }
    await handle.close();
    try {
        await rename(temporary, path);
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
export function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=fs.js.map