// snapshot-dom.js — in-page observation engine for the Jev PoC.
// Injected and evaluated in every frame. Installs window.__jevFast per the
// registry contract in types.ts (FrameSnapshot). Plain browser JS, no
// imports, safe to re-evaluate in the same document (idempotent install).
(function () {
  if (window.__jevFast && window.__jevFast.installed) {
    // Already installed in this document lifetime: the existing closures
    // (nodes Map, snapshot fn) already preserve node indices across calls.
    // Re-evaluating this script is a no-op so we never fork the node
    // registry into two inconsistent copies.
    return;
  }

  var MAX_TEXT = 8000;
  var MAX_NAME = 200;

  var nodes = new Map(); // index -> element, stable within this document lifetime
  var elementToIndex = new WeakMap();
  var nextIndex = 1;
  var closedShadowHostSet = new WeakSet(); // avoid double counting across snapshot() calls

  function indexOf(el) {
    var existing = elementToIndex.get(el);
    if (existing !== undefined) return existing;
    var i = nextIndex++;
    nodes.set(i, el);
    elementToIndex.set(el, i);
    return i;
  }

  // ---- visibility -----------------------------------------------------

  function isDisplayNone(el) {
    var cs = getComputedStyleSafe(el);
    return !cs || cs.display === "none";
  }

  function getComputedStyleSafe(el) {
    try {
      return el.ownerDocument.defaultView.getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }

  function isVisibilityHidden(el) {
    var cs = getComputedStyleSafe(el);
    return !!cs && (cs.visibility === "hidden" || cs.visibility === "collapse");
  }

  // Walk ancestors (piercing shadow roots via getRootNode/host chain) to
  // decide whether el is excluded from accessibility because a container is
  // aria-hidden, display:none, or visibility:hidden. Visibility can be
  // reset by a descendant so it is not inherited the same way display is,
  // but for this PoC's "skip whole hidden subtrees" purpose walking up is
  // the cheap, honest approximation.
  function isHiddenSubtree(el) {
    var node = el;
    while (node) {
      if (node.nodeType === 1) {
        if (node.getAttribute && node.getAttribute("aria-hidden") === "true")
          return true;
        if (isDisplayNone(node)) return true;
      }
      var parent = node.parentElement;
      if (!parent) {
        var root = node.getRootNode ? node.getRootNode() : null;
        if (root && root.host) {
          node = root.host;
          continue;
        }
        break;
      }
      node = parent;
    }
    return false;
  }

  function ownerWindow(el) {
    return (el.ownerDocument && el.ownerDocument.defaultView) || window;
  }

  // Rect relative to this frame's own viewport (frame-local, per contract).
  function frameRect(el) {
    var r;
    try {
      r = el.getBoundingClientRect();
    } catch (e) {
      return null;
    }
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function isOnscreen(rect, win) {
    if (!rect) return false;
    var vw = win.innerWidth;
    var vh = win.innerHeight;
    return (
      rect.x + rect.width > 0 &&
      rect.y + rect.height > 0 &&
      rect.x < vw &&
      rect.y < vh
    );
  }

  // elementFromPoint piercing shadow roots: Element.prototype.elementFromPoint
  // on a ShadowRoot returns the deepest element inside that root; walk down
  // through any open shadow roots we land on.
  function deepElementFromPoint(doc, x, y) {
    var el = doc.elementFromPoint(x, y);
    var guardCount = 0;
    while (el && el.shadowRoot && guardCount < 20) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
      guardCount++;
    }
    return el;
  }

  function isInert(el) {
    var node = el;
    while (node) {
      if (node.nodeType === 1 && node.inert) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true")
      return true;
    return false;
  }

  // ---- accessible name (accname chain, see ACCNAME.md) -----------------

  function clampName(s) {
    s = (s || "").replace(/\s+/g, " ").trim();
    if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME - 1) + "…";
    return s;
  }

  function textFromIdRefs(doc, idList) {
    var ids = idList.trim().split(/\s+/).filter(Boolean);
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
      var ref = doc.getElementById(ids[i]);
      if (ref) parts.push(visibleTextContent(ref));
    }
    return parts.join(" ");
  }

  // Recursively collects visible text, piercing open shadow roots and
  // resolving <slot> to its assigned content instead of its fallback.
  function visibleTextContent(el, insideName) {
    if (!el) return "";
    if (el.nodeType === 3) return el.nodeValue || "";
    // A descendant contributes its own accessible name, not its text. Google's
    // date picker puts the name one level below the cell that takes the click:
    // the cell reads "20" and the child reads "Friday, November 20, 2026". The
    // text-only walk produced 45 cells all called "20".
    if (insideName && el.nodeType === 1 && el.getAttribute) {
      var own = el.getAttribute("aria-label");
      if (own && own.trim()) return clampName(own);
    }
    // A ShadowRoot (11) is a DocumentFragment, not an Element: rejecting it
    // here meant every shadow root's text was silently dropped, so a shadow
    // control was actionable while its own error text stayed invisible.
    if (el.nodeType === 11 || el.nodeType === 9) {
      var frag = [];
      var kid = el.firstChild;
      while (kid) {
        frag.push(visibleTextContent(kid, true));
        kid = kid.nextSibling;
      }
      return frag.join(" ");
    }
    if (el.nodeType !== 1) return "";
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return "";
    var cs = getComputedStyleSafe(el);
    if (cs && (cs.display === "none" || cs.visibility === "hidden")) return "";
    if (el.tagName === "SLOT") {
      var assigned = el.assignedNodes
        ? el.assignedNodes({ flatten: true })
        : [];
      if (assigned.length === 0) return childTextContent(el);
      var out = [];
      for (var i = 0; i < assigned.length; i++)
        out.push(visibleTextContent(assigned[i]));
      return out.join(" ");
    }
    if (el.shadowRoot) return childTextContent(el.shadowRoot);
    return childTextContent(el);
  }

  function childTextContent(parent) {
    var out = [];
    var child = parent.firstChild;
    while (child) {
      out.push(visibleTextContent(child, true));
      child = child.nextSibling;
    }
    return out.join(" ");
  }

  // input/image label helpers
  var LABELLABLE = {
    INPUT: 1,
    TEXTAREA: 1,
    SELECT: 1,
    BUTTON: 1,
    METER: 1,
    OUTPUT: 1,
    PROGRESS: 1,
  };

  /**
   * A label's text with the labelled control's own content removed. The spec
   * substitutes an embedded control's value, not its contents; taking the raw
   * text named a <select> "Ticket type Choose one General admission VIP ...".
   */
  function labelTextExcluding(labelEl, control) {
    if (!labelEl.contains || !labelEl.contains(control))
      return visibleTextContent(labelEl);
    var parts = [];
    var child = labelEl.firstChild;
    while (child) {
      if (child === control) {
        // Only a select contributes its value to the name it sits inside.
        // Substituting any control's value put a password into the label of
        // its own field, and put a checkbox's default "on" in front of every
        // wrapped checkbox label. A value also changes as the user types,
        // which would move the name and the guard under a live decision.
        if (control.tagName === "SELECT") {
          var value = control.value;
          if (typeof value === "string" && value) parts.push(value);
        }
      } else if (child.nodeType === 1) {
        if (!child.contains(control)) parts.push(visibleTextContent(child, true));
        else parts.push(labelTextExcluding(child, control));
      } else if (child.nodeType === 3) {
        parts.push(child.nodeValue || "");
      }
      child = child.nextSibling;
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function nativeLabelText(el) {
    var doc = el.ownerDocument;
    // explicit <label for="id">
    if (el.id) {
      var labels = doc.querySelectorAll(
        'label[for="' + cssEscape(el.id) + '"]'
      );
      if (labels.length) {
        var parts = [];
        for (var i = 0; i < labels.length; i++)
          parts.push(labelTextExcluding(labels[i], el));
        return parts.join(" ");
      }
    }
    // wrapping <label>
    var node = el.parentElement;
    var hops = 0;
    while (node && hops < 5) {
      if (node.tagName === "LABEL") return labelTextExcluding(node, el);
      node = node.parentElement;
      hops++;
    }
    // el.labels (native association, covers both cases via the platform)
    if (el.labels && el.labels.length) {
      var out = [];
      for (var j = 0; j < el.labels.length; j++)
        out.push(labelTextExcluding(el.labels[j], el));
      return out.join(" ");
    }
    // <fieldset><legend> names the group. It only applies to a control with
    // no name of its own: a <button>Pay now</button> is not called "Payment".
    var own =
      el.tagName === "BUTTON" || el.tagName === "A"
        ? visibleTextContent(el)
        : "";
    if (!own) {
      var fs = el.closest ? el.closest("fieldset") : null;
      if (fs) {
        var legend = fs.querySelector("legend");
        if (legend) return visibleTextContent(legend);
      }
    }
    // table cell: <caption>, or header cell via scope/headers is complex —
    // handle the common case of a <caption> for a <table>.
    if (el.tagName === "TABLE") {
      var caption = el.querySelector("caption");
      if (caption) return visibleTextContent(caption);
    }
    if (el.tagName === "OPTGROUP" && el.getAttribute("label"))
      return el.getAttribute("label");
    if (el.tagName === "TD" || el.tagName === "TH") {
      var scope = el.closest("tr");
      if (scope) {
        var th = scope.querySelector('th[scope="row"]');
        if (th && th !== el) return visibleTextContent(th);
      }
    }
    return "";
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // Full accname resolution chain, priority order per ACCNAME.md.
  function accessibleName(el) {
    var doc = el.ownerDocument;
    var labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      var t = textFromIdRefs(doc, labelledby);
      if (t.trim()) return clampName(t);
    }
    var ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return clampName(ariaLabel);

    if (LABELLABLE[el.tagName]) {
      var native = nativeLabelText(el);
      if (native && native.trim()) return clampName(native);
    }

    if (el.tagName === "INPUT") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") {
        if (el.value) return clampName(el.value);
      }
      if (type === "image" && el.alt) return clampName(el.alt);
      if (el.placeholder) return clampName(el.placeholder);
      if (el.value && (type === "submit" || type === "button"))
        return clampName(el.value);
    }

    if ((el.tagName === "IMG" || el.tagName === "INPUT") && el.alt)
      return clampName(el.alt);

    var title = el.getAttribute && el.getAttribute("title");
    if (title && title.trim()) return clampName(title);

    var text = visibleTextContent(el);
    if (text && text.trim()) return clampName(text);

    if (el.tagName === "INPUT" && el.placeholder)
      return clampName(el.placeholder);

    return "";
  }

  function ariaDescribedBy(el) {
    var doc = el.ownerDocument;
    var ids = el.getAttribute && el.getAttribute("aria-describedby");
    if (!ids) return "";
    return clampName(textFromIdRefs(doc, ids));
  }

  // ---- role resolution ---------------------------------------------------

  var IMPLICIT_ROLE = {
    A: function (el) {
      return el.hasAttribute("href") ? "link" : "generic";
    },
    BUTTON: function () {
      return "button";
    },
    INPUT: function (el) {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      var map = {
        button: "button",
        submit: "button",
        reset: "button",
        image: "button",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        email: "textbox",
        search: "searchbox",
        tel: "textbox",
        text: "textbox",
        url: "textbox",
        password: "textbox",
        number: "spinbutton",
        file: "upload",
      };
      return map[type] || "textbox";
    },
    TEXTAREA: function () {
      return "textbox";
    },
    SELECT: function (el) {
      return el.multiple ? "listbox" : "combobox";
    },
    OPTION: function () {
      return "option";
    },
    A_NOHREF: function () {
      return "generic";
    },
    IMG: function (el) {
      return el.alt === "" ? "presentation" : "img";
    },
    NAV: function () {
      return "navigation";
    },
    MAIN: function () {
      return "main";
    },
    HEADER: function () {
      return "banner";
    },
    FOOTER: function () {
      return "contentinfo";
    },
    FORM: function () {
      return "form";
    },
    TABLE: function () {
      return "table";
    },
    UL: function () {
      return "list";
    },
    OL: function () {
      return "list";
    },
    LI: function () {
      return "listitem";
    },
    H1: function () {
      return "heading";
    },
    H2: function () {
      return "heading";
    },
    H3: function () {
      return "heading";
    },
    H4: function () {
      return "heading";
    },
    H5: function () {
      return "heading";
    },
    H6: function () {
      return "heading";
    },
  };

  function resolveRole(el) {
    var explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    var fn = IMPLICIT_ROLE[el.tagName];
    if (fn) return fn(el);
    return el.tagName ? el.tagName.toLowerCase() : "generic";
  }

  // ---- scroll containers -------------------------------------------------

  function isScrollable(el, cs) {
    if (!cs) return false;
    var oy = cs.overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
    return el.scrollHeight > el.clientHeight + 1;
  }

  function scrollerLabel(el) {
    // Explicit names only: accessibleName() falls back to text content, which
    // for a list container is the whole list.
    var explicit = "";
    if (el.getAttribute) {
      explicit =
        el.getAttribute("aria-label") || el.getAttribute("title") || "";
      var labelledBy = el.getAttribute("aria-labelledby");
      if (!explicit && labelledBy) explicit = accessibleName(el);
    }
    if (explicit) return clampName(explicit);
    var heading = el.querySelector && el.querySelector("h1,h2,h3,h4,h5,h6");
    if (heading) {
      var h = clampName(visibleTextContent(heading));
      if (h) return h;
    }
    // Deliberately NOT the contents: a label built from the rows is the same
    // for every direction and floods the model's table. Describe the region.
    var role = resolveRole(el);
    var kind = role && role !== "generic" ? role : el.tagName.toLowerCase();
    var count = el.children ? el.children.length : 0;
    var id = el.id ? " #" + el.id : "";
    return "the " + kind + id + (count ? " with " + count + " items" : "");
  }

  // ---- guard / marker / pageKey ------------------------------------------

  function hashString(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  // Guard changes when the node's tag/role/name or its nearby structural
  // context (parent tag + sibling position) changes, but not when unrelated
  // parts of the page animate: it deliberately ignores rect/style so a CSS
  // transition elsewhere never invalidates it.
  function computeGuard(el, name, role) {
    var parent = el.parentElement;
    var parentTag = parent ? parent.tagName : "";
    var siblingIndex = 0;
    if (parent) {
      var child = parent.firstElementChild;
      while (child && child !== el) {
        siblingIndex++;
        child = child.nextElementSibling;
      }
    }
    var key = [
      el.tagName,
      role,
      name,
      parentTag,
      siblingIndex,
      el.id || "",
    ].join("|");
    return hashString(key);
  }

  function guardFor(index) {
    var el = nodes.get(index);
    if (!el || !el.isConnected) return null;
    var role = resolveRole(el);
    var name = accessibleName(el);
    return computeGuard(el, name, role);
  }

  function computeMarker(doc) {
    // Cheap whole-frame freshness token. Node count and text length alone miss
    // the most common interactive change there is: a menu opening. Toggling
    // [hidden] or aria-expanded moves neither number, so a dropdown opened
    // without the loop noticing. State-bearing attributes are in the token for
    // that reason.
    var body = doc.body;
    var childCount = body ? body.getElementsByTagName("*").length : 0;
    var shadow = 0;
    if (body) {
      // getElementsByTagName and textContent stop at shadow boundaries, so
      // without this pass a mutation inside an open shadow root left the
      // marker unchanged and stale decisions stayed "fresh".
      var hosts = [body];
      var seen = 0;
      while (hosts.length && seen < 2000) {
        var host = hosts.pop();
        var kids = host.querySelectorAll ? host.querySelectorAll("*") : [];
        for (var hi = 0; hi < kids.length && seen < 2000; hi++) {
          seen++;
          var kid = kids[hi];
          if (kid.shadowRoot) {
            shadow++;
            // A structural change inside a shadow root shows up in its
            // element count; its text is left to the observation fingerprint.
            shadow += kid.shadowRoot.querySelectorAll("*").length;
            hosts.push(kid.shadowRoot);
          }
        }
      }
    }
    var state = "";
    if (body && body.querySelectorAll) {
      state = [
        body.querySelectorAll("[hidden]").length,
        body.querySelectorAll('[aria-expanded="true"]').length,
        body.querySelectorAll('[aria-selected="true"]').length,
        body.querySelectorAll("[open]").length,
        body.querySelectorAll(":disabled").length,
        body.querySelectorAll('[aria-hidden="true"]').length,
      ].join(",");
    }
    // Focus is deliberately NOT in here: a fill clicks the field to focus it,
    // so including focus made an action invalidate its own decision.
    // Text length is deliberately not in the marker. Text that keeps
    // changing elsewhere -- a clock, a live price -- moved it between every
    // decision and its action, so no action on an unchanged control could
    // run: with a 150 ms classifier call, a ticking clock blocked a plain
    // click. The observation fingerprint carries the text instead, so new
    // content still counts as progress; the marker only answers whether the
    // page's structure and state still match the decision.
    return hashString(
      doc.URL + "|" + childCount + "|" + state + "|" + shadow
    );
  }

  function computePageKey(doc) {
    return hashString(doc.URL + "|" + (doc.title || ""));
  }

  // ---- geometry / hit testing (rect/hit per registry contract) ----------

  function rectFor(index) {
    var el = nodes.get(index);
    if (!el || !el.isConnected) return null;
    return frameRect(el);
  }

  function hitFor(index) {
    var el = nodes.get(index);
    if (!el || !el.isConnected) return null;
    if (isDisabled(el) || isInert(el)) return null;
    var rect = frameRect(el);
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    var win = ownerWindow(el);
    if (!isOnscreen(rect, win)) return null;
    var cx = rect.x + rect.width / 2;
    var cy = rect.y + rect.height / 2;
    var doc = el.ownerDocument;
    var hitEl = deepElementFromPoint(doc, cx, cy);
    if (!hitEl) return null;
    if (hitEl !== el && !el.contains(hitEl)) {
      // covered by something else — but if that something is inside an
      // open shadow root hosted by el, el still "contains" it logically;
      // contains() already handles light-DOM descendants. Cross-shadow
      // containment needs a manual walk up through host chains.
      var node = hitEl;
      var found = false;
      var hops = 0;
      while (node && hops < 30) {
        if (node === el) {
          found = true;
          break;
        }
        var parent = node.parentElement;
        if (!parent) {
          var root = node.getRootNode ? node.getRootNode() : null;
          parent = root && root.host ? root.host : null;
        }
        node = parent;
        hops++;
      }
      if (!found) return null;
    }
    return { x: cx, y: cy };
  }

  // ---- the DOM walk --------------------------------------------------

  function walk(doc, ctx) {
    walkNode(doc.body || doc.documentElement, ctx);
  }

  // aria-hidden deliberately does not prune here. It is bookkeeping, and real
  // pages leave it behind: Google Flights keeps aria-hidden="true" on its
  // search form after the trip-type menu closes, which dropped 70 of 84
  // actions from a page that was fully painted. Whether a person can act on
  // an element is decided by paint and by the hit test, in filterUnreachable.
  function walkNode(el, ctx) {
    if (!el) return;
    if (el.nodeType !== 1) return;
    var cs = getComputedStyleSafe(el);
    if (cs && cs.display === "none") return;

    var handled = visitElement(el, ctx, cs);
    if (handled) return; // canvas / select / file input: children are not separately meaningful

    // recurse into open shadow root first (its content is what's rendered
    // in place of any <slot> children below), then light-DOM children,
    // skipping any light-DOM child that is itself assigned to a slot
    // (it will be visited when we walk the slot, in its rendered position).
    if (el.shadowRoot) {
      var sr = el.shadowRoot;
      var schild = sr.firstElementChild;
      while (schild) {
        walkNode(schild, ctx);
        schild = schild.nextElementSibling;
      }
    } else if (isLikelyClosedShadowHost(el)) {
      if (!closedShadowHostSet.has(el)) {
        closedShadowHostSet.add(el);
        ctx.closedShadowHosts++;
      }
    }

    if (el.tagName === "SLOT") {
      var assigned = el.assignedElements
        ? el.assignedElements({ flatten: true })
        : [];
      for (var i = 0; i < assigned.length; i++) walkNode(assigned[i], ctx);
      return; // slot's own light-DOM fallback children are not separately rendered when assigned
    }

    var child = el.firstElementChild;
    while (child) {
      if (!isSlotted(child)) walkNode(child, ctx);
      child = child.nextElementSibling;
    }
  }

  function isSlotted(el) {
    return !!el.assignedSlot;
  }

  // Heuristic-only: a custom element (tag contains "-") with no open
  // shadowRoot but that has rendered layout box and no light-DOM children
  // is likely hosting a closed shadow root. False positives: a custom
  // element that legitimately renders nothing yet (not-yet-upgraded,
  // display:contents with all content in light DOM) or one that is simply
  // empty by design. We only count it once per element (see closedShadowHostSet).
  // Closed shadow roots are invisible to page script by design. Guessing from
  // the DOM produced both false negatives (a plain <div> host) and false
  // positives (any empty custom element), so detection moved to CDP in
  // observe.ts, which sees what DevTools sees. Nothing here counts them.
  function isLikelyClosedShadowHost() {
    return false;
  }

  function visitElement(el, ctx, cs) {
    var tag = el.tagName;

    // scrollable region
    if (isScrollable(el, cs)) {
      var idx = indexOf(el);
      // A scroll action is re-validated against this guard before it executes.
      ctx.guards[idx] = guardFor(idx);
      ctx.scrollers.push({
        node: idx,
        rect: frameRect(el) || { x: 0, y: 0, width: 0, height: 0 },
        label: scrollerLabel(el),
        canUp: el.scrollTop > 0,
        canDown: el.scrollTop < el.scrollHeight - el.clientHeight - 1,
        top: el.scrollTop,
        scrollHeight: el.scrollHeight,
      });
    }

    // canvas
    if (tag === "CANVAS") {
      var crect = frameRect(el);
      if (
        crect &&
        isOnscreen(crect, ownerWindow(el)) &&
        !isHiddenViaVisibility(el, cs)
      ) {
        var cidx = indexOf(el);
        ctx.canvases.push({
          node: cidx,
          rect: crect,
          label: accessibleName(el) || nearbyHeading(el) || "",
        });
      }
      return true; // canvas contents are opaque; no children worth walking
    }

    if (tag === "SELECT") {
      addSelectActions(el, ctx);
      return true; // <option> children handled as part of the select, not walked separately
    }

    if (
      tag === "INPUT" &&
      (el.getAttribute("type") || "").toLowerCase() === "file"
    ) {
      addAction(el, ctx, "upload", {});
      return true;
    }

    var actionKind = actionKindFor(el, cs);
    if (actionKind) addAction(el, ctx, actionKind, {});
    return false;
  }

  function isHiddenViaVisibility(el, cs) {
    return !!cs && cs.visibility === "hidden";
  }

  function nearbyHeading(el) {
    var prev = el.previousElementSibling;
    var hops = 0;
    while (prev && hops < 5) {
      if (/^H[1-6]$/.test(prev.tagName))
        return clampName(visibleTextContent(prev));
      prev = prev.previousElementSibling;
      hops++;
    }
    var parent = el.parentElement;
    if (parent) {
      var heading =
        parent.querySelector && parent.querySelector("h1,h2,h3,h4,h5,h6");
      if (heading) return clampName(visibleTextContent(heading));
    }
    return "";
  }

  var CLICKABLE_ROLES = {
    button: 1,
    link: 1,
    checkbox: 1,
    radio: 1,
    tab: 1,
    menuitem: 1,
    option: 1,
    switch: 1,
  };

  function actionKindFor(el, cs) {
    var tag = el.tagName;
    var role = resolveRole(el);
    if (tag === "TEXTAREA") return "fill";
    if (tag === "INPUT") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return "click";
      if (
        type === "submit" ||
        type === "button" ||
        type === "reset" ||
        type === "image"
      )
        return "click";
      if (type === "range") return "click"; // arrow-key adjustable; treat as clickable focus target
      return "fill";
    }
    if (tag === "BUTTON" || tag === "A") return "click";
    if (el.isContentEditable) return "fill";
    if (CLICKABLE_ROLES[role]) return "click";
    if (
      el.hasAttribute &&
      (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0")
    ) {
      // Only surface as clickable if it also has a meaningful name — avoids
      // flooding actions with every focusable wrapper div.
      return "click";
    }
    return null;
  }

  // An element a person cannot see is not a target. walkNode prunes
  // display:none and aria-hidden, but a container can also collapse its
  // contents to nothing with a zero height and overflow:clip. Those elements
  // used to enter the numbered table: on Google Flights the whole
  // multi-airport panel did, and a run typed into its hidden "Where else?"
  // field instead of the visible origin field.
  //
  // A file input is exempt. Sites routinely give it zero size and drive it
  // from a styled label, and it is still the only way to attach a file.
  function isCollapsed(el, kind) {
    if (kind === "upload") return false;
    var rect = frameRect(el);
    if (!rect || rect.width <= 0 || rect.height <= 0) return true;
    return isVisibilityHidden(el);
  }

  // The name of the section a control sits in.
  //
  // A control's own name is often too local to act on. Google Flights names
  // its origin field "Where else?", which says nothing about origin, and
  // every text model asked to fill it answered with nothing or with the
  // wrong city. The enclosing dialog is named "Enter your origin".
  //
  // Only a dialog or an explicitly named group counts. A wrapper named after
  // the whole page adds noise, not context.
  function groupName(el) {
    var node = el.parentElement;
    var hops = 0;
    while (node && hops < 12) {
      var role = node.getAttribute && node.getAttribute("role");
      var tag = node.tagName;
      if (role === "dialog" || role === "alertdialog" || tag === "DIALOG") {
        var name = accessibleName(node);
        if (name) return name;
      }
      if (
        node.getAttribute &&
        (node.getAttribute("aria-label") ||
          node.getAttribute("aria-labelledby")) &&
        (role === "group" || role === "region" || tag === "FIELDSET")
      ) {
        var groupLabel = accessibleName(node);
        if (groupLabel) return groupLabel;
      }
      node = node.parentElement;
      hops++;
    }
    return "";
  }

  // A name for a control that has none.
  //
  // Icon buttons often carry no text and no aria-label: Peek's next-month
  // arrow is an SVG inside a bare button. With an empty label the classifier
  // cannot choose it. Developers usually leave a hint in the markup -- a test
  // id, an integration id, a framework action -- and those read as plain
  // words once separated. A value that looks generated, such as a hex or
  // numeric id, says nothing, so it is never used.
  var HINT_ATTRIBUTES = [
    "data-testid",
    "data-test",
    "data-test-id",
    "data-qa",
    "data-cy",
    "data-integration",
    "data-action",
    "phx-click",
    "name",
    "id",
  ];

  function humanizeHint(raw) {
    var words = String(raw)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter(function (w) {
        return w.length > 0;
      });
    // A generated value: a run of hex or digits, or no real word in it.
    for (var i = 0; i < words.length; i++) {
      if (/^[0-9a-f]{6,}$/i.test(words[i]) && /[0-9]/.test(words[i]))
        return "";
    }
    var real = words.filter(function (w) {
      return /^[A-Za-z]{3,}$/.test(w);
    });
    if (real.length === 0) return "";
    var text = words.join(" ").toLowerCase();
    return text.length > 40 ? "" : text;
  }

  function hintName(el) {
    var svgTitle = el.querySelector && el.querySelector("svg title");
    if (svgTitle && svgTitle.textContent && svgTitle.textContent.trim())
      return clampName(svgTitle.textContent.trim());
    for (var i = 0; i < HINT_ATTRIBUTES.length; i++) {
      var value = el.getAttribute && el.getAttribute(HINT_ATTRIBUTES[i]);
      if (!value) continue;
      var hint = humanizeHint(value);
      if (hint) return hint;
    }
    return "";
  }

  function addAction(el, ctx, kind, extra) {
    if (isCollapsed(el, kind)) return;
    var name = accessibleName(el) || hintName(el);
    if (
      !name &&
      kind === "click" &&
      !el.hasAttribute("onclick") &&
      el.getAttribute("tabindex") !== "0"
    ) {
      // unnamed non-interactive-by-default element: skip, not a real target
    }
    var idx = indexOf(el);
    var role = resolveRole(el);
    // guardFor() is the single source of truth: the executor calls it to
    // re-validate, so anything else here is a guaranteed mismatch.
    var guard = guardFor(idx);
    ctx.guards[idx] = guard;
    var action = {
      id: ctx.frameId + ":" + idx + ":" + kind,
      kind: kind,
      label: name,
      ref: { frameId: ctx.frameId, node: idx },
      role: role,
      guard: guard,
    };
    if (kind === "upload") {
      // Browsers hide a file input's real value; without the file name here an
      // attached file looks like an empty field and gets attached again.
      var picked = el.files && el.files.length ? el.files[0].name : "";
      action.value = picked;
      action.currentValue = picked;
    }
    if (kind === "fill") {
      var group = groupName(el);
      if (group && group !== name) action.group = group;
      // A field that holds a secret by its own nature never gives up its
      // value. The value used to be copied here, so it reached the numbered
      // table a model reads and the classifier request. Only the length
      // leaves, so "the field has something in it" is still expressible.
      var autofill = (el.getAttribute("autocomplete") || "").toLowerCase();
      var inputType = (el.getAttribute("type") || "text").toLowerCase();
      var secret =
        inputType === "password" ||
        autofill === "current-password" ||
        autofill === "new-password" ||
        autofill === "one-time-code";
      if (secret) {
        action.sensitive = true;
        action.value = "";
        action.currentValue = el.value ? "(" + String(el.value.length) + " characters, hidden)" : "";
      } else {
        action.value = el.value !== undefined ? el.value : "";
        action.currentValue = action.value;
      }
    }
    if (el.checked !== undefined && kind === "click")
      action.checked = !!el.checked;
    var role2 = role;
    if (role2 === "option") action.selected = !!el.selected;
    if (el.getAttribute && el.getAttribute("aria-expanded") != null) {
      action.expanded = el.getAttribute("aria-expanded") === "true";
    }
    for (var k in extra) action[k] = extra[k];
    ctx.actions.push(action);
  }

  function addSelectActions(selectEl, ctx) {
    var fieldName = accessibleName(selectEl);
    var idx = indexOf(selectEl);
    var guard = guardFor(idx);
    ctx.guards[idx] = guard;
    var options = selectEl.options;
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      if (opt.disabled) continue;
      var optLabel = (opt.label || opt.text || opt.value || "").trim();
      var full = fieldName ? fieldName + " → " + optLabel : optLabel;
      var optIdx = indexOf(opt);
      ctx.guards[optIdx] = guardFor(optIdx);
      ctx.actions.push({
        id: ctx.frameId + ":" + optIdx + ":select",
        kind: "select",
        label: clampName(full),
        ref: { frameId: ctx.frameId, node: idx },
        role: "option",
        selected: opt.selected,
        optionValue: opt.value,
        // The executor re-checks ref.node, which is the <select>, so the
        // action must carry the SELECT's guard, not the option's.
        guard: guard,
      });
    }
  }

  // ---- keyboard operations on the focused element -----------------------

  // A widget with no native semantics is only reachable by key, so the focused
  // element gets the allowlisted keys offered as ordinary indexed targets. The
  // key set is fixed in code; the model picks among them, it never names one.
  var PRESS_KEYS = [
    "Enter",
    "Escape",
    "Tab",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Backspace",
  ];

  function addPressActions(doc, ctx) {
    var el = doc.activeElement;
    if (!el || el === doc.body || el === doc.documentElement) return;
    if (ctx.allowed && !ctx.allowed(el)) return;
    var idx = indexOf(el);
    var name = accessibleName(el) || resolveRole(el) || "the focused element";
    var role = resolveRole(el);
    var guard = guardFor(idx);
    ctx.guards[idx] = guard;
    for (var i = 0; i < PRESS_KEYS.length; i++) {
      ctx.actions.push({
        id: ctx.frameId + ":" + idx + ":press:" + PRESS_KEYS[i],
        kind: "press",
        label: "Press " + PRESS_KEYS[i] + " on " + name,
        ref: { frameId: ctx.frameId, node: idx },
        role: role,
        key: PRESS_KEYS[i],
        guard: guard,
      });
    }
  }

  // ---- visible text collection (frame text, offscreen/clipped excluded) --

  function collectVisibleText(doc) {
    var win = doc.defaultView || window;
    var out = [];
    var total = 0;
    var walker = doc.createTreeWalker(
      doc.body || doc.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          var s = node.nodeValue;
          if (!s || !s.trim()) return NodeFilter.FILTER_REJECT;
          var parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest && parent.closest("script,style,noscript"))
            return NodeFilter.FILTER_REJECT;
          if (isHiddenSubtree(parent)) return NodeFilter.FILTER_REJECT;
          var cs = getComputedStyleSafe(parent);
          if (cs && cs.visibility === "hidden") return NodeFilter.FILTER_REJECT;
          var rect;
          try {
            rect = parent.getBoundingClientRect();
          } catch (e) {
            rect = null;
          }
          if (!rect || (rect.width === 0 && rect.height === 0))
            return NodeFilter.FILTER_REJECT;
          if (
            !isOnscreen(
              { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              win
            )
          )
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    var n;
    while ((n = walker.nextNode())) {
      if (total >= MAX_TEXT) break;
      var t = n.nodeValue.replace(/\s+/g, " ").trim();
      if (!t) continue;
      out.push(t);
      total += t.length;
    }
    // also pull text out of open shadow roots the TreeWalker cannot enter
    var shadowHosts = (doc.body || doc.documentElement).querySelectorAll("*");
    for (var i = 0; i < shadowHosts.length && total < MAX_TEXT; i++) {
      var host = shadowHosts[i];
      if (host.shadowRoot) {
        var t2 = visibleTextContent(host.shadowRoot).trim();
        if (t2) {
          out.push(t2);
          total += t2.length;
        }
      }
    }
    var joined = out.join(" ").replace(/\s+/g, " ").trim();
    return joined.length > MAX_TEXT ? joined.slice(0, MAX_TEXT) : joined;
  }

  // ---- filter out actions their own container clips away ---------------

  // A container that clips (overflow other than visible) shows only the part
  // of its contents that falls inside its own box. Anything outside is not on
  // screen for the person, whatever its own rect says.
  //
  // This covers two cases with one rule. A scroll container shows the scrolled
  // portion only. A collapsed panel with a zero height and overflow:clip shows
  // nothing at all: Google Flights hides its multi-airport panel that way, and
  // its fields used to enter the numbered table and capture the run.
  function clipsContents(cs) {
    if (!cs) return false;
    return (
      (cs.overflowX !== "visible" && cs.overflowX !== "") ||
      (cs.overflowY !== "visible" && cs.overflowY !== "")
    );
  }

  function intersects(a, b) {
    return (
      a.x + a.width > b.x &&
      a.x < b.x + b.width &&
      a.y + a.height > b.y &&
      a.y < b.y + b.height
    );
  }

  function isClippedAway(el) {
    var rect = frameRect(el);
    if (!rect) return true;
    var doc = el.ownerDocument;
    var node = el.parentElement;
    var hops = 0;
    while (node && node !== doc.documentElement && hops < 40) {
      if (clipsContents(getComputedStyleSafe(node))) {
        var box = frameRect(node);
        // A clipping ancestor with no box of its own shows nothing.
        if (!box || !intersects(rect, box)) return true;
      }
      node = node.parentElement;
      hops++;
    }
    return false;
  }

  // The open ARIA modal on top, if any. Content outside an aria-modal
  // element is inert by contract, but a drawer's backdrop is often not a
  // hit-test target: on Target the loop scrolled the page behind an open
  // purchase drawer. A native modal <dialog> needs none of this; the top
  // layer already covers the page. A modal counts only when the point at
  // its centre lands inside it: that rules out one an ancestor hides or
  // clips, and one another modal covers.
  // ponytail: modals inside shadow roots are not found, and a top-document
  // modal does not hide a background iframe's controls.
  function topModal() {
    var open = Array.prototype.filter.call(
      document.querySelectorAll('[aria-modal="true"]'),
      function (el) {
        if (isHiddenSubtree(el)) return false;
        var cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
        var r = el.getBoundingClientRect();
        if (
          !(
            r.width > 0 &&
            r.height > 0 &&
            r.right > 0 &&
            r.bottom > 0 &&
            r.left < innerWidth &&
            r.top < innerHeight
          )
        )
          return false;
        var x = (Math.max(r.left, 0) + Math.min(r.right, innerWidth)) / 2;
        var y = (Math.max(r.top, 0) + Math.min(r.bottom, innerHeight)) / 2;
        var hit = document.elementFromPoint(x, y);
        return hit !== null && insideOf(el, hit);
      }
    );
    return open.length ? open[open.length - 1] : null;
  }

  // What may be acted on while a modal is open: the modal, and any list or
  // popup a control inside it names with aria-controls or aria-owns, which
  // sites often render outside the dialog.
  function modalScope(modal) {
    var owned = [modal];
    var named = modal.querySelectorAll("[aria-controls],[aria-owns]");
    for (var i = 0; i < named.length; i++) {
      var ids = (
        (named[i].getAttribute("aria-controls") || "") +
        " " +
        (named[i].getAttribute("aria-owns") || "")
      ).split(/\s+/);
      for (var j = 0; j < ids.length; j++) {
        var target = ids[j] && document.getElementById(ids[j]);
        if (target) owned.push(target);
      }
    }
    return function (el) {
      for (var k = 0; k < owned.length; k++)
        if (insideOf(owned[k], el)) return true;
      return false;
    };
  }

  function insideOf(container, el) {
    var node = el;
    while (node) {
      if (node === container) return true;
      if (node.parentElement) node = node.parentElement;
      else {
        var root = node.getRootNode ? node.getRootNode() : null;
        node = root && root.host ? root.host : null;
      }
    }
    return false;
  }

  function filterUnreachable(ctx) {
    var modal = topModal();
    var allowed = modal ? modalScope(modal) : null;
    ctx.allowed = allowed;
    if (allowed) {
      var box = modal.getBoundingClientRect();
      ctx.scrollers = ctx.scrollers.filter(function (scroller) {
        // The page itself scrolls only to reach a modal taller than the view.
        if (scroller.node === undefined)
          return box.top < 0 || box.bottom > innerHeight;
        var el = nodes.get(scroller.node);
        return !!el && allowed(el);
      });
    }
    ctx.actions = ctx.actions.filter(function (action) {
      if (!action.ref) return true;
      var el = nodes.get(action.ref.node);
      if (!el) return true;
      if (allowed && !allowed(el)) return false;
      // A file input is exempt: sites routinely collapse it and drive it from
      // a styled label, and it is still the only way to attach a file.
      if (action.kind === "upload") return true;
      if (isClippedAway(el)) return false;
      // The centre of the element must reach the element. This is what
      // removes a menu that has faded out but is still laid out, and
      // anything behind an overlay or a modal.
      return hitFor(action.ref.node) !== null;
    });
  }

  function makeSnapshotFn() {
    return function snapshot() {
      var doc = document;
      var frameId = window.__jevFrameId || "";
      var ctx = {
        frameId: frameId,
        actions: [],
        guards: {},
        canvases: [],
        closedShadowHosts: 0,
        scrollers: [],
      };

      walk(doc, ctx);

      // frame's own viewport as a scroller entry (node omitted), only when
      // the frame itself actually scrolls.
      var docEl = doc.documentElement;
      var win = doc.defaultView || window;
      if (docEl.scrollHeight > docEl.clientHeight + 1) {
        ctx.scrollers.push({
          rect: { x: 0, y: 0, width: win.innerWidth, height: win.innerHeight },
          label: doc.title || "page",
          canUp: win.scrollY > 0,
          canDown: win.scrollY < docEl.scrollHeight - docEl.clientHeight - 1,
          top: win.scrollY,
          scrollHeight: docEl.scrollHeight,
        });
      }

      filterUnreachable(ctx);
      addPressActions(doc, ctx);

      // Derived from the observed controls, so it covers shadow roots and
      // frames for free.
      var valueParts = [];
      for (var vi = 0; vi < ctx.actions.length; vi++) {
        var va = ctx.actions[vi];
        if (
          va.kind === "press" ||
          va.kind === "scroll" ||
          va.kind === "switch_tab"
        )
          continue;
        // Keyed by kind and label, never by the action id. An id embeds the
        // frame id, which is local to one process, and that made an identical
        // page fingerprint differently after another process attached to it.
        valueParts.push(
          va.kind +
            ":" +
            (va.label || "") +
            "=" +
            (va.currentValue || va.value || "") +
            (va.checked ? "|c" : "") +
            (va.selected ? "|s" : "")
        );
      }

      return {
        valueState: hashString(valueParts.join(";")),
        url: doc.URL,
        title: doc.title || "",
        text: collectVisibleText(doc),
        pageKey: computePageKey(doc),
        marker: computeMarker(doc),
        actions: ctx.actions,
        guards: ctx.guards,
        canvases: ctx.canvases,
        closedShadowHosts: ctx.closedShadowHosts,
        scrollers: ctx.scrollers,
      };
    };
  }

  window.__jevFast = {
    installed: true,
    // Read live, not fixed at install: the engine outlives the connection
    // that installed it, and a second attachment names this frame anew.
    get frameId() {
      return window.__jevFrameId || "";
    },
    nodes: nodes,
    guard: function (index) {
      return guardFor(index);
    },
    pageKey: function () {
      return computePageKey(document);
    },
    marker: function () {
      return computeMarker(document);
    },
    rect: function (index) {
      return rectFor(index);
    },
    hit: function (index) {
      return hitFor(index);
    },
  };
  window.__jevFast.snapshot = makeSnapshotFn();
})();
