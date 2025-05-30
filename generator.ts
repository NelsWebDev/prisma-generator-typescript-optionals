import type { DMMF } from "@prisma/generator-helper";
import generatorHelper from "@prisma/generator-helper";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Need to use default export for ESM compatibility
const { generatorHandler } = generatorHelper;

interface Config {
  enumPrefix: string;
  enumSuffix: string;
  enumObjectPrefix: string;
  enumObjectSuffix: string;
  modelPrefix: string;
  modelSuffix: string;
  typePrefix: string;
  typeSuffix: string;
  headerComment: string;
  modelType: "interface" | "type";
  enumType: "stringUnion" | "enum" | "object";
  dateType: "Date" | "string" | "number";
  bigIntType: "bigint" | "string" | "number";
  decimalType: "Decimal" | "string" | "number";
  bytesType: "Uint8Array" | "Buffer" | "ArrayObject" | "BufferObject" | "string" | "number[]";
  exportEnums: boolean;
  optionalRelations: boolean;
  omitRelations: boolean;
  optionalNullables: boolean;
  prettier: boolean;
  resolvePrettierConfig: boolean;
}

// Map of Prisma scalar types to Typescript type getters
const SCALAR_TYPE_GETTERS: Record<string, (config: Config) => string> = {
  String: () => "string",
  Boolean: () => "boolean",
  Int: () => "number",
  Float: () => "number",
  Json: () => "JsonValue",
  DateTime: (config) => config.dateType,
  BigInt: (config) => config.bigIntType,
  Decimal: (config) => config.decimalType,
  Bytes: (config) => config.bytesType,
};

// Since we want the output to have zero dependencies, define custom types which are compatible
// with the actual Prisma types. If users need the real Prisma types, they can cast to them.
const CUSTOM_TYPES = {
  ArrayObject: "type ArrayObject = { [index: number]: number } & { length?: never };",
  BufferObject: 'type BufferObject = { type: "Buffer"; data: number[] };',
  Decimal: "type Decimal = { valueOf(): string };",
  JsonValue:
    "type JsonValue = string | number | boolean | { [key in string]?: JsonValue } | Array<JsonValue> | null;",
};

