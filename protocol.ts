/**
 * scrcpy binary protocol helpers.
 *
 * VIDEO STREAM (per packet):
 *   [8 bytes pts] [4 bytes size] [size bytes payload]
 *   - pts: uint64 big-endian microseconds (0xFFFFFFFFFFFFFFFF = config packet)
 *   - size: uint32 big-endian
 *
 * DEVICE METADATA (first message on video socket):
 *   [1 byte dummy] [64 bytes device name, null-padded]
 *
 * CONTROL MESSAGES (client -> device):
 *   Byte 0: message type
 *   Remainder: type-specific payload
 */

export interface VideoPacket {
  pts: bigint; // microseconds; 0xFFFFFFFFFFFFFFFFn = codec config
  isConfig: boolean;
  data: Buffer;
}

export const PTS_CONFIG = 0xffffffffffffffffn;

// ── Control message types ─────────────────────────────────────────────────────

export const enum ControlMsgType {
  INJECT_KEYCODE = 0,
  INJECT_TEXT = 1,
  INJECT_TOUCH_EVENT = 2,
  INJECT_SCROLL_EVENT = 3,
  BACK_OR_SCREEN_ON = 4,
  EXPAND_NOTIFICATION_PANEL = 5,
  EXPAND_SETTINGS_PANEL = 6,
  COLLAPSE_PANELS = 7,
  GET_CLIPBOARD = 8,
  SET_CLIPBOARD = 9,
  SET_SCREEN_POWER_MODE = 10,
  ROTATE_DEVICE = 11,
}

export const enum AndroidKeyEventAction {
  DOWN = 0,
  UP = 1,
}

export const enum AndroidMotionEventAction {
  DOWN = 0,
  UP = 1,
  MOVE = 2,
}

export const enum AndroidKeycode {
  KEYCODE_BACK = 4,
  KEYCODE_HOME = 3,
  KEYCODE_APP_SWITCH = 187,
  KEYCODE_VOLUME_UP = 24,
  KEYCODE_VOLUME_DOWN = 25,
}

// ── Packet parsing ────────────────────────────────────────────────────────────

/**
 * Stateful stream parser. Feed raw TCP chunks via push(); get packets via
 * an event callback.
 */
export class VideoStreamParser {
  private buf: Buffer = Buffer.alloc(0);
  private metaRead = false;
  public deviceName = "unknown";

  onPacket?: (packet: VideoPacket) => void;

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  private drain(): void {
    // First message: 1 dummy byte + 64-byte device name
    if (!this.metaRead) {
      if (this.buf.length < 65) return;
      // byte 0 is dummy
      this.deviceName = this.buf
        .slice(1, 65)
        .toString("utf8")
        .replace(/\0/g, "");
      this.buf = this.buf.slice(65);
      this.metaRead = true;
    }

    // Read frame packets: 8-byte PTS + 4-byte size + data
    while (true) {
      if (this.buf.length < 12) break;

      const ptsHigh = this.buf.readUInt32BE(0);
      const ptsLow = this.buf.readUInt32BE(4);
      const pts = (BigInt(ptsHigh) << 32n) | BigInt(ptsLow);
      const size = this.buf.readUInt32BE(8);

      if (this.buf.length < 12 + size) break;

      const data = this.buf.slice(12, 12 + size);
      this.buf = this.buf.slice(12 + size);

      this.onPacket?.({
        pts,
        isConfig: pts === PTS_CONFIG,
        data: Buffer.from(data), // copy to avoid slice retention
      });
    }
  }
}

// ── Control message builders ──────────────────────────────────────────────────

export function buildTouchEvent(
  action: AndroidMotionEventAction,
  pointerId: number,
  x: number,
  y: number,
  screenWidth: number,
  screenHeight: number,
  pressure: number = 1.0
): Buffer {
  // Type(1) + action(1) + buttons(4) + pointerId(8) + x(4) + y(4) +
  // screenW(2) + screenH(2) + pressure(2)  = 28 bytes
  const buf = Buffer.alloc(28);
  let offset = 0;
  buf.writeUInt8(ControlMsgType.INJECT_TOUCH_EVENT, offset++);
  buf.writeUInt8(action, offset++);
  buf.writeInt32BE(0, offset); offset += 4; // buttons (unused)
  buf.writeBigInt64BE(BigInt(pointerId), offset); offset += 8;
  buf.writeInt32BE(Math.round(x), offset); offset += 4;
  buf.writeInt32BE(Math.round(y), offset); offset += 4;
  buf.writeUInt16BE(screenWidth, offset); offset += 2;
  buf.writeUInt16BE(screenHeight, offset); offset += 2;
  buf.writeUInt16BE(Math.round(pressure * 0xffff), offset); offset += 2;
  return buf;
}

export function buildKeycode(
  action: AndroidKeyEventAction,
  keycode: AndroidKeycode,
  metaState = 0
): Buffer {
  // Type(1) + action(1) + keycode(4) + repeat(4) + metaState(4) = 14 bytes
  const buf = Buffer.alloc(14);
  let offset = 0;
  buf.writeUInt8(ControlMsgType.INJECT_KEYCODE, offset++);
  buf.writeUInt8(action, offset++);
  buf.writeInt32BE(keycode, offset); offset += 4;
  buf.writeInt32BE(0, offset); offset += 4; // repeat
  buf.writeInt32BE(metaState, offset);
  return buf;
}

export function buildBackButton(): Buffer[] {
  return [
    buildKeycode(AndroidKeyEventAction.DOWN, AndroidKeycode.KEYCODE_BACK),
    buildKeycode(AndroidKeyEventAction.UP, AndroidKeycode.KEYCODE_BACK),
  ];
}

export function buildHomeButton(): Buffer[] {
  return [
    buildKeycode(AndroidKeyEventAction.DOWN, AndroidKeycode.KEYCODE_HOME),
    buildKeycode(AndroidKeyEventAction.UP, AndroidKeycode.KEYCODE_HOME),
  ];
}

export function buildAppSwitchButton(): Buffer[] {
  return [
    buildKeycode(AndroidKeyEventAction.DOWN, AndroidKeycode.KEYCODE_APP_SWITCH),
    buildKeycode(AndroidKeyEventAction.UP, AndroidKeycode.KEYCODE_APP_SWITCH),
  ];
}
