// This file handles highlighting of code regions made inactive
// by preprocessor conditionals. At the server and protocol level
// this is part of semantic highlighting, but on the client side
// we handle the inactive-code highlighting kind specially, to be
// able to use whole-line background styling, something that vscode's
// semantic highlighting customizations do not currently support
// (see https://github.com/microsoft/vscode/issues/123352).

import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import {ClangdContext} from './clangd-context';

export function activate(context: ClangdContext) {
  const feature = new InactiveRegionsFeature();
  context.client.registerFeature(feature);
}

let inactiveCodeTokenTypeIndex: number|undefined = undefined;

class InactiveRegionsFeature implements vscodelc.StaticFeature {
  fillClientCapabilities(_capabilities: vscodelc.ClientCapabilities) {}
  initialize(capabilities: vscodelc.ServerCapabilities,
             _documentSelector: vscodelc.DocumentSelector|undefined) {
    if (capabilities.semanticTokensProvider) {
      // Find the token type index representing inactive code and record it.
      let tokenTypes = capabilities.semanticTokensProvider.legend.tokenTypes;
      for (let i = 0; i < tokenTypes.length; i++) {
        if (tokenTypes[i] === 'comment') {
          inactiveCodeTokenTypeIndex = i;
        }
      }
    }
  }
  dispose() {}
}

const inactiveCodeDecorationType =
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      color: new vscode.ThemeColor('clangd.inactiveRegions.foreground'),
      backgroundColor:
          new vscode.ThemeColor('clangd.inactiveRegions.background')
    });

// The most recent SemanticTokens for each document, for delta requests.
const lastTokens: Map<vscode.TextDocument, vscode.SemanticTokens> = new Map();

function computeInactiveRanges(tokens: vscode.SemanticTokens): vscode.Range[] {
  const data: Uint32Array = tokens.data;
  // Tokens are encoded as 5 integers per token, see
  // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_semanticTokens
  const tokenCount = data.length / 5;
  let tokenIndex = 0;
  let lastLineNumber = 0;
  let lastStartCharacter = 0;
  let inactiveRanges: vscode.Range[] = [];
  while (tokenIndex < tokenCount) {
    const offset = 5 * tokenIndex;
    const deltaLine = data[offset];
    const deltaCharacter = data[offset + 1];
    const lineNumber = lastLineNumber + deltaLine;
    const startCharacter =
        (deltaLine === 0 ? lastStartCharacter + deltaCharacter
                         : deltaCharacter);
    const length = data[offset + 2];
    const tokenTypeIndex = data[offset + 3];
    // offset + 4 is the token modifiers, which we don't care about here

    if (tokenTypeIndex == inactiveCodeTokenTypeIndex) {
      inactiveRanges.push(new vscode.Range(
          new vscode.Position(lineNumber, startCharacter),
          new vscode.Position(lineNumber, startCharacter + length)));
    }

    lastLineNumber = lineNumber;
    lastStartCharacter = startCharacter;
    tokenIndex++;
  }
  return inactiveRanges;
}

export function provideDocumentSemanticTokens(document: vscode.TextDocument,
                                              tokens: vscode.SemanticTokens) {
  // Save tokens for future delta requests.
  lastTokens.set(document, tokens);

  let inactiveRanges = computeInactiveRanges(tokens);
  vscode.window.visibleTextEditors.forEach((e) => {
    if (e.document == document) {
      e.setDecorations(inactiveCodeDecorationType, inactiveRanges);
    }
  });
}

function isSemanticTokens(tokens: vscode.SemanticTokens|
                          vscode.SemanticTokensEdits):
    tokens is vscode.SemanticTokens {
  return tokens && (tokens as vscode.SemanticTokens).data !== undefined;
}

function copy(src: Uint32Array, srcOffset: number, dest: Uint32Array,
              destOffset: number, length: number) {
  for (let i = 0; i < length; i++) {
    dest[destOffset + i] = src[srcOffset + i];
  }
}

function applyDelta(prev: vscode.SemanticTokens,
                    delta: vscode.SemanticTokensEdits): vscode.SemanticTokens {
  // Implementation adapted from
  // https://github.com/microsoft/vscode/blob/5319757634f77a050b49c10162939bfe60970c29/src/vs/editor/common/services/modelServiceImpl.ts#L892.

  let deltaLength = 0;
  for (const edit of delta.edits) {
    deltaLength += (edit.data ? edit.data.length : 0) - edit.deleteCount;
  }

  const srcData = prev.data;
  const destData = new Uint32Array(srcData.length + deltaLength);

  let srcLastStart = srcData.length;
  let destLastStart = destData.length;
  for (let i = delta.edits.length - 1; i >= 0; i--) {
    const edit = delta.edits[i];

    const copyCount = srcLastStart - (edit.start + edit.deleteCount);
    if (copyCount) {
      copy(srcData, srcLastStart - copyCount, destData,
           destLastStart - copyCount, copyCount);
      destLastStart -= copyCount;
    }
    if (edit.data) {
      copy(edit.data, 0, destData, destLastStart - edit.data.length,
           edit.data.length);
      destLastStart -= edit.data.length;
    }
    srcLastStart = edit.start;
  }
  if (srcLastStart > 0) {
    copy(srcData, 0, destData, 0, srcLastStart);
  }

  return {resultId: delta.resultId, data: destData};
}

export function provideDocumentSemanticTokensEdits(
    document: vscode.TextDocument, previousResultId: string,
    tokens: vscode.SemanticTokens|vscode.SemanticTokensEdits) {

  if (!isSemanticTokens(tokens)) { // have delta
    // Look up previous data to apply delta to
    let previousTokens = lastTokens.get(document);
    if (!previousTokens || previousTokens.resultId !== previousResultId) {
      // What to do?
      return;
    }

    tokens = applyDelta(previousTokens, tokens);
  }

  provideDocumentSemanticTokens(document, tokens);
}