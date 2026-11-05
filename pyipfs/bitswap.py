"""Bitswap 1.2.0 (with 1.1.0/1.0.0 fallbacks): exchange blocks with peers.

Acts as both client (``get`` / ``get_many``) and server (answers peers'
wantlists from the local blockstore).
"""

import logging
import threading
import time

from . import protobuf as pb
from .cid import CID
from .p2p.host import read_delimited, write_delimited

log = logging.getLogger(__name__)

PROTOCOLS = ["/ipfs/bitswap/1.2.0", "/ipfs/bitswap/1.1.0", "/ipfs/bitswap/1.0.0", "/ipfs/bitswap"]
WANT_BLOCK, WANT_HAVE = 0, 1
HAVE, DONT_HAVE = 0, 1
MAX_MESSAGE = 4 * 1024 * 1024 + 64 * 1024
MAX_BLOCK_BATCH = 2 * 1024 * 1024


class BlockUnavailable(LookupError):
    pass


class Message:
    """A decoded/encodable bitswap message."""

    def __init__(self):
        self.wants = []       # (cid, priority, cancel, want_type, send_dont_have)
        self.full = False
        self.blocks = []      # (cid, data)
        self.presences = []   # (cid, HAVE|DONT_HAVE)

    def encode(self, legacy=False) -> bytes:
        out = b""
        if self.wants or self.full:
            wl = b""
            for cid, prio, cancel, wtype, sdh in self.wants:
                e = pb.enc_bytes(1, cid.to_bytes()) + pb.enc_varint(2, prio)
                if cancel:
                    e += pb.enc_varint(3, 1)
                if not legacy:
                    if wtype:
                        e += pb.enc_varint(4, wtype)
                    if sdh:
                        e += pb.enc_varint(5, 1)
                wl += pb.enc_bytes(1, e)
            if self.full:
                wl += pb.enc_varint(2, 1)
            out += pb.enc_bytes(1, wl)
        for cid, data in self.blocks:
            if legacy:
                out += pb.enc_bytes(2, data)
            else:
                out += pb.enc_bytes(3, pb.enc_bytes(1, cid.prefix()) + pb.enc_bytes(2, data))
        if not legacy:
            for cid, t in self.presences:
                out += pb.enc_bytes(4, pb.enc_bytes(1, cid.to_bytes()) + pb.enc_varint(2, t))
        return out

    @classmethod
    def decode(cls, buf) -> "Message":
        m = pb.decode(buf)
        msg = cls()
        if 1 in m:
            wl = pb.decode(m[1][0])
            msg.full = bool(pb.first(wl, 2, 0))
            for raw in wl.get(1, []):
                e = pb.decode(raw)
                msg.wants.append((CID.from_bytes(pb.first(e, 1)), pb.to_signed(pb.first(e, 2, 1), 32),
                                  bool(pb.first(e, 3, 0)), pb.first(e, 4, WANT_BLOCK),
                                  bool(pb.first(e, 5, 0))))
        for data in m.get(2, []):  # bitswap 1.0.0: CIDv0 blocks
            msg.blocks.append((CID.from_data(data, "dag-pb", 0), data))
        for raw in m.get(3, []):
            b = pb.decode(raw)
            data = pb.first(b, 2, b"")
            msg.blocks.append((CID.from_prefix(pb.first(b, 1), data), data))
        for raw in m.get(4, []):
            p = pb.decode(raw)
            msg.presences.append((CID.from_bytes(pb.first(p, 1)), pb.first(p, 2, HAVE)))
        return msg


class _Want:
    __slots__ = ("cid", "event", "data", "refs", "haves", "dont_haves", "peers_asked", "block_from")

    def __init__(self, cid):
        self.cid = cid
        self.event = threading.Event()
        self.data = None
        self.refs = 0
        self.haves = set()
        self.dont_haves = set()
        self.peers_asked = set()
        self.block_from = None


