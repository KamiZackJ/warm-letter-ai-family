export interface CallbackTask<T> {
  success(value: T): void;
  fail(error: unknown): void;
}

export interface AbortableTask {
  abort?: () => void;
}

export interface CallbackTaskOptions<T> {
  timeoutMs: number;
  timeoutError: () => Error;
  onLateSuccess?: (value: T) => void | PromiseLike<void>;
}

/** Bound native callback APIs without relying on browser AbortController. */
export function runCallbackTask<T>(
  start: (callbacks: CallbackTask<T>) => AbortableTask | void,
  options: CallbackTaskOptions<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
      reject(new Error("操作等待时间配置无效"));
      return;
    }
    let settled = false;
    let succeeded = false;
    let expired = false;
    let task: AbortableTask | void;
    let abortAttempted = false;
    const deadlineAt = Date.now() + options.timeoutMs;
    const abort = (): void => {
      if (!task?.abort || abortAttempted) return;
      abortAttempted = true;
      try { task.abort(); } catch { /* Cancellation must not mask timeout. */ }
    };
    const finish = (complete: () => void): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      complete();
      return true;
    };
    const expire = (): void => {
      // Mark settled before abort: some tasks call fail synchronously from
      // abort(), which must not replace the stable timeout error.
      if (!finish(() => {
        expired = true;
        try { reject(options.timeoutError()); } catch (error) { reject(error); }
      })) return;
      abort();
    };
    const timer = setTimeout(expire, options.timeoutMs);
    try {
      task = start({
        success: (value) => {
          if (!settled && Date.now() >= deadlineAt) expire();
          if (settled) {
            if (!succeeded && options.onLateSuccess) {
              try { void Promise.resolve(options.onLateSuccess(value)).catch(() => undefined); }
              catch { /* Best-effort late-result cleanup must stay detached. */ }
            }
            return;
          }
          finish(() => { succeeded = true; resolve(value); });
        },
        fail: (error) => {
          if (!settled && Date.now() >= deadlineAt) expire();
          finish(() => reject(error));
        },
      });
      // A synchronous callback can exhaust the budget before start returns.
      if (expired) abort();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
