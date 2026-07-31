import { randomUUID } from 'node:crypto';
import { agents, conversations, createDb, type Db, messages } from '@assistant/db';
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
const testedRoutes = [
  '/',
  '/chat',
  '/approvals',
  '/goals',
  '/tasks',
  '/profile',
  '/profile/memories',
  '/documents',
  '/skills',
  '/settings',
  '/import',
  '/costs',
  '/anomalies',
  '/improvements',
];

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

async function assertResponsiveContract(page: Page, label: string, mobile: boolean) {
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
  if (mobile) {
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
}

async function openRoute(page: Page, path: string, mobile = true) {
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  assert(response?.ok(), `${path} returned HTTP ${response?.status() ?? 'unknown'}`);
  assert(
    new URL(page.url()).origin === new URL(baseUrl).origin,
    `${path} unexpectedly left the smoke-test origin: ${page.url()}`,
  );
  await page.waitForLoadState('networkidle');
  await assertResponsiveContract(page, path, mobile);
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
  const longToken = 'unbroken-mobile-overflow-regression-'.repeat(10);
  await db.insert(messages).values([
    {
      conversationId: conversation.id,
      role: 'user',
      origin: 'owner',
      text: longToken,
      parts: [{ type: 'text', text: longToken }],
    },
    {
      conversationId: conversation.id,
      role: 'assistant',
      origin: 'assistant',
      text: `A long inline value: \`${longToken}\``,
      parts: [
        {
          type: 'text',
          text: `A long inline value: \`${longToken}\`\n\n| Detail | Value |\n| --- | --- |\n| Token | ${longToken} |`,
        },
      ],
    },
  ]);
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
  assert(
    new URL(page.url()).pathname === '/chat',
    `Root did not open the primary chat: ${page.url()}`,
  );
  assert(await page.getByRole('textbox', { name: 'Message' }).isVisible(), 'Chat is not ready');
  const menuTrigger = page.getByRole('button', { name: 'Open navigation menu' });
  await targetSize(menuTrigger, 'mobile navigation trigger');
  await menuTrigger.click();
  const bloom = page.locator('#mobile-nav[role="dialog"]');
  await bloom.waitFor({ state: 'visible' });
  assert((await bloom.getAttribute('aria-modal')) === 'true', 'mobile bloom is not modal');
  assert(
    (await bloom.getAttribute('aria-labelledby')) === 'mobile-nav-title',
    'mobile bloom is not labelled',
  );
  assert(
    (await page.evaluate(() => document.body.style.overflow)) === 'hidden',
    'opening the mobile bloom did not lock background scrolling',
  );
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
      'Close navigation menu',
    'opening the mobile bloom did not move focus to its close control',
  );
  await targetSize(bloom.getByRole('link', { name: 'Chat' }), 'primary bloom destination');
  const moreButton = bloom.getByRole('button', { name: 'More' });
  await targetSize(moreButton, 'mobile bloom more control');
  await moreButton.click();
  const settingsLink = bloom.getByRole('link', { name: 'Settings' });
  await settingsLink.waitFor({ state: 'visible' });
  await targetSize(settingsLink, 'secondary bloom destination');
  await settingsLink.focus();
  await page.keyboard.press('Tab');
  assert(
    await page.evaluate(() =>
      Boolean(document.querySelector('#mobile-nav')?.contains(document.activeElement)),
    ),
    'Tab escaped the mobile navigation dialog',
  );
  await page.evaluate(() => {
    const focusable = [
      ...(document
        .querySelector('#mobile-nav')
        ?.querySelectorAll<HTMLElement>(
          'a[href]:not([aria-hidden="true"]), button:not([disabled]):not([aria-hidden="true"])',
        ) ?? []),
    ].filter((element) => element.checkVisibility());
    focusable[focusable.length - 1]?.focus();
  });
  await page.keyboard.press('Tab');
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
      'Close navigation menu',
    'Tab from the last bloom control did not wrap to the close control',
  );
  const closeButton = bloom.getByRole('button', { name: 'Close navigation menu' });
  await targetSize(closeButton, 'mobile navigation close button');
  await closeButton.click();
  await bloom.waitFor({ state: 'detached' });
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
      'Open navigation menu',
    'closing the mobile bloom did not restore focus to its trigger',
  );

  for (const route of testedRoutes.slice(1)) await openRoute(page, route);
  await openRoute(page, '/tasks');
  assert((await page.locator('main table').count()) === 0, 'Activity regressed to a table');
  assert(
    await page.getByRole('navigation', { name: 'Filter activity' }).isVisible(),
    'Activity filters are missing',
  );

  if (fixture) {
    await openRoute(page, `/chat/${fixture.id}`);
    const message = page.getByRole('textbox', { name: 'Message' });
    const send = page.getByRole('button', { name: 'Send' });
    const composerSurface = page.getByTestId('chat-composer-surface');
    const autonomyMode = page.getByTestId('chat-autonomy-mode');
    await targetSize(message, 'chat message field');
    await targetSize(send, 'chat send button');
    await targetSize(autonomyMode, 'chat autonomy mode');
    assert(
      (await page.getByRole('link', { name: 'All chats', exact: true }).count()) === 0,
      'All chats still occupies the chat header',
    );
    assert(
      (await page.getByRole('button', { name: 'Model', exact: true }).count()) === 0,
      'Model still occupies the chat header',
    );
    assert(
      (await composerSurface.locator('[data-testid="chat-autonomy-mode"]').count()) === 1,
      'autonomy mode is not integrated into the composer surface',
    );
    await message.fill('/model');
    const modelList = page.getByRole('listbox', { name: 'Response model' });
    await modelList.waitFor();
    await targetSize(modelList.getByRole('option').first(), 'slash-command model option');
    await message.fill('A long mobile draft '.repeat(40));
    await assertResponsiveContract(page, 'populated chat composer', true);
    const composer = await message.boundingBox();
    assert(
      composer && composer.y + composer.height <= 844,
      'chat composer fell below the viewport',
    );
  }

  for (const viewport of [
    { width: 768, height: 900, label: 'tablet' },
    { width: 1440, height: 900, label: 'desktop' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of testedRoutes) {
      await openRoute(page, route, false);
    }
    assert(
      (await page.locator('main').count()) === 1,
      `${viewport.label} shell did not render exactly one main region`,
    );
  }

  assert(errors.length === 0, `browser errors were reported: ${errors.join(' | ')}`);
  console.log(
    JSON.stringify({
      ok: true,
      viewports: ['390x844', '768x900', '1440x900'],
      routes: testedRoutes.length * 3 + (fixture ? 1 : 0),
      checks: [
        'no horizontal overflow',
        '44px mobile targets',
        '16px mobile fields',
        'bloom focus trap',
        'primary and secondary bloom destinations',
        'root opens the primary chat',
        'activity feed and filters',
      ],
    }),
  );
} finally {
  await context?.close();
  await browser?.close();
  if (fixture) {
    await fixture.db.delete(messages).where(eq(messages.conversationId, fixture.id));
    await fixture.db.delete(conversations).where(eq(conversations.id, fixture.id));
    await (fixture.db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
}
