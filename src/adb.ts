import { exec, spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import * as net from "net";
import { EventEmitter } from "events";

const execAsync = promisify(exec);

export interface AdbDevice {
    serial: string;
    state: string
    model?: string;
}

export interface DeviceStream {
    serial: string;
    videoSocket: net.Socket | null;
    controlSocket: net.Socket | null;
    serverProcess: ChildProcess | null;
    port: number;
    controlPort: number;
}

// The scrcpy jar version we ship - must match the jar in /public/server/
export const SCRCPY_SERVER_VERSION = "3.1";
export const SCRCPY_SERVER_LOCAL_PATH = `${__dirname}/../../public/server/scrcpy-server.jar`;
export const SCRCPY_SERVER_DEVICE_PATH = "/data/local/tmp/scrcpy-server.jar";

export async function listDevices(): Promise<AdbDevice[]> {
    const { stdout } = await execAsync("adb devices -l");
    const lines = stdout.trim().split("\n").slice(1); // skip "List of devices attached"
    const devices: AdbDevice[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const serial = parts[0];
        const state = parts[1];
        if (!serial || !state || state === "offline") continue;

        // Extract model from key=value pairs
        const modelEntry = parts.find((p) => p.startsWith("model:"));
        const model = modelEntry ? modelEntry.replace("model:", "") : serial;

        devices.push({serial, state, model});
    }

    return devices;
}

export async function pushServer(serial: string): Promise<void> {
    // Only push if the file doesn't already exist with same size (quick check)
    try {
        await execAsync(
            `adb -s ${serial} push "{SCRCPY_SERVER_LOCAL_PATH}" ${SCRCPY_SERVER_DEVICE_PATH}`
        );
        console.log(`[${serial}] Server pushed to device`);
    } catch (error) {
        throw new Error(`Failed to push server to ${serial}: ${e}`);
    }
}

export async function setupForward(serial: string, port: number): Promise<void> {
    await execAsync(
        `adb -s ${serial} forward tcp:${port} localabstract:scrcpy_${port}`
    );
    console.log(`[${serial}] ADB forward: tcp:${port} -> scrcpy_${port}`);
}

export async function setupControlForward(serial: string, port: number): Promise<void> {
    await execAsync(
        `adb -s ${serial} forward tcp:${port} localabstract:scrcpy_ctr_${port}`
    );
    console.log(`[${serial}] ADB control forward: tcp${port} -> scrcpy_ctrl_${port}`);
}


export async function removeForward(serial: string, port: number): Promise<void> {
    try {
        await execAsync(`adb -s ${serial} forward --remove tcp:${port}`)
    } catch (_) {
        // ignore - process may already be dead
    } 
}

export function startServerProcess(serial: string, videoPort: number): ChildProcess {
    // We use tunnel_forward so the device connects to a port we've forwarded
    const args = [
        "-s", serial,
        "shell",
        `CLASSPATH=${SCRCPY_SERVER_DEVICE_PATH}`,
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        SCRCPY_SERVER_VERSION,
        `tunnel_forward=true`,
        `audio=false`,
        `control=true`,
        `cleanup=true`,
        `send_frame_meta=true`,
        `raw_stream=false`,
        `max_size=1024`,
        `max_fps=30`,
        `video_bit_rate=2000000`,
        `lock_video_orientation=0`,
        `tunnel_host=localhost`,
        `tunnel_port=${videoPort}`,
        `scid=${videoPort}`,
    ];

    const proc = spawn("adb", args, {stdio: ["ignore", "pipe", "pipe"]})

    proc.stdout?.on("data", (d: Buffer) => {
        console.log(`[${serial}][server] Server: ${d.toString().trim()}`);
    });
    proc.stderr?.on("data", (d: Buffer) => {
        console.log(`[${serial}][server:err] Server: ${d.toString().trim()}`);
    });
    proc.on("data", (code) => {
        console.log(`[${serial}] Server process exited with code ${code}`);
    });

    return proc;
}

export function connectVideoSocket(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
    });
}