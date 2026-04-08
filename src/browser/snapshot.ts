/**
 * DOM snapshot generator -- produces an accessibility-style text tree
 * of the page, annotating interactive elements with numbered refs.
 *
 * Used by BrowserPage.snapshot() via evaluate() in the page context.
 */

import type { SnapshotOptions } from "../types.js";

/**
 * Returns a self-contained JS IIFE string that, when evaluated in a
 * browser page context, traverses the DOM and returns a text snapshot.
 */
export function generateSnapshotJs(opts?: SnapshotOptions): string {
  const interactive = opts?.interactive ?? false;
  const compact = opts?.compact ?? false;
  const maxDepth = opts?.maxDepth ?? 50;
  const raw = opts?.raw ?? false;

  // We embed the options as literals inside the IIFE so it runs standalone.
  return `(() => {
  const INTERACTIVE = ${interactive === true};
  const COMPACT = ${compact === true};
  const MAX_DEPTH = ${Number.isFinite(Number(maxDepth)) ? Math.trunc(Number(maxDepth)) : 50};
  const RAW = ${raw === true};

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'LINK', 'META']);
  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'switch',
    'tab', 'menuitem', 'option', 'combobox', 'listbox', 'slider',
    'spinbutton', 'searchbox', 'treeitem'
  ]);

  let refCounter = 0;
  const refs = [];

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

  /** Build the { k: v } bag consumed by \`unicli operate observe\`. */
  function collectAttrs(el) {
    const bag = {};
    for (const a of ATTR_NAMES) {
      if (el.hasAttribute(a)) {
        let val = el.getAttribute(a) || '';
        if (a === 'href' && val.length > 80) val = val.slice(0, 77) + '...';
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
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    return text.trim().slice(0, 200);
  }

  function walk(node, depth, indent) {
    if (depth > MAX_DEPTH) return '';
    if (node.nodeType === 3) {
      const text = node.textContent.trim();
      if (!text) return '';
      if (COMPACT && text.length < 2) return '';
      return indent + text.slice(0, 200) + '\\n';
    }
    if (node.nodeType !== 1) return '';

    const el = node;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return '';
    if (isHidden(el)) return '';

    const interactive = isInteractive(el);

    // In interactive-only mode, skip non-interactive subtrees
    // But still recurse children in case they contain interactive elements
    if (INTERACTIVE && !interactive) {
      let childOut = '';
      const children = el.childNodes;
      for (let i = 0; i < children.length; i++) {
        childOut += walk(children[i], depth + 1, indent);
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
      });
      line += '[' + ref + ']';
    }

    const tagLower = tag.toLowerCase();
    const attrs = getAttrs(el);
    const directText = textContent(el);

    // Self-closing or leaf elements
    if (tag === 'INPUT' || tag === 'BR' || tag === 'HR' || tag === 'IMG') {
      line += '<' + tagLower + attrs + ' />';
      if (scrollable) line += ' ' + scrollInfo(el);
      return line + '\\n';
    }

    line += '<' + tagLower + attrs + '>';
    if (scrollable) line += ' ' + scrollInfo(el);

    // Check for children
    const root = el.shadowRoot || el;
    const children = root.childNodes;
    let hasElementChildren = false;
    for (let i = 0; i < children.length; i++) {
      if (children[i].nodeType === 1 && !SKIP_TAGS.has(children[i].tagName)) {
        hasElementChildren = true;
        break;
      }
    }

    if (!hasElementChildren && directText) {
      // Inline: <tag>text</tag>
      return line + directText.slice(0, 200) + '</' + tagLower + '>\\n';
    }

    let out = line + '\\n';
    const childIndent = indent + '  ';
    for (let i = 0; i < children.length; i++) {
      out += walk(children[i], depth + 1, childIndent);
    }

    // Handle same-origin iframes (max 5)
    if (tag === 'IFRAME') {
      try {
        const iframeDoc = el.contentDocument;
        if (iframeDoc && iframeDoc.body) {
          out += childIndent + '|iframe|\\n';
          out += walk(iframeDoc.body, depth + 1, childIndent + '  ');
        }
      } catch (e) {
        out += childIndent + '|iframe| (cross-origin)\\n';
      }
    }

    return out;
  }

  const result = walk(document.body, 0, '');

  if (RAW) {
    return JSON.stringify({ tree: result, refs: refs });
  }
  return result;
})()`;
}
