/**
 * @owner       scripts::release-truth-check
 * @does        Cross-checks release-facing runtime, workflow, dependency, symbol-resolved literal package-load, privacy, and security claims against executable repository state.
 * @needs       package.json, package-lock.json, TypeScript runtime source program and symbols, CI/release workflows, updater constant, PRIVACY.md, SECURITY.md
 * @feeds       npm run truth:check, CI, release verification
 * @breaks      Any undeclared literal runtime package load, mutable loader binding, production dependency marked dev-only, root manifest/lock mismatch, missing Node/audit gate, npm 10-incompatible optional-peer closure, wrong scoped URL, or resurrected false security claim fails non-zero.
 * @invariants  Every non-test src literal package load expressed through runtime import/export, import(), a symbol-bound createRequire result, or its resolver names a declared production dependency; TypeScript symbols distinguish lexical shadows while a fixed-point binding scan covers aliases, assignments, templates, destructuring, and type-only exclusions; reassignment from a loader to an unrelated value is an explicit unsupported state; root manifest and lock identity/dependency maps match exactly; every direct production dependency has a non-dev lock entry; and the lock retains DocSearch's npm 10-required optional React peer closure even when newer npm clients would prune it.
 * @side-effects Reads repository files and writes one summary line.
 * @test        Executed by npm run verify and both publish/mainline workflow gates.
 * @stability   stable
 * @since       2026-07-12
 */

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import { parse } from "yaml";
import { UPDATE_REGISTRY_URL } from "../src/engine/update-check.js";

interface WorkflowStep {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  strategy?: { matrix?: { include?: Array<Record<string, unknown>> } };
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

interface PackageManifest {
  name: string;
  version: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
}

interface PackageLockEntry {
  name?: string;
  version?: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLock {
  name?: string;
  version?: string;
  packages?: Record<string, PackageLockEntry>;
}

type DependencyMapName =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies";

function fail(message: string): never {
  throw new Error(`release-truth-check: ${message}`);
}

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function runtimeSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return runtimeSourceFiles(path);
      if (!/\.tsx?$/.test(entry.name)) return [];
      if (/(?:\.test|\.spec|\.d)\.tsx?$/.test(entry.name)) return [];
      return [path];
    })
    .sort();
}

function importLoadsRuntime(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportLoadsRuntime(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

type RuntimeBindingKind =
  | "create-require"
  | "module-namespace"
  | "require"
  | "resolver";

interface RuntimeBindings {
  createRequire: Set<ts.Symbol>;
  moduleNamespace: Set<ts.Symbol>;
  require: Set<ts.Symbol>;
  resolver: Set<ts.Symbol>;
}

function symbolAt(
  checker: ts.TypeChecker,
  node: ts.Node | undefined,
): ts.Symbol | undefined {
  return node ? checker.getSymbolAtLocation(node) : undefined;
}

function addSymbol(
  target: Set<ts.Symbol>,
  checker: ts.TypeChecker,
  node: ts.Node | undefined,
): boolean {
  const symbol = symbolAt(checker, node);
  if (!symbol) return false;
  const size = target.size;
  target.add(symbol);
  return target.size !== size;
}

function runtimeBindings(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): RuntimeBindings {
  const bindings: RuntimeBindings = {
    createRequire: new Set(),
    moduleNamespace: new Set(),
    require: new Set(),
    resolver: new Set(),
  };
  for (const statement of source.statements) {
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ["module", "node:module"].includes(
        literalText(statement.moduleReference.expression) ?? "",
      )
    ) {
      addSymbol(bindings.moduleNamespace, checker, statement.name);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    if (
      !["module", "node:module"].includes(
        literalText(statement.moduleSpecifier) ?? "",
      )
    ) {
      continue;
    }
    if (statement.importClause.name) {
      addSymbol(bindings.moduleNamespace, checker, statement.importClause.name);
    }
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      addSymbol(bindings.moduleNamespace, checker, namedBindings.name);
    } else if (namedBindings) {
      for (const element of namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "createRequire") {
          addSymbol(bindings.createRequire, checker, element.name);
        }
      }
    }
  }

  const declarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind)
    ) {
      assignments.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      const kind = runtimeBindingKind(
        declaration.initializer,
        checker,
        bindings,
      );
      if (kind) {
        changed =
          bindRuntimeName(declaration.name, kind, checker, bindings) || changed;
      }
    }
    for (const assignment of assignments) {
      if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      const kind = runtimeBindingKind(assignment.right, checker, bindings);
      if (kind) {
        changed =
          bindRuntimeAssignmentTarget(
            assignment.left,
            kind,
            checker,
            bindings,
          ) || changed;
      }
    }
  }

  const trackedSymbols = new Set(
    Object.values(bindings).flatMap((symbols) => [...symbols]),
  );
  for (const declaration of declarations) {
    if (!declaration.initializer || !ts.isIdentifier(declaration.name))
      continue;
    const symbol = symbolAt(checker, declaration.name);
    if (
      symbol &&
      trackedSymbols.has(symbol) &&
      !runtimeBindingKind(declaration.initializer, checker, bindings)
    ) {
      failMutableRuntimeBinding(source, declaration.name);
    }
  }
  for (const assignment of assignments) {
    const symbols = assignmentTargetSymbols(assignment.left, checker);
    if (
      symbols.some((symbol) => trackedSymbols.has(symbol)) &&
      (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !runtimeBindingKind(assignment.right, checker, bindings))
    ) {
      failMutableRuntimeBinding(source, assignment.left);
    }
  }
  return bindings;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function bindRuntimeName(
  name: ts.BindingName,
  kind: RuntimeBindingKind,
  checker: ts.TypeChecker,
  bindings: RuntimeBindings,
): boolean {
  if (ts.isIdentifier(name)) {
    return addSymbol(bindings[kindToSet(kind)], checker, name);
  }
  if (!ts.isObjectBindingPattern(name)) return false;
  let changed = false;
  for (const element of name.elements) {
    const propertyName = bindingElementPropertyName(element);
    if (kind === "require" && propertyName === "resolve") {
      changed = addSymbol(bindings.resolver, checker, element.name) || changed;
    } else if (
      kind === "module-namespace" &&
      propertyName === "createRequire"
    ) {
      changed =
        addSymbol(bindings.createRequire, checker, element.name) || changed;
    }
  }
  return changed;
}

