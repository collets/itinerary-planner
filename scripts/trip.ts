import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from 'dotenv';
import { parse } from 'yaml';
import patch from 'fast-json-patch';
import { upload } from '@vercel/blob/client';
import {
  TripSchema,
  PlanSchema,
  StepSchema,
  ReservationSchema,
  emptyState,
  type Trip,
  type Plan,
} from '../src/domain/schema';
import { bookingWarnings } from '../src/domain/trip';
import {
  applyTravel,
  preconditions,
  TravelCommandSchema,
  TravelActionSchema,
} from '../src/domain/travel';
import { openapi } from '../src/server/app';
import { apiClient } from './api-client.js';

config({ path: process.env.ITINERARY_ENV_FILE ?? '.env.local', quiet: true });
const argv = process.argv.slice(2);
const args = argv.filter((v) => !v.startsWith('--'));
const flag = (name: string) =>
  argv
    .find((v) => v.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const command = args[0],
  tripId = args[1];
const base =
  (process.env.ITINERARY_API_URL ?? 'http://localhost:5173').replace(/\/$/, '') + '/api/v2';
const token = process.env.ITINERARY_API_TOKEN;
const client = apiClient(process.env.ITINERARY_API_URL ?? 'http://localhost:5173', token);
const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
async function request(path: string, method = 'GET', body?: unknown, etag?: string) {
  if (!token) throw new Error('Set ITINERARY_API_TOKEN in an ignored environment file');
  const response = await client.fetch('/api/v2' + path, {
    method,
    headers: { ...headers(), ...(etag ? { 'X-Trip-Version': etag } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, ...data }));
  return data;
}
async function file(path: string) {
  if (!path) throw new Error('A JSON/YAML file is required');
  return parse(await readFile(path, 'utf8'));
}
function validate(plan: Plan, state = emptyState()) {
  return TripSchema.parse({
    schemaVersion: '1',
    id: command === 'validate' ? 'validation-trip' : (tripId ?? 'validation-trip'),
    revision: 1,
    updatedAt: new Date().toISOString(),
    plan,
    state,
  });
}
const current = () => request(`/trips/${tripId}`) as Promise<{ trip: Trip; etag: string }>;
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function edit(change: (plan: Plan) => void) {
  const value = await current();
  const plan = structuredClone(value.trip.plan);
  change(plan);
  TripSchema.parse({ ...value.trip, plan });
  const diff = patch.compare(value.trip.plan, plan);
  if (argv.includes('--dry-run'))
    return output({ diff, warnings: bookingWarnings({ ...value.trip, plan }) });
  output(await request(`/trips/${tripId}/plan`, 'PUT', plan, value.etag));
}

try {
  switch (command) {
    case 'travel': {
      const value = await current();
      const raw = await file(args[2]);
      const action = TravelActionSchema.parse(raw.action ?? raw);
      const command = TravelCommandSchema.parse({
        id: raw.id ?? crypto.randomUUID(),
        action,
        routes: raw.routes ?? [],
        at: raw.at ?? new Date().toISOString(),
        expected: raw.expected ?? preconditions(value.trip, action),
      });
      applyTravel(value.trip, command);
      output(
        await request(
          `/trips/${tripId}/travel/${argv.includes('--dry-run') ? 'preview' : 'apply'}`,
          'POST',
          command,
          value.etag,
        ),
      );
      break;
    }
    case 'travel-history':
      output(await request(`/trips/${tripId}/travel/history`));
      break;
    case 'original':
      output(await request(`/trips/${tripId}/travel/original`));
      break;
    case 'list':
      output(await request('/trips'));
      break;
    case 'schema': {
      const schema = openapi();
      if (tripId) await writeFile(tripId, JSON.stringify(schema, null, 2));
      else output(schema);
      break;
    }
    case 'validate': {
      const input = await file(tripId);
      const valid = input.plan ? TripSchema.parse(input) : validate(PlanSchema.parse(input));
      output({ valid: true, steps: valid.plan.steps.length, warnings: bookingWarnings(valid) });
      break;
    }
    case 'create': {
      const input = await file(args[2]);
      const plan = PlanSchema.parse(input.plan ?? input);
      validate(plan);
      output(await request('/trips', 'POST', { id: tripId, plan }));
      break;
    }
    case 'pull':
    case 'export': {
      const value = await current();
      const path = args[2] ?? `local-data/${tripId}.json`;
      await writeFile(
        path,
        JSON.stringify(argv.includes('--include-state') ? value.trip : value.trip.plan, null, 2),
        { mode: 0o600 },
      );
      await writeFile(path + '.meta.json', JSON.stringify({ id: tripId, etag: value.etag }), {
        mode: 0o600,
      });
      output({ file: path, etag: value.etag });
      break;
    }
    case 'diff': {
      const value = await current();
      const input = await file(args[2]);
      const plan = PlanSchema.parse(input.plan ?? input);
      TripSchema.parse({ ...value.trip, plan });
      output({
        diff: patch.compare(value.trip.plan, plan),
        warnings: bookingWarnings({ ...value.trip, plan }),
      });
      break;
    }
    case 'push': {
      const input = await file(args[2]);
      const plan = PlanSchema.parse(input.plan ?? input);
      const etag = flag('etag') ?? (await file(args[2] + '.meta.json')).etag;
      const value = await request(
        `/trips/${tripId}/plan${argv.includes('--dry-run') ? '?dryRun=true' : ''}`,
        'PUT',
        plan,
        etag,
      );
      if (value.etag)
        await writeFile(args[2] + '.meta.json', JSON.stringify({ id: tripId, etag: value.etag }), {
          mode: 0o600,
        });
      output(value);
      break;
    }
    case 'add-step': {
      const step = StepSchema.parse(await file(args[2]));
      await edit((plan) => {
        const day = plan.days.find((d) => d.id === flag('day'));
        if (!day) throw new Error('Use --day=<day-id>');
        const after = flag('after');
        const index = after ? day.stepIds.indexOf(after) + 1 : day.stepIds.length;
        if (after && index === 0) throw new Error('Unknown --after step');
        plan.steps.push(step);
        day.stepIds.splice(index, 0, step.id);
      });
      break;
    }
    case 'update-step': {
      const step = StepSchema.parse(await file(args[3]));
      if (step.id !== args[2]) throw new Error('Step ID must remain stable');
      await edit((plan) => {
        const index = plan.steps.findIndex((s) => s.id === step.id);
        if (index < 0) throw new Error('Unknown step');
        plan.steps[index] = step;
      });
      break;
    }
    case 'delete-step':
      await edit((plan) => {
        plan.steps = plan.steps.filter((s) => s.id !== args[2]);
        plan.days.forEach((d) => {
          d.stepIds = d.stepIds.filter((id) => id !== args[2]);
        });
        plan.costs.forEach((c) => {
          c.stepIds = c.stepIds.filter((id) => id !== args[2]);
        });
        plan.tasks = plan.tasks.filter((t) => t.stepId !== args[2]);
        plan.alternatives = plan.alternatives.filter((a) => !a.affectedStepIds.includes(args[2]));
      });
      break;
    case 'reorder':
      await edit((plan) => {
        const day = plan.days.find((d) => d.id === args[2]);
        if (!day) throw new Error('Unknown day');
        day.stepIds = (flag('ids') ?? '').split(',');
      });
      break;
    case 'apply-alternative':
      await edit((plan) => {
        const alt = plan.alternatives.find((a) => a.id === args[2]);
        if (!alt || !alt.replacementSteps.length)
          throw new Error('Alternative requires a researched plan edit; see its description');
        plan.steps = plan.steps.map((s) => alt.replacementSteps.find((r) => r.id === s.id) ?? s);
        alt.costChanges.forEach((change) => {
          plan.costs.find((c) => c.id === change.id)!.inclusion = change.inclusion;
        });
      });
      break;
    case 'history':
      output(await request(`/trips/${tripId}/history`));
      break;
    case 'restore': {
      const value = await current();
      output(await request(`/trips/${tripId}/restore/${args[2]}`, 'POST', {}, value.etag));
      break;
    }
    case 'delete': {
      if (flag('confirm') !== tripId)
        throw new Error('Use --confirm=<trip-id> to delete all trip data');
      const value = await current();
      output(await request(`/trips/${tripId}`, 'DELETE', undefined, value.etag));
      break;
    }
    case 'reservation': {
      const value = await current();
      const reservation = ReservationSchema.parse(await file(args[2]));
      const exists = value.trip.state.reservations.some((r) => r.id === reservation.id);
      output(
        await request(
          `/trips/${tripId}/reservations${exists ? '/' + reservation.id : ''}`,
          exists ? 'PATCH' : 'POST',
          exists
            ? Object.fromEntries(Object.entries(reservation).filter(([k]) => k !== 'id'))
            : reservation,
          value.etag,
        ),
      );
      break;
    }
    case 'upload-ticket': {
      const path = args[4];
      const bytes = await readFile(path);
      const contentType = path.toLowerCase().endsWith('.pdf')
        ? 'application/pdf'
        : path.toLowerCase().endsWith('.png')
          ? 'image/png'
          : 'image/jpeg';
      const value = await current();
      const created = await request(
        `/trips/${tripId}/tickets`,
        'POST',
        {
          stepId: args[2],
          travellerIds: args[3].split(','),
          title: flag('title') ?? basename(path),
          filename: basename(path),
          contentType,
          size: bytes.byteLength,
        },
        value.etag,
      );
      const ticket = created.trip.state.tickets.at(-1);
      const configuration = await request('/config');
      if (configuration.storage === 'blob') {
        await upload(ticket.pathname, new Blob([bytes], { type: contentType }), {
          access: 'private',
          contentType,
          handleUploadUrl: base + '/uploads/blob',
          clientPayload: JSON.stringify({ tripId, ticketId: ticket.id }),
          headers: Object.fromEntries(client.headers()),
        });
        output(await request(`/trips/${tripId}/tickets/${ticket.id}/finalize`, 'POST', {}));
      } else {
        const response = await client.fetch(`/api/v2/trips/${tripId}/tickets/${ticket.id}/file`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
          body: bytes,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(data));
        output(data);
      }
      break;
    }
    default:
      console.log(
        'Commands: list, create <id> <file>, pull/export <id> <file>, validate <file>, diff <id> <file>, push <id> <file> [--dry-run], add-step <id> <file> --day=ID [--after=ID], update-step <id> <step> <file>, delete-step <id> <step>, reorder <id> <day> --ids=a,b, apply-alternative <id> <alternative>, reservation <id> <file>, upload-ticket <id> <step> <traveller-ids> <file>, history <id>, restore <id> <revision>, delete <id> --confirm=ID, schema [file].',
      );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
