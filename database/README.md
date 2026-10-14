# ProxiSpeak Database

This folder contains the MongoDB setup for ProxiSpeak.

## Collections

- `users`: User profiles and avatar settings.
- `rooms`: Virtual office room configuration and layout.
- `livePositions`: Current avatar positions and presence.

## Coordinate convention

The proposed virtual office uses flat 2D coordinates:

- Position format: `[x, y]`
- X increases to the right.
- Y increases downward.
- Each coordinate ranges from 0 to 1000.
- These are virtual coordinates, not GPS locations.

## Setup

The `setup.js` file is a MongoDB Shell (`mongosh`) script.
It creates or updates collection validators and creates indexes.

From the project root, run:

```bash
mongosh --file database/setup.js