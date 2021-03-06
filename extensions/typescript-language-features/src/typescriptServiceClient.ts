/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import BufferSyncSupport from './features/bufferSyncSupport';
import { DiagnosticKind, DiagnosticsManager } from './features/diagnostics';
import * as Proto from './protocol';
import { ITypeScriptServiceClient } from './typescriptService';
import API from './utils/api';
import { TsServerLogLevel, TypeScriptServiceConfiguration } from './utils/configuration';
import { Disposable } from './utils/dispose';
import * as electron from './utils/electron';
import * as fileSchemes from './utils/fileSchemes';
import * as is from './utils/is';
import LogDirectoryProvider from './utils/logDirectoryProvider';
import Logger from './utils/logger';
import { TypeScriptPluginPathsProvider } from './utils/pluginPathsProvider';
import { TypeScriptServerPlugin } from './utils/plugins';
import TelemetryReporter from './utils/telemetry';
import Tracer from './utils/tracer';
import { inferredProjectConfig } from './utils/tsconfig';
import { TypeScriptVersionPicker } from './utils/versionPicker';
import { TypeScriptVersion, TypeScriptVersionProvider } from './utils/versionProvider';
import { ICallback, Reader } from './utils/wireProtocol';


const localize = nls.loadMessageBundle();

interface CallbackItem {
	readonly c: (value: any) => void;
	readonly e: (err: any) => void;
	readonly start: number;
}

class CallbackMap {
	private readonly callbacks: Map<number, CallbackItem> = new Map();
	private readonly asyncCallbacks: Map<number, CallbackItem> = new Map();
	public pendingResponses: number = 0;

	public destroy(e: any): void {
		for (const callback of this.callbacks.values()) {
			callback.e(e);
		}
		for (const callback of this.asyncCallbacks.values()) {
			callback.e(e);
		}
		this.callbacks.clear();
		this.pendingResponses = 0;
	}

	public add(seq: number, callback: CallbackItem, isAsync: boolean) {
		if (isAsync) {
			this.asyncCallbacks.set(seq, callback);
		} else {
			this.callbacks.set(seq, callback);
			++this.pendingResponses;
		}
	}

	public fetch(seq: number): CallbackItem | undefined {
		const callback = this.callbacks.get(seq) || this.asyncCallbacks.get(seq);
		this.delete(seq);
		return callback;
	}

	private delete(seq: number) {
		if (this.callbacks.delete(seq)) {
			--this.pendingResponses;
		} else {
			this.asyncCallbacks.delete(seq);
		}
	}
}

interface RequestItem {
	readonly request: Proto.Request;
	callbacks: CallbackItem | null;
	readonly isAsync: boolean;
}

class RequestQueue {
	private queue: RequestItem[] = [];
	private sequenceNumber: number = 0;

	public get length(): number {
		return this.queue.length;
	}

	public push(item: RequestItem): void {
		this.queue.push(item);
	}

	public shift(): RequestItem | undefined {
		return this.queue.shift();
	}

	public tryCancelPendingRequest(seq: number): boolean {
		for (let i = 0; i < this.queue.length; i++) {
			if (this.queue[i].request.seq === seq) {
				this.queue.splice(i, 1);
				return true;
			}
		}
		return false;
	}

	public createRequest(command: string, args: any): Proto.Request {
		return {
			seq: this.sequenceNumber++,
			type: 'request',
			command: command,
			arguments: args
		};
	}
}

class ForkedTsServerProcess {
	constructor(
		private childProcess: cp.ChildProcess
	) { }

	public onError(cb: (err: Error) => void): void {
		this.childProcess.on('error', cb);
	}

	public onExit(cb: (err: any) => void): void {
		this.childProcess.on('exit', cb);
	}

	public write(serverRequest: Proto.Request) {
		this.childProcess.stdin.write(JSON.stringify(serverRequest) + '\r\n', 'utf8');
	}

	public createReader(
		callback: ICallback<Proto.Response>,
		onError: (error: any) => void
	) {
		// tslint:disable-next-line:no-unused-expression
		new Reader<Proto.Response>(this.childProcess.stdout, callback, onError);
	}

	public kill() {
		this.childProcess.kill();
	}
}

export interface TsDiagnostics {
	readonly kind: DiagnosticKind;
	readonly resource: vscode.Uri;
	readonly diagnostics: Proto.Diagnostic[];
}

