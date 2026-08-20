import { randomUUID } from 'node:crypto';
import { agents, conversations, createDb, type Db, messages } from '@assistant/db';
import { and, eq } from 'drizzle-orm';
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
  '/chat/all',
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

/**
 * Navigation lives in the composer's "/" palette and nowhere else. No page may
 * grow a menu control back, and every page that is not the main thread has to
 * offer a visible way home.
 */
async function assertNoMenuChrome(page: Page, label: string) {
  const triggers = await page.getByRole('button', { name: /navigation menu/i }).count();
  assert(triggers === 0, `${label} still renders a navigation menu trigger`);
}

async function assertBackLink(page: Page, label: string, expectedHref: string) {
  const back = page.locator(`main a[href="${expectedHref}"]`).first();
  // Wait rather than sample. A palette pick is a client-side navigation, so the
  // URL changes a render before the destination has any content — an immediate
  // isVisible() reads the outgoing page and fails on a slow runner.
  await back.waitFor({ state: 'visible' }).catch(() => {
    throw new Error(`${label} has no visible back link to ${expectedHref}`);
  });
  await targetSize(back, `${label} back link`);
}

async function assertStandaloneScreenRadius(page: Page) {
  // Chromium DevTools cannot emulate display-mode: standalone. Inspect the
  // browser-parsed CSSOM instead, which still proves the production stylesheet
  // contains a valid standalone rule and preserves the component radius token.
  const metrics = await page.evaluate(() => {
    let deviceFormula = '';
    let canvasRadius = '';
    let canvasClip = '';
    const pending = [...document.styleSheets].map((sheet) => ({
      rules: sheet.cssRules,
      standalone: false,
    }));

    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      for (const rule of current.rules) {
        const isStandaloneRule =
          rule instanceof CSSMediaRule && rule.conditionText.includes('display-mode: standalone');
        const insideStandalone = current.standalone || isStandaloneRule;

        if (insideStandalone && rule instanceof CSSStyleRule) {
          if (rule.selectorText === ':root') {
            deviceFormula = rule.style.getPropertyValue('--device-screen-radius').trim();
          }
          if (rule.selectorText === 'body') {
            canvasRadius = rule.style.borderRadius;
            canvasClip = rule.style.clipPath;
          }
        }

        if ('cssRules' in rule) {
          pending.push({
            rules: (rule as CSSGroupingRule).cssRules,
            standalone: insideStandalone,
          });
        }
      }
    }
    const root = getComputedStyle(document.documentElement);
    return {
      deviceFormula,
      canvasRadius,
      canvasClip,
      defaultDeviceRadius: root.getPropertyValue('--device-screen-radius').trim(),
      componentRadius: root.getPropertyValue('--radius-shell').trim(),
    };
  });
  assert(
    metrics.deviceFormula.includes('safe-area-inset-top') &&
      metrics.deviceFormula.includes('safe-area-inset-left'),
    `standalone radius is not derived from device safe areas: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.canvasRadius === 'var(--device-screen-radius)' &&
      metrics.canvasClip.includes('var(--device-screen-radius)'),
    `standalone canvas does not take the device radius: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.defaultDeviceRadius === '0px' && metrics.componentRadius === '1rem',
    `device radius leaked into component geometry: ${JSON.stringify(metrics)}`,
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
      // Quick replies stay visually compact but carry their missing touch area
      // in an absolutely positioned ::after extension (conversation.css).
      // Measure that intentional hit box instead of only the painted pill.
      const touchExtension = element.matches('.chip-quick-reply')
        ? getComputedStyle(element, '::after')
        : null;
      const extendedHeight = touchExtension
        ? rect.height +
          Math.max(0, -Number.parseFloat(touchExtension.top)) +
          Math.max(0, -Number.parseFloat(touchExtension.bottom))
        : rect.height;
      return [
        {
          tag: element.tagName.toLowerCase(),
          label: (element.getAttribute('aria-label') || element.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(extendedHeight),
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

/**
 * The status gradient may tint the island but no filtered layer may intersect
 * it. WebKit samples intersecting backdrop-filter siblings before their visual
 * z-order is resolved, which is what made the status label look frosted on an
 * installed iPhone even though the island had the higher z-index.
 */
async function assertDynamicIslandLayering(page: Page) {
  const metrics = await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('.status-overlay');
    const veil = document.querySelector<HTMLElement>('.status-veil');
    const lowerGlass = document.querySelector<HTMLElement>('.status-veil-glass');
    const island = document.querySelector<HTMLElement>('.notch-island');
    const crown = document.querySelector<HTMLElement>('.status-crown');
    const main = document.querySelector<HTMLElement>('main');
    if (!overlay || !veil || !island || !crown || !main) {
      return null;
    }
    const overlayRect = overlay.getBoundingClientRect();
    const lowerGlassRect = lowerGlass?.getBoundingClientRect();
    const islandRect = island.getBoundingClientRect();
    return {
      open: overlay.dataset.open === 'true',
      overlay: {
        left: overlayRect.left,
        right: overlayRect.right,
        top: overlayRect.top,
        bottom: overlayRect.bottom,
        zIndex: getComputedStyle(overlay).zIndex,
      },
      mainZ: Number.parseInt(getComputedStyle(main).zIndex, 10),
      veilFilter: getComputedStyle(veil).backdropFilter,
      veilBackground: getComputedStyle(veil).backgroundImage,
      lowerGlass:
        lowerGlass && lowerGlassRect
          ? {
              left: lowerGlassRect.left,
              right: lowerGlassRect.right,
              top: lowerGlassRect.top,
              bottom: lowerGlassRect.bottom,
              filter: getComputedStyle(lowerGlass).backdropFilter,
            }
          : null,
      island: {
        left: islandRect.left,
        right: islandRect.right,
        top: islandRect.top,
        bottom: islandRect.bottom,
        filter: getComputedStyle(island).backdropFilter,
      },
      filteredCrownChildren: [...crown.children].filter(
        (element) => getComputedStyle(element).backdropFilter !== 'none',
      ).length,
    };
  });
  assert(metrics, 'Dynamic Island layers are incomplete');
  assert(
    Number.parseInt(metrics.overlay.zIndex, 10) > metrics.mainZ,
    `Dynamic Island is not above app content: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.veilFilter === 'none' && metrics.island.filter === 'none',
    `a filtered layer covers the Dynamic Island: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.veilBackground.includes('0.62') || metrics.veilBackground.includes('62%'),
    `status gradient is not softly translucent at the top: ${metrics.veilBackground}`,
  );
  assert(
    metrics.filteredCrownChildren === 0,
    `the Dynamic Island crown contains filtered content: ${JSON.stringify(metrics)}`,
  );
  if (metrics.open) {
    assert(
      metrics.lowerGlass === null,
      `a backdrop-filter surface is mounted while the Dynamic Island is open: ${JSON.stringify(metrics)}`,
    );
  } else {
    assert(
      metrics.lowerGlass?.filter.includes('blur(6px)') &&
        metrics.lowerGlass.top >= metrics.island.bottom + 8,
      `the closed-state top glass is missing or inside the safety zone: ${JSON.stringify(metrics)}`,
    );
  }
}

async function openRoute(page: Page, path: string, mobile = true) {
  const response = await page.goto(`${baseUrl}${path}`, {
    waitUntil: 'domcontentloaded',
  });
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
  // This fixture stands for a *side* thread — a titled chat with a header and a
  // back link — which it only is if a main thread already exists. Opening /chat
  // promotes the most recently updated chat conversation when none is marked
  // primary, and on the empty database CI builds that would be this fixture:
  // it would render as the main thread, which correctly has neither. A
  // developer's populated database already has a primary and never noticed.
  const [primary] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, agent.id), eq(conversations.isPrimary, true)))
    .limit(1);
  if (!primary) {
    await db
      .insert(conversations)
      .values({ agentId: agent.id, channel: 'chat', trust: 'owner', isPrimary: true });
  }
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
  const installContract = await page.evaluate(async () => {
    const manifestHref = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href;
    const manifest = manifestHref
      ? ((await (await fetch(manifestHref)).json()) as {
          display?: string;
          start_url?: string;
          scope?: string;
          icons?: Array<{ sizes?: string; purpose?: string }>;
        })
      : null;
    return {
      viewport: document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content ?? null,
      mobileCapable:
        document.querySelector<HTMLMetaElement>('meta[name="mobile-web-app-capable"]')?.content ??
        null,
      appleCapable:
        document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-capable"]')
          ?.content ?? null,
      statusBar:
        document.querySelector<HTMLMetaElement>(
          'meta[name="apple-mobile-web-app-status-bar-style"]',
        )?.content ?? null,
      appleIcon: document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href,
      themeColors: [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
        ({ content, media }) => ({ content, media }),
      ),
      manifest,
    };
  });
  assert(
    installContract.viewport?.includes('viewport-fit=cover') &&
      installContract.viewport.includes('maximum-scale=1') &&
      installContract.viewport.includes('user-scalable=no'),
    `iOS viewport contract is incomplete: ${installContract.viewport}`,
  );
  assert(
    installContract.mobileCapable === 'yes' && installContract.appleCapable === 'yes',
    `standalone capability metadata is incomplete: ${JSON.stringify(installContract)}`,
  );
  assert(
    installContract.statusBar === 'black-translucent',
    `iOS status bar is not edge-to-edge: ${installContract.statusBar}`,
  );
  assert(installContract.appleIcon?.endsWith('/apple-icon.png'), 'Apple touch icon is missing');
  assert(installContract.themeColors.length === 2, 'light/dark browser theme colors are missing');
  assert(
    installContract.manifest?.display === 'standalone' &&
      installContract.manifest.start_url === '/chat' &&
      installContract.manifest.scope === '/' &&
      installContract.manifest.icons?.some(({ sizes }) => sizes === '192x192') &&
      installContract.manifest.icons.some(({ sizes }) => sizes === '512x512') &&
      installContract.manifest.icons.some(({ purpose }) => purpose === 'maskable'),
    `web app manifest is incomplete: ${JSON.stringify(installContract.manifest)}`,
  );
  await assertStandaloneScreenRadius(page);
  await assertDynamicIslandLayering(page);
  const primaryMessageField = page.getByRole('combobox', { name: 'Message' });
  await primaryMessageField.waitFor({ state: 'visible' });
  await assertNoMenuChrome(page, 'mobile chat');

  // Navigation is the "/" palette. A bare slash lists both what the composer
  // can do and everywhere the app can go, grouped, with the badge counts the
  // retired menu trigger used to carry.
  await primaryMessageField.fill('/');
  const commandPalette = page.getByRole('listbox', { name: 'Commands' });
  await commandPalette.waitFor();
  assert(
    (await primaryMessageField.getAttribute('aria-expanded')) === 'true',
    'the "/" palette is not exposed to assistive technology',
  );
  for (const group of ['This chat', 'Go to']) {
    assert(
      await commandPalette.getByRole('group', { name: group }).isVisible(),
      `the "/" palette is missing its "${group}" group`,
    );
  }
  const approvalsOption = commandPalette.getByRole('option', { name: /^\/approvals/ });
  await targetSize(approvalsOption, 'slash-command destination');
  await approvalsOption.click();
  await page.waitForURL(`${baseUrl}/approvals`);
  // With no menu anywhere, the back link is the whole way out of a subpage —
  // and waiting for it is also what proves the destination has actually
  // rendered, so the two checks below measure the new page and not the old one.
  await assertBackLink(page, '/approvals', '/chat');
  await assertResponsiveContract(page, '/approvals via "/"', true);
  await assertNoMenuChrome(page, '/approvals');

  await page.locator('main a[href="/chat"]').first().click();
  await page.waitForURL(`${baseUrl}/chat`);
  await page
    .getByRole('combobox', { name: 'Message' })
    .waitFor({ state: 'visible' })
    .catch(() => {
      throw new Error('the back link did not return to the chat');
    });

  // Typing narrows on the command or on an alias, so /tasks still finds
  // Activity even though the destination is spelled /activity.
  await page.getByRole('combobox', { name: 'Message' }).fill('/tasks');
  // Wait for the option the alias should resolve to before counting, so the
  // count reads a settled palette rather than whatever it was mid-filter.
  await commandPalette.getByRole('option', { name: /^\/activity/ }).waitFor({ state: 'visible' });
  assert(
    (await commandPalette.getByRole('option').count()) === 1,
    'aliases do not narrow the "/" palette to the destination they name',
  );
  await page.keyboard.press('Escape');

  for (const route of testedRoutes.slice(1)) {
    await openRoute(page, route);
    await assertNoMenuChrome(page, route);
  }
  for (const [route, parent] of [
    ['/approvals', '/chat'],
    ['/settings', '/chat'],
    ['/profile/memories', '/profile'],
    ['/import', '/documents'],
  ] as const) {
    await openRoute(page, route);
    await assertBackLink(page, route, parent);
  }
  await openRoute(page, '/tasks');
  assert((await page.locator('main table').count()) === 0, 'Activity regressed to a table');
  assert(
    await page.getByRole('navigation', { name: 'Filter activity' }).isVisible(),
    'Activity filters are missing',
  );

  if (fixture) {
    await openRoute(page, `/chat/${fixture.id}`);
    const message = page.getByRole('combobox', { name: 'Message' });
    const send = page.getByRole('button', { name: 'Send' });
    const composerSurface = page.getByTestId('chat-composer-surface');
    await targetSize(message, 'chat message field');
    await targetSize(send, 'chat send button');
    const glassContract = await composerSurface.evaluate((surface) => {
      const veil = document.querySelector<HTMLElement>('.composer-veil');
      const transcript = document.querySelector<HTMLElement>('[role="log"]');
      return {
        surfaceFilter: getComputedStyle(surface).backdropFilter,
        veilFilter: veil ? getComputedStyle(veil).backdropFilter : 'missing',
        transcriptMask: transcript ? getComputedStyle(transcript).maskImage : 'missing',
      };
    });
    assert(
      glassContract.surfaceFilter.includes('blur(7px)') &&
        glassContract.veilFilter === 'none' &&
        glassContract.transcriptMask !== 'none' &&
        glassContract.transcriptMask !== 'missing',
      `composer glass/fade contract regressed: ${JSON.stringify(glassContract)}`,
    );
    // A side thread is a subpage, so "All chats" is its back link now — one
    // quiet row above the title, not an action competing with it.
    await assertBackLink(page, `/chat/${fixture.id}`, '/chat/all');
    assert(
      (await page.getByRole('button', { name: 'Model', exact: true }).count()) === 0,
      'Model still occupies the chat header',
    );
    assert(
      (await composerSurface.locator('[data-testid="chat-autonomy-mode"]').count()) === 0,
      'autonomy still holds a permanent seat in the composer',
    );
    // One row: the field, then send on its right. No model chip — /model owns
    // that now — so a second control in this row is a regression.
    const composerRow = await composerSurface.evaluate((surface) => {
      const field = surface.querySelector('textarea')?.getBoundingClientRect();
      const send = surface.querySelector('button[type="submit"]')?.getBoundingClientRect();
      return {
        sameRow: Boolean(field && send && field.top < send.bottom && send.top < field.bottom),
        sendOnRight: Boolean(field && send && send.left >= field.right - 1),
        buttons: surface.querySelectorAll('button').length,
      };
    });
    assert(composerRow.sameRow, 'send is not on the same row as the message field');
    assert(composerRow.sendOnRight, 'send is not to the right of the message field');
    assert(
      composerRow.buttons === 1,
      `composer carries ${composerRow.buttons} controls, expected 1`,
    );
    await message.focus();
    const focusVisual = await composerSurface.evaluate((surface) => {
      const wrapper = surface.parentElement;
      return {
        radius: Number.parseFloat(getComputedStyle(surface).borderRadius),
        outlineStyle: getComputedStyle(surface).outlineStyle,
        surfaceTransform: getComputedStyle(surface).transform,
        // Both halves matter. A pseudo-element with no `content` generates no
        // box at all, and then `opacity` resolves to its initial 1 — reading
        // opacity alone would call "there is no glow layer" a glow.
        focusGlowContent: getComputedStyle(surface, '::after').content,
        focusGlowOpacity: getComputedStyle(surface, '::after').opacity,
        wrapperShadow: wrapper ? getComputedStyle(wrapper).boxShadow : 'missing',
        wrapperTransform: wrapper ? getComputedStyle(wrapper).transform : 'missing',
      };
    });
    assert(focusVisual.radius > 0, 'chat composer focus surface is not rounded');
    assert(focusVisual.outlineStyle === 'none', 'chat composer has a second focus outline');
    assert(focusVisual.surfaceTransform === 'none', 'chat composer moves while focused');
    // No second glow: either the layer paints nothing, or there is no layer.
    assert(
      focusVisual.focusGlowContent === 'none' || focusVisual.focusGlowOpacity === '0',
      `chat composer has a second focus glow: ${JSON.stringify(focusVisual)}`,
    );
    assert(
      focusVisual.wrapperShadow === 'none' && focusVisual.wrapperTransform === 'none',
      `chat composer has a second outer focus treatment: ${JSON.stringify(focusVisual)}`,
    );
    // Autonomy is a slash command now. Picking it arms the turn, hands the
    // composer back empty, and says so in a notice above the field.
    await message.fill('/auto');
    const commandList = page.getByRole('listbox', { name: 'Commands' });
    await commandList.waitFor();
    await commandList.getByRole('option').first().click();
    const autonomyNotice = page.getByTestId('chat-autonomy-mode');
    await autonomyNotice.waitFor({ state: 'visible' });
    await targetSize(autonomyNotice, 'autonomy cancel control');
    assert((await message.inputValue()) === '', '/auto left its token in the composer');
    await autonomyNotice.click();
    await autonomyNotice.waitFor({ state: 'detached' });

    await message.fill('/model');
    assert((await message.getAttribute('aria-expanded')) === 'true', 'model picker is not exposed');
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
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const route of testedRoutes) {
      await openRoute(page, route, false);
    }
    assert(
      (await page.locator('main').count()) === 1,
      `${viewport.label} shell did not render exactly one main region`,
    );
    // The palette replaces the menu at every width, not just on a phone.
    await assertNoMenuChrome(page, viewport.label);
    assert(
      (await page.locator('.nav-launcher').count()) === 0,
      `${viewport.label} shell still rendered the retired left navigation launcher`,
    );
  }

  if (fixture) {
    // The desktop composer is the phone's: one row, one control. /model is the
    // only way in to the picker, so there is no draft to keep safe through it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRoute(page, `/chat/${fixture.id}`, false);
    const message = page.getByRole('combobox', { name: 'Message' });
    assert(
      (await page.getByRole('button', { name: /^Response model:/ }).count()) === 0,
      'the composer still carries a model control',
    );
    await message.fill('/model');
    const modelList = page.getByRole('listbox', { name: 'Response model' });
    await modelList.waitFor();
    await modelList.getByRole('option').first().click();
    await modelList.waitFor({ state: 'detached' });
    assert((await message.inputValue()) === '', 'the picker left its token in the composer');
  }

  assert(errors.length === 0, `browser errors were reported: ${errors.join(' | ')}`);
  console.log(
    JSON.stringify({
      ok: true,
      viewports: ['390x844', '768x900', '1440x900'],
      routes: testedRoutes.length * 3 + (fixture ? 2 : 0),
      checks: [
        'no horizontal overflow',
        '44px mobile targets',
        '16px mobile fields',
        'iOS standalone metadata and install icons',
        'device-mapped standalone screen radius',
        'Dynamic Island above content and physically clear of backdrop blur',
        'no navigation menu chrome at any viewport',
        'slash-command navigation, grouped and badged',
        'slash-command aliases (/tasks finds Activity)',
        'a back link out of every subpage',
        'root opens the primary chat',
        'activity feed and filters',
        'single rounded composer focus treatment',
        'one-row composer carrying only send, at every viewport',
        'slash-command autonomy (/auto) arms and cancels',
        'slash-command model switching (/model)',
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
