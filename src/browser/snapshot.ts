/**
 * @owner       src/browser/snapshot.ts
 * @does        Generate one renderer script that snapshots the composed DOM and atomically installs its ref identity/node registry.
 * @needs       src/types.ts SnapshotOptions and a caller-generated snapshot capability id
 * @feeds       BrowserPage and BrowserBrokerPage snapshots, observe, ref actions, and direct browser MCP state including its URL/title identity
 * @breaks      Returned refs are unusable unless identity and live-node registries are installed by the same renderer evaluation.
 * @invariants  Ref ids are unique within one snapshot; aria-hidden and sensitive-control descendants are omitted across composed slot boundaries; open shadow roots, slots, and same-origin frames share one registry; inaccessible frames are reported but never flattened into actionable refs; raw trees never exceed the direct-tool parser bound.
 * @side-effects Annotates interactive elements and replaces four window-scoped Uni-CLI snapshot registry values.
 * @perf        O(visited document nodes) time and O(interactive elements + bounded tree) memory, with one renderer round trip; raw traversal stops as soon as its 1M-character tree budget is full.
 * @concurrency A newer snapshot atomically replaces the prior registry and capability id.
 * @test        tests/unit/browser-snapshot-helpers.test.ts, tests/integration/browser-ref-capabilities.test.ts
 * @stability   experimental
 * @since       2026-04-04
 */

import type { SnapshotOptions } from "../types.js";

/**
 * Returns a self-contained JS IIFE string that, when evaluated in a
 * browser page context, traverses the DOM and returns a text snapshot.
 */
