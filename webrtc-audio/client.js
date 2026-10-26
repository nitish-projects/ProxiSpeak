"use strict";

const socket = io({ autoConnect: false });

// ---------- HTML elements ----------

const elementIds = [
  "start",
  "mute",
  "stop",
  "signaling",
  "status",
  "log",
  "audioState",
  "enableAudio",
  "avatarX",
  "avatarY",
  "moveAvatar",
  "proximityStatus",
  "distance",
  "distanceValue",
  "gainValue",
  "pan",
  "panValue",
];

const ui = {};

for (const id of elementIds) {
  ui[id] = document.getElementById(id);

  if (!ui[id]) {
    throw new Error(
      `Missing HTML element "${id}". Use the updated index.html.`
    );
  }
}

if (typeof window.calculateSpatialAudio !== "function") {
  throw new Error(
    "Load spatial-math.js before client.js in index.html."
  );
}

// ---------- Application state ----------

const OFFICE_ID = "local-audio-lab";
const HEARING_RADIUS = 100;

let stream = null;
let requesting = false;
let requestVersion = 0;
let roomFull = false;
let leaving = false;

let call = null;
let signalQueue = Promise.resolve();

let audioContext = null;
let remoteSource = null;
let gainNode = null;
let panNode = null;

let latestSnapshot = null;
let lastRevision = -1;

// ---------- Interface helpers ----------

function log(message) {
  const line = `${new Date().toLocaleTimeString()} ${message}`;
  const lines = `${ui.log.textContent}\n${line}`.trim().split("\n");

  ui.log.textContent = lines.slice(-50).join("\n");
  ui.log.scrollTop = ui.log.scrollHeight;
}

function updateButtons() {
  ui.start.disabled =
    !socket.connected ||
    roomFull ||
    leaving ||
    requesting ||
    stream !== null;

  ui.mute.disabled = stream === null;
  ui.stop.disabled = !requesting && stream === null;

  const track = stream?.getAudioTracks()[0];

  ui.mute.textContent =
    track && !track.enabled
      ? "Unmute microphone"
      : "Mute microphone";

  ui.enableAudio.disabled =
    !audioContext ||
    audioContext.state === "closed" ||
    audioContext.state === "running";

  ui.moveAvatar.disabled =
    !socket.connected || roomFull || !latestSnapshot;

  // Positions from the server control playback in this version.
  ui.distance.disabled = true;
  ui.pan.disabled = true;
}

function showSpatialValues(distance, gain, pan) {
  ui.distanceValue.textContent =
    Number.isFinite(distance) ? distance.toFixed(1) : "Unavailable";

  ui.gainValue.textContent = `${Math.round(gain * 100)}%`;

  const panPercent = Math.round(Math.abs(pan) * 100);

  ui.panValue.textContent =
    panPercent === 0
      ? "Center"
      : `${panPercent}% ${pan < 0 ? "left" : "right"}`;

  // Slider positions are only visual indicators.
  ui.distance.value = Number.isFinite(distance)
    ? Math.min(Number(ui.distance.max), distance)
    : Number(ui.distance.max);

  ui.pan.value = Math.round(pan * 100);
}

// ---------- Audio processing ----------

function smoothParameter(parameter, target) {
  if (!audioContext || audioContext.state === "closed") return;

  const now = audioContext.currentTime;
  const currentValue = parameter.value;

  parameter.cancelScheduledValues(now);
  parameter.setValueAtTime(currentValue, now);
  parameter.linearRampToValueAtTime(target, now + 0.05);
}

function silenceReceivedAudio() {
  if (gainNode) smoothParameter(gainNode.gain, 0);
  if (panNode) smoothParameter(panNode.pan, 0);

  showSpatialValues(null, 0, 0);
}

function disconnectRemoteAudio() {
  if (remoteSource) remoteSource.disconnect();
  if (gainNode) gainNode.disconnect();
  if (panNode) panNode.disconnect();

  remoteSource = null;
  gainNode = null;
  panNode = null;
}

