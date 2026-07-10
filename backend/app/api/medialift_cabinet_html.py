"""МедиаЛифт — веб-кабинет участника (отдельная страница, НЕ Mini App).

Открывается по ссылке `pluson.ru/medialift/me?slug={slug}&c={contact_id}`.
Работает на любом устройстве (человек в МедиаЛифт заходит через @pluson_bot без
Mini App). Данные берёт из /public/medialift/{slug}/my-cabinet.

Блоки: ваша ссылка · готовые материалы · статистика (перешли/подписались/охват
ветки/всего в системе) · апселл (ПЛЮСОН / Коллабораторная) с разъяснением ·
свёрнутые математические прикидки роста.
"""
import html as _html
import json
from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse
from app.database import get_pool

router = APIRouter()

DARK = "#25455D"
PEACH = "#FFCFA4"


@router.get("/medialift/me", response_class=HTMLResponse, include_in_schema=False)
async def medialift_cabinet(slug: str = Query(...), c: int = Query(...)):
    pool = await get_pool()
    async with pool.acquire() as db:
        from app.api.medialift import my_cabinet
        try:
            data = await my_cabinet(slug=slug, contact_id=c, db=db)
        except Exception:
            return HTMLResponse("<h2>Кабинет не найден</h2>", status_code=404)

    st = data["stats"]
    name = _html.escape(data.get("name") or "")
    link = data.get("link") or ""
    texts = data.get("share_texts") or []

    # Прикидка роста: при среднем 3-4 приглашённых на уровень и 4 уровнях глубины
    # ветка даёт десятки показов; при конверсии в подписку ~40% и отписке — живые.
    reach = st["branch_reach"]
    est_shows = max(reach, st["clicked"]) * 4  # грубо: каждый уровень множит показы
    est_live = int(est_shows * 0.43 * 0.6)     # 43% подписка × 60% остаются

    texts_html = ""
    for i, t in enumerate(texts):
        tj = json.dumps(t)
        texts_html += f"""
        <div class="card">
          <pre id="txt{i}">{_html.escape(t)}</pre>
          <button class="btn-ghost" onclick='copyText({tj})'>📋 Скопировать текст</button>
        </div>"""
    if not texts_html:
        texts_html = '<p class="muted">Материалы появятся позже.</p>'

    link_esc = _html.escape(link)
    page = f"""<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>МедиаЛифт — ваш кабинет</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ margin:0; font-family:Roboto,-apple-system,sans-serif; background:#f2f5f8; color:#1a2a3a; }}
  .wrap {{ max-width:640px; margin:0 auto; padding:16px 14px 60px; }}
  .hero {{ background:linear-gradient(45deg,{DARK},#0a1520); color:#fff; border-radius:18px; padding:20px; margin-bottom:16px; }}
  .hero h1 {{ margin:0 0 4px; font-size:20px; }}
  .hero p {{ margin:0; opacity:.85; font-size:14px; }}
  .sec {{ background:#fff; border-radius:16px; padding:16px; margin-bottom:14px; box-shadow:0 2px 8px rgba(37,69,93,.05); }}
  .sec h2 {{ margin:0 0 10px; font-size:16px; color:{DARK}; }}
  .muted {{ color:#6b7c8e; font-size:13px; }}
  .link-box {{ display:flex; gap:8px; }}
  .link-box input {{ flex:1; padding:10px 12px; border:1px solid #cfd8e0; border-radius:10px; font-size:13px; }}
  .btn {{ background:{DARK}; color:#fff; border:none; border-radius:10px; padding:10px 16px; font-weight:700; font-size:14px; cursor:pointer; text-decoration:none; display:inline-block; text-align:center; }}
  .btn-peach {{ background:{PEACH}; color:{DARK}; }}
  .btn-ghost {{ background:#eef2f6; color:{DARK}; border:none; border-radius:8px; padding:8px 14px; font-weight:600; font-size:13px; cursor:pointer; margin-top:8px; }}
  .stats {{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }}
  .stat {{ background:#f8fafc; border-radius:12px; padding:12px; text-align:center; }}
  .stat .n {{ font-size:24px; font-weight:800; color:{DARK}; }}
  .stat .l {{ font-size:12px; color:#6b7c8e; margin-top:2px; }}
  .card {{ background:#f8fafc; border-radius:12px; padding:12px; margin-bottom:10px; }}
  pre {{ white-space:pre-wrap; font-family:inherit; font-size:13px; margin:0; }}
  details {{ background:#fff; border-radius:16px; padding:14px 16px; margin-bottom:14px; }}
  summary {{ font-weight:700; color:{DARK}; cursor:pointer; }}
  .upsell {{ background:linear-gradient(45deg,{DARK},#0a1520); color:#fff; }}
  .upsell h2 {{ color:#fff; }}
  .upsell .btn {{ width:100%; margin-top:8px; }}
</style></head><body>
<div class="wrap">

  <div class="hero">
    <h1>Ваш кабинет МедиаЛифт{', ' + name if name else ''} 👋</h1>
    <p>Тут ваша ссылка и готовые материалы. Рассказывайте о системе — и ваш канал
       будет предлагаться всем, кто зайдёт под вами.</p>
  </div>

  <div class="sec">
    <h2>🔗 Ваша ссылка</h2>
    <p class="muted" style="margin-bottom:10px">Зовите людей по ней — они попадут в систему под вами и подпишутся на ваш канал.</p>
    <div class="link-box">
      <input id="reflink" value="{link_esc}" readonly>
      <button class="btn" onclick="copyLink()">Копировать</button>
    </div>
  </div>

  <div class="sec">
    <h2>📊 Статистика</h2>
    <div class="stats">
      <div class="stat"><div class="n">{st['clicked']}</div><div class="l">перешли по вашей ссылке</div></div>
      <div class="stat"><div class="n">{st['joined']}</div><div class="l">подписались и вошли</div></div>
      <div class="stat"><div class="n">{st['branch_reach']}</div><div class="l">всего под вами в ветке</div></div>
      <div class="stat"><div class="n">{st['total_system']}</div><div class="l">всего в системе</div></div>
    </div>
  </div>

  <div class="sec">
    <h2>✍️ Готовые материалы и тексты</h2>
    <p class="muted" style="margin-bottom:10px">Скопируйте и разошлите — так система растёт, а вместе с ней ваша аудитория.</p>
    {texts_html}
  </div>

  <details>
    <summary>📈 Как можно вырасти (прикидка)</summary>
    <p class="muted" style="margin-top:10px">
      Каждый, кто зашёл по вашей ссылке, подписывается на вас и приводит своих —
      а те тоже показывают ваш канал. За 3–4 уровня ветки под вами набирается
      порядка <b>{est_shows}</b> показов вашего канала. При конверсии в подписку
      около 43% и с учётом отписок это примерно <b>{est_live} живых подписчиков</b>
      — без вложений в рекламу, только за то, что вы рассказываете о системе.
    </p>
    <p class="muted">Чем больше людей вы приведёте на первом уровне — тем сильнее эффект: ветка множится сама.</p>
  </details>

  <div class="sec upsell">
    <h2>🚀 Усильте результат</h2>
    <p style="opacity:.9; font-size:14px; margin:0 0 12px">
      Канал — это хорошо. Но <b>свой лид-магнит</b> работает эффективнее: люди получают
      ценность и попадают в вашу базу, а не просто подписываются.
    </p>
    <a class="btn btn-peach" href="https://pluson.ru/register">🎁 ПЛЮСОН с лид-магнитом — 14 дней бесплатно</a>
    <a class="btn" href="https://pluson.ru/dashboard/collab-hub">🤝 Коллабораторная — закрытый Хаб</a>
  </div>

</div>
<script>
  function copyLink() {{
    var i = document.getElementById('reflink'); i.select();
    navigator.clipboard.writeText(i.value); }}
  function copyText(t) {{ navigator.clipboard.writeText(t); }}
</script>
</body></html>"""
    return HTMLResponse(page)
