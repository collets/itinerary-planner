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
  const old = await request.get('/api/v2/trips/example-trip', { headers });
  await expect(old).toBeOK();
  const value = await old.json();
  const removed = await request.delete('/api/v2/trips/example-trip', {
    headers: { ...headers, 'X-Trip-Version': value.etag },
  });
  await expect(removed).toBeOK();
  const plan = exampleTrip().plan;
  plan.costs[0] = { ...plan.costs[0], currency: 'PLN', min: 45, max: 55 };
  const created = await request.post('/api/v2/trips', {
    headers,
    data: { id: 'example-trip', plan },
  });
  await expect(created).toBeOK();
  const rates = await request.post('/api/v2/trips/example-trip/rates', { headers, data: {} });
  await expect(rates).toBeOK();
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
const activeSection = async (page: Page, name: string) => {
  const navigation = page.getByRole('navigation', { name: 'Navigazione viaggio' });
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(navigation.locator('.active')).toHaveCount(1);
  await expect(
    navigation.getByRole(name === 'Adesso' ? 'button' : 'link', { name, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
};
test('full day, route and details remain usable on mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await activeSection(page, 'Itinerario');
  await page.goto('/trips/example-trip/?day=day-one');
  await activeSection(page, 'Itinerario');
  await expect(page.getByText('09:00', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Verso il museo, percorso 15 minuti' }),
  ).toContainText('1 punto di interesse');
  await page.getByRole('link', { name: 'Verso il museo, percorso 15 minuti' }).click();
  await expect(page.getByRole('heading', { name: 'Verso il museo', exact: true })).toBeVisible();
  await activeSection(page, 'Adesso');
  await expect(
    page.locator('.street-list li').filter({ hasText: 'Via dei Giardini' }),
  ).toBeVisible();
  await expect(page.getByText('Giardino segreto', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tappa successiva' }).click();
  await expect(page.getByRole('heading', { name: 'Museo del borgo', exact: true })).toBeVisible();
  await activeSection(page, 'Adesso');
  await page.reload();
  await activeSection(page, 'Adesso');
  await expect(page.locator('.euro-estimate').first()).toContainText('≈');
  await page.getByRole('button', { name: /Visitata/ }).click();
  await page.getByRole('link', { name: 'Vista completa' }).click();
  await activeSection(page, 'Itinerario');
  await page.goBack();
  await activeSection(page, 'Adesso');
  await page.goForward();
  await activeSection(page, 'Itinerario');
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
  await activeSection(page, 'Biglietti');
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
  await activeSection(page, 'Biglietti');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await connection(true, browserName, context, request);
  await page.reload();
  await expect(page.locator('.image-ticket img')).toBeVisible();
  await expect(page.getByText(/Stai usando il viaggio salvato/)).toBeVisible();
  await activeSection(page, 'Biglietti');
  await page.getByRole('link', { name: 'Preparativi', exact: true }).click();
  await activeSection(page, 'Preparativi');
  await expect(page.locator('.budget-total .euro-estimate').first()).toContainText('≈');
  await page.getByRole('checkbox', { name: /Prenotare il museo/ }).check();
  await expect(page.getByRole('checkbox', { name: /Prenotare il museo/ })).toBeChecked();
  await connection(false, browserName, context, request);
  if (browserName === 'webkit')
    await page.getByRole('button', { name: 'Aggiorna viaggio' }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v2/trips/example-trip');
      return (await response.json()).trip.state.taskCompletion['book-museum'];
    })
    .toBe(true);
});
test('dialogs fill the mobile screen, contain scrolling and restore the page', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await login(page);
  await page.evaluate(() => window.scrollTo(0, 250));
  const editDay = page.getByRole('button', { name: 'Adatta la giornata', exact: true });
  await editDay.scrollIntoViewIfNeeded();
  const originalScroll = await page.evaluate(() => window.scrollY);
  await editDay.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize()!;
  const bounds = await dialog.boundingBox();
  expect(bounds).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  await expect(dialog.getByRole('button', { name: 'Chiudi', exact: true })).toBeVisible();
  expect(await dialog.locator('.modal-header svg').getAttribute('width')).toBe('20');
  await page.getByLabel('Tipo di modifica').selectOption('add');
  await expect(dialog.getByLabel('Nome della tappa')).toBeVisible();
  await dialog.getByLabel('Nome della tappa').fill('Un posto nuovo');
  await expect(dialog.getByLabel('Nome della tappa')).toHaveCSS('font-size', '16px');
  const body = dialog.locator('.modal-body');
  await body.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByRole('button', { name: 'Chiudi', exact: true })).toBeInViewport();
  const scrollState = await dialog.evaluate((element) => {
    const content = element.querySelector('.modal-body')!;
    window.scrollTo(100, 1000);
    return {
      pageX: window.scrollX,
      pageY: window.scrollY,
      bodyPosition: getComputedStyle(document.body).position,
      dialogFits: element.scrollWidth <= element.clientWidth,
      contentFits: content.scrollWidth <= content.clientWidth,
    };
  });
  expect(scrollState).toEqual({
    pageX: 0,
    pageY: 0,
    bodyPosition: 'fixed',
    dialogFits: true,
    contentFits: true,
  });
  await page.screenshot({ path: 'test-results/mobile-dialog.png' });
  await dialog.getByRole('button', { name: 'Chiudi', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(originalScroll);
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed');
  await page.getByRole('link', { name: 'Biglietti', exact: true }).click();
  await page.getByRole('button', { name: 'Aggiungi biglietto' }).click();
  await expect(dialog).toBeVisible();
  expect(await dialog.boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
  await expect(dialog.getByRole('button', { name: 'Chiudi', exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBe(550);
  expect((await dialog.boundingBox())!.height).toBeLessThan(768);
  await expect(dialog.getByRole('button', { name: 'Chiudi', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed');
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
  const current = await request.get('/api/v2/trips/example-trip', { headers });
  await expect(current).toBeOK();
  const value = await current.json();
  const made = await request.post('/api/v2/trips/example-trip/tickets', {
    headers: { ...headers, 'X-Trip-Version': value.etag },
    data: {
      title: 'PDF offline',
      filename: 'ticket.pdf',
      stepId: 'museum',
      travellerIds: ['traveller-one'],
      contentType: 'application/pdf',
      size: bytes.length,
    },
  });
  await expect(made).toBeOK();
  const ticket = (await made.json()).trip.state.tickets[0];
  expect(
    (
      await request.put(`/api/v2/trips/example-trip/tickets/${ticket.id}/file`, {
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

async function confirmEdit(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Mostra anteprima' }).click();
  await expect(dialog.getByRole('heading', { name: 'Anteprima del programma' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Conferma modifica', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function download(page: Page) {
  await page.getByRole('button', { name: 'Salva viaggio offline', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Salva viaggio offline', exact: true })
    .click();
  await expect(page.getByText('Download completato', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Chiudi', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
test('offline reorder, note, archive and reinclude survive reload and sync in order', async ({
  page,
  context,
  browserName,
  request,
}) => {
  await login(page);
  await download(page);
  await connection(true, browserName, context, request);
  await page.getByRole('button', { name: 'Adatta Museo del borgo', exact: true }).click();
  await page.getByLabel('Tipo di modifica').selectOption('move');
  await page.getByRole('dialog').getByLabel('Posizione della tappa').selectOption('');
  await page.getByRole('dialog').getByLabel('Minuti indicativi').fill('10');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Stima confermata', exact: true })
    .click();
  await confirmEdit(page);
  await expect(page.locator('.stop-card').first()).toContainText('Museo del borgo');
  await page.getByRole('button', { name: 'Adatta Museo del borgo', exact: true }).click();
  await page.getByLabel('Tipo di modifica').selectOption('note');
  await page.getByLabel('Nota condivisa').fill('Ci fermiamo per un caffè');
  await confirmEdit(page);
  await page.reload();
  await expect(page.locator('.stop-card').first()).toContainText('Museo del borgo');
  await page.getByRole('button', { name: 'Adatta Museo del borgo', exact: true }).click();
  await page.getByLabel('Tipo di modifica').selectOption('skip');
  await confirmEdit(page);
  await expect(page.locator('.stop-card')).toHaveCount(1);
  await page.locator('.archived-stops summary').click();
  await page
    .locator('.archived-stops')
    .getByRole('link', { name: /Museo del borgo/ })
    .click();
  await expect(page.getByText('Ci fermiamo per un caffè', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reinserisci o annota' }).click();
  await page.getByLabel('Posizione della tappa').selectOption('');
  await confirmEdit(page);
  await page.getByRole('link', { name: 'Vista completa' }).click();
  await expect(page.locator('.stop-card')).toHaveCount(2);
  await connection(false, browserName, context, request);
  await page.getByRole('button', { name: 'Aggiorna viaggio' }).click();
  await expect
    .poll(async () => {
      const r = await page.request.get('/api/v2/trips/example-trip');
      const t = (await r.json()).trip;
      return t.travel?.history.length;
    })
    .toBe(4);
  await expect(page.getByText('Modifiche da rivedere', { exact: true })).not.toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const r = indexedDB.open('passo-private-data');
        return await new Promise<number>((resolve) => {
          r.onsuccess = () => {
            const d = r.result;
            const c = d.transaction('travelCommands').objectStore('travelCommands').count();
            c.onsuccess = () => resolve(c.result);
          };
        });
      }),
    )
    .toBe(0);
});
test('two phones retain conflicting edits until explicit review and confirmation', async ({
  page,
  browser,
  browserName,
  context,
  request,
}) => {
  await login(page);
  await download(page);
  const other = await browser.newContext({ baseURL: 'http://localhost:5173' }),
    second = await other.newPage();
  try {
    await login(second);
    await connection(true, browserName, context, request);
    if (browserName === 'webkit')
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
        window.dispatchEvent(new Event('offline'));
      });
    await page.getByRole('button', { name: 'Adatta La piazza del borgo', exact: true }).click();
    await page.getByRole('button', { name: '+30 min', exact: true }).click();
    await confirmEdit(page);
    if (browserName === 'webkit') await connection(false, browserName, context, request);
    await second.getByRole('button', { name: 'Adatta La piazza del borgo', exact: true }).click();
    await confirmEdit(second);
    await expect
      .poll(async () => {
        const r = await second.request.get('/api/v2/trips/example-trip');
        return (await r.json()).trip.travel?.history.length;
      })
      .toBe(1);
    if (browserName === 'webkit')
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
        window.dispatchEvent(new Event('online'));
      });
    else await connection(false, browserName, context, request);
    await page.getByRole('button', { name: 'Aggiorna viaggio' }).click();
    await expect(page.getByText('Modifiche da rivedere', { exact: true })).toBeVisible();
    await expect(page.locator('.time-column strong').first()).toHaveText('09:30');
    await page.getByRole('button', { name: 'Confronta le versioni' }).click();
    await page.getByRole('button', { name: 'Rivedi e conferma' }).click();
    await page.getByRole('dialog').getByLabel('Ritardo in minuti').fill('15');
    await confirmEdit(page);
    await expect
      .poll(async () => {
        const r = await page.request.get('/api/v2/trips/example-trip');
        return (await r.json()).trip.travel?.history.length;
      })
      .toBe(2);
    await second.getByRole('button', { name: 'Aggiorna viaggio' }).click();
    await expect(second.locator('.time-column strong').first()).toHaveText('09:30');
    await expect(page.getByText('Modifiche da rivedere', { exact: true })).not.toBeVisible();
  } finally {
    await other.close();
  }
});
