from fastapi import APIRouter, Query
from app.schemas import (
    GroupBootstrapResponse,
    PullChangesResponse,
    PushMutationsRequest,
    PushMutationsResponse,
)
from app.sync_service import sync_service

router = APIRouter(prefix="/sync", tags=["Sync"])


@router.get("/bootstrap/{group_uid}", response_model=GroupBootstrapResponse)
async def get_bootstrap(group_uid: str):
    """Returns full initial snapshot for a group along with serverSequence."""
    return await sync_service.get_group_bootstrap(group_uid)


@router.get("/changes/{group_uid}", response_model=PullChangesResponse)
async def get_changes(
    group_uid: str,
    after: int = Query(0, ge=0, description="Pull changes strictly after this sequence number"),
    limit: int = Query(100, ge=1, le=500, description="Max changes per page"),
):
    """Pulls incremental delta changes strictly after the given server sequence cursor."""
    return await sync_service.get_changes_since(group_uid, after=after, limit=limit)


@router.post("/push", response_model=PushMutationsResponse)
async def post_push_mutations(req: PushMutationsRequest):
    """Processes an atomic batch of client outbox mutations with idempotency and concurrency checking."""
    return await sync_service.process_push_mutations(req)