export default class TypeScriptServiceClient extends Disposable implements ITypeScriptServiceClient {
	private static readonly WALK_THROUGH_SNIPPET_SCHEME_COLON = `${fileSchemes.walkThroughSnippet}:`;

	private pathSeparator: string;

	private _onReady?: { promise: Promise<void>; resolve: () => void; reject: () => void; };
	private _configuration: TypeScriptServiceConfiguration;
	private versionProvider: TypeScriptVersionProvider;
	private pluginPathsProvider: TypeScriptPluginPathsProvider;
	private versionPicker: TypeScriptVersionPicker;

	private tracer: Tracer;
	public readonly logger: Logger = new Logger();
	private tsServerLogFile: string | null = null;
	private servicePromise: Thenable<ForkedTsServerProcess> | null;
	private lastError: Error | null;
	private lastStart: number;
	private numberRestarts: number;
	private isRestarting: boolean = false;

	private cancellationPipeName: string | null = null;

	private requestQueue: RequestQueue;
	private callbacks: CallbackMap;

	public readonly telemetryReporter: TelemetryReporter;
	/**
	 * API version obtained from the version picker after checking the corresponding path exists.
	 */
	private _apiVersion: API;
	/**
	 * Version reported by currently-running tsserver.
	 */
	private _tsserverVersion: string | undefined;

	public readonly bufferSyncSupport: BufferSyncSupport;
	public readonly diagnosticsManager: DiagnosticsManager;

	constructor(
		private readonly workspaceState: vscode.Memento,
		private readonly onDidChangeTypeScriptVersion: (version: TypeScriptVersion) => void,
		public readonly plugins: TypeScriptServerPlugin[],
		private readonly logDirectoryProvider: LogDirectoryProvider,
		allModeIds: string[]
	) {
		super();
		this.pathSeparator = path.sep;
		this.lastStart = Date.now();

		var p = new Promise<void>((resolve, reject) => {
			this._onReady = { promise: p, resolve, reject };
		});
		this._onReady!.promise = p;

		this.servicePromise = null;
		this.lastError = null;
		this.numberRestarts = 0;

		this.requestQueue = new RequestQueue();
		this.callbacks = new CallbackMap();
		this._configuration = TypeScriptServiceConfiguration.loadFromWorkspace();
		this.versionProvider = new TypeScriptVersionProvider(this._configuration);
		this.pluginPathsProvider = new TypeScriptPluginPathsProvider(this._configuration);
		this.versionPicker = new TypeScriptVersionPicker(this.versionProvider, this.workspaceState);

		this._apiVersion = API.defaultVersion;
		this._tsserverVersion = undefined;
		this.tracer = new Tracer(this.logger);

		this.bufferSyncSupport = new BufferSyncSupport(this, allModeIds);
		this.onReady(() => { this.bufferSyncSupport.listen(); });

		this.diagnosticsManager = new DiagnosticsManager('typescript');
		this.bufferSyncSupport.onDelete(resource => {
			this.diagnosticsManager.delete(resource);
		}, null, this._disposables);

		vscode.workspace.onDidChangeConfiguration(() => {
			const oldConfiguration = this._configuration;
			this._configuration = TypeScriptServiceConfiguration.loadFromWorkspace();

			this.versionProvider.updateConfiguration(this._configuration);
			this.pluginPathsProvider.updateConfiguration(this._configuration);
			this.tracer.updateConfiguration();

			if (this.servicePromise) {
				if (this._configuration.checkJs !== oldConfiguration.checkJs
					|| this._configuration.experimentalDecorators !== oldConfiguration.experimentalDecorators
				) {
					this.setCompilerOptionsForInferredProjects(this._configuration);
				}

				if (!this._configuration.isEqualTo(oldConfiguration)) {
					this.restartTsServer();
				}
			}
		}, this, this._disposables);
		this.telemetryReporter = new TelemetryReporter(() => this._tsserverVersion || this._apiVersion.versionString);
		this._register(this.telemetryReporter);
	}

	public get configuration() {
		return this._configuration;
	}

	public dispose() {
		super.dispose();

		this.bufferSyncSupport.dispose();

		if (this.servicePromise) {
			this.servicePromise.then(childProcess => {
				childProcess.kill();
			}).then(undefined, () => void 0);
		}
	}

