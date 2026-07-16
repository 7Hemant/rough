import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FieldConfig } from '../field-config/field-config.schema';
import { TestCase } from '../test-cases/test-case.schema';
import { ExecutionProgressGateway, LogEntry } from './execution-progress.gateway';
import { HtmlReportService } from './html-report.service';
import * as path from 'path';
import * as fs from 'fs';

const ARTIFACTS_DIR = path.join(process.cwd(), 'artifacts', 'live');

/**
 * Execution logger — collects logs and emits them in real-time via WebSocket.
 * Emits to both runId and projectId rooms so frontend can subscribe with either.
 */
class ExecutionLogger {
  private logs: LogEntry[] = [];
  private startTime = Date.now();

  constructor(
    private runId: string,
    private gateway?: ExecutionProgressGateway,
    private projectId?: string,
  ) {}

  log(step: number, level: LogEntry['level'], message: string, opts?: { selector?: string; details?: string; duration?: number }) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      step,
      level,
      message,
      selector: opts?.selector,
      details: opts?.details,
      duration: opts?.duration,
    };
    this.logs.push(entry);
    // Emit to runId room
    this.gateway?.emitLog(this.runId, entry);
    // Also emit to projectId room (frontend may subscribe with projectId)
    if (this.projectId && this.projectId !== this.runId) {
      this.gateway?.emitLog(this.projectId, entry);
    }
  }

  info(step: number, message: string, opts?: { selector?: string; details?: string }) {
    this.log(step, 'info', message, opts);
  }

  wait(step: number, message: string, opts?: { selector?: string; details?: string }) {
    this.log(step, 'wait', message, opts);
  }

  action(step: number, message: string, opts?: { selector?: string; details?: string; duration?: number }) {
    this.log(step, 'action', message, opts);
  }

  success(step: number, message: string, opts?: { duration?: number; details?: string }) {
    this.log(step, 'success', message, opts);
  }

  error(step: number, message: string, opts?: { selector?: string; details?: string }) {
    this.log(step, 'error', message, opts);
  }

  warn(step: number, message: string, opts?: { details?: string }) {
    this.log(step, 'warn', message, opts);
  }

  getElapsed(): number {
    return Date.now() - this.startTime;
  }

  getAllLogs(): LogEntry[] {
    return this.logs;
  }
}

function formatError(msg: string): string {
  if (!msg) return 'Unknown error';
  if (msg.includes('Timeout')) return 'Element not found or not clickable. The page may not have loaded correctly.';
  if (msg.includes('net::ERR')) return 'Page failed to load. Check URL and network.';
  if (msg.includes('strict mode violation')) return 'Multiple matching elements — selector is ambiguous. Update in Field Manager.';
  if (msg.includes('selectOption')) return 'Dropdown option not found. Check the value matches available options.';
  if (msg.includes('fill')) return 'Could not fill field. It may be disabled or hidden.';
  return msg.split('\n')[0].slice(0, 150);
}

/**
 * Smart wait: waits for page to become stable (no pending network requests, DOM settled).
 * This replaces hardcoded waitForTimeout calls with dynamic readiness detection.
 */
async function waitForPageStable(page: any, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 15000;
  try {
    // Wait for network to be idle (no inflight requests for 500ms)
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  } catch {}
  try {
    // Ensure DOM content is fully parsed
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
  } catch {}
}

/**
 * Resolve the Page object from a ctx that may be either a Page or a Frame.
 * Frames expose .page(); Pages don't.
 */
function pageOf(ctx: any, fallbackPage: any): any {
  try {
    if (typeof ctx.page === 'function') return ctx.page();
  } catch {}
  return fallbackPage || ctx;
}

/**
 * Smart element wait: waits for element to be visible AND stable (not animating/moving).
 * Uses Playwright's actionability checks rather than a fixed timeout.
 */
async function waitForElementReady(ctx: any, selector: string, opts?: { timeout?: number; state?: 'visible' | 'attached' }) {
  const timeout = opts?.timeout || 20000;
  const state = opts?.state || 'visible';

  // Wait for element to appear in the DOM and become visible
  await ctx.waitForSelector(selector, { state, timeout });

  // Additional stability check: ensure element is not in a transition/animation
  try {
    await ctx.locator(selector).first().waitFor({ state: 'visible', timeout: 3000 });
  } catch {}
}

/**
 * Smart click: waits for element to be clickable (visible, enabled, stable) then clicks.
 * Handles post-click navigation/loading automatically.
 */
async function smartClick(ctx: any, page: any, selector: string, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 20000;

  // Wait for element to be visible and stable
  await waitForElementReady(ctx, selector, { timeout });

  // Perform click with Playwright's built-in actionability checks
  // (auto-waits for element to be visible, enabled, and not obscured)
  await ctx.click(selector, { timeout });

  // After click, wait for page to settle (navigation, AJAX, re-renders)
  await waitForPageStable(page, { timeout: 10000 });
}

