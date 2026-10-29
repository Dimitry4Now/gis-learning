import { Component } from '@angular/core';
import { MapView } from './map/map-view';

@Component({
  imports: [MapView],
  selector: 'app-root',
  template: '<app-map-view />',
  styles: ':host { display: block; height: 100vh; }',
})
export class App {}
