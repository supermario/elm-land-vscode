const vscode = require('vscode')

module.exports = (globalState) => {
  return {
    openCustomDocument: (uri, context, token) => {
      // This gets passed into resolveCustomEditor
      return {
        uri,
        dispose: () => { }
      }
    },
    resolveCustomEditor: async (document, panel, token) => {
      let uri = document.uri
      let [author, package, version] = uri.path.split('/').slice(-4, -1)
      let params = new URLSearchParams(uri.query)
      let moduleName = params.get('moduleName')
      let typeOrValue = params.get('typeOrValue')
      let docs = await vscode.workspace.openTextDocument(uri)
      let url =
        `https://package.elm-lang.org/packages/${author}/${package}/${version}/${moduleName.split('.').join('-')}`

      if (typeOrValue) {
        url += `#` + typeOrValue
      }

      const flags = {
        author,
        package,
        version,
        moduleName,
        typeOrValue,
        url,
        docs: JSON.parse(docs.getText())
      }

      panel.webview.html = `<!DOCTYPE html>
      <html>
      <body>
          <h1>Elm Packages!</h1>
          <ul>
            <li>Author: ${author}</li>
            <li>Package: ${package}</li>
            <li>Version: ${version}</li>
            <li>Module name: ${moduleName}</li>
            <li>Type or value: ${typeOrValue}</li>
            <li>Website: <a href="${url}">${url}</li>
          </ul>
      </body>
      </html>`
    }
  }
}