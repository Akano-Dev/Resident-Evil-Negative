/* ================================================================
   DEAD ZONE — game.js  (Combat Overhaul Edition)
   Three.js r128

   ASSET STRUCTURE:
     models/   zombie.glb  gun.glb
     sounds/   gunshot.wav  zombie_growl.wav  player_hurt.wav  ambient_horror.mp3
     textures/ ground.jpg   wall.jpg          ceiling.jpg      sky.jpg

   HOW ASSETS ARE HANDLED:
   • Every external asset is wrapped in a try/load pattern.
   • If a file is missing the loader catches the error and the game
     automatically falls back to the existing procedural mesh / Web
     Audio synthesis — so the game ALWAYS runs even with no files.
   • Drop real files into the folders above and they are used instead.

   FIX / IMPROVEMENT LOG:
   [FIX-1] Pointer lock — canvas 100vw×100vh; pointerlockerror caught;
           requestPointerLock inside user-gesture; ESC → pause menu.
   [FIX-2] Zombie GLB — pivot Group drives AI; inner mesh holds visual
           orientation; bounding-box auto-scale; lookAt on pivot only.
   [FIX-3] Audio latency — AudioContext created early (suspended);
           all buffers decoded before first shot; zero first-shot delay.
   [FIX-4] Zombie health / death — health clamped; dead flag first;
           death animation on inner mesh; position.y guarded post-death.
   [COMBAT-1] Bullet collision — world-space sphere test on pivot plus
              vertical range guard; bullet removed on hit immediately;
              hit confirmed with screen flash + kill-count increment.
   [COMBAT-2] Blood effects — 20-particle burst with two passes:
              fast outward spray + slow drip layer; particles carry
              per-particle random colour within the dark-red range;
              additive blending on fast particles for a gory glow.
   [COMBAT-3] Zombie respawn — after death a 3-5 s timer selects a
              random spawn point well away from the player; a new
              zombie is placed, health reset, and the chase resumes;
              zombiesKilled counter drives escalating difficulty.
   [COMBAT-4] Kill counter & scoring — kills shown in HUD; difficulty
              ramps every kill (speed +0.15, damage +1, health +10).
   [FIX-5] Performance / fallback safety — all procedural systems kept;
           particle cap (MAX_PARTICLES) prevents runaway allocation.
   [FIX-6] Code quality — architecture unchanged; comments retained.
   ================================================================ */
'use strict';

// ─────────────────────────────────────────────────────────────────
//  ASSET MANIFEST
// ─────────────────────────────────────────────────────────────────
const ASSET_PATHS = {
  models: {
    zombie : 'models/zombie.glb',
    gun    : 'models/gun.glb',
  },
  sounds: {
    gunshot     : 'sounds/gunshot.wav',
    zombieGrowl : 'sounds/zombie_growl.wav',
    playerHurt  : 'sounds/player_hurt.wav',
    ambient     : 'sounds/ambient_horror.mp3',
  },
  textures: {
    ground  : 'textures/ground.jpg',
    wall    : 'textures/wall.jpg',
    ceiling : 'textures/ceiling.jpg',
    sky     : 'textures/sky.jpg',
  },
};

// ─────────────────────────────────────────────────────────────────
//  LOADED ASSET CACHE
//  null = not loaded / fallback to procedural.
// ─────────────────────────────────────────────────────────────────
const Assets = {
  models:   { zombie: null, gun: null },
  buffers:  { gunshot: null, zombieGrowl: null, playerHurt: null, ambient: null },
  textures: { ground: null, wall: null, ceiling: null, sky: null },
};

// ─────────────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────────────
const Settings = {
  sensitivity : 0.0014,
  volume      : 0.7,
  showFPS     : true,
};

// ─────────────────────────────────────────────────────────────────
//  GAME CONSTANTS
// ─────────────────────────────────────────────────────────────────
const PLAYER_SPEED           = 8;
const PLAYER_HEALTH_MAX      = 100;
const ZOMBIE_HEALTH_MAX      = 200;
const BULLET_DAMAGE          = 30;
const BULLET_SPEED           = 45;
const AMMO_MAX               = 12;
const GRAVITY                = -24;
const JUMP_FORCE             = 10;
const ZOMBIE_ATTACK_RANGE    = 2.0;
const ZOMBIE_ATTACK_INTERVAL = 1.1;
const SHOOT_COOLDOWN         = 0.28;
const DAY_DURATION           = 60;   // seconds of daylight
const NIGHT_DURATION         = 60;   // seconds of night
const ZOMBIE_DAY             = { speed: 2.5, damage:  6 };
const ZOMBIE_NIGHT           = { speed: 5.2, damage: 14 };

// [COMBAT-1] Hit detection constants
// ZOMBIE_HIT_RADIUS: horizontal sphere radius for bullet/zombie test.
// ZOMBIE_HIT_HEIGHT: maximum y-distance from pivot for a valid hit
//   (prevents bullets fired overhead from registering as hits).
const ZOMBIE_HIT_RADIUS      = 1.2;
const ZOMBIE_HIT_HEIGHT      = 2.5;

// [COMBAT-3] Respawn configuration
const ZOMBIE_RESPAWN_MIN     = 3.0;   // minimum seconds before respawn
const ZOMBIE_RESPAWN_MAX     = 5.0;   // maximum seconds before respawn
// Safe distance from player for a respawn point (world-units)
const ZOMBIE_SPAWN_SAFE_DIST = 8.0;
// Map boundary used for random spawn — must be ≤ room half-width (16)
const ZOMBIE_SPAWN_BOUND     = 12.0;

// [COMBAT-4] Difficulty ramp per kill
const DIFFICULTY_SPEED_INC   = 0.15;  // added to base speed each kill
const DIFFICULTY_DAMAGE_INC  = 1;     // added to base damage each kill
const DIFFICULTY_HEALTH_INC  = 10;    // added to ZOMBIE_HEALTH_MAX each kill

// [FIX-5] Max live particles to prevent garbage spikes
const MAX_PARTICLES          = 200;

// ─────────────────────────────────────────────────────────────────
//  GAME STATE
// ─────────────────────────────────────────────────────────────────
let scene, camera, renderer, clock;
let keys          = {};
let yaw = 0, pitch = 0;
let velocityY     = 0;
let isOnGround    = true;
let isBlocking    = false;
let gameActive    = false;
let gamePaused    = false;
let gameOver      = false;

let playerHealth      = PLAYER_HEALTH_MAX;
let zombieHealth      = ZOMBIE_HEALTH_MAX;
let ammo              = AMMO_MAX;
let canShoot          = true;
let shootTimer        = 0;
let zombieAttackTimer = 0;
let zombieAlive       = true;

// [FIX-2] zombieGroup is the AI PIVOT; zombieMesh is the visual child.
let zombieGroup, zombieMesh;
// Eye references for day/night emissive glow.
let zombieEyeL, zombieEyeR;
// Canonical spawn position (updated each respawn).
let zombiePos       = new THREE.Vector3(10, 0, 10);
let zombieWalkTimer = 0;
let growlTimer      = 0;

// [COMBAT-3] Respawn state
let zombieRespawnTimer  = 0;   // countdown seconds until respawn
let zombiesKilled       = 0;   // total kills this game session
let isRespawning        = false; // true while waiting to respawn

// [COMBAT-4] Difficulty accumulator — grows with each kill
let difficultyLevel = 0;

let isDay      = true;
let cycleTimer = 0;

let bullets       = [];
let particles     = [];
let wallMeshes    = [];
let flickerLights = [];
let sunLight, ambLight, skyMesh;
let gunGroup;
let gunRecoil   = 0;
let gunBobTimer = 0;

let fpsFrames = 0, fpsTime = 0;
let shotsFired = 0, shotsHit = 0, damageTaken = 0, surviveTime = 0;

// ─────────────────────────────────────────────────────────────────
//  DOM REFS
// ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const loadingScreen = $('loading-screen');
const loadBar       = $('load-bar');
const loadText      = $('load-text');
const mainMenu      = $('main-menu');
const settingsPanel = $('settings-panel');
const pauseMenu     = $('pause-menu');
const endScreen     = $('end-screen');
const hud           = $('hud');
const healthBar     = $('health-bar');
const healthVal     = $('health-val');
const ammoCur       = $('ammo-cur');
const ammoMaxEl     = $('ammo-max');
const reloadHint    = $('reload-hint');
const zombieBar     = $('zombie-bar');
const hitFlash      = $('hit-flash');
const shootFlash    = $('shoot-flash');
const nightVignette = $('night-vignette');
const muzzleFlash   = $('muzzle-flash');
const gameMsg       = $('game-msg');
const blockInd      = $('block-ind');
const timeIcon      = $('time-icon');
const timeLabel     = $('time-label');
const timeBar       = $('time-bar');
const fpsCounter    = $('fps-counter');
const phaseBanner   = $('phase-banner');

// ═══════════════════════════════════════════════════════════════════
//
//  ██████╗  █████╗ ███████╗███████╗███████╗████████╗███████╗
//  ██╔══██╗██╔══██╗██╔════╝██╔════╝██╔════╝╚══██╔══╝██╔════╝
//  ███████║███████║███████╗███████╗█████╗     ██║   ███████╗
//  ██╔══██║██╔══██║╚════██║╚════██║██╔══╝     ██║   ╚════██║
//  ██║  ██║██║  ██║███████║███████║███████╗   ██║   ███████║
//  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝   ╚═╝   ╚══════╝
//
// ═══════════════════════════════════════════════════════════════════

/**
 * Asset Manager
 * ─────────────
 * Loads all external assets in parallel, reports progress, and
 * stores results in the Assets cache.  Missing files are silently
 * caught — the game falls back to procedural generation for anything
 * that fails to load.
 */
