"""Load Overture Maps places (businesses and other points of interest) for North Macedonia into PostGIS.

Source: https://docs.overturemaps.org/guides/places/ . Each place comes from an upstream dataset with
its own license (Meta and Microsoft: CDLA Permissive 2.0, Foursquare: Apache 2.0, AllThePlaces:
CC0), so the dataset of every place is stored. Places carry a confidence score from 0 to 1, because
listings such as closed shops are not always removed.

Run from the repo root after load_osm.py (it clips to the country outline that script derives):
    etl/.venv/bin/python etl/load_overture_places.py
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
from sqlalchemy import text

from db import DATA_DIR, engine, finish_table, record_load

OUT = DATA_DIR / "overture" / "mk-place.parquet"
# North Macedonia's bounding box, west,south,east,north; the result is clipped to the border below
BBOX = "20.45,40.85,23.04,42.37"
TABLE = "overture_places"


def first(items, key: str | None = None):
    """First element of an Overture list column, or one field of it."""
    if items is None or len(items) == 0:
        return None
    return items[0] if key is None else items[0].get(key)


def address(items) -> str | None:
    a = first(items)
    if not a:
        return None
    return ", ".join(part for part in (a.get("freeform"), a.get("locality")) if part) or None


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cli = Path(sys.executable).parent / "overturemaps"
    subprocess.run([str(cli), "download", f"--bbox={BBOX}", "-f", "geoparquet", "-t", "place", "-o", str(OUT)], check=True)
    release = json.loads(OUT.with_suffix(".parquet.state").read_text())["last_release"]  # e.g. 2026-10-21.0

    raw = gpd.read_parquet(OUT)
    with engine().begin() as conn:
        country = gpd.read_postgis("SELECT geom FROM country", conn, geom_col="geom").geometry.iloc[0]
    raw = raw[raw.geometry.intersects(country)]

    places = gpd.GeoDataFrame(
        {
            "id": raw["id"],
            "name": raw["names"].map(lambda n: n.get("primary") if n else None),
            "category": raw["basic_category"],
            "confidence": raw["confidence"].round(2),
            "phone": raw["phones"].map(first),
            "website": raw["websites"].map(first),
            "address": raw["addresses"].map(address),
            "operating_status": raw["operating_status"],
            "dataset": raw["sources"].map(lambda s: first(s, "dataset")),
        },
        # Overture's GeoParquet declares OGC:CRS84 (lon/lat, like EPSG:4326 but with the axis order spelled out)
        geometry=raw.geometry.to_crs(4326).values,
    ).rename_geometry("geom")

    with engine().begin() as conn:
        places.to_postgis(TABLE, conn, if_exists="replace", index=False)
        finish_table(conn, TABLE, [f"CREATE INDEX IF NOT EXISTS {TABLE}_category_idx ON {TABLE} (category)"])
        released = datetime.strptime(release.split(".")[0], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        record_load(conn, TABLE, len(places), f"Overture release {release}", released)
    print(f"{TABLE}: {len(places)} rows (release {release})")


if __name__ == "__main__":
    main()
