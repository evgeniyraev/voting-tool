const SAMPLE_TOPIC = "Friday team lunch";
const SAMPLE_OPTIONS = [
  { name: "Greenhouse Café", detail: "Seasonal plates · 12 min walk" },
  { name: "Little Italy", detail: "Pasta & pizza · 8 min walk" },
  { name: "Noodle Club", detail: "Asian comfort food · 15 min walk" },
  { name: "The Harbor Room", detail: "Seafood & grill · 10 min walk" },
  { name: "Park Picnic", detail: "Bring-your-own · 5 min walk" },
];
const OPTION_ICONS = ["🌿", "🍅", "🍜", "⚓", "☀️", "🎯", "🎲", "🌸", "🔥", "🍀", "🥑", "🎧"];
const OPTION_COLORS = ["#d9edc5", "#f4d4c2", "#f3dfb4", "#cadde9", "#eee4a9", "#e3d1ec", "#cfe8dd", "#f2cdd5"];

const state = {
  ballots: [],
  dragging: null,
  peers: new Map(),
  peer: null,
  peerId: null,
  hostId: null,
  roomCode: null,
  isHost: false,
  /** { topic, candidates: [{ id, name, detail, icon, color }] } — null until the host defines the vote. */
  room: null,
  /** Staged rooms: { mode: "staged", topic, stage: "suggest"|"vote"|"results" } — null in classic rooms. */
  config: null,
  suggestions: [],
  ready: new Set(),
  /** Non-host peers that have acted (suggested / readied / voted). */
  actors: new Set(),
  revealed: false,
};

/** Messages re-broadcast into the mesh when they carried new information. */
const RELAY_TYPES = new Set(["ballot", "suggestion", "ready"]);

const candidateList = document.querySelector("#candidateList");
const ballotPlaceholder = document.querySelector("#ballotPlaceholder");
const submitVoteButton = document.querySelector("#submitVote");
const toast = document.querySelector("#toast");
const connectionStatus = document.querySelector("#connectionStatus");
const copyRoomButton = document.querySelector("#copyRoom");
const showQrButton = document.querySelector("#showQr");
const qrDialog = document.querySelector("#qrDialog");
const qrCode = document.querySelector("#qrCode");
const optionRows = document.querySelector("#optionRows");
const suggestionList = document.querySelector("#suggestionList");
const suggestEmpty = document.querySelector("#suggestEmpty");
const readyToggle = document.querySelector("#readyToggle");
const readyMeter = document.querySelector("#readyMeter");
const startVoteNow = document.querySelector("#startVoteNow");
const HOST_STORAGE_KEY = "common-ground-host-id";
let selectedMode = "classic";
/** True while this client is racing other clients for an abandoned host id. */
let claimingHostId = false;
/** Bounded so a permanently unreachable room stops flip-flopping roles. */
let takeoverAttempts = 0;
const MAX_TAKEOVER_ATTEMPTS = 6;
/** Generous: a real host behind TURN can take several seconds to open. */
const HOST_CONNECT_TIMEOUT_MS = 10000;
let createViewRendered = false;

function candidates() {
  return state.room ? state.room.candidates : [];
}

function findCandidate(id) {
  return candidates().find((candidate) => candidate.id === id);
}

function randomRoomCode() {
  const words = ["LIME", "MINT", "SAGE", "FERN", "PINE", "MOSS"];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(100 + Math.random() * 900)}`;
}

function readRoomLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.roomCode = params.get("room") || randomRoomCode();
  state.hostId = params.get("host");
  state.isHost = !state.hostId || sessionStorage.getItem(HOST_STORAGE_KEY) === state.hostId;
  if (!state.hostId) {
    state.hostId = `common-ground-${crypto.randomUUID()}`;
    sessionStorage.setItem(HOST_STORAGE_KEY, state.hostId);
  }
  document.querySelector("#roomCode").textContent = state.roomCode.replace("-", "–");
}

function writeRoomLink() {
  const params = new URLSearchParams({ room: state.roomCode, host: state.hostId });
  history.replaceState(null, "", `${location.pathname}${location.search}#${params}`);
}

function applyRoom(room) {
  if (state.room || !room || !Array.isArray(room.candidates) || room.candidates.length < 2) return;
  state.room = { topic: room.topic || "Group decision", candidates: room.candidates };
  document.querySelector("#roomName").textContent = state.room.topic;
  renderCandidates();
}

