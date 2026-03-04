import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIAGNOSTIC_CODE = "always_specify_types";
const OUTPUT_CHANNEL_NAME = "Dart Generic Auto-Fix";

/** Matches the first occurrence of `Word<...>` inside a hover markdown string.
 *  Handles nested generics up to two levels deep, e.g. Map<String, List<int>>.
 *  Group 1 → the raw inner type string, e.g. "MyBloc, MyState".
 */
function buildGenericRegex(targetWord: string): RegExp {
  // Escape any regex-special chars that could appear in a Dart type name
  const escaped = targetWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow optional whitespace after the word before `<`
  // Inner content: allow nested <> one level deep via [^<>]*(?:<[^<>]*>[^<>]*)*
  return new RegExp(
    `\\b${escaped}\\s*<((?:[^<>]|<[^<>]*>)*)>`,
    "s", // dotAll – hover text may contain newlines inside code blocks
  );
}

// ---------------------------------------------------------------------------
// Hover-text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Converts a MarkdownString | string to a plain string.
 */
function markdownToString(part: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof part === "string") {
    return part;
  }
  if ("value" in part) {
    return part.value;
  }
  return "";
}

/**
 * Collapses all hover content parts into one string for regex scanning.
 */
function extractHoverText(hovers: vscode.Hover[]): string {
  return hovers
    .flatMap((h) => h.contents)
    .map(markdownToString)
    .join("\n");
}

/**
 * Parses the inferred generic type string for `targetWord` out of
 * the concatenated hover markdown.
 *
 * Returns the raw inner type (e.g. "MyBloc, MyState") or null.
 */
function parseGenericType(
  hoverText: string,
  targetWord: string,
): string | null {
  const rx = buildGenericRegex(targetWord);
  const match = rx.exec(hoverText);
  if (!match) {
    return null;
  }

  const inner = match[1].trim();

  // Reject degenerate matches: empty, just whitespace, or a bare `?`
  if (!inner || inner === "?") {
    return null;
  }

  return inner;
}

async function fixAllGenericsInProject(
  output: vscode.OutputChannel,
): Promise<void> {
  const projectRoot = await findFlutterProjectRoot();

  if (!projectRoot) {
    vscode.window.showWarningMessage(
      "Dart Generic Auto-Fix: No Flutter project found in workspace.",
    );
    return;
  }

  output.show(true);
  output.appendLine(`\n[run] Scanning for missing types in: ${projectRoot.fsPath}`);

  // Find all Dart files, excluding common build/generated directories
  const dartFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(projectRoot, '**/*.dart'),
    '**/{build,.dart_tool,.flutter-plugins,.flutter-plugins-dependencies}/**',
  );

  output.appendLine(`[info] Found ${dartFiles.length} Dart file(s) to scan.`);

  // Trigger a workspace analysis to ensure diagnostics are up-to-date
  try {
    await vscode.commands.executeCommand('dart.analyzeWorkspace');
    output.appendLine('[info] Analysis triggered.');
  } catch {
    // Command might not be available in all Dart versions, continue anyway
    output.appendLine('[info] Analysis trigger skipped (may not be supported).');
  }

  const diagnosticsByFile = new Map<vscode.Uri, vscode.Diagnostic[]>();

  // Collect diagnostics for each file
  for (const fileUri of dartFiles) {
    const diagnostics = vscode.languages.getDiagnostics(fileUri);
    const targets = diagnostics.filter((d) => {
      const code =
        typeof d.code === "object" && d.code !== null
          ? String(d.code.value)
          : String(d.code ?? "");
      return code === DIAGNOSTIC_CODE;
    });

    if (targets.length > 0) {
      diagnosticsByFile.set(fileUri, targets);
    }
  }

  const totalCount = Array.from(diagnosticsByFile.values()).reduce(
    (sum, diagnostics) => sum + diagnostics.length,
    0,
  );

  if (totalCount === 0) {
    output.appendLine("[info] No 'always_specify_types' diagnostics found.");
    vscode.window.showInformationMessage(
      "Dart Generic Auto-Fix: no missing types found.",
    );
    return;
  }

  output.appendLine(`[info] Found ${totalCount} diagnostic(s) to process across ${diagnosticsByFile.size} file(s).`);

  let fixCount = 0;
  let skipCount = 0;

  for (const [fileUri, diagnostics] of diagnosticsByFile) {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      output.appendLine(`[skip] Could not open: ${fileUri.fsPath}`);
      skipCount += diagnostics.length;
      continue;
    }

    output.appendLine(`[file] Processing: ${vscode.workspace.asRelativePath(fileUri)}`);

    // Process sequentially – avoids WorkspaceEdit offset drift
    for (const diagnostic of diagnostics) {
      const targetWord = document.getText(diagnostic.range).trim();

      if (!targetWord) {
        output.appendLine(`[skip] Empty word at ${fmtRange(diagnostic.range)}.`);
        skipCount++;
        continue;
      }

      // ── 1. Invoke hover provider ──────────────────────────────────────────
      let hovers: vscode.Hover[] | undefined;
      try {
        hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          "vscode.executeHoverProvider",
          fileUri,
          diagnostic.range.start,
        );
      } catch (err) {
        output.appendLine(
          `[skip] Hover command failed for '${targetWord}': ${err}`,
        );
        skipCount++;
        continue;
      }

      if (!hovers || hovers.length === 0) {
        output.appendLine(
          `[skip] No hover data for '${targetWord}' at ${fmtRange(diagnostic.range)}.`,
        );
        skipCount++;
        continue;
      }

      // ── 2. Extract type from hover markdown ───────────────────────────────
      const hoverText = extractHoverText(hovers);
      const genericType = parseGenericType(hoverText, targetWord);

      if (!genericType) {
        output.appendLine(
          `[skip] Could not parse generic type for '${targetWord}'. Hover text:\n${hoverText}`,
        );
        skipCount++;
        continue;
      }

      // ── 3. Determine insertion position ──────────────────────────────────
      // Re-fetch the document in case a previous edit shifted lines
      const liveDocument = await vscode.workspace.openTextDocument(fileUri);
      const insertPos = positionAfterWord(
        liveDocument,
        diagnostic.range.start,
        targetWord,
      );

      // Guard: already has a generic annotation
      if (alreadyHasGeneric(liveDocument, insertPos)) {
        output.appendLine(
          `[skip] '${targetWord}' already has a generic at ${fmtPos(insertPos)}.`,
        );
        skipCount++;
        continue;
      }

      // ── 4. Apply edit ─────────────────────────────────────────────────────
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.insert(fileUri, insertPos, `<${genericType}>`);

      const success = await vscode.workspace.applyEdit(workspaceEdit);

      if (success) {
        output.appendLine(
          `[fix] Inserted '<${genericType}>' after '${targetWord}' at ${fmtPos(insertPos)}.`,
        );
        fixCount++;
      } else {
        output.appendLine(
          `[error] applyEdit failed for '${targetWord}' at ${fmtPos(insertPos)}.`,
        );
        skipCount++;
      }
    }
  }

  const summary = `Dart Generic Auto-Fix: ${fixCount} fix(es) applied, ${skipCount} skipped.`;
  output.appendLine(`[done] ${summary}`);
  vscode.window.showInformationMessage(summary);
}

