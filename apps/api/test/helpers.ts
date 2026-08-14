import type { FastifyInstance, LightMyRequestResponse } from "fastify";

export function json<T>(response: LightMyRequestResponse): T {
  return response.json<T>();
}

export async function login(app: FastifyInstance, code = "captain-demo"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/wx-login",
    payload: { code, displayName: "Demo Sender" },
  });
  return json<{ token: string }>(response).token;
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function registerTextMaterial(
  app: FastifyInstance,
  token: string,
  textContent = "Today I cooked dinner and remembered home.",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/materials",
    headers: auth(token),
    payload: { type: "text", name: "daily-note", textContent },
  });
  return json<{ material: { id: string } }>(response).material.id;
}

export async function waitForJob(
  app: FastifyInstance,
  token: string,
  jobId: string,
): Promise<{ status: string; error?: { code: string } }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: auth(token),
    });
    const job = json<{ job: { status: string; error?: { code: string } } }>(response).job;
    if (job.status === "succeeded" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${jobId} did not finish`);
}
