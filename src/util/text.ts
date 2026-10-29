/** Keep the beginning and end of long text, marking exactly how much was removed. */
export function truncateMiddle(text: string, max: number, label = "chars"): string {
  if (text.length <= max) return text;
  if (max < 80) return `${text.slice(0, Math.max(0, max))}…`;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} ${label} omitted …]\n${text.slice(-tail)}`;
}

export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Bounded capture buffer keeping the head and the tail of a stream. */
export class BoundedBuffer {
  private head = "";
  private tail = "";
  private total = 0;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.total += chunk.length;
    const headLimit = Math.floor(this.limit / 2);
    if (this.head.length < headLimit) {
      const take = chunk.slice(0, headLimit - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-(this.limit - headLimit));
  }

  get truncated(): boolean {
    return this.total > this.head.length + this.tail.length;
  }

  get length(): number {
    return this.total;
  }

  toString(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n[… ${this.total - this.head.length - this.tail.length} chars omitted …]\n${this.tail}`;
  }
}
