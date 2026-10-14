// ProxiSpeak - Database Setup
// Run this file using mongosh from the project root.

const proxiSpeakDb = db.getSiblingDB("proxispeak");

const numberTypes = ["double", "int", "long", "decimal"];

// Create a collection if missing; otherwise update its validator.
function ensureCollection(name, schema) {
    const validator = {
        $jsonSchema: schema
    };

    const existing = proxiSpeakDb.getCollectionInfos({
        name: name
    });

    if (existing.length === 0) {
        proxiSpeakDb.createCollection(name, {
            validator: validator,
            validationLevel: "strict",
            validationAction: "error"
        });

        print("Created collection: " + name);
    } else {
        proxiSpeakDb.runCommand({
            collMod: name,
            validator: validator,
            validationLevel: "strict",
            validationAction: "error"
        });

        print("Updated validator: " + name);
    }
}

// 1. USERS
ensureCollection("users", {
    bsonType: "object",
    required: [
        "displayName",
        "avatar",
        "isActive",
        "createdAt",
        "updatedAt"
    ],
    properties: {
        displayName: {
            bsonType: "string",
            minLength: 1,
            maxLength: 50
        },
        email: {
            bsonType: "string"
        },
        avatar: {
            bsonType: "object",
            required: ["styleId"],
            properties: {
                styleId: {
                    bsonType: "string",
                    minLength: 1
                },
                color: {
                    bsonType: "string"
                }
            }
        },
        isActive: {
            bsonType: "bool"
        },
        createdAt: {
            bsonType: "date"
        },
        updatedAt: {
            bsonType: "date"
        }
    }
});

// 2. ROOMS
ensureCollection("rooms", {
    bsonType: "object",
    required: [
        "name",
        "slug",
        "status",
        "coordinateSystem",
        "interactionRadius"
    ],
    properties: {
        name: {
            bsonType: "string",
            minLength: 1
        },
        slug: {
            bsonType: "string",
            minLength: 1
        },
        status: {
            enum: ["active", "inactive"]
        },
        coordinateSystem: {
            bsonType: "object",
            required: [
                "type",
                "unit",
                "min",
                "max",
                "xDirection",
                "yDirection"
            ],
            properties: {
                type: {
                    enum: ["cartesian-2d"]
                },
                unit: {
                    enum: ["virtual-unit"]
                },
                min: {
                    bsonType: numberTypes,
                    enum: [0]
                },
                max: {
                    bsonType: numberTypes,
                    enum: [1000]
                },
                xDirection: {
                    enum: ["right"]
                },
                yDirection: {
                    enum: ["down"]
                }
            }
        },
        interactionRadius: {
            bsonType: numberTypes,
            minimum: 1
        },
        layoutVersion: {
            bsonType: ["int", "long"]
        },
        layout: {
            bsonType: "object"
        }
    }
});

// 3. LIVE POSITIONS
ensureCollection("livePositions", {
    bsonType: "object",
    required: [
        "userId",
        "roomId",
        "position",
        "presence",
        "sessionId",
        "lastUpdatedAt",
        "expiresAt"
    ],
    properties: {
        userId: {
            bsonType: "objectId"
        },
        roomId: {
            bsonType: "objectId"
        },
        position: {
            bsonType: "array",
            minItems: 2,
            maxItems: 2,
            items: {
                bsonType: numberTypes,
                minimum: 0,
                maximum: 1000
            }
        },
        presence: {
            enum: ["online", "away"]
        },
        sessionId: {
            bsonType: "string"
        },
        lastUpdatedAt: {
            bsonType: "date"
        },
        expiresAt: {
            bsonType: "date"
        }
    }
});

// INDEXES

// Optional email must be unique when supplied.
proxiSpeakDb.users.createIndex(
    { email: 1 },
    {
        unique: true,
        sparse: true,
        name: "users_email_unique"
    }
);

// Each room gets a unique URL-friendly identifier.
proxiSpeakDb.rooms.createIndex(
    { slug: 1 },
    {
        unique: true,
        name: "rooms_slug_unique"
    }
);

// Flat 2D index for virtual office coordinates.
proxiSpeakDb.livePositions.createIndex(
    { position: "2d", roomId: 1 },
    {
        min: 0,
        max: 1000,
        name: "live_position_2d_room"
    }
);

// Version 1 allows one live position per user.
proxiSpeakDb.livePositions.createIndex(
    { userId: 1 },
    {
        unique: true,
        name: "live_user_unique"
    }
);

// Quickly filter positions by room and presence.
proxiSpeakDb.livePositions.createIndex(
    { roomId: 1, presence: 1 },
    {
        name: "live_room_presence"
    }
);

// Expire abandoned position records eventually.
// Queries must still check expiresAt > the current time.
proxiSpeakDb.livePositions.createIndex(
    { expiresAt: 1 },
    {
        expireAfterSeconds: 0,
        name: "live_expiry_ttl"
    }
);

print("ProxiSpeak database setup completed.");
print("Database: " + proxiSpeakDb.getName());
print("Collections: users, rooms, livePositions");