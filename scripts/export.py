# /// script
# requires-python = ">=3.11"
# dependencies = ["psycopg[binary]>=3.2", "pyarrow>=17", "pandas>=2.2"]
# ///
"""Export every table to Parquet + CSV for analysis.

    DATABASE_URL='postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres' uv run scripts/export.py [out_dir]

Times are UTC (timestamptz). `local_day` is the accounting day (Asia/Almaty with the day
boundary from profiles.day_boundary_minutes). `meals` holds versions (is_current = latest),
`events` is the append-only journal of every change.
"""
import datetime as dt
import os
import pathlib
import sys

import pandas as pd
import psycopg

TABLES = [
    "profiles", "goals", "foods", "meal_templates", "meal_template_items", "media", "recognitions",
    "meals", "meal_items", "meal_corrections", "checklist_items", "checklist_marks", "body_metrics",
    "workouts", "slips", "memories", "skills", "reminder_rules", "notifications", "agent_messages",
    "agent_runs", "llm_calls", "recipes", "shopping_lists", "events",
]
VIEWS = ["day_totals", "weight_daily", "checklist_state"]
DROP = {"embedding", "tsv", "search_text", "access_token_enc", "refresh_token_enc"}


def main() -> None:
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is required (Supabase → Connect → Session pooler)")
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else f"export-{dt.date.today().isoformat()}")
    out.mkdir(parents=True, exist_ok=True)
    with psycopg.connect(url) as conn:
        for name in TABLES + VIEWS:
            with conn.cursor() as cur:
                cur.execute(f'select * from public."{name}"')
                cols = [d.name for d in cur.description]
                df = pd.DataFrame(cur.fetchall(), columns=cols)
            df = df.drop(columns=[c for c in df.columns if c in DROP])
            for c in df.columns:  # jsonb / arrays → JSON strings for Parquet compatibility
                if df[c].map(lambda v: isinstance(v, (dict, list))).any():
                    df[c] = df[c].map(lambda v: None if v is None else pd.io.json.dumps(v))
            df.to_parquet(out / f"{name}.parquet", index=False)
            df.to_csv(out / f"{name}.csv", index=False)
            print(f"{name:22s} {len(df):>7d} rows")
    print(f"→ {out.resolve()}")


if __name__ == "__main__":
    main()