function applyConfig(config) {
  if (state.config || !config || config.mode !== "staged") return;
  state.config = {
    mode: "staged",
    topic: config.topic || "Group decision",
    stage: config.stage || "suggest",
    generation: config.generation || 1,
  };
  document.querySelector("#roomName").textContent = state.config.topic;
  document.querySelector("#suggestTopic").textContent = state.config.topic;
  if (state.config.stage === "suggest") switchView("suggest");
  renderSuggestions();
  updateReadyMeter();
}

function configGeneration() {
  return state.config ? state.config.generation || 1 : 1;
}

/** Clears every trace of the current vote — the room itself stays open. */
function resetVoteState() {
  state.ballots = [];
  state.suggestions = [];
  state.ready = new Set();
  state.actors = new Set();
  state.room = null;
  state.revealed = false;
}

/** Protocol v4: the host abandoned the current vote and reopened the room at
 *  the suggest stage with a higher generation. */
function applyNewVote(config) {
  if (!config || config.mode !== "staged") return;
  const incoming = config.generation || 1;
  if (state.config && incoming <= configGeneration()) return;
  resetVoteState();
  state.config = {
    mode: "staged",
    topic: config.topic || "Group decision",
    stage: config.stage || "suggest",
    generation: incoming,
  };
  document.querySelector("#roomName").textContent = state.config.topic;
  document.querySelector("#suggestTopic").textContent = state.config.topic;
  renderCandidates();
  renderSuggestions();
  updateReadyMeter();
  updateWaiting();
  switchView(state.config.stage === "suggest" ? "suggest" : "ballot");
  showToast("The host started a new vote — suggest your ideas!");
}

function enterVotingStage() {
  if (!state.config || state.config.stage === "vote") return;
  state.config.stage = "vote";
  if (state.room && !state.ballots.some((ballot) => ballot.peerId === state.peerId)) {
    switchView("ballot");
    showToast("Everyone's ready — rank the options!");
  }
}

// MARK: Staged rooms — roster & readiness

function rosterIds() {
  const ids = new Set(state.actors);
  state.peers.forEach((connection, peerId) => {
    if (connection.open) ids.add(peerId);
  });
  if (!state.isHost && state.peerId) ids.add(state.peerId);
  ids.delete(state.hostId);
  return ids;
}

function allReady() {
  const roster = rosterIds();
  return roster.size > 0 && [...roster].every((peerId) => state.ready.has(peerId));
}

