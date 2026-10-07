// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { exampleTrip } from '../src/domain/fixture';
import { emptyConstraints } from '../src/domain/ai-task';
import { AiAssistant } from '../src/components/AiAssistant';
import { AiInsights } from '../src/components/AiInsights';
import { dayInsights } from '../src/domain/ai-insights';
import { information } from './fixtures/place-information';
import type { AiJobView } from '../src/server/ai';

const doubles = vi.hoisted(() => ({
  request: vi.fn(),
  fetchTrip: vi.fn(),
  sync: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  journal: vi.fn(),
  useTrip: vi.fn(),
}));
vi.mock('../src/client/context', () => ({ useTrip: doubles.useTrip }));
vi.mock('../src/client/api', () => ({
  request: doubles.request,
  fetchTrip: doubles.fetchTrip,
  syncPending: doubles.sync,
}));
vi.mock('../src/client/db', () => ({
  db: { meta: { get: doubles.get } },
  saveAiAdvice: doubles.save,
  journal: doubles.journal,
}));
vi.mock('../src/components/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));

const trip = exampleTrip();
let online: boolean, job: AiJobView;
beforeEach(() => {
  vi.clearAllMocks();
  online = true;
  job = {
    id: 'question-job',
    tripId: trip.id,
    dayId: 'day-one',
    status: 'clarification',
    message: 'Quale museo?',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    mock: true,
    proposals: [],
    task: {
      goals: ['research'],
      targetStepIds: [],
      constraints: emptyConstraints(),
      pendingQuestion: {
        question: 'Quale museo?',
        choices: [
          {
            id: 'museum-choice',
            label: 'Museo del borgo',
            stepId: 'museum',
            placeId: 'blue-museum',
          },
        ],
      },
    },
  };
  doubles.useTrip.mockImplementation(() => ({
    trip,
    etag: 'version',
    online,
    aiMode: 'mock',
    refresh: vi.fn(),
    notify: vi.fn(),
  }));
  doubles.get.mockImplementation(async () => ({
    value: {
      text: '',
      preference: 'fastest',
      savedAt: Date.now(),
      baseEtag: 'version',
      request: { id: job.id, dayId: 'day-one', text: 'Orari e prezzi?' },
      job,
    },
  }));
  doubles.fetchTrip.mockResolvedValue({ trip, etag: 'version' });
  doubles.sync.mockResolvedValue(undefined);
  doubles.journal.mockResolvedValue([]);
  doubles.save.mockResolvedValue(undefined);
  doubles.request.mockImplementation(async (_path: string, method = 'GET') =>
    method === 'GET'
      ? job
      : { ...job, id: 'new-job', status: 'answered', task: null, message: 'Risposta di prova.' },
  );
});
afterEach(cleanup);

describe('Assistant conversation widgets and private local advice', () => {
  it('does not start a paid request on open, and sends a validated choice only on explicit interaction', async () => {
    render(
      <AiAssistant
        target={{ dayId: 'day-one', generic: true }}
        onTarget={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const choice = await screen.findByRole('button', { name: 'Museo del borgo' });
    expect(doubles.request.mock.calls.filter((args) => args[1] === 'POST')).toHaveLength(0);
    fireEvent.click(choice);
    await waitFor(() =>
      expect(doubles.request.mock.calls.filter((args) => args[1] === 'POST')).toHaveLength(1),
    );
    const mutation = doubles.request.mock.calls.find((args) => args[1] === 'POST')!;
    expect(mutation[2]).toMatchObject({
      parentJobId: 'question-job',
      choiceId: 'museum-choice',
      text: 'Museo del borgo',
    });
    expect(mutation[0]).toBe('/trips/example-trip/ai/requests');
    expect(doubles.request.mock.calls.some((args) => args[0].includes('/apply'))).toBe(false);
  });
  it('keeps cached questions and choices readable offline without dispatching', async () => {
    online = false;
    render(<AiAssistant target={{ dayId: 'day-one' }} onTarget={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Museo del borgo' })).toBeDisabled();
    expect(screen.getByText('Quale museo?')).toBeInTheDocument();
    expect(doubles.request.mock.calls.filter((args) => args[1] === 'POST')).toHaveLength(0);
  });
  it('reuses the day conversation when changing the selected stop', async () => {
    const first = render(
      <AiAssistant
        target={{ dayId: 'day-one', stepId: 'square' }}
        onTarget={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('Quale museo?');
    first.unmount();
    render(
      <AiAssistant
        target={{ dayId: 'day-one', stepId: 'museum' }}
        onTarget={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('Quale museo?');
    expect(doubles.get.mock.calls.map((args) => args[0])).toEqual([
      'ai:example-trip:day-one:assistant-v2',
      'ai:example-trip:day-one:assistant-v2',
    ]);
    expect(doubles.request.mock.calls.filter((args) => args[1] === 'POST')).toHaveLength(0);
  });
  it('shows sourced facts even when the requested adaptation cannot be proposed', async () => {
    job = {
      ...job,
      status: 'failed',
      failure: 'evidence',
      message: 'La visita è chiusa.',
      task: null,
      facts: [{ placeId: 'blue-museum', information: information() }],
    };
    render(<AiAssistant target={{ dayId: 'day-one' }} onTarget={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('Informazioni e fonti consultate')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Museo sintetico: visite' })[0]).toHaveAttribute(
      'href',
      'https://museum.example/',
    );
    expect(
      screen.queryByRole('button', { name: 'Applica questa proposta' }),
    ).not.toBeInTheDocument();
  });
  it('renders original currency, group totals, unknown prices and the dated euro estimate', () => {
    const priced = exampleTrip();
    priced.plan.costs[0].currency = 'PLN';
    priced.plan.costs.push({ ...priced.plan.costs[0], id: 'unknown', min: null, max: null });
    priced.state.exchangeRates.push({
      currency: 'PLN',
      euroPerUnit: 0.25,
      asOf: '2026-10-01',
      fetchedAt: new Date().toISOString(),
      source: 'https://example.com/fx',
    });
    render(<AiInsights insights={dayInsights(priced, 'day-one', Date.now())} />);
    expect(screen.getByText(/totale incompleto/)).toBeInTheDocument();
    expect(screen.getByText(/cambio del 2026-10-01/)).toHaveTextContent('7,50');
    expect(screen.getByText(/Pagato:/)).toHaveTextContent('30,00');
  });
});
