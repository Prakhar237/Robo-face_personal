import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { DEFAULT_SYSTEM_PROMPT } from "../constants";

// --- Audio Processing Helpers ---

function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// --- Live Client ---

export interface LiveClientCallbacks {
  onOpen: () => void;
  onClose: () => void;
  onAudioPlay: () => void;
  onAudioStop: () => void;
  onTranscript?: (text: string, isUser: boolean) => void;
}

export class GeminiLiveClient {
  private ai: GoogleGenAI;
  private session: any = null;
  private inputContext: AudioContext | null = null;
  private outputContext: AudioContext | null = null;
  private inputProcessor: ScriptProcessorNode | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;

  private nextStartTime = 0;
  private scheduledSources: Set<AudioBufferSourceNode> = new Set();

  // Callbacks
  private callbacks: LiveClientCallbacks;

  // State
  private isConnected = false;

  constructor(callbacks: LiveClientCallbacks) {
    this.ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_API_KEY });
    this.callbacks = callbacks;
  }

  async connect() {
    if (this.isConnected) return;

    // Initialize Audio Contexts
    this.inputContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    this.outputContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

    // Get Mic Stream
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Connect to Gemini Live
    this.session = await this.ai.live.connect({
      model: 'gemini-live-2.5-flash-native-audio',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
        systemInstruction: DEFAULT_SYSTEM_PROMPT,
      },
      callbacks: {
        onopen: () => {
          this.isConnected = true;
          this.callbacks.onOpen();
          this.startAudioInput();
        },
        onmessage: (message: LiveServerMessage) => {
          this.handleMessage(message);
        },
        onclose: () => {
          this.disconnect();
        },
        onerror: (err) => {
          console.error("Gemini Live Error:", err);
          this.disconnect();
        }
      }
    });
  }

  private async startAudioInput() {
    if (!this.inputContext || !this.stream) return;

    // Load the AudioWorklet processor
    await this.inputContext.audioWorklet.addModule('/audio-processor.worklet.js');

    this.inputSource = this.inputContext.createMediaStreamSource(this.stream);

    // Create worklet node — runs off main thread, 128-sample buffer (8ms latency vs 256ms)
    const workletNode = new AudioWorkletNode(this.inputContext, 'pcm-processor');

    workletNode.port.onmessage = (event) => {
      if (!this.isConnected || !this.session) return;

      const float32 = event.data as Float32Array;
      const pcm16 = floatTo16BitPCM(float32);
      const base64 = arrayBufferToBase64(pcm16);

      try {
        this.session.sendRealtimeInput({
          media: {
            mimeType: 'audio/pcm;rate=16000',
            data: base64
          }
        });
      } catch (e) {
        console.warn("Skipped sending audio chunk: connection closing");
      }
    };

    this.inputSource.connect(workletNode);
    // Note: Do NOT connect workletNode to destination — we don't want to hear mic playback
  }

  private async handleMessage(message: LiveServerMessage) {
    // 1. Handle Server Content (Audio & Text)
    const parts = message.serverContent?.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        // Audio
        if (part.inlineData?.data && this.outputContext) {
          await this.queueAudio(part.inlineData.data);
        }
        // Text (Transcript)
        if (part.text && this.callbacks.onTranscript) {
          this.callbacks.onTranscript(part.text, false);
        }
      }
    }

    // 2. Handle Interruption
    if (message.serverContent?.interrupted) {
      this.stopAllAudio();
    }
  }

  private async queueAudio(base64: string) {
    if (!this.outputContext) return;

    // Decode PCM
    const uint8 = base64ToUint8Array(base64);
    const int16 = new Int16Array(uint8.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    const buffer = this.outputContext.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    // Schedule
    const source = this.outputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputContext.destination);

    // Sync timing
    const currentTime = this.outputContext.currentTime;
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime;
    }

    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;

    this.scheduledSources.add(source);

    // Notify playing state
    if (this.scheduledSources.size === 1) {
      this.callbacks.onAudioPlay();
    }

    source.onended = () => {
      this.scheduledSources.delete(source);
      if (this.scheduledSources.size === 0) {
        this.callbacks.onAudioStop();
        // Reset time if we ran out of buffer to avoid huge gaps
        if (this.outputContext) {
          this.nextStartTime = this.outputContext.currentTime;
        }
      }
    };
  }

  private stopAllAudio() {
    this.scheduledSources.forEach(s => s.stop());
    this.scheduledSources.clear();
    this.nextStartTime = 0;
    this.callbacks.onAudioStop();
  }

  disconnect() {
    this.isConnected = false;
    this.session = null;
    this.stopAllAudio();

    // Cleanup Input
    this.inputProcessor?.disconnect();
    this.inputSource?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    if (this.inputContext && this.inputContext.state !== 'closed') {
      this.inputContext.close();
    }

    // Cleanup Output
    if (this.outputContext && this.outputContext.state !== 'closed') {
      this.outputContext.close();
    }

    this.callbacks.onClose();
  }
}
