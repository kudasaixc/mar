export declare class Workspace {
    readonly maxOutput: number;
    readonly commandTimeoutMs: number;
    readonly root: string;
    private constructor();
    static create(path: string, maxOutput: number, commandTimeoutMs: number): Promise<Workspace>;
    resolveSafe(input?: string): Promise<string>;
    displayPath(path: string): string;
    read(path: string, startLine?: number, endLine?: number): Promise<string>;
    list(path?: string, depth?: number): Promise<string>;
    search(pattern: string, path?: string, glob?: string): Promise<string>;
    private searchWithoutRipgrep;
    write(path: string, content: string): Promise<string>;
    replace(path: string, oldText: string, newText: string, all?: boolean): Promise<string>;
    run(command: string): Promise<string>;
    diff(): Promise<string>;
    private assertCommand;
    private trimOutput;
}
//# sourceMappingURL=workspace.d.ts.map