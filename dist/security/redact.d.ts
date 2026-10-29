export declare class Redactor {
    private readonly values;
    constructor(secrets?: Iterable<string>);
    /** Build a redactor from sensitive-looking environment variables and explicitly named ones. */
    static fromEnvironment(env?: NodeJS.ProcessEnv, extraNames?: Iterable<string>): Redactor;
    redact(text: string): string;
    /** Deep-redact JSON-compatible data. */
    redactValue<T>(value: T): T;
}
export declare const NO_REDACTION: Redactor;
//# sourceMappingURL=redact.d.ts.map