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
  if (msg.includes('No visible element')) return 'Element exists but is hidden. If this is a wizard step, the previous "Next" click may not have advanced the form.';
  if (msg.includes('Timeout')) return 'Element not found or not clickable. The page may not have loaded correctly.';
  if (msg.includes('net::ERR')) return 'Page failed to load. Check URL and network.';
  if (msg.includes('strict mode violation')) return 'Multiple matching elements — selector is ambiguous. Update in Field Manager.';
  if (msg.includes('selectOption')) return 'Dropdown option not found. Check the value matches available options.';
  if (msg.includes('fill')) return 'Could not fill field. It may be disabled or hidden.';
  return msg.split('\n')[0].slice(0, 150);
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
 * App-level readiness check for jQuery apps:
 *   - document.readyState === 'complete'
 *   - jQuery.active === 0 (jQuery's own in-flight AJAX counter — the definitive
 *     signal for jQuery-driven cascades; better and faster than networkidle)
 *   - no VISIBLE loading indicators (blockUI overlays, spinners, loaders)
 *
 * SPEED-TUNED: defaults are lean (no grace period, single passing check). The
 * heavier settings (grace + quiet period across two checks) are used ONLY where
 * cascades demand them — right after a dropdown selection — via options.
 */
async function waitForAppReady(page: any, opts?: { timeout?: number; graceMs?: number; quietChecks?: number }) {
  const timeout = opts?.timeout ?? 10000;
  const grace = opts?.graceMs ?? 0;
  const quietChecks = opts?.quietChecks ?? 1;
  const deadline = Date.now() + timeout;

  // Optional grace: lets deferred (setTimeout-launched) AJAX actually START
  // before we begin checking. Used after selects; skipped elsewhere for speed.
  if (grace > 0) {
    try { await page.waitForTimeout(grace); } catch {}
  }

  let consecutiveReady = 0;
  while (Date.now() < deadline) {
    let ready = false;
    try {
      ready = await page.evaluate(() => {
        // 1. Document fully loaded (scripts, images)
        if (document.readyState !== 'complete') return false;

        // 2. jQuery has no in-flight AJAX requests
        const jq = (window as any).jQuery || (window as any).$;
        if (jq && typeof jq.active === 'number' && jq.active > 0) return false;

        // 3. No VISIBLE loading indicators
        const isVisible = (el: any) =>
          !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const indicators = document.querySelectorAll(
          '.blockUI, .blockOverlay, .blockMsg, .loading, .loader, .spinner, ' +
          '.spinner-border, .spinner-grow, .fa-spinner, .fa-circle-notch, ' +
          '.loading-overlay, .page-loader, .preloader, #loading, #loader, ' +
          '#preloader, [class*="loading-spinner"]',
        );
        for (const el of Array.from(indicators)) {
          if (isVisible(el)) return false;
        }
        return true;
      });
    } catch {
      // evaluate can fail mid-navigation — treat as not ready and retry
      ready = false;
    }

    if (ready) {
      consecutiveReady++;
      if (consecutiveReady >= quietChecks) return;
    } else {
      consecutiveReady = 0;
    }
    try { await page.waitForTimeout(200); } catch {}
  }
  // Timed out — proceed anyway; per-action waits (option retry, visible-element
  // polling) provide the next layer of protection.
}

/**
 * Smart wait: DOM parsed + app quiet. networkidle removed — for a jQuery app,
 * jQuery.active is a stricter AND faster signal (networkidle costs 500ms
 * minimum and stalls on pages with background polling).
 */
async function waitForPageStable(page: any, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 12000;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
  } catch {}
  await waitForAppReady(page, { timeout: Math.min(timeout, 10000), graceMs: 200, quietChecks: 1 });
}

