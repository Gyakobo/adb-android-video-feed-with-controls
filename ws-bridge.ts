import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { DeviceSession, TouchPayload } from "./session";
import { VideoPacket } from "./protocol";

// ── Message shapes (client ↔ server) ─────────────────────────────────────────

type ServerMsg =
  | { type: "devices"; devices: { serial: string; name: string }[] }
  | { type: "frame"; serial: string; isConfig: boolean; pts: string; data: string } // data = base64
  | { type: "sessionStarted"; serial: string; name: string }
  | { type: "sessionClosed"; serial: string }
  | { type: "error"; serial: string; message: string };

type ClientMsg =
  | { type: "startSession"; serial: string }
  | { type: "stopSession"; serial: string }
  | { type: "touch"; serial: string; payload: TouchPayload }
  | { type: "key"; serial: string; key: "back" | "home" | "appswitch" };

export class WsBridge {
  private wss: WebSocketServer;
  private sessions = new Map<string, DeviceSession>();
  // Track which clients subscribed to which serial
  private subscribers = new Map<string, Set<WebSocket>>();

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws) => this.handleClient(ws));
  }

  private handleClient(ws: WebSocket): void {
    console.log("[ws] client connected");

    ws.on("message", async (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        return;
      }

      switch (msg.type) {
        case "startSession":
          await this.startSession(ws, msg.serial);
          break;
        case "stopSession":
          this.stopSession(msg.serial);
          break;
        case "touch":
          this.sessions.get(msg.serial)?.sendTouch(msg.payload);
          break;
        case "key":
          this.handleKey(msg.serial, msg.key);
          break;
      }
    });

    ws.on("close", () => {
      console.log("[ws] client disconnected");
      // Clean up subscriber entries
      for (const [serial, subs] of this.subscribers) {
        subs.delete(ws);
        if (subs.size === 0) this.subscribers.delete(serial);
      }
    });
  }

  private async startSession(ws: WebSocket, serial: string): Promise<void> {
    // Subscribe this ws to frames for this serial
    if (!this.subscribers.has(serial)) {
      this.subscribers.set(serial, new Set());
    }
    this.subscribers.get(serial)!.add(ws);

    // If session already running just ack
    if (this.sessions.has(serial)) {
      const s = this.sessions.get(serial)!;
      this.send(ws, {
        type: "sessionStarted",
        serial,
        name: s.deviceName,
      });
      return;
    }

    // Lazy-import to avoid circular deps
    const { listDevices } = await import("./adb");
    const devices = await listDevices();
    const device = devices.find((d) => d.serial === serial);
    if (!device) {
      this.send(ws, { type: "error", serial, message: "Device not found" });
      return;
    }

    const session = new DeviceSession(device);
    this.sessions.set(serial, session);

    session.on("deviceName", (name: string) => {
      this.broadcast(serial, { type: "sessionStarted", serial, name });
    });

    session.on("frame", (pkt: VideoPacket) => {
      const subs = this.subscribers.get(serial);
      if (!subs || subs.size === 0) return;
      const msg: ServerMsg = {
        type: "frame",
        serial,
        isConfig: pkt.isConfig,
        pts: pkt.pts.toString(),
        data: pkt.data.toString("base64"),
      };
      const encoded = JSON.stringify(msg);
      subs.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(encoded);
        }
      });
    });

    session.on("error", (message: string) => {
      this.broadcast(serial, { type: "error", serial, message });
    });

    session.on("closed", () => {
      this.sessions.delete(serial);
      this.broadcast(serial, { type: "sessionClosed", serial });
    });

    try {
      await session.start();
    } catch (e) {
      this.sessions.delete(serial);
      this.broadcast(serial, {
        type: "error",
        serial,
        message: `Failed to start session: ${e}`,
      });
    }
  }

  private stopSession(serial: string): void {
    this.sessions.get(serial)?.close();
  }

  private handleKey(serial: string, key: ClientMsg & { type: "key" } extends { key: infer K } ? K : never): void {
    const s = this.sessions.get(serial);
    if (!s) return;
    if (key === "back") s.sendBack();
    else if (key === "home") s.sendHome();
    else if (key === "appswitch") s.sendAppSwitch();
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(serial: string, msg: ServerMsg): void {
    const subs = this.subscribers.get(serial);
    if (!subs) return;
    const encoded = JSON.stringify(msg);
    subs.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoded);
    });
    // Also broadcast to all clients (for sessionClosed, deviceName etc.)
    this.wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoded);
    });
  }

  getSessions(): Map<string, DeviceSession> {
    return this.sessions;
  }
}
