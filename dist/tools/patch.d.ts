export interface HunkLine {
    op: " " | "-" | "+";
    text: string;
}
export interface Hunk {
    oldStart?: number;
    lines: HunkLine[];
}
export interface FilePatch {
    /** null for file creation. */
    oldPath: string | null;
    /** null for file deletion. */
    newPath: string | null;
    hunks: Hunk[];
}
/** Parse a (possibly multi-file) unified diff, tolerating missing line numbers. */
export declare function parsePatch(text: string): FilePatch[];
/** Apply hunks to file content. Every hunk must match exactly once near its expected position. */
export declare function applyHunks(content: string, hunks: Hunk[], label: string): {
    content: string;
    added: number;
    removed: number;
};
//# sourceMappingURL=patch.d.ts.map