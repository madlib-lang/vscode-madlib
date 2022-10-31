const { LanguageClient } = require("vscode-languageclient");

const vscode = require("vscode");

const { execSync } = require("child_process");
const path = require("path");

let client;



const escapeShell = function(cmd) {
  return '"'+cmd.replace(/(["\$`\\])/g,'\\$1')+'"';
};

exports.activate = (context) => {
  console.log(context);

  let options = { command: "madlib", args: ["lsp", "+RTS", "-A50m", "-H500m", "-N3"] }

  let serverOptions = {
    run: options,
    debug: options,
  };

  // Options to control the language client
  let clientOptions = {
    documentSelector: [{ scheme: "file", language: "madlib" }],
    // hoverProvider: true,
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    "MadlibServer",
    "Madlib Language Server",
    serverOptions,
    clientOptions
  );

  vscode.languages.registerDocumentFormattingEditProvider("madlib", {
    provideDocumentFormattingEdits(document) {
      try {
        const result = execSync(
          `madlib format --text ${escapeShell(document.getText())}`,
          { encoding: "utf-8", cwd: vscode.workspace.rootPath }
        );

        const firstLine = document.lineAt(0);
        const lastLine = document.lineAt(document.lineCount - 1);
        const textRange = new vscode.Range(
          firstLine.range.start,
          lastLine.range.end
        );
        return [vscode.TextEdit.replace(textRange, result)];
      } catch (e) {
        console.error(e);
        return [];
      }
    },
  });

  // Start the client. This will also launch the server
  client.start();
};

exports.deactivate = () => {
  if (!client) {
    return undefined;
  }
  return client.stop();
};
