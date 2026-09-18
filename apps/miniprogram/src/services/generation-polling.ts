export interface GenerationJobSnapshot {
  status: string;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export interface GenerationPollingOptions {
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  shouldRetryError?: (error: unknown) => boolean;
}

const defaultIntervalMs = 1_000;
const defaultTimeoutMs = 180_000;

export class GenerationPollingTimeoutError extends Error {
  constructor() {
    super("暂时未读到生成结果，请从最近家书查看");
    this.name = "GenerationPollingTimeoutError";
  }
}

export class GenerationJobFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GenerationJobFailedError";
  }
}

export async function resolveGenerationJobId(
  existingJobId: string | undefined,
  startJob: () => Promise<{ id: string }>,
): Promise<string> {
  if (existingJobId) return existingJobId;
  return (await startJob()).id;
}

export async function waitForGenerationJob(
  jobId: string,
  fetchJob: (jobId: string) => Promise<GenerationJobSnapshot>,
  options: GenerationPollingOptions = {},
): Promise<GenerationJobSnapshot> {
  const intervalMs = options.intervalMs ?? defaultIntervalMs;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
    !Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error("生成进度等待设置无效");
  }
  const now = options.now ?? Date.now;
  const startedAt = now();
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout>;
  let expired = false;
  const timeoutError = new GenerationPollingTimeoutError();
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => { expired = true; reject(timeoutError); }, timeoutMs);
  });
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    pauseTimer = setTimeout(() => { pauseTimer = undefined; resolve(); }, milliseconds);
  }));
  const remaining = (): number => {
    const milliseconds = timeoutMs - (now() - startedAt);
    if (expired || milliseconds <= 0) throw timeoutError;
    return milliseconds;
  };

  try {
    while (true) {
      remaining();
      let job: GenerationJobSnapshot;
      try {
        // Native network callbacks can disappear. A single pending fetch must
        // not bypass the overall foreground polling budget.
        job = await Promise.race([fetchJob(jobId), deadline]);
      } catch (error) {
        const milliseconds = remaining();
        if (error instanceof GenerationPollingTimeoutError || !options.shouldRetryError?.(error)) throw error;
        await Promise.race([sleep(Math.min(intervalMs, milliseconds)), deadline]);
        continue;
      }
      const milliseconds = remaining();
      if (job.status === "succeeded" || job.status === "failed") return job;
      await Promise.race([sleep(Math.min(intervalMs, milliseconds)), deadline]);
    }
  } finally {
    clearTimeout(deadlineTimer!);
    if (pauseTimer !== undefined) clearTimeout(pauseTimer);
  }
}
