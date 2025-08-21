/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */


import * as vscode from 'vscode';
import { Httpgd } from 'httpgd';
import { HttpgdPlot, IHttpgdViewer, HttpgdViewerOptions } from './httpgdTypes';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';

import { asViewColumn, config, setContext, UriIcon, makeWebviewCommandUriString } from '../util';

import { extensionContext } from '../extension';

import { FocusPlotMessage, InMessage, OutMessage, ToggleStyleMessage, UpdatePlotMessage, HidePlotMessage, AddPlotMessage, PreviewPlotLayout, PreviewPlotLayoutMessage, ToggleFullWindowMessage } from './webviewMessages';
import { HttpgdIdResponse, HttpgdPlotId, HttpgdRendererId } from 'httpgd/lib/types';
import { Response } from 'node-fetch';
import { autoShareBrowser, isHost, shareServer } from '../liveShare';

// Cache interface for plot data
interface PlotCacheKey {
    id: HttpgdPlotId;
    width: number;
    height: number;
    zoom: number;
    dpr: number;
    renderer: string;
}

class PlotCache {
    private cache = new Map<string, HttpgdPlot<string>>();
    private maxSize: number = 50; // Maximum number of cached plots

    private makeKey(params: PlotCacheKey): string {
        return `${params.id}_${params.width}_${params.height}_${params.zoom}_${params.dpr}_${params.renderer}`;
    }

    get(params: PlotCacheKey): HttpgdPlot<string> | undefined {
        const key = this.makeKey(params);
        return this.cache.get(key);
    }

    set(params: PlotCacheKey, plot: HttpgdPlot<string>): void {
        const key = this.makeKey(params);
        
        // Remove oldest entries if cache is full
        if (this.cache.size >= this.maxSize) {
            const entries = Array.from(this.cache.entries());
            if (entries.length > 0) {
                const oldestKey = entries[0][0];
                this.cache.delete(oldestKey);
            }
        }
        
        this.cache.set(key, plot);
    }

    clear(): void {
        this.cache.clear();
    }

    // Remove entries for a specific plot ID
    removeById(id: HttpgdPlotId): void {
        for (const [key, plot] of this.cache.entries()) {
            if (plot.id === id) {
                this.cache.delete(key);
            }
        }
    }
}

const commands = [
    'showViewers',
    'openUrl',
    'openExternal',
    'showIndex',
    'toggleStyle',
    'toggleFullWindow',
    'togglePreviewPlots',
    'exportPlot',
    'nextPlot',
    'prevPlot',
    'lastPlot',
    'firstPlot',
    'hidePlot',
    'closePlot',
    'resetPlots',
    'zoomIn',
    'zoomOut',
    'clearCache'
] as const;

type CommandName = typeof commands[number];

export function initializeHttpgd(): HttpgdManager {
    const httpgdManager = new HttpgdManager();
    for (const cmd of commands) {
        const fullCommand = `r.plot.${cmd}`;
        const cb = httpgdManager.getCommandHandler(cmd);
        extensionContext.subscriptions.push(
            vscode.commands.registerCommand(fullCommand, cb)
        );
    }
    return httpgdManager;
}

export class HttpgdManager {
    viewers: HttpgdViewer[] = [];

    viewerOptions: HttpgdViewerOptions;

    recentlyActiveViewers: HttpgdViewer[] = [];

    constructor() {
        const htmlRoot = extensionContext.asAbsolutePath('html/httpgd');
        this.viewerOptions = {
            parent: this,
            htmlRoot: htmlRoot,
            preserveFocus: true
        };
    }