function bindRuntimeAssignmentTarget(
  target: ts.Expression,
  kind: RuntimeBindingKind,
  checker: ts.TypeChecker,
  bindings: RuntimeBindings,
): boolean {
  if (ts.isParenthesizedExpression(target)) {
    return bindRuntimeAssignmentTarget(
      target.expression,
      kind,
      checker,
      bindings,
    );
  }
  if (ts.isIdentifier(target)) {
    return addSymbol(bindings[kindToSet(kind)], checker, target);
  }
  if (!ts.isObjectLiteralExpression(target)) return false;
  let changed = false;
  for (const property of target.properties) {
    const propertyName = objectAssignmentPropertyName(property);
    const assignedSymbols = objectAssignmentTargetSymbols(property, checker);
    if (kind === "require" && propertyName === "resolve") {
      changed = addSymbols(bindings.resolver, assignedSymbols) || changed;
    } else if (
      kind === "module-namespace" &&
      propertyName === "createRequire"
    ) {
      changed = addSymbols(bindings.createRequire, assignedSymbols) || changed;
    }
  }
  return changed;
}

function assignmentTargetSymbols(
  target: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol[] {
  if (ts.isParenthesizedExpression(target)) {
    return assignmentTargetSymbols(target.expression, checker);
  }
  if (ts.isIdentifier(target)) {
    const symbol = symbolAt(checker, target);
    return symbol ? [symbol] : [];
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) =>
      objectAssignmentTargetSymbols(property, checker),
    );
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : assignmentTargetSymbols(
            ts.isSpreadElement(element) ? element.expression : element,
            checker,
          ),
    );
  }
  if (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargetSymbols(target.left, checker);
  }
  return [];
}

function addSymbols(target: Set<ts.Symbol>, symbols: ts.Symbol[]): boolean {
  const size = target.size;
  for (const symbol of symbols) target.add(symbol);
  return target.size !== size;
}

function objectAssignmentPropertyName(
  property: ts.ObjectLiteralElementLike,
): string | undefined {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (!ts.isPropertyAssignment(property)) return undefined;
  return propertyNameText(property.name);
}

function objectAssignmentTargetSymbols(
  property: ts.ObjectLiteralElementLike,
  checker: ts.TypeChecker,
): ts.Symbol[] {
  if (ts.isShorthandPropertyAssignment(property)) {
    const symbol =
      checker.getShorthandAssignmentValueSymbol(property) ??
      symbolAt(checker, property.name);
    return symbol ? [symbol] : [];
  }
  if (ts.isPropertyAssignment(property)) {
    return assignmentTargetSymbols(property.initializer, checker);
  }
  if (ts.isSpreadAssignment(property)) {
    return assignmentTargetSymbols(property.expression, checker);
  }
  return [];
}

