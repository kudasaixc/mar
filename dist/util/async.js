import { CancelledError } from "../errors.js";
/** Combine several optional signals; aborts when any input aborts. */
export function anySignal(...signals) {
    const controller = new AbortController();
    const listeners = [];
    for (const signal of signals) {
        if (!signal)
            continue;
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const listener = () => controller.abort(signal.reason);
        signal.addEventListener("abort", listener, { once: true });
        listeners.push([signal, listener]);
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const [signal, listener] of listeners)
                signal.removeEventListener("abort", listener);
        },
    };
}
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new CancelledError();
}
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(new CancelledError());
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new CancelledError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
/** Counting semaphore with FIFO fairness and cancellation-aware acquisition. */
export class Semaphore {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
        if (!Number.isInteger(limit) || limit < 1)
            throw new RangeError("Semaphore limit must be a positive integer.");
    }
    get pending() {
        return this.waiting.length;
    }
    get running() {
        return this.active;
    }
    async acquire(signal) {
        throwIfAborted(signal);
        if (this.active < this.limit) {
            this.active += 1;
            return this.releaser();
        }
        await new Promise((resolve, reject) => {
            const entry = { resolve, reject };
            this.waiting.push(entry);
            signal?.addEventListener("abort", () => {
                const index = this.waiting.indexOf(entry);
                if (index >= 0) {
                    this.waiting.splice(index, 1);
                    reject(new CancelledError());
                }
            }, { once: true });
        });
        return this.releaser();
    }
    async use(fn, signal) {
        const release = await this.acquire(signal);
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
    releaser() {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const next = this.waiting.shift();
            if (next)
                next.resolve();
            else
                this.active -= 1;
        };
    }
}
/** Per-key mutual exclusion (for example, one writer per file path). */
export class KeyedMutex {
    tails = new Map();
    async run(key, fn) {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        this.tails.set(key, tail);
        await previous;
        try {
            return await fn();
        }
        finally {
            release();
            if (this.tails.get(key) === tail)
                this.tails.delete(key);
        }
    }
}
//# sourceMappingURL=async.js.map