    public async showViewer(urlString: string): Promise<void> {
        const url = new URL(urlString);
        const host = url.host;
        const token = url.searchParams.get('token') || undefined;
        const ind = this.viewers.findIndex(
            (viewer) => viewer.host === host
        );
        if (ind >= 0) {
            const viewer = this.viewers.splice(ind, 1)[0];
            this.viewers.unshift(viewer);
            viewer.show();
        } else {
            const conf = config();
            const colorTheme = conf.get('plot.defaults.colorTheme', 'vscode');
            this.viewerOptions.stripStyles = (colorTheme === 'vscode');
            this.viewerOptions.previewPlotLayout = conf.get<PreviewPlotLayout>('plot.defaults.plotPreviewLayout', 'multirow');
            this.viewerOptions.refreshTimeoutLength = conf.get('plot.timing.refreshInterval', 10);
            this.viewerOptions.resizeTimeoutLength = conf.get('plot.timing.resizeInterval', 100);
            this.viewerOptions.fullWindow = conf.get('plot.defaults.fullWindowMode', false);
            this.viewerOptions.renderer = conf.get('plot.defaults.httpgdRenderer', 'svgp');
            this.viewerOptions.token = token;
            const viewer = new HttpgdViewer(host, this.viewerOptions);
            if (isHost() && autoShareBrowser) {
                const disposable = await shareServer(url, 'httpgd');
                viewer.webviewPanel?.onDidDispose(() => void disposable.dispose());
            }
            this.viewers.unshift(viewer);
        }
    }

    public registerActiveViewer(viewer: HttpgdViewer): void {
        const ind = this.recentlyActiveViewers.indexOf(viewer);
        if (ind) {
            this.recentlyActiveViewers.splice(ind, 1);
        }
        this.recentlyActiveViewers.unshift(viewer);
    }

    public getRecentViewer(): HttpgdViewer | undefined {
        return this.recentlyActiveViewers.find((viewer) => !!viewer.webviewPanel);
    }

    public getNewestViewer(): HttpgdViewer | undefined {
        return this.viewers[0];
    }

    public getCommandHandler(command: CommandName): (...args: any[]) => void {
        return (...args: any[]) => {
            this.handleCommand(command, ...args);
        };
    }

    public async openUrl(): Promise<void> {
        const clipText = await vscode.env.clipboard.readText();
        const val0 = clipText.trim().split(/[\n ]/)[0];
        const options: vscode.InputBoxOptions = {
            value: val0,
            prompt: 'Please enter the httpgd url'
        };
        const urlString = await vscode.window.showInputBox(options);
        if (urlString) {
            await this.showViewer(urlString);
        }
    }

    // generic command handler
    public handleCommand(command: CommandName, hostOrWebviewUri?: string | vscode.Uri, ...args: any[]): void {
        // the number and type of arguments given to a command can vary, depending on where it was called from:
        // - calling from the title bar menu provides two arguments, the first of which identifies the webview
        // - calling from the command palette provides no arguments
        // - calling from a command uri provides a flexible number/type of arguments
        // below  is an attempt to handle these different combinations efficiently and (somewhat) robustly
        //

        if (command === 'showViewers') {
            this.viewers.forEach(viewer => {
                viewer.show(true);
            });
            return;
        } else if (command === 'openUrl') {
            void this.openUrl();
            return;
        }

        // Identify the correct viewer
        let viewer: HttpgdViewer | undefined;
        if (typeof hostOrWebviewUri === 'string') {
            const host = hostOrWebviewUri;
            viewer = this.viewers.find((viewer) => viewer.host === host);
        } else if (hostOrWebviewUri instanceof vscode.Uri) {
            const uri = hostOrWebviewUri;
            viewer = this.viewers.find((viewer) => viewer.getPanelPath() === uri.path);
        }

        // fall back to most recent viewer
        viewer ||= this.getRecentViewer();

        // Abort if no viewer identified
        if (!viewer) {
            return;
        }

        // Get possible arguments for commands:
        const stringArg = findItemOfType(args, 'string');
        const boolArg = findItemOfType(args, 'boolean');

        // Call corresponding method, possibly with an argument:
        switch (command) {
            case 'showIndex': {
                void viewer.focusPlot(stringArg);
                break;
            } case 'nextPlot': {
                void viewer.nextPlot(boolArg);
                break;
            } case 'prevPlot': {
                void viewer.prevPlot(boolArg);
                break;
            } case 'lastPlot': {
                void viewer.nextPlot(true);
                break;
            } case 'firstPlot': {
                void viewer.prevPlot(true);
                break;
            } case 'resetPlots': {
                viewer.resetPlots();
                break;
            } case 'toggleStyle': {
                void viewer.toggleStyle(boolArg);
                break;
            } case 'togglePreviewPlots': {
                void viewer.togglePreviewPlots(stringArg as PreviewPlotLayout);
                break;
            } case 'closePlot': {
                void viewer.closePlot(stringArg);
                break;
            } case 'hidePlot': {
                void viewer.hidePlot(stringArg);
                break;
            } case 'exportPlot': {
                void viewer.exportPlot(stringArg);
                break;
            } case 'zoomIn': {
                void viewer.zoomIn();
                break;
            } case 'zoomOut': {
                void viewer.zoomOut();
                break;
            } case 'openExternal': {
                void viewer.openExternal();
                break;
            } case 'toggleFullWindow': {
                void viewer.toggleFullWindow();
                break;
            } case 'clearCache': {
                viewer.clearPlotCache();
                break;
            } default: {
                break;
            }
        }
    }
}


