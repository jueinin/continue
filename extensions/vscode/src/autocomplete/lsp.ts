import type { IDE, RangeInFile } from "core";
import { getAst, getTreePathAtCursor } from "core/autocomplete/ast";
import { GetLspDefinitionsFunction } from "core/autocomplete/completionProvider";
import { AutocompleteLanguageInfo } from "core/autocomplete/languages";
import { AutocompleteSnippet } from "core/autocomplete/ranking";
import { RangeInFileWithContents } from "core/commands/util";
import { intersection } from "core/util/ranges";
import * as vscode from "vscode";
import type Parser from "web-tree-sitter";

type GotoProviderName =
  | "vscode.executeDefinitionProvider"
  | "vscode.executeTypeDefinitionProvider"
  | "vscode.executeDeclarationProvider"
  | "vscode.executeImplementationProvider"
  | "vscode.executeReferenceProvider";
async function executeGotoProvider(
  uri: string,
  line: number,
  character: number,
  name: GotoProviderName,
): Promise<RangeInFile[]> {
  try {
    const definitions = (await vscode.commands.executeCommand(
      name,
      vscode.Uri.parse(uri),
      new vscode.Position(line, character),
    )) as any;

    return definitions
      .filter((d: any) => (d.targetUri || d.uri) && (d.targetRange || d.range))
      .map((d: any) => ({
        filepath: (d.targetUri || d.uri).fsPath,
        range: d.targetRange || d.range,
      }));
  } catch (e) {
    console.warn(`Error executing ${name}:`, e);
    return [];
  }
}

function isRifWithContents(
  rif: RangeInFile | RangeInFileWithContents,
): rif is RangeInFileWithContents {
  return typeof (rif as any).contents === "string";
}

function findChildren(
  node: Parser.SyntaxNode,
  predicate: (n: Parser.SyntaxNode) => boolean,
): Parser.SyntaxNode[] {
  let matchingNodes: Parser.SyntaxNode[] = [];

  // Check if the current node's type is in the list of types we're interested in
  if (predicate(node)) {
    matchingNodes.push(node);
  }

  // Recursively search for matching types in all children of the current node
  for (const child of node.children) {
    matchingNodes = matchingNodes.concat(findChildren(child, predicate));
  }

  return matchingNodes;
}

function findTypeIdentifiers(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return findChildren(
    node,
    (childNode) =>
      childNode.type === "type_identifier" ||
      (["ERROR"].includes(childNode.parent?.type ?? "") &&
        childNode.type === "identifier" &&
        childNode.text[0].toUpperCase() === childNode.text[0]),
  );
}

async function crawlTypes(
  rif: RangeInFile | RangeInFileWithContents,
  ide: IDE,
  depth: number,
  results: RangeInFileWithContents[],
  searchedLabels: Set<string>,
): Promise<RangeInFileWithContents[]> {
  // Get the file contents if not already attached
  const contents = isRifWithContents(rif)
    ? rif.contents
    : await ide.readFile(rif.filepath);

  // Parse AST
  const ast = await getAst(rif.filepath, contents);
  if (!ast) return results;
  const astLineCount = ast.rootNode.text.split("\n").length;

  // Find type identifiers
  const identifierNodes = findTypeIdentifiers(ast.rootNode).filter(
    (node) => !searchedLabels.has(node.text),
  );
  // Don't search for the same type definition more than once
  // We deduplicate below to be sure, but this saves calls to the LSP
  identifierNodes.forEach((node) => searchedLabels.add(node.text));

  // Use LSP to get the definitions of those types
  const definitions = await Promise.all(
    identifierNodes.map(async (node) => {
      const [typeDef] = await executeGotoProvider(
        rif.filepath,
        // TODO: tree-sitter is zero-indexed, but there seems to be an off-by-one
        // error at least with the .ts parser sometimes
        rif.range.start.line +
          Math.min(node.startPosition.row, astLineCount - 1),
        rif.range.start.character + node.startPosition.column,
        "vscode.executeDefinitionProvider",
      );

      if (!typeDef) {
        return undefined;
      }
      return {
        ...typeDef,
        contents: await ide.readRangeInFile(typeDef.filepath, typeDef.range),
      };
    }),
  );

  // TODO: Filter out if not in our code?

  // Filter out duplicates
  for (const definition of definitions) {
    if (
      !definition ||
      results.some(
        (result) =>
          result.filepath === definition.filepath &&
          intersection(result.range, definition.range) !== null,
      )
    ) {
      continue; // ;)
    }
    results.push(definition);
  }

  // Recurse
  if (depth > 0) {
    for (const result of [...results]) {
      await crawlTypes(result, ide, depth - 1, results, searchedLabels);
    }
  }

  return results;
}

