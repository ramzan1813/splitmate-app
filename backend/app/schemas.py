from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field


# --- Health & Info Schemas ---
class HealthResponse(BaseModel):
    status: str = "ok"
    name: str = "EvenUp Sync Backend"
    version: str = "3.0.0"
    database: str = "connected"


# --- Entity DTOs ---
class SplitSnapshot(BaseModel):
    memberUid: str
    memberName: Optional[str] = None
    value: float = 1.0
    share: int = 0


class MemberSnapshot(BaseModel):
    id: Optional[int] = None
    uid: str
    memberUid: Optional[str] = None
    name: str
    userId: Optional[str] = None
    role: str = "MEMBER"
    isMe: bool = False
    serverVersion: int = 1
    isDeleted: bool = False


class TransactionSnapshot(BaseModel):
    id: Optional[int] = None
    uid: str
    groupId: Optional[int] = None
    type: Literal["expense", "payment"] = "expense"
    title: str
    amount: int
    paidBy: Optional[int] = 0
    paidByMemberUid: str
    splitType: str = "equal"
    category: str = "General"
    note: Optional[str] = ""
    date: str
    authorId: str
    authorName: str
    updatedById: Optional[str] = None
    updatedByName: Optional[str] = None
    updatedTs: Optional[int] = 0
    createdTs: Optional[int] = None
    serverVersion: int = 1
    isDeleted: bool = False
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None
    splits: List[SplitSnapshot] = Field(default_factory=list)


class GroupSnapshot(BaseModel):
    id: Optional[int] = None
    uid: str
    name: str
    description: str = ""
    currency: str = "USD"
    permissionModel: str = "collaborative"
    creatorId: str
    creatorName: str
    serverVersion: int = 1
    isDeleted: bool = False
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None


# --- Bootstrap Response ---
class GroupBootstrapResponse(BaseModel):
    groupUid: str
    serverSequence: int
    group: GroupSnapshot
    members: List[MemberSnapshot]
    transactions: List[TransactionSnapshot]


# --- Delta Pull Schemas ---
class ServerChange(BaseModel):
    sequence: int
    changeId: str
    groupUid: str
    entityType: Literal["group", "member", "transaction"]
    entityUid: str
    operation: Literal["create", "update", "delete"]
    actorId: str
    deviceId: str
    entityVersion: int
    payload: Dict[str, Any]
    createdAt: str


class PullChangesResponse(BaseModel):
    groupUid: str
    latestServerSequence: int
    hasMore: bool
    changes: List[ServerChange]


# --- Push Mutation Schemas ---
class PushMutation(BaseModel):
    clientMutationId: str
    entityType: Literal["group", "member", "transaction"]
    entityUid: str
    operation: Literal["create", "update", "delete"]
    expectedVersion: int = 0
    payload: Optional[Dict[str, Any]] = None


class PushMutationsRequest(BaseModel):
    groupUid: str
    deviceId: str
    actorId: Optional[str] = "anonymous"
    actorName: Optional[str] = "Anonymous"
    mutations: List[PushMutation]


class PushMutationResult(BaseModel):
    clientMutationId: str
    status: Literal["ACCEPTED", "CONFLICT", "REJECTED"]
    entityUid: str
    serverVersion: Optional[int] = None
    serverSequence: Optional[int] = None
    error: Optional[str] = None
    message: Optional[str] = None


class PushMutationsResponse(BaseModel):
    groupUid: str
    results: List[PushMutationResult]


# --- Device Push Registration ---
class DeviceRegisterRequest(BaseModel):
    deviceId: str
    userId: Optional[str] = None
    userName: Optional[str] = None
    expoPushToken: Optional[str] = None
    pushEnabled: bool = True


class DeviceRegisterResponse(BaseModel):
    status: str = "ok"
    deviceId: str
    pushEnabled: bool
