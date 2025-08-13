// script.js
// The Only Lift — Passenger-first, robust, auto-enter/auto-exit, perfect-ish simulator
// Usage: include as <script type="module" src="script.js" defer></script>

const LiftSim = (function () {
  'use strict';

  /* -------------------------
     Utilities
  ------------------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const nowMs = () => Date.now();
  const secToMs = s => s * 1000;
  const rand = (a, b) => a + Math.random() * (b - a);
  const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('saveJSON failed', e); } };
  const loadJSON = (k) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { console.warn('loadJSON failed', e); return null; } };
  const dispatch = (name, detail = {}) => window.dispatchEvent(new CustomEvent(name, { detail }));

  /* -------------------------
     DOM & Config
  ------------------------- */
  const ROOT = document.getElementById('app') || document.body;

  // default config - can be overridden by #app-config JSON or data-* on #app
  const DEFAULT_CFG = {
    floors: 18,
    initialFloor: 0,
    floorOrder: 'descending',
    passengerWeightKg: 75,
    maxSpeedMps: 2.5,
    floorHeightMeters: 3.0,
    physics: { accelLimit: 1.5, brakeLimit: 2.0 },
    persistenceKey: 'only-lift-world-v1',
    npcTrafficFactor: 0.02,
    randomEventRatePerSec: 0.00045,
    autoBoardDelayMs: 220,
    autoExitDelayMs: 220,
    doorActionCooldownMs: 900
  };

  // merge config from <script id="app-config"> JSON if present
  const cfgNode = document.getElementById('app-config');
  let CFG = Object.assign({}, DEFAULT_CFG);
  if (cfgNode) {
    try {
      const parsed = JSON.parse(cfgNode.textContent);
      CFG = Object.assign(CFG, parsed);
      CFG.physics = Object.assign(DEFAULT_CFG.physics, parsed.physics || {});
    } catch (e) {
      console.warn('Invalid app-config JSON, using defaults.', e);
    }
  }
  // override with data-* on #app if present
  if (ROOT) {
    if (ROOT.dataset.floors) CFG.floors = parseInt(ROOT.dataset.floors, 10);
    if (ROOT.dataset.initialFloor) CFG.initialFloor = parseInt(ROOT.dataset.initialFloor, 10);
    if (ROOT.dataset.passengerWeightKg) CFG.passengerWeightKg = parseFloat(ROOT.dataset.passengerWeightKg);
    if (ROOT.dataset.maxSpeedMps) CFG.maxSpeedMps = parseFloat(ROOT.dataset.maxSpeedMps);
    if (ROOT.dataset.floorHeightMeters) CFG.floorHeightMeters = parseFloat(ROOT.dataset.floorHeightMeters);
    if (ROOT.dataset.persistenceKey) CFG.persistenceKey = ROOT.dataset.persistenceKey;
  }

  // DOM references (fall back gracefully)
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
    modalClose: document.getElementById('modalClose')
  };

  // small safety for elements that might be missing: ensure minimal structure
  if (!DOM.passengerLog) {
    const el = document.createElement('div'); el.id = 'passengerLog'; el.className = 'passenger-log'; if (ROOT) ROOT.appendChild(el); DOM.passengerLog = el;
  }
  if (!DOM.floorPanel) {
    const el = document.createElement('nav'); el.id = 'floorButtons'; el.className = 'floor-buttons'; if (ROOT) ROOT.appendChild(el); DOM.floorPanel = el;
  }
  if (!DOM.externalCallPanel) {
    const el = document.createElement('div'); el.id = 'externalCallPanel'; el.className = 'external-call-panel'; if (ROOT) ROOT.appendChild(el); DOM.externalCallPanel = el;
  }

  /* -------------------------
     Audio Engine
  ------------------------- */
  const AudioEngine = (function () {
    let ctx = null;
    let master = null;
    let enabled = true;
    let tts = true;

    function ensure() {
      if (ctx) return ctx;
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        ctx = new C();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
        return ctx;
      } catch (e) {
        console.warn('AudioContext unavailable', e);
        ctx = null;
        return null;
      }
    }

    function unlock() {
      const c = ensure();
      if (!c) return;
      if (c.state === 'suspended' && c.resume) c.resume().catch(() => {});
    }

    function beep(opts = {}) {
      const { freq = 880, time = 0.06, vol = 0.14, type = 'sine' } = opts;
      const c = ensure();
      if (!c || !enabled) return;
      try {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.value = 0;
        o.connect(g);
        g.connect(master);
        const t0 = c.currentTime;
        g.gain.linearRampToValueAtTime(vol, t0 + 0.006);
        o.start(t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + time);
        setTimeout(() => { try { o.stop(); o.disconnect(); g.disconnect(); } catch (_) {} }, (time + 0.05) * 1000);
      } catch (e) { /* ignore */ }
    }

    function chime() {
      const c = ensure();
      if (!c || !enabled) return;
      try {
        const t0 = c.currentTime;
        const o1 = c.createOscillator(), g1 = c.createGain();
        o1.type = 'sine'; o1.frequency.value = 880; o1.connect(g1); g1.connect(master);
        g1.gain.setValueAtTime(0.0001, t0); g1.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
        o1.start(t0); o1.stop(t0 + 0.28);

        const o2 = c.createOscillator(), g2 = c.createGain();
        o2.type = 'sine'; o2.frequency.value = 660; o2.connect(g2); g2.connect(master);
        g2.gain.setValueAtTime(0.0001, t0 + 0.18); g2.gain.linearRampToValueAtTime(0.15, t0 + 0.20);
        o2.start(t0 + 0.18); o2.stop(t0 + 0.44);
      } catch (e) {}
    }

    function doorSwoosh(open = true) {
      const c = ensure();
      if (!c || !enabled) return;
      try {
        const t0 = c.currentTime;
        const o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
        o.type = 'sawtooth'; o.frequency.value = 240;
        f.type = 'lowpass'; f.frequency.value = open ? 1600 : 1200;
        o.connect(f); f.connect(g); g.connect(master);
        g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(open ? 0.18 : 0.12, t0 + 0.02);
        o.start(t0);
        setTimeout(() => { try { o.stop(); o.disconnect(); f.disconnect(); g.disconnect(); } catch (_) {} }, 600);
      } catch (e) {}
    }

    function announce(text) {
      if (!enabled) return;
      if (tts && window.speechSynthesis && 'SpeechSynthesisUtterance' in window) {
        try {
          const u = new SpeechSynthesisUtterance(String(text));
          const voices = window.speechSynthesis.getVoices();
          if (voices && voices.length) u.voice = voices.find(v => /id|en/i.test(v.lang)) || voices[0];
          unlock();
          window.speechSynthesis.speak(u);
        } catch (e) { beep({ freq: 720, time: 0.12 }); }
      } else beep({ freq: 720, time: 0.12 });
    }

    function toggle() {
      enabled = !enabled;
      if (!enabled && window.speechSynthesis) window.speechSynthesis.cancel();
      return enabled;
    }

    return { ensure, unlock, beep, chime, doorSwoosh, announce, toggle, isEnabled: () => enabled, setTts: v => { tts = !!v; } };
  })();

  /* -------------------------
     Logging / UI helpers (must be defined early)
  ------------------------- */
  function appendLogUI(msg) {
    const container = DOM.passengerLog;
    if (!container) {
      console.log(msg);
      return;
    }
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
      node.textContent = `[${(new Date()).toLocaleTimeString()}] ${msg}`;
    }
    container.prepend(node);
    while (container.children.length > 400) container.removeChild(container.lastChild);

    // accessibility live
    if (DOM.liveStatus) {
      DOM.liveStatus.textContent = msg;
    }
    // also console.debug
    console.debug('[LiftSim]', msg);
  }

  /* -------------------------
     Elevator Model
  ------------------------- */
  const EState = {
    IDLE: 'IDLE',
    MOVING: 'MOVING',
    ARRIVED: 'ARRIVED',
    DOOR_OPEN: 'DOOR_OPEN',
    DOOR_CLOSED: 'DOOR_CLOSED',
    EMERGENCY: 'EMERGENCY'
  };

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
      this.autoCloseMs = CFG.doorAutoCloseMs || 3500;
      this.arrivalTs = 0;

      // auto boarding/exiting flags per door open cycle
      this._autoBoardHandled = false;
      this._autoExitHandled = false;
    }

    floorToMeters(f) { return clamp(Math.floor(f), 0, this.floors - 1) * this.floorHeight; }
    metersToFloor(m) { return Math.round(m / this.floorHeight); }

    // Request a floor from inside (passenger)
    requestFloor(f) {
      const ff = clamp(Math.floor(f), 0, this.floors - 1);
      if (this.targetFloor === null && this.queue.length === 0) {
        this.targetFloor = ff;
      } else if (!this.queue.includes(ff) && this.targetFloor !== ff) {
        this.queue.push(ff);
      }
      dispatch('lift:call', { floor: ff, who: 'Passenger' });
    }

    // External request simply enqueues; keep away duplicates in world.requestExternalCall
    requestExternal(f, who = 'NPC') {
      const ff = clamp(Math.floor(f), 0, this.floors - 1);
      if (this.targetFloor === null && this.queue.length === 0) {
        this.targetFloor = ff;
      } else if (!this.queue.includes(ff) && this.targetFloor !== ff) {
        this.queue.push(ff);
      }
      dispatch('lift:call', { floor: ff, who });
    }

    openDoors() {
      if (this.components.door < 5) return false;
      this.doorsOpen = true;
      this.state = EState.DOOR_OPEN;
      this.arrivalTs = nowMs();
      this._autoBoardHandled = false;
      this._autoExitHandled = false;
      AudioEngine.doorSwoosh(true);
      dispatch('lift:door', { state: 'open' });
      return true;
    }

    closeDoors() {
      if (this.playerInside && this.loadKg > this.overloadLimitKg) return false;
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

    popNextTarget() {
      if (this.targetFloor !== null) return;
      if (this.queue.length === 0) return;
      // choose nearest
      const cur = this.metersToFloor(this.position);
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < this.queue.length; i++) {
        const d = Math.abs(this.queue[i] - cur);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      this.targetFloor = this.queue.splice(bestIdx, 1)[0];
    }

    step(dt) {
      // doors progression
      const ds = (1 / this.doorSpeed) * (0.5 + (this.components.door / 100) * 0.8);
      if (this.doorsOpen) this.doorProgress = clamp(this.doorProgress + ds * dt, 0, 1);
      else this.doorProgress = clamp(this.doorProgress - ds * dt, 0, 1);

      // reset auto flags when doors fully closed
      if (!this.doorsOpen && this.doorProgress <= 0.02) {
        this._autoBoardHandled = false;
        this._autoExitHandled = false;
      }

      if (this.state === EState.EMERGENCY) return;

      // while doors open: do not move
      if (this.doorsOpen && this.doorProgress > 0.05) {
        this.velocity = 0; this.acceleration = 0; this.state = EState.DOOR_OPEN;
        // auto-close if no one inside and timed out
        if (!this.playerInside && nowMs() - this.arrivalTs > this.autoCloseMs) this.closeDoors();
        return;
      }

      // decide next target if none
      if (this.targetFloor === null && this.queue.length) this.popNextTarget();
      if (this.targetFloor === null) {
        // idle damping
        this.acceleration = -this.velocity * 1.8;
        this.velocity += this.acceleration * dt;
        this.position += this.velocity * dt;
        if (Math.abs(this.velocity) < 0.01) { this.velocity = 0; this.acceleration = 0; this.state = EState.IDLE; }
        return;
      }

      // Move toward target
      const targetPos = this.floorToMeters(this.targetFloor);
      const dist = targetPos - this.position;
      const dir = Math.sign(dist || 1);
      const absDist = Math.abs(dist);

      // braking distance
      const brakingDist = (this.velocity * this.velocity) / (2 * CFG.physics.brakeLimit + 1e-6);

      if (absDist <= brakingDist + 0.03) {
        this.acceleration = -CFG.physics.brakeLimit * Math.sign(this.velocity || dir);
      } else {
        const desired = CFG.maxSpeedMps * dir;
        const err = desired - this.velocity;
        this.acceleration = clamp(err * 1.8, -CFG.physics.brakeLimit, CFG.physics.accelLimit);
      }

      // integrate
      this.velocity += this.acceleration * dt;
      this.velocity = clamp(this.velocity, -CFG.maxSpeedMps, CFG.maxSpeedMps);
      this.position += this.velocity * dt;
      this.state = EState.MOVING;

      // arrival detection
      if (absDist < 0.03 && Math.abs(this.velocity) < 0.06) {
        // snap
        this.position = targetPos;
        this.velocity = 0; this.acceleration = 0;
        this.arrivalFloor = this.targetFloor;
        this.targetFloor = null;
        this.state = EState.ARRIVED;
        // open doors
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
        _autoBoardHandled: this._autoBoardHandled, _autoExitHandled: this._autoExitHandled
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
      e._autoBoardHandled = !!obj._autoBoardHandled;
      e._autoExitHandled = !!obj._autoExitHandled;
      return e;
    }
  }

  /* -------------------------
     World: calls, NPCs, scheduling
     Calls structure: { id, floor, dir, who, ts, status: 'pending'|'assigned'|'serving'|'served' }
  ------------------------- */
  class World {
    constructor() {
      this.elev = new Elevator(CFG.floors, CFG.initialFloor);
      this.playerFloor = CFG.initialFloor; // where the passenger currently is (outside) or last exited floor
      this.playerRequestedFloor = null;    // numeric floor passenger requests when inside
      this.calls = [];                     // queued external calls
      this.npcs = [];
      this.scheduled = [];
      this.logs = [];
      this.eventWindow = { start: nowMs(), count: 0, cap: 6 };
      this.lastPlayerCall = { floor: null, dir: null, ts: 0 }; // debounce for player
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

    // external call entrypoint — prevents duplicates & debounces player
    playerCall(floor, dir = 'up') {
      const now = nowMs();
      // debounce same call by player for 1.8s
      if (this.lastPlayerCall.floor === floor && this.lastPlayerCall.dir === dir && now - (this.lastPlayerCall.ts || 0) < 1800) {
        this.log('Panggilan diabaikan (terlalu cepat).');
        return false;
      }
      this.lastPlayerCall = { floor, dir, ts: now };

      // if a similar call already exists (any who) -> don't create duplicate
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

    // internal usage for NPCs or world
    requestExternalCall(floor, dir = 'up', who = 'NPC') {
      const now = nowMs();
      // avoid duplicates for same who+floor+dir with pending/assigned
      if (this.calls.some(c => c.floor === floor && c.dir === dir && (c.status === 'pending' || c.status === 'assigned') && c.who === who)) {
        return;
      }
      const id = `call-${Math.floor(now)}-${Math.round(Math.random() * 9999)}`;
      const call = { id, floor, dir, who, ts: now, status: 'pending' };
      this.calls.push(call);
      this.log(`${who} called ${dir} at floor ${floor}`);
      dispatch('lift:call', { floor, dir, who });
    }

    // assign nearest pending call to elevator (mark as 'assigned')
    assignCalls() {
      // already moving to target; don't assign if elev already has target
      if (this.elev.targetFloor !== null) return;
      // find nearest pending call
      const pending = this.calls.filter(c => c.status === 'pending');
      if (!pending.length) return;
      const cur = this.elev.metersToFloor(this.elev.position);
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < pending.length; i++) {
        const d = Math.abs(pending[i].floor - cur);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      const chosen = pending[bestIdx];
      // mark as assigned in calls array
      const idxAll = this.calls.findIndex(c => c.id === chosen.id);
      if (idxAll >= 0) {
        this.calls[idxAll].status = 'assigned';
        this.calls[idxAll].assignedTs = nowMs();
      }
      // hand to elevator
      this.elev.requestExternal(chosen.floor, chosen.who);
      this.log(`Lift ditugaskan ke panggilan di lantai ${chosen.floor} (oleh ${chosen.who})`);
    }

    // cleanup served calls when elevator opens at floor
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
      // only operate when doors are essentially open
      if (!(e.doorsOpen && e.doorProgress > 0.98)) return;
      if (nowMs() - e.lastDoorActionMs < e.doorCooldownMs) return;

      const liftFloor = e.metersToFloor(e.position);

      // if there was a pending/assigned call at this floor, mark as served
      // and prevent re-handling reentrancy
      if (!e._autoBoardHandled) {
        this.markCallServedAtFloor(liftFloor);
      }

      // AUTO-BOARD (when player outside and lift opened at player's floor)
      if (!e.playerInside && liftFloor === this.playerFloor && !e._autoBoardHandled) {
        e._autoBoardHandled = true;
        // slight delay to feel natural
        setTimeout(() => {
          if (e.doorsOpen && e.doorProgress > 0.98 && !e.playerInside && liftFloor === this.playerFloor) {
            const ok = e.enterPlayer(CFG.passengerWeightKg);
            if (ok) {
              this.log(`Anda masuk ke lift di lantai ${liftFloor}`);
              dispatch('lift:boarded', { floor: liftFloor });
              AudioEngine.announce('Anda masuk ke lift');
              // when boarded, make the keypad visible and wait for user's destination selection
              // (we keep world.playerRequestedFloor separate; user must choose)
            } else {
              this.log('Gagal masuk (terblokir oleh kondisi).');
              // allow re-attempt on next open
              e._autoBoardHandled = false;
            }
          } else {
            e._autoBoardHandled = false;
          }
        }, CFG.autoBoardDelayMs);
      }

      // AUTO-EXIT (if player inside and elevator arrived at player's requested floor)
      if (e.playerInside && this.playerRequestedFloor !== null && e.arrivalFloor === this.playerRequestedFloor && !e._autoExitHandled) {
        e._autoExitHandled = true;
        setTimeout(() => {
          if (e.doorsOpen && e.doorProgress > 0.98 && e.playerInside && e.arrivalFloor === this.playerRequestedFloor) {
            const ok = e.exitPlayer(CFG.passengerWeightKg);
            if (ok) {
              this.playerFloor = e.arrivalFloor;
              this.log(`Anda keluar di lantai ${e.arrivalFloor}`);
              dispatch('lift:exited', { floor: e.arrivalFloor });
              AudioEngine.announce(`Anda tiba di lantai ${e.arrivalFloor}`);
              // clear requested destination on exit
              this.playerRequestedFloor = null;
            } else {
              this.log('Gagal keluar (terblokir).');
              e._autoExitHandled = false;
            }
          } else {
            e._autoExitHandled = false;
          }
        }, CFG.autoExitDelayMs);
      }

      // NPC sparse boarding/exiting (lower probability)
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

    // simple event handler
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
      } catch (e) {
        console.warn('deserialize fail', e);
      }
      return w;
    }
  }

  /* -------------------------
     Canvas Renderer
  ------------------------- */
  class Renderer {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.world = world;
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
      const ctx = this.ctx;
      const W = this.canvas.width / this.dpr;
      const H = this.canvas.height / this.dpr;
      ctx.clearRect(0, 0, W, H);

      const pad = 12;
      const shaftW = Math.min(340, W * 0.30);
      const shaftX = pad, shaftY = pad, shaftH = H - pad * 2;

      // shaft background
      ctx.fillStyle = '#071426';
      ctx.fillRect(shaftX, shaftY, shaftW, shaftH);

      const fc = this.world.elev.floors;
      const floorH = Math.max(28, Math.floor((shaftH - 8) / fc));
      const totalH = floorH * fc;
      const top = shaftY + (shaftH - totalH);

      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.font = '11px ui-monospace, monospace';
      for (let i = 0; i < fc; i++) {
        const y = top + i * floorH;
        ctx.beginPath();
        ctx.moveTo(shaftX, y);
        ctx.lineTo(shaftX + shaftW, y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillText(`${fc - 1 - i}`, shaftX + shaftW + 8, y + 12);
      }

      const carW = Math.min(170, shaftW * 0.58);
      const carH = floorH - 6;
      const carX = shaftX + (shaftW - carW) / 2;
      const posRatio = this.world.elev.position / Math.max(1, this.world.elev.floorToMeters(this.world.elev.floors - 1));
      const carY = top + (fc - 1) * floorH - posRatio * ((fc - 1) * floorH) - carH / 2;

      // cables
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(carX + 6, carY);
      ctx.lineTo(carX + 6, top - 8);
      ctx.moveTo(carX + carW - 6, carY);
      ctx.lineTo(carX + carW - 6, top - 8);
      ctx.stroke();

      // car body
      ctx.fillStyle = '#0f3a4a';
      ctx.fillRect(carX, carY, carW, carH);
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(carX + 6, carY + 6, carW - 12, carH - 12);

      // doors
      const doorProg = this.world.elev.doorProgress;
      const panelW = carW / 2;
      const leftX = carX + (1 - doorProg) * (panelW * 0.9);
      const rightX = carX + carW - panelW - (1 - doorProg) * (panelW * 0.9);
      ctx.fillStyle = '#021b25';
      ctx.fillRect(leftX, carY, panelW, carH);
      ctx.fillRect(rightX, carY, panelW, carH);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.strokeRect(carX, carY, carW, carH);

      // HUD
      ctx.fillStyle = 'rgba(0,0,0,0.36)';
      ctx.fillRect(shaftX + 12, 10, 300, 64);
      ctx.fillStyle = '#cfeffb';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(`Pos: ${this.world.elev.position.toFixed(2)} m`, shaftX + 24, 30);
      ctx.fillText(`Vel: ${this.world.elev.velocity.toFixed(2)} m/s`, shaftX + 24, 52);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(`Target: ${this.world.elev.targetFloor === null ? '-' : this.world.elev.targetFloor}`, shaftX + 200, 30);
      ctx.fillText(`Load: ${Math.round(this.world.elev.loadKg)} kg`, shaftX + 200, 52);
    }
  }

  /* -------------------------
     UI: external panel (single-floor up/down) & internal keypad
     - external shows only for outside passenger, and reflects call state
  ------------------------- */
  let lastRenderedSnapshot = null;

  function renderExternalPanel(world) {
    const panel = DOM.externalCallPanel;
    if (!panel) return;
    const f = world.playerFloor;

    // snapshot: floor + whether passenger has current pending/assigned call + elevator target + doors/open
    const hasPending = world.calls.some(c => c.floor === f && c.who === 'Passenger' && (c.status === 'pending' || c.status === 'assigned'));
    const elevTarget = world.elev.targetFloor;
    const snapshot = `${f}|pending:${hasPending}|target:${elevTarget}|doors:${world.elev.doorsOpen}|playerInside:${world.elev.playerInside}`;
    if (snapshot === lastRenderedSnapshot) return;
    lastRenderedSnapshot = snapshot;

    panel.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'external-row single';

    const label = document.createElement('div');
    label.className = 'external-floor-label';
    label.textContent = `Lantai ${f}`;
    row.appendChild(label);

    const group = document.createElement('div');
    group.className = 'external-group single';

    // Up button
    const up = document.createElement('button');
    up.className = 'call-up single';
    up.type = 'button';
    up.setAttribute('aria-label', `Panggil naik di lantai ${f}`);
    up.textContent = '▲';

    // Down button
    const down = document.createElement('button');
    down.className = 'call-down single';
    down.type = 'button';
    down.setAttribute('aria-label', `Panggil turun di lantai ${f}`);
    down.textContent = '▼';

    // If passenger already inside, don't show external buttons (UI layer manages but guard)
    if (world.elev.playerInside) {
      up.disabled = true; down.disabled = true;
      up.title = 'Anda berada di dalam lift';
      down.title = 'Anda berada di dalam lift';
    } else {
      // disable up if top floor
      if (f >= CFG.floors - 1) up.disabled = true;
      // disable down if bottom
      if (f <= 0) down.disabled = true;
      // if there's already a pending/assigned passenger call for this floor: disable and show status
      if (hasPending) {
        up.disabled = true; down.disabled = true;
        const badge = document.createElement('div');
        badge.className = 'external-badge';
        // check if elevator has been assigned and is heading here
        const assigned = world.calls.some(c => c.floor === f && c.who === 'Passenger' && c.status === 'assigned');
        if (assigned) badge.textContent = 'Panggilan: ditugaskan';
        else badge.textContent = 'Panggilan: menunggu';
        row.appendChild(badge);
      } else {
        // wire click handlers (with UI protection)
        up.addEventListener('click', (ev) => {
          if (up.disabled) return;
          up.disabled = true;
          setTimeout(() => { up.disabled = false; }, 900);
          AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
          const ok = world.playerCall(f, 'up');
          if (!ok) appendLogUI('Panggilan tidak dibuat (duplicate/debounce).');
        });
        down.addEventListener('click', (ev) => {
          if (down.disabled) return;
          down.disabled = true;
          setTimeout(() => { down.disabled = false; }, 900);
          AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
          const ok = world.playerCall(f, 'down');
          if (!ok) appendLogUI('Panggilan tidak dibuat (duplicate/debounce).');
        });
      }
    }

    group.appendChild(up);
    group.appendChild(down);
    row.appendChild(group);
    panel.appendChild(row);
  }

  function buildInternalKeypad(world) {
    const container = DOM.floorPanel;
    if (!container) return;
    container.innerHTML = '';
    const tpl = DOM.tplFloorButton;
    for (let f = CFG.floors - 1; f >= 0; f--) {
      let btn;
      if (tpl && tpl.content && tpl.content.firstElementChild) {
        btn = tpl.content.firstElementChild.cloneNode(true);
      } else {
        btn = document.createElement('button');
        btn.className = 'floor-btn';
        btn.type = 'button';
        btn.innerHTML = `<span class="floor-num">${f}</span>`;
      }
      btn.dataset.floor = f;
      const span = btn.querySelector('.floor-num');
      if (span) span.textContent = f;

      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        // prevent internal double-press
        if (btn.classList.contains('floor-selected')) {
          appendLogUI(`Lantai ${f} sudah dipilih.`);
          return;
        }
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep({ freq: 880, time: 0.06 });
        if (!world.elev.playerInside) {
          appendLogUI('Keypad hanya aktif saat berada di dalam kabin.');
          return;
        }
        world.elev.requestFloor(f);
        // mark as selected visually
        btn.classList.add('floor-selected');
        btn.setAttribute('aria-pressed', 'true');
        // record player's requested floor so auto-exit can act
        world.playerRequestedFloor = f;
        appendLogUI(`Meminta lantai ${f}`);
      });

      container.appendChild(btn);
    }
    // initial visibility
    container.style.display = world.elev.playerInside ? 'grid' : 'none';
  }

  function clearSelectedKeypadButton(floor) {
    const btn = DOM.floorPanel.querySelector(`.floor-btn[data-floor="${floor}"]`);
    if (btn) {
      btn.classList.remove('floor-selected');
      btn.setAttribute('aria-pressed', 'false');
    }
  }

  /* -------------------------
     Panels visibility update: hide external when inside; hide cabin controls when outside
  ------------------------- */
  function updatePanelsVisibility(world) {
    const inside = world.elev.playerInside;
    // external panel visible only when outside
    if (DOM.externalCallPanel) DOM.externalCallPanel.style.display = !inside ? '' : 'none';
    // internal keypad visible only when inside
    if (DOM.floorPanel) DOM.floorPanel.style.display = inside ? 'grid' : 'none';
    // cabin controls (open/close/alarm) available only inside
    if (DOM.cabinControls) DOM.cabinControls.style.display = inside ? '' : 'none';
    // enable/disable physical door/alarm buttons
    if (DOM.btnDoorOpen) DOM.btnDoorOpen.disabled = !inside;
    if (DOM.btnDoorClose) DOM.btnDoorClose.disabled = !inside;
    if (DOM.btnAlarm) DOM.btnAlarm.disabled = !inside;
    // display small text
    if (DOM.displaySmall) {
      const liftF = world.elev.metersToFloor(world.elev.position);
      const youState = inside ? `Anda: di dalam (asal ${world.playerFloor})` : `Anda: ${world.playerFloor} (di luar)`;
      DOM.displaySmall.textContent = `Lift: ${liftF} — ${youState}`;
    }
  }

  /* -------------------------
     Wiring controls (door/open/close/alarm/audio toggle)
  ------------------------- */
  function wireControls(world) {
    // door open
    if (DOM.btnDoorOpen) {
      DOM.btnDoorOpen.addEventListener('click', () => {
        if (DOM.btnDoorOpen.disabled) return;
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
        const ok = world.elev.openDoors();
        appendLogUI(ok ? 'Pintu dibuka.' : 'Gagal membuka pintu.');
        if (ok) AudioEngine.announce('Pintu terbuka');
      });
    }
    // door close
    if (DOM.btnDoorClose) {
      DOM.btnDoorClose.addEventListener('click', () => {
        if (DOM.btnDoorClose.disabled) return;
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
        const ok = world.elev.closeDoors();
        appendLogUI(ok ? 'Pintu ditutup.' : 'Penutupan pintu tertahan.');
        if (ok) AudioEngine.announce('Pintu tertutup');
      });
    }
    // alarm
    if (DOM.btnAlarm) {
      DOM.btnAlarm.addEventListener('click', () => {
        if (DOM.btnAlarm.disabled) return;
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep({ freq: 240, time: 0.28, vol: 0.28 });
        appendLogUI('Alarm ditekan — bantuan diberitahu (simulasi).');
        dispatch('lift:alarm', { who: 'Passenger' });
        // schedule simulated tech check
        world.scheduled.push({ ts: nowMs() + secToMs(8), type: 'auto_repair', payload: { comp: 'control' } });
      });
    }

    // modal close guard
    if (DOM.modalClose) DOM.modalClose.addEventListener('click', () => { if (DOM.modal) DOM.modal.setAttribute('aria-hidden', 'true'); });

    // audio toggle button (if present)
    if (DOM.audioToggle) {
      DOM.audioToggle.addEventListener('click', () => {
        const on = AudioEngine.toggle();
        DOM.audioToggle.textContent = on ? '🔊' : '🔇';
        appendLogUI(on ? 'Suara aktif' : 'Suara dimatikan');
      });
    }

    // keyboard shortcuts: m = mute, o = open, c = close
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'm') {
        const on = AudioEngine.toggle();
        if (DOM.audioToggle) DOM.audioToggle.textContent = on ? '🔊' : '🔇';
        appendLogUI(on ? 'Suara aktif' : 'Suara dimatikan');
      } else if (e.key.toLowerCase() === 'o') {
        DOM.btnDoorOpen?.click();
      } else if (e.key.toLowerCase() === 'c') {
        DOM.btnDoorClose?.click();
      }
    });

    // event listeners to keep UI sync
    window.addEventListener('lift:arrived', (e) => {
      if (e?.detail) appendLogUI(`Lift tiba di lantai ${e.detail.floor}`);
    });
    window.addEventListener('lift:door', (e) => {
      if (e?.detail?.state) appendLogUI(`Door ${e.detail.state}`);
    });
    window.addEventListener('lift:call', (e) => {
      if (e?.detail) appendLogUI(`Call: ${e.detail.floor} by ${e.detail.who || 'unknown'}`);
    });
    window.addEventListener('lift:boarded', (e) => {
      appendLogUI('Anda berada di dalam lift.');
      // reveal internal keypad
      buildInternalKeypad(world);
      updatePanelsVisibility(world);
    });
    window.addEventListener('lift:exited', (e) => {
      appendLogUI('Anda berada di luar lift.');
      // clear selected keypad buttons visually
      if (typeof e?.detail?.floor === 'number') clearSelectedKeypadButton(e.detail.floor);
      buildInternalKeypad(world);
      updatePanelsVisibility(world);
    });
  }

  /* -------------------------
     Persistence
  ------------------------- */
  const PERSIST_KEY = CFG.persistenceKey || 'only-lift-world-v1';
  function saveNow(world) {
    try {
      saveJSON(PERSIST_KEY, { ts: nowMs(), world: world.serialize() });
    } catch (e) {
      console.warn('saveNow failed', e);
    }
  }
  function tryLoad() {
    try {
      return loadJSON(PERSIST_KEY);
    } catch (e) {
      return null;
    }
  }

  /* -------------------------
     Bootstrap
  ------------------------- */
  let world;
  const saved = tryLoad();
  if (saved && saved.world) {
    try {
      world = World.deserialize(saved.world);
      // fast-forward simulation up to 10 minutes to keep plausible
      const delta = Math.floor((nowMs() - (saved.ts || nowMs())) / 1000);
      const ff = Math.min(delta, 60 * 10);
      if (ff > 2) {
        let ran = 0;
        const stepSec = 5;
        while (ran < ff) {
          world.step(Math.min(stepSec, ff - ran));
          ran += stepSec;
        }
        world.log(`Fast-forwarded ${Math.round(ff)}s since last session`);
      }
    } catch (e) {
      console.warn('Failed to deserialize saved world; creating new one.', e);
      world = new World();
      world.log('World initialized (fresh).');
    }
  } else {
    world = new World();
    world.log('World initialized (fresh).');
  }

  // attach renderer
  const renderer = new Renderer(DOM.canvas, world);

  // initial UI build
  buildInternalKeypad(world);
  renderExternalPanel(world);
  updatePanelsVisibility(world);
  wireControls(world);

  // listeners: keep external panel reacting to call assignments and elevator events
  window.addEventListener('lift:arrived', () => {
    renderExternalPanel(world);
    // if elevator arrived and doors open at some floor where player had requested inside, clear selected btn
    const f = world.elev.arrivalFloor;
    if (typeof f === 'number') {
      // mark served calls
      world.markCallServedAtFloor(f);
      // clear selected keypad button if that was the destination
      if (world.playerRequestedFloor === f) clearSelectedKeypadButton(f);
    }
  });
  window.addEventListener('lift:call', () => {
    renderExternalPanel(world);
  });

  /* -------------------------
     Simulation loop (fixed-step)
  ------------------------- */
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

    // renderer draw
    renderer.draw();

    // UI sync
    if (DOM.displayFloor) DOM.displayFloor.textContent = String(world.elev.metersToFloor(world.elev.position));
    if (DOM.displayState) DOM.displayState.textContent = world.elev.state;
    if (DOM.readoutLoad) DOM.readoutLoad.textContent = `${Math.round(world.elev.loadKg)} kg`;
    if (DOM.readoutSpeed) DOM.readoutSpeed.textContent = `${world.elev.velocity.toFixed(2)} m/s`;
    if (DOM.readoutDoor) DOM.readoutDoor.textContent = world.elev.doorsOpen ? 'Terbuka' : 'Tertutup';

    // re-render panels intelligently
    renderExternalPanel(world);
    updatePanelsVisibility(world);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t) => { lastRAF = t; requestAnimationFrame(frame); });

  // periodic save
  setInterval(() => saveNow(world), 8000);

  // unlock audio gracefully on first user gesture
  const unlockOnce = () => { AudioEngine.ensure(); AudioEngine.unlock(); window.removeEventListener('click', unlockOnce); };
  window.addEventListener('click', unlockOnce, { once: true });

  // expose debug API and small helpers
  window.LiftSim = {
    world,
    cfg: CFG,
    audio: AudioEngine,
    saveNow: () => { saveNow(world); appendLogUI('World saved'); },
    reset: (preserveFloor = true) => {
      const f = preserveFloor ? world.playerFloor : CFG.initialFloor;
      localStorage.removeItem(PERSIST_KEY);
      world = new World();
      world.playerFloor = f;
      buildInternalKeypad(world);
      renderExternalPanel(world);
      updatePanelsVisibility(world);
      appendLogUI('World reset');
      return world;
    }
  };

  appendLogUI('Simulator siap — ketika Anda di luar tampil ▲/▼. Panggil lift, ia akan auto-board/exit. Tekan "m" untuk mute/unmute.');
  console.info('LiftSim initialized', { cfg: CFG });

  return { world, cfg: CFG, audio: AudioEngine };
})(); // end LiftSim

export default LiftSim;