/**
 * Smart fill: waits for input to be ready then fills.
 *
 * Handles legacy/enterprise stacks:
 *  - Bootstrap datepicker inputs are frequently `readonly` (typing is blocked and
 *    Playwright's fill() throws "element is not editable"). We detect that, set the
 *    value directly, and fire input/change/blur so the widget (and jQuery validation)
 *    picks it up, then close the calendar popup with Escape.
 *  - jQuery-driven widgets that only react to `$(el).trigger('change')`.
 */
async function smartFill(ctx: any, selector: string, value: string, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 20000;

  // Wait for the element to at least exist in the DOM
  await ctx.waitForSelector(selector, { state: 'attached', timeout });
  const locator = ctx.locator(selector).first();

  // Bootstrap datepickers are commonly readonly — plain fill() would fail
  const isReadonly = await locator
    .evaluate((el: any) => el.hasAttribute('readonly') || el.readOnly === true)
    .catch(() => false);

  if (!isReadonly) {
    try {
      await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 8000) });
      await locator.fill(value, { timeout: Math.min(timeout, 8000) });
      // Notify jQuery-based widgets/validation that the value changed
      await locator.evaluate((el: any) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const jq = (window as any).jQuery;
        if (jq) { try { jq(el).trigger('change').trigger('blur'); } catch {} }
      });
      // A datepicker popup often opens on focus — dismiss it so it doesn't block later steps
      try { await locator.press('Escape'); } catch {}
      return;
    } catch {
      // fall through to JS-based assignment (readonly toggled at runtime, masked input, etc.)
    }
  }

  // Readonly input (datepicker) or fill() failed → assign value via JS and drive the widget
  await locator.evaluate((el: any, val: string) => {
    const wasReadonly = el.hasAttribute('readonly');
    if (wasReadonly) el.removeAttribute('readonly');
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const jq = (window as any).jQuery;
    if (jq) { try { jq(el).val(val).trigger('change').trigger('blur'); } catch {} }
    if (wasReadonly) el.setAttribute('readonly', 'readonly');
  }, value);
  try { await locator.press('Escape'); } catch {}
}

/**
 * Smart select: selects an option in a dropdown.
 *
 * Supports four cases:
 *  1. Plain native <select> — uses Playwright's selectOption (by label, then value).
 *  2. Enhanced select (Select2 / Chosen / bootstrap-select) — the real <select> is
 *     hidden (display:none), so selectOption would time out waiting for visibility.
 *     We set the value on the underlying element and trigger jQuery `change` so the
 *     widget re-renders its visible label.
 *  2b. bootstrap-select (selectpicker) UI fallback — if setting the value directly
 *     failed (option not present yet, AJAX-loaded options, text mismatch), we drive
 *     the widget through its UI: click the .dropdown-toggle button in the
 *     .bootstrap-select wrapper, type into the live-search box (.bs-searchbox input),
 *     and click the matching option (li a).
 *  3. Fully custom dropdown — opens the widget, types into its search box if present,
 *     and clicks the option whose text matches.
 */
