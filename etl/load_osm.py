"""Load selected OSM layers for North Macedonia from the GeoPackage into PostGIS.

Run from the repo root after `docker compose up -d`:
    etl/.venv/bin/python etl/load_osm.py
"""

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import geopandas as gpd
import pandas as pd
import pyogrio
from sqlalchemy import text

from db import DATA_DIR, engine, finish_table, record_load

GPKG = DATA_DIR / "mk-osm.gpkg"
CORRECTIONS = Path(__file__).resolve().parent / "corrections"

# Macedonian Cyrillic -> Latin, in two spellings people actually type: with digraphs (Kichevo)
# and with single letters, which is what the official diacritics (Kičevo) reduce to without accents
TRANSLIT_DIGRAPH = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "ѓ": "gj", "е": "e", "ж": "zh", "з": "z",
    "ѕ": "dz", "и": "i", "ј": "j", "к": "k", "л": "l", "љ": "lj", "м": "m", "н": "n", "њ": "nj",
    "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "ќ": "kj", "у": "u", "ф": "f", "х": "h",
    "ц": "c", "ч": "ch", "џ": "dzh", "ш": "sh",
}
TRANSLIT_SINGLE = TRANSLIT_DIGRAPH | {"ѓ": "g", "ж": "z", "ќ": "k", "ч": "c", "џ": "dz", "ш": "s"}

# OSM place types worth finding in a search box, most important first
PLACE_RANK = {
    "city": 1, "town": 2, "village": 3, "suburb": 4, "quarter": 4, "neighbourhood": 5,
    "hamlet": 5, "locality": 6, "isolated_dwelling": 6, "square": 6,
}

# Point-of-interest categories: category -> (OSM key, values)
POI_CATEGORIES = {
    "pharmacy": ("amenity", ["pharmacy"]),
    "school": ("amenity", ["school", "kindergarten", "college", "university"]),
    "health": ("amenity", ["hospital", "clinic", "doctors", "dentist"]),
    "supermarket": ("shop", ["supermarket"]),
    "border_control": ("barrier", ["border_control"]),
}

# OSM object type prefixes, as in openstreetmap.org/node/123, /way/123, /relation/123
ID_PREFIX = {"points": "n", "lines": "w"}


def hstore_value(other_tags: str | None, key: str) -> str | None:
    """Read one key from GDAL's hstore-style other_tags string: "k1"=>"v1","k2"=>"v2"."""
    if not isinstance(other_tags, str):  # pandas gives NaN, not None, for missing values
        return None
    match = re.search(rf'"{re.escape(key)}"=>"((?:[^"\\]|\\.)*)"', other_tags)
    return match.group(1) if match else None


def has_tag(key: str, values: list[str]) -> str:
    """SQL filter for a tag stored inside other_tags."""
    return "(" + " OR ".join(f"other_tags LIKE '%\"{key}\"=>\"{v}\"%'" for v in values) + ")"


def in_list(column: str, values: list[str]) -> str:
    """SQL filter for a tag GDAL promoted to its own column."""
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def tag_filter(layer: str, key: str, values: list[str]) -> str:
    """SQL filter for a tag, wherever GDAL stored it in this layer: its own column or other_tags."""
    return in_list(key, values) if key in layer_fields(layer) else has_tag(key, values)


def layer_fields(layer: str) -> set[str]:
    return set(pyogrio.read_info(GPKG, layer=layer)["fields"])


def any_poi(layer: str) -> str:
    return " OR ".join(tag_filter(layer, key, values) for key, values in POI_CATEGORIES.values())


def column_name(osm_key: str) -> str:
    return osm_key.replace(":", "_")