function closeAudioOutput() {
  disconnectRemoteAudio();

  const previousContext = audioContext;
  audioContext = null;

  ui.audioState.textContent = "Not started";

  if (previousContext) {
    previousContext.onstatechange = null;

    if (previousContext.state !== "closed") {
      previousContext.close().catch((error) => {
        log(`Audio cleanup: ${error.message}`);
      });
    }
  }
}

function updateAudioFromPositions(
  listenerPosition,
  speakerPosition,
  hearingRadius = HEARING_RADIUS
) {
  const result = window.calculateSpatialAudio(
    listenerPosition,
    speakerPosition,
    hearingRadius
  );

  showSpatialValues(result.distance, result.gain, result.pan);

  if (gainNode && panNode) {
    smoothParameter(gainNode.gain, result.gain);
    smoothParameter(panNode.pan, result.pan);
  }

  return result;
}

function applyLatestProximity() {
  if (!call) {
    silenceReceivedAudio();

    ui.proximityStatus.textContent = latestSnapshot
      ? "Position received. Start audio in both tabs."
      : "Waiting for position data from the server…";

    return;
  }

  if (
    !latestSnapshot ||
    latestSnapshot.roomId !== call.officeId
  ) {
    silenceReceivedAudio();
    ui.proximityStatus.textContent =
      "Waiting for this room's proximity data…";
    return;
  }

  const remotePeer = latestSnapshot.nearbyUsers.find(
    (peer) => peer.peerId === call.peerId
  );

  if (!remotePeer || !remotePeer.audioReady) {
    silenceReceivedAudio();

    ui.proximityStatus.textContent =
      "The other participant is outside the hearing radius " +
      "or is not ready for audio.";

    return;
  }

  const result = updateAudioFromPositions(
    latestSnapshot.self.position,
    remotePeer.position,
    latestSnapshot.hearingRadius
  );

  ui.proximityStatus.textContent =
    `Other participant: ${result.distance.toFixed(1)} units away. ` +
    `Volume gain: ${Math.round(result.gain * 100)}%.`;
}

function attachSpatialAudio(remoteStream) {
  if (!audioContext || audioContext.state === "closed") {
    throw new Error("Audio output is not initialized.");
  }

  disconnectRemoteAudio();

  remoteSource = audioContext.createMediaStreamSource(remoteStream);
  gainNode = audioContext.createGain();
  panNode = audioContext.createStereoPanner();

  // Start silent until proximity has been checked.
  gainNode.gain.setValueAtTime(0, audioContext.currentTime);
  panNode.pan.setValueAtTime(0, audioContext.currentTime);

  panNode.channelCount = 1;
  panNode.channelCountMode = "explicit";

  remoteSource.connect(gainNode);
  gainNode.connect(panNode);
  panNode.connect(audioContext.destination);

  applyLatestProximity();
  log("Remote voice connected to spatial audio processing.");
}

// ---------- Proximity data ----------

function isValidPosition(position) {
  return (
    Array.isArray(position) &&
    position.length === 2 &&
    position.every(
      (value) =>
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 1000
    )
  );
}

function isValidSnapshot(snapshot) {
  return (
    snapshot &&
    snapshot.roomId === OFFICE_ID &&
    Number.isSafeInteger(snapshot.revision) &&
    snapshot.revision >= 0 &&
    Number.isFinite(snapshot.hearingRadius) &&
    snapshot.hearingRadius > 0 &&
    snapshot.self?.peerId === socket.id &&
    isValidPosition(snapshot.self.position) &&
    Array.isArray(snapshot.nearbyUsers) &&
    snapshot.nearbyUsers.every(
      (peer) =>
        peer &&
        typeof peer.peerId === "string" &&
        typeof peer.audioReady === "boolean" &&
        isValidPosition(peer.position)
    )
  );
}

function resetProximityState() {
  latestSnapshot = null;
  lastRevision = -1;
  applyLatestProximity();
  updateButtons();
}

