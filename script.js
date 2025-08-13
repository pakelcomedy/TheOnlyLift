// script.js
// The Only Lift — passenger-first, fixed auto-enter/auto-exit logic.
// Replace your existing script.js with this file (module).

const LiftSim = (function(){
  'use strict';

  /* ---------- Utilities ---------- */
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const nowMs = () => Date.now();
  const rand = (a,b) => a + Math.random()*(b-a);
  const secToMs = s => s*1000;
  const saveJSON = (k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} };
  const loadJSON = (k)=>{ try{ const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; }catch(e){ return null; } };

  /* ---------- Config & DOM ---------- */
  const ROOT = document.getElementById('app') || document.body;
  const CFG = {
    floors: parseInt(ROOT.dataset.floors || 18, 10),
    initialFloor: parseInt(ROOT.dataset.initialFloor || 0, 10),
    floorHeightMeters: parseFloat(ROOT.dataset.floorHeightMeters || 3.0),
    maxSpeed: parseFloat(ROOT.dataset.maxSpeedMps || 2.2),
    accel: 1.0,
    brake: 1.6,
    playerWeightKg: parseFloat(ROOT.dataset.passengerWeightKg || 75),
    doorActionCooldownMs: parseInt(ROOT.dataset.doorActionCooldownMs || 1200,10),
    persistenceKey: (ROOT.dataset.persistenceKey || 'only-lift-v3'),
    npcCount: Math.max(0, Math.round((parseInt(ROOT.dataset.floors||18,10) * 0.02))),
    randomEventRatePerSec: 0.00045,
    eventCapPerMinute: 4,
    autoBoardDelayMs: 200,
    autoExitDelayMs: 200
  };

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
    modal: document.getElementById('modal'),
    modalMessage: document.getElementById('modalMessage'),
    modalClose: document.getElementById('modalClose')
  };

  /* ---------- Audio ---------- */
  const AudioEngine = (function(){
    let ctx=null, master=null, enabled=true, tts=true;
    function ensure(){ if(ctx) return ctx; try{ ctx = new (window.AudioContext||window.webkitAudioContext)(); master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);}catch(e){ctx=null;} return ctx; }
    function unlock(){ const c = ensure(); if(!c) return; if(c.state==='suspended' && c.resume) c.resume().catch(()=>{}); }
    function beep({freq=880,time=0.06,vol=0.16,type='sine'}={}){ const c=ensure(); if(!c||!enabled) return; try{ const o=c.createOscillator(), g=c.createGain(); o.type=type; o.frequency.value=freq; g.gain.value=0; o.connect(g); g.connect(master); const t0=c.currentTime; g.gain.linearRampToValueAtTime(vol,t0+0.006); o.start(t0); g.gain.exponentialRampToValueAtTime(0.0001,t0+time); setTimeout(()=>{ try{ o.stop(); o.disconnect(); g.disconnect(); }catch(e){} }, (time+0.05)*1000);}catch(e){} }
    function chime(){ const c=ensure(); if(!c||!enabled) return; try{ const t=c.currentTime; const o1=c.createOscillator(), g1=c.createGain(); o1.type='sine'; o1.frequency.value=880; o1.connect(g1); g1.connect(master); g1.gain.setValueAtTime(0.0001,t); g1.gain.linearRampToValueAtTime(0.18,t+0.01); g1.gain.exponentialRampToValueAtTime(0.0001,t+0.28); o1.start(t); o1.stop(t+0.28); const o2=c.createOscillator(), g2=c.createGain(); o2.type='sine'; o2.frequency.value=660; o2.connect(g2); g2.connect(master); g2.gain.setValueAtTime(0.0001,t+0.18); g2.gain.linearRampToValueAtTime(0.15,t+0.20); g2.gain.exponentialRampToValueAtTime(0.0001,t+0.44); o2.start(t+0.18); o2.stop(t+0.44); }catch(e){} }
    function doorSwoosh(open=true){ const c=ensure(); if(!c||!enabled) return; try{ const t=c.currentTime; const o=c.createOscillator(), f=c.createBiquadFilter(), g=c.createGain(); o.type='sawtooth'; o.frequency.value=240; f.type='lowpass'; f.frequency.value=open?1600:1200; o.connect(f); f.connect(g); g.connect(master); g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(open?0.18:0.12,t+0.02); g.gain.exponentialRampToValueAtTime(0.0001,t+(open?0.42:0.28)); o.start(t); setTimeout(()=>{ try{ o.stop(); }catch(e){} },600); }catch(e){} }
    function announce(text){ if(!enabled) return; if(tts && window.speechSynthesis && 'SpeechSynthesisUtterance' in window){ try{ const u = new SpeechSynthesisUtterance(text); const voices = window.speechSynthesis.getVoices(); if(voices && voices.length) u.voice = voices.find(v=>/id|en/i.test(v.lang)) || voices[0]; unlock(); window.speechSynthesis.speak(u);}catch(e){ beep({freq:720,time:0.12}); } } else beep({freq:720,time:0.12}); }
    function toggle(){ enabled = !enabled; if(!enabled && window.speechSynthesis) window.speechSynthesis.cancel(); return enabled; }
    return { ensure, unlock, beep, chime, doorSwoosh, announce, toggle, isEnabled: ()=>enabled, setTts: v=>{ tts = !!v } };
  })();

  /* ---------- Elevator model ---------- */
  const State = { IDLE:'IDLE', MOVING:'MOVING', ARRIVED:'ARRIVED', DOOR:'DOOR', EMERGENCY:'EMERGENCY' };

  class Elevator {
    constructor(floors, initialFloor) {
      this.floors = floors;
      this.floorHeight = CFG.floorHeightMeters;
      this.position = this.floorToMeters(initialFloor);
      this.velocity = 0;
      this.acceleration = 0;
      this.targetFloor = null;
      this.queue = [];
      this.state = State.IDLE;
      this.doorsOpen = false;
      this.doorProgress = 0;
      this.doorSpeed = 0.9;
      this.loadKg = 0;
      this.playerInside = false;
      this.lastDoorActionMs = 0;
      this.doorCooldownMs = CFG.doorActionCooldownMs;
      this.overloadLimitKg = 1800;
      this.arrivalFloor = null;
      this.components = {door:100, motor:100};
      this.autoCloseMs = 3500;
      this.arrivalTs = 0;

      // NEW: helper flag to avoid duplicate auto board/exit on same open cycle
      this._autoBoardHandled = false;
    }
    floorToMeters(f){ return clamp(f,0,this.floors-1) * this.floorHeight; }
    metersToFloor(m){ return Math.round(m / this.floorHeight); }
    requestFloor(f){ f = clamp(Math.floor(f),0,this.floors-1); if(this.targetFloor===null && this.queue.length===0) this.targetFloor = f; else if(!this.queue.includes(f) && this.targetFloor!==f) this.queue.push(f); window.dispatchEvent(new CustomEvent('lift:call',{detail:{floor:f,who:'Passenger'}})); }
    requestExternal(f,who='NPC'){ f = clamp(Math.floor(f),0,this.floors-1); if(this.targetFloor===null && this.queue.length===0) this.targetFloor = f; else if(!this.queue.includes(f) && this.targetFloor!==f) this.queue.push(f); window.dispatchEvent(new CustomEvent('lift:call',{detail:{floor:f,who}})); }
    openDoors(){ if(this.components.door < 5) return false; this.doorsOpen = true; this.state = State.DOOR; this.arrivalTs = nowMs(); this._autoBoardHandled = false; AudioEngine.doorSwoosh(true); window.dispatchEvent(new CustomEvent('lift:door',{detail:{state:'open'}})); return true; }
    closeDoors(){ if(this.playerInside && this.loadKg > this.overloadLimitKg) return false; this.doorsOpen = false; this.state = State.IDLE; AudioEngine.doorSwoosh(false); // reset handler only when fully closed (handled below in step)
      window.dispatchEvent(new CustomEvent('lift:door',{detail:{state:'closed'}})); return true; }
    enterPlayer(weight){ if(!this.doorsOpen || this.doorProgress < 0.9) return false; if(this.playerInside) return false; if(nowMs() - this.lastDoorActionMs < this.doorCooldownMs) return false; if(this.loadKg + weight > this.overloadLimitKg) return false; this.loadKg += weight; this.playerInside = true; this.lastDoorActionMs = nowMs(); return true; }
    exitPlayer(weight){ if(!this.doorsOpen || this.doorProgress < 0.9) return false; if(!this.playerInside) return false; if(nowMs() - this.lastDoorActionMs < this.doorCooldownMs) return false; this.loadKg = Math.max(0, this.loadKg - weight); this.playerInside = false; this.lastDoorActionMs = nowMs(); return true; }
    popNextTarget(){ if(this.targetFloor!==null) return; if(this.queue.length===0) return; const cur = this.metersToFloor(this.position); let bestIdx=0,bestDist=Infinity; for(let i=0;i<this.queue.length;i++){ const d=Math.abs(this.queue[i]-cur); if(d<bestDist){bestDist=d;bestIdx=i;} } this.targetFloor = this.queue.splice(bestIdx,1)[0]; }
    step(dt){
      // doors progression
      const ds = (1/this.doorSpeed) * (0.5 + (this.components.door/100)*0.8);
      if (this.doorsOpen) this.doorProgress = clamp(this.doorProgress + ds*dt, 0, 1);
      else this.doorProgress = clamp(this.doorProgress - ds*dt, 0, 1);

      // reset auto flag when doors fully closed
      if (!this.doorsOpen && this.doorProgress <= 0.02) {
        this._autoBoardHandled = false;
      }

      if (this.state === State.EMERGENCY) return;

      if (this.doorsOpen && this.doorProgress > 0.05) {
        this.velocity = 0; this.acceleration = 0; this.state = State.DOOR;
        if (!this.playerInside && nowMs() - this.arrivalTs > this.autoCloseMs) this.closeDoors();
        return;
      }

      if (this.targetFloor === null && this.queue.length) this.popNextTarget();
      if (this.targetFloor === null) {
        // idle damping
        this.acceleration = -this.velocity * 1.8;
        this.velocity += this.acceleration * dt;
        this.position += this.velocity * dt;
        if (Math.abs(this.velocity) < 0.01) { this.velocity = 0; this.acceleration = 0; this.state = State.IDLE; }
        return;
      }

      // moving to target
      const targetPos = this.floorToMeters(this.targetFloor);
      const dist = targetPos - this.position;
      const dir = Math.sign(dist || 1);
      const absDist = Math.abs(dist);

      // braking distance
      const brakingDist = (this.velocity * this.velocity) / (2 * CFG.brake + 1e-6);

      if (absDist <= brakingDist + 0.03) {
        this.acceleration = -CFG.brake * Math.sign(this.velocity || dir);
      } else {
        const desired = CFG.maxSpeed * dir;
        const err = desired - this.velocity;
        this.acceleration = clamp(err * 1.8, -CFG.brake, CFG.accel);
      }

      // integrate
      this.velocity += this.acceleration * dt;
      this.velocity = clamp(this.velocity, -CFG.maxSpeed, CFG.maxSpeed);
      this.position += this.velocity * dt;
      this.state = State.MOVING;

      // arrival detection
      if (absDist < 0.03 && Math.abs(this.velocity) < 0.06) {
        // snap to floor
        this.position = targetPos;
        this.velocity = 0; this.acceleration = 0;
        this.arrivalFloor = this.targetFloor;
        this.targetFloor = null;
        this.state = State.ARRIVED;
        // open doors
        this.openDoors();
        // arrival audio & announcement
        AudioEngine.chime();
        AudioEngine.announce(`Lantai ${this.arrivalFloor}`);
        window.dispatchEvent(new CustomEvent('lift:arrived', { detail:{ floor: this.arrivalFloor } }));
      }
    }

    serialize(){ return { pos:this.position, vel:this.velocity, acc:this.acceleration, target:this.targetFloor, queue:this.queue.slice(), doorsOpen:this.doorsOpen, doorProg:this.doorProgress, loadKg:this.loadKg, playerInside:this.playerInside, components:this.components, state:this.state, arrivalFloor:this.arrivalFloor }; }
    static deserialize(o,floors,initial){ const e = new Elevator(floors, initial); if (!o) return e; e.position = o.pos ?? e.position; e.velocity = o.vel ?? 0; e.acceleration = o.acc ?? 0; e.targetFloor = o.target ?? null; e.queue = o.queue || []; e.doorsOpen = !!o.doorsOpen; e.doorProgress = o.doorProg ?? 0; e.loadKg = o.loadKg ?? 0; e.playerInside = !!o.playerInside; e.components = o.components || e.components; e.state = o.state || e.state; e.arrivalFloor = o.arrivalFloor ?? null; e._autoBoardHandled = !!o._autoBoardHandled; return e; }
  }

  /* ---------- World ---------- */
  class World {
    constructor(){ this.elev = new Elevator(CFG.floors, CFG.initialFloor); this.playerFloor = CFG.initialFloor; this.calls = []; this.npcs = []; this.scheduled = []; this.logs = []; this.eventWindow = { start: nowMs(), count:0, cap: CFG.eventCapPerMinute }; this.initNPCs(); }
    initNPCs(){ this.npcs = []; for (let i=0;i<CFG.npcCount;i++){ this.npcs.push({ id:`NPC-${i+1}`, nextActionMs: nowMs() + rand(20_000,90_000), busyUntil:0 }); } }
    log(msg){ const t = new Date(); const line = `[${t.toLocaleTimeString()}] ${msg}`; this.logs.unshift(line); if (this.logs.length > 400) this.logs.length = 400; appendLogUI(msg); }
    schedule(type, inSeconds, payload={}){ const ts = nowMs() + secToMs(inSeconds); this.scheduled.push({ ts, type, payload }); this.log(`Scheduled ${type} in ${Math.round(inSeconds)}s`); }
    processScheduled(){ const now = nowMs(); for (let i=this.scheduled.length-1;i>=0;i--) if (now >= this.scheduled[i].ts) { const ev = this.scheduled.splice(i,1)[0]; this.handleEvent(ev.type, ev.payload); } }
    handleEvent(type,payload){ if (type === 'door_jam') { this.log('Door jam occurred.'); this.elev.components.door = Math.max(0, this.elev.components.door - Math.round(rand(6,18))); if (Math.random() < 0.5) { this.elev.doorsOpen = true; this.elev.doorProgress = 1; this.elev.state = State.DOOR; this.elev.holdDoor = true; this.log('Door jammed open.'); } else { this.elev.doorsOpen = false; this.elev.doorProgress = 0; this.elev.holdDoor = true; this.log('Door jammed closed.'); } this.schedule('auto_repair', rand(12,40), { comp:'door' }); return; } if (type === 'auto_repair') { const comp = payload.comp; if (comp && this.elev.components[comp] !== undefined) { const amount = Math.round(rand(12,40)); this.elev.components[comp] = clamp(this.elev.components[comp] + amount, 0, 100); this.log(`Auto repair: ${comp} +${amount}%`); this.elev.holdDoor = false; } return; } }
    shouldTriggerEvent(ratePerSec, dt){ const now = nowMs(); if (now - this.eventWindow.start > 60_000) { this.eventWindow.start = now; this.eventWindow.count = 0; } if (this.eventWindow.count >= this.eventWindow.cap) return false; if (Math.random() < ratePerSec * dt) { this.eventWindow.count++; return true; } return false; }
    stepNPCs(dt){ const now = nowMs(); for (const npc of this.npcs) { if (now >= npc.nextActionMs && !npc.busyUntil) { if (Math.random() < 0.28) { const f = Math.floor(Math.random() * this.elev.floors); this.requestExternalCall(f, Math.random() < 0.5 ? 'up' : 'down', npc.id); npc.busyUntil = now + rand(20_000,80_000); npc.nextActionMs = now + rand(40_000,160_000); } else npc.nextActionMs = now + rand(25_000,120_000); } if (npc.busyUntil && now >= npc.busyUntil) npc.busyUntil = 0; } }
    stepBoarding(dt){
      const e = this.elev;
      if (!(e.doorsOpen && e.doorProgress > 0.9)) return;
      if (nowMs() - e.lastDoorActionMs < e.doorCooldownMs) return;

      const liftFloor = e.metersToFloor(e.position);

      // NEW: when doors are (almost) fully open and we haven't handled boarding/exit for this opening
      if (e.doorsOpen && e.doorProgress >= 0.98 && !e._autoBoardHandled) {
        // mark handled immediately to prevent races
        e._autoBoardHandled = true;

        // If player is outside at this floor -> auto-board
        if (!e.playerInside && liftFloor === this.playerFloor) {
          setTimeout(() => {
            // re-check conditions before acting
            if (e.doorsOpen && e.doorProgress >= 0.98 && !e.playerInside && liftFloor === this.playerFloor) {
              const ok = e.enterPlayer(CFG.playerWeightKg);
              if (ok) {
                this.log(`You boarded at floor ${liftFloor}`);
                // show cabin controls/keypad immediately
                updatePanelsVisibility();
                AudioEngine.announce('Anda masuk ke lift');
              } else {
                // if failed, allow a future attempt (clear flag after brief delay)
                e._autoBoardHandled = false;
              }
            } else {
              // if conditions not met, clear handled so future opens can try
              e._autoBoardHandled = false;
            }
          }, CFG.autoBoardDelayMs);
        }
        // If player is inside and this is arrival floor -> auto-exit
        else if (e.playerInside && e.arrivalFloor !== null && e.arrivalFloor === liftFloor) {
          setTimeout(() => {
            if (e.doorsOpen && e.doorProgress >= 0.98 && e.playerInside && e.arrivalFloor === liftFloor) {
              const ok = e.exitPlayer(CFG.playerWeightKg);
              if (ok) {
                this.playerFloor = liftFloor;
                this.log(`You exited at floor ${liftFloor}`);
                updatePanelsVisibility();
                AudioEngine.announce(`Anda tiba di lantai ${liftFloor}`);
              } else {
                e._autoBoardHandled = false;
              }
            } else {
              e._autoBoardHandled = false;
            }
          }, CFG.autoExitDelayMs);
        } else {
          // no player action needed; keep flag set until doors close to prevent repeated checks
        }
      }

      // NPC sparse boarding/exiting (unchanged, low rate)
      const pBoard = 0.08, pExit = 0.05;
      if (Math.random() < pBoard * dt) {
        const w = 50 + Math.random()*90;
        if (e.loadKg + w < e.overloadLimitKg) {
          e.loadKg += w;
          this.log(`NPC boarded (~${Math.round(w)} kg)`);
          e.requestFloor(Math.floor(Math.random()*e.floors));
        } else this.log('NPC blocked by overload');
        e.lastDoorActionMs = nowMs();
      }
      if (Math.random() < pExit * dt && e.loadKg > 0) {
        const out = Math.min(e.loadKg, 20 + Math.random()*80);
        e.loadKg = Math.max(0, e.loadKg - out);
        this.log(`NPC exited (~${Math.round(out)} kg)`);
        e.lastDoorActionMs = nowMs();
      }
    }
    requestExternalCall(floor, dir='up', who='NPC'){ this.calls.push({ floor, dir, who, ts: nowMs() }); this.log(`${who} called ${dir} at floor ${floor}`); window.dispatchEvent(new CustomEvent('lift:call',{ detail:{ floor, dir, who } })); }
    assignCalls(){ if (this.elev.targetFloor !== null) return; if (!this.calls.length) return; const cur = this.elev.metersToFloor(this.elev.position); let bestIdx = 0, bestDist = Infinity; for (let i=0;i<this.calls.length;i++){ const d = Math.abs(this.calls[i].floor - cur); if (d < bestDist){ bestDist = d; bestIdx = i; } } const call = this.calls.splice(bestIdx,1)[0]; this.elev.requestExternal(call.floor, call.who); this.log(`Assigned elevator to external call at ${call.floor}`); }
    step(dt){ this.stepNPCs(dt); this.processScheduled(); if (this.shouldTriggerEvent(CFG.randomEventRatePerSec, dt)) { if (Math.random() < 0.6) this.schedule('door_jam', rand(6,20)); } this.elev.step(dt); this.stepBoarding(dt); this.assignCalls(); }
    serialize(){ return { elev:this.elev.serialize(), playerFloor:this.playerFloor, calls:this.calls.slice(), scheduled:this.scheduled.slice(), npcs:this.npcs.map(n=>({ id:n.id, nextActionMs:n.nextActionMs, busyUntil:n.busyUntil })), logs:this.logs.slice(0,200), ts: nowMs() }; }
    static deserialize(obj){ const w = new World(); if (!obj) return w; try { if (obj.elev) w.elev = Elevator.deserialize(obj.elev, CFG.floors, CFG.initialFloor); w.playerFloor = obj.playerFloor ?? CFG.initialFloor; w.calls = obj.calls || []; w.scheduled = obj.scheduled || []; if (Array.isArray(obj.npcs)) w.npcs = obj.npcs.map(n=>({ id:n.id, nextActionMs:n.nextActionMs||nowMs()+rand(10_000,60_000), busyUntil:n.busyUntil||0 })); w.logs = obj.logs || []; } catch(e) { console.warn('deserialize fail', e); } return w; }
  }

  /* ---------- Renderer ---------- */
  class Renderer {
    constructor(canvas, world) {
      this.canvas = canvas; this.world = world;
      this.ctx = canvas ? canvas.getContext('2d', { alpha:false }) : null;
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.resize(); window.addEventListener('resize', ()=>this.resize());
    }
    resize(){ if (!this.canvas) return; const r = this.canvas.getBoundingClientRect(); this.canvas.width = Math.floor(r.width * this.dpr); this.canvas.height = Math.floor(r.height * this.dpr); if (this.ctx && this.ctx.setTransform) this.ctx.setTransform(this.dpr,0,0,this.dpr,0,0); }
    draw(){ if (!this.ctx) return; const ctx = this.ctx, W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr; ctx.clearRect(0,0,W,H); const pad = 16, shaftW = Math.min(340, W*0.30), shaftX = pad, shaftY = pad, shaftH = H - pad*2; ctx.fillStyle = '#071426'; ctx.fillRect(shaftX, shaftY, shaftW, shaftH); const fc = this.world.elev.floors; const floorH = Math.max(36, Math.floor((shaftH - 8) / fc)); const totalH = floorH * fc; const top = shaftY + (shaftH - totalH); ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1; ctx.font = '11px ui-monospace, monospace'; for (let i=0;i<fc;i++){ const y = top + i*floorH; ctx.beginPath(); ctx.moveTo(shaftX,y); ctx.lineTo(shaftX+shaftW,y); ctx.stroke(); ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillText(`${fc-1-i}`, shaftX + shaftW + 8, y+12); } const carW = Math.min(170, shaftW*0.58), carH = floorH - 6, carX = shaftX + (shaftW - carW)/2; const posRatio = this.world.elev.position / this.world.elev.floorToMeters(Math.max(1, this.world.elev.floors - 1)); const carY = top + (fc-1)*floorH - posRatio * ((fc-1)*floorH) - carH/2; ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(carX+6,carY); ctx.lineTo(carX+6, top-8); ctx.moveTo(carX+carW-6,carY); ctx.lineTo(carX+carW-6, top-8); ctx.stroke(); ctx.fillStyle = '#0f3a4a'; ctx.fillRect(carX,carY,carW,carH); ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(carX+6,carY+6,carW-12,carH-12); const doorProg = this.world.elev.doorProgress; const panelW = carW/2; const leftX = carX + (1-doorProg)*(panelW*0.9); const rightX = carX + carW - panelW - (1-doorProg)*(panelW*0.9); ctx.fillStyle = '#021b25'; ctx.fillRect(leftX,carY,panelW,carH); ctx.fillRect(rightX,carY,panelW,carH); ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.strokeRect(carX,carY,carW,carH); ctx.fillStyle = 'rgba(0,0,0,0.36)'; ctx.fillRect(shaftX+12, 10, 300, 64); ctx.fillStyle = '#cfeffb'; ctx.font = '12px ui-monospace, monospace'; ctx.fillText(`Pos: ${this.world.elev.position.toFixed(2)} m`, shaftX+24, 30); ctx.fillText(`Vel: ${this.world.elev.velocity.toFixed(2)} m/s`, shaftX+24, 52); ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillText(`Target: ${this.world.elev.targetFloor===null?'-':this.world.elev.targetFloor}`, shaftX+200, 30); ctx.fillText(`Load: ${Math.round(this.world.elev.loadKg)} kg`, shaftX+200, 52); }
  }

  /* ---------- UI helpers ---------- */
  function appendLogUI(msg) {
    const container = DOM.passengerLog; if (!container) return;
    const tpl = DOM.tplLogLine;
    const node = tpl ? tpl.content.firstElementChild.cloneNode(true) : document.createElement('div');
    const t = node.querySelector('.log-time');
    const txt = node.querySelector('.log-text') || node;
    if (t) t.textContent = (new Date()).toLocaleTimeString();
    if (txt) txt.textContent = msg;
    container.prepend(node);
    while (container.children.length > 300) container.removeChild(container.lastChild);
  }

  /* ---------- EXTERNAL PANEL (single-floor Up/Down) ---------- */
  let lastRenderedPlayerFloor = null;
  function renderExternalForPlayerFloor() {
    const panel = DOM.externalCallPanel;
    if (!panel) return;
    const f = world.playerFloor;
    if (lastRenderedPlayerFloor === f) return;
    lastRenderedPlayerFloor = f;
    panel.innerHTML = '';
    const row = document.createElement('div'); row.className = 'external-row single';
    const label = document.createElement('div'); label.className = 'external-floor-label'; label.textContent = `Lantai ${f}`;
    row.appendChild(label);

    const group = document.createElement('div'); group.className = 'external-group single';
    const up = document.createElement('button'); up.className = 'call-up single'; up.type = 'button'; up.setAttribute('aria-label', `Panggil naik di lantai ${f}`); up.textContent = '▲';
    if (f >= CFG.floors - 1) up.disabled = true;
    up.addEventListener('click', ()=> {
      if (up.disabled) return;
      up.disabled = true; setTimeout(()=> up.disabled = false, 700);
      AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
      world.requestExternalCall(f, 'up', 'Passenger');
      appendLogUI(`Memanggil naik di lantai ${f}`);
    });
    group.appendChild(up);

    const down = document.createElement('button'); down.className = 'call-down single'; down.type = 'button'; down.setAttribute('aria-label', `Panggil turun di lantai ${f}`); down.textContent = '▼';
    if (f <= 0) down.disabled = true;
    down.addEventListener('click', ()=> {
      if (down.disabled) return;
      down.disabled = true; setTimeout(()=> down.disabled = false, 700);
      AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
      world.requestExternalCall(f, 'down', 'Passenger');
      appendLogUI(`Memanggil turun di lantai ${f}`);
    });
    group.appendChild(down);

    row.appendChild(group);
    panel.appendChild(row);
  }

  /* ---------- INTERNAL KEYPAD ---------- */
  function buildInternalKeypad() {
    const container = DOM.floorPanel;
    if (!container) return;
    container.innerHTML = '';
    const tpl = DOM.tplFloorButton;
    for (let f = CFG.floors - 1; f >= 0; f--) {
      const btn = tpl ? tpl.content.firstElementChild.cloneNode(true) : document.createElement('button');
      btn.classList.add('floor-btn'); btn.dataset.floor = f;
      const span = btn.querySelector('.floor-num'); if (span) span.textContent = f;
      btn.addEventListener('click', ()=> {
        if (btn.disabled) return;
        btn.disabled = true; setTimeout(()=> btn.disabled = false, 700);
        AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
        if (!world.elev.playerInside) { appendLogUI('Keypad hanya aktif ketika berada di dalam kabin.'); return; }
        world.elev.requestFloor(f);
        appendLogUI(`Meminta lantai ${f}`);
      });
      container.appendChild(btn);
    }
    container.style.display = world.elev.playerInside ? 'grid' : 'none';
  }

  /* ---------- Show/hide cabin controls & keypad depending on playerInside ---------- */
  function updatePanelsVisibility() {
    const inside = world.elev.playerInside;
    if (DOM.floorPanel) {
      const needDisplay = inside ? 'grid' : 'none';
      if (DOM.floorPanel.style.display !== needDisplay) DOM.floorPanel.style.display = needDisplay;
    }
    if (DOM.externalCallPanel) {
      const needDisplay = inside ? 'none' : 'block';
      if (DOM.externalCallPanel.style.display !== needDisplay) DOM.externalCallPanel.style.display = needDisplay;
    }
    if (DOM.cabinControls) {
      if (inside) {
        DOM.cabinControls.style.display = '';
        DOM.cabinControls.setAttribute('aria-hidden', 'false');
        DOM.btnDoorOpen && (DOM.btnDoorOpen.disabled = false);
        DOM.btnDoorClose && (DOM.btnDoorClose.disabled = false);
        DOM.btnAlarm && (DOM.btnAlarm.disabled = false);
      } else {
        DOM.cabinControls.style.display = 'none';
        DOM.cabinControls.setAttribute('aria-hidden', 'true');
        DOM.btnDoorOpen && (DOM.btnDoorOpen.disabled = true);
        DOM.btnDoorClose && (DOM.btnDoorClose.disabled = true);
        DOM.btnAlarm && (DOM.btnAlarm.disabled = true);
      }
    }
    if (DOM.displaySmall) {
      const liftF = world.elev.metersToFloor(world.elev.position);
      const youState = inside ? `You: inside @ ${world.playerFloor}` : `You: ${world.playerFloor} (outside)`;
      DOM.displaySmall.textContent = `Lift: ${liftF} — ${youState}`;
    }
  }

  /* ---------- Controls wiring ---------- */
  function wireControls() {
    if (DOM.btnDoorOpen) DOM.btnDoorOpen.addEventListener('click', ()=> {
      if (DOM.btnDoorOpen.disabled) return;
      AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
      const ok = world.elev.openDoors(); appendLogUI(ok ? 'Pintu dibuka.' : 'Gagal membuka pintu.');
      if (ok) AudioEngine.announce('Pintu terbuka');
    });
    if (DOM.btnDoorClose) DOM.btnDoorClose.addEventListener('click', ()=> {
      if (DOM.btnDoorClose.disabled) return;
      AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep();
      const ok = world.elev.closeDoors(); appendLogUI(ok ? 'Pintu ditutup.' : 'Penutupan pintu ditahan.');
      if (ok) AudioEngine.announce('Pintu tertutup');
    });
    if (DOM.btnAlarm) DOM.btnAlarm.addEventListener('click', ()=> {
      if (DOM.btnAlarm.disabled) return;
      AudioEngine.ensure(); AudioEngine.unlock(); AudioEngine.beep({freq:240, time:0.28, vol:0.3});
      appendLogUI('Alarm ditekan — bantuan diberitahu (simulasi).');
      window.dispatchEvent(new CustomEvent('lift:alarm',{ detail:{ who:'Passenger' } }));
      world.schedule('auto_repair', 8, { comp: 'control' });
    });
    if (DOM.modalClose) DOM.modalClose.addEventListener('click', ()=> { if (DOM.modal) DOM.modal.setAttribute('aria-hidden','true'); });

    window.addEventListener('keydown', (e)=> {
      if (e.key.toLowerCase() === 'm') { const on = AudioEngine.toggle(); appendLogUI(on ? 'Suara aktif' : 'Suara dimatikan'); }
      if (e.key.toLowerCase() === 'o') DOM.btnDoorOpen?.click();
      if (e.key.toLowerCase() === 'c') DOM.btnDoorClose?.click();
    });

    window.addEventListener('lift:arrived', (e)=> { if (e?.detail) appendLogUI(`Lift tiba di lantai ${e.detail.floor}`); });
    window.addEventListener('lift:door', (e)=> { if (e?.detail?.state) appendLogUI(`Door ${e.detail.state}`); });
    window.addEventListener('lift:call', (e)=> { if (e?.detail) appendLogUI(`Call: ${e.detail.floor} by ${e.detail.who || 'unknown'}`); });
  }

  /* ---------- Persistence ---------- */
  function saveNow(){ try{ saveJSON(CFG.persistenceKey, { ts: nowMs(), world: world.serialize() }); }catch(e){} }
  function tryLoad(){ const raw = loadJSON(CFG.persistenceKey); if (!raw || !raw.world) return null; return raw; }

  /* ---------- Bootstrap & main loop ---------- */
  let world;
  const saved = tryLoad();
  if (saved && saved.world) {
    world = World.deserialize(saved.world);
    const delta = Math.floor((nowMs() - (saved.ts || nowMs()))/1000);
    const ff = Math.min(delta, 60*10);
    if (ff > 2) {
      let ran = 0; const stepSec = 5;
      while (ran < ff) { world.step(Math.min(stepSec, ff-ran)); ran += stepSec; }
      world.log(`Fast-forwarded ${Math.round(ff)}s since last session`);
    }
  } else {
    world = new World();
    world.log('World initialized (passenger-mode).');
  }

  const renderer = new Renderer(DOM.canvas, world);

  buildInternalKeypad();
  renderExternalForPlayerFloor();
  wireControls();
  updatePanelsVisibility();

  // main fixed-step loop
  let last = performance.now(); let acc = 0; const MS_PER_STEP = 1000/60;
  function frame(now) {
    const dtMs = Math.min(200, now - last);
    last = now;
    acc += dtMs;
    let steps = 0;
    while (acc >= MS_PER_STEP && steps < 8) {
      world.step(MS_PER_STEP/1000); acc -= MS_PER_STEP; steps++;
    }
    renderer.draw();
    // UI sync
    if (DOM.displayFloor) DOM.displayFloor.textContent = String(world.elev.metersToFloor(world.elev.position));
    if (DOM.displayState) DOM.displayState.textContent = world.elev.state;
    if (DOM.readoutLoad) DOM.readoutLoad.textContent = `${Math.round(world.elev.loadKg)} kg`;
    if (DOM.readoutSpeed) DOM.readoutSpeed.textContent = `${world.elev.velocity.toFixed(2)} m/s`;
    if (DOM.readoutDoor) DOM.readoutDoor.textContent = world.elev.doorsOpen ? 'Terbuka' : 'Tertutup';

    renderExternalForPlayerFloor();
    updatePanelsVisibility();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame((t)=>{ last = t; requestAnimationFrame(frame); });

  // autosave
  setInterval(saveNow, 1000 * 8);

  // unlock audio on first click
  const unlockOnce = ()=>{ AudioEngine.ensure(); AudioEngine.unlock(); window.removeEventListener('click', unlockOnce); };
  window.addEventListener('click', unlockOnce, { once: true });

  // expose debug API
  window.LiftSim = { world, cfg: CFG, audio: AudioEngine, saveNow };

  appendLogUI('Simulator siap — auto-enter/auto-exit diperkuat: lift akan otomatis menampung Anda saat pintu terbuka sepenuhnya, dan otomatis menurunkan Anda saat sampai di tujuan.');

  return { world, cfg: CFG, audio: AudioEngine };
})();

export default LiftSim;
