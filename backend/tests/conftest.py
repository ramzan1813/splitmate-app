import os
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from app.db import Database
from app.main import app
from app.sync_service import sync_service


@pytest_asyncio.fixture(scope="function")
async def test_db():
    test_db_path = "./test_splitmate.db"
    if os.path.exists(test_db_path):
        try:
            os.remove(test_db_path)
        except Exception:
            pass

    database = Database(f"sqlite+aiosqlite:///{test_db_path}")
    await database.connect()

    # Monkeypatch singleton db
    from app import db as db_module
    old_db = db_module.db
    db_module.db = database
    sync_service.db = database

    yield database

    await database.disconnect()
    db_module.db = old_db
    sync_service.db = old_db
    if os.path.exists(test_db_path):
        try:
            os.remove(test_db_path)
        except Exception:
            pass


@pytest_asyncio.fixture(scope="function")
async def client(test_db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
