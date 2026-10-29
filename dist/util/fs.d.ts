/** Write a file atomically: temporary file in the same directory, fsync, then rename. */
export declare function writeFileAtomic(path: string, content: string | Buffer, mode?: number): Promise<void>;
export declare function sha256(content: string | Buffer): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
//# sourceMappingURL=fs.d.ts.map