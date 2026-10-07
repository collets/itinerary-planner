import { z } from 'zod';

/** Public citation links only. These are displayed, never fetched by our server. */
export const ResearchUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !url.search &&
      !/^(localhost|.*\.localhost|.*\.local|.*\.internal|\d+(?:\.\d+){3}|\[.*\])$/i.test(
        url.hostname,
      ) &&
      url.hostname.includes('.')
    );
  }, 'Use a public HTTPS citation without credentials, query or fragment');
const sourceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const sourceIds = z.array(sourceId).min(1).max(4);
const fact = z.object({ text: z.string().trim().min(1).max(1800), sourceIds }).strict();
const link = z.object({ url: ResearchUrl, sourceIds }).strict();
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const window = z
  .object({ opens: clock, closes: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/) })
  .strict();
export const PlaceResearchSchema = z
  .object({
    description: fact.nullable(),
    details: fact.nullable(),
    trivia: fact.nullable(),
    entrance: fact.nullable(),
    openingHours: z
      .object({
        text: z.string().trim().min(1).max(1800),
        sourceIds,
        visitStatus: z.enum(['open', 'closed', 'unknown']),
        windows: z.array(window).max(3),
      })
      .strict()
      .nullable(),
    price: z
      .object({
        label: z.string().trim().min(1).max(300),
        min: z.number().min(0).max(100000),
        max: z.number().min(0).max(100000),
        currency: z.string().regex(/^[A-Z]{3}$/),
        basis: z.enum(['person', 'group']),
        sourceIds,
      })
      .strict()
      .nullable(),
    website: link.nullable(),
    bookingUrl: link.nullable(),
    sources: z
      .array(
        z
          .object({
            id: sourceId,
            title: z.string().trim().min(1).max(200),
            url: ResearchUrl,
            kind: z.enum(['official', 'secondary']),
          })
          .strict(),
      )
      .max(6),
    warnings: z.array(z.string().trim().min(1).max(500)).max(6),
  })
  .strict();
export const PlaceInformationSchema = PlaceResearchSchema.extend({
  checkedAt: z.iso.datetime(),
  visitDate: z.iso.date(),
})
  .strict()
  .superRefine((value, ctx) => {
    if (JSON.stringify(value).length > 18000)
      ctx.addIssue({ code: 'custom', message: 'Research evidence exceeds storage/history bound' });
    const sources = new Map(value.sources.map((s) => [s.id, s]));
    if (sources.size !== value.sources.length)
      ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Duplicate evidence IDs' });
    for (const key of [
      'description',
      'details',
      'trivia',
      'entrance',
      'openingHours',
      'price',
      'website',
      'bookingUrl',
    ] as const) {
      const field = value[key];
      if (!field) continue;
      if (field.sourceIds.some((id) => !sources.has(id)))
        ctx.addIssue({ code: 'custom', path: [key], message: 'Missing field evidence' });
      if (
        ['openingHours', 'price', 'website', 'bookingUrl', 'entrance'].includes(key) &&
        !field.sourceIds.some((id) => sources.get(id)?.kind === 'official')
      )
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Practical facts need official evidence',
        });
      if (
        'url' in field &&
        !field.sourceIds.some(
          (id) =>
            new URL(
              sources.get(id)?.kind === 'official'
                ? sources.get(id)!.url
                : 'https://invalid.example',
            ).hostname === new URL(field.url).hostname,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Link must match its cited official site',
        });
    }
    if (value.price && value.price.max < value.price.min)
      ctx.addIssue({ code: 'custom', path: ['price'], message: 'Invalid price range' });
    if (value.openingHours) {
      const hours = value.openingHours;
      if (hours.visitStatus !== 'open' && hours.windows.length)
        ctx.addIssue({
          code: 'custom',
          path: ['openingHours'],
          message: 'Only open dates have windows',
        });
      if (hours.windows.some((w) => w.opens >= w.closes))
        ctx.addIssue({ code: 'custom', path: ['openingHours'], message: 'Invalid opening window' });
    }
  });
export type PlaceInformation = z.infer<typeof PlaceInformationSchema>;
export type PlaceResearch = z.infer<typeof PlaceResearchSchema>;
export type PlaceInformationUpdate = { placeId: string; information: PlaceInformation };
export function informationFresh(
  information: PlaceInformation | undefined,
  visitDate: string,
  now: number,
) {
  return (
    !!information &&
    information.visitDate === visitDate &&
    Date.parse(information.checkedAt) <= now &&
    now - Date.parse(information.checkedAt) < 24 * 3600_000
  );
}
/** Checks the cited date's local window; unknown hours never imply admission. */
export function visitWindowStatus(
  information: PlaceInformation,
  start: string,
  end: string,
  timezone: string,
): 'fits' | 'outside' | 'unknown' {
  const hours = information.openingHours;
  const parts = (value: string) => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const field = (type: string) => p.find((v) => v.type === type)!.value;
    return {
      date: `${field('year')}-${field('month')}-${field('day')}`,
      time: `${field('hour')}:${field('minute')}`,
    };
  };
  const from = parts(start),
    to = parts(end);
  if (!hours || from.date !== information.visitDate) return 'unknown';
  if (hours.visitStatus === 'closed') return 'outside';
  if (hours.visitStatus === 'unknown' || !hours.windows.length) return 'unknown';
  return to.date === from.date &&
    hours.windows.some((w) => from.time >= w.opens && to.time <= w.closes)
    ? 'fits'
    : 'outside';
}
