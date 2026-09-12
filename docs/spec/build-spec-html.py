#!/usr/bin/env python3
"""Render Dr.App.txt into a single self-contained, indexed HTML reading copy.

    python3 docs/spec/build-spec-html.py

Reads  docs/spec/Dr.App.txt
Writes docs/spec/Dr.App.Spec.html

The Markdown subset handled here is exactly what the specification uses:
headings, paragraphs, bullet and numbered lists, pipe tables, fenced code,
blockquotes, horizontal rules, and inline bold/italic/code/strike/links.
No third-party dependencies, so it runs anywhere Python 3 does.
"""

import html
import re
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "Dr.App.txt"
OUT = HERE / "Dr.App.Spec.html"


# --------------------------------------------------------------------------- #
# Inline formatting
# --------------------------------------------------------------------------- #
def inline(text: str) -> str:
    """Escape, then apply inline Markdown. Code spans are protected first."""
    spans: list[str] = []

    def stash(m):
        spans.append(html.escape(m.group(1)))
        return f"\x00{len(spans) - 1}\x00"

    text = re.sub(r"`([^`]+)`", stash, text)
    text = html.escape(text)

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+?)\*(?![\w*])", r"<em>\1</em>", text)
    text = re.sub(r"~~(.+?)~~", r"<del>\1</del>", text)
    text = text.replace("&lt;br&gt;", "<br>")

    return re.sub(r"\x00(\d+)\x00", lambda m: f"<code>{spans[int(m.group(1))]}</code>", text)


def slug(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    text = unicodedata.normalize("NFKD", text)
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_]+", "-", text) or "section"


# --------------------------------------------------------------------------- #
# Block parsing
# --------------------------------------------------------------------------- #
def split_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def render(md: str):
    lines = md.split("\n")
    out: list[str] = []
    toc: list[dict] = []
    seen: dict[str, int] = {}
    i = 0

    def anchor(text: str) -> str:
        base = slug(text)
        seen[base] = seen.get(base, 0) + 1
        return base if seen[base] == 1 else f"{base}-{seen[base]}"

    while i < len(lines):
        line = lines[i]

        # fenced code
        if line.startswith("```"):
            i += 1
            body = []
            while i < len(lines) and not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            i += 1
            out.append(f'<pre><code>{html.escape(chr(10).join(body))}</code></pre>')
            continue

        # heading
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            level, raw = len(m.group(1)), m.group(2).strip()
            aid = anchor(raw)
            if level >= 2:
                toc.append({"level": level, "text": re.sub(r"\s*\*\(.*?\)\*\s*$", "", raw), "id": aid})
            out.append(
                f'<h{level} id="{aid}" class="hd">{inline(raw)}'
                f'<a class="anchor" href="#{aid}" aria-label="Link to this section">#</a></h{level}>'
            )
            i += 1
            continue

        # horizontal rule
        if re.match(r"^---+\s*$", line):
            out.append("<hr>")
            i += 1
            continue

        # table
        if line.strip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            head = split_row(line)
            i += 2
            body = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                body.append(split_row(lines[i]))
                i += 1
            th = "".join(f"<th>{inline(c)}</th>" for c in head)
            trs = "".join(
                "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body
            )
            head_html = f"<thead><tr>{th}</tr></thead>" if any(head) else ""
            out.append(f'<div class="tw"><table>{head_html}<tbody>{trs}</tbody></table></div>')
            continue

        # blockquote
        if line.startswith(">"):
            body = []
            while i < len(lines) and lines[i].startswith(">"):
                body.append(lines[i].lstrip(">").strip())
                i += 1
            out.append(f"<blockquote>{inline(' '.join(body))}</blockquote>")
            continue

        # lists
        if re.match(r"^\s*[*-]\s+", line) or re.match(r"^\s*\d+\.\s+", line):
            ordered = bool(re.match(r"^\s*\d+\.\s+", line))
            items: list[str] = []
            while i < len(lines):
                cur = lines[i]
                m2 = re.match(r"^\s*(?:[*-]|\d+\.)\s+(.*)$", cur)
                if m2:
                    items.append(m2.group(1))
                elif cur.strip() and cur.startswith(("  ", "\t")) and items:
                    items[-1] += " " + cur.strip()          # continuation line
                else:
                    break
                i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{inline(x)}</li>" for x in items) + f"</{tag}>")
            continue

        # paragraph
        if line.strip():
            body = []
            while i < len(lines) and lines[i].strip() and not re.match(
                r"^(#{1,6}\s|```|---+\s*$|\s*[*-]\s|\s*\d+\.\s|>|\s*\|)", lines[i]
            ):
                body.append(lines[i].strip())
                i += 1
            out.append(f"<p>{inline(' '.join(body))}</p>")
            continue

        i += 1

    return "\n".join(out), toc