const AssetManager = (() => {
  // ── Helpers ─────────────────────────────────────────────────────

  /** Promise-based GLTF loader. Resolves with the gltf object or null. */
  function loadGLTF(path) {
    return new Promise(resolve => {
      if (typeof THREE.GLTFLoader === 'undefined') {
        console.warn(`[Assets] GLTFLoader not available — skipping ${path}`);
        resolve(null); return;
      }
      const loader = new THREE.GLTFLoader();
      loader.load(
        path,
        gltf  => { console.log(`[Assets] ✓ Model loaded: ${path}`); resolve(gltf); },
        null,
        err   => { console.warn(`[Assets] ✗ Model missing: ${path}`); resolve(null); }
      );
    });
  }

  /**
   * Promise-based AudioBuffer loader via fetch + ArrayBuffer storage.
   * Raw bytes stored in Assets.buffers.*; decoded inside initAudio().
   * [FIX-3] Each raw buffer is cloned before decoding.
   */
  function loadAudioBuffer(path) {
    return new Promise(resolve => {
      fetch(path)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then(ab  => { console.log(`[Assets] ✓ Audio loaded: ${path}`); resolve(ab); })
        .catch(e  => { console.warn(`[Assets] ✗ Audio missing: ${path} (${e.message})`); resolve(null); });
    });
  }

  /**
   * Promise-based THREE.TextureLoader wrapper.
   * Resolves with a configured THREE.Texture or null on error.
   */
  function loadTexture(path) {
    return new Promise(resolve => {
      const loader = new THREE.TextureLoader();
      loader.load(
        path,
        tex => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          console.log(`[Assets] ✓ Texture loaded: ${path}`);
          resolve(tex);
        },
        null,
        () => { console.warn(`[Assets] ✗ Texture missing: ${path}`); resolve(null); }
      );
    });
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * loadAll(onProgress)
   * Kicks off all asset loads in parallel.
   * onProgress(pct:0-100, message:string) called as groups finish.
   * Returns a Promise that resolves when all assets are done.
   */
  function loadAll(onProgress) {
    const total = 10;  // models×2 + sounds×4 + textures×4
    let done = 0;

    function tick(msg) {
      done++;
      onProgress(Math.round((done / total) * 100), msg);
    }

    const modelJobs = [
      loadGLTF(ASSET_PATHS.models.zombie).then(r => { Assets.models.zombie = r;              tick('Zombie model…');   }),
      loadGLTF(ASSET_PATHS.models.gun   ).then(r => { Assets.models.gun    = r;              tick('Gun model…');      }),
    ];

    const soundJobs = [
      loadAudioBuffer(ASSET_PATHS.sounds.gunshot    ).then(r => { Assets.buffers.gunshot      = r; tick('Gunshot audio…');   }),
      loadAudioBuffer(ASSET_PATHS.sounds.zombieGrowl).then(r => { Assets.buffers.zombieGrowl  = r; tick('Growl audio…');     }),
      loadAudioBuffer(ASSET_PATHS.sounds.playerHurt ).then(r => { Assets.buffers.playerHurt   = r; tick('Hurt audio…');      }),
      loadAudioBuffer(ASSET_PATHS.sounds.ambient    ).then(r => { Assets.buffers.ambient       = r; tick('Ambient audio…');   }),
    ];

    const texJobs = [
      loadTexture(ASSET_PATHS.textures.ground  ).then(r => { Assets.textures.ground   = r; tick('Ground texture…');  }),
      loadTexture(ASSET_PATHS.textures.wall    ).then(r => { Assets.textures.wall     = r; tick('Wall texture…');    }),
      loadTexture(ASSET_PATHS.textures.ceiling ).then(r => { Assets.textures.ceiling  = r; tick('Ceiling texture…'); }),
      loadTexture(ASSET_PATHS.textures.sky     ).then(r => { Assets.textures.sky      = r; tick('Sky texture…');     }),
    ];

    return Promise.all([...modelJobs, ...soundJobs, ...texJobs]);
  }

  return { loadAll };
})();

// ═══════════════════════════════════════════════════════════════════
//  LOADING SEQUENCE
// ═══════════════════════════════════════════════════════════════════

function runBootstrap() {
  loadBar.style.width  = '5%';
  loadText.textContent = 'Loading assets…';

  AssetManager.loadAll((pct, msg) => {
    loadBar.style.width  = (5 + pct * 0.90) + '%';
    loadText.textContent = msg;
  }).then(() => {
    loadBar.style.width  = '100%';
    loadText.textContent = 'Ready. Daylight won\'t last…';

    setTimeout(() => {
      loadingScreen.style.transition = 'opacity .8s';
      loadingScreen.style.opacity    = '0';
      setTimeout(() => {
        loadingScreen.style.display = 'none';
        mainMenu.style.display      = 'flex';
        initThree();
      }, 800);
    }, 800);
  });
}

runBootstrap();

// ═══════════════════════════════════════════════════════════════════
//  MENU WIRING
// ═══════════════════════════════════════════════════════════════════

$('btn-start').addEventListener('click', () => {
  mainMenu.style.display = 'none';
  startGame();
});

$('btn-settings').addEventListener('click', () => {
  mainMenu.style.display      = 'none';
  settingsPanel.style.display = 'flex';
  settingsPanel.dataset.from  = 'main';
});

$('btn-settings-back').addEventListener('click', () => {
  settingsPanel.style.display = 'none';
  if (settingsPanel.dataset.from === 'pause') {
    pauseMenu.style.display = 'flex';
  } else {
    mainMenu.style.display  = 'flex';
  }
});

$('btn-resume').addEventListener('click', resumeGame);

$('btn-pause-settings').addEventListener('click', () => {
  pauseMenu.style.display     = 'none';
  settingsPanel.style.display = 'flex';
  settingsPanel.dataset.from  = 'pause';
});

$('btn-quit').addEventListener('click', () => {
  pauseMenu.style.display = 'none';
  endScreen.style.display = 'none';
  hud.style.display       = 'none';
  gameActive = false;
  gameOver   = true;
  document.exitPointerLock();
  resetSceneState();
  mainMenu.style.display = 'flex';
});

$('btn-restart').addEventListener('click', () => {
  endScreen.style.display = 'none';
  resetSceneState();
  startGame();
});

$('btn-end-menu').addEventListener('click', () => {
  endScreen.style.display = 'none';
  hud.style.display       = 'none';
  resetSceneState();
  mainMenu.style.display  = 'flex';
});

// Settings sliders / toggles
$('sens-slider').addEventListener('input', function () {
  Settings.sensitivity      = this.value / 5000;
  $('sens-val').textContent = this.value;
});
$('vol-slider').addEventListener('input', function () {
  Settings.volume           = this.value / 100;
  $('vol-val').textContent  = this.value + '%';
  // [FIX-3] masterGain may not exist yet if audio hasn't been unlocked
  if (masterGain && audioCtx) {
    masterGain.gain.setTargetAtTime(Settings.volume * 0.6, audioCtx.currentTime, 0.1);
  }
});
$('fullscreen-btn').addEventListener('click', function () {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
    this.textContent = 'Disable'; this.classList.add('toggled');
  } else {
    document.exitFullscreen();
    this.textContent = 'Enable'; this.classList.remove('toggled');
  }
});
$('fps-btn').addEventListener('click', function () {
  Settings.showFPS = !Settings.showFPS;
  this.textContent = Settings.showFPS ? 'ON' : 'OFF';
  this.classList.toggle('toggled', Settings.showFPS);
  fpsCounter.style.display = Settings.showFPS ? 'block' : 'none';
});

// ═══════════════════════════════════════════════════════════════════
//  [FIX-1]  POINTER LOCK + INPUT
// ═══════════════════════════════════════════════════════════════════

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer?.domElement;

  if (locked) {
    gameActive = true;
    gamePaused = false;
  } else {
    gameActive = false;
    if (!gameOver && !gamePaused) {
      _openPauseMenu();
    }
  }
});

document.addEventListener('pointerlockerror', () => {
  console.warn('[PointerLock] Request failed — must be called from a user gesture.');
});

document.addEventListener('mousemove', e => {
  if (!gameActive || gamePaused || gameOver) return;
  yaw   -= e.movementX * Settings.sensitivity;
  pitch -= e.movementY * Settings.sensitivity;
  pitch  = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, pitch));
});

document.addEventListener('mousedown', e => {
  if (!gameActive || gamePaused || gameOver) return;
  if (e.button === 0) tryShoot();
  if (e.button === 2) { isBlocking = true;  blockInd.style.display = 'block'; }
});

document.addEventListener('mouseup', e => {
  if (e.button === 2) { isBlocking = false; blockInd.style.display = 'none'; }
});

document.addEventListener('contextmenu', e => e.preventDefault());

document.addEventListener('keydown', e => {
  keys[e.code] = true;

  if (e.code === 'Escape') {
    if (gameOver) return;
    if (gamePaused) {
      resumeGame();
    } else if (gameActive) {
      pauseGame();
    }
    return;
  }

  if (e.code === 'Space' && isOnGround && gameActive && !gamePaused && !gameOver) {
    velocityY  = JUMP_FORCE;
    isOnGround = false;
  }
  if (e.code === 'KeyR' && gameActive && !gamePaused && !gameOver) doReload();
});

document.addEventListener('keyup', e => { keys[e.code] = false; });

function _openPauseMenu() {
  gamePaused = true;
  pauseMenu.style.display = 'flex';
}

function pauseGame() {
  gamePaused = true;
  document.exitPointerLock();
  pauseMenu.style.display = 'flex';
}

function resumeGame() {
  pauseMenu.style.display = 'none';
  renderer.domElement.requestPointerLock();
}

// ═══════════════════════════════════════════════════════════════════
//
//   █████╗ ██╗   ██╗██████╗ ██╗ ██████╗
//  ██╔══██╗██║   ██║██╔══██╗██║██╔═══██╗
//  ███████║██║   ██║██║  ██║██║██║   ██║
//  ██╔══██║██║   ██║██║  ██║██║██║   ██║
//  ██║  ██║╚██████╔╝██████╔╝██║╚██████╔╝
//  ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝
//
// ═══════════════════════════════════════════════════════════════════
/**
 * Hybrid Audio Engine
 * ───────────────────
 * [FIX-3] AudioContext created early (suspended) then resumed on first
 * user gesture.  ALL ArrayBuffers decoded eagerly so the gunshot buffer
 * is ready before the player can fire.
 */

