from fastapi import APIRouter
from app.db import db
from app.schemas import DeviceRegisterRequest, DeviceRegisterResponse

router = APIRouter(prefix="/devices", tags=["Devices"])


@router.post("/register", response_model=DeviceRegisterResponse)
async def register_device(req: DeviceRegisterRequest):
    """Registers or updates a device's push notification token and presence."""
    async with db.transaction() as tx:
        await tx.execute(
            "INSERT INTO devices (device_id, user_id, user_name, expo_push_token, push_enabled, last_seen_at, created_at) "
            "VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) "
            "ON CONFLICT (device_id) DO UPDATE SET "
            "user_id = COALESCE($2, devices.user_id), "
            "user_name = COALESCE($3, devices.user_name), "
            "expo_push_token = COALESCE($4, devices.expo_push_token), "
            "push_enabled = $5, "
            "last_seen_at = CURRENT_TIMESTAMP",
            [req.deviceId, req.userId, req.userName, req.expoPushToken, req.pushEnabled],
        )
    return DeviceRegisterResponse(status="ok", deviceId=req.deviceId, pushEnabled=req.pushEnabled)