/**
 * Returns the VSCode Position immediately after the last character of
 * `targetWord` starting at `startPos` in `document`.
 *
 * We re-read the word from the document rather than trusting the diagnostic
 * range end so that we are always aligned to the actual source text.
 */
function positionAfterWord(
  document: vscode.TextDocument,
  startPos: vscode.Position,
  targetWord: string,
): vscode.Position {
  const lineText = document.lineAt(startPos.line).text;
  const col = startPos.character;

  // Verify the word is actually there (defensive)
  if (lineText.substring(col, col + targetWord.length) === targetWord) {
    return new vscode.Position(startPos.line, col + targetWord.length);
  }

  // Fallback: search the remainder of the line
  const idx = lineText.indexOf(targetWord, col);
  if (idx !== -1) {
    return new vscode.Position(startPos.line, idx + targetWord.length);
  }

  // Last resort: use diagnostic start + word length
  return new vscode.Position(
    startPos.line,
    startPos.character + targetWord.length,
  );
}

// ---------------------------------------------------------------------------
// Already-typed guard
// ---------------------------------------------------------------------------

/**
 * Returns true if the character immediately after `pos` in the document
 * is already `<`, meaning the generic is already present.
 */
function alreadyHasGeneric(
  document: vscode.TextDocument,
  pos: vscode.Position,
): boolean {
  const lineText = document.lineAt(pos.line).text;
  const ch = lineText[pos.character]; // character right after word end
  return ch === "<";
}

// ---------------------------------------------------------------------------
// Core fix function
// ---------------------------------------------------------------------------

