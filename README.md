# Common Ground

An anonymous ranked-choice voting prototype using WebRTC data channels and a
single-winner transferable vote count.

## Features

- Drag-to-rank ballot
- Peer-to-peer ballot sharing through WebRTC data channels
- Single transferable vote elimination and transfer rounds
- Transparent round-by-round results
- Responsive light and dark themes

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
