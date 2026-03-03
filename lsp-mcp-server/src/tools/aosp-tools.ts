import { promisify } from "util";
import { execFile } from "child_process";
import path from "path";
import fs from "fs/promises";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 30;
const INDEX_DIR_NAME = ".lsp-mcp-aosp-index";
const DEFAULT_PRESET_MAX_MODULES = 80;

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

function moduleShardPath(root: string, moduleName: string): string {
  const safe = moduleName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(moduleIndexDir(root), `${safe}.json`);
}

function presetShardPath(root: string, preset: AospPresetKey): string {
  return path.join(presetIndexDir(root), `${preset}.json`);
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

  if (input.operation === "listPresets") {
    return {
      operation: input.operation,
      presets: Object.values(AOSP_PRESETS),
    };
  }

  const moduleInfoState = await loadModuleInfo(root);
  const moduleInfo = moduleInfoState.data;

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
