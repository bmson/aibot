import { agents, contacts, conversations, createDb, type Db, messages, tasks } from '@assistant/db';
import axe from 'axe-core';
import { eq } from 'drizzle-orm';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
  webkit,
} from 'playwright';

const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const browserPath = process.env.SMOKE_BROWSER_PATH;
const browserChannel = process.env.SMOKE_BROWSER_CHANNEL ?? 'chrome';
const requestedBrowsers = (process.env.SMOKE_BROWSERS ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is 'chromium' | 'webkit' => name === 'chromium' || name === 'webkit');
const createFixture = process.env.SMOKE_CREATE_FIXTURE === 'true';
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

const baseRoutes = [
  '/',
  '/chat',
  '/chat/all',
  '/chat/all?view=archived',
  '/approvals',
  '/goals',
  '/goals?view=archived',
  '/tasks',
  '/tasks?filter=needs-you',
  '/tasks?filter=working',
  '/tasks?filter=scheduled',
  '/tasks?filter=completed',
  '/tasks?view=archived',
  '/profile',
  '/profile/memories',
  '/profile/memories?state=review',
  '/profile/memories?filter=verified',
  '/profile/memories?filter=untidied',
  '/profile/memories?q=__ui_audit_no_results__',
  '/documents',
  '/skills',
  '/settings',
  '/import',
  '/costs',
  '/anomalies',
  '/improvements',
] as const;

const viewports = [
  { width: 320, height: 568, label: 'compact phone' },
  { width: 390, height: 844, label: 'phone' },
  { width: 768, height: 1024, label: 'tablet portrait' },
  { width: 1024, height: 768, label: 'tablet landscape' },
  { width: 1440, height: 900, label: 'desktop' },
] as const;

interface AuditFixture {
  db: Db;
  conversationId: string;
  personId?: string;
  taskId?: string;
}

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
      'jelly-button',
      'jelly-input',
      'jelly-textarea',
      'jelly-segmented',
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
        style.visibility === 'hidden' ||
        element.closest('[inert]')
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
          formField: ['INPUT', 'SELECT', 'TEXTAREA', 'JELLY-INPUT', 'JELLY-TEXTAREA'].includes(
            element.tagName,
          ),
        },
      ];
    });

    const horizontalEscapes = [
      ...document.querySelectorAll<HTMLElement>('h1, h2, h3, p, button, input, textarea, summary'),
    ].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        element.closest(
          '.jelly-tabs-viewport, .overflow-x-auto, pre, [popover]:not(:popover-open), [inert]',
        )
      ) {
        return [];
      }
      if (rect.left >= -1 && rect.right <= window.innerWidth + 1) return [];
      return [
        {
          tag: element.tagName.toLowerCase(),
          text: (element.getAttribute('aria-label') || element.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        },
      ];
    });

    return {
      viewportWidth: window.innerWidth,
      scrollWidth: root.scrollWidth,
      controls,
      horizontalEscapes,
    };
  });

  assert(
    metrics.scrollWidth <= metrics.viewportWidth + 1,
    `${label} overflows horizontally: ${metrics.scrollWidth}px document in ${metrics.viewportWidth}px viewport`,
  );
  assert(
    metrics.horizontalEscapes.length === 0,
    `${label} has content outside the viewport: ${JSON.stringify(metrics.horizontalEscapes)}`,
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
      `${label} has form text below 16px: ${JSON.stringify(zoomingFields)}`,
    );
  }
}

async function assertPinnedJelly(page: Page, label: string) {
  await page.waitForFunction(() =>
    ['jelly-button', 'jelly-input', 'jelly-textarea', 'jelly-segmented'].every((tag) =>
      Boolean(customElements.get(tag)),
    ),
  );
  const scripts = await page
    .locator('script[src]')
    .evaluateAll((elements) => elements.map((element) => (element as HTMLScriptElement).src));
  assert(
    scripts.some((src) => src.includes('/vendor/jelly-ui/d898ec9/jelly.js')),
    `${label} did not load the pinned Jelly bundle`,
  );
  assert(
    scripts.every((src) => !src.includes('jelly-ui.com')),
    `${label} still loads Jelly from the remote runtime`,
  );
}

