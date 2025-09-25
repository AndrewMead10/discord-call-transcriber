(function () {
  const sessionListEl = document.getElementById('session-list');
  const sessionDetailEl = document.getElementById('session-detail');
  const themeToggleButton = document.getElementById('theme-toggle');

  let sessions = [];
  let activeSessionId = null;
  const audioElements = new Map();
  let fullAudioElement = null;

  function renderMarkdown(text) {
    if (!text) {
      return '';
    }
    if (window.marked && typeof window.marked.parse === 'function') {
      return window.marked.parse(text, { breaks: true });
    }
    const escaped = String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(/\n/g, '<br>');
  }

  function formatDate(value) {
    if (!value) {
      return 'Unknown';
    }
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) {
      return 'Unknown';
    }
    return date.toLocaleString();
  }

  function clearAudioPlayers() {
    if (fullAudioElement) {
      fullAudioElement.pause();
      fullAudioElement.currentTime = 0;
      fullAudioElement = null;
    }
    for (const { audio } of audioElements.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
    audioElements.clear();
  }

  function updatePlayStates() {
    for (const [segmentId, { audio, button }] of audioElements.entries()) {
      if (!button) {
        continue;
      }
      if (!audio.paused && !audio.ended) {
        button.textContent = '⏸';
        button.setAttribute('aria-label', 'Pause segment audio');
      } else {
        button.textContent = '🔊';
        button.setAttribute('aria-label', 'Play segment audio');
      }
    }
  }

  function stopOthers(exceptId) {
    for (const [segmentId, { audio }] of audioElements.entries()) {
      if (segmentId === exceptId) {
        continue;
      }
      audio.pause();
      audio.currentTime = 0;
    }
  }

  function handlePlayClick(event) {
    const segmentId = event.currentTarget.dataset.segmentId;
    if (!segmentId) {
      return;
    }
    const entry = audioElements.get(segmentId);
    if (!entry) {
      return;
    }

    const { audio } = entry;
    if (audio.paused || audio.ended) {
      stopOthers(segmentId);
      audio.play().catch((error) => {
        console.error('Failed to play audio segment', segmentId, error);
      });
    } else {
      audio.pause();
      audio.currentTime = 0;
    }
    updatePlayStates();
  }

  function createSessionItem(session) {
    const item = document.createElement('a');
    item.href = `/?session=${encodeURIComponent(session.id)}`;
    item.className = 'session-item';
    item.dataset.sessionId = session.id;

    const title = document.createElement('div');
    title.className = 'session-item-title';
    title.textContent = session.guildName || 'Unknown server';
    item.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'session-item-meta';
    meta.textContent = [
      session.channelName || 'Unknown channel',
      formatDate(session.startedAt),
      `${session.participantCount || 0} participants`,
    ]
      .filter(Boolean)
      .join(' • ');
    item.appendChild(meta);

    item.addEventListener('click', (event) => {
      event.preventDefault();
      if (session.id === activeSessionId) {
        return;
      }
      selectSession(session.id);

      // Update URL without reload
      const newUrl = new URL(window.location);
      newUrl.searchParams.set('session', session.id);
      window.history.pushState({}, '', newUrl);
    });

    if (session.id === activeSessionId) {
      item.classList.add('active');
    }

    return item;
  }

  function renderSessionList() {
    sessionListEl.innerHTML = '';
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'session-item';
      empty.textContent = 'No sessions recorded yet.';
      sessionListEl.appendChild(empty);
      return;
    }

    for (const session of sessions) {
      sessionListEl.appendChild(createSessionItem(session));
    }
  }

  function renderSessionDetail(payload) {
    clearAudioPlayers();
    sessionDetailEl.classList.remove('empty');
    sessionDetailEl.innerHTML = '';

    const { session, participants, segments } = payload;

    const header = document.createElement('section');
    header.className = 'session-header';

    const title = document.createElement('h2');
    title.textContent = `${session.guildName || 'Unknown server'} — ${session.channelName || 'Unknown channel'}`;
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = [
      `Started: ${formatDate(session.startedAt)}`,
      `Ended: ${formatDate(session.endedAt)}`,
      `${participants.length} participants`,
    ].join(' | ');
    header.appendChild(meta);

    const shareButton = document.createElement('button');
    shareButton.type = 'button';
    shareButton.className = 'share-button';
    shareButton.textContent = '🔗 Share';
    shareButton.setAttribute('aria-label', 'Copy link to this transcription');
    shareButton.addEventListener('click', () => {
      const shareUrl = `${window.location.origin}/?session=${encodeURIComponent(session.id)}`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        const originalText = shareButton.textContent;
        shareButton.textContent = '✅ Copied!';
        shareButton.style.background = 'rgba(34, 197, 94, 0.15)';
        shareButton.style.borderColor = 'rgba(34, 197, 94, 0.3)';
        setTimeout(() => {
          shareButton.textContent = originalText;
          shareButton.style.background = '';
          shareButton.style.borderColor = '';
        }, 2000);
      }).catch(() => {
        shareButton.textContent = '❌ Failed';
        setTimeout(() => {
          shareButton.textContent = '🔗 Share';
        }, 2000);
      });
    });
    header.appendChild(shareButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'delete-button';
    deleteButton.textContent = '🗑️ Delete';
    deleteButton.setAttribute('aria-label', 'Delete this session');
    deleteButton.addEventListener('click', () => {
      showDeleteConfirmation(session.id);
    });
    header.appendChild(deleteButton);

    sessionDetailEl.appendChild(header);

    if (session.summary && session.summary.trim()) {
      const summarySection = document.createElement('section');
      summarySection.className = 'session-summary';

      const summaryTitle = document.createElement('h3');
      summaryTitle.textContent = 'Summary';
      summarySection.appendChild(summaryTitle);

      const summaryBody = document.createElement('div');
      summaryBody.className = 'session-summary-body';
      summaryBody.innerHTML = renderMarkdown(session.summary);
      summarySection.appendChild(summaryBody);

      sessionDetailEl.appendChild(summarySection);
    }

    if (session.audioUrl) {
      const playback = document.createElement('section');
      playback.className = 'session-playback';

      const playbackTitle = document.createElement('h3');
      playbackTitle.textContent = 'Full Recording';
      playback.appendChild(playbackTitle);

      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'none';
      player.src = session.audioUrl;
      playback.appendChild(player);

      fullAudioElement = player;

      sessionDetailEl.appendChild(playback);
    }

    const participantsContainer = document.createElement('section');
    participantsContainer.className = 'participants';

    const participantsTitle = document.createElement('h3');
    participantsTitle.textContent = 'Participants';
    participantsContainer.appendChild(participantsTitle);

    const participantList = document.createElement('div');
    participantList.className = 'participant-list';
    if (participants.length) {
      for (const participant of participants) {
        const pill = document.createElement('span');
        pill.className = 'participant-pill';
        pill.textContent = participant.displayName || participant.userId;
        participantList.appendChild(pill);
      }
    } else {
      const none = document.createElement('span');
      none.className = 'participant-pill';
      none.textContent = 'No participants recorded';
      participantList.appendChild(none);
    }
    participantsContainer.appendChild(participantList);
    sessionDetailEl.appendChild(participantsContainer);

    const transcriptContainer = document.createElement('section');
    transcriptContainer.className = 'transcript';

    if (!segments.length) {
      const emptySegments = document.createElement('p');
      emptySegments.textContent = 'No transcript segments were saved for this session.';
      transcriptContainer.appendChild(emptySegments);
    } else {
      for (const segment of segments) {
        const segmentEl = document.createElement('article');
        segmentEl.className = 'segment';

        const headerEl = document.createElement('div');
        headerEl.className = 'segment-header';

        const headerMain = document.createElement('div');
        headerMain.className = 'segment-header-main';

        const titleEl = document.createElement('div');
        titleEl.className = 'segment-title';
        titleEl.textContent = segment.label || segment.userId || 'Unknown speaker';
        headerMain.appendChild(titleEl);

        const actions = document.createElement('div');
        actions.className = 'segment-actions';

        if (segment.audioUrl) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'segment-play';
          button.dataset.segmentId = segment.id;
          button.textContent = '🔊';
          button.setAttribute('aria-label', 'Play segment audio');
          button.addEventListener('click', handlePlayClick);

          const audio = document.createElement('audio');
          audio.src = segment.audioUrl;
          audio.preload = 'none';
          audio.hidden = true;

          audio.addEventListener('ended', updatePlayStates);
          audio.addEventListener('pause', updatePlayStates);
          audio.addEventListener('play', updatePlayStates);

          audioElements.set(segment.id, { audio, button });

          actions.appendChild(button);
          actions.appendChild(audio);
        } else {
          const disabledButton = document.createElement('button');
          disabledButton.type = 'button';
          disabledButton.className = 'segment-play';
          disabledButton.textContent = '🔇';
          disabledButton.disabled = true;
          disabledButton.setAttribute('aria-label', 'Audio not available');
          actions.appendChild(disabledButton);
        }

        if (actions.children.length) {
          headerMain.appendChild(actions);
        }

        headerEl.appendChild(headerMain);

        segmentEl.appendChild(headerEl);

        const textEl = document.createElement('div');
        textEl.className = 'segment-text';
        textEl.textContent = segment.text || '';
        segmentEl.appendChild(textEl);

        transcriptContainer.appendChild(segmentEl);
      }
    }

    sessionDetailEl.appendChild(transcriptContainer);

    updatePlayStates();
  }

  function showError(message) {
    sessionDetailEl.classList.remove('empty');
    sessionDetailEl.innerHTML = '';
    const error = document.createElement('p');
    error.textContent = message;
    sessionDetailEl.appendChild(error);
  }

  function showDeleteConfirmation(sessionId) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        <h3>Delete Session</h3>
        <p>Are you sure you want to delete this session? This action cannot be undone.</p>
        <form id="delete-form">
          <div class="form-group">
            <label for="delete-password">Enter password to confirm:</label>
            <input type="password" id="delete-password" required>
          </div>
          <div class="modal-actions">
            <button type="button" class="cancel-button">Cancel</button>
            <button type="submit" class="confirm-delete-button">Delete</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(modal);

    const form = modal.querySelector('#delete-form');
    const cancelButton = modal.querySelector('.cancel-button');
    const passwordInput = modal.querySelector('#delete-password');

    const closeModal = () => {
      document.body.removeChild(modal);
    };

    cancelButton.addEventListener('click', closeModal);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = passwordInput.value;

      if (password !== 'ihatetranscribing') {
        alert('Incorrect password');
        return;
      }

      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          throw new Error(`Failed to delete session: ${response.status}`);
        }

        closeModal();
        sessions = sessions.filter(s => s.id !== sessionId);
        renderSessionList();

        if (sessions.length > 0) {
          selectSession(sessions[0].id);
        } else {
          sessionDetailEl.classList.add('empty');
          sessionDetailEl.innerHTML = '<p>No sessions available yet.</p>';
        }

        activeSessionId = null;
      } catch (error) {
        console.error('Failed to delete session', error);
        alert('Failed to delete session');
      }
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });
  }

  async function selectSession(sessionId) {
    activeSessionId = sessionId;
    renderSessionList();
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        throw new Error(`Failed to load session: ${response.status}`);
      }
      const payload = await response.json();
      renderSessionDetail(payload);
    } catch (error) {
      console.error('Failed to load session detail', error);
      showError('Failed to load session detail.');
    }
  }

  async function loadSessions() {
    try {
      const response = await fetch('/api/sessions');
      if (!response.ok) {
        throw new Error(`Failed to load sessions: ${response.status}`);
      }
      const payload = await response.json();
      sessions = payload.sessions || [];
      renderSessionList();

      if (!sessions.length) {
      sessionDetailEl.classList.add('empty');
      sessionDetailEl.textContent = 'No sessions available yet.';
      return;
      }

      const urlParams = new URLSearchParams(window.location.search);
      const sessionParam = urlParams.get('session');

      if (sessionParam) {
        const requestedSession = sessions.find((item) => item.id === sessionParam);
        if (requestedSession) {
          selectSession(requestedSession.id);
        } else {
          const initialSession = sessions[0];
          selectSession(initialSession.id);
        }
      } else {
        const initialSession = sessions.find((item) => item.id === activeSessionId) || sessions[0];
        selectSession(initialSession.id);
      }
    } catch (error) {
      console.error('Failed to load sessions', error);
      sessionDetailEl.classList.remove('empty');
      sessionDetailEl.textContent = 'Unable to load sessions.';
    }
  }

  loadSessions();
})();
  const THEME_STORAGE_KEY = 'call-transcribe-theme';
  let userSetTheme = false;

  function applyTheme(theme, { persist = true } = {}) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    document.body.classList.toggle('dark', normalized === 'dark');

    if (themeToggleButton) {
      const isDark = normalized === 'dark';
      themeToggleButton.textContent = isDark ? '☀️' : '🌙';
      themeToggleButton.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
    }

    if (persist) {
      localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(THEME_STORAGE_KEY);
    }
  }

  function resolveInitialTheme() {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') {
      userSetTheme = true;
      return stored;
    }
    userSetTheme = false;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  const initialTheme = resolveInitialTheme();
  applyTheme(initialTheme, { persist: userSetTheme });

  if (themeToggleButton) {
    themeToggleButton.addEventListener('click', () => {
      const nextTheme = document.body.classList.contains('dark') ? 'light' : 'dark';
      userSetTheme = true;
      applyTheme(nextTheme);
    });
  }

  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event) => {
      if (!userSetTheme) {
        applyTheme(event.matches ? 'dark' : 'light', { persist: false });
      }
    };

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleChange);
    } else if (typeof media.addListener === 'function') {
      media.addListener(handleChange);
    }
  }
