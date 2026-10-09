import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.db import db
from app.routers import devices, health, join, sync

logging.basicConfig(level=logging.INFO if not settings.DEBUG else logging.DEBUG)
logger = logging.getLogger("splitmate.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"Starting {settings.PROJECT_NAME} v{settings.VERSION}...")
    await db.connect()
    yield
    logger.info(f"Shutting down {settings.PROJECT_NAME}...")
    await db.disconnect()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="Offline-First Multi-Device Synchronization Coordinator for SplitMate",
    lifespan=lifespan,
)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", tags=["Root"])
async def root():
    return {
        "status": "ok",
        "name": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "architecture": "Python FastAPI + PostgreSQL/SQLite Monotonic Change Log",
    }


# Include Routers
app.include_router(health.router)
app.include_router(join.router)
app.include_router(sync.router)
app.include_router(devices.router)
