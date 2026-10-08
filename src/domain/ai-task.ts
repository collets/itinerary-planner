import { z } from 'zod';
import { Id } from './schema.js';
import { ResearchFocusSchema } from './place-information.js';

const instant = z.iso.datetime({ offset: true });
export const AiChangeIntentSchema = z
  .enum(['add-stop', 'replace-stop', 'adjust-stops', 'route', 'location-only', 'undo'])
  .nullable();
export const AiConstraintsSchema = z
  .object({
    keepStepIds: z.array(Id).max(60),
    avoidPlaceIds: z.array(Id).max(10),
    requireOpenPlaceIds: z.array(Id).max(2),
    maxWalkingMinutes: z.number().int().min(0).max(720).nullable(),
    finishBy: instant.nullable(),
    visitNotBefore: instant.nullable(),
    visitNotAfter: instant.nullable(),
    preferences: z.array(z.string().min(1).max(200)).max(6),
  })
  .strict();
export const AiTaskSchema = z
  .object({
    // Optional solely for task state persisted before executable-intent tracking.
    changeIntent: AiChangeIntentSchema.optional(),
    researchFocus: ResearchFocusSchema.nullable().optional(),
    goals: z
      .array(z.enum(['answer', 'research', 'compare', 'propose', 'undo']))
      .min(1)
      .max(5),
    targetStepIds: z.array(Id).max(4),
    constraints: AiConstraintsSchema,
    pendingQuestion: z
      .object({
        question: z.string().min(1).max(1000),
        choices: z
          .array(
            z
              .object({
                id: Id,
                label: z.string().min(1).max(160),
                stepId: Id.nullable(),
                placeId: Id.nullable(),
              })
              .strict(),
          )
          .max(6),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AiTask = z.infer<typeof AiTaskSchema>;
export const emptyConstraints = (): AiTask['constraints'] => ({
  keepStepIds: [],
  avoidPlaceIds: [],
  requireOpenPlaceIds: [],
  maxWalkingMinutes: null,
  finishBy: null,
  visitNotBefore: null,
  visitNotAfter: null,
  preferences: [],
});

/** A reasoning pass may tighten constraints, but only a new user turn may relax them. */
export function retainConstraints(previous: AiTask['constraints'], next: AiTask['constraints']) {
  const earlier = (a: string | null, b: string | null) =>
    !a ? b : !b ? a : Date.parse(a) <= Date.parse(b) ? a : b;
  const later = (a: string | null, b: string | null) =>
    !a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b;
  return AiConstraintsSchema.parse({
    keepStepIds: [...new Set([...previous.keepStepIds, ...next.keepStepIds])],
    avoidPlaceIds: [...new Set([...previous.avoidPlaceIds, ...next.avoidPlaceIds])],
    requireOpenPlaceIds: [
      ...new Set([...previous.requireOpenPlaceIds, ...next.requireOpenPlaceIds]),
    ],
    maxWalkingMinutes:
      previous.maxWalkingMinutes === null
        ? next.maxWalkingMinutes
        : next.maxWalkingMinutes === null
          ? previous.maxWalkingMinutes
          : Math.min(previous.maxWalkingMinutes, next.maxWalkingMinutes),
    finishBy: earlier(previous.finishBy, next.finishBy),
    visitNotBefore: later(previous.visitNotBefore, next.visitNotBefore),
    visitNotAfter: earlier(previous.visitNotAfter, next.visitNotAfter),
    preferences: [...new Set([...previous.preferences, ...next.preferences])].slice(0, 6),
  });
}
