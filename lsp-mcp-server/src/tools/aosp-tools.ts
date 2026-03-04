import { promisify } from "util";
import { execFile } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { z } from "zod";
import type { LSPManager } from "../lsp/index.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 30;
const INDEX_DIR_NAME = ".lsp-mcp-aosp-index";
const DEFAULT_PRESET_MAX_MODULES = 80;
const DEFAULT_DOMAIN_MAX_WARM_MODULES = 80;

const DEFAULT_EXCLUDES = [
  "!out/**",
  "!prebuilts/**",
  "!.repo/**",
  "!.git/**",
  "!**/node_modules/**",
];

const AOSP_ANCHORS = ["build/soong", "frameworks/base", "system/core", "packages/modules"];

type AospScope = "frameworks" | "system" | "art" | "bionic" | "hardware" | "packages";
const DEFAULT_SCOPE: AospScope = "frameworks";

const SCOPE_DIRS: Record<AospScope, string[]> = {
  frameworks: ["frameworks"],
  system: ["system"],
  art: ["art"],
  bionic: ["bionic"],
  hardware: ["hardware"],
  packages: ["packages"],
};

type AospPresetKey = "audio" | "driver" | "system_server";
type AospPreset = {
  id: AospPresetKey;
  title: string;
  description: string;
  repos: string[];
  moduleKeywords: string[];
};

type AospDomainKey = "audio" | "video" | "render";
type AospDomainProfile = {
  id: AospDomainKey;
  title: string;
  description: string;
  repos: string[];
  hotModules: string[];
  warmModuleKeywords: string[];
};

const AOSP_DOMAINS: Record<AospDomainKey, AospDomainProfile> = {
  audio: {
    id: "audio",
    title: "Audio",
    description: "Audio and media pipeline with semantic priority on common audio modules.",
    repos: ["frameworks/av", "frameworks/base/media", "system/media", "hardware/interfaces"],
    hotModules: ["libaudioclient", "libaudiohal", "audioserver", "services.core"],
    warmModuleKeywords: ["audio", "media", "aaudio", "audiopolicy", "audioserver", "codec"],
  },
  video: {
    id: "video",
    title: "Video",
    description: "Video codec, stagefright and media stack repositories.",
    repos: ["frameworks/av", "frameworks/base/media", "packages/modules/Media", "hardware/interfaces"],
    hotModules: ["libstagefright", "libmediaplayerservice", "mediaswcodec", "mediaextractor"],
    warmModuleKeywords: ["video", "stagefright", "codec", "media", "extractor", "decoder", "encoder"],
  },
  render: {
    id: "render",
    title: "Render",
    description: "SurfaceFlinger, HWUI, graphics and render pipeline.",
    repos: ["frameworks/native", "frameworks/base/libs/hwui", "hardware/interfaces/graphics", "system/core"],
    hotModules: ["surfaceflinger", "libgui", "libhwui", "libsurfaceflinger"],
    warmModuleKeywords: ["render", "surface", "composer", "hwui", "vulkan", "egl", "gralloc", "gpu"],
  },
};

const AOSP_PRESETS: Record<AospPresetKey, AospPreset> = {
  audio: {
    id: "audio",
    title: "Audio 开发",
    description: "frameworks/av 与 system/media 为主，覆盖音频 HAL 和媒体相关模块",
    repos: [
      "frameworks/av",
      "frameworks/base/media",
      "system/media",
      "hardware/interfaces",
      "hardware/libhardware",
      "packages/modules/Media",
    ],
    moduleKeywords: ["audio", "media", "codec", "aaudio", "audiopolicy", "audioserver"],
  },
  driver: {
    id: "driver",
    title: "底层驱动",
    description: "硬件接口、系统核心与 HAL 桥接路径",
    repos: [
      "hardware/interfaces",
      "hardware/libhardware",
      "hardware/google",
      "system/core",
      "system/sepolicy",
      "vendor",
    ],
    moduleKeywords: ["hal", "driver", "kernel", "hwservicemanager", "hidl", "aidl_interface"],
  },
  system_server: {
    id: "system_server",
    title: "System Server",
    description: "Framework 与系统服务核心路径",
    repos: [
      "frameworks/base/services",
      "frameworks/base/core",
      "frameworks/native/services",
      "system/server_configurable_flags",
      "system/core",
    ],
    moduleKeywords: ["services.core", "services", "systemserver", "am", "wm"],
  },
};

export const AOSP_OPERATIONS = [
  "detectRoot",
  "init",
  "search",
  "listDomains",
  "indexDomain",
  "queryDomain",
  "listPresets",
  "resolveModule",
  "indexModule",
  "indexPreset",
  "queryIndexedSymbol",
  "queryPresetSymbol",
  "findPath",
  "findSymbol",
  "findClass",
  "findModule",
] as const;

const ScopeOrRepoSchema = z
  .object({
    scope: z
      .enum(["frameworks", "system", "art", "bionic", "hardware", "packages"])
      .default(DEFAULT_SCOPE),
    repo: z
      .string()
      .optional()
      .describe("Optional repo path relative to AOSP root, e.g. frameworks/base or system/core"),
    moduleName: z
      .string()
      .optional()
      .describe("Optional module name from module-info.json; if set, search is restricted to module paths"),
  })
  .strict();

