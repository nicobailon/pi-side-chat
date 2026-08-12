import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * config.json `promptPack` manifest (#13): each value is a path relative to
 * the extension dir, or an absolute path. All keys are optional — an absent
 * or unreadable key falls back to the bundled `prompts/` default.
 */
export interface PromptPackManifest {
  framing?: string;
  focusAnchor?: string;
  laneReminders?: {
    base?: string;
    escalated?: string;
    failedNote?: string;
    preamble?: string;
  };
}

/** Fully resolved prompt texts after manifest resolution + file reads. */
export interface PromptPack {
  framing: string;
  focusAnchor: string;
  laneReminders: {
    base: string;
    escalated: string;
    failedNote: string;
    preamble: string;
  };
}

/** Bundled defaults, shipped git-tracked in `prompts/` (#14 drafts). */
const BUNDLED_PATHS = {
  framing: "prompts/btw-framing.md",
  focusAnchor: "prompts/btw-focus-anchor.md",
  laneReminders: {
    base: "prompts/lane-reminder-base.md",
    escalated: "prompts/lane-reminder-escalated.md",
    failedNote: "prompts/lane-failed-note.md",
    preamble: "prompts/lane-preamble.md",
  },
} as const;

/** Extension directory (dirname of this module): base for relative paths. */
export function getExtensionDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Load the prompt pack fresh — no caching, every fork re-reads the manifest
 * files so edits apply on the next fork. Per-key fallback (#13):
 *
 * - configured path missing/unreadable → bundled default + notify warning;
 * - bundled default unreadable (packaging error) → empty text + notify.
 */
export function loadPromptPack(
  manifest: PromptPackManifest | undefined,
  options: { extensionDir: string; notify: (message: string) => void },
): PromptPack {
  const read = (key: string, configured: string | undefined, bundled: string): string => {
    if (configured && configured.trim()) {
      try {
        return readFileSync(resolvePath(options.extensionDir, configured), "utf-8").trim();
      } catch {
        options.notify(`promptPack ${key}: cannot read "${configured}" — falling back to the bundled default`);
      }
    }
    try {
      return readFileSync(resolvePath(options.extensionDir, bundled), "utf-8").trim();
    } catch {
      options.notify(`promptPack ${key}: bundled default "${bundled}" unreadable — using empty prompt text`);
      return "";
    }
  };

  const laneReminders = manifest?.laneReminders ?? {};
  return {
    framing: read("framing", manifest?.framing, BUNDLED_PATHS.framing),
    focusAnchor: read("focusAnchor", manifest?.focusAnchor, BUNDLED_PATHS.focusAnchor),
    laneReminders: {
      base: read("laneReminders.base", laneReminders.base, BUNDLED_PATHS.laneReminders.base),
      escalated: read("laneReminders.escalated", laneReminders.escalated, BUNDLED_PATHS.laneReminders.escalated),
      failedNote: read("laneReminders.failedNote", laneReminders.failedNote, BUNDLED_PATHS.laneReminders.failedNote),
      preamble: read("laneReminders.preamble", laneReminders.preamble, BUNDLED_PATHS.laneReminders.preamble),
    },
  };
}

/**
 * Template substitution (#13): replaces `{{name}}` with the given value.
 * Undefined variables are left as-is (typos stay visible, never swallowed).
 * Framing vars: `{{cwd}}` `{{model}}`; lane reminder vars: `{{tool}}` `{{count}}`.
 */
export function substituteTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

function resolvePath(extensionDir: string, path: string): string {
  return isAbsolute(path) ? path : join(extensionDir, path);
}
