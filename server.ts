import type { Serve } from "bun";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

// ---------------- CONFIGURATION ----------------

const PORT = Number(Bun.env.CALL_SERVER_PORT ?? 3001);
const FRONTEND_ORIGIN = Bun.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const RING_TIMEOUT_MS = 60_000;
const RECORDINGS_DIR = "./recordings";
const MAX_RECORDING_SIZE = 100 * 1024 * 1024;

type SocketData = { number: string };
type User = { number: string; online: boolean };
type CallStatus = "ringing" | "connected" | "ended";
type Call = {
  id: string;
  caller: string;
  receiver: string;
  status: CallStatus;
  createdAt: number;
  expiresAt: number;
};

type ClientSocket = {
  readonly readyState: number;
  readonly data: SocketData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
};

// ---------------- IN-MEMORY STORAGE ----------------

const users = new Map<string, User>();
const sockets = new Map<string, ClientSocket>();
const calls = new Map<string, Call>();
const ringTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------- HELPERS ----------------

function validNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

function corsHeaders(req: Request): Headers {
  const headers = new Headers();
  const origin = req.headers.get("origin");

  if (origin && origin === FRONTEND_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  return headers;
}

function json(req: Request, data: object, status = 200): Response {
  const headers = corsHeaders(req);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function send(number: string, data: object): boolean {
  const socket = sockets.get(number);
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify(data));
  return true;
}

function isOnline(number: string): boolean {
  const socket = sockets.get(number);
  return Boolean(socket && socket.readyState === 1);
}

function hasActiveCall(number: string): boolean {
  for (const call of calls.values()) {
    if (
      call.status !== "ended" &&
      (call.caller === number || call.receiver === number)
    ) {
      return true;
    }
  }
  return false;
}

function clearRingTimer(callId: string): void {
  const timer = ringTimers.get(callId);
  if (timer) clearTimeout(timer);
  ringTimers.delete(callId);
}

/** Server-authoritative expiry. The deadline is also checked inside accept. */
function expireRingingCall(call: Call): void {
  if (call.status !== "ringing") return;

  call.status = "ended";
  clearRingTimer(call.id);

  send(call.caller, {
    type: "no-answer",
    callId: call.id,
    from: call.receiver,
  });

  send(call.receiver, {
    type: "missed",
    callId: call.id,
    from: call.caller,
  });

  console.log(`Call timed out after 60 seconds: ${call.id}`);
}

function finishCall(call: Call): void {
  if (call.status === "ended") return;
  clearRingTimer(call.id);
  call.status = "ended";
}

// ---------------- RECORDING CONVERSION ----------------

async function convertRecording(callId: string, blob: Blob) {
  await mkdir(RECORDINGS_DIR, { recursive: true });

  const safeId = callId.replace(/[^a-zA-Z0-9_-]/g, "");
  const input = `${RECORDINGS_DIR}/${safeId}.webm`;
  const output = `${RECORDINGS_DIR}/${safeId}.mp3`;

  await Bun.write(input, blob);

  const ffmpeg = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      output,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  const exitCode = await ffmpeg.exited;
  if (exitCode !== 0) throw new Error("FFmpeg MP3 conversion failed");

  return { filename: `${safeId}.mp3`, path: output };
}

// ---------------- BUN SERVER ----------------

const serverOptions: Serve.Options<SocketData> = {
  tls: {
    cert: Bun.file("./localhost+2.pem"),
    key: Bun.file("./localhost+2-key.pem"),
  },
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      const headers = corsHeaders(req);
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }

    // Health check
    if (path === "/api/health" && method === "GET") {
      return json(req, {
        success: true,
        service: "internet-calling",
        onlineUsers: sockets.size,
        activeCalls: [...calls.values()].filter((c) => c.status !== "ended")
          .length,
        ringTimeoutSeconds: RING_TIMEOUT_MS / 1000,
      });
    }

    // Register a six-digit calling ID
    if (path === "/api/register" && method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      const number =
        body && typeof body === "object" && "number" in body
          ? (body as { number?: unknown }).number
          : null;

      if (!validNumber(number)) {
        return json(req, { error: "Enter a valid six-digit number" }, 400);
      }
      if (users.has(number)) {
        return json(req, { error: "This number is already registered" }, 409);
      }

      users.set(number, { number, online: false });
      return json(req, { success: true, number });
    }

    // Create a call and notify the receiver
    if (path === "/api/calls" && method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      const from =
        body && typeof body === "object" && "from" in body
          ? (body as { from?: unknown }).from
          : null;
      const to =
        body && typeof body === "object" && "to" in body
          ? (body as { to?: unknown }).to
          : null;

      if (!validNumber(from) || !validNumber(to)) {
        return json(req, { error: "Invalid six-digit number" }, 400);
      }
      if (from === to) {
        return json(req, { error: "You cannot call yourself" }, 400);
      }
      if (!users.has(from) || !users.has(to)) {
        return json(req, { error: "Number does not exist" }, 404);
      }
      if (!isOnline(from) || !isOnline(to)) {
        return json(req, { error: "One or both users are offline" }, 409);
      }
      if (hasActiveCall(from) || hasActiveCall(to)) {
        return json(
          req,
          { error: "One of the users is already in a call" },
          409,
        );
      }

      const now = Date.now();
      const callId = `call_${randomUUID()}`;
      const call: Call = {
        id: callId,
        caller: from,
        receiver: to,
        status: "ringing",
        createdAt: now,
        expiresAt: now + RING_TIMEOUT_MS,
      };

      calls.set(callId, call);

      const delivered = send(to, {
        type: "incoming",
        callId,
        from,
        expiresAt: call.expiresAt,
        ringTimeoutMs: RING_TIMEOUT_MS,
      });

      if (!delivered) {
        calls.delete(callId);
        return json(req, { error: "Receiver disconnected" }, 409);
      }

      const timer = setTimeout(() => expireRingingCall(call), RING_TIMEOUT_MS);
      ringTimers.set(callId, timer);

      return json(req, {
        success: true,
        callId,
        status: "ringing",
        expiresAt: call.expiresAt,
        ringTimeoutMs: RING_TIMEOUT_MS,
      });
    }

    // Save a call recording as MP3
    if (path === "/api/recordings" && method === "POST") {
      const callId = url.searchParams.get("callId");
      const call = callId ? calls.get(callId) : undefined;
      if (!call) return json(req, { error: "Invalid call ID" }, 404);

      const contentLength = Number(req.headers.get("content-length") ?? 0);
      if (contentLength > MAX_RECORDING_SIZE) {
        return json(req, { error: "Recording exceeds 100 MB" }, 413);
      }

      const blob = await req.blob();
      if (blob.size === 0 || blob.size > MAX_RECORDING_SIZE) {
        return json(req, { error: "Invalid recording size" }, 400);
      }

      try {
        const result = await convertRecording(call.id, blob);
        return json(req, {
          success: true,
          filename: result.filename,
          savedAt: result.path,
        });
      } catch (error) {
        console.error("Recording conversion error:", error);
        return json(req, { error: "Unable to convert recording to MP3" }, 500);
      }
    }

    // WebSocket connection
    if (path === "/ws" && method === "GET") {
      const number = url.searchParams.get("number");
      const origin = req.headers.get("origin");

      if (origin && origin !== FRONTEND_ORIGIN) {
        return new Response("Origin not allowed", { status: 403 });
      }
      if (!validNumber(number) || !users.has(number)) {
        return new Response("Unregistered number", { status: 401 });
      }

      const upgraded = server.upgrade(req, { data: { number } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return json(req, { error: "Endpoint not found" }, 404);
  },

  websocket: {
    data: {} as SocketData,

    open(ws) {
      const number = ws.data.number;
      const previous = sockets.get(number);
      if (previous && previous !== ws) {
        previous.close(4001, "Another session connected");
      }

      sockets.set(number, ws);
      users.set(number, { number, online: true });
      ws.send(JSON.stringify({ type: "registered", number }));
      console.log(`User ${number} connected`);
    },

    message(ws, raw) {
      const number = ws.data.number;
      let message: Record<string, unknown>;

      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (!parsed || typeof parsed !== "object") return;
        message = parsed as Record<string, unknown>;
      } catch {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Invalid WebSocket message",
          }),
        );
        return;
      }

      const type = message.type;
      const callId = message.callId;
      if (typeof type !== "string" || typeof callId !== "string") return;

      const call = calls.get(callId);
      if (
        !call ||
        call.status === "ended" ||
        (number !== call.caller && number !== call.receiver)
      )
        return;

      const other = number === call.caller ? call.receiver : call.caller;

      if (type === "accept") {
        if (number !== call.receiver || call.status !== "ringing") return;

        // Enforce the exact deadline even if the timer callback is delayed.
        if (Date.now() >= call.expiresAt) {
          expireRingingCall(call);
          send(number, { type: "call-expired", callId });
          return;
        }

        clearRingTimer(callId);
        call.status = "connected";
        send(call.caller, { type: "accepted", callId });
        send(call.receiver, { type: "accepted-confirmed", callId });
        console.log(`Call accepted: ${callId}`);
        return;
      }

      if (type === "reject") {
        if (number !== call.receiver || call.status !== "ringing") return;
        clearRingTimer(callId);
        call.status = "ended";
        send(call.caller, { type: "rejected", callId });
        send(call.receiver, { type: "rejected-confirmed", callId });
        console.log(`Call rejected: ${callId}`);
        return;
      }

      if (type === "hangup") {
        finishCall(call);
        send(other, { type: "hangup", callId });
        console.log(`Call ended: ${callId}`);
        return;
      }

      // Only relay WebRTC negotiation after the receiver has accepted.
      if (call.status !== "connected") return;

      if (type === "offer" && message.offer) {
        send(other, {
          type: "offer",
          callId,
          from: number,
          offer: message.offer,
        });
      } else if (type === "answer" && message.answer) {
        send(other, {
          type: "answer",
          callId,
          from: number,
          answer: message.answer,
        });
      } else if (type === "ice" && message.candidate) {
        send(other, {
          type: "ice",
          callId,
          from: number,
          candidate: message.candidate,
        });
      }
    },

    close(ws) {
      const number = ws.data.number;
      // Ignore the close event from an older replaced connection.
      if (sockets.get(number) !== ws) return;

      sockets.delete(number);
      const user = users.get(number);
      if (user) user.online = false;

      for (const call of calls.values()) {
        if (
          call.status !== "ended" &&
          (call.caller === number || call.receiver === number)
        ) {
          const wasRinging = call.status === "ringing";
          clearRingTimer(call.id);
          call.status = "ended";
          const other = call.caller === number ? call.receiver : call.caller;
          send(other, {
            type: wasRinging ? "unavailable" : "hangup",
            callId: call.id,
          });
        }
      }

      console.log(`User ${number} disconnected`);
    },
  },
};

const server = Bun.serve(serverOptions);

console.log("-----------------------------------");
console.log(" INTERNET CALLING SERVER");
console.log("-----------------------------------");
console.log(`HTTP API : http://localhost:${PORT}`);
console.log(`WEBSOCKET: ws://localhost:${PORT}/ws`);
console.log(`FRONTEND : ${FRONTEND_ORIGIN}`);
console.log(`RING TIME: ${RING_TIMEOUT_MS / 1000} seconds`);
console.log("-----------------------------------");

export default server;
