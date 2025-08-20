# Proposal: Respawn Language Server from Active R Session

## 1. User Request Summary

The user wants to implement a feature where the R language server can be automatically restarted based on the configuration of an active, attached R session in the VS Code terminal.

**Key Objectives:**

-   When the extension attaches to a running R terminal, it should retrieve the R binary path (`R.home("bin/R")`) and library paths (`.libPaths()`) from that session.
-   This information should be sent back to the VS Code extension.
-   The extension should then use these details to respawn the R language server.
-   This ensures the language server runs with the exact same R executable and library configuration as the user's interactive session.
-   The feature should be controlled by a new setting and is intended for Linux and macOS platforms.

## 2. Implementation Plan

The implementation can be broken down into three main parts: adding a new configuration setting, modifying the R script to send session data, and updating the extension to handle this data and restart the server.

### 2.1. Configuration Setting

A new boolean setting will be added to `package.json` to enable or disable this feature.

-   **ID:** `r.lsp.respawnOnAttach`
-   **Type:** `boolean`
-   **Default:** `false`
-   **Scope:** leave it empty to use default values
-   **Description:** "Automatically restart the R Language Server using the R path and library paths from the active terminal session upon attaching. This ensures the language server matches the interactive environment. (Note: This feature is intended for Linux and macOS)."

### 2.2. R Session-Side Modification (`R/session/vsc.R`)

The `attach` function in `R/session/vsc.R` will be modified to collect and transmit the R environment details.

1.  **Gather Information:** Inside the `attach` function, we will retrieve the R binary path and library paths.
    ```r
    r_home <- R.home("bin")
    r_lib_paths <- .libPaths()
    ```
2.  **Update Attach Request:** The collected information will be added to the payload of the `request("attach", ...)` call. A new `session` object will be nested in the payload to contain this data.

    ```r
    # Existing attach function in R/session/vsc.R
    attach <- function() {
        # ... existing code ...
        request("attach",
            # ... existing properties ...
            session = list(
                rHome = R.home("bin/R"),
                libPaths = .libPaths()
            )
        )
    }
    ```

### 2.3. Extension-Side Modification (TypeScript)

The extension's TypeScript code will be updated to handle the new data and orchestrate the language server restart.

1.  **Handle Enhanced Attach Request:** The command handler for the `attach` request (likely in `src/session.ts` or a related file) will be updated to:
    -   Check for the new `session` property in the request payload.
    -   Read `rHome` and `libPaths` from the payload.

2.  **Check Feature Flag:**
    -   Before proceeding, the handler will check if the `r.lsp.respawnOnAttach` setting is `true`.

3.  **Trigger Language Server Restart:**
    -   If the feature is enabled, the handler will call a new method on the `LanguageService` instance (e.g., `rLanguageService.restartWithSessionPaths(rHome, libPaths)`).

4.  **Update `LanguageService` (`src/languageService.ts`):**
    -   A new public method `restartWithSessionPaths(rPath: string, libPaths: string[])` will be added.
    -   This method will store `rPath` and `libPaths` in private member variables of the `LanguageService` class (e.g., `this.sessionRPath` and `this.sessionLibPaths`).
    -   After storing the paths, it will call the existing `restart()` method.

5.  **Modify Server Spawning Logic:**
    -   The `createClient` or `spawnServer` method inside `LanguageService` will be modified.
    -   When determining the R executable path, it will prioritize the session-provided path:
        ```typescript
        const rPath = this.sessionRPath || await getRpath();
        ```
    -   When setting up the environment variables for the child process, it will set `R_LIBS_USER` to the session-provided library paths, joined by a colon:
        ```typescript
        const env = { ...process.env };
        if (this.sessionLibPaths && this.sessionLibPaths.length > 0) {
            env.R_LIBS_USER = this.sessionLibPaths.join(':');
        }
        ```
    -   This ensures that the newly spawned language server process uses the exact environment from the attached R session. The existing `restart` method's logic of stopping and starting the clients will handle the rest.

By following this plan, we can achieve a seamless integration where the language server's environment automatically synchronizes with the user's active R terminal, resolving potential inconsistencies in R versions or package availability.