function failMutableRuntimeBinding(
  source: ts.SourceFile,
  node: ts.Node,
): never {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  fail(
    `mutable runtime package-loader binding is unsupported at ${source.fileName}:${String(position.line + 1)}; keep createRequire and resolver bindings immutable`,
  );
}

function kindToSet(kind: RuntimeBindingKind): keyof RuntimeBindings {
  return kind === "create-require"
    ? "createRequire"
    : kind === "module-namespace"
      ? "moduleNamespace"
      : kind;
}

function bindingElementPropertyName(
  element: ts.BindingElement,
): string | undefined {
  return propertyNameText(element.propertyName ?? element.name);
}

function propertyNameText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return literalText(node.expression);
  return literalText(node);
}

function runtimeBindingKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: RuntimeBindings,
): RuntimeBindingKind | undefined {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return runtimeBindingKind(expression.expression, checker, bindings);
  }

  if (ts.isIdentifier(expression)) {
    const symbol = symbolAt(checker, expression);
    if (!symbol) return undefined;
    for (const kind of [
      "create-require",
      "module-namespace",
      "require",
      "resolver",
    ] as const) {
      if (bindings[kindToSet(kind)].has(symbol)) return kind;
    }
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const propertyName = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : literalText(expression.argumentExpression);
    const owner = runtimeBindingKind(expression.expression, checker, bindings);
    if (owner === "module-namespace" && propertyName === "createRequire") {
      return "create-require";
    }
    if (owner === "require" && propertyName === "resolve") return "resolver";
    return undefined;
  }

  if (ts.isCallExpression(expression)) {
    if (
      expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ["module", "node:module"].includes(
        literalText(expression.arguments[0]) ?? "",
      )
    ) {
      return "module-namespace";
    }
    return runtimeBindingKind(expression.expression, checker, bindings) ===
      "create-require"
      ? "require"
      : undefined;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return runtimeBindingKind(expression.right, checker, bindings);
  }
  if (
    ts.isBinaryExpression(expression) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(expression.operatorToken.kind)
  ) {
    return (
      runtimeBindingKind(expression.left, checker, bindings) ??
      runtimeBindingKind(expression.right, checker, bindings)
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      runtimeBindingKind(expression.whenTrue, checker, bindings) ??
      runtimeBindingKind(expression.whenFalse, checker, bindings)
    );
  }
  return undefined;
}

function literalPackageLoad(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  bindings: RuntimeBindings,
): string | undefined {
  const argument = literalText(node.arguments[0]);
  if (!argument) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return argument;
  const kind = runtimeBindingKind(node.expression, checker, bindings);
  return kind === "require" || kind === "resolver" ? argument : undefined;
}

