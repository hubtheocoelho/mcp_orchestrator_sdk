import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "@mcp-orchestrator/core";

/**
 * A small filesystem domain exposed as SDK tools, sandboxed to `baseDir`. Every
 * path is resolved against the base and rejected if it escapes it, so the tools
 * are safe to hand to an agent. This mirrors how the original monolith's
 * filesystem tools become plain, registrable ToolDefinitions under the SDK.
 */
export function filesystemDomain(baseDir: string): ToolDefinition[] {
  const root = resolve(baseDir);

  const safePath = (path: string): string => {
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path escapes sandbox: ${path}`);
    }
    return target;
  };

  const readFileTool: ToolDefinition<{ path: string }, string> = {
    id: "filesystem.read_file",
    description: "Read a UTF-8 text file within the sandbox",
    safety: "read-only",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the sandbox root" } },
      required: ["path"],
    },
    execute: async ({ path }) => readFile(safePath(path), "utf8"),
  };

  const writeFileTool: ToolDefinition<{ path: string; content: string }, { bytes: number }> = {
    id: "filesystem.write_file",
    description: "Write a UTF-8 text file within the sandbox",
    safety: "write",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the sandbox root" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    execute: async ({ path, content }) => {
      await writeFile(safePath(path), content, "utf8");
      return { bytes: Buffer.byteLength(content, "utf8") };
    },
  };

  const listFilesTool: ToolDefinition<{ dir?: string }, string[]> = {
    id: "filesystem.list_files",
    description: "List entries of a directory within the sandbox",
    safety: "read-only",
    schema: {
      type: "object",
      properties: { dir: { type: "string", description: "Directory relative to the sandbox root" } },
    },
    execute: async ({ dir }) => readdir(safePath(dir ?? ".")),
  };

  return [readFileTool, writeFileTool, listFilesTool];
}