async function smartSelect(ctx: any, page: any, selector: string, value: string, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 20000;
  const pg = pageOf(ctx, page);

  await ctx.waitForSelector(selector, { state: 'attached', timeout });
  const locator = ctx.locator(selector).first();

  const tagName = await locator.evaluate((el: any) => el.tagName.toLowerCase()).catch(() => '');

  if (tagName === 'select') {
    const isVisible = await locator.isVisible().catch(() => false);

    // Case 1: plain visible native select
    if (isVisible) {
      try { await locator.selectOption({ label: value }, { timeout: Math.min(timeout, 8000) }); return; } catch {}
      try { await locator.selectOption(value, { timeout: Math.min(timeout, 8000) }); return; } catch {}
    }

    // Case 2: enhanced select whose native element is hidden (Select2 / Chosen / selectpicker).
    // Match the option by value OR visible text (recorder stores the visible text),
    // set it on the real <select>, then notify BOTH native and jQuery listeners AND
    // call each widget's refresh API so its visible label updates. Cascading dropdowns
    // (State → City) rely on the change handler firing, so this also triggers AJAX loads.
    const applied = await locator.evaluate((el: any, val: string) => {
      const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(val);
      const options = Array.from(el.options) as any[];
      const match =
        options.find((o) => o.value === val) ||
        options.find((o) => norm(o.textContent) === target) ||
        options.find((o) => norm(o.textContent).includes(target) && target.length > 0);
      if (!match) return false;

      el.value = match.value;
      match.selected = true;

      // Native listeners
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      const jq = (window as any).jQuery || (window as any).$;
      if (jq) {
        try {
          const $el = jq(el);
          $el.val(match.value);
          // jQuery change (Select2 v4 + app cascade handlers listen here)
          $el.trigger('change');
          // Select2-specific namespaced event (some versions/configs require it)
          try { $el.trigger('change.select2'); } catch {}
          // bootstrap-select: refresh the rendered button text
          if (typeof $el.selectpicker === 'function') {
            try { $el.selectpicker('refresh'); } catch {}
          }
          // Chosen: notify it to re-render
          try { $el.trigger('chosen:updated'); } catch {}
        } catch {}
      }
      return true;
    }, value);
    if (applied) {
      // FIX: cascading dropdowns (State → City) fire AJAX in the change handler.
      // A fixed 300ms was often too short, leaving the next dropdown empty.
      // Wait for the network to actually go idle (bounded to 8s).
      try { await pg.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      return;
    }

    // Case 2b (FIX): bootstrap-select UI drive. The option wasn't found in the
    // native <select> (options may load only when the dropdown opens, or the
    // recorded text differs slightly) — so operate the widget the way a user does:
    // open the toggle button, type in the live-search box, click the option.
    const bsWrapper = locator.locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " bootstrap-select ")][1]',
    );
    if (await bsWrapper.count().catch(() => 0)) {
      try {
        // Open the dropdown
        await bsWrapper.locator('button.dropdown-toggle').first().click({ timeout: 5000 });

        // Type in the live-search box if the select uses data-live-search
        const search = bsWrapper.locator('.bs-searchbox input').first();
        if (await search.count().catch(() => 0)) {
          try {
            await search.fill(value, { timeout: 3000 });
            // Let live-search filter the option list
            await pg.waitForTimeout(400);
          } catch {}
        }

        // Bootstrap 4/5 open menu: .dropdown-menu.show — Bootstrap 3: .bootstrap-select.open
        // Try EXACT text match first so "Delhi" doesn't accidentally click "New Delhi",
        // then fall back to substring match.
        const bsOptionSelectors = [
          `.bootstrap-select .dropdown-menu.show li a:text-is("${value}")`,
          `.bootstrap-select.open .dropdown-menu li a:text-is("${value}")`,
          `.bootstrap-select .dropdown-menu.show li a:has-text("${value}")`,
          `.bootstrap-select.open .dropdown-menu li a:has-text("${value}")`,
        ];
        for (const optSel of bsOptionSelectors) {
          const opt = ctx.locator(optSel).first();
          if (await opt.count().catch(() => 0)) {
            await opt.click({ timeout: 4000 });
            // Wait for cascade AJAX triggered by the selection
            try { await pg.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
            return;
          }
        }

        // Nothing matched — close the open menu so it doesn't block later steps
        try { await pg.keyboard.press('Escape'); } catch {}
      } catch {}
    }
  }

  // Case 3: custom dropdown widget → open it, search, and click the matching option
  try { await locator.click({ timeout: Math.min(timeout, 6000) }); } catch {}

  // Some searchable widgets render their search box only after opening
  const searchBox = ctx
    .locator('.select2-search__field, .bs-searchbox input, .chosen-search input, .dropdown-menu.show input[type="search"]')
    .first();
  if (await searchBox.count().catch(() => 0)) {
    try {
      await searchBox.fill(value, { timeout: 3000 });
      try { await pg.waitForTimeout(400); } catch {}
    } catch {}
  }

  const optionSelectors = [
    `.select2-results__option:has-text("${value}")`,
    `.chosen-results li:has-text("${value}")`,
    // FIX: bootstrap-select option markup (li > a), exact match first
    `.bootstrap-select .dropdown-menu li a:text-is("${value}")`,
    `.bootstrap-select .dropdown-menu li a:has-text("${value}")`,
    `.dropdown-menu.show li:has-text("${value}")`,
    `[role="option"]:has-text("${value}")`,
  ];
  for (const optSel of optionSelectors) {
    const opt = ctx.locator(optSel).first();
    if (await opt.count().catch(() => 0)) {
      try {
        await opt.click({ timeout: 4000 });
        try { await pg.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
        return;
      } catch {}
    }
  }

  // Last resort: let Playwright's selectOption surface a clear, actionable error
  await ctx.selectOption(selector, value, { timeout });
}

/**
 * Smart navigation: navigates and waits for page to be fully ready.
 */
async function smartNavigate(page: any, url: string, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 30000;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await waitForPageStable(page, { timeout });
}

/**
 * Find the correct frame/page context where a selector exists.
 * Enterprise apps often use iframes for content areas after login.
 */
async function getContextForSelector(page: any, selector: string, xpath?: string): Promise<any> {
  // First check main page with CSS selector
  try {
    const el = await page.$(selector);
    if (el) return page;
  } catch {}

  // Try XPath on main page
  if (xpath) {
    try {
      const el = await page.$(`xpath=${xpath}`);
      if (el) return page;
    } catch {}
  }

  // Check all frames with CSS selector
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const el = await frame.$(selector);
      if (el) return frame;
    } catch {}
  }

  // Check all frames with XPath
  if (xpath) {
    for (const frame of frames) {
      try {
        const el = await frame.$(`xpath=${xpath}`);
        if (el) return frame;
      } catch {}
    }
  }

  // Return main page as fallback (will trigger normal timeout error)
  return page;
}

/**
 * Resolve the working locator for a field — tries CSS selector first, falls back to XPath.
 * Falls back to XPath when:
 *  1. CSS selector finds zero elements (not found)
 *  2. CSS selector finds multiple elements (ambiguous/not unique)
 * Returns the selector string that Playwright should use.
 */
