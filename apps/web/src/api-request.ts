export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function apiErrorFrom(
  response: Response,
  fallback: string,
): Promise<ApiRequestError> {
  let code: string | undefined;
  let message = fallback;
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = payload.error?.code;
    message = payload.error?.message || fallback;
  } catch {
    // Keep the user-facing fallback when the server response is not JSON.
  }
  return new ApiRequestError(message, response.status, code);
}
