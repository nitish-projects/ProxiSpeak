(function (root) {
  function validatePosition(position, name) {
    if (
      !Array.isArray(position) ||
      position.length !== 2 ||
      !position.every(Number.isFinite)
    ) {
      throw new Error(`${name} must contain two numbers: [x, y].`);
    }
  }

  function calculateSpatialAudio(
    listenerPosition,
    speakerPosition,
    hearingRadius
  ) {
    validatePosition(listenerPosition, "Listener position");
    validatePosition(speakerPosition, "Speaker position");

    if (!Number.isFinite(hearingRadius) || hearingRadius <= 0) {
      throw new Error("Hearing radius must be greater than zero.");
    }

    const dx = speakerPosition[0] - listenerPosition[0];
    const dy = speakerPosition[1] - listenerPosition[1];

    const distance = Math.hypot(dx, dy);

    // Linear volume falloff.
    const gain = Math.max(0, 1 - distance / hearingRadius);

    // Screen-relative panning:
    // negative X difference = left; positive = right.
    const pan = Math.max(-1, Math.min(1, dx / hearingRadius));

    return {
      distance,
      gain,
      pan,
      audible: distance < hearingRadius,
    };
  }

  // Allows testing with Node.js and use in a browser.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { calculateSpatialAudio };
  } else {
    root.calculateSpatialAudio = calculateSpatialAudio;
  }
})(globalThis);