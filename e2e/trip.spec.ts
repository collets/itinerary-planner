import { exampleTrip } from '../src/domain/fixture';
import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type APIRequestContext,
} from '@playwright/test';
test.beforeEach(async ({ request }) => {
  const headers = { Authorization: 'Bearer e2e-agent-token' };
  const old = await request.get('/api/v1/trips/example-trip', { headers });
  const value = await old.json();
  await request.delete('/api/v1/trips/example-trip', {
    headers: { ...headers, 'If-Match': value.etag },
  });
  const plan = exampleTrip().plan;
  plan.costs[0] = { ...plan.costs[0], currency: 'PLN', min: 45, max: 55 };
  await request.post('/api/v1/trips', { headers, data: { id: 'example-trip', plan } });
  await request.post('/api/v1/trips/example-trip/rates', { headers, data: {} });
});
const connection = async (
  offline: boolean,
  browserName: string,
  context: BrowserContext,
  request: APIRequestContext,
) => {
  if (browserName === 'webkit')
    await request.post(`http://127.0.0.1:3002/${offline ? 'offline' : 'online'}`);
  else await context.setOffline(offline);
};
test.afterEach(async ({ browserName, request }) => {
  if (browserName === 'webkit') await request.post('http://127.0.0.1:3002/online');
});
const login = async (page: Page) => {
  await page.goto('/');
  await page.getByLabel('La vostra chiave di accesso').fill('e2e-access-key');
  await page.getByRole('button', { name: 'Apri i tuoi viaggi' }).click();
  await page.getByRole('link', { name: /Un giorno a Borgo Blu/ }).click();
  await expect(page.getByRole('heading', { name: 'Un giorno a Borgo Blu.' })).toBeVisible();
};
test('full day, route and details remain usable on mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await expect(page.getByText('09:00', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Verso il museo, percorso 15 minuti' }),
  ).toContainText('1 punto di interesse');
  await page.getByRole('link', { name: 'Verso il museo, percorso 15 minuti' }).click();
  await expect(page.getByRole('heading', { name: 'Verso il museo', exact: true })).toBeVisible();
  await expect(
    page.locator('.street-list li').filter({ hasText: 'Via dei Giardini' }),
  ).toBeVisible();
  await expect(page.getByText('Giardino segreto', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tappa successiva' }).click();
  await expect(page.getByRole('heading', { name: 'Museo del borgo', exact: true })).toBeVisible();
  await expect(page.locator('.euro-estimate').first()).toContainText('≈');
  await page.getByRole('button', { name: /Visitata/ }).click();
  await page.getByRole('link', { name: 'Vista completa' }).click();
  await expect(page.locator('.stop-card').last()).toContainText('Visitata');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/mobile-overview.png', fullPage: true });
});
test('uploads a shared ticket, filters by person, then opens it after an offline reload', async ({
  page,
  context,
  browserName,
  request,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'Biglietti', exact: true }).click();
  await page.getByRole('button', { name: 'Aggiungi biglietto' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Titolo', { exact: true }).fill('Ingresso condiviso');
  await dialog.getByRole('combobox', { name: 'Tappa', exact: true }).selectOption('museum');
  await dialog.locator('input[type=file]').setInputFiles('public/icon-192.png');
  await dialog.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresso condiviso' })).toBeVisible();
  await page.getByRole('button', { name: 'Io', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresso condiviso' })).toBeVisible();
  await page.getByRole('button', { name: 'Compagno di viaggio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresso condiviso' })).toBeVisible();
  await page.getByRole('button', { name: 'Salva viaggio offline', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Salva viaggio offline', exact: true })
    .click();
  await expect(page.getByText('Download completato', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Chiudi', exact: true }).click();
  await page.getByRole('link', { name: /Apri biglietto/ }).click();
  await expect(page.locator('.image-ticket img')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await connection(true, browserName, context, request);
  await page.reload();
  await expect(page.locator('.image-ticket img')).toBeVisible();
  await expect(page.getByText(/Stai usando il viaggio salvato/)).toBeVisible();
  await page.getByRole('link', { name: 'Preparativi', exact: true }).click();
  await expect(page.locator('.budget-total .euro-estimate').first()).toContainText('≈');
  await page.getByRole('checkbox', { name: /Prenotare il museo/ }).check();
  await expect(page.getByRole('checkbox', { name: /Prenotare il museo/ })).toBeChecked();
  await connection(false, browserName, context, request);
  if (browserName === 'webkit')
    await page.getByRole('button', { name: 'Aggiorna viaggio' }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v1/trips/example-trip');
      return (await response.json()).trip.state.taskCompletion['book-museum'];
    })
    .toBe(true);
});
function pdfDocument() {
  const content = 'BT /F1 24 Tf 40 160 Td (BIGLIETTO TEST) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 220] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const position = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => String(o).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  return Buffer.from(result);
}
test('renders an original PDF for the first time while offline', async ({
  page,
  context,
  request,
  browserName,
}) => {
  const headers = { Authorization: 'Bearer e2e-agent-token' },
    bytes = pdfDocument();
  const value = await (await request.get('/api/v1/trips/example-trip', { headers })).json();
  const made = await request.post('/api/v1/trips/example-trip/tickets', {
    headers: { ...headers, 'If-Match': value.etag },
    data: {
      title: 'PDF offline',
      filename: 'ticket.pdf',
      stepId: 'museum',
      travellerIds: ['traveller-one'],
      contentType: 'application/pdf',
      size: bytes.length,
    },
  });
  const ticket = (await made.json()).trip.state.tickets[0];
  expect(
    (
      await request.put(`/api/v1/trips/example-trip/tickets/${ticket.id}/file`, {
        headers: { ...headers, 'Content-Type': 'application/pdf' },
        data: bytes,
      })
    ).ok(),
  ).toBe(true);
  await login(page);
  await page.getByRole('button', { name: 'Salva viaggio offline', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Salva viaggio offline', exact: true })
    .click();
  await expect(page.getByText('Download completato', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Chiudi', exact: true }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await connection(true, browserName, context, request);
  await page.goto(`/trips/example-trip/tickets/${ticket.id}`);
  await expect(page.getByRole('heading', { name: 'PDF offline', exact: true })).toBeVisible();
  await expect
    .poll(() => page.locator('canvas').evaluate((e) => (e as HTMLCanvasElement).width))
    .toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Aumenta zoom' }).click();
  await expect(page.getByText('125%', { exact: true })).toBeVisible();
});
