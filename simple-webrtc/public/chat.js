/**
 * FireSTREAM Chat Engine
 * ─────────────────────────────────────────────────────────────────
 * Estrategia dual:
 *   1. BroadcastChannel  → comunicación instantánea entre pestañas
 *      del mismo navegador (sin latencia, sin permisos Firebase).
 *   2. Firebase RTDB     → chat persistente y entre dispositivos/redes.
 *
 * Los mensajes se deduplicaban con un Set de ids para que un mensaje
 * enviado localmente no aparezca dos veces.
 * ─────────────────────────────────────────────────────────────────
 */

class FireChat {
  /**
   * @param {string} roomPath   — ej. 'rooms/main'
   * @param {object} options
   *   role:      'viewer' | 'streamer'
   *   name:      nombre visible en el chat
   *   onMessage: function({ id, role, name, text, ts })
   */
  constructor(roomPath, { role, name, onMessage }) {
    this._path      = roomPath + '/chat';
    this._role      = role;
    this._name      = name;
    this._onMessage = onMessage;
    this._seen      = new Set();   // ids ya mostrados

    // ── BroadcastChannel (mismo origen, cualquier pestaña) ──
    this._bc = new BroadcastChannel('firestream_chat');
    this._bc.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.id && !this._seen.has(msg.id)) {
        this._seen.add(msg.id);
        this._onMessage(msg);
      }
    };

    // ── Firebase RTDB ───────────────────────────────────────
    try {
      this._chatRef = db.ref(this._path);
      // Solo escucha los mensajes nuevos a partir de ahora
      const nowMs = Date.now();
      this._chatRef
        .orderByChild('ts')
        .startAt(nowMs)
        .limitToLast(100)
        .on('child_added', (snap) => {
          const msg = snap.val();
          if (!msg || !msg.id || !msg.text) return;
          if (this._seen.has(msg.id)) return;   // ya mostrado via BC
          this._seen.add(msg.id);
          this._onMessage(msg);
        });
      this._fbOk = true;
    } catch (err) {
      this._fbOk = false;
      console.warn('[FireChat] Firebase no disponible:', err);
    }
  }

  /** Envía un mensaje por BroadcastChannel y, si es posible, a Firebase */
  send(text) {
    if (!text || !text.trim()) return;
    const msg = {
      id:   crypto.randomUUID(),
      role: this._role,
      name: this._name,
      text: text.trim(),
      ts:   Date.now(),
    };

    // Marcar como visto para no mostrarlo de rebote
    this._seen.add(msg.id);
    // Mostrar de inmediato localmente
    this._onMessage(msg);

    // ── Enviar por BroadcastChannel ──
    this._bc.postMessage(msg);

    // ── Enviar a Firebase (sin bloquear si falla) ──
    if (this._fbOk) {
      this._chatRef.push(msg).catch((err) => {
        console.warn('[FireChat] No se pudo guardar en Firebase:', err.message);
      });
    }
  }

  destroy() {
    this._bc.close();
    if (this._fbOk) this._chatRef.off();
  }
}
