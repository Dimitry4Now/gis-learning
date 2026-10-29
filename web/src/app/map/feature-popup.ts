import type { LayerDefinition, SourceDefinition } from '../registry/registry';

/**
 * Popup content for a clicked feature: the layer's registered fields and where the data comes from.
 * Built with textContent, never innerHTML, because attribute values come from third-party data.
 */
export function featurePopup(
  def: LayerDefinition,
  source: SourceDefinition | undefined,
  properties: Record<string, unknown>,
): HTMLElement {
  const root = el('div', 'feature-popup');
  root.append(el('div', 'feature-popup-layer', def.name));

  const table = el('dl');
  for (const field of def.fields.filter((f) => !f.internal)) {
    const value = properties[field.name];
    table.append(el('dt', '', field.label), el('dd', value === null || value === undefined ? 'muted' : '', format(value)));
  }
  root.append(table);

  if (source) {
    root.append(el('div', 'feature-popup-source', `${source.name} · ${source.attribution}`));
  }
  return root;
}

function format(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return 'not recorded';
  }
  return String(value);
}

function el(tag: string, className = '', text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}
