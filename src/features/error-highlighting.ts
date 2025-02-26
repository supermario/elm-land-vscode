import * as child_process from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import * as autodetectElmJson from './shared/autodetect-elm-json'
import { GlobalState } from './shared/autodetect-elm-json'
import { ElmJsonFile } from './shared/elm-json-file'
import sharedLogic, { Feature } from './shared/logic'

let diagnostics = vscode.languages.createDiagnosticCollection(sharedLogic.pluginId)

export const feature: Feature = ({ globalState, context }) => {

  context.subscriptions.push(
    vscode.commands.registerCommand('elmLand.installElm', () => {
      const terminal = vscode.window.createTerminal(`Install elm`)
      terminal.sendText(`npm install -g elm@0.19.1`)
      terminal.show()
    })
  )

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => run(globalState, diagnostics, document))
  )
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(document => run(globalState, diagnostics, document))
  )
  context.subscriptions.push(diagnostics)

  // Reload and show errors anytime an "elm.json" file is saved or opened
  const recompileElmJson = async (document: vscode.TextDocument) => {
    const isEnabled: boolean = vscode.workspace.getConfiguration('elmLand').feature.errorHighlighting
    if (!isEnabled) return

    if (document.uri.fsPath.endsWith('elm.json')) {
      await autodetectElmJson.run(globalState)
      await run(globalState, diagnostics, document)
    }
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(recompileElmJson)
  )
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(recompileElmJson)
  )
}


const run = async (
  globalState: GlobalState,
  collection: vscode.DiagnosticCollection,
  document: vscode.TextDocument
) => {
  let start = Date.now()
  // Allow user to disable this feature
  const isEnabled: boolean = vscode.workspace.getConfiguration('elmLand').feature.errorHighlighting
  if (!isEnabled) {
    collection.clear()
    return
  }

  let uri =
    document.fileName.includes('.git')
      ? vscode.Uri.file(document.fileName.split('.git')[0] || '')
      : document.uri

  const isElmFile = uri.fsPath && uri.fsPath.endsWith('.elm')
  const isElmJsonFile = uri.fsPath && uri.fsPath.endsWith('elm.json')

  if (isElmFile || isElmJsonFile) {
    let elmJsonFile = sharedLogic.findElmJsonFor(globalState, uri)

    let compileElmFile = async (elmJsonFile: ElmJsonFile, elmFilesToCompile: string[]) => {
      const error = await Elm.compile({ elmJsonFile, elmFilesToCompile })

      if (error) {
        const items = Elm.toDiagnosticItems(elmJsonFile, { error })
        for (var item of items) {
          let { fsPath, diagnostics } = item
          collection.set(vscode.Uri.file(fsPath), diagnostics)
        }
      }
    }

    // Remove stale errors
    collection.clear()

    if (elmJsonFile) {
      let entrypoints = await sharedLogic.keepFilesThatExist(elmJsonFile.entrypoints)
      let elmFilesToCompile = isElmFile ? entrypoints.concat([uri.fsPath]) : entrypoints

      if (elmFilesToCompile.length > 0) {
        await compileElmFile(elmJsonFile, elmFilesToCompile)
        console.info('errorHighlighting', `${Date.now() - start}ms`)

        if (globalState.isFirstTimeRunningPlugin) {
          globalState.isFirstTimeRunningPlugin = false
          // Packages should now be installed, re-run the autodetect script
          await autodetectElmJson.run(globalState)
        }
      }
    } else {
      console.error(`Couldn't find an elm.json file for ${uri.fsPath}`)
    }
  }
}

type ParsedError
  = ParsedCompileError
  | ParsedReportError
  | { kind: 'unknown', raw: string }

type ParsedCompileError = {
  kind: 'compile-errors'
  errors: ElmCompilerError[]
}

type ParsedReportError = {
  kind: 'error'
  title: string
  path: string | null
  message: ElmErrorMessage[]
}