interface EjsData {
    overwriteStyles: boolean;
    previewPlotLayout: PreviewPlotLayout;
    activePlot?: HttpgdPlotId;
    plots: HttpgdPlot<string>[];
    largePlot: HttpgdPlot<string>;
    host: string;
    asLocalPath: (relPath: string) => string;
    asWebViewPath: (localPath: string) => string;
    makeCommandUri: (command: string, ...args: any[]) => string;
    overwriteCssPath: string;

    // only used to render an individual smallPlot div:
    plot?: HttpgdPlot<string>;
}

interface ShowOptions {
    viewColumn: vscode.ViewColumn,
    preserveFocus?: boolean
}

export class HttpgdViewer implements IHttpgdViewer {

    readonly parent: HttpgdManager;

    readonly host: string;
    readonly token?: string;

    // Actual webview where the plot viewer is shown
    // Will have to be created anew, if the user closes it and the plot changes
    webviewPanel?: vscode.WebviewPanel;

    // Api that provides plot contents etc.
    readonly api: Httpgd;

    // active plots
    plots: HttpgdPlot<string>[] = [];

    // Id of the currently viewed plot
    activePlot?: HttpgdPlotId;

    // Ids of plots that are not shown, but not closed inside httpgd
    hiddenPlots: HttpgdPlotId[] = [];

    readonly defaultStripStyles: boolean = true;
    stripStyles: boolean;

    readonly defaultPreviewPlotLayout: PreviewPlotLayout = 'multirow';
    previewPlotLayout: PreviewPlotLayout;

    readonly defaultFullWindow: boolean = false;
    fullWindow: boolean;

    // Custom file to be used instead of `styleOverwrites.css`
    customOverwriteCssPath?: string;

    // Size of the view area:
    viewHeight: number = 600;
    viewWidth: number = 800;

    // Size of the shown plot (as computed):
    plotHeight: number = 600;
    plotWidth: number = 800;

    readonly zoom0: number = 1;
    zoom: number = this.zoom0;

    protected resizeTimeout?: NodeJS.Timeout;
    readonly resizeTimeoutLength: number = 1300;

    protected refreshTimeout?: NodeJS.Timeout;
    readonly refreshTimeoutLength: number = 10;

    private lastExportUri?: vscode.Uri;

    readonly htmlTemplate: string;
    readonly smallPlotTemplate: string;
    readonly htmlRoot: string;
    readonly renderer: string; // renderer id used for inline viewing
    // device pixel ratio reported by the webview
    dpr: number = 1;
    // Helper indicating if the current renderer is rasterized
    rendererIsRasterized: () => boolean = () => false;

    // Plot cache for performance optimization
    private plotCache: PlotCache = new PlotCache();

    readonly showOptions: ShowOptions;
    readonly webviewOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions;

    // Computed properties:

    // Get/set active plot by index instead of id:
    protected get activeIndex(): number {
        if(!this.activePlot){
            return -1;
        }
        return this.getIndex(this.activePlot);
    }
    protected set activeIndex(ind: number) {
        if (this.plots.length === 0) {
            this.activePlot = undefined;
        } else {
            ind = Math.max(ind, 0);
            ind = Math.min(ind, this.plots.length - 1);
            this.activePlot = this.plots[ind].id;
        }
    }

