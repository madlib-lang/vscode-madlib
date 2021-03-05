const {
  CompletionList,
  createConnection,
  Diagnostic,
  InitializeParams,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  DiagnosticSeverity,
} = require("vscode-languageserver");
const { TextDocument } = require("vscode-languageserver-textdocument");
const { exec, spawn } = require("child_process");
const {
  __,
  pipe,
  curry,
  ap,
  flatten,
  concat,
  map,
  pathOr,
  inc,
  prop,
  identity,
  ifElse,
  slice,
  propOr,
  pathEq,
  filter,
  fromPairs,
} = require("ramda");

const { NodeType } = require("./ast");

const trace = curry((label, x) => {
  console.log(label, x);
  return x;
});
const box = x => [x];
const uriToFilepath = uri => uri.substr(7);
const filepathToUri = fp => `file://${fp}`;

// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

let connection = createConnection(ProposedFeatures.all);
let documents = new TextDocuments(TextDocument);

const astTable = {};
let initialized = false;

connection.onInitialize(params => {
  console.log(params);
  documents.onDidClose(e => {
    console.log(e);
  });
  connection.onShutdown(() => {
    console.log("SHUTDOWN");
  });

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      hoverProvider: true,
    },
  };
});

connection.onInitialized(() => {
  initialized = true;
});

