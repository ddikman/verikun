import { Element } from '../types';

// Compact one-line rendering tuned for AI agents: dense, scannable, and using
// the same `@idShort` token that the selector grammar accepts, so an element
// printed here can be copy-pasted straight back into a `tap`/`find` command.

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function formatInline(el: Element): string {
  const parts: string[] = [`[${el.index}]`, el.type];
  if (el.text.trim()) parts.push(JSON.stringify(clip(el.text, 60)));
  if (el.idShort) parts.push('@' + el.idShort);
  if (el.desc.trim() && el.desc !== el.text) parts.push('desc=' + JSON.stringify(clip(el.desc, 40)));
  parts.push(`(${el.center.x},${el.center.y})`);

  const flags: string[] = [];
  if (el.clickable) flags.push('tap');
  if (el.scrollable) flags.push('scroll');
  if (el.checkable) flags.push(el.checked ? 'checked' : 'unchecked');
  if (el.focused) flags.push('focused');
  if (el.password) flags.push('pwd');
  if (el.selected) flags.push('selected');
  if (!el.enabled) flags.push('disabled');
  if (flags.length) parts.push(flags.join(','));

  return parts.join(' ');
}

export function formatCompact(elements: Element[]): string {
  if (!elements.length) return '(no elements)';
  return elements.map(formatInline).join('\n');
}

export function formatTree(elements: Element[]): string {
  if (!elements.length) return '(no elements)';
  return elements.map((el) => '  '.repeat(el.depth) + formatInline(el)).join('\n');
}

/** Structured shape for --json. Omits empty/false fields to stay compact. */
export function toJsonShape(el: Element): Record<string, unknown> {
  return {
    index: el.index,
    type: el.type,
    class: el.class,
    id: el.id || undefined,
    text: el.text || undefined,
    desc: el.desc || undefined,
    center: el.center,
    bounds: el.bounds,
    clickable: el.clickable || undefined,
    scrollable: el.scrollable || undefined,
    checkable: el.checkable || undefined,
    checked: el.checkable ? el.checked : undefined,
    focused: el.focused || undefined,
    password: el.password || undefined,
    enabled: el.enabled,
    selected: el.selected || undefined,
  };
}