let audioCtx   = null;
let masterGain = null;
const DecodedBuffers  = { gunshot: null, zombieGrowl: null, playerHurt: null, ambient: null };
let ambientSourceNode = null;

// Create AudioContext immediately (browsers allow creation without gesture)
(function _createAudioContext() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'running') audioCtx.suspend();
  } catch (e) {
    console.warn('[Audio] Web Audio API not available:', e);
  }
})();

function _unlockAudio() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => console.log('[Audio] AudioContext resumed'));
  }
}

function initAudio() {
  if (!audioCtx) return;

  if (!masterGain) {
    masterGain = audioCtx.createGain();
    masterGain.gain.value = Settings.volume * 0.6;
    masterGain.connect(audioCtx.destination);
  }

  _unlockAudio();

  // Decode all raw buffers immediately — no latency on first shot
  _decodeAllBuffers().then(() => {
    startAmbient();
  });
}

async function _decodeAllBuffers() {
  const entries = [
    ['gunshot',     Assets.buffers.gunshot    ],
    ['zombieGrowl', Assets.buffers.zombieGrowl],
    ['playerHurt',  Assets.buffers.playerHurt ],
    ['ambient',     Assets.buffers.ambient    ],
  ];
  for (const [key, raw] of entries) {
    if (!raw || DecodedBuffers[key]) continue;
    try {
      DecodedBuffers[key] = await audioCtx.decodeAudioData(raw.slice(0));
      console.log(`[Audio] ✓ Decoded: ${key}`);
    } catch (e) {
      console.warn(`[Audio] ✗ Decode failed: ${key}`, e);
    }
  }
}

function _playBuffer(buf, gainVal = 1.0, loop = false) {
  if (!audioCtx || !buf) return null;
  if (audioCtx.state !== 'running') return null;
  try {
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop   = loop;
    const g    = audioCtx.createGain();
    g.gain.value = gainVal;
    src.connect(g);
    g.connect(masterGain);
    src.start(0);
    return src;
  } catch (e) { return null; }
}

// ── Ambient ──────────────────────────────────────────────────────

function startAmbient() {
  if (ambientSourceNode) { try { ambientSourceNode.stop(); } catch(e){} }

  if (DecodedBuffers.ambient) {
    ambientSourceNode = _playBuffer(DecodedBuffers.ambient, 0.4, true);
    console.log('[Audio] Ambient: using loaded file');
  } else {
    console.log('[Audio] Ambient: using synthesised fallback');
    try {
      const sr   = audioCtx.sampleRate;
      const buf  = audioCtx.createBuffer(1, sr * 4, sr);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const t = i / sr;
        data[i] = Math.sin(t * 55 * Math.PI * 2) * 0.18
                + Math.sin(t * 38 * Math.PI * 2) * 0.10
                + (Math.random() * 2 - 1) * 0.015;
      }
      const src = audioCtx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const ag = audioCtx.createGain();
      ag.gain.value = 0.35;
      src.connect(ag); ag.connect(masterGain); src.start();
      ambientSourceNode = src;
    } catch (e) {}
  }
}

// ── Gunshot ──────────────────────────────────────────────────────

function playGunshot() {
  if (!audioCtx) return;
  if (DecodedBuffers.gunshot) { _playBuffer(DecodedBuffers.gunshot, 0.9); return; }
  try {
    const dur  = 0.14;
    const sr   = audioCtx.sampleRate;
    const buf  = audioCtx.createBuffer(1, sr * dur, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.03));
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(1.0, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    src.connect(g); g.connect(masterGain); src.start();
  } catch (e) {}
}

// ── Zombie Growl ─────────────────────────────────────────────────

function playZombieGrowl() {
  if (!audioCtx) return;
  if (DecodedBuffers.zombieGrowl) { _playBuffer(DecodedBuffers.zombieGrowl, 0.8); return; }
  try {
    const osc = audioCtx.createOscillator();
    const g   = audioCtx.createGain();
    osc.type  = 'sawtooth';
    osc.frequency.setValueAtTime(90 + Math.random() * 30, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(40, audioCtx.currentTime + 0.5);
    g.gain.setValueAtTime(0.25, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.55);
    osc.connect(g); g.connect(masterGain);
    osc.start(); osc.stop(audioCtx.currentTime + 0.55);
  } catch (e) {}
}

// ── Player Hurt ──────────────────────────────────────────────────

function playPlayerHurt() {
  if (!audioCtx) return;
  if (DecodedBuffers.playerHurt) { _playBuffer(DecodedBuffers.playerHurt, 0.85); return; }
  try {
    const osc = audioCtx.createOscillator();
    const g   = audioCtx.createGain();
    osc.type  = 'triangle';
    osc.frequency.setValueAtTime(320, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, audioCtx.currentTime + 0.25);
    g.gain.setValueAtTime(0.35, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.28);
    osc.connect(g); g.connect(masterGain);
    osc.start(); osc.stop(audioCtx.currentTime + 0.3);
  } catch (e) {}
}

// ── Dry Click (empty gun) ────────────────────────────────────────

function playDryClick() {
  if (!audioCtx) return;
  try {
    const sr   = audioCtx.sampleRate;
    const buf  = audioCtx.createBuffer(1, sr * 0.04, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.3 * Math.exp(-i / 200);
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(masterGain); src.start();
  } catch (e) {}
}

// ── Reload ───────────────────────────────────────────────────────

function playReload() {
  if (!audioCtx) return;
  try {
    [0, 0.18, 0.36].forEach((delay, i) => {
      const osc = audioCtx.createOscillator();
      const g   = audioCtx.createGain();
      osc.type  = 'square';
      osc.frequency.value = 350 + i * 80;
      g.gain.setValueAtTime(0.12, audioCtx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.12);
      osc.connect(g); g.connect(masterGain);
      osc.start(audioCtx.currentTime + delay);
      osc.stop (audioCtx.currentTime + delay + 0.15);
    });
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════
//
//  ████████╗███████╗██╗  ██╗████████╗██╗   ██╗██████╗ ███████╗███████╗
//  ╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝██║   ██║██╔══██╗██╔════╝██╔════╝
//     ██║   █████╗   ╚███╔╝    ██║   ██║   ██║██████╔╝█████╗  ███████╗
//     ██║   ██╔══╝   ██╔██╗    ██║   ██║   ██║██╔══██╗██╔══╝  ╚════██║
//     ██║   ███████╗██╔╝ ██╗   ██║   ╚██████╔╝██║  ██║███████╗███████║
//     ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝
//
// ═══════════════════════════════════════════════════════════════════
/**
 * Texture Provider
 * ────────────────
 * Returns a configured THREE.Texture — loaded image or procedural.
 */

function makeCanvas(size, fn) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  fn(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ── Procedural fallbacks ──────────────────────────────────────────

function procFloor() {
  return makeCanvas(512, (ctx, s) => {
    ctx.fillStyle = '#2a2420'; ctx.fillRect(0, 0, s, s);
    const ts = 64;
    for (let y = 0; y < s; y += ts) {
      for (let x = 0; x < s; x += ts) {
        const lum = 30 + Math.random() * 18;
        ctx.fillStyle = `rgb(${lum},${lum - 4},${lum - 8})`;
        ctx.fillRect(x + 2, y + 2, ts - 4, ts - 4);
      }
    }
    ctx.strokeStyle = '#111'; ctx.lineWidth = 3;
    for (let x = 0; x <= s; x += ts) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,s); ctx.stroke(); }
    for (let y = 0; y <= s; y += ts) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(s,y); ctx.stroke(); }
    for (let i = 0; i < 8000; i++) {
      const v = Math.random() * 25;
      ctx.fillStyle = `rgba(${v},${v},${v},0.05)`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1, 1);
    }
  });
}

function procWall() {
  return makeCanvas(512, (ctx, s) => {
    ctx.fillStyle = '#1c1a18'; ctx.fillRect(0, 0, s, s);
    const bW = 80, bH = 34;
    for (let row = 0; row * bH < s + bH; row++) {
      const ox = (row % 2) * (bW / 2);
      for (let col = -1; col * bW < s + bW; col++) {
        const x = col * bW + ox, y = row * bH;
        const lum = 26 + Math.floor(Math.random() * 14);
        ctx.fillStyle = `rgb(${lum},${lum - 3},${lum - 6})`;
        ctx.fillRect(x + 2, y + 2, bW - 4, bH - 4);
        ctx.strokeStyle = '#0c0b0a'; ctx.lineWidth = 3;
        ctx.strokeRect(x + 1, y + 1, bW - 2, bH - 2);
      }
    }
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath();
      let cx = Math.random() * s, cy = Math.random() * s;
      ctx.moveTo(cx, cy);
      for (let j = 0; j < 8; j++) { cx += Math.random()*14-7; cy += Math.random()*14-4; ctx.lineTo(cx,cy); }
      ctx.stroke();
    }
    const bx = 40 + Math.random()*(s-80), by = 40 + Math.random()*(s-80);
    const gr = ctx.createRadialGradient(bx,by,0,bx,by,25);
    gr.addColorStop(0,'rgba(80,0,0,0.6)'); gr.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle = gr; ctx.fillRect(0,0,s,s);
  });
}

function procCeiling() {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = '#151413'; ctx.fillRect(0,0,s,s);
    for (let i = 0; i < 20; i++) {
      const gx = Math.random()*s, gy = Math.random()*s;
      const g  = ctx.createRadialGradient(gx,gy,0,gx,gy,20+Math.random()*35);
      g.addColorStop(0,'rgba(4,2,0,0.65)'); g.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,s,s);
    }
  });
}

