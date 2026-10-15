const { MongoClient, ObjectId } = require("mongodb");
const { findNearbyUsers } = require("./proximity");

async function main() {
  const client = new MongoClient("mongodb://127.0.0.1:27017");

  try {
    await client.connect();

    const db = client.db("proxispeak");
    const livePositions = db.collection("livePositions");

    const nearbyUsers = await findNearbyUsers(
      livePositions,
      new ObjectId("650000000000000000000010"),
      new ObjectId("650000000000000000000001"),
      400,
      500,
      100
    );

    console.log("Nearby users found:", nearbyUsers.length);
    console.log(nearbyUsers);
  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    await client.close();
  }
}

main();