const { parseArgsString } = require('./util');

const KEEP_ALIVE_FLAGS = [
  '--keep-alive-for-test',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection'
];

const BACKGROUND_FEATURES = [
  'Translate',
  'OptimizationHints',
  'MediaRouter',
  'AutofillServerCommunication',
  'InterestFeedContentSuggestions',
  'BackForwardCache',
  'Prerender2',
  'MemorySaver',
  'HighEfficiencyModeAvailable',
  'TabDiscarding',
  'SpareRendererForSitePerProcess',
  'IntensiveWakeUpThrottling'
];

const BASE_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--no-pings',
  '--metrics-recording-only',
  '--autoplay-policy=no-user-gesture-required',
  ...KEEP_ALIVE_FLAGS
];

function effectiveMemoryMode(settings, profile) {
  const mode = profile.memoryMode && profile.memoryMode !== 'inherit' ? profile.memoryMode : (settings.memoryMode || 'auto');
  if (mode === 'auto') return profile.windowMode === 'hidden' ? 'saver' : 'balanced';
  return mode;
}

function buildChromiumArgs({ settings = {}, profile = {}, extensionPaths = [] }) {
  const mode = effectiveMemoryMode(settings, profile);
  const features = new Set(BACKGROUND_FEATURES);
  if (mode === 'saver' || mode === 'extreme') {
    features.add('IsolateOrigins');
    features.add('site-per-process');
  }

  const args = [...BASE_FLAGS];
  args.push(`--disable-features=${[...features].join(',')}`);

  if (profile.windowMode === 'hidden') {
    args.push('--disable-gpu');
  }

  if (mode === 'saver') {
    args.push('--disable-gpu', '--disable-gpu-compositing', '--renderer-process-limit=3');
    args.push('--process-per-site');
    args.push('--disable-site-isolation-trials');
  } else if (mode === 'extreme') {
    args.push('--disable-gpu', '--disable-gpu-compositing', '--renderer-process-limit=1');
    args.push('--process-per-site');
    args.push('--disable-site-isolation-trials');
    args.push('--disable-software-rasterizer');
  }

  const heapMb = Number(settings.jsHeapMb);
  if (Number.isFinite(heapMb) && heapMb > 0) {
    args.push(`--js-flags=--max-old-space-size=${Math.round(heapMb)}`);
  }

  if (extensionPaths.length) {
    const joined = extensionPaths.map((item) => item.replace(/\\/g, '/')).join(',');
    args.push(`--load-extension=${joined}`);
    args.push(`--disable-extensions-except=${joined}`);
  }

  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    // root 环境下 Chromium 的 setuid 沙箱不可用，容器中运行时需要关闭沙箱
    args.push('--no-sandbox');
  }

  args.push(...parseArgsString(profile.extraArgs || ''));
  return [...new Set(args)];
}

module.exports = {
  BASE_FLAGS,
  KEEP_ALIVE_FLAGS,
  BACKGROUND_FEATURES,
  effectiveMemoryMode,
  buildChromiumArgs
};
