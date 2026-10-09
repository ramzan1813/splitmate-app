import os
import re
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from contextlib import asynccontextmanager

import aiosqlite
import asyncpg
from app.config import settings

logger = logging.getLogger("splitmate.db")

 
class Database:
    def __init__(self, db_url: str):
        self.db_url = db_url
        self.is_sqlite = db_url.startswith("sqlite")
        self.sqlite_path: Optional[str] = None
        self.pg_pool: Optional[asyncpg.Pool] = None

        if self.is_sqlite:
            # Parse path from sqlite:/// or sqlite+aiosqlite:///
            clean_url = re.sub(r"^sqlite(?:\+aiosqlite)?:///?", "", db_url)
            self.sqlite_path = clean_url if clean_url else ":memory:"

    async def connect(self):
        if self.is_sqlite:
            logger.info(f"Connecting to SQLite database: {self.sqlite_path}")
            if self.sqlite_path != ":memory:" and not os.path.exists(os.path.dirname(os.path.abspath(self.sqlite_path))):
                os.makedirs(os.path.dirname(os.path.abspath(self.sqlite_path)), exist_ok=True)
            await self.run_migrations()
        else:
            # PostgreSQL URL cleanup
            pg_url = re.sub(r"^postgresql\+(?:asyncpg|psycopg2|psycopg)://", "postgresql://", self.db_url)
            logger.info("Connecting to PostgreSQL pool...")
            
            async def init_connection(conn):
                await conn.set_type_codec(
                    'jsonb',
                    encoder=json.dumps,
                    decoder=json.loads,
                    schema='pg_catalog'
                )
                await conn.set_type_codec(
                    'json',
                    encoder=json.dumps,
                    decoder=json.loads,
                    schema='pg_catalog'
                )

            self.pg_pool = await asyncpg.create_pool(pg_url, min_size=2, max_size=20, init=init_connection)
            await self.run_migrations()

    async def disconnect(self):
        if self.pg_pool:
            await self.pg_pool.close()

    async def run_migrations(self):
        migrations_dir = Path(__file__).parent.parent / "migrations"
        if self.is_sqlite:
            schema_file = migrations_dir / "001_init_sqlite.sql"
            if schema_file.exists():
                sql = schema_file.read_text(encoding="utf-8")
                async with aiosqlite.connect(self.sqlite_path) as db:
                    await db.executescript(sql)
                    await db.commit()
                logger.info("SQLite schema migrations applied successfully.")
        else:
            schema_file = migrations_dir / "001_init_postgres.sql"
            if schema_file.exists() and self.pg_pool:
                sql = schema_file.read_text(encoding="utf-8")
                async with self.pg_pool.acquire() as conn:
                    await conn.execute(sql)
                logger.info("PostgreSQL schema migrations applied successfully.")

    @asynccontextmanager
    async def transaction(self):
        """Context manager providing transactional isolation."""
        if self.is_sqlite:
            async with aiosqlite.connect(self.sqlite_path) as conn:
                conn.row_factory = aiosqlite.Row
                await conn.execute("BEGIN IMMEDIATE")
                try:
                    yield SQLiteExecutor(conn)
                    await conn.commit()
                except Exception:
                    await conn.rollback()
                    raise
        else:
            assert self.pg_pool is not None
            async with self.pg_pool.acquire() as conn:
                async with conn.transaction():
                    yield PostgresExecutor(conn)

    async def fetch_all(self, query: str, params: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
        async with self.transaction() as tx:
            return await tx.fetch_all(query, params)

    async def fetch_one(self, query: str, params: Optional[List[Any]] = None) -> Optional[Dict[str, Any]]:
        async with self.transaction() as tx:
            return await tx.fetch_one(query, params)

    async def execute(self, query: str, params: Optional[List[Any]] = None) -> Any:
        async with self.transaction() as tx:
            return await tx.execute(query, params)


def _convert_pg_query_to_sqlite(query: str) -> str:
    """Converts PostgreSQL $1, $2 placeholders to SQLite ? and normalizes boolean/timestamp."""
    sqlite_query = re.sub(r"\$(\d+)", "?", query)
    # Replace now() with CURRENT_TIMESTAMP
    sqlite_query = re.sub(r"\bnow\(\)", "CURRENT_TIMESTAMP", sqlite_query, flags=re.IGNORECASE)
    # Replace TRUE/FALSE with 1/0 where needed
    sqlite_query = re.sub(r"\bTRUE\b", "1", sqlite_query, flags=re.IGNORECASE)
    sqlite_query = re.sub(r"\bFALSE\b", "0", sqlite_query, flags=re.IGNORECASE)
    return sqlite_query


class SQLiteExecutor:
    def __init__(self, conn: aiosqlite.Connection):
        self.conn = conn

    def _normalize_params(self, params: Optional[List[Any]]) -> List[Any]:
        if not params:
            return []
        normalized = []
        for p in params:
            if isinstance(p, (dict, list)):
                normalized.append(json.dumps(p))
            elif isinstance(p, bool):
                normalized.append(1 if p else 0)
            else:
                normalized.append(p)
        return normalized

    async def fetch_all(self, query: str, params: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
        sql = _convert_pg_query_to_sqlite(query)
        p = self._normalize_params(params)
        async with self.conn.execute(sql, p) as cursor:
            rows = await cursor.fetchall()
            cols = [col[0] for col in cursor.description] if cursor.description else []
            out = []
            for row in rows:
                d = dict(zip(cols, row))
                # Deserialize JSON if string
                for k, v in d.items():
                    if k in ("payload", "response") and isinstance(v, str):
                        try:
                            d[k] = json.loads(v)
                        except Exception:
                            pass
                    elif isinstance(v, int) and k.startswith("is_"):
                        d[k] = bool(v)
                out.append(d)
            return out

    async def fetch_one(self, query: str, params: Optional[List[Any]] = None) -> Optional[Dict[str, Any]]:
        rows = await self.fetch_all(query, params)
        return rows[0] if rows else None

    async def execute(self, query: str, params: Optional[List[Any]] = None) -> int:
        sql = _convert_pg_query_to_sqlite(query)
        p = self._normalize_params(params)
        cursor = await self.conn.execute(sql, p)
        return cursor.rowcount


class PostgresExecutor:
    def __init__(self, conn: asyncpg.Connection):
        self.conn = conn

    def _normalize_params(self, params: Optional[List[Any]]) -> List[Any]:
        if not params:
            return []
        return list(params)

    async def fetch_all(self, query: str, params: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
        p = self._normalize_params(params)
        records = await self.conn.fetch(query, *p)
        out = []
        for r in records:
            d = dict(r)
            for k, v in d.items():
                if k in ("payload", "response") and isinstance(v, str):
                    try:
                        d[k] = json.loads(v)
                    except Exception:
                        pass
            out.append(d)
        return out

    async def fetch_one(self, query: str, params: Optional[List[Any]] = None) -> Optional[Dict[str, Any]]:
        p = self._normalize_params(params)
        record = await self.conn.fetchrow(query, *p)
        if not record:
            return None
        d = dict(record)
        for k, v in d.items():
            if k in ("payload", "response") and isinstance(v, str):
                try:
                    d[k] = json.loads(v)
                except Exception:
                    pass
        return d

    async def execute(self, query: str, params: Optional[List[Any]] = None) -> str:
        p = self._normalize_params(params)
        return await self.conn.execute(query, *p)


db = Database(settings.DATABASE_URL)
