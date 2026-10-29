# gis-learning

A hands-on project for learning GIS by building a web map application on real data for North Macedonia.

## Stack

| Part | Tech | Role |
|------|------|------|
| `etl/` | Python, GeoPandas | Reads raw geodata, filters it and loads it into PostGIS |
| `api/` | Java, Spring Boot, Gradle | Serves spatial queries from PostGIS as GeoJSON |
| `web/` | Angular, MapLibre GL JS | Displays the map and the data from the API |
| `docker-compose.yml` | PostgreSQL + PostGIS | Spatial database |

## Data sources

Geodata is not versioned in git (it is large and can always be downloaded again). Everything lives in `data/`, which is ignored.

| Data | Source | License |
|------|--------|---------|
| OpenStreetMap extract for North Macedonia (`macedonia-latest.osm.pbf`) | [Geofabrik download page](https://download.geofabrik.de/europe/macedonia.html), direct link: <https://download.geofabrik.de/europe/macedonia-latest.osm.pbf> | [ODbL](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors |
| Building footprints detected from satellite imagery | [Microsoft Global ML Building Footprints](https://github.com/microsoft/GlobalMLBuildingFootprints), downloaded by `etl/load_microsoft_buildings.py` | [CDLA Permissive 2.0](https://cdla.dev/permissive-2-0/) |
| Businesses and other places | [Overture Maps places](https://docs.overturemaps.org/guides/places/), downloaded by `etl/load_overture_places.py` | Per upstream dataset, see [Overture attribution](https://docs.overturemaps.org/attribution): CDLA Permissive 2.0 (Meta, Microsoft), Apache 2.0 (Foursquare), CC0 (AllThePlaces) |
| Local corrections to OSM (e.g. the name and status of the Klepalo crossing) | `etl/corrections/*.csv`, versioned in git, each row with its own source | Project data |

Geofabrik updates the extract daily and Overture releases monthly, so feature counts may differ slightly from the ones below. The source registry (`api/src/main/resources/registry/sources.json`) holds the full provenance, terms and known limitations of each source, and the app shows them per layer.

### Base maps

The web app can switch between these background maps. Each one shows its own attribution and terms in the app.

| Base map | Provider | Terms |
|----------|----------|-------|
| Streets, Bright, Light, Dark | [OpenFreeMap](https://openfreemap.org/) vector styles | Free, no key; © OpenMapTiles, data © OpenStreetMap contributors |
| Satellite (Esri) | Esri World Imagery | [Esri Master License Agreement](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9), intended for ArcGIS apps. Used here for personal learning; check Esri's terms before publishing |
| Satellite (Sentinel-2, 10 m) | [EOX Sentinel-2 cloudless 2024](https://cloudless.eox.at/) | [CC BY-NC-SA 4.0](https://cloudless.eox.at/documentation/license), non-commercial only |
| Topographic | [OpenTopoMap](https://opentopomap.org/) | CC-BY-SA; a volunteer service, fine for light use |

## Setup

Prerequisites: Docker, Python 3.12+, Java 21+, Node 22+, GDAL (`sudo apt install gdal-bin`).

### 1. Download and convert the OSM data

```bash
mkdir -p data
curl -L -o data/macedonia-latest.osm.pbf https://download.geofabrik.de/europe/macedonia-latest.osm.pbf

# PBF is slow to read; convert once to an indexed GeoPackage
ogr2ogr -f GPKG data/mk-osm.gpkg data/macedonia-latest.osm.pbf \
  points lines multipolygons -lco SPATIAL_INDEX=YES
```

### 2. Start PostGIS

```bash
docker compose up -d --wait
```

The database listens on `localhost:5434` (database, user and password are all `gis`).

### 3. Load the data into PostGIS

```bash
python3 -m venv etl/.venv
etl/.venv/bin/pip install -r etl/requirements.txt
etl/.venv/bin/python etl/load_osm.py                  # ~20 s
etl/.venv/bin/python etl/load_microsoft_buildings.py  # ~4 min, downloads 60 MB the first time
etl/.venv/bin/python etl/load_overture_places.py      # ~30 s
```

Run `load_osm.py` first: the other two clip their data to the country outline it derives. They are independent of each other, but don't run any of them while another is rebuilding tables, as they lock the same tables.

This creates these tables, each with a spatial index. OSM ids are typed: `n123`, `w123` and `r123` are node, way and relation 123 on openstreetmap.org.

| Table | Rows (approx.) | Contents |
|-------|----------------|----------|
| `municipalities` | 80 | Municipal boundaries (`admin_level=7`) |
| `places` | 2,800 | Named cities, towns, villages, suburbs and localities, with English and Albanian names where OSM has them |
| `pois` | 2,070 | Points of interest by `category`: pharmacy, school, health, supermarket, border_control. Mapped areas are stored as one point each |
| `roads` | 101,000 | Everything tagged `highway`, with class, number, surface, speed limit, lanes, one-way |
| `railways` | 1,700 | Everything tagged `railway` |
| `waterways` | 4,300 | Rivers, streams, canals, drains, ditches |
| `water_bodies` | 700 | Lakes, reservoirs, ponds (`natural=water`) |
| `buildings` | 124,500 | OSM buildings, with type, floors and address where mapped |
| `power_lines` | 354 | Power lines with voltage (75% of them) and operator |
| `substations` | 46 | Electrical substations, as points |
| `border_crossings` | 20 | Derived: OSM checkpoints merged per crossing (they are mapped per lane and on both sides), with status, municipality, nearest MK settlement, and a label position outside the border |
| `border_crossing_corrections` | few | Local corrections from `etl/corrections/border_crossings.csv` |
| `ms_buildings` | 776,000 | Microsoft footprints inside the border, with area |
| `overture_places` | 45,000 | Overture places inside the border, with category, confidence, contacts and upstream dataset |
| `country` | 1 | Country outline, derived as the union of the municipalities (simplified to ~200 m) |
| `layer_loads` | 1 per table | Provenance: when each table was loaded, its row count, and the source file and its date |

`places.search_text` holds every spelling of a name (Cyrillic, Latin with and without digraphs such as `kichevo` and `kicevo`, English, Albanian), lowercased and without diacritics, with a trigram index for search.

### 4. Run the API

```bash
cd api
./gradlew bootRun
```

The API runs on <http://localhost:8081>.

| Endpoint | Returns |
|----------|---------|
| `GET /api/sources` | The data-source registry: provider, access method, license, attribution, coverage, known limitations |
| `GET /api/layers` | The layer registry, each layer with its load record (`null` when its table is not loaded) |
| `GET /api/layers/{id}/features?bbox=w,s,e,n` | A layer's features as GeoJSON, optionally limited to a bounding box. At most the layer's `maxFeatures`; `truncated: true` says there were more |
| `GET /api/search?q=ohr&limit=8` | Places matching the text, prefix matches and bigger places first; tolerates small typos |
| `GET /api/country` | The country outline as a GeoJSON MultiPolygon |

### Sources and layers

The registries live in `api/src/main/resources/registry/`:

- `sources.json`: who provides the data, how it is accessed, license and attribution, coverage, and known limitations.
- `layers.json`: what the map can show. Each layer names its source, PostGIS table and optional SQL filter, geometry type, the fields exposed to the client, whether it loads `all` at once or by `viewport`, a minimum zoom, a feature cap, and a renderer (`fill-outline`, `line`, `circle`, `place-labels` or `border-crossings`). Fields marked `internal` are sent for rendering only, such as a label position, and not shown as attributes.

The registry is trusted server-side configuration: table and field names go into SQL, so they are validated as plain identifiers at startup, and `table` and `where` are never sent to clients. To add a layer, load its table in the ETL, add an entry to `layers.json` (and to `sources.json` if the provider is new), and restart the API.

### 5. Run the web app

```bash
cd web
npm install
npm start
```

Open <http://localhost:4200>. Requests to `/api` are proxied to the API.

- **Base map**: streets, light, dark, two satellite options and topographic, each with its terms (see [Base maps](#base-maps)). Switching keeps all layers and their loaded data.
- **Layers** (16): cities and towns, border crossings (grey when not in use, labels outside the border), pharmacies, health, schools, supermarkets, Overture businesses, substations, power lines, railways, roads, rivers, lakes, OSM buildings, Microsoft buildings, municipalities. Large layers load only the visible area and only from a minimum zoom (buildings from 15, roads from 13).
- **Layers panel**: switch each layer on and off, change its opacity and drawing order, and expand it to see its source, license, coverage, data date and limitations. Each layer shows its own state (feature count, loading, none in this area, zoom in, failed, not loaded), and one failing layer does not affect the others.
- **Feature inspection**: click a feature to see its attributes and where the data comes from.
- **Search**: finds places in any script (`Скопје`, `skopje`, `Shkup`).
- **Map controls**: zoom, compass, back to the whole country, your location, fullscreen, and a scale bar.

Your layer settings and map position are saved in the browser (`localStorage`), separately from the registry: registry changes never overwrite them, new layers appear with their defaults, and settings of a layer that leaves the registry are kept and shown as "No longer available" until you forget them.

The "Cities and towns" layer labels all 34 cities and towns, because the base map drops many small towns at country zoom. While it is on, the base map's own city and town labels are hidden inside the country with a `within` filter, so nothing is labelled twice; outside the border they stay.

Tests: `./gradlew test` in `api/` (the context test needs the database running) and `npm test` in `web/`.

The production bundle budget in `angular.json` is raised to 2 MB, because MapLibre alone is about 1 MB.

## Learning plan

1. **Basics in QGIS**: vector vs raster, coordinate systems, attributes, styling
2. **Web map**: MapLibre in Angular, own vector tiles (PMTiles)
3. **Spatial database**: PostGIS queries (nearest, within distance, intersects), spatial indexes
4. **Raster analysis**: elevation model, hillshade, slope, viewshed
5. **Routing**: OSRM, routes and isochrones
6. **Capstone**: a real application built on everything above
