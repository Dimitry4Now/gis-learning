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
| Base map tiles (used by the web app) | [OpenFreeMap](https://openfreemap.org/) | Free, no API key, built on OpenStreetMap data |

Geofabrik updates the extract daily, so feature counts may differ slightly from the ones below.

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
etl/.venv/bin/python etl/load_osm.py
```

This creates these tables, each with a spatial index:

| Table | Rows (approx.) | Contents |
|-------|----------------|----------|
| `municipalities` | 80 | Municipal boundaries (`admin_level=7`) |
| `pharmacies` | 287 | Pharmacy points (`amenity=pharmacy`) |
| `places` | 2,800 | Named cities, towns, villages, suburbs and localities, with English and Albanian names where OSM has them |
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
- `layers.json`: what the map can show. Each layer names its source, PostGIS table and optional SQL filter, geometry type, the fields exposed to the client, whether it loads `all` at once or by `viewport`, a minimum zoom, a feature cap, and a renderer (`fill-outline`, `circle` or `place-labels`).

The registry is trusted server-side configuration: table and field names go into SQL, so they are validated as plain identifiers at startup, and `table` and `where` are never sent to clients. To add a layer, load its table in the ETL, add an entry to `layers.json` (and to `sources.json` if the provider is new), and restart the API.

### 5. Run the web app

```bash
cd web
npm install
npm start
```

Open <http://localhost:4200>. Requests to `/api` are proxied to the API.

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
