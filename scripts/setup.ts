import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hashKey } from '../src/server/auth';
import { exampleTrip } from '../src/domain/fixture';

try {
  await access('.env.local');
  console.log('Local credentials already exist. Nothing overwritten.');
} catch {
  const accessKey = randomBytes(32).toString('base64url'),
    agentKey = randomBytes(32).toString('base64url');
  await mkdir('local-data', { recursive: true });
  await writeFile(
    '.env.local',
    `STORAGE_DRIVER=file\nDATA_DIR=local-data/store\nAPP_ACCESS_KEY_HASH=${hashKey(accessKey)}\nAGENT_API_TOKEN_HASH=${hashKey(agentKey)}\nSESSION_SECRET=${randomBytes(32).toString('base64url')}\nITINERARY_API_URL=http://localhost:5173\nITINERARY_API_TOKEN=${agentKey}\n`,
    { mode: 0o600 },
  );
  await writeFile('local-data/access-key.txt', accessKey + '\n', { mode: 0o600 });
  console.log(
    'Credentials generated. Your browser access key is in local-data/access-key.txt (ignored by Git).',
  );
}
const trip = exampleTrip();
await mkdir(`local-data/store/trips/${trip.id}`, { recursive: true });
try {
  await writeFile(`local-data/store/trips/${trip.id}/current.json`, JSON.stringify(trip), {
    flag: 'wx',
    mode: 0o600,
  });
  console.log('Fictional example trip created.');
} catch {
  /* Preserve existing example state. */
}