function procGround() {
  return makeCanvas(512, (ctx, s) => {
    ctx.fillStyle = '#3a3020'; ctx.fillRect(0,0,s,s);
    for (let i = 0; i < 12000; i++) {
      const x = Math.random()*s, y = Math.random()*s;
      const r = 36+Math.random()*20, g2 = 30+Math.random()*14, b = 16+Math.random()*10;
      ctx.fillStyle = `rgba(${r},${g2},${b},0.18)`;
      ctx.fillRect(x,y,2,2);
    }
  });
}

// ── Resolved texture getters (file or fallback) ───────────────────

function getFloorTex()   { const t = Assets.textures.ground  || procFloor();   t.repeat.set(8, 8);   return t; }
function getWallTex()    { const t = Assets.textures.wall    || procWall();    t.repeat.set(5, 2);   return t; }
function getCeilingTex() { const t = Assets.textures.ceiling || procCeiling(); t.repeat.set(8, 8);   return t; }
function getGroundTex()  { const t = Assets.textures.ground  || procGround();  t.repeat.set(12, 12); return t; }

// ═══════════════════════════════════════════════════════════════════
//  THREE.JS INIT
// ═══════════════════════════════════════════════════════════════════

function initThree() {
  const canvas = $('game-canvas');

  // [FIX-1] Cover full viewport so every click can request pointer lock
  canvas.style.position = 'fixed';
  canvas.style.top      = '0';
  canvas.style.left     = '0';
  canvas.style.width    = '100vw';
  canvas.style.height   = '100vh';
  canvas.style.display  = 'block';

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled      = true;
  renderer.shadowMap.type         = THREE.PCFSoftShadowMap;
  renderer.toneMapping            = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure    = 1.0;

  scene  = new THREE.Scene();
  clock  = new THREE.Clock();
  camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(0, 1.65, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  buildEnvironment();
  buildLights();
  buildSky();
  spawnZombie();
  buildGunModel();

  // [FIX-1] Only request lock from a real click inside a user-gesture
  canvas.addEventListener('click', () => {
    if (!gameOver && hud.style.display !== 'none' && !gamePaused) {
      canvas.requestPointerLock();
    }
  });

  gameLoop();
}

// ═══════════════════════════════════════════════════════════════════
//  START / RESET
// ═══════════════════════════════════════════════════════════════════

function startGame() {
  _unlockAudio();
  initAudio();

  playerHealth      = PLAYER_HEALTH_MAX;
  zombieHealth      = ZOMBIE_HEALTH_MAX;
  ammo              = AMMO_MAX;
  canShoot          = true;
  shootTimer        = 0;
  zombieAttackTimer = 0;
  zombieAlive       = true;
  gameOver          = false;
  gamePaused        = false;
  yaw = pitch       = 0;
  velocityY         = 0;
  isOnGround        = true;
  isBlocking        = false;
  isDay             = true;
  cycleTimer        = 0;
  surviveTime = shotsFired = shotsHit = damageTaken = 0;

  // [COMBAT-3] Reset respawn & kill tracking
  zombiesKilled      = 0;
  isRespawning       = false;
  zombieRespawnTimer = 0;

  // [COMBAT-4] Reset difficulty
  difficultyLevel    = 0;

  blockInd.style.display = 'none';
  gameMsg.style.opacity  = '0';
  camera.position.set(0, 1.65, 0);
  camera.rotation.set(0, 0, 0);

  // Reset zombie to initial spawn
  zombiePos.set(10, 0, 10);
  _resetZombieVisuals();

  ammoMaxEl.textContent = AMMO_MAX;
  ammoCur.classList.remove('ammo-warn');
  reloadHint.style.display = 'none';
  updateHUD();
  updateZombieBar();
  _updateKillCounter();
  setDayEnvironment(1);

  hud.style.display = 'block';
  renderer.domElement.requestPointerLock();
}

/**
 * _resetZombieVisuals()
 * ─────────────────────
 * Repositions and re-erects the zombie group/mesh so it is ready to
 * chase again.  Called from startGame() and after each respawn.
 */
function _resetZombieVisuals() {
  if (zombieGroup) {
    zombieGroup.position.copy(zombiePos);
    zombieGroup.position.y = 0;
    zombieGroup.rotation.set(0, 0, 0);
    zombieGroup.visible = true;
  }
  // Re-erect inner mesh in case it was tipped during death animation
  if (zombieMesh) {
    zombieMesh.rotation.set(0, 0, 0);
  }
}

function resetSceneState() {
  gameActive = false;
  gameOver   = true;
  gamePaused = false;
}

// ═══════════════════════════════════════════════════════════════════
//  ENVIRONMENT
// ═══════════════════════════════════════════════════════════════════

function buildEnvironment() {
  const floorMat  = new THREE.MeshLambertMaterial({ map: getFloorTex()   });
  const wallMat   = new THREE.MeshLambertMaterial({ map: getWallTex()    });
  const ceilMat   = new THREE.MeshLambertMaterial({ map: getCeilingTex() });
  const groundMat = new THREE.MeshLambertMaterial({ map: getGroundTex()  });

  const W = 32, D = 32, H = 5;
  const hw = W / 2, hd = D / 2;

  // Outdoor ground
  const outdoorGround = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
  outdoorGround.rotation.x   = -Math.PI / 2;
  outdoorGround.receiveShadow = true;
  scene.add(outdoorGround);

  // Room floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
  floor.rotation.x   = -Math.PI / 2;
  floor.position.y   = 0.01;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  scene.add(ceil);

  // Walls
  function addWall(w, h, d, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    wallMeshes.push({ x, z, halfW: w / 2, halfD: d / 2 });
  }
  const t = 0.5;
  addWall(W, H, t,  0,    H/2, -hd);
  addWall(W, H, t,  0,    H/2,  hd);
  addWall(t, H, D, -hw,   H/2,   0);
  addWall(t, H, D,  hw,   H/2,   0);

  // Props / debris
  function addBox(w, h, d, x, z, col) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: col })
    );
    m.position.set(x, h / 2, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    wallMeshes.push({ x, z, halfW: w / 2, halfD: d / 2 });
  }

  [[-7,-7],[7,-7],[-7,7],[7,7]].forEach(([x,z]) => addBox(0.7, H, 0.7, x, z, 0x1a1a18));
  addBox(1.4, 0.9, 1.0,  -5,    4,   0x2a1800);
  addBox(0.9, 0.9, 0.9,  -5.6,  4.7, 0x221200);
  addBox(2.0, 0.5, 0.5,   9,   -8,   0x1a1a14);
  addBox(0.6, 1.6, 0.5,   9,   -7.2, 0x1a1a14);
  addBox(1.2, 0.4, 1.6,  -9,    8,   0x1e1200);
  addBox(0.5, 1.1, 0.5,   5,   -3,   0x191510);
  addBox(3.0, 0.35,0.5,  -3,  -10,   0x111110);

  // Blood decals on floor
  for (let i = 0; i < 8; i++) {
    const s = 0.5 + Math.random() * 1.8;
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(s, s * 0.65),
      new THREE.MeshBasicMaterial({ color: 0x3a0000, transparent: true, opacity: 0.55 + Math.random() * 0.3 })
    );
    decal.rotation.x = -Math.PI / 2;
    decal.position.set((Math.random()-0.5)*24, 0.02, (Math.random()-0.5)*24);
    scene.add(decal);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  LIGHTING
// ═══════════════════════════════════════════════════════════════════

function buildLights() {
  ambLight = new THREE.AmbientLight(0xffeedd, 1.2);
  scene.add(ambLight);

  sunLight = new THREE.DirectionalLight(0xfff5cc, 1.8);
  sunLight.position.set(20, 40, 15);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.near   = 0.5;
  sunLight.shadow.camera.far    = 120;
  sunLight.shadow.camera.left   = -30;
  sunLight.shadow.camera.right  =  30;
  sunLight.shadow.camera.top    =  30;
  sunLight.shadow.camera.bottom = -30;
  sunLight.shadow.bias = -0.002;
  scene.add(sunLight);

  const pPositions = [[-7,-7],[7,-7],[-7,7],[7,7],[0,0]];
  pPositions.forEach(([x, z]) => {
    const pl = new THREE.PointLight(0x442200, 0, 12, 2);
    pl.position.set(x, 4.6, z);
    scene.add(pl);
    flickerLights.push({ light: pl, base: 0, timer: Math.random() * Math.PI * 2 });

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 5, 5),
      new THREE.MeshBasicMaterial({ color: 0x886633 })
    );
    bulb.position.copy(pl.position);
    scene.add(bulb);

    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.009, 0.009, 0.3, 4),
      new THREE.MeshBasicMaterial({ color: 0x111 })
    );
    cord.position.set(x, 4.85, z);
    scene.add(cord);
  });

  // Player torch
  const torch = new THREE.SpotLight(0xffeecc, 0, 22, Math.PI / 8, 0.45, 1.2);
  torch.castShadow = false;
  const torchTarget = new THREE.Object3D();
  torchTarget.position.set(0, 0, -1);
  camera.add(torch);
  camera.add(torchTarget);
  torch.target = torchTarget;
  scene.add(camera);
}

// ═══════════════════════════════════════════════════════════════════
//  SKY
// ═══════════════════════════════════════════════════════════════════

function buildSky() {
  const skyGeo = new THREE.SphereGeometry(150, 16, 8);
  let skyMat;

  if (Assets.textures.sky) {
    const skyTex = Assets.textures.sky;
    skyTex.mapping = THREE.EquirectangularReflectionMapping;
    skyMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide });
    console.log('[Sky] Using loaded sky texture');
  } else {
    skyMat = new THREE.MeshBasicMaterial({ color: 0x87ceeb, side: THREE.BackSide });
    console.log('[Sky] Using procedural sky colour');
  }

  skyMesh = new THREE.Mesh(skyGeo, skyMat);
  scene.add(skyMesh);
}

