import { randomUUID } from 'node:crypto';
import { agents, conversations, createDb, type Db } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from 'playwright';

// localhost, not 127.0.0.1: Next 16's dev-origin protection only allows the
// localhost origin by default — against 127.0.0.1 the dev client never
// hydrates and every interaction assertion times out.
const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const browserPath = process.env.SMOKE_BROWSER_PATH;
const browserChannel = process.env.SMOKE_BROWSER_CHANNEL ?? 'chrome';
const createFixture = process.env.SMOKE_CREATE_FIXTURE === 'true';
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const testedRoutes = ['/', '/chat', '/goals', '/tasks', '/profile', '/settings'];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function targetSize(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  assert(box, `${label} is not visible`);
  assert(
    box.width >= 43.5 && box.height >= 43.5,
    `${label} is ${Math.round(box.width)}×${Math.round(box.height)}; expected at least 44×44`,
  );
}

async function assertMobileContract(page: Page, label: string) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const selectors = [
      'button',
      'summary',
      'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
      'select',
      'textarea',
      '.mobile-touch-target',
    ];
    const elements = [
      ...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)])),
    ];
    const controls = elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      ) {
        return [];
      }
      return [
        {
          tag: element.tagName.toLowerCase(),
          label: (element.getAttribute('aria-label') || element.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          fontSize: Number.parseFloat(style.fontSize),
          formField: ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName),
        },
      ];
    });
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: root.scrollWidth,
      controls,
    };
  });
  assert(
    metrics.scrollWidth <= metrics.viewportWidth,
    `${label} overflows horizontally: ${metrics.scrollWidth}px document in ${metrics.viewportWidth}px viewport`,
  );
  const undersized = metrics.controls.filter(
    (control) => control.width < 44 || control.height < 44,
  );
  assert(
    undersized.length === 0,
    `${label} has undersized controls: ${JSON.stringify(undersized)}`,
  );
  const zoomingFields = metrics.controls.filter(
    (control) => control.formField && control.fontSize < 16,
  );
  assert(
    zoomingFields.length === 0,
    `${label} has form text below 16px, which triggers iOS focus zoom: ${JSON.stringify(zoomingFields)}`,
  );
}

async function openRoute(page: Page, path: string) {
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  assert(response?.ok(), `${path} returned HTTP ${response?.status() ?? 'unknown'}`);
  assert(
    new URL(page.url()).origin === new URL(baseUrl).origin,
    `${path} unexpectedly left the smoke-test origin: ${page.url()}`,
  );
  await page.waitForLoadState('networkidle');
  await assertMobileContract(page, path);
}

async function createConversationFixture(): Promise<{ db: Db; id: string } | undefined> {
  if (!createFixture) return undefined;
  const db = createDb(databaseUrl);
  const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
  assert(agent, 'mobile smoke requires the seeded assistant agent');
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: agent.id,
      channel: 'chat',
      trust: 'owner',
      title: `Mobile smoke ${randomUUID().slice(0, 8)}`,
    })
    .returning({ id: conversations.id });
  assert(conversation, 'failed to create the mobile chat fixture');
  return { db, id: conversation.id };
}

const errors: string[] = [];
let fixture: Awaited<ReturnType<typeof createConversationFixture>>;
let browser: Browser | undefined;
let context: BrowserContext | undefined;

try {
  fixture = await createConversationFixture();
  browser = await chromium.launch({
    headless: true,
    ...(browserPath
      ? { executablePath: browserPath }
      : { channel: browserChannel as 'chrome' | 'chromium' }),
  });
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.push(`response: ${response.status()} ${response.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(`console: ${message.text()}`);
    }
  });

  await openRoute(page, '/');
  const menuTrigger = page.getByRole('button', { name: 'Open navigation menu' });
  await targetSize(menuTrigger, 'mobile navigation trigger');
  await menuTrigger.click();
  const drawer = page.locator('#mobile-nav[role="dialog"]');
  await drawer.waitFor({ state: 'visible' });
  assert((await drawer.getAttribute('aria-modal')) === 'true', 'mobile drawer is not modal');
  assert(
    (await drawer.getAttribute('aria-labelledby')) === 'mobile-nav-title',
    'mobile drawer is not labelled by its visible title',
  );
  assert(
    (await page.evaluate(() => document.body.style.overflow)) === 'hidden',
    'opening the mobile drawer did not lock background scrolling',
  );
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
      'Close navigation menu',
    'opening the mobile drawer did not move focus to its close control',
  );
  const settingsLink = drawer.getByRole('link', { name: 'Settings' });
  await settingsLink.focus();
  await page.keyboard.press('Tab');
  assert(
    await page.evaluate(() =>
      Boolean(document.querySelector('#mobile-nav')?.contains(document.activeElement)),
    ),
    'Tab escaped the mobile navigation dialog',
  );
  // Wrap check from the true last focusable (the drawer's tail varies —
  // System group, sign out — so don't assume Settings is last).
  await page.evaluate(() => {
    const focusable = [
      ...(document
        .querySelector('#mobile-nav')
        ?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary') ?? []),
    ].filter((element) => element.checkVisibility());
    focusable[focusable.length - 1]?.focus();
  });
  await page.keyboard.press('Tab');
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
      'Close navigation menu',
    'Tab from the last drawer control did not wrap to the close control',
  );
  const closeButton = drawer.getByRole('button', { name: 'Close navigation menu' });
  await targetSize(closeButton, 'mobile navigation close button');
  await closeButton.click();
  await drawer.waitFor({ state: 'detached' });
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
      'Open navigation menu',
    'closing the mobile drawer did not restore focus to its trigger',
  );

  for (const route of testedRoutes.slice(1)) await openRoute(page, route);

  if (fixture) {
    await openRoute(page, `/chat/${fixture.id}`);
    const message = page.getByRole('textbox', { name: 'Message' });
    const send = page.getByRole('button', { name: 'Send' });
    const model = page.getByRole('button', { name: 'Model' });
    await targetSize(message, 'chat message field');
    await targetSize(send, 'chat send button');
    await targetSize(model, 'chat model menu');
    await message.fill('A long mobile draft '.repeat(40));
    await assertMobileContract(page, 'populated chat composer');
    const composer = await message.boundingBox();
    assert(
      composer && composer.y + composer.height <= 844,
      'chat composer fell below the viewport',
    );
  }

  assert(errors.length === 0, `browser errors were reported: ${errors.join(' | ')}`);
  console.log(
    JSON.stringify({
      ok: true,
      viewport: '390x844',
      routes: testedRoutes.length + (fixture ? 1 : 0),
      checks: ['no horizontal overflow', '44px targets', '16px fields', 'drawer focus trap'],
    }),
  );
} finally {
  await context?.close();
  await browser?.close();
  if (fixture) {
    await fixture.db.delete(conversations).where(eq(conversations.id, fixture.id));
    await (fixture.db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
}
