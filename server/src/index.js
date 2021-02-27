const {
  CompletionList,
  createConnection,
  Diagnostic,
  InitializeParams,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} = require("vscode-languageserver");
const { TextDocument } = require("vscode-languageserver-textdocument");
const { exec } = require("child_process");
const { __, pipe, curry, ap, map, pathOr, inc, prop, identity, ifElse, slice } = require("ramda");

const { NodeType } = require("./ast");

const trace = curry((label, x) => {
  console.log(label, x);
  return x;
});
const box = x => [x];
const uriToFilepath = uri => uri.substr(7);

// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

let connection = createConnection(ProposedFeatures.all);
let documents = new TextDocuments(TextDocument);

const astTable = {};

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

connection.onInitialized(() => {});

connection.onDidChangeConfiguration(change => {
  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

documents.onDidChangeContent(change => {
  const filepath = uriToFilepath(change.document._uri);
  exec(`madlib compile --json -i ${filepath}`, (err, ast, stderr) => {
    const parsed = JSON.parse(ast);
    Object.keys(parsed).forEach(k => {
      astTable[k] = parsed[k];
    });
    console.log(astTable);
  });
});

documents.onDidSave(change => {
  const filepath = uriToFilepath(change.document._uri);
  exec(`madlib compile --json -i ${filepath}`, (err, ast, stderr) => {
    const parsed = JSON.parse(ast);
    Object.keys(parsed).forEach(k => {
      astTable[k] = parsed[k];
    });
    console.log(astTable);
  });
});

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
      prop("expressions"),
      findExpression(line, col),
      (x) => {
        if (x.nodeType === NodeType.Abstraction) {
          console.log(x.param);
        }
        return x;
      },
      trace("Found expression"),
      ifElse(identity, buildHoverResponse(path, line), identity)
    )(path)
);
connection.onHover(handleHover);

const getExpressionName = exp => {
  switch(exp.nodeType) {
    case NodeType.AbstractionParameter:
    case NodeType.Assignment:
    case NodeType.Variable:
      return exp.name;
    case NodeType.NamespaceAccess:
      return exp.accessor;
  }
  return false;
}

const generateTypeTooltipMarkdown = curry(
  (exp, astPath, line) => {
    const name = getExpressionName(exp);
    const typePrefix = name ? `${name} :: ` : "";
return `
\`\`\`madlib
${typePrefix}${exp.type}
\`\`\`
*Defined in ${astPath} at line ${line}*
`
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
      return findExpression(line, col, [exp.record]) || findExpression(line, col, [exp.field]) || exp;
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
      return findExpression(line, col, [exp.expression]) || findExpression(line, col, map(prop("expression"), exp.isCases)) || exp;
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
