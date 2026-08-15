import { describe, expect, it, vi } from "vitest";
import {
  GenerationPollingTimeoutError,
  resolveGenerationJobId,
  waitForGenerationJob,
} from "../src/services/generation-polling";

describe("generation polling", () => {
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
        message: "家书仍在后台整理，请稍后返回查看",
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
});