async function runAxe(page: Page, label: string) {
  const violations = await page.evaluate(async () => {
    const axeApi = (
      window as typeof window & {
        axe: {
          run: (
            root: Document,
            options: { resultTypes: string[] },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe;
    const results = await axeApi.run(document, { resultTypes: ['violations'] });
    return results.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.slice(0, 3).map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      }));
  });
  assert(
    violations.length === 0,
    `${label} has serious Axe violations: ${JSON.stringify(violations)}`,
  );
}

async function openRoute(
  page: Page,
  path: string,
  {
    accessibility = false,
    mobile,
    label,
  }: { accessibility?: boolean; mobile: boolean; label: string },
) {
  // Tear down the previous route document before the next direct navigation.
  // Some operational pages intentionally auto-refresh while work is active;
  // WebKit can otherwise let that old timer race the following page.goto().
  if (page.url() !== 'about:blank') {
    await page.goto('about:blank', { waitUntil: 'commit' });
  }
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  assert(response?.ok(), `${label} ${path} returned HTTP ${response?.status() ?? 'unknown'}`);
  assert(
    new URL(page.url()).origin === new URL(baseUrl).origin,
    `${label} ${path} unexpectedly left the smoke-test origin: ${page.url()}`,
  );
  await page.locator('main').waitFor();
  await page.waitForLoadState('networkidle');
  await assertPinnedJelly(page, `${label} ${path}`);
  await assertResponsiveContract(page, `${label} ${path}`, mobile);
  if (accessibility) await runAxe(page, `${label} ${path}`);
}

function routesFor(fixture: AuditFixture | undefined) {
  return [
    ...baseRoutes,
    ...(fixture ? [`/chat/${fixture.conversationId}`] : []),
    ...(fixture?.taskId ? [`/tasks/${fixture.taskId}`] : []),
    ...(fixture?.personId ? [`/profile/people/${fixture.personId}`] : []),
  ];
}

async function createAuditFixture(): Promise<AuditFixture | undefined> {
  if (!createFixture) return undefined;
  const db = createDb(databaseUrl);
  const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
  assert(agent, 'UI smoke requires the seeded assistant agent');
  const longToken = 'unbroken-ui-overflow-regression-'.repeat(10);
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: agent.id,
      channel: 'chat',
      trust: 'owner',
      title: `UI audit ${longToken}`,
    })
    .returning({ id: conversations.id });
  assert(conversation, 'failed to create the UI audit chat fixture');
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
  const [[task], [person]] = await Promise.all([
    db.select({ id: tasks.id }).from(tasks).limit(1),
    db.select({ id: contacts.id }).from(contacts).limit(1),
  ]);
  return {
    db,
    conversationId: conversation.id,
    taskId: task?.id,
    personId: person?.id,
  };
}

function wireErrorCapture(page: Page, label: string, errors: string[]) {
  page.on('pageerror', (error) => errors.push(`${label} page: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(baseUrl)) {
      errors.push(`${label} response: ${response.status()} ${response.url()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(`${label} console: ${message.text()}`);
    }
  });
}

