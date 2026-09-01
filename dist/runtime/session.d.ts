export declare class SessionStore {
    readonly id: string;
    readonly path: string;
    private constructor();
    static create(workspace: string): Promise<SessionStore>;
    append(type: string, data: unknown): Promise<void>;
}
//# sourceMappingURL=session.d.ts.map