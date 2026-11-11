// Craft Anything compact call layer.
//
// The engine ships 321 tools; dumping `commands` is ~129 KB of JSON (~30k tokens)
// and listing it in a skill makes the model context-heavy and worse at choosing.
// So the model gets three small entry points instead:
//   - op=capability name=<cap>   → a curated wrapper (tool + param mapping)
//   - op=tools query=<word>      → bounded search over the catalog (name/title/summary)
//   - op=commands                → toolset counts + hints (never the whole table)
// Everything below is pure (no spawn/fs) so it is unit-testable.

const MAX_SUMMARY = 110;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

/** Curated capabilities: id -> { Tool id, how the target is passed, allow-listed params }. */
export const CRAFT_CAPABILITIES = {
  triage: {
    label: '目标识别 + 下一步工具建议',
    tool: 'core-target-triage',
    target: { mode: 'flag', name: 'path' },
    params: ['path'],
    notes: '不知道文件是什么时先跑这个；输出会给出格式/架构/语言与推荐工具集',
  },
  open_target: {
    label: '打开目标为活动 target',
    tool: 'core-target-open',
    target: { mode: 'flag', name: 'path' },
    params: ['path', 'format', 'architecture', 'entryPoint', 'languageId'],
  },
  functions_list: {
    label: '函数清单（分页）',
    tool: 'native-functions-list',
    target: { mode: 'positional' },
    params: ['path', 'document', 'limit', 'offset', 'architecture', 'entryPoint', 'format', 'languageId'],
  },
  function_pseudocode: {
    label: '函数伪代码（内置 lifter）',
    tool: 'native-function-pseudocode',
    target: { mode: 'positional' },
    params: ['path', 'document', 'function', 'architecture', 'entryPoint', 'format', 'languageId'],
    required: ['function'],
  },
  function_disassemble: {
    label: '函数汇编清单',
    tool: 'native-function-disassemble',
    target: { mode: 'positional' },
    params: ['path', 'document', 'function'],
    required: ['function'],
  },
  strings_list: {
    label: '字符串浏览（分页）',
    tool: 'native-strings-browse',
    target: { mode: 'positional' },
    params: ['path', 'document', 'limit', 'offset', 'section', 'address'],
  },
  imports_list: {
    label: '导入/动态符号清单',
    tool: 'native-library-calls-list',
    target: { mode: 'flag', name: 'path' },
    params: ['path', 'limit', 'offset', 'contains', 'kind'],
  },
  web_page_inspect: {
    label: 'CDP 被动观察网页（DOM/脚本/网络轮廓）',
    tool: 'web-page-show',
    target: { mode: 'none' },
    params: [
      'cdpEndpoint', 'targetId', 'watchMs', 'timeoutSecs', 'launch', 'headless', 'noSandbox',
      'withScriptText', 'withConsoleText', 'withAccessibilityText', 'withStorageNames',
      'withBodyOutlines', 'withWebsocketOutlines', 'hiddenValues',
    ],
  },
  android_package: {
    label: 'APK 包/Manifest/签名概览',
    tool: 'android-package-show',
    target: { mode: 'flag', name: 'path' },
    params: ['path', 'includeManifestXml'],
  },
  unpack_packed: {
    label: '解出程序/游戏内嵌的打包文件',
    tool: 'core-packed-files-unpack',
    target: { mode: 'flag', name: 'path' },
    params: ['path', 'outputDirectory', 'contains', 'paths', 'format', 'maxOutputBytes', 'maxOutputFiles'],
    required: ['outputDirectory'],
  },
};

export const CRAFT_CAPABILITY_IDS = Object.keys(CRAFT_CAPABILITIES);

/** Arguments consumed by the gateway layer, never forwarded as tool flags. */
const RESERVED = new Set([
  'op', 'backend', 'capability', 'name', 'params', 'taskId', 'stepId', 'timeoutMs', 'raw',
  'deep', 'allowRun', 'project',
]);

function kebab(key) {
  return String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * Map a capability id + caller args to a real CLI argv (global options first,
 * then the tool, then a positional target, then flags).
 */
export function buildCapabilityArgv(capabilityId, args = {}) {
  const cap = CRAFT_CAPABILITIES[capabilityId];
  if (!cap) {
    fail(`未知 craft capability: ${capabilityId}。可用：${CRAFT_CAPABILITY_IDS.join('/')}`, 'unknown-capability');
  }
  const prefix = [];
  if (args.deep === true) prefix.push('--deep');
  if (args.allowRun === true) prefix.push('--allow-run');
  if (args.project) prefix.push('--project', String(args.project));

  const flags = [];
  let positional;
  let target = null;
  for (const [key, value] of Object.entries(args)) {
    if (RESERVED.has(key) || value === undefined || value === null) continue;
    if (key === 'path') {
      target = String(value);
      if (cap.target.mode === 'positional') { positional = target; continue; }
      if (cap.target.mode === 'none') continue;
      flags.push('--path', target);
      continue;
    }
    if (!cap.params.includes(key)) {
      fail(`capability ${capabilityId} 不接受参数 ${key}（可用：${cap.params.join('/')}）`, 'unknown-param');
    }
    const flag = `--${kebab(key)}`;
    if (value === true) flags.push(flag);
    else if (value === false) { /* omit booleans set to false */ }
    else if (Array.isArray(value)) for (const item of value) flags.push(flag, String(item));
    else flags.push(flag, String(value));
  }

  for (const required of cap.required || []) {
    const provided = args[required];
    if (provided === undefined || provided === null || provided === '') {
      fail(`capability ${capabilityId} 需要参数 ${required}`, 'missing-param');
    }
  }
  if (cap.target.mode !== 'none' && !target && !args.document) {
    fail(`capability ${capabilityId} 需要 path（或已打开的 document）`, 'missing-target');
  }

  const argv = [...prefix, cap.tool, ...(positional ? [positional] : []), ...flags];
  return { capability: capabilityId, tool: cap.tool, label: cap.label, argv };
}

function clipSummary(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY)}…` : s;
}

/** Bounded keyword/toolset search over the `commands --format json` catalog. */
export function searchTools(tools, { query = '', toolset = '', limit } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const q = String(query || '').trim().toLowerCase();
  const ts = String(toolset || '').trim().toLowerCase();
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  let rows = list;
  if (ts) rows = rows.filter((t) => String(t.toolset || '').toLowerCase() === ts);
  if (q) {
    rows = rows.filter((t) => `${t.tool} ${t.command} ${t.title} ${t.toolset} ${t.summary}`.toLowerCase().includes(q));
  }
  return {
    matched: rows.length,
    returned: Math.min(rows.length, capped),
    items: rows.slice(0, capped).map((t) => ({
      tool: t.tool,
      title: t.title,
      toolset: t.toolset,
      needsTarget: !!t.needs_target,
      summary: clipSummary(t.summary),
    })),
  };
}

/** Compact catalog index: counts per toolset + the curated capability ids. */
export function compactIndex(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const counts = new Map();
  for (const t of list) counts.set(t.toolset, (counts.get(t.toolset) || 0) + 1);
  return {
    total: list.length,
    toolsets: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    capabilities: CRAFT_CAPABILITY_IDS,
    hint: '不要整表打印：用 op=tools query=<词> 检索，或 op=capability name=<能力> 直接调；需要完整清单才传 raw:true',
  };
}
