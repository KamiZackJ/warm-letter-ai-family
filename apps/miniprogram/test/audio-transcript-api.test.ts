import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("../src/services/http-client", () => ({
  HttpRequestError: class HttpRequestError extends Error {}, request: requestMock,
  requestBinary: vi.fn(), uploadBinary: vi.fn(),
}));

import { realApi } from "../src/services/api";

const privateTranscripts = [{ materialId: "audio-1", text: "开了个会，有点累。", confirmed: true }];
const draft = {
  version: 1, title: "近况", greeting: "家里人：", paragraphs: [{ id: "p1", text: "开了个会。", sourceRefs: ["audio-1"] }],
  closing: "祝好", signature: "小暖",
};
const serverLetter = {
  id: "letter-1", recipient: "家里人", materialIds: ["audio-1"], state: "EDITING",
  settings: { tone: "warm", length: "short" }, draft,
  audioTranscripts: privateTranscripts, audioTranscriptRevisionPending: true,
  createdAt: "2026-09-18T12:00:00Z", updatedAt: "2026-09-18T12:00:00Z",
};

beforeEach(() => {
  requestMock.mockReset();
  const storage = new Map<string, unknown>([["warm_letter:test:access_token", "test-token"]]);
  Object.assign(globalThis, { wx: {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
  } });
});

describe("private audio transcript API", () => {
  it("sends the owner PATCH and maps the private correction and regeneration flag", async () => {
    requestMock.mockResolvedValue({ letter: serverLetter });
    const result = await realApi.updateAudioTranscript("letter-1", "audio-1", privateTranscripts[0]!.text);
    expect(requestMock).toHaveBeenCalledWith("/letters/letter-1/audio-transcripts/audio-1", {
      method: "PATCH", data: { text: privateTranscripts[0]!.text },
    });
    expect(result.audioTranscripts).toEqual(privateTranscripts);
    expect(result.audioTranscriptRevisionPending).toBe(true);
  });

  it("exposes transcripts only through the owner letter model, never the public reader mapper", async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === "/letters/letter-1") return { letter: serverLetter };
      if (path.endsWith("/replies")) return { replies: [] };
      return { reader: { ...serverLetter, publishedAt: serverLetter.createdAt, sources: [], replies: [] } };
    });
    expect((await realApi.getLetter("letter-1")).audioTranscripts).toEqual(privateTranscripts);
    const reader = await realApi.getReader("letter-1", "reader-token");
    expect(reader).not.toHaveProperty("audioTranscripts");
    expect(reader).not.toHaveProperty("audioTranscriptRevisionPending");
  });
});