export const AospToolSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("detectRoot"),
    hintPath: z.string().optional().describe("Optional path to start detection from"),
  }),
  z.object({
    operation: z.literal("init"),
    domain: z.enum(["audio", "video", "render"]).optional(),
    focusPath: z.string().optional().describe("Optional path hint to infer domain"),
    maxWarmModules: z.number().int().min(1).max(400).default(DEFAULT_DOMAIN_MAX_WARM_MODULES),
  }),
  z.object({
    operation: z.literal("search"),
    query: z.string().min(1),
    domain: z.enum(["audio", "video", "render"]).optional(),
    queryType: z.enum(["auto", "symbol", "class", "path"]).default("auto"),
    allowRemote: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
  }),
  z.object({
    operation: z.literal("listDomains"),
  }),
  z.object({
    operation: z.literal("indexDomain"),
    domain: z.enum(["audio", "video", "render"]),
    maxWarmModules: z.number().int().min(1).max(400).default(DEFAULT_DOMAIN_MAX_WARM_MODULES),
  }),
  z.object({
    operation: z.literal("queryDomain"),
    domain: z.enum(["audio", "video", "render"]),
    query: z.string().min(1).describe("Search query"),
    queryType: z.enum(["symbol", "class", "path"]).default("symbol"),
    mode: z.enum(["auto", "semantic", "file", "remote"]).default("auto"),
    literal: z.boolean().default(true),
    allowRemote: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
  }),
  z.object({
    operation: z.literal("listPresets"),
  }),
  z.object({
    operation: z.literal("resolveModule"),
    moduleName: z.string().min(1),
  }),
  z.object({
    operation: z.literal("indexModule"),
    moduleName: z.string().min(1),
  }),
  z.object({
    operation: z.literal("indexPreset"),
    preset: z.enum(["audio", "driver", "system_server"]),
    maxModules: z.number().int().min(1).max(400).default(DEFAULT_PRESET_MAX_MODULES),
  }),
  z.object({
    operation: z.literal("queryIndexedSymbol"),
    symbol: z.string().min(1),
    moduleName: z.string().optional().describe("Optional; if absent, query all indexed modules"),
    preset: z.enum(["audio", "driver", "system_server"]).optional(),
    literal: z.boolean().default(true),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
  }),
  z.object({
    operation: z.literal("queryPresetSymbol"),
    preset: z.enum(["audio", "driver", "system_server"]),
    symbol: z.string().min(1),
    literal: z.boolean().default(true),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
  }),
  z.object({
    operation: z.literal("findPath"),
    query: z.string().min(1).describe("File/path keyword, supports partial text"),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
    ...ScopeOrRepoSchema.shape,
  }),
  z.object({
    operation: z.literal("findSymbol"),
    symbol: z.string().min(1).describe("Identifier or regex to search in source"),
    literal: z.boolean().default(true).describe("Whether to treat symbol as plain text"),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
    ...ScopeOrRepoSchema.shape,
  }),
  z.object({
    operation: z.literal("findClass"),
    className: z.string().min(1).describe("Java/C++ class or interface name"),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
    ...ScopeOrRepoSchema.shape,
  }),
  z.object({
    operation: z.literal("findModule"),
    moduleName: z.string().min(1).describe("Android.bp module name"),
    scope: z
      .enum(["frameworks", "system", "art", "bionic", "hardware", "packages"])
      .default(DEFAULT_SCOPE),
    repo: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(DEFAULT_LIMIT),
  }),
]);

export type AospToolInput = z.infer<typeof AospToolSchema>;

interface AospToolContext {
  workspaceRoot: string;
  lspManager?: LSPManager;
}

type ModuleInfoEntry = {
  path?: string[];
};

type ModuleInfoMap = Record<string, ModuleInfoEntry>;
type ModuleIndexShard = {
  version: 1;
  moduleName: string;
  root: string;
  moduleInfoPath: string | null;
  searchRoots: string[];
  fileCount: number;
  createdAt: string;
};

type PresetIndexShard = {
  version: 1;
  preset: AospPresetKey;
  root: string;
  repos: string[];
  modules: string[];
  createdAt: string;
};

type DomainIndexedModule = {
  moduleName: string;
  fileCount: number;
  searchRoots: string[];
};

type DomainIndexShard = {
  version: 1;
  domain: AospDomainKey;
  root: string;
  repos: string[];
  hotModules: DomainIndexedModule[];
  warmModules: DomainIndexedModule[];
  moduleInfoPath: string | null;
  moduleInfoMtimeMs: number | null;
  createdAt: string;
};

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatRelative(root: string, target: string): string {
  return toPosixPath(path.relative(root, target));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function validateRepo(repo: string): string {
  const normalized = toPosixPath(repo).replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("repo must be a non-empty path relative to AOSP root");
  }
  if (normalized.includes("..")) {
    throw new Error("repo cannot contain parent directory traversal");
  }
  return normalized;
}

async function scoreAospRoot(candidate: string): Promise<number> {
  let score = 0;
  for (const anchor of AOSP_ANCHORS) {
    if (await pathExists(path.join(candidate, anchor))) score += 1;
  }
  if (await pathExists(path.join(candidate, ".repo"))) score += 2;
  return score;
}

