const BASE = "http://localhost:3000";

async function runTest() {
  console.log("=== Verifying Ammo Fix ===");

  try {
    // 1. Register
    console.log("Step 1: Registering...");
    const username = "AmmoTester_" + Math.random().toString(36).slice(2, 8);
    const regRes = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    const regData = await regRes.json();
    if (!regRes.ok || !regData.player_id) {
      console.error("Register failed:", regData);
      process.exit(1);
    }
    const playerId = regData.player_id;
    console.log(`Registered: ${playerId}`);

    // 2. Burst shoot
    console.log("Step 2: Sending burst actions (50 shots)...");
    const actionPromises = [];
    for (let i = 0; i < 50; i++) {
      actionPromises.push(
        fetch(`${BASE}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            player_id: playerId,
            action: "shoot",
            angle: 0,
          }),
        }).catch(() => ({ ok: false })),
      );
    }
    await Promise.all(actionPromises);

    // 3. Inspect state immediately
    console.log("Step 3: Checking immediate state...");
    const stateRes = await fetch(`${BASE}/state?player_id=${playerId}`);
    const stateData = await stateRes.json();
    if (!stateData.self) {
      console.error("State data missing self! Full response:", stateData);
      process.exit(1);
    }
    console.log(`Ammo right after burst: ${stateData.self.ammo}`);
    console.log(
      `Reload CD right after burst: ${stateData.self.reloadCooldown}`,
    );

    // 4. Wait for refill and check
    console.log(
      "Step 4: Waiting 1200ms for reload then checking final ammo...",
    );
    await new Promise((r) => setTimeout(r, 1200));

    const stateRes2 = await fetch(`${BASE}/state?player_id=${playerId}`);
    const stateData2 = await stateRes2.json();
    if (!stateData2.self) {
      console.error("State data missing self! Full response:", stateData2);
      process.exit(1);
    }
    console.log(`Ammo after refill: ${stateData2.self.ammo}`);

    if (stateData2.self.ammo === 50) {
      console.log("SUCCESS: Ammo is auto-refilled to 50.");
    } else {
      console.error("FAIL: Ammo did not refill.");
      process.exit(1);
    }

    console.log("=== Verification Complete ===");
  } catch (error) {
    console.error("Test failed with error:", error.message);
    process.exit(1);
  }
}

runTest();
