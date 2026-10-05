import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { secureHeaders } from 'hono/secure-headers';
import { z, ZodError } from 'zod';
import jsonPatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import {
  handleUpload,
  handleUploadPresigned,
  type HandleUploadBody,
  type HandleUploadPresignedBody,
  type HandleUploadOptions,
} from '@vercel/blob/client';
import { issueSignedToken } from '@vercel/blob';
import {
  Id,
  PlanSchema,
  TripSchema,
  ReservationSchema,
  TicketSchema,
  ProgressStatus,
} from '../domain/schema.js';
import { bookingWarnings } from '../domain/trip.js';
import { ApiError, storage } from './storage.js';
import { TripService } from './service.js';
import { checkOrigin, login, logout, role, sameHash } from './auth.js';
import { exchangeRate } from './rates.js';
import { TravelCommandSchema } from '../domain/travel.js';
import { createThrottle, limitBody } from './security.js';
import { AiService } from './ai.js';
import { MockAiProviders } from './ai-providers.js';
import { AiRequestSchema, AiPlanError } from '../domain/ai.js';
import { AiLimitsSchema, AiBudgetError, Microdollars } from '../domain/ai-budget.js';

const prefix = '/api/v1';
type Env = { Variables: { role: 'agent' | 'browser' | 'ai-admin' } };
export function createApp(injected?: TripService, injectedAi?: AiService) {
  const app = new Hono<Env>();
  const service = () => injected ?? new TripService(storage());
  const ai = () =>
    injectedAi ??
    new AiService(
      service(),
      process.env.AI_MODE === 'mock' && process.env.STORAGE_DRIVER !== 'blob' && !process.env.VERCEL
        ? new MockAiProviders()
        : undefined,
    );
  const throttle = createThrottle();
  const id = (c: Context, name = 'id') => Id.parse(c.req.param(name));
  const agent = (c: Context<Env>) => {
    if (c.get('role') !== 'agent')
      throw new ApiError(403, 'Agent access required for itinerary edits');
  };
  const result = (c: Context, value: Awaited<ReturnType<TripService['read']>>) => {
    // Mutation versions belong in JSON; HTTP ETags are read validators.
    if (['GET', 'HEAD'].includes(c.req.method)) c.header('ETag', value.etag);
    return c.json({ ...value, warnings: bookingWarnings(value.trip) });
  };
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'DENY',
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], sandbox: [] },
    }),
  );
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const loginRequest = path === `${prefix}/session` && c.req.method === 'POST';
    const callback = path === `${prefix}/uploads/blob` && c.req.method === 'POST';
    const health = path === `${prefix}/health` && ['GET', 'HEAD'].includes(c.req.method);
    const admin = path.startsWith(`${prefix}/ai/admin/`);
    if (admin) {
      const authorization = c.req.header('Authorization') ?? '';
      if (
        !authorization.startsWith('Bearer ') ||
        authorization.length > 263 ||
        !sameHash(authorization.slice(7), process.env.AI_ADMIN_TOKEN_HASH)
      )
        throw new ApiError(401, 'Credenziale operatore AI richiesta.');
      c.set('role', 'ai-admin');
      throttle(c, 'ai-admin', 30);
    } else if (!loginRequest && !callback && !health) {
      const access = await role(c);
      if (!access) throw new ApiError(401, 'Accedi per continuare');
      c.set('role', access);
      if (!['GET', 'HEAD'].includes(c.req.method)) {
        if (access === 'browser') checkOrigin(c);
        throttle(c, 'write', 180);
      }
    }
    if (loginRequest) {
      checkOrigin(c);
      throttle(c, 'login', 20);
    }
    const binary =
      c.req.method === 'PUT' && /^\/api\/v1\/trips\/[^/]+\/tickets\/[^/]+\/file$/.test(path);
    const plan = path === `${prefix}/trips` || path.endsWith('/plan');
    const maximum = loginRequest
      ? 1024
      : callback
        ? 16384
        : binary
          ? 10 * 1024 * 1024
          : plan
            ? 512 * 1024
            : 64 * 1024;
    await limitBody(c, maximum, !binary);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ZodError)
      return c.json(
        {
          error: 'Validation failed',
          issues: error.issues.slice(0, 25).map((i) => ({ path: i.path, message: i.message })),
        },
        422,
      );
    if (error instanceof ApiError)
      return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    if (error instanceof AiBudgetError)
      return c.json(
        { error: error.message, code: error.code },
        error.code === 'disabled'
          ? 503
          : error.code === 'limit' || error.code === 'busy'
            ? 429
            : 409,
      );
    if (error instanceof AiPlanError)
      return c.json({ error: error.message }, error.code === 'conflict' ? 409 : 422);
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
    console.error('API failure', { name: error.name });
    return c.json({ error: 'Servizio momentaneamente non disponibile' }, 503);
  });
  app.get(`${prefix}/health`, (c) => c.json({ ok: true }));
  app.post(`${prefix}/session`, async (c) => {
    checkOrigin(c);
    const body = z
      .object({ key: z.string().min(1).max(256) })
      .strict()
      .parse(await c.req.json());
    return c.json(await login(c, body.key));
  });
  // Blob verifies signed completion callbacks. Token generation requires app authentication.
  app.post(`${prefix}/uploads/blob`, async (c) => {
    if (process.env.STORAGE_DRIVER !== 'blob')
      throw new ApiError(400, 'Blob uploads are not enabled');
    const body = await c.req.json<HandleUploadBody | HandleUploadPresignedBody>();
    if (
      !body ||
      ![
        'blob.generate-client-token',
        'blob.generate-presigned-url',
        'blob.upload-completed',
      ].includes(body.type)
    )
      throw new ApiError(400, 'Invalid upload event');
    if (body.type !== 'blob.upload-completed') {
      const access = await role(c);
      if (!access) throw new ApiError(401, 'Accedi per continuare');
      if (access === 'browser') checkOrigin(c);
      throttle(c, 'write', 180);
    }
    if (body.type === 'blob.upload-completed' && !c.req.header('x-vercel-signature'))
      throw new ApiError(403, 'Signed callback required');
    const authorizeUpload = async (pathname: string, clientPayload: string | null) => {
      const access = await role(c);
      if (!access) throw new ApiError(401, 'Authentication required');
      if (access === 'browser') checkOrigin(c);
      const { tripId, ticketId } = z
        .object({ tripId: Id, ticketId: Id })
        .parse(JSON.parse(clientPayload ?? '{}'));
      const { trip } = await service().read(tripId);
      const ticket = trip.state.tickets.find((t) => t.id === ticketId);
      if (!ticket || ticket.status !== 'pending' || ticket.pathname !== pathname)
        throw new ApiError(403, 'Unauthorized upload target');
      return {
        allowedContentTypes: [ticket.contentType],
        maximumSizeInBytes: ticket.size,
        addRandomSuffix: false,
        allowOverwrite: false,
        validUntil: Date.now() + 10 * 60 * 1000,
        tokenPayload: JSON.stringify({ tripId, ticketId }),
      };
    };
    const onUploadCompleted: HandleUploadOptions['onUploadCompleted'] = async ({
      tokenPayload,
      blob,
    }) => {
      const { tripId, ticketId } = z
        .object({ tripId: Id, ticketId: Id })
        .parse(JSON.parse(tokenPayload ?? '{}'));
      const { trip } = await service().read(tripId);
      const ticket = trip.state.tickets.find((t) => t.id === ticketId);
      if (!ticket || ticket.pathname !== blob.pathname)
        throw new ApiError(403, 'Invalid upload completion');
      await service().finalize(tripId, ticketId);
    };
    const presigned = !!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN;
    if (
      (presigned && body.type === 'blob.generate-client-token') ||
      (!presigned && body.type === 'blob.generate-presigned-url')
    )
      throw new ApiError(400, 'Refresh the app before uploading');
    const response = presigned
      ? await handleUploadPresigned({
          request: c.req.raw,
          body: body as HandleUploadPresignedBody,
          onUploadCompleted,
          getSignedToken: async (pathname, clientPayload) => {
            const options = await authorizeUpload(pathname, clientPayload);
            const token = await issueSignedToken({
              pathname,
              operations: ['put'],
              allowedContentTypes: options.allowedContentTypes,
              maximumSizeInBytes: options.maximumSizeInBytes,
              validUntil: options.validUntil,
            });
            return { token, urlOptions: options };
          },
        })
      : await handleUpload({
          request: c.req.raw,
          body: body as HandleUploadBody,
          onBeforeGenerateToken: authorizeUpload,
          onUploadCompleted,
        });
    return c.json(response);
  });
  app.get(`${prefix}/session`, async (c) => {
    if (c.get('role') === 'agent') return c.json({ role: 'agent' });
    return c.json({ role: 'browser' });
  });
  app.delete(`${prefix}/session`, (c) => {
    logout(c);
    return c.json({ ok: true });
  });
  app.get(`${prefix}/openapi.json`, (c) => c.json(openapi()));
  app.get(`${prefix}/config`, async (c) =>
    c.json({
      storage: process.env.STORAGE_DRIVER === 'blob' ? 'blob' : 'file',
      presignedUploads: !!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN,
      editing: process.env.TRAVEL_EDITING_ENABLED !== 'false',
      staging: process.env.APP_ENVIRONMENT === 'staging',
      ai: await ai().availability(),
    }),
  );
  app.get(`${prefix}/ai/admin/status`, async (c) => {
    const budget = ai().budget;
    const { ledger } = await budget.read();
    return c.json({
      ...(await budget.status()),
      runs: ledger.runs
        .slice(-20)
        .map((r) => ({
          id: r.id,
          status: r.status,
          cancelRequested: r.cancelRequested,
          operations: r.operations.map((o) => ({
            id: o.id,
            state: o.state,
            maxCost: o.maxCost,
            actualCost: o.actualCost,
          })),
        })),
    });
  });
  app.post(`${prefix}/ai/admin/configure`, async (c) => {
    const body = z
      .object({ enabled: z.boolean(), limits: AiLimitsSchema.optional() })
      .strict()
      .parse(await c.req.json());
    if (body.enabled && (await ai().availability()).mode === 'off')
      throw new ApiError(
        503,
        'Configura i fornitori e i controlli di spesa prima di abilitare l’AI.',
      );
    return c.json(await ai().budget.configure(body.enabled, body.limits));
  });
  app.post(`${prefix}/ai/admin/reconcile`, async (c) => {
    const body = z
      .object({
        runId: Id,
        operationId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
        actualCost: Microdollars,
        evidence: z.string().min(12).max(1000),
      })
      .strict()
      .parse(await c.req.json());
    await ai().budget.reconcile(body.runId, body.operationId, body.actualCost, body.evidence);
    return c.json({ ok: true });
  });
  app.use(`${prefix}/trips/:id/*`, async (c, next) => {
    const isV2 = c.req.header('x-passo-api-version') === '2';
    if (!isV2 && !c.req.path.endsWith('/file')) {
      const value = await service().read(id(c));
      if (value.trip.schemaVersion === '2')
        throw new ApiError(426, 'Aggiorna l’app per usare il programma adattato.');
      if (c.req.path.includes('/travel')) throw new ApiError(404, 'Use API v2');
    }
    await next();
  });
  // The exact trip route is not covered by /:id/*.
  app.use(`${prefix}/trips/:id`, async (c, next) => {
    if (
      c.req.header('x-passo-api-version') !== '2' &&
      (await service().read(id(c))).trip.schemaVersion === '2'
    )
      throw new ApiError(426, 'Aggiorna l’app per usare il programma adattato.');
    await next();
  });
  app.get(`${prefix}/trips/:id/travel/original`, async (c) => {
    const { trip } = await service().read(id(c));
    return c.json({ plan: trip.travel?.originalPlan ?? trip.plan });
  });
  app.use(`${prefix}/trips/:id/ai/*`, async (c, next) => {
    if (c.req.header('x-passo-api-version') !== '2') throw new ApiError(404, 'Use API v2');
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (process.env.TRAVEL_EDITING_ENABLED === 'false')
        throw new ApiError(403, 'Le modifiche al programma sono momentaneamente disattivate.');
      throttle(c, 'ai', 30);
    }
    await next();
  });
  app.post(`${prefix}/trips/:id/ai/requests`, async (c) =>
    c.json(
      await ai().create(
        id(c),
        AiRequestSchema.parse(await c.req.json()),
        c.req.header('X-Trip-Version'),
      ),
    ),
  );
  app.get(`${prefix}/trips/:id/ai/requests/:jobId`, async (c) =>
    c.json(await ai().get(id(c), id(c, 'jobId'))),
  );
  app.post(`${prefix}/trips/:id/ai/requests/:jobId/advance`, async (c) =>
    c.json(await ai().advance(id(c), id(c, 'jobId'))),
  );
  app.post(`${prefix}/trips/:id/ai/requests/:jobId/cancel`, async (c) =>
    c.json(await ai().cancel(id(c), id(c, 'jobId'))),
  );
  app.post(`${prefix}/trips/:id/ai/proposals/:proposalId/apply`, async (c) => {
    const body = z
      .object({ previewHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(await c.req.json());
    return result(
      c,
      await ai().apply(
        id(c),
        id(c, 'proposalId'),
        body.previewHash,
        c.req.header('X-Trip-Version'),
      ),
    );
  });
  app.get(`${prefix}/trips/:id/travel/history`, async (c) => {
    const { trip } = await service().read(id(c));
    return c.json(trip.travel?.history.map(({ id, title, at }) => ({ id, title, at })) ?? []);
  });
  app.post(`${prefix}/trips/:id/travel/:operation`, async (c) => {
    if (c.req.header('x-passo-api-version') !== '2') throw new ApiError(404, 'Use API v2');
    if (process.env.TRAVEL_EDITING_ENABLED === 'false')
      throw new ApiError(403, 'Le modifiche al programma sono momentaneamente disattivate.');
    const operation = z.enum(['preview', 'apply']).parse(c.req.param('operation'));
    return result(
      c,
      await service().travel(
        id(c),
        TravelCommandSchema.parse(await c.req.json()),
        c.req.header('X-Trip-Version'),
        operation === 'preview',
      ),
    );
  });
  app.get(`${prefix}/trips`, async (c) => c.json(await service().list()));
  app.post(`${prefix}/trips`, async (c) => {
    agent(c);
    const body = z
      .object({ id: Id, plan: PlanSchema })
      .strict()
      .parse(await c.req.json());
    return result(c, await service().create(body.id, body.plan));
  });
  app.get(`${prefix}/trips/:id`, async (c) => {
    const value = await service().read(id(c));
    if (c.req.header('If-None-Match') === value.etag) return c.body(null, 304);
    return result(c, value);
  });
  app.delete(`${prefix}/trips/:id`, async (c) => {
    agent(c);
    await service().delete(id(c), c.req.header('X-Trip-Version'));
    return c.json({ ok: true });
  });
  app.get(`${prefix}/trips/:id/plan`, async (c) => {
    const value = await service().read(id(c));
    c.header('ETag', value.etag);
    return c.json({ plan: value.trip.plan, etag: value.etag });
  });
  app.post(`${prefix}/trips/:id/rates`, async (c) => {
    throttle(c, 'rates', 30);
    const value = await service().read(id(c));
    const currencies = [
      ...new Set([
        ...value.trip.plan.costs.map((cost) => cost.currency),
        ...value.trip.state.reservations.flatMap((r) => (r.currency ? [r.currency] : [])),
      ]),
    ].filter((currency) => currency !== 'EUR');
    if (currencies.length > 8)
      throw new ApiError(422, 'Aggiorna al massimo otto valute per viaggio.');
    const rates = await Promise.all(
      currencies.map((currency) => exchangeRate(currency, service().store)),
    );
    if (JSON.stringify(value.trip.state.exchangeRates) === JSON.stringify(rates))
      return result(c, value);
    return result(
      c,
      await service().mutate(id(c), value.etag, (draft) => {
        draft.state.exchangeRates = rates;
      }),
    );
  });
  app.put(`${prefix}/trips/:id/plan`, async (c) => {
    agent(c);
    const plan = PlanSchema.parse(await c.req.json());
    if (c.req.query('dryRun') === 'true') {
      const value = await service().read(id(c));
      if (c.req.header('X-Trip-Version') !== value.etag)
        throw new ApiError(412, 'The document changed');
      const preview = TripSchema.parse({ ...value.trip, plan });
      return c.json({
        valid: true,
        warnings: bookingWarnings(preview),
        revision: value.trip.revision,
      });
    }
    return result(
      c,
      await service().mutate(
        id(c),
        c.req.header('X-Trip-Version'),
        (draft) => {
          draft.plan = plan;
        },
        true,
      ),
    );
  });
  app.patch(`${prefix}/trips/:id/plan`, async (c) => {
    agent(c);
    const operations = z
      .array(
        z.object({
          op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
          path: z.string(),
          from: z.string().optional(),
          value: z.unknown().optional(),
        }),
      )
      .max(200)
      .parse(await c.req.json());
    return result(
      c,
      await service().mutate(
        id(c),
        c.req.header('X-Trip-Version'),
        (draft) => {
          try {
            draft.plan = PlanSchema.parse(
              jsonPatch.applyPatch(draft.plan, operations as Operation[], true, false, true)
                .newDocument,
            );
          } catch (e) {
            if (e instanceof ZodError) throw e;
            throw new ApiError(422, 'Invalid JSON Patch');
          }
        },
        true,
      ),
    );
  });
  app.get(`${prefix}/trips/:id/history`, async (c) => {
    agent(c);
    const paths = await service().store.list(`history/${id(c)}/`);
    return c.json(paths.map((p) => Number(p.split('/').at(-1)!.replace('.json', ''))).reverse());
  });
  app.post(`${prefix}/trips/:id/restore/:revision`, async (c) => {
    agent(c);
    const revision = z.coerce.number().int().min(1).parse(c.req.param('revision'));
    const item = await service().store.read(
      `history/${id(c)}/${String(revision).padStart(10, '0')}.json`,
    );
    if (!item) throw new ApiError(404, 'Snapshot not found');
    const previous = TripSchema.parse(JSON.parse(new TextDecoder().decode(item.body)));
    return result(
      c,
      await service().mutate(
        id(c),
        c.req.header('X-Trip-Version'),
        (draft) => {
          draft.plan = previous.plan;
        },
        true,
      ),
    );
  });
  app.patch(`${prefix}/trips/:id/progress/:stepId`, async (c) => {
    const stepId = id(c, 'stepId');
    const body = z
      .object({
        status: ProgressStatus,
        expected: ProgressStatus.optional(),
        at: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(await c.req.json());
    return result(
      c,
      await service().mutate(id(c), c.req.header('X-Trip-Version'), (draft) => {
        if (!draft.plan.steps.some((s) => s.id === stepId))
          throw new ApiError(404, 'Step not found');
        if (body.expected && (draft.state.progress[stepId] ?? 'pending') !== body.expected)
          throw new ApiError(409, 'Progress changed on another device');
        draft.state.progress[stepId] = body.status;
        if (draft.travel) {
          if (body.status === 'done')
            draft.travel.completedAt[stepId] = body.at ?? new Date().toISOString();
          else delete draft.travel.completedAt[stepId];
        }
      }),
    );
  });
  app.patch(`${prefix}/trips/:id/tasks/:taskId`, async (c) => {
    const taskId = id(c, 'taskId');
    const body = z
      .object({ done: z.boolean(), expected: z.boolean().optional() })
      .strict()
      .parse(await c.req.json());
    return result(
      c,
      await service().mutate(id(c), c.req.header('X-Trip-Version'), (draft) => {
        if (!draft.plan.tasks.some((t) => t.id === taskId))
          throw new ApiError(404, 'Task not found');
        if (
          body.expected !== undefined &&
          (draft.state.taskCompletion[taskId] ?? false) !== body.expected
        )
          throw new ApiError(409, 'Task changed on another device');
        draft.state.taskCompletion[taskId] = body.done;
      }),
    );
  });
  app.post(`${prefix}/trips/:id/reservations`, async (c) => {
    const reservation = ReservationSchema.parse(await c.req.json());
    return result(
      c,
      await service().mutate(id(c), c.req.header('X-Trip-Version'), (draft) => {
        if (draft.state.reservations.some((r) => r.id === reservation.id))
          throw new ApiError(409, 'Reservation already exists');
        draft.state.reservations.push(reservation);
      }),
    );
  });
  app.patch(`${prefix}/trips/:id/reservations/:reservationId`, async (c) => {
    const body = ReservationSchema.partial()
      .omit({ id: true })
      .extend({
        slot: ReservationSchema.shape.slot.nullable(),
        paidAmount: ReservationSchema.shape.paidAmount.nullable(),
        currency: ReservationSchema.shape.currency.nullable(),
        costId: ReservationSchema.shape.costId.nullable(),
      })
      .parse(await c.req.json());
    const reservationId = id(c, 'reservationId');
    return result(
      c,
      await service().mutate(id(c), c.req.header('X-Trip-Version'), (draft) => {
        const r = draft.state.reservations.find((r) => r.id === reservationId);
        if (!r) throw new ApiError(404, 'Reservation not found');
        Object.assign(r, body);
        for (const key of ['slot', 'paidAmount', 'currency', 'costId'] as const)
          if (body[key] === null) delete r[key];
      }),
    );
  });
  app.delete(`${prefix}/trips/:id/reservations/:reservationId`, async (c) => {
    const reservationId = id(c, 'reservationId');
    return result(
      c,
      await service().mutate(id(c), c.req.header('X-Trip-Version'), (draft) => {
        draft.state.reservations = draft.state.reservations.filter((r) => r.id !== reservationId);
      }),
    );
  });
  app.post(`${prefix}/trips/:id/tickets`, async (c) => {
    const body = TicketSchema.omit({ id: true, pathname: true, uploadedAt: true, status: true })
      .strict()
      .parse(await c.req.json());
    const tripId = id(c);
    const ticketId = service().newId('ticket');
    const ext =
      body.contentType === 'application/pdf'
        ? 'pdf'
        : body.contentType === 'image/png'
          ? 'png'
          : 'jpg';
    return result(
      c,
      await service().mutate(tripId, c.req.header('X-Trip-Version'), (draft) => {
        draft.state.tickets.push({
          ...body,
          id: ticketId,
          pathname: `tickets/${tripId}/${ticketId}/original.${ext}`,
          status: 'pending',
          uploadedAt: new Date().toISOString(),
        });
      }),
    );
  });
  app.put(`${prefix}/trips/:id/tickets/:ticketId/file`, async (c) => {
    if (process.env.STORAGE_DRIVER === 'blob')
      throw new ApiError(400, 'Use direct client upload for Blob');
    const tripId = id(c);
    const { trip } = await service().read(tripId);
    const ticket = trip.state.tickets.find((t) => t.id === id(c, 'ticketId'));
    if (!ticket || ticket.status !== 'pending') throw new ApiError(404, 'Pending ticket not found');
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength !== ticket.size) throw new ApiError(400, 'Size mismatch');
    await service().store.write(ticket.pathname, body, 'create', ticket.contentType);
    return result(c, await service().finalize(tripId, ticket.id));
  });
  app.post(`${prefix}/trips/:id/tickets/:ticketId/finalize`, async (c) =>
    result(c, await service().finalize(id(c), id(c, 'ticketId'))),
  );
  app.get(`${prefix}/trips/:id/tickets/:ticketId/file`, async (c) => {
    const { trip } = await service().read(id(c));
    const ticket = trip.state.tickets.find((t) => t.id === id(c, 'ticketId'));
    if (!ticket || ticket.status !== 'ready') throw new ApiError(404, 'Ticket not ready');
    const stream = await service().store.stream(ticket.pathname);
    if (!stream) throw new ApiError(404, 'Ticket file missing');
    c.header('Content-Type', ticket.contentType);
    c.header(
      'Content-Disposition',
      `${c.req.query('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(ticket.filename)}`,
    );
    c.header('Content-Length', String(ticket.size));
    return c.body(stream);
  });
  app.patch(`${prefix}/trips/:id/tickets/:ticketId`, async (c) => {
    const body = TicketSchema.pick({
      title: true,
      stepId: true,
      travellerIds: true,
      reservationId: true,
    })
      .partial()
      .extend({ reservationId: Id.nullable().optional() })
      .strict()
      .parse(await c.req.json());
    const ticketId = id(c, 'ticketId');
    return result(
      c,
      await service().mutate(id(c), c.req.header('X-Trip-Version'), (draft) => {
        const t = draft.state.tickets.find((t) => t.id === ticketId);
        if (!t) throw new ApiError(404, 'Ticket not found');
        Object.assign(t, body);
        if (body.reservationId === null) delete t.reservationId;
      }),
    );
  });
  app.delete(`${prefix}/trips/:id/tickets/:ticketId`, async (c) => {
    let path = '';
    const ticketId = id(c, 'ticketId');
    const value = await service().mutate(id(c), c.req.header('X-Trip-Version'), (draft) => {
      const t = draft.state.tickets.find((t) => t.id === ticketId);
      if (!t) throw new ApiError(404, 'Ticket not found');
      path = t.pathname;
      draft.state.tickets = draft.state.tickets.filter((t) => t.id !== ticketId);
    });
    await service().store.remove(path);
    return result(c, value);
  });
  app.notFound((c) => c.json({ error: 'Endpoint not found' }, 404));
  // Route both versions through the same authenticated handlers. Strip the internal
  // version marker on incoming requests so legacy clients cannot forge it.
  const root = new Hono();
  root.all('*', async (c) => {
    const url = new URL(c.req.url),
      headers = new Headers(c.req.raw.headers);
    headers.delete('x-passo-api-version');
    if (url.pathname.startsWith('/api/v2/')) {
      url.pathname = url.pathname.replace('/api/v2/', '/api/v1/');
      headers.set('x-passo-api-version', '2');
    }
    return app.fetch(new Request(url, new Request(c.req.raw, { headers })));
  });
  return root;
}

export function openapi() {
  const security = [{ AgentToken: [] }, { BrowserSession: [] }];
  const responses = {
    '200': { description: 'Success' },
    '409': { description: 'Relevant day or note changed; review the conflict' },
    '426': { description: 'Legacy client must upgrade before reading a V2 trip' },
    '401': { description: 'Authentication required' },
    '412': { description: 'Stale ETag; re-read and merge' },
    '422': { description: 'Validation failed' },
    '428': { description: 'X-Trip-Version required' },
  };
  const paths: Record<string, unknown> = {};
  const routes: [string, string[], string][] = [
    [
      '/session',
      ['get', 'post', 'delete'],
      'Browser session; POST accepts {key} and requires Origin',
    ],
    ['/trips', ['get', 'post'], 'List/create trips. Create accepts {id, plan}; agent only'],
    ['/trips/{id}', ['get', 'delete'], 'Read trip document / delete trip (agent only)'],
    [
      '/trips/{id}/plan',
      ['get', 'put', 'patch'],
      'Agent plan editing; PUT Plan, PATCH RFC6902. X-Trip-Version required. PUT ?dryRun=true validates',
    ],
    ['/trips/{id}/travel/preview', ['post'], 'Validate a travel command without writing'],
    ['/trips/{id}/travel/apply', ['post'], 'Commit an idempotent travel command; browser or agent'],
    ['/trips/{id}/travel/original', ['get'], 'Read immutable authored plan'],
    ['/trips/{id}/travel/history', ['get'], 'Last 20 travel changes'],
    ['/trips/{id}/history', ['get'], 'Agent reads available plan snapshots'],
    [
      '/trips/{id}/rates',
      ['post'],
      'Refresh approximate EUR conversions from ECB through Frankfurter; cached 24 hours',
    ],
    ['/trips/{id}/restore/{revision}', ['post'], 'Agent restores plan; X-Trip-Version required'],
    [
      '/trips/{id}/progress/{stepId}',
      ['patch'],
      'Body {status, expected?}; status pending/done/skipped',
    ],
    ['/trips/{id}/tasks/{taskId}', ['patch'], 'Body {done, expected?}'],
    ['/trips/{id}/reservations', ['post'], 'Create Reservation'],
    ['/trips/{id}/reservations/{reservationId}', ['patch', 'delete'], 'Update/delete Reservation'],
    [
      '/trips/{id}/tickets',
      ['post'],
      'Create pending Ticket (omit id, pathname, uploadedAt, status)',
    ],
    [
      '/trips/{id}/tickets/{ticketId}',
      ['patch', 'delete'],
      'Update assignments/title or delete ticket',
    ],
    [
      '/trips/{id}/tickets/{ticketId}/file',
      ['get', 'put'],
      'Read private file; PUT raw bytes for local storage only',
    ],
    [
      '/trips/{id}/tickets/{ticketId}/finalize',
      ['post'],
      'Idempotent finalization after direct upload',
    ],
    ['/uploads/blob', ['post'], 'Vercel Blob SDK token generation / signed completion callback'],
  ];
  for (const [path, methods, summary] of routes)
    paths[path] = Object.fromEntries(
      methods.map((method) => [
        method,
        {
          summary,
          security,
          parameters: [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
            name: m[1],
            in: 'path',
            required: true,
            schema: { type: 'string' },
          })),
          responses,
        },
      ]),
    );
  const bodySchemas: Record<string, unknown> = {
    'post /trips/{id}/travel/preview': { $ref: '#/components/schemas/TravelCommand' },
    'post /trips/{id}/travel/apply': { $ref: '#/components/schemas/TravelCommand' },
    'post /session': z.toJSONSchema(z.object({ key: z.string() })),
    'post /trips': z.toJSONSchema(z.object({ id: Id, plan: PlanSchema })),
    'put /trips/{id}/plan': { $ref: '#/components/schemas/Plan' },
    'patch /trips/{id}/plan': {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['op', 'path'],
        properties: {
          op: { enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'] },
          path: { type: 'string' },
          from: { type: 'string' },
          value: {},
        },
      },
    },
    'patch /trips/{id}/progress/{stepId}': z.toJSONSchema(
      z.object({
        status: ProgressStatus,
        expected: ProgressStatus.optional(),
        at: z.iso.datetime({ offset: true }).optional(),
      }),
    ),
    'patch /trips/{id}/tasks/{taskId}': z.toJSONSchema(
      z.object({ done: z.boolean(), expected: z.boolean().optional() }),
    ),
    'post /trips/{id}/reservations': { $ref: '#/components/schemas/Reservation' },
    'post /trips/{id}/tickets': z.toJSONSchema(
      TicketSchema.omit({ id: true, pathname: true, uploadedAt: true, status: true }),
    ),
  };
  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(
      operations as Record<
        string,
        { parameters: unknown[]; requestBody?: unknown; security: unknown[] }
      >,
    )) {
      const schema = bodySchemas[`${method} ${path}`];
      if (schema)
        operation.requestBody = { required: true, content: { 'application/json': { schema } } };
      if (
        method !== 'get' &&
        path.includes('{id}') &&
        !path.endsWith('/travel/preview') &&
        !path.endsWith('/rates') &&
        !path.endsWith('/finalize') &&
        !path.endsWith('/file')
      )
        operation.parameters.push({
          name: 'X-Trip-Version',
          in: 'header',
          required: true,
          schema: { type: 'string' },
        });
      if (path === '/session' && method === 'post') operation.security = [];
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Passo itinerary API', version: '2.0.0' },
    servers: [{ url: '/api/v2' }],
    paths,
    components: {
      securitySchemes: {
        AgentToken: { type: 'http', scheme: 'bearer' },
        BrowserSession: { type: 'apiKey', in: 'cookie', name: 'passo_session' },
      },
      schemas: {
        TravelCommand: z.toJSONSchema(TravelCommandSchema),
        Trip: z.toJSONSchema(TripSchema),
        Plan: z.toJSONSchema(PlanSchema),
        Ticket: z.toJSONSchema(TicketSchema),
        Reservation: z.toJSONSchema(ReservationSchema),
      },
    },
  };
}
