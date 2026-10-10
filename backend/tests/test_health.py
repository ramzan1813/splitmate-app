import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["name"] == "EvenUp Sync Backend"
    assert "version" in data


@pytest.mark.asyncio
async def test_health_db(client: AsyncClient):
    response = await client.get("/health/db")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["database"] == "connected"


@pytest.mark.asyncio
async def test_join_landing_page(client: AsyncClient):
    response = await client.get("/join?uid=grp_test123&name=Trip%20to%20Rome&cur=EUR")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "Trip to Rome" in response.text
    assert "EUR" in response.text
    assert "splitmate://join" in response.text
