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
  function visibleTextContent(el) {
    if (!el) return "";
    if (el.nodeType === 3) return el.nodeValue || "";
    // A ShadowRoot (11) is a DocumentFragment, not an Element: rejecting it
    // here meant every shadow root's text was silently dropped, so a shadow
    // control was actionable while its own error text stayed invisible.
    if (el.nodeType === 11 || el.nodeType === 9) {
      var frag = [];
      var kid = el.firstChild;
      while (kid) {
        frag.push(visibleTextContent(kid));
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
      out.push(visibleTextContent(child));
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
        var value = control.value;
        if (typeof value === "string" && value) parts.push(value);
      } else if (child.nodeType === 1) {
        if (!child.contains(control)) parts.push(visibleTextContent(child));
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
    var textLen = body ? (body.textContent || "").length : 0;
    var shadow = 0;
    var shadowText = 0;
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
            shadowText += (kid.shadowRoot.textContent || "").length;
            // Element count as well as text: a structural change inside a
            // shadow root often adds no text at all.
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
    return hashString(
      doc.URL +
        "|" +
        childCount +
        "|" +
        textLen +
        "|" +
        state +
        "|" +
        shadow +
        "|" +
        shadowText
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

  function walkNode(el, ctx) {
    if (!el) return;
    if (el.nodeType !== 1) return;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return;
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

  function addAction(el, ctx, kind, extra) {
    var name = accessibleName(el);
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
      action.value = el.value !== undefined ? el.value : "";
      action.currentValue = action.value;
      var described = ariaDescribedBy(el);
      if (described) action.currentValue = action.currentValue; // describedby carried via label chain only
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

  // ---- filter out actions inside a scrolled-out-of-view scroller ---------

  function filterHiddenInScrollers(ctx) {
    if (ctx.scrollers.length === 0) return;
    var scrollerEls = [];
    for (var i = 0; i < ctx.scrollers.length; i++) {
      var s = ctx.scrollers[i];
      if (s.node !== undefined) {
        var el = nodes.get(s.node);
        if (el) scrollerEls.push(el);
      }
    }
    if (scrollerEls.length === 0) return;
    ctx.actions = ctx.actions.filter(function (action) {
      if (!action.ref) return true;
      var el = nodes.get(action.ref.node);
      if (!el) return true;
      for (var j = 0; j < scrollerEls.length; j++) {
        var scroller = scrollerEls[j];
        if (scroller !== el && scroller.contains(el)) {
          // inside a scroller: only keep it if currently within that
          // scroller's visible (scrolled) viewport
          var scRect = frameRect(scroller);
          var elRect = frameRect(el);
          if (!scRect || !elRect) return false;
          var visible =
            elRect.y + elRect.height > scRect.y &&
            elRect.y < scRect.y + scRect.height &&
            elRect.x + elRect.width > scRect.x &&
            elRect.x < scRect.x + scRect.width;
          if (!visible) return false;
        }
      }
      return true;
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

      filterHiddenInScrollers(ctx);
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
        valueParts.push(
          va.id +
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
    frameId: window.__jevFrameId || "",
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
