import html
import json
from urllib.parse import parse_qs, urlencode


def render_join_page(query_string: str, server_base_url: str = "") -> str:
    params = parse_qs(query_string, keep_blank_values=True)
    flat_params = {k: v[0] for k, v in params.items() if v}

    if "server" not in flat_params and server_base_url:
        flat_params["server"] = server_base_url

    raw_name = flat_params.get("name", "EvenUp Group")
    raw_cur = flat_params.get("cur", "PKR")

    group_name = html.escape(raw_name)
    currency = html.escape(raw_cur)

    deep_link = f"splitmate://join?{urlencode(flat_params)}"
    deep_link_attr = html.escape(deep_link)
    deep_link_js = json.dumps(deep_link).replace("<", "\\u003c")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join EvenUp Group</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #F8FAFC; margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; box-sizing: border-box; }}
    .card {{ background: #1E293B; border-radius: 20px; padding: 32px 24px; max-width: 400px; width: 100%; text-align: center; border: 1px solid #334155; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }}
    h1 {{ font-size: 22px; margin: 0 0 8px; color: #fff; }}
    p {{ color: #94A3B8; font-size: 14px; line-height: 1.5; margin: 0 0 20px; }}
    .info-box {{ background: #0F172A; border-radius: 12px; padding: 14px; margin-bottom: 20px; text-align: left; }}
    .info-row {{ display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }}
    .info-row:last-child {{ margin-bottom: 0; }}
    .info-label {{ color: #94A3B8; }}
    .info-val {{ font-weight: 700; color: #F8FAFC; }}
    .btn {{ display: block; background: #0F766E; color: #fff; text-decoration: none; padding: 14px 20px; border-radius: 12px; font-weight: 700; font-size: 15px; margin-bottom: 10px; border: none; cursor: pointer; width: 100%; box-sizing: border-box; }}
    .btn-outline {{ background: transparent; border: 1px solid #475569; color: #CBD5E1; }}
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 40px; margin-bottom: 8px;">🤝</div>
    <h1>Join {group_name}</h1>
    <p>You were invited to sync expenses in EvenUp.</p>
    <div class="info-box">
      <div class="info-row"><span class="info-label">Group Name:</span><span class="info-val">{group_name}</span></div>
      <div class="info-row"><span class="info-label">Currency:</span><span class="info-val">{currency}</span></div>
    </div>
    <a href="{deep_link_attr}" class="btn">📱 Open in EvenUp App</a>
    <button class="btn btn-outline" id="copy">📋 Copy App Link</button>
  </div>
  <script>
    const link = {deep_link_js};
    document.getElementById('copy').onclick = () => navigator.clipboard.writeText(link).then(() => alert('Invite link copied!'));
    window.location.href = link;
  </script>
</body>
</html>"""