def normalize(value: str) -> str:
    """Lowercase and strip diacritics (č -> c, ë -> e, ѓ -> г).

    Must stay in sync with PlaceSearchController.normalize in the API, which does the same to the query.
    """
    decomposed = unicodedata.normalize("NFKD", value.lower())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def search_text(*names: str | None) -> str:
    """All spellings of a place in one lowercase string, for trigram search."""
    variants = set()
    for name in (n for n in names if isinstance(n, str)):
        lower = name.lower()
        variants.add(normalize(name))
        for table in (TRANSLIT_DIGRAPH, TRANSLIT_SINGLE):
            variants.add(normalize("".join(table.get(c, c) for c in lower)))
    return " ".join(sorted(variants))


def prepare_places(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    gdf = gdf[gdf["place"].isin(PLACE_RANK.keys())].copy()
    gdf["place_rank"] = gdf["place"].map(PLACE_RANK)
    gdf["search_text"] = [search_text(*names) for names in zip(gdf["name"], gdf["name_en"], gdf["name_sq"])]
    return gdf


def prepare_pois(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    gdf = gdf.copy()
    gdf["category"] = None
    gdf["kind"] = None
    for category, (key, values) in POI_CATEGORIES.items():
        match = gdf[key].isin(values) & gdf["category"].isna()
        gdf.loc[match, "category"] = category
        gdf.loc[match, "kind"] = gdf.loc[match, key]
    return gdf[gdf["category"].notna()].drop(columns=[key for key, _ in POI_CATEGORIES.values()])


@dataclass
class Extract:
    table: str
    # (GeoPackage layer, SQL filter) pairs; rows from all of them end up in one table. A filter can be
    # a function of the layer name, for tags that GDAL stores differently per layer.
    sources: list[tuple[str, str | Callable[[str], str]]]
    # OSM tag keys to turn into columns (":" becomes "_", so name:en -> name_en)
    tags: list[str] = field(default_factory=list)
    # store polygons as one representative point each, so a POI is one point however it was mapped
    as_points: bool = False
    transform: Callable[[gpd.GeoDataFrame], gpd.GeoDataFrame] | None = None
    indexes: list[str] = field(default_factory=list)


EXTRACTS = [
    Extract("municipalities", [("multipolygons", "boundary = 'administrative' AND admin_level = '7'")]),
    Extract(
        "places",
        [("points", "place IS NOT NULL AND name IS NOT NULL")],
        tags=["place", "name:en", "name:sq"],
        transform=prepare_places,
        indexes=[
            "CREATE EXTENSION IF NOT EXISTS pg_trgm",
            "CREATE INDEX IF NOT EXISTS places_search_idx ON places USING GIN (search_text gin_trgm_ops)",
        ],
    ),
    Extract(
        "pois",
        [("points", any_poi), ("multipolygons", any_poi)],
        # abandoned / disused / access mark facilities that exist but are not in use
        tags=[*{key for key, _ in POI_CATEGORIES.values()}, "opening_hours", "operator", "abandoned", "disused", "access"],
        as_points=True,
        transform=prepare_pois,
        indexes=["CREATE INDEX IF NOT EXISTS pois_category_idx ON pois (category)"],
    ),
    Extract(
        "roads",
        [("lines", "highway IS NOT NULL")],
        tags=["highway", "ref", "surface", "maxspeed", "lanes", "oneway"],
    ),
    Extract("railways", [("lines", "railway IS NOT NULL")], tags=["railway", "usage", "electrified", "service"]),
    Extract(
        "waterways",
        [("lines", in_list("waterway", ["river", "stream", "canal", "drain", "ditch"]))],
        tags=["waterway", "intermittent"],
    ),
    Extract("water_bodies", [("multipolygons", "\"natural\" = 'water'")], tags=["water", "intermittent"]),
    Extract(
        "buildings",
        [("multipolygons", "building IS NOT NULL")],
        tags=["building", "building:levels", "addr:street", "addr:housenumber", "height"],
    ),
    Extract(
        "power_lines",
        [("lines", has_tag("power", ["line", "minor_line"]))],
        tags=["power", "voltage", "operator", "cables", "frequency"],
    ),
    Extract(
        "substations",
        [("points", has_tag("power", ["substation"])), ("multipolygons", has_tag("power", ["substation"]))],
        tags=["substation", "voltage", "operator"],
        as_points=True,
    ),
]

# Tables from earlier versions of this script that no longer exist
RETIRED = ["pharmacies"]  # now the pharmacy category of pois

# Tables computed from loaded tables, rebuilt after every load
DERIVED = {
    # Country outline as the union of all municipalities, simplified to ~200 m. The web map uses it
    # to hide the base map's own MK town labels; too slow (~1 s) to compute per request.
    "country": """
        CREATE TABLE country AS
        SELECT ST_Multi(ST_SimplifyPreserveTopology(ST_Union(geom), 0.002))::geometry(MultiPolygon, 4326) AS geom
        FROM municipalities
    """,
    # One point per border crossing. OSM maps checkpoints per lane or booth, and on both sides of the
    # border, so checkpoints within ~1 km are merged; only those within 3 km of the border count,
    # which leaves out inland customs posts. Names and positions prefer the MK side; a local
    # correction (etl/corrections) wins over both, and the nearest MK settlement is the last resort,
    # with name_source saying which one was used. A crossing is "not in use" when OSM marks any of
    # its checkpoints abandoned, disused or access=no, unless a correction gives a more precise
    # status (e.g. "never opened"). label_anchor puts the label on the side facing
    # away from the country's centre, i.e. outside the border.
    "border_crossings": r"""
        CREATE TABLE border_crossings AS
        WITH gates AS (
          SELECT p.osm_id, p.name, p.geom, ST_Intersects(p.geom, c.geom) AS inside,
                 (p.abandoned = 'yes' OR p.disused = 'yes' OR p.access = 'no') AS out_of_use
          FROM pois p, country c
          WHERE p.category = 'border_control'
            AND ST_DWithin(p.geom::geography, ST_Boundary(c.geom)::geography, 3000)
        ),
        clustered AS (
          SELECT *, ST_ClusterDBSCAN(geom, eps := 0.012, minpoints := 1) OVER () AS cluster
          FROM gates
        ),
        crossings AS (
          SELECT cluster, min(osm_id) AS osm_id, array_agg(osm_id) AS osm_ids, count(*) AS checkpoints,
                 coalesce(bool_or(out_of_use), false) AS out_of_use,
                 (array_agg(name ORDER BY name) FILTER (WHERE name IS NOT NULL AND inside))[1] AS name_mk,
                 (array_agg(name ORDER BY name) FILTER (WHERE name IS NOT NULL))[1] AS name_any,
                 ST_Centroid(coalesce(ST_Collect(geom) FILTER (WHERE inside), ST_Collect(geom))) AS geom
          FROM clustered
          GROUP BY cluster
        ),
        centre AS (SELECT ST_Centroid(geom) AS geom FROM country)
        SELECT x.osm_id,
               coalesce(fix.name, x.name_mk, x.name_any) AS name,
               near.name AS near,
               muni.name AS municipality,
               coalesce(
                 fix.name,
                 split_part(regexp_replace(x.name_mk,
                   '^(Граничен премин|Гранични прелаз|ГКПП|Vendkalimi [Kk]ufitar|Pika [Kk]ufitare|Border [Cc]rossing)\s+', ''),
                   ' / ', 1),
                 near.name
               ) AS label,
               CASE WHEN fix.name IS NOT NULL THEN 'local correction (' || fix.source || ')'
                    WHEN x.name_mk IS NOT NULL THEN 'OpenStreetMap'
                    ELSE 'nearest settlement (no MK-side name in OpenStreetMap)' END AS name_source,
               -- OSM records closures, not openings, so the default only says nothing closed is mapped
               coalesce(fix.status, CASE WHEN x.out_of_use THEN 'not in use' ELSE 'no closure recorded' END) AS status,
               fix.note,
               x.checkpoints,
               (ARRAY['bottom', 'bottom-left', 'left', 'top-left', 'top', 'top-right', 'right', 'bottom-right'])
                 [(round(degrees(ST_Azimuth(centre.geom, x.geom)) / 45)::integer % 8) + 1] AS label_anchor,
               x.geom::geometry(Point, 4326) AS geom
        FROM crossings x
        CROSS JOIN centre
        LEFT JOIN border_crossing_corrections fix ON fix.osm_id = ANY (x.osm_ids)
        LEFT JOIN municipalities muni ON ST_Intersects(muni.geom, x.geom)
        CROSS JOIN LATERAL (
          SELECT p.name FROM places p, country c
          WHERE p.place IN ('city', 'town', 'village', 'hamlet') AND ST_Intersects(p.geom, c.geom)
          ORDER BY p.geom <-> x.geom
          LIMIT 1
        ) near
    """,
}


def read_source(layer: str, where: str | Callable[[str], str], tags: list[str]) -> gpd.GeoDataFrame:
    """Reads one GeoPackage layer and turns the requested tags into columns, wherever GDAL stored them."""
    if callable(where):
        where = where(layer)
    available = layer_fields(layer)
    id_columns = ["osm_id", "osm_way_id"] if layer == "multipolygons" else ["osm_id"]
    promoted = [t for t in tags if t in available]
    gdf = gpd.read_file(GPKG, layer=layer, where=where, columns=[*id_columns, "name", "other_tags", *promoted])

    if layer == "multipolygons":  # areas from relations carry osm_id, areas from closed ways osm_way_id
        gdf["osm_id"] = ("r" + gdf["osm_id"]).where(gdf["osm_id"].notna(), "w" + gdf["osm_way_id"])
        gdf = gdf.drop(columns="osm_way_id")
    else:
        gdf["osm_id"] = ID_PREFIX[layer] + gdf["osm_id"]

    for tag in tags:
        if tag not in promoted:
            gdf[column_name(tag)] = gdf["other_tags"].map(lambda t, key=tag: hstore_value(t, key))
    return gdf.drop(columns="other_tags")


def load(conn, extract: Extract) -> None:
    parts = [read_source(layer, where, extract.tags) for layer, where in extract.sources]
    gdf = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), crs=parts[0].crs)
    if gdf.empty:
        raise SystemExit(f"{extract.table}: filters matched nothing")

    gdf = gdf.rename_geometry("geom").to_crs(4326)
    if extract.as_points:
        gdf["geom"] = gdf.geometry.representative_point()
    if extract.transform:
        gdf = extract.transform(gdf)
    gdf.to_postgis(extract.table, conn, if_exists="replace", index=False)

    finish_table(conn, extract.table, extract.indexes)
    modified = datetime.fromtimestamp(GPKG.stat().st_mtime, tz=timezone.utc)
    record_load(conn, extract.table, len(gdf), GPKG.name, modified)
    print(f"{extract.table}: {len(gdf)} rows")


def load_corrections(conn) -> None:
    """Local corrections to OSM data, each with its own source, kept as a separate table."""
    corrections = pd.read_csv(CORRECTIONS / "border_crossings.csv", dtype=str)
    corrections.to_sql("border_crossing_corrections", conn, if_exists="replace", index=False)
    print(f"border_crossing_corrections: {len(corrections)} rows")


def main() -> None:
    if not GPKG.exists():
        raise SystemExit(f"Missing {GPKG}. Convert the OSM extract first (see README).")

    with engine().begin() as conn:
        for extract in EXTRACTS:
            load(conn, extract)
        load_corrections(conn)
        modified = datetime.fromtimestamp(GPKG.stat().st_mtime, tz=timezone.utc)
        for table, query in DERIVED.items():
            conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
            conn.execute(text(query))
            rows = conn.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
            finish_table(conn, table)
            record_load(conn, table, rows, f"derived from {GPKG.name}", modified)
            print(f"{table}: {rows} rows, derived")
        for table in RETIRED:
            conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
            conn.execute(text("DELETE FROM layer_loads WHERE table_name = :t"), {"t": table})


if __name__ == "__main__":
    main()