	public restartTsServer(): void {
		const start = () => {
			this.servicePromise = this.startService(true);
			return this.servicePromise;
		};

		if (this.servicePromise) {
			this.servicePromise = this.servicePromise.then(childProcess => {
				this.info('Killing TS Server');
				this.isRestarting = true;
				childProcess.kill();
				this.resetClientVersion();
			}).then(start);
		} else {
			start();
		}
	}

	private readonly _onTsServerStarted = this._register(new vscode.EventEmitter<API>());
	public readonly onTsServerStarted = this._onTsServerStarted.event;

	private readonly _onDiagnosticsReceived = this._register(new vscode.EventEmitter<TsDiagnostics>());
	public readonly onDiagnosticsReceived = this._onDiagnosticsReceived.event;

	private readonly _onConfigDiagnosticsReceived = this._register(new vscode.EventEmitter<Proto.ConfigFileDiagnosticEvent>());
	public readonly onConfigDiagnosticsReceived = this._onConfigDiagnosticsReceived.event;

	private readonly _onResendModelsRequested = this._register(new vscode.EventEmitter<void>());
	public readonly onResendModelsRequested = this._onResendModelsRequested.event;

	private readonly _onProjectLanguageServiceStateChanged = this._register(new vscode.EventEmitter<Proto.ProjectLanguageServiceStateEventBody>());
	public readonly onProjectLanguageServiceStateChanged = this._onProjectLanguageServiceStateChanged.event;

	private readonly _onDidBeginInstallTypings = this._register(new vscode.EventEmitter<Proto.BeginInstallTypesEventBody>());
	public readonly onDidBeginInstallTypings = this._onDidBeginInstallTypings.event;

	private readonly _onDidEndInstallTypings = this._register(new vscode.EventEmitter<Proto.EndInstallTypesEventBody>());
	public readonly onDidEndInstallTypings = this._onDidEndInstallTypings.event;

	private readonly _onTypesInstallerInitializationFailed = this._register(new vscode.EventEmitter<Proto.TypesInstallerInitializationFailedEventBody>());
	public readonly onTypesInstallerInitializationFailed = this._onTypesInstallerInitializationFailed.event;

	public get apiVersion(): API {
		return this._apiVersion;
	}

	public onReady(f: () => void): Promise<void> {
		return this._onReady!.promise.then(f);
	}

	private info(message: string, data?: any): void {
		this.logger.info(message, data);
	}

	private error(message: string, data?: any): void {
		this.logger.error(message, data);
	}

	private logTelemetry(eventName: string, properties?: { [prop: string]: string }) {
		this.telemetryReporter.logTelemetry(eventName, properties);
	}

	private service(): Thenable<ForkedTsServerProcess> {
		if (this.servicePromise) {
			return this.servicePromise;
		}
		if (this.lastError) {
			return Promise.reject<ForkedTsServerProcess>(this.lastError);
		}
		this.startService();
		if (this.servicePromise) {
			return this.servicePromise;
		}
		return Promise.reject<ForkedTsServerProcess>(new Error('Could not create TS service'));
	}

	public ensureServiceStarted() {
		if (!this.servicePromise) {
			this.startService();
		}
	}

