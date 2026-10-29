"""Load selected OSM layers for North Macedonia from the GeoPackage into PostGIS.

Run from the repo root after `docker compose up -d`:
    etl/.venv/bin/python etl/load_osm.py
"""

import os
import re
import unicodedata
from pathlib import Path

import geopandas as gpd
from sqlalchemy import create_engine, text

GPKG = Path(__file__).resolve().parent.parent / "data" / "mk-osm.gpkg"
DB_URL = os.environ.get("GIS_DB_URL", "postgresql+psycopg://gis:gis@localhost:5434/gis")

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


def hstore_value(other_tags: str | None, key: str) -> str | None:
    """Read one key from GDAL's hstore-style other_tags string: "k1"=>"v1","k2"=>"v2"."""
    if not isinstance(other_tags, str):  # pandas gives NaN, not None, for missing values
        return None
    match = re.search(rf'"{re.escape(key)}"=>"((?:[^"\\]|\\.)*)"', other_tags)
    return match.group(1) if match else None


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
    gdf["name_en"] = gdf["other_tags"].map(lambda t: hstore_value(t, "name:en"))
    gdf["name_sq"] = gdf["other_tags"].map(lambda t: hstore_value(t, "name:sq"))
    gdf["place_rank"] = gdf["place"].map(PLACE_RANK)
    gdf["search_text"] = [search_text(*names) for names in zip(gdf["name"], gdf["name_en"], gdf["name_sq"])]
    return gdf.drop(columns="other_tags")


# table name -> (source layer, SQL filter on the OSM attributes, columns, optional transform)
EXTRACTS = {
    "municipalities": (
        "multipolygons",
        "boundary = 'administrative' AND admin_level = '7'",
        ["osm_id", "name"],
        None,
    ),
    "pharmacies": (
        "points",
        "other_tags LIKE '%\"amenity\"=>\"pharmacy\"%'",
        ["osm_id", "name"],
        None,
    ),
    "places": (
        "points",
        "place IS NOT NULL AND name IS NOT NULL",
        ["osm_id", "name", "place", "other_tags"],
        prepare_places,
    ),
}

# Extra indexes per table, beyond the spatial index every table gets
INDEXES = {
    "places": [
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        "CREATE INDEX IF NOT EXISTS places_search_idx ON places USING GIN (search_text gin_trgm_ops)",
    ],
}


def load(engine, table: str, layer: str, where: str, columns: list[str], transform) -> None:
    gdf = gpd.read_file(GPKG, layer=layer, where=where, columns=columns)
    if gdf.empty:
        raise SystemExit(f"{table}: filter matched nothing in layer {layer}")

    gdf = gdf.rename_geometry("geom").to_crs(4326)
    if transform:
        gdf = transform(gdf)
    gdf.to_postgis(table, engine, if_exists="replace", index=False)

    with engine.begin() as conn:
        conn.execute(text(f"CREATE INDEX IF NOT EXISTS {table}_geom_idx ON {table} USING GIST (geom)"))
        for statement in INDEXES.get(table, []):
            conn.execute(text(statement))
        conn.execute(text(f"ANALYZE {table}"))

    print(f"{table}: {len(gdf)} rows")


def main() -> None:
    if not GPKG.exists():
        raise SystemExit(f"Missing {GPKG}. Convert the OSM extract first (see README).")

    engine = create_engine(DB_URL)
    for table, (layer, where, columns, transform) in EXTRACTS.items():
        load(engine, table, layer, where, columns, transform)


if __name__ == "__main__":
    main()
