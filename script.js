// script.js
// The Only Lift — User-fixed version
// - NO auto-enter / NO auto-exit (manual only)
// - Auto-close ALWAYS after CFG.doorAutoCloseMs when doors open
// - Robust storage wrapper (avoids SecurityError in restricted contexts)
// - ActionPanel attached to ROOT with high z-index so Masuk/Keluar buttons are clickable

const LiftSim = (function () {
  'use strict';

  /* -------------------------
     Utilities
  ------------------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const nowMs = () => Date.now();
  const secToMs = s => s * 1000;
  const rand = (a, b) => a + Math.random() * (b - a);
  const dispatch = (name, detail = {}) => window.dispatchEvent(new CustomEvent(name, { detail }));

  /* -------------------------
     Safe storage wrapper
     - Avoid direct localStorage/sessionStorage calls that throw SecurityError
  ------------------------- */
  const safeStorage = (function () {
    let ok = false;
    try {
      // feature-detect in try/catch
      ok = !!window && typeof window.localStorage !== 'undefined';
      // do one test access (wrapped) to detect blocked contexts
      if (ok) {
        try {
          const testKey = '__ls_test__';
          window.localStorage.setItem(testKey, '1');
          window.localStorage.removeItem(testKey);
          ok = true;
        } catch (e) {
          ok = false;
        }
      }
    } catch (e) {
      ok = false;
    }
    return {
      isAvailable: () => ok,
      set(key, value) {
        if (!ok) return;
        try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('safeStorage.set failed', e); }
      },
      get(key) {
        if (!ok) return null;
        try {
          const s = window.localStorage.getItem(key);
          return s ? JSON.parse(s) : null;
        } catch (e) { console.warn('safeStorage.get failed', e); return null; }
      },
      remove(key) {
        if (!ok) return;
        try { window.localStorage.removeItem(key); } catch (e) { console.warn('safeStorage.remove failed', e); }
      }
    };
  })();

  /* -------------------------
     DOM & Config
  ------------------------- */
  const ROOT = document.getElementById('app') || document.querySelector('.app') || document.body;

  const DEFAULT_CFG = {
    floors: 18,
    initialFloor: 0,
    passengerWeightKg: 75,
    maxSpeedMps: 2.5,
    floorHeightMeters: 3.0,
    physics: { accelLimit: 1.5, brakeLimit: 2.0 },
    persistenceKey: 'only-lift-world-v1',
    npcTrafficFactor: 0.02,
    randomEventRatePerSec: 0.00045,
    doorActionCooldownMs: 900,
    // default auto-close = 10000 ms (10 seconds)
    doorAutoCloseMs: 10000
  };

  const cfgNode = document.getElementById('app-config');
  let CFG = Object.assign({}, DEFAULT_CFG);
  if (cfgNode) {
    try {
      const parsed = JSON.parse(cfgNode.textContent);
      CFG = Object.assign(CFG, parsed);
      CFG.physics = Object.assign(DEFAULT_CFG.physics, parsed.physics || {});
      if (parsed.doorAutoCloseMs !== undefined) CFG.doorAutoCloseMs = parsed.doorAutoCloseMs;
    } catch (e) { console.warn('Invalid app-config JSON, using defaults.', e); }
  }

  if (ROOT) {
    if (ROOT.dataset.floors) CFG.floors = parseInt(ROOT.dataset.floors, 10);
    if (ROOT.dataset.initialFloor) CFG.initialFloor = parseInt(ROOT.dataset.initialFloor, 10);
    if (ROOT.dataset.passengerWeightKg) CFG.passengerWeightKg = parseFloat(ROOT.dataset.passengerWeightKg);
    if (ROOT.dataset.maxSpeedMps) CFG.maxSpeedMps = parseFloat(ROOT.dataset.maxSpeedMps);
    if (ROOT.dataset.floorHeightMeters) CFG.floorHeightMeters = parseFloat(ROOT.dataset.floorHeightMeters);
    if (ROOT.dataset.persistenceKey) CFG.persistenceKey = ROOT.dataset.persistenceKey;
    if (ROOT.dataset.doorAutoCloseMs) {
      const v = parseInt(ROOT.dataset.doorAutoCloseMs, 10);
      if (!Number.isNaN(v)) CFG.doorAutoCloseMs = v;
    }
  }

  /* -------------------------
     DOM refs (graceful fallback)
  ------------------------- */
  const DOM = {
    canvas: document.getElementById('shaftCanvas'),
    externalCallPanel: document.getElementById('externalCallPanel'),
    floorPanel: document.getElementById('floorButtons'),
    cabinControls: document.getElementById('cabinControls'),
    tplFloorButton: document.getElementById('tplFloorButton'),
    tplCallButton: document.getElementById('tplCallButton'),
    tplLogLine: document.getElementById('tplLogLine'),
    passengerLog: document.getElementById('passengerLog'),
    liveStatus: document.getElementById('liveStatus'),
    displayFloor: document.getElementById('displayBigFloor'),
    displaySmall: document.getElementById('displaySmall'),
    displayState: document.getElementById('displayState'),
    readoutLoad: document.getElementById('readoutLoad'),
    readoutSpeed: document.getElementById('readoutSpeed'),
    readoutDoor: document.getElementById('readoutDoor'),
    btnDoorOpen: document.getElementById('btnDoorOpen'),
    btnDoorClose: document.getElementById('btnDoorClose'),
    btnAlarm: document.getElementById('btnAlarm'),
    audioToggle: document.getElementById('audioToggle'),
    modal: document.getElementById('modal'),
    modalMessage: document.getElementById('modalMessage'),
    modalClose: document.getElementById('modalClose'),
    actionPanel: document.getElementById('actionPanel')
  };

  // ensure actionPanel exists & accessible; attach to ROOT to avoid overlay/hit-test issues
  if (DOM.actionPanel) {
    try {
      DOM.actionPanel.setAttribute('role', DOM.actionPanel.getAttribute('role') || 'region');
      DOM.actionPanel.setAttribute('aria-label', DOM.actionPanel.getAttribute('aria-label') || 'Tindakan cepat (Masuk/Keluar)');
      DOM.actionPanel.setAttribute('aria-live', DOM.actionPanel.getAttribute('aria-live') || 'polite');
      // ensure panel is able to receive pointer events
      DOM.actionPanel.style.pointerEvents = DOM.actionPanel.style.pointerEvents || 'auto';
      DOM.actionPanel.style.zIndex = DOM.actionPanel.style.zIndex || '99999';
    } catch (e) { console.warn('actionPanel attribute set failed', e); }
  } else {
    const ap = document.createElement('div');
    ap.id = 'actionPanel';
    ap.className = 'action-panel';
    ap.setAttribute('role', 'region');
    ap.setAttribute('aria-label', 'Tindakan cepat (Masuk/Keluar)');
    ap.setAttribute('aria-live', 'polite');

    // Place it in ROOT with fixed positioning so it's always clickable and visible
    ap.style.position = 'absolute';
    ap.style.right = '18px';
    ap.style.bottom = '18px';
    ap.style.display = 'flex';
    ap.style.flexWrap = 'wrap';
    ap.style.gap = '8px';
    ap.style.alignItems = 'center';
    ap.style.justifyContent = 'center';
    ap.style.pointerEvents = 'auto';
    ap.style.zIndex = '99999';
    // subtle background so it's visible but not obtrusive
    ap.style.background = 'rgba(0,0,0,0.0)';
    ap.style.padding = '4px';

    // append to ROOT (app container) not inside nested panels that might block clicks
    try {
      (ROOT || document.body).appendChild(ap);
      DOM.actionPanel = ap;
    } catch (e) {
      // fallback: append to body
      try { document.body.appendChild(ap); DOM.actionPanel = ap; } catch (e2) { console.warn('failed to append actionPanel', e2); }
    }
  }

  // ensure other fallback nodes exist
  if (!DOM.passengerLog) {
    const el = document.createElement('div'); el.id = 'passengerLog'; el.className = 'passenger-log';
    if (ROOT) ROOT.appendChild(el); DOM.passengerLog = el;
  }
  if (!DOM.floorPanel) {
    const el = document.createElement('nav'); el.id = 'floorButtons'; el.className = 'floor-buttons';
    if (ROOT) ROOT.appendChild(el); DOM.floorPanel = el;
  }
  if (!DOM.externalCallPanel) {
    const el = document.createElement('div'); el.id = 'externalCallPanel'; el.className = 'external-call-panel';
    if (ROOT) ROOT.appendChild(el); DOM.externalCallPanel = el;
  }

  /* -------------------------
     AudioEngine
  ------------------------- */
  const AudioEngine = (function () {
    let ctx = null, master = null, enabled = true, tts = true;
    function ensure() {
      if (ctx) return ctx;
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        ctx = new C();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
        return ctx;
      } catch (e) { console.warn('AudioContext unavailable', e); ctx = null; return null; }
    }
    function unlock() { const c = ensure(); if (!c) return; if (c.state === 'suspended' && c.resume) c.resume().catch(()=>{}); }
    function beep(opts = {}) {
      const { freq = 880, time = 0.06, vol = 0.14, type = 'sine' } = opts;
      const c = ensure(); if (!c || !enabled) return;
      try {
        const o = c.createOscillator(), g = c.createGain();
        o.type = type; o.frequency.value = freq; g.gain.value = 0;
        o.connect(g); g.connect(master);
        const t0 = c.currentTime;
        g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
        o.start(t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + time);
        setTimeout(() => { try { o.stop(); o.disconnect(); g.disconnect(); } catch (_) {} }, (time + 0.05) * 1000);
      } catch (e) {}
    }
    function chime() {
      const c = ensure(); if (!c || !enabled) return;
      try {
        const t0 = c.currentTime;
        const o1 = c.createOscillator(), g1 = c.createGain();
        o1.type='sine'; o1.frequency.value=880; o1.connect(g1); g1.connect(master);
        g1.gain.setValueAtTime(0.0001,t0); g1.gain.linearRampToValueAtTime(0.18,t0+0.02);
        o1.start(t0); o1.stop(t0+0.28);
        const o2 = c.createOscillator(), g2 = c.createGain();
        o2.type='sine'; o2.frequency.value=660; o2.connect(g2); g2.connect(master);
        g2.gain.setValueAtTime(0.0001,t0+0.18); g2.gain.linearRampToValueAtTime(0.15,t0+0.20);
        o2.start(t0+0.18); o2.stop(t0+0.44);
      } catch(e){}
    }
    function doorSwoosh(open=true) {
      const c = ensure(); if (!c || !enabled) return;
      try {
        const t0 = c.currentTime;
        const o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
        o.type='sawtooth'; o.frequency.value=240;
        f.type='lowpass'; f.frequency.value = open ? 1600 : 1200;
        o.connect(f); f.connect(g); g.connect(master);
        g.gain.setValueAtTime(0.0001,t0); g.gain.linearRampToValueAtTime(open ? 0.18 : 0.12, t0+0.02);
        o.start(t0);
        setTimeout(()=>{ try{ o.stop(); o.disconnect(); f.disconnect(); g.disconnect(); } catch(_){} }, 600);
      } catch(e){}
    }
    function announce(text) {
      if (!enabled) return;
      if (tts && window.speechSynthesis && 'SpeechSynthesisUtterance' in window) {
        try {
          const u = new SpeechSynthesisUtterance(String(text));
          const voices = window.speechSynthesis.getVoices();
          if (voices && voices.length) u.voice = voices.find(v => /id|en/i.test(v.lang)) || voices[0];
          unlock(); window.speechSynthesis.speak(u);
        } catch(e){ beep({freq:720,time:0.12}); }
      } else beep({freq:720,time:0.12});
    }
    function toggle(){ enabled = !enabled; if(!enabled && window.speechSynthesis) window.speechSynthesis.cancel(); return enabled; }
    return { ensure, unlock, beep, chime, doorSwoosh, announce, toggle, isEnabled:()=>enabled, setTts:v=>{tts=!!v;} };
  })();

  /* -------------------------
     Logging helper
  ------------------------- */
  function appendLogUI(msg) {
    const container = DOM.passengerLog;
    if (!container) { console.log(msg); return; }
    const tpl = DOM.tplLogLine;
    let node;
    if (tpl && tpl.content && tpl.content.firstElementChild) {
      node = tpl.content.firstElementChild.cloneNode(true);
      const t = node.querySelector('.log-time');
      const txt = node.querySelector('.log-text');
      if (t) t.textContent = (new Date()).toLocaleTimeString();
      if (txt) txt.textContent = msg;
    } else {
      node = document.createElement('div');
      node.className = 'log-line';
      const timeNode = document.createElement('span');
      timeNode.className = 'log-time';
      timeNode.textContent = (new Date()).toLocaleTimeString();
      const textNode = document.createElement('div');
      textNode.className = 'log-text';
      textNode.textContent = msg;
      node.appendChild(timeNode);
      node.appendChild(textNode);
    }
    container.prepend(node);
    while (container.children.length > 400) container.removeChild(container.lastChild);
    if (DOM.liveStatus) DOM.liveStatus.textContent = msg;
    console.debug('[LiftSim]', msg);
  }

  /* -------------------------
     Elevator Model
  ------------------------- */
  const EState = { IDLE:'IDLE', MOVING:'MOVING', ARRIVED:'ARRIVED', DOOR_OPEN:'DOOR_OPEN', DOOR_CLOSED:'DOOR_CLOSED', EMERGENCY:'EMERGENCY' };

  class Elevator {
    constructor(floors, initialFloor) {
      this.floors = floors;
      this.floorHeight = CFG.floorHeightMeters;
      this.position = this.floorToMeters(initialFloor);
      this.velocity = 0;
      this.acceleration = 0;
      this.targetFloor = null;
      this.queue = [];
      this.state = EState.IDLE;
      this.doorsOpen = false;
      this.doorProgress = 0;
      this.doorSpeed = 0.9;
      this.loadKg = 0;
      this.playerInside = false;
      this.lastDoorActionMs = 0;
      this.doorCooldownMs = CFG.doorActionCooldownMs || 900;
      this.overloadLimitKg = 1800;
      this.arrivalFloor = null;
      this.components = { door: 100, motor: 100 };
      this.autoCloseMs = CFG.doorAutoCloseMs || 10000;
      this.arrivalTs = 0;
      this._autoCloseTimer = null;
      this._lastManualActionKey = null;
      this._lastManualActionTs = 0;
    }

    floorToMeters(f) { return clamp(Math.floor(f), 0, this.floors - 1) * this.floorHeight; }
    metersToFloor(m) { return Math.round(m / this.floorHeight); }

    requestFloor(f) {
      const ff = clamp(Math.floor(f), 0, this.floors - 1);
      if (this.targetFloor === null && this.queue.length === 0) {
        this.targetFloor = ff;
      } else if (!this.queue.includes(ff) && this.targetFloor !== ff) {
        this.queue.push(ff);
      }
      dispatch('lift:call', { floor: ff, who: 'Passenger' });
    }

    requestExternal(f, who = 'NPC') {
      const ff = clamp(Math.floor(f), 0, this.floors - 1);
      if (this.targetFloor === null && this.queue.length === 0) {
        this.targetFloor = ff;
      } else if (!this.queue.includes(ff) && this.targetFloor !== ff) {
        this.queue.push(ff);
      }
      dispatch('lift:call', { floor: ff, who });
    }

    // Open doors and schedule unconditional auto-close after autoCloseMs
    openDoors() {
      if (this.components.door < 5) return false;
      this.doorsOpen = true;
      this.state = EState.DOOR_OPEN;
      this.arrivalTs = nowMs();
      AudioEngine.doorSwoosh(true);
      dispatch('lift:door', { state: 'open' });

      // clear previous timer
      if (this._autoCloseTimer) {
        clearTimeout(this._autoCloseTimer);
        this._autoCloseTimer = null;
      }

      const ms = Number(this.autoCloseMs) || 10000;
      try {
        this._autoCloseTimer = setTimeout(() => {
          try {
            if (this.doorsOpen) {
              this.closeDoors();
              appendLogUI(`Pintu otomatis ditutup setelah ${Math.round(ms / 1000)}s.`);
            }
          } catch (e) { /* ignore */ }
        }, ms);
      } catch (e) { console.warn('Auto-close scheduling failed', e); }

      return true;
    }

    // Close doors and clear auto-close timer
    closeDoors() {
      if (this.components.door < 5) return false;
      if (this._autoCloseTimer) {
        clearTimeout(this._autoCloseTimer);
        this._autoCloseTimer = null;
      }
      this.doorsOpen = false;
      this.state = EState.DOOR_CLOSED;
      AudioEngine.doorSwoosh(false);
      dispatch('lift:door', { state: 'closed' });
      return true;
    }

    enterPlayer(weight) {
      if (!this.doorsOpen || this.doorProgress < 0.9) return false;
      if (this.playerInside) return false;
      if (nowMs() - this.lastDoorActionMs < this.doorCooldownMs) return false;
      if (this.loadKg + weight > this.overloadLimitKg) return false;
      this.loadKg += weight;
      this.playerInside = true;
      this.lastDoorActionMs = nowMs();
      return true;
    }

    exitPlayer(weight) {
      if (!this.doorsOpen || this.doorProgress < 0.9) return false;
      if (!this.playerInside) return false;
      if (nowMs() - this.lastDoorActionMs < this.doorCooldownMs) return false;
      this.loadKg = Math.max(0, this.loadKg - weight);
      this.playerInside = false;
      this.lastDoorActionMs = nowMs();
      return true;
    }

    tryEnterOnce(actionKey, weight) {
      if (this._lastManualActionKey === actionKey && (nowMs() - this._lastManualActionTs) < 2500) return false;
      const ok = this.enterPlayer(weight);
      if (ok) { this._lastManualActionKey = actionKey; this._lastManualActionTs = nowMs(); }
      return ok;
    }

    tryExitOnce(actionKey, weight) {
      if (this._lastManualActionKey === actionKey && (nowMs() - this._lastManualActionTs) < 2500) return false;
      const ok = this.exitPlayer(weight);
      if (ok) { this._lastManualActionKey = actionKey; this._lastManualActionTs = nowMs(); }
      return ok;
    }

    popNextTarget() {
      if (this.targetFloor !== null) return;
      if (this.queue.length === 0) return;
      const cur = this.metersToFloor(this.position);
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < this.queue.length; i++) {
        const d = Math.abs(this.queue[i] - cur);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      this.targetFloor = this.queue.splice(bestIdx, 1)[0];
    }

    step(dt) {
      const ds = (1 / this.doorSpeed) * (0.5 + (this.components.door / 100) * 0.8);
      if (this.doorsOpen) this.doorProgress = clamp(this.doorProgress + ds * dt, 0, 1);
      else this.doorProgress = clamp(this.doorProgress - ds * dt, 0, 1);

      if (this.state === EState.EMERGENCY) return;

      if (this.doorsOpen && this.doorProgress > 0.05) {
        this.velocity = 0; this.acceleration = 0; this.state = EState.DOOR_OPEN;
        return;
      }

      if (this.targetFloor === null && this.queue.length) this.popNextTarget();
      if (this.targetFloor === null) {
        this.acceleration = -this.velocity * 1.8;
        this.velocity += this.acceleration * dt;
        this.position += this.velocity * dt;
        if (Math.abs(this.velocity) < 0.01) { this.velocity = 0; this.acceleration = 0; this.state = EState.IDLE; }
        return;
      }

      const targetPos = this.floorToMeters(this.targetFloor);
      const dist = targetPos - this.position;
      const dir = Math.sign(dist || 1);
      const absDist = Math.abs(dist);
      const brakingDist = (this.velocity * this.velocity) / (2 * CFG.physics.brakeLimit + 1e-6);

      if (absDist <= brakingDist + 0.03) {
        this.acceleration = -CFG.physics.brakeLimit * Math.sign(this.velocity || dir);
      } else {
        const desired = CFG.maxSpeedMps * dir;
        const err = desired - this.velocity;
        this.acceleration = clamp(err * 1.8, -CFG.physics.brakeLimit, CFG.physics.accelLimit);
      }

      this.velocity += this.acceleration * dt;
      this.velocity = clamp(this.velocity, -CFG.maxSpeedMps, CFG.maxSpeedMps);
      this.position += this.velocity * dt;
      this.state = EState.MOVING;

      if (absDist < 0.03 && Math.abs(this.velocity) < 0.06) {
        this.position = targetPos;
        this.velocity = 0; this.acceleration = 0;
        this.arrivalFloor = this.targetFloor;
        this.targetFloor = null;
        this.state = EState.ARRIVED;
        this.openDoors();
        AudioEngine.chime();
        AudioEngine.announce(`Lantai ${this.arrivalFloor}`);
        dispatch('lift:arrived', { floor: this.arrivalFloor });
      }
    }

    serialize() {
      return {
        pos: this.position, vel: this.velocity, acc: this.acceleration, target: this.targetFloor, queue: this.queue.slice(),
        doorsOpen: this.doorsOpen, doorProg: this.doorProgress, loadKg: this.loadKg, playerInside: this.playerInside,
        components: this.components, state: this.state, arrivalFloor: this.arrivalFloor,
        _lastManualActionKey: this._lastManualActionKey, _lastManualActionTs: this._lastManualActionTs,
        autoCloseMs: this.autoCloseMs
      };
    }

    static deserialize(obj, floors, initial) {
      const e = new Elevator(floors, initial);
      if (!obj) return e;
      e.position = obj.pos ?? e.position;
      e.velocity = obj.vel ?? 0;
      e.acceleration = obj.acc ?? 0;
      e.targetFloor = obj.target ?? null;
      e.queue = obj.queue || [];
      e.doorsOpen = !!obj.doorsOpen;
      e.doorProgress = obj.doorProg ?? 0;
      e.loadKg = obj.loadKg ?? 0;
      e.playerInside = !!obj.playerInside;
      e.components = obj.components || e.components;
      e.state = obj.state || e.state;
      e.arrivalFloor = obj.arrivalFloor ?? null;
      e._lastManualActionKey = obj._lastManualActionKey ?? null;
      e._lastManualActionTs = obj._lastManualActionTs ?? 0;
      e.autoCloseMs = obj.autoCloseMs ?? CFG.doorAutoCloseMs ?? e.autoCloseMs;
      return e;
    }
  }

  /* -------------------------
     World
  ------------------------- */
  class World {
    constructor() {
      this.elev = new Elevator(CFG.floors, CFG.initialFloor);
      this.playerFloor = CFG.initialFloor;
      this.playerRequestedFloor = null;
      this.calls = [];
      this.npcs = [];
      this.scheduled = [];
      this.logs = [];
      this.eventWindow = { start: nowMs(), count: 0, cap: 6 };
      this.lastPlayerCall = { floor: null, dir: null, ts: 0 };
      this.initNPCs();
    }

    initNPCs() {
      this.npcs = [];
      const count = Math.max(0, Math.round(CFG.floors * CFG.npcTrafficFactor));
      for (let i = 0; i < count; i++) this.npcs.push({ id: `NPC-${i + 1}`, nextActionMs: nowMs() + rand(20_000, 90_000), busyUntil: 0 });
    }

    log(msg) {
      const t = new Date();
      const line = `[${t.toLocaleTimeString()}] ${msg}`;
      this.logs.unshift(line);
      if (this.logs.length > 400) this.logs.length = 400;
      appendLogUI(msg);
    }

    playerCall(floor, dir = 'up') {
      const now = nowMs();
      if (this.lastPlayerCall.floor === floor && this.lastPlayerCall.dir === dir && now - (this.lastPlayerCall.ts || 0) < 1800) {
        this.log('Panggilan diabaikan (terlalu cepat).');
        return false;
      }
      this.lastPlayerCall = { floor, dir, ts: now };
      if (this.calls.some(c => c.floor === floor && c.dir === dir && (c.status === 'pending' || c.status === 'assigned'))) {
        this.log(`Panggilan sudah terdaftar di lantai ${floor}`);
        return false;
      }
      const id = `call-${Math.floor(now)}-${Math.round(Math.random() * 9999)}`;
      const call = { id, floor, dir, who: 'Passenger', ts: now, status: 'pending' };
      this.calls.push(call);
      this.log(`Panggil ${dir} di lantai ${floor}`);
      dispatch('lift:call', { floor, dir, who: 'Passenger' });
      return true;
    }

    requestExternalCall(floor, dir = 'up', who = 'NPC') {
      const now = nowMs();
      if (this.calls.some(c => c.floor === floor && c.dir === dir && (c.status === 'pending' || c.status === 'assigned') && c.who === who)) return;
      const id = `call-${Math.floor(now)}-${Math.round(Math.random() * 9999)}`;
      const call = { id, floor, dir, who, ts: now, status: 'pending' };
      this.calls.push(call);
      this.log(`${who} called ${dir} at floor ${floor}`);
      dispatch('lift:call', { floor, dir, who });
    }

    assignCalls() {
      if (this.elev.targetFloor !== null) return;
      const pending = this.calls.filter(c => c.status === 'pending');
      if (!pending.length) return;
      const cur = this.elev.metersToFloor(this.elev.position);
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < pending.length; i++) {
        const d = Math.abs(pending[i].floor - cur);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      const chosen = pending[bestIdx];
      const idxAll = this.calls.findIndex(c => c.id === chosen.id);
      if (idxAll >= 0) {
        this.calls[idxAll].status = 'assigned';
        this.calls[idxAll].assignedTs = nowMs();
      }
      this.elev.requestExternal(chosen.floor, chosen.who);
      this.log(`Lift ditugaskan ke panggilan di lantai ${chosen.floor} (oleh ${chosen.who})`);
    }

    markCallServedAtFloor(floor) {
      for (let i = 0; i < this.calls.length; i++) {
        const c = this.calls[i];
        if (c.floor === floor && (c.status === 'pending' || c.status === 'assigned')) {
          c.status = 'served';
          c.servedTs = nowMs();
        }
      }
    }

    stepNPCs(dt) {
      const now = nowMs();
      for (const npc of this.npcs) {
        if (now >= npc.nextActionMs && !npc.busyUntil) {
          if (Math.random() < 0.28) {
            const f = Math.floor(Math.random() * this.elev.floors);
            const dir = Math.random() < 0.5 ? 'up' : 'down';
            this.requestExternalCall(f, dir, npc.id);
            npc.busyUntil = now + rand(20_000, 90_000);
            npc.nextActionMs = now + rand(40_000, 160_000);
          } else {
            npc.nextActionMs = now + rand(25_000, 120_000);
          }
        }
        if (npc.busyUntil && now >= npc.busyUntil) npc.busyUntil = 0;
      }
    }

    stepBoarding(dt) {
      const e = this.elev;
      if (!(e.doorsOpen && e.doorProgress > 0.98)) return;
      if (nowMs() - e.lastDoorActionMs < e.doorCooldownMs) return;

      const liftFloor = e.metersToFloor(e.position);

      // mark calls served at this floor
      this.markCallServedAtFloor(liftFloor);

      // NPC automatic boarding/exiting (sparse)
      if (Math.random() < 0.06 * dt) {
        const w = 50 + Math.random() * 90;
        if (e.loadKg + w < e.overloadLimitKg) {
          e.loadKg += w;
          this.log(`NPC naik (~${Math.round(w)} kg)`);
          e.requestFloor(Math.floor(Math.random() * e.floors));
        } else this.log('NPC terblokir (overload)');
        e.lastDoorActionMs = nowMs();
      }
      if (Math.random() < 0.04 * dt && e.loadKg > 0) {
        const out = Math.min(e.loadKg, 20 + Math.random() * 80);
        e.loadKg = Math.max(0, e.loadKg - out);
        this.log(`NPC turun (~${Math.round(out)} kg)`);
        e.lastDoorActionMs = nowMs();
      }
    }

    shouldTriggerEvent(ratePerSec, dt) {
      const now = nowMs();
      if (now - this.eventWindow.start > 60_000) {
        this.eventWindow.start = now;
        this.eventWindow.count = 0;
      }
      if (this.eventWindow.count >= this.eventWindow.cap) return false;
      if (Math.random() < ratePerSec * dt) { this.eventWindow.count++; return true; }
      return false;
    }

    processScheduled() {
      const now = nowMs();
      for (let i = this.scheduled.length - 1; i >= 0; i--) {
        if (now >= this.scheduled[i].ts) {
          const ev = this.scheduled.splice(i, 1)[0];
          this.handleEvent(ev.type, ev.payload);
        }
      }
    }

    handleEvent(type, payload) {
      if (type === 'door_jam') {
        this.log('Door jam occurred.');
        this.elev.components.door = Math.max(0, this.elev.components.door - Math.round(rand(6, 18)));
        if (Math.random() < 0.5) {
          this.elev.doorsOpen = true; this.elev.doorProgress = 1; this.elev.state = EState.DOOR_OPEN; this.elev.holdDoor = true; this.log('Door jammed open.');
        } else {
          this.elev.doorsOpen = false; this.elev.doorProgress = 0; this.elev.state = EState.DOOR_CLOSED; this.elev.holdDoor = true; this.log('Door jammed closed.');
        }
        this.scheduled.push({ ts: nowMs() + secToMs(rand(12, 40)), type: 'auto_repair', payload: { comp: 'door' } });
      } else if (type === 'auto_repair') {
        const comp = payload?.comp || 'door';
        const amt = Math.round(rand(12, 40));
        if (this.elev.components[comp] !== undefined) {
          this.elev.components[comp] = clamp(this.elev.components[comp] + amt, 0, 100);
          this.log(`Auto repair: ${comp} +${amt}%`);
          this.elev.holdDoor = false;
        }
      }
    }

    step(dt) {
      this.stepNPCs(dt);
      this.processScheduled();
      if (this.shouldTriggerEvent(CFG.randomEventRatePerSec, dt) && Math.random() < 0.6) {
        this.scheduled.push({ ts: nowMs() + secToMs(rand(2, 20)), type: 'door_jam' });
      }
      this.elev.step(dt);
      this.stepBoarding(dt);
      this.assignCalls();
    }

    serialize() {
      return {
        elev: this.elev.serialize(),
        playerFloor: this.playerFloor,
        playerRequestedFloor: this.playerRequestedFloor,
        calls: this.calls.slice(),
        scheduled: this.scheduled.slice(),
        npcs: this.npcs.map(n => ({ id: n.id, nextActionMs: n.nextActionMs, busyUntil: n.busyUntil })),
        logs: this.logs.slice(0, 200),
        ts: nowMs()
      };
    }

    static deserialize(obj) {
      const w = new World();
      if (!obj) return w;
      try {
        if (obj.elev) w.elev = Elevator.deserialize(obj.elev, CFG.floors, CFG.initialFloor);
        w.playerFloor = obj.playerFloor ?? CFG.initialFloor;
        w.playerRequestedFloor = obj.playerRequestedFloor ?? null;
        w.calls = obj.calls || [];
        w.scheduled = obj.scheduled || [];
        if (Array.isArray(obj.npcs)) w.npcs = obj.npcs.map(n => ({ id: n.id, nextActionMs: n.nextActionMs || nowMs() + rand(10000, 60000), busyUntil: n.busyUntil || 0 }));
        w.logs = obj.logs || [];
      } catch (e) { console.warn('deserialize fail', e); }
      return w;
    }
  }

  /* -------------------------
     Renderer (unchanged)
  ------------------------- */
  class Renderer {
    constructor(canvas, world) {
      this.canvas = canvas; this.world = world;
      this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null;
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }
    resize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.floor(Math.max(240, rect.width) * this.dpr);
      this.canvas.height = Math.floor(Math.max(240, rect.height) * this.dpr);
      if (this.ctx && this.ctx.setTransform) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    draw() {
      if (!this.ctx) return;
      const ctx = this.ctx; const W = this.canvas.width / this.dpr; const H = this.canvas.height / this.dpr;
      ctx.clearRect(0, 0, W, H);
      const pad = 12;
      const shaftW = Math.min(340, W * 0.30);
      const shaftX = pad, shaftY = pad, shaftH = H - pad * 2;
      ctx.fillStyle = '#071426'; ctx.fillRect(shaftX, shaftY, shaftW, shaftH);
      const fc = this.world.elev.floors;
      const floorH = Math.max(28, Math.floor((shaftH - 8) / fc));
      const totalH = floorH * fc;
      const top = shaftY + (shaftH - totalH);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
      ctx.font = '11px ui-monospace, monospace';
      for (let i = 0; i < fc; i++) {
        const y = top + i * floorH;
        ctx.beginPath(); ctx.moveTo(shaftX, y); ctx.lineTo(shaftX + shaftW, y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillText(`${fc - 1 - i}`, shaftX + shaftW + 8, y + 12);
      }
      const carW = Math.min(170, shaftW * 0.58);
      const carH = floorH - 6;
      const carX = shaftX + (shaftW - carW) / 2;
      const posRatio = this.world.elev.position / Math.max(1, this.world.elev.floorToMeters(this.world.elev.floors - 1));
      const carY = top + (fc - 1) * floorH - posRatio * ((fc - 1) * floorH) - carH / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(carX + 6, carY); ctx.lineTo(carX + 6, top - 8); ctx.moveTo(carX + carW - 6, carY); ctx.lineTo(carX + carW - 6, top - 8); ctx.stroke();
      ctx.fillStyle = '#0f3a4a'; ctx.fillRect(carX, carY, carW, carH);
      ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(carX + 6, carY + 6, carW - 12, carH - 12);
      const doorProg = this.world.elev.doorProgress; const panelW = carW / 2;
      const leftX = carX + (1 - doorProg) * (panelW * 0.9);
      const rightX = carX + carW - panelW - (1 - doorProg) * (panelW * 0.9);
      ctx.fillStyle = '#021b25'; ctx.fillRect(leftX, carY, panelW, carH); ctx.fillRect(rightX, carY, panelW, carH);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.strokeRect(carX, carY, carW, carH);
      ctx.fillStyle = 'rgba(0,0,0,0.36)'; ctx.fillRect(shaftX + 12, 10, 300, 64);
      ctx.fillStyle = '#cfeffb'; ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(`Pos: ${this.world.elev.position.toFixed(2)} m`, shaftX + 24, 30);
      ctx.fillText(`Vel: ${this.world.elev.velocity.toFixed(2)} m/s`, shaftX + 24, 52);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(`Target: ${this.world.elev.targetFloor === null ? '-' : this.world.elev.targetFloor}`, shaftX + 200, 30);
      ctx.fillText(`Load: ${Math.round(this.world.elev.loadKg)} kg`, shaftX + 200, 52);
    }
  }

  /* -------------------------
     UI: external panel, keypad, action panel
  ------------------------- */
  let lastRenderedSnapshot = null;

  function renderExternalPanel(world) {
    const panel = DOM.externalCallPanel; if (!panel) return;
    const f = world.playerFloor;
    const hasPending = world.calls.some(c => c.floor === f && c.who === 'Passenger' && (c.status === 'pending' || c.status === 'assigned'));
    const elevTarget = world.elev.targetFloor;
    const snapshot = `${f}|pending:${hasPending}|target:${elevTarget}|doors:${world.elev.doorsOpen}|playerInside:${world.elev.playerInside}`;
    if (snapshot === lastRenderedSnapshot) return;
    lastRenderedSnapshot = snapshot;
    panel.innerHTML = '';
    const row = document.createElement('div'); row.className = 'external-row single';
    const label = document.createElement('div'); label.className = 'external-floor-label'; label.textContent = `Lantai ${f}`; row.appendChild(label);
    const group = document.createElement('div'); group.className = 'external-group single';
    const up = document.createElement('button'); up.className = 'call-up single'; up.type='button'; up.setAttribute('aria-label', `Panggil naik di lantai ${f}`); up.textContent='▲'; up.tabIndex=0;
    const down = document.createElement('button'); down.className='call-down single'; down.type='button'; down.setAttribute('aria-label', `Panggil turun di lantai ${f}`); down.textContent='▼'; down.tabIndex=0;
    if (world.elev.playerInside) {
      up.disabled = true; down.disabled = true; up.title='Anda berada di dalam lift'; down.title='Anda berada di dalam lift';
    } else {
      if (f >= CFG.floors - 1) up.disabled = true;
      if (f <= 0) down.disabled = true;
      if (hasPending) {
        up.disabled = true; down.disabled = true;
        const badge = document.createElement('div'); badge.className='external-badge';
        const assigned = world.calls.some(c => c.floor===f && c.who==='Passenger' && c.status==='assigned');
        badge.textContent = assigned ? 'Panggilan: ditugaskan' : 'Panggilan: menunggu';
        row.appendChild(badge);
      } else {
        up.addEventListener('click', () => {
          if (up.disabled) return;
          up.disabled = true; setTimeout(()=>{ up.disabled=false; }, 900);
          AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
          const ok = world.playerCall(f, 'up'); if (!ok) appendLogUI('Panggilan tidak dibuat (duplicate/debounce).');
        });
        down.addEventListener('click', () => {
          if (down.disabled) return;
          down.disabled = true; setTimeout(()=>{ down.disabled=false; }, 900);
          AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
          const ok = world.playerCall(f, 'down'); if (!ok) appendLogUI('Panggilan tidak dibuat (duplicate/debounce).');
        });
      }
    }
    group.appendChild(up); group.appendChild(down); row.appendChild(group); panel.appendChild(row);
  }

  function buildInternalKeypad(world) {
    const container = DOM.floorPanel; if (!container) return;
    container.innerHTML = '';
    const tpl = DOM.tplFloorButton;
    for (let f = CFG.floors - 1; f >= 0; f--) {
      let btn;
      if (tpl && tpl.content && tpl.content.firstElementChild) btn = tpl.content.firstElementChild.cloneNode(true);
      else { btn = document.createElement('button'); btn.className='floor-btn'; btn.type='button'; btn.innerHTML=`<span class="floor-num">${f}</span>`; }
      btn.dataset.floor = f;
      const span = btn.querySelector('.floor-num'); if (span) span.textContent = f;
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        if (btn.classList.contains('floor-selected')) { appendLogUI(`Lantai ${f} sudah dipilih.`); return; }
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep({freq:880,time:0.06});
        if (!world.elev.playerInside) { appendLogUI('Keypad hanya aktif saat berada di dalam kabin.'); return; }
        world.elev.requestFloor(f);
        btn.classList.add('floor-selected'); btn.setAttribute('aria-pressed','true');
        world.playerRequestedFloor = f;
        appendLogUI(`Meminta lantai ${f}`);
      });
      container.appendChild(btn);
    }
    container.style.display = world.elev.playerInside ? 'grid' : 'none';
  }

  function clearSelectedKeypadButton(floor) {
    const btn = DOM.floorPanel.querySelector(`.floor-btn[data-floor="${floor}"]`);
    if (btn) { btn.classList.remove('floor-selected'); btn.setAttribute('aria-pressed','false'); }
  }

  function renderActionPanel(world) {
    const ap = DOM.actionPanel; if (!ap) return;
    ap.innerHTML = '';
    const e = world.elev;
    if (!(e.doorsOpen && e.doorProgress > 0.98)) { ap.style.display='none'; return; }
    ap.style.display='flex'; ap.style.pointerEvents='auto'; ap.style.zIndex='99999';
    const liftFloor = e.metersToFloor(e.position);

    // Masuk (manual)
    if (!e.playerInside && liftFloor === world.playerFloor) {
      const btn = document.createElement('button'); btn.className='action-btn enter'; btn.type='button'; btn.textContent='Masuk';
      btn.setAttribute('aria-label', `Masuk lift di lantai ${liftFloor}`); btn.tabIndex=0;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (btn.disabled) return;
        btn.disabled = true; setTimeout(()=>{ btn.disabled=false; }, 1200);
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
        const actionKey = `manualEnter:${liftFloor}:${Math.floor(e.arrivalTs/1000)}`;
        const ok = e.tryEnterOnce(actionKey, CFG.passengerWeightKg);
        if (ok) {
          world.log(`Anda masuk ke lift (manual) di lantai ${liftFloor}`);
          dispatch('lift:boarded', { floor: liftFloor });
          AudioEngine.announce('Anda masuk ke lift');
          buildInternalKeypad(world);
          updatePanelsVisibility(world);
        } else world.log('Gagal masuk (manual) — mungkin sudah masuk atau terblokir.');
      });
      ap.appendChild(btn);
    }

    // Keluar (manual)
    if (e.playerInside) {
      const btn = document.createElement('button'); btn.className='action-btn exit'; btn.type='button'; btn.textContent='Keluar';
      btn.setAttribute('aria-label', `Keluar lift di lantai ${liftFloor}`); btn.tabIndex=0;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (btn.disabled) return;
        btn.disabled = true; setTimeout(()=>{ btn.disabled=false; }, 1200);
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
        const actionKey = `manualExit:${liftFloor}:${Math.floor(e.arrivalTs/1000)}`;
        const ok = e.tryExitOnce(actionKey, CFG.passengerWeightKg);
        if (ok) {
          world.playerFloor = liftFloor;
          world.log(`Anda keluar (manual) di lantai ${liftFloor}`);
          dispatch('lift:exited', { floor: liftFloor });
          AudioEngine.announce(`Anda turun di lantai ${liftFloor}`);
          if (world.playerRequestedFloor === liftFloor) world.playerRequestedFloor = null;
          buildInternalKeypad(world);
          updatePanelsVisibility(world);
        } else world.log('Gagal keluar (manual) — mungkin sudah keluar atau terblokir.');
      });
      ap.appendChild(btn);
    }
  }

  function updatePanelsVisibility(world) {
    const inside = world.elev.playerInside;
    if (DOM.externalCallPanel) DOM.externalCallPanel.style.display = !inside ? '' : 'none';
    if (DOM.floorPanel) DOM.floorPanel.style.display = inside ? 'grid' : 'none';
    if (DOM.cabinControls) DOM.cabinControls.style.display = inside ? '' : 'none';
    if (DOM.btnDoorOpen) DOM.btnDoorOpen.disabled = !inside;
    if (DOM.btnDoorClose) DOM.btnDoorClose.disabled = !inside;
    if (DOM.btnAlarm) DOM.btnAlarm.disabled = false;
    if (DOM.displaySmall) {
      const liftF = world.elev.metersToFloor(world.elev.position);
      const youState = inside ? `Anda: di dalam (asal ${world.playerFloor})` : `Anda: ${world.playerFloor} (di luar)`;
      DOM.displaySmall.textContent = `Lift: ${liftF} — ${youState}`;
    }
  }

  function wireControls(world) {
    if (DOM.btnDoorOpen) {
      DOM.btnDoorOpen.addEventListener('click', () => {
        if (DOM.btnDoorOpen.disabled) return;
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
        const ok = world.elev.openDoors();
        appendLogUI(ok ? 'Pintu dibuka.' : 'Gagal membuka pintu.');
        if (ok) AudioEngine.announce('Pintu terbuka');
      });
    }
    if (DOM.btnDoorClose) {
      DOM.btnDoorClose.addEventListener('click', () => {
        if (DOM.btnDoorClose.disabled) return;
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
        const ok = world.elev.closeDoors();
        appendLogUI(ok ? 'Pintu ditutup.' : 'Penutupan pintu tertahan.');
        if (ok) AudioEngine.announce('Pintu tertutup');
      });
    }
    if (DOM.btnAlarm) {
      DOM.btnAlarm.addEventListener('click', () => {
        const last = DOM.btnAlarm._lastTs || 0;
        if (nowMs() - last < 2000) { appendLogUI('Alarm: sudah dipanggil baru-baru ini.'); return; }
        DOM.btnAlarm._lastTs = nowMs();
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep({ freq: 240, time: 0.28, vol: 0.28 });
        appendLogUI('Alarm ditekan — bantuan diberitahu (simulasi).');
        dispatch('lift:alarm', { who: 'Passenger' });
        world.scheduled.push({ ts: nowMs() + secToMs(8), type: 'auto_repair', payload: { comp: 'control' } });
      });
    }
    if (DOM.modalClose) DOM.modalClose.addEventListener('click', () => { if (DOM.modal) DOM.modal.setAttribute('aria-hidden', 'true'); });
    if (DOM.audioToggle) {
      DOM.audioToggle.addEventListener('click', () => {
        const on = AudioEngine.toggle(); DOM.audioToggle.textContent = on ? '🔊' : '🔇';
        appendLogUI(on ? 'Suara aktif' : 'Suara dimatikan');
      });
    }
    window.addEventListener('keydown', (e) => {
      try {
        if (e.key.toLowerCase() === 'm') {
          const on = AudioEngine.toggle(); if (DOM.audioToggle) DOM.audioToggle.textContent = on ? '🔊' : '🔇';
          appendLogUI(on ? 'Suara aktif' : 'Suara dimatikan');
        } else if (e.key.toLowerCase() === 'o') DOM.btnDoorOpen?.click();
        else if (e.key.toLowerCase() === 'c') DOM.btnDoorClose?.click();
      } catch (err) { /* ignore */ }
    });

    window.addEventListener('lift:arrived', (e) => { if (e?.detail) appendLogUI(`Lift tiba di lantai ${e.detail.floor}`); });
    window.addEventListener('lift:door', (e) => { if (e?.detail?.state) appendLogUI(`Door ${e.detail.state}`); });
    window.addEventListener('lift:call', (e) => { if (e?.detail) appendLogUI(`Call: ${e.detail.floor} by ${e.detail.who || 'unknown'}`); });
    window.addEventListener('lift:boarded', (e) => { appendLogUI('Anda berada di dalam lift.'); buildInternalKeypad(world); updatePanelsVisibility(world); });
    window.addEventListener('lift:exited', (e) => { appendLogUI('Anda berada di luar lift.'); if (typeof e?.detail?.floor === 'number') clearSelectedKeypadButton(e.detail.floor); buildInternalKeypad(world); updatePanelsVisibility(world); });
  }

  /* Persistence */
  const PERSIST_KEY = CFG.persistenceKey || 'only-lift-world-v1';
  function saveNow(world) {
    try { safeStorage.set(PERSIST_KEY, { ts: nowMs(), world: world.serialize() }); }
    catch (e) { console.warn('saveNow failed', e); }
  }
  function tryLoad() { try { return safeStorage.get(PERSIST_KEY); } catch (e) { return null; } }

  /* Bootstrap */
  let world;
  const saved = tryLoad();
  if (saved && saved.world) {
    try {
      world = World.deserialize(saved.world);
      const delta = Math.floor((nowMs() - (saved.ts || nowMs())) / 1000);
      const ff = Math.min(delta, 60 * 10);
      if (ff > 2) {
        let ran = 0; const stepSec = 5;
        while (ran < ff) { world.step(Math.min(stepSec, ff - ran)); ran += stepSec; }
        world.log(`Fast-forwarded ${Math.round(ff)}s since last session`);
      }
    } catch (e) { console.warn('Failed to deserialize saved world; creating new one.', e); world = new World(); world.log('World initialized (fresh).'); }
  } else { world = new World(); world.log('World initialized (fresh).'); }

  const renderer = new Renderer(DOM.canvas, world);
  buildInternalKeypad(world);
  renderExternalPanel(world);
  updatePanelsVisibility(world);
  wireControls(world);

  window.addEventListener('lift:arrived', () => {
    renderExternalPanel(world);
    const f = world.elev.arrivalFloor;
    if (typeof f === 'number') {
      world.markCallServedAtFloor(f);
      if (world.playerRequestedFloor === f) clearSelectedKeypadButton(f);
    }
  });
  window.addEventListener('lift:call', () => { renderExternalPanel(world); });

  /* Simulation loop */
  let lastRAF = performance.now();
  let accumulator = 0;
  const STEP_MS = 1000 / 60;

  function frame(now) {
    const delta = Math.min(200, now - lastRAF);
    lastRAF = now;
    accumulator += delta;
    let steps = 0;
    while (accumulator >= STEP_MS && steps < 8) {
      world.step(STEP_MS / 1000);
      accumulator -= STEP_MS;
      steps++;
    }

    renderer.draw();

    if (DOM.displayFloor) DOM.displayFloor.textContent = String(world.elev.metersToFloor(world.elev.position));
    if (DOM.displayState) DOM.displayState.textContent = world.elev.state;
    if (DOM.readoutLoad) DOM.readoutLoad.textContent = `${Math.round(world.elev.loadKg)} kg`;
    if (DOM.readoutSpeed) DOM.readoutSpeed.textContent = `${world.elev.velocity.toFixed(2)} m/s`;
    if (DOM.readoutDoor) DOM.readoutDoor.textContent = world.elev.doorsOpen ? 'Terbuka' : 'Tertutup';

    renderExternalPanel(world);
    renderActionPanel(world);
    updatePanelsVisibility(world);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => { lastRAF = t; requestAnimationFrame(frame); });

  setInterval(() => saveNow(world), 8000);
  const unlockOnce = () => { AudioEngine.ensure(); AudioEngine.unlock(); window.removeEventListener('click', unlockOnce); };
  window.addEventListener('click', unlockOnce, { once: true });

  window.LiftSim = {
    world, cfg: CFG, audio: AudioEngine,
    saveNow: () => { saveNow(world); appendLogUI('World saved'); },
    reset: (preserveFloor = true) => {
      const f = preserveFloor ? world.playerFloor : CFG.initialFloor;
      try { safeStorage.remove(PERSIST_KEY); } catch (e) { /* ignore */ }
      world = new World();
      world.playerFloor = f;
      buildInternalKeypad(world);
      renderExternalPanel(world);
      updatePanelsVisibility(world);
      appendLogUI('World reset');
      return world;
    }
  };

  appendLogUI('Simulator siap — Auto-enter/auto-exit dimatikan; masuk/keluar manual. Auto-close = ' + (CFG.doorAutoCloseMs/1000) + 's; tombol Masuk/Keluar harusnya bisa diklik. Tekan "m" untuk mute/unmute.');
  console.info('LiftSim initialized', { cfg: CFG });

  return { world, cfg: CFG, audio: AudioEngine };
})(); // end LiftSim

export default LiftSim;
