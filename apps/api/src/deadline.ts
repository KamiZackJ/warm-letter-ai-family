/** A single wall-clock budget shared by all awaited stages of an operation. */
export class OperationDeadline {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly expiresAt: number;
  private readonly timeoutError: Error;
  private readonly cancelled: Promise<never>;
  private rejectCancelled!: (error: Error) => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cleanups = new Set<() => unknown>();
  private closed = false;
  private readonly detachParent?: () => void;

  constructor(timeoutMs: number, errorFactory: () => Error, parentSignal?: AbortSignal) {
    this.expiresAt = Date.now() + timeoutMs;
    this.timeoutError = errorFactory();
    this.cancelled = new Promise<never>((_resolve, reject) => { this.rejectCancelled = reject; });
    // A deadline can expire while code is between awaits or after an operation
    // was synchronously rejected. It must never create an unhandled rejection.
    void this.cancelled.catch(() => undefined);
    this.timer = setTimeout(() => this.dispose(), timeoutMs);
    if (parentSignal) {
      const abort = () => this.dispose();
      parentSignal.addEventListener("abort", abort, { once: true });
      this.detachParent = () => parentSignal.removeEventListener("abort", abort);
      if (parentSignal.aborted) this.dispose();
    }
  }

  check(): void {
    if (!this.closed && Date.now() >= this.expiresAt) this.dispose();
    if (this.closed) throw this.timeoutError;
  }

  remainingMs(): number {
    this.check();
    return Math.max(1, this.expiresAt - Date.now());
  }

  async wait<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.check();
    const work = Promise.resolve().then(() => {
      this.check();
      return operation();
    });
    try {
      const result = await Promise.race([work, this.cancelled]);
      this.check();
      return result;
    } catch (error) {
      this.check();
      throw error;
    }
  }

  addCleanup(cleanup: () => unknown): () => void {
    if (this.closed) this.runCleanup(cleanup);
    else this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.detachParent?.();
    this.rejectCancelled(this.timeoutError);
    this.controller.abort(this.timeoutError);
    for (const cleanup of this.cleanups) this.runCleanup(cleanup);
    this.cleanups.clear();
  }

  private runCleanup(cleanup: () => unknown): void {
    try {
      // A stuck cancel()/return() must not extend the caller's deadline.
      void Promise.resolve(cleanup()).catch(() => undefined);
    } catch { /* Cleanup errors must not mask the operation's result. */ }
  }
}
