/**
 * FireSTREAM Reactions Engine
 * ─────────────────────────────────────────────────────────────────
 * Sistema de reacciones en tiempo real:
 *   1. BroadcastChannel  → Sincronización instantánea entre pestañas
 *                          locales del mismo navegador (latencia 0).
 *   2. Firebase RTDB     → Sincronización en tiempo real entre distintos
 *                          dispositivos y redes.
 *
 * Muestra animaciones flotantes de emojis sobre el reproductor de video
 * sincronizadas para todos los espectadores y el streamer.
 * Emojis soportados: ❤️, 👍, 😂, 😮, 🔥
 * ─────────────────────────────────────────────────────────────────
 */

class FireReactions {
  /**
   * @param {string} roomPath   — ej. 'rooms/main'
   * @param {object} options
   *   container: HTMLElement | string (elemento donde flotarán los emojis)
   *   onReaction: function(emoji, data) (opcional)
   */
  constructor(roomPath, options = {}) {
    this._path = (roomPath || 'rooms/main') + '/reactions';
    this._container = typeof options.container === 'string'
      ? document.querySelector(options.container)
      : (options.container || null);
    this._onReaction = options.onReaction || null;
    this._seen = new Set();
    this.supportedEmojis = ['❤️', '👍', '😂', '😮', '🔥'];

    // ── BroadcastChannel (mismo navegador, instantáneo) ──
    try {
      this._bc = new BroadcastChannel('firestream_reactions');
      this._bc.onmessage = (e) => {
        const data = e.data;
        if (data && data.id && !this._seen.has(data.id)) {
          this._seen.add(data.id);
          this._handleIncoming(data.emoji, data);
        }
      };
    } catch (err) {
      console.warn('[FireReactions] BroadcastChannel no soportado:', err);
    }

    // ── Firebase Realtime Database ───────────────────────
    try {
      if (typeof db !== 'undefined' && db) {
        this._reactionsRef = db.ref(this._path);
        const nowMs = Date.now();

        // Escuchar reacciones nuevas a partir del momento actual
        this._reactionsRef
          .orderByChild('ts')
          .startAt(nowMs)
          .limitToLast(50)
          .on('child_added', (snap) => {
            const data = snap.val();
            if (!data || !data.emoji || !data.id) return;
            if (this._seen.has(data.id)) return; // Ya mostrada via BroadcastChannel
            this._seen.add(data.id);
            this._handleIncoming(data.emoji, data);
          });

        this._fbOk = true;
      } else {
        this._fbOk = false;
      }
    } catch (err) {
      this._fbOk = false;
      console.warn('[FireReactions] Firebase RTDB no disponible:', err);
    }
  }

  /**
   * Asigna el contenedor sobre el cual flotarán las reacciones
   * @param {HTMLElement} containerEl
   */
  setContainer(containerEl) {
    this._container = containerEl;
  }

  /**
   * Envía una reacción a todos los clientes conectados
   * @param {string} emoji
   */
  send(emoji) {
    if (!emoji) return;

    const data = {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      emoji: emoji,
      ts: Date.now()
    };

    // Marcar localmente para no duplicar
    this._seen.add(data.id);

    // Visualizar inmediatamente en la pantalla local
    this._handleIncoming(emoji, data);

    // Enviar a otras pestañas mediante BroadcastChannel
    if (this._bc) {
      this._bc.postMessage(data);
    }

    // Enviar a Firebase Realtime Database
    if (this._fbOk && this._reactionsRef) {
      this._reactionsRef.push(data).catch((err) => {
        console.warn('[FireReactions] Error enviando a Firebase:', err.message);
      });
    }
  }

  /**
   * Maneja una reacción entrante y dibuja la animación flotante
   */
  _handleIncoming(emoji, data) {
    this.renderFloatingEmoji(emoji);
    if (typeof this._onReaction === 'function') {
      this._onReaction(emoji, data);
    }
  }

  /**
   * Crea y anima un emoji flotante sobre el contenedor del reproductor
   * @param {string} emoji
   */
  renderFloatingEmoji(emoji) {
    if (!this._container) {
      this._container = document.querySelector('.video-stage') || document.body;
    }
    if (!this._container) return;

    // Asegurar que el contenedor tenga la clase del overlay
    let overlay = this._container.querySelector('.reactions-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'reactions-overlay';
      this._container.appendChild(overlay);
    }

    const item = document.createElement('div');
    item.className = 'floating-reaction';
    item.textContent = emoji;

    // Distribuir a lo largo de la pantalla del reproductor (20% a 88%)
    const minLeft = 20;
    const maxLeft = 88;
    const randomLeft = (Math.random() * (maxLeft - minLeft) + minLeft).toFixed(1);

    // Deriva horizontal y rotación aleatoria para que cada emoji tenga trayectoria única
    const drift = (Math.random() * 80 - 40).toFixed(1) + 'px';
    const rot = (Math.random() * 40 - 20).toFixed(1) + 'deg';
    const duration = (Math.random() * 0.6 + 3.0).toFixed(2) + 's';

    item.style.left = `${randomLeft}%`;
    item.style.setProperty('--drift', drift);
    item.style.setProperty('--rot', rot);
    item.style.animationDuration = duration;

    overlay.appendChild(item);

    // Eliminar del DOM una vez completada la animación
    setTimeout(() => {
      if (item.parentNode) {
        item.parentNode.removeChild(item);
      }
    }, 4000);
  }

  /**
   * Vincula una barra de botones de reacciones
   * @param {HTMLElement|string} barContainer
   */
  attachReactionButtons(barContainer) {
    const el = typeof barContainer === 'string'
      ? document.querySelector(barContainer)
      : barContainer;
    if (!el) return;

    const btns = el.querySelectorAll('[data-reaction]');
    btns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const emoji = btn.getAttribute('data-reaction');
        if (emoji) {
          this.send(emoji);
          // Efecto de pulso en el botón
          btn.classList.add('pop');
          setTimeout(() => btn.classList.remove('pop'), 250);
        }
      });
    });
  }

  destroy() {
    if (this._bc) this._bc.close();
    if (this._fbOk && this._reactionsRef) this._reactionsRef.off();
  }
}

// Exportar globalmente
window.FireReactions = FireReactions;