socket.on("proximity:update", (snapshot) => {
  if (!isValidSnapshot(snapshot)) {
    log("Ignored invalid proximity data.");
    return;
  }

  if (snapshot.revision <= lastRevision) return;

  const previousPosition = latestSnapshot?.self.position;
  const position = snapshot.self.position;

  // Avoid overwriting edits when only another avatar moved.
  if (
    !previousPosition ||
    previousPosition[0] !== position[0] ||
    previousPosition[1] !== position[1]
  ) {
    ui.avatarX.value = position[0];
    ui.avatarY.value = position[1];
  }

  latestSnapshot = snapshot;
  lastRevision = snapshot.revision;

  applyLatestProximity();
  updateButtons();
});

ui.moveAvatar.addEventListener("click", () => {
  if (!socket.connected || !latestSnapshot) return;

  if (
    ui.avatarX.value.trim() === "" ||
    ui.avatarY.value.trim() === ""
  ) {
    ui.proximityStatus.textContent = "Enter both X and Y coordinates.";
    return;
  }

  const position = [
    Number(ui.avatarX.value),
    Number(ui.avatarY.value),
  ];

  if (!isValidPosition(position)) {
    ui.proximityStatus.textContent =
      "X and Y must be numbers between 0 and 1000.";
    return;
  }

  const sentByPeerId = socket.id;

  socket.timeout(5000).emit(
    "avatar:position",
    {
      roomId: latestSnapshot.roomId,
      position,
    },
    (error, response) => {
      if (!socket.connected || socket.id !== sentByPeerId) return;

      if (error || !response?.ok) {
        const message =
          response?.message || "Position update timed out.";

        ui.proximityStatus.textContent = message;
        log(message);
        return;
      }

      log(`Avatar moved to [${position.join(", ")}].`);
    }
  );
});

// ---------- Session cleanup ----------

function cleanup(message, notifyServer = false) {
  requestVersion++;
  requesting = false;

  const oldCall = call;
  call = null;

  if (oldCall) {
    clearTimeout(oldCall.timer);

    oldCall.pc.onicecandidate = null;
    oldCall.pc.ontrack = null;
    oldCall.pc.onconnectionstatechange = null;
    oldCall.pc.close();
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  closeAudioOutput();
  applyLatestProximity();

  if (notifyServer && socket.connected && !leaving) {
    // Wait for webrtc:end before permitting another start.
    leaving = true;
    socket.emit("audio:leave");
  }

  ui.status.textContent = message;
  updateButtons();
}

function fail(currentCall, error) {
  if (call !== currentCall) return;

  log(`Error: ${error.message}`);
  cleanup(`Call failed: ${error.message}`, true);
}

// ---------- WebRTC signaling ----------

function sendSignal(eventName, currentCall, payload) {
  if (call !== currentCall || !socket.connected) return;

  socket.timeout(5000).emit(
    eventName,
    {
      officeId: currentCall.officeId,
      toPeerId: currentCall.peerId,
      callId: currentCall.callId,
      ...payload,
    },
    (error, response) => {
      if (call !== currentCall) return;

      if (error || !response?.ok) {
        fail(
          currentCall,
          new Error(
            response?.message ||
              "Signaling acknowledgement timed out."
          )
        );
      }
    }
  );
}

async function beginCall(message) {
  if (!stream || call || leaving) return;

  if (
    !message ||
    message.officeId !== OFFICE_ID ||
    typeof message.callId !== "string" ||
    typeof message.peerId !== "string" ||
    typeof message.initiator !== "boolean"
  ) {
    cleanup("Invalid call information received.", true);
    return;
  }

  let currentCall = null;

  try {
    // Same-computer demo. Add STUN/TURN for later network testing.
    const pc = new RTCPeerConnection({ iceServers: [] });

    currentCall = {
      ...message,
      pc,
      pendingCandidates: [],
      timer: null,
    };

    call = currentCall;
    applyLatestProximity();

    ui.status.textContent = "Setting up the WebRTC connection…";

    log(
      `Call assigned. Role: ${
        message.initiator ? "caller" : "receiver"
      }.`
    );

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal("webrtc:ice-candidate", currentCall, {
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event) => {
      if (call !== currentCall || event.track.kind !== "audio") {
        return;
      }

      try {
        const receivedStream =
          event.streams[0] || new MediaStream([event.track]);

        attachSpatialAudio(receivedStream);
        log("Remote audio track received.");

        if (audioContext.state !== "running") {
          log("Click Resume audio output to enable playback.");
        }
      } catch (error) {
        fail(currentCall, error);
      }
    };

    pc.onconnectionstatechange = () => {
      if (call !== currentCall) return;

      log(`WebRTC: ${pc.connectionState}`);

      if (pc.connectionState === "connected") {
        clearTimeout(currentCall.timer);

        ui.status.textContent =
          "WebRTC connected. Move an avatar to test spatial audio.";

        applyLatestProximity();
      } else if (pc.connectionState === "disconnected") {
        ui.status.textContent =
          "Audio interrupted. Stop and restart if it persists.";
      } else if (pc.connectionState === "failed") {
        fail(currentCall, new Error("WebRTC connection failed."));
      }
    };

    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });

    currentCall.timer = setTimeout(() => {
      fail(currentCall, new Error("Connection setup timed out."));
    }, 30000);

    if (message.initiator) {
      const offer = await pc.createOffer();

      if (call !== currentCall) return;
      await pc.setLocalDescription(offer);

      if (call !== currentCall) return;

      sendSignal("webrtc:offer", currentCall, {
        description: pc.localDescription.toJSON(),
      });

      log("Offer sent.");
    }
  } catch (error) {
    if (currentCall) {
      fail(currentCall, error);
    } else {
      cleanup(
        `Could not create WebRTC connection: ${error.message}`,
        true
      );
    }
  }
}

