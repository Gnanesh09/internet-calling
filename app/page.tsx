"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleDot,
  Clock3,
  Delete,
  Headphones,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  UserRound,
  Volume2,
  X,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const WS = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001/ws";
const RING_TIMEOUT_MS = 60_000;

type IncomingCall = {
  callId: string;
  from: string;
  expiresAt: number;
};

type RingMode = "incoming" | "outgoing";
type CallStatus = "idle" | "ringing" | "connecting" | "connected";

export default function Home() {
  const [number, setNumber] = useState("");
  const [dial, setDial] = useState("");
  const [registered, setRegistered] = useState(false);
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [callId, setCallId] = useState("");
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState("");
  const [duration, setDuration] = useState(0);
  const [incomingSeconds, setIncomingSeconds] = useState(60);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingContextRef = useRef<AudioContext | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingCallIdRef = useRef("");
  const callIdRef = useRef("");
  const acceptedCallIdRef = useRef<string | null>(null);
  const incomingRef = useRef<IncomingCall | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // A Web Audio ringtone is generated locally; no audio file is required.
  const ringtoneContextRef = useRef<AudioContext | null>(null);
  const ringtoneIntervalRef = useRef<number | null>(null);
  const ringtoneModeRef = useRef<RingMode | null>(null);

  function send(data: object): boolean {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(data));
    return true;
  }

  function updateStatus(status: CallStatus) {
    setCallStatus(status);
  }

  async function prepareRingtoneAudio(): Promise<void> {
    if (typeof window === "undefined" || !("AudioContext" in window)) return;

    let context = ringtoneContextRef.current;
    if (!context || context.state === "closed") {
      context = new window.AudioContext();
      ringtoneContextRef.current = context;
    }

    // Call this from a user click (register / call) to unlock browser audio.
    if (context.state === "suspended") {
      await context.resume();
    }
  }

  function stopRingtone() {
    ringtoneModeRef.current = null;
    if (ringtoneIntervalRef.current !== null) {
      window.clearInterval(ringtoneIntervalRef.current);
      ringtoneIntervalRef.current = null;
    }
    // Keep the context alive so the next incoming call can ring without
    // trying to create a fresh AudioContext outside a user gesture.
  }

  function playRingtoneBurst(mode: RingMode) {
    const context = ringtoneContextRef.current;
    if (!context || context.state !== "running") return;

    const now = context.currentTime;
    const notes =
      mode === "incoming"
        ? [
            { frequency: 660, offset: 0 },
            { frequency: 880, offset: 0.22 },
          ]
        : [
            { frequency: 440, offset: 0 },
            { frequency: 480, offset: 0.16 },
          ];

    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startAt = now + note.offset;
      const endAt = startAt + 0.19;

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, startAt);
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(0.12, startAt + 0.025);
      gain.gain.setValueAtTime(0.12, endAt - 0.04);
      gain.gain.linearRampToValueAtTime(0, endAt);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(endAt);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    }
  }

  async function startRingtone(mode: RingMode) {
    stopRingtone();
    ringtoneModeRef.current = mode;

    try {
      await prepareRingtoneAudio();
      if (ringtoneModeRef.current !== mode) return;

      playRingtoneBurst(mode);
      ringtoneIntervalRef.current = window.setInterval(
        () => playRingtoneBurst(mode),
        mode === "incoming" ? 1_550 : 3_000,
      );
    } catch (error) {
      // Browser audio can be blocked until the user interacts with the page.
      console.warn("Ringtone could not start:", error);
    }
  }

  async function getMicrophone(): Promise<MediaStream> {
    if (
      typeof window === "undefined" ||
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      throw new Error(
        "Microphone requires HTTPS. Use http://localhost:3000 or an HTTPS address.",
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    localRef.current = stream;
    return stream;
  }

  async function register() {
    if (!/^\d{6}$/.test(number)) {
      setMessage("Choose a six-digit number");
      return;
    }

    // Unlock the Web Audio context from this click for future call sounds.
    void prepareRingtoneAudio().catch((error) =>
      console.warn("Audio unlock failed:", error),
    );

    try {
      const response = await fetch(`${API}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Registration failed");
      connectSocket(number);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Registration failed",
      );
    }
  }

  function connectSocket(phone: string) {
    const socket = new WebSocket(`${WS}?number=${encodeURIComponent(phone)}`);
    wsRef.current = socket;

    socket.onopen = () => {
      setRegistered(true);
      setMessage("");
    };

    socket.onmessage = async (event: MessageEvent<string>) => {
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.error("Invalid WebSocket payload", event.data);
        return;
      }

      if (data.type === "incoming") {
        const nextIncoming: IncomingCall = {
          callId: data.callId,
          from: data.from,
          expiresAt: Number(data.expiresAt) || Date.now() + RING_TIMEOUT_MS,
        };

        // Ignore duplicate delivery of the same invitation.
        if (incomingRef.current?.callId === nextIncoming.callId) return;
        incomingRef.current = nextIncoming;
        setIncoming(nextIncoming);
        setMessage("");
        await startRingtone("incoming");
        return;
      }

      if (data.type === "accepted") {
        acceptedCallIdRef.current = data.callId;
        stopRingtone();
        await createOffer(data.callId);
        return;
      }

      if (data.type === "accepted-confirmed") {
        stopRingtone();
        setIncoming(null);
        incomingRef.current = null;
        updateStatus("connecting");
        return;
      }

      if (data.type === "offer") {
        await receiveOffer(data);
        return;
      }

      if (data.type === "answer") {
        const pc = pcRef.current;
        if (pc) {
          await pc.setRemoteDescription(data.answer);
          await flushPendingIce();
        }
        return;
      }

      if (data.type === "ice") {
        try {
          await addOrQueueIce(data.candidate);
        } catch (error) {
          console.error("ICE candidate error:", error);
        }
        return;
      }

      if (data.type === "rejected") {
        stopRingtone();
        cleanupCall();
        setMessage("Call declined");
        return;
      }

      if (data.type === "no-answer") {
        stopRingtone();
        cleanupCall();
        setMessage("No answer — the call expired after 60 seconds");
        return;
      }

      if (data.type === "missed") {
        stopRingtone();
        cleanupCall();
        setMessage(`Missed call from ${data.from}`);
        return;
      }

      if (data.type === "call-expired") {
        stopRingtone();
        cleanupCall();
        setMessage(
          "This call invitation expired. It was not answered within 60 seconds.",
        );
        return;
      }

      if (data.type === "unavailable") {
        stopRingtone();
        cleanupCall();
        setMessage("The other person disconnected");
        return;
      }

      if (data.type === "hangup") {
        stopRingtone();
        cleanupCall();
        setMessage("Call ended");
      }
    };

    socket.onclose = () => {
      setRegistered(false);
      stopRingtone();
      cleanupCall();
      setMessage("Disconnected from calling server");
    };

    socket.onerror = () => setMessage("WebSocket connection error");
  }

  async function createPeerConnection(id: string, local: MediaStream) {
    pcRef.current?.close();

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pcRef.current = pc;
    pendingIceRef.current = [];

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        send({ type: "ice", callId: id, candidate: event.candidate.toJSON() });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      remoteRef.current = stream;

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.play().catch((error) => {
          console.warn("Remote audio playback needs user interaction:", error);
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        stopRingtone();
        updateStatus("connected");
        setMessage("");
      } else if (pc.connectionState === "failed") {
        setMessage(
          "Connection failed. A TURN server may be required on this network.",
        );
      } else if (pc.connectionState === "disconnected") {
        setMessage("Connection interrupted...");
      }
    };

    local.getTracks().forEach((track) => pc.addTrack(track, local));
    return pc;
  }

  async function startCall() {
    if (!/^\d{6}$/.test(dial)) {
      setMessage("Enter a valid six-digit number");
      return;
    }
    if (dial === number) {
      setMessage("You cannot call yourself");
      return;
    }
    if (!registered || wsRef.current?.readyState !== WebSocket.OPEN) {
      setMessage("Connect your calling ID first");
      return;
    }

    // Unlock sound while the click gesture is active.
    void prepareRingtoneAudio().catch((error) =>
      console.warn("Audio unlock failed:", error),
    );

    let local: MediaStream | null = null;
    try {
      local = await getMicrophone();

      const response = await fetch(`${API}/api/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: number, to: dial }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start call");

      callIdRef.current = data.callId;
      acceptedCallIdRef.current = null;
      setCallId(data.callId);
      updateStatus("ringing");
      setMessage("Ringing… waiting for an answer");
      await createPeerConnection(data.callId, local);
      // Do not start ringback if the receiver accepted during setup.
      if (acceptedCallIdRef.current !== data.callId) {
        await startRingtone("outgoing");
      }
    } catch (error) {
      local?.getTracks().forEach((track) => track.stop());
      if (localRef.current === local) localRef.current = null;
      cleanupCall();
      setMessage(
        error instanceof Error ? error.message : "Could not start call",
      );
    }
  }

  async function acceptCall() {
    const invitation = incomingRef.current;
    if (!invitation) return;

    stopRingtone();
    setMessage("Connecting…");

    try {
      const local = await getMicrophone();
      callIdRef.current = invitation.callId;
      setCallId(invitation.callId);
      await createPeerConnection(invitation.callId, local);

      const sent = send({ type: "accept", callId: invitation.callId });
      if (!sent) throw new Error("Calling server disconnected");

      setIncoming(null);
      incomingRef.current = null;
      updateStatus("connecting");
    } catch (error) {
      send({ type: "reject", callId: invitation.callId });
      cleanupCall();
      setMessage(
        error instanceof Error ? error.message : "Could not accept call",
      );
    }
  }

  function rejectCall() {
    const invitation = incomingRef.current;
    if (!invitation) return;

    stopRingtone();
    send({ type: "reject", callId: invitation.callId });
    incomingRef.current = null;
    setIncoming(null);
    setMessage("Call declined");
  }

  async function createOffer(id: string) {
    try {
      const pc = pcRef.current;
      if (!pc) throw new Error("Peer connection is not ready");

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: "offer", callId: id, offer: pc.localDescription });
      updateStatus("connecting");
    } catch (error) {
      console.error("Offer error:", error);
      setMessage("Unable to start the audio connection");
      hangup();
    }
  }

  async function receiveOffer(data: any) {
    try {
      const pc = pcRef.current;
      if (!pc) throw new Error("Peer connection is not ready");

      await pc.setRemoteDescription(data.offer);
      await flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({
        type: "answer",
        callId: data.callId,
        answer: pc.localDescription,
      });
      updateStatus("connecting");
    } catch (error) {
      console.error("Answer error:", error);
      setMessage("Unable to answer the audio connection");
      hangup();
    }
  }

  async function addOrQueueIce(candidate: RTCIceCandidateInit) {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      pendingIceRef.current.push(candidate);
      return;
    }
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async function flushPendingIce() {
    const pc = pcRef.current;
    if (!pc?.remoteDescription) return;

    const pending = pendingIceRef.current.splice(0);
    for (const candidate of pending) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  function toggleMute() {
    const nextMuted = !muted;
    localRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }

  async function startRecording() {
    const local = localRef.current;
    const remote = remoteRef.current;
    const idForRecording = callIdRef.current;

    if (!local || !remote || !idForRecording) {
      setMessage("Wait until the call audio is connected");
      return;
    }

    try {
      const context = new AudioContext();
      recordingContextRef.current = context;
      const destination = context.createMediaStreamDestination();
      const localSource = context.createMediaStreamSource(local);
      const remoteSource = context.createMediaStreamSource(remote);
      localSource.connect(destination);
      remoteSource.connect(destination);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(destination.stream, { mimeType });
      recorderRef.current = recorder;
      recordingCallIdRef.current = idForRecording;
      recordingChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(recordingChunksRef.current, {
          type: "audio/webm",
        });
        try {
          const response = await fetch(
            `${API}/api/recordings?callId=${encodeURIComponent(recordingCallIdRef.current)}`,
            {
              method: "POST",
              headers: { "Content-Type": "audio/webm" },
              body: blob,
            },
          );
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error ?? "Recording upload failed");
          setMessage(`Recording saved: ${result.filename}`);
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Recording upload failed",
          );
        } finally {
          await context.close().catch(() => undefined);
          if (recordingContextRef.current === context)
            recordingContextRef.current = null;
          setRecording(false);
          recorderRef.current = null;
        }
      };

      recorder.start(1_000);
      setRecording(true);
      setMessage("Recording started");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to start recording",
      );
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }

  function hangup() {
    const id = callIdRef.current || incomingRef.current?.callId;
    if (id) send({ type: "hangup", callId: id });

    stopRingtone();
    if (recorderRef.current?.state === "recording") stopRecording();
    cleanupCall();
    setMessage("Call ended");
  }

  function cleanupCall() {
    stopRingtone();
    pcRef.current?.close();
    pcRef.current = null;

    localRef.current?.getTracks().forEach((track) => track.stop());
    localRef.current = null;
    remoteRef.current = null;

    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

    pendingIceRef.current = [];
    callIdRef.current = "";
    acceptedCallIdRef.current = null;
    incomingRef.current = null;
    setIncoming(null);
    setCallId("");
    setMuted(false);
    updateStatus("idle");

    if (recorderRef.current?.state === "recording") {
      // Its onstop callback uploads using the captured call ID.
      recorderRef.current.stop();
    } else if (!recorderRef.current) {
      setRecording(false);
    }
  }

  // Show the server-provided one-minute deadline on the incoming-call card.
  useEffect(() => {
    if (!incoming) {
      setIncomingSeconds(60);
      return;
    }

    const updateCountdown = () => {
      const remaining = Math.max(0, incoming.expiresAt - Date.now());
      setIncomingSeconds(Math.ceil(remaining / 1_000));
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [incoming]);

  useEffect(() => {
    if (callStatus !== "connected") {
      setDuration(0);
      return;
    }

    const timer = window.setInterval(
      () => setDuration((value) => value + 1),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [callStatus]);

  useEffect(() => {
    return () => {
      stopRingtone();
      wsRef.current?.close();
      pcRef.current?.close();
      localRef.current?.getTracks().forEach((track) => track.stop());
      if (recorderRef.current?.state === "recording")
        recorderRef.current.stop();
      void ringtoneContextRef.current?.close();
    };
    // Intentionally run only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatTime = (seconds: number) =>
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  const busy = callStatus !== "idle" || incoming !== null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f5f7] p-5 text-[#171717]">
      <div className="w-full max-w-[390px] overflow-hidden rounded-[30px] border border-black/[0.04] bg-white shadow-xl shadow-black/[0.04]">
        <header className="flex items-center justify-between px-7 pb-5 pt-8">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black text-white">
              <Phone size={17} />
            </div>
            <span className="text-lg font-semibold tracking-tight">call.</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span
              className={`h-2 w-2 rounded-full ${registered ? "bg-green-500" : "bg-gray-300"}`}
            />
            {registered ? "Online" : "Offline"}
          </div>
        </header>

        <div className="px-7 pb-8">
          {!registered ? (
            <div className="pb-8 pt-12 text-center">
              <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                <UserRound size={28} />
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Get your number
              </h1>
              <p className="mt-2 text-sm text-gray-400">
                Choose your six-digit calling ID
              </p>
              <input
                value={number}
                onChange={(event) =>
                  setNumber(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="000000"
                maxLength={6}
                inputMode="numeric"
                className="mt-9 w-full border-b border-gray-200 bg-transparent py-5 text-center text-4xl font-medium tracking-[12px] outline-none focus:border-black"
              />
              <button
                onClick={register}
                disabled={number.length !== 6}
                className="mt-9 w-full rounded-2xl bg-black py-4 font-medium text-white transition hover:bg-gray-800 disabled:opacity-30"
              >
                Register number
              </button>
            </div>
          ) : (
            <>
              <div className="pb-7 pt-8 text-center">
                <p className="text-xs uppercase tracking-widest text-gray-400">
                  Your calling ID
                </p>
                <h1 className="mt-3 text-4xl font-semibold tracking-[8px]">
                  {number}
                </h1>
              </div>

              <div className="border-t border-gray-100 pt-7">
                <p className="mb-3 text-xs font-medium text-gray-400">
                  CALL SOMEONE
                </p>
                <div className="flex items-center rounded-2xl border border-gray-200 px-4 py-3">
                  <Phone size={17} className="text-gray-400" />
                  <input
                    value={dial}
                    onChange={(event) =>
                      setDial(event.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder="Enter 6 digit number"
                    maxLength={6}
                    inputMode="numeric"
                    disabled={busy}
                    className="ml-3 min-w-0 flex-1 bg-transparent text-lg tracking-widest outline-none disabled:opacity-40"
                  />
                  {dial && !busy && (
                    <button
                      onClick={() => setDial("")}
                      aria-label="Clear number"
                    >
                      <Delete size={18} className="text-gray-400" />
                    </button>
                  )}
                </div>
                <button
                  onClick={startCall}
                  disabled={busy || dial.length !== 6}
                  className="mt-4 flex w-full items-center justify-center gap-3 rounded-2xl bg-black py-4 font-medium text-white transition disabled:opacity-30"
                >
                  <Phone size={18} />
                  Call
                </button>
              </div>
            </>
          )}

          {incoming && (
            <section className="mt-6 rounded-3xl bg-gray-50 p-5 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white">
                <Phone size={23} />
              </div>
              <p className="mt-3 text-lg font-semibold">Incoming call</p>
              <p className="mt-1 text-sm text-gray-400">{incoming.from}</p>
              <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-gray-500">
                <Clock3 size={13} />
                Answer within{" "}
                <span className="font-semibold tabular-nums">
                  00:{String(incomingSeconds).padStart(2, "0")}
                </span>
              </div>
              <div className="mt-5 flex gap-4">
                <button
                  onClick={rejectCall}
                  className="flex flex-1 items-center justify-center rounded-xl bg-red-500 py-3 text-white"
                  aria-label="Decline call"
                >
                  <X />
                </button>
                <button
                  onClick={acceptCall}
                  className="flex flex-1 items-center justify-center rounded-xl bg-green-500 py-3 text-white"
                  aria-label="Accept call"
                >
                  <Check />
                </button>
              </div>
              <p className="mt-3 flex items-center justify-center gap-1 text-[11px] text-gray-400">
                <Volume2 size={12} /> Ringing until answered or timeout
              </p>
            </section>
          )}

          {callStatus !== "idle" && (
            <section className="mt-7 border-t border-gray-100 pt-7 text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                <Headphones size={32} />
              </div>
              <p className="mt-4 text-lg font-semibold">
                {callStatus === "ringing"
                  ? "Calling…"
                  : callStatus === "connecting"
                    ? "Connecting…"
                    : "In call"}
              </p>
              <p className="mt-1 text-sm text-gray-400">
                {callStatus === "connected"
                  ? formatTime(duration)
                  : callStatus === "ringing"
                    ? "Waiting up to 60 seconds"
                    : "Please wait"}
              </p>
              {callId && (
                <p className="mt-3 break-all text-[10px] text-gray-400">
                  {callId}
                </p>
              )}

              <div className="mt-7 flex items-center justify-center gap-5">
                <button
                  onClick={toggleMute}
                  disabled={!localRef.current}
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 disabled:opacity-30"
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                >
                  {muted ? <MicOff /> : <Mic />}
                </button>
                <button
                  onClick={hangup}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-200"
                  aria-label="End call"
                >
                  <PhoneOff size={25} />
                </button>
                <button
                  onClick={recording ? stopRecording : startRecording}
                  disabled={callStatus !== "connected"}
                  className={`flex h-14 w-14 items-center justify-center rounded-full ${recording ? "bg-red-100 text-red-600" : "bg-gray-100"} disabled:opacity-30`}
                  aria-label={recording ? "Stop recording" : "Start recording"}
                >
                  <CircleDot />
                </button>
              </div>
              <p className="mt-4 text-xs text-gray-400">
                {muted ? "Microphone muted" : "Microphone active"} ·{" "}
                {recording ? "Recording" : "Not recording"}
              </p>
            </section>
          )}

          {message && (
            <p className="mt-5 text-center text-xs text-gray-400">{message}</p>
          )}
        </div>

        <footer className="bg-gray-50 px-7 py-4 text-center">
          <p className="text-[10px] tracking-wider text-gray-400">
            PRIVATE INTERNET CALLING
          </p>
        </footer>
      </div>

      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
    </main>
  );
}
