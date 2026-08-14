import { describe, expect, it } from "vitest";
import { FakeAIProvider } from "../src/ai.js";
import type { Letter, LetterDraft, ShareAccess } from "../src/domain.js";
import { ApiError } from "../src/errors.js";
import { MemoryRepository } from "../src/repository.js";
import { WarmLetterService } from "../src/service.js";

const draft: LetterDraft = {
  version: 1,
  title: "写给妈妈的一封暖笺",
  greeting: "亲爱的妈妈：",
  paragraphs: [{ id: "p-1", text: "我最近一切顺利。", sourceRefs: ["material-1"] }],
  closing: "周末再联系。",
  provider: "test",
  generatedAt: "2026-08-15T00:00:00.000Z",
};

class FailingShareRepository extends MemoryRepository {
  failNextShareSave = false;

  override saveShareAccess(access: ShareAccess): ShareAccess {
    if (this.failNextShareSave) {
      this.failNextShareSave = false;
      throw new Error("share persistence failed");
    }
    return super.saveShareAccess(access);
  }
}

function setup(now: () => Date, repository = new MemoryRepository()): {
  repository: MemoryRepository;
  service: WarmLetterService;
  letter: Letter;
} {
  repository.saveUser({
    id: "user-1",
    openId: "openid-1",
    displayName: "寄信人",
    createdAt: now().toISOString(),
  });
  repository.saveMaterial({
    id: "material-1",
    userId: "user-1",
    type: "text",
    name: "今日小记",
    textContent: "我最近一切顺利。",
    status: "READY",
    createdAt: now().toISOString(),
  });
  const letter = repository.saveLetter({
    id: "letter-1",
    userId: "user-1",
    recipient: "妈妈",
    materialIds: ["material-1"],
    settings: { tone: "warm", length: "short" },
    state: "EDITING",
    draft,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  });
  const service = new WarmLetterService(repository, new FakeAIProvider(), {
    now,
    shareTokenTtlMs: 60_000,
  });
  return { repository, service, letter };
}

function expectApiError(operation: () => unknown, code: string, statusCode: number): void {
  try {
    operation();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code, statusCode });
  }
}

describe("share access lifecycle", () => {
  it("rejects unsafe token configuration", () => {
    expect(
      () =>
        new WarmLetterService(new MemoryRepository(), new FakeAIProvider(), {
          shareTokenTtlMs: 0,
        }),
    ).toThrow("positive safe integer");
    expect(
      () =>
        new WarmLetterService(new MemoryRepository(), new FakeAIProvider(), {
          mediaSigningKeys: [Buffer.alloc(31)],
        }),
    ).toThrow("at least 32 bytes");
  });

  it("stores only a token hash and expires public access", () => {
    let currentTime = new Date("2026-08-15T00:00:00.000Z");
    const { repository, service, letter } = setup(() => currentTime);
    const published = service.confirmAndPublish("user-1", letter.id);

    expect(published.shareToken).toHaveLength(43);
    expect(repository.listShareAccess(letter.id)).toEqual([
      expect.objectContaining({
        letterId: letter.id,
        tokenHash: expect.not.stringContaining(published.shareToken),
        expiresAt: "2026-08-15T00:01:00.000Z",
      }),
    ]);
    expect(JSON.stringify(repository.getLetter(letter.id))).not.toContain(published.shareToken);
    expect(service.getReader(letter.id, published.shareToken).id).toBe(letter.id);

    currentTime = new Date("2026-08-15T00:01:00.000Z");
    expectApiError(
      () => service.getReader(letter.id, published.shareToken),
      "SHARE_TOKEN_EXPIRED",
      410,
    );
  });

  it("revokes old links when reissuing and supports explicit revocation", async () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const { service, letter } = setup(() => now);
    const original = service.confirmAndPublish("user-1", letter.id);
    const replacement = service.reissueShare("user-1", letter.id);

    expect(replacement.shareToken).not.toBe(original.shareToken);
    expectApiError(
      () => service.getReader(letter.id, original.shareToken),
      "SHARE_TOKEN_REVOKED",
      410,
    );
    expect(service.getReader(letter.id, replacement.shareToken).id).toBe(letter.id);

    service.revokeShare("user-1", letter.id);
    await expect(service.createReply(letter.id, replacement.shareToken, "收到")).rejects.toMatchObject({
      code: "SHARE_TOKEN_REVOKED",
      statusCode: 410,
    });
    expectApiError(() => service.getReader(letter.id, "guessed"), "PUBLIC_ACCESS_NOT_FOUND", 404);
  });

  it("keeps the current share active when replacement persistence fails", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const repository = new FailingShareRepository();
    const { service, letter } = setup(() => now, repository);
    const original = service.confirmAndPublish("user-1", letter.id);

    repository.failNextShareSave = true;
    expect(() => service.reissueShare("user-1", letter.id)).toThrow("share persistence failed");
    expect(service.getReader(letter.id, original.shareToken).id).toBe(letter.id);
    expect(repository.listShareAccess(letter.id)).toHaveLength(1);
  });
});
