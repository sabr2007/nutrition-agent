'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { pickAudioMime } from '@/lib/client/media';

export const WAVE_BARS = 40;
const SAMPLE_MS = 70;
const MAX_RECORDING_MS = 120_000;
/** Below this the recording is a mis-tap, not speech. */
const MIN_BYTES = 1500;
/** RMS of quiet speech is ~0.05: scale so normal speech fills the bar. */
const LEVEL_GAIN = 5;

export type VoiceClip = { blob: Blob; ext: string; durationMs: number };

type Session = {
  recorder: MediaRecorder;
  stream: MediaStream;
  audio: AudioContext | null;
  timer: number;
  startedAt: number;
  chunks: Blob[];
  ext: string;
};

const silence = () => Array<number>(WAVE_BARS).fill(0);

/**
 * Microphone recording with a live level meter (the dotted waveform in the composer).
 * `onLimit` fires when the recording hits the length cap so the caller can stop and transcribe.
 */
export function useVoiceRecorder(onLimit: () => void) {
  const [recording, setRecording] = useState(false);
  const [levels, setLevels] = useState<number[]>(silence);
  const session = useRef<Session | null>(null);
  const limitRef = useRef(onLimit);

  useEffect(() => { limitRef.current = onLimit; }, [onLimit]);

  const release = useCallback(() => {
    const s = session.current;
    if (!s) return;
    window.clearInterval(s.timer);
    s.stream.getTracks().forEach((t) => t.stop());
    void s.audio?.close().catch(() => undefined);
    session.current = null;
    setRecording(false);
    setLevels(silence());
  }, []);

  useEffect(() => release, [release]);

  const start = useCallback(async () => {
    if (session.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const { mime, ext } = pickAudioMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    let audio: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      audio = new AudioContext();
      analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
    } catch {
      audio = null; // no meter, recording still works
    }
    const buf = new Uint8Array(analyser?.fftSize ?? 0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      let level = 0;
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        level = Math.min(1, Math.sqrt(sum / buf.length) * LEVEL_GAIN);
      }
      setLevels((prev) => [...prev.slice(1), level]);
      if (Date.now() - startedAt > MAX_RECORDING_MS) limitRef.current();
    }, SAMPLE_MS);

    session.current = { recorder, stream, audio, timer, startedAt, chunks, ext };
    recorder.start(250);
    setRecording(true);
  }, []);

  /** Stops and returns the clip; null when it was too short to be speech. */
  const stop = useCallback((): Promise<VoiceClip | null> => new Promise((resolve) => {
    const s = session.current;
    if (!s) {
      resolve(null);
      return;
    }
    s.recorder.onstop = () => {
      const blob = new Blob(s.chunks, { type: s.recorder.mimeType || 'audio/mp4' });
      const durationMs = Date.now() - s.startedAt;
      release();
      resolve(blob.size < MIN_BYTES ? null : { blob, ext: s.ext, durationMs });
    };
    window.clearInterval(s.timer);
    s.recorder.stop();
  }), [release]);

  const cancel = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.recorder.onstop = null;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
    release();
  }, [release]);

  return { recording, levels, start, stop, cancel };
}
