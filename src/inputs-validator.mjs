/**
 * Minimal JSON Schema validator for tools-catalog inputs schemas.
 *
 * Supports the subset of JSON Schema actually used in tools-catalog.json:
 *   - type: object | string | number | integer | boolean | array
 *   - required: string[]
 *   - properties: { fieldName: <fieldSchema> }
 *   - enum: any[]
 *   - minimum / maximum (number, integer)
 *   - items (for arrays)
 *   - oneOf: [schema, ...]   (treated as "any-of" — passes if any branch matches)
 *
 * We intentionally avoid pulling in ajv to keep the CLI dep tree small.
 *
 * @returns {{ ok: boolean, errors: Array<{ field: string, message: string, kind: "missing"|"type"|"enum"|"range"|"other" }> }}
 */
export function validateInputs(inputs, schema) {
  const errors = [];
  if (!schema) return { ok: true, errors };

  // root must be an object
  if (schema.type === "object" || schema.properties || schema.required) {
    if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
      errors.push({ field: "(root)", kind: "type", message: "inputs must be a JSON object" });
      return { ok: false, errors };
    }
  }

  // Required fields
  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      const v = inputs[field];
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
        errors.push({ field, kind: "missing", message: `required field "${field}" is missing` });
      }
    }
  }

  // Per-field validation
  if (schema.properties) {
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
      if (inputs[field] === undefined || inputs[field] === null) continue;
      errors.push(...validateField(field, inputs[field], fieldSchema));
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateField(field, value, schema) {
  const errors = [];

  // oneOf: pass if any branch accepts (no errors).
  if (Array.isArray(schema.oneOf)) {
    const branchErrors = schema.oneOf.map((sub) => validateField(field, value, sub));
    const anyPass = branchErrors.some((errs) => errs.length === 0);
    if (!anyPass) {
      errors.push({
        field,
        kind: "type",
        message: `value does not match any of oneOf schemas (tried ${schema.oneOf.length} branches)`,
      });
    }
    return errors;
  }

  // Type check
  if (schema.type) {
    if (!checkType(value, schema.type)) {
      errors.push({
        field,
        kind: "type",
        message: `expected type "${schema.type}", got "${actualType(value)}"`,
      });
      return errors; // bail out on type mismatch
    }
  }

  // Enum
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({
      field,
      kind: "enum",
      message: `value ${JSON.stringify(value)} must be one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
    });
  }

  // Number range
  if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push({ field, kind: "range", message: `value ${value} is below minimum ${schema.minimum}` });
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push({ field, kind: "range", message: `value ${value} is above maximum ${schema.maximum}` });
    }
  }

  // Array items
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validateField(`${field}[${i}]`, item, schema.items));
    });
  }

  return errors;
}

function checkType(value, type) {
  switch (type) {
    case "object":  return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":   return Array.isArray(value);
    case "string":  return typeof value === "string";
    case "number":  return typeof value === "number" && !Number.isNaN(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null":    return value === null;
    default:        return true;
  }
}

function actualType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