class _PeerSender:
    """A persistent outbound bitswap stream to one peer."""

    def __init__(self, host, peer):
        self.host, self.peer = host, peer
        self.stream = None
        self.lock = threading.Lock()

    def send(self, msg: Message):
        with self.lock:
            for attempt in range(2):
                try:
                    if self.stream is None:
                        self.stream = self.host.new_stream(self.peer, PROTOCOLS, timeout=20)
                    legacy = self.stream.protocol in ("/ipfs/bitswap/1.0.0", "/ipfs/bitswap")
                    write_delimited(self.stream, msg.encode(legacy))
                    return True
                except Exception as e:
                    log.debug("bitswap send to %s failed: %s", self.peer, e)
                    if self.stream is not None:
                        try:
                            self.stream.reset()
                        except Exception:
                            pass
                    self.stream = None
            return False


class Bitswap:
    def __init__(self, host, blockstore, serve=True):
        self.host = host
        self.store = blockstore
        self.serve = serve
        self._wants = {}  # multihash -> _Want
        self._lock = threading.Lock()
        self._senders = {}
        self.stats = {"blocks_received": 0, "blocks_sent": 0, "data_received": 0,
                      "data_sent": 0, "dup_blocks": 0}
        self.ledger = {}  # PeerID -> peer's current wantlist {multihash: (cid, type, sdh)}
        for p in PROTOCOLS:
            host.set_stream_handler(p, self._handle_stream)
        host.on_connect(self._on_connect)
        host.on_disconnect(lambda c: self._forget_peer(c.remote_peer))

    # ---- sending ---------------------------------------------------------
    def _sender(self, peer):
        with self._lock:
            s = self._senders.get(peer)
            if s is None:
                s = self._senders[peer] = _PeerSender(self.host, peer)
            return s

    def _send(self, peer, msg):
        return self._sender(peer).send(msg)

    def _forget_peer(self, peer):
        if not self.host.is_connected(peer):
            with self._lock:
                self._senders.pop(peer, None)
            self.ledger.pop(peer, None)

    def _on_connect(self, conn):
        # tell newly connected peers what we are looking for
        with self._lock:
            wants = [w.cid for w in self._wants.values() if w.data is None]
        if wants:
            threading.Thread(target=self._send_wants, args=(conn.remote_peer, wants, WANT_HAVE),
                             daemon=True).start()

    def _send_wants(self, peer, cids, wtype=WANT_BLOCK):
        msg = Message()
        for c in cids:
            msg.wants.append((c, 1, False, wtype, True))
        with self._lock:
            for c in cids:
                w = self._wants.get(c.multihash)
                if w:
                    w.peers_asked.add(peer)
        return self._send(peer, msg)

    def _send_cancels(self, cids, peers):
        msg = Message()
        for c in cids:
            msg.wants.append((c, 0, True, WANT_BLOCK, False))
        for p in peers:
            if self.host.is_connected(p):
                threading.Thread(target=self._send, args=(p, msg), daemon=True).start()

    # ---- receiving -------------------------------------------------------
    def _handle_stream(self, st):
        peer = st.remote_peer
        while True:
            try:
                data = read_delimited(st, MAX_MESSAGE)
            except (EOFError, ConnectionError):
                return
            try:
                msg = Message.decode(data)
            except Exception as e:
                log.debug("bad bitswap message from %s: %s", peer, e)
                st.reset()
                return
            self._process(peer, msg)

    def _process(self, peer, msg: Message):
        for cid, data in msg.blocks:
            self._receive_block(peer, cid, data)
        for cid, t in msg.presences:
            ask = None
            with self._lock:
                w = self._wants.get(cid.multihash)
                if w is None or w.data is not None:
                    continue
                if t == HAVE:
                    w.haves.add(peer)
                    if w.block_from is None:
                        w.block_from = ask = peer
                else:
                    w.dont_haves.add(peer)
                    w.haves.discard(peer)
                    if w.block_from == peer:
                        w.block_from = None
                        others = [p for p in w.haves if self.host.is_connected(p)]
                        if others:
                            w.block_from = ask = others[0]
            if ask is not None:
                self._send_wants(ask, [w.cid], WANT_BLOCK)
        if msg.wants or msg.full:
            self._serve_wants(peer, msg)

    def _receive_block(self, peer, cid, data):
        if not cid.verify(data):
            log.warning("peer %s sent block not matching %s", peer, cid)
            return
        self.stats["blocks_received"] += 1
        self.stats["data_received"] += len(data)
        with self._lock:
            w = self._wants.get(cid.multihash)
            if w is None or w.data is not None:
                self.stats["dup_blocks"] += 1
                return
            w.data = data
            asked = set(w.peers_asked)
        self.store.put(cid, data, verify=False)
        w.event.set()
        asked.discard(peer)
        if asked:
            self._send_cancels([w.cid], asked)

    def _serve_wants(self, peer, msg):
        ledger = self.ledger.setdefault(peer, {})
        if msg.full:
            ledger.clear()
        for cid, _prio, cancel, wtype, sdh in msg.wants:
            if cancel:
                ledger.pop(cid.multihash, None)
            else:
                ledger[cid.multihash] = (cid, wtype, sdh)
        if not self.serve:
            return
        out = Message()
        size = 0
        for mh, (cid, wtype, sdh) in list(ledger.items()):
            if self.store.has(cid):
                if wtype == WANT_HAVE:
                    out.presences.append((cid, HAVE))
                else:
                    data = self.store.get(cid)
                    out.blocks.append((cid, data))
                    size += len(data)
                    self.stats["blocks_sent"] += 1
                    self.stats["data_sent"] += len(data)
                ledger.pop(mh, None)
            elif sdh:
                out.presences.append((cid, DONT_HAVE))
                ledger.pop(mh, None)
            if size >= MAX_BLOCK_BATCH:
                self._send(peer, out)
                out, size = Message(), 0
        if out.blocks or out.presences:
            self._send(peer, out)

    def notify_new_blocks(self, cids):
        """Offer newly added blocks to peers that are waiting for them."""
        mhs = {CID.decode(c).multihash for c in cids}
        for peer, ledger in list(self.ledger.items()):
            if mhs & set(ledger):
                self._serve_wants(peer, Message())

    # ---- public client API -----------------------------------------------
    def get(self, cid, timeout=60.0, peers=None) -> bytes:
        cid = CID.decode(cid)
        return self.get_many([cid], timeout, peers)[cid]

    def get_many(self, cids, timeout=60.0, peers=None, rebroadcast=5.0) -> dict:
        """Fetch several blocks concurrently. Returns ``{cid: data}``; raises
        ``BlockUnavailable`` if any are not obtained within ``timeout``."""
        cids = [CID.decode(c) for c in cids]
        result, missing = {}, []
        for c in cids:
            try:
                result[c] = self.store.get(c)
            except KeyError:
                missing.append(c)
        if not missing:
            return result
        wants = []
        with self._lock:
            for c in missing:
                w = self._wants.get(c.multihash)
                if w is None:
                    w = self._wants[c.multihash] = _Want(c)
                w.refs += 1
                wants.append(w)
        try:
            deadline = time.monotonic() + timeout
            while True:
                pending = [w for w in wants if w.data is None]
                if not pending:
                    break
                targets = list(peers) if peers is not None else self.host.peers()
                wtype = WANT_BLOCK if len(targets) == 1 else WANT_HAVE
                for p in targets:
                    todo = [w.cid for w in pending if p not in w.dont_haves]
                    if wtype == WANT_BLOCK:
                        for w in pending:
                            w.block_from = p
                    if todo:
                        threading.Thread(target=self._send_wants, args=(p, todo, wtype),
                                         daemon=True).start()
                wait_until = min(deadline, time.monotonic() + rebroadcast)
                for w in pending:
                    remaining = wait_until - time.monotonic()
                    if remaining <= 0 or not w.event.wait(remaining):
                        break
                if time.monotonic() >= deadline:
                    break
                with self._lock:
                    for w in pending:
                        w.block_from = None
                        w.dont_haves.clear()
            for w in wants:
                if w.data is None:
                    raise BlockUnavailable(f"block {w.cid} not found via bitswap within {timeout}s")
                result[w.cid] = w.data
            return result
        finally:
            with self._lock:
                for w in wants:
                    w.refs -= 1
                    if w.refs <= 0:
                        self._wants.pop(w.cid.multihash, None)
            # cancel anything still outstanding
            left = [w.cid for w in wants if w.data is None]
            if left:
                self._send_cancels(left, self.host.peers())

    def wantlist(self):
        with self._lock:
            return [w.cid for w in self._wants.values() if w.data is None]