    // constructor called by the session watcher if a corresponding function was called in R
    // creates a new api instance itself
    constructor(host: string, options: HttpgdViewerOptions) {
        this.host = host;
        this.token = options.token;
        this.parent = options.parent;

        this.api = new Httpgd(this.host, this.token, true);
        this.api.onPlotsChanged((newState) => {
            void this.refreshPlotsDelayed(newState.plots);
        });
        this.api.onConnectionChanged(() => {
            // todo
        });
        this.api.onDeviceActiveChanged(() => {
            // todo
        });
        const conf = config();
        this.customOverwriteCssPath = conf.get('plot.customStyleOverwrites', '');
        const localResourceRoots = (
            this.customOverwriteCssPath ?
                [extensionContext.extensionUri, vscode.Uri.file(path.dirname(this.customOverwriteCssPath))] :
                undefined
        );
        this.htmlRoot = options.htmlRoot;
        this.htmlTemplate = fs.readFileSync(path.join(this.htmlRoot, 'index.ejs'), 'utf-8');
        this.smallPlotTemplate = fs.readFileSync(path.join(this.htmlRoot, 'smallPlot.ejs'), 'utf-8');
        this.showOptions = {
            viewColumn: options.viewColumn ?? asViewColumn(conf.get<string>('session.viewers.viewColumn.plot'), vscode.ViewColumn.Two),
            preserveFocus: !!options.preserveFocus
        };
        this.webviewOptions = {
            enableCommandUris: true,
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: localResourceRoots
        };
        this.defaultStripStyles = options.stripStyles ?? this.defaultStripStyles;
        this.stripStyles = this.defaultStripStyles;
        this.defaultPreviewPlotLayout = options.previewPlotLayout ?? this.defaultPreviewPlotLayout;
        this.previewPlotLayout = this.defaultPreviewPlotLayout;
        this.defaultFullWindow = options.fullWindow ?? this.defaultFullWindow;
        this.fullWindow = this.defaultFullWindow;
        // Use the correct option for resize debounce interval
        this.resizeTimeoutLength = options.resizeTimeoutLength ?? this.resizeTimeoutLength;
        this.refreshTimeoutLength = options.refreshTimeoutLength ?? this.refreshTimeoutLength;
        this.renderer = options.renderer ?? 'svgp';
        // Initialize DPR and rasterization helper from options (with defaults)
        this.dpr = options.dpr ?? 1;
        this.rendererIsRasterized = options.rendererIsRasterized ?? (() => this.renderer.toLowerCase() === 'png');
        void this.api.connect();
        //void this.checkState();
    }


    // Methods to interact with the webview
    // Can e.g. be called by vscode commands + menu items:

    // Called to create a new webview if the user closed the old one:
    public show(preserveFocus?: boolean): void {
        preserveFocus ??= this.showOptions.preserveFocus;
        if (!this.webviewPanel) {
            const showOptions = {
                ...this.showOptions,
                preserveFocus: preserveFocus
            };
            this.webviewPanel = this.makeNewWebview(showOptions);
            this.refreshHtml();
        } else {
            this.webviewPanel.reveal(undefined, preserveFocus);
        }
        this.parent.registerActiveViewer(this);
    }

    public openExternal(): void {
        let urlString = `http://${this.host}/live`;
        if (this.token) {
            urlString += `?token=${this.token}`;
        }
        const uri = vscode.Uri.parse(urlString);
        void vscode.env.openExternal(uri);
    }

    // focus a specific plot id
    public async focusPlot(id?: HttpgdPlotId): Promise<void> {
        this.activePlot = id || this.activePlot;
        const plt = this.plots[this.activeIndex];
        if (plt.height !== this.viewHeight || plt.width !== this.viewHeight || plt.zoom !== this.zoom) {
            await this.refreshPlots(this.api.getPlots());
        } else {
            this._focusPlot();
        }
    }
    protected _focusPlot(plotId?: HttpgdPlotId): void {
        plotId ??= this.activePlot;
        if(!plotId){
            return;
        }
        const msg: FocusPlotMessage = {
            message: 'focusPlot',
            plotId: plotId
        };
        this.postWebviewMessage(msg);
        void this.setContextValues();
    }

    // navigate through plots (supply `true` to go to end/beginning of list)
    public async nextPlot(last?: boolean): Promise<void> {
        this.activeIndex = last ? this.plots.length - 1 : this.activeIndex + 1;
        await this.focusPlot();
    }
    public async prevPlot(first?: boolean): Promise<void> {
        this.activeIndex = first ? 0 : this.activeIndex - 1;
        await this.focusPlot();
    }

