import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';

it('keeps feature deployments disabled until explicitly isolated, without affecting releases', () => {
  const check = (values: Record<string, string>) =>
    spawnSync(process.execPath, ['scripts/ai-preview-build.mjs'], {
      env: { PATH: process.env.PATH, ...values },
      encoding: 'utf8',
    }).status;
  expect(check({ VERCEL_GIT_COMMIT_REF: 'main' })).toBe(1);
  expect(check({ VERCEL_GIT_COMMIT_REF: 'staging' })).toBe(1);
  expect(check({ VERCEL_GIT_COMMIT_REF: 'feature/ai-assistance' })).toBe(0);
  const good = {
    VERCEL_GIT_COMMIT_REF: 'feature/ai-assistance',
    VERCEL_ENV: 'preview',
    AI_PREVIEW_ENABLED: 'true',
    AI_PREVIEW_PROJECT_ID: 'prj_test',
    VERCEL_PROJECT_ID: 'prj_test',
    APP_ENVIRONMENT: 'ai-preview',
    STORAGE_DRIVER: 'blob',
    AI_PREVIEW_STORE_ID: 'store_test',
    BLOB_STORE_ID: 'test',
  };
  expect(check(good)).toBe(1);
  expect(check({ ...good, BLOB_STORE_ID: 'wrong-store' })).toBe(0);
  expect(check({ ...good, STAGING_SEED: 'unexpected-private-seed' })).toBe(0);
  expect(check({ ...good, BLOB_READ_WRITE_TOKEN: 'legacy-shared-credential' })).toBe(0);
  expect(check({ ...good, VERCEL_ENV: 'production' })).toBe(0);
  expect(check({ ...good, VERCEL_PROJECT_ID: 'prj_production' })).toBe(0);
  expect(check({ ...good, AI_PREVIEW_PROJECT_ID: '' })).toBe(0);
  expect(check({ ...good, VERCEL_GIT_COMMIT_REF: 'staging' })).toBe(0);
  expect(
    check({ ...good, VERCEL_GIT_COMMIT_REF: 'staging', AI_STAGING_BRANCH_ENABLED: 'true' }),
  ).toBe(1);
  expect(
    check({ ...good, VERCEL_GIT_COMMIT_REF: 'unreviewed', AI_STAGING_BRANCH_ENABLED: 'true' }),
  ).toBe(0);
  expect(
    check({
      AI_PREVIEW_PROJECT_ID: 'prj_test',
      VERCEL_GIT_COMMIT_REF: 'main',
      VERCEL_ENV: 'production',
    }),
  ).toBe(0);
});