export async function getDefinitionsForNode(
  uri: string,
  node: Parser.SyntaxNode,
  ide: IDE,
  lang: AutocompleteLanguageInfo,
): Promise<RangeInFileWithContents[]> {
  const ranges: (RangeInFile | RangeInFileWithContents)[] = [];
  switch (node.type) {
    case "call_expression": {
      // function call -> function definition
      const funDefs = await executeGotoProvider(
        uri,
        line: node.startPosition.row,
        character: node.startPosition.column,
        name: "vscode.executeDefinitionProvider",
      });
      if (!funDef) {
        return [];
      }

      // Don't display a function of more than 15 lines
      // We can of course do something smarter here eventually
      let funcText = await ide.readRangeInFile(funDef.filepath, funDef.range);
      if (funcText.split("\n").length > 15) {
        let truncated = false;
        const funRootAst = await getAst(funDef.filepath, funcText);
        if (funRootAst) {
          const [funNode] = findChildren(
            funRootAst?.rootNode,
            (node) => FUNCTION_DECLARATION_NODE_TYPEs.includes(node.type),
            1,
          );
          if (funNode) {
            const [statementBlockNode] = findChildren(
              funNode,
              (node) => FUNCTION_BLOCK_NODE_TYPES.includes(node.type),
              1,
            );
            if (statementBlockNode) {
              funcText = funRootAst.rootNode.text
                .slice(0, statementBlockNode.startIndex)
                .trim();
              truncated = true;
            }
          }
        }
        if (!truncated) {
          funcText = funcText.split("\n")[0];
        }
      }

      ranges.push(funDef);

      const typeDefs = await crawlTypes(
        {
          ...funDef,
          contents: funcText,
        },
        ide,
      );
      ranges.push(...funDefs);
      break;
    }
    case "variable_declarator":
      // variable assignment -> variable definition/type
      // usages of the var that appear after the declaration
      break;
    case "impl_item":
      // impl of trait -> trait definition
      break;
    case "new_expression":
      // In 'new MyClass(...)', "MyClass" is the classNameNode
      const classNameNode = node.children.find(
        (child) => child.type === "identifier",
      );
      const [classDef] = await executeGotoProvider(
        uri,
        (classNameNode ?? node).endPosition.row,
        (classNameNode ?? node).endPosition.column,
        "vscode.executeDefinitionProvider",
      );
      if (!classDef) {
        break;
      }
      const contents = await ide.readRangeInFile(
        classDef.filepath,
        classDef.range,
      );

      ranges.push({
        ...classDef,
        contents: `${
          classNameNode?.text ? `${lang.comment} ${classNameNode.text}:\n` : ""
        }${contents.trim()}`,
      });

      const definitions = await crawlTypes(
        { ...classDef, contents },
        ide,
        1,
        [],
        new Set(),
      );
      ranges.push(...definitions.filter(Boolean));

      break;
    case "":
      // function definition -> implementations?
      break;
  }
  return await Promise.all(
    ranges.map(async (rif) => {
      if (!isRifWithContents(rif)) {
        return {
          ...rif,
          contents: await ide.readRangeInFile(rif.filepath, rif.range),
        };
      }
      return rif;
    }),
  );
}

/**
 * and other stuff not directly on the path:
 * - variables defined on line above
 * ...etc...
 */

export const getDefinitionsFromLsp: GetLspDefinitionsFunction = async (
  filepath: string,
  contents: string,
  cursorIndex: number,
  ide: IDE,
  lang: AutocompleteLanguageInfo,
): Promise<AutocompleteSnippet[]> => {
  try {
    const ast = await getAst(filepath, contents);
    if (!ast) return [];

    const treePath = await getTreePathAtCursor(ast, cursorIndex);
    if (!treePath) return [];

    const results: RangeInFileWithContents[] = [];
    for (const node of treePath.reverse()) {
      const definitions = await getDefinitionsForNode(
        filepath,
        node,
        ide,
        lang,
      );
      results.push(...definitions);
    }

    return results.map((result) => ({
      ...result,
      score: 0.8,
    }));
  } catch (e) {
    console.warn("Error getting definitions from LSP: ", e);
    return [];
  }
};