export function generateSnapshotJs(
  opts: SnapshotOptions | undefined,
  snapshotId: string,
): string {
  const interactive = opts?.interactive ?? false;
  const compact = opts?.compact ?? false;
  const maxDepth = opts?.maxDepth ?? 50;
  const maxRefs = opts?.maxRefs ?? 10_000;
  const raw = opts?.raw ?? false;

  // We embed the options as literals inside the IIFE so it runs standalone.
  return `(() => {
  const INTERACTIVE = ${interactive === true};
  const COMPACT = ${compact === true};
  const MAX_DEPTH = ${Number.isFinite(Number(maxDepth)) ? Math.trunc(Number(maxDepth)) : 50};
  const MAX_REFS = ${Number.isFinite(Number(maxRefs)) ? Math.max(1, Math.trunc(Number(maxRefs))) : 10_000};
  const RAW = ${raw === true};
  const SNAPSHOT_ID = ${JSON.stringify(snapshotId)};
  const takenAt = Date.now();
  const MAX_RAW_TREE_CHARS = 1_000_000;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'LINK', 'META']);
  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'switch',
    'tab', 'menuitem', 'option', 'combobox', 'listbox', 'slider',
    'spinbutton', 'searchbox', 'treeitem'
  ]);

  let refCounter = 0;
  const refs = [];
  const identity = {};
  const nodes = new Map();
  const limitations = { inaccessible_frames: 0 };
  let truncated = false;
  let outputChars = 0;

  function emit(value) {
    if (!RAW) return value;
    const remaining = MAX_RAW_TREE_CHARS - outputChars;
    if (remaining <= 0) {
      truncated = true;
      return '';
    }
    if (value.length > remaining) {
      outputChars = MAX_RAW_TREE_CHARS;
      truncated = true;
      return value.slice(0, remaining);
    }
    outputChars += value.length;
    return value;
  }

  function outputBudgetFull() {
    const full = RAW && outputChars >= MAX_RAW_TREE_CHARS;
    if (full) truncated = true;
    return full;
  }

  function isAriaHidden(el) {
    return (el.getAttribute('aria-hidden') || '').toLowerCase() === 'true';
  }

  function isHidden(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (style.position === 'fixed' || style.position === 'absolute') return false;
      return true;
    }
    return false;
  }

  function isInteractive(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
    if (el.contentEditable === 'true') return true;
    return false;
  }

  function isScrollable(el) {
    if (el === document.documentElement || el === document.body) return false;
    const style = getComputedStyle(el);
    const ov = style.overflow + style.overflowY + style.overflowX;
    if (!/auto|scroll/.test(ov)) return false;
    return el.scrollHeight > el.clientHeight + 10 || el.scrollWidth > el.clientWidth + 10;
  }

  function scrollInfo(el) {
    const up = el.scrollTop / el.clientHeight;
    const down = (el.scrollHeight - el.scrollTop - el.clientHeight) / el.clientHeight;
    return '(' + up.toFixed(1) + '\\u2191 ' + down.toFixed(1) + '\\u2193)';
  }

  const ATTR_NAMES = ['type', 'name', 'value', 'placeholder', 'href', 'role',
                       'aria-label', 'aria-expanded', 'aria-checked', 'disabled',
                       'readonly', 'required', 'checked', 'selected'];
  const MAX_ATTR_VALUE_LENGTH = 256;
  const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
    'current-password', 'new-password', 'one-time-code', 'cc-number',
    'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'
  ]);

  function hasSensitiveValue(el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
      return false;
    }
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    const autocomplete = (el.getAttribute('autocomplete') || '')
      .toLowerCase()
      .split(/\\s+/);
    return autocomplete.some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token));
  }

  /** Build the { k: v } bag consumed by \`unicli operate observe\`. */
  function collectAttrs(el) {
    const bag = {};
    for (const a of ATTR_NAMES) {
      if (el.hasAttribute(a)) {
        if (a === 'value' && hasSensitiveValue(el)) {
          continue;
        }
        let val = (el.getAttribute(a) || '').replace(/[\\x00-\\x1F\\x7F]/g, ' ');
        const maximum = a === 'href' ? 80 : MAX_ATTR_VALUE_LENGTH;
        if (val.length > maximum) val = val.slice(0, maximum - 3) + '...';
        bag[a] = val;
      }
    }
    return bag;
  }

  function getAttrs(el) {
    const bag = collectAttrs(el);
    const keep = [];
    for (const a of ATTR_NAMES) {
      if (a in bag) {
        keep.push(a + '="' + bag[a].replace(/"/g, '&quot;') + '"');
      }
    }
    return keep.length ? ' ' + keep.join(' ') : '';
  }

  function textContent(el) {
    if (hasSensitiveValue(el)) return '';
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    return text.replace(/\\s+/g, ' ').trim().slice(0, 200);
  }

  function composedChildNodes(el) {
    if (el.tagName === 'SLOT' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length > 0) return assigned;
    }
    return (el.shadowRoot || el).childNodes;
  }

  function walk(node, depth, indent) {
    if (outputBudgetFull()) return '';
    if (depth > MAX_DEPTH) {
      truncated = true;
      return '';
    }
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\\s+/g, ' ').trim();
      if (!text) return '';
      if (COMPACT && text.length < 2) return '';
      return emit(indent + text.slice(0, 200) + '\\n');
    }
    if (node.nodeType !== 1) return '';

    const el = node;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return '';
    if (isAriaHidden(el) || (tag !== 'SLOT' && isHidden(el))) return '';

    const interactive = isInteractive(el);

    if (interactive && refCounter >= MAX_REFS) {
      truncated = true;
      return '';
    }

    // In interactive-only mode, skip non-interactive subtrees
    // But still recurse children in case they contain interactive elements
    if (INTERACTIVE && !interactive) {
      let childOut = '';
      const children = composedChildNodes(el);
      for (let i = 0; i < children.length; i++) {
        if (outputBudgetFull()) break;
        childOut += walk(children[i], depth + 1, indent);
      }
      if (tag === 'IFRAME' && !outputBudgetFull()) {
        try {
          const iframeDoc = el.contentDocument;
          if (iframeDoc && iframeDoc.body) {
            childOut += walk(iframeDoc.body, depth + 1, indent);
          } else {
            limitations.inaccessible_frames += 1;
          }
        } catch (e) {
          limitations.inaccessible_frames += 1;
        }
      }
      return childOut;
    }

    let line = indent;
    const scrollable = isScrollable(el);

    if (scrollable) {
      line += '|scroll|';
    }

    // Shadow DOM marker
    if (el.shadowRoot) {
      line += '|shadow|';
    }

    if (interactive) {
      const ref = ++refCounter;
      el.setAttribute('data-unicli-ref', String(ref));
      // Refs carry the attribute bag so \`unicli operate observe\` can match
      // role, aria-label, placeholder, etc. without re-parsing the rendered
      // tree string. See src/browser/observe.ts scoreCandidate().
      refs.push({
        ref,
        tag: tag.toLowerCase(),
        text: textContent(el).slice(0, 50),
        attrs: collectAttrs(el),
        frame:
          el.ownerDocument !== document
            ? 'same_origin_iframe'
            : (el.getRootNode() instanceof ShadowRoot ? 'shadow' : 'main'),
      });
      const rect = el.getBoundingClientRect();
      const name =
        el.getAttribute('aria-label') ||
        el.getAttribute('name') ||
        el.getAttribute('placeholder') ||
        textContent(el).slice(0, 80) ||
        undefined;
      const entry = {
        role: el.getAttribute('role') || tag.toLowerCase(),
        taken_at: takenAt,
        bbox: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      };
      if (name) entry.name = name;
      identity[String(ref)] = entry;
      nodes.set(String(ref), el);
      line += '[' + ref + ']';
    }

    const tagLower = tag.toLowerCase();
    const attrs = getAttrs(el);
    const directText = textContent(el);

    // Self-closing or leaf elements
    if (tag === 'INPUT' || tag === 'BR' || tag === 'HR' || tag === 'IMG') {
      line += '<' + tagLower + attrs + ' />';
      if (scrollable) line += ' ' + scrollInfo(el);
      return emit(line + '\\n');
    }

    line += '<' + tagLower + attrs + '>';
    if (scrollable) line += ' ' + scrollInfo(el);

    // Check for children
    const children = hasSensitiveValue(el) ? [] : composedChildNodes(el);
    let hasElementChildren = false;
    for (let i = 0; i < children.length; i++) {
      if (children[i].nodeType === 1 && !SKIP_TAGS.has(children[i].tagName)) {
        hasElementChildren = true;
        break;
      }
    }

    if (!hasElementChildren && directText) {
      // Inline: <tag>text</tag>
      return emit(line + directText.slice(0, 200) + '</' + tagLower + '>\\n');
    }

    let out = emit(line + '\\n');
    const childIndent = indent + '  ';
    for (let i = 0; i < children.length; i++) {
      if (outputBudgetFull()) break;
      out += walk(children[i], depth + 1, childIndent);
    }

    // Handle same-origin iframes (max 5)
    if (tag === 'IFRAME' && !outputBudgetFull()) {
      try {
        const iframeDoc = el.contentDocument;
        if (iframeDoc && iframeDoc.body) {
          out += emit(childIndent + '|iframe|\\n');
          if (!outputBudgetFull()) {
            out += walk(iframeDoc.body, depth + 1, childIndent + '  ');
          }
        } else {
          limitations.inaccessible_frames += 1;
          out += emit(childIndent + '|iframe| (inaccessible)\\n');
        }
      } catch (e) {
        limitations.inaccessible_frames += 1;
        out += emit(childIndent + '|iframe| (cross-origin)\\n');
      }
    }

    return out;
  }

  const result = walk(document.body, 0, '');
  window.__unicli_ref_identity = identity;
  window.__unicli_ref_nodes = nodes;
  window.__unicli_ref_snapshot_id = SNAPSHOT_ID;
  window.__unicli_ref_taken_at = takenAt;

  if (RAW) {
    return JSON.stringify({
      snapshot_id: SNAPSHOT_ID,
      url: window.location.href.slice(0, 8192),
      url_truncated: window.location.href.length > 8192,
      title: document.title.slice(0, 512),
      tree: result,
      refs: refs,
      limitations: limitations,
      truncated: truncated,
    });
  }
  return result;
})()`;
}