def build_toc(toc: list[dict]) -> str:
    parts = []
    for e in toc:
        if e["level"] > 4:
            continue
        parts.append(
            f'<a class="t{e["level"]}" href="#{e["id"]}" data-t="{e["id"]}">'
            f'{html.escape(e["text"])}</a>'
        )
    return "\n".join(parts)


CSS = """
:root{
  --paper:#FBFAF7;--paper-2:#F5F2EB;--surface:#FFFDF9;--rule:#E2DDD1;--rule-2:#CFC8B7;
  --ink:#14211F;--ink-2:#3F534F;--ink-3:#6F817C;--ink-4:#9AA8A3;
  --teal:#0B4F4A;--teal-2:#0E7C74;--teal-wash:#E2EFED;
  --marigold:#C97A12;--marigold-wash:#FCF1DF;--vermilion:#B33F33;
  --sage:#3F6B46;--sage-wash:#E8F1E8;--indigo:#494A8C;
  --f:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --m:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --side:310px;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font:400 16px/1.68 var(--f);
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
:lang(mr),:lang(kok){font-family:"Noto Sans Devanagari","Nirmala UI",Mangal,var(--f);line-height:1.8}
:lang(te){font-family:"Noto Sans Telugu",Gautami,"Nirmala UI",var(--f);line-height:1.9}
:lang(bn){font-family:"Noto Sans Bengali",Vrinda,"Nirmala UI",var(--f);line-height:1.9}

#bar{position:fixed;top:0;left:0;height:3px;background:var(--teal-2);z-index:60;width:0;transition:width 90ms}

.wrap{display:grid;grid-template-columns:var(--side) minmax(0,1fr);max-width:1500px;margin:0 auto;gap:0}

/* ---- sidebar ---------------------------------------------------------- */
aside{position:sticky;top:0;height:100vh;overflow-y:auto;border-right:1px solid var(--rule);
  background:var(--paper-2);padding:20px 16px 60px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.mark{width:34px;height:34px;border-radius:9px;background:var(--teal);color:#EAF6F3;
  display:grid;place-items:center;font-weight:900;font-size:.9rem;letter-spacing:-.04em;flex:none}
.brand b{font-size:.95rem;letter-spacing:-.01em}
.brand span{display:block;font-size:.68rem;color:var(--ink-3);font-weight:600}
.side-actions{display:flex;gap:6px;margin:14px 0 10px;flex-wrap:wrap}
.sbtn{flex:1;min-width:0;min-height:34px;padding:0 9px;border:1px solid var(--rule-2);border-radius:5px;
  background:var(--surface);font:700 .7rem var(--f);color:var(--ink-2);cursor:pointer;white-space:nowrap}
.sbtn:hover{border-color:var(--teal-2);color:var(--teal);background:var(--teal-wash)}
#find{width:100%;min-height:38px;padding:8px 10px;border:1.5px solid var(--rule-2);border-radius:5px;
  background:var(--surface);font:400 .82rem var(--f);margin-bottom:4px}
#find:focus{outline:none;border-color:var(--teal-2);box-shadow:0 0 0 3px var(--teal-wash)}
#findbar{display:none;align-items:center;gap:6px;margin-bottom:10px;font-size:.72rem;color:var(--ink-3)}
#findbar.on{display:flex}
#findbar button{width:26px;height:26px;border:1px solid var(--rule-2);border-radius:4px;
  background:var(--surface);cursor:pointer;font-weight:800;color:var(--ink-2)}
nav{display:flex;flex-direction:column;gap:1px;margin-top:8px}
nav a{display:block;padding:6px 10px;border-radius:5px;text-decoration:none;color:var(--ink-2);
  font-size:.79rem;line-height:1.35;border-left:2px solid transparent}
nav a:hover{background:var(--surface);color:var(--teal)}
nav a.t2{font-weight:800;margin-top:9px;color:var(--ink);font-size:.83rem}
nav a.t3{padding-left:20px;font-size:.77rem}
nav a.t4{padding-left:32px;font-size:.74rem;color:var(--ink-3)}
nav a.on{background:var(--teal-wash);color:var(--teal);border-left-color:var(--teal);font-weight:700}
nav a.hide{display:none}

/* ---- document --------------------------------------------------------- */
main{padding:34px 46px 120px;max-width:1000px;min-width:0}
.meta{background:var(--surface);border:1px solid var(--rule);border-radius:13px;padding:18px 20px;margin-bottom:30px}
.meta .eyebrow{font-size:.65rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-4)}
.meta .links{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.meta .links a{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;
  border:1px solid var(--rule-2);border-radius:5px;background:var(--paper-2);color:var(--ink-2);
  text-decoration:none;font-size:.76rem;font-weight:700}
.meta .links a:hover{border-color:var(--teal-2);color:var(--teal);background:var(--teal-wash)}

h1{font-size:2rem;line-height:1.18;letter-spacing:-.024em;margin:0 0 6px}
h2{font-size:1.42rem;letter-spacing:-.018em;margin:52px 0 14px;padding-bottom:9px;border-bottom:2px solid var(--rule-2)}
h3{font-size:1.1rem;letter-spacing:-.012em;margin:32px 0 10px;color:var(--teal)}
h4{font-size:.95rem;margin:24px 0 8px;color:var(--ink-2)}
h5,h6{font-size:.88rem;margin:18px 0 6px;color:var(--ink-2)}
.hd{scroll-margin-top:20px;position:relative}
.anchor{position:absolute;left:-22px;top:0;color:var(--ink-4);text-decoration:none;opacity:0;
  font-weight:400;transition:opacity 120ms}
.hd:hover .anchor{opacity:1}
.anchor:hover{color:var(--teal-2)}

p{margin:0 0 14px;max-width:78ch}
ul,ol{margin:0 0 16px 22px;max-width:78ch}
li{margin-bottom:7px}
li::marker{color:var(--ink-4)}
a{color:var(--teal-2)}
strong{font-weight:700;color:var(--ink)}
del{color:var(--ink-4)}
hr{border:none;border-top:1px solid var(--rule);margin:34px 0}

code{font-family:var(--m);font-size:.86em;background:var(--paper-2);border:1px solid var(--rule);
  border-radius:4px;padding:1px 5px}
pre{background:#0E1A18;color:#CFE3DE;border-radius:10px;padding:16px 18px;overflow-x:auto;
  margin:0 0 20px;border:1px solid #22352F}
pre code{background:none;border:none;padding:0;color:inherit;font-size:.775rem;line-height:1.5;white-space:pre}

blockquote{border-left:3px solid var(--marigold);background:var(--marigold-wash);
  padding:12px 16px;border-radius:0 6px 6px 0;margin:0 0 18px;max-width:78ch;font-size:.94rem}

.tw{overflow-x:auto;margin:0 0 22px;border:1px solid var(--rule);border-radius:10px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:.83rem}
th{text-align:left;font-size:.65rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-3);padding:11px 13px;border-bottom:1.5px solid var(--rule-2);background:var(--paper-2);
  position:sticky;top:0;white-space:nowrap}
td{padding:11px 13px;border-bottom:1px solid var(--rule);vertical-align:top;line-height:1.55}
tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--paper-2)}
td code{font-size:.8em}

mark{background:#FFE9A8;color:inherit;border-radius:2px;padding:0 1px}
mark.cur{background:var(--marigold);color:#fff}

#top{position:fixed;right:22px;bottom:22px;width:44px;height:44px;border-radius:50%;
  background:var(--teal);color:#EAF6F3;border:none;cursor:pointer;font-size:1.1rem;
  box-shadow:0 6px 20px rgba(20,33,31,.22);display:none;z-index:50}
#top.on{display:block}

#menu{display:none;position:fixed;left:14px;top:12px;z-index:70;width:44px;height:44px;
  border-radius:9px;background:var(--teal);color:#EAF6F3;border:none;font-size:1.2rem;cursor:pointer}

@media (max-width:1000px){
  .wrap{grid-template-columns:1fr}
  aside{position:fixed;left:0;top:0;width:290px;z-index:65;transform:translateX(-100%);
    transition:transform 190ms;box-shadow:0 0 40px rgba(0,0,0,.2)}
  aside.open{transform:none}
  #menu{display:block}
  main{padding:70px 20px 100px}
}
@media print{
  aside,#top,#menu,#bar,.meta .links{display:none!important}
  .wrap{display:block;max-width:none}
  main{padding:0;max-width:none}
  body{font-size:10.5pt}
  h2{break-before:page;border-bottom:1px solid #999}
  h2:first-of-type{break-before:avoid}
  h2,h3,h4{break-after:avoid}
  .tw,pre,blockquote,table{break-inside:avoid}
  pre{background:#f4f4f4;color:#111;border:1px solid #ccc}
  a{color:inherit;text-decoration:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
"""

