// Vercel ignoreCommand: exit 0 skips a build; exit 1 proceeds.
// Main/staging releases keep their ordinary build behavior.
const aiBranch = process.env.VERCEL_GIT_COMMIT_REF === 'feature/ai-assistance';
if (!aiBranch) process.exit(1);
const isolated =
  process.env.VERCEL_ENV === 'preview' &&
  process.env.AI_PREVIEW_ENABLED === 'true' &&
  process.env.APP_ENVIRONMENT === 'ai-preview' &&
  process.env.STORAGE_DRIVER === 'blob' &&
  !!process.env.AI_PREVIEW_STORE_ID &&
  process.env.AI_PREVIEW_STORE_ID.replace(/^store_/, '') ===
    process.env.BLOB_STORE_ID?.replace(/^store_/, '') &&
  !process.env.STAGING_SEED &&
  !process.env.BLOB_READ_WRITE_TOKEN;
console.log(
  isolated
    ? 'Isolated AI preview build enabled.'
    : 'AI preview build skipped pending isolated configuration.',
);
process.exit(isolated ? 1 : 0);