async function resolveSelector(ctx: any, selector: string, xpath?: string): Promise<string> {
  // Try CSS selector first
  try {
    const elements = await ctx.$$(selector);
    // If exactly one match, CSS selector is good
    if (elements.length === 1) return selector;

    // If zero or multiple matches, fall back to XPath
    if (xpath) {
      try {
        const xpathElements = await ctx.$$(`xpath=${xpath}`);
        if (xpathElements.length === 1) return `xpath=${xpath}`;
      } catch {}
    }

    // If CSS found multiple but XPath also failed, still return CSS (will trigger strict mode error with clear message)
    if (elements.length > 0) return selector;
  } catch {}

  // CSS selector threw an error (invalid selector syntax etc.) — try XPath
  if (xpath) {
    try {
      const el = await ctx.$(`xpath=${xpath}`);
      if (el) return `xpath=${xpath}`;
    } catch {}
  }

  // Return original selector as last resort (will trigger proper timeout error)
  return selector;
}

@Injectable()
export class DynamicStepService {
  constructor(
    @InjectModel(FieldConfig.name) private fieldModel: Model<FieldConfig>,
    @InjectModel(TestCase.name) private testCaseModel: Model<TestCase>,
    @Optional() private progressGateway?: ExecutionProgressGateway,
    @Optional() private htmlReportService?: HtmlReportService,
  ) {}