	private startService(resendModels: boolean = false): Promise<ForkedTsServerProcess> {
		let currentVersion = this.versionPicker.currentVersion;

		this.info(`Using tsserver from: ${currentVersion.path}`);
		if (!fs.existsSync(currentVersion.tsServerPath)) {
			vscode.window.showWarningMessage(localize('noServerFound', 'The path {0} doesn\'t point to a valid tsserver install. Falling back to bundled TypeScript version.', currentVersion.path));

			this.versionPicker.useBundledVersion();
			currentVersion = this.versionPicker.currentVersion;
		}

		this._apiVersion = this.versionPicker.currentVersion.version || API.defaultVersion;
		this.onDidChangeTypeScriptVersion(currentVersion);

		this.requestQueue = new RequestQueue();
		this.callbacks = new CallbackMap();
		this.lastError = null;

		return this.servicePromise = new Promise<ForkedTsServerProcess>(async (resolve, reject) => {
			try {
				const tsServerForkArgs = await this.getTsServerArgs(currentVersion);
				const debugPort = this.getDebugPort();
				const tsServerForkOptions: electron.IForkOptions = {
					execArgv: debugPort ? [`--inspect=${debugPort}`] : [] // [`--debug-brk=5859`]
				};
				electron.fork(currentVersion.tsServerPath, tsServerForkArgs, tsServerForkOptions, this.logger, (err: any, childProcess: cp.ChildProcess | null) => {
					if (err || !childProcess) {
						this.lastError = err;
						this.error('Starting TSServer failed with error.', err);
						vscode.window.showErrorMessage(localize('serverCouldNotBeStarted', 'TypeScript language server couldn\'t be started. Error message is: {0}', err.message || err));
						/* __GDPR__
							"error" : {
								"${include}": [
									"${TypeScriptCommonProperties}"
								]
							}
						*/
						this.logTelemetry('error');
						this.resetClientVersion();
						return;
					}

					this.info('Started TSServer');
					const handle = new ForkedTsServerProcess(childProcess);
					this.lastStart = Date.now();

					handle.onError((err: Error) => {
						this.lastError = err;
						this.error('TSServer errored with error.', err);
						if (this.tsServerLogFile) {
							this.error(`TSServer log file: ${this.tsServerLogFile}`);
						}
						/* __GDPR__
							"tsserver.error" : {
								"${include}": [
									"${TypeScriptCommonProperties}"
								]
							}
						*/
						this.logTelemetry('tsserver.error');
						this.serviceExited(false);
					});
					handle.onExit((code: any) => {
						if (code === null || typeof code === 'undefined') {
							this.info('TSServer exited');
						} else {
							this.error(`TSServer exited with code: ${code}`);
							/* __GDPR__
								"tsserver.exitWithCode" : {
									"code" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" },
									"${include}": [
										"${TypeScriptCommonProperties}"
									]
								}
							*/
							this.logTelemetry('tsserver.exitWithCode', { code: code });
						}

						if (this.tsServerLogFile) {
							this.info(`TSServer log file: ${this.tsServerLogFile}`);
						}
						this.serviceExited(!this.isRestarting);
						this.isRestarting = false;
					});

					handle.createReader(
						msg => { this.dispatchMessage(msg); },
						error => { this.error('ReaderError', error); });

					this._onReady!.resolve();
					resolve(handle);
					this._onTsServerStarted.fire(currentVersion.version);

					this.serviceStarted(resendModels);
				});
			} catch (error) {
				reject(error);
			}
		});
	}

	public onVersionStatusClicked(): Thenable<void> {
		return this.showVersionPicker(false);
	}

	private showVersionPicker(firstRun: boolean): Thenable<void> {
		return this.versionPicker.show(firstRun).then(change => {
			if (firstRun || !change.newVersion || !change.oldVersion || change.oldVersion.path === change.newVersion.path) {
				return;
			}
			this.restartTsServer();
		});
	}

