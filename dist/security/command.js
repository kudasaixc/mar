import { basename, isAbsolute } from "node:path";
/** Characters that give a command string shell semantics beyond a single argv. */
const SHELL_META = /[;&|`$<>(){}\n\\*?[\]~!#]/;
/**
 * Split a command string into words using POSIX-like quoting. This is used only to
 * reason about policy rules; the string itself is still executed by a shell. It is
 * deliberately conservative: anything it cannot model is reported as `complex`.
 */
export function parseCommand(command) {
    const argv = [];
    let current = "";
    let inWord = false;
    let quote;
    let complex = false;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote === "'") {
            if (char === "'")
                quote = undefined;
            else
                current += char;
            continue;
        }
        if (quote === '"') {
            if (char === '"')
                quote = undefined;
            else {
                if (char === "$" || char === "`" || char === "\\")
                    complex = true;
                current += char;
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            inWord = true;
            continue;
        }
        if (/\s/.test(char)) {
            if (char === "\n")
                complex = true;
            if (inWord)
                argv.push(current);
            current = "";
            inWord = false;
            continue;
        }
        if (SHELL_META.test(char))
            complex = true;
        current += char;
        inWord = true;
    }
    if (quote)
        complex = true;
    if (inWord)
        argv.push(current);
    return { argv, complex };
}
/** Split a shell string into the simple commands it chains, for deny-rule matching. */
export function shellSegments(command) {
    return command
        .split(/\|\||&&|[;|&\n]|\$\(|`|\)/)
        .map((segment) => segment.trim())
        .filter(Boolean);
}
const WRAPPERS = new Set(["env", "command", "builtin", "exec", "nohup", "nice", "time", "timeout", "xargs", "stdbuf", "ionice", "chrt", "setsid"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** Remove wrappers such as `env X=1`, `nohup`, or `timeout 5` that run another command. */
export function unwrap(argv) {
    let rest = argv;
    for (let guard = 0; guard < 8 && rest.length; guard += 1) {
        const head = basename(rest[0]);
        if (!WRAPPERS.has(head))
            break;
        rest = rest.slice(1);
        while (rest.length && (rest[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || /^\d+[smhd]?$/.test(rest[0]))) {
            rest = rest.slice(1);
        }
    }
    return rest;
}
function expandFlags(tokens, keepCombined) {
    const flags = new Set();
    for (const token of tokens) {
        const combined = /^-[A-Za-z]{2,}$/.test(token);
        if (!combined || keepCombined)
            flags.add(token);
        if (combined)
            for (const letter of token.slice(1))
                flags.add(`-${letter}`);
    }
    return flags;
}
/**
 * A deny rule matches when its first word equals the command name and every other
 * word appears among the arguments (order-insensitive; combined short flags such
 * as `-rf` are expanded). Nested `sh -c "..."` strings are inspected recursively.
 */
export function matchesDenyRule(argv, rule, depth = 0) {
    const words = unwrap(argv);
    if (!words.length)
        return false;
    const name = basename(words[0]);
    if (SHELLS.has(name) && depth < 3) {
        const flagIndex = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
        const script = flagIndex >= 0 ? words[flagIndex + 1] : undefined;
        if (script !== undefined) {
            return shellSegments(script).some((segment) => matchesDenyRule(parseCommand(segment).argv, rule, depth + 1));
        }
    }
    const ruleWords = parseCommand(rule).argv;
    if (!ruleWords.length || basename(ruleWords[0]) !== name)
        return false;
    const present = expandFlags(words.slice(1), true);
    return [...expandFlags(ruleWords.slice(1), false)].every((word) => present.has(word));
}
export function deniedBy(command, rules) {
    const segments = Array.isArray(command)
        ? [command]
        : shellSegments(command).map((segment) => parseCommand(segment).argv);
    for (const argv of segments) {
        for (const rule of rules)
            if (matchesDenyRule(argv, rule))
                return rule;
    }
    return undefined;
}
/** Arguments that turn otherwise read-only tools into writers or executors. */
const UNSAFE_ARGUMENT = /^(?:--output|--pre\b|--pre=|-exec|-execdir|-delete|-ok|-fprint|--exec|-o$|--upload-pack|--ext-diff|-c$)/;
/**
 * An allow rule pre-approves a command only when it is a simple argv (no shell
 * features), its words start with the rule's words, no argument is known to
 * write or execute, and every path-like argument stays inside the workspace.
 */
export function allowedBy(command, rules) {
    const parsed = Array.isArray(command) ? { argv: command, complex: false } : parseCommand(command);
    if (parsed.complex || !parsed.argv.length)
        return undefined;
    const argv = parsed.argv;
    if (argv.slice(1).some((arg) => UNSAFE_ARGUMENT.test(arg)))
        return undefined;
    if (argv.slice(1).some((arg) => !arg.startsWith("-") && escapesWorkspace(arg)))
        return undefined;
    if (argv[0].includes("/"))
        return undefined;
    for (const rule of rules) {
        const words = parseCommand(rule).argv;
        if (words.length && words.length <= argv.length && words.every((word, index) => argv[index] === word))
            return rule;
    }
    return undefined;
}
function escapesWorkspace(arg) {
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    return isAbsolute(value) || value.startsWith("~") || /(^|[\\/])\.\.([\\/]|$)/.test(value);
}
//# sourceMappingURL=command.js.map