JS = r"""
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];

/* reading progress */
addEventListener("scroll",()=>{
  const h=document.documentElement, max=h.scrollHeight-h.clientHeight;
  $("#bar").style.width=(max>0?(h.scrollTop/max*100):0)+"%";
  $("#top").classList.toggle("on", h.scrollTop>500);
},{passive:true});
$("#top").onclick=()=>scrollTo({top:0,behavior:"smooth"});

/* mobile drawer */
$("#menu").onclick=()=>$("aside").classList.toggle("open");
$$("nav a").forEach(a=>a.onclick=()=>$("aside").classList.remove("open"));

/* scroll-spy */
const links=new Map($$("nav a").map(a=>[a.dataset.t,a]));
const spy=new IntersectionObserver(es=>{
  es.forEach(e=>{
    if(!e.isIntersecting) return;
    const a=links.get(e.target.id); if(!a) return;
    $$("nav a.on").forEach(x=>x.classList.remove("on"));
    a.classList.add("on");
    const r=a.getBoundingClientRect(), s=$("aside").getBoundingClientRect();
    if(r.top<s.top+40||r.bottom>s.bottom-40) a.scrollIntoView({block:"center"});
  });
},{rootMargin:"0px 0px -78% 0px"});
$$(".hd").forEach(h=>spy.observe(h));

/* full-text find: filters the contents list and highlights matches in the body */
let hits=[], cur=-1;
function clearMarks(){
  $$("main mark").forEach(m=>{ const p=m.parentNode; p.replaceChild(document.createTextNode(m.textContent),m); p.normalize(); });
  hits=[]; cur=-1;
}
function find(q){
  clearMarks();
  const nav=$$("nav a");
  if(!q){ nav.forEach(a=>a.classList.remove("hide")); $("#findbar").classList.remove("on"); return; }
  const needle=q.toLowerCase();
  nav.forEach(a=>a.classList.toggle("hide", !a.textContent.toLowerCase().includes(needle)));

  const walker=document.createTreeWalker($("main"),NodeFilter.SHOW_TEXT,{
    acceptNode:n=> n.nodeValue.toLowerCase().includes(needle) && !/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  const targets=[]; let n; while(n=walker.nextNode()) targets.push(n);
  targets.forEach(node=>{
    const frag=document.createDocumentFragment(); const text=node.nodeValue; let i=0;
    for(;;){
      const j=text.toLowerCase().indexOf(needle,i); if(j<0) break;
      frag.appendChild(document.createTextNode(text.slice(i,j)));
      const mk=document.createElement("mark"); mk.textContent=text.slice(j,j+needle.length);
      frag.appendChild(mk); hits.push(mk); i=j+needle.length;
    }
    frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode.replaceChild(frag,node);
  });
  $("#findbar").classList.add("on");
  $("#count").textContent = hits.length ? hits.length+" match"+(hits.length>1?"es":"") : "no matches";
  if(hits.length) step(0);
}
function step(d){
  if(!hits.length) return;
  if(cur>=0) hits[cur].classList.remove("cur");
  cur=(cur+d+hits.length)%hits.length;
  hits[cur].classList.add("cur");
  hits[cur].scrollIntoView({block:"center",behavior:"smooth"});
  $("#count").textContent=(cur+1)+" of "+hits.length;
}
let timer; $("#find").addEventListener("input",e=>{ clearTimeout(timer); timer=setTimeout(()=>find(e.target.value.trim()),200); });
$("#find").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); step(e.shiftKey?-1:1); }
                                          if(e.key==="Escape"){ e.target.value=""; find(""); } });
$("#prev").onclick=()=>step(-1); $("#next").onclick=()=>step(1);
addEventListener("keydown",e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==="f"){ e.preventDefault(); $("#find").focus(); $("#find").select(); }
  if(e.key==="/"&&document.activeElement!==$("#find")){ e.preventDefault(); $("#find").focus(); }
});

/* copy a deep link from any heading anchor */
$$(".anchor").forEach(a=>a.addEventListener("click",e=>{
  e.preventDefault();
  const url=location.href.split("#")[0]+a.getAttribute("href");
  history.replaceState(null,"",a.getAttribute("href"));
  document.getElementById(a.getAttribute("href").slice(1)).scrollIntoView();
  if(navigator.clipboard) navigator.clipboard.writeText(url).catch(()=>{});
}));
"""