async function exerciseMobileInteractions(
  page: Page,
  label: string,
  fixture: AuditFixture | undefined,
) {
  await openRoute(page, '/', { mobile: true, label });
  assert(
    new URL(page.url()).pathname === '/chat',
    `${label} root did not open the primary chat: ${page.url()}`,
  );
  assert(
    await page.getByRole('textbox', { name: 'Message' }).isVisible(),
    `${label} chat is not ready`,
  );

  const menuTrigger = page.getByRole('button', { name: 'Open navigation menu' });
  await targetSize(menuTrigger, `${label} mobile navigation trigger`);
  await menuTrigger.click();
  const drawer = page.locator('#mobile-nav[role="dialog"]');
  await drawer.waitFor({ state: 'visible' });
  assert(
    (await drawer.getAttribute('aria-modal')) === 'true',
    `${label} mobile drawer is not modal`,
  );
  assert(
    (await drawer.getAttribute('aria-labelledby')) === 'mobile-nav-title',
    `${label} mobile drawer is not visibly labelled`,
  );
  assert(
    (await page.evaluate(() => document.body.style.overflow)) === 'hidden',
    `${label} opening the mobile drawer did not lock background scrolling`,
  );
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
      'Close navigation menu',
    `${label} opening the mobile drawer did not move focus to close`,
  );
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
    `${label} Tab escaped the mobile drawer`,
  );
  const closeButton = drawer.getByRole('button', { name: 'Close navigation menu' });
  await targetSize(closeButton, `${label} mobile navigation close button`);
  await closeButton.click();
  await drawer.waitFor({ state: 'detached' });
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
      'Open navigation menu',
    `${label} closing the drawer did not restore trigger focus`,
  );

  await openRoute(page, '/tasks', { mobile: true, label });
  assert(
    (await page.locator('main table').count()) === 0,
    `${label} Activity regressed to a table`,
  );
  const tablist = page.getByRole('tablist', { name: 'Filter activity' });
  await tablist.waitFor();
  const allTab = tablist.getByRole('tab', { name: 'All', exact: true });
  await allTab.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForURL(
    (url) => url.pathname === '/tasks' && url.searchParams.get('filter') === 'needs-you',
  );
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/tasks' && url.search === '');
  await page.waitForFunction(
    () =>
      document
        .querySelector('jelly-segmented[roles="tablist"]')
        ?.shadowRoot?.querySelector('[role="tab"]')
        ?.getAttribute('aria-selected') === 'true',
  );
  assert(
    (await tablist.getByRole('tab', { name: 'All', exact: true }).getAttribute('aria-selected')) ===
      'true',
    `${label} browser Back did not restore the Activity tab state`,
  );

  await openRoute(page, '/profile/memories', { mobile: true, label });
  const search = page.getByRole('searchbox', { name: 'Search memories' });
  await search.fill('single form value');
  const submittedValues = await page
    .locator('.memory-search-form')
    .evaluate((form) => new FormData(form as HTMLFormElement).getAll('q').map(String));
  assert(
    submittedValues.length === 1 && submittedValues[0] === 'single form value',
    `${label} Jelly search submitted duplicate or stale values: ${JSON.stringify(submittedValues)}`,
  );
  await page.locator('.memory-search-form').evaluate((form) => (form as HTMLFormElement).reset());
  assert(
    (await search.inputValue()) === '',
    `${label} Jelly search did not follow native form reset semantics`,
  );

  if (fixture) {
    await openRoute(page, `/chat/${fixture.conversationId}`, { mobile: true, label });
    const message = page.getByRole('textbox', { name: 'Message' });
    const send = page.getByRole('button', { name: 'Send' });
    const composerSurface = page.getByTestId('chat-composer-surface');
    const autonomyMode = page.getByTestId('chat-autonomy-mode');
    await targetSize(message, `${label} chat message field`);
    await targetSize(send, `${label} chat send button`);
    await targetSize(autonomyMode, `${label} chat autonomy mode`);
    assert(
      (await composerSurface.locator('[data-testid="chat-autonomy-mode"]').count()) === 1,
      `${label} autonomy mode is not integrated into the composer`,
    );
    await message.fill('/model');
    const modelList = page.getByRole('listbox', { name: 'Response model' });
    await modelList.waitFor();
    await targetSize(modelList.getByRole('option').first(), `${label} slash-command model option`);
    await message.fill('A long mobile draft '.repeat(40));
    await assertResponsiveContract(page, `${label} populated chat composer`, true);
    const composer = await message.boundingBox();
    const viewport = page.viewportSize();
    assert(
      composer && viewport && composer.y + composer.height <= viewport.height,
      `${label} chat composer fell below the viewport`,
    );
  }
}

async function assertCompactLayout(page: Page, label: string) {
  await openRoute(page, '/documents', { mobile: true, label });
  const title = await page.getByRole('heading', { name: 'Documents', exact: true }).boundingBox();
  const action = await page.getByRole('link', { name: 'Import backstory' }).boundingBox();
  assert(title && action, `${label} Documents header controls are not visible`);
  const overlap =
    title.x < action.x + action.width &&
    title.x + title.width > action.x &&
    title.y < action.y + action.height &&
    title.y + title.height > action.y;
  assert(!overlap, `${label} Documents title and action overlap`);

  await openRoute(page, '/tasks', { mobile: true, label });
  const tabMetrics = await page.locator('.jelly-tabs-viewport').evaluate((element) => {
    const segmented = element.querySelector('jelly-segmented');
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      fontSize: segmented ? Number.parseFloat(getComputedStyle(segmented).fontSize) : 0,
    };
  });
  assert(
    tabMetrics.scrollWidth > tabMetrics.clientWidth,
    `${label} Activity tabs are not intentionally scrollable at 320px`,
  );
  assert(tabMetrics.fontSize >= 13, `${label} Activity tab text is below 13px`);

  await openRoute(page, '/profile/memories', { mobile: true, label });
  const field = await page.getByRole('searchbox', { name: 'Search memories' }).boundingBox();
  const button = await page.getByRole('button', { name: 'Search', exact: true }).boundingBox();
  assert(
    field && button && button.y >= field.y + field.height,
    `${label} Memory search did not stack`,
  );
}

