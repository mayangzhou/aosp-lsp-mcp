import { z } from "zod";
import type { LSPManager } from "../lsp/index.js";

export const LSP_OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const;

export type LSPOperation = (typeof LSP_OPERATIONS)[number];

const PositionSchema = z.object({
  filePath: z.string().describe("The absolute or relative path to the file"),
  line: z.number().int().min(1).describe("The line number (1-based, as shown in editors)"),
  character: z.number().int().min(1).describe("The character offset (1-based, as shown in editors)"),
});

export const LspToolSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("goToDefinition"), ...PositionSchema.shape }),
  z.object({ operation: z.literal("findReferences"), ...PositionSchema.shape }),
  z.object({ operation: z.literal("hover"), ...PositionSchema.shape }),
  z.object({ operation: z.literal("goToImplementation"), ...PositionSchema.shape }),
  z.object({ operation: z.literal("prepareCallHierarchy"), ...PositionSchema.shape }),
  z.object({ operation: z.literal("incomingCalls"), ...PositionSchema.shape }),
  z.object({ operation: z.literal("outgoingCalls"), ...PositionSchema.shape }),
  z.object({
    operation: z.literal("documentSymbol"),
    filePath: z.string().describe("The absolute or relative path to the file"),
  }),
  z.object({
    operation: z.literal("workspaceSymbol"),
    query: z.string().default("").describe("Optional symbol query string"),
  }),
]);

export type LspToolInput = z.infer<typeof LspToolSchema>;

export async function executeLspTool(
  lspManager: LSPManager,
  input: LspToolInput
): Promise<any> {
  const toPosition = (value: Extract<
    LspToolInput,
    { filePath: string; line: number; character: number }
  >) => ({
    file: value.filePath,
    line: value.line - 1,
    character: value.character - 1,
  });

  switch (input.operation) {
    case "goToDefinition": {
      const position = toPosition(input);
      await lspManager.touchFile(input.filePath);
      return lspManager.definition(position);
    }
    case "findReferences": {
      const position = toPosition(input);
      await lspManager.touchFile(input.filePath);
      return lspManager.references(position);
    }
    case "hover": {
      const position = toPosition(input);
      await lspManager.touchFile(input.filePath);
      return lspManager.hover(position);
    }
    case "documentSymbol":
      await lspManager.touchFile(input.filePath);
      return lspManager.documentSymbol(input.filePath);
    case "workspaceSymbol":
      return lspManager.workspaceSymbol(input.query);
    case "goToImplementation": {
      const position = toPosition(input);
      await lspManager.touchFile(input.filePath);
      return lspManager.implementation(position);
    }
    case "prepareCallHierarchy": {
      const position = toPosition(input);
      await lspManager.touchFile(input.filePath);
      return lspManager.prepareCallHierarchy(position);
    }
    case "incomingCalls": {
      const position = toPosition(input);
      await lspManager.touchFile(input.filePath);
      return lspManager.incomingCalls(position);
    }
    case "outgoingCalls": {
      const position = toPosition(input);
      await lspManager.touchFile(input.filePath);
      return lspManager.outgoingCalls(position);
    }
  }
}

export const LSP_TOOL_DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace (supports optional query)
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

Parameters:
- Position-based operations require filePath, line, character
- documentSymbol requires filePath
- workspaceSymbol accepts optional query

Note: LSP servers must be configured for the file type.`;
