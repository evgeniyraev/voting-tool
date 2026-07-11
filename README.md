# Common Ground

An anonymous ranked-choice voting prototype using WebRTC data channels and a
single-winner transferable vote count.

## Features

- Host-defined votes: the room creator sets the question and the options
- Drag-to-rank ballot
- Peer-to-peer ballot sharing through WebRTC data channels
- Single transferable vote elimination and transfer rounds
- Host-only vote counting with automatic result reveal
- Transparent round-by-round results
- Responsive light and dark themes

## Wire protocol (v2)

Peers exchange JSON messages over PeerJS data connections opened with
`{ reliable: true, serialization: "json" }` (native clients such as the
Tiny Tribunal iOS app speak the same protocol):

- `{ "type": "room-info", "topic": string, "candidates": [{ "id", "name", "detail", "icon", "color" }] }`
  — sent by the host when the vote is defined; only the host is trusted for it.
- `{ "type": "sync", "room": RoomInfo | null, "ballots": [Ballot], "peerIds": [string] }`
  — sent by both sides when a connection opens; merges ballots, introduces
  peers for the mesh, and carries the room definition for late joiners.
- `{ "type": "ballot", "peerId": string, "ranking": [candidateId] }`
  — one per voter, deduplicated by `peerId`, re-broadcast to the mesh.
- `{ "type": "count-results" }` — host tells peers to reveal the local count.

Guests joining before the host defines the vote see a waiting placeholder
until `room-info` arrives.

## Run locally

```sh
python3 -m http.server 4173
```

Open `http://127.0.0.1:4173`.

## Invite others

Open the app and click **Copy invite**. Anyone opening that room link can join
from another browser or device while the room host remains online.

Keep the original host tab open until voting and counting are finished. If the
host closes the room, new participants cannot join through its invite link.

The static GitHub Pages frontend uses the hosted PeerJS signaling service to
introduce room participants. Ballots are exchanged directly between browsers
over encrypted WebRTC data channels and are not stored by this app.

This is still a prototype. For high-stakes elections, use an authenticated
signaling service, a dedicated TURN service, durable encrypted ballot storage,
and independent security review.

## Apple App Clip / Universal Links

`.well-known/apple-app-site-association` associates this tool with the
Tiny Tribunal iOS app so invite links can open the app or its App Clip.
Two deployment caveats:

1. The file must be served from the **domain root**
   (`https://zerogravityroom.github.io/.well-known/apple-app-site-association`).
   For GitHub *project* pages that means copying it into the
   `zerogravityroom/zerogravityroom.github.io` user-site repository — the copy in this
   repo is the source of truth, not the deployed location.
2. GitHub Pages serves extensionless files as `application/octet-stream`;
   Apple's CDN expects `application/json`. If App Clip cards never appear,
   host the site on Cloudflare Pages or Netlify where the content type can be
   controlled.

The file carries team id `4F5J749858` and bundle id
`com.zerogravityroom.tinytribunal` — keep it in sync with the app project's
`Config.xcconfig`. Uncomment the `apple-itunes-app` meta tag in `index.html`
once the app is on the App Store.

## Learn more about ranked-choice voting

The "how it works" panels (ballot and suggest views) and the page footer link
out to a short explainer of the counting method — reachable, but out of the
main flow:

- Single transferable vote — <https://en.wikipedia.org/wiki/Single_transferable_vote>
- Video explainer — <https://youtu.be/l8XOZJkozfI>