async function handleSignal(eventName, message, currentCall) {
  if (
    !currentCall ||
    call !== currentCall ||
    !message ||
    message.callId !== currentCall.callId ||
    message.fromPeerId !== currentCall.peerId ||
    message.officeId !== currentCall.officeId
  ) {
    return;
  }

  const pc = currentCall.pc;

  try {
    if (eventName === "webrtc:ice-candidate") {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(message.candidate);
      } else {
        currentCall.pendingCandidates.push(message.candidate);
      }

      return;
    }

    await pc.setRemoteDescription(message.description);

    if (call !== currentCall) return;

    for (const candidate of currentCall.pendingCandidates) {
      if (call !== currentCall) return;
      await pc.addIceCandidate(candidate);
    }

    currentCall.pendingCandidates = [];

    if (call !== currentCall) return;

    if (eventName === "webrtc:offer") {
      log("Offer received.");

      const answer = await pc.createAnswer();

      if (call !== currentCall) return;
      await pc.setLocalDescription(answer);

      if (call !== currentCall) return;

      sendSignal("webrtc:answer", currentCall, {
        description: pc.localDescription.toJSON(),
      });

      log("Answer sent.");
    } else {
      log("Answer received.");
    }
  } catch (error) {
    fail(currentCall, error);
  }
}

// ---------- Start microphone ----------

ui.start.addEventListener("click", async () => {
  if (
    !socket.connected ||
    stream ||
    requesting ||
    roomFull ||
    leaving
  ) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    ui.status.textContent =
      "Microphone API unavailable. Open http://127.0.0.1:3000";
    return;
  }

  if (!window.AudioContext || !window.RTCPeerConnection) {
    ui.status.textContent =
      "This browser does not support the required audio APIs.";
    return;
  }

  const version = ++requestVersion;
  requesting = true;

  ui.status.textContent = "Starting audio output…";
  updateButtons();

  try {
    audioContext = new AudioContext();
    const context = audioContext;

    const showAudioState = () => {
      if (audioContext !== context) return;

      ui.audioState.textContent = context.state;
      updateButtons();
    };

    context.onstatechange = showAudioState;
    showAudioState();

    await context.resume();

    if (version !== requestVersion || !socket.connected) return;

    showAudioState();
    ui.status.textContent = "Waiting for microphone permission…";

    const captured = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });

    if (version !== requestVersion || !socket.connected) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }

    stream = captured;
    requesting = false;

    const microphoneTrack = captured.getAudioTracks()[0];

    if (!microphoneTrack) {
      throw new Error("No audio track was returned.");
    }

    microphoneTrack.addEventListener("ended", () => {
      if (stream === captured) {
        cleanup("Microphone became unavailable.", true);
      }
    });

    ui.status.textContent =
      "Microphone ready. Waiting for the second tab…";

    log("Microphone started.");
    updateButtons();

    socket.timeout(5000).emit("audio:ready", (error, response) => {
      if (version !== requestVersion) return;

      if (error || !response?.ok) {
        cleanup(
          response?.message ||
            "Could not join the audio exercise. Try again.",
          true
        );
      }
    });
  } catch (error) {
    if (version !== requestVersion) return;

    const messages = {
      NotAllowedError:
        "Microphone or audio access was blocked. Check browser permissions.",
      NotFoundError:
        "No microphone was found. Connect one and try again.",
      NotReadableError:
        "The microphone could not be opened. Check your device or other apps.",
      AbortError:
        "Audio startup was interrupted. Try again.",
    };

    const message =
      messages[error.name] || `Audio startup failed: ${error.message}`;

    log(message);
    cleanup(message, true);
  }
});

