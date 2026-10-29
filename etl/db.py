"""Database connection and load log shared by the ETL scripts."""

import os
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, text

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_URL = os.environ.get("GIS_DB_URL", "postgresql+psycopg://gis:gis@localhost:5434/gis")


def engine():
    return create_engine(DB_URL)


def record_load(conn, table: str, row_count: int, source_file: str, source_modified: datetime) -> None:
    """Provenance for the API: when each table was loaded, from which file, and how old that file was."""
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS layer_loads (
          table_name text PRIMARY KEY,
          row_count integer NOT NULL,
          loaded_at timestamptz NOT NULL,
          source_file text NOT NULL,
          source_modified timestamptz NOT NULL
        )
    """))
    conn.execute(
        text("""
            INSERT INTO layer_loads VALUES (:table, :rows, now(), :file, :modified)
            ON CONFLICT (table_name) DO UPDATE SET row_count = excluded.row_count, loaded_at = excluded.loaded_at,
              source_file = excluded.source_file, source_modified = excluded.source_modified
        """),
        {"table": table, "rows": row_count, "file": source_file, "modified": source_modified},
    )


def finish_table(conn, table: str, extra_statements: list[str] = ()) -> None:
    """Spatial index, any extra indexes, and fresh planner statistics."""
    conn.execute(text(f"CREATE INDEX IF NOT EXISTS {table}_geom_idx ON {table} USING GIST (geom)"))
    for statement in extra_statements:
        conn.execute(text(statement))
    conn.execute(text(f"ANALYZE {table}"))
