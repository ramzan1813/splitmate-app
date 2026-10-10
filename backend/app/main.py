import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

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
    description="Offline-First Multi-Device Synchronization Coordinator for EvenUp",
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


@app.exception_handler(StarletteHTTPException)
async def http_error_envelope(request: Request, exc: HTTPException):
    """Errors use the relay's body, {"error": CODE, "message": text}, not FastAPI's {"detail": ...}.

    Phones act on the code (CURSOR_AHEAD -> re-sync, GROUP_NOT_FOUND -> group deleted,
    GROUP_UNAVAILABLE -> hidden, keep it); under "detail" they would only see HTTP_<status>.
    """
    detail = exc.detail
    if isinstance(detail, dict) and detail.get("error"):
        body = {"error": detail["error"], "message": detail.get("message") or str(detail["error"])}
    else:
        body = {"error": f"HTTP_{exc.status_code}", "message": str(detail)}
    return JSONResponse(status_code=exc.status_code, content=body, headers=getattr(exc, "headers", None))


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


if __name__ == "__main__":
    import uvicorn

    logger.info(f"Starting server on http://{settings.HOST}:{settings.PORT}")
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
    )
