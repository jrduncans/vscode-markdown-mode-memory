import * as vscode from 'vscode';
import {
	createGroupSnapshot,
	detectGroupTransitions,
	detectInPlaceTransition,
	GroupSnapshot,
	MarkdownMode,
	MarkdownTabSnapshot,
	ReplacementEventDetector
} from './modeTransitionDetector';

type ManagementState = 'managing' | 'notManaging';
type MarkdownTab = MarkdownTabSnapshot<vscode.TabGroup>;

interface OriginalAssociation {
	readonly value: string | undefined;
}

type EditorAssociations = Record<string, string>;

const MANAGEMENT_STATE_KEY = 'managementState';
const ORIGINAL_ASSOCIATION_KEY = 'originalMarkdownAssociation';
const MARKDOWN_GLOB = '*.md';

const MARKDOWN_PREVIEW_EDITOR = 'vscode.markdown.preview.editor';
const MARKDOWN_HYBRID_EDITOR = 'vscode.markdown.editor';
const REPLACEMENT_WINDOW_MS = 2_000;

export function activate(context: vscode.ExtensionContext): void {
	const controller = new MarkdownAssociationController(context);
	context.subscriptions.push(controller);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'markdownModeMemory.startManagingWorkspace',
			() => controller.startManagingWorkspace()
		),
		vscode.commands.registerCommand(
			'markdownModeMemory.stopManagingAndRestorePreference',
			() => controller.stopManagingAndRestorePreference()
		)
	);
	controller.start();
}