    // restore closed plots, reset zoom, redraw html
    public resetPlots(): void {
        this.hiddenPlots = [];
        this.zoom = this.zoom0;
        // Clear cache when plots are reset
        this.plotCache.clear();
        void this.refreshPlots(this.api.getPlots(), true, true);
    }

    public hidePlot(id?: HttpgdPlotId): void {
        id ??= this.activePlot;
        if (!id) { return; }
        const tmpIndex = this.activeIndex;
        this.hiddenPlots.push(id);
        this.plots = this.plots.filter((plt) => !this.hiddenPlots.includes(plt.id));
        if (id === this.activePlot) {
            this.activeIndex = tmpIndex;
            this._focusPlot();
        }
        this._hidePlot(id);
    }
    protected _hidePlot(id: HttpgdPlotId): void {
        const msg: HidePlotMessage = {
            message: 'hidePlot',
            plotId: id
        };
        this.postWebviewMessage(msg);
    }

    public async closePlot(id?: HttpgdPlotId): Promise<void> {
        id ??= this.activePlot;
        if (id) {
            this.hidePlot(id);
            // Remove from cache when plot is closed
            this.plotCache.removeById(id);
            await this.api.removePlot({ id: id });
        }
    }

    public toggleStyle(force?: boolean): void {
        this.stripStyles = force ?? !this.stripStyles;
        const msg: ToggleStyleMessage = {
            message: 'toggleStyle',
            useOverwrites: this.stripStyles
        };
        this.postWebviewMessage(msg);
    }

    public toggleFullWindow(force?: boolean): void {
        this.fullWindow = force ?? !this.fullWindow;
        const msg: ToggleFullWindowMessage = {
            message: 'toggleFullWindow',
            useFullWindow: this.fullWindow
        };
        this.postWebviewMessage(msg);
    }

    public togglePreviewPlots(force?: PreviewPlotLayout): void {
        if (force) {
            this.previewPlotLayout = force;
        } else if (this.previewPlotLayout === 'multirow') {
            this.previewPlotLayout = 'scroll';
        } else if (this.previewPlotLayout === 'scroll') {
            this.previewPlotLayout = 'hidden';
        } else if (this.previewPlotLayout === 'hidden') {
            this.previewPlotLayout = 'multirow';
        }
        const msg: PreviewPlotLayoutMessage = {
            message: 'togglePreviewPlotLayout',
            style: this.previewPlotLayout
        };
        this.postWebviewMessage(msg);
    }

    public zoomOut(): void {
        if (this.zoom > 0) {
            this.zoom -= 0.1;
            void this.resizePlot();
        }
    }

    public zoomIn(): void {
        this.zoom += 0.1;
        void this.resizePlot();
    }

    // Clear plot cache manually (useful for debugging or when plots change significantly)
    public clearPlotCache(): void {
        this.plotCache.clear();
    }


    public async setContextValues(mightBeInBackground: boolean = false): Promise<void> {
        if (this.webviewPanel?.active) {
            this.parent.registerActiveViewer(this);
            await setContext('r.plot.active', true);
            await setContext('r.plot.canGoBack', this.activeIndex > 0);
            await setContext('r.plot.canGoForward', this.activeIndex < this.plots.length - 1);
        } else if (!mightBeInBackground) {
            await setContext('r.plot.active', false);
        }
    }

    public getPanelPath(): string | undefined {
        if (!this.webviewPanel) {
            return undefined;
        }
        const dummyUri = this.webviewPanel.webview.asWebviewUri(vscode.Uri.file(''));
        const m = /^[^.]*/.exec(dummyUri.authority);
        const webviewId = m?.[0] || '';
        return `webview-panel/webview-${webviewId}`;
    }

    protected getIndex(id: HttpgdPlotId): number {
        return this.plots.findIndex((plt: HttpgdPlot<string>) => plt.id === id);
    }

