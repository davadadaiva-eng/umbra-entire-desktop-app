/**
 * WhisperAsr — client for the lightweight Whisper-ASR diarization server
 * (scripts/whisper-asr-server.py), which runs faster-whisper (small) plus
 * speechbrain ECAPA speaker embeddings (~520 MB total, fully ungated) and
 * returns the same speaker-labeled segments as the VibeVoice-ASR server.
 *
 * It shares the VibeVoiceAsr HTTP client (identical /health + /transcribe
 * contract); the only difference is the default server URL and port.
 */
import { VibeVoiceAsr, VibeVoiceAsrOptions } from './VibeVoiceAsr';

export class WhisperAsr extends VibeVoiceAsr {
  constructor(options: VibeVoiceAsrOptions = {}) {
    super({ ...options, baseUrl: options.baseUrl ?? 'http://127.0.0.1:17501' });
  }
}
