import { z } from 'zod';

export const Microdollars = z.number().int().nonnegative().max(1_000_000_000);
export const AiLimitsSchema = z
  .object({
    monthly: Microdollars.positive(),
    daily: Microdollars.positive(),
    request: Microdollars.positive(),
    operations: z.number().int().min(1).max(20),
  })
  .strict()
  .refine((v) => v.request <= v.daily && v.daily <= v.monthly);
export type AiLimits = z.infer<typeof AiLimitsSchema>;
export const DEFAULT_AI_LIMITS: AiLimits = {
  monthly: 10_000_000,
  daily: 1_000_000,
  request: 250_000,
  operations: 3,
};
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
export const UsageBoundsSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(1_000_000),
    outputTokens: z.number().int().nonnegative().max(100_000),
    searches: z.number().int().nonnegative().max(5),
    routes: z.number().int().nonnegative().max(10),
  })
  .strict();
export type UsageBounds = z.infer<typeof UsageBoundsSchema>;
export const AiPriceSchema = z
  .object({
    id: identifier,
    inputPerMillion: Microdollars,
    outputPerMillion: Microdollars,
    search: Microdollars,
    route: Microdollars,
    expiresAt: timestamp,
  })
  .strict();
export type AiPrice = z.infer<typeof AiPriceSchema>;
export function maximumCost(price: AiPrice, bounds: UsageBounds, now: number): number {
  price = AiPriceSchema.parse(price);
  bounds = UsageBoundsSchema.parse(bounds);
  if (Date.parse(price.expiresAt) <= now)
    throw new AiBudgetError('pricing', 'Prezzi AI non aggiornati.');
  const million = 1_000_000n;
  const tokens =
    BigInt(bounds.inputTokens) * BigInt(price.inputPerMillion) +
    BigInt(bounds.outputTokens) * BigInt(price.outputPerMillion);
  const total =
    (tokens + million - 1n) / million +
    BigInt(bounds.searches) * BigInt(price.search) +
    BigInt(bounds.routes) * BigInt(price.route);
  return Microdollars.parse(Number(total));
}
const operationSchema = z
  .object({
    id: identifier,
    fingerprint: hash,
    maxCost: Microdollars,
    actualCost: Microdollars.optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    settledDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    reconciliation: z.string().min(12).max(1000).optional(),
    state: z.enum(['reserved', 'dispatched', 'uncertain', 'settled', 'released']),
    owner: identifier.optional(),
  })
  .strict();
const runSchema = z
  .object({
    id: identifier,
    scope: identifier,
    requestHash: hash,
    createdAt: timestamp,
    status: z.enum(['active', 'complete', 'cancelled', 'uncertain']),
    cancelRequested: z.boolean().default(false),
    operations: z.array(operationSchema).max(20),
  })
  .strict();
