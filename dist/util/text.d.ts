/** Keep the beginning and end of long text, marking exactly how much was removed. */
export declare function truncateMiddle(text: string, max: number, label?: string): string;
export declare function oneLine(text: string, max?: number): string;
/** Bounded capture buffer keeping the head and the tail of a stream. */
export declare class BoundedBuffer {
    private readonly limit;
    private head;
    private tail;
    private total;
    constructor(limit: number);
    push(chunk: string): void;
    get truncated(): boolean;
    get length(): number;
    toString(): string;
}
//# sourceMappingURL=text.d.ts.map