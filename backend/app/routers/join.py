from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from app.join_page import render_join_page

router = APIRouter(tags=["Join"])


@router.get("/join", response_class=HTMLResponse)
async def get_join_page(request: Request):
    query_str = str(request.url.query)
    html_content = render_join_page(query_str)
    return HTMLResponse(content=html_content, status_code=200)
