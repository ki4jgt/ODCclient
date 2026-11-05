"""Flask front end for the ODC chain explorer."""

import os

from flask import Flask, jsonify, request, render_template

from . import ipfs_status
from .chain import Hidden, NotFound, MalformedBlock, parse_call, fmt_call, PAGE_SIZE


def create_app(explorer):
    app = Flask(__name__)
    app.json.sort_keys = False

    def _catalog():
        if explorer.root is None and not explorer.wait_ready(90):
            raise LookupError(explorer.resolve_error or "still resolving the ODC root over IPNS")
        # Always the latest published root; clients can't pin an older one.
        return explorer.catalog()

    def _call_arg(name="call", default=""):
        raw = request.args.get(name)
        bare = parse_call(default if raw is None else raw)
        if bare is None:
            raise NotFound("call numbers use 0-9 and A-Z, up to 9 characters")
        return bare

    @app.errorhandler(NotFound)
    def _not_found(e):
        return jsonify(error="not_found", message=f"No category {e}"), 404

    def _hide_arg():
        # ``hide``: comma-separated call numbers whose whole branch the reader
        # doesn't want to see (the front end's "hide adult content" sends 0).
        out = []
        for part in request.args.get("hide", "").split(","):
            bare = parse_call(part)
            if bare:
                out.append(bare)
        return tuple(out)

    @app.errorhandler(Hidden)
    def _hidden(e):
        return jsonify(error="hidden", message=f"{e} is hidden by your content settings"), 403

    @app.errorhandler(MalformedBlock)
    def _malformed(e):
        return jsonify(error="malformed", message=str(e)), 502

    @app.errorhandler(LookupError)
    def _unavailable(e):
        return jsonify(error="unavailable", message=str(e)), 503

    def _asset_version():
        # Changes whenever app.js or app.css changes, so a reload always fetches
        # the current front end instead of a copy the browser kept.
        mtimes = []
        for name in ("app.js", "app.css"):
            try:
                mtimes.append(os.path.getmtime(os.path.join(app.static_folder, name)))
            except OSError:
                pass
        return str(int(max(mtimes, default=0)))

    @app.get("/")
    def index():
        resp = app.make_response(render_template("index.html", ipns=explorer.ipns_name,
                                                 v=_asset_version()))
        # Never reuse a stored copy of the page: a reload always brings the
        # current front end (its script and stylesheet URLs carry a version).
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/favicon.ico")
    def favicon():
        # Browsers and other tools ask for /favicon.ico regardless of <link> tags.
        return app.send_static_file("favicon.ico")

    @app.get("/api/ipfs")
    def ipfs():
        return jsonify(ipfs_status.snapshot(explorer))

    @app.get("/api/category")
    def category():
        cat = _catalog()
        data = cat.category(_call_arg(), _hide_arg())
        data["root"] = cat.root
        return jsonify(data)

    @app.get("/api/flow")
    def flow():
        # ``from`` is where reading started (its subcategories, then later
        # siblings, then onward to the end of the catalog); ``call`` + ``offset``
        # is the cursor within that order. Both default to the same category.
        cat = _catalog()
        call = _call_arg("call")
        origin = _call_arg("from", fmt_call(call))
        offset = max(0, request.args.get("offset", 0, type=int))
        page = cat.page(origin, call, offset, PAGE_SIZE, _hide_arg())
        page.update(root=cat.root, origin=fmt_call(origin),
                    start={"call": fmt_call(call), "offset": offset})
        return jsonify(page)

    @app.after_request
    def _no_third_parties(resp):
        # Belt and braces: the browser may only load from this server.
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "font-src 'self'; "
            "script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; "
            "form-action 'self'")
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    return app
