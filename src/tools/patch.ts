import { ToolError } from "../errors.js";

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

function cleanPath(raw: string): string | null {
  const value = raw.trim().split("\t")[0]!.replace(/^"(.*)"$/, "$1");
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/** Parse a (possibly multi-file) unified diff, tolerating missing line numbers. */
export function parsePatch(text: string): FilePatch[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const files: FilePatch[] = [];
  let current: FilePatch | undefined;
  let hunk: Hunk | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      current = { oldPath: cleanPath(line.slice(4)), newPath: cleanPath(lines[index + 1]!.slice(4)), hunks: [] };
      files.push(current);
      hunk = undefined;
      index += 1;
      continue;
    }
    if (line.startsWith("@@")) {
      if (!current) throw new ToolError("Patch hunk appears before a ---/+++ file header.");
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      hunk = match ? { oldStart: Number(match[1]), lines: [] } : { lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue;
    const op = line[0];
    if (op === " " || op === "-" || op === "+") hunk.lines.push({ op, text: line.slice(1) });
    else if (line === "") {
      // A blank line inside a hunk is usually an unprefixed empty context line, except at the end.
      const rest = lines.slice(index + 1);
      if (rest.some((next) => /^[ +-]/.test(next) && !next.startsWith("---"))) hunk.lines.push({ op: " ", text: "" });
    } else if (!line.startsWith("diff ") && !line.startsWith("index ") && !/^(new|deleted) file mode|^similarity|^rename /.test(line)) {
      throw new ToolError(`Unrecognized patch line ${index + 1}: ${line.slice(0, 80)}`);
    }
  }
  if (!files.length) throw new ToolError("No file headers found. Use unified diff format with --- a/path and +++ b/path lines.");
  for (const file of files) {
    if (!file.oldPath && !file.newPath) throw new ToolError("A patch entry has /dev/null for both paths.");
    if (!file.hunks.length && file.oldPath === file.newPath) throw new ToolError(`Patch for ${file.newPath} has no hunks.`);
  }
  return files;
}

function findBlock(haystack: string[], needle: string[], expected: number, loose: boolean): number[] {
  const equal = (a: string, b: string): boolean => loose ? a.trimEnd() === b.trimEnd() : a === b;
  const positions: number[] = [];
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (!equal(haystack[start + offset]!, needle[offset]!)) { matches = false; break; }
    }
    if (matches) positions.push(start);
  }
  return positions.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected));
}

/** Apply hunks to file content. Every hunk must match exactly once near its expected position. */
export function applyHunks(content: string, hunks: Hunk[], label: string): { content: string; added: number; removed: number } {
  const endsWithNewline = content.endsWith("\n");
  const lines = content === "" ? [] : (endsWithNewline ? content.slice(0, -1) : content).split("\n");
  let delta = 0;
  let added = 0;
  let removed = 0;
  let cursor = 0;
  hunks.forEach((hunk, index) => {
    const before = hunk.lines.filter((line) => line.op !== "+").map((line) => line.text);
    const after = hunk.lines.filter((line) => line.op !== "-").map((line) => line.text);
    const expected = hunk.oldStart !== undefined ? Math.max(0, hunk.oldStart - 1 + delta) : cursor;
    let position: number;
    if (!before.length) {
      position = hunk.oldStart !== undefined ? Math.min(lines.length, hunk.oldStart === 0 ? 0 : expected) : lines.length;
    } else {
      let candidates = findBlock(lines, before, expected, false).filter((candidate) => candidate >= cursor);
      if (!candidates.length) candidates = findBlock(lines, before, expected, true).filter((candidate) => candidate >= cursor);
      if (!candidates.length) {
        throw new ToolError(`Hunk ${index + 1} does not apply to ${label}: its context/removed lines were not found. Re-read the file and regenerate the patch.`);
      }
      // With several identical matches, only an exact line-number hit is trusted; anything else would be a guess.
      if (candidates.length > 1 && (hunk.oldStart === undefined || candidates[0] !== expected)) {
        throw new ToolError(`Hunk ${index + 1} is ambiguous: its context matches ${candidates.length} places in ${label}. Add more context lines or correct the @@ line numbers.`);
      }
      position = candidates[0]!;
    }
    lines.splice(position, before.length, ...after);
    delta += after.length - before.length;
    cursor = position + after.length;
    added += hunk.lines.filter((line) => line.op === "+").length;
    removed += hunk.lines.filter((line) => line.op === "-").length;
  });
  const joined = lines.join("\n");
  return { content: lines.length ? `${joined}${endsWithNewline || content === "" ? "\n" : ""}` : "", added, removed };
}