export async function detectAospRoot(startPath: string): Promise<{
  root: string;
  score: number;
  checked: string[];
}> {
  const checked: string[] = [];
  let current = path.resolve(startPath);
  try {
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  let best = { root: current, score: 0 };
  while (true) {
    checked.push(current);
    const score = await scoreAospRoot(current);
    if (score > best.score) best = { root: current, score };

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { ...best, checked };
}

async function runRgJson(cwd: string, pattern: string, args: string[]): Promise<Array<Record<string, any>>> {
  const fullArgs = [
    "--json",
    "--line-number",
    "--column",
    "--no-heading",
    "--hidden",
    ...DEFAULT_EXCLUDES.flatMap((x) => ["--glob", x]),
    ...args,
    pattern,
  ];

  let stdout = "";
  try {
    const result = await execFileAsync("rg", fullArgs, {
      cwd,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const exitCode = (error as { code?: string | number }).code;
    if (exitCode === 1 || exitCode === "1") return [];
    if (exitCode === "ENOENT") throw new Error("ripgrep (rg) is required but not found in PATH");
    throw error;
  }

  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, any>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, any> => item !== null);
}

async function runRgFiles(cwd: string, query: string): Promise<string[]> {
  const args = [
    "--files",
    "--hidden",
    ...DEFAULT_EXCLUDES.flatMap((x) => ["--glob", x]),
    "--glob",
    `*${query}*`,
  ];

  let stdout = "";
  try {
    const result = await execFileAsync("rg", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const exitCode = (error as { code?: string | number }).code;
    if (exitCode === 1 || exitCode === "1") return [];
    if (exitCode === "ENOENT") throw new Error("ripgrep (rg) is required but not found in PATH");
    throw error;
  }
  return stdout.split(/\r?\n/).filter(Boolean).map(toPosixPath);
}

async function findModuleInfoPath(root: string): Promise<string | null> {
  const fixedCandidates = [
    path.join(root, "out/soong/module-info.json"),
    path.join(root, "out/module-info.json"),
  ];
  for (const candidate of fixedCandidates) {
    if (await pathExists(candidate)) return candidate;
  }

  const productRoot = path.join(root, "out/target/product");
  if (!(await pathExists(productRoot))) return null;

  const children = await fs.readdir(productRoot, { withFileTypes: true });
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const candidate = path.join(productRoot, child.name, "module-info.json");
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function loadModuleInfo(root: string): Promise<{ path: string | null; data: ModuleInfoMap | null }> {
  const moduleInfoPath = await findModuleInfoPath(root);
  if (!moduleInfoPath) return { path: null, data: null };

  try {
    const source = await fs.readFile(moduleInfoPath, "utf-8");
    const parsed = JSON.parse(source) as ModuleInfoMap;
    return { path: moduleInfoPath, data: parsed };
  } catch {
    return { path: moduleInfoPath, data: null };
  }
}

function moduleIndexDir(root: string): string {
  return path.join(root, INDEX_DIR_NAME, "modules");
}

function presetIndexDir(root: string): string {
  return path.join(root, INDEX_DIR_NAME, "presets");
}

function domainIndexDir(root: string): string {
  return path.join(root, INDEX_DIR_NAME, "domains");
}

function moduleShardPath(root: string, moduleName: string): string {
  const safe = moduleName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(moduleIndexDir(root), `${safe}.json`);
}

function presetShardPath(root: string, preset: AospPresetKey): string {
  return path.join(presetIndexDir(root), `${preset}.json`);
}

function domainShardPath(root: string, domain: AospDomainKey): string {
  return path.join(domainIndexDir(root), `${domain}.json`);
}

async function writeModuleShard(root: string, shard: ModuleIndexShard): Promise<string> {
  const dir = moduleIndexDir(root);
  await fs.mkdir(dir, { recursive: true });
  const target = moduleShardPath(root, shard.moduleName);
  await fs.writeFile(target, JSON.stringify(shard, null, 2), "utf-8");
  return target;
}

async function writePresetShard(root: string, shard: PresetIndexShard): Promise<string> {
  const dir = presetIndexDir(root);
  await fs.mkdir(dir, { recursive: true });
  const target = presetShardPath(root, shard.preset);
  await fs.writeFile(target, JSON.stringify(shard, null, 2), "utf-8");
  return target;
}

async function writeDomainShard(root: string, shard: DomainIndexShard): Promise<string> {
  const dir = domainIndexDir(root);
  await fs.mkdir(dir, { recursive: true });
  const target = domainShardPath(root, shard.domain);
  await fs.writeFile(target, JSON.stringify(shard, null, 2), "utf-8");
  return target;
}

async function readModuleShard(root: string, moduleName: string): Promise<ModuleIndexShard | null> {
  const target = moduleShardPath(root, moduleName);
  if (!(await pathExists(target))) return null;
  try {
    const content = await fs.readFile(target, "utf-8");
    const parsed = JSON.parse(content) as ModuleIndexShard;
    if (parsed.version !== 1 || !Array.isArray(parsed.searchRoots)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readPresetShard(root: string, preset: AospPresetKey): Promise<PresetIndexShard | null> {
  const target = presetShardPath(root, preset);
  if (!(await pathExists(target))) return null;
  try {
    const content = await fs.readFile(target, "utf-8");
    const parsed = JSON.parse(content) as PresetIndexShard;
    if (parsed.version !== 1 || !Array.isArray(parsed.modules)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readDomainShard(root: string, domain: AospDomainKey): Promise<DomainIndexShard | null> {
  const target = domainShardPath(root, domain);
  if (!(await pathExists(target))) return null;
  try {
    const content = await fs.readFile(target, "utf-8");
    const parsed = JSON.parse(content) as DomainIndexShard;
    if (parsed.version !== 1 || !Array.isArray(parsed.hotModules) || !Array.isArray(parsed.warmModules)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readAllModuleShards(root: string): Promise<ModuleIndexShard[]> {
  const dir = moduleIndexDir(root);
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter((x) => x.isFile() && x.name.endsWith(".json"));
  const shards = await Promise.all(
    files.map(async (entry) => {
      const full = path.join(dir, entry.name);
      try {
        const content = await fs.readFile(full, "utf-8");
        const parsed = JSON.parse(content) as ModuleIndexShard;
        if (parsed.version !== 1 || !Array.isArray(parsed.searchRoots)) return null;
        return parsed;
      } catch {
        return null;
      }
    })
  );
  return shards.filter((item): item is ModuleIndexShard => item !== null);
}

function getModulePaths(root: string, moduleInfo: ModuleInfoMap | null, moduleName: string): string[] {
  if (!moduleInfo) return [];
  const exact = moduleInfo[moduleName];
  if (exact?.path?.length) {
    return exact.path.map((item) => path.join(root, item));
  }

  const lower = moduleName.toLowerCase();
  const fuzzy = Object.entries(moduleInfo)
    .filter(([name]) => name.toLowerCase().includes(lower))
    .slice(0, 20)
    .flatMap(([, entry]) => entry.path ?? [])
    .map((item) => path.join(root, item));
  return fuzzy;
}

function discoverModulesForPreset(
  moduleInfo: ModuleInfoMap | null,
  preset: AospPreset,
  maxModules: number
): string[] {
  if (!moduleInfo) return [];

  const repos = preset.repos.map((repo) => validateRepo(repo));
  const keywords = preset.moduleKeywords.map((item) => item.toLowerCase());
  const scored: Array<{ name: string; score: number }> = [];

  for (const [moduleName, entry] of Object.entries(moduleInfo)) {
    const paths = (entry.path ?? []).map((item) => toPosixPath(item));
    const lowerName = moduleName.toLowerCase();
    const repoHit = paths.some((item) => repos.some((repo) => item === repo || item.startsWith(`${repo}/`)));
    const keywordHit = keywords.some((keyword) => lowerName.includes(keyword));
    if (!repoHit && !keywordHit) continue;

    let score = 0;
    if (repoHit) score += 2;
    if (keywordHit) score += 1;
    scored.push({ name: moduleName, score });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, maxModules).map((item) => item.name);
}

function discoverWarmModulesForDomain(
  moduleInfo: ModuleInfoMap | null,
  domain: AospDomainProfile,
  maxModules: number
): string[] {
  if (!moduleInfo) return [];

  const repoPrefixes = domain.repos.map((repo) => validateRepo(repo));
  const keywords = domain.warmModuleKeywords.map((item) => item.toLowerCase());
  const hotSet = new Set(domain.hotModules);
  const scored: Array<{ name: string; score: number }> = [];

  for (const [moduleName, entry] of Object.entries(moduleInfo)) {
    if (hotSet.has(moduleName)) continue;
    const paths = (entry.path ?? []).map((item) => toPosixPath(item));
    const lowerName = moduleName.toLowerCase();
    const repoHit = paths.some((item) => repoPrefixes.some((repo) => item === repo || item.startsWith(`${repo}/`)));
    const keywordHit = keywords.some((keyword) => lowerName.includes(keyword));
    if (!repoHit && !keywordHit) continue;

    let score = 0;
    if (repoHit) score += 2;
    if (keywordHit) score += 1;
    scored.push({ name: moduleName, score });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, maxModules).map((item) => item.name);
}

function isPathUnderRoots(target: string, roots: string[]): boolean {
  const normalizedTarget = toPosixPath(path.resolve(target)).toLowerCase();
  return roots.some((root) => {
    const normalizedRoot = toPosixPath(path.resolve(root)).toLowerCase().replace(/\/+$/, "");
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
  });
}

function toAbsoluteFromUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function inferConfidence(name: string, query: string, tier: "semantic" | "file" | "remote"): number {
  const left = name.toLowerCase();
  const right = query.toLowerCase();
  if (left === right) return tier === "semantic" ? 1 : tier === "file" ? 0.92 : 0.65;
  if (left.includes(right)) return tier === "semantic" ? 0.95 : tier === "file" ? 0.85 : 0.6;
  return tier === "semantic" ? 0.88 : tier === "file" ? 0.75 : 0.5;
}

async function querySemanticInDomain(input: {
  lspManager: LSPManager | undefined;
  allowedRoots: string[];
  query: string;
  limit: number;
}) {
  if (!input.lspManager) return [];

  const symbols = (await input.lspManager.workspaceSymbol(input.query).catch(() => [])) as Array<Record<string, any>>;
  const results: Array<Record<string, any>> = [];

  for (const symbol of symbols) {
    const uri = (symbol.location?.uri as string | undefined) ?? (symbol.uri as string | undefined);
    if (!uri) continue;
    const absolutePath = toAbsoluteFromUri(uri);
    if (!absolutePath) continue;
    if (!isPathUnderRoots(absolutePath, input.allowedRoots)) continue;

    const start = (symbol.location?.range?.start as { line?: number; character?: number } | undefined) ?? {};
    const name = typeof symbol.name === "string" ? symbol.name : "";

    results.push({
      tier: "semantic",
      source: "lsp",
      confidence: inferConfidence(name || input.query, input.query, "semantic"),
      name,
      kind: symbol.kind ?? null,
      containerName: symbol.containerName ?? null,
      absolutePath: toPosixPath(absolutePath),
      relativePath: "",
      line: Number.isFinite(start.line) ? Number(start.line) + 1 : 1,
      character: Number.isFinite(start.character) ? Number(start.character) + 1 : 1,
    });
    if (results.length >= input.limit) break;
  }

  return results;
}

function buildRemoteCandidates(query: string, queryType: "symbol" | "class" | "path", limit: number) {
  const encoded = encodeURIComponent(query);
  const token = queryType === "path" ? "path" : "symbol";
  return [
    {
      tier: "remote",
      source: "opengrok",
      confidence: inferConfidence(query, query, "remote"),
      title: "OpenGrok candidate",
      url: `https://opengrok.example.com/search?q=${encoded}&defs=${token}`,
      note: "Template URL; replace host with your internal OpenGrok service.",
    },
    {
      tier: "remote",
      source: "cs.android.com",
      confidence: inferConfidence(query, query, "remote"),
      title: "cs.android.com candidate",
      url: `https://cs.android.com/search?q=${encoded}`,
      note: "Remote reference result, verify with local branch before changes.",
    },
  ].slice(0, Math.max(1, Math.min(limit, 2)));
}

async function getFileMtimeMs(filePath: string | null): Promise<number | null> {
  if (!filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    return Number(stat.mtimeMs);
  } catch {
    return null;
  }
}

function inferQueryType(query: string): "symbol" | "class" | "path" {
  if (/[\\/]/.test(query) || /\.[a-z0-9]{1,8}$/i.test(query)) return "path";
  if (/^[A-Z][A-Za-z0-9_]*$/.test(query)) return "class";
  return "symbol";
}

function scoreDomainByPathHint(domain: AospDomainProfile, focusPath: string): number {
  const normalized = toPosixPath(focusPath).toLowerCase();
  let score = 0;
  for (const repo of domain.repos) {
    const repoLower = repo.toLowerCase();
    if (normalized === repoLower || normalized.startsWith(`${repoLower}/`)) score += 3;
  }
  for (const keyword of domain.warmModuleKeywords) {
    if (normalized.includes(keyword.toLowerCase())) score += 1;
  }
  return score;
}

function scoreDomainByModuleInfo(domain: AospDomainProfile, moduleInfo: ModuleInfoMap | null): number {
  if (!moduleInfo) return 0;
  let score = 0;
  for (const moduleName of domain.hotModules) {
    if (moduleInfo[moduleName]) score += 3;
  }
  const keywords = domain.warmModuleKeywords.map((x) => x.toLowerCase());
  for (const key of Object.keys(moduleInfo)) {
    const lower = key.toLowerCase();
    if (keywords.some((k) => lower.includes(k))) score += 1;
  }
  return score;
}

function inferDomain(input: {
  requestedDomain?: AospDomainKey;
  focusPath?: string;
  moduleInfo: ModuleInfoMap | null;
}): { domain: AospDomainKey; reason: string; scores: Record<AospDomainKey, number> } {
  if (input.requestedDomain) {
    return {
      domain: input.requestedDomain,
      reason: "explicit",
      scores: { audio: 0, video: 0, render: 0 },
    };
  }

  const domains = Object.values(AOSP_DOMAINS);
  const scores: Record<AospDomainKey, number> = { audio: 0, video: 0, render: 0 };
  for (const domain of domains) {
    scores[domain.id] += scoreDomainByModuleInfo(domain, input.moduleInfo);
    if (input.focusPath) scores[domain.id] += scoreDomainByPathHint(domain, input.focusPath);
  }

  const ranked = domains
    .map((domain) => ({ id: domain.id, score: scores[domain.id] }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    domain: ranked[0]?.id ?? "audio",
    reason: input.focusPath ? "focusPath+moduleInfo" : "moduleInfo",
    scores,
  };
}

async function resolveSearchRoots(input: {
  root: string;
  scope: AospScope;
  repo?: string;
  moduleName?: string;
  moduleInfo: ModuleInfoMap | null;
}): Promise<string[]> {
  if (input.moduleName) {
    const moduleRoots = getModulePaths(input.root, input.moduleInfo, input.moduleName);
    if (!moduleRoots.length) {
      throw new Error(
        `Module "${input.moduleName}" not found in module-info.json. Run resolveModule first or check build outputs.`
      );
    }
    const existing = await Promise.all(
      moduleRoots.map(async (value) => ((await pathExists(value)) ? value : null))
    );
    const cleaned = existing.filter((value): value is string => value !== null);
    if (!cleaned.length) {
      throw new Error(`Resolved module "${input.moduleName}" has no existing source paths`);
    }
    return Array.from(new Set(cleaned));
  }

  if (input.repo) {
    const safeRepo = validateRepo(input.repo);
    const repoRoot = path.join(input.root, safeRepo);
    if (!(await pathExists(repoRoot))) {
      throw new Error(`Repo path not found: ${safeRepo}`);
    }
    return [repoRoot];
  }

  return SCOPE_DIRS[input.scope]
    .map((item) => path.join(input.root, item))
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

async function findPathInRoots(root: string, roots: string[], query: string, limit: number) {
  const allMatches = await Promise.all(
    roots.map(async (cwd) => {
      if (!(await pathExists(cwd))) return [];
      const matches = await runRgFiles(cwd, query);
      return matches.map((match) => toPosixPath(path.join(cwd, match)));
    })
  );
  const flat = allMatches.flat();
  return Array.from(new Set(flat))
    .slice(0, limit)
    .map((target) => ({
      absolutePath: toPosixPath(target),
      relativePath: formatRelative(root, target),
    }));
}

async function countFilesInRoots(roots: string[]): Promise<number> {
  const counts = await Promise.all(
    roots.map(async (cwd) => {
      if (!(await pathExists(cwd))) return 0;
      const files = await runRgFiles(cwd, "");
      return files.length;
    })
  );
  return counts.reduce((acc, item) => acc + item, 0);
}

async function grepInRoots(input: {
  root: string;
  roots: string[];
  pattern: string;
  limit: number;
  literal: boolean;
  fileGlobs?: string[];
}) {
  const results: Array<Record<string, any>> = [];

  for (const cwd of input.roots) {
    if (!(await pathExists(cwd))) continue;
    const globArgs = input.fileGlobs?.flatMap((glob) => ["--glob", glob]).filter(Boolean) ?? [];
    const flags = input.literal ? ["--fixed-strings"] : [];
    const events = await runRgJson(cwd, input.pattern, [...flags, ...globArgs]);

    for (const event of events) {
      if (event.type !== "match") continue;
      const filePath = event.data.path.text as string;
      const absolutePath = toPosixPath(path.resolve(cwd, filePath));
      results.push({
        absolutePath,
        relativePath: formatRelative(input.root, absolutePath),
        line: event.data.line_number as number,
        column:
          event.data.submatches?.[0]?.start !== undefined
            ? Number(event.data.submatches[0].start) + 1
            : 1,
        match: (event.data.lines?.text as string)?.trim() || "",
      });
      if (results.length >= input.limit) return results;
    }
  }
  return results;
}

async function buildModuleIndexShard(input: {
  root: string;
  moduleName: string;
  moduleInfo: ModuleInfoMap | null;
  moduleInfoPath: string | null;
}) {
  const moduleRoots = getModulePaths(input.root, input.moduleInfo, input.moduleName);
  if (!moduleRoots.length) {
    throw new Error(`Module "${input.moduleName}" not found in module-info.json. Ensure build artifacts are ready.`);
  }
  const existingRoots = await Promise.all(
    moduleRoots.map(async (value) => ((await pathExists(value)) ? value : null))
  );
  const searchRoots = Array.from(
    new Set(existingRoots.filter((value): value is string => value !== null).map(toPosixPath))
  );
  if (!searchRoots.length) {
    throw new Error(`Resolved module "${input.moduleName}" has no existing source paths`);
  }

  const fileCount = await countFilesInRoots(searchRoots);
  const shard: ModuleIndexShard = {
    version: 1,
    moduleName: input.moduleName,
    root: toPosixPath(input.root),
    moduleInfoPath: input.moduleInfoPath ? toPosixPath(input.moduleInfoPath) : null,
    searchRoots,
    fileCount,
    createdAt: new Date().toISOString(),
  };
  const shardFile = await writeModuleShard(input.root, shard);
  return { shard, shardFile };
}

async function buildDomainIndexShard(input: {
  root: string;
  domain: AospDomainKey;
  maxWarmModules: number;
  moduleInfo: ModuleInfoMap | null;
  moduleInfoPath: string | null;
}) {
  const profile = AOSP_DOMAINS[input.domain];
  const hotIndexed: DomainIndexedModule[] = [];
  const warmIndexed: DomainIndexedModule[] = [];

  for (const moduleName of profile.hotModules) {
    try {
      const { shard } = await buildModuleIndexShard({
        root: input.root,
        moduleName,
        moduleInfo: input.moduleInfo,
        moduleInfoPath: input.moduleInfoPath,
      });
      hotIndexed.push({
        moduleName: shard.moduleName,
        fileCount: shard.fileCount,
        searchRoots: shard.searchRoots,
      });
    } catch {
      // Skip unavailable modules in current branch/product.
    }
  }

  const warmModules = discoverWarmModulesForDomain(input.moduleInfo, profile, input.maxWarmModules);
  for (const moduleName of warmModules) {
    try {
      const { shard } = await buildModuleIndexShard({
        root: input.root,
        moduleName,
        moduleInfo: input.moduleInfo,
        moduleInfoPath: input.moduleInfoPath,
      });
      warmIndexed.push({
        moduleName: shard.moduleName,
        fileCount: shard.fileCount,
        searchRoots: shard.searchRoots,
      });
    } catch {
      // Skip stale module-info entries.
    }
  }

  const repos = profile.repos
    .map((repo) => validateRepo(repo))
    .filter((repo, index, arr) => arr.indexOf(repo) === index);
  const moduleInfoMtimeMs = await getFileMtimeMs(input.moduleInfoPath);

  const shard: DomainIndexShard = {
    version: 1,
    domain: input.domain,
    root: toPosixPath(input.root),
    repos,
    hotModules: hotIndexed,
    warmModules: warmIndexed,
    moduleInfoPath: input.moduleInfoPath ? toPosixPath(input.moduleInfoPath) : null,
    moduleInfoMtimeMs,
    createdAt: new Date().toISOString(),
  };
  const shardFile = await writeDomainShard(input.root, shard);
  return { shard, shardFile };
}

async function runDomainQuery(input: {
  root: string;
  shard: DomainIndexShard;
  query: string;
  queryType: "symbol" | "class" | "path";
  mode: "auto" | "semantic" | "file" | "remote";
  allowRemote: boolean;
  limit: number;
  literal: boolean;
  lspManager?: LSPManager;
}) {
  const hotRoots = Array.from(new Set(input.shard.hotModules.flatMap((item) => item.searchRoots))).map((x) =>
    path.resolve(x)
  );
  const warmRoots = Array.from(new Set(input.shard.warmModules.flatMap((item) => item.searchRoots))).map((x) =>
    path.resolve(x)
  );
  const repoRoots = (
    await Promise.all(
      input.shard.repos.map(async (repo) => {
        const value = path.join(input.root, repo);
        return (await pathExists(value)) ? path.resolve(value) : null;
      })
    )
  ).filter((item): item is string => item !== null);

  const fileRoots = Array.from(new Set([...hotRoots, ...warmRoots, ...repoRoots]));
  const allowSemantic = (input.mode === "auto" || input.mode === "semantic") && input.queryType !== "path";
  const allowFile = input.mode === "auto" || input.mode === "file";
  const allowRemote = input.mode === "remote" || (input.mode === "auto" && input.allowRemote);

  const semanticResults = allowSemantic
    ? await querySemanticInDomain({
        lspManager: input.lspManager,
        allowedRoots: hotRoots,
        query: input.query,
        limit: input.limit,
      })
    : [];
  const semanticNormalized = semanticResults.map((item) => ({
    ...item,
    relativePath: formatRelative(input.root, item.absolutePath as string),
  }));

  let fileResults: Array<Record<string, any>> = [];
  if (allowFile && semanticNormalized.length < Math.min(5, input.limit)) {
    if (input.queryType === "path") {
      const matches = await findPathInRoots(input.root, fileRoots, input.query, input.limit);
      fileResults = matches.map((item) => ({
        tier: "file",
        source: "rg",
        confidence: inferConfidence(item.relativePath, input.query, "file"),
        ...item,
      }));
    } else if (input.queryType === "class") {
      const pattern = `(class|interface|enum|struct)\\s+${input.query}\\b`;
      const matches = await grepInRoots({
        root: input.root,
        roots: fileRoots,
        pattern,
        limit: input.limit,
        literal: false,
        fileGlobs: ["*.java", "*.kt", "*.aidl", "*.cc", "*.cpp", "*.h", "*.hpp"],
      });
      fileResults = matches.map((item) => ({
        tier: "file",
        source: "rg",
        confidence: inferConfidence(String(item.match ?? input.query), input.query, "file"),
        ...item,
      }));
    } else {
      const matches = await grepInRoots({
        root: input.root,
        roots: fileRoots,
        pattern: input.query,
        limit: input.limit,
        literal: input.literal,
      });
      fileResults = matches.map((item) => ({
        tier: "file",
        source: "rg",
        confidence: inferConfidence(String(item.match ?? input.query), input.query, "file"),
        ...item,
      }));
    }
  }

  const remoteResults = allowRemote ? buildRemoteCandidates(input.query, input.queryType, input.limit) : [];
  const preferredTier =
    semanticNormalized.length > 0 ? "semantic" : fileResults.length > 0 ? "file" : remoteResults.length > 0 ? "remote" : "none";

  return {
    preferredTier,
    coverage: {
      hotModules: input.shard.hotModules.length,
      warmModules: input.shard.warmModules.length,
      repos: input.shard.repos,
    },
    results: [...semanticNormalized, ...fileResults, ...remoteResults].slice(0, input.limit),
  };
}

export async function executeAospTool(context: AospToolContext, input: AospToolInput): Promise<Record<string, any>> {
  const detected = await detectAospRoot(context.workspaceRoot);
  const root = detected.root;

  if (input.operation === "detectRoot") {
    const detectedFromHint = input.hintPath ? await detectAospRoot(input.hintPath) : detected;
    return {
      operation: input.operation,
      root: toPosixPath(detectedFromHint.root),
      score: detectedFromHint.score,
      isAospLike: detectedFromHint.score >= 3,
      checked: detectedFromHint.checked.map(toPosixPath),
    };
  }

  if (detected.score < 2) {
    throw new Error(
      `Cannot confidently detect AOSP root from workspace (${context.workspaceRoot}). Try operation=detectRoot first.`
    );
  }

  const compileCommandsCandidates = [
    path.join(root, "compile_commands.json"),
    path.join(root, "out/soong/compile_commands.json"),
  ];

  if (input.operation === "listDomains") {
    return {
      operation: input.operation,
      domains: Object.values(AOSP_DOMAINS),
    };
  }

  if (input.operation === "listPresets") {
    return {
      operation: input.operation,
      presets: Object.values(AOSP_PRESETS),
    };
  }

  const moduleInfoState = await loadModuleInfo(root);
  const moduleInfo = moduleInfoState.data;

  if (input.operation === "init") {
    const moduleInfoMtimeMs = await getFileMtimeMs(moduleInfoState.path);
    const compileCommandsFound = (
      await Promise.all(
        compileCommandsCandidates.map(async (candidate) => ((await pathExists(candidate)) ? candidate : null))
      )
    ).filter((item): item is string => item !== null);

    const inferred = inferDomain({
      requestedDomain: input.domain,
      focusPath: input.focusPath,
      moduleInfo,
    });
    const { shard, shardFile } = await buildDomainIndexShard({
      root,
      domain: inferred.domain,
      maxWarmModules: input.maxWarmModules,
      moduleInfo,
      moduleInfoPath: moduleInfoState.path,
    });

    return {
      operation: input.operation,
      root: toPosixPath(root),
      environment: {
        moduleInfoPath: moduleInfoState.path ? toPosixPath(moduleInfoState.path) : null,
        moduleInfoReady: Boolean(moduleInfoState.path && moduleInfo),
        moduleInfoMtimeMs,
        compileCommandsCandidates: compileCommandsCandidates.map(toPosixPath),
        compileCommandsPath: compileCommandsFound.length ? toPosixPath(compileCommandsFound[0]) : null,
        compileCommandsReady: compileCommandsFound.length > 0,
      },
      domain: {
        selected: inferred.domain,
        reason: inferred.reason,
        scores: inferred.scores,
      },
      index: {
        shardFile: toPosixPath(shardFile),
        repos: shard.repos,
        hotModules: shard.hotModules.length,
        warmModules: shard.warmModules.length,
        totalIndexedModules: shard.hotModules.length + shard.warmModules.length,
      },
      next: {
        operation: "search",
        arguments: {
          query: "ActivityManagerService",
          domain: inferred.domain,
          queryType: "auto",
          limit: 20,
        },
      },
    };
  }

  if (input.operation === "search") {
    const inferred = inferDomain({
      requestedDomain: input.domain,
      moduleInfo,
    });
    let shard = await readDomainShard(root, inferred.domain);
    if (!shard) {
      const built = await buildDomainIndexShard({
        root,
        domain: inferred.domain,
        maxWarmModules: DEFAULT_DOMAIN_MAX_WARM_MODULES,
        moduleInfo,
        moduleInfoPath: moduleInfoState.path,
      });
      shard = built.shard;
    }

    const queryType = input.queryType === "auto" ? inferQueryType(input.query) : input.queryType;
    const domainResult = await runDomainQuery({
      root,
      shard,
      query: input.query,
      queryType,
      mode: "auto",
      allowRemote: input.allowRemote,
      limit: input.limit,
      literal: true,
      lspManager: context.lspManager,
    });
    return {
      operation: input.operation,
      root: toPosixPath(root),
      domain: inferred.domain,
      query: input.query,
      queryType,
      preferredTier: domainResult.preferredTier,
      coverage: domainResult.coverage,
      results: domainResult.results,
    };
  }

  if (input.operation === "indexDomain") {
    const { shard, shardFile } = await buildDomainIndexShard({
      root,
      domain: input.domain,
      maxWarmModules: input.maxWarmModules,
      moduleInfo,
      moduleInfoPath: moduleInfoState.path,
    });
    return {
      operation: input.operation,
      root: toPosixPath(root),
      domain: input.domain,
      shardFile: toPosixPath(shardFile),
      repos: shard.repos,
      hotModules: shard.hotModules,
      warmModules: shard.warmModules,
      moduleInfoPath: shard.moduleInfoPath,
      moduleInfoMtimeMs: shard.moduleInfoMtimeMs,
      totalIndexedModules: shard.hotModules.length + shard.warmModules.length,
    };
  }

  if (input.operation === "queryDomain") {
    const shard = await readDomainShard(root, input.domain);
    if (!shard) {
      throw new Error(`Domain "${input.domain}" is not indexed yet. Run indexDomain first.`);
    }
    const domainResult = await runDomainQuery({
      root,
      shard,
      query: input.query,
      queryType: input.queryType,
      mode: input.mode,
      allowRemote: input.allowRemote,
      limit: input.limit,
      literal: input.literal,
      lspManager: context.lspManager,
    });

    return {
      operation: input.operation,
      root: toPosixPath(root),
      domain: input.domain,
      query: input.query,
      queryType: input.queryType,
      mode: input.mode,
      preferredTier: domainResult.preferredTier,
      coverage: domainResult.coverage,
      results: domainResult.results,
    };
  }

  if (input.operation === "resolveModule") {
    const moduleRoots = getModulePaths(root, moduleInfo, input.moduleName);
    return {
      operation: input.operation,
      root: toPosixPath(root),
      moduleInfoPath: moduleInfoState.path ? toPosixPath(moduleInfoState.path) : null,
      moduleName: input.moduleName,
      resolvedPaths: moduleRoots.map(toPosixPath),
      found: moduleRoots.length > 0,
    };
  }

  if (input.operation === "indexModule") {
    const { shard, shardFile } = await buildModuleIndexShard({
      root,
      moduleName: input.moduleName,
      moduleInfo,
      moduleInfoPath: moduleInfoState.path,
    });
    return {
      operation: input.operation,
      root: toPosixPath(root),
      moduleName: input.moduleName,
      shardFile: toPosixPath(shardFile),
      searchRoots: shard.searchRoots,
      fileCount: shard.fileCount,
      moduleInfoPath: shard.moduleInfoPath,
    };
  }

  if (input.operation === "indexPreset") {
    const preset = AOSP_PRESETS[input.preset];
    const modules = discoverModulesForPreset(moduleInfo, preset, input.maxModules);
    if (!modules.length) {
      throw new Error(
        `No modules discovered for preset "${input.preset}". Ensure module-info.json is available and up to date.`
      );
    }

    const indexed: Array<{ moduleName: string; fileCount: number }> = [];
    for (const moduleName of modules) {
      try {
        const { shard } = await buildModuleIndexShard({
          root,
          moduleName,
          moduleInfo,
          moduleInfoPath: moduleInfoState.path,
        });
        indexed.push({ moduleName, fileCount: shard.fileCount });
      } catch {
        // Skip invalid/stale module entries.
      }
    }
    if (!indexed.length) {
      throw new Error(`Preset "${input.preset}" discovered modules but none could be indexed.`);
    }

    const presetShard: PresetIndexShard = {
      version: 1,
      preset: input.preset,
      root: toPosixPath(root),
      repos: preset.repos,
      modules: indexed.map((item) => item.moduleName),
      createdAt: new Date().toISOString(),
    };
    const presetShardFile = await writePresetShard(root, presetShard);
    return {
      operation: input.operation,
      root: toPosixPath(root),
      preset: input.preset,
      presetTitle: preset.title,
      presetShardFile: toPosixPath(presetShardFile),
      indexedModules: indexed,
      moduleInfoPath: moduleInfoState.path ? toPosixPath(moduleInfoState.path) : null,
    };
  }

  if (input.operation === "queryPresetSymbol") {
    const presetShard = await readPresetShard(root, input.preset);
    if (!presetShard) {
      throw new Error(`Preset "${input.preset}" is not indexed yet. Run indexPreset first.`);
    }
    const moduleShards = await Promise.all(
      presetShard.modules.map((moduleName) => readModuleShard(root, moduleName))
    );
    const valid = moduleShards.filter((item): item is ModuleIndexShard => item !== null);
    if (!valid.length) {
      throw new Error(`Preset "${input.preset}" has no valid module shards. Run indexPreset again.`);
    }
    const mergedRoots = Array.from(new Set(valid.flatMap((shard) => shard.searchRoots)));
    const results = await grepInRoots({
      root,
      roots: mergedRoots,
      pattern: input.symbol,
      limit: input.limit,
      literal: input.literal,
    });
    return {
      operation: input.operation,
      root: toPosixPath(root),
      preset: input.preset,
      queriedModules: valid.map((item) => item.moduleName),
      searchRoots: mergedRoots.map(toPosixPath),
      results,
    };
  }

  if (input.operation === "queryIndexedSymbol") {
    let shards: ModuleIndexShard[];
    if (input.moduleName) {
      shards = [await readModuleShard(root, input.moduleName)].filter(
        (item): item is ModuleIndexShard => item !== null
      );
    } else if (input.preset) {
      const presetShard = await readPresetShard(root, input.preset);
      if (!presetShard) {
        throw new Error(`Preset "${input.preset}" is not indexed yet. Run indexPreset first.`);
      }
      const moduleShards = await Promise.all(
        presetShard.modules.map((moduleName) => readModuleShard(root, moduleName))
      );
      shards = moduleShards.filter((item): item is ModuleIndexShard => item !== null);
    } else {
      shards = await readAllModuleShards(root);
    }
    if (!shards.length) {
      throw new Error(
        input.moduleName
          ? `Indexed module "${input.moduleName}" not found. Run indexModule first.`
          : input.preset
            ? `No indexed modules found for preset "${input.preset}". Run indexPreset first.`
            : "No indexed modules found. Run indexModule or indexPreset first."
      );
    }

    const mergedRoots = Array.from(new Set(shards.flatMap((shard) => shard.searchRoots)));
    const results = await grepInRoots({
      root,
      roots: mergedRoots,
      pattern: input.symbol,
      limit: input.limit,
      literal: input.literal,
    });
    return {
      operation: input.operation,
      root: toPosixPath(root),
      queriedModules: shards.map((shard) => shard.moduleName),
      searchRoots: mergedRoots.map(toPosixPath),
      results,
    };
  }

  if (input.operation === "findPath") {
    const roots = await resolveSearchRoots({
      root,
      scope: input.scope,
      repo: input.repo,
      moduleName: input.moduleName,
      moduleInfo,
    });
    return {
      operation: input.operation,
      root: toPosixPath(root),
      searchRoots: roots.map(toPosixPath),
      moduleInfoPath: moduleInfoState.path ? toPosixPath(moduleInfoState.path) : null,
      results: await findPathInRoots(root, roots, input.query, input.limit),
    };
  }

  if (input.operation === "findSymbol") {
    const roots = await resolveSearchRoots({
      root,
      scope: input.scope,
      repo: input.repo,
      moduleName: input.moduleName,
      moduleInfo,
    });
    return {
      operation: input.operation,
      root: toPosixPath(root),
      searchRoots: roots.map(toPosixPath),
      moduleInfoPath: moduleInfoState.path ? toPosixPath(moduleInfoState.path) : null,
      results: await grepInRoots({
        root,
        roots,
        pattern: input.symbol,
        limit: input.limit,
        literal: input.literal,
      }),
    };
  }

  if (input.operation === "findClass") {
    const roots = await resolveSearchRoots({
      root,
      scope: input.scope,
      repo: input.repo,
      moduleName: input.moduleName,
      moduleInfo,
    });
    const pattern = `(class|interface|enum|struct)\\s+${input.className}\\b`;
    return {
      operation: input.operation,
      root: toPosixPath(root),
      searchRoots: roots.map(toPosixPath),
      moduleInfoPath: moduleInfoState.path ? toPosixPath(moduleInfoState.path) : null,
      results: await grepInRoots({
        root,
        roots,
        pattern,
        limit: input.limit,
        literal: false,
        fileGlobs: ["*.java", "*.kt", "*.aidl", "*.cc", "*.cpp", "*.h", "*.hpp"],
      }),
    };
  }

  const fromModuleInfo = getModulePaths(root, moduleInfo, input.moduleName);
  if (fromModuleInfo.length) {
    return {
      operation: input.operation,
      root: toPosixPath(root),
      moduleInfoPath: moduleInfoState.path ? toPosixPath(moduleInfoState.path) : null,
      moduleName: input.moduleName,
      results: fromModuleInfo.map((value) => ({
        absolutePath: toPosixPath(value),
        relativePath: formatRelative(root, value),
        source: "module-info.json",
      })),
    };
  }

  const roots = await resolveSearchRoots({
    root,
    scope: input.scope,
    repo: input.repo,
    moduleInfo,
  });
  return {
    operation: input.operation,
    root: toPosixPath(root),
    searchRoots: roots.map(toPosixPath),
    moduleInfoPath: moduleInfoState.path ? toPosixPath(moduleInfoState.path) : null,
    moduleName: input.moduleName,
    results: await grepInRoots({
      root,
      roots,
      pattern: `name\\s*:\\s*"${input.moduleName}"`,
      limit: input.limit,
      literal: false,
      fileGlobs: ["Android.bp"],
    }),
  };
}

export const AOSP_TOOL_DESCRIPTION = `AOSP-optimized navigation and lookup tool.

Design constraints:
- Never scan whole AOSP root directly
- Text search is restricted by repo/scope/module
- Prefer module-info.json (AIDEgen style) for module path resolution
- Supports role-based presets (audio/driver/system_server)

Supported operations:
- detectRoot: Detect AOSP source root by anchor folders (.repo, build/soong, frameworks/base, system/core)
- init: One-command initialization (artifact checks + domain inference + domain indexing)
- search: Daily auto search (auto-domain + progressive semantic/file/optional-remote routing)
- listDomains: List built-in domain profiles (audio/video/render)
- indexDomain: Build/update domain-local index shards with hot/warm module strategy
- queryDomain: Progressive query in one domain (semantic -> file -> optional remote)
- listPresets: List built-in preset profiles
- resolveModule: Resolve module source paths from module-info.json
- indexModule: Build/update local partial index shard for one module
- indexPreset: Build/update local partial index shards for a preset
- queryIndexedSymbol: Query symbols within indexed module shards
- queryPresetSymbol: Query symbols within modules indexed by one preset
- findPath: Locate file/path in a restricted search root
- findSymbol: Search symbol text in a restricted search root
- findClass: Locate Java/C++ class or interface definitions in restricted roots
- findModule: Locate module by name (module-info first, Android.bp fallback)`;
