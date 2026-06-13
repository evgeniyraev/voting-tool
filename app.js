const candidates = [
  { id: "greenhouse", name: "Greenhouse Café", detail: "Seasonal plates · 12 min walk", icon: "🌿", color: "#d9edc5" },
  { id: "little-italy", name: "Little Italy", detail: "Pasta & pizza · 8 min walk", icon: "🍅", color: "#f4d4c2" },
  { id: "noodle-club", name: "Noodle Club", detail: "Asian comfort food · 15 min walk", icon: "🍜", color: "#f3dfb4" },
  { id: "harbor", name: "The Harbor Room", detail: "Seafood & grill · 10 min walk", icon: "⚓", color: "#cadde9" },
  { id: "picnic", name: "Park Picnic", detail: "Bring-your-own · 5 min walk", icon: "☀️", color: "#eee4a9" },
];

const state = {
  ballots: [],
  dragging: null,
  peers: new Map(),
  peer: null,
  peerId: null,
  hostId: null,
  roomCode: null,
  isHost: false,
};

const candidateList = document.querySelector("#candidateList");
const toast = document.querySelector("#toast");
const connectionStatus = document.querySelector("#connectionStatus");
const copyRoomButton = document.querySelector("#copyRoom");
const showQrButton = document.querySelector("#showQr");
const qrDialog = document.querySelector("#qrDialog");
const qrCode = document.querySelector("#qrCode");
const HOST_STORAGE_KEY = "common-ground-host-id";

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

function renderCandidates() {
  candidateList.innerHTML = "";
  candidates.forEach((candidate) => {
    const item = document.createElement("li");
    item.className = "candidate";
    item.draggable = true;
    item.dataset.id = candidate.id;
    item.innerHTML = `
      <span class="candidate-art" style="--candidate: ${candidate.color}">${candidate.icon}</span>
      <div><strong>${candidate.name}</strong><small>${candidate.detail}</small></div>
      <span class="support">Rank this choice</span>
      <span class="handle">⠿</span>
    `;
    const handle = item.querySelector(".handle");
    item.addEventListener("dragstart", () => {
      state.dragging = item;
      requestAnimationFrame(() => item.classList.add("dragging"));
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      state.dragging = null;
    });
    handle.addEventListener("touchstart", (event) => startTouchDrag(event, item), { passive: false });
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

function startTouchDrag(event, item) {
  const touch = event.changedTouches[0];
  if (!touch) return;
  event.preventDefault();
  state.dragging = item;
  const touchId = touch.identifier;
  const box = item.getBoundingClientRect();
  const fingerOffsetY = touch.clientY - box.top;
  const preview = item.cloneNode(true);

  item.classList.add("touch-placeholder");
  preview.classList.add("touch-preview");
  preview.removeAttribute("draggable");
  preview.style.width = `${box.width}px`;
  preview.style.left = `${box.left}px`;
  preview.style.top = `${touch.clientY - fingerOffsetY}px`;
  document.body.appendChild(preview);

  const move = (moveEvent) => {
    const activeTouch = Array.from(moveEvent.changedTouches).find((current) => current.identifier === touchId);
    if (!activeTouch) return;
    moveEvent.preventDefault();
    preview.style.top = `${activeTouch.clientY - fingerOffsetY}px`;
    movePlaceholder(item, findDropTarget(activeTouch.clientY) || null);
    if (activeTouch.clientY < 90) window.scrollBy(0, -12);
    if (activeTouch.clientY > window.innerHeight - 90) window.scrollBy(0, 12);
  };
  const end = (endEvent) => {
    if (!Array.from(endEvent.changedTouches).some((current) => current.identifier === touchId)) return;
    item.classList.remove("touch-placeholder");
    preview.remove();
    state.dragging = null;
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", end);
  };

  document.addEventListener("touchmove", move, { passive: false });
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
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

function receivePeerMessage(message, senderId = null) {
  if (message.type === "ballot" && !state.ballots.some((ballot) => ballot.peerId === message.peerId)) {
    state.ballots.push({ peerId: message.peerId, ranking: message.ranking });
    updateWaiting();
    showToast("An anonymous peer submitted a ballot");
  } else if (message.type === "sync") {
    message.ballots.forEach((ballot) => {
      if (!state.ballots.some((existing) => existing.peerId === ballot.peerId)) state.ballots.push(ballot);
    });
    message.peerIds.forEach((peerId) => {
      if (peerId !== state.peerId && !state.peers.has(peerId)) connectToPeer(peerId);
    });
    updateWaiting();
  } else if (message.type === "count-results" && senderId === state.hostId) {
    renderResults(false);
  }
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

function registerConnection(connection) {
  if (state.peers.has(connection.peer)) return;
  state.peers.set(connection.peer, connection);
  connection.on("open", () => {
    connection.send({
      type: "sync",
      ballots: state.ballots,
      peerIds: [state.hostId, ...state.peers.keys()].filter(Boolean),
    });
    updatePeerCount();
  });
  connection.on("data", (message) => {
    receivePeerMessage(message, connection.peer);
    if (message.type === "ballot") sendToAll(message, connection.peer);
  });
  connection.on("close", () => {
    state.peers.delete(connection.peer);
    updatePeerCount();
  });
  connection.on("error", () => {
    state.peers.delete(connection.peer);
    updatePeerCount();
  });
}

function connectToPeer(peerId) {
  if (!peerId || peerId === state.peerId || state.peers.has(peerId)) return;
  registerConnection(state.peer.connect(peerId, { reliable: true }));
}

function setupPeerChannel() {
  readRoomLink();
  configureRoleUI();
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
      connectionStatus.textContent = "Host offline";
      copyRoomButton.disabled = false;
      copyRoomButton.textContent = "Start new room";
      showQrButton.disabled = true;
      showToast("Room host is no longer online");
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
  resultsStep.disabled = !state.isHost;
  if (!state.isHost) {
    document.querySelector("#waitingMessage").textContent =
      "Your anonymous ballot is locked in. The inviter will reveal the result when voting is complete.";
  }
}

function startNewRoom() {
  sessionStorage.removeItem(HOST_STORAGE_KEY);
  location.hash = "";
  location.reload();
}

function submitBallot() {
  if (!state.peerId) return showToast("Wait for the room to finish connecting");
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
  const active = new Set(candidates.map((candidate) => candidate.id));
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
  if (announce && !state.isHost) return showToast("Only the inviter can count votes");
  const result = countSTV(state.ballots);
  const winner = candidates.find((candidate) => candidate.id === result.winner);
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
        const candidate = candidates.find((item) => item.id === id);
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
  switchView("results");
  if (announce) sendToAll({ type: "count-results" });
}

document.querySelector("#submitVote").addEventListener("click", submitBallot);
document.querySelector("#countNow").addEventListener("click", () => renderResults(true));
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
  renderCandidates();
  switchView("ballot");
});
document.querySelectorAll(".progress-step").forEach((step) => step.addEventListener("click", () => {
  if (step.dataset.view === "results" && state.ballots.length && state.isHost) renderResults(true);
  else if (step.dataset.view !== "results") switchView(step.dataset.view);
}));

renderCandidates();
setupPeerChannel();
