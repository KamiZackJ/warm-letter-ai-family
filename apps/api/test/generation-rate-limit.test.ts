import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { auth, json, login, registerTextMaterial } from "./helpers.js";

async function createReadyLetter(
  app: FastifyInstance,
  token: string,
  label: string,
): Promise<string> {
  const materialId = await registerTextMaterial(app, token, `今天记录了${label}。`);
  const response = await app.inject({
    method: "POST",
    url: "/v1/letters",
    headers: auth(token),
    payload: { recipient: "妈妈", materialIds: [materialId] },
  });
  expect(response.statusCode).toBe(201);
  return json<{ letter: { id: string } }>(response).letter.id;
}

function generate(
  app: FastifyInstance,
  token: string,
  letterId: string,
  idempotencyKey: string,
  remoteAddress: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/v1/letters/${letterId}/generate`,
    headers: { ...auth(token), "idempotency-key": idempotencyKey },
    remoteAddress,
  });
}

describe("generation cost rate limit", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("limits one authenticated user across different IP addresses", async () => {
    app = buildApp({
      deploymentMode: "test",
      generationRateLimits: { perIp: 10, perUser: 1 },
    });
    const token = await login(app, "generation-user-limit");
    const firstLetter = await createReadyLetter(app, token, "第一件事");
    const secondLetter = await createReadyLetter(app, token, "第二件事");

    expect(
      (await generate(app, token, firstLetter, "generation-user-first-0001", "198.51.100.1"))
        .statusCode,
    ).toBe(202);
    const limited = await generate(
      app,
      token,
      secondLetter,
      "generation-user-second-0002",
      "198.51.100.2",
    );

    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(json<{ error: { code: string } }>(limited).error.code).toBe("RATE_LIMITED");
  });

  it("limits one IP address across different authenticated users", async () => {
    app = buildApp({
      deploymentMode: "test",
      generationRateLimits: { perIp: 1, perUser: 10 },
    });
    const firstToken = await login(app, "generation-ip-user-one");
    const secondToken = await login(app, "generation-ip-user-two");
    const firstLetter = await createReadyLetter(app, firstToken, "第一位用户");
    const secondLetter = await createReadyLetter(app, secondToken, "第二位用户");
    const sharedIp = "198.51.100.10";

    expect(
      (await generate(app, firstToken, firstLetter, "generation-ip-first-0001", sharedIp))
        .statusCode,
    ).toBe(202);
    const limited = await generate(
      app,
      secondToken,
      secondLetter,
      "generation-ip-second-0002",
      sharedIp,
    );

    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
  });

  it("does not consume or enforce buckets for an existing idempotent job replay", async () => {
    app = buildApp({
      deploymentMode: "test",
      generationRateLimits: { perIp: 2, perUser: 2 },
    });
    const token = await login(app, "generation-replay-limit");
    const firstLetter = await createReadyLetter(app, token, "第一次生成");
    const secondLetter = await createReadyLetter(app, token, "第二次生成");
    const thirdLetter = await createReadyLetter(app, token, "第三次生成");
    const remoteAddress = "198.51.100.20";
    const firstKey = "generation-replay-first-0001";

    const first = await generate(app, token, firstLetter, firstKey, remoteAddress);
    expect(first.statusCode).toBe(202);
    const firstJobId = json<{ job: { id: string } }>(first).job.id;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await generate(app, token, firstLetter, firstKey, remoteAddress);
      expect(replay.statusCode).toBe(202);
      expect(json<{ job: { id: string } }>(replay).job.id).toBe(firstJobId);
    }

    expect(
      (
        await generate(
          app,
          token,
          secondLetter,
          "generation-replay-second-0002",
          remoteAddress,
        )
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await generate(
          app,
          token,
          thirdLetter,
          "generation-replay-third-0003",
          remoteAddress,
        )
      ).statusCode,
    ).toBe(429);

    const replayAfterLimit = await generate(app, token, firstLetter, firstKey, remoteAddress);
    expect(replayAfterLimit.statusCode).toBe(202);
    expect(json<{ job: { id: string } }>(replayAfterLimit).job.id).toBe(firstJobId);
  });
});
