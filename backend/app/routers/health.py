from fastapi import APIRouter, HTTPException
from app.config import settings
from app.db import db
from app.schemas import HealthResponse

router = APIRouter(tags=["Health"])


@router.get("/health", response_model=HealthResponse)
async def get_health():
    return HealthResponse(
        status="ok",
        name=settings.PROJECT_NAME,
        version=settings.VERSION,
        database="configured",
    )


@router.get("/health/db")
async def get_health_db():
    try:
        async with db.transaction() as tx:
            await tx.fetch_one("SELECT 1 AS alive")
        return {"status": "ok", "database": "connected", "type": "sqlite" if db.is_sqlite else "postgresql"}
    except Exception as e:
        raise HTTPException(status_code=503, detail={"status": "error", "message": str(e)})
