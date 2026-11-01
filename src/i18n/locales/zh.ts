import type { Dictionary } from './en'

/**
 * Chinese dictionary.
 *
 * Typed as `Dictionary`, i.e. `typeof en`. Adding a key to English without adding
 * it here is a compile error, and so is a typo in a nested section name. That is
 * the whole point of this file existing as a separate typed object rather than a
 * loose record of strings.
 */
export const zh: Dictionary = {
  meta: {
    title: '数字展厅 — 实时图形工程',
    description:
      '一个基于 React 19、Three.js 与 Lenis 构建的沉浸式个人展厅：滚动驱动的镜头编排、实时 GPU 粒子与物理沙盒。',
  },

  nav: {
    brand: 'SHOWROOM',
    brandSub: '数字 · v0.1',
    homeAria: '返回展厅入口',
    sectionsAria: '章节',
    primarySectionsAria: '主要章节',
    mobileMenuAria: '章节导航',
    openMenu: '打开菜单',
    closeMenu: '关闭菜单',
    fallbackSection: '展厅',

    fpsMonitorOn: '关闭 FPS 监视器',
    fpsMonitorOff: '开启 FPS 监视器',
    perfHudOpen: '打开性能遥测面板（Shift+D）',
    perfHudClose: '关闭性能遥测面板（Shift+D）',
    commandPaletteOpen: '打开命令面板（Ctrl/⌘ + K）',
    paletteCycle: '切换视觉调色',
    soundMute: '关闭音效',
    soundUnmute: '开启音效',
    tierCycle: '切换渲染档位',
    tierLabel: '档位',

    fps: '帧率',
    frame: '单帧',
    worst: '峰值',
    viewport: '视口',
    languageAria: '切换语言',
    languageEnglish: 'EN',
    languageChinese: '中文',
  },

  sections: {
    hero: {
      index: '01',
      eyebrow: 'entrance',
      title: '入口',
      description: '一个像机器启动般加载的展厅：同一个时钟同时驱动页面、镜头与 GPU。',
    },
    gallery: {
      index: '02',
      eyebrow: 'gallery',
      title: '展厅',
      description: '每一件展品都是可滚动、可指向的实时装置，而不是一张截图。',
    },
    architecture: {
      index: '03',
      eyebrow: 'architecture',
      title: '架构',
      description: '三层紧密咬合：硅基算力、智能编排与空间界面。',
    },
    playground: {
      index: '04',
      eyebrow: 'playground',
      title: '沙盒',
      description: '手写求解器：Verlet 积分的挂绳，以及由 FABRIK 逆向运动学驱动的机械生物。',
    },
    archive: {
      index: '05',
      eyebrow: 'archive',
      title: '档案',
      description: '按时间索引的创作记录。',
    },
    contact: {
      index: '06',
      eyebrow: 'contact',
      title: '通讯',
      description: '如果你也在构建某种沉浸式的数字空间，我们可以聊聊。',
    },
  },

  hero: {
    statusOnline: '系统在线',
    stackStack: 'webgl · lenis · r3f',
    titleLead: '个人',
    titleMain: '数字展厅',
    body: '一个由 WebGL、惯性滚动与实时状态编排构成的沉浸式空间。',
    bodyAccent: '在这里，滚动即是镜头运动。',
    ctaEnter: '进入展厅',
    ctaArchive: '浏览档案',
    scrollHint: 'scroll',
    fpsBadge: '帧率',
    particlesBadge: '粒子',
  },

  bento: {
    cardThroughputLabel: '实时推理',
    cardThroughputTitle: '推理吞吐监控',
    cardThroughputNote: '实时跳动的 Token 吞吐量折线图，直接绘制到 canvas',
    cardThroughputBody:
      '边缘推理集群的实时吞吐，每 120ms 采样一次，由 canvas 直接绘制。',
    cardTopologyTitle: '分布式推理拓扑',
    cardTopologyNote: '点击节点查看其职责',
    cardTerminalTitle: '一键部署',
    cardTerminalNote: '带真实键盘输入的终端模拟器',
    cardRenderTitle: '渲染管线',
    cardRenderNote: '单 draw call 渲染 8000 粒子',
    cardUptimeTitle: '服务健康度',
    cardUptimeNote: '过去 14 天的可用性',
    cardTopologyLabel: '架构拓扑',
    cardTerminalLabel: '部署终端',
    cardRenderLabel: '渲染管线',
    cardUptimeLabel: '在线时长',
    copyCode: '复制代码',
    copied: '已复制到剪贴板',
    copyFailed: '剪贴板不可用',
    inspectArchitecture: '查看架构',
    drawCalls: '绘制调用',
    particles: '粒子',
    frame: '帧',
    terminalAria: '终端命令输入，可用命令：help、skills、matrix、clear',
    terminalPrompt: '$',
    terminalHint: '输入 "help" 开始探索',
    terminalOnline: '在线 · showroom.edge',
  },

  architecture: {
    eyebrow: 'architecture',
    headingLead: '全栈 AI 与',
    headingAccent: '分布式计算',
    headingTail: '核心',
    subtitleIdle: '三层紧密咬合 · 持续自转',
    subtitleExplode: '分层展开 · 数据流贯通',
    subtitleFinal: '结构重组 · 指标浮现',
    metrics: {
      throughputLabel: '单节点推理吞吐',
      throughputNote: '较上一代提升 3.2×',
      availabilityLabel: '集群可用性',
      availabilityNote: '跨 6 个区域热切换',
      latencyLabel: '端到端延迟',
      latencyNote: '含网络与排队',
      agentsLabel: '并发智能体',
      agentsNote: '单编排层上限',
    },
    layers: {
      infra: {
        summary: '高密度计算网格，为每个 token 榨干每一瓦特。',
        details: [
          '自定义 attention / RMSNorm 融合算子',
          'FP8 / INT4 量化 · 动态批处理',
          '跨节点 all-reduce · 800Gbps RDMA',
          'GPU 间 900GB/s 直连带宽',
          'HBM3e · 每卡 192GB',
        ],
      },
      agents: {
        summary: '互联推理节点，以毫秒级调度编排多智能体协作。',
        details: [
          '有状态工具调用 · 流式输出',
          '语义路由 · 模型自动降级',
          'HNSW 索引 · 千万级 embedding',
          '确定性重放 · 断点续跑',
          '全链路 trace · 逐 token 归因',
        ],
      },
      spatial: {
        summary: '磨砂折射界面，把算力以空间化的方式交到人手里。',
        details: [
          '自定义 GLSL · 后处理管线',
          '并发渲染 · 零重渲染热路径',
          '弹簧物理 · 120Hz 合成层',
          '惯性滚动 · 单主时钟驱动',
          '键盘可达 · 减少动效适配',
        ],
      },
    },
    layerDetailAria: '技术栈详情',
    layerDetailClose: '关闭技术栈详情',
    layerDetailHint: 'esc 或再次点击图层 · 返回总览',
    layerStack: '技术栈',
  },

  sandbox: {
    verletLabel: 'Verlet 沙盒',
    verletHint: '拖动工牌以拉扯绳索',
    verletReset: '重新锻造挂绳',
    verletStrain: '应变',
    verletGravity: '重力',
    fabrikLabel: 'FABRIK 求解器',
    fabrikReset: '重置机械生物',
    fabrikError: '误差',
    fabrikIterations: '迭代',
    fabrikShots: '射击',
    fabrikJoints: '机腿',
    fabrikQuadruped: '四足',
    fabrikShowVectors: '显示 IK 向量',
    fabrikLaserHint: '点击发射离子光束',
    fabrikBurnHint: '灼痕在三秒内冷却',
    gravityEarth: '地球重力',
    gravityZero: '零重力',
    gravityMoon: '月球重力',
    gravityHeavy: '超重模式',
  },

  hud: {
    panelAria: '性能遥测面板',
    closeAria: '关闭性能遥测面板',
    fps: '帧率',
    frame: '单帧',
    worst: '最差',
    particles: '粒子',
    shaderPass: '着色通道',
    physSolve: '物理求解',
    ikSolve: 'IK 求解',
    canvases: 'Canvas 启用',
    tier: '档位',
    vfxPreset: '视觉调色',
    hint: 'shift + d 切换',
    heap: 'JS 堆',
    noticeTitle: '已切换至性能模式',
  },

  archive: {
    rows: {
      graphics: '实时图形实验',
      narrative: '交互叙事装置',
      generative: '生成式视觉系统',
    },
  },

  footer: {
    copyright: '© 2026 数字展厅',
    builtWith: '基于 react 19 · three.js · lenis 构建',
    email: 'hello@showroom.dev',
  },

  boot: {
    wordmark: 'Showroom',
    status: '正在初始化渲染管线',
    announce: '正在加载展厅',
  },

  commands: {
    dialogAria: '命令面板',
    placeholder: '搜索命令、章节、预设…',
    empty: '没有匹配的命令',
    groups: {
      navigate: '跳转章节',
      physics: '物理沙盒',
      accent: '主题强调色',
      palette: '视觉调色',
      actions: '操作',
    },
    openPalette: '打开命令面板',
    closePalette: '关闭命令面板',
    copyEmail: '复制邮箱',
    downloadJson: '下载简历 JSON',
    jumpTo: '跳转到',
    gravityPrefix: '',
  },
}

export default zh
