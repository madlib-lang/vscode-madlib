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

const uriToFilepath = uri => uri.substr(7);

// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
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
      // Tell the client that the server supports code completion
      completionProvider: {
        resolveProvider: false,
      },
      hoverProvider: true,
    },
  };
});

connection.onInitialized(() => {});

connection.onDidChangeConfiguration(change => {
  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
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

/**
 * input:
{
  textDocument: { uri: 'file:///Users/a.boeglin/Code/madui/src/Example.mad' },
  position: { line: 35, character: 18 }
}
 */
connection.onHover(input => {
  const astPath = uriToFilepath(input.textDocument.uri);
  const ast = astTable[astPath];
  const foundExp = findExpression(input.position.line + 1, input.position.character + 1, ast.expressions);
  console.log(input);
  console.log(foundExp);

  if (foundExp) {
    return {
      contents: { kind: "markdown", value: `
\`\`\`madlib
${foundExp.type}
\`\`\`
*Defined in ${astPath} at line ${input.position.line + 1}*
` },
    };
  }
});

const findExpression = (line, col, expressions) => {
  return expressions.find(exp => {
    if (line >= exp.loc.start.line && line <= exp.loc.end.line) {
      return true;
    }
    return false;
  });
};

connection.onCompletion(async (textDocumentPosition, token) => {
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

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
