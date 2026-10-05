import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AiBudgetService } from '../src/server/ai-budget';
import { FileStorage, ApiError, type Storage } from '../src/server/storage';
import { AiLedgerSchema, DEFAULT_AI_LIMITS, maximumCost } from '../src/domain/ai-budget';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let directory: string, now: number, store: FileStorage, budget: AiBudgetService;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'passo-ai-budget-'));
  now = Date.parse('2026-10-05T12:00:00Z');
  store = new FileStorage(directory);
  budget = new AiBudgetService(store, () => now);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const run = (id = 'run-one', text = 'request') =>
  budget.start({ id, scope: 'example-trip', requestHash: hash(text) });
const reserve = (id = 'operation-one', maxCost = 100_000, runId = 'run-one') =>
  budget.reserve(runId, { id, maxCost, fingerprint: hash(id) });

describe('durable AI spending boundary', () => {
  it('allows one run and one paid dispatch under a hundred competing service instances', async () => {
    await budget.configure(true);
    const instances = Array.from(
      { length: 100 },
      () => new AiBudgetService(new FileStorage(directory), () => now),
    );
    const starts = await Promise.allSettled(
      instances.map((instance, index) =>
        instance.start({
          id: `burst-${index}`,
          scope: 'example-trip',
          requestHash: hash(`burst-${index}`),
        }),
      ),
    );
    const accepted = starts.filter((result) => result.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    const runId = (accepted[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    await reserve('burst-operation', 100_000, runId);
    let calls = 0;
    const dispatched = await Promise.allSettled(
      instances.map((instance) =>
        instance.dispatch(runId, 'burst-operation', async () => {
          calls++;
          return { value: true, actualCost: 10_000 };
        }),
      ),
    );
    expect(dispatched.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(calls).toBe(1);
    expect(await budget.status()).toMatchObject({ reserved: 0, daily: 10_000, monthly: 10_000 });
  });
  it('settles a proven free failed operation without retrying it or blocking later paid work', async () => {
    await budget.configure(true);
    await run();
    await reserve('free-operation', 0);
    let calls = 0;
    await expect(
      budget.dispatch('run-one', 'free-operation', async () => {
        calls++;
        throw new Error('Free provider unavailable');
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await budget.cancel('run-one');
    expect((await budget.status()).active).toBe(0);
    await expect(
      budget.dispatch('run-one', 'free-operation', async () => {
        calls++;
        return { value: true, actualCost: 0 };
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('caps daily job creation durably even for zero-cost requests', async () => {
    await budget.configure(true);
    for (let i = 0; i < 60; i++) {
      await run(`run-${i}`);
      await budget.finish(`run-${i}`);
    }
    await expect(run('run-too-many')).rejects.toMatchObject({ code: 'limit' });
    now += 24 * 3600_000;
    await run('run-next-day');
  });
  it('starts disabled and never dispatches without a reservation', async () => {
    let calls = 0;
    expect((await budget.status()).enabled).toBe(false);
    await expect(run()).rejects.toMatchObject({ code: 'disabled' });
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => {
        calls++;
        return { value: true, actualCost: 1 };
      }),
    ).rejects.toMatchObject({ code: 'disabled' });
    expect(calls).toBe(0);
  });
  it('reserves the maximum and settles only verified usage', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    expect((await budget.status()).reserved).toBe(100_000);
    const result = await budget.dispatch('run-one', 'operation-one', async () => ({
      value: 'proposal',
      actualCost: 20_000,
    }));
    expect(result).toBe('proposal');
    await budget.finish('run-one');
    expect(await budget.status()).toMatchObject({
      daily: 20_000,
      monthly: 20_000,
      reserved: 0,
      active: 0,
    });
  });
  it('deduplicates identical IDs and rejects changed payloads', async () => {
    await budget.configure(true);
    await run();
    await run();
    await reserve();
    await reserve();
    await expect(run('run-one', 'different request')).rejects.toMatchObject({ code: 'conflict' });
    await expect(reserve('operation-one', 99_000)).rejects.toMatchObject({ code: 'conflict' });
    expect((await budget.read()).ledger.runs).toHaveLength(1);
    expect((await budget.read()).ledger.runs[0].operations).toHaveLength(1);
  });
  it('allows only one active run across independent instances and trips', async () => {
    await budget.configure(true);
    const other = new AiBudgetService(new FileStorage(directory), () => now);
    const results = await Promise.allSettled([
      run(),
      other.start({ id: 'run-two', scope: 'other-trip', requestHash: hash('other') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await budget.status()).active).toBe(1);
  });
  it('claims a reserved operation once under concurrent dispatch', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    let calls = 0;
    const execute = async () => {
      calls++;
      return { value: 'ok', actualCost: 10_000 };
    };
    const other = new AiBudgetService(new FileStorage(directory), () => now);
    const results = await Promise.allSettled([
      budget.dispatch('run-one', 'operation-one', execute),
      other.dispatch('run-one', 'operation-one', execute),
    ]);
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('does not overspend a request when two instances reserve simultaneously', async () => {
    await budget.configure(true);
    await run();
    const other = new AiBudgetService(new FileStorage(directory), () => now);
    const results = await Promise.allSettled([
      reserve('op-one', 200_000),
      other.reserve('run-one', { id: 'op-two', maxCost: 200_000, fingerprint: hash('op-two') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await budget.status()).reserved).toBe(200_000);
  });
  it('enforces operation, daily and monthly limits before dispatch', async () => {
    await budget.configure(true, { request: 100, daily: 100, monthly: 100, operations: 1 });
    await run();
    await reserve('op-one', 100);
    await expect(reserve('op-two', 1)).rejects.toMatchObject({ code: 'limit' });
    await budget.dispatch('run-one', 'op-one', async () => ({ value: true, actualCost: 100 }));
    await budget.finish('run-one');
    await run('run-two');
    await expect(reserve('op-three', 1, 'run-two')).rejects.toMatchObject({ code: 'limit' });
    now += 24 * 3600_000;
    await expect(reserve('op-three', 1, 'run-two')).rejects.toMatchObject({ code: 'limit' });
    now = Date.parse('2026-11-01T12:00:00Z');
    await reserve('op-three', 1, 'run-two');
  });
  it('retains uncertain charges after timeout, cancellation and calendar rollover', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    let calls = 0;
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => {
        calls++;
        throw new Error('Provider may have accepted the request');
      }),
    ).rejects.toMatchObject({ code: 'uncertain' });
    await budget.cancel('run-one');
    now = Date.parse('2026-11-01T12:00:00Z');
    expect(await budget.status()).toMatchObject({
      daily: 100_000,
      monthly: 100_000,
      reserved: 100_000,
      active: 1,
    });
    await expect(run('run-two')).rejects.toMatchObject({ code: 'busy' });
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => {
        calls++;
        return { value: true, actualCost: 1 };
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
  it('charges a cross-midnight settlement conservatively to both periods', async () => {
    now = Date.parse('2026-10-31T23:59:59Z');
    await budget.configure(true);
    await run();
    await reserve();
    await budget.dispatch('run-one', 'operation-one', async () => {
      now += 2000;
      return { value: true, actualCost: 50_000 };
    });
    expect(await budget.status()).toMatchObject({ daily: 50_000, monthly: 50_000 });
  });
  it('releases only operations proven not dispatched on cancellation', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    await budget.cancel('run-one');
    expect(await budget.status()).toMatchObject({ reserved: 0, active: 0 });
    let calls = 0;
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => {
        calls++;
        return { value: true, actualCost: 1 };
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
  it('checks the kill switch after reservation and before dispatch', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    await budget.configure(false);
    let calls = 0;
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => {
        calls++;
        return { value: true, actualCost: 1 };
      }),
    ).rejects.toMatchObject({ code: 'disabled' });
    expect(calls).toBe(0);
    expect((await budget.status()).reserved).toBe(100_000);
  });
  it('does not reopen a cancelled run when an in-flight call finishes', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    let resolve!: (value: { value: boolean; actualCost: number }) => void;
    const response = new Promise<{ value: boolean; actualCost: number }>((r) => {
      resolve = r;
    });
    const dispatch = budget.dispatch('run-one', 'operation-one', () => response);
    await expect
      .poll(async () => (await budget.read()).ledger.runs[0].operations[0].state)
      .toBe('dispatched');
    await budget.cancel('run-one');
    resolve({ value: true, actualCost: 10_000 });
    await dispatch;
    expect((await budget.read()).ledger.runs[0].status).toBe('cancelled');
    expect((await budget.status()).active).toBe(0);
    await expect(reserve('op-two', 1)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('requires explicit evidence for operator reconciliation and never redispatches the old call', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => {
        throw new Error('Timeout');
      }),
    ).rejects.toBeDefined();
    await expect(budget.reconcile('run-one', 'operation-one', 1, 'expired')).rejects.toBeDefined();
    await budget.reconcile(
      'run-one',
      'operation-one',
      20_000,
      'Checked provider usage for this exact request.',
    );
    expect(await budget.status()).toMatchObject({ active: 0, reserved: 0, daily: 20_000 });
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => ({ value: true, actualCost: 1 })),
    ).rejects.toBeDefined();
    await run('run-two');
  });
  it('disables dispatch on malformed provider usage', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => ({ value: true, actualCost: -1 })),
    ).rejects.toMatchObject({ code: 'pricing' });
    expect(await budget.status()).toMatchObject({ enabled: false, reserved: 100_000 });
  });
  it('stops the workspace and retains the full known charge on an invalid price bound', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    await expect(
      budget.dispatch('run-one', 'operation-one', async () => ({
        value: true,
        actualCost: 200_000,
      })),
    ).rejects.toMatchObject({ code: 'pricing' });
    expect(await budget.status()).toMatchObject({ enabled: false, reserved: 200_000 });
    await expect(budget.configure(true)).rejects.toBeDefined();
  });
  it('fails closed when storage is unavailable or the ledger is malformed', async () => {
    let calls = 0;
    const unavailable: Storage = {
      ...store,
      read: async () => {
        throw new Error('Unavailable');
      },
      write: async () => {
        throw new Error('Unavailable');
      },
      remove: async () => {},
      list: async () => [],
      stream: async () => null,
    };
    const service = new AiBudgetService(unavailable);
    await expect(
      service.dispatch('run-one', 'operation-one', async () => {
        calls++;
        return { value: true, actualCost: 0 };
      }),
    ).rejects.toBeDefined();
    await store.write('ai/budget.json', new TextEncoder().encode('{}'), 'create');
    await expect(
      budget.start({ id: 'run-one', scope: 'trip', requestHash: hash('x') }),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
  it('never calls the provider after a failed dispatch claim write', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    let calls = 0;
    const broken: Storage = {
      read: store.read.bind(store),
      write: async () => {
        throw new ApiError(503, 'Unavailable');
      },
      remove: store.remove.bind(store),
      list: store.list.bind(store),
      stream: store.stream.bind(store),
    };
    await expect(
      new AiBudgetService(broken).dispatch('run-one', 'operation-one', async () => {
        calls++;
        return { value: true, actualCost: 0 };
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
  it('preserves the in-flight maximum if settlement storage fails', async () => {
    await budget.configure(true);
    await run();
    await reserve();
    let calls = 0,
      writes = 0;
    const broken: Storage = {
      read: store.read.bind(store),
      write: async (...args) => {
        if (++writes > 1) throw new ApiError(503, 'Unavailable');
        return store.write(args[0], args[1], args[2]);
      },
      remove: store.remove.bind(store),
      list: store.list.bind(store),
      stream: store.stream.bind(store),
    };
    await expect(
      new AiBudgetService(broken, () => now).dispatch('run-one', 'operation-one', async () => {
        calls++;
        return { value: true, actualCost: 10_000 };
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect((await budget.status()).reserved).toBe(100_000);
    await expect(budget.finish('run-one')).rejects.toMatchObject({ code: 'uncertain' });
  });
});

it('rounds integer token costs upward and rejects expired pricing', () => {
  const price = {
    id: 'mock',
    inputPerMillion: 2_000_000,
    outputPerMillion: 10_000_000,
    search: 10_000,
    route: 0,
    expiresAt: '2026-11-01T00:00:00Z',
  };
  const bounds = { inputTokens: 12_000, outputTokens: 2_000, searches: 2, routes: 0 };
  expect(maximumCost(price, bounds, now)).toBe(64_000);
  expect(
    maximumCost(
      { ...price, inputPerMillion: 1 },
      { ...bounds, inputTokens: 1, outputTokens: 0, searches: 0 },
      now,
    ),
  ).toBe(1);
  expect(() => maximumCost(price, bounds, Date.parse('2026-12-01T00:00:00Z'))).toThrow();
  expect(() => maximumCost(price, { ...bounds, inputTokens: -1 }, now)).toThrow();
});
it('rejects corrupt duplicate identities and unresolved completed records', () => {
  const entry = {
    id: 'run',
    scope: 'trip',
    requestHash: hash('x'),
    createdAt: '2026-10-05T00:00:00Z',
    status: 'active',
    operations: [],
  };
  expect(
    AiLedgerSchema.safeParse({
      version: 1,
      enabled: true,
      limits: DEFAULT_AI_LIMITS,
      runs: [entry, entry],
    }).success,
  ).toBe(false);
});
