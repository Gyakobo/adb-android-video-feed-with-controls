import express from "express";
import * as http from "http";
import * as path from "path";
import { listDevices } from "./adb";
import { WsBridge } from "./ws-bridge";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const app = express();
const server = http.createServer(app);

// Static frontend
app.use(express.static(path.join(__dirname, "../../public")));
app.use(express.json());

// REST: list connected ADB devices
app.get("/api/devices", async (_req, res) => {
  try {
    const devices = await listDevices();
    res.json({ devices });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// WebSocket bridge (video + control)
const bridge = new WsBridge(server);

server.listen(PORT, () => {
  console.log(`\n🚀  scrcpy-server running at http://localhost:${PORT}`);
  console.log(`    WebSocket at  ws://localhost:${PORT}/ws`);
  console.log(`    REST API at   http://localhost:${PORT}/api/devices\n`);

  // Log connected devices on startup
  listDevices()
    .then((devs) => {
      if (devs.length === 0) {
        console.log("⚠️  No ADB devices connected. Connect a device and refresh the page.");
      } else {
        console.log(`📱  Found ${devs.length} device(s):`);
        devs.forEach((d) => console.log(`     • ${d.serial} (${d.model ?? d.serial})`));
      }
    })
    .catch(() => {
      console.warn("⚠️  Could not run adb — ensure ADB is installed and in PATH.");
    });
});

process.on("SIGINT", () => {
  console.log("\n👋  Shutting down...");
  bridge.getSessions().forEach((s) => s.close());
  server.close(() => process.exit(0));
});