    protected handleResize(height: number, width: number, userTriggered: boolean = false): void {
        this.viewHeight = height;
        this.viewWidth = width;
        // DPR is updated via messages; no-op here
        if (userTriggered || this.resizeTimeoutLength === 0) {
            if(this.resizeTimeout){
                clearTimeout(this.resizeTimeout);
            }
            this.resizeTimeout = undefined;
            void this.resizePlot();
        } else if (!this.resizeTimeout) {
            this.resizeTimeout = setTimeout(() => {
                void this.resizePlot().then(() =>
                    this.resizeTimeout = undefined
                );
            }, this.resizeTimeoutLength);
        }
    }

    protected async resizePlot(id?: HttpgdPlotId): Promise<void> {
        id ??= this.activePlot;
        if (!id) { return; }
        // Apply DPR for raster renderers only
        const scale = this.rendererIsRasterized() ? this.dpr : 1;
        const reqWidth = Math.round(this.viewWidth * scale);
        const reqHeight = Math.round(this.viewHeight * scale);
        const effectiveZoom = this.zoom * scale;
        const plt = await this.getPlotContent(id, reqWidth, reqHeight, effectiveZoom);
        this.plotWidth = plt.width;
        this.plotHeight = plt.height;
        
        // Update the cached plot data to match the new size
        const plotIndex = this.plots.findIndex(p => p.id === id);
        if (plotIndex >= 0) {
            this.plots[plotIndex] = plt;
        }
        
        this.updatePlot(plt);
    }

    protected async refreshPlotsDelayed(plotsIdResponse: HttpgdIdResponse[], redraw: boolean = false, force: boolean = false): Promise<void> {
        if(this.refreshTimeoutLength === 0){
            await this.refreshPlots(plotsIdResponse, redraw, force);
        } else{
            clearTimeout(this.refreshTimeout);
            this.refreshTimeout = setTimeout(() => {
                void this.refreshPlots(plotsIdResponse, redraw, force).then(() =>
                    this.refreshTimeout = undefined
                );
            }, this.refreshTimeoutLength);
        }
    }

    protected async refreshPlots(plotsIdResponse: HttpgdIdResponse[], redraw: boolean = false, force: boolean = false): Promise<void> {
        const nPlots = this.plots.length;
        let plotIds = plotsIdResponse.map((x) => x.id);
        plotIds = plotIds.filter((id) => !this.hiddenPlots.includes(id));
        const newPlotPromises = plotIds.map(async (id) => {
            const plot = this.plots.find((plt) => plt.id === id);
            if (force || !plot || id === this.activePlot) {
                // Force a re-fetch by clearing the plot from cache.
                this.plotCache.removeById(id);
                const scale = this.rendererIsRasterized() ? this.dpr : 1;
                const reqWidth = Math.round(this.viewWidth * scale);
                const reqHeight = Math.round(this.viewHeight * scale);
                const effectiveZoom = this.zoom * scale;
                return await this.getPlotContent(id, reqWidth, reqHeight, effectiveZoom);
            } else {
                return plot;
            }
        });
        const newPlots = await Promise.all(newPlotPromises);
        const oldPlotIds = this.plots.map(plt => plt.id);
        this.plots = newPlots;
        if (this.plots.length !== nPlots) {
            this.activePlot = this.plots[this.plots.length - 1]?.id;
        }
        if (redraw || !this.webviewPanel) {
            this.refreshHtml();
        } else {
            for (const plt of this.plots) {
                if (oldPlotIds.includes(plt.id)) {
                    this.updatePlot(plt);
                } else {
                    this.addPlot(plt);
                }
            }
            this._focusPlot();
        }
    }

    protected updatePlot(plt: HttpgdPlot<string>): void {
        const msg: UpdatePlotMessage = {
            message: 'updatePlot',
            plotId: plt.id,
            svg: plt.data
        };
        this.postWebviewMessage(msg);
    }

    protected addPlot(plt: HttpgdPlot<string>): void {
        const ejsData = this.makeEjsData();
        ejsData.plot = plt;
        const html = ejs.render(this.smallPlotTemplate, ejsData);
        const msg: AddPlotMessage = {
            message: 'addPlot',
            html: html
        };
        this.postWebviewMessage(msg);
        void this.focusPlot(plt.id);
        void this.setContextValues();
    }

