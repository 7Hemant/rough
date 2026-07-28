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
              if (hasClassLike(node, /(^|\s)bootstrap-select(\s|$)/i))
                return true;
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

          // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
          // FIX (extra recorded fill/select steps for fields the user never touched):
          //
          // ROOT CAUSE: our change listeners (especially the delegated jQuery one)
          // captured PROGRAMMATIC change events, not just user ones:
          //   1. On page load, bootstrap-select / Select2 / datepickers initialize and
          //      call $(el).trigger('change') or dispatchEvent(new Event('change')) on
          //      every field they enhance â a burst of fill/select records at start.
          //   2. Cascading dropdowns (State â City): when the user picks a State, the
          //      app resets/reloads the City select and triggers 'change' on it â an
          //      extra select/fill step for City that the user never performed.
          //   3. Autofocus / programmatic .focus() on load recorded bogus focus steps.
          //
          // FIX: track REAL user gestures (trusted pointerdown/keydown). A change is
          // recorded only if it is user-initiated:
          //   - native change with event.isTrusted === true, OR
          //   - it fired shortly after a real gesture AND that gesture landed on the
          //     element itself, an ancestor (bootstrap-select wraps the select), the
          //     widget sibling (Select2/Chosen/jQuery-UI render a sibling container),
          //     or an enhanced-widget popup (Select2 dropdown / datepicker calendar is
          //     appended to <body>, so it's neither ancestor nor sibling).
          // Additionally, untrusted changes carrying an EMPTY value are dropped â
          // that's the signature of a cascade reset, never of a user action.
          // ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
          let lastUserGestureTs = 0;
          let lastGestureInWidgetUi = false;
          const touchedNodes: any =
            typeof WeakSet !== "undefined" ? new WeakSet() : null;

          function markUserGesture(e: any) {
            if (!e.isTrusted) return;
            lastUserGestureTs = Date.now();
            // Was this gesture inside an enhanced widget's UI (possibly appended to
            // <body>)? If yes, a change firing right after on a hidden <select> or a
            // readonly date input is legitimately user-initiated.
            try {
              lastGestureInWidgetUi = !!(
                e.target &&
                e.target.closest &&
                e.target.closest(
                  ".select2-container, .select2-dropdown, .bootstrap-select, " +
                    ".chosen-container, .ui-selectmenu-menu, .ui-selectmenu-button, " +
                    ".datepicker, .daterangepicker, .flatpickr-calendar, " +
                    ".ui-datepicker, .bootstrap-datetimepicker-widget, .dropdown-menu",
                )
              );
            } catch {
              lastGestureInWidgetUi = false;
            }
            // Mark the touched element + its ancestors (bounded walk)
            if (touchedNodes) {
              let n = e.target;
              let depth = 0;
              while (n && n.nodeType === 1 && depth++ < 25) {
                touchedNodes.add(n);
                n = n.parentElement;
              }
            }
          }
          document.addEventListener("pointerdown", markUserGesture, true);
          document.addEventListener("keydown", markUserGesture, true);

          function isUserInitiatedChange(el: any, nativeEvent: any): boolean {
            // Trusted native change = definitely the user (typed in an input and
            // blurred, or picked in a native <select>).
            if (nativeEvent && nativeEvent.isTrusted) return true;
            // No real user gesture recently â widget init / page-load programmatic
            // change â never record it.
            if (Date.now() - lastUserGestureTs > 1500) return false;
            if (!touchedNodes) return true; // very old browser â keep old behavior
            // Gesture landed on the element or an ancestor (covers plain inputs and
            // bootstrap-select, whose wrapper CONTAINS the native <select>).
            let n = el;
            let depth = 0;
            while (n && n.nodeType === 1 && depth++ < 25) {
              if (touchedNodes.has(n)) return true;
              n = n.parentElement;
            }
            // Select2 / Chosen / jQuery-UI selectmenu render the visible widget as a
            // SIBLING right after the hidden <select>.
            const sib = el.nextElementSibling;
            if (
              sib &&
              /select2|chosen|ui-selectmenu/i.test(sib.className || "") &&
              touchedNodes.has(sib)
            )
              return true;
            // Widget popups appended to <body> (Select2 dropdown, datepicker
            // calendar): the gesture can't be linked via DOM ancestry â accept the
            // change if the last gesture was inside a widget UI.
            if (lastGestureInWidgetUi) return true;
            return false;
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
          function recordChange(el: any, trusted?: boolean) {
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
              const opt = el.options && el.options[el.selectedIndex];
              const optText = opt && (opt.textContent || "").trim();
              if (optText) recordedValue = optText;
            }

            // FIX: an untrusted (programmatic) change with an EMPTY value is a
            // cascade reset (State picked â City cleared+reloaded â trigger('change'))
            // or a widget clearing itself â never a user action. Don't record it.
            if (!trusted && !recordedValue && el.type !== "checkbox") return;

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
          // FIX (bootstrap-select live search): the search box inside .bs-searchbox is
          // an <input> â typing in it fires a change on blur, which used to be recorded
          // as a broken `fill` step (the search box doesn't exist when the dropdown is
          // closed). Skip changes coming from widget internals â BUT never skip the
          // native <select> itself, since it lives INSIDE the .bootstrap-select wrapper
          // and its change event is the one replayable action we need.
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
              // FIX: apps can dispatchEvent(new Event('change')) programmatically on
              // fields the user never touched (init, cascades) â gate on user intent.
              if (!isUserInitiatedChange(el, e)) return;
              recordChange(el, e.isTrusted);
            },
            true,
          );

          // CHANGE events (jQuery): bootstrap-select and Select2 update their hidden
          // <select> via `$(el).trigger('change')`, which does NOT emit a native DOM
          // event â so addEventListener('change') never sees it. Bind a jQuery
          // delegated listener as soon as jQuery is available to capture these.
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
                      // FIX: same guard as the native listener â ignore the live-search
                      // input and other widget internals, but keep the native <select>.
                      if (
                        this.tagName !== "SELECT" &&
                        isTransientWidgetInternal(this)
                      )
                        return;
                      // FIX: jQuery-triggered changes are ALWAYS programmatic events â
                      // widgets fire them on init and on cascade resets for fields the
                      // user never touched. Only record if a real user gesture caused it.
                      if (!isUserInitiatedChange(this, null)) return;
                      recordChange(this, false);
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

              // FIX: the interactive ancestor we resolved to may itself be a widget
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
          document.addEventListener(
            "focus",
            (e: any) => {
              const el = e.target;
              if (!el) return;
              // Skip focus on the Select2/bootstrap-select search box internals
              if (isTransientWidgetInternal(el)) return;
              const focusableTags = ["INPUT", "SELECT", "TEXTAREA"];
              if (!focusableTags.includes(el.tagName)) return;
              // FIX: autofocus / programmatic el.focus() on page load fires focus
              // events too (and they are "trusted" â the browser dispatches them).
              // Only record focus that follows a real user gesture (Tab keydown or a
              // pointer press), so init-time focus doesn't create extra steps.
              if (Date.now() - lastUserGestureTs > 1500) return;
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
              if (["Enter", "Tab", "Escape"].includes(e.key)) {
                const el = e.target;
                // FIX: pressing Enter inside the bootstrap-select/Select2 live-search
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
                // FIX: scrolling the option list inside an open bootstrap-select /
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
