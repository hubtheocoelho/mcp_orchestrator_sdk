import type { JsonObject } from "@mcp-orchestrator/core";
import type { InputRequest, WorkflowDefinition } from "@mcp-orchestrator/workflow";

/** A flat JSON Schema object, the shape MCP tools and elicitation accept. */
export interface ObjectSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  [key: string]: unknown;
}

/** Schema used for a `needs_input` request that declares none: one free-text answer. */
export const DEFAULT_INPUT_SCHEMA: ObjectSchema = {
  type: "object",
  properties: { value: { type: "string", description: "Your answer" } },
  required: ["value"],
};

/** The tool `inputSchema` derived from a workflow's declared inputs. */
export function workflowInputSchema(definition: WorkflowDefinition): ObjectSchema {
  const properties: ObjectSchema["properties"] = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(definition.inputs)) {
    const property: Record<string, unknown> = {};
    if (spec.type) property.type = spec.type;
    if (spec.description) property.description = spec.description;
    if (spec.default !== undefined) property.default = spec.default;
    properties[name] = property;
    if (spec.required && spec.default === undefined) required.push(name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** The request schema of a `needs_input` step, defaulted and normalised to an object schema. */
export function requestSchema(request: InputRequest): ObjectSchema {
  const schema = request.schema;
  if (!schema || typeof schema.properties !== "object" || schema.properties === null) {
    return DEFAULT_INPUT_SCHEMA;
  }
  return { ...schema, type: "object", properties: schema.properties as ObjectSchema["properties"] };
}

/**
 * Validate an answer against a flat request schema: object shape, required
 * keys, primitive `type`s and `enum`s. Returns the problems found (empty when valid).
 */
export function validateInput(schema: ObjectSchema, value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["input must be an object"];
  }
  const input = value as JsonObject;
  const errors: string[] = [];
  for (const key of schema.required ?? []) {
    if (input[key] === undefined) errors.push(`missing required field "${key}"`);
  }
  for (const [key, field] of Object.entries(input)) {
    const spec = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (!spec) {
      if (schema.additionalProperties === false) errors.push(`unexpected field "${key}"`);
      continue;
    }
    if (typeof spec.type === "string" && !matchesType(spec.type, field)) {
      errors.push(`field "${key}" must be ${spec.type}`);
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(field)) {
      errors.push(`field "${key}" must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  }
  return errors;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
