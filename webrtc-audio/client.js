const socket = io();

const startButton = document.getElementById("start");
const muteButton = document.getElementById("mute");
const stopButton = document.getElementById("stop");
const signaling = document.getElementById("signaling");
const statusText = document.getElementById("status");
const remoteAudio = document.getElementById("remoteAudio");
const logBox = document.getElementById("log");

let stream = null;
let requesting = false;
let requestVersion = 0;
let call = null;
let signalQueue = Promise.resolve();
let roomFull = false;

function log(message) {
  const line = `${new Date().toLocaleTimeString()} ${message}`;
  const lines = `${logBox.textContent}\n${line}`.trim().split("\n");

  logBox.textContent = lines.slice(-40).join("\n");
  logBox.scrollTop = logBox.scrollHeight;
}

function updateButtons() {
  startButton.disabled =
    !socket.connected || requesting || stream !== null || roomFull;

  muteButton.disabled = stream === null;
  stopButton.disabled = !requesting && stream === null;

  const track = stream?.getAudioTracks()[0];

  muteButton.textContent =
    track && !track.enabled ? "Unmute microphone" : "Mute microphone";
}

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

  remoteAudio.pause();
  remoteAudio.srcObject = null;

  if (notifyServer && socket.connected) {
    socket.emit("audio:leave");
  }

  statusText.textContent = message;
  updateButtons();
}

function fail(currentCall, error) {
  if (call !== currentCall) return;

  log(`Error: ${error.message}`);
  cleanup(`Call failed: ${error.message}`, true);
}

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
          new Error(response?.message || "Signaling acknowledgement timed out.")
        );
      }
    }
  );
}

async function beginCall(message) {
  if (!stream || call) return;

  // Same-computer exercise: no STUN/TURN servers configured yet.
  const pc = new RTCPeerConnection({ iceServers: [] });

  const currentCall = {
    ...message,
    pc,
    pendingCandidates: [],
    timer: null,
  };

  call = currentCall;

  statusText.textContent = "Setting up the WebRTC connection…";
  log(`Call assigned. Role: ${message.initiator ? "caller" : "receiver"}`);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal("webrtc:ice-candidate", currentCall, {
        candidate: event.candidate.toJSON(),
      });
    }
  };

  pc.ontrack = (event) => {
    if (call !== currentCall) return;

    remoteAudio.srcObject =
      event.streams[0] || new MediaStream([event.track]);

    log("Remote audio track received.");

    remoteAudio.play().catch(() => {
      if (call === currentCall) {
        log("Playback needs a click. Press Play under Received audio.");
      }
    });
  };

  pc.onconnectionstatechange = () => {
    if (call !== currentCall) return;

    log(`WebRTC: ${pc.connectionState}`);

    if (pc.connectionState === "connected") {
      clearTimeout(currentCall.timer);
      statusText.textContent = "WebRTC connected. Audio can flow.";
    } else if (pc.connectionState === "disconnected") {
      statusText.textContent =
        "Audio connection interrupted. Stop and restart if it persists.";
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

  try {
    if (message.initiator) {
      const offer = await pc.createOffer();

      if (call !== currentCall) return;
      await pc.setLocalDescription(offer);

      sendSignal("webrtc:offer", currentCall, {
        description: pc.localDescription.toJSON(),
      });

      log("Offer sent.");
    }
  } catch (error) {
    fail(currentCall, error);
  }
}

async function handleSignal(eventName, message) {
  const currentCall = call;

  if (
    !currentCall ||
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

    if (eventName === "webrtc:offer") {
      log("Offer received.");

      const answer = await pc.createAnswer();

      if (call !== currentCall) return;
      await pc.setLocalDescription(answer);

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

startButton.addEventListener("click", async () => {
  if (!socket.connected || stream || requesting) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    statusText.textContent = "Microphone API unavailable. Use the local URL.";
    return;
  }

  const version = ++requestVersion;
  requesting = true;
  statusText.textContent = "Waiting for microphone permission…";
  updateButtons();

  try {
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

    captured.getAudioTracks()[0].addEventListener("ended", () => {
      if (stream === captured) {
        cleanup("Microphone became unavailable.", true);
      }
    });

    statusText.textContent = "Microphone ready. Waiting for the second tab…";
    updateButtons();

    socket.timeout(5000).emit("audio:ready", (error, response) => {
      if (version !== requestVersion) return;

      if (error || !response?.ok) {
        cleanup("Could not join the audio exercise. Try again.", true);
      }
    });
  } catch (error) {
    if (version !== requestVersion) return;

    const messages = {
      NotAllowedError: "Microphone permission was blocked.",
      NotFoundError: "No microphone was found.",
      NotReadableError: "The microphone could not be opened.",
    };

    cleanup(messages[error.name] || `Microphone error: ${error.name}`);
  }
});

muteButton.addEventListener("click", () => {
  const track = stream?.getAudioTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;
  log(track.enabled ? "Microphone unmuted." : "Microphone muted.");
  updateButtons();
});

stopButton.addEventListener("click", () => {
  cleanup("Session stopped. Microphone released.", true);
});

socket.on("connect", () => {
  roomFull = false;
  signaling.textContent = "Connected";
  log(`Signaling connected. Peer ID: ${socket.id}`);
  updateButtons();
});

socket.on("connect_error", (error) => {
  signaling.textContent = "Connection error";
  log(error.message);
  cleanup("Cannot reach the signaling server.");
});

socket.on("disconnect", () => {
  signaling.textContent = "Disconnected";

  cleanup(
    roomFull
      ? "The exercise already has two tabs. Close this extra tab."
      : "Signaling disconnected. Start again after it reconnects."
  );
});

socket.on("lab:full", ({ message }) => {
  roomFull = true;
  log(message);
  cleanup(message);
});

socket.on("webrtc:start", beginCall);

for (const eventName of [
  "webrtc:offer",
  "webrtc:answer",
  "webrtc:ice-candidate",
]) {
  socket.on(eventName, (message) => {
    // Process incoming signaling in order.
    signalQueue = signalQueue
      .then(() => handleSignal(eventName, message))
      .catch((error) => log(`Signaling error: ${error.message}`));
  });
}

socket.on("webrtc:end", ({ callId, reason }) => {
  if (callId && call && callId !== call.callId) return;

  log(reason);
  cleanup(`${reason} Click Start audio in both tabs to try again.`);
});

window.addEventListener("pagehide", () => {
  cleanup("Page closed.");
  socket.disconnect();
});