// ═══════════════════════════════════════════════════════════════════
//  DAY / NIGHT
// ═══════════════════════════════════════════════════════════════════

const DAY_SKY      = new THREE.Color(0x87ceeb);
const SUNSET_SKY   = new THREE.Color(0xff6020);
const NIGHT_SKY    = new THREE.Color(0x02020a);
const DAY_FOG      = new THREE.Color(0xaad4f5);
const NIGHT_FOG    = new THREE.Color(0x020208);
const DAY_AMB_COL  = new THREE.Color(0xffeedd);
const NIGHT_AMB_COL= new THREE.Color(0x050515);

function setDayEnvironment(t) {
  // t = 1 → full day, 0 → full night
  const skyCol = t > 0.5
    ? DAY_SKY.clone().lerp(SUNSET_SKY, (1 - t) * 2)
    : SUNSET_SKY.clone().lerp(NIGHT_SKY, (0.5 - t) * 2);
  const fogCol = DAY_FOG.clone().lerp(NIGHT_FOG, 1 - t);

  // Only tint if using plain-colour sky (don't overwrite loaded texture)
  if (skyMesh && !skyMesh.material.map) {
    skyMesh.material.color.copy(skyCol);
  }
  scene.background = skyCol.clone();
  scene.fog = new THREE.FogExp2(fogCol.clone(), 0.018 + (1 - t) * 0.055);

  sunLight.intensity = t * 1.8;
  sunLight.color.set(t > 0.5 ? 0xfff5cc : 0xff8833);
  sunLight.position.set(20 * t, 40 * t + 2, 15 * t);

  ambLight.intensity = 0.15 + t * 1.1;
  ambLight.color.lerpColors(NIGHT_AMB_COL, DAY_AMB_COL, t);

  const nightBoost = 1 - t;
  flickerLights.forEach(f => { f.base = nightBoost * 0.85; });

  const torchChild = camera.children.find(c => c.isSpotLight);
  if (torchChild) torchChild.intensity = 0.6 + nightBoost * 1.4;

  nightVignette.style.opacity = (1 - t) * 0.8;

  if (zombieEyeL) {
    const col = nightBoost > 0.5 ? 0xff2200 : 0x550000;
    const emi = new THREE.Color(nightBoost > 0.5 ? 0xff0000 : 0x000000);
    zombieEyeL.material.color.set(col);
    zombieEyeL.material.emissive = emi;
    zombieEyeR.material.color.set(col);
    zombieEyeR.material.emissive = emi.clone();
  }

  const pct = isDay ? (cycleTimer / DAY_DURATION) : (cycleTimer / NIGHT_DURATION);
  timeBar.style.width = (pct * 100) + '%';
  if (isDay) {
    timeIcon.textContent  = t > 0.7 ? '☀' : '🌅';
    timeLabel.textContent = t > 0.7 ? 'DAYLIGHT' : 'DUSK';
    timeBar.style.background = t > 0.7
      ? 'linear-gradient(90deg,#ffb300,#ffe000)'
      : 'linear-gradient(90deg,#ff7700,#ff3300)';
  } else {
    timeIcon.textContent  = '🌙';
    timeLabel.textContent = 'NIGHTTIME';
    timeBar.style.background = 'linear-gradient(90deg,#1a004a,#5500cc)';
  }
}

// ═══════════════════════════════════════════════════════════════════
//
//  ███╗   ███╗ ██████╗ ██████╗ ███████╗██╗      ███████╗
//  ████╗ ████║██╔═══██╗██╔══██╗██╔════╝██║      ██╔════╝
//  ██╔████╔██║██║   ██║██║  ██║█████╗  ██║      ███████╗
//  ██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  ██║      ╚════██║
//  ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗███████╗ ███████║
//  ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝ ╚══════╝
//
// ═══════════════════════════════════════════════════════════════════

/**
 * spawnZombie()
 * ─────────────
 * [FIX-2] Two-layer structure:
 *   zombieGroup  (PIVOT — AI drives this)
 *     └─ zombieMesh  (GLB scene or procedural mesh)
 *
 * AI logic (position, lookAt, walk-bob) operates ONLY on zombieGroup.
 * The inner zombieMesh carries the visual orientation correction.
 */
function spawnZombie() {
  if (Assets.models.zombie) {
    _spawnZombieGLB(Assets.models.zombie);
  } else {
    _spawnZombieProc();
  }
}

// ── GLB path ─────────────────────────────────────────────────────

function _spawnZombieGLB(gltf) {
  console.log('[Zombie] Using loaded GLB model');

  zombieGroup = new THREE.Group();
  zombieGroup.position.copy(zombiePos);
  scene.add(zombieGroup);

  zombieMesh = gltf.scene.clone(true);

  // Auto-scale via bounding box (target ~2 world-units tall)
  const TARGET_HEIGHT = 2.0;
  const bbox = new THREE.Box3().setFromObject(zombieMesh);
  const modelHeight = bbox.max.y - bbox.min.y;
  const autoScale = modelHeight > 0 ? TARGET_HEIGHT / modelHeight : 0.01;
  zombieMesh.scale.setScalar(autoScale);
  console.log(`[Zombie] Auto-scale: ${autoScale.toFixed(4)} (model height was ${modelHeight.toFixed(3)})`);

  // Shift feet to y=0 on the pivot
  const bboxScaled = new THREE.Box3().setFromObject(zombieMesh);
  zombieMesh.position.y = -bboxScaled.min.y;

  // [FIX-2] Flip 180° on Y so the model faces the direction lookAt points
  zombieMesh.rotation.y = Math.PI;

  zombieMesh.traverse(child => {
    if (child.isMesh) {
      child.castShadow    = true;
      child.receiveShadow = true;
    }
  });

  zombieGroup.add(zombieMesh);

  // Invisible eye markers for night-glow references
  const eyeGeo  = new THREE.SphereGeometry(0.001, 4, 4);
  const eyeMatL = new THREE.MeshStandardMaterial({
    color: 0x550000, emissive: new THREE.Color(0x220000), visible: false,
  });
  const eyeMatR = eyeMatL.clone();
  zombieEyeL = new THREE.Mesh(eyeGeo, eyeMatL);
  zombieEyeR = new THREE.Mesh(eyeGeo, eyeMatR);
  zombieGroup.add(zombieEyeL, zombieEyeR);
}

// ── Procedural fallback path ──────────────────────────────────────

function _spawnZombieProc() {
  console.log('[Zombie] Using procedural fallback model');

  zombieGroup = new THREE.Group();
  zombieGroup.position.copy(zombiePos);
  scene.add(zombieGroup);

  zombieMesh = new THREE.Group();
  zombieGroup.add(zombieMesh);

  const skin   = new THREE.MeshLambertMaterial({ color: 0x4a6630 });
  const cloth  = new THREE.MeshLambertMaterial({ color: 0x2c1f0e });
  const dark   = new THREE.MeshLambertMaterial({ color: 0x1a1208 });
  const eyeM   = new THREE.MeshStandardMaterial({
    color: 0x550000, emissive: new THREE.Color(0x220000), roughness: 0.3, metalness: 0
  });
  const bloodM = new THREE.MeshBasicMaterial({ color: 0x550000, transparent: true, opacity: 0.8 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.95, 0.4), cloth);
  torso.position.y = 1.32; torso.castShadow = true; zombieMesh.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.4), skin);
  head.position.y = 2.1; head.castShadow = true; zombieMesh.add(head);

  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.12, 0.35), skin);
  jaw.position.set(0, 1.85, 0.04); zombieMesh.add(jaw);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.2, 6), skin);
  neck.position.y = 1.88; zombieMesh.add(neck);

  zombieEyeL = new THREE.Mesh(new THREE.SphereGeometry(0.065, 6, 6), eyeM.clone());
  zombieEyeR = new THREE.Mesh(new THREE.SphereGeometry(0.065, 6, 6), eyeM.clone());
  zombieEyeL.position.set(-0.1, 2.14, 0.2);
  zombieEyeR.position.set( 0.1, 2.14, 0.2);
  zombieMesh.add(zombieEyeL, zombieEyeR);

  [-1, 1].forEach(s => {
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.65, 0.22), cloth);
    upper.position.set(s * 0.52, 1.22, 0); upper.castShadow = true; zombieMesh.add(upper);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.55, 0.2), skin);
    lower.position.set(s * 0.52, 0.72, 0); lower.castShadow = true; zombieMesh.add(lower);
    const hand  = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.2), skin);
    hand.position.set(s * 0.52, 0.42, 0); zombieMesh.add(hand);
  });

  [-1, 1].forEach(s => {
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.6, 0.27), dark);
    thigh.position.set(s * 0.19, 0.6, 0); thigh.castShadow = true; zombieMesh.add(thigh);
    const shin  = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.55, 0.24), cloth);
    shin.position.set(s * 0.19, 0.12, 0); shin.castShadow = true; zombieMesh.add(shin);
    const foot  = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.14, 0.34), dark);
    foot.position.set(s * 0.19, -0.1, 0.07); zombieMesh.add(foot);
  });

  const bs = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.2), bloodM);
  bs.position.set(0.1, 1.48, 0.22); zombieMesh.add(bs);
}

// ═══════════════════════════════════════════════════════════════════
//
//   ██████╗ ██╗   ██╗███╗   ██╗
//  ██╔════╝ ██║   ██║████╗  ██║
//  ██║  ███╗██║   ██║██╔██╗ ██║
//  ██║   ██║██║   ██║██║╚██╗██║
//  ╚██████╔╝╚██████╔╝██║ ╚████║
//   ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝
//
// ═══════════════════════════════════════════════════════════════════

function buildGunModel() {
  if (Assets.models.gun) {
    _buildGunGLB(Assets.models.gun);
  } else {
    _buildGunProc();
  }
}

