import type { IControl, LngLatBoundsLike, Map } from 'maplibre-gl';

/** A map button that flies back to the given bounds, styled like MapLibre's own controls. */
export class ResetViewControl implements IControl {
  private container?: HTMLDivElement;

  constructor(
    private readonly bounds: LngLatBoundsLike,
    private readonly padding: number,
  ) {}

  onAdd(map: Map): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reset-view';
    button.title = 'Show all of North Macedonia';
    button.setAttribute('aria-label', button.title);
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<path d="M4 11 12 4l8 7M6 9.5V20h4.5v-5.5h3V20H18V9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
      '</svg>';
    button.addEventListener('click', () => map.fitBounds(this.bounds, { padding: this.padding }));

    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.container.append(button);
    return this.container;
  }

  onRemove(): void {
    this.container?.remove();
  }
}
