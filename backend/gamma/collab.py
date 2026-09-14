"""Live rooms: who is on a page right now, and the fan-out of applied
operations to them.

One room per ``(workspace, page_id)``, in memory — Gamma runs as one uvicorn
process everywhere (Docker, the desktop sidecar), so nothing needs to be
shared across workers. A room holds the websocket peers
(``routers/collab.py`` accepts them) with their identity, colour and last
cursor; ``publish`` sends a message to every peer and is safe to call from
the event loop AND from threadpool code (the sync AI chat endpoint runs the
agent's tools there): sends are always scheduled on the loop the sockets
live on.

Presence is never persisted. Document changes never travel over the socket
towards the server — writes are ``POST /api/pages/{id}/ops`` (gamma/ops.py),
the socket only carries the applied batches back out.
"""

import asyncio
import json
from dataclasses import dataclass, field

from .logbuf import log

PALETTE = 8  # colour indexes handed out per room (CSS: --peer-0 … --peer-7)

_rooms: dict[tuple[str, str], "Room"] = {}
_loop: asyncio.AbstractEventLoop | None = None  # the loop the sockets live on


@dataclass
class Peer:
    ws: object
    client: str
    user: str          # session username, "" for an anonymous share viewer
    name: str
    color: int
    can_edit: bool
    block: str = ""    # block the peer is on (focused row or open editor)
    anchor: int = -1   # selection inside the open editor, -1 = no editor open
    head: int = -1

    def public(self) -> dict:
        return {"client": self.client, "user": self.user, "name": self.name,
                "color": self.color, "can_edit": self.can_edit,
                "block": self.block, "anchor": self.anchor, "head": self.head}


@dataclass
class Room:
    key: tuple[str, str]
    peers: dict[str, Peer] = field(default_factory=dict)

    def next_color(self) -> int:
        used = {p.color for p in self.peers.values()}
        for i in range(PALETTE):
            if i not in used:
                return i
        return len(self.peers) % PALETTE

    def presence(self) -> list[dict]:
        return [p.public() for p in self.peers.values()]

    async def broadcast(self, text: str, exclude: str = "") -> None:
        targets = [p for p in list(self.peers.values()) if p.client != exclude]
        if not targets:
            return
        results = await asyncio.gather(*(p.ws.send_text(text) for p in targets),
                                       return_exceptions=True)
        for peer, res in zip(targets, results):
            if isinstance(res, BaseException):
                # A dead socket: its handler's finally block removes the peer
                # too, but don't wait for that to keep it out of the next send.
                self.peers.pop(peer.client, None)


def join(ws: str, page_id: str, peer: Peer) -> Room:
    global _loop
    _loop = asyncio.get_running_loop()
    room = _rooms.setdefault((ws, page_id), Room((ws, page_id)))
    room.peers[peer.client] = peer
    return room


def leave(room: Room, client: str) -> None:
    room.peers.pop(client, None)
    if not room.peers:
        _rooms.pop(room.key, None)


def room_for(ws: str, page_id: str) -> Room | None:
    return _rooms.get((ws, page_id))


def _schedule(coro) -> None:
    """Run a coroutine on the sockets' loop from anywhere."""
    if _loop is None or _loop.is_closed():
        coro.close()
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is _loop:
        _loop.create_task(coro)
    else:
        asyncio.run_coroutine_threadsafe(coro, _loop)


def publish(ws: str, page_id: str, message: dict, exclude: str = "") -> None:
    """Send ``message`` to everyone in the page's room (no room → no-op)."""
    room = _rooms.get((ws, page_id))
    if not room or not room.peers:
        return
    try:
        _schedule(room.broadcast(json.dumps(message), exclude))
    except Exception as e:  # never let a fan-out failure break the write
        log.warning(f"[collab] publish failed: {e}")


def publish_ops(ws: str, result: dict) -> None:
    """Fan out an applied batch (the dict ``ops.apply_ops`` returns)."""
    publish(ws, result["page_id"], {
        "t": "ops", "seq": result["seq"], "at": result["at"],
        "actor": result["actor"], "client": result["client"], "ops": result["ops"],
    })


def publish_reload(ws: str, page_id: str, seq: int | None = None) -> None:
    """Tell the room the page changed in a way ops can't express (a whole
    subtree replace, an import): clients refetch the tree."""
    publish(ws, page_id, {"t": "reload", "seq": seq})


def publish_all(ws: str, message: dict) -> None:
    """Every room of one workspace (library-wide rewrites)."""
    for key in list(_rooms):
        if key[0] == ws:
            publish(ws, key[1], message)