function runtimeImportSpecifiers(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): string[] {
  const bindings = runtimeBindings(source, checker);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      importLoadsRuntime(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      exportLoadsRuntime(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const specifier = literalPackageLoad(node, checker, bindings);
      if (specifier) specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function runtimeProgramOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    types: [],
  };
}

function runtimeImportSpecifiersFromSource(
  path: string,
  sourceText: string,
): string[] {
  const options = runtimeProgramOptions();
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    fileName === path
      ? ts.createSourceFile(path, sourceText, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  host.fileExists = (fileName) => fileName === path;
  host.readFile = (fileName) => (fileName === path ? sourceText : undefined);
  const program = ts.createProgram({ rootNames: [path], options, host });
  const source = program.getSourceFile(path);
  if (!source) fail(`runtime scanner could not bind synthetic source ${path}`);
  return runtimeImportSpecifiers(source, program.getTypeChecker());
}

function verifyRuntimePackageLoadScanner(): void {
  const source = `
    import "static-package";
    import type { Shape } from "type-only-package";
    export { value } from "export-package";
    export type { OtherShape } from "export-type-only-package";
    import { createRequire as makeRequire } from "node:module";
    import * as moduleApi from "node:module";
    import moduleEquals = require("node:module");
    function lateOuterLoad() {
      return requireFromAlias("late-outer-package");
    }
    const requireFromAlias = makeRequire(import.meta.url);
    const requireFromNamespace = moduleApi.createRequire(import.meta.url);
    const requireFromImportEquals = moduleEquals.createRequire(import.meta.url);
    const resolveFromAlias = requireFromAlias.resolve;
    const { resolve: destructuredResolve } = requireFromNamespace;
    const { ["resolve"]: computedResolve } = requireFromNamespace;
    let assignedRequire: typeof requireFromAlias;
    let chainedRequireA: typeof requireFromAlias;
    let chainedRequireB: typeof requireFromAlias;
    assignedRequire = makeRequire(import.meta.url);
    chainedRequireA = chainedRequireB = makeRequire(import.meta.url);
    void import(\`dynamic-package\`);
    requireFromAlias("required-package");
    requireFromNamespace.resolve("resolved-package");
    requireFromNamespace[\`resolve\`](\`element-resolved-package\`);
    requireFromImportEquals("import-equals-package");
    resolveFromAlias("resolver-alias-package");
    destructuredResolve("destructured-resolver-package");
    computedResolve("computed-resolver-package");
    assignedRequire("assigned-require-package");
    chainedRequireA("chained-require-a-package");
    chainedRequireB("chained-require-b-package");
    void lateOuterLoad;
    async function dynamicModuleLoad() {
      const { createRequire: dynamicCreateRequire } = await import("node:module");
      const dynamicRequire = dynamicCreateRequire(import.meta.url);
      return dynamicRequire("dynamic-module-package");
    }
    void dynamicModuleLoad;
    function shadowed(requireFromAlias: (name: string) => unknown) {
      return requireFromAlias("shadowed-local-function");
    }
  `;
  const actual = new Set(
    runtimeImportSpecifiersFromSource(
      "runtime-package-load-fixture.ts",
      source,
    ),
  );
  const expected = new Set([
    "static-package",
    "export-package",
    "node:module",
    "dynamic-package",
    "required-package",
    "resolved-package",
    "element-resolved-package",
    "import-equals-package",
    "resolver-alias-package",
    "destructured-resolver-package",
    "computed-resolver-package",
    "assigned-require-package",
    "chained-require-a-package",
    "chained-require-b-package",
    "late-outer-package",
    "dynamic-module-package",
  ]);
  const missing = [...expected].filter((specifier) => !actual.has(specifier));
  const unexpected = [...actual].filter(
    (specifier) => !expected.has(specifier),
  );
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      `runtime package-load scanner self-check disagrees (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }

  let rejectedMutation = false;
  try {
    runtimeImportSpecifiersFromSource(
      "runtime-package-loader-mutation-fixture.ts",
      `
        import { createRequire } from "node:module";
        let runtimeRequire = createRequire(import.meta.url);
        ({ runtimeRequire } = { runtimeRequire: (name: string) => name });
        runtimeRequire("shadowed-after-mutation");
      `,
    );
  } catch (error) {
    rejectedMutation =
      error instanceof Error &&
      error.message.includes(
        "mutable runtime package-loader binding is unsupported",
      );
  }
  if (!rejectedMutation) {
    fail("runtime package-load scanner accepted a mutable loader binding");
  }
}

function externalPackageName(
  specifier: string,
  packageName: string,
): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("node:") ||
    specifier === packageName ||
    specifier.startsWith(`${packageName}/`) ||
    builtinModules.includes(specifier)
  ) {
    return undefined;
  }
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

function workflow(path: string): Workflow {
  return parse(read(path)) as Workflow;
}

function allSteps(value: Workflow): WorkflowStep[] {
  return Object.values(value.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function hasRun(steps: WorkflowStep[], command: string): boolean {
  return steps.some((step) => step.run?.includes(command));
}

function dependencyMapDifferences(
  expected: Record<string, string> | undefined,
  actual: Record<string, string> | undefined,
): string[] {
  const expectedMap = expected ?? {};
  const actualMap = actual ?? {};
  return [...new Set([...Object.keys(expectedMap), ...Object.keys(actualMap)])]
    .sort()
    .filter((name) => expectedMap[name] !== actualMap[name])
    .map(
      (name) =>
        `${name} (manifest=${expectedMap[name] ?? "missing"}, lock=${actualMap[name] ?? "missing"})`,
    );
}

const manifest = JSON.parse(read("package.json")) as PackageManifest;
const lockfile = JSON.parse(read("package-lock.json")) as PackageLock;
const ci = workflow(".github/workflows/ci.yml");
const release = workflow(".github/workflows/release.yml");
const privacy = read("PRIVACY.md");
const security = read("SECURITY.md");

verifyRuntimePackageLoadScanner();

const lockRoot = lockfile.packages?.[""];
if (!lockRoot) fail("package-lock omits the root package entry");
if (
  lockfile.name !== manifest.name ||
  lockRoot.name !== manifest.name ||
  lockfile.version !== manifest.version ||
  lockRoot.version !== manifest.version
) {
  fail("package-lock root identity disagrees with package.json");
}
for (const mapName of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] satisfies DependencyMapName[]) {
  const differences = dependencyMapDifferences(
    manifest[mapName],
    lockRoot[mapName],
  );
  if (differences.length > 0) {
    fail(
      `package-lock root ${mapName} disagrees with package.json: ${differences.join("; ")}`,
    );
  }
}

const productionDependencies = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
]);
const runtimeImports = new Map<string, Set<string>>();
const runtimePaths = runtimeSourceFiles("src");
const runtimeProgram = ts.createProgram({
  rootNames: runtimePaths,
  options: runtimeProgramOptions(),
});
const runtimeChecker = runtimeProgram.getTypeChecker();
for (const path of runtimePaths) {
  const source = runtimeProgram.getSourceFile(path);
  if (!source) fail(`runtime scanner could not bind source ${path}`);
  for (const specifier of runtimeImportSpecifiers(source, runtimeChecker)) {
    const dependency = externalPackageName(specifier, manifest.name);
    if (!dependency) continue;
    const paths = runtimeImports.get(dependency) ?? new Set<string>();
    paths.add(path);
    runtimeImports.set(dependency, paths);
  }
}
const undeclaredRuntimeImports = [...runtimeImports]
  .filter(([dependency]) => !productionDependencies.has(dependency))
  .map(
    ([dependency, paths]) =>
      `${dependency} (${[...paths].slice(0, 3).join(", ")})`,
  );
if (undeclaredRuntimeImports.length > 0) {
  fail(
    `runtime source loads undeclared package(s): ${undeclaredRuntimeImports.join("; ")}`,
  );
}
for (const dependency of productionDependencies) {
  const entry = lockfile.packages?.[`node_modules/${dependency}`];
  if (!entry) fail(`package-lock omits runtime dependency ${dependency}`);
  if (entry.dev)
    fail(`package-lock marks runtime dependency as dev-only: ${dependency}`);
}

if (manifest.engines?.node !== ">=22.19.0") {
  fail(
    `unexpected Node support contract: ${manifest.engines?.node ?? "missing"}`,
  );
}

for (const path of [
  "node_modules/@docsearch/js/node_modules/@types/react",
  "node_modules/@docsearch/js/node_modules/react",
  "node_modules/@docsearch/js/node_modules/react-dom",
  "node_modules/@docsearch/js/node_modules/scheduler",
  "node_modules/@types/prop-types",
  "node_modules/js-tokens",
  "node_modules/loose-envify",
]) {
  if (!lockfile.packages?.[path]) {
    fail(`package-lock omits npm 10-required optional peer: ${path}`);
  }
}

const verifyMatrix = ci.jobs?.verify?.strategy?.matrix?.include ?? [];
for (const major of [22, 24]) {
  if (!verifyMatrix.some((entry) => Number(entry["node-version"]) === major)) {
    fail(`CI verify matrix does not exercise supported Node ${major}`);
  }
}

const auditCommand = "npm audit --omit=dev --audit-level=moderate";
if (!hasRun(allSteps(ci), auditCommand)) {
  fail("CI does not gate production dependency advisories");
}
if (!hasRun(allSteps(release), auditCommand)) {
  fail("release workflow does not re-run the production dependency audit");
}

const verifySteps = ci.jobs?.verify?.steps ?? [];
const unitStep = verifySteps.find((step) => step.run === "npm run test");
if (!unitStep?.if?.includes("node-compat")) {
  fail("Node 24 compatibility matrix does not execute the unit suite");
}
const integrationCommand = "npm run test:integration";
if (!manifest.scripts?.verify?.includes(integrationCommand)) {
  fail("npm run verify does not include the integration suite");
}
if (!hasRun(allSteps(ci), integrationCommand)) {
  fail("CI does not execute the integration suite");
}
if (!hasRun(allSteps(release), "npm run verify")) {
  fail("release workflow does not execute the canonical npm run verify gate");
}

const processOwnerPaths = [
  "packages/sidecars/unicli-process-owner-win32-x64/unicli-process-owner.exe",
  "packages/sidecars/unicli-process-owner-win32-arm64/unicli-process-owner.exe",
];
for (const path of processOwnerPaths) {
  if (!manifest.files?.includes(path)) {
    fail(`published package omits bundled process owner: ${path}`);
  }
}
for (const name of [
  "@zenalexa/unicli-process-owner-win32-x64",
  "@zenalexa/unicli-process-owner-win32-arm64",
]) {
  if (manifest.optionalDependencies?.[name]) {
    fail(`root package still depends on unpublished process owner: ${name}`);
  }
}
const processOwnerJob = release.jobs?.["build-process-owner"];
const processOwnerTargets =
  processOwnerJob?.strategy?.matrix?.include?.map((entry) => entry.target) ??
  [];
for (const target of ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]) {
  if (!processOwnerTargets.includes(target)) {
    fail(`release workflow does not build process owner target ${target}`);
  }
}
if (
  !hasRun(
    processOwnerJob?.steps ?? [],
    "cargo build --locked -p unicli-process-owner",
  )
) {
  fail("release workflow does not build the locked process owner crate");
}
const releaseJob = release.jobs?.release;
const releaseNeeds = Array.isArray(releaseJob?.needs)
  ? releaseJob.needs
  : releaseJob?.needs
    ? [releaseJob.needs]
    : [];
if (!releaseNeeds.includes("build-process-owner")) {
  fail("npm publication is not gated on process owner builds");
}
const releaseSteps = releaseJob?.steps ?? [];
const bundledVerification = releaseSteps.find(
  (step) => step.name === "Verify bundled process owners",
);
for (const path of processOwnerPaths) {
  if (!bundledVerification?.run?.includes(path)) {
    fail(`release workflow does not verify bundled process owner: ${path}`);
  }
}
for (const name of ["process-owner-win32-x64", "process-owner-win32-arm64"]) {
  if (!releaseSteps.some((step) => step.with?.name === name)) {
    fail(`release workflow does not download artifact ${name}`);
  }
}

const benchmarkSteps = ci.jobs?.["benchmark-evidence"]?.steps ?? [];
const benchmarkStep = benchmarkSteps.find(
  (step) => step.run === "npm run bench",
);
if (benchmarkStep?.env?.BENCH_FIXTURES_ONLY !== "1") {
  fail("scheduled benchmark evidence is not pinned to fixture mode");
}

const expectedRegistryUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/latest`;
if (UPDATE_REGISTRY_URL !== expectedRegistryUrl) {
  fail(
    `updater endpoint ${UPDATE_REGISTRY_URL} does not match scoped package ${expectedRegistryUrl}`,
  );
}

if (!manifest.scripts?.verify?.includes("npm run truth:check")) {
  fail("npm run verify does not include the release truth gate");
}

const requiredPrivacyClaims: Array<[RegExp, string]> = [
  [/do\s+\*\*not\*\*\s+persist/i, "live acquisition does not persist"],
  [/unencrypted JSON object/i, "explicit storage is unencrypted JSON"],
  [/mode\s+`0700`/i, "POSIX directory mode 0700"],
  [/mode\s+`0600`/i, "POSIX file mode 0600"],
];
for (const [pattern, claim] of requiredPrivacyClaims) {
  if (!pattern.test(privacy)) fail(`PRIVACY.md is missing: ${claim}`);
}

const requiredSecurityClaims: Array<[RegExp, string]> = [
  [/do not write cookies to disk/i, "runtime refresh does not persist"],
  [/store unencrypted JSON/i, "explicit storage is unencrypted JSON"],
  [/directory is\s+`0700`/i, "POSIX directory mode 0700"],
  [/files are\s+`0600`/i, "POSIX file mode 0600"],
];
for (const [pattern, claim] of requiredSecurityClaims) {
  if (!pattern.test(security)) fail(`SECURITY.md is missing: ${claim}`);
}

const retiredClaims = [
  /cookies stay in chrome/i,
  /cookies are never extracted/i,
  /no credentials (?:are )?stored on disk/i,
  /(?:only|exactly)\s+\d+\s+(?:direct\s+)?runtime dependencies/i,
];
for (const pattern of retiredClaims) {
  if (pattern.test(`${privacy}\n${security}`)) {
    fail(`retired security claim reappeared: ${pattern.source}`);
  }
}

const dependencyCount = Object.keys(manifest.dependencies ?? {}).length;
process.stdout.write(
  `release-truth-check: PASS — Node 22/24, npm 10 lock closure, runtime package loads, scoped updater, audit gates, ${dependencyCount} direct runtime dependencies, and credential claims agree\n`,
);
