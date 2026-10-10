from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from app.join_page import render_join_page

router = APIRouter(tags=["Join"])


@router.get("/join", response_class=HTMLResponse)
async def get_join_page(request: Request):
    query_str = str(request.url.query)
    base_url = str(request.base_url).rstrip("/")
    html_content = render_join_page(query_str, server_base_url=base_url)
    return HTMLResponse(content=html_content, status_code=200)
