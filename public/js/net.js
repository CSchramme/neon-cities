// Verbindung zum NEON CITIES Server mit automatischem Reconnect.
//
// Bevorzugt WebSocket (schnellste Variante). Lässt der Webserver keine
// WebSockets durch (z. B. Plesk im Proxy-Modus), wird automatisch auf
// Server-Sent Events und notfalls Long-Polling umgeschaltet.
// Erzwingen lässt sich ein Weg mit ?transport=ws|sse|poll in der Adresse.

const MODES = ['ws', 'sse', 'poll'];

function randomId() {
  const a = new Uint8Array(12);
  (window.crypto || window.msCrypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Link {
  constructor(role, { key = '' } = {}) {
    this.role = role;
    this.key = key;
    this.handlers = {};
    this.connected = false;
    this.retry = 0;
    this.cid = randomId();
    const forced = new URLSearchParams(location.search).get('transport');
    this.forced = MODES.includes(forced) ? forced : null;
    this.mode = this.forced || 'ws';
    this.wsFails = 0;
    this.outbox = [];
    this.sending = false;
    this.session = 0; // erhöht sich bei jedem Neuaufbau, alte Callbacks werden ignoriert
    this.connect();
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }

  emit(type, data) {
    for (const fn of this.handlers[type] || []) fn(data);
  }

  dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'pong') this.gotPong = true;
    this.emit(msg.t, msg);
    this.emit('*', msg);
  }

  query() {
    const q = new URLSearchParams({ cid: this.cid, role: this.role });
    if (this.key) q.set('key', this.key);
    return q.toString();
  }

  // ------------------------------------------------------------ Auf- und Abbau
  connect() {
    const session = ++this.session;
    if (this.mode === 'ws') this.connectWs(session);
    else if (this.mode === 'sse') this.connectSse(session);
    else this.connectPoll(session);
  }

  markOpen() {
    if (this.connected) return;
    this.connected = true;
    this.retry = 0;
    this.emit('open', { mode: this.mode });
    if (this.mode !== 'ws') this.flush(); // liegengebliebene Nachrichten nachsenden
  }

  /** Verbindung verloren: neu aufbauen (ggf. mit anderem Weg) */
  lost(session, { switchTo = null } = {}) {
    if (session !== this.session) return;
    this.session++; // laufende Callbacks dieser Verbindung ungültig machen
    this.cleanup();
    if (this.connected) {
      this.connected = false;
      this.emit('close');
    }
    if (switchTo && !this.forced && switchTo !== this.mode) {
      this.mode = switchTo;
      this.retry = 0;
      setTimeout(() => this.connect(), 50);
      return;
    }
    const delay = Math.min(5000, 500 * 2 ** this.retry++);
    setTimeout(() => this.connect(), delay);
  }

  cleanup() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    clearTimeout(this.firstTimer);
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try { this.ws.close(); } catch { /* egal */ }
      this.ws = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
  }

  // ------------------------------------------------------------ WebSocket
  connectWs(session) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let opened = false;
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this.lost(session, { switchTo: 'sse' });
      return;
    }
    this.ws = ws;
    // hängt der Aufbau (manche Proxys antworten nie), nicht ewig warten
    this.firstTimer = setTimeout(() => {
      if (!opened) {
        this.wsFails++;
        this.lost(session, { switchTo: this.wsFails >= 2 ? 'sse' : null });
      }
    }, 6000);
    ws.onopen = () => {
      opened = true;
      clearTimeout(this.firstTimer);
      this.wsFails = 0;
      ws.send(JSON.stringify({ t: 'hello', role: this.role, key: this.key }));
      this.markOpen();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.dispatch(msg);
    };
    ws.onclose = () => {
      if (!opened) this.wsFails++;
      // zweimal hintereinander keine WebSocket-Verbindung: HTTP-Ersatzweg nutzen
      this.lost(session, { switchTo: !opened && this.wsFails >= 2 ? 'sse' : null });
    };
    ws.onerror = () => { try { ws.close(); } catch { /* egal */ } };
  }

  // ------------------------------------------------------------ Server-Sent Events
  connectSse(session) {
    if (!window.EventSource) {
      this.lost(session, { switchTo: 'poll' });
      return;
    }
    const es = new EventSource(`/events?${this.query()}`);
    this.es = es;
    let got = false;
    // Kommt nichts an, puffert ein Proxy dazwischen: auf Long-Polling wechseln
    this.firstTimer = setTimeout(() => { if (!got) this.lost(session, { switchTo: 'poll' }); }, 7000);
    es.onmessage = (ev) => {
      if (session !== this.session) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!got) {
        got = true;
        clearTimeout(this.firstTimer);
        this.markOpen();
        this.startPingCheck(session);
      }
      this.dispatch(msg);
    };
    es.onerror = () => {
      if (session !== this.session) return;
      this.lost(session, { switchTo: got ? null : 'poll' });
    };
  }

  /** Prüft regelmäßig, ob Antworten wirklich sofort ankommen (sonst Long-Polling) */
  startPingCheck(session) {
    const check = () => {
      if (session !== this.session) return;
      this.gotPong = false;
      this.send({ t: 'ping', at: Date.now() });
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (session === this.session && !this.gotPong) this.lost(session, { switchTo: 'poll' });
      }, 6000);
    };
    setTimeout(check, 300);
    this.pingTimer = setInterval(check, 15000);
  }

  // ------------------------------------------------------------ Long-Polling
  async connectPoll(session) {
    let first = true;
    while (session === this.session) {
      const ctrl = new AbortController();
      this.pollAbort = ctrl;
      let msgs;
      try {
        const res = await fetch(`/poll?${this.query()}&_=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        msgs = await res.json();
      } catch {
        if (session === this.session) this.lost(session);
        return;
      }
      if (session !== this.session) return;
      if (first) {
        first = false;
        this.markOpen();
      }
      for (const m of msgs) this.dispatch(m);
    }
  }

  // ------------------------------------------------------------ Senden
  send(obj) {
    if (!this.connected) return false;
    if (this.mode === 'ws') {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }
    // HTTP: aufeinanderfolgende Tipp-Updates zusammenfassen, Reihenfolge bleibt erhalten
    const last = this.outbox[this.outbox.length - 1];
    if (obj.t === 'type' && last && last.t === 'type') this.outbox[this.outbox.length - 1] = obj;
    else this.outbox.push(obj);
    this.flush();
    return true;
  }

  async flush() {
    if (this.sending || !this.outbox.length) return;
    this.sending = true;
    const batch = this.outbox.splice(0, this.outbox.length);
    const session = this.session;
    try {
      const res = await fetch(`/send?cid=${encodeURIComponent(this.cid)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        cache: 'no-store',
      });
      if (res.status === 409) {
        // Server kennt uns nicht mehr (z. B. neu gestartet): neu verbinden und nochmal senden
        this.outbox.unshift(...batch.filter((m) => m.t !== 'ping'));
        this.lost(session);
      }
    } catch {
      this.outbox.unshift(...batch.filter((m) => m.t !== 'ping'));
      this.lost(session);
    } finally {
      this.sending = false;
      if (this.connected) this.flush();
    }
  }
}
