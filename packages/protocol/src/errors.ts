import { z } from "zod";

export const ErrorCode = z.enum([
  "VALIDATION",
  "NOT_FOUND",
  "CONFLICT",
  "PATH_INVALID",
  "PATH_NOT_ACCESSIBLE",
  "DUPLICATE_PROJECT",
  "CLAUDE_NOT_INSTALLED",
  "CLAUDE_NOT_LOGGED_IN",
  "CLAUDE_RUNTIME",
  "SESSION_NOT_FOUND",
  "SESSION_BUSY",
  "GIT_NOT_INSTALLED",
  "GIT_NOT_REPO",
  "GIT_FAILED",
  "GIT_CONFLICT",
  "POLICY_DENIED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const RpcErrorSchema = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

/** `details` of the VALIDATION error when the phone is switched on before its setup is complete. */
export interface PhoneSetupIncomplete {
  phoneSetupIncomplete: true;
}

/** Thrown inside the sidecar; serialized as RpcError over the wire. */
export class ForgeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ForgeError";
  }

  toJSON(): RpcError {
    return { code: this.code, message: this.message, details: this.details };
  }
}
