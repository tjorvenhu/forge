import { z } from "zod";

/** Counter keys the FORGE app sends; order is the display and SQL order. */
export const COUNTER_KEYS = [
  "tokensInput",
  "tokensOutput",
  "tokensCacheRead",
  "tokensCacheWrite",
  "claudeTurns",
  "claudeWorkMs",
  "sessions",
  "projectsCreated",
  "agentsStarted",
  "agentsMerged",
  "phoneCalls",
  "userTurns",
  "costUsdCents",
] as const;

export type CounterKey = (typeof COUNTER_KEYS)[number];
export type Counters = Record<CounterKey, number>;

/** Per-installation ceilings: one installation cannot plausibly reach more, so a higher value is manipulation. */
export const COUNTER_LIMITS: Counters = {
  tokensInput: 1e12,
  tokensOutput: 1e12,
  tokensCacheRead: 1e12,
  tokensCacheWrite: 1e12,
  claudeTurns: 1e7,
  claudeWorkMs: 1e11,
  sessions: 1e7,
  projectsCreated: 1e7,
  agentsStarted: 1e7,
  agentsMerged: 1e7,
  phoneCalls: 1e7,
  userTurns: 1e7,
  costUsdCents: 1e10,
};

export const MAX_MODELS = 20;
/** Ceilings per model and installation: all four token kinds together, and the same cost ceiling as the counter. */
export const MODEL_LIMITS = { tokens: 4e12, costUsdCents: 1e10 } as const;

export const MAX_BODY_BYTES = 4096;

export const PLAN_PATTERN = /^[a-z0-9_]{1,24}$/;
/** Language of the FORGE interface, "de" or "en" today. */
export const LANGUAGE_PATTERN = /^[a-z]{2}$/;

const counterShape = Object.fromEntries(
  COUNTER_KEYS.map((k) => [k, z.number().int().min(0).max(COUNTER_LIMITS[k]).default(0)]),
) as Record<CounterKey, z.ZodDefault<z.ZodNumber>>;

const modelSchema = z.object({
  tokens: z.number().int().min(0).max(MODEL_LIMITS.tokens),
  costUsdCents: z.number().int().min(0).max(MODEL_LIMITS.costUsdCents),
});

export type ModelUsage = z.infer<typeof modelSchema>;

const modelsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9._:[\]-]{1,64}$/), modelSchema)
  .refine((m) => Object.keys(m).length <= MAX_MODELS, `at most ${MAX_MODELS} models`)
  .default({});

export const installIdSchema = z.uuidv4().transform((s) => s.toLowerCase());

export const reportSchema = z.object({
  schema: z.literal(1),
  installId: installIdSchema,
  appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
  os: z.string().max(64).regex(/^\P{Cc}*$/u),
  // z.object drops unknown keys, so counters of newer app versions are ignored.
  counters: z.object(counterShape),
  // Cumulative per model since installation; app versions before it do not send it.
  models: modelsSchema,
  // Claude plan of the account ("max_20x", "pro" ...); null without a claude.ai login or from older app versions.
  plan: z.string().regex(PLAN_PATTERN).nullable().default(null),
  // Language of the FORGE interface; null from older app versions.
  language: z.string().regex(LANGUAGE_PATTERN).nullable().default(null),
});

export type Report = z.infer<typeof reportSchema>;

export type ParseResult = { ok: true; report: Report } | { ok: false; status: 400 | 413; error: string };

export function parseReport(raw: string): ParseResult {
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "body too large" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "invalid json" };
  }
  const result = reportSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, status: 400, error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid" };
  }
  return { ok: true, report: result.data };
}

/** Reads at most `limit` bytes of the body; null when it is longer. Stops reading early so a huge body is never buffered. */
export async function readBodyLimited(req: Request, limit = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