function _buildGunGLB(gltf) {
  console.log('[Gun] Using loaded GLB model');

  gunGroup = gltf.scene.clone(true);

  const TARGET_GUN_SIZE = 0.35;
  const gbox    = new THREE.Box3().setFromObject(gunGroup);
  const gsize   = gbox.getSize(new THREE.Vector3());
  const longest = Math.max(gsize.x, gsize.y, gsize.z);
  const gunScale = longest > 0 ? TARGET_GUN_SIZE / longest : 0.008;
  gunGroup.scale.setScalar(gunScale);
  console.log(`[Gun] Auto-scale: ${gunScale.toFixed(5)}`);

  gunGroup.position.set(0.2, -0.22, -0.4);
  gunGroup.rotation.set(0, Math.PI, 0);

  gunGroup.traverse(child => {
    if (child.isMesh) {
      child.castShadow    = false;
      child.receiveShadow = false;
    }
  });

  camera.add(gunGroup);
}

function _buildGunProc() {
  console.log('[Gun] Using procedural fallback model');

  gunGroup = new THREE.Group();

  const gunMat    = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4, metalness: 0.8 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.5 });
  const skinMat   = new THREE.MeshLambertMaterial({ color: 0x8b6040 });
  const cuffMat   = new THREE.MeshLambertMaterial({ color: 0x222233 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.1, 0.36), gunMat);
  gunGroup.add(body);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 8), accentMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.28);
  gunGroup.add(barrel);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.14, 0.075), gunMat);
  grip.position.set(0, -0.11, 0.08);
  grip.rotation.x = 0.22;
  gunGroup.add(grip);

  const tg = new THREE.Mesh(new THREE.TorusGeometry(0.027, 0.006, 4, 8, Math.PI), accentMat);
  tg.position.set(0, -0.03, 0.04);
  tg.rotation.y = Math.PI / 2;
  gunGroup.add(tg);

  const sf = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.028, 0.008), accentMat);
  sf.position.set(0, 0.068, -0.14);
  gunGroup.add(sf);

  const sr = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.006), accentMat);
  sr.position.set(0, 0.065, 0.06);
  gunGroup.add(sr);

  [-0.1, 0.1].forEach(x => {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.38, 6), skinMat);
    arm.rotation.x = Math.PI / 2 - 0.18;
    arm.position.set(x, -0.18, 0.1);
    gunGroup.add(arm);

    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.06, 6), cuffMat);
    cuff.rotation.x = Math.PI / 2 - 0.18;
    cuff.position.set(x, -0.3, 0.2);
    gunGroup.add(cuff);
  });

  gunGroup.position.set(0.2, -0.22, -0.4);
  camera.add(gunGroup);
}

// ── Gun animation (recoil + sway) ────────────────────────────────

function animateGun(dt) {
  gunBobTimer += dt;

  if (gunRecoil > 0) {
    gunRecoil -= dt * 7;
    gunGroup.position.z = -0.4 + Math.max(0, gunRecoil) * 0.09;
    gunGroup.rotation.x =        Math.max(0, gunRecoil) * 0.28;
  } else {
    gunRecoil = 0;
    gunGroup.position.z = -0.4;
    gunGroup.rotation.x = 0;
  }

  const moving = keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD'];
  const sway   = moving ? 0.012 : 0.003;
  const freq   = moving ? 8     : 1.2;
  gunGroup.position.y = -0.22 + Math.sin(gunBobTimer * freq)       * sway;
  gunGroup.position.x =  0.2  + Math.cos(gunBobTimer * freq * 0.5) * sway * 0.5;
}

// ═══════════════════════════════════════════════════════════════════
//  SHOOTING
// ═══════════════════════════════════════════════════════════════════

function tryShoot() {
  if (!canShoot) return;
  if (ammo <= 0) { playDryClick(); showMsg('OUT OF AMMO — Press R', 2.5); return; }

  ammo--;
  shotsFired++;
  canShoot   = false;
  shootTimer = SHOOT_COOLDOWN;
  gunRecoil  = 1;

  triggerMuzzleFlash();
  triggerShootFlash();
  _unlockAudio();
  playGunshot();

  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const bul = {
    pos:   camera.position.clone().addScaledVector(dir, 0.5),
    dir,
    dist:  0,
    alive: true,
    mesh:  _makeBulletMesh(),
  };
  scene.add(bul.mesh);
  bullets.push(bul);

  updateHUD();
  if (ammo === 0)      reloadHint.style.display = 'block';
  else if (ammo <= 3)  ammoCur.classList.add('ammo-warn');
}

function _makeBulletMesh() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 4, 4),
    new THREE.MeshBasicMaterial({ color: 0xffdd66 })
  );
}

function doReload() {
  if (ammo === AMMO_MAX) return;
  playReload();
  showMsg('RELOADING…', 1.2);
  canShoot = false;
  setTimeout(() => {
    ammo     = AMMO_MAX;
    canShoot = true;
    ammoCur.classList.remove('ammo-warn');
    reloadHint.style.display = 'none';
    updateHUD();
    showMsg('', 0);
  }, 1200);
}

// ─────────────────────────────────────────────────────────────────
//  [COMBAT-1] BULLET UPDATE & HIT DETECTION
//  ────────────────────────────────────────────────────────────────
//  Hit detection uses a two-stage test:
//    1. Horizontal distance from bullet to zombieGroup.position on
//       the XZ plane must be < ZOMBIE_HIT_RADIUS.  Using just the
//       pivot (not a mesh bounding box) gives reliable detection for
//       both GLB and procedural models regardless of their geometry.
//    2. Vertical distance (bullet.pos.y - zombieGroup.position.y)
//       must be < ZOMBIE_HIT_HEIGHT.  This prevents bullets fired
//       high overhead from registering as hits on a ground zombie.
//
//  On a confirmed hit:
//    • The bullet is removed from the array immediately (b.alive=false).
//    • zombieHealth is reduced, clamped to 0.
//    • A blood-particle burst is spawned at the hit position.
//    • The zombie health bar is updated.
//    • A growl is played.
//    • If health == 0, killZombie() is called.
// ─────────────────────────────────────────────────────────────────

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];

    // Clean up dead bullets immediately
    if (!b.alive) {
      scene.remove(b.mesh);
      bullets.splice(i, 1);
      continue;
    }

    // Advance bullet position
    b.pos.addScaledVector(b.dir, BULLET_SPEED * dt);
    b.mesh.position.copy(b.pos);
    b.dist += BULLET_SPEED * dt;

    // Max range cull
    if (b.dist > 80) {
      b.alive = false;
      continue;
    }

    // ── [COMBAT-1] Hit test (only while zombie is alive & not respawning)
    if (zombieAlive && !isRespawning) {
      const zp = zombieGroup.position;

      // XZ plane distance (avoids false hits from bullets flying over the zombie)
      const dx   = b.pos.x - zp.x;
      const dz   = b.pos.z - zp.z;
      const hDist = Math.sqrt(dx * dx + dz * dz);

      // Vertical distance from bullet to zombie's base
      const vDist = Math.abs(b.pos.y - zp.y);

      if (hDist < ZOMBIE_HIT_RADIUS && vDist < ZOMBIE_HIT_HEIGHT) {
        // ── Confirmed hit ──────────────────────────────────────────
        b.alive = false;
        shotsHit++;

        // [COMBAT-2] Spawn enhanced blood particles at the exact hit point
        spawnBloodParticles(b.pos.clone());

        // Small screen flash to confirm the hit for the player
        triggerHitConfirmFlash();

        // Reduce health, clamped to 0
        zombieHealth = Math.max(0, zombieHealth - BULLET_DAMAGE);

        // Update HUD health bar
        updateZombieBar();

        // Zombie reacts with a growl
        playZombieGrowl();

        console.log(`[Combat] Hit! Zombie health: ${zombieHealth}`);

        if (zombieHealth <= 0) {
          killZombie();
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  [COMBAT-2]  BLOOD PARTICLE SYSTEM
//  ─────────────────────────────────────────────────────────────────
//  Improved over the original 10-particle burst with:
//  • 20 total particles split into two layers:
//      Layer A (fast spray) — 12 particles, high initial velocity,
//        short life, additive blending for a bright gory spatter.
//      Layer B (drip layer) — 8 particles, slower, longer life,
//        fall more steeply under gravity to simulate dripping blood.
//  • Per-particle random colour in the 0x550000–0xcc0000 range.
//  • Particle cap (MAX_PARTICLES) ensures no runaway allocation.
// ═══════════════════════════════════════════════════════════════════

function spawnBloodParticles(pos) {
  // [FIX-5] Respect the global particle cap
  if (particles.length >= MAX_PARTICLES) return;

  const available = MAX_PARTICLES - particles.length;

  // ── Layer A: fast outward spray ───────────────────────────────
  const sprayCount = Math.min(12, available);
  for (let i = 0; i < sprayCount; i++) {
    // Random dark-red hue for variety
    const r  = 0x55 + Math.floor(Math.random() * 0x77);
    const col = (r << 16);   // green/blue stay 0 — stays in red range

    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.02 + Math.random() * 0.04, 4, 4),
      new THREE.MeshBasicMaterial({
        color:       col,
        transparent: true,
        opacity:     1,
        blending:    THREE.AdditiveBlending,   // bright pop at impact
        depthWrite:  false,
      })
    );
    m.position.copy(pos);
    scene.add(m);

    // High-velocity outward burst
    const angle  = Math.random() * Math.PI * 2;
    const speed  = 3 + Math.random() * 6;
    particles.push({
      mesh:     m,
      vel:      new THREE.Vector3(
                  Math.cos(angle) * speed,
                  1.5 + Math.random() * 4,
                  Math.sin(angle) * speed
                ),
      life:     0.25 + Math.random() * 0.25,
      maxLife:  0.25 + Math.random() * 0.25,  // stored for opacity curve
      gravMult: 0.5,    // lighter gravity — spray stays airborne
    });
  }

  // ── Layer B: slow drip / fall ─────────────────────────────────
  const dropCount = Math.min(8, MAX_PARTICLES - particles.length);
  for (let i = 0; i < dropCount; i++) {
    const r   = 0x33 + Math.floor(Math.random() * 0x44);
    const col = (r << 16);

    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.03 + Math.random() * 0.05, 4, 4),
      new THREE.MeshBasicMaterial({
        color:       col,
        transparent: true,
        opacity:     0.9,
        depthWrite:  false,
      })
    );
    m.position.copy(pos);
    scene.add(m);

    const angle = Math.random() * Math.PI * 2;
    const speed = 0.5 + Math.random() * 2;
    particles.push({
      mesh:     m,
      vel:      new THREE.Vector3(
                  Math.cos(angle) * speed,
                  0.5 + Math.random() * 1.5,
                  Math.sin(angle) * speed
                ),
      life:     0.5 + Math.random() * 0.5,
      maxLife:  0.5 + Math.random() * 0.5,
      gravMult: 1.2,    // falls faster — simulates heavier blood drops
    });
  }
}

