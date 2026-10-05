// Local-only synthetic adapter. No provider keys, network calls or live deployments.
import { config } from 'dotenv';
import { FileStorage } from '../src/server/storage.js';
import { AiBudgetService } from '../src/server/ai-budget.js';
if (process.env.VERCEL) throw new Error('The AI demo is local only');
await import('./setup.js');
config({ path: '.env.local', quiet: true });
if (process.env.STORAGE_DRIVER === 'blob')
  throw new Error('Use a separate local file store for the demo');
process.env.STORAGE_DRIVER = 'file';
process.env.AI_MODE = 'mock';
await new AiBudgetService(new FileStorage(process.env.DATA_DIR ?? 'local-data/store')).configure(
  true,
);
console.log(
  'AI demo enabled locally. Browser access key: local-data/access-key.txt. No paid calls.',
);
await import('./dev.js');