const Elm = {
  compile: (input: { elmJsonFile: ElmJsonFile, elmFilesToCompile: string[] }): Promise<ParsedError | undefined> => {
    let deduplicated = [...new Set(input.elmFilesToCompile)]
    const promise: Promise<ParsedError | undefined> =
      new Promise((resolve, reject) => {
        const isWindows = process.platform === 'win32'
        // This uses `spawn` so that we can support folders with spaces in them
        // without having to think about escaping.
        const child = child_process.spawn(
          'elm',
          [
            'make',
            // `shell: true` is needed on Windows to execute shell scripts (non .exe files).
            // When installing binaries with npm on Windows they are wrapped by a shell script.
            // `shell: true` requires manual escaping. Luckily, paths on Windows cannot contain
            // double quotes, so just adding double quotes around them should be enough and correct.
            ...(isWindows ? deduplicated.map(file => `"${file}"`) : deduplicated),
            '--output=/dev/null',
            '--report=json'
          ],
          {
            cwd: input.elmJsonFile.projectFolder,
            env: sharedLogic.npxEnv(),
            shell: isWindows
          }
        )

        child.on('error', (err: Error & { code?: string }) => {
          if (err.code === "ENOENT") {
            vscode.window.showInformationMessage(
              'The "Error highlighting" feature requires "elm"',
              { modal: false },
              'Install'
            ).then(
              response => {
                if (response === 'Install') {
                  vscode.commands.executeCommand('elmLand.installElm')
                }
                resolve(undefined)
              },
              reject
            )
          } else {
            resolve({ kind: 'unknown', raw: err.message })
          }
        })

        const stderrBuffers: Array<Buffer> = []

        child.stderr.on('data', (chunk: Buffer) => {
          stderrBuffers.push(chunk)
        })

        child.on('exit', (exitCode) => {
          if (exitCode === 0) {
            resolve(undefined)
          } else {
            const stderr = Buffer.concat(stderrBuffers).toString('utf-8')

            try {
              const json: ElmError = JSON.parse(stderr)

              switch (json.type) {
                case 'compile-errors':
                  let error1: ParsedCompileError = {
                    kind: 'compile-errors',
                    errors: json.errors
                  }
                  return resolve(error1)
                case 'error':
                  let error2: ParsedReportError = {
                    kind: 'error',
                    title: json.title,
                    path: json.path,
                    message: json.message
                  }
                  return resolve(error2)
                default:
                  throw new Error("Unhandled error type: " + ((json as any).type))
              }
            } catch {
              resolve({ kind: 'unknown', raw: stderr })
            }
          }
        })
      })

    return promise
  },

  toDiagnosticItems: (elmJsonFile: ElmJsonFile, input: { error: ParsedError }): DiagnosticItem[] => {
    switch (input.error.kind) {
      case 'error':
        let items: DiagnosticItem[] = []
        const entireFileRange: vscode.Range =
          new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
          )

        if (input.error.title === 'MISSING SOURCE DIRECTORY') {
          let directory = input.error.message.slice(1, -1).map(fromMessageToString)[0]
          if (directory) {
            let elmRange = sharedLogic.findFirstOccurenceOfWordInFile(directory, elmJsonFile.rawFileContents)
            if (elmRange) {
              items = [
                toDiagnosticItem({
                  filepath: elmJsonFile.uri.fsPath,
                  problems: [
                    {
                      range: sharedLogic.fromElmRange(elmRange),
                      title: input.error.title,
                      message: input.error.message
                    }
                  ]
                })
              ]
            }
          }
        } else if (input.error.title === 'MISSING SOURCE DIRECTORIES') {
          let directories: string[] = input.error.message.filter(x => typeof x === 'object').map(fromMessageToString)
          if (directories) {
            items = [
              toDiagnosticItem({
                filepath: elmJsonFile.uri.fsPath,
                problems: directories
                  .map(directory => {
                    let elmRange = sharedLogic.findFirstOccurenceOfWordInFile(directory, elmJsonFile.rawFileContents)
                    if (elmRange) {
                      return {
                        range: sharedLogic.fromElmRange(elmRange),
                        title: (input.error as ParsedReportError).title,
                        message: ((input.error as ParsedReportError)).message
                      }
                    } else {
                      return undefined
                    }
                  }).filter(sharedLogic.isDefined)
              })
            ]
          }
        } else {
          items = [
            toDiagnosticItem({
              filepath:
                input.error.path
                  ? path.join(elmJsonFile.projectFolder, input.error.path)
                  : elmJsonFile.uri.fsPath,
              problems: [
                {
                  range: entireFileRange,
                  title: input.error.title,
                  message: input.error.message
                }
              ]
            })
          ]
        }
        return items
      case 'compile-errors':
        const toDiagnostics = (error: ElmCompilerError): DiagnosticItem => {
          const problems = error.problems

          const fromProblemToDiagnostic = (problem: ElmCompilerProblem) => {
            const diagnostic: vscode.Diagnostic = {
              severity: vscode.DiagnosticSeverity.Error,
              range: new vscode.Range(
                Elm.fromErrorLocation(problem.region.start),
                Elm.fromErrorLocation(problem.region.end)
              ),
              message: Elm.formatErrorMessage(problem.title, problem.message)
            }
            return diagnostic
          }

          let diagnostics: vscode.Diagnostic[] = problems.map(fromProblemToDiagnostic)

          return { fsPath: error.path, diagnostics }
        }
        return input.error.errors.flatMap(toDiagnostics)
      case 'unknown':
        return []
    }
  },
  fromErrorLocation: (location: ElmErrorPosition): vscode.Position => {
    return new vscode.Position(location.line - 1, location.column - 1)
  },
  formatErrorMessage: (title: string, message: ElmErrorMessage[]) => {
    return title + '\n\n' + message.map(line => {
      if (typeof line === 'string') {
        return line
      } else {
        // VS Code Diagnostics do not support color error messages
        if (line.color === 'RED') {
          return line.string
        }
        return line.string
      }
    }).join('') + '\n'
  }
}