class MarkdownAssociationController implements vscode.Disposable {
	private readonly tabSnapshots = new WeakMap<vscode.Tab, MarkdownTab>();
	private readonly groupSnapshots = new WeakMap<vscode.TabGroup, GroupSnapshot>();
	private readonly replacementDetector = new ReplacementEventDetector<vscode.TabGroup>(REPLACEMENT_WINDOW_MS);
	private updateQueue: Promise<void> = Promise.resolve();
	private hasShownNoWorkspaceWarning = false;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output = vscode.window.createOutputChannel('Markdown Mode Memory');

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(this.output);
	}

	public start(): void {
		this.disposables.push(
			vscode.window.tabGroups.onDidChangeTabs(event => this.observeTabChanges(event)),
			vscode.window.tabGroups.onDidChangeTabGroups(event => this.observeTabGroupChanges(event))
		);

		this.snapshotOpenTabs();
	}

	public async startManagingWorkspace(): Promise<void> {
		await this.updateQueue;

		if (!this.hasWorkspace()) {
			void vscode.window.showWarningMessage('Markdown Mode Memory needs an open folder or workspace to manage its Markdown editor preference.');
			return;
		}

		if (this.managementState() === 'managing') {
			void vscode.window.showInformationMessage('Markdown Mode Memory is already managing this workspace\'s Markdown editor preference.');
			return;
		}

		await this.beginManaging();
		void vscode.window.showInformationMessage('Markdown Mode Memory will remember the next Markdown view you select in this workspace.');
	}

	public async stopManagingAndRestorePreference(): Promise<void> {
		await this.updateQueue;

		if (this.managementState() !== 'managing') {
			void vscode.window.showInformationMessage('Markdown Mode Memory is not managing this workspace\'s Markdown editor preference.');
			return;
		}

		if (!this.hasWorkspace()) {
			void vscode.window.showWarningMessage('Markdown Mode Memory needs an open folder or workspace to restore its Markdown editor preference.');
			return;
		}

		const original = this.context.workspaceState.get<OriginalAssociation>(ORIGINAL_ASSOCIATION_KEY) ?? { value: undefined };
		const associations = this.workspaceAssociations();
		delete associations[MARKDOWN_GLOB];
		if (original.value !== undefined) {
			associations[MARKDOWN_GLOB] = original.value;
		}

		await this.updateWorkspaceAssociations(associations);
		await this.context.workspaceState.update(MANAGEMENT_STATE_KEY, 'notManaging' satisfies ManagementState);
		await this.context.workspaceState.update(ORIGINAL_ASSOCIATION_KEY, undefined);
		void vscode.window.showInformationMessage('Markdown Mode Memory stopped managing this workspace and restored its previous Markdown editor preference.');
	}

	public dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private observeTabChanges(event: vscode.TabChangeEvent): void {
		const now = Date.now();

		// VS Code reports editor replacement as separate close and open events. Read
		// closed tabs from snapshots taken while the tab was still valid.
		for (const closedTab of event.closed) {
			const closedMarkdownTab = this.tabSnapshots.get(closedTab);
			this.tabSnapshots.delete(closedTab);
			if (closedMarkdownTab) {
				this.queueDetectedTransition(this.replacementDetector.observeClosed(closedMarkdownTab, now));
			}
		}

		// A tab object has stable identity across update events, so its snapshot
		// gives us the previous editor mode if VS Code updates it in place.
		for (const changedTab of event.changed) {
			const previous = this.tabSnapshots.get(changedTab);
			const current = this.getMarkdownTab(changedTab);
			this.queueDetectedTransition(detectInPlaceTransition(previous, current));
			this.saveSnapshot(changedTab, current);
		}

		for (const openedTab of event.opened) {
			const openedMarkdownTab = this.getMarkdownTab(openedTab);
			if (openedMarkdownTab) {
				this.queueDetectedTransition(this.replacementDetector.observeOpened(openedMarkdownTab, now));
			}
			this.saveSnapshot(openedTab, openedMarkdownTab);
		}

		this.snapshotOpenTabs();
	}

	private observeTabGroupChanges(event: vscode.TabGroupChangeEvent): void {
		// Some editor replacements cause VS Code to rebuild its tab model instead
		// of emitting granular close/open events. Compare the previous and current
		// contents of changed groups so those replacements are not lost.
		for (const group of event.changed) {
			const previous = this.groupSnapshots.get(group);
			const current = this.createGroupSnapshot(group);
			if (previous) {
				for (const mode of detectGroupTransitions(previous, current)) {
					this.queueWorkspacePreferenceUpdate(mode);
				}
			}
		}

		for (const group of event.closed) {
			this.groupSnapshots.delete(group);
		}

		this.snapshotOpenTabs();
	}

	private snapshotOpenTabs(): void {
		for (const group of vscode.window.tabGroups.all) {
			this.groupSnapshots.set(group, this.createGroupSnapshot(group));
			for (const tab of group.tabs) {
				this.saveSnapshot(tab, this.getMarkdownTab(tab));
			}
		}
	}

	private createGroupSnapshot(group: vscode.TabGroup): GroupSnapshot {
		const markdownTabs: MarkdownTab[] = [];
		for (const tab of group.tabs) {
			const markdownTab = this.getMarkdownTab(tab);
			if (markdownTab) {
				markdownTabs.push(markdownTab);
			}
		}
		return createGroupSnapshot(markdownTabs);
	}

	private saveSnapshot(tab: vscode.Tab, markdownTab: MarkdownTab | undefined): void {
		if (markdownTab) {
			this.tabSnapshots.set(tab, markdownTab);
		} else {
			this.tabSnapshots.delete(tab);
		}
	}

	private queueDetectedTransition(mode: MarkdownMode | undefined): void {
		if (mode) {
			this.queueWorkspacePreferenceUpdate(mode);
		}
	}

	private queueWorkspacePreferenceUpdate(mode: MarkdownMode): void {
		this.updateQueue = this.updateQueue
			.then(() => this.updateWorkspacePreference(mode))
			.catch(error => {
				const details = error instanceof Error ? error.stack ?? error.message : String(error);
				this.output.appendLine(`Could not update the workspace editor association.\n${details}`);
				void vscode.window.showErrorMessage('Markdown Mode Memory could not update the workspace Markdown editor preference. See the Markdown Mode Memory output channel for details.');
			});
	}

	private async updateWorkspacePreference(mode: MarkdownMode): Promise<void> {
		if (!this.hasWorkspace()) {
			if (!this.hasShownNoWorkspaceWarning) {
				this.hasShownNoWorkspaceWarning = true;
				void vscode.window.showWarningMessage('Markdown Mode Memory needs an open folder or workspace to remember a Markdown editor preference.');
			}
			return;
		}

		if (!await this.ensureManagementConsent()) {
			return;
		}

		await this.writeWorkspacePreference(mode);
	}

	private async writeWorkspacePreference(mode: MarkdownMode): Promise<void> {
		const associations = this.workspaceAssociations();
		const editorId = this.editorIdFor(mode);
		if (associations[MARKDOWN_GLOB] === editorId) {
			return;
		}

		associations[MARKDOWN_GLOB] = editorId;
		await this.updateWorkspaceAssociations(associations);
	}

	private async ensureManagementConsent(): Promise<boolean> {
		const state = this.managementState();
		if (state === 'managing') {
			return true;
		}
		if (state === 'notManaging') {
			return false;
		}

		const choice = await vscode.window.showInformationMessage(
			'Remember the last Markdown view used in this workspace?',
			{
				modal: true,
				detail: 'Markdown Mode Memory does this by updating this workspace\'s workbench.editorAssociations setting whenever you switch between source, preview, or hybrid view. This may modify .vscode/settings.json or the workspace file and can affect other people who use it.'
			},
			'Remember for This Workspace',
			'Not for This Workspace'
		);
		if (choice !== 'Remember for This Workspace') {
			await this.context.workspaceState.update(MANAGEMENT_STATE_KEY, 'notManaging' satisfies ManagementState);
			return false;
		}

		await this.beginManaging();
		return true;
	}

	private async beginManaging(): Promise<void> {
		const associations = this.workspaceAssociations();
		await this.context.workspaceState.update(ORIGINAL_ASSOCIATION_KEY, {
			value: associations[MARKDOWN_GLOB]
		} satisfies OriginalAssociation);
		await this.context.workspaceState.update(MANAGEMENT_STATE_KEY, 'managing' satisfies ManagementState);
	}

	private managementState(): ManagementState | undefined {
		return this.context.workspaceState.get<ManagementState>(MANAGEMENT_STATE_KEY);
	}

	private hasWorkspace(): boolean {
		return vscode.workspace.workspaceFile !== undefined
			|| (vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0);
	}

	private workspaceAssociations(): EditorAssociations {
		const configuration = vscode.workspace.getConfiguration('workbench');
		const inspection = configuration.inspect<EditorAssociations>('editorAssociations');
		return { ...(inspection?.workspaceValue ?? {}) };
	}

	private async updateWorkspaceAssociations(associations: EditorAssociations): Promise<void> {
		const value = Object.keys(associations).length > 0 ? associations : undefined;
		await vscode.workspace.getConfiguration('workbench').update(
			'editorAssociations',
			value,
			vscode.ConfigurationTarget.Workspace
		);
	}

	private editorIdFor(mode: MarkdownMode): string {
		switch (mode) {
			case 'source':
				return 'default';
			case 'preview':
				return MARKDOWN_PREVIEW_EDITOR;
			case 'hybrid':
				return MARKDOWN_HYBRID_EDITOR;
		}
	}

	private getMarkdownTab(tab: vscode.Tab | undefined): MarkdownTab | undefined {
		if (!tab) {
			return undefined;
		}

		const input = tab.input;
		if (input instanceof vscode.TabInputText) {
			return this.isMarkdownResource(input.uri)
				? { group: tab.group, mode: 'source', resource: input.uri.toString() }
				: undefined;
		}

		if (input instanceof vscode.TabInputCustom
			&& (input.viewType === MARKDOWN_PREVIEW_EDITOR || input.viewType === MARKDOWN_HYBRID_EDITOR)
			&& this.isMarkdownResource(input.uri)) {
			return {
				group: tab.group,
				mode: input.viewType === MARKDOWN_PREVIEW_EDITOR ? 'preview' : 'hybrid',
				resource: input.uri.toString()
			};
		}

		return undefined;
	}

	private isMarkdownResource(uri: vscode.Uri): boolean {
		return uri.path.toLowerCase().endsWith('.md');
	}
}

export function deactivate(): void {
	// All resources are registered with the extension context.
}
