// Who else is on the page (collab.js `peers`): the avatar stack in the page
// header, and the small chips on the block a person is on. Colours are the
// room's per-peer index (CSS --peer-N); an open editor shows as a full
// avatar, a mere viewer as a faded one.
import React from "react";

function initial(peer) {
  const name = (peer?.name || "").trim();
  return name && name !== "Anonymous" ? name[0].toUpperCase() : "?";
}

function describe(peer) {
  const what = peer.anchor >= 0 ? "editing" : peer.block ? "on a block" : "viewing";
  return `${peer.name || "Anonymous"} · ${what}`;
}

export function PeerAvatar({ peer, onClick, title }) {
  return (
    <span
      className={`peerAvatar peer-${peer.color % 8}${peer.anchor >= 0 ? "" : " viewing"}`}
      title={title || describe(peer)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >{initial(peer)}</span>
  );
}

// Chips on a block row: up to three avatars, then a "+n".
export function PeerChips({ peers }) {
  if (!peers?.length) return null;
  const shown = peers.slice(0, 3);
  return (
    <span className="peerChips" aria-hidden="true">
      {shown.map((p) => <PeerAvatar key={p.client} peer={p} />)}
      {peers.length > shown.length ? <span className="peerMore">+{peers.length - shown.length}</span> : null}
    </span>
  );
}

// The header stack; clicking an avatar jumps to that person's block.
export function PresenceBar({ peers, onJump }) {
  if (!peers?.length) return null;
  return (
    <span className="presenceBar" aria-label="People on this page">
      {peers.map((p) => (
        <PeerAvatar
          key={p.client}
          peer={p}
          title={`${describe(p)}${p.block ? " — click to jump" : ""}`}
          onClick={p.block && onJump ? () => onJump(p.block) : undefined}
        />
      ))}
    </span>
  );
}