    // get content of a single plot
    protected async getPlotContent(id: HttpgdPlotId, width: number, height: number, zoom: number): Promise<HttpgdPlot<string>> {
        // Create cache key for this request
        const cacheKey: PlotCacheKey = {
            id,
            width,
            height,
            zoom,
            dpr: this.dpr,
            renderer: this.renderer
        };

        // Try to get from cache first
        const cachedPlot = this.plotCache.get(cacheKey);
        if (cachedPlot) {
            return cachedPlot;
        }

        const args = {
            id: id,
            height: height,
            width: width,
            zoom: zoom,
            renderer: this.renderer
        };
        const resp = await this.api.getPlot(args) as unknown as Response | undefined;
        let data = '';
        if (resp) {
            // Try to determine content type to decide how to embed
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('svg')) {
                data = await resp.text() || '';
            } else if (contentType.includes('png') || contentType.includes('jpeg') || contentType.includes('jpg') || contentType.includes('webp')) {
                const buf = Buffer.from(await resp.arrayBuffer());
                const mime = contentType.split(';')[0];
                const base64 = buf.toString('base64');
                data = `<img src="data:${mime};base64,${base64}" style="max-width: 100%; max-height: 100%;"/>`;
            } else {
                // Fallback: try text (works for svg), else as base64 png
                try {
                    data = await resp.text();
                } catch {
                    const buf = Buffer.from(await resp.arrayBuffer());
                    const base64 = buf.toString('base64');
                    data = `<img src="data:image/png;base64,${base64}" style="max-width: 100%; max-height: 100%;"/>`;
                }
            }
        }

        const plt: HttpgdPlot<string> = {
            id: id,
            data: data,
            height: height,
            width: width,
            zoom: zoom,
        };

        this.viewHeight ??= plt.height;
        this.viewWidth ??= plt.width;

        // Store in cache
        this.plotCache.set(cacheKey, plt);

