
/**
 * Find online users near a position in the same room.
 * Coordinates use the project's 2D coordinate system.
 */
async function findNearbyUsers(
  livePositions,
  roomId,
  currentUserId,
  x,
  y,
  radius = 100
) {
  return livePositions.find({
    roomId,
    userId: { $ne: currentUserId },
    presence: "online",
    expiresAt: { $gt: new Date() },
    position: {
      $geoWithin: {
        $center: [[x, y], radius]
      }
    }
  }).toArray();
}

module.exports = { findNearbyUsers };
