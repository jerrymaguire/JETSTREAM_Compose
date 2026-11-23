export type ErrorCode =
  | "invalid_request"
  | "payload_too_large"
  | "not_found"
  | "agent_busy"
  | "queue_timeout"
  | "run_timeout"
  | "gateway_call_failed"
  | "agent_runtime_failed"
  | "interrupted_by_restart"
  | "internal_error";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    retryable = false,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.details = details;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError("internal_error", message, 500, false);
}
