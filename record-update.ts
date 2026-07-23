import { Controller, Post, Get, Body, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { FieldConfigService } from "../field-config/field-config.service";
import { Project } from "../projects/project.schema";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const RECORDINGS_DIR = path.join(process.cwd(), "artifacts", "recordings");

// Module-level state (survives across requests)
const activeSessions = new Map<string, any>();

function actionsFilePath(projectId: string) {
  return path.join(os.tmpdir(), `recorder_${projectId}.json`);
}

@ApiTags("Auto Recorder")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("api/auto-record")
export class AutoRecordController {
  constructor(
    private fieldConfigService: FieldConfigService,
    @InjectModel(Project.name) private projectModel: Model<Project>,
  ) {}

  @Post("start")
  async startRecording(
    @Body() dto: { url?: string; name: string; projectId?: string },
  ) {
    const projectId = dto.projectId || "default";

    // If no URL provided, resolve from project's baseUrl
    let url = dto.url;
    if (!url && projectId !== "default") {
      const project = await this.projectModel.findById(projectId).lean();
      url = project?.baseUrl;
    }
    if (!url) {
      return {
        status: "ERROR",
        message: "No URL provided and project has no baseUrl configured",
      };
    }

    // Close any existing session
    if (activeSessions.has(projectId)) {
      try {
        await activeSessions.get(projectId).close();
      } catch {}
      activeSessions.delete(projectId);
    }

    // Initialize temp file for actions
    const filePath = actionsFilePath(projectId);
    fs.writeFileSync(filePath, JSON.stringify([]), "utf8");
    if (!fs.existsSync(RECORDINGS_DIR))
      fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

    // Launch browser in background (non-blocking, like old app)
    (async () => {
      try {
        const { chromium } = await import("playwright");
        const browser = await chromium.launch({
          headless: false,
          args: ["--no-sandbox", "--disable-gpu", "--start-maximized"],
        });
        activeSessions.set(projectId, browser);

        const context = await browser.newContext({ viewport: null });

        // Real-time sink for recorded actions: writes each action to disk as soon as
        // it happens, instead of relying solely on a 3s poll (which can drop actions
        // that fire right before a navigation clears the in-page buffer).
        await context.exposeFunction("__reportAction", (actionObj: any) => {
          try {
            let existing: any[] = [];
            try {
              existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
            } catch {}
            existing.push(actionObj);
            fs.writeFileSync(filePath, JSON.stringify(existing), "utf8");
          } catch {}
        });

        // Inject capture script at context level (works across navigations)
        await context.addInitScript(() => {
          (window as any).__recordedActions =
            (window as any).__recordedActions || [];

          // ================================================================
          // Record ONLY fields the user actually interacted with:
          //   - A "user gesture" timestamp (mousedown/keydown/touchstart).
          //     recordChange() rejects changes with no gesture yet in this
          //     document â which filters ALL page-load / programmatic init
          //     changes, because addInitScript re-runs on every navigation
          //     and the gesture clock starts at 0 on each new page.
          //   - Placeholder select changes are skipped (empty option value).
          //   - Clicks on text-entry controls are not recorded â the change
          //     event captures the real fill/select/check.
          //   - No focus recording, no Tab recording, no hover on fields.
          //
          // CASCADE FIX (fields that depend on a previous field):
          //   State â City, Plan â Premium etc. load options / set values via
          //   AJAX after the parent choice. Those dependent change events can
          //   arrive MANY seconds after the user's click (slow server, heavy
          //   jQuery). The gesture window is therefore WIDE (30s): its only
          //   job is to distinguish "user has started interacting with this
          //   page" from "page is still initializing". Page-load init triggers
          //   are filtered regardless of window size because the clock resets
          //   to 0 on every navigation. Cascade resets to placeholder are
          //   filtered by the empty-option-value check, not by timing.
          // ================================================================

          // --- user gesture tracking -------------------------------------
          let lastUserGestureTime = 0;
          function noteGesture() {
            lastUserGestureTime = Date.now();
          }
          document.addEventListener("mousedown", noteGesture, true);
          document.addEventListener("keydown", noteGesture, true);
          document.addEventListener("touchstart", noteGesture, true);

          // Wide window (see CASCADE FIX above). lastUserGestureTime === 0
          // means the user has not interacted with this page at all yet â
          // that alone filters init-time programmatic changes.
          function hasRecentUserGesture(): boolean {
            return (
              lastUserGestureTime > 0 &&
              Date.now() - lastUserGestureTime < 30000
            );
          }

          // Text-entry / value controls whose clicks should NOT be recorded â
          // their real action is the change event (fill/select/check).
          function isTextEntryControl(el: any): boolean {
            if (!el || !el.tagName) return false;
            if (el.tagName === "TEXTAREA" || el.tagName === "SELECT")
              return true;
            if (el.tagName === "INPUT") {
              const t = (el.type || "text").toLowerCase();
              // checkbox / radio / button-ish inputs keep their click behavior
              return ![
                "checkbox",
                "radio",
                "button",
                "submit",
                "reset",
                "image",
                "file",
              ].includes(t);
            }
            return false;
          }

          // CASCADE FIX: placeholder detection is now VALUE-based, not
          // text-based. Placeholder options are almost always
          //   <option value="">Select...</option>
          // so an empty option value (or empty select value) is the reliable
          // signal of "no real choice yet" â including cascade resets, which
          // put the dependent select back onto its empty-value placeholder.
          // A selected option that carries a real value is a REAL user choice
          // and is recorded even if its text looks placeholder-ish (a
          // legitimate option named "None", "Choose", etc. is kept).
          // Text matching is only a narrow fallback for sloppy markup where
          // the placeholder has value="0"/"-1".
          function isPlaceholderChoice(el: any, text: string): boolean {
            const v = (text || "").replace(/\s+/g, " ").trim();
            if (!v) return true;
            try {
              const opt = el.options && el.options[el.selectedIndex];
              if (!opt) return true;
              const optVal = opt.getAttribute
                ? opt.getAttribute("value")
                : opt.value;
              // Empty (or missing) value attribute â placeholder
              if (optVal === "" || optVal === null) return true;
              // Real value + strictly placeholder-looking text with a
              // sentinel value like 0 / -1 â still a placeholder
              if (
                (optVal === "0" || optVal === "-1") &&
                /^(-{1,3}\s*)?(select|choose|please select)(\s+one)?(\s*-{1,3})?(\.{2,3})?$/i.test(
                  v,
                )
              )
                return true;
              // Real value â real choice (even if text is "None"/"Choose")
              return false;
            } catch {}
            // No option info available â fall back to strict text patterns only
            return /^(-{1,3}\s*)?(select|choose|please select|nothing selected)(\s+one)?(\s*-{1,3})?(\.{2,3})?$/i.test(
              v,
            );
          }

          // Helper to generate a reliable CSS selector for an element
          function getSelector(el: any): string {
            if (el.id) return `#${el.id}`;
            if (el.getAttribute("name"))
              return `[name="${el.getAttribute("name")}"]`;
            if (el.getAttribute("data-testid"))
              return `[data-testid="${el.getAttribute("data-testid")}"]`;
            if (el.getAttribute("aria-label"))
              return `[aria-label="${el.getAttribute("aria-label")}"]`;
            if (el.getAttribute("placeholder"))
              return `[placeholder="${el.getAttribute("placeholder")}"]`;
            if (el.getAttribute("title"))
              return `[title="${el.getAttribute("title")}"]`;
            // For links and buttons, use text content for a unique selector
            if (
              (el.tagName === "A" || el.tagName === "BUTTON") &&
              el.textContent
            ) {
              const text = el.textContent.trim().split("\n")[0].trim();
              if (text && text.length <= 40) {
                return `${el.tagName.toLowerCase()}:has-text("${text}")`;
              }
            }
            // Build a CSS path for elements without identifiable attributes
            if (
              el.className &&
              typeof el.className === "string" &&
              el.className.trim()
            ) {
              const cls = el.className
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .join(".");
              return `${el.tagName.toLowerCase()}.${cls}`;
            }
            return el.tagName.toLowerCase();
          }

          // Helper to generate an XPath for an element
          function getXPath(el: Element): string {
            function isUnique(xpath: string): boolean {
              try {
                return (
                  document.evaluate(
                    `count(${xpath})`,
                    document,
                    null,
                    XPathResult.NUMBER_TYPE,
                    null,
                  ).numberValue === 1
                );
              } catch {
                return false;
              }
            }

            // 1. Unique ID
            if (el.id) {
              const xpath = `//*[@id="${el.id}"]`;
              if (isUnique(xpath)) return xpath;
            }

            // 2. data-testid
            const testId = el.getAttribute("data-testid");
            if (testId) {
              const xpath = `//*[@data-testid="${testId}"]`;
              if (isUnique(xpath)) return xpath;
            }

            // 3. name
            const name = el.getAttribute("name");
            if (name) {
              const xpath = `//*[@name="${name}"]`;
              if (isUnique(xpath)) return xpath;
            }

            // 4. aria-label
            const aria = el.getAttribute("aria-label");
            if (aria) {
              const xpath = `//*[@aria-label="${aria}"]`;
              if (isUnique(xpath)) return xpath;
            }

            // 5. Visible text
            const text = (el.textContent || "").trim();

            if (text && text.length < 80) {
              const xpath = `//${el.tagName.toLowerCase()}[normalize-space(.)="${text}"]`;

              if (isUnique(xpath)) return xpath;
            }

            // 6. Parent + child text
            if (text) {
              const parent = el.parentElement;

              if (parent) {
                const xpath =
                  `//${parent.tagName.toLowerCase()}` +
                  `//${el.tagName.toLowerCase()}[normalize-space(.)="${text}"]`;

                if (isUnique(xpath)) return xpath;
              }
            }

            // 7. Build indexed XPath
            const parts: string[] = [];

            let current: Element | null = el;

            while (current && current.nodeType === 1) {
              let index = 1;

              let sibling = current.previousElementSibling;

              while (sibling) {
                if (sibling.tagName === current.tagName) index++;

                sibling = sibling.previousElementSibling;
              }

              parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);

              current = current.parentElement;
            }

            return "/" + parts.join("/");
          }

          // Helper to get a human-readable label
          function getLabel(el: any): string {
            return (
              (el.innerText || "").trim().slice(0, 60) ||
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("title") ||
              el.getAttribute("name") ||
              el.id ||
              ""
            );
          }

          function record(actionObj: any) {
            try {
              if ((window as any).__reportAction) {
                (window as any).__reportAction(actionObj);
                return;
              }
            } catch {}
            (window as any).__recordedActions.push(actionObj);
          }

          function getInteractiveElement(start: any): any {
            const interactiveTags = [
              "A",
              "BUTTON",
              "INPUT",
              "SELECT",
              "TEXTAREA",
              "LABEL",
              "LI",
            ];
            let current = start;
            while (
              current &&
              current.tagName !== "HTML" &&
              current.tagName !== "BODY"
            ) {
              const isInteractive =
                interactiveTags.includes(current.tagName) ||
                current.getAttribute("role") ||
                current.getAttribute("title") ||
                current.getAttribute("data-tooltip") ||
                current.getAttribute("aria-label") ||
                current.getAttribute("data-testid") ||
                current.onclick ||
                (current.className &&
                  typeof current.className === "string" &&
                  /btn|button|link|menu|nav|tab|hover|dropdown|card|item|option|select/i.test(
                    current.className,
                  )) ||
                window.getComputedStyle(current).cursor === "pointer";
              if (isInteractive) return current;
              current = current.parentElement;
            }
            return start;
          }

          // Walk up the ancestor chain looking for a node matching a predicate.
          function closestMatch(el: any, predicate: (n: any) => boolean): any {
            let cur = el;
            while (cur && cur.nodeType === 1) {
              if (predicate(cur)) return cur;
              cur = cur.parentElement;
            }
            return null;
          }

          function hasClassLike(el: any, regex: RegExp): boolean {
            return (
              el.className &&
              typeof el.className === "string" &&
              regex.test(el.className)
            );
          }

          // Detects clicks/hovers on the TRANSIENT internals of enhanced widgets:
          //  - Select2 / bootstrap-select: the container, search box, and results list
          //    are recreated every time the dropdown opens, so recording clicks on them
          //    produces steps that can't be replayed.
          //  - Datepickers (bootstrap-datepicker, daterangepicker, jQuery UI, flatpickr,
          //    datetimepicker): calendar day/month cells are transient too.
          // For all of these the real, replayable action is the native <select>/<input>
          // firing a `change` event â which we capture separately. So we SKIP recording
          // any raw interaction that happens inside these widget internals.
          function isTransientWidgetInternal(el: any): boolean {
            return !!closestMatch(el, (node: any) => {
              if (
                hasClassLike(
                  node,
                  /select2-(results|dropdown|search|container|selection)/i,
                )
              )
                return true;
              // bootstrap-select (selectpicker) wrapper â its toggle button, search
              // box and option list are all internal; the real action is the native
              // <select> change captured via the jQuery listener below.
              if (hasClassLike(node, /(^|\s)bootstrap-select(\s|$)/i)) return true;
              if (
                hasClassLike(
                  node,
                  /(^|\s)(datepicker|datepicker-dropdown|daterangepicker|flatpickr-calendar|ui-datepicker|bootstrap-datetimepicker-widget)(\s|$)/i,
                )
              )
                return true;
              // bootstrap-select search box
              if (hasClassLike(node, /(^|\s)bs-searchbox(\s|$)/i)) return true;
              return false;
            });
          }

          // Track hover with dwell-time: only capture elements user intentionally hovers on
          let lastHoverSelector = "";
          let lastHoverTime = 0;
          let hoverTimer: any = null;
          let hoverCandidate: any = null;

          // CLICK events
          document.addEventListener(
            "click",
            (e: any) => {
              let el = e.target;
              if (!el || el.tagName === "HTML" || el.tagName === "BODY") return;
              // Skip clicks inside Select2/bootstrap-select/datepicker internals â
              // the native <select>/<input> change event captures the real action.
              if (isTransientWidgetInternal(el)) return;
              el = getInteractiveElement(el);
              // Do NOT record a click on a text-entry control (text input /
              // textarea / select). Clicking into a field is not an action â if
              // the user actually types or picks a value, the change event
              // records the real fill/select/check step.
              if (isTextEntryControl(el)) return;
              const selector = getSelector(el);
              const xpath = getXPath(el);
              const label = getLabel(el);

              record({
                action: "click",
                selector,
                xpath,
                label,
                tag: el.tagName.toLowerCase(),
                value: "",
              });
            },
            true,
          );

          // Shared change handler. Deduplicates rapid duplicate changes on the same
          // element (native + jQuery listeners can both fire for one selection).
          let lastChangeSig = "";
          let lastChangeTime = 0;
          function recordChange(el: any) {
            if (!el || !el.tagName) return;

            // Reject changes that arrive before the user has interacted with
            // this page at all (page-load init triggers) or absurdly long
            // after the last interaction. The window is WIDE on purpose so
            // cascade AJAX (dependent dropdowns, auto-calculated fields) that
            // completes several seconds after the user's click is still
            // recorded.
            if (!hasRecentUserGesture()) return;

            const action =
              el.tagName === "SELECT"
                ? "select"
                : el.type === "checkbox"
                  ? "check"
                  : "fill";

            // For <select> (including Select2/bootstrap-select, which keep a real
            // underlying <select>), record the VISIBLE option text rather than the
            // option's value code, so replay can match by label.
            let recordedValue = el.value || "";
            if (el.tagName === "SELECT") {
              const opt = el.options && el.options[el.selectedIndex];
              const optText = opt && (opt.textContent || "").trim();
              if (optText) recordedValue = optText;

              // Skip placeholder / no-choice selections (VALUE-based check â
              // an option with a real value is recorded even if its text is
              // "None"/"Choose"; cascade resets land on the empty-value
              // placeholder and are filtered).
              if (isPlaceholderChoice(el, recordedValue)) return;
            }

            // Skip empty text fills â a change with an empty value on a text
            // control is a blur/reset artifact, not an intentional entry.
            if (action === "fill" && !(recordedValue || "").trim()) return;

            const selector = getSelector(el);
            const xpath = getXPath(el);
            const label =
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("name") ||
              el.id ||
              (el.innerText || "").trim().slice(0, 40) ||
              "";

            // Dedupe: same element + same value within 400ms = one logical change
            const sig = `${selector}|${action}|${recordedValue}`;
            const now = Date.now();
            if (sig === lastChangeSig && now - lastChangeTime < 400) return;
            lastChangeSig = sig;
            lastChangeTime = now;

            record({
              action,
              selector,
              xpath,
              label,
              tag: el.tagName.toLowerCase(),
              value: recordedValue,
            });
          }

          // CHANGE events (native): select, checkbox, filled inputs that lost focus.
          // Skip changes coming from widget internals (bs-searchbox input etc.) â
          // but NEVER skip the native <select>, which lives inside the
          // .bootstrap-select wrapper and is the one replayable action we need.
          document.addEventListener(
            "change",
            (e: any) => {
              const el = e.target;
              if (
                el &&
                el.tagName !== "SELECT" &&
                isTransientWidgetInternal(el)
              )
                return;
              recordChange(el);
            },
            true,
          );

          // CHANGE events (jQuery): bootstrap-select and Select2 update their hidden
          // <select> via `$(el).trigger('change')`, which does NOT emit a native DOM
          // event â so addEventListener('change') never sees it. Bind a jQuery
          // delegated listener as soon as jQuery is available to capture these.
          // (Init-time programmatic triggers are filtered inside recordChange via
          // the gesture check; cascade-driven changes pass because a gesture
          // preceded them.)
          (function bindJqueryChange() {
            const jq = (window as any).jQuery || (window as any).$;
            if (jq && jq.fn && typeof jq.fn.on === "function") {
              try {
                // Delegated on document so it survives DOM re-renders; namespaced to
                // avoid double-binding across SPA navigations.
                jq(document)
                  .off("change.__recorder")
                  .on("change.__recorder", "select, input, textarea", function (
                    this: any,
                  ) {
                    // Same guard as the native listener â ignore the live-search
                    // input and other widget internals, but keep the native <select>.
                    if (
                      this.tagName !== "SELECT" &&
                      isTransientWidgetInternal(this)
                    )
                      return;
                    recordChange(this);
                  });
              } catch {}
              return;
            }
            // jQuery not loaded yet â retry shortly (bounded so we don't poll forever)
            if (((window as any).__jqBindTries || 0) < 40) {
              (window as any).__jqBindTries =
                ((window as any).__jqBindTries || 0) + 1;
              setTimeout(bindJqueryChange, 250);
            }
          })();

          // HOVER events â only capture elements the user intentionally hovers on (dwell time >= 500ms)
          document.addEventListener(
            "mouseover",
            (e: any) => {
              let el = e.target;
              if (!el || el.tagName === "HTML" || el.tagName === "BODY") return;
              // Skip hovers over Select2/bootstrap-select/datepicker internals
              if (isTransientWidgetInternal(el)) return;

              // Walk up to find the nearest interactive/meaningful parent element
              const interactiveTags = [
                "A",
                "BUTTON",
                "INPUT",
                "SELECT",
                "TEXTAREA",
                "LABEL",
              ];
              let interactiveEl = null;
              let current = el;
              while (
                current &&
                current.tagName !== "HTML" &&
                current.tagName !== "BODY"
              ) {
                const isInteractive =
                  interactiveTags.includes(current.tagName) ||
                  current.getAttribute("role") ||
                  current.getAttribute("title") ||
                  current.getAttribute("data-tooltip") ||
                  current.getAttribute("aria-label") ||
                  current.onclick ||
                  (current.className &&
                    typeof current.className === "string" &&
                    /btn|button|link|menu|nav|tab|hover|dropdown/i.test(
                      current.className,
                    )) ||
                  window.getComputedStyle(current).cursor === "pointer";
                if (isInteractive) {
                  interactiveEl = current;
                  break;
                }
                current = current.parentElement;
              }

              if (!interactiveEl) return;
              el = interactiveEl;

              // The interactive ancestor we resolved to may itself be a widget
              // internal (e.g. the .dropdown-toggle button inside .bootstrap-select).
              if (isTransientWidgetInternal(el)) return;

              // Never record hovers over form fields or their labels â resting
              // the mouse on a field while reading the form is not an action.
              // Hovers remain recorded for menus / nav / tooltip triggers.
              if (
                ["INPUT", "SELECT", "TEXTAREA", "LABEL", "OPTION"].includes(
                  el.tagName,
                )
              )
                return;

              // Cancel any pending hover recording since user moved to a different element
              if (hoverTimer) {
                clearTimeout(hoverTimer);
                hoverTimer = null;
                hoverCandidate = null;
              }

              const selector = getSelector(el);

              // Debounce: skip if same element hovered within 1 second
              const now = Date.now();
              if (selector === lastHoverSelector && now - lastHoverTime < 1000)
                return;

              // Start dwell timer â only record if user stays on this element for 500ms
              hoverCandidate = el;
              hoverTimer = setTimeout(() => {
                if (hoverCandidate === el) {
                  lastHoverSelector = selector;
                  lastHoverTime = Date.now();
                  const label = getLabel(el);
                  const xpath = getXPath(el);

                  // Capture surrounding text context from the element and its neighbors
                  let surroundingText = "";
                  try {
                    const parts: string[] = [];
                    // Text from previous sibling
                    const prev = el.previousElementSibling;
                    if (prev) {
                      const t = (
                        prev.innerText ||
                        prev.textContent ||
                        ""
                      ).trim();
                      if (t) parts.push(t.slice(0, 80));
                    }
                    // Text from the element itself (including nested children)
                    const own = (el.innerText || el.textContent || "").trim();
                    if (own) parts.push(own.slice(0, 120));
                    // Text from next sibling
                    const next = el.nextElementSibling;
                    if (next) {
                      const t = (
                        next.innerText ||
                        next.textContent ||
                        ""
                      ).trim();
                      if (t) parts.push(t.slice(0, 80));
                    }
                    // If element has no text, check parent for context
                    if (!own && el.parentElement) {
                      const parentText = (
                        el.parentElement.innerText ||
                        el.parentElement.textContent ||
                        ""
                      ).trim();
                      if (parentText) parts.push(parentText.slice(0, 120));
                    }
                    surroundingText = parts.filter(Boolean).join(" | ");
                  } catch {}

                  record({
                    action: "hover",
                    selector,
                    xpath,
                    label,
                    tag: el.tagName.toLowerCase(),
                    value: surroundingText,
                  });
                }
                hoverTimer = null;
                hoverCandidate = null;
              }, 500);
            },
            true,
          );

          // Cancel hover recording if user leaves the element before dwell time
          document.addEventListener(
            "mouseout",
            (e: any) => {
              const el = e.target;
              if (hoverCandidate && hoverTimer) {
                // Check if the mouse moved outside the hover candidate
                const related = e.relatedTarget;
                if (!related || !hoverCandidate.contains(related)) {
                  clearTimeout(hoverTimer);
                  hoverTimer = null;
                  hoverCandidate = null;
                }
              }
            },
            true,
          );

          // NOTE: the FOCUS listener has been removed on purpose. It recorded a
          // step for every INPUT/SELECT/TEXTAREA that received focus â including
          // tab-through navigation and auto-focus on page load. Real interactions
          // are fully covered by the change (fill/select/check) events.

          // DOUBLE-CLICK events
          document.addEventListener(
            "dblclick",
            (e: any) => {
              let el = e.target;
              if (!el || el.tagName === "HTML" || el.tagName === "BODY") return;
              if (isTransientWidgetInternal(el)) return;
              el = getInteractiveElement(el);
              // Same rule as click: double-clicking inside a text field (e.g. to
              // select a word before retyping) is not a step â the change event
              // captures the eventual fill.
              if (isTextEntryControl(el)) return;
              const selector = getSelector(el);
              const xpath = getXPath(el);
              const label = getLabel(el);
              record({
                action: "dblclick",
                selector,
                xpath,
                label,
                tag: el.tagName.toLowerCase(),
                value: "",
              });
            },
            true,
          );

          // KEYDOWN events for special keys (Enter, Escape). Tab is not recorded â
          // tabbing between fields is navigation, not an action.
          document.addEventListener(
            "keydown",
            (e: any) => {
              if (["Enter", "Escape"].includes(e.key)) {
                const el = e.target;
                // Pressing Enter inside the bootstrap-select/Select2 live-search
                // box selects the highlighted option â the resulting <select>
                // change is captured separately.
                if (el && isTransientWidgetInternal(el)) return;
                const selector = el ? getSelector(el) : "body";
                const xpath = el ? getXPath(el) : "/html/body";
                const label = el ? el.getAttribute("name") || el.id || "" : "";
                record({
                  action: "press",
                  selector,
                  xpath,
                  label,
                  tag: el?.tagName?.toLowerCase() || "body",
                  value: e.key,
                });
              }
            },
            true,
          );

          // RIGHT-CLICK / CONTEXT MENU events
          document.addEventListener(
            "contextmenu",
            (e: any) => {
              let el = e.target;
              if (!el || el.tagName === "HTML" || el.tagName === "BODY") return;
              if (isTransientWidgetInternal(el)) return;
              el = getInteractiveElement(el);
              // Right-clicking a text field (paste menu) is not a step either â
              // the pasted value arrives via the change event.
              if (isTextEntryControl(el)) return;
              const selector = getSelector(el);
              const xpath = getXPath(el);
              const label = getLabel(el);
              record({
                action: "rightclick",
                selector,
                xpath,
                label,
                tag: el.tagName.toLowerCase(),
                value: "",
              });
            },
            true,
          );

          // SCROLL events (debounced, on scrollable containers)
          let scrollTimer: any = null;
          document.addEventListener(
            "scroll",
            (e: any) => {
              if (scrollTimer) clearTimeout(scrollTimer);
              scrollTimer = setTimeout(() => {
                const el =
                  e.target === document ? document.documentElement : e.target;
                if (!el) return;
                // Scrolling the option list inside an open bootstrap-select /
                // Select2 dropdown is a transient internal â skip it.
                if (
                  el !== document.documentElement &&
                  isTransientWidgetInternal(el)
                )
                  return;
                const selector =
                  el === document.documentElement ? "html" : getSelector(el);
                const xpath =
                  el === document.documentElement ? "/html" : getXPath(el);
                record({
                  action: "scroll",
                  selector,
                  xpath,
                  label: "",
                  tag: el.tagName?.toLowerCase() || "html",
                  value: `${el.scrollTop || window.scrollY}`,
                });
              }, 500);
            },
            true,
          );

          // NAVIGATION / URL capture â track URL changes (login redirects, SPA route changes)
          let lastCapturedUrl = window.location.href;

          // Record the initial page URL
          record({
            action: "navigate",
            selector: "",
            xpath: "",
            label: document.title || "",
            tag: "page",
            value: window.location.href,
          });

          // Detect URL changes via popstate (back/forward) and pushState/replaceState overrides
          const originalPushState = history.pushState;
          const originalReplaceState = history.replaceState;

          function captureUrlChange() {
            const currentUrl = window.location.href;
            if (currentUrl !== lastCapturedUrl) {
              lastCapturedUrl = currentUrl;
              record({
                action: "navigate",
                selector: "",
                xpath: "",
                label: document.title || "",
                tag: "page",
                value: currentUrl,
              });
            }
          }

          history.pushState = function (...args: any[]) {
            originalPushState.apply(this, args);
            captureUrlChange();
          };

          history.replaceState = function (...args: any[]) {
            originalReplaceState.apply(this, args);
            captureUrlChange();
          };

          window.addEventListener("popstate", captureUrlChange);
          window.addEventListener("hashchange", captureUrlChange);

          // Also poll for URL changes (catches edge cases like meta-refresh or framework routers)
          setInterval(captureUrlChange, 1000);
        });

        const page = await context.newPage();
        await page.goto(url.match(/^https?:\/\//) ? url : `http://${url}`, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        // Capture server-side navigation events (full page loads after login, redirects)
        page.on("framenavigated", async (frame) => {
          if (frame === page.mainFrame()) {
            const url = frame.url();
            if (url && url !== "about:blank") {
              let existing: any[] = [];
              try {
                existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
              } catch {}
              existing.push({
                action: "navigate",
                selector: "",
                xpath: "",
                label: "",
                tag: "page",
                value: url,
              });
              fs.writeFileSync(filePath, JSON.stringify(existing), "utf8");
            }
          }
        });

        // Also capture new pages (popups/tabs opened after login)
        context.on("page", async (newPage) => {
          const url = newPage.url();
          if (url && url !== "about:blank") {
            let existing: any[] = [];
            try {
              existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
            } catch {}
            existing.push({
              action: "navigate",
              selector: "",
              xpath: "",
              label: "new_tab",
              tag: "page",
              value: url,
            });
            fs.writeFileSync(filePath, JSON.stringify(existing), "utf8");
          }
        });

        // Flush captured actions to file every 3 seconds (survives browser crash)
        async function flushActions() {
          try {
            const pages = context.pages();
            if (pages.length === 0) return;
            const activePage = pages[pages.length - 1];
            const newActions = await activePage.evaluate(() => {
              const a = (window as any).__recordedActions || [];
              (window as any).__recordedActions = [];
              return a;
            });
            if (newActions.length > 0) {
              let existing: any[] = [];
              try {
                existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
              } catch {}
              fs.writeFileSync(
                filePath,
                JSON.stringify([...existing, ...newActions]),
                "utf8",
              );
            }
          } catch {}
        }

        const flushInterval = setInterval(flushActions, 3000);

        // Cleanup on browser close (user closes window)
        browser.on("disconnected", async () => {
          clearInterval(flushInterval);
          await flushActions();
          activeSessions.delete(projectId);
        });
      } catch (err: any) {
        console.error("Recorder launch error:", err.message);
        activeSessions.delete(projectId);
      }
    })();

    return {
      status: "RECORDING",
      message:
        "ð¬ Browser opening... Perform your actions, then click Done Recording.",
      projectId,
    };
  }

  @Post("stop")
  async stopRecording(@Body() body?: { projectId?: string; name?: string }) {
    const projectId = body?.projectId || "default";
    const scriptName = body?.name;

    // Close browser if still open
    if (activeSessions.has(projectId)) {
      try {
        await activeSessions.get(projectId).close();
      } catch {}
      activeSessions.delete(projectId);
    }

    // Wait a moment for final flush
    await new Promise((r) => setTimeout(r, 500));

    // Read captured actions from temp file (works even if browser crashed)
    const filePath = actionsFilePath(projectId);
    let allActions: any[] = [];
    if (fs.existsSync(filePath)) {
      try {
        allActions = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {}
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }

    // Auto-create field configs from captured actions as a NEW script
    // Each recording creates its own test case â previous recordings are preserved
    let fieldCount = 0;
    let scriptId: any = null;
    let resolvedScriptName: string | null = null;
    if (projectId !== "default" && allActions.length > 0) {
      try {
        const result = await this.fieldConfigService.createFromRecordedActions(
          projectId,
          allActions,
          scriptName,
        );
        fieldCount = result.fieldCount;
        scriptId = result.scriptId;
        resolvedScriptName = result.scriptName;
      } catch {}
    }

    // Save raw recording to file
    const runId = Date.now().toString();
    const recordingPath = path.join(RECORDINGS_DIR, `${runId}.json`);
    fs.writeFileSync(
      recordingPath,
      JSON.stringify(
        {
          id: runId,
          projectId,
          scriptId,
          scriptName: resolvedScriptName,
          actions: allActions,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    return {
      runId,
      scriptId,
      scriptName: resolvedScriptName,
      status: "STOPPED",
      fieldCount,
      totalActions: allActions.length,
      message:
        fieldCount > 0
          ? `â Captured ${allActions.length} actions â ${fieldCount} fields saved as "${resolvedScriptName}". Script visible in Test Cases & Field Management.`
          : allActions.length > 0
            ? `â Captured ${allActions.length} actions (no project ID to save fields).`
            : "â ï¸ No actions captured. Did you interact with the app?",
    };
  }

  @Get("status")
  getStatus() {
    const sessions = Array.from(activeSessions.keys());
    if (sessions.length === 0)
      return { status: "IDLE", message: "No active recording" };
    return { status: "RECORDING", activeSessions: sessions };
  }
}