	public async openTsServerLogFile(): Promise<boolean> {
		if (!this.apiVersion.gte(API.v222)) {
			vscode.window.showErrorMessage(
				localize(
					'typescript.openTsServerLog.notSupported',
					'TS Server logging requires TS 2.2.2+'));
			return false;
		}

		if (this._configuration.tsServerLogLevel === TsServerLogLevel.Off) {
			vscode.window.showErrorMessage<vscode.MessageItem>(
				localize(
					'typescript.openTsServerLog.loggingNotEnabled',
					'TS Server logging is off. Please set `typescript.tsserver.log` and restart the TS server to enable logging'),
				{
					title: localize(
						'typescript.openTsServerLog.enableAndReloadOption',
						'Enable logging and restart TS server'),
				})
				.then(selection => {
					if (selection) {
						return vscode.workspace.getConfiguration().update('typescript.tsserver.log', 'verbose', true).then(() => {
							this.restartTsServer();
						});
					}
					return undefined;
				});
			return false;
		}

		if (!this.tsServerLogFile) {
			vscode.window.showWarningMessage(localize(
				'typescript.openTsServerLog.noLogFile',
				'TS Server has not started logging.'));
			return false;
		}

		try {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.parse(this.tsServerLogFile));
			return true;
		} catch {
			vscode.window.showWarningMessage(localize(
				'openTsServerLog.openFileFailedFailed',
				'Could not open TS Server log file'));
			return false;
		}
	}

	private serviceStarted(resendModels: boolean): void {
		const configureOptions: Proto.ConfigureRequestArguments = {
			hostInfo: 'vscode'
		};
		this.executeWithoutWaitingForResponse('configure', configureOptions);
		this.setCompilerOptionsForInferredProjects(this._configuration);
		if (resendModels) {
			this._onResendModelsRequested.fire();
		}
	}

	private setCompilerOptionsForInferredProjects(configuration: TypeScriptServiceConfiguration): void {
		if (!this.apiVersion.gte(API.v206)) {
			return;
		}

		const args: Proto.SetCompilerOptionsForInferredProjectsArgs = {
			options: this.getCompilerOptionsForInferredProjects(configuration)
		};
		this.executeWithoutWaitingForResponse('compilerOptionsForInferredProjects', args);
	}

	private getCompilerOptionsForInferredProjects(configuration: TypeScriptServiceConfiguration): Proto.ExternalProjectCompilerOptions {
		return {
			...inferredProjectConfig(configuration),
			allowJs: true,
			allowSyntheticDefaultImports: true,
			allowNonTsExtensions: true,
		};
	}

	private serviceExited(restart: boolean): void {
		enum MessageAction {
			reportIssue
		}

		interface MyMessageItem extends vscode.MessageItem {
			id: MessageAction;
		}

		this.servicePromise = null;
		this.tsServerLogFile = null;
		this.callbacks.destroy(new Error('Service died.'));
		this.callbacks = new CallbackMap();
		if (!restart) {
			this.resetClientVersion();
		}
		else {
			const diff = Date.now() - this.lastStart;
			this.numberRestarts++;
			let startService = true;
			if (this.numberRestarts > 5) {
				let prompt: Thenable<MyMessageItem | undefined> | undefined = undefined;
				this.numberRestarts = 0;
				if (diff < 10 * 1000 /* 10 seconds */) {
					this.lastStart = Date.now();
					startService = false;
					prompt = vscode.window.showErrorMessage<MyMessageItem>(
						localize('serverDiedAfterStart', 'The TypeScript language service died 5 times right after it got started. The service will not be restarted.'),
						{
							title: localize('serverDiedReportIssue', 'Report Issue'),
							id: MessageAction.reportIssue
						});
					/* __GDPR__
						"serviceExited" : {
							"${include}": [
								"${TypeScriptCommonProperties}"
							]
						}
					*/
					this.logTelemetry('serviceExited');
					this.resetClientVersion();
				} else if (diff < 60 * 1000 /* 1 Minutes */) {
					this.lastStart = Date.now();
					prompt = vscode.window.showWarningMessage<MyMessageItem>(
						localize('serverDied', 'The TypeScript language service died unexpectedly 5 times in the last 5 Minutes.'),
						{
							title: localize('serverDiedReportIssue', 'Report Issue'),
							id: MessageAction.reportIssue
						});
				}
				if (prompt) {
					prompt.then(item => {
						if (item && item.id === MessageAction.reportIssue) {
							return vscode.commands.executeCommand('workbench.action.reportIssues');
						}
						return undefined;
					});
				}
			}
			if (startService) {
				this.startService(true);
			}
		}
	}

	public normalizedPath(resource: vscode.Uri): string | null {
		if (this._apiVersion.gte(API.v213)) {
			if (resource.scheme === fileSchemes.walkThroughSnippet || resource.scheme === fileSchemes.untitled) {
				const dirName = path.dirname(resource.path);
				const fileName = this.inMemoryResourcePrefix + path.basename(resource.path);
				return resource.with({ path: path.posix.join(dirName, fileName) }).toString(true);
			}
		}

		if (resource.scheme !== fileSchemes.file) {
			return null;
		}

		const result = resource.fsPath;
		if (!result) {
			return null;
		}

		// Both \ and / must be escaped in regular expressions
		return result.replace(new RegExp('\\' + this.pathSeparator, 'g'), '/');
	}

	public toPath(resource: vscode.Uri): string | null {
		return this.normalizedPath(resource);
	}

	private get inMemoryResourcePrefix(): string {
		return this._apiVersion.gte(API.v270) ? '^' : '';
	}

	public toResource(filepath: string): vscode.Uri {
		if (this._apiVersion.gte(API.v213)) {
			if (filepath.startsWith(TypeScriptServiceClient.WALK_THROUGH_SNIPPET_SCHEME_COLON) || (filepath.startsWith(fileSchemes.untitled + ':'))
			) {
				let resource = vscode.Uri.parse(filepath);
				if (this.inMemoryResourcePrefix) {
					const dirName = path.dirname(resource.path);
					const fileName = path.basename(resource.path);
					if (fileName.startsWith(this.inMemoryResourcePrefix)) {
						resource = resource.with({ path: path.posix.join(dirName, fileName.slice(this.inMemoryResourcePrefix.length)) });
					}
				}
				return resource;
			}
		}
		return this.bufferSyncSupport.toResource(filepath);
	}

	public getWorkspaceRootForResource(resource: vscode.Uri): string | undefined {
		const roots = vscode.workspace.workspaceFolders;
		if (!roots || !roots.length) {
			return undefined;
		}

		if (resource.scheme === fileSchemes.file || resource.scheme === fileSchemes.untitled) {
			for (const root of roots.sort((a, b) => a.uri.fsPath.length - b.uri.fsPath.length)) {
				if (resource.fsPath.startsWith(root.uri.fsPath + path.sep)) {
					return root.uri.fsPath;
				}
			}
			return roots[0].uri.fsPath;
		}

		return undefined;
	}

	public execute(command: string, args: any, token: vscode.CancellationToken): Promise<any> {
		return this.executeImpl(command, args, {
			isAsync: false,
			token,
			expectsResult: true
		});
	}

	public executeWithoutWaitingForResponse(command: string, args: any): void {
		this.executeImpl(command, args, {
			isAsync: false,
			token: undefined,
			expectsResult: false
		});
	}

	public executeAsync(command: string, args: Proto.GeterrRequestArgs, token: vscode.CancellationToken): Promise<any> {
		return this.executeImpl(command, args, {
			isAsync: true,
			token,
			expectsResult: true
		});
	}

	private executeImpl(command: string, args: any, executeInfo: { isAsync: boolean, token?: vscode.CancellationToken, expectsResult: boolean }): Promise<any> {
		const request = this.requestQueue.createRequest(command, args);
		const requestInfo: RequestItem = {
			request: request,
			callbacks: null,
			isAsync: executeInfo.isAsync
		};
		let result: Promise<any>;
		if (executeInfo.expectsResult) {
			let wasCancelled = false;
			result = new Promise<any>((resolve, reject) => {
				requestInfo.callbacks = { c: resolve, e: reject, start: Date.now() };
				if (executeInfo.token) {
					executeInfo.token.onCancellationRequested(() => {
						wasCancelled = true;
						this.tryCancelRequest(request.seq);
					});
				}
			}).catch((err: any) => {
				if (!wasCancelled) {
					this.error(`'${command}' request failed with error.`, err);
					const properties = this.parseErrorText(err && err.message, command);
					this.logTelemetry('languageServiceErrorResponse', properties);
				}
				throw err;
			});
		} else {
			result = Promise.resolve(null);
		}
		this.requestQueue.push(requestInfo);
		this.sendNextRequests();

		return result;
	}

	/**
	 * Given a `errorText` from a tsserver request indicating failure in handling a request,
	 * prepares a payload for telemetry-logging.
	 */
	private parseErrorText(errorText: string | undefined, command: string) {
		const properties: ObjectMap<string> = Object.create(null);
		properties['command'] = command;
		if (errorText) {
			properties['errorText'] = errorText;

			const errorPrefix = 'Error processing request. ';
			if (errorText.startsWith(errorPrefix)) {
				const prefixFreeErrorText = errorText.substr(errorPrefix.length);
				const newlineIndex = prefixFreeErrorText.indexOf('\n');
				if (newlineIndex >= 0) {
					// Newline expected between message and stack.
					properties['message'] = prefixFreeErrorText.substring(0, newlineIndex);
					properties['stack'] = prefixFreeErrorText.substring(newlineIndex + 1);
				}
			}
		}
		return properties;
	}

	private sendNextRequests(): void {
		while (this.callbacks.pendingResponses === 0 && this.requestQueue.length > 0) {
			const item = this.requestQueue.shift();
			if (item) {
				this.sendRequest(item);
			}
		}
	}

	private sendRequest(requestItem: RequestItem): void {
		const serverRequest = requestItem.request;
		this.tracer.traceRequest(serverRequest, !!requestItem.callbacks, this.requestQueue.length);
		if (requestItem.callbacks) {
			this.callbacks.add(serverRequest.seq, requestItem.callbacks, requestItem.isAsync);
		}
		this.service()
			.then((childProcess) => {
				childProcess.write(serverRequest);
			})
			.then(undefined, err => {
				const callback = this.callbacks.fetch(serverRequest.seq);
				if (callback) {
					callback.e(err);
				}
			});
	}

	private tryCancelRequest(seq: number): boolean {
		try {
			if (this.requestQueue.tryCancelPendingRequest(seq)) {
				this.tracer.logTrace(`TypeScript Service: canceled request with sequence number ${seq}`);
				return true;
			}

			if (this.apiVersion.gte(API.v222) && this.cancellationPipeName) {
				this.tracer.logTrace(`TypeScript Service: trying to cancel ongoing request with sequence number ${seq}`);
				try {
					fs.writeFileSync(this.cancellationPipeName + seq, '');
				} catch {
					// noop
				}
				return true;
			}

			this.tracer.logTrace(`TypeScript Service: tried to cancel request with sequence number ${seq}. But request got already delivered.`);
			return false;
		} finally {
			const p = this.callbacks.fetch(seq);
			if (p) {
				p.e(new Error(`Cancelled Request ${seq}`));
			}
		}
	}

	private dispatchMessage(message: Proto.Message): void {
		try {
			if (message.type === 'response') {
				const response: Proto.Response = message as Proto.Response;
				const p = this.callbacks.fetch(response.request_seq);
				if (p) {
					this.tracer.traceResponse(response, p.start);
					if (response.success) {
						p.c(response);
					} else {
						p.e(response);
					}
				}
			} else if (message.type === 'event') {
				const event: Proto.Event = <Proto.Event>message;
				this.tracer.traceEvent(event);
				this.dispatchEvent(event);
			} else {
				throw new Error('Unknown message type ' + message.type + ' received');
			}
		} finally {
			this.sendNextRequests();
		}
	}

	private dispatchEvent(event: Proto.Event) {
		switch (event.event) {
			case 'requestCompleted':
				const seq = (event as Proto.RequestCompletedEvent).body.request_seq;
				const p = this.callbacks.fetch(seq);
				if (p) {
					this.tracer.traceRequestCompleted('requestCompleted', seq, p.start);
					p.c(undefined);
				}
				break;

			case 'syntaxDiag':
			case 'semanticDiag':
			case 'suggestionDiag':
				const diagnosticEvent: Proto.DiagnosticEvent = event;
				if (diagnosticEvent.body && diagnosticEvent.body.diagnostics) {
					this._onDiagnosticsReceived.fire({
						kind: getDignosticsKind(event),
						resource: this.toResource(diagnosticEvent.body.file),
						diagnostics: diagnosticEvent.body.diagnostics
					});
				}
				break;

			case 'configFileDiag':
				this._onConfigDiagnosticsReceived.fire(event as Proto.ConfigFileDiagnosticEvent);
				break;

			case 'telemetry':
				const telemetryData = (event as Proto.TelemetryEvent).body;
				this.dispatchTelemetryEvent(telemetryData);
				break;

			case 'projectLanguageServiceState':
				if (event.body) {
					this._onProjectLanguageServiceStateChanged.fire((event as Proto.ProjectLanguageServiceStateEvent).body);
				}
				break;

			case 'projectsUpdatedInBackground':
				if (event.body) {
					const body = (event as Proto.ProjectsUpdatedInBackgroundEvent).body;
					const resources = body.openFiles.map(vscode.Uri.file);
					this.bufferSyncSupport.getErr(resources);
				}
				break;

			case 'beginInstallTypes':
				if (event.body) {
					this._onDidBeginInstallTypings.fire((event as Proto.BeginInstallTypesEvent).body);
				}
				break;

			case 'endInstallTypes':
				if (event.body) {
					this._onDidEndInstallTypings.fire((event as Proto.EndInstallTypesEvent).body);
				}
				break;

			case 'typesInstallerInitializationFailed':
				if (event.body) {
					this._onTypesInstallerInitializationFailed.fire((event as Proto.TypesInstallerInitializationFailedEvent).body);
				}
				break;
		}
	}

	private dispatchTelemetryEvent(telemetryData: Proto.TelemetryEventBody): void {
		const properties: ObjectMap<string> = Object.create(null);
		switch (telemetryData.telemetryEventName) {
			case 'typingsInstalled':
				const typingsInstalledPayload: Proto.TypingsInstalledTelemetryEventPayload = (telemetryData.payload as Proto.TypingsInstalledTelemetryEventPayload);
				properties['installedPackages'] = typingsInstalledPayload.installedPackages;

				if (is.defined(typingsInstalledPayload.installSuccess)) {
					properties['installSuccess'] = typingsInstalledPayload.installSuccess.toString();
				}
				if (is.string(typingsInstalledPayload.typingsInstallerVersion)) {
					properties['typingsInstallerVersion'] = typingsInstalledPayload.typingsInstallerVersion;
				}
				break;

			default:
				const payload = telemetryData.payload;
				if (payload) {
					Object.keys(payload).forEach((key) => {
						try {
							if (payload.hasOwnProperty(key)) {
								properties[key] = is.string(payload[key]) ? payload[key] : JSON.stringify(payload[key]);
							}
						} catch (e) {
							// noop
						}
					});
				}
				break;
		}
		if (telemetryData.telemetryEventName === 'projectInfo') {
			this._tsserverVersion = properties['version'];
		}

		/* __GDPR__
			"typingsInstalled" : {
				"installedPackages" : { "classification": "PublicNonPersonalData", "purpose": "FeatureInsight" },
				"installSuccess": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"typingsInstallerVersion": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"${include}": [
					"${TypeScriptCommonProperties}"
				]
			}
		*/
		// __GDPR__COMMENT__: Other events are defined by TypeScript.
		this.logTelemetry(telemetryData.telemetryEventName, properties);
	}

	private async getTsServerArgs(
		currentVersion: TypeScriptVersion
	): Promise<string[]> {
		const args: string[] = [];

		if (this.apiVersion.gte(API.v206)) {
			if (this.apiVersion.gte(API.v250)) {
				args.push('--useInferredProjectPerProjectRoot');
			} else {
				args.push('--useSingleInferredProject');
			}

			if (this._configuration.disableAutomaticTypeAcquisition) {
				args.push('--disableAutomaticTypingAcquisition');
			}
		}

		if (this.apiVersion.gte(API.v208)) {
			args.push('--enableTelemetry');
		}

		if (this.apiVersion.gte(API.v222)) {
			this.cancellationPipeName = electron.getTempFile('tscancellation');
			args.push('--cancellationPipeName', this.cancellationPipeName + '*');
		}

		if (this.apiVersion.gte(API.v222)) {
			if (this._configuration.tsServerLogLevel !== TsServerLogLevel.Off) {
				const logDir = await this.logDirectoryProvider.getNewLogDirectory();
				if (logDir) {
					this.tsServerLogFile = path.join(logDir, `tsserver.log`);
					this.info(`TSServer log file: ${this.tsServerLogFile}`);
				} else {
					this.tsServerLogFile = null;
					this.error('Could not create TSServer log directory');
				}

				if (this.tsServerLogFile) {
					args.push('--logVerbosity', TsServerLogLevel.toString(this._configuration.tsServerLogLevel));
					args.push('--logFile', this.tsServerLogFile);
				}
			}
		}

		if (this.apiVersion.gte(API.v230)) {
			const pluginPaths = this.pluginPathsProvider.getPluginPaths();

			if (this.plugins.length) {
				args.push('--globalPlugins', this.plugins.map(x => x.name).join(','));

				if (currentVersion.path === this.versionProvider.defaultVersion.path) {
					pluginPaths.push(...this.plugins.map(x => x.path));
				}
			}

			if (pluginPaths.length !== 0) {
				args.push('--pluginProbeLocations', pluginPaths.join(','));
			}
		}

		if (this.apiVersion.gte(API.v234)) {
			if (this._configuration.npmLocation) {
				args.push('--npmLocation', `"${this._configuration.npmLocation}"`);
			}
		}

		if (this.apiVersion.gte(API.v260)) {
			const tsLocale = getTsLocale(this._configuration);
			if (tsLocale) {
				args.push('--locale', tsLocale);
			}
		}

		if (this.apiVersion.gte(API.v291)) {
			args.push('--noGetErrOnBackgroundUpdate');
		}

		return args;
	}

	private getDebugPort(): number | undefined {
		const value = process.env['TSS_DEBUG'];
		if (value) {
			const port = parseInt(value);
			if (!isNaN(port)) {
				return port;
			}
		}
		return undefined;
	}

	private resetClientVersion() {
		this._apiVersion = API.defaultVersion;
		this._tsserverVersion = undefined;
	}
}


const getTsLocale = (configuration: TypeScriptServiceConfiguration): string | undefined =>
	(configuration.locale
		? configuration.locale
		: vscode.env.language);

function getDignosticsKind(event: Proto.Event) {
	switch (event.event) {
		case 'syntaxDiag': return DiagnosticKind.Syntax;
		case 'semanticDiag': return DiagnosticKind.Semantic;
		case 'suggestionDiag': return DiagnosticKind.Suggestion;
	}
	throw new Error('Unknown dignostics kind');
}
