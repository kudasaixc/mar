export interface ParsedCommand {
    argv: string[];
    /** True when the string relies on shell features (pipes, redirection, expansion, ...). */
    complex: boolean;
}
/**
 * Split a command string into words using POSIX-like quoting. This is used only to
 * reason about policy rules; the string itself is still executed by a shell. It is
 * deliberately conservative: anything it cannot model is reported as `complex`.
 */
export declare function parseCommand(command: string): ParsedCommand;
/** Split a shell string into the simple commands it chains, for deny-rule matching. */
export declare function shellSegments(command: string): string[];
/** Remove wrappers such as `env X=1`, `nohup`, or `timeout 5` that run another command. */
export declare function unwrap(argv: string[]): string[];
/**
 * A deny rule matches when its first word equals the command name and every other
 * word appears among the arguments (order-insensitive; combined short flags such
 * as `-rf` are expanded). Nested `sh -c "..."` strings are inspected recursively.
 */
export declare function matchesDenyRule(argv: string[], rule: string, depth?: number): boolean;
export declare function deniedBy(command: string | string[], rules: string[]): string | undefined;
/**
 * An allow rule pre-approves a command only when it is a simple argv (no shell
 * features), its words start with the rule's words, no argument is known to
 * write or execute, and every path-like argument stays inside the workspace.
 */
export declare function allowedBy(command: string | string[], rules: string[]): string | undefined;
//# sourceMappingURL=command.d.ts.map