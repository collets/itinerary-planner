import { randomUUID } from 'node:crypto';
import {
  AiLedgerSchema,
  AiLimitsSchema,
  AiBudgetError,
  initialLedger,
  budgetUsage,
  startRun,
  reserveOperation,
  findRun,
  requireEnabled,
  Microdollars,
  type AiLedger,
  type AiLimits,
} from '../domain/ai-budget.js';
import { ApiError, type Storage } from './storage.js';

const PATH = 'ai/budget.json';
export class AiBudgetService {
  constructor(
    private store: Storage,
    private now: () => number = Date.now,
  ) {}
  async read() {
    const item = await this.store.read(PATH);
    return {
      ledger: item
        ? AiLedgerSchema.parse(JSON.parse(new TextDecoder().decode(item.body)))
        : initialLedger(),
      etag: item?.etag,
    };
  }
  private async change<T>(fn: (ledger: AiLedger) => T): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { ledger, etag } = await this.read();
      const before = JSON.stringify(ledger);
      const value = fn(ledger);
      AiLedgerSchema.parse(ledger);
      if (before === JSON.stringify(ledger)) return value;
      try {
        await this.store.write(
          PATH,
          new TextEncoder().encode(JSON.stringify(ledger)),
          etag ?? 'create',
        );
        return value;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 412)) throw error;
      }
    }
    throw new AiBudgetError('busy', 'Registro di spesa AI occupato. Riprova più tardi.');
  }
  async status() {
    const { ledger } = await this.read();
    return { enabled: ledger.enabled, limits: ledger.limits, ...budgetUsage(ledger, this.now()) };
  }
  // This method is an operator capability; never expose it to family sessions
  // or to model tools. Existing commitments are preserved when limits change.
  configure(enabled: boolean, limits?: AiLimits) {
    return this.change((ledger) => {
      ledger.enabled = enabled;
      if (limits) ledger.limits = AiLimitsSchema.parse(limits);
      return { enabled: ledger.enabled, limits: ledger.limits };
    });
  }
  start(input: { id: string; scope: string; requestHash: string }) {
    return this.change((ledger) => structuredClone(startRun(ledger, input, this.now())));
  }
  reserve(runId: string, input: { id: string; fingerprint: string; maxCost: number }) {
    return this.change((ledger) =>
      structuredClone(reserveOperation(ledger, runId, input, this.now())),
    );
  }
  private claim(runId: string, operationId: string, owner: string) {
    return this.change((ledger) => {
      requireEnabled(ledger);
      const run = findRun(ledger, runId);
      if (run.status !== 'active' || run.cancelRequested)
        throw new AiBudgetError('conflict', 'Richiesta AI già chiusa.');
      const op = run.operations.find((o) => o.id === operationId);
      if (!op || op.state !== 'reserved')
        throw new AiBudgetError(
          'uncertain',
          'Operazione AI già avviata. Attendi o verifica il risultato.',
        );
      op.state = 'dispatched';
      op.owner = owner;
      return structuredClone(op);
    });
  }
  private settle(runId: string, operationId: string, owner: string, actualCost?: number) {
    return this.change((ledger) => {
      const run = findRun(ledger, runId),
        op = run.operations.find((o) => o.id === operationId);
      if (!op || op.owner !== owner || !['dispatched', 'uncertain'].includes(op.state))
        throw new AiBudgetError('conflict', 'Proprietà della richiesta AI non valida.');
      if (actualCost === undefined) {
        op.state = 'uncertain';
        run.status = 'uncertain';
      } else {
        const cost = Microdollars.safeParse(actualCost);
        if (!cost.success || actualCost > op.maxCost) {
          // An invalid pricing bound must stop the workspace. Preserve the
          // reservation and force operator investigation, never under-report.
          ledger.enabled = false;
          op.state = 'uncertain';
          run.status = 'uncertain';
          if (cost.success) op.actualCost = actualCost;
          return false;
        }
        op.actualCost = actualCost;
        op.state = 'settled';
        op.settledDay = new Date(this.now()).toISOString().slice(0, 10);
        if (
          run.status === 'uncertain' &&
          run.operations.every((o) => ['released', 'settled'].includes(o.state))
        )
          run.status = run.cancelRequested ? 'cancelled' : 'active';
      }
      return true;
    });
  }
  async dispatch<T>(
    runId: string,
    operationId: string,
    execute: () => Promise<{ value: T; actualCost: number }>,
  ) {
    const owner = randomUUID();
    const operation = await this.claim(runId, operationId, owner);
    // A disable after the CAS claim stops the call when observed. Calls already
    // accepted by the provider cannot be recalled or assumed unbilled.
    if (!(await this.read()).ledger.enabled) {
      await this.settle(runId, operationId, owner, 0);
      throw new AiBudgetError('disabled', 'Assistenza AI momentaneamente disattivata.');
    }
    let result: { value: T; actualCost: number };
    try {
      result = await execute();
    } catch {
      if (operation.maxCost === 0) {
        // A verified free provider cannot create a monetary liability. Keep its
        // exactly-once claim settled, and do not retry the failed operation.
        await this.settle(runId, operationId, owner, 0);
        throw new AiBudgetError(
          'conflict',
          'Il fornitore gratuito non ha completato la richiesta. Il programma resta invariato.',
        );
      }
      await this.settle(runId, operationId, owner).catch(() => {});
      throw new AiBudgetError(
        'uncertain',
        'Richiesta AI interrotta. La spesa resta riservata finché non è verificata.',
      );
    }
    const valid = await this.settle(runId, operationId, owner, result.actualCost);
    if (!valid)
      throw new AiBudgetError('pricing', 'Spesa AI da verificare. Assistenza disattivata.');
    return result.value;
  }
  finish(runId: string) {
    return this.change((ledger) => {
      const run = findRun(ledger, runId);
      if (run.operations.some((o) => ['dispatched', 'uncertain'].includes(o.state)))
        throw new AiBudgetError('uncertain', 'Spesa AI ancora da verificare.');
      for (const op of run.operations) if (op.state === 'reserved') op.state = 'released';
      run.status = run.cancelRequested ? 'cancelled' : 'complete';
    });
  }
  cancel(runId: string) {
    return this.change((ledger) => {
      const run = findRun(ledger, runId);
      if (run.status === 'complete') return;
      run.cancelRequested = true;
      for (const op of run.operations) if (op.state === 'reserved') op.state = 'released';
      run.status = run.operations.some((o) => ['dispatched', 'uncertain'].includes(o.state))
        ? 'uncertain'
        : 'cancelled';
    });
  }
  // Operator-only recovery. Evidence comes from checking provider usage, never
  // from a lease timeout, a model response or an ordinary browser session.
  async reconcile(runId: string, operationId: string, actualCost: number, evidence: string) {
    Microdollars.parse(actualCost);
    if (evidence.trim().length < 12 || evidence.length > 1000)
      throw new ApiError(422, 'Descrivi la verifica della spesa prima di riconciliarla.');
    return this.change((ledger) => {
      const run = findRun(ledger, runId),
        op = run.operations.find((o) => o.id === operationId);
      if (!op || !['dispatched', 'uncertain'].includes(op.state))
        throw new AiBudgetError('conflict', 'Nessuna spesa incerta da riconciliare.');
      op.actualCost = actualCost;
      op.reconciliation = evidence.trim();
      op.settledDay = new Date(this.now()).toISOString().slice(0, 10);
      op.state = 'settled';
      if (actualCost > op.maxCost) ledger.enabled = false;
      if (run.operations.every((o) => ['settled', 'released'].includes(o.state)))
        run.status = run.cancelRequested ? 'cancelled' : 'complete';
    });
  }
}
