each atomic change need to be commited.
each commit message should be semantic.
before you do any task, check bd status to see if it has been created as an issue, if not, create it.
after you've done a task, update the bd issue with what you've done.
you can use gh cli tool to search code on github and i have gh cat extension installed to help you read code files.

positron repo: posit-dev/positron, locally available at ${workspaceroot}/repo_ref/positron
ark repo: posit-dev/ark, locally available at ${workspaceroot}/repo_ref/ark

- Ark sidecar smoke test
  - 通过 pixi 的 R 4.4 环境运行：`pixi run -- node scripts/ark-sidecar-lsp-test.js`