function uniqueSuggestionCandidates() {
  const seen = new Set();
  const unique = state.suggestions.filter((suggestion) => {
    const key = suggestion.name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const taken = new Set();
  return unique.map((suggestion, index) => ({
    id: slugify(suggestion.name, taken),
    name: suggestion.name.trim(),
    detail: (suggestion.detail || "").trim(),
    icon: OPTION_ICONS[index % OPTION_ICONS.length],
    color: OPTION_COLORS[index % OPTION_COLORS.length],
  }));
}

function renderSuggestions() {
  if (!suggestionList) return;
  suggestEmpty.hidden = state.suggestions.length > 0;
  suggestionList.innerHTML = "";
  state.suggestions.forEach((suggestion, index) => {
    const item = document.createElement("li");
    item.className = "candidate suggestion";
    const art = document.createElement("span");
    art.className = "candidate-art";
    art.style.setProperty("--candidate", OPTION_COLORS[index % OPTION_COLORS.length]);
    art.textContent = OPTION_ICONS[index % OPTION_ICONS.length];
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = suggestion.name;
    const detail = document.createElement("small");
    detail.textContent = suggestion.detail || "";
    text.append(title, detail);
    item.append(art, text);
    suggestionList.appendChild(item);
  });
}

function updateReadyMeter() {
  if (!readyMeter) return;
  const roster = rosterIds();
  const readyCount = [...roster].filter((peerId) => state.ready.has(peerId)).length;
  readyMeter.textContent = roster.size
    ? `${readyCount} of ${roster.size} ready · voting starts when everyone is`
    : "Share the invite — voting starts when everyone is ready";
  const mine = state.ready.has(state.peerId);
  readyToggle.querySelector("span").textContent = mine ? "Ready — waiting for the others" : "I'm ready to vote";
  readyToggle.classList.toggle("is-ready", mine);
  if (state.isHost) {
    startVoteNow.disabled = uniqueSuggestionCandidates().length < 2;
  }
}

function maybeAutoStartVote() {
  if (!state.isHost || !state.config || state.config.stage !== "suggest") return;
  if (allReady() && uniqueSuggestionCandidates().length >= 2) startVote();
}

function startVote() {
  if (!state.isHost || !state.config || state.config.stage !== "suggest") return;
  const candidates = uniqueSuggestionCandidates();
  if (candidates.length < 2) return showToast("Need at least two distinct suggestions");
  applyRoom({ topic: state.config.topic, candidates });
  state.config.stage = "vote";
  sendToAll({ type: "room-info", topic: state.room.topic, candidates: state.room.candidates });
  sendToAll({ type: "stage", stage: "vote" });
  switchView("ballot");
}

function maybeAutoReveal() {
  if (!state.isHost || !state.config || state.config.stage !== "vote" || state.revealed) return;
  const roster = rosterIds();
  const voted = new Set(state.ballots.map((ballot) => ballot.peerId));
  if (roster.size > 0 && [...roster].every((peerId) => voted.has(peerId)) && voted.has(state.peerId)) {
    renderResults(true);
  }
}

function renderCandidates() {
  const items = candidates();
  ballotPlaceholder.hidden = items.length > 0;
  submitVoteButton.disabled = items.length === 0;
  candidateList.innerHTML = "";
  items.forEach((candidate) => {
    const item = document.createElement("li");
    item.className = "candidate";
    item.draggable = matchMedia("(hover: hover) and (pointer: fine)").matches;
    item.dataset.id = candidate.id;
    item.innerHTML = `
      <span class="candidate-art" style="--candidate: ${candidate.color}">${candidate.icon}</span>
      <div><strong></strong><small></small></div>
      <span class="support">Rank this choice</span>
      <span class="handle">⠿</span>
    `;
    item.querySelector("strong").textContent = candidate.name;
    item.querySelector("small").textContent = candidate.detail || "";
    const handle = item.querySelector(".handle");
    item.addEventListener("dragstart", () => {
      state.dragging = item;
      requestAnimationFrame(() => item.classList.add("dragging"));
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      state.dragging = null;
    });
    handle.addEventListener("pointerdown", (event) => startPointerDrag(event, item));
    candidateList.appendChild(item);
  });
}

function findDropTarget(clientY) {
  return [...candidateList.querySelectorAll(".candidate:not(.dragging):not(.touch-placeholder)")].find((item) => {
    const box = item.getBoundingClientRect();
    return clientY < box.top + box.height / 2;
  });
}

function movePlaceholder(item, target) {
  if (target === item.nextElementSibling || (!target && item === candidateList.lastElementChild)) return;
  const positions = new Map(
    [...candidateList.children].map((candidate) => [candidate, candidate.getBoundingClientRect().top]),
  );
  candidateList.insertBefore(item, target);
  [...candidateList.children].forEach((candidate) => {
    const offset = positions.get(candidate) - candidate.getBoundingClientRect().top;
    if (!offset) return;
    candidate.style.transition = "none";
    candidate.style.transform = `translateY(${offset}px)`;
    requestAnimationFrame(() => {
      candidate.style.transition = "";
      candidate.style.transform = "";
    });
  });
}

function startPointerDrag(event, item) {
  if (event.pointerType === "mouse") return;
  event.preventDefault();
  state.dragging = item;
  const pointerId = event.pointerId;
  const box = item.getBoundingClientRect();
  const fingerOffsetY = event.clientY - box.top;
  const preview = item.cloneNode(true);

  item.classList.add("touch-placeholder");
  preview.classList.add("touch-preview");
  preview.removeAttribute("draggable");
  preview.style.width = `${box.width}px`;
  preview.style.left = `${box.left}px`;
  preview.style.top = `${event.clientY - fingerOffsetY}px`;
  document.body.appendChild(preview);

  const move = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    moveEvent.preventDefault();
    preview.style.top = `${moveEvent.clientY - fingerOffsetY}px`;
    movePlaceholder(item, findDropTarget(moveEvent.clientY) || null);
    if (moveEvent.clientY < 90) window.scrollBy(0, -12);
    if (moveEvent.clientY > window.innerHeight - 90) window.scrollBy(0, 12);
  };
  const end = (endEvent) => {
    if (endEvent.pointerId !== pointerId) return;
    item.classList.remove("touch-placeholder");
    preview.remove();
    state.dragging = null;
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
  };

  document.addEventListener("pointermove", move, { passive: false });
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}

candidateList.addEventListener("dragover", (event) => {
  if (!state.dragging) return;
  event.preventDefault();
  candidateList.insertBefore(state.dragging, findDropTarget(event.clientY) || null);
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

function switchView(view) {
  document.body.classList.toggle("creating", view === "create" || view === "suggest");
  document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
  document.querySelector(`#${view}View`).classList.add("active");
  document.querySelectorAll(".progress-step").forEach((step) => {
    step.classList.toggle("active", step.dataset.view === view);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function currentBallot() {
  return [...candidateList.querySelectorAll(".candidate")].map((item) => item.dataset.id);
}

/** Applies a message; returns true when it carried new information (and, for
 *  RELAY_TYPES, should be re-broadcast into the mesh). */
function receivePeerMessage(message, senderId = null) {
  if (message.type === "ballot") {
    if (state.ballots.some((ballot) => ballot.peerId === message.peerId)) return false;
    state.ballots.push({ peerId: message.peerId, ranking: message.ranking });
    state.actors.add(message.peerId);
    updateWaiting();
    showToast("An anonymous peer submitted a ballot");
    maybeAutoReveal();
    return true;
  }
  if (message.type === "room-info" && senderId === state.hostId && !state.isHost) {
    applyRoom({ topic: message.topic, candidates: message.candidates });
    return false;
  }
  if (message.type === "room-config" && senderId === state.hostId && !state.isHost) {
    applyConfig(message);
    return false;
  }
  if (message.type === "suggestion") {
    if (state.room || state.suggestions.some((existing) => existing.id === message.id)) return false;
    state.suggestions.push({ id: message.id, peerId: message.peerId, name: message.name, detail: message.detail || "" });
    state.actors.add(message.peerId);
    renderSuggestions();
    updateReadyMeter();
    maybeAutoStartVote();
    return true;
  }
  if (message.type === "ready") {
    const has = state.ready.has(message.peerId);
    if (message.ready === has) return false;
    if (message.ready) state.ready.add(message.peerId);
    else state.ready.delete(message.peerId);
    state.actors.add(message.peerId);
    updateReadyMeter();
    maybeAutoStartVote();
    return true;
  }
  if (message.type === "stage" && senderId === state.hostId && !state.isHost) {
    if (message.stage === "vote") enterVotingStage();
    return false;
  }
  if (message.type === "new-vote" && senderId === state.hostId && !state.isHost) {
    applyNewVote(message);
    return false;
  }
  if (message.type === "sync") {
    // v4: a peer already following a restarted vote — reset before ingesting.
    const incomingGeneration = message.config ? message.config.generation || 1 : 1;
    if (!state.isHost && state.config && incomingGeneration > configGeneration()) {
      applyNewVote(message.config);
    }
    // Stale peers that missed a restart must not re-inject the old vote.
    const staleVote = incomingGeneration < configGeneration();
    if (!staleVote) {
      if (message.room && !state.isHost) applyRoom(message.room);
      if (message.config && !state.isHost) applyConfig(message.config);
      message.ballots.forEach((ballot) => {
        if (!state.ballots.some((existing) => existing.peerId === ballot.peerId)) {
          state.ballots.push(ballot);
          state.actors.add(ballot.peerId);
        }
      });
      (message.suggestions || []).forEach((suggestion) => {
        if (!state.suggestions.some((existing) => existing.id === suggestion.id)) {
          state.suggestions.push(suggestion);
          state.actors.add(suggestion.peerId);
        }
      });
      (message.readyPeerIds || []).forEach((peerId) => state.ready.add(peerId));
    }
    message.peerIds.forEach((peerId) => {
      if (peerId !== state.peerId && !state.peers.has(peerId)) connectToPeer(peerId);
    });
    updateWaiting();
    renderSuggestions();
    updateReadyMeter();
    return false;
  }
  if (message.type === "count-results" && senderId === state.hostId) {
    renderResults(false);
  }
  return false;
}

function sendToAll(message, exceptPeerId = null) {
  state.peers.forEach((connection, peerId) => {
    if (peerId !== exceptPeerId && connection.open) connection.send(message);
  });
}

function updatePeerCount() {
  const connected = [...state.peers.values()].filter((connection) => connection.open).length + 1;
  document.querySelector("#peerCount").textContent = connected;
  document.querySelector(".peer-row p").lastChild.textContent =
    ` anonymous peer${connected === 1 ? "" : "s"} connected`;
}

/** PeerJS does not emit "close" when a peer's page simply goes away, so a
 *  vanished host would otherwise look connected forever. The ICE transport
 *  giving up is the signal that actually arrives. */
function watchIceState(connection, onLost) {
  const pc = connection.peerConnection;
  if (!pc) return;
  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState !== "failed" && pc.iceConnectionState !== "closed") return;
    connection.close();
    onLost();
  });
}

function registerConnection(connection) {
  if (state.peers.has(connection.peer)) return;
  state.peers.set(connection.peer, connection);
  const dropped = () => {
    if (!state.peers.has(connection.peer)) return;
    state.peers.delete(connection.peer);
    updatePeerCount();
    updateReadyMeter();
    maybeAutoStartVote();
    maybeAutoReveal();
    // The host left the room behind — claim it so the vote can carry on.
    if (!state.isHost && connection.peer === state.hostId) attemptHostTakeover();
  };
  connection.on("open", () => {
    connection.send({
      type: "sync",
      room: state.room,
      config: state.config,
      suggestions: state.suggestions,
      readyPeerIds: [...state.ready],
      ballots: state.ballots,
      peerIds: [state.hostId, ...state.peers.keys()].filter(Boolean),
    });
    updatePeerCount();
    updateReadyMeter();
    watchIceState(connection, dropped);
  });
  connection.on("data", (message) => {
    const carriedNews = receivePeerMessage(message, connection.peer);
    if (carriedNews && RELAY_TYPES.has(message.type)) sendToAll(message, connection.peer);
  });
  connection.on("close", dropped);
  connection.on("error", dropped);
}

function connectToPeer(peerId) {
  if (!peerId || peerId === state.peerId || state.peers.has(peerId)) return;
  const connection = state.peer.connect(peerId, { reliable: true, serialization: "json" });
  registerConnection(connection);
  if (state.isHost || peerId !== state.hostId) return;
  // A host that left keeps its id registered on the signalling server for a
  // while, so dialling it is accepted and then silently never opens — no
  // "peer-unavailable" ever arrives. A host that never answers is an empty
  // room too, so time the dial out and claim it.
  setTimeout(() => {
    if (connection.open || state.isHost) return;
    state.peers.delete(peerId);
    updatePeerCount();
    attemptHostTakeover();
  }, HOST_CONNECT_TIMEOUT_MS);
}

/** Tears the signalling peer down so setupPeerChannel can rebuild it in the
 *  other role. Peer ids are released as soon as the peer is destroyed. */
function restartPeerChannel(asHost) {
  if (state.peer) state.peer.destroy();
  state.peers.clear();
  state.peer = null;
  state.peerId = null;
  state.isHost = asHost;
  if (!asHost) configureRoleUI();
  updatePeerCount();
  // Out of the current error/close handler before rebuilding.
  setTimeout(setupPeerChannel, 0);
}

/** Nobody is holding this room's host id, so the room is empty: claim the id
 *  ourselves. The invite link keeps working and later joiners land on us. */
function attemptHostTakeover() {
  if (state.isHost || claimingHostId) return;
  if (takeoverAttempts >= MAX_TAKEOVER_ATTEMPTS) return showHostOffline();
  claimingHostId = true;
  connectionStatus.textContent = "Claiming room";
  // A host that never showed up leaves its id free, so the first try lands
  // immediately. A host that *left* keeps its id reserved on the signalling
  // server for a while, so back off and let the reservation lapse. The jitter
  // also stops several waiting clients from all grabbing at the same instant.
  const delay = Math.min(500 * 2 ** takeoverAttempts, 16000) + Math.random() * 800;
  takeoverAttempts += 1;
  setTimeout(() => restartPeerChannel(true), delay);
}

/** Promotion succeeded — surface the host controls this client never had. */
function finishHostTakeover() {
  claimingHostId = false;
  configureRoleUI();
  if (state.room || state.config) {
    showToast("The host left — you are hosting this room now");
    return;
  }
  document.querySelector("#roomName").textContent = "Your room";
  if (!createViewRendered) {
    createViewRendered = true;
    renderCreateView();
  }
  switchView("create");
  showToast("This room was empty — you are hosting it now");
}

function showHostOffline() {
  claimingHostId = false;
  connectionStatus.textContent = "Host offline";
  copyRoomButton.disabled = false;
  copyRoomButton.textContent = "Start new room";
  showQrButton.disabled = true;
  showToast("Room host is no longer online");
}

function setupPeerChannel() {
  if (!window.Peer) {
    connectionStatus.textContent = "Offline";
    showToast("Could not load the room service");
    return;
  }
  state.peer = new Peer(state.isHost ? state.hostId : undefined);
  state.peer.on("open", (peerId) => {
    state.peerId = peerId;
    if (state.isHost) {
      state.hostId = peerId;
      sessionStorage.setItem(HOST_STORAGE_KEY, peerId);
      writeRoomLink();
      if (claimingHostId) finishHostTakeover();
    } else {
      connectToPeer(state.hostId);
    }
    connectionStatus.textContent = "Live";
    copyRoomButton.disabled = false;
    copyRoomButton.textContent = "Copy invite";
    showQrButton.disabled = false;
    updatePeerCount();
  });
  state.peer.on("connection", registerConnection);
  state.peer.on("disconnected", () => {
    connectionStatus.textContent = "Reconnecting";
    state.peer.reconnect();
  });
  state.peer.on("error", (error) => {
    if (error.type === "peer-unavailable") {
      // Drop the connection that never opened, so a later retry can dial the
      // same id again instead of being deduped against this dead entry.
      state.peers.delete(state.hostId);
      updatePeerCount();
      // The room has no host online — take it over instead of dead-ending.
      attemptHostTakeover();
    } else if (error.type === "unavailable-id") {
      // The id is still registered: either another client won the race we just
      // started, or the broker has not yet released a departed host's id. Fall
      // back to joining — a real host answers, a stale registration times out
      // in connectToPeer and brings us back here on a longer backoff.
      claimingHostId = false;
      sessionStorage.removeItem(HOST_STORAGE_KEY);
      restartPeerChannel(false);
    } else {
      connectionStatus.textContent = "Connection issue";
      showToast("Could not connect to the room");
    }
  });
}

function configureRoleUI() {
  const countButton = document.querySelector("#countNow");
  const resultsStep = document.querySelector("#resultsStep");
  const restartButton = document.querySelector("#restartVote");
  countButton.hidden = !state.isHost;
  restartButton.hidden = !state.isHost;
  document.querySelector("#newVote").hidden = !state.isHost;
  resultsStep.disabled = !state.isHost;
  if (!state.isHost) {
    document.querySelector("#waitingMessage").textContent =
      "Your anonymous ballot is locked in. The inviter will reveal the result when voting is complete.";
    document.querySelector("#roomName").textContent = "Waiting for the host…";
  }
}

function startNewRoom() {
  sessionStorage.removeItem(HOST_STORAGE_KEY);
  location.hash = "";
  location.reload();
}

// MARK: Host vote creation

function slugify(name, taken) {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "option";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function addOptionRow(name = "", detail = "") {
  const row = document.createElement("div");
  row.className = "option-row";
  row.innerHTML = `
    <span class="option-icon"></span>
    <input class="option-name" type="text" maxlength="60" placeholder="Option name" />
    <input class="option-detail" type="text" maxlength="80" placeholder="Detail (optional)" />
    <button class="option-remove" type="button" aria-label="Remove option">×</button>
  `;
  const nameInput = row.querySelector(".option-name");
  nameInput.value = name;
  nameInput.addEventListener("paste", (event) => spreadPastedLines(nameInput, event));
  row.querySelector(".option-detail").value = detail;
  row.querySelector(".option-remove").addEventListener("click", () => {
    row.remove();
    refreshOptionIcons();
  });
  optionRows.appendChild(row);
  refreshOptionIcons();
  return row;
}

/** "- pizza", "• pizza", "3. pizza" → "pizza"; plain lines pass through. */
function stripListMarker(line) {
  return line.trim().replace(/^(?:[-–—•*]\s+|\d+[.)]\s*)/, "");
}

/** Pasting a multi-line list into an option name fills the ballot: the first
 *  line stays in this row, the rest fill the empty rows below (inserting new
 *  ones as needed) so the pasted order is kept. */
function spreadPastedLines(input, event) {
  const text = event.clipboardData?.getData("text") ?? "";
  if (!/[\r\n]/.test(text)) return; // single-line paste: default behavior
  event.preventDefault();
  const merged = input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
  const lines = merged.split(/[\r\n]+/).map(stripListMarker).filter(Boolean)
    .map((line) => line.slice(0, input.maxLength));
  input.value = lines.shift() ?? "";
  let anchor = input.closest(".option-row");
  for (const line of lines) {
    const next = anchor.nextElementSibling;
    if (next && !next.querySelector(".option-name").value && !next.querySelector(".option-detail").value) {
      next.querySelector(".option-name").value = line;
      anchor = next;
    } else {
      const inserted = addOptionRow(line);
      anchor.after(inserted);
      anchor = inserted;
    }
  }
  refreshOptionIcons();
}

function refreshOptionIcons() {
  [...optionRows.querySelectorAll(".option-icon")].forEach((icon, index) => {
    icon.textContent = OPTION_ICONS[index % OPTION_ICONS.length];
    icon.style.setProperty("--candidate", OPTION_COLORS[index % OPTION_COLORS.length]);
  });
}

function renderCreateView() {
  document.querySelector("#createTopic").value = SAMPLE_TOPIC;
  SAMPLE_OPTIONS.forEach((option) => addOptionRow(option.name, option.detail));
}

function startStagedRoom(topic) {
  state.config = { mode: "staged", topic, stage: "suggest", generation: 1 };
  document.querySelector("#roomName").textContent = topic;
  document.querySelector("#suggestTopic").textContent = topic;
  readyToggle.hidden = true; // the host starts the vote instead of readying
  startVoteNow.hidden = false;
  sendToAll({ type: "room-config", mode: "staged", topic, stage: "suggest", generation: 1 });
  renderSuggestions();
  updateReadyMeter();
  switchView("suggest");
}

/** Host: abandon the current vote and reopen the same room at the suggest
 *  stage (protocol v4) — every connected peer follows along. */
function hostStartNewVote(topic) {
  if (!state.isHost) return;
  const generation = configGeneration() + 1;
  resetVoteState();
  state.config = { mode: "staged", topic, stage: "suggest", generation };
  document.querySelector("#roomName").textContent = topic;
  document.querySelector("#suggestTopic").textContent = topic;
  readyToggle.hidden = true;
  startVoteNow.hidden = false;
  sendToAll({ type: "new-vote", mode: "staged", topic, stage: "suggest", generation });
  renderCandidates();
  renderSuggestions();
  updateReadyMeter();
  updateWaiting();
  switchView("suggest");
}

function submitSuggestion() {
  const nameInput = document.querySelector("#suggestName");
  const detailInput = document.querySelector("#suggestDetail");
  const name = nameInput.value.trim();
  if (!name || !state.config || state.config.stage !== "suggest") return;
  const peerId = state.peerId || state.hostId;
  const suggestion = { id: `sug-${crypto.randomUUID()}`, peerId, name, detail: detailInput.value.trim() };
  state.suggestions.push(suggestion);
  state.actors.add(peerId);
  sendToAll({ type: "suggestion", ...suggestion });
  nameInput.value = "";
  detailInput.value = "";
  nameInput.focus();
  renderSuggestions();
  updateReadyMeter();
  maybeAutoStartVote();
}

function toggleReady() {
  if (!state.peerId) return showToast("Wait for the room to finish connecting");
  const next = !state.ready.has(state.peerId);
  if (next) state.ready.add(state.peerId);
  else state.ready.delete(state.peerId);
  state.actors.add(state.peerId);
  sendToAll({ type: "ready", peerId: state.peerId, ready: next });
  updateReadyMeter();
}

function startRoom() {
  const topic = document.querySelector("#createTopic").value.trim() || "Group decision";
  if (selectedMode === "staged") return startStagedRoom(topic);
  const taken = new Set();
  const roomCandidates = [...optionRows.querySelectorAll(".option-row")]
    .map((row, index) => ({
      name: row.querySelector(".option-name").value.trim(),
      detail: row.querySelector(".option-detail").value.trim(),
      icon: OPTION_ICONS[index % OPTION_ICONS.length],
      color: OPTION_COLORS[index % OPTION_COLORS.length],
    }))
    .filter((option) => option.name)
    .map((option) => ({ id: slugify(option.name, taken), ...option }));
  if (roomCandidates.length < 2) return showToast("Add at least two options to vote on");

  applyRoom({ topic, candidates: roomCandidates });
  sendToAll({ type: "room-info", topic: state.room.topic, candidates: state.room.candidates });
  switchView("ballot");
}

function submitBallot() {
  if (!state.peerId) return showToast("Wait for the room to finish connecting");
  if (!state.room) return showToast("The host hasn't started the vote yet");
  if (state.ballots.some((ballot) => ballot.peerId === state.peerId)) return;
  const ranking = currentBallot();
  state.ballots.push({ peerId: state.peerId, ranking });
  sendToAll({ type: "ballot", peerId: state.peerId, ranking });
  updateWaiting();
  switchView("waiting");
}

function updateWaiting() {
  const count = state.ballots.length;
  document.querySelector("#waitingCount").textContent = count;
  updatePeerCount();
}

function countSTV(ballots) {
  const active = new Set(candidates().map((candidate) => candidate.id));
  const rounds = [];
  const majority = Math.floor(ballots.length / 2) + 1;

  while (active.size > 1) {
    const counts = Object.fromEntries([...active].map((id) => [id, 0]));
    ballots.forEach(({ ranking }) => {
      const choice = ranking.find((id) => active.has(id));
      if (choice) counts[choice] += 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const winner = sorted.find(([, count]) => count >= majority);
    if (winner) {
      rounds.push({ counts, eliminated: null });
      return { winner: winner[0], votes: winner[1], majority, rounds };
    }
    const lowest = Math.min(...Object.values(counts));
    const eliminated = [...Object.keys(counts)].reverse().find((id) => counts[id] === lowest);
    rounds.push({ counts, eliminated });
    active.delete(eliminated);
  }

  const winner = [...active][0];
  const finalCount = ballots.filter(({ ranking }) => ranking.find((id) => active.has(id)) === winner).length;
  return { winner, votes: finalCount, majority, rounds };
}

function renderResults(announce = false) {
  if (!state.ballots.length) return showToast("No ballots have been submitted yet");
  if (!state.room) return showToast("The vote hasn't been defined yet");
  if (announce && !state.isHost) return showToast("Only the inviter can count votes");
  const result = countSTV(state.ballots);
  const winner = findCandidate(result.winner);
  document.querySelector("#winnerName").textContent = winner.name;
  document.querySelector("#winnerVotes").textContent = result.votes;
  document.querySelector("#winnerPercent").textContent = `${Math.round(result.votes / state.ballots.length * 100)}%`;
  document.querySelector("#winnerDetail").textContent =
    `Won after ${result.rounds.length} round${result.rounds.length === 1 ? "" : "s"} with broad support across the group.`;

  const roundsList = document.querySelector("#roundsList");
  roundsList.innerHTML = "";
  result.rounds.forEach((round, index) => {
    const card = document.createElement("article");
    card.className = "round-card";
    const rows = Object.entries(round.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, votes]) => {
        const candidate = findCandidate(id);
        return `
          <div class="bar-row ${round.eliminated === id ? "eliminated" : ""}">
            <div><p>${candidate.icon} ${candidate.name}</p><div class="bar"><i style="--bar-color: ${candidate.color}; width: ${votes / state.ballots.length * 100}%"></i></div></div>
            <strong>${votes}</strong>
          </div>`;
      }).join("");
    card.innerHTML = `
      <div class="round-head"><strong>Round ${index + 1}</strong><span>${round.eliminated ? "Lowest eliminated" : "Majority reached"}</span></div>
      ${rows}`;
    roundsList.appendChild(card);
  });
  state.revealed = true;
  switchView("results");
  if (announce) sendToAll({ type: "count-results" });
}

submitVoteButton.addEventListener("click", submitBallot);
document.querySelector("#countNow").addEventListener("click", () => renderResults(true));
document.querySelector("#addOption").addEventListener("click", () => addOptionRow().querySelector(".option-name").focus());
document.querySelector("#startRoom").addEventListener("click", startRoom);
copyRoomButton.addEventListener("click", async () => {
  if (copyRoomButton.textContent === "Start new room") return startNewRoom();
  if (!state.hostId) return showToast("Room is still connecting");
  await navigator.clipboard?.writeText(location.href);
  showToast("Invite link copied — send it to your voters");
});
showQrButton.addEventListener("click", () => {
  if (!window.QRCode) return showToast("Could not load the QR code generator");
  qrCode.innerHTML = "";
  document.querySelector("#qrRoomCode").textContent = state.roomCode;
  new QRCode(qrCode, {
    text: location.href,
    width: 200,
    height: 200,
    colorDark: "#18251f",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
  qrDialog.showModal();
});
document.querySelector("#closeQr").addEventListener("click", () => qrDialog.close());
qrDialog.addEventListener("click", (event) => {
  if (event.target === qrDialog) qrDialog.close();
});
document.querySelector("#themeButton").addEventListener("click", () => document.body.classList.toggle("dark"));
document.querySelector("#restartVote").addEventListener("click", () => {
  state.ballots = [];
  state.revealed = false;
  renderCandidates();
  switchView("ballot");
});
document.querySelector("#newVote").addEventListener("click", () => {
  const topic = (prompt("What is the group deciding next?") || "").trim() || "Group decision";
  hostStartNewVote(topic);
});
document.querySelector("#addSuggestion").addEventListener("click", submitSuggestion);
document.querySelector("#suggestName").addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitSuggestion();
});
document.querySelector("#suggestDetail").addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitSuggestion();
});
readyToggle.addEventListener("click", toggleReady);
startVoteNow.addEventListener("click", startVote);
document.querySelectorAll("#modeToggle .mode-option").forEach((button) => button.addEventListener("click", () => {
  selectedMode = button.dataset.mode;
  document.querySelectorAll("#modeToggle .mode-option").forEach((other) => {
    other.classList.toggle("active", other === button);
  });
  document.querySelector("#classicFields").hidden = selectedMode === "staged";
  document.querySelector("#startRoom span").textContent =
    selectedMode === "staged" ? "Open the idea room" : "Open the room";
}));
document.querySelectorAll(".progress-step").forEach((step) => step.addEventListener("click", () => {
  if (step.dataset.view === "results" && state.ballots.length && state.isHost) renderResults(true);
  else if (step.dataset.view !== "results") switchView(step.dataset.view);
}));

readRoomLink();
configureRoleUI();
renderCandidates();
if (state.isHost) {
  renderCreateView();
  switchView("create");
}
setupPeerChannel();