async function fixAllGenericsInDocument(
  document: vscode.TextDocument,
  output: vscode.OutputChannel,
): Promise<void> {
  const allDiagnostics = vscode.languages.getDiagnostics(document.uri);

  const targets = allDiagnostics.filter((d) => {
    // Accept both string and number diagnostic codes
    const code =
      typeof d.code === "object" && d.code !== null
        ? String(d.code.value)
        : String(d.code ?? "");
    return code === DIAGNOSTIC_CODE;
  });

  if (targets.length === 0) {
    output.appendLine("[info] No 'always_specify_types' diagnostics found.");
    vscode.window.showInformationMessage(
      "Dart Generic Auto-Fix: nothing to fix.",
    );
    return;
  }

  output.appendLine(`[info] Found ${targets.length} diagnostic(s) to process.`);

  let fixCount = 0;
  let skipCount = 0;

  // Process sequentially – avoids WorkspaceEdit offset drift
  for (const diagnostic of targets) {
    const targetWord = document.getText(diagnostic.range).trim();

    if (!targetWord) {
      output.appendLine(`[skip] Empty word at ${fmtRange(diagnostic.range)}.`);
      skipCount++;
      continue;
    }

    // ── 1. Invoke hover provider ──────────────────────────────────────────
    let hovers: vscode.Hover[] | undefined;
    try {
      hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        document.uri,
        diagnostic.range.start,
      );
    } catch (err) {
      output.appendLine(
        `[skip] Hover command failed for '${targetWord}': ${err}`,
      );
      skipCount++;
      continue;
    }

    if (!hovers || hovers.length === 0) {
      output.appendLine(
        `[skip] No hover data for '${targetWord}' at ${fmtRange(diagnostic.range)}.`,
      );
      skipCount++;
      continue;
    }

    // ── 2. Extract type from hover markdown ───────────────────────────────
    const hoverText = extractHoverText(hovers);
    const genericType = parseGenericType(hoverText, targetWord);

    if (!genericType) {
      output.appendLine(
        `[skip] Could not parse generic type for '${targetWord}'. Hover text:\n${hoverText}`,
      );
      skipCount++;
      continue;
    }

    // ── 3. Determine insertion position ──────────────────────────────────
    // Re-fetch the document in case a previous edit shifted lines
    const liveDocument = await vscode.workspace.openTextDocument(document.uri);
    const insertPos = positionAfterWord(
      liveDocument,
      diagnostic.range.start,
      targetWord,
    );

    // Guard: already has a generic annotation
    if (alreadyHasGeneric(liveDocument, insertPos)) {
      output.appendLine(
        `[skip] '${targetWord}' already has a generic at ${fmtPos(insertPos)}.`,
      );
      skipCount++;
      continue;
    }

    // ── 4. Apply edit ─────────────────────────────────────────────────────
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.insert(document.uri, insertPos, `<${genericType}>`);

    const success = await vscode.workspace.applyEdit(workspaceEdit);

    if (success) {
      output.appendLine(
        `[fix] Inserted '<${genericType}>' after '${targetWord}' at ${fmtPos(insertPos)}.`,
      );
      fixCount++;
    } else {
      output.appendLine(
        `[error] applyEdit failed for '${targetWord}' at ${fmtPos(insertPos)}.`,
      );
      skipCount++;
    }
  }

  const summary = `Dart Generic Auto-Fix: ${fixCount} fix(es) applied, ${skipCount} skipped.`;
  output.appendLine(`[done] ${summary}`);
  vscode.window.showInformationMessage(summary);
}

async function findFlutterProjectRoot(): Promise<vscode.Uri | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }

  for (const folder of folders) {
    const pubspecPath = vscode.Uri.joinPath(folder.uri, "pubspec.yaml");
    try {
      await vscode.workspace.openTextDocument(pubspecPath);
      return folder.uri;
    } catch {
      continue;
    }
  }

  return null;
}

function fmtPos(p: vscode.Position): string {
  return `${p.line + 1}:${p.character + 1}`;
}

function fmtRange(r: vscode.Range): string {
  return `${fmtPos(r.start)}–${fmtPos(r.end)}`;
}

// ---------------------------------------------------------------------------
// Extension entry points
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  const disposable = vscode.commands.registerCommand(
    "flutter-fix-missing-types.fixMissingTypes",
    async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        vscode.window.showWarningMessage(
          "Dart Generic Auto-Fix: no active editor.",
        );
        return;
      }

      const document = editor.document;

      if (document.languageId !== "dart") {
        vscode.window.showWarningMessage(
          "Dart Generic Auto-Fix: active file is not a Dart file.",
        );
        return;
      }

      output.show(/* preserveFocus */ true);
      output.appendLine(`\n[run] Fixing generics in: ${document.fileName}`);

      await fixAllGenericsInDocument(document, output);
    },
  );

  context.subscriptions.push(disposable);

  const disposableProject = vscode.commands.registerCommand(
    "flutter-fix-missing-types.fixProject",
    async () => {
      output.show(/* preserveFocus */ true);
      await fixAllGenericsInProject(output);
    },
  );

  context.subscriptions.push(disposableProject);
}

export function deactivate(): void {
  // Nothing to clean up beyond what context.subscriptions handles.
}
