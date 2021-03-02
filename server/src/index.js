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
const { exec } = require("child_process");
const {
  __,
  pipe,
  curry,
  ap,
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

const handleDiagnostic = change => {
  const filepath = uriToFilepath(change.document._uri);
  exec(`madlib compile --json -i ${filepath}`, (e, ast, stderr) => {
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
      propOr([], "expressions"),
      findExpression(line, col),
      x => {
        if (x.nodeType === NodeType.Abstraction) {
          console.log(x.param);
        }
        return x;
      },
      trace("Found expression"),
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
  return false;
};

const generateTypeTooltipMarkdown = curry((exp, astPath, line) => {
  const name = getExpressionName(exp);
  const typePrefix = name ? `${name} :: ` : "";
  return `
\`\`\`madlib
${typePrefix}${exp.type}
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

const findExpression = curry((line, col, expressions) => {
  if (expressions.length === 0) {
    return false;
  }

  const exp = expressions[0];

  if (!isInRange(line, col, exp.loc)) {
    return findExpression(line, col, slice(1, Infinity, expressions));
  }

  switch (exp.nodeType) {
    case NodeType.Application:
      return (
        findExpression(line, col, [exp.argument]) ||
        findExpression(line, col, [exp.abstraction]) ||
        exp
      );
    case NodeType.Abstraction:
      return findExpression(line, col, [exp.param]) || findExpression(line, col, exp.body) || exp;
    case NodeType.TypedExpression:
    case NodeType.Export:
    case NodeType.Assignment:
      return findExpression(line, col, [exp.expression]) || exp;
    case NodeType.FieldAccess:
      return (
        findExpression(line, col, [exp.record]) || findExpression(line, col, [exp.field]) || exp
      );
    case NodeType.If:
      return (
        findExpression(line, col, [exp.condition]) ||
        findExpression(line, col, [exp.truthy]) ||
        findExpression(line, col, [exp.falsy]) ||
        exp
      );
    case NodeType.TemplateString:
    case NodeType.TupleConstructor:
      return findExpression(line, col, exp.expressions) || exp;
    case NodeType.ListConstructor:
      return findExpression(line, col, map(prop("expression"), exp.items)) || exp;
    case NodeType.Record:
      return findExpression(line, col, map(prop("expression"), exp.fields)) || exp;
    case NodeType.Where:
      return (
        findExpression(line, col, [exp.expression]) ||
        findExpression(line, col, map(prop("expression"), exp.isCases)) ||
        exp
      );
    case NodeType.Placeholder:
      return findExpression(line, col, [exp.expression]) || false;
    case NodeType.Variable:
    case NodeType.LiteralNumber:
    case NodeType.LiteralString:
    case NodeType.LiteralBoolean:
    case NodeType.LiteralUnit:
    case NodeType.NamespaceAccess:
    case NodeType.AbstractionParameter:
    default:
      return exp;
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
