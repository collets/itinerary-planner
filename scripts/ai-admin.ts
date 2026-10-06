import { config } from 'dotenv';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { AiBudgetService } from '../src/server/ai-budget.js';
import { FileStorage } from '../src/server/storage.js';
import { AiLimitsSchema, Microdollars } from '../src/domain/ai-budget.js';
import { aiProviders } from '../src/server/ai-config.js';
import { apiClient } from './api-client.js';
config({ path: process.env.ITINERARY_ENV_FILE ?? '.env.local', quiet: true });
const [command, ...args] = process.argv.slice(2);
try {
  const enabled = command === 'enable';
  const body =
    command === 'enable' || command === 'disable'
      ? {
          enabled,
          ...(args.find((a) => a.startsWith('--limits='))
            ? {
                limits: AiLimitsSchema.parse(
                  JSON.parse(
                    await readFile(args.find((a) => a.startsWith('--limits='))!.slice(9), 'utf8'),
                  ),
                ),
              }
            : {}),
        }
      : command === 'reconcile'
        ? z
            .object({
              runId: z.string(),
              operationId: z.string(),
              actualCost: Microdollars,
              evidence: z.string().min(12).max(1000),
            })
            .strict()
            .parse(JSON.parse(await readFile(args[0], 'utf8')))
        : undefined;
  if (!['status', 'enable', 'disable', 'reconcile'].includes(command))
    throw new Error(
      'Usage: pnpm ai:admin status|enable|disable [--local] [--limits=ignored.json], or reconcile ignored-evidence.json [--local]',
    );
  let result: unknown;
  if (args.includes('--local')) {
    if (process.env.VERCEL || process.env.STORAGE_DRIVER === 'blob')
      throw new Error('Local administration requires local file storage');
    if (enabled && !aiProviders())
      throw new Error('Configure a mock or fully gated live provider before enabling');
    const budget = new AiBudgetService(new FileStorage(process.env.DATA_DIR ?? 'local-data/store'));
    if (command === 'status') {
      const { ledger } = await budget.read();
      result = { ...(await budget.status()), runs: ledger.runs.slice(-20) };
    } else if (command === 'reconcile') {
      const input = body as {
        runId: string;
        operationId: string;
        actualCost: number;
        evidence: string;
      };
      await budget.reconcile(input.runId, input.operationId, input.actualCost, input.evidence);
      result = { ok: true };
    } else
      result = await budget.configure(
        enabled,
        (body as { limits?: z.infer<typeof AiLimitsSchema> }).limits,
      );
  } else {
    const token = process.env.ITINERARY_AI_ADMIN_TOKEN;
    if (!token || token.length < 32)
      throw new Error('Set an independent ITINERARY_AI_ADMIN_TOKEN in an ignored environment file');
    const client = apiClient(process.env.ITINERARY_API_URL ?? 'http://localhost:5173', token);
    const response = await client.fetch(
      `/api/v2/ai/admin/${command === 'status' ? 'status' : command === 'reconcile' ? 'reconcile' : 'configure'}`,
      {
        method: command === 'status' ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok)
      throw new Error(
        `Administration failed (HTTP ${response.status}); no provider call was initiated`,
      );
    result = await response.json();
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'AI administration failed');
  process.exitCode = 1;
}