// ---------- Audio controls ----------

ui.mute.addEventListener("click", () => {
  if (!stream) return;

  const tracks = stream.getAudioTracks();
  if (!tracks.length) return;

  const enabled = !tracks[0].enabled;
  tracks.forEach((track) => {
    track.enabled = enabled;
  });

  log(enabled ? "Microphone unmuted." : "Microphone muted.");
  updateButtons();
});

ui.stop.addEventListener("click", () => {
  cleanup("Session stopped. Microphone released.", true);
});

ui.enableAudio.addEventListener("click", async () => {
  const context = audioContext;

  if (!context || context.state === "closed") return;

  try {
    await context.resume();

    if (audioContext !== context) return;

    ui.audioState.textContent = context.state;
    updateButtons();
    log(`Audio output: ${context.state}`);
  } catch (error) {
    if (audioContext === context) {
      log(`Could not resume audio: ${error.message}`);
    }
  }
});

// ---------- Socket.IO connection events ----------

socket.on("connect", () => {
  roomFull = false;
  leaving = false;

  resetProximityState();

  ui.signaling.textContent = "Connected";
  ui.status.textContent =
    "Signaling connected. Click Start audio in both tabs.";

  log(`Signaling connected. Peer ID: ${socket.id}`);

  socket.emit("proximity:request");
  updateButtons();
});

socket.on("connect_error", (error) => {
  ui.signaling.textContent = "Connection error";
  leaving = false;

  log(error.message);
  cleanup("Cannot reach the signaling server.");
  resetProximityState();
});

socket.on("disconnect", () => {
  ui.signaling.textContent = "Disconnected";
  leaving = false;

  cleanup(
    roomFull
      ? "The exercise already has two tabs. Close this extra tab."
      : "Signaling disconnected. Start again after it reconnects."
  );

  resetProximityState();
});

socket.on("lab:full", (message) => {
  roomFull = true;

  const text =
    message?.message || "Two tabs are already connected.";

  log(text);
  cleanup(text);
});

socket.on("webrtc:start", beginCall);

for (const eventName of [
  "webrtc:offer",
  "webrtc:answer",
  "webrtc:ice-candidate",
]) {
  socket.on(eventName, (message) => {
    const currentCall = call;

    // Preserve signaling order and ignore work from old calls.
    signalQueue = signalQueue
      .then(() => handleSignal(eventName, message, currentCall))
      .catch((error) => {
        log(`Signaling error: ${error.message}`);
      });
  });
}

socket.on("webrtc:end", (message) => {
  if (
    message?.callId &&
    call &&
    message.callId !== call.callId
  ) {
    return;
  }

  const reason = message?.reason || "The session ended.";

  leaving = false;
  log(reason);

  cleanup(
    `${reason} Click Start audio in both tabs to try again.`
  );
});

window.addEventListener("pagehide", () => {
  cleanup("Page closed.");
  socket.disconnect();
});

// Reconnect if the browser restores this page from its back/forward cache.
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !socket.connected) {
    roomFull = false;
    leaving = false;
    socket.connect();
  }
});

// ---------- Initial state ----------

showSpatialValues(null, 0, 0);
updateButtons();
socket.connect();