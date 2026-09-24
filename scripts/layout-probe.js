// Shared layout measurement, read as text by prototype/check-layout.py and by
// scripts/check-client-layout.py and injected into a probe page.
//
// It lives in one file because the two callers must assert the identical thing.
// When they were allowed to diverge, the prototype gate reported green over a
// production client that had never been measured at all.
//
// Two placeholders are substituted by the caller:
//   __MAIN_SELECTOR__   the content region, for the collapse check
//   __RAIL_SELECTOR__   the navigation rail, whose width is not content

function measure(doc) {
  const W = doc.documentElement.clientWidth;
  const view = doc.defaultView;
  const out = [], scrollers = [];

  // A segmented control or a table wrapper is *meant* to scroll sideways, so an
  // element inside one is contained, not broken. body and html are excluded as
  // boundaries on purpose: their overflow-x:hidden is a production safety net,
  // and honouring it here would hide exactly the bug we are looking for.
  function contained(el){
    let p = el.parentElement;
    while(p && p !== doc.body && p !== doc.documentElement){
      if(/(auto|scroll)/.test(view.getComputedStyle(p).overflowX)) return true;
      p = p.parentElement;
    }
    return false;
  }

  for(const el of doc.body.querySelectorAll("*")){
    const r = el.getBoundingClientRect();
    if(r.width === 0 && r.height === 0) continue;

    // Informational: a scroller whose content is far wider than itself is a
    // density smell even though it is not a layout break.
    if(/(auto|scroll)/.test(view.getComputedStyle(el).overflowX) &&
       el.scrollWidth > el.clientWidth * 1.15 && el.clientWidth > 0){
      scrollers.push({cls: (el.getAttribute("class") || "-").slice(0, 40),
                      inner: el.scrollWidth, outer: el.clientWidth});
    }

    const over = Math.round(r.right - W);
    if(over <= 1 || contained(el)) continue;

    // Report only the outermost offender; a wide child in a wide parent is one
    // bug, not two.
    let p = el.parentElement, nested = false;
    while(p && p !== doc.body){
      if(p.getBoundingClientRect().right - W > 1){ nested = true; break; }
      p = p.parentElement;
    }
    if(nested) continue;
    out.push({tag: el.tagName.toLowerCase(), cls: (el.getAttribute("class") || "").slice(0, 70),
              over: over, w: Math.round(r.width), left: Math.round(r.left)});
  }
  // Underflow is the mirror-image bug and an overflow scan cannot see it: a
  // collapsed grid track squeezes content into a sliver without ever crossing
  // the right edge. Measure how much of the viewport the content actually uses.
  const sels = "__MAIN_SELECTOR__".split(",").map(s => s.trim());
  let shown = null;
  for(const sel of sels){
    const el = doc.querySelector(sel);
    if(el && el.offsetParent !== null){ shown = el; break; }
  }
  if(!shown) shown = doc.querySelector(sels[sels.length - 1]);
  const rail = doc.querySelector("__RAIL_SELECTOR__");
  const railW = (rail && rail.offsetParent !== null) ? Math.round(rail.getBoundingClientRect().width) : 0;
  const usable = W - railW - 8;
  const mw = shown ? Math.round(shown.getBoundingClientRect().width) : 0;

  // A cheap fingerprint of what actually rendered. Two differently-labelled
  // screens that fingerprint identically were not both measured: the client
  // redirected them to the same place, and the run is green over nothing.
  const heading = doc.querySelector("h1, h2");
  const sig = (heading ? heading.textContent.trim().slice(0, 60) : "-") + "|" +
              (shown ? shown.querySelectorAll("*").length : 0);

  return {
    vw: W,
    sig: sig,
    scroll: Math.round(doc.documentElement.scrollWidth - W),
    bodyScroll: Math.round(doc.body.scrollWidth - W),
    mainWidth: mw,
    mainShortfall: Math.max(0, Math.round(usable - mw)),
    offenders: out.slice(0, 8),
    scrollers: scrollers.slice(0, 6)
  };
}