// ─────────────────────────────────────────────────────────────────
//  Particle update — handles both blood particle layers.
//  [FIX-5] Particles are removed from the END of the array using a
//  reverse loop so splicing doesn't corrupt iteration.
// ─────────────────────────────────────────────────────────────────

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;

    if (p.life <= 0) {
      scene.remove(p.mesh);
      // Dispose geometry and material to free GPU memory
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      particles.splice(i, 1);
      continue;
    }

    // Gravity (per-particle multiplier for spray vs drip feel)
    p.vel.y += GRAVITY * dt * (p.gravMult || 0.35);

    // Move
    p.mesh.position.addScaledVector(p.vel, dt);

    // Fade out smoothly using remaining life fraction
    const lifeFraction = p.life / (p.maxLife || 0.5);
    p.mesh.material.opacity = Math.max(0, lifeFraction);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ZOMBIE AI
// ═══════════════════════════════════════════════════════════════════

function updateZombie(dt) {
  // [COMBAT-3] Handle respawn countdown when zombie is dead
  if (!zombieAlive) {
    if (isRespawning) {
      zombieRespawnTimer -= dt;
      if (zombieRespawnTimer <= 0) {
        _doRespawnZombie();
      }
    }
    return;
  }

  zombieWalkTimer += dt;
  growlTimer      += dt;

  // [FIX-2] All positional reads/writes go through zombieGroup (pivot)
  const zp   = zombieGroup.position;
  const pp   = camera.position;

  const dir  = new THREE.Vector3(pp.x - zp.x, 0, pp.z - zp.z);
  const dist = dir.length();
  dir.normalize();

  // Speed scaling with day/night AND difficulty ramp
  const nightT      = isDay ? 0 : Math.min(1, cycleTimer / NIGHT_DURATION);
  const baseSpeed   = ZOMBIE_DAY.speed + (ZOMBIE_NIGHT.speed - ZOMBIE_DAY.speed) * nightT;
  const spd         = baseSpeed + difficultyLevel * DIFFICULTY_SPEED_INC;

  if (dist > 0.9) {
    zp.x += dir.x * spd * dt;
    zp.z += dir.z * spd * dt;
  }

  // Keep pivot Y at 0 during normal movement
  zp.y = 0;

  // [FIX-2] lookAt on PIVOT — inner mesh has 180° Y baked in
  zombieGroup.lookAt(new THREE.Vector3(pp.x, 0, pp.z));

  // Walk bob
  const walkFreq = 4 + nightT * 3;
  zombieGroup.position.y = Math.abs(Math.sin(zombieWalkTimer * walkFreq)) * 0.07;

  // Random growl when player is in range
  if (growlTimer > 3.5 + Math.random() * 4 && dist < 20) {
    growlTimer = 0;
    playZombieGrowl();
  }

  // Attack
  zombieAttackTimer += dt;
  if (dist < ZOMBIE_ATTACK_RANGE && zombieAttackTimer >= ZOMBIE_ATTACK_INTERVAL) {
    zombieAttackTimer = 0;
    const baseDmg = ZOMBIE_DAY.damage + (ZOMBIE_NIGHT.damage - ZOMBIE_DAY.damage) * nightT;
    const scaledDmg = baseDmg + difficultyLevel * DIFFICULTY_DAMAGE_INC;
    attackPlayer(isBlocking ? Math.floor(scaledDmg * 0.15) : scaledDmg);
  }
}

function attackPlayer(dmg) {
  playerHealth = Math.max(0, playerHealth - dmg);
  damageTaken += dmg;
  triggerHitFlash();
  playPlayerHurt();
  updateHUD();
  if (playerHealth <= 0) endGame(false);
}

// ─────────────────────────────────────────────────────────────────
//  [COMBAT-1] / [FIX-4]  killZombie
//  ─────────────────────────────────────────────────────────────────
//  • Sets zombieAlive = false FIRST (stops AI + bullet hit tests).
//  • Tips the inner zombieMesh for the death pose visual.
//  • Schedules the respawn timer.
//  • Increments kill counter and difficulty.
//  • Does NOT call endGame() — respawn keeps the game going.
// ─────────────────────────────────────────────────────────────────

function killZombie() {
  // Stop AI and bullet collision immediately
  zombieAlive = false;

  // Visual death tip on the inner mesh (not the pivot)
  if (zombieMesh) {
    zombieMesh.rotation.z = Math.PI / 2;
  }
  // Lift pivot slightly so tipped model doesn't clip floor
  if (zombieGroup) {
    zombieGroup.position.y = 0.3;
  }

  // Update kill count and difficulty
  zombiesKilled++;
  difficultyLevel++;
  _updateKillCounter();

  // Show a kill confirmation message
  showMsg(`☠ KILL #${zombiesKilled}  — Difficulty +1`, 2.5);

  // [COMBAT-3] Spawn a big death blood burst at the zombie's position
  spawnDeathBloodBurst(zombieGroup.position.clone());

  // [COMBAT-3] Schedule respawn after 3–5 seconds
  const delay = ZOMBIE_RESPAWN_MIN + Math.random() * (ZOMBIE_RESPAWN_MAX - ZOMBIE_RESPAWN_MIN);
  zombieRespawnTimer = delay;
  isRespawning       = true;

  console.log(`[Zombie] Killed (kill #${zombiesKilled}). Respawning in ${delay.toFixed(1)}s`);
}

// ─────────────────────────────────────────────────────────────────
//  [COMBAT-3]  RESPAWN LOGIC
//  ─────────────────────────────────────────────────────────────────
//  Picks a random position within ZOMBIE_SPAWN_BOUND on the XZ plane
//  that is at least ZOMBIE_SPAWN_SAFE_DIST away from the player, then
//  resets all zombie state and restarts the chase.
// ─────────────────────────────────────────────────────────────────

function _doRespawnZombie() {
  isRespawning = false;

  // Pick a safe spawn point
  const spawnPos = _pickZombieSpawnPoint();
  zombiePos.copy(spawnPos);

  // Reset health — scales with difficulty
  zombieHealth = ZOMBIE_HEALTH_MAX + difficultyLevel * DIFFICULTY_HEALTH_INC;

  // Reset timers
  zombieWalkTimer   = 0;
  growlTimer        = 0;
  zombieAttackTimer = 0;

  // Re-erect and reposition the existing zombie group
  _resetZombieVisuals();

  // Mark alive again
  zombieAlive = true;

  // Update HUD bar to full for new zombie
  updateZombieBar();

  showMsg('NEW ZOMBIE INCOMING!', 2.5);
  playZombieGrowl();

  console.log(`[Zombie] Respawned at (${spawnPos.x.toFixed(1)}, ${spawnPos.z.toFixed(1)}). Health: ${zombieHealth}`);
}

/**
 * _pickZombieSpawnPoint()
 * ────────────────────────
 * Returns a THREE.Vector3 on the ground plane that is:
 *   • Inside [-ZOMBIE_SPAWN_BOUND, +ZOMBIE_SPAWN_BOUND] on X and Z
 *   • At least ZOMBIE_SPAWN_SAFE_DIST away from the player
 * Falls back to a default position if 20 random attempts all fail.
 */
function _pickZombieSpawnPoint() {
  const pp = camera.position;

  for (let attempt = 0; attempt < 20; attempt++) {
    const x = (Math.random() * 2 - 1) * ZOMBIE_SPAWN_BOUND;
    const z = (Math.random() * 2 - 1) * ZOMBIE_SPAWN_BOUND;
    const dx = x - pp.x;
    const dz = z - pp.z;

    if (Math.sqrt(dx * dx + dz * dz) >= ZOMBIE_SPAWN_SAFE_DIST) {
      return new THREE.Vector3(x, 0, z);
    }
  }

  // Fallback: spawn directly opposite the player at max bound
  const angle = Math.atan2(pp.z, pp.x) + Math.PI;
  return new THREE.Vector3(
    Math.cos(angle) * ZOMBIE_SPAWN_BOUND * 0.9,
    0,
    Math.sin(angle) * ZOMBIE_SPAWN_BOUND * 0.9
  );
}

/**
 * spawnDeathBloodBurst()
 * ───────────────────────
 * [COMBAT-3] Large burst of blood particles when a zombie dies —
 * more particles and wider spread than a regular hit burst.
 */