        return plt;
    }


    // functions for initial or re-drawing of html:

    protected refreshHtml(): void {
        this.webviewPanel ??= this.makeNewWebview();
        this.webviewPanel.webview.html = '';
        this.webviewPanel.webview.html = this.makeHtml();
        // make sure that fullWindow is set correctly:
        this.toggleFullWindow(this.fullWindow);
        void this.setContextValues(true);
    }

    protected makeHtml(): string {
        const ejsData = this.makeEjsData();
        const html = ejs.render(this.htmlTemplate, ejsData);
        return html;
    }

    protected makeEjsData(): EjsData {
        const asLocalPath = (relPath: string) => {
            if (!this.webviewPanel) {
                return relPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, relPath));
            return localUri.fsPath;
        };
        const asWebViewPath = (localPath: string) => {
            if (!this.webviewPanel) {
                return localPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, localPath));
            const webViewUri = this.webviewPanel.webview.asWebviewUri(localUri);
            return webViewUri.toString();
        };
        let overwriteCssPath = '';
        if (this.customOverwriteCssPath) {
            const uri = vscode.Uri.file(this.customOverwriteCssPath);
            overwriteCssPath = this.webviewPanel?.webview.asWebviewUri(uri).toString() || '';
        } else {
            overwriteCssPath = asWebViewPath('styleOverwrites.css');
        }
        const ejsData: EjsData = {
            overwriteStyles: this.stripStyles,
            previewPlotLayout: this.previewPlotLayout,
            plots: this.plots,
            largePlot: this.plots[this.activeIndex],
            activePlot: this.activePlot,
            host: this.host,
            asLocalPath: asLocalPath,
            asWebViewPath: asWebViewPath,
            makeCommandUri: makeWebviewCommandUriString,
            overwriteCssPath: overwriteCssPath
        };
        return ejsData;
    }

    protected makeNewWebview(showOptions?: ShowOptions): vscode.WebviewPanel {
        const webviewPanel = vscode.window.createWebviewPanel(
            'RPlot',
            'R Plot',
            showOptions || this.showOptions,
            this.webviewOptions
        );
        webviewPanel.iconPath = new UriIcon('graph');
        webviewPanel.onDidDispose(() => this.webviewPanel = undefined);
        webviewPanel.onDidChangeViewState(() => {
            void this.setContextValues();
        });
        webviewPanel.webview.onDidReceiveMessage((e: OutMessage) => {
            this.handleWebviewMessage(e);
        });
        return webviewPanel;
    }

    protected handleWebviewMessage(msg: OutMessage): void {
        if (msg.message === 'log') {
            console.log(msg.body);
        } else if (msg.message === 'resize') {
            const height = msg.height;
            const width = msg.width;
            const userTriggered = msg.userTriggered;
            const dprVal = (msg as unknown as Record<string, unknown>)['dpr'];
            if (typeof dprVal === 'number' && !Number.isNaN(dprVal)) {
                // If DPR changed, clear cache since it affects rendering
                if (this.dpr !== dprVal) {
                    this.plotCache.clear();
                }
                this.dpr = dprVal;
            }
            void this.handleResize(height, width, userTriggered);
        }
    }

    protected postWebviewMessage(msg: InMessage): void {
        void this.webviewPanel?.webview.postMessage(msg);
    }


    // export plot
    // if no format supplied, show a quickpick menu etc.
    // if no filename supplied, show selector window
    public async exportPlot(id?: HttpgdPlotId, rendererId?: HttpgdRendererId, outFile?: string): Promise<void> {
        // make sure id is valid or return:
        id ||= this.activePlot || this.plots[this.plots.length - 1]?.id;
        const plot = this.plots.find((plt) => plt.id === id);
        if (!plot) {
            void vscode.window.showWarningMessage('No plot available for export.');
            return;
        }
        // make sure format is valid or return:
        if (!rendererId) {
            const renderers = this.api.getRenderers();
            const qpItems  = renderers.map(renderer => ({
                label: renderer.name,
                detail: renderer.descr,
                id: renderer.id
            }));
            const options: vscode.QuickPickOptions = {
                placeHolder: 'Please choose a file format'
            };
            // format = await vscode.window.showQuickPick(formats, options);
            const qpPick = await vscode.window.showQuickPick(qpItems, options);
            rendererId = qpPick?.id;
            if(!rendererId){
                return;
            }
        }
        // make sure outFile is valid or return:
        if (!outFile) {
            const options: vscode.SaveDialogOptions = {};

            // Suggest a file extension:
            const renderer = this.api.getRenderers().find(r => r.id === rendererId);
            const ext = renderer?.ext.replace(/^\./, '');

            // try to set default URI:
            if(this.lastExportUri){
                const noExtPath = this.lastExportUri.fsPath.replace(/\.[^.]*$/, '');
                const defaultPath = noExtPath + (ext ? `.${ext}` : '');
                options.defaultUri = vscode.Uri.file(defaultPath);
            } else {
                // construct default Uri
                const defaultFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if(defaultFolder){
                    const defaultName = 'plot' + (ext ? `.${ext}` : '');
                    options.defaultUri = vscode.Uri.file(path.join(defaultFolder, defaultName));
                }
            }
            // set file extension filter
            if(ext && renderer?.name){
                options.filters = {
                    [renderer.name]: [ext],
                    ['All']: ['*'],
                };
            }

            const outUri = await vscode.window.showSaveDialog(options);
            if(outUri){
                this.lastExportUri = outUri;
                outFile = outUri.fsPath;
            } else {
                return;
            }
        }
        // get plot:
        const plt = await this.api.getPlot({
            id: this.activePlot,
            renderer: rendererId
        }) as unknown as Response; // I am not sure why eslint thinks this is the
        // browser Response object and not the node-fetch one.
        // cross-fetch problem or config problem in vscode-r?

        const dest = fs.createWriteStream(outFile);
        dest.on('error', (err) => void vscode.window.showErrorMessage(
            `Export failed: ${err.message}`
        ));
        dest.on('close', () => void vscode.window.showInformationMessage(
            `Export done: ${outFile || ''}`
        ));
        void plt.body.pipe(dest);
    }

    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    public dispose(): void {
        this.api.disconnect();
        // Clear the plot cache on disposal
        this.plotCache.clear();
    }
}

// helper function to handle argument lists that might contain (useless) extra arguments
function findItemOfType(arr: any[], type: 'string'): string | undefined;
function findItemOfType(arr: any[], type: 'boolean'): boolean | undefined;
function findItemOfType(arr: any[], type: 'number'): number | undefined;
function findItemOfType<T = unknown>(arr: any[], type: string): T {
    const item = arr.find((elm) => typeof elm === type) as T;
    return item;
}
