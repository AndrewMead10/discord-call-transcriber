const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');

const SOURCE_SAMPLE_RATE = 48_000;
const SOURCE_CHANNELS = 2;
const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHANNELS = 1;
const BIT_DEPTH = 16;

function createWavHeader(dataLength, { sampleRate, channels, bitDepth }) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  const byteRate = sampleRate * channels * (bitDepth / 8);
  buffer.writeUInt32LE(byteRate, 28);
  const blockAlign = channels * (bitDepth / 8);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function pcmStereo48kToMono16k(buffer) {
  if (buffer.length === 0) {
    throw new Error('PCM buffer is empty');
  }

  const totalSamples = buffer.length / 2; // int16 samples across both channels
  if (totalSamples % SOURCE_CHANNELS !== 0) {
    throw new Error(`Unexpected PCM sample count for stereo audio: ${totalSamples}`);
  }

  const view = new Int16Array(buffer.buffer, buffer.byteOffset, totalSamples);
  const frameCount = totalSamples / SOURCE_CHANNELS;
  const monoSamples = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const left = view[frame * SOURCE_CHANNELS];
    const right = view[frame * SOURCE_CHANNELS + 1];
    monoSamples[frame] = (left + right) / 2;
  }

  const downsampleFactor = SOURCE_SAMPLE_RATE / TARGET_SAMPLE_RATE;
  if (Math.abs(downsampleFactor - Math.round(downsampleFactor)) > 1e-6) {
    throw new Error(`Downsample factor must be integer; got ${downsampleFactor}`);
  }

  const factor = Math.round(downsampleFactor);
  const downsampledLength = Math.max(1, Math.floor(frameCount / factor));
  const downsampled = new Int16Array(downsampledLength);

  for (let i = 0; i < downsampledLength; i += 1) {
    const start = i * factor;
    let sum = 0;
    let count = 0;
    for (let j = 0; j < factor && start + j < frameCount; j += 1) {
      sum += monoSamples[start + j];
      count += 1;
    }
    const avg = sum / count;
    const clamped = Math.max(-32768, Math.min(32767, Math.round(avg)));
    downsampled[i] = clamped;
  }

  return Buffer.from(downsampled.buffer, downsampled.byteOffset, downsampled.byteLength);
}

async function pcmToWav(pcmPath) {
  const pcmData = await fsp.readFile(pcmPath);
  if (pcmData.length === 0) {
    throw new Error(`PCM file is empty: ${pcmPath}`);
  }

  const mono16k = pcmStereo48kToMono16k(pcmData);

  const header = createWavHeader(mono16k.length, {
    sampleRate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
    bitDepth: BIT_DEPTH,
  });

  const wavBuffer = Buffer.concat([header, mono16k]);
  const wavPath = pcmPath.replace(/\.pcm$/i, '') + '.wav';
  await fsp.writeFile(wavPath, wavBuffer);
  return wavPath;
}

class TranscriptionClient {
  constructor({ url, apiKey, headerName } = {}) {
    this.url = url?.trim() || null;
    this.apiKey = apiKey?.trim() || null;
    this.headerName = headerName?.trim() || 'X-API-Key';
  }

  isConfigured() {
    return Boolean(this.url && this.apiKey);
  }

  async submit(manifest) {
    if (!manifest) {
      return { status: 'failed', reason: 'No manifest provided' };
    }

    if (!this.isConfigured()) {
      return { status: 'skipped', reason: 'Missing transcription endpoint configuration', manifest };
    }

    const labels = manifest.labels ?? {};
    const recordingEntries = Object.entries(manifest.recordings ?? {});
    if (!recordingEntries.length) {
      return { status: 'skipped', reason: 'Manifest contained no recordings' };
    }

    const segments = [];
    const errors = [];

    for (const [userId, items] of recordingEntries) {
      for (const item of items) {
        try {
          const wavPath = await pcmToWav(item.filePath);
          const fileData = await fsp.readFile(wavPath);
          const filename = path.basename(wavPath);

          const formData = new FormData();
          const file = new File([fileData], filename, { type: 'audio/wav' });
          formData.append('file', file);

          const response = await fetch(this.url, {
            method: 'POST',
            headers: {
              [this.headerName]: this.apiKey,
            },
            body: formData,
          });

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Service responded with ${response.status}: ${text}`);
          }

          const text = await response.text();
          const cleaned = text.trim();
          const label = labels[userId] ?? userId;
          segments.push({
            id: crypto.randomUUID(),
            userId,
            label,
            startedAt: item.startedAt ?? null,
            text: cleaned,
            audioPath: wavPath,
          });
        } catch (error) {
          const label = labels[userId] ?? userId;
          errors.push({
            userId,
            label,
            filePath: item.filePath,
            reason: error.message,
          });
        }
      }
    }

    if (!segments.length) {
      return {
        status: 'failed',
        reason: errors.length ? `All uploads failed: ${JSON.stringify(errors)}` : 'No segments transcribed',
      };
    }

    segments.sort((a, b) => {
      const at = a.startedAt ?? 0;
      const bt = b.startedAt ?? 0;
      return at - bt;
    });

    const transcript = segments
      .map((segment) => `${segment.label}: ${segment.text}`)
      .join('\n');

    return {
      status: 'sent',
      data: {
        transcript,
        segments,
        errors: errors.length ? errors : undefined,
      },
    };
  }
}

module.exports = { TranscriptionClient };