type ToDiagnosticItemInput = {
  filepath: string
  problems: ElmProblem[]
}

type ElmProblem = {
  range: vscode.Range
  title: string
  message: ElmErrorMessage[]
}

type ElmError
  = CompilerReportError
  | ReportError

type ReportError = {
  type: 'error'
  path: null | string
  title: string
  message: ElmErrorMessage[]
}

type CompilerReportError = {
  type: 'compile-errors'
  errors: ElmCompilerError[]
}

type ElmCompilerError = {
  path: string
  name: string
  problems: ElmCompilerProblem[]
}

type ElmCompilerProblem = {
  title: string
  region: ElmErrorRegion
  message: ElmErrorMessage[]
}

type ElmErrorRegion = {
  start: ElmErrorPosition
  end: ElmErrorPosition
}

type ElmErrorPosition = { line: number, column: number }

type ElmErrorColor
  = 'RED'
  | 'MAGENTA'
  | 'YELLOW'
  | 'GREEN'
  | 'CYAN'
  | 'BLUE'
  | 'BLACK'
  | 'WHITE'

type ElmErrorMessage = string | ElmErrorStyledMessage

type ElmErrorStyledMessage = {
  bold: boolean
  underline: boolean
  color: ElmErrorColor | Lowercase<ElmErrorColor> | null
  string: string
}

type DiagnosticItem = {
  fsPath: string
  diagnostics: vscode.Diagnostic[]
}

const toDiagnosticItem = ({ filepath, problems }: ToDiagnosticItemInput): DiagnosticItem => {
  let diagnostics = problems.map(({ range, title, message }) => ({
    severity: vscode.DiagnosticSeverity.Error,
    range,
    message: Elm.formatErrorMessage(title, message)
  }))
  return {
    fsPath: filepath,
    diagnostics
  }
}

const fromMessageToString = (message: ElmErrorMessage): string =>
  typeof message === 'string'
    ? message
    : message.string
