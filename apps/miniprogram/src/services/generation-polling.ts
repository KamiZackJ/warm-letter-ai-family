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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class GenerationPollingTimeoutError extends Error {
  constructor() {
    super("家书仍在后台整理，请稍后返回查看");
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
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const startedAt = now();

  while (true) {
    let job: GenerationJobSnapshot;
    try {
      job = await fetchJob(jobId);
    } catch (error) {
      if (!options.shouldRetryError?.(error)) throw error;
      const elapsedMs = now() - startedAt;
      if (elapsedMs >= timeoutMs) throw new GenerationPollingTimeoutError();
      await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
      continue;
    }
    if (job.status === "succeeded" || job.status === "failed") return job;

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) throw new GenerationPollingTimeoutError();
    await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
}
