import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GenerationPollingTimeoutError,
  resolveGenerationJobId,
  waitForGenerationJob,
} from "../src/services/generation-polling";

describe("generation polling", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("keeps waiting for a 12-second generation job within the real-provider window", async () => {
    let elapsedMs = 0;
    const fetchJob = vi.fn(async () => ({
      status: elapsedMs >= 12_000 ? "succeeded" : "running",
    }));

    const job = await waitForGenerationJob("job-1", fetchJob, {
      intervalMs: 1_000,
      timeoutMs: 180_000,
      now: () => elapsedMs,
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds;
      },
    });

    expect(job.status).toBe("succeeded");
    expect(elapsedMs).toBe(12_000);
    expect(fetchJob).toHaveBeenCalledTimes(13);
  });

  it("resumes a stored job without submitting generation again", async () => {
    const startJob = vi.fn().mockResolvedValue({ id: "new-job" });

    await expect(resolveGenerationJobId("active-job", startJob)).resolves.toBe("active-job");
    expect(startJob).not.toHaveBeenCalled();

    await expect(resolveGenerationJobId(undefined, startJob)).resolves.toBe("new-job");
    expect(startJob).toHaveBeenCalledTimes(1);
  });

  it("reports a persistent background state instead of a false generation failure", async () => {
    let elapsedMs = 0;
    const result = waitForGenerationJob("job-1", async () => ({ status: "running" }), {
      intervalMs: 1_000,
      timeoutMs: 2_000,
      now: () => elapsedMs,
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds;
      },
    });

    await expect(result).rejects.toEqual(
      expect.objectContaining<Partial<GenerationPollingTimeoutError>>({
        name: "GenerationPollingTimeoutError",
        message: "暂时未读到生成结果，请从最近家书查看",
      }),
    );
  });

  it("keeps the same job after a transient polling network error", async () => {
    let elapsedMs = 0;
    const networkError = new Error("request:fail timeout");
    const fetchJob = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "succeeded" });

    const job = await waitForGenerationJob("job-1", fetchJob, {
      intervalMs: 1_000,
      timeoutMs: 10_000,
      now: () => elapsedMs,
      sleep: async (milliseconds) => {
        elapsedMs += milliseconds;
      },
      shouldRetryError: (error) => error === networkError,
    });

    expect(job.status).toBe("succeeded");
    expect(fetchJob).toHaveBeenNthCalledWith(1, "job-1");
    expect(fetchJob).toHaveBeenNthCalledWith(2, "job-1");
    expect(fetchJob).toHaveBeenNthCalledWith(3, "job-1");
  });

  it("does not retry a permanent polling error", async () => {
    const permanentError = new Error("job not found");
    const fetchJob = vi.fn().mockRejectedValue(permanentError);

    await expect(
      waitForGenerationJob("job-1", fetchJob, {
        shouldRetryError: () => false,
      }),
    ).rejects.toBe(permanentError);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it("returns the background timeout even when a single fetch never settles", async () => {
    vi.useFakeTimers();
    let finish!: (job: { status: string }) => void;
    const fetchJob = vi.fn(() => new Promise<{ status: string }>((resolve) => { finish = resolve; }));
    const result = waitForGenerationJob("job-1", fetchJob, { timeoutMs: 100, shouldRetryError: () => true })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeInstanceOf(GenerationPollingTimeoutError);
    finish({ status: "succeeded" });
    await Promise.resolve();
    expect(fetchJob).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds a custom sleep and clears polling timers on quick completion", async () => {
    vi.useFakeTimers();
    const result = waitForGenerationJob("job-1", async () => ({ status: "running" }), {
      timeoutMs: 100,
      sleep: () => new Promise(() => undefined),
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeInstanceOf(GenerationPollingTimeoutError);
    await expect(waitForGenerationJob("job-2", async () => ({ status: "succeeded" }))).resolves.toEqual({ status: "succeeded" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