connection.onDidChangeConfiguration(change => {
  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

const locToRange = loc => ({
  start: {
    line: loc.start.line - 1,
    character: loc.start.col - 1,
  },
  end: {
    line: loc.end.line - 1,
    character: loc.end.col - 1,
  },
});

const buildDiagnostics = map(
  map(err => ({
    range: locToRange(err.loc),
    severity: DiagnosticSeverity.Error,
    message: err.message,
    source: "madlib",
  }))
);

const fixedExec = curry((command, args, callback) => {
  const data = [];
  const proc = spawn(command, args);
  proc.stdout.setEncoding("utf8");

  proc.on("exit", function (exitCode) {
    console.log("process exited with code " + exitCode);
  });

  proc.stdout.on("data", function (chunk) {
    data.push(chunk);
  });

  proc.stdout.on("end", function () {
    callback(data.join(""));
  });
});

const handleDiagnostic = change => {
  const filepath = uriToFilepath(change.document._uri);
  // exec(`madlib compile --json -i ${filepath}`, (e, ast, stderr) => {
  fixedExec(`madlib`, ["compile", "--json", "-i", filepath], ast => {
    const parsed = JSON.parse(ast);
    const asts = parsed.asts;
    Object.keys(asts).forEach(k => {
      astTable[k] = asts[k];
    });

    console.log(parsed.errors);

    const initalKeys = map(path => [path, { path }], [
      ...Object.keys(astTable),
      ...map(prop("origin"), parsed.errors),
    ]);

    const groupedErrors = map(
      ast => filter(err => err.origin === ast.path, parsed.errors),
      fromPairs(initalKeys)
    );
    // const groupedErrors = groupBy(prop("origin"), parsed.errors);
    const diagnostics = buildDiagnostics(groupedErrors);

    console.log(diagnostics);

    Object.keys(diagnostics).forEach(path => {
      if (filepath !== path) {
        return;
      }

      const uri = filepathToUri(path);
      connection.sendDiagnostics({ uri, diagnostics: diagnostics[path] });
    });
  });
};

documents.onDidOpen(handleDiagnostic);
// documents.onDidChangeContent(handleDiagnostic);
documents.onDidSave(handleDiagnostic);

const handleHover = pipe(
  trace("Hover call"),
  box,
  ap([
    pipe(pathOr("-", ["textDocument", "uri"]), uriToFilepath),
    pipe(pathOr(1, ["position", "line"]), inc),
    pipe(pathOr(1, ["position", "character"]), inc),
  ]),
  ([path, line, col]) =>
    pipe(
      prop(__, astTable),
      box,
      ap([
        propOr([], "expressions"),
        pipe(
          propOr([], "instances"),
          trace("instances"),
          pipe(map(propOr([], "methods")), flatten, map(propOr([], "exp"))),
          flatten
        ),
        propOr([], "typeDeclarations"),
      ]),
      flatten,
      findNode(line, col),
      trace("Found node"),
      ifElse(identity, buildHoverResponse(path, line), identity)
    )(path)
);

connection.onHover(change => (initialized ? handleHover(change) : null));

const getExpressionName = exp => {
  switch (exp.nodeType) {
    case NodeType.AbstractionParameter:
    case NodeType.Assignment:
    case NodeType.Variable:
      return exp.name;
    case NodeType.NamespaceAccess:
      return exp.accessor;
    case NodeType.Export:
      return pathEq(["expression", "nodeType"], NodeType.Assignment, exp)
        ? exp.expression.name
        : false;
    case NodeType.TypedExpression:
      return pathEq(["expression", "nodeType"], NodeType.Assignment, exp)
        ? exp.expression.name
        : pathEq(["expression", "expression", "nodeType"], NodeType.Assignment, exp)
        ? exp.expression.expression.name
        : false;
  }

  return exp.name || false;
};

const generateTypeTooltipMarkdown = curry((exp, astPath, line) => {
  const name = getExpressionName(exp);
  const typePrefix = name ? `${name} :: ` : "";
  return `
\`\`\`madlib
${typePrefix}${exp.type || exp.kind}
\`\`\`
*Defined in ${astPath} at line ${line}*
`;
});

const buildHoverResponse = curry((path, line, expression) => ({
  contents: {
    kind: "markdown",
    value: generateTypeTooltipMarkdown(expression, path, line),
  },
}));

const isInRange = curry((line, col, loc) => {
  if (line >= loc.start.line && line <= loc.end.line) {
    if (line === loc.start.line && col < loc.start.col) {
      return false;
    } else if (line === loc.end.line && col > loc.end.col) {
      return false;
    }
    return true;
  }
  return false;
});

const findNode = curry((line, col, nodes) => {
  if (nodes.length === 0) {
    return false;
  }

  const node = nodes[0];

  if (!isInRange(line, col, node.loc)) {
    return findNode(line, col, slice(1, Infinity, nodes));
  }

  switch (node.nodeType) {
    case NodeType.Application:
      return (
        findNode(line, col, [node.argument]) || findNode(line, col, [node.abstraction]) || node
      );
    case NodeType.Abstraction:
      return findNode(line, col, [node.param]) || findNode(line, col, node.body) || node;
    case NodeType.TypedExpression:
    case NodeType.Export:
    case NodeType.Assignment:
      return findNode(line, col, [node.expression]) || node;
    case NodeType.FieldAccess:
      return findNode(line, col, [node.record]) || findNode(line, col, [node.field]) || node;
    case NodeType.If:
      return (
        findNode(line, col, [node.condition]) ||
        findNode(line, col, [node.truthy]) ||
        findNode(line, col, [node.falsy]) ||
        node
      );
    case NodeType.TemplateString:
    case NodeType.TupleConstructor:
      return findNode(line, col, node.expressions) || node;
    case NodeType.ListConstructor:
      return findNode(line, col, map(prop("expression"), node.items)) || node;
    case NodeType.Record:
      return findNode(line, col, map(prop("expression"), node.fields)) || node;
    case NodeType.Where:
      return findNode(line, col, [node.expression]) || findNode(line, col, node.isCases) || node;
    case NodeType.Is:
      return findNode(line, col, [node.pattern]) || findNode(line, col, [node.expression]) || node;
    case NodeType.Pattern:
      return node;
    case NodeType.Placeholder:
      return findNode(line, col, [node.expression]) || false;
    case NodeType.ADT:
      return findNode(line, col, node.constructors) || node;
    case NodeType.Constructor:
    case NodeType.Variable:
    case NodeType.LiteralNumber:
    case NodeType.LiteralString:
    case NodeType.LiteralBoolean:
    case NodeType.LiteralUnit:
    case NodeType.NamespaceAccess:
    case NodeType.AbstractionParameter:
    default:
      return node;
  }
});

connection.onCompletion((textDocumentPosition, token) => {
  const document = documents.get(textDocumentPosition.textDocument.uri);
  if (!document) {
    return null;
  }

  const mode = languageModes.getModeAtPosition(document, textDocumentPosition.position);
  if (!mode || !mode.doComplete) {
    return CompletionList.create();
  }
  const doComplete = mode.doComplete;

  return doComplete(document, textDocumentPosition.position);
});

documents.listen(connection);
connection.listen();
