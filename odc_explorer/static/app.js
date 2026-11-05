/* ODC chain explorer — hash-routed single page.
 *   #/                         home: call-number box + top-level "drawers"
 *   #/c/<call>/<offset>?...    browse: 25 domains in library order from a cursor
 *   #/ipfs                     status of the embedded IPFS node
 * Everything is served by the local Flask app; the page makes no third-party requests.
 */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view");
  const topbar = $("#topbar");
  const PAGE = 25;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bare = (call) => String(call || "").replace(/\./g, "").toUpperCase();
  const dotted = (b) => (bare(b).match(/.{1,3}/g) || []).join(".");
  const shortCid = (c) => (c ? `${c.slice(0, 10)}…${c.slice(-6)}` : "");

  async function api(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
    const r = await fetch(`/api/${path}?${qs}`);
    const body = await r.json().catch(() => ({ message: r.statusText }));
    if (!r.ok) throw Object.assign(new Error(body.message || r.statusText), { status: r.status, kind: body.error });
    return body;
  }

  // ---------- theme ----------
  // ---------- content setting: hide adult content (call 0 and below) ----------
  const ADULT_CALL = "0";
  let hideAdult = false;
  const hideParam = () => (hideAdult ? ADULT_CALL : undefined);

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; };
  applyTheme(store.get("odc-theme"));
  hideAdult = store.get("odc-hide-adult") === "1";

  // The 18+ switch lives in the top bar and on the home page. Turning it
  // redraws the current page (a user action), with or without branch 0.
  const adultToggle = () => `<button type="button" class="adult-toggle" data-adult-toggle aria-pressed="${hideAdult}"
      title="${hideAdult ? "Adult content (call 0) is hidden. Click to show it." : "Hide adult content (call 0 and everything under it)"}">
      <span class="sw" aria-hidden="true"></span>18+<span class="lbl"> ${hideAdult ? "hidden" : "shown"}</span></button>`;
  const syncAdultToggles = () => document.querySelectorAll("[data-adult-slot]").forEach((el) => (el.innerHTML = adultToggle()));
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-adult-toggle]")) return;
    hideAdult = !hideAdult;
    store.set("odc-hide-adult", hideAdult ? "1" : "0");
    syncAdultToggles();
    route();
  });
  $("#theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next); store.set("odc-theme", next);
  });

  // ---------- routing ----------
  function parseHash() {
    const raw = location.hash.replace(/^#/, "") || "/";
    const [path, query = ""] = raw.split("?");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    return { parts, q: new URLSearchParams(query) };
  }
  const browseHref = (call, offset = 0, extra = {}) => {
    const qs = new URLSearchParams(Object.entries(extra).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    const s = qs.toString();
    return `#/c/${encodeURIComponent(dotted(call)) || "-"}/${offset}${s ? "?" + s : ""}`;
  };

  let renderToken = 0;
  async function route() {
    const token = ++renderToken;
    const { parts, q } = parseHash();
    const stale = () => token !== renderToken;
    window.scrollTo({ top: 0 });
    stopIpfsRefresh();
    if (parts[0] === "ipfs") {
      await renderIpfs(stale);
    } else if (parts[0] === "c") {
      const call = parts[1] && parts[1] !== "-" ? parts[1] : "";
      await renderBrowse(call, Math.max(0, parseInt(parts[2] || "0", 10) || 0), q, stale);
    } else {
      await renderHome(stale);
    }
  }
  window.addEventListener("hashchange", () => route());

  // Pages only change when you act. Every navigation reads the latest catalog;
  // a link to the page you're already on doesn't change the URL, so redraw it
  // explicitly (that's how you pick up a newly published catalog in place).
  // Same page = same path and same non-empty parameters, in any order
  // (``#/c/-/0`` and ``#/c/-/0?from=`` are one page).
  const canonical = (h) => {
    const [path, query = ""] = String(h).replace(/^#/, "").split("?");
    const params = [...new URLSearchParams(query)].filter(([, v]) => v !== "").sort();
    return path.replace(/\/+$/, "") + "?" + new URLSearchParams(params);
  };
  const isCurrentPage = (h) => canonical(h) === canonical(location.hash || "#/");
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (isCurrentPage(a.getAttribute("href"))) { e.preventDefault(); route(); }
  });

  // ---------- call-number box (spec Section 8 lookup; no text search) ----------
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-search]");
    if (!form) return;
    e.preventDefault();
    const input = form.q;
    const b = bare(input.value.trim().replace(/^(#|call:)/i, "").replace(/\s+/g, ""));
    if (!b) { location.hash = "#/"; return; }
    if (!/^[0-9A-Z]{1,9}$/.test(b)) {
      input.setCustomValidity("Call numbers are 1–9 characters of 0-9 and A-Z, e.g. 05 or ABC.DEF.G");
      input.reportValidity();
      input.addEventListener("input", () => input.setCustomValidity(""), { once: true });
      return;
    }
    input.blur();
    const target = browseHref(b, 0, { from: dotted(b) });
    if (isCurrentPage(target)) route(); else location.hash = target;
  });
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === "/" && !typing) {
      const input = document.querySelector(".search input:not([hidden])");
      const visible = [...document.querySelectorAll(".search input")].find((i) => i.offsetParent);
      (visible || input)?.focus(); e.preventDefault();
    } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "ArrowRight") document.querySelector("[data-next]:not([disabled])")?.click();
      if (e.key === "ArrowLeft") document.querySelector("[data-prev]:not([disabled])")?.click();
    }
  });
  const setQuery = (q) => document.querySelectorAll(".search input").forEach((i) => (i.value = q));

  // ---------- shared bits ----------
  const tileColors = ["#8a2d1f", "#3b5b4a", "#a8822f", "#2f4a7a", "#6b3a5b", "#7a5230", "#40606b", "#5a5f2a"];
  function tile(domain) {
    let h = 0;
    for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<div class="mono-tile" style="background:${tileColors[h % tileColors.length]}" aria-hidden="true">${esc(domain[0] || "?")}</div>`;
  }
  function rank(r) {
    const pips = Array.from({ length: 9 }, (_, i) => `<i class="${i < r ? "on" : ""}"></i>`).join("");
    return `<span class="rank" title="Rank ${r} of 9 — cultural relevance and author authority">${pips}<b>${r}</b></span>`;
  }
  function crumbLinks(call, descs, sep = "›") {
    const b = bare(call);
    return descs.map((d, i) => `<a href="${browseHref(b.slice(0, i + 1), 0, { from: dotted(b.slice(0, i + 1)) })}">${esc(d || dotted(b.slice(0, i + 1)))}</a>`)
      .join(`<span class="sep">${sep}</span>`);
  }
  function resultItem(it, n) {
    return `<li class="result" style="animation-delay:${Math.min(n, 12) * 18}ms">
      ${tile(it.domain)}
      <div>
        <div class="url"><span>https://${esc(it.domain)}</span>${rank(it.rank)}</div>
        <h2><a href="https://${esc(it.domain)}" target="_blank" rel="noopener noreferrer">${esc(it.domain)}</a></h2>
        <p>${esc(it.desc) || "<em>No description.</em>"}</p>
      </div>
    </li>`;
  }
  const skeleton = (note) => `
    ${note ? `<p class="loading-note">${esc(note)}</p>` : ""}
    ${Array.from({ length: 5 }, () => `<div style="margin:18px 0"><div class="skel" style="width:30%"></div><div class="skel" style="width:55%;height:18px"></div><div class="skel" style="width:85%"></div></div>`).join("")}`;
  const errorBox = (e) => e.kind === "hidden"
    ? `<div class="empty"><h3>Adult content is hidden</h3>This category is under call number ${esc(ADULT_CALL)}, which you've chosen to hide.
        <div style="margin-top:14px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <a class="btn" href="#/">Back to the catalog</a><button class="btn" type="button" data-adult-toggle>Show adult content</button></div></div>`
    : `<div class="error"><strong>${e.status === 404 ? "Not in the catalog" : "Couldn't read the chain"}</strong><br>${esc(e.message)}
    <div style="margin-top:14px"><a class="btn" href="#/">Back to the catalog</a></div></div>`;
  const slowNote = "Fetching blocks over IPFS — the first visit to a shelf can take a moment.";

  // ---------- home ----------
  async function renderHome(stale) {
    topbar.hidden = true;
    document.title = "Open Domain Catalog";
    view.innerHTML = `<section class="home">
      <a class="wordmark big" href="#/"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span><span>Open Domain <em>Catalog</em></span></a>
      <p class="tagline">A library of the web, shelved by call number and read straight from IPFS.</p>
      <form class="search" data-search>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input name="q" type="search" placeholder="Go to a call number, e.g. 05 or ABC.DEF.G" autocomplete="off" aria-label="Go to call number" autofocus>
        <kbd>/</kbd>
      </form>
      <div class="actions">
        <a class="btn primary" href="${browseHref("", 0, { from: "" })}">Browse the stacks from the start →</a>
        <a class="btn" href="#/ipfs"><span class="dot" data-reach></span>IPFS node status</a>
        <span data-adult-slot>${adultToggle()}</span>
      </div>
      <h2 class="section-title">The card catalog</h2>
      <div class="drawers" id="drawers">${Array.from({ length: 3 }, () => `<div class="drawer"><div class="skel" style="width:30%"></div><div class="skel" style="width:70%;height:20px"></div></div>`).join("")}</div>
    </section>`;
    refreshReachDot();
    try {
      const data = await api("category", { call: "", hide: hideParam() });
      noteRoot(data.root);
      if (stale()) return;
      $("#drawers").innerHTML = data.children.length ? data.children.map((c) => `
        <a class="drawer" href="${browseHref(c.call, 0, { from: c.call })}">
          <span class="pull" aria-hidden="true"></span>
          <span class="label">${esc(c.call)}</span>
          <h3>${esc(c.desc || "Untitled")}</h3>
          <p>${c.has_children ? "Subcategories" : ""}${c.has_children && c.has_domains ? " · " : ""}${c.has_domains ? "Domains" : ""}${!c.has_children && !c.has_domains ? "Empty shelf" : ""}</p>
        </a>`).join("") : `<div class="empty">The catalog has no categories yet.</div>`;
    } catch (e) {
      if (!stale()) $("#drawers").outerHTML = errorBox(e);
    }
  }

  // ---------- browse ----------
  // Previous-page support: Next pushes onto this trail, so Previous can go back
  // through history; a deep link with no trail falls back to the shelf start.
  const trail = [];

  // Sidebar: where you are (breadcrumbs), then the shelf you're on: the current
  // category's siblings with it highlighted and its own subcategories nested
  // underneath. ``cur`` and ``parent`` are /api/category results; ``parent`` is
  // null at "All shelves".
  function rail(cur, parent) {
    const link = (c, cls) => `<li><a class="${cls}" href="${browseHref(c.call, 0, { from: c.call })}"><span class="c">${esc(c.call)}</span>${esc(c.desc || "Untitled")}</a></li>`;
    const crumbs = cur.breadcrumbs;
    const loc = [`<li><a href="${browseHref("", 0, { from: "" })}" class="${crumbs.length ? "" : "here"}"><span class="c">—</span>All shelves</a></li>`];
    crumbs.forEach((c, i) => loc.push(link(c, i === crumbs.length - 1 ? "here" : "")));

    let title, items;
    if (!parent) {                          // at "All shelves": list the top shelves
      title = "Top shelves";
      items = cur.children.map((c) => link(c, "depth-1")).join("");
    } else {
      title = parent.call ? `${esc(parent.call)} ${esc(parent.desc || "Untitled")}` : "Top shelves";
      items = parent.children.map((c) => {
        if (c.call !== cur.call) return link(c, "depth-1");
        return link(c, "depth-1 here") + cur.children.map((k) => link(k, "depth-2")).join("");
      }).join("");
    }
    return `<h4>Location</h4><ul class="tree">${loc.join("")}</ul>
      <h4>${title}</h4><ul class="tree">${items || `<li><span class="tree muted" style="padding:6px 10px;display:block">No categories here.</span></li>`}</ul>`;
  }


  // ---------- sidebar that follows the content ----------
  // The server always answers from the latest catalog root. Category details
  // only change when that root changes, so cache them and start over whenever
  // the server reports a new root.
  const catCache = new Map();
  let cacheRoot = null;
  function noteRoot(root) {
    if (root && root !== cacheRoot) {
      if (cacheRoot !== null) catCache.clear();
      cacheRoot = root;
    }
  }
  function getCategory(b) {
    const key = `${hideAdult ? "h" : "a"}|${b}`;   // children differ with the 18+ setting
    if (!catCache.has(key)) {
      const p = api("category", { call: b, hide: hideParam() }).then((c) => {
        if (c.root && c.root !== cacheRoot) {   // newer catalog: drop older entries
          noteRoot(c.root);
          catCache.set(key, p);
        }
        return c;
      }).catch((e) => { catCache.delete(key); throw e; });
      catCache.set(key, p);
    }
    return catCache.get(key);
  }

  // The sidebar describes the page: the category the page's first domain is
  // in, and the shelf it sits on. It doesn't change while you scroll.
  async function drawRail(b, stale) {
    let cur, parent = null;
    try {
      [cur, parent] = await Promise.all([getCategory(b), b ? getCategory(b.slice(0, -1)) : null]);
    } catch { return null; }
    if (stale() || !$("#rail")) return null;
    $("#rail").innerHTML = rail(cur, parent);
    return cur;
  }

  // Header card for the subject the page is on (the same category as the
  // sidebar). ``start`` is the category reading began at, noted when different.
  function headCard(cur, start) {
    const crumbs = cur.breadcrumbs.length > 1
      ? crumbLinks(cur.call, cur.breadcrumbs.slice(0, -1).map((b) => b.desc))
      : "Open Domain Catalog";
    const moved = bare(start.call) !== bare(cur.call);
    const began = moved
      ? ` · started at <a href="${browseHref(start.call, 0, { from: start.call })}">${esc(start.call ? `${start.call} ${start.desc || "Untitled"}` : "All shelves")}</a>`
      : "";
    return `<div class="catcard">
      <div class="top"><span class="call">${esc(cur.call || "000.000.000")}</span>
        <span class="crumbs">${crumbs}</span></div>
      <h1>${esc(cur.call ? cur.desc || "Untitled category" : "All shelves")}</h1>
      <div class="meta">${cur.children.length} subcategor${cur.children.length === 1 ? "y" : "ies"} ·
        ${cur.has_domains ? "holds domains of its own" : "no domains of its own"}${began}</div>
    </div>`;
  }

  async function renderBrowse(call, offset, q, stale) {
    topbar.hidden = false;
    setQuery("");
    const from = q.has("from") ? q.get("from") : dotted(call);
    const pageNo = Math.max(1, parseInt(q.get("p") || "1", 10) || 1);
    view.innerHTML = `<div class="layout"><aside class="rail" id="rail">${skeleton()}</aside>
      <section><div id="head"><div class="catcard"><div class="skel" style="width:20%"></div><div class="skel" style="width:50%;height:26px"></div></div></div>
      <div id="flow">${skeleton(slowNote)}</div></section></div>`;

    let cat, flow;
    try {
      const fromBare = bare(from);
      [cat, flow] = await Promise.all([
        api("category", { call: fromBare, hide: hideParam() }).then((c) => { noteRoot(c.root); return c; }),
        api("flow", { from: bare(from), call: bare(call), offset, hide: hideParam() }).then((f) => { noteRoot(f.root); if (!stale()) drawFlow(f); return f; }),
      ]);
    } catch (e) {
      if (!stale()) view.innerHTML = `<div class="layout" style="grid-template-columns:1fr"><section>${errorBox(e)}</section></div>`;
      return;
    }
    if (stale()) return;
    // Sidebar and header follow the subject this page is on: the category of
    // its first domain (an empty page, at the end of the catalog, shows the
    // category you chose).
    const cur = (await drawRail(flow.items.length ? bare(flow.items[0].call) : bare(from), stale)) || cat;
    if (stale()) return;
    $("#head").innerHTML = headCard(cur, cat);
    document.title = `${cur.call ? cur.call + " " + (cur.desc || "") : "All shelves"} · Open Domain Catalog`;

    function drawFlow(f) {
      const fromB = bare(from);
      const first = (pageNo - 1) * PAGE + 1;
      let html = "";
      if (f.warnings?.length) html += `<div class="notice"><strong>Skipped malformed blocks:</strong> ${f.warnings.map(esc).join("; ")}</div>`;
      if (!f.items.length) {
        html += `<div class="empty"><h3>End of the catalog</h3>
          ${offset || pageNo > 1 ? "There are no more domains after this point in the catalog." : "This category, its subcategories and everything after it in the catalog have no domains."}
          <div style="margin-top:14px"><a class="btn" href="${browseHref("", 0, { from: "" })}">Start again from the first shelf</a></div></div>`;
      } else {
        html += `<ol class="results">`;
        let last = null;
        f.items.forEach((it, n) => {
          if (it.call !== last) {
            const b = bare(it.call);
            const parentB = fromB.slice(0, -1);
            const tag = !fromB || b === fromB ? ""
              : b.startsWith(fromB) ? "Subcategory"
              : b.startsWith(parentB) && fromB.length > 0 && b.length >= fromB.length ? "Sibling"
              : "Next on the shelf";
            const cont = n === 0 && it.offset > 0 ? " <small>(continued)</small>" : "";
            html += `<li class="shelf-mark" data-call="${esc(b)}">
              <a class="spine" href="${browseHref(b, 0, { from: it.call })}">${esc(it.call)}</a>
              <a class="where" href="${browseHref(b, 0, { from: it.call })}">${esc(it.crumbs[it.crumbs.length - 1] || "Untitled")}${cont}
                ${it.crumbs.length > 1 ? `<small> in ${esc(it.crumbs.slice(0, -1).join(" › "))}</small>` : ""}</a>
              ${tag ? `<span class="flowtag">${tag}</span>` : ""}
            </li>`;
            last = it.call;
          }
          html += resultItem(it, n);
        });
        html += `</ol>`;
        if (!f.next) html += `<p class="end-note">End of the catalog</p>`;
      }
      const shown = f.items.length;
      html += `<nav class="pager" aria-label="Pages">
        <button class="btn" data-prev ${pageNo > 1 || offset > 0 || bare(call) !== fromB ? "" : "disabled"}>← Previous ${PAGE}</button>
        <span class="pos">${shown ? `Domains ${first}–${first + shown - 1} from <code>${esc(from || "the first shelf")}</code> onward` : ""}</span>
        <button class="btn primary" data-next ${f.next ? "" : "disabled"}>Next ${PAGE} →</button>
      </nav>`;
      $("#flow").innerHTML = html;
      const nextBtn = $("[data-next]");
      nextBtn?.addEventListener("click", () => {
        if (!f.next) return;
        trail.push(location.hash);
        location.hash = browseHref(f.next.call, f.next.offset, { from, p: pageNo + 1 });
      });
      $("[data-prev]")?.addEventListener("click", () => {
        if (trail.length) { trail.pop(); history.back(); }
        else location.hash = browseHref(from, 0, { from });
      });
    }
  }

  // ---------- IPFS status page ----------
  const fmtBytes = (n) => {
    if (n == null || isNaN(n)) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; n = Number(n);
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  };
  const fmtDur = (s) => {
    if (s == null) return "—";
    s = Math.max(0, Math.round(s));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  };
  const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
  const short = (id, a = 8, b = 6) => (id && id.length > a + b + 1 ? `${id.slice(0, a)}…${id.slice(-b)}` : id || "—");
  const copyBtn = (text) => `<button class="copy" type="button" data-copy="${esc(text)}">copy</button>`;
  const codeCopy = (text) => `<code>${esc(text)}</code> ${copyBtn(text)}`;
  const addrList = (list, empty = "None") => list && list.length
    ? `<ul class="addrs">${list.map((a) => `<li><code>${esc(a)}</code>${copyBtn(a)}</li>`).join("")}</ul>`
    : `<p class="none">${esc(empty)}</p>`;
  const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const errOr = (sec, fn, off = "Not running on this node.") =>
    sec == null ? `<p class="none">${esc(off)}</p>` : sec.error ? `<p class="none">Unavailable: ${esc(sec.error)}</p>` : fn(sec);
  const reachPill = (r) => `<span class="pill ${r === "public" ? "ok" : r === "private" ? "warn" : "mute"}">${esc(r || "unknown")}</span>`;
  const reachClass = (d) => {
    const r = d?.addresses?.reachability, dial = d?.sharing?.ready;
    return r === "public" ? "dot ok" : dial ? "dot warn" : (d?.peers?.total ?? 0) === 0 ? "dot bad" : "dot";
  };
  const humanKey = (k) => k.replace(/_/g, " ");

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "copied"; }
    catch { b.textContent = "select"; }
    setTimeout(() => (b.textContent = "copy"), 1200);
  });

  let ipfsTimer = null;
  let peerFilter = "";
  function stopIpfsRefresh() { clearTimeout(ipfsTimer); ipfsTimer = null; }

  async function refreshReachDot() {
    try {
      const d = await api("ipfs");
      document.querySelectorAll("[data-reach]").forEach((el) => (el.className = reachClass(d)));
      return d;
    } catch { return null; }
  }

  async function renderIpfs(stale) {
    topbar.hidden = false;
    setQuery("");
    document.title = "IPFS node · Open Domain Catalog";
    view.innerHTML = `<section class="ipfs">
      <div class="ipfs-head"><div><h1>IPFS node</h1>
        <p>The pyipfs peer inside this explorer: how it reads the catalog, and how it shares blocks with other readers.</p></div>
        <span class="live"><span class="dot" id="live-dot"></span><span id="live-text">Connecting…</span></span></div>
      <div class="tiles" id="tiles">${Array.from({ length: 6 }, () => `<div class="tile"><div class="skel" style="width:50%"></div><div class="skel" style="width:70%;height:22px"></div></div>`).join("")}</div>
      <div class="dash">
        <div class="panel" id="p-node"><h2>Node</h2>${skeleton()}</div>
        <div class="panel" id="p-ipns"><h2>Catalog root (IPNS)</h2>${skeleton()}</div>
        <div class="panel wide" id="p-addrs"><h2>Addresses &amp; reachability</h2>${skeleton()}</div>
        <div class="panel" id="p-nat"><h2>NAT traversal</h2></div>
        <div class="panel" id="p-net"><h2>DHT &amp; Bitswap</h2></div>
        <div class="panel" id="p-repo"><h2>Repository</h2></div>
        <div class="panel" id="p-share-sum"><h2>Block sharing</h2></div>
        <div class="panel wide"><h2>Connected peers <small id="peer-count"></small></h2>
          <input class="filter" id="peer-filter" type="search" placeholder="Filter peers, addresses, agents" value="${esc(peerFilter)}" aria-label="Filter peers">
          <div class="tbl-wrap scroll" id="p-peers"></div></div>
        <div class="panel wide"><h2>Shared catalog blocks <small id="share-count"></small></h2>
          <div class="tbl-wrap scroll" id="p-share"></div></div>
      </div></section>`;
    let last = null;
    $("#peer-filter").addEventListener("input", (e) => { peerFilter = e.target.value; if (last) drawPeers(last.peers); });

    const tick = async () => {
      let d;
      try { d = await api("ipfs"); } catch (e) {
        if (stale()) return;
        $("#live-dot").className = "dot bad"; $("#live-text").textContent = `Can't reach the explorer: ${e.message}`;
        ipfsTimer = setTimeout(tick, 5000); return;
      }
      if (stale()) return;
      last = d;
      document.querySelectorAll("[data-reach]").forEach((el) => (el.className = reachClass(d)));
      $("#live-dot").className = "dot ok";
      $("#live-text").textContent = `Live · updated ${new Date().toLocaleTimeString()} · refreshes every 5s`;
      if (!d.available) { $(".dash").innerHTML = `<div class="empty wide">No IPFS node is attached.</div>`; return; }
      drawAll(d);
      ipfsTimer = setTimeout(tick, 5000);
    };
    await tick();

    function drawAll(d) {
      const n = d.node, a = d.addresses, p = d.peers, sh = d.sharing, r = d.repo, bs = d.bitswap, dht = d.dht;
      const tile = (k, v, sub = "") => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="sub">${sub}</div></div>`;
      $("#tiles").innerHTML = [
        tile("Reachability", reachPill(a?.reachability), (() => {
          const direct = (a?.public || []).filter((x) => !x.includes("p2p-circuit")).length;
          const relayed = (a?.public || []).length - direct;
          if (a?.reachability === "private" || (!direct && relayed)) return relayed ? `reachable via ${relayed} relay address${relayed === 1 ? "" : "es"}` : "not reachable yet";
          return direct ? `${direct} direct public address${direct === 1 ? "" : "es"}` : "no public address yet";
        })()),
        tile("Peers", num(p?.total), p?.error ? "" : `${p.inbound} in · ${p.outbound} out · ${p.relayed} relayed`),
        tile("DHT table", num(dht?.routing_table), dht ? `${esc(dht.mode)} mode` : "DHT off"),
        tile("Shared blocks", !sh || sh.error ? "—" : `${num(sh.announced)}<span style="font-size:15px;color:var(--ink-3)">/${num(sh.blocks)}</span>`, !sh || sh.error ? "announcing is off" : sh.ready ? `${num(sh.due)} due to announce` : "waiting for a reachable address"),
        tile("Bitswap", bs?.error ? "—" : `${num(bs.stats.blocks_sent)} <span style="font-size:13px;color:var(--ink-3)">sent</span>`, bs?.error ? "" : `${fmtBytes(bs.stats.data_sent)} out · ${num(bs.stats.blocks_received)} blocks / ${fmtBytes(bs.stats.data_received)} in`),
        tile("Repository", r?.error ? "—" : fmtBytes(r.size), r?.error ? "" : `${num(r.num_blocks)} blocks${r.storage_max ? ` of ${fmtBytes(r.storage_max)}` : ""}`),
      ].join("");

      $("#p-node").innerHTML = `<h2>Node</h2>` + errOr(n, (n) => kv([
        ["Peer ID", codeCopy(n.peer_id)],
        ["Agent", esc(n.agent_version)],
        ["Protocol", esc(n.protocol_version)],
        ["Identity key", esc(n.key_type)],
        ["Crypto backend", esc(n.crypto_backend)],
        ["Uptime", fmtDur(n.uptime)],
        ["Repo", n.repo ? `<code>${esc(n.repo)}</code>` : "in memory"],
      ]) + `<h3>Protocols served</h3><div class="chipset">${n.protocols.map((x) => `<code>${esc(x)}</code>`).join("")}</div>`);

      const ip = d.ipns;
      $("#p-ipns").innerHTML = `<h2>Catalog root (IPNS)</h2>` + errOr(ip, (ip) => kv([
        ["IPNS name", codeCopy(ip.name)],
        ["Current root", ip.root ? codeCopy(ip.root) : `<span class="none">not resolved yet</span>`],
        ["Sequence", ip.sequence != null ? num(ip.sequence) : `<span class="none">unknown</span>`],
        ["Previous root", ip.previous ? `<code>${esc(ip.previous)}</code>` : `<span class="none">none (first root)</span>`],
        ["Resolved", ip.resolved_ago != null ? `${fmtDur(ip.resolved_ago)} ago` : `<span class="none">using last known root</span>`],
        ["Next check", ip.next_check_in != null ? `in ${fmtDur(ip.next_check_in)}` : "—"],
        ip.resolve_error ? ["Last error", `<span class="pill bad">error</span> ${esc(ip.resolve_error)}`] : null,
      ]));

      $("#p-addrs").innerHTML = `<h2>Addresses &amp; reachability <small>${reachPill(a?.reachability)}</small></h2>` + errOr(a, (a) => `
        <div class="dash" style="gap:4px 24px">
          <div><h3>Announced to peers</h3>${addrList(a.announced, "Nothing announced yet")}</div>
          <div><h3>Public (confirmed)</h3>${addrList(a.public, "No confirmed public address")}</div>
          <div><h3>Listening on</h3>${addrList(a.listen)}</div>
          <div><h3>Observed by peers</h3>${addrList(a.observed, "No observations yet")}</div>
          <div><h3>Mapped on router (UPnP / NAT-PMP)</h3>${addrList(a.nat_mapped, "No router mapping")}</div>
          <div><h3>Relay (p2p-circuit)</h3>${addrList(a.relay, "No relay addresses")}</div>
          <div><h3>AutoNAT: reachable</h3>${addrList(a.verified, "None confirmed")}</div>
          <div><h3>AutoNAT: unreachable</h3>${addrList(a.unreachable, "None")}</div>
        </div>`);

      $("#p-nat").innerHTML = `<h2>NAT traversal</h2>
        <h3>Router port mapping</h3>${errOr(d.nat, (x) => kv([
          ["Gateway", x.gateway ? `${esc(x.gateway)}${x.gateway_host ? ` <code>${esc(x.gateway_host)}</code>` : ""}` : `<span class="none">searching / none found</span>`],
          ["External IP", x.external_ip ? `<code>${esc(x.external_ip)}</code>` : "—"],
          ["Mappings", x.mappings.length ? x.mappings.map((m) => `<code>${m.internal} → ${m.external}</code>`).join(" ") : "none"],
        ]), "Not active (needs a public listen address).")}
        <h3>AutoNAT</h3>${errOr(d.autonat, (x) => x.results.length
          ? `<div class="tbl-wrap"><table class="tbl"><tr><th>Address</th><th class="num">Reachable</th><th class="num">Unreachable</th></tr>${x.results.map((r) =>
              `<tr><td><code>${esc(r.addr)}</code></td><td class="num">${r.reachable}</td><td class="num">${r.unreachable}</td></tr>`).join("")}</table></div>
             <p class="none" style="margin-top:6px">${x.confidence} agreeing servers needed for a verdict.</p>`
          : `<p class="none">No dial-back results yet.</p>`)}
        <h3>Circuit relay</h3>${errOr(d.relay, (x) => kv([
          ["Client mode", esc(x.mode)],
          ["Relay service", x.service ? "on" : "off"],
          ["Reservations", x.reservations.length ? "" : "none"],
        ]) + (x.reservations.length ? `<ul class="addrs">${x.reservations.map((rv) =>
          `<li><code>${esc(rv.relay)}</code><span class="none">${rv.expires_in != null ? `expires in ${fmtDur(rv.expires_in)}` : ""}</span></li>`).join("")}</ul>` : ""))}
        <h3>Hole punching (DCUtR)</h3>${errOr(d.hole_punch, (x) => kv(Object.entries(x).map(([k, v]) => [humanKey(k), num(v)])))}`;

      $("#p-net").innerHTML = `<h2>DHT &amp; Bitswap</h2>
        <h3>Kademlia DHT</h3>${errOr(dht, (x) => kv([
          ["Protocol", `<code>${esc(x.protocol)}</code>`],
          ["Mode", `${esc(x.mode)} <span class="none">(queries the DHT; doesn't answer queries)</span>`],
          ["Routing table", `${num(x.routing_table)} peers`],
          ["Bootstrap peers", num(x.bootstrap_peers)],
        ]), "DHT disabled.")}
        <h3>Bitswap</h3>${errOr(bs, (x) => kv([
          ["Serving blocks", x.serving ? `<span class="pill ok">on</span>` : `<span class="pill bad">off</span>`],
          ["Blocks sent", `${num(x.stats.blocks_sent)} · ${fmtBytes(x.stats.data_sent)}`],
          ["Blocks received", `${num(x.stats.blocks_received)} · ${fmtBytes(x.stats.data_received)}`],
          ["Duplicate blocks", num(x.stats.dup_blocks)],
          ["Our open wants", num(x.our_wants)],
          ["Peers wanting blocks", `${num(x.peers_wanting)} <span class="none">(${num(x.blocks_wanted_by_peers)} blocks)</span>`],
        ]))}`;

      $("#p-repo").innerHTML = `<h2>Repository</h2>` + errOr(r, (x) => {
        const pct = x.storage_max ? Math.min(100, (100 * x.size) / x.storage_max) : null;
        const skip = new Set(["size", "storage_max", "num_blocks", "pins"]);
        return (pct != null ? `<div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
            <p class="none" style="margin:0 0 10px">${fmtBytes(x.size)} of ${fmtBytes(x.storage_max)} (${pct.toFixed(1)}%). Least-recently-used unpinned blocks are evicted when full.</p>` : "") +
          kv([["Blocks", num(x.num_blocks)], ["Pins", num(x.pins)],
              ...Object.entries(x).filter(([k]) => !skip.has(k)).map(([k, v]) =>
                [humanKey(k), /size|bytes|water/.test(k) && typeof v === "number" && v > 1 ? fmtBytes(v) : typeof v === "number" ? num(v) : esc(String(v))])]);
      }) + `<h3>Block cache (memory)</h3>` + errOr(d.block_cache, (c) => {
        const reads = c.hits + c.misses;
        return kv([
          ["Holding", `${num(c.blocks)} blocks · ${fmtBytes(c.bytes)} of ${fmtBytes(c.max_bytes)}`],
          ["Hit rate", reads ? `${((100 * c.hits) / reads).toFixed(1)}% <span class="none">(${num(c.hits)} hits, ${num(c.misses)} misses)</span>` : "no reads yet"],
          ["Evicted", num(c.evictions)],
        ]) + `<p class="none" style="margin-top:6px">Parsed blocks, by CID, shared across catalog versions. pyipfs manages the copies on disk.</p>`;
      });

      $("#p-share-sum").innerHTML = `<h2>Block sharing <small>by pyipfs</small></h2>` + errOr(sh, (x) => kv([
        ["Status", x.ready ? `<span class="pill ok">announcing</span>` : `<span class="pill warn">waiting</span> <span class="none">for a public or relay address (up to 3 min)</span>`],
        ["Strategy", `<code>${esc(x.strategy)}</code> <span class="none">(every cached block)</span>`],
        ["Blocks held", num(x.blocks)],
        ["Announced", num(x.announced)],
        ["Due now", num(x.due)],
        x.retrying ? ["Retrying", `${num(x.retrying)} <span class="none">(backing off after failures)</span>`] : null,
        ["Re-announce", `every ${fmtDur(x.interval)}`],
        ["Last pass", x.last_pass_ago != null ? `${fmtDur(x.last_pass_ago)} ago, took ${fmtDur(x.last_pass_duration)}` : "not yet"],
        ["Totals", `${num(x.provided_total)} announced · ${num(x.failed_total)} failed · ${num(x.passes)} passes`],
        ["Parallel announces", num(x.workers)],
      ]) + `<p class="none" style="margin-top:10px">Every block in this reader's cache is served over Bitswap and announced on the DHT by pyipfs, so other readers can fetch it from here.</p>`, "Announcing is off on this node.");

      drawPeers(p);
      $("#share-count").textContent = !sh || sh.error ? "" : `${num(sh.blocks)} block${sh.blocks === 1 ? "" : "s"}${sh.list.length < sh.blocks ? ` (showing ${sh.list.length})` : ""}`;
      $("#p-share").innerHTML = errOr(sh, (x) => x.list.length
        ? `<table class="tbl"><tr><th>Block CID</th><th>Announced</th><th>Next re-announce</th></tr>${x.list.map((b) =>
            `<tr><td>${codeCopy(b.cid)}</td><td class="num">${b.announced_ago != null ? `${fmtDur(b.announced_ago)} ago`
              : b.retry_in != null ? `<span class="pill bad">failed ×${b.failures}</span>` : `<span class="pill warn">pending</span>`}</td>
             <td class="num">${b.next_in != null ? `in ${fmtDur(b.next_in)}` : b.retry_in != null ? `retry in ${fmtDur(b.retry_in)}` : "—"}</td></tr>`).join("")}</table>`
        : `<p class="none">No catalog blocks fetched yet. Browse a shelf and they'll appear here.</p>`);
    }

    function drawPeers(p) {
      if (!p || p.error) { $("#p-peers").innerHTML = errOr(p, () => ""); return; }
      const f = peerFilter.trim().toLowerCase();
      const rows = f ? p.list.filter((c) => `${c.peer} ${c.addr} ${c.agent} ${c.direction}`.toLowerCase().includes(f)) : p.list;
      $("#peer-count").textContent = `${num(p.total)} peers · ${num(p.connections)} connections · ${num(p.known)} known${f ? ` · ${rows.length} shown` : ""}`;
      $("#p-peers").innerHTML = rows.length ? `<table class="tbl"><tr><th>Peer</th><th>Address</th><th>Dir</th><th>Type</th><th>Agent</th><th class="num">Connected</th></tr>${rows.map((c) => `
        <tr><td><code title="${esc(c.peer)}">${esc(short(c.peer, 10, 6))}</code>${c.dht ? ` <span class="pill mute" title="In the DHT routing table">dht</span>` : ""}</td>
          <td><code>${esc(c.addr || "—")}</code></td>
          <td>${c.direction === "inbound" ? "in" : "out"}</td>
          <td>${c.relayed ? `<span class="pill warn">${c.limited ? "relay (limited)" : "relay"}</span>` : "direct"}</td>
          <td>${esc(c.agent || "—")}</td>
          <td class="num">${fmtDur(c.age)}</td></tr>`).join("")}</table>`
        : `<p class="none">${f ? "No peers match the filter." : "No connections yet."}</p>`;
    }
  }

  syncAdultToggles();
  route();
  refreshReachDot();
  setInterval(refreshReachDot, 60000);
})();
