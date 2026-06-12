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

## Prototype networking

WebRTC offer and answer signaling currently uses `BroadcastChannel`, which
connects tabs on the same origin. A production deployment needs a signaling
service plus STUN/TURN configuration for peers on different devices and
networks.