/**
 * Wizard-safe element resolution: find the first VISIBLE element matching a
 * selector. Wizard/multi-step forms keep every step panel in the DOM and hide
 * the inactive ones, so a recorded selector can match several elements — only
 * the current step's one is visible. Playwright's waitForSelector waits on the
 * FIRST DOM match (possibly hidden) and would hang; this polls ALL matches.
 */
async function firstVisibleElement(ctx: any, selector: string, timeout: number): Promise<any> {
  const deadline = Date.now() + timeout;
  let lastCount = 0;
  while (Date.now() < deadline) {
    try {
      const els = await ctx.$$(selector);
      lastCount = els.length;
      for (const el of els) {
        try {
          if (await el.isVisible()) return el;
        } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (lastCount > 0) {
    throw new Error(`Timeout: No visible element among ${lastCount} match(es) for selector: ${selector}`);
  }
  throw new Error(`Timeout: element not found for selector: ${selector}`);
}

/**
 * Smart element wait: waits for a matching element to be ready and RETURNS its handle.
 *  - state 'visible' (default): returns the first VISIBLE match (wizard-safe).
 *  - state 'attached': returns the first match present in the DOM (hidden file
 *    inputs etc.).
 */
async function waitForElementReady(ctx: any, selector: string, opts?: { timeout?: number; state?: 'visible' | 'attached' }): Promise<any> {
  const timeout = opts?.timeout || 20000;
  const state = opts?.state || 'visible';

  if (state === 'attached') {
    return await ctx.waitForSelector(selector, { state: 'attached', timeout });
  }
  return await firstVisibleElement(ctx, selector, timeout);
}

/**
 * Smart click: resolves the first VISIBLE match (wizard-safe), clicks it, then
 * waits for the page/app to settle.
 */
async function smartClick(ctx: any, page: any, selector: string, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 20000;

  const el = await firstVisibleElement(ctx, selector, timeout);
  try { await el.scrollIntoViewIfNeeded(); } catch {}
  await el.click({ timeout: Math.min(timeout, 10000) });

  // After click, wait for page + app to settle (navigation, AJAX, re-renders)
  await waitForPageStable(page, { timeout: 10000 });
}

/**
 * Close a datepicker popup ONLY if one is actually open.
 *
 * Never send Escape unconditionally after fills: jQuery inputmask RESTORES THE
 * ORIGINAL (empty) VALUE on Escape, and daterangepicker CANCELS AND REVERTS on
 * Escape — that silently wipes masked/date field values. When a picker IS
 * open, click a neutral spot first (closes most pickers without touching the
 * input's value), then Escape only as backup.
 */
async function closeDatepickerIfOpen(page: any) {
  try {
    const pickerCheck = () => {
      const isVisible = (el: any) =>
        !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const pickers = document.querySelectorAll(
        '.datepicker.dropdown-menu, .datepicker-dropdown, .daterangepicker, ' +
        '.ui-datepicker:not(.ui-datepicker-inline), .flatpickr-calendar.open, ' +
        '.bootstrap-datetimepicker-widget',
      );
      for (const el of Array.from(pickers)) {
        if (isVisible(el)) return true;
      }
      return false;
    };
    const pickerOpen = await page.evaluate(pickerCheck);
    if (pickerOpen) {
      try { await page.mouse.click(1, 1); } catch {}
      const stillOpen = await page.evaluate(pickerCheck).catch(() => false);
      if (stillOpen) {
        try { await page.keyboard.press('Escape'); } catch {}
      }
    }
  } catch {}
}

/**
 * Smart fill: waits for input to be ready, fills, VERIFIES the value stuck,
 * and retries with real typing if it didn't.
 *
 * Handles legacy/enterprise stacks:
 *  - Multi-step forms: visible-match resolution across hidden step panels.
 *  - Masked inputs (jQuery inputmask): fill() can be rejected by the mask —
 *    verification catches it and the retry TYPES the value key-by-key, which
 *    masks accept. No Escape is ever sent to these fields.
 *  - Bootstrap datepicker readonly inputs: value set via JS + events.
 *  - jQuery-driven widgets that only react to $(el).trigger('change').
 */
async function smartFill(ctx: any, page: any, selector: string, value: string, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 20000;
  const pg = pageOf(ctx, page);

  // Wait for the element to at least exist in the DOM
  await ctx.waitForSelector(selector, { state: 'attached', timeout });

  // Prefer the VISIBLE match when the selector hits multiple elements across
  // step panels. Fall back to the first attached match.
  let el: any = null;
  try {
    el = await firstVisibleElement(ctx, selector, Math.min(timeout, 8000));
  } catch {
    el = await ctx.$(selector);
  }
  if (!el) throw new Error(`Element not found for selector: ${selector}`);

  const fireEvents = (node: any) => {
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    const jq = (window as any).jQuery;
    if (jq) { try { jq(node).trigger('change').trigger('blur'); } catch {} }
  };

  const setViaJs = async () => {
    await el.evaluate((node: any, val: string) => {
      const wasReadonly = node.hasAttribute('readonly');
      if (wasReadonly) node.removeAttribute('readonly');
      node.value = val;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      const jq = (window as any).jQuery;
      if (jq) { try { jq(node).val(val).trigger('change').trigger('blur'); } catch {} }
      if (wasReadonly) node.setAttribute('readonly', 'readonly');
    }, value);
  };

  const currentValue = async (): Promise<string> =>
    (await el.inputValue().catch(() => '')) || '';

  // Bootstrap datepickers are commonly readonly — plain fill() would fail
  const isReadonly = await el
    .evaluate((node: any) => node.hasAttribute('readonly') || node.readOnly === true)
    .catch(() => false);

  const isVisible = await el.isVisible().catch(() => false);

  if (!isReadonly && isVisible) {
    // Attempt 1: standard fill
    try {
      await el.fill(value, { timeout: Math.min(timeout, 8000) });
      await el.evaluate(fireEvents);
    } catch {}

    // VERIFY the value actually stuck. Masked inputs reformat the value, so
    // "non-empty" is the pass condition, not exact equality.
    if ((await currentValue()).trim() === '' && value.trim() !== '') {
      // Attempt 2: type key-by-key like a real user — inputmask and other
      // keystroke-driven widgets accept this where fill()'s single value-set
      // gets rejected.
      try {
        await el.click({ timeout: 3000 });
        await el.evaluate((node: any) => { node.value = ''; });
        await el.type(value, { delay: 25 });
        await el.evaluate(fireEvents);
      } catch {}
    }

    // Attempt 3: JS assignment as the last resort
    if ((await currentValue()).trim() === '' && value.trim() !== '') {
      await setViaJs();
    }
  } else {
    // Readonly (datepicker) or hidden input → assign value via JS directly
    await setViaJs();
  }

  // Close a datepicker popup ONLY if one actually opened.
  await closeDatepickerIfOpen(pg);
}

/**
 * Smart select: selects an option in a dropdown.
 *
 * Supports four cases:
 *  1. Plain visible native <select> — Playwright selectOption (label, then value).
 *  2. Enhanced select (Select2 / Chosen / bootstrap-select) — set value on the
 *     hidden native element + native/jQuery change + widget refresh APIs.
 *     Retries the option match for up to 12s so a dependent dropdown's
 *     AJAX-loaded options have time to arrive.
 *  2b. bootstrap-select UI fallback — toggle button → live-search → option.
 *  3. Fully custom dropdown — open, search, click matching option.
 *
 * After every applied selection: full app-readiness wait (grace + quiet period)
 * so the NEXT dependent field's data is loaded before its step runs.
 */
async function smartSelect(ctx: any, page: any, selector: string, value: string, opts?: { timeout?: number }) {
  const timeout = opts?.timeout || 20000;
  const pg = pageOf(ctx, page);

  await ctx.waitForSelector(selector, { state: 'attached', timeout });

  // Wizard-safe: among multiple matches, pick the "active" one — either the
  // select itself is visible, or its widget wrapper is visible.
  let handle: any = null;
  try {
    const els = await ctx.$$(selector);
    for (const el of els) {
      const activeHere = await el
        .evaluate((node: any) => {
          const visible = (n: any) => !!(n && (n.offsetWidth || n.offsetHeight || n.getClientRects().length));
          if (visible(node)) return true;
          const wrapper = node.closest && (node.closest('.bootstrap-select') || node.closest('.select2') || node.closest('.chosen-container'));
          if (wrapper && visible(wrapper)) return true;
          const sib = node.nextElementSibling;
          if (sib && /select2|bootstrap-select|chosen/i.test(sib.className || '') && visible(sib)) return true;
          return false;
        })
        .catch(() => false);
      if (activeHere) { handle = el; break; }
    }
    if (!handle && els.length > 0) handle = els[0];
  } catch {}
  if (!handle) throw new Error(`Element not found for selector: ${selector}`);

  const tagName = await handle.evaluate((el: any) => el.tagName.toLowerCase()).catch(() => '');

  if (tagName === 'select') {
    const isVisible = await handle.isVisible().catch(() => false);

    // Case 1: plain visible native select — selectOption internally retries
    // until the option exists, covering late AJAX-loaded options.
    if (isVisible) {
      try { await handle.selectOption({ label: value }, { timeout: Math.min(timeout, 10000) }); return; } catch {}
      try { await handle.selectOption(value, { timeout: Math.min(timeout, 10000) }); return; } catch {}
    }

    // Case 2: enhanced select with hidden native element.
    const tryApply = () =>
      handle.evaluate((el: any, val: string) => {
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

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        const jq = (window as any).jQuery || (window as any).$;
        if (jq) {
          try {
            const $el = jq(el);
            $el.val(match.value);
            $el.trigger('change');
            try { $el.trigger('change.select2'); } catch {}
            if (typeof $el.selectpicker === 'function') {
              try { $el.selectpicker('refresh'); } catch {}
            }
            try { $el.trigger('chosen:updated'); } catch {}
          } catch {}
        }
        return true;
      }, value);

    let applied = await tryApply();
    if (!applied) {
      // Dependent dropdown: options may still be arriving via AJAX — retry.
      const matchDeadline = Date.now() + Math.min(timeout, 12000);
      while (!applied && Date.now() < matchDeadline) {
        try { await pg.waitForTimeout(400); } catch {}
        applied = await tryApply();
      }
    }

    if (applied) {
      // The selection's change handler fires the cascade AJAX for the NEXT
      // dependent field. Heavier wait kept HERE only: grace so the (often
      // deferred) request starts, quiet period across two checks so chained
      // requests (State response → City request) are caught.
      await waitForAppReady(pg, { timeout: 12000, graceMs: 300, quietChecks: 2 });
      return;
    }

    // Case 2b: bootstrap-select UI drive.
    const wrapperHandle = await handle.evaluateHandle((el: any) => el.closest('.bootstrap-select')).catch(() => null);
    const wrapperEl = wrapperHandle ? wrapperHandle.asElement && wrapperHandle.asElement() : null;
    if (wrapperEl) {
      try {
        const toggle = await wrapperEl.$('button.dropdown-toggle');
        if (toggle) await toggle.click({ timeout: 5000 });

        const search = await wrapperEl.$('.bs-searchbox input');
        if (search) {
          try {
            await search.fill(value, { timeout: 3000 });
            await pg.waitForTimeout(400);
          } catch {}
        }

        const bsOptionSelectors = [
          `.dropdown-menu li a:text-is("${value}")`,
          `.dropdown-menu li a:has-text("${value}")`,
        ];
        for (const optSel of bsOptionSelectors) {
          const opt = await wrapperEl.$(optSel);
          if (opt && (await opt.isVisible().catch(() => false))) {
            await opt.click({ timeout: 4000 });
            await waitForAppReady(pg, { timeout: 12000, graceMs: 300, quietChecks: 2 });
            return;
          }
        }

        try { await pg.keyboard.press('Escape'); } catch {}
      } catch {}
    }
  }

  // Case 3: custom dropdown widget.
  try { await handle.click({ timeout: Math.min(timeout, 6000) }); } catch {}

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
        await waitForAppReady(pg, { timeout: 12000, graceMs: 300, quietChecks: 2 });
        return;
      } catch {}
    }
  }

  // Last resort: let Playwright's selectOption surface a clear, actionable error
  await ctx.selectOption(selector, value, { timeout });
}

