# RRR - R Enhanced

> **This is a fork of [vscode-R](https://github.com/REditorSupport/vscode-R) by REditorSupport.**
> RRR maintains the original extension with additional bug fixes and improvements for R development in VS Code.

## Features

- Snippets for R and R Markdown
- R Language Service: code completion, function signature, symbol highlight, document outline, formatting, definition, diagnostics, references
- Interacting with R terminals: sending code to terminals, running multiple terminals, working with remote servers
- Package development commands (devtools)
- Keyboard shortcuts
- Workspace viewer, Help pages viewer, Package management
- Data viewer, Plot viewer, Webpage viewer, Browser viewer
- R Markdown support
- RStudio add-in support
- Full support of Remote Development (SSH, Containers, WSL)
- Live share collaboration

## Getting started

1. [Install R](https://cloud.r-project.org/) (>= 3.4.0) on your system. For Windows users, writing R Path to the registry is recommended in the installation.

2. Install [`languageserver`](https://github.com/REditorSupport/languageserver) in R.

    ```r
    install.packages("languageserver")
    ```

3. Install the RRR extension from the [VS Code Extension Marketplace](https://marketplace.visualstudio.com/items?itemName=tttpob.rrr).

4. Create an R file and start coding.

## Questions, issues, and contributions

- If you find a problem or have a feature request, please [file an issue](https://github.com/tttpob/vscode-R/issues).
- For issues related to the original vscode-R extension, please visit [REditorSupport/vscode-R](https://github.com/REditorSupport/vscode-R).

## Credits

This extension is a fork of [vscode-R](https://github.com/REditorSupport/vscode-R) by [REditorSupport](https://github.com/REditorSupport).
