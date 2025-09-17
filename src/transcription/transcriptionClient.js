class TranscriptionClient {
  constructor({ url, apiKey } = {}) {
    this.url = url?.trim() || null;
    this.apiKey = apiKey?.trim() || null;
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

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(manifest),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          status: 'failed',
          reason: `Service responded with ${response.status}: ${text}`,
        };
      }

      const data = await response.json().catch(() => null);
      return { status: 'sent', data };
    } catch (error) {
      return { status: 'failed', reason: error.message };
    }
  }
}

module.exports = { TranscriptionClient };
