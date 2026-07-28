async startRecording(url?: string, name?: string, projectId?: string) {
    const resolvedProjectId = projectId || "default";

    // If no URL provided, resolve from project's baseUrl
    let resolvedUrl = url;
    if (!resolvedUrl && resolvedProjectId !== "default") {
      const project = await this.projectModel
        .findById(resolvedProjectId)
        .lean();
      resolvedUrl = project?.baseUrl;
    }
    if (!resolvedUrl) {
      return {
        status: "ERROR",
        message: "No URL provided and project has no baseUrl configured",
      };
    }

    // Close any existing session
    if (activeSessions.has(resolvedProjectId)) {
      try {
        await activeSessions.get(resolvedProjectId).close();
      } catch {}
      activeSessions.delete(resolvedProjectId);
    }

    // Initialize temp file for actions
    const filePath = actionsFilePath(resolvedProjectId);
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
        activeSessions.set(resolvedProjectId, browser);

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

          // ================================================================
          // FIX (extra fields): track REAL user activity. Programmatic form
          // initialization, cascading dropdowns, and plugins firing
          // $(el).trigger('change') on page load used to be recorded as
          // fill/select steps the user never performed. We only record
          // untrusted/jQuery changes that happen shortly after real input.
          // ================================================================
          let lastUserInput = 0;
          ["pointerdown", "keydown", "touchstart"].forEach((t) =>
            document.addEventListener(
              t,
              () => {
                lastUserInput = Date.now();
              },
              true,
            ),
          );

          // FIX (slowness): getComputedStyle forces style recalculation.
          // Never call it per-ancestor inside walk-up loops â only once,
          // on the original event target, as a last resort.
          function isPointerCursor(el: any): boolean {
            try {
              return window.getComputedStyle(el).cursor === "pointer";
            } catch {
              return false;
            }
          }

          function isInteractiveNode(node: any): boolean {
            const interactiveTags = [
              "A",
              "BUTTON",
              "INPUT",
              "SELECT",
              "TEXTAREA",
              "LABEL",
              "LI",
            ];
            return !!(
              interactiveTags.includes(node.tagName) ||
              node.getAttribute("role") ||
              node.getAttribute("title") ||
              node.getAttribute("data-tooltip") ||
              node.getAttribute("aria-label") ||
              node.getAttribute("data-testid") ||
              node.onclick ||
              (node.className &&
                typeof node.className === "string" &&
                /btn|button|link|menu|nav|tab|hover|dropdown|card|item|option|select/i.test(
                  node.className,
                ))
            );
          }

          function getInteractiveElement(start: any): any {
            // Cheap checks up the chain (no style recalc per ancestor)
            let current = start;
            while (
              current &&
              current.tagName !== "HTML" &&
              current.tagName !== "BODY"
            ) {
              if (isInteractiveNode(current)) return current;
              current = current.parentElement;
            }
            // Last resort: single computed-style check on the target only
            if (isPointerCursor(start)) return start;
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
          // Used for click/hover/focus/keydown/scroll ONLY â see isSearchInternal
          // below for change events.
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
              if (hasClassLike(node, /(^|\s)bootstrap-select(\s|$)/i))
                return true;
              if (
                hasClassLike(
                  node,
                  /(^|\s)(datepicker-dropdown|daterangepicker|flatpickr-calendar|ui-datepicker|bootstrap-datetimepicker-widget)(\s|$)/i,
                )
              )
                return true;
              // Standalone datepicker CALENDAR panels (not the input itself):
              // bootstrap-datepicker renders <div class="datepicker"> as the popup.
              // Only treat DIV/TABLE containers as internal so an
              // <input class="datepicker"> is never skipped.
              if (
                hasClassLike(node, /(^|\s)datepicker(\s|$)/i) &&
                node.tagName !== "INPUT" &&
                node.tagName !== "SELECT" &&
                node.tagName !== "TEXTAREA"
              )
                return true;
              // bootstrap-select search box
              if (hasClassLike(node, /(^|\s)bs-searchbox(\s|$)/i)) return true;
              return false;
            });
          }

          // ================================================================
          // FIX (dropdowns not recording): change events need a NARROWER
          // filter than clicks/hovers. The old code ran change events through
          // isTransientWidgetInternal, which meant:
          //   - <input class="datepicker"> matched the datepicker regex, so
          //     picking a date never recorded a fill step.
          //   - inputs living inside a widget wrapper were silently dropped.
          // For change events, the ONLY thing to skip is the live-search box
          // inside Select2 / bootstrap-select. Real form controls always record.
          // ================================================================
          function isSearchInternal(el: any): boolean {
            return !!closestMatch(el, (n: any) =>
              hasClassLike(n, /bs-searchbox|select2-search/i),
            );
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
            const selector = getSelector(el);
            const xpath = getXPath(el);
            const label =
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("name") ||
              el.id ||
              (el.innerText || "").trim().slice(0, 40) ||
              "";
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
              // FIX: multi-selects used to record only el.value (first selected
              // option). Record ALL selected option labels, joined with "||".
              if (el.multiple) {
                recordedValue = Array.from(el.selectedOptions || [])
                  .map((o: any) => (o.textContent || "").trim())
                  .filter(Boolean)
                  .join("||");
              } else {
                const opt = el.options && el.options[el.selectedIndex];
                const optText = opt && (opt.textContent || "").trim();
                if (optText) recordedValue = optText;
              }
            }

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
          // FIX (extra fields): e.isTrusted === false means the page's own script
          // dispatched the event (form init, cascading dropdowns) â the user did
          // nothing, so don't record it.
          // FIX (dropdowns): use the narrow isSearchInternal filter so datepicker
          // inputs and other real controls inside widget wrappers still record.
          document.addEventListener(
            "change",
            (e: any) => {
              if (e.isTrusted === false) return;
              const el = e.target;
              if (el && el.tagName !== "SELECT" && isSearchInternal(el)) return;
              recordChange(el);
            },
            true,
          );

          // CHANGE events (jQuery): bootstrap-select and Select2 update their hidden
          // <select> via `$(el).trigger('change')`, which does NOT emit a native DOM
          // event â so addEventListener('change') never sees it. Bind a jQuery
          // delegated listener as soon as jQuery is available to capture these.
          // FIX (extra fields): trigger('change') is never "trusted", so instead
          // require that REAL user input happened within the last 1.5s. Changes
          // fired during page load / programmatic cascades are ignored.
          (function bindJqueryChange() {
            const jq = (window as any).jQuery || (window as any).$;
            if (jq && jq.fn && typeof jq.fn.on === "function") {
              try {
                // Delegated on document so it survives DOM re-renders; namespaced to
                // avoid double-binding across SPA navigations.
                jq(document)
                  .off("change.__recorder")
                  .on(
                    "change.__recorder",
                    "select, input, textarea",
                    function (this: any) {
                      if (Date.now() - lastUserInput > 1500) return;
                      if (
                        this.tagName !== "SELECT" &&
                        isSearchInternal(this)
                      )
                        return;
                      recordChange(this);
                    },
                  );
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

          // HOVER events â only capture elements the user intentionally hovers on
          // (dwell time >= 500ms).
          // FIX (slowness): the old handler ran on EVERY element the cursor passed
          // over and called getComputedStyle per ancestor â hundreds of forced
          // style recalcs per second on heavy pages. Now: throttled to one check
          // per 150ms, and computed style is checked at most ONCE per event.
          let lastMouseoverCheck = 0;
          document.addEventListener(
            "mouseover",
            (e: any) => {
              const nowT = Date.now();
              if (nowT - lastMouseoverCheck < 150) return;
              lastMouseoverCheck = nowT;

              let el = e.target;
              if (!el || el.tagName === "HTML" || el.tagName === "BODY") return;
              // Skip hovers over Select2/bootstrap-select/datepicker internals
              if (isTransientWidgetInternal(el)) return;

              // Walk up to find the nearest interactive/meaningful parent element
              // using CHEAP checks only (tags/attrs/classes â no style recalc).
              const hoverTags = [
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
                  hoverTags.includes(current.tagName) ||
                  current.getAttribute("role") ||
                  current.getAttribute("title") ||
                  current.getAttribute("data-tooltip") ||
                  current.getAttribute("aria-label") ||
                  current.onclick ||
                  (current.className &&
                    typeof current.className === "string" &&
                    /btn|button|link|menu|nav|tab|hover|dropdown/i.test(
                      current.className,
                    ));
                if (isInteractive) {
                  interactiveEl = current;
                  break;
                }
                current = current.parentElement;
              }

              // Single computed-style check on the original target only,
              // as a last resort when no interactive ancestor was found.
              if (!interactiveEl && isPointerCursor(e.target)) {
                interactiveEl = e.target;
              }

              if (!interactiveEl) return;
              el = interactiveEl;

              // The interactive ancestor we resolved to may itself be a widget
              // internal (e.g. the .dropdown-toggle button inside .bootstrap-select).
              // Re-check after walking up so those don't get recorded as hover steps.
              if (isTransientWidgetInternal(el)) return;

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

          // FOCUS events (tabbing into fields)
          // FIX (extra fields): the old handler recorded EVERY focus â including
          // the focus that accompanies a click (duplicating steps) and programmatic
          // el.focus() calls the user never performed. Now only keyboard tabbing
          // records a focus step.
          let tabPressed = false;
          document.addEventListener(
            "focus",
            (e: any) => {
              const el = e.target;
              if (!el) return;
              if (!tabPressed) return;
              tabPressed = false;
              // Skip focus on the Select2/bootstrap-select search box internals
              if (isTransientWidgetInternal(el)) return;
              const focusableTags = ["INPUT", "SELECT", "TEXTAREA"];
              if (!focusableTags.includes(el.tagName)) return;
              const selector = getSelector(el);
              const xpath = getXPath(el);
              const label =
                el.getAttribute("aria-label") ||
                el.getAttribute("placeholder") ||
                el.getAttribute("name") ||
                el.id ||
                "";
              record({
                action: "focus",
                selector,
                xpath,
                label,
                tag: el.tagName.toLowerCase(),
                value: "",
              });
            },
            true,
          );

          // DOUBLE-CLICK events
          document.addEventListener(
            "dblclick",
            (e: any) => {
              let el = e.target;
              if (!el || el.tagName === "HTML" || el.tagName === "BODY") return;
              if (isTransientWidgetInternal(el)) return;
              el = getInteractiveElement(el);
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

          // KEYDOWN events for special keys (Enter, Tab, Escape)
          document.addEventListener(
            "keydown",
            (e: any) => {
              // Track Tab so the focus handler only records keyboard tabbing
              if (e.key === "Tab") tabPressed = true;
              if (["Enter", "Tab", "Escape"].includes(e.key)) {
                const el = e.target;
                // Pressing Enter inside the bootstrap-select/Select2 live-search
                // box selects the highlighted option â the resulting <select> change
                // is captured separately. Recording the keypress itself would create
                // an unreplayable step targeting the transient search input.
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

          history.pushState = function (
            this: History,
            ...args: [data: unknown, unused: string, url?: string | URL | null]
          ) {
            originalPushState.apply(
              this,
              args as Parameters<typeof history.pushState>,
            );
            captureUrlChange();
          };

          history.replaceState = function (
            this: History,
            ...args: [data: unknown, unused: string, url?: string | URL | null]
          ) {
            originalReplaceState.apply(
              this,
              args as Parameters<typeof history.replaceState>,
            );
            captureUrlChange();
          };

          window.addEventListener("popstate", captureUrlChange);
          window.addEventListener("hashchange", captureUrlChange);

          // Also poll for URL changes (catches edge cases like meta-refresh or framework routers)
          setInterval(captureUrlChange, 1000);
        });

        // Node-side helper: append an action to the file, skipping duplicate
        // navigate entries (in-page capture + framenavigated + polling can all
        // report the same URL).
        function appendActionToFile(actionObj: any) {
          try {
            let existing: any[] = [];
            try {
              existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
            } catch {}
            if (actionObj.action === "navigate") {
              const lastNav = [...existing]
                .reverse()
                .find((a) => a.action === "navigate");
              if (lastNav && lastNav.value === actionObj.value) return;
            }
            existing.push(actionObj);
            fs.writeFileSync(filePath, JSON.stringify(existing), "utf8");
          } catch {}
        }

        const page = await context.newPage();
        await page.goto(
          resolvedUrl.match(/^https?:\/\//)
            ? resolvedUrl
            : `http://${resolvedUrl}`,
          {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          },
        );

        // Capture server-side navigation events (full page loads after login, redirects)
        page.on("framenavigated", async (frame) => {
          if (frame === page.mainFrame()) {
            const url = frame.url();
            if (url && url !== "about:blank") {
              appendActionToFile({
                action: "navigate",
                selector: "",
                xpath: "",
                label: "",
                tag: "page",
                value: url,
              });
            }
          }
        });

        // Also capture new pages (popups/tabs opened after login)
        context.on("page", async (newPage) => {
          const url = newPage.url();
          if (url && url !== "about:blank") {
            appendActionToFile({
              action: "navigate",
              selector: "",
              xpath: "",
              label: "new_tab",
              tag: "page",
              value: url,
            });
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
          activeSessions.delete(resolvedProjectId);
        });
      } catch (err: any) {
        console.error("Recorder launch error:", err.message);
        activeSessions.delete(resolvedProjectId);
      }
    })();

    return {
      status: "RECORDING",
      message:
        "ð¬ Browser opening... Perform your actions, then click Done Recording.",
      projectId: resolvedProjectId,
    };
  }