/**
 * Smart navigation: navigates and waits for page + app to be ready.
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
 * Resolve the working locator for a field — CSS first, XPath fallback.
 * Wizard handling: multiple CSS matches with exactly one visible → CSS is fine;
 * multiple visible or zero → prefer the recorded (indexed) XPath.
 */
async function resolveSelector(ctx: any, selector: string, xpath?: string): Promise<string> {
  try {
    const elements = await ctx.$$(selector);
    if (elements.length === 1) return selector;

    if (elements.length > 1) {
      let visibleCount = 0;
      for (const el of elements) {
        try { if (await el.isVisible()) visibleCount++; } catch {}
      }
      if (visibleCount === 1) return selector;
    }

    if (xpath) {
      try {
        const xpathElements = await ctx.$$(`xpath=${xpath}`);
        if (xpathElements.length === 1) return `xpath=${xpath}`;
      } catch {}
    }

    if (elements.length > 0) return selector;
  } catch {}

  if (xpath) {
    try {
      const el = await ctx.$(`xpath=${xpath}`);
      if (el) return `xpath=${xpath}`;
    } catch {}
  }

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

    // INTEGRITY REGISTRY: every filled input AND selected dropdown on the
    // current screen. Right before any click (Next/Submit), each entry is
    // re-checked — if the page cleared it (inputmask/daterangepicker revert on
    // inputs, or a "Same as Permanent Address" copy losing the race with the
    // dependent City dropdown's AJAX options), it is re-applied before the
    // click proceeds. Cleared after clicks/navigation (new screen = new fields).
    const filledRegistry: { ctx: any; selector: string; value: string; kind: 'fill' | 'select' }[] = [];

    const reapplyClearedFills = async (currentStep: number) => {
      for (const f of filledRegistry) {
        try {
          const el = await f.ctx.$(f.selector);
          if (!el) continue;

          if (f.kind === 'fill') {
            const cur = await el.inputValue().catch(() => null);
            if (cur !== null && cur.trim() === '' && f.value.trim() !== '') {
              logger.warn(currentStep, `Value was cleared by the page — re-applying "${f.value.slice(0, 30)}"`, { details: f.selector });
              await smartFill(f.ctx, page, f.selector, f.value, { timeout: 8000 });
            }
          } else {
            // SELECT: "unselected" = empty select value OR the selected option
            // is the empty-value placeholder ("Select..."). This is exactly the
            // state a dependent dropdown lands in when a copy/cascade reset it
            // after our selection (Communication City stuck on "Select").
            const isEmpty = await el
              .evaluate((node: any) => {
                if (!node.tagName || node.tagName !== 'SELECT') return false;
                if (!node.value) return true;
                const opt = node.options && node.options[node.selectedIndex];
                if (!opt) return true;
                const v = opt.getAttribute ? opt.getAttribute('value') : opt.value;
                return v === '' || v === null;
              })
              .catch(() => false);
            if (isEmpty && f.value.trim() !== '') {
              logger.warn(currentStep, `Dropdown lost its selection — re-selecting "${f.value}"`, { details: f.selector });
              // smartSelect's built-in 12s option retry covers the case where
              // the dropdown's AJAX options are still (re)loading.
              await smartSelect(f.ctx, page, f.selector, f.value, { timeout: 15000 });
            }
          }
        } catch {}
      }
    };

    try {
      // Navigate to start URL with smart wait
      logger.wait(1, `Navigating to ${opts.url}`, { details: 'Waiting for DOM + app ready (jQuery/spinners)' });
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
        // Wait for post-login page + app to become stable
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
          // Lean pre-step readiness check: near-instant when the app is idle,
          // blocks while AJAX or a spinner is active.
          await waitForAppReady(page, { timeout: 10000, graceMs: 0, quietChecks: 1 });

          // Determine the effective selector: prefer CSS, fall back to XPath
          const cssSelector = field.selector || null;
          const xpathSelector = (field as any).xpath || null;
          const effectiveSelector = cssSelector || (xpathSelector ? `xpath=${xpathSelector}` : null);

          // Find the correct context (main page or iframe) for this selector
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
              await smartFill(ctx, page, resolvedSel, value, { timeout: 20000 });
              // Register for the pre-click integrity check
              if (value.trim() !== '') {
                filledRegistry.push({ ctx, selector: resolvedSel, value, kind: 'fill' });
              }
              logger.action(stepNum, `Filled "${field.label}" with value: "${value.slice(0, 50)}${value.length > 50 ? '...' : ''}"`, { selector: resolvedSel });
              break;
            case 'click':
              // Before Next/Submit clicks: verify every previously filled input
              // still holds its value AND every previously selected dropdown is
              // still selected — re-apply anything the page cleared (widget
              // reverts, "Same as Permanent Address" copy races, cascade resets).
              await reapplyClearedFills(stepNum);
              logger.wait(stepNum, `Waiting for "${field.label}" to be visible & clickable`, { selector: resolvedSel });
              await smartClick(ctx, page, resolvedSel, { timeout: 20000 });
              logger.action(stepNum, `Clicked "${field.label}" — waiting for page to settle`, { selector: resolvedSel });
              // A Next/Submit click typically moves to a new screen — old
              // registry entries belong to the previous screen now.
              filledRegistry.length = 0;
              break;
            case 'select':
              logger.wait(stepNum, `Waiting for dropdown "${field.label}" to be ready (options may load via AJAX)`, { selector: resolvedSel });
              await smartSelect(ctx, page, resolvedSel, value, { timeout: 20000 });
              // Register for the pre-click integrity check — dependent dropdowns
              // (e.g. Communication City) can be reset by copy toggles/cascades
              // AFTER this step succeeded.
              if (value.trim() !== '') {
                filledRegistry.push({ ctx, selector: resolvedSel, value, kind: 'select' });
              }
              logger.action(stepNum, `Selected option "${value}" in "${field.label}"`, { selector: resolvedSel });
              break;
            case 'check': {
              logger.wait(stepNum, `Waiting for checkbox "${field.label}" to be visible`, { selector: resolvedSel });
              const el = await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              await el.check({ timeout: 10000 });
              logger.action(stepNum, `Checked "${field.label}"`, { selector: resolvedSel });
              break;
            }
            case 'hover': {
              logger.wait(stepNum, `Waiting for "${field.label}" to be visible for hover`, { selector: resolvedSel });
              const el = await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              await el.hover({ timeout: 10000 });
              logger.action(stepNum, `Hovered over "${field.label}"`, { selector: resolvedSel });
              await waitForPageStable(page, { timeout: 5000 });
              break;
            }
            case 'press':
              if (resolvedSel && resolvedSel !== 'body') {
                logger.wait(stepNum, `Waiting for element to be ready before pressing "${value || 'Enter'}"`, { selector: resolvedSel });
                const el = await waitForElementReady(ctx, resolvedSel, { timeout: 15000 });
                await el.press(value || 'Enter');
              } else {
                await ctx.press(resolvedSel || 'body', value || 'Enter');
              }
              logger.action(stepNum, `Pressed key "${value || 'Enter'}"`, { selector: resolvedSel });
              await waitForPageStable(page, { timeout: 8000 });
              break;
            case 'wait':
              // Dynamic wait: if value is a selector, wait for it; if number, use as timeout
              if (value && isNaN(Number(value))) {
                logger.wait(stepNum, `Waiting for element to appear: "${value}"`);
                await firstVisibleElement(ctx, value, 30000);
                logger.action(stepNum, `Element appeared: "${value}"`);
              } else {
                const waitMs = parseInt(value || '2000');
                if (waitMs <= 1000) {
                  logger.wait(stepNum, `Waiting for page to stabilize`);
                  await waitForPageStable(page, { timeout: 8000 });
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
              filledRegistry.length = 0;
              break;
            case 'clickIfVisible': {
              logger.info(stepNum, `Checking if "${field.label}" is visible before clicking`, { selector: resolvedSel });
              try {
                const el = await firstVisibleElement(ctx, resolvedSel, 3000).catch(() => null);
                if (el) {
                  await reapplyClearedFills(stepNum);
                  await el.click({ timeout: 5000 });
                  logger.action(stepNum, `Element was visible — clicked "${field.label}"`, { selector: resolvedSel });
                } else {
                  logger.info(stepNum, `Element not visible — skipping click`, { selector: resolvedSel });
                }
              } catch {}
              break;
            }
            case 'uploadFile': {
              logger.wait(stepNum, `Waiting for file input "${field.label}" to be attached`, { selector: resolvedSel });
              const el = await waitForElementReady(ctx, resolvedSel, { timeout: 20000, state: 'attached' });
              await el.setInputFiles(value);
              logger.action(stepNum, `Uploaded file: "${value}"`, { selector: resolvedSel });
              break;
            }
            case 'dblclick': {
              logger.wait(stepNum, `Waiting for "${field.label}" to be visible for double-click`, { selector: resolvedSel });
              const el = await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              await el.dblclick({ timeout: 10000 });
              logger.action(stepNum, `Double-clicked "${field.label}"`, { selector: resolvedSel });
              await waitForPageStable(page, { timeout: 8000 });
              break;
            }
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
              await waitForPageStable(page, { timeout: 5000 });
              break;
            case 'assert': {
              // Wizard-safe: assert against the visible match when there are several
              const el = await waitForElementReady(ctx, resolvedSel, { timeout: 20000 }).catch(() => null);
              let passed = false;
              if (field.assertType === 'visible') passed = !!el;
              else if (field.assertType === 'hidden') passed = !el;
              else if (el) {
                if (field.assertType === 'hasText') passed = ((await el.textContent()) || '').includes(field.expectedValue);
                else if (field.assertType === 'hasValue') passed = (await el.inputValue()) === field.expectedValue;
                else if (field.assertType === 'containsText') passed = ((await el.textContent()) || '').includes(field.expectedValue);
                else if (field.assertType === 'enabled') passed = await el.isEnabled();
                else if (field.assertType === 'disabled') passed = !(await el.isEnabled());
              }
              if (!passed) throw new Error(`Assertion failed: ${field.assertType} on ${resolvedSel}`);
              logger.action(stepNum, `Assertion passed: ${field.assertType} = "${field.expectedValue}"`, { selector: resolvedSel });
              break;
            }
            case 'captureAppNumber': {
              logger.wait(stepNum, `Waiting for element to capture value from "${field.label}"`, { selector: resolvedSel });
              const el = await waitForElementReady(ctx, resolvedSel, { timeout: 20000 });
              const text = await el.textContent();
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
              const el = await firstVisibleElement(ctx, resolvedSel, 3000).catch(() => null);
              const val = el ? await el.inputValue().catch(() => '') : '';
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

    // Brief settle before closing
    await waitForAppReady(page, { timeout: 4000, graceMs: 0, quietChecks: 1 });
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