export const AiLedgerSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    limits: AiLimitsSchema,
    runs: z.array(runSchema).max(1000),
  })
  .strict()
  .superRefine((ledger, ctx) => {
    if (new Set(ledger.runs.map((r) => r.id)).size !== ledger.runs.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate run IDs' });
    for (const run of ledger.runs) {
      if (new Set(run.operations.map((o) => o.id)).size !== run.operations.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate operation IDs' });
      for (const op of run.operations) {
        if (op.state === 'settled' && op.actualCost === undefined)
          ctx.addIssue({ code: 'custom', message: 'Settled usage must be known' });
        if (op.actualCost !== undefined && op.actualCost > op.maxCost && ledger.enabled)
          ctx.addIssue({ code: 'custom', message: 'Usage exceeded the reserved upper bound' });
        if (['dispatched', 'uncertain', 'settled'].includes(op.state) && !op.owner)
          ctx.addIssue({ code: 'custom', message: 'Dispatch ownership missing' });
        if (run.status === 'complete' && !['settled', 'released'].includes(op.state))
          ctx.addIssue({ code: 'custom', message: 'Completed run has unresolved usage' });
      }
    }
  });
export type AiLedger = z.infer<typeof AiLedgerSchema>;
export type AiRun = AiLedger['runs'][number];
export type AiOperation = AiRun['operations'][number];
export class AiBudgetError extends Error {
  constructor(
    public code: 'disabled' | 'limit' | 'busy' | 'conflict' | 'uncertain' | 'pricing',
    message: string,
  ) {
    super(message);
    this.name = 'AiBudgetError';
  }
}
export function initialLedger(): AiLedger {
  return { version: 1, enabled: false, limits: { ...DEFAULT_AI_LIMITS }, runs: [] };
}
export function operationCost(op: AiOperation) {
  return op.state === 'released'
    ? 0
    : op.state === 'settled'
      ? op.actualCost!
      : Math.max(op.actualCost ?? 0, op.maxCost);
}
export function budgetUsage(ledger: AiLedger, now: number) {
  const day = new Date(now).toISOString().slice(0, 10),
    month = day.slice(0, 7);
  const operations = ledger.runs.flatMap((r) => r.operations);
  // Uncertain/in-flight liabilities survive calendar rollover. They continue
  // to consume both limits until the accepted provider operation is reconciled.
  const open = (op: AiOperation) => !['released', 'settled'].includes(op.state);
  return {
    daily: operations
      .filter((op) => op.day === day || op.settledDay === day || open(op))
      .reduce((sum, op) => sum + operationCost(op), 0),
    monthly: operations
      .filter((op) => op.month === month || op.settledDay?.slice(0, 7) === month || open(op))
      .reduce((sum, op) => sum + operationCost(op), 0),
    reserved: operations.filter(open).reduce((sum, op) => sum + operationCost(op), 0),
    active: ledger.runs.filter((r) => ['active', 'uncertain'].includes(r.status)).length,
  };
}
export function requireEnabled(ledger: AiLedger) {
  if (!ledger.enabled)
    throw new AiBudgetError('disabled', 'Assistenza AI momentaneamente disattivata.');
}
export function findRun(ledger: AiLedger, id: string) {
  const run = ledger.runs.find((r) => r.id === id);
  if (!run) throw new AiBudgetError('conflict', 'Richiesta AI non disponibile.');
  return run;
}
export function startRun(
  ledger: AiLedger,
  input: { id: string; scope: string; requestHash: string },
  now: number,
): AiRun {
  requireEnabled(ledger);
  identifier.parse(input.id);
  identifier.parse(input.scope);
  hash.parse(input.requestHash);
  const existing = ledger.runs.find((r) => r.id === input.id);
  if (existing) {
    if (existing.scope !== input.scope || existing.requestHash !== input.requestHash)
      throw new AiBudgetError('conflict', 'Questa richiesta è già associata a dati diversi.');
    return existing;
  }
  if (budgetUsage(ledger, now).active)
    throw new AiBudgetError('busy', 'È già in corso una richiesta AI.');
  if (ledger.runs.length >= 1000)
    throw new AiBudgetError('limit', 'Registro AI completo. Serve una verifica amministrativa.');
  const run: AiRun = {
    ...input,
    createdAt: new Date(now).toISOString(),
    status: 'active',
    cancelRequested: false,
    operations: [],
  };
  ledger.runs.push(run);
  return run;
}
export function reserveOperation(
  ledger: AiLedger,
  runId: string,
  input: { id: string; fingerprint: string; maxCost: number },
  now: number,
): AiOperation {
  requireEnabled(ledger);
  identifier.parse(input.id);
  hash.parse(input.fingerprint);
  Microdollars.parse(input.maxCost);
  const run = findRun(ledger, runId);
  const existing = run.operations.find((o) => o.id === input.id);
  if (existing) {
    if (existing.fingerprint !== input.fingerprint || existing.maxCost !== input.maxCost)
      throw new AiBudgetError('conflict', 'Operazione AI già associata a dati diversi.');
    return existing;
  }
  if (run.status !== 'active' || run.cancelRequested)
    throw new AiBudgetError('conflict', 'Richiesta AI già chiusa.');
  const usage = budgetUsage(ledger, now);
  if (
    run.operations.length >= ledger.limits.operations ||
    run.operations.reduce((sum, op) => sum + operationCost(op), 0) + input.maxCost >
      ledger.limits.request ||
    usage.daily + input.maxCost > ledger.limits.daily ||
    usage.monthly + input.maxCost > ledger.limits.monthly
  )
    throw new AiBudgetError('limit', 'Limite di spesa AI raggiunto.');
  const day = new Date(now).toISOString().slice(0, 10);
  const op: AiOperation = { ...input, day, month: day.slice(0, 7), state: 'reserved' };
  run.operations.push(op);
  return op;
}
