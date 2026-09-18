import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCallbackTask, type CallbackTask } from "../src/services/async-task";

describe("native callback task deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("cleans up a late successful artifact without changing the original timeout", async () => {
    let callbacks!: CallbackTask<string>;
    const timeout = new Error("超时");
    const onLateSuccess = vi.fn(async () => { throw new Error("cleanup unavailable"); });
    const abort = vi.fn(() => callbacks.fail(new Error("native abort")));
    const result = runCallbackTask<string>((value) => { callbacks = value; return { abort }; }, {
      timeoutMs: 25, timeoutError: () => timeout, onLateSuccess,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toBe(timeout);
    callbacks.success("late-file.wav");
    await Promise.resolve();
    expect(onLateSuccess).toHaveBeenCalledWith("late-file.wav");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts immediate success once without cleaning up the accepted artifact", async () => {
    const onLateSuccess = vi.fn();
    const abort = vi.fn();
    await expect(runCallbackTask<string>((callbacks) => {
      callbacks.success("accepted.wav");
      callbacks.success("accepted.wav");
      callbacks.fail(new Error("late failure"));
      return { abort };
    }, { timeoutMs: 25, timeoutError: () => new Error("超时"), onLateSuccess })).resolves.toBe("accepted.wav");
    expect(abort).not.toHaveBeenCalled();
    expect(onLateSuccess).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when starting the native operation throws", async () => {
    const failure = new Error("native unavailable");
    await expect(runCallbackTask(() => { throw failure; }, {
      timeoutMs: 25, timeoutError: () => new Error("超时"),
    })).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
