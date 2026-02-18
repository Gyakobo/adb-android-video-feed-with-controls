import * as net from "net";
import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  pushServer,
  setupForward,
  removeForward,
  startServerProcess,
  connectVideoSocket,
  AdbDevice,
} from "./adb";
import {
  VideoStreamParser,
  VideoPacket,
  buildTouchEvent,
  buildBackButton,
  buildHomeButton,
  buildAppSwitchButton,
  AndroidMotionEventAction,
} from "./protocol";

export type SessionEvent =
  | { type: "deviceName"; name: string }
  | { type: "frame"; data: Buffer; isConfig: boolean; pts: bigint }
  | { type: "error"; message: string }
  | { type: "closed" };

export interface TouchPayload {
  action: "down" | "up" | "move";
  pointerId: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
}

// Port range base — each device gets base+index*2 (video) and base+index*2+1 (control)
const PORT_BASE = 27200;
let portCounter = 0;

function nextPorts(): { videoPort: number } {
  const videoPort = PORT_BASE + portCounter++ * 2;
  return { videoPort };
}

export class DeviceSession extends EventEmitter {
  readonly serial: string;
  readonly device: AdbDevice;

  private videoPort: number;
  private serverProc: ChildProcess | null = null;
  private videoSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;
  private parser: VideoStreamParser;
  private _closed = false;
  private _deviceName = "unknown";

  constructor(device: AdbDevice) {
    super();
    this.device = device;
    this.serial = device.serial;
    this.parser = new VideoStreamParser();
    const { videoPort } = nextPorts();
    this.videoPort = videoPort;
  }

  get deviceName(): string {
    return this._deviceName;
  }

  async start(): Promise<void> {
    console.log(`[${this.serial}] Starting session on port ${this.videoPort}`);

    try {
      await pushServer(this.serial);
    } catch (e) {
      // If push fails (jar not found locally), warn but continue — may already be there
      console.warn(`[${this.serial}] Push warning: ${e}`);
    }

    await setupForward(this.serial, this.videoPort);

    // Start the device-side server
    this.serverProc = startServerProcess(this.serial, this.videoPort);

    // Give the server a moment to start listening
    await sleep(500);

    // Open video socket (with retries built into connectVideoSocket)
    const videoSock = await connectVideoSocket(this.videoPort);
    this.videoSocket = videoSock;

    // The video socket also accepts control messages (same socket for simplicity)
    // Scrcpy actually uses two separate sockets; here we open a second connection
    // on the same forwarded port for control.
    try {
      this.controlSocket = await connectVideoSocket(this.videoPort);
    } catch (_) {
      console.warn(`[${this.serial}] Control socket unavailable — input disabled`);
    }

    // Wire up the parser
    this.parser.onPacket = (pkt: VideoPacket) => {
      if (pkt.isConfig) {
        console.log(`[${this.serial}] Codec config packet (${pkt.data.length} bytes)`);
      }
      this.emit("frame", pkt);
    };

    videoSock.on("data", (chunk: Buffer) => {
      this.parser.push(chunk);
      // Once the parser reads the device name emit it
      if (this._deviceName !== this.parser.deviceName) {
        this._deviceName = this.parser.deviceName;
        this.emit("deviceName", this._deviceName);
      }
    });

    videoSock.on("close", () => {
      if (!this._closed) this.close();
    });

    videoSock.on("error", (err) => {
      this.emit("error", err.message);
      this.close();
    });

    console.log(`[${this.serial}] Session started`);
  }

  sendTouch(payload: TouchPayload): void {
    if (!this.controlSocket || this._closed) return;
    const actionMap: Record<string, AndroidMotionEventAction> = {
      down: AndroidMotionEventAction.DOWN,
      up: AndroidMotionEventAction.UP,
      move: AndroidMotionEventAction.MOVE,
    };
    const msg = buildTouchEvent(
      actionMap[payload.action],
      payload.pointerId,
      payload.x,
      payload.y,
      payload.screenWidth,
      payload.screenHeight
    );
    this.controlSocket.write(msg);
  }

  sendBack(): void {
    buildBackButton().forEach((b) => this.controlSocket?.write(b));
  }

  sendHome(): void {
    buildHomeButton().forEach((b) => this.controlSocket?.write(b));
  }

  sendAppSwitch(): void {
    buildAppSwitchButton().forEach((b) => this.controlSocket?.write(b));
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    console.log(`[${this.serial}] Closing session`);

    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.serverProc?.kill("SIGTERM");
    removeForward(this.serial, this.videoPort).catch(() => {});

    this.emit("closed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}