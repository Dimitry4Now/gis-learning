"""Load Microsoft's machine-learning building footprints for North Macedonia into PostGIS.

Source: https://github.com/microsoft/GlobalMLBuildingFootprints (CDLA Permissive 2.0). Footprints are
detected from satellite imagery, so they are outlines only: no height, use or address.

Run from the repo root after load_osm.py (it clips to the country outline that script derives):
    etl/.venv/bin/python etl/load_microsoft_buildings.py
"""

import csv
import subprocess
import urllib.request
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.engine import make_url

from db import DATA_DIR, DB_URL, engine, finish_table, record_load

LINKS_URL = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
# Microsoft still lists the country under its pre-2019 name
LOCATION = "FYROMakedonija"
OUT_DIR = DATA_DIR / "microsoft"
TABLE = "ms_buildings"


def download(url: str, path) -> None:
    if path.exists():
        return
    print(f"downloading {path.name}")
    tmp = path.with_suffix(path.suffix + ".part")
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(path)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    links = OUT_DIR / "dataset-links.csv"
    links.unlink(missing_ok=True)  # always use the current list
    download(LINKS_URL, links)
    with links.open(newline="") as f:
        tiles = [row for row in csv.DictReader(f) if row["Location"] == LOCATION]
    if not tiles:
        raise SystemExit(f"No tiles for {LOCATION} in {LINKS_URL}")

    url = make_url(DB_URL)
    pg = f"PG:host={url.host} port={url.port} dbname={url.database} user={url.username} password={url.password}"
    for i, tile in enumerate(tiles):
        path = OUT_DIR / f"{tile['QuadKey']}.geojsonl.gz"
        download(tile["Url"], path)
        subprocess.run(
            [
                "ogr2ogr", "-f", "PostgreSQL", pg, f"/vsigzip/{path}",
                "-nln", f"{TABLE}_staging", "-lco", "GEOMETRY_NAME=geom", "-lco", "SPATIAL_INDEX=NONE",
                # With a SQL select the geometry must be listed explicitly, or it is dropped
                "-sql", f"SELECT geometry, '{tile['QuadKey']}' AS quadkey FROM \"{path.name.removesuffix('.gz')}\"",
                "-dialect", "SQLite",
                "-overwrite" if i == 0 else "-append",
            ],
            check=True,
        )
        print(f"imported tile {tile['QuadKey']} ({i + 1}/{len(tiles)})")

    with engine().begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {TABLE}"))
        # Tiles are grouped by country but cut along tile edges, so keep only footprints inside MK.
        # Joining the single country row lets PostGIS prepare that polygon once and reuse it for every
        # building (~2 s); an EXISTS over ST_Subdivide pieces took more than 10 minutes.
        conn.execute(text(f"""
            CREATE TABLE {TABLE} AS
            SELECT 'ms-' || s.quadkey || '-' || s.ogc_fid AS id,
                   s.geom::geometry(Polygon, 4326) AS geom,
                   round(ST_Area(s.geom::geography))::integer AS area_m2
            FROM {TABLE}_staging s, country c
            WHERE ST_Intersects(s.geom, c.geom)
        """))
        conn.execute(text(f"DROP TABLE {TABLE}_staging"))
        finish_table(conn, TABLE)
        rows = conn.execute(text(f"SELECT count(*) FROM {TABLE}")).scalar_one()
        uploaded = max(datetime.strptime(t["UploadDate"], "%Y-%m-%d") for t in tiles).replace(tzinfo=timezone.utc)
        record_load(conn, TABLE, rows, f"{len(tiles)} {LOCATION} tiles from dataset-links.csv", uploaded)
    print(f"{TABLE}: {rows} rows")


if __name__ == "__main__":
    main()
