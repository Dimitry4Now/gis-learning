import { Component, DestroyRef, inject, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, distinctUntilChanged, map, of, switchMap } from 'rxjs';
import type { Feature, FeatureCollection, Point } from 'geojson';

export interface PlaceProps {
  name: string;
  name_en: string | null;
  place: string;
}

export type Place = Feature<Point, PlaceProps>;

@Component({
  selector: 'app-place-search',
  templateUrl: './place-search.html',
  styleUrl: './place-search.css',
})
export class PlaceSearch {
  private readonly http = inject(HttpClient);
  private readonly queries = new Subject<string>();

  readonly selected = output<Place>();
  readonly cleared = output<void>();

  protected readonly query = signal('');
  protected readonly results = signal<Place[]>([]);
  protected readonly active = signal(-1);
  protected readonly failed = signal(false);

  constructor() {
    this.queries
      .pipe(
        map((q) => q.trim()),
        debounceTime(250),
        distinctUntilChanged(),
        // switchMap cancels the previous request when a new key is typed
        switchMap((q) =>
          q.length < 2
            ? of([])
            : this.http.get<FeatureCollection<Point, PlaceProps>>('/api/search', { params: { q } }).pipe(
                map((fc) => fc.features as Place[]),
                catchError(() => {
                  this.failed.set(true);
                  return of([]);
                }),
              ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((places) => {
        this.results.set(places);
        this.active.set(places.length ? 0 : -1);
      });
  }

  protected onInput(value: string): void {
    this.query.set(value);
    this.failed.set(false);
    this.queries.next(value);
    if (!value) {
      this.cleared.emit();
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.results().length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      this.active.update((i) => (i + 1) % count);
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      this.active.update((i) => (i - 1 + count) % count);
    } else if (event.key === 'Enter' && this.active() >= 0) {
      this.choose(this.results()[this.active()]);
    } else if (event.key === 'Escape') {
      this.results.set([]);
    }
  }

  protected choose(place: Place): void {
    this.query.set(place.properties.name);
    this.results.set([]);
    this.selected.emit(place);
  }

  protected clear(): void {
    this.query.set('');
    this.results.set([]);
    this.queries.next('');
    this.cleared.emit();
  }
}