async function assertDesktopNavigation(page: Page, label: string) {
  await openRoute(page, '/settings', { mobile: false, label });
  const settingsLabel = page.getByRole('link', { name: 'Settings' }).locator('span.nav-label');
  const systemLabel = page.getByRole('button', { name: 'System' }).locator('span.nav-label');
  const [settingsBox, systemBox] = await Promise.all([
    settingsLabel.boundingBox(),
    systemLabel.boundingBox(),
  ]);
  assert(settingsBox && systemBox, `${label} desktop navigation labels are not visible`);
  assert(
    Math.abs(settingsBox.x - systemBox.x) <= 1.5,
    `${label} System label is misaligned by ${Math.round(systemBox.x - settingsBox.x)}px`,
  );
}

async function assertNativeFallback(engineName: string, browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/vendor/jelly-ui/**', (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor();
  const fallbackInput = page.locator('input#agent-timezone.app-jelly-fallback');
  const fallbackSubmit = page.locator('button.app-jelly-fallback', {
    hasText: 'Save changes',
  });
  await fallbackInput.waitFor();
  await fallbackSubmit.waitFor();
  assert(
    await fallbackInput.isVisible(),
    `${engineName} did not render the native Jelly input fallback`,
  );
  assert(
    await fallbackSubmit.isVisible(),
    `${engineName} did not render the native Jelly button fallback`,
  );
  await context.close();
}

async function assertDelayedJellyUpgrade(engineName: string, browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let releaseJelly = () => {};
  const jellyGate = new Promise<void>((resolve) => {
    releaseJelly = resolve;
  });
  await context.route('**/vendor/jelly-ui/**', async (route) => {
    await jellyGate;
    await route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded' });
  const fallback = page.locator('input#agent-timezone.app-jelly-fallback');
  await fallback.waitFor();
  await page.waitForFunction(() =>
    Object.keys(document.querySelector('#agent-timezone') ?? {}).some((key) =>
      key.startsWith('__reactProps$'),
    ),
  );
  await fallback.fill('Pacific/Audit-Focus');
  await fallback.focus();
  releaseJelly();
  await page.waitForFunction(() => Boolean(customElements.get('jelly-input')));
  const upgraded = page.getByRole('textbox', { name: 'Timezone' });
  await upgraded.waitFor();
  assert(
    (await upgraded.inputValue()) === 'Pacific/Audit-Focus',
    `${engineName} lost a value typed before Jelly registration`,
  );
  const focus = await page.evaluate(() => ({
    host: document.activeElement?.tagName,
    inner: (document.activeElement as HTMLElement | null)?.shadowRoot?.activeElement?.tagName,
  }));
  assert(
    focus.host === 'JELLY-INPUT' && focus.inner === 'INPUT',
    `${engineName} lost focus during Jelly registration: ${JSON.stringify(focus)}`,
  );
  await context.close();
}

async function assertChatStreamingStates(engineName: string, browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const installChatMock = async (page: Page) => {
    // Install after hydration so Next's development fetch instrumentation
    // cannot replace the deterministic mock. A string avoids tsx/esbuild's
    // function-name helper leaking into Playwright's serialized callback.
    await page.evaluate(String.raw`
      (() => {
        window.__uiAuditFetchLog = [];
        const audit = (entry) => window.__uiAuditFetchLog.push(entry);
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const rawUrl =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const url = new URL(rawUrl, window.location.href);
          const requestBody = typeof init?.body === 'string' ? init.body : '';
          if (url.pathname !== '/api/chat' || init?.method !== 'POST') {
            return nativeFetch(input, init);
          }
          audit({ event: 'chat-request', requestBody });

          if (requestBody.includes('UI audit stop')) {
            audit({ event: 'stop-branch' });
            const encoder = new TextEncoder();
            const timers = [];
            const stream = new ReadableStream({
              start(controller) {
                const send = (chunk) =>
                  controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
                send({ type: 'start', messageId: 'ui-audit-stop-assistant' });
                send({ type: 'text-start', id: 'ui-audit-stop-text' });
                send({
                  type: 'text-delta',
                  id: 'ui-audit-stop-text',
                  delta: 'Streaming until stopped.',
                });
                const close = () => {
                  audit({ event: 'stop-close' });
                  for (const timer of timers) window.clearTimeout(timer);
                  try {
                    controller.close();
                  } catch {}
                };
                timers.push(window.setTimeout(close, 30_000));
                init.signal?.addEventListener(
                  'abort',
                  () => {
                    audit({ event: 'stop-abort' });
                    close();
                  },
                  { once: true },
                );
              },
              cancel() {
                for (const timer of timers) window.clearTimeout(timer);
              },
            });
            return new Response(stream, {
              headers: {
                'cache-control': 'no-cache',
                'content-type': 'text/event-stream',
                'x-vercel-ai-ui-message-stream': 'v1',
              },
            });
          }

          if (requestBody.includes('UI audit error')) {
            audit({ event: 'error-branch' });
            return new Response(JSON.stringify({ error: 'Deterministic UI audit error.' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
          }

          const chunks = [
            { type: 'start', messageId: 'ui-audit-assistant' },
            { type: 'text-start', id: 'ui-audit-text' },
            {
              type: 'text-delta',
              id: 'ui-audit-text',
              delta: 'Deterministic streamed response.',
            },
            { type: 'text-end', id: 'ui-audit-text' },
            { type: 'finish', finishReason: 'stop' },
          ];
          audit({ event: 'complete-branch' });
          const body =
            chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') +
            'data: [DONE]\n\n';
          return new Response(body, {
            headers: {
              'cache-control': 'no-cache',
              'content-type': 'text/event-stream',
              'x-vercel-ai-ui-message-stream': 'v1',
            },
          });
        };
      })()
    `);
  };
  const streamPage = await context.newPage();
  await streamPage.goto(`${baseUrl}/chat`, { waitUntil: 'networkidle' });
  await installChatMock(streamPage);
  await streamPage.getByRole('textbox', { name: 'Message' }).fill('UI audit streamed response');
  await streamPage.getByRole('button', { name: 'Send' }).click();
  await streamPage.getByText('Deterministic streamed response.', { exact: true }).waitFor();
  await streamPage.close();

  const stopPage = await context.newPage();
  await stopPage.goto(`${baseUrl}/chat`, { waitUntil: 'networkidle' });
  await installChatMock(stopPage);
  await stopPage.getByRole('textbox', { name: 'Message' }).fill('UI audit stop');
  await stopPage.getByRole('button', { name: 'Send' }).click();
  try {
    await stopPage
      .getByText('Streaming until stopped.', { exact: true })
      .waitFor({ timeout: 5_000 });
  } catch {
    const diagnostic = await stopPage.evaluate(() => ({
      bodyTail: document.body.innerText.slice(-1_200),
      buttons: [...document.querySelectorAll('button')].map((button) => ({
        disabled: button.disabled,
        label: button.getAttribute('aria-label'),
        text: button.innerText,
      })),
      customElements: {
        button: Boolean(customElements.get('jelly-button')),
        textarea: Boolean(customElements.get('jelly-textarea')),
      },
      fetchLog: (
        window as typeof window & {
          __uiAuditFetchLog?: Array<Record<string, unknown>>;
        }
      ).__uiAuditFetchLog,
    }));
    throw new Error(`${engineName} Stop stream did not render: ${JSON.stringify(diagnostic)}`);
  }
  const stop = stopPage.getByRole('button', { name: 'Stop', exact: true });
  await stop.waitFor();
  await targetSize(stop, `${engineName} chat stop button`);
  await stop.click();
  await stop.waitFor({ state: 'detached' });
  await stopPage.close();

  const errorPage = await context.newPage();
  await errorPage.goto(`${baseUrl}/chat`, { waitUntil: 'networkidle' });
  await installChatMock(errorPage);
  await errorPage.getByRole('textbox', { name: 'Message' }).fill('UI audit error');
  await errorPage.getByRole('button', { name: 'Send' }).click();
  await errorPage.getByText('Deterministic UI audit error.', { exact: true }).waitFor();
  const dismiss = errorPage.getByRole('button', { name: 'dismiss', exact: true });
  await dismiss.click();
  await errorPage.getByText('Deterministic UI audit error.', { exact: true }).waitFor({
    state: 'detached',
  });
  await context.close();
}

async function assertNotFoundStates(engineName: string, browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
  await context.addInitScript({ content: axe.source });
  const page = await context.newPage();
  const paths = [
    '/__ui_audit_not_found__',
    '/tasks/00000000-0000-0000-0000-000000000000',
    '/profile/people/00000000-0000-0000-0000-000000000000',
  ];
  for (const [index, path] of paths.entries()) {
    const response = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
    if (index === 0) {
      assert(response?.status() === 404, `${engineName} ${path} did not return 404`);
    }
    await page.getByRole('heading', { name: 'Not found' }).waitFor();
    await assertPinnedJelly(page, `${engineName} ${path}`);
    await assertResponsiveContract(page, `${engineName} ${path}`, true);
  }
  await runAxe(page, `${engineName} not-found state`);
  await context.close();
}

async function assertDarkAndReducedMotion(engineName: string, browser: Browser) {
  const darkContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  await darkContext.addInitScript({ content: axe.source });
  const darkPage = await darkContext.newPage();
  for (const route of ['/chat', '/tasks', '/settings']) {
    await openRoute(darkPage, route, {
      accessibility: route === '/settings',
      mobile: true,
      label: `${engineName} dark`,
    });
    assert(
      await darkPage.locator('html.dark').count(),
      `${engineName} ${route} did not honor dark mode`,
    );
  }
  await darkContext.close();

  const reducedContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const reducedPage = await reducedContext.newPage();
  await openRoute(reducedPage, '/tasks', {
    mobile: false,
    label: `${engineName} reduced motion`,
  });
  const runningAnimations = await reducedPage.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === 'running').length,
  );
  assert(
    runningAnimations === 0,
    `${engineName} reduced-motion Activity has ${runningAnimations} running animations`,
  );
  await reducedContext.close();
}

async function assertTextResize(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  for (const route of ['/documents', '/tasks', '/settings']) {
    await openRoute(page, route, { mobile: false, label: 'chromium 200% text' });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await assertResponsiveContract(page, `chromium 200% text ${route}`, false);
  }
  await context.close();
}

const errors: string[] = [];
const summaries: Array<{ browser: string; routes: number; viewports: number }> = [];
let fixture: AuditFixture | undefined;

try {
  assert(requestedBrowsers.length > 0, 'SMOKE_BROWSERS must contain chromium and/or webkit');
  fixture = await createAuditFixture();
  const routes = routesFor(fixture);

  for (const engineName of requestedBrowsers) {
    const browser =
      engineName === 'webkit'
        ? await webkit.launch({ headless: true })
        : await chromium.launch({
            headless: true,
            ...(browserPath
              ? { executablePath: browserPath }
              : { channel: browserChannel as 'chrome' | 'chromium' }),
          });
    try {
      await assertNativeFallback(engineName, browser);
      await assertDelayedJellyUpgrade(engineName, browser);
      // Streaming interceptors deserve a clean browser phase: they exercise
      // request cancellation, not accumulated navigation/cache state from the
      // route sweep that follows.
      await assertChatStreamingStates(engineName, browser);

      for (const viewport of viewports) {
        const mobile = viewport.width <= 639;
        const context: BrowserContext = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          hasTouch: mobile,
          isMobile: mobile,
        });
        await context.addInitScript({ content: axe.source });
        const page = await context.newPage();
        const label = `${engineName} ${viewport.label}`;
        wireErrorCapture(page, label, errors);

        for (const route of routes) {
          const accessibility =
            (viewport.width === 390 || viewport.width === 1440) &&
            ['/chat', '/tasks', '/documents', '/settings', '/costs'].includes(route);
          await openRoute(page, route, { accessibility, mobile, label });
        }

        if (viewport.width === 320) await assertCompactLayout(page, label);
        if (viewport.width === 390) await exerciseMobileInteractions(page, label, fixture);
        if (viewport.width === 1440) await assertDesktopNavigation(page, label);
        await context.close();
      }

      await assertNotFoundStates(engineName, browser);
      await assertDarkAndReducedMotion(engineName, browser);
      if (engineName === 'chromium') await assertTextResize(browser);
      summaries.push({ browser: engineName, routes: routes.length, viewports: viewports.length });
    } finally {
      await browser.close();
    }
  }

  assert(errors.length === 0, `browser errors were reported: ${errors.join(' | ')}`);
  console.log(
    JSON.stringify({
      ok: true,
      summaries,
      checks: [
        'all routes and dynamic details',
        '320px through 1440px reflow',
        'no unintended overflow or clipping',
        '44px mobile targets and 16px fields',
        'pinned Jelly runtime and native fallback',
        'single form values',
        'keyboard tabs and drawer focus trap',
        'dark mode and reduced motion',
        '200% text resize',
        'serious Axe violations',
      ],
    }),
  );
} finally {
  if (fixture) {
    await fixture.db.delete(messages).where(eq(messages.conversationId, fixture.conversationId));
    await fixture.db.delete(conversations).where(eq(conversations.id, fixture.conversationId));
    await (fixture.db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
}
