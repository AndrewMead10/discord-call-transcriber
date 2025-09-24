const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');

const SOURCE_SAMPLE_RATE = 48_000;
const SOURCE_CHANNELS = 2;
const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHANNELS = 1;
const BIT_DEPTH = 16;
const SOURCE_FRAME_BYTES = SOURCE_CHANNELS * (BIT_DEPTH / 8);
const MIN_SPLIT_PADDING_MS = 50;
const MIN_PART_DURATION_MS = 80;

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

async function writeWavFromPcm(pcmBuffer, wavPath) {
  if (!pcmBuffer || pcmBuffer.length === 0) {
    throw new Error('PCM buffer is empty');
  }

  const mono16k = pcmStereo48kToMono16k(pcmBuffer);

  const header = createWavHeader(mono16k.length, {
    sampleRate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
    bitDepth: BIT_DEPTH,
  });

  const wavBuffer = Buffer.concat([header, mono16k]);
  await fsp.mkdir(path.dirname(wavPath), { recursive: true });
  await fsp.writeFile(wavPath, wavBuffer);
  return wavBuffer;
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

    const startEvents = [];
    for (const [eventUserId, items] of recordingEntries) {
      for (const item of items) {
        if (!item) {
          continue;
        }
        const startedAt = Number.isFinite(item.startedAt) ? item.startedAt : 0;
        startEvents.push({ userId: eventUserId, startedAt });
      }
    }

    startEvents.sort((a, b) => a.startedAt - b.startedAt);

    for (const [userId, items] of recordingEntries) {
      const label = labels[userId] ?? userId;
      for (const item of items) {
        if (!item?.filePath) {
          errors.push({
            userId,
            label,
            filePath: null,
            startedAt: item?.startedAt ?? null,
            reason: 'Recording item was missing a file path',
          });
          continue;
        }

        const startedAt = Number.isFinite(item.startedAt) ? item.startedAt : 0;
        const absolutePath = path.resolve(item.filePath);

        let stats;
        try {
          stats = await fsp.stat(absolutePath);
        } catch (error) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: `Unable to access PCM file: ${error.message}`,
          });
          continue;
        }

        if (!stats.isFile()) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: 'PCM entry was not a file',
          });
          continue;
        }

        if (stats.size === 0) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: 'PCM file was empty',
          });
          continue;
        }

        if (stats.size % SOURCE_FRAME_BYTES !== 0) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: `Unexpected PCM byte length: ${stats.size}`,
          });
          continue;
        }

        const sampleFrames = stats.size / SOURCE_FRAME_BYTES;
        const durationMs = (sampleFrames / SOURCE_SAMPLE_RATE) * 1000;
        const segmentEnd = startedAt + durationMs;

        const splitSet = new Set();
        let lastSplit = null;
        for (const event of startEvents) {
          if (event.startedAt <= startedAt) {
            continue;
          }
          if (event.startedAt >= segmentEnd) {
            break;
          }
          if (event.userId === userId) {
            continue;
          }
          if (event.startedAt - startedAt < MIN_SPLIT_PADDING_MS) {
            continue;
          }
          if (segmentEnd - event.startedAt < MIN_SPLIT_PADDING_MS) {
            continue;
          }
          if (lastSplit !== null && Math.abs(event.startedAt - lastSplit) < MIN_SPLIT_PADDING_MS) {
            continue;
          }
          splitSet.add(event.startedAt);
          lastSplit = event.startedAt;
        }

        const splitTimes = Array.from(splitSet).sort((a, b) => a - b);

        let pcmData;
        try {
          pcmData = await fsp.readFile(absolutePath);
        } catch (error) {
          errors.push({
            userId,
            label,
            filePath: absolutePath,
            startedAt,
            reason: `Failed to load PCM data: ${error.message}`,
          });
          continue;
        }

        const boundaries = [...splitTimes, segmentEnd];
        let previousSample = 0;
        let previousTime = startedAt;
        let partIndex = 0;

        for (const boundaryTime of boundaries) {
          const relativeMs = boundaryTime - startedAt;
          let sampleIndex = Math.round((relativeMs / 1000) * SOURCE_SAMPLE_RATE);
          if (sampleIndex < previousSample) {
            sampleIndex = previousSample;
          }
          if (sampleIndex > sampleFrames) {
            sampleIndex = sampleFrames;
          }

          if (sampleIndex === previousSample) {
            previousTime = boundaryTime;
            continue;
          }

          const byteStart = previousSample * SOURCE_FRAME_BYTES;
          const byteEnd = sampleIndex * SOURCE_FRAME_BYTES;
          const partBuffer = pcmData.subarray(byteStart, byteEnd);
          const partStartTime = previousTime;
          const partDuration = boundaryTime - previousTime;

          previousSample = sampleIndex;
          previousTime = boundaryTime;

          if (!partBuffer.length || partDuration <= 0) {
            continue;
          }

          if (partDuration < MIN_PART_DURATION_MS) {
            // Allow overlapping fragments, but ensure they contain at least one frame.
            const minimumBytes = SOURCE_FRAME_BYTES;
            if (partBuffer.length < minimumBytes) {
              continue;
            }
          }

          partIndex += 1;

          const isOverlapSplit = splitTimes.some((time) => Math.abs(time - partStartTime) < 0.5);
          const adjustedStart = Number.isFinite(partStartTime)
            ? partStartTime + (isOverlapSplit ? 1 : 0)
            : 0;
          const partStartedAt = Number.isFinite(adjustedStart) ? Math.round(adjustedStart) : 0;
          const wavDir = path.join(path.dirname(absolutePath), 'segments');
          const baseName = path.basename(absolutePath, '.pcm');
          const wavFileName = `${baseName}_${partStartedAt}_${partIndex}.wav`;
          const wavPath = path.join(wavDir, wavFileName);

          let wavBuffer;
          try {
            wavBuffer = await writeWavFromPcm(partBuffer, wavPath);
          } catch (error) {
            errors.push({
              userId,
              label,
              filePath: absolutePath,
              startedAt: partStartedAt,
              reason: `Failed to convert PCM: ${error.message}`,
            });
            continue;
          }

          try {
            const formData = new FormData();
            const file = new File([wavBuffer], path.basename(wavPath), { type: 'audio/wav' });
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

            segments.push({
              id: crypto.randomUUID(),
              userId,
              label,
              startedAt: partStartedAt,
              text: cleaned,
              audioPath: wavPath,
            });
          } catch (error) {
            errors.push({
              userId,
              label,
              filePath: absolutePath,
              startedAt: partStartedAt,
              reason: error.message,
            });
          }
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
