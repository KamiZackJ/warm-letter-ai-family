export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function assertFound<T>(value: T | undefined, code: string, message: string): T {
  if (value === undefined) {
    throw new ApiError(404, code, message);
  }
  return value;
}
