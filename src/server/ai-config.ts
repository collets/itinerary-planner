import { MockAiProviders, type AiProviders } from './ai-providers.js';
import { liveProvidersFromEnvironment } from './ai-live.js';

export function isolatedAiPreview() {
  return (
    process.env.VERCEL_ENV === 'preview' &&
    process.env.VERCEL_GIT_COMMIT_REF === 'feature/ai-assistance' &&
    process.env.AI_PREVIEW_ENABLED === 'true' &&
    process.env.APP_ENVIRONMENT === 'ai-preview' &&
    process.env.STORAGE_DRIVER === 'blob' &&
    !!process.env.AI_PREVIEW_STORE_ID &&
    process.env.AI_PREVIEW_STORE_ID.trim().replace(/^store_/, '') ===
      process.env.BLOB_STORE_ID?.trim().replace(/^store_/, '') &&
    !process.env.BLOB_READ_WRITE_TOKEN &&
    !process.env.STAGING_SEED
  );
}
export function aiProviders(): AiProviders | undefined {
  const local = !process.env.VERCEL && process.env.STORAGE_DRIVER !== 'blob';
  const preview = isolatedAiPreview();
  if (process.env.AI_MODE === 'mock' && (local || preview)) return new MockAiProviders();
  if (
    !local &&
    !preview &&
    !(process.env.VERCEL_ENV === 'production' && process.env.AI_PRODUCTION_ENABLED === 'true')
  )
    return undefined;
  if (local && process.env.AI_LOCAL_LIVE_ENABLED !== 'true') return undefined;
  return liveProvidersFromEnvironment();
}
