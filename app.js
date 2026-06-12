const candidates = [
  { id: "greenhouse", name: "Greenhouse Café", detail: "Seasonal plates · 12 min walk", icon: "🌿", color: "#d9edc5" },
  { id: "little-italy", name: "Little Italy", detail: "Pasta & pizza · 8 min walk", icon: "🍅", color: "#f4d4c2" },
  { id: "noodle-club", name: "Noodle Club", detail: "Asian comfort food · 15 min walk", icon: "🍜", color: "#f3dfb4" },
  { id: "harbor", name: "The Harbor Room", detail: "Seafood & grill · 10 min walk", icon: "⚓", color: "#cadde9" },
  { id: "picnic", name: "Park Picnic", detail: "Bring-your-own · 5 min walk", icon: "☀️", color: "#eee4a9" },
];

const demoBallots = [
  ["little-italy", "greenhouse", "noodle-club", "harbor", "picnic"],
  ["noodle-club", "greenhouse", "picnic", "little-italy", "harbor"],
  ["harbor", "greenhouse", "little-italy", "noodle-club", "picnic"],
  ["greenhouse", "picnic", "noodle-club", "harbor", "little-italy"],
  ["picnic", "greenhouse", "little-italy", "noodle-club", "harbor"],
];

const state = {
  ballots: [],
  dragging: null,
  signalChannel: null,
  peers: new Map(),
  peerId: crypto.randomUUID(),
};

const candidateList = document.querySelector("#candidateList");
const toast = document.querySelector("#toast");

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
    item.addEventListener("dragstart", () => {
      state.dragging = item;
      requestAnimationFrame(() => item.classList.add("dragging"));
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      state.dragging = null;
    });
    candidateList.appendChild(item);
  });
}

candidateList.addEventListener("dragover", (event) => {
  event.preventDefault();
  const after = [...candidateList.querySelectorAll(".candidate:not(.dragging)")].find((item) => {
    const box = item.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2;
  });
  candidateList.insertBefore(state.dragging, after || null);
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

function receivePeerMessage(message) {
  if (message.type === "ballot" && !state.ballots.some((ballot) => ballot.peerId === message.peerId)) {
    state.ballots.push({ peerId: message.peerId, ranking: message.ranking });
    updateWaiting();
    showToast("An anonymous peer submitted a ballot");
  }
}

function registerDataChannel(peerId, channel) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  peer.channel = channel;
  channel.addEventListener("message", ({ data }) => receivePeerMessage(JSON.parse(data)));
  channel.addEventListener("open", updatePeerCount);
  channel.addEventListener("close", updatePeerCount);
}

function updatePeerCount() {
  const connected = [...state.peers.values()].filter((peer) => peer.channel?.readyState === "open").length + 1;
  document.querySelector("#peerCount").textContent = connected;
}

async function createPeer(peerId, initiator) {
  if (state.peers.has(peerId)) return state.peers.get(peerId).connection;
  const connection = new RTCPeerConnection();
  state.peers.set(peerId, { connection, channel: null });

  connection.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) state.signalChannel.postMessage({ type: "ice", from: state.peerId, to: peerId, candidate });
  });
  connection.addEventListener("datachannel", ({ channel }) => registerDataChannel(peerId, channel));
  connection.addEventListener("connectionstatechange", updatePeerCount);

  if (initiator) {
    registerDataChannel(peerId, connection.createDataChannel("anonymous-ballots"));
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    state.signalChannel.postMessage({ type: "offer", from: state.peerId, to: peerId, description: offer });
  }
  return connection;
}

function setupPeerChannel() {
  if (!("BroadcastChannel" in window)) return;
  state.signalChannel = new BroadcastChannel("common-ground-lime-742-signal");
  state.signalChannel.addEventListener("message", async ({ data }) => {
    if (data.from === state.peerId || (data.to && data.to !== state.peerId)) return;
    if (data.type === "hello") {
      if (state.peerId < data.from) await createPeer(data.from, true);
    } else if (data.type === "offer") {
      const connection = await createPeer(data.from, false);
      await connection.setRemoteDescription(data.description);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      state.signalChannel.postMessage({ type: "answer", from: state.peerId, to: data.from, description: answer });
    } else if (data.type === "answer") {
      await state.peers.get(data.from)?.connection.setRemoteDescription(data.description);
    } else if (data.type === "ice") {
      await state.peers.get(data.from)?.connection.addIceCandidate(data.candidate);
    }
  });
  state.signalChannel.postMessage({ type: "hello", from: state.peerId });
}

function submitBallot() {
  if (state.ballots.some((ballot) => ballot.peerId === state.peerId)) return;
  const ranking = currentBallot();
  state.ballots.push({ peerId: state.peerId, ranking });
  const message = JSON.stringify({ type: "ballot", peerId: state.peerId, ranking });
  state.peers.forEach((peer) => {
    if (peer.channel?.readyState === "open") peer.channel.send(message);
  });
  updateWaiting();
  switchView("waiting");
}

function updateWaiting() {
  const count = state.ballots.length;
  document.querySelector("#waitingCount").textContent = count;
  document.querySelector("#peerCount").textContent = Math.max(4, count);
}

function addDemoVote() {
  const next = demoBallots[state.ballots.length % demoBallots.length];
  state.ballots.push({ peerId: `demo-${state.ballots.length}`, ranking: next });
  updateWaiting();
  showToast("Anonymous demo ballot received");
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

function renderResults() {
  if (state.ballots.length < 2) {
    demoBallots.slice(0, 4).forEach((ranking, index) => state.ballots.push({ peerId: `auto-${index}`, ranking }));
  }
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
}

document.querySelector("#submitVote").addEventListener("click", submitBallot);
document.querySelector("#addDemoVote").addEventListener("click", addDemoVote);
document.querySelector("#countNow").addEventListener("click", renderResults);
document.querySelector("#copyRoom").addEventListener("click", async () => {
  await navigator.clipboard?.writeText(`${location.href.split("#")[0]}#LIME-742`);
  showToast("Invite link copied");
});
document.querySelector("#themeButton").addEventListener("click", () => document.body.classList.toggle("dark"));
document.querySelector("#restartVote").addEventListener("click", () => {
  state.ballots = [];
  renderCandidates();
  switchView("ballot");
});
document.querySelectorAll(".progress-step").forEach((step) => step.addEventListener("click", () => {
  if (step.dataset.view === "results" && state.ballots.length) renderResults();
  else if (step.dataset.view !== "results") switchView(step.dataset.view);
}));

renderCandidates();
setupPeerChannel();
