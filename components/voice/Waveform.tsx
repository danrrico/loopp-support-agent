"use client";

import { useEffect, useRef } from "react";

/**
 * Waveform canvas (architecture-v2.md §4.3).
 *
 * Renders live audio levels from a MediaStream via AnalyserNode at ~60fps.
 * With no stream attached it draws an idle flat line. The audio lifecycle
 * is explicit: on unmount (or stream change) the animation frame is
 * cancelled and the AudioContext is closed — microphone capture must never
 * continue after disconnect.
 */
export function Waveform({
  stream,
  active,
}: {
  /** Local mic stream (or remote track) — null when no voice session. */
  stream: MediaStream | null;
  /** Whether audio is currently expected (drives the color). */
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const midY = height / 2;

    const drawIdle = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = "#a1a1aa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(width, midY);
      ctx.stroke();
    };

    if (!stream || stream.getAudioTracks().length === 0) {
      drawIdle();
      return;
    }

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    let cancelled = false;

    const draw = () => {
      if (cancelled) return;
      analyser.getByteTimeDomainData(data);
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = active ? "#22c55e" : "#a1a1aa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const step = width / data.length;
      for (let i = 0; i < data.length; i++) {
        const x = i * step;
        const y = ((data[i] - 128) / 128) * (height / 2 - 4) + midY;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      source.disconnect();
      void audioCtx.close();
    };
  }, [stream, active]);

  return (
    <canvas
      ref={canvasRef}
      width={640}
      height={64}
      className="w-full rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
      aria-label="Voice waveform"
    />
  );
}
