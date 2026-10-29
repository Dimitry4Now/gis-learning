"""Load selected OSM layers for North Macedonia from the GeoPackage into PostGIS.

Run from the repo root after `docker compose up -d`:
    etl/.venv/bin/python etl/load_osm.py
"""

import os
from pathlib import Path

import geopandas as gpd
from sqlalchemy import create_engine, text

GPKG = Path(__file__).resolve().parent.parent / "data" / "mk-osm.gpkg"
DB_URL = os.environ.get("GIS_DB_URL", "postgresql+psycopg://gis:gis@localhost:5434/gis")

# table name -> (source layer, SQL filter on the OSM attributes)
EXTRACTS = {
    "municipalities": (
        "multipolygons",
        "boundary = 'administrative' AND admin_level = '7'",
    ),
    "pharmacies": (
        "points",
        "other_tags LIKE '%\"amenity\"=>\"pharmacy\"%'",
    ),
}


def load(engine, table: str, layer: str, where: str) -> None:
    gdf = gpd.read_file(GPKG, layer=layer, where=where, columns=["osm_id", "name"])
    if gdf.empty:
        raise SystemExit(f"{table}: filter matched nothing in layer {layer}")

    gdf = gdf.rename_geometry("geom").to_crs(4326)
    gdf.to_postgis(table, engine, if_exists="replace", index=False)

    with engine.begin() as conn:
        conn.execute(text(f"CREATE INDEX IF NOT EXISTS {table}_geom_idx ON {table} USING GIST (geom)"))
        conn.execute(text(f"ANALYZE {table}"))

    print(f"{table}: {len(gdf)} rows")


def main() -> None:
    if not GPKG.exists():
        raise SystemExit(f"Missing {GPKG}. Convert the OSM extract first (see README).")

    engine = create_engine(DB_URL)
    for table, (layer, where) in EXTRACTS.items():
        load(engine, table, layer, where)


if __name__ == "__main__":
    main()