function validateConfig(config: Config) {
  const errors: string[] = [];
  if (!["interface", "type"].includes(config.modelType)) {
    errors.push(`Invalid modelType: ${config.modelType}`);
  }
  if (!["stringUnion", "enum", "object"].includes(config.enumType)) {
    errors.push(`Invalid enumType: ${config.enumType}`);
  }
  if (!["Date", "string", "number"].includes(config.dateType)) {
    errors.push(`Invalid dateType: ${config.dateType}`);
  }
  if (!["bigint", "string", "number"].includes(config.bigIntType)) {
    errors.push(`Invalid bigIntType: ${config.bigIntType}`);
  }
  if (!["Decimal", "string", "number"].includes(config.decimalType)) {
    errors.push(`Invalid decimalType: ${config.decimalType}`);
  }
  if (
    !["Uint8Array", "Buffer", "ArrayObject", "BufferObject", "string", "number[]"].includes(
      config.bytesType,
    )
  ) {
    errors.push(`Invalid bytesType: ${config.bytesType}`);
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

// Get the Typescript code representing a Prisma Enum
function getEnumTs(
  config: Config,
  enumData: DMMF.DatamodelEnum,
  enumNameMap: Map<string, string>,
): string {
  const exportKwd = config.exportEnums ? "export " : "";
  switch (config.enumType) {
    case "enum": {
      const enumValues = enumData.values.map(({ name }) => `  ${name} = "${name}"`).join(",\n");
      return `${exportKwd}enum ${enumNameMap.get(enumData.name)} {\n${enumValues}\n}`;
    }
    case "stringUnion": {
      const enumValues = enumData.values.map(({ name }) => `"${name}"`).join(" | ");
      return `${exportKwd}type ${enumNameMap.get(enumData.name)} = ${enumValues};`;
    }
    case "object": {
      const enumValues = enumData.values.map(({ name }) => `  ${name}: "${name}"`).join(",\n");
      const enumName = enumNameMap.get(enumData.name);
      const enumObjectName = `${config.enumObjectPrefix}${enumName}${config.enumObjectSuffix}`;
      const enumType = enumData.values.map(({ name }) => `"${name}"`).join(" | ");
      return `${exportKwd}type ${enumName} = ${enumType};\n\n${exportKwd}const ${enumObjectName} = {\n${enumValues}\n} satisfies Record<string, ${enumName}>;`;
    }
    default:
      throw new Error(`Unknown enumType: ${config.enumType}`);
  }
}

// Get the Typescript code representing a Prisma Model
function getModelTs(
  config: Config,
  modelData: DMMF.Model,
  modelNameMap: Map<string, string>,
  enumNameMap: Map<string, string>,
  typeNameMap: Map<string, string>,
  usedCustomTypes: Set<keyof typeof CUSTOM_TYPES>,
): string {
  const getDefinition = (
    name: string,
    resolvedType: string,
    opts: { isRequired: boolean; isList: boolean; isRelation: boolean },
  ) => {
    const { isRequired, isList, isRelation } = opts;

    const makeOptional =
      (!isRequired && config.optionalNullables && !isRelation) ||
      (isRelation && !isRequired && config.optionalRelations);

    const typeStr = `${resolvedType}${isList ? "[]" : ""}`;
    const finalType = makeOptional
      ? typeStr
      : `${typeStr}${!isRequired && !makeOptional ? " | undefined" : ""}`;

    return `  ${name}${makeOptional ? "?" : ""}: ${finalType};`;
  };

  const fields = modelData.fields
    .map(({ name, kind, type, isRequired, isList }) => {
      switch (kind) {
        case "scalar": {
          const typeGetter = SCALAR_TYPE_GETTERS[type];
          if (!typeGetter) {
            throw new Error(`Unknown scalar type: ${type}`);
          }
          const resolvedType = typeGetter(config);
          if (resolvedType in CUSTOM_TYPES) {
            usedCustomTypes.add(resolvedType as keyof typeof CUSTOM_TYPES);
          }
          return getDefinition(name, resolvedType, {
            isRequired,
            isList,
            isRelation: false,
          });
        }
        case "enum": {
          const enumName = enumNameMap.get(type);
          if (!enumName) {
            throw new Error(`Unknown enum name: ${type}`);
          }
          return getDefinition(name, enumName, {
            isRequired,
            isList,
            isRelation: false,
          });
        }
        case "object": {
          if (config.omitRelations) return null;

          const modelName = modelNameMap.get(type);
          const typeName = typeNameMap.get(type);
          const resolvedType = typeName ?? modelName;

          if (!resolvedType) {
            throw new Error(`Unknown model/type name: ${type}`);
          }

          return getDefinition(name, resolvedType, {
            isRequired,
            isList,
            isRelation: true,
          });
        }
        case "unsupported":
          return getDefinition(name, "any", {
            isRequired,
            isList,
            isRelation: false,
          });
        default:
          throw new Error(`Unknown field kind: ${kind}`);
      }
    })
    .filter((f) => f !== null)
    .join("\n");

  const name = modelNameMap.get(modelData.name) ?? typeNameMap.get(modelData.name);

  switch (config.modelType) {
    case "interface":
      return `export interface ${name} {\n${fields}\n}`;
    case "type":
      return `export type ${name} = {\n${fields}\n};`;
    default:
      throw new Error(`Unknown modelType: ${config.modelType}`);
  }
}

generatorHandler({
  onManifest() {
    return {
      prettyName: "Typescript Interfaces",
      defaultOutput: "interfaces.ts",
    };
  },
  async onGenerate(options) {
    const baseConfig = options.generator.config;
    const config: Config = {
      enumPrefix: "",
      enumSuffix: "",
      enumObjectPrefix: "",
      enumObjectSuffix: "",
      modelPrefix: "",
      modelSuffix: "",
      typePrefix: "",
      typeSuffix: "",
      headerComment:
        "This file was auto-generated by @nelswebdev/prisma-generator-typescript-optionals",
      modelType: "interface",
      enumType: "stringUnion",
      dateType: "Date",
      bigIntType: "bigint",
      decimalType: "Decimal",
      bytesType: "Uint8Array",
      ...baseConfig,
      // Booleans go here since in the base config they are strings
      exportEnums: baseConfig.exportEnums !== "false", // Default true
      optionalRelations: baseConfig.optionalRelations !== "false", // Default true
      omitRelations: baseConfig.omitRelations === "true", // Default false
      optionalNullables: baseConfig.optionalNullables === "true", // Default false
      prettier: baseConfig.prettier === "true", // Default false
      resolvePrettierConfig: baseConfig.resolvePrettierConfig !== "false", // Default true
    };

    validateConfig(config);

    const datamodel = options.dmmf.datamodel;
    const models = datamodel.models;
    const enums = datamodel.enums;
    const types = datamodel.types;

    const usedCustomTypes = new Set<keyof typeof CUSTOM_TYPES>();

    const enumNameMap = new Map<string, string>(
      enums.map((e) => [e.name, `${config.enumPrefix}${e.name}${config.enumSuffix}`]),
    );
    const modelNameMap = new Map<string, string>(
      models.map((m) => [m.name, `${config.modelPrefix}${m.name}${config.modelSuffix}`]),
    );
    const typeNameMap = new Map<string, string>(
      types.map((t) => [t.name, `${config.typePrefix}${t.name}${config.typeSuffix}`]),
    );

    const enumsTs = enums.map((e) => getEnumTs(config, e, enumNameMap));
    // Types and Models are essentially the same thing, so we can run both through getModelTs
    const modelsTs = [...models, ...types].map((m) =>
      getModelTs(config, m, modelNameMap, enumNameMap, typeNameMap, usedCustomTypes),
    );
    const customTypesTs = Array.from(usedCustomTypes).map((t) => CUSTOM_TYPES[t]);

    let ts = [...enumsTs, ...modelsTs, ...customTypesTs].join("\n\n") + "\n";

    if (config.headerComment) {
      const headerContent = config.headerComment
        .split("\n")
        .map((line) => `// ${line}`)
        .join("\n");
      ts = `${headerContent}\n\n${ts}`;
    }

    const outputFile = options.generator.output?.value as string;
    const outputDir = dirname(outputFile);

    if (config.prettier) {
      // Prettier is imported inside this if so that it's not a required dependency
      let prettier: typeof import("prettier");
      try {
        prettier = await import("prettier");
      } catch {
        throw new Error("Unable import Prettier. Is it installed?");
      }

      const prettierOptions = config.resolvePrettierConfig
        ? await prettier.resolveConfig(outputFile)
        : null;

      ts = await prettier.format(ts, { ...prettierOptions, parser: "typescript" });
    }

    await mkdir(outputDir, { recursive: true });
    await writeFile(outputFile, ts);
  },
});
