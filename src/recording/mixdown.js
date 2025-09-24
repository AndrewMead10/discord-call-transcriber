const fsp = require('fs/promises');
const path = require('path');

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const BYTES_PER_SAMPLE = BIT_DEPTH / 8;
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;

function createWavHeader(dataLength) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * FRAME_BYTES, 28);
  buffer.writeUInt16LE(FRAME_BYTES, 32);
  buffer.writeUInt16LE(BIT_DEPTH, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function resolveSessionStart(manifest) {
  const candidates = [];
  if (manifest?.sessionId) {
    const numeric = Number.parseInt(manifest.sessionId, 10);
    if (Number.isFinite(numeric)) {
      candidates.push(numeric);
    }
  }
  const recordings = manifest?.recordings ?? {};
  for (const items of Object.values(recordings)) {
    for (const item of items) {
      if (item?.startedAt) {
        candidates.push(item.startedAt);
      }
    }
  }
  if (!candidates.length) {
    return Date.now();
  }
  return Math.min(...candidates);
}

async function mixSessionAudio({ manifest, outputPath } = {}) {
  if (!manifest) {
    return null;
  }

  const recordings = manifest.recordings ?? {};
  const userEntries = Object.entries(recordings);
  if (!userEntries.length) {
    return null;
  }

  const sessionDir = manifest.directory ? path.resolve(manifest.directory) : null;
  if (!sessionDir) {
    return null;
  }

  const sessionStart = resolveSessionStart(manifest);
  const segments = [];

  for (const items of userEntries.map(([, value]) => value)) {
    for (const item of items) {
      if (!item?.filePath) {
        continue;
      }
      try {
        const filePath = path.resolve(item.filePath);
        const buffer = await fsp.readFile(filePath);
        if (!buffer.length || buffer.length % FRAME_BYTES !== 0) {
          continue;
        }
        const sampleFrames = buffer.length / FRAME_BYTES;
        const startedAt = item.startedAt ?? sessionStart;
        const offsetMs = Math.max(0, startedAt - sessionStart);
        const offsetSamples = Math.max(0, Math.round((offsetMs / 1000) * SAMPLE_RATE));
        segments.push({ buffer, sampleFrames, offsetSamples });
      } catch (error) {
        console.error('Failed to read PCM for mixdown:', error);
      }
    }
  }

  if (!segments.length) {
    return null;
  }

  let totalSamples = 0;
  for (const segment of segments) {
    const segmentEnd = segment.offsetSamples + segment.sampleFrames;
    if (segmentEnd > totalSamples) {
      totalSamples = segmentEnd;
    }
  }

  if (totalSamples === 0) {
    return null;
  }

  const mixBuffer = new Int32Array(totalSamples * CHANNELS);

  for (const segment of segments) {
    const view = new Int16Array(segment.buffer.buffer, segment.buffer.byteOffset, segment.buffer.length / BYTES_PER_SAMPLE);
    const startIndex = segment.offsetSamples * CHANNELS;
    for (let i = 0; i < view.length; i += 1) {
      const mixIndex = startIndex + i;
      if (mixIndex >= mixBuffer.length) {
        break;
      }
      mixBuffer[mixIndex] += view[i];
    }
  }

  const outputPcm = Buffer.alloc(totalSamples * FRAME_BYTES);
  for (let i = 0; i < mixBuffer.length; i += 1) {
    let sample = mixBuffer[i];
    if (sample > 32767) {
      sample = 32767;
    } else if (sample < -32768) {
      sample = -32768;
    }
    outputPcm.writeInt16LE(sample, i * BYTES_PER_SAMPLE);
  }

  const wavHeader = createWavHeader(outputPcm.length);
  const wavBuffer = Buffer.concat([wavHeader, outputPcm]);

  const finalPath = outputPath
    ? path.resolve(outputPath)
    : path.join(sessionDir, 'mixdown.wav');

  await fsp.writeFile(finalPath, wavBuffer);
  return finalPath;
}

module.exports = { mixSessionAudio };