def main() -> None:
    md = SRC.read_text(encoding="utf-8")

    # The H1 and the metadata table become the document header card.
    body_md = md
    m = re.match(r"^#\s+(.*?)\n(.*?)\n---\n", md, re.S)
    title = "PractixOS — Product Specification"
    subtitle = ""
    if m:
        title = m.group(1).strip()
        head_block = m.group(2)
        v = re.search(r"\*\*(Version [^*]+)\*\*(.*)", head_block)
        subtitle = (v.group(1) + v.group(2)).strip() if v else ""
        body_md = md[m.end():]

    content, toc = render(body_md)
    sections = sum(1 for e in toc if e["level"] == 2)
    words = len(re.findall(r"\w+", re.sub(r"<[^>]+>", " ", content)))

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="description" content="{html.escape(title)} — indexed reading copy">
<title>{html.escape(title)}</title>
<style>{CSS}</style>
</head>
<body>
<div id="bar"></div>
<button id="menu" aria-label="Contents">☰</button>

<div class="wrap">
<aside>
  <div class="brand">
    <span class="mark">Px</span>
    <b>PractixOS<span>Product specification</span></b>
  </div>
  <div class="side-actions">
    <button class="sbtn" onclick="window.print()">Print / PDF</button>
    <button class="sbtn" onclick="navigator.clipboard&amp;&amp;navigator.clipboard.writeText(location.href)">Copy link</button>
  </div>
  <input id="find" type="search" placeholder="Search the specification  ( / )" aria-label="Search">
  <div id="findbar"><span id="count"></span><span style="flex:1"></span>
    <button id="prev" aria-label="Previous match">↑</button><button id="next" aria-label="Next match">↓</button></div>
  <nav aria-label="Contents">
{build_toc(toc)}
  </nav>
</aside>

<main>
  <h1>{html.escape(title)}</h1>
  <div class="meta">
    <div class="eyebrow">{html.escape(subtitle)}</div>
    <p style="margin:8px 0 0;color:var(--ink-2)">The complete product specification and strategic blueprint for PractixOS,
      a verticalized Practice Operating System for independent outpatient clinics in India.
      {sections} sections, approximately {words:,} words. Section&nbsp;0 lists everything that changed in this revision.</p>
    <div class="links">
      <a href="../plan/IMPLEMENTATION-PLAN.md">Engineering implementation plan</a>
      <a href="../../prototype/PractixOS.html">Interactive prototype</a>
      <a href="#0-revision-log--what-changed-in-v20-and-why">What changed in v2.0</a>
    </div>
  </div>
{content}
</main>
</div>

<button id="top" aria-label="Back to top">↑</button>
<script>{JS}</script>
</body>
</html>
"""
    OUT.write_text(page, encoding="utf-8")
    print(f"wrote {OUT.relative_to(HERE.parent.parent)}  ({len(page):,} bytes, {sections} sections, {len(toc)} entries)")


if __name__ == "__main__":
    main()
