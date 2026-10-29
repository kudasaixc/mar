/** Combine several optional signals; aborts when any input aborts. */
export declare function anySignal(...signals: Array<AbortSignal | undefined>): {
    signal: AbortSignal;
    dispose(): void;
};
export declare function throwIfAborted(signal?: AbortSignal): void;
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
/** Counting semaphore with FIFO fairness and cancellation-aware acquisition. */
export declare class Semaphore {
    private readonly limit;
    private active;
    private readonly waiting;
    constructor(limit: number);
    get pending(): number;
    get running(): number;
    acquire(signal?: AbortSignal): Promise<() => void>;
    use<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    private releaser;
}
/** Per-key mutual exclusion (for example, one writer per file path). */
export declare class KeyedMutex {
    private readonly tails;
    run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=async.d.ts.map