  /**
   * Build steps from field configs and execute them with Playwright
   * No manual selectors needed — everything comes from FieldConfig DB
   */
  async executeWithDynamicFields(opts: {
    projectId: string;
    scriptId?: string;
    url: string;
    testData: Record<string, string>;
    credentials?: { username: string; password: string };
    runId?: string;
    headless?: boolean;
    screenshotMode?: 'all' | 'final' | 'none';
    executionTarget?: 'local' | 'server';
    serverWsEndpoint?: string;
    shouldAbort?: () => boolean;
    shouldPause?: () => boolean;
  }) {
    const fieldFilter: any = {
      projectId: new Types.ObjectId(opts.projectId),
      isActive: true,
      isSkipped: false,
    };

    // If a specific scriptId is provided, only run that script's fields
    if (opts.scriptId) {
      fieldFilter.scriptId = new Types.ObjectId(opts.scriptId);
    }

    const fields = await this.fieldModel.find(fieldFilter).sort({ order: 1 }).lean();

    const { chromium } = await import('playwright');
    const isHeadless = opts.headless ?? (process.env.HEADLESS === 'true');

    const runId = opts.runId || Date.now().toString();
    const logger = new ExecutionLogger(runId, this.progressGateway, opts.projectId);

    logger.info(0, `Starting execution: ${fields.length} steps to execute`);

    // Launch browser: local or connect to remote Playwright server
    let browser: any;
    if (opts.executionTarget === 'server' && opts.serverWsEndpoint) {
      logger.info(0, `Connecting to remote browser server: ${opts.serverWsEndpoint}`);
      browser = await chromium.connect(opts.serverWsEndpoint);
    } else {
      logger.info(0, `Browser: Chromium (local) | Headless: ${isHeadless} | URL: ${opts.url}`);
      browser = await chromium.launch({ headless: isHeadless, args: ['--no-sandbox', '--start-maximized'] });
    }

    const context = await browser.newContext({ viewport: isHeadless ? { width: 1280, height: 720 } : null });
    const page = await context.newPage();

    logger.info(0, 'Browser launched successfully');

    const runDir = path.join(ARTIFACTS_DIR, `dynamic_${runId}`);
    const ssMode = opts.screenshotMode || 'all';
    if (ssMode !== 'none') {
      fs.mkdirSync(runDir, { recursive: true });
    }

    const results: { step: number; field: string; action: string; status: string; screenshot?: string; error?: string; capturedValue?: string }[] = [];
    const capturedVars: Record<string, string> = {};
    let stepNum = 0;

    try {
      // Navigate to start URL with smart wait
      logger.wait(1, `Navigating to ${opts.url}`, { details: 'Waiting for page DOM + network idle' });
      const navStart = Date.now();
      await smartNavigate(page, opts.url, { timeout: 30000 });
      stepNum++;
      logger.success(stepNum, `Page loaded successfully`, { duration: Date.now() - navStart });

      if (ssMode === 'all') {
        const ssPath = path.join(runDir, `step_${stepNum}.png`);
        await page.screenshot({ path: ssPath });
        results.push({ step: stepNum, field: 'Navigation', action: `goto ${opts.url}`, status: 'PASSED', screenshot: `/api/live-test/screenshot/dynamic_${runId}/step_${stepNum}.png` });
      } else {
        results.push({ step: stepNum, field: 'Navigation', action: `goto ${opts.url}`, status: 'PASSED' });
      }

      // Login if credentials
      if (opts.credentials) {
        logger.info(stepNum + 1, 'Attempting login with provided credentials');
        logger.wait(stepNum + 1, 'Waiting for login form to appear');
        // Wait for login form to be ready (dynamic wait for input fields)
        const userSelectors = ['input[type="email"]', 'input[type="text"]', 'input[name*="user"]', 'input[id*="user"]', 'input[id*="User"]'];
        let userInput: any = null;
        for (const sel of userSelectors) {
          try {
            await page.waitForSelector(sel, { state: 'visible', timeout: 5000 });
            userInput = await page.$(sel);
            if (userInput) break;
          } catch {}
        }
        const passInput = await page.$('input[type="password"]');
        if (userInput) {
          await userInput.fill(opts.credentials.username);
        }
        if (passInput) {
          await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 5000 });
          await passInput.fill(opts.credentials.password);
        }
        const submit = await page.$('button[type="submit"], input[type="submit"], button:has-text("Login"), input[value*="Login"]');
        if (submit) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
            submit.click(),
          ]);
        }
        // Wait for post-login page to become stable (dynamic, not hardcoded)
        logger.wait(stepNum + 1, 'Waiting for post-login page to stabilize');
        const loginStart = Date.now();
        await waitForPageStable(page, { timeout: 20000 });
        stepNum++;
        logger.success(stepNum, 'Login completed successfully', { duration: Date.now() - loginStart });
        if (ssMode === 'all') {
          await page.screenshot({ path: path.join(runDir, `step_${stepNum}.png`) });
          results.push({ step: stepNum, field: 'Login', action: 'authenticate', status: 'PASSED', screenshot: `/api/live-test/screenshot/dynamic_${runId}/step_${stepNum}.png` });
        } else {
          results.push({ step: stepNum, field: 'Login', action: 'authenticate', status: 'PASSED' });
        }
      }

      // Execute each field config as a step
      for (const field of fields) {
        // Check abort signal before each step
        if (opts.shouldAbort?.()) {
          logger.warn(stepNum + 1, 'Execution terminated by user');
          const remaining = fields.length - results.length;
          for (let i = 0; i < remaining; i++) {
            results.push({ step: stepNum + 1 + i, field: 'TERMINATED', action: 'Terminated by user', status: 'SKIPPED' });
          }
          break;
        }

        // Check pause signal — hold until resumed or terminated
        if (opts.shouldPause?.()) {
          logger.info(stepNum + 1, 'Execution paused by user — waiting for resume...');
          while (opts.shouldPause?.()) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (opts.shouldAbort?.()) break;
          }
          // After resume, re-check abort
          if (opts.shouldAbort?.()) {
            logger.warn(stepNum + 1, 'Execution terminated by user (while paused)');
            const remaining = fields.length - results.length;
            for (let i = 0; i < remaining; i++) {
              results.push({ step: stepNum + 1 + i, field: 'TERMINATED', action: 'Terminated by user', status: 'SKIPPED' });
            }
            break;
          }
          logger.info(stepNum + 1, 'Execution resumed');
        }

        stepNum++;
        const stepStart = Date.now();

        // Skip login-related fields when credentials were already used to authenticate
        if (opts.credentials && this.isLoginField(field)) {
          logger.warn(stepNum, `Skipping "${field.label}" — already authenticated via credentials`);
          results.push({ step: stepNum, field: field.label, action: `SKIPPED (already authenticated via credentials)`, status: 'SKIPPED' });
          continue;
        }

        // Check conditions
        if (field.conditions?.length) {
          const condMet = field.conditions.every((c) => capturedVars[c.ref] === c.equals);
          if (!condMet) {
            logger.warn(stepNum, `Skipping "${field.label}" — condition not met: ${field.conditions[0].ref}=${field.conditions[0].equals}`);
            results.push({ step: stepNum, field: field.label, action: `SKIPPED (condition: ${field.conditions[0].ref}=${field.conditions[0].equals})`, status: 'SKIPPED' });
            continue;
          }
        }

        logger.info(stepNum, `Step ${stepNum}/${fields.length + 1}: ${field.actionType} → "${field.label}"`, { selector: field.selector });

        // Resolve value from testData or defaultValue
        let value = opts.testData[field.fieldName] || field.defaultValue || '';
        // Replace captured variables {{varName}}
        for (const [k, v] of Object.entries(capturedVars)) {
          value = value.replace(`{{${k}}}`, v);
        }

        try {
          // Determine the effective selector: prefer CSS, fall back to XPath
          const cssSelector = field.selector || null;
          const xpathSelector = (field as any).xpath || null;
          const effectiveSelector = cssSelector || (xpathSelector ? `xpath=${xpathSelector}` : null);

          // Find the correct context (main page or iframe) for this selector
          logger.wait(stepNum, `Locating element context (checking main page + iframes)`, { selector: effectiveSelector || 'none' });
          const ctx = effectiveSelector ? await getContextForSelector(page, cssSelector || `xpath=${xpathSelector}`, xpathSelector) : page;
          // Resolve the best working selector (CSS or XPath fallback)
          const sel = effectiveSelector ? await resolveSelector(ctx, cssSelector || `xpath=${xpathSelector}`, xpathSelector) : null;

          if (sel && sel !== effectiveSelector) {
            logger.info(stepNum, `Selector fallback: using XPath instead of CSS`, { selector: sel });
          }

          // Guard: actions that require a selector should fail clearly if none is available
          const needsSelector = !['wait', 'goto', 'press', 'screenshot'].includes(field.actionType);
          if (needsSelector && !sel) {
            throw new Error(`No selector (CSS or XPath) configured for field "${field.label}"`);
          }

          // After the guard, sel is guaranteed non-null for actions that need it
          const resolvedSel = sel as string;

          switch (field.actionType) {
            case 'fill':
              logger.wait(stepNum, `Waiting for input "${field.label}" to be visible & editable`, { selector: resolvedSel });
              await smartFill(ctx, resolvedSel, value, { timeout: 20000 });
              logger.action(stepNum, `Filled "${field.label}" with value: "${value.slice(0, 50)}${value.length > 50 ? '...' : ''}"`, { selector: resolvedSel });
              break;
            case 'click':
              logger.wait(stepNum, `Waiting for "${field.label}" to be visible & clickable`, { selector: resolvedSel });
              await smartClick(ctx, page, resolvedSel, { timeout: 20000 });
              logger.action(stepNum, `Clicked "${field.label}" — waiting for page to settle`, { selector: resolvedSel });
              break;
            case 'select':
              logger.wait(stepNum, `Waiting for dropdown "${field.label}" to be visible`, { selector: resolvedSel });
              await smartSelect(ctx, page, resolvedSel, value, { timeout: 20000 });
              logger.action(stepNum, `Selected option "${value}" in "${field.label}"`, { selector: resolvedSel });
              break;
            case 'check':
              logger.wait(stepNum, `Waiting for checkbox "${field.label}" to be visible`, { selector: resolvedSel });
              await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              await ctx.check(resolvedSel, { timeout: 10000 });
              logger.action(stepNum, `Checked "${field.label}"`, { selector: resolvedSel });
              break;
            case 'hover':
              logger.wait(stepNum, `Waiting for "${field.label}" to be visible for hover`, { selector: resolvedSel });
              await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              await ctx.hover(resolvedSel, { timeout: 10000 });
              logger.action(stepNum, `Hovered over "${field.label}" — waiting for effects to render`, { selector: resolvedSel });
              // Wait for hover effects (tooltips, dropdowns) to render
              await waitForPageStable(page, { timeout: 5000 });
              break;
            case 'press':
              if (resolvedSel && resolvedSel !== 'body') {
                logger.wait(stepNum, `Waiting for element to be ready before pressing "${value || 'Enter'}"`, { selector: resolvedSel });
                await waitForElementReady(ctx, resolvedSel, { timeout: 15000 });
              }
              await ctx.press(resolvedSel || 'body', value || 'Enter');
              logger.action(stepNum, `Pressed key "${value || 'Enter'}"`, { selector: resolvedSel });
              await waitForPageStable(page, { timeout: 5000 });
              break;
            case 'wait':
              // Dynamic wait: if value is a selector, wait for it; if number, use as timeout
              if (value && isNaN(Number(value))) {
                logger.wait(stepNum, `Waiting for element to appear: "${value}"`);
                await ctx.waitForSelector(value, { state: 'visible', timeout: 30000 });
                logger.action(stepNum, `Element appeared: "${value}"`);
              } else {
                const waitMs = parseInt(value || '2000');
                if (waitMs <= 1000) {
                  logger.wait(stepNum, `Waiting for page to stabilize`);
                  await waitForPageStable(page, { timeout: 5000 });
                } else {
                  logger.wait(stepNum, `Explicit wait: ${waitMs}ms`);
                  await page.waitForTimeout(waitMs);
                }
                logger.action(stepNum, `Wait completed`);
              }
              break;
            case 'goto':
              logger.wait(stepNum, `Navigating to: ${value}`);
              await smartNavigate(page, value, { timeout: 30000 });
              logger.action(stepNum, `Navigation complete: ${value}`);
              break;
            case 'clickIfVisible': {
              logger.info(stepNum, `Checking if "${field.label}" is visible before clicking`, { selector: resolvedSel });
              try {
                const el = await ctx.$(resolvedSel);
                if (el) {
                  const isVisible = await el.isVisible();
                  if (isVisible) {
                    await el.click({ timeout: 5000 });
                    logger.action(stepNum, `Element was visible — clicked "${field.label}"`, { selector: resolvedSel });
                  } else {
                    logger.info(stepNum, `Element not visible — skipping click`, { selector: resolvedSel });
                  }
                } else {
                  logger.info(stepNum, `Element not found — skipping click`, { selector: resolvedSel });
                }
              } catch {}
              break;
            }
            case 'uploadFile':
              logger.wait(stepNum, `Waiting for file input "${field.label}" to be attached`, { selector: resolvedSel });
              await waitForElementReady(ctx, resolvedSel, { timeout: 20000, state: 'attached' });
              await ctx.setInputFiles(resolvedSel, value);
              logger.action(stepNum, `Uploaded file: "${value}"`, { selector: resolvedSel });
              break;
            case 'dblclick':
              logger.wait(stepNum, `Waiting for "${field.label}" to be visible for double-click`, { selector: resolvedSel });
              await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              await ctx.dblclick(resolvedSel, { timeout: 10000 });
              logger.action(stepNum, `Double-clicked "${field.label}"`, { selector: resolvedSel });
              await waitForPageStable(page, { timeout: 5000 });
              break;
            case 'scroll':
              logger.info(stepNum, `Scrolling to "${field.label}"`, { selector: resolvedSel });
              if (resolvedSel && resolvedSel !== 'html') {
                try { await waitForElementReady(ctx, resolvedSel, { timeout: 10000, state: 'attached' }); } catch {}
              }
              await ctx.evaluate((s: string) => {
                const el = document.querySelector(s) || document.evaluate(s.replace('xpath=', ''), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (el) (el as Element).scrollIntoView({ behavior: 'smooth' });
                else window.scrollBy(0, 300);
              }, resolvedSel);
              // Brief stability wait after scroll for lazy-loaded content
              await waitForPageStable(page, { timeout: 3000 });
              break;
            case 'assert': {
              await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              const locator = ctx.locator(resolvedSel);
              let passed = false;
              if (field.assertType === 'visible') passed = await locator.isVisible();
              else if (field.assertType === 'hidden') passed = !(await locator.isVisible());
              else if (field.assertType === 'hasText') passed = (await locator.textContent())?.includes(field.expectedValue) || false;
              else if (field.assertType === 'hasValue') passed = (await locator.inputValue()) === field.expectedValue;
              else if (field.assertType === 'containsText') passed = (await locator.textContent())?.includes(field.expectedValue) || false;
              else if (field.assertType === 'enabled') passed = await locator.isEnabled();
              else if (field.assertType === 'disabled') passed = !(await locator.isEnabled());
              if (!passed) throw new Error(`Assertion failed: ${field.assertType} on ${resolvedSel}`);
              logger.action(stepNum, `Assertion passed: ${field.assertType} = "${field.expectedValue}"`, { selector: resolvedSel });
              break;
            }
            case 'captureAppNumber': {
              logger.wait(stepNum, `Waiting for element to capture value from "${field.label}"`, { selector: resolvedSel });
              await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              const text = await ctx.locator(resolvedSel).textContent();
              if (text && field.captureAs) {
                capturedVars[field.captureAs] = text.trim();
                logger.action(stepNum, `Captured "${field.captureAs}" = "${text.trim()}"`, { selector: resolvedSel });
              }
              break;
            }
            case 'screenshot':
              logger.action(stepNum, `Taking screenshot`);
              break; // screenshot taken below anyway
          }

          // Capture value if captureAs is set
          if (field.captureAs && field.actionType !== 'captureAppNumber') {
            try {
              const val = await ctx.locator(resolvedSel).inputValue();
              if (val) {
                capturedVars[field.captureAs] = val;
                logger.info(stepNum, `Captured variable "${field.captureAs}" = "${val}"`);
              }
            } catch {}
          }

          const stepDuration = Date.now() - stepStart;
          logger.success(stepNum, `✓ Step ${stepNum} passed: ${field.actionType} → "${field.label}" (${stepDuration}ms)`, { duration: stepDuration });

          if (ssMode === 'all') {
            const ss = path.join(runDir, `step_${stepNum}.png`);
            await page.screenshot({ path: ss });
            results.push({ step: stepNum, field: field.label, action: `${field.actionType}: ${value || field.selector}`, status: 'PASSED', screenshot: `/api/live-test/screenshot/dynamic_${runId}/step_${stepNum}.png`, capturedValue: field.captureAs ? capturedVars[field.captureAs] : undefined });
          } else {
            results.push({ step: stepNum, field: field.label, action: `${field.actionType}: ${value || field.selector}`, status: 'PASSED', capturedValue: field.captureAs ? capturedVars[field.captureAs] : undefined });
          }
          this.progressGateway?.emitProgress(opts.runId || runId, { step: stepNum, total: fields.length + 1, action: field.label, status: 'passed' });
          if (opts.projectId) this.progressGateway?.emitProgress(opts.projectId, { step: stepNum, total: fields.length + 1, action: field.label, status: 'passed' });

        } catch (err: any) {
          const stepDuration = Date.now() - stepStart;
          logger.error(stepNum, `✗ Step ${stepNum} failed: ${field.actionType} → "${field.label}" (${stepDuration}ms)`, { selector: field.selector, details: formatError(err.message) });

          if (ssMode !== 'none') {
            const ss = path.join(runDir, `step_${stepNum}_fail.png`);
            try { await page.screenshot({ path: ss }); } catch {}
            results.push({ step: stepNum, field: field.label, action: `${field.actionType}: ${value || field.selector}`, status: 'FAILED', error: formatError(err.message), screenshot: `/api/live-test/screenshot/dynamic_${runId}/step_${stepNum}_fail.png` });
          } else {
            results.push({ step: stepNum, field: field.label, action: `${field.actionType}: ${value || field.selector}`, status: 'FAILED', error: formatError(err.message) });
          }
          this.progressGateway?.emitProgress(opts.runId || runId, { step: stepNum, total: fields.length + 1, action: field.label, status: 'failed' });
          if (opts.projectId) this.progressGateway?.emitProgress(opts.projectId, { step: stepNum, total: fields.length + 1, action: field.label, status: 'failed' });
        }
      }
    } catch (err: any) {
      logger.error(stepNum + 1, `FATAL ERROR: ${err.message}`);
      results.push({ step: stepNum + 1, field: 'FATAL', action: 'execution', status: 'FAILED', error: err.message });
    }

    // In 'final' mode, capture the last step screenshot (final state or last failure)
    if (ssMode === 'final' && results.length > 0) {
      const lastResult = results[results.length - 1];
      const lastStepNum = lastResult.step;
      const suffix = lastResult.status === 'FAILED' ? '_fail' : '';
      const ss = path.join(runDir, `step_${lastStepNum}${suffix}.png`);
      try {
        await page.screenshot({ path: ss });
        lastResult.screenshot = `/api/live-test/screenshot/dynamic_${runId}/step_${lastStepNum}${suffix}.png`;
      } catch {}
    }

    // Wait for page to settle before closing
    await waitForPageStable(page, { timeout: 5000 });
    await browser.close();

    // Resolve script name from linked test case
    const testCase = await this.testCaseModel.findOne({
      projectId: new Types.ObjectId(opts.projectId),
      tags: 'field-config',
      isDeleted: { $ne: true },
    }).lean();
    const scriptName = testCase?.title || null;

    const totalDuration = logger.getElapsed();
    const passedCount = results.filter((r) => r.status === 'PASSED').length;
    const failedCount = results.filter((r) => r.status === 'FAILED').length;
    const skippedCount = results.filter((r) => r.status === 'SKIPPED').length;

    logger.info(0, `Execution complete: ${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped (${totalDuration}ms total)`);

    // Notify all WebSocket watchers that execution is done
    this.progressGateway?.emitComplete(runId, { passed: passedCount, failed: failedCount, skipped: skippedCount, duration: totalDuration, totalSteps: results.length });
    if (opts.projectId) this.progressGateway?.emitComplete(opts.projectId, { passed: passedCount, failed: failedCount, skipped: skippedCount, duration: totalDuration, totalSteps: results.length });

    const executionResult = {
      runId,
      scriptName,
      testCaseId: testCase?._id || null,
      screenshotMode: ssMode,
      totalSteps: results.length,
      passed: passedCount,
      failed: failedCount,
      skipped: skippedCount,
      duration: totalDuration,
      capturedVariables: capturedVars,
      results,
      logs: logger.getAllLogs(),
    };

    // Auto-generate HTML report after execution
    try {
      this.htmlReportService?.generateReport({
        runId,
        totalSteps: executionResult.totalSteps,
        passed: executionResult.passed,
        failed: executionResult.failed,
        skipped: executionResult.skipped,
        results,
        projectId: opts.projectId,
        url: opts.url,
        executedAt: new Date().toISOString(),
      });
    } catch {}

    return {
      ...executionResult,
      reportUrl: `/api/html-report/download/${runId}`,
    };
  }

  /**
   * Detect if a field config is a login-related step that should be skipped
   * when credentials are already provided for automatic login.
   */
  private isLoginField(field: any): boolean {
    const sectionLower = (field.section || '').toLowerCase();
    const labelLower = (field.label || '').toLowerCase();
    const fieldNameLower = (field.fieldName || '').toLowerCase();
    const selectorLower = (field.selector || '').toLowerCase();

    // Check section name
    if (sectionLower === 'login' || sectionLower === 'authentication' || sectionLower === 'auth') {
      return true;
    }

    // Check if it's a password input type
    if (field.inputType === 'password') {
      return true;
    }

    // Check field name / label patterns
    const loginPatterns = ['login', 'password', 'username', 'signin', 'sign-in', 'sign_in'];
    if (loginPatterns.some(p => fieldNameLower.includes(p) || labelLower.includes(p))) {
      return true;
    }

    // Check selector patterns for login elements
    if (selectorLower.includes('login') || selectorLower.includes('password') ||
        selectorLower.includes('btnlogin') || selectorLower.includes('btn-login') ||
        selectorLower.includes('input[type="password"]')) {
      return true;
    }

    return false;
  }

  /**
   * Preview steps without executing (dry run).
   * Returns the script name from the linked test case so Record & Run
   * displays the same name pattern as the Test Cases section.
   */
  async previewSteps(projectId: string) {
    const pid = new Types.ObjectId(projectId);

    const fields = await this.fieldModel.find({
      projectId: pid, isActive: true, isSkipped: false,
    }).sort({ order: 1 }).lean();

    // Resolve script name from the linked test case
    const testCase = await this.testCaseModel.findOne({
      projectId: pid,
      tags: 'field-config',
      isDeleted: { $ne: true },
    }).lean();

    const scriptName = testCase?.title || null;

    const steps = fields.map((f: any, i: number) => ({
      step: i + 1,
      label: f.label,
      action: f.actionType,
      selector: f.selector,
      defaultValue: f.defaultValue,
      conditions: f.conditions,
      captureAs: f.captureAs,
    }));

    return {
      scriptName,
      testCaseId: testCase?._id || null,
      totalSteps: steps.length,
      steps,
    };
  }
}