function spawnDeathBloodBurst(pos) {
  if (particles.length >= MAX_PARTICLES) return;

  const count = Math.min(30, MAX_PARTICLES - particles.length);
  for (let i = 0; i < count; i++) {
    const r   = 0x44 + Math.floor(Math.random() * 0x88);
    const col = (r << 16);

    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.04 + Math.random() * 0.08, 4, 4),
      new THREE.MeshBasicMaterial({
        color:       col,
        transparent: true,
        opacity:     1,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
      })
    );
    // Raise spawn point to roughly torso height
    const spawnPos = pos.clone();
    spawnPos.y += 0.8 + Math.random() * 0.8;
    m.position.copy(spawnPos);
    scene.add(m);

    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 7;
    const life  = 0.4 + Math.random() * 0.6;
    particles.push({
      mesh:     m,
      vel:      new THREE.Vector3(
                  Math.cos(angle) * speed,
                  0.5 + Math.random() * 5,
                  Math.sin(angle) * speed
                ),
      life:     life,
      maxLife:  life,
      gravMult: 0.8,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PLAYER MOVEMENT
// ═══════════════════════════════════════════════════════════════════

function updatePlayer(dt) {
  if (gamePaused) return;

  const euler   = new THREE.Euler(0, yaw, 0, 'YXZ');
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(euler);
  const right   = new THREE.Vector3(1, 0,  0).applyEuler(euler);

  let moved = false;
  if (keys['KeyW']) { camera.position.addScaledVector(forward,  PLAYER_SPEED * dt); moved = true; }
  if (keys['KeyS']) { camera.position.addScaledVector(forward, -PLAYER_SPEED * dt); moved = true; }
  if (keys['KeyA']) { camera.position.addScaledVector(right,   -PLAYER_SPEED * dt); moved = true; }
  if (keys['KeyD']) { camera.position.addScaledVector(right,    PLAYER_SPEED * dt); moved = true; }

  velocityY         += GRAVITY * dt;
  camera.position.y += velocityY * dt;
  if (camera.position.y <= 1.65) {
    camera.position.y = 1.65;
    velocityY  = 0;
    isOnGround = true;
  }

  const B = 15;
  camera.position.x = Math.max(-B, Math.min(B, camera.position.x));
  camera.position.z = Math.max(-B, Math.min(B, camera.position.z));

  camera.rotation.order = 'YXZ';
  camera.rotation.y     = yaw;
  camera.rotation.x     = pitch;

  if (moved && isOnGround) {
    camera.position.y = 1.65 + Math.sin(clock.elapsedTime * 9) * 0.02;
  }

  wallMeshes.forEach(w => {
    const dx = camera.position.x - w.x;
    const dz = camera.position.z - w.z;
    const ox = w.halfW + 0.45;
    const oz = w.halfD + 0.45;
    if (Math.abs(dx) < ox && Math.abs(dz) < oz) {
      const ovX = ox - Math.abs(dx);
      const ovZ = oz - Math.abs(dz);
      if (ovX < ovZ) camera.position.x += Math.sign(dx) * ovX;
      else           camera.position.z += Math.sign(dz) * ovZ;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  DAY / NIGHT CYCLE
// ═══════════════════════════════════════════════════════════════════

function updateDayNight(dt) {
  if (!gameActive || gamePaused) return;

  surviveTime += dt;
  cycleTimer  += dt;

  const duration = isDay ? DAY_DURATION : NIGHT_DURATION;
  setDayEnvironment(isDay ? Math.max(0, 1 - cycleTimer / duration * 0.98) : 0);

  if (cycleTimer >= duration) {
    cycleTimer = 0;
    isDay      = !isDay;
    showPhaseBanner(isDay ? '☀ DAWN' : '🌙 NIGHTFALL');
    if (!isDay) { showMsg('ZOMBIES GROW STRONGER!', 3); playZombieGrowl(); }
  }
}

let phaseBannerTO;
function showPhaseBanner(text) {
  phaseBanner.textContent      = text;
  phaseBanner.style.color      = isDay ? '#ffe066' : '#8866ff';
  phaseBanner.style.textShadow = `0 0 30px ${isDay ? '#ffa000' : '#6600ff'}`;
  phaseBanner.style.opacity    = '1';
  clearTimeout(phaseBannerTO);
  phaseBannerTO = setTimeout(() => { phaseBanner.style.opacity = '0'; }, 3500);
}

// ═══════════════════════════════════════════════════════════════════
//  FLICKER
// ═══════════════════════════════════════════════════════════════════

function updateFlicker(dt) {
  flickerLights.forEach(f => {
    f.timer += dt;
    f.light.intensity = Math.max(0,
      f.base
      + Math.sin(f.timer * 22) * 0.10
      + Math.sin(f.timer *  7) * 0.08
    );
  });
}

// ═══════════════════════════════════════════════════════════════════
//  HUD
// ═══════════════════════════════════════════════════════════════════

function updateHUD() {
  const hp = (playerHealth / PLAYER_HEALTH_MAX) * 100;
  healthBar.style.width      = hp + '%';
  healthVal.textContent      = Math.max(0, playerHealth);
  healthBar.style.background = hp > 60
    ? 'linear-gradient(90deg,#1a8c3c,#2ecc71)'
    : hp > 30
    ? 'linear-gradient(90deg,#c47000,#f39c12)'
    : 'linear-gradient(90deg,#7b0000,#c0392b)';
  ammoCur.textContent = ammo;
}

function updateZombieBar() {
  // Health can exceed ZOMBIE_HEALTH_MAX due to difficulty scaling, so
  // track the current maximum (ZOMBIE_HEALTH_MAX + kills × inc)
  const maxHp = ZOMBIE_HEALTH_MAX + difficultyLevel * DIFFICULTY_HEALTH_INC;
  zombieBar.style.width = Math.max(0, (zombieHealth / maxHp) * 100) + '%';
}

/**
 * [COMBAT-4] _updateKillCounter
 * Writes the zombiesKilled count into the DOM.  If the element
 * doesn't exist in the HTML it creates it on first call.
 */
function _updateKillCounter() {
  let el = $('kill-counter');
  if (!el) {
    // Create the kill-counter element dynamically so the existing
    // HTML doesn't need to be changed.
    el = document.createElement('div');
    el.id = 'kill-counter';
    Object.assign(el.style, {
      position:   'absolute',
      top:        '16px',
      left:       '16px',
      fontFamily: 'Share Tech Mono, monospace',
      fontSize:   '0.65rem',
      letterSpacing: '0.2em',
      color:      '#c0392b',
      textShadow: '0 0 10px rgba(192,57,43,0.7)',
    });
    hud.appendChild(el);
  }
  el.textContent = `☠ KILLS: ${zombiesKilled}  |  DIFFICULTY: ${difficultyLevel}`;
}

let msgTO;
function showMsg(text, dur = 2) {
  gameMsg.textContent      = text;
  gameMsg.style.opacity    = text ? '1' : '0';
  clearTimeout(msgTO);
  if (text && dur > 0) msgTO = setTimeout(() => { gameMsg.style.opacity = '0'; }, dur * 1000);
}

function triggerHitFlash() {
  hitFlash.style.opacity = '1';
  setTimeout(() => { hitFlash.style.opacity = '0'; }, 130);
}

/**
 * [COMBAT-1] triggerHitConfirmFlash
 * A brief, subtle white flash that confirms a bullet hit on the zombie.
 * Distinct from triggerHitFlash() which shows the player was hurt.
 */
function triggerHitConfirmFlash() {
  shootFlash.style.opacity = '0.15';
  setTimeout(() => { shootFlash.style.opacity = '0'; }, 40);
}

function triggerShootFlash()  { shootFlash.style.opacity  = '1'; setTimeout(() => { shootFlash.style.opacity  = '0'; },  55); }
function triggerMuzzleFlash() { muzzleFlash.style.opacity = '1'; setTimeout(() => { muzzleFlash.style.opacity = '0'; },  55); }

// ═══════════════════════════════════════════════════════════════════
//  SHOOT COOLDOWN
// ═══════════════════════════════════════════════════════════════════

function updateShootCooldown(dt) {
  if (!canShoot) { shootTimer -= dt; if (shootTimer <= 0) canShoot = true; }
}

// ═══════════════════════════════════════════════════════════════════
//  FPS COUNTER
// ═══════════════════════════════════════════════════════════════════

function updateFPS(dt) {
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    const fps  = Math.round(fpsFrames / fpsTime);
    fpsFrames  = 0;
    fpsTime    = 0;
    if (Settings.showFPS) fpsCounter.textContent = fps + ' FPS';
  }
}

// ═══════════════════════════════════════════════════════════════════
//  GAME END
// ═══════════════════════════════════════════════════════════════════

function endGame(won) {
  gameActive = false;
  gameOver   = true;
  document.exitPointerLock();

  const accuracy = shotsFired > 0 ? Math.round((shotsHit / shotsFired) * 100) : 0;
  const mins = Math.floor(surviveTime / 60);
  const secs = Math.floor(surviveTime % 60);

  $('end-icon').textContent  = won ? '🏆' : '☠';
  $('end-title').textContent = won ? 'YOU SURVIVED' : 'YOU DIED';
  $('end-title').style.color = won ? '#39ff14'      : '#c0392b';
  $('end-msg').textContent   = won
    ? 'The undead have fallen. You live another day.'
    : 'The zombie got you. Better luck next time.';
  $('end-stats').innerHTML = `
    <b>Survived:</b> ${mins}m ${secs}s &nbsp;|&nbsp;
    <b>Kills:</b> ${zombiesKilled} &nbsp;|&nbsp;
    <b>Shots:</b> ${shotsFired} &nbsp;|&nbsp;
    <b>Accuracy:</b> ${accuracy}% &nbsp;|&nbsp;
    <b>Damage taken:</b> ${damageTaken}
  `;

  setTimeout(() => {
    hud.style.display       = 'none';
    endScreen.style.display = 'flex';
  }, won ? 2200 : 1000);
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN LOOP
// ═══════════════════════════════════════════════════════════════════

function gameLoop() {
  requestAnimationFrame(gameLoop);
  const dt = Math.min(clock.getDelta(), 0.05);

  updateFPS(dt);

  if (!gameActive || gamePaused || gameOver) {
    renderer.render(scene, camera);
    return;
  }

  updatePlayer(dt);
  updateZombie(dt);        // also handles respawn countdown
  updateBullets(dt);       // [COMBAT-1] improved hit detection
  updateParticles(dt);     // [COMBAT-2] improved blood effects
  updateShootCooldown(dt);
  updateFlicker(dt);
  updateDayNight(dt);
  animateGun(dt);

  renderer.render(scene, camera);
}
