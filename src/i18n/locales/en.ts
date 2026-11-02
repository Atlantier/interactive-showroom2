/**
 * English dictionary — the source of truth for every string in the showroom.
 *
 * This file is the schema. `zh.ts` is typed as `typeof en`, so a missing or
 * misspelled key in the Chinese dictionary is a compile error rather than a
 * silent fallback at runtime.
 *
 * Copy rules for this file:
 * - Launch-keynote register: Telemetry, Verlet Integration, Inverse Kinematics,
 *   Anisotropic Glow, Overclock. Precise engineering nouns, never filler.
 * - Sentence case for prose, uppercase tracking is a CSS concern and stays out.
 * - No trailing periods on labels, badges or single-line status text.
 */
export const en = {
  /** Document-level strings, written into <title> and the meta description. */
  meta: {
    title: 'Digital Showroom — Real-time Graphics Engineering',
    description:
      'An immersive personal showroom built with React 19, Three.js and Lenis: scroll-driven camera choreography, real-time GPU particles and physics sandboxes.',
  },

  /** Top navigation, including every control's accessible label. */
  nav: {
    brand: 'SHOWROOM',
    brandSub: 'Digital · v0.1',
    homeAria: 'Back to the showroom entrance',
    sectionsAria: 'Chapters',
    primarySectionsAria: 'Primary chapters',
    mobileMenuAria: 'Chapter navigation',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    fallbackSection: 'Gallery',

    fpsMonitorOn: 'Hide the FPS monitor',
    fpsMonitorOff: 'Show the FPS monitor',
    perfHudOpen: 'Open the performance telemetry panel (Shift+D)',
    perfHudClose: 'Close the performance telemetry panel (Shift+D)',
    commandPaletteOpen: 'Open the command palette (Ctrl/⌘ + K)',
    paletteCycle: 'Cycle the Visual Overdrive palette',
    soundMute: 'Mute sound',
    soundUnmute: 'Unmute sound',
    tierCycle: 'Cycle the render tier',
    tierLabel: 'Tier',

    fps: 'fps',
    frame: 'frame',
    worst: 'worst',
    viewport: 'viewport',
    skipToContent: 'Skip to content',
    backToTop: 'Back to top',
    scrollProgressTitle: 'Scroll progress · click to return to the top',
    audioSpectrumTitle: 'Live audio spectrum',
    languageAria: 'Switch language',
    languageEnglish: 'EN',
    languageChinese: '中文',
  },

  /** Chapter shells: eyebrow, title and description for every section. */
  sections: {
    hero: {
      index: '01',
      eyebrow: 'entrance',
      title: 'Entrance',
      description:
        'A showroom that loads like a machine coming online: one clock drives the page, the camera and the GPU.',
    },
    gallery: {
      index: '02',
      eyebrow: 'gallery',
      title: 'Gallery',
      description:
        'Every exhibit is a real-time instrument you can scroll and point at — not a screenshot.',
    },
    architecture: {
      index: '03',
      eyebrow: 'architecture',
      title: 'Architecture',
      description:
        'Three tightly interlocked layers: silicon, orchestration and the spatial interface.',
    },
    playground: {
      index: '04',
      eyebrow: 'playground',
      title: 'Playground',
      description:
        'Hand-written solvers: Verlet-integrated lanyards, plus a mechanical creature driven by FABRIK inverse kinematics.',
    },
    archive: {
      index: '05',
      eyebrow: 'archive',
      title: 'Archive',
      description: 'An index of past work, ordered by time.',
    },
    contact: {
      index: '06',
      eyebrow: 'contact',
      title: 'Contact',
      description:
        'If you are building an immersive digital space of your own, let us compare notes.',
    },
  },

  /** First screen. */
  hero: {
    statusOnline: 'system online',
    stackStack: 'webgl · lenis · r3f',
    titleLead: 'Personal',
    titleMain: 'Digital Showroom',
    body: 'An immersive space assembled from WebGL, inertial scrolling and real-time state orchestration.',
    bodyAccent: 'Here, scrolling is camera motion.',
    ctaEnter: 'Enter the gallery',
    ctaArchive: 'Browse the archive',
    scrollHint: 'scroll',
    fpsBadge: 'fps',
    particlesBadge: 'particles',
  },

  /** Five-card works matrix. */
  bento: {
    cardThroughputLabel: 'Live inference',
    cardThroughputTitle: 'Inference throughput',
    cardThroughputNote: 'A live token-throughput chart, redrawn straight to canvas',
    cardThroughputBody:
      'Real-time throughput across the edge inference cluster, sampled every 120ms and drawn directly to a canvas.',
    topologyHint: 'Tap a node',
    topologyAria: 'Architecture topology diagram. Select a node to inspect its responsibility.',
    topologyRoles: {
      edge: 'Global ingress · edge caching',
      gateway: 'Request gateway · auth and rate limiting',
      router: 'Semantic routing · model selection',
      worker: 'Inference workers · batch scheduling',
      cache: 'Semantic cache · answer on hit',
      store: 'Persistence · vectors and logs',
    },
    cardTopologyTitle: 'Distributed topology',
    cardTopologyNote: 'Click a node to inspect its responsibility',
    cardTerminalTitle: 'One-command deploy',
    cardTerminalNote: 'A terminal emulator with a working keyboard',
    cardRenderTitle: 'Render pipeline',
    cardRenderNote: '8000 particles in a single draw call',
    cardUptimeTitle: 'Service health',
    cardUptimeNote: 'Availability over the past 14 days',
    cardTopologyLabel: 'Topology',
    cardTerminalLabel: 'Deploy',
    cardRenderLabel: 'Rendering',
    cardUptimeLabel: 'Uptime',
    copyCode: 'Copy code',
    copied: 'Copied to clipboard',
    copyFailed: 'Clipboard unavailable',
    inspectArchitecture: 'Inspect architecture',
    drawCalls: 'draw calls',
    particles: 'particles',
    frame: 'frame',
    terminalAria: 'Terminal command input. Available commands: help, skills, matrix, clear',
    terminalInputHint: 'type help / skills / matrix / clear',
    terminalUnknownHint: '  try: help',
    terminalHelp: {
      help: 'help    — show this help',
      skills: 'skills  — list the skills matrix',
      matrix: 'matrix  — enter the matrix view',
      clear: 'clear   — clear the terminal',
    },
    terminalPrompt: '$',
    terminalHint: 'type "help" to explore',
    terminalOnline: 'live at showroom.edge',
  },

  /** Scroll-driven 3D deconstruction chapter. */
  architecture: {
    eyebrow: 'architecture',
    headingLead: 'Full-stack AI and',
    headingAccent: 'distributed compute',
    headingTail: 'cores',
    subtitleIdle: 'Three layers, tightly interlocked · in constant rotation',
    subtitleExplode: 'Layered separation · data flows through',
    subtitleFinal: 'Structural reconfiguration · metrics surface',
    metrics: {
      throughputLabel: 'Per-node inference throughput',
      throughputNote: '3.2× over the previous generation',
      availabilityLabel: 'Cluster availability',
      availabilityNote: 'Across 6 regional hot swaps',
      latencyLabel: 'End-to-end latency',
      latencyNote: 'Network and queueing included',
      agentsLabel: 'Concurrent agents',
      agentsNote: 'Single orchestration layer',
    },
    layers: {
      infra: {
        summary: 'A dense compute mesh that squeezes every watt into every token.',
        details: [
          'Custom fused attention / RMSNorm kernels',
          'FP8 / INT4 quantisation · dynamic batching',
          'Cross-node all-reduce · 800 Gbps RDMA',
          '900 GB/s direct GPU interconnect',
          'HBM3e · 192 GB per card',
        ],
      },
      agents: {
        summary:
          'Interconnected inference nodes scheduling multi-agent collaboration at millisecond latency.',
        details: [
          'Stateful tool calls · streaming output',
          'Semantic routing · automatic model fallback',
          'HNSW index · billions of embeddings',
          'Deterministic replay · resume from checkpoint',
          'End-to-end traces · per-token attribution',
        ],
      },
      spatial: {
        summary: 'A frosted refractive interface that hands compute back as something spatial.',
        details: [
          'Hand-written GLSL · post-processing pipeline',
          'Concurrent rendering · zero-rerender hot paths',
          'Spring physics · 120 Hz compositor layers',
          'Inertial scrolling · single master clock',
          'Keyboard reachable · reduced-motion aware',
        ],
      },
    },
    layerDetailAria: 'technology stack details',
    layerDetailClose: 'Close the technology stack details',
    layerDetailHint: 'esc or click the layer again to return to the overview',
    layerStack: 'Technology stack',
  },

  /** Visual Overdrive palette names. */
  palette: {
    emerald: 'Emerald Cyber',
    supernova: 'Black Gold Supernova',
    phantom: 'Quantum Phantom',
  },

  /** Physics sandboxes. */
  sandbox: {
    verletLabel: 'Verlet sandbox',
    verletAria:
      'Draggable physics lanyard sandbox: drag a badge to swing it, overstretch it and the cord snaps',
    fabrikArmAria:
      'Six-axis arm driven by FABRIK inverse kinematics. Move the pointer to track, click to fire the laser',
    fabrikCreatureAria:
      'Procedural quadruped gait demo. Move the pointer to steer the tracking behaviour',
    fabrikArmHint: 'Move the pointer to track · click to fire the laser',
    fabrikCreatureHint: 'Move the pointer · the gait planner picks each foothold',
    verletHint: 'Drag a badge to stress the rope',
    verletReset: 'Re-forge lanyards',
    verletStrain: 'strain',
    verletGravity: 'Gravity',
    fabrikLabel: 'FABRIK solver',
    fabrikReset: 'Reset creature',
    fabrikError: 'error',
    fabrikIterations: 'iter',
    fabrikShots: 'shots',
    fabrikJoints: 'Joints',
    fabrikArmLabel: 'Arm',
    fabrikQuadruped: 'Quadruped',
    fabrikShowVectors: 'Show IK vectors',
    fabrikLaserHint: 'Click to fire the ion beam',
    fabrikBurnHint: 'Burns cool over three seconds',
    verletKeys:
      'Keyboard: Enter or Space grabs the nearest badge, the arrow keys swing it, Shift moves further, Escape lets go',
    fabrikKeysArm: 'Keyboard: the arrow keys steer the arm, Enter or Space fires the ion beam',
    fabrikKeysCreature: 'Keyboard: the arrow keys steer the point the creature walks toward',
    kbdGrab: 'Badge grabbed. Arrow keys swing it, Escape lets go.',
    kbdRelease: 'Badge released.',
    kbdFire: 'Ion beam fired.',
    gravityEarth: 'Earth gravity',
    gravityZero: 'Zero gravity',
    gravityMoon: 'Lunar gravity',
    gravityHeavy: 'Overdrive',
  },

  /** Developer telemetry panel. */
  hud: {
    panelAria: 'Performance telemetry panel',
    closeAria: 'Close the performance telemetry panel',
    fps: 'FPS',
    frame: 'Frame',
    worst: 'Worst',
    particles: 'Particles',
    shaderPass: 'Shader pass',
    physSolve: 'Phys solve',
    ikSolve: 'IK solve',
    canvases: 'Canvas a/s',
    tier: 'Tier',
    vfxPreset: 'VFX preset',
    hint: 'shift + d to toggle',
    heap: 'JS heap',
    noticeTitle: 'Performance mode engaged',
    degradeReason:
      'Averaged {fps} FPS over the last {seconds}s — below the {threshold} FPS threshold',
    frameBudget: 'Frame budget',
    avg: 'avg',
    adaptiveQuality: 'adaptive quality',
  },

  /** Archive rows. `type` stays a technical proper noun in both locales. */
  archive: {
    rows: {
      graphics: 'Real-time graphics experiments',
      narrative: 'Interactive narrative installations',
      generative: 'Generative visual systems',
    },
  },

  /** Footer, inside the contact chapter. */
  footer: {
    copyright: '© 2026 Digital Showroom',
    builtWith: 'built with react 19 · three.js · lenis',
    email: 'hello@showroom.dev',
  },

  /** Boot veil. */
  boot: {
    wordmark: 'Showroom',
    status: 'Initialising render pipeline',
    announce: 'Loading the showroom',
  },

  /** Command palette. */
  commands: {
    dialogAria: 'Command palette',
    placeholder: 'Search commands, chapters, presets…',
    empty: 'No matching commands',
    groups: {
      navigate: 'Chapters',
      physics: 'Physics sandbox',
      accent: 'Accent theme',
      palette: 'Visual palette',
      actions: 'Actions',
    },
    openPalette: 'Open the command palette',
    closePalette: 'Close the command palette',
    copyEmail: 'Copy email address',
    downloadJson: 'Download profile JSON',
    jumpTo: 'Jump to',
    searchAria: 'Search commands',
    listAria: 'Available commands',
    settingsAria: 'Current settings',
    emptyHint: 'Try "architecture", "gravity", "theme" or "resume"',
    navHint: 'navigate',
    execHint: 'run',
    done: 'done',
    countLabel: '{items} results · {total} commands',
    gravityNotes: {
      earth: '1.0 g · restored to default',
      zero: '0 g · the cord floats free',
      moon: '0.17 g · lunar surface',
      heavy: '2.6 g · the cord snaps taut',
    },
    accents: {
      emerald: { title: 'Emerald', subtitle: 'Emerald · default accent' },
      violet: { title: 'Cyber Violet', subtitle: 'Cyber Violet · neon purple' },
      amber: { title: 'Titanium Amber', subtitle: 'Titanium Amber · warm gold highlight' },
      cyan: { title: 'Signal Cyan', subtitle: 'Signal Cyan · the showroom original' },
    },
    profile: {
      title: 'Personal Digital Showroom',
      role: 'Full-stack AI · real-time graphics engineering',
      summary:
        'An immersive space assembled from WebGL, inertial scrolling and real-time state orchestration, where scrolling is camera motion.',
    },
    skills: {
      graphics: 'Real-time graphics',
      physics: 'Physics simulation',
      frontend: 'Frontend architecture',
      interaction: 'Interaction',
    },
    gravityPrefix: '',
  },
}

/**
 * The dictionary contract.
 *
 * Deliberately NOT `as const`: that would widen every value to its own literal
 * type, and `zh.ts` typed as `typeof en` could then only repeat the English
 * strings verbatim. The shape must be frozen, the values must not.
 */
export type Dictionary